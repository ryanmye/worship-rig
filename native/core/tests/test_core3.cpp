// CORE3 (CORE2A O2, T11 / T15 / T13 files): synth / organ units of a song switch are built off the control thread,
// and the neighbours a pinned `cache preload` names are prebuilt in the background.
// Before: Model::prepare built every fresh instrument on the control thread. An organ costs ~60-70 ms (8 drawbar
// PeriodicWaves), a first use of a wavetable family 80-300 ms, so a switch to a synth / organ-heavy song stopped
// every tick and every `play` for up to a second on this box. Required (1.x, audio.js prepare / the controller):
// the old song keeps playing and live input, scenes and ticks flow while the new song is built; `prepare` resolves
// once it is built; the newest switch wins; a commit takes effect at once.
//
// The heavy song: 16 organ slots, each registration different, so every slot is a fresh ~60 ms build (~1 s on this box
// in Release, several seconds under the sanitizers) whatever wavetable banks earlier tests left warm.
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

#include "doctest.h"
#include "helpers.h"
#include "rig/rig_engine.h"

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

/** Task spec: no tick gap over 50 ms during a switch (30 Hz ticks = 33 ms). Sanitized builds run several times
 *  slower (as runtime_preload). */
constexpr double kMaxGapMs = kSanitized ? 250.0 : 50.0;

double ms(Clock::time_point a, Clock::time_point b) {
  return std::chrono::duration<double, std::milli>(b - a).count();
}

struct Ev {
  Clock::time_point at;
  std::string text;
};

/** Realtime engine over the repo's app/, every payload time-stamped, a paced audio thread (runtime_preload's Rt). */
struct Rt {
  rig_engine *e = nullptr;
  std::mutex mu;
  std::vector<Ev> evs;
  std::atomic<bool> stop{false};
  std::thread audio;
  int nextId = 100;

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
  }
  ~Rt() {
    stop = true;
    if (audio.joinable()) audio.join();
    rig_destroy(e);
  }
  Rt(const Rt &) = delete;
  Rt &operator=(const Rt &) = delete;

  void post(const std::string &m) { REQUIRE(rig_post(e, m.data(), m.size()) == RIG_OK); }
  std::pair<Clock::time_point, std::string> reply(int id, int msMax = 3000) {
    const std::string needle = "\"re\":" + std::to_string(id) + ",";
    const auto end = Clock::now() + std::chrono::milliseconds(msMax);
    for (;;) {
      {
        std::lock_guard<std::mutex> lk(mu);
        for (const Ev &v : evs)  // a flush may batch several payloads into one array: from this reply on
          if (const std::size_t at = v.text.find(needle); at != std::string::npos) return {v.at, v.text.substr(at)};
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
  /** Position of the reply to `id` in the event stream (-1 if none): reply order, also inside one batch. */
  long long replyIndex(int id) {
    const std::string needle = "\"re\":" + std::to_string(id) + ",";
    std::lock_guard<std::mutex> lk(mu);
    for (std::size_t k = 0; k < evs.size(); ++k)
      if (const std::size_t at = evs[k].text.find(needle); at != std::string::npos)
        return static_cast<long long>(k) * 100000000LL + static_cast<long long>(at);
    return -1;
  }
  double maxGapMs(Clock::time_point from, Clock::time_point to) {
    std::lock_guard<std::mutex> lk(mu);
    double worst = 0;
    Clock::time_point prev = from;
    for (const Ev &v : evs)
      if (v.at >= from && v.at <= to && v.text.find("\"ev\":\"tick\"") != std::string::npos) {
        worst = std::max(worst, ms(prev, v.at));
        prev = v.at;
      }
    return std::max(worst, ms(prev, to));
  }
  /** One request, its reply text. */
  std::string call(const std::string &body, int msMax = 5000) {
    const int id = nextId++;
    post("{\"v\":1," + body + ",\"id\":" + std::to_string(id) + "}");
    return reply(id, msMax).second;
  }
  /** A numeric `_debugStats` member. */
  double stat(const char *key) {
    const std::string s = call(R"("op":"get","what":"stats")");
    const std::string needle = std::string("\"") + key + "\":";
    const std::size_t at = s.find(needle);
    return at == std::string::npos ? -1 : std::strtod(s.c_str() + at + needle.size(), nullptr);
  }
  std::uint32_t voices() const {
    rig_meters m{};
    m.struct_size = sizeof m;
    rig_get_meters(e, &m);
    return m.voices;
  }
  void boot() {
    REQUIRE(!call(R"("op":"hello","protocol":1)").empty());
    REQUIRE(!call(R"("op":"audio","action":"start")").empty());
    audio = std::thread([this] {
      std::vector<float> l(128), r(128);
      float *p[2] = {l.data(), r.data()};
      auto next = Clock::now();
      while (!stop) {
        rig_render(e, p, 2, 128, 0);
        next += std::chrono::nanoseconds(static_cast<long long>(128 * 1e9 / 48000.0));
        std::this_thread::sleep_until(next);
        if (Clock::now() > next + std::chrono::milliseconds(50)) next = Clock::now();
      }
    });
    REQUIRE(!call(R"("op":"config","meters":{"rate":30})").empty());
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
  }
  /** prepare + commit, both answered; returns the token. */
  long switchTo(const std::string &patch, int msMax = 120000) {
    const std::string r = call("\"op\":\"prepare\",\"patch\":" + patch, msMax);
    const long t = tokenOf(r);
    REQUIRE(t > 0);
    REQUIRE(contains(call("\"op\":\"commit\",\"token\":" + std::to_string(t)), "\"committed\":true"));
    return t;
  }
  static long tokenOf(const std::string &r) {
    const std::size_t at = r.find("\"token\":");
    return at == std::string::npos ? -1 : std::strtol(r.c_str() + at + 8, nullptr, 10);
  }
};

std::string slot(const char *type, const char *id, const std::string &params = "{}") {
  return std::string(R"({"instrument":{"type":")") + type + R"(","id":")" + id +
         R"("},"gain":0.2,"highNote":127,"mono":"off","params":)" + params + "}";
}
/** `n` organ slots; `variant` changes every registration (a different song: nothing reused, nothing prebuilt). The
 *  prebuild tests use 10 (60 MB of the 64 MB prebuilt cap: 6 MB per organ). */
