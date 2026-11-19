// Chromium's third_party/fdlibm (= V8 12.4 src/base/ieee754.cc, vendored as third_party/v8_ieee754/ieee754.cc and
// mirrored minus its V8 includes in fdlibm_v8.inc) compiled into the including translation unit with internal
// linkage: rig::fdlibm_internal::v8::base::ieee754::{exp, pow, ...}. A TU that includes this needs no other object
// file (param.cpp uses it so rig_core links without rig_time_num); unused functions are dropped by the compiler.
// Everyone else calls the external rig::fdlibm::* (js_math.h, fdlibm.cpp), which wraps this same code.
#pragma once
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <type_traits>

#define V8_CC_MSVC 0
#define V8_INLINE inline __attribute__((always_inline))
#define V8_WARN_UNUSED_RESULT __attribute__((warn_unused_result))

#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Weverything"
#elif defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wconversion"
#pragma GCC diagnostic ignored "-Wsign-conversion"
#pragma GCC diagnostic ignored "-Wshadow"
#pragma GCC diagnostic ignored "-Wpedantic"
#pragma GCC diagnostic ignored "-Wunused-variable"
#pragma GCC diagnostic ignored "-Wunused-but-set-variable"
#pragma GCC diagnostic ignored "-Wunused-function"
#pragma GCC diagnostic ignored "-Wmaybe-uninitialized"
#pragma GCC diagnostic ignored "-Wimplicit-fallthrough"
#pragma GCC diagnostic ignored "-Wfloat-conversion"
#pragma GCC diagnostic ignored "-Wsign-compare"
#pragma GCC diagnostic ignored "-Wparentheses"
#pragma GCC diagnostic ignored "-Wmisleading-indentation"
#endif

namespace rig::fdlibm_internal {
namespace {

// ---- the V8 helpers ieee754.cc uses (src/base/{macros,overflowing-math}.h) -----------------------------------------
namespace v8::base {
template <class D, class S>
inline D bit_cast(const S &s) {
  static_assert(sizeof(D) == sizeof(S));
  D d;
  std::memcpy(&d, &s, sizeof d);
  return d;
}
template <class T>
inline T NegateWithWraparound(T a) {
  using U = std::make_unsigned_t<T>;
  return static_cast<T>(U(0) - static_cast<U>(a));
}
template <class T>
inline T SubWithWraparound(T a, T b) {
  using U = std::make_unsigned_t<T>;
  return static_cast<T>(static_cast<U>(a) - static_cast<U>(b));
}
template <class T>
inline T Divide(T x, T y) {
  return x / y;  // IEEE division (V8: "divide, also by zero, without UB")
}
namespace ieee754 {  // src/base/ieee754.h
double acos(double);
double acosh(double);
double asin(double);
double asinh(double);
double atan(double);
double atan2(double, double);
double cos(double);
double sin(double);
double exp(double);
double atanh(double);
double log(double);
double log1p(double);
double log2(double);
double log10(double);
double cbrt(double);
double expm1(double);
double tan(double);
double cosh(double);
double sinh(double);
double tanh(double);
double pow(double, double);
}  // namespace ieee754
}  // namespace v8::base

#include "num/fdlibm_v8.inc"

}  // namespace
}  // namespace rig::fdlibm_internal

#if defined(__clang__)
#pragma clang diagnostic pop
#elif defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

#undef V8_CC_MSVC
#undef V8_INLINE
#undef V8_WARN_UNUSED_RESULT
