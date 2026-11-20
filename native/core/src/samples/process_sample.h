// processSample (M10): the engine's post-decode step, a port of `processSample` / `limitMonoLoss` in
// app/js/engine/sampler.js (sections: onset trim, length cap + fade, dual-mono collapse added in 1.1, mono-loss
// limiter). Float32 arithmetic where the JS writes into Float32Arrays, doubles elsewhere.
#pragma once
#include <cstddef>
#include <vector>

namespace rig::samples {

inline constexpr double kOnsetDb = -50;
inline constexpr double kDualMonoRel = 1e-3;
inline constexpr double kDualMonoAbs = 1.0 / 4096.0;  // 2^-12
inline constexpr double kKeysMaxSec = 30;
inline constexpr double kMaxSecMin = 1, kMaxSecMax = 60;

/** The legacy decode cap (s): 10 s above middle C, 16 s at/below. */
inline double legacyCapSec(int midi) {
  return midi > 60 ? 10.0 : 16.0;
}

struct DecodeOpts {
  double maxSec = 0;         // > 0: decode length cap (sustain); 0 = the legacy 10 s / 16 s rule
  double maxMonoLossDb = 0;  // > 0 (stereo only): limit the mono-sum loss to this many dB
  bool hasMaxMonoLoss = false;
  bool operator==(const DecodeOpts &o) const {
    return maxSec == o.maxSec && maxMonoLossDb == o.maxMonoLossDb && hasMaxMonoLoss == o.hasMaxMonoLoss;
  }
};

struct MonoFix {
  double lossDb = 0, mid = 1, side = 1;
  bool applied = false;  // the JS `_monoFix` object was set (even with mid = side = 1)
};

struct Processed {
  std::vector<float> ch[2];
  int channels = 0;
  std::size_t frames = 0;
  bool dualMono = false;
  double lrDiff = 0;  // max |L - R| of the kept range; infinity = stopped early (real stereo); NaN = mono input
  bool hasLrDiff = false;
  double onsetTrim = 0;     // s
  std::size_t natural = 0;  // frames after the onset trim (uncapped)
  bool capped = false;
  MonoFix monoFix;
};

/** `in` = 1 or 2 channels of equal length at the engine rate. */
Processed processSample(const std::vector<float> *in, int channels, double sampleRate, int midi,
                        const DecodeOpts &opts);

/** In place; see JS `limitMonoLoss`. statsLen/fadeLen: measure over the first statsLen frames with a linear fade-out
 *  over the last fadeLen of them. */
MonoFix limitMonoLoss(float *L, float *R, std::size_t n, double capDb, std::size_t statsLen, std::size_t fadeLen);

}  // namespace rig::samples
