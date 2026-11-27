// T13 graph building: units of fresh slot channels are built at prepare (audio.js prepare: registry.create + new
// Channel) and attached at commit. See model/graph_build.h and model/song.h.
#include "model/graph_build.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

#include "api/registry.h"
#include "inst/organ.h"
#include "inst/sampler.h"
#include "inst/synth.h"
#include "mix/slot_channel.h"
#include "model/model.h"
#include "model/song.h"

namespace rig {

BuiltChannel SongGraph::build(const PatchSpec &patch, int slot, double sampleRate) {
  BuiltChannel b;
  const SlotPatch &sp = patch.slots[slot];
  const std::string kind = "inst." + sp.instType;
  const Registry::UnitEntry *ie = Registry::global().unit(kind);
  const Registry::UnitEntry *se = Registry::global().unit(kKindStrip);
  m_.env_.sampleRate = sampleRate > 0 ? sampleRate : m_.sink_.timeBase().sampleRate;
  UnitSpec spec;
  spec.channel = slot;
  spec.patch = &patch;
  spec.song = &m_.song_;
  if (ie) {
    spec.slot = instSlot(static_cast<std::size_t>(slot));
    spec.instSeq = ++m_.instSeq_;  // audio.js: ++this._instSeq per instrument created (contract 7.15)
    if (Unit *u = ie->factory(m_.env_, spec)) {
      b.inst = new InstShell(u);
      b.kind = kind;
      b.instSeq = spec.instSeq;
    }
  }
  if (!b.inst) {
    // audio.js prepare: registry.create threw -> the slot plays nothing (plan null). An unknown type is warned here;
    // a factory that declines an id (e.g. a synth-extra id without T15) is warned by its service at commit.
    if (!ie)
      m_.warn("instrument type '" + sp.instType + "' is not available in this build (slot stays silent)",
              "unsupported");
    return b;
  }
  if (se) b.strip = buildStrip(patch, slot, m_.env_.sampleRate);
  ++n_.built;
  return b;
}

Unit *SongGraph::buildStrip(const PatchSpec &patch, int slot, double sampleRate) {
  const Registry::UnitEntry *se = Registry::global().unit(kKindStrip);
  if (!se) return nullptr;
  m_.env_.sampleRate = sampleRate;
  UnitSpec spec;
  spec.channel = slot;
  spec.patch = &patch;
  spec.song = &m_.song_;
  spec.slot = stripSlot(static_cast<std::size_t>(slot));
  spec.instSeq = 0;
  return se->factory(m_.env_, spec);
}

void SongGraph::discard(Plan &plan) {
  const double sr = m_.sink_.timeBase().sampleRate;
  for (int i = 0; i < kMaxSlots; ++i) {  // never attached: they die here, on the control thread
    PlanSlot &ps = plan.slots[i];
    if (ps.job) {
      // CORE3: an instrument of a superseded switch (built or still building) is the one a switch back to that song
      // needs: it joins the prebuilt set (LRU, capped) instead of being thrown away. Not at another rate.
      if (worker_ && ps.job->sampleRate == sr && !ps.job->unwanted.load())
        keepPrebuilt(buildKey(plan.patch.slots[i], i, sr), std::move(ps.job));
      else
        ps.job->unwanted.store(true);
      ps.job.reset();
    }
    delete ps.built.inst;
    delete ps.built.strip;
    ps.built = BuiltChannel{};
  }
  plan.onBuilt.clear();  // the bridge answered these prepares when the newer one came (CORE2A)
  ++n_.discarded;
  // (no eviction here: the newer prepare first adopts what it needs, then evicts to the cap)
}

// ---- CORE3: off-thread builds and neighbour prebuilds -------------------------------------------------------------

namespace {
// RSS of one instance with warm wavetable banks (CORE3 measurement, g++ Release, 48 kHz): organ 5.8 MB (8 drawbar
// PeriodicWaves of 576 KB + voices), synth.js 2.1 MB, synth-extra 2.6 MB (16 prefaulted voices of the 160-slot pool).
// Rounded up: what the prebuilt set charges per unit against its cap.
constexpr std::size_t kMiB = 1024 * 1024;
constexpr std::size_t kOrganBytes = 6 * kMiB, kSynthBytes = 2 * kMiB + kMiB * 7 / 10;
// The prebuilt set's cap: one 16-slot song of 4 organs + 12 synths (56 MB) or 2-4 typical neighbours (2-3 heavy
// slots each, 5-18 MB) fit. iPad: half.
constexpr std::size_t kPrebuildCapDesktop = 64 * kMiB, kPrebuildCapIpad = 32 * kMiB;

std::size_t jobBytes(const BuildJob &j) {
  return j.kind == inst::kKindOrgan ? kOrganBytes : kSynthBytes;
}
}  // namespace

bool SongGraph::realtime() const {
  const rig_config *cfg = m_.env_.config;
  return cfg && cfg->mode == RIG_MODE_REALTIME;
}

bool SongGraph::offThreadKind(const SlotPatch &sp) const {
  // the kinds whose factories are pure (read only env + spec.patch->slots[channel]; shared wavetable banks are built
  // under their own mutexes) and costly: synth.js / synth-extra (inst.synth) and organ. Samplers stay inline (their
  // factory talks to the sampler / cache services; it costs < 1 ms, the decodes are already asynchronous: CORE2A).
  if (!realtime() || (sp.instType != "synth" && sp.instType != "organ")) return false;
  return Registry::global().unit("inst." + sp.instType) != nullptr;
}

std::string SongGraph::buildKey(const SlotPatch &sp, int slot, double sampleRate) {
  // everything a synth / organ factory reads: the slot (its rng stream name), the instrument, its params text, the
  // release override, the rate
  char num[64];
  std::snprintf(num, sizeof num, "%d|%.17g|%.17g|", slot, sampleRate,
                std::isfinite(sp.release) && sp.release > 0 ? sp.release : 0.0);
  return std::string(num) + sp.instType + "|" + sp.instId + "|" + sp.paramsJson;
}

BuildWorker &SongGraph::worker() {
  if (!worker_) worker_ = std::make_unique<BuildWorker>(buildWake_);
  return *worker_;
}

void SongGraph::setBuildWake(std::function<void()> fn) {
  buildWake_ = std::move(fn);
  if (worker_) worker_->setWake(buildWake_);
}

std::shared_ptr<BuildJob> SongGraph::makeJob(const SlotPatch &sp, int slot, double sampleRate) {
  auto j = std::make_shared<BuildJob>();
  j->kind = "inst." + sp.instType;
  const Registry::UnitEntry *ie = Registry::global().unit(j->kind);
  j->factory = ie ? ie->factory : nullptr;
  j->env = m_.env_;
  j->env.sampleRate = sampleRate;
  j->patch.slots[slot] = sp;  // the factory reads only its slot: the key above covers everything it sees
  j->patch.slotCount = std::max(slot + 1, 1);
  j->song = m_.song_;
  j->channel = slot;
  j->slot = instSlot(static_cast<std::size_t>(slot));
  j->instSeq = ++m_.instSeq_;  // audio.js: ++this._instSeq per instrument created (contract 7.15)
  j->sampleRate = sampleRate;
  return j;
}

void SongGraph::startFresh(Plan &plan, int slot) {
  PlanSlot &ps = plan.slots[slot];
  const SlotPatch &sp = plan.patch.slots[slot];
  const double sr = m_.sink_.timeBase().sampleRate;
  ps.kind = PlanSlot::Fresh;
  const std::string key = buildKey(sp, slot, sr);
  std::shared_ptr<BuildJob> j = takePrebuilt(key);
  // a prebuilt unit (done), or one still queued (it moves to the switch lane), or one the switch lane is building
  // (a superseded switch's): adopted. One the prebuild lane is building right now is not waited for (a utility-
  // priority thread, starved on a busy box): the switch builds its own in its lane, and that one stays prebuilt.
  if (j && !worker().promote(j)) {
    keepPrebuilt(key, std::move(j));
    ++n_.prebuildBusy;
    j.reset();
  }
  if (j) {
    ++n_.prebuildHits;
    ps.job = std::move(j);
  } else {
    ps.job = makeJob(sp, slot, sr);
    worker().post(ps.job, 0);
  }
  ps.built.kind = ps.job->kind;
  ps.built.instSeq = ps.job->instSeq;
  ps.built.strip = buildStrip(plan.patch, slot, sr);  // < 1 ms (measured 0.1-0.6 ms)
  if (const int d = BuildWorker::testSwitchSlotWaitMs.load(std::memory_order_relaxed); d > 0)
    worker().testWaitPrebuildStart(d);  // tests only (core3f)
}

bool SongGraph::planBuilt() const {
  if (!plan_) return true;
  for (const PlanSlot &ps : plan_->slots)
    if (ps.job && !ps.job->done()) return false;
  return true;
}

void SongGraph::fireBuilt(Plan &plan) {
  std::vector<std::function<void()>> fns;
  fns.swap(plan.onBuilt);
  for (auto &fn : fns) fn();
}

void SongGraph::pumpBuilds() {
  if (plan_ && !plan_->onBuilt.empty() && planBuilt()) fireBuilt(*plan_);
}

void SongGraph::whenBuilt(std::uint32_t token, std::function<void()> fn) {
  if (!plan_ || plan_->token != token || planBuilt()) return fn();
  plan_->onBuilt.push_back(std::move(fn));
}

void SongGraph::takeBuilt(Plan &plan) {
  // commit: every instrument now. First every job the worker has not started is built here (the worker meanwhile
  // goes on with its own: both cores work), then the ones it was building are waited for. (Waiting slot by slot
  // instead let the worker claim each next job while the control thread slept: all 16 built serially.)
  for (PlanSlot &ps : plan.slots)
    if (ps.job && !ps.job->done()) worker().buildHere(*ps.job);
  for (PlanSlot &ps : plan.slots) {
    if (!ps.job) continue;
    if (!ps.job->done()) worker().finish(*ps.job);
    if (ps.job->builtOnControl) ++n_.atCommit;
    else ++n_.offThread;
    if (Unit *u = ps.job->take()) {
      ps.built.inst = new InstShell(u);
      ++n_.built;
    } else {  // the factory declined (warned by its service at commit, as before): the slot plays nothing
      delete ps.built.strip;
      ps.built = BuiltChannel{};
      ps.kind = PlanSlot::None;
    }
    ps.job.reset();
  }
  fireBuilt(plan);  // a raw client that committed before the reply: the prepare reply goes out before the commit's
}

std::shared_ptr<BuildJob> SongGraph::takePrebuilt(const std::string &key) {
  // the most recently used match (a built one first: it costs nothing)
  int best = -1;
  for (int k = 0; k < static_cast<int>(prebuilt_.size()); ++k) {
    const Prebuilt &p = prebuilt_[static_cast<std::size_t>(k)];
    if (p.key != key) continue;
    if (best < 0) {
      best = k;
      continue;
    }
    const Prebuilt &b = prebuilt_[static_cast<std::size_t>(best)];
    if ((p.job->done() && !b.job->done()) || (p.job->done() == b.job->done() && p.used > b.used)) best = k;
  }
  if (best < 0) return nullptr;
  std::shared_ptr<BuildJob> j = std::move(prebuilt_[static_cast<std::size_t>(best)].job);
  prebuilt_.erase(prebuilt_.begin() + best);
  return j;
}

void SongGraph::keepPrebuilt(const std::string &key, std::shared_ptr<BuildJob> job) {
  Prebuilt p;
  p.key = key;
  p.bytes = jobBytes(*job);
  p.job = std::move(job);
  p.used = ++useClock_;
  // a superseded switch's job still queued goes back to prebuild order: the newer switch is built first
  if (worker_ && !p.job->done()) worker_->reprioritize(p.job, 1);
  prebuilt_.push_back(std::move(p));
}

void SongGraph::evictPrebuilt(std::size_t capBytes) {
  std::size_t total = prebuiltBytes();
  while (total > capBytes && !prebuilt_.empty()) {
    auto lru = std::min_element(prebuilt_.begin(), prebuilt_.end(),
                                [](const Prebuilt &a, const Prebuilt &b) { return a.used < b.used; });
    total -= lru->bytes;
    lru->job->unwanted.store(true);  // queued: skipped; built: freed with the last reference (never attached)
    prebuilt_.erase(lru);
    ++n_.prebuildEvicted;
  }
}

std::size_t SongGraph::prebuiltBytes() const {
  std::size_t t = 0;
  for (const Prebuilt &p : prebuilt_) t += p.bytes;
  return t;
}

std::size_t SongGraph::prebuildCapBytes() const {
  const rig_config *cfg = m_.env_.config;
  return cfg && cfg->profile == RIG_PROFILE_IPAD ? kPrebuildCapIpad : kPrebuildCapDesktop;
}

void SongGraph::dropPrebuilt() {
  evictPrebuilt(0);
}

void SongGraph::prebuild(const std::vector<PatchSpec> &patches) {
  if (!realtime()) return;
  const double sr = m_.sink_.timeBase().sampleRate;
  std::vector<std::pair<std::string, int>> want;  // key -> instances this request needs (two songs, same unit)
  for (const PatchSpec &p : patches)
    for (int i = 0; i < kMaxSlots; ++i) {
      const SlotPatch &s = p.slots[i];
      if (!slotUsed(s) || !offThreadKind(s)) continue;
      const Channel &cur = slots_[i];
      if (cur.live && cur.cfg.instType == s.instType && cur.cfg.instId == s.instId &&
          paramsMatch(m_.active_.slots[i], s))
        continue;  // a switch from the song playing now keeps this instance (audio.js:617): nothing to build
      const std::string key = buildKey(s, i, sr);
      auto w = std::find_if(want.begin(), want.end(), [&](const auto &x) { return x.first == key; });
      int need = 1;
      if (w != want.end()) need = ++w->second;
      else want.emplace_back(key, 1);
      int have = 0;
      for (Prebuilt &e : prebuilt_)
        if (e.key == key && ++have <= need) e.used = ++useClock_;  // LRU: this window is the newest
      if (have >= need) continue;
      std::shared_ptr<BuildJob> j = makeJob(s, i, sr);
      worker().post(j, 1);
      keepPrebuilt(key, std::move(j));
      ++n_.prebuildPosted;
    }
  // CORE3 review O1: a `replace` window names the most wanted song first (controller.js pinWindow /
  // windowCandidates: current, next, prev, next2, prev2). Stamped in request order, the cap evicted the Next song's
  // units before prev2's. Re-stamped in reverse, the first-named units are the most recently used.
  for (auto w = want.rbegin(); w != want.rend(); ++w) {
    int k = 0;
    for (Prebuilt &e : prebuilt_)
      if (e.key == w->first && k++ < w->second) e.used = ++useClock_;
  }
  evictPrebuilt(prebuildCapBytes());
}

void SongGraph::instrumentSetup(UnitSlot slot, const std::string &kind, std::int64_t frame) {
  // INTERFACE-CHANGE(T00c) D1: the cap reaches the instrument before any note (same frame, FIFO)
  Command vc{};
  vc.op = Op::VoiceCap;
  vc.target = static_cast<std::uint32_t>(slot);
  vc.frame = frame;
  vc.aux = m_.polyphony_;
  m_.send(vc);
  if (kind == kKindSampler && dynRange_ != 1.0) {  // T12 O1: a new sampler starts at range 1
    Command dc{};
    dc.op = opOf(SamplerOp::DynamicRange);
    dc.target = static_cast<std::uint32_t>(slot);
    dc.frame = frame;
    dc.f.a = dynRange_;
    m_.send(dc);
  }
}

bool SongGraph::attachBuilt(UnitSlot slot, const std::string &kind, Unit *u, double when, int channel) {
  const Registry::UnitEntry *e = Registry::global().unit(kind);
  Command c{};
  c.op = Op::AttachUnit;
  c.target = static_cast<std::uint32_t>(slot);
  c.frame = m_.frameFor(when);
  c.p.ptr = u;
  (void)channel;
  if (!m_.send(c)) {
    delete u;
    return false;
  }
  if (kind.rfind("inst.", 0) == 0) instrumentSetup(slot, kind, c.frame);
  Model::Attached &a = m_.attached_[static_cast<std::size_t>(slot)];
  a.kind = kind;
  a.module = e && e->priority > kBuiltinPriority;
  for (auto it = m_.tracked_.begin(); it != m_.tracked_.end();)  // a new unit starts from its own defaults
    it = paramUnit(it->first) == slot ? m_.tracked_.erase(it) : std::next(it);
  ++m_.stats_.unitsAttached;
  return true;
}

}  // namespace rig
