#include "samples/process_sample.h"

#include <algorithm>
#include <cmath>
#include <limits>

#include "num/js_math.h"

namespace rig::samples {
namespace {

// JS Math.round: round half toward +infinity.
std::size_t jsRound(double x) {
  return static_cast<std::size_t>(std::floor(x + 0.5));
}

}  // namespace

MonoFix limitMonoLoss(float *L, float *R, std::size_t n, double capDb, std::size_t statsLen, std::size_t fadeLen) {
  double mm = 0, ss = 0;
  const std::size_t m = std::min(n, statsLen);
  const std::size_t f0 = m - std::min(m, fadeLen);
  for (std::size_t i = 0; i < m; ++i) {
    // same weight (and the same float32 product) as processSample's fade: o[len-1-j] *= j / fo
    const double w = i < f0 ? 1.0 : static_cast<double>(m - 1 - i) / static_cast<double>(fadeLen);
    const double l = w == 1.0 ? static_cast<double>(L[i]) : static_cast<double>(static_cast<float>(L[i] * w));
    const double r = w == 1.0 ? static_cast<double>(R[i]) : static_cast<double>(static_cast<float>(R[i] * w));
    const double mid = 0.5 * (l + r);
    const double side = 0.5 * (l - r);
    mm += mid * mid;
    ss += side * side;
  }
  MonoFix fix;
  fix.applied = true;
  fix.lossDb = mm > 0 ? 10 * js::log10((mm + ss) / mm) : 0;
  if (!(mm > 0) || !(ss > 0) || fix.lossDb <= capDb + 1e-3) return fix;
  const double k = js::pow(10, capDb / 10) - 1;  // target S^2/M^2
  const double a = std::sqrt((mm + ss) / ((1 + k) * mm));
  const double b = a * std::sqrt((k * mm) / ss);
  for (std::size_t i = 0; i < n; ++i) {
    const double mid = 0.5 * (static_cast<double>(L[i]) + static_cast<double>(R[i])) * a;
    const double side = 0.5 * (static_cast<double>(L[i]) - static_cast<double>(R[i])) * b;
    L[i] = static_cast<float>(mid + side);
    R[i] = static_cast<float>(mid - side);
  }
  fix.mid = a;
  fix.side = b;
  return fix;
}

Processed processSample(const std::vector<float> *in, int channels, double sr, int midi, const DecodeOpts &opts) {
  Processed out;
  const std::size_t length = in[0].size();
  const double thr = js::pow(10, kOnsetDb / 20);
  std::size_t onset = length;
  for (int c = 0; c < channels; ++c) {
    const std::vector<float> &d = in[c];
    for (std::size_t i = 0; i < d.size() && i < onset; ++i) {
      if (std::fabs(static_cast<double>(d[i])) > thr) {
        onset = i;
        break;
      }
    }
  }
  if (onset >= length) onset = 0;
  const std::size_t guard = jsRound(0.001 * sr);
  const std::size_t start = onset > guard ? onset - guard : 0;
  const double capSec = opts.maxSec > 0 ? opts.maxSec : legacyCapSec(midi);
  const std::size_t cap = jsRound(capSec * sr);
  const std::size_t len = std::max<std::size_t>(1, std::min(length - start, cap));
  const bool capped = length - start > cap;

  // dual-mono detection (ci-3): stops at the first difference above 0.01 (-40 dBFS), reporting infinity
  bool dualMono = false;
  if (channels == 2) {
    double diff = 0, peak = 0;
    bool stopped = false;
    for (std::size_t i = start; i < start + len; ++i) {
      const double d = std::fabs(static_cast<double>(in[0][i]) - static_cast<double>(in[1][i]));
      if (d > diff) {
        if (d > 0.01) {
          diff = std::numeric_limits<double>::infinity();
          stopped = true;
          break;
        }
        diff = d;
      }
      const double v = std::fabs(static_cast<double>(in[0][i]));
      if (v > peak) peak = v;
    }
    (void)stopped;
    out.lrDiff = diff;
    out.hasLrDiff = true;
    dualMono = diff <= std::max(kDualMonoRel * peak, kDualMonoAbs);
  }
  const int used = dualMono ? 1 : channels;
  const std::size_t fi = std::min(len, jsRound(0.002 * sr));
  const std::size_t fo = capped ? std::min(len, jsRound(1.0 * sr)) : 0;
  for (int c = 0; c < used; ++c) {
    std::vector<float> &o = out.ch[c];
    o.assign(in[c].begin() + static_cast<std::ptrdiff_t>(start),
             in[c].begin() + static_cast<std::ptrdiff_t>(start + len));
    for (std::size_t i = 0; i < fi; ++i)
      o[i] = static_cast<float>(
          static_cast<double>(o[i]) *
          (0.5 - 0.5 * js::cos(3.14159265358979323846 * static_cast<double>(i) / static_cast<double>(fi))));
    for (std::size_t i = 0; i < fo; ++i)
      o[len - 1 - i] =
          static_cast<float>(static_cast<double>(o[len - 1 - i]) * (static_cast<double>(i) / static_cast<double>(fo)));
  }
  if (used == 2 && opts.hasMaxMonoLoss && std::isfinite(opts.maxMonoLossDb) && opts.maxMonoLossDb > 0) {
    // measured on exactly what the legacy cap keeps (incl. its 1 s fade), so a long variant is the legacy buffer
    // plus a tail, not a re-balanced copy
    const std::size_t legacyLen = std::max<std::size_t>(1, std::min(length - start, jsRound(legacyCapSec(midi) * sr)));
    const std::size_t legacyFade = len > legacyLen ? std::min(legacyLen, jsRound(1.0 * sr)) : 0;
    out.monoFix = limitMonoLoss(out.ch[0].data(), out.ch[1].data(), len, opts.maxMonoLossDb, legacyLen, legacyFade);
  }
  out.channels = used;
  out.frames = len;
  out.dualMono = dualMono;
  out.onsetTrim = static_cast<double>(start) / sr;
  out.natural = length - start;
  out.capped = capped;
  return out;
}

}  // namespace rig::samples
