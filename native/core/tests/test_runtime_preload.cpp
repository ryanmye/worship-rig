// CORE2A (T06 / T08 files): asynchronous sample loading on the realtime control loop (PARITY "UI parity" row 1).
// Before: `cache preload` ran CacheServiceImpl::preload, which busy-waited on pump() on the control thread, so while
// cold samples decoded no tick went out and no `play` was handled (a song switch to cold samples froze live input).
// Required behaviour (1.x web engine, audio.js prepare / preload): decoding never blocks the thread that handles input
// and ticks; `prepare` resolves once the new song's samples are decoded (the old song keeps playing meanwhile, and
// notes played in that window sound on it at once); `preload` resolves when its decodes are done; the newest song
// switch is served first.
//
// The decodes here are artificially slowed (a synthetic loader that sleeps per sample: no file I/O, the same cost
// under every sanitizer), so a load takes ~1-3 s like a cold song on this box.
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
#include "model/model.h"
#include "samples/cache_service.h"

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

/** The longest wall-clock gap allowed between two ticks while samples load (task spec: 100 ms; the meters ask for
 *  30 Hz, 33 ms). Sanitized builds run the control loop several times slower. */
constexpr double kMaxGapMs = kSanitized ? 250.0 : 100.0;

rig::Engine &impl(rig_engine *e) {
  return *reinterpret_cast<rig::Engine *>(e);
}

std::atomic<int> g_loads{0};
std::atomic<int> g_sleepMs{30};

/** A decode that takes g_sleepMs of wall time and yields 0.4 s of a quiet sine (no file I/O). Worker thread. */
rig::samples::LoadOutcome slowLoad(const rig::samples::LoadRequest &rq) {
  std::this_thread::sleep_for(std::chrono::milliseconds(g_sleepMs.load()));
  ++g_loads;
  std::vector<float> ch[1];
  const auto n = static_cast<std::size_t>(rq.engineRate * 0.4);
  ch[0].resize(n);
  const double f = 440.0 * std::pow(2.0, (rq.midi - 69) / 12.0);
  for (std::size_t i = 0; i < n; ++i)
    ch[0][i] = static_cast<float>(0.3 * std::sin(6.283185307179586 * f * static_cast<double>(i) / rq.engineRate));
  rig::samples::LoadOutcome o;
  o.buffer = rig::samples::makeStored(rig::samples::processSample(ch, 1, rq.engineRate, rq.midi, rq.opts),
                                      rq.engineRate, rq.storage);
  o.status = rig::samples::LoadOutcome::Status::Ok;
  return o;
}

struct Ev {
  Clock::time_point at;
  std::string text;
};

/** Realtime engine over the repo's app/ with the slow loader, every payload time-stamped, and a paced audio thread. */
struct Rt {
  rig_engine *e = nullptr;
  std::mutex mu;
  std::vector<Ev> evs;
  std::atomic<bool> stop{false};
  std::atomic<long> blocks{0};
  std::thread audio;

  Rt() {
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.mode = RIG_MODE_REALTIME;
    cfg.sample_rate = 48000;
    cfg.app_dir = RIG_REPO_DIR "/app";
    cfg.on_event = [](void *u, const char *j, size_t n) {
      auto *r = static_cast<Rt *>(u);
      const auto now = Clock::now();
      std::lock_guard<std::mutex> lk(r->mu);
      r->evs.push_back({now, std::string(j, n)});
    };
    cfg.event_user = this;
    e = rig_create(&cfg, nullptr);
    REQUIRE(e != nullptr);
    // before the first request: the control thread reads the loader only when it posts a decode (after rig_post)
    auto *cs = dynamic_cast<rig::samples::CacheServiceImpl *>(impl(e).model().service<rig::CacheService>());
    REQUIRE(cs != nullptr);
    cs->cache().setLoader(slowLoad);
  }
  ~Rt() {
    stopAudio();
    rig_destroy(e);
  }
  Rt(const Rt &) = delete;
  Rt &operator=(const Rt &) = delete;

