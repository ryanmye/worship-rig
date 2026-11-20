// Slot width (contract 3.2; fx.js Channel, fx.js:1996-2064): M = speakers down-mix ((L+R)/2; x itself for mono),
// S = x - M (0 for mono), out = x + (min(w,1)-1) S + max(w-1,0) HPF2(150 Hz, Butterworth)(S). The two side gains are
// a-rate GainNodes (StripParam kStripWidthNarrow / kStripWidthWide), the side HPF a fixed BiquadFilterNode. A mono
// input stays mono (the panner keeps its mono law); w = 1 is the exact identity. RT-safe.
#pragma once
#include <cstddef>
#include <cstdint>

#include "dsp/biquad.h"
#include "dsp/gain.h"

namespace rig {

class Width {
 public:
  static constexpr double kSideHpHz = 150.0;
  static constexpr double kMax = 2.25;  // effective width clamp (fx.js setWidth)

  Width();
  /** Gains for an effective width (narrow = min(w,1)-1, wide = max(0, w-1), w clamped to 0..2.25). */
  static void gainsFor(double w, double &narrow, double &wide);
  wa::Param &narrow() { return narrow_.gain(); }
  wa::Param &wide() { return wide_.gain(); }
  /** setWidth(w, when, step): step = setNow, else rampTo tau 15 ms. `nowFrame` = context frame of the call. */
  void setWidth(double w, double when, bool step, std::int64_t nowFrame, double sr);
  /** In place over `nch` (1|2) channels. */
  void process(float *const *ch, unsigned nch, std::size_t n, std::int64_t frame0, double sr);

 private:
  wa::Gain narrow_, wide_;
  wa::BiquadFilter hp_;
};

}  // namespace rig
