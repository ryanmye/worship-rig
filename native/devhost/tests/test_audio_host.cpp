// AudioHost: the real-time callback body under the allocation trap (no device), then the miniaudio null backend
// driving a realtime engine through the rig_host vtable (open, rate adoption, restart, 4 channels, device list).
#include <chrono>
#include <cmath>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

#include "audio_host.h"
#include "doctest.h"
#include "rig/rig_engine.h"
#include "util.h"
#include "yyjson.h"

namespace rigtest {
extern long g_rtAllocs;
}

namespace {

rig_engine *makeEngine(dht::Sink &sink, const rig_host *host, std::uint32_t maxBlock, std::uint32_t channels = 2) {
  rig_config cfg;
  rig_config_init(&cfg);
  cfg.mode = RIG_MODE_REALTIME;
  cfg.sample_rate = 48000;
  cfg.max_block_frames = maxBlock;
  cfg.output_channels = channels;
  cfg.seed = 7;
  cfg.on_event = &dht::Sink::fn;
  cfg.event_user = &sink;
  cfg.host = host;
  return rig_create(&cfg, nullptr);
}

void post(rig_engine *e, const std::string &m) {
  REQUIRE(rig_post(e, m.data(), m.size()) == RIG_OK);
}

void startWithTestVoice(rig_engine *e, dht::Sink &s) {
  post(e, R"({"v":1,"op":"hello","protocol":1,"id":1})");
  REQUIRE(s.waitFor("\"re\":1"));
  post(e, R"({"v":1,"op":"audio","action":"start","id":2})");
  REQUIRE(s.waitFor("\"re\":2"));
  post(e, R"({"v":1,"op":"prepare","id":3,"patch":{"slots":[{"instrument":{"type":"test","id":"sine"},)"
          R"("gain":1,"params":{"attack":0.002,"release":0.05}},null,null,null]}})");
  REQUIRE(s.waitFor("\"token\":1"));
  post(e, R"({"v":1,"op":"commit","id":4,"token":1})");
  REQUIRE(s.waitFor("\"committed\":true"));
}

}  // namespace