  void post(const std::string &m) { REQUIRE(rig_post(e, m.data(), m.size()) == RIG_OK); }
  /** When the reply to `id` arrived (time_point{} if not within ms) and its text. */
  std::pair<Clock::time_point, std::string> reply(int id, int ms = 3000) {
    const std::string needle = "\"re\":" + std::to_string(id) + ",";
    const auto end = Clock::now() + std::chrono::milliseconds(ms);
    for (;;) {
      {
        std::lock_guard<std::mutex> lk(mu);
        for (const Ev &v : evs)
          if (v.text.find(needle) != std::string::npos) return {v.at, v.text};
      }
      if (Clock::now() >= end) return {Clock::time_point{}, std::string()};
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
  }
  bool replied(int id) {
    const std::string needle = "\"re\":" + std::to_string(id) + ",";
    std::lock_guard<std::mutex> lk(mu);
    for (const Ev &v : evs)
      if (v.text.find(needle) != std::string::npos) return true;
    return false;
  }
  /** Tick times in [from, to]. */
  std::vector<Clock::time_point> ticks(Clock::time_point from, Clock::time_point to) {
    std::vector<Clock::time_point> out;
    std::lock_guard<std::mutex> lk(mu);
    for (const Ev &v : evs)
      if (v.at >= from && v.at <= to && v.text.find("\"ev\":\"tick\"") != std::string::npos) out.push_back(v.at);
    return out;
  }
  /** The largest gap (ms) between consecutive ticks in [from, to], counting the window edges. */
  double maxGapMs(Clock::time_point from, Clock::time_point to) {
    const auto t = ticks(from, to);
    double worst = 0;
    Clock::time_point prev = from;
    for (const auto &x : t) {
      worst = std::max(worst, std::chrono::duration<double, std::milli>(x - prev).count());
      prev = x;
    }
    return std::max(worst, std::chrono::duration<double, std::milli>(to - prev).count());
  }
  void startAudio(unsigned block = 128) {
    audio = std::thread([this, block] {
      std::vector<float> l(block), r(block);
      float *p[2] = {l.data(), r.data()};
      auto next = Clock::now();
      while (!stop) {
        rig_render(e, p, 2, block, 0);
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
  /** hello, audio start, the render thread, 30 Hz meters; returns once ticks flow. */
  void boot() {
    post(R"({"v":1,"op":"hello","protocol":1,"id":1})");
    REQUIRE(!reply(1).second.empty());
    post(R"({"v":1,"op":"audio","action":"start","id":2})");
    REQUIRE(!reply(2).second.empty());
    startAudio();
    post(R"({"v":1,"op":"config","meters":{"rate":30},"id":3})");
    REQUIRE(!reply(3).second.empty());
    const auto t0 = Clock::now();
    while (ticks(t0, Clock::now()).size() < 3 && Clock::now() - t0 < std::chrono::seconds(10))
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    REQUIRE(ticks(t0, Clock::now()).size() >= 3);
  }
};

std::string patchOf(const char *id) {
  return std::string(R"({"slots":[{"instrument":{"type":"sampler","id":")") + id +
         R"("},"gain":0.2,"highNote":127,"mono":"off"}]})";
}
std::string synthPatch() {
  return R"({"slots":[{"instrument":{"type":"synth","id":"warm-pad"},"gain":0.2,"highNote":127,"mono":"off"}]})";
}
double ms(Clock::time_point a, Clock::time_point b) {
  return std::chrono::duration<double, std::milli>(b - a).count();
}
long tokenOf(const std::string &r) {
  const std::size_t at = r.find("\"token\":");
  return at == std::string::npos ? -1 : std::strtol(r.c_str() + at + 8, nullptr, 10);
}

}  // namespace

