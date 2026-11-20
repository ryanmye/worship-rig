// T05: DelayNode a-rate kernel, port of Chromium 157.0.8103.78 delay.cc + cpu/x86/delay_sse2.cc (Copyright The
// Chromium Authors, BSD-3-Clause, third_party/chromium/LICENSE). See fx/delay_node.h.
#include "fx/delay_node.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace rig::fx {

std::size_t timeToSampleFrameUp(double time, double rate) {
  // audio_utilities.cc: round to 1/1024 frame first, then ceil
  const double frame = std::round(time * rate * 1024.0) / 1024.0;
  return static_cast<std::size_t>(std::ceil(frame));
}

void DelayNodeKernel::allocate(double maxDelaySec, double sampleRate, unsigned channels) {
  sr_ = static_cast<float>(sampleRate);
  max_ = maxDelaySec;
  len_ = kQ + timeToSampleFrameUp(maxDelaySec, static_cast<double>(sr_));
  for (unsigned c = 0; c < 2; ++c) buf_[c].assign(c < channels ? len_ : 0, 0.0f);
  w_ = 0;
}

void DelayNodeKernel::clear() {
  for (auto &b : buf_) std::fill(b.begin(), b.end(), 0.0f);
  w_ = 0;
}

void DelayNodeKernel::advanceSilent() {
  w_ += kQ;
  if (w_ >= len_) w_ -= len_;
}

void DelayNodeKernel::process(const float *const *in, float *const *out, unsigned channels, const float *dt) {
  // CopyToCircularBuffer: the quantum goes into the buffer before any read (reads of < 128 frames see it)
  for (unsigned c = 0; c < channels; ++c) {
    float *b = buf_[c].data();
    const std::size_t first = std::min(kQ, len_ - w_);
    std::memcpy(b + w_, in[c], first * sizeof(float));
    if (first < kQ) std::memcpy(b, in[c] + first, (kQ - first) * sizeof(float));
  }
  // ProcessARateVector: v_write_index = w + k (wrapped), read position in float
  const float lenF = static_cast<float>(len_);
  const long len = static_cast<long>(len_);
  for (std::size_t i = 0; i < kQ; ++i) {
    long wi = static_cast<long>(w_ + i);
    if (wi >= len) wi -= len;
    const float desired = std::max(dt[i], 0.0f) * sr_;    // _mm_max_ps(dt, 0) * rate
    float rp = static_cast<float>(wi) + (lenF - desired);  // cvtepi32_ps(w) + (len - desired)
    if (rp >= lenF) rp -= lenF;                            // WrapPositionVector
    long i1 = static_cast<long>(rp);                       // _mm_cvttps_epi32
    if (i1 >= len) i1 -= len;
    long i2 = i1 + 1;
    if (i2 >= len) i2 -= len;
    const float f = rp - static_cast<float>(i1);
    for (unsigned c = 0; c < channels; ++c) {
      const float s1 = buf_[c][static_cast<std::size_t>(i1)], s2 = buf_[c][static_cast<std::size_t>(i2)];
      out[c][i] = s1 + f * (s2 - s1);
    }
  }
  w_ += kQ;
  if (w_ >= len_) w_ -= len_;
}

void sumAndClip(float *v, const float *const *conns, unsigned nConns, float defaultValue, float lo, float hi,
                std::size_t n) {
  for (unsigned k = 0; k < nConns; ++k)
    for (std::size_t i = 0; i < n; ++i) v[i] += conns[k][i];
  if (nConns > 0)
    for (std::size_t i = 0; i < n; ++i)
      if (std::isnan(v[i])) v[i] = defaultValue;
  for (std::size_t i = 0; i < n; ++i) v[i] = std::min(std::max(v[i], lo), hi);
}

void biquadQuantum(wa::Biquad &f, wa::BiquadType type, const float *freq, const float *q, bool sampleAccurate,
                   double sampleRate, const float *in, float *out) {
  if (!sampleAccurate) {
    f.set(type, freq[0], q[0], 0.0, sampleRate);
    f.process(in, out, DelayNodeKernel::kQ);
    return;
  }
  for (std::size_t i = 0; i < DelayNodeKernel::kQ; ++i) {
    f.set(type, freq[i], q[i], 0.0, sampleRate);
    f.process(in + i, out + i, 1);
  }
}

}  // namespace rig::fx
