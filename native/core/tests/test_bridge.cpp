#include <cstring>
#include <initializer_list>
#include <string>
#include <vector>

#include "api/engine.h"
#include "doctest.h"
#include "helpers.h"

using namespace rigtest;

TEST_SUITE("bridge") {
  TEST_CASE("hello must come first; its reply carries the contract fields") {
    OfflineEngine eng;
    std::string r = eng.call(R"({"v":1,"op":"get","what":"stats","id":5})");
    CHECK(contains(r, "\"re\":5"));
    CHECK(contains(r, "\"ok\":false"));
    CHECK(contains(r, "\"code\":\"protocol\""));
    r = eng.call(R"({"v":1,"op":"hello","protocol":1,"app":"t","id":1})");
    CHECK(contains(r, "\"ok\":true"));
    CHECK(contains(r, "\"protocol\":1"));
    CHECK(contains(r, "worship-rig-core"));
    CHECK(contains(r, "\"sampleRate\":48000"));
    CHECK(contains(r, "\"seed\":1"));
  }

  TEST_CASE("protocol mismatch, wrong v and unknown ops are structured errors") {
    OfflineEngine eng;
    CHECK(contains(eng.call(R"({"v":2,"op":"hello","protocol":2,"id":1})"), "\"code\":\"protocol\""));
    CHECK(contains(eng.call(R"({"op":"hello","id":2})"), "\"code\":\"protocol\""));
    eng.hello();
    const std::string r = eng.call(R"({"v":1,"op":"frobnicate","id":9})");
    CHECK(contains(r, "\"re\":9"));
    CHECK(contains(r, "\"code\":\"unknown-op\""));
    CHECK(contains(r, "frobnicate"));
  }

  TEST_CASE("without an id, errors surface as a warn event") {
    OfflineEngine eng;
    eng.hello();
    const std::string r = eng.call(R"({"v":1,"op":"frobnicate"})");
    CHECK(contains(r, "\"ev\":\"warn\""));
    CHECK(contains(r, "\"code\":\"unknown-op\""));
    CHECK(!contains(r, "\"re\""));
    CHECK(eng.call(R"({"v":1,"op":"config","mono":true})").empty());  // fire-and-forget success is silent
  }

  TEST_CASE("rig_post return codes: not JSON is INVALID, schema errors are not return codes") {
    OfflineEngine eng;
    CHECK(eng.post("hello") == RIG_E_INVALID);
    CHECK(eng.post("") == RIG_E_INVALID);
    CHECK(eng.post("{\"v\":1,") == RIG_E_INVALID);
    CHECK(eng.post(R"({"v":1,"op":"hello","protocol":1})") == RIG_OK);
    CHECK(eng.post(R"({"v":1,"op":"nope"})") == RIG_OK);
  }

  TEST_CASE("arrays are processed in order and replies come back as one batch") {
    OfflineEngine eng;
    const std::string r =
        eng.call(R"([{"v":1,"op":"hello","protocol":1,"id":1},{"v":1,"op":"get","what":"stats","id":2},)"
                 R"({"v":1,"op":"get","what":"state","id":3}])");
    REQUIRE(eng.msgs.size() == 1);
    CHECK(eng.msgs[0].front() == '[');
    const auto p1 = r.find("\"re\":1"), p2 = r.find("\"re\":2"), p3 = r.find("\"re\":3");
    CHECK(p1 < p2);
    CHECK(p2 < p3);
  }

  TEST_CASE("prepare/commit: tokens, stale token") {
    OfflineEngine eng;
    eng.hello();
    std::string r = eng.call(R"({"v":1,"op":"prepare","id":1,"patch":{"slots":[{"gain":1},null,null,null]}})");
    CHECK(contains(r, "\"token\":1"));
    r = eng.call(R"({"v":1,"op":"prepare","id":2,"patch":{"slots":[]}})");
    CHECK(contains(r, "\"token\":2"));
    CHECK(contains(eng.call(R"({"v":1,"op":"commit","id":3,"token":1,"when":0})"), "\"committed\":true"));
    CHECK(contains(eng.call(R"({"v":1,"op":"commit","id":4,"token":77})"), "\"code\":\"stale-token\""));
    CHECK(contains(eng.call(R"({"v":1,"op":"commit","id":5})"), "\"code\":\"bad-request\""));
    CHECK(contains(eng.call(R"({"v":1,"op":"prepare","id":6,"patch":5})"), "\"code\":\"bad-request\""));
  }

  TEST_CASE("set: known row applies, unknown row errors, validated-but-unimplemented rows say applied:false") {
    OfflineEngine eng;
    eng.hello();
    CHECK(contains(eng.call(R"({"v":1,"op":"set","id":1,"path":"slots.1.gain","value":0.5})"), "\"applied\":true"));
    CHECK(contains(eng.call(R"({"v":1,"op":"set","id":2,"path":"slots.1.bogus","value":1})"),
                   "\"code\":\"unknown-param\""));
    // a validated row whose module (T16 drone) is not in this wave: applied:false, not an error
    const std::string d = eng.call(R"({"v":1,"op":"set","id":3,"path":"drone.gain","value":0.7})");
    CHECK(contains(d, "\"ok\":true"));
    CHECK(contains(d, "\"applied\":"));
    const std::string b =
        eng.call(R"({"v":1,"op":"set","id":4,"batch":[["slots.0.pan",0.5],["nope",1],["master.volume",0.4,0.1]]})");
    CHECK(contains(b, "\"applied\":[true,false,true]"));
  }

  TEST_CASE("ops whose module is missing answer unsupported, not silence") {
    // WAVE0B_REVIEW V1: every op dispatches to the Model; a missing service / empty result = `unsupported`.
    OfflineEngine eng;
    eng.hello();
    rig::Model &m = reinterpret_cast<rig::Engine *>(eng.e)->model();
    const struct {
      const char *msg, *service;
    } cases[] = {{R"({"v":1,"id":1,"op":"drone","key":{"pc":2,"minor":false}})", "drone"},
                 {R"({"v":1,"id":1,"op":"click","action":"start"})", "click"},
                 {R"({"v":1,"id":1,"op":"midi","action":"listen","ids":[]})", "midi"},
                 {R"({"v":1,"id":1,"op":"rec","action":"stop"})", "rec"},
                 {R"({"v":1,"id":1,"op":"cache","action":"retainReverb","patches":[]})", "reverb"}};
    for (const auto &c : cases) {
      if (m.service(c.service)) continue;  // a module provides it in this build
      INFO(c.msg);
      CHECK(contains(eng.call(c.msg), "\"code\":\"unsupported\""));
    }
    CHECK(contains(eng.call(R"({"v":1,"op":"play","e":"bend","x":0.5,"id":2})"), "\"code\":\"unsupported\""));
    CHECK(contains(eng.call(R"({"v":1,"op":"click","id":3})"), "\"code\":\"bad-request\""));
  }

  TEST_CASE("song / config reach the Model") {
    OfflineEngine eng;
    eng.hello();
    rig::Model &m = reinterpret_cast<rig::Engine *>(eng.e)->model();
    const std::string r =
        eng.call(R"({"v":1,"id":1,"op":"song","transpose":3,"tempo":96,"timeSig":"6/8","key":{"pc":9,"minor":true}})");
    CHECK(contains(r, "\"ok\":true"));
    CHECK(m.song().transpose == 3);
    CHECK(m.song().tempo == 96);
    CHECK(m.song().sigNum == 6);
    CHECK(m.song().keyPc == 9);
    CHECK(m.song().keyMinor);
    CHECK(contains(eng.call(R"({"v":1,"id":2,"op":"song","tempo":null})"), "\"ok\":true"));
    CHECK(m.song().tempo == 0);
    CHECK(contains(eng.call(R"({"v":1,"id":3,"op":"config","mono":true,"lowResource":true})"),
                   "\"lowResource\":true"));
    CHECK(m.song().mono);
    // the builtin strip has no audition: false until T02's SlotChannel lands
    const std::string a = eng.call(R"({"v":1,"id":4,"op":"config","eqAudition":{"slot":0,"mode":"bypass"}})");
    CHECK(contains(a, "\"eqAudition\":"));
    CHECK(contains(eng.call(R"({"v":1,"id":5,"op":"play","e":"wheel","src":"mod","value":0.5})"), "\"ok\":true"));
  }

  TEST_CASE("audio start/sleep/wake and get state/stats/devices reply") {
    OfflineEngine eng;
    eng.hello();
    const std::string st = eng.call(R"({"v":1,"op":"audio","action":"start","id":1})");
    CHECK(contains(st, "\"state\":\"running\""));
    CHECK(st.find("\"ev\":\"state\"") < st.find("\"phase\":\"start\""));  // G9: state before load start
    CHECK(st.find("\"phase\":\"start\"") < st.find("\"re\":1"));             // ... and before the reply
    CHECK(!contains(eng.call(R"({"v":1,"op":"audio","action":"start","id":11})"), "\"phase\""));  // once
    // contract 1.1: sleep is realtime only (offline answers done:false); wake is idempotent
    CHECK(contains(eng.call(R"({"v":1,"op":"audio","action":"sleep","id":2})"), "\"done\":false"));
    CHECK(contains(eng.call(R"({"v":1,"op":"audio","action":"wake","id":7})"), "\"done\":true"));
    CHECK(contains(eng.call(R"({"v":1,"op":"audio","action":"bad","id":3})"), "\"code\":\"bad-request\""));
    CHECK(contains(eng.call(R"({"v":1,"op":"get","what":"stats","id":4})"), "\"quanta\""));
    CHECK(contains(eng.call(R"({"v":1,"op":"get","what":"devices","id":5})"), "\"result\":[]"));
    CHECK(contains(eng.call(R"({"v":1,"op":"get","what":"state","id":6})"), "\"committed\":false"));
  }

  TEST_CASE("test hooks are gated by the flag") {
    OfflineEngine eng(48000, 0);
    CHECK(rig_test_tap(eng.e, "out") == RIG_E_UNSUPPORTED);
    OfflineEngine on;
    CHECK(rig_test_tap(on.e, "out") == RIG_OK);
    CHECK(rig_test_tap(on.e, "fx.reverb.output") == RIG_E_UNSUPPORTED);  // lands with the reverb task
  }
}
