// PeriodicWave: a port of Chromium 157.0.8103.78 third_party/blink/renderer/modules/webaudio/periodic_wave_handler.cc
// (BSD-3, The Chromium Authors; licence text in third_party/chromium/LICENSE): table size by sample rate, 3 ranges per
// octave of culled partials, normalisation by the peak of the first (fullest) range, the x86 lane arithmetic of
// WaveDataForFundamentalFrequency (identical to the scalar form).
//
// Deviation (T11a): Chromium 157 inverts the spectrum with RustFFT in float32. Here the same spectrum (float inputs,
// same culling, same scaling) goes through a double-precision radix-2 FFT and the result is rounded to float: the
// tables differ from Chromium's by the float32 rounding noise of its FFT (<= ~1e-7 absolute), nothing else. Building
// allocates and runs on the control thread / a worker; tables are immutable afterwards.
#include "dsp/periodic_wave.h"

#include <algorithm>
#include <cmath>
#include <complex>
#include <numbers>
#include <vector>

#include "num/js_math.h"

namespace rig::wa {

namespace {

constexpr unsigned kNumberOfOctaveBands = 3;
constexpr unsigned kMaxPeriodicWaveSize = 16384;
constexpr float kCentsPerOctave = 1200;
constexpr float kCentsPerRange = kCentsPerOctave / kNumberOfOctaveBands;

unsigned waveSizeFor(float sampleRate) {
  if (sampleRate <= 24000) return 2048;
  if (sampleRate <= 88200) return 4096;
  return kMaxPeriodicWaveSize;
}

/** In-place iterative radix-2 complex FFT, sign = +1: sum x[k] e^{+2 pi i k n / N} (no scaling). */
void fft(std::vector<std::complex<double>> &a, const std::vector<std::complex<double>> &tw) {
  const std::size_t n = a.size();
  for (std::size_t i = 1, j = 0; i < n; ++i) {
    std::size_t bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) std::swap(a[i], a[j]);
  }
  for (std::size_t len = 2; len <= n; len <<= 1) {
    const std::size_t step = n / len;
    for (std::size_t i = 0; i < n; i += len) {
      for (std::size_t k = 0; k < len / 2; ++k) {
        const std::complex<double> u = a[i + k], v = a[i + k + len / 2] * tw[k * step];
        a[i + k] = u + v;
        a[i + k + len / 2] = u - v;
      }
    }
  }
}

}  // namespace

struct PeriodicWave::Impl {
  double sampleRate = 0;
  unsigned size = 0, ranges = 0;
  float lowest = 0, rateScale = 0;
  std::vector<float> tables;  // ranges * size

  Impl(float sr)
      : sampleRate(sr),
        size(waveSizeFor(sr)),
        ranges(static_cast<unsigned>(std::lround(kNumberOfOctaveBands * std::log2(static_cast<float>(size))))),
        lowest(sr / static_cast<float>(size)),
        rateScale(static_cast<float>(size) / sr) {}

  void build(const float *realData, const float *imagData, std::size_t count, bool disableNormalization) {
    float normalizationScale = 0.5f;
    const unsigned half = size / 2;
    const unsigned components = static_cast<unsigned>(std::min<std::size_t>(count, half));
    tables.assign(static_cast<std::size_t>(ranges) * size, 0.0f);
    std::vector<std::complex<double>> tw(size / 2), z(size);
    for (unsigned k = 0; k < size / 2; ++k) {
      const double ang = 2.0 * std::numbers::pi * k / size;
      tw[k] = {js::cos(ang), js::sin(ang)};
    }
    const float scale = static_cast<float>(size);
    for (unsigned r = 0; r < ranges; ++r) {
      const float centsToCull = static_cast<float>(r) * kCentsPerRange;
      const float cullingScale = static_cast<float>(js::pow(2.0, static_cast<double>(-centsToCull / kCentsPerOctave)));
      const unsigned partials = static_cast<unsigned>(cullingScale * static_cast<float>(half));
      const unsigned keep = std::min(components, partials + 1);
      std::fill(z.begin(), z.end(), std::complex<double>(0, 0));
      for (unsigned k = 1; k < keep; ++k) {
        const double re = static_cast<double>(realData[k] * scale);
        const double im = static_cast<double>(imagData[k] * -scale);
        z[k] = {re, im};
        z[size - k] = {re, -im};
      }
      fft(z, tw);
      float *t = &tables[static_cast<std::size_t>(r) * size];
      for (unsigned i = 0; i < size; ++i) t[i] = static_cast<float>(z[i].real() / size);
      if (!disableNormalization && r == 0) {
        float mx = 0;
        for (unsigned i = 0; i < size; ++i) mx = std::max(mx, std::fabs(t[i]));
        if (mx != 0) normalizationScale = 1.0f / mx;
      }
      for (unsigned i = 0; i < size; ++i) t[i] *= normalizationScale;
    }
  }
};

