// wa::DelayLine (dsp/delay_line.h): DelayNode as Chromium 157.0.8103.78 renders it, a port of
// third_party/blink/renderer/platform/audio/delay.cc (Delay::ProcessARate / ProcessARateScalar),
// platform/audio/cpu/x86/delay_sse2.cc (Delay::ProcessARateVector) and modules/webaudio/delay_handler.cc (delayTime
// is a-rate: CalculateSampleAccurateValues every quantum). Copyright 2020 The Chromium Authors / (C) 2010 Google
// Inc. BSD-3 (third_party/chromium/LICENSE): Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met: 1. Redistributions of source code
// must retain the above copyright notice, this list of conditions and the following disclaimer. 2. Redistributions
// in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in
// the documentation and/or other materials provided with the distribution. 3. Neither the name of the copyright
// holder nor the names of its contributors may be used to endorse or promote products derived from this software
// without specific prior written permission. THIS SOFTWARE IS PROVIDED "AS IS" AND ANY EXPRESS OR IMPLIED
// WARRANTIES ARE DISCLAIMED (full text: third_party/chromium/LICENSE).
//
// The goldens are x86-64 renders: frames in groups of 4 take the SSE2 path (read position in float), a remainder
// (n % 4, never in 128-frame quanta) the scalar double path. Buffer length = 128 + ceil(maxDelay * rate), the input
// block is written before it is read (delay 0 = the current input). The sample form (write / read) is the scalar
// formula on a one-frame block, for feedback loops (contract Q9: no 128-frame split).
#include "dsp/delay_line.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace rig::wa {
namespace {

std::size_t timeToSampleFrameUp(double time, double rate) {  // audio_utilities::TimeToSampleFrame(.., kRoundUp)
  const double f = std::ceil(time * rate);
  return f > 0 ? static_cast<std::size_t>(f) : 0;
}

}  // namespace

DelayLine::DelayLine(double maxDelaySec, double sampleRate, double initialDelaySec)
    : time_(initialDelaySec, 0.0f, static_cast<float>(maxDelaySec)) {
  const float sr = static_cast<float>(sampleRate);
  size_ = Param::kQuantum + timeToSampleFrameUp(maxDelaySec, sr);
  buf_ = new float[size_]();
}

DelayLine::~DelayLine() {
  delete[] buf_;
}

void DelayLine::clear() {
  std::memset(buf_, 0, size_ * sizeof(float));
}

void DelayLine::process(std::int64_t frame0, double sampleRate, const float *in, float *out, std::size_t n) {
  n = std::min(n, Param::kQuantum);
  float times[Param::kQuantum];
  time_.processARate(frame0, sampleRate, times, n);
  // CopyToCircularBuffer
  const std::size_t len = size_;
  const std::size_t first = std::min(n, len - pos_);
  std::memmove(buf_ + pos_, in, first * sizeof(float));
  if (n > first) std::memmove(buf_, in + first, (n - first) * sizeof(float));
  // ProcessARateVector (SSE2 lanes, emulated in scalar float)
  const float sr = static_cast<float>(sampleRate);
  const float lenF = static_cast<float>(len);
  const auto L = static_cast<std::int64_t>(len);
  const auto wrapIdx = [L](std::int64_t v) { return v < L ? v : v - L; };
  std::size_t k = 0;
  const std::size_t loops = n / 4;
  std::int64_t lane[4];
  for (int m = 0; m < 4; ++m) lane[m] = wrapIdx(static_cast<std::int64_t>(pos_) + m);
  for (std::size_t l = 0; l < loops; ++l, k += 4) {
    for (int m = 0; m < 4; ++m) {
      const float dt = std::max(times[k + m], 0.0f);
      const float desired = dt * sr;
      float rp = static_cast<float>(lane[m]) + (lenF - desired);
      if (rp >= lenF) rp -= lenF;
      const std::int64_t i1 = wrapIdx(static_cast<std::int64_t>(rp));  // _mm_cvttps_epi32 (truncation)
      const std::int64_t i2 = wrapIdx(i1 + 1);
      const float frac = rp - static_cast<float>(i1);
      const float s1 = buf_[i1], s2 = buf_[i2];
      out[k + m] = s1 + frac * (s2 - s1);
      lane[m] = wrapIdx(lane[m] + 4);
    }
  }
  std::size_t w = pos_ + k;
  if (w >= len) w -= len;
  // ProcessARateScalar for the remainder
  for (std::size_t i = k; i < n; ++i) {
    const double desired = std::fmax(static_cast<double>(times[i]), 0.0) * static_cast<double>(sr);
    double rp = static_cast<double>(w) + static_cast<double>(len) - desired;
    if (rp >= static_cast<double>(len)) rp -= static_cast<double>(len);
    const std::size_t i1 = static_cast<std::size_t>(rp);
    std::size_t i2 = i1 + 1;
    if (i2 >= len) i2 -= len;
    const float frac = static_cast<float>(rp - static_cast<double>(i1));
    const float s1 = buf_[i1], s2 = buf_[i2];
    if (++w >= len) w -= len;
    out[i] = s1 + frac * (s2 - s1);
  }
  pos_ = w;
}

void DelayLine::write(float x) {
  buf_[pos_] = x;
  if (++pos_ >= size_) pos_ = 0;
}

float DelayLine::read(double delaySec, double sampleRate) const {
  const std::size_t len = size_;
  const std::size_t w = pos_ == 0 ? len - 1 : pos_ - 1;  // the sample write() just stored
  const double maxFrames = static_cast<double>(len - Param::kQuantum);
  const double desired =
      std::clamp(delaySec, 0.0, 1e300) * static_cast<double>(static_cast<float>(sampleRate));
  double rp = static_cast<double>(w) + static_cast<double>(len) - std::min(desired, maxFrames);
  if (rp >= static_cast<double>(len)) rp -= static_cast<double>(len);
  const std::size_t i1 = static_cast<std::size_t>(rp);
  std::size_t i2 = i1 + 1;
  if (i2 >= len) i2 -= len;
  const float frac = static_cast<float>(rp - static_cast<double>(i1));
  const float s1 = buf_[i1], s2 = buf_[i2];
  return s1 + frac * (s2 - s1);
}

}  // namespace rig::wa
