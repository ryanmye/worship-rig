// T05 echo (kind "delay"): the six echo-* golden fixtures at the EXACT tier through the fixture runner (= rig_render;
// ctest golden.t05 compares at the manifest tier), echo timing k * time in plain and ping-pong mode, the line switch
// / glide / busy-line flush / ring-out state machine, panic, the silent-buffer skip, and the JS test delaySync
// (test/phase1/engine/suites.mjs) through the bridge (tempo -> the "delay" service -> DelayOp::SetTime).
#include <cmath>
#include <string>
#include <vector>

#include "doctest.h"
#include "fx/delay_unit.h"
#include "helpers.h"
#include "model/patch.h"
#include "test_delay_util.h"

using namespace rigtest;
using rig::fx::DelayUnit;

namespace {

constexpr double kSr = 44100;

rig::DelayPatch patchOf(double time, double fb, bool pp, double tone = 1.0, double rg = 1.0, int sync = 0) {
  rig::DelayPatch p;
  p.time = time;
  p.feedback = fb;
  p.pingpong = pp;
  p.tone = tone;
  p.returnGain = rg;
  p.sync = sync;
  return p;
}

std::vector<std::vector<float>> impulseAt(std::size_t frame, std::size_t len, float amp = 0.5f) {
  std::vector<std::vector<float>> in(2, std::vector<float>(len, 0.0f));
  in[0][frame] = in[1][frame] = amp;
  return in;
}

/** First sample in [a, b) with |x| > 1e-12: the onset of an echo (the causal tone LPF starts at the echo frame,
 *  while its peak drifts by the filter's group delay on every pass). */
std::size_t onset(const std::vector<float> &x, std::size_t a, std::size_t b) {
  for (std::size_t i = a; i < b && i < x.size(); ++i)
    if (std::fabs(x[i]) > 1e-12) return i;
  return b;
}

std::size_t argmaxAbs(const std::vector<float> &x, std::size_t a, std::size_t b) {
  std::size_t k = a;
  for (std::size_t i = a; i < b && i < x.size(); ++i)
    if (std::fabs(x[i]) > std::fabs(x[k])) k = i;
  return k;
}

double energy(const std::vector<float> &x, std::size_t a, std::size_t b) {
  double s = 0;
  for (std::size_t i = a; i < b && i < x.size(); ++i) s += double(x[i]) * x[i];
  return s;
}

}  // namespace

