// T03 kernels against the golden Chromium (157.0.8103.78): wa::DynamicsCompressor vs DynamicsCompressorNode renders
// (tools/golden/vectors/data/compressor.txt, dump-compressor.mjs), the makeup / glue-reference measurements vs the
// values fx.js measured in that Chromium, and wa::WaveShaper (curve lookup, 2x / 4x Up/DownSampler) vs
// WaveShaperNode renders (data/waveshaper.txt, dump-waveshaper.mjs). Every case replays the dumper's input formula
// with rig::js math and the same 128-frame quanta.
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "doctest.h"
#include "dsp/compressor.h"
#include "dsp/resampler_updown.h"
#include "dsp/waveshaper.h"
#include "mix/master_chain_tables.h"
#include "num/js_math.h"
#include "time/param.h"
#include "yyjson.h"

namespace {

const std::string kData = std::string(RIG_REPO_DIR) + "/tools/golden/vectors/data/";
constexpr std::size_t kQ = 128;

std::vector<float> b64floats(const std::string &s) {
  auto val = [](char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
  };
  std::vector<std::uint8_t> bytes;
  std::uint32_t acc = 0;
  int bits = 0;
  for (char c : s) {
    const int v = val(c);
    if (v < 0) continue;
    acc = (acc << 6) | static_cast<std::uint32_t>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push_back(static_cast<std::uint8_t>((acc >> bits) & 0xff));
    }
  }
  std::vector<float> f(bytes.size() / 4);
  std::memcpy(f.data(), bytes.data(), f.size() * 4);
  return f;
}

double fromHex64(const std::string &h) {
  const std::uint64_t u = std::stoull(h, nullptr, 16);
  double d;
  std::memcpy(&d, &u, 8);
  return d;
}

struct Case {
  std::string name, spec, out, out1;
};

std::vector<Case> readCases(const std::string &file, std::vector<std::string> *extra = nullptr) {
  std::ifstream in(kData + file);
  REQUIRE_MESSAGE(in.good(), "missing vector file " << file);
  std::vector<Case> cs;
  std::string line;
  while (std::getline(in, line)) {
    if (line.rfind("case ", 0) == 0) cs.push_back({line.substr(5), "", "", ""});
    else if (line.rfind("spec ", 0) == 0) cs.back().spec = line.substr(5);
    else if (line.rfind("out1 ", 0) == 0) cs.back().out1 = line.substr(5);
    else if (line.rfind("out ", 0) == 0) cs.back().out = line.substr(4);
    else if (extra && (line.rfind("makeup ", 0) == 0 || line.rfind("glueref ", 0) == 0)) extra->push_back(line);
  }
  return cs;
}

double num(yyjson_val *o, const char *k, double d = 0) {
  yyjson_val *v = yyjson_obj_get(o, k);
  return v && yyjson_is_num(v) ? yyjson_get_num(v) : d;
}

// dump-*.mjs noise(): integer hash, exact in float32
double noise(std::int64_t v) {
  auto imul = [](std::uint32_t a, std::uint32_t b) { return a * b; };
  std::uint32_t h = imul((static_cast<std::uint32_t>(v) ^ 99u) + 0x7f4a7c15u, 0x9e3779b1u);
  h ^= h >> 15;
  h = imul(h, 0x85ebca6bu);
  h ^= h >> 13;
  return static_cast<double>(h >> 8) / 8388608.0 - 1.0;
}

struct Diff {
  double max = 0;
  std::size_t at = 0;
};
Diff diff(const std::vector<float> &ref, const std::vector<float> &got) {
  Diff d;
  for (std::size_t i = 0; i < ref.size() && i < got.size(); ++i) {
    const double e = std::fabs(double(ref[i]) - double(got[i]));
    if (e > d.max) d = {e, i};
  }
  return d;
}

}  // namespace

