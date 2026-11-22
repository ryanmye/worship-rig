// T05: the DelayNode kernel shared by the echo, chorus and lofi tape delay (fx/delay*, fx/chorus*, fx/lofi*).
//
// Port of Chromium 157.0.8103.78 third_party/blink/renderer/platform/audio/delay.cc (Delay::ProcessARate) and
// cpu/x86/delay_sse2.cc (Delay::ProcessARateVector), Copyright The Chromium Authors, BSD-3-Clause
// (third_party/chromium/LICENSE). DelayNode.delayTime is always a-rate in Chromium 157 (DelayHandler::Process takes
// the IsAudioRate() branch), so only the a-rate kernel is ported. The goldens are x86-64 renders, i.e. the SSE2
// path: the read position is computed in float, 4 lanes at a time, reproduced here in scalar float (128 % 4 == 0,
// so the scalar double tail of ProcessARate never runs).
//
// Why not wa::DelayLine (dsp/delay_line.h): parity with the goldens needs Chromium's exact buffer length
// (128 + ceil(max * rate)) and float read position, and the echo's feedback cycle is built from 128-frame blocks
// exactly as Chromium renders it (fx/delay_unit.h).
#pragma once
#include <cstddef>
#include <vector>

#include "dsp/biquad.h"

namespace rig::fx {

/** audio_utilities::TimeToSampleFrame(time, rate, kRoundUp). */
std::size_t timeToSampleFrameUp(double time, double rate);

/** One DelayNode (up to 2 channels sharing the write index, as the per-channel kernels of a DelayHandler do). */
class DelayNodeKernel {
 public:
  static constexpr std::size_t kQ = 128;

  DelayNodeKernel() = default;
  /** Control side: Delay::Delay (buffer zeroed). */
  void allocate(double maxDelaySec, double sampleRate, unsigned channels);
  void clear();
  /** One quantum. `delayTimes` are the a-rate values (already clipped to [0, max] by the AudioParam). in and out
   *  may not alias. */
  void process(const float *const *in, float *const *out, unsigned channels, const float *delayTimes);
  /** T14: one delay-time array per channel. Chromium's DelayHandler runs one DelayDSPKernel per channel and each
   *  kernel evaluates delayTime (CalculateSampleAccurateValues) itself, so the second channel sees the timeline's
   *  second evaluation of the quantum (differs right after cancelAndHold + setValue + linearRamp: the tape bend). */
  void process(const float *const *in, float *const *out, unsigned channels, const float *const *delayTimes);
  /** Skip a quantum whose input is known silent while the buffer is all zeros: the write index advances (it enters
   *  the float read position) and nothing is copied. */
  void advanceSilent();
  std::size_t length() const { return len_; }
  double maxDelay() const { return max_; }
  float sampleRate() const { return sr_; }

 private:
  std::vector<float> buf_[2];
  std::size_t len_ = 0, w_ = 0;
  float sr_ = 0;
  double max_ = 0;
};

/** AudioParam::CalculateFinalValues for a-rate delayTime with audio-rate connections: values += each connection
 *  (in connection order), NaN -> default, clip to [lo, hi] (vector_math::Vclip). */
void sumAndClip(float *values, const float *const *conns, unsigned nConns, float defaultValue, float lo, float hi,
                std::size_t n);

/** One quantum of a BiquadFilterNode whose frequency / Q are a-rate params (values already rendered):
 *  per-sample coefficients when `sampleAccurate` (BiquadDSPKernel with HasSampleAccurateValues), else one set
 *  from element 0 (FinalValue). Gain 0 (lowpass / highpass / bandpass ignore it). in may equal out. */
void biquadQuantum(wa::Biquad &f, wa::BiquadType type, const float *freq, const float *q, bool sampleAccurate,
                   double sampleRate, const float *in, float *out);

}  // namespace rig::fx
