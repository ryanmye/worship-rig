// T11 synth.js port (kind "inst.synth"): the six synth.js golden fixtures at the exact tier through the fixture runner
// (= rig_render) with the allocation trap on, the PRNG seeding, the voice lifecycle (VoiceEnded, releaseVoice, kill,
// allNotesOff), D1 polyphony through the instrument, pitch / bend / legato, params, morph, the release override, the
// rate-change wavetable swap (T11a O4), the synth-extra dispatch hook and the instrument-param set handler.
#include <cmath>
#include <string>

#include "inst/instrument_service.h"
#include "inst/synth.h"
#include "inst/synth_dispatch.h"
#include "inst/synth_voices.h"
#include "num/prng.h"
#include "test_synth_util.h"

using rig::inst::SynthInstrument;

namespace {

constexpr double kExactMaxDiff = 2e-4;  // manifest tolerances.exact.maxAbsDiff

rig::Command op(rig::Op o, double t, double sr, std::uint32_t aux = 0) {
  rig::Command c{};
  c.op = o;
  c.frame = std::llround(t * sr);
  c.aux = aux;
  return c;
}

std::string commitSlot0(rigtest::OfflineEngine &e, const std::string &instrument, const std::string &extra = "") {
  e.hello();
  e.call(R"({"v":1,"op":"audio","action":"start","id":3})");
  const std::string r = e.call(R"({"v":1,"op":"prepare","id":5,"patch":{"slots":[{"instrument":)" + instrument +
                               R"(,"gain":1)" + extra + "},null,null,null]}}");
  const std::size_t p = r.find("\"token\":");
  REQUIRE(p != std::string::npos);
  const long tok = std::strtol(r.c_str() + p + 8, nullptr, 10);
  return e.call(R"({"v":1,"op":"commit","id":6,"when":0,"token":)" + std::to_string(tok) + "}");
}

int g_extraCalls = 0;
rig::Unit *fakeExtra(const rig::UnitEnv &env, const rig::UnitSpec &) {
  ++g_extraCalls;  // stands in for T15: a warm-pad plays the synth-extra id
  return new SynthInstrument(*rig::inst::findPatch("warm-pad"), env.sampleRate, 1, "fake", "{}", 0);
}

}  // namespace