PeriodicWave::PeriodicWave() : impl_(nullptr) {}
PeriodicWave::~PeriodicWave() { delete impl_; }

PeriodicWave *PeriodicWave::create(const float *real, const float *imag, std::size_t n, bool disableNormalization,
                                   double sampleRate) {
  if (n < 2 || !real || !imag || !(sampleRate > 0)) return nullptr;
  auto *w = new PeriodicWave();
  w->impl_ = new Impl(static_cast<float>(sampleRate));
  w->impl_->build(real, imag, n, disableNormalization);
  return w;
}

PeriodicWave *PeriodicWave::basic(Basic type, double sampleRate) {
  if (!(sampleRate > 0)) return nullptr;
  auto *w = new PeriodicWave();
  w->impl_ = new Impl(static_cast<float>(sampleRate));
  const unsigned half = w->impl_->size / 2;
  std::vector<float> real(half, 0.0f), imag(half, 0.0f);
  for (unsigned n = 1; n < half; ++n) {
    const float piFactor = 2 / (static_cast<float>(n) * std::numbers::pi_v<float>);
    float b = 0;
    switch (type) {
      case Basic::Sine: b = (n == 1) ? 1.0f : 0.0f; break;
      case Basic::Square: b = (n & 1) ? 2 * piFactor : 0.0f; break;
      case Basic::Sawtooth: b = piFactor * ((n & 1) ? 1.0f : -1.0f); break;
      case Basic::Triangle:
        b = (n & 1) ? 2 * (piFactor * piFactor) * ((((n - 1) >> 1) & 1) ? -1.0f : 1.0f) : 0.0f;
        break;
    }
    imag[n] = b;
  }
  w->impl_->build(real.data(), imag.data(), half, false);
  return w;
}

double PeriodicWave::sampleRate() const { return impl_->sampleRate; }
std::size_t PeriodicWave::tableSize() const { return impl_->size; }
float PeriodicWave::rateScale() const { return impl_->rateScale; }

void PeriodicWave::tablesFor(double fundamentalHz, const float *&lower, const float *&higher, float &interp) const {
  const Impl &m = *impl_;
  const float f = std::fabs(static_cast<float>(fundamentalHz));
  const float ratio = f > 0 ? f / m.lowest : 0.5f;
  const float cents = std::log2(ratio) * kCentsPerOctave;
  const float lim = static_cast<float>(m.ranges - 1);
  float pitchRange = 1 + cents / kCentsPerRange;
  pitchRange = pitchRange < 0.0f ? 0.0f : (pitchRange > lim ? lim : pitchRange);
  const unsigned i1 = static_cast<unsigned>(pitchRange);
  const unsigned i2 = i1 < m.ranges - 1 ? i1 + 1 : i1;
  lower = &m.tables[static_cast<std::size_t>(i2) * m.size];
  higher = &m.tables[static_cast<std::size_t>(i1) * m.size];
  interp = pitchRange - static_cast<float>(i1);
}

}  // namespace rig::wa
