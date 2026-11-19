#include "graph/graph.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "graph/test_points.h"
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
  for (Unit *u : units_) delete u;
  delete inject_;
}

std::uint32_t Graph::liveVoices() const {
  std::uint32_t n = 0;
  for (std::size_t i = 0; i < kChannels; ++i)
    if (units_[i]) n += units_[i]->liveVoices();
  for (std::size_t i = 0; i < kRetiring; ++i)
    if (Unit *u = units_[idx(retireInstSlot(i))]) n += u->liveVoices();
  return n;
}

bool Graph::push(const AudioEvent &e) {
  if (out_.push(e)) return true;
  ++lostEvents_;
  stats_.eventsDropped.fetch_add(1, std::memory_order_relaxed);
  return false;
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
      if (c.target == kAllSlots) {
        for (std::size_t i = 0; i < kChannels; ++i)
          if (units_[i]) units_[i]->apply(c);
        if (c.op != Op::NoteOn)  // retiring channels never get new notes
          for (std::size_t i = 0; i < kRetiring; ++i)
            if (Unit *u = units_[idx(retireInstSlot(i))]) u->apply(c);
      } else if (c.target < kUnitSlots && units_[c.target]) {
        units_[c.target]->apply(c);
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
      else if (isModuleOp(c.op) && c.sub == kSubOwnedPayload) garbage(GarbageKind::Owned, c.p.ptr);  // no unit: give it back
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
  const double want = requestedSr_.load(std::memory_order_acquire);
  if (want >= 8000.0 && want != sr_) adoptRate(want);
  drainCommands();
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
  for (std::size_t i = 0; i < kChannels; ++i) {
    const bool tapHere = (i == 0 && tapIs("slot0.pan")) || (i == 1 && tapIs("slot1.pan"));
    renderChannel(instSlot(i), stripSlot(i), i == 0, base, tapHere ? &tapBus_ : nullptr);
    tapped = tapped || tapHere;
  }
  for (std::size_t i = 0; i < kRetiring; ++i) renderChannel(retireInstSlot(i), retireStripSlot(i), false, base, nullptr);
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
  // 6. click
  bool clickOn = false;
  if (units_[idx(UnitSlot::Click)]) {
    UnitIO io;
    io.out = &clickBus_;
    runUnit(UnitSlot::Click, base, io);
    clickOn = true;
    if (!clickAux_) outBus_.add(clickBus_);
  }
  // 7. sinks: meter sees `out`, recorder sees `out` (+ aux click when recorded)
  if (units_[idx(UnitSlot::Meter)]) {
    UnitIO io;
    io.in = &outBus_;
    runUnit(UnitSlot::Meter, base, io);
  }
  if (units_[idx(UnitSlot::Recorder)]) {
    UnitIO io;
    io.in = &outBus_;
    if (clickOn && clickAux_ && clickRecord_) {
      fxBus_ = outBus_;
      fxBus_.add(clickBus_);
      io.in = &fxBus_;
    }
    runUnit(UnitSlot::Recorder, base, io);
  }

  if (tap_ != 0 && !tapped) tapBus_.clear(2);  // tap point not served this quantum: silence
  const Bus &src = tap_ == 0 ? outBus_ : tapBus_;
  float pk[2] = {0, 0};
  for (unsigned c = 0; c < channels; ++c) {
    if (c < 2) {
      const float *s = src.ch[src.channels == 1 ? 0 : c];
      std::memcpy(out[c], s, kQ * sizeof(float));
      for (std::size_t i = 0; i < kQ; ++i) pk[c] = std::max(pk[c], std::fabs(s[i]));
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
