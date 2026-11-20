// T07: port of the engine suite's click (discontinuity) detector, test/phase1/engine/suites.mjs `clicks()`, and its
// positive control `clickDetectorSelfTest` on a synthetic signal. The JS control renders a warm-pad chord + reverb
// (T11 + T04) with a 330 Hz sine hard-stopped at a crest; here the pad is three detuned sines with a slow envelope at
// the same level (about -20 dBFS) so the detector itself is checked now. The engine-level tests that use it
// (`clicksStealsDelay`: voice steals + delay time changes; `clickDetectorSelfTest` on the real pad) need T11's synth
// and T05's delay: handed on to those tasks, which can call rigtest::clicks() from this file's header-free copy.
#include <algorithm>
#include <cmath>
#include <vector>

#include "doctest.h"

namespace rigtest {

struct ClickHit {
  double t, dd, lm;
};

/** suites.mjs clicks(d, sr, a, b, floor): first difference > 6 x local median and > 4.5 x local RMS. */
std::vector<ClickHit> clicks(const std::vector<float> &d, double sr, double a, double b, double floor = 1e-3) {
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

TEST_SUITE("click") {
  TEST_CASE("click detector: finds a hard-stopped sine under a pad (positive control), nothing without it") {
    const double sr = 44100, pi = 3.141592653589793;
    const std::size_t n = static_cast<std::size_t>(3 * sr);
    auto pad = [&](std::size_t i) {
      const double t = static_cast<double>(i) / sr;
      const double env = std::min(1.0, t / 0.4);
      return env * 0.033 *
             (std::sin(2 * pi * 220.0 * t) + std::sin(2 * pi * 261.9 * t) + std::sin(2 * pi * 329.2 * t));
    };
    std::vector<float> clean(n), hit(n);
    const double t0 = 0.5, t1 = 0.5 + 495.25 / 330;  // stops at a crest -> full-amplitude step (as the JS control)
    for (std::size_t i = 0; i < n; ++i) {
      const double t = static_cast<double>(i) / sr;
      clean[i] = static_cast<float>(pad(i));
      const double s = t >= t0 && t < t1 ? 0.08 * std::sin(2 * pi * 330 * (t - t0)) : 0;
      hit[i] = static_cast<float>(pad(i) + s);
    }
    const auto h = rigtest::clicks(hit, sr, 1.0, 2.9);
    REQUIRE(h.size() >= 1);
    CHECK(std::fabs(h[0].t - 2.0) < 0.02);
    CHECK(rigtest::clicks(hit, sr, 1.0, 1.95).empty());
    CHECK(rigtest::clicks(clean, sr, 1.0, 2.9).empty());
  }
}
