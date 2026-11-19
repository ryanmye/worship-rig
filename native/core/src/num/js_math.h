// Bit-exact math for parity with the golden renders (Chromium 157.0.8103.78 = V8 15.7, x86-64 Linux, glibc 2.39).
//
// Two different libraries stand behind "Math" in that Chromium (T01, SETUP_REVIEW finding 14, measured with
// tools/golden/vectors/dump-math.mjs; decision table in native/core/src/num/README.md):
//
//   rig::js::*      JavaScript Math.* as V8 15.7 computes it. sin cos tan exp log log2 log10 expm1 cbrt atan atan2
//                   come from LLVM libc (correctly rounded; V8 forwards to `LIBC_NAMESPACE::shared::*`), vendored in
//                   src/num/llvm_libc. Math.pow is `std::pow` (V8 flag use_std_math_pow, default true) = glibc's
//                   __pow_fma on an FMA CPU, ported in js_pow.cpp; Math.tanh is `std::tanh` = glibc __tanh_fma, ported
//                   in js_tanh.cpp; Math.sinh/cosh are V8's own code over the LLVM expm1/exp. Use these for anything
//                   the JS engine computes in JavaScript (IR generator, curve tables, dB conversions, seeds).
//   rig::fdlibm::*  Chromium's `third_party/fdlibm` (a fork of V8 12.4's ieee754.cc, identical function bodies to the
//                   vendored third_party/v8_ieee754/ieee754.cc). Blink's C++ calls these inside Web Audio kernels:
//                   AudioParam exponential ramps (fdlibm::pow), setTarget (fdlibm::exp), discrete time constants.
//                   Use them when porting Blink C++ that calls `fdlibm::`.
//
// All functions are pure, thread-safe, allocation-free and RT-safe.
#pragma once

namespace rig::js {

double sin(double x);
double cos(double x);
double tan(double x);
double exp(double x);
double log(double x);
double log2(double x);
double log10(double x);
double expm1(double x);
double cbrt(double x);
double atan(double x);
double atan2(double y, double x);
/** Math.pow: V8's special cases (NaN exponent, ±1 ** ±Infinity = NaN, y == 2 → x*x, y == 0.5 → sqrt(x + 0)),
 *  then glibc 2.39 __pow_fma (ported). */
double pow(double x, double y);
/** Math.tanh = glibc 2.39 __tanh_fma (fdlibm tanh over glibc's FMA build of fdlibm expm1). */
double tanh(double x);
/** Math.sinh / Math.cosh: V8 15.7 ieee754.cc over the LLVM expm1/exp. */
double sinh(double x);
double cosh(double x);
/** Math.sqrt: IEEE-754 square root (exact everywhere). */
double sqrt(double x);
/** Math.round: round half toward +Infinity, keeps -0 (Math.round(-0.4) = -0). */
double round(double x);
/** Math.fround. */
double fround(double x);
/** Math.floor / Math.ceil / Math.abs / Math.trunc are exact; use <cmath>. */

/** Math.PI, Math.LN2, Math.SQRT1_2 (the JS constants are the nearest doubles). */
inline constexpr double kPi = 3.141592653589793;
inline constexpr double kLn2 = 0.6931471805599453;
inline constexpr double kSqrt1_2 = 0.7071067811865476;

}  // namespace rig::js

namespace rig::fdlibm {

double sin(double x);
double cos(double x);
double tan(double x);
double exp(double x);
double log(double x);
double log2(double x);
double log10(double x);
double log1p(double x);
double expm1(double x);
double cbrt(double x);
double atan(double x);
double atan2(double y, double x);
double pow(double x, double y);
double tanh(double x);
double sinh(double x);
double cosh(double x);
double asin(double x);
double acos(double x);

}  // namespace rig::fdlibm
