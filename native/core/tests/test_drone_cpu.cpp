// T16: CPU of the drone unit per 128-frame quantum (44.1 kHz) on this box, printed for the report: a static synth
// layer (3 drone-osc voices), a key-change crossfade (two layers, 7 voices), the brightness 9th (4 voices), a frozen
// loop alone. The bound is loose (a 2-CPU box shared with other builds); the numbers matter.
#include <chrono>
#include <cstdio>
#include <functional>
#include <vector>

#include "drone/drone_core.h"
#include "drone/drone_unit.h"
#include "helpers.h"
#include "runtime/rt_guard.h"
#include "time/timer.h"

// T16 review O5: clang (CI / Mac ASan) defines neither __SANITIZE_ADDRESS__ nor __SANITIZE_THREAD__; ask
// __has_feature too, so a sanitizer build only reports the timings instead of asserting them.
#if defined(__SANITIZE_ADDRESS__) || defined(__SANITIZE_THREAD__)
#define RIG_TEST_SANITIZED 1
#elif defined(__has_feature)
#if __has_feature(address_sanitizer) || __has_feature(thread_sanitizer)
#define RIG_TEST_SANITIZED 1
#endif
#endif

namespace {

class Host final : public rig::drone::DroneHost {
 public:
  double now() const override { return static_cast<double>(frame) / 44100; }
  double sampleRate() const override { return 44100; }
  std::uint32_t seed() const override { return 1; }
  bool offline() const override { return true; }
  void send(rig::Command c, double when) override {
    const auto f = when > 0 ? static_cast<std::int64_t>(when * 44100) : 0;
    c.frame = f > frame ? f : frame;
    pending.push_back(c);
  }
  void at(double t, std::function<void(double)> fn) override { timers.at(t, 44100, std::move(fn)); }
  void warn(const std::string &) override {}
  void apply(rig::drone::DroneUnit &u) {
    std::vector<rig::Command> keep;
    for (const rig::Command &c : pending) {
      if (c.frame < frame + 128) u.apply(c);
      else keep.push_back(c);
    }
    pending.swap(keep);
  }
  std::int64_t frame = 0;
  rig::TimerQueue timers;
  std::vector<rig::Command> pending;
};

class Sink final : public rig::EventSink {
 public:
  bool push(const rig::AudioEvent &e) override {
    if (e.kind == rig::EventKind::Garbage && static_cast<rig::GarbageKind>(e.aux) == rig::GarbageKind::Owned)
      delete static_cast<rig::Owned *>(e.ptr);
    return true;
  }
};

/** Renders `quanta` quanta from `q0`; returns microseconds per quantum spent in DroneUnit::process. */
double run(Host &h, rig::drone::DroneUnit &u, std::int64_t q0, std::int64_t quanta) {
  Sink sink;
  rig::Bus out, send;
  double us = 0;
  for (std::int64_t q = q0; q < q0 + quanta; ++q) {
    h.frame = q * 128;
    h.timers.runDue(q);
    h.apply(u);
    rig::RenderContext ctx{q * 128, 44100, static_cast<std::uint64_t>(q), rig::UnitSlot::Drone, &sink};
    rig::UnitIO io;
    io.out = &out;
    send.clear(2);
    io.sends[rig::kSendReverb] = &send;
    const auto t0 = std::chrono::steady_clock::now();
    {
      rig::rt::RenderScope scope;  // FTZ/DAZ as on the audio thread (T04 review finding 2); arms the allocation trap
      u.process(ctx, io);
    }
    us += std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count();
  }
  return us / static_cast<double>(quanta);
}

}  // namespace

TEST_SUITE("drone_cpu") {
  TEST_CASE("drone unit cost per quantum") {
    const long alloc0 = rigtest::g_rtAllocs;
    Host h;
    rig::drone::DroneCore d(h, rig::rngFor(1, "drone"));
    rig::drone::DroneUnit u(44100, d.unitInit(-8.5));
    rig::drone::DroneCore::Config c;
    c.mode = "synth";
    c.gain = 1;
    c.fade = 2;
    d.configure(c, 0);
    d.setKey(0, false, NAN, 0);
    const double q = 128.0 / 44100 * 1e6;
    const double one = run(h, u, 0, 1000);  // 2.9 s: one layer, 3 voices
    d.setKey(9, true, NAN, h.now());
    const double two = run(h, u, 1000, 600);  // the crossfade: 2 layers, 6 voices
    run(h, u, 1600, 400);
    rig::drone::DroneCore::Config b;
    b.brightness = 0.9;
    d.configure(b, h.now());
    const double nine = run(h, u, 2000, 600);  // 4 voices
    MESSAGE("drone us/quantum: 1 layer " << one << ", crossfade " << two << ", with the 9th " << nine
                                         << " (quantum " << q << " us)");
    std::printf("[drone_cpu] 1 layer %.1f us, crossfade %.1f us, 9th %.1f us per quantum (%.1f%%, %.1f%%, %.1f%%)\n",
                one, two, nine, 100 * one / q, 100 * two / q, 100 * nine / q);
#if !defined(RIG_TEST_SANITIZED)  // sanitizers: report only (5-15x slower)
    CHECK(one < 0.5 * q);
    CHECK(two < 0.5 * q);
#endif

    // a frozen loop alone (the low-resource drone): one looping buffer source
    rig::drone::LoopRequest r;
    r.sampleRate = 44100;
    r.loopSec = 2;
    r.prerollSec = 0.5;
    rig::drone::LoopResult loop = rig::drone::renderDroneLoop(r);
    REQUIRE(loop.buffer);
    Host h2;
    rig::drone::DroneCore d2(h2, rig::rngFor(1, "drone"));
    rig::drone::DroneUnit u2(44100, d2.unitInit(0));
    d2.playLoopTest(r, 0);
    const double frozen = run(h2, u2, 0, 1000);
    std::printf("[drone_cpu] frozen loop %.1f us per quantum (%.1f%%)\n", frozen, 100 * frozen / q);
#if !defined(RIG_TEST_SANITIZED)
    CHECK(frozen < one);
#endif
    CHECK(rigtest::g_rtAllocs == alloc0);  // DroneUnit::process: no allocation (T16 review)
  }
}
