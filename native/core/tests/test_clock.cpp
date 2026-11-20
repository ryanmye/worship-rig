// Engine clock across device sample-rate changes (SETUP_REVIEW 15, 16; contract 6.3 "never goes backwards").
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <thread>
#include <vector>

#include "doctest.h"
#include "helpers.h"

using namespace rigtest;

namespace {

rig_device_info deviceAt(double sr) {
  rig_device_info d{};
  d.struct_size = sizeof d;
  d.device_id = "test";
  d.device_name = "test";
  d.sample_rate = sr;
  d.channels = 2;
  d.buffer_frames = 256;
  return d;
}

size_t firstNonZero(const std::vector<float> &v, size_t from = 0) {
  for (size_t i = from; i < v.size(); ++i)
    if (v[i] != 0.0f) return i;
  return v.size();
}

const char *kPatch =
    R"({"v":1,"op":"prepare","id":2,"patch":{"slots":[{"instrument":{"type":"test","id":"sine"},"gain":1,)"
    R"("params":{"attack":0.005,"decay":0.05,"sustain":0.6,"release":0.1}},null,null,null]}})";

}  // namespace

TEST_SUITE("clock") {
  TEST_CASE("offline: a rate change mid-run keeps engine time monotonic and reschedules pending notes") {
    for (double to : {96000.0, 32000.0}) {
      OfflineEngine e(48000);
      e.hello();
      e.call(kPatch);
      e.call(R"({"v":1,"op":"commit","token":1,"when":0})");
      e.call(R"({"v":1,"op":"play","e":"on","n":69,"vel":127,"when":1.0})");  // scheduled at the old rate
      std::vector<std::vector<float>> all(2);
      auto take = [&](size_t n) {
        auto o = e.render(n);
        for (int c = 0; c < 2; ++c) all[c].insert(all[c].end(), o[c].begin(), o[c].end());
      };
      take(24000);  // 0.5 s; the FIFO has rendered whole quanta ahead
      const double t0 = rig_engine_time(e.e);
      const double rendered = std::ceil(24000.0 / 128.0) * 128.0;  // time-grid frames at 48 kHz
      CHECK(t0 == doctest::Approx(rendered / 48000.0));
      const rig_device_info d = deviceAt(to);
      rig_host_audio_started(e.e, &d);
      take(static_cast<size_t>(to));  // one more second at the new rate
      const double t1 = rig_engine_time(e.e);
      CHECK(t1 >= t0);
      // after the switch time advances by frames / new rate (+ < 1 sample of grid snap + < 1 quantum of FIFO)
      CHECK(t1 - t0 == doctest::Approx(1.0).epsilon(256.0 / to));
      // the note scheduled for t = 1.0 s plays at t = 1.0 s on the new grid
      const double newGridAtSwitch = std::ceil(rendered * to / 48000.0 - 1e-9);
      const size_t expect = static_cast<size_t>(rendered + (std::llround(1.0 * to) - newGridAtSwitch)) + 1;
      // the `out` signal passes the master chain, whose compressors delay it by their look-ahead (contract 3.8:
      // output latency = DynamicsCompressor pre-delay, floor(0.006 * rate) frames at the new rate; T03 review O1)
      const size_t lookahead = static_cast<size_t>(0.006f * static_cast<float>(to));
      CHECK(firstNonZero(all[0]) == expect + lookahead);
      char buf[512];
      rig_test_query(e.e, "stats", buf, sizeof buf);
      CHECK(contains(buf, "\"rateChanges\":1"));
    }
  }

  TEST_CASE("realtime: rig_host_audio_started from another thread while rendering (TSan target)") {
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.mode = RIG_MODE_REALTIME;
    cfg.sample_rate = 48000;
    cfg.seed = 7;
    rig_engine *e = rig_create(&cfg, nullptr);
    REQUIRE(e != nullptr);
    const std::string hello = R"({"v":1,"op":"hello","protocol":1,"id":1})";
    const std::string start = R"({"v":1,"op":"audio","action":"start","id":2})";
    rig_post(e, hello.data(), hello.size());
    rig_post(e, start.data(), start.size());
    std::vector<float> l(441), r(441);
    float *out[2] = {l.data(), r.data()};
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (rig_engine_time(e) == 0.0 && std::chrono::steady_clock::now() < deadline) {
      rig_render(e, out, 2, 441, 0);  // silent until the control thread has processed `audio start`
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    REQUIRE(rig_engine_time(e) > 0.0);

    std::atomic<bool> stop{false};
    std::atomic<int> backwards{0};
    std::atomic<long> renders{0};
    std::thread audio([&] {  // the "device" thread
      double last = rig_engine_time(e);
      while (!stop.load()) {
        rig_render(e, out, 2, 441, 0);  // odd block size: FIFO adapter in the loop
        const double t = rig_engine_time(e);
        if (t < last) backwards.fetch_add(1);
        last = t;
        renders.fetch_add(1);
      }
    });
    std::thread host([&] {  // the platform layer's notification thread
      const double rates[] = {44100, 96000, 32000, 48000, 88200, 44100};
      for (double sr : rates) {
        const rig_device_info d = deviceAt(sr);
        rig_host_audio_started(e, &d);
        std::this_thread::sleep_for(std::chrono::milliseconds(15));
      }
    });
    for (int i = 0; i < 40; ++i) {  // the WebView posting notes meanwhile
      const std::string m = R"({"v":1,"op":"play","e":"on","n":60,"vel":90})";
      rig_post(e, m.data(), m.size());
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    host.join();
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    stop = true;
    audio.join();
    CHECK(backwards.load() == 0);
    CHECK(renders.load() > 10);
    rig_destroy(e);
  }
}
