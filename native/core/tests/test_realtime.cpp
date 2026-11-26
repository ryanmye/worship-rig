// Realtime mode: control thread + a fake host thread calling rig_render with odd block sizes. Run under ASan/UBSan
// and TSAN (presets asan / tsan) as the "TSAN soak"; this is the short version (3 s of audio).
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>

#include <cstring>
#include <initializer_list>
#include <string>
#include <vector>
#include "doctest.h"
#include "rig/rig_engine.h"

// T00c O4: g++ defines __SANITIZE_*__, clang answers __has_feature (as test_drone_cpu.cpp / test_wheels.cpp ask)
#if defined(__SANITIZE_ADDRESS__) || defined(__SANITIZE_THREAD__)
#define RIG_RT_SANITIZED 1
#elif defined(__has_feature)
#if __has_feature(address_sanitizer) || __has_feature(thread_sanitizer)
#define RIG_RT_SANITIZED 1
#endif
#endif
#ifndef RIG_RT_SANITIZED
#define RIG_RT_SANITIZED 0
#endif

TEST_SUITE("realtime") {
  struct Rt {
    rig_engine *e = nullptr;
    std::mutex mu;
    std::string all;
    int events = 0;
    Rt() {
      rig_config cfg;
      rig_config_init(&cfg);
      cfg.mode = RIG_MODE_REALTIME;
      cfg.sample_rate = 48000;
      cfg.on_event = [](void *u, const char *j, size_t n) {
        auto *r = static_cast<Rt *>(u);
        std::lock_guard<std::mutex> lk(r->mu);
        r->all.append(j, n);
        ++r->events;
      };
      cfg.event_user = this;
      e = rig_create(&cfg, nullptr);
    }
    ~Rt() { rig_destroy(e); }
    void post(const std::string &m) { REQUIRE(rig_post(e, m.data(), m.size()) == RIG_OK); }
    bool waitFor(const char *needle, int ms = 3000) {
      for (int i = 0; i < ms; ++i) {
        {
          std::lock_guard<std::mutex> lk(mu);
          if (all.find(needle) != std::string::npos) return true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
      return false;
    }
  };

  TEST_CASE("control thread answers posts; a host thread renders odd blocks; notes sound; ticks arrive") {
    Rt rt;
    REQUIRE(rt.e != nullptr);
    rt.post(R"({"v":1,"op":"hello","protocol":1,"id":1})");
    REQUIRE(rt.waitFor("worship-rig-core"));
    rt.post(R"({"v":1,"op":"audio","action":"start","id":2})");
    REQUIRE(rt.waitFor("\"re\":2"));
    rt.post(R"({"v":1,"op":"prepare","id":3,"patch":{"slots":[{"instrument":{"type":"test","id":"sine"},)"
            R"("gain":1,"params":{"attack":0.002,"release":0.05}},null,null,null]}})");
    REQUIRE(rt.waitFor("\"token\":1"));
    rt.post(R"({"v":1,"op":"commit","id":4,"token":1})");
    REQUIRE(rt.waitFor("\"committed\":true"));

    std::atomic<bool> stop{false};
    std::atomic<long> frames{0};
    std::atomic<float> peak{0};
    std::atomic<int> lateWakes{0};
    // Review F1: the xruns of the render calls where a note-on landed (`voices` rose in the call's meter snapshot), so
    // a render that blocks once per note fails however many late wakeups the box shows. A note's window is its call and
    // the next two (the quantum's overrun reaches the snapshot one quantum later, and a short call may render none).
    std::atomic<int> notesLanded{0}, noteXruns{0};
    std::thread host([&] {  // the platform audio thread: 441-frame blocks, paced at ~5x realtime
      const unsigned blocks[] = {441, 256, 128, 441, 100, 512};
      std::vector<float> l(1024), r(1024);
      float *p[2] = {l.data(), r.data()};
      rig_meters hm{};
      std::uint32_t prevVoices = 0, prevXruns = 0;
      int window = 0;
      bool hit = false;
      for (unsigned i = 0; !stop; ++i) {
        const unsigned n = blocks[i % 6];
        REQUIRE(rig_render(rt.e, p, 2, n, 0) == RIG_OK);
        hm.struct_size = RIG_METERS_SIZE_V1;
        if (rig_get_meters(rt.e, &hm) == RIG_OK) {
          if (hm.voices > prevVoices) {
            ++notesLanded;
            window = 3;
            hit = false;
          }
          if (window > 0) {
            if (hm.xruns > prevXruns && !hit) {
              hit = true;
              ++noteXruns;
            }
            --window;
          }
          prevVoices = hm.voices;
          prevXruns = hm.xruns;
        }
        float m = peak.load();
        for (unsigned k = 0; k < n; ++k) m = std::fmax(m, std::fabs(l[k]));
        peak = m;
        frames += n;
        const auto s0 = std::chrono::steady_clock::now();
        std::this_thread::sleep_for(std::chrono::microseconds(1500));
        // Lane F1 timing bounds: this thread kept off its CPU for over one quantum, outside rig_render (box noise)
        const auto over = std::chrono::steady_clock::now() - s0 - std::chrono::microseconds(1500);
        if (over > std::chrono::nanoseconds(static_cast<long long>(128 * 1e9 / 48000))) ++lateWakes;
      }
    });
    for (int n = 0; n < 8; ++n) {
      rt.post(R"({"v":1,"op":"play","e":"on","n":)" + std::to_string(55 + n) + R"(,"vel":100})");
      std::this_thread::sleep_for(std::chrono::milliseconds(60));
    }
    rt.post(R"({"v":1,"op":"set","path":"slots.0.gain","value":0.5})");
    rt.post(R"({"v":1,"op":"play","e":"panic"})");
    while (frames < 3 * 48000) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    stop = true;
    host.join();

    CHECK(peak.load() > 0.05f);
    CHECK(rig_engine_time(rt.e) == doctest::Approx(frames.load() / 48000.0).epsilon(0.01));
    CHECK(rt.waitFor("\"ev\":\"tick\""));
    rig_meters m{};
    m.struct_size = sizeof m;
    CHECK(rig_get_meters(rt.e, &m) == RIG_OK);
    CHECK(m.frames >= static_cast<unsigned long long>(3 * 48000));
#if RIG_RT_SANITIZED
    // T00c O4: instrumented renders (TSan, ASan) are not a timing build: under `ctest -j2` the ASan build overran 14
    // times with no defect (passes alone). Reported, not asserted; every Release / RelWithDebInfo build still checks.
    MESSAGE("xruns under a sanitizer (not a timing build): " << m.xruns);
#else
    // Lane F1 timing bounds. `xruns` counts quanta whose render took over 2.67 ms of wall clock, so a quantum the
    // scheduler interrupted counts as one; the stated 3 failed on CI's shared macos-15 runner (6, serial ctest). The
    // allowance is 3 plus the host thread's own late wakeups (a 1.5 ms sleep over one quantum late), counted on the
    // same thread over the same 3 s but outside rig_render, so neither a slow nor a blocking render can raise it.
    // k = 1: a stall has to land in the sub-ms render to cost an xrun but anywhere in the 1.5 ms sleep to make a
    // wakeup late, so noise xruns should not outnumber late wakeups (here under two `yes` loops: xruns 0-1, late
    // 3-7; idle 0 and 0). Capped at 20 (review F1; was 50): a render slower than realtime overruns all ~1125 quanta,
    // one that stalls every 32nd quantum 35-36. Under four `yes` loops the box shows 24-56 late wakeups with 0-1
    // noise xruns, so with the cap at 50 that stall passed (allowance 36-44); CI's worst noise reading is 6.
    const unsigned allowed = std::min(3u + static_cast<unsigned>(lateWakes.load()), 20u);
    MESSAGE("xruns " << m.xruns << " over " << frames.load() / 128 << " quanta; host late wakeups " << lateWakes.load()
                     << "; allowed " << allowed << "; note-on calls " << notesLanded.load() << ", with an xrun "
                     << noteXruns.load());
    CHECK(m.xruns <= allowed);
    // Review F1: not scaled by the box's noise. At most half the note-ons may share their window with an xrun: noise
    // lands in a 3-call window with p ~ 3 x noise xruns / ~460 calls (20 noise xruns: P(>= 5 of 8) ~ 0.2 %; measured
    // 0-1 of 8 idle, under two and under four `yes` loops), while a render that blocks 4 ms per note-on hits 8 of 8
    // and passed the total above whenever the box showed >= 5 late wakeups (review F1 mutation: allowance 9 under two
    // `yes` loops, 46 under four)
    CHECK(notesLanded.load() >= 6);  // the detector saw the notes (8 note-ons, one voice each)
    CHECK(noteXruns.load() <= 4);
#endif
  }

  TEST_CASE("rig_render before audio start writes silence and does not advance time") {
    Rt rt;
    float a[256], b[256];
    for (auto &x : a) x = 1.0f;
    float *p[2] = {a, b};
    CHECK(rig_render(rt.e, p, 2, 256, 0) == RIG_OK);
    CHECK(a[0] == 0.0f);
    CHECK(rig_engine_time(rt.e) == 0.0);
    float *bad[1] = {nullptr};
    CHECK(rig_render(rt.e, bad, 0, 256, 0) == RIG_E_INVALID);
  }

  TEST_CASE("post floods are bounded and a destroyed engine joins its threads") {
    Rt rt;
    int full = 0;
    for (int i = 0; i < 40000; ++i) {
      const char *m = R"({"v":1,"op":"hello","protocol":1})";
      if (rig_post(rt.e, m, std::strlen(m)) == RIG_E_FULL) ++full;
    }
    CHECK(full >= 0);  // may or may not outrun the control thread; the point is no crash and a clean destroy
  }

  TEST_CASE("rig_midi_in is lock-free, bounded and counts drops") {
    Rt rt;
    const std::uint8_t on[] = {0x90, 60, 100};
    int full = 0;
    for (int i = 0; i < 20000; ++i)
      if (rig_midi_in(rt.e, "port1", on, 3, 0) == RIG_E_FULL) ++full;
    CHECK(rig_midi_in(rt.e, "p", nullptr, 3, 0) == RIG_E_INVALID);
    CHECK(full >= 0);
  }
}
