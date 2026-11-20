// T02 test helpers: read the single-node Chromium vector files of tools/golden/vectors/data (dump-biquad.mjs,
// dump-panner.mjs, dump-delay-line.mjs) and regenerate their inputs with rig::js math.
#pragma once
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "doctest.h"
#include "num/js_math.h"
#include "yyjson.h"

namespace t02 {

inline const std::string &dataDir() {
  static const std::string d = std::string(RIG_REPO_DIR) + "/tools/golden/vectors/data/";
  return d;
}

inline std::vector<float> b64floats(const std::string &s) {
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

struct Case {
  std::string name, spec, out, out1;
};

inline std::vector<Case> readCases(const std::string &file) {
  std::ifstream in(dataDir() + file);
  REQUIRE_MESSAGE(in.good(), "missing vector file " << file);
  std::vector<Case> cs;
  std::string line;
  while (std::getline(in, line)) {
    if (line.rfind("case ", 0) == 0) cs.push_back({line.substr(5), "", "", ""});
    else if (cs.empty()) continue;
    else if (line.rfind("spec ", 0) == 0) cs.back().spec = line.substr(5);
    else if (line.rfind("out1 ", 0) == 0) cs.back().out1 = line.substr(5);
    else if (line.rfind("out ", 0) == 0) cs.back().out = line.substr(4);
  }
  return cs;
}

/** The dumpers' integer hash noise in [-1, 1). */
inline double noise(std::uint32_t v) {
  std::uint32_t h = static_cast<std::uint32_t>((v ^ 99u) + 0x7f4a7c15u) * 0x9e3779b1u;
  h ^= h >> 15;
  h *= 0x85ebca6bu;
  h ^= h >> 13;
  return static_cast<double>(h >> 8) / 8388608.0 - 1.0;
}

/** amp * (Math.sin(2*PI*hz_c*i/sr) + 0.5 * noise(i*2+c)), hz_0 = 431, hz_1 = 2711, as float32. */
inline std::vector<float> input(unsigned c, std::size_t frames, double sr, double amp) {
  const double hz = c == 0 ? 431.0 : 2711.0;
  std::vector<float> d(frames);
  for (std::size_t i = 0; i < frames; ++i) {
    const double x = 2 * rig::js::kPi * hz * static_cast<double>(i) / sr;
    d[i] = static_cast<float>(amp * (rig::js::sin(x) + 0.5 * noise(static_cast<std::uint32_t>(i * 2 + c))));
  }
  return d;
}

/** Owned yyjson document of a spec line. */
struct Spec {
  yyjson_doc *doc;
  explicit Spec(const std::string &s) : doc(yyjson_read(s.data(), s.size(), 0)) {}
  ~Spec() { yyjson_doc_free(doc); }
  Spec(const Spec &) = delete;
  Spec &operator=(const Spec &) = delete;
  yyjson_val *root() const { return yyjson_doc_get_root(doc); }
  yyjson_val *get(const char *k) const { return yyjson_obj_get(root(), k); }
  double num(const char *k, double d = 0) const {
    yyjson_val *v = get(k);
    return v && yyjson_is_num(v) ? yyjson_get_num(v) : d;
  }
  std::string str(const char *k) const {
    yyjson_val *v = get(k);
    return v && yyjson_is_str(v) ? yyjson_get_str(v) : "";
  }
};

inline double maxDiff(const std::vector<float> &a, const std::vector<float> &b) {
  if (a.size() != b.size()) return 1e9;
  double m = 0;
  for (std::size_t i = 0; i < a.size(); ++i) {
    const double d = std::abs(static_cast<double>(a[i]) - static_cast<double>(b[i]));
    if (d > m || d != d) m = d != d ? 1e9 : d;
  }
  return m;
}

}  // namespace t02
