// "Smart" controls for the H-v2 sound panel (design/H/implementation.md §1, H-v2 concept §1(1),
// views/edit/CONTRACT.md §6 "slot"). Pure: no DOM, no Web Audio. Everything here is presentation over existing state:
// each slider is a view of exactly ONE existing PARAMS path (no new store fields), picked by a fixed rule from the
// instrument metadata that engine.listInstruments() returns.
//
//   smartSlidersFor(meta)            → three slider specs: Brightness · Warmth · Ring-out | Fade-in (| Width)
//   slotPath(spec, i)                → the concrete store address ('slots.0.params.cutoff')
//   wordFor(role, value, spec)       → the word shown first ('Bright', 'Neutral', 'Natural')
//   formatSmart(spec, value)         → the small number beside it ('100%', '0 dB', '0.35 s', '1.8 kHz')
//   describeSlot(slot, meta, o)      → sentence-title parts ("KEYS plays Grand Piano on every key, …")
//
// The mapping rule (H concept §3 "The sound itself"):
//   Brightness = params.cutoff → params.tone → slots.<i>.eq.high
//   Warmth     = slots.<i>.eq.low (bipolar, filled from the centre)
//   third      = params.attack as "Fade-in" for pad-like instruments, else params.release as "Ring-out";
//                slots.<i>.width ("Width") when the instrument has neither (unknown / not loaded yet).
// A spec on eq.high / eq.low carries `shelf: 'high'|'low'`: the view reads and writes it as the slot EQ's high / low
// shelf (shared/eq-math.js readEq + shelfWrites), because the legacy rows stop acting once the Tone editor has written
// b1 / b8 rows (CONTRACT_CHANGES "## eq-build", "## hv2-edit-integrate"). `path` stays the legacy row (the test
// hook and the "one valid PARAMS path" rule).
import { describe, isValidPath } from './params.js';
import { noteName } from './music.js';

const MINUS = '−';
const SLOT_PREFIX = 'slots.<i>.';

/** Group names whose instruments fade in rather than ring out (engine listInstruments() `group`). */
const PAD_GROUPS = new Set(['Synth Pads']);

/** @param {object|null} meta @param {string} key @returns {object|null} numeric instrument param with that key */
function numParam(meta, key) {
  const list = meta && Array.isArray(meta.params) ? meta.params : [];
  const p = list.find((x) => x && x.key === key);
  if (!p || typeof p.default === 'boolean' || p.unit === 'bool' || p.unit === 'enum') return null;
  if (Array.isArray(p.enum)) return null;
  if (!Number.isFinite(p.min) || !Number.isFinite(p.max) || !(p.max > p.min)) return null;
  return p;
}

/** Spec for an instrument param (`slots.<i>.params.<key>`), ranges from the metadata. */
function paramSpec(role, label, p, ends, extra = {}) {
  return {
    role,
    label,
    path: `${SLOT_PREFIX}params.${p.key}`,
    key: p.key,
    min: p.min,
    max: p.max,
    curve: p.curve === 'log' && p.min > 0 ? 'log' : 'lin',
    default: Number.isFinite(p.default) ? p.default : p.min,
    unit: p.unit || 'lin',
    ends,
    bipolar: false,
    ...extra,
  };
}

/** Spec for a PARAMS row (`slots.<i>.eq.high` …), ranges from the table. */
function tableSpec(role, label, rest, ends, extra = {}) {
  const e = describe(`slots.0.${rest}`);
  const shelf = rest === 'eq.high' ? 'high' : rest === 'eq.low' ? 'low' : null;
  return {
    role,
    label,
    path: `${SLOT_PREFIX}${rest}`,
    key: null,
    min: e.min,
    max: e.max,
    curve: e.curve === 'log' && e.min > 0 ? 'log' : 'lin',
    default: e.default,
    unit: e.unit,
    ends,
    bipolar: false,
    ...(shelf ? { shelf } : {}),
    ...extra,
  };
}

/** True when the instrument should get "Fade-in" (its attack) instead of "Ring-out" (its release). */
export function isPadLike(meta) {
  if (!meta) return false;
  if (PAD_GROUPS.has(meta.group)) return true;
  return /(^|[-_ ])pad($|[-_ ])/i.test(String(meta.ref?.id || ''));
}

/**
 * The three "sound itself" sliders for an instrument. Each spec maps to exactly one PARAMS path (a table row or the
 * instrument-param pattern `slots.<i>.params.<key>` with a key the instrument really has).
 * @param {object|null} meta  an engine.listInstruments() entry ({ref, name, group, params}); null = unknown/not loaded
 * @returns {Array<{role:'brightness'|'warmth'|'ringout'|'fadein'|'width', label:string, path:string, key:string|null,
 *   min:number, max:number, curve:'lin'|'log', default:number, unit:string, ends:[string,string], bipolar:boolean}>}
 */
