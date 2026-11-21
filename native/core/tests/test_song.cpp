// T13 song / graph policy beyond the JS suites: retire into the retiring channels (MoveUnit), disposal timing, the
// command gate for commits ahead of the clock, 10 ms coalescing of the Model's rows, 16-slot songs (slots 4..15 =
// slot 0's rules), the 32 retiring channels, eqAudition across a commit (T02 #2 / #4), the voice limit over retiring
// voices (D4 / D1), settings.dynamicRange (T12 O1), wavetables of retiring synths after a rate change (T11 O3), the
// voice-pool prefault (T11 O1) and the CPU cost of the units T13 adds.
#include <atomic>
#include <chrono>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>

#include "inst/voice_alloc.h"
#include "test_model_util.h"
#include "test_synth_util.h"

using rigtest::contains;
using t13::Eng;
using t13::patch;
using t13::slot;

namespace {

/** A test-voice slot (sine) with a given release, all sends 0. */
std::string tv(double gain = 0.8, double release = 0.3) {
  return slot("test", "sine", gain,
              R"("params":{"attack":0.002,"decay":0.3,"sustain":0.8,"release":)" + Eng::num(release) + "}");
}

int retiringIndexOf(Eng &e, std::uint32_t id) {
  for (int j = 0; j < static_cast<int>(rig::kRetiring); ++j)
    if (e.sg().retiring(j).live && e.sg().retiring(j).id == id) return j;
  return -1;
}

}  // namespace

