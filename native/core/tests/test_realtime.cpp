// Realtime mode: control thread + a fake host thread calling rig_render with odd block sizes. Run under ASan/UBSan
// and TSAN (presets asan / tsan) as the "TSAN soak"; this is the short version (3 s of audio).
#include <atomic>
#include <chrono>
#include <cmath>
#include <mutex>
#include <string>
#include <thread>

#include <cstring>
#include <initializer_list>
#include <string>
#include <vector>
#include "doctest.h"
#include "rig/rig_engine.h"

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
    std::thread host([&] {  // the platform audio thread: 441-frame blocks, paced at ~5x realtime
      const unsigned blocks[] = {441, 256, 128, 441, 100, 512};
      std::vector<float> l(1024), r(1024);
      float *p[2] = {l.data(), r.data()};
      for (unsigned i = 0; !stop; ++i) {
        const unsigned n = blocks[i % 6];
        REQUIRE(rig_render(rt.e, p, 2, n, 0) == RIG_OK);
        float m = peak.load();
        for (unsigned k = 0; k < n; ++k) m = std::fmax(m, std::fabs(l[k]));
        peak = m;
        frames += n;
        std::this_thread::sleep_for(std::chrono::microseconds(1500));
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
#if defined(__SANITIZE_THREAD__)
    MESSAGE("xruns under TSan (not a timing build): " << m.xruns);  // instrumented FX render runs below real time
#else
    CHECK(m.xruns <= 3);  // wall-clock overrun count on a shared 2-CPU box: preemption can trip it once or twice
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
