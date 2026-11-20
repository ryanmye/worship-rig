// T08 recorder (M17): WAV round trip (recorder-processor.js conversion), 24-bit, overflow accounting, naming,
// errors, the realtime writer thread with the 1 s header refresh, and the stop on a rate change.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <regex>
#include <string>
#include <thread>
#include <vector>

#include "api/engine.h"
#include "doctest.h"
#include "helpers.h"
#include "io/wav.h"
#include "rec/rec.h"
#include "yyjson.h"

using namespace rigtest;
namespace fs = std::filesystem;

namespace {

std::string tmp(const char *name) {
  const fs::path p = fs::temp_directory_path() / ("rig_t08_rec_" + std::to_string(::getpid()) + name);
  fs::remove_all(p);
  fs::create_directories(p);
  return p.string();
}

std::string field(const std::string &json, const char *key) {
  yyjson_doc *d = yyjson_read(json.data(), json.size(), 0);
  std::string out;
  if (d) {
    yyjson_val *root = yyjson_doc_get_root(d);
    if (yyjson_is_arr(root)) root = yyjson_arr_get_last(root);
    yyjson_val *res = yyjson_obj_get(root, "result");
    yyjson_val *v = yyjson_obj_get(res ? res : root, key);
    if (v && yyjson_is_str(v)) out = yyjson_get_str(v);
    else if (v && yyjson_is_num(v)) out = std::to_string(yyjson_get_num(v));
    yyjson_doc_free(d);
  }
  return out;
}

std::string replyOf(OfflineEngine &e, const std::string &msg, int id) {
  const std::string all = e.call(msg);
  const std::string tag = "{\"v\":1,\"re\":" + std::to_string(id) + ",";
  const std::size_t p = all.find(tag);
  if (p == std::string::npos) return {};
  int depth = 0;
  for (std::size_t i = p; i < all.size(); ++i) {
    depth += all[i] == '{' ? 1 : all[i] == '}' ? -1 : 0;
    if (depth == 0) return all.substr(p, i - p + 1);
  }
  return {};
}

void sineSong(OfflineEngine &e) {
  e.hello();
  e.call(R"({"v":1,"op":"audio","action":"start","id":2})");
  e.call(R"({"v":1,"op":"prepare","id":3,"patch":{"slots":[{"instrument":{"type":"test","id":"sine"},"gain":1.4,)"
         R"("params":{"attack":0.002,"release":0.05}},null,null,null]}})");
  e.call(R"({"v":1,"op":"commit","token":1,"when":0})");
}

}  // namespace

