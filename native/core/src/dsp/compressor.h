// wa::DynamicsCompressor: DynamicsCompressorNode (contract Q8). A port of Chromium 157.0.8103.78
// third_party/blink/renderer/platform/audio/dynamics_compressor.cc (BSD-3, Google Inc. / The Chromium Authors;
// third_party/chromium/LICENSE) driven the way modules/webaudio/dynamics_compressor_handler.cc drives it: the five
// parameters are k-rate (one value per 128-frame quantum, set before process), stereo-linked detection over the
// input channels (a mono input is duplicated), 2 output channels, a 6 ms pre-delay (264 frames at 44.1 kHz) with the
// 1024-frame ring, the knee curve, adaptive release polynomial and the automatic makeup (1/fullRangeGain)^0.6.
//
// Numerics: Chromium's `fdlibm::powf / asinf` are rig::fdlibm (the vendored Chromium fdlibm); its plain libm calls
// (audio_utilities powf/log10f, sin, exp: glibc on the golden machine) use rig::js, the correctly rounded LLVM libc
// functions, in double then rounded to float (glibc's are correctly rounded in all but rare last-ulp cases).
// The metering path (kParamReduction) is not computed: nothing reads it and it costs a log10 per frame.
// Real-time safe: no allocation after construction.
#pragma once
#include <cstddef>
#include <cstdint>

namespace rig::wa {

class DynamicsCompressor {
 public:
  struct Params {
    float threshold = -24, knee = 30, ratio = 12, attack = 0.003f, release = 0.25f;  // node defaults
  };
  static constexpr unsigned kMaxPreDelayFrames = 1024;

  explicit DynamicsCompressor(double sampleRate);

  /** DynamicsCompressorHandler::Process: params of this quantum (already clamped to the node's ranges). */
  void setParams(const Params &p) { params_ = p; }
  const Params &params() const { return params_; }
  /** `n` (<= 128) frames of `srcChannels` (1 or 2) inputs into 2 outputs (may alias the inputs). */
  void process(const float *const *src, unsigned srcChannels, float *const *dst, std::size_t n);
  /** Fresh state (DynamicsCompressor::Reset). */
  void reset();
  /** A new kernel at another rate (a native rate change; Chromium builds a new context): state is reset. */
  void setSampleRate(double sampleRate);
  /** Look-ahead in frames (LatencyTime() * rate): 256 before the first quantum, then floor(0.006 * rate). */
  unsigned latencyFrames() const { return lastPreDelayFrames_; }

  // State, for tests and the fixed-point check.
  float detectorAverage() const { return detectorAverage_; }
  float compressorGain() const { return compressorGain_; }

 private:
  float kneeCurve(float x, float k) const;
  float saturate(float x, float k) const;
  float kAtSlope(float desiredSlope) const;
  float updateStaticCurveParameters(float dbThreshold, float dbKnee, float ratio);
  void setPreDelayTime(float seconds);

  Params params_;
  float sampleRate_;
  float detectorAverage_ = 0, compressorGain_ = 1;
  unsigned lastPreDelayFrames_ = 256;
  int preDelayRead_ = 0, preDelayWrite_ = 256;
  float dbMaxAttackCompressionDiff_ = -1;
  // static curve (kUninitializedValue = -1)
  float ratio_ = -1, slope_ = -1, linearThreshold_ = -1, dbThreshold_ = -1, dbKnee_ = -1, kneeThreshold_ = -1,
        dbKneeThreshold_ = -1, dbYKneeThreshold_ = -1, knee_ = -1;
  alignas(16) float preDelay_[2][kMaxPreDelayFrames] = {};
};

}  // namespace rig::wa
