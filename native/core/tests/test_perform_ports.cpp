// T14 W3A unit.perform_ports: the JS engine suites T14 had not ported (reviews/T14.md O1), through the Model on an
// offline engine with the real instruments (test/phase1/engine/suites.mjs: transposeFFT, sustainLongCap,
// sustainVariants, sustainRelease, exprCurveAndPedalSwell, sceneGlide, pedalSwellLevelMoves,
// intensityMacroAndBrightness, padLikeIntensity; tapeBendStream is in test_wheels.cpp). Where JS reads a Web Audio
// internal (a GainNode's value, a buffer object) the native test reads the Model's state or measures the render;
// what has no native counterpart is named in the case.
#include <algorithm>
#include <cmath>
#include <complex>
#include <string>
#include <vector>

#include "mix/slot_channel.h"
#include "model/perform.h"
#include "model/song.h"
#include "samples/decode.h"
#include "samples/manifest.h"
#include "samples/process_sample.h"
#include "test_click_detector.h"
#include "test_drone_util.h"
#include "test_model_util.h"
#include "yyjson.h"

using t13::Eng;
using t13::patch;
using t13::slot;

namespace {

constexpr double kSR = t13::kSR;
constexpr double kPi = 3.14159265358979323846;

std::string appDir() {
  return std::string(RIG_REPO_DIR) + "/app";
}

std::vector<float> mono(const Eng &e) {
  return t16::mono(e);
}
double rms(const std::vector<float> &d, double a, double b) {
  return t13::rms(d, a, b);
}
double db(double x) {
  return 20 * std::log10(x + 1e-30);
}

/** suites.mjs peakHz: Hann window over [a, b] in a 32768-point FFT, log-parabolic peak interpolation. */
double peakHz(const std::vector<float> &d, double a, double b, double lo = 30, double hi = 5000) {
  constexpr std::size_t n = 32768;
  const auto i0 = static_cast<std::size_t>(std::floor(a * kSR));
  const std::size_t len = std::min(n, static_cast<std::size_t>(std::floor((b - a) * kSR)));
  std::vector<std::complex<double>> x(n);
  for (std::size_t i = 0; i < len; ++i)
    x[i] = d[i0 + i] * (0.5 - 0.5 * std::cos(2 * kPi * static_cast<double>(i) / static_cast<double>(len - 1)));
  for (std::size_t i = 1, j = 0; i < n; ++i) {  // iterative radix-2
    std::size_t bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) std::swap(x[i], x[j]);
  }
  for (std::size_t L = 2; L <= n; L <<= 1) {
    const std::complex<double> w(std::cos(-2 * kPi / static_cast<double>(L)), std::sin(-2 * kPi / static_cast<double>(L)));
    for (std::size_t i = 0; i < n; i += L) {
      std::complex<double> c(1, 0);
      for (std::size_t k = 0; k < L / 2; ++k, c *= w) {
        const std::complex<double> u = x[i + k], v = x[i + k + L / 2] * c;
        x[i + k] = u + v;
        x[i + k + L / 2] = u - v;
      }
    }
  }
  const double bin = kSR / static_cast<double>(n);
  std::size_t k = 0;
  double m = -1;
  for (auto i = static_cast<std::size_t>(std::ceil(lo / bin)); i < std::min(n / 2 - 1, static_cast<std::size_t>(hi / bin));
       ++i)
    if (std::abs(x[i]) > m) {
      m = std::abs(x[i]);
      k = i;
    }
  const double y0 = std::log(std::abs(x[k - 1]) + 1e-20), y1 = std::log(std::abs(x[k]) + 1e-20),
               y2 = std::log(std::abs(x[k + 1]) + 1e-20);
  return (static_cast<double>(k) + 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2)) * bin;
}

