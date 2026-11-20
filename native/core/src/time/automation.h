// Ports of the AudioParam helpers the engine is allowed to use (CLAUDE.md "No direct AudioParam automation"):
// app/js/shared/automation.js (setNow, rampTo, glideTo, linearTo, holdAndFade, cancelAndHold, releaseTau,
// stopAfterRelease, equalPowerCurve) and the engine helpers of app/js/engine/fx.js (linFrom, glideFrom, moveAt,
// trackedMove, equalPowerFade with its 16 linear segments). Same calls in the same order on wa::Param as the JS makes
// on an AudioParam, so a native render matches Chromium sample by sample (tests/time_automation_test.cpp replays
// tools/golden/vectors/data/automation.txt). `when` is engine time; non-finite or <= 0 means "now" (0, clamped to the
// render time by the Param, as Web Audio does). Return values follow the JS (false = rejected, nothing scheduled).
// The helpers are templates over the param type: wa::Param, or any proxy with the same six timeline methods plus
// intrinsic() (e.g. a Model-side object that turns each call into a Command for the audio thread).
#pragma once
#include <cmath>
#include <cstddef>
#include <limits>

#include "num/js_math.h"
#include "time/param.h"

namespace rig::wa {

inline constexpr double kRampSettleTc = 12.0;  // RAMP_SETTLE_TC (automation.js:40)
inline constexpr double kDefaultTc = 0.015;    // DEFAULT_TC (automation.js:12)
inline constexpr double kTau = 0.015;          // fx.js TAU
inline constexpr double kExpFloor = 1e-4;      // EXP_FLOOR (automation.js:9)

namespace detail {
inline double t0(double when) { return std::isfinite(when) && when > 0 ? when : 0.0; }
/** startValue(): the caller's `from` when finite, else param.value (the intrinsic value), else NaN. */
template <class P>
inline double startValue(const P &p, double from) {
  if (std::isfinite(from)) return from;
  const double v = p.intrinsic();
  return std::isfinite(v) ? v : std::numeric_limits<double>::quiet_NaN();
}
}  // namespace detail

/** "No `{from}`": glideTo/linearTo then start from param.value, exact only when `when` ≈ now (CLAUDE.md). */
inline constexpr double kNoFrom = std::numeric_limits<double>::quiet_NaN();

/** cancelAndHold(param, when) */
template <class P>
inline void cancelAndHold(P &p, double when) { p.cancelAndHoldAtTime(detail::t0(when)); }

/** setNow: cancelAndHold(t) + setValueAtTime(v, t). */
template <class P>
inline bool setNow(P &p, double value, double when) {
  if (!std::isfinite(value)) return false;
  const double t = detail::t0(when);
  cancelAndHold(p, t);
  p.setValueAtTime(value, t);
  return true;
}

/** rampTo: cancelAndHold(t) + setTargetAtTime(v, t, tc) + setValueAtTime(v, t + 12 tc) (the pinned end, Q2). */
template <class P>
inline bool rampTo(P &p, double value, double when, double timeConstant = kDefaultTc) {
  if (!std::isfinite(value)) return false;
  const double t = detail::t0(when);
  cancelAndHold(p, t);
  if (std::isfinite(timeConstant) && timeConstant > 0) {
    p.setTargetAtTime(value, t, timeConstant);
    p.setValueAtTime(value, t + kRampSettleTc * timeConstant);
  } else {
    p.setValueAtTime(value, t);
  }
  return true;
}

/** linearTo(param, value, when, duration, {from}) */
template <class P>
inline bool linearTo(P &p, double value, double when, double duration, double from = kNoFrom) {
  if (!std::isfinite(value)) return false;
  const double t = detail::t0(when);
  if (!(std::isfinite(duration) && duration > 0)) return setNow(p, value, t);
  const double f = detail::startValue(p, from);
  cancelAndHold(p, t);
  if (std::isfinite(f)) p.setValueAtTime(f, t);
  p.linearRampToValueAtTime(value, t + duration);
  return true;
}

/** glideTo(param, value, when, duration, {from}): exponential, floor 1e-4, linear when either end is negative. */
template <class P>
inline bool glideTo(P &p, double value, double when, double duration, double from = kNoFrom) {
  if (!std::isfinite(value)) return false;
  const double t = detail::t0(when);
  if (!(std::isfinite(duration) && duration > 0)) return setNow(p, value, t);
  const double f = detail::startValue(p, from);
  if (value < 0 || f < 0) return linearTo(p, value, t, duration, f);
  cancelAndHold(p, t);
  p.setValueAtTime(f > kExpFloor ? f : kExpFloor, t);
  p.exponentialRampToValueAtTime(value > kExpFloor ? value : kExpFloor, t + duration);
  if (value < kExpFloor) p.setValueAtTime(value, t + duration);
  return true;
}

/** Time constant for a release given as time to −60 dB: τ = release / 6.9. */
inline double releaseTau(double releaseSeconds) { return releaseSeconds > 0 ? releaseSeconds / 6.9 : 0; }
/** When to stop() a source released at `when`: when + release × 1.3. */
inline double stopAfterRelease(double when, double release) { return when + (release > 0 ? release : 0) * 1.3; }

/** holdAndFade: rampTo(0) with τ = fadeSec / 4. */
template <class P>
inline bool holdAndFade(P &p, double when, double fadeSec) {
  return rampTo(p, 0, when, (fadeSec > 0 ? fadeSec : 0) / 4);
}

/** equalPowerCurve(n, 'in'|'out') into out[] (Float32Array); returns the length used (min 2). */
inline std::size_t equalPowerCurve(float *out, std::size_t n, bool fadeOut) {
  const std::size_t len = n < 2 ? 2 : n;
  for (std::size_t i = 0; i < len; ++i) {
    const double x = (static_cast<double>(i) / static_cast<double>(len - 1)) * (js::kPi / 2);
    out[i] = static_cast<float>(fadeOut ? js::cos(x) : js::sin(x));
  }
  out[0] = fadeOut ? 1.0f : 0.0f;
  out[len - 1] = fadeOut ? 0.0f : 1.0f;
  return len;
}

// ---- fx.js engine helpers ----------------------------------------------------------------------------------------

/** linFrom: setNow(from, when) then linearTo(to, when, dur, {from}) (cancelAndHold inserts no hold after a completed
 *  ramp, so the anchor is needed, fx.js:37). */
template <class P>
inline bool linFrom(P &p, double from, double to, double when, double dur) {
  setNow(p, from, when);
  return linearTo(p, to, when, dur, from);
}
/** glideFrom: setNow(from, when) then glideTo(to, when, dur, {from}). */
template <class P>
inline bool glideFrom(P &p, double from, double to, double when, double dur) {
  setNow(p, from, when);
  return glideTo(p, to, when, dur, from);
}

/** A recorded move (fx.js trackedMove / moveAt): linear over dur, or rampTo's approach with time constant tc. */
struct Move {
  double from = 0, to = 0, t0 = 0, dur = 0, tc = 0;
  bool valid = false;
};

/** moveAt(m, t, fallback): where the recorded move is at time t. */
inline double moveAt(const Move &m, double t, double fallback) {
  if (!m.valid) return fallback;
  if (t <= m.t0) return m.from;
  if (m.tc > 0) return t >= m.t0 + 12 * m.tc ? m.to : m.to + (m.from - m.to) * js::exp(-(t - m.t0) / m.tc);
  if (!(m.dur > 0) || t >= m.t0 + m.dur) return m.to;
  return m.from + (m.to - m.from) * ((t - m.t0) / m.dur);
}

/** trackedMove glide argument 'set' (a fresh, silent channel). */
inline constexpr double kGlideSet = -1.0;

/** trackedMove(param, m, to, when, glide, fallback): glide > 0 linear from the tracked value; 0 rampTo (τ 15 ms);
 *  kGlideSet setNow. Returns the move to record. */
template <class P>
inline Move trackedMove(P &p, const Move &m, double to, double when, double glide, double fallback) {
  const double from = moveAt(m, when, fallback);
  Move r;
  r.valid = true;
  r.to = to;
  r.t0 = when;
  if (glide == kGlideSet) {
    setNow(p, to, when);
    r.from = to;
    return r;
  }
  r.from = from;
  if (glide > 0) {
    linFrom(p, from, to, when, glide);
    r.dur = glide;
    return r;
  }
  rampTo(p, to, when, kTau);
  r.tc = kTau;
  return r;
}

/** equalPowerFade: piecewise-linear through sin (fade in) / cos (fade out), `segs` segments (default 16, Q4). */
template <class P>
inline bool equalPowerFade(P &p, double from, double to, double when, double dur, int segs = 16) {
  if (!(dur > 0)) return setNow(p, to, when);
  setNow(p, from, when);  // anchor (see linFrom)
  const bool up = to >= from;
  const double d = dur / segs;
  double prev = from;
  for (int k = 1; k <= segs; ++k) {
    const double x = (static_cast<double>(k) / segs) * (js::kPi / 2);
    const double v = k == segs ? to : up ? from + (to - from) * js::sin(x) : to + (from - to) * js::cos(x);
    linearTo(p, v, when + (k - 1) * d, d, prev);  // each segment starts where the previous ended
    prev = v;
  }
  return true;
}

}  // namespace rig::wa
