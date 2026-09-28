// Slot EQ math (design/eq/DECISION.md §2 + §5, overridden by design/eq/AMENDMENT.md: WING-style variable bands).
// Pure: no DOM, no Web Audio. Everything the keyboard EQ editor (views/components/eq-keyboard.js) draws, parses or
// writes lives here so it can be unit-tested in node (test/unit/shared/eq-math.test.mjs):
//   • the pitch-true axis (uOfF / fOfU): one semitone = one unit over A0…C8, compressed "sub" and "air" zones
//   • RBJ biquad coefficients exactly as Web Audio's BiquadFilterNode implements them (peaking/notch: linear Q;
//     shelves: S = 1, Q ignored; highpass/lowpass: Q in dB) and their magnitude response at any sample rate
//   • the slot EQ model (AMENDMENT §4): `slots.<i>.eq.b<k>.{on,type,hz,db,q}` for k = 1..8, `eq.cutHz` (20 = off),
//     `eq.hiCutHz` (20000 = off); legacy `eq.low` / `eq.high` read as b1 (120 Hz low shelf) / b8 (6 kHz high shelf)
//     while those bands have no stored fields. readEq() turns a stored slot.eq into the editor's band list;
//     writesFor() turns a target state back into the minimal list of store.set() writes.
//   • band reach vs the slot's sounding range ("Boost notes F#3–C5", "overtones only", "no effect on notes")
//   • Hz / note / Q / bandwidth parsers, the EqualizerAPO/REW paste parser, "Copy as text", presets
// Ranges come from the PARAMS rows when they exist (shared/params.js, owned by the engine side); the FALLBACK_* values
// below are AMENDMENT.md §4's numbers and are only used until/unless those rows land.
import { describe } from './params.js';

/** Axis keyboard: A0 … C8 (88 keys). */
export const MIDI_LO = 21;
export const MIDI_HI = 108;
export const F_MIN = 20;
export const F_MAX = 20000;
/** Compression of the sub (< A0) and air (> C8) zones, in axis units per semitone (curve prototype). */
export const SUB_K = 0.5;
export const AIR_K = 0.42;
/** Key-zone edges in semitones. */
export const S_LO = MIDI_LO - 0.5;
export const S_HI = MIDI_HI + 0.5;

export const semiOf = (f) => 69 + 12 * Math.log2(f / 440);
export const fOfSemi = (s) => 440 * Math.pow(2, (s - 69) / 12);
/** Equal-tempered frequency of a (fractional) MIDI note. */
export const midiF = fOfSemi;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const SUB_U = (S_LO - semiOf(F_MIN)) * SUB_K;
export const KEY_U = S_HI - S_LO;
export const AIR_U = (semiOf(F_MAX) - S_HI) * AIR_K;
export const TOTAL_U = SUB_U + KEY_U + AIR_U;

/**
 * Frequency → axis units (0 … TOTAL_U). One unit per semitone over the keys.
 * @param {number} f Hz
 * @returns {number}
 */
export function uOfF(f) {
  const s = semiOf(f);
  if (s < S_LO) return SUB_U - (S_LO - s) * SUB_K;
  if (s > S_HI) return SUB_U + KEY_U + (s - S_HI) * AIR_K;
  return SUB_U + (s - S_LO);
}

/**
 * Axis units → frequency (inverse of uOfF).
 * @param {number} u
 * @returns {number} Hz
 */
export function fOfU(u) {
  if (u < SUB_U) return fOfSemi(S_LO - (SUB_U - u) / SUB_K);
  if (u > SUB_U + KEY_U) return fOfSemi(S_HI + (u - SUB_U - KEY_U) / AIR_K);
  return fOfSemi(S_LO + (u - SUB_U));
}

/** Semitone coordinate → axis units (keys zone only). */
export const uOfSemi = (s) => SUB_U + (s - S_LO);

const BLACK = new Set([1, 3, 6, 8, 10]);
export const isBlackKey = (n) => BLACK.has(((n % 12) + 12) % 12);
const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
/** 'C4' for 60 (flats except F#, as the curve prototype and the app's key labels). */
export const noteName = (n) => NAMES[((Math.round(n) % 12) + 12) % 12] + (Math.floor(Math.round(n) / 12) - 1);

/**
 * Pitch-true key rectangles in semitone coordinates: every key is centred on its own fundamental; white keys are
 * 1, 1.5 or 2 semitones wide depending on their neighbours, black keys 0.92.
 * @returns {{n:number, black:boolean, l:number, r:number}[]}
 */
