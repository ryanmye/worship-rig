// Chromium 157.0.8103.78 SincResampler port (see resampler.h). BSD-3 licence of the original applies.
#include "samples/resampler.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include "num/js_math.h"

namespace rig::samples {
namespace {

constexpr int kKernelSize = 32;
constexpr int kKernelOffsetCount = 32;
constexpr int kKernelStorageSize = kKernelSize * (kKernelOffsetCount + 1);
constexpr int kRequestFrames = 512;  // Chromium: SincResampler::kDefaultRequestSize

class Sinc {
 public:
  explicit Sinc(double ioRatio) : ratio_(ioRatio), input_(static_cast<std::size_t>(kRequestFrames + kKernelSize), 0.0f) {
    initKernel();
    flush();
  }

  /** Fill `n` output frames pulling input from `src` (zeros past its end). */
  void run(const float *src, std::size_t srcLen, float *dst, std::size_t n) {
    src_ = src;
    srcLen_ = srcLen;
    std::size_t remaining = n;
    if (!primed_ && remaining) {
      read(r0_);
      primed_ = true;
    }
    while (remaining) {
      const int count = static_cast<int>(std::ceil((blockSize_ - virtualIdx_) / ratio_));
      for (int i = count; i > 0; --i) {
        const int sourceIdx = static_cast<int>(virtualIdx_);
        const double sub = virtualIdx_ - sourceIdx;
        const double virtualOffset = sub * kKernelOffsetCount;
        const int offsetIdx = static_cast<int>(virtualOffset);
        const float *k1 = kernel_.data() + offsetIdx * kKernelSize;
        const float *k2 = k1 + kKernelSize;
        const float *in = r1_ + sourceIdx;
        const double factor = virtualOffset - offsetIdx;
        *dst++ = convolve(in, k1, k2, factor);
        virtualIdx_ += ratio_;
        if (--remaining == 0) return;
      }
      virtualIdx_ -= blockSize_;
      std::memcpy(r1_, r3_, sizeof(float) * kKernelSize);
      if (r0_ == r2_) updateRegions(true);
      read(r0_);
    }
  }

 private:
  void initKernel() {
    kernel_.assign(static_cast<std::size_t>(kKernelStorageSize), 0.0f);
    double scale = ratio_ > 1.0 ? 1.0 / ratio_ : 1.0;
    scale *= kCutoff;
    const double pi = 3.14159265358979323846;
    for (int off = 0; off <= kKernelOffsetCount; ++off) {
      const double subsample = static_cast<double>(off) / kKernelOffsetCount;
      for (int i = 0; i < kKernelSize; ++i) {
        // Blackman window (alpha .16) matching the offset of the sinc (Chromium: x = (i - subsample) / kKernelSize)
        const float x = static_cast<float>((i - subsample) / kKernelSize);
        const float window = static_cast<float>(0.42 - 0.5 * js::cos(2.0 * pi * x) + 0.08 * js::cos(4.0 * pi * x));
        const float preSinc = static_cast<float>(pi * (i - kKernelSize / 2 - subsample));
        const double sinc = preSinc == 0 ? scale : js::sin(scale * preSinc) / preSinc;
        kernel_[static_cast<std::size_t>(off * kKernelSize + i)] = static_cast<float>(window * sinc);
      }
    }
  }
  void flush() {
    virtualIdx_ = 0;
    primed_ = false;
    std::fill(input_.begin(), input_.end(), 0.0f);
    updateRegions(false);
  }
  void updateRegions(bool secondLoad) {
    float *b = input_.data();
    r0_ = b + (secondLoad ? kKernelSize : kKernelSize / 2);
    r1_ = b;
    r2_ = b + kKernelSize / 2;
    r3_ = r0_ + kRequestFrames - kKernelSize;
    r4_ = r0_ + kRequestFrames - kKernelSize / 2;
    blockSize_ = static_cast<double>(r4_ - r2_);
  }
  void read(float *dst) {
    for (int i = 0; i < kRequestFrames; ++i) {
      const std::size_t p = pos_ + static_cast<std::size_t>(i);
      dst[i] = p < srcLen_ ? src_[p] : 0.0f;
    }
    pos_ += kRequestFrames;
  }
  // Chromium's x86 path is the SSE2 convolve: four lane-wise partial sums, then a horizontal add.
  static float convolve(const float *in, const float *k1, const float *k2, double factor) {
    float s1[4] = {0, 0, 0, 0}, s2[4] = {0, 0, 0, 0};
    for (int i = 0; i < kKernelSize; i += 4)
      for (int l = 0; l < 4; ++l) {
        s1[l] += in[i + l] * k1[i + l];
        s2[l] += in[i + l] * k2[i + l];
      }
    const float sum1 = s1[0] + s1[1] + s1[2] + s1[3];
    const float sum2 = s2[0] + s2[1] + s2[2] + s2[3];
    return static_cast<float>((1.0 - factor) * static_cast<double>(sum1) + factor * static_cast<double>(sum2));
  }

 private:
  static constexpr double kCutoff = 0.9;  // lowered sinc cutoff against aliasing (Chromium: sinc_scale_factor *= .9)
  double ratio_;
  std::vector<float> kernel_, input_;
  const float *src_ = nullptr;
  std::size_t srcLen_ = 0, pos_ = 0;
  double virtualIdx_ = 0, blockSize_ = 0;
  bool primed_ = false;
  float *r0_ = nullptr, *r1_ = nullptr, *r2_ = nullptr, *r3_ = nullptr, *r4_ = nullptr;
};

}  // namespace

std::size_t resampledLength(std::size_t frames, double inRate, double outRate) {
  if (inRate == outRate) return frames;
  // Blink AudioBus::CreateBySampleRateConverting: length / (source rate / destination rate), truncated
  return static_cast<std::size_t>(static_cast<double>(frames) / (inRate / outRate));
}

void resampleChannel(const std::vector<float> &in, double inRate, double outRate, std::vector<float> &out) {
  if (inRate == outRate || in.empty()) {
    out = in;
    return;
  }
  const std::size_t n = resampledLength(in.size(), inRate, outRate);
  out.assign(n, 0.0f);
  Sinc s(inRate / outRate);
  s.run(in.data(), in.size(), out.data(), n);
}

}  // namespace rig::samples
