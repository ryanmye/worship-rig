// T15 building blocks (inst/synth_extra_dsp.h). Chromium 157.0.8103.78 biquad_dsp_kernel.cc / biquad_processor.cc
// (UpdateCoefficientsIfNecessary, CheckForDirtyCoefficients, NormalizeFrequency) and delay.cc / delay_sse2.cc (via
// T05's kernel), BSD-3 (The Chromium Authors; third_party/chromium/LICENSE). JS math goes through rig::js.
#include "inst/synth_extra_dsp.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <mutex>
#include <vector>

#include "num/js_math.h"

namespace rig::inst {

// ---- ceiling ---------------------------------------------------------------------------------------------------

const float *extraCeilingCurve() {
  static const std::vector<float> c = [] {
    const std::size_t N = kExtraCeilingPoints;
    std::vector<float> v(N);
    const double k = js::pow(10, -3.0 / 20), mx = js::pow(10, -1.0 / 20);
    const double room = mx - k;
    for (std::size_t i = 0; i < N; ++i) {
      const double s = ((static_cast<double>(i) / static_cast<double>(N - 1)) * 2 - 1) * kExtraCeilRange;
      const double a = std::fabs(s);
      const double sg = s > 0 ? 1.0 : (s < 0 ? -1.0 : 0.0);  // Math.sign
      v[i] = static_cast<float>(sg * (a <= k ? a : k + room * js::tanh((a - k) / room)));
    }
    v[(N - 1) / 2] = 0;
    return v;
  }();
  return c.data();
}

// ---- XFilter ---------------------------------------------------------------------------------------------------

void XFilter::init(wa::BiquadType type, double freqHz, double q, wa::Param *freq, wa::Param *qParam,
                   wa::Param *detune, bool linked) {
  type_ = type;
  freq_ = static_cast<float>(freqHz);
  q_ = static_cast<float>(q);
  fp_ = freq;
  qp_ = qParam;
  dp_ = detune;
  linked_ = linked;
  dirty_ = true;
  channels_ = 0;
  k_[0].reset();
  k_[1].reset();
}

wa::BiquadCoeffs XFilter::coeffs(std::int64_t frame0, double sr, float detuneIn) {
  const double nyquist = 0.5 * static_cast<double>(static_cast<float>(sr));
  float f = fp_ ? fp_->processKRate(frame0, sr) : freq_;  // FinalValue, clipped to the param range [0, nyquist]
  f = f < 0 ? 0 : (f > static_cast<float>(nyquist) ? static_cast<float>(nyquist) : f);
  const float q = qp_ ? qp_->processKRate(frame0, sr) : q_;
  constexpr float kDetMax = 153600.0f;
  float det = (dp_ ? dp_->processKRate(frame0, sr) : 0.0f) + detuneIn;
  det = det < -kDetMax ? -kDetMax : (det > kDetMax ? kDetMax : det);
  double nf = f / nyquist;
  if (det != 0.0f) nf = nf * static_cast<double>(std::exp2(det / 1200.0f));
  last_[0] = f;
  last_[1] = q;
  last_[2] = det;
  return wa::biquadCoeffsNormalized(type_, nf, q, 0.0);
}

void XFilter::process(float *const *ch, unsigned nch, std::size_t n, std::int64_t frame0, double sr,
                      float detuneIn) {
  nch = nch >= 2 ? 2u : 1u;
  if (nch != channels_) {  // CheckNumberOfChannelsForInput: fresh kernels (has_just_reset_)
    k_[0].reset();
    k_[1].reset();
    channels_ = nch;
    dirty_ = true;
  }
  const bool sa = linked_ || (fp_ && fp_->hasSampleAccurateValues(frame0, sr)) ||
                  (qp_ && qp_->hasSampleAccurateValues(frame0, sr)) ||
                  (dp_ && dp_->hasSampleAccurateValues(frame0, sr));
  if (sa) {
    for (unsigned c = 0; c < nch; ++c) {
      if (c == 0 || perKernel) k_[c].set(coeffs(frame0, sr, detuneIn));
      else k_[c].set(k_[0].coeffs());
      k_[c].process(ch[c], ch[c], n);
    }
    return;
  }
  // CheckForDirtyCoefficients: FinalValue() compare (constant params here, so one evaluation is exact)
  const float f = fp_ ? fp_->processKRate(frame0, sr) : freq_;
  const float q = qp_ ? qp_->processKRate(frame0, sr) : q_;
  const float d = dp_ ? dp_->processKRate(frame0, sr) : 0.0f;
  if (dirty_ || f != last_[0] || q != last_[1] || d != last_[2]) {
    const double nyquist = 0.5 * static_cast<double>(static_cast<float>(sr));
    const float fc = f < 0 ? 0 : (f > static_cast<float>(nyquist) ? static_cast<float>(nyquist) : f);
    double nf = fc / nyquist;
    if (d != 0.0f) nf = nf * static_cast<double>(std::exp2(d / 1200.0f));
    const wa::BiquadCoeffs co = wa::biquadCoeffsNormalized(type_, nf, q, 0.0);
    for (auto &k : k_) k.set(co);
    last_[0] = f;
    last_[1] = q;
    last_[2] = d;
    dirty_ = false;
  }
  for (unsigned c = 0; c < nch; ++c) k_[c].process(ch[c], ch[c], n);
}

// ---- XDelay ----------------------------------------------------------------------------------------------------

std::size_t XDelay::lengthFor(double maxDelaySec, double sr) {
  const float r = static_cast<float>(sr);
  const double frame = std::round(maxDelaySec * static_cast<double>(r) * 1024.0) / 1024.0;
  return kQ + static_cast<std::size_t>(std::ceil(frame));
}

void XDelay::attach(float *buf, double maxDelaySec, double sr) {
  buf_ = buf;
  sr_ = static_cast<float>(sr);
  max_ = maxDelaySec;
  len_ = lengthFor(maxDelaySec, sr);
  w_ = 0;
  std::memset(buf_, 0, len_ * sizeof(float));
}

void XDelay::process(const float *in, float *out, float delay, const float *delayIn) {
  // AudioParam CalculateFinalValues (a-rate, no events): intrinsic + connections, NaN -> default, clip [0, max]
  float dt[kQ];
  const float hi = static_cast<float>(max_);
  for (std::size_t i = 0; i < kQ; ++i) {
    float v = delayIn ? delay + delayIn[i] : delay;
    if (delayIn && std::isnan(v)) v = delay;
    dt[i] = std::min(std::max(v, 0.0f), hi);
  }
  const std::size_t first = std::min(kQ, len_ - w_);  // CopyToCircularBuffer before any read
  std::memcpy(buf_ + w_, in, first * sizeof(float));
  if (first < kQ) std::memcpy(buf_, in + first, (kQ - first) * sizeof(float));
  const float lenF = static_cast<float>(len_);
  const long len = static_cast<long>(len_);
  for (std::size_t i = 0; i < kQ; ++i) {  // ProcessARateVector (SSE2 float read position), as fx/delay_node.cpp
    long wi = static_cast<long>(w_ + i);
    if (wi >= len) wi -= len;
    const float desired = std::max(dt[i], 0.0f) * sr_;
    float rp = static_cast<float>(wi) + (lenF - desired);
    if (rp >= lenF) rp -= lenF;
    long i1 = static_cast<long>(rp);
    if (i1 >= len) i1 -= len;
    long i2 = i1 + 1;
    if (i2 >= len) i2 -= len;
    const float fr = rp - static_cast<float>(i1);
    const float s1 = buf_[static_cast<std::size_t>(i1)], s2 = buf_[static_cast<std::size_t>(i2)];
    out[i] = s1 + fr * (s2 - s1);
  }
  w_ += kQ;
  if (w_ >= len_) w_ -= len_;
}

// ---- wavetables ------------------------------------------------------------------------------------------------

void rotatedWaves(std::array<std::unique_ptr<wa::PeriodicWave>, kRotations> &out, const double *sin, std::size_t h1,
                  double sr, bool disableNormalization) {
  std::vector<float> re(h1), im(h1);
  for (unsigned i = 0; i < kRotations; ++i) {
    const double th = (2 * js::kPi * i) / kRotations;
    re[0] = im[0] = 0;
    for (std::size_t h = 1; h < h1; ++h) {
      re[h] = static_cast<float>(sin[h] * js::sin(static_cast<double>(h) * th));
      im[h] = static_cast<float>(sin[h] * js::cos(static_cast<double>(h) * th));
    }
    out[i].reset(wa::PeriodicWave::create(re.data(), im.data(), h1, disableNormalization, sr));
  }
}

const wa::PeriodicWave *mapTable(const wa::PeriodicWave *w, const WaveBank &ob, const XWaveBank &ox,
                                 const WaveArray *od, const WaveBank &nb, const XWaveBank &nx, const WaveArray *nd) {
  auto inArr = [&](const WaveArray &o, const WaveArray &n, const wa::PeriodicWave *&out) {
    for (std::size_t i = 0; i < o.size(); ++i)
      if (o[i].get() == w) {
        out = n[i].get();
        return true;
      }
    return false;
  };
  const wa::PeriodicWave *r = nullptr;
  if (inArr(ob.saw, nb.saw, r) || inArr(ob.glass, nb.glass, r) || inArr(ob.sine, nb.sine, r) ||
      inArr(ob.tri, nb.tri, r) || inArr(ox.square, nx.square, r) || inArr(ox.shimmer, nx.shimmer, r))
    return r ? r : w;
  if (od && nd && inArr(*od, *nd, r)) return r ? r : w;
  for (std::size_t i = 0; i < ox.fmAdv.size(); ++i)
    if (ox.fmAdv[i].get() == w && nx.fmAdv[i]) return nx.fmAdv[i].get();
  if (w == ob.basicSine.get()) return nb.basicSine.get();
  if (w == ob.basicTriangle.get()) return nb.basicTriangle.get();
  if (w == ox.cosine.get()) return nx.cosine.get();
  if (w == ox.rotorCos.get()) return nx.rotorCos.get();
  return w;
}

wa::PeriodicWave *fmModWave(double adv, double sr) {
  const double k = js::round(adv / 0.002);
  const double e = k * 0.002;
  const float re[2] = {0, static_cast<float>(js::cos(e))}, im[2] = {0, static_cast<float>(-js::sin(e))};
  return wa::PeriodicWave::create(re, im, 2, false, sr);
}

namespace {
double f32(double x) {
  return static_cast<double>(static_cast<float>(x));
}
std::mutex g_mu;
std::vector<std::shared_ptr<XWaveBank>> g_banks;
}  // namespace

XWaveBank::~XWaveBank() = default;

const wa::PeriodicWave *XWaveBank::fmModFor(double adv) const {
  if (!fmAdv[0]) return cosine.get();
  const double k = std::floor(adv / kFmAdvStep + 0.5);
  const unsigned i = k <= 0 ? 0u : (k >= kFmAdvSteps - 1 ? kFmAdvSteps - 1 : static_cast<unsigned>(k));
  return fmAdv[i].get();
}

std::shared_ptr<const XWaveBank> XWaveBank::get(double sampleRate, bool squares, bool shimmer, bool dx) {
  // CORE3: built OUTSIDE the mutex, as WaveBank::get (inst/synth_dsp.cpp): a song switch never waits for a
  // utility-priority neighbour prebuild that is building a bank; two threads may both build, with the same tables.
  auto covers = [sampleRate](const XWaveBank &b, bool sq, bool sh, bool fm) {
    return b.sampleRate == sampleRate && (!sq || b.square[0]) && (!sh || b.shimmer[0]) && (!fm || b.fmAdv[0]);
  };
  bool wantSq = squares, wantSh = shimmer, wantDx = dx;
  {
    std::lock_guard<std::mutex> lock(g_mu);
    for (auto it = g_banks.rbegin(); it != g_banks.rend(); ++it)
      if (covers(**it, squares, shimmer, dx)) return *it;
    for (const auto &b : g_banks)
      if (b->sampleRate == sampleRate) {
        wantSq = wantSq || b->square[0] != nullptr;
        wantSh = wantSh || b->shimmer[0] != nullptr;
        wantDx = wantDx || b->fmAdv[0] != nullptr;
      }
  }
  auto bank = std::make_shared<XWaveBank>();
  bank->sampleRate = sampleRate;
  if (wantSq) {  // squareWaves: Float32Array(512), odd k: 4 / (pi k)
    std::vector<double> s(512, 0.0);
    for (int k = 1; k <= 511; k += 2) s[static_cast<std::size_t>(k)] = f32(4 / (js::kPi * k));
    rotatedWaves(bank->square, s.data(), s.size(), sampleRate);
  }
  if (wantSh) {  // shimmer-pad waves(): Float32Array(49), triangle odd k + 0.28 at 2, 0.1 at 4
    std::vector<double> s(49, 0.0);
    for (int k = 1; k <= 48; k += 2) s[static_cast<std::size_t>(k)] = f32((((k - 1) / 2) % 2 ? -1.0 : 1.0) / (k * k));
    s[2] = f32(s[2] + 0.28);
    s[4] = f32(s[4] + 0.1);
    rotatedWaves(bank->shimmer, s.data(), s.size(), sampleRate);
  }
  bank->cosine.reset(fmModWave(0, sampleRate));
  if (wantDx)
    for (unsigned k = 0; k < kFmAdvSteps; ++k) bank->fmAdv[k].reset(fmModWave(k * kFmAdvStep, sampleRate));
  {
    const float re[2] = {0, 1}, im[2] = {0, 0};
    bank->rotorCos.reset(wa::PeriodicWave::create(re, im, 2, true, sampleRate));
  }
  std::lock_guard<std::mutex> lock(g_mu);
  for (auto it = g_banks.rbegin(); it != g_banks.rend(); ++it)  // another thread finished a bank that covers ours
    if (covers(**it, wantSq, wantSh, wantDx)) return *it;
  for (auto it = g_banks.begin(); it != g_banks.end();)  // ours covers every same-rate bank it replaces
    it = covers(*bank, (*it)->square[0] != nullptr, (*it)->shimmer[0] != nullptr, (*it)->fmAdv[0] != nullptr) &&
                 (*it)->sampleRate == sampleRate
             ? g_banks.erase(it)
             : std::next(it);
  g_banks.push_back(bank);
  while (g_banks.size() > 2) g_banks.erase(g_banks.begin());
  return bank;
}

}  // namespace rig::inst
