// T06: processSample against the JS engine's own output (tools/golden/decode-dump/dump.mjs `proc` vectors: the golden
// Chromium's decode fed through app/js/engine/sampler.js processSample), plus synthetic edge cases.
#include <algorithm>
#include <cmath>
#include <cstdio>

#include "doctest.h"
#include "samples_util.h"

using namespace samplestest;
using rig::samples::DecodeOpts;
using rig::samples::Processed;

namespace {
std::vector<float> sine(std::size_t n, double hz, double sr, double amp = 0.5, std::size_t from = 0) {
  std::vector<float> v(n, 0.0f);
  for (std::size_t i = from; i < n; ++i)
    v[i] = static_cast<float>(amp * std::sin(2 * 3.14159265358979323846 * hz * static_cast<double>(i - from) / sr));
  return v;
}
}  // namespace

TEST_SUITE("samples_process") {
  TEST_CASE("processSample vs JS processSample on 6 files x 2 option variants") {
    Dump d;
    if (!d.ok()) {
      MESSAGE("decode-dump not generated: skipped");
      return;
    }
    double worst = 0;
    int rows = 0;
    std::printf("\n== processSample vs JS: file/variant, frames, channels, maxAbs, dualMono, capped, mono-fix mid/side\n");
    std::size_t i, n;
    yyjson_val *f;
    yyjson_arr_foreach(d.files, i, n, f) {
      yyjson_val *procs = yyjson_obj_get(f, "proc");
      if (!procs || yyjson_arr_size(procs) == 0) continue;
      rig::io::WavData raw;
      REQUIRE(readDump(std::string("raw44100/") + str(f, "key") + ".wav", raw));
      std::vector<float> in[2] = {raw.ch[0], raw.ch.size() > 1 ? raw.ch[1] : std::vector<float>()};
      std::size_t j, m;
      yyjson_val *p;
      yyjson_arr_foreach(procs, j, m, p) {
        rig::io::WavData ref;
        REQUIRE(readDump(str(p, "file"), ref));
        const DecodeOpts opts = optsOf(yyjson_obj_get(p, "opts"));
        Processed out = rig::samples::processSample(in, static_cast<int>(raw.ch.size()), 44100,
                                                    static_cast<int>(num(f, "midi")), opts);
        REQUIRE(static_cast<int>(out.channels) == static_cast<int>(ref.ch.size()));
        REQUIRE(out.frames == ref.frames());
        double mx = 0;
        for (int c = 0; c < out.channels; ++c)
          for (std::size_t k = 0; k < out.frames; ++k)
            mx = std::max(mx, std::fabs(static_cast<double>(out.ch[c][k]) - static_cast<double>(ref.ch[static_cast<std::size_t>(c)][k])));
        CHECK(out.dualMono == yyjson_get_bool(yyjson_obj_get(p, "dualMono")));
        CHECK(out.capped == yyjson_get_bool(yyjson_obj_get(p, "capped")));
        CHECK(static_cast<double>(out.natural) == num(p, "natural"));
        CHECK(out.onsetTrim == doctest::Approx(num(p, "onsetTrim")).epsilon(1e-12));
        yyjson_val *mf = yyjson_obj_get(p, "monoFix");
        const bool hasFix = mf && yyjson_is_obj(mf);
        CHECK(out.monoFix.applied == hasFix);
        double mid = 1, side = 1;
        if (hasFix) {
          mid = num(mf, "mid");
          side = num(mf, "side");
          CHECK(out.monoFix.lossDb == doctest::Approx(num(mf, "lossDb")).epsilon(1e-9));
          CHECK(out.monoFix.mid == doctest::Approx(mid).epsilon(1e-9));
          CHECK(out.monoFix.side == doctest::Approx(side).epsilon(1e-9));
        }
        std::printf("%-30s %-4s %7zu %d  %.3e  mono=%d capped=%d fix=%s mid/side %.6f/%.6f\n", str(f, "key"),
                    str(p, "variant"), out.frames, out.channels, mx, out.dualMono, out.capped, hasFix ? "yes" : "no",
                    out.monoFix.mid, out.monoFix.side);
        worst = std::max(worst, mx);
        ++rows;
        CHECK(mx <= 1e-6);
      }
    }
    std::printf("   %d vectors, worst max abs error %.3e\n", rows, worst);
    CHECK(rows == 12);
  }

  TEST_CASE("onset trim keeps 1 ms of pre-roll and fades in over 2 ms") {
    const double sr = 48000;
    std::vector<float> in[2] = {sine(48000, 440, sr, 0.5, 4800), {}};  // silence for 100 ms, then a sine
    auto o = rig::samples::processSample(in, 1, sr, 60, DecodeOpts{});
    CHECK(o.channels == 1);
    CHECK(o.onsetTrim == doctest::Approx(0.099).epsilon(1e-9));  // first sample above -50 dBFS is a few frames after
    CHECK(o.natural == o.frames);
    CHECK_FALSE(o.capped);
    CHECK(o.ch[0][0] == 0.0f);  // raised-cosine fade starts at 0
    CHECK(o.ch[0].size() == o.frames);
  }

  TEST_CASE("cap: length limited, 1 s fade-out only when truncated, legacy 10 s / 16 s rule") {
    const double sr = 8000;
    std::vector<float> in[2] = {sine(static_cast<std::size_t>(20 * sr), 220, sr, 0.8), {}};
    DecodeOpts o3;
    o3.maxSec = 3;
    auto a = rig::samples::processSample(in, 1, sr, 60, o3);
    CHECK(a.frames == static_cast<std::size_t>(3 * sr));
    CHECK(a.capped);
    CHECK(a.ch[0].back() == 0.0f);
    CHECK(std::fabs(a.ch[0][a.frames - 1 - 4000]) <= 0.8f * 0.5f + 1e-3f);  // mid fade
    auto lo = rig::samples::processSample(in, 1, sr, 60, DecodeOpts{});   // <= C4: 16 s
    auto hi = rig::samples::processSample(in, 1, sr, 72, DecodeOpts{});   // > C4: 10 s
    CHECK(lo.frames == static_cast<std::size_t>(16 * sr));
    CHECK(hi.frames == static_cast<std::size_t>(10 * sr));
    CHECK(lo.capped);
    std::vector<float> shortIn[2] = {sine(4000, 220, sr, 0.8), {}};
    auto s = rig::samples::processSample(shortIn, 1, sr, 60, DecodeOpts{});
    CHECK_FALSE(s.capped);
    CHECK(s.ch[0].back() != 0.0f);  // no fade-out when not truncated
  }

  TEST_CASE("dual mono collapses within max(1e-3 peak, 2^-12), real stereo stays") {
    const double sr = 8000;
    std::vector<float> L = sine(8000, 330, sr, 0.9);
    std::vector<float> R = L;
    std::vector<float> in[2] = {L, R};
    CHECK(rig::samples::processSample(in, 2, sr, 60, DecodeOpts{}).channels == 1);
    // decoder-noise sized difference (-72 dBFS floor): still dual mono
    for (std::size_t i = 0; i < R.size(); ++i) R[i] += (i % 2 ? 1.0f : -1.0f) * 1e-4f;
    std::vector<float> in2[2] = {L, R};
    auto n = rig::samples::processSample(in2, 2, sr, 60, DecodeOpts{});
    CHECK(n.channels == 1);
    CHECK(n.dualMono);
    CHECK(n.lrDiff <= 1.1e-4);
    // a real side signal stays stereo and reports an early stop as infinity
    for (std::size_t i = 0; i < R.size(); ++i) R[i] = -L[i];
    std::vector<float> in3[2] = {L, R};
    auto st = rig::samples::processSample(in3, 2, sr, 60, DecodeOpts{});
    CHECK(st.channels == 2);
    CHECK(std::isinf(st.lrDiff));
  }

  TEST_CASE("mono-loss limiter keeps stereo RMS and limits the mono-sum loss") {
    const double sr = 8000;
    std::vector<float> L = sine(16000, 200, sr, 0.5);
    std::vector<float> R(L.size());
    for (std::size_t i = 0; i < L.size(); ++i) R[i] = static_cast<float>(-0.9 * L[i]);  // nearly anti-phase
    std::vector<float> in[2] = {L, R};
    DecodeOpts o;
    o.hasMaxMonoLoss = true;
    o.maxMonoLossDb = 3;
    auto r = rig::samples::processSample(in, 2, sr, 60, o);
    REQUIRE(r.channels == 2);
    CHECK(r.monoFix.applied);
    CHECK(r.monoFix.lossDb > 3);
    double sst = 0, mm = 0, ss = 0, before = 0;
    const std::size_t skip = 200;  // past the 2 ms fade
    for (std::size_t i = skip; i < r.frames; ++i) {
      const double l = r.ch[0][i], rr = r.ch[1][i];
      mm += 0.25 * (l + rr) * (l + rr);
      ss += 0.25 * (l - rr) * (l - rr);
      sst += l * l + rr * rr;
      before += static_cast<double>(L[i + 0]) * L[i] + static_cast<double>(R[i]) * R[i];
    }
    CHECK(10 * std::log10((mm + ss) / mm) == doctest::Approx(3.0).epsilon(0.02));
    CHECK(sst / before == doctest::Approx(1.0).epsilon(0.02));  // loudness in stereo unchanged
    // no fix on mono-collapsed or when the loss is already under the cap
    std::vector<float> in2[2] = {L, L};
    CHECK_FALSE(rig::samples::processSample(in2, 2, sr, 60, o).monoFix.applied);
  }
}
