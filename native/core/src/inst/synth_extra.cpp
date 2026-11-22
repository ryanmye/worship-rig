// SynthExtraInstrument (inst/synth_extra.h): synth-extra.js SynthExtraInstrument + IMPL[*].init / apply / morph /
// glide and the shared helpers (initFilterMod, buildChorus, initOut). Line references: app/js/engine/synth-extra.js.
#include "inst/synth_extra.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>
#include <vector>

#include "inst/synth.h"
#include "inst/synth_dispatch.h"
#include "model/patch.h"
#include "num/js_math.h"
#include "time/automation.h"

namespace rig::inst {

using namespace xk;

namespace {

constexpr double kLn10 = 2.302585092994046;

/** buildChorus (285-318): mono in, L = dry + wA·delayA, R = dry + wB·delayB, anti-phase triangle LFO. */
struct XChorus {
  wa::Gain dry{1.0}, wA{0.0}, wB{0.0}, modA{0.0}, modB{0.0};
  wa::Oscillator lfo{nullptr};
  std::vector<float> bufA, bufB;
  XDelay dA, dB;
  void init(const WaveBank &bank, double rate, double sr) {
    lfo.setWave(bank.basicTriangle.get());
    lfo.frequency().setValue(rate);
    lfo.start(0);
    const std::size_t len = XDelay::lengthFor(0.02, sr);
    bufA.assign(len, 0.0f);
    bufB.assign(len, 0.0f);
    dA.attach(bufA.data(), 0.02, sr);
    dB.attach(bufB.data(), 0.02, sr);
  }
  void set(double amount, double t) {
    const double c = clampd(amount, 0, 1);
    const double depth = (0.4 + 1.6 * c) / 1000;  // +- seconds around 3.5 ms
    const double w = 0.8 * c;
    wa::rampTo(modA.gain(), depth, t, 0.03);
    wa::rampTo(modB.gain(), -depth, t, 0.03);
    wa::rampTo(wA.gain(), w, t, 0.03);
    wa::rampTo(wB.gain(), w, t, 0.03);
    wa::rampTo(dry.gain(), 1 / (1 + 0.45 * w), t, 0.03);  // keeps the summed level roughly constant
  }
  /** x (mono) -> l, r. */
  void process(const float *x, float *l, float *r, std::int64_t f0, double sr) {
    constexpr std::size_t n = kQuantum;
    float lf[n], ma[n], mb[n], da[n], db[n], d[n];
    lfo.process(f0, sr, lf, n);
    std::memcpy(ma, lf, sizeof lf);
    std::memcpy(mb, lf, sizeof lf);
    float *c1[1] = {ma}, *c2[1] = {mb};
    modA.process(c1, c1, 1, n, f0, sr);
    modB.process(c2, c2, 1, n, f0, sr);
    dA.process(x, da, 0.0035f, ma);
    dB.process(x, db, 0.0035f, mb);
    std::memcpy(d, x, sizeof d);
    float *cd[1] = {d}, *ca[1] = {da}, *cb[1] = {db};
    dry.process(cd, cd, 1, n, f0, sr);
    wA.process(ca, ca, 1, n, f0, sr);
    wB.process(cb, cb, 1, n, f0, sr);
    for (std::size_t i = 0; i < n; ++i) {
      l[i] = d[i] + da[i];
      r[i] = d[i] + db[i];
    }
  }
};

}  // namespace

/** Instrument-level nodes (InstrumentBase.bus + IMPL.init). Built on the control thread. */
struct XShared {
  wa::ConstantSource filterCS{0.0}, dutyCS{0.5}, octCS{0.0}, brightCS{0.0}, tineCS{0.0};
  bool hasFilterMod = false;
  double filterBase = 0, filterMorphCents = 0;
  wa::Oscillator pwmLfo{nullptr}, vibLfo{nullptr}, tremLfoL{nullptr}, tremLfoR{nullptr};
  wa::Gain pwmG{1.0}, vibD{1.0}, tremGL{1.0}, tremGR{1.0}, tremDL{1.0}, tremDR{1.0};
  wa::Gain msA[2] = {wa::Gain(1.0), wa::Gain(1.0)}, msB[2] = {wa::Gain(1.0), wa::Gain(1.0)};
  XChorus chorus;
  bool hasChorus = false;
  wa::BiquadFilter dcBlock{wa::BiquadType::Highpass, 20, 0, 0};
  wa::Gain pre{1.0}, post{1.0};
  std::unique_ptr<wa::WaveShaper> shaper;
  wa::BiquadFilter lpf{wa::BiquadType::Lowpass, 6000, 0, 0};
  wa::Gain trimG{1.0};
  std::unique_ptr<wa::WaveShaper> ceil;
  unsigned headCh = 1;
  float regTrim = 1;
  alignas(16) float fcs[kQuantum], duty[kQuantum], tmp[kQuantum], vib[kQuantum], oct[kQuantum], bright[kQuantum],
      tine[kQuantum];
};

// ---- construction ----------------------------------------------------------------------------------------------

SynthExtraInstrument::SynthExtraInstrument(const XPatchDef &patch, double sampleRate, std::uint32_t engineSeed,
                                           std::string_view rngName, std::string_view paramsJson,
                                           double releaseOverride)
    : XHost(sampleRate, engineSeed, rngName, releaseOverride, true, patch.params, patch.nParams),
      patch_(patch),
      sh_(std::make_unique<XShared>()) {
  resolveParamsJson(patch_.params, patch_.nParams, paramsJson, params_);
  const XPatch id = patch_.id;
  bank_ = WaveBank::get(sr_, kWaveSaw | kWaveBasic);  // phaseRotatedSawWaves(ctx, 8), built-in sine / triangle
  xbank_ = XWaveBank::get(sr_, id != XPatch::ShimmerPad, id == XPatch::ShimmerPad, id == XPatch::DxEpiano);
  XShared &s = *sh_;
  const double *p = params_;
  auto filterMod = [&](double base, double morphCents) {  // initFilterMod
    s.hasFilterMod = true;
    s.filterBase = base;
    s.filterMorphCents = morphCents;
    s.filterCS.offset().setValue(filterOffsetCents());
    s.filterCS.start(0);
  };
  s.dcBlock.reinit(wa::BiquadType::Highpass, 20, butter2Q(), 0);
  s.headCh = 1;
  switch (id) {
    case XPatch::SupersawPad:
      filterMod(3000, 2400);
      setWidth(0);
      s.headCh = 2;
      break;
    case XPatch::JunoPad:
      filterMod(2200, 1200);
      s.dutyCS.start(0);
      s.pwmLfo.setWave(bank_->basicSine.get());
      s.pwmLfo.frequency().setValue(p[jPwmRate]);
      s.pwmLfo.start(0);
      s.pwmG.gain().setValue(p[jPwmDepth] * 0.42);
      s.chorus.init(*bank_, p[jChorusRate], sr_);
      s.hasChorus = true;
      setChorus(clampd(p[jChorus] + 0.4 * morphX_, 0, 1), 0);
      s.headCh = 2;
      break;
    case XPatch::ShimmerPad: {
      filterMod(7000, 0);
      s.octCS.offset().setValue(clampd(p[shOctave] + morphX_, 0, 1) * 0.7);
      s.octCS.start(0);
      const double d = p[shTremDepth] * 0.5;
      s.tremGL.gain().setValue(1 - d);
      s.tremGR.gain().setValue(1 - d);
      s.tremLfoL.setWave(bank_->basicSine.get());
      s.tremLfoL.frequency().setValue(p[shTremRate]);
      s.tremLfoL.start(0);
      s.tremLfoR.setWave(xbank_->cosine.get());
      s.tremLfoR.frequency().setValue(p[shTremRate]);
      s.tremLfoR.start(0);
      s.tremDL.gain().setValue(d);
      s.tremDR.gain().setValue(d);
      s.headCh = 2;
      break;
    }
    case XPatch::DxEpiano:
      s.brightCS.offset().setValue(p[dxTone] * (1 + 0.4 * morphX_));
      s.brightCS.start(0);
      s.tineCS.offset().setValue(p[dxTone] * (1 + 1.5 * morphX_));
      s.tineCS.start(0);
      s.chorus.init(*bank_, 0.7, sr_);
      s.hasChorus = true;
      setChorus(p[dxChorus], 0);
      s.headCh = 2;
      break;
    case XPatch::Pluck: filterMod(4500, 0); break;
    case XPatch::PolyStab:
      filterMod(900, 0);
      s.headCh = 2;
      break;
    case XPatch::AnalogBrass:
      filterMod(700, 0);
      s.vibLfo.setWave(bank_->basicSine.get());
      s.vibLfo.frequency().setValue(p[brVibRate]);
      s.vibLfo.start(0);
      s.vibD.gain().setValue(p[brVibDepth]);
      s.headCh = 2;
      break;
    case XPatch::SquareLead:
      filterMod(3500, 1200);
      s.dutyCS.offset().setValue(0.5 - 0.4 * clampd(p[lePwm] + 0.6 * morphX_, 0, 1));
      s.dutyCS.start(0);
      s.vibLfo.setWave(bank_->basicSine.get());
      s.vibLfo.frequency().setValue(p[leVibRate]);
      s.vibLfo.start(0);
      s.vibD.gain().setValue(p[leVibDepth]);
      break;
    case XPatch::Sub808:
      s.shaper = std::make_unique<wa::WaveShaper>(softClipCurve12(), kSoftClipPoints, wa::WaveShaper::Oversample::None,
                                                  1);
      s.lpf.reinit(wa::BiquadType::Lowpass, 6000, butter2Q(), 0);
      setDrive808(0);
      break;
    case XPatch::SynthBass: filterMod(320, 2400); break;
    default: break;
  }
  // initOut: head -> trimG (level * gainTrim / CEIL_RANGE) -> ceiling -> output (2 channels, explicit)
  s.trimG.gain().setValue((patch_.level * js::pow(10, patch_.gainTrim / 20)) / kExtraCeilRange);
  s.ceil = std::make_unique<wa::WaveShaper>(extraCeilingCurve(), kExtraCeilingPoints, wa::WaveShaper::Oversample::None,
                                            s.headCh);
  s.regTrim = static_cast<float>(js::pow(10, patch_.trimDb / 20));
  if (id == XPatch::JunoPad || id == XPatch::SquareLead) {
    // one PWM DelayNode buffer per pool slot, sized for MIDI note 0 at this rate (never touched until used)
    delayStride_ = (XDelay::lengthFor(pwmMaxDelay(noteToFreq(0)), sr_) + 15) / 16 * 16;
    delayArena_.reset(new float[delayStride_ * kPoolCap]);
  }
}

SynthExtraInstrument::~SynthExtraInstrument() = default;

float *SynthExtraInstrument::delayBuffer(int slot) {
  return delayArena_ ? delayArena_.get() + delayStride_ * static_cast<std::size_t>(slot) : nullptr;
}

// ---- helpers -----------------------------------------------------------------------------------------------

double SynthExtraInstrument::filterOffsetCents() const {
  const XShared &s = *sh_;
  const int ci = xParamIndex(patch_, "cutoff");
  const double c = ci >= 0 ? params_[ci] : s.filterBase;  // inst.params.cutoff ?? inst.filterBase
  return cents(c / s.filterBase) + morphX_ * s.filterMorphCents;
}

void SynthExtraInstrument::updateFilterMod(double t) {
  if (sh_->hasFilterMod) wa::rampTo(sh_->filterCS.offset(), filterOffsetCents(), t);
}

void SynthExtraInstrument::setChorus(double amount, double t) {
  sh_->chorus.set(amount, t);
}

void SynthExtraInstrument::setWidth(double t) {
  const double w = clampd(params_[ssWidth] + 0.4 * morphX_, 0, 1);
  for (auto &g : sh_->msA) wa::rampTo(g.gain(), (1 + w) / 2, t, 0.02);
  for (auto &g : sh_->msB) wa::rampTo(g.gain(), (1 - w) / 2, t, 0.02);
}

void SynthExtraInstrument::setDrive808(double t) {
  const double G = js::pow(10, 12.0 / 20);
  const double d = clampd(params_[suDrive] + morphX_, 0, 1);
  const double k = 0.3 + 5.7 * js::pow(d, 1.5);  // input scale into tanh(G x) / tanh(G): clean -> growling
  wa::rampTo(sh_->pre.gain(), k / G, t, 0.02);
  wa::rampTo(sh_->post.gain(), (js::tanh(G) / k) * (1 + 1.6 * d), t, 0.02);  // partial level compensation
}

double SynthExtraInstrument::q2Poly() const {
  return 0.9 + clampd(params_[poResonance] + 0.45 * morphX_, 0, 1) * 5;
}

void SynthExtraInstrument::redecayPluck(double t) {
  // held notes continue their decay at the new rate from wherever they are (released ones keep releasing)
  pool_.forEach([&](int slot, XVoice &v) {
    if (!held(slot) || !(t > v.startedAt() + 0.002)) return;  // env.attackEnd = t + max(.002, a)
    const double dk = params_[plDecay] * js::pow(2, -(v.note() - 60) / 36.0) * (1 + 1.5 * morphX_);
    wa::rampTo(v.envG.gain(), 0, t, dk / kLn10);
  });
}

void SynthExtraInstrument::resustainBrass(double t) {
  pool_.forEach([&](int slot, XVoice &xv) {
    auto &v = static_cast<BrassVoice &>(xv);
    if (!held(slot) || t < v.attackEnd) return;
    const double c = clampd(params_[brEnvAmount] + 0.45 * morphX_, 0, 1.4) * 3600 * (0.6 + 0.4 * v.vel) * 0.35;
    wa::rampTo(v.da, c, t, 0.05);
    wa::rampTo(v.db, c, t, 0.05);
  });
}

// ---- voices ------------------------------------------------------------------------------------------------

double SynthExtraInstrument::releaseParam() const {
  const int ri = xParamIndex(patch_, "release");
  return ri >= 0 ? params_[ri] : 0.3;
}

void SynthExtraInstrument::buildVoice(int note, double vel, double t) {
  XBuild b{*bank_, *xbank_, rng_, params_, sr_, t, vel, morphX_, static_cast<double>(nextFrame_) / sr_, note,
           nullptr, delayStride_};
  int slot = -1;
  switch (patch_.id) {
    case XPatch::SupersawPad: slot = emplaceVoice<SupersawVoice>(note, t, b); break;
    case XPatch::JunoPad: slot = emplaceVoice<JunoVoice>(note, t, b); break;
    case XPatch::ShimmerPad: slot = emplaceVoice<ShimmerVoice>(note, t, b); break;
    case XPatch::DxEpiano:
      b.dxTine = params_[dxTone] * (1 + 1.5 * morphX_);
      slot = emplaceVoice<DxVoice>(note, t, b);
      break;
    case XPatch::Pluck: slot = emplaceVoice<PluckVoice>(note, t, b); break;
    case XPatch::PolyStab:
      b.q2 = q2Poly();
      b.envCents = clampd(params_[poEnvAmount] + 0.5 * morphX_, 0, 1.4) * 3600 * (0.5 + 0.5 * vel);
      slot = emplaceVoice<PolyVoice>(note, t, b);
      break;
    case XPatch::AnalogBrass:
      b.envCents = clampd(params_[brEnvAmount] + 0.45 * morphX_, 0, 1.4) * 3600 * (0.6 + 0.4 * vel);
      slot = emplaceVoice<BrassVoice>(note, t, b);
      break;
    case XPatch::SquareLead: slot = emplaceVoice<LeadVoice>(note, t, b); break;
    case XPatch::Sub808: slot = emplaceVoice<Sub808Voice>(note, t, b); break;
    case XPatch::SynthBass: slot = emplaceVoice<BassVoice>(note, t, b); break;
    default: break;
  }
  if (slot < 0) return;
  if (patch_.id == XPatch::JunoPad) {
    auto &v = static_cast<JunoVoice &>(pool_.voice(slot));
    v.dl.attachFitting(delayBuffer(slot), delayStride_, pwmMaxDelay(v.freq), sr_);
  } else if (patch_.id == XPatch::SquareLead) {
    auto &v = static_cast<LeadVoice &>(pool_.voice(slot));
    v.dl.attachFitting(delayBuffer(slot), delayStride_, pwmMaxDelay(v.freq), sr_);
  }
}

void SynthExtraInstrument::voiceDestroyed(int) {}

void SynthExtraInstrument::glide(XVoice &v, int note, double t) {
  const int gi = xParamIndex(patch_, "glide");
  const double dur = gi >= 0 ? params_[gi] : 0.03;  // inst.params.glide ?? 0.03
  v.glidePitched(note, t, dur);
  if (patch_.id == XPatch::DxEpiano) {
    auto &d = static_cast<DxVoice &>(v);
    for (wa::Gain *g : {&d.A.modG, &d.B.modG}) wa::rampTo(g->gain(), 0.3 * d.i1 * d.freq, t, 0.05);
  }
}

// ---- params / morph ----------------------------------------------------------------------------------------

void SynthExtraInstrument::applyParam(std::uint32_t key, double val, double t) {
  XShared &s = *sh_;
  auto each = [&](auto &&fn) { forVoices([&](int, XVoice &v) { fn(v); }); };
  switch (patch_.id) {
    case XPatch::SupersawPad:
      if (key == ssCutoff) updateFilterMod(t);
      else if (key == ssWidth) setWidth(t);
      else if (key == ssResonance) each([&](XVoice &v) {
        wa::rampTo(static_cast<SupersawVoice &>(v).qb, qDb(1.31 + val * 4.7), t);
      });
      else if (key == ssSub) each([&](XVoice &v) { wa::rampTo(static_cast<SupersawVoice &>(v).subG.gain(), val * 0.5, t); });
      else if (key == ssDetune) each([&](XVoice &xv) {
        auto &v = static_cast<SupersawVoice &>(xv);
        for (int i = 0; i < 7; ++i) wa::rampTo(v.saw[i].detune(), SupersawVoice::kOffs[i] * val + v.jit[i], t);
      });
      break;
    case XPatch::JunoPad:
      if (key == jCutoff) updateFilterMod(t);
      else if (key == jPwmRate) wa::rampTo(s.pwmLfo.frequency(), val, t);
      else if (key == jPwmDepth) wa::rampTo(s.pwmG.gain(), val * 0.42, t);
      else if (key == jChorus) setChorus(clampd(params_[jChorus] + 0.4 * morphX_, 0, 1), t);
      else if (key == jChorusRate) wa::rampTo(s.chorus.lfo.frequency(), val, t);
      else if (key == jResonance) each([&](XVoice &v) { wa::rampTo(static_cast<JunoVoice &>(v).qb, qDb(0.8 + val * 4), t); });
      else if (key == jSub) each([&](XVoice &v) { wa::rampTo(static_cast<JunoVoice &>(v).subG.gain(), val * 0.35, t); });
      break;
    case XPatch::ShimmerPad:
      if (key == shCutoff) updateFilterMod(t);
      else if (key == shOctave) wa::rampTo(s.octCS.offset(), clampd(params_[shOctave] + morphX_, 0, 1) * 0.7, t, 0.05);
      else if (key == shTremRate) {
        wa::rampTo(s.tremLfoL.frequency(), val, t);
        wa::rampTo(s.tremLfoR.frequency(), val, t);
      } else if (key == shTremDepth) {
        for (wa::Gain *g : {&s.tremGL, &s.tremGR}) wa::rampTo(g->gain(), 1 - val * 0.5, t);
        for (wa::Gain *g : {&s.tremDL, &s.tremDR}) wa::rampTo(g->gain(), val * 0.5, t);
      } else if (key == shDetune) each([&](XVoice &xv) {
        auto &v = static_cast<ShimmerVoice &>(xv);
        wa::rampTo(v.a.detune(), -val, t);
        wa::rampTo(v.b.detune(), 0.6 * val, t);
      });
      break;
    case XPatch::DxEpiano:
      if (key == dxTone) onMorph(t);
      else if (key == dxChorus) setChorus(val, t);
      else if (key == dxDetune) each([&](XVoice &xv) {
        auto &v = static_cast<DxVoice &>(xv);
        wa::rampTo(v.B.car.detune(), val, t);
        wa::rampTo(v.B.mod.detune(), val, t);
      });
      break;
    case XPatch::Pluck:
      if (key == plCutoff) updateFilterMod(t);
      else if (key == plSquare) each([&](XVoice &v) { wa::rampTo(static_cast<PluckVoice &>(v).sqG.gain(), val * 0.6, t); });
      else if (key == plResonance) each([&](XVoice &v) { wa::rampTo(static_cast<PluckVoice &>(v).qb, qDb(1.0 + val * 4), t); });
      else if (key == plDecay) redecayPluck(t);
      break;
    case XPatch::PolyStab:
      if (key == poCutoff) updateFilterMod(t);
      else if (key == poResonance) each([&](XVoice &v) { wa::rampTo(static_cast<PolyVoice &>(v).qb, qDb(q2Poly()), t); });
      else if (key == poDetune) each([&](XVoice &xv) {
        auto &v = static_cast<PolyVoice &>(xv);
        wa::rampTo(v.s1.detune(), -val, t);
        wa::rampTo(v.s2.detune(), val, t);
      });
      break;
    case XPatch::AnalogBrass:
      if (key == brCutoff) updateFilterMod(t);
      else if (key == brVibRate) wa::rampTo(s.vibLfo.frequency(), val, t);
      else if (key == brVibDepth) wa::rampTo(s.vibD.gain(), val, t);
      else if (key == brEnvAmount) resustainBrass(t);
      else if (key == brDetune) each([&](XVoice &xv) {
        auto &v = static_cast<BrassVoice &>(xv);
        wa::rampTo(v.saw[1].detune(), -val, t);
        wa::rampTo(v.saw[2].detune(), val, t);
      });
      break;
    case XPatch::SquareLead:
      if (key == leCutoff) updateFilterMod(t);
      else if (key == lePwm) wa::rampTo(s.dutyCS.offset(), 0.5 - 0.4 * clampd(params_[lePwm] + 0.6 * morphX_, 0, 1), t);
      else if (key == leSub) each([&](XVoice &v) { wa::rampTo(static_cast<LeadVoice &>(v).subG.gain(), val * 0.4, t); });
      else if (key == leResonance) each([&](XVoice &v) { wa::rampTo(static_cast<LeadVoice &>(v).qb, qDb(1.0 + val * 4), t); });
      else if (key == leVibRate) wa::rampTo(s.vibLfo.frequency(), val, t);
      else if (key == leVibDepth) wa::rampTo(s.vibD.gain(), val, t);
      break;
    case XPatch::Sub808:
      if (key == suDrive) setDrive808(t);
      break;
    case XPatch::SynthBass:
      if (key == baCutoff) updateFilterMod(t);
      else if (key == baSquare) each([&](XVoice &v) { wa::rampTo(static_cast<BassVoice &>(v).sqG.gain(), val, t); });
      else if (key == baResonance) each([&](XVoice &v) { wa::rampTo(static_cast<BassVoice &>(v).qb, qDb(0.9 + val * 4), t); });
      break;
    default: break;
  }
}

void SynthExtraInstrument::onMorph(double t) {
  XShared &s = *sh_;
  switch (patch_.id) {
    case XPatch::SupersawPad:
      updateFilterMod(t);
      setWidth(t);
      break;
    case XPatch::JunoPad:
      updateFilterMod(t);
      setChorus(clampd(params_[jChorus] + 0.4 * morphX_, 0, 1), t);
      break;
    case XPatch::ShimmerPad:
      wa::rampTo(s.octCS.offset(), clampd(params_[shOctave] + morphX_, 0, 1) * 0.7, t, 0.05);
      break;
    case XPatch::DxEpiano:
      wa::rampTo(s.brightCS.offset(), params_[dxTone] * (1 + 0.4 * morphX_), t);
      wa::rampTo(s.tineCS.offset(), params_[dxTone] * (1 + 1.5 * morphX_), t);
      break;
    case XPatch::Pluck: redecayPluck(t); break;
    case XPatch::PolyStab:
      forVoices([&](int, XVoice &v) { wa::rampTo(static_cast<PolyVoice &>(v).qb, qDb(q2Poly()), t); });
      break;
    case XPatch::AnalogBrass: resustainBrass(t); break;
    case XPatch::SquareLead:
      updateFilterMod(t);
      wa::rampTo(s.dutyCS.offset(), 0.5 - 0.4 * clampd(params_[lePwm] + 0.6 * morphX_, 0, 1), t);
      break;
    case XPatch::Sub808: setDrive808(t); break;
    case XPatch::SynthBass: updateFilterMod(t); break;
    default: break;
  }
}

void SynthExtraInstrument::applyModule(const Command &c) {
  const auto op = static_cast<std::uint16_t>(c.op);
  applyCommon(op, static_cast<std::uint16_t>(SynthOp::Morph), static_cast<std::uint16_t>(SynthOp::ReleaseOverride), c);
}

// ---- rendering ---------------------------------------------------------------------------------------------

void SynthExtraInstrument::sharedPass(XIn &in) {
  XShared &s = *sh_;
  const std::size_t n = in.n;
  const std::int64_t f0 = in.frame0;
  const double sr = in.sr;
  if (s.hasFilterMod) {  // linkFilter: filterCS into every voice filter's k-rate detune (first frame)
    s.filterCS.process(f0, sr, s.fcs, n);
    in.filterDet = s.fcs[0];
  }
  switch (patch_.id) {
    case XPatch::JunoPad: {  // periodG input: dutyCS + pwmG(pwmLfo) (DelayNode params are always pulled)
      s.dutyCS.process(f0, sr, s.duty, n);
      s.pwmLfo.process(f0, sr, s.tmp, n);
      float *c[1] = {s.tmp};
      s.pwmG.process(c, c, 1, n, f0, sr);
      for (std::size_t i = 0; i < n; ++i) s.duty[i] = s.duty[i] + s.tmp[i];
      in.duty = s.duty;
      break;
    }
    case XPatch::SquareLead:
    case XPatch::AnalogBrass: {
      if (patch_.id == XPatch::SquareLead) {
        s.dutyCS.process(f0, sr, s.duty, n);
        in.duty = s.duty;
      }
      // the vibrato LFO only feeds oscillator detunes (through vibD -> each voice's vibG): pulled only while one of
      // those oscillators renders (T11 glass-pad rule)
      bool pulled = false;
      forVoices([&](int, XVoice &v) {
        for (unsigned i = 0; i < (patch_.id == XPatch::AnalogBrass ? 3u : 2u); ++i)
          pulled = pulled || v.srcActive(i, f0, sr, n);
      });
      if (pulled) {
        s.vibLfo.process(f0, sr, s.vib, n);
        float *c[1] = {s.vib};
        s.vibD.process(c, c, 1, n, f0, sr);
        in.vib = s.vib;
      }
      break;
    }
    case XPatch::ShimmerPad:
      s.octCS.process(f0, sr, s.oct, n);
      in.oct = s.oct;
      break;
    case XPatch::DxEpiano:
      s.brightCS.process(f0, sr, s.bright, n);
      s.tineCS.process(f0, sr, s.tine, n);
      in.bright = s.bright;
      in.tine = s.tine;
      break;
    default: break;
  }
}

void SynthExtraInstrument::postChain(const XIn &in, float *l, float *r, Bus &out) {
  XShared &s = *sh_;
  const std::size_t n = in.n;
  const std::int64_t f0 = in.frame0;
  const double sr = in.sr;
  float *ch[2] = {l, r};
  switch (patch_.id) {
    case XPatch::SupersawPad: {  // split -> M/S gains -> merge
      float a0[kQuantum], b0[kQuantum], a1[kQuantum], b1[kQuantum];
      std::memcpy(a0, l, n * sizeof(float));
      std::memcpy(b0, r, n * sizeof(float));
      std::memcpy(a1, r, n * sizeof(float));
      std::memcpy(b1, l, n * sizeof(float));
      float *c0[1] = {a0}, *c1[1] = {b0}, *c2[1] = {a1}, *c3[1] = {b1};
      s.msA[0].process(c0, c0, 1, n, f0, sr);
      s.msB[0].process(c1, c1, 1, n, f0, sr);
      s.msA[1].process(c2, c2, 1, n, f0, sr);
      s.msB[1].process(c3, c3, 1, n, f0, sr);
      for (std::size_t i = 0; i < n; ++i) {
        l[i] = a0[i] + b0[i];
        r[i] = a1[i] + b1[i];
      }
      break;
    }
    case XPatch::JunoPad: {
      float x[kQuantum];
      std::memcpy(x, l, n * sizeof(float));  // mono bus (mono voices)
      s.chorus.process(x, l, r, f0, sr);
      break;
    }
    case XPatch::DxEpiano: {
      float x[kQuantum];
      std::memcpy(x, l, n * sizeof(float));
      float *c[1] = {x};
      s.dcBlock.process(c, 1, n, f0, sr);
      s.chorus.process(x, l, r, f0, sr);
      break;
    }
    case XPatch::ShimmerPad: {  // split -> tremGL / tremGR (gain + LFO input) -> merge
      float lfoL[kQuantum], lfoR[kQuantum], g[kQuantum];
      s.tremLfoL.process(f0, sr, lfoL, n);
      s.tremLfoR.process(f0, sr, lfoR, n);
      float *cl[1] = {lfoL}, *cr[1] = {lfoR};
      s.tremDL.process(cl, cl, 1, n, f0, sr);
      s.tremDR.process(cr, cr, 1, n, f0, sr);
      s.tremGL.gain().processARate(f0, sr, g, n);
      for (std::size_t i = 0; i < n; ++i) l[i] *= g[i] + lfoL[i];
      s.tremGR.gain().processARate(f0, sr, g, n);
      for (std::size_t i = 0; i < n; ++i) r[i] *= g[i] + lfoR[i];
      break;
    }
    case XPatch::Sub808:
      s.pre.process(ch, ch, 1, n, f0, sr);
      s.shaper->process(ch, 1, n);
      s.post.process(ch, ch, 1, n, f0, sr);
      s.lpf.process(ch, 1, n, f0, sr);
      break;
    default: break;
  }
  const unsigned nch = s.headCh;
  s.trimG.process(ch, ch, nch, n, f0, sr);
  s.ceil->process(ch, nch, n);
  if (nch == 1) std::memcpy(r, l, n * sizeof(float));  // output: channelCount 2, explicit ('speakers' up-mix)
  if (s.regTrim != 1.0f)
    for (std::size_t i = 0; i < n; ++i) {
      l[i] *= s.regTrim;
      r[i] *= s.regTrim;
    }
  out.channels = 2;
  std::memcpy(out.ch[0], l, n * sizeof(float));
  std::memcpy(out.ch[1], r, n * sizeof(float));
}

// ---- factory -----------------------------------------------------------------------------------------------

Unit *makeSynthExtraUnit(const UnitEnv &env, const UnitSpec &spec) {
  if (!spec.patch || spec.channel < 0) return nullptr;
  const auto ch = static_cast<std::size_t>(spec.channel);
  if (ch >= sizeof(spec.patch->slots) / sizeof(spec.patch->slots[0])) return nullptr;
  const SlotPatch &sp = spec.patch->slots[ch];
  const XPatchDef *pd = findXPatch(sp.instId);
  if (!pd) return nullptr;
  const std::string name =
      "inst|" + std::to_string(spec.channel) + "|synth|" + sp.instId + "|" + std::to_string(spec.instSeq);
  const double rel = std::isfinite(sp.release) && sp.release > 0 ? sp.release : 0;
  return new SynthExtraInstrument(*pd, env.sampleRate, env.seed, name, sp.paramsJson, rel);
}

}  // namespace rig::inst
