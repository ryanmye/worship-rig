// PeriodicWave: Chromium band-limited wavetables (Q11, Q12). Interface FROZEN by T00b; T11a implements
// (dsp/periodic_wave.cpp), porting Chromium 157.0.8103.78 `periodic_wave.cc` (table size, per-range partial culling,
// normalisation rule, interpolation incl. the higher-order low-frequency path; SETUP_REVIEW 17).
// Built on the control thread / a worker (allocates); immutable afterwards, shared by oscillators by raw pointer.
#pragma once
#include <cstddef>
#include <cstdint>

namespace rig::wa {

class PeriodicWave {
 public:
  enum class Basic { Sine, Square, Sawtooth, Triangle };
  /** createPeriodicWave(real, imag, {disableNormalization}); n = coefficient count (index 0 ignored, as Web Audio). */
  static PeriodicWave *create(const float *real, const float *imag, std::size_t n, bool disableNormalization,
                              double sampleRate);
  /** The built-in OscillatorNode types. */
  static PeriodicWave *basic(Basic type, double sampleRate);
  ~PeriodicWave();
  PeriodicWave(const PeriodicWave &) = delete;
  PeriodicWave &operator=(const PeriodicWave &) = delete;

  double sampleRate() const;
  /** Lower/higher band tables and the crossfade for a fundamental (Chromium WaveDataForFundamentalFrequency). */
  void tablesFor(double fundamentalHz, const float *&lower, const float *&higher, float &interp) const;
  std::size_t tableSize() const;
  float rateScale() const;  // tableSize / sampleRate

 private:
  PeriodicWave();
  struct Impl;
  Impl *impl_;
};

}  // namespace rig::wa
