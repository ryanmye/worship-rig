// Parameter address grammar + table (SPEC §4, REVIEW 4.2). Used by store.set, engine.setParam, MIDI learn, presets, UI.
// Gains are stored linear 0..2 (fader taper 2·pos³, displayed in dB). Frequencies Hz, times seconds.
import { noteName } from './music.js';

/** Number of fixed slots per patch. */
export const SLOT_COUNT = 4;

/**
 * @typedef {object} ParamEntry
 * @property {string} path     pattern; `<i>` = slot index 0..3, `<key>` = instrument param key
 * @property {number} [min]
 * @property {number} [max]
 * @property {number|boolean|string|null} default
 * @property {'lin'|'dB-display'|'dB'|'Hz'|'s'|'semis'|'midi'|'bool'|'enum'} unit  'dB' = a value stored in dB (EQ gains)
 * @property {'lin'|'log'} curve   UI mapping; 'dB-display' params use faderTaper() regardless
 * @property {string[]} [enum]
 * @property {number} [step]       1 for integer params
 * @property {string} label
 * @property {boolean} [dynamic]   true for slots.<i>.params.<key> (real range comes from listInstruments())
 */

const num = (path, min, max, def, unit, curve, label, extra = {}) =>
  Object.freeze({ path, min, max, default: def, unit, curve, label, ...extra });
const bool = (path, def, label) => Object.freeze({ path, min: 0, max: 1, default: def, unit: 'bool', curve: 'lin', label });
const enm = (path, values, def, label) =>
  Object.freeze({ path, default: def, unit: 'enum', curve: 'lin', enum: Object.freeze(values.slice()), label });

const MINUS6DB = Math.pow(10, -6 / 20);

/** Slot EQ band slots per slot (the WING bus count, design/eq/AMENDMENT.md §1). */
export const EQ_BAND_COUNT = 8;
/** Stored band types (AMENDMENT §2); 'off' = an unused band slot. */
export const EQ_BAND_TYPES = Object.freeze(['off', 'lowshelf', 'peak', 'highshelf', 'notch', 'lowcut', 'highcut']);
/** Default band frequencies: log-spaced from the legacy 120 Hz low shelf (b1) to the 6 kHz high shelf (b8). */
const EQ_BAND_HZ = [120, 210, 370, 640, 1100, 2000, 3400, 6000];

/** Rows `slots.<i>.eq.b<k>.{on,type,hz,db,q}` for k = 1..EQ_BAND_COUNT (AMENDMENT §4). */
function eqBandRows() {
  const rows = [];
  for (let k = 1; k <= EQ_BAND_COUNT; k++) {
    const p = `slots.<i>.eq.b${k}`;
    const edge = k === 1 || k === EQ_BAND_COUNT;
    rows.push(
      bool(`${p}.on`, edge, `Band ${k} on`),
      enm(`${p}.type`, EQ_BAND_TYPES, k === 1 ? 'lowshelf' : k === EQ_BAND_COUNT ? 'highshelf' : 'peak', `Band ${k} type`),
      num(`${p}.hz`, 20, 20000, EQ_BAND_HZ[k - 1], 'Hz', 'log', `Band ${k} Hz`),
      num(`${p}.db`, -15, 15, 0, 'dB', 'lin', `Band ${k} gain`),
      num(`${p}.q`, 0.1, 10, 1, 'lin', 'log', `Band ${k} Q`),
    );
  }
  return rows;
}

