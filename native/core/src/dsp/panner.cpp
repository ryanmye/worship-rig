// Port of Chromium 157.0.8103.78 third_party/blink/renderer/platform/audio/stereo_panner.cc and
// third_party/blink/renderer/modules/webaudio/stereo_panner_handler.cc.
// Copyright 2014 The Chromium Authors. BSD-3 (third_party/chromium/LICENSE): Redistribution and use in source and
// binary forms, with or without modification, are permitted provided that the following conditions are met:
// 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the
// following disclaimer. 2. Redistributions in binary form must reproduce the above copyright notice, this list of
// conditions and the following disclaimer in the documentation and/or other materials provided with the
// distribution. 3. Neither the name of Google LLC nor the names of its contributors may be used to endorse or
// promote products derived from this software without specific prior written permission. THIS SOFTWARE IS PROVIDED
// BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES ARE DISCLAIMED (full text:
// third_party/chromium/LICENSE).
#include "dsp/panner.h"

#include <algorithm>

#include "num/js_math.h"

namespace rig::wa {
namespace {
constexpr double kPiOverTwoDouble = 1.5707963267948966;  // std::numbers::pi / 2
}

void StereoPanner::panSampleAccurate(float inL, float inR, unsigned nch, float panValue, float &outL, float &outR) {
  const double pan = std::clamp(static_cast<double>(panValue), -1.0, 1.0);
  if (nch == 1) {
    const double r = (pan * 0.5 + 0.5) * kPiOverTwoDouble;
    const double gl = fdlibm::cos(r), gr = fdlibm::sin(r);
    outL = static_cast<float>(inL * gl);
    outR = static_cast<float>(inL * gr);
    return;
  }
  const double r = (pan <= 0 ? pan + 1 : pan) * kPiOverTwoDouble;
  const double gl = fdlibm::cos(r), gr = fdlibm::sin(r);
  if (pan <= 0) {
    outL = static_cast<float>(inL + inR * gl);
    outR = static_cast<float>(inR * gr);
  } else {
    outL = static_cast<float>(inL * gl);
    outR = static_cast<float>(inR + inL * gr);
  }
}

void StereoPanner::advance(std::size_t n, std::int64_t frame0, double sr) {
  if (pan_.hasSampleAccurateValues(frame0, sr)) {
    float pv[Param::kQuantum];
    pan_.processARate(frame0, sr, pv, n);
  } else {
    pan_.processKRate(frame0, sr);
  }
}

void StereoPanner::process(const float *const *in, unsigned nch, float *outL, float *outR, std::size_t n,
                           std::int64_t frame0, double sr) {
  nch = nch >= 2 ? 2u : 1u;
  const float *sl = in[0];
  const float *sr2 = nch > 1 ? in[1] : in[0];
  if (pan_.hasSampleAccurateValues(frame0, sr)) {  // PanWithSampleAccurateValues
    float pv[Param::kQuantum];
    pan_.processARate(frame0, sr, pv, n);
    for (std::size_t i = 0; i < n; ++i) {
      const float l = sl[i], r = sr2[i];
      panSampleAccurate(l, r, nch, pv[i], outL[i], outR[i]);
    }
    return;
  }
  // PanToTargetValue (pan_->Value(): the timeline value at this quantum, i.e. FinalValue without events running)
  const float target = std::clamp(pan_.processKRate(frame0, sr), -1.0f, 1.0f);
  if (nch == 1) {
    const double r = (target * 0.5 + 0.5) * kPiOverTwoDouble;
    const float gl = static_cast<float>(fdlibm::cos(r)), gr = static_cast<float>(fdlibm::sin(r));
    for (std::size_t i = 0; i < n; ++i) {  // destination_r first (in-place safe)
      const float x = sl[i];
      outR[i] = x * gr;
      outL[i] = x * gl;
    }
    return;
  }
  const double r = (target <= 0 ? target + 1 : target) * kPiOverTwoDouble;
  const float gl = static_cast<float>(fdlibm::cos(r)), gr = static_cast<float>(fdlibm::sin(r));
  if (target <= 0) {
    for (std::size_t i = 0; i < n; ++i) {
      const float l = sl[i], rr = sr2[i];
      const float prod = rr * gl;
      outL[i] = l + prod;  // copy, then Vsma: dest += src * scale (float multiply, then float add)
      outR[i] = rr * gr;
    }
  } else {
    for (std::size_t i = 0; i < n; ++i) {
      const float l = sl[i], rr = sr2[i];
      const float prod = l * gr;
      outR[i] = rr + prod;
      outL[i] = l * gl;
    }
  }
}

}  // namespace rig::wa
