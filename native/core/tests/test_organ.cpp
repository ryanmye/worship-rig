// T15: organ.js (kind inst.organ). Golden fixtures at the exact tier (the four presets, pan-mono-src and T13's organ
// automation originals), the preset tables against the engine-api.json catalogue (bool / enum rows included), the
// registry kind, and the voice bookkeeping with the allocation trap on.
#include <cstdlib>
#include <memory>
#include <string>

#include "api/registry.h"
#include "inst/organ.h"
#include "inst/synth_extra.h"
#include "inst/synth_extra_tables.h"
#include "model/patch.h"
#include "test_model_util.h"
#include "test_synth_extra_util.h"
#include "test_synth_util.h"

namespace {

using t13::Eng;

/** max |a - b| over both channels of two engines' renders in [t0, t1] s. */
double diffIn(const Eng &a, const Eng &b, double t0, double t1) {
  const auto i0 = static_cast<std::size_t>(t0 * t13::kSR);
  const auto i1 = std::min({a.L.size(), b.L.size(), static_cast<std::size_t>(t1 * t13::kSR)});
  double m = 0;
  for (std::size_t i = i0; i < i1; ++i)
    m = std::max({m, std::fabs(double(a.L[i]) - b.L[i]), std::fabs(double(a.R[i]) - b.R[i])});
  return m;
}

/** An engine playing one organ slot (`extra` = more slot members, `top` = patch members), chord at `at` s. */
struct OrganEng {
  Eng e;
  OrganEng(const char *id, const std::string &extra = "", const std::string &top = "") {
    REQUIRE(e.use(t13::patch({t13::slot("organ", id, 1, extra)}, top)));
  }
  void chord(double at) {
    for (int n : {48, 55, 64}) e.on(n, at);
  }
};

}  // namespace

