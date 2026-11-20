// Port of Chromium 157.0.8103.78 third_party/blink/renderer/platform/audio/dynamics_compressor.cc
// Copyright (C) 2011 Google Inc. All rights reserved. BSD-3 (third_party/chromium/LICENSE):
// Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
// following conditions are met: 1. Redistributions of source code must retain the above copyright notice, this list
// of conditions and the following disclaimer. 2. Redistributions in binary form must reproduce the above copyright
// notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided
// with the distribution. 3. Neither the name of Apple Computer, Inc. ("Apple") nor the names of its contributors may
// be used to endorse or promote products derived from this software without specific prior written permission.
// THIS SOFTWARE IS PROVIDED BY APPLE AND ITS CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES ARE
// DISCLAIMED (full text: third_party/chromium/LICENSE).
//
// Line-by-line port of DynamicsCompressor::Process and the static-curve helpers; float arithmetic as in the source
// (the build uses -ffp-contract=off, so no FMA contraction). See compressor.h for the math library mapping.
#include "dsp/compressor.h"

#include <algorithm>
#include <cfloat>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>

#include "num/js_math.h"

namespace rig::wa {
namespace {

constexpr float kPiOverTwoFloat = static_cast<float>(1.57079632679489661923);  // wtf/math_extras.h
constexpr float kPreDelay = 0.006f;                                            // seconds

constexpr float kReleaseZone1 = 0.09f;
constexpr float kReleaseZone2 = 0.16f;
constexpr float kReleaseZone3 = 0.42f;
constexpr float kReleaseZone4 = 0.98f;

constexpr float kABase = 0.9999999999999998f * kReleaseZone1 + 1.8432219684323923e-16f * kReleaseZone2 -
                         1.9373394351676423e-16f * kReleaseZone3 + 8.824516011816245e-18f * kReleaseZone4;
constexpr float kBBase = -1.5788320352845888f * kReleaseZone1 + 2.3305837032074286f * kReleaseZone2 -
                         0.9141194204840429f * kReleaseZone3 + 0.1623677525612032f * kReleaseZone4;
constexpr float kCBase = 0.5334142869106424f * kReleaseZone1 - 1.272736789213631f * kReleaseZone2 +
                         0.9258856042207512f * kReleaseZone3 - 0.18656310191776226f * kReleaseZone4;
constexpr float kDBase = 0.08783463138207234f * kReleaseZone1 - 0.1694162967925622f * kReleaseZone2 +
                         0.08588057951595272f * kReleaseZone3 - 0.00429891410546283f * kReleaseZone4;
constexpr float kEBase = -0.042416883008123074f * kReleaseZone1 + 0.1115693827987602f * kReleaseZone2 -
                         0.09764676325265872f * kReleaseZone3 + 0.028494263462021576f * kReleaseZone4;

constexpr float kSatReleaseTime = 0.0025f;  // detector release time

float ensureFinite(float x, float defaultValue) {
  return std::isfinite(x) ? x : defaultValue;
}
float flushDenormal(float x) {  // DenormalDisabler::FlushDenormalFloatToZero
  return std::fabs(x) < FLT_MIN ? 0.0f : x;
}
// ---- glibc 2.39 log10f (what audio_utilities::LinearToDecibels calls on the golden machine) ------------------------
// log10f: sysdeps/ieee754/flt-32/e_log10f.c, Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//   Developed at SunPro, a Sun Microsystems, Inc. business. Permission to use, copy, modify, and distribute this
//   software is freely granted, provided that this notice is preserved.
// logf (called by it): sysdeps/ieee754/flt-32/e_logf.c = Arm optimized-routines math/logf.c, Copyright (c) 2017-2018
//   Arm Limited, SPDX-License-Identifier: MIT (src/num/LICENSE.arm-optimized-routines).
// Verified bit-identical to this box's glibc (x86-64, FMA ifunc variant of logf) on 7.1e8 positive floats (every
// third bit pattern), with or without FMA in logf; a correctly rounded log10 differs, and its last-ulp differences
// flip comparisons in KAtSlope (1e-5 output differences on the glue vectors).
struct LogfEntry {
  double invc, logc;
};
constexpr LogfEntry kLogfTab[16] = {
    {0x1.661ec79f8f3bep+0, -0x1.57bf7808caadep-2}, {0x1.571ed4aaf883dp+0, -0x1.2bef0a7c06ddbp-2},
    {0x1.49539f0f010bp+0, -0x1.01eae7f513a67p-2},  {0x1.3c995b0b80385p+0, -0x1.b31d8a68224e9p-3},
    {0x1.30d190c8864a5p+0, -0x1.6574f0ac07758p-3}, {0x1.25e227b0b8eap+0, -0x1.1aa2bc79c81p-3},
    {0x1.1bb4a4a1a343fp+0, -0x1.a4e76ce8c0e5ep-4}, {0x1.12358f08ae5bap+0, -0x1.1973c5a611cccp-4},
    {0x1.0953f419900a7p+0, -0x1.252f438e10c1ep-5}, {0x1p+0, 0x0p+0},
    {0x1.e608cfd9a47acp-1, 0x1.aa5aa5df25984p-5},  {0x1.ca4b31f026aap-1, 0x1.c5e53aa362eb4p-4},
    {0x1.b2036576afce6p-1, 0x1.526e57720db08p-3},  {0x1.9c2d163a1aa2dp-1, 0x1.bc2860d22477p-3},
    {0x1.886e6037841edp-1, 0x1.1058bc8a07ee1p-2},  {0x1.767dcf5534862p-1, 0x1.4043057b6ee09p-2},
};
constexpr double kLogfLn2 = 0x1.62e42fefa39efp-1;
constexpr double kLogfA[3] = {-0x1.00ea348b88334p-2, 0x1.5575b0be00b6ap-2, -0x1.ffffef20a4123p-2};

std::uint32_t asuint(float f) {
  std::uint32_t u;
  std::memcpy(&u, &f, 4);
  return u;
}
float asfloat(std::uint32_t u) {
  float f;
  std::memcpy(&f, &u, 4);
  return f;
}

float glibcLogf(float x) {
  std::uint32_t ix = asuint(x);
  if (ix == 0x3f800000u) return 0;
  if (ix - 0x00800000u >= 0x7f800000u - 0x00800000u) {
    if (ix * 2 == 0) return -HUGE_VALF;
    if (ix == 0x7f800000u) return x;
    if ((ix & 0x80000000u) || ix * 2 >= 0xff000000u) return std::numeric_limits<float>::quiet_NaN();
    ix = asuint(x * 0x1p23f);  // subnormal: normalise
    ix -= 23u << 23;
  }
  const std::uint32_t tmp = ix - 0x3f330000u;
  const std::uint32_t i = (tmp >> (23 - 4)) % 16;
  const int k = static_cast<std::int32_t>(tmp) >> 23;
  const std::uint32_t iz = ix - (tmp & 0x1ffu << 23);
  const double invc = kLogfTab[i].invc, logc = kLogfTab[i].logc;
  const double z = static_cast<double>(asfloat(iz));
  const double r = z * invc - 1;
  const double y0 = logc + static_cast<double>(k) * kLogfLn2;
  const double r2 = r * r;
  double y = kLogfA[1] * r + kLogfA[2];
  y = kLogfA[0] * r2 + y;
  y = y * r2 + (y0 + r);
  return static_cast<float>(y);
}

float glibcLog10f(float x) {
  constexpr float two25 = 3.3554432000e+07f, ivln10 = 4.3429449201e-01f, log10_2hi = 3.0102920532e-01f,
                  log10_2lo = 7.9034151668e-07f;
  std::int32_t hx;
  std::memcpy(&hx, &x, 4);
  std::int32_t k = 0;
  if (hx < 0x00800000) {
    if ((hx & 0x7fffffff) == 0) return -two25 / std::fabs(x);  // log(+-0) = -inf
    if (hx < 0) return std::numeric_limits<float>::quiet_NaN();
    k -= 25;
    x *= two25;  // subnormal: scale up
    std::memcpy(&hx, &x, 4);
  }
  if (hx >= 0x7f800000) return x + x;
  k += (hx >> 23) - 127;
  const auto i = static_cast<std::int32_t>((static_cast<std::uint32_t>(k) & 0x80000000u) >> 31);
  hx = (hx & 0x007fffff) | ((0x7f - i) << 23);
  const auto y = static_cast<float>(k + i);
  std::memcpy(&x, &hx, 4);
  const float z = y * log10_2lo + ivln10 * glibcLogf(x);
  return z + y * log10_2hi;
}

// audio_utilities::DecibelsToLinear / LinearToDecibels: powf(10, .05 dB) and 20 log10f(x). powf is the correctly
// rounded pow rounded to float (glibc's powf differs in the last bit for ~6.5e-5 of the inputs: rate-level noise,
// bit-identical on every vector case); log10f is the glibc port above.
float decibelsToLinear(float db) {
  return static_cast<float>(rig::js::pow(10.0, static_cast<double>(0.05f * db)));
}
float linearToDecibels(float linear) {
  return 20.0f * glibcLog10f(linear);
}
// fdlibm::powf / fdlibm::asinf (third_party/fdlibm/ieee754.cc: the double functions rounded to float).
float fdlibmPowf(float x, float y) {
  return static_cast<float>(rig::fdlibm::pow(static_cast<double>(x), static_cast<double>(y)));
}
float fdlibmAsinf(double x) {
  return static_cast<float>(rig::fdlibm::asin(x));
}

}  // namespace

DynamicsCompressor::DynamicsCompressor(double sampleRate) : sampleRate_(static_cast<float>(sampleRate)) {
  reset();
}

void DynamicsCompressor::setSampleRate(double sampleRate) {
  sampleRate_ = static_cast<float>(sampleRate);
  lastPreDelayFrames_ = 256;  // kDefaultPreDelayFrames: as a freshly constructed kernel
  reset();
}

void DynamicsCompressor::reset() {
  detectorAverage_ = 0;
  compressorGain_ = 1;
  std::memset(preDelay_, 0, sizeof preDelay_);
  preDelayRead_ = 0;
  preDelayWrite_ = 256;  // kDefaultPreDelayFrames
  dbMaxAttackCompressionDiff_ = -1;
}

void DynamicsCompressor::setPreDelayTime(float seconds) {
  auto frames = static_cast<unsigned>(seconds * sampleRate_);
  if (frames > kMaxPreDelayFrames - 1) frames = kMaxPreDelayFrames - 1;
  if (lastPreDelayFrames_ != frames) {
    lastPreDelayFrames_ = frames;
    std::memset(preDelay_, 0, sizeof preDelay_);
    preDelayRead_ = 0;
    preDelayWrite_ = static_cast<int>(frames);
  }
}

float DynamicsCompressor::kneeCurve(float x, float k) const {
  if (x < linearThreshold_) return x;  // linear up to threshold
  return linearThreshold_ +
         (1 - static_cast<float>(rig::js::exp(static_cast<double>(-k * (x - linearThreshold_))))) / k;
}

float DynamicsCompressor::saturate(float x, float k) const {
  if (x < kneeThreshold_) return kneeCurve(x, k);
  const float dbX = linearToDecibels(x);  // constant ratio after the knee
  const float dbY = dbYKneeThreshold_ + slope_ * (dbX - dbKneeThreshold_);
  return decibelsToLinear(dbY);
}

float DynamicsCompressor::kAtSlope(float desiredSlope) const {
  const float dbX = dbThreshold_ + dbKnee_;
  const float x = decibelsToLinear(dbX);
  float x2 = 1;
  float dbX2 = 0;
  if (!(x < linearThreshold_)) {
    x2 = static_cast<float>(static_cast<double>(x) * 1.001);
    dbX2 = linearToDecibels(x2);
  }
  float minK = 0.1f;
  float maxK = 10000;
  float k = 5;
  float slope = 1;
  for (int i = 0; i < 15; ++i) {
    if (!(x < linearThreshold_)) {
      const float dbY = linearToDecibels(kneeCurve(x, k));
      const float dbY2 = linearToDecibels(kneeCurve(x2, k));
      slope = (dbY2 - dbY) / (dbX2 - dbX);
    }
    if (slope < desiredSlope)
      maxK = k;  // k is too high
    else
      minK = k;  // k is too low
    k = std::sqrt(minK * maxK);
  }
  return k;
}

float DynamicsCompressor::updateStaticCurveParameters(float dbThreshold, float dbKnee, float ratio) {
  if (dbThreshold != dbThreshold_ || dbKnee != dbKnee_ || ratio != ratio_) {
    dbThreshold_ = dbThreshold;
    linearThreshold_ = decibelsToLinear(dbThreshold);
    dbKnee_ = dbKnee;
    ratio_ = ratio;
    slope_ = 1 / ratio_;
    const float k = kAtSlope(1 / ratio_);
    dbKneeThreshold_ = dbThreshold + dbKnee;
    kneeThreshold_ = decibelsToLinear(dbKneeThreshold_);
    dbYKneeThreshold_ = linearToDecibels(kneeCurve(kneeThreshold_, k));
    knee_ = k;
  }
  return knee_;
}

void DynamicsCompressor::process(const float *const *src, unsigned srcChannels, float *const *dst, std::size_t n) {
  const float dbThreshold = params_.threshold;
  const float dbKnee = params_.knee;
  const float ratio = params_.ratio;
  const float attackTime = params_.attack;
  const float releaseTime = params_.release;
  const float sampleRate = sampleRate_;

  const float k = updateStaticCurveParameters(dbThreshold, dbKnee, ratio);
  const float linearPostGain = fdlibmPowf(1 / saturate(1, k), 0.6f);  // makeup gain
  const float attackFrames = std::max(0.001f, attackTime) * sampleRate;
  const float releaseFrames = sampleRate * releaseTime;
  const float satReleaseFrames = kSatReleaseTime * sampleRate;

  const float a = releaseFrames * kABase;
  const float b = releaseFrames * kBBase;
  const float c = releaseFrames * kCBase;
  const float d = releaseFrames * kDBase;
  const float e = releaseFrames * kEBase;

  setPreDelayTime(kPreDelay);
  constexpr unsigned kDivisionFrames = 32;
  constexpr int kMask = static_cast<int>(kMaxPreDelayFrames) - 1;

  // Inputs and outputs may alias: keep this division's input frames before writing.
  const float *in0 = src[0];
  const float *in1 = srcChannels > 1 ? src[1] : src[0];

  std::size_t frameIndex = 0;
  while (frameIndex < n) {
    detectorAverage_ = ensureFinite(detectorAverage_, 1);
    const float desiredGain = detectorAverage_;
    const float scaledDesiredGain = fdlibmAsinf(static_cast<double>(desiredGain)) / kPiOverTwoFloat;

    float envelopeRate = 0.0f;
    const bool isReleasing = scaledDesiredGain > compressorGain_;
    float dbCompressionDiff = 0.0f;
    if (scaledDesiredGain == 0)
      dbCompressionDiff = isReleasing ? -1.0f : 1.0f;
    else
      dbCompressionDiff = linearToDecibels(compressorGain_ / scaledDesiredGain);

    if (isReleasing) {
      dbMaxAttackCompressionDiff_ = -1;
      dbCompressionDiff = ensureFinite(dbCompressionDiff, -1);
      float x = dbCompressionDiff;
      x = std::clamp(x, -12.0f, 0.0f);
      x = 0.25f * (x + 12);
      const float x2 = x * x;
      const float x3 = x2 * x;
      const float x4 = x2 * x2;
      const float calcReleaseFrames = a + b * x + c * x2 + d * x3 + e * x4;
      constexpr float kDbSpacing = 5;
      const float dbPerFrame = kDbSpacing / calcReleaseFrames;
      envelopeRate = decibelsToLinear(dbPerFrame);
    } else {
      dbCompressionDiff = ensureFinite(dbCompressionDiff, 1);
      if (dbMaxAttackCompressionDiff_ == -1 || dbMaxAttackCompressionDiff_ < dbCompressionDiff)
        dbMaxAttackCompressionDiff_ = dbCompressionDiff;
      const float dbEffAttenDiff = std::max(0.5f, dbMaxAttackCompressionDiff_);
      const float x = 0.25f / dbEffAttenDiff;
      envelopeRate = 1 - fdlibmPowf(x, 1 / attackFrames);
    }

    int readIndex = preDelayRead_;
    int writeIndex = preDelayWrite_;
    float detectorAverage = detectorAverage_;
    float compressorGain = compressorGain_;

    const std::size_t loopFrames = std::min<std::size_t>(kDivisionFrames, n - frameIndex);
    for (std::size_t div = 0; div < loopFrames; ++div) {
      const float u0 = in0[frameIndex], u1 = in1[frameIndex];
      preDelay_[0][writeIndex] = u0;
      preDelay_[1][writeIndex] = u1;
      float compressorInput = 0;
      const float a0 = u0 > 0 ? u0 : -u0;
      if (compressorInput < a0) compressorInput = a0;
      const float a1 = u1 > 0 ? u1 : -u1;
      if (compressorInput < a1) compressorInput = a1;

      const float scaledInput = compressorInput;
      const float absInput = scaledInput > 0 ? scaledInput : -scaledInput;
      const float shapedInput = saturate(absInput, k);
      const float attenuation = absInput <= 0.0001f ? 1 : shapedInput / absInput;
      const float dbAttenuation = std::max(2.0f, -linearToDecibels(attenuation));
      const float dbPerFrame = dbAttenuation / satReleaseFrames;
      const float satReleaseRate = decibelsToLinear(dbPerFrame) - 1;
      const bool isRelease = attenuation > detectorAverage;
      const float rate = isRelease ? satReleaseRate : 1;
      detectorAverage += (attenuation - detectorAverage) * rate;
      detectorAverage = std::min(1.0f, detectorAverage);
      detectorAverage = ensureFinite(detectorAverage, 1);

      if (envelopeRate < 1) {
        compressorGain += (scaledDesiredGain - compressorGain) * envelopeRate;  // attack
      } else {
        compressorGain *= envelopeRate;  // release
        compressorGain = std::min(1.0f, compressorGain);
      }
      const float postWarpCompressorGain =
          static_cast<float>(rig::js::sin(static_cast<double>(kPiOverTwoFloat * compressorGain)));
      const float totalGain = linearPostGain * postWarpCompressorGain;
      // (metering of kParamReduction omitted: no audible effect, see compressor.h)
      dst[0][frameIndex] = preDelay_[0][readIndex] * totalGain;
      dst[1][frameIndex] = preDelay_[1][readIndex] * totalGain;
      ++frameIndex;
      readIndex = (readIndex + 1) & kMask;
      writeIndex = (writeIndex + 1) & kMask;
    }
    preDelayRead_ = readIndex;
    preDelayWrite_ = writeIndex;
    detectorAverage_ = flushDenormal(detectorAverage);
    compressorGain_ = flushDenormal(compressorGain);
  }
}

}  // namespace rig::wa
