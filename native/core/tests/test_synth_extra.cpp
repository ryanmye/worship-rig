// T15: synth-extra.js through the inst.synth dispatch hook. Golden fixtures at the exact tier (max |diff| <= 2e-4;
// synth-dx-epiano at its manifest statistical tier, Q11), the patch tables against the engine-api.json catalogue,
// the D1 cap / O-W3-1 fadeNote / kill / legato bookkeeping with the allocation trap on, and T11 O2: wa::Oscillator
// makes Chromium's three FinalValue() calls per quantum itself.
#include <cmath>
#include <memory>
#include <string>

#include "dsp/oscillator.h"
#include "dsp/periodic_wave.h"
#include "inst/synth.h"
#include "inst/synth_dispatch.h"
#include "inst/synth_extra.h"
#include "model/patch.h"
#include "test_synth_extra_util.h"
#include "test_synth_util.h"

namespace {

rig::inst::SynthExtraInstrument *makeX(const char *id, double sr = 48000, const char *params = "{}") {
  const rig::inst::XPatchDef *p = rig::inst::findXPatch(id);
  REQUIRE(p != nullptr);
  return new rig::inst::SynthExtraInstrument(*p, sr, 1, std::string("inst|0|synth|") + id + "|1", params, 0);
}

}  // namespace

