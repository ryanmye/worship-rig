// T16 drone files mode (suites.mjs droneFiles, droneFilesKeyRace, droneFilesNoHardCut): pad files decoded to the
// engine rate and played from memory, loop region + equal-power loop crossfade, random start from the drone rng.
// WAV pads from test/phase1/engine/fixtures/pads and an MP3 (any app sample) here; AAC / M4A pads need the host
// decoder (Mac list).
#include <cmath>
#include <string>
#include <vector>

#include "drone/drone_service.h"
#include "drone/drone_unit.h"
#include "helpers.h"
#include "test_click_detector.h"
#include "test_drone_util.h"
#include "test_model_util.h"

using namespace t16;

namespace {

const std::string kPads = RIG_REPO_DIR "/test/phase1/engine/fixtures/pads/";

std::string padFiles() {
  return R"([{"name":"Test Pad - C.wav","path":")" + kPads + R"(Test Pad - C.wav"},)"
         R"({"name":"Test Pad - G.wav","path":")" + kPads + R"(Test Pad - G.wav"}])";
}

/** Pool players whose gain is above `thr` and that play a buffer, by file name. */
std::vector<std::string> audible(rig::drone::DroneServiceImpl &s, double thr = 0.01) {
  std::vector<std::string> out;
  auto *u = const_cast<rig::drone::DroneUnit *>(s.unitForTests());
  for (const auto &el : s.core()->pool()) {
    if (!u->padPlaying(el.idx)) continue;
    if (u->param(rig::drone::kParamPadGain0 + el.idx)->intrinsic() > thr) out.push_back(el.name);
  }
  return out;
}

}  // namespace

TEST_SUITE("drone_files") {
  TEST_CASE("droneFiles: a WAV pad loops for 31 s without a gap (loop crossfades), no warnings") {
    t13::Eng e;
    const std::string r = e.call(R"({"v":1,"op":"drone","id":9,"files":)" + padFiles() + "}");
    CHECK(rigtest::contains(r, "\"files\":2"));
    e.msgs.clear();
    droneConfig(e, R"({"mode":"files","gain":1,"fade":2})", 0);
    droneKey(e, 0, false, 0);
    std::string warns;
    for (auto &m : e.msgs) warns += m;
    auto *s = service(e);
    CHECK(s->core()->effectiveMode() == "files");
    const long alloc0 = rigtest::g_rtAllocs;
    e.until(31);
    const std::vector<float> d = mono(e);
    CHECK(t13::minWindowDb(d, 4, 30.9) > -60);
    CHECK(rigtest::clicks(d, t13::kSR, 4, 30.9).empty());
    CHECK_FALSE(rigtest::contains(warns, "failed"));
    CHECK(rigtest::g_rtAllocs == alloc0);
    // the 20 s pad loops [5, 15) with a 3.33 s crossfade: 31 s needs at least 2 more starts than the first one
    unsigned starts = 0;
    for (const auto &el : s->core()->pool()) starts += el.started ? 1 : 0;
    CHECK(s->core()->pool().size() >= 2);
    CHECK(audible(*s).size() == 1);
    // files mode sends nothing to the reverb: the drone's send gate ramps to 0
    auto *u = const_cast<rig::drone::DroneUnit *>(s->unitForTests());
    CHECK(u->param(rig::kDroneSendGate)->intrinsic() < 1e-6);
    (void)starts;
  }

  TEST_CASE("droneFilesKeyRace: C -> G -> C within 5 ms leaves exactly the C pad audible") {
    t13::Eng e;
    e.call(R"({"v":1,"op":"drone","id":9,"files":)" + padFiles() + "}");
    droneConfig(e, R"({"mode":"files","fade":1})", 0);
    droneKey(e, 0, false, 0);
    e.until(2.5);
    droneKey(e, 7, false, 2.5);
    e.until(2.505);
    droneKey(e, 0, false, 2.505);
    e.until(5.6);
    auto *s = service(e);
    const auto a = audible(*s);
    REQUIRE(a.size() == 1);
    CHECK(rigtest::contains(a[0], "- C."));
  }

  TEST_CASE("droneFilesNoHardCut: key changes while the pool is busy never hard-cut an audible element") {
    t13::Eng e;
    e.call(R"({"v":1,"op":"drone","id":9,"files":)" + padFiles() + "}");
    droneConfig(e, R"({"mode":"files","fade":4})", 0);
    droneKey(e, 0, false, 0);
    e.until(2.5);
    double t = 2.5;
    for (int k : {7, 0, 7, 0, 7}) {
      droneKey(e, k, false, t);
      e.until(t += 0.7);
    }
    e.until(t + 5);
    auto *s = service(e);
    CHECK(s->core()->hardCuts() == 0);
    CHECK(s->core()->pool().size() <= rig::drone::kMaxPads);
    const auto a = audible(*s);
    REQUIRE(a.size() == 1);
    CHECK(rigtest::contains(a[0], "- G."));
    const std::vector<float> d = mono(e);
    CHECK(rigtest::clicks(d, t13::kSR, 2.6, t + 5).empty());
  }

  TEST_CASE("MP3 pad, minor key on its relative-major file, and the synth fallback when the file is missing") {
    t13::Eng e;
    const std::string mp3 = RIG_REPO_DIR "/app/samples/ep-rhodes/C4.mp3";  // any MP3 decodes the same way
    e.call(R"({"v":1,"op":"drone","id":9,"files":[{"name":"Pad - C.mp3","path":")" + mp3 +
           R"("},{"name":"Pad - D.wav","path":"/nonexistent/D.wav"}]})");
    droneConfig(e, R"({"mode":"files","gain":1,"fade":0.5})", 0);
    droneKey(e, 9, true, 0);  // A minor -> relative major C
    e.until(2);
    auto *s = service(e);
    CHECK(s->core()->effectiveMode() == "files");
    const std::vector<float> d = mono(e);
    CHECK(t13::rms(d, 1, 2) > 1e-3);
    e.msgs.clear();
    droneKey(e, 2, false, 2);  // D: the file does not exist -> warned once, silence (as a failed <audio>)
    e.until(3);
    std::string w;
    for (auto &m : e.msgs) w += m;
    CHECK(rigtest::contains(w, "Pad file failed to load: Pad - D.wav"));
  }
}