export function smartSlidersFor(meta) {
  const out = [];
  // Brightness: the instrument's own filter, else its tone control, else the strip's high shelf
  const cutoff = numParam(meta, 'cutoff');
  const tone = numParam(meta, 'tone');
  if (cutoff) out.push(paramSpec('brightness', 'Brightness', cutoff, ['darker', 'brighter']));
  else if (tone) out.push(paramSpec('brightness', 'Brightness', tone, ['darker', 'brighter']));
  else out.push(tableSpec('brightness', 'Brightness', 'eq.high', ['darker', 'brighter'], { bipolar: true }));
  // Warmth: always the strip's low shelf
  out.push(tableSpec('warmth', 'Warmth', 'eq.low', ['thinner', 'fuller'], { bipolar: true }));
  // Fade-in for pads, else Ring-out; Width when the instrument offers neither
  const attack = numParam(meta, 'attack');
  const release = numParam(meta, 'release');
  if (isPadLike(meta) && attack) out.push(paramSpec('fadein', 'Fade-in', attack, ['quick', 'slow']));
  else if (release) out.push(paramSpec('ringout', 'Ring-out', release, ['short', 'long']));
  else if (attack) out.push(paramSpec('fadein', 'Fade-in', attack, ['quick', 'slow']));
  else out.push(tableSpec('width', 'Width', 'width', ['narrow', 'wide']));
  return out;
}

/**
 * Concrete store address of a spec for slot i ('slots.<i>.params.cutoff' → 'slots.2.params.cutoff').
 * @param {{path:string}} spec @param {number} i @returns {string}
 */
export const slotPath = (spec, i) => spec.path.replace('<i>', String(i));

/** @param {{path:string}} spec @returns {boolean} the spec's path is a valid PARAMS address (checked on slot 0) */
export const isValidSpec = (spec) => isValidPath(slotPath(spec, 0));

/** Slider position 0..1 of a value on the spec's scale (log when the spec is log). */
export function positionOf(spec, v) {
  const n = Number(v);
  if (!Number.isFinite(n) || !(spec.max > spec.min)) return 0;
  const x = Math.min(spec.max, Math.max(spec.min, n));
  if (spec.curve === 'log' && spec.min > 0) return Math.log(x / spec.min) / Math.log(spec.max / spec.min);
  return (x - spec.min) / (spec.max - spec.min);
}

/** First bucket whose upper bound is ≥ x; the last word otherwise. */
const bucket = (x, table) => (table.find(([hi]) => x <= hi) || table[table.length - 1])[1];
const E = 1e-9; // "strictly below" bounds
const WORDS = Object.freeze({
  brightDb: [[-6, 'Dark'], [-1.5 - E, 'Mellow'], [1.5, 'Neutral'], [6 - E, 'Bright'], [Infinity, 'Very bright']],
  brightPos: [[0.2 - E, 'Dark'], [0.45 - E, 'Mellow'], [0.7 - E, 'Natural'], [Infinity, 'Bright']],
  warmth: [[-6, 'Thin'], [-1.5 - E, 'Lean'], [1.5, 'Neutral'], [6 - E, 'Warm'], [Infinity, 'Full']],
  ringout: [[0.5 - E, 'Short'], [2, 'Natural'], [5, 'Long'], [Infinity, 'Very long']],
  fadein: [[0.03 - E, 'Instant'], [0.3 - E, 'Quick'], [1.5 - E, 'Gentle'], [4 - E, 'Slow'], [Infinity, 'Very slow']],
  width: [[0.02 - E, 'Mono'], [0.7 - E, 'Narrow'], [1.1, 'Normal'], [Infinity, 'Wide']],
});

/**
 * The word shown before the number. Buckets (H concept §3, untested wording — the number is always shown too):
 *  - brightness: dB (eq.high) Dark ≤ −6 < Mellow < −1.5 ≤ Neutral ≤ 1.5 < Bright < 6 ≤ Very bright;
 *                a filter/tone position Dark < .2 ≤ Mellow < .45 ≤ Natural < .7 ≤ Bright
 *  - warmth (dB): Thin ≤ −6 < Lean < −1.5 ≤ Neutral ≤ 1.5 < Warm < 6 ≤ Full
 *  - ringout: relative to the instrument's default d: Short < d/2 ≤ Natural ≤ 2d < Long ≤ 5d < Very long
 *  - fadein (s): Instant < .03 ≤ Quick < .3 ≤ Gentle < 1.5 ≤ Slow < 4 ≤ Very slow
 *  - width: Mono < .02 ≤ Narrow < .7 ≤ Normal ≤ 1.1 < Wide
 * @param {string} role
 * @param {number} value
 * @param {object} [spec]  the smartSlidersFor() spec (needed for filter/tone positions and the ring-out default)
 * @returns {string}
 */
export function wordFor(role, value, spec) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '';
  switch (role) {
    case 'brightness':
      return !spec || spec.unit === 'dB' ? bucket(v, WORDS.brightDb) : bucket(positionOf(spec, v), WORDS.brightPos);
    case 'warmth':
      return bucket(v, WORDS.warmth);
    case 'ringout': {
      const d = spec && Number(spec.default) > 0 ? Number(spec.default) : 0.3;
      return bucket(v / d, WORDS.ringout);
    }
    case 'fadein':
      return bucket(v, WORDS.fadein);
    case 'width':
      return bucket(v, WORDS.width);
    default:
      return '';
  }
}

