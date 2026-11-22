// T15 building blocks for the synth-extra.js and organ.js ports (Chromium 157.0.8103.78 semantics, BSD-3, The
// Chromium Authors; third_party/chromium/LICENSE):
//   * XFilter: a BiquadFilterNode whose frequency / Q / detune run k-rate (synth-extra `kRate(f.frequency, f.detune,
//     f.Q)`) with optional audio inputs on detune (linkFilter: filterCS) and optional automation of each param
//     (pluck's frequency sweep, the filter envelopes on detune, resonance on Q). biquad_dsp_kernel.cc
//     UpdateCoefficientsIfNecessary: while any param HasSampleAccurateValues (a connection counts) the coefficients
//     are recomputed every quantum from FinalValue() (k-rate: timeline value at the quantum start + first frame of
//     the connected-input sum; the a-rate gain is constant 0); NormalizeFrequency multiplies f / nyquist by
//     exp2(detune / 1200) (float exp2). Otherwise they are recomputed only when a value changed. ONE evaluation per
//     quantum serves both channel kernels: measured against the goldens, a k-rate setTarget on detune steps once
//     per quantum in a stereo filter (poly-stab / analog-brass: 1.7e-6 / 6.9e-6 with one evaluation, 0.23 / 0.10
//     with one per kernel). `perKernel` keeps the other reading for probes.
//   * XDelay: a DelayNode (a-rate delayTime = intrinsic + connected inputs, clipped to [0, maxDelayTime]) over a
//     caller-owned buffer of the exact Chromium length 128 + ceil(max * rate) (T05 fx/delay_node.cpp kernel: SSE2
//     float read position).
//   * the synth-extra safety ceiling curve and the wavetables synth-extra / organ add to T11's WaveBank.
#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>

#include "dsp/biquad.h"
#include "dsp/periodic_wave.h"
#include "graph/unit.h"
#include "inst/synth_dsp.h"
#include "time/param.h"

namespace rig::inst {

/** synth-extra.js ceilingCurve(): 4097 points, linear below -3 dBFS, tanh knee to a -1 dBFS asymptote, span +-4. */
const float *extraCeilingCurve();
inline constexpr std::size_t kExtraCeilingPoints = 4097;
inline constexpr double kExtraCeilRange = 4;

/** BiquadFilterNode with k-rate frequency / Q / detune (see the header comment). Params are optional (owned by the
 *  voice): a null param is a constant that never automates. */
class XFilter {
 public:
  void init(wa::BiquadType type, double freqHz, double q, wa::Param *freq = nullptr, wa::Param *qParam = nullptr,
            wa::Param *detune = nullptr, bool linked = true);
  /** In place, nch channels. `detuneIn` = first frame of the detune connections (linkFilter), 0 if none. */
  void process(float *const *ch, unsigned nch, std::size_t n, std::int64_t frame0, double sr, float detuneIn);
  bool perKernel = false;

 private:
  wa::BiquadCoeffs coeffs(std::int64_t frame0, double sr, float detuneIn);
  wa::BiquadType type_ = wa::BiquadType::Lowpass;
  float freq_ = 350, q_ = 1;
  wa::Param *fp_ = nullptr, *qp_ = nullptr, *dp_ = nullptr;
  bool linked_ = true, dirty_ = true;
  unsigned channels_ = 0;
  float last_[3] = {0, 0, 0};
  wa::Biquad k_[2];
};

/** DelayNode over a borrowed buffer (one channel). */
class XDelay {
 public:
  static constexpr std::size_t kQ = 128;
  /** Chromium buffer length for maxDelayTime at `sr` (128 + TimeToSampleFrame(max * sr, round up)). */
  static std::size_t lengthFor(double maxDelaySec, double sr);
  /** `buf` holds at least lengthFor(max, sr) floats; it is zeroed here (Delay::Delay). */
  void attach(float *buf, double maxDelaySec, double sr);
  /** attach() into a buffer of `cap` floats: maxDelaySec shrinks to fit (only after a rate increase). */
  void attachFitting(float *buf, std::size_t cap, double maxDelaySec, double sr) {
    if (buf && lengthFor(maxDelaySec, sr) > cap) maxDelaySec = static_cast<double>(cap - kQ - 2) / sr;
    if (buf) attach(buf, maxDelaySec, sr);
  }
  /** One quantum: `delayIn` = connected-input sum (null = none) added to the intrinsic `delay` (s). */
  void process(const float *in, float *out, float delay, const float *delayIn);
  double maxDelay() const { return max_; }

 private:
  float *buf_ = nullptr;
  std::size_t len_ = 0, w_ = 0;
  float sr_ = 0;
  double max_ = 0;
};

/** synth-extra / organ wavetables of one sample rate (control thread; immutable once built). */
struct XWaveBank {
  double sampleRate = 0;
  std::array<std::unique_ptr<wa::PeriodicWave>, kRotations> square, shimmer;
  std::unique_ptr<wa::PeriodicWave> cosine;  // fmModWave(0) / cosWave: cos(theta)
  std::unique_ptr<wa::PeriodicWave> rotorCos;  // organ rotor: real [0, 1], imag [0, 0], disableNormalization
  // dx-epiano 1:1 modulators, fmModWave(adv) for adv = k * kFmAdvStep (the JS quantum is 0.002 rad; a full set would
  // be ~150 tables of 0.6 MB, so the native set is coarser: dx-epiano is statistical, Q11)
  static constexpr unsigned kFmAdvSteps = 8;
  static constexpr double kFmAdvStep = 0.04;
  std::array<std::unique_ptr<wa::PeriodicWave>, kFmAdvSteps> fmAdv;
  const wa::PeriodicWave *fmModFor(double adv) const;
  ~XWaveBank();
  static std::shared_ptr<const XWaveBank> get(double sampleRate, bool squares, bool shimmer, bool dx = false);
};

/** T15Op::SetTables payload (a device rate change): the new rate's banks (+ an organ's drawbar waves). The unit swaps
 *  them in, so the payload carries the old ones back to the control thread (Unit::giveBack). */
struct XTablesPayload final : Owned {
  std::shared_ptr<const WaveBank> bank;
  std::shared_ptr<const XWaveBank> xbank;
  std::array<std::unique_ptr<wa::PeriodicWave>, kRotations> drawbars;
};
using WaveArray = std::array<std::unique_ptr<wa::PeriodicWave>, kRotations>;
/** The table at the position `w` holds in the old tables, taken from the new ones (w itself if not found). */
const wa::PeriodicWave *mapTable(const wa::PeriodicWave *w, const WaveBank &ob, const XWaveBank &ox,
                                 const WaveArray *od, const WaveBank &nb, const XWaveBank &nx, const WaveArray *nd);

/** voice.js rotatedWaves(ctx, key, sin, 8) with sin[] already rounded as the JS array type holds it. */
void rotatedWaves(std::array<std::unique_ptr<wa::PeriodicWave>, kRotations> &out, const double *sin, std::size_t h1,
                  double sr, bool disableNormalization = false);
/** createPeriodicWave([0, cos e], [0, -sin e]) (fmModWave(ctx, adv) with e = round(adv / 0.002) * 0.002). */
wa::PeriodicWave *fmModWave(double adv, double sr);

}  // namespace rig::inst
