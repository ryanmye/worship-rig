// Port of Chromium 157.0.8103.78 third_party/blink/renderer/platform/audio/{up_sampler,down_sampler,
// direct_convolver}.cc. Copyright (C) 2013 Google Inc. / The Chromium Authors. BSD-3, full text and the tag in
// third_party/chromium/LICENSE: redistribution in source and binary forms with or without modification is permitted
// provided that the copyright notice, the conditions and the disclaimer are retained; no endorsement; provided "AS
// IS" without warranty. See resampler_updown.h for what differs (direct convolution for the large 4x blocks).
#include "dsp/resampler_updown.h"

#include <algorithm>
#include <cstring>

#include "num/js_math.h"

namespace rig::wa {
namespace {

constexpr double kPiDouble = 3.141592653589793;  // std::numbers::pi
constexpr double kTwoPiDouble = 2.0 * kPiDouble;  // wtf/math_extras.h kTwoPiDouble

// up_sampler.cc MakeKernel
std::vector<float> upKernel(std::size_t size) {
  std::vector<float> kernel(size);
  const double alpha = 0.16;
  const double a0 = 0.5 * (1.0 - alpha);
  const double a1 = 0.5;
  const double a2 = 0.5 * alpha;
  const int n = static_cast<int>(size);
  const int halfSize = n / 2;
  const double subsampleOffset = -0.5;
  for (int i = 0; i < n; ++i) {
    const double s = kPiDouble * (i - halfSize - subsampleOffset);
    const double sinc = s == 0.0 ? 1.0 : rig::fdlibm::sin(s) / s;
    const double x = (i - subsampleOffset) / n;
    const double window = a0 - a1 * rig::fdlibm::cos(kTwoPiDouble * x) + a2 * rig::fdlibm::cos(kTwoPiDouble * 2.0 * x);
    kernel[static_cast<std::size_t>(i)] = static_cast<float>(sinc * window);
  }
  return kernel;
}

// down_sampler.cc MakeReducedKernel
std::vector<float> downReducedKernel(int size) {
  std::vector<float> kernel(static_cast<std::size_t>(size / 2));
  const double alpha = 0.16;
  const double a0 = 0.5 * (1.0 - alpha);
  const double a1 = 0.5;
  const double a2 = 0.5 * alpha;
  const int n = size;
  const int halfSize = n / 2;
  const double sincScaleFactor = 0.5;
  for (int i = 1; i < n; i += 2) {
    const double s = sincScaleFactor * kPiDouble * (i - halfSize);
    double sinc = s == 0.0 ? 1.0 : rig::fdlibm::sin(s) / s;
    sinc *= sincScaleFactor;
    const double x = static_cast<double>(i) / n;
    const double window = a0 - a1 * rig::fdlibm::cos(kTwoPiDouble * x) + a2 * rig::fdlibm::cos(kTwoPiDouble * 2.0 * x);
    kernel[static_cast<std::size_t>((i - 1) / 2)] = static_cast<float>(sinc * window);
  }
  return kernel;
}

std::vector<float> reversed(const std::vector<float> &k) {
  return std::vector<float>(k.rbegin(), k.rend());
}

}  // namespace

void directConvolve(const float *buf, const float *rev, std::size_t taps, float *dst, std::size_t n) {
  // Vectorised across outputs, never across taps: every output is still the sequential float sum over k ascending
  // (the order of Chromium's SSE Conv, whose lanes are also outputs), so the result is bit-identical to the scalar
  // loop below; the compiler turns the fixed-width j loop into 4- or 8-lane mul + add (no FMA: -ffp-contract=off).
  constexpr std::size_t kBlock = 16;
  std::size_t f = 0;
  for (; f + kBlock <= n; f += kBlock) {
    float acc[kBlock] = {};
    const float *s = buf + f;
    for (std::size_t k = 0; k < taps; ++k) {
      const float r = rev[k];
      for (std::size_t j = 0; j < kBlock; ++j) acc[j] = acc[j] + r * s[k + j];
    }
    std::memcpy(dst + f, acc, sizeof acc);
  }
  for (; f < n; ++f) {
    float sum = 0.0f;
    const float *s = buf + f;
    for (std::size_t k = 0; k < taps; ++k) sum = sum + rev[k] * s[k];
    dst[f] = sum;
  }
}

// ---- UpSampler ----------------------------------------------------------------------------------------------------

UpSampler::UpSampler(std::size_t inputBlockSize)
    : block_(inputBlockSize),
      reversed_(reversed(upKernel(kKernelSize))),
      conv_(kKernelSize - 1 + inputBlockSize, 0.0f),
      input_(kKernelSize / 2 + inputBlockSize, 0.0f),
      odd_(inputBlockSize, 0.0f) {}

void UpSampler::reset() {
  std::fill(conv_.begin(), conv_.end(), 0.0f);
  std::fill(input_.begin(), input_.end(), 0.0f);
}

void UpSampler::process(const float *src, float *dst) {
  const std::size_t n = block_, half = kKernelSize / 2, history = kKernelSize - 1;
  std::memcpy(input_.data() + half, src, n * sizeof(float));
  for (std::size_t i = 0; i < n; ++i) dst[i * 2] = input_[i];  // delayed input
  // odd samples: DirectConvolver::Process(source) -> temp, written interleaved
  std::memcpy(conv_.data() + history, src, n * sizeof(float));
  directConvolve(conv_.data(), reversed_.data(), kKernelSize, odd_.data(), n);
  for (std::size_t f = 0; f < n; ++f) dst[f * 2 + 1] = odd_[f];
  std::memmove(conv_.data(), conv_.data() + n, history * sizeof(float));
  std::memmove(input_.data(), input_.data() + n, half * sizeof(float));
}

// ---- DownSampler --------------------------------------------------------------------------------------------------

DownSampler::DownSampler(std::size_t inputBlockSize)
    : block_(inputBlockSize),
      reversed_(reversed(downReducedKernel(static_cast<int>(kKernelSize)))),
      conv_(kKernelSize / 2 - 1 + inputBlockSize / 2, 0.0f),
      input_(kKernelSize / 2 + inputBlockSize, 0.0f),
      odd_(inputBlockSize / 2, 0.0f) {}

void DownSampler::reset() {
  std::fill(conv_.begin(), conv_.end(), 0.0f);
  std::fill(input_.begin(), input_.end(), 0.0f);
}

void DownSampler::process(const float *src, float *dst) {
  const std::size_t n = block_, half = kKernelSize / 2, out = n / 2, taps = kKernelSize / 2, history = taps - 1;
  std::memcpy(input_.data() + half, src, n * sizeof(float));
  const float *delayed = input_.data() + (half - 1);
  for (std::size_t i = 0; i < out; ++i) odd_[i] = delayed[i * 2];
  std::memcpy(conv_.data() + history, odd_.data(), out * sizeof(float));
  directConvolve(conv_.data(), reversed_.data(), taps, dst, out);
  std::memmove(conv_.data(), conv_.data() + out, history * sizeof(float));
  // even input samples, delayed by the half-band latency, scaled by .5
  for (std::size_t i = 0; i < out; ++i) dst[i] += 0.5f * input_[i * 2];
  std::memmove(input_.data(), input_.data() + n, half * sizeof(float));
}

}  // namespace rig::wa
