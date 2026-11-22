// CORE1 (T08 files): the realtime control loop pumps the sample cache (mackit O1) and an audio restart / output while
// asleep wakes the engine (W3A review R1). Realtime engines with a paced fake audio thread, as in unit.runtime.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "api/engine.h"
#include "doctest.h"
#include "helpers.h"

using Clock = std::chrono::steady_clock;
using rigtest::contains;

namespace {

#if defined(__SANITIZE_ADDRESS__) || defined(__SANITIZE_THREAD__)
constexpr bool kSanitized = true;
#elif defined(__has_feature)
#if __has_feature(address_sanitizer) || __has_feature(thread_sanitizer)
constexpr bool kSanitized = true;
#else
constexpr bool kSanitized = false;
#endif
#else
constexpr bool kSanitized = false;
#endif

rig::Engine &impl(rig_engine *e) {
  return *reinterpret_cast<rig::Engine *>(e);
}

/** Realtime engine reading the repo's app/ (bundled samples), optional fake host, events under a mutex, and a
 *  platform audio thread paced at real time that records the output peak. */
struct Rt {
  rig_engine *e = nullptr;
  rig_host host{};
  std::mutex mu;
  std::string all;
  std::atomic<bool> stop{false};
  std::atomic<float> peak{0};
  std::atomic<long> blocks{0};
  std::thread audio;

