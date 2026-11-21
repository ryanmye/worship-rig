// T13 Model: the JS engine suites of the song / graph half ported (test/phase1/engine/suites.mjs: supersededPrepare,
// gaplessSwitch, paramResetOnReuse, freshStripWheel, switchHeadroom, washAcrossCommit, morphAtCommit,
// beforeStartNoThrow, lowResource, restartKeepsState). The web suites use the test sampler fixtures; these use the
// synth.js instruments (T11) and the test voice, which the native core has today. What a port cannot check yet is
// said per case (and in the T13 report).
#include <algorithm>
#include <string>

#include "fx/reverb_service.h"
#include "samples/cache_service.h"
#include "test_click_detector.h"
#include "test_model_util.h"
#include "yyjson.h"

using rigtest::contains;
using t13::Eng;
using t13::patch;
using t13::slot;

TEST_SUITE("model") {
  TEST_CASE("supersededPrepare: only the latest token commits; the superseded plan's units are discarded") {
    Eng e;
    const long t1 = e.prepare(patch({slot("synth", "bell")}));
    const long t2 = e.prepare(patch({slot("synth", "soft-keys")}));
    REQUIRE(t1 > 0);
    REQUIRE(t2 > t1);
    CHECK(e.sg().counters().discarded == 1);
    CHECK_FALSE(e.commit(t1));
    CHECK(e.commit(t2));
    CHECK_FALSE(e.commit(t2));  // already committed
    REQUIRE(e.sg().liveChannel(0));
    CHECK(e.sg().liveChannel(0)->cfg.instId == "soft-keys");
    CHECK(e.sg().counters().built == 2);  // both were built (prepare builds), one was discarded
    e.until(0.5);
  }

  TEST_CASE("gaplessSwitch: held notes keep sounding on the retired channel, new notes go to the new song") {
    Eng e;
    const std::string sends = R"("sends":{"reverb":0.5,"delay":0.15,"chorus":0.4})";
    const std::string A = patch({"null", slot("synth", "warm-pad", 1, sends)},
                                R"("fx":{"reverb":{"size":0.5}})");
    const std::string B = patch({slot("test", "sine", 0.8), slot("synth", "bell")}, R"("fx":{"reverb":{"size":0.3}})");
    REQUIRE(e.use(A, 0));
    for (int n : {60, 64, 67}) e.on(n, 0.1);
    const std::uint32_t oldId = e.sg().liveChannel(1)->id;
    const long tok = e.prepare(B);
    CHECK(e.commit(tok, 1.5));
    CHECK_FALSE(e.commit(tok, 1.6));  // double commit refused
    e.on(72, 2.0);
    e.off(72, 2.3);
    for (int n : {60, 64, 67}) e.off(n, 3.0);
    // the old pad sits in a retiring channel at once (the Model's view), the new bell in slot 1
    CHECK(e.sg().instUnitOf(oldId) != rig::UnitSlot::Count);
    CHECK(rig::isRetireInstSlot(e.sg().instUnitOf(oldId)));
    CHECK(e.sg().liveChannel(1)->cfg.instId == "bell");
    e.until(2.1);
    int j = -1;
    for (int k = 0; k < static_cast<int>(rig::kRetiring); ++k)
      if (e.sg().retiring(k).live && e.sg().retiring(k).id == oldId) j = k;
    REQUIRE(j >= 0);
    CHECK(e.sg().retiring(j).shell->publishedVoices() == 3);  // 60 64 67 held there; 72 did not go there
    CHECK(e.sg().liveChannel(1)->shell->publishedVoices() == 1);
    CHECK(e.meters().slot_retiring[1] == 1);  // T08 #1: the retiring strip still meters slot 1
    e.until(9.0);
    const std::vector<float> &d = e.L;
    const double w = t13::minWindowDb(d, 0.6, 3.0);
    // the same pad without the switch: the switch must add no click (the native pad is the real synth.js warm-pad,
    // the JS suite's is the fallback preset, so its own transients are compared, not assumed away)
    Eng ref;
    REQUIRE(ref.use(A, 0));
    for (int n : {60, 64, 67}) ref.on(n, 0.1);
    ref.until(2.0);
    const auto cl = rigtest::clicks(d, t13::kSR, 1.3, 2.0), base = rigtest::clicks(ref.L, t13::kSR, 1.3, 2.0);
    std::size_t extra = 0;
    for (const auto &c : cl)
      extra += std::none_of(base.begin(), base.end(), [&](const auto &b) { return std::fabs(b.t - c.t) < 0.003; });
    INFO("min window " << w << " dB, clicks " << cl.size() << " (without the switch " << base.size() << ")");
    CHECK(w > -60);
    CHECK(extra == 0);
    CHECK(e.sg().retiringCount() == 0);  // released, silent for 1 s, disposed
    CHECK(e.sg().counters().disposed == 1);
    CHECK(rigtest::contains(e.call(R"({"v":1,"op":"get","what":"stats","id":9})"), "\"retiring\":0"));
  }

  TEST_CASE("paramResetOnReuse: reuse needs equal effective params; a reused instrument gets the song's values") {
    Eng e;
    REQUIRE(e.use(patch({slot("synth", "warm-pad", 1, R"("params":{"attack":7.2})")})));
    const std::uint32_t a = e.sg().liveChannel(0)->id;
    REQUIRE(e.use(patch({slot("synth", "warm-pad")})));  // no params: attack 7.2 != default -> fresh
    const std::uint32_t b = e.sg().liveChannel(0)->id;
    CHECK(a != b);
    REQUIRE(e.use(patch({slot("synth", "warm-pad", 1, R"("params":{"attack":1.2})")})));  // = the default: kept
    CHECK(e.sg().liveChannel(0)->id == b);
    // a live edit between prepare (reuse planned) and commit is reset to the song's value at commit
    const long tok = e.prepare(patch({slot("synth", "warm-pad")}));
    CHECK(contains(e.set("slots.0.params.attack", "5"), "\"applied\":true"));
    CHECK(contains(e.model().patch().slots[0].paramsJson, "\"attack\":5"));
    REQUIRE(e.commit(tok));
    CHECK(e.sg().liveChannel(0)->id == b);
    CHECK(!contains(e.model().patch().slots[0].paramsJson, "attack"));  // reported: the song's (default) value
    // audible: the reused pad attacks like a fresh default pad (1.2 s), not like the edited 5 s one
    e.on(60, 0.05);
    e.until(1.0);
    Eng ref;
    REQUIRE(ref.use(patch({slot("synth", "warm-pad")})));
    ref.on(60, 0.05);
    ref.until(1.0);
    Eng slow;
    REQUIRE(slow.use(patch({slot("synth", "warm-pad", 1, R"("params":{"attack":5})")})));
    slow.on(60, 0.05);
    slow.until(1.0);
    const double got = t13::db(t13::rms(e.L, 0.4, 1.0)), want = t13::db(t13::rms(ref.L, 0.4, 1.0)),
                 edited = t13::db(t13::rms(slow.L, 0.4, 1.0));
    INFO("reused " << got << " dB, fresh default " << want << " dB, attack 5 " << edited << " dB");
    CHECK(std::fabs(got - want) < 3);  // another instSeq = other random draws (detune, phases): not bit-equal
    CHECK(want - edited > 6);
  }

  TEST_CASE("freshStripWheel: a fresh strip starts at the current wheel factor (wheel 0: a silent first note)") {
    Eng e;
    const std::string routing = R"("modWheel":{"target":"slots.0.gain","min":0,"max":1})";
    REQUIRE(e.use(patch({slot("synth", "bell")}, routing), 0));
    e.sg().wheel().mod = 0;  // T14's setWheel('mod', 0) writes this
    const long tok = e.prepare(patch({slot("synth", "soft-keys")}, routing));
    REQUIRE(e.commit(tok, 1.0));
    e.on(72, 1.0, 110);
    e.until(1.2);
    const double first100 = t13::db(t13::rms(e.L, 1.0, 1.1));
    INFO("first 100 ms " << first100 << " dB");
    CHECK(first100 < -90);
    CHECK(e.sg().liveChannel(0)->wheel == 0.0);
    // without the routing the same switch is loud (the check above is not vacuous)
    Eng loud;
    REQUIRE(loud.use(patch({slot("synth", "bell")}), 0));
    loud.sg().wheel().mod = 0;
    REQUIRE(loud.commit(loud.prepare(patch({slot("synth", "soft-keys")})), 1.0));
    loud.on(72, 1.0, 110);
    loud.until(1.2);
    CHECK(t13::db(t13::rms(loud.L, 1.0, 1.1)) > -40);
  }

  TEST_CASE("switchHeadroom (Model side): prepare protects playing + incoming song, commit the new one only") {
    Eng e(true, t13::kSR, RIG_REPO_DIR "/app");
    auto *cs = dynamic_cast<rig::samples::CacheServiceImpl *>(e.model().service<rig::CacheService>());
    REQUIRE(cs);
    CHECK_FALSE(cs->cache().hasProtect());  // before any prepare pins stay absolute (protect null)
    const long tok = e.prepare(patch({slot("sampler", "ep-rhodes")}));
    CHECK(cs->cache().hasProtect());
    // a key of the incoming sampler is protected while it decodes next to the playing song
    rig::PatchSpec p;
    {
      const std::string j = patch({slot("sampler", "ep-rhodes")});
      yyjson_doc *doc = yyjson_read(j.data(), j.size(), 0);
      REQUIRE(rig::parsePatch(yyjson_doc_get_root(doc), p, nullptr));
      yyjson_doc_free(doc);
    }
    const auto keys = cs->protectKeys({&p});
    REQUIRE(!keys.empty());
    CHECK(cs->cache().isProtected(keys.front()));
    REQUIRE(e.commit(tok));
    CHECK(cs->cache().isProtected(keys.front()));  // the song that now plays
    // a later song: only its own samples are protected. (A song WITHOUT samplers protects nothing in JS, an empty
    // Set; BufferCache::protect(data() of an empty vector = null) resets to "no protection" instead: T06 note.)
    REQUIRE(e.use(patch({slot("sampler", "ep-wurli")})));
    CHECK_FALSE(cs->cache().isProtected(keys.front()));
    // the pinned / evicted-and-rewarmed accounting itself is T06's (samples_service: switch headroom)
  }

  TEST_CASE("washAcrossCommit: NOT PORTABLE YET (macro.wash and the staged effective size are T14 + T04)") {
    // JS stages lerp(size, .9, wash) in prepare and commits to it. The routing state is here (macro('macro.wash')),
    // but ReverbPool::onCommit re-stages the plain patch size (T04 file) and the wheel writes are T14's. This case
    // pins what T13 provides: the wash macro value the stage needs.
    Eng e;
    REQUIRE(e.use(patch({}, R"("modWheel":{"target":"macro.wash","min":0,"max":1},"fx":{"reverb":{"size":0.3}})")));
    e.sg().wheel().mod = 1;
    REQUIRE(e.sg().macro("macro.wash").has_value());
    CHECK(*e.sg().macro("macro.wash") == 1.0);
    CHECK_FALSE(e.sg().macro("macro.intensity").has_value());
  }

  TEST_CASE("morphAtCommit: the current morph reaches a fresh instrument at commit (pad-like + macro.intensity)") {
    Eng e;
    REQUIRE(e.use(patch({slot("synth", "bell")})));
    CHECK(e.sg().liveChannel(0)->morph == 0.0);  // plain: 0 (the instrument's own start value)
    const std::string r = R"({"modWheel":{"target":"macro.intensity","min":0,"max":1}})";
    yyjson_doc *doc = yyjson_read(r.data(), r.size(), 0);
    e.model().setRouting(yyjson_doc_get_root(doc), -1);
    yyjson_doc_free(doc);
    e.sg().wheel().mod = 0.4;
    REQUIRE(e.use(patch({"null", slot("synth", "warm-pad")}, R"("modWheel":{"target":"macro.intensity"})")));
    REQUIRE(e.sg().liveChannel(1));
    CHECK(e.sg().liveChannel(1)->morph == doctest::Approx(0.4).epsilon(1e-12));
    // slot 1 = the Pad: its wheel factor also follows the intensity (lerp(.35, 1, I))
    CHECK(e.sg().liveChannel(1)->wheel == doctest::Approx(0.35 + 0.65 * 0.4));
    e.on(60, 0.0);
    e.until(0.5);
    CHECK(t13::rms(e.L, 0.1, 0.5) > 1e-4);
  }

  TEST_CASE("beforeStartNoThrow: calls before audio start never fail hard; values are stored and apply later") {
    Eng e(false);  // hello only
    const char *calls[] = {
        R"({"v":1,"op":"set","id":10,"path":"slots.0.params.tone","value":0.5})",
        R"({"v":1,"op":"set","id":11,"path":"fx.reverb.size","value":0.7})",
        R"({"v":1,"op":"set","id":12,"path":"master.volume","value":0.3})",
        R"({"v":1,"op":"set","id":13,"path":"drone.gain","value":0.5})",
        R"({"v":1,"op":"song","id":14,"tempo":90})",
        R"({"v":1,"op":"play","e":"on","n":60,"vel":100})",
        R"({"v":1,"op":"play","e":"off","n":60})",
        R"({"v":1,"op":"play","e":"pedal","down":true})",
        R"({"v":1,"op":"play","e":"wheel","src":"mod","value":0.25})",
        R"({"v":1,"op":"config","id":15,"eqAudition":{"slot":1,"mode":"bypass"}})",
        R"({"v":1,"op":"song","id":17,"routing":{"modWheel":{"target":"slots.0.gain"}}})",
        R"({"v":1,"op":"get","what":"state","id":16})",
    };
    for (const char *c : calls) {
      const std::string r = e.call(c);
      INFO(c << " -> " << r);
      CHECK_FALSE(contains(r, "internal"));
    }
    CHECK(e.model().patch().master.volume == doctest::Approx(0.3));  // stored before start
    CHECK(e.model().patch().reverb.size == doctest::Approx(0.7));
    CHECK(e.model().setDynamicRange(2) == 2.0);
    e.call(R"({"v":1,"op":"audio","action":"start","id":2})");
    REQUIRE(e.use(patch({slot("synth", "bell")})));
    e.on(69, 0.05);
    e.until(0.5);
    CHECK(t13::rms(e.L, 0.1, 0.5) > 1e-3);
  }

  TEST_CASE("lowResource: idempotent, stats, idle reverb units dropped on, pins restored off (Model side)") {
    Eng e;
    auto *pool = dynamic_cast<rig::fx::ReverbPool *>(e.model().service<rig::ReverbService>());
    REQUIRE(pool);
    for (double size : {0.4, 0.8, 0.95}) {
      REQUIRE(e.use(patch({slot("synth", "bell")}, R"("fx":{"reverb":{"size":)" + Eng::num(size) + "}}")));
      e.until(e.L.size() / t13::kSR + 1.2);  // the 0.8 s crossfade is over: the old unit is idle
    }
    const std::size_t before = pool->units();
    REQUIRE(before >= 2);
    CHECK(e.model().setLowResource(true));
    CHECK(e.model().setLowResource(true));  // idempotent
    CHECK(pool->units() <= 1);              // only the space in use stays built
    CHECK(pool->units() < before);
    CHECK(contains(e.call(R"({"v":1,"op":"get","what":"stats","id":9})"), "\"lowResource\":true"));
    CHECK(contains(e.call(R"({"v":1,"op":"get","what":"state","id":9})"), "\"lowResource\":true"));
    CHECK_FALSE(e.model().setLowResource(false));
    CHECK(contains(e.call(R"({"v":1,"op":"get","what":"stats","id":9})"), "\"lowResource\":false"));
    // pins: 'current-only' while on and the restore are CacheServiceImpl::setLowResource (T06 tests); the Model calls
    // it. Slot taps paused: Engine::buildTick reads Model::lowResource (T08). Drone freeze: T16.
  }

  TEST_CASE("restartKeepsState: an audio restart and a rate change keep song, routing, wheels and channels") {
    Eng e;
    REQUIRE(e.use(patch({"null", slot("synth", "warm-pad")},
                        R"("modWheel":{"target":"slots.1.gain","min":0,"max":1})")));
    e.sg().wheel().mod = 0.1;
    e.model().setDynamicRange(1.5);
    const std::uint32_t id = e.sg().liveChannel(1)->id;
    const std::string st0 = e.call(R"({"v":1,"op":"get","what":"state","id":9})");
    e.call(R"({"v":1,"op":"audio","action":"stop","id":20})");
    e.call(R"({"v":1,"op":"audio","action":"start","id":21})");
    rig_device_info info{};
    info.struct_size = sizeof info;
    info.sample_rate = 48000;
    info.channels = 2;
    rig_host_audio_started(e.e, &info);
    e.until(0.5);
    const std::string st1 = e.call(R"({"v":1,"op":"get","what":"state","id":9})");
    CHECK(st1 == st0);
    REQUIRE(e.sg().liveChannel(1));
    CHECK(e.sg().liveChannel(1)->id == id);
    CHECK(e.sg().wheel().mod == 0.1);
    CHECK(e.model().dynamicRange() == 1.5);
    // drone files and the fade-out state are T16 / T14 (restartKeepsState's other halves)
  }

  TEST_CASE("role defaults: an absent row takes the role value, an explicit null the PARAMS default (T13 O1)") {
    // engine/audio.js normalizePatch: {...defaultSlot(role), ...s} keeps an explicit null and clampParam(null) gives
    // the PARAMS default; sends merge one level deeper ({...base.sends, ...s.sends}). Values checked in node:
    // Bass {highNote, mono, bendEnabled: null} -> 127 / 'off' / false; absent -> 59 / 'lowest' / true (synth);
    // Keys sends {reverb: null} -> reverb 0, delay 0.1 (role).
    const auto parse = [](const std::string &j) {
      rig::PatchSpec p;
      yyjson_doc *doc = yyjson_read(j.data(), j.size(), 0);
      REQUIRE(doc);
      REQUIRE(rig::parsePatch(yyjson_doc_get_root(doc), p, nullptr));
      yyjson_doc_free(doc);
      return p;
    };
    const std::string bass = R"({"instrument":{"type":"synth","id":"sub-bass"})";
    const rig::PatchSpec a = parse(patch({"null", "null", "null", bass + "}"}));
    REQUIRE(a.slots[3].present);
    CHECK(a.slots[3].spec.highNote == 59);
    CHECK(a.slots[3].mono == 1);  // 'lowest'
    CHECK(a.slots[3].bendEnabled);
    const rig::PatchSpec b = parse(patch(
        {R"({"instrument":{"type":"synth","id":"warm-pad"},"sends":{"reverb":null}})", "null", "null",
         bass + R"(,"highNote":null,"mono":null,"bendEnabled":null})"}));
    REQUIRE(b.slots[3].present);
    CHECK(b.slots[3].spec.highNote == 127);
    CHECK(b.slots[3].mono == 0);  // 'off'
    CHECK_FALSE(b.slots[3].bendEnabled);
    REQUIRE(b.slots[0].present);
    CHECK(b.slots[0].sends[0] == 0);
    CHECK(b.slots[0].sends[1] == doctest::Approx(0.1));
  }
}
