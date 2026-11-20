// wa::Param semantics that the Chromium vectors do not isolate: argument validation (JS throws → false), capacity and
// pruning, cancel semantics, k-rate sampling per quantum, hasSampleAccurateValues, clamping, the automation helpers'
// event sequences, Timer and Coalescer.
#include <cmath>
#include <string>
#include <vector>

#include "doctest.h"
#include "time/automation.h"
#include "time/coalescer.h"
#include "time/param.h"
#include "time/timer.h"

using namespace rig::wa;

namespace {
std::vector<float> render(Param &p, double sr, std::size_t frames, Param::Rate rate = Param::Rate::ARate) {
  std::vector<float> out(frames);
  for (std::size_t f = 0; f < frames; f += Param::kQuantum)
    p.process(rate, static_cast<std::int64_t>(f), sr, out.data() + f, std::min(Param::kQuantum, frames - f));
  return out;
}
}  // namespace

TEST_SUITE("time") {
  TEST_CASE("validation: what JS rejects returns false and schedules nothing") {
    Param p(0.0);
    CHECK(!p.setValueAtTime(NAN, 0));
    CHECK(!p.setValueAtTime(1, -1));
    CHECK(!p.setValueAtTime(1e39, 0));  // WebIDL float overflow
    CHECK(!p.exponentialRampToValueAtTime(0, 1));
    CHECK(!p.setTargetAtTime(1, 0, -0.1));
    CHECK(!p.setValueCurveAtTime(nullptr, 0, 0, 1));
    const float c[2] = {0, 1};
    CHECK(!p.setValueCurveAtTime(c, 2, 0, 0));
    CHECK(p.eventCount() == 0);
    CHECK(p.setTargetAtTime(0.5, 0, 0));  // tau 0 = setValueAtTime
    CHECK(p.eventCount() == 1);
  }

  TEST_CASE("first ramp on an empty timeline starts from the intrinsic value at the call time") {
    Param p(0.25);
    CHECK(p.linearRampToValueAtTime(1.0, 128.0 / 1000));
    CHECK(p.eventCount() == 2);  // implicit setValueAtTime(0.25, now) + the ramp
    const auto v = render(p, 1000, 256);
    CHECK(v[0] == 0.25f);
    CHECK(v[64] == doctest::Approx(0.25 + 0.75 * 0.5));
    CHECK(v[200] == 1.0f);
  }

  TEST_CASE("k-rate: one value per quantum, taken at the quantum start") {
    Param p(0.0);
    p.setValueAtTime(0, 0);
    p.linearRampToValueAtTime(1, 1.0);
    const auto v = render(p, 1280, 1280, Param::Rate::KRate);
    for (std::size_t q = 0; q < 10; ++q) {
      for (std::size_t i = 0; i < 128; ++i) CHECK(v[q * 128 + i] == v[q * 128]);
      CHECK(v[q * 128] == doctest::Approx(q * 128.0 / 1280).epsilon(1e-6));
    }
  }

  TEST_CASE("rendered a-rate values follow the spec formula (valueAt) when every quantum is rendered") {
    // Replacement for test_param.cpp "a-rate block equals per-sample valueAt": every quantum must be rendered (the
    // setTarget recursion is stateful). k-rate is NOT the spec value at the quantum start when a setTarget begins
    // mid-quantum: Chromium steps it from the previous quantum's value by a whole control period (here 0.395 instead
    // of 0.787 at frame 512); time_automation_test.cpp checks k-rate against Chromium instead.
    const double sr = 48000;
    auto make = [] {
      Param p(0.0);
      p.setValueAtTime(0.0, 0.0);
      p.linearRampToValueAtTime(1.0, 0.01);
      p.setTargetAtTime(0.25, 0.01, 0.002);
      return p;
    };
    Param a = make();
    const Param ref = make();
    float buf[128];
    for (std::int64_t f0 = 0; f0 <= 1024; f0 += 128) {
      a.processARate(f0, sr, buf, 128);
      for (int i = 0; i < 128; ++i) CHECK(buf[i] == doctest::Approx(ref.valueAt((f0 + i) / sr)).epsilon(2e-6));
    }
    Param k = make();
    CHECK(k.processKRate(0, sr) == 0.0f);
    CHECK(k.processKRate(128, sr) == doctest::Approx(128.0 / 480).epsilon(1e-6));  // linear: exact at the start
  }

  TEST_CASE("setTarget converges and snaps to the target after 10 tau") {
    Param p(1.0);
    p.setTargetAtTime(0, 0, 0.01);
    const auto v = render(p, 1000, 1024);
    CHECK(v[5] == doctest::Approx(std::exp(-0.5)).epsilon(1e-5));
    CHECK(v[1000] == 0.0f);
    CHECK(!p.settledAt(10));  // a SetTarget never ends by itself (Q2: rampTo pins it)
  }

  TEST_CASE("rampTo pins the end: the timeline is settled after 12 tau") {
    Param p(0.2);
    rampTo(p, 1.0, 0.0, 0.015);
    CHECK(p.eventCount() == 2);
    CHECK(p.settledAt(12 * 0.015 + 1e-9));
    const auto v = render(p, 48000, 48000 / 4);
    CHECK(v.back() == 1.0f);
  }

  TEST_CASE("cancelAndHold mid linear ramp holds the reached value; a new ramp continues from there") {
    Param p(0.0);
    p.setValueAtTime(0, 0);
    p.linearRampToValueAtTime(1, 1);
    p.cancelAndHoldAtTime(0.5);
    p.linearRampToValueAtTime(0, 1.5);
    const auto v = render(p, 1000, 1600);
    CHECK(v[499] == doctest::Approx(0.499).epsilon(1e-5));
    CHECK(v[500] == doctest::Approx(0.5).epsilon(1e-5));
    CHECK(v[1000] == doctest::Approx(0.25).epsilon(1e-4));
    CHECK(v[1500] == 0.0f);
  }

  TEST_CASE("cancelScheduledValues removes events at or after t") {
    Param p(0.0);
    p.setValueAtTime(1, 0.1);
    p.setValueAtTime(2, 0.2);
    p.setValueAtTime(3, 0.3);
    p.cancelScheduledValues(0.2);
    CHECK(p.eventCount() == 1);
  }

  TEST_CASE("events at equal times keep insertion order") {
    Param p(0.0);
    p.setValueAtTime(1, 0.0);
    p.setValueAtTime(2, 0.0);
    const auto v = render(p, 1000, 128);
    CHECK(v[0] == 2.0f);
  }

  TEST_CASE("values are clamped to [min, max]") {
    Param p(0.0, -1.0f, 1.0f);
    p.setValueAtTime(5, 0);
    const auto v = render(p, 1000, 128);
    CHECK(v[0] == 1.0f);
    CHECK(p.intrinsic() == 1.0);
  }

  TEST_CASE("hasSampleAccurateValues: future SetValue/SetTarget do not need the a-rate path") {
    Param p(0.0);
    p.setValueAtTime(1, 1.0);
    CHECK(!p.hasSampleAccurateValues(0, 1000));
    CHECK(p.hasSampleAccurateValues(896, 1000));  // quantum [896, 1024) contains t = 1
    Param q(0.0);
    q.setValueAtTime(0, 0);
    q.linearRampToValueAtTime(1, 1);
    CHECK(q.hasSampleAccurateValues(0, 1000));
  }

  TEST_CASE("capacity: past events are pruned on insertion; only future overflow is rejected and counted") {
    Param p(0.0);
    for (int i = 0; i < 500; ++i) {
      // exact binary times: an event later than the render time would be clamped to frame/sr, which can round to a
      // hair after the frame (Chromium behaviour, reproduced)
      p.setContextTime(i * 8, 1024.0);
      CHECK(p.setValueAtTime(static_cast<double>(i), i / 128.0));
      float b[1];
      p.processARate(i * 8, 1024.0, b, 1);
      CHECK(b[0] == static_cast<float>(i));
      CHECK(p.eventCount() <= 2);
    }
    CHECK(p.dropped() == 0);
    Param f(0.0);
    for (int i = 0; i < static_cast<int>(Param::kCapacity); ++i) CHECK(f.setValueAtTime(1.0, 10.0 + i));
    CHECK(!f.setValueAtTime(1.0, 100.0));
    CHECK(f.dropped() == 1);
  }

  TEST_CASE("late insertion: times before the render time are clamped to it") {
    Param p(0.0);
    render(p, 1000, 256);           // context now at frame 256
    p.setContextTime(256, 1000);
    p.setValueAtTime(1, 0.0);         // in the past: clamped to 0.256
    float b[128];
    p.processARate(256, 1000, b, 128);
    CHECK(b[0] == 1.0f);
  }

  TEST_CASE("helper event sequences match the JS (glideTo floor and end set, linearTo anchor, holdAndFade tau)") {
    Param p(1.0);
    glideTo(p, 0, 0.01, 0.1, 1.0);  // cancelAndHold + set(1) + exp(1e-4) + set(0)
    CHECK(p.eventCount() == 3);
    Param q(0.0);
    linearTo(q, 1, 0.5, 0.1, 0.2);  // set(0.2, 0.5) + lin(1, 0.6)
    CHECK(q.eventCount() == 2);
    CHECK(q.valueAt(0.55) == doctest::Approx(0.6));
    Param r(0.0);
    CHECK(holdAndFade(r, 0, 0.4));
    CHECK(r.eventCount() == 2);
    CHECK(!rampTo(r, NAN, 0));
    CHECK(releaseTau(6.9) == doctest::Approx(1.0));
    CHECK(stopAfterRelease(1, 2) == doctest::Approx(3.6));
    float c[64];
    CHECK(equalPowerCurve(c, 64, false) == 64);
    CHECK(c[0] == 0.0f);
    CHECK(c[63] == 1.0f);
  }

  TEST_CASE("moveAt / trackedMove (fx.js)") {
    Param p(0.0);
    Move m;
    CHECK(moveAt(m, 1, 0.7) == 0.7);
    m = trackedMove(p, m, 1.0, 0.0, 0.5, 0.2);
    CHECK(m.dur == 0.5);
    CHECK(moveAt(m, 0.25, 0) == doctest::Approx(0.6));
    m = trackedMove(p, m, 0.0, 0.25, 0, 0);  // rampTo from where the glide is
    CHECK(m.from == doctest::Approx(0.6));
    CHECK(m.tc == kTau);
    CHECK(moveAt(m, 0.25 + 12 * kTau, 0) == 0.0);
    m = trackedMove(p, m, 0.3, 1.0, kGlideSet, 0);
    CHECK(m.from == 0.3);
  }

  TEST_CASE("Timer: 128-frame quanta, (quantum, submission) order, callbacks get max(t, now), late timers after") {
    rig::TimerQueue q;
    std::vector<std::string> log;
    q.at(0.0, 48000, [&](double t) { log.push_back("a" + std::to_string(t)); });
    q.at(-5, 48000, [&](double t) { log.push_back("neg" + std::to_string(t)); });
    q.at(129.0 / 48000, 48000, [&](double t) {
      log.push_back("b");
      CHECK(t == doctest::Approx(256.0 / 48000));  // due in quantum 2 (ceil(129/128)): max(t, 2·128/sr)
      q.at(0.0, 48000, [&](double t2) {
        log.push_back("late");
        CHECK(t2 == doctest::Approx(256.0 / 48000));  // max(0, now)
      });
    });
    const auto id = q.at(1.0, 48000, [&](double) { log.push_back("never"); });
    q.at(130.0 / 48000, 48000, [&](double) { log.push_back("c"); });
    CHECK(rig::TimerQueue::quantumOf(128.0 / 48000 + 1e-12, 48000) == 1);  // within 1e-6 of a boundary
    CHECK(q.nextQuantum() == 0);
    q.runDue(0);
    CHECK(log.size() == 2);
    q.cancel(id);
    q.runDue(2);
    CHECK(log == (std::vector<std::string>{"a0.000000", "neg0.000000", "b", "c", "late"}));
    q.runDue(1000);
    CHECK(q.pending() == 0);
  }

  TEST_CASE("Coalescer: one apply per key per 10 ms, latest wins, trailing flush at last + interval") {
    rig::TimerQueue tq;
    rig::Coalescer co([&](double at, std::function<void(double)> fn) { tq.at(at, 48000, std::move(fn)); }, 0.01);
    std::vector<std::pair<double, int>> applied;
    co.push("a", 0.000, [&](double t) { applied.push_back({t, 1}); });
    co.push("a", 0.002, [&](double t) { applied.push_back({t, 2}); });
    co.push("a", 0.004, [&](double t) { applied.push_back({t, 3}); });
    co.push("b", 0.004, [&](double t) { applied.push_back({t, 9}); });
    REQUIRE(applied.size() == 2);
    tq.runDue(rig::TimerQueue::quantumOf(0.01, 48000));
    REQUIRE(applied.size() == 3);
    CHECK(applied[2].second == 3);
    // run at the timer's time, the start of quantum ceil(0.01·sr/128) = 4 (fx.js: last.set(key, t); fn(t))
    CHECK(applied[2].first == doctest::Approx(4 * 128.0 / 48000));
    co.push("a", 0.012, [&](double t) { applied.push_back({t, 4}); });  // < 10 ms after the flush: pending
    co.cancelAll([](std::string_view k) { return k == "a"; });
    tq.runDue(1000);
    CHECK(applied.size() == 3);
  }
}
