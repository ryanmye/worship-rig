// T14 unit.wheels: wheels (pickup, virtual glide, swell), the wheel factors on strips / master, and the bend modes
// (model/wheels.cpp) through the bridge on an offline engine. Ports of the JS suites bendPitch, bendModes (pitch /
// morph neutralising), macrosAndWheel, sceneWheelGlide, the swell half of exprCurveAndPedalSwell, getRuntimeState.
#include <cmath>
#include <ctime>
#include <string>
#include <vector>

#include "fx/reverb_service.h"
#include "model/perform.h"
#include "test_model_util.h"
#include "test_perform_probe.h"

using t13::Eng;
using t13::patch;
using t13::slot;

namespace {

constexpr double kSR = t13::kSR;

std::string probe(const std::string &extra = "") {
  return slot("t14probe", "p", 1, extra);
}

struct W {
  Eng e;
  explicit W(const std::vector<std::string> &slots, const std::string &extra = "") {
    REQUIRE(e.use(patch(slots, extra)));
    e.until(0.01);
    t14::clear();
  }
  std::string bend(double x, double when) {
    return e.call(R"({"v":1,"id":21,"op":"play","e":"bend","x":)" + Eng::num(x) + R"(,"when":)" + Eng::num(when) + "}");
  }
  std::string wheel(const char *src, double v, double when, double glide = 0) {
    return e.call(std::string(R"({"v":1,"id":22,"op":"play","e":"wheel","src":")") + src + R"(","value":)" +
                  Eng::num(v) +
                  R"(,"glide":)" + Eng::num(glide) + R"(,"when":)" + Eng::num(when) + "}");
  }
  std::string swell(int start, double when) {
    std::string m = R"({"v":1,"id":23,"op":"play","e":"swell","when":)" + Eng::num(when);
    if (start >= 0) m += std::string(R"(,"start":)") + (start ? "true" : "false");
    return e.call(m + "}");
  }
  double mod() {
    const std::string j = e.model().wheelValuesJson();
    return std::strtod(j.c_str() + j.find("\"mod\":") + 6, nullptr);
  }
};

}  // namespace

TEST_SUITE("wheels") {
  TEST_CASE("pitch bend: x * range on bendEnabled slots, coalesced on 'bend' (bendPitch)") {
    W w({probe(R"("bendEnabled":true)"), probe(R"("bendEnabled":false)")}, R"("bend":{"mode":"pitch","range":4})");
    w.bend(0.5, 0.1);
    w.bend(-0.25, 0.103);  // inside the 10 ms window: applied at the trailing flush with the latest value
    w.e.until(0.15);       // (posted up front, a later write would apply at once and drop the pending one, as JS)
    w.bend(1, 0.2);
    w.e.until(0.3);
    const auto b = t14::callsOf('B');
    REQUIRE(b.size() == 3);
    CHECK(b[0].a == doctest::Approx(2.0));
    CHECK(b[0].frame == std::llround(0.1 * kSR));
    CHECK(b[1].a == doctest::Approx(-1.0));
    CHECK(std::fabs(static_cast<double>(b[1].frame) / kSR - 0.11) < 128 / kSR + 1e-9);
    CHECK(b[2].a == doctest::Approx(4.0));
    for (const auto &c : b) CHECK(c.channel == 0);
    // bendEnabled true in pitch mode re-applies the bend; false freezes the slot at 0
    t14::clear();
    w.e.set("slots.1.bendEnabled", "true", 0.35);
    w.e.set("slots.0.bendEnabled", "false", 0.35);
    w.e.until(0.4);
    const auto b2 = t14::callsOf('B');
    REQUIRE(b2.size() == 2);
    CHECK(b2[0].channel == 1);
    CHECK(b2[0].a == doctest::Approx(4.0));
    CHECK(b2[1].channel == 0);
    CHECK(b2[1].a == 0);
  }

  TEST_CASE("a bend-mode change leaves the old mode neutral; panic re-applies bend 0 (bendModes)") {
    W w({probe(R"("bendEnabled":true)")}, R"("bend":{"mode":"pitch","range":2})");
    w.bend(1, 0.1);
    w.e.until(0.2);
    w.e.call(R"({"v":1,"op":"song","id":5,"routing":{"bend":{"mode":"morph","range":2}},"when":0.25})");
    w.bend(0.5, 0.3);  // morph mode: no pitch bend
    w.e.until(0.4);
    auto b = t14::callsOf('B');
    REQUIRE(b.size() == 2);
    CHECK(b[1].a == 0);  // neutral pitch at the mode change
    CHECK(b[1].frame == std::llround(0.25 * kSR));
    CHECK(w.e.model().perform().bend() == doctest::Approx(0.5));
    CHECK(rig::performBendMorph(w.e.model()) == doctest::Approx(0.5));
    // back to pitch: only the OLD mode is neutralised (audio.js _neutralBend); the pitch follows at the next bend
    t14::clear();
    w.e.call(R"({"v":1,"op":"song","id":5,"routing":{"bend":{"mode":"pitch","range":2}}})");
    w.e.until(0.5);
    CHECK(t14::callsOf('B').empty());
    w.bend(0.25, 0.55);
    w.e.until(0.6);
    REQUIRE(t14::callsOf('B').size() == 1);
    CHECK(t14::callsOf('B')[0].a == doctest::Approx(0.5));
  }

  TEST_CASE("wheel writes: values, `wheel` events, owner, pickup against a virtual owner (macrosAndWheel)") {
    W w({probe()});
    std::string r = w.wheel("expr", 0.4, 0.1);
    CHECK(rigtest::contains(r, R"("ev":"wheel","source":"expr","value":0.4)"));
    r = w.wheel("virtual", 0.5, 0.2);
    CHECK(rigtest::contains(w.e.model().wheelValuesJson(), R"("owner":"virtual")"));
    r = w.wheel("mod", 0.1, 0.3);  // far from the virtual value: refused, reported with pickup
    CHECK(rigtest::contains(r, R"("ev":"wheel","source":"mod","value":0.5,"hardware":0.1)"));
    CHECK(rigtest::contains(r, R"("pickup":true})"));
    CHECK(rigtest::contains(r, R"("ok":false)"));
    r = w.wheel("mod", 0.3, 0.31);  // still below, not crossed
    CHECK(rigtest::contains(r, R"("pickup":true)"));
    r = w.wheel("mod", 0.6, 0.32);  // crossed the virtual value: hardware takes over
    CHECK(rigtest::contains(r, R"("ev":"wheel","source":"mod","value":0.6})"));
    CHECK(rigtest::contains(w.e.model().wheelValuesJson(), R"("owner":"hw")"));
    w.wheel("virtual", 0.2, 0.4);
    r = w.wheel("mod", 0.22, 0.41);  // within +-0.03: takes over at once
    CHECK(rigtest::contains(r, R"("value":0.22})"));
    CHECK(rigtest::contains(w.e.model().runtimeStateJson(), R"("wheel":{"mod":0.22,"expr":0.4,"vol":1})"));
    CHECK(rigtest::contains(w.e.call(R"({"v":1,"id":24,"op":"play","e":"wheel","src":"bogus","value":1})"),
                            R"("ok":false)"));
  }

  TEST_CASE("virtual glide walks in 25 ms steps on the audio clock; a hardware takeover ends it (sceneWheelGlide)") {
    W w({probe()});
    w.wheel("virtual", 0, -1);
    w.e.until(0.1);
    w.wheel("virtual", 1, 0.2, 0.4);
    w.e.until(0.4);
    const double mid = w.mod();
    CHECK(mid > 0.35);
    CHECK(mid < 0.65);
    w.e.until(0.7);
    CHECK(w.mod() == doctest::Approx(1.0));
    w.wheel("virtual", 0, 0.8, 1.0);
    w.e.until(1.0);
    const double m1 = w.mod();
    w.wheel("mod", m1, -1);  // the hardware wheel at the glide's value takes over and stops the glide
    w.e.until(1.5);
    CHECK(w.mod() == doctest::Approx(m1));
  }

  TEST_CASE("swell: 60 ms dip, 0 -> 1 over swell.seconds in 50 ms steps, back to the pre-swell value over 4 s") {
    W w({probe()}, R"("swell":{"seconds":1})");
    w.wheel("mod", 0.6, -1);
    w.e.until(0.1);
    w.swell(-1, 0.2);  // toggle = start
    CHECK(rigtest::contains(w.e.model().wheelValuesJson(), R"("swelling":true)"));
    w.e.until(0.26);  // the second step (50 ms) is inside the 60 ms dip
    CHECK(w.mod() < 0.15);
    w.e.until(0.7);
    CHECK(w.mod() == doctest::Approx(0.5).epsilon(0.12));
    w.e.until(1.3);
    CHECK(w.mod() == doctest::Approx(1.0));
    w.swell(-1, 1.4);  // toggle = back
    w.e.until(3.4);
    CHECK(w.mod() == doctest::Approx(0.8).epsilon(0.05));
    w.e.until(5.6);
    CHECK(w.mod() == doctest::Approx(0.6));
    CHECK(rigtest::contains(w.e.model().wheelValuesJson(), R"("swelling":false)"));
    CHECK(rigtest::contains(w.swell(0, 5.7), R"("ok":false)"));  // nothing to undo
  }

  TEST_CASE("the mod wheel scales its routed strip, the volume wheel the master (audio, test voice)") {
    Eng e;
    const std::string routing =
        R"("modWheel":{"target":"slots.0.gain","min":0,"max":1},"volume":{"target":"master.volume"})";
    REQUIRE(e.use(patch({slot("test", "sine", 1)}, routing)));
    e.on(69, 0.02);
    e.until(0.5);
    const double full = t13::rms(e.L, 0.3, 0.5);
    REQUIRE(full > 1e-3);
    e.call(R"({"v":1,"op":"play","e":"wheel","src":"mod","value":0.5,"when":0.5})");
    e.until(1.0);
    CHECK(t13::rms(e.L, 0.8, 1.0) / full == doctest::Approx(0.5).epsilon(0.03));
    e.call(R"({"v":1,"op":"play","e":"wheel","src":"vol","value":0.5,"when":1.0})");
    e.until(1.5);
    CHECK(t13::rms(e.L, 1.3, 1.5) / full == doctest::Approx(0.25).epsilon(0.05));
  }
  TEST_CASE("CPU: lofi with the tape-bend delay timeline (2 evaluations per quantum), perform control calls") {
    auto threadUs = [] {
      timespec ts{};
      clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts);
      return static_cast<double>(ts.tv_sec) * 1e6 + static_cast<double>(ts.tv_nsec) / 1e3;
    };
    auto perQuantum = [&](bool lofi, bool tape) {
      Eng e;
      const std::string fx = lofi ? R"("fx":{"lofi":{"amount":0.5}},"bend":{"mode":"tape","range":2})" : "";
      REQUIRE(e.use(patch({slot("test", "sine", 1)}, fx)));
      e.on(69, 0.01);
      if (tape) e.call(R"({"v":1,"id":3,"op":"play","e":"bend","x":-0.5,"when":0.05})");
      e.until(0.2);
      std::vector<float> l(128), r(128);
      float *p2[2] = {l.data(), r.data()};
      const double t0 = threadUs();
      for (int i = 0; i < 400; ++i) rig_offline_render(e.e, p2, 2, 128);
      return (threadUs() - t0) / 400;
    };
    const double base = perQuantum(false, false), lofi = perQuantum(true, false), tape = perQuantum(true, true);
    MESSAGE("per 128-frame quantum: test voice " << base << " us; + lofi engaged " << lofi - base
                                                 << " us; + lofi with a tape-bend ramp " << tape - base << " us");
    CHECK(tape - base < 400);  // loose sanity bound (2-CPU shared box); the numbers go into the T14 report
    Eng e;
    REQUIRE(e.use(patch({probe(), probe(R"("mono":"lowest")"), probe(), probe(R"("highNote":127)")})));
    const double c0 = threadUs();
    for (int i = 0; i < 500; ++i) {
      e.model().noteOn(40 + i % 40, 90, -1);
      e.model().noteOff(40 + i % 40, -1);
    }
    MESSAGE("Model::noteOn + noteOff (4 slots, control thread, incl. events): " << (threadUs() - c0) / 500 << " us");
  }
  TEST_CASE("washAcrossCommit: macro.wash moves the reverb size; a commit lands on the washed space (T14 + T04)") {
    Eng e;
    const std::string wash = R"("modWheel":{"target":"macro.wash","min":0,"max":1},"fx":{"reverb":{"size":0.3}})";
    REQUIRE(e.use(patch({slot("test", "sine", 1)}, wash)));
    auto *rp = dynamic_cast<rig::fx::ReverbPool *>(e.model().service<rig::ReverbService>());
    REQUIRE(rp);
    e.call(R"({"v":1,"id":3,"op":"play","e":"wheel","src":"mod","value":0,"when":0.05})");
    e.until(0.5);
    CHECK(rp->targetKey() == rp->irKeyFor(0.3, 0.5));
    e.call(R"({"v":1,"id":3,"op":"play","e":"wheel","src":"mod","value":1,"when":0.6})");
    e.until(1.5);  // Reverb.request: 300 ms debounce, then build + crossfade
    CHECK(rp->targetKey() == rp->irKeyFor(0.9, 0.5));
    // the next song with the same wash routing: prepare stages and commit lands on lerp(0.5, .9, 1) = 0.9 directly
    const std::string wash2 = R"("modWheel":{"target":"macro.wash","min":0,"max":1},"fx":{"reverb":{"size":0.5}})";
    REQUIRE(e.use(patch({slot("test", "saw", 1)}, wash2)));
    CHECK(rp->targetKey() == rp->irKeyFor(0.9, 0.5));
    // a song without wash: its own size
    REQUIRE(e.use(patch({slot("test", "sine", 1)}, R"("fx":{"reverb":{"size":0.5}})")));
    CHECK(rp->targetKey() == rp->irKeyFor(0.5, 0.5));
  }
}
