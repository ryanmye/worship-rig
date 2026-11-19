// Math.pow as Chromium 157 computes it on x86-64 Linux with an FMA CPU: V8 15.7 `math::pow` (src/numbers/ieee754.cc,
// BSD-3) in front of `std::pow`, which is glibc 2.39's __pow_fma (sysdeps/x86_64/fpu/multiarch/e_pow-fma.c, i.e.
// sysdeps/ieee754/dbl-64/e_pow.c built with gcc -O2 -mfma -mavx2). That algorithm is ARM optimized-routines math/pow.c;
// this file ports tag v23.01 (MIT OR Apache-2.0 WITH LLVM-exception, Copyright (c) 2018-2023 Arm Limited), whose code
// path is identical to glibc 2.39's.
//
// Why explicit std::fma: glibc's FMA variant is compiled with GCC's default -ffp-contract=fast, so besides the two
// fma() calls in the source GCC fused 18 more multiply-adds. Every fused operation of that build is written out here
// as std::fma (the list was read from `gcc -O2 -mfma -mavx2 -fdump-tree-widening_mul` of the same source, see
// native/core/src/num/README.md), and this file is compiled with -ffp-contract=off, so the result is the same on any
// IEEE-754 machine and compiler. Without the extra fusions 14020 of 2e7 inputs differ by 1 ulp from Chromium.
// Verified: 0 mismatches vs glibc ::pow on this box over 2e7 inputs and vs Chromium's Math.pow over 1e5 dumped cases.
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>

#include "num/js_math.h"

