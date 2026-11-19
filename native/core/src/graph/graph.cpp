#include "graph/graph.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "runtime/rt_guard.h"

namespace rig {
namespace {

constexpr std::size_t Q = RIG_QUANTUM_FRAMES;

// Min-heap order: earlier frame first, then submission order.
bool later(const Command &a, const Command &b) {
  return a.frame != b.frame ? a.frame > b.frame : a.seq > b.seq;
}

}  // namespace

Graph::Graph(double sr, CommandQueue &in, EventQueue &out, Seqlock<rig_meters> &meters)
    : sr_(sr), in_(in), out_(out), meters_(meters) {
  for (auto &s : slots_) s.pan.setValue(0.0);
}

std::uint32_t Graph::liveVoices() const {
  std::uint32_t n = 0;
  for (const auto &s : slots_)
    for (const auto &v : s.voices) n += v.active() ? 1 : 0;
  return n;
}

void Graph::pushEvent(const AudioEvent &e) { out_.push(e); }

void Graph::garbage(GarbageKind k, void *p) {
  if (!p) return;
  AudioEvent e{};
  e.kind = EventKind::Garbage;
  e.aux = static_cast<std::uint32_t>(k);
  e.ptr = p;
  pushEvent(e);  // a full ring leaks the object (control side counts the shortfall); never frees here
}

void Graph::drainCommands() {
  Command c;
  while (in_.pop(c)) {
    if (c.frame == kFrameNow) c.frame = frame_;
    if (heapN_ == kHeap) {
      stats_.heapDropped.fetch_add(1, std::memory_order_relaxed);
      if (c.op == Op::AttachSlot) garbage(GarbageKind::SlotSpec, c.p.ptr);
      continue;
    }
    heap_[heapN_++] = c;
    std::push_heap(heap_, heap_ + heapN_, later);
  }
}

wa::Param *Graph::paramFor(std::uint32_t t) {
  if (t == pid::kMasterVolume) return &master_;
  const std::uint32_t slot = t / pid::kSlotStride, which = t % pid::kSlotStride;
  if (slot >= kSlots) return nullptr;
  return which == pid::kFader ? &slots_[slot].fader : which == pid::kPan ? &slots_[slot].pan : nullptr;
}

void Graph::apply(const Command &c) {
  switch (c.op) {
    case Op::ParamSet:
    case Op::ParamLinear:
    case Op::ParamExp:
    case Op::ParamTarget:
    case Op::ParamCancelHold: {
      wa::Param *p = paramFor(c.target);
      if (!p) return;
      const std::uint32_t before = p->dropped();
      if (c.op == Op::ParamSet) p->setValueAtTime(c.f.a, c.f.b);
      else if (c.op == Op::ParamLinear) p->linearRampToValueAtTime(c.f.a, c.f.b);
      else if (c.op == Op::ParamExp) p->exponentialRampToValueAtTime(c.f.a, c.f.b);
      else if (c.op == Op::ParamTarget) p->setTargetAtTime(c.f.a, c.f.b, c.f.c);
      else p->cancelAndHoldAtTime(c.f.b);
      stats_.paramDropped.fetch_add(p->dropped() - before, std::memory_order_relaxed);
      break;
    }
    case Op::AttachSlot: {
      if (c.target >= kSlots) {
        garbage(GarbageKind::SlotSpec, c.p.ptr);
        break;
      }
      Slot &s = slots_[c.target];
      const SlotSpec *old = s.spec;
      s.spec = static_cast<const SlotSpec *>(c.p.ptr);
      s.eq.configure(s.spec->eq, sr_);
      if (old) garbage(GarbageKind::SlotSpec, const_cast<SlotSpec *>(old));
      break;
    }
    case Op::NoteOn: {
      const int note = static_cast<int>(c.aux & 0xff), vel = static_cast<int>((c.aux >> 8) & 0xff);
      for (std::size_t i = 0; i < kSlots; ++i) {
        Slot &s = slots_[i];
        if (c.target != kAllSlots && c.target != i) continue;
        if (!s.spec || s.spec->inst == InstKind::None || note < s.spec->lowNote || note > s.spec->highNote) continue;
        TestVoice *v = nullptr;
        for (auto &cand : s.voices)
          if (!cand.active()) {
            v = &cand;
            break;
          }
        if (!v) {  // steal round-robin
          v = &s.voices[s.nextVoice++ % kVoices];
          stats_.voicesStolen.fetch_add(1, std::memory_order_relaxed);
        }
        v->start(*s.spec, note, vel, c.frame, sr_);
      }
      break;
    }
    case Op::NoteOff:
    case Op::AllNotesOff:
    case Op::Panic: {
      for (std::size_t i = 0; i < kSlots; ++i) {
        Slot &s = slots_[i];
        if (!s.spec || (c.target != kAllSlots && c.target != i)) continue;
        for (auto &v : s.voices) {
          if (!v.active() || v.released()) continue;
          if (c.op == Op::NoteOff && v.note() != static_cast<int>(c.aux)) continue;
          if (c.op == Op::Panic) v.kill();
          else v.release(*s.spec, c.frame, sr_);
        }
      }
      break;
    }
    case Op::TestTap:
      tap_ = static_cast<Tap>(c.aux);
      break;
    case Op::TestInject: {
      if (inject_) garbage(GarbageKind::InjectBuffer, inject_);
      inject_ = static_cast<InjectBuffer *>(c.p.ptr);
      break;
    }
    case Op::None:
      break;
  }
}

void Graph::renderSlot(std::size_t si, std::int64_t q0, float (*sum)[Q], float (*tapBuf)[Q]) {
  Slot &s = slots_[si];
  float in[2][Q] = {};
  int nch = 1;
  bool any = false;
  if (s.spec) {
    for (std::uint32_t vi = 0; vi < kVoices; ++vi) {
      TestVoice &v = s.voices[vi];
      if (!v.active()) continue;
      any = true;
      if (!v.render(in[0], q0, Q, sr_)) {
        AudioEvent e{};
        e.frame = q0;
        e.kind = EventKind::VoiceEnded;
        e.f.a = static_cast<double>(si);
        e.f.b = static_cast<double>(vi);
        pushEvent(e);
      }
    }
  }
  if (si == 0 && inject_) {  // slot0.strip injection
    const InjectBuffer &ib = *inject_;
    const long long a = std::max<long long>(q0, ib.startFrame);
    const long long b = std::min<long long>(q0 + static_cast<long long>(Q),
                                            ib.startFrame + static_cast<long long>(ib.frames));
    if (a < b) {
      any = true;
      nch = static_cast<int>(ib.channels);
      for (long long f = a; f < b; ++f)
        for (int c = 0; c < nch; ++c)
          in[c][f - q0] += ib.data[c][f - ib.startFrame] * ib.gain;
    }
  }
  const int tailQuanta = static_cast<int>(6.0 * sr_ / Q);  // filter ring-out after the last input (notch Q 10 at 60 Hz)
  if (any) s.tail = s.eq.filters() > 0 ? tailQuanta : 1;
  else if (s.tail > 0) --s.tail;
  else {
    if (tapBuf) std::memset(tapBuf, 0, 2 * Q * sizeof(float));
    return;
  }
  float gain[Q], pan[Q];
  s.fader.processARate(q0, sr_, gain, Q);
  for (int c = 0; c < nch; ++c)
    for (std::size_t i = 0; i < Q; ++i) in[c][i] *= gain[i];
  float *chans[2] = {in[0], in[1]};
  s.eq.process(chans, nch, Q);
  s.pan.processARate(q0, sr_, pan, Q);
  float l[Q], r[Q];
  constexpr double kHalfPi = 1.57079632679489661923;
  if (nch == 1) {
    for (std::size_t i = 0; i < Q; ++i) {
      const double x = (std::clamp<double>(pan[i], -1.0, 1.0) + 1.0) * 0.5;
      l[i] = in[0][i] * static_cast<float>(std::cos(x * kHalfPi));
      r[i] = in[0][i] * static_cast<float>(std::sin(x * kHalfPi));
    }
  } else {
    for (std::size_t i = 0; i < Q; ++i) {
      const double p = std::clamp<double>(pan[i], -1.0, 1.0);
      if (p <= 0.0) {
        const double x = (p + 1.0) * kHalfPi;
        l[i] = in[0][i] + in[1][i] * static_cast<float>(std::cos(x));
        r[i] = in[1][i] * static_cast<float>(std::sin(x));
      } else {
        const double x = p * kHalfPi;
        l[i] = in[0][i] * static_cast<float>(std::cos(x));
        r[i] = in[1][i] + in[0][i] * static_cast<float>(std::sin(x));
      }
    }
  }
  for (std::size_t i = 0; i < Q; ++i) {
    sum[0][i] += l[i];
    sum[1][i] += r[i];
  }
  if (tapBuf) {
    std::memcpy(tapBuf[0], l, sizeof l);
    std::memcpy(tapBuf[1], r, sizeof r);
  }
}

void Graph::renderQuantum(float *const *out, unsigned channels) {
  rt::RenderScope scope;
  drainCommands();
  const std::int64_t q0 = frame_, q1 = frame_ + static_cast<std::int64_t>(Q);
  while (heapN_ > 0 && heap_[0].frame < q1) {
    std::pop_heap(heap_, heap_ + heapN_, later);
    const Command c = heap_[--heapN_];
    apply(c);
  }
  float sum[2][Q] = {};
  float tap[2][Q] = {};
  const std::size_t tapSlot = tap_ == Tap::Out ? kSlots : static_cast<std::size_t>(tap_) - 1;
  for (std::size_t i = 0; i < kSlots; ++i) renderSlot(i, q0, sum, i == tapSlot ? tap : nullptr);
  float mv[Q];
  master_.processARate(q0, sr_, mv, Q);
  for (std::size_t i = 0; i < Q; ++i) {
    sum[0][i] *= mv[i];
    sum[1][i] *= mv[i];
  }
  const float(*src)[Q] = tap_ == Tap::Out ? sum : tap;
  float pk[2] = {0, 0};
  for (unsigned c = 0; c < channels; ++c) {
    if (c < 2) {
      std::memcpy(out[c], src[c], Q * sizeof(float));
      for (std::size_t i = 0; i < Q; ++i) pk[c] = std::max(pk[c], std::fabs(src[c][i]));
    } else {
      std::memset(out[c], 0, Q * sizeof(float));  // aux click outputs: silent until T07
    }
  }
  frame_ = q1;
  stats_.quanta.fetch_add(1, std::memory_order_relaxed);
  peakRing_[peakPos_][0] = pk[0];
  peakRing_[peakPos_][1] = pk[1];
  peakPos_ = (peakPos_ + 1) & 63;
  rig_meters m{};
  m.struct_size = sizeof(m);
  m.t = static_cast<double>(frame_) / sr_;
  m.frames = static_cast<std::uint64_t>(frame_);
  for (auto &r : peakRing_) {
    m.out_peak[0] = std::max(m.out_peak[0], r[0]);
    m.out_peak[1] = std::max(m.out_peak[1], r[1]);
  }
  m.voices = liveVoices();
  m.cpu_load = cpu_;
  m.xruns = xruns_;
  meters_.write(m);
}

}  // namespace rig
