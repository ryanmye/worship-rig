// wa::Biquad: BiquadFilterNode with Chromium's coefficient formulas (Biquad.cpp) and a double-precision direct
// form I section. Q of lowpass/highpass is in dB, shelves use S = 1, coefficients are set once per quantum (k-rate).
#pragma once
#include <cstddef>

namespace rig::wa {

enum class BiquadType { Lowpass, Highpass, Bandpass, Lowshelf, Highshelf, Peaking, Notch, Allpass };

struct BiquadCoeffs {
  double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;  // normalised by a0
};

/**
 * Coefficients as BiquadFilterNode computes them.
 * @param freqHz cutoff / centre in Hz; @param q linear Q (peaking, notch, bandpass) or dB resonance (lowpass,
 * highpass; pass Web Audio's `Q` value as is); @param gainDb gain for shelves and peaking.
 */
BiquadCoeffs biquadCoeffs(BiquadType type, double freqHz, double q, double gainDb, double sampleRate);

class Biquad {
 public:
  void set(const BiquadCoeffs &c) { c_ = c; }
  void set(BiquadType type, double freqHz, double q, double gainDb, double sampleRate) {
    c_ = biquadCoeffs(type, freqHz, q, gainDb, sampleRate);
  }
  const BiquadCoeffs &coeffs() const { return c_; }
  void reset() { x1_ = x2_ = y1_ = y2_ = 0.0; }
  /** In place or out of place (in may equal out). */
  void process(const float *in, float *out, std::size_t n);

 private:
  BiquadCoeffs c_;
  double x1_ = 0, x2_ = 0, y1_ = 0, y2_ = 0;
};

}  // namespace rig::wa
