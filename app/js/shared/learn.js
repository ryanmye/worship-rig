// MIDI learn for any PARAMS path (2.x step 5, FX-gap-analysis "MIDI learn"; DECISIONS O-AW-ML). Pure: no DOM, no
// Web Audio. The store validates a mapping's optional fields with learnFields, the controller maps a CC with ccToValue
// (and its pickup with valueToCc), the views name a target with learnLabel.
//
// A mapping is settings.midiLearn[<path>] = {cc, channel, min?, max?, invert?}: the key is a §4 path in the current-
// song grammar ('slots.1.sends.reverb', 'fx.delay.feedback'), so it follows whichever song plays (O-AW-ML rule 2).
import { describe, faderTaper, inverseTaper, clamp, isLearnable, slotName, parsePath, MAX_SLOTS } from './params.js';

/**
 * A PARAMS path a CC can drive: a numeric row with a finite min/max that is not a switch, a choice or a whole-number
 * step (bool, enum and step-1 rows such as octave / transpose / lowNote are not continuous), and not the dynamic
 * `slots.<i>.params.<key>` row (its range lives in the instrument list, not in PARAMS). Slots 0..MAX_SLOTS-1.
 * @param {string} path
 * @returns {boolean}
 */
export function isLearnablePath(path) {
  if (typeof path !== 'string' || !parsePath(path, MAX_SLOTS)) return false;
  const e = describe(path);
  return !!e && !e.dynamic && e.unit !== 'bool' && e.unit !== 'enum' && e.step !== 1
    && Number.isFinite(e.min) && Number.isFinite(e.max) && e.max > e.min;
}

/**
 * A learnable path that is not one of the fixed 1.x / UIA Learn rows (params.isLearnable): Settings lists these as
 * custom mappings, with Remove.
 * @param {string} id
 * @returns {boolean}
 */
export function isCustomLearn(id) {
  return isLearnablePath(id) && !isLearnable(id);
}

/**
 * The CC curve of a row, the same one Edit's sliders use (views/edit/lib.js sliderScale), so a knob at half way sits
 * where the slider's thumb would: 'taper' for gains shown in dB (2·pos³), 'log' for log rows (Hz, Q, times),
 * else 'lin'.
 * @param {string} path
 * @returns {'taper'|'log'|'lin'}
 */
export function learnCurve(path) {
  const e = describe(path);
  if (!e) return 'lin';
  if (e.unit === 'dB-display') return 'taper';
  return e.curve === 'log' && e.min > 0 ? 'log' : 'lin';
}

/**
 * The Pedal hold slider's track (Edit › slot › Advanced › Sustain): log 2..`top` s, and from `natural` up it reads
 * 'natural' (the field is removed). The row's own max (30 s) is not the slider's end, so a knob on the row's range
 * sat 10 % off the thumb and could never get back to 'natural' (skeptic midi-learn-any L1). Edit's slot panel
 * reads these, so the slider and the knob share one track.
 */
export const PEDAL_HOLD_TRACK = Object.freeze({ min: 2, top: 40, natural: 31 });
const isPedalHold = (path) => describe(path)?.path === 'slots.<i>.pedalHold';

/** Position 0..1 along the row's curve ↔ value (no clamping of p; v is clamped to the row). */
function scaleOf(path) {
  const e = describe(path);
  const curve = learnCurve(path);
  if (isPedalHold(path)) {
    const { min, top, natural } = PEDAL_HOLD_TRACK;
    const a = Math.log(min);
    const b = Math.log(top);
    return {
      // absent / null / 'natural' = the top of the track, as the slider shows it
      toPos: (v) => (typeof v === 'number' && Number.isFinite(v) ? (Math.log(Math.min(top, Math.max(min, v))) - a)
        / (b - a) : 1),
      toVal: (p) => {
        const v = Math.exp(a + p * (b - a));
        return v >= natural - 1e-9 ? null : Math.min(e.max, v);
      },
    };
  }
  if (curve === 'taper') return { toPos: (v) => inverseTaper(v), toVal: (p) => faderTaper(p) };
  if (curve === 'log') {
    const a = Math.log(e.min);
    const b = Math.log(e.max);
    return {
      toPos: (v) => (Math.log(Math.min(e.max, Math.max(e.min, v))) - a) / (b - a),
      toVal: (p) => Math.exp(a + p * (b - a)),
    };
  }
  return {
    toPos: (v) => (Math.min(e.max, Math.max(e.min, v)) - e.min) / (e.max - e.min),
    toVal: (p) => e.min + p * (e.max - e.min),
  };
}

