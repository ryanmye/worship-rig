// Ports of the smoothing primitives in app/js/shared/automation.js that the Model emits as Param events.
// T00 provides the three the contract names; T01 owns the full set (glideTo, linFrom/glideFrom, equalPowerFade).
#pragma once
#include "time/param.h"

namespace rig::wa {

inline constexpr double kRampSettleTc = 12.0;  // RAMP_SETTLE_TC (automation.js:40)
inline constexpr double kTau = 0.015;          // fx.js TAU

/** setNow: cancelAndHold(t) + set(v, t). */
inline void setNow(Param &p, double v, double t) {
  p.cancelAndHoldAtTime(t);
  p.setValueAtTime(v, t);
}

/** rampTo: cancelAndHold(t) + setTarget(v, t, tau) + set(v, t + 12 tau): the "pinned end". */
inline void rampTo(Param &p, double v, double t, double tau = kTau) {
  p.cancelAndHoldAtTime(t);
  p.setTargetAtTime(v, t, tau);
  p.setValueAtTime(v, t + kRampSettleTc * tau);
}

/** linearTo from an explicit start value (the `{from}` rule of CLAUDE.md). */
inline void linearTo(Param &p, double from, double v, double t, double dur) {
  setNow(p, from, t);
  p.linearRampToValueAtTime(v, t + dur);
}

}  // namespace rig::wa
