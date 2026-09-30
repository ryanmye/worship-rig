// Worship Rig state model + persistence (SPEC §2, REVIEW 4.9, 6.9). Pure ES module: no DOM, no Web Audio.
//
// State shape (schema 1):
//   { schema:1,
//     songs: { [id]: Song }, songOrder: [id],            // library (map + display order)
//     setlists: { [id]: Setlist }, setlistOrder: [id],
//     settings: Settings,                                 // SPEC §2 + setlistIndex (position in current setlist)
//     meta: { factorySeeded, factoryVersion, createdAt } }
// Everything returned by get() is deep-frozen; change it only through set()/update()/helpers.
//
// Paths for set(path, value):
//   • §4 parameter grammar → the CURRENT song: 'slots.1.gain', 'fx.reverb.size', 'master.volume', 'drone.gain'
//   • 'song.<field…>' → the current song: 'song.hearIn', 'song.patch.modWheel.target', 'song.drone.mode'
//   • entity paths: 'songs.<id>.name', 'songs.<id>.patch.slots.0.instrument', 'setlists.<id>.songIds',
//     'settings.latency', 'songOrder', 'setlistOrder'
//   • current-song slot aliases (not §4 grammar): 'slots.<i>' (create with a Slot / clear with null),
//     'slots.<i>.instrument' (change the instrument; params reset), 'slots.<i>.muted' (true/false),
//     'slots.<i>.mutedGain' (ui-core compat) — all resolve to 'songs.<cur>.patch.slots.<i>…'
// Values are validated/clamped (params.clamp); invalid writes return false and warn. Numeric params must be finite
// numbers (NaN/Infinity/strings/null are rejected). Path segments that collide with Object.prototype
// ('__proto__', 'constructor', 'toString', …) are rejected.
// Slot mute (SPEC §10): Slot.muted:true + Slot.gainBeforeMute (absent when unmuted); the engine only sees gain (0 while muted).
//   ui-core's convention (gain 0 + mutedGain) is accepted and mirrored: mutedGain === gainBeforeMute while muted.
// Persistence: debounced; a failed save is retried (1 s, 5 s, 30 s, then every 30 s) and flushed on pagehide /
//   visibility hidden. loadInfo.readOnly = true means nothing is written (an unreadable library whose backup
//   could not be written, or a second window — setReadOnly()); onInfo(fn) reports loadInfo changes.
// subscribe((state, changedPaths) => …) is batched per microtask; changedPaths are canonical entity paths
// ('songs.<id>.patch.slots.1.gain', 'songs.<id>.drone.gain', 'settings.view', …).
import { mod12, transposeSemis } from './shared/music.js';
import { isValidId as isThemeId, DEFAULT_THEME_ID } from './shared/themes.js';
import { PARAMS, clamp, describe, isValidPath, parsePath, defaultSlot, SLOT_COUNT } from './shared/params.js';
import {
  FACTORY_SONGS, FACTORY_VERSION, FACTORY_SINCE, CATEGORIES, WHEEL_TARGETS, BEND_MODES, DRONE_MODES, defaultFx, defaultDrone, defaultRouting,
  blankSong, factoryById,
} from './presets.js';

export const SCHEMA = 1;
export const STORAGE_KEY = 'rig.v1';
export const INSTRUMENT_TYPES = Object.freeze(['sampler', 'synth', 'organ']);
export const LATENCIES = Object.freeze(['lowest', 'balanced', 'safe']);
export const VELOCITY_SENS = Object.freeze(['soft', 'normal', 'hard', 'fixed']);
export const VIEWS = Object.freeze(['perform', 'edit']);
/** Song categories the UI groups by (factory categories incl. 'synth', plus 'user'). Unknown strings are kept. */
export const SONG_CATEGORIES = Object.freeze([...CATEGORIES, 'user']);
/** Settings that belong to this machine and survive a replace-import. */
// menubar-A (C7): menu-bar mode and low-resource are how this machine runs the app, not library content.
export const DEVICE_LOCAL_SETTINGS = Object.freeze([
  'outputDeviceId', 'padFolder', 'midiInputId', 'midiInputName', 'menuBarMode', 'lowResource', 'audioSleepSec',
]);
/**
 * lowres2: settings.audioSleepSec (optional; absent = AUDIO_SLEEP_DEFAULT_SEC): suspend the audio after this many
 * seconds with nothing to play and no input; 0 = never. Whole seconds 0..AUDIO_SLEEP_MAX_SEC. lowres2-scope (Ryan
 * 2026-09-30): the low-resource idle window only (the controller never sleeps outside low-resource); no Settings UI.
 */
export const AUDIO_SLEEP_DEFAULT_SEC = 30;
export const AUDIO_SLEEP_MAX_SEC = 3600;
/** @param {*} v @returns {number|null} the valid audioSleepSec for `v`, null when it is not a number */
export function validAudioSleepSec(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(AUDIO_SLEEP_MAX_SEC, Math.max(0, Math.round(v)));
}
/** @param {object} settings @returns {number} effective audioSleepSec (the default when absent/invalid) */
export function audioSleepSecOf(settings) {
  const v = validAudioSleepSec(settings && settings.audioSleepSec);
  return v === null ? AUDIO_SLEEP_DEFAULT_SEC : v;
}
/** Settings that only move around the library (not an edit of it; round2-shell #2). */
const NAV_SETTINGS = new Set(['currentSongId', 'setlistIndex', 'currentSetlistId']);
/** Settings that change how the app looks, not the library (themes-setup): they don't mark it edited. */
const LOOK_SETTINGS = new Set(['theme']);
/** @param {string} p changed path @returns {boolean} the change edits library content (songs, setlists, settings) */
function isEditPath(p) {
  if (p.startsWith('meta.') || p === 'meta' || p === 'schema') return false;
  if (p.startsWith('settings.')) {
    const k = p.split('.')[1];
    return !NAV_SETTINGS.has(k) && !DEVICE_LOCAL_SETTINGS.includes(k) && !LOOK_SETTINGS.has(k);
  }
  return true;
}

export const DEFAULT_SETTINGS = Object.freeze({
  latency: 'lowest',
  outputDeviceId: 'default',
  monoOutput: false,
  midiInputId: 'first',
  /** Name of the explicitly chosen MIDI input (midi-default): a re-plugged device with a new id is matched by it. */
  midiInputName: null,
  programChange: false,
  pedalInvert: false,
  velocitySens: 'normal',
  midiLearn: Object.freeze({}),
  padFolder: null,
  currentSetlistId: null,
  currentSongId: null,
  setlistIndex: -1,
  /** true = the current entry was removed from the setlist: prev/next are setlistIndex−1 / setlistIndex. */
  setlistGap: false,
  view: 'perform',
  performLock: false,
  computerKeyboard: true,
  // menu-bar mode (docs/menubar-mode.md; C7 menubar-A)
  /** Setlist whose songs are the menu-bar modes (null = the first 3 songs of the current setlist). */
  menuBarSetlistId: null,
  /** Low-resource mode, on by choice (it also turns on by itself while hidden in menu-bar mode). */
  lowResource: false,
  /** Live in the menu bar (Electron: tray, hide-on-close, no Dock icon). */
  menuBarMode: false,
});

export class FutureSchemaError extends Error {
  constructor(schema) {
    super(`Library schema ${schema} is newer than this app (${SCHEMA})`);
    this.name = 'FutureSchemaError';
    this.schema = schema;
  }
}

// ---------------------------------------------------------------------------------------------
// small utils
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const INVALID = Symbol('invalid');
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Keys that must never be used as object keys from user data (prototype pollution / shadowing). */
export const isReservedKey = (k) => typeof k !== 'string' || RESERVED_KEYS.has(k) || Object.prototype.hasOwnProperty.call(Object.prototype, k);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** How many `rig.v1.backup-<ts>` keys are kept in localStorage. */
export const BACKUPS_KEEP = 3;
/**
 * security S2: the largest library (compact JSON characters) an import may leave behind. Chromium's localStorage holds
 * ~5.2 M characters per origin (measured), shared with the backup copies; a bigger library makes every later save
 * fail (QuotaExceededError) until the offending song is deleted. A real library is ~2 KB per song.
 */
export const LIBRARY_MAX_CHARS = 2000000;
/** security S2: deepest nesting an import may have (real exports reach ~8: songs.<id>.patch.slots.<i>.eq.b3.hz). */
export const IMPORT_MAX_DEPTH = 64;

/** Iterative (no recursion, so a hostile file can't blow the stack): does `v` nest deeper than `max`? */
function nestsDeeperThan(v, max) {
  const stack = [[v, 0]];
  while (stack.length) {
    const [o, d] = stack.pop();
    if (o === null || typeof o !== 'object') continue;
    if (d >= max) return true;
    for (const k of Object.keys(o)) stack.push([o[k], d + 1]);
  }
  return false;
}
/** Retry delays after a failed save (the last one repeats). */
export const PERSIST_RETRY_MS = Object.freeze([1000, 5000, 30000]);

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
  return true;
}

function getIn(obj, segs) {
  let o = obj;
  for (const s of segs) {
    if (o === null || typeof o !== 'object') return undefined;
    o = o[s];
  }
  return o;
}

