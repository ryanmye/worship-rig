// OrganInstrument (inst/organ.h): app/js/engine/organ.js. Line references are organ.js.
#include "inst/organ.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>

#include "dsp/biquad.h"
#include "dsp/constant_source.h"
#include "dsp/waveshaper.h"
#include "model/patch.h"
#include "num/js_math.h"
#include "time/automation.h"

namespace rig::inst {

namespace {

constexpr unsigned kHarmonics[9] = {1, 3, 2, 4, 6, 8, 10, 12, 16};  // DRAWBAR_HARMONICS (relative to f/2)
constexpr const char *kFootages[9] = {"16′", "5⅓′", "8′", "4′", "2⅔′", "2′", "1⅗′", "1⅓′", "1′"};
constexpr double kVoiceGain = 0.1;
constexpr double kPercLevel = 0.9, kPercTau = 0.2;
constexpr double kHornTau = 0.3, kDrumTau = 1.5, kCrossover = 800, kHornDelay = 0.001, kHornDelayDepth = -0.00035;
constexpr double kSpeedHorn[2] = {0.8, 6.8}, kSpeedDrum[2] = {0.7, 5.9};  // [slow, fast]

struct Bars {
  ParamDef p[ok::kCount];
};
constexpr Bars presetParams(const char *bars, bool perc, double click, double drive, unsigned rotary, double rel) {
  Bars b{};
  for (unsigned i = 0; i < 9; ++i)
    b.p[i] = {i == 0 ? "drawbar1" : i == 1 ? "drawbar2" : i == 2 ? "drawbar3" : i == 3 ? "drawbar4" : i == 4 ? "drawbar5"
              : i == 5 ? "drawbar6" : i == 6 ? "drawbar7" : i == 7 ? "drawbar8" : "drawbar9",
              kFootages[i], 0, 8, static_cast<double>(bars[i] - '0'), "lin", "lin"};
  b.p[ok::kPercussion] = {"percussion", "Percussion", 0, 1, perc ? 1.0 : 0.0, "bool", "lin"};
  b.p[ok::kClick] = {"click", "Key click", 0, 1, click, "lin", "lin"};
  b.p[ok::kDrive] = {"drive", "Drive", 0, 1, drive, "lin", "lin"};
  b.p[ok::kRotary] = {"rotary", "Rotary", 0, 2, static_cast<double>(rotary), "enum", "lin"};
  b.p[ok::kRelease] = {"release", "Release", 0.01, 4, rel, "s", "log"};
  return b;
}
constexpr Bars kGospel = presetParams("888800000", true, 0.5, 0.35, ok::kFast, 0.08);
constexpr Bars kSoftPad = presetParams("008800000", false, 0.2, 0.1, ok::kSlow, 0.15);
constexpr Bars kFull = presetParams("888888888", false, 0.5, 0.5, ok::kSlow, 0.08);
constexpr Bars kChurch = presetParams("806000000", false, 0.1, 0, ok::kOff, 1.5);

const OrganPresetDef kPresets[] = {
    {OrganPreset::Gospel, "Gospel Organ", "gospel", kGospel.p, ok::kCount, 0.45, 4.4},
    {OrganPreset::SoftPad, "Soft Organ", "soft-pad", kSoftPad.p, ok::kCount, 0.55, 3.6},
    {OrganPreset::Full, "Full Organ", "full", kFull.p, ok::kCount, 0.45, 2.3},
    {OrganPreset::Church, "Church Organ", "church", kChurch.p, ok::kCount, 0.75, 6.1},
};

int rotaryEnum(std::size_t i, std::string_view s) {
  if (i != ok::kRotary) return -1;
  return s == "slow" ? 0 : s == "fast" ? 1 : s == "off" ? 2 : -1;
}

double drawbarAmp(double d) {
  return d != 0 ? js::pow(10, (-3 * (8 - d)) / 20) : 0;
}

}  // namespace

const OrganPresetDef &organPresetDef(OrganPreset id) {
  return kPresets[static_cast<std::size_t>(id)];
}

const OrganPresetDef *findOrganPreset(std::string_view id) {
  for (const OrganPresetDef &p : kPresets)
    if (id == p.idStr) return &p;
  return nullptr;
}

/** One rotor (_buildRotary rotor()): speed ConstantSource -> sin / cos oscillators (L / R mics). */
struct OrganRotor {
  wa::ConstantSource speed{0.0};
  wa::Oscillator sin{nullptr}, cos{nullptr};
  bool withDelay = false;
  std::vector<float> buf[2];
  XDelay dl[2];
  wa::Gain dg[2] = {wa::Gain(kHornDelayDepth), wa::Gain(kHornDelayDepth)};
  wa::Gain amG[2] = {wa::Gain(1.0), wa::Gain(1.0)}, amD[2] = {wa::Gain(1.0), wa::Gain(1.0)};

