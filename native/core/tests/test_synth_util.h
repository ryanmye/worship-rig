// T11 test helpers (tests/test_synth*.cpp, test_voice_alloc*.cpp): golden fixtures through the fixture runner
// (= rig_render) compared sample by sample, and a direct driver for one instrument unit (128-frame quanta, every
// command applied and every quantum rendered inside rt::RenderScope, so the allocation trap sees the audio thread).
#pragma once
#include <algorithm>
#include <cmath>
#include <memory>
#include <string>
#include <vector>

#include "doctest.h"
#include "fixture_runner.h"
#include "graph/unit.h"
#include "helpers.h"
#include "inst/synth.h"
#include "io/wav.h"
#include "runtime/command.h"
#include "runtime/rt_guard.h"

namespace t11 {

inline const std::string kGolden = std::string(RIG_REPO_DIR) + "/native/golden";

struct GoldenResult {
  bool present = false;
  double maxDiff = 0, peak = 0;
  long rtAllocs = 0;
  std::vector<std::string> skipped;
};

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
  if (!rig::io::readWav(kGolden + "/out/" + id + ".wav", gold)) {
    MESSAGE("golden WAV missing for " << id << " (node tools/golden/render.mjs --only " << id << "): skipped");
    return g;
  }
  g.present = true;
  const long before = rigtest::g_rtAllocs;
  const rig::tools::RunResult r = rig::tools::runFixture(*it, kGolden, 44100);
  g.rtAllocs = rigtest::g_rtAllocs - before;
  REQUIRE(r.ok);
  g.skipped = r.skipped;
  REQUIRE(r.channels.size() == 2);
  for (int c = 0; c < 2; ++c) {
    REQUIRE(r.channels[c].size() == gold.ch[c].size());
    g.maxDiff = std::max(g.maxDiff, rigtest::maxAbsDiff(r.channels[c], gold.ch[c]));
    for (float v : gold.ch[c]) g.peak = std::max(g.peak, double(std::fabs(v)));
  }
  MESSAGE(id << ": max |native - golden| = " << g.maxDiff << ", golden peak " << g.peak);
  return g;
}

/** One instrument unit driven directly. */
struct Driver {
  struct Sink final : rig::EventSink {
    std::vector<rig::AudioEvent> ev;
    bool push(const rig::AudioEvent &e) override {
      if (ev.size() < ev.capacity()) ev.push_back(e);
      return true;
    }
  } sink;
  std::unique_ptr<rig::Unit> u;
  double sr;
  std::int64_t frame = 0;
  long rtAllocs = 0;
  rig::UnitSlot self = rig::UnitSlot::Inst0;
  Driver(rig::Unit *unit, double rate) : u(unit), sr(rate) { sink.ev.reserve(1 << 14); }
  ~Driver() {
    for (auto &e : sink.ev)  // payloads handed back (Garbage): free them as the control thread would
      if (e.kind == rig::EventKind::Garbage) delete static_cast<rig::Owned *>(e.ptr);
  }

  /** Apply a command inside the audio-thread scope (as the graph does at the start of a quantum). */
  void apply(const rig::Command &c) {
    const long before = rigtest::g_rtAllocs;
    {
      rig::rt::RenderScope rs;
      u->apply(c);
    }
    rtAllocs += rigtest::g_rtAllocs - before;
  }
  void noteOn(int note, int vel, double t) {
    rig::Command c{};
    c.op = rig::Op::NoteOn;
    c.frame = std::llround(t * sr);
    c.aux = static_cast<std::uint32_t>(note) | (static_cast<std::uint32_t>(vel) << 8);
    apply(c);
  }
  void noteOff(int note, double t) {
    rig::Command c{};
    c.op = rig::Op::NoteOff;
    c.frame = std::llround(t * sr);
    c.aux = static_cast<std::uint32_t>(note);
    apply(c);
  }
  /** Render `frames` (rounded up to whole quanta); returns {L, R} (R = L for a mono unit). */
  std::vector<std::vector<float>> run(std::size_t frames) {
    frames = (frames + rig::kQ - 1) / rig::kQ * rig::kQ;
    std::vector<std::vector<float>> out(2, std::vector<float>(frames));
    rig::Bus bo;
    for (std::size_t q = 0; q < frames; q += rig::kQ) {
      rig::RenderContext ctx{frame, sr, 0, self, &sink};
      rig::UnitIO io;
      io.out = &bo;
      const long before = rigtest::g_rtAllocs;
      {
        rig::rt::RenderScope rs;
        u->process(ctx, io);
      }
      rtAllocs += rigtest::g_rtAllocs - before;
      for (std::size_t i = 0; i < rig::kQ; ++i) {
        out[0][q + i] = bo.ch[0][i];
        out[1][q + i] = bo.channels == 2 ? bo.ch[1][i] : bo.ch[0][i];
      }
      frame += static_cast<std::int64_t>(rig::kQ);
    }
    return out;
  }
  std::size_t count(rig::EventKind k) const {
    return static_cast<std::size_t>(
        std::count_if(sink.ev.begin(), sink.ev.end(), [&](auto &e) { return e.kind == k; }));
  }
};

inline rig::inst::SynthInstrument *makeSynth(const char *id, double sr = 48000, const char *params = "{}",
                                             double release = 0) {
  const rig::inst::PatchDef *p = rig::inst::findPatch(id);
  REQUIRE(p != nullptr);
  return new rig::inst::SynthInstrument(*p, sr, 1, std::string("inst|0|synth|") + id + "|1", params, release);
}

inline double rms(const std::vector<float> &x, std::size_t a, std::size_t b) {
  double s = 0;
  for (std::size_t i = a; i < b && i < x.size(); ++i) s += double(x[i]) * x[i];
  return b > a ? std::sqrt(s / double(b - a)) : 0;
}

/** Frequency from upward zero crossings with linear interpolation over [a, b). */
inline double zeroCrossHz(const std::vector<float> &x, std::size_t a, std::size_t b, double sr) {
  double first = -1, last = -1;
  int n = 0;
  for (std::size_t i = a + 1; i < b && i < x.size(); ++i) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const double pos = double(i - 1) + double(-x[i - 1]) / double(x[i] - x[i - 1]);
      if (first < 0) first = pos;
      else ++n;
      last = pos;
    }
  }
  return n > 0 ? n * sr / (last - first) : 0;
}

}  // namespace t11