double maxD1(const std::vector<float> &d, double a, double b) {
  double m = 0;
  for (auto i = std::max<std::size_t>(1, static_cast<std::size_t>(a * kSR)); i < std::min(d.size(), static_cast<std::size_t>(b * kSR)); ++i)
    m = std::max(m, static_cast<double>(std::fabs(d[i] - d[i - 1])));
  return m;
}
double maxD2(const std::vector<float> &d, double a, double b) {
  double m = 0;
  for (auto i = std::max<std::size_t>(2, static_cast<std::size_t>(a * kSR)); i < std::min(d.size(), static_cast<std::size_t>(b * kSR)); ++i)
    m = std::max(m, static_cast<double>(std::fabs(d[i] - 2.0 * d[i - 1] + d[i - 2])));
  return m;
}

/** First 5 ms step after tOff where the 10 ms RMS is 60 dB under the 100 ms before tOff (suites.mjs decayTo60). */
double decayTo60(const std::vector<float> &d, double tOff) {
  const double ref = db(rms(d, tOff - 0.1, tOff));
  for (double t = tOff; t + 0.01 <= static_cast<double>(d.size()) / kSR; t += 0.005)
    if (db(rms(d, t, t + 0.01)) < ref - 60) return t - tOff;
  return INFINITY;
}

std::string songOp(const std::string &body) {
  return R"({"v":1,"op":"song","id":9,)" + body + "}";
}

}  // namespace

