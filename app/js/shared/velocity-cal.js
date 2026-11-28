// Per-keyboard velocity calibration, Pianoteq's model (TOUCH, DECISIONS D43). Pure: no DOM, no Web Audio.
//
// A calibration curve maps the velocity a keyboard sends (0..127) to the velocity Rig plays (0..127), piecewise
// linear through 2..12 points. It is stored as {in: number[], out: number[]} and written in Pianoteq's text format
//   Velocity = [in1, in2, …; out1, out2, …]
// so the community curves made for Pianoteq paste in as they are (the FP-10 example of native/docs/lanes/IO-2.0.md:
// `Velocity = [0, 1, 18, 32, 50, 108, 127; 0, 0, 30, 57, 84, 127, 127]`). Inputs rise strictly, outputs never fall
// (harder never plays quieter); below the first point and above the last the curve stays flat. An output of 0 is a
// silent note (Pianoteq: velocity 0 out = no sound; MIDI: a note-on with velocity 0 is a note-off).
//
// The controller applies it before the engine (controller.js noteOnFrom): the engine then gets the calibrated
// velocity on the linear curve, so app/js/engine is unchanged and it works the same on the web and the 2.0 engine.
// The output is rounded to a whole velocity because the 2.0 bridge carries integers (bridge-engine.js noteOn).
import { normalizeTouch, compileTouch, touchAt } from './touch-curve.js';

/** Fewest / most points of a curve (IO-2.0 "Lane TOUCH"). */
export const CAL_MIN_POINTS = 2;
export const CAL_MAX_POINTS = 12;
/** Highest MIDI velocity. */
export const VEL_MAX = 127;

/** @typedef {{in: number[], out: number[]}} VelocityCurve */
/** @typedef {Readonly<{xs: readonly number[], ys: readonly number[], n: number}>} CompiledCal */

const round2 = (v) => Math.round(v * 100) / 100;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const fail = (error) => ({ ok: false, error });

/**
 * Check a curve: 2..12 points, every number 0..127 (rounded to 2 decimals), inputs strictly rising, outputs never
 * falling. Bad input is refused, not repaired, so a curve never changes meaning on its way in.
 * @param {unknown} raw  {in, out}
 * @returns {{ok:true, curve:VelocityCurve} | {ok:false, error:string}}
 */
export function checkCurve(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.in) || !Array.isArray(raw.out)) {
    return fail('A curve needs a row of key velocities and a row of what they play.');
  }
  const xs = raw.in;
  const ys = raw.out;
  if (xs.length !== ys.length) return fail(`The two rows need the same count (${xs.length} and ${ys.length}).`);
  if (xs.length < CAL_MIN_POINTS || xs.length > CAL_MAX_POINTS) {
    return fail(`A curve has ${CAL_MIN_POINTS} to ${CAL_MAX_POINTS} points (this one has ${xs.length}).`);
  }
  const out = { in: [], out: [] };
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const y = ys[i];
    if (!fin(x) || !fin(y) || x < 0 || y < 0 || x > VEL_MAX || y > VEL_MAX) {
      return fail(`Point ${i + 1}: every number is a velocity from 0 to ${VEL_MAX}.`);
    }
    out.in.push(round2(x));
    out.out.push(round2(y));
    if (i > 0 && !(out.in[i] > out.in[i - 1])) {
      return fail(`Point ${i + 1}: key velocities must rise from left to right (${out.in[i - 1]}, then ${out.in[i]}).`);
    }
    if (i > 0 && out.out[i] < out.out[i - 1]) {
      return fail(`Point ${i + 1}: a harder key can't play quieter (${out.out[i - 1]}, then ${out.out[i]}).`);
    }
  }
  return { ok: true, curve: out };
}

/**
 * The checked curve, or null (store validation).
 * @param {unknown} raw
 * @returns {VelocityCurve|null}
 */
export function validCurve(raw) {
  const r = checkCurve(raw);
  return r.ok ? r.curve : null;
}

const NUM = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Read Pianoteq's text format. Accepts `Velocity = [a, b; c, d]`, the bracketed part alone, or the two rows without
 * brackets; commas and / or spaces between numbers. The result is checked like checkCurve().
 * @param {string} text
 * @returns {{ok:true, curve:VelocityCurve} | {ok:false, error:string}}
 */