/** Immutable set; new containers are frozen. value === undefined deletes the key. */
function setIn(obj, segs, value) {
  if (segs.length === 0) return value;
  const [head, ...rest] = segs;
  const isArr = Array.isArray(obj);
  const base = obj && typeof obj === 'object' ? obj : {};
  const copy = isArr ? base.slice() : { ...base };
  const key = isArr ? Number(head) : head;
  const next = setIn(base[key], rest, value);
  if (next === undefined && !isArr) delete copy[key];
  else copy[key] = next;
  return Object.freeze(copy);
}

/** Leaf-ish changed paths between two states (arrays of primitives, or of different lengths, are reported whole). */
export function diffPaths(a, b, prefix = '', out = [], depth = 0) {
  if (deepEqual(a, b)) return out;
  const objArrays = Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.some((x) => x && typeof x === 'object');
  if ((!isObj(a) || !isObj(b)) && !objArrays) {
    out.push(prefix);
    return out;
  }
  if (depth > 8) {
    out.push(prefix);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) diffPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k, out, depth + 1);
  return out;
}

const int = (v, lo, hi, def) => {
  const n = Number(v);
  if (!Number.isFinite(n) || typeof v === 'boolean' || v === null || v === '') return def;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};
const num = (v, lo, hi, def) => {
  const n = Number(v);
  if (!Number.isFinite(n) || typeof v === 'boolean' || v === null || v === '') return def;
  return Math.min(hi, Math.max(lo, n));
};
const pc = (v, def) => (Number.isFinite(Number(v)) && v !== null && v !== '' && typeof v !== 'boolean' ? mod12(Number(v)) : def);
const oneOf = (v, list, def) => (list.includes(v) ? v : def);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
/**
 * Strict write value for a §4 path (L1): numeric entries accept only finite numbers (then clamp); booleans and
 * enums keep params.clamp's coercion; dynamic instrument params also accept booleans/strings.
 * @returns {*|typeof INVALID}
 */
function strictParam(p, value) {
  const e = describe(p);
  if (!e) return INVALID;
  if (e.unit === 'bool' || e.unit === 'enum') return clamp(p, value);
  if (e.dynamic && (typeof value === 'boolean' || typeof value === 'string')) return value;
  if (!finite(value)) return INVALID;
  const v = clamp(p, value);
  return v === null || v === undefined ? INVALID : v;
}
const bool = (v, def) => (typeof v === 'boolean' ? v : def);
const str = (v, def, max = 200) => (typeof v === 'string' ? v.slice(0, max) : def);

// ---------------------------------------------------------------------------------------------
// normalisers (idempotent; unknown fields preserved)
const SLOT_LEAVES = ['gain', 'pan', 'octave', 'transpose', 'lowNote', 'highNote', 'sustain', 'mono', 'velocityCurve', 'bendEnabled'];
const SEND_KEYS = ['reverb', 'delay', 'chorus'];
/**
 * Slot params from the PARAMS table beyond the leaves and sends (e.g. 'width', 'eq.low', 'eq.high'): optional in a
 * Slot (absent = the engine default), clamped when present. Derived from the table so new strip params need no
 * store change.
 */
const SLOT_EXTRA = PARAMS.filter((e) => e.path.startsWith('slots.<i>.') && !e.dynamic)
  .map((e) => e.path.slice('slots.<i>.'.length))
  .filter((rel) => !SLOT_LEAVES.includes(rel) && !rel.startsWith('sends.'))
  .map((rel) => rel.split('.'));
/** fx.<unit>.<key> / master.<key> entries of the table as [unit, key] (units beyond defaultFx(), e.g. eq/comp, too). */
const FX_ENTRIES = PARAMS.filter((e) => e.path.startsWith('fx.') || e.path.startsWith('master.')).map((e) => {
  const segs = e.path.split('.');
  return segs[0] === 'master' ? ['master', segs[1], e.path] : [segs[1], segs[2], e.path];
});

export function isInstrumentRef(ref) {
  return isObj(ref) && INSTRUMENT_TYPES.includes(ref.type) && typeof ref.id === 'string' && ref.id.length > 0;
}

function cleanInstrumentParams(p) {
  const out = {};
  if (!isObj(p)) return out;
  for (const [k, v] of Object.entries(p)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || isReservedKey(k)) continue;
    if (typeof v === 'number' ? Number.isFinite(v) : typeof v === 'boolean' || typeof v === 'string') out[k] = v;
  }
  return out;
}

export function normalizeSlot(raw, i) {
  if (!isObj(raw) || !isInstrumentRef(raw.instrument)) return null;
  const inst = { ...raw.instrument, type: raw.instrument.type, id: raw.instrument.id };
  const d = defaultSlot(i, inst);
  const out = { ...d, ...raw, instrument: inst };
  for (const k of SLOT_LEAVES) out[k] = clamp(`slots.${i}.${k}`, raw[k] === undefined ? d[k] : raw[k]);
  if (out.lowNote > out.highNote) [out.lowNote, out.highNote] = [out.highNote, out.lowNote];
  const sends = { ...d.sends, ...(isObj(raw.sends) ? raw.sends : {}) };
  for (const k of SEND_KEYS) sends[k] = clamp(`slots.${i}.sends.${k}`, sends[k]);
  out.sends = sends;
  for (const segs of SLOT_EXTRA) {
    const v = getIn(raw, segs);
    if (v === undefined) continue;
    const c = clamp(`slots.${i}.${segs.join('.')}`, v);
    // any depth (eq.b3.hz, design/eq/AMENDMENT.md §4): copy each container on the way down, never mutate `raw`
    let o = out;
    for (const s of segs.slice(0, -1)) o = o[s] = { ...(isObj(o[s]) ? o[s] : {}) };
    o[segs[segs.length - 1]] = c;
  }
  out.params = cleanInstrumentParams(raw.params);
  return normalizeMute(out, raw);
}

/** Canonical mute fields (see header). */
function normalizeMute(out, raw) {
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  let before = fin(raw.gainBeforeMute) ? raw.gainBeforeMute : fin(raw.mutedGain) ? raw.mutedGain : null;
  let muted = raw.muted === true || (raw.muted === undefined && out.gain === 0 && before !== null);
  delete out.muted;
  delete out.gainBeforeMute;
  delete out.mutedGain;
  if (muted) {
    if (before === null || before <= 0) before = out.gain > 0 ? out.gain : 0.8;
    before = Math.min(2, Math.max(0, before));
    out.gain = 0;
    out.muted = true;
    out.gainBeforeMute = before;
    out.mutedGain = before;
  }
  return out; // unmuted slots carry no mute fields (muted is absent = false)
}

export function normalizeFx(raw) {
  const def = defaultFx();
  const src = isObj(raw) ? raw : {};
  const out = { ...src };
  for (const unit of Object.keys(def)) out[unit] = { ...def[unit], ...(isObj(src[unit]) ? src[unit] : {}) };
  // clamp every table param that is present (units outside defaultFx(), e.g. eq/comp, stay optional)
  for (const [unit, k, p] of FX_ENTRIES) {
    if (!isObj(out[unit]) || out[unit][k] === undefined) continue;
    if (out[unit] === src[unit]) out[unit] = { ...out[unit] };
    out[unit][k] = clamp(p, out[unit][k]);
  }
  return out;
}

function normalizeWheel(raw, defTarget) {
  const w = isObj(raw) ? raw : {};
  return { ...w, target: oneOf(w.target, WHEEL_TARGETS, defTarget), min: num(w.min, 0, 1, 0), max: num(w.max, 0, 1, 1) };
}

export function normalizePatch(raw) {
  const p = isObj(raw) ? raw : {};
  const r = defaultRouting();
  const slots = Array.isArray(p.slots) ? p.slots : [];
  const bend = isObj(p.bend) ? p.bend : {};
  const swell = isObj(p.swell) ? p.swell : {};
  const vol = isObj(p.volume) ? p.volume : {};
  return {
    ...p,
    slots: Array.from({ length: SLOT_COUNT }, (_, i) => normalizeSlot(slots[i], i)),
    fx: normalizeFx(p.fx),
    modWheel: normalizeWheel(p.modWheel, r.modWheel.target),
    expression: normalizeWheel(p.expression, r.expression.target),
    volume: { ...vol, target: oneOf(vol.target, WHEEL_TARGETS, r.volume.target) },
    bend: { ...bend, mode: oneOf(bend.mode, BEND_MODES, r.bend.mode), range: int(bend.range, 0, 24, r.bend.range) },
    swell: { ...swell, seconds: num(swell.seconds, 1, 60, r.swell.seconds) },
  };
}

export function normalizeDrone(raw) {
  const d = defaultDrone('off');
  const src = isObj(raw) ? raw : {};
  const out = { ...d, ...src };
  out.mode = oneOf(out.mode, DRONE_MODES, 'off');
  for (const k of ['gain', 'brightness', 'movement', 'width', 'fade']) out[k] = clamp(`drone.${k}`, out[k]);
  for (const k of ['chordFollow', 'continueAcrossSongs', 'minorUsesRelativeMajorFile']) out[k] = bool(out[k], d[k]);
  return out;
}

export function normalizeSong(raw, id) {
  if (!isObj(raw)) return null;
  const out = { ...raw };
  out.id = typeof id === 'string' && id ? id : typeof raw.id === 'string' && raw.id ? raw.id : null;
  out.name = str(raw.name, 'Untitled', 120);
  out.notes = str(raw.notes, '', 10000);
  out.playIn = pc(raw.playIn, 0);
  out.hearIn = pc(raw.hearIn, out.playIn);
  out.transposeOctave = int(raw.transposeOctave, -1, 1, 0);
  out.minor = bool(raw.minor, false);
  out.tempo = raw.tempo === null || raw.tempo === undefined ? null : num(raw.tempo, 30, 300, null);
  out.patch = normalizePatch(raw.patch);
  out.drone = normalizeDrone(raw.drone);
  return out;
}