TEST_SUITE("master-dsp") {
  TEST_CASE("DynamicsCompressor matches DynamicsCompressorNode sample by sample") {
    std::vector<std::string> extra;
    const auto cases = readCases("compressor.txt", &extra);
    REQUIRE(cases.size() >= 10);
    double worst = 0;
    for (const Case &cs : cases) {
      yyjson_doc *doc = yyjson_read(cs.spec.data(), cs.spec.size(), 0);
      yyjson_val *sp = yyjson_doc_get_root(doc);
      const double sr = num(sp, "sr");
      const auto frames = static_cast<std::size_t>(num(sp, "frames"));
      const auto ch = static_cast<unsigned>(num(sp, "ch"));
      yyjson_val *node = yyjson_obj_get(sp, "node"), *sig = yyjson_obj_get(sp, "sig");
      const bool sine = std::string(yyjson_get_str(yyjson_obj_get(sig, "kind"))) == "sine";
      const double hz = num(sig, "hz"), r = num(sig, "r", 1);
      const auto segN = static_cast<std::size_t>(rig::js::round(num(sig, "seg") * sr));
      std::vector<double> levels;
      {
        size_t i, n;
        yyjson_val *x;
        yyjson_arr_foreach(yyjson_obj_get(sig, "levels"), i, n, x) levels.push_back(yyjson_get_num(x));
      }
      std::vector<float> input[2];
      for (unsigned c = 0; c < ch; ++c) {
        input[c].resize(frames);
        for (std::size_t i = 0; i < frames; ++i) {
          const double a = rig::js::pow(10.0, levels[std::min(i / segN, levels.size() - 1)] / 20.0);
          const double v = sine ? a * rig::js::sin(2 * rig::js::kPi * hz * static_cast<double>(i) / sr)
                                : a * noise(static_cast<std::int64_t>(i * 2 + c));
          input[c][i] = static_cast<float>(c ? v * r : v);
        }
      }
      // node params (+ k-rate automation of threshold / ratio through wa::Param, as the AudioParams render)
      rig::wa::DynamicsCompressor::Params base;
      base.threshold = static_cast<float>(num(node, "threshold", -24));
      base.knee = static_cast<float>(num(node, "knee", 30));
      base.ratio = static_cast<float>(num(node, "ratio", 12));
      base.attack = static_cast<float>(num(node, "attack", 0.003));
      base.release = static_cast<float>(num(node, "release", 0.25));
      rig::wa::Param thr(base.threshold, -100.0f, 0.0f), rat(base.ratio, 1.0f, 20.0f);
      if (yyjson_val *ev = yyjson_obj_get(sp, "ev")) {
        size_t i, n;
        yyjson_val *e;
        yyjson_arr_foreach(ev, i, n, e) {
          const std::string p = yyjson_get_str(yyjson_arr_get(e, 0)), op = yyjson_get_str(yyjson_arr_get(e, 1));
          rig::wa::Param &P = p == "threshold" ? thr : rat;
          const double v = yyjson_get_num(yyjson_arr_get(e, 2)), t = yyjson_get_num(yyjson_arr_get(e, 3));
          if (op == "set") P.setValueAtTime(v, t);
          else P.setTargetAtTime(v, t, yyjson_get_num(yyjson_arr_get(e, 4)));
        }
      }
      rig::wa::DynamicsCompressor comp(sr);
      std::vector<float> got0(frames), got1(frames);
      float l[kQ], rr[kQ], a[kQ], b[kQ];
      for (std::size_t f0 = 0; f0 < frames; f0 += kQ) {
        const std::size_t n = std::min(kQ, frames - f0);
        for (std::size_t i = 0; i < kQ; ++i) {
          a[i] = i < n ? input[0][f0 + i] : 0.0f;
          b[i] = i < n && ch > 1 ? input[1][f0 + i] : 0.0f;
        }
        rig::wa::DynamicsCompressor::Params p = base;
        p.threshold = thr.processKRate(static_cast<std::int64_t>(f0), sr);
        p.ratio = rat.processKRate(static_cast<std::int64_t>(f0), sr);
        comp.setParams(p);
        const float *src[2] = {a, b};
        float *dst[2] = {l, rr};
        comp.process(src, ch, dst, kQ);
        for (std::size_t i = 0; i < n; ++i) {
          got0[f0 + i] = l[i];
          got1[f0 + i] = rr[i];
        }
      }
      const auto ref0 = b64floats(cs.out);
      const auto ref1 = cs.out1 == "same" ? ref0 : b64floats(cs.out1);
      REQUIRE(ref0.size() == frames);
      const Diff d0 = diff(ref0, got0), d1 = diff(ref1, got1);
      const double m = std::max(d0.max, d1.max);
      worst = std::max(worst, m);
      std::printf("  compressor %-20s max|diff| %.3g (frame %zu)\n", cs.name.c_str(), m,
                  d0.max >= d1.max ? d0.at : d1.at);
      CHECK_MESSAGE(m <= 2e-6, cs.name);
      yyjson_doc_free(doc);
    }
    std::printf("  compressor worst %.3g over %zu cases\n", worst, cases.size());
  }

  TEST_CASE("makeup and glue reference table match the values fx.js measured in Chromium") {
    std::vector<std::string> extra;
    readCases("compressor.txt", &extra);
    double chromeMakeup = 0;
    std::vector<double> chromeTable;
    for (const std::string &l : extra) {
      if (l.rfind("makeup ", 0) == 0) chromeMakeup = fromHex64(l.substr(7));
      if (l.rfind("glueref ", 0) == 0) {
        std::size_t p = 8;
        while (p < l.size()) {
          const std::size_t q = l.find(' ', p);
          chromeTable.push_back(fromHex64(l.substr(p, q == std::string::npos ? std::string::npos : q - p)));
          p = q == std::string::npos ? l.size() : q + 1;
        }
      }
    }
    REQUIRE(chromeTable.size() == rig::master::kGlueGrid + 1);
    const double m = rig::master::compMakeup();
    std::printf("  makeup native %.9f chromium %.9f (%.2f dB)\n", m, chromeMakeup, 20 * std::log10(m));
    CHECK(std::fabs(m / chromeMakeup - 1) < 1e-6);  // measured 3.9e-8 (wa::Oscillator is not bit-exact)
    const auto &t = rig::master::glueRefTable();
    for (std::size_t k = 0; k < t.size(); ++k) {
      std::printf("  glueref[%zu] native %.6f chromium %.6f dB\n", k, t[k], chromeTable[k]);
      CHECK(std::fabs(t[k] - chromeTable[k]) < 1e-5);
    }
    // contract 3.8: [0, .07, .45, 1.23, 2.23, 3.33, 4.51, 5.75, 7.02, 8.12, 8.44] dB; makeup ~ +1.10 dB
    CHECK(std::fabs(t[5] - 3.33) < 0.01);
    CHECK(std::fabs(20 * std::log10(m) - 1.10) < 0.01);
    CHECK(rig::master::glueRefDb(t, 0.35) == doctest::Approx(t[3] + (t[4] - t[3]) * 0.5).epsilon(1e-9));
  }

  TEST_CASE("compressor look-ahead and silence") {
    rig::wa::DynamicsCompressor c(44100);
    CHECK(c.latencyFrames() == 256);  // before the first quantum (kDefaultPreDelayFrames)
    float z[kQ] = {}, l[kQ], r[kQ];
    const float *src[1] = {z};
    float *dst[2] = {l, r};
    c.process(src, 1, dst, kQ);
    CHECK(c.latencyFrames() == 264);  // floor(.006 * 44100): contract "264 frames incl. its pre-delay"
    for (float v : l) CHECK(v == 0.0f);
    rig::wa::DynamicsCompressor c48(48000);
    c48.process(src, 1, dst, kQ);
    CHECK(c48.latencyFrames() == 288);
  }

  TEST_CASE("WaveShaper matches WaveShaperNode (none / 2x / 4x)") {
    const auto cases = readCases("waveshaper.txt");
    REQUIRE(cases.size() >= 11);
    for (const Case &cs : cases) {
      yyjson_doc *doc = yyjson_read(cs.spec.data(), cs.spec.size(), 0);
      yyjson_val *sp = yyjson_doc_get_root(doc);
      const double sr = num(sp, "sr"), amp = num(sp, "amp"), hz = num(sp, "hz");
      const auto frames = static_cast<std::size_t>(num(sp, "frames"));
      const auto ch = static_cast<unsigned>(num(sp, "ch"));
      const std::string os = yyjson_get_str(yyjson_obj_get(sp, "os"));
      yyjson_val *cv = yyjson_obj_get(sp, "curve");
      const std::string kind = yyjson_get_str(yyjson_obj_get(cv, "kind"));
      std::vector<float> curve;
      if (kind == "list") {
        size_t i, n;
        yyjson_val *x;
        yyjson_arr_foreach(yyjson_obj_get(cv, "p"), i, n, x) curve.push_back(static_cast<float>(yyjson_get_num(x)));
      } else {
        const auto n = static_cast<std::size_t>(num(cv, "n"));
        const double p = num(cv, "p");
        curve.resize(n);
        if (kind == "clip") {
          std::memcpy(curve.data(), rig::master::clipCurve(), n * sizeof(float));
        } else {
          for (std::size_t i = 0; i < n; ++i) {
            const double x = (static_cast<double>(i) / static_cast<double>(n - 1)) * 2 - 1;
            const double sc = rig::js::pow(2.0, p - 1);
            curve[i] = static_cast<float>(kind == "tanh" ? rig::js::tanh(p * x) / p : rig::js::round(x * sc) / sc);
          }
        }
      }
      const auto mode = os == "none" ? rig::wa::WaveShaper::Oversample::None
                        : os == "2x" ? rig::wa::WaveShaper::Oversample::X2
                                     : rig::wa::WaveShaper::Oversample::X4;
      rig::wa::WaveShaper ws(curve.data(), curve.size(), mode, ch);
      CHECK(ws.latencyFrames() == (os == "none" ? 0.0 : os == "2x" ? 128.0 : 192.0));
      std::vector<float> got[2];
      for (unsigned c = 0; c < ch; ++c) got[c].resize(frames);
      for (std::size_t f0 = 0; f0 < frames; f0 += kQ) {
        float buf[2][kQ];
        for (unsigned c = 0; c < ch; ++c)
          for (std::size_t i = 0; i < kQ; ++i) {
            const std::size_t f = f0 + i;
            const double t = static_cast<double>(f);
            buf[c][i] = f < frames ? static_cast<float>(amp * (t / static_cast<double>(frames)) *
                                                        (rig::js::sin(2 * rig::js::kPi * hz * t / sr) +
                                                         0.3 * noise(static_cast<std::int64_t>(f * 2 + c))))
                                   : 0.0f;
          }
        float *p[2] = {buf[0], buf[1]};
        ws.process(p, ch, kQ);
        for (unsigned c = 0; c < ch; ++c)
          for (std::size_t i = 0; i < kQ && f0 + i < frames; ++i) got[c][f0 + i] = buf[c][i];
      }
      const auto ref0 = b64floats(cs.out);
      REQUIRE(ref0.size() == frames);
      double m = diff(ref0, got[0]).max;
      if (ch == 2) m = std::max(m, diff(cs.out1 == "same" ? ref0 : b64floats(cs.out1), got[1]).max);
      // none / 2x use Chromium's exact operations; 4x convolves its large blocks directly where Chromium uses FFTs
      const double tol = os == "4x" ? 1e-6 : 0.0;
      std::printf("  waveshaper %-14s max|diff| %.3g\n", cs.name.c_str(), m);
      CHECK_MESSAGE(m <= tol, cs.name);
      yyjson_doc_free(doc);
    }
  }

  TEST_CASE("Up/DownSampler: latency, DC gain and a delayed pass band") {
    rig::wa::UpSampler up(128);
    rig::wa::DownSampler down(256);
    CHECK(up.latencyFrames() == 64);
    CHECK(down.latencyFrames() == 64);
    // a constant through up -> down settles to the same constant (half-band pair, unity DC gain)
    float in[128], mid[256], out[128];
    for (float &v : in) v = 0.25f;
    for (int q = 0; q < 8; ++q) {
      up.process(in, mid);
      down.process(mid, out);
    }
    for (float v : out) CHECK(v == doctest::Approx(0.25).epsilon(2e-3));
    // an impulse comes out of the pair 128 frames later (64 + 64 at the input rate), centred on that frame
    up.reset();
    down.reset();
    std::vector<float> resp;
    for (int q = 0; q < 4; ++q) {
      for (float &v : in) v = 0.0f;
      if (q == 0) in[0] = 1.0f;
      up.process(in, mid);
      down.process(mid, out);
      resp.insert(resp.end(), out, out + 128);
    }
    std::size_t peak = 0;
    for (std::size_t i = 0; i < resp.size(); ++i)
      if (std::fabs(resp[i]) > std::fabs(resp[peak])) peak = i;
    CHECK(peak == 128);
  }
}