TEST_SUITE("devhost-audio") {
  TEST_CASE("callback body: chunks to max_block, interleaves, never allocates; cost per 128 frames") {
    devhost::AudioOptions o;
    o.maxBlockFrames = 1024;
    devhost::AudioHost host(o);
    dht::Sink s;
    rig_engine *e = makeEngine(s, nullptr, 1024);  // no host: the test is the audio thread
    REQUIRE(e);
    startWithTestVoice(e, s);
    host.prepareBuffers(2);
    host.attach(e);
    post(e, R"({"v":1,"op":"play","e":"on","n":69,"vel":100,"id":5})");
    REQUIRE(s.waitFor("\"re\":5"));
    std::vector<float> out(3000 * 2, -9.0f);
    const long before = rigtest::g_rtAllocs;
    double peakL = 0, peakR = 0;
    bool finite = true;
    for (int i = 0; i < 20; ++i) {  // 3000-frame callbacks = 2 full max blocks + a remainder
      host.renderInterleaved(out.data(), 3000);
      for (std::size_t k = 0; k < 3000; ++k) {
        finite = finite && std::isfinite(out[2 * k]) && std::isfinite(out[2 * k + 1]);
        peakL = std::fmax(peakL, std::fabs(out[2 * k]));
        peakR = std::fmax(peakR, std::fabs(out[2 * k + 1]));
      }
    }
    CHECK(rigtest::g_rtAllocs == before);
    CHECK(finite);
    CHECK(peakL > 0.01);  // the note sounds on both interleaved channels (no -9 fill left anywhere)
    CHECK(peakR > 0.01);
    CHECK(peakL < 4.0);

    // cost: 128-frame callbacks with the voice sounding; wrapper = everything outside rig_render
    const auto s0 = host.stats();
    std::vector<float> q(128 * 2);
    for (int i = 0; i < 4000; ++i) host.renderInterleaved(q.data(), 128);
    const auto s1 = host.stats();
    CHECK(rigtest::g_rtAllocs == before);
    const double n = static_cast<double>(s1.callbacks - s0.callbacks);
    const double total = static_cast<double>(s1.totalNs - s0.totalNs) / n / 1e3;
    const double render = static_cast<double>(s1.renderNs - s0.renderNs) / n / 1e3;
    std::printf("[devhost-audio] per 128-frame callback: %.2f us total, %.2f us in rig_render, %.2f us wrapper "
                "(%.2f %% of the 2.67 ms quantum)\n",
                total, render, total - render, 100.0 * (total - render) / 2666.7);
    CHECK(total - render < 50.0);  // generous: the wrapper is a deinterleave + 4 clock reads
    host.attach(nullptr);
    rig_destroy(e);
  }

  TEST_CASE("null backend: audio start opens the device, state running, engine time advances, restart") {
    devhost::AudioOptions o;
    o.backend = "null";
    o.periodFrames = 256;
    devhost::AudioHost host(o);
    std::string err;
    REQUIRE_MESSAGE(host.init(&err), err);
    CHECK(host.backendName() == "Null");
    dht::Sink s;
    rig_engine *e = makeEngine(s, host.vtable(), o.maxBlockFrames);
    REQUIRE(e);
    host.attach(e);
    post(e, R"({"v":1,"op":"hello","protocol":1,"id":1})");
    REQUIRE(s.waitFor("\"re\":1"));
    post(e, R"({"v":1,"op":"audio","action":"start","id":2})");
    REQUIRE(s.waitFor("\"state\":\"running\""));
    REQUIRE(s.waitFor("\"re\":2"));
    std::this_thread::sleep_for(std::chrono::milliseconds(400));
    const double t = rig_engine_time(e);
    CHECK(t > 0.1);
    const auto st = host.stats();
    CHECK(st.running);
    CHECK(st.callbacks > 10);
    CHECK(st.sampleRate == 48000.0);
    CHECK(st.periodFrames == 256);
    CHECK(s.text().find("\"latencyMs\":10.6") != std::string::npos);  // 256 x 2 periods at 48 kHz

    post(e, R"({"v":1,"op":"get","what":"devices","id":3})");
    REQUIRE(s.waitFor("\"re\":3"));
    const std::string devs = host.devicesJson();
    yyjson_doc *doc = yyjson_read(devs.data(), devs.size(), 0);
    REQUIRE(doc);
    yyjson_val *root = yyjson_doc_get_root(doc);
    REQUIRE(yyjson_is_arr(root));
    REQUIRE(yyjson_arr_size(root) >= 1);
    yyjson_val *d0 = yyjson_arr_get_first(root);
    CHECK(yyjson_is_str(yyjson_obj_get(d0, "id")));
    CHECK(yyjson_is_str(yyjson_obj_get(d0, "name")));
    CHECK(yyjson_is_bool(yyjson_obj_get(d0, "default")));
    CHECK(yyjson_is_arr(yyjson_obj_get(d0, "sampleRates")));
    yyjson_doc_free(doc);
    CHECK(s.text().find("\"Null:0\"") != std::string::npos);  // the `get devices` reply carries the host list

    post(e, R"({"v":1,"op":"audio","action":"restart","id":4})");
    REQUIRE(s.waitFor("\"restarted\":true"));
    REQUIRE(s.waitFor("\"re\":4"));
    const double t1 = rig_engine_time(e);
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    CHECK(rig_engine_time(e) > t1);  // time keeps running across a restart (contract 6.3)

    post(e, R"({"v":1,"op":"audio","action":"output","deviceId":"no-such-device","id":6})");
    CHECK(s.waitFor("no output device 'no-such-device'"));
    CHECK(s.waitFor("\"state\":\"closed\""));
    host.shutdown();
    host.attach(nullptr);
    rig_destroy(e);
  }

  TEST_CASE("null backend: a 4-channel engine gets a 4-channel device (aux click outputs)") {
    devhost::AudioOptions o;
    o.backend = "null";
    devhost::AudioHost host(o);
    std::string err;
    REQUIRE(host.init(&err));
    dht::Sink s;
    rig_engine *e = makeEngine(s, host.vtable(), o.maxBlockFrames, 4);
    REQUIRE(e);
    host.attach(e);
    post(e, R"({"v":1,"op":"hello","protocol":1,"id":1})");
    post(e, R"({"v":1,"op":"audio","action":"start","id":2})");
    REQUIRE(s.waitFor("\"state\":\"running\""));
    CHECK(s.waitFor("\"channels\":4"));
    CHECK(host.stats().channels == 4);
    host.shutdown();
    host.attach(nullptr);
    rig_destroy(e);
  }

  TEST_CASE("D2 (T00c): `audio {bufferFrames}` sets the period through audio_start_frames; --buffer overrides it") {
    for (std::uint32_t forced : {0u, 512u}) {
      devhost::AudioOptions o;
      o.backend = "null";
      o.bufferFrames = forced;  // rig-devhost --buffer N
      devhost::AudioHost host(o);
      std::string err;
      REQUIRE(host.init(&err));
      CHECK(host.vtable()->audio_start_frames != nullptr);
      dht::Sink s;
      rig_engine *e = makeEngine(s, host.vtable(), o.maxBlockFrames);
      REQUIRE(e);
      host.attach(e);
      post(e, R"({"v":1,"op":"hello","protocol":1,"id":1})");
      post(e, R"({"v":1,"op":"audio","action":"start","id":2,"bufferFrames":64})");
      REQUIRE(s.waitFor("\"state\":\"running\""));
      const std::uint32_t want = forced ? forced : 64u;
      CHECK(host.stats().periodFrames == want);
      CHECK(s.waitFor(("\"bufferFrames\":" + std::to_string(want)).c_str()));  // the granted size
      std::this_thread::sleep_for(std::chrono::milliseconds(200));
      CHECK(rig_engine_time(e) > 0.05);
      host.shutdown();
      host.attach(nullptr);
      rig_destroy(e);
    }
  }

  TEST_CASE("unknown backend name is an init error") {
    devhost::AudioOptions o;
    o.backend = "nope";
    devhost::AudioHost host(o);
    std::string err;
    CHECK_FALSE(host.init(&err));
    CHECK(err.find("unknown audio backend") != std::string::npos);
  }
}
