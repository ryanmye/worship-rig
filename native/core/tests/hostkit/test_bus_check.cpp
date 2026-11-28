// Bus v1 checks (remote lane, D45): rig_bus.h over hand-written messages. Expected reasons are bus.js's
// (Node 22: `stateError` / `commandError`); test/unit/hostkit/bus-parity.test.mjs runs a larger corpus through both.
#include <cstdlib>
#include <string>

#include "bus_check.h"
#include "doctest.h"
#include "rig/rig_bus.h"

namespace {

std::string state(const std::string &json) {
  char *e = nullptr;
  const int rc = rig_bus_check_state(json.data(), json.size(), &e);
  std::string r = rc == 0 ? "ok" : rc == 1 && e ? e : "internal";
  if (rc == 0) CHECK(e == nullptr);
  rig_hostkit_free(e);
  return r;
}
std::string command(const std::string &json) {
  char *e = nullptr;
  const int rc = rig_bus_check_command(json.data(), json.size(), &e);
  std::string r = rc == 0 ? "ok" : rc == 1 && e ? e : "internal";
  if (rc == 0) CHECK(e == nullptr);
  rig_hostkit_free(e);
  return r;
}

const std::string kBase =
    R"("v":1,"current":{"id":"a","name":"A","key":"D"},"modes":[{"id":"a","name":"A","key":"D","index":0}],)"
    R"("master":1,"masterDb":0,"droneOn":false,"droneKey":"D","audio":"running","latencyMs":5.2,)"
    R"("midi":{"connected":false,"name":null},"lowResource":false,"recording":false,"windowVisible":true,)"
    R"("memoryMB":null)";
std::string withBase(const std::string &extra) { return "{" + kBase + extra + "}"; }

}  // namespace

