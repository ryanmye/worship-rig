// T16 frozen drone (DECISIONS D5; drone-freeze.js, suites.mjs droneFreeze): renderDroneLoop and its seam, the
// freeze state machine on an offline engine (the test flag `__freezeOptions.realtime` lets it freeze; the render runs
// inline instead of on the worker), the worker itself, and the drone-freeze fixture hook.
#include <atomic>
#include <cmath>
#include <string>
#include <thread>
#include <vector>

#include "drone/drone_core.h"
#include "drone/drone_service.h"
#include "drone/drone_unit.h"
#include "helpers.h"
#include "test_click_detector.h"
#include "test_drone_util.h"
#include "test_model_util.h"

using namespace t16;

namespace {

double powerDb(const t13::Eng &e, double a, double b) {
  const auto i0 = static_cast<std::size_t>(a * t13::kSR), i1 = static_cast<std::size_t>(b * t13::kSR);
  double s = 0;
  for (std::size_t i = i0; i < i1 && i < e.L.size(); ++i) s += 0.5 * (e.L[i] * e.L[i] + e.R[i] * e.R[i]);
  return 10 * std::log10(s / static_cast<double>(i1 - i0) + 1e-30);
}

rig::drone::LoopRequest request(bool wet) {
  rig::drone::LoopRequest r;
  r.seed = 1;
  r.sampleRate = 44100;
  r.pc = 2;
  r.brightness = 0.4;
  r.movement = 0.3;
  r.width = 0.75;
  r.trimDb = -8.5;
  r.loopSec = 4;
  r.prerollSec = 4;
  r.seamSec = 1.5;
  if (wet) {
    r.reverb.hasIr = true;
    r.reverb.size = 0.42;
    r.reverb.damp = 0.5;
    r.reverb.predelay = 0.025;
    r.reverb.wet = 1;
  }
  return r;
}

}  // namespace

