// T08 runtime: reliable garbage path (V13), ended bits after a Dropped event (SETUP_REVIEW 18), rate-change rebuild
// delivery (review 16), non-blocking audio_start + watchdog + busy (R25, G9), tick cadence (contract 6.5, G6, G7),
// host clock map, MIDI port table (21c).
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "api/engine.h"
#include "doctest.h"
#include "helpers.h"
#include "runtime/clock_map.h"
#include "runtime/midi_ports.h"
#include "test_runtime_probe.h"

using namespace rigtest;
using Clock = std::chrono::steady_clock;

namespace {

std::atomic<long> g_owned{0};
struct Counted final : rig::Owned {
  Counted() { ++g_owned; }
  ~Counted() override { --g_owned; }
};

rig::Engine &impl(rig_engine *e) {
  return *reinterpret_cast<rig::Engine *>(e);
}

/** Realtime engine with an optional fake host; events captured under a mutex. */
struct RtEngine {
  rig_engine *e = nullptr;
  rig_host host{};
  std::mutex mu;
  std::string all;
  std::vector<std::pair<Clock::time_point, std::string>> log;
  std::atomic<bool> stop{false};
  std::thread audio;

  explicit RtEngine(const rig_host *h = nullptr) {
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.mode = RIG_MODE_REALTIME;
    cfg.sample_rate = 48000;
    if (h) {
      host = *h;
      cfg.host = &host;
    }
    cfg.on_event = [](void *u, const char *j, size_t n) {
      auto *r = static_cast<RtEngine *>(u);
      std::lock_guard<std::mutex> lk(r->mu);
      r->all.append(j, n);
      r->log.emplace_back(Clock::now(), std::string(j, n));
    };
    cfg.event_user = this;
    e = rig_create(&cfg, nullptr);
    REQUIRE(e != nullptr);
  }
  ~RtEngine() {
    stopAudio();
    rig_destroy(e);
  }
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
  int countOf(const std::string &needle) {
    std::lock_guard<std::mutex> lk(mu);
    int n = 0;
    for (std::size_t p = all.find(needle); p != std::string::npos; p = all.find(needle, p + 1)) ++n;
    return n;
  }
  /** A platform audio thread paced at real time (blocks of `block` frames). */
  void startAudio(unsigned block = 256, double sr = 48000) {
    audio = std::thread([this, block, sr] {
      std::vector<float> l(block), r(block);
      float *p[2] = {l.data(), r.data()};
      auto next = Clock::now();
      std::uint64_t host = 1'000'000'000;
      while (!stop) {
        rig_render(e, p, 2, block, host);
        host += static_cast<std::uint64_t>(block * 1e9 / sr);
        next += std::chrono::nanoseconds(static_cast<long long>(block * 1e9 / sr));
        std::this_thread::sleep_until(next);
      }
    });
  }
  void stopAudio() {
    stop = true;
    if (audio.joinable()) audio.join();
  }
};

void hello(RtEngine &r) {
  r.post(R"({"v":1,"op":"hello","protocol":1,"app":"t","id":1})");
  REQUIRE(r.waitFor("\"re\":1,"));
}

}  // namespace