export function keyRects(lo = MIDI_LO, hi = MIDI_HI) {
  const out = [];
  for (let n = lo; n <= hi; n++) {
    if (isBlackKey(n)) {
      out.push({ n, black: true, l: n - 0.46, r: n + 0.46 });
      continue;
    }
    const l = n === lo ? n - 0.5 : n - (isBlackKey(n - 1) ? 1 : 0.5);
    const r = n === hi ? n + 0.5 : n + (isBlackKey(n + 1) ? 1 : 0.5);
    out.push({ n, black: false, l, r });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the slot EQ model
/** Band slots per slot EQ (the WING's bus count, AMENDMENT §1). */
export const MAX_BANDS = 8;
/** Stored band types (AMENDMENT §2). 'off' marks an unused (removed) band slot. */
export const BAND_TYPES = Object.freeze(['off', 'lowshelf', 'peak', 'highshelf', 'notch', 'lowcut', 'highcut']);
/** Types the editor offers in its type menu, in menu order. */
export const MENU_TYPES = Object.freeze(['peak', 'lowshelf', 'highshelf', 'notch', 'lowcut', 'highcut']);
export const TYPE_LABEL = Object.freeze({
  off: 'Off', peak: 'PEQ', lowshelf: 'Low shelf', highshelf: 'High shelf', notch: 'Notch', lowcut: 'Low cut',
  highcut: 'High cut',
});
/** Types whose gain means something (notch and cuts have none in Web Audio). */
export const hasGain = (t) => t === 'peak' || t === 'lowshelf' || t === 'highshelf';
/** Types whose Q means something (Web Audio ignores Q on shelves). */
export const hasQ = (t) => t === 'peak' || t === 'notch' || t === 'lowcut' || t === 'highcut';
export const BAND_FIELDS = Object.freeze(['on', 'type', 'hz', 'db', 'q']);

// AMENDMENT §4 numbers, used when the PARAMS row is missing (see header).
const FALLBACK_ROWS = {
  on: { min: 0, max: 1, default: false },
  type: { default: 'peak' },
  hz: { min: 20, max: 20000, default: 1000 },
  db: { min: -15, max: 15, default: 0 },
  q: { min: 0.1, max: 10, default: 1 },
  cutHz: { min: 20, max: 20000, default: 20 },
  hiCutHz: { min: 20, max: 20000, default: 20000 },
  low: { min: -12, max: 12, default: 0 },
  high: { min: -12, max: 12, default: 0 },
};
/** Legacy shelves (today's fixed fx.js eqLow / eqHigh), shown as b1 / b8 while those bands have no stored fields. */
export const LEGACY_LOW = Object.freeze({ k: 1, type: 'lowshelf', hz: 120, key: 'low' });
export const LEGACY_HIGH = Object.freeze({ k: MAX_BANDS, type: 'highshelf', hz: 6000, key: 'high' });
/** cutHz at or below this is "off" (a 20 Hz Butterworth is −1.07 dB at A0, so the engine bypasses it; DECISION §3). */
export const CUT_OFF_HZ = 20.5;
/** hiCutHz at or above this is "off". */
export const HICUT_OFF_HZ = 19999;
/** Web Audio's Butterworth Q for lowpass/highpass, in dB (fx.BUTTER2_Q). */
export const BUTTER2_Q_DB = 20 * Math.log10(Math.SQRT1_2);
/** Q the editor gives a band switched to a cut (linear; = Butterworth once converted to dB). */
export const CUT_Q = Math.SQRT1_2;

/** Relative eq key of a band field: bandKey(3, 'hz') → 'b3.hz' (store path `slots.<i>.eq.b3.hz`). */
export const bandKey = (k, field) => `b${k}.${field}`;

/**
 * Range/default for a relative eq key ('b3.hz', 'cutHz', 'low'): the PARAMS row when it exists, else AMENDMENT §4.
 * @param {string} key
 * @returns {{min?:number, max?:number, default:any, enum?:string[], fromParams:boolean}}
 */
export function eqRow(key) {
  let e = null;
  try {
    e = describe(`slots.0.eq.${key}`);
  } catch {
    e = null;
  }
  const field = /^b\d+\.(\w+)$/.exec(key)?.[1] ?? key;
  const fb = FALLBACK_ROWS[field] || { default: 0 };
  if (!e) return { ...fb, fromParams: false };
  return { min: e.min, max: e.max, default: e.default, enum: e.enum, fromParams: true };
}

/**
 * Clamp/coerce one value for a relative eq key.
 * @param {string} key
 * @param {*} v
 * @returns {number|boolean|string}
 */
export function clampEqValue(key, v) {
  const field = /^b\d+\.(\w+)$/.exec(key)?.[1] ?? key;
  const r = eqRow(key);
  if (field === 'on') return !!v;
  if (field === 'type') return BAND_TYPES.includes(v) ? v : r.default;
  const x = Number(v);
  if (!Number.isFinite(x)) return r.default;
  return clamp(x, r.min ?? -Infinity, r.max ?? Infinity);
}

/** Read `a.b.c` from a nested object; also accepts a flat `{'b3.hz': …}` object (either store shape works). */
function pick(eq, key) {
  if (!eq || typeof eq !== 'object') return undefined;
  if (eq[key] !== undefined) return eq[key];
  let o = eq;
  for (const s of key.split('.')) {
    if (!o || typeof o !== 'object') return undefined;
    o = o[s];
  }
  return o;
}

/** True when band k has any stored field. */
export function bandStored(eq, k) {
  return BAND_FIELDS.some((f) => pick(eq, bandKey(k, f)) !== undefined);
}

/**
 * The editor's view of a stored slot.eq (absent / partial ok).
 * bands: visible bands (type ≠ 'off'), ascending k; each {k, on, type, hz, db, q, legacy}. `legacy` = shown from
 * eq.low / eq.high (b1 / b8 with no stored fields); the first edit migrates them (writesFor()).
 * @param {object} [eq]
 * @returns {{bands:{k:number, on:boolean, type:string, hz:number, db:number, q:number, legacy:boolean}[],
 *   cutHz:number, hiCutHz:number, legacy:boolean}}
 */
export function readEq(eq) {
  const bands = [];
  let legacy = false;
  for (let k = 1; k <= MAX_BANDS; k++) {
    const L = k === LEGACY_LOW.k ? LEGACY_LOW : k === LEGACY_HIGH.k ? LEGACY_HIGH : null;
    if (!bandStored(eq, k)) {
      if (!L) continue;
      legacy = true;
      const db = clampEqValue(L.key, pick(eq, L.key) ?? 0);
      bands.push({ k, on: true, type: L.type, hz: L.hz, db, q: Math.SQRT1_2, legacy: true });
      continue;
    }
    const g = (f) => {
      const v = pick(eq, bandKey(k, f));
      return clampEqValue(bandKey(k, f), v === undefined ? eqRow(bandKey(k, f)).default : v);
    };
    const type = g('type');
    if (type === 'off') continue;
    bands.push({ k, on: g('on'), type, hz: g('hz'), db: g('db'), q: g('q'), legacy: false });
  }
  const cut = pick(eq, 'cutHz');
  const hi = pick(eq, 'hiCutHz');
  return {
    bands,
    cutHz: cut === undefined ? eqRow('cutHz').default : clampEqValue('cutHz', cut),
    hiCutHz: hi === undefined ? eqRow('hiCutHz').default : clampEqValue('hiCutHz', hi),
    legacy,
  };
}

/** Lowest band slot k that is free (not visible), or null when all 8 are in use. */
export function freeBand(model) {
  const used = new Set(model.bands.map((b) => b.k));
  for (let k = 1; k <= MAX_BANDS; k++) if (!used.has(k)) return k;
  return null;
}

const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b);

/**
 * Minimal store writes that turn stored `eq` into `target`.
 * target: {bands: [{k, on, type, hz, db, q}] (the full visible set; missing k = removed), cutHz?, hiCutHz?}.
 * Rules (AMENDMENT §1, §4):
 *   • a removed band that has stored fields (or is a legacy b1/b8 on screen) gets `on:false, type:'off'`
 *   • a band that is new or was legacy gets all five fields; an existing one only its changed fields
 *   • when any legacy shelf is on screen, the first write migrates BOTH b1 and b8 (so an engine that reads
 *     eq.low/eq.high only while every b-row is absent keeps sounding the same) and zeroes eq.low / eq.high
 * @param {object} [eq] stored slot.eq
 * @param {{bands:object[], cutHz?:number, hiCutHz?:number}} target
 * @returns {[string, any][]} [relative key, value] in a stable order (bands ascending, then cuts, then legacy zeroing)
 */
export function writesFor(eq, target) {
  const cur = readEq(eq);
  const out = [];
  const want = new Map(target.bands.map((b) => [b.k, b]));
  const has = new Map(cur.bands.map((b) => [b.k, b]));
  const touched = [];
  for (let k = 1; k <= MAX_BANDS; k++) {
    const t = want.get(k);
    const c = has.get(k);
    if (!t) {
      if ((c && c.legacy) || (bandStored(eq, k) && pick(eq, bandKey(k, 'type')) !== 'off') ||
        (c && !c.legacy)) {
        out.push([bandKey(k, 'on'), false], [bandKey(k, 'type'), 'off']);
        touched.push(k);
      }
      continue;
    }
    const v = {};
    for (const f of BAND_FIELDS) v[f] = clampEqValue(bandKey(k, f), t[f] ?? eqRow(bandKey(k, f)).default);
    if (!c || c.legacy || !bandStored(eq, k)) {
      for (const f of BAND_FIELDS) out.push([bandKey(k, f), v[f]]);
      touched.push(k);
      continue;
    }
    for (const f of BAND_FIELDS) {
      const stored = pick(eq, bandKey(k, f));
      if (stored === undefined || !same(stored, v[f])) out.push([bandKey(k, f), v[f]]);
    }
  }
  if (target.cutHz !== undefined && !same(clampEqValue('cutHz', target.cutHz), cur.cutHz)) {
    out.push(['cutHz', clampEqValue('cutHz', target.cutHz)]);
  }
  if (target.hiCutHz !== undefined && !same(clampEqValue('hiCutHz', target.hiCutHz), cur.hiCutHz)) {
    out.push(['hiCutHz', clampEqValue('hiCutHz', target.hiCutHz)]);
  }
  if (cur.legacy && out.length) {
    // migrate the untouched legacy shelf too, so both b-rows exist from here on
    for (const L of [LEGACY_LOW, LEGACY_HIGH]) {
      if (touched.includes(L.k) || bandStored(eq, L.k)) continue;
      const c = has.get(L.k);
      const t = want.get(L.k);
      if (!c || !t) continue;
      if (out.some(([key]) => key.startsWith(`b${L.k}.`))) continue;
      for (const f of BAND_FIELDS) out.push([bandKey(L.k, f), clampEqValue(bandKey(L.k, f), t[f])]);
    }
    for (const L of [LEGACY_LOW, LEGACY_HIGH]) {
      const v = pick(eq, L.key);
      if (v !== undefined && v !== 0) out.push([L.key, 0]);
    }
  }
  return out;
}

/**
 * A/B compare done with store writes (used when neither controller nor engine offers a non-persisted audition):
 * `off` switches every audible band off and opens the cuts; `restore` puts back exactly what was there.
 * Legacy shelves are zeroed rather than migrated (a compare must not change the song's shape).
 * @param {object} [eq]
 * @returns {{off:[string, any][], restore:[string, any][]}}
 */
export function bypassWrites(eq) {
  const m = readEq(eq);
  const off = [];
  const restore = [];
  for (const b of m.bands) {
    if (b.legacy) {
      const L = b.k === LEGACY_LOW.k ? LEGACY_LOW : LEGACY_HIGH;
      if (b.db !== 0) {
        off.push([L.key, 0]);
        restore.push([L.key, b.db]);
      }
    } else if (b.on) {
      off.push([bandKey(b.k, 'on'), false]);
      restore.push([bandKey(b.k, 'on'), true]);
    }
  }
  if (m.cutHz > CUT_OFF_HZ) {
    off.push(['cutHz', eqRow('cutHz').min ?? 20]);
    restore.push(['cutHz', m.cutHz]);
  }
  if (m.hiCutHz < HICUT_OFF_HZ) {
    off.push(['hiCutHz', eqRow('hiCutHz').max ?? 20000]);
    restore.push(['hiCutHz', m.hiCutHz]);
  }
  return { off, restore };
}

/** Number of bands that do something (on, and |gain| ≥ 0.05 or a gainless type), plus cuts that are on. */
export function activeBands(eq) {
  const m = readEq(eq);
  let n = 0;
  for (const b of m.bands) if (b.on && (!hasGain(b.type) || Math.abs(b.db) >= 0.05)) n += 1;
  if (m.cutHz > CUT_OFF_HZ) n += 1;
  if (m.hiCutHz < HICUT_OFF_HZ) n += 1;
  return n;
}

/** "Flat" or "Custom · 3 bands" (the Advanced → Tone summary, DECISION §4). */
export function eqSummary(eq) {
  const n = activeBands(eq);
  return n === 0 ? 'Flat' : `Custom · ${n} band${n > 1 ? 's' : ''}`;
}

// ------------------------------------------------------------------------------------------------ filter math
/**
 * RBJ cookbook biquad as Web Audio's BiquadFilterNode computes it (Web Audio types: peaking, notch, lowshelf,
 * highshelf, highpass, lowpass): peaking and notch with linear Q, shelves with S = 1 (Web Audio ignores their Q),
 * highpass/lowpass with Q in dB. `[b0, b1, b2, a0, a1, a2]` (not normalised).
 * @param {{type:string, f:number, g?:number, q?:number}} b
 * @param {number} [fs=48000]
 * @returns {number[]}
 */
export function rbjCoeffs(b, fs = 48000) {
  const w0 = (2 * Math.PI * clamp(b.f, 1, fs / 2 - 1)) / fs;
  const cs = Math.cos(w0);
  const sn = Math.sin(w0);
  const A = Math.pow(10, (b.g || 0) / 40);
  if (b.type === 'peaking') {
    const al = sn / (2 * (b.q || 1));
    return [1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A];
  }
  if (b.type === 'notch') {
    const al = sn / (2 * (b.q || 1));
    return [1, -2 * cs, 1, 1 + al, -2 * cs, 1 - al];
  }
  if (b.type === 'highpass' || b.type === 'lowpass') {
    const al = sn / (2 * Math.pow(10, (b.q ?? BUTTER2_Q_DB) / 20));
    if (b.type === 'highpass') return [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + al, -2 * cs, 1 - al];
    return [(1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al];
  }
  const al = (sn / 2) * Math.SQRT2;
  const sA = 2 * Math.sqrt(A) * al;
  if (b.type === 'lowshelf') {
    return [A * (A + 1 - (A - 1) * cs + sA), 2 * A * (A - 1 - (A + 1) * cs), A * (A + 1 - (A - 1) * cs - sA),
      A + 1 + (A - 1) * cs + sA, -2 * (A - 1 + (A + 1) * cs), A + 1 + (A - 1) * cs - sA];
  }
  if (b.type === 'highshelf') {
    return [A * (A + 1 + (A - 1) * cs + sA), -2 * A * (A - 1 + (A + 1) * cs), A * (A + 1 + (A - 1) * cs - sA),
      A + 1 - (A - 1) * cs + sA, 2 * (A - 1 - (A + 1) * cs), A + 1 - (A - 1) * cs - sA];
  }
  throw new TypeError(`eq-math: unsupported filter type "${b.type}"`);
}

/**
 * Magnitude (dB) of a biquad at f. Floored at −300 dB (a notch's centre is an exact zero).
 * @param {number[]} c rbjCoeffs()
 * @param {number} f Hz
 * @param {number} [fs=48000]
 * @returns {number}
 */
export function magDb(c, f, fs = 48000) {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const nr = c[0] + c[1] * c1 + c[2] * c2;
  const ni = -(c[1] * s1 + c[2] * s2);
  const dr = c[3] + c[4] * c1 + c[5] * c2;
  const di = -(c[4] * s1 + c[5] * s2);
  return Math.max(-300, 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di) + 1e-30));
}

