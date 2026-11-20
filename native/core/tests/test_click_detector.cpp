// T07: port of the engine suite's click (discontinuity) detector, test/phase1/engine/suites.mjs `clicks()`, and its
// positive control `clickDetectorSelfTest` on a synthetic signal. The JS control renders a warm-pad chord + reverb
// (T11 + T04) with a 330 Hz sine hard-stopped at a crest; here the pad is three detuned sines with a slow envelope at
// the same level (about -20 dBFS) so the detector itself is checked now. The engine-level tests that use it
// (`clicksStealsDelay`: voice steals + delay time changes; `clickDetectorSelfTest` on the real pad) need T11's synth
// and T05's delay: handed on to those tasks (tests/test_click_detector.h has the detector).
#include <cmath>
#include <vector>

#include "doctest.h"
#include "test_click_detector.h"


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
