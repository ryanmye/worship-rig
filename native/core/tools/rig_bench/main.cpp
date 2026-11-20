// rig_bench: render-throughput baseline (128-frame quanta per second) of the empty graph and of N test voices, and
// the CPU cost of the reverb (T04, ARCHITECTURE 2.1 budgets; BUILD_PLAN T04: one unit <= 8 % of one core here).
//   rig_bench [seconds_of_audio_per_case=20] [sample_rate=48000] [--reverb-only]
// Exit status 1 when the reverb unit exceeds its budget on this machine (per-quantum cost = thread CPU time, so a
// loaded shared box measures the DSP, not the scheduler; wall-clock figures are printed beside it).
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <time.h>

#include "fx/reverb_unit.h"
#include "num/prng.h"
#include "rig/rig_engine.h"

static void post(rig_engine *e, const std::string &m) {
  rig_post(e, m.data(), m.size());
}

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
    slots += voices
                 ? std::string(R"({"instrument":{"type":"test","id":")") + (s % 2 ? "saw" : "sine") +
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

struct UnitCost {
  double meanUs, p999Us, maxUs, pctCore;
};

/** Thread CPU time in microseconds: a quantum's cost without the time the thread spent preempted (this box runs
 *  several builds at once; wall-clock p99.9 is then the scheduler tick, not the DSP). */
static double threadCpuUs() {
  timespec ts{};
  clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts);
  return static_cast<double>(ts.tv_sec) * 1e6 + static_cast<double>(ts.tv_nsec) * 1e-3;
}

/** The reverb render unit alone (HPF, LPF, predelay lines, convolvers, gains) fed continuous stereo noise:
 *  `spaces` units rendering at once (2 = a unit crossfade), mean and worst microseconds per 128-frame quantum. */
static UnitCost reverbUnit(const char *label, double sr, double seconds, const std::vector<double> &sizes) {
  using namespace rig;
  fx::ReverbUnit unit(sr, 1.0);
  for (std::size_t i = 0; i < sizes.size(); ++i) {
    auto *cu = new fx::ConvUnit(fx::ReverbKernel::build(sr, 1, sizes[i], 0.25), sr);
    cu->slot = static_cast<unsigned>(i);
    cu->predelay = 0.03;
    if (i == 0) {
      unit.installInitial(cu);
    } else {  // a crossfade that never ends: both units fed, both rendering
      cu->when = 0;
      cu->fade = 1e6;
      Command c{};
      c.op = opOf(ReverbOp::AttachKernel);
      c.sub = kSubOwnedPayload;
      c.p.ptr = static_cast<Owned *>(cu);
      unit.apply(c);
    }
  }
  struct Sink final : EventSink {
    bool push(const AudioEvent &e) override {
      if (e.kind == EventKind::Garbage) delete static_cast<Owned *>(e.ptr);
      return true;
    }
  } sink;
  Mulberry32 rng(7);
  Bus in, out;
  in.channels = 2;
  UnitIO io;
  io.in = &in;
  io.out = &out;
  const long quanta = static_cast<long>(seconds * sr / 128);
  double total = 0, worst = 0, wallTotal = 0, wallWorst = 0;
  std::vector<double> each, wall;
  each.reserve(static_cast<std::size_t>(quanta));
  wall.reserve(static_cast<std::size_t>(quanta));
  for (long q = -64; q < quanta; ++q) {  // 64 warm-up quanta
    for (int c = 0; c < 2; ++c)
      for (std::size_t i = 0; i < kQ; ++i) in.ch[c][i] = static_cast<float>((rng.next() * 2 - 1) * 0.25);
    const long f = q + 64;
    RenderContext ctx{static_cast<std::int64_t>(f) * 128, sr, static_cast<std::uint64_t>(f), UnitSlot::Reverb, &sink};
    const double c0 = threadCpuUs();
    const auto t0 = std::chrono::steady_clock::now();
    unit.process(ctx, io);
    const double wus = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count();
    const double us = threadCpuUs() - c0;
    if (q < 0) continue;
    total += us;
    worst = std::max(worst, us);
    each.push_back(us);
    wallTotal += wus;
    wallWorst = std::max(wallWorst, wus);
    wall.push_back(wus);
  }
  std::sort(each.begin(), each.end());
  std::sort(wall.begin(), wall.end());
  const auto p999of = [](const std::vector<double> &v) { return v[std::min(v.size() - 1, v.size() * 999 / 1000)]; };
  const double p999 = p999of(each);
  const double mean = total / static_cast<double>(quanta);
  const double period = 128.0 / sr * 1e6;
  std::printf("%-40s CPU %6.2f us/quantum mean = %5.2f%% of one core; p99.9 %6.1f us (%4.1f%% of the %.0f us "
              "period), max %6.1f us\n",
              label, mean, 100.0 * mean / period, p999, 100.0 * p999 / period, period, worst);
  std::printf("%-40s wall %5.2f us mean, p99.9 %6.1f us, max %6.1f us (includes preemption)\n", "",
              wallTotal / static_cast<double>(quanta), p999of(wall), wallWorst);
  return {mean, p999, worst, 100.0 * mean / period};
}

int main(int argc, char **argv) {
  double seconds = 20.0, sr = 48000.0;
  bool reverbOnly = false;
  int pos = 0;
  for (int i = 1; i < argc; ++i) {
    if (!std::strcmp(argv[i], "--reverb-only")) {
      reverbOnly = true;
      continue;
    }
    (pos++ == 0 ? seconds : sr) = std::atof(argv[i]);
  }
  if (!reverbOnly) {
    run("empty graph", 0, seconds, sr, false);
    run("32 test voices (4 strips)", 32, seconds, sr, false);
    run("32 test voices + EQ (hp80 + peak)", 32, seconds, sr, true);
  }
  const UnitCost room = reverbUnit("reverb unit, 1.5 s space (room)", sr, seconds, {0.18});
  const UnitCost big = reverbUnit("reverb unit, 8 s space (wash, 10.6 s IR)", sr, seconds, {1.0});
  const UnitCost xf = reverbUnit("reverb crossfade, 8 s + 6.5 s spaces", sr, seconds, {1.0, 0.65});
  (void)room;
  (void)xf;
  const double budget = 8.0;  // BUILD_PLAN T04: one reverb unit <= 8 % of one core on this box at 48 kHz
  // thread CPU time: the max can still hold a page fault or a cache-cold quantum; the p99.9 quantum is what the
  // DSP itself costs at its worst phase
  const bool ok = big.pctCore <= budget && big.p999Us <= 0.5 * 128.0 / sr * 1e6;
  std::printf("reverb budget (8 s unit <= %.0f%% of one core, p99.9 quantum below 50%% of its period): %s\n", budget,
              ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}
