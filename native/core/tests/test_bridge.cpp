#include <cstring>
#include <initializer_list>
#include <string>
#include <vector>
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
    CHECK(contains(eng.call(R"({"v":1,"op":"set","id":3,"path":"fx.reverb.size","value":0.7})"), "\"applied\":false"));
    const std::string b =
        eng.call(R"({"v":1,"op":"set","id":4,"batch":[["slots.0.pan",0.5],["nope",1],["master.volume",0.4,0.1]]})");
    CHECK(contains(b, "\"applied\":[true,false,true]"));
  }

  TEST_CASE("ops that later tasks implement answer unsupported, not silence") {
    OfflineEngine eng;
    eng.hello();
    for (const char *op : {"cache", "song", "drone", "click", "midi", "rec"}) {
      const std::string r = eng.call(std::string(R"({"v":1,"id":1,"op":")") + op + "\"}");
      CHECK(contains(r, "\"code\":\"unsupported\""));
    }
    CHECK(contains(eng.call(R"({"v":1,"op":"play","e":"wheel","id":2})"), "\"code\":\"unsupported\""));
  }

  TEST_CASE("audio start/sleep/wake and get state/stats/devices reply") {
    OfflineEngine eng;
    eng.hello();
    CHECK(contains(eng.call(R"({"v":1,"op":"audio","action":"start","id":1})"), "\"state\":\"running\""));
    CHECK(contains(eng.call(R"({"v":1,"op":"audio","action":"sleep","id":2})"), "\"done\":true"));
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
