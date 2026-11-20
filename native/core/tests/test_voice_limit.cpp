// DECISIONS D4: the engine-wide voice limit (total voices counted by every instrument, slots and retiring channels).
// Cross-slot stealing order on a bare Graph with synth.js instruments (released before held, oldest first, retiring
// channels included, a 20 ms fade and not a hard cut, the per-slot cap first), a limit change applying live (bounded
// steals per note-on), Off, Auto per profile through the bridge (config reply, get state, validation), the limit set
// from another thread while the audio thread steals (TSan), and 16 slots x 128 voices per slot held under a 512 limit
// with no allocation on the audio thread.
#include <atomic>
#include <chrono>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "api/engine.h"
#include "graph/graph.h"
#include "helpers.h"
#include "inst/synth.h"
#include "inst/voice_alloc.h"
#include "num/prng.h"
#include "runtime/rt_guard.h"
#include "test_synth_util.h"

using rig::inst::SynthInstrument;
using rigtest::contains;
using rigtest::OfflineEngine;

namespace {

constexpr double kSR = 48000;

/** A bare Graph (no strips: the instruments render, nothing reaches the output) driven quantum by quantum. */
struct GraphRig {
  std::unique_ptr<rig::CommandQueue> cq = std::make_unique<rig::CommandQueue>();
  std::unique_ptr<rig::EventQueue> eq = std::make_unique<rig::EventQueue>();
  std::unique_ptr<rig::Seqlock<rig_meters>> meters = std::make_unique<rig::Seqlock<rig_meters>>();
  std::unique_ptr<rig::Graph> g = std::make_unique<rig::Graph>(kSR, *cq, *eq, *meters);
  std::uint32_t seq = 0;
  long rtAllocs = 0;

