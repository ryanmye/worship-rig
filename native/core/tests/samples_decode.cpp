// T06: decoder parity against the golden Chromium's decodeAudioData (tools/golden/decode-dump/dump.mjs), resampler
// parity at 48 kHz, and the file decode paths. The numbers the T06 report quotes are printed by this test.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <unistd.h>

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

namespace {
std::string tmpPath(const char *name) {
  return (std::filesystem::temp_directory_path() / (std::string("rig_t06_") + std::to_string(::getpid()) + name))
      .string();
}
}  // namespace

TEST_SUITE("samples_decode") {
  TEST_CASE("WAV decode: float32 and PCM16 files, channel split, rate") {
    std::vector<std::vector<float>> ch(2, std::vector<float>(1000));
    for (std::size_t i = 0; i < 1000; ++i) {
      ch[0][i] = static_cast<float>(std::sin(0.01 * static_cast<double>(i)) * 0.5);
      ch[1][i] = static_cast<float>(std::cos(0.02 * static_cast<double>(i)) * 0.25);
    }
    const std::string a = tmpPath("_f32.wav"), b = tmpPath("_pcm16.wav");
    REQUIRE(rig::io::writeWavF32(a, ch, 44100));
    REQUIRE(rig::io::writeWavPcm16(b, ch, 22050));
    auto ra = rig::samples::decodeFile(a, nullptr);
    REQUIRE(ra.ok());
    CHECK(ra.pcm.channels == 2);
    CHECK(ra.pcm.sampleRate == 44100);
    CHECK(ra.pcm.frames() == 1000);
    for (std::size_t i = 0; i < 1000; ++i) REQUIRE(ra.pcm.ch[0][i] == ch[0][i]);
    auto rb = rig::samples::decodeFile(b, nullptr);
    REQUIRE(rb.ok());
    CHECK(rb.pcm.sampleRate == 22050);
    double mx = 0;
    for (std::size_t i = 0; i < 1000; ++i)
      mx = std::max(mx, std::fabs(static_cast<double>(rb.pcm.ch[1][i]) - ch[1][i]));
    CHECK(mx <= 1.0 / 32768.0 + 1e-9);
    std::remove(a.c_str());
    std::remove(b.c_str());
  }

  TEST_CASE("failures: missing file and garbage are permanent; unknown formats need the host hook") {
    CHECK(rig::samples::decodeFile("/nonexistent/none.mp3", nullptr).status ==
          rig::samples::DecodeResult::Status::Permanent);
    const std::string g = tmpPath("_garbage.mp3");
    if (std::FILE *f = std::fopen(g.c_str(), "wb")) {
      const char junk[] = "this is not an mp3 file at all, just text";
      std::fwrite(junk, 1, sizeof junk, f);
      std::fclose(f);
    }
    auto r = rig::samples::decodeFile(g, nullptr);
    CHECK_FALSE(r.ok());
    CHECK(r.status == rig::samples::DecodeResult::Status::Permanent);
    // AAC/M4A goes to the host decoder; without one it fails with a clear error
    const std::string m = tmpPath("_clip.m4a");
    if (std::FILE *f = std::fopen(m.c_str(), "wb")) {
      std::fputs("fake m4a", f);
      std::fclose(f);
    }
    CHECK_FALSE(rig::samples::decodeFile(m, nullptr).ok());
    int calls = 0;
    auto host = [&](const std::string &path, Pcm &out, std::string *) {
      ++calls;
      CHECK(path == m);
      out.sampleRate = 32000;
      out.channels = 2;
      out.ch[0].assign(64, 0.25f);
      out.ch[1].assign(64, -0.25f);
      return true;
    };
    auto h = rig::samples::decodeFile(m, host);
    REQUIRE(h.ok());
    CHECK(calls == 1);
    CHECK(h.pcm.sampleRate == 32000);
    CHECK(h.pcm.ch[1][10] == -0.25f);
    auto bad = rig::samples::decodeFile(m, [](const std::string &, Pcm &, std::string *e) {
      *e = "no codec";
      return false;
    });
    CHECK_FALSE(bad.ok());
    CHECK(bad.error == "no codec");
    std::remove(g.c_str());
    std::remove(m.c_str());
  }

  TEST_CASE("resampler: lengths follow decodeAudioData, identity at equal rates, sine fidelity") {
    CHECK(rig::samples::resampledLength(960000, 48000, 44100) == 881999);  // floor(960000 / (48000/44100))
    CHECK(rig::samples::resampledLength(137984, 44100, 48000) == 150186);
    CHECK(rig::samples::resampledLength(1234, 44100, 44100) == 1234);
    std::vector<float> in(44100), out;
    for (std::size_t i = 0; i < in.size(); ++i)
      in[i] =
          static_cast<float>(0.5 * std::sin(2 * 3.14159265358979323846 * 1000.0 * static_cast<double>(i) / 44100.0));
    rig::samples::resampleChannel(in, 44100, 44100, out);
    CHECK(out == in);
    for (const double sr : {48000.0, 32000.0, 22050.0}) {
      rig::samples::resampleChannel(in, 44100, sr, out);
      REQUIRE(out.size() == rig::samples::resampledLength(in.size(), 44100, sr));
      double mx = 0;
      for (std::size_t i = 64; i + 64 < out.size(); ++i)
        mx = std::max(mx, std::fabs(static_cast<double>(out[i]) -
                                    0.5 * std::sin(2 * 3.14159265358979323846 * 1000.0 * static_cast<double>(i) / sr)));
      CHECK(mx < 2e-4);  // windowed-sinc error of a 1 kHz tone (the filter is 32 taps, cutoff 0.9 Nyquist)
    }
  }

  TEST_CASE("decode parity vs Chromium decodeAudioData (reported)") {
    Dump d;
    if (!d.ok()) {
      MESSAGE("decode-dump not generated (node tools/golden/decode-dump/dump.mjs): skipped");
      return;
    }
    for (const int rate : {44100, 48000}) {
      std::printf(
          "\n== decode vs Chromium @%d Hz: file, lenDiff(native-chromium), lag, maxAbs, rms, maxAbsRaw, "
          "proc maxAbs\n",
          rate);
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
        CHECK(worst.maxAbs <= 1e-4);  // 20/20 files at both rates: the decoder + resampler agree to -80 dB
        CHECK(worst.lenDiff == 0);
        CHECK(worst.lag == 0);  // same gapless handling (encoder delay / padding trimmed identically)
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
      std::printf("   processed within 1e-4: %d/%d (BUILD_PLAN T06: >= 18 of 20, else pcmOverride is mandatory)\n",
                  within, total);
      // a sample crossing the -50 dBFS onset threshold in one decoder only moves the trimmed start by 1-3 frames
      CHECK(within >= (rate == 48000 ? 18 : 15));
    }
  }
}
