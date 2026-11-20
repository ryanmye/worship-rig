// T05 chorus (kind "chorus"): the chorus-* golden fixtures at the exact tier (both are exactIfPrngPorted; ctest
// golden.t05 compares at the manifest tier), the seeded start phase, the mono down-mix, and the delay modulation
// measured through a ramp input (7 ms +- 2 ms x depth, rates r / 1.07 r, r clamped to .15..1.5).
#include <cmath>
#include <string>
#include <vector>

#include "doctest.h"
#include "fx/chorus_unit.h"
#include "helpers.h"
#include "model/patch.h"
#include "num/js_math.h"
#include "num/prng.h"
#include "test_delay_util.h"

using rig::fx::ChorusUnit;

namespace {

constexpr double kSr = 44100;

rig::ChorusPatch patchOf(double rate, double depth, double rg = 1.0) {
  rig::ChorusPatch p;
  p.rate = rate;
  p.depth = depth;
  p.returnGain = rg;
  return p;
}

/** Delay (s) of voice c over time, from a ramp input x[n] = s n: y[n] = s (n - delay[n] sr). */
std::vector<double> measuredDelay(double rate, double depth, std::size_t frames, int c) {
  ChorusUnit u(kSr, 1, patchOf(rate, depth));
  t05::Driver d(&u, kSr);
  const double s = 1e-5;
  std::vector<std::vector<float>> in(2, std::vector<float>(frames));
  for (std::size_t n = 0; n < frames; ++n) in[0][n] = in[1][n] = static_cast<float>(s * static_cast<double>(n));
  const auto out = d.run(frames, in);
  std::vector<double> dl(frames);
  for (std::size_t n = 0; n < frames; ++n)
    dl[n] = (static_cast<double>(n) - double(out[static_cast<std::size_t>(c)][n]) / s) / kSr;
  return dl;
}

}  // namespace

TEST_SUITE("chorus") {
  TEST_CASE("golden fixtures chorus-* at the exact tier, allocation trap on") {
    for (const char *id : {"chorus-default-sine", "chorus-fast-deep-noise"}) {
      const std::string sid = id;
      INFO(sid);
      const t05::GoldenResult g = t05::goldenRun(sid);
      if (!g.present) continue;
      CHECK(g.rtAllocs == 0);
      CHECK(g.peak > 0.1);
      CHECK(g.maxDiff <= 2e-4);  // the exact tier (manifest: statistical, exactIfPrngPorted)
      if (sid == "chorus-default-sine") CHECK(g.maxDiff <= 2e-5);
    }
  }

  TEST_CASE("start phase = rngFor(seed, 'chorus').next() * 2 pi") {
    ChorusUnit u(kSr, 1, patchOf(0.4, 0.5));
    rig::Rng r = rig::rngFor(1, "chorus");
    CHECK(u.startPhase() == r.next() * rig::js::kPi * 2);
    ChorusUnit v(kSr, 7, patchOf(0.4, 0.5));
    CHECK(v.startPhase() != u.startPhase());
  }

  TEST_CASE("input is mono 1/2 (L + R); a constant passes unchanged on both outputs") {
    ChorusUnit u(kSr, 1, patchOf(0.4, 1.0, 0.5));
    t05::Driver d(&u, kSr);
    const std::size_t n = 44160;
    std::vector<std::vector<float>> in{std::vector<float>(n, 0.4f), std::vector<float>(n, 0.0f)};
    const auto out = d.run(n, in);
    for (int c = 0; c < 2; ++c)
      for (std::size_t i = 4410; i < n; ++i) REQUIRE(out[static_cast<std::size_t>(c)][i] == doctest::Approx(0.1).epsilon(1e-6));
  }

  TEST_CASE("delay modulation: 7 ms +- 2 ms x depth; rates r and 1.07 r; rate clamped to 1.5 Hz") {
    const std::size_t frames = static_cast<std::size_t>(3.2 * kSr) / 128 * 128;
    for (int c = 0; c < 2; ++c) {
      const auto dl = measuredDelay(0.4, 1.0, frames, c);
      double lo = 1, hi = 0;
      for (std::size_t n = static_cast<std::size_t>(0.6 * kSr); n < frames; ++n) {
        lo = std::min(lo, dl[n]);
        hi = std::max(hi, dl[n]);
      }
      CHECK(lo == doctest::Approx(0.005).epsilon(0.01));
      CHECK(hi == doctest::Approx(0.009).epsilon(0.01));
    }
    auto crossings = [&](const std::vector<double> &dl) {
      int k = 0;
      for (std::size_t n = static_cast<std::size_t>(0.7 * kSr) + 1; n < dl.size(); ++n)
        if ((dl[n - 1] - 0.007) < 0 && (dl[n] - 0.007) >= 0) ++k;
      return k;
    };
    // rate 5 Hz requested -> 1.5 Hz: 2.5 s of signal = 3.75 cycles (voice 2: 4.0)
    const auto d0 = measuredDelay(5.0, 0.5, frames, 0), d1 = measuredDelay(5.0, 0.5, frames, 1);
    CHECK(crossings(d0) >= 3);
    CHECK(crossings(d0) <= 4);
    CHECK(crossings(d1) >= 3);
    CHECK(crossings(d1) <= 5);
  }
}
