// JS Math.* backed by the vendored LLVM libc subset (src/num/llvm_libc, Apache-2.0 WITH LLVM-exception): the same
// correctly rounded implementations V8 15.7's src/base/ieee754.cc forwards to. Also Math.sinh/cosh (V8 15.7 code,
// BSD-3 + Sun fdlibm notice, see below), sqrt, round, fround.
//
// Build: this file needs `src/num/llvm_libc` as a SYSTEM include directory (-isystem) so the vendored headers are
// not compiled with our -Werror warning set; see src/num/num.cmake.
#include "num/js_math.h"

#include <cmath>
#include <cstdint>
#include <cstring>

#include "shared/math/atan.h"
#include "shared/math/atan2.h"
#include "shared/math/cbrt.h"
#include "shared/math/cos.h"
#include "shared/math/exp.h"
#include "shared/math/expm1.h"
#include "shared/math/log.h"
#include "shared/math/log10.h"
#include "shared/math/log2.h"
#include "shared/math/sin.h"
#include "shared/math/tan.h"

namespace rig::js {

namespace L = LIBC_NAMESPACE::shared;

double sin(double x) { return L::sin(x); }
double cos(double x) { return L::cos(x); }
double tan(double x) { return L::tan(x); }
double exp(double x) { return L::exp(x); }
double log(double x) { return L::log(x); }
double log2(double x) { return L::log2(x); }
double log10(double x) { return L::log10(x); }
double expm1(double x) { return L::expm1(x); }
double cbrt(double x) { return L::cbrt(x); }
double atan(double x) { return L::atan(x); }
double atan2(double y, double x) { return L::atan2(y, x); }

double sqrt(double x) { return std::sqrt(x); }

double round(double x) {
  // V8: Float64RoundUp(x), minus one when that overshoots by more than one half. Keeps -0 and NaN; exact for every
  // double (x + 0.5 would round for 0.49999999999999994 and for odd integers above 2^52).
  double r = std::ceil(x);
  if (r - 0.5 > x) r -= 1.0;
  return r;
}

double fround(double x) { return static_cast<double>(static_cast<float>(x)); }

// ---- Math.sinh / Math.cosh: v8/src/base/ieee754.cc at 15.7-lkgr, verbatim apart from the calls to L::* --------------
// ====================================================
// Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//
// Developed at SunSoft, a Sun Microsystems, Inc. business.
// Permission to use, copy, modify, and distribute this
// software is freely granted, provided that this notice
// is preserved.
// ====================================================
// The original source code covered by the above license above has been modified significantly by Google Inc.
// Copyright 2016 the V8 project authors. All rights reserved. (BSD-3, native/core/third_party/v8_ieee754/LICENSE)

double sinh(double x) {
  static const double KSINH_OVERFLOW = 710.4758600739439, TWO_M28 = 3.725290298461914e-9,  // 2^-28
      LOG_MAXD = 709.7822265625;  // 0x40862E42 00000000, empty lower half
  static const double shuge = 1.0e307;

  double h = (x < 0) ? -0.5 : 0.5;
  // |x| in [0, 22]. return sign(x)*0.5*(E+E/(E+1))
  double ax = std::fabs(x);
  if (ax < 22) {
    // For |x| < 2^-28, sinh(x) = x
    if (ax < TWO_M28) return x;
    double t = L::expm1(ax);
    if (ax < 1) {
      return h * (2 * t - t * t / (t + 1));
    }
    return h * (t + t / (t + 1));
  }
  // |x| in [22, log(maxdouble)], return 0.5 * exp(|x|)
  if (ax < LOG_MAXD) return h * L::exp(ax);
  // |x| in [log(maxdouble), overflowthreshold]
  if (ax <= KSINH_OVERFLOW) {
    double w = L::exp(0.5 * ax);
    double t = h * w;
    return t * w;
  }
  // |x| > overflowthreshold or is NaN.
  return x * shuge;
}

double cosh(double x) {
  static const double KCOSH_OVERFLOW = 710.4758600739439;
  static const double one = 1.0, half = 0.5;
  static volatile double huge = 1.0e+300;

  const double ax = std::fabs(x);
  std::uint64_t bits;
  std::memcpy(&bits, &ax, sizeof bits);
  const std::uint32_t ix = static_cast<std::uint32_t>(bits >> 32);  // GET_HIGH_WORD(ix, x); ix &= 0x7FFFFFFF

  // |x| in [0,0.5*log2], return 1+expm1(|x|)^2/(2*exp(|x|))
  if (ix < 0x3FD62E43) {
    double t = L::expm1(ax);
    double w = one + t;
    // For |x| < 2^-55, cosh(x) = 1
    if (ix < 0x3C800000) return w;
    return one + (t * t) / (w + w);
  }
  // |x| in [0.5*log2, 22], return (exp(|x|)+1/exp(|x|)/2
  if (ix < 0x40360000) {
    double t = L::exp(ax);
    return half * t + half / t;
  }
  // |x| in [22, log(maxdouble)], return half*exp(|x|)
  if (ix < 0x40862E42) return half * L::exp(ax);
  // |x| in [log(maxdouble), overflowthreshold]
  if (ax <= KCOSH_OVERFLOW) {
    double w = L::exp(half * ax);
    double t = half * w;
    return t * w;
  }
  /* x is INF or NaN */
  if (ix >= 0x7FF00000) return x * x;
  // |x| > overflowthreshold.
  return huge * huge;
}

}  // namespace rig::js
