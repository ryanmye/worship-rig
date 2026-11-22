// W3B (fx-row-sweep root cause): fx.js Lofi.apply(when) runs at CALL time. Its WaveShaper curves (sat / quant: not
// AudioParams) change at once, only the ramps and the engage crossfade wait for `when`. The golden page issues every
// event up front, so in fx-row-sweep the curves of the LAST lofi row (saturation .9, amount .7 at 7.0 / 7.2 s: drive
// 9 dB, 11 bits) shape the whole render from t = 0 (1.7-2.3 dB quieter in 0-3 s, exact zeros where 11 bits round a
// -100 dB drone to 0). The native lofi service sent its state at `when`, so the curves stepped at 7 s.
#include <algorithm>
#include <cmath>
#include <string>

#include "doctest.h"
#include "helpers.h"
#include "test_model_util.h"

namespace {

double diffIn(const t13::Eng &a, const t13::Eng &b, double t0, double t1) {
  const auto i0 = static_cast<std::size_t>(t0 * t13::kSR);
  const auto i1 = std::min({a.L.size(), b.L.size(), static_cast<std::size_t>(t1 * t13::kSR)});
  double m = 0;
  for (std::size_t i = i0; i < i1; ++i)
    m = std::max({m, std::fabs(double(a.L[i]) - b.L[i]), std::fabs(double(a.R[i]) - b.R[i])});
  return m;
}

}  // namespace

TEST_SUITE("lofi-calltime") {
  TEST_CASE("a lofi row issued ahead of its time: curves now, ramps at `when` (fx.js Lofi.apply)") {
    const std::string fx = R"("fx":{"lofi":{"amount":0.3,"saturation":0.3,"bits":0.3,"crackle":0}})";
    t13::Eng ahead, onTime, never;
    for (t13::Eng *e : {&ahead, &onTime, &never}) {
      REQUIRE(e->use(t13::patch({t13::slot("test", "sine", 1)}, fx)));
      e->on(57, 0.05, 110);
    }
    ahead.set("fx.lofi.saturation", "0.9", 1.0);  // issued at t = 0 for t = 1 s
    for (t13::Eng *e : {&ahead, &onTime, &never}) e->until(1.0);
    onTime.set("fx.lofi.saturation", "0.9", 1.0);  // issued at its time
    for (t13::Eng *e : {&ahead, &onTime, &never}) e->until(1.6);
    REQUIRE(t13::rms(never.L, 0.2, 0.9) > 1e-3);
    CHECK(diffIn(onTime, never, 0, 1.0) == 0);       // nothing before the call
    CHECK(diffIn(ahead, never, 0.2, 0.9) > 1e-3);    // the drive curve is in effect from the call on
    CHECK(diffIn(ahead, onTime, 1.2, 1.6) < 1e-5);   // after `when` both run the same curve and ramps
  }
}