/**
 * The small number beside the word. dB → "0 dB" / "+6.0 dB"; seconds → "12 ms" / "0.35 s" / "2.5 s";
 * Hz → "180 Hz" / "1.8 kHz"; width → "Mono" / "100%"; any other range → percent of the range ("100%").
 * @param {object} spec @param {number} value @returns {string}
 */
export function formatSmart(spec, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (spec.unit === 'dB') return Math.abs(n) < 0.05 ? '0 dB' : `${n > 0 ? '+' : MINUS}${Math.abs(n).toFixed(1)} dB`;
  if (spec.unit === 's') {
    if (n < 0.1) return `${Math.round(n * 1000)} ms`;
    if (n < 1) return `${n.toFixed(2)} s`;
    return n < 10 ? `${n.toFixed(1)} s` : `${Math.round(n)} s`;
  }
  if (spec.unit === 'Hz') {
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)} kHz`;
    return n >= 10 ? `${Math.round(n)} Hz` : `${n.toFixed(2)} Hz`;
  }
  if (spec.role === 'width') return n < 0.005 ? 'Mono' : `${Math.round(n * 100)}%`;
  return `${Math.round(positionOf({ ...spec, curve: 'lin' }, n) * 100)}%`;
}

// ---------------------------------------------------------------------------------------------------------------
// sentence title
const OCTAVE_WORDS = { 1: 'an octave up', 2: 'two octaves up', '-1': 'an octave down', '-2': 'two octaves down' };

/** "every key" / "keys up to B3" / "keys from C4 up" / "C3 to C5". @param {object} slot */
export function rangeWords(slot) {
  const lo = Number(slot.lowNote) || 0;
  const hi = Number.isFinite(slot.highNote) ? slot.highNote : 127;
  if (lo <= 0 && hi >= 127) return 'every key';
  if (lo <= 0) return `keys up to ${noteName(hi)}`;
  if (hi >= 127) return `keys from ${noteName(lo)} up`;
  return `${noteName(lo)} to ${noteName(hi)}`;
}

/** How far into the Space: '' (dry), 'a little', 'well', 'deep'. @param {number} v 0..1 */
export function sendWords(v) {
  const n = Number(v) || 0;
  if (n <= 0.0005) return '';
  if (n <= 0.3) return 'a little';
  if (n <= 0.6) return 'well';
  return 'deep';
}

/**
 * Sentence-title parts for a slot (CONTRACT.md §3.5 part shapes). Word tokens carry `key` (which control they jump
 * to: 'instrument' | 'muted' | 'range' | 'octave' | 'reverb' | 'sustain'); the panel adds `control`. `changed` is set
 * from `o.isChanged(field)` for the song-diff watched fields ('instrument', 'octave', 'sends.reverb', 'sustain').
 * "KEYS plays Grand Piano on every key, ● an octave up, a little into the Hall, sustain on"
 * @param {object|null} slot
 * @param {object|null} meta     listInstruments() entry (null = unknown / not loaded)
 * @param {{role:string, name?:string, spaceName?:string, isChanged?:(field:string) => boolean}} o
 *        role = 'KEYS'; name = the display name (default meta.name, else "<id> (not available)"); spaceName = the
 *        matched Space preset ('Hall'), default 'Space'
 * @returns {Array<string|{text:string, role?:true, key?:string, changed?:boolean}>}
 */
export function describeSlot(slot, meta, o = {}) {
  const role = { text: String(o.role || '').toUpperCase(), role: true };
  const ch = (f) => (typeof o.isChanged === 'function' ? !!o.isChanged(f) : false);
  if (!slot) return [role, ' is empty. ', { text: 'Add a sound', key: 'instrument' }];
  const id = slot.instrument ? slot.instrument.id : '?';
  const name = o.name || (meta ? meta.name : `${id} (not available)`);
  const parts = [role];
  if (slot.muted) parts.push(' is ', { text: 'switched off', key: 'muted' }, ', but plays ');
  else parts.push(' plays ');
  parts.push({ text: name, key: 'instrument', changed: ch('instrument') });
  parts.push(' on ', { text: rangeWords(slot), key: 'range' });
  const oct = Math.round(Number(slot.octave) || 0);
  if (oct) parts.push(', ', { text: OCTAVE_WORDS[oct] || `${oct} octaves`, key: 'octave', changed: ch('octave') });
  const how = sendWords(slot.sends ? slot.sends.reverb : 0);
  const space = o.spaceName || 'Space';
  if (how) parts.push(`, ${how} into the `, { text: space, key: 'reverb', changed: ch('sends.reverb') });
  else parts.push(', ', { text: 'dry', key: 'reverb', changed: ch('sends.reverb') });
  parts.push(', sustain ', { text: slot.sustain === false ? 'off' : 'on', key: 'sustain', changed: ch('sustain') });
  return parts;
}