/** Ordered parameter table (SPEC §4). @type {ReadonlyArray<ParamEntry>} */
export const PARAMS = Object.freeze([
  // slots
  num('slots.<i>.gain', 0, 2, 0.8, 'dB-display', 'lin', 'Level'),
  num('slots.<i>.pan', -1, 1, 0, 'lin', 'lin', 'Pan'),
  num('slots.<i>.octave', -2, 2, 0, 'lin', 'lin', 'Octave', { step: 1 }),
  num('slots.<i>.transpose', -12, 12, 0, 'semis', 'lin', 'Transpose', { step: 1 }),
  num('slots.<i>.lowNote', 0, 127, 0, 'midi', 'lin', 'Low note', { step: 1 }),
  num('slots.<i>.highNote', 0, 127, 127, 'midi', 'lin', 'High note', { step: 1 }),
  bool('slots.<i>.sustain', true, 'Sustain pedal'),
  enm('slots.<i>.mono', ['off', 'lowest', 'highest'], 'off', 'Mono'),
  enm('slots.<i>.velocityCurve', ['soft', 'normal', 'hard', 'fixed'], 'normal', 'Velocity'),
  bool('slots.<i>.bendEnabled', false, 'Pitch bend'),
  num('slots.<i>.sends.reverb', 0, 1, 0, 'lin', 'lin', 'Reverb send'),
  num('slots.<i>.sends.delay', 0, 1, 0, 'lin', 'lin', 'Delay send'),
  num('slots.<i>.sends.chorus', 0, 1, 0, 'lin', 'lin', 'Chorus send'),
  // slot strip (engine-3): mid/side width (× the instrument's own widthDefault; 0 = mono, lows never widened) and the
  // slot EQ (eq.low / eq.high = the low / high shelf gains, unchanged since engine-3), both before the pan
  num('slots.<i>.width', 0, 1.5, 1, 'lin', 'lin', 'Stereo width'),
  num('slots.<i>.eq.low', -12, 12, 0, 'dB', 'lin', 'Low EQ'),
  num('slots.<i>.eq.high', -12, 12, 0, 'dB', 'lin', 'High EQ'),
  // slot EQ bands (design/eq/DECISION.md §2): two path segments only, because store.normalizeSlot nests one level.
  // Chain: low cut → low shelf → bell 1 → bell 2 → high shelf. Hz rows default to today's fixed shelves (120 Hz /
  // 6 kHz), so absent rows = the old 2-band strip. cutHz 20 = off (crossfaded out; a 20 Hz HP is −1.07 dB at A0).
  num('slots.<i>.eq.lowHz', 40, 500, 120, 'Hz', 'log', 'Low shelf Hz'),
  num('slots.<i>.eq.mid1', -12, 12, 0, 'dB', 'lin', 'Bell 1'),
  num('slots.<i>.eq.mid1Hz', 20, 20000, 400, 'Hz', 'log', 'Bell 1 Hz'),
  num('slots.<i>.eq.mid1Q', 0.3, 10, 1, 'lin', 'log', 'Bell 1 width'),
  num('slots.<i>.eq.mid2', -12, 12, 0, 'dB', 'lin', 'Bell 2'),
  num('slots.<i>.eq.mid2Hz', 20, 20000, 2500, 'Hz', 'log', 'Bell 2 Hz'),
  num('slots.<i>.eq.mid2Q', 0.3, 10, 1, 'lin', 'log', 'Bell 2 width'),
  num('slots.<i>.eq.highHz', 1000, 16000, 6000, 'Hz', 'log', 'High shelf Hz'),
  num('slots.<i>.eq.cutHz', 20, 400, 20, 'Hz', 'log', 'Low cut'),
  // WING-style variable bands (design/eq/AMENDMENT.md §4; supersedes the lowHz/mid*/highHz rows above, which the
  // engine still honours for a band that has no b-rows). Three path segments: store.normalizeSlot nests any depth.
  // b1 / b8 default to today's 120 Hz low shelf / 6 kHz high shelf, on, so a song without b-rows (or with eq.low /
  // eq.high only) sounds exactly as before; b2..b7 default off. hiCutHz 20000 = off (like cutHz 20).
  ...eqBandRows(),
  num('slots.<i>.eq.hiCutHz', 200, 20000, 20000, 'Hz', 'log', 'High cut'),
  // reverb
  num('fx.reverb.size', 0, 1, 0.5, 'lin', 'lin', 'Reverb size'),
  num('fx.reverb.damp', 0, 1, 0.5, 'lin', 'lin', 'Reverb damping'),
  num('fx.reverb.predelay', 0, 0.2, 0.02, 's', 'lin', 'Pre-delay'),
  num('fx.reverb.returnGain', 0, 2, 1, 'dB-display', 'lin', 'Space level'),
  // delay
  num('fx.delay.time', 0.05, 1.5, 0.375, 's', 'log', 'Delay time'),
  num('fx.delay.feedback', 0, 0.9, 0.35, 'lin', 'lin', 'Feedback'),
  bool('fx.delay.pingpong', false, 'Ping-pong'),
  num('fx.delay.tone', 0, 1, 0.5, 'lin', 'lin', 'Delay tone'),
  enm('fx.delay.sync', ['off', '1/4', '1/8d', '1/8'], 'off', 'Tempo sync'),
  num('fx.delay.returnGain', 0, 2, 1, 'dB-display', 'lin', 'Delay level'),
  // chorus
  num('fx.chorus.rate', 0.05, 3, 0.4, 'Hz', 'log', 'Chorus rate'),
  num('fx.chorus.depth', 0, 1, 0.5, 'lin', 'lin', 'Chorus depth'),
  num('fx.chorus.returnGain', 0, 2, 1, 'dB-display', 'lin', 'Chorus level'),
  // lofi (amount 0 = bit-exact bypass)
  num('fx.lofi.amount', 0, 1, 0, 'lin', 'lin', 'Lofi'),
  num('fx.lofi.wow', 0, 1, 0.5, 'lin', 'lin', 'Wow'),
  num('fx.lofi.flutter', 0, 1, 0.5, 'lin', 'lin', 'Flutter'),
  num('fx.lofi.crackle', 0, 1, 0.3, 'lin', 'lin', 'Crackle'),
  num('fx.lofi.bits', 0, 1, 0.5, 'lin', 'lin', 'Bit crush'),
  num('fx.lofi.tone', 0, 1, 0.5, 'lin', 'lin', 'Lofi tone'),
  num('fx.lofi.saturation', 0, 1, 0.5, 'lin', 'lin', 'Saturation'),
  // master EQ (after lofi, before master gain): low shelf 100 Hz, peaking 1 kHz (Q .8), high shelf 8 kHz
  num('fx.eq.low', -12, 12, 0, 'dB', 'lin', 'Master low'),
  num('fx.eq.mid', -12, 12, 0, 'dB', 'lin', 'Master mid'),
  num('fx.eq.high', -12, 12, 0, 'dB', 'lin', 'Master high'),
  // glue compressor (after the master EQ): 0 = bypassed (disconnected), 1 = thr −24 dB, ratio 4, unity at −23 dBFS
  num('fx.comp.amount', 0, 1, 0, 'lin', 'lin', 'Glue'),
  // master (default −6 dB, SPEC §3.1)
  num('master.volume', 0, 2, MINUS6DB, 'dB-display', 'lin', 'Master'),
  // drone
  num('drone.gain', 0, 2, MINUS6DB, 'dB-display', 'lin', 'Drone level'),
  num('drone.brightness', 0, 1, 0.5, 'lin', 'lin', 'Brightness'),
  num('drone.movement', 0, 1, 0.3, 'lin', 'lin', 'Movement'),
  num('drone.width', 0, 1, 0.7, 'lin', 'lin', 'Width'),
  num('drone.fade', 1, 20, 4, 's', 'lin', 'Key fade'),
]);

