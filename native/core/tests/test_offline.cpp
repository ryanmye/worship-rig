#include <algorithm>
#include <cmath>

#include "num/hash_seed.h"
#include <cstring>
#include <initializer_list>
#include <string>
#include <vector>
#include "doctest.h"
#include "helpers.h"
#include "time/timer.h"

using namespace rigtest;

namespace {

const char *kPatch =
    R"({"v":1,"op":"prepare","id":2,"patch":{"slots":[{"instrument":{"type":"test","id":"sine"},"gain":1,)"
    R"("params":{"attack":0.005,"decay":0.05,"sustain":0.6,"release":0.1}},null,null,null]}})";

void setup(OfflineEngine &e) {
  e.hello();
  e.call(kPatch);
  e.call(R"({"v":1,"op":"commit","token":1,"when":0})");
  // timing checks read the strip output: the master chain (T03) adds the compressor's 6 ms look-ahead
  REQUIRE(rig_test_tap(e.e, "slot0.pan") == RIG_OK);
}

size_t firstNonZero(const std::vector<float> &v) {
  for (size_t i = 0; i < v.size(); ++i)
    if (v[i] != 0.0f) return i;
  return v.size();
}

}  // namespace

TEST_SUITE("offline") {
  TEST_CASE("an empty engine renders exact silence and advances engine time") {
    OfflineEngine e(44100);
    e.hello();
    const auto out = e.render(1000);
    CHECK(std::all_of(out[0].begin(), out[0].end(), [](float x) { return x == 0.0f; }));
    CHECK(rig_engine_time(e.e) == doctest::Approx(1024.0 / 44100.0));  // whole quanta are rendered ahead
  }

  TEST_CASE("note-on at `when` starts on exactly frame round(when * sr)") {
    for (double when : {0.1, 0.1234567, 0.5}) {
      OfflineEngine e(48000);
      setup(e);
      e.call(R"({"v":1,"op":"play","e":"on","n":69,"vel":127,"when":)" + std::to_string(when) + "}");
      const auto out = e.render(48000);
      const size_t expect = static_cast<size_t>(std::llround(when * 48000));
      // frame 0 of the voice has envelope 0, so the first audible sample is expect + 1
      CHECK(firstNonZero(out[0]) == expect + 1);
    }
  }

  TEST_CASE("a note that is already late plays in the next quantum, not never") {
    OfflineEngine e;
    setup(e);
    e.render(1024);
    e.call(R"({"v":1,"op":"play","e":"on","n":60,"vel":100,"when":0.001})");
    const auto out = e.render(2048);
    CHECK(firstNonZero(out[0]) < 200);
  }

  TEST_CASE("output is independent of the host block size (FIFO adapter) and bit-repeatable") {
    std::vector<std::vector<float>> ref;
    for (size_t chunk : {size_t(4800), size_t(1), size_t(127), size_t(128), size_t(441), size_t(777)}) {
      OfflineEngine e;
      setup(e);
      e.call(R"({"v":1,"op":"play","e":"on","n":60,"vel":100,"when":0.01})");
      e.call(R"({"v":1,"op":"play","e":"off","n":60,"when":0.05})");
      auto out = e.render(4800, chunk);
      if (ref.empty()) ref = out;
      CHECK(out == ref);
    }
    CHECK(*std::max_element(ref[0].begin(), ref[0].end()) > 0.05f);  // not trivially silent
  }

  TEST_CASE("two engines with the same inputs render identical bits") {
    auto run = [] {
      OfflineEngine e;
      setup(e);
      e.call(R"({"v":1,"op":"play","e":"on","n":52,"vel":90,"when":0.02})");
      return e.render(24000, 333);
    };
    CHECK(run() == run());
  }

  TEST_CASE("voice end events come back and are counted, garbage is freed on the control side") {
    OfflineEngine e;
    setup(e);
    e.call(R"({"v":1,"op":"play","e":"on","n":60,"vel":100,"when":0.0})");
    e.call(R"({"v":1,"op":"play","e":"off","n":60,"when":0.05})");
    e.render(96000);
    e.render(128);  // events produced in the last quantum are delivered before the next one
    const std::string s = e.call(R"({"v":1,"op":"get","what":"stats","id":1})");
    CHECK(contains(s, "\"voicesEnded\":1"));
    CHECK(contains(s, "\"voices\":0"));
  }

  TEST_CASE("no allocation on the audio path while rendering notes, EQ and param changes") {
    OfflineEngine e;
    setup(e);
    e.call(R"({"v":1,"op":"set","path":"slots.0.eq.b4.on","value":true})");
    for (int n = 48; n < 60; ++n)
      e.call(R"({"v":1,"op":"play","e":"on","n":)" + std::to_string(n) + R"(,"vel":100,"when":0.01})");
    e.call(R"({"v":1,"op":"set","path":"slots.0.gain","value":0.3,"when":0.1})");
    const long before = g_rtAllocs;
    e.render(48000, 128);
    CHECK(g_rtAllocs == before);
  }

  TEST_CASE("timers run on 128-frame quantum boundaries (k = ceil(t*sr/128 - 1e-6))") {
    rig::TimerQueue q;
    std::vector<int> order;
    q.at(0.0, 48000, [&](double) { order.push_back(0); });
    q.at(128.0 / 48000, 48000, [&](double) { order.push_back(1); });  // exactly quantum 1
    q.at(128.5 / 48000, 48000, [&](double) { order.push_back(2); });  // quantum 2
    q.at(128.0 / 48000, 48000, [&](double) { order.push_back(3); });  // same quantum, later submission
    CHECK(rig::TimerQueue::quantumOf(128.0 / 48000, 48000) == 1);
    CHECK(rig::TimerQueue::quantumOf(128.5 / 48000, 48000) == 2);
    q.runDue(0);
    CHECK(order == std::vector<int>{0});
    q.runDue(1);
    CHECK(order == (std::vector<int>{0, 1, 3}));
    q.runDue(5);
    CHECK(order == (std::vector<int>{0, 1, 3, 2}));
    CHECK(q.pending() == 0);
  }

  TEST_CASE("meters: peak of the output is visible through the lock-free snapshot") {
    OfflineEngine e;
    setup(e);
    e.call(R"({"v":1,"op":"play","e":"on","n":69,"vel":127,"when":0.0})");
    e.render(9600);
    rig_meters m{};
    m.struct_size = sizeof m;
    REQUIRE(rig_get_meters(e.e, &m) == RIG_OK);
    CHECK(m.out_peak[0] > 0.05f);
    CHECK(m.voices == 1);
    CHECK(m.frames == 9600);
    CHECK(rig_get_meters(e.e, nullptr) == RIG_E_INVALID);
  }

  TEST_CASE("API guards: wrong mode, bad config") {
    OfflineEngine e;
    float a[128], b[128];
    float *p[2] = {a, b};
    CHECK(rig_render(e.e, p, 2, 128, 0) == RIG_E_STATE);  // offline engine has no realtime path
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.sample_rate = 100;
    rig_status st = RIG_OK;
    CHECK(rig_create(&cfg, &st) == nullptr);
    CHECK(st == RIG_E_INVALID);
    cfg.sample_rate = 48000;
    cfg.struct_size = 8;  // shorter than the minimum
    CHECK(rig_create(&cfg, &st) == nullptr);
    CHECK(std::string(rig_status_string(RIG_E_FULL)) == "full");
    CHECK(rig_api_version() == ((1u << 16) | 0u));
    rig_destroy(nullptr);  // no-op
  }

  TEST_CASE("seed_string hashes like hashSeed (FNV-1a) and reaches the hello reply") {
    CHECK(rig::hashSeed("abc") == 0x1A47E90Bu);  // FNV-1a 32 of "abc"
    CHECK(rig::hashSeed("") == 0x811c9dc5u);
    std::string got;
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.mode = RIG_MODE_OFFLINE;
    cfg.seed_string = "abc";
    cfg.on_event = [](void *u, const char *j, size_t n) { static_cast<std::string *>(u)->assign(j, n); };
    cfg.event_user = &got;
    rig_engine *e = rig_create(&cfg, nullptr);
    const std::string m = R"({"v":1,"op":"hello","protocol":1,"id":1})";
    rig_post(e, m.data(), m.size());
    CHECK(contains(got, "\"seed\":440920331"));  // 0x1A47E90B
    rig_destroy(e);
  }
}
