// rig::fdlibm: Chromium's third_party/fdlibm (157.0.8103.78), i.e. the fdlibm port of V8 12.4's
// src/base/ieee754.cc. Blink's Web Audio C++ calls it as `fdlibm::exp/pow/...` (AudioParam exponential ramps,
// setTarget, DiscreteTimeConstantForSampleRate). Its function bodies are identical to the vendored
// third_party/v8_ieee754/ieee754.cc (checked by diff against Chromium's copy: only `base::Divide` vs `Divide` and
// the V8_USE_LIBM_TRIG_FUNCTIONS guards differ, and Chromium leaves that macro undefined). See fdlibm_embed.h.
#include "num/fdlibm_embed.h"
#include "num/js_math.h"

namespace rig::fdlibm {
namespace I = rig::fdlibm_internal::v8::base::ieee754;
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
