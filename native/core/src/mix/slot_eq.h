// Slot EQ: resolved spec (port of fx.js resolveSlotEq b-rows) and the RT filter chain (lc, b1..b8, hc).
// T00 limits: legacy low/mid/high rows are not read; a spec change is a hard switch (no 50 ms warm + 30 ms crossfade,
// no per-parameter glide). T02 replaces this file's implementation behind the same two classes.
#pragma once
#include <cstddef>

#include "dsp/biquad.h"

namespace rig {

inline constexpr int kEqBands = 8;
enum EqBandType { EqOff = 0, EqLowshelf, EqPeak, EqHighshelf, EqNotch, EqLowcut, EqHighcut };

struct EqBand {
  bool on = false;
  int type = EqPeak;
  double hz = 1000, db = 0, q = 0.707;
};

struct SlotEqSpec {
  EqBand bands[kEqBands];
  double cutHz = 20, hiCutHz = 20000;
};

/** A wired filter (what slotEqMembers + eqSpec produce). */
struct EqFilter {
  wa::BiquadType type;
  double hz, q, db;
};

inline constexpr std::size_t kMaxEqFilters = kEqBands + 2;

/** Filters of a spec in chain order; returns the count. */
std::size_t buildEqChain(const SlotEqSpec &spec, EqFilter out[kMaxEqFilters]);

/** RT chain for up to two channels with per-channel state; configure() keeps state when the filter types match. */
class SlotEq {
 public:
  void configure(const SlotEqSpec &spec, double sampleRate);
  /** In-place over `nch` channels of n frames. */
  void process(float *const *ch, int nch, std::size_t n);
  std::size_t filters() const { return count_; }

 private:
  EqFilter f_[kMaxEqFilters];
  wa::Biquad bq_[2][kMaxEqFilters];
  std::size_t count_ = 0;
};

}  // namespace rig
