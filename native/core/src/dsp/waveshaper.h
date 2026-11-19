// WaveShaper: WaveShaperNode (Q10): curve lookup v = (n-1)(x+1)/2 with linear interpolation, clamped ends, optional
// 2x/4x oversampling through ported Chromium Up/DownSampler (latency reported, used by the lofi engage delay).
// Interface FROZEN by T00b; T03 implements (dsp/waveshaper.cpp, dsp/resampler_updown*). Used by T03 (clip curve) and
// T05 (lofi tanh + quantiser). Curves are built on the control thread and borrowed.
#pragma once
#include <cstddef>
#include <cstdint>

namespace rig::wa {

class WaveShaper {
 public:
  enum class Oversample { None, X2, X4 };
  WaveShaper(const float *curve, std::size_t n, Oversample os, unsigned channels);
  ~WaveShaper();
  WaveShaper(const WaveShaper &) = delete;
  WaveShaper &operator=(const WaveShaper &) = delete;

  /** Swap the curve (borrowed pointer) at the next process call; no allocation. */
  void setCurve(const float *curve, std::size_t n);
  /** In place, `channels` channels of n (= 128) frames. */
  void process(float *const *ch, unsigned channels, std::size_t n);
  /** Group delay of the oversampler in frames at the engine rate (Chromium value, 0 for None). */
  double latencyFrames() const;

 private:
  struct Impl;
  Impl *impl_;
};

}  // namespace rig::wa