function normalizeSetlist(raw, id, songs) {
  if (!isObj(raw)) return null;
  const ids = Array.isArray(raw.songIds) ? raw.songIds.filter((s) => typeof s === 'string' && songs[s]) : [];
  return { ...raw, id, name: str(raw.name, 'Setlist', 120), songIds: ids };
}

function normalizeMidiLearn(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!isObj(v) || isReservedKey(k)) continue;
    const ch = v.channel === null || v.channel === undefined ? null : int(v.channel, 0, 15, null);
    if (Number.isInteger(v.cc) && v.cc >= 0 && v.cc <= 127) out[k] = { ...v, channel: ch };
    else if (Number.isInteger(v.note) && v.note >= 0 && v.note <= 127) out[k] = { ...v, channel: ch };
  }
  return out;
}

const SETTINGS_VALIDATORS = {
  latency: (v) => oneOf(v, LATENCIES, INVALID),
  outputDeviceId: (v) => (typeof v === 'string' && v ? v : INVALID),
  monoOutput: (v) => bool(v, INVALID),
  midiInputId: (v) => (typeof v === 'string' && v ? v : INVALID),
  midiInputName: (v) => (v === null ? null : typeof v === 'string' && v ? v : INVALID),
  programChange: (v) => bool(v, INVALID),
  pedalInvert: (v) => bool(v, INVALID),
  velocitySens: (v) => oneOf(v, VELOCITY_SENS, INVALID),
  midiLearn: (v) => (isObj(v) ? normalizeMidiLearn(v) : INVALID),
  padFolder: (v) => (v === null ? null : isObj(v) && (v.kind === 'electron' || v.kind === 'fsa') ? { ...v } : INVALID),
  currentSetlistId: (v) => (v === null || typeof v === 'string' ? v : INVALID),
  currentSongId: (v) => (v === null || typeof v === 'string' ? v : INVALID),
  setlistIndex: (v) => int(v, -1, 1e6, INVALID),
  setlistGap: (v) => bool(v, INVALID),
  view: (v) => oneOf(v, VIEWS, INVALID),
  performLock: (v) => bool(v, INVALID),
  computerKeyboard: (v) => bool(v, INVALID),
  menuBarSetlistId: (v) => (v === null || (typeof v === 'string' && v) ? v : INVALID),
  lowResource: (v) => bool(v, INVALID),
  menuBarMode: (v) => bool(v, INVALID),
};

function normalizeSettings(raw, songs, setlists) {
  const src = isObj(raw) ? raw : {};
  const out = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(src)) if (!isReservedKey(k)) out[k] = v;
  for (const [k, fn] of Object.entries(SETTINGS_VALIDATORS)) {
    const v = fn(out[k]);
    out[k] = v === INVALID ? clone(DEFAULT_SETTINGS[k]) : v;
  }
  if (out.currentSetlistId !== null && !setlists[out.currentSetlistId]) out.currentSetlistId = null;
  if (out.menuBarSetlistId !== null && !setlists[out.menuBarSetlistId]) out.menuBarSetlistId = null; // menubar-A
  if (out.currentSongId !== null && !songs[out.currentSongId]) out.currentSongId = null;
  // themes-setup: settings.theme is optional (absent = DEFAULT_THEME_ID, so no SCHEMA bump); an id that is no longer
  // registered falls back to the default instead of throwing or keeping a dead value
  if (hasOwn(out, 'theme') && out.theme !== undefined && !isThemeId(out.theme)) out.theme = DEFAULT_THEME_ID;
  if (hasOwn(out, 'audioSleepSec')) {
    // lowres2: optional; an invalid value is dropped (absent = the default), never kept
    const v = validAudioSleepSec(out.audioSleepSec);
    if (v === null) delete out.audioSleepSec;
    else out.audioSleepSec = v;
  }
  return out;
}

function orderOf(order, map) {
  const seen = new Set();
  const out = [];
  if (Array.isArray(order)) for (const id of order) if (typeof id === 'string' && map[id] && !seen.has(id)) seen.add(id) && out.push(id);
  for (const id of Object.keys(map)) if (!seen.has(id)) out.push(id);
  return out;
}

/**
 * Array form (hand-written files / song arrays) → id map. Missing or duplicate ids get unique ids (`<id>~2`, …);
 * references by id (setlists) keep pointing at the first entry with that id.
 */
function entriesFromArray(arr, prefix) {
  const out = Object.create(null);
  arr.forEach((s, i) => {
    if (!isObj(s)) return;
    let id = typeof s.id === 'string' && s.id && !isReservedKey(s.id) ? s.id : `${prefix}-import${i}`;
    if (id in out) {
      let n = 2;
      while (`${id}~${n}` in out) n += 1;
      id = `${id}~${n}`;
    }
    out[id] = s;
  });
  return out;
}

/**
 * Migrate/normalise a raw state object to schema 1. Idempotent; unknown fields are preserved.
 * @param {object} raw
 * @returns {object} normalised (not frozen) state
 * @throws {FutureSchemaError} schema newer than SCHEMA; {TypeError} not a state object
 */
export function migrate(raw) {
  if (!isObj(raw)) throw new TypeError('migrate: state must be an object');
  const schema = raw.schema === undefined ? SCHEMA : raw.schema;
  if (typeof schema !== 'number' || !Number.isFinite(schema)) throw new TypeError('migrate: bad schema');
  if (schema > SCHEMA) throw new FutureSchemaError(schema);
  const out = { ...raw, schema: SCHEMA };
  // songs: map (array accepted for hand-written files)
  const songs = {};
  const srcSongs = Array.isArray(raw.songs) ? entriesFromArray(raw.songs, 'song') : isObj(raw.songs) ? raw.songs : {};
  for (const [id, s] of Object.entries(srcSongs)) {
    if (!id || id === 'undefined' || isReservedKey(id)) continue;
    const n = normalizeSong(s, id);
    if (n) songs[id] = n;
  }
  out.songs = songs;
  out.songOrder = orderOf(raw.songOrder, songs);
  const setlists = {};
  const srcSets = Array.isArray(raw.setlists) ? entriesFromArray(raw.setlists, 'set') : isObj(raw.setlists) ? raw.setlists : {};
  for (const [id, s] of Object.entries(srcSets)) {
    if (!id || id === 'undefined' || isReservedKey(id)) continue;
    const n = normalizeSetlist(s, id, songs);
    if (n) setlists[id] = n;
  }
  out.setlists = setlists;
  out.setlistOrder = orderOf(raw.setlistOrder, setlists);
  out.settings = normalizeSettings(raw.settings, songs, setlists);
  if (out.settings.currentSetlistId === null && out.setlistOrder.length) out.settings.currentSetlistId = out.setlistOrder[0];
  if (out.settings.currentSongId === null) {
    const sl = out.settings.currentSetlistId ? setlists[out.settings.currentSetlistId] : null;
    out.settings.currentSongId = (sl && sl.songIds[0]) || out.songOrder[0] || null;
  }
  const meta = isObj(raw.meta) ? raw.meta : {};
  out.meta = { ...meta, factorySeeded: bool(meta.factorySeeded, out.songOrder.length > 0) };
  return out;
}

/** Empty (unseeded) schema-1 state. */
export function emptyState(now = Date.now()) {
  return migrate({ schema: SCHEMA, songs: {}, setlists: {}, settings: {}, meta: { factorySeeded: false, createdAt: now } });
}

/**
 * Transpose (semitones incl. octave) implied by a song's Play-In/Hear-In/octave (SPEC §2, REVIEW 1.10).
 * @param {{playIn:number, hearIn:number, transposeOctave?:number}} song
 * @returns {number}
 */
export function transposeSemisOf(song) {
  if (!song) return 0;
  return transposeSemis(song.playIn, song.hearIn) + 12 * (song.transposeOctave || 0);
}

/** In-memory Storage-like adapter (node tests, private windows). */
export function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
    keys: () => [...m.keys()],
    _map: m,
  };
}

function defaultStorage() {
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      const probe = '__rig_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return ls;
    }
  } catch {
    /* blocked storage → memory */
  }
  return memoryStorage();
}

