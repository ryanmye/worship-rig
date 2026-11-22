// UIB (BUILD_PLAN "UI wave" item 5, T12 O1): the bridge row `config {dynamicRange}` (settings.dynamicRange, 1..3,
// audio.js setDynamicRange). The Model side (validation like shared/touch-curve.js validDynRange, samplers attached
// later) is tested in unit.song / unit.model; this suite proves the wire: hello minor 4 + capability, the reply echo,
// the schema type check, `get state`, and that a live sampler and a sampler attached after the call both hear it.
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
double noteDb(int vel, const char *range, bool pre) {
  Eng e(true, t13::kSR, RIG_REPO_DIR "/app");
  if (pre && range) REQUIRE(contains(e.call(cfg(range)), "\"ok\":true"));
  REQUIRE(e.use(patch({slot("sampler", "ep-rhodes", 1)}, R"("master":{"volume":1})")));
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
    CHECK(contains(e.call(cfg("9")), "\"dynamicRange\":3"));
    CHECK(e.model().dynamicRange() == 3.0);
    // a non-number is refused by the schema (the store never sends one) and leaves the range alone
    CHECK(contains(e.call(cfg("\"wide\"")), "bad-request"));
    CHECK(contains(e.call(cfg("true")), "bad-request"));
    CHECK(e.model().dynamicRange() == 3.0);
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
}
