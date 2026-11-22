// DroneUnit (drone/drone_unit.h): the node graph of app/js/engine/drone.js (constructor, lines 127-200) rendered
// with the Chromium 157.0.8103.78 node semantics of the ports it uses (wa::Gain, wa::BiquadFilter, wa::BufferSource,
// inst::SynthInstrument). T16.
#include "drone/drone_unit.h"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstring>

#include "num/js_math.h"
#include "time/automation.h"

namespace rig::drone {
namespace {

void zero(float *x, std::size_t n) {
  std::memset(x, 0, n * sizeof(float));
}

double u2d(std::uint64_t u) {
  return std::bit_cast<double>(u);
}

}  // namespace

void AudioBuf::seal(double sampleRate) {
  sb = SampleBuffer{};
  sb.channels = data[1].empty() ? 1u : 2u;
  sb.frames = data[0].size();
  sb.sampleRate = sampleRate;
  sb.f32[0] = data[0].data();
  sb.f32[1] = sb.channels == 2 ? data[1].data() : nullptr;
  sb.bytes = static_cast<std::uint64_t>(sb.frames) * sb.channels * sizeof(float);
}

bool DroneUnit::Events::push(const AudioEvent &e) {
  if (e.kind == EventKind::VoiceEnded) return true;  // the drone's voices are its own business (no slot meters)
  return next ? next->push(e) : false;
}

DroneUnit::DroneUnit(double sampleRate, const DroneInit &init)
    : sr_(sampleRate),
      synthBus_(1.0),
      widthA_(1.0),
      widthB_(1.0),
      level_(init.level),
      // drone.js: new BiquadFilterNode(ctx, {type: 'highpass', frequency: 80, Q: 20 * Math.log10(Math.SQRT1_2)})
      hpf_(wa::BiquadType::Highpass, 80, 20 * js::log10(js::kSqrt1_2), 0) {
  const double w = std::clamp(init.width, 0.0, 1.0);
  wa::rampTo(widthA_.gain(), (1 + w) / 2, 0, 0.02);  // wLL, wRR
  wa::rampTo(widthB_.gain(), (1 - w) / 2, 0, 0.02);  // wLR, wRL
  wa::setNow(synthBus_.gain(), init.trimGain, 0);    // _afterRegistry -> setTrim(droneTrim)
}

DroneUnit::~DroneUnit() {
  // Control thread (the unit came back as Garbage, or was never attached): payloads die with it.
  for (InstSlot &s : inst_) delete s.box;
  for (Player &p : pads_) delete p.ref;
  for (Player &p : loops_) delete p.ref;
  for (unsigned i = 0; i < garbageN_; ++i) delete garbage_[i];
}

std::int64_t DroneUnit::frameOf(double t) const {
  return std::isfinite(t) && t > 0 ? static_cast<std::int64_t>(std::llround(t * sr_)) : 0;
}

void DroneUnit::later(Owned *p) {
  if (!p) return;
  if (garbageN_ < kMaxGarbage) garbage_[garbageN_++] = p;
  // else: leaked (counted nowhere); kMaxGarbage is far above what one quantum's commands can return
}

wa::Param *DroneUnit::param(std::uint32_t index) {
  switch (index) {
    case kDroneLevel: return &level_.gain();
    case kDroneWidthA: return &widthA_.gain();
    case kDroneWidthB: return &widthB_.gain();
    case kDroneSendGate: return &sendGate_.gain();
    case kParamWheel: return &wheel_.gain();
    case kParamBend: return &bend_.gain();
    case kParamSynthBus: return &synthBus_.gain();
    case kParamSynthMode: return &synthMode_.gain();
    case kParamFilesMode: return &filesMode_.gain();
    default: break;
  }
  if (index >= kParamInstGain0 && index < kParamInstGain0 + kMaxInst) return &inst_[index - kParamInstGain0].gain.gain();
  if (index >= kParamPadGain0 && index < kParamPadGain0 + kMaxPads) return &pads_[index - kParamPadGain0].gain.gain();
  if (index >= kParamLoopGain0 && index < kParamLoopGain0 + kMaxLoops)
    return &loops_[index - kParamLoopGain0].gain.gain();
  return nullptr;
}

void DroneUnit::stopPlayer(Player &p) {
  later(p.ref);
  p.ref = nullptr;
  p.src = wa::BufferSource();
}

void DroneUnit::apply(const Command &c) {
  const auto op = static_cast<DroneOp>(static_cast<std::uint16_t>(c.op));
  const bool owned = c.sub == kSubOwnedPayload;
  auto *payload = owned ? static_cast<Owned *>(c.p.ptr) : nullptr;
  const unsigned slot = c.aux;
  inst::SynthInstrument *in = slot < kMaxInst && inst_[slot].box ? inst_[slot].box->inst.get() : nullptr;
  switch (op) {
    case DroneOp::Param: {
      wa::Param *p = param(c.sub);
      if (!p) return;
      p->setContextTime(nextFrame_, sr_);  // main-thread view: the end of the last rendered quantum
      switch (static_cast<ParamCall>(c.aux)) {
        case ParamCall::Set: p->setValueAtTime(c.f.a, c.f.b); break;
        case ParamCall::Linear: p->linearRampToValueAtTime(c.f.a, c.f.b); break;
        case ParamCall::Exp: p->exponentialRampToValueAtTime(c.f.a, c.f.b); break;
        case ParamCall::Target: p->setTargetAtTime(c.f.a, c.f.b, c.f.c); break;
        case ParamCall::CancelHold: p->cancelAndHoldAtTime(c.f.b); break;
        case ParamCall::CancelScheduled: p->cancelScheduledValues(c.f.b); break;
      }
      return;
    }
    case DroneOp::SetInst:
      if (slot >= kMaxInst) return later(payload);
      later(inst_[slot].box);
      inst_[slot].box = static_cast<InstBox *>(payload);
      inst_[slot].armed = false;
      inst_[slot].gain = wa::Gain(0.0);  // drone.js _buildInst: new GainNode(ctx, {gain: 0})
      if (inst_[slot].box && inst_[slot].box->inst) inst_[slot].box->inst->setSampleRate(sr_);
      return;
    case DroneOp::DropInst:
      if (slot >= kMaxInst) return;
      later(inst_[slot].box);
      inst_[slot].box = nullptr;
      inst_[slot].armed = false;
      return;
    case DroneOp::Arm:
      if (slot < kMaxInst) inst_[slot].armed = c.f.a > 0.5 && inst_[slot].box;
      return;
    case DroneOp::NoteOn:
      if (in) {
        const int note = static_cast<int>(c.f.a);
        const int vel = std::clamp(static_cast<int>(std::lround(c.f.c * 127)), 1, 127);
        in->noteOn(note, vel, static_cast<float>(c.f.c), frameOf(c.f.b));
      }
      return;
    case DroneOp::NoteOff:
      if (in) in->noteOff(static_cast<int>(c.f.a), frameOf(c.f.b), true);
      return;
    case DroneOp::AllOff:
      if (in) in->allNotesOff(frameOf(c.f.b));
      return;
    case DroneOp::InstParam:
      if (in) in->setParam(c.sub, c.f.a, c.f.b, 0);
      return;
    case DroneOp::Morph:
      if (in) in->morph(c.f.a, c.f.b);
      return;
    case DroneOp::Bend:
      if (in) in->setBend(c.f.a, frameOf(c.f.b));
      return;
    case DroneOp::InstWaves: {
      if (!in) return later(payload);
      Command w = c;
      w.op = opOf(inst::SynthOp::SetWaves);
      in->apply(w);  // the instrument owns the payload now and hands its old bank back
      return;
    }
    case DroneOp::PadStart:
    case DroneOp::LoopStart: {
      const bool isPad = op == DroneOp::PadStart;
      const unsigned n = isPad ? kMaxPads : kMaxLoops;
      if (slot >= n || !payload) return later(payload);
      Player &p = isPad ? pads_[slot] : loops_[slot];
      stopPlayer(p);
      p.ref = static_cast<BufRef *>(payload);
      if (!isPad) p.gain = wa::Gain(0.0);  // drone.js _freezeSwap: a new source and a new GainNode(gain 0)
      p.src.setBuffer(p.ref->buf ? &p.ref->buf->sb : nullptr);
      const bool loop = isPad ? u2d(c.p.u2) > 0.5 : true;
      p.src.setLoop(loop, 0, 0);
      p.src.start(u2d(c.p.u0), std::max(0.0, u2d(c.p.u1)));
      return;
    }
    case DroneOp::PadStop:
      if (slot < kMaxPads) stopPlayer(pads_[slot]);
      return;
    case DroneOp::LoopStop:
      if (slot < kMaxLoops) stopPlayer(loops_[slot]);
      return;
    default:
      return later(payload);
  }
}

void DroneUnit::setSampleRate(double sr) {
  sr_ = sr;
  for (InstSlot &s : inst_)
    if (s.box && s.box->inst) s.box->inst->setSampleRate(sr);
}

std::uint32_t DroneUnit::liveVoices() const {
  std::uint32_t n = 0;
  for (const InstSlot &s : inst_)
    if (s.box && s.box->inst) n += s.box->inst->liveVoices();
  return n;
}

void DroneUnit::renderPlayer(Player &p, std::int64_t f0, double sr, float *l, float *r, bool &any) {
  if (!p.ref) return;
  float x[2][kQ];
  float *o[2] = {x[0], x[1]};
  p.src.process(f0, sr, o, kQ);
  if (p.src.channels() == 1) std::memcpy(x[1], x[0], sizeof x[0]);  // mono pad: 'speakers' up-mix downstream
  p.gain.process(o, o, 2, kQ, f0, sr);
  for (std::size_t i = 0; i < kQ; ++i) {
    l[i] += x[0][i];
    r[i] += x[1][i];
  }
  any = true;
  if (p.src.ended()) stopPlayer(p);  // drone.js onended / _disposeFrozen: the element / source is done
}

void DroneUnit::process(const RenderContext &ctx, UnitIO &io) {
  const std::int64_t f0 = ctx.frame0;
  const double sr = ctx.sampleRate;
  sr_ = sr;
  for (unsigned i = 0; i < garbageN_; ++i) giveBack(ctx, garbage_[i]);
  garbageN_ = 0;
  events_.next = ctx.events;
  RenderContext ictx = ctx;
  ictx.events = &events_;

  // ---- synth layers -> synthBus -> HPF -> synthMode ------------------------------------------------------------
  float *sb[2] = {a_[0], a_[1]};
  zero(a_[0], kQ);
  zero(a_[1], kQ);
  Bus tmp;
  for (InstSlot &s : inst_) {
    if (!s.armed || !s.box || !s.box->inst) continue;
    UnitIO iio;
    iio.out = &tmp;
    s.box->inst->process(ictx, iio);
    if (tmp.channels == 1) std::memcpy(tmp.ch[1], tmp.ch[0], sizeof tmp.ch[0]);
    float *t[2] = {tmp.ch[0], tmp.ch[1]};
    s.gain.process(t, t, 2, kQ, f0, sr);
    for (std::size_t i = 0; i < kQ; ++i) {
      a_[0][i] += tmp.ch[0][i];
      a_[1][i] += tmp.ch[1][i];
    }
  }
  for (unsigned i = 0; i < garbageN_; ++i) giveBack(ctx, garbage_[i]);  // nothing new expected; keeps order
  garbageN_ = 0;
  synthBus_.process(sb, sb, 2, kQ, f0, sr);
  hpf_.process(sb, 2, kQ, f0, sr);
  synthMode_.process(sb, sb, 2, kQ, f0, sr);

  // ---- pads -> filesMode; widthIn = synth + files ----------------------------------------------------------------
  float *fb[2] = {b_[0], b_[1]};
  zero(b_[0], kQ);
  zero(b_[1], kQ);
  bool anyPad = false;
  for (Player &p : pads_) renderPlayer(p, f0, sr, b_[0], b_[1], anyPad);
  filesMode_.process(fb, fb, 2, kQ, f0, sr);
  if (anyPad)
    for (std::size_t i = 0; i < kQ; ++i) {
      a_[0][i] += b_[0][i];
      a_[1][i] += b_[1][i];
    }

  // ---- width matrix: L' = wLL(L) + wRL(R), R' = wRR(R) + wLR(L) (wLL = wRR = A, wLR = wRL = B) -----------------
  {
    float *aIn[2] = {a_[0], a_[1]};
    float *aOut[2] = {c_[0], c_[1]};
    float *bOut[2] = {b_[0], b_[1]};
    widthA_.process(aIn, aOut, 2, kQ, f0, sr);  // c0 = A·L, c1 = A·R
    widthB_.process(aIn, bOut, 2, kQ, f0, sr);  // b0 = B·L, b1 = B·R
    for (std::size_t i = 0; i < kQ; ++i) {
      c_[0][i] += b_[1][i];
      c_[1][i] += b_[0][i];
    }
  }
  // ---- frozen loops -> merge channels 2, 3 ------------------------------------------------------------------------
  zero(c_[2], kQ);
  zero(c_[3], kQ);
  bool anyLoop = false;
  for (Player &p : loops_) renderPlayer(p, f0, sr, c_[2], c_[3], anyLoop);

  // ---- level -> wheel -> bend (4 channels), then out = live + loop, send = live x sendGate -----------------------
  float *c4[4] = {c_[0], c_[1], c_[2], c_[3]};
  const unsigned nch = anyLoop ? 4u : 2u;  // silent loop channels stay exactly 0 through the gains
  level_.process(c4, c4, nch, kQ, f0, sr);
  wheel_.process(c4, c4, nch, kQ, f0, sr);
  bend_.process(c4, c4, nch, kQ, f0, sr);
  if (io.out) {
    io.out->channels = 2;
    for (std::size_t i = 0; i < kQ; ++i) {
      io.out->ch[0][i] = anyLoop ? c_[0][i] + c_[2][i] : c_[0][i];
      io.out->ch[1][i] = anyLoop ? c_[1][i] + c_[3][i] : c_[1][i];
    }
  }
  float *s2[2] = {c_[0], c_[1]};
  sendGate_.process(s2, s2, 2, kQ, f0, sr);
  if (Bus *rev = io.sends[kSendReverb]) {
    Bus send;
    send.channels = 2;
    std::memcpy(send.ch[0], c_[0], sizeof send.ch[0]);
    std::memcpy(send.ch[1], c_[1], sizeof send.ch[1]);
    rev->add(send);
  }
  nextFrame_ = f0 + static_cast<std::int64_t>(kQ);
}

}  // namespace rig::drone
