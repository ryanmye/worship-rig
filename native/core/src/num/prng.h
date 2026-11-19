// Port of app/js/shared/prng.js (SPEC §0.8: every random decision in the engine comes from one seeded stream) and of
// fx.js rngFor(). Bit-exact: the streams equal the JS ones (vectors: tools/golden/vectors/dump-prng.mjs ->
// tools/golden/vectors/data/prng.txt, tests/num_prng_test.cpp). Allocation-free and RT-safe except shuffle(),
// which works in place on caller storage.
#pragma once
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

#include "num/hash_seed.h"
#include "num/js_math.h"
#include "num/js_number.h"

namespace rig {

/** JS ToUint32 (`x >>> 0`): truncate toward zero, modulo 2^32; NaN and ±Infinity give 0. */
inline std::uint32_t toUint32(double x) {
  if (!std::isfinite(x)) return 0;
  const double t = std::trunc(x);
  double m = std::fmod(t, 4294967296.0);  // exact
  if (m < 0) m += 4294967296.0;
  return static_cast<std::uint32_t>(m);
}

/** mulberry32 (prng.js): next() returns a double in [0, 1) with 32 random bits. */
class Mulberry32 {
 public:
  explicit Mulberry32(std::uint32_t seed = 0) : a_(seed) {}
  double next() {
    a_ += 0x6d2b79f5u;  // (a + 0x6d2b79f5) | 0
    std::uint32_t t = (a_ ^ (a_ >> 15)) * (1u | a_);
    t = (t + ((t ^ (t >> 7)) * (61u | t))) ^ t;
    return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
  }
  std::uint32_t state() const { return a_; }

 private:
  std::uint32_t a_;
};

/** createRng (prng.js): mulberry32 plus the helpers, same draw order as JS. */
class Rng {
 public:
  explicit Rng(std::uint32_t seed = 0) : seed_(seed), gen_(seed) {}
  /** createRng(string): the seed is hashSeed(s). */
  explicit Rng(std::string_view s) : Rng(hashSeed(s)) {}

  std::uint32_t seed() const { return seed_; }
  double next() { return gen_.next(); }
  /** float in [a, b): a + (b - a) * next() */
  double range(double a, double b) { return a + (b - a) * next(); }
  /** integer in [a, b] inclusive (bounds may be given in either order and non-integer). */
  double integer(double a, double b) {
    const double lo = std::ceil(a < b ? a : b);
    const double hi = std::floor(a < b ? b : a);
    return lo + std::floor(next() * (hi - lo + 1));
  }
  /** standard normal, Box–Muller with the spare cached (two draws every other call). */
  double gaussian() {
    if (hasSpare_) {
      hasSpare_ = false;
      return spare_;
    }
    const double u1 = 1 - next();  // (0, 1] so log is finite
    const double u2 = next();
    const double r = js::sqrt(-2 * js::log(u1));
    spare_ = r * js::sin(2 * js::kPi * u2);
    hasSpare_ = true;
    return r * js::cos(2 * js::kPi * u2);
  }
  /** pick(): the index of the element JS would pick from an array of length n (n == 0: no draw, returns n). */
  std::size_t pickIndex(std::size_t n) {
    if (n == 0) return 0;
    return static_cast<std::size_t>(std::floor(next() * static_cast<double>(n)));
  }
  /** shuffle(): Fisher–Yates in place (JS returns a shuffled copy; same permutation). */
  template <class T>
  void shuffle(T *arr, std::size_t n) {
    for (std::size_t i = n; i-- > 1;) {
      const std::size_t j = static_cast<std::size_t>(std::floor(next() * static_cast<double>(i + 1)));
      T t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
  }
  /** fork(): createRng(Math.floor(next() * 4294967296) >>> 0). */
  Rng fork() { return Rng(toUint32(std::floor(next() * 4294967296.0))); }

 private:
  std::uint32_t seed_;
  Mulberry32 gen_;
  double spare_ = 0.0;
  bool hasSpare_ = false;
};

/** fx.js rngFor(seed, name) = createRng(hashSeed(`${seed >>> 0}|${name}`)). Control thread (builds a string). */
inline Rng rngFor(std::uint32_t seed, std::string_view name) {
  std::string s = std::to_string(seed);
  s += '|';
  s += name;
  return Rng(hashSeed(s));
}

/** Seed-string pieces formatted like a JS template literal `${n}` (String(n)), e.g. the IR key `${sr}`. */
inline void appendJs(std::string &s, double n) { s += js::numberToString(n); }

}  // namespace rig