export function parseVelocity(text) {
  if (typeof text !== 'string' || !text.trim()) return fail('Paste a curve like Velocity = [0, 64, 127; 0, 64, 127].');
  let s = text.trim().replace(/^velocity\s*[=:]?\s*/i, '');
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) return fail('The curve is missing its closing "]".');
    s = s.slice(1, -1);
  }
  if (/[[\]]/.test(s)) return fail('Paste one curve: Velocity = [key velocities; what they play].');
  const rows = s.split(';');
  if (rows.length !== 2) return fail('Two rows are needed, split by ";": the key velocities, then what they play.');
  const nums = [];
  for (const row of rows) {
    const toks = row.split(/[\s,]+/).filter(Boolean);
    const vals = [];
    for (const t of toks) {
      if (!NUM.test(t)) return fail(`"${t.slice(0, 12)}" is not a velocity from 0 to ${VEL_MAX}.`);
      vals.push(Number(t));
    }
    nums.push(vals);
  }
  return checkCurve({ in: nums[0], out: nums[1] });
}

/**
 * Write a curve in Pianoteq's text format (parseVelocity(formatVelocity(c)) returns c; a string in this exact form
 * comes back unchanged).
 * @param {VelocityCurve} curve
 * @returns {string}
 */
export function formatVelocity(curve) {
  const f = (v) => String(round2(v));
  return `Velocity = [${curve.in.map(f).join(', ')}; ${curve.out.map(f).join(', ')}]`;
}

/**
 * Pre-compute a checked curve for calAt() (once per configuration change; the per-note step allocates nothing).
 * @param {VelocityCurve} curve
 * @returns {CompiledCal|null} null for an invalid curve
 */
export function compileCurve(curve) {
  const c = validCurve(curve);
  if (!c) return null;
  return Object.freeze({ xs: Object.freeze(c.in.slice()), ys: Object.freeze(c.out.slice()), n: c.in.length });
}

/**
 * The curve at a key velocity (fractional): linear between points, flat outside them.
 * @param {CompiledCal} c
 * @param {number} vel
 * @returns {number} 0..127
 */
export function calAt(c, vel) {
  const v = Number(vel) || 0;
  const { xs, ys, n } = c;
  if (v <= xs[0]) return ys[0];
  if (v >= xs[n - 1]) return ys[n - 1];
  let i = 1;
  while (xs[i] < v) i++;
  const x0 = xs[i - 1];
  return ys[i - 1] + ((ys[i] - ys[i - 1]) * (v - x0)) / (xs[i] - x0);
}

/**
 * The whole velocity the engine gets for a key velocity: 0 = a silent note (not sent), else 1..127.
 * @param {CompiledCal} c
 * @param {number} vel
 * @returns {number}
 */
export function calVelocity(c, vel) {
  return Math.min(VEL_MAX, Math.max(0, Math.round(calAt(c, vel))));
}

/**
 * Same points?
 * @param {VelocityCurve|null|undefined} a
 * @param {VelocityCurve|null|undefined} b
 * @returns {boolean}
 */
export function sameCurve(a, b) {
  if (!a || !b) return a === b;
  return a.in.length === b.in.length && a.in.every((x, i) => x === b.in[i] && a.out[i] === b.out[i]);
}

// ---------------------------------------------------------------------------------------------------------------
// Presets: Linear plus the old named curves (SPEC §2 soft / hard / fixed) as points

// denser at the soft end, where v^0.6 bends most: the light / heavy presets stay within 0.8 velocity of the old curves
const SAMPLE_AT = Object.freeze([0, 1, 4, 10, 20, 34, 52, 74, 100, 127]);

/**
 * An old {shape, min, max, top} curve as points (the editor's starting point for a keyboard that has one; it is only
 * saved as points when the player saves). The old curve gives a 0..1 level; ×127 is the velocity that plays it on
 * the linear curve. Sampled at 10 inputs plus `top`, so at most 11 points.
 * @param {object} spec
 * @returns {VelocityCurve}
 */
export function curveFromTouch(spec) {
  const s = normalizeTouch(spec);
  const c = compileTouch(s);
  const xs = [...new Set([...SAMPLE_AT, s.top])].sort((a, b) => a - b);
  return { in: xs, out: xs.map((x) => round2(touchAt(c, x) * VEL_MAX)) };
}

/**
 * Preset curves, in menu order. light / heavy / fixed = the old named curves soft (v^0.6), hard (v^1.6) and fixed
 * (100 for every note).
 * @type {Readonly<Record<'linear'|'light'|'heavy'|'fixed', Readonly<VelocityCurve>>>}
 */
