// UIB (BUILD_PLAN "UI wave" item 5, T12 O1): the bridge row `config {dynamicRange}` (settings.dynamicRange, 1..3;
// 1..6 since TOUCH D43; audio.js setDynamicRange). The Model side (validation like shared/touch-curve.js
// validDynRange, samplers attached later) is tested in unit.song / unit.model; this suite proves the wire: hello
// minor 4 + capability, the reply echo, the schema type check, `get state`, and that a live sampler and a sampler
// attached after the call both hear it. TOUCH (D43) adds ranges past 3 against the velocityDb law.
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <string>

#include "helpers.h"
#include "test_model_util.h"

using rigtest::contains;
using t13::Eng;
using t13::patch;
using t13::slot;

namespace {

std::string cfg(const std::string &v) {
  return R"({"v":1,"op":"config","id":30,"dynamicRange":)" + v + "}";
}

/** Level (dB) of one ep-rhodes note at `vel`, with `range` sent before (pre = true) or after the song's commit. */
double noteDb(int vel, const char *range, bool pre, const char *inst = "ep-rhodes") {
  Eng e(true, t13::kSR, RIG_REPO_DIR "/app");
  if (pre && range) REQUIRE(contains(e.call(cfg(range)), "\"ok\":true"));
  REQUIRE(e.use(patch({slot("sampler", inst, 1)}, R"("master":{"volume":1})")));
  if (!pre && range) REQUIRE(contains(e.call(cfg(range)), "\"ok\":true"));
  e.on(60, 0.1, vel);
  e.until(0.7);
  return t13::db(t13::rms(e.L, 0.15, 0.65));
}

}  // namespace

TEST_SUITE("bridge_dynrange") {
  TEST_CASE("hello: minor 4 with the dynamicRange capability (contract README: additive = minor + capability)") {
    Eng e(false);
    const std::string h = e.call(R"({"v":1,"op":"hello","protocol":1,"id":12})");
    const std::size_t mi = h.find("\"minor\":");
    REQUIRE(mi != std::string::npos);
    CHECK(std::strtol(h.c_str() + mi + 8, nullptr, 10) >= 4);
    CHECK(contains(h, "\"dynamicRange\""));
    CHECK(contains(h, "\"droneFreeze\""));  // minor 3 stays
  }

  TEST_CASE("config {dynamicRange}: echoed as the range in force (validDynRange), in get state, type-checked") {
    Eng e;
    CHECK(contains(e.call(cfg("2.345")), "\"dynamicRange\":2.35"));
    CHECK(contains(e.call(R"({"v":1,"op":"get","what":"state","id":9})"), "\"dynamicRange\":2.35"));
    CHECK(contains(e.call(cfg("0.2")), "\"dynamicRange\":1"));
    CHECK(contains(e.call(cfg("9")), "\"dynamicRange\":6"));  // TOUCH (D43): 1..6
    CHECK(e.model().dynamicRange() == 6.0);
    // a non-number is refused by the schema (the store never sends one) and leaves the range alone
    CHECK(contains(e.call(cfg("\"wide\"")), "bad-request"));
    CHECK(contains(e.call(cfg("true")), "bad-request"));
    CHECK(e.model().dynamicRange() == 6.0);
    // with other fields in the same message (the controller sends one field per message; the wire allows more)
    const std::string r = e.call(R"({"v":1,"op":"config","id":31,"droneFreeze":false,"dynamicRange":1.5})");
    CHECK(contains(r, "\"dynamicRange\":1.5"));
    CHECK(contains(r, "\"ok\":true"));
    CHECK(e.model().dynamicRange() == 1.5);
    // absent = untouched (an unrelated config message never resets it)
    CHECK_FALSE(contains(e.call(R"({"v":1,"op":"config","id":32,"mono":false})"), "dynamicRange"));
    CHECK(e.model().dynamicRange() == 1.5);
  }

  TEST_CASE("config {dynamicRange} reaches the sampler: soft notes quieter at 3, live and attached-later agree") {
    const double base = noteDb(40, nullptr, true);
    const double before = noteDb(40, "3", true);  // sent before the song: the sampler is attached later
    const double live = noteDb(40, "3", false);   // sent to the live sampler
    const double one = noteDb(40, "1", false);    // 1 = today's sound
    MESSAGE("ep-rhodes vel 40: range 1 " << base << " dB, 3 (before) " << before << " dB, 3 (live) " << live
                                         << " dB, 1 (live) " << one << " dB");
    CHECK(base > -80);                 // the note sounds
    CHECK(before < base - 4);          // velocityDb: span * (range - 1) * (v - pivot) < 0 below the pivot
    CHECK(std::fabs(live - before) < 0.05);
    CHECK(std::fabs(one - base) < 0.05);
  }

  // TOUCH (D43): past 3. The level change against range 1 must be the shared/touch-curve.js velocityDb law, which the
  // web engine's sampler.js uses as it is (test/phase2/touch "web dynamics" checks the same numbers on the web engine):
  //   velocityDb(v, span, r) - velocityDb(v, span, 1) = span · (min(r, 72 / span) - 1) · (v - 0.75), v = vel / 127.
  // Same note, same velocity, same layer: the renders differ only by that gain, so they agree far below 1e-5.
  TEST_CASE("dynamicRange past 3 (TOUCH D43): multi-layer to 60 dB, single layer capped at 72 dB (range 3)") {
    const auto law = [](int vel, double span, double r) {
      return span * (std::min(r, 72.0 / span) - 1) * (vel / 127.0 - 0.75);
    };
    for (const int vel : {20, 40, 64}) {
      const double piano1 = noteDb(vel, "1", false, "salamander-piano");
      const double piano6 = noteDb(vel, "6", false, "salamander-piano");
      const double piano45 = noteDb(vel, "4.5", true, "salamander-piano");
      const double rhodes1 = noteDb(vel, "1", false);
      const double rhodes3 = noteDb(vel, "3", false);
      const double rhodes6 = noteDb(vel, "6", false);
      MESSAGE("vel " << vel << ": salamander 6 - 1 = " << piano6 - piano1 << " dB (law " << law(vel, 10, 6)
                     << "), ep-rhodes 6 - 1 = " << rhodes6 - rhodes1 << " dB (law " << law(vel, 24, 6) << ")");
      CHECK(piano1 > -80);
      CHECK(std::fabs((piano6 - piano1) - law(vel, 10, 6)) < 1e-4);    // 1e-4 dB = 1.2e-5 in amplitude
      CHECK(std::fabs((piano45 - piano1) - law(vel, 10, 4.5)) < 1e-4);  // sent before the song: the same
      CHECK(std::fabs((rhodes6 - rhodes1) - law(vel, 24, 6)) < 1e-4);
      CHECK(std::fabs(rhodes6 - rhodes3) < 1e-4);  // the single-layer cap: 6 plays as 3
    }
  }
}