TEST_SUITE("synth-extra") {
  TEST_CASE("golden fixtures at the exact tier (dx-epiano: statistical, Q11)") {
    for (const char *id : {"synth-808-sub", "synth-pluck", "synth-synth-bass", "synth-poly-stab", "synth-analog-brass",
                           "synth-square-lead", "synth-juno-pad", "synth-supersaw-pad", "synth-shimmer-pad",
                           "auto-delay-send"}) {
      CAPTURE(id);
      const t15::GoldenResult g = t15::goldenRun(id);
      if (!g.present) continue;
      CHECK(g.peak > 0.01);  // none of these goldens is silence
      CHECK(g.maxDiff <= 2e-4);
      CHECK(g.rtAllocs == 0);
    }
    const t15::GoldenResult dx = t15::goldenRun("synth-dx-epiano");
    if (dx.present) {
      CHECK(dx.peak > 0.01);
      CHECK(dx.rtAllocs == 0);  // its bands / envelope tier is checked by golden.t15 (compare.mjs)
    }
  }

  TEST_CASE("patch tables = engine-api.json catalogue (order, keys, labels, ranges, defaults, trims)") {
    const t15::Doc api{t15::readFile(std::string(RIG_REPO_DIR) + "/native/contract/engine-api.json")};
    REQUIRE(api.d);
    for (std::size_t k = 0; k < rig::inst::kXPatchCount; ++k) {
      const auto &p = rig::inst::xpatchDef(static_cast<rig::inst::XPatch>(k));
      CAPTURE(p.idStr);
      CHECK(rig::inst::isSynthExtraId(p.idStr));
      yyjson_val *e = t15::catalogueEntry(api, "synth", p.idStr);
      REQUIRE(e);
      CHECK(std::string(yyjson_get_str(yyjson_obj_get(e, "name"))) == p.name);
      CHECK(std::string(yyjson_get_str(yyjson_obj_get(e, "group"))) == p.group);
      CHECK(yyjson_get_num(yyjson_obj_get(e, "gainTrimDb")) == doctest::Approx(p.trimDb));
      yyjson_val *params = yyjson_obj_get(e, "params");
      REQUIRE(yyjson_arr_size(params) == p.nParams);
      for (std::size_t j = 0; j < p.nParams; ++j) {
        yyjson_val *q = yyjson_arr_get(params, j);
        const auto &d = p.params[j];
        CAPTURE(d.key);
        CHECK(std::string(yyjson_get_str(yyjson_obj_get(q, "key"))) == d.key);
        CHECK(std::string(yyjson_get_str(yyjson_obj_get(q, "label"))) == d.label);
        CHECK(yyjson_get_num(yyjson_obj_get(q, "min")) == d.min);
        CHECK(yyjson_get_num(yyjson_obj_get(q, "max")) == d.max);
        CHECK(yyjson_get_num(yyjson_obj_get(q, "default")) == d.def);
        CHECK(std::string(yyjson_get_str(yyjson_obj_get(q, "unit"))) == d.unit);
        CHECK(std::string(yyjson_get_str(yyjson_obj_get(q, "curve"))) == d.curve);
        CHECK(rig::inst::xParamIndex(p, d.key) == static_cast<int>(j));
      }
    }
  }

  TEST_CASE("inst.synth dispatch builds synth-extra units; unknown ids stay null") {
    rig::PatchSpec ps;
    ps.slots[0].present = true;
    ps.slots[0].instType = "synth";
    ps.slots[0].instId = "808-sub";
    rig::UnitEnv env;
    rig::UnitSpec spec;
    spec.patch = &ps;
    spec.channel = 0;
    REQUIRE(rig::inst::synthExtraFactory() != nullptr);
    std::unique_ptr<rig::Unit> u(rig::inst::makeSynth(env, spec));
    REQUIRE(u);
    CHECK(dynamic_cast<rig::inst::SynthExtraInstrument *>(u.get()) != nullptr);
    ps.slots[0].instId = "no-such-patch";
    std::unique_ptr<rig::Unit> none(rig::inst::makeSynth(env, spec));
    CHECK(none == nullptr);
  }

  TEST_CASE("voice cap, steal, fadeNote, legato, kill: bookkeeping without allocation") {
    auto *inst = makeX("pluck");
    t11::Driver d(inst, 48000);
    rig::Command cap{};
    cap.op = rig::Op::VoiceCap;
    cap.aux = 4;
    d.apply(cap);
    for (int i = 0; i < 6; ++i) d.noteOn(48 + 2 * i, 100, 0.01 + 0.01 * i);
    d.run(48000 / 10);
    CHECK(inst->playingVoices() == 4);
    CHECK(inst->steals() == 2);
    rig::Command fade{};
    fade.op = rig::Op::FadeNote;
    fade.frame = d.frame;
    fade.aux = 58;
    fade.f.a = 0.02;
    d.apply(fade);
    CHECK(inst->playingVoices() == 3);
    rig::Command lg{};
    lg.op = rig::Op::LegatoTo;
    lg.frame = d.frame;
    lg.aux = 56u | (60u << 8);
    d.apply(lg);
    d.noteOff(60, double(d.frame) / 48000);
    d.run(48000 / 2);
    rig::Command panic{};
    panic.op = rig::Op::Panic;
    d.apply(panic);
    d.run(rig::kQ);
    CHECK(inst->liveVoices() == 0);
    CHECK(d.count(rig::EventKind::VoiceEnded) == 6);
    CHECK(d.rtAllocs == 0);
    CHECK(inst->pendingEndedDrops() == 0);
  }

  TEST_CASE("every patch renders sound at 44.1 / 48 / 96 kHz without allocating") {
    for (double sr : {44100.0, 48000.0, 96000.0}) {
      for (std::size_t k = 0; k < rig::inst::kXPatchCount; ++k) {
        const auto &p = rig::inst::xpatchDef(static_cast<rig::inst::XPatch>(k));
        CAPTURE(p.idStr);
        CAPTURE(sr);
        auto *inst = makeX(p.idStr, sr);
        t11::Driver d(inst, sr);
        d.noteOn(36, 110, 0.01);  // the lowest PWM note (largest delay buffer) included
        d.noteOn(60, 100, 0.01);
        const auto out = d.run(static_cast<std::size_t>(sr * 0.4));
        CHECK(t11::rms(out[0], out[0].size() / 2, out[0].size()) > 1e-3);
        CHECK(inst->outputChannels() == 2u);
        CHECK(d.rtAllocs == 0);
      }
    }
  }

  TEST_CASE("rate change: T15Op::SetTables re-points the oscillators to the new rate's tables (pitch kept)") {
    for (bool swap : {false, true}) {
      auto *inst = makeX("808-sub", 44100, R"({"pitchDrop":0})");
      t11::Driver d(inst, 44100);
      d.noteOn(57, 100, 0.01);
      d.run(44100 / 5);
      inst->setSampleRate(48000);
      d.sr = 48000;
      d.frame = static_cast<std::int64_t>(std::ceil(double(d.frame) * 48000 / 44100 - 1e-9));
      if (swap) {
        auto *w = new rig::inst::XTablesPayload();
        w->bank = rig::inst::WaveBank::get(48000, rig::inst::kWaveSaw | rig::inst::kWaveBasic);
        w->xbank = rig::inst::XWaveBank::get(48000, true, false);
        rig::Command c{};
        c.op = rig::opOf(rig::inst::T15Op::SetTables);
        c.sub = rig::kSubOwnedPayload;
        c.p.ptr = static_cast<rig::Owned *>(w);
        d.apply(c);
      }
      const auto out = d.run(48000 / 5);
      const double hz = t11::zeroCrossHz(out[0], 960, out[0].size(), 48000);
      CAPTURE(swap);
      if (swap) CHECK(hz == doctest::Approx(220).epsilon(0.002));
      else CHECK(hz == doctest::Approx(220 * 48000.0 / 44100).epsilon(0.002));  // old tables: x new / old
      CHECK(d.count(rig::EventKind::Garbage) == (swap ? 1u : 0u));
      CHECK(d.rtAllocs == 0);
    }
  }

  TEST_CASE("T11 O2: wa::Oscillator evaluates frequency / detune FinalValue three times per k-rate quantum") {
    CHECK(rig::inst::oscFinalValueCalls() == rig::inst::kChromiumOscFinalValueCalls);
    std::unique_ptr<rig::wa::PeriodicWave> w(rig::wa::PeriodicWave::basic(rig::wa::PeriodicWave::Basic::Sine, 48000));
    rig::wa::Oscillator o(w.get(), 220, 0);
    o.setDetuneRate(rig::wa::Param::Rate::KRate);
    o.detune().setTargetAtTime(700, 0, 0.05);
    o.frequency().setTargetAtTime(440, 0, 0.05);  // a-rate with automation: sample accurate, no FinalValue
    o.start(0);
    rig::wa::Param ref(0);
    ref.setTargetAtTime(700, 0, 0.05);
    float buf[128];
    for (std::int64_t f = 0; f < 4 * 128; f += 128) o.process(f, 48000, buf, 128);
    for (std::int64_t f = 0; f < 4 * 128; f += 128) ref.processKRate(f, 48000);
    CHECK(o.detune().intrinsic() == ref.intrinsic());  // detune once per quantum: frequency is sample accurate
    rig::wa::Oscillator k(w.get(), 220, 0);
    k.setDetuneRate(rig::wa::Param::Rate::KRate);
    k.detune().setTargetAtTime(700, 0, 0.05);
    k.start(0);
    rig::wa::Param ref3(0);
    ref3.setTargetAtTime(700, 0, 0.05);
    for (std::int64_t f = 0; f < 4 * 128; f += 128) {
      k.process(f, 48000, buf, 128);
      for (int j = 0; j < 3; ++j) ref3.processKRate(f, 48000);
    }
    CHECK(k.detune().intrinsic() == ref3.intrinsic());  // three per quantum on the k-rate path
  }
}
