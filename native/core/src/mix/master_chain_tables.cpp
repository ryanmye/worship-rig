// Ports of fx.js clipCurve, glueSettings, glueRefDb, measureCompMakeup and measureGlueRef (see master_chain_tables.h).
#include "mix/master_chain_tables.h"

#include <algorithm>
#include <cmath>
#include <memory>
#include <vector>

#include "dsp/oscillator.h"
#include "dsp/periodic_wave.h"
#include "num/js_math.h"

namespace rig::master {
namespace {

constexpr std::size_t kQ = 128;

/** OscillatorNode(1 kHz) -> GainNode(amp) -> compressor -> mono destination; mean square of the last 4410 frames
 *  (the destination's 1-channel down-mix .5 L + .5 R equals L: the input is mono, the kernel duplicates it). */
double renderTail(double sr, std::size_t frames, float amp, const wa::DynamicsCompressor::Params &p) {
  wa::DynamicsCompressor comp(sr);
  comp.setParams(p);
  const std::unique_ptr<wa::PeriodicWave> wave(wa::PeriodicWave::basic(wa::PeriodicWave::Basic::Sine, sr));
  wa::Oscillator osc(wave.get(), 1000.0);
  osc.start(0.0);
  float in[kQ], l[kQ], r[kQ];
  const float *src[1] = {in};
  float *dst[2] = {l, r};
  double s = 0;
  const std::size_t from = frames - 4410;
  for (std::size_t f0 = 0; f0 < frames; f0 += kQ) {
    osc.process(static_cast<std::int64_t>(f0), sr, in, kQ);
    for (float &v : in) v *= amp;
    comp.process(src, 1, dst, kQ);
    for (std::size_t i = 0; i < kQ; ++i) {
      const std::size_t f = f0 + i;
      if (f >= from && f < frames) {
        const float d = 0.5f * l[i] + 0.5f * r[i];
        s += static_cast<double>(d) * static_cast<double>(d);
      }
    }
  }
  return s;
}

}  // namespace

wa::DynamicsCompressor::Params glueSettings(double a) {
  const double x = std::min(1.0, std::max(0.0, std::isnan(a) ? 0.0 : a));  // Number(a) || 0: +-Infinity clamps
  wa::DynamicsCompressor::Params p;
  p.threshold = static_cast<float>(-24.0 * x);
  p.ratio = static_cast<float>(1.0 + (4.0 - 1.0) * x);
  p.knee = 6.0f;
  p.attack = 0.01f;
  p.release = 0.25f;
  return p;
}

wa::DynamicsCompressor::Params catcherSettings() {
  wa::DynamicsCompressor::Params p;
  p.threshold = -3.0f;
  p.knee = 3.0f;
  p.ratio = 12.0f;
  p.attack = 0.003f;
  p.release = 0.25f;
  return p;
}

double measureCompMakeup(double sr) {
  const auto n = static_cast<std::size_t>(rig::js::round(sr * 0.5));
  const float g = static_cast<float>(rig::js::pow(10.0, -30.0 / 20.0));
  const double s = renderTail(sr, n, g, catcherSettings());
  const double outRms = std::sqrt(s / 4410.0);
  const double inRms = rig::js::pow(10.0, -30.0 / 20.0) / kSqrt2;
  const double m = outRms / inRms;
  return m > 0.5 && m < 2 ? m : 1.0;
}

std::array<double, kGlueGrid + 1> measureGlueRef(double sr) {
  std::array<double, kGlueGrid + 1> out{};
  const auto n = static_cast<std::size_t>(rig::js::round(sr * 0.8));
  const double refAmp = 0.1;
  const double inRms = refAmp / kSqrt2;
  for (std::size_t k = 0; k <= kGlueGrid; ++k) {
    const double s = renderTail(sr, n, static_cast<float>(refAmp),
                                glueSettings(static_cast<double>(k) / static_cast<double>(kGlueGrid)));
    const double gDb = 20.0 * rig::js::log10(std::sqrt(s / 4410.0) / inRms);
    out[k] = std::isfinite(gDb) && std::fabs(gDb) < 30 ? gDb : 0.0;
  }
  return out;
}

// The JS measures both at 44.1 kHz whatever the context rate, so on the native kernels they are constants. Pinned
// here (measureCompMakeup(44100) / measureGlueRef(44100), bit-identical on g++ 13 and clang 18) instead of measured
// at the first MasterChain construction: that runs on the control thread inside `audio start` and took ~0.28 s
// (Release) / ~1 s (ASan) on the 2-CPU box, stalling every reply behind it. tests/test_master_dsp.cpp re-measures
// and requires bit equality, so a kernel change (or another platform's libm) cannot drift silently.
namespace {
constexpr double kCompMakeup44k = 0x1.22b3fb3f31395p+0;
constexpr std::array<double, kGlueGrid + 1> kGlueRef44k = {
    -0x1.037c0fb725f7ep-13, 0x1.10b0f83b0cd44p-4, 0x1.c8f66e11c8ba5p-2, 0x1.3b982723a97dfp+0,
    0x1.1cdb3cf50aa16p+1,   0x1.aa59d844fa055p+1, 0x1.20c4d20826cf7p+2, 0x1.6fdcbf8c481p+2,
    0x1.c16729e36e65ap+2,   0x1.03e12d17886c5p+3, 0x1.0e11599f76b36p+3};
}  // namespace

double compMakeup() {
  return kCompMakeup44k;
}

const std::array<double, kGlueGrid + 1> &glueRefTable() {
  return kGlueRef44k;
}

double glueRefDb(const std::array<double, kGlueGrid + 1> &table, double a) {
  const double x = std::min(1.0, std::max(0.0, a)) * static_cast<double>(table.size() - 1);
  const auto i = std::min(table.size() - 2, static_cast<std::size_t>(std::floor(x)));
  return table[i] + (table[i + 1] - table[i]) * (x - static_cast<double>(i));
}

double glueMakeup(double a) {
  return rig::js::pow(10.0, -glueRefDb(glueRefTable(), a) / 20.0);
}

const float *clipCurve() {
  static const std::vector<float> c = [] {
    std::vector<float> v(kClipCurveSize);
    const double n = static_cast<double>(kClipCurveSize);
    const double ceil = rig::js::pow(10.0, -0.3 / 20.0);
    const double k = 0.5;
    for (std::size_t i = 0; i < kClipCurveSize; ++i) {
      const double x = ((static_cast<double>(i) / (n - 1)) * 2 - 1) * 2;
      const double ax = std::fabs(x);
      const double y = ax < k ? ax : k + (ceil - k) * rig::js::tanh((ax - k) / (ceil - k));
      const double sign = x > 0 ? 1.0 : (x < 0 ? -1.0 : x);  // Math.sign (keeps +-0)
      v[i] = static_cast<float>(sign * y);
    }
    return v;
  }();
  return c.data();
}

}  // namespace rig::master
