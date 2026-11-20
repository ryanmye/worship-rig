// T11a: wa::Oscillator / PeriodicWave / BufferSource / ConstantSource against OfflineAudioContext renders of Chromium
// 157 (tools/golden/vectors/data/sources.txt, dumped by tools/golden/vectors/dump-sources.mjs): every case replays
// the dumped spec through 128-frame quanta and is compared sample by sample. RIG_T11A_VERBOSE=1 prints the table.
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "doctest.h"
#include "dsp/buffer_source.h"
#include "dsp/constant_source.h"
#include "dsp/oscillator.h"
#include "dsp/periodic_wave.h"
#include "num_vectors.h"
#include "runtime/rt_guard.h"
#include "yyjson.h"

using namespace rig;
using namespace rig::wa;

namespace rigtest {
extern long g_rtAllocs;  // tests/alloc_trap.cpp
}

namespace {

std::vector<std::uint8_t> b64decode(const std::string &s) {
  auto val = [](char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
  };
  std::vector<std::uint8_t> out;
  std::uint32_t acc = 0;
  int bits = 0;
  for (char c : s) {
    const int v = val(c);
    if (v < 0) continue;
    acc = (acc << 6) | static_cast<std::uint32_t>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<std::uint8_t>((acc >> bits) & 0xff));
    }
  }
  return out;
}

double jnum(yyjson_val *o, const char *k, double d) {
  yyjson_val *v = yyjson_obj_get(o, k);
  return v && yyjson_is_num(v) ? yyjson_get_num(v) : d;
}
bool jhas(yyjson_val *o, const char *k) {
  return yyjson_obj_get(o, k) != nullptr;
}
std::string jstr(yyjson_val *o, const char *k) {
  yyjson_val *v = yyjson_obj_get(o, k);
  return v && yyjson_is_str(v) ? yyjson_get_str(v) : "";
}

void applyEv(Param &p, yyjson_val *evs) {
  if (!evs) return;
  std::size_t i, max;
  yyjson_val *e;
  yyjson_arr_foreach(evs, i, max, e) {
    const std::string op = yyjson_get_str(yyjson_arr_get(e, 0));
    const double v = yyjson_get_num(yyjson_arr_get(e, 1)), t = yyjson_get_num(yyjson_arr_get(e, 2));
    if (op == "set") p.setValueAtTime(v, t);
    else if (op == "lin") p.linearRampToValueAtTime(v, t);
    else if (op == "exp") p.exponentialRampToValueAtTime(v, t);
    else if (op == "target") p.setTargetAtTime(v, t, yyjson_get_num(yyjson_arr_get(e, 3)));
  }
}

std::vector<float> floats(yyjson_val *arr) {
  std::vector<float> v;
  std::size_t i, max;
  yyjson_val *e;
  yyjson_arr_foreach(arr, i, max, e) v.push_back(static_cast<float>(yyjson_get_num(e)));
  return v;
}

double noise(std::uint32_t v, std::uint32_t seed) {
  std::uint32_t h = ((v ^ seed) + 0x7f4a7c15u) * 0x9e3779b1u;
  h ^= h >> 15;
  h *= 0x85ebca6bu;
  h ^= h >> 13;
  return static_cast<double>(h >> 8) / 8388608.0 - 1.0;
}
float bufSample(std::uint32_t i, std::uint32_t c, std::uint32_t seed) {
  const double saw = static_cast<double>(i % 64) / 64.0 - 0.5;
  return static_cast<float>((c ? -0.7 : 0.7) * saw + 0.2 * noise(i * 2 + c, seed));
}

struct Result {
  std::vector<float> out;  // channel after channel, window only
  int endedBoundary = -1;  // first quantum boundary at which the render had finished (BufferSource)
};

