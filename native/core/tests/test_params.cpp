#include <cmath>

#include <cstring>
#include <initializer_list>
#include <string>
#include <vector>
#include "doctest.h"
#include "params/params.h"

using namespace rig;

TEST_SUITE("params") {
  TEST_CASE("table has the 102 contract rows, sorted, with unique paths") {
    CHECK(paramCount() == 102);
    for (std::size_t i = 1; i < paramCount(); ++i) CHECK(std::string(paramRows()[i - 1].path) < paramRows()[i].path);
  }

  TEST_CASE("slot paths resolve to the <i> row and report the slot") {
    int slot = -1;
    const ParamRow *r = findParam("slots.2.gain", &slot);
    REQUIRE(r != nullptr);
    CHECK(slot == 2);
    CHECK(std::string(r->path) == "slots.<i>.gain");
    CHECK(r->def == doctest::Approx(0.8));
    CHECK(r->max == 2.0);
    CHECK(findParam("slots.4.gain") == nullptr);  // only 4 slots
    CHECK(findParam("slots.0.nonsense") == nullptr);
    CHECK(findParam("master.volume") != nullptr);
    bool dyn = false;
    CHECK(findParam("slots.1.params.attack", nullptr, &dyn) == nullptr);
    CHECK(dyn);
  }

  TEST_CASE("clamp rules of contract 2.1") {
    const ParamRow *g = findParam("slots.0.gain");
    CHECK(clampNumber(*g, 5.0) == 2.0);
    CHECK(clampNumber(*g, -1.0) == 0.0);
    CHECK(clampNumber(*g, NAN) == doctest::Approx(0.8));
    const ParamRow *oct = findParam("slots.0.octave");
    CHECK(clampNumber(*oct, 1.4) == 1.0);  // step 1 rounds
    CHECK(clampNumber(*oct, 9) == 2.0);
  }

  TEST_CASE("enum rows") {
    const ParamRow *t = findParam("slots.0.eq.b4.type");
    REQUIRE(t != nullptr);
    CHECK(t->kind == 2);
    CHECK(enumIndex(*t, "peak") == 2);
    CHECK(enumIndex(*t, "highcut") == 6);
    CHECK(enumIndex(*t, "nope") == -1);
    CHECK(enumName(*t, 5) == "lowcut");
    CHECK(enumName(*t, static_cast<int>(t->def)) == "peak");
  }

  TEST_CASE("every row has a smoothing rule and a sane range") {
    for (std::size_t i = 0; i < paramCount(); ++i) {
      const ParamRow &r = paramRows()[i];
      CHECK(std::string(smoothingText(r.smoothing)).size() > 0);
      if (r.kind == 0 && !std::isnan(r.min) && !std::isnan(r.max) && !std::isnan(r.def)) {  // def NaN: word default
        CHECK(r.min <= r.def);
        CHECK(r.def <= r.max);
      }
    }
  }
}
