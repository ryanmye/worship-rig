// T06: decoder parity against the golden Chromium's decodeAudioData (tools/golden/decode-dump/dump.mjs), resampler
// parity at 48 kHz, and the file decode paths. The numbers the T06 report quotes are printed by this test.
#include <algorithm>
#include <cmath>
#include <cstdio>

#include "doctest.h"
#include "samples_util.h"

using namespace samplestest;
using rig::samples::Pcm;

namespace {

struct Cmp {
  long lenDiff = 0;
  int lag = 0;           // best alignment of native vs chromium (frames; + = native late)
  double maxAbs = 0;     // after alignment
  double rms = 0;        // after alignment
  double maxAbsRaw = 0;  // no alignment
};

double sqDiff(const std::vector<float> &a, const std::vector<float> &b, int lag, std::size_t from, std::size_t n) {
  double s = 0;
  for (std::size_t i = from; i < from + n; ++i) {
    const long j = static_cast<long>(i) + lag;
    if (j < 0 || j >= static_cast<long>(b.size()) || i >= a.size()) continue;
    const double d = static_cast<double>(a[i]) - static_cast<double>(b[static_cast<std::size_t>(j)]);
    s += d * d;
  }
  return s;
}

// a = native, b = chromium. lag: a[i] vs b[i + lag].
Cmp compare(const std::vector<float> &a, const std::vector<float> &b) {
  Cmp c;
  c.lenDiff = static_cast<long>(a.size()) - static_cast<long>(b.size());
  const std::size_t n = std::min<std::size_t>(std::min(a.size(), b.size()) / 2, 40000);
  const std::size_t from = std::min(a.size(), b.size()) / 4;
  double best = 1e300;
  for (int lag = -1500; lag <= 1500; ++lag) {
    const double s = sqDiff(a, b, lag, from, n);
    if (s < best) {
      best = s;
      c.lag = lag;
    }
  }
  double acc = 0;
  std::size_t cnt = 0;
  for (std::size_t i = 0; i < a.size(); ++i) {
    const long j = static_cast<long>(i) + c.lag;
    if (j < 0 || j >= static_cast<long>(b.size())) continue;
    const double d = std::fabs(static_cast<double>(a[i]) - static_cast<double>(b[static_cast<std::size_t>(j)]));
    c.maxAbs = std::max(c.maxAbs, d);
    acc += d * d;
    ++cnt;
  }
  c.rms = cnt ? std::sqrt(acc / static_cast<double>(cnt)) : 0;
  for (std::size_t i = 0; i < std::min(a.size(), b.size()); ++i)
    c.maxAbsRaw = std::max(c.maxAbsRaw, std::fabs(static_cast<double>(a[i]) - static_cast<double>(b[i])));
  return c;
}

}  // namespace

TEST_SUITE("samples_decode") {
  TEST_CASE("decode parity vs Chromium decodeAudioData (reported)") {
    Dump d;
    if (!d.ok()) {
      MESSAGE("decode-dump not generated (node tools/golden/decode-dump/dump.mjs): skipped");
      return;
    }
    for (const int rate : {44100, 48000}) {
      std::printf("\n== decode vs Chromium @%d Hz: file, lenDiff(native-chromium), lag, maxAbs, rms, maxAbsRaw, "
                  "proc maxAbs\n", rate);
      std::size_t i, n;
      yyjson_val *f;
      int within = 0, total = 0;
      yyjson_arr_foreach(d.files, i, n, f) {
        const std::string url = str(f, "url");
        const std::string rel = std::string("raw") + std::to_string(rate) + "/" + str(f, "key") + ".wav";
        rig::io::WavData ref;
        REQUIRE(readDump(rel, ref));
        Pcm nat;
        REQUIRE(decodeAt(appDir() + url, rate, nat));
        REQUIRE(nat.channels == static_cast<int>(ref.ch.size()));
        Cmp worst;
        for (int c = 0; c < nat.channels; ++c) {
          Cmp k = compare(nat.ch[c], ref.ch[static_cast<std::size_t>(c)]);
          if (k.maxAbs >= worst.maxAbs) worst = k;
        }
        // after processSample on both sides (the engine's own onset trim): what the sampler fixtures would see
        const auto opts = optsOf(yyjson_obj_get(f, "opts"));
        const int midi = static_cast<int>(num(f, "midi"));
        std::vector<float> chromChs[2] = {ref.ch[0], ref.ch.size() > 1 ? ref.ch[1] : std::vector<float>()};
        auto pn = rig::samples::processSample(nat.ch, nat.channels, rate, midi, opts);
        auto pc = rig::samples::processSample(chromChs, static_cast<int>(ref.ch.size()), rate, midi, opts);
        double pmax = 0;
        const bool sameShape = pn.channels == pc.channels;
        for (int c = 0; sameShape && c < pn.channels; ++c)
          for (std::size_t k = 0; k < std::min(pn.ch[c].size(), pc.ch[c].size()); ++k)
            pmax = std::max(pmax, std::fabs(static_cast<double>(pn.ch[c][k]) - static_cast<double>(pc.ch[c][k])));
        std::printf("%-34s %+5ld %+5d  %.3e %.3e %.3e  %.3e%s onset n/c %.5f/%.5f\n", str(f, "key"), worst.lenDiff,
                    worst.lag, worst.maxAbs, worst.rms, worst.maxAbsRaw, pmax, sameShape ? "" : " (channels differ)",
                    pn.onsetTrim, pc.onsetTrim);
        ++total;
        if (sameShape && pmax <= 1e-4) ++within;
      }
      std::printf("   processed within 1e-4: %d/%d\n", within, total);
    }
  }
}