TEST_SUITE("hostkit-bus") {
  TEST_CASE("state: a full v1 state passes; each required field is checked in bus.js order") {
    CHECK(state(withBase("")) == "ok");
    CHECK(state(R"({"v":1,"current":null,"modes":[],"master":0,"masterDb":null,"droneOn":true,"droneKey":"",)"
                R"("audio":"asleep","latencyMs":0,"midi":{"connected":true,"name":"FP-10"},"lowResource":true,)"
                R"("recording":true,"windowVisible":false,"memoryMB":12})") == "ok");
    CHECK(state("[]") == "not an object");
    CHECK(state("null") == "not an object");
    CHECK(state("{}") == "v must be 1");
    CHECK(state(R"({"v":"1"})") == "v must be 1");
    CHECK(state(R"({"v":1})") == "current");
    CHECK(state(R"({"v":1,"current":{"id":"","name":"A","key":"D"}})") == "current");
    CHECK(state(R"({"v":1,"current":null,"modes":[{"id":"a","name":"A","key":"D","index":-1}]})") == "modes");
    CHECK(state(R"({"v":1,"current":null,"modes":[{"id":"a","name":"A","key":"D","index":0.5}]})") == "modes");
    CHECK(state(R"({"v":1,"current":null,"modes":[],"master":2.0001})") == "master");
    CHECK(state(R"({"v":1,"current":null,"modes":[],"master":1e999})") == "master");  // Infinity: not finite
    CHECK(state(R"({"v":1,"current":null,"modes":[],"master":1,"masterDb":"0"})") == "masterDb");
    CHECK(state(R"({"v":1,"current":null,"modes":[],"master":1,"masterDb":null,"droneOn":0})") == "droneOn");
    CHECK(state(withBase(R"(,"audio":"restarting")")) == "audio");  // the later key wins, as in JSON.parse
    CHECK(state(withBase(R"(,"midi":{"connected":false})")) == "midi");
    CHECK(state(withBase(R"(,"memoryMB":"x")")) == "memoryMB");
    CHECK(state(withBase(R"(,"theme":"")")) == "theme");
    CHECK(state(withBase(R"(,"theme":"sanctuary")")) == "ok");
  }

  TEST_CASE("state: scene and D45's scene.name / locked") {
    CHECK(state(withBase(R"(,"scene":{"n":null,"count":2})")) == "ok");
    CHECK(state(withBase(R"(,"scene":{"n":1,"count":2,"name":"Bridge"})")) == "ok");
    CHECK(state(withBase(R"(,"scene":{"n":2,"count":2})")) == "scene");
    CHECK(state(withBase(R"(,"scene":{"n":0,"count":0})")) == "scene");
    CHECK(state(withBase(R"(,"scene":null)")) == "scene");
    CHECK(state(withBase(R"(,"scene":{"n":0,"count":2,"name":null})")) == "scene.name");
    CHECK(state(withBase(R"(,"scene":{"n":0,"count":2,"name":")" + std::string(40, 'x') + R"("})")) == "ok");
    CHECK(state(withBase(R"(,"scene":{"n":0,"count":2,"name":")" + std::string(41, 'x') + R"("})")) == "scene.name");
    std::string emoji;
    for (int i = 0; i < 40; ++i) emoji += "\xF0\x9F\x98\x80";  // 40 code points, 80 UTF-16 units
    CHECK(state(withBase(R"(,"scene":{"n":0,"count":2,"name":")" + emoji + R"("})")) == "ok");
    std::string escaped;
    for (int i = 0; i < 40; ++i) escaped += "\\ud83d\\ude00";  // the same, written as escapes
    CHECK(state(withBase(R"(,"scene":{"n":0,"count":2,"name":")" + escaped + R"("})")) == "ok");
    CHECK(state(withBase(R"(,"scene":{"n":0,"count":2,"name":")" + escaped + R"(x"})")) == "scene.name");
    CHECK(state(withBase(R"(,"locked":true)")) == "ok");
    CHECK(state(withBase(R"(,"locked":"yes")")) == "locked");
  }

  TEST_CASE("command: every type and its payload; via") {
    for (const char *t : {"hello", "nextMode", "prevMode", "panic", "fadeOutAll", "droneToggle", "openMain",
                          "nextScene", "prevScene", "nextSong", "prevSong"}) {
      CHECK(command(std::string(R"({"v":1,"type":")") + t + R"("})") == "ok");
    }
    CHECK(command(R"({"v":1,"type":"nope"})") == R"(unknown type "nope")");
    CHECK(command(R"({"v":1})") == "unknown type undefined");
    CHECK(command(R"({"v":1,"type":{"a":[1,null]}})") == R"(unknown type {"a":[1,null]})");
    CHECK(command(R"({"v":2,"type":"panic"})") == "v must be 1");
    CHECK(command(R"({"v":1,"type":"selectMode","id":""})") == "selectMode.id");
    CHECK(command(R"({"v":1,"type":"selectMode","id":"x"})") == "ok");
    CHECK(command(R"({"v":1,"type":"master","value":2})") == "ok");
    CHECK(command(R"({"v":1,"type":"master","value":-0.1})") == "master.value (0..2)");
    CHECK(command(R"({"v":1,"type":"droneKey","pc":11})") == "ok");
    CHECK(command(R"({"v":1,"type":"droneKey","pc":1.5})") == "droneKey.pc (0..11)");
    CHECK(command(R"({"v":1,"type":"record","on":1})") == "record.on");
    CHECK(command(R"({"v":1,"type":"droneToggle","on":true})") == "ok");
    CHECK(command(R"({"v":1,"type":"droneToggle","on":"yes"})") == "droneToggle.on");
    CHECK(command(R"({"v":1,"type":"droneToggle","on":null})") == "droneToggle.on");
    CHECK(command(R"({"v":1,"type":"lowResource","on":false})") == "ok");
    CHECK(command(R"({"v":1,"type":"panic","via":"remote"})") == "ok");
    CHECK(command(R"({"v":1,"type":"panic","via":"tray"})") == "via");
    CHECK(command(R"({"v":1,"type":"master","via":"x","value":9})") == "via");  // via before the payload
  }

  TEST_CASE("caps, JSON and depth") {
    CHECK(command("") == "not JSON");
    CHECK(command("{") == "not JSON");
    CHECK(command("\xEF\xBB\xBF{\"v\":1,\"type\":\"panic\"}") == "not JSON");  // a BOM: JSON.parse refuses it
    std::string big = R"({"v":1,"type":"panic","pad":")" + std::string(4096, 'a') + R"("})";
    CHECK(command(big).rfind("too large (", 0) == 0);
    std::string fits = R"({"v":1,"type":"panic","p":")";
    fits += std::string(4096 - fits.size() - 2, 'a') + "\"}";
    REQUIRE(fits.size() == 4096);
    CHECK(command(fits) == "ok");
    std::string deep = R"({"v":1,"type":"panic","x":)" + std::string(20, '[') + std::string(20, ']') + "}";
    CHECK(command(deep) == "too deep");
    char *e = nullptr;
    CHECK(rig_bus_check_command(nullptr, 0, &e) == 1);
    CHECK(std::string(e) == "not JSON");
    rig_hostkit_free(e);
    CHECK(rig_bus_check_command("{}", 2, nullptr) == 1);  // no reason wanted
    CHECK(rig_bus_check_command(R"({"v":1,"type":"panic"})", 22, nullptr) == 0);
    CHECK(state(std::string(70000, ' ')).rfind("too large (", 0) == 0);
  }
}