/** The mapping's ends in curve positions [lo, hi] (its min / max, else the row's). */
function endsOf(path, m) {
  const e = describe(path);
  const s = scaleOf(path);
  const lo = m && Number.isFinite(m.min) ? m.min : e.min;
  const hi = m && Number.isFinite(m.max) ? m.max : isPedalHold(path) ? PEDAL_HOLD_TRACK.top : e.max;
  return { s, lo: s.toPos(lo), hi: s.toPos(hi) };
}

/**
 * CC position → parameter value. cc01 (0..1, MIDI value / 127) runs from the mapping's min to its max (the row's
 * min..max when absent) along learnCurve; invert runs it backwards. The result is clamped to the row (params.clamp).
 * With no min / max / invert, a gain row gives exactly faderTaper(cc01): the 1.x learned fader. Pedal hold runs
 * along PEDAL_HOLD_TRACK and gives null (= 'natural': the store removes the field) at the top, as its slider does.
 * @param {string} path a learnable path
 * @param {number} cc01
 * @param {{min?:number, max?:number, invert?:boolean}} [m]
 * @returns {number|null}
 */
export function ccToValue(path, cc01, m) {
  const x0 = Math.min(1, Math.max(0, Number(cc01) || 0));
  const x = m && m.invert === true ? 1 - x0 : x0;
  const { s, lo, hi } = endsOf(path, m);
  const v = s.toVal(lo + x * (hi - lo));
  return v === null ? null : clamp(path, v);
}

/**
 * Parameter value → the CC position that gives it (the pickup's target), or null when no CC position stands for it:
 * a non-number (release's null = the instrument's own) or min = max. Pedal hold's absent / null / 'natural' is the
 * top of its track (PEDAL_HOLD_TRACK). A value outside the mapping's range gives
 * the nearer end, so the knob takes over there.
 * @param {string} path
 * @param {*} value
 * @param {{min?:number, max?:number, invert?:boolean}} [m]
 * @returns {number|null} 0..1
 */
export function valueToCc(path, value, m) {
  const natural = isPedalHold(path) && (value === null || value === undefined || value === 'natural');
  if (!natural && (typeof value !== 'number' || !Number.isFinite(value))) return null;
  const { s, lo, hi } = endsOf(path, m);
  if (Math.abs(hi - lo) < 1e-12) return null;
  const c = Math.min(1, Math.max(0, (s.toPos(value) - lo) / (hi - lo)));
  return m && m.invert === true ? 1 - c : c;
}

/**
 * Validate a mapping's optional range fields for its key, in place on a copy (store.normalizeMidiLearn; idempotent).
 * For a learnable path: min / max must be finite numbers (clamped to the row; anything else is dropped), invert is
 * kept only as `true`. Other keys (buttons, unknown ids from a newer version) pass unchanged.
 * @param {string} key
 * @param {object} v a mapping that already has a valid cc / note and channel
 * @returns {object}
 */
export function learnFields(key, v) {
  if (!isLearnablePath(key)) return v;
  const out = { ...v };
  for (const f of ['min', 'max']) {
    if (!(f in out)) continue;
    if (typeof out[f] === 'number' && Number.isFinite(out[f])) out[f] = clamp(key, out[f]);
    else delete out[f];
  }
  if ('invert' in out && out.invert !== true) delete out.invert;
  return out;
}

const UNIT_WORDS = Object.freeze({ reverb: 'Reverb', delay: 'Delay', chorus: 'Chorus', lofi: 'Lofi', eq: 'Master EQ',
  comp: 'Glue' });

/**
 * A plain name for a learn target ('Pad reverb send', 'Delay feedback', 'Drone brightness'): the row's label with its
 * slot or unit in front when the label does not already say it.
 * @param {string} path
 * @returns {string}
 */
export function learnLabel(path) {
  const e = describe(path);
  if (!e) return String(path);
  const p = parsePath(path, MAX_SLOTS);
  if (p && p.slot !== null) return `${slotName(p.slot)} ${e.label.charAt(0).toLowerCase()}${e.label.slice(1)}`;
  const segs = path.split('.');
  const unit = segs[0] === 'fx' ? UNIT_WORDS[segs[1]] : segs[0] === 'drone' ? 'Drone' : null;
  if (!unit || e.label.toLowerCase().includes(unit.toLowerCase()) || e.label.toLowerCase().startsWith('master')) {
    return e.label;
  }
  return `${unit} ${e.label.charAt(0).toLowerCase()}${e.label.slice(1)}`;
}
