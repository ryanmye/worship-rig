// Key-sensitivity ("touch") curves and the expression-pedal taper (v11-touch). Pure: no DOM, no Web Audio.
//
// A touch curve maps a MIDI velocity 0..127 to the 0..1 level an instrument gets:
//   x = clamp(vel / top, 0, 1),  y = min + (max − min) · x^shape
// shape = the exponent (< 1 lighter: soft playing still sounds full; > 1 heavier: dig in for full volume), min / max =
// the quietest / loudest output, top = the velocity that already reaches `max` (a light-touch board that never sends
// 127 can still reach full volume). The four named curves of SPEC §2 Slot.velocityCurve are exact special cases, so
// curveVelocity() of engine/audio.js returns bit-identical values for them (v11-touch "old libraries unchanged").
//
// Engine use: compileTouch() once per configuration change, touchAt() per note: no allocation, one Math.pow.

/** Field ranges of a touch spec (the PARAMS rows `slots.<i>.touch.*` use the same numbers). */
export const TOUCH_RANGE = Object.freeze({
  shape: Object.freeze({ min: 0.25, max: 4, default: 1 }),
  min: Object.freeze({ min: 0, max: 1, default: 0 }),
  max: Object.freeze({ min: 0, max: 1, default: 1 }),
  top: Object.freeze({ min: 20, max: 127, default: 127 }),
});
/** Spec fields, in display order. */
export const TOUCH_KEYS = Object.freeze(['shape', 'min', 'max', 'top']);

/**
 * The named curves as specs (SPEC §2): soft = v^0.6, normal = v, hard = v^1.6, fixed = 100/127 for every note.
 * @type {Readonly<Record<'soft'|'normal'|'hard'|'fixed', Readonly<{shape:number,min:number,max:number,top:number}>>>}
 */
export const TOUCH_PRESETS = Object.freeze({
  soft: Object.freeze({ shape: 0.6, min: 0, max: 1, top: 127 }),
  normal: Object.freeze({ shape: 1, min: 0, max: 1, top: 127 }),
  hard: Object.freeze({ shape: 1.6, min: 0, max: 1, top: 127 }),
  fixed: Object.freeze({ shape: 1, min: 100 / 127, max: 100 / 127, top: 127 }),
});

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clampTo = (v, r) => (fin(v) ? Math.min(r.max, Math.max(r.min, v)) : r.default);

/**
 * A complete, clamped spec from a partial one (missing / invalid fields take the defaults; top is a whole velocity).
 * @param {object} [raw]
 * @returns {{shape:number, min:number, max:number, top:number}}
 */
export function normalizeTouch(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    shape: clampTo(r.shape, TOUCH_RANGE.shape),
    min: clampTo(r.min, TOUCH_RANGE.min),
    max: clampTo(r.max, TOUCH_RANGE.max),
    top: Math.round(clampTo(r.top, TOUCH_RANGE.top)),
  };
}

/**
 * @typedef {Readonly<{g:number, lo:number, span:number, top:number, linear:boolean}>} CompiledTouch
 *   g = exponent, lo = output at x = 0, span = max − lo (≥ 0), top = full-scale velocity, linear: g === 1
 */

/**
 * Pre-compute a curve for touchAt(). A min above max is swapped (the curve never runs backwards: harder never plays
 * quieter); the UI keeps them ordered anyway.
 * @param {object} spec  {shape, min, max, top} (partial: defaults fill in)
 * @returns {CompiledTouch}
 */
export function compileTouch(spec) {
  const s = normalizeTouch(spec);
  const lo = Math.min(s.min, s.max);
  const hi = Math.max(s.min, s.max);
  return Object.freeze({ g: s.shape, lo, span: hi - lo, top: s.top, linear: s.shape === 1 });
}

/** Compiled named curves (shared, frozen: the engine hands the same object to every note). */
export const COMPILED_PRESETS = Object.freeze(Object.fromEntries(
  Object.entries(TOUCH_PRESETS).map(([k, v]) => [k, compileTouch(v)]),
));
/** The identity curve (velocity / 127). */
export const LINEAR_TOUCH = COMPILED_PRESETS.normal;

/**
 * Level 0..1 for a velocity on a compiled curve. Allocation-free (per-note hot path). For the named curves it equals
 * the SPEC §2 formulas exactly: x = vel / 127 (a division, as before), 0 + 1 · y = y, and y = x when shape is 1.
 * @param {CompiledTouch} c
 * @param {number} vel127
 * @returns {number}
 */
export function touchAt(c, vel127) {
  let x = (Number(vel127) || 0) / c.top;
  if (x > 1) x = 1;
  else if (!(x > 0)) x = 0;
  return c.lo + c.span * (c.linear ? x : Math.pow(x, c.g));
}

/**
 * True when a spec is (within rounding) one of the named curves; returns that name, else null.
 * @param {object} spec
 * @returns {'soft'|'normal'|'hard'|'fixed'|null}
 */
