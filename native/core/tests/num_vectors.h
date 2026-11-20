// Shared helpers of the T01 vector tests: locate tools/golden/vectors/data, parse hex bit patterns.
#pragma once
#include <cstdint>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#ifndef RIG_REPO_DIR
#error "RIG_REPO_DIR must point at the repository root (CMake defines it for the test targets)"
#endif

namespace rigvec {

inline std::string dataPath(const char *name) {
  return std::string(RIG_REPO_DIR) + "/tools/golden/vectors/data/" + name;
}

/** All non-comment lines of a vector file (empty when the file is missing: tests then REQUIRE a minimum count). */
inline std::vector<std::string> lines(const char *name) {
  std::vector<std::string> out;
  std::ifstream in(dataPath(name));
  std::string l;
  while (std::getline(in, l))
    if (!l.empty() && l[0] != '#') out.push_back(l);
  return out;
}

inline std::vector<std::string> split(const std::string &s) {
  std::vector<std::string> t;
  std::istringstream ss(s);
  std::string w;
  while (ss >> w) t.push_back(w);
  return t;
}

inline double hexToDouble(const std::string &h) {
  const std::uint64_t u = std::stoull(h, nullptr, 16);
  double d;
  std::memcpy(&d, &u, sizeof d);
  return d;
}
inline std::uint64_t bits(double d) {
  std::uint64_t u;
  std::memcpy(&u, &d, sizeof u);
  return u;
}
inline std::uint32_t bits(float f) {
  std::uint32_t u;
  std::memcpy(&u, &f, sizeof u);
  return u;
}
/** Distance in ulps between two finite doubles of any sign. */
inline std::uint64_t ulpDiff(double a, double b) {
  auto ord = [](double x) {
    const std::uint64_t u = bits(x);
    return (u >> 63) ? -static_cast<std::int64_t>(u & 0x7fffffffffffffffULL) : static_cast<std::int64_t>(u);
  };
  const std::int64_t d = ord(a) - ord(b);
  return static_cast<std::uint64_t>(d < 0 ? -d : d);
}

}  // namespace rigvec