// ctest unit.runtime_preload: the CI TSan regex ("runtime") covers it
TEST_SUITE("runtime_preload") {
  TEST_CASE("CORE2A: a cold cache preload keeps the control loop live: ticks keep coming, a play is handled at once") {
    g_sleepMs = 25;
    Rt rt;
    rt.boot();
    // 90 + 88 samples x 25 ms on the decode worker(s): ~2-4 s of decoding
    const int before = g_loads.load();
    const auto t0 = Clock::now();
    rt.post(R"({"v":1,"op":"cache","action":"preload","pin":"add","id":10,"patches":[)" + patchOf("salamander-piano") +
            "," + patchOf("vibes") + "]}");
    std::this_thread::sleep_for(std::chrono::milliseconds(400));
    REQUIRE(!rt.replied(10));  // still decoding
    const auto tPlay = Clock::now();
    rt.post(R"({"v":1,"op":"play","e":"on","n":60,"vel":90,"id":11})");
    const auto pr = rt.reply(11, 5000);
    REQUIRE(!pr.second.empty());
    const double playMs = ms(tPlay, pr.first);
    MESSAGE("play reply during the preload after " << playMs << " ms");
    CHECK(playMs < kMaxGapMs);
    CHECK(!rt.replied(10));  // the play was answered while the samples were still decoding
    rt.post(R"({"v":1,"op":"play","e":"off","n":60})");
    const auto done = rt.reply(10, kSanitized ? 120000 : 30000);
    REQUIRE(!done.second.empty());
    CHECK(contains(done.second, "\"decodedMB\":"));
    CHECK(contains(done.second, "\"ok\":true"));
    const double loadMs = ms(t0, done.first);
    const double gap = rt.maxGapMs(t0, done.first);
    MESSAGE("preload of " << (g_loads.load() - before) << " samples took " << loadMs << " ms; largest tick gap "
                          << gap << " ms over " << rt.ticks(t0, done.first).size() << " ticks");
    CHECK(loadMs > 1000);  // it really was slow
    CHECK(gap < kMaxGapMs);
    // the `load {phase:'preload'}` event comes with it, and the samples are there
    rt.post(R"({"v":1,"op":"get","what":"sampleStatus","id":12,"patches":[)" + patchOf("salamander-piano") + "]}");
    CHECK(contains(rt.reply(12).second, "\"loaded\":[true]"));
  }

  TEST_CASE("CORE2A: prepare answers once the new song's samples are decoded; the old song plays meanwhile") {
    g_sleepMs = 25;
    Rt rt;
    rt.boot();
    rt.post(R"({"v":1,"op":"prepare","id":10,"patch":)" + synthPatch() + "}");
    const auto p0 = rt.reply(10);
    REQUIRE(tokenOf(p0.second) > 0);
    rt.post(R"({"v":1,"op":"commit","id":11,"token":)" + std::to_string(tokenOf(p0.second)) + "}");
    REQUIRE(contains(rt.reply(11).second, "\"committed\":true"));

    const auto t0 = Clock::now();
    rt.post(R"({"v":1,"op":"prepare","id":20,"patch":)" + patchOf("salamander-piano") + "}");
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    REQUIRE(!rt.replied(20));  // audio.js prepare: resolves after the decodes (contract 1.2 prepare)
    // a note in that window sounds on the playing song (warm-pad) at once
    const auto tPlay = Clock::now();
    rt.post(R"({"v":1,"op":"play","e":"on","n":64,"vel":90,"id":21})");
    const auto pr = rt.reply(21, 5000);
    REQUIRE(!pr.second.empty());
    CHECK(ms(tPlay, pr.first) < kMaxGapMs);
    std::uint32_t v = 0;
    for (const auto end = Clock::now() + std::chrono::milliseconds(kSanitized ? 2000 : 500);
         v == 0 && Clock::now() < end;) {
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
      v = rt.voices();
    }
    CHECK(v > 0);
    CHECK(!rt.replied(20));
    rt.post(R"({"v":1,"op":"play","e":"off","n":64})");

    const auto p1 = rt.reply(20, kSanitized ? 120000 : 30000);
    REQUIRE(tokenOf(p1.second) > 0);
    const double loadMs = ms(t0, p1.first);
    const double gap = rt.maxGapMs(t0, p1.first);
    MESSAGE("prepare of a cold salamander-piano answered after " << loadMs << " ms; largest tick gap " << gap << " ms");
    CHECK(loadMs > 1000);
    CHECK(gap < kMaxGapMs);
    // every sample is there when the reply comes (the commit lands on a complete instrument, as in 1.x)
    rt.post(R"({"v":1,"op":"get","what":"sampleStatus","id":22,"patches":[)" + patchOf("salamander-piano") + "]}");
    CHECK(contains(rt.reply(22).second, "\"loaded\":[true]"));
    rt.post(R"({"v":1,"op":"commit","id":23,"token":)" + std::to_string(tokenOf(p1.second)) + "}");
    CHECK(contains(rt.reply(23).second, "\"committed\":true"));
  }

  TEST_CASE("CORE2A: a newer song switch supersedes one still loading: the old prepare answers at once, the new one "
            "is decoded first") {
    g_sleepMs = 25;
    Rt rt;
    rt.boot();
    const auto t0 = Clock::now();
    rt.post(R"({"v":1,"op":"prepare","id":10,"patch":)" + patchOf("salamander-piano") + "}");
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    REQUIRE(!rt.replied(10));
    const auto t1 = Clock::now();
    rt.post(R"({"v":1,"op":"prepare","id":11,"patch":)" + patchOf("vibes") + "}");
    const auto a = rt.reply(10, 5000);  // superseded: answered now, not after its ~2 s of decodes
    REQUIRE(tokenOf(a.second) > 0);
    CHECK(ms(t1, a.first) < kMaxGapMs);
    const auto b = rt.reply(11, kSanitized ? 120000 : 30000);
    REQUIRE(tokenOf(b.second) > tokenOf(a.second));
    // the newest switch went first: vibes (88 samples) did not wait for the rest of salamander's 90
    rt.post(R"({"v":1,"op":"get","what":"sampleStatus","id":12,"patches":[)" + patchOf("vibes") + "," +
            patchOf("salamander-piano") + "]}");
    const std::string st = rt.reply(12).second;
    MESSAGE("vibes ready " << ms(t1, b.first) << " ms after its prepare; status then " << st);
    CHECK(contains(st, "\"loaded\":[true,false]"));
    CHECK(rt.maxGapMs(t0, b.first) < kMaxGapMs);
    rt.post(R"({"v":1,"op":"commit","id":13,"token":)" + std::to_string(tokenOf(a.second)) + "}");
    CHECK(contains(rt.reply(13).second, "\"ok\":false"));  // superseded token
    rt.post(R"({"v":1,"op":"commit","id":14,"token":)" + std::to_string(tokenOf(b.second)) + "}");
    CHECK(contains(rt.reply(14).second, "\"committed\":true"));
  }

  TEST_CASE("CORE2A: a newer preload is served before an older one still loading; both answer") {
    g_sleepMs = 25;
    Rt rt;
    rt.boot();
    const auto t0 = Clock::now();
    rt.post(R"({"v":1,"op":"cache","action":"preload","pin":"add","id":10,"patches":[)" + patchOf("salamander-piano") +
            "]}");
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    REQUIRE(!rt.replied(10));
    rt.post(R"({"v":1,"op":"cache","action":"preload","pin":"add","id":11,"patches":[)" + patchOf("celesta") + "]}");
    const auto b = rt.reply(11, kSanitized ? 120000 : 30000);
    REQUIRE(!b.second.empty());
    CHECK(!rt.replied(10));  // the older one still has samples to decode: the newer went first
    const auto a = rt.reply(10, kSanitized ? 120000 : 30000);
    REQUIRE(!a.second.empty());  // and it is not dropped (1.x: every preload resolves with its songs decoded)
    CHECK(a.first > b.first);
    rt.post(R"({"v":1,"op":"get","what":"sampleStatus","id":12,"patches":[)" + patchOf("celesta") + "," +
            patchOf("salamander-piano") + "]}");
    CHECK(contains(rt.reply(12).second, "\"loaded\":[true,true]"));
    CHECK(rt.maxGapMs(t0, a.first) < kMaxGapMs);
  }
}