TEST_SUITE("runtime") {
  TEST_CASE("garbage never leaks: 58k owned payloads handed back with no control drain in between (V13)") {
    long before = g_owned;
    {
      OfflineEngine eng;
      eng.hello();
      rig::Engine &en = impl(eng.e);
      // no unit in the drone slot: every payload comes straight back as Garbage (heap-full drops too)
      for (int i = 0; i < 58000; ++i) {
        auto *p = new Counted();
        en.model().sendOwned(rig::UnitSlot::Drone, rig::opOf(static_cast<std::uint16_t>(0x7F01)), p, -1.0);
      }
      const auto &st = en.graph().stats();
      CHECK(st.garbageLost.load() == 0);  // the control side drains while sending: never beyond ring + stash
      eng.render(48000);
      CHECK(g_owned.load() == before);  // all freed on the control side while rendering
      CHECK(st.garbageLost.load() == 0);
    }
    CHECK(g_owned.load() == before);
  }

  TEST_CASE("graph: a full garbage ring parks pointers in the stash and flushes them in order (V13)") {
    auto *cq = new rig::CommandQueue();
    auto *eq = new rig::EventQueue();
    auto *meters = new rig::Seqlock<rig_meters>();
    auto *g = new rig::Graph(48000, *cq, *eq, *meters);
    const long before = g_owned;
    float l[128], r[128];
    float *out[2] = {l, r};
    long sent = 0;
    auto flood = [&](int n) {
      for (int i = 0; i < n; ++i) {
        rig::Command c{};
        c.op = rig::opOf(static_cast<std::uint16_t>(0x7F02));
        c.sub = rig::kSubOwnedPayload;
        c.target = static_cast<std::uint32_t>(rig::UnitSlot::Drone);  // empty slot: handed straight back
        c.frame = rig::kFrameNow;
        c.p.ptr = new Counted();
        REQUIRE(cq->push(c));
        ++sent;
      }
      g->renderQuantum(out, 2);
    };
    flood(16384);
    flood(16384);  // 32768: the ring is full
    flood(1000);   // parked
    CHECK(g->stats().garbageParked.load() == 1000);
    CHECK(g->stats().garbageLost.load() == 0);
    long freed = 0;
    rig::AudioEvent ev;
    while (g->popGarbage(ev)) {
      rig::freeGarbage(ev);
      ++freed;
    }
    CHECK(freed == 32768);
    g->renderQuantum(out, 2);  // the stash flushes into the drained ring
    while (g->popGarbage(ev)) {
      rig::freeGarbage(ev);
      ++freed;
    }
    CHECK(freed == sent);
    CHECK(g_owned.load() == before);
    delete g;
    delete meters;
    delete eq;
    delete cq;
  }

  TEST_CASE("Dropped: VoiceEnded lost to a full ring comes back as one rescan per slot (ended bits)") {
    OfflineEngine eng;
    eng.hello();
    rig::Engine &en = impl(eng.e);
    const int r0 = t08::g_rescans;
    REQUIRE(en.model().attachUnit(rig::UnitSlot::Drone, "t08.flood", -1.0));
    t08::g_floodPerQuantum = 5000;  // > 4096
    eng.render(128 * 3);
    t08::g_floodPerQuantum = 0;
    eng.render(128 * 3);
    CHECK(en.graph().stats().eventsDropped.load() > 0);
    CHECK(t08::g_rescans - r0 >= 1);
    CHECK(t08::g_rescanSlot == static_cast<int>(rig::UnitSlot::Drone));
    CHECK(en.graph().takeEndedSlots() == 0);  // consumed
  }

  TEST_CASE("rate change: every service gets onRateChanged once with the new rate; time stays monotonic") {
    OfflineEngine eng(48000);
    eng.hello();
    eng.call(R"({"v":1,"op":"audio","action":"start","id":2})");
    eng.render(4800);
    const double t0 = rig_engine_time(eng.e);
    const int c0 = t08::g_rateChanges;
    rig_device_info info{};
    info.struct_size = sizeof info;
    info.sample_rate = 96000;
    info.channels = 2;
    info.output_latency_sec = 0.005;
    eng.msgs.clear();
    rig_host_audio_started(eng.e, &info);
    std::string ev;
    for (auto &m : eng.msgs) ev += m;
    CHECK(contains(ev, "\"sampleRate\":96000"));
    eng.render(9600);
    CHECK(t08::g_rateChanges - c0 == 1);
    CHECK(t08::g_lastRate.load() == 96000);
    CHECK(rig_engine_time(eng.e) >= t0);
    CHECK(rig_engine_time(eng.e) == doctest::Approx(t0 + 0.1).epsilon(0.01));
    CHECK(impl(eng.e).model().env().sampleRate == 96000);  // factories build at the new rate
  }

  TEST_CASE("audio_start runs off the control thread: a host that blocks 400 ms does not stall replies") {
    static std::atomic<rig_engine *> eng{nullptr};
    rig_host h{};
    h.struct_size = sizeof h;
    h.audio_start = [](void *, const char *, double, uint32_t) {
      std::this_thread::sleep_for(std::chrono::milliseconds(400));  // a synchronous AUHAL open (R25)
      rig_device_info info{};
      info.struct_size = sizeof info;
      info.sample_rate = 48000;
      info.channels = 2;
      info.output_latency_sec = 0.0075;
      info.device_id = "fake";
      rig_host_audio_started(eng.load(), &info);
    };
    h.audio_stop = [](void *) {};
    RtEngine rt(&h);
    eng = rt.e;
    hello(rt);
    const auto t0 = Clock::now();
    rt.post(R"({"v":1,"op":"audio","action":"start","id":2})");
    rt.post(R"({"v":1,"op":"get","what":"stats","id":3})");
    REQUIRE(rt.waitFor("\"re\":3,"));
    CHECK(Clock::now() - t0 < std::chrono::milliseconds(300));  // answered while the host still blocks
    {
      std::lock_guard<std::mutex> lk(rt.mu);
      const auto ps = rt.all.find("\"ev\":\"state\""), pr = rt.all.find("\"re\":2,");
      CHECK(ps != std::string::npos);
      CHECK(ps < pr);  // G9: state before the audio reply
    }
    rt.post(R"({"v":1,"op":"audio","action":"restart","id":4})");  // still opening: busy
    REQUIRE(rt.waitFor("\"re\":4,"));
    CHECK(rt.countOf("\"code\":\"busy\"") == 1);
    REQUIRE(rt.waitFor("\"state\":\"running\"", 3000));
    CHECK(rt.waitFor("\"deviceId\":\"fake\""));
    rt.startAudio();
    REQUIRE(rt.waitFor("\"hostLatency\":0.007", 2000));  // G7: tick carries the host latency
    rt.post(R"({"v":1,"op":"audio","action":"restart","id":5})");
    REQUIRE(rt.waitFor("\"re\":5,"));
    CHECK(rt.waitFor("\"restarted\":true", 3000));
  }

  TEST_CASE("watchdog: no completion within 5 s -> state closed + device warning; the loop keeps running") {
    rig_host h{};
    h.struct_size = sizeof h;
    h.audio_start = [](void *, const char *, double, uint32_t) {};  // never reports back
    RtEngine rt(&h);
    hello(rt);
    rt.post(R"({"v":1,"op":"audio","action":"start","id":2})");
    REQUIRE(rt.waitFor("\"re\":2,"));
    rt.post(R"({"v":1,"op":"get","what":"state","id":3})");
    CHECK(rt.waitFor("\"re\":3,", 500));
    CHECK(rt.countOf("\"state\":\"closed\"") == 0);
    REQUIRE(rt.waitFor("\"code\":\"device\"", 7000));
    CHECK(rt.countOf("\"state\":\"closed\"") == 1);
    rt.post(R"({"v":1,"op":"audio","action":"start","id":4})");  // a new attempt is accepted after the timeout
    CHECK(rt.waitFor("\"re\":4,"));
  }

  TEST_CASE("ticks: 8 Hz idle floor (G6), the subscribed rate, stats every second, none while asleep") {
    RtEngine rt;
    hello(rt);
    rt.post(R"({"v":1,"op":"audio","action":"start","id":2})");
    REQUIRE(rt.waitFor("\"re\":2,"));
    rt.startAudio(441);
    auto ticksIn = [&](int ms) {
      const int a = rt.countOf("\"ev\":\"tick\"");
      std::this_thread::sleep_for(std::chrono::milliseconds(ms));
      return rt.countOf("\"ev\":\"tick\"") - a;
    };
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    const int idle = ticksIn(2000);
    MESSAGE("idle ticks in 2 s: " << idle);
    CHECK(idle >= 12);  // 8 Hz nominal; a loaded 2-CPU box may lose a few
    CHECK(idle <= 20);
    rt.post(R"({"v":1,"op":"config","meters":{"rate":4,"slots":[],"rta":false}})");  // the shim's idle request
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    CHECK(ticksIn(2000) >= 12);  // never below the floor
    rt.post(R"({"v":1,"op":"config","meters":{"rate":30,"slots":[0],"rta":true}})");
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    const int active = ticksIn(2000);
    MESSAGE("active ticks in 2 s: " << active);
    CHECK(active >= 45);
    CHECK(active <= 66);
    CHECK(rt.waitFor("\"rta\":\""));
    CHECK(rt.waitFor("\"slots\":[["));
    CHECK(rt.countOf("\"stats\":{") >= 4);  // ~1 per second over 6 s
    std::string lastTick;
    {
      std::lock_guard<std::mutex> lk(rt.mu);
      for (auto it = rt.log.rbegin(); it != rt.log.rend(); ++it)
        if (it->second.find("\"ev\":\"tick\"") != std::string::npos) {
          lastTick = it->second;
          break;
        }
    }
    for (const char *k : {"\"t\":", "\"frames\":", "\"out\":[", "\"blockers\":", "\"pedal\":", "\"held\":",
                          "\"runtime\":", "\"cpu\":"})
      CHECK(contains(lastTick, k));
    rt.post(R"({"v":1,"op":"audio","action":"sleep","ramp":0.05,"id":9})");
    REQUIRE(rt.waitFor("\"sleep\":\"asleep\"", 2000));
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    CHECK(ticksIn(600) == 0);
    rt.post(R"({"v":1,"op":"audio","action":"wake","id":10})");
    REQUIRE(rt.waitFor("\"wakeMs\":"));
    CHECK(ticksIn(600) > 0);
  }

  TEST_CASE("clock map: host time <-> engine time from rig_render timestamps") {
    rig::ClockMap m;
    CHECK(m.engineTimeAt(5) == -1.0);
    m.publish(2'000'000'000, 48000, 48000, 256);
    CHECK(m.engineTimeAt(2'000'000'000) == doctest::Approx(1.0));
    CHECK(m.engineTimeAt(2'500'000'000) == doctest::Approx(1.5));
    CHECK(m.hostTimeAt(1.25) == 2'250'000'000ull);
    RtEngine rt;
    hello(rt);
    rt.post(R"({"v":1,"op":"audio","action":"start","id":2})");
    REQUIRE(rt.waitFor("\"re\":2,"));
    rt.startAudio(256);
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    const rig::ClockPoint p = impl(rt.e).clockMap().anchor();
    CHECK(p.hostNs > 1'000'000'000ull);
    CHECK(p.blockFrames == 256);
    // the fake host advances its clock exactly with the frames: the map is linear in both
    const double t = impl(rt.e).clockMap().engineTimeAt(p.hostNs + 10'000'000);
    CHECK(t == doctest::Approx(static_cast<double>(p.frame) / 48000.0 + 0.01));
  }

  TEST_CASE("MIDI port table: stable indices, no hash collisions, rig_host_midi_ports interns in order") {
    rig::MidiPortTable t;
    CHECK(t.intern("a") == 0);
    CHECK(t.intern("b") == 1);
    CHECK(t.intern("a") == 0);
    CHECK(t.find("c") == rig::MidiPortTable::kNone);
    CHECK(t.intern("") == rig::MidiPortTable::kNone);
    char buf[16];
    CHECK(t.id(1, buf, sizeof buf));
    CHECK(std::string(buf) == "b");
    // two ids the T00 31-hash mapped to the same uint16 ("Aa" / "BB") now differ
    CHECK(t.intern("Aa") != t.intern("BB"));
    OfflineEngine eng;
    const char *ports = R"([{"id":"1234","name":"Keys","state":"connected","kind":"input"},{"id":"99","name":"P"}])";
    CHECK(rig_host_midi_ports(eng.e, ports, std::strlen(ports)) == RIG_OK);
    CHECK(impl(eng.e).midiPortId(0) == "1234");
    CHECK(impl(eng.e).midiPortId(1) == "99");
    CHECK(rig_host_midi_ports(eng.e, "{", 1) == RIG_E_INVALID);
  }
}