/**
 * Web Audio filter spec of an editor band, or null when it is identity (off, type 'off', or a 0 dB peak/shelf).
 * Per-band cuts take the band's linear Q converted to Web Audio's dB Q (Q 0.71 → Butterworth).
 * @param {{on:boolean, type:string, hz:number, db:number, q:number}} b
 * @returns {{type:string, f:number, g:number, q:number}|null}
 */
export function bandFilter(b) {
  if (!b || !b.on || b.type === 'off') return null;
  if (hasGain(b.type) && Math.abs(b.db) < 0.001) return null;
  switch (b.type) {
    case 'peak': return { type: 'peaking', f: b.hz, g: b.db, q: b.q };
    case 'lowshelf': return { type: 'lowshelf', f: b.hz, g: b.db, q: Math.SQRT1_2 };
    case 'highshelf': return { type: 'highshelf', f: b.hz, g: b.db, q: Math.SQRT1_2 };
    case 'notch': return { type: 'notch', f: b.hz, g: 0, q: b.q };
    case 'lowcut': return { type: 'highpass', f: b.hz, g: 0, q: 20 * Math.log10(Math.max(1e-3, b.q)) };
    case 'highcut': return { type: 'lowpass', f: b.hz, g: 0, q: 20 * Math.log10(Math.max(1e-3, b.q)) };
    default: return null;
  }
}