TEST_SUITE("organ") {
  TEST_CASE("golden fixtures at the exact tier") {
    for (const char *id : {"organ-gospel", "organ-soft-pad", "organ-full", "organ-church", "pan-mono-src",
                           "auto-slot-level", "auto-reverb-send", "auto-master-volume"}) {
      CAPTURE(id);
      const t15::GoldenResult g = t15::goldenRun(id);
      if (!g.present) continue;
      CHECK(g.peak > 0.01);  // none of these goldens is silence
      CHECK(g.maxDiff <= 2e-4);
      CHECK(g.rtAllocs == 0);
    }
  }

  TEST_CASE("preset tables = engine-api.json catalogue") {
    const t15::Doc api{t15::readFile(std::string(RIG_REPO_DIR) + "/native/contract/engine-api.json")};
    REQUIRE(api.d);
    for (std::size_t k = 0; k < rig::inst::kOrganPresetCount; ++k) {
      const auto &p = rig::inst::organPresetDef(static_cast<rig::inst::OrganPreset>(k));
      CAPTURE(p.idStr);
      yyjson_val *e = t15::catalogueEntry(api, "organ", p.idStr);
      REQUIRE(e);
      CHECK(std::string(yyjson_get_str(yyjson_obj_get(e, "name"))) == p.name);
      CHECK(yyjson_get_num(yyjson_obj_get(e, "gainTrimDb")) == doctest::Approx(p.trimDb));
      yyjson_val *params = yyjson_obj_get(e, "params");
      REQUIRE(yyjson_arr_size(params) == p.nParams);
      for (std::size_t j = 0; j < p.nParams; ++j) {
        yyjson_val *q = yyjson_arr_get(params, j);
        const auto &d = p.params[j];
        CAPTURE(d.key);
        CHECK(std::string(yyjson_get_str(yyjson_obj_get(q, "key"))) == d.key);
        CHECK(std::string(yyjson_get_str(yyjson_obj_get(q, "label"))) == d.label);
        CHECK(std::string(yyjson_get_str(yyjson_obj_get(q, "unit"))) == d.unit);
        yyjson_val *def = yyjson_obj_get(q, "default");
        if (yyjson_is_bool(def)) {
          CHECK((yyjson_get_bool(def) ? 1.0 : 0.0) == d.def);
        } else if (yyjson_is_str(def)) {  // enum: the default is listed at index d.def
          yyjson_val *en = yyjson_obj_get(q, "enum");
          REQUIRE(yyjson_is_arr(en));
          CHECK(std::string(yyjson_get_str(yyjson_arr_get(en, static_cast<std::size_t>(d.def)))) ==
                yyjson_get_str(def));
          CHECK(yyjson_arr_size(en) == 3);
        } else {
          CHECK(yyjson_get_num(def) == d.def);
          CHECK(yyjson_get_num(yyjson_obj_get(q, "min")) == d.min);
          CHECK(yyjson_get_num(yyjson_obj_get(q, "max")) == d.max);
        }
      }
    }
  }

  TEST_CASE("registry: kind inst.organ builds every preset (unknown -> gospel, as organ.js)") {
    rig::PatchSpec ps;
    ps.slots[0].present = true;
    ps.slots[0].instType = "organ";
    rig::UnitEnv env;
    rig::UnitSpec spec;
    spec.patch = &ps;
    spec.channel = 0;
    for (const char *id : {"gospel", "soft-pad", "full", "church", "nope"}) {
      ps.slots[0].instId = id;
      std::unique_ptr<rig::Unit> u(rig::inst::makeOrgan(env, spec));
      REQUIRE(u);
      auto *o = dynamic_cast<rig::inst::OrganInstrument *>(u.get());
      REQUIRE(o);
      CHECK(std::string(o->preset().idStr) == (std::string(id) == "nope" ? "gospel" : id));
      CHECK(o->outputChannels() == 2u);
    }
  }

  TEST_CASE("cap, fadeNote, params from slots.<i>.params JSON, kill: no allocation") {
    const auto &p = rig::inst::organPresetDef(rig::inst::OrganPreset::Gospel);
    auto *o = new rig::inst::OrganInstrument(p, 48000, 1, "inst|0|organ|gospel|1",
                                             R"({"rotary":"off","percussion":false,"drawbar9":7.6,"drive":0.9})", 0);
    CHECK(static_cast<int>(o->paramValue(rig::inst::ok::kRotary)) == rig::inst::ok::kOff);
    CHECK(o->paramValue(rig::inst::ok::kPercussion) == 0);
    CHECK(o->paramValue(8) == 8);  // step 1
    CHECK(o->paramValue(rig::inst::ok::kDrive) == doctest::Approx(0.9));
    // T15 review: a numeric bool param is coerceParam's `value >= 0.5`, not a clamp
    o->setParam(rig::inst::ok::kPercussion, 0.3, 0, 0);
    CHECK(o->paramValue(rig::inst::ok::kPercussion) == 0);
    o->setParam(rig::inst::ok::kPercussion, 0.7, 0, 0);
    CHECK(o->paramValue(rig::inst::ok::kPercussion) == 1);
    o->setParam(rig::inst::ok::kPercussion, 0, 0, 0);
    t11::Driver d(o, 48000);
    rig::Command cap{};
    cap.op = rig::Op::VoiceCap;
    cap.aux = 3;
    d.apply(cap);
    for (int i = 0; i < 5; ++i) d.noteOn(48 + i, 100, 0.01);
    const auto out = d.run(48000 / 5);
    CHECK(t11::rms(out[0], 0, out[0].size()) > 1e-3);
    CHECK(o->playingVoices() == 3);
    rig::Command fade{};
    fade.op = rig::Op::FadeNote;
    fade.frame = d.frame;
    fade.aux = 52;
    d.apply(fade);
    CHECK(o->playingVoices() == 2);
    rig::Command panic{};
    panic.op = rig::Op::Panic;
    d.apply(panic);
    d.run(rig::kQ);
    CHECK(o->liveVoices() == 0);
    CHECK(d.rtAllocs == 0);
  }

  // ---- W3B: the T15 review's open items (Model / service side) ---------------------------------------------------

  TEST_CASE("T15 review 1: an enum param set as its name from the UI (rotary 'off' / 'fast' / unlisted)") {
    OrganEng a("gospel", R"("params":{"rotary":"off"})");  // built off
    OrganEng b("gospel"), c("gospel"), d("gospel"), u("gospel");  // gospel's own rotary: fast
    CHECK(rigtest::contains(b.e.set("slots.0.params.rotary", R"("off")", 0), R"("applied":true)"));
    CHECK(rigtest::contains(c.e.set("slots.0.params.rotary", R"("fast")", 0), R"("applied":true)"));
    // voice.js coerceParam: an unlisted name is the preset's default (fast here)
    CHECK(rigtest::contains(u.e.set("slots.0.params.rotary", R"("spin")", 0), R"("applied":true)"));
    for (OrganEng *o : {&a, &b, &c, &d, &u}) {
      o->chord(0.5);
      o->e.until(1.5);
    }
    CHECK(t13::rms(d.e.L, 0.6, 1.5) > 1e-3);
    // 'off' = the instrument built with rotary off once the 30 ms dry / rotary crossfade has settled (was: 0 = slow)
    CHECK(diffIn(a.e, b.e, 0.5, 1.5) < 1e-5);
    CHECK(diffIn(a.e, d.e, 0.5, 1.5) > 1e-2);
    // 'fast' on a fast preset and an unlisted name change nothing (was: slow, the horn slowing down from 0)
    CHECK(diffIn(c.e, d.e, 0, 1.5) == 0);
    CHECK(diffIn(u.e, d.e, 0, 1.5) == 0);
    // the stored params keep the index: a rebuild of the unit plays the same
    CHECK(rigtest::contains(b.e.model().patch().slots[0].paramsJson, R"("rotary":2)"));
    // a name for a numeric param or a non-organ instrument: not applied (the JSON stays unchanged)
    CHECK(rigtest::contains(d.e.set("slots.0.params.drive", R"("hot")", 0), R"("applied":false)"));
    Eng s;
    REQUIRE(s.use(t13::patch({t13::slot("synth", "warm-pad")})));
    CHECK(rigtest::contains(s.set("slots.0.params.rotary", R"("fast")", 0), R"("applied":false)"));
    const auto &sp = d.e.model().patch().slots[0];
    CHECK(rig::inst::instEnumIndex(sp, "rotary", "slow") == rig::inst::ok::kSlow);
    CHECK(rig::inst::instEnumIndex(sp, "rotary", "off") == rig::inst::ok::kOff);
    CHECK(rig::inst::instEnumIndex(sp, "rotary", "?") == rig::inst::ok::kFast);  // gospel's default
    CHECK(rig::inst::instEnumIndex(sp, "drive", "slow") == -1);
  }

  TEST_CASE("W3B review N1: a song switch that changes only the organ rotary changes it (reuse path)") {
    // song A: gospel rotary 'fast'; song B: the same preset, rotary 'off' (song.cpp paramsMatch / applyReused used to
    // clamp the enum row into [0, 0], so every rotary compared equal, the channel was reused and stayed 'fast')
    auto reused = [](Eng &e) {
      const std::string r = e.call(R"({"v":1,"op":"get","what":"stats","id":99})");
      const std::size_t at = r.find("\"channelsReused\":");
      REQUIRE(at != std::string::npos);
      return std::strtol(r.c_str() + at + 17, nullptr, 10);
    };
    const std::string fast = R"("params":{"rotary":"fast"})", off = R"("params":{"rotary":"off"})";
    Eng sw, ref, keep, same;
    REQUIRE(sw.use(t13::patch({t13::slot("organ", "gospel", 1, fast)})));
    REQUIRE(ref.use(t13::patch({t13::slot("organ", "church", 1)})));  // another preset: a fresh channel at 0.2 s
    REQUIRE(keep.use(t13::patch({t13::slot("organ", "gospel", 1, fast)})));
    REQUIRE(same.use(t13::patch({t13::slot("organ", "gospel", 1, fast)})));
    for (Eng *e : {&sw, &ref, &keep, &same}) e->until(0.2);
    const long r0 = reused(sw), k0 = reused(same);
    REQUIRE(sw.use(t13::patch({t13::slot("organ", "gospel", 1, off)})));
    REQUIRE(ref.use(t13::patch({t13::slot("organ", "gospel", 1, off)})));
    // the stored index of the same value ('fast' = 1, W3B-4) still matches: that switch reuses the channel
    REQUIRE(same.use(t13::patch({t13::slot("organ", "gospel", 1, R"("params":{"rotary":1})")})));
    CHECK(reused(sw) == r0);       // was r0 + 1
    CHECK(reused(same) == k0 + 1);
    for (Eng *e : {&sw, &ref, &keep, &same}) {
      for (int n : {48, 55, 64}) e->on(n, 0.5);
      e->until(1.5);
    }
    CHECK(t13::rms(sw.L, 0.7, 1.5) > 1e-3);
    CHECK(diffIn(sw, ref, 0.7, 1.5) < 1e-5);   // was 0.131 (W3B probe)
    CHECK(diffIn(sw, keep, 0.7, 1.5) > 1e-2);  // 'off' is audibly not 'fast'
    CHECK(diffIn(same, keep, 0, 1.5) == 0);    // reused 'fast' = never switched
  }

  TEST_CASE("T15 review 2: macro.intensity (morph) and slots.<i>.release reach an organ") {
    // fresh channel: the commit's morph (soft-pad is pad-like) = the half-moon switch to fast, as rotary 'fast'
    const std::string full = R"("modWheel":{"target":"macro.intensity","min":1,"max":1})";
    OrganEng m("soft-pad", "", full), f("soft-pad"), r("soft-pad");
    REQUIRE(rigtest::contains(r.e.set("slots.0.params.rotary", R"("fast")", 0), R"("applied":true)"));
    for (OrganEng *o : {&m, &f, &r}) {
      o->chord(0.1);
      o->e.until(2.0);
    }
    CHECK(diffIn(m.e, f.e, 0.5, 2.0) > 1e-2);  // was byte-identical: the morph never reached the organ
    CHECK(diffIn(m.e, r.e, 0, 2.0) < 1e-6);
    // live: the mod wheel routed to macro.intensity (applyWheels)
    // live: the mod wheel (0 before the commit) routed to macro.intensity, moved to 1 at 0.5 s (applyWheels)
    Eng w, n;
    for (Eng *e : {&w, &n}) {
      e->call(R"({"v":1,"id":22,"op":"play","e":"wheel","src":"mod","value":0,"when":0})");
      REQUIRE(e->use(t13::patch({t13::slot("organ", "soft-pad", 1)},
                                e == &w ? R"("modWheel":{"target":"macro.intensity","min":0,"max":1})" : "")));
      for (int k : {48, 55, 64}) e->on(k, 0.1);
      e->until(0.5);
    }
    REQUIRE(diffIn(w, n, 0, 0.5) == 0);
    w.call(R"({"v":1,"id":22,"op":"play","e":"wheel","src":"mod","value":1,"when":0.5})");
    for (Eng *e : {&w, &n}) e->until(2.0);
    CHECK(diffIn(w, n, 1.0, 2.0) > 1e-2);
    // slots.<i>.release set at run time = the same release as built with it (was: the preset's 0.15 s)
    OrganEng s("soft-pad"), b("soft-pad", R"("release":2)"), p("soft-pad");
    REQUIRE(rigtest::contains(s.e.set("slots.0.release", "2", 0.02), R"("applied":true)"));
    for (OrganEng *o : {&s, &b, &p}) {
      o->chord(0.1);
      for (int k : {48, 55, 64}) o->e.off(k, 0.5);
      o->e.until(1.2);
    }
    CHECK(diffIn(s.e, b.e, 0, 1.2) == 0);
    CHECK(t13::rms(s.e.L, 0.9, 1.2) > 10 * t13::rms(p.e.L, 0.9, 1.2));
  }

  TEST_CASE("T15 review 3: drawbar changes are heard (30 ms debounce, live voices re-pointed)") {
    // a burst of drawbar sets before the chord = one rebuild; the chord then plays the new registration exactly
    OrganEng a("soft-pad"), b("soft-pad", R"("params":{"drawbar1":8,"drawbar9":6})"), c("soft-pad");
    a.e.set("slots.0.params.drawbar1", "8", 0.0);
    a.e.set("slots.0.params.drawbar9", "6", 0.012);
    auto *svc = dynamic_cast<rig::inst::T15TablesService *>(a.e.model().service("t15-tables"));
    REQUIRE(svc);
    for (OrganEng *o : {&a, &b, &c}) {
      o->chord(0.3);
      o->e.until(1.0);
    }
    CHECK(svc->drawbarRebuilds() == 1u);
    CHECK(diffIn(a.e, b.e, 0.3, 1.0) == 0);
    CHECK(diffIn(a.e, c.e, 0.3, 1.0) > 1e-2);  // was: stored, never heard
    // a change while the chord holds: the sounding voices switch to the new tables (phase kept)
    OrganEng h("soft-pad"), g("soft-pad", R"("params":{"drawbar1":8})"), k("soft-pad");
    for (OrganEng *o : {&h, &g, &k}) {
      o->chord(0.1);
      o->e.until(0.5);
    }
    h.e.set("slots.0.params.drawbar1", "8", 0.5);
    for (OrganEng *o : {&h, &g, &k}) o->e.until(1.2);
    const double moved = diffIn(h.e, g.e, 0.7, 1.2), stayed = diffIn(k.e, g.e, 0.7, 1.2);
    MESSAGE("held chord after the swap: |h - built with it| " << moved << ", |unchanged - built with it| " << stayed);
    CHECK(stayed > 1e-2);
    CHECK(moved < stayed / 20);
    CHECK(diffIn(h.e, k.e, 0, 0.5) == 0);  // nothing before the change
  }

  TEST_CASE("T15 review 4: a rate change re-attaches the organ horn / synth-extra chorus DelayNodes") {
    const auto &p = rig::inst::organPresetDef(rig::inst::OrganPreset::Gospel);
    auto *o = new rig::inst::OrganInstrument(p, 44100, 1, "inst|0|organ|gospel|1", "", 0);
    t11::Driver d(o, 44100);
    d.noteOn(60, 100, 0.01);
    d.run(44100 / 10);
    CHECK(o->hornDelayRate() == 44100);
    auto send = [&](rig::inst::XTablesPayload *w) {
      rig::Command c{};
      c.op = rig::opOf(rig::inst::T15Op::SetTables);
      c.sub = rig::kSubOwnedPayload;
      c.p.ptr = static_cast<rig::Owned *>(w);
      d.apply(c);
    };
    // drawbars-only payload built for another rate: ignored (the rate change's own payload rebuilds them)
    const rig::wa::PeriodicWave *w0 = o->drawbarWave0();
    double bars[16] = {8, 8, 8, 8, 8, 8, 8, 8, 8};
    auto *wrong = new rig::inst::XTablesPayload();
    rig::inst::drawbarWaves(bars, 48000, wrong->drawbars);
    wrong->sampleRate = 48000;
    send(wrong);
    CHECK(o->drawbarWave0() == w0);
    o->setSampleRate(48000);
    d.sr = 48000;
    d.frame = static_cast<std::int64_t>(std::ceil(double(d.frame) * 48000 / 44100 - 1e-9));
    auto *w = new rig::inst::XTablesPayload();
    w->bank = rig::inst::WaveBank::get(48000, rig::inst::kWaveSine | rig::inst::kWaveBasic);
    w->xbank = rig::inst::XWaveBank::get(48000, false, false);
    rig::inst::drawbarWaves(bars, 48000, w->drawbars);
    w->sampleRate = 48000;
    send(w);
    CHECK(o->hornDelayRate() == 48000);
    const auto out = d.run(48000 / 5);
    CHECK(t11::rms(out[0], 0, out[0].size()) > 1e-3);
    CHECK(d.rtAllocs == 0);

    const rig::inst::XPatchDef *jp = rig::inst::findXPatch("juno-pad");
    REQUIRE(jp != nullptr);
    auto *x = new rig::inst::SynthExtraInstrument(*jp, 44100, 1, "inst|0|synth|juno-pad|1", "{}", 0);
    t11::Driver dx(x, 44100);
    dx.noteOn(60, 100, 0.01);
    dx.run(44100 / 10);
    CHECK(x->chorusDelayRate() == 44100);
    x->setSampleRate(48000);
    dx.sr = 48000;
    auto *xw = new rig::inst::XTablesPayload();
    xw->bank = rig::inst::WaveBank::get(48000, rig::inst::kWaveSaw | rig::inst::kWaveBasic);
    xw->xbank = rig::inst::XWaveBank::get(48000, true, false);
    xw->sampleRate = 48000;
    rig::Command c{};
    c.op = rig::opOf(rig::inst::T15Op::SetTables);
    c.sub = rig::kSubOwnedPayload;
    c.p.ptr = static_cast<rig::Owned *>(xw);
    dx.apply(c);
    CHECK(x->chorusDelayRate() == 48000);
    dx.run(48000 / 10);
    CHECK(dx.rtAllocs == 0);
  }
}