TEST_SUITE("song") {
  TEST_CASE("retire: a pedalled chord moves with its state, is released there, disposed 1 s after its last voice") {
    Eng e;
    REQUIRE(e.use(patch({tv(0.8, 0.05)}), 0));  // test voice: release = tau, the voice ends at 12 tau
    e.pedal(true, 0.05);
    for (int n : {60, 64, 67}) e.on(n, 0.1);
    for (int n : {60, 64, 67}) e.off(n, 0.4);  // held by the pedal
    const std::uint32_t id = e.sg().liveChannel(0)->id;
    REQUIRE(e.use(patch({tv(0.8, 0.051)}), 1.0));  // another release -> a fresh instrument
    const int j = retiringIndexOf(e, id);
    REQUIRE(j >= 0);
    CHECK(e.model().attachedKind(rig::retireInstSlot(static_cast<std::size_t>(j))) == "inst.test");
    CHECK(e.model().attachedKind(rig::retireStripSlot(static_cast<std::size_t>(j))) == "strip");
    e.on(72, 1.5);
    e.off(72, 1.6);
    e.until(2.0);
    CHECK(e.sg().retiring(j).shell->publishedVoices() == 3);  // the pedal holds them on the old instrument
    CHECK(e.meters().slot_retiring[0] == 1);
    e.pedal(false, 2.0);  // pedal up: released on the retired instrument (ends 0.6 s later)
    e.until(2.5);
    CHECK(e.sg().retiringCount() == 1);
    e.until(5.0);
    CHECK(e.sg().retiringCount() == 0);
    CHECK(e.model().attachedKind(rig::retireInstSlot(static_cast<std::size_t>(j))).empty());
    CHECK(e.meters().slot_retiring[0] == 0);
    CHECK(e.sg().counters().disposed == 1);
    // the old chord sounded until the pedal came up, then decayed (it never cut at the commit)
    CHECK(t13::rms(e.L, 1.05, 1.45) > 0.05);
    CHECK(t13::rms(e.L, 4.0, 5.0) == 0.0);
  }

  TEST_CASE("gate: rows set after a commit that lies ahead reach the new channel, not the outgoing one") {
    // offline renders post the whole song up front (rig_render, page.js): the commit at 1 s is called at t = 0
    Eng e;
    REQUIRE(e.use(patch({tv(0.9)}), 0));
    REQUIRE(e.commit(e.prepare(patch({tv(0.9, 0.31)})), 1.0));
    e.set("slots.0.gain", "0.2", 1.5);  // the new channel's fader, at 1.5 s
    e.on(69, 1.1);
    e.until(2.0);
    const double before = t13::rms(e.L, 1.3, 1.45), after = t13::rms(e.L, 1.7, 1.95);
    INFO("before " << t13::db(before) << " dB, after " << t13::db(after) << " dB");
    CHECK(t13::db(before) - t13::db(after) > 10);  // 0.9 -> 0.2 = -13 dB (+ the voice's decay); without the gate the
                                                   // ramp went to the outgoing strip and nothing changed here
  }

  TEST_CASE("coalescing: slots.<i>.gain applies at most once per 10 ms per slot; the latest value wins") {
    auto run = [](bool second, double t2) {
      Eng e;
      REQUIRE(e.use(patch({tv(0.9)}), 0));
      e.on(69, 0.05);
      e.set("slots.0.gain", "0.1", 0.5);
      if (second) e.set("slots.0.gain", "0.6", t2);
      e.until(1.0);
      return e.L;
    };
    const auto coalesced = run(true, 0.502);  // 2 ms later: deferred to 0.510 (fx.js Coalescer), and the timer runs
                                              // on the next quantum boundary (AudioTimer / OfflineAudioContext.suspend)
    const auto explicitly = run(true, std::ceil(0.510 * t13::kSR / 128 - 1e-6) * 128 / t13::kSR);
    const auto single = run(false, 0);
    CHECK(rigtest::maxAbsDiff(coalesced, explicitly) == 0.0);
    CHECK(rigtest::maxAbsDiff(coalesced, single) > 0.01);
  }

  TEST_CASE("16 slots: slots 4..15 follow slot 0's rules (reuse, fresh, retire, empty) exactly") {
    Eng e;
    std::vector<std::string> a(16, tv()), b(16, tv());
    b[9] = tv(0.8, 0.31);  // slot 9: another instrument config -> fresh; slot 12 dropped -> retires
    b[12] = "null";
    REQUIRE(e.use(patch(a), 0));
    std::uint32_t ids[16];
    for (int i = 0; i < 16; ++i) ids[i] = e.sg().liveChannel(i)->id;
    for (int n : {60, 62}) e.on(n, 0.05);
    e.until(0.3);
    REQUIRE(e.use(patch(b)));
    for (int i = 0; i < 16; ++i) {
      INFO("slot " << i);
      if (i == 12) {
        CHECK(e.sg().liveChannel(i) == nullptr);
        CHECK(rig::isRetireInstSlot(e.sg().instUnitOf(ids[i])));
      } else if (i == 9) {
        CHECK(e.sg().liveChannel(i)->id != ids[i]);
        CHECK(rig::isRetireInstSlot(e.sg().instUnitOf(ids[i])));
      } else {
        CHECK(e.sg().liveChannel(i)->id == ids[i]);  // reused, like slot 0
      }
    }
    CHECK(e.sg().retiringCount() == 2);
    e.until(0.6);
    const rig_meters m = e.meters();
    CHECK(m.slot_retiring[9] == 1);
    CHECK(m.slot_retiring[12] == 1);
    CHECK(m.slot_retiring[0] == 0);
    CHECK(contains(e.set("slots.12.gain", "0.5"), "\"applied\":false"));  // empty slot (JS: no cfg)
    CHECK(contains(e.set("slots.15.gain", "0.5"), "\"applied\":true"));
  }

  TEST_CASE("32 retiring channels: a third back-to-back 16-slot switch takes the channels retired first") {
    Eng e;
    for (int k = 0; k < 4; ++k) {
      std::vector<std::string> s(16, tv(0.8, 0.3 + 0.01 * k));  // a new release each time: every slot fresh
      REQUIRE(e.use(patch(s)));
      for (int n = 60; n < 64; ++n) e.on(n, -1);  // held: nothing ever retires by itself here
      e.until(e.L.size() / t13::kSR + 0.05);
    }
    CHECK(e.sg().retiringCount() == 32);
    CHECK(e.sg().counters().forcedRetire == 16);
    CHECK(e.sg().counters().retired == 48);
  }

  TEST_CASE("eqAudition: true for any slot 0..15 (empty too, T02 #4); a commit ends it on a reused strip (T02 #2)") {
    const std::string eqA = R"("eq":{"b4":{"on":true,"type":"peak","hz":1000,"db":9,"q":1}})";
    const std::string eqB = R"("eq":{"b4":{"on":true,"type":"peak","hz":1000,"db":-9,"q":1}})";
    auto run = [&](bool audition) {
      Eng e;
      REQUIRE(e.use(patch({slot("test", "saw", 0.8, eqA)}), 0));
      e.on(57, 0.05);
      if (audition)
        CHECK(contains(e.call(R"({"v":1,"op":"config","id":30,"eqAudition":{"slot":0,"mode":"bypass"},"when":0.3})"),
                       "\"eqAudition\":true"));
      REQUIRE(e.commit(e.prepare(patch({slot("test", "saw", 0.8, eqB)})), 0.6));  // same instrument: reused strip
      CHECK(!e.sg().auditioned(0));
      e.until(2.0);
      return e.L;
    };
    Eng z;
    CHECK(contains(z.call(R"({"v":1,"op":"config","id":31,"eqAudition":{"slot":3,"mode":"bypass"}})"),
                   "\"eqAudition\":true"));
    CHECK(contains(z.call(R"({"v":1,"op":"config","id":32,"eqAudition":{"slot":15,"mode":"on"}})"),
                   "\"eqAudition\":true"));
    const auto plain = run(false), aud = run(true);
    // after the commit both play the NEW song's EQ (-9 dB): the audition did not survive it
    double m = 0;
    for (std::size_t i = static_cast<std::size_t>(1.5 * t13::kSR); i < plain.size(); ++i)
      m = std::max(m, std::fabs(static_cast<double>(plain[i]) - aud[i]));
    INFO("max diff after the commit settled " << m << ", level " << t13::rms(plain, 1.5, 2.0));
    CHECK(m < 1e-4 * std::max(1.0, t13::rms(plain, 1.5, 2.0) * 10));
    const double ra = t13::rms(aud, 0.35, 0.55), rp = t13::rms(plain, 0.35, 0.55);
    CHECK(std::fabs(ra - rp) > 0.1 * rp);  // the audition was heard before the commit
  }

  TEST_CASE("D4 + D1 across commit / retire: retiring voices count toward the engine voice limit") {
    Eng e;
    e.call(R"({"v":1,"op":"config","id":40,"polyphony":128,"voiceLimit":128})");
    const std::string bell = slot("synth", "bell", 0.5, R"("params":{"decay":12})");  // D4 counts T11's voices
    REQUIRE(e.use(patch({bell})));
    std::string batch = "[";
    for (int n = 0; n < 100; ++n)
      batch += (n ? "," : "") + std::string(R"({"v":1,"op":"play","e":"on","vel":90,"n":)") + std::to_string(n) + "}";
    e.call(batch + "]");
    e.until(0.1);
    CHECK(e.meters().voices == 100);
    REQUIRE(e.use(patch({slot("synth", "bell", 0.5, R"("params":{"decay":11})")})));  // fresh: the 100 voices retire
    e.until(0.2);
    CHECK(e.meters().voices == 100);
    e.call(batch + "]");  // 100 more on the new instrument: the oldest (retiring) voices give way
    e.until(0.4);
    const rig_meters m = e.meters();
    CHECK(m.voices <= 128 + rig::inst::kMaxLimitStealsPerNote);  // fading steal victims are counted until gone
    e.until(1.0);
    CHECK(e.meters().voices <= 128);
    int j = -1;
    for (int k = 0; k < static_cast<int>(rig::kRetiring); ++k)
      if (e.sg().retiring(k).live) j = k;
    REQUIRE(j >= 0);
    CHECK(e.sg().retiring(j).shell->publishedVoices() <= 28);  // 100 + 100 under 128: the old ones were stolen
  }

  TEST_CASE("settings.dynamicRange (T12 O1): validated like validDynRange, reported, sent to samplers") {
    Eng e;
    CHECK(e.model().dynamicRange() == 1.0);
    CHECK(e.model().setDynamicRange(2.345) == doctest::Approx(2.35));
    CHECK(e.model().setDynamicRange(0.2) == 1.0);
    CHECK(e.model().setDynamicRange(9) == 3.0);
    CHECK(e.model().setDynamicRange(std::nan("")) == 1.0);
    CHECK(e.model().setDynamicRange(2) == 2.0);
    CHECK(contains(e.call(R"({"v":1,"op":"get","what":"state","id":9})"), "\"dynamicRange\":2"));
  }

  TEST_CASE("rate change (T11 O3): a retiring synth.js instrument gets the new rate's wavetables") {
    Eng e(true, 48000);
    const std::string s = slot("synth", "bell", 1, R"("params":{"index":0,"decay":12})");
    REQUIRE(e.use(patch({s})));
    e.on(69, 0.01);
    e.until(0.05);
    REQUIRE(e.use(patch({slot("synth", "sub-bass")})));  // the bell retires, still ringing (A4)
    rig_device_info info{};
    info.struct_size = sizeof info;
    info.sample_rate = 96000;
    info.channels = 2;
    rig_host_audio_started(e.e, &info);
    std::vector<float> out;
    for (int k = 0; k < 40; ++k) {
      auto o = e.render(1280, 128);
      out.insert(out.end(), o[0].begin(), o[0].end());
    }
    // with the old 48 kHz tables the retiring bell would ring an octave up (880 Hz) at 96 kHz
    CHECK(t11::zeroCrossHz(out, 20000, 50000, 96000) == doctest::Approx(440).epsilon(5e-3));
  }

  TEST_CASE("rate change between prepare and commit (T13 review): the plan's prebuilt units follow the new rate") {
    // units are built at prepare since T13; a device rate change before the commit must not leave the incoming
    // song on the old rate's wavetables (the InstrumentService re-points only the attached Inst0..15)
    Eng e(true, 48000);
    e.render(1280, 128);
    const long tok = e.prepare(patch({slot("synth", "bell", 1, R"("params":{"index":0,"decay":12})")}));
    REQUIRE(tok > 0);
    rig_device_info info{};
    info.struct_size = sizeof info;
    info.sample_rate = 96000;
    info.channels = 2;
    rig_host_audio_started(e.e, &info);
    e.render(1280, 128);  // the rate is adopted, RateChanged reaches the Model
    REQUIRE(e.commit(tok));
    e.on(69, 0);
    std::vector<float> out;
    for (int k = 0; k < 40; ++k) {
      auto o = e.render(1280, 128);
      out.insert(out.end(), o[0].begin(), o[0].end());
    }
    CHECK(t11::zeroCrossHz(out, 20000, 50000, 96000) == doctest::Approx(440).epsilon(5e-3));
  }

  TEST_CASE("prefault (T11 O1): fresh instruments do not page-fault on the audio thread (cost printed)") {
    using clk = std::chrono::steady_clock;
    // the fault cost a note-on paid before (first touch of a fresh 19.2 MB pool's slots), moved to prepare now
    constexpr std::size_t kStride = 119888, kSlots = 16;
    volatile unsigned sink = 0;
    auto touch = [&](unsigned char *p) {
      const auto t0 = clk::now();
      for (std::size_t s = 0; s < kSlots; ++s) std::memset(p + s * kStride, static_cast<int>(s + 1), kStride);
      const double us = std::chrono::duration<double, std::micro>(clk::now() - t0).count();
      for (std::size_t i = 0; i < kSlots * kStride; i += 4096) sink = sink + p[i];  // the stores are observable
      return us;
    };
    auto *fresh = static_cast<unsigned char *>(::operator new(kStride * 160));
    const double cold = touch(fresh), warm = touch(fresh);
    ::operator delete(fresh);
    MESSAGE("16 synth voice slots: first touch " << cold << " us (was paid on the audio thread at note-on), "
                                                 << "after the prefault " << warm << " us");
    // the engine path: a 16-note chord on a fresh warm-pad right after its commit, quantum cost
    Eng e;
    REQUIRE(e.use(patch({slot("synth", "warm-pad")})));
    e.until(0.01);
    for (int n = 48; n < 64; ++n) e.on(n, -1);
    const auto t0 = clk::now();
    e.until(e.L.size() / t13::kSR + 128 / t13::kSR);
    const double chord = std::chrono::duration<double, std::micro>(clk::now() - t0).count();
    MESSAGE("16-note chord quantum on a fresh warm-pad: " << chord << " us (T11 review O1 measured ~900 us before)");
    CHECK(sink > 0);  // no timing assertion on a shared box: the numbers are the measurement
  }

  TEST_CASE("CPU per 128-frame quantum: 16 slot channels + 16 retiring ones through InstShell (printed)") {
    Eng e;
    std::vector<std::string> a(16, tv(0.5, 5.0)), b(16, tv(0.5, 5.1));
    REQUIRE(e.use(patch(a)));
    for (int n = 60; n < 64; ++n) e.on(n, -1);
    REQUIRE(e.use(patch(b)));
    for (int n = 60; n < 64; ++n) e.on(n, -1);
    e.until(0.1);
    using clk = std::chrono::steady_clock;
    const auto t0 = clk::now();
    e.until(e.L.size() / t13::kSR + 1.0);
    const double us = std::chrono::duration<double, std::micro>(clk::now() - t0).count() / (t13::kSR / 128.0);
    MESSAGE("32 channels (16 slots + 16 retiring, 4 test voices each): " << us << " us per quantum");
    CHECK(e.sg().retiringCount() == 16);
  }

  TEST_CASE("realtime: switches with held notes while a host thread renders; the retire poll reads voices (TSan)") {
    struct Rt {
      rig_engine *e = nullptr;
      std::mutex mu;
      std::string all;
      Rt() {
        rig_config cfg;
        rig_config_init(&cfg);
        cfg.mode = RIG_MODE_REALTIME;
        cfg.sample_rate = 48000;
        cfg.on_event = [](void *u, const char *j, size_t n) {
          auto *r = static_cast<Rt *>(u);
          std::lock_guard<std::mutex> lk(r->mu);
          r->all.append(j, n);
        };
        cfg.event_user = this;
        e = rig_create(&cfg, nullptr);
      }
      ~Rt() { rig_destroy(e); }
      void post(const std::string &m) { REQUIRE(rig_post(e, m.data(), m.size()) == RIG_OK); }
      bool waitFor(const std::string &needle, int ms = 5000) {
        for (int i = 0; i < ms; ++i) {
          {
            std::lock_guard<std::mutex> lk(mu);
            if (all.find(needle) != std::string::npos) return true;
          }
          std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        return false;
      }
    } rt;
    REQUIRE(rt.e != nullptr);
    rt.post(R"({"v":1,"op":"hello","protocol":1,"id":1})");
    rt.post(R"({"v":1,"op":"audio","action":"start","id":2})");
    REQUIRE(rt.waitFor("\"re\":2"));
    std::atomic<bool> stop{false};
    std::thread host([&] {
      std::vector<float> l(256), r(256);
      float *p[2] = {l.data(), r.data()};
      while (!stop.load()) {
        rig_render(rt.e, p, 2, 256, 0);
        std::this_thread::sleep_for(std::chrono::microseconds(1500));
      }
    });
    for (int k = 0; k < 6; ++k) {  // every switch a fresh instrument (another release), notes held across it
      const std::string id = std::to_string(10 + 2 * k);
      rt.post(R"({"v":1,"op":"prepare","id":)" + id + R"(,"patch":)" + patch({tv(0.3, 0.02 + 0.001 * k)}) + "}");
      REQUIRE(rt.waitFor("\"token\":" + std::to_string(k + 1)));
      rt.post(R"({"v":1,"op":"commit","id":)" + std::to_string(11 + 2 * k) + R"(,"token":)" +
              std::to_string(k + 1) + "}");
      rt.post(R"({"v":1,"op":"play","e":"on","n":)" + std::to_string(60 + k) + R"(,"vel":90})");
      std::this_thread::sleep_for(std::chrono::milliseconds(60));
      rt.post(R"({"v":1,"op":"play","e":"off","n":)" + std::to_string(60 + k) + "}");
    }
    // every retired channel ends: release 12 tau ~ 0.3 s, then 1 s of silence, polled every 0.25 s
    bool drained = false;
    for (int i = 0; i < 100 && !drained; ++i) {
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      rt.post(R"({"v":1,"op":"get","what":"stats","id":99})");
      std::lock_guard<std::mutex> lk(rt.mu);
      drained = rt.all.rfind("\"channelsDisposed\":5") != std::string::npos;  // 6 songs: 5 retired, all ended
    }
    stop = true;
    host.join();
    CHECK(drained);
  }
}
