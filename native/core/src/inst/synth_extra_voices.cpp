// synth-extra.js PATCHES + IMPL[*].voice (inst/synth_extra_voices.h). Line references: app/js/engine/synth-extra.js.
#include "inst/synth_extra_voices.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "num/js_math.h"
#include "time/automation.h"

namespace rig::inst {
namespace {

constexpr ParamDef attack(double d, double max = 8) { return {"attack", "Attack", 0.002, max, d, "s", "log"}; }
constexpr ParamDef decay(double d, double max = 6) { return {"decay", "Decay", 0.02, max, d, "s", "log"}; }
constexpr ParamDef sustain(double d) { return {"sustain", "Sustain", 0, 1, d, "lin", "lin"}; }
constexpr ParamDef release(double d, double max = 12) { return {"release", "Release", 0.03, max, d, "s", "log"}; }
constexpr ParamDef cutoff(double d, double min = 200, double max = 14000) {
  return {"cutoff", "Cutoff", min, max, d, "Hz", "log"};
}
constexpr ParamDef reso(double d) { return {"resonance", "Resonance", 0, 1, d, "lin", "lin"}; }
constexpr ParamDef glide(double d) { return {"glide", "Legato glide", 0, 0.5, d, "s", "lin"}; }
constexpr ParamDef lin(const char *key, const char *label, double min, double max, double d) {
  return {key, label, min, max, d, "lin", "lin"};
}

constexpr ParamDef kSupersaw[] = {attack(0.6), decay(1.2), sustain(0.85), release(2.5), cutoff(3000), reso(0),
                                  lin("detune", "Detune spread (cents)", 0, 50, 25),
                                  lin("width", "Stereo width", 0, 1, 0.6), lin("sub", "Sub level", 0, 1, 0.3)};
constexpr ParamDef kJuno[] = {attack(0.35), decay(1.5), sustain(0.8), release(2), cutoff(2200), reso(0.15),
                              {"pwmRate", "PWM rate", 0.05, 6, 0.6, "Hz", "log"},
                              lin("pwmDepth", "PWM depth", 0, 1, 0.6), lin("chorus", "Chorus", 0, 1, 0.6),
                              {"chorusRate", "Chorus rate", 0.1, 2, 0.5, "Hz", "log"},
                              lin("sub", "Sub level", 0, 1, 0.35)};
constexpr ParamDef kShimmer[] = {attack(1.5), decay(2), sustain(0.9), release(4, 16), cutoff(7000, 500, 16000),
                                 lin("detune", "Detune (cents)", 0, 25, 7),
                                 lin("octave", "Octave-up level", 0, 1, 0.35),
                                 {"bloomTime", "Octave fade-in", 0.2, 8, 3, "s", "log"},
                                 {"tremRate", "Tremolo rate", 0.05, 4, 0.3, "Hz", "log"},
                                 lin("tremDepth", "Tremolo depth", 0, 1, 0.3)};
constexpr ParamDef kDx[] = {{"decay", "Decay", 0.3, 3, 1, "lin", "log"}, release(0.35, 3),
                            lin("tone", "Brightness", 0, 2, 1), lin("tine", "Tine", 0, 2, 1),
                            lin("detune", "Detune (cents)", 0, 12, 3), lin("chorus", "Chorus", 0, 1, 0.35),
                            glide(0.03)};
constexpr ParamDef kPluck[] = {{"decay", "Decay @C4", 0.1, 4, 0.75, "s", "log"}, release(0.3, 3), cutoff(4500),
                               reso(0.2), lin("square", "Square level", 0, 1, 0.5),
                               lin("detune", "Detune (cents)", 0, 20, 6), glide(0.03)};
constexpr ParamDef kPoly[] = {attack(0.005, 1), decay(0.45, 3), sustain(0.5), release(0.25, 3),
                              cutoff(900, 100, 8000), reso(0.35),
                              lin("envAmount", "Filter env amount", 0, 1, 0.6),
                              lin("detune", "Detune (cents)", 0, 30, 10), glide(0.03)};
constexpr ParamDef kBrass[] = {attack(0.06, 2), decay(0.4, 3), sustain(0.85), release(0.35, 4),
                               cutoff(700, 100, 8000), lin("envAmount", "Filter env amount", 0, 1, 0.55),
                               {"filterAttack", "Filter attack", 0.005, 1, 0.08, "s", "log"},
                               lin("detune", "Detune (cents)", 0, 30, 8),
                               lin("vibDepth", "Vibrato depth (cents)", 0, 30, 7),
                               {"vibRate", "Vibrato rate", 2, 8, 5.2, "Hz", "lin"},
                               {"vibDelay", "Vibrato delay", 0, 2, 0.4, "s", "lin"}, glide(0.05)};
constexpr ParamDef kLead[] = {attack(0.005, 2), release(0.2, 4), cutoff(3500, 200, 14000), reso(0.1),
                              lin("pwm", "Pulse width", 0, 1, 0), lin("sub", "Sub level", 0, 1, 0.4), glide(0.06),
                              lin("vibDepth", "Vibrato depth (cents)", 0, 40, 10),
                              {"vibRate", "Vibrato rate", 2, 8, 5.5, "Hz", "lin"},
                              {"vibDelay", "Vibrato delay", 0, 2, 0.3, "s", "lin"}};
constexpr ParamDef k808[] = {{"decay", "Decay", 0.2, 8, 2.5, "s", "log"}, release(0.25, 3),
                             lin("drive", "Drive", 0, 1, 0.35),
                             lin("pitchDrop", "Pitch drop (semitones)", 0, 12, 2),
                             {"dropTime", "Pitch drop time", 0.01, 0.3, 0.06, "s", "log"}, glide(0.05)};
constexpr ParamDef kBass[] = {attack(0.003, 1), decay(0.35, 3), sustain(0.55), release(0.12, 3),
                              cutoff(320, 60, 4000), reso(0.3), lin("envAmount", "Filter env amount", 0, 1, 0.6),
                              lin("square", "Square level", 0, 1, 0.5), glide(0.03)};

#define RIG_XP(id, name, str, group, tab, level) \
  XPatchDef{XPatch::id, name, str, group, tab, sizeof(tab) / sizeof(tab[0]), 0, 0, level}
// gainTrim (PATCHES) and gain-trims.json synth[id] are 0 dB for every synth-extra patch (tests check both)
const XPatchDef kXPatches[] = {
    RIG_XP(SupersawPad, "Supersaw Pad", "supersaw-pad", "Synth Pads", kSupersaw, 0.624),
    RIG_XP(JunoPad, "Juno Pad", "juno-pad", "Synth Pads", kJuno, 0.506),
    RIG_XP(ShimmerPad, "Shimmer Pad", "shimmer-pad", "Synth Pads", kShimmer, 0.857),
    RIG_XP(DxEpiano, "DX E-Piano", "dx-epiano", "Synth Keys", kDx, 0.471),
    RIG_XP(Pluck, "Pluck", "pluck", "Synth Keys", kPluck, 0.628),
    RIG_XP(PolyStab, "Poly Stab", "poly-stab", "Synth Keys", kPoly, 0.832),
    RIG_XP(AnalogBrass, "Analog Brass", "analog-brass", "Brass & Leads", kBrass, 0.586),
    RIG_XP(SquareLead, "Square Lead", "square-lead", "Brass & Leads", kLead, 0.25),
    RIG_XP(Sub808, "808 Sub", "808-sub", "Bass", k808, 0.517),
    RIG_XP(SynthBass, "Synth Bass", "synth-bass", "Bass", kBass, 0.544),
};
#undef RIG_XP

unsigned pick(const XBuild &b) {
  return static_cast<unsigned>(b.rng.pickIndex(kRotations));
}
void zero(float *x, std::size_t n) {
  std::memset(x, 0, n * sizeof(float));
}
void mulc(float *x, std::size_t n, float g) {  // GainNode with a constant gain (GainHandler FinalValue path)
  if (g == 1.0f) return;
  if (g == 0.0f) return zero(x, n);
  for (std::size_t i = 0; i < n; ++i) x[i] *= g;
}
void addTo(float *d, const float *s, std::size_t n) {
  for (std::size_t i = 0; i < n; ++i) d[i] += s[i];
}
void gain1(wa::Gain &g, float *x, const VoiceIn &in) {
  float *c[1] = {x};
  g.process(c, c, 1, in.n, in.frame0, in.sr);
}
/** GainNode whose gain AudioParam has an audio input: a-rate timeline + input, per frame. */
void connGain(wa::Param &g, const float *conn, float *x, const VoiceIn &in) {
  float v[kQuantum];
  g.processARate(in.frame0, in.sr, v, in.n);
  for (std::size_t i = 0; i < in.n; ++i) x[i] *= v[i] + conn[i];
}
const XIn &xin(const VoiceIn &in) {
  return static_cast<const XIn &>(in);
}
constexpr double kLn10 = 2.302585092994046;  // Math.LN10 (PLUCK_T20)

}  // namespace

const XPatchDef &xpatchDef(XPatch id) {
  return kXPatches[static_cast<std::size_t>(id)];
}

const XPatchDef *findXPatch(std::string_view id) {
  for (const XPatchDef &p : kXPatches)
    if (id == p.idStr) return &p;
  return nullptr;
}

double pwmMaxDelay(double f) {
  return clampd(2.2 / f, 0.004, 1);
}

void xosc(SynthVoice &v, wa::Oscillator &o, const wa::PeriodicWave *w, double freq, double detune, double t) {
  o.setWave(w);
  o.frequency().setValue(freq);
  o.detune().setValue(detune);
  o.setDetuneRate(wa::Param::Rate::KRate);  // InstrumentBase.osc: detune k-rate, bendCS linked
  v.addSource(&o, t, WaveKind::None, 0);
}

void LpfPair::init(double freq, double q2, wa::Param *fa, wa::Param *qb, wa::Param *fb, wa::Param *da,
                   wa::Param *db) {
  a.init(wa::BiquadType::Lowpass, freq, butter4Q(0), fa, nullptr, da, true);
  b.init(wa::BiquadType::Lowpass, freq, qDb(q2), fb, qb, db, true);
}

void LpfPair::process(float *const *ch, unsigned nch, const VoiceIn &in) {
  a.process(ch, nch, in.n, in.frame0, in.sr, in.filterDet);
  b.process(ch, nch, in.n, in.frame0, in.sr, in.filterDet);
}

// ---- 808-sub (synth-extra.js 1002-1016) ----------------------------------------------------------------------

Sub808Voice::Sub808Voice(const XBuild &b) : XVoice(b.note, b.t, 0.35 + 0.65 * b.vel) {
  using namespace xk;
  const double *p = b.p;
  const double f = noteToFreq(b.note);
  const double f0 = f * js::pow(2, p[suPitchDrop] / 12);
  xosc(*this, o, b.bank.basicSine.get(), f0, 0, b.t);
  track(o.frequency(), f0, 1);  // v.data.tracked = [{tp: TrackedParam(o.frequency, f0), mult: 1}]
  tracked[0].glide(f, b.t, p[suDropTime]);
  makeEnv({0.002, 0, 0, p[suRelease], p[suDecay] / 4.6}, b.t);
  freq = f;
}

void Sub808Voice::render(const VoiceIn &in, float *l, float *r) {
  runOsc(0, o, in, sumL_, nullptr, in.bend);
  envOut(in, l, r, 1);
}

// ---- pluck (782-806) -------------------------------------------------------------------------------------------

PluckVoice::PluckVoice(const XBuild &b) : XVoice(b.note, b.t, 0) {
  using namespace xk;
  const double *p = b.p;
  const double f = noteToFreq(b.note);
  const auto ph = static_cast<unsigned>(b.rng.integer(0, kRotations - 1));
  xosc(*this, saw, b.bank.saw[ph].get(), f, -p[plDetune] / 2, b.t);
  xosc(*this, sq, b.xb.square[ph].get(), f, p[plDetune] / 2, b.t);
  sqG.gain().setValue(p[plSquare] * 0.6);
  const double dk = p[plDecay] * js::pow(2, -(b.note - 60) / 36.0) * (1 + 1.5 * b.morph);  // decayAt
  const double peak = std::min(18000.0, 4500 * keytrack(b.note, 60, 0.5) * (0.45 + 0.75 * b.vel));
  const double floor = std::min(peak, std::max(250.0, 2.2 * f));
  fa.setValue(peak);
  fb.setValue(peak);
  qb.setValue(qDb(1.0 + p[plResonance] * 4));
  lp.init(peak, 1.0 + p[plResonance] * 4, &fa, &qb, &fb);
  for (wa::Param *fl : {&fa, &fb}) {
    wa::setNow(*fl, peak, b.t);
    wa::rampTo(*fl, floor, b.t + 0.002, dk / 4);
  }
  outG.gain().setValue((0.3 + 0.7 * b.vel) * keyLevel(b.note));
  makeEnv({0.002, 0, 0, p[plRelease], dk / kLn10}, b.t);
  freq = f;
  track(saw.frequency(), f, 1);
  track(sq.frequency(), f, 1);
}

void PluckVoice::render(const VoiceIn &in, float *l, float *r) {
  float tmp[kQuantum];
  runOsc(0, saw, in, sumL_, nullptr, in.bend);
  runOsc(1, sq, in, tmp, nullptr, in.bend);
  gain1(sqG, tmp, in);
  addTo(sumL_, tmp, in.n);
  mulc(sumL_, in.n, 0.5f);
  float *ch[1] = {sumL_};
  lp.process(ch, 1, in);
  envOut(in, l, r, 1);
}

// ---- synth-bass (1031-1060) ------------------------------------------------------------------------------------

BassVoice::BassVoice(const XBuild &b) : XVoice(b.note, b.t, 0.4 + 0.6 * b.vel) {
  using namespace xk;
  const double *p = b.p;
  const double f = noteToFreq(b.note);
  const auto ph = static_cast<unsigned>(b.rng.integer(0, kRotations - 1));
  xosc(*this, saw, b.bank.saw[ph].get(), f, 0, b.t);
  xosc(*this, sq, b.xb.square[ph].get(), f, 0, b.t);
  sqG.gain().setValue(p[baSquare]);
  qb.setValue(qDb(0.9 + p[baResonance] * 4));
  lp.init(320 * keytrack(b.note, 36, 0.5), 0.9 + p[baResonance] * 4, nullptr, &qb, nullptr, &da, &db);
  const double ec = p[baEnvAmount] * 3600 * (0.4 + 0.6 * b.vel);
  for (wa::Param *d : {&da, &db}) {
    wa::setNow(*d, ec, b.t);
    wa::rampTo(*d, 0, b.t + 0.003, 0.08);
  }
  makeEnv({p[baAttack], p[baDecay], p[baSustain], p[baRelease], 0}, b.t);
  freq = f;
  track(saw.frequency(), f, 1);
  track(sq.frequency(), f, 1);
}

void BassVoice::render(const VoiceIn &in, float *l, float *r) {
  float tmp[kQuantum];
  runOsc(0, saw, in, sumL_, nullptr, in.bend);
  runOsc(1, sq, in, tmp, nullptr, in.bend);
  gain1(sqG, tmp, in);
  addTo(sumL_, tmp, in.n);
  mulc(sumL_, in.n, 0.55f);
  float *ch[1] = {sumL_};
  lp.process(ch, 1, in);
  envOut(in, l, r, 1);
}

// ---- poly-stab (820-852) ---------------------------------------------------------------------------------------

PolyVoice::PolyVoice(const XBuild &b) : XVoice(b.note, b.t, (0.3 + 0.7 * b.vel) * keyLevel(b.note)) {
  using namespace xk;
  const double *p = b.p;
  const double f = noteToFreq(b.note);
  xosc(*this, s1, b.bank.saw[pick(b)].get(), f, -p[poDetune], b.t);
  xosc(*this, s2, b.bank.saw[pick(b)].get(), f, p[poDetune], b.t);
  xosc(*this, sq, b.xb.square[pick(b)].get(), f, 0, b.t);
  p1 = ConstPan(-0.35);
  p2 = ConstPan(0.35);
  qb.setValue(qDb(b.q2));
  lp.init(900 * keytrack(b.note, 60, 0.5), b.q2, nullptr, &qb, nullptr, &da, &db);
  const double a = std::max(0.002, p[poAttack]);
  for (wa::Param *d : {&da, &db}) {
    wa::setNow(*d, b.envCents, b.t);
    wa::rampTo(*d, 0, b.t + a, p[poDecay] / 2.5);
  }
  makeEnv({a, p[poDecay], p[poSustain], p[poRelease], 0}, b.t);
  freq = f;
  track(s1.frequency(), f, 1);
  track(s2.frequency(), f, 1);
  track(sq.frequency(), f, 1);
}

void PolyVoice::render(const VoiceIn &in, float *l, float *r) {
  const std::size_t n = in.n;
  float tmp[kQuantum];
  zero(sumL_, n);
  zero(sumR_, n);
  runOsc(0, s1, in, tmp, nullptr, in.bend);
  p1.addTo(tmp, sumL_, sumR_, n);
  runOsc(1, s2, in, tmp, nullptr, in.bend);
  p2.addTo(tmp, sumL_, sumR_, n);
  runOsc(2, sq, in, tmp, nullptr, in.bend);
  mulc(tmp, n, 0.55f);
  addTo(sumL_, tmp, n);
  addTo(sumR_, tmp, n);
  mulc(sumL_, n, 0.3f);
  mulc(sumR_, n, 0.3f);
  float *ch[2] = {sumL_, sumR_};
  lp.process(ch, 2, in);
  envOut(in, l, r, 2);
}

// ---- analog-brass (868-905) ------------------------------------------------------------------------------------

BrassVoice::BrassVoice(const XBuild &b) : XVoice(b.note, b.t, (0.45 + 0.55 * b.vel) * keyLevel(b.note)) {
  using namespace xk;
  const double *p = b.p;
  const double f = noteToFreq(b.note);
  const double d = p[brDetune];
  const double dets[3] = {0, -d, d}, pans[3] = {0, -0.4, 0.4};
  for (int i = 0; i < 3; ++i) {
    xosc(*this, saw[i], b.bank.saw[pick(b)].get(), f, dets[i], b.t);
    pan[i] = ConstPan(pans[i]);
  }
  wa::setNow(vibG.gain(), 0, b.t + p[brVibDelay]);
  wa::linearTo(vibG.gain(), 1, b.t + p[brVibDelay], 0.4, 0);
  hpf.init(wa::BiquadType::Highpass, 80, butter2Q(), nullptr, nullptr, nullptr, false);
  lp.init(700 * keytrack(b.note, 60, 0.6) * (0.7 + 0.5 * b.vel), 1.0, nullptr, nullptr, nullptr, &da, &db);
  const double pk = b.envCents, fa = p[brFilterAttack];
  for (wa::Param *x : {&da, &db}) {
    wa::setNow(*x, 0, b.t);
    wa::linearTo(*x, pk, b.t, fa, 0);
    wa::rampTo(*x, pk * 0.35, b.t + fa, 0.3);
  }
  makeEnv({p[brAttack], p[brDecay], p[brSustain], p[brRelease], 0}, b.t);
  vel = b.vel;
  attackEnd = b.t + fa;
  freq = f;
  for (auto &s : saw) track(s.frequency(), f, 1);
}

double BrassVoice::onRelease(double rt, double envR, double paramR) {
  for (wa::Param *x : {&da, &db}) wa::rampTo(*x, 0, rt, paramR / 4);
  return envRelease(rt, envR);
}

void BrassVoice::render(const VoiceIn &in, float *l, float *r) {
  const XIn &x = xin(in);
  const std::size_t n = in.n;
  float tmp[kQuantum], vib[kQuantum], det[kQuantum];
  zero(sumL_, n);
  zero(sumR_, n);
  const bool active = srcActive(0, in.frame0, in.sr, n);  // vibG is pulled by the saws' detune (k-rate)
  if (active) {
    std::memcpy(vib, x.vib ? x.vib : x.zeros, n * sizeof(float));
    gain1(vibG, vib, in);
    for (std::size_t i = 0; i < n; ++i) det[i] = in.bend[i] + vib[i];
  }
  for (int i = 0; i < 3; ++i) {
    runOsc(static_cast<unsigned>(i), saw[i], in, tmp, nullptr, active ? det : in.bend);
    pan[i].addTo(tmp, sumL_, sumR_, n);
  }
  mulc(sumL_, n, 0.33f);
  mulc(sumR_, n, 0.33f);
  float *ch[2] = {sumL_, sumR_};
  hpf.process(ch, 2, n, in.frame0, in.sr, 0);
  lp.process(ch, 2, in);
  envOut(in, l, r, 2);
}

// ---- square-lead (936-961) -------------------------------------------------------------------------------------

LeadVoice::LeadVoice(const XBuild &b) : XVoice(b.note, b.t, (0.5 + 0.5 * b.vel) * keyLevel(b.note)) {
  using namespace xk;
  const double *p = b.p;
  const double f = noteToFreq(b.note);
  xosc(*this, saw, b.bank.saw[pick(b)].get(), f, 0, b.t);
  periodG.gain().setValue(1 / f);  // pwmPulse(inst, v, saw, f, 0.4)
  double mx = pwmMaxDelay(f);
  if (XDelay::lengthFor(mx, b.sr) > b.delayCap) mx = static_cast<double>(b.delayCap - XDelay::kQ - 1) / b.sr;
  dl.attach(b.delayBuf, mx, b.sr);
  xosc(*this, sub, b.xb.square[pick(b)].get(), f / 2, 0, b.t);
  subG.gain().setValue(p[leSub] * 0.4);
  wa::setNow(vibG.gain(), 0, b.t + p[leVibDelay]);
  wa::linearTo(vibG.gain(), 1, b.t + p[leVibDelay], 0.3, 0);
  qb.setValue(qDb(1.0 + p[leResonance] * 4));
  lp.init(3500 * keytrack(b.note, 60, 0.7) * (0.8 + 0.4 * b.vel), 1.0 + p[leResonance] * 4, nullptr, &qb);
  makeEnv({p[leAttack], 0, 1, p[leRelease], 0}, b.t);
  freq = f;
  track(saw.frequency(), f, 1);
  track(sub.frequency(), f * 0.5, 0.5);
  trackPeriod(periodG.gain(), f, 1);
}

void LeadVoice::render(const VoiceIn &in, float *l, float *r) {
  const XIn &x = xin(in);
  const std::size_t n = in.n;
  float sw[kQuantum], tmp[kQuantum], vib[kQuantum], det[kQuantum], per[kQuantum];
  const bool active = srcActive(0, in.frame0, in.sr, n) || srcActive(1, in.frame0, in.sr, n);
  if (active) {
    std::memcpy(vib, x.vib ? x.vib : x.zeros, n * sizeof(float));
    gain1(vibG, vib, in);
    for (std::size_t i = 0; i < n; ++i) det[i] = in.bend[i] + vib[i];
  }
  runOsc(0, saw, in, sw, nullptr, active ? det : in.bend);
  std::memcpy(per, x.duty ? x.duty : x.zeros, n * sizeof(float));
  gain1(periodG, per, in);
  dl.process(sw, tmp, 0.0f, per);
  std::memcpy(sumL_, sw, n * sizeof(float));  // sum <- saw, inv(dl), subG
  for (std::size_t i = 0; i < n; ++i) sumL_[i] += tmp[i] * -1.0f;
  runOsc(1, sub, in, tmp, nullptr, active ? det : in.bend);
  gain1(subG, tmp, in);
  addTo(sumL_, tmp, n);
  mulc(sumL_, n, 0.4f);
  float *ch[1] = {sumL_};
  lp.process(ch, 1, in);
  envOut(in, l, r, 1);
}

// ---- juno-pad (389-411) ----------------------------------------------------------------------------------------

JunoVoice::JunoVoice(const XBuild &b) : XVoice(b.note, b.t, (0.55 + 0.45 * b.vel) * keyLevel(b.note)) {
  using namespace xk;
  const double *p = b.p;
  const double f = noteToFreq(b.note);
  xosc(*this, saw, b.bank.saw[pick(b)].get(), f, 0, b.t);
  periodG.gain().setValue(1 / f);  // pwmPulse(inst, v, saw, f, 0.32)
  double mx = pwmMaxDelay(f);
  if (XDelay::lengthFor(mx, b.sr) > b.delayCap) mx = static_cast<double>(b.delayCap - XDelay::kQ - 1) / b.sr;
  dl.attach(b.delayBuf, mx, b.sr);
  xosc(*this, sub, b.xb.square[pick(b)].get(), f / 2, 0, b.t);
  subG.gain().setValue(p[jSub] * 0.35);
  hpf.init(wa::BiquadType::Highpass, 60, butter2Q(), nullptr, nullptr, nullptr, false);
  qb.setValue(qDb(0.8 + p[jResonance] * 4));
  lp.init(2200 * keytrack(b.note, 60, 0.5) * (0.75 + 0.5 * b.vel), 0.8 + p[jResonance] * 4, nullptr, &qb);
  makeEnv({p[jAttack], p[jDecay], p[jSustain], p[jRelease], 0}, b.t);
  freq = f;
  track(saw.frequency(), f, 1);
  track(sub.frequency(), f * 0.5, 0.5);
  trackPeriod(periodG.gain(), f, 1);
}

void JunoVoice::render(const VoiceIn &in, float *l, float *r) {
  const XIn &x = xin(in);
  const std::size_t n = in.n;
  float sw[kQuantum], tmp[kQuantum], per[kQuantum];
  runOsc(0, saw, in, sw, nullptr, in.bend);
  std::memcpy(per, x.duty ? x.duty : x.zeros, n * sizeof(float));
  gain1(periodG, per, in);
  dl.process(sw, tmp, 0.0f, per);
  std::memcpy(sumL_, sw, n * sizeof(float));
  for (std::size_t i = 0; i < n; ++i) sumL_[i] += tmp[i] * -1.0f;
  runOsc(1, sub, in, tmp, nullptr, in.bend);
  gain1(subG, tmp, in);
  addTo(sumL_, tmp, n);
  mulc(sumL_, n, 0.32f);
  float *ch[1] = {sumL_};
  hpf.process(ch, 1, n, in.frame0, in.sr, 0);
  lp.process(ch, 1, in);
  envOut(in, l, r, 1);
}

// ---- supersaw-pad (342-372) ------------------------------------------------------------------------------------

SupersawVoice::SupersawVoice(const XBuild &b) : XVoice(b.note, b.t, (0.55 + 0.45 * b.vel) * keyLevel(b.note)) {
  using namespace xk;
  const double *p = b.p;
  const double f = noteToFreq(b.note);
  for (int i = 0; i < 7; ++i) jit[i] = kOffs[i] == 0 ? 0 : b.rng.range(-1.5, 1.5);
  for (int i = 0; i < 7; ++i) xosc(*this, saw[i], b.bank.saw[pick(b)].get(), f, kOffs[i] * p[ssDetune] + jit[i], b.t);
  hpf.init(wa::BiquadType::Highpass, 100, butter2Q(), nullptr, nullptr, nullptr, false);
  const double fc = 3000 * keytrack(b.note, 60, 0.5) * (0.75 + 0.5 * b.vel);
  qb.setValue(qDb(1.31 + p[ssResonance] * 4.7));
  lp.init(fc, 1.31 + p[ssResonance] * 4.7, nullptr, &qb);
  xosc(*this, sub, b.bank.basicSine.get(), f / 2, 0, b.t);
  subG.gain().setValue(p[ssSub] * 0.5);
  makeEnv({p[ssAttack], p[ssDecay], p[ssSustain], p[ssRelease], 0}, b.t);
  freq = f;
  for (auto &s : saw) track(s.frequency(), f, 1);
  track(sub.frequency(), f * 0.5, 0.5);
}

void SupersawVoice::render(const VoiceIn &in, float *l, float *r) {
  const std::size_t n = in.n;
  float tmp[kQuantum];
  zero(sumL_, n);
  zero(sumR_, n);
  for (int i = 0; i < 7; ++i) {
    runOsc(static_cast<unsigned>(i), saw[i], in, tmp, nullptr, in.bend);
    if (kSides[i] != 1) addTo(sumL_, tmp, n);
    if (kSides[i] != 0) addTo(sumR_, tmp, n);
  }
  mulc(sumL_, n, 0.19f);
  mulc(sumR_, n, 0.19f);
  float *ch[2] = {sumL_, sumR_};
  hpf.process(ch, 2, n, in.frame0, in.sr, 0);
  runOsc(7, sub, in, tmp, nullptr, in.bend);  // l1 input: subG (connected first) + hpf
  gain1(subG, tmp, in);
  for (std::size_t i = 0; i < n; ++i) {
    sumL_[i] = tmp[i] + sumL_[i];
    sumR_[i] = tmp[i] + sumR_[i];
  }
  lp.process(ch, 2, in);
  envOut(in, l, r, 2);
}

// ---- shimmer-pad (497-540) -------------------------------------------------------------------------------------

ShimmerVoice::ShimmerVoice(const XBuild &bc) : XVoice(bc.note, bc.t, (0.55 + 0.45 * bc.vel) * keyLevel(bc.note)) {
  using namespace xk;
  const double *p = bc.p;
  const double f = noteToFreq(bc.note);
  const auto &ws = bc.xb.shimmer;
  xosc(*this, c, ws[pick(bc)].get(), f, 0, bc.t);
  xosc(*this, a, ws[pick(bc)].get(), f, -p[shDetune], bc.t);
  xosc(*this, b, ws[pick(bc)].get(), f, 0.6 * p[shDetune], bc.t);
  pa = ConstPan(-0.6);
  pb = ConstPan(0.6);
  xosc(*this, oct, ws[pick(bc)].get(), 2 * f, 0, bc.t);
  wa::setNow(octEnv.gain(), 0, bc.t);
  wa::linearTo(octEnv.gain(), 1, bc.t, p[shBloomTime], 0);
  hpf.init(wa::BiquadType::Highpass, 150, butter2Q(), nullptr, nullptr, nullptr, false);
  lpf.init(wa::BiquadType::Lowpass, 7000 * keytrack(bc.note, 60, 0.3) * (0.8 + 0.4 * bc.vel), qDb(0.6));
  makeEnv({p[shAttack], p[shDecay], p[shSustain], p[shRelease], 0}, bc.t);
  bloom = p[shBloomTime];
  freq = f;
  track(c.frequency(), f, 1);
  track(a.frequency(), f, 1);
  track(b.frequency(), f, 1);
  track(oct.frequency(), 2 * f, 2);
}

double ShimmerVoice::onRelease(double rt, double envR, double) {
  // freeze the octave fade-in where it is: a still-rising bloom must not swell a releasing note
  wa::setNow(octEnv.gain(), clampd((rt - startedAt_) / bloom, 0, 1), rt);
  return envRelease(rt, envR);
}

void ShimmerVoice::render(const VoiceIn &in, float *l, float *r) {
  const XIn &x = xin(in);
  const std::size_t n = in.n;
  float tmp[kQuantum], sL[kQuantum] = {}, sR[kQuantum] = {};
  runOsc(0, c, in, sumL_, nullptr, in.bend);  // sum <- c (mono), sideG (stereo), octLvl (mono)
  std::memcpy(sumR_, sumL_, n * sizeof(float));
  runOsc(1, a, in, tmp, nullptr, in.bend);
  pa.addTo(tmp, sL, sR, n);
  runOsc(2, b, in, tmp, nullptr, in.bend);
  pb.addTo(tmp, sL, sR, n);
  mulc(sL, n, 0.45f);
  mulc(sR, n, 0.45f);
  addTo(sumL_, sL, n);
  addTo(sumR_, sR, n);
  runOsc(3, oct, in, tmp, nullptr, in.bend);
  gain1(octEnv, tmp, in);
  connGain(octLvl.gain(), x.oct ? x.oct : x.zeros, tmp, in);
  addTo(sumL_, tmp, n);
  addTo(sumR_, tmp, n);
  mulc(sumL_, n, 0.3f);
  mulc(sumR_, n, 0.3f);
  float *ch[2] = {sumL_, sumR_};
  hpf.process(ch, 2, n, in.frame0, in.sr, 0);
  lpf.process(ch, 2, n, in.frame0, in.sr, in.filterDet);
  envOut(in, l, r, 2);
}

// ---- dx-epiano (617-683) ---------------------------------------------------------------------------------------
// Three FM stacks: carrier (sine) + cosine-phase modulator (fmModWave) through modG (deviation) and brightG (gain 0 +
// the shared brightness signal) into the carrier's a-rate frequency. Stacks start on a render-quantum boundary
// `tb` up to 7 quanta early (blockStart - rng.int(0, 7) quanta, never before now); the envelope starts at t.

DxVoice::DxVoice(const XBuild &b) : XVoice(b.note, b.t, 0) {
  using namespace xk;
  const double *p = b.p;
  const double f = noteToFreq(b.note);
  const double i1v = 0.3 + 1.4 * b.vel * b.vel;
  const double q = 128 / b.sr;
  const double bs = std::max(b.now, std::floor(b.t / q + 1e-9) * q);  // blockStart(ctx, t)
  const double tb = std::max(b.now, bs - b.rng.integer(0, 7) * q);
  auto stack = [&](Stack &s, double det, double ratio, double dev0) {
    xosc(*this, s.car, b.bank.basicSine.get(), f, det, tb);  // rot = 0: 'sine'
    const double fm = f * ratio * js::pow(2, det / 1200);
    const double adv = ratio == 1 ? (js::kPi * fm) / b.sr : 0;
    xosc(*this, s.mod, b.xb.fmModFor(ratio * 0 + adv), f * ratio, det, tb);
    s.modG.gain().setValue(dev0);
  };
  stack(A, 0, 1, i1v * f);
  stack(B, p[dxDetune], 1, i1v * f);
  for (Stack *s : {&A, &B}) {
    wa::setNow(s->modG.gain(), i1v * f, b.t);
    wa::rampTo(s->modG.gain(), 0.3 * i1v * f, b.t, 0.9);
  }
  outG.gain().setValue((0.2 + 0.8 * b.vel) * 0.5 * keyLevel(b.note + 12));
  const double fT = 14 * f;
  const double capI = (0.45 * b.sr - f) / fT - 1.5;
  const double iT = std::min((0.35 + 1.9 * b.vel) * p[dxTine], capI / std::max(1e-3, b.dxTine));
  track(A.car.frequency(), f, 1);
  track(A.mod.frequency(), f, 1);
  track(B.car.frequency(), f, 1);
  track(B.mod.frequency(), f, 1);
  if (iT > 0.02) {
    hasTine = true;
    const double hi = clampd((0.4 * b.sr - fT) / (0.15 * b.sr), 0, 1);
    const double dev = iT * fT;
    stack(T, 0, 14, dev);
    wa::setNow(T.modG.gain(), dev, b.t);
    wa::rampTo(T.modG.gain(), 0, b.t, 0.045);
    const double tauT = 0.45 * keytrack(b.note, 60, -0.5);
    wa::setNow(tEnv.gain(), 0, b.t);
    wa::linearTo(tEnv.gain(), 0.7 * hi, b.t, 0.001, 0);
    wa::rampTo(tEnv.gain(), 0, b.t + 0.001, tauT);
    stopSrc(4, b.t + 8 * tauT);  // -70 dB: saves CPU on long notes
    stopSrc(5, b.t + 8 * tauT);
    track(T.car.frequency(), f, 1);
    track(T.mod.frequency(), f * 14, 14);
  }
  const double ampTau = clampd(2.6 * js::pow(0.7 / 2.6, (b.note - 48) / 36.0), 0.3, 6);
  makeEnv({0.001, 0, 0, p[dxRelease], ampTau * p[dxDecay]}, b.t);
  i1 = i1v;
  freq = f;
}

void DxVoice::render(const VoiceIn &in, float *l, float *r) {
  const XIn &x = xin(in);
  const std::size_t n = in.n;
  float mod[kQuantum], car[kQuantum];
  auto runStack = [&](Stack &s, unsigned ci, const float *bright, float *out) {
    runOsc(ci + 1, s.mod, in, mod, nullptr, in.bend);
    gain1(s.modG, mod, in);
    connGain(s.brightG.gain(), bright ? bright : x.zeros, mod, in);
    runOsc(ci, s.car, in, out, mod, in.bend);
  };
  runStack(A, 0, x.bright, sumL_);
  runStack(B, 2, x.bright, car);
  gain1(bG, car, in);
  addTo(sumL_, car, n);
  if (hasTine) {
    runStack(T, 4, x.tine, car);
    gain1(tEnv, car, in);
    addTo(sumL_, car, n);
  }
  envOut(in, l, r, 1);
}

}  // namespace rig::inst
