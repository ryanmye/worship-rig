#include <cmath>

#include <cstring>
#include <initializer_list>
#include <string>
#include <vector>
#include "doctest.h"
#include "time/automation.h"
#include "time/param.h"

using namespace rig::wa;

TEST_SUITE("param") {
  TEST_CASE("setValueAtTime steps, intrinsic value before the first event") {
    Param p(0.25);
    p.setValueAtTime(1.0, 0.5);
    p.setValueAtTime(2.0, 1.0);
    CHECK(p.valueAt(0.0) == doctest::Approx(0.25));
    CHECK(p.valueAt(0.4999) == doctest::Approx(0.25));
    CHECK(p.valueAt(0.5) == doctest::Approx(1.0));
    CHECK(p.valueAt(0.999) == doctest::Approx(1.0));
    CHECK(p.valueAt(1.0) == doctest::Approx(2.0));
    CHECK(p.valueAt(50.0) == doctest::Approx(2.0));
  }

  TEST_CASE("linear ramp: exact midpoint, ends at the target, holds after") {
    Param p(0.0);
    p.setValueAtTime(1.0, 1.0);
    p.linearRampToValueAtTime(3.0, 2.0);
    CHECK(p.valueAt(1.5) == doctest::Approx(2.0));
    CHECK(p.valueAt(1.25) == doctest::Approx(1.5));
    CHECK(p.valueAt(2.0) == doctest::Approx(3.0));
    CHECK(p.valueAt(9.0) == doctest::Approx(3.0));
  }

  TEST_CASE("exponential ramp is geometric") {
    Param p(0.0);
    p.setValueAtTime(1.0, 0.0);
    p.exponentialRampToValueAtTime(16.0, 4.0);
    CHECK(p.valueAt(1.0) == doctest::Approx(2.0));
    CHECK(p.valueAt(2.0) == doctest::Approx(4.0));
    CHECK(p.valueAt(3.0) == doctest::Approx(8.0));
  }

  TEST_CASE("setTarget follows target + (start - target) e^(-dt/tau)") {
    Param p(1.0);
    p.setTargetAtTime(0.0, 1.0, 0.1);
    for (double dt : {0.0, 0.05, 0.1, 0.3, 1.0}) CHECK(p.valueAt(1.0 + dt) == doctest::Approx(std::exp(-dt / 0.1)));
    CHECK(p.valueAt(0.5) == doctest::Approx(1.0));  // before the event
  }

  TEST_CASE("rampTo: exponential approach, then the value is pinned to the target at t + 12 tau") {
    Param p(0.0);
    p.setValueAtTime(0.2, 0.0);
    rampTo(p, 1.0, 1.0, kTau);
    CHECK(p.valueAt(1.0 + kTau) == doctest::Approx(1.0 - 0.8 * std::exp(-1.0)));
    const double pin = 1.0 + kRampSettleTc * kTau;
    CHECK(p.valueAt(pin - 1e-9) == doctest::Approx(1.0 - 0.8 * std::exp(-12.0)).epsilon(1e-9));
    CHECK(p.valueAt(pin) == 1.0);  // exactly the target, not "almost"
    CHECK(p.valueAt(100.0) == 1.0);
  }

  TEST_CASE("cancelAndHold freezes the value reached mid-ramp") {
    Param p(0.0);
    p.setValueAtTime(0.0, 0.0);
    p.linearRampToValueAtTime(1.0, 2.0);
    p.cancelAndHoldAtTime(0.5);
    CHECK(p.valueAt(0.5) == doctest::Approx(0.25));
    CHECK(p.valueAt(1.9) == doctest::Approx(0.25));
    p.linearRampToValueAtTime(1.0, 2.5);  // a new ramp starts from the held value at t = 0.5
    CHECK(p.valueAt(1.5) == doctest::Approx(0.25 + 0.75 * 0.5));
  }

  TEST_CASE("cancelAndHold during setTarget holds the curve value") {
    Param p(1.0);
    p.setTargetAtTime(0.0, 0.0, 0.2);
    p.cancelAndHoldAtTime(0.3);
    CHECK(p.valueAt(5.0) == doctest::Approx(std::exp(-1.5)));
  }

  // "a-rate block equals per-sample valueAt" removed by the wave-0b verifier: it skipped quantum 384, which is
  // invalid for Chromium's stateful setTarget recursion. Replaced by time_param_test.cpp "rendered a-rate values
  // follow the spec formula" (every quantum) and time_automation_test.cpp (k-rate vs Chromium dumps).

  TEST_CASE("capacity: old events are folded, the timeline stays correct and nothing is dropped") {
    Param p(0.0);
    for (int i = 0; i < 500; ++i) {
      CHECK(p.setValueAtTime(static_cast<double>(i), i * 0.01));
      float b[1];
      p.processARate(static_cast<std::int64_t>(i * 0.01 * 1000), 1000.0, b, 1);
    }
    CHECK(p.dropped() == 0);
    CHECK(p.valueAt(4.99) == doctest::Approx(499.0));
  }

  TEST_CASE("overflow with only future events is rejected and counted") {
    Param p(0.0);
    for (int i = 0; i < 64; ++i) CHECK(p.setValueAtTime(1.0, 10.0 + i));
    CHECK(!p.setValueAtTime(1.0, 100.0));
    CHECK(p.dropped() == 1);
  }
}
