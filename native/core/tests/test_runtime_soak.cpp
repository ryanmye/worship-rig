// T08 soak (R15): a fake host renders in real time with 128 / 256 / 441-frame blocks (switching every second) while
// four other threads post bridge traffic (notes, sets, prepare/commit, meters, recordings, device restarts that
// change the rate 48k <-> 44.1k), feed MIDI and read meters / the clock. Run under g++ TSan as the 10-minute soak:
//   RIG_SOAK_SECONDS=600 ./rig_tests -ts=soak
// ctest runs the short version (RIG_SOAK_SECONDS unset: 4 s).
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <mutex>
#include <random>
#include <string>
#include <unistd.h>
#include <thread>
#include <vector>

#include "api/engine.h"
#include "doctest.h"
#include "rig/rig_engine.h"

namespace {

struct Soak {
  rig_engine *e = nullptr;
  rig_host host{};
  std::atomic<bool> stop{false};
  std::atomic<unsigned> block{128};
  std::atomic<double> rate{48000};
  std::atomic<long> replies{0}, internal{0}, ticks{0}, stateRunning{0}, renders{0};
  std::atomic<bool> nonMonotonic{false};
  std::mutex mu;
  std::string lastBatch;
};

Soak *g_soak = nullptr;

void onEvent(void *u, const char *j, size_t n) {
  auto *s = static_cast<Soak *>(u);
  const std::string_view v(j, n);
  for (std::size_t p = v.find("\"re\":"); p != std::string_view::npos; p = v.find("\"re\":", p + 1)) ++s->replies;
  for (std::size_t p = v.find("\"ev\":\"tick\""); p != std::string_view::npos; p = v.find("\"ev\":\"tick\"", p + 1))
    ++s->ticks;
  if (v.find("\"code\":\"internal\"") != std::string_view::npos) ++s->internal;
  if (v.find("\"state\":\"running\"") != std::string_view::npos) ++s->stateRunning;
}

}  // namespace

