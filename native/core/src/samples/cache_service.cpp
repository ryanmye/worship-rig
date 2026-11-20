#include "samples/cache_service.h"

#include <chrono>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <set>
#include <thread>

#include "bridge/json_out.h"
#include "io/wav.h"
#include "samples/resampler.h"
#include "model/model.h"
#include "model/patch.h"
#include "rig/rig_engine.h"
#include "yyjson.h"

namespace rig::samples {
namespace {

const rig_config *cfgOf(rig::Model &m) {
  return m.env().config;
}

bool realtime(const rig_config *c) {
  return c && c->mode == RIG_MODE_REALTIME;
}
bool ipad(const rig_config *c) {
  return c && c->profile == RIG_PROFILE_IPAD;
}

Storage storageOf(const rig_config *c) {
  if (c && c->sample_storage == RIG_SAMPLES_F32) return Storage::F32;
  if (c && c->sample_storage == RIG_SAMPLES_I16) return Storage::I16;
  return ipad(c) ? Storage::I16 : Storage::F32;
}

std::unique_ptr<JobRunner> makeRunner(const rig_config *c) {
  if (!realtime(c)) return std::make_unique<InlineRunner>();
  unsigned n = c->decode_threads;
  if (!n) {
    const unsigned hw = std::thread::hardware_concurrency();
    n = ipad(c) ? 1 : std::max(1u, std::min(2u, hw > 1 ? hw - 1 : 1u));
  }
  return std::make_unique<ThreadPool>(n);
}

HostDecodeFn hostDecoder(const rig_config *c) {
  if (!c || !c->host || !c->host->decode_file) return nullptr;
  const rig_host *h = c->host;
  return [h](const std::string &path, Pcm &out, std::string *err) {
    rig_decoded_audio a{};
    a.struct_size = sizeof a;
    if (h->decode_file(h->user, path.c_str(), &a) != 0 || !a.data || !a.channels || !a.frames) {
      if (err) *err = "host decode failed";
      return false;
    }
    out.sampleRate = a.sample_rate;
    out.channels = a.channels >= 2 ? 2 : 1;
    for (int ch = 0; ch < out.channels; ++ch) out.ch[ch].assign(a.data[ch], a.data[ch] + a.frames);
    if (h->free_decoded) h->free_decoded(h->user, &a);
    return true;
  };
}

BufferCache::Config cacheConfig(const rig_config *c, rig::Model &m, std::function<void(const std::string &)> warn) {
  BufferCache::Config cfg;
  const std::uint64_t mb = c && c->cache_mb ? c->cache_mb : (ipad(c) ? 320u : 700u);
  cfg.capBytes = mb * 1024ull * 1024ull;
  // T00c (D3 memory budget, ARCHITECTURE section 7): hard cap = the cap on the iPad (jetsam: nothing above the
  // budget), 1.5 x the cap on the desktop (referenced buffers may pass the soft cap, as in 1.x, but not without
  // bound: 16 sampler slots can reference > 2 GB of float32 samples).
  cfg.hardCapBytes = ipad(c) ? cfg.capBytes : cfg.capBytes / 2 * 3;
  cfg.storage = storageOf(c);
  cfg.engineRate = m.env().sampleRate;
  cfg.warn = std::move(warn);
  return cfg;
}

double round1(double x) {
  return std::floor(x * 10 + 0.5) / 10;
}

}  // namespace

struct CacheServiceImpl::PreloadOp {
  std::vector<rig::PatchSpec> patches;
  std::vector<SampleJob> jobs;
  std::string pin;
  std::size_t next = 0, inflight = 0;
  int deferred = 0;
  bool advancing = false, finished = false;
  std::function<void(std::string)> done;
};

CacheServiceImpl::CacheServiceImpl(rig::Model &m)
    : model_(m),
      runner_(makeRunner(cfgOf(m))),
      cache_(
          [&] {
            BufferCache::Config c = cacheConfig(cfgOf(m), m, [this](const std::string &s) { warnMsg(s, "decode"); });
            c.warnMemory = [this](const std::string &s) { warnMsg(s, "memory"); };  // T00c
            return c;
          }(),
          [h = hostDecoder(cfgOf(m))](const LoadRequest &rq) { return loadSampleFile(rq, h); }, runner_.get()) {
  const rig_config *c = cfgOf(m);
  if (c && (c->flags & RIG_FLAG_TEST_API))
    if (const char *dir = std::getenv("RIG_SAMPLES_PCM_OVERRIDE")) setPcmOverride(dir);
}

void CacheServiceImpl::setPcmOverride(const std::string &dir) {
  HostDecodeFn host = hostDecoder(cfgOf(model_));
  if (dir.empty()) {
    cache_.setLoader([host](const LoadRequest &rq) { return loadSampleFile(rq, host); });
    return;
  }
  cache_.setLoader([dir, host](const LoadRequest &rq) {
    // key = path below ".../samples/" without extension, '/' -> "__" (tools/golden/decode-dump/dump.mjs)
    std::string rel = rq.url;
    const std::size_t at = rel.rfind("/samples/");
    if (at != std::string::npos) rel = rel.substr(at + 9);
    const std::size_t dot = rel.find_last_of('.');
    if (dot != std::string::npos) rel.resize(dot);
    for (std::size_t i = 0; (i = rel.find('/', i)) != std::string::npos;) rel.replace(i, 1, "__");
    std::string file = dir + "/raw" + std::to_string(static_cast<long>(rq.engineRate)) + "/" + rel + ".wav";
    if (!std::filesystem::exists(file)) {  // native/golden/pcm layout: <set>/<note>.wav at the file's own rate
      std::string nested = rel;
      for (std::size_t i = 0; (i = nested.find("__", i)) != std::string::npos;) nested.replace(i, 2, "/");
      file = dir + "/" + nested + ".wav";
    }
    io::WavData w;
    if (!std::filesystem::exists(file) || !io::readWav(file, w, nullptr) || w.ch.empty() || w.frames() == 0)
      return loadSampleFile(rq, host);
    Pcm pcm;
    pcm.sampleRate = w.sampleRate;
    pcm.channels = w.ch.size() >= 2 ? 2 : 1;
    for (int c = 0; c < pcm.channels; ++c) {
      if (w.sampleRate != rq.engineRate)
        resampleChannel(w.ch[static_cast<std::size_t>(c)], w.sampleRate, rq.engineRate, pcm.ch[c]);
      else
        pcm.ch[c] = std::move(w.ch[static_cast<std::size_t>(c)]);
    }
    LoadOutcome o;
    o.buffer =
        makeStored(processSample(pcm.ch, pcm.channels, rq.engineRate, rq.midi, rq.opts), rq.engineRate, rq.storage);
    o.status = LoadOutcome::Status::Ok;
    return o;
  });
}

CacheServiceImpl::~CacheServiceImpl() {
  runner_.reset();  // join the workers before the cache (their mailbox) goes away
}

void CacheServiceImpl::warnMsg(const std::string &m, const char *code) {
  model_.warn(m, code);
}

// ---- paths, manifests --------------------------------------------------------------------------------------

void CacheServiceImpl::onPaths(const rig::EnginePaths &p) {
  const bool appChanged = !p.appDir.empty() && p.appDir != loadedApp_;
  paths_ = p;
  auto warn = [this](const std::string &s) { warnMsg(s, "manifest"); };
  if (appChanged) {
    loadedApp_ = p.appDir;
    registry_.loadFactory(p.appDir, warn);
    std::vector<std::string> dropped;
    registry_.reloadUser(p.userManifest, warn, dropped);
    for (const auto &kv : registry_.all())
      for (const Layer &L : kv.second.layers)
        for (const SampleRef &s : L.samples) cache_.declareSource(s.url, s.midi, kv.second.decodeOpts);
    return;
  }
  // rig_set_paths re-reads the user manifest even when the path is the same (the Settings rescan after an import)
  if (!p.userManifest.empty()) reloadManifests();
}

bool CacheServiceImpl::reloadManifests() {
  auto warn = [this](const std::string &s) { warnMsg(s, "manifest"); };
  std::vector<std::string> dropped;
  const auto r = registry_.reloadUser(paths_.userManifest, warn, dropped);
  if (r == SampleRegistry::UserResult::Failed) return false;
  // a successful reload clears the failure marks and unreferenced buffers of every user sample path, old and new
  cache_.invalidate(dropped);
  return true;
}

// ---- patches -> keys -----------------------------------------------------------------------------------------

std::vector<rig::PatchSpec> CacheServiceImpl::parsePatches(const yyjson_val *patches) const {
  std::vector<rig::PatchSpec> out;
  auto *arr = const_cast<yyjson_val *>(patches);
  if (!arr || !yyjson_is_arr(arr)) return out;
  std::size_t i, n;
  yyjson_val *v;
  yyjson_arr_foreach(arr, i, n, v) {
    rig::PatchSpec ps;
    std::string err;
    if (rig::parsePatch(v, ps, &err)) out.push_back(std::move(ps));
  }
  return out;
}

CacheServiceImpl::JobList CacheServiceImpl::sampleJobs(const std::vector<rig::PatchSpec> &patches) const {
  JobList out;
  std::set<std::string, std::less<>> live;
  for (const auto &s : model_.patch().slots)
    if (s.present && s.instType == "sampler") live.insert(s.instId);
  for (const auto &p : patches) {
    for (const auto &s : p.slots) {
      if (!s.present || s.instType != "sampler") continue;
      const SamplerDef *def = registry_.find(s.instId);
      if (!def) continue;
      // sustain (pin budget): an instrument the playing song uses is keyed at its long cap, every other at the
      // legacy 10 s / 16 s cap
      const double maxSec = live.count(def->id) ? def->decodeOpts.maxSec : 0;
      DecodeOpts opts = def->decodeOpts;
      if (def->decodeOpts.maxSec > 0 && !(maxSec > 0)) opts.maxSec = 0;
      for (const Layer &L : def->layers)
        for (const SampleRef &smp : L.samples) {
          SampleJob job;
          job.url = smp.url;
          job.midi = smp.midi;
          job.opts = opts;
          const std::string key = cache_.keyOf(smp.url, smp.midi, maxSec);
          out.keys.push_back(key);
          out.jobs.push_back(std::move(job));
          out.jobKeys.push_back(key);
        }
    }
  }
  return out;
}

std::vector<std::string> CacheServiceImpl::currentKeys() const {
  return sampleJobs({model_.patch()}).keys;
}

std::vector<std::string> CacheServiceImpl::protectKeys(const std::vector<const rig::PatchSpec *> &patches) const {
  std::set<std::string> out;
  for (const rig::PatchSpec *p : patches) {
    if (!p) continue;
    for (const auto &s : p->slots) {
      if (!s.present || s.instType != "sampler") continue;
      const SamplerDef *def = registry_.find(s.instId);
      if (!def) continue;
      const double m = def->decodeOpts.maxSec;
      for (const Layer &L : def->layers)
        for (const SampleRef &smp : L.samples) {
          out.insert(smp.url);
          if (m > 0) {
            out.insert(cache_.keyOf(smp.url, smp.midi, m));
            char b[40];
            std::snprintf(b, sizeof b, "%.15g", m);
            out.insert(smp.url + kVariantSep + b);
          }
        }
    }
  }
  return std::vector<std::string>(out.begin(), out.end());
}

void CacheServiceImpl::protectSwitch(const rig::PatchSpec *playing, const rig::PatchSpec *incoming) {
  const auto keys = protectKeys({playing, incoming});
  cache_.protect(keys.data(), keys.size());
}

// ---- pins --------------------------------------------------------------------------------------------------

// T00c pin policy (D3 memory budget): pinned bytes stay within the pin budget, 85 % of the HARD cap (iPad 272 of
// 320 MB; desktop 892 of the 1050 MB hard cap, above the controller's own 600 MB PIN_BUDGET_MB), so pins alone never
// fill the cache and the playing song keeps room (its decodes also push other songs' pins out while it is
// protected). Keys are taken in request order
// (the first patch = the song that plays next) until the budget is spent; the rest stay unpinned (counted in
// pinsDropped, one `memory` warning per preload). Low-resource mode pins the current song only, whatever its size.
std::vector<std::string> CacheServiceImpl::withinPinBudget(const std::vector<std::string> &keys, bool add) {
  const double hard = static_cast<double>(cache_.hardCapBytes() ? cache_.hardCapBytes() : cache_.capBytes());
  const double budget = 0.85 * hard;
  // T00c review: what is pinned already is counted by its ESTIMATE (stored size once decoded), not pinnedBytes(),
  // which sees decoded pins only: back-to-back `preload {pin:'add'}` calls land before their decodes do.
  double used = 0.0;
  if (add) used = cache_.estimateBytes(std::vector<std::string>(cache_.pins().begin(), cache_.pins().end())).bytes;
  std::vector<std::string> out;
  std::set<std::string> seen;
  int dropped = 0;
  for (const std::string &k : keys) {
    if (!seen.insert(k).second) continue;
    if (add && cache_.pins().count(k)) {  // already pinned and counted
      out.push_back(k);
      continue;
    }
    const double b = cache_.estimateBytes({k}).bytes;
    if (used + b > budget) {
      ++dropped;
      continue;
    }
    used += b;
    out.push_back(k);
  }
  if (dropped) {
    pinsDropped_ += dropped;
    warnMsg(std::to_string(dropped) + " sample(s) stay unpinned: pins are capped at " +
                std::to_string(static_cast<long long>(budget / kMB)) + " MB (85 % of the sample cache's hard cap)",
            "memory");
  }
  return out;
}

void CacheServiceImpl::doPin(const std::vector<std::string> &keys, const std::string &pin) {
  if (lowRes_)
    cache_.setPins(currentKeys());  // low resource: pin policy 'current-only'
  else if (pin == "replace")
    cache_.setPins(withinPinBudget(keys, false));
  else if (pin != "none")
    cache_.pinAdd(withinPinBudget(keys, true));
}

void CacheServiceImpl::setLowResource(bool on) {
  if (on == lowRes_) return;
  lowRes_ = on;
  if (on) {
    lowResSavedPins_.assign(cache_.pins().begin(), cache_.pins().end());
    cache_.setPins(currentKeys());
    cache_.trimUnpinned();
  } else {
    std::vector<std::string> pins = lowResSavedPins_;
    const auto cur = currentKeys();
    pins.insert(pins.end(), cur.begin(), cur.end());
    cache_.setPins(pins);
    lowResSavedPins_.clear();
  }
}

void CacheServiceImpl::rewarmPins() {
  if (rewarming_ || pinJobs_.empty()) return;
  rewarming_ = true;
  rewarmFrom(0);
}

// Nearest-pinned first in preload order, while they fit without pushing anything pinned out. Each decode continues
// with the next job from its callback (inline: from the loop below, without recursion).
void CacheServiceImpl::rewarmFrom(std::size_t i) {
  for (; i < pinJobs_.size(); ++i) {
    const std::string key = pinJobs_[i].first;
    const SampleJob job = pinJobs_[i].second;
    if (!cache_.pins().count(key) && !cache_.pins().count(job.url)) continue;
    if (cache_.has(key) || cache_.has(cache_.keyOf(job.url, job.midi, job.opts.maxSec))) continue;
    if (!cache_.roomFor(cache_.estimateBytes({key}).bytes)) break;
    rewarmInSync_ = true;
    const std::size_t before = rewarmDone_;
    cache_.requestJob(job, 2, false, [this, i](const SampleBuffer *) {
      if (rewarmInSync_) {
        ++rewarmDone_;  // finished inside requestJob: the loop carries on
        return;
      }
      rewarmFrom(i + 1);  // asynchronous completion (pump): continue from here
    });
    rewarmInSync_ = false;
    if (rewarmDone_ == before) return;  // a worker is decoding: its callback continues
  }
  rewarming_ = false;
}

// ---- preload -----------------------------------------------------------------------------------------------------

void CacheServiceImpl::advance(const std::shared_ptr<PreloadOp> &op) {
  if (op->advancing) return;
  op->advancing = true;
  while (op->next < op->jobs.size() && op->inflight < 6) {
    const SampleJob &job = op->jobs[op->next++];
    const std::string key = cache_.keyOf(job.url, job.midi, job.opts.maxSec);
    // a warm-up decode never pushes another song's pinned buffers out: with no unpinned room left it waits for
    // rewarmPins (pinned) or is skipped (unpinned)
    const bool held = cache_.has(key) || (key == job.url && !cache_.longOf(job.url).empty());
    if (cache_.hasProtect() && !cache_.isProtected(key) && !held &&
        !cache_.roomFor(cache_.estimateBytes({key}).bytes)) {
      ++op->deferred;
      continue;
    }
    ++op->inflight;
    cache_.requestJob(job, 1, false, [this, op](const SampleBuffer *) {
      --op->inflight;
      advance(op);
    });
  }
  op->advancing = false;
  if (!op->finished && op->next >= op->jobs.size() && op->inflight == 0) {
    op->finished = true;
    // keys are recomputed now that the natural lengths are known (a long key of a sample shorter than the legacy cap
    // collapses to the plain URL, which is where its buffer was stored)
    doPin(sampleJobs(op->patches).keys, op->pin);
    if (op->deferred) rewarmPins();
    JsonOut j;
    j.begin().kv("decodedMB", cache_.decodedMB()).kv("pinnedMB", cache_.pinnedMB()).kv("deferred", op->deferred).end();
    std::string reply = j.take();
    JsonOut ev;
    ev.begin()
        .kv("v", 1)
        .kv("ev", "load")
        .kv("phase", "preload")
        .kv("decodedMB", cache_.decodedMB())
        .kv("pinnedMB", cache_.pinnedMB())
        .kv("deferred", op->deferred)
        .end();
    model_.emit(ev.take());
    if (op->done) op->done(std::move(reply));
  }
}

void CacheServiceImpl::preloadAsync(const yyjson_val *patches, std::string_view pin,
                                    std::function<void(std::string)> done) {
  auto op = std::make_shared<PreloadOp>();
  op->patches = parsePatches(patches);
  op->pin = pin.empty() || pin == "auto" ? (op->patches.size() > 2 ? "replace" : "add") : std::string(pin);
  op->done = std::move(done);
  JobList jl = sampleJobs(op->patches);
  if (!lowRes_) { /* reverb warm-ups belong to the reverb service (preload hook, T04) */
  }
  doPin(jl.keys, op->pin);
  // remembered for rewarmPins (a pinned sample evicted for a switch's headroom comes back later)
  if (op->pin == "replace" || op->pin == "add") {
    if (op->pin == "replace") pinJobs_.clear();
    for (std::size_t i = 0; i < jl.jobs.size(); ++i) {
      bool found = false;
      for (auto &pj : pinJobs_)
        if (pj.first == jl.jobKeys[i]) {
          pj.second = jl.jobs[i];
          found = true;
        }
      if (!found) pinJobs_.emplace_back(jl.jobKeys[i], jl.jobs[i]);
    }
  }
  op->jobs = std::move(jl.jobs);
  ops_.push_back(op);
  advance(op);
  ops_.erase(std::remove_if(ops_.begin(), ops_.end(), [](const auto &o) { return o->finished; }), ops_.end());
}

std::string CacheServiceImpl::preload(const yyjson_val *patches, std::string_view pin) {
  std::string out;
  bool done = false;
  preloadAsync(patches, pin, [&](std::string j) {
    out = std::move(j);
    done = true;
  });
  while (!done) {
    if (pump() == 0) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  return out;
}

std::size_t CacheServiceImpl::pump() {
  const std::size_t n = cache_.pump();
  cache_.collect();
  ops_.erase(std::remove_if(ops_.begin(), ops_.end(), [](const auto &o) { return o->finished; }), ops_.end());
  return n;
}

std::string CacheServiceImpl::estimate(const yyjson_val *patches) {
  const JobList jl = sampleJobs(parsePatches(patches));
  const BufferCache::Estimate e = cache_.estimateBytes(jl.keys);
  JsonOut j;
  j.begin()
      .kv("mb", e.bytes / kMB)
      .kvBool("exact", e.unknown == 0)
      .kv("samples", e.count)
      .kv("capMB", cache_.capMB())
      .end();
  return j.take();
}

std::string CacheServiceImpl::sampleStatus(const yyjson_val *patches) {
  JsonOut loaded, failed;
  loaded.beginArray();
  failed.beginArray();
  for (const auto &p : parsePatches(patches)) {
    const JobList jl = sampleJobs({p});
    bool ok = true, bad = false;
    for (std::size_t i = 0; i < jl.jobs.size(); ++i) {
      const std::string &url = jl.jobs[i].url;
      const bool isFailed = cache_.failed(url);
      const bool held = cache_.has(jl.keys[i]) || cache_.has(url) || !cache_.longOf(url).empty();
      if (!held && !isFailed) ok = false;
      if (isFailed) bad = true;
    }
    loaded.elemBool(ok);
    failed.elemBool(bad);
  }
  loaded.endArray();
  failed.endArray();
  JsonOut j;
  j.begin().kvRaw("loaded", loaded.view()).kvRaw("failed", failed.view()).end();
  return j.take();
}

// ---- events from the engine ------------------------------------------------------------------------------------

void CacheServiceImpl::onCommit(const rig::PatchSpec &patch, double) {
  const auto keys = protectKeys({&patch});
  cache_.protect(keys.data(), keys.size());  // the song that now plays: its buffers stay
  if (lowRes_) cache_.setPins(currentKeys());
  rewarmPins();
}

void CacheServiceImpl::onRateChanged(double sr) {
  cache_.setEngineRate(sr);
}

void CacheServiceImpl::onMemoryPressure(int level) {
  cache_.trim(level);
}

std::string CacheServiceImpl::statsFields() {
  JsonOut j;
  j.kv("decodedMB", round1(cache_.decodedMB()))
      .kv("pinnedMB", round1(cache_.pinnedMB()))
      .kv("referencedMB", round1(static_cast<double>(cache_.referencedBytes()) / kMB))
      .kv("capMB", round1(cache_.capMB()))
      .kv("hardCapMB", round1(static_cast<double>(cache_.hardCapBytes()) / kMB))  // T00c
      .kv("pinsDropped", pinsDropped_)
      .kv("capRefused", cache_.capRefused());
  std::string s = j.take();
  return s;
}

}  // namespace rig::samples