TEST_SUITE("synth") {
  TEST_CASE("golden synth.js fixtures at the exact tier (max |diff| <= 2e-4), allocation trap on") {
    for (const char *id : {"synth-warm-pad", "synth-glass-pad", "synth-strings", "synth-sub-bass", "synth-bell",
                           "synth-soft-keys"}) {
      CAPTURE(id);
      const t11::GoldenResult g = t11::goldenRun(id);
      if (!g.present) continue;
      CHECK(g.peak > 0.1);  // none of these goldens is silence
      CHECK(g.maxDiff <= kExactMaxDiff);
      CHECK(g.rtAllocs == 0);
      CHECK(g.skipped.empty());
    }
  }

  TEST_CASE("PRNG: rngFor(seed, 'inst|<slot>|synth|<id>|<instSeq>') = the manifest stream seeds; forked once") {
    struct S {
      const char *name;
      std::uint32_t seed;
    } streams[] = {{"inst|0|synth|warm-pad|1", 2164297332u}, {"inst|0|synth|glass-pad|1", 330908569u},
                   {"inst|0|synth|strings|1", 1584860539u},  {"inst|0|synth|sub-bass|1", 736155387u},
                   {"inst|0|synth|bell|1", 3170535236u}};
    for (const S &s : streams) CHECK(rig::rngFor(1, s.name).seed() == s.seed);
    rig::Rng outer = rig::rngFor(1, "inst|0|synth|warm-pad|1");
    const rig::Rng fork = outer.fork();  // asRng(prng) = prng.fork(): floor(next() * 2^32) >>> 0
    rig::Rng again = rig::rngFor(1, "inst|0|synth|warm-pad|1");
    CHECK(fork.seed() == rig::toUint32(std::floor(again.next() * 4294967296.0)));
  }

  TEST_CASE("note lifecycle: release, sources stop at release x 1.3, VoiceEnded(slot, id), liveVoices 0") {
    const double sr = 48000;
    t11::Driver d(t11::makeSynth("sub-bass", sr), sr);  // release 0.25 s
    auto *s = static_cast<SynthInstrument *>(d.u.get());
    d.noteOn(36, 100, 0.01);
    CHECK(s->liveVoices() == 1);
    const rig::VoiceId id = s->voiceIdOf(36);
    d.noteOff(36, 0.2);
    const auto out = d.run(48000);
    CHECK(t11::rms(out[0], 4800, 9600) > 0.01);
    CHECK(t11::rms(out[0], 30000, 48000) < 1e-6);
    CHECK(s->liveVoices() == 0);
    REQUIRE(d.count(rig::EventKind::VoiceEnded) == 1);
    for (const auto &e : d.sink.ev) {
      if (e.kind != rig::EventKind::VoiceEnded) continue;
      CHECK(e.f.a == double(rig::UnitSlot::Inst0));
      CHECK(e.f.b == double(id));
      CHECK(double(e.frame) / sr > 0.2 + 0.25 * 1.3);  // stopAfterRelease, then the filter tail
      CHECK(double(e.frame) / sr < 0.2 + 0.25 * 1.3 + 0.05);
    }
    CHECK(d.rtAllocs == 0);
  }

  TEST_CASE("release override (slots.<i>.release / SynthOp::ReleaseOverride) replaces the patch release") {
    const double sr = 48000;
    t11::Driver d(t11::makeSynth("sub-bass", sr, "{}", 1.0), sr);
    d.noteOn(36, 100, 0.01);
    d.noteOff(36, 0.1);
    d.run(48000);
    CHECK(d.count(rig::EventKind::VoiceEnded) == 0);  // 0.1 + 1.3 s
    d.run(48000);
    CHECK(d.count(rig::EventKind::VoiceEnded) == 1);
    rig::Command c{};
    c.op = rig::opOf(rig::inst::SynthOp::ReleaseOverride);
    c.f.a = 0;  // back to the patch's own 0.25 s
    d.apply(c);
    d.noteOn(40, 100, 2.01);
    d.noteOff(40, 2.1);
    d.run(24000);
    CHECK(d.count(rig::EventKind::VoiceEnded) == 2);
  }

  TEST_CASE("allNotesOff fades every voice in 30 ms; kill() stops at once; releaseVoice(id) fades one voice") {
    const double sr = 48000;
    t11::Driver d(t11::makeSynth("bell", sr), sr);
    auto *s = static_cast<SynthInstrument *>(d.u.get());
    for (int n = 60; n < 64; ++n) d.noteOn(n, 100, 0.01);
    d.run(9600);
    d.apply(op(rig::Op::ReleaseVoice, 0.2, sr, s->voiceIdOf(61)));
    auto out = d.run(9600);
    CHECK(s->playingNote(61) == 0);
    CHECK(s->playingNote(60) == 1);
    d.apply(op(rig::Op::AllNotesOff, 0.4, sr));
    out = d.run(9600);  // 0.4 .. 0.6
    CHECK(t11::rms(out[0], 4800, 9600) < 1e-6);  // -60 dB at 30 ms, stopped at 39 ms
    CHECK(s->liveVoices() == 0);
    d.noteOn(70, 100, 0.61);
    d.run(9600);
    d.apply(op(rig::Op::Panic, 0.8, sr));
    out = d.run(1280);
    for (float v : out[0]) CHECK_MESSAGE(v == 0.0f, "kill(): silence from the next quantum (bell: no bus filter)");
    CHECK(s->liveVoices() == 0);
    CHECK(d.rtAllocs == 0);
  }

  TEST_CASE("pitch: A4 = 440 Hz; bend +2 st (8 ms ramp); legatoTo glides to the new note") {
    const double sr = 48000;
    t11::Driver d(t11::makeSynth("bell", sr, R"({"index":0,"decay":12})"), sr);  // index 0: a pure sine carrier
    d.noteOn(69, 100, 0.01);
    auto out = d.run(48000);
    CHECK(t11::zeroCrossHz(out[0], 9600, 40000, sr) == doctest::Approx(440).epsilon(1e-4));
    rig::Command b = op(rig::Op::Bend, 1.0, sr);
    b.f.a = 2;
    d.apply(b);
    out = d.run(48000);
    CHECK(t11::zeroCrossHz(out[0], 4800, 40000, sr) == doctest::Approx(493.8833).epsilon(1e-4));
    rig::Command z = op(rig::Op::Bend, 2.0, sr);
    z.f.a = 0;
    d.apply(z);
    d.apply(op(rig::Op::LegatoTo, 2.0, sr, 69u | (72u << 8)));
    out = d.run(48000);
    CHECK(t11::zeroCrossHz(out[0], 4800, 40000, sr) == doctest::Approx(523.2511).epsilon(1e-4));
    auto *s = static_cast<SynthInstrument *>(d.u.get());
    CHECK(s->playingNote(72) == 1);
    CHECK(s->playingNote(69) == 0);
  }

  TEST_CASE("setParam: clamped to the patch range, applied (warm-pad cutoff opens the filter), morph") {
    const double sr = 48000;
    t11::Driver a(t11::makeSynth("warm-pad", sr), sr), b(t11::makeSynth("warm-pad", sr), sr);
    auto *sb = static_cast<SynthInstrument *>(b.u.get());
    const int ci = rig::inst::paramIndex(sb->patch(), "cutoff");
    REQUIRE(ci >= 0);
    rig::Command c = op(rig::Op::InstParam, 0, sr, static_cast<std::uint32_t>(ci));
    c.f.a = 99999;
    c.f.b = 0;
    b.apply(c);
    CHECK(sb->paramValue(static_cast<std::size_t>(ci)) == 14000);
    a.noteOn(60, 100, 0.01);
    b.noteOn(60, 100, 0.01);
    const auto oa = a.run(48000), ob = b.run(48000);
    CHECK(rigtest::maxAbsDiff(oa[0], ob[0]) > 1e-3);
    rig::Command m{};
    m.op = rig::opOf(rig::inst::SynthOp::Morph);
    m.f.a = 1;
    m.f.b = 1.0;
    a.apply(m);
    const auto ma = a.run(9600), mb = b.run(9600);
    CHECK(rigtest::maxAbsDiff(ma[0], mb[0]) > 1e-4);
    CHECK(a.rtAllocs == 0);
  }

  TEST_CASE("D1 polyphony: default cap 64, setVoiceCap 32/128 (Op::VoiceCap), steals fade 20 ms") {
    const double sr = 48000;
    t11::Driver d(t11::makeSynth("bell", sr), sr);
    auto *s = static_cast<SynthInstrument *>(d.u.get());
    CHECK(s->voiceCap() == 64);
    for (int i = 0; i < 70; ++i) d.noteOn(20 + i, 80, 0.01 + i * 0.001);
    CHECK(s->playingVoices() == 64);
    CHECK(s->steals() == 6);
    CHECK(s->playingNote(20) == 0);  // the six oldest held voices went first
    CHECK(s->playingNote(26) == 1);
    d.run(9600);
    CHECK(s->liveVoices() == 64);  // the stolen ones have faded and are gone
    d.apply(op(rig::Op::VoiceCap, 0, sr, 128));
    CHECK(s->voiceCap() == 128);
    for (int i = 0; i < 50; ++i) d.noteOn(20 + i, 80, 0.21);
    CHECK(s->playingVoices() == 114);
    d.apply(op(rig::Op::VoiceCap, 0, sr, 32));
    d.noteOn(100, 80, 0.22);
    CHECK(s->playingVoices() == 32);
    d.run(9600);
    CHECK(s->liveVoices() == 32);
    CHECK(d.rtAllocs == 0);
  }

  TEST_CASE("rate change (T11a O4): SetWaves re-points the tables, the old bank comes back as Garbage") {
    t11::Driver d(t11::makeSynth("bell", 48000, R"({"index":0,"decay":12})"), 48000);
    d.noteOn(69, 100, 0.01);
    d.run(4800);
    d.sr = 96000;  // the graph adopted 96 kHz: Unit::setSampleRate, then frames continue at the new rate
    d.u->setSampleRate(96000);
    d.frame = d.frame * 2;
    auto out = d.run(19200);
    CHECK(t11::zeroCrossHz(out[0], 1000, 19000, 96000) == doctest::Approx(880).epsilon(1e-3));  // 48 kHz tables
    auto *w = new rig::inst::WavesPayload();
    w->bank = rig::inst::WaveBank::get(96000, rig::inst::synthWaveFamilies("bell"));
    rig::Command c{};
    c.op = rig::opOf(rig::inst::SynthOp::SetWaves);
    c.sub = rig::kSubOwnedPayload;
    c.p.ptr = static_cast<rig::Owned *>(w);
    d.apply(c);
    out = d.run(19200);
    CHECK(t11::zeroCrossHz(out[0], 1000, 19000, 96000) == doctest::Approx(440).epsilon(1e-4));
    CHECK(d.count(rig::EventKind::Garbage) == 1);
    CHECK(d.rtAllocs == 0);
  }

  TEST_CASE("synth-extra ids: silent + 'unsupported' warning without T15; dispatched through the hook with it") {
    REQUIRE(rig::inst::kSynthExtraCount == 10);
    CHECK(rig::inst::isSynthExtraId("juno-pad"));
    CHECK_FALSE(rig::inst::isSynthExtraId("warm-pad"));
    const rig::UnitFactory saved = rig::inst::synthExtraFactory();
    rig::inst::registerSynthExtra(nullptr);
    {
      rigtest::OfflineEngine e(44100);
      const std::string r = commitSlot0(e, R"({"type":"synth","id":"juno-pad"})");
      CHECK(rigtest::contains(r, "instrument 'synth:juno-pad'"));
      CHECK(rigtest::contains(r, "\"code\":\"unsupported\""));
    }
    rig::inst::registerSynthExtra(&fakeExtra);
    g_extraCalls = 0;
    {
      rigtest::OfflineEngine e(44100);
      const std::string r = commitSlot0(e, R"({"type":"synth","id":"juno-pad"})");
      CHECK_FALSE(rigtest::contains(r, "unsupported"));
      CHECK(g_extraCalls == 1);
      e.call(R"({"v":1,"op":"play","id":7,"e":"on","n":60,"vel":100})");
      const auto out = e.render(44100);
      CHECK(t11::rms(out[0], 22050, 44100) > 1e-3);
    }
    rig::inst::registerSynthExtra(saved);
    {
      rigtest::OfflineEngine e(44100);  // a synth.js id never warns
      CHECK_FALSE(rigtest::contains(commitSlot0(e, R"({"type":"synth","id":"bell"})"), "unsupported"));
    }
  }

  TEST_CASE("set slots.<i>.params.<key>: catalogue index -> Op::InstParam; stored in the patch; empty slot false") {
    auto render = [](bool withSet) {
      rigtest::OfflineEngine e(44100);
      commitSlot0(e, R"({"type":"synth","id":"warm-pad"})");
      if (withSet) {
        const std::string r = e.call(R"({"v":1,"op":"set","id":8,"path":"slots.0.params.cutoff","value":12000})");
        CHECK(rigtest::contains(r, "\"applied\":true"));
        const std::string r2 = e.call(R"({"v":1,"op":"set","id":9,"path":"slots.1.params.cutoff","value":1})");
        CHECK_FALSE(rigtest::contains(r2, "\"applied\":true"));
      }
      e.call(R"({"v":1,"op":"play","id":7,"e":"on","n":60,"vel":100})");
      return e.render(44100);
    };
    const auto a = render(false), b = render(true);
    CHECK(rigtest::maxAbsDiff(a[0], b[0]) > 1e-3);
  }

  TEST_CASE("every synth.js patch builds, plays and ends (incl. hidden drone-osc), stereo / mono as in Web Audio") {
    for (const char *id : {"warm-pad", "glass-pad", "strings", "sub-bass", "soft-keys", "bell", "drone-osc"}) {
      CAPTURE(id);
      const double sr = 44100;
      t11::Driver d(t11::makeSynth(id, sr), sr);
      auto *s = static_cast<SynthInstrument *>(d.u.get());
      const bool mono = std::string(id) == "sub-bass" || std::string(id) == "bell";
      CHECK(s->outputChannels() == (mono ? 1u : 2u));
      d.noteOn(48, 100, 0.01);
      d.noteOn(60, 100, 0.01);
      d.noteOff(48, 0.5);
      d.noteOff(60, 0.5);
      const auto out = d.run(44100 * 2 / 128 * 128);
      CHECK(t11::rms(out[0], 4410, 22050) > 1e-3);
      d.run(44100 * 8 / 128 * 128);  // the longest release (drone-osc 4 s x 1.3)
      CHECK(s->liveVoices() == 0);
      CHECK(d.count(rig::EventKind::VoiceEnded) == 2);
      CHECK(d.rtAllocs == 0);
    }
  }
}