  explicit Rt(const rig_host *h = nullptr) {
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.mode = RIG_MODE_REALTIME;
    cfg.sample_rate = 48000;
    cfg.app_dir = RIG_REPO_DIR "/app";
    if (h) {
      host = *h;
      cfg.host = &host;
    }
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
    stopAudio();
    rig_destroy(e);
  }
  Rt(const Rt &) = delete;
  Rt &operator=(const Rt &) = delete;

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
  /** Events delivered so far (a mark for waitFor). */
  std::size_t mark() {
    std::lock_guard<std::mutex> lk(mu);
    return all.size();
  }
  /** `needle` in what was delivered after `from` (a mark()). */
  bool waitAfter(const std::string &needle, std::size_t from, int ms = 3000) {
    const auto end = Clock::now() + std::chrono::milliseconds(ms);
    while (Clock::now() < end) {
      {
        std::lock_guard<std::mutex> lk(mu);
        if (all.find(needle, from) != std::string::npos) return true;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return false;
  }
  /** The reply object to request `id` ("{"v":1,...,"re":id,...}", braces matched), "" on timeout. */
  std::string reply(int id, int ms = 3000) {
    const std::string needle = "\"re\":" + std::to_string(id) + ",";
    const auto end = Clock::now() + std::chrono::milliseconds(ms);
    while (Clock::now() < end) {
      {
        std::lock_guard<std::mutex> lk(mu);
        const std::size_t at = all.find(needle);
        if (at != std::string::npos) {
          std::size_t from = all.rfind("{\"v\":1", at);
          if (from == std::string::npos) from = at;
          int depth = 0;
          bool str = false;
          for (std::size_t i = from; i < all.size(); ++i) {
            const char c = all[i];
            if (str) {
              if (c == '\\') ++i;
              else if (c == '"') str = false;
            } else if (c == '"') {
              str = true;
            } else if (c == '{' || c == '[') {
              ++depth;
            } else if ((c == '}' || c == ']') && --depth == 0) {
              return all.substr(from, i + 1 - from);
            }
          }
          return all.substr(from);
        }
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    return {};
  }
  void startAudio(unsigned block = 128) {
    audio = std::thread([this, block] {
      std::vector<float> l(block), r(block);
      float *p[2] = {l.data(), r.data()};
      auto next = Clock::now();
      while (!stop) {
        rig_render(e, p, 2, block, 0);
        float m = peak.load(std::memory_order_relaxed);
        for (unsigned k = 0; k < block; ++k) m = std::max(m, std::max(std::abs(l[k]), std::abs(r[k])));
        peak.store(m, std::memory_order_relaxed);
        blocks.fetch_add(1, std::memory_order_relaxed);
        next += std::chrono::nanoseconds(static_cast<long long>(block * 1e9 / 48000.0));
        std::this_thread::sleep_until(next);
        if (Clock::now() > next + std::chrono::milliseconds(50)) next = Clock::now();  // a slow (sanitized) render
      }
    });
  }
  void stopAudio() {
    stop = true;
    if (audio.joinable()) audio.join();
  }
  std::uint32_t voices() const {
    rig_meters m{};
    m.struct_size = sizeof m;
    rig_get_meters(e, &m);
    return m.voices;
  }
  /** Lets the paced audio thread render `ms` of wall time. */
  static void pause(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }
};

/** n slots of sampler `id`, all full range and polyphonic: slot 3's Bass role defaults (highNote 59, mono 'lowest')
 *  would otherwise play none of notes 60-67 (patch.cpp applyRoleDefaults). */
std::string slotsOf(const char *id, int n) {
  std::string s;
  for (int i = 0; i < n; ++i)
    s += std::string(i ? "," : "") + R"({"instrument":{"type":"sampler","id":")" + id +
         R"("},"gain":0.2,"highNote":127,"mono":"off"})";
  return s;
}

/** Fake platform for the restart tests: audio_start reports the device at once from the core's host thread. */
std::atomic<rig_engine *> g_eng{nullptr};
std::atomic<int> g_starts{0}, g_stops{0};
rig_host fakeHost() {
  rig_host h{};
  h.struct_size = sizeof h;
  h.audio_start = [](void *, const char *dev, double, uint32_t) {
    ++g_starts;
    rig_device_info info{};
    info.struct_size = sizeof info;
    info.sample_rate = 48000;
    info.channels = 2;
    info.output_latency_sec = 0.005;
    info.device_id = dev ? dev : "fake-default";
    rig_host_audio_started(g_eng.load(), &info);
  };
  h.audio_stop = [](void *) {
    ++g_stops;
    rig_host_audio_state(g_eng.load(), RIG_DEVICE_SUSPENDED, nullptr);  // as the dev host / Apple layer do
  };
  return h;
}

/** Puts the engine to sleep through the bridge (no voices, nothing blocks it) and checks that time stops. */
void sleepNow(Rt &rt, int id) {
  rt.post(R"({"v":1,"op":"audio","action":"sleep","ramp":0.02,"id":)" + std::to_string(id) + "}");
  REQUIRE(contains(rt.reply(id), "\"done\":true"));
  const auto end = Clock::now() + std::chrono::seconds(kSanitized ? 10 : 3);
  while (impl(rt.e).awake() && Clock::now() < end) Rt::pause(2);
  REQUIRE(!impl(rt.e).awake());  // the engine's atomic (the Model's sleep state is control-thread data)
  // CORE1 skeptic: a render that read awake_ before the flip may still finish one more quantum (seen under TSan:
  // time moved 128 frames after t0). Two more completed blocks guarantee a render that started after the flip.
  const long b0 = rt.blocks.load();
  for (const auto end2 = Clock::now() + std::chrono::seconds(kSanitized ? 10 : 3);
       rt.blocks.load() < b0 + 2 && Clock::now() < end2;)
    Rt::pause(1);
  const double t0 = rig_engine_time(rt.e);
  Rt::pause(80);
  CHECK(rig_engine_time(rt.e) == t0);  // asleep: rig_render writes silence and time stands still
}

/** True once engine time moves again within `ms`. */
bool timeRuns(Rt &rt, int ms = 2000) {
  const double t0 = rig_engine_time(rt.e);
  const auto end = Clock::now() + std::chrono::milliseconds(ms);
  while (Clock::now() < end) {
    if (rig_engine_time(rt.e) > t0) return true;
    Rt::pause(2);
  }
  return false;
}

}  // namespace