namespace rig::js {
namespace {

#include "num/js_pow_data.inc"

constexpr int kExpTableBits = 7;
constexpr int kN = 1 << kExpTableBits;
constexpr int kLogN = 1 << 7;
constexpr std::uint64_t kOff = 0x3fe6955500000000ULL;
constexpr std::uint32_t kSignBias = 0x800 << kExpTableBits;

inline std::uint64_t asuint64(double f) {
  std::uint64_t u;
  std::memcpy(&u, &f, sizeof u);
  return u;
}
inline double asdouble(std::uint64_t u) {
  double f;
  std::memcpy(&f, &u, sizeof f);
  return f;
}
inline std::uint32_t top12(double x) { return static_cast<std::uint32_t>(asuint64(x) >> 52); }

// __math_oflow / __math_uflow / __math_invalid (math_err.c): the value only (errno is not modelled).
inline double oflow(std::uint32_t sign) {
  const double y = 0x1p769;
  return (sign ? -y : y) * y;
}
inline double uflow(std::uint32_t sign) {
  const double y = 0x1p-767;
  return (sign ? -y : y) * y;
}
inline double invalid(double x) { return (x - x) / (x - x); }

/** log(x) as hi + tail; ix is the bit pattern of x normalised in the subnormal range. */
inline double logInline(std::uint64_t ix, double *tail) {
  const std::uint64_t tmp = ix - kOff;
  const int i = static_cast<int>((tmp >> (52 - 7)) % kLogN);
  const int k = static_cast<int>(static_cast<std::int64_t>(tmp) >> 52);
  const std::uint64_t iz = ix - (tmp & 0xfffULL << 52);
  const double z = asdouble(iz);
  const double kd = static_cast<double>(k);

  const double invc = kLogTab[i].invc;
  const double logc = kLogTab[i].logc;
  const double logctail = kLogTab[i].logctail;

  const double r = std::fma(z, invc, -1.0);
  const double t1 = std::fma(kd, kLn2hi, logc);      // contracted: kd * Ln2hi + logc
  const double t2 = t1 + r;
  const double lo1 = std::fma(kd, kLn2lo, logctail);  // contracted: kd * Ln2lo + logctail
  const double lo2 = t1 - t2 + r;

  const double ar = kLogPoly[0] * r;  // A[0] = -0.5
  const double ar2 = r * ar;
  const double ar3 = r * ar2;
  const double hi = t2 + ar2;
  const double lo3 = std::fma(ar, r, -ar2);
  const double lo4 = t2 - hi + ar2;
  // p = ar3 * (A1 + r*A2 + ar2*(A3 + r*A4 + ar2*(A5 + r*A6))), every product contracted; p itself is fused into lo.
  const double q12 = std::fma(r, kLogPoly[2], kLogPoly[1]);
  const double q34 = std::fma(r, kLogPoly[4], kLogPoly[3]);
  const double q56 = std::fma(r, kLogPoly[6], kLogPoly[5]);
  const double q36 = std::fma(ar2, q56, q34);
  const double q16 = std::fma(ar2, q36, q12);
  const double lo = std::fma(ar3, q16, lo1 + lo2 + lo3 + lo4);
  const double y = hi + lo;
  *tail = hi - y + lo;
  return y;
}

inline double specialcase(double tmp, std::uint64_t sbits, std::uint64_t ki) {
  if ((ki & 0x80000000) == 0) {
    // k > 0, the exponent of scale might have overflowed by <= 460.
    sbits -= 1009ULL << 52;
    const double scale = asdouble(sbits);
    return 0x1p1009 * std::fma(tmp, scale, scale);  // contracted: scale + scale * tmp
  }
  // k < 0, need special care in the subnormal range (not contracted by GCC: scale * tmp has two uses).
  sbits += 1022ULL << 52;
  const double scale = asdouble(sbits);
  const double st = scale * tmp;
  double y = scale + st;
  if (std::fabs(y) < 1.0) {
    double one = 1.0;
    if (y < 0.0) one = -1.0;
    double lo = scale - y + st;
    const double hi = one + y;
    lo = one - hi + y + lo;
    y = (hi + lo) - one;
    if (y == 0.0) y = asdouble(sbits & 0x8000000000000000ULL);
  }
  return 0x1p-1022 * y;
}

/** sign * exp(x + xtail). */
inline double expInline(double x, double xtail, std::uint32_t signBias) {
  std::uint32_t abstop = top12(x) & 0x7ff;
  if (abstop - top12(0x1p-54) >= top12(512.0) - top12(0x1p-54)) {
    if (abstop - top12(0x1p-54) >= 0x80000000) {
      // tiny x (incl. 0)
      const double one = 1.0 + x;
      return signBias ? -one : one;
    }
    if (abstop >= top12(1024.0)) {
      if (asuint64(x) >> 63) return uflow(signBias);
      return oflow(signBias);
    }
    abstop = 0;  // large x is special cased below
  }
  double kd = std::fma(x, kInvLn2N, kShift);  // contracted: z = InvLn2N * x; kd = z + Shift
  const std::uint64_t ki = asuint64(kd);
  kd -= kShift;
  double r = std::fma(kd, kNegLn2loN, std::fma(kd, kNegLn2hiN, x));
  r += xtail;
  const std::uint64_t idx = 2 * (ki % kN);
  const std::uint64_t top = (ki + signBias) << (52 - kExpTableBits);
  const double tail = asdouble(kExpTab[idx]);
  const std::uint64_t sbits = kExpTab[idx + 1] + top;
  const double r2 = r * r;
  // tmp = tail + r + r2 * (C2 + r * C3) + r2 * r2 * (C4 + r * C5), contracted
  const double a = std::fma(r2, std::fma(r, kExpPoly[1], kExpPoly[0]), r + tail);
  const double tmp = std::fma(r2 * r2, std::fma(r, kExpPoly[3], kExpPoly[2]), a);
  if (abstop == 0) return specialcase(tmp, sbits, ki);
  const double scale = asdouble(sbits);
  return std::fma(tmp, scale, scale);  // contracted: scale + scale * tmp
}

/** 0 if not an integer, 1 if odd, 2 if even; iy = bits of a non-zero finite value. */
inline int checkint(std::uint64_t iy) {
  const int e = static_cast<int>(iy >> 52 & 0x7ff);
  if (e < 0x3ff) return 0;
  if (e > 0x3ff + 52) return 2;
  if (iy & ((1ULL << (0x3ff + 52 - e)) - 1)) return 0;
  if (iy & (1ULL << (0x3ff + 52 - e))) return 1;
  return 2;
}

inline bool zeroinfnan(std::uint64_t i) { return 2 * i - 1 >= 2 * asuint64(INFINITY) - 1; }

/** glibc 2.39 __pow_fma. */
double glibcPow(double x, double y) {
  std::uint32_t signBias = 0;
  std::uint64_t ix = asuint64(x);
  const std::uint64_t iy = asuint64(y);
  std::uint32_t topx = top12(x);
  const std::uint32_t topy = top12(y);
  if (topx - 0x001 >= 0x7ff - 0x001 || (topy & 0x7ff) - 0x3be >= 0x43e - 0x3be) {
    if (zeroinfnan(iy)) {
      if (2 * iy == 0) return 1.0;
      if (ix == asuint64(1.0)) return 1.0;
      if (2 * ix > 2 * asuint64(INFINITY) || 2 * iy > 2 * asuint64(INFINITY)) return x + y;
      if (2 * ix == 2 * asuint64(1.0)) return 1.0;
      if ((2 * ix < 2 * asuint64(1.0)) == !(iy >> 63)) return 0.0;  // |x|<1 && y==inf or |x|>1 && y==-inf
      return y * y;
    }
    if (zeroinfnan(ix)) {
      double x2 = x * x;
      if (ix >> 63 && checkint(iy) == 1) x2 = -x2;
      return iy >> 63 ? 1 / x2 : x2;
    }
    // x and y are non-zero finite
    if (ix >> 63) {
      const int yint = checkint(iy);
      if (yint == 0) return invalid(x);
      if (yint == 1) signBias = kSignBias;
      ix &= 0x7fffffffffffffffULL;
      topx &= 0x7ff;
    }
    if ((topy & 0x7ff) - 0x3be >= 0x43e - 0x3be) {
      if (ix == asuint64(1.0)) return 1.0;
      if ((topy & 0x7ff) < 0x3be) return ix > asuint64(1.0) ? 1.0 + y : 1.0 - y;  // |y| < 2^-65
      return (ix > asuint64(1.0)) == (topy < 0x800) ? oflow(0) : uflow(0);
    }
    if (topx == 0) {
      // normalise subnormal x so the exponent becomes negative
      ix = asuint64(x * 0x1p52);
      ix &= 0x7fffffffffffffffULL;
      ix -= 52ULL << 52;
    }
  }
  double lo;
  const double hi = logInline(ix, &lo);
  const double ehi = y * hi;
  const double elo = std::fma(y, lo, std::fma(y, hi, -ehi));  // contracted: y * lo + fma(y, hi, -ehi)
  return expInline(ehi, elo, signBias);
}

}  // namespace

double pow(double x, double y) {
  // V8 15.7 src/numbers/ieee754.cc math::pow
  if (std::isnan(y)) return std::numeric_limits<double>::quiet_NaN();
  if (std::isinf(y) && (x == 1 || x == -1)) return std::numeric_limits<double>::quiet_NaN();
  if (std::isnan(x)) x = std::numeric_limits<double>::quiet_NaN();
  if (y == 2) return x * x;
  if (y == 0.5) {
    if (std::isinf(x)) return std::numeric_limits<double>::infinity();
    return std::sqrt(x + 0);
  }
  return glibcPow(x, y);
}

}  // namespace rig::js
