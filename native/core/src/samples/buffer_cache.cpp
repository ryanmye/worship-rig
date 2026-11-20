#include "samples/buffer_cache.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <thread>

#include "samples/resampler.h"

namespace rig::samples {

// ---- loading ---------------------------------------------------------------------------------------------------

std::unique_ptr<Stored> makeStored(const Processed &p, double sampleRate, Storage storage) {
  auto s = std::make_unique<Stored>();
  s->channels = static_cast<std::uint32_t>(p.channels);
  s->frames = p.frames;
  s->sampleRate = sampleRate;
  s->natural = p.natural;
  s->capped = p.capped;
  s->dualMono = p.dualMono;
  s->onsetTrim = p.onsetTrim;
  s->monoFix = p.monoFix;
  s->lrDiff = p.lrDiff;
  if (storage == Storage::F32) {
    for (int c = 0; c < p.channels; ++c) {
      s->f32v[c] = p.ch[c];
      s->f32[c] = s->f32v[c].data();
    }
    s->bytes = static_cast<std::uint64_t>(p.channels) * p.frames * 4;
  } else {
    float peak = 0;
    for (int c = 0; c < p.channels; ++c)
      for (float v : p.ch[c]) peak = std::max(peak, std::fabs(v));
    // 1/32768 unless the buffer exceeds full scale (mono-loss mid boost): then the scale grows so nothing clips
    const float scale = std::max(1.0f / 32768.0f, peak / 32767.0f);
    for (int c = 0; c < p.channels; ++c) {
      s->i16v[c].resize(p.ch[c].size());
      for (std::size_t i = 0; i < p.ch[c].size(); ++i) {
        const float q = std::nearbyint(p.ch[c][i] / scale);
        s->i16v[c][i] = static_cast<std::int16_t>(std::min(32767.0f, std::max(-32768.0f, q)));
      }
      s->i16[c] = s->i16v[c].data();
    }
    s->i16Scale = scale;
    s->bytes = static_cast<std::uint64_t>(p.channels) * p.frames * 2;
  }
  return s;
}

LoadOutcome loadSampleFile(const LoadRequest &rq, const HostDecodeFn &host) {
  LoadOutcome o;
  DecodeResult r = decodeFile(rq.url, host);
  if (!r.ok()) {
    o.status = r.status == DecodeResult::Status::Transient ? LoadOutcome::Status::Transient
                                                            : LoadOutcome::Status::Permanent;
    o.error = r.error;
    return o;
  }
  Pcm &pcm = r.pcm;
  if (pcm.sampleRate != rq.engineRate)
    for (int c = 0; c < pcm.channels; ++c) {
      std::vector<float> out;
      resampleChannel(pcm.ch[c], pcm.sampleRate, rq.engineRate, out);
      pcm.ch[c] = std::move(out);
    }
  Processed p = processSample(pcm.ch, pcm.channels, rq.engineRate, rq.midi, rq.opts);
  o.buffer = makeStored(p, rq.engineRate, rq.storage);
  o.status = LoadOutcome::Status::Ok;
  return o;
}

std::string urlOfKey(std::string_view key) {
  const std::size_t i = key.find(kVariantSep);
  return std::string(i == std::string_view::npos ? key : key.substr(0, i));
}

namespace {
double maxOfKey(const std::string &key) {
  const std::size_t i = key.find(kVariantSep);
  return i == std::string::npos ? 0 : std::atof(key.c_str() + i + 5);
}
std::string groupOf(const std::string &k) {
  const std::string u = urlOfKey(k);
  return u.substr(0, u.find_last_of('/') + 1) + k.substr(u.size());
}
std::string numToKey(double m) {  // JS `${m}`: integers without a decimal point
  char b[40];
  if (m == std::floor(m) && std::fabs(m) < 1e15) std::snprintf(b, sizeof b, "%.0f", m);
  else std::snprintf(b, sizeof b, "%.15g", m);
  return b;
}
}  // namespace

// ---- construction ------------------------------------------------------------------------------------------------

BufferCache::BufferCache(Config cfg, LoadFn load, JobRunner *runner)
    : cfg_(std::move(cfg)), load_(std::move(load)), runner_(runner) {}

BufferCache::~BufferCache() {
  // jobs still running on a worker pool must not outlive the cache: the owner destroys its pool first.
  graveyard_.clear();
}

double BufferCache::now() const {
  if (cfg_.nowMs) return cfg_.nowMs();
  using namespace std::chrono;
  return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

// ---- lookup helpers ----------------------------------------------------------------------------------------------

std::string BufferCache::standIn(const std::string &key) const {
  auto it = superseded_.find(key);
  if (it == superseded_.end()) return {};
  auto e = entries_.find(it->second);
  return e != entries_.end() ? it->second : std::string();
}

Stored *BufferCache::find(const std::string &key) {
  auto it = entries_.find(key);
  if (it == entries_.end()) {
    const std::string s = standIn(key);
    if (s.empty()) return nullptr;
    it = entries_.find(s);
  }
  return it->second.get();
}

const Stored *BufferCache::peek(std::string_view key) const { return find(std::string(key)); }

bool BufferCache::protectedKey(const std::string &key) const {
  if (!protect_) return true;
  if (protect_->count(key)) return true;
  auto l = supersededBy_.find(key);
  return l != supersededBy_.end() && protect_->count(l->second) > 0;
}

bool BufferCache::isPinned(const std::string &key) const {
  if (pinned_.count(key)) return true;
  auto l = supersededBy_.find(key);
  return l != supersededBy_.end() && pinned_.count(l->second) > 0;
}

std::string BufferCache::longOf(const std::string &url) const {
  auto it = longKeys_.find(url);
  if (it == longKeys_.end()) return {};
  for (const std::string &k : it->second)
    if (entries_.count(k)) return k;
  return {};
}

void BufferCache::adoptLong(const std::string &url) {
  const std::string lk = longOf(url);
  if (lk.empty()) return;
  superseded_[url] = lk;
  supersededBy_[lk] = url;
}

bool BufferCache::has(std::string_view key) const { return find(std::string(key)) != nullptr; }

bool BufferCache::failed(std::string_view key) const { return failed_.count(urlOfKey(key)) > 0; }

bool BufferCache::skipped(const std::string &url) {
  auto it = failed_.find(url);
  if (it == failed_.end()) return false;
  if (it->second.permanent || now() - it->second.at < kRetryAfterMs) return true;
  failed_.erase(it);  // a transient failure long enough ago: try again
  return false;
}

std::string BufferCache::keyOf(const std::string &url, int midi, double maxSec) const {
  if (!(maxSec > 0)) return url;
  auto it = meta_.find(url);
  if (it != meta_.end()) {
    const Meta &m = it->second;
    const double legacy = std::floor(legacyCapSec(m.midi) * m.sr + 0.5);
    const double longCap = std::floor(maxSec * m.sr + 0.5);
    const double nat = static_cast<double>(m.nat);
    if (std::min(nat, legacy) == std::min(nat, longCap)) return url;
  }
  (void)midi;
  return url + kVariantSep + numToKey(maxSec);
}

// ---- accounting --------------------------------------------------------------------------------------------------

std::uint64_t BufferCache::referencedBytes() const {
  std::uint64_t b = 0;
  for (const auto &kv : entries_)
    if (kv.second->refs > 0) b += kv.second->bytes;
  for (const auto &s : stale_) b += s->bytes;
  return b;
}

std::uint64_t BufferCache::pinnedBytes() const {
  std::uint64_t b = 0;
  std::set<std::string> seen;
  for (const std::string &u : pinned_) {
    std::string k = entries_.count(u) ? u : standIn(u);
    if (k.empty() || !seen.insert(k).second) continue;
    b += entries_.at(k)->bytes;
  }
  return b;
}

bool BufferCache::roomFor(double extra) const {
  if (static_cast<double>(bytes_) + extra <= static_cast<double>(cfg_.capBytes)) return true;
  double freeB = 0;
  for (const auto &kv : entries_) {
    const Stored &e = *kv.second;
    if (e.refs == 0 && !isPinned(kv.first) && !(protect_ && protectedKey(kv.first))) freeB += static_cast<double>(e.bytes);
  }
  return static_cast<double>(bytes_) - freeB + extra <= static_cast<double>(cfg_.capBytes);
}

BufferCache::Estimate BufferCache::estimateBytes(const std::vector<std::string> &keys) const {
  // a legacy key whose long variant is held is served by that buffer (stand-in): it costs the long buffer's size,
  // counted once with the long key itself
  std::vector<std::string> uniq;
  std::set<std::string> seen;
  for (const std::string &k : keys) {
    std::string held;
    if (!entries_.count(k)) {
      held = standIn(k);
      if (held.empty() && k == urlOfKey(k)) held = longOf(k);
    }
    const std::string &u = held.empty() ? k : held;
    if (seen.insert(u).second) uniq.push_back(u);
  }
  std::map<std::string, std::pair<int, double>> byDir;
  bool dirsBuilt = false;
  Estimate est;
  const double bps = bytesPerSample();
  for (const std::string &k : uniq) {
    const std::string url = urlOfKey(k);
    auto f = failed_.find(url);
    if (f != failed_.end() && f->second.permanent) continue;  // a missing file costs nothing
    auto sz = sizes_.find(k);
    if (sz != sizes_.end()) {
      est.bytes += sz->second;
      continue;
    }
    auto mt = meta_.find(url);
    if (mt != meta_.end()) {
      const double m = maxOfKey(k);
      const double cap = std::floor((m > 0 ? m : legacyCapSec(mt->second.midi)) * mt->second.sr + 0.5);
      est.bytes += mt->second.ch * std::max(1.0, std::min(static_cast<double>(mt->second.nat), cap)) * bps;
      continue;
    }
    if (!dirsBuilt) {
      for (const auto &kv : sizes_) {
        auto &a = byDir[groupOf(kv.first)];
        a.first += 1;
        a.second += kv.second;
      }
      dirsBuilt = true;
    }
    auto d = byDir.find(groupOf(k));
    est.bytes += d != byDir.end() ? d->second.second / d->second.first : defaultSampleBytes();
    ++est.unknown;
  }
  est.count = static_cast<int>(uniq.size());
  return est;
}

// ---- eviction ----------------------------------------------------------------------------------------------------

void BufferCache::deleteEntry(const std::string &key) {
  auto it = entries_.find(key);
  if (it == entries_.end()) return;
  std::unique_ptr<Stored> e = std::move(it->second);
  entries_.erase(it);
  bytes_ -= e->bytes;
  auto l = supersededBy_.find(key);
  if (l != supersededBy_.end()) {
    superseded_.erase(l->second);
    supersededBy_.erase(l);
  }
  graveyard_.push_back(std::move(e));
}

std::size_t BufferCache::collect() {
  const bool gated = static_cast<bool>(cfg_.graphEpoch);
  const std::uint64_t ep = gated ? cfg_.graphEpoch() : 0;
  std::size_t n = 0;
  for (std::size_t i = 0; i < graveyard_.size();) {
    const Stored &s = *graveyard_[i];
    if (!gated || !s.hasEpoch || ep > s.freeAfterEpoch + 1) {
      graveyard_[i] = std::move(graveyard_.back());
      graveyard_.pop_back();
      ++n;
    } else {
      ++i;
    }
  }
  return n;
}

void BufferCache::evict(double incoming) {
  collect();
  const double limit = static_cast<double>(cfg_.capBytes) - incoming;
  if (static_cast<double>(bytes_) <= limit) return;
  const double target = std::min(lowWaterBytes(), limit);
  auto lru = [](const std::pair<std::string, const Stored *> &a, const std::pair<std::string, const Stored *> &b) {
    return a.second->lastUsed != b.second->lastUsed ? a.second->lastUsed < b.second->lastUsed : a.first < b.first;
  };
  std::vector<std::pair<std::string, const Stored *>> cands;
  for (const auto &kv : entries_) {
    // with `protect` set, the playing / incoming song's unreferenced copies are not victims: the prepare reuses them
    if (kv.second->refs == 0 && !isPinned(kv.first) && !(protect_ && protectedKey(kv.first)))
      cands.emplace_back(kv.first, kv.second.get());
  }
  std::sort(cands.begin(), cands.end(), lru);
  for (const auto &c : cands) {
    if (static_cast<double>(bytes_) <= target) break;
    deleteEntry(c.first);
  }
  if (static_cast<double>(bytes_) <= limit || !protect_) return;
  cands.clear();
  for (const auto &kv : entries_)
    if (kv.second->refs == 0 && !protectedKey(kv.first)) cands.emplace_back(kv.first, kv.second.get());
  std::sort(cands.begin(), cands.end(), lru);
  for (const auto &c : cands) {
    if (static_cast<double>(bytes_) <= limit) break;
    deleteEntry(c.first);
    ++evictedPinned_;
  }
}

void BufferCache::setCapBytes(std::uint64_t b) {
  cfg_.capBytes = b;
  evict();
}

std::uint64_t BufferCache::trimUnpinned() {
  const std::uint64_t before = bytes_;
  std::vector<std::string> victims;
  for (const auto &kv : entries_)
    if (kv.second->refs == 0 && !isPinned(kv.first) && !(protect_ && protectedKey(kv.first))) victims.push_back(kv.first);
  for (const auto &k : victims) deleteEntry(k);
  return before - bytes_;
}

void BufferCache::trim(int level) {
  trimUnpinned();
  if (level >= 2) {
    // critical: pinned buffers beyond the current song go too (their pins stay; a later re-warm decodes them again)
    std::vector<std::string> victims;
    for (const auto &kv : entries_)
      if (kv.second->refs == 0 && !(protect_ && protectedKey(kv.first))) victims.push_back(kv.first);
    for (const auto &k : victims) deleteEntry(k);
  }
  collect();
}

void BufferCache::setEngineRate(double sr) {
  if (sr == cfg_.engineRate || !(sr > 0)) return;
  const double k = sr / cfg_.engineRate;
  cfg_.engineRate = sr;
  for (auto &kv : sizes_) kv.second *= k;
  for (auto &kv : meta_) {
    kv.second.nat = static_cast<std::uint64_t>(std::floor(static_cast<double>(kv.second.nat) * k + 0.5));
    kv.second.sr = sr;
  }
  std::vector<std::string> keys;
  for (const auto &kv : entries_) keys.push_back(kv.first);
  for (const auto &key : keys) {
    auto it = entries_.find(key);
    if (it->second->refs == 0) {
      deleteEntry(key);
    } else {  // a live instrument still reads it: keep it, off the lookup path, until released
      stale_.push_back(std::move(it->second));
      entries_.erase(it);
    }
  }
  superseded_.clear();
  supersededBy_.clear();
}

// ---- API: acquire / release / request ----------------------------------------------------------------------

const SampleBuffer *BufferCache::acquire(std::string_view keyv) {
  const std::string key(keyv);
  Stored *e = find(key);
  if (!e && key == urlOfKey(key)) {
    adoptLong(key);
    e = find(key);
  }
  if (!e) return nullptr;
  ++e->refs;
  e->lastUsed = ++tick_;
  evict();
  return e;
}

void BufferCache::release(const SampleBuffer *buf, std::uint64_t epoch) {
  if (!buf) return;
  auto *s = const_cast<Stored *>(static_cast<const Stored *>(buf));
  if (s->refs > 0) --s->refs;
  s->freeAfterEpoch = std::max(s->freeAfterEpoch, epoch);
  s->hasEpoch = true;
  for (std::size_t i = 0; i < stale_.size(); ++i) {
    if (stale_[i].get() != s) continue;
    if (s->refs == 0) {
      bytes_ -= s->bytes;
      graveyard_.push_back(std::move(stale_[i]));
      stale_.erase(stale_.begin() + static_cast<std::ptrdiff_t>(i));
    }
    break;
  }
  evict();
}

void BufferCache::declareSource(const std::string &url, int midi, const DecodeOpts &opts) {
  sources_[url] = {midi, opts};
}

void BufferCache::request(std::string_view keyv, int priority, Ready ready) {
  const std::string key(keyv);
  SampleJob job;
  job.url = urlOfKey(key);
  job.midi = 60;
  auto s = sources_.find(job.url);
  if (s != sources_.end()) {
    job.midi = s->second.first;
    job.opts = s->second.second;
  }
  job.opts.maxSec = maxOfKey(key);  // the key names the variant: no suffix = the legacy cap
  requestJob(job, priority, false, std::move(ready));
}

LoadOutcome BufferCache::runLoad(const LoadFn &load, const LoadRequest &rq, int retries, int delayMs) {
  LoadOutcome out;
  for (int attempt = 0; attempt <= retries; ++attempt) {
    out = load(rq);
    if (out.status != LoadOutcome::Status::Transient || attempt == retries) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(delayMs * (attempt + 1)));
  }
  return out;
}

void BufferCache::requestJob(const SampleJob &job, int priority, bool takeRef, Ready ready) {
  const std::string key = keyOf(job.url, job.midi, job.opts.maxSec);
  sources_[job.url] = {job.midi, job.opts};
  Stored *e = find(key);
  if (!e && key == job.url) {
    adoptLong(job.url);  // a legacy-cap request whose long variant is decoded takes the long buffer (same audio)
    e = find(key);
  }
  if (e) {
    if (takeRef) ++e->refs;
    e->lastUsed = ++tick_;
    evict();
    if (ready) ready(e);  // without takeRef the pointer is valid during the call only
    return;
  }
  if (skipped(job.url)) {
    if (ready) ready(nullptr);
    return;
  }
  auto it = inflight_.find(key);
  if (it != inflight_.end()) {
    it->second.push_back({takeRef, std::move(ready)});
    return;
  }
  inflight_[key].push_back({takeRef, std::move(ready)});
  ++posted_;
  LoadRequest rq;
  rq.url = job.url;
  rq.midi = job.midi;
  rq.opts = job.opts;
  rq.engineRate = cfg_.engineRate;
  rq.storage = cfg_.storage;
  auto work = [this, key, job, rq] {
    Done d;
    d.key = key;
    d.url = job.url;
    d.job = job;
    d.out = runLoad(load_, rq, cfg_.retries, cfg_.retryDelayMs);
    {
      std::lock_guard<std::mutex> l(mailM_);
      mailbox_.push_back(std::move(d));
    }
    if (cfg_.wake) cfg_.wake();
  };
  if (runner_) {
    runner_->post(priority, work);
    if (runner_->inlineMode()) pump();
  } else {
    work();
    pump();
  }
}

std::size_t BufferCache::pump() {
  std::vector<Done> batch;
  {
    std::lock_guard<std::mutex> l(mailM_);
    batch.swap(mailbox_);
  }
  for (Done &d : batch) finish(d);
  return batch.size();
}

void BufferCache::waitIdle() {
  while (!inflight_.empty()) {
    if (pump() == 0) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
}

void BufferCache::finish(Done &d) {
  std::vector<Waiter> waiters;
  auto it = inflight_.find(d.key);
  if (it != inflight_.end()) {
    waiters = std::move(it->second);
    inflight_.erase(it);
  }
  if (posted_ > 0) --posted_;
  Stored *e = nullptr;
  if (d.out.status != LoadOutcome::Status::Ok || !d.out.buffer) {
    const bool first = failed_.find(d.url) == failed_.end();
    failed_[d.url] = {now(), d.out.status != LoadOutcome::Status::Transient};
    if (first && cfg_.warn) cfg_.warn("Sample missing or undecodable, skipped: " + d.url + " (" + d.out.error + ")");
  } else if (d.out.buffer->sampleRate != cfg_.engineRate) {
    // the engine rate changed while this decoded: not a failure, the caller asks again at the new rate
  } else {
    Stored &b = *d.out.buffer;
    meta_[d.url] = {b.natural, static_cast<int>(b.channels), b.sampleRate, d.job.midi};
    const std::string key = keyOf(d.url, d.job.midi, d.job.opts.maxSec);  // the natural length is known now
    auto ex = entries_.find(key);
    if (ex != entries_.end()) {
      e = ex->second.get();
    } else {
      evict(static_cast<double>(b.bytes));  // make room first: decodedMB never passes the cap by the new buffer
      b.lastUsed = ++tick_;
      const std::uint64_t nb = b.bytes;
      e = d.out.buffer.get();
      entries_[key] = std::move(d.out.buffer);
      if (key != d.url) longKeys_[d.url].insert(key);
      bytes_ += nb;
      sizes_[key] = static_cast<double>(nb);
    }
  }
  if (e) ++e->refs;  // held while the callbacks run: an earlier callback cannot evict it from under a later one
  for (Waiter &w : waiters) {
    if (e) {
      if (w.takeRef) ++e->refs;
      e->lastUsed = ++tick_;
    }
    if (w.ready) w.ready(e);
  }
  if (e) {
    --e->refs;
    evict();
  }
}

// ---- pins, protection --------------------------------------------------------------------------------------

void BufferCache::pinAdd(const std::vector<std::string> &keys) {
  for (const auto &k : keys) pinned_.insert(k);
  evict();
}
void BufferCache::setPins(const std::vector<std::string> &keys) {
  pinned_ = std::set<std::string>(keys.begin(), keys.end());
  evict();
}
void BufferCache::unpin(const std::vector<std::string> &keys) {
  for (const auto &k : keys) pinned_.erase(k);
  evict();
}

void BufferCache::pin(const std::string *keys, std::size_t n, std::string_view mode) {
  std::vector<std::string> v(keys, keys + n);
  if (mode == "replace") setPins(v);
  else if (mode != "none") pinAdd(v);
}

void BufferCache::protect(const std::string *keys, std::size_t n) {
  if (!keys) {
    protect_.reset();
  } else {
    protect_ = std::set<std::string>(keys, keys + n);
  }
  evict();
}

void BufferCache::supersede(const std::string &legacyKey, const std::string &longKey) {
  auto it = entries_.find(legacyKey);
  if (it != entries_.end() && it->second->refs == 0 && longKey != legacyKey && entries_.count(longKey)) {
    deleteEntry(legacyKey);
    superseded_[legacyKey] = longKey;
    supersededBy_[longKey] = legacyKey;
  }
  evict();
}

BufferCache::Invalidated BufferCache::invalidate(const std::vector<std::string> &urls) {
  Invalidated r;
  std::set<std::string> set;
  for (const auto &u : urls) set.insert(urlOfKey(u));
  for (const auto &u : set) {
    r.failed += static_cast<int>(failed_.erase(u));
    meta_.erase(u);  // a re-imported file may differ in length
  }
  for (auto i = sizes_.begin(); i != sizes_.end();) i = set.count(urlOfKey(i->first)) ? sizes_.erase(i) : std::next(i);
  std::vector<std::string> victims;
  for (const auto &kv : entries_)
    if (set.count(urlOfKey(kv.first)) && kv.second->refs == 0) victims.push_back(kv.first);
  for (const auto &k : victims) {
    deleteEntry(k);
    ++r.dropped;
  }
  return r;
}

}  // namespace rig::samples