export const CAL_PRESETS = Object.freeze({
  linear: Object.freeze({ in: [0, 127], out: [0, 127] }),
  light: Object.freeze(curveFromTouch({ shape: 0.6 })),
  heavy: Object.freeze(curveFromTouch({ shape: 1.6 })),
  fixed: Object.freeze({ in: [0, 127], out: [100, 100] }),
});
/** Preset names for the UI. */
export const CAL_PRESET_LABELS = Object.freeze({ linear: 'Linear', light: 'Light', heavy: 'Heavy', fixed: 'Fixed' });

/**
 * The preset a curve equals, or null.
 * @param {VelocityCurve|null|undefined} curve
 * @returns {string|null}
 */
export function presetOfCurve(curve) {
  for (const [k, p] of Object.entries(CAL_PRESETS)) if (sameCurve(curve, p)) return k;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The five-step assistant (silence, p, mp, f, fff)

/** Assistant steps, in order. */
export const CAL_STEPS = Object.freeze(['silence', 'p', 'mp', 'f', 'fff']);
/**
 * Velocity each step's median plays. p / f are Pianoteq's reference points (p 32, mf 64, f 96 on its linear curve);
 * mp sits halfway between p and mf. fff gets 120, not 127: the loudest playing still has room above it, so a note
 * harder than the player's fff median gets louder (the old fit put full level at the median hard note: everything
 * harder was clamped). Silence: notes as soft as the silence step's median play nothing.
 */
export const CAL_TARGETS = Object.freeze({ silence: 0, p: 32, mp: 48, f: 96, fff: 120 });
/** Notes the assistant asks for per step. */
export const CAL_NOTES = 6;
/** Fewest notes per step fitCalibration() accepts. */
export const CAL_MIN_NOTES = 3;
/** Medians of neighbouring steps must be at least this far apart (velocity steps). */
export const CAL_MIN_GAP = 2;
/** An fff median at or above this is a board that tops out: its fff plays full (there is nothing harder to send). */
const SATURATED = 126.5;

const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const velocities = (a) => (Array.isArray(a) ? a : []).map(Number).filter((v) => v >= 1 && v <= VEL_MAX);

/**
 * Fit a calibration curve from the five steps' notes. Each step's median maps to its CAL_TARGETS velocity; below the
 * silence median nothing sounds; above fff the f→fff slope carries on up to 127 (reached at fff + 7 · (fff − f) / 24,
 * or at 127 when that is past the top), so a light board that never sends 127 still reaches full level at its
 * hardest notes, and a hard board's fff still has louder notes above it.
 * @param {{silence?:number[], p?:number[], mp?:number[], f?:number[], fff?:number[]}} sets  raw velocities per step
 * @returns {{ok:true, curve:VelocityCurve, medians:Record<string, number>}
 *   | {ok:false, reason:'few'|'same'|'order', step:string, medians:Record<string, number|null>}}
 */
export function fitCalibration(sets) {
  const s = sets && typeof sets === 'object' ? sets : {};
  const medians = {};
  for (const k of CAL_STEPS) {
    const v = velocities(s[k]);
    medians[k] = v.length ? median(v) : null;
  }
  for (const k of CAL_STEPS) {
    if (velocities(s[k]).length < CAL_MIN_NOTES) return { ok: false, reason: 'few', step: k, medians };
  }
  const m = CAL_STEPS.map((k) => medians[k]);
  if (m.every((v) => Math.abs(v - m[0]) < CAL_MIN_GAP)) return { ok: false, reason: 'same', step: 'p', medians };
  for (let i = 1; i < m.length; i++) {
    if (m[i] - m[i - 1] < CAL_MIN_GAP) return { ok: false, reason: 'order', step: CAL_STEPS[i], medians };
  }
  const xs = [0];
  const ys = [0];
  CAL_STEPS.forEach((k, i) => {
    xs.push(round2(m[i]));
    ys.push(CAL_TARGETS[k]);
  });
  const f = medians.f;
  const fff = medians.fff;
  if (fff >= SATURATED) {
    xs[xs.length - 1] = VEL_MAX; // the board tops out at fff: fff is full level
    ys[ys.length - 1] = VEL_MAX;
  } else {
    const full = fff + ((VEL_MAX - CAL_TARGETS.fff) * (fff - f)) / (CAL_TARGETS.fff - CAL_TARGETS.f);
    xs.push(Math.min(VEL_MAX, round2(full)));
    ys.push(VEL_MAX);
  }
  const r = checkCurve({ in: xs, out: ys });
  // cannot fail after the order check above (kept as a guard: a refused fit is better than a wrong curve)
  if (!r.ok) return { ok: false, reason: 'order', step: 'fff', medians };
  return { ok: true, curve: r.curve, medians };
}
