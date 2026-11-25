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
#include "model/build_worker.h"  // BuildWorker::testPrebuildDelayMs (a starved prebuild, deterministic)
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
/** Over the long windows (seconds of prebuilding, a supersede sequence with stats polls) a loaded 2-CPU box (ctest -j2
 *  next to other builds: 51 ms seen once at load 4) needs more slack; still far below one organ build (60-70 ms each,
 *  ~0.6-1.6 s for these songs before CORE3). The bound runtime_preload uses. */
constexpr double kLongGapMs = kSanitized ? 250.0 : 100.0;

/** An idle box: the loop's own largest gap is one 30 Hz tick (33 ms) plus scheduling jitter (37 ms on this box). */
constexpr double kIdleLoopMs = 40;
/** The tick-gap bound of a switch: kMaxGapMs on an idle box; on a loaded one 1.5 x the loop's own largest gap over
 *  two idle seconds (CORE3 finish pass: next to two busy threads on this 2-CPU box the idle loop alone shows 48-65 ms
 *  gaps, CFS slices, with no switch at all). CORE3 review: the finish pass's 1.3 x one idle second failed 1 of 2
 *  loaded runs (switch gap 72.9 ms, bound 72.8): the switch window is 4 s there, and the switch lane is one more
 *  runnable thread. Before CORE3 a switch to these songs held the loop for the whole build, 1.1-1.6 s idle and
 *  ~4 s loaded, so the bound stays an order of magnitude below a held loop. */