  void init(const WaveBank &bank, const XWaveBank &xb, double freq, double amDb, bool delay, double sr) {
    speed.offset().setValue(freq);
    speed.start(0);
    sin.setWave(bank.basicSine.get());
    sin.frequency().setValue(0);
    cos.setWave(xb.rotorCos.get());
    cos.frequency().setValue(0);
    sin.start(0);
    cos.start(0);
    withDelay = delay;
    const double g = js::pow(10, -amDb / 20);
    for (int c = 0; c < 2; ++c) {
      if (delay) {
        buf[c].assign(XDelay::lengthFor(0.01, sr), 0.0f);
        dl[c].attach(buf[c].data(), 0.01, sr);
      }
      amG[c].gain().setValue((1 + g) / 2);
      amD[c].gain().setValue((1 - g) / 2);
    }
  }
  /** x (mono, after the crossover) -> += merger L / R. */
  void process(const float *x, float *l, float *r, std::int64_t f0, double sr) {
    constexpr std::size_t n = kQuantum;
    float sp[n], lfo[2][n];
    speed.process(f0, sr, sp, n);
    sin.process(f0, sr, lfo[0], n, sp, nullptr);
    cos.process(f0, sr, lfo[1], n, sp, nullptr);
    for (int c = 0; c < 2; ++c) {
      float src[n], m[n], g[n];
      if (withDelay) {
        std::memcpy(m, lfo[c], sizeof m);
        float *cm[1] = {m};
        dg[c].process(cm, cm, 1, n, f0, sr);
        dl[c].process(x, src, static_cast<float>(kHornDelay), m);
      } else {
        std::memcpy(src, x, sizeof src);
      }
      std::memcpy(m, lfo[c], sizeof m);
      float *cm[1] = {m};
      amD[c].process(cm, cm, 1, n, f0, sr);
      amG[c].gain().processARate(f0, sr, g, n);
      float *out = c == 0 ? l : r;
      for (std::size_t i = 0; i < n; ++i) out[i] += src[i] * (g[i] + m[i]);
    }
  }
};

struct OrganShared {
  std::array<std::unique_ptr<wa::PeriodicWave>, kRotations> waves;  // drawbarWaves(ctx, bars)
  std::vector<float> clickData[4];
  SampleBuffer clicks[4];
  wa::BiquadFilter clickBpf{wa::BiquadType::Bandpass, 2830, 1.41, 0};
  wa::Gain clickG{1.0};
  wa::Gain pre{1.0}, post{1.0}, dryG{1.0}, rotG{1.0};
  std::unique_ptr<wa::WaveShaper> shaper;
  wa::BiquadFilter lo{wa::BiquadType::Lowpass, kCrossover, 0, 0}, hi{wa::BiquadType::Highpass, kCrossover, 0, 0};
  OrganRotor horn, drum;
  wa::Gain output{1.0}, ceilPre{0.25};
  std::unique_ptr<wa::WaveShaper> ceiling;
  float regTrim = 1;
  alignas(16) float click[kQuantum];
};

// ---- voice (_buildVoice 252-288) -------------------------------------------------------------------------------

OrganVoice::OrganVoice(const OrganBuild &b) : XVoice(b.note, b.t, kVoiceGain) {
  const double f = noteToFreq(b.note);
  rot = b.rot;
  o.setWave(b.waves[rot].get());  // one oscillator at f/2 (16' fundamental), random phase
  o.frequency().setValue(f / 2);
  o.setDetuneRate(wa::Param::Rate::KRate);
  addSource(&o, b.t, WaveKind::None, 0);
  if (b.percLevel > 0) {  // 3rd harmonic (2 2/3' = harmonic 6 of f/2; rotation 6 rot keeps it on the tonewheel)
    hasPerc = true;
    perc.setWave(b.bank.sine[(6 * rot) % 8].get());
    perc.frequency().setValue(3 * f);
    perc.setDetuneRate(wa::Param::Rate::KRate);
    addSource(&perc, b.t, WaveKind::Sine, (6 * rot) % 8);
    wa::setNow(pg.gain(), 0, b.t);
    wa::linearTo(pg.gain(), b.percLevel, b.t, 0.001, 0);
    wa::rampTo(pg.gain(), 0, b.t + 0.001, kPercTau);
    stopSource(1, b.t + kPercTau * 6.9 * 1.3);
  }
  if (b.click) {  // key click: 4 ms windowed noise -> shared BPF
    hasClick = true;
    click.setBuffer(b.click);
    addSource(&click, b.t, 0);
  }
  makeEnv({0.005, 0, 1, 0, 0}, b.t);
  freq = f;
  track(o.frequency(), f / 2, 0.5);
  if (hasPerc) track(perc.frequency(), 3 * f, 3);
}

void OrganVoice::render(const VoiceIn &in, float *l, float *r) {
  const XIn &x = static_cast<const XIn &>(in);
  const std::size_t n = in.n;
  float tmp[kQuantum];
  runOsc(0, o, in, sumL_, nullptr, in.bend);
  if (hasPerc) {
    runOsc(1, perc, in, tmp, nullptr, in.bend);
    float *c[1] = {tmp};
    pg.process(c, c, 1, n, in.frame0, in.sr);
    for (std::size_t i = 0; i < n; ++i) sumL_[i] += tmp[i];
  }
  if (hasClick && x.click) {
    float *c[1] = {tmp};
    click.process(in.frame0, in.sr, c, n);
    for (std::size_t i = 0; i < n; ++i) x.click[i] += tmp[i];
  }
  envOut(in, l, r, 1);
}

// ---- instrument ------------------------------------------------------------------------------------------------

OrganInstrument::OrganInstrument(const OrganPresetDef &preset, double sampleRate, std::uint32_t engineSeed,
                                 std::string_view rngName, std::string_view paramsJson, double releaseOverride)
    : XHost(sampleRate, engineSeed, rngName, releaseOverride, true, preset.params, preset.nParams),
      preset_(preset),
      sh_(std::make_unique<OrganShared>()) {
  resolveParamsJson(preset_.params, preset_.nParams, paramsJson, params_, &rotaryEnum);
  for (unsigned i = 0; i < 9; ++i) params_[i] = js::round(params_[i]);  // step 1
  bank_ = WaveBank::get(sr_, kWaveSine | kWaveBasic);
  xbank_ = XWaveBank::get(sr_, false, false);
  OrganShared &s = *sh_;
  {  // drawbarWaves(ctx, bars): Float32Array(17) amplitudes, 8 rotations, disableNormalization
    float amp[17] = {};
    for (unsigned i = 0; i < 9; ++i) amp[kHarmonics[i]] = static_cast<float>(amp[kHarmonics[i]] + drawbarAmp(params_[i]));
    double a[17];
    for (int h = 0; h < 17; ++h) a[h] = amp[h];
    rotatedWaves(s.waves, a, 17, sr_, true);
  }
  {  // clickBuffers(ctx, rng): 4 Hann-windowed noise bursts of 4 ms
    const double lenD = std::max(8.0, js::round(0.004 * sr_));
    const auto len = static_cast<std::size_t>(lenD);
    for (int k = 0; k < 4; ++k) {
      s.clickData[k].resize(len);
      for (std::size_t i = 0; i < len; ++i)
        s.clickData[k][i] = static_cast<float>((rng_.next() * 2 - 1) * 0.5 *
                                               (1 - js::cos((2 * js::kPi * static_cast<double>(i)) / (lenD - 1))));
      SampleBuffer &b = s.clicks[k];
      b.channels = 1;
      b.frames = len;
      b.sampleRate = sr_;
      b.f32[0] = s.clickData[k].data();
      b.bytes = len * sizeof(float);
    }
  }
  s.clickBpf.reinit(wa::BiquadType::Bandpass, 2830, 1.41, 0);
  s.clickG.gain().setValue(params_[ok::kClick] * 1.5);
  const double drive = params_[ok::kDrive];
  s.shaper = std::make_unique<wa::WaveShaper>(
      softClipCurve12(), kSoftClipPoints, drive > 0.5 ? wa::WaveShaper::Oversample::X2 : wa::WaveShaper::Oversample::None,
      1);
  setDrive(0);
  const bool off = static_cast<int>(params_[ok::kRotary]) == ok::kOff;
  s.dryG.gain().setValue(off ? 1 : 0);
  s.rotG.gain().setValue(off ? 0 : 1);
  s.lo.reinit(wa::BiquadType::Lowpass, kCrossover, butter2Q(), 0);
  s.hi.reinit(wa::BiquadType::Highpass, kCrossover, butter2Q(), 0);
  const int target = rotaryTarget();
  rotarySpeed_ = target >= 0 ? target : static_cast<int>(ok::kSlow);
  s.horn.init(*bank_, *xbank_, kSpeedHorn[rotarySpeed_], 3, true, sr_);
  s.drum.init(*bank_, *xbank_, kSpeedDrum[rotarySpeed_], 2, false, sr_);
  wa::setNow(s.output.gain(), preset_.presetTrim, 0);
  s.ceiling = std::make_unique<wa::WaveShaper>(softCeilingCurve(), kCeilingPoints, wa::WaveShaper::Oversample::None, 2);
  s.regTrim = static_cast<float>(js::pow(10, preset_.trimDb / 20));
}

OrganInstrument::~OrganInstrument() = default;

int OrganInstrument::rotaryTarget() const {
  const auto base = static_cast<int>(params_[ok::kRotary]);
  if (base != ok::kFast && base != ok::kSlow) return -1;
  if (!(morphX_ >= 0.5)) return base;
  return base == ok::kFast ? ok::kSlow : ok::kFast;
}

void OrganInstrument::setRotarySpeed(int speed, double t) {
  if (speed != ok::kFast && speed != ok::kSlow) return;
  rotarySpeed_ = speed;
  wa::rampTo(sh_->horn.speed.offset(), kSpeedHorn[speed], t, kHornTau);
  wa::rampTo(sh_->drum.speed.offset(), kSpeedDrum[speed], t, kDrumTau);
}

void OrganInstrument::setDrive(double t) {
  const double clipG = js::pow(10, 12.0 / 20);
  const double d = params_[ok::kDrive];
  const double k = 0.35 + 2.5 * d;  // input scale into tanh(4x)/tanh(4)
  wa::rampTo(sh_->pre.gain(), k / clipG, t, 0.02);
  wa::rampTo(sh_->post.gain(), (js::tanh(clipG) / k) * (1 - 0.3 * d), t, 0.02);
}

bool OrganInstrument::keyDownAt(double t) {
  bool down = false;
  pool_.forEach([&](int s, XVoice &) {
    const auto &m = pool_.meta(s);
    if ((m.state == VoiceState::Held || m.state == VoiceState::Released) && m.startedAt <= t && m.releasedAt > t)
      down = true;
  });
  return down;
}

double OrganInstrument::percLevel(double t) {
  if (!keyDownAt(t)) percT_ = t;
  const double dt = t - percT_;
  const double lv = dt >= 0 ? kPercLevel * js::exp(-dt / kPercTau) : 0;
  return lv > 2e-3 ? lv : 0;
}

void OrganInstrument::buildVoice(int note, double, double t) {
  OrganShared &s = *sh_;
  const auto rot = static_cast<unsigned>(rng_.integer(0, kRotations - 1));
  const double lv = params_[ok::kPercussion] != 0 ? percLevel(t) : 0;
  const SampleBuffer *click = nullptr;
  if (params_[ok::kClick] > 0) click = &s.clicks[rng_.pickIndex(4)];
  const OrganBuild b{s.waves, *bank_, t, lv, note, rot, click};
  emplaceVoice<OrganVoice>(note, t, b);
}

void OrganInstrument::glide(XVoice &v, int note, double t) {
  v.glidePitched(note, t, 0.01);  // TrackedParam glides of f/2 (and 3 f) over 10 ms
}

void OrganInstrument::applyParam(std::uint32_t key, double val, double t) {
  OrganShared &s = *sh_;
  if (key < 9) {
    params_[key] = js::round(val);
    // _scheduleWave: drawbarWaves() allocates PeriodicWaves, which the audio thread cannot do; the registration
    // takes effect when the instrument is rebuilt (T15 report: needs a control-side rebuild op)
  } else if (key == ok::kDrive) {
    setDrive(t);
  } else if (key == ok::kClick) {
    wa::rampTo(s.clickG.gain(), val * 1.5, t);
  } else if (key == ok::kRotary) {
    params_[key] = std::round(val);
    const bool on = static_cast<int>(params_[key]) != ok::kOff;
    wa::rampTo(s.dryG.gain(), on ? 0 : 1, t, 0.03);
    wa::rampTo(s.rotG.gain(), on ? 1 : 0, t, 0.03);
    if (on) setRotarySpeed(rotaryTarget(), t);
  }
}

void OrganInstrument::onMorph(double t) {
  const int sp = rotaryTarget();
  if (sp >= 0 && sp != rotarySpeed_) setRotarySpeed(sp, t);
}

void OrganInstrument::applyModule(const Command &c) {
  applyCommon(static_cast<std::uint16_t>(c.op), static_cast<std::uint16_t>(OrganOp::Morph),
              static_cast<std::uint16_t>(OrganOp::ReleaseOverride), c);
}

void OrganInstrument::sharedPass(XIn &in) {
  std::memset(sh_->click, 0, sizeof sh_->click);
  in.click = sh_->click;
}

void OrganInstrument::postChain(const XIn &in, float *l, float *r, Bus &out) {
  OrganShared &s = *sh_;
  const std::size_t n = in.n;
  const std::int64_t f0 = in.frame0;
  const double sr = in.sr;
  float *cc[1] = {s.click};
  s.clickBpf.process(cc, 1, n, f0, sr);
  s.clickG.process(cc, cc, 1, n, f0, sr);
  for (std::size_t i = 0; i < n; ++i) l[i] += s.click[i];  // bus <- voices + clickG
  float *ch[1] = {l};
  s.pre.process(ch, ch, 1, n, f0, sr);
  s.shaper->process(ch, 1, n);
  s.post.process(ch, ch, 1, n, f0, sr);
  float dry[kQuantum], rt[kQuantum], lo[kQuantum], hi[kQuantum], mL[kQuantum] = {}, mR[kQuantum] = {};
  std::memcpy(dry, l, n * sizeof(float));
  std::memcpy(rt, l, n * sizeof(float));
  float *cd[1] = {dry}, *cr[1] = {rt};
  s.dryG.process(cd, cd, 1, n, f0, sr);
  s.rotG.process(cr, cr, 1, n, f0, sr);
  std::memcpy(lo, rt, n * sizeof(float));
  std::memcpy(hi, rt, n * sizeof(float));
  float *cl[1] = {lo}, *ch2[1] = {hi};
  s.lo.process(cl, 1, n, f0, sr);
  s.hi.process(ch2, 1, n, f0, sr);
  s.horn.process(hi, mL, mR, f0, sr);
  s.drum.process(lo, mL, mR, f0, sr);
  for (std::size_t i = 0; i < n; ++i) {  // output <- dryG (mono, up-mixed) + merger
    l[i] = dry[i] + mL[i];
    r[i] = dry[i] + mR[i];
  }
  float *o2[2] = {l, r};
  s.output.process(o2, o2, 2, n, f0, sr);
  s.ceilPre.process(o2, o2, 2, n, f0, sr);
  s.ceiling->process(o2, 2, n);
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

Unit *makeOrgan(const UnitEnv &env, const UnitSpec &spec) {
  if (!spec.patch || spec.channel < 0) return nullptr;
  const auto ch = static_cast<std::size_t>(spec.channel);
  if (ch >= sizeof(spec.patch->slots) / sizeof(spec.patch->slots[0])) return nullptr;
  const SlotPatch &sp = spec.patch->slots[ch];
  const OrganPresetDef *pd = findOrganPreset(sp.instId);
  if (!pd) pd = &organPresetDef(OrganPreset::Gospel);  // organ.js: unknown preset -> gospel (warned)
  const std::string name =
      "inst|" + std::to_string(spec.channel) + "|organ|" + sp.instId + "|" + std::to_string(spec.instSeq);
  const double rel = std::isfinite(sp.release) && sp.release > 0 ? sp.release : 0;
  return new OrganInstrument(*pd, env.sampleRate, env.seed, name, sp.paramsJson, rel);
}

}  // namespace rig::inst