// ctest unit.runtime_cache: the CI TSan regex ("runtime") covers it
TEST_SUITE("runtime_cache") {
  TEST_CASE("mackit O1: 16 sampler slots prepared cold (no cache preload) sound in realtime: 8 notes = 128 voices") {
    // Before the fix the control loop never called the cache's pump(): decodes finished on the workers and sat in
    // the mailbox, `get sampleStatus` never reported loaded, and 8 held notes in 16 slots of ep-rhodes made 0 voices.
    Rt rt;
    rt.post(R"({"v":1,"op":"hello","protocol":1,"id":1})");
    REQUIRE(!rt.reply(1).empty());
    rt.post(R"({"v":1,"op":"audio","action":"start","id":2})");
    REQUIRE(!rt.reply(2).empty());
    const long allocs0 = rigtest::g_rtAllocs;  // the audio thread's allocation trap (read again after its join)
    rt.startAudio();
    const std::string slots = slotsOf("ep-rhodes", 16);
    rt.post(R"({"v":1,"op":"prepare","id":3,"patch":{"slots":[)" + slots + "]}}");
    const std::string pr = rt.reply(3, 20000);
    REQUIRE(contains(pr, "\"token\":"));
    const long token = std::strtol(pr.c_str() + pr.find("\"token\":") + 8, nullptr, 10);
    rt.post(R"({"v":1,"op":"commit","id":4,"token":)" + std::to_string(token) + "}");
    REQUIRE(contains(rt.reply(4, 20000), "\"committed\":true"));

    // nothing preloaded: the samples arrive through the control loop's pump (woken by the decode workers)
    const auto t0 = Clock::now();
    bool loaded = false;
    for (int id = 100; !loaded && Clock::now() - t0 < std::chrono::seconds(kSanitized ? 180 : 60); ++id) {
      rt.post(R"({"v":1,"op":"get","what":"sampleStatus","id":)" + std::to_string(id) +
              R"(,"patches":[{"slots":[)" + slotsOf("ep-rhodes", 1) + "]}]}");
      const std::string r = rt.reply(id, 5000);
      loaded = contains(r, "\"loaded\":[true]");
      if (!loaded) Rt::pause(50);
    }
    const double loadSec = std::chrono::duration<double>(Clock::now() - t0).count();
    MESSAGE("ep-rhodes decoded and integrated without a preload in " << loadSec << " s");
    REQUIRE(loaded);

    rt.post(R"({"v":1,"op":"config","polyphony":128,"voiceLimit":0,"id":5})");  // the probe's sweep settings
    REQUIRE(contains(rt.reply(5), "\"ok\":true"));
    std::string notes = "[";
    for (int n = 0; n < 8; ++n)
      notes += std::string(n ? "," : "") + R"({"v":1,"op":"play","e":"on","vel":100,"n":)" + std::to_string(60 + n) +
               "}";
    rt.post(notes + "]");
    std::uint32_t v = 0;  // the most voices seen (ep-rhodes notes decay: the count falls again after a while)
    for (const auto end = Clock::now() + std::chrono::seconds(kSanitized ? 30 : 5);
         v < 128 && Clock::now() < end;) {
      Rt::pause(5);
      v = std::max(v, rt.voices());
    }
    MESSAGE("voices with 8 notes held in 16 slots of ep-rhodes: " << v);
    CHECK(v == 128);
    Rt::pause(150);
    CHECK(rt.peak.load() > 0.05f);  // heard, not only counted
    rt.post(R"({"v":1,"op":"play","e":"panic"})");
    rt.stopAudio();
    CHECK(rigtest::g_rtAllocs == allocs0);  // the pumped zone tables reach the audio thread without allocating there
  }

  TEST_CASE("mackit O1: a decode that finishes while the engine is destroyed wakes nobody") {
    // The decode workers belong to the cache service, which dies with the Model after the Engine's wake semaphore:
    // ~Engine unhooks the workers' wake first (WakeLink). A wake that captured the Engine itself would touch the
    // destroyed semaphore when a decode finishes in that window; this case exercises the window under ASan / TSan
    // (a guard: the window is narrow, so a passing run alone does not prove the link is needed).
    for (int round = 0; round < 3; ++round) {
      Rt rt;
      rt.post(R"({"v":1,"op":"hello","protocol":1,"id":1})");
      REQUIRE(!rt.reply(1).empty());
      rt.post(R"({"v":1,"op":"audio","action":"start","id":2})");
      REQUIRE(!rt.reply(2).empty());
      rt.post(R"({"v":1,"op":"prepare","id":3,"patch":{"slots":[)" + slotsOf("salamander-piano", 2) + "]}}");
      REQUIRE(contains(rt.reply(3, 20000), "\"token\":"));
      Rt::pause(20 * round);  // destroyed while the workers are still decoding
    }
  }

  TEST_CASE("W3A R1: audio restart / output while asleep wakes the engine; a host-initiated reopen does not") {
    g_starts = 0;
    g_stops = 0;
    const rig_host h = fakeHost();
    Rt rt(&h);
    g_eng = rt.e;
    rt.post(R"({"v":1,"op":"hello","protocol":1,"id":1})");
    REQUIRE(!rt.reply(1).empty());
    rt.post(R"({"v":1,"op":"audio","action":"start","id":2})");
    REQUIRE(rt.waitFor("\"state\":\"running\""));
    rt.startAudio();
    REQUIRE(timeRuns(rt));

    // 1. restart while asleep (audio.js restart(): a new context starts awake)
    sleepNow(rt, 10);
    std::size_t at = rt.mark();
    rt.post(R"({"v":1,"op":"audio","action":"restart","id":11})");
    REQUIRE(rt.waitAfter("\"restarted\":true", at, 5000));
    CHECK(rt.waitAfter("\"sleep\":\"awake\"", at, 100));  // the wake's `state` event (before the running one)
    CHECK(impl(rt.e).awake());
    CHECK(timeRuns(rt));  // rendering again with no perform call
    CHECK(g_stops.load() == 1);

    // 2. output change while asleep (setSinkId's fallback is a restart too)
    sleepNow(rt, 20);
    at = rt.mark();
    rt.post(R"({"v":1,"op":"audio","action":"output","deviceId":"usb-4out","id":21})");
    REQUIRE(!rt.reply(21).empty());
    REQUIRE(rt.waitAfter("\"restarted\":true", at, 5000));
    CHECK(rt.waitAfter("\"sleep\":\"awake\"", at, 100));
    CHECK(impl(rt.e).awake());
    CHECK(timeRuns(rt));

    // 3. the host reopens by itself (route change, interruption end): a suspended AudioContext stays suspended across
    //    a device change, so the engine stays asleep until the next perform call wakes it (W3A)
    sleepNow(rt, 30);
    const int starts = g_starts.load();
    rig_device_info info{};
    info.struct_size = sizeof info;
    info.sample_rate = 48000;
    info.channels = 2;
    info.device_id = "usb-4out";
    at = rt.mark();
    rig_host_audio_started(rt.e, &info);
    REQUIRE(rt.waitAfter("\"restarted\":true", at, 3000));  // the hand-off ran on the control thread
    CHECK(!rt.waitAfter("\"sleep\":\"awake\"", at, 50));
    CHECK(g_starts.load() == starts);
    CHECK(!impl(rt.e).awake());
    CHECK(!timeRuns(rt, 150));
    rt.post(R"({"v":1,"op":"play","e":"on","n":60,"vel":90})");
    const auto end2 = Clock::now() + std::chrono::seconds(3);
    while (!impl(rt.e).awake() && Clock::now() < end2) Rt::pause(2);
    CHECK(impl(rt.e).awake());
    CHECK(timeRuns(rt));
    rt.post(R"({"v":1,"op":"play","e":"panic"})");
    rt.stopAudio();
    g_eng = nullptr;
  }

  TEST_CASE("W3A R1: with no host (the caller renders), audio restart / output while asleep wakes the engine too") {
    // CORE1 skeptic: the requestAudio no-host branch has its own wake (engine.cpp); the case above covers the host one
    Rt rt;
    rt.post(R"({"v":1,"op":"hello","protocol":1,"id":1})");
    REQUIRE(!rt.reply(1).empty());
    rt.post(R"({"v":1,"op":"audio","action":"start","id":2})");
    REQUIRE(!rt.reply(2).empty());
    rt.startAudio();
    REQUIRE(timeRuns(rt));
    int id = 10;
    for (const char *action : {"restart", "output"}) {
      sleepNow(rt, id++);
      const std::size_t at = rt.mark();
      rt.post(std::string(R"({"v":1,"op":"audio","action":")") + action + R"(","id":)" + std::to_string(id) + "}");
      REQUIRE(!rt.reply(id++).empty());
      CHECK(rt.waitAfter("\"sleep\":\"awake\"", at, 2000));
      CHECK(impl(rt.e).awake());
      CHECK(timeRuns(rt));
    }
    rt.stopAudio();
  }
}
