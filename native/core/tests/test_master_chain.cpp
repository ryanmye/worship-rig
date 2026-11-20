// T03 master chain through the engine (C API, offline): ports of the JS engine tests monoCeilingAndMakeup,
// glueEngageNoDip and the engine-side parts of masterEqGlue (test/phase1/engine/suites.mjs). The JS tests drive
// instruments that land in later waves; here the same signals are injected at fx.eqIn (= the JS `e.fx.sum` with lofi
// off), so only the master chain is under test. Statistical checks use the JS tolerances; identity checks are exact.
// Also: the mono sum (fx.js setMono, needed by fx-row-sweep) and a CPU measurement of the chain (printed only).
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <string>
#include <utility>
#include <vector>

#include "doctest.h"
#include "dsp/compressor.h"
#include "dsp/waveshaper.h"
#include "fixture_runner.h"
#include "helpers.h"
#include "io/wav.h"
#include "mix/master_chain_tables.h"

using namespace rigtest;

namespace {

constexpr double kSr = 44100;
constexpr double kPi = 3.14159265358979323846;

double db(double x) {
  return 20 * std::log10(x);
}
double rms(const std::vector<float> &x, double a, double b) {
  const auto i0 = static_cast<std::size_t>(a * kSr), i1 = std::min(x.size(), static_cast<std::size_t>(b * kSr));
  double s = 0;
  for (std::size_t i = i0; i < i1; ++i) s += double(x[i]) * double(x[i]);
  return std::sqrt(s / static_cast<double>(i1 - i0));
}
double peakAbs(const std::vector<float> &x, double a, double b) {
  double m = 0;
  for (auto i = static_cast<std::size_t>(a * kSr); i < std::min(x.size(), static_cast<std::size_t>(b * kSr)); ++i)
    m = std::max(m, std::fabs(double(x[i])));
  return m;
}
long tokenOf(const std::string &reply) {
  const std::size_t p = reply.find("\"token\":");
  return p == std::string::npos ? -1 : std::strtol(reply.c_str() + p + 8, nullptr, 10);
}

std::string num(double v) {
  char b[40];
  std::snprintf(b, sizeof b, "%.17g", v);
  return b;
}

/** hello, audio start, prepare + commit at 0 of an empty patch with these FX master rows, then tap `tap`. */
void start(OfflineEngine &e, double amount, double volume, const char *tap, const std::string &eq = "") {
  e.hello();
  e.call(R"({"v":1,"op":"audio","action":"start","id":3})");
  const std::string fx = R"({"comp":{"amount":)" + num(amount) + R"(},"master":{"volume":)" + num(volume) + "}" +
                         (eq.empty() ? "" : "," + eq) + "}";
  const long tok =
      tokenOf(e.call(R"({"v":1,"op":"prepare","id":4,"patch":{"slots":[null,null,null,null],"fx":)" + fx + "}}"));
  REQUIRE(tok > 0);
  e.call(R"({"v":1,"op":"commit","id":5,"token":)" + std::to_string(tok) + R"(,"when":0})");
  REQUIRE(rig_test_tap(e.e, tap) == RIG_OK);
}

void inject(OfflineEngine &e, const char *at, const std::vector<float> &l, const std::vector<float> &r) {
  const float *ch[2] = {l.data(), r.data()};
  REQUIRE(rig_test_inject(e.e, at, ch, 2, l.size(), 0.0, 1.0f) == RIG_OK);
}

/** amp * sin(2 pi hz t), with a per-frame gain curve when given. */
std::vector<float> sine(double seconds, double hz, double amp) {
  std::vector<float> x(static_cast<std::size_t>(seconds * kSr));
  for (std::size_t i = 0; i < x.size(); ++i)
    x[i] = static_cast<float>(amp * std::sin(2 * kPi * hz * static_cast<double>(i) / kSr));
  return x;
}

void setComp(OfflineEngine &e, double v, double when) {
  e.call(R"({"v":1,"op":"set","id":7,"path":"fx.comp.amount","value":)" + num(v) + R"(,"when":)" + num(when) + "}");
}

/** Render to `seconds`, calling the scheduled callbacks at the quantum boundary JS's offline e.at() fires on. */
std::vector<std::vector<float>> renderWith(OfflineEngine &e, double seconds,
                                           std::vector<std::pair<double, double>> compEvents) {
  std::vector<std::vector<float>> all(2);
  std::size_t done = 0;
  const auto total = static_cast<std::size_t>(seconds * kSr);
  std::sort(compEvents.begin(), compEvents.end());
  auto take = [&](std::size_t upTo) {
    if (upTo <= done) return;
    auto o = e.render(upTo - done);
    for (int c = 0; c < 2; ++c) all[c].insert(all[c].end(), o[c].begin(), o[c].end());
    done = upTo;
  };
  for (const auto &[t, v] : compEvents) {
    take(static_cast<std::size_t>(std::ceil(t * kSr / 128.0 - 1e-6)) * 128);
    setComp(e, v, t);
  }
  take(total);
  return all;
}

}  // namespace

