// T14 W3A unit.perform_carry: the wave-2 carry-overs T14 took over, through the bridge on an offline engine.
//   T00c O2  rig_meters.slot_count is set by Model::commit (any commit, not only the bridge's)
//   T13 O2   an instrument param is stored at call time (the coalesced flush only sends)
//   T13 O3   a reused channel re-sends cfg.params keys that have no catalogue meta (`user:` samplers)
//   T13 O4   a note-off posted between a commit call and its future `when` releases at its own time
//   T07 O7   the MIDI direct path and the app's `play` notes share one refcount per pitch (controller.js heldCount)
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <unistd.h>
#include <vector>

#include "model/perform.h"
#include "model/song.h"
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

std::string probe(const std::string &extra = "") {
  return slot("t14probe", "p", 1, extra);
}

}  // namespace

TEST_SUITE("perform_carry") {
  TEST_CASE("T00c O2: Model::commit (not only the bridge's opCommit) sets rig_meters.slot_count") {
    Eng e;
    std::vector<std::string> six(6, slot("test", "sine", 1));
    const long tok = e.prepare(patch(six, R"("slotCount":6)"));
    REQUIRE(tok > 0);
    REQUIRE(e.model().commit(static_cast<std::uint32_t>(tok), -1));  // straight to the Model, no bridge
    e.until(0.05);
    CHECK(e.meters().slot_count == static_cast<std::uint32_t>(e.model().patch().slotCount));
    CHECK(e.meters().slot_count >= 6);
    REQUIRE(e.use(patch({slot("test", "sine", 1)})));  // and through the bridge as before
    e.until(0.1);
    CHECK(e.meters().slot_count == static_cast<std::uint32_t>(e.model().patch().slotCount));
  }

  TEST_CASE("T13 O2: slots.<i>.params.<key> is in the patch at call time; the instrument gets it at the flush") {
    Eng e;
    REQUIRE(e.use(patch({slot("synth", "sub-bass", 1)})));
    e.until(0.02);
    e.set("slots.0.params.cutoff", "400", 0.05);
    // stored now (JS _setSlotParam: cfg.params[key] = v, then the coalesced instrument call), clamped to the meta
    CHECK(rigtest::contains(e.model().patch().slots[0].paramsJson, "\"cutoff\":400"));
    e.set("slots.0.params.cutoff", "5000", 0.05);  // above max 1000
    CHECK(rigtest::contains(e.model().patch().slots[0].paramsJson, "\"cutoff\":1000"));
    // a prepare inside the 10 ms window sees the new value: same params -> the channel is reused, not rebuilt
    const std::uint32_t before = e.model().instSeq();
    REQUIRE(e.use(patch({slot("synth", "sub-bass", 1, R"("params":{"cutoff":1000})")})));
    CHECK(e.model().instSeq() == before);
  }

  TEST_CASE("T13 O3: a reused `user:` sampler gets the new song's params that differ from the playing ones") {
    // test-keys C4: a 2.4 s sine at -6 dB/s, claimed as G6 (91) so it plays at rate 1 (suites.mjs undampedOptIn)
    const std::string url = std::string(RIG_REPO_DIR) + "/test/phase1/engine/fixtures/test-keys/soft/C4.wav";
    const auto dir = std::filesystem::temp_directory_path() / ("rig-w3a-o3-" + std::to_string(::getpid()));
    std::filesystem::create_directories(dir / "samples");
    std::ofstream(dir / "samples" / "manifest.json") << R"({"instruments":[]})";
    std::ofstream(dir / "user.json") << R"({"instruments":[{"id":"keys","name":"keys","ext":"wav","release":0.12,)"
                                        R"("category":"strings","layers":[{"vel":[0,127],"files":{"G6":")" +
                                            url + R"("}}]}]})";
    auto run = [&](bool setBetween) {
      rig_config cfg;
      rig_config_init(&cfg);
      cfg.mode = RIG_MODE_OFFLINE;
      cfg.flags = RIG_FLAG_TEST_API;
      cfg.sample_rate = kSR;
      const std::string app = dir.string(), user = (dir / "user.json").string();
      cfg.app_dir = app.c_str();
      cfg.user_manifest = user.c_str();
      rig_engine *e = rig_create(&cfg, nullptr);
      REQUIRE(e);
      auto post = [&](const std::string &m) { rig_post(e, m.data(), m.size()); };
      post(R"({"v":1,"op":"hello","protocol":1,"id":1})");
      post(R"({"v":1,"op":"audio","action":"start","id":2})");
      REQUIRE(rig_test_tap(e, "slot0.pan") == RIG_OK);
      const std::string song = R"({"slots":[{"instrument":{"type":"sampler","id":"user:keys"},"gain":1,)"
                               R"("params":{"release":0.2}},null,null,null]})";
      post(R"({"v":1,"op":"prepare","id":3,"patch":)" + song + "}");
      post(R"({"v":1,"op":"commit","id":4,"token":1})");
      post(R"({"v":1,"op":"prepare","id":5,"patch":)" + song + "}");  // same params: the channel is reused
      if (setBetween)  // the playing song's release moves to 3 s before the reused commit
        post(R"({"v":1,"op":"set","id":6,"path":"slots.0.params.release","value":3})");
      std::vector<float> l(4410), r(4410);
      float *p[2] = {l.data(), r.data()};
      rig_offline_render(e, p, 2, 2205);  // the set's 10 ms flush
      post(R"({"v":1,"op":"commit","id":7,"token":2,"when":0.1})");
      post(R"({"v":1,"op":"play","e":"on","n":91,"vel":100,"when":0.15})");
      post(R"({"v":1,"op":"play","e":"off","n":91,"when":0.6})");
      std::vector<float> out;
      for (int k = 0; k < 30; ++k) {
        rig_offline_render(e, p, 2, 4410);
        out.insert(out.end(), l.begin(), l.end());
      }
      rig_destroy(e);
      // level 0.4 s after the note-off against the held level (out starts at 0.05 s)
      return t13::db(t13::rms(out, 0.95, 1.05)) - t13::db(t13::rms(out, 0.4, 0.5));
    };
    const double plain = run(false), afterSet = run(true);
    std::error_code ec;
    std::filesystem::remove_all(dir, ec);
    MESSAGE("decay 0.4 s after note-off: plain release 0.2 " << plain << " dB, after a set of 3 s + reuse "
                                                             << afterSet << " dB");
    CHECK(plain < -30);
    CHECK(std::fabs(afterSet - plain) < 1.5);  // the reused channel plays the new song's release again
  }

  TEST_CASE("T13 O4: a note-off posted between a commit call and its later `when` releases at its own frame") {
    Eng e;
    REQUIRE(e.use(patch({probe()})));
    e.on(60, 0.05);
    e.until(0.1);
    t14::clear();
    const long tok = e.prepare(patch({slot("t14probe", "q", 1)}));  // another id: the old channel retires
    REQUIRE(e.commit(tok, 0.5));                                   // the move to RetireInst happens at 0.5 s
    e.off(60, 0.3);  // posted after the commit call, before its `when`
    e.until(0.7);
    const auto f = t14::callsOf('F', 0);
    REQUIRE(f.size() == 1);
    CHECK(f[0].note == 60);
    CHECK(f[0].frame == fr(0.3));  // was: held by the command gate until the move frame (0.5 s)
    // a note-off after the move frame takes the normal path (the retiring unit)
    e.on(62, 0.8);
    e.until(0.9);
    t14::clear();
    const long tok2 = e.prepare(patch({probe()}));
    REQUIRE(e.commit(tok2, 1.0));
    e.off(62, 1.2);
    e.until(1.3);
    const auto f2 = t14::callsOf('F');
    REQUIRE(f2.size() == 1);
    CHECK(f2[0].frame == fr(1.2));
  }

  TEST_CASE("T07 O7: the MIDI direct path and `play` share one count per pitch (no double note-on, no early off)") {
    Eng e;
    REQUIRE(e.use(patch({probe()})));
    e.until(0.02);
    rig::Model &m = e.model();
    const std::string ports = R"([{"id":"k1","name":"Keys","state":"connected","kind":"input"}])";
    REQUIRE(rig_host_midi_ports(e.e, ports.data(), ports.size()) == RIG_OK);
    REQUIRE(rigtest::contains(e.call(R"({"v":1,"op":"midi","id":5,"action":"route","on":true})"), "\"on\":true"));
    t14::clear();
    const std::uint8_t on60[] = {0x90, 60, 90}, off60[] = {0x80, 60, 0};
    m.midiBytes(0, on60, sizeof on60, 0);  // MIDI first
    e.on(60, -1);                           // then the app (UI / computer keyboard): joins, no second note-on
    m.midiBytes(0, off60, sizeof off60, 0);  // MIDI lets go: the app still holds it
    e.until(0.1);
    CHECK(t14::callsOf('N').size() == 1);
    CHECK(t14::callsOf('F').empty());
    CHECK(m.perform().held().count(60) == 1);
    e.off(60, -1);  // the last holder
    e.until(0.15);
    CHECK(t14::callsOf('F').size() == 1);
    CHECK(m.perform().held().empty());
    // app first, then MIDI: the same
    t14::clear();
    e.on(64, -1);
    const std::uint8_t on64[] = {0x90, 64, 90}, off64[] = {0x80, 64, 0};
    m.midiBytes(0, on64, sizeof on64, 0);
    e.off(64, -1);
    e.until(0.2);
    CHECK(t14::callsOf('N').size() == 1);
    CHECK(t14::callsOf('F').empty());
    m.midiBytes(0, off64, sizeof off64, 0);
    e.until(0.25);
    CHECK(t14::callsOf('F').size() == 1);
    // one path alone keeps its old behaviour: a repeated app note-on is a re-strike (off + on)
    t14::clear();
    e.on(67, -1);
    e.on(67, -1);
    e.off(67, -1);
    e.until(0.3);
    CHECK(t14::callsOf('N').size() == 2);
    CHECK(t14::callsOf('F').size() == 2);
  }
}
