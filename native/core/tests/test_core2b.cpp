// CORE2B (PARITY "UI parity" rows 1-3; UIC review S1 / O1 / O2 / O4): the tick's `pedal` / `held` (and the
// rig_meters snapshot's), the tick runtime's `swelling`, and the contracted param read-back `get {what:'param'}`.
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "helpers.h"
#include "model/perform.h"
#include "test_model_util.h"

using rigtest::contains;
using t13::Eng;
using t13::patch;
using t13::slot;

namespace {

const char *kSine = R"({"instrument":{"type":"test","id":"sine"},"gain":1,"params":{"attack":0.002,"release":0.05}})";

std::string play(const std::string &body) {
  return R"({"v":1,"op":"play","id":40,)" + body + "}";
}
std::string getParam(Eng &e, const std::string &path) {
  return e.call(R"({"v":1,"op":"get","id":41,"what":"param","path":")" + path + R"("})");
}
/** The `"pedal":...,"held":n` part of a tick. */
std::string pedalHeld(Eng &e) {
  const std::string t = e.engine().buildTick(false);
  const std::size_t a = t.find("\"pedal\":");
  return a == std::string::npos ? "" : t.substr(a, t.find(",\"runtime\"") - a);
}

}  // namespace

TEST_SUITE("core2b") {
  TEST_CASE("tick + rig_meters: pedal stays true while held; held counts the held physical notes") {
    Eng e;
    REQUIRE(e.use(patch({kSine, "null", "null", "null"})));
    e.until(0.05);
    CHECK(pedalHeld(e) == "\"pedal\":false,\"held\":0");
    e.call(play(R"("e":"on","n":60,"vel":100)"));
    e.call(play(R"("e":"on","n":64,"vel":100)"));
    e.call(play(R"("e":"pedal","down":true)"));
    e.until(0.1);
    CHECK(pedalHeld(e) == "\"pedal\":true,\"held\":2");
    rig_meters m = e.meters();
    CHECK(m.pedal == 1);
    CHECK(m.held == 2);
    e.call(play(R"("e":"off","n":60)"));  // pedal-held now (sounding), no longer a held key
    // the UIC skeptic's probe: the lamp went dark 0.4 s after pedal down; read it every 0.1 s for 1.5 s
    for (double t = 0.2; t <= 1.6; t += 0.1) {
      e.until(t);
      INFO("t = " << t);
      CHECK(pedalHeld(e) == "\"pedal\":true,\"held\":1");
      m = e.meters();
      CHECK(m.pedal == 1);
      CHECK(m.held == 1);
    }
    CHECK(contains(e.engine().statsJson(), "\"pedaled\":1"));  // 60 rings under the pedal
    e.call(play(R"("e":"pedal","down":false)"));
    e.call(play(R"("e":"off","n":64)"));
    e.until(1.7);
    CHECK(pedalHeld(e) == "\"pedal\":false,\"held\":0");
    m = e.meters();
    CHECK(m.pedal == 0);
    CHECK(m.held == 0);
    // panic lifts the pedal and clears the held set (audio.js allNotesOff)
    e.call(play(R"("e":"pedal","down":true)"));
    e.call(play(R"("e":"on","n":67,"vel":90)"));
    e.until(1.8);
    CHECK(pedalHeld(e) == "\"pedal\":true,\"held\":1");
    e.call(play(R"("e":"panic")"));
    e.until(1.9);
    CHECK(pedalHeld(e) == "\"pedal\":false,\"held\":0");
    CHECK(e.meters().pedal == 0);
  }

  TEST_CASE("an API 1.0 rig_meters caller (struct_size V1) gets pedal / held too") {
    Eng e;
    REQUIRE(e.use(patch({kSine})));
    e.call(play(R"("e":"pedal","down":true)"));
    e.call(play(R"("e":"on","n":60,"vel":100)"));
    e.until(0.1);
    rig_meters m{};
    m.struct_size = RIG_METERS_SIZE_V1;
    REQUIRE(rig_get_meters(e.e, &m) == RIG_OK);
    CHECK(m.pedal == 1);
    CHECK(m.held == 1);
  }

  TEST_CASE("tick runtime carries swelling (contract 6.5), as wheelValues does; get state keeps getRuntimeState") {
    Eng e;
    REQUIRE(e.use(patch({kSine})));
    e.until(0.05);
    auto tick = [&] { return e.engine().buildTick(false); };
    CHECK(contains(tick(), "\"swelling\":false"));
    e.call(play(R"("e":"swell","start":true)"));
    e.until(0.2);
    CHECK(contains(tick(), "\"swelling\":true"));
    CHECK(contains(tick(), "\"modOwner\":\"virtual\""));
    CHECK(contains(e.model().perform().wheelValuesJson(), "\"swelling\":true"));
    const std::string st = e.call(R"({"v":1,"op":"get","id":9,"what":"state"})");
    CHECK(contains(st, "\"runtime\":{\"wheel\""));
    CHECK_FALSE(contains(st, "swelling"));  // audio.js getState().runtime = getRuntimeState(): no swelling
    e.call(play(R"("e":"panic")"));  // allNotesOff drops the swell
    e.until(0.3);
    CHECK(contains(tick(), "\"swelling\":false"));
    CHECK(contains(e.model().perform().wheelValuesJson(), "\"swelling\":false"));
  }

  TEST_CASE("hello: minor 5 with the getParam capability") {
    Eng e(false);
    const std::string h = e.call(R"({"v":1,"op":"hello","protocol":1,"id":12})");
    CHECK(contains(h, "\"minor\":5"));
    CHECK(contains(h, "\"getParam\""));
  }

  TEST_CASE("get param: the value the Model holds, in the PARAMS value space") {
    Eng e;
    const std::string organ = slot("organ", "gospel", 0.7, R"("mono":"highest","release":2.5)");
    REQUIRE(e.use(patch({slot("synth", "warm-pad", 0.6), "null", organ},
                        R"("fx":{"reverb":{"size":0.3},"delay":{"sync":"1/8d"},"master":{"volume":1.1}})")));
    CHECK(contains(getParam(e, "slots.0.gain"), R"("result":{"path":"slots.0.gain","value":0.6})"));
    CHECK(contains(getParam(e, "fx.reverb.size"), R"("value":0.3})"));
    CHECK(contains(getParam(e, "fx.delay.sync"), R"("value":"1/8d"})"));
    CHECK(contains(getParam(e, "master.volume"), R"("value":1.1})"));
    CHECK(contains(getParam(e, "slots.2.mono"), R"("value":"highest"})"));
    CHECK(contains(getParam(e, "slots.2.release"), R"("value":2.5})"));
    CHECK(contains(getParam(e, "slots.0.release"), R"("result":{"path":"slots.0.release"})"));  // absent: undefined
    CHECK(contains(getParam(e, "slots.0.pedalHold"), R"("value":"natural"})"));
    CHECK(contains(getParam(e, "slots.0.sustain"), R"("value":true})"));
    // role defaults (normalizePatch): slot 0 is Keys, reverb send 0 (the slot JSON is explicit), Bass highNote 59 n/a
    CHECK(contains(getParam(e, "slots.0.highNote"), R"("value":127})"));
    // an empty slot: undefined (audio.js: no cfg); a slot past the patch's entries: undefined too
    CHECK(contains(getParam(e, "slots.1.gain"), R"("result":{"path":"slots.1.gain"})"));
    CHECK(contains(getParam(e, "slots.9.gain"), R"("result":{"path":"slots.9.gain"})"));
    // a set is read back at once, clamped as PARAMS clamps it (Model::set stores before any module handler)
    e.set("slots.0.gain", "5");
    CHECK(contains(getParam(e, "slots.0.gain"), R"("value":2})"));
    e.set("slots.0.octave", "-1.4");
    CHECK(contains(getParam(e, "slots.0.octave"), R"("value":-1})"));
    e.set("slots.0.velocityCurve", "\"hard\"");
    CHECK(contains(getParam(e, "slots.0.velocityCurve"), R"("value":"hard"})"));
    e.set("fx.delay.pingpong", "true");
    CHECK(contains(getParam(e, "fx.delay.pingpong"), R"("value":true})"));
    // slot EQ: b-rows resolved (b1 = the 120 Hz low shelf, on, by default), cuts, legacy rows stored or default
    CHECK(contains(getParam(e, "slots.0.eq.b1.type"), R"("value":"lowshelf"})"));
    CHECK(contains(getParam(e, "slots.0.eq.b1.on"), R"("value":true})"));
    CHECK(contains(getParam(e, "slots.0.eq.b1.hz"), R"("value":120})"));
    CHECK(contains(getParam(e, "slots.0.eq.b3.on"), R"("value":false})"));
    e.set("slots.0.eq.b3.db", "4.5");
    CHECK(contains(getParam(e, "slots.0.eq.b3.db"), R"("value":4.5})"));
    CHECK(contains(getParam(e, "slots.0.eq.cutHz"), R"("value":20})"));
    CHECK(contains(getParam(e, "slots.0.eq.mid1Hz"), R"("value":400})"));
    // instrument params: stored, else the catalogue default with its own type (organ.js: percussion true, rotary)
    CHECK(contains(getParam(e, "slots.0.params.cutoff"), R"("value":1800})"));
    CHECK(contains(getParam(e, "slots.2.params.percussion"), R"("value":true})"));
    CHECK(contains(getParam(e, "slots.2.params.rotary"), R"("value":"fast"})"));
    e.set("slots.2.params.rotary", "\"off\"");
    CHECK(contains(getParam(e, "slots.2.params.rotary"), R"("value":"off"})"));
    e.set("slots.0.params.cutoff", "900");
    CHECK(contains(getParam(e, "slots.0.params.cutoff"), R"("value":900})"));
    CHECK(contains(getParam(e, "slots.0.params.nope"), R"("result":{"path":"slots.0.params.nope"})"));
    // drone.*: the live drone's value (drone.js getParam)
    e.set("drone.width", "0.25");
    CHECK(contains(getParam(e, "drone.width"), R"("value":0.25})"));
    // the test hook documented in rig_engine.h answers the same
    char buf[64];
    rig_test_query(e.e, "getParam:slots.0.gain", buf, sizeof buf);
    CHECK(std::string(buf) == "2");
    rig_test_query(e.e, "getParam:slots.1.gain", buf, sizeof buf);
    CHECK(std::string(buf) == "null");
  }

  TEST_CASE("get param: unknown path -> unknown-param; missing path -> bad-request; a commit replaces the values") {
    Eng e;
    REQUIRE(e.use(patch({kSine})));
    CHECK(contains(getParam(e, "slots.0.nope"), "\"code\":\"unknown-param\""));
    CHECK(contains(getParam(e, "slots.16.gain"), "\"code\":\"unknown-param\""));
    CHECK(contains(getParam(e, "fx.reverb"), "\"code\":\"unknown-param\""));
    CHECK(contains(getParam(e, "slots.0.params.9x"), "\"code\":\"unknown-param\""));
    CHECK(contains(e.call(R"({"v":1,"op":"get","id":42,"what":"param"})"), "\"code\":\"bad-request\""));
    CHECK(contains(e.call(R"({"v":1,"op":"get","id":43,"what":"param","path":3})"), "\"code\":\"bad-request\""));
    e.set("slots.0.gain", "0.4");
    CHECK(contains(getParam(e, "slots.0.gain"), R"("value":0.4})"));
    REQUIRE(e.use(patch({R"({"instrument":{"type":"test","id":"sine"},"gain":0.9})"})));
    CHECK(contains(getParam(e, "slots.0.gain"), R"("value":0.9})"));
  }

  TEST_CASE("realtime: every tick after the pedal reply says pedal:true until pedal up (UIC probe, 1.2 s)") {
    struct Rt {
      rig_engine *e = nullptr;
      std::mutex mu;
      std::string all;
    } rt;
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.mode = RIG_MODE_REALTIME;
    cfg.sample_rate = 48000;
    cfg.on_event = [](void *u, const char *j, size_t n) {
      auto *r = static_cast<Rt *>(u);
      std::lock_guard<std::mutex> lk(r->mu);
      r->all.append(j, n);
      r->all += '\n';
    };
    cfg.event_user = &rt;
    rt.e = rig_create(&cfg, nullptr);
    REQUIRE(rt.e != nullptr);
    auto post = [&](const std::string &m) { REQUIRE(rig_post(rt.e, m.data(), m.size()) == RIG_OK); };
    auto waitFor = [&](const char *needle, int ms = 5000) {
      for (int i = 0; i < ms; ++i) {
        {
          std::lock_guard<std::mutex> lk(rt.mu);
          if (rt.all.find(needle) != std::string::npos) return true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
      return false;
    };
    post(R"({"v":1,"op":"hello","protocol":1,"id":1})");
    post(R"({"v":1,"op":"audio","action":"start","id":2})");
    REQUIRE(waitFor("\"re\":2"));
    post(std::string(R"({"v":1,"op":"prepare","id":3,"patch":{"slots":[)") + kSine + "]}}");
    REQUIRE(waitFor("\"token\":1"));
    post(R"({"v":1,"op":"commit","id":4,"token":1})");
    REQUIRE(waitFor("\"committed\":true"));
    std::atomic<bool> stop{false};
    std::thread host([&] {  // the device thread: 256-frame blocks at about real time
      std::vector<float> l(256), r(256);
      float *p[2] = {l.data(), r.data()};
      while (!stop) {
        rig_render(rt.e, p, 2, 256, 0);
        std::this_thread::sleep_for(std::chrono::microseconds(5300));
      }
    });
    post(R"({"v":1,"op":"play","e":"on","n":60,"vel":100})");
    post(R"({"v":1,"op":"play","e":"pedal","down":true,"id":5})");
    REQUIRE(waitFor("\"re\":5"));
    std::size_t from;
    {
      std::lock_guard<std::mutex> lk(rt.mu);
      from = rt.all.find("\"re\":5");
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(1200));
    post(R"({"v":1,"op":"play","e":"pedal","down":false,"id":6})");
    post(R"({"v":1,"op":"play","e":"off","n":60})");
    REQUIRE(waitFor("\"re\":6"));
    std::this_thread::sleep_for(std::chrono::milliseconds(600));  // a few ticks after pedal up
    stop = true;
    host.join();
    std::string log;
    {
      std::lock_guard<std::mutex> lk(rt.mu);
      log = rt.all;
    }
    rig_destroy(rt.e);
    // ticks strictly between the pedal-down reply and the pedal-up reply
    const std::size_t to = log.find("\"re\":6");
    int ticks = 0, lit = 0;
    for (std::size_t at = log.find("\"ev\":\"tick\"", from); at != std::string::npos && at < to;
         at = log.find("\"ev\":\"tick\"", at + 1)) {
      ++ticks;
      const std::size_t eol = log.find('\n', at);
      const std::string line = log.substr(at, eol - at);
      if (contains(line, "\"pedal\":true,\"held\":1")) ++lit;
    }
    MESSAGE("ticks while the pedal was down: " << ticks << ", lit: " << lit);
    CHECK(ticks >= 3);  // 4 Hz with no meter subscribed: >= 4 in 1.2 s (3 under load)
    CHECK(lit == ticks);
    // and after pedal up + note off, the core's ticks say so (the shim's lamp goes dark from the core, not a timeout)
    const std::size_t last = log.rfind("\"ev\":\"tick\"");
    REQUIRE(last != std::string::npos);
    REQUIRE(last > to);
    CHECK(contains(log.substr(last, log.find('\n', last) - last), "\"pedal\":false,\"held\":0"));
  }
}