export function presetOf(spec) {
  const s = normalizeTouch(spec);
  for (const [k, p] of Object.entries(TOUCH_PRESETS)) {
    if (k === 'fixed') {
      if (Math.abs(s.min - p.min) < 1e-3 && Math.abs(s.max - p.max) < 1e-3) return k;
      continue;
    }
    if (Math.abs(s.shape - p.shape) < 1e-3 && s.min < 1e-3 && s.max > 1 - 1e-3 && s.top === 127) return k;
  }
  return null;
}

/**
 * One word for a curve's feel (UI): 'Light' (shape < 0.8), 'Even', 'Heavy' (shape > 1.25), 'Fixed' (min = max).
 * @param {object} spec
 * @returns {string}
 */
export function touchWord(spec) {
  const s = normalizeTouch(spec);
  if (Math.abs(s.max - s.min) < 1e-3) return 'Fixed';
  if (s.shape < 0.8) return 'Light';
  if (s.shape > 1.25) return 'Heavy';
  return 'Even';
}

// ---------------------------------------------------------------------------------------------------------------
// "Play soft, then hard" calibration

/** Level a soft note should get after fitting (a normal player's soft playing, ~40 / 127, on the linear curve). */
export const FIT_SOFT_TARGET = 0.3;
/** Notes per step of the guided calibration. */
export const FIT_NOTES = 6;
/** Fewest notes per step fitTouch() accepts. */
export const FIT_MIN_NOTES = 3;
/** Soft and hard medians closer than this (velocity steps) cannot be told apart. */
export const FIT_MIN_SPREAD = 8;

const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const velocities = (a) => (Array.isArray(a) ? a : []).map(Number).filter((v) => v >= 1 && v <= 127);

/**
 * Fit a curve to the player's touch: their hard playing (median) reaches the loudest output (top = that velocity),
 * and their soft playing (median) lands on FIT_SOFT_TARGET of the output range, by choosing the exponent. min / max
 * are kept from `base` (the curve being replaced), so a floor the player set survives a re-fit.
 * @param {number[]} soft  velocities of the "play softly" notes
 * @param {number[]} hard  velocities of the "play hard" notes
 * @param {object} [base]  current spec (min / max kept)
 * @returns {{ok:true, touch:{shape:number,min:number,max:number,top:number}, soft:number, hard:number}
 *          |{ok:false, reason:'few'|'same', soft:number|null, hard:number|null}}
 */
export function fitTouch(soft, hard, base) {
  const s = velocities(soft);
  const hd = velocities(hard);
  const sm = s.length ? median(s) : null;
  const hm = hd.length ? median(hd) : null;
  if (s.length < FIT_MIN_NOTES || hd.length < FIT_MIN_NOTES) return { ok: false, reason: 'few', soft: sm, hard: hm };
  if (hm - sm < FIT_MIN_SPREAD) return { ok: false, reason: 'same', soft: sm, hard: hm };
  const b = normalizeTouch(base);
  const top = Math.round(clampTo(hm, TOUCH_RANGE.top));
  const x = Math.min(0.98, Math.max(0.02, sm / top));
  const lo = Math.min(b.min, b.max);
  const span = Math.max(b.min, b.max) - lo;
  // where the soft notes should land inside [lo, lo + span]; a floor above the target leaves the exponent neutral
  const want = span > 1e-6 ? Math.min(0.95, Math.max(0.05, (FIT_SOFT_TARGET - lo) / span)) : FIT_SOFT_TARGET;
  const g = Math.log(want) / Math.log(x);
  const shape = Math.round(clampTo(g, TOUCH_RANGE.shape) * 1000) / 1000;
  return { ok: true, touch: { shape, min: b.min, max: b.max, top }, soft: sm, hard: hm };
}

// ---------------------------------------------------------------------------------------------------------------
// Expression pedal taper

/** patch.expression.curve values (absent = 'linear', today's behaviour). */
export const PEDAL_CURVES = Object.freeze(['linear', 'log']);
/** Decades of the 'log' (audio) taper: half travel ≈ −20 dB below the top, like an audio-taper volume pedal. */
const LOG_DECADES = 2;
const LOG_NORM = Math.pow(10, LOG_DECADES) - 1;

/**
 * Pedal position 0..1 → control amount 0..1. 'linear' = the position (bit-exact); 'log' = (10^(2x) − 1) / 99: fine
 * control at the quiet end, 0 at heel and 1 at toe either way.
 * @param {number} x01
 * @param {'linear'|'log'|string} [curve]
 * @returns {number}
 */
export function pedalCurve(x01, curve) {
  if (curve !== 'log') return x01;
  const x = x01 > 1 ? 1 : x01 > 0 ? x01 : 0;
  return (Math.pow(10, LOG_DECADES * x) - 1) / LOG_NORM;
}
