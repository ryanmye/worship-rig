// Click (discontinuity) detector of the engine suites, test/phase1/engine/suites.mjs `clicks()` (T07 port): flags
// samples whose first difference exceeds 6 x the local median and 4.5 x the local RMS of the first difference
// (256-sample blocks, +-4 blocks around). For the engine tests that need it (`clicksStealsDelay` with T11's synth and
// T05's delay; `clickDetectorSelfTest` on the real warm-pad): include this header.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <vector>

namespace rigtest {

struct ClickHit {
  double t, dd, lm;
};

/** suites.mjs clicks(d, sr, a, b, floor): first difference > 6 x local median and > 4.5 x local RMS. */
inline std::vector<ClickHit> clicks(const std::vector<float> &d, double sr, double a, double b, double floor = 1e-3) {
  const std::size_t i0 = std::max<std::size_t>(2, static_cast<std::size_t>(std::floor(a * sr)));
  const std::size_t i1 = std::min(d.size(), static_cast<std::size_t>(std::floor(b * sr)));
  std::vector<ClickHit> found;
  if (i1 <= i0) return found;
  const std::size_t n = i1 - i0;
  std::vector<float> d1(n);
  for (std::size_t i = 0; i < n; ++i) d1[i] = std::fabs(d[i0 + i] - d[i0 + i - 1]);
  const std::size_t B = 256, nb = (n + B - 1) / B;
  std::vector<double> med(nb), ms(nb);
  for (std::size_t bi = 0; bi < nb; ++bi) {
    std::vector<float> seg(d1.begin() + static_cast<std::ptrdiff_t>(bi * B),
                           d1.begin() + static_cast<std::ptrdiff_t>(std::min(n, (bi + 1) * B)));
    double q = 0;
    for (float v : seg) q += static_cast<double>(v) * v;
    std::sort(seg.begin(), seg.end());
    med[bi] = seg.empty() ? 0 : seg[seg.size() >> 1];
    ms[bi] = seg.empty() ? 0 : q / static_cast<double>(seg.size());
  }
  for (std::size_t i = 0; i < n; ++i) {
    const std::size_t bi = i / B, lo = bi >= 4 ? bi - 4 : 0, hi = std::min(nb - 1, bi + 4);
    std::vector<double> cand(med.begin() + static_cast<std::ptrdiff_t>(lo),
                             med.begin() + static_cast<std::ptrdiff_t>(hi + 1));
    std::sort(cand.begin(), cand.end());
    const double lm = cand[cand.size() >> 1];
    double q = 0;
    for (std::size_t k = lo; k <= hi; ++k) q += ms[k];
    const double lr = std::sqrt(q / static_cast<double>(hi - lo + 1));
    const double h = d1[i];
    if (h > floor && h > 6 * lm && h > 4.5 * lr) {
      found.push_back({static_cast<double>(i0 + i) / sr, h, lm});
      i += B;
    }
  }
  return found;
}

}  // namespace rigtest
