// Math.tanh as Chromium 157 computes it on x86-64 Linux with an FMA CPU: V8 15.7 forwards to `std::tanh`, which is
// glibc 2.39's __tanh_fma (sysdeps/x86_64/fpu/multiarch/s_tanh-fma.c = sysdeps/ieee754/dbl-64/s_tanh.c built with
// -mfma -mavx2), calling __expm1_fma (s_expm1.c, same flags). Both sources are fdlibm (Sun notice below; glibc's
// s_expm1.c carries a 1997 change by Naohiko Shimizu). GCC fused 12 multiply-adds in __expm1_fma (none in tanh);
// each is an explicit std::fma here (list from `gcc -O2 -mfma -mavx2 -fdump-tree-widening_mul`, see README.md) and
// this file is compiled with -ffp-contract=off. Verified: 0 mismatches vs glibc ::tanh/::expm1 on this box over 2e7
// inputs, and vs Chromium's Math.tanh over 1e5 dumped cases. Without the fusions 2921 of 2e7 tanh values differ.
//
// ====================================================
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//
// Developed at SunPro, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================
#include <cmath>
#include <cstdint>
#include <cstring>

#include "num/js_math.h"

namespace rig::js {
namespace {

inline std::int32_t highWord(double d) {
  std::uint64_t b;
  std::memcpy(&b, &d, sizeof b);
  return static_cast<std::int32_t>(b >> 32);
}
inline std::uint32_t lowWord(double d) {
  std::uint64_t b;
  std::memcpy(&b, &d, sizeof b);
  return static_cast<std::uint32_t>(b);
}
inline void setHighWord(double &d, std::uint32_t v) {
  std::uint64_t b;
  std::memcpy(&b, &d, sizeof b);
  b = (b & 0xffffffffULL) | (static_cast<std::uint64_t>(v) << 32);
  std::memcpy(&d, &b, sizeof b);
}

constexpr double kHuge = 1.0e+300, kTiny = 1.0e-300;
constexpr double kOThreshold = 7.09782712893383973096e+02;  // 0x40862E42, 0xFEFA39EF
constexpr double kLn2Hi = 6.93147180369123816490e-01;       // 0x3fe62e42, 0xfee00000
constexpr double kLn2Lo = 1.90821492927058770002e-10;       // 0x3dea39ef, 0x35793c76
constexpr double kInvLn2 = 1.44269504088896338700e+00;      // 0x3ff71547, 0x652b82fe
constexpr double kQ[] = {1.0, -3.33333333333331316428e-02,  // BFA11111 111110F4
                         1.58730158725481460165e-03,        // 3F5A01A0 19FE5585
                         -7.93650757867487942473e-05,       // BF14CE19 9EAADBB7
                         4.00821782732936239552e-06,        // 3ED0CFCA 86E65239
                         -2.01099218183624371326e-07};      // BE8AFDB7 6E09C32D

/** glibc 2.39 __expm1_fma. */
double glibcExpm1(double x) {
  double y, hi, lo, c = 0.0, t, e;
  std::int32_t k;
  std::uint32_t hx = static_cast<std::uint32_t>(highWord(x));
  const std::uint32_t xsb = hx & 0x80000000;
  hx &= 0x7fffffff;

  // filter out huge and non-finite argument
  if (hx >= 0x4043687A) {    // |x| >= 56*ln2
    if (hx >= 0x40862E42) {  // |x| >= 709.78...
      if (hx >= 0x7ff00000) {
        if (((hx & 0xfffff) | lowWord(x)) != 0) return x + x;  // NaN
        return (xsb == 0) ? x : -1.0;                           // exp(+-inf) = {inf, -1}
      }
      if (x > kOThreshold) return kHuge * kHuge;  // overflow
    }
    if (xsb != 0) return kTiny - kQ[0];  // x < -56*ln2, return -1.0 with inexact
  }

  // argument reduction
  if (hx > 0x3fd62e42) {    // |x| > 0.5 ln2
    if (hx < 0x3FF0A2B2) {  // and |x| < 1.5 ln2
      if (xsb == 0) {
        hi = x - kLn2Hi;
        lo = kLn2Lo;
        k = 1;
      } else {
        hi = x + kLn2Hi;
        lo = -kLn2Lo;
        k = -1;
      }
    } else {
      k = static_cast<std::int32_t>(kInvLn2 * x + ((xsb == 0) ? 0.5 : -0.5));  // not contracted by GCC
      t = k;
      hi = std::fma(-t, kLn2Hi, x);  // contracted: x - t * ln2_hi
      lo = t * kLn2Lo;               // two uses: not contracted
    }
    x = hi - lo;
    c = (hi - x) - lo;
  } else if (hx < 0x3c900000) {  // |x| < 2**-54, return x
    t = kHuge + x;
    return x - (t - (kHuge + x));
  } else {
    k = 0;
  }

  // x is now in primary range
  const double hfx = 0.5 * x;
  const double hxs = x * hfx;
  const double R1 = std::fma(hxs, kQ[1], kQ[0]);
  const double h2 = hxs * hxs;
  const double R2 = std::fma(hxs, kQ[3], kQ[2]);
  const double h4 = h2 * h2;
  const double R3 = std::fma(hxs, kQ[5], kQ[4]);
  const double r1 = std::fma(h4, R3, std::fma(h2, R2, R1));  // R1 + h2 * R2 + h4 * R3
  t = std::fma(-hfx, r1, 3.0);                               // 3.0 - r1 * hfx
  e = hxs * ((r1 - t) / std::fma(-t, x, 6.0));               // 6.0 - x * t
  if (k == 0) return x - std::fma(x, e, -hxs);               // x - (x * e - hxs)
  e = std::fma(e - c, x, -c);                                // x * (e - c) - c
  e -= hxs;
  if (k == -1) return std::fma(x - e, 0.5, -0.5);  // 0.5 * (x - e) - 0.5
  if (k == 1) {
    if (x < -0.25) return -2.0 * (e - (x + 0.5));
    return std::fma(x - e, 2.0, kQ[0]);  // one + 2.0 * (x - e)
  }
  if (k <= -2 || k > 56) {  // suffice to return exp(x)-1
    y = kQ[0] - (e - x);
    setHighWord(y, static_cast<std::uint32_t>(highWord(y)) + (static_cast<std::uint32_t>(k) << 20));
    return y - kQ[0];
  }
  t = kQ[0];
  if (k < 20) {
    setHighWord(t, 0x3ff00000 - (0x200000u >> k));  // t = 1 - 2^-k
    y = t - (e - x);
    setHighWord(y, static_cast<std::uint32_t>(highWord(y)) + (static_cast<std::uint32_t>(k) << 20));
  } else {
    setHighWord(t, static_cast<std::uint32_t>((0x3ff - k) << 20));  // 2^-k
    y = x - (e + t);
    y += kQ[0];
    setHighWord(y, static_cast<std::uint32_t>(highWord(y)) + (static_cast<std::uint32_t>(k) << 20));
  }
  return y;
}

}  // namespace

double tanh(double x) {
  constexpr double one = 1.0, two = 2.0, tiny = 1.0e-300;
  double t, z;
  const std::int32_t jx = highWord(x);
  const std::int32_t ix = jx & 0x7fffffff;
  const std::uint32_t lx = lowWord(x);

  if (ix >= 0x7ff00000) {  // x is INF or NaN
    if (jx >= 0) return one / x + one;  // tanh(+-inf) = +-1
    return one / x - one;               // tanh(NaN) = NaN
  }
  if (ix < 0x40360000) {  // |x| < 22
    if ((static_cast<std::uint32_t>(ix) | lx) == 0) return x;  // x == +-0
    if (ix < 0x3c800000) return x * (one + x);                 // |x| < 2**-55
    if (ix >= 0x3ff00000) {                                    // |x| >= 1
      t = glibcExpm1(two * std::fabs(x));
      z = one - two / (t + two);
    } else {
      t = glibcExpm1(-two * std::fabs(x));
      z = -t / (t + two);
    }
  } else {
    z = one - tiny;  // |x| >= 22, return +-1
  }
  return (jx >= 0) ? z : -z;
}

}  // namespace rig::js