TEST_SUITE("drone_freeze") {
  TEST_CASE("renderDroneLoop: 4 s loop, seamless wrap, deterministic, dry and wet") {
    const rig::drone::LoopResult dry = rig::drone::renderDroneLoop(request(false));
    const rig::drone::LoopResult dry2 = rig::drone::renderDroneLoop(request(false));
    const rig::drone::LoopResult wet = rig::drone::renderDroneLoop(request(true));
    REQUIRE(dry.buffer);
    REQUIRE(wet.buffer);
    CHECK(dry.buffer->sb.frames == 176400);
    CHECK(dry.loopSec == doctest::Approx(4.0));
    CHECK(dry.bytes == 176400u * 8);
    CHECK(dry.seamOk);
    CHECK(wet.seamOk);
    CHECK(rigtest::maxAbsDiff(dry.buffer->data[0], dry2.buffer->data[0]) == 0.0);
    // the loop played twice: no click across the wrap
    std::vector<float> m(dry.buffer->data[0].size() * 2);
    for (std::size_t i = 0; i < dry.buffer->data[0].size(); ++i)
      m[i] = m[i + dry.buffer->data[0].size()] = 0.5f * (dry.buffer->data[0][i] + dry.buffer->data[1][i]);
    // the real drone-osc trips the click detector on its own now and then: none may sit at the wrap (t = 4 s)
    for (const auto &c : rigtest::clicks(m, 44100, 0.01, static_cast<double>(m.size()) / 44100))
      CHECK(std::fabs(c.t - 4.0) > 0.02);
    CHECK(dry.seamDelta <= dry.bodyDelta);
    CHECK(rig::drone::freezeLoopFrames(48000, 20) == 960000);
    CHECK(rig::drone::freezeLoopFrames(48000, 100) == 1440000);  // 30 s cap (11 MB < 12 MB)
    CHECK(rig::drone::freezeLoopFrames(96000, 30) == 12 * 1024 * 1024 / 8);  // the byte cap
  }

  TEST_CASE("makeSeamlessLoop: correlated head/tail keep their level through the seam (CI-1)") {
    std::vector<float> c(3000);
    for (std::size_t i = 0; i < c.size(); ++i) c[i] = static_cast<float>(std::sin(2 * kPi * 0.01 * i));
    const double rho = rig::drone::seamCorrelation(c.data(), 100, 2000, 400);
    CHECK(rho == doctest::Approx(1.0).epsilon(1e-6));  // 2000 samples = 20 periods: head = tail
    rig::drone::makeSeamlessLoop(c.data(), 100, 2000, 400);
    double peak = 0;
    for (std::size_t i = 100; i < 500; ++i) peak = std::max(peak, std::fabs(static_cast<double>(c[i])));
    CHECK(peak == doctest::Approx(1.0).epsilon(0.01));  // equal gain (rho = 1), not +3 dB
    const float *ch[1] = {c.data() + 100};
    CHECK(rig::drone::seamCheck(ch, 1, 2000).ok);
  }

  TEST_CASE("droneFreeze: low resource freezes the live drone (level within 1 dB), key change goes live, thaw") {
    t13::Eng e;
    REQUIRE(e.use(t13::patch({}, R"("fx":{"reverb":{"size":0.1}})")));
    droneConfig(e, R"({"__freezeOptions":{"loopSec":4,"prerollSec":3.5,"realtime":true}})", 0);
    droneConfig(e, R"({"mode":"synth","gain":0.5,"fade":0.3})", 0);
    droneKey(e, 2, false, 0);
    auto *s = service(e);
    e.until(3.5);
    e.until(9.5);
    const double live = powerDb(e, 3.5, 9.5);
    const unsigned liveVoices = s->unitForTests()->liveVoices();
    e.call(R"({"v":1,"op":"config","id":5,"lowResource":true})");
    double t = 9.5;
    while (t < 30 && !(s->core()->frozen() && s->unitForTests()->liveVoices() == 0 && s->core()->layerCount() == 0))
      e.until(t += 0.1);
    REQUIRE(s->core()->frozen());
    const std::string st = e.call(R"({"v":1,"op":"get","id":6,"what":"stats"})");
    CHECK(rigtest::contains(st, "\"droneFrozen\":true"));
    CHECK(rigtest::contains(st, "\"droneLoopSec\":4"));
    CHECK(s->core()->renders() == 1);
    e.until(t + 4);
    const double frozenDb = powerDb(e, t, t + 4);
    CHECK(liveVoices > 0);
    CHECK(std::fabs(frozenDb - live) < 1.0);
    auto *u = const_cast<rig::drone::DroneUnit *>(s->unitForTests());
    CHECK(u->param(rig::kDroneSendGate)->intrinsic() < 1e-6);  // the loop carries its own reverb
    std::vector<float> d = mono(e);
    // a key change goes through the live synth at once, and freezes again after the debounce
    t += 4;
    droneKey(e, 7, false, t);
    CHECK_FALSE(s->core()->frozen());
    e.until(t + 1);
    CHECK(s->unitForTests()->liveVoices() > 0);
    double t2 = t;
    while (t2 < t + 15 && !s->core()->frozen()) e.until(t2 += 0.1);
    CHECK(s->core()->frozen());
    CHECK(s->core()->renders() == 2);
    // low resource off: the live synth comes back (its attack first), the loop fades
    e.until(t2 + 1);
    e.call(R"({"v":1,"op":"config","id":5,"lowResource":false})");
    CHECK_FALSE(s->core()->frozen());
    e.until(t2 + 6);
    CHECK(s->unitForTests()->liveVoices() > 0);
    CHECK_FALSE(u->loopPlaying(0));
    CHECK_FALSE(u->loopPlaying(1));
    CHECK(u->param(rig::kDroneSendGate)->intrinsic() == doctest::Approx(0.4).epsilon(1e-6));
    // on again with nothing changed: the kept loop swaps back in without a render
    e.call(R"({"v":1,"op":"config","id":5,"lowResource":true})");
    double t3 = t2 + 6;
    while (t3 < t2 + 20 && !s->core()->frozen()) e.until(t3 += 0.1);
    CHECK(s->core()->frozen());
    CHECK(s->core()->renders() == 2);
    CHECK(s->core()->reused() >= 1);
    d = mono(e);
    CHECK(t13::minWindowDb(d, 4, t3) > -60);
  }

  TEST_CASE("droneFreeze off (config droneFreeze false), chord-follow and files are never frozen") {
    t13::Eng e;
    droneConfig(e, R"({"__freezeOptions":{"loopSec":2,"prerollSec":1,"realtime":true}})", 0);
    droneConfig(e, R"({"mode":"synth","gain":0.5,"fade":0.3})", 0);
    droneKey(e, 0, false, 0);
    auto *s = service(e);
    e.call(R"({"v":1,"op":"config","id":5,"droneFreeze":false,"lowResource":true})");
    e.until(8);
    CHECK_FALSE(s->core()->frozen());
    CHECK(s->core()->renders() == 0);
    droneConfig(e, R"({"chordFollow":true})", 8);
    e.call(R"({"v":1,"op":"config","id":5,"droneFreeze":true})");
    e.until(14);
    CHECK_FALSE(s->core()->frozen());
    droneConfig(e, R"({"chordFollow":false})", 14);
    double t = 14;
    while (t < 26 && !s->core()->frozen()) e.until(t += 0.1);
    CHECK(s->core()->frozen());
  }

  TEST_CASE("drone-freeze fixture hook: the loop plays alone at unit level, equal to renderDroneLoop") {
    for (bool wet : {false, true}) {
      t13::Eng e;
      e.call(R"({"v":1,"op":"drone","id":8,"config":{"__freezeTest":{"key":{"pc":2,"minor":false},)"
             R"("params":{"brightness":0.4,"movement":0.3,"width":0.75},"loopSec":4,"prerollSec":4,"seamSec":1.5,)"
             R"("reverb":)" +
             std::string(wet ? R"({"size":0.42,"damp":0.5,"predelay":0.025,"wet":1})" : "null") + "}},\"when\":0}");
      REQUIRE(rig_test_tap(e.e, "fx.sum") == RIG_OK);
      e.until(4);
      rig::drone::LoopRequest req = request(wet);
      req.trimDb = 0;  // the test engine has no app dir: gain-trims.json is not read
      req.seed = 7;    // t13::Eng's engine seed
      const rig::drone::LoopResult ref = rig::drone::renderDroneLoop(req);
      std::vector<float> L(e.L.begin(), e.L.begin() + 176400);
      CHECK(rigtest::maxAbsDiff(L, ref.buffer->data[0]) == 0.0);
    }
  }

  TEST_CASE("DroneWorker: renders on its thread while the caller renders too (TSan)") {
    rig::drone::DroneWorker w;
    std::atomic<int> done{0};
    rig::drone::LoopResult a;
    rig::drone::LoopRequest req = request(true);
    req.loopSec = 1;
    req.prerollSec = 0.5;
    w.post([&]() -> std::function<void()> {
      auto r = rig::drone::renderDroneLoop(req);
      return [&, r] {
        a = r;
        done.fetch_add(1);
      };
    });
    const rig::drone::LoopResult b = rig::drone::renderDroneLoop(req);  // same inputs, this thread
    while (done.load() == 0) {
      w.drain();
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    REQUIRE(a.buffer);
    CHECK(rigtest::maxAbsDiff(a.buffer->data[1], b.buffer->data[1]) == 0.0);
    CHECK(w.outstanding() == 0);
  }
}
