// Oscillator: a port of Chromium 157.0.8103.78 third_party/blink/renderer/modules/webaudio/oscillator_handler.cc and
// the x86 kernels in cpu/x86/oscillator_kernel_sse2.cc (BSD-3, The Chromium Authors; third_party/chromium/LICENSE).
// The goldens are x86-64 renders, so the SSE2 lane arithmetic (float virtual index vector in the k-rate kernel,
// double lanes in the a-rate kernel, `x0 + f * (x1 - x0)` linear interpolation) is reproduced in portable scalar
// float/double code (no FMA contraction: the build sets -ffp-contract=off). Lagrange 3/5 point interpolation for
// increments below 0.3 table samples is the scalar DoInterpolation. exp2/log2 are the float libm functions
// Chromium calls (glibc 2.39 on the golden machine).
#include "dsp/oscillator.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "dsp/oscillator_schedule.h"

namespace rig::wa {

namespace {

constexpr float kInterpolate2Point = 0.3f;
constexpr float kInterpolate3Point = 0.16f;
constexpr std::size_t kMaxQ = 128;

float detuneToMultiplier(float cents) { return std::exp2(cents / 1200); }

float clampFrequency(float f, float nyquist) {
  if (std::isnan(f)) return nyquist;
  return f < -nyquist ? -nyquist : (f > nyquist ? nyquist : f);
}

inline double wrap(double v, double invN, unsigned N) { return v - std::floor(v * invN) * N; }

float doInterpolation(double vri, float incr, unsigned mask, float tf, const float *lo, const float *hi) {
  double sLower = 0, sHigher = 0;
  unsigned r0 = static_cast<unsigned>(vri);
  if (incr >= kInterpolate2Point) {
    unsigned r2 = r0 + 1;
    r0 &= mask;
    r2 &= mask;
    const float s1l = lo[r0], s2l = lo[r2], s1h = hi[r0], s2h = hi[r2];
    const double f = static_cast<double>(static_cast<float>(vri) - static_cast<float>(r0));
    sHigher = (1 - f) * s1h + f * s2h;
    sLower = (1 - f) * s1l + f * s2l;
  } else if (incr >= kInterpolate3Point) {
    unsigned ri[3];
    for (int k = -1; k <= 1; ++k) ri[k + 1] = (r0 + static_cast<unsigned>(k)) & mask;
    const double t = vri - r0;
    const double a[3] = {0.5 * t * (t - 1), 1 - t * t, 0.5 * t * (t + 1)};
    for (int k = 0; k < 3; ++k) {
      sLower += a[k] * lo[ri[k]];
      sHigher += a[k] * hi[ri[k]];
    }
  } else {
    unsigned ri[5];
    for (int k = -2; k <= 2; ++k) ri[k + 2] = (r0 + static_cast<unsigned>(k)) & mask;
    const double t = vri - r0, t2 = t * t;
    const double a[5] = {t * (t2 - 1) * (t - 2) / 24, -t * (t - 1) * (t2 - 4) / 6, (t2 - 1) * (t2 - 4) / 4,
                         -t * (t + 1) * (t2 - 4) / 6, t * (t2 - 1) * (t + 2) / 24};
    for (int k = 0; k < 5; ++k) {
      sLower += a[k] * lo[ri[k]];
      sHigher += a[k] * hi[ri[k]];
    }
  }
  return static_cast<float>((1 - tf) * sHigher + tf * sLower);
}

/** One float lane of the SSE2 WrapVirtualIndexVector: x - floor(x * inv) * size in float with int truncation. */
inline float wrapLaneF(float x, float size, float inv) {
  const float r = x * inv;
  int f = static_cast<int>(r);
  if (r < static_cast<float>(f)) f -= 1;
  return x - static_cast<float>(f) * size;
}
inline double wrapLaneD(double x, double size, double inv) {
  const double r = x * inv;
  int f = static_cast<int>(r);
  if (r < static_cast<double>(f)) f -= 1;
  return x - static_cast<double>(f) * size;
}

double processKRate(const PeriodicWave &w, std::size_t n, float *dest, double vri, float frequency) {
  const unsigned N = static_cast<unsigned>(w.tableSize());
  const double invN = 1.0 / N;
  const unsigned mask = N - 1;
  const float *lo = nullptr, *hi = nullptr;
  float tf = 0;
  w.tablesFor(frequency, lo, hi, tf);
  const float rateScale = w.rateScale();
  const float incr = frequency * rateScale;
  if (incr >= kInterpolate2Point) {
    double v = vri;
    std::size_t k = 0;
    {  // ProcessKRateVector (SSE2): four float lanes
      const float size = static_cast<float>(N), inv = 1.0f / static_cast<float>(N);
      float lane[4] = {static_cast<float>(v), static_cast<float>(v + static_cast<double>(1 * incr)),
                       static_cast<float>(v + static_cast<double>(2 * incr)),
                       static_cast<float>(v + static_cast<double>(3 * incr))};
      for (float &x : lane) x = wrapLaneF(x, size, inv);
      const float vIncr = 4 * incr;
      for (std::size_t loop = 0; loop < n / 4; ++loop, k += 4) {
        float s[4];
        for (int m = 0; m < 4; ++m) {
          const unsigned r0 = static_cast<unsigned>(static_cast<int>(lane[m])) & mask;
          const unsigned r1 = (r0 + 1) & mask;
          const float f = lane[m] - static_cast<float>(r0);
          const float sh = hi[r0] + f * (hi[r1] - hi[r0]);
          const float sl = lo[r0] + f * (lo[r1] - lo[r0]);
          s[m] = sh + tf * (sl - sh);
        }
        std::memcpy(dest + k, s, sizeof s);
        for (float &x : lane) x = wrapLaneF(x + vIncr, size, inv);
      }
      v += static_cast<double>(static_cast<float>(k) * incr);
      v = wrap(v, invN, N);
    }
    for (; k < n; ++k) {  // ProcessKRateScalar
      const unsigned r0 = static_cast<unsigned>(v) & mask;
      const unsigned r1 = (r0 + 1) & mask;
      const float f = static_cast<float>(v) - static_cast<float>(r0);
      const float sh = hi[r0] + f * (hi[r1] - hi[r0]);
      const float sl = lo[r0] + f * (lo[r1] - lo[r0]);
      dest[k] = sh + tf * (sl - sh);
      v += static_cast<double>(incr);
      v = wrap(v, invN, N);
    }
    vri += static_cast<double>(static_cast<float>(n) * incr);
    return wrap(vri, invN, N);
  }
  for (std::size_t k = 0; k < n; ++k) {
    dest[k] = doInterpolation(vri, std::fabs(incr), mask, tf, lo, hi);
    vri += static_cast<double>(incr);
    vri = wrap(vri, invN, N);
  }
  return vri;
}

double processARate(const PeriodicWave &w, std::size_t n, float *dest, double vri, const float *pinc) {
  const float rateScale = w.rateScale();
  const float invRate = 1 / rateScale;
  const unsigned N = static_cast<unsigned>(w.tableSize());
  const double invN = 1.0 / N;
  const unsigned mask = N - 1;
  std::size_t k = 0;
  for (std::size_t loop = 0; loop < n / 4; ++loop, k += 4) {
    bool big = true;
    float freq[4];
    for (int m = 0; m < 4; ++m) {
      big = big && std::fabs(pinc[k + m]) >= kInterpolate2Point;
      freq[m] = invRate * pinc[k + m];
    }
    const float *lo[4], *hi[4];
    float tf[4];
    for (int m = 0; m < 4; ++m) w.tablesFor(freq[m], lo[m], hi[m], tf[m]);
    if (big) {  // ProcessARateVectorKernel (SSE2): double lanes, float interpolation
      double incrSum[4];
      incrSum[0] = pinc[k];
      for (int m = 1; m < 4; ++m) incrSum[m] = incrSum[m - 1] + pinc[k + m];
      const double lane[4] = {vri, vri + incrSum[0], vri + incrSum[1], vri + incrSum[2]};
      for (int m = 0; m < 4; ++m) {
        const double x = wrapLaneD(lane[m], static_cast<double>(N), invN);
        const unsigned r0 = static_cast<unsigned>(static_cast<int>(x)) & mask;
        const unsigned r1 = (static_cast<unsigned>(static_cast<int>(x)) + 1) & mask;
        const float f = static_cast<float>(x) - static_cast<float>(r0);
        const float sh = hi[m][r0] + f * (hi[m][r1] - hi[m][r0]);
        const float sl = lo[m][r0] + f * (lo[m][r1] - lo[m][r0]);
        dest[k + m] = sh + tf[m] * (sl - sh);
      }
      vri += incrSum[3];
      vri = wrap(vri, invN, N);
    } else {
      for (int m = 0; m < 4; ++m) {
        dest[k + m] = doInterpolation(vri, std::fabs(pinc[k + m]), mask, tf[m], lo[m], hi[m]);
        vri += static_cast<double>(pinc[k + m]);
        vri = wrap(vri, invN, N);
      }
    }
  }
  for (std::size_t m = k; m < n; ++m) {  // ProcessARateScalar
    const float incr = pinc[m];
    const float frequency = invRate * incr;
    const float *lo = nullptr, *hi = nullptr;
    float tf = 0;
    w.tablesFor(frequency, lo, hi, tf);
    dest[m] = doInterpolation(vri, std::fabs(incr), mask, tf, lo, hi);
    vri += static_cast<double>(incr);
    vri = wrap(vri, invN, N);
  }
  return vri;
}

}  // namespace

Oscillator::Oscillator(const PeriodicWave *wave, double frequency, double detuneCents)
    : wave_(wave), freq_(frequency), detune_(detuneCents, -153600.0f, 153600.0f) {}

void Oscillator::start(double t) {
  sched::State s{start_, stop_, playing_, finished_};
  s.startAt(t);
  start_ = s.start;
}

void Oscillator::stop(double t) {
  sched::State s{start_, stop_, playing_, finished_};
  s.stopAt(t);
  stop_ = s.end;
}

void Oscillator::process(std::int64_t frame0, double sampleRate, float *out, std::size_t n) {
  process(frame0, sampleRate, out, n, nullptr, nullptr);
}

void Oscillator::process(std::int64_t frame0, double sampleRate, float *out, std::size_t n, const float *freqMod,
                         const float *detuneMod) {
  if (n > kMaxQ) n = kMaxQ;
  std::memset(out, 0, n * sizeof(float));
  if (!wave_) return;
  sched::State st{start_, stop_, playing_, finished_};
  const sched::Info info = sched::update(st, frame0, sampleRate, n);
  start_ = st.start;
  playing_ = st.playing;
  finished_ = st.finished;
  if (info.silentAll) return;

  const PeriodicWave &w = *wave_;
  const float rateScale = w.rateScale();
  const float sr = static_cast<float>(sampleRate);
  float pinc[kMaxQ], dvals[kMaxQ];
  bool hasSA = false, hasFreqChanges = false;
  float finalScale = rateScale;
  float frequency = 0;  // k-rate frequency after detune and clamping (0 while sample accurate, as in Chromium)

  // `HasSampleAccurateValues() && IsAudioRate()`: a k-rate param (or one without automation in this quantum) uses
  // FinalValue() = timeline value at the quantum start + first frame of the input sum, clipped to the param range.
  const bool freqSA = freqRate_ == Param::Rate::ARate &&
                      (freq_.hasSampleAccurateValues(frame0, sampleRate) || freqMod != nullptr);
  const bool detSA = detuneRate_ == Param::Rate::ARate &&
                     (detune_.hasSampleAccurateValues(frame0, sampleRate) || detuneMod != nullptr);
  float freqFinal = 0, detFinal = 0;
  // Chromium's frequency AudioParam has the nominal range [-Nyquist, Nyquist]: its timeline values, its FinalValue()
  // and the sum with connected inputs are clipped to it BEFORE the detune multiplier is applied (30 kHz at 48 kHz with
  // detune -1200 plays 12 kHz in Chromium 157, not 15 kHz). freq_ is built without that range (the sample rate is not
  // known at construction), so the clip is done here (T11a review).
  const float nyq = sr / 2;
  if (freqSA) {
    hasSA = hasFreqChanges = true;
    freq_.processARate(frame0, sampleRate, pinc, n);
    if (freqMod)
      for (std::size_t i = 0; i < n; ++i) pinc[i] += freqMod[i];
    for (std::size_t i = 0; i < n; ++i) pinc[i] = clampFrequency(pinc[i], nyq);
  } else {
    freqFinal = freq_.processKRate(frame0, sampleRate);
    if (freqMod) freqFinal += freqMod[0];
    freqFinal = clampFrequency(freqFinal, nyq);
    finalScale *= freqFinal;
  }
  const float dLo = detune_.minValue(), dHi = detune_.maxValue();
  auto clipDetune = [dLo, dHi](float v) { return v < dLo ? dLo : (v > dHi ? dHi : v); };
  if (detSA) {
    hasSA = true;
    float *dv = hasFreqChanges ? dvals : pinc;
    detune_.processARate(frame0, sampleRate, dv, n);
    if (detuneMod)
      for (std::size_t i = 0; i < n; ++i) dv[i] = clipDetune(dv[i] + detuneMod[i]);
    const float k = static_cast<float>(1.0 / 1200);
    for (std::size_t i = 0; i < n; ++i) dv[i] = std::exp2(dv[i] * k);
    if (hasFreqChanges)
      for (std::size_t i = 0; i < n; ++i) pinc[i] = dv[i] * pinc[i];
  } else {
    detFinal = detune_.processKRate(frame0, sampleRate);
    if (detuneMod) detFinal = clipDetune(detFinal + detuneMod[0]);
    finalScale *= detuneToMultiplier(detFinal);
  }
  if (hasSA) {
    for (std::size_t i = 0; i < n; ++i) pinc[i] = clampFrequency(pinc[i], nyq);
    for (std::size_t i = 0; i < n; ++i) pinc[i] *= finalScale;
  } else {
    frequency = clampFrequency(freqFinal * detuneToMultiplier(detFinal), nyq);
  }

  double vri = phase_;
  std::size_t dst = info.offset;
  std::size_t cnt = info.count;
  const double sfo = info.startFrameOffset;
  if (sfo > 0) {
    ++dst;
    --cnt;
    vri += (1 - sfo) * frequency * rateScale;
  } else if (sfo < 0) {
    vri = -sfo * frequency * rateScale;
  }
  if (hasSA) {
    vri = processARate(w, cnt, out + dst, vri, pinc);
  } else {
    vri = processKRate(w, cnt, out + dst, vri, frequency);
  }
  phase_ = vri;
}

}  // namespace rig::wa
