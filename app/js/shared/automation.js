// The ONLY sanctioned way to automate AudioParams (SPEC §0.2, REVIEW 1.1).
// Every helper anchors the timeline with cancel-and-hold first, so a new target never lands *before*
// a pending ramp end (the "release during attack doesn't release" bug). glideTo/linearTo additionally write
// setValueAtTime(from, when) so the ramp starts exactly at `when` (cancelAndHoldAtTime alone does not
// guarantee that in Chromium); pass `{from}` when scheduling ahead of the current time.
// `when` is AudioContext time in seconds; times earlier than currentTime (incl. 0) mean "now"
// (Web Audio clamps them). No Web Audio import: works on any object with the AudioParam methods.

/** Floor for exponential ramps (−80 dB). */
export const EXP_FLOOR = 1e-4;
/** Default smoothing time constant for continuous controls (SPEC §3.1: τ 15 ms). */
export const DEFAULT_TC = 0.015;

function t0(when) {
  return Number.isFinite(when) && when > 0 ? when : 0;
}

/**
 * Cancel everything scheduled at/after `when` and hold the value the param would have had at `when`.
 * Falls back to cancelScheduledValues + setValueAtTime(param.value) where cancelAndHoldAtTime is missing
 * (that fallback holds the *current* value, which is exact when `when` ≈ now).
 * @param {AudioParam} param
 * @param {number} when
 */
export function cancelAndHold(param, when) {
  const t = t0(when);
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(t);
  } else {
    const v = param.value;
    param.cancelScheduledValues(t);
    param.setValueAtTime(v, t);
  }
}

/**
 * rampTo pins the param at its target this many time constants after the start (idle-cpu #3). The step left is
 * e^−12 ≈ 6.1e-6 of the move: −104 dB of a gain change, 0.007 ¢ of a 12-semitone detune move.
 */
export const RAMP_SETTLE_TC = 12;

/**
 * Smooth exponential approach (setTargetAtTime) from whatever the param is doing at `when`, then
 * setValueAtTime(value) at `when + RAMP_SETTLE_TC × timeConstant` (idle-cpu #3, reviews/idle-cpu.md). A SetTarget
 * event never ends in Chromium: long after it has converged the param still counts as automated, so a
 * BiquadFilter keeps recomputing its coefficients every sample (measured: 60 converged peaking biquads cost 1.6×
 * their static cost; k-rate does not help) and a GainNode at 0 never flags its output silent, which keeps
 * everything downstream running (a converged gain 0 in front of a convolver kept it busy forever, 13 % of a core
 * against 2.5 % with the pin). The pin ends the automation; any later helper call cancels it (cancelAndHold).
 * @param {AudioParam} param
 * @param {number} value
 * @param {number} when
 * @param {number} [timeConstant=0.015] seconds; <= 0 means an instant set
 * @returns {boolean} false (and no-op) when value is not finite
 */
export function rampTo(param, value, when, timeConstant = DEFAULT_TC) {
  if (!Number.isFinite(value)) return false;
  const t = t0(when);
  cancelAndHold(param, t);
  if (Number.isFinite(timeConstant) && timeConstant > 0) {
    param.setTargetAtTime(value, t, timeConstant);
    param.setValueAtTime(value, t + RAMP_SETTLE_TC * timeConstant);
  } else param.setValueAtTime(value, t);
  return true;
}

/**
 * Start value for glideTo/linearTo: the caller's `from` when finite, else `param.value`.
 * `param.value` is the param's value at the context's *current* render time, so it is exact only when
 * `when` ≈ now. For a ramp scheduled in the future (offline rendering, anything behind a lookahead, or a
 * ramp that interrupts another scheduled ramp) engine code must pass the value it tracks via `{from}`.
 * @param {AudioParam} param
 * @param {{from?:number}} [opts]
 * @returns {number} NaN when neither is available (then no anchor is written)
 */
function startValue(param, opts) {
  const f = opts ? opts.from : undefined;
  if (Number.isFinite(f)) return f;
  const v = param.value;
  return Number.isFinite(v) ? v : NaN;
}