TEST_SUITE("soak") {
  TEST_CASE("realtime soak: 128/256/441-frame blocks, rate changes, 5 threads (TSan target)") {
    const char *env = std::getenv("RIG_SOAK_SECONDS");
    const double seconds = env ? std::atof(env) : 4.0;
    const std::string dir =
        (std::filesystem::temp_directory_path() / ("rig_t08_soak_" + std::to_string(::getpid()))).string();
    std::filesystem::create_directories(dir);
    Soak s;
    g_soak = &s;
    s.host.struct_size = sizeof s.host;
    s.host.user = &s;
    s.host.audio_start = [](void *u, const char *, double, uint32_t ch) {
      auto *so = static_cast<Soak *>(u);
      // every (re)start alternates the device rate: the engine rebases its clock and services rebuild
      const double sr = so->rate.load() == 48000 ? 44100 : 48000;
      so->rate = sr;
      rig_device_info info{};
      info.struct_size = sizeof info;
      info.sample_rate = sr;
      info.channels = ch;
      info.buffer_frames = so->block;
      info.output_latency_sec = 0.006;
      info.device_id = "soak";
      rig_host_audio_started(so->e, &info);
    };
    s.host.audio_stop = [](void *) {};
    rig_config cfg;
    rig_config_init(&cfg);
    cfg.sample_rate = 48000;
    cfg.recordings_dir = dir.c_str();
    cfg.host = &s.host;
    cfg.on_event = onEvent;
    cfg.event_user = &s;
    s.e = rig_create(&cfg, nullptr);
    REQUIRE(s.e);
    auto post = [&](const std::string &m) { return rig_post(s.e, m.data(), m.size()); };
    long ids = 0;
    auto req = [&](const std::string &body) {
      ++ids;
      post(R"({"v":1,"id":)" + std::to_string(ids) + "," + body + "}");
    };
    req(R"("op":"hello","protocol":1,"app":"soak")");
    req(R"("op":"audio","action":"start")");

    std::thread audio([&] {  // the device IO thread
      const unsigned sizes[] = {128, 256, 441};
      std::vector<float> l(512), r(512), a(512), b(512);
      float *p[4] = {l.data(), r.data(), a.data(), b.data()};
      auto next = std::chrono::steady_clock::now();
      const auto t0 = next;
      std::uint64_t host = 1;
      while (!s.stop) {
        const auto el = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        const unsigned n = sizes[static_cast<unsigned>(el) % 3];
        s.block = n;
        rig_render(s.e, p, 4, n, host);
        ++s.renders;
        const double sr = s.rate.load();
        host += static_cast<std::uint64_t>(n * 1e9 / sr);
        next += std::chrono::nanoseconds(static_cast<long long>(n * 1e9 / sr));
        std::this_thread::sleep_until(next);
      }
    });
    std::thread midi([&] {
      const std::uint8_t on[] = {0x90, 64, 90}, off[] = {0x80, 64, 0}, cc[] = {0xB0, 1, 40};
      for (int i = 0; !s.stop; ++i) {
        rig_midi_in(s.e, i % 2 ? "port-a" : "port-b", i % 3 == 0 ? on : i % 3 == 1 ? off : cc, 3, 0);
        std::this_thread::sleep_for(std::chrono::microseconds(1500));
      }
    });
    std::thread meters([&] {
      double last = 0;
      while (!s.stop) {
        rig_meters m{};
        m.struct_size = sizeof m;
        rig_get_meters(s.e, &m);
        const double t = rig_engine_time(s.e);
        if (t < last) s.nonMonotonic = true;
        last = t;
        std::this_thread::sleep_for(std::chrono::microseconds(700));
      }
    });
    std::thread hostEvents([&] {  // hot-plug, memory pressure and MIDI port lists from "the OS"
      for (int i = 0; !s.stop; ++i) {
        if (i % 3 == 0) rig_host_devices_changed(s.e);
        if (i % 7 == 0) rig_host_memory_pressure(s.e, 1);
        const char *ports = R"([{"id":"port-a","name":"A"},{"id":"port-b","name":"B"}])";
        rig_host_midi_ports(s.e, ports, std::strlen(ports));
        std::this_thread::sleep_for(std::chrono::milliseconds(170));
      }
    });

    std::mt19937 rng(7);
    const auto end = std::chrono::steady_clock::now() + std::chrono::duration<double>(seconds);
    int token = 0;
    bool rec = false;
    for (int step = 0; std::chrono::steady_clock::now() < end; ++step) {
      const int note = 48 + static_cast<int>(rng() % 24);
      switch (rng() % 12) {
        case 0:
        case 1:
          post(R"({"v":1,"op":"play","e":"on","n":)" + std::to_string(note) + R"(,"vel":90})");
          break;
        case 2:
        case 3:
          post(R"({"v":1,"op":"play","e":"off","n":)" + std::to_string(note) + "}");
          break;
        case 4:
          req(R"("op":"set","path":"slots.0.gain","value":)" + std::to_string((rng() % 100) / 100.0));
          break;
        case 5:
          req(R"("op":"prepare","patch":{"slots":[{"instrument":{"type":"test","id":"sine"},"gain":0.7},)"
              R"({"instrument":{"type":"test","id":"saw"},"gain":0.3},null,null]})");
          req(R"("op":"commit","token":)" + std::to_string(++token));
          break;
        case 6:
          req(std::string(R"("op":"config","meters":{"rate":30,"slots":[0,1],"rta":)") +
              (rng() % 2 ? "true" : "false") + "}");
          break;
        case 7:
          req(R"("op":"get","what":"stats")");
          break;
        case 8:
          req(rec ? R"("op":"rec","action":"stop")" : R"("op":"rec","action":"start")");
          rec = !rec;
          break;
        case 9:
          if (step % 40 == 9) req(R"("op":"audio","action":"restart")");  // rate change through the host
          break;
        case 10:
          if (step % 60 == 10) {
            req(R"("op":"audio","action":"sleep","ramp":0.02)");
            std::this_thread::sleep_for(std::chrono::milliseconds(80));
            req(R"("op":"audio","action":"wake")");
          }
          break;
        default:
          post(R"({"v":1,"op":"play","e":"panic"})");
          break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(5 + rng() % 20));
    }
    if (rec) req(R"("op":"rec","action":"stop")");
    // every id gets its reply (queue drained within 2 s)
    for (int i = 0; i < 2000 && s.replies.load() < ids; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    s.stop = true;
    audio.join();
    midi.join();
    meters.join();
    hostEvents.join();
    rig::Engine &en = *reinterpret_cast<rig::Engine *>(s.e);
    const auto &st = en.graph().stats();
    MESSAGE("soak " << seconds << " s: renders " << s.renders.load() << ", requests " << ids << ", replies "
                    << s.replies.load() << ", ticks " << s.ticks.load() << ", rate changes " << st.rateChanges.load()
                    << ", events dropped " << st.eventsDropped.load() << ", garbage parked "
                    << st.garbageParked.load());
    CHECK(s.replies.load() == ids);
    CHECK(s.internal.load() == 0);
    CHECK(!s.nonMonotonic.load());
    CHECK(st.garbageLost.load() == 0);
    CHECK(s.ticks.load() > 0);
    CHECK(s.stateRunning.load() >= 1);
    rig_destroy(s.e);
    std::filesystem::remove_all(dir);
  }
}