/** Generic entry for per-instrument params; real ranges come from engine.listInstruments(). */
export const INSTRUMENT_PARAM_ENTRY = Object.freeze({
  path: 'slots.<i>.params.<key>',
  dynamic: true,
  min: -Infinity,
  max: Infinity,
  default: null,
  unit: 'lin',
  curve: 'lin',
  label: 'Instrument parameter',
});

const BY_PATTERN = new Map(PARAMS.map((e) => [e.path, e]));
const SLOT_RE = /^slots\.(\d+)\.(.+)$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Normalise a concrete path to its table pattern.
 * @param {string} path
 * @returns {{pattern:string, slot:number|null, key:string|null}|null}
 */
export function parsePath(path) {
  if (typeof path !== 'string') return null;
  const m = SLOT_RE.exec(path);
  if (!m) return !path.startsWith('slots.') && BY_PATTERN.has(path) ? { pattern: path, slot: null, key: null } : null;
  if (!/^[0-3]$/.test(m[1])) return null;
  const slot = Number(m[1]);
  const rest = m[2];
  if (rest.startsWith('params.')) {
    const key = rest.slice(7);
    return KEY_RE.test(key) ? { pattern: 'slots.<i>.params.<key>', slot, key } : null;
  }
  const pattern = `slots.<i>.${rest}`;
  return BY_PATTERN.has(pattern) ? { pattern, slot, key: null } : null;
}

/**
 * Table entry for a concrete path ('slots.1.gain' → the 'slots.<i>.gain' entry).
 * @param {string} path
 * @returns {ParamEntry|null}
 */
