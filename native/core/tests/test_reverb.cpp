// T04 reverb: IR generator bit-exact vs the golden Chromium (tools/golden/vectors/data/reverb-ir.txt), the
// partitioned convolver vs direct convolution and vs Chromium's ConvolverNode (data/reverb-conv.txt), and the
// ported JS test irRecipe.
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "doctest.h"
#include "dsp/convolver.h"
#include "fx/ir_gen.h"
#include "num/js_math.h"
#include "num/prng.h"

namespace {

const std::string kData = std::string(RIG_REPO_DIR) + "/tools/golden/vectors/data/";

std::uint32_t fnvBytes(const std::vector<float> &a) {
  std::uint32_t h = 0x811c9dc5u;
  const auto *b = reinterpret_cast<const unsigned char *>(a.data());
  for (std::size_t i = 0; i < a.size() * 4; ++i) h = (h ^ b[i]) * 0x01000193u;
  return h;
}
std::uint32_t fnvWords(const std::vector<float> &a) {
  std::uint32_t h = 0x811c9dc5u;
  for (float f : a) {
    std::uint32_t w;
    std::memcpy(&w, &f, 4);
    h = (h ^ w) * 0x01000193u;
  }
  return h;
}
std::uint32_t bits(float f) {
  std::uint32_t w;
  std::memcpy(&w, &f, 4);
  return w;
}
float fromBits(std::uint32_t w) {
  float f;
  std::memcpy(&f, &w, 4);
  return f;
}
double fromHex64(const std::string &h) {
  const std::uint64_t u = std::stoull(h, nullptr, 16);
  double d;
  std::memcpy(&d, &u, 8);
  return d;
}
double energy(const rig::fx::IrChannels &ir) {
  double e = 0;
  for (const auto &ch : ir.ch)
    for (float v : ch) e += double(v) * double(v);
  return e;
}

/** test/phase1/engine/suites.mjs irRecipe's Park-Miller LCG. */
struct Lcg final : rig::fx::IrRandom {
  double s = 1;
  double next() override {
    s = std::fmod(s * 16807, 2147483647);
    return s / 2147483647;
  }
};

// Inputs of the ConvolverNode vectors (dump-reverb.mjs genIr / genIn, float32 via Math.fround).
std::vector<float> genIr(std::size_t len, int c) {
  rig::Mulberry32 r(static_cast<std::uint32_t>(1000 + c));
  std::vector<float> a(len);
  for (std::size_t i = 0; i < len; ++i)
    a[i] = static_cast<float>((r.next() * 2 - 1) * 0.05 * rig::js::exp(-3.0 * double(i) / double(len)));
  return a;
}
std::vector<float> genIn(std::size_t frames, int c) {
  rig::Mulberry32 r(static_cast<std::uint32_t>(2000 + c));
  std::vector<float> a(frames, 0.0f);
  const std::size_t burst = frames / 4;
  for (std::size_t i = 0; i < burst; ++i) a[i] = static_cast<float>((r.next() * 2 - 1) * 0.25);
  a[frames / 3] = 0.5f;
  a[frames / 3 + 777] = -0.3f;
  return a;
}

/** Run a convolver over `in` (zero-padded to whole quanta). */
std::vector<float> runConv(const rig::wa::ConvolverKernel &k, const std::vector<float> &in, std::size_t frames,
                           unsigned phase = 0) {
  rig::wa::Convolver cv(k, phase);
  std::vector<float> out(frames + 128, 0.0f);
  std::vector<float> x(frames + 128, 0.0f);
  std::copy(in.begin(), in.begin() + static_cast<long>(std::min(in.size(), frames)), x.begin());
  for (std::size_t q = 0; q < frames; q += 128) cv.process(x.data() + q, out.data() + q);
  out.resize(frames);
  return out;
}

std::vector<double> directConv(const std::vector<float> &h, const std::vector<float> &x, std::size_t frames,
                               double scale = 1.0) {
  std::vector<double> y(frames, 0.0);
  for (std::size_t n = 0; n < frames && n < x.size(); ++n) {
    if (x[n] == 0.0f) continue;
    for (std::size_t t = 0; t < h.size() && n + t < frames; ++t) y[n + t] += double(x[n]) * double(h[t]) * scale;
  }
  return y;
}

}  // namespace

