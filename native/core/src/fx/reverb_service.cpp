// ReverbPool (see reverb_service.h): the control half of app/js/engine/fx.js Reverb (fx.js:579-1122) and of the
// AudioEngine reverb policy in audio.js (stage in prepare, commitTo in commit, retainReverb, preload warm-ups, the
// low-resource trim). Function names follow the JS ones so the two can be read side by side.
#include "fx/reverb_service.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>

#include "fx/ir_gen.h"
#include "model/model.h"
#include "model/patch.h"
#include "rig/rig_engine.h"
#include "yyjson.h"

namespace rig::fx {
namespace {

std::mutex &registryMu() {
  static std::mutex m;
  return m;
}
std::map<const void *, ReverbPool *> &registry() {
  static std::map<const void *, ReverbPool *> r;
  return r;
}

double clampPd(double v) {
  return std::isnan(v) ? 0.0 : std::min(kPredelayMax, std::max(0.0, v));
}

constexpr double kInf = std::numeric_limits<double>::infinity();

}  // namespace

ReverbPool::ReverbPool(Model &m) : m_(m), patchKey_(&m.patch()) {
  const rig_config *cfg = m.env().config;
  offline_ = !cfg || cfg->mode == RIG_MODE_OFFLINE;
  inline_ = offline_;
  seed_ = m.env().seed;
  sr_ = m.env().sampleRate;
  const bool ipad = cfg && cfg->profile == RIG_PROFILE_IPAD;
  maxUnits_ = cfg && cfg->reverb_units_max ? cfg->reverb_units_max : (ipad ? 4u : 10u);  // REVERB_UNITS_MAX
  maxBytes_ = (ipad ? std::size_t(32) : std::size_t(160)) << 20;  // ARCHITECTURE 7: iPad <= 30 MB of reverb
  std::lock_guard<std::mutex> lk(registryMu());
  registry()[patchKey_] = this;
}

ReverbPool::~ReverbPool() {
  {
    std::lock_guard<std::mutex> lk(registryMu());
    auto it = registry().find(patchKey_);
    if (it != registry().end() && it->second == this) registry().erase(it);
  }
  {
    std::lock_guard<std::mutex> lk(mu_);
    stop_ = true;
  }
  cv_.notify_all();
  if (worker_.joinable()) worker_.join();
}

ReverbPool *ReverbPool::forPatch(const PatchSpec *patch) {
  std::lock_guard<std::mutex> lk(registryMu());
  auto it = registry().find(patch);
  return it == registry().end() ? nullptr : it->second;
}

double ReverbPool::now() const {
  return m_.now();
}
double ReverbPool::t(double when) const {
  return m_.timeFor(when);
}
void ReverbPool::at(double time, std::function<void(double)> fn) {
  m_.sink().at(time, std::move(fn));
}

std::string ReverbPool::irKeyFor(double size, double damp) const {
  return irKey(size, damp, sr_);
}

void ReverbPool::setLimits(unsigned maxUnits, std::size_t maxBytes) {
  maxUnits_ = std::max(1u, maxUnits);
  maxBytes_ = maxBytes;
  evict();
}

std::size_t ReverbPool::bytes() const {
  std::size_t b = 0;
  for (const auto &e : pool_) b += e.second.first->bytes();
  return b;
}

std::vector<std::string> ReverbPool::keys() const {
  std::vector<std::pair<std::uint64_t, std::string>> v;
  for (const auto &e : pool_) v.emplace_back(e.second.second, e.first);
  std::sort(v.begin(), v.end());
  std::vector<std::string> out;
  for (auto &p : v) out.push_back(p.second);
  return out;
}

std::string ReverbPool::activeKey() const {
  return active_ >= 0 ? slots_[active_].key : std::string();
}
std::string ReverbPool::targetKey() const {
  return !target_.empty() ? target_ : activeKey();
}
double ReverbPool::activePredelay() const {
  return active_ >= 0 ? slots_[active_].pdV[slots_[active_].cur] : predelayV_;
}
std::size_t ReverbPool::quietWaiting() const {
  std::size_t n = 0;
  for (const auto &e : inflight_) n += e.second.gated ? 1 : 0;
  return n;
}

// ---- pool -------------------------------------------------------------------------------------------------------

ReverbPool::KernelPtr ReverbPool::cached(const std::string &key) {
  auto it = pool_.find(key);
  if (it == pool_.end()) return nullptr;
  it->second.second = ++tick_;  // _touch
  return it->second.first;
}

ReverbPool::KernelPtr ReverbPool::buildKernel(const std::string &key, double sr, double size, double damp) const {
  return override_ ? override_(key, sr, size, damp) : ReverbKernel::build(sr, seed_, size, damp);
}

ReverbPool::KernelPtr ReverbPool::unitSync(double size, double damp) {
  const std::string key = irKeyFor(size, damp);
  if (KernelPtr k = cached(key)) return k;
  KernelPtr k = buildKernel(key, sr_, size, damp);
  ++builds_;
  newUnit(key, k);
  return k;
}

void ReverbPool::newUnit(const std::string &key, KernelPtr k) {
  pool_[key] = {std::move(k), ++tick_};
  if (!offline_) builtAt_ = now();  // v11-reverb-quiet: a build ends a pause
  evict();
}

bool ReverbPool::busy(const std::string &key) const {
  if (keep_.count(key)) return true;
  for (const SlotMirror &s : slots_)
    if (s.key == key && (s.st == SlotState::Active || s.st == SlotState::Fading)) return true;
  return false;
}

void ReverbPool::dropKernel(const std::string &key) {
  pool_.erase(key);
  for (unsigned s = 0; s < kReverbSlots; ++s) {
    SlotMirror &m = slots_[s];
    if (m.key != key || m.st != SlotState::Idle) continue;
    Command c{};
    c.op = opOf(ReverbOp::Release);
    c.aux = s;
    m_.sendUnitOp(UnitSlot::Reverb, c, -1.0);
    m = SlotMirror{};
    m.gen = ++tick_;
  }
}

void ReverbPool::evict() {
  for (const std::string &k : keys())  // spaces built for an earlier device rate are never played again
    if (pool_.at(k).first->sampleRate != sr_ && !busy(k)) dropKernel(k);
  if (retain_) {
    for (const std::string &k : keys())
      if (!busy(k) && !retain_->count(k) && !songKeys_.count(k)) dropKernel(k);
  }
  for (const std::string &k : keys()) {  // LRU order
    if (pool_.size() <= maxUnits_ && bytes() <= maxBytes_) break;
    if (!busy(k)) dropKernel(k);
  }
}

bool ReverbPool::retain(const yyjson_val *patches) {
  if (!unitBuilt_) return false;  // JS: false before start()
  std::set<std::string> keys;
  yyjson_val *arr = const_cast<yyjson_val *>(patches);
  if (arr && yyjson_is_arr(arr)) {
    size_t i, n;
    yyjson_val *v;
    yyjson_arr_foreach(arr, i, n, v) {
      if (!v || !yyjson_is_obj(v)) continue;  // patchStates.filter(Boolean)
      PatchSpec p;
      if (!parsePatch(v, p, nullptr)) continue;
      keys.insert(irKeyFor(p.reverb.size, p.reverb.damp));  // T14: the effective (wash) size
    }
  }
  retain_ = std::move(keys);
  evict();
  return true;
}

// ---- builds -------------------------------------------------------------------------------------------------------

void ReverbPool::workerLoop() {
  for (;;) {
    Job j;
    {
      std::unique_lock<std::mutex> lk(mu_);
      cv_.wait(lk, [&] { return stop_ || !jobs_.empty(); });
      if (stop_) return;
      j = jobs_.front();
      jobs_.erase(jobs_.begin());
      ++running_;
    }
    KernelPtr k = buildKernel(j.key, j.sr, j.size, j.damp);
    {
      std::lock_guard<std::mutex> lk(mu_);
      mailbox_.emplace_back(j.key, std::move(k));
      --running_;
    }
  }
}

void ReverbPool::startJob(const std::string &key, double size, double damp) {
  if (jobKeys_.count(key)) return;
  jobKeys_.insert(key);
  if (inline_) {  // offline engine (simulated realtime policy): build now, deliver as the worker would
    KernelPtr k = buildKernel(key, sr_, size, damp);
    {
      std::lock_guard<std::mutex> lk(mu_);
      mailbox_.emplace_back(key, std::move(k));
    }
    pump();
    return;
  }
  {
    std::lock_guard<std::mutex> lk(mu_);
    jobs_.push_back(Job{key, sr_, size, damp, seed_});
    if (!worker_.joinable()) worker_ = std::thread([this] { workerLoop(); });
  }
  cv_.notify_one();
  armPoll();
}

void ReverbPool::armPoll() {
  if (pollArmed_) return;
  pollArmed_ = true;
  at(now() + kReverbQuietPoll, [this](double) {
    pollArmed_ = false;
    pump();
    if (!jobKeys_.empty()) armPoll();
  });
}

std::size_t ReverbPool::pump() {
  std::vector<std::pair<std::string, KernelPtr>> done;
  {
    std::lock_guard<std::mutex> lk(mu_);
    done.swap(mailbox_);
  }
  for (auto &d : done) {
    jobKeys_.erase(d.first);
    ++builds_;
    auto it = inflight_.find(d.first);
    if (it != inflight_.end()) {
      it->second.kernel = std::move(d.second);
      tryFinish(d.first);
    } else {
      prebuilt_[d.first] = std::move(d.second);
      while (prebuilt_.size() > 2) prebuilt_.erase(prebuilt_.begin());
    }
  }
  return done.size();
}

void ReverbPool::waitBuilds() {
  for (;;) {
    {
      std::lock_guard<std::mutex> lk(mu_);
      if (jobs_.empty() && running_ == 0 && mailbox_.empty()) break;
    }
    if (pump() == 0) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  pump();
}

void ReverbPool::unitAsync(double size, double damp, double quiet, std::function<bool()> need, Done cb) {
  const std::string key = irKeyFor(size, damp);
  if (KernelPtr k = cached(key)) {
    cb(k);
    return;
  }
  if (!need) need = [] { return true; };
  auto it = inflight_.find(key);
  if (it != inflight_.end()) {
    Inflight &r = it->second;
    if (!(quiet > 0)) {
      r.hurried = true;  // prepare / a live edit needs it now: stop waiting for a pause
    } else if (r.gated) {
      // a deferred switch joins a speculative warm-up of the same space: the shortest wait of its callers applies
      r.needs.push_back({quiet, std::move(need)});
      armQuiet(0);
    }
    r.then.push_back(std::move(cb));
    tryFinish(key);
    return;
  }
  Inflight e;
  e.gated = quiet > 0 && gateActive();
  e.needs.push_back({quiet, std::move(need)});
  e.then.push_back(std::move(cb));
  e.seq = ++inflightSeq_;
  inflight_[key] = std::move(e);
  if (offline_) {
    KernelPtr k = buildKernel(key, sr_, size, damp);
    ++builds_;
    inflight_[key].kernel = std::move(k);
    tryFinish(key);
  } else if (auto pb = prebuilt_.find(key); pb != prebuilt_.end()) {
    inflight_[key].kernel = pb->second;
    prebuilt_.erase(pb);
    tryFinish(key);
  } else {
    startJob(key, size, damp);
  }
}

void ReverbPool::tryFinish(const std::string &key) {
  auto it = inflight_.find(key);
  if (it == inflight_.end()) return;
  Inflight &e = it->second;
  if (!e.kernel) return;
  if (e.gated && !e.hurried && !e.claimed) {
    if (!e.queued) {
      e.queued = true;  // the IR is ready: now wait for the pause (_whenQuiet)
      armQuiet(0);
    }
    return;
  }
  Inflight done = std::move(e);
  inflight_.erase(it);
  if (done.claimed && !done.hurried) ++quietBuilds_;
  KernelPtr k;
  if (auto p = pool_.find(key); p != pool_.end()) {
    k = p->second.first;
  } else {
    k = done.kernel;
    newUnit(key, k);
  }
  for (Done &cb : done.then) cb(k);
}

void ReverbPool::finishNull(const std::string &key) {
  auto it = inflight_.find(key);
  if (it == inflight_.end()) return;
  Inflight done = std::move(it->second);
  inflight_.erase(it);
  if (done.kernel) prebuilt_[key] = done.kernel;  // the IR stays computed (JS irCache)
  while (prebuilt_.size() > 2) prebuilt_.erase(prebuilt_.begin());
  for (Done &cb : done.then) cb(nullptr);
}

// ---- quiet gate (v11-reverb-quiet) --------------------------------------------------------------------------------

double ReverbPool::quietNow() const {
  const double q = quietFor_ ? quietFor_() : kInf;
  return std::min(std::isnan(q) ? 0.0 : q, now() - builtAt_);
}

double ReverbPool::waitSec(const Inflight &e) const {
  double q = kInf;
  for (const Need &n : e.needs)
    if (n.q < q && n.f()) q = n.q;
  return q == kInf ? 0 : q;
}

void ReverbPool::armQuiet(double delay) {
  bool any = false;
  for (const auto &e : inflight_) any = any || (e.second.queued && !e.second.claimed);
  if (!any) return;
  const double when = now() + std::max(0.0, delay);
  if (quietArmed_ && quietAt_ <= when + 1e-3) return;
  const std::uint64_t gen = ++quietGen_;
  quietArmed_ = true;
  quietAt_ = when;
  at(when, [this, gen](double) {
    if (gen != quietGen_) return;  // re-armed sooner
    quietArmed_ = false;
    quietAt_ = 1e300;
    quietTick();
  });
}

void ReverbPool::quietTick() {
  std::vector<std::pair<std::uint64_t, std::string>> q;  // waiting entries in arrival order
  for (const auto &e : inflight_)
    if (e.second.queued && !e.second.claimed) q.emplace_back(e.second.seq, e.first);
  std::sort(q.begin(), q.end());
  std::vector<std::pair<std::string, double>> waiting;
  for (const auto &p : q) {
    const double sec = waitSec(inflight_.at(p.second));
    if (sec > 0)
      waiting.emplace_back(p.second, sec);
    else
      finishNull(p.second);  // nobody needs it any more
  }
  const double quiet = quietNow();
  int best = -1;
  for (std::size_t i = 0; i < waiting.size(); ++i) {
    if (quiet < waiting[i].second) continue;
    if (best < 0 || waiting[i].second < waiting[best].second) best = static_cast<int>(i);  // first come on ties
  }
  if (best >= 0) {
    const std::string key = waiting[best].first;
    waiting.erase(waiting.begin() + best);
    builtAt_ = now();  // claimed: a second build waits for a whole window again
    inflight_.at(key).claimed = true;
    tryFinish(key);
  }
  if (waiting.empty()) return;
  double mn = kInf;
  for (const auto &w : waiting) mn = std::min(mn, w.second);
  armQuiet(std::max(kReverbQuietPoll, mn - (best >= 0 ? 0 : quiet)));
}

// ---- which IR plays -----------------------------------------------------------------------------------------------

Unit *ReverbPool::buildUnit(const UnitEnv &env, const UnitSpec &spec) {
  sr_ = env.sampleRate;
  seed_ = env.seed;
  const ReverbPatch rp = spec.patch ? spec.patch->reverb : ReverbPatch{};
  size_ = rp.size;
  damp_ = rp.damp;
  predelayV_ = clampPd(rp.predelay);
  for (SlotMirror &s : slots_) {
    s = SlotMirror{};
    s.gen = ++tick_;
  }
  active_ = -1;
  target_.clear();
  unitBuilt_ = true;
  auto *u = new ReverbUnit(sr_, rp.returnGain);
  const std::string key = irKeyFor(size_, damp_);
  auto activate0 = [this, key](double p) {
    SlotMirror &m = slots_[0];
    m.key = key;
    m.st = SlotState::Active;
    m.connected = true;
    m.cur = 0;
    m.pdV[0] = m.pdV[1] = p;
    m.lastUse = ++tick_;
    active_ = 0;
  };
  if (offline_ || pool_.count(key)) {  // Reverb.init: offline builds synchronously
    auto *cu = new ConvUnit(unitSync(size_, damp_), sr_);
    cu->slot = 0;
    cu->predelay = predelayV_;
    u->installInitial(cu);
    activate0(predelayV_);
  } else {
    building_ = u;  // a build that completes inside this call (inline builds) installs directly
    unitAsync(size_, damp_, 0, nullptr, [this, activate0](KernelPtr k) {
      if (!k || active_ >= 0) return;  // a commit already activated something
      auto *cu = new ConvUnit(k, sr_);
      cu->slot = 0;
      cu->when = now();
      cu->predelay = predelayV_;
      if (building_)
        building_->installInitial(cu);
      else
        m_.sendOwned(UnitSlot::Reverb, opOf(ReverbOp::AttachKernel), cu, -1.0);
      activate0(predelayV_);
    });
    building_ = nullptr;
  }
  return u;
}

ReverbPool::Stage ReverbPool::stage(double size, double damp, bool defer) {
  const std::string key = irKeyFor(size, damp);
  keep_ = {key};
  if (!(active_ >= 0 && slots_[active_].key == key)) {
    if (offline_) {
      unitSync(size, damp);
    } else if (defer && !pool_.count(key)) {
      if (!inflight_.count(key) && !prebuilt_.count(key)) startJob(key, size, damp);  // the IR only (irAsync)
      return Stage{key, size, damp, true};
    } else {
      unitAsync(size, damp, 0, nullptr, [](KernelPtr) {});
    }
  }
  return Stage{key, size, damp, false};
}

void ReverbPool::commitTo(const Stage *st, double predelay, double when) {
  predelayV_ = clampPd(predelay);
  if (st) {
    target_ = st->key;
    ++reqSeq_;  // a live request still in its debounce belongs to the previous song
    songKeys_ = {st->key};
  }
  if (!st || (active_ >= 0 && st->key == slots_[active_].key)) {
    if (st) {
      size_ = st->size;
      damp_ = st->damp;
    }
    pdTo(active_, predelayV_, when);
    return;
  }
  auto it = pool_.find(st->key);  // units.get(): no LRU touch
  if (it == pool_.end()) {
    // deferred stage, or evicted between prepare and commit: the async path swaps when it is ready
    if (st->deferred) ++deferredBuilds_;
    request(st->size, st->damp, when - kReverbDebounce, st->deferred);
    return;
  }
  swapUnit(st->key, it->second.first, *st, when, ++reqSeq_);
}

int ReverbPool::slotOf(const std::string &key) const {
  for (unsigned s = 0; s < kReverbSlots; ++s)
    if (slots_[s].st != SlotState::Empty && slots_[s].key == key) return static_cast<int>(s);
  return -1;
}

int ReverbPool::pickSlot() const {
  int best = -1;
  for (unsigned s = 0; s < kReverbSlots; ++s)
    if (slots_[s].st == SlotState::Empty) return static_cast<int>(s);
  for (unsigned s = 0; s < kReverbSlots; ++s)  // the idle unit used longest ago
    if (slots_[s].st == SlotState::Idle && (best < 0 || slots_[s].lastUse < slots_[best].lastUse))
      best = static_cast<int>(s);
  if (best >= 0) return best;
  for (unsigned s = 0; s < kReverbSlots; ++s)  // every slot busy: the fade that started first is cut short
    if (static_cast<int>(s) != active_ && (best < 0 || slots_[s].idleAt < slots_[best].idleAt))
      best = static_cast<int>(s);
  return best;
}

void ReverbPool::swapUnit(const std::string &key, KernelPtr k, const Stage &st, double when, std::uint32_t seq,
                          double fade) {
  if (active_ >= 0 && slots_[active_].key == key) {
    pdTo(active_, predelayV_, when);
    return;
  }
  int s = slotOf(key);
  if (s >= 0 && slots_[s].st == SlotState::Fading && slots_[s].idleAt > when) {
    // the unit we want is still fading out from a previous switch: swap as soon as it is idle
    at(slots_[s].idleAt + 0.001, [this, key, k, st, seq, fade](double tt) {
      if (seq == reqSeq_) swapUnit(key, k, st, tt, seq, fade);
    });
    return;
  }
  const int out = active_;
  if (s >= 0 && slots_[s].st == SlotState::Idle) {
    Command c{};
    c.op = opOf(ReverbOp::Reactivate);
    c.aux = static_cast<std::uint32_t>(s);
    c.f.a = when;
    c.f.b = fade;
    c.f.c = predelayV_;
    c.f.d = out;
    m_.sendUnitOp(UnitSlot::Reverb, c, -1.0);
  } else {
    s = pickSlot();
    auto *cu = new ConvUnit(std::move(k), sr_);
    cu->slot = static_cast<unsigned>(s);
    cu->when = when;
    cu->fade = fade;
    cu->predelay = predelayV_;
    cu->fadeOutSlot = out;
    m_.sendOwned(UnitSlot::Reverb, opOf(ReverbOp::AttachKernel), cu, -1.0);
    slots_[s].gen = ++tick_;
  }
  SlotMirror &u = slots_[s];
  u.key = key;
  u.st = SlotState::Active;
  u.connected = true;
  u.cur = 0;
  u.pdV[0] = u.pdV[1] = predelayV_;
  u.pdBusyUntil = 0;
  u.pdPendingSet = false;
  u.lastUse = ++tick_;
  if (out >= 0 && out != s) {
    SlotMirror &o = slots_[out];
    o.st = SlotState::Fading;
    o.idleAt = when + fade + kIdleAfterFade;
    const std::uint64_t gen = o.gen;
    at(o.idleAt, [this, out, gen](double) {
      SlotMirror &m = slots_[out];
      if (m.gen == gen && out != active_ && m.st == SlotState::Fading) {
        m.st = SlotState::Idle;  // the unit disconnected its input itself at this quantum
        m.connected = false;
        evict();
      }
    });
  }
  active_ = s;
  songKeys_.insert(key);  // a macro.wash bucket the song reached stays built while it plays
  cached(key);
  size_ = st.size;
  damp_ = st.damp;
}

void ReverbPool::sendSetPredelay(int slot, double p, double when, bool immediate) {
  Command c{};
  c.op = opOf(ReverbOp::SetPredelay);
  c.aux = static_cast<std::uint32_t>(slot);
  c.f.a = p;
  c.f.b = when;
  c.f.c = immediate ? 1 : 0;
  m_.sendUnitOp(UnitSlot::Reverb, c, -1.0);
}

void ReverbPool::pdTo(int slot, double p, double when) {
  if (slot < 0) return;
  SlotMirror &u = slots_[slot];
  if (!u.connected) {  // _setUnitPd on a silent unit
    sendSetPredelay(slot, p, when, true);
    u.cur = 0;
    u.pdV[0] = u.pdV[1] = p;
    u.pdBusyUntil = 0;
    u.pdPendingSet = false;
    return;
  }
  if (std::fabs(u.pdV[u.cur] - p) < 1e-6 && !(u.pdBusyUntil > when)) return;
  if (u.pdBusyUntil > when) {
    // a predelay crossfade is still running: apply the latest value once it has finished
    const bool first = !u.pdPendingSet;
    u.pdPending = p;
    u.pdPendingSet = true;
    if (first) {
      const std::uint64_t gen = u.gen;
      at(u.pdBusyUntil, [this, slot, gen](double tt) {
        SlotMirror &m = slots_[slot];
        if (m.gen != gen || !m.pdPendingSet) return;
        const double q = m.pdPending;
        m.pdPendingSet = false;
        if (slot == active_) pdTo(slot, q, tt);
      });
    }
    return;
  }
  if (std::fabs(u.pdV[u.cur] - p) < 1e-6) return;
  const unsigned nx = 1 - u.cur;
  sendSetPredelay(slot, p, when, false);
  u.pdV[nx] = p;
  u.cur = nx;
  u.pdBusyUntil = when + kPredelayFade + 0.005;
}

void ReverbPool::request(double size, double damp, double when, bool quiet) {
  const std::uint32_t seq = ++reqSeq_;
  target_ = irKeyFor(size, damp);
  at(when + kReverbDebounce, [this, size, damp, seq, quiet](double tt) {
    if (seq != reqSeq_) return;
    const std::string key = irKeyFor(size, damp);
    if (active_ >= 0 && slots_[active_].key == key) {
      size_ = size;
      damp_ = damp;
      return;
    }
    const Stage st{key, size, damp, false};
    if (offline_ || pool_.count(key)) {
      swapUnit(key, unitSync(size, damp), st, tt, seq);
      return;
    }
    if (!quiet) songKeys_.insert(key);  // a live bucket stays built for the song even if the wheel moves on
    std::function<bool()> need;
    if (quiet) need = [this, seq] { return seq == reqSeq_; };
    unitAsync(size, damp, quiet ? kReverbQuietSec : 0, need, [this, key, st, seq](KernelPtr k) {
      if (k && seq == reqSeq_) swapUnit(key, k, st, now(), seq);
    });
  });
}

void ReverbPool::setPredelay(double seconds, double when) {
  predelayV_ = clampPd(seconds);
  pdTo(active_, predelayV_, t(when));
}

void ReverbPool::ensureBuilt(double size, double damp) {
  if (offline_)
    unitSync(size, damp);
  else
    unitAsync(size, damp, 0, nullptr, [](KernelPtr) {});
}

void ReverbPool::warm(double size, double damp) {
  if (offline_) return;
  const std::string key = irKeyFor(size, damp);
  auto wanted = [this, key] { return !retain_ || retain_->count(key) || songKeys_.count(key); };
  if (!wanted()) return;
  unitAsync(size, damp, kReverbWarmQuietSec, wanted, [](KernelPtr) {});
}

// ---- engine hooks -------------------------------------------------------------------------------------------------

void ReverbPool::onCommit(const PatchSpec &patch, double when) {
  if (!unitBuilt_) return;  // the unit is built from this patch when it is attached
  const double tt = t(when);
  const Stage st = stage(patch.reverb.size, patch.reverb.damp, false);  // T13: stage in prepare (defer while held)
  commitTo(&st, patch.reverb.predelay, tt);
  m_.moveParam(UnitSlot::Reverb, kReverbReturnGain, patch.reverb.returnGain, when, 0.0);  // rampTo(ret.gain, …)
}

void ReverbPool::onRateChanged(double sampleRate) {
  if (sampleRate == sr_) return;
  sr_ = sampleRate;
  // a new context in JS: every space is rebuilt at the new rate; the playing one is replaced at once
  for (const std::string &k : keys())
    if (!busy(k)) dropKernel(k);
  prebuilt_.clear();
  if (!unitBuilt_) return;
  const double size = size_, damp = damp_;
  const Stage st{irKeyFor(size, damp), size, damp, false};
  keep_ = {st.key};
  const std::uint32_t seq = ++reqSeq_;
  target_ = st.key;
  if (offline_) {
    swapUnit(st.key, unitSync(size, damp), st, now(), seq, 0.0);
    return;
  }
  unitAsync(size, damp, 0, nullptr, [this, st, seq](KernelPtr k) {
    if (k && seq == reqSeq_) swapUnit(st.key, k, st, now(), seq, 0.0);
  });
}

void ReverbPool::onMemoryPressure(int level) {
  if (level < 1) return;
  // _trimReverbUnits: drop every unit nothing uses (not active, not fading, not staged)
  for (const std::string &k : keys())
    if (!busy(k)) dropKernel(k);
  prebuilt_.clear();
}

std::string ReverbPool::statsFields() {
  return "\"reverbUnits\":" + std::to_string(pool_.size()) + ",\"reverbQuietWaiting\":" +
         std::to_string(quietWaiting());
}

}  // namespace rig::fx
