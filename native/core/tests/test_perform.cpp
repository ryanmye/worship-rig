// T14 unit.perform: the perform Model (model/perform.{h,cpp}) through the bridge on an offline engine, observed by
// the probe instrument (test_perform_probe.h) and the bridge events. Ports of the JS engine suites named in
// BUILD_PLAN (test/phase1/engine suites: split, transposeFFT's routing part, restrike, sustainDeferral,
// sustainRelease, sustainPedalHold, sustainVariants, monoLowest, stuckNoteFuzz, panicAndFade, touchCurves,
// chordReadout) where the native core has the parts; the audible halves are the golden fixtures (t14.ids).
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <map>
#include <random>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include "inst/voice_alloc.h"
#include "model/perform.h"
#include "num/js_math.h"
#include "test_model_util.h"
#include "test_perform_probe.h"

using t13::Eng;
using t13::patch;
using t13::slot;

namespace {

constexpr double kSR = t13::kSR;

std::int64_t fr(double t) {
  return std::llround(t * kSR);
}

/** A probe slot (type t14probe) with extra JSON fields. */
std::string probe(const std::string &extra = "") {
  return slot("t14probe", "p", 1, extra);
}

/** Engine with one committed probe song; the probe log cleared after the commit. */
struct P {
  Eng e;
  explicit P(const std::vector<std::string> &slots, const std::string &extra = "") {
    REQUIRE(e.use(patch(slots, extra)));
    e.until(0.01);
    t14::clear();
  }
  void bend(double x, double when) {
    e.call(R"({"v":1,"id":21,"op":"play","e":"bend","x":)" + Eng::num(x) + R"(,"when":)" + Eng::num(when) + "}");
  }
  void panic(double when) { e.call(R"({"v":1,"id":22,"op":"play","e":"panic","when":)" + Eng::num(when) + "}"); }
  void fade(double s, double when) {
    e.call(R"({"v":1,"id":23,"op":"play","e":"fade","seconds":)" + Eng::num(s) + R"(,"when":)" + Eng::num(when) + "}");
  }
  rig::Perform &perf() { return e.model().perform(); }
};

std::string ops(const std::vector<t14::Call> &v) {
  std::string s;
  for (const auto &c : v) {
    if (c.op == 'P') continue;
    s += c.op;
    s += std::to_string(c.note);
    if (c.op == 'L') s += ">" + std::to_string(c.note2);
    s += ' ';
  }
  return s;
}

double hexToDouble(const std::string &h) {
  std::uint64_t u = std::stoull(h, nullptr, 16);
  double d;
  std::memcpy(&d, &u, sizeof d);
  return d;
}

std::string dataPath(const char *name) {
  return std::string(RIG_REPO_DIR) + "/tools/golden/vectors/data/" + name;
}

}  // namespace