TEST_SUITE("perform_ports") {
  TEST_CASE("transposeFFT: song transpose moves the sounding pitch (sub-bass sine, FFT peak within 0.5 %)") {
    Eng e;
    REQUIRE(e.use(patch({slot("synth", "sub-bass", 1, R"("params":{"tri":0},"highNote":127,"mono":"off")")})));
    struct Case {
      int tr, play, expect;
    } cases[] = {{3, 57, 60}, {-6, 57, 51}, {1, 59, 60}, {17, 55, 72}};
    for (int i = 0; i < 4; ++i) {
      e.call(songOp("\"transpose\":" + std::to_string(cases[i].tr)));
      e.on(cases[i].play, 0.05 + i * 0.8);
      e.off(cases[i].play, 0.75 + i * 0.8);
    }
    e.until(3.3);
    const std::vector<float> d = mono(e);
    for (int i = 0; i < 4; ++i) {
      const double f = peakHz(d, 0.15 + i * 0.8, 0.7 + i * 0.8);
      const double want = 440 * std::pow(2.0, (cases[i].expect - 69) / 12.0);
      INFO("transpose " << cases[i].tr << " play " << cases[i].play << ": " << f << " Hz, want " << want);
      CHECK(std::fabs(f / want - 1) < 0.005);
    }
  }

  TEST_CASE("sustainRelease: slots.<i>.release replaces the instrument's release; null = its own again") {
    auto run = [](const std::string &type, const std::string &id, double release, bool reset) {
      Eng e(true, kSR, appDir());
      std::string extra = std::isfinite(release) ? "\"release\":" + Eng::num(release) : "";
      REQUIRE(e.use(patch({slot(type, id, 1, extra)}, R"("master":{"volume":1})")));
      if (reset) e.set("slots.0.release", "null", 0);
      e.on(60, 0.1);
      e.off(60, 1);
      e.until(5);
      return decayTo60(mono(e), 1);
    };
    const double organOwn = run("organ", "church", NAN, false), organ03 = run("organ", "church", 0.3, false),
                 organ4 = run("organ", "church", 4, false), organReset = run("organ", "church", 4, true);
    const double padOwn = run("synth", "warm-pad", NAN, false), pad03 = run("synth", "warm-pad", 0.3, false),
                 pad1 = run("synth", "warm-pad", 1, false);
    MESSAGE("decay to -60 dB (s): organ own " << organOwn << " r0.3 " << organ03 << " r4 " << organ4 << " reset "
                                              << organReset << "; pad own " << padOwn << " r0.3 " << pad03 << " r1 "
                                              << pad1);
    CHECK(organOwn == doctest::Approx(1.5).epsilon(0.1));
    CHECK(std::fabs(organ03 - 0.3) <= 0.06);
    CHECK(std::fabs(organ4 - 4) <= 0.3);
    CHECK(std::fabs(organReset - organOwn) <= 0.02);
    CHECK(std::fabs(pad03 - 0.3) <= 0.06);
    CHECK(std::fabs(pad1 - 1) <= 0.1);
    CHECK(padOwn > 2.5);
  }

  TEST_CASE("sustainLongCap: a pedalled A1 (20 s Salamander file) still sounds at 18 s (the sustain variant)") {
    // JS plays a one-sample copy of the v9 layer; natively the factory instrument at vel 127 (v14 A1, also 20 s).
    // The legacy 16 s cap is checked on the decode itself in sustainVariants.
    Eng e(true, kSR, appDir());
    REQUIRE(e.use(patch({slot("sampler", "salamander-piano", 1)}, R"("master":{"volume":1})")));
    e.on(33, 0.1, 127);
    e.pedal(true, 0.5);
    e.off(33, 1);
    e.until(19);
    auto st = [&](double a, double b) {
      return db(std::sqrt(0.5 * (std::pow(rms(e.L, a, b), 2) + std::pow(rms(e.R, a, b), 2))));
    };
    const double at14 = st(13.9, 14.1), at17 = st(16.9, 17.1), at18 = st(17.9, 18.1);
    MESSAGE("A1 under the pedal: 14 s " << at14 << " dB, 17 s " << at17 << " dB, 18 s " << at18 << " dB");
    CHECK(at14 > -60);
    CHECK(at18 > -50);  // the legacy cap (16 s, 1 s fade) would be digital silence here
  }

  TEST_CASE("sustainVariants: the long variant is the legacy buffer plus a tail (v9 Salamander, prefix exact)") {
    const std::string manifest = appDir() + "/samples/manifest.json";
    yyjson_doc *doc = yyjson_read_file(manifest.c_str(), 0, nullptr, nullptr);
    REQUIRE(doc);
    const auto defs = rig::samples::normalizeManifest(yyjson_doc_get_root(doc), manifest, {});
    yyjson_doc_free(doc);
    const rig::samples::SamplerDef *sal = nullptr;
    for (const auto &d : defs)
      if (d.id == "salamander-piano") sal = &d;
    REQUIRE(sal);
    const rig::samples::Layer *v9 = nullptr;
    for (const auto &L : sal->layers)
      if (L.lo == 53) v9 = &L;
    REQUIRE(v9);
    int truncated = 0, monoFixed = 0;
    double worst = 0;
    for (const auto &s : v9->samples) {
      const rig::samples::DecodeResult r = rig::samples::decodeFile(s.url, {});
      REQUIRE_MESSAGE(r.ok(), s.url);
      rig::samples::DecodeOpts legacyOpts = sal->decodeOpts;
      legacyOpts.maxSec = 0;
      const auto legacy = rig::samples::processSample(r.pcm.ch, r.pcm.channels, r.pcm.sampleRate, s.midi, legacyOpts);
      if (!legacy.capped) continue;
      const auto longer = rig::samples::processSample(r.pcm.ch, r.pcm.channels, r.pcm.sampleRate, s.midi,
                                                      sal->decodeOpts);
      ++truncated;
      if (legacy.monoFix.applied && legacy.monoFix.mid != 1) ++monoFixed;
      CHECK(longer.frames > legacy.frames);
      const auto n = legacy.frames - static_cast<std::size_t>(std::lround(1.0 * r.pcm.sampleRate));  // before the fade
      for (int c = 0; c < legacy.channels; ++c)
        for (std::size_t i = 0; i < n; ++i)
          worst = std::max(worst, static_cast<double>(std::fabs(legacy.ch[c][i] - longer.ch[c][i])));
    }
    MESSAGE("v9 samples the legacy cap truncates: " << truncated << " (mono-fixed " << monoFixed
                                                    << "), prefix max|diff| " << worst);
    CHECK(sal->decodeOpts.maxSec > 16);
    CHECK(truncated >= 5);
    CHECK(worst == 0.0);
    // (b) of the JS suite (an instrument disposed during its upgrade decode holds no cache reference) is the
    // sampler / cache lifetime: samples_service.cpp and test_sampler.cpp cover the native lease path.
  }

  TEST_CASE("exprCurveAndPedalSwell: expression curve log = 9/99 at half travel; pedal swell raises the drone") {
    Eng e;
    const std::string R0 = R"("modWheel":{"target":"none","min":0,"max":1},)"
                           R"("expression":{"target":"slots.1.gain","min":0,"max":1})";  // patch top level (JS)
    REQUIRE(e.use(patch({"null", slot("synth", "warm-pad", 1)}, R0)));
    e.call(R"({"v":1,"op":"play","e":"wheel","src":"expr","value":0.5,"when":0})");
    const double lin = e.sg().factorFor("slots.1.gain");
    e.call(songOp(R"("routing":{"expression":{"target":"slots.1.gain","min":0,"max":1,"curve":"log"}},"when":0)"));
    const double logv = e.sg().factorFor("slots.1.gain");
    e.call(songOp(R"("routing":{"expression":{"target":"slots.1.gain","min":0,"max":1,"curve":"bogus"}},"when":0)"));
    const double bogus = e.sg().factorFor("slots.1.gain");
    CHECK(lin == doctest::Approx(0.5).epsilon(1e-12));
    CHECK(logv == doctest::Approx(9.0 / 99).epsilon(1e-9));
    CHECK(bogus == doctest::Approx(0.5).epsilon(1e-12));
    e.call(songOp(R"("routing":{"swell":{"seconds":8,"pedal":true}},"when":0)"));
    t16::droneConfig(e, R"({"mode":"synth","gain":0.25,"fade":1})", 0);
    t16::droneKey(e, 0, false, 0);
    e.pedal(true, 2.5);
    e.pedal(false, 6);
    e.until(9.6);
    e.pedal(true, 9.6);
    e.call(songOp(R"("routing":{"swell":{"seconds":8}},"when":9.7)"));  // combo off while held: lets go
    e.until(12);
    const std::vector<float> d = mono(e);
    const double rest = db(rms(d, 1.8, 2.4)), swelled = db(rms(d, 5.2, 5.9)), back = db(rms(d, 9.2, 9.5)),
                 comboOff = db(rms(d, 11.5, 11.9));
    MESSAGE("drone: rest " << rest << " dB, swelled " << swelled << " dB, back " << back << " dB, combo off "
                           << comboOff << " dB");
    // drone.gain 0.25 -> the swell rises toward drone.gain 1: x4 = +12 dB (+- the drone's own movement)
    CHECK(swelled - rest > 10);
    CHECK(swelled - rest < 14.5);
    CHECK(std::fabs(back - rest) < 1.5);
    CHECK(comboOff - rest < 20 * std::log10(2.0) + 1.5);  // JS: swell factor < 2 at 11.9 s
  }

  TEST_CASE("sceneGlide: a slot fader glide (twice, mid-glide) is click-free; a hard step is caught; drone glide") {
    constexpr double GLIDE = 0.5, T = 1.0;
    struct R {
      double ratio, d2Ratio, before, dip, end;
      std::size_t clicks;
      bool held;
      rig::Move mid;
    };
    auto run = [&](const std::string &mode) {
      Eng e;
      REQUIRE(e.use(patch({slot("synth", "sub-bass", 1, R"("params":{"tri":0,"tone":1})")})));
      e.on(57, 0.1, 120);
      rig::Model &m = e.model();
      R r{};
      if (mode == "glide") {
        m.sink().at(T, [&m](double t) {
          yyjson_doc *v = yyjson_read("0.25", 4, 0);
          m.set("slots.0.gain", yyjson_doc_get_root(v), GLIDE, t);
          yyjson_doc_free(v);
        });
        m.sink().at(T + 0.2, [&m](double t) {
          yyjson_doc *v = yyjson_read("1", 1, 0);
          m.set("slots.0.gain", yyjson_doc_get_root(v), GLIDE, t);
          yyjson_doc_free(v);
        });
        m.sink().at(T + 0.1, [&m, &r](double) { r.mid = m.songGraph().liveChannel(0)->fader; });
      } else if (mode == "step") {  // positive control: a hard step on the fader
        m.sink().at(T, [&m](double t) { m.setParamAt(rig::stripSlot(0), rig::kStripFader, 0.25, t); });
      }
      e.until(3.2);
      const std::vector<float> &d = e.L;
      const double steady = std::max(maxD1(d, T - 0.4, T - 0.01), maxD1(d, 2.6, 3.0));
      const double steadyD2 = std::max(maxD2(d, T - 0.4, T - 0.01), maxD2(d, 2.6, 3.0));
      r.ratio = maxD1(d, T - 0.01, T + 0.75) / steady;
      r.d2Ratio = maxD2(d, T - 0.01, T + 0.75) / steadyD2;
      r.clicks = rigtest::clicks(d, kSR, T - 0.1, T + 0.9).size();
      r.before = db(rms(d, T - 0.05, T - 0.04));
      r.dip = db(rms(d, T + 0.195, T + 0.205));
      r.end = db(rms(d, 2.9, 3.0));
      r.held = m.perform().held().count(57) == 1;
      return r;
    };
    const R glide = run("glide"), step = run("step");
    // drone: the same glide on drone.gain
    Eng e;
    t16::droneConfig(e, R"({"mode":"synth","gain":0.8,"fade":0.2})", 0);
    t16::droneKey(e, 9, false, 0);
    e.set("drone.gain", "0.2", 1.5, GLIDE);
    e.until(3);
    const std::vector<float> dd = mono(e);
    const std::size_t droneClicks = rigtest::clicks(dd, kSR, 1.3, 2.3).size();
    const double dBefore = db(rms(dd, 1.3, 1.5)), dMid = db(rms(dd, 1.7, 1.8)), dAfter = db(rms(dd, 2.6, 2.9));
    const double dipDb = glide.before - glide.dip;
    MESSAGE("glide: ratio " << glide.ratio << " d2Ratio " << glide.d2Ratio << " clicks " << glide.clicks << " dip "
                            << dipDb << " dB, end-before " << glide.end - glide.before << "; step ratio "
                            << step.ratio << "; drone " << dBefore << " / " << dMid << " / " << dAfter << " dB, clicks "
                            << droneClicks);
    CHECK(glide.ratio <= 1.05);
    CHECK(glide.d2Ratio < 2);
    CHECK(glide.clicks == 0);
    CHECK(glide.held);
    CHECK(dipDb > 2.3);
    CHECK(dipDb < 4);
    CHECK(std::fabs(glide.end - glide.before) < 0.5);
    CHECK(glide.mid.to == 0.25);
    CHECK(glide.mid.dur == GLIDE);
    CHECK(step.ratio > 3);
    CHECK(droneClicks == 0);
    CHECK(dBefore - dAfter > 6);
    CHECK(dMid < dBefore);
    CHECK(dMid > dAfter);
  }

  TEST_CASE("pedalSwellLevelMoves: a drone.gain move under the pedal swell lands on full, never above (R-1)") {
    // JS also samples level x bendGain every 25 ms (effMax <= 1.001); natively the drone's gains live on the audio
    // thread, so the rendered level is the measure: after the move it matches the swelled level before it and the
    // reference (drone 1.0, no pedal); 'down' (0.5 -> 0.1) lands on its own swell (x4 = 0.4), not on x2.
    // Timeline 2.5 s later than JS (T 3.5 -> 6): the suites' harness plays the fallback drone-osc preset
    // (instrumentModules: false), whose attack is short; the native drone is the synth.js drone-osc with its 2.5 s
    // voice attack (drone.js _start: a start from silence keeps it), still rising at 3.5 s.
    constexpr double T = 6.0;
    struct Out {
      double before, after;
      std::vector<double> clickAt;
    };
    auto run = [&](const std::string &how) {
      Eng e;
      const std::string sw = R"("swell":{"seconds":8,"pedal":true})";
      REQUIRE(e.use(patch({"null", slot("synth", "warm-pad", 1)}, sw)));
      const double g = how == "reference" ? 1 : how == "down" ? 0.5 : 0.25;
      t16::droneConfig(e, R"({"mode":"synth","gain":)" + Eng::num(g) + R"(,"fade":0.5})", 0);
      t16::droneKey(e, 0, false, 0);
      if (how != "reference") e.pedal(true, 0.1);
      long tok = -1;
      if (how == "song") tok = e.prepare(patch({"null", slot("synth", "warm-pad", 1)}, sw));
      e.until(T);
      if (how == "scene") e.set("drone.gain", "1", T, 0.5);
      else if (how == "fader") e.set("drone.gain", "1", T);
      else if (how == "down") e.set("drone.gain", "0.1", T, 0.5);
      else if (how == "song") {
        REQUIRE(e.commit(tok, T));
        t16::droneConfig(e, R"({"mode":"synth","gain":1,"fade":0.5})", T);
      }
      e.until(T + 3);
      const std::vector<float> d = mono(e);
      Out o{db(rms(d, T - 0.7, T)), db(rms(d, T + 2.1, T + 2.9)), {}};
      for (const auto &c : rigtest::clicks(d, kSR, T - 0.2, T + 1)) o.clickAt.push_back(c.t);
      return o;
    };
    const Out ref = run("reference"), scene = run("scene"), fader = run("fader"), song = run("song"),
              down = run("down");
    // The native drone itself moves about 1.7 dB between the two windows and has one click-detector hit at 6.78 s
    // in the REFERENCE too (no pedal, no move: drone-osc content, T16's; the JS harness plays the fallback preset):
    // so each case is compared with the reference, window for window, and only clicks the reference lacks count.
    auto extraClicks = [&](const Out &x) {
      std::size_t n = 0;
      for (double t : x.clickAt)
        if (std::none_of(ref.clickAt.begin(), ref.clickAt.end(), [t](double r) { return std::fabs(r - t) < 0.002; }))
          ++n;
      return n;
    };
    auto ok = [&](const Out &x, const char *name) {
      INFO(name << ": before " << x.before << " after " << x.after << " (ref " << ref.before << " / " << ref.after
                << "), clicks " << x.clickAt.size());
      CHECK(std::fabs(x.before - ref.before) < 0.5);  // swelled to full before the move (JS effBefore > 0.97)
      CHECK(std::fabs(x.after - ref.after) < 0.5);    // full after it, never above (JS effMax <= 1.001)
      CHECK(extraClicks(x) == 0);
    };
    ok(scene, "scene");
    ok(fader, "fader");
    ok(song, "song");
    MESSAGE("reference: before " << ref.before << " after " << ref.after << "; down: before " << down.before
                                 << " after " << down.after);
    CHECK(std::fabs(down.before - ref.before) < 0.5);
    CHECK(down.after - ref.after == doctest::Approx(20 * std::log10(0.4)).epsilon(0.05));  // its own swell: x4
    CHECK(extraClicks(down) == 0);
  }

  TEST_CASE("intensityMacroAndBrightness: macro.intensity at 0 -> slot wheel 0.35, reverb return x0.8, no morph") {
    auto run = [](double mod, double &slotW, double &morph, double &revDb) {
      Eng e;
      const std::string R0 = R"("modWheel":{"target":"macro.intensity","min":0,"max":1})";
      REQUIRE(e.use(patch({"null", slot("synth", "warm-pad", 1)}, R0)));
      e.call(R"({"v":1,"op":"play","e":"wheel","src":"mod","value":)" + Eng::num(mod) + R"(,"when":0.1})");
      REQUIRE(rig_test_tap(e.e, "fx.reverb.output") == RIG_OK);
      std::vector<float> noise(static_cast<std::size_t>(0.3 * kSR));
      std::uint32_t s = 1;
      for (float &x : noise) x = static_cast<float>((s = s * 1664525u + 1013904223u) >> 8) / 16777216.0f - 0.5f;
      const float *ch[2] = {noise.data(), noise.data()};
      REQUIRE(rig_test_inject(e.e, "fx.reverb.input", ch, 2, noise.size(), 0.3, 0.5f) == RIG_OK);
      e.until(0.5);
      slotW = e.sg().slotWheelFactor(1);
      morph = e.sg().liveChannel(1)->morph;
      e.until(1.2);
      revDb = db(rms(e.L, 0.4, 1.0));
    };
    double w0 = 0, m0 = 0, r0 = 0, w1 = 0, m1 = 0, r1 = 0;
    run(0, w0, m0, r0);
    run(1, w1, m1, r1);
    MESSAGE("mod 0: slot wheel " << w0 << " morph " << m0 << " reverb out " << r0 << " dB; mod 1: " << w1 << " / "
                                 << m1 << " / " << r1 << " dB");
    CHECK(w0 == doctest::Approx(0.35).epsilon(0.01 / 0.35));
    CHECK(m0 == 0);  // intensity 0: no morph (JS e.slots[1].morph === 0)
    (void)m1;
    CHECK(r1 - r0 == doctest::Approx(20 * std::log10(1.15 / 0.8)).epsilon(0.02));  // reverb wheel 0.8 .. 1.15
    // The drone half (brightness 0.8 -> 4 voices, 0.3 -> 3) is T16's voicing: unit.drone (droneVoicing vectors).
  }

  TEST_CASE("padLikeIntensity: macro.intensity morphs the pad-like instruments (0.6), not the bell; pluck calibWindow") {
    Eng e(true, kSR, appDir());
    const std::string R0 = R"("modWheel":{"target":"macro.intensity","min":0,"max":1})";
    const std::vector<std::pair<std::string, std::string>> ids = {
        {"synth", "supersaw-pad"}, {"synth", "juno-pad"}, {"synth", "shimmer-pad"}, {"organ", "soft-pad"},
        {"synth", "bell"}};
    std::vector<std::string> slots;
    for (const auto &[t, id] : ids) slots.push_back(slot(t, id, 1));
    std::vector<std::string> first(slots.begin(), slots.begin() + 4), second = {slots[4]};
    REQUIRE(e.use(patch(first, R0)));
    e.call(R"({"v":1,"op":"play","e":"wheel","src":"mod","value":0.6})");
    e.until(0.05);
    for (int i = 0; i < 4; ++i) {
      INFO(ids[static_cast<std::size_t>(i)].second);
      REQUIRE(e.sg().liveChannel(i));
      CHECK(e.sg().liveChannel(i)->morph == doctest::Approx(0.6).epsilon(1e-3));
    }
    REQUIRE(e.use(patch(second, R0)));
    e.call(R"({"v":1,"op":"play","e":"wheel","src":"mod","value":0.6})");
    e.until(0.1);
    REQUIRE(e.sg().liveChannel(0));
    CHECK(e.sg().liveChannel(0)->morph == 0);
    // listInstruments().find(pluck).calibWindow[1] === 1 (synth-extra's calibration window, read by calibrate.mjs)
    const std::string list = e.model().listInstruments();
    yyjson_doc *doc = yyjson_read(list.data(), list.size(), 0);
    REQUIRE(doc);
    double calib1 = -1;
    yyjson_val *root = yyjson_doc_get_root(doc), *it = nullptr;
    yyjson_arr_iter ai;
    if (yyjson_arr_iter_init(root, &ai))
      while ((it = yyjson_arr_iter_next(&ai))) {
        yyjson_val *ref = yyjson_obj_get(it, "ref");
        yyjson_val *id = ref ? yyjson_obj_get(ref, "id") : nullptr;
        if (!id || !yyjson_equals_str(id, "pluck")) continue;
        yyjson_val *cw = yyjson_obj_get(it, "calibWindow");
        if (cw && yyjson_is_arr(cw) && yyjson_arr_size(cw) == 2) calib1 = yyjson_get_num(yyjson_arr_get(cw, 1));
      }
    yyjson_doc_free(doc);
    CHECK(calib1 == 1);
  }
}
