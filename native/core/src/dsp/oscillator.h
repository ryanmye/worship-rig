// Oscillator: OscillatorNode semantics over a PeriodicWave (Chromium oscillator_node.cc port, Q11/Q12).
// Interface FROZEN by T00b; T11a implements (dsp/oscillator.cpp). Used by voices (T11/T15), the chorus and lofi LFOs
// (T05), the drone (T16). RT: no allocation after construction.
#pragma once
#include <cstddef>
#include <cstdint>

#include "dsp/periodic_wave.h"
#include "time/param.h"

namespace rig::wa {

class Oscillator {
 public:
  /** `wave` is borrowed (owner keeps it alive past the oscillator's detach epoch). */
  Oscillator(const PeriodicWave *wave, double frequency = 440.0, double detuneCents = 0.0);

  Param &frequency() { return freq_; }  // a-rate
  Param &detune() { return detune_; }   // a-rate (cents)
  void setWave(const PeriodicWave *w) { wave_ = w; }

  /** start(t)/stop(t) at engine seconds (sub-sample accurate like Chromium: start frame = ceil(t*sr)). */
  void start(double t);
  void stop(double t);
  bool finished() const { return finished_; }

  /** Writes n frames for time-grid frames [frame0, frame0+n) (zeros before start / after stop). */
  void process(std::int64_t frame0, double sampleRate, float *out, std::size_t n);

 private:
  const PeriodicWave *wave_;
  Param freq_, detune_;
  double phase_ = 0.0;  // in table samples (Chromium virtual read index)
  double start_ = -1.0, stop_ = -1.0;
  bool finished_ = false;
};

}  // namespace rig::wa