/** Filter specs of the dedicated cuts that are on (Butterworth). */
export function cutFilters(model) {
  const out = [];
  if (model.cutHz > CUT_OFF_HZ) out.push({ type: 'highpass', f: model.cutHz, g: 0, q: BUTTER2_Q_DB, cut: 'low' });
  if (model.hiCutHz < HICUT_OFF_HZ) out.push({ type: 'lowpass', f: model.hiCutHz, g: 0, q: BUTTER2_Q_DB, cut: 'high' });
  return out;
}

/**
 * One band's response (dB) at f; 0 when the band is identity.
 * @param {object} b editor band
 * @param {number} f
 * @param {number} [fs=48000]
 */
export function bandDb(b, f, fs = 48000) {
  const s = bandFilter(b);
  return s ? magDb(rbjCoeffs(s, fs), f, fs) : 0;
}

/**
 * Summed response (dB) of an editor model (readEq()) or a stored eq at each frequency: every band plus both cuts.
 * @param {object} modelOrEq readEq() result, or a stored slot.eq
 * @param {ArrayLike<number>} freqs
 * @param {number} [fs=48000]
 * @returns {Float64Array}
 */
export function eqResponseDb(modelOrEq, freqs, fs = 48000) {
  const m = modelOrEq && Array.isArray(modelOrEq.bands) ? modelOrEq : readEq(modelOrEq);
  const specs = [...m.bands.map(bandFilter).filter(Boolean), ...cutFilters(m)];
  const out = new Float64Array(freqs.length);
  for (const s of specs) {
    const c = rbjCoeffs(s, fs);
    for (let i = 0; i < freqs.length; i++) out[i] += magDb(c, freqs[i], fs);
  }
  return out;
}

/**
 * Peaking Q → bandwidth in octaves between the half-gain points. With `f` and `fs`, the digital (bilinear) relation
 * 1/Q = 2·sinh(ln2/2 · BW · w0/sin w0) (DECISION §5: the analog formula is wrong in the air zone); without, analog.
 */
export function bwOfQ(q, f, fs) {
  const k = f && fs ? Math.sin((2 * Math.PI * f) / fs) / ((2 * Math.PI * f) / fs) : 1;
  return ((2 * Math.asinh(1 / (2 * q))) / Math.LN2) * k;
}

/** Inverse of bwOfQ. */
export function qOfBw(bw, f, fs) {
  const w0 = f && fs ? (2 * Math.PI * f) / fs : 0;
  const k = w0 ? w0 / Math.sin(w0) : 1;
  return 1 / (2 * Math.sinh((Math.LN2 / 2) * bw * k));
}

