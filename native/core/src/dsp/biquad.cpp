// Port of Chromium 157.0.8103.78 third_party/blink/renderer/platform/audio/biquad.cc and
// third_party/blink/renderer/modules/webaudio/biquad_filter_handler.cc.
// Copyright (C) 2010 Google Inc. All rights reserved. BSD-3 (third_party/chromium/LICENSE):
// Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
// following conditions are met: 1. Redistributions of source code must retain the above copyright notice, this list
// of conditions and the following disclaimer. 2. Redistributions in binary form must reproduce the above copyright
// notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided
// with the distribution. 3. Neither the name of Apple Computer, Inc. ("Apple") nor the names of its contributors may
// be used to endorse or promote products derived from this software without specific prior written permission.
// THIS SOFTWARE IS PROVIDED BY APPLE AND ITS CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES ARE
// DISCLAIMED (full text: third_party/chromium/LICENSE).
//
// The non-Mac path of Biquad::Process (the Mac build uses vDSP_deq22D, which the goldens never ran).
#include "dsp/biquad.h"

#include <algorithm>
#include <cmath>

#include "num/js_math.h"

namespace rig::wa {
namespace {

constexpr double kPiDouble = 3.141592653589793;  // std::numbers::pi
constexpr double kLn10 = 2.302585092994046;      // std::numbers::ln10

/** biquad.cc pow10: fdlibm::expf(x * ln10), i.e. exp of the float-rounded argument, rounded to float. */
double pow10(double x) {
  return static_cast<float>(fdlibm::exp(static_cast<float>(x * kLn10)));
}

BiquadCoeffs norm(double b0, double b1, double b2, double a0, double a1, double a2) {
  const double inv = 1 / a0;
  return {b0 * inv, b1 * inv, b2 * inv, a1 * inv, a2 * inv};
}

BiquadCoeffs lowpass(double cutoff, double resonance) {
  cutoff = std::clamp(cutoff, 0.0, 1.0);
  if (cutoff == 1) return norm(1, 0, 0, 1, 0, 0);
  if (!(cutoff > 0)) return norm(0, 0, 0, 1, 0, 0);
  resonance = pow10(resonance / 20);
  const double theta = kPiDouble * cutoff;
  const double alpha = fdlibm::sin(theta) / (2 * resonance);
  const double cosw = fdlibm::cos(theta);
  const double beta = (1 - cosw) / 2;
  return norm(beta, 2 * beta, beta, 1 + alpha, -2 * cosw, 1 - alpha);
}

BiquadCoeffs highpass(double cutoff, double resonance) {
  cutoff = std::clamp(cutoff, 0.0, 1.0);
  if (cutoff == 1) return norm(0, 0, 0, 1, 0, 0);
  if (!(cutoff > 0)) return norm(1, 0, 0, 1, 0, 0);
  resonance = pow10(resonance / 20);
  const double theta = kPiDouble * cutoff;
  const double alpha = fdlibm::sin(theta) / (2 * resonance);
  const double cosw = fdlibm::cos(theta);
  const double beta = (1 + cosw) / 2;
  return norm(beta, -2 * beta, beta, 1 + alpha, -2 * cosw, 1 - alpha);
}

BiquadCoeffs lowShelf(double frequency, double dbGain) {
  frequency = std::clamp(frequency, 0.0, 1.0);
  const double a = pow10(dbGain / 40);
  if (frequency == 1) return norm(a * a, 0, 0, 1, 0, 0);
  if (!(frequency > 0)) return norm(1, 0, 0, 1, 0, 0);
  const double w0 = kPiDouble * frequency;
  const double s = 1;  // filter slope (1 is max value)
  const double alpha = 0.5 * fdlibm::sin(w0) * std::sqrt((a + 1 / a) * (1 / s - 1) + 2);
  const double k = fdlibm::cos(w0);
  const double k2 = 2 * std::sqrt(a) * alpha;
  const double ap1 = a + 1, am1 = a - 1;
  return norm(a * (ap1 - am1 * k + k2), 2 * a * (am1 - ap1 * k), a * (ap1 - am1 * k - k2), ap1 + am1 * k + k2,
              -2 * (am1 + ap1 * k), ap1 + am1 * k - k2);
}

BiquadCoeffs highShelf(double frequency, double dbGain) {
  frequency = std::clamp(frequency, 0.0, 1.0);
  const double a = pow10(dbGain / 40);
  if (frequency == 1) return norm(1, 0, 0, 1, 0, 0);
  if (!(frequency > 0)) return norm(a * a, 0, 0, 1, 0, 0);
  const double w0 = kPiDouble * frequency;
  const double s = 1;
  const double alpha = 0.5 * fdlibm::sin(w0) * std::sqrt((a + 1 / a) * (1 / s - 1) + 2);
  const double k = fdlibm::cos(w0);
  const double k2 = 2 * std::sqrt(a) * alpha;
  const double ap1 = a + 1, am1 = a - 1;
  return norm(a * (ap1 + am1 * k + k2), -2 * a * (am1 + ap1 * k), a * (ap1 + am1 * k - k2), ap1 - am1 * k + k2,
              2 * (am1 - ap1 * k), ap1 - am1 * k - k2);
}

BiquadCoeffs peaking(double frequency, double q, double dbGain) {
  frequency = std::clamp(frequency, 0.0, 1.0);
  q = std::max(0.0, q);
  const double a = pow10(dbGain / 40);
  if (!(frequency > 0 && frequency < 1)) return norm(1, 0, 0, 1, 0, 0);
  if (!(q > 0)) return norm(a * a, 0, 0, 1, 0, 0);
  const double w0 = kPiDouble * frequency;
  const double alpha = fdlibm::sin(w0) / (2 * q);
  const double k = fdlibm::cos(w0);
  return norm(1 + alpha * a, -2 * k, 1 - alpha * a, 1 + alpha / a, -2 * k, 1 - alpha / a);
}

BiquadCoeffs allpass(double frequency, double q) {
  frequency = std::clamp(frequency, 0.0, 1.0);
  q = std::max(0.0, q);
  if (!(frequency > 0 && frequency < 1)) return norm(1, 0, 0, 1, 0, 0);
  if (!(q > 0)) return norm(-1, 0, 0, 1, 0, 0);
  const double w0 = kPiDouble * frequency;
  const double alpha = fdlibm::sin(w0) / (2 * q);
  const double k = fdlibm::cos(w0);
  return norm(1 - alpha, -2 * k, 1 + alpha, 1 + alpha, -2 * k, 1 - alpha);
}

BiquadCoeffs notch(double frequency, double q) {
  frequency = std::clamp(frequency, 0.0, 1.0);
  q = std::max(0.0, q);
  if (!(frequency > 0 && frequency < 1)) return norm(1, 0, 0, 1, 0, 0);
  if (!(q > 0)) return norm(0, 0, 0, 1, 0, 0);
  const double w0 = kPiDouble * frequency;
  const double alpha = fdlibm::sin(w0) / (2 * q);
  const double k = fdlibm::cos(w0);
  return norm(1, -2 * k, 1, 1 + alpha, -2 * k, 1 - alpha);
}

BiquadCoeffs bandpass(double frequency, double q) {
  frequency = std::max(0.0, frequency);
  q = std::max(0.0, q);
  if (!(frequency > 0 && frequency < 1)) return norm(0, 0, 0, 1, 0, 0);
  if (!(q > 0)) return norm(1, 0, 0, 1, 0, 0);
  const double w0 = kPiDouble * frequency;
  const double alpha = fdlibm::sin(w0) / (2 * q);
  const double k = fdlibm::cos(w0);
  return norm(alpha, 0, -alpha, 1 + alpha, -2 * k, 1 - alpha);
}

/** biquad_filter_handler.cc NormalizeFrequency (detune 0): float frequency / double nyquist. */
double normalizeFrequency(float frequency, double sampleRate) {
  const double nyquist = 0.5 * static_cast<double>(static_cast<float>(sampleRate));
  return frequency / nyquist;
}

}  // namespace

BiquadCoeffs biquadCoeffsNormalized(BiquadType type, double f, double q, double gainDb) {
  switch (type) {
    case BiquadType::Lowpass:
      return lowpass(f, q);
    case BiquadType::Highpass:
      return highpass(f, q);
    case BiquadType::Bandpass:
      return bandpass(f, q);
    case BiquadType::Lowshelf:
      return lowShelf(f, gainDb);
    case BiquadType::Highshelf:
      return highShelf(f, gainDb);
    case BiquadType::Peaking:
      return peaking(f, q, gainDb);
    case BiquadType::Notch:
      return notch(f, q);
    case BiquadType::Allpass:
      return allpass(f, q);
  }
  return {};
}

BiquadCoeffs biquadCoeffs(BiquadType type, double freqHz, double q, double gainDb, double sampleRate) {
  const float f = static_cast<float>(freqHz), qf = static_cast<float>(q), g = static_cast<float>(gainDb);
  return biquadCoeffsNormalized(type, normalizeFrequency(f, sampleRate), qf, g);
}

// ---- Biquad -------------------------------------------------------------------------------------------------------

void Biquad::process(const float *in, float *out, std::size_t n) {
  double x1 = x1_, x2 = x2_, y1 = y1_, y2 = y2_;
  const double b0 = c_.b0, b1 = c_.b1, b2 = c_.b2, a1 = c_.a1, a2 = c_.a2;
  for (std::size_t k = 0; k < n; ++k) {
    const float x = in[k];
    const float y = static_cast<float>(b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2);
    out[k] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  // DenormalDisabler::FlushDenormalFloatToZero is the identity where the CSR flushes (x86 / arm64 Chromium); the
  // float round trip is exact (the state holds float values).
  x1_ = x1;
  x2_ = x2;
  y1_ = y1;
  y2_ = y2;
}

void Biquad::processVarying(const float *in, float *out, std::size_t n, const BiquadCoeffs *c) {
  double x1 = x1_, x2 = x2_, y1 = y1_, y2 = y2_;
  for (std::size_t k = 0; k < n; ++k) {
    const float x = in[k];
    const float y = static_cast<float>(c[k].b0 * x + c[k].b1 * x1 + c[k].b2 * x2 - c[k].a1 * y1 - c[k].a2 * y2);
    out[k] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  x1_ = x1;
  x2_ = x2;
  y1_ = y1;
  y2_ = y2;
  c_ = c[0];  // Chromium's fixed path reads index 0 (b0_[0]) until the next coefficient update
}

// ---- BiquadFilter -------------------------------------------------------------------------------------------------

namespace {
// BiquadFilterNode param ranges (biquad_filter_node.cc): frequency 0..nyquist (clamped by the formulas here),
// Q unbounded, gain <= 40 * log10(FLT_MAX).
constexpr float kMaxGainDb = 1541.27f;
}  // namespace

BiquadFilter::BiquadFilter(BiquadType type, double freqHz, double q, double gainDb)
    : type_(type), freq_(freqHz, 0.0f, FLT_MAX), q_(q), gain_(gainDb, -FLT_MAX, kMaxGainDb) {}

void BiquadFilter::reinit(BiquadType type, double freqHz, double q, double gainDb) {
  type_ = type;
  freq_ = Param(freqHz, 0.0f, FLT_MAX);
  q_ = Param(q);
  gain_ = Param(gainDb, -FLT_MAX, kMaxGainDb);
  channels_ = 0;
  last_[0] = last_[1] = last_[2] = 0;
  lastSr_ = 0;
  reset();
}

void BiquadFilter::reset() {
  for (auto &k : k_) k.reset();
  dirty_ = true;
}

void BiquadFilter::update(std::size_t n, std::int64_t frame0, double sr, bool &varying) {
  varying = false;
  const bool sa = freq_.hasSampleAccurateValues(frame0, sr) || q_.hasSampleAccurateValues(frame0, sr) ||
                  gain_.hasSampleAccurateValues(frame0, sr);
  if (sa && !krate_) {
    float fv[kMaxFrames], qv[kMaxFrames], gv[kMaxFrames];
    freq_.processARate(frame0, sr, fv, n);
    q_.processARate(frame0, sr, qv, n);
    gain_.processARate(frame0, sr, gv, n);
    bool constant = true;
    for (std::size_t k = 1; k < n && constant; ++k) constant = fv[k] == fv[0] && qv[k] == qv[0] && gv[k] == gv[0];
    const std::size_t needed = constant ? 1 : n;
    for (std::size_t k = 0; k < needed; ++k)
      var_[k] = biquadCoeffsNormalized(type_, normalizeFrequency(fv[k], sr), qv[k], gv[k]);
    varying = needed > 1;
    if (!varying)
      for (auto &kk : k_) kk.set(var_[0]);
    dirty_ = false;
    lastSr_ = sr;
    return;
  }
  const float v[3] = {freq_.processKRate(frame0, sr), q_.processKRate(frame0, sr), gain_.processKRate(frame0, sr)};
  bool changed = dirty_ || sa || sr != lastSr_;
  if (!sa && !dirty_) {  // previous_parameter_* compare (only in this branch, as in Chromium)
    if (v[0] != last_[0] || v[1] != last_[1] || v[2] != last_[2]) changed = true;
  }
  if (!sa) {
    last_[0] = v[0];
    last_[1] = v[1];
    last_[2] = v[2];
  }
  if (!changed) return;
  const BiquadCoeffs c = biquadCoeffsNormalized(type_, normalizeFrequency(v[0], sr), v[1], v[2]);
  for (auto &kk : k_) kk.set(c);
  dirty_ = false;
  lastSr_ = sr;
}

void BiquadFilter::process(float *const *ch, unsigned nch, std::size_t n, std::int64_t frame0, double sr) {
  nch = std::clamp(nch, 1u, 2u);
  if (nch != channels_) {  // CheckNumberOfChannelsForInput: new kernels (zero state), has_just_reset_
    for (auto &k : k_) k.reset();
    channels_ = nch;
    dirty_ = true;
  }
  bool varying = false;
  update(n, frame0, sr, varying);
  for (unsigned c = 0; c < nch; ++c) {
    if (varying)
      k_[c].processVarying(ch[c], ch[c], n, var_);
    else
      k_[c].process(ch[c], ch[c], n);
  }
}

void BiquadFilter::processParamsOnly(std::size_t n, std::int64_t frame0, double sr) {
  float tmp[kMaxFrames];
  freq_.processARate(frame0, sr, tmp, n);
  q_.processARate(frame0, sr, tmp, n);
  gain_.processARate(frame0, sr, tmp, n);
}

}  // namespace rig::wa