std::string heavySong(int variant, int n = 16) {
  static const char *kIds[] = {"gospel", "soft-pad", "full", "church"};
  std::string s = R"({"slots":[)";
  for (int i = 0; i < n; ++i) {
    if (i) s += ",";
    const std::string params = "{\"drawbar4\":" + std::to_string((i + variant) % 9) + ",\"drawbar6\":" +
                               std::to_string((i / 9 + variant * 3) % 9) + "}";
    s += slot("organ", kIds[i % 4], params);
  }
  return s + "]}";
}
std::string lightSong() {
  return std::string(R"({"slots":[)") + slot("synth", "warm-pad") + "]}";
}

}  // namespace

// ctest unit.core3 (TSan: the suite builds on two threads)
TEST_SUITE("core3") {
  TEST_CASE("CORE3: a switch to a 16-slot organ song during live play: ticks flow, a play mid-switch is handled at "
            "once, the prepare answers once the song is built, the commit lands") {
    Rt rt;
    rt.boot();
    rt.switchTo(lightSong());
    rt.post(R"({"v":1,"op":"play","e":"on","n":60,"vel":90})");  // held over the switch: the old song plays on
    const double built0 = rt.stat("buildsOffThread");

    const auto t0 = Clock::now();
    const int pid = rt.nextId++;
    rt.post("{\"v\":1,\"op\":\"prepare\",\"id\":" + std::to_string(pid) + ",\"patch\":" + heavySong(0) + "}");
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    const int nid = rt.nextId++;
    const auto tPlay = Clock::now();
    rt.post("{\"v\":1,\"op\":\"play\",\"e\":\"on\",\"n\":64,\"vel\":90,\"id\":" + std::to_string(nid) + "}");
    const auto pl = rt.reply(nid, 10000);
    REQUIRE(!pl.second.empty());
    const double playMs = ms(tPlay, pl.first);
    const bool replyBeforePlay = rt.replied(pid);
    MESSAGE("play sent 30 ms into the switch answered after " << playMs << " ms");
    CHECK(playMs < kMaxGapMs);
    CHECK(!replyBeforePlay);  // the song was still being built (the reply waits for it)
    CHECK(rt.voices() > 0);   // the old song sounds meanwhile

    const auto pr = rt.reply(pid, kSanitized ? 300000 : 60000);
    REQUIRE(Rt::tokenOf(pr.second) > 0);
    const double buildMs = ms(t0, pr.first);
    const double gap = rt.maxGapMs(t0, pr.first);
    MESSAGE("16 organs built off the control thread in " << buildMs << " ms; largest tick gap " << gap << " ms");
    CHECK(buildMs > 200);  // it really was a heavy build (~1 s in Release on this box)
    CHECK(gap < kMaxGapMs);
    const auto tc = Clock::now();
    const std::string c = rt.call("\"op\":\"commit\",\"token\":" + std::to_string(Rt::tokenOf(pr.second)));
    CHECK(contains(c, "\"committed\":true"));
    MESSAGE("commit answered after " << ms(tc, Clock::now()) << " ms");
    CHECK(rt.stat("buildsOffThread") - built0 == 16);
    CHECK(rt.stat("buildsAtCommit") == 0);
    rt.post(R"({"v":1,"op":"play","e":"off","n":60})");
    rt.post(R"({"v":1,"op":"play","e":"off","n":64})");
    // the new song plays: a note on it starts voices
    rt.post(R"({"v":1,"op":"play","e":"on","n":67,"vel":90})");
    std::uint32_t v = 0;
    for (const auto end = Clock::now() + std::chrono::milliseconds(2000); v == 0 && Clock::now() < end;) {
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
      v = rt.voices();
    }
    CHECK(v > 0);
  }

  TEST_CASE("CORE3: a neighbour named by a pinned preload is prebuilt; the switch to it builds nothing") {
    Rt rt;
    rt.boot();
    rt.switchTo(lightSong());
    // controller.js preloadNeighbors: [prev, next] with pin 'add'
    const std::string pre = rt.call(R"("op":"cache","action":"preload","pin":"add","patches":[)" + heavySong(1, 10) + "," +
                                        lightSong() + "]",
                                    30000);
    REQUIRE(contains(pre, "\"ok\":true"));
    CHECK(rt.stat("prebuildPosted") == 10);  // light song: slot 0 is the playing warm-pad (reused, skipped)
    const auto tw = Clock::now();
    // (a core without prebuilds has no such stat: -1, no wait; the timing check below then fails on its own)
    const auto waitEnd = tw + std::chrono::seconds(kSanitized ? 300 : 60);
    for (double d = rt.stat("prebuiltDone"); d >= 0 && d < 10 && Clock::now() < waitEnd; d = rt.stat("prebuiltDone"))
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    CHECK(rt.stat("prebuiltDone") == 10);
    CHECK(rt.stat("buildsPending") == 0);
    const double hits0 = rt.stat("prebuildHits"), commit0 = rt.stat("buildsAtCommit");
    const double built0 = rt.stat("channelsBuilt");

    const auto t0 = Clock::now();
    const std::string pr = rt.call("\"op\":\"prepare\",\"patch\":" + heavySong(1, 10), 10000);
    const double prepMs = ms(t0, Clock::now());
    REQUIRE(Rt::tokenOf(pr) > 0);
    MESSAGE("prepare of the prebuilt neighbour answered after " << prepMs << " ms");
    CHECK(prepMs < kMaxGapMs);  // nothing left to build (10 organs take ~0.7 s)
    CHECK(contains(rt.call("\"op\":\"commit\",\"token\":" + std::to_string(Rt::tokenOf(pr))), "\"committed\":true"));
    CHECK(rt.stat("prebuildHits") - hits0 == 10);
    CHECK(rt.stat("buildsAtCommit") == commit0);
    CHECK(rt.stat("channelsBuilt") - built0 == 10);
    CHECK(rt.stat("prebuilt") == 0);  // adopted, not copied
    CHECK(rt.maxGapMs(tw, Clock::now()) < kMaxGapMs);  // prebuilding never held the control loop either
  }

  TEST_CASE("CORE3: supersede with prebuilt and unbuilt songs: the newest switch wins, an older prepare still "
            "answers, the superseded song's units are kept for a switch back") {
    Rt rt;
    rt.boot();
    rt.switchTo(lightSong());
    // A (prebuilt neighbour) and B (never named): prepare B, then A before B is built
    rt.call(R"("op":"cache","action":"preload","pin":"replace","patches":[)" + heavySong(2, 10) + "]", 30000);
    for (const auto end = Clock::now() + std::chrono::seconds(kSanitized ? 300 : 60);
         rt.stat("prebuiltDone") < 10 && Clock::now() < end;)
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    REQUIRE(rt.stat("prebuiltDone") == 10);

    const auto t0 = Clock::now();
    const int pb = rt.nextId++, pa = rt.nextId++;
    rt.post("{\"v\":1,\"op\":\"prepare\",\"id\":" + std::to_string(pb) + ",\"patch\":" + heavySong(3, 10) + "}");
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    CHECK(!rt.replied(pb));
    const auto t1 = Clock::now();
    rt.post("{\"v\":1,\"op\":\"prepare\",\"id\":" + std::to_string(pa) + ",\"patch\":" + heavySong(2, 10) + "}");
    const auto rb = rt.reply(pb, 10000);  // superseded: answered at once, with its token
    const auto ra = rt.reply(pa, 10000);  // prebuilt: nothing to wait for
    REQUIRE(Rt::tokenOf(rb.second) > 0);
    REQUIRE(Rt::tokenOf(ra.second) > Rt::tokenOf(rb.second));
    MESSAGE("superseded B answered " << ms(t1, rb.first) << " ms, prebuilt A " << ms(t1, ra.first)
                                     << " ms after A's prepare");
    CHECK(ms(t1, rb.first) < kMaxGapMs);
    CHECK(ms(t1, ra.first) < kMaxGapMs);
    CHECK(rt.replyIndex(pb) < rt.replyIndex(pa));
    CHECK(contains(rt.call("\"op\":\"commit\",\"token\":" + std::to_string(Rt::tokenOf(rb.second))), "\"ok\":false"));
    CHECK(contains(rt.call("\"op\":\"commit\",\"token\":" + std::to_string(Rt::tokenOf(ra.second))),
                   "\"committed\":true"));
    // B's 10 jobs (built or still building) joined the prebuilt set: a switch back to B adopts them
    CHECK(rt.stat("prebuilt") == 10);
    const double hits0 = rt.stat("prebuildHits");
    const auto t2 = Clock::now();
    const std::string r2 = rt.call("\"op\":\"prepare\",\"patch\":" + heavySong(3, 10), kSanitized ? 300000 : 60000);
    REQUIRE(Rt::tokenOf(r2) > 0);
    CHECK(rt.stat("prebuildHits") - hits0 == 10);
    CHECK(contains(rt.call("\"op\":\"commit\",\"token\":" + std::to_string(Rt::tokenOf(r2))), "\"committed\":true"));
    CHECK(rt.maxGapMs(t0, Clock::now()) < kMaxGapMs);
    MESSAGE("switch back to B answered after " << ms(t2, Clock::now()) << " ms");

    // two unbuilt songs: C superseded by D; D is built first (C's queued jobs drop to prebuild priority)
    const int pc = rt.nextId++, pd = rt.nextId++;
    const auto t3 = Clock::now();
    rt.post("{\"v\":1,\"op\":\"prepare\",\"id\":" + std::to_string(pc) + ",\"patch\":" + heavySong(4, 10) + "}");
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    rt.post("{\"v\":1,\"op\":\"prepare\",\"id\":" + std::to_string(pd) + ",\"patch\":" + heavySong(5, 10) + "}");
    const auto rc = rt.reply(pc, 10000);
    const auto rd = rt.reply(pd, kSanitized ? 300000 : 60000);
    REQUIRE(Rt::tokenOf(rc.second) > 0);
    REQUIRE(Rt::tokenOf(rd.second) > 0);
    CHECK(ms(t3, rc.first) < 30 + kMaxGapMs);
    const double cDone = rt.stat("prebuiltDone");
    MESSAGE("D (newest) built after " << ms(t3, rd.first) << " ms; C's units done then: " << cDone << " of 10");
    CHECK(cDone < 10);  // D did not wait for the rest of C
    CHECK(contains(rt.call("\"op\":\"commit\",\"token\":" + std::to_string(Rt::tokenOf(rd.second))),
                   "\"committed\":true"));
    CHECK(rt.maxGapMs(t3, Clock::now()) < kMaxGapMs);
  }

  TEST_CASE("CORE3: a commit sent before the prepare reply takes effect at once (builds what is left inline); the "
            "prepare reply goes out first") {
    Rt rt;
    rt.boot();
    rt.switchTo(lightSong());
    const int pid = rt.nextId++, cid = rt.nextId++;
    const double off0 = rt.stat("buildsOffThread"), at0 = rt.stat("buildsAtCommit");
    rt.post("{\"v\":1,\"op\":\"prepare\",\"id\":" + std::to_string(pid) + ",\"patch\":" + heavySong(6) + "}");
    // the token is the next one (raw client: it does not wait for the reply)
    rt.post("{\"v\":1,\"op\":\"commit\",\"id\":" + std::to_string(cid) + ",\"token\":2}");
    const auto c = rt.reply(cid, kSanitized ? 300000 : 60000);
    REQUIRE(!c.second.empty());
    CHECK(contains(c.second, "\"committed\":true"));
    CHECK(rt.replied(pid));
    CHECK(rt.replyIndex(pid) < rt.replyIndex(cid));
    const double off = rt.stat("buildsOffThread") - off0, at = rt.stat("buildsAtCommit") - at0;
    MESSAGE("built on the worker " << off << ", inline at the commit " << at);
    CHECK(off + at == 16);
    CHECK(at > 0);
  }

  TEST_CASE("CORE3: offline, units are built inline at prepare (renders unchanged); nothing is prebuilt") {
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.mode = RIG_MODE_OFFLINE;
    cfg.sample_rate = 48000;
    cfg.app_dir = RIG_REPO_DIR "/app";
    static std::string last;
    cfg.on_event = [](void *, const char *j, size_t n) { last.assign(j, n); };
    rig_engine *e = rig_create(&cfg, nullptr);
    REQUIRE(e != nullptr);
    auto post = [&](const std::string &m) {
      REQUIRE(rig_post(e, m.data(), m.size()) == RIG_OK);
      return last;
    };
    post(R"({"v":1,"op":"hello","protocol":1,"id":1})");
    post(R"({"v":1,"op":"audio","action":"start","id":2})");
    post(R"({"v":1,"op":"cache","action":"preload","pin":"add","id":3,"patches":[)" + heavySong(7) + "]}");
    const std::string pr = post("{\"v\":1,\"op\":\"prepare\",\"id\":4,\"patch\":" + heavySong(7) + "}");
    REQUIRE(Rt::tokenOf(pr) > 0);
    post("{\"v\":1,\"op\":\"commit\",\"id\":5,\"token\":" + std::to_string(Rt::tokenOf(pr)) + "}");
    CHECK(contains(last, "\"committed\":true"));
    const std::string st = post(R"({"v":1,"op":"get","what":"stats","id":6})");
    CHECK(contains(st, "\"buildsOffThread\":0"));
    CHECK(contains(st, "\"prebuildPosted\":0"));
    CHECK(contains(st, "\"channelsBuilt\":16"));
    rig_destroy(e);
  }
}
