// T16 drone: the JS drone suites of test/phase1/engine/suites.mjs ported to the native engine (droneKeyChange,
// droneChordFollow, droneSongChangeAndFiles, droneInstrumentReuse, droneParkGain0, droneOffNoVoices), plus the
// low-resource hook (O-W3-2) and config {droneFreeze} (D5). Files mode: tests/test_drone_files.cpp; the frozen loop:
// tests/test_drone_freeze.cpp; vectors: tests/test_drone_vectors.cpp.
#include <cmath>
#include <string>
#include <vector>

#include "drone/drone_service.h"
#include "drone/drone_unit.h"
#include "drone/drone_voicing.h"
#include "helpers.h"
#include "test_click_detector.h"
#include "test_drone_util.h"
#include "test_model_util.h"

using namespace t16;

TEST_SUITE("drone") {
  TEST_CASE("droneKeyChange: a key change crossfades without gaps or clicks; the same key is a no-op") {
    t13::Eng e;
    const long alloc0 = rigtest::g_rtAllocs;
    droneConfig(e, R"({"mode":"synth","gain":1})", 0);
    droneKey(e, 0, false, 0);
    const std::string noop = droneKey(e, 0, false, 1);  // same key -> no-op
    droneKey(e, 7, false, 3, 3);
    e.until(7.5);
    const std::vector<float> d = mono(e);
    const double w = t13::minWindowDb(d, 2.2, 7.4);
    // The real drone-osc (4 detuned band-limited saws) trips suites.mjs' click detector on its own now and then (the
    // JS suite runs the fallback synth: instrumentModules false); a gain step would show at the crossfade's ends.
    const auto cl = rigtest::clicks(d, t13::kSR, 2.5, 7.0);
    for (const auto &c : cl) CHECK((std::fabs(c.t - 3.0) > 0.02 && std::fabs(c.t - 6.0) > 0.02));
    auto maxStep = [&](double a, double b) {  // largest level change between neighbouring 50 ms windows
      double m = 0;
      for (double t = a; t + 0.1 <= b; t += 0.025)
        m = std::max(m, std::fabs(t13::db(t13::rms(d, t + 0.05, t + 0.1)) - t13::db(t13::rms(d, t, t + 0.05))));
      return m;
    };
    const double step = maxStep(2.9, 6.2), steady = maxStep(6.5, 7.4);
    MESSAGE("level step in the crossfade " << step << " dB, steady " << steady << " dB");
    const double c3a = bandMag(d, 1.5, 2.9, 130.81), d3a = bandMag(d, 1.5, 2.9, 146.83);
    const double c3b = bandMag(d, 6.5, 7.4, 130.81), g2b = bandMag(d, 6.5, 7.4, 98);
    auto *s = service(e);
    REQUIRE(s);
    CHECK(rigtest::contains(noop, "\"changed\":false"));
    CHECK(w > -60);
    CHECK(step < steady + 2);
    CHECK(s->core()->layerCount() == 1);
    CHECK(c3a > 4 * d3a);  // C: C3 G3 C4 (root 48; the subs an octave below)
    CHECK(g2b > 4 * c3b);  // G: G2 D3 G3 (root 43)
    CHECK(rigtest::g_rtAllocs == alloc0);
  }

  TEST_CASE("droneChordFollow: 150 ms debounce, D then G chord voicings, melody notes above C4 ignored") {
    t13::Eng e;
    droneConfig(e, R"({"mode":"synth","chordFollow":true})", 0);
    droneKey(e, 2, false, 0);
    auto *s = service(e);
    REQUIRE(s);
    // audio.js _notesChanged on every noteOn / noteOff (the perform side calls PerformDrone::droneNotesChanged)
    s->droneNotesChanged({50}, 0.5);
    s->droneNotesChanged({50, 54}, 0.5);
    s->droneNotesChanged({50, 54, 57}, 0.5);
    e.until(1.4);
    const auto p1 = pcsOf(s->core()->debugTargets());
    s->droneNotesChanged({54, 57}, 1.5);
    s->droneNotesChanged({57}, 1.5);
    s->droneNotesChanged({}, 1.5);
    s->droneNotesChanged({43}, 1.6);
    s->droneNotesChanged({43, 47}, 1.6);
    s->droneNotesChanged({43, 47, 50}, 1.6);
    s->droneNotesChanged({43, 47, 50, 79}, 1.6);
    e.until(3.0);
    const auto p2 = pcsOf(s->core()->debugTargets());
    auto has = [](const std::vector<int> &p, std::vector<int> want) {
      for (int x : want)
        if (std::find(p.begin(), p.end(), x) == p.end()) return false;
      return true;
    };
    CHECK(has(p1, {2, 6, 9}));
    CHECK(has(p2, {7, 11, 2}));
    CHECK(std::find(p2.begin(), p2.end(), 4) == p2.end());
    CHECK_FALSE(rig::drone::followVoicing({50, 62}, {}).has_value());  // 1 pc -> hold
    CHECK(s->core()->followCount() == 4);
    CHECK(s->core()->layerCount() == 0);  // the static layer faded out (1.5 s) and was returned
  }

  TEST_CASE("droneSongChangeAndFiles: continueAcrossSongs, the pad-file mapping, a missing pad falls back") {
    auto run = [](bool cont) {
      t13::Eng e;
      REQUIRE(e.use(t13::patch({t13::slot("synth", "soft-keys")})));
      droneConfig(e, std::string(R"({"mode":"synth","gain":1,"fade":1,"continueAcrossSongs":)") +
                         (cont ? "true" : "false") + "}",
                  0);
      droneKey(e, 0, false, 0);
      const long tok = e.prepare(t13::patch({t13::slot("synth", "bell")}));
      e.commit(tok, 2);
      auto *s = service(e);
      if (!cont) s->droneSongChanged(2);  // audio.js commit -> drone.songChanged (T14's afterCommit; direct here)
      droneKey(e, 0, false, 2);           // the controller re-sends the same key after the switch
      e.until(4);
      const std::vector<float> d = mono(e);
      struct R {
        double before, after, min;
      };
      return R{t13::db(t13::rms(d, 1.7, 1.95)), t13::db(t13::rms(d, 3.5, 3.9)), t13::minWindowDb(d, 1.8, 3.9)};
    };
    const auto keep = run(true);
    const auto restart = run(false);
    CHECK(keep.min > -60);
    CHECK(std::fabs(keep.after - keep.before) < 3);
    CHECK(restart.after > -60);
    CHECK(restart.min > -80);
    CHECK(restart.after < keep.after);  // restarted with the voices' own 2.5 s attack

    t13::Eng e;
    auto *s = service(e);
    REQUIRE(s);
    const std::string r = e.call(
        R"({"v":1,"op":"drone","id":9,"files":[{"name":"Pad - C.mp3","path":"/x/c"},)"
        R"({"name":"Ambient_Pad_-_F#m.mp3","path":"/x/fsm"},{"name":"Pad E flat.mp3","path":"/x/eb"},)"
        R"({"name":"random.mp3","path":"/x/x"}]})");
    CHECK(rigtest::contains(r, "\"files\":3"));
    auto url = [&](int pc, bool minor) {
      const rig::drone::PadFile *f = s->core()->fileFor(pc, minor);
      return f ? f->path : std::string("-");
    };
    CHECK(url(9, true) == "/x/c");     // Am -> relative major C
    CHECK(url(6, true) == "/x/fsm");   // F#m: relative major A missing -> the F#m file
    CHECK(url(9, false) == "/x/fsm");  // A major -> relative minor F#m
    CHECK(url(3, false) == "/x/eb");
    CHECK(url(2, false) == "-");
    s->core()->setMinorUsesRelativeMajorFile(false);
    CHECK(url(9, true) == "/x/c");  // no Am file: the relative major after all
    // files mode for a key without a pad: warns and plays the synth drone (natively files also work offline)
    e.msgs.clear();
    droneConfig(e, R"({"mode":"files"})", 0);
    droneKey(e, 2, false, 0);
    std::string all;
    for (auto &m : e.msgs) all += m;
    CHECK(rigtest::contains(all, "No pad file for D; using the synth drone."));
    CHECK(s->core()->effectiveMode() == "synth");
  }

  TEST_CASE("droneInstrumentReuse: key changes take the idle A/B instruments (2 builds for 5 keys)") {
    t13::Eng e;
    droneConfig(e, R"({"mode":"synth","gain":1,"fade":1})", 0);
    droneKey(e, 0, false, 0);
    const int keys[] = {7, 2, 9, 4};
    for (int i = 0; i < 4; ++i) {
      e.until(2 + i * 2);
      droneKey(e, keys[i], false, 2 + i * 2);
    }
    e.until(11);
    const std::vector<float> d = mono(e);
    auto *s = service(e);
    CHECK(s->core()->instBuilds() == 2);
    CHECK(t13::minWindowDb(d, 1.2, 10.9) > -60);
    CHECK(bandMag(d, 9.8, 10.9, 82.41 * 2) > 4 * bandMag(d, 9.8, 10.9, 110));  // E: E3 B3 E4
  }

  TEST_CASE("droneParkGain0: parks after 10 s at gain 0, remembers a key change, resumes in it") {
    const double sr = 22050, P = rig::drone::kDroneParkSec;
    t13::Eng e(true, sr);
    droneConfig(e, R"({"mode":"synth","gain":0.8,"fade":0.2})", 0);
    droneKey(e, 0, false, 0);
    auto *s = service(e);
    struct Snap {
      unsigned voices;
      bool parked;
      std::size_t layers;
    };
    auto snap = [&] { return Snap{s->unitForTests()->liveVoices(), s->core()->parked(), s->core()->layerCount()}; };
    auto at = [&](double t) { untilSr(e, t, sr); };
    at(0.5);
    e.set("drone.gain", "0", 0.5);  // a dip ...
    at(1.0);
    e.set("drone.gain", "0.8", 1.0);  // ... back up after 0.5 s: never parks
    at(1.2);
    const Snap dip = snap();
    at(1.5);
    e.set("drone.gain", "0", 1.5);
    at(1.5 + P - 0.3);
    const Snap k1 = snap();
    at(1.5 + P + 0.1);
    droneKey(e, 7, false, 1.5 + P + 0.1);  // parked: remembered, nothing starts
    at(1.5 + P + 1.0);
    const Snap k2 = snap();
    at(1.5 + P + 1.5);
    e.set("drone.gain", "0.8", 1.5 + P + 1.5);  // resume in G
    at(1.5 + P + 3.0);
    const Snap k3 = snap();
    at(P + 8);
    std::vector<float> d(e.L.size());
    for (std::size_t i = 0; i < d.size(); ++i) d[i] = 0.5f * (e.L[i] + e.R[i]);
    auto bandAt = [&](double a, double b, double f) { return bandMagSr(d, sr, a, b, f); };
    const double late = rmsSr(d, sr, 1.5 + P + 4.5, 1.5 + P + 6.5);
    const double g = bandAt(1.5 + P + 4.5, 1.5 + P + 6.5, 98), c = bandAt(1.5 + P + 4.5, 1.5 + P + 6.5, 130.81);
    CHECK(dip.voices > 0);
    CHECK_FALSE(dip.parked);
    CHECK(k1.voices > 0);
    CHECK_FALSE(k1.parked);
    CHECK(k2.parked);
    CHECK(k2.voices == 0);
    CHECK(k2.layers == 0);
    CHECK_FALSE(k3.parked);
    CHECK(k3.voices > 0);
    CHECK(s->core()->keyPc() == 7);
    CHECK(t13::db(late) > -50);
    CHECK(g > 4 * c);
  }

  TEST_CASE("droneOffNoVoices: mode off ends every voice; idle instruments wait disarmed and silent") {
    t13::Eng e;
    droneConfig(e, R"({"mode":"synth","gain":0.5,"fade":0.3})", 0);
    droneKey(e, 2, false, 0);
    e.until(1.2);
    auto *s = service(e);
    const unsigned voicesOn = s->unitForTests()->liveVoices();
    droneConfig(e, R"({"mode":"off"})", 1.2);
    double t = 1.2;
    while (t < 9 && (s->unitForTests()->liveVoices() > 0 || s->core()->layerCount() > 0)) e.until(t += 0.05);
    e.until(t + 0.4);
    CHECK(voicesOn > 0);
    CHECK(s->unitForTests()->liveVoices() == 0);
    CHECK(s->core()->layerCount() == 0);
    CHECK(s->core()->idleCount() == 1);
    for (unsigned i = 0; i < rig::drone::kMaxInst; ++i) CHECK_FALSE(s->unitForTests()->armed(i));
  }

  TEST_CASE("drone params: width matrix, brightness re-voice (9th), movement -> drift, level glide, wheel") {
    t13::Eng e;
    REQUIRE(e.use(t13::patch({}, R"("fx":{"reverb":{"returnGain":0}})")));  // the reverb return is stereo
    droneConfig(e, R"({"mode":"synth","gain":1,"fade":0.5,"width":0})", 0);
    droneKey(e, 0, false, 0);
    e.until(3);
    std::vector<float> L(e.L), R(e.R);
    double side = 0;
    for (std::size_t i = static_cast<std::size_t>(2.5 * t13::kSR); i < L.size(); ++i) side += std::fabs(L[i] - R[i]);
    CHECK(side < 1e-3);  // width 0 = mono (L' = R')
    CHECK(rigtest::contains(e.set("drone.brightness", "0.9", 3), "\"applied\":true"));  // crosses .6: + the 9th
    e.until(6);
    const std::vector<float> d = mono(e);
    CHECK(bandMag(d, 5, 6, 146.83) > 10 * bandMag(d, 2, 3, 146.83));  // D3 = root (48) + 14
    e.set("drone.gain", "0.25", 6, 1);  // a 1 s scene glide
    e.until(8);
    const std::vector<float> d2 = mono(e);
    const double drop = t13::db(t13::rms(d2, 7.5, 8)) - t13::db(t13::rms(d2, 5.5, 6));
    CHECK(drop < -10);
    CHECK(drop > -14);  // -12 dB (x 0.25)
    CHECK_FALSE(rigtest::contains(e.set("drone.nope", "1", 8), "\"applied\":true"));
  }

  TEST_CASE("low resource (O-W3-2): SongState.lowResource reaches the drone; droneFreeze false keeps it live") {
    t13::Eng e;
    auto *s = service(e);
    REQUIRE(s);
    CHECK(rigtest::contains(e.call(R"({"v":1,"op":"config","id":5,"droneFreeze":false})"), "\"droneFreeze\":false"));
    e.call(R"({"v":1,"op":"config","id":5,"lowResource":true})");
    CHECK(e.model().song().lowResource);
    CHECK_FALSE(s->core()->freezeOn());
    CHECK(rigtest::contains(e.call(R"({"v":1,"op":"config","id":5,"droneFreeze":true})"), "\"droneFreeze\":true"));
    CHECK(s->core()->freezeOn());
    e.call(R"({"v":1,"op":"config","id":5,"lowResource":false})");
    CHECK_FALSE(e.model().song().lowResource);
    CHECK_FALSE(s->core()->freezeOn());
    CHECK(rigtest::contains(e.call(R"({"v":1,"op":"get","id":6,"what":"stats"})"), "\"droneFrozen\":false"));
  }

  TEST_CASE("pedal and bend swells move the level toward full; the bend duck ducks to .3; the wheel") {
    t13::Eng e;
    REQUIRE(e.use(t13::patch({}, R"("fx":{"reverb":{"returnGain":0}})")));
    droneConfig(e, R"({"mode":"synth","gain":0.25,"fade":0.5})", 0);
    droneKey(e, 0, false, 0);
    auto *s = service(e);
    e.until(5);
    s->dronePedalSwell(true, 5);  // rise ~2.5 s toward drone.gain 1 (x 4 = +12 dB)
    e.until(10);
    s->dronePedalSwell(false, 10);  // sink back ~3 s
    e.until(17);
    s->droneBendSwell(-1, 17);  // duck to .3
    e.until(18);
    const std::vector<float> d = mono(e);
    const double base = t13::db(t13::rms(d, 4.5, 5)), up = t13::db(t13::rms(d, 9.5, 10));
    const double back = t13::db(t13::rms(d, 16.5, 17)), duck = t13::db(t13::rms(d, 17.7, 18));
    CHECK(up - base > 11);
    CHECK(up - base < 13);
    CHECK(std::fabs(back - base) < 1);
    CHECK(duck - back < -9);  // 20 log10(.3) = -10.5
    CHECK(duck - back > -12);
    s->droneWheel(0, 18, 0.03);
    e.until(18.5);
    const std::vector<float> d2 = mono(e);
    CHECK(t13::rms(d2, 18.3, 18.5) < 1e-5);
  }

  TEST_CASE("rate change (T11a O4): the drone keeps its pitch, its instruments get the new rate's wavetables") {
    t13::Eng e;
    droneConfig(e, R"({"mode":"synth","gain":1,"fade":0.5})", 0);
    droneKey(e, 9, false, 0);  // A: A2 E3 A3
    e.until(3);
    rig_device_info dev{};
    dev.struct_size = sizeof dev;
    dev.device_id = "test";
    dev.device_name = "test";
    dev.sample_rate = 48000;
    dev.channels = 2;
    dev.buffer_frames = 256;
    rig_host_audio_started(e.e, &dev);
    auto o = e.render(3 * 48000, 128);
    std::vector<float> d(o[0].size());
    for (std::size_t i = 0; i < d.size(); ++i) d[i] = 0.5f * (o[0][i] + o[1][i]);
    CHECK(bandMagSr(d, 48000, 1, 3, 110) > 4 * bandMagSr(d, 48000, 1, 3, 110 * 48000 / 44100.0));
    CHECK(t13::minWindowDb(d, 0.1, 2.9) > -60);
    auto *s = service(e);
    CHECK(s->core()->layerCount() == 1);
    char buf[512];
    rig_test_query(e.e, "stats", buf, sizeof buf);
    CHECK(rigtest::contains(buf, "\"rateChanges\":1"));
  }

  TEST_CASE("slot pool full: a cut fading layer's timers leave its reused slot alone (T16 review)") {
    // 30 key changes 0.1 s apart under a 6 s fade: 24 slots fill, the last 6 layers cut the oldest fading ones and
    // take their slots; when those cut layers' fade-end timers fire (~6.1-6.9 s) the live layer must keep sounding
    t13::Eng e;
    droneConfig(e, R"({"mode":"synth","gain":1,"fade":6})", 0);
    std::string log;
    for (int i = 0; i < 30; ++i) {
      const double t = 0.1 * i;
      e.until(t);
      for (const auto &m : e.msgs) log += m;
      log += droneKey(e, i % 12, (i / 12) % 2 == 1, t);
    }
    e.until(9.5);
    for (const auto &m : e.msgs) log += m;
    const std::vector<float> d = mono(e);
    CHECK(t13::minWindowDb(d, 7.0, 9.4) > -60);
    const rig::drone::DroneUnit *u = service(e)->unitForTests();
    REQUIRE(u);
    CHECK(u->liveVoices() >= 3);
    CHECK(rigtest::contains(log, "too many overlapping layers"));  // the cut path ran
  }
}