// ------------------------------------------------------------------------------------------------ zones & reach
/**
 * Sounding fundamental range of a slot (DECISION §5), the fallback when the engine has no getSlotPlayRange:
 * shift = 12·octave + transpose + songTranspose; physical = controller ∩ split; sounding = physical + shift.
 * `instRange` only marks "stretched" notes (the sampler repitches without limit, DECISION §7), it does not grey.
 * @param {{lowNote?:number, highNote?:number, octave?:number, transpose?:number}} slot
 * @param {{songTranspose?:number, ctrl?:[number, number], instRange?:[number, number]|null}} [o]
 * @returns {{lo:number, hi:number, fLo:number, fHi:number, shift:number, why:{lo:string, hi:string},
 *   stretched:[number, number][]}}
 */
export function soundingRange(slot, o = {}) {
  const ctrl = o.ctrl || [MIDI_LO, MIDI_HI];
  const shift = 12 * (slot.octave || 0) + (slot.transpose || 0) + (o.songTranspose || 0);
  const low = slot.lowNote ?? 0;
  const high = slot.highNote ?? 127;
  const pLo = Math.max(ctrl[0], low);
  const pHi = Math.min(ctrl[1], high);
  return zoneOf(pLo + shift, Math.max(pLo, pHi) + shift, {
    shift,
    why: { lo: low > ctrl[0] ? 'split' : 'keyboard', hi: high < ctrl[1] ? 'split' : 'keyboard' },
    instRange: o.instRange,
  });
}

/**
 * Zone object from a sounding range (used for engine.getSlotPlayRange results too).
 * @param {number} lo lowest sounding MIDI note
 * @param {number} hi highest sounding MIDI note
 * @param {{shift?:number, why?:{lo:string, hi:string}, instRange?:[number, number]|null}} [o]
 */
export function zoneOf(lo, hi, o = {}) {
  const stretched = [];
  const ir = o.instRange;
  if (ir) {
    if (lo < ir[0]) stretched.push([lo, Math.min(hi, ir[0] - 1)]);
    if (hi > ir[1]) stretched.push([Math.max(lo, ir[1] + 1), hi]);
  }
  return {
    lo, hi, fLo: midiF(lo - 0.5), fHi: midiF(hi + 0.5), shift: o.shift ?? 0,
    why: o.why || { lo: 'split', hi: 'split' }, stretched,
  };
}

/** 401 log-spaced points, 20 Hz … 20 kHz (band reach, DECISION §5). */
export const REACH_FREQS = Object.freeze(Array.from({ length: 401 }, (_, i) => F_MIN * Math.pow(F_MAX / F_MIN, i / 400)));

/**
 * Where a filter acts, relative to the sounding range.
 * kind: 'flat' (identity) · 'none' (entirely below the lowest note) · 'over' (entirely above the top note: tone
 * colour only) · 'ok' (acts on notes lo…hi; `overtones` true when it also reaches above the top note).
 * Threshold: |dB| ≥ max(0.5, 0.3·|gain|) for peaks/shelves, 1 dB for cuts, 3 dB for a notch.
 * @param {{type:string, f:number, g:number, q:number}|null} spec bandFilter() / cutFilters() entry
 * @param {{lo:number, hi:number, fLo:number, fHi:number}} zone soundingRange() / zoneOf()
 * @param {number} [fs=48000]
 * @returns {{kind:'flat'|'none'|'over'|'ok', lo?:number, hi?:number, fA?:number, fZ?:number, overtones?:boolean,
 *   boost?:boolean}}
 */
export function bandReach(spec, zone, fs = 48000) {
  if (!spec) return { kind: 'flat' };
  const gl = spec.type === 'peaking' || spec.type === 'lowshelf' || spec.type === 'highshelf';
  if (gl && Math.abs(spec.g) < 0.25) return { kind: 'flat' };
  const thr = gl ? Math.max(0.5, Math.abs(spec.g) * 0.3) : spec.type === 'notch' ? 3 : 1;
  const c = rbjCoeffs(spec, fs);
  let a = null;
  let z = null;
  for (const f of REACH_FREQS) {
    if (f >= fs / 2) break;
    if (Math.abs(magDb(c, f, fs)) >= thr) {
      if (a === null) a = f;
      z = f;
    }
  }
  if (a === null) return { kind: 'flat' };
  const boost = gl && spec.g > 0;
  if (z < zone.fLo) return { kind: 'none', fA: a, fZ: z, boost };
  if (a > zone.fHi) return { kind: 'over', fA: a, fZ: z, boost, lo: zone.lo, hi: zone.hi };
  const n0 = clamp(Math.ceil(semiOf(a) - 0.5), zone.lo, zone.hi);
  const n1 = clamp(Math.floor(semiOf(z) + 0.5), zone.lo, zone.hi);
  return { kind: 'ok', lo: Math.min(n0, n1), hi: Math.max(n0, n1), fA: a, fZ: z, overtones: z > zone.fHi, boost };
}

/**
 * "Acts on" text for a band (plain text; the component adds the pill): {pill, text, kind}.
 * @param {object} b editor band
 * @param {object} zone
 * @param {number} [fs]
 */
export function actsOn(b, zone, fs = 48000) {
  if (!b.on) return { kind: 'flat', pill: 'Off', text: 'band switched off' };
  const r = bandReach(bandFilter(b), zone, fs);
  const verb = b.type === 'notch' ? 'Notch' : b.type === 'lowcut' || b.type === 'highcut' ? 'Cut' : r.boost ? 'Boost' : 'Cut';
  if (r.kind === 'flat') return { kind: 'flat', pill: 'Flat', text: hasGain(b.type) ? 'set a boost or cut' : 'no effect' };
  if (r.kind === 'none') return { kind: 'none', pill: 'No effect', text: `below lowest note ${noteName(zone.lo)}` };
  if (r.kind === 'over') {
    return { kind: 'over', pill: 'Overtones', text: `above top note ${noteName(zone.hi)}: tone colour, not notes` };
  }
  const span = r.lo === r.hi ? noteName(r.lo) : `${noteName(r.lo)}–${noteName(r.hi)}`;
  return { kind: 'ok', pill: verb, text: `notes ${span}${r.overtones ? ' + overtones' : ''}`, lo: r.lo, hi: r.hi };
}