/**
 * Exponential glide (pitch/gain) reaching `value` at `when + duration`.
 * Anchored: after cancel-and-hold it always writes `setValueAtTime(from, when)`, because Chromium's
 * cancelAndHoldAtTime inserts no hold when no event spans `when` (fresh param, after a completed ramp or a
 * setValueAtTime earlier than `when`) and a ramp would otherwise start at the *previous* event — or at 0 after a
 * setTargetAtTime (verified in Chromium 1194). `from` defaults to `param.value` (see startValue): pass
 * `{from}` whenever `when` is not "now" and you know the value at `when`.
 * Strictly-positive params only: if the target or the start value is negative it falls back to linearTo.
 * A start value <= 1e-4 is lifted to 1e-4 (an exponential ramp from 0 is undefined).
 * A target <= 1e-4 ramps to 1e-4 and then sets exactly `value` at the end.
 * @param {AudioParam} param
 * @param {number} value
 * @param {number} when
 * @param {number} duration seconds; <= 0 means setNow
 * @param {{from?:number}} [opts] from: the param's value at `when`, if the caller knows it
 * @returns {boolean} false (and no-op) when value is not finite
 */
export function glideTo(param, value, when, duration, opts) {
  if (!Number.isFinite(value)) return false;
  const t = t0(when);
  if (!(Number.isFinite(duration) && duration > 0)) return setNow(param, value, t);
  const from = startValue(param, opts);
  if (value < 0 || from < 0) return linearTo(param, value, t, duration, { from });
  cancelAndHold(param, t);
  param.setValueAtTime(from > EXP_FLOOR ? from : EXP_FLOOR, t);
  param.exponentialRampToValueAtTime(Math.max(value, EXP_FLOOR), t + duration);
  if (value < EXP_FLOOR) param.setValueAtTime(value, t + duration);
  return true;
}

/**
 * Linear ramp reaching `value` at `when + duration`, starting at `when` from `from` (default `param.value`).
 * Anchored with setValueAtTime(from, when) after cancel-and-hold — same reason and same `from` rule as glideTo.
 * @param {AudioParam} param
 * @param {number} value
 * @param {number} when
 * @param {number} duration seconds; <= 0 means setNow
 * @param {{from?:number}} [opts] from: the param's value at `when`, if the caller knows it
 * @returns {boolean}
 */
export function linearTo(param, value, when, duration, opts) {
  if (!Number.isFinite(value)) return false;
  const t = t0(when);
  if (!(Number.isFinite(duration) && duration > 0)) return setNow(param, value, t);
  const from = startValue(param, opts);
  cancelAndHold(param, t);
  if (Number.isFinite(from)) param.setValueAtTime(from, t);
  param.linearRampToValueAtTime(value, t + duration);
  return true;
}

/**
 * Instant set at `when` (after cancel-and-hold, so later scheduled events are cleared).
 * Use only where a step is inaudible (e.g. param of a silent voice).
 * @param {AudioParam} param
 * @param {number} value
 * @param {number} when
 * @returns {boolean}
 */
export function setNow(param, value, when) {
  if (!Number.isFinite(value)) return false;
  const t = t0(when);
  cancelAndHold(param, t);
  param.setValueAtTime(value, t);
  return true;
}

/**
 * Time constant for a release defined as time-to-−60 dB: τ = release / 6.9 (ln 1000 ≈ 6.908).
 * @param {number} releaseSeconds
 * @returns {number} seconds (0 for non-positive input)
 */
export function releaseTau(releaseSeconds) {
  return releaseSeconds > 0 ? releaseSeconds / 6.9 : 0;
}

/**
 * When to stop() a source released at `when`: when + release × 1.3.
 * @param {number} when
 * @param {number} release seconds
 * @returns {number}
 */
export function stopAfterRelease(when, release) {
  return when + Math.max(0, release) * 1.3;
}

/**
 * Equal-power fade curve for setValueCurveAtTime: in = sin(x·π/2), out = cos(x·π/2), x ∈ [0,1].
 * Endpoints are exact (in: 0→1, out: 1→0).
 * @param {number} [n=64] points (min 2)
 * @param {'in'|'out'} [direction='in']
 * @returns {Float32Array}
 */
export function equalPowerCurve(n = 64, direction = 'in') {
  const len = Math.max(2, Math.floor(Number.isFinite(n) ? n : 64));
  const out = new Float32Array(len);
  const fadeOut = direction === 'out';
  for (let i = 0; i < len; i++) {
    const x = (i / (len - 1)) * (Math.PI / 2);
    out[i] = fadeOut ? Math.cos(x) : Math.sin(x);
  }
  out[0] = fadeOut ? 1 : 0;
  out[len - 1] = fadeOut ? 0 : 1;
  return out;
}
/** SPEC §1 name. */
export const fadeCurveEqualPower = equalPowerCurve;

/**
 * Fade to 0 from the held value with τ = fadeSec/4 (≈ −35 dB after fadeSec).
 * @param {AudioParam} param
 * @param {number} when
 * @param {number} fadeSec
 * @returns {boolean}
 */
export function holdAndFade(param, when, fadeSec) {
  return rampTo(param, 0, when, Math.max(0, fadeSec) / 4);
}