double gapBound(double idleGapMs) {
  return idleGapMs <= kIdleLoopMs ? kMaxGapMs : std::max(kMaxGapMs, idleGapMs * 1.5);
}

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

  explicit Rt(rig_profile profile = RIG_PROFILE_DESKTOP) {
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.mode = RIG_MODE_REALTIME;
    cfg.profile = profile;
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
    const auto ti = Clock::now();
    std::this_thread::sleep_for(std::chrono::milliseconds(2000));
    const double idleGap = rt.maxGapMs(ti, Clock::now());
    const double bound = gapBound(idleGap);
    MESSAGE("idle loop: largest tick gap " << idleGap << " ms; switch bound " << bound << " ms");
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
    CHECK(playMs < bound);
    CHECK(!replyBeforePlay);  // the song was still being built (the reply waits for it)
    CHECK(rt.voices() > 0);   // the old song sounds meanwhile

    const auto pr = rt.reply(pid, kSanitized ? 300000 : 60000);
    REQUIRE(Rt::tokenOf(pr.second) > 0);
    const double buildMs = ms(t0, pr.first);
    const double gap = rt.maxGapMs(t0, pr.first);
    MESSAGE("16 organs built off the control thread in " << buildMs << " ms; largest tick gap " << gap << " ms");
    CHECK(buildMs > 200);  // it really was a heavy build (~1 s in Release on this box)
    CHECK(gap < bound);
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
    const std::string pre = rt.call(R"("op":"cache","action":"preload","pin":"add","patches":[)" + heavySong(1, 10) +
                                        "," +
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
    CHECK(rt.maxGapMs(tw, Clock::now()) < kLongGapMs);  // prebuilding never held the control loop either
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
    const double hits0 = rt.stat("prebuildHits"), busy0 = rt.stat("prebuildBusy");
    const auto t2 = Clock::now();
    const std::string r2 = rt.call("\"op\":\"prepare\",\"patch\":" + heavySong(3, 10), kSanitized ? 300000 : 60000);
    REQUIRE(Rt::tokenOf(r2) > 0);
    // adopted, except at most the one the prebuild lane is building at this moment (the switch builds its own)
    const double hits = rt.stat("prebuildHits") - hits0, busy = rt.stat("prebuildBusy") - busy0;
    MESSAGE("switch back to B: " << hits << " adopted, " << busy << " in the prebuild lane's hands");
    CHECK(hits + busy == 10);
    CHECK(busy <= 1);
    CHECK(contains(rt.call("\"op\":\"commit\",\"token\":" + std::to_string(Rt::tokenOf(r2))), "\"committed\":true"));
    CHECK(rt.maxGapMs(t0, Clock::now()) < kLongGapMs);
    MESSAGE("switch back to B answered after " << ms(t2, Clock::now()) << " ms");

    // two unbuilt songs: C superseded by D; D is built first (C's queued jobs move to the prebuild lane). D is posted
    // once C is prepared (a stats round trip): the bound is measured from D's post, not from C's (CORE3 finish
    // pass: the macOS CI runner failed `ms(t3, rc) < 30 + 50` at 145.8 ms with C measured from before a 30 ms
    // test-thread sleep; the tick gap over the same window stayed under 100 ms, so the control loop was not held:
    // the sleep / test thread was late).
    const int pc = rt.nextId++, pd = rt.nextId++;
    const auto t3 = Clock::now();
    rt.post("{\"v\":1,\"op\":\"prepare\",\"id\":" + std::to_string(pc) + ",\"patch\":" + heavySong(4, 10) + "}");
    const std::string dBody = "{\"v\":1,\"op\":\"prepare\",\"id\":" + std::to_string(pd) + ",\"patch\":" +
                              heavySong(5, 10) + "}";
    CHECK(rt.stat("buildsPending") > 0);  // answered after C (FIFO): C is prepared, its units are building
    const bool cOpen = !rt.replied(pc);  // C is still building (10 organs: >= 0.2 s anywhere)
    const auto tD = Clock::now();
    rt.post(dBody);
    const auto rc = rt.reply(pc, 10000);
    const auto rd = rt.reply(pd, kSanitized ? 300000 : 60000);
    REQUIRE(Rt::tokenOf(rc.second) > 0);
    REQUIRE(Rt::tokenOf(rd.second) > 0);
    REQUIRE(cOpen);
    MESSAGE("C answered " << ms(tD, rc.first) << " ms after D's prepare was posted (" << ms(t3, rc.first)
                          << " ms after its own)");
    CHECK(ms(tD, rc.first) < kMaxGapMs);  // before CORE3: after C's inline build, 0.6 s on this box
    MESSAGE("D (newest) built after " << ms(tD, rd.first) << " ms; C's units done then: " << rt.stat("prebuiltDone")
                                      << " of 10");
    // C's 10 units (built, building, or queued in the prebuild lane) are kept for a switch back. That D never waits
    // for them is the "prebuild in flight" case below (deterministic there).
    CHECK(rt.stat("prebuilt") == 10);
    CHECK(contains(rt.call("\"op\":\"commit\",\"token\":" + std::to_string(Rt::tokenOf(rd.second))),
                   "\"committed\":true"));
    CHECK(rt.maxGapMs(t3, Clock::now()) < kLongGapMs);
  }

  TEST_CASE("CORE3: a switch is never queued behind a neighbour prebuild in flight; its reply is bounded by its own "
            "build") {
    // CORE3 finish pass (handoff: a 5.4 s prepare reply and 658 ms gaps in ui-core run ui2). A prebuild runs on a
    // utility-priority thread, which a busy box starves (two busy threads here: 16 organs took 13-14 s instead of
    // 1.1 s). The hook makes every prebuild lane job sleep before it builds: a starved prebuild, deterministically.
    struct DelayGuard {
      explicit DelayGuard(int d) { rig::BuildWorker::testPrebuildDelayMs = d; }
      ~DelayGuard() { rig::BuildWorker::testPrebuildDelayMs = 0; }
    };
    const int delayMs = kSanitized ? 60000 : 5000;
    Rt rt;
    rt.boot();
    rt.switchTo(lightSong());
    // reference: a fresh 4-organ switch with nothing else in flight
    auto t = Clock::now();
    std::string r = rt.call("\"op\":\"prepare\",\"patch\":" + heavySong(10, 4), kSanitized ? 300000 : 60000);
    const double refMs = ms(t, Clock::now());
    REQUIRE(Rt::tokenOf(r) > 0);
    REQUIRE(contains(rt.call("\"op\":\"commit\",\"token\":" + std::to_string(Rt::tokenOf(r))), "\"committed\":true"));

    DelayGuard guard(delayMs);
    REQUIRE(contains(rt.call(R"("op":"cache","action":"preload","pin":"add","patches":[)" + heavySong(12, 10) + "]",
                             30000),
                     "\"ok\":true"));
    std::this_thread::sleep_for(std::chrono::milliseconds(100));  // the prebuild lane has claimed its first job
    CHECK(rt.stat("prebuiltDone") == 0);

    // (a) an unrelated song: its 4 organs are built in the switch lane, never behind the prebuild
    t = Clock::now();
    r = rt.call("\"op\":\"prepare\",\"patch\":" + heavySong(11, 4), kSanitized ? 300000 : 60000);
    const double aMs = ms(t, Clock::now());
    REQUIRE(Rt::tokenOf(r) > 0);
    MESSAGE("reference 4-organ switch " << refMs << " ms; the same size with a prebuild in flight " << aMs << " ms");
    // the deterministic bound: well below the prebuild in flight (before: >= delayMs, the switch queued behind it);
    // the reference bound is loose because a loaded box varies the build time itself 2-3x
    CHECK(aMs < delayMs / 2);
    CHECK(aMs < 4 * refMs + 500);
    REQUIRE(contains(rt.call("\"op\":\"commit\",\"token\":" + std::to_string(Rt::tokenOf(r))), "\"committed\":true"));

    // (b) the very neighbour being prebuilt: the unit the prebuild lane holds is built again in the switch lane, the
    // nine still queued move to the switch lane
    const double hits0 = rt.stat("prebuildHits"), busy0 = rt.stat("prebuildBusy");
    t = Clock::now();
    r = rt.call("\"op\":\"prepare\",\"patch\":" + heavySong(12, 10), kSanitized ? 300000 : 60000);
    const double bMs = ms(t, Clock::now());
    REQUIRE(Rt::tokenOf(r) > 0);
    MESSAGE("the neighbour being prebuilt: " << bMs << " ms (10 organs)");
    CHECK(bMs < delayMs / 2);
    CHECK(bMs < 10 * refMs + 1000);  // 10 organs (2.5 references), the switch lane alone
    CHECK(rt.stat("prebuildBusy") - busy0 == 1);
    CHECK(rt.stat("prebuildHits") - hits0 == 9);
    CHECK(contains(rt.call("\"op\":\"commit\",\"token\":" + std::to_string(Rt::tokenOf(r))), "\"committed\":true"));
  }

  TEST_CASE("CORE3: a newer prepare without an id still answers the older one at once") {
    Rt rt;
    rt.boot();
    rt.switchTo(lightSong());
    const int pc = rt.nextId++;
    rt.post("{\"v\":1,\"op\":\"prepare\",\"id\":" + std::to_string(pc) + ",\"patch\":" + heavySong(13, 10) + "}");
    CHECK(rt.stat("buildsPending") > 0);  // C is prepared
    const bool cOpen = !rt.replied(pc);
    const auto tD = Clock::now();
    rt.post("{\"v\":1,\"op\":\"prepare\",\"patch\":" + heavySong(14, 4) + "}");  // no id: no reply of its own
    const auto rc = rt.reply(pc, kSanitized ? 300000 : 20000);
    REQUIRE(cOpen);
    REQUIRE(Rt::tokenOf(rc.second) > 0);
    MESSAGE("older prepare answered " << ms(tD, rc.first) << " ms after the newer one (no id) was posted");
    CHECK(ms(tD, rc.first) < kMaxGapMs);  // before: never (its build callback died with the superseded plan)
    rt.switchTo(lightSong());
  }

  TEST_CASE("CORE3: the prebuilt set stays within its cap (64 MB desktop, 32 MB iPad), LRU; memory pressure empties "
            "it") {
    // charged 6 MB per organ (measured RSS 5.8 MB per instance with warm banks): 2 x 10 organs = 120 MB asked for
    for (const rig_profile prof : {RIG_PROFILE_DESKTOP, RIG_PROFILE_IPAD}) {
      const double capMB = prof == RIG_PROFILE_IPAD ? 32 : 64;
      Rt rt(prof);
      rt.boot();
      rt.switchTo(lightSong());
      REQUIRE(contains(rt.call(R"("op":"cache","action":"preload","pin":"add","patches":[)" + heavySong(15, 10) + "," +
                                   heavySong(16, 10) + "]",
                               30000),
                       "\"ok\":true"));
      const double mb = rt.stat("prebuiltMB"), n = rt.stat("prebuilt"), ev = rt.stat("prebuildEvicted");
      MESSAGE("profile " << prof << ": " << n << " units kept, " << mb << " MB charged, " << ev << " evicted");
      CHECK(rt.stat("prebuildPosted") == 20);
      CHECK(mb <= capMB);
      CHECK(n == std::floor(capMB / 6));
      CHECK(ev == 20 - n);
      // the first-named song is the one kept (controller.js pinWindow names the Next song before the ones further
      // away; CORE3 review O1: request-order stamps evicted it first): naming it again posts only what the cap left
      // out (desktop nothing, iPad its last 5 slots)
      rt.call(R"("op":"cache","action":"preload","pin":"add","patches":[)" + heavySong(15, 10) + "]", 30000);
      CHECK(rt.stat("prebuildPosted") == 20 + (10 - n));
      CHECK(rt.stat("prebuiltMB") <= capMB);
      for (const auto end = Clock::now() + std::chrono::seconds(kSanitized ? 300 : 60);
           rt.stat("buildsPending") > 0 && Clock::now() < end;)
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
      CHECK(rt.stat("buildsPending") == 0);  // evicted queued jobs were skipped, nothing left behind
      rig_host_memory_pressure(rt.e, 1);
      double left = -1;
      for (const auto end = Clock::now() + std::chrono::seconds(5); left != 0 && Clock::now() < end;) {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        left = rt.stat("prebuilt");
      }
      CHECK(left == 0);
      // LRU across requests (CORE3 review): X and Y fit, X is named again, then Z overflows the cap by `over` units:
      // those come out of Y (the least recently named), X stays whole
      const int u = prof == RIG_PROFILE_IPAD ? 2 : 4, over = prof == RIG_PROFILE_IPAD ? 1 : 2;  // 3u x 6 MB
      auto preload = [&](int variant) {
        rt.call(R"("op":"cache","action":"preload","pin":"add","patches":[)" + heavySong(variant, u) + "]", 30000);
        return rt.stat("prebuildPosted");
      };
      const double ev0 = rt.stat("prebuildEvicted");
      preload(17);
      const double posted = preload(18);
      CHECK(preload(17) == posted);  // X named again: all there, nothing posted, X is now the newest
      CHECK(preload(19) == posted + u);
      CHECK(rt.stat("prebuildEvicted") - ev0 == over);
      CHECK(preload(17) == posted + u);         // X kept whole
      CHECK(preload(18) == posted + u + over);  // Y lost `over` units
      // a switch afterwards simply builds (nothing adopted)
      rt.switchTo(heavySong(15, 4));
    }
  }

  TEST_CASE("CORE3 review: a rate change while a switch is building: the reply still comes, the units are rebuilt at "
            "the new rate, the prebuilt set is dropped") {
    Rt rt;
    rt.boot();
    rt.switchTo(lightSong());
    REQUIRE(contains(rt.call(R"("op":"cache","action":"preload","pin":"add","patches":[)" + heavySong(20, 4) + "]",
                             30000),
                     "\"ok\":true"));
    CHECK(rt.stat("prebuilt") == 4);
    const double off0 = rt.stat("buildsOffThread"), at0 = rt.stat("buildsAtCommit");
    const int pid = rt.nextId++;
    rt.post("{\"v\":1,\"op\":\"prepare\",\"id\":" + std::to_string(pid) + ",\"patch\":" + heavySong(21, 10) + "}");
    CHECK(rt.stat("buildsPending") > 0);  // answered after the prepare (FIFO): its units are queued or building
    const bool open = !rt.replied(pid);
    rig_device_info info{};
    info.struct_size = sizeof info;
    info.sample_rate = 44100;
    info.channels = 2;
    info.output_latency_sec = 0.005;
    rig_host_audio_started(rt.e, &info);  // a route change to a 44.1 kHz device (rebuilds the plan's units)
    const auto pr = rt.reply(pid, kSanitized ? 300000 : 60000);
    REQUIRE(open);
    REQUIRE(Rt::tokenOf(pr.second) > 0);
    CHECK(rt.stat("prebuilt") == 0);  // built for 48 kHz: dropped
    CHECK(contains(rt.call("\"op\":\"commit\",\"token\":" + std::to_string(Rt::tokenOf(pr.second))),
                   "\"committed\":true"));
    CHECK(rt.stat("buildsOffThread") - off0 + rt.stat("buildsAtCommit") - at0 == 10);  // the 44.1 kHz jobs only
    CHECK(rt.stat("buildsPending") == 0);
    rt.post(R"({"v":1,"op":"play","e":"on","n":67,"vel":90})");
    std::uint32_t v = 0;
    for (const auto end = Clock::now() + std::chrono::milliseconds(2000); v == 0 && Clock::now() < end;) {
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
      v = rt.voices();
    }
    CHECK(v > 0);
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