Result render(yyjson_val *spec) {
  const std::string kind = jstr(spec, "k");
  const double sr = jnum(spec, "sr", 44100);
  const auto frames = static_cast<std::size_t>(jnum(spec, "frames", 4096));
  std::size_t w0 = 0, w1 = frames;
  if (yyjson_val *w = yyjson_obj_get(spec, "win")) {
    w0 = static_cast<std::size_t>(yyjson_get_num(yyjson_arr_get(w, 0)));
    w1 = static_cast<std::size_t>(yyjson_get_num(yyjson_arr_get(w, 1)));
  }
  const double start = jnum(spec, "start", 0);
  const bool hasStop = jhas(spec, "stop");
  const double stop = jnum(spec, "stop", 0);
  Result r;
  const unsigned nch = kind == "buf" ? static_cast<unsigned>(jnum(spec, "bufCh", 1)) : 1;
  std::vector<std::vector<float>> chan(nch, std::vector<float>(frames, 0.0f));
  const std::size_t kQ = 128;

  // construction (control thread: allocation allowed)
  std::unique_ptr<PeriodicWave> wave, modWave;
  std::unique_ptr<Oscillator> osc, mod;
  std::unique_ptr<BufferSource> bsrc;
  std::unique_ptr<ConstantSource> cs;
  std::vector<std::vector<float>> bdata;
  SampleBuffer sb;
  double fmDepth = 0;
  if (kind == "osc") {
    const std::string type = jstr(spec, "type");
    if (type == "custom") {
      yyjson_val *wv = yyjson_obj_get(spec, "wave");
      const auto re = floats(yyjson_obj_get(wv, "real")), im = floats(yyjson_obj_get(wv, "imag"));
      wave.reset(PeriodicWave::create(re.data(), im.data(), re.size(), yyjson_get_bool(yyjson_obj_get(wv, "dn")), sr));
    } else {
      const PeriodicWave::Basic b = type == "sine"       ? PeriodicWave::Basic::Sine
                                    : type == "square"   ? PeriodicWave::Basic::Square
                                    : type == "sawtooth" ? PeriodicWave::Basic::Sawtooth
                                                         : PeriodicWave::Basic::Triangle;
      wave.reset(PeriodicWave::basic(b, sr));
    }
    REQUIRE(wave);
    osc = std::make_unique<Oscillator>(wave.get(), jnum(spec, "freq", 440), jnum(spec, "detune", 0));
    applyEv(osc->frequency(), yyjson_obj_get(spec, "fEv"));
    applyEv(osc->detune(), yyjson_obj_get(spec, "dEv"));
    if (yyjson_val *fm = yyjson_obj_get(spec, "fm")) {
      modWave.reset(PeriodicWave::basic(PeriodicWave::Basic::Sine, sr));
      mod = std::make_unique<Oscillator>(modWave.get(), jnum(fm, "f", 1), 0.0);
      mod->start(0);
      fmDepth = jnum(fm, "depth", 0);
    }
    osc->start(start);
    if (hasStop) osc->stop(stop);
  } else if (kind == "buf") {
    const auto len = static_cast<std::uint32_t>(jnum(spec, "bufLen", 3000));
    const auto seed = static_cast<std::uint32_t>(jnum(spec, "bufSeed", 1));
    bdata.assign(nch, std::vector<float>(len));
    for (unsigned c = 0; c < nch; ++c)
      for (std::uint32_t i = 0; i < len; ++i) bdata[c][i] = bufSample(i, c, seed);
    sb.channels = nch;
    sb.frames = len;
    sb.sampleRate = jnum(spec, "bufSr", sr);
    for (unsigned c = 0; c < nch; ++c) sb.f32[c] = bdata[c].data();
    bsrc = std::make_unique<BufferSource>(&sb);
    bsrc->playbackRate().setValue(jnum(spec, "rate", 1));
    bsrc->detune().setValue(jnum(spec, "detune", 0));
    if (yyjson_val *lp = yyjson_obj_get(spec, "loop")) {
      bsrc->setLoop(true, yyjson_get_num(yyjson_arr_get(lp, 0)), yyjson_get_num(yyjson_arr_get(lp, 1)));
    }
    applyEv(bsrc->playbackRate(), yyjson_obj_get(spec, "rEv"));
    applyEv(bsrc->detune(), yyjson_obj_get(spec, "dEv"));
    if (jhas(spec, "dur")) bsrc->start(start, jnum(spec, "offset", 0), jnum(spec, "dur", 0));
    else bsrc->start(start, jnum(spec, "offset", 0));
    if (hasStop) bsrc->stop(stop);
  } else {
    cs = std::make_unique<ConstantSource>(jnum(spec, "offset", 1));
    applyEv(cs->offset(), yyjson_obj_get(spec, "ev"));
    cs->start(start);
    if (hasStop) cs->stop(stop);
  }

  const long allocs0 = rigtest::g_rtAllocs;
  {
    rt::RenderScope scope;  // allocation trap on, FTZ/DAZ as in the engine
    float modBuf[128], fmBuf[128];
    for (std::size_t f0 = 0; f0 < frames; f0 += kQ) {
      const std::size_t n = std::min(kQ, frames - f0);
      const auto fr = static_cast<std::int64_t>(f0);
      if (osc) {
        if (mod) {
          mod->process(fr, sr, modBuf, n);
          for (std::size_t i = 0; i < n; ++i) fmBuf[i] = modBuf[i] * static_cast<float>(fmDepth);
          osc->process(fr, sr, chan[0].data() + f0, n, fmBuf, nullptr);
        } else {
          osc->process(fr, sr, chan[0].data() + f0, n);
        }
      } else if (bsrc) {
        float *outp[2] = {chan[0].data() + f0, nch > 1 ? chan[1].data() + f0 : nullptr};
        bsrc->process(fr, sr, outp, n);
        if (bsrc->ended() && r.endedBoundary < 0) r.endedBoundary = static_cast<int>(f0 / kQ) + 1;
      } else {
        cs->process(fr, sr, chan[0].data() + f0, n);
      }
    }
  }
  CHECK_MESSAGE(rigtest::g_rtAllocs == allocs0, "allocation on the render path");
  for (unsigned c = 0; c < nch; ++c)
    r.out.insert(r.out.end(), chan[c].begin() + static_cast<long>(w0), chan[c].begin() + static_cast<long>(w1));
  return r;
}

}  // namespace