let idCounter = 0;
function defaultIdGen(prefix) {
  idCounter = (idCounter + 1) % 1296;
  const rand = Math.floor(Math.random() * 36 ** 5).toString(36).padStart(5, '0');
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36).padStart(2, '0')}${rand}`;
}

// ---------------------------------------------------------------------------------------------
/**
 * @param {object} [opts]
 * @param {Storage|{getItem,setItem,removeItem}} [opts.storage]  default localStorage (memory if blocked)
 * @param {() => number} [opts.now]
 * @param {string} [opts.key='rig.v1']
 * @param {number} [opts.debounceMs=300]
 * @param {ReadonlyArray<object>} [opts.factory=FACTORY_SONGS]
 * @param {boolean} [opts.seed=true]  seed factory songs on first run
 * @param {(prefix:string) => string} [opts.idGen]
 * @param {{setTimeout:Function, clearTimeout:Function}} [opts.timers]
 * @param {Function|null} [opts.requestIdle]  requestIdleCallback (default global if present)
 * @param {(msg:string)=>void} [opts.warn]
 * @param {boolean} [opts.autoFlush=true]  persist on pagehide / visibility hidden (browser only)
 */
export function createStore(opts = {}) {
  const storage = opts.storage || defaultStorage();
  const now = opts.now || (() => Date.now());
  const key = opts.key || STORAGE_KEY;
  const debounceMs = opts.debounceMs ?? 300;
  const factory = opts.factory || FACTORY_SONGS;
  const idGen = opts.idGen || defaultIdGen;
  const timers = opts.timers || { setTimeout: (...a) => globalThis.setTimeout(...a), clearTimeout: (id) => globalThis.clearTimeout(id) };
  const requestIdle = opts.requestIdle !== undefined ? opts.requestIdle : typeof globalThis.requestIdleCallback === 'function' ? globalThis.requestIdleCallback.bind(globalThis) : null;
  const warn = opts.warn || ((m) => console.warn(`[store] ${m}`));

  let state;
  const listeners = new Set();
  const pending = new Set();
  let flushQueued = false;
  let persistTimer = null;
  let dirty = false;
  let generation = 0; // round2-shell #3: whole-library replacements (see api.generation)
  let retryTimer = null;
  let retryIdx = 0;
  let readOnlyReason = null; // null | 'backup-failed' | 'second-window' | string
  const info = { status: 'ok', backupKey: null, backupError: null, lastSavedAt: null, persistError: null, persistFailures: 0, readOnly: false, readOnlyReason: null };
  const infoListeners = new Set();
  function infoChanged() {
    info.readOnly = readOnlyReason !== null;
    info.readOnlyReason = readOnlyReason;
    for (const fn of [...infoListeners]) {
      try {
        fn({ ...info });
      } catch (err) {
        warn(`info listener failed: ${err && err.message}`);
      }
    }
  }

  // ---- load
  const backupPrefix = `${key}.backup-`;
  function backupKeys() {
    const out = [];
    try {
      const n = typeof storage.length === 'number' ? storage.length : 0;
      const keys = typeof storage.keys === 'function' ? storage.keys() : Array.from({ length: n }, (_, i) => storage.key(i));
      for (const k of keys) if (typeof k === 'string' && k.startsWith(backupPrefix)) out.push(k);
    } catch {
      /* storage without enumeration: nothing to prune */
    }
    const ts = (k) => Number(k.slice(backupPrefix.length)) || 0;
    return out.sort((a, b) => ts(a) - ts(b) || a.localeCompare(b));
  }
  /** Delete the oldest backup keys so that at most `keep` remain (never `except`). */
  function pruneBackups(keep, except = null) {
    const ks = backupKeys().filter((k) => k !== except);
    const room = Math.max(0, keep - (except ? 1 : 0));
    for (const k of ks.slice(0, Math.max(0, ks.length - room))) {
      try {
        storage.removeItem(k);
      } catch {
        /* ignore */
      }
    }
  }
  /** @returns {boolean} true when the raw string is safely stored under a backup key */
  function backupRaw(raw) {
    const k = `${backupPrefix}${now()}`;
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        storage.setItem(k, raw);
        if (storage.getItem(k) !== raw) throw new Error('backup did not read back');
        info.backupKey = k;
        pruneBackups(BACKUPS_KEEP, k);
        return true;
      } catch (err) {
        lastErr = err;
        if (attempt === 0) pruneBackups(BACKUPS_KEEP - 1); // make room (quota) and try once more
      }
    }
    info.backupError = (lastErr && lastErr.message) || String(lastErr);
    warn(`could not write backup ${k}: ${info.backupError}`);
    return false;
  }
  let raw = null;
  let unreadable = null; // the raw string we could not load (kept in memory for an Electron disk backup)
  try {
    raw = storage.getItem(key);
  } catch (err) {
    warn(`storage read failed: ${err && err.message}`);
  }
  if (raw === null || raw === undefined) {
    info.status = 'fresh';
    state = deepFreeze(emptyState(now()));
  } else {
    try {
      state = deepFreeze(migrate(JSON.parse(raw)));
    } catch (err) {
      info.status = err instanceof FutureSchemaError ? 'future-schema' : 'corrupt';
      unreadable = String(raw);
      if (backupRaw(unreadable)) {
        warn(`${info.status === 'corrupt' ? 'saved library is unreadable' : err.message}; starting fresh (backup kept as ${info.backupKey})`);
      } else {
        // H1: never overwrite the only copy. Nothing is written until allowOverwrite() (after an export/disk backup).
        readOnlyReason = 'backup-failed';
        info.readOnly = true;
        info.readOnlyReason = readOnlyReason;
        warn(`${info.status === 'corrupt' ? 'saved library is unreadable' : err.message} and no backup could be written; the saved data is left untouched and changes are NOT saved`);
      }
      state = deepFreeze(emptyState(now()));
    }
  }

  // ---- notify / persist
  function flushNotify() {
    flushQueued = false;
    if (!pending.size) return;
    const paths = [...pending];
    pending.clear();
    for (const fn of [...listeners]) {
      try {
        fn(state, paths);
      } catch (err) {
        warn(`subscriber failed: ${err && err.message}`);
      }
    }
  }
  /**
   * round2-shell #2: `meta.edited` is false only on a library this store seeded from an empty one and nobody has
   * changed since (absent = unknown, e.g. a library from before this field: treated as edited). Navigation and
   * device-local settings don't count. `seed` writes (factory seed/top-up) never count.
   */
  function changed(paths, { seed = false } = {}) {
    if (!seed && state.meta.edited === false && paths.some(isEditPath)) {
      state = setIn(state, ['meta', 'edited'], true); // bookkeeping: persisted with this change, not notified
    }
    for (const p of paths) pending.add(p);
    if (!flushQueued) {
      flushQueued = true;
      queueMicrotask(flushNotify);
    }
    schedulePersist();
  }
  function clearRetry() {
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
  }
  function persistNow() {
    if (persistTimer !== null) timers.clearTimeout(persistTimer);
    persistTimer = null;
    if (!dirty) return true;
    if (readOnlyReason !== null) return false; // dirty stays; written after allowOverwrite()/setReadOnly(false)
    clearRetry();
    try {
      storage.setItem(key, JSON.stringify(state));
      dirty = false;
      info.lastSavedAt = now();
      const hadError = info.persistError !== null;
      info.persistError = null;
      info.persistFailures = 0;
      retryIdx = 0;
      if (hadError) infoChanged();
      return true;
    } catch (err) {
      info.persistError = (err && err.message) || String(err);
      info.persistFailures += 1;
      if (info.persistFailures === 1) warn(`could not save library: ${info.persistError}`);
      // M7: retry with backoff even if nothing else changes
      const delay = PERSIST_RETRY_MS[Math.min(retryIdx, PERSIST_RETRY_MS.length - 1)];
      retryIdx += 1;
      retryTimer = timers.setTimeout(() => {
        retryTimer = null;
        persistNow();
      }, delay);
      infoChanged();
      return false;
    }
  }
  function schedulePersist() {
    dirty = true;
    if (readOnlyReason !== null) return;
    if (persistTimer !== null) timers.clearTimeout(persistTimer);
    persistTimer = timers.setTimeout(() => {
      persistTimer = null;
      if (requestIdle) requestIdle(() => persistNow(), { timeout: 1000 });
      else persistNow();
    }, debounceMs);
  }
  function commit(next, paths) {
    if (next === state || !paths.length) return false;
    state = next;
    changed(paths);
    return true;
  }
  const put = (segs, value) => {
    state = setIn(state, segs, value === undefined ? undefined : deepFreeze(clone(value)));
    return segs.join('.');
  };

  // ---- validation of a single write
  function resolvePath(path) {
    if (typeof path !== 'string' || !path) return null;
    const cur = state.settings.currentSongId;
    let segs;
    if (isValidPath(path)) {
      if (!cur || !state.songs[cur]) return null;
      if (path.startsWith('drone.')) segs = ['songs', cur, 'drone', path.slice(6)];
      else if (path === 'master.volume') segs = ['songs', cur, 'patch', 'fx', 'master', 'volume'];
      else segs = ['songs', cur, 'patch', ...path.split('.')];
    } else if (path.startsWith('song.')) {
      if (!cur || !state.songs[cur]) return null;
      segs = ['songs', cur, ...path.slice(5).split('.')];
    } else if (/^slots\.\d+(\.|$)/.test(path)) {
      // current-song slot aliases: 'slots.<i>', 'slots.<i>.instrument', 'slots.<i>.muted', …
      if (!cur || !state.songs[cur]) return null;
      segs = ['songs', cur, 'patch', ...path.split('.')];
    } else segs = path.split('.');
    if (segs.some((sg) => !sg || isReservedKey(sg))) return null; // L2
    return segs;
  }

  /** @returns {{segs:string[], value:*}|null} */
  function validate(segs, value) {
    const [root, id, field, ...rest] = segs;
    if (root === 'songs') {
      const song = state.songs[id];
      if (!song) return null;
      if (segs.length === 2) {
        const n = normalizeSong(value, id);
        return n ? { segs, value: n } : null;
      }
      if (field === 'id') return null;
      if (field === 'patch') return validatePatch(segs, song, rest, value);
      if (field === 'drone') {
        if (rest.length === 0) return { segs, value: normalizeDrone(value) };
        const k = rest[0];
        if (rest.length > 1) return null;
        if (k === 'mode') return DRONE_MODES.includes(value) ? { segs, value } : null;
        if (['chordFollow', 'continueAcrossSongs', 'minorUsesRelativeMajorFile'].includes(k)) return typeof value === 'boolean' ? { segs, value } : null;
        if (isValidPath(`drone.${k}`)) {
          const v = strictParam(`drone.${k}`, value);
          return v === INVALID ? null : { segs, value: v };
        }
        return { segs, value: clone(value) };
      }
      if (rest.length) return { segs, value: clone(value) }; // unknown nested fields
      switch (field) {
        case 'playIn':
        case 'hearIn': {
          const v = pc(value, INVALID);
          return v === INVALID ? null : { segs, value: v };
        }
        case 'transposeOctave':
          return { segs, value: int(value, -1, 1, 0) };
        case 'minor':
          return typeof value === 'boolean' ? { segs, value } : null;
        case 'tempo':
          return value === null ? { segs, value } : Number.isFinite(Number(value)) ? { segs, value: num(value, 30, 300, null) } : null;
        case 'name':
          return typeof value === 'string' ? { segs, value: value.slice(0, 120) } : null;
        case 'notes':
          return typeof value === 'string' ? { segs, value: value.slice(0, 10000) } : null;
        default:
          return { segs, value: clone(value) };
      }
    }
    if (root === 'setlists') {
      const sl = state.setlists[id];
      if (!sl) return null;
      if (segs.length === 2) {
        const n = normalizeSetlist(value, id, state.songs);
        return n ? { segs, value: n } : null;
      }
      if (field === 'id') return null;
      if (field === 'name') return typeof value === 'string' && rest.length === 0 ? { segs, value: value.slice(0, 120) } : null;
      if (field === 'songIds') {
        if (rest.length || !Array.isArray(value)) return null;
        return { segs, value: value.filter((s) => typeof s === 'string' && state.songs[s]) };
      }
      return { segs, value: clone(value) };
    }
    if (root === 'settings') {
      if (segs.length === 1) return null;
      const k = segs[1];
      if (segs.length > 2) {
        if (k === 'midiLearn') {
          const next = { ...state.settings.midiLearn };
          const cid = segs.slice(2).join('.');
          if (value === null || value === undefined) delete next[cid];
          else next[cid] = value;
          return { segs: ['settings', 'midiLearn'], value: normalizeMidiLearn(next) };
        }
        return hasOwn(SETTINGS_VALIDATORS, k) || k === 'theme' || k === 'audioSleepSec' ? null : { segs, value: clone(value) };
      }
      // themes-setup: an unknown theme id is stored as the default (never an error, never a dead id)
      if (k === 'theme') return { segs, value: isThemeId(value) ? value : DEFAULT_THEME_ID };
      if (k === 'audioSleepSec') {
        const v = validAudioSleepSec(value); // lowres2: a number, rounded and clamped; anything else is refused
        return v === null ? null : { segs, value: v };
      }
      const fn = hasOwn(SETTINGS_VALIDATORS, k) ? SETTINGS_VALIDATORS[k] : null;
      if (!fn) return { segs, value: clone(value) }; // unknown settings are allowed (preserved)
      const v = fn(value);
      if (v === INVALID) return null;
      if (k === 'currentSongId' && v !== null && !state.songs[v]) return null;
      if (k === 'currentSetlistId' && v !== null && !state.setlists[v]) return null;
      if (k === 'menuBarSetlistId' && v !== null && !state.setlists[v]) return null; // menubar-A
      return { segs, value: v };
    }
    if ((root === 'songOrder' || root === 'setlistOrder') && segs.length === 1) {
      if (!Array.isArray(value)) return null;
      const map = root === 'songOrder' ? state.songs : state.setlists;
      const seen = new Set(value.filter((s) => typeof s === 'string' && map[s]));
      return { segs, value: [...seen, ...Object.keys(map).filter((s) => !seen.has(s))] };
    }
    if (root === 'meta') return { segs, value: clone(value) };
    return null;
  }

  function validatePatch(segs, song, rest, value) {
    if (rest.length === 0) return { segs, value: normalizePatch(value) };
    const [k, a, b, ...more] = rest;
    if (k === 'slots') {
      if (rest.length === 1) return Array.isArray(value) ? { segs, value: normalizePatch({ ...song.patch, slots: value }).slots } : null;
      const i = Number(a);
      if (!Number.isInteger(i) || i < 0 || i >= SLOT_COUNT || String(i) !== a) return null;
      if (rest.length === 2) return { segs, value: value === null ? null : normalizeSlot(value, i) ?? INVALID };
      const slot = song.patch.slots[i];
      if (!slot) return null;
      if (b === 'instrument') {
        const ref = more.length === 0 ? value : { ...slot.instrument, [more[0]]: value };
        if (!isInstrumentRef(ref)) return null;
        const sameInst = ref.type === slot.instrument.type && ref.id === slot.instrument.id;
        const nextSlot = normalizeSlot({ ...slot, instrument: ref, params: sameInst ? slot.params : {} }, i);
        return { segs: segs.slice(0, 5), value: nextSlot };
      }
      if (b === 'params') {
        if (more.length === 0) return { segs, value: cleanInstrumentParams(value) };
        if (more.length > 1) return null;
        const p = `slots.${i}.params.${more[0]}`;
        if (!isValidPath(p)) return null;
        if (value === undefined) return { segs, value: undefined };
        const v = strictParam(p, value);
        return v === INVALID ? null : { segs, value: v };
      }
      if (more.length === 0 && (b === 'gain' || b === 'muted' || b === 'mutedGain' || b === 'gainBeforeMute')) {
        const r = muteWrite(slot, i, b, value);
        if (r === INVALID) return null;
        if (r !== null) return { segs: segs.slice(0, 5), value: r };
      }
      if (b === 'sends' && more.length === 0 && rest.length === 3) return isObj(value) ? { segs, value: normalizeSlot({ ...slot, sends: value }, i).sends } : null;
      const p = `slots.${i}.${[b, ...more].join('.')}`;
      if (isValidPath(p)) {
        const v = strictParam(p, value);
        return v === INVALID ? null : { segs, value: v };
      }
      if (SLOT_LEAVES.includes(b)) return null;
      return { segs, value: clone(value) };
    }
    if (k === 'fx') {
      if (rest.length === 1) return { segs, value: normalizeFx(value) };
      if (rest.length === 2) return isObj(value) ? { segs, value: normalizeFx({ ...song.patch.fx, [a]: value })[a] } : null;
      const p = a === 'master' ? `master.${b}` : `fx.${a}.${b}`;
      if (rest.length === 3 && isValidPath(p)) {
        const v = strictParam(p, value);
        return v === INVALID ? null : { segs, value: v };
      }
      return isValidPath(p) ? null : { segs, value: clone(value) };
    }
    if (k === 'modWheel' || k === 'expression') {
      if (rest.length === 1) return { segs, value: normalizeWheel(value, defaultRouting()[k].target) };
      if (a === 'target') return WHEEL_TARGETS.includes(value) ? { segs, value } : null;
      if (a === 'min' || a === 'max') return finite(value) ? { segs, value: num(value, 0, 1, 0) } : null;
      return { segs, value: clone(value) };
    }
    if (k === 'volume') {
      if (rest.length === 1) return isObj(value) && WHEEL_TARGETS.includes(value.target) ? { segs, value: { ...value } } : null;
      if (a === 'target') return WHEEL_TARGETS.includes(value) ? { segs, value } : null;
      return { segs, value: clone(value) };
    }
    if (k === 'bend') {
      if (rest.length === 1) return { segs, value: normalizePatch({ bend: value }).bend };
      if (a === 'mode') return BEND_MODES.includes(value) ? { segs, value } : null;
      if (a === 'range') return finite(value) ? { segs, value: int(value, 0, 24, 2) } : null;
      return { segs, value: clone(value) };
    }
    if (k === 'swell') {
      if (rest.length === 1) return { segs, value: normalizePatch({ swell: value }).swell };
      if (a === 'seconds') return finite(value) ? { segs, value: num(value, 1, 60, 8) } : null;
      return { segs, value: clone(value) };
    }
    return { segs, value: clone(value) };
  }

  /**
   * Slot mute bookkeeping for writes to gain / muted / mutedGain / gainBeforeMute.
   * @returns {object|null|typeof INVALID} a whole new slot, null = plain leaf write, INVALID = reject
   */
  function muteWrite(slot, i, field, value) {
    const strip = (o) => {
      const c = { ...o };
      delete c.muted;
      delete c.gainBeforeMute;
      delete c.mutedGain;
      return c;
    };
    const hasBefore = finite(slot.gainBeforeMute) || finite(slot.mutedGain);
    const before = finite(slot.gainBeforeMute) ? slot.gainBeforeMute : finite(slot.mutedGain) ? slot.mutedGain : null;
    if (field === 'gain') {
      const v = strictParam(`slots.${i}.gain`, value);
      if (v === INVALID) return INVALID;
      if (slot.muted) return v > 0 ? { ...strip(slot), gain: v } : null;
      if (hasBefore) return v === 0 ? { ...slot, gain: 0, muted: true, gainBeforeMute: before, mutedGain: before } : { ...strip(slot), gain: v };
      return null;
    }
    if (field === 'muted') {
      if (typeof value !== 'boolean') return INVALID;
      if (value) {
        if (slot.muted) return slot;
        const b = slot.gain > 0 ? slot.gain : before > 0 ? before : 0.8;
        return { ...slot, gain: 0, muted: true, gainBeforeMute: b, mutedGain: b };
      }
      if (!slot.muted) return strip(slot);
      return { ...strip(slot), gain: before > 0 ? before : 0.8 };
    }
    // mutedGain / gainBeforeMute (ui-core compat)
    if (value === undefined || value === null) return strip(slot);
    if (!finite(value) || value < 0) return INVALID;
    const b = Math.min(2, value);
    if (slot.gain === 0) return { ...slot, muted: true, gainBeforeMute: b, mutedGain: b };
    return { ...strip(slot), gainBeforeMute: b, mutedGain: b }; // transitional: gain 0 follows
  }

  /**
   * A library seeded by an older factory version gets the factory songs added since (FACTORY_SINCE), appended to the
   * library (not to any setlist), once: meta.factoryVersion is raised even when nothing is added. Songs whose
   * factoryId is already in the library are skipped. @returns {string[]} new song ids
   */
  function topUpFactory(presets) {
    const have = Number.isFinite(state.meta.factoryVersion) ? state.meta.factoryVersion : 1;
    if (have >= FACTORY_VERSION) return [];
    const known = new Set(Object.values(state.songs).map((s) => s.factoryId).filter(Boolean));
    const ids = [];
    const paths = [];
    for (const p of presets) {
      const fid = p.factoryId || p.id;
      const since = FACTORY_SINCE[fid];
      if (!since || since <= have || known.has(fid)) continue;
      const id = idGen('song');
      paths.push(put(['songs', id], normalizeSong({ ...clone(p), factoryId: fid }, id)));
      ids.push(id);
    }
    if (ids.length) paths.push(put(['songOrder'], [...state.songOrder, ...ids]));
    paths.push(put(['meta', 'factoryVersion'], FACTORY_VERSION));
    changed(paths, { seed: true });
    return ids;
  }

  // ---- navigation helpers
  function navList(s = state) {
    const sl = s.settings.currentSetlistId ? s.setlists[s.settings.currentSetlistId] : null;
    if (sl && sl.songIds.length) return { ids: sl.songIds, setlist: true };
    return { ids: s.songOrder, setlist: false };
  }
  function currentIndex(s = state) {
    const { ids } = navList(s);
    const cur = s.settings.currentSongId;
    const pos = s.settings.setlistIndex;
    if (s.settings.setlistGap) return -1;
    if (Number.isInteger(pos) && pos >= 0 && ids[pos] === cur) return pos;
    return ids.indexOf(cur);
  }
  /** Nav position incl. the "gap" state (current entry removed: prev = pos−1, next = pos). */
  function navState(s = state) {
    const { ids, setlist } = navList(s);
    const st = s.settings;
    const gap = !!st.setlistGap && Number.isInteger(st.setlistIndex) && st.setlistIndex >= 0;
    return { ids, listId: setlist ? st.currentSetlistId : null, pos: gap ? st.setlistIndex : currentIndex(s), gap };
  }
  function putPos(pos, gap = false) {
    const out = [];
    if (state.settings.setlistIndex !== pos) out.push(put(['settings', 'setlistIndex'], pos));
    if (!!state.settings.setlistGap !== !!gap) out.push(put(['settings', 'setlistGap'], !!gap));
    return out;
  }
  /**
   * M4: keep settings.setlistIndex pointing at the same entry after an edit of `editedListId` (null = library order).
   * `before` is navState() captured before the edit; fn(pos, gap) → {pos, gap}. Call after the list was put().
   */
  function reposition(before, editedListId, fn) {
    const after = navState();
    if (after.listId !== before.listId) return putPos(-1, false); // nav switched library ↔ setlist: fall back to indexOf
    if (editedListId !== before.listId) return [];
    if (before.pos < 0) return before.gap ? [] : putPos(-1, false);
    const r = fn(before.pos, before.gap);
    return putPos(r.pos, r.gap);
  }
  const insertAtPos = (at) => (pos, gap) => ({ pos: (gap ? at < pos : at <= pos) ? pos + 1 : pos, gap });
  const removeAtPos = (idx) => (pos, gap) => {
    if (idx < pos) return { pos: pos - 1, gap };
    if (idx === pos && !gap) return { pos: idx, gap: true };
    return { pos, gap };
  };
  const moveAtPos = (from, at) => (pos, gap) => {
    if (from === pos && !gap) return { pos: at, gap };
    const j = from === pos ? pos : pos > from ? pos - 1 : pos;
    return { pos: j >= at ? j + 1 : j, gap };
  };

  const api = {
    /** @returns {object} current (frozen) state */
    get: () => state,
    /**
     * Load/persist status: {status:'ok'|'fresh'|'corrupt'|'future-schema', backupKey, backupError, lastSavedAt,
     * persistError, persistFailures, readOnly, readOnlyReason}
     */
    /**
     * Incremented each time the whole library is replaced (importJSON {replace:true}, reload()), before subscribers
     * are notified. Songs keep their ids across such a swap; this tells them apart from edits (round2-shell #3).
     */
    get generation() {
      return generation;
    },
    /**
     * True for a factory seed nobody has changed (round2-shell #2: meta.edited === false). Such a library is not
     * worth a disk backup, and a backup of it must never be offered as "a newer library" (M5).
     */
    get pristine() {
      return state.meta.edited === false;
    },
    get loadInfo() {
      return { ...info, readOnly: readOnlyReason !== null, readOnlyReason };
    },
    /** @param {(info:object) => void} fn called when loadInfo changes (save failed/recovered, read-only) @returns unsubscribe */
    onInfo(fn) {
      infoListeners.add(fn);
      return () => infoListeners.delete(fn);
    },
    /**
     * Read-only mode: edits stay in memory, nothing is written. Used for a second window (H2).
     * setReadOnly(false) writes pending changes (unless the load-time 'backup-failed' lock is still on).
     */
    setReadOnly(on, reason = 'second-window') {
      // round4-controller C4: another reason never replaces the H1 lock, or the matching setReadOnly(false) (second
      // window taking over) would clear it and the next persist would overwrite the only copy of the library
      if (on && readOnlyReason === 'backup-failed') return false;
      const next = on ? String(reason || 'read-only') : readOnlyReason === 'backup-failed' ? 'backup-failed' : null;
      if (next === readOnlyReason) return false;
      readOnlyReason = next;
      if (readOnlyReason === null && dirty) schedulePersist();
      infoChanged();
      return true;
    },
    /** H1: the unreadable library has been saved elsewhere (export / disk backup): allow normal saving again. */
    allowOverwrite() {
      if (readOnlyReason !== 'backup-failed') return false;
      readOnlyReason = null;
      if (dirty) schedulePersist();
      infoChanged();
      return true;
    },
    /** The raw library string that could not be loaded (corrupt / future schema), else null. */
    unreadableRaw: () => unreadable,
    /**
     * Re-read the library from storage (e.g. after another window released the instance lock).
     * @returns {boolean} true when the state changed
     */
    reload() {
      let r;
      try {
        r = storage.getItem(key);
      } catch {
        return false;
      }
      if (r === null || r === undefined) return false;
      let next;
      try {
        next = migrate(JSON.parse(r));
      } catch (err) {
        warn(`reload: stored library unreadable (${err && err.message}); keeping the current one`);
        return false;
      }
      const paths = diffPaths(state, next);
      if (!paths.length) return false;
      generation += 1;
      state = deepFreeze(next);
      for (const p of paths) pending.add(p);
      if (!flushQueued) {
        flushQueued = true;
        queueMicrotask(flushNotify);
      }
      return true;
    },

    /**
     * Validated write. See header for path forms.
     * @returns {boolean} true when the state changed
     */
    set(path, value) {
      const segs = resolvePath(path);
      if (!segs) {
        warn(`set: cannot resolve "${path}"`);
        return false;
      }
      const v = validate(segs, value);
      if (!v || v.value === INVALID) {
        warn(`set: rejected ${path} = ${JSON.stringify(value)}`);
        return false;
      }
      if (deepEqual(getIn(state, v.segs), v.value)) return false;
      const p = put(v.segs, v.value);
      changed([p]);
      return true;
    },

    /**
     * Free-form mutation: fn(draft) edits a deep copy (or returns a replacement). The result is migrated/validated.
     * @returns {boolean} changed
     */
    update(fn) {
      const draft = clone(state);
      const r = fn(draft);
      let next;
      try {
        next = migrate(r && typeof r === 'object' ? r : draft);
      } catch (err) {
        warn(`update rejected: ${err.message}`);
        return false;
      }
      const paths = diffPaths(state, next);
      return commit(deepFreeze(next), paths);
    },

    /** @param {(state, changedPaths:string[]) => void} fn @returns {() => void} unsubscribe */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Deliver pending notifications synchronously (tests). */
    flush: flushNotify,
    /** Write to storage now (e.g. on pagehide). */
    persistNow,

    // ---- songs
    getSong: (id) => state.songs[id] || null,
    currentSong: () => state.songs[state.settings.currentSongId] || null,
    songsInOrder: () => state.songOrder.map((id) => state.songs[id]),
    transposeSemisOf: (songOrId) => transposeSemisOf(typeof songOrId === 'string' ? state.songs[songOrId] : songOrId),

    /**
     * Add a song (copy of a Song/preset, or a blank song).
     * @param {object} [from]  Song or factory preset (factory ids are kept as `factoryId`)
     * @param {{setlistId?:string|null, index?:number, name?:string, select?:boolean}} [o]
     *        setlistId default = current setlist (null = library only)
     * @returns {string} new id
     */
    addSong(from, o = {}) {
      const id = idGen('song');
      const src = from ? clone(from) : blankSong();
      if (typeof src.id === 'string' && src.id.startsWith('factory:') && !src.factoryId) src.factoryId = src.id;
      const song = normalizeSong({ ...src, name: o.name ?? src.name }, id);
      const paths = [];
      paths.push(put(['songs', id], song));
      paths.push(put(['songOrder'], [...state.songOrder, id]));
      const slId = o.setlistId === undefined ? state.settings.currentSetlistId : o.setlistId;
      if (slId && state.setlists[slId]) {
        const ids = state.setlists[slId].songIds.slice();
        const at = Number.isInteger(o.index) ? Math.max(0, Math.min(ids.length, o.index)) : ids.length;
        ids.splice(at, 0, id);
        paths.push(put(['setlists', slId, 'songIds'], ids));
      }
      if (o.select || !state.settings.currentSongId) paths.push(put(['settings', 'currentSongId'], id));
      changed(paths);
      return id;
    },

    /** @returns {string|null} id of the copy (inserted after the original in library + current setlist) */
    duplicateSong(id) {
      const s = state.songs[id];
      if (!s) return null;
      const newId = idGen('song');
      const before = navState();
      const copy = normalizeSong({ ...clone(s), name: `${s.name} (copy)` }, newId);
      const paths = [put(['songs', newId], copy)];
      const order = state.songOrder.slice();
      const libAt = order.indexOf(id) + 1;
      order.splice(libAt, 0, newId);
      paths.push(put(['songOrder'], order));
      const slId = state.settings.currentSetlistId;
      const sl = slId && state.setlists[slId];
      let slAt = -1;
      if (sl && sl.songIds.includes(id)) {
        const ids = sl.songIds.slice();
        // after the current entry when the original is the current song (reprise-safe), else after the first copy
        slAt = (before.listId === slId && !before.gap && ids[before.pos] === id ? before.pos : ids.indexOf(id)) + 1;
        ids.splice(slAt, 0, newId);
        paths.push(put(['setlists', slId, 'songIds'], ids));
      }
      if (before.listId === null) paths.push(...reposition(before, null, insertAtPos(libAt)));
      else if (slAt >= 0) paths.push(...reposition(before, slId, insertAtPos(slAt)));
      changed(paths);
      return newId;
    },

    /** Remove a song from the library and every setlist. @returns {boolean} */
    deleteSong(id) {
      if (!state.songs[id]) return false;
      const before = navState();
      const removedBefore = (p) => before.ids.slice(0, Math.max(0, p)).filter((s) => s === id).length;
      const wasCurrent = state.settings.currentSongId === id;
      const paths = [put(['songs', id], undefined), put(['songOrder'], state.songOrder.filter((s) => s !== id))];
      for (const slId of state.setlistOrder) {
        const sl = state.setlists[slId];
        if (sl.songIds.includes(id)) paths.push(put(['setlists', slId, 'songIds'], sl.songIds.filter((s) => s !== id)));
      }
      const after = navState();
      if (wasCurrent) {
        // select the song that followed it (M4), at its exact position
        const remaining = after.ids;
        let p = before.pos >= 0 ? before.pos - removedBefore(before.pos) : 0;
        if (after.listId !== before.listId) p = 0;
        p = Math.min(Math.max(0, p), remaining.length - 1);
        const next = remaining[p] || state.songOrder[0] || null;
        paths.push(put(['settings', 'currentSongId'], next));
        paths.push(...putPos(next && remaining[p] === next ? p : -1, false));
      } else {
        paths.push(...reposition(before, before.listId, (pos, gap) => ({ pos: pos - removedBefore(pos), gap })));
      }
      changed(paths);
      return true;
    },

    /** Reset a factory-derived song's sound to the factory version (keeps id, name edits are reset; keeps key fields). */
    resetToFactory(id) {
      const s = state.songs[id];
      const f = s && s.factoryId && factoryById(s.factoryId);
      if (!f) return false;
      const next = normalizeSong({ ...clone(f), id, factoryId: s.factoryId, playIn: s.playIn, hearIn: s.hearIn, minor: s.minor, transposeOctave: s.transposeOctave }, id);
      if (deepEqual(next, s)) return false;
      changed([put(['songs', id], next)]);
      return true;
    },

    // ---- setlists
    /** @returns {string} new setlist id */
    addSetlist(name = 'New Setlist', songIds = [], o = {}) {
      const id = idGen('set');
      const sl = normalizeSetlist({ name, songIds }, id, state.songs);
      const paths = [put(['setlists', id], sl), put(['setlistOrder'], [...state.setlistOrder, id])];
      if (!o.select && !state.settings.currentSetlistId) paths.push(put(['settings', 'currentSetlistId'], id));
      changed(paths);
      if (o.select) api.setCurrentSetlist(id);
      return id;
    },
    deleteSetlist(id) {
      if (!state.setlists[id]) return false;
      const order = state.setlistOrder.filter((s) => s !== id);
      const paths = [put(['setlists', id], undefined), put(['setlistOrder'], order)];
      if (state.settings.currentSetlistId === id) {
        paths.push(put(['settings', 'currentSetlistId'], order[0] || null));
        paths.push(...putPos(-1, false));
      }
      // menubar-A: the menu-bar set falls back to the current setlist's first songs
      if (state.settings.menuBarSetlistId === id) paths.push(put(['settings', 'menuBarSetlistId'], null));
      changed(paths);
      return true;
    },
    /** Insert a song into a setlist (duplicates allowed, e.g. a reprise). */
    addToSetlist(setlistId, songId, index) {
      const sl = state.setlists[setlistId];
      if (!sl || !state.songs[songId]) return false;
      const before = navState();
      const ids = sl.songIds.slice();
      const at = Number.isInteger(index) ? Math.max(0, Math.min(ids.length, index)) : ids.length;
      ids.splice(at, 0, songId);
      const paths = [put(['setlists', setlistId, 'songIds'], ids)];
      paths.push(...reposition(before, setlistId, insertAtPos(at)));
      changed(paths);
      return true;
    },
    removeFromSetlist(setlistId, index) {
      const sl = state.setlists[setlistId];
      if (!sl || !Number.isInteger(index) || index < 0 || index >= sl.songIds.length) return false;
      const before = navState();
      const ids = sl.songIds.slice();
      ids.splice(index, 1);
      const paths = [put(['setlists', setlistId, 'songIds'], ids)];
      paths.push(...reposition(before, setlistId, removeAtPos(index)));
      changed(paths);
      return true;
    },
    /** Reorder within a setlist (setlistId null → the library order). */
    moveSong(setlistId, from, to) {
      const list = setlistId ? state.setlists[setlistId]?.songIds : state.songOrder;
      if (!list || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= list.length) return false;
      const ids = list.slice();
      const [x] = ids.splice(from, 1);
      const at = Math.max(0, Math.min(ids.length, to));
      ids.splice(at, 0, x);
      if (deepEqual(ids, list)) return false;
      const before = navState();
      const paths = [put(setlistId ? ['setlists', setlistId, 'songIds'] : ['songOrder'], ids)];
      paths.push(...reposition(before, setlistId || null, moveAtPos(from, at)));
      changed(paths);
      return true;
    },
    moveSetlist(from, to) {
      const ids = state.setlistOrder.slice();
      if (from < 0 || from >= ids.length) return false;
      const [x] = ids.splice(from, 1);
      ids.splice(Math.max(0, Math.min(ids.length, to)), 0, x);
      changed([put(['setlistOrder'], ids)]);
      return true;
    },
    /** Make a setlist current; if the current song isn't in it, select its first song. */
    setCurrentSetlist(id) {
      if (id !== null && !state.setlists[id]) return false;
      const paths = [put(['settings', 'currentSetlistId'], id), ...putPos(-1, false)];
      const sl = id && state.setlists[id];
      if (sl && sl.songIds.length && !sl.songIds.includes(state.settings.currentSongId)) {
        paths.push(put(['settings', 'currentSongId'], sl.songIds[0]));
        paths.push(put(['settings', 'setlistIndex'], 0));
      }
      changed(paths);
      return true;
    },
    currentSetlist: () => (state.settings.currentSetlistId ? state.setlists[state.settings.currentSetlistId] || null : null),
    /** Ids used for next/prev: the current setlist (if non-empty) else the library order. */
    navIds: () => navList().ids,
    /** Position of the current song in navIds() (−1 if absent). */
    currentIndex: () => currentIndex(),
    /** @returns {{index:number, prev:{id,index}|null, next:{id,index}|null}} */
    neighbors() {
      const nav = navState();
      const { ids } = nav;
      const at = (j) => (j >= 0 && j < ids.length ? { id: ids[j], index: j } : null);
      if (nav.gap) return { index: -1, gap: nav.pos, prev: at(nav.pos - 1), next: at(nav.pos) };
      const i = nav.pos;
      if (i < 0) return { index: -1, prev: null, next: at(0) };
      return { index: i, prev: at(i - 1), next: at(i + 1) };
    },
    next: () => api.neighbors().next?.id ?? null,
    prev: () => api.neighbors().prev?.id ?? null,
    /** Record the current song (and its position in the nav list, for setlists with repeats). */
    selectSongId(id, index) {
      if (!state.songs[id]) return false;
      const { ids } = navList();
      const pos = Number.isInteger(index) && ids[index] === id ? index : ids.indexOf(id);
      const paths = [];
      if (state.settings.currentSongId !== id) paths.push(put(['settings', 'currentSongId'], id));
      paths.push(...putPos(pos, false));
      if (!paths.length) return false;
      changed(paths);
      return true;
    },

    /** MIDI Learn mapping for a controlId (ids contain dots, so this is not a set() path). null clears. */
    setMidiLearn(controlId, mapping) {
      if (typeof controlId !== 'string' || isReservedKey(controlId)) return false;
      if (mapping && mapping.cc === 64) {
        warn('setMidiLearn: CC64 is the sustain pedal and cannot be mapped');
        return false;
      }
      const next = { ...state.settings.midiLearn };
      if (mapping) next[controlId] = { ...mapping };
      else delete next[controlId];
      return api.set('settings.midiLearn', next);
    },

    // ---- factory / import / export
    /**
     * Copy factory songs into the library once (new ids, `factoryId` kept) and create a first setlist.
     * @returns {string[]} new song ids ([] if already seeded)
     */
    seedFactory(presets = factory) {
      if (state.meta.factorySeeded) return topUpFactory(presets);
      const pristine = !state.songOrder.length && state.meta.edited === undefined;
      const ids = [];
      const paths = [];
      for (const p of presets) {
        const id = idGen('song');
        const src = clone(p);
        const song = normalizeSong({ ...src, factoryId: src.factoryId || src.id }, id);
        paths.push(put(['songs', id], song));
        ids.push(id);
      }
      paths.push(put(['songOrder'], [...state.songOrder, ...ids]));
      const slId = idGen('set');
      paths.push(put(['setlists', slId], { id: slId, name: 'My Set', songIds: ids.slice() }));
      paths.push(put(['setlistOrder'], [...state.setlistOrder, slId]));
      if (!state.settings.currentSetlistId) paths.push(put(['settings', 'currentSetlistId'], slId));
      if (!state.settings.currentSongId && ids[0]) {
        paths.push(put(['settings', 'currentSongId'], ids[0]));
        paths.push(put(['settings', 'setlistIndex'], 0));
      }
      paths.push(put(['meta', 'factorySeeded'], true));
      paths.push(put(['meta', 'factoryVersion'], FACTORY_VERSION));
      if (pristine) paths.push(put(['meta', 'edited'], false)); // round2-shell #2: an untouched factory library
      changed(paths, { seed: true });
      return ids;
    },

    /** Whole library as JSON (for export files and Electron auto-backups). */
    exportJSON({ pretty = true } = {}) {
      const { songs, songOrder, setlists, setlistOrder, meta } = state;
      // security S3: device-local settings stay on this machine. The pad folder's absolute path carries the account
      // name (/Users/<name>/…), and the MIDI/audio device names/ids identify the hardware. Nothing reads them back:
      // a replace-import keeps this machine's values, a merge ignores settings.
      const settings = Object.fromEntries(
        Object.entries(state.settings).filter(([k]) => !DEVICE_LOCAL_SETTINGS.includes(k)),
      );
      const doc = { app: 'worship-rig', kind: 'library', schema: SCHEMA, exportedAt: new Date(now()).toISOString(), songs, songOrder, setlists, setlistOrder, settings, meta };
      return JSON.stringify(doc, null, pretty ? 2 : 0);
    },
    /** One song as JSON (share a sound). */
    exportSong(id, { pretty = true } = {}) {
      const s = state.songs[id];
      if (!s) return null;
      return JSON.stringify({ app: 'worship-rig', kind: 'song', schema: SCHEMA, exportedAt: new Date(now()).toISOString(), song: s }, null, pretty ? 2 : 0);
    },

    /**
     * Import a library / song / array of songs.
     * merge (default): songs added with NEW ids; setlists added with remapped ids; settings ignored.
     * replace: the whole library is replaced (device-local settings kept).
     * @returns {{ok:true, songIds:string[], setlistIds:string[]} | {ok:false, error:string}}
     */
    importJSON(text, { replace = false } = {}) {
      const tooBig = { ok: false, error: 'That file is too large to import: the library can hold about 2 MB of songs.' };
      // security S2: a pretty-printed export is ~2–3× its compact size; anything far beyond the cap isn't even parsed
      if (typeof text === 'string' && text.length > 4 * LIBRARY_MAX_CHARS) return tooBig;
      // security S2: deep nesting made clone/deepFreeze throw RangeError out of importJSON (uncaught in the UI), and a
      // merge could leave earlier songs half-written into the state with no change event
      const notOurs = { ok: false, error: 'That file is not a Worship Rig library or song.' };
      if (typeof text !== 'string' && nestsDeeperThan(text, IMPORT_MAX_DEPTH)) return notOurs;
      let doc;
      try {
        doc = typeof text === 'string' ? JSON.parse(text) : clone(text);
      } catch {
        return { ok: false, error: 'That file is not valid JSON.' };
      }
      if (nestsDeeperThan(doc, IMPORT_MAX_DEPTH)) return notOurs;
      let lib;
      try {
        if (Array.isArray(doc)) lib = migrate({ songs: doc.map((s, i) => ({ ...s, id: s?.id || `import${i}` })) });
        else if (isObj(doc) && (doc.kind === 'song' || (!doc.songs && isObj(doc.patch)))) {
          const s = doc.kind === 'song' ? doc.song : doc;
          if (!isObj(s)) return { ok: false, error: 'No song found in that file.' };
          if (typeof doc.schema === 'number' && doc.schema > SCHEMA) throw new FutureSchemaError(doc.schema);
          lib = migrate({ songs: [{ ...s, id: s.id || 'import0' }] });
        } else lib = migrate(doc);
      } catch (err) {
        if (err instanceof FutureSchemaError) return { ok: false, error: 'This file was made by a newer version of Worship Rig.' };
        return { ok: false, error: 'That file is not a Worship Rig library or song.' };
      }
      if (!lib.songOrder.length && !replace) return { ok: false, error: 'No songs found in that file.' };
      // security S2: the library after the import must still fit localStorage (unknown fields are kept, uncapped)
      const after = JSON.stringify(lib).length + (replace ? 0 : JSON.stringify(state).length);
      if (after > LIBRARY_MAX_CHARS) return tooBig;
      if (replace) {
        const keep = Object.fromEntries(DEVICE_LOCAL_SETTINGS.map((k) => [k, state.settings[k]]));
        // an imported library is the user's data, whatever it says (round2-shell #2)
        const meta = { ...lib.meta, factorySeeded: true, edited: true };
        const next = migrate({ ...lib, settings: { ...lib.settings, ...keep }, meta });
        generation += 1; // round2-shell #3: read by the controller's onStore (revert snapshot)
        commit(deepFreeze(next), diffPaths(state, next));
        return { ok: true, songIds: next.songOrder.slice(), setlistIds: next.setlistOrder.slice() };
      }
      const map = new Map();
      const paths = [];
      const songIds = [];
      for (const oldId of lib.songOrder) {
        const id = idGen('song');
        map.set(oldId, id);
        paths.push(put(['songs', id], normalizeSong({ ...lib.songs[oldId] }, id)));
        songIds.push(id);
      }
      paths.push(put(['songOrder'], [...state.songOrder, ...songIds]));
      const names = new Set(Object.values(state.setlists).map((s) => s.name));
      const setlistIds = [];
      for (const oldId of lib.setlistOrder) {
        const sl = lib.setlists[oldId];
        const id = idGen('set');
        const name = names.has(sl.name) ? `${sl.name} (imported)` : sl.name;
        paths.push(put(['setlists', id], { ...sl, id, name, songIds: sl.songIds.map((s) => map.get(s)).filter(Boolean) }));
        setlistIds.push(id);
      }
      if (setlistIds.length) paths.push(put(['setlistOrder'], [...state.setlistOrder, ...setlistIds]));
      if (!state.settings.currentSongId && songIds[0]) paths.push(put(['settings', 'currentSongId'], songIds[0]));
      changed(paths);
      return { ok: true, songIds, setlistIds };
    },

    /** Stop timers (tests). Persists pending changes. */
    dispose() {
      persistNow();
      clearRetry();
      listeners.clear();
      infoListeners.clear();
      if (typeof globalThis.removeEventListener === 'function') globalThis.removeEventListener('pagehide', onPageHide);
      if (globalThis.document && typeof globalThis.document.removeEventListener === 'function') globalThis.document.removeEventListener('visibilitychange', onVisibility);
    },
  };

  const onPageHide = () => persistNow();
  const onVisibility = () => {
    if (globalThis.document && globalThis.document.visibilityState === 'hidden') persistNow();
  };
  if (opts.autoFlush !== false && typeof globalThis.addEventListener === 'function' && typeof globalThis.document !== 'undefined') {
    globalThis.addEventListener('pagehide', onPageHide);
    if (typeof globalThis.document.addEventListener === 'function') globalThis.document.addEventListener('visibilitychange', onVisibility);
  }

  if (info.status !== 'ok' && opts.seed !== false) api.seedFactory();
  else if (info.status !== 'ok') schedulePersist();
  pending.clear(); // nobody is subscribed yet; the initial state is not a change
  return api;
}

/** SPEC §2 alias: `create({storage})`. */
export const create = createStore;