export function describe(path) {
  const p = parsePath(path);
  if (!p) return null;
  return p.pattern === INSTRUMENT_PARAM_ENTRY.path ? INSTRUMENT_PARAM_ENTRY : BY_PATTERN.get(p.pattern);
}

/**
 * @param {string} path
 * @returns {boolean} true when the path is a valid parameter address (controlIds like 'panic' are not)
 */
export function isValidPath(path) {
  return parsePath(path) !== null;
}

/**
 * Every concrete non-dynamic path (slot patterns expanded for 0..3), in table order.
 * @returns {string[]}
 */
export function expandPaths() {
  const out = [];
  for (const e of PARAMS) {
    if (e.path.includes('<i>')) for (let i = 0; i < SLOT_COUNT; i++) out.push(e.path.replace('<i>', String(i)));
    else out.push(e.path);
  }
  return out;
}

/**
 * Coerce and clamp a value for a path.
 * numbers: Number(value), NaN → default (dynamic: NaN → null), clamp to [min,max], round when step=1.
 * bool: booleans as-is; numbers → value >= 0.5; 'true'/'on'/'1' → true; else false.
 * enum: a member → itself; a number → enum[clamped round(index)]; else default.
 * @param {string} path
 * @param {*} value
 * @returns {number|boolean|string|null}
 * @throws {TypeError} unknown path (check isValidPath first)
 */
export function clamp(path, value) {
  const e = describe(path);
  if (!e) throw new TypeError(`params.clamp: unknown path "${path}"`);
  if (e.unit === 'bool') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value >= 0.5;
    if (typeof value === 'string') return ['true', 'on', '1'].includes(value.toLowerCase());
    return false;
  }
  if (e.unit === 'enum') {
    if (e.enum.includes(value)) return value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      const i = Math.min(e.enum.length - 1, Math.max(0, Math.round(value)));
      return e.enum[i];
    }
    return e.default;
  }
  if (e.dynamic && typeof value === 'boolean') return value;
  let v = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(v) || value === null || value === undefined || value === '') return e.default;
  v = Math.min(e.max, Math.max(e.min, v));
  if (e.step === 1) v = Math.round(v);
  return v;
}

/**
 * Fader position → linear gain: 2·pos³ (top ≈ +6 dB). pos clamped to 0..1.
 * @param {number} pos01
 * @returns {number} 0..2
 */
export function faderTaper(pos01) {
  const p = Math.min(1, Math.max(0, Number(pos01) || 0));
  return 2 * p * p * p;
}

/**
 * Linear gain → fader position (inverse of faderTaper), clamped 0..1.
 * @param {number} gain
 * @returns {number}
 */
export function inverseTaper(gain) {
  const g = Number(gain);
  if (!(g > 0)) return 0;
  return Math.min(1, Math.cbrt(g / 2));
}

/**
 * @param {number} g linear gain
 * @returns {number} dB (−Infinity for g <= 0)
 */
export function gainToDb(g) {
  return g > 0 ? 20 * Math.log10(g) : -Infinity;
}

/**
 * @param {number} db
 * @returns {number} linear gain (0 for −Infinity)
 */
export function dbToGain(db) {
  return db === -Infinity ? 0 : Math.pow(10, db / 20);
}

const MINUS = '−';
const signed = (n, digits) => {
  const s = Math.abs(n).toFixed(digits);
  if (Number(s) === 0) return (0).toFixed(digits);
  return (n < 0 ? MINUS : '+') + s;
};

/**
 * Human-readable value for UI labels.
 * gain → "−6.0 dB" / "+3.5 dB" / "0.0 dB" / "−∞ dB"; Hz → "0.40 Hz" / "180 Hz" / "1.8 kHz";
 * s → "350 ms" / "1.20 s"; dB (EQ) → "+3.0 dB" / "0.0 dB"; width → "80%"; bool → "On"/"Off"; semis → "+2 st"; midi → "C4"; pan → "L 50" / "C" / "R 50";
 * octave → "+1"; 0..1 params → "50%"; enum → the value.
 * @param {string} path
 * @param {*} value
 * @returns {string}
 */