TEST_SUITE("delay") {
  TEST_CASE("golden fixtures echo-* at the exact tier, allocation trap on") {
    for (const char *id : {"echo-none", "echo-slapback", "echo-quarter", "echo-dotted", "echo-ambient-echo",
                           "echo-dotted-noise"}) {
      const std::string sid = id;
      INFO(sid);
      const t05::GoldenResult g = t05::goldenRun(sid);
      if (!g.present) continue;
      CHECK(g.rtAllocs == 0);
      CHECK(g.maxDiff <= 2e-4);  // the exact tier
      CHECK(g.maxDiff <= 1e-6);  // what the port achieves (float-for-float Chromium kernels)
      if (sid == "echo-none")
        CHECK(g.peak == 0.0);  // silent golden (return gain 0): passes without any delay code, proves nothing
      else
        CHECK(g.peak > 0.01);
    }
  }

  TEST_CASE("echo k lands at exactly k * time; ping-pong alternates L / R") {
    const std::size_t T = static_cast<std::size_t>(0.2 * kSr), at = 22050, len = at + 6 * T;
    for (bool pp : {false, true}) {
      INFO("pingpong " << pp);
      DelayUnit u(kSr, patchOf(0.2, 0.5, pp), 0);
      t05::Driver d(&u, kSr);
      const auto out = d.run((len + 127) / 128 * 128, impulseAt(at, len));
      std::size_t first = 0;
      for (std::size_t k = 1; k <= 4; ++k) {
        const std::size_t c = pp ? (k % 2 == 1 ? 0 : 1) : 0;
        const std::size_t on = onset(out[c], at + k * T - 64, at + k * T + 64);
        if (k == 1) first = on;
        CHECK(on - first == (k - 1) * T);  // one delay of `time` per pass: Q is inside, not added (Q9)
        CHECK(on == at + k * T);
        if (pp) {  // the other channel carries nothing of this echo
          const double other = energy(out[1 - c], at + k * T - 64, at + k * T + 64);
          CHECK(other < 1e-12);
        }
      }
      // plain: both channels, feedback .5 per pass (the LPF has unity DC gain: the area of each echo scales by .5)
      if (!pp) {
        auto area = [&](std::size_t a, std::size_t b) {
          double s = 0;
          for (std::size_t i = a; i < b; ++i) s += out[1][i];
          return s;
        };
        const double a1 = area(at + T - 64, at + T + 512), a2 = area(at + 2 * T - 64, at + 2 * T + 512);
        CHECK(a1 == doctest::Approx(0.5).epsilon(1e-3));
        CHECK(a2 / a1 == doctest::Approx(0.5).epsilon(1e-3));
      }
    }
  }

  TEST_CASE("time change > 5 %: line switch, old line rings out, flushes, goes idle; <= 5 %: glide") {
    DelayUnit u(kSr, patchOf(0.3, 0.5, false), 0);
    t05::Driver d(&u, kSr);
    // construction = Delay() + applyAll(0): .375 -> .3 is a 20 % change, so line B takes it at once (as in JS)
    REQUIRE(u.activeLine() == 1);
    CHECK(std::string(u.lineState(0)) == "ringing");
    d.run(22016);  // 0.4992 s
    u.updateTime(0.6, 0.5);
    CHECK(u.activeLine() == 1);  // line A is still ringing (busy): flushed first
    d.run(static_cast<std::size_t>(0.6 * kSr) / 128 * 128);
    CHECK(u.activeLine() == 0);
    CHECK(u.lineTime(0) == 0.6);
    CHECK(std::string(u.lineState(1)) == "ringing");
  }

  TEST_CASE("line switch from idle: the old line rings min(8, time ceil(ln .001 / ln fb) + .1) s, then flushes") {
    DelayUnit u(kSr, patchOf(0.3, 0.5, false), 0);
    t05::Driver d(&u, kSr);
    d.run(static_cast<std::size_t>(4.5 * kSr) / 128 * 128);  // line A (.375 s): rings 3.85 s, flushes .475 s
    REQUIRE(u.activeLine() == 1);
    REQUIRE(std::string(u.lineState(0)) == "idle");
    const double t0 = d.now();
    u.updateTime(0.6, t0);
    REQUIRE(u.activeLine() == 0);
    CHECK(u.lineTime(0) == 0.6);
    CHECK(std::string(u.lineState(1)) == "ringing");
    // tail = .3 * 10 + .1 = 3.1 s, then flushing for .3 + .1 s
    d.run(static_cast<std::size_t>(3.08 * kSr) / 128 * 128);
    CHECK(std::string(u.lineState(1)) == "ringing");
    d.run(static_cast<std::size_t>(0.04 * kSr) / 128 * 128);
    CHECK(std::string(u.lineState(1)) == "flushing");
    d.run(static_cast<std::size_t>(0.42 * kSr) / 128 * 128);
    CHECK(std::string(u.lineState(1)) == "idle");
    // <= 5 %: same line, linear glide
    u.updateTime(0.62, d.now());
    CHECK(u.activeLine() == 0);
    CHECK(u.lineTime(0) == 0.62);
  }

  TEST_CASE("switch while the other line rings: it is flushed first (time + 60 ms), then takes the new time") {
    DelayUnit u(kSr, patchOf(0.375, 0.5, false), 0);  // .375 = the line default: no switch at build
    t05::Driver d(&u, kSr);
    REQUIRE(u.activeLine() == 0);
    d.run(22016);
    u.updateTime(0.6, 0.5);  // line B active, line A ringing
    REQUIRE(u.activeLine() == 1);
    d.run(8832);  // to ~0.7 s
    const double t = d.now();
    u.updateTime(0.3, t);  // line A is busy: flushing, retry at t + .375 + .06
    CHECK(u.activeLine() == 1);
    CHECK(std::string(u.lineState(0)) == "flushing");
    d.run(static_cast<std::size_t>(0.42 * kSr) / 128 * 128);
    CHECK(u.activeLine() == 1);
    d.run(static_cast<std::size_t>(0.03 * kSr) / 128 * 128);
    CHECK(u.activeLine() == 0);
    CHECK(u.lineTime(0) == 0.3);
    CHECK(std::string(u.lineState(1)) == "ringing");
  }

  TEST_CASE("a burst of time changes while the other line is busy: one retry, the last time wins, lines settle") {
    DelayUnit u(kSr, patchOf(0.375, 0.5, false), 0);
    t05::Driver d(&u, kSr);
    d.run(22016);
    u.updateTime(0.6, 0.5);  // line B active, line A ringing
    REQUIRE(u.activeLine() == 1);
    d.run(8832);
    for (int k = 0; k < 40; ++k) u.updateTime(0.25 + 0.001 * k, d.now());  // more retries than timer slots
    CHECK(std::string(u.lineState(0)) == "flushing");
    d.run(static_cast<std::size_t>(0.45 * kSr) / 128 * 128);
    REQUIRE(u.activeLine() == 0);
    CHECK(u.lineTime(0) == doctest::Approx(0.289));
    d.run(static_cast<std::size_t>(7.0 * kSr) / 128 * 128);  // B rings 0.6 * 10 + .1 s, flushes .7 s
    CHECK(std::string(u.lineState(1)) == "idle");
  }

  TEST_CASE("panic: feedback 0 for max(.2, longest + .05) s empties the loop, then feedback returns") {
    const std::size_t at = 4410, len = static_cast<std::size_t>(2.5 * kSr);
    auto render = [&](bool panic) {
      DelayUnit u(kSr, patchOf(0.2, 0.8, false), 0);
      t05::Driver d(&u, kSr);
      if (panic) u.panic(0.35);
      return d.run(len / 128 * 128, impulseAt(at, len));
    };
    const auto ref = render(false), p = render(true);
    // echoes at .3, .5 (already fed back before .35), then nothing: the loop is empty when feedback returns at .6
    CHECK(energy(p[0], static_cast<std::size_t>(0.29 * kSr), static_cast<std::size_t>(0.32 * kSr)) > 1e-3);
    CHECK(energy(p[0], static_cast<std::size_t>(0.75 * kSr), static_cast<std::size_t>(2.4 * kSr)) < 1e-20);
    CHECK(energy(ref[0], static_cast<std::size_t>(0.75 * kSr), static_cast<std::size_t>(2.4 * kSr)) > 1e-3);
  }

  TEST_CASE("the all-zero buffer skip is exact (write index keeps advancing)") {
    // 0.37503 s is a fractional delay: Chromium's float read position depends on the write index
    const std::size_t at = static_cast<std::size_t>(3.0 * kSr), len = at + static_cast<std::size_t>(1.0 * kSr);
    auto render = [&](bool tiny) {
      DelayUnit u(kSr, patchOf(0.37503, 0.4, false), 0);
      t05::Driver d(&u, kSr);
      auto in = impulseAt(at, len);
      if (tiny) in[0][static_cast<std::size_t>(1.5 * kSr)] = 1e-20f;  // keeps the kernels running to 3.5 s
      return d.run(len / 128 * 128, in);
    };
    const auto a = render(false), b = render(true);
    CHECK(energy(a[0], at, len) > 1e-3);
    CHECK(maxAbsDiff(a[0], b[0]) < 1e-15);
    CHECK(maxAbsDiff(a[1], b[1]) < 1e-15);
  }

  TEST_CASE("delaySync: 1/8 at 120 bpm = 0.25 s through the bridge (song tempo -> service -> SetTime)") {
    rig::DelayPatch p = patchOf(0.375, 0.3, false, 0.5, 1.0, 3);
    CHECK(rig::fx::delayEffectiveTime(p, 120) == 0.25);
    CHECK(rig::fx::delayEffectiveTime(p, 0) == 0.375);
    p.sync = 2;
    CHECK(rig::fx::delayEffectiveTime(p, 120) == 0.375);
    p.sync = 1;
    CHECK(rig::fx::delayEffectiveTime(p, 20) == 1.9);  // clamp

    OfflineEngine e(kSr);
    e.hello();
    e.call(R"({"v":1,"op":"set","id":2,"path":"fx.delay.sync","value":"1/8"})");
    e.call(R"({"v":1,"op":"set","id":2,"path":"fx.delay.feedback","value":0.3})");
    e.call(R"({"v":1,"op":"audio","action":"start","id":3})");
    e.call(R"({"v":1,"op":"song","id":4,"tempo":120})");
    REQUIRE(rig_test_tap(e.e, "fx.delay.output") == RIG_OK);
    std::vector<float> x(4096, 0.0f);
    x[0] = 0.5f;
    const float *ch[2] = {x.data(), x.data()};
    REQUIRE(rig_test_inject(e.e, "fx.delay.input", ch, 2, static_cast<uint32_t>(x.size()), 0.5, 1.0f) == RIG_OK);
    const auto out = e.render(static_cast<std::size_t>(1.2 * kSr), 4410);
    const std::size_t at = static_cast<std::size_t>(0.5 * kSr), T = static_cast<std::size_t>(0.25 * kSr);
    CHECK(onset(out[0], at + T - 64, at + T + 64) == at + T);
    CHECK(onset(out[0], at + 2 * T - 64, at + 2 * T + 64) == at + 2 * T);
    CHECK(std::fabs(out[0][argmaxAbs(out[0], at + T - 64, at + T + 64)]) > 0.05);
  }

  TEST_CASE("device rate change: the service rebuilds the delay at the new rate (echo still at k * time)") {
    OfflineEngine e(48000);
    e.hello();
    e.call(R"({"v":1,"op":"set","id":2,"path":"fx.delay.time","value":0.25})");
    e.call(R"({"v":1,"op":"set","id":2,"path":"fx.delay.feedback","value":0.5})");
    e.call(R"({"v":1,"op":"audio","action":"start","id":3})");
    REQUIRE(rig_test_tap(e.e, "fx.delay.output") == RIG_OK);
    e.render(24000);
    rig_device_info dev{};
    dev.struct_size = sizeof dev;
    dev.device_id = "test";
    dev.device_name = "test";
    dev.sample_rate = 96000;
    dev.channels = 2;
    dev.buffer_frames = 256;
    rig_host_audio_started(e.e, &dev);
    e.render(9600);  // the graph adopts 96 kHz, the RateChanged event reaches the service, a new unit is attached
    const double t0 = rig_engine_time(e.e) + 0.2;
    std::vector<float> x(256, 0.0f);
    x[0] = 0.5f;
    const float *ch[2] = {x.data(), x.data()};
    REQUIRE(rig_test_inject(e.e, "fx.delay.input", ch, 2, static_cast<uint32_t>(x.size()), t0, 1.0f) == RIG_OK);
    const auto out = e.render(96000);
    std::size_t imp = 0;  // the injected impulse is not in the tap: find the first echo, then the second
    const std::size_t a = onset(out[0], 0, out[0].size());
    REQUIRE(a < out[0].size());
    imp = onset(out[0], a + 1000, out[0].size());
    CHECK(imp - a == 24000);  // .25 s at 96 kHz between echoes
  }
}

