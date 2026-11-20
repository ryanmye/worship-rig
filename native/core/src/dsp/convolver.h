// wa::Convolver: zero-latency non-uniformly partitioned convolution (NUPOLS, ARCHITECTURE section 4) with the
// semantics of Chromium's ConvolverNode / Reverb (third_party/blink/renderer/platform/audio/reverb.cc, Chromium
// 157.0.8103.78, BSD-3, licence in third_party/chromium/LICENSE): an exact linear convolution with the whole impulse
// response, no latency, an optional normalisation scale (`chromiumNormalizationScale`, Reverb's
// CalculateNormalizationScale; ConvolverNode `disableNormalization: true` = scale 1, which is what the engine uses).
//
// Partitioning (time-distributed on the audio thread, FFTs by pffft):
//   direct FIR           taps [0, 128)
//   stage 1  B = 128     taps [128, 2048)    FFT 256, computed in the quantum after its input block
//   stage 2  B = 1024    taps [2048, 16384)  FFT 2048, spread over the 8 quanta after its input block
//   stage 3  B = 8192    taps [16384, len)   FFT 16384, spread over the 64 quanta after its input block
// Stage s (s >= 2) starts at tap 2 B_s, so its forward FFT, its partition MACs and its inverse FFT can be spread over
// the B_s / 128 quanta that follow the block (one FFT, one IFFT and about P / (B_s / 128 - 2) MACs per quantum).
// A `phase` staggers the stage periods between instances (the two channels of a stereo IR) so the big FFTs of the
// channels never land in the same quantum; the output does not depend on it beyond float rounding.
//
// ConvolverKernel is immutable once built (control thread / IR worker; shared by instances). Convolver is the
// running state of one channel; it is allocated on the control side and process() is RT-safe (no allocation, no
// locks; pffft work buffers are preallocated).
#pragma once
#include <cstddef>
#include <cstdint>
#include <memory>

namespace rig::wa {

class ConvolverKernel {
 public:
  static constexpr std::size_t kDirectTaps = 128;
  static constexpr unsigned kStages = 3;
  struct Stage {
    std::size_t start = 0;   // first tap
    unsigned block = 0;      // partition size B (FFT size 2B)
    unsigned parts = 0;      // partitions (0 = stage unused)
    float *spectra = nullptr;  // parts x 2B floats, pffft z-domain order, pre-scaled by scale / 2B
  };

  /** One channel of an impulse response; `scale` multiplies it (Chromium applies the normalisation scale to the
   *  kernel the same way). Allocates. */
  ConvolverKernel(const float *ir, std::size_t length, float scale = 1.0f);
  ~ConvolverKernel();
  ConvolverKernel(const ConvolverKernel &) = delete;
  ConvolverKernel &operator=(const ConvolverKernel &) = delete;

  std::size_t length() const { return length_; }
  /** Heap bytes held (spectra + direct taps). */
  std::size_t bytes() const { return bytes_; }
  const float *direct() const { return direct_; }
  std::size_t directTaps() const { return directTaps_; }
  const Stage &stage(unsigned s) const { return stages_[s]; }

 private:
  std::size_t length_ = 0, directTaps_ = 0, bytes_ = 0;
  float direct_[kDirectTaps] = {};
  Stage stages_[kStages];
};

class Convolver {
 public:
  static constexpr std::size_t kQuantum = 128;

  /** Running state for `kernel` (which must outlive it). Allocates and zeroes (control side). */
  explicit Convolver(const ConvolverKernel &kernel, unsigned phase = 0);
  ~Convolver();
  Convolver(const Convolver &) = delete;
  Convolver &operator=(const Convolver &) = delete;

  /** out[0..128) = the next 128 output frames for input in[0..128) (out is overwritten; in and out may alias). */
  void process(const float *in, float *out);
  /** Forget all history (control side, or the audio thread for a short kernel). */
  void reset();
  const ConvolverKernel &kernel() const { return k_; }
  /** Heap bytes of this state. */
  std::size_t bytes() const { return bytes_; }
  /** After this many frames of exactly-zero input the state is all zeros and the output is exactly zero, so a
   *  caller may skip process() until the input is non-zero again (the result is unchanged). */
  std::size_t tailFrames() const { return tail_; }

 private:
  struct StageState {
    float *in = nullptr;   // 2B: [previous block | block being filled]
    float *fdl = nullptr;  // parts x 2B: spectra of the last `parts` input windows (ring)
    float *acc = nullptr;  // 2B: spectrum accumulator
    float *ready = nullptr;  // B: output block being played
    unsigned fdlPos = 0, step = 0, quanta = 1;
  };
  void runStage(unsigned s, const float *in, float *out);
  void mac(unsigned s, unsigned from, unsigned to);

  const ConvolverKernel &k_;
  StageState st_[ConvolverKernel::kStages];
  float hist_[2 * kQuantum] = {};  // direct FIR input history: [previous quantum | current]
  float *work_ = nullptr;          // pffft work + IFFT scratch (2 x the largest FFT)
  std::size_t bytes_ = 0, tail_ = 0;
};

/** Reverb::CalculateNormalizationScale (reverb.cc): 1 / RMS power of all channels (floor 0.000125), x
 *  10^(-58 / 20) (fdlibm::powf, as Blink), x 44100 / sampleRate, x 0.5 for a 4-channel response. */
float chromiumNormalizationScale(const float *const *channels, unsigned numChannels, std::size_t length,
                                 double sampleRate);

}  // namespace rig::wa
