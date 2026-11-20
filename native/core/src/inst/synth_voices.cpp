// synth.js voice recipes (inst/synth_voices.h). Line references are app/js/engine/synth.js.
#include "inst/synth_voices.h"

#include <algorithm>
#include <cstring>

#include "num/js_math.h"
#include "time/automation.h"

namespace rig::inst {
namespace {

using wa::Oscillator;

/** InstrumentBase.osc(v, wave, freq, detune, t): bend-linked (k-rate detune), started, a voice source. */
void osc(SynthVoice &v, Oscillator &o, const BuildCtx &b, WaveKind kind, unsigned rot, double freq, double detune,
         double t) {
  o.setWave(b.bank.wave(kind, rot));
  o.frequency().setValue(freq);
  o.detune().setValue(detune);
  o.setDetuneRate(wa::Param::Rate::KRate);
  v.addSource(&o, t, kind, rot);
}

/** rng.pick(waves): the rotation index. */
unsigned pick(const BuildCtx &b) {
  return static_cast<unsigned>(b.rng.pickIndex(kRotations));
}

void zero(float *x, std::size_t n) {
  std::memset(x, 0, n * sizeof(float));
}

/** GainNode with a constant gain (no automation, no inputs): GainHandler FinalValue path. */
void constGain(float *x, std::size_t n, float g) {
  if (g == 1.0f) return;
  if (g == 0.0f) {
    zero(x, n);
    return;
  }
  for (std::size_t i = 0; i < n; ++i) x[i] *= g;
}

void addTo(float *dst, const float *src, std::size_t n) {
  for (std::size_t i = 0; i < n; ++i) dst[i] += src[i];
}

void sumDet(float *out, const float *a, const float *b, std::size_t n) {
  for (std::size_t i = 0; i < n; ++i) out[i] = a[i] + b[i];
}

}  // namespace

unsigned releaseIndex(PatchId id) {
  switch (id) {
    case PatchId::WarmPad: return pk::wRelease;
    case PatchId::GlassPad: return pk::gRelease;
    case PatchId::Strings: return pk::sRelease;
    case PatchId::SubBass: return pk::bRelease;
    case PatchId::SoftKeys: return pk::kRelease;
    case PatchId::Bell: return pk::eRelease;
    case PatchId::DroneOsc: return pk::dRelease;
    default: return 0;
  }
}

int glideIndex(PatchId id) {
  switch (id) {
    case PatchId::SubBass: return pk::bGlide;
    case PatchId::SoftKeys: return pk::kGlide;
    case PatchId::Bell: return pk::eGlide;
    default: return -1;
  }
}

// ---- warm-pad (synth.js 265-286) -------------------------------------------------------------------------------

WarmVoice::WarmVoice(const BuildCtx &b) : SynthVoice(b.note, b.t, (0.55 + 0.45 * b.vel) * keyLevel(b.note)) {
  using namespace pk;
  const double *p = b.p;
  const double f = noteToFreq(b.note);
  const double outer = p[wDetune];
  const double inner = (outer * 9) / 17;
  const double dets[5] = {0, -inner, inner, -outer, outer};
  const double pans[5] = {0, 0.3, -0.3, -0.6, 0.6};
  for (int i = 0; i < 5; ++i) {  // sawStack: pick, osc, panner
    osc(*this, saw[i], b, WaveKind::Saw, pick(b), f, dets[i], b.t);
    pan[i] = ConstPan(pans[i]);
  }
  osc(*this, sub, b, WaveKind::BasicTriangle, 0, f / 2, 0, b.t);
  subG.gain().setValue(p[wSub] * 1.12);
  const double fc = 1800 * keytrack(b.note, 60, 0.5) * (0.7 + 0.6 * b.vel);
  q2.setValue(butter4Q(1) + p[wResonance] * 14.93);  // resQ
  l1.init(wa::BiquadType::Lowpass, fc, butter4Q(0));
  l2.init(wa::BiquadType::Lowpass, fc, butter4Q(1) + p[wResonance] * 14.93, &q2);
  makeEnv({p[wAttack], p[wDecay], p[wSustain], p[wRelease], 0}, b.t);
  freq = f;
  for (int i = 0; i < 5; ++i) addPitched(saw[i].frequency(), f, 1);
  addPitched(sub.frequency(), f * 0.5, 0.5);
}

void WarmVoice::render(const VoiceIn &in, float *l, float *r) {
  const std::size_t n = in.n;
  float tmp[kQuantum];
  zero(sumL_, n);
  zero(sumR_, n);
  for (int i = 0; i < 5; ++i) {
    saw[i].process(in.frame0, in.sr, tmp, n, nullptr, in.bend);
    pan[i].addTo(tmp, sumL_, sumR_, n);
  }
  sub.process(in.frame0, in.sr, tmp, n, nullptr, in.bend);
  float *t1[1] = {tmp};
  subG.process(t1, t1, 1, n, in.frame0, in.sr);
  addTo(sumL_, tmp, n);
  addTo(sumR_, tmp, n);
  constGain(sumL_, n, 0.2f);
  constGain(sumR_, n, 0.2f);
  float *ch[2] = {sumL_, sumR_};
  l1.process(ch, 2, n, in.frame0, in.sr, in.filterDet);
  l2.process(ch, 2, n, in.frame0, in.sr, in.filterDet);
  envOut(in, l, r, 2);
}

// ---- glass-pad (synth.js 322-355) ------------------------------------------------------------------------------

GlassVoice::GlassVoice(const BuildCtx &bc) : SynthVoice(bc.note, bc.t, (0.55 + 0.45 * bc.vel) * keyLevel(bc.note)) {
  using namespace pk;
  const double *p = bc.p;
  const double f = noteToFreq(bc.note);
  osc(*this, c, bc, WaveKind::Glass, pick(bc), f, 0, bc.t);
  osc(*this, a, bc, WaveKind::Glass, pick(bc), f, -p[gDetune], bc.t);
  osc(*this, b, bc, WaveKind::Glass, pick(bc), f, p[gDetune], bc.t);
  pa = ConstPan(-0.5);
  pb = ConstPan(0.5);
  osc(*this, bloom, bc, WaveKind::Glass, pick(bc), 2 * f, 0, bc.t);
  lpf.init(wa::BiquadType::Lowpass, 6000 * keytrack(bc.note, 60, 0.3) * (0.8 + 0.4 * bc.vel), qDb(0.6));
  makeEnv({p[gAttack], p[gDecay], p[gSustain], p[gRelease], 0}, bc.t);
  freq = f;
  addPitched(c.frequency(), f, 1);
  addPitched(a.frequency(), f, 1);
  addPitched(b.frequency(), f, 1);
  addPitched(bloom.frequency(), 2 * f, 2);
}

void GlassVoice::render(const VoiceIn &in, float *l, float *r) {
  const std::size_t n = in.n;
  float tmp[kQuantum], det[kQuantum], sideL[kQuantum], sideR[kQuantum];
  zero(sumL_, n);
  zero(sumR_, n);
  zero(sideL, n);
  zero(sideR, n);
  c.process(in.frame0, in.sr, tmp, n, nullptr, in.bend);
  addTo(sumL_, tmp, n);
  addTo(sumR_, tmp, n);
  sumDet(det, in.bend, in.chorusNeg, n);
  a.process(in.frame0, in.sr, tmp, n, nullptr, det);
  pa.addTo(tmp, sideL, sideR, n);
  sumDet(det, in.bend, in.chorusPos, n);
  b.process(in.frame0, in.sr, tmp, n, nullptr, det);
  pb.addTo(tmp, sideL, sideR, n);
  constGain(sideL, n, 0.7f);
  constGain(sideR, n, 0.7f);
  addTo(sumL_, sideL, n);
  addTo(sumR_, sideR, n);
  bloom.process(in.frame0, in.sr, tmp, n, nullptr, in.bend);
  for (std::size_t i = 0; i < n; ++i) tmp[i] *= 0.0f + in.bloom[i];  // bloomG: gain 0 + bloomCS (a-rate input)
  addTo(sumL_, tmp, n);
  addTo(sumR_, tmp, n);
  constGain(sumL_, n, 0.26f);
  constGain(sumR_, n, 0.26f);
  float *ch[2] = {sumL_, sumR_};
  lpf.process(ch, 2, n, in.frame0, in.sr, in.filterDet);
  envOut(in, l, r, 2);
}

// ---- strings (synth.js 382-408) --------------------------------------------------------------------------------

StringsVoice::StringsVoice(const BuildCtx &b) : SynthVoice(b.note, b.t, (0.5 + 0.5 * b.vel) * keyLevel(b.note)) {
  using namespace pk;
  const double *p = b.p;
  const double f = noteToFreq(b.note);
  const double d = p[sDetune];
  const double dets[5] = {0, -d / 2, d / 2, d, -d};
  const double pans[5] = {0, -0.25, 0.25, -0.5, 0.5};
  for (int i = 0; i < 5; ++i) {
    osc(*this, saw[i], b, WaveKind::Saw, pick(b), f, dets[i], b.t);
    pan[i] = ConstPan(pans[i]);
  }
  // delayed vibrato: per-voice LFO (slightly random rate), depth fades in after vibDelay
  vib.setWave(b.bank.basicSine.get());
  vib.frequency().setValue(p[sVibRate] * (1 + 0.04 * b.rng.gaussian()));
  addSource(&vib, b.t, WaveKind::BasicSine, 0);
  wa::setNow(vibG.gain(), 0, b.t + p[sVibDelay]);
  wa::linearTo(vibG.gain(), p[sVibDepth], b.t + p[sVibDelay], 0.4, 0);
  const double fc = 4000 * keytrack(b.note, 60, 0.25) * (0.8 + 0.4 * b.vel);
  l1.init(wa::BiquadType::Lowpass, fc, butter4Q(0));
  l2.init(wa::BiquadType::Lowpass, fc, butter4Q(1));
  makeEnv({p[sAttack], 0.3, 1, p[sRelease], 0}, b.t);
  freq = f;
  for (int i = 0; i < 5; ++i) addPitched(saw[i].frequency(), f, 1);
}

void StringsVoice::render(const VoiceIn &in, float *l, float *r) {
  const std::size_t n = in.n;
  float tmp[kQuantum], vibOut[kQuantum], det[kQuantum];
  vib.process(in.frame0, in.sr, vibOut, n);
  float *v1[1] = {vibOut};
  vibG.process(v1, v1, 1, n, in.frame0, in.sr);
  sumDet(det, in.bend, vibOut, n);
  zero(sumL_, n);
  zero(sumR_, n);
  for (int i = 0; i < 5; ++i) {
    saw[i].process(in.frame0, in.sr, tmp, n, nullptr, det);
    pan[i].addTo(tmp, sumL_, sumR_, n);
  }
  constGain(sumL_, n, 0.2f);
  constGain(sumR_, n, 0.2f);
  float *ch[2] = {sumL_, sumR_};
  l1.process(ch, 2, n, in.frame0, in.sr, in.filterDet);
  l2.process(ch, 2, n, in.frame0, in.sr, in.filterDet);
  envOut(in, l, r, 2);
}

// ---- sub-bass (synth.js 453-474) -------------------------------------------------------------------------------

SubVoice::SubVoice(const BuildCtx &b) : SynthVoice(b.note, b.t, 0.6 + 0.4 * b.vel) {
  using namespace pk;
  const double *p = b.p;
  const double f = noteToFreq(b.note);
  const auto rot = static_cast<unsigned>(b.rng.integer(0, 7));
  osc(*this, s, b, WaveKind::Sine, rot, f, 0, b.t);
  osc(*this, tr, b, WaveKind::Tri, rot, f, 0, b.t);
  osc(*this, h2, b, WaveKind::Sine, (2 * rot) % 8, 2 * f, 0, b.t);
  trG.gain().setValue(p[bTri] * 0.8);
  makeEnv({p[bAttack], 0, 1, p[bRelease], 0}, b.t);
  freq = f;
  addPitched(s.frequency(), f, 1);
  addPitched(tr.frequency(), f, 1);
  addPitched(h2.frequency(), 2 * f, 2);
}

void SubVoice::render(const VoiceIn &in, float *l, float *) {
  const std::size_t n = in.n;
  float tmp[kQuantum];
  s.process(in.frame0, in.sr, sumL_, n, nullptr, in.bend);
  tr.process(in.frame0, in.sr, tmp, n, nullptr, in.bend);
  float *t1[1] = {tmp};
  trG.process(t1, t1, 1, n, in.frame0, in.sr);
  addTo(sumL_, tmp, n);
  h2.process(in.frame0, in.sr, tmp, n, nullptr, in.bend);
  for (std::size_t i = 0; i < n; ++i) tmp[i] *= 0.0f + in.h2[i];  // h2G: gain 0 + h2CS
  addTo(sumL_, tmp, n);
  constGain(sumL_, n, 0.5f);
  envOut(in, l, nullptr, 1);
}

// ---- soft-keys (synth.js 551-580) ------------------------------------------------------------------------------

double keysAmpTau(int note) {
  return clampd(3 * js::pow(0.8 / 3, (note - 48) / 36.0), 0.35, 6);
}

void keysCaps(double sr, double f, double i1, double &c1, double &cT) {
  c1 = fmIndexCap(sr, f, f);
  cT = fmIndexCap(sr, f, 14 * f, std::min(i1, c1) * f);
}

KeysVoice::KeysVoice(const BuildCtx &b) : SynthVoice(b.note, b.t, (0.15 + 0.85 * b.vel) * 0.5) {
  using namespace pk;
  const double *p = b.p;
  const double f = noteToFreq(b.note);
  osc(*this, car, b, WaveKind::BasicSine, 0, f, 0, b.t);
  osc(*this, m1, b, WaveKind::BasicSine, 0, f, 0, b.t);
  const double i0 = (0.3 + 1.5 * b.vel) * p[kTone];
  double c1 = 0, cT = 0;
  keysCaps(b.sr, f, i0, c1, cT);
  fm1.init(&m1G.gain(), i0, 0.2 * p[kTone], 0.4, f, c1, b.t);
  addPitched(car.frequency(), f, 1);
  addPitched(m1.frequency(), f, 1);
  const double iT = 0.8 * p[kTine] * (0.4 + 0.6 * b.vel);
  if (iT > 0 && cT > 0.02) {  // tine only where some of its first sideband fits under 0.45 sr
    osc(*this, tine, b, WaveKind::BasicSine, 0, 14 * f, 0, b.t);
    stopSource(nSrc_ - 1, b.t + 0.3);  // tau 30 ms: silent long before
    fmT.init(&tG.gain(), iT, 0, 0.03, 14 * f, cT, b.t);
    hasTine = true;
    addPitched(tine.frequency(), 14 * f, 14);
  }
  makeEnv({0.002, 0, 0, p[kRelease], keysAmpTau(b.note) * p[kDecay]}, b.t);
  freq = f;
}

void KeysVoice::render(const VoiceIn &in, float *l, float *) {
  const std::size_t n = in.n;
  float tmp[kQuantum], fm[kQuantum];
  m1.process(in.frame0, in.sr, fm, n, nullptr, in.bend);
  float *f1[1] = {fm};
  m1G.process(f1, f1, 1, n, in.frame0, in.sr);
  if (hasTine) {
    tine.process(in.frame0, in.sr, tmp, n, nullptr, in.bend);
    float *t1[1] = {tmp};
    tG.process(t1, t1, 1, n, in.frame0, in.sr);
    addTo(fm, tmp, n);
  }
  car.process(in.frame0, in.sr, sumL_, n, fm, in.bend);
  envOut(in, l, nullptr, 1);
}

// ---- bell (synth.js 616-634) -----------------------------------------------------------------------------------

BellVoice::BellVoice(const BuildCtx &b)
    : SynthVoice(b.note, b.t, (0.25 + 0.75 * b.vel) * 0.5 * keyLevel(b.note)) {
  using namespace pk;
  const double *p = b.p;
  const double f = noteToFreq(b.note);
  const double r = p[eRatio] + b.morph * (5.1 - 3.5);
  const unsigned rc = pick(b);
  osc(*this, car, b, WaveKind::Sine, rc, f, 0, b.t);
  const unsigned rm = pick(b);
  osc(*this, mod, b, WaveKind::Sine, rm, f * r, 0, b.t);
  const double i0 = p[eIndex] * (0.6 + 0.4 * b.vel);
  fmd.init(&mG.gain(), i0, 0.15 * i0, p[eIndexDecay], r * f, fmIndexCap(b.sr, f, r * f), b.t);
  const double tau = p[eDecay] * keytrack(b.note, 60, -0.5) / 3;  // decay param ≈ time to -26 dB
  makeEnv({p[eAttack], 0, 0, p[eRelease], tau}, b.t);
  freq = f;
  addPitched(car.frequency(), f, 1);
  addPitched(mod.frequency(), f * r, r);
}

void BellVoice::render(const VoiceIn &in, float *l, float *) {
  const std::size_t n = in.n;
  float fm[kQuantum];
  mod.process(in.frame0, in.sr, fm, n, nullptr, in.bend);
  float *f1[1] = {fm};
  mG.process(f1, f1, 1, n, in.frame0, in.sr);
  car.process(in.frame0, in.sr, sumL_, n, fm, in.bend);
  envOut(in, l, nullptr, 1);
}

// ---- drone-osc (synth.js 674-704) ------------------------------------------------------------------------------

DroneVoice::DroneVoice(const BuildCtx &b)
    : SynthVoice(b.note, b.t, (0.55 + 0.45 * b.vel) * keyLevel(b.note)), walk(b.walk) {
  using namespace pk;
  const double *p = b.p;
  const double f = noteToFreq(b.note);
  const double d = p[dDetune];
  const double dets[4] = {-d, -d / 3, d / 3, d};
  const double pans[4] = {-0.5, 0.2, -0.2, 0.5};
  for (int i = 0; i < 4; ++i) {
    osc(*this, saw[i], b, WaveKind::Saw, pick(b), f, dets[i], b.t);
    pan[i] = ConstPan(pans[i]);
  }
  osc(*this, sub, b, WaveKind::BasicTriangle, 0, f / 2, 0, b.t);
  subG.gain().setValue(p[dSub] * 1.12);
  walk.setLoop(true, 0, 0);
  walk.playbackRate().setValue(b.rng.range(0.6, 1.4));
  driftG.gain().setValue(p[dDrift]);
  const double dur = b.walk && b.walk->sampleRate > 0
                         ? static_cast<double>(b.walk->frames) / b.walk->sampleRate
                         : 64.0;
  addSource(&walk, b.t, b.rng.range(0, dur));
  const double fc = 1400 * keytrack(b.note, 60, 0.5) * (0.7 + 0.6 * b.vel);
  l1.init(wa::BiquadType::Lowpass, fc, butter4Q(0));
  l2.init(wa::BiquadType::Lowpass, fc, butter4Q(1));
  makeEnv({p[dAttack], 1, 1, p[dRelease], 0}, b.t);
  freq = f;
  for (int i = 0; i < 4; ++i) addPitched(saw[i].frequency(), f, 1);
  addPitched(sub.frequency(), f * 0.5, 0.5);
}

void DroneVoice::render(const VoiceIn &in, float *l, float *r) {
  const std::size_t n = in.n;
  float tmp[kQuantum], drift[kQuantum], det[kQuantum], tmpR[kQuantum];
  float *w[2] = {drift, tmpR};
  walk.process(in.frame0, in.sr, w, n);
  float *d1[1] = {drift};
  driftG.process(d1, d1, 1, n, in.frame0, in.sr);
  zero(sumL_, n);
  zero(sumR_, n);
  for (int i = 0; i < 4; ++i) {
    const float *uni = (i % 2 == 0) ? in.uniNeg : in.uniPos;
    for (std::size_t k = 0; k < n; ++k) det[k] = in.bend[k] + drift[k] + uni[k];
    saw[i].process(in.frame0, in.sr, tmp, n, nullptr, det);
    pan[i].addTo(tmp, sumL_, sumR_, n);
  }
  sumDet(det, in.bend, drift, n);
  sub.process(in.frame0, in.sr, tmp, n, nullptr, det);
  float *t1[1] = {tmp};
  subG.process(t1, t1, 1, n, in.frame0, in.sr);
  addTo(sumL_, tmp, n);
  addTo(sumR_, tmp, n);
  constGain(sumL_, n, 0.22f);
  constGain(sumR_, n, 0.22f);
  float *ch[2] = {sumL_, sumR_};
  l1.process(ch, 2, n, in.frame0, in.sr, in.filterDet);
  l2.process(ch, 2, n, in.frame0, in.sr, in.filterDet);
  envOut(in, l, r, 2);
}

}  // namespace rig::inst
