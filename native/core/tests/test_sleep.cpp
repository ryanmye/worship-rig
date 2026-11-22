// T14 W3A unit.sleep: audio sleep / wake queueing (model/sleep.{h,cpp}; audio.js sleep / wake / _sleepHold /
// sleepBlockers, lowres2) on an offline engine that pretends realtime (Sleep::setTestRealtime: the renders keep the
// time running while "asleep"), plus the realtime engine path (`audio sleep|wake`, `play` while asleep). Port of the
// engine half of the JS suite audioSleep (test/phase1/engine/realtime suites); the controller's sleep clock is UI.
#include <atomic>
#include <chrono>
#include <cmath>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "model/perform.h"
#include "model/sleep.h"
#include "test_model_util.h"
#include "test_perform_probe.h"

using t13::Eng;
using t13::patch;
using t13::slot;
using Clock = std::chrono::steady_clock;

namespace {

constexpr double kSR = t13::kSR;

std::int64_t fr(double t) {
  return std::llround(t * kSR);
}

/** Offline engine (test sine on slot 0, probe on slot 1) that sleeps like a realtime one. */
struct S {
  Eng e;
  S() {
    REQUIRE(e.use(patch({slot("test", "sine", 1), slot("t14probe", "p", 1)})));
    e.until(0.01);
    e.model().perform().sleeper().setTestRealtime(true);
    t14::clear();
  }
  rig::Model &m() { return e.model(); }
  std::string st() { return m().sleepState(); }
  double now() { return m().now(); }
};

/** Realtime engine paced by a fake platform thread (test_runtime.cpp RtEngine, reduced). */
struct Rt {
  rig_engine *e = nullptr;
  std::mutex mu;
  std::string all;
  std::atomic<bool> stop{false};
  std::thread audio;
  Rt() {
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.mode = RIG_MODE_REALTIME;
    cfg.sample_rate = 48000;
    cfg.on_event = [](void *u, const char *j, size_t n) {
      auto *r = static_cast<Rt *>(u);
      std::lock_guard<std::mutex> lk(r->mu);
      r->all.append(j, n);
    };
    cfg.event_user = this;
    e = rig_create(&cfg, nullptr);
    REQUIRE(e != nullptr);
  }
  ~Rt() {
    stop = true;
    if (audio.joinable()) audio.join();
    rig_destroy(e);
  }
  void post(const std::string &m) { REQUIRE(rig_post(e, m.data(), m.size()) == RIG_OK); }
  bool waitFor(const std::string &needle, int ms = 3000) {
    const auto end = Clock::now() + std::chrono::milliseconds(ms);
    while (Clock::now() < end) {
      {
        std::lock_guard<std::mutex> lk(mu);
        if (all.find(needle) != std::string::npos) return true;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return false;
  }
  void startAudio(unsigned block = 256) {
    audio = std::thread([this, block] {
      std::vector<float> l(block), r(block);
      float *p[2] = {l.data(), r.data()};
      auto next = Clock::now();
      std::uint64_t host = 1'000'000'000;
      while (!stop) {
        rig_render(e, p, 2, block, host);
        host += static_cast<std::uint64_t>(block * 1e9 / 48000);
        next += std::chrono::nanoseconds(static_cast<long long>(block * 1e9 / 48000));
        std::this_thread::sleep_until(next);
      }
    });
  }
};

}  // namespace

TEST_SUITE("sleep") {
  TEST_CASE("an offline engine never sleeps and never queues (audio.js: realtime only); blockers = ['no-audio']") {
    Eng e;
    REQUIRE(e.use(patch({slot("t14probe", "p", 1)})));
    e.until(0.01);
    t14::clear();
    CHECK_FALSE(e.model().sleep(0.05));
    CHECK(std::string(e.model().sleepState()) == "awake");
    CHECK(e.model().sleepBlockersJson() == R"(["no-audio"])");
    CHECK_FALSE(e.model().wake(NAN));  // awake: nothing to do
    e.on(60, 0.05);
    e.until(0.1);
    CHECK(t14::callsOf('N').size() == 1);
    // bridge: `audio sleep` answers done:false offline (contract 1.1), wake is idempotent
    CHECK(rigtest::contains(e.call(R"({"v":1,"op":"audio","action":"sleep","id":5})"), "\"done\":false"));
    CHECK(rigtest::contains(e.call(R"({"v":1,"op":"audio","action":"wake","id":6})"), "\"done\":true"));
  }

  TEST_CASE("sleep: out ramps 1 -> 0 from now + 10 ms over the ramp, then asleep; wake ramps back over 60 ms") {
    S s;
    s.e.on(69, 0.02);
    s.e.until(0.3);
    const double full = t13::rms(s.e.L, 0.2, 0.3);
    REQUIRE(full > 1e-3);
    const double t0 = s.now();
    CHECK(s.m().sleepBlockersJson() == R"(["voices"])");
    REQUIRE(s.m().sleep(0.1));
    CHECK(s.st() == "sleeping");
    CHECK_FALSE(s.m().sleep(0.1));  // only from awake
    s.e.until(t0 + 0.05);
    CHECK(s.st() == "sleeping");
    s.e.until(t0 + 0.2);
    CHECK(s.st() == "asleep");  // t0 + 10 ms lead + 100 ms ramp + 5 ms
    // the ramp: full before t0 + 10 ms, about half at its middle, digital silence after it (x * 0 = 0)
    CHECK(t13::rms(s.e.L, t0 - 0.02, t0 + 0.005) / full == doctest::Approx(1).epsilon(0.02));
    CHECK(t13::rms(s.e.L, t0 + 0.055, t0 + 0.065) / full == doctest::Approx(0.5).epsilon(0.1));
    CHECK(t13::rms(s.e.L, t0 + 0.111, t0 + 0.2) == 0.0);
    const double t1 = s.now();
    CHECK(s.m().wake(NAN));
    CHECK(s.st() == "awake");
    CHECK_FALSE(s.m().wake(NAN));  // idempotent
    s.e.until(t1 + 0.3);
    // the test voice decays slowly while held: compare with the level just before the sleep ramp, loosely, and
    // check that the ramp is over (flat) after 70 ms
    CHECK(t13::rms(s.e.L, t1 + 0.071, t1 + 0.3) / full > 0.9);
    CHECK(t13::rms(s.e.L, t1 + 0.2, t1 + 0.3) / t13::rms(s.e.L, t1 + 0.08, t1 + 0.18) ==
          doctest::Approx(1).epsilon(0.02));
    CHECK(t13::rms(s.e.L, t1, t1 + 0.009) < 1e-6);  // the wake ramp starts 10 ms ahead (ramp lead)
    const std::string st = s.m().statsJson();
    CHECK(rigtest::contains(st, R"("audioSleep":"awake")"));
    CHECK(rigtest::contains(st, R"("lastWake":{"ms":)"));
    CHECK(rigtest::contains(st, R"("queued":0,"ramp":0.06,)"));
  }

  TEST_CASE("_sleepHold: a noteOn while asleep wakes the audio and plays at the 5 ms wake ramp's start") {
    S s;
    REQUIRE(s.m().sleep(0.05));
    s.e.until(s.now() + 0.2);
    REQUIRE(s.st() == "asleep");
    const double t1 = s.now();
    t14::clear();
    s.e.on(64, t1 + 0.5);  // its own `when` is dropped: queued calls replay at the ramp start (audio.js wake)
    CHECK(s.st() == "awake");
    s.e.off(64, t1 + 0.1);  // awake again: plays at its own time
    s.e.until(t1 + 0.3);
    const auto on = t14::callsOf('N', 1), off = t14::callsOf('F', 1);
    REQUIRE(on.size() == 1);
    CHECK(on[0].note == 64);
    CHECK(on[0].frame == fr(t1 + 0.01));
    REQUIRE(off.size() == 1);
    CHECK(off[0].frame == fr(t1 + 0.1));
    const std::string st = s.m().statsJson();
    CHECK(rigtest::contains(st, R"("queued":1,"ramp":0.005)"));
  }

  TEST_CASE("_sleepHold: pedal and note-off while sleeping cancel the sleep; queued calls replay in order") {
    S s;
    s.e.on(60, 0.02);
    s.e.until(0.2);
    const double t0 = s.now();
    REQUIRE(s.m().sleep(0.15));
    t14::clear();
    s.e.pedal(true, t0 + 0.02);  // sleeping: held, then the wake replays it (state awake again)
    CHECK(s.st() == "awake");
    CHECK(s.m().perform().pedal());
    s.e.off(60, t0 + 0.03);  // pedal down: held by the pedal (sustain slot)
    s.e.until(t0 + 0.5);
    CHECK(s.st() == "awake");  // the sleep's timer found a newer seq: no suspend
    CHECK(s.m().perform().pedaledCount() >= 1);
    CHECK(s.m().sleepBlockersJson().find("\"pedal\"") != std::string::npos);
    // audio: the 5 ms wake ramp (no noteOn queued: 60 ms) took `out` back from mid-ramp, the note still sounds
    CHECK(t13::rms(s.e.L, t0 + 0.3, t0 + 0.5) > 1e-3);
  }

  TEST_CASE("blockers: voices (held, pedaled, live voices), pedal, click; empty when nothing plays") {
    S s;
    CHECK(s.m().sleepBlockersJson() == "[]");
    s.e.on(60, 0.02);
    s.e.until(0.1);
    CHECK(s.m().sleepBlockersJson() == R"(["voices"])");
    s.e.off(60, 0.1);
    s.e.until(2.5);  // the test voice's release has ended
    CHECK(s.m().sleepBlockersJson() == "[]");
    s.e.pedal(true, 2.5);
    CHECK(s.m().sleepBlockersJson() == R"(["pedal"])");
    s.e.pedal(false, 2.6);
    s.e.call(R"({"v":1,"op":"song","id":9,"tempo":120})");
    s.e.call(R"({"v":1,"op":"click","id":10,"action":"start","when":2.7})");
    s.e.until(2.9);
    CHECK(s.m().sleepBlockersJson().find("\"click\"") != std::string::npos);
  }

  TEST_CASE("realtime: audio sleep -> asleep (no render, no ticks), a played note wakes it with queued 1") {
    Rt rt;
    rt.post(R"({"v":1,"op":"hello","protocol":1,"app":"t","id":1})");
    REQUIRE(rt.waitFor("\"re\":1,"));
    rt.post(R"({"v":1,"op":"audio","action":"start","id":2})");
    REQUIRE(rt.waitFor("\"re\":2,"));
    rt.startAudio();
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    rt.post(R"({"v":1,"op":"audio","action":"sleep","ramp":0.03,"id":3})");
    REQUIRE(rt.waitFor("\"sleep\":\"sleeping\""));
    REQUIRE(rt.waitFor("\"sleep\":\"asleep\"", 2000));
    rt.post(R"({"v":1,"op":"play","e":"on","n":60,"vel":90})");
    REQUIRE(rt.waitFor("\"queued\":1"));
    CHECK(rt.waitFor("\"wakeMs\":"));
    std::lock_guard<std::mutex> lk(rt.mu);
    const std::size_t last = rt.all.rfind("\"ev\":\"state\"");  // the wake's state event is the latest one
    REQUIRE(last != std::string::npos);
    const std::string ev = rt.all.substr(last, rt.all.find('}', last) - last);
    CHECK(rigtest::contains(ev, "\"sleep\":\"awake\""));
    CHECK(rigtest::contains(ev, "\"queued\":1"));
  }
}
