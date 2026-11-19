// rig_bench: render-throughput baseline (128-frame quanta per second) of the empty graph and of N test voices.
//   rig_bench [seconds_of_audio_per_case=20] [sample_rate=48000]
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "rig/rig_engine.h"

static void post(rig_engine *e, const std::string &m) { rig_post(e, m.data(), m.size()); }

static double run(const char *label, int voices, double seconds, double sr, bool eq) {
  rig_config cfg;
  rig_config_init(&cfg);
  cfg.mode = RIG_MODE_OFFLINE;
  cfg.sample_rate = sr;
  cfg.seed = 1;
  rig_engine *e = rig_create(&cfg, nullptr);
  post(e, R"({"v":1,"op":"hello","protocol":1})");
  std::string slots = "[";
  const int perSlot = (voices + 3) / 4;
  for (int s = 0; s < 4; ++s) {
    slots += s ? "," : "";
    slots += voices ? std::string(R"({"instrument":{"type":"test","id":")") + (s % 2 ? "saw" : "sine") +
                          R"("},"gain":0.5,"params":{"attack":0.01,"sustain":0.7,"release":0.2})" +
                          (eq ? R"(,"eq":{"b4":{"on":true,"type":"peak","hz":1000,"db":6,"q":1},"cutHz":80})" : "") + "}"
                    : "null";
  }
  slots += "]";
  post(e, R"({"v":1,"op":"prepare","id":1,"patch":{"slots":)" + slots + "}}");
  post(e, R"({"v":1,"op":"commit","token":1,"when":0})");
  for (int v = 0; v < perSlot; ++v)
    post(e, R"({"v":1,"op":"play","e":"on","n":)" + std::to_string(48 + v * 2) + R"(,"vel":100})");
  std::vector<float> l(128 * 64), r(128 * 64);
  float *out[2] = {l.data(), r.data()};
  const long total = static_cast<long>(seconds * sr / (128 * 64)) * 64;
  rig_offline_render(e, out, 2, 128 * 64);  // warm-up
  const auto t0 = std::chrono::steady_clock::now();
  for (long q = 0; q < total; q += 64) rig_offline_render(e, out, 2, 128 * 64);
  const double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  rig_meters m{};
  m.struct_size = sizeof m;
  rig_get_meters(e, &m);
  const double bps = static_cast<double>(total) / dt;
  std::printf("%-34s %9.0f blocks/s  %7.0f x realtime  (%.3f%% of one core at %.0f Hz)  voices live %u\n", label, bps,
              bps * 128 / sr, 100.0 / (bps * 128 / sr), sr, m.voices);
  rig_destroy(e);
  return bps;
}

int main(int argc, char **argv) {
  const double seconds = argc > 1 ? std::atof(argv[1]) : 20.0;
  const double sr = argc > 2 ? std::atof(argv[2]) : 48000.0;
  run("empty graph", 0, seconds, sr, false);
  run("4 strips, 0 voices (slots attached)", 0, seconds, sr, false);
  run("32 test voices (4 strips)", 32, seconds, sr, false);
  run("32 test voices + EQ (hp80 + peak)", 32, seconds, sr, true);
  return 0;
}
