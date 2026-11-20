// wa::Biquad / wa::BiquadFilter: BiquadFilterNode as Chromium 157.0.8103.78 computes it. Port of
// third_party/blink/renderer/platform/audio/biquad.cc (Biquad::Set*Params, Process) and
// third_party/blink/renderer/modules/webaudio/biquad_filter_handler.cc (NormalizeFrequency, the k-rate / a-rate
// coefficient update per render quantum, kernel reset on a channel-count change). Copyright (C) 2010 Google Inc.,
// BSD-3 (third_party/chromium/LICENSE).
//
// Parity details kept from the source: AudioParam values are float (frequency / Q / gain are rounded to float before
// the formulas); frequency is normalised by the double nyquist 0.5 * sampleRate; 10^x is fdlibm::expf(x * ln 10)
// (float precision!); sin / cos are fdlibm (rig::fdlibm); the section output is rounded to float inside the
// recursion (`float y = b0 * x + ...` with double coefficients and double state that holds float values); state is
// not flushed explicitly (x86 Chromium runs with FTZ/DAZ, as rt_guard does).
#pragma once
#include <cstddef>
#include <cstdint>

#include "time/param.h"

namespace rig::wa {

enum class BiquadType { Lowpass, Highpass, Bandpass, Lowshelf, Highshelf, Peaking, Notch, Allpass };

struct BiquadCoeffs {
  double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;  // normalised by a0
};

/**
 * Biquad::Set*Params on an already normalised frequency (f / nyquist; clamped to 0..1 as Chromium does).
 * @param q Q param value: linear Q (peaking, notch, bandpass, allpass) or resonance in dB (lowpass, highpass)
 * @param gainDb gain param value (shelves, peaking)
 */
BiquadCoeffs biquadCoeffsNormalized(BiquadType type, double normFreq, double q, double gainDb);

/**
 * Coefficients as BiquadFilterNode computes them from its param values: frequency, Q and gain are rounded to float
 * (AudioParam values), frequency is divided by nyquist = 0.5 * sampleRate.
 */
BiquadCoeffs biquadCoeffs(BiquadType type, double freqHz, double q, double gainDb, double sampleRate);

/** One channel of a biquad section (Chromium Biquad). */
class Biquad {
 public:
  void set(const BiquadCoeffs &c) { c_ = c; }
  void set(BiquadType type, double freqHz, double q, double gainDb, double sampleRate) {
    c_ = biquadCoeffs(type, freqHz, q, gainDb, sampleRate);
  }
  const BiquadCoeffs &coeffs() const { return c_; }
  void reset() { x1_ = x2_ = y1_ = y2_ = 0.0; }
  /** Fixed coefficients. In place or out of place (in may equal out). */
  void process(const float *in, float *out, std::size_t n);
  /** Sample-accurate coefficients (a-rate automation): c[k] for frame k. In place allowed. */
  void processVarying(const float *in, float *out, std::size_t n, const BiquadCoeffs *c);

 private:
  BiquadCoeffs c_;
  double x1_ = 0, x2_ = 0, y1_ = 0, y2_ = 0;
};

/**
 * BiquadFilterNode for up to two channels (BiquadFilterHandler): the frequency / Q / gain AudioParams (detune is
 * not exposed: always 0), their automation rate, and one Biquad kernel per channel. Each quantum the coefficients
 * come from the params: a-rate with sample-accurate values ⇒ per frame (one set when all values are constant),
 * otherwise from FinalValue(). A change of the input channel count resets the kernels (Uninitialize/Initialize).
 * RT-safe after construction.
 */
class BiquadFilter {
 public:
  static constexpr std::size_t kMaxFrames = Param::kQuantum;

  BiquadFilter(BiquadType type = BiquadType::Lowpass, double freqHz = 350, double q = 1, double gainDb = 0);

  Param &frequency() { return freq_; }
  Param &q() { return q_; }
  Param &gain() { return gain_; }
  BiquadType type() const { return type_; }
  /** BiquadFilterNode.type = t: a different type resets the kernels (BiquadFilterHandler::SetType). */
  void setType(BiquadType t) {
    if (t == type_) return;
    type_ = t;
    reset();
  }
  /** automationRate of every param ('k-rate' for the slot EQ, fx.js `_node`). */
  void setKRate(bool k) { krate_ = k; }
  bool kRate() const { return krate_; }
  /** Reset both kernels (filter memory). */
  void reset();
  /** Become a new node (fresh params with these values, no events; zero state; k-rate kept). */
  void reinit(BiquadType type, double freqHz, double q, double gainDb);

  /**
   * One quantum (n ≤ 128) of `nch` channels in place: ch[c] is read and overwritten. frame0 / sampleRate drive the
   * params.
   */
  void process(float *const *ch, unsigned nch, std::size_t n, std::int64_t frame0, double sampleRate);
  /** Advance the params only (Chromium ProcessOnlyAudioParams, while the node propagates silence). */
  void processParamsOnly(std::size_t n, std::int64_t frame0, double sampleRate);
  const BiquadCoeffs &coeffs() const { return k_[0].coeffs(); }

 private:
  void update(std::size_t n, std::int64_t frame0, double sampleRate, bool &varying);

  BiquadType type_;
  Param freq_, q_, gain_;
  bool krate_ = false, dirty_ = true;
  unsigned channels_ = 0;  // 0 = not initialised yet
  float last_[3] = {0, 0, 0};
  double lastSr_ = 0;
  Biquad k_[2];
  BiquadCoeffs var_[kMaxFrames];
};

}  // namespace rig::wa
