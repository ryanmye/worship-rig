// MACFIX: module registration reaches every consumer through rig_create alone. Mac check #3 (b9a0c27, Apple clang 21)
// failed unit.synth and unit.synth-extra because the synth-extra hook was read before any engine existed (the golden
// test cases that normally create one first skip without native/golden/out), not because a linker dropped a
// registration: api/registry.cpp's ensureModulesRegistered() names every rig_register_* function, and rig_create calls
// it. This suite is its own ctest process (unit.registry-link) and needs no golden file, so it fails when rig_create
// stops registering the modules, or when a module (T15's synth-extra hook, the organ, the services) is left out of the
// registration, whatever the other suites or the link order do.
#include <cmath>
#include <cstdlib>
#include <string>

#include "api/registry.h"
#include "click/click.h"
#include "drone/drone.h"
#include "fx/chorus.h"
#include "fx/delay.h"
#include "fx/lofi.h"
#include "fx/reverb.h"
#include "helpers.h"
#include "inst/organ.h"
#include "inst/sampler.h"
#include "inst/sampler_service.h"
#include "inst/synth.h"
#include "inst/synth_dispatch.h"
#include "inst/synth_extra_tables.h"
#include "meter/meter.h"
#include "mix/master_chain.h"
#include "mix/slot_channel.h"
#include "mix/slot_channel_api.h"
#include "model/services.h"
#include "rec/rec.h"

namespace {

/** Commit `instrument` in slot 0 through the bridge only (what the Apple shell and rig-devhost do). */
std::string commitSlot0(rigtest::OfflineEngine &e, const std::string &instrument) {
  const std::string r = e.call(R"({"v":1,"op":"prepare","id":5,"patch":{"slots":[{"instrument":)" + instrument +
                               R"(,"gain":1},null,null,null]}})");
  const std::size_t p = r.find("\"token\":");
  REQUIRE(p != std::string::npos);
  const long tok = std::strtol(r.c_str() + p + 8, nullptr, 10);
  return e.call(R"({"v":1,"op":"commit","id":6,"when":0,"token":)" + std::to_string(tok) + "}");
}

double rms(const std::vector<float> &x, std::size_t from, std::size_t to) {
  double s = 0;
  for (std::size_t i = from; i < to; ++i) s += double(x[i]) * x[i];
  return std::sqrt(s / double(to - from));
}

}  // namespace

TEST_SUITE("registry-link") {
  TEST_CASE("every synth-extra id and the organ sound through rig_create + the bridge alone") {
    // no direct factory or hook call before the engines: the registration has to come from rig_create
    struct Case {
      const char *type, *id;
    };
    std::vector<Case> cases;
    for (const char *id : rig::inst::kSynthExtraIds) cases.push_back({"synth", id});
    cases.push_back({"synth", "warm-pad"});
    cases.push_back({"organ", "organ-gospel"});
    for (const Case &c : cases) {
      CAPTURE(c.id);
      rigtest::OfflineEngine e(44100);
      e.hello();
      e.call(R"({"v":1,"op":"audio","action":"start","id":3})");
      const std::string r =
          commitSlot0(e, std::string(R"({"type":")") + c.type + R"(","id":")" + c.id + R"("})");
      CHECK_FALSE(rigtest::contains(r, "unsupported"));
      CHECK_FALSE(rigtest::contains(r, "not available"));
      e.call(R"({"v":1,"op":"play","id":7,"e":"on","n":60,"vel":100})");
      const auto out = e.render(22050);
      CHECK(rms(out[0], 2205, 22050) > 1e-4);  // pluck / 808-sub decay: the first half second is enough
    }
    CHECK(rig::inst::synthExtraFactory() != nullptr);
  }

  TEST_CASE("after rig_create the registry holds every unit kind, service and set handler of the core") {
    { rigtest::OfflineEngine e(48000); }
    const rig::Registry &reg = rig::Registry::global();
    for (const char *kind : {rig::inst::kKindSynth, rig::inst::kKindOrgan, rig::kKindSampler, rig::kKindDrone,
                             rig::kKindClick, rig::kKindReverb, rig::kKindDelay, rig::kKindChorus, rig::kKindLofi,
                             rig::kKindMaster, rig::kKindStrip, rig::kKindMeter, rig::kKindRec}) {
      CAPTURE(kind);
      CHECK(reg.unit(kind) != nullptr);
    }
    for (const char *svc : {rig::CacheService::kName, rig::InstrumentService::kName, rig::ReverbService::kName,
                            rig::ClickService::kName, rig::MidiService::kName, rig::DroneService::kName,
                            rig::MeterService::kName, rig::RecService::kName, rig::SamplerService::kName,
                            rig::inst::T15TablesService::kName, rig::StripService::kName, "master", "delay",
                            "lofi", "chorus"}) {
      CAPTURE(svc);
      CHECK(reg.service(svc) != nullptr);
    }
    for (const char *row : {"drone.volume", "fx.reverb.size", "fx.delay.time", "fx.chorus.rate", "fx.lofi.amount",
                            "fx.eq.low", "fx.comp.amount", "master.volume", "slots.<i>.params.cutoff",
                            "slots.<i>.eq.low", "slots.<i>.sends.reverb"}) {
      CAPTURE(row);
      CHECK(reg.setHandler(row) != nullptr);
    }
    CHECK(rig::inst::synthExtraFactory() != nullptr);
  }
}
