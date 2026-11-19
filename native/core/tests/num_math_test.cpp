// rig::js math vs Math.* dumped from the golden Chromium (tools/golden/vectors/data/math.txt): bit-exact for every
// function and case. rig::fdlibm spot checks and the fdlibm_v8.inc derivation check.
#include <cmath>
#include <fstream>
#include <map>
#include <sstream>
#include <string>

#include "doctest.h"
#include "num/js_math.h"
#include "num_vectors.h"

using rigvec::bits;
using rigvec::hexToDouble;

TEST_SUITE("num") {
  TEST_CASE("js math: bit-exact against Chromium 157 Math.* for every dumped case") {
    using F1 = double (*)(double);
    using F2 = double (*)(double, double);
    const std::map<std::string, F1> one = {
        {"sin", rig::js::sin},     {"cos", rig::js::cos},     {"tan", rig::js::tan},       {"exp", rig::js::exp},
        {"log", rig::js::log},     {"log2", rig::js::log2},   {"log10", rig::js::log10},   {"tanh", rig::js::tanh},
        {"atan", rig::js::atan},   {"sqrt", rig::js::sqrt},   {"cbrt", rig::js::cbrt},     {"expm1", rig::js::expm1},
        {"sinh", rig::js::sinh},   {"round", rig::js::round}, {"fround", rig::js::fround}};
    const std::map<std::string, F2> two = {{"pow", rig::js::pow}, {"atan2", rig::js::atan2}};
    std::map<std::string, std::pair<int, int>> stats;  // fn -> (cases, mismatches)
    for (const auto &l : rigvec::lines("math.txt")) {
      const auto t = rigvec::split(l);
      REQUIRE(t.size() >= 3);
      const bool isTwo = t.size() == 4;
      const double x = hexToDouble(t[1]);
      const double r = hexToDouble(t.back());
      double v;
      if (isTwo) {
        REQUIRE(two.count(t[0]));
        v = two.at(t[0])(x, hexToDouble(t[2]));
      } else {
        REQUIRE(one.count(t[0]));
        v = one.at(t[0])(x);
      }
      auto &s = stats[t[0]];
      ++s.first;
      const bool same = (std::isnan(v) && std::isnan(r)) || bits(v) == bits(r);
      if (!same) {
        ++s.second;
        if (s.second <= 3) MESSAGE(l << " -> got " << std::hexfloat << v);
      }
    }
    REQUIRE(stats.size() == 17);
    for (const auto &[fn, s] : stats) {
      INFO(fn);
      CHECK(s.first >= 400);
      CHECK(s.second == 0);
    }
  }

  TEST_CASE("js pow: V8 special cases") {
    using rig::js::pow;
    CHECK(std::isnan(pow(1, INFINITY)));
    CHECK(std::isnan(pow(-1, -INFINITY)));
    CHECK(std::isnan(pow(2, NAN)));
    CHECK(pow(NAN, 0) == 1);
    CHECK(pow(3, 2) == 9);
    CHECK(pow(-INFINITY, 0.5) == INFINITY);
    CHECK(!std::signbit(pow(-0.0, 0.5)));
    CHECK(pow(10, -2) == pow(10.0, -2.0));
    CHECK(pow(0, -1) == INFINITY);
    CHECK(pow(-0.0, -1) == -INFINITY);
    CHECK(std::isnan(pow(-8, 1.0 / 3)));
    CHECK(pow(-2, 3) == -8);
  }

  TEST_CASE("js round: half toward +Infinity, -0 kept") {
    using rig::js::round;
    CHECK(round(2.5) == 3);
    CHECK(round(-2.5) == -2);
    CHECK(round(0.49999999999999994) == 0);
    CHECK(std::signbit(round(-0.4)));
    CHECK(round(4503599627370497.0) == 4503599627370497.0);
  }

  TEST_CASE("fdlibm: Chromium third_party/fdlibm values (V8 12.4 port)") {
    // exp(1) and pow(2, 0.5) are correctly rounded in fdlibm too; spot values where fdlibm and libm diverge are
    // covered indirectly by the AudioParam curves (exponential ramps, setTarget) in time_automation_test.cpp.
    CHECK(rig::fdlibm::exp(1.0) == 2.718281828459045);
    CHECK(rig::fdlibm::pow(2.0, 0.5) == 1.4142135623730951);
    CHECK(rig::fdlibm::exp(-1.0 / (48000 * 0.015)) == doctest::Approx(std::exp(-1.0 / (48000 * 0.015))));
  }

  TEST_CASE("fdlibm_v8.inc is third_party/v8_ieee754/ieee754.cc minus its V8 includes") {
    std::ifstream a(std::string(RIG_SOURCE_DIR) + "/third_party/v8_ieee754/ieee754.cc");
    std::ifstream b(std::string(RIG_SOURCE_DIR) + "/src/num/fdlibm_v8.inc");
    REQUIRE(a.good());
    REQUIRE(b.good());
    std::string la, lb;
    std::getline(b, lb);  // two header lines
    std::getline(b, lb);
    int n = 0;
    while (std::getline(a, la)) {
      if (la.rfind("#include \"src/base/", 0) == 0) continue;
      REQUIRE(std::getline(b, lb));
      CHECK(la == lb);
      ++n;
    }
    CHECK(!std::getline(b, lb));
    CHECK(n > 3000);
  }
}