TEST_SUITE("rec") {
  TEST_CASE("16-bit conversion = recorder-processor.js (clamp, NaN -> 0, Math.round asymmetric scale)") {
    using W = rig::WavStreamWriter;
    CHECK(W::to16(0.0f) == 0);
    CHECK(W::to16(1.0f) == 32767);
    CHECK(W::to16(-1.0f) == -32768);
    CHECK(W::to16(2.5f) == 32767);
    CHECK(W::to16(-7.0f) == -32768);
    CHECK(W::to16(std::nanf("")) == 0);
    CHECK(W::to16(0.5f) == 16384);                 // Math.round(16383.5) = 16384 (half up)
    CHECK(W::to16(-0.5f) == -16384);               // Math.round(-16384) exact
    CHECK(W::to16(-1.0f / 65536.0f) == 0);         // Math.round(-0.5) = -0 (half towards +inf)
    CHECK(W::to24(1.0f) == 8388607);
    CHECK(W::to24(-1.0f) == -8388608);
  }

  TEST_CASE("offline round trip: the WAV holds exactly the rendered quanta, 16-bit, at the engine rate") {
    const std::string dir = tmp("_rt");
    OfflineEngine e(44100);
    sineSong(e);
    const std::string r = replyOf(e, R"({"v":1,"op":"rec","action":"start","dir":")" + dir + R"(","id":5})", 5);
    REQUIRE(contains(r, "\"ok\":true"));
    const std::string path = field(r, "path");
    REQUIRE(!path.empty());
    CHECK(std::regex_search(fs::path(path).filename().string(), std::regex(R"(^Rig \d{4}-\d\d-\d\d \d{4}\.wav$)")));
    e.call(R"({"v":1,"op":"play","e":"on","n":69,"vel":127,"when":0.01})");
    e.call(R"({"v":1,"op":"play","e":"off","n":69,"when":0.5})");
    std::vector<std::vector<float>> got(2);
    for (int k = 0; k < 40; ++k) {  // 40 x 3 quanta: the FIFO never runs ahead of the output
      auto out = e.render(384);
      for (int c = 0; c < 2; ++c) got[c].insert(got[c].end(), out[c].begin(), out[c].end());
    }
    const std::string s = replyOf(e, R"({"v":1,"op":"rec","action":"stop","id":6})", 6);
    CHECK(contains(s, "\"seconds\":"));
    CHECK(std::stod(field(s, "bytes")) == 44.0 + got[0].size() * 4.0);
    rig::io::WavData w;
    std::string err;
    REQUIRE(rig::io::readWav(path, w, &err));
    CHECK(w.sampleRate == 44100);
    REQUIRE(w.ch.size() == 2);
    REQUIRE(w.frames() == got[0].size());
    std::size_t mismatches = 0;
    float peak = 0;
    for (int c = 0; c < 2; ++c)
      for (std::size_t i = 0; i < w.frames(); ++i) {
        const int expect = rig::WavStreamWriter::to16(got[c][i]);
        const long back = std::lround(static_cast<double>(w.ch[c][i]) * 32768.0);
        if (back != expect) ++mismatches;
        peak = std::max(peak, std::fabs(got[c][i]));
      }
    CHECK(peak > 0.1f);  // not a silent take
    CHECK(mismatches == 0);
    fs::remove_all(dir);
  }

  TEST_CASE("24-bit, user filename (sanitised, .wav added), collisions get (2), errors") {
    const std::string dir = tmp("_names");
    OfflineEngine e;
    e.hello();
    // before the audio graph exists: not-started
    CHECK(contains(e.call(R"({"v":1,"op":"rec","action":"start","dir":")" + dir + R"(","id":1})"), "not-started"));
    sineSong(e);
    CHECK(contains(e.call(R"({"v":1,"op":"rec","action":"start","bits":8,"dir":")" + dir + R"(","id":2})"),
                   "bad-request"));
    CHECK(contains(e.call(R"({"v":1,"op":"rec","action":"start","dir":"/nonexistent/zz","id":3})"), "bad-request"));
    CHECK(contains(e.call(R"({"v":1,"op":"rec","action":"start","id":4})"), "bad-request"));  // no default dir
    const std::string start =
        R"({"v":1,"op":"rec","action":"start","bits":24,"filename":"../Take/One","dir":")" + dir + R"(","id":7})";
    std::string r = replyOf(e, start, 7);
    CHECK(fs::path(field(r, "path")).filename() == "TakeOne.wav");
    e.call(R"({"v":1,"op":"play","e":"on","n":60,"vel":100})");
    e.render(4096);
    e.call(R"({"v":1,"op":"rec","action":"stop","id":8})");
    rig::io::WavData w;
    REQUIRE(rig::io::readWav(field(r, "path"), w));
    CHECK(w.frames() == 4096);
    r = replyOf(e, start, 7);
    CHECK(fs::path(field(r, "path")).filename() == "TakeOne (2).wav");
    CHECK(contains(e.call(R"({"v":1,"op":"rec","action":"stop","id":9})"), "\"path\":"));
    CHECK(contains(e.call(R"({"v":1,"op":"rec","action":"stop","id":10})"), "\"path\":null"));  // not recording
    fs::remove_all(dir);
  }

  TEST_CASE("overflow accounting: a stalled writer drops whole quanta and counts them; nothing is overwritten") {
    auto *s = new rig::RecShared();
    rig::RecUnit u(s);
    rig::Bus b;
    b.clear(2);
    rig::UnitIO io;
    io.in = &b;
    rig::RenderContext ctx{0, 48000, 0, rig::UnitSlot::Recorder, nullptr};
    s->armed = true;
    const std::size_t cap = rig::RecShared::kFrames / 128;
    for (std::size_t q = 0; q < cap + 952; ++q) {
      b.ch[0][0] = static_cast<float>(q);
      u.process(ctx, io);
    }
    CHECK(s->head.load() == rig::RecShared::kFrames);
    CHECK(s->dropped.load() == 952u * 128u);
    CHECK(s->buf[(cap - 1) * 128 * 2] == static_cast<float>(cap - 1));  // the last kept quantum is intact
    s->armed = false;
    u.process(ctx, io);
    CHECK(s->dropped.load() == 952u * 128u);  // disarmed: no accounting
    delete s;
  }

  TEST_CASE("a rate change ends the take with a message (a WAV has one rate)") {
    const std::string dir = tmp("_rate");
    OfflineEngine e(48000);
    sineSong(e);
    REQUIRE(contains(e.call(R"({"v":1,"op":"rec","action":"start","dir":")" + dir + R"(","id":5})"), "\"ok\":true"));
    e.render(4800);
    rig_device_info info{};
    info.struct_size = sizeof info;
    info.sample_rate = 44100;
    info.channels = 2;
    rig_host_audio_started(e.e, &info);
    e.msgs.clear();
    e.render(1024);
    std::string all;
    for (auto &m : e.msgs) all += m;
    CHECK(contains(all, "\"state\":\"stopped\""));
    CHECK(contains(all, "sample rate changed"));
    CHECK(contains(e.call(R"({"v":1,"op":"rec","action":"stop","id":6})"), "\"path\":null"));
    fs::remove_all(dir);
  }

  TEST_CASE("realtime: the writer thread records off the audio thread; the header is valid while recording") {
    const std::string dir = tmp("_live");
    std::string all;
    std::mutex mu;
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.sample_rate = 48000;
    cfg.recordings_dir = dir.c_str();
    struct Sink {
      std::string *all;
      std::mutex *mu;
    } sink{&all, &mu};
    cfg.on_event = [](void *u, const char *j, size_t n) {
      auto *s = static_cast<Sink *>(u);
      std::lock_guard<std::mutex> lk(*s->mu);
      s->all->append(j, n);
    };
    cfg.event_user = &sink;
    rig_engine *e = rig_create(&cfg, nullptr);
    REQUIRE(e);
    auto post = [&](const std::string &m) { rig_post(e, m.data(), m.size()); };
    auto wait = [&](const char *needle, int ms) {
      for (int i = 0; i < ms; ++i) {
        {
          std::lock_guard<std::mutex> lk(mu);
          if (all.find(needle) != std::string::npos) return true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
      return false;
    };
    post(R"({"v":1,"op":"hello","protocol":1,"app":"t","id":1})");
    post(R"({"v":1,"op":"audio","action":"start","id":2})");
    post(R"({"v":1,"op":"prepare","id":3,"patch":{"slots":[{"instrument":{"type":"test","id":"saw"},"gain":1},)"
         R"(null,null,null]}})");
    post(R"({"v":1,"op":"commit","token":1,"id":4})");
    REQUIRE(wait("\"re\":4,", 3000));
    std::atomic<bool> stop{false};
    std::thread audio([&] {
      std::vector<float> l(441), r(441);
      float *p[2] = {l.data(), r.data()};
      auto next = std::chrono::steady_clock::now();
      while (!stop) {
        rig_render(e, p, 2, 441, 0);
        next += std::chrono::microseconds(9187);
        std::this_thread::sleep_until(next);
      }
    });
    post(R"({"v":1,"op":"rec","action":"start","id":5})");
    REQUIRE(wait("\"re\":5,", 3000));
    post(R"({"v":1,"op":"play","e":"on","n":57,"vel":100})");
    std::this_thread::sleep_for(std::chrono::milliseconds(1400));
    std::string path;
    {
      std::lock_guard<std::mutex> lk(mu);
      const auto p = all.find("\"path\":\"");
      REQUIRE(p != std::string::npos);
      path = all.substr(p + 8, all.find('"', p + 8) - p - 8);
    }
    rig::io::WavData mid;
    CHECK(rig::io::readWav(path, mid));  // header refreshed within 1 s: a crash now leaves a playable file
    CHECK(mid.frames() > 0);
    CHECK(wait("\"level\":{", 1000));
    post(R"({"v":1,"op":"rec","action":"stop","id":6})");
    REQUIRE(wait("\"re\":6,", 3000));
    stop = true;
    audio.join();
    rig_destroy(e);
    rig::io::WavData w;
    REQUIRE(rig::io::readWav(path, w));
    CHECK(w.frames() >= 48000);
    CHECK(w.frames() % 128 == 0);
    float pk = 0;
    for (float x : w.ch[0]) pk = std::max(pk, std::fabs(x));
    CHECK(pk > 0.05f);
    CHECK(!contains(all, "droppedFrames"));
    fs::remove_all(dir);
  }
}
