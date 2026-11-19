// DelayLine: DelayNode semantics (Q9): fractional read with linear interpolation, a-rate delayTime, max delay fixed
// at construction. Interface FROZEN by T00b; T02 implements (dsp/delay_line.cpp). Used by the width/strip (T02), the
// echo, chorus and lofi tape delay (T05), the reverb predelay (T04). Unlike DelayNode, a feedback loop built from
// these lines is NOT split into 128-frame blocks (the owner processes sample by sample when it feeds back).
#pragma once
#include <cstddef>
#include <cstdint>

#include "time/param.h"

namespace rig::wa {

class DelayLine {
 public:
  DelayLine(double maxDelaySec, double sampleRate, double initialDelaySec = 0.0);
  ~DelayLine();
  DelayLine(const DelayLine &) = delete;
  DelayLine &operator=(const DelayLine &) = delete;

  Param &delayTime() { return time_; }
  /** Block form: out[i] = in delayed by delayTime(frame0 + i). in and out may alias. */
  void process(std::int64_t frame0, double sampleRate, const float *in, float *out, std::size_t n);
  /** Sample form for feedback loops: write one input, then read the output at `delaySec`. */
  void write(float x);
  float read(double delaySec, double sampleRate) const;
  void clear();

 private:
  Param time_;
  float *buf_ = nullptr;
  std::size_t size_ = 0, pos_ = 0;
};

}  // namespace rig::wa