// ------------------------------------------------------------------------------------------------ formatting
/** "250 Hz", "82.4 Hz", "2.5 kHz", "12.5 kHz". */
export function fmtHz(f) {
  if (f >= 10000) return `${(f / 1000).toFixed(1).replace(/\.0$/, '')} kHz`;
  if (f >= 1000) return `${(f / 1000).toFixed(2).replace(/0$/, '').replace(/\.0$/, '')} kHz`;
  return `${f < 100 ? f.toFixed(1).replace(/\.0$/, '') : Math.round(f)} Hz`;
}
/** Hz cell text: "250", "82.4", "2.5k", "12.5k". */
export function fmtHzNum(f) {
  if (f >= 1000) return `${(f / 1000).toFixed(f >= 10000 ? 1 : 2).replace(/\.?0+$/, '')}k`;
  return f < 100 ? f.toFixed(1).replace(/\.0$/, '') : String(Math.round(f));
}
/** "+2.0", "−3.5", "0.0" (U+2212 minus). */
export function fmtDb(g) {
  return (g > 0.04 ? '+' : g < -0.04 ? '−' : '') + Math.abs(g).toFixed(1);
}
/** "A3 · 220 Hz", "≈B3 +21¢ · 250 Hz", "above C8 · 8 kHz", "below A0 · 20 Hz". */
export function noteLabel(f) {
  const s = semiOf(f);
  if (s > S_HI) return `above C8 · ${fmtHz(f)}`;
  if (s < S_LO) return `below A0 · ${fmtHz(f)}`;
  const n = Math.round(s);
  const c = Math.round((s - n) * 100);
  return Math.abs(c) < 3 ? `${noteName(n)} · ${fmtHz(f)}` : `≈${noteName(n)} ${c > 0 ? '+' : '−'}${Math.abs(c)}¢ · ${fmtHz(f)}`;
}

// ------------------------------------------------------------------------------------------------ parsers
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * Hz or a note: "220", "220 Hz", "1.2k", "1k2", "3.5 kHz", "A3", "F#2", "Bb4", "≈B3 +21¢ · 250 Hz" (→ B3).
 * @param {string} v
 * @returns {number|null} Hz (not clamped), null when unparseable
 */
