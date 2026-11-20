#include "graph/graph.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "graph/test_points.h"
#include "inst/instrument.h"
#include "inst/voice_alloc.h"
#include "runtime/rt_guard.h"
#include "time/param.h"

namespace rig {
namespace {

// Min-heap order: earlier frame first, then submission order.
bool later(const Command &a, const Command &b) {
  return a.frame != b.frame ? a.frame > b.frame : a.seq > b.seq;
}

std::size_t idx(UnitSlot s) {
  return static_cast<std::size_t>(s);
}

}  // namespace

Graph::Graph(double sr, CommandQueue &in, EventQueue &out, Seqlock<rig_meters> &meters)
    : sr_(sr), requestedSr_(sr), in_(in), out_(out), meters_(meters) {
  TimeBase tb;
  tb.sampleRate = sr_;
  timeBase_.write(tb);
}

void freeCommandPayload(const Command &c) {
  switch (c.op) {
    case Op::AttachSlot:
      delete static_cast<SlotSpec *>(c.p.ptr);
      break;
    case Op::TestInject:
      delete static_cast<InjectBuffer *>(c.p.ptr);
      break;
    case Op::AttachUnit:
      delete static_cast<Unit *>(c.p.ptr);
      break;
    default:
      if (isModuleOp(c.op) && c.sub == kSubOwnedPayload) delete static_cast<Owned *>(c.p.ptr);
      break;
  }
}

void freeGarbage(const AudioEvent &e) {
  if (e.kind != EventKind::Garbage) return;
  switch (static_cast<GarbageKind>(e.aux)) {
    case GarbageKind::SlotSpec:
      delete static_cast<SlotSpec *>(e.ptr);
      break;
    case GarbageKind::InjectBuffer:
      delete static_cast<InjectBuffer *>(e.ptr);
      break;
    case GarbageKind::Unit:
      delete static_cast<Unit *>(e.ptr);
      break;
    case GarbageKind::Owned:
      delete static_cast<Owned *>(e.ptr);
      break;
  }
}

Graph::~Graph() {
  for (std::size_t i = 0; i < heapN_; ++i) freeCommandPayload(heap_[i]);
  for (std::size_t i = 0; i < stashN_; ++i) freeGarbage(stash_[i]);  // INTERFACE-CHANGE(T08)
  AudioEvent g;
  while (garbage_.pop(g)) freeGarbage(g);  // INTERFACE-CHANGE(T08): the owner normally drained it already
  for (Unit *u : units_) delete u;
  delete inject_;
}

std::uint32_t Graph::liveVoices() const {
  std::uint32_t n = 0;
  for (std::size_t i = 0; i < kChannels; ++i)
    if (Unit *u = units_[idx(instSlot(i))]) n += u->liveVoices();
  for (std::size_t i = 0; i < kRetiring; ++i)
    if (Unit *u = units_[idx(retireInstSlot(i))]) n += u->liveVoices();
  return n;
}

// INTERFACE-CHANGE(D4): engine-wide voice limit, after a note-on reached `played` (its per-slot cap already applied
// inside noteOn, so the per-slot steal comes first and a note the instrument ignored never steals). While the voices
// counted over every instrument (slots and retiring channels) exceed the limit: the globally earliest-released voice
// (each instrument's own release policy, as its per-slot steal), else the globally oldest playing one, any slot,
// faded with the instrument's 20 ms steal fade. Ties keep slot order but never prefer the instrument just played
// (its newest voice is the note-on itself). Bounded: 48 virtual calls to count, at most kMaxLimitStealsPerNote steals
// of one scan each (48 instruments x 160 pool slots); no allocation, no locks.
void Graph::limitVoices(Unit *played, std::int64_t frame) {
  Instrument *const target = played ? played->asInstrument() : nullptr;
  if (voiceLimit_ == 0 || !target) return;
  Instrument *insts[kChannels + kRetiring];
  unsigned n = 0, total = 0;
  const auto collect = [&](UnitSlot s) {
    if (Unit *u = units_[idx(s)])
      if (Instrument *i = u->asInstrument()) {
        insts[n++] = i;
        total += i->playingVoices();
      }
  };
  for (std::size_t i = 0; i < kChannels; ++i) collect(instSlot(i));
  for (std::size_t i = 0; i < kRetiring; ++i) collect(retireInstSlot(i));
  for (unsigned k = 0; total > voiceLimit_ && k < inst::kMaxLimitStealsPerNote; ++k) {
    Instrument *victim = nullptr;
    VoiceId vid = 0;
    double best = 0;
    for (int pass = 0; pass < 2 && !victim; ++pass) {  // released first, then held
      for (unsigned i = 0; i < n; ++i) {
        double at = 0;
        VoiceId id = 0;
        if (!insts[i]->oldestVoice(pass == 0, frame, at, id)) continue;
        if (!victim || at < best || (at == best && victim == target)) {
          victim = insts[i];
          vid = id;
          best = at;
        }
      }
    }
    if (!victim) break;
    const unsigned before = victim->playingVoices();
    victim->releaseVoice(vid, frame, inst::kStealFade);
    if (victim->playingVoices() >= before) break;  // the instrument kept it: never spin
    total -= before - victim->playingVoices();
    stats_.limitSteals.fetch_add(1, std::memory_order_relaxed);
  }
}

bool Graph::push(const AudioEvent &e) {
  if (e.kind == EventKind::Garbage) {  // INTERFACE-CHANGE(T08): own ring + stash, never the shared event ring
    if (stashN_ == 0 && garbage_.push(e)) return true;
    if (stashN_ < kGarbageStash) {
      stash_[stashN_++] = e;
      stats_.garbageParked.fetch_add(1, std::memory_order_relaxed);
      return true;
    }
    stats_.garbageLost.fetch_add(1, std::memory_order_relaxed);
    return false;
  }
  if (out_.push(e)) return true;
  if (e.kind == EventKind::VoiceEnded && e.f.a >= 0.0 && e.f.a < static_cast<double>(kUnitSlots)) {  // ended bits
    const auto s = static_cast<unsigned>(e.f.a);  // T00c: kEndedWords words cover every unit slot
    endedLost_[s / 64].fetch_or(std::uint64_t{1} << (s % 64), std::memory_order_acq_rel);
  }
  ++lostEvents_;
  stats_.eventsDropped.fetch_add(1, std::memory_order_relaxed);
  return false;
}

// INTERFACE-CHANGE(T08): retry parked garbage in order before anything new goes to the ring.
void Graph::flushGarbageStash() {
  std::size_t i = 0;
  while (i < stashN_ && garbage_.push(stash_[i])) ++i;
  if (i == 0) return;
  for (std::size_t k = i; k < stashN_; ++k) stash_[k - i] = stash_[k];
  stashN_ -= i;
}

// INTERFACE-CHANGE(T08): per-slot level of the post-pan strip output, mono down-mix 0.5 (L + R).
// INTERFACE-CHANGE(T00c) D3 / T08 #1: the slot's strip and every retiring strip of that origin slot are summed
// sample-wise into one accumulator (JS: the outgoing strip stays connected to the slot's analyser until disposed);
// with no retiring strip the numbers are exactly the T08 ones (same order of operations).
void Graph::slotAccumulate(std::size_t slot, const Bus &strip) {
  float *acc = slotAcc_[slot];
  const bool st = strip.channels == 2;
  if (!slotHas_[slot]) {
    for (std::size_t i = 0; i < kQ; ++i) acc[i] = st ? 0.5f * (strip.ch[0][i] + strip.ch[1][i]) : strip.ch[0][i];
    slotHas_[slot] = true;
    return;
  }
  for (std::size_t i = 0; i < kQ; ++i) acc[i] += st ? 0.5f * (strip.ch[0][i] + strip.ch[1][i]) : strip.ch[0][i];
}

void Graph::slotMeters() {
  for (std::size_t slot = 0; slot < kChannels; ++slot) {
    float pk = 0.0f;
    double sq = 0.0;
    if (slotHas_[slot]) {
      const float *acc = slotAcc_[slot];
      for (std::size_t i = 0; i < kQ; ++i) {
        pk = std::max(pk, std::fabs(acc[i]));
        sq += static_cast<double>(acc[i]) * static_cast<double>(acc[i]);
      }
    }
    slotPeakQ_[slot][0] = slotPeakQ_[slot][1];
    slotSqQ_[slot][0] = slotSqQ_[slot][1];
    slotPeakQ_[slot][1] = pk;
    slotSqQ_[slot][1] = sq;
  }
}

void Graph::garbage(GarbageKind k, void *p) {
  if (!p) return;
  AudioEvent e{};
  e.frame = frame_;
  e.kind = EventKind::Garbage;
  e.aux = static_cast<std::uint32_t>(k);
  e.ptr = p;
  push(e);  // a full ring leaks the object (counted in eventsDropped); never frees here
}

void Graph::drainCommands() {
  Command c;
  while (in_.pop(c)) {
    if (c.frame == kFrameNow) c.frame = frame_;
    if (heapN_ == kHeap) {
      stats_.heapDropped.fetch_add(1, std::memory_order_relaxed);
      if (c.op == Op::AttachUnit) garbage(GarbageKind::Unit, c.p.ptr);
      else if (c.op == Op::AttachSlot) garbage(GarbageKind::SlotSpec, c.p.ptr);
      else if (c.op == Op::TestInject) garbage(GarbageKind::InjectBuffer, c.p.ptr);
      else if (isModuleOp(c.op) && c.sub == kSubOwnedPayload) garbage(GarbageKind::Owned, c.p.ptr);
      continue;
    }
    heap_[heapN_++] = c;
    std::push_heap(heap_, heap_ + heapN_, later);
  }
}

void Graph::applyParam(const Command &c) {
  const std::size_t s = static_cast<std::size_t>(paramUnit(c.target));
  Unit *u = s < kUnitSlots ? units_[s] : nullptr;
  wa::Param *p = u ? u->param(paramIndex(c.target)) : nullptr;
  if (!p) return;
  const std::uint32_t before = p->dropped();
  switch (c.op) {
    case Op::ParamSet:
      p->setValueAtTime(c.f.a, c.f.b);
      break;
    case Op::ParamLinear:
      p->linearRampToValueAtTime(c.f.a, c.f.b);
      break;
    case Op::ParamExp:
      p->exponentialRampToValueAtTime(c.f.a, c.f.b);
      break;
    case Op::ParamTarget:
      p->setTargetAtTime(c.f.a, c.f.b, c.f.c);
      break;
    default:
      p->cancelAndHoldAtTime(c.f.b);
      break;
  }
  stats_.paramDropped.fetch_add(p->dropped() - before, std::memory_order_relaxed);
}

void Graph::apply(const Command &c) {
  switch (c.op) {
    case Op::ParamSet:
    case Op::ParamLinear:
    case Op::ParamExp:
    case Op::ParamTarget:
    case Op::ParamCancelHold:
      applyParam(c);
      return;
    case Op::AttachUnit:
    case Op::DetachUnit: {
      Unit *nu = c.op == Op::AttachUnit ? static_cast<Unit *>(c.p.ptr) : nullptr;
      if (c.target >= kUnitSlots) {
        garbage(GarbageKind::Unit, nu);
        return;
      }
      Unit *old = units_[c.target];
      units_[c.target] = nu;
      if (nu) nu->setSampleRate(sr_);
      garbage(GarbageKind::Unit, old);
      const UnitSlot t = static_cast<UnitSlot>(c.target);  // INTERFACE-CHANGE(T00c): retiring strip origin
      if (isRetireStripSlot(t))
        retireOrigin_[c.target - idx(UnitSlot::RetireStrip0)] =
            nu && c.aux >= 1 && c.aux <= kChannels ? static_cast<std::uint8_t>(c.aux) : 0;
      return;
    }
    case Op::MoveUnit: {  // INTERFACE-CHANGE(T00c) D3 / T08 #1
      if (c.target >= kUnitSlots || c.aux >= kUnitSlots || c.target == c.aux) return;
      const UnitSlot to = static_cast<UnitSlot>(c.target), from = static_cast<UnitSlot>(c.aux);
      std::uint8_t origin = 0;
      if (static_cast<std::size_t>(from) >= idx(UnitSlot::Strip0) &&
          static_cast<std::size_t>(from) < idx(UnitSlot::Strip0) + kChannels)
        origin = static_cast<std::uint8_t>(static_cast<std::size_t>(from) - idx(UnitSlot::Strip0) + 1);
      else if (isRetireStripSlot(from))
        origin = retireOrigin_[c.aux - idx(UnitSlot::RetireStrip0)];
      if (isRetireStripSlot(from)) retireOrigin_[c.aux - idx(UnitSlot::RetireStrip0)] = 0;
      Unit *old = units_[c.target];
      units_[c.target] = units_[c.aux];
      units_[c.aux] = nullptr;
      garbage(GarbageKind::Unit, old);
      if (isRetireStripSlot(to))
        retireOrigin_[c.target - idx(UnitSlot::RetireStrip0)] = units_[c.target] ? origin : 0;
      return;
    }
    case Op::AttachSlot:  // legacy T00 op: no longer emitted (builtin strip + test instrument replace it)
      garbage(GarbageKind::SlotSpec, c.p.ptr);
      return;
    case Op::NoteOn:
    case Op::NoteOff:
    case Op::AllNotesOff:
    case Op::Panic:
    case Op::Sustain:
    case Op::Bend:
    case Op::LegatoTo:
    case Op::InstParam:
    case Op::ReleaseVoice:
    case Op::VoiceCap:  // INTERFACE-CHANGE(T00c) D1
      if (c.target == kAllSlots) {
        for (std::size_t i = 0; i < kChannels; ++i)
          if (Unit *u = units_[idx(instSlot(i))]) {
            u->apply(c);
            if (c.op == Op::NoteOn) limitVoices(u, c.frame);  // INTERFACE-CHANGE(D4)
          }
        if (c.op != Op::NoteOn)  // retiring channels never get new notes
          for (std::size_t i = 0; i < kRetiring; ++i)
            if (Unit *u = units_[idx(retireInstSlot(i))]) u->apply(c);
      } else if (c.target < kUnitSlots && units_[c.target]) {
        units_[c.target]->apply(c);
        if (c.op == Op::NoteOn) limitVoices(units_[c.target], c.frame);  // INTERFACE-CHANGE(D4)
      }
      return;
    case Op::TestTap:
      if (c.aux < kTapCount) tap_ = static_cast<int>(c.aux);
      return;
    case Op::TestInject:
      garbage(GarbageKind::InjectBuffer, inject_);
      inject_ = static_cast<InjectBuffer *>(c.p.ptr);
      return;
    case Op::ClickRoute:
      clickAux_ = (c.aux & 1u) != 0;
      clickRecord_ = (c.aux & 2u) != 0;
      return;
    case Op::None:
      return;
    default:
      if (isModuleOp(c.op) && c.target < kUnitSlots && units_[c.target]) units_[c.target]->apply(c);
      else if (isModuleOp(c.op) && c.sub == kSubOwnedPayload)
        garbage(GarbageKind::Owned, c.p.ptr);  // no unit to take it: give it back
      return;
  }
}

void Graph::adoptRate(double sr) {
  const double old = sr_;
  const auto rescale = [&](std::int64_t f) {
    return static_cast<std::int64_t>(std::ceil(static_cast<double>(f) * sr / old - 1e-9));
  };
  const std::int64_t f0 = frame_;
  frame_ = rescale(frame_);
  for (std::size_t i = 0; i < heapN_; ++i)
    heap_[i].frame = heap_[i].frame <= f0 ? frame_ : std::max(frame_, rescale(heap_[i].frame));
  std::make_heap(heap_, heap_ + heapN_, later);
  sr_ = sr;
  for (Unit *u : units_)
    if (u) u->setSampleRate(sr_);
  stats_.rateChanges.fetch_add(1, std::memory_order_relaxed);
  AudioEvent e{};
  e.frame = frame_;
  e.kind = EventKind::RateChanged;
  e.f.a = sr;
  e.f.b = old;
  push(e);
}

bool Graph::injectOverlaps(std::uint32_t point) const {
  if (!inject_ || inject_->point != point) return false;
  const long long q0 = frame_, q1 = frame_ + static_cast<long long>(kQ);
  return inject_->startFrame < q1 && inject_->startFrame + static_cast<long long>(inject_->frames) > q0;
}

void Graph::addInject(std::uint32_t point, Bus &bus) {
  if (!injectOverlaps(point)) return;
  const InjectBuffer &ib = *inject_;
  const long long q0 = frame_;
  const long long a = std::max<long long>(q0, ib.startFrame);
  const long long b =
      std::min<long long>(q0 + static_cast<long long>(kQ), ib.startFrame + static_cast<long long>(ib.frames));
  Bus tmp;
  tmp.clear(ib.channels);
  for (long long f = a; f < b; ++f)
    for (unsigned c = 0; c < ib.channels; ++c) tmp.ch[c][f - q0] = ib.data[c][f - ib.startFrame] * ib.gain;
  bus.add(tmp);
}

void Graph::runUnit(UnitSlot s, const RenderContext &base, UnitIO &io) {
  RenderContext ctx = base;
  ctx.self = s;
  units_[idx(s)]->process(ctx, io);
}

void Graph::renderChannel(UnitSlot inst, UnitSlot strip, bool injectHere, const RenderContext &base, Bus *tapBus) {
  Unit *iu = units_[idx(inst)], *su = units_[idx(strip)];
  if (!iu && !su) {
    if (tapBus) tapBus->clear(2);
    return;
  }
  instBus_.clear(1);
  bool live = false;
  if (iu) {
    live = iu->liveVoices() > 0;
    UnitIO io;
    io.out = &instBus_;
    runUnit(inst, base, io);
  }
  if (injectHere) {
    const std::uint32_t p = static_cast<std::uint32_t>(injectIndex("slot0.strip"));
    if (injectOverlaps(p)) {
      addInject(p, instBus_);
      live = true;
    }
  }
  if (!su) {  // no strip: nothing reaches the sum (a fresh channel is silent until its strip exists)
    if (tapBus) tapBus->clear(2);
    return;
  }
  UnitIO io;
  io.in = live ? &instBus_ : nullptr;
  io.out = &stripBus_;
  for (unsigned k = 0; k < kSendBuses; ++k) io.sends[k] = &sends_[k];
  runUnit(strip, base, io);
  sum_.add(stripBus_);
  if (tapBus) *tapBus = stripBus_;
}

void Graph::renderQuantum(float *const *out, unsigned channels) {
  rt::RenderScope scope;
  if (stashN_) flushGarbageStash();  // INTERFACE-CHANGE(T08)
  const double want = requestedSr_.load(std::memory_order_acquire);
  if (want >= 8000.0 && want != sr_) adoptRate(want);
  drainCommands();
  voiceLimit_ = voiceLimitReq_.load(std::memory_order_relaxed);  // INTERFACE-CHANGE(D4): live from this quantum
  const std::int64_t q0 = frame_, q1 = frame_ + static_cast<std::int64_t>(kQ);
  while (heapN_ > 0 && heap_[0].frame < q1) {
    std::pop_heap(heap_, heap_ + heapN_, later);
    const Command c = heap_[--heapN_];
    apply(c);
  }
  if (lostEvents_) {
    AudioEvent e{};
    e.frame = q0;
    e.kind = EventKind::Dropped;
    e.aux = lostEvents_;
    if (out_.push(e)) lostEvents_ = 0;
  }
  RenderContext base{q0, sr_, epoch_.current(), UnitSlot::Count, this};
  const TestPoint &tp = kTapPoints[tap_];
  const auto tapIs = [&](const char *name) { return std::strcmp(tp.name, name) == 0; };
  bool tapped = false;

  // 1. slot channels (+ retiring) into sum and the send buses
  sum_.clear(2);
  for (auto &s : sends_) s.clear(2);
  for (std::size_t i = 0; i < kChannels; ++i) slotHas_[i] = slotRetiring_[i] = false;
  for (std::size_t i = 0; i < kChannels; ++i) {
    const bool tapHere = (i == 0 && tapIs("slot0.pan")) || (i == 1 && tapIs("slot1.pan"));
    renderChannel(instSlot(i), stripSlot(i), i == 0, base, tapHere ? &tapBus_ : nullptr);
    if (units_[idx(stripSlot(i))]) slotAccumulate(i, stripBus_);  // INTERFACE-CHANGE(T08)
    tapped = tapped || tapHere;
  }
  for (std::size_t i = 0; i < kRetiring; ++i) {
    renderChannel(retireInstSlot(i), retireStripSlot(i), false, base, nullptr);
    const std::uint8_t o = retireOrigin_[i];  // INTERFACE-CHANGE(T00c) T08 #1: the origin slot's meter hears it
    if (o && units_[idx(retireStripSlot(i))]) {
      slotAccumulate(o - 1u, stripBus_);
      slotRetiring_[o - 1u] = true;
    }
  }
  slotMeters();
  // 2. drone
  if (units_[idx(UnitSlot::Drone)]) {
    UnitIO io;
    io.out = &fxBus_;
    io.sends[kSendReverb] = &sends_[kSendReverb];
    runUnit(UnitSlot::Drone, base, io);
    sum_.add(fxBus_);
  }
  // 3. send effects
  static constexpr struct {
    UnitSlot unit;
    unsigned send;
    const char *in, *out;
  } kFx[] = {{UnitSlot::Reverb, kSendReverb, "fx.reverb.input", "fx.reverb.output"},
             {UnitSlot::Delay, kSendDelay, "fx.delay.input", "fx.delay.output"},
             {UnitSlot::Chorus, kSendChorus, "fx.chorus.input", "fx.chorus.output"}};
  for (const auto &fx : kFx) {
    addInject(static_cast<std::uint32_t>(injectIndex(fx.in)), sends_[fx.send]);
    if (!units_[idx(fx.unit)]) {
      if (tapIs(fx.out)) {
        tapBus_.clear(2);
        tapped = true;
      }
      continue;
    }
    UnitIO io;
    io.in = &sends_[fx.send];
    io.out = &fxBus_;
    runUnit(fx.unit, base, io);
    sum_.add(fxBus_);
    if (tapIs(fx.out)) {
      tapBus_ = fxBus_;
      tapped = true;
    }
  }
  // 4. sum -> lofi -> eqIn
  addInject(static_cast<std::uint32_t>(injectIndex("fx.sum")), sum_);
  if (tapIs("fx.sum")) {
    tapBus_ = sum_;
    tapped = true;
  }
  if (units_[idx(UnitSlot::Lofi)]) {
    UnitIO io;
    io.in = &sum_;
    io.out = &eqIn_;
    runUnit(UnitSlot::Lofi, base, io);
  } else {
    eqIn_ = sum_;
  }
  addInject(static_cast<std::uint32_t>(injectIndex("fx.eqIn")), eqIn_);
  if (tapIs("fx.lofi.output")) {
    tapBus_ = eqIn_;
    tapped = true;
  }
  // 5. master chain -> out
  if (units_[idx(UnitSlot::MasterChain)]) {
    UnitIO io;
    io.in = &eqIn_;
    io.out = &outBus_;
    if (tp.unit == UnitSlot::MasterChain && tp.local != kGraphBus) {
      io.tap = &tapBus_;
      io.tapPoint = tp.local;
      tapBus_.clear(2);
      tapped = true;
    }
    if (inject_ && kInjectPoints[inject_->point].unit == UnitSlot::MasterChain &&
        kInjectPoints[inject_->point].local != kGraphBus && injectOverlaps(inject_->point)) {
      fxBus_.clear(2);
      addInject(inject_->point, fxBus_);
      io.inject = &fxBus_;
      io.injectPoint = kInjectPoints[inject_->point].local;
    }
    runUnit(UnitSlot::MasterChain, base, io);
  } else {
    outBus_ = eqIn_;
  }
  // 6. click: rendered here, summed into the destination only after the sinks (T07 review O1, orchestrator). The JS
  // sends 'main' to ctx.destination alone: the analysers sit on fx.out and recordTap hears the click only with
  // setClick({record:true}) (contract 1.5, 3.11), for main and aux alike.
  bool clickOn = false;
  if (units_[idx(UnitSlot::Click)]) {
    UnitIO io;
    io.out = &clickBus_;
    runUnit(UnitSlot::Click, base, io);
    clickOn = true;
  }
  // 7. sinks: the meter sees `out` without the click; the recorder sees `out` + the click when it is recorded
  if (units_[idx(UnitSlot::Meter)]) {
    UnitIO io;
    io.in = &outBus_;
    runUnit(UnitSlot::Meter, base, io);
  }
  if (units_[idx(UnitSlot::Recorder)]) {
    UnitIO io;
    io.in = &outBus_;
    if (clickOn && clickRecord_) {
      fxBus_ = outBus_;
      fxBus_.add(clickBus_);
      io.in = &fxBus_;
    }
    runUnit(UnitSlot::Recorder, base, io);
  }

  if (tap_ != 0 && !tapped) tapBus_.clear(2);  // tap point not served this quantum: silence
  const Bus &src = tap_ == 0 ? outBus_ : tapBus_;
  float pk[2] = {0, 0};  // rig_meters.out_peak: pre-click, like the JS analysers on fx.out
  for (unsigned c = 0; c < channels && c < 2; ++c) {
    const float *s = src.ch[src.channels == 1 ? 0 : c];
    for (std::size_t i = 0; i < kQ; ++i) pk[c] = std::max(pk[c], std::fabs(s[i]));
  }
  if (clickOn && !clickAux_) outBus_.add(clickBus_);  // the destination keeps the click (the `out` tap = goldens)
  for (unsigned c = 0; c < channels; ++c) {
    if (c < 2) {
      const float *s = src.ch[src.channels == 1 ? 0 : c];
      std::memcpy(out[c], s, kQ * sizeof(float));
    } else if (clickOn && clickAux_) {
      std::memcpy(out[c], clickBus_.ch[0], kQ * sizeof(float));  // aux click on device channels 3-4
    } else {
      std::memset(out[c], 0, kQ * sizeof(float));
    }
  }
  frame_ = q1;
  rendered_ += kQ;
  epoch_.advance();
  stats_.quanta.fetch_add(1, std::memory_order_relaxed);
  peakRing_[peakPos_][0] = pk[0];
  peakRing_[peakPos_][1] = pk[1];
  peakPos_ = (peakPos_ + 1) & 63;
  rig_meters m{};
  m.struct_size = sizeof(m);
  m.t = static_cast<double>(frame_) / sr_;
  m.frames = rendered_;
  for (auto &r : peakRing_) {
    m.out_peak[0] = std::max(m.out_peak[0], r[0]);
    m.out_peak[1] = std::max(m.out_peak[1], r[1]);
  }
  for (std::size_t i = 0; i < kChannels; ++i) {  // INTERFACE-CHANGE(T08): 256 frames = this + previous quantum
    const float sp = std::max(slotPeakQ_[i][0], slotPeakQ_[i][1]);
    const float rms = static_cast<float>(std::sqrt((slotSqQ_[i][0] + slotSqQ_[i][1]) / (2.0 * kQ)));
    if (i < 4) {  // API 1.0 layout (rig_engine.h): the first four slots
      m.slot_peak[i] = sp;
      m.slot_rms[i] = rms;
    }
    m.slot_peak_all[i] = sp;  // INTERFACE-CHANGE(T00c) D3
    m.slot_rms_all[i] = rms;
    m.slot_retiring[i] = slotRetiring_[i] ? 1 : 0;
  }
  m.slot_count = slotCount_.load(std::memory_order_relaxed);
  m.voices = liveVoices();
  m.cpu_load = cpu_;
  m.xruns = xruns_;
  meters_.write(m);
  TimeBase tb;
  tb.frame = frame_;
  tb.sampleRate = sr_;
  tb.rendered = rendered_;
  tb.epoch = epoch_.current();
  timeBase_.write(tb);
}

}  // namespace rig