TEST_SUITE("master") {
  TEST_CASE("golden fixtures master-eq, glue-*, limiter-* in process at the exact tier, allocation trap on") {
    const std::string golden = std::string(RIG_REPO_DIR) + "/native/golden";
    std::vector<rig::tools::Fixture> all;
    std::string err;
    REQUIRE(rig::tools::loadFixtures(golden + "/manifest.json", all, &err));
    const long allocs = g_rtAllocs;
    for (const char *id : {"master-eq", "glue-50", "glue-100", "glue-100-bursts", "limiter-steps", "limiter-steps-hot",
                           "limiter-bursts-hot"}) {
      INFO(std::string(id));
      const auto it = std::find_if(all.begin(), all.end(), [&](const auto &f) { return f.id == id; });
      REQUIRE(it != all.end());
      rig::io::WavData gold;
      if (!rig::io::readWav(golden + "/out/" + id + ".wav", gold) &&
          !rig::io::readWav(golden + "/smoke/" + id + ".wav", gold)) {
        MESSAGE("golden WAV missing for " << id << " (node tools/golden/render.mjs --only " << id << "): skipped");
        continue;
      }
      const rig::tools::RunResult r = rig::tools::runFixture(*it, golden, 44100);
      REQUIRE(r.ok);
      for (const auto &sk : r.skipped) MESSAGE("skipped: " << sk);
      CHECK(r.skipped.empty());
      REQUIRE(r.channels.size() == 2);
      double m = 0, peak = 0;
      for (int c = 0; c < 2; ++c) {
        REQUIRE(r.channels[c].size() == gold.ch[c].size());
        m = std::max(m, maxAbsDiff(r.channels[c], gold.ch[c]));
        for (float v : gold.ch[c]) peak = std::max(peak, double(std::fabs(v)));
      }
      std::printf("  %-20s max|native - golden| %.3g, golden peak %.3f\n", id, m, peak);
      CHECK(m <= 2e-4);  // the exact tier
      CHECK(m <= 1e-6);  // what the port achieves (Chromium's hash-order sums, the makeup measurement's oscillator)
      CHECK(peak > 0.1);  // none of these goldens is silence
    }
    CHECK(g_rtAllocs == allocs);
  }

  TEST_CASE("mono sum: sqrt2 * (L + R) / 2 on both channels, stereo untouched, 50 ms crossfade") {
    const double inDb = db(0.1 / std::sqrt(2.0));
    auto run = [&](bool mono, bool leftOnly) {
      OfflineEngine e(kSr);
      start(e, 0, 1, "out");
      if (mono) e.call(R"({"v":1,"op":"config","id":9,"mono":true})");
      const auto s = sine(1.0, 1000, 0.1);
      const std::vector<float> z(s.size(), 0.0f);
      inject(e, "fx.eqIn", s, leftOnly ? z : s);
      return e.render(static_cast<std::size_t>(kSr));
    };
    const auto st = run(false, false), mo = run(true, false), moL = run(true, true), stL = run(false, true);
    // monoCeilingAndMakeup "unity": stereo at the input level, mono +3.01 dB (the mono law of fx.js setMono)
    CHECK(std::fabs(db(rms(st[0], 0.5, 1)) - inDb) < 0.05);
    CHECK(std::fabs(db(rms(mo[0], 0.5, 1)) - (inDb + 3.0103)) < 0.05);
    // a left-only input in mono: both channels carry sqrt2 * L / 2 (-3 dB re L), identical sample by sample
    const auto after = [](const std::vector<float> &x) {  // after the 50 ms crossfade
      return std::vector<float>(x.begin() + static_cast<std::ptrdiff_t>(0.06 * kSr), x.end());
    };
    CHECK(maxAbsDiff(after(moL[0]), after(moL[1])) == 0.0);
    CHECK(std::fabs(db(rms(moL[0], 0.5, 1)) - (inDb - 3.0103)) < 0.05);
    CHECK(peakAbs(stL[1], 0, 1) == 0.0);  // stereo keeps the right channel silent
    // the crossfade: config mono at t = 0 ramps over 50 ms, so the start differs from the end level
    CHECK(rms(mo[0], 0.0065, 0.016) < rms(mo[0], 0.5, 1));
  }

  TEST_CASE("monoCeilingAndMakeup: a hot master stays under -0.3 dBFS in stereo and mono; makeup cancelled") {
    auto run = [](bool mono) {
      OfflineEngine e(kSr);
      start(e, 0, 2, "out");  // master volume 2 (+6 dB) as in the JS test
      if (mono) e.call(R"({"v":1,"op":"config","id":9,"mono":true})");
      std::vector<float> l(static_cast<std::size_t>(1.5 * kSr)), r(l.size());
      for (std::size_t i = 0; i < l.size(); ++i) {  // four partials, as the 4-note chord: peaks near 2.4 at 0 dB
        const double t = static_cast<double>(i) / kSr;
        double v = 0;
        for (double hz : {110.0, 164.81, 220.0, 329.63}) v += 0.6 * std::sin(2 * kPi * hz * t);
        l[i] = static_cast<float>(v);
        r[i] = static_cast<float>(0.8 * v);
      }
      inject(e, "fx.eqIn", l, r);
      const auto o = e.render(l.size());
      return db(std::max(peakAbs(o[0], 0.1, 1.5), peakAbs(o[1], 0.1, 1.5)));
    };
    const double st = run(false), mo = run(true);
    std::printf("  hot master peak: stereo %.2f dBFS, mono %.2f dBFS\n", st, mo);
    CHECK(st <= -0.3);
    CHECK(mo <= -0.3);
    CHECK(st > -3.0);  // the ceiling is reached, not a far lower level
    CHECK(db(rig::master::compMakeup()) > 0.5);
  }

  TEST_CASE("glueEngageNoDip: engaging the glue never dips or bumps the level (fresh, stale state, retarget)") {
    const double inDb = db(0.1 / std::sqrt(2.0));
    auto run = [&](const char *kind) {
      OfflineEngine e(kSr);
      start(e, 0, 1, "out");
      const std::string k = kind;
      auto s = sine(3.3, 1000, 1.0);
      for (std::size_t i = 0; i < s.size(); ++i)
        s[i] *= k == "stale" && static_cast<double>(i) < 1.2 * kSr ? 0.9f : 0.1f;
      inject(e, "fx.eqIn", s, s);
      std::vector<std::pair<double, double>> ev;
      if (k == "stale") ev = {{0.2, 0.9}, {1.0, 0.0}};
      ev.push_back({2.5, k == "retarget" ? 0.5 : 1.0});
      if (k == "retarget") ev.push_back({2.6, 1.0});
      const auto o = renderWith(e, 3.3, ev);
      double lo = 1e9, hi = -1e9;
      for (double t = 2.5; t + 0.05 <= 3.2 + 1e-9; t += 0.05) {
        const double w = db(rms(o[0], t, t + 0.05)) - inDb;
        lo = std::min(lo, w);
        hi = std::max(hi, w);
      }
      std::printf("  glueEngageNoDip %-8s window re input: min %+.3f max %+.3f dB\n", kind, lo, hi);
      return std::make_pair(lo, hi);
    };
    for (const char *k : {"fresh", "stale", "retarget"}) {
      INFO(k);
      const auto [lo, hi] = run(k);
      CHECK(lo > -0.3);
      CHECK(hi < 0.3);
    }
  }

  TEST_CASE("masterEqGlue: never-glue == amount 0 == bypassed glue (exact); unity at any amount; dynamics") {
    auto tone = [](OfflineEngine &e, double seconds) {
      std::vector<float> l(static_cast<std::size_t>(seconds * kSr)), r(l.size());
      for (std::size_t i = 0; i < l.size(); ++i) {  // a loud chord-like signal with an envelope
        const double t = static_cast<double>(i) / kSr;
        const double env = 0.35 + 0.3 * std::sin(2 * kPi * 1.3 * t);
        l[i] = static_cast<float>(env * (std::sin(2 * kPi * 261.6 * t) + 0.5 * std::sin(2 * kPi * 392 * t)));
        r[i] = static_cast<float>(env * (std::sin(2 * kPi * 329.6 * t) + 0.4 * std::sin(2 * kPi * 523.3 * t)));
      }
      inject(e, "fx.eqIn", l, r);
    };
    auto piano = [&](unsigned flags, std::vector<std::pair<double, double>> ev) {
      OfflineEngine e(kSr, RIG_FLAG_TEST_API | flags);
      start(e, 0, 1, "out");
      tone(e, 2.5);
      return renderWith(e, 2.5, std::move(ev));
    };
    const auto never = piano(RIG_FLAG_NO_GLUE, {});
    const auto zero = piano(0, {});
    const auto onoff = piano(0, {{0.6, 1.0}, {1.2, 0.0}});
    CHECK(maxAbsDiff(never[0], zero[0]) == 0.0);
    CHECK(maxAbsDiff(never[1], zero[1]) == 0.0);
    // engage at .6 s, bypass at 1.2 s: after the 30 ms crossfade and the 40 ms detach it is the dry path again,
    // bit for bit (Chromium: <= 1e-5 for its hash-order sums)
    auto tail = [](const std::vector<float> &x) {
      return std::vector<float>(x.begin() + static_cast<std::ptrdiff_t>(1.3 * kSr), x.end());
    };
    CHECK(maxAbsDiff(tail(never[0]), tail(onoff[0])) == 0.0);
    CHECK(maxAbsDiff(tail(never[1]), tail(onoff[1])) == 0.0);
    // ... and the glue did act while engaged
    CHECK(maxAbsDiff(never[0], onoff[0]) > 1e-3);
    // no click around the switches: first differences stay near the steady signal's
    auto maxD1 = [](const std::vector<float> &x, double a, double b) {
      double m = 0;
      for (auto i = static_cast<std::size_t>(a * kSr) + 1; i < static_cast<std::size_t>(b * kSr); ++i)
        m = std::max(m, std::fabs(double(x[i]) - double(x[i - 1])));
      return m;
    };
    const double base = maxD1(never[0], 0.3, 2.4);
    CHECK(maxD1(onoff[0], 0.55, 1.0) < 1.25 * base);
    CHECK(maxD1(onoff[0], 1.15, 1.35) < 1.25 * base);

    // unity: 1 kHz at amplitude .1 into the sum at master 1 comes out at its input level for any amount
    const double inDb = db(0.1 / std::sqrt(2.0));
    for (double a : {1.0, 0.5, 0.35}) {
      OfflineEngine e(kSr);
      start(e, a, 1, "out");
      const auto s = sine(1.2, 1000, 0.1);
      inject(e, "fx.eqIn", s, s);
      const auto o = e.render(static_cast<std::size_t>(1.2 * kSr));
      const double out = db(rms(o[0], 0.8, 1.2));
      std::printf("  unity amount %.2f: %.3f dB (input %.3f)\n", a, out, inDb);
      CHECK(std::fabs(out - inDb) < 0.1);
    }

    // dynamics (fx.master tap, the glue alone): loud / soft bursts, amount 0 vs 1, the gap shrinks by > 3 dB
    auto gap = [](double amount) {
      OfflineEngine e(kSr);
      start(e, amount, 1, "fx.master");
      const double o = 0.4;  // the bursts start after the 0.3 s engage delay, as in the JS test
      std::vector<float> s(static_cast<std::size_t>((4.2 + o) * kSr));
      const double lv[4] = {0.5, 0.03, 0.45, 0.025};
      for (std::size_t i = 0; i < s.size(); ++i) {
        const double t = static_cast<double>(i) / kSr - 0.1 - o;
        const int k = t < 0 ? -1 : static_cast<int>(t);
        if (k < 0 || k > 3 || t - k > 0.9) continue;
        s[i] = static_cast<float>(lv[k] * std::sin(2 * kPi * 220 * t));
      }
      inject(e, "fx.eqIn", s, s);
      const auto out = e.render(s.size());
      double ch[4];
      for (int k = 0; k < 4; ++k) ch[k] = db(rms(out[0], 0.1 + o + k + 0.02, 0.1 + o + k + 0.8));
      return (ch[0] + ch[2]) / 2 - (ch[1] + ch[3]) / 2;
    };
    const double g0 = gap(0), g1 = gap(1);
    std::printf("  loud/soft gap: amount 0 %.1f dB, amount 1 %.1f dB\n", g0, g1);
    CHECK(g1 < g0 - 3);
  }

  TEST_CASE("master EQ rows reach the chain (fx.eqOut tap): a set moves the band, 0 dB is the identity") {
    auto run = [](const std::string &eq, bool live) {
      OfflineEngine e(kSr);
      start(e, 0, 1, "fx.eqOut", live ? "" : eq);
      if (live) e.call(R"({"v":1,"op":"set","id":8,"path":"fx.eq.low","value":6})");
      const auto s = sine(1.0, 30, 0.1);
      inject(e, "fx.eqIn", s, s);
      return e.render(static_cast<std::size_t>(kSr));
    };
    const auto flat = run(R"("eq":{"low":0,"mid":0,"high":0})", false);
    const auto in = sine(1.0, 30, 0.1);
    CHECK(maxAbsDiff(flat[0], in) < 1e-6);  // three 0 dB biquads: identity up to float rounding
    const auto boosted = run(R"("eq":{"low":6,"mid":0,"high":0})", false);
    const auto live = run("", true);
    const double inDb = db(rms(in, 0.5, 1));
    CHECK(std::fabs(db(rms(boosted[0], 0.5, 1)) - inDb - 6.0) < 0.4);  // masterEqGlue: 30 Hz under the 100 Hz shelf
    CHECK(db(rms(live[0], 0.5, 1)) == doctest::Approx(db(rms(boosted[0], 0.5, 1))).epsilon(1e-3));
  }

  TEST_CASE("CPU cost per 128-frame quantum (printed; not a pass criterion)") {
    constexpr int kN = 4000;
    float a[128], b[128], l[128], r[128];
    for (int i = 0; i < 128; ++i) {
      a[i] = static_cast<float>(0.5 * std::sin(i * 0.1));
      b[i] = static_cast<float>(0.4 * std::sin(i * 0.13));
    }
    auto us = [](auto &&fn) {
      const auto t0 = std::chrono::steady_clock::now();
      for (int k = 0; k < kN; ++k) fn();
      return std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count() / kN;
    };
    rig::wa::DynamicsCompressor c(48000);
    c.setParams(rig::master::catcherSettings());
    const float *src[2] = {a, b};
    float *dst[2] = {l, r};
    const double comp = us([&] { c.process(src, 2, dst, 128); });
    double ws[3];
    const rig::wa::WaveShaper::Oversample modes[3] = {rig::wa::WaveShaper::Oversample::None,
                                                      rig::wa::WaveShaper::Oversample::X2,
                                                      rig::wa::WaveShaper::Oversample::X4};
    for (int m = 0; m < 3; ++m) {
      rig::wa::WaveShaper w(rig::master::clipCurve(), rig::master::kClipCurveSize, modes[m], 2);
      ws[m] = us([&] {
        std::copy(a, a + 128, l);
        std::copy(b, b + 128, r);
        w.process(dst, 2, 128);
      });
    }
    OfflineEngine e(48000);
    start(e, 1, 1, "out");
    e.render(128 * 64);
    const double chain = us([&] { e.render(128); });
    const double period = 128.0 / 48000.0 * 1e6;
    std::printf("  48 kHz, us per quantum (%% of one core): compressor %.2f (%.2f%%), waveshaper none %.2f, 2x %.2f, "
                "4x %.2f (%.2f%%), engine with master chain + glue on %.2f (%.2f%%)\n",
                comp, 100 * comp / period, ws[0], ws[1], ws[2], 100 * ws[2] / period, chain, 100 * chain / period);
    CHECK(chain > 0);
  }
}
