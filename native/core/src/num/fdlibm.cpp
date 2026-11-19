// rig::fdlibm: Chromium's third_party/fdlibm (157.0.8103.78), i.e. the fdlibm port of V8 12.4's
// src/base/ieee754.cc. Blink's Web Audio C++ calls it as `fdlibm::exp/pow/...` (AudioParam exponential ramps,
// setTarget, DiscreteTimeConstantForSampleRate). Its function bodies are identical to the vendored
// third_party/v8_ieee754/ieee754.cc (checked by diff against Chromium's copy; only `base::Divide` vs `Divide` and
// the V8_USE_LIBM_TRIG_FUNCTIONS guards differ, and Chromium leaves that macro undefined), so this TU compiles the
// vendored file (via fdlibm_v8.inc: the same text minus its V8 header includes) with the few V8 helpers it needs.
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <type_traits>

#include "num/js_math.h"

// ---- the V8 helpers ieee754.cc uses (src/base/{build_config,macros,overflowing-math}.h) ------------------------------
#define V8_CC_MSVC 0
#define V8_INLINE inline __attribute__((always_inline))
#define V8_WARN_UNUSED_RESULT __attribute__((warn_unused_result))

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
namespace ieee754 {
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
#include "num/fdlibm_v8.inc"
#if defined(__clang__)
#pragma clang diagnostic pop
#elif defined(__GNUC__)
#pragma GCC diagnostic pop
#endif

namespace rig::fdlibm {
namespace I = v8::base::ieee754;
double sin(double x) { return I::sin(x); }
double cos(double x) { return I::cos(x); }
double tan(double x) { return I::tan(x); }
double exp(double x) { return I::exp(x); }
double log(double x) { return I::log(x); }
double log2(double x) { return I::log2(x); }
double log10(double x) { return I::log10(x); }
double log1p(double x) { return I::log1p(x); }
double expm1(double x) { return I::expm1(x); }
double cbrt(double x) { return I::cbrt(x); }
double atan(double x) { return I::atan(x); }
double atan2(double y, double x) { return I::atan2(y, x); }
double pow(double x, double y) { return I::pow(x, y); }
double tanh(double x) { return I::tanh(x); }
double sinh(double x) { return I::sinh(x); }
double cosh(double x) { return I::cosh(x); }
double asin(double x) { return I::asin(x); }
double acos(double x) { return I::acos(x); }
}  // namespace rig::fdlibm