TEST_SUITE("perform") {
  TEST_CASE("split, transpose, octave and slot transpose decide the sounding note per slot (audio.js noteOn)") {
    P p({probe(R"("lowNote":0,"highNote":59)"), probe(R"("lowNote":60,"highNote":127,"octave":1,"transpose":-2)")});
    p.e.call(R"({"v":1,"op":"song","id":9,"transpose":3})");
    p.e.on(55, 0.1);
    p.e.on(64, 0.2);
    p.e.on(127, 0.3);  // slot 1: 127 + 3 + 12 - 2 > 127: skipped with a warn
    const std::string w = p.e.call(R"({"v":1,"op":"play","e":"on","n":126,"vel":90,"when":0.35})");
    p.e.until(0.5);
    const auto on0 = t14::callsOf('N', 0), on1 = t14::callsOf('N', 1);
    REQUIRE(on0.size() == 1);
    CHECK(on0[0].note == 58);
    CHECK(on0[0].frame == fr(0.1));
    REQUIRE(on1.size() == 1);
    CHECK(on1[0].note == 64 + 3 + 12 - 2);
    CHECK(on1[0].frame == fr(0.2));
    CHECK(p.perf().held().size() == 4);
  }

  TEST_CASE("velocity: linear by default, slot curves, the keyboard's touch for 'normal' slots (touchCurves)") {
    P p({probe(R"("velocityCurve":"soft")"), probe(R"("velocityCurve":"fixed","lowNote":0)"),
         probe(R"("velocityCurve":"custom","touch":{"shape":2,"min":0.1,"max":0.9,"top":100})"),
         probe(R"("highNote":127,"mono":"off")")});  // slot 3 = the Bass role (highNote 59, mono lowest)
    p.e.call(R"({"v":1,"op":"play","e":"on","n":60,"vel":64,"when":0.1,"touch":{"shape":0.5,"min":0,"max":1}})");
    p.e.on(62, 0.2, 127);
    p.e.until(0.3);
    std::map<int, double> v0;
    for (const auto &c : t14::callsOf('N')) v0[c.channel * 1000 + c.note] = c.a;
    CHECK(v0[0 * 1000 + 60] == doctest::Approx(rig::js::pow(64.0 / 127, 0.6)).epsilon(1e-7));
    CHECK(v0[1 * 1000 + 60] == doctest::Approx(100.0 / 127).epsilon(1e-7));
    CHECK(v0[2 * 1000 + 60] == doctest::Approx(0.1 + 0.8 * std::pow(64.0 / 100, 2)).epsilon(1e-7));
    CHECK(v0[3 * 1000 + 60] == doctest::Approx(std::sqrt(64.0 / 127)).epsilon(1e-7));  // the keyboard's curve
    CHECK(v0[3 * 1000 + 62] == doctest::Approx(1.0).epsilon(1e-7));
    CHECK(v0[2 * 1000 + 62] == doctest::Approx(0.9).epsilon(1e-7));
  }

  TEST_CASE("touch curves equal shared/touch-curve.js bit for bit (perform-touch.txt)") {
    std::ifstream f(dataPath("perform-touch.txt"));
    REQUIRE_MESSAGE(f.good(), "run node tools/golden/vectors/dump-perform.mjs");
    std::string line;
    int n = 0, bad = 0;
    const char *names[] = {"soft", "normal", "hard", "fixed"};
    while (std::getline(f, line)) {
      if (line.empty() || line[0] == '#') continue;
      std::istringstream s(line);
      std::string kind;
      s >> kind;
      double got = 0, want = 0;
      if (kind == "named") {
        std::string curve, h;
        int vel;
        s >> curve >> vel >> h;
        int idx = 1;
        for (int k = 0; k < 4; ++k)
          if (curve == names[k]) idx = k;
        got = rig::Touch::preset(idx).at(vel);
        want = hexToDouble(h);
      } else if (kind == "custom") {
        double shape, mn, mx, top;
        int vel;
        std::string h;
        s >> shape >> mn >> mx >> top >> vel >> h;
        got = rig::Touch::compile(shape, mn, mx, top).at(vel);
        want = hexToDouble(h);
      } else {
        continue;  // pedal: SongGraph's pedalCurve (T13), covered by unit.model
      }
      ++n;
      if (got != want) {
        ++bad;
        INFO(line << " got " << got);
        CHECK(got == want);
      }
    }
    CHECK(n > 590);
    CHECK(bad == 0);
  }

  TEST_CASE("chord readout equals shared/chords.js (perform-chords.txt) and the notes event carries it") {
    std::ifstream f(dataPath("perform-chords.txt"));
    REQUIRE(f.good());
    std::string line;
    int n = 0;
    while (std::getline(f, line)) {
      if (line.empty() || line[0] == '#') continue;
      std::istringstream s(line);
      std::string kind;
      s >> kind;
      if (kind == "spell") {
        int pc, minor, sharp;
        s >> pc >> minor >> sharp;
        CHECK(rig::spellingSharp(pc, minor != 0) == (sharp != 0));
        continue;
      }
      std::string pcsS, name, quality, bassS;
      int bassPc, sharp, root, omit5;
      s >> pcsS >> bassPc >> sharp >> name >> root >> quality >> bassS >> omit5;
      std::vector<int> pcs;
      std::stringstream ps(pcsS);
      for (std::string x; std::getline(ps, x, ',');) pcs.push_back(std::stoi(x));
      rig::ChordInfo c;
      const bool ok = rig::chordName(pcs, bassPc, sharp != 0, c);
      INFO(line);
      CHECK(ok == (name != "-"));
      if (ok) {
        CHECK(c.name == name);
        CHECK(c.root == root);
        CHECK(c.quality == quality);
        CHECK(c.omit5 == (omit5 != 0));
      }
      ++n;
    }
    CHECK(n > 1000);
    P p({probe()});
    p.e.call(R"({"v":1,"op":"song","id":9,"key":{"pc":7,"minor":false}})");  // G major: sharps
    p.e.on(54, 0.1);  // "F#" (a single note names itself)
    p.e.on(61, 0.1);  // "F#5"
    const std::string r = p.e.call(R"({"v":1,"op":"play","e":"on","n":58,"vel":90,"when":0.1})");
    CHECK(rigtest::contains(r, R"("ev":"notes","held":[54,58,61],"chord":{"name":"F#","root":6,"quality":"maj")"));
    // two notes that are not a fifth keep the previous name: no chord key (JS compares names only)
    const std::string r2 = p.e.call(R"({"v":1,"op":"play","e":"off","n":61,"when":0.2})");
    CHECK(rigtest::contains(r2, R"("held":[54,58]})"));
    const std::string r3 = p.e.call(R"({"v":1,"op":"play","e":"panic","when":0.3})");
    CHECK(rigtest::contains(r3, R"("held":[],"chord":null})"));
  }

  TEST_CASE("duplicate note-on = re-strike; under the pedal the pedaled voice fades 30 ms first (restrike)") {
    P p({probe()});
    p.e.on(60, 0.1);
    p.e.on(60, 0.2);  // no pedal: note-off, then note-on
    p.e.pedal(true, 0.3);
    p.e.off(60, 0.4);  // pedaled (no NoteOff reaches the instrument)
    p.e.on(60, 0.5);   // re-strike of the pedaled note: FadeNote 30 ms, then NoteOn (same frame, FIFO)
    p.e.until(0.6);
    CHECK(ops(t14::calls()) == "N60 F60 N60 D60 N60 ");
    const auto d = t14::callsOf('D');
    REQUIRE(d.size() == 1);
    CHECK(d[0].a == doctest::Approx(0.03));
    CHECK(d[0].frame == fr(0.5));
    CHECK(p.perf().pedaledCount() == 0);
    p.e.pedal(false, 0.7);
    p.e.until(0.8);
    CHECK(ops(t14::calls()) == "N60 F60 N60 D60 N60 ");  // the struck note is still held by its key
  }

  TEST_CASE("sustain: pedal holds released notes of sustain slots; pedal up releases them (sustainDeferral)") {
    P p({probe(), probe(R"("sustain":false)")});
    p.e.pedal(true, 0.1);
    p.e.on(60, 0.2);
    p.e.off(60, 0.3);
    p.e.until(0.4);
    CHECK(t14::callsOf('F', 0).empty());
    REQUIRE(t14::callsOf('F', 1).size() == 1);  // sustain off: released at once
    CHECK(t14::callsOf('F', 1)[0].frame == fr(0.3));
    CHECK(p.perf().pedaledCount() == 1);
    CHECK(p.perf().quietFor() == 0);
    p.e.pedal(true, 0.45);  // idempotent
    p.e.pedal(false, 0.5);
    p.e.until(0.6);
    REQUIRE(t14::callsOf('F', 0).size() == 1);
    CHECK(t14::callsOf('F', 0)[0].frame == fr(0.5));
    CHECK(p.perf().pedaledCount() == 0);
  }

  TEST_CASE("pedalHold: a pedaled note fades over 25 % of the hold after the hold (sustainPedalHold)") {
    P p({probe(R"("pedalHold":2)")});
    p.e.pedal(true, 0.1);
    p.e.on(60, 0.2);
    p.e.off(60, 0.3);
    p.e.on(64, 0.2);
    p.e.off(64, 0.35);
    p.e.on(64, 1.0);  // re-strike cancels 64's timer
    p.e.until(3.0);
    const auto d = t14::callsOf('D');
    REQUIRE(d.size() == 2);
    CHECK(d[0].note == 64);  // the re-strike
    CHECK(d[1].note == 60);
    CHECK(d[1].a == doctest::Approx(0.5));
    CHECK(std::fabs(static_cast<double>(d[1].frame) / kSR - 2.3) < 128 / kSR + 1e-9);  // quantised timer
    CHECK(p.perf().pedaledCount() == 0);
    p.e.pedal(false, 3.1);
    p.e.until(3.2);
    CHECK(t14::callsOf('F').empty());  // 60 faded already; 64 (re-struck, key still down) stays
  }

  TEST_CASE("mono lowest / highest: legato glides, pedal defers the last release, pedal up ends it (monoLowest)") {
    P p({probe(R"("mono":"lowest")")});
    p.e.on(60, 0.1);
    p.e.on(64, 0.2);  // higher: ignored
    p.e.on(55, 0.3);  // lower: legato 60 -> 55
    p.e.off(55, 0.4);  // back to 60
    p.e.off(60, 0.5);  // -> 64
    p.e.off(64, 0.6);  // release
    p.e.until(0.7);
    CHECK(ops(t14::calls()) == "N60 L60>55 L55>60 L60>64 F64 ");
    t14::clear();
    p.e.pedal(true, 0.8);
    p.e.on(67, 0.9);
    p.e.off(67, 1.0);  // held by the pedal (mono pedalHold)
    p.e.on(67, 1.1);   // the same key again under the hold: _monoSwitch (legato onto the held voice)
    p.e.off(67, 1.2);
    p.e.pedal(false, 1.3);
    p.e.until(1.4);
    CHECK(ops(t14::calls()) == "N67 L67>67 F67 ");
    t14::clear();
    p.e.set("slots.0.mono", R"("highest")");
    p.e.on(60, 1.5);
    p.e.on(67, 1.6);
    p.e.on(64, 1.7);  // lower than 67: ignored
    p.e.off(67, 1.8);  // -> 64
    p.e.until(1.9);
    CHECK(ops(t14::calls()) == "N60 L60>67 L67>64 ");
  }

  TEST_CASE("panic: 30 ms fade of every voice, pedal / held / sounding cleared, bend back to 0 (panicAndFade)") {
    P p({probe(R"("bendEnabled":true)"), probe(R"("bendEnabled":false)")}, R"("bend":{"mode":"pitch","range":2})");
    p.e.pedal(true, 0.1);
    p.e.on(60, 0.2);
    p.bend(0.5, 0.25);
    p.e.off(60, 0.3);
    p.panic(0.4);
    p.e.until(0.5);
    const auto b = t14::callsOf('B');
    REQUIRE(b.size() == 2);  // the bend, and bend 0 at the panic, on the bendEnabled slot only
    CHECK(b[0].channel == 0);
    CHECK(b[0].a == doctest::Approx(1.0));
    CHECK(b[1].a == 0);
    CHECK(b[1].frame == fr(0.4));
    CHECK(t14::callsOf('A').size() == 2);  // both slots, at the panic frame
    CHECK(t14::callsOf('A')[0].frame == fr(0.4));
    CHECK(t14::callsOf('K').empty());  // never the hard kill
    CHECK_FALSE(p.perf().pedal());
    CHECK(p.perf().held().empty());
    CHECK(p.perf().pedaledCount() == 0);
    p.e.pedal(false, 0.6);  // nothing left to release
    p.e.until(0.7);
    CHECK(t14::callsOf('F').empty());
  }

  TEST_CASE("fadeOutAll: voices off after the fade, faded until the next note (panicAndFade, getRuntimeState)") {
    P p({probe()});
    p.e.on(60, 0.1);
    p.fade(0.5, 0.2);
    CHECK(rigtest::contains(p.e.model().runtimeStateJson(), R"("faded":true)"));
    p.e.until(0.8);
    const auto a = t14::callsOf('A');
    REQUIRE(a.size() == 1);
    CHECK(std::fabs(static_cast<double>(a[0].frame) / kSR - 0.7) < 128 / kSR + 1e-9);
    CHECK(p.perf().soundingCount() == 0);
    CHECK(p.perf().held().count(60) == 1);  // JS keeps `held` (the key is still down)
    p.e.on(62, 0.9);
    CHECK(rigtest::contains(p.e.model().runtimeStateJson(), R"("faded":false)"));
    // a second fade while the first runs starts from where it is
    p.fade(1.0, 1.0);
    p.fade(1.0, 1.5);
    p.e.until(2.6);
    CHECK(t14::callsOf('A').size() == 2);  // only the second fade's timer acts
  }

  TEST_CASE("audio: fadeOutAll mutes the output, the next note restores it (sampler-free, test voice)") {
    Eng e;
    REQUIRE(e.use(patch({slot("test", "sine", 1)})));
    e.on(69, 0.05);
    e.call(R"({"v":1,"op":"play","e":"fade","seconds":0.3,"when":0.3})");
    e.on(72, 1.0);
    e.until(1.5);
    CHECK(t13::rms(e.L, 0.2, 0.3) > 1e-3);
    CHECK(t13::rms(e.L, 0.7, 0.95) < 1e-6);
    CHECK(t13::rms(e.L, 1.1, 1.4) > 1e-3);
  }

  TEST_CASE("notes follow their channel into retirement; the pedal releases them there (T13 contract)") {
    P p({probe()});
    p.e.pedal(true, 0.1);
    p.e.on(60, 0.2);
    p.e.off(60, 0.3);
    p.e.until(0.4);
    REQUIRE(p.e.use(patch({slot("t14probe", "q", 1)})));  // a different id: fresh channel, the old one retires
    p.e.pedal(false, 0.5);
    p.e.until(0.6);
    const auto f = t14::callsOf('F', 0);
    REQUIRE(f.size() == 1);
    CHECK(f[0].note == 60);
    CHECK(f[0].frame == fr(0.5));
  }

  TEST_CASE("stuck-note fuzz: random note / pedal / panic streams never leave a note held (stuckNoteFuzz)") {
    P p({probe(), probe(R"("mono":"lowest")"), probe(R"("pedalHold":2,"lowNote":40,"highNote":80)")});
    std::mt19937 rng(14);
    std::set<int> down;
    double t = 0.05;
    for (int k = 0; k < 600; ++k) {
      t += 0.004 + (rng() % 10) * 0.001;
      const unsigned r = rng() % 100;
      const int n = 36 + static_cast<int>(rng() % 48);
      if (r < 45) {
        p.e.on(n, t, 1 + static_cast<int>(rng() % 127));
        down.insert(n);
      } else if (r < 85) {
        p.e.off(n, t);
        down.erase(n);
      } else if (r < 97) {
        p.e.pedal(rng() % 2 == 0, t);
      } else {
        p.panic(t);
        down.clear();
      }
    }
    for (int n : std::set<int>(down)) p.e.off(n, t += 0.003);
    p.e.pedal(false, t += 0.01);
    p.e.until(t + 3);
    std::map<std::pair<int, int>, int> held;  // (channel, note) -> net
    for (const auto &c : t14::calls()) {
      if (c.op == 'N') held[{c.channel, c.note}] = 1;
      else if (c.op == 'F' || c.op == 'D') held[{c.channel, c.note}] = 0;
      else if (c.op == 'L') {
        held[{c.channel, c.note}] = 0;
        held[{c.channel, c.note2}] = 1;
      } else if (c.op == 'A') {
        for (auto &[k, v] : held)
          if (k.first == c.channel) v = 0;
      }
    }
    int stuck = 0;
    for (const auto &[k, v] : held) stuck += v;
    CHECK(stuck == 0);
    CHECK(p.perf().soundingCount() == 0);
    CHECK(p.perf().pedaledCount() == 0);
    CHECK(p.perf().held().empty());
  }

  TEST_CASE("quietFor: 0 while keys or the pedal hold, else the time since the last input (v11-reverb-quiet)") {
    P p({probe()});
    p.e.until(0.5);
    p.e.on(60, -1);
    CHECK(p.perf().quietFor() == 0);
    p.e.off(60, -1);
    p.e.until(1.5);
    CHECK(p.perf().quietFor() == doctest::Approx(1.0).epsilon(0.01));
    p.e.pedal(true, -1);
    CHECK(p.perf().quietFor() == 0);
    p.e.until(32);  // a pedal down for 30 s stops counting (PEDAL_STUCK_SEC)
    CHECK(p.perf().quietFor() > 30);
  }

  TEST_CASE("VoicePool::fadeNote fades only the HELD voices of that note (O-W3-1)") {
    rig::inst::VoicePool<int> pool;
    const int a = pool.emplace(60, 0.0, 1), b = pool.emplace(60, 0.1, 2), c = pool.emplace(64, 0.2, 3);
    pool.markReleased(b, 0.3);
    std::vector<int> faded;
    CHECK(pool.fadeNote(60, 0.5, [&](int s) { faded.push_back(s); }) == 1);
    REQUIRE(faded.size() == 1);
    CHECK(faded[0] == a);
    CHECK(pool.meta(a).state == rig::inst::VoiceState::Killed);
    CHECK(pool.meta(b).state == rig::inst::VoiceState::Released);
    CHECK(pool.meta(c).state == rig::inst::VoiceState::Held);
    CHECK(pool.playing() == 2);
    CHECK(pool.fadeNote(61, 0.5, [&](int) { FAIL("no voice plays 61"); }) == 0);
  }

  TEST_CASE("re-strike under the pedal on a synth.js instrument: the old voice is gone after its 30 ms fade") {
    Eng e;
    REQUIRE(e.use(patch({slot("synth", "strings", 1)})));
    e.pedal(true, 0.05);
    e.on(60, 0.1);
    e.off(60, 0.3);
    e.until(0.9);
    CHECK(e.meters().voices == 1);
    e.on(60, 1.0);
    e.until(1.3);
    CHECK(e.meters().voices == 1);  // without FadeNote the pedaled voice would still sound next to the new one
    e.on(64, 1.4);
    e.off(64, 1.5);
    e.on(64, 1.6);  // a second pedaled re-strike: 60 (pedaled) + the new 64
    e.until(1.8);
    CHECK(e.meters().voices == 2);
  }

  TEST_CASE("slots 4..15 play like slot 0 (DECISIONS D3)") {
    std::vector<std::string> s(16, "null");
    s[0] = probe(R"("highNote":59)");
    s[15] = probe(R"("lowNote":60,"transpose":1)");
    P p(s);
    p.e.on(59, 0.1);
    p.e.on(60, 0.2);
    p.e.until(0.3);
    REQUIRE(t14::callsOf('N', 0).size() == 1);
    REQUIRE(t14::callsOf('N', 15).size() == 1);
    CHECK(t14::callsOf('N', 15)[0].note == 61);
  }
  TEST_CASE("graph rule (T00c O3): a retiring channel's mono line retriggers with a targeted NoteOn on RetireInst") {
    // audio.js _monoOff -> _monoSwitch(sc) on the retiring channel: the next held note starts there. The test voice
    // has no legatoTo, so the switch is a FadeNote + a NoteOn targeted at RetireInst<j>, which the graph applies.
    Eng e;
    REQUIRE(e.use(patch({slot("test", "sine", 1, R"("mono":"lowest")")})));
    e.on(60, 0.05);
    e.on(72, 0.1);  // higher: held, silent (mono lowest)
    e.until(0.3);
    REQUIRE(e.use(patch({probe()})));  // a different kind: fresh channel, the sine retires with both keys held
    e.off(60, 0.4);                     // -> 72 on the retiring channel
    e.until(0.8);
    auto level = [&](double hz, double a, double b) {  // Goertzel magnitude of e.L in [a, b)
      const auto i0 = static_cast<std::size_t>(a * kSR), i1 = static_cast<std::size_t>(b * kSR);
      const double w = 2 * M_PI * hz / kSR, cw = 2 * std::cos(w);
      double s1 = 0, s2 = 0;
      for (std::size_t i = i0; i < i1; ++i) {
        const double s0 = e.L[i] + cw * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      return std::sqrt(s1 * s1 + s2 * s2 - cw * s1 * s2) / static_cast<double>(i1 - i0);
    };
    const double f60 = 440 * std::pow(2.0, (60 - 69) / 12.0), f72 = 2 * f60;
    CHECK(level(f60, 0.2, 0.35) > 10 * level(f72, 0.2, 0.35));  // before: the low note
    // after: the retiring channel plays 72 (the targeted NoteOn reached RetireInst<0>). The test voice has no
    // FadeNote, so its 60 keeps sounding: only the arrival of 72 is checked.
    CHECK(level(f72, 0.5, 0.75) > 30 * level(f72, 0.2, 0.35));
    CHECK(e.model().songGraph().retiringCount() == 1);
  }
}