  ~GraphRig() {
    rig::AudioEvent e;
    while (g->popGarbage(e)) rig::freeGarbage(e);
  }
  void send(rig::Command c) {
    c.seq = ++seq;
    REQUIRE(cq->push(c));
  }
  SynthInstrument *attach(rig::UnitSlot s, const char *id = "warm-pad") {
    SynthInstrument *u = t11::makeSynth(id, kSR);
    rig::Command c{};
    c.op = rig::Op::AttachUnit;
    c.target = static_cast<std::uint32_t>(s);
    c.frame = rig::kFrameNow;
    c.p.ptr = static_cast<rig::Unit *>(u);
    send(c);
    return u;
  }
  void note(rig::Op op, rig::UnitSlot s, int n, double t) {
    rig::Command c{};
    c.op = op;
    c.target = static_cast<std::uint32_t>(s);
    c.frame = std::llround(t * kSR);
    c.aux = static_cast<std::uint32_t>(n) | (100u << 8);
    send(c);
  }
  void on(rig::UnitSlot s, int n, double t) { note(rig::Op::NoteOn, s, n, t); }
  void off(rig::UnitSlot s, int n, double t) { note(rig::Op::NoteOff, s, n, t); }
  /** Render until engine time `t` (whole quanta). */
  void runTo(double t) {
    float l[rig::kQ], r[rig::kQ];
    float *out[2] = {l, r};
    while (static_cast<double>(g->frame()) < t * kSR) {
      const long before = rigtest::g_rtAllocs;
      g->renderQuantum(out, 2);
      rtAllocs += rigtest::g_rtAllocs - before;
      rig::AudioEvent e;
      while (eq->pop(e)) {
      }
    }
  }
  std::uint32_t limitSteals() const { return g->stats().limitSteals.load(); }
};

rig::Engine &eng(OfflineEngine &e) {
  return *reinterpret_cast<rig::Engine *>(e.e);
}

/** hello + audio start + an `n`-slot song of one synth patch (no release param changes). */
void songN(OfflineEngine &e, int n, const std::string &id) {
  e.hello();
  e.call(R"({"v":1,"op":"audio","action":"start","id":2})");
  std::string p = R"({"slots":[)";
  for (int i = 0; i < n; ++i)
    p += (i ? "," : "") + std::string(R"({"instrument":{"type":"synth","id":")") + id + R"("},"gain":0.2})";
  p += "]}";
  const std::string r = e.call(R"({"v":1,"op":"prepare","id":3,"patch":)" + p + "}");
  REQUIRE(contains(r, "\"token\":"));
  const std::size_t at = r.find("\"token\":") + 8;
  const std::string token = r.substr(at, r.find_first_of(",}", at) - at);
  REQUIRE(contains(e.call(R"({"v":1,"op":"commit","id":4,"token":)" + token + "}"), "\"committed\":true"));
}

std::string playBatch(int from, int to) {
  std::string b = "[";
  for (int n = from; n < to; ++n)
    b += (n > from ? "," : "") + std::string(R"({"v":1,"op":"play","e":"on","vel":100,"n":)") + std::to_string(n) +
         "}";
  return b + "]";
}

rig_meters meters(OfflineEngine &e) {
  rig_meters m{};
  m.struct_size = sizeof m;
  REQUIRE(rig_get_meters(e.e, &m) == RIG_OK);
  return m;
}

/** An offline engine with a chosen resource profile. */
struct ProfileEngine {
  rig_engine *e = nullptr;
  std::vector<std::string> msgs;
  explicit ProfileEngine(rig_profile profile) {
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.mode = RIG_MODE_OFFLINE;
    cfg.flags = RIG_FLAG_TEST_API;
    cfg.sample_rate = kSR;
    cfg.seed = 1;
    cfg.profile = profile;
    cfg.on_event = [](void *u, const char *j, size_t n) { static_cast<ProfileEngine *>(u)->msgs.emplace_back(j, n); };
    cfg.event_user = this;
    e = rig_create(&cfg, nullptr);
    REQUIRE(e != nullptr);
  }
  ~ProfileEngine() { rig_destroy(e); }
  std::string call(const std::string &m) {
    msgs.clear();
    rig_post(e, m.data(), m.size());
    std::string all;
    for (auto &s : msgs) all += s;
    return all;
  }
  rig::Engine &engine() { return *reinterpret_cast<rig::Engine *>(e); }
};

}  // namespace

TEST_SUITE("voice-limit") {
  TEST_CASE("VoicePool: the running playing() count equals a recount; the D4 candidates match makeRoom's victims") {
    struct V {
      int n;
      explicit V(int x) : n(x) {}
    };
    rig::inst::VoicePool<V> p;
    p.setCap(24);
    rig::Rng rng(rig::rngFor(7, "d4-pool"));
    auto recount = [&] {
      unsigned n = 0;
      for (unsigned i = 0; i < p.capacity(); ++i) {
        const auto st = p.meta(static_cast<int>(i)).state;
        n += st == rig::inst::VoiceState::Held || st == rig::inst::VoiceState::Released ? 1u : 0u;
      }
      return n;
    };
    double t = 0;
    for (int step = 0; step < 4000; ++step) {
      t += 0.001;
      const double x = rng.next();
      if (x < 0.45) {
        // the victim makeRoom takes is the D4 candidate: released (by `when`) first, else the oldest playing
        int expect = p.oldestReleased(t);
        if (expect < 0) expect = p.oldestPlaying();
        int got = -1;
        p.makeRoom(t, [&](int s) {
          if (got < 0) got = s;
        });
        if (got >= 0) CHECK(got == expect);
        p.emplace(static_cast<int>(x * 1000) % 128, t, step);
      } else if (x < 0.75) {
        int s = static_cast<int>(rng.next() * p.capacity());
        p.markReleased(s, t + (rng.next() < 0.3 ? 0.01 : 0.0));  // some releases scheduled ahead (voice.js `when`)
      } else if (x < 0.9) {
        p.markKilled(static_cast<int>(rng.next() * p.capacity()), t);
      } else {
        p.destroy(static_cast<int>(rng.next() * p.capacity()));
      }
      REQUIRE(p.playing() == recount());
    }
    p.destroyAll();
    CHECK(p.playing() == 0);
  }

  TEST_CASE("cross-slot order: released before held, earliest first, retiring channels count, 20 ms fade") {
    GraphRig r;
    using rig::UnitSlot;
    SynthInstrument *a = r.attach(UnitSlot::Inst0), *b = r.attach(rig::instSlot(1)), *c = r.attach(rig::instSlot(2));
    SynthInstrument *ret = r.attach(rig::retireInstSlot(0));
    r.g->setVoiceLimit(5);
    r.runTo(0.003);
    r.on(rig::retireInstSlot(0), 50, 0.005);  // the oldest held voice is on a retiring channel
    r.on(UnitSlot::Inst0, 60, 0.010);
    r.on(rig::instSlot(1), 61, 0.015);
    r.on(rig::instSlot(2), 62, 0.020);
    r.on(UnitSlot::Inst0, 63, 0.025);
    r.off(rig::instSlot(2), 62, 0.030);  // released first ...
    r.off(rig::instSlot(1), 61, 0.035);  // ... then this one: warm-pad releases ring for seconds (still counted)
    r.runTo(0.04);
    CHECK(a->playingVoices() + b->playingVoices() + c->playingVoices() + ret->playingVoices() == 5);
    CHECK(r.limitSteals() == 0);

    r.on(UnitSlot::Inst0, 64, 0.045);  // 6 > 5: the earliest-released voice, slot 2's 62 (not slot 1's, not held)
    r.runTo(0.05);
    CHECK(r.limitSteals() == 1);
    CHECK(c->playingNote(62) == 0);
    CHECK(b->playingNote(61) == 1);
    CHECK(c->liveVoices() == 1);  // fading, not cut: the voice still renders its 20 ms steal fade
    r.on(rig::instSlot(2), 65, 0.055);  // next: the other released voice (slot 1's 61)
    r.runTo(0.06);
    CHECK(r.limitSteals() == 2);
    CHECK(b->playingNote(61) == 0);
    r.on(rig::instSlot(1), 66, 0.065);  // nothing released: the oldest held voice, on the retiring channel
    r.runTo(0.07);
    CHECK(r.limitSteals() == 3);
    CHECK(ret->playingNote(50) == 0);
    CHECK(ret->liveVoices() == 1);  // still fading
    CHECK(a->playingNote(60) == 1);
    r.on(rig::instSlot(2), 67, 0.075);  // then the oldest held voice in a slot: slot 0's 60
    r.runTo(0.08);
    CHECK(a->playingNote(60) == 0);
    CHECK(r.limitSteals() == 4);
    CHECK(a->playingVoices() + b->playingVoices() + c->playingVoices() + ret->playingVoices() == 5);
    r.runTo(0.2);  // the 20 ms fades are over: the stolen voices are gone
    CHECK(ret->liveVoices() == 0);
    CHECK(a->liveVoices() == 2);  // 63 and 64; 60 has faded out
    CHECK(a->steals() + b->steals() + c->steals() + ret->steals() == 0);  // no per-slot steal was involved
    CHECK(r.rtAllocs == 0);
  }

  TEST_CASE("the per-slot cap comes first: a note-on over its slot's cap steals there, the total stays") {
    GraphRig r;
    SynthInstrument *a = r.attach(rig::UnitSlot::Inst0, "bell"), *b = r.attach(rig::instSlot(1), "bell");
    rig::Command cap{};
    cap.op = rig::Op::VoiceCap;
    cap.target = static_cast<std::uint32_t>(rig::UnitSlot::Inst0);
    cap.frame = rig::kFrameNow;
    cap.aux = 32;
    r.send(cap);
    r.g->setVoiceLimit(40);
    r.runTo(0.003);
    for (int i = 0; i < 8; ++i) r.on(rig::instSlot(1), 70 + i, 0.004);  // slot 1 holds the 8 oldest voices
    for (int i = 0; i < 32; ++i) r.on(rig::UnitSlot::Inst0, 30 + i, 0.006);
    r.runTo(0.01);
    CHECK(a->playingVoices() + b->playingVoices() == 40);
    r.on(rig::UnitSlot::Inst0, 90, 0.012);  // slot 0 at its cap 32: its own steal; the total is not over
    r.runTo(0.015);
    CHECK(a->steals() == 1);
    CHECK(r.limitSteals() == 0);
    CHECK(b->playingVoices() == 8);  // the globally older voices of slot 1 were left alone
    r.on(rig::instSlot(1), 91, 0.016);  // slot 1 under its cap: the limit steals the oldest (slot 1's own 70)
    r.runTo(0.02);
    CHECK(r.limitSteals() == 1);
    CHECK(b->playingNote(70) == 0);
    CHECK(a->playingVoices() + b->playingVoices() == 40);
  }

  TEST_CASE("a limit change applies live from the next note-on; at most 4 steals per note-on; Off = no limit") {
    GraphRig r;
    SynthInstrument *a = r.attach(rig::UnitSlot::Inst0, "sub-bass"), *b = r.attach(rig::instSlot(1), "sub-bass");
    r.runTo(0.003);
    for (int i = 0; i < 20; ++i) r.on(rig::instSlot(i % 2), 30 + i, 0.004 + i * 0.001);
    r.runTo(0.03);
    CHECK(a->playingVoices() + b->playingVoices() == 20);  // off (the bare Graph's default)
    r.g->setVoiceLimit(10);  // lowered while 20 sound: nothing is cut until a note-on
    r.runTo(0.04);
    CHECK(a->playingVoices() + b->playingVoices() == 20);
    CHECK(r.limitSteals() == 0);
    r.on(rig::UnitSlot::Inst0, 80, 0.045);  // 21 > 10: four steals, the oldest four
    r.runTo(0.05);
    CHECK(r.limitSteals() == rig::inst::kMaxLimitStealsPerNote);
    CHECK(a->playingVoices() + b->playingVoices() == 21 - rig::inst::kMaxLimitStealsPerNote);
    CHECK(a->playingNote(30) == 0);
    CHECK(b->playingNote(31) == 0);
    CHECK(a->playingNote(32) == 0);
    CHECK(b->playingNote(33) == 0);
    CHECK(a->playingNote(34) == 1);
    for (int i = 0; i < 3; ++i) r.on(rig::instSlot(1), 81 + i, 0.055);  // converges: 17+1-4, 14+1-4, 11+1-2
    r.runTo(0.06);
    CHECK(a->playingVoices() + b->playingVoices() == 10);
    r.g->setVoiceLimit(12);  // raised live: the next two note-ons steal nothing
    r.runTo(0.065);
    const std::uint32_t steals = r.limitSteals();
    r.on(rig::UnitSlot::Inst0, 90, 0.07);
    r.on(rig::UnitSlot::Inst0, 91, 0.07);
    r.runTo(0.075);
    CHECK(r.limitSteals() == steals);
    CHECK(a->playingVoices() + b->playingVoices() == 12);
    r.g->setVoiceLimit(0);  // Off
    r.runTo(0.08);
    for (int i = 0; i < 30; ++i) r.on(rig::instSlot(i % 2), 40 + i, 0.085);
    r.runTo(0.09);
    CHECK(r.limitSteals() == steals);
    CHECK(a->playingVoices() + b->playingVoices() == 42);
    CHECK(r.rtAllocs == 0);
  }

  TEST_CASE("bridge: Auto per profile (desktop 128, iPad 64), manual 128/256/512, Off; echoed and validated") {
    CHECK(rig::inst::autoVoiceLimit(false) == rig::inst::kAutoVoiceLimitDesktop);
    CHECK(rig::inst::autoVoiceLimit(true) == rig::inst::kAutoVoiceLimitIpad);
    CHECK(rig::inst::kAutoVoiceLimitDesktop == 128u);
    CHECK(rig::inst::kAutoVoiceLimitIpad == 64u);
    for (const rig_profile prof : {RIG_PROFILE_DESKTOP, RIG_PROFILE_IPAD}) {
      const bool ipad = prof == RIG_PROFILE_IPAD;
      const std::string autoN = ipad ? "64" : "128";
      ProfileEngine e(prof);
      CHECK(contains(e.call(R"({"v":1,"op":"hello","protocol":1,"id":1})"), "\"voiceLimit\""));  // capability
      // the default is Auto from creation: the graph already enforces the profile's number
      CHECK(e.engine().graph().voiceLimitRequested() == (ipad ? 64u : 128u));
      std::string st = e.call(R"({"v":1,"op":"get","what":"state","id":2})");
      CHECK(contains(st, "\"voiceLimit\":\"auto\""));
      CHECK(contains(st, ("\"voiceLimitEffective\":" + autoN).c_str()));
      for (const char *v : {"128", "256", "512"}) {
        const std::string r = e.call(std::string(R"({"v":1,"op":"config","id":3,"voiceLimit":)") + v + "}");
        CHECK(contains(r, (std::string("\"voiceLimit\":") + v + ",\"voiceLimitEffective\":" + v).c_str()));
        CHECK(e.engine().graph().voiceLimitRequested() == std::stoul(v));
      }
      CHECK(contains(e.call(R"({"v":1,"op":"config","id":4,"voiceLimit":0})"),
                     "\"voiceLimit\":0,\"voiceLimitEffective\":0"));
      CHECK(e.engine().graph().voiceLimitRequested() == 0u);
      st = e.call(R"({"v":1,"op":"get","what":"state","id":5})");
      CHECK(contains(st, "\"voiceLimit\":0,\"voiceLimitEffective\":0"));
      CHECK(contains(e.call(R"({"v":1,"op":"config","id":6,"voiceLimit":"auto"})"),
                     ("\"voiceLimit\":\"auto\",\"voiceLimitEffective\":" + autoN).c_str()));
      CHECK(contains(e.call(R"({"v":1,"op":"get","what":"stats","id":7})"), "\"voiceLimitSteals\":0"));
      for (const char *bad : {"300", "64", "\"128\"", "\"off\"", "-1", "128.5", "true", "1e300", "-1e300"}) {
        const std::string r = e.call(std::string(R"({"v":1,"op":"config","id":8,"voiceLimit":)") + bad + "}");
        INFO(bad << " -> " << r);
        CHECK(contains(r, "bad-request"));
      }
      CHECK(e.engine().model().voiceLimit() == rig::Model::kVoiceLimitAuto);  // a refused value changes nothing
      CHECK(e.engine().graph().voiceLimitRequested() == (ipad ? 64u : 128u));
    }
  }

  TEST_CASE("16 slots x 128 voices per slot under a 512 limit: 2048 note-ons keep 512; no allocation") {
    OfflineEngine e;
    songN(e, 16, "warm-pad");
    REQUIRE(contains(e.call(R"({"v":1,"op":"config","id":5,"polyphony":128,"voiceLimit":512})"), "\"ok\":true"));
    e.render(1280);
    const long before = rigtest::g_rtAllocs;
    e.post(playBatch(0, 128));  // every note in all 16 slots, one quantum: 16 x 128 = 2048 voices asked for
    e.render(128 * 2);
    rig::Engine &en = eng(e);
    CHECK(en.graph().stats().limitSteals.load() == 2048u - 512u);
    e.render(4800);  // 100 ms: the steal fades are over
    CHECK(rigtest::g_rtAllocs - before == 0);
    const rig_meters m = meters(e);
    CHECK(m.voices == 512u);  // no slot reached its own cap of 128 first: the per-slot steals stay at 0
    CHECK(contains(e.call(R"({"v":1,"op":"get","what":"stats","id":9})"), "\"voiceLimitSteals\":1536"));
  }

  TEST_CASE("threads: the limit set from the control thread while the audio thread renders and steals (TSan)") {
    GraphRig r;
    r.attach(rig::UnitSlot::Inst0, "sub-bass");
    r.attach(rig::instSlot(1), "sub-bass");
    std::atomic<bool> stop{false};
    std::thread audio([&] {
      float l[rig::kQ], rr[rig::kQ];
      float *out[2] = {l, rr};
      while (!stop.load(std::memory_order_acquire)) {
        r.g->renderQuantum(out, 2);
        rig::AudioEvent e;
        while (r.eq->pop(e)) {
        }
      }
    });
    for (int i = 0; i < 400; ++i) {  // producer side of the SPSC command ring + the lock-free limit
      r.g->setVoiceLimit(static_cast<std::uint32_t>(4 + i % 8));
      rig::Command c{};
      c.op = rig::Op::NoteOn;
      c.target = static_cast<std::uint32_t>(rig::instSlot(static_cast<std::size_t>(i % 2)));
      c.frame = rig::kFrameNow;
      c.aux = static_cast<std::uint32_t>(30 + i % 60) | (100u << 8);
      c.seq = ++r.seq;
      while (!r.cq->push(c)) std::this_thread::yield();
      if (i % 16 == 0) std::this_thread::sleep_for(std::chrono::microseconds(200));
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    stop.store(true, std::memory_order_release);
    audio.join();
    CHECK(r.limitSteals() > 0);
    CHECK(r.g->voiceLimitRequested() == 4u + 399u % 8u);
  }

  TEST_CASE("16 slots x 128 voices per slot with the limit Off: every voice sounds (2048)") {
    OfflineEngine e;
    songN(e, 16, "warm-pad");
    REQUIRE(contains(e.call(R"({"v":1,"op":"config","id":5,"polyphony":128,"voiceLimit":0})"), "\"ok\":true"));
    e.render(1280);
    e.post(playBatch(0, 128));
    e.render(128 * 4);
    CHECK(meters(e).voices == 2048u);
    CHECK(eng(e).graph().stats().limitSteals.load() == 0u);
  }
}
