// Ports of fx.js clipCurve, glueSettings, glueRefDb, measureCompMakeup and measureGlueRef (see master_chain_tables.h).
#include "mix/master_chain_tables.h"

#include <algorithm>
#include <cmath>
#include <vector>

#include "num/js_math.h"

namespace rig::master {
namespace {

constexpr std::size_t kQ = 128;

/** OscillatorNode(1 kHz) -> GainNode(amp) -> compressor -> mono destination; mean square of the last 4410 frames
 *  (the destination's 1-channel down-mix .5 L + .5 R equals L: the input is mono, the kernel duplicates it). */
double renderTail(double sr, std::size_t frames, float amp, const wa::DynamicsCompressor::Params &p) {
  wa::DynamicsCompressor comp(sr);
  comp.setParams(p);
  float in[kQ], l[kQ], r[kQ];
  const float *src[1] = {in};
  float *dst[2] = {l, r};
  double s = 0;
  const std::size_t from = frames - 4410;
  for (std::size_t f0 = 0; f0 < frames; f0 += kQ) {
    for (std::size_t i = 0; i < kQ; ++i) {
      const double t = static_cast<double>(f0 + i);
      in[i] = static_cast<float>(rig::js::sin(2.0 * rig::js::kPi * 1000.0 * t / sr)) * amp;
    }
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
  const double x = std::min(1.0, std::max(0.0, std::isfinite(a) ? a : 0.0));
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

double compMakeup() {
  static const double m = measureCompMakeup(44100.0);  // the JS measures at 44.1 kHz whatever the context rate
  return m;
}

const std::array<double, kGlueGrid + 1> &glueRefTable() {
  static const std::array<double, kGlueGrid + 1> t = measureGlueRef(44100.0);
  return t;
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