TEST_SUITE("sources") {
  TEST_CASE("single-node renders match Chromium 157 OfflineAudioContext (<= 1e-5)") {
    const auto all = rigvec::lines("sources.txt");
    REQUIRE(all.size() > 400);
    const bool verbose = std::getenv("RIG_T11A_VERBOSE") != nullptr;
    int cases = 0;
    double worst = 0;
    for (std::size_t li = 0; li + 3 < all.size(); ++li) {
      if (all[li].rfind("case ", 0) != 0) continue;
      const std::string name = all[li].substr(5);
      REQUIRE(all[li + 1].rfind("spec ", 0) == 0);
      REQUIRE(all[li + 2].rfind("out ", 0) == 0);
      const auto bytes = b64decode(all[li + 2].substr(4));
      std::vector<float> ref(bytes.size() / 4);
      std::memcpy(ref.data(), bytes.data(), ref.size() * 4);
      int refEnded = -2;
      if (all[li + 3].rfind("ended ", 0) == 0) refEnded = std::atoi(all[li + 3].c_str() + 6);
      const std::string json = all[li + 1].substr(5);
      yyjson_doc *doc = yyjson_read(json.data(), json.size(), 0);
      REQUIRE(doc);
      const Result r = render(yyjson_doc_get_root(doc));
      yyjson_doc_free(doc);
      REQUIRE_MESSAGE(r.out.size() == ref.size(), name);
      double maxd = 0, sumsq = 0, sumref = 0;
      std::size_t exact = 0;
      for (std::size_t i = 0; i < ref.size(); ++i) {
        const double d = std::fabs(static_cast<double>(r.out[i]) - static_cast<double>(ref[i]));
        maxd = std::fmax(maxd, d);
        exact += d == 0;
        sumsq += d * d;
        sumref += static_cast<double>(ref[i]) * static_cast<double>(ref[i]);
      }
      double peak = 0;
      for (float f : ref) peak = std::fmax(peak, std::fabs(static_cast<double>(f)));
      if (verbose) {
        std::printf("  %-42s max %.3e  exact %5.1f%%  peak %.3f  snr %.0f dB%s\n", name.c_str(), maxd,
                    100.0 * static_cast<double>(exact) / static_cast<double>(ref.size()), peak,
                    sumsq > 0 ? 10 * std::log10(sumref / sumsq) : 999.0,
                    refEnded != -2 ? (r.endedBoundary == refEnded ? "  ended ok" : "  ENDED MISMATCH") : "");
      }
      CHECK_MESSAGE(maxd <= 1e-5, name << ": max abs diff " << maxd);
      if (refEnded != -2)
        CHECK_MESSAGE(r.endedBoundary == refEnded, name << ": ended at " << r.endedBoundary << " vs " << refEnded);
      const bool silentOk = name.find("rate-fast-clamp") != std::string::npos ||
                            name.find("too-fast") != std::string::npos || name.find("cs-zero") != std::string::npos ||
                            name.find("beyond-end") != std::string::npos ||
                            name.find("above-nyquist") != std::string::npos;  // sin(pi n) = 0 at Nyquist
      CHECK_MESSAGE((peak > 0.01 || silentOk), name << ": reference is (near) silence");
      worst = std::fmax(worst, maxd);
      ++cases;
    }
    if (verbose) std::printf("  %d cases, worst %.3e\n", cases, worst);
    CHECK(cases >= 130);
  }

  TEST_CASE("PeriodicWave: normalisation, band limiting, table selection") {
    std::unique_ptr<PeriodicWave> w(PeriodicWave::basic(PeriodicWave::Basic::Sawtooth, 44100));
    CHECK(w->tableSize() == 4096);
    const float *lo = nullptr, *hi = nullptr;
    float tf = 0;
    w->tablesFor(1.0, lo, hi, tf);
    float peak = 0;
    for (std::size_t i = 0; i < w->tableSize(); ++i) peak = std::fmax(peak, std::fabs(hi[i]));
    CHECK(peak == doctest::Approx(1.0f).epsilon(1e-5));
    w->tablesFor(-440.0, lo, hi, tf);
    const float *lo2 = nullptr, *hi2 = nullptr;
    float tf2 = 0;
    w->tablesFor(440.0, lo2, hi2, tf2);
    CHECK((lo == lo2 && hi == hi2 && tf == tf2));
    w->tablesFor(0.0, lo, hi, tf);  // ratio 0.5: lowest range
    CHECK(hi != nullptr);
    std::unique_ptr<PeriodicWave> w96(PeriodicWave::basic(PeriodicWave::Basic::Square, 96000));
    std::unique_ptr<PeriodicWave> w22(PeriodicWave::basic(PeriodicWave::Basic::Triangle, 22050));
    CHECK(w96->tableSize() == 16384);
    CHECK(w22->tableSize() == 2048);
    CHECK(PeriodicWave::create(nullptr, nullptr, 1, false, 44100) == nullptr);
    // sine at the Nyquist-most range has no partials left once the fundamental is above 1/3 octave under Nyquist
    std::unique_ptr<PeriodicWave> sq(PeriodicWave::basic(PeriodicWave::Basic::Square, 44100));
    sq->tablesFor(20000.0, lo, hi, tf);
    float e = 0;
    for (std::size_t i = 0; i < sq->tableSize(); ++i) e = std::fmax(e, std::fabs(lo[i]));
    CHECK(e < 1.5f);
  }

  TEST_CASE("sources: scheduling edge cases") {
    std::unique_ptr<PeriodicWave> w(PeriodicWave::basic(PeriodicWave::Basic::Sine, 48000));
    Oscillator o(w.get(), 440);
    float b[128];
    o.process(0, 48000, b, 128);  // never started: silence
    for (float f : b) CHECK(f == 0.0f);
    o.start(0.0);
    o.stop(128.0 / 48000);
    o.process(0, 48000, b, 128);
    CHECK(o.finished());  // the end frame lies on the quantum boundary: Finish() in that quantum (Chromium 157)
    o.process(128, 48000, b, 128);
    for (float f : b) CHECK(f == 0.0f);

    BufferSource none(nullptr);
    float l[128];
    float *outp[1] = {l};
    none.process(0, 48000, outp, 128);
    CHECK_FALSE(none.ended());
    none.start(0);
    none.process(128, 48000, outp, 128);
    CHECK(none.ended());  // started without a buffer: finishes at once (Chromium)

    ConstantSource c(0.5);
    c.process(0, 48000, b, 128);
    CHECK(b[0] == 0.0f);
    c.start(0);
    c.process(128, 48000, b, 128);
    CHECK(b[127] == 0.5f);
    c.stop(300.0 / 48000);
    c.process(256, 48000, b, 128);
    CHECK((b[43] == 0.5f && b[44] == 0.0f));
    c.process(384, 48000, b, 128);
    CHECK(c.finished());
  }
}
