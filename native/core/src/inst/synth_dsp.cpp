// synth.js / voice.js building blocks (inst/synth_dsp.h). Chromium 157.0.8103.78 semantics (BSD-3, The Chromium
// Authors; third_party/chromium/LICENSE): biquad_filter_handler.cc (Process, NormalizeFrequency), stereo_panner.cc
// (PanToTargetValue, mono input). JS arithmetic mirrors app/js/engine/voice.js and synth.js expression by expression.
#include "inst/synth_dsp.h"

#include <cmath>
#include <mutex>

#include "num/js_math.h"

namespace rig::inst {

// ---- scalar helpers ------------------------------------------------------------------------------------------------

double noteToFreq(double midi) {
  return 440 * js::pow(2, (midi - 69) / 12);
}
double keytrack(double note, double ref, double amount) {
  return js::pow(2, (amount * (note - ref)) / 12);
}
double keyLevel(int note) {
  return note > 60 ? js::pow(10, (-3.0 * (note - 60)) / 12 / 20) : 1;
}
double qDb(double q) {
  return 20 * js::log10(q);
}
double butter2Q() {
  static const double v = qDb(js::kSqrt1_2);
  return v;
}
double butter4Q(int stage) {
  static const double v0 = qDb(0.5412), v1 = qDb(1.3066);
  return stage == 0 ? v0 : v1;
}
double cents(double ratio) {
  return 1200 * js::log2(ratio);
}
double fmIndexCap(double sr, double f, double fm, double extraHz, double edge) {
  if (!(fm > 0)) return INFINITY;
  const double v = (edge * sr - f - extraHz) / fm - 1.5;  // FM_MARGIN
  return v > 0 ? v : 0;
}

namespace {

std::vector<float> makeSoftClip(double driveDb) {
  const double g = js::pow(10, driveDb / 20);
  const std::size_t n = kSoftClipPoints;
  std::vector<float> c(n);
  const double norm = js::tanh(g);
  for (std::size_t i = 0; i < n; ++i) {
    const double x = (static_cast<double>(i) / static_cast<double>(n - 1)) * 2 - 1;
    c[i] = static_cast<float>(js::tanh(g * x) / norm);
  }
  c[(n - 1) / 2] = 0;
  return c;
}

std::vector<float> makeCeiling(double ceilDb, double kneeDb, double range) {
  const double c = js::pow(10, ceilDb / 20), k = js::pow(10, kneeDb / 20);
  const std::size_t n = kCeilingPoints;
  std::vector<float> curve(n);
  for (std::size_t i = 0; i < n; ++i) {
    const double x = range * ((static_cast<double>(i) / static_cast<double>(n - 1)) * 2 - 1);
    const double a = std::fabs(x);
    const double y = a <= k ? a : k + (c - k) * js::tanh((a - k) / (c - k));
    const double sg = x > 0 ? 1.0 : (x < 0 ? -1.0 : 0.0);  // Math.sign
    curve[i] = static_cast<float>(sg * y);
  }
  curve[(n - 1) / 2] = 0;
  return curve;
}

}  // namespace

const float *softClipCurve12() {
  static const std::vector<float> c = makeSoftClip(12);
  return c.data();
}
const float *softCeilingCurve() {
  static const std::vector<float> c = makeCeiling(-1, -4, 4);
  return c.data();
}

// ---- wavetables ----------------------------------------------------------------------------------------------------

namespace {

/** voice.js rotatedWaves(ctx, key, sin, n): sin[h] (already rounded like the JS array type) rotated by 2 pi i / n. */
void rotated(std::array<std::unique_ptr<wa::PeriodicWave>, kRotations> &out, const std::vector<double> &sin,
             double sr) {
  const std::size_t h1 = sin.size();  // H + 1
  std::vector<float> re(h1), im(h1);
  for (unsigned i = 0; i < kRotations; ++i) {
    const double th = (2 * js::kPi * i) / kRotations;
    re[0] = im[0] = 0;
    for (std::size_t h = 1; h < h1; ++h) {
      re[h] = static_cast<float>(sin[h] * js::sin(static_cast<double>(h) * th));
      im[h] = static_cast<float>(sin[h] * js::cos(static_cast<double>(h) * th));
    }
    out[i].reset(wa::PeriodicWave::create(re.data(), im.data(), h1, false, sr));
  }
}

double f32(double x) {
  return static_cast<double>(static_cast<float>(x));
}

void build(WaveBank &b, unsigned fam) {
  const double sr = b.sampleRate;
  if (fam & kWaveSaw) {  // Float32Array(513): (-1)^(k+1) 2 / (pi k)
    std::vector<double> s(513, 0.0);
    for (int k = 1; k <= 512; ++k) s[k] = f32(((k % 2 ? 1 : -1) * 2) / (js::kPi * k));
    rotated(b.saw, s, sr);
  }
  if (fam & (kWaveGlass | kWaveTri)) {
    std::vector<double> tri(64, 0.0);  // Float32Array(64): odd k, alternating 1 / k^2
    for (int k = 1; k <= 63; k += 2) tri[k] = f32((((k - 1) / 2) % 2 ? -1.0 : 1.0) / (k * k));
    if (fam & kWaveTri) rotated(b.tri, tri, sr);
    if (fam & kWaveGlass) {
      std::vector<double> g = tri;
      g[2] = f32(0.5);
      g[3] = f32(-0.2);
      rotated(b.glass, g, sr);
    }
  }
  if (fam & kWaveSine) rotated(b.sine, std::vector<double>{0.0, 1.0}, sr);  // a plain JS array: doubles
  if (fam & kWaveBasic) {
    b.basicSine.reset(wa::PeriodicWave::basic(wa::PeriodicWave::Basic::Sine, sr));
    b.basicTriangle.reset(wa::PeriodicWave::basic(wa::PeriodicWave::Basic::Triangle, sr));
  }
  b.families |= fam;
}

std::mutex g_bankMu;
std::vector<std::shared_ptr<WaveBank>> g_banks;  // newest last

}  // namespace

WaveBank::~WaveBank() = default;

std::shared_ptr<const WaveBank> WaveBank::get(double sampleRate, unsigned families) {
  std::lock_guard<std::mutex> lock(g_bankMu);
  for (auto it = g_banks.rbegin(); it != g_banks.rend(); ++it) {
    if ((*it)->sampleRate == sampleRate && ((*it)->families & families) == families) return *it;
  }
  unsigned want = families;
  for (const auto &b : g_banks)
    if (b->sampleRate == sampleRate) want |= b->families;  // grow: the new bank replaces the smaller one
  auto bank = std::make_shared<WaveBank>();
  bank->sampleRate = sampleRate;
  build(*bank, want);
  for (auto it = g_banks.begin(); it != g_banks.end();)
    it = (*it)->sampleRate == sampleRate ? g_banks.erase(it) : std::next(it);
  g_banks.push_back(bank);
  while (g_banks.size() > 2) g_banks.erase(g_banks.begin());  // keep the two most recent rates
  return bank;
}

void WaveBank::trim() {
  std::lock_guard<std::mutex> lock(g_bankMu);
  for (auto it = g_banks.begin(); it != g_banks.end();) it = it->use_count() == 1 ? g_banks.erase(it) : std::next(it);
}

// ---- nodes ---------------------------------------------------------------------------------------------------------

ConstPan::ConstPan(double pan) {
  constexpr double kPiOverTwoDouble = 1.5707963267948966;
  float target = static_cast<float>(pan);
  target = target < -1.0f ? -1.0f : (target > 1.0f ? 1.0f : target);
  const double r = (target * 0.5 + 0.5) * kPiOverTwoDouble;
  gl = static_cast<float>(fdlibm::cos(r));
  gr = static_cast<float>(fdlibm::sin(r));
}

void VoiceFilter::init(wa::BiquadType type, double freqHz, double q, wa::Param *qParam) {
  type_ = type;
  freq_ = static_cast<float>(freqHz);
  q_ = static_cast<float>(q);
  qp_ = qParam;
  channels_ = 0;
  k_[0].reset();
  k_[1].reset();
}

void VoiceFilter::process(float *const *ch, unsigned nch, std::size_t n, std::int64_t frame0, double sr,
                          float detuneIn) {
  nch = nch >= 2 ? 2u : 1u;
  if (nch != channels_) {  // CheckNumberOfChannelsForInput: fresh kernels
    k_[0].reset();
    k_[1].reset();
    channels_ = nch;
  }
  const double nyquist = 0.5 * static_cast<double>(static_cast<float>(sr));
  float f = freq_;  // k-rate FinalValue, clipped to [0, nyquist]
  if (f < 0) f = 0;
  if (f > static_cast<float>(nyquist)) f = static_cast<float>(nyquist);
  constexpr float kDetMax = 153600.0f;
  float det = 0.0f + detuneIn;  // intrinsic 0 + first frame of the connections
  det = det < -kDetMax ? -kDetMax : (det > kDetMax ? kDetMax : det);
  double nf = f / nyquist;
  if (det != 0.0f) nf = nf * static_cast<double>(std::exp2(det / 1200.0f));
  float qv[kQuantum];
  bool varying = false;
  if (qp_) {
    qp_->processARate(frame0, sr, qv, n);
    for (std::size_t i = 1; i < n && !varying; ++i) varying = qv[i] != qv[0];
  } else {
    qv[0] = q_;
  }
  if (varying) {
    for (std::size_t i = 0; i < n; ++i) var_[i] = wa::biquadCoeffsNormalized(type_, nf, qv[i], 0.0);
    for (unsigned c = 0; c < nch; ++c) k_[c].processVarying(ch[c], ch[c], n, var_);
    return;
  }
  const wa::BiquadCoeffs co = wa::biquadCoeffsNormalized(type_, nf, qv[0], 0.0);
  for (unsigned c = 0; c < nch; ++c) {
    k_[c].set(co);
    k_[c].process(ch[c], ch[c], n);
  }
}

}  // namespace rig::inst
