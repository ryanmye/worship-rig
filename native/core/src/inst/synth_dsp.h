// Building blocks of the synth.js port (T11): the voice.js helpers (keytrack, qDb, Butterworth Qs, FM index cap,
// soft-clip / soft-ceiling curves), the shared wavetable bank (voice.js rotatedWaves / phaseRotatedSawWaves /
// sineWaves / triangleWaves, synth.js glassWaves) and two lean Web Audio node models the voices use where a full
// node with four AudioParams would cost memory for nothing:
//   * VoiceFilter: a BiquadFilterNode whose frequency and detune are k-rate and whose detune has audio inputs
//     (synth.js linkFilter: filterCS + filter LFO), Chromium 157.0.8103.78 biquad_filter_handler.cc semantics:
//     the connections make HasSampleAccurateValues() true, Q is a-rate, so the coefficients are recomputed every
//     quantum from frequency FinalValue (k-rate), detune FinalValue + the first frame of the input sum, the Q
//     timeline (per frame only while Q is automated); NormalizeFrequency multiplies by exp2(detune / 1200) (float
//     exp2: libc++ resolves the float overload); kernels: wa::Biquad (T02).
//   * ConstPan: a StereoPannerNode on a mono input whose pan is never automated (PanToTargetValue: float gains
//     cos / sin of (pan + 1) / 2 * pi / 2, fdlibm).
// Chromium code BSD-3 (The Chromium Authors; third_party/chromium/LICENSE). JS math goes through rig::js.
#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

#include "dsp/biquad.h"
#include "dsp/periodic_wave.h"
#include "time/param.h"

namespace rig::inst {

inline constexpr std::size_t kQuantum = wa::Param::kQuantum;

// ---- voice.js / synth.js / music.js scalar helpers (JS double arithmetic, rig::js math) --------------------------
double noteToFreq(double midi);                      // music.js: 440 * 2^((midi - 69) / 12)
double keytrack(double note, double ref, double amount);  // 2^(amount (note - ref) / 12)
double keyLevel(int note);                           // synth.js: -3 dB/oct above C4
double qDb(double q);                                // 20 log10(q)
double butter2Q();                                   // qDb(SQRT1_2)
double butter4Q(int stage);                          // qDb(.5412), qDb(1.3066)
double cents(double ratio);                          // 1200 log2(ratio)
double fmIndexCap(double sr, double f, double fm, double extraHz = 0, double edge = 0.45);
inline double clampd(double x, double lo, double hi) { return x < lo ? lo : (x > hi ? hi : x); }

/** voice.js softClipCurve(driveDb): 2049 points of tanh(g x) / tanh(g), centre exactly 0 (cached, immutable). */
const float *softClipCurve12();  // driveDb = EP_CLIP_DB = 12
inline constexpr std::size_t kSoftClipPoints = 2049;
/** voice.js softCeilingCurve(-1, -4, 4): 8193 points (addOutputCeiling defaults). */
const float *softCeilingCurve();
inline constexpr std::size_t kCeilingPoints = 8193;

// ---- wavetables -----------------------------------------------------------------------------------------------
enum WaveFamily : unsigned {
  kWaveSaw = 1u << 0,      // phaseRotatedSawWaves: 512 harmonics, 8 rotations
  kWaveGlass = 1u << 1,    // glassWaves: triangle + partials 2 / 3, 8 rotations
  kWaveSine = 1u << 2,     // sineWaves: 8 rotations of a sine
  kWaveTri = 1u << 3,      // triangleWaves: 63 harmonics, 8 rotations
  kWaveBasic = 1u << 4,    // OscillatorNode built-in 'sine' and 'triangle'
  kWaveAll = 0x1f
};
inline constexpr unsigned kRotations = 8;

/** The PeriodicWaves of one sample rate. Immutable once built; oscillators borrow the pointers. */
struct WaveBank {
  double sampleRate = 0;
  unsigned families = 0;
  std::array<std::unique_ptr<wa::PeriodicWave>, kRotations> saw, glass, sine, tri;
  std::unique_ptr<wa::PeriodicWave> basicSine, basicTriangle;
  ~WaveBank();

  /** Control thread: the bank for `sampleRate` holding at least `families` (shared, built on first use). */
  static std::shared_ptr<const WaveBank> get(double sampleRate, unsigned families);
  /** Drop the cached banks no instrument uses any more (memory pressure). */
  static void trim();
};

// ---- lean node models ------------------------------------------------------------------------------------------

/** StereoPannerNode with a constant pan on a mono input: L += x * gl, R += x * gr (summed into a stereo bus). */
struct ConstPan {
  float gl = 0, gr = 0;
  ConstPan() = default;
  explicit ConstPan(double pan);
  void addTo(const float *x, float *l, float *r, std::size_t n) const {
    for (std::size_t i = 0; i < n; ++i) {
      r[i] += x[i] * gr;
      l[i] += x[i] * gl;
    }
  }
};

/** BiquadFilterNode with k-rate frequency / detune and audio inputs on detune (synth.js linkFilter). */
class VoiceFilter {
 public:
  VoiceFilter() = default;
  /** `qParam` (optional, owned by the caller) makes Q automatable (warm-pad resonance); else Q is the constant. */
  void init(wa::BiquadType type, double freqHz, double q, wa::Param *qParam = nullptr);
  /** In place, nch channels; `detuneIn` = first frame of the detune input sum (cents) for this quantum. */
  void process(float *const *ch, unsigned nch, std::size_t n, std::int64_t frame0, double sr, float detuneIn);

 private:
  wa::BiquadType type_ = wa::BiquadType::Lowpass;
  float freq_ = 350, q_ = 1;
  wa::Param *qp_ = nullptr;
  unsigned channels_ = 0;
  wa::Biquad k_[2];
  wa::BiquadCoeffs var_[kQuantum];
};

/** Down-mix helpers (AudioNodeInput, channelInterpretation 'speakers'). */
inline void downmixToMono(const float *l, const float *r, float *out, std::size_t n) {
  for (std::size_t i = 0; i < n; ++i) out[i] = 0.5f * (l[i] + r[i]);
}

}  // namespace rig::inst