export function formatValue(path, value) {
  const e = describe(path);
  if (!e) return String(value);
  switch (e.unit) {
    case 'bool':
      return clamp(path, value) ? 'On' : 'Off';
    case 'enum':
      return String(clamp(path, value));
    case 'dB-display': {
      const db = gainToDb(Number(value));
      if (db === -Infinity) return `${MINUS}∞ dB`;
      return `${db > -0.05 && db < 0.05 ? '0.0' : signed(db, 1)} dB`;
    }
    case 'Hz': {
      const f = Number(value);
      if (f >= 1000) return `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)} kHz`;
      if (f >= 10) return `${Math.round(f)} Hz`;
      return `${f.toFixed(2)} Hz`;
    }
    case 's': {
      const s = Number(value);
      return s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`;
    }
    case 'dB': {
      const d = Number(value);
      return `${Math.abs(d) < 0.05 ? '0.0' : signed(d, 1)} dB`;
    }
    case 'semis':
      return `${signed(Math.round(Number(value)), 0)} st`;
    case 'midi':
      return noteName(Number(value));
    default: {
      const v = Number(value);
      if (e.path === 'slots.<i>.pan') {
        const pct = Math.round(Math.abs(v) * 100);
        return pct === 0 ? 'C' : `${v < 0 ? 'L' : 'R'} ${pct}`;
      }
      if (e.step === 1) return signed(Math.round(v), 0);
      if (e.path === 'slots.<i>.width') return `${Math.round(v * 100)}%`;
      if (e.min === 0 && e.max === 1) return `${Math.round(v * 100)}%`;
      if (typeof value === 'boolean') return value ? 'On' : 'Off';
      return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : String(value);
    }
  }
}

/** MIDI-learnable controlIds (SPEC §4). Buttons: note-on or CC ≥ 64; faders: pickup mode. */
export const LEARNABLE = Object.freeze([
  'slots.0.gain', 'slots.1.gain', 'slots.2.gain', 'slots.3.gain',
  'drone.gain', 'fx.reverb.returnGain', 'master.volume',
  'nextSong', 'prevSong', 'panic', 'fadeOutAll', 'swell',
]);

/**
 * @param {string} controlId
 * @returns {boolean}
 */
export function isLearnable(controlId) {
  return LEARNABLE.includes(controlId);
}

/**
 * @param {string} controlId
 * @returns {boolean} true for momentary actions (nextSong/prevSong/panic/fadeOutAll/swell), false for faders
 */
export function isLearnButton(controlId) {
  return isLearnable(controlId) && !isValidPath(controlId);
}

/** Per-role slot defaults (roles 0 Keys, 1 Pad, 2 Extra, 3 Bass). */
export const ROLE_DEFAULTS = Object.freeze([
  Object.freeze({ name: 'Keys', color: 'orange', sustain: true, sends: Object.freeze({ reverb: 0.25, delay: 0.1, chorus: 0 }) }),
  Object.freeze({ name: 'Pad', color: 'green', sustain: true, sends: Object.freeze({ reverb: 0.5, delay: 0.15, chorus: 0.4 }) }),
  Object.freeze({ name: 'Extra', color: 'blue', sends: Object.freeze({ reverb: 0.35, delay: 0.2, chorus: 0.2 }) }),
  Object.freeze({ name: 'Bass', color: 'purple', mono: 'lowest', highNote: 59, sends: Object.freeze({ reverb: 0, delay: 0, chorus: 0 }) }),
]);

/**
 * Fresh, fully-populated Slot for a role.
 * @param {number} roleIndex 0..3
 * @param {{type:'sampler'|'synth'|'organ', id:string}} instrumentRef
 * @returns {object} Slot (SPEC §2)
 * @throws {RangeError} bad role; {TypeError} bad instrumentRef
 */
export function defaultSlot(roleIndex, instrumentRef) {
  const role = ROLE_DEFAULTS[roleIndex];
  if (!Number.isInteger(roleIndex) || !role) throw new RangeError(`defaultSlot: roleIndex must be 0..3, got ${roleIndex}`);
  if (!instrumentRef || typeof instrumentRef.type !== 'string' || typeof instrumentRef.id !== 'string') {
    throw new TypeError('defaultSlot: instrumentRef must be {type, id}');
  }
  const { type, id } = instrumentRef;
  return {
    instrument: { type, id },
    gain: 0.8,
    pan: 0,
    octave: 0,
    transpose: 0,
    lowNote: 0,
    highNote: role.highNote ?? 127,
    sustain: role.sustain ?? true,
    bendEnabled: type === 'synth' || type === 'organ',
    mono: role.mono ?? 'off',
    velocityCurve: 'normal',
    sends: { ...role.sends },
    params: {},
  };
}