export function parseFreq(v) {
  const s = String(v ?? '').trim().replace(/^≈/, '').replace(/,/g, '');
  let m = /^([A-Ga-g])\s*([#♯b♭]?)\s*(-?\d)(?![\d.])/.exec(s);
  if (m) {
    const pc = PC[m[1].toUpperCase()] + (/[#♯]/.test(m[2]) ? 1 : /[b♭]/.test(m[2]) ? -1 : 0);
    return midiF(pc + 12 * (Number(m[3]) + 1));
  }
  m = /^(\d+)k(\d+)$/i.exec(s);
  if (m) return Number(`${m[1]}.${m[2]}`) * 1000;
  m = /^(\d*\.?\d+)\s*(k)?\s*(hz)?$/i.exec(s);
  if (m) {
    const f = Number(m[1]) * (m[2] ? 1000 : 1);
    return f > 0 ? f : null;
  }
  return null;
}

/**
 * Gain: "+3", "-2.5", "−2.5 dB".
 * @returns {number|null}
 */
export function parseDb(v) {
  const m = /^\s*([+\-−]?)\s*(\d*\.?\d+)\s*(db)?\s*$/i.exec(String(v ?? ''));
  if (!m) return null;
  return (m[1] === '-' || m[1] === '−' ? -1 : 1) * Number(m[2]);
}

/**
 * Q, or a bandwidth in octaves ("1 oct", "0.5oct") converted at f/fs with the digital relation.
 * @returns {number|null}
 */
export function parseQ(v, f, fs) {
  const m = /^\s*(\d*\.?\d+)\s*(oct(?:aves?)?)?\s*$/i.exec(String(v ?? ''));
  if (!m) return null;
  const x = Number(m[1]);
  if (!(x > 0)) return null;
  return m[2] ? qOfBw(x, f, fs) : x;
}

/** ISO third-octave centres: snap targets outside the keys (sub / air). */
export const ISO_THIRDS = Object.freeze([20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000]);

/**
 * Drag snapping: the nearest key inside A0…C8, the nearest ISO third-octave outside; `free` = no snap.
 * @param {number} f
 * @param {boolean} [free]
 * @returns {number}
 */
export function snapF(f, free = false) {
  if (free) return clamp(f, F_MIN, F_MAX);
  const s = semiOf(f);
  if (s >= S_LO && s <= S_HI) return midiF(Math.round(s));
  let best = ISO_THIRDS[0];
  for (const v of ISO_THIRDS) if (Math.abs(Math.log(v / f)) < Math.abs(Math.log(best / f))) best = v;
  return best;
}

// ------------------------------------------------------------------------------------------------ transfer
const r2 = (x) => Math.round(x * 100) / 100;
const numTxt = (x, d) => r2(x).toFixed(d);
const fcTxt = (f) => `Fc ${numTxt(f, f < 100 ? 2 : f < 1000 ? 1 : 0)} Hz`;

/**
 * "Copy as text": EqualizerAPO lines (REW and most EQs read them; parseForeign reads them back exactly).
 * Shelves carry "Q 0.71" (= Web Audio's fixed S = 1 slope); per-band cuts are HPQ/LPQ with their Q; the dedicated
 * cuts are plain HP/LP (Butterworth). Off bands are written as OFF so the numbering stays the band's k.
 * @param {object} modelOrEq readEq() result or stored eq
 * @param {string} [title] first-line comment, e.g. 'Keys · Grand Piano'
 * @returns {string}
 */
export function formatEqText(modelOrEq, title = '') {
  const m = modelOrEq && Array.isArray(modelOrEq.bands) ? modelOrEq : readEq(modelOrEq);
  const lines = [];
  if (title) lines.push(`# Worship Rig EQ · ${title}`);
  const gain = (g) => `Gain ${numTxt(g, 1)} dB`;
  for (const b of m.bands) {
    const st = b.on ? 'ON' : 'OFF';
    const q = `Q ${numTxt(b.q, 2)}`;
    let body;
    if (b.type === 'peak') body = `PK ${fcTxt(b.hz)} ${gain(b.db)} ${q}`;
    else if (b.type === 'lowshelf') body = `LSC ${fcTxt(b.hz)} ${gain(b.db)} Q 0.71`;
    else if (b.type === 'highshelf') body = `HSC ${fcTxt(b.hz)} ${gain(b.db)} Q 0.71`;
    else if (b.type === 'notch') body = `NO ${fcTxt(b.hz)} ${q}`;
    else if (b.type === 'lowcut') body = `HPQ ${fcTxt(b.hz)} ${q}`;
    else body = `LPQ ${fcTxt(b.hz)} ${q}`;
    lines.push(`Filter ${b.k}: ${st} ${body}`);
  }
  if (m.cutHz > CUT_OFF_HZ) lines.push(`Filter 9: ON HP ${fcTxt(m.cutHz)}`);
  if (m.hiCutHz < HICUT_OFF_HZ) lines.push(`Filter 10: ON LP ${fcTxt(m.hiCutHz)}`);
  return lines.join('\n');
}

/**
 * "Bring an EQ over" (DECISION §1; variable bands per AMENDMENT): EqualizerAPO / REW lines, "PK 250 Hz Q 1.4 −3 dB",
 * "low shelf 120 Hz +2 dB", "HP 80 Hz", "notch 60 Hz Q 10", bandwidths in octaves. Each filter line becomes a band:
 *   PK/PEQ/bell → peak · LS/LSC → lowshelf · HS/HSC → highshelf · NO/notch → notch
 *   the first HP (Butterworth) → the low cut (eq.cutHz); a 2nd HP or an HPQ → a lowcut band
 *   the first LP → the high cut (eq.hiCutHz); a 2nd LP or an LPQ → a highcut band
 * Bands are numbered: the first low shelf → b1, the first high shelf → b8, the rest ascending in the free slots
 * (frequency order). Anything that doesn't fit (a 9th band, AP/BP, a 6 dB/oct shelf, preamp) is listed as skipped,
 * never approximated. OFF lines come over as bands that are switched off. Out-of-range values are clamped + noted.
 * The result REPLACES the slot EQ: apply it with writesFor(eq, result).
 * @param {string} text
 * @param {number} [fs=48000] for "x oct" bandwidths (digital relation)
 * @returns {{bands:object[], cutHz:number, hiCutHz:number, lines:{raw:string, status:'applied'|'skipped',
 *   why?:string, band?:string, notes?:string[]}[]}}
 */
export function parseForeign(text, fs = 48000) {
  const found = [];
  const lines = [];
  let cutHz = eqRow('cutHz').default;
  let hiCutHz = eqRow('hiCutHz').default;
  let haveCut = false;
  let haveHiCut = false;
  const chunks = String(text ?? '').replace(/[−–]/g, '-').split(/\r?\n|;/).map((s) => s.trim()).filter(Boolean);
  for (const raw of chunks) {
    const s = raw.toLowerCase().replace(/\s+/g, ' ');
    const skip = (why) => lines.push({ raw, status: 'skipped', why });
    if (/^(#|\/\/)/.test(s)) continue; // comments (our own "Copy as text" header) are not lines
    if (/^preamp\b/.test(s)) {
      skip('preamp: use the slot level instead');
      continue;
    }
    const body = s.replace(/^filter\s*\d*\s*:\s*/, '');
    if (/^none\b/.test(body)) continue; // REW's unused slots
    const on = !/^off\b/.test(body);
    const t = body.replace(/^(on|off)\s+/, '');
    let type = null;
    let slope = null;
    let withQ = false;
    let m;
    if ((m = /^(lsc?|ls|low ?shelf|lowshelf|bass shelf)(?:\s+(\d+(?:\.\d+)?)\s*db)?\b/.exec(t))) {
      type = 'lowshelf';
      slope = m[2] ? Number(m[2]) : null;
    } else if ((m = /^(hsc?|hs|high ?shelf|highshelf|treble shelf)(?:\s+(\d+(?:\.\d+)?)\s*db)?\b/.exec(t))) {
      type = 'highshelf';
      slope = m[2] ? Number(m[2]) : null;
    } else if ((m = /^(hpq|hpf|hp|high ?pass|low ?cut)\b/.exec(t))) {
      type = 'hp';
      withQ = m[1] === 'hpq';
    } else if ((m = /^(lpq|lpf|lp|low ?pass|high ?cut)\b/.exec(t))) {
      type = 'lp';
      withQ = m[1] === 'lpq';
    } else if (/^(no|notch)\b/.test(t)) type = 'notch';
    else if (/^(ap|all ?pass|bp|band ?pass|modal)\b/.test(t)) type = 'other';
    else if (/^(pk|peq|peak(?:ing)?|bell|eq)\b/.test(t) || /^\d/.test(t) || /\bhz\b|\d\s*k\b/.test(t)) type = 'peak';
    if (!type) {
      skip('not a filter line');
      continue;
    }
    if (type === 'other') {
      skip(`${t.split(' ')[0].toUpperCase()} filters aren't part of the slot EQ`);
      continue;
    }
    if (slope !== null && Math.abs(slope - 12) > 0.01) {
      skip(`${slope} dB/oct shelf: the slot EQ's shelves have a fixed 12 dB/oct slope`);
      continue;
    }
    let f = null;
    if ((m = /\b(?:fc|freq(?:uency)?)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(k)?/.exec(t))) f = Number(m[1]) * (m[2] ? 1000 : 1);
    else if ((m = /(\d+(?:\.\d+)?)\s*k(?:hz)?\b/.exec(t))) f = Number(m[1]) * 1000;
    else if ((m = /(\d+(?:\.\d+)?)\s*hz\b/.exec(t))) f = Number(m[1]);
    else if ((m = /^(\d+(?:\.\d+)?)\s*[:=]/.exec(t))) f = Number(m[1]); // graphic "63: +2"
    if (!(f > 5 && f < 30000)) {
      skip('no frequency found');
      continue;
    }
    let gain = 0;
    if ((m = /\bgain\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)/.exec(t))) gain = Number(m[1]);
    else if ((m = /([+-]?\d+(?:\.\d+)?)\s*db\b/.exec(t.replace(/^(lsc?|hsc?|ls|hs)\s+\d+(?:\.\d+)?\s*db/, '')))) {
      gain = Number(m[1]);
    } else if ((m = /^\d+(?:\.\d+)?\s*[:=]\s*([+-]?\d+(?:\.\d+)?)/.exec(t))) gain = Number(m[1]);
    let q = null;
    let bw = null;
    if ((m = /\bq\s*[:=]?\s*(\d+(?:\.\d+)?)/.exec(t))) q = Number(m[1]);
    else if ((m = /\bbw\s*(?:oct)?\s*[:=]?\s*(\d+(?:\.\d+)?)/.exec(t)) || (m = /(\d+(?:\.\d+)?)\s*oct/.exec(t))) {
      bw = Number(m[1]);
    }
    const notes = [];
    const cl = (key, v, what) => {
      const c = clampEqValue(key, v);
      const r = eqRow(key);
      if (Math.abs(c - v) > 1e-9) notes.push(`${what} ${r2(v)} → ${r2(c)} (range ${r.min}…${r.max})`);
      return c;
    };
    if ((type === 'hp' && !withQ && !haveCut) || (type === 'lp' && !withQ && !haveHiCut)) {
      if (!on) {
        skip('filter is off');
        continue;
      }
      if (q !== null && Math.abs(q - Math.SQRT1_2) > 0.02) notes.push(`Q ${q} ignored: the ${type === 'hp' ? 'low' : 'high'} cut is a fixed Butterworth`);
      if (type === 'hp') {
        haveCut = true;
        cutHz = cl('cutHz', f, 'Hz');
      } else {
        haveHiCut = true;
        hiCutHz = cl('hiCutHz', f, 'Hz');
      }
      lines.push({ raw, status: 'applied', band: type === 'hp' ? 'Low cut' : 'High cut', notes });
      continue;
    }
    const bt = type === 'hp' ? 'lowcut' : type === 'lp' ? 'highcut' : type;
    if ((bt === 'lowshelf' || bt === 'highshelf') && q !== null && Math.abs(q - Math.SQRT1_2) > 0.02) {
      notes.push(`Q ${q} ignored: shelves have a fixed slope (Q 0.71)`);
    }
    let qq = q ?? (bw !== null ? qOfBw(bw, f, fs) : bt === 'peak' ? 1.41 : bt === 'notch' ? 10 : Math.SQRT1_2);
    if (bt === 'lowshelf' || bt === 'highshelf') qq = Math.SQRT1_2;
    const band = {
      on, type: bt, hz: cl('b1.hz', f, 'Hz'), db: hasGain(bt) ? cl('b1.db', gain, 'gain') : 0, q: cl('b1.q', qq, 'Q'),
    };
    found.push({ band, line: { raw, status: 'applied', band: TYPE_LABEL[bt], notes } });
  }
  // number the bands: first low shelf → b1, first high shelf → b8, the rest in frequency order in the free slots
  const bands = [];
  const used = new Set();
  const take = (entry, k) => {
    used.add(k);
    bands.push({ k, ...entry.band });
    entry.line.band = `${k} · ${entry.line.band}`;
    entry.done = true;
  };
  const ls = found.find((e) => e.band.type === 'lowshelf');
  if (ls) take(ls, 1);
  const hs = found.find((e) => e.band.type === 'highshelf');
  if (hs) take(hs, MAX_BANDS);
  const rest = found.filter((e) => !e.done).sort((a, b) => a.band.hz - b.band.hz);
  for (const e of rest) {
    let k = 1;
    while (used.has(k) && k <= MAX_BANDS) k++;
    if (k > MAX_BANDS) {
      e.line.status = 'skipped';
      e.line.why = `a ${found.length}th band: the slot EQ has ${MAX_BANDS}`;
      delete e.line.band;
      continue;
    }
    take(e, k);
  }
  bands.sort((a, b) => a.k - b.k);
  // the report keeps the input order
  const all = [...lines, ...found.map((e) => e.line)];
  const pos = new Map();
  chunks.forEach((c, i) => {
    if (!pos.has(c)) pos.set(c, i);
  });
  all.sort((a, b) => (pos.get(a.raw) ?? 0) - (pos.get(b.raw) ?? 0));
  return { bands, cutHz, hiCutHz, lines: all };
}

// ------------------------------------------------------------------------------------------------ presets
const pk = (k, hz, db, q) => ({ k, on: true, type: 'peak', hz, db, q });
const ls = (hz, db) => ({ k: 1, on: true, type: 'lowshelf', hz, db, q: Math.SQRT1_2 });
const hs = (hz, db) => ({ k: MAX_BANDS, on: true, type: 'highshelf', hz, db, q: Math.SQRT1_2 });
/**
 * "Start from" presets (curve prototype + AMENDMENT §6): name → target state for writesFor(). Each preset replaces
 * the whole slot EQ, cuts off. 'Wing channel' is the WING channel layout (L shelf, 4 PEQs, H shelf, all 0 dB); its
 * PEQ frequencies are ours (log-spaced), not verified against the console's factory values.
 */
export const EQ_PRESETS = Object.freeze({
  Flat: { bands: [ls(120, 0), hs(6000, 0)] },
  Warm: { bands: [ls(midiF(50), 3), pk(2, 3000, -3, 0.9), hs(8000, -2)] },
  Air: { bands: [ls(120, 0), pk(2, 250, -1.5, 1.2), pk(3, 4700, 1.5, 0.7), hs(10000, 4.5)] },
  'Cut mud': { bands: [ls(midiF(40), 2), pk(2, 250, -5, 1.3), pk(3, 880, 2, 1.4), hs(4200, -6)] },
  'Wing channel': { bands: [ls(120, 0), pk(2, 250, 0, 1), pk(3, 700, 0, 1), pk(4, 2000, 0, 1), pk(5, 4500, 0, 1),
    hs(6000, 0)] },
});
for (const p of Object.values(EQ_PRESETS)) {
  p.cutHz = FALLBACK_ROWS.cutHz.default;
  p.hiCutHz = FALLBACK_ROWS.hiCutHz.default;
  Object.freeze(p);
}