TEST_SUITE("reverb") {
  TEST_CASE("IR keys, seeds and buckets as fx.js") {
    CHECK(rig::fx::reverbBucket(0.5) == 5);
    CHECK(rig::fx::reverbBucket(0.18) == 1.5);
    CHECK(rig::fx::reverbBucket(0.42) == 3.8);
    CHECK(rig::fx::reverbBucket(0.65) == 6.5);
    CHECK(rig::fx::reverbBucket(1) == 8);
    CHECK(rig::fx::reverbBucket(0) == 1.5);
    CHECK(rig::fx::dampQ(0.45) == 0.5);
    CHECK(rig::fx::dampQ(0.35) == 0.4);
    CHECK(rig::fx::dampQ(-1) == 0);
    CHECK(rig::fx::irKey(0.18, 0.6, 44100) == "1.5|0.6|44100");
    // manifest.json randomness streams of the golden fixtures
    CHECK(rig::fx::irSeed(1, "5|0.5|44100") == 3286534298u);
    CHECK(rig::fx::irSeed(1, "1.5|0.6|44100") == 1336640726u);
    CHECK(rig::fx::irSeed(1, "3.8|0.5|44100") == 111885742u);
    CHECK(rig::fx::irSeed(1, "6.5|0.5|44100") == 203665850u);
    CHECK(rig::fx::irSeed(1, "8|0.4|44100") == 2651569338u);
    CHECK(rig::fx::irSeed(1, "8|0.3|44100") == 782184627u);
  }

  TEST_CASE("IR generator is bit-exact against the golden Chromium (reverb-ir.txt)") {
    std::ifstream f(kData + "reverb-ir.txt");
    REQUIRE(f.good());
    std::string line;
    int irs = 0, lcgs = 0;
    while (std::getline(f, line)) {
      std::istringstream ss(line);
      std::string tag;
      ss >> tag;
      if (tag == "ir") {
        unsigned seed;
        double sr, size, damp;
        std::string key, fl, fr, wl, wr, eh, idx;
        std::uint32_t rngSeed;
        std::size_t len;
        ss >> seed >> sr >> size >> damp >> key >> rngSeed >> len >> fl >> fr >> wl >> wr >> eh >> idx;
        INFO(line.substr(0, 60));
        CHECK(rig::fx::irKey(size, damp, sr) == key);
        CHECK(rig::fx::irSeed(seed, key) == rngSeed);
        const rig::fx::IrChannels ir = rig::fx::engineIr(sr, seed, size, damp);
        REQUIRE(ir.length() == len);
        CHECK(fnvBytes(ir.ch[0]) == std::stoul(fl, nullptr, 16));
        CHECK(fnvBytes(ir.ch[1]) == std::stoul(fr, nullptr, 16));
        CHECK(fnvWords(ir.ch[0]) == std::stoul(wl, nullptr, 16));
        CHECK(fnvWords(ir.ch[1]) == std::stoul(wr, nullptr, 16));
        CHECK(energy(ir) == fromHex64(eh));
        // the selected samples, for a readable first mismatch
        std::istringstream is(idx.substr(4));
        std::string item;
        int bad = 0;
        while (std::getline(is, item, ';')) {
          const std::size_t c = item.find(':'), m = item.find(',');
          const std::size_t i = std::stoul(item.substr(0, c));
          const std::uint32_t l = static_cast<std::uint32_t>(std::stoul(item.substr(c + 1, m - c - 1), nullptr, 16));
          const std::uint32_t r = static_cast<std::uint32_t>(std::stoul(item.substr(m + 1), nullptr, 16));
          if ((bits(ir.ch[0][i]) != l || bits(ir.ch[1][i]) != r) && bad++ < 3)
            MESSAGE("sample " << i << ": " << ir.ch[0][i] << " vs " << fromBits(l));
        }
        CHECK(bad == 0);
        ++irs;
      } else if (tag == "lcg") {
        double sr, sizeSec, damp;
        std::size_t len;
        std::string fl, fr, wl, wr, eh;
        ss >> sr >> sizeSec >> damp >> len >> fl >> fr >> wl >> wr >> eh;
        Lcg lcg;
        const rig::fx::IrChannels ir = rig::fx::generateIr(sr, lcg, sizeSec, damp);
        REQUIRE(ir.length() == len);
        CHECK(fnvBytes(ir.ch[0]) == std::stoul(fl, nullptr, 16));
        CHECK(fnvBytes(ir.ch[1]) == std::stoul(fr, nullptr, 16));
        CHECK(energy(ir) == fromHex64(eh));
        ++lcgs;
      }
    }
    CHECK(irs == 13);
    CHECK(lcgs == 2);
  }

  TEST_CASE("irRecipe (suites.mjs): energy 0.7, 2.6-2.7 s, two channels") {
    for (double sr : {44100.0, 48000.0}) {
      Lcg lcg;
      const rig::fx::IrChannels ir = rig::fx::generateIr(sr, lcg, 2, 0.5);
      const double seconds = double(ir.length()) / sr;
      CHECK(std::fabs(energy(ir) - 0.7) < 1e-3);
      CHECK(seconds > 2.6);
      CHECK(seconds < 2.7);
      CHECK(ir.ch[1].size() == ir.ch[0].size());
    }
  }

  TEST_CASE("partitioned convolver equals direct convolution (<= 1e-6) for every stage layout") {
    // lengths: direct only, stage 1 partial, all three stages, the 8 s bucket at 48 kHz (1.1 x 9.6 s)
    for (std::size_t len : {std::size_t(1), std::size_t(127), std::size_t(128), std::size_t(129), std::size_t(2048),
                            std::size_t(2049), std::size_t(16384), std::size_t(16385), std::size_t(40000)}) {
      INFO("len " << len);
      std::vector<float> h = genIr(len, 0);
      const rig::wa::ConvolverKernel k(h.data(), h.size());
      const std::size_t frames = len + 4096;
      std::vector<float> x = genIn(frames, 0);
      for (unsigned phase : {0u, 1u}) {
        const auto y = runConv(k, x, frames, phase);
        const auto ref = directConv(h, x, frames);
        double m = 0;
        for (std::size_t i = 0; i < frames; ++i) m = std::fmax(m, std::fabs(double(y[i]) - ref[i]));
        CHECK(m <= 1e-6);
      }
    }
  }

  TEST_CASE("convolver with a real 8 s / 48 kHz reverb IR: impulse response reproduced, tail ends") {
    const rig::fx::IrChannels ir = rig::fx::engineIr(48000, 1, 1.0, 0.25);
    REQUIRE(ir.length() > 500000);
    for (int c = 0; c < 2; ++c) {
      const rig::wa::ConvolverKernel k(ir.ch[c].data(), ir.length());
      rig::wa::Convolver cv(k, static_cast<unsigned>(c));
      std::vector<float> in(128, 0.0f), out(128);
      const std::size_t start = 300;  // impulse at frame 300 (mid-quantum), amplitude 0.5
      double m = 0;
      std::size_t lastNonZero = 0;
      const std::size_t total = ((start + ir.length() + cv.tailFrames()) / 128 + 2) * 128;
      for (std::size_t q = 0; q < total; q += 128) {
        std::fill(in.begin(), in.end(), 0.0f);
        if (start >= q && start < q + 128) in[start - q] = 0.5f;
        cv.process(in.data(), out.data());
        for (std::size_t i = 0; i < 128; ++i) {
          const std::size_t f = q + i;
          const double want = f >= start && f - start < ir.length() ? 0.5 * double(ir.ch[c][f - start]) : 0.0;
          m = std::fmax(m, std::fabs(double(out[i]) - want));
          if (out[i] != 0.0f) lastNonZero = f;
        }
      }
      CHECK(m <= 1e-6);
      CHECK(lastNonZero < start + ir.length() + cv.tailFrames());
      CHECK(k.bytes() > 3'000'000);
      CHECK(k.bytes() < 5'000'000);
    }
  }

  TEST_CASE("convolver vs Chromium ConvolverNode incl. normalisation (reverb-conv.txt)") {
    std::ifstream f(kData + "reverb-conv.txt");
    REQUIRE(f.good());
    std::string line;
    int cases = 0;
    while (std::getline(f, line)) {
      if (line.rfind("case ", 0) != 0) continue;
      std::istringstream ss(line.substr(5));
      std::string name, sl, sr2;
      double sr;
      std::size_t irLen, frames, stride;
      unsigned irCh, inCh, norm;
      ss >> name >> sr >> irLen >> irCh >> inCh >> norm >> frames >> stride >> sl >> sr2;
      INFO("case " << name);
      std::vector<std::vector<float>> ir(irCh), in(inCh);
      for (unsigned c = 0; c < irCh; ++c) ir[c] = genIr(irLen, int(c));
      for (unsigned c = 0; c < inCh; ++c) in[c] = genIn(frames, int(c));
      std::vector<const float *> irp;
      for (auto &v : ir) irp.push_back(v.data());
      const float scale = norm ? rig::wa::chromiumNormalizationScale(irp.data(), irCh, irLen, sr) : 1.0f;
      double worst = 0, peak = 0;
      for (unsigned c = 0; c < 2; ++c) {
        std::string ol;
        REQUIRE(std::getline(f, ol));
        std::istringstream os(ol);
        std::string tag;
        unsigned oc;
        os >> tag >> oc;
        REQUIRE(oc == c);
        // Reverb::Process: 2 -> 2 -> 2 (L->L, R->R) or 1 -> 2 -> 2 (mono input into both)
        const rig::wa::ConvolverKernel k(ir[std::min(c, irCh - 1)].data(), irLen, scale);
        const auto y = runConv(k, in[std::min(c, inCh - 1)], frames, c);
        std::string hx;
        std::size_t i = 0;
        double sumsq = 0;
        for (float v : y) sumsq += double(v) * double(v);
        while (os >> hx) {
          const float want = fromBits(static_cast<std::uint32_t>(std::stoul(hx, nullptr, 16)));
          worst = std::fmax(worst, std::fabs(double(want) - double(y[i * stride])));
          peak = std::fmax(peak, std::fabs(double(want)));
          ++i;
        }
        CHECK(i == (frames + stride - 1) / stride);
        const double ref = fromHex64(c == 0 ? sl : sr2);
        CHECK(std::fabs(sumsq - ref) <= 1e-5 * ref);
      }
      MESSAGE(name << ": max |native - Chromium| = " << worst << " (peak " << peak << ")");
      CHECK(worst <= 1e-6 * std::fmax(1.0, peak));
      ++cases;
    }
    CHECK(cases == 6);
  }
}
