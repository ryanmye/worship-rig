// T05 test helpers shared by tests/test_delay.cpp, test_chorus.cpp, test_lofi.cpp: golden fixtures through the
// fixture runner at the exact tier, a direct unit driver (one unit, 128-frame quanta, an event sink), signal probes.
#pragma once
#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

#include "doctest.h"
#include "fixture_runner.h"
#include "graph/unit.h"
#include "helpers.h"
#include "io/wav.h"
#include "rig/rig_engine.h"

namespace t05 {

inline const std::string kGolden = std::string(RIG_REPO_DIR) + "/native/golden";

struct GoldenResult {
  bool present = false;
  double maxDiff = 0, peak = 0;
  long rtAllocs = 0;
};

/** Render `id` through rig::tools::runFixture (= rig_render) and compare with the golden WAV sample by sample. */
inline GoldenResult goldenRun(const std::string &id) {
  static std::vector<rig::tools::Fixture> all;
  if (all.empty()) {
    std::string err;
    REQUIRE(rig::tools::loadFixtures(kGolden + "/manifest.json", all, &err));
  }
  GoldenResult g;
  const auto it = std::find_if(all.begin(), all.end(), [&](const auto &f) { return f.id == id; });
  REQUIRE(it != all.end());
  rig::io::WavData gold;
  if (!rig::io::readWav(kGolden + "/out/" + id + ".wav", gold) &&
      !rig::io::readWav(kGolden + "/smoke/" + id + ".wav", gold)) {
    MESSAGE("golden WAV missing for " << id << " (node tools/golden/render.mjs --only " << id << "): skipped");
    return g;
  }
  g.present = true;
  const long before = rigtest::g_rtAllocs;
  const rig::tools::RunResult r = rig::tools::runFixture(*it, kGolden, 44100);
  g.rtAllocs = rigtest::g_rtAllocs - before;
  REQUIRE(r.ok);
  for (const auto &s : r.skipped) MESSAGE("skipped: " << s);
  CHECK(r.skipped.empty());
  REQUIRE(r.channels.size() == 2);
  for (int c = 0; c < 2; ++c) {
    REQUIRE(r.channels[c].size() == gold.ch[c].size());
    g.maxDiff = std::max(g.maxDiff, rigtest::maxAbsDiff(r.channels[c], gold.ch[c]));
    for (float v : gold.ch[c]) g.peak = std::max(g.peak, double(std::fabs(v)));
  }
  MESSAGE(id << ": max |native - golden| = " << g.maxDiff << ", golden peak " << g.peak);
  return g;
}

/** Drives one unit directly: stereo input per quantum -> output, frame counter, events swallowed. */
struct Driver {
  struct Sink final : rig::EventSink {
    std::vector<rig::AudioEvent> ev;
    bool push(const rig::AudioEvent &e) override {
      if (ev.size() < ev.capacity()) ev.push_back(e);
      return true;
    }
  } sink;
  rig::Unit *u;
  double sr;
  std::int64_t frame = 0;
  Driver(rig::Unit *unit, double rate) : u(unit), sr(rate) { sink.ev.reserve(4096); }

  /** Render `frames` (multiple of 128) with input in[c][frame] (absolute frames; missing = 0). */
  std::vector<std::vector<float>> run(std::size_t frames, const std::vector<std::vector<float>> &in = {}) {
    std::vector<std::vector<float>> out(2, std::vector<float>(frames));
    rig::Bus bi, bo;
    for (std::size_t q = 0; q < frames; q += rig::kQ) {
      bi.clear(2);
      for (int c = 0; c < 2; ++c)
        if (c < static_cast<int>(in.size()))
          for (std::size_t i = 0; i < rig::kQ; ++i) {
            const std::size_t f = static_cast<std::size_t>(frame) + i;
            bi.ch[c][i] = f < in[c].size() ? in[c][f] : 0.0f;
          }
      rig::RenderContext ctx{frame, sr, 0, rig::UnitSlot::Count, &sink};
      rig::UnitIO io;
      io.in = &bi;
      io.out = &bo;
      u->process(ctx, io);
      for (int c = 0; c < 2; ++c)
        for (std::size_t i = 0; i < rig::kQ && q + i < frames; ++i)
          out[c][q + i] = bo.channels == 1 ? bo.ch[0][i] : bo.ch[c][i];
      frame += static_cast<std::int64_t>(rig::kQ);
    }
    return out;
  }
  double now() const { return static_cast<double>(frame) / sr; }
};

inline rig::Command op(rig::Op o, double when, double a = 0, double b = 0, double c = 0, std::uint32_t aux = 0) {
  rig::Command cmd{};
  cmd.op = o;
  cmd.aux = aux;
  cmd.f.a = a;
  cmd.f.b = b;
  cmd.f.c = c;
  cmd.f.e = when;
  return cmd;
}

/** Second difference |x[i] - 2x[i-1] + x[i-2]| max over [t0, t1) (the JS click probe). */
inline double maxD2(const std::vector<float> &x, double sr, double t0, double t1) {
  double m = 0;
  for (std::size_t i = std::max<std::size_t>(2, static_cast<std::size_t>(t0 * sr));
       i < static_cast<std::size_t>(t1 * sr) && i < x.size(); ++i)
    m = std::max(m, std::fabs(double(x[i]) - 2 * double(x[i - 1]) + double(x[i - 2])));
  return m;
}

inline double peakAbs(const std::vector<float> &x, double sr, double t0, double t1) {
  double m = 0;
  for (std::size_t i = static_cast<std::size_t>(t0 * sr); i < static_cast<std::size_t>(t1 * sr) && i < x.size(); ++i)
    m = std::max(m, double(std::fabs(x[i])));
  return m;
}

}  // namespace t05
