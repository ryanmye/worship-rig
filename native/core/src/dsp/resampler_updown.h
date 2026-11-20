// wa::UpSampler / wa::DownSampler: the 2x half-band resamplers behind WaveShaperNode oversampling. Ports of Chromium
// 157.0.8103.78 third_party/blink/renderer/platform/audio/up_sampler.cc and down_sampler.cc (BSD-3, Google Inc. /
// The Chromium Authors; third_party/chromium/LICENSE), with direct_convolver.cc's convolution as Chromium's x86 SIMD
// code computes it (vector_math Conv: per output, sequential float sum of products over the reversed kernel; the
// lane layout does not change the order). Kernels: UpSampler 128 taps (windowed sinc at a half-sample offset,
// Blackman alpha .16, fdlibm sin/cos), DownSampler the 128 odd taps of a 256-tap half-band sinc.
//
// Deviation: Chromium convolves blocks larger than its kernel (the second stage of 4x: UpSampler(256),
// DownSampler(512)) with SimpleFFTConvolver (FFT overlap-add). Here every block uses the direct form: the same linear
// convolution, different float rounding (about 1e-7 relative).
//
// Allocation in the constructors only; process() is real-time safe.
#pragma once
#include <cstddef>
#include <vector>

namespace rig::wa {

/** dst[2n] from src[n]: even outputs = the input delayed by 64 frames, odd outputs = the interpolation filter. */
class UpSampler {
 public:
  static constexpr std::size_t kKernelSize = 128;
  explicit UpSampler(std::size_t inputBlockSize);
  void process(const float *src, float *dst);  // src: inputBlockSize frames, dst: 2 * inputBlockSize
  void reset();
  std::size_t latencyFrames() const { return kKernelSize / 2; }  // at the input rate
  std::size_t blockSize() const { return block_; }

 private:
  std::size_t block_;
  std::vector<float> reversed_;  // kernel reversed (Conv's prepared filter)
  std::vector<float> conv_;      // DirectConvolver buffer: kernel - 1 history + block
  std::vector<float> input_;     // kKernelSize / 2 + block
  std::vector<float> odd_;       // block: the interpolated (odd) outputs before interleaving
};

/** dst[n/2] from src[n]: half-band low-pass, keep every second frame. */
class DownSampler {
 public:
  static constexpr std::size_t kKernelSize = 256;  // the reduced kernel has kKernelSize / 2 taps
  explicit DownSampler(std::size_t inputBlockSize);
  void process(const float *src, float *dst);  // src: inputBlockSize frames, dst: inputBlockSize / 2
  void reset();
  std::size_t latencyFrames() const { return kKernelSize / 4; }  // ConvolutionKernelSize() / 2 = 64
  std::size_t blockSize() const { return block_; }

 private:
  std::size_t block_;
  std::vector<float> reversed_;
  std::vector<float> conv_;
  std::vector<float> input_;  // kKernelSize / 2 + block
  std::vector<float> odd_;    // block / 2
};

/** vector_math::Conv over a history buffer: dst[f] = sum_k buf[f + k] * reversed[k] (float, k ascending). */
void directConvolve(const float *buf, const float *reversed, std::size_t taps, float *dst, std::size_t n);

}  // namespace rig::wa
