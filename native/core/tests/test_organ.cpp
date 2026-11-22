// T15: organ.js (kind inst.organ). Golden fixtures at the exact tier (the four presets, pan-mono-src and T13's organ
// automation originals), the preset tables against the engine-api.json catalogue (bool / enum rows included), the
// registry kind, and the voice bookkeeping with the allocation trap on.
#include <memory>
#include <string>

#include "api/registry.h"
#include "inst/organ.h"
#include "model/patch.h"
#include "test_synth_extra_util.h"
#include "test_synth_util.h"

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
}
