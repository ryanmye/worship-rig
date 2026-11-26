// Worship Rig state model + persistence (SPEC §2, REVIEW 4.9, 6.9). Pure ES module: no DOM, no Web Audio.
//
// State shape (schema 2; UIA, native DECISIONS D3):
//   { schema:2,
//     songs: { [id]: Song }, songOrder: [id],            // library (map + display order)
//     setlists: { [id]: Setlist }, setlistOrder: [id],
//     settings: Settings,                                 // SPEC §2 + setlistIndex (position in current setlist)
//     meta: { factorySeeded, factoryVersion, createdAt, packSongs? } }
// Patch packs (2.x step 1, DECISIONS O-AW-PP): meta.packSongs = { '<slug>:<file>[#n]': {id, hash, sig} } remembers
//   every pack song this library ever took (id = its library song, hash = the pack version it was written from,
//   sig = songFingerprint of what was written). Never pruned: a deleted pack song keeps its entry, so it is never
//   added again (topUpFactory's "once" rule). Absent until a pack song is added.
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
// Schema 2 (UIA, native DECISIONS D3): Song.patch.slots has 1..MAX_SLOTS (16) entries (a Slot, or null = an empty
//   slot); its length is the song's slot count. Schema 1 had exactly 4, so migrate() keeps a 1.x song's 4 entries
//   byte for byte (a schema-1 array of another length is padded / cut to 4, as 1.x did); new songs start with 4.
//   Slot paths ('slots.<i>…') address i < that song's slot count; addSlot / removeSlot change the count (removeSlot
//   moves later slots down and re-points wheel targets and scenes). Loading a schema-1 library that has songs first
//   keeps a copy of it (1.1 cannot read schema 2).
// Kept copies (D8, review E5 M4): `<key>.kept-<ts>.<kind>.s<schema>` hold whole libraries that must never be rotated
//   away: the 1.x text kept at an upgrade ('migration'), a newer library set aside here or by 1.x ('downgrade'; 1.x
//   puts it in the `.backup-` rotation, and the next load moves it here) and the library a restore replaced
//   ('restore'). No count limit; only when storage is full is an earlier state of a still-kept library removed (all
//   its songs and setlists are in a newer copy of its version; D8 skeptic K2), with a notice. keptLibraries() lists
//   them (plus 1.1.1's separate `<key>.1x` library) for "Restore previous library…". onNotice(fn) reports what the
//   UI should say (that, and D9's size warning).
import { mod12, transposeSemis } from './shared/music.js';
import { isValidId as isThemeId, DEFAULT_THEME_ID } from './shared/themes.js';
import { normalizeHotkeys } from './shared/hotkeys.js';
import {
  PARAMS, clamp, describe, isValidPath as isValidPath4, defaultSlot, SLOT_COUNT, MAX_SLOTS, slotGainIndex, isLearnable,
} from './shared/params.js';
import { normalizeTouch, PEDAL_CURVES, COMPUTER_KEYBOARD, validDynRange } from './shared/touch-curve.js';
import { normalizeClick, validTimeSig } from './shared/click-math.js';
import { normalizeScenes } from './shared/scenes.js';
import { validPackEntry, packModeOf, songFingerprint, PACK_ID_RE, PACK_ID_MAX } from './shared/patch-packs.js';
import { learnFields, isLearnablePath } from './shared/learn.js';
import {
  FACTORY_SONGS, FACTORY_VERSION, FACTORY_SINCE, CATEGORIES, WHEEL_TARGETS, BEND_MODES, DRONE_MODES, defaultFx, defaultDrone, defaultRouting,
  blankSong, factoryById,
} from './presets.js';

// UIA: the store speaks the 2.0 song grammar (slots.0..15); which of them a song has is its patch.slots.length
const isValidPath = (p) => isValidPath4(p, MAX_SLOTS);

export const SCHEMA = 2; // INTERFACE-CHANGE(UIA): 1 → 2 (1..16 slots per song, native DECISIONS D3)
export const STORAGE_KEY = 'rig.v1';
export const INSTRUMENT_TYPES = Object.freeze(['sampler', 'synth', 'organ']);
export const LATENCIES = Object.freeze(['lowest', 'balanced', 'safe']);
export const VELOCITY_SENS = Object.freeze(['soft', 'normal', 'hard', 'fixed']);
export const VIEWS = Object.freeze(['perform', 'edit']);
/**
 * v11-touch: settings.keyboards (optional; absent until a keyboard is remembered or given a curve) =
 * { [MIDI device name]: { touch?: {shape,min,max,top}, remember?: true } }. touch = the keyboard's own curve, which
 * slots on 'normal' inherit; remember = prefer this device when choosing the "first keyboard" automatically. Keyed by
 * name (Web MIDI ids change when a device is re-plugged). COMPUTER_KEYBOARD is the on-screen + computer keys entry.
 */
export { COMPUTER_KEYBOARD };
export const KEYBOARDS_MAX = 32;
export const KEYBOARD_NAME_MAX = 120;
/** Song categories the UI groups by (factory categories incl. 'synth', plus 'user'). Unknown strings are kept. */
export const SONG_CATEGORIES = Object.freeze([...CATEGORIES, 'user']);
/** Settings that belong to this machine and survive a replace-import. */
// menubar-A (C7): menu-bar mode and low-resource are how this machine runs the app, not library content.
// v11-electron: so are the global hotkeys and the update check (optional; absent = hotkeys off, checking on).
export const DEVICE_LOCAL_SETTINGS = Object.freeze([
  'outputDeviceId', 'padFolder', 'midiInputId', 'midiInputName', 'menuBarMode', 'lowResource', 'audioSleepSec',
  'hotkeys', 'updateCheck',
  // v11-metronome: the click's monitor setup (level, count-in, outputs 3–4) and the MIDI clock port are this rig's
  'click', 'midiClockOut',
  // v11-decisions (Ryan 2026-11-03, checklist Q7): the keyboard curves / "remember" are per MIDI device and stay with
  // each Mac: not exported, a replace-import keeps this Mac's, an incoming library's are dropped
  'keyboards',
  // Ryan 2026-11-20 (hardware batch): the dynamic range is this player's keyboard and room, like the curves
  'dynamicRange',
  // 2.0 (native DECISIONS D1, D2, D4): voices, buffer size and the voice limit are sized for this machine's CPU and
  // audio device, so an imported library never carries another Mac's (or an iPad's) choice
  'polyphony', 'bufferFrames', 'voiceLimit',
  // UIB (DECISIONS D5): "Freeze drone to save CPU" is about this machine's CPU, like the voices above
  'droneFreeze',
  // Chart view (D7, hidden): a preview switch for this machine; a replace-import never turns it on or off
  'chartView',
]);
/** 2.0 settings.polyphony (D1): voices per sound (slot). Optional; absent = POLYPHONY_DEFAULT. */
export const POLYPHONY_CHOICES = Object.freeze([32, 64, 128]);
export const POLYPHONY_DEFAULT = 64;
/** 2.0 settings.bufferFrames (D2): the audio buffer the host asks the device for. Optional; absent = the default. */
export const BUFFER_FRAMES_CHOICES = Object.freeze([64, 128, 256, 512]);
export const BUFFER_FRAMES_DEFAULT = 128;
/** 2.0 settings.voiceLimit (D4): total live voices across all sounds. Optional; absent = 'auto'. */
export const VOICE_LIMIT_CHOICES = Object.freeze(['auto', 128, 256, 512, 'off']);
export const VOICE_LIMIT_DEFAULT = 'auto';
const SOUND_2_CHOICES = Object.freeze({
  polyphony: POLYPHONY_CHOICES, bufferFrames: BUFFER_FRAMES_CHOICES, voiceLimit: VOICE_LIMIT_CHOICES,
});
/**
 * A valid value for one of the 2.0 Sound settings, else undefined. Numeric strings ("128", from a hand-edited or
 * exported file) are accepted for the numeric choices; anything off the list is refused, never clamped (a buffer of
 * 100 frames is not "almost 128").
 * @param {'polyphony'|'bufferFrames'|'voiceLimit'} key
 * @param {*} v
 * @returns {number|string|undefined}
 */
export function validSound2(key, v) {
  const list = SOUND_2_CHOICES[key];
  if (!list) return undefined;
  if (list.includes(v)) return v;
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return list.includes(n) ? n : undefined;
}
/**
 * The 2.0 Sound settings with their defaults filled in (the store keeps them absent until the user picks one).
 * @param {object} settings
 * @returns {{polyphony:number, bufferFrames:number, voiceLimit:(number|'auto'|'off')}}
 */
export function sound2Of(settings) {
  const s = settings || {};
  return {
    polyphony: validSound2('polyphony', s.polyphony) ?? POLYPHONY_DEFAULT,
    bufferFrames: validSound2('bufferFrames', s.bufferFrames) ?? BUFFER_FRAMES_DEFAULT,
    voiceLimit: validSound2('voiceLimit', s.voiceLimit) ?? VOICE_LIMIT_DEFAULT,
  };
}
/**
 * Chart view (D7, hidden; CONTRACT_CHANGES "Chart view (D7, hidden)"): song.chart is optional (absent until a chart is
 * added) = `{text, format?, key?, name?}`. `text` is the raw source (ChordPro or plain chord-over-lyrics) and is the
 * only thing stored: the parsed model is derived at view time (views/chart/logic.js). `format` is 'chordpro' | 'plain'
 * (absent = detect at view time), `key` the key the chart is written in when its source names none, `name` the file
 * it came from. Unknown fields are kept. CHART_MAX_CHARS caps `text` (UTF-16 units, what localStorage counts).
 */
export const CHART_MAX_CHARS = 65536;
export const CHART_FORMATS = Object.freeze(['chordpro', 'plain']);
const CHART_KEY_RE = /^[A-G][#b]?m?$/;
const CHART_NAME_MAX = 200;

/**
 * Normalise a song.chart value (migrate, store writes). Idempotent.
 * @param {*} raw
 * @returns {object|null} null = no usable chart (not an object, empty or over CHART_MAX_CHARS)
 */
export function normalizeChart(raw) {
  if (!isObj(raw) || typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > CHART_MAX_CHARS) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) if (!isReservedKey(k)) out[k] = clone(v);
  if (!CHART_FORMATS.includes(out.format)) delete out.format;
  if (hasOwn(out, 'key') && !(typeof out.key === 'string' && CHART_KEY_RE.test(out.key))) delete out.key;
  if (hasOwn(out, 'name')) {
    if (typeof out.name === 'string' && out.name.trim()) out.name = out.name.trim().slice(0, CHART_NAME_MAX);
    else delete out.name;
  }
  return out;
}

/**
 * Why a chart can't be stored, in words for the user (null = it can).
 * @param {*} raw
 * @returns {string|null}
 */
export function chartError(raw) {
  if (!isObj(raw) || typeof raw.text !== 'string' || !raw.text.trim()) return 'The chart is empty.';
  if (raw.text.length > CHART_MAX_CHARS) {
    return `That chart is too large (${Math.ceil(raw.text.length / 1024)} KB). A chart can be at most `
      + `${CHART_MAX_CHARS / 1024} KB.`;
  }
  return null;
}

/** v11-metronome: settings.midiClockOut (optional, absent = off) is a Web MIDI output name; ids change on re-plug. */
export const MIDI_CLOCK_NAME_MAX = 120;
/**
 * Lane S (DECISIONS D6): what a Program Change does when settings.programChange is on: 'cue' (the song waits for GO)
 * or 'switch' (the 1.x jump). settings.programChangeAction is optional. DECISIONS O-AW-3 (review S-cue-go S6): absent
 * with PC on (every 1.x library) = 'switch', so a program-button player keeps the behaviour they had; turning PC on
 * in 2.0 (store.set false → true while absent) writes PC_ACTION_DEFAULT ('cue') explicitly, so new users get cue.
 */
export const PC_ACTIONS = Object.freeze(['cue', 'switch']);
export const PC_ACTION_DEFAULT = 'cue';
/** O-AW-3: what an absent settings.programChangeAction means while PC is on (a 1.x library). */
export const PC_ACTION_LEGACY = 'switch';
/**
 * Lane S: settings.programChangeChannel (optional; absent = any channel) is the one MIDI channel, 0..15 (shown 1..16),
 * whose Program Change picks songs, so another keyboard's patch change can't (S1 audit risk 8).
 * @param {*} v @returns {number|undefined} the valid channel, undefined when `v` is not one
 */
export function validPcChannel(v) {
  return Number.isInteger(v) && v >= 0 && v <= 15 ? v : undefined;
}
/**
 * Lane S: the effective Program Change settings. An absent action reads 'switch' while PC is on (O-AW-3: a 1.x
 * library) and 'cue' while it is off (what turning it on will write, so Settings shows that).
 * @param {object} settings
 * @returns {{on:boolean, channel:number|null, action:'cue'|'switch'}}
 */
export function programChangeOf(settings) {
  const s = settings || {};
  const on = !!s.programChange;
  return {
    on,
    channel: validPcChannel(s.programChangeChannel) ?? null,
    action: PC_ACTIONS.includes(s.programChangeAction) ? s.programChangeAction
      : on ? PC_ACTION_LEGACY : PC_ACTION_DEFAULT,
  };
}
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
/**
 * D9 (review E5 M3): a replace / restore import may bring a library up to 1.25× LIBRARY_MAX_CHARS. Saves are not
 * capped (a library grown past the cap by notes is warned about, not refused), so its own backup must still restore.
 */
export const LIBRARY_RESTORE_MAX_CHARS = Math.round(LIBRARY_MAX_CHARS * 1.25);
/** D9: a save past the cap warns once per store (session), then again at each further 10 % of growth. */
export const SIZE_WARN_STEP = 1.1;
/** D8: the key 1.1.1 keeps its separate 1.x library under while the main key holds a 2.0 library. */
export const SEPARATE_1X_SUFFIX = '.1x';
/** D8: kinds of kept copies (never rotated). */
export const KEPT_KINDS = Object.freeze(['migration', 'downgrade', 'restore']);
/** D8: 'schema 1 → "1.x"', 'schema 2 → "2.0"' (which app version wrote a library). */
export const versionOfSchema = (schema) => (schema === 1 ? '1.x' : schema === 2 ? '2.0' : `schema ${schema}`);
/** E5: top-level fields of an export file / disk backup that are not library state (importJSON drops them). */
export const IMPORT_ENVELOPE_KEYS = Object.freeze(['app', 'kind', 'exportedAt', 'origin']);
/** security S2: deepest nesting an import may have (real exports reach ~8: songs.<id>.patch.slots.<i>.eq.b3.hz). */
export const IMPORT_MAX_DEPTH = 64;
/**
 * D11: Worship Rig 1.1.1 writes this machine's device-local settings into its backups and exports as an optional
 * top-level block, `deviceSettings` = {v, install, settings}. importJSON never keeps it in the state: it hands it to
 * the caller (`result.deviceSettings`), and controller.applyDeviceSettings consumes it (CONTRACT_CHANGES "D11").
 */
export const DEVICE_SETTINGS_KEY = 'deviceSettings';
/**
 * D11: the 1.x device-local settings a block may bring: 1.1's DEVICE_LOCAL_SETTINGS. 2.0's own additions (voices,
 * buffer, voice limit, drone freeze, chart view) are about this machine's CPU and are never taken from a file.
 */
export const DEVICE_BLOCK_SETTINGS = Object.freeze([
  'outputDeviceId', 'padFolder', 'midiInputId', 'midiInputName', 'menuBarMode', 'lowResource', 'audioSleepSec',
  'hotkeys', 'updateCheck', 'click', 'midiClockOut', 'keyboards', 'dynamicRange',
]);
/** D11: the device selections of a block; they apply only when the device or folder is found here (controller). */
export const DEVICE_SELECTIONS = Object.freeze(['outputDeviceId', 'padFolder', 'midiInputId', 'midiInputName',
  'midiClockOut']);
/**
 * D11: the machine marker. 1.1.1 makes a random id once per origin under this key (outside the library). 2.0 Chrome
 * on the same origin reads the same key; native / Electron 2.0 also remember the markers of blocks they took on a
 * same-machine path (KNOWN_INSTALLS_KEY, newest first, at most KNOWN_INSTALLS_MAX).
 */
export const INSTALL_ID_KEY = 'rig.install';
export const KNOWN_INSTALLS_KEY = 'rig.install.known';
export const KNOWN_INSTALLS_MAX = 8;
const INSTALL_ID_RE = /^[0-9a-f]{32}$/;
/** @param {*} v @returns {boolean} `v` is a machine marker as 1.1.1 writes it */
export const validInstallId = (v) => typeof v === 'string' && INSTALL_ID_RE.test(v);

/**
 * D11: one device-local value from a block, checked with this store's own validators. Unknown keys, and values the
 * store would refuse or drop, give undefined. A value equal to the default (or absent) is valid: nothing to apply.
 * @param {string} k
 * @param {*} v
 * @returns {*} the value as the store keeps it, or undefined (invalid)
 */
export function validDeviceSetting(k, v) {
  if (!DEVICE_BLOCK_SETTINGS.includes(k) || v === undefined) return undefined;
  const fn = SETTINGS_VALIDATORS[k];
  if (fn) {
    const r = fn(v);
    if (r === INVALID) return undefined;
    // an Electron pad folder needs its path, an FSA one its name (nothing else can be checked or shown)
    if (k === 'padFolder' && r && r.kind === 'electron' && !(typeof r.path === 'string' && r.path)) return undefined;
    return r;
  }
  const out = normalizeSettings({ [k]: v }, {}, {});
  if (hasOwn(out, k)) return out[k];
  return k === 'dynamicRange' && v === 1 ? 1 : undefined; // 1 is stored as absent (the default)
}

/**
 * D11: read a `deviceSettings` block. Never throws.
 * @param {*} raw
 * @returns {{v:number, install:(string|null), settings:object, dropped:string[]}|null} null = no usable block
 *   (not an object, no settings map, or a version this build does not know). `dropped` = unknown / invalid keys.
 */
export function readDeviceSettings(raw) {
  if (!isObj(raw) || !Number.isInteger(raw.v) || raw.v < 1 || raw.v > 1 || !isObj(raw.settings)) return null;
  const settings = {};
  const dropped = [];
  for (const [k, v] of Object.entries(raw.settings)) {
    const ok = isReservedKey(k) ? undefined : validDeviceSetting(k, v);
    if (ok === undefined) dropped.push(String(k).slice(0, 40));
    else settings[k] = ok;
  }
  return { v: raw.v, install: validInstallId(raw.install) ? raw.install : null, settings, dropped };
}

/**
 * D11 skeptic (DS1): the device-local settings changed on this machine, kept outside the library (per origin, like
 * rig.install) as a JSON array: setting keys, and `keyboards:<name>` per keyboard entry. A value set back to its
 * default looks unset in the library, so this is what keeps a 1.1.1 block from overwriting it.
 */
export const DEVICE_TOUCHED_KEY = 'rig.device.touched';
/** @param {string} name a keyboard name @returns {string} its DEVICE_TOUCHED_KEY entry */
export const touchedKeyboard = (name) => `keyboards:${name}`;

/**
 * D11: is device-local setting `k` still unset in `settings` (absent, or its default) and never changed on this
 * machine? Only these are filled in from a block: a setting changed here is never overwritten, also when it was set
 * back to its default (DS1: `touched`, from store.deviceSettingsTouched()).
 * @param {object} settings
 * @param {string} k
 * @param {Iterable<string>} [touched] the device-local keys changed on this machine
 * @returns {boolean}
 */
export function deviceSettingUnset(settings, k, touched = null) {
  const s = settings || {};
  if (touched) {
    const t = touched instanceof Set ? touched : new Set(touched);
    if (t.has(k === 'midiInputName' ? 'midiInputId' : k)) return false;
  }
  if (k === 'midiInputId' || k === 'midiInputName') return (s.midiInputId ?? 'first') === 'first';
  if (hasOwn(DEFAULT_SETTINGS, k)) return deepEqual(s[k] ?? DEFAULT_SETTINGS[k], DEFAULT_SETTINGS[k]);
  if (k === 'dynamicRange') return s.dynamicRange === undefined || s.dynamicRange === 1;
  return s[k] === undefined;
}

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
 * enums keep params.clamp's coercion; dynamic instrument params also accept booleans/strings. sustain: a row's
 * `words` ('natural') pass as-is, and null / undefined on an `optional` row resolve to undefined (the field is removed).
 * @returns {*|typeof INVALID}
 */
function strictParam(p, value) {
  const e = describe(p);
  if (!e) return INVALID;
  if (e.unit === 'bool' || e.unit === 'enum') return clamp(p, value);
  if (e.dynamic && (typeof value === 'boolean' || typeof value === 'string')) return value;
  if (e.words && e.words.includes(value)) return value;
  if (e.optional && (value === null || value === undefined)) return undefined;
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
    if (c === null || c === undefined) {
      if (segs.length === 1) delete out[segs[0]]; // sustain: an optional row at its null default stays absent
      continue;
    }
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

/**
 * UIA: a wheel / pedal / volume-knob target for a song with `n` slots: presets.WHEEL_TARGETS without its four slot
 * levels, plus 'slots.<i>.gain' for every i < n. With 4 slots that is exactly WHEEL_TARGETS (1.x).
 * @param {*} t
 * @param {number} [n=SLOT_COUNT]
 * @returns {boolean}
 */
export function isWheelTarget(t, n = SLOT_COUNT) {
  if (typeof t !== 'string') return false;
  if (t.startsWith('slots.')) return slotGainIndex(t, n) !== null;
  return WHEEL_TARGETS.includes(t);
}
/** A valid target for n slots: `t`, else `def`, else 'none' (a 1-slot song has no 'slots.1.gain'). */
const wheelTarget = (t, def, n) => (isWheelTarget(t, n) ? t : isWheelTarget(def, n) ? def : 'none');

function normalizeWheel(raw, defTarget, n = SLOT_COUNT) {
  const w = isObj(raw) ? raw : {};
  const out = {
    ...w, target: wheelTarget(w.target, defTarget, n), min: num(w.min, 0, 1, 0), max: num(w.max, 0, 1, 1),
  };
  // v11-touch: expression.curve is optional ('linear' | 'log'; absent = linear); an unknown value is dropped
  if (out.curve !== undefined && !PEDAL_CURVES.includes(out.curve)) delete out.curve;
  return out;
}

/**
 * UIA: how many slots a stored `slots` value gives a song. Schema 2: its length, 1..MAX_SLOTS (more are cut; none or an
 * empty array = a new song's SLOT_COUNT). Schema 1 (`legacy`): always SLOT_COUNT, padded or cut as 1.x did.
 * @param {*} slots
 * @param {boolean} [legacy]
 * @returns {number}
 */
export function slotCountOf(slots, legacy = false) {
  if (legacy || !Array.isArray(slots) || slots.length === 0) return SLOT_COUNT;
  return Math.min(MAX_SLOTS, slots.length);
}

/**
 * @param {*} raw
 * @param {{legacy?:boolean}} [o] legacy: the patch comes from a schema-1 library (exactly 4 slots)
 * @returns {object}
 */
export function normalizePatch(raw, { legacy = false } = {}) {
  const p = isObj(raw) ? raw : {};
  const r = defaultRouting();
  const slots = Array.isArray(p.slots) ? p.slots : [];
  const bend = isObj(p.bend) ? p.bend : {};
  const swell = isObj(p.swell) ? p.swell : {};
  const vol = isObj(p.volume) ? p.volume : {};
  const n = slotCountOf(p.slots, legacy);
  return {
    ...p,
    slots: Array.from({ length: n }, (_, i) => normalizeSlot(slots[i], i)),
    fx: normalizeFx(p.fx),
    modWheel: normalizeWheel(p.modWheel, r.modWheel.target, n),
    expression: normalizeWheel(p.expression, r.expression.target, n),
    volume: { ...vol, target: wheelTarget(vol.target, r.volume.target, n) },
    bend: { ...bend, mode: oneOf(bend.mode, BEND_MODES, r.bend.mode), range: int(bend.range, 0, 24, r.bend.range) },
    swell: normalizeSwell(swell, r.swell.seconds),
  };
}

/** v11-touch: swell.pedal is optional (true = the sustain pedal also swells the drone; anything else = absent). */
function normalizeSwell(swell, defSeconds) {
  const out = { ...swell, seconds: num(swell.seconds, 1, 60, defSeconds) };
  if (out.pedal !== true) delete out.pedal;
  return out;
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

/**
 * @param {*} raw
 * @param {string} [id]
 * @param {{legacy?:boolean}} [o] legacy: from a schema-1 library (UIA: exactly 4 slots, as 1.x stored them)
 * @returns {object|null}
 */
export function normalizeSong(raw, id, { legacy = false } = {}) {
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
  // v11-metronome: song.timeSig is optional (absent = 4/4); an unknown signature is dropped
  if (hasOwn(out, 'timeSig') && validTimeSig(out.timeSig) === undefined) delete out.timeSig;
  out.patch = normalizePatch(raw.patch, { legacy });
  out.drone = normalizeDrone(raw.drone);
  // v11-scenes: optional (absent until a scene is saved); an empty or unusable list is dropped, so migrate stays
  // idempotent
  const scenes = normalizeScenes(raw.scenes, out.patch.slots.length); // UIA: one entry per slot (at least 4)
  if (scenes) out.scenes = scenes;
  else delete out.scenes;
  // Chart view (D7): optional, absent until a chart is added; an unusable or oversized one is dropped (idempotent)
  if (hasOwn(out, 'chart')) {
    const chart = normalizeChart(out.chart);
    if (chart) out.chart = chart;
    else delete out.chart;
  }
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
    // 2.x step 5 (O-AW-ML): a learnable path's optional min / max / invert are validated (learnFields); other keys,
    // including unknown ids from a newer version, keep every field as before
    if (Number.isInteger(v.cc) && v.cc >= 0 && v.cc <= 127) out[k] = learnFields(k, { ...v, channel: ch });
    else if (Number.isInteger(v.note) && v.note >= 0 && v.note <= 127) out[k] = learnFields(k, { ...v, channel: ch });
  }
  return out;
}

/** v11-touch: settings.keyboards (see COMPUTER_KEYBOARD). Unknown entry fields are kept; empty entries dropped. */
export function normalizeKeyboards(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [name, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= KEYBOARDS_MAX) break;
    if (!name || name.length > KEYBOARD_NAME_MAX || isReservedKey(name) || !isObj(v)) continue;
    const e = {};
    for (const [k, x] of Object.entries(v)) if (!isReservedKey(k)) e[k] = clone(x);
    if (e.touch !== undefined) {
      if (isObj(e.touch)) e.touch = normalizeTouch(e.touch);
      else delete e.touch;
    }
    if (e.remember !== true) delete e.remember;
    if (Object.keys(e).length) out[name] = e;
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
  if (hasOwn(out, 'keyboards')) {
    // v11-touch: optional; an empty or invalid map is dropped (absent = no keyboard has its own settings)
    const kb = normalizeKeyboards(out.keyboards);
    if (Object.keys(kb).length) out.keyboards = kb;
    else delete out.keyboards;
  }
  if (hasOwn(out, 'audioSleepSec')) {
    // lowres2: optional; an invalid value is dropped (absent = the default), never kept
    const v = validAudioSleepSec(out.audioSleepSec);
    if (v === null) delete out.audioSleepSec;
    else out.audioSleepSec = v;
  }
  // v11-electron: optional, absent until set; a bad value is dropped (absent = the default), never kept
  if (hasOwn(out, 'hotkeys')) {
    const v = normalizeHotkeys(out.hotkeys);
    if (v === null) delete out.hotkeys;
    else out.hotkeys = v;
  }
  if (hasOwn(out, 'updateCheck') && typeof out.updateCheck !== 'boolean') delete out.updateCheck;
  // UIB (D5): settings.droneFreeze optional, absent = on (1.x behaviour); a non-boolean is dropped
  if (hasOwn(out, 'droneFreeze') && typeof out.droneFreeze !== 'boolean') delete out.droneFreeze;
  // settings.dynamicRange: optional (absent = 1, today's sound); a bad value is dropped, 1 is stored as absent
  if (hasOwn(out, 'dynamicRange')) {
    const v = validDynRange(out.dynamicRange);
    if (v === null || v === 1) delete out.dynamicRange;
    else out.dynamicRange = v;
  }
  // v11-metronome: settings.click / settings.midiClockOut are optional, absent until set; bad values are dropped
  if (hasOwn(out, 'click')) {
    const c = normalizeClick(out.click);
    if (c && Object.keys(c).length) out.click = c;
    else delete out.click;
  }
  if (hasOwn(out, 'midiClockOut') && validMidiClockOut(out.midiClockOut) === undefined) delete out.midiClockOut;
  // Chart view (D7, hidden): settings.chartView is true or absent (off); anything else is dropped
  if (hasOwn(out, 'chartView') && out.chartView !== true) delete out.chartView;
  // Lane S: optional Program Change channel / action; a bad value is dropped (absent = any channel; the action as
  // programChangeOf reads it, O-AW-3). Never filled in here: an imported 1.x library with PC on stays 'switch'.
  if (hasOwn(out, 'programChangeChannel') && validPcChannel(out.programChangeChannel) === undefined) {
    delete out.programChangeChannel;
  }
  if (hasOwn(out, 'programChangeAction') && !PC_ACTIONS.includes(out.programChangeAction)) {
    delete out.programChangeAction;
  }
  // 2.0 Sound (D1, D2, D4): optional, absent = the default (no SCHEMA bump); a value off the list is dropped
  for (const k of Object.keys(SOUND_2_CHOICES)) {
    if (!hasOwn(out, k)) continue;
    const v = validSound2(k, out[k]);
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** v11-metronome: a MIDI output name for settings.midiClockOut, else undefined (= off). */
function validMidiClockOut(v) {
  return typeof v === 'string' && v && v.length <= MIDI_CLOCK_NAME_MAX ? v : undefined;
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
 * Migrate/normalise a raw state object to schema 2. Idempotent; unknown fields are preserved.
 * Schema 1 → 2 (UIA): every song keeps its 4 slots exactly as 1.x normalised them (`legacy`); nothing else changes.
 * A state without `schema` (hand-written files) is read as schema 1 for its slots (4 per song) and as the current
 * schema otherwise; the store's own drafts carry SCHEMA.
 * @param {object} raw
 * @returns {object} normalised (not frozen) state
 * @throws {FutureSchemaError} schema newer than SCHEMA; {TypeError} not a state object
 */
export function migrate(raw) {
  if (!isObj(raw)) throw new TypeError('migrate: state must be an object');
  const schema = raw.schema === undefined ? SCHEMA : raw.schema;
  if (typeof schema !== 'number' || !Number.isFinite(schema)) throw new TypeError('migrate: bad schema');
  if (schema > SCHEMA) throw new FutureSchemaError(schema);
  // UIA: schema 1, and a state without one (hand-written files, 1.x-era docs), keep exactly 4 slots per song
  const legacy = raw.schema === undefined || schema < 2;
  const out = { ...raw, schema: SCHEMA };
  // D11 skeptic (DS3): 1.1.0 and pre-D11 2.0 keep an imported 1.1.1 file's device block as an unknown top-level field,
  // so it can sit in a stored library (rig.v1, a kept copy). It is another computer's device data, never library
  // state: importJSON reads it from the file itself, and every other path drops it here.
  delete out[DEVICE_SETTINGS_KEY];
  // songs: map (array accepted for hand-written files)
  const songs = {};
  const srcSongs = Array.isArray(raw.songs) ? entriesFromArray(raw.songs, 'song') : isObj(raw.songs) ? raw.songs : {};
  for (const [id, s] of Object.entries(srcSongs)) {
    if (!id || id === 'undefined' || isReservedKey(id)) continue;
    const n = normalizeSong(s, id, { legacy });
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
  // O-AW-PP: optional; unusable entries are dropped, an empty map is dropped (idempotent)
  if (hasOwn(out.meta, 'packSongs')) {
    const recs = normalizePackRecords(out.meta.packSongs);
    if (recs) out.meta.packSongs = recs;
    else delete out.meta.packSongs;
  }
  return out;
}

/**
 * meta.packSongs (O-AW-PP), cleaned: entries keyed by a valid pack id with {id:string, hash:string, sig:string}.
 * @param {*} raw
 * @returns {object|null} null when nothing usable is left
 */
function normalizePackRecords(raw) {
  if (!isObj(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (isReservedKey(k) || k.length > PACK_ID_MAX || !PACK_ID_RE.test(k) || !isObj(v)) continue;
    if (typeof v.id !== 'string' || !v.id || typeof v.hash !== 'string' || typeof v.sig !== 'string') continue;
    out[k] = { id: v.id, hash: v.hash, sig: v.sig };
  }
  return Object.keys(out).length ? out : null;
}

/** Empty (unseeded) state at the current SCHEMA. */
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
  let deviceTouched = null; // D11 skeptic DS1: Set of DEVICE_TOUCHED_KEY entries, read on first use
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
  /**
   * Delete the oldest backup keys so that at most `keep` remain (never `except`). D8: a readable whole library in the
   * rotation is never pruned (load moves it to a kept copy; one is left here only when that move did not fit).
   */
  function pruneBackups(keep, except = null) {
    const ks = backupKeys().filter((k) => k !== except && librarySchemaOf(storage.getItem(k)) === null);
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

  // ---- kept copies (D8)
  const keptPrefix = `${key}.kept-`;
  const KEPT_RE = /^(\d+)\.(migration|downgrade|restore)\.s(\d+)(?:\.\d+)?$/;
  const notices = [];
  const noticeListeners = new Set();
  /** Tell the UI (the controller toasts `message`); held until the first onNotice subscriber (load-time notices). */
  function notice(n) {
    if (!noticeListeners.size) {
      notices.push(n);
      return;
    }
    for (const fn of [...noticeListeners]) {
      try {
        fn(n);
      } catch (err) {
        warn(`notice listener failed: ${err && err.message}`);
      }
    }
  }
  function allKeys() {
    try {
      const n = typeof storage.length === 'number' ? storage.length : 0;
      return typeof storage.keys === 'function' ? storage.keys() : Array.from({ length: n }, (_, i) => storage.key(i));
    } catch {
      return [];
    }
  }
  /** @returns {{key:string, savedAt:number, kind:string, schema:number}[]} oldest first */
  function keptEntries() {
    const out = [];
    for (const k of allKeys()) {
      if (typeof k !== 'string' || !k.startsWith(keptPrefix)) continue;
      const m = KEPT_RE.exec(k.slice(keptPrefix.length));
      if (m) out.push({ key: k, savedAt: Number(m[1]), kind: m[2], schema: Number(m[3]) });
    }
    return out.sort((a, b) => a.savedAt - b.savedAt || a.key.localeCompare(b.key));
  }
  /** Schema of a readable whole library (absent = 1, as migrate() reads it), else null (unreadable / not a library). */
  function librarySchemaOf(text) {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isObj(doc) || !(isObj(doc.songs) || Array.isArray(doc.songs))) return null;
    return typeof doc.schema === 'number' ? doc.schema : 1;
  }
  /** Song and setlist ids of a whole-library text, or null when it is not one (D8 skeptic K2: lineage proxy). */
  function idsOf(text) {
    let doc;
    try {
      doc = typeof text === 'string' ? JSON.parse(text) : text;
    } catch {
      return null;
    }
    if (!isObj(doc)) return null;
    const out = new Set();
    if (Array.isArray(doc.songs)) for (const x of doc.songs) out.add(`s:${isObj(x) ? x.id : x}`);
    else if (isObj(doc.songs)) for (const k of Object.keys(doc.songs)) out.add(`s:${k}`);
    else return null;
    if (isObj(doc.setlists)) for (const k of Object.keys(doc.setlists)) out.add(`l:${k}`);
    return out;
  }
  const covers = (big, small) => !!big && !!small && [...small].every((x) => big.has(x));
  /**
   * D8 quota policy: free space by removing ONE kept copy, oldest first, that is an earlier state of a library that is
   * still kept: every song and setlist it has is in a newer kept copy of the same version (schema), or, for a 2.0
   * copy, in the library saved under the main key and in memory. The newest copy of every version is never removed,
   * and neither is `protect` (the copy a restore is about to bring back).
   * D8 skeptic K2: "superseded" was "any newer copy of the same schema", so a set-aside 2.0 library of 300 songs was
   * removed to make room while a later factory-seed copy of the same version stayed.
   * D8 skeptic K1: without `protect`, keeping the current library before a restore could remove the copy being
   * restored. @returns {object|null} the removed entry
   */
  function removeOneSuperseded(except = null, { protect = null } = {}) {
    const all = keptEntries().filter((e) => e.key !== except);
    const newest = new Map();
    for (const e of all) newest.set(e.schema, e.key); // sorted oldest first: the last one wins
    const ids = new Map();
    const idsAt = (k) => {
      if (!ids.has(k)) {
        let t = null;
        try {
          t = storage.getItem(k);
        } catch {
          t = null;
        }
        ids.set(k, idsOf(t));
      }
      return ids.get(k);
    };
    // the main library: what is stored and what will be stored (a failed write leaves the stored one)
    let main = idsAt(key);
    if (main && state) {
      const live = idsOf(state);
      main = new Set([...main].filter((x) => live && live.has(x)));
    }
    const victim = all.find((e, i) => {
      if (e.key === protect || newest.get(e.schema) === e.key) return false;
      const mine = idsAt(e.key);
      if (!mine) return false;
      if (e.schema === SCHEMA && covers(main, mine)) return true;
      return all.slice(i + 1).some((o) => o.schema === e.schema && covers(idsAt(o.key), mine));
    });
    if (!victim) return null;
    try {
      storage.removeItem(victim.key);
    } catch {
      return null;
    }
    return victim;
  }
  function noticeRemoved(removed, why) {
    if (!removed.length) return;
    const list = removed.map((e) => `${versionOfSchema(e.schema)} from ${new Date(e.savedAt).toLocaleDateString()}`);
    const n = removed.length;
    notice({
      type: 'kept-removed',
      removed: removed.map((e) => ({ key: e.key, schema: e.schema, savedAt: e.savedAt, kind: e.kind })),
      message: `Browser storage was full, so ${n === 1 ? 'an older kept copy' : `${n} older kept copies`} of your `
        + `library (${list.join(', ')}) ${n === 1 ? 'was' : 'were'} removed to ${why}. Every song in `
        + `${n === 1 ? 'it' : 'them'} is in a newer kept copy or your current library. Export your library from `
        + 'Settings to be safe.',
    });
  }
  /**
   * Store `text` as a kept copy. On a quota error, superseded copies (removeOneSuperseded) are removed one at a time
   * (with a notice) until it fits; the newest copy of each version stays.
   * @returns {string|null} the key, or null when it could not be kept
   */
  function keepRaw(text, kind, schema, ts = now(), { protect = null } = {}) {
    let k = `${keptPrefix}${ts}.${kind}.s${schema}`;
    for (let i = 2; storage.getItem(k) !== null; i++) k = `${keptPrefix}${ts}.${kind}.s${schema}.${i}`;
    const removed = [];
    let lastErr = null;
    for (;;) {
      try {
        storage.setItem(k, text);
        if (storage.getItem(k) !== text) throw new Error('kept copy did not read back');
        noticeRemoved(removed, 'keep a new one');
        return k;
      } catch (err) {
        lastErr = err;
        try {
          storage.removeItem(k);
        } catch {
          /* ignore */
        }
        const gone = removeOneSuperseded(k, { protect });
        if (!gone) break;
        removed.push(gone);
      }
    }
    noticeRemoved(removed, 'keep a new one');
    warn(`could not keep a copy of the ${versionOfSchema(schema)} library: ${(lastErr && lastErr.message) || lastErr}`);
    return null;
  }
  /**
   * D8: a whole library in the ordinary `.backup-` rotation (1.x sets a 2.0 library aside there, and 1.x and 2.0
   * before D8 kept migration copies there; 1.1.0 prunes it to 3 per launch) moves to a kept copy, keeping its time.
   * The rotation keeps what is not a readable library (a corrupt text). A text already kept is not kept twice.
   */
  function adoptRotationLibraries() {
    const have = new Set();
    for (const e of keptEntries()) {
      try {
        have.add(storage.getItem(e.key));
      } catch {
        /* ignore */
      }
    }
    for (const k of backupKeys()) {
      let text;
      try {
        text = storage.getItem(k);
      } catch {
        continue;
      }
      if (typeof text !== 'string') continue;
      const schema = librarySchemaOf(text);
      if (schema === null) continue;
      const ts = Number(k.slice(backupPrefix.length)) || now();
      const kept = have.has(text) ? true : keepRaw(text, schema < SCHEMA ? 'migration' : 'downgrade', schema, ts);
      if (!kept) continue; // stays in the rotation; keepRaw warned
      have.add(text);
      try {
        storage.removeItem(k);
      } catch {
        /* the copy is kept; a leftover rotation key is harmless */
      }
      info.adopted = (info.adopted || 0) + 1;
    }
  }
  adoptRotationLibraries(); // D8: before anything below can rotate the `.backup-` keys
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
      const parsed = JSON.parse(raw);
      state = deepFreeze(migrate(parsed));
      // UIA: an older schema with songs in it keeps a copy of itself first (1.1 cannot read schema 2, and this copy is
      // what it would need). Best effort: the upgrade goes ahead without it, and nothing here is shown as an error.
      // D8: the copy is a kept copy (never rotated; 1.1.0 prunes the `.backup-` keys). An untouched 1.x factory seed
      // (1.x seeds one when it sets a 2.0 library aside) holds nothing of the user's and is not kept.
      if (isObj(parsed) && typeof parsed.schema === 'number' && parsed.schema < SCHEMA && isObj(parsed.songs)
        && Object.keys(parsed.songs).length && !(isObj(parsed.meta) && parsed.meta.edited === false)) {
        info.migratedFrom = parsed.schema;
        const k = keepRaw(String(raw), 'migration', parsed.schema);
        if (k) info.migrationBackupKey = k;
        else warn(`could not keep the schema-${parsed.schema} library before upgrading it`);
      }
    } catch (err) {
      info.status = err instanceof FutureSchemaError ? 'future-schema' : 'corrupt';
      unreadable = String(raw);
      // D8: a newer version's library (a downgrade) is a kept copy, never rotated; a corrupt text goes to the rotation
      const keptKey = err instanceof FutureSchemaError ? keepRaw(unreadable, 'downgrade', err.schema) : null;
      if (keptKey) info.backupKey = keptKey;
      if (keptKey || (!(err instanceof FutureSchemaError) && backupRaw(unreadable))) {
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

  // ---- D11 skeptic DS1: which device-local settings were changed on this machine (outside the library)
  function touchedSet() {
    if (deviceTouched) return deviceTouched;
    deviceTouched = new Set();
    try {
      const a = JSON.parse(storage.getItem(DEVICE_TOUCHED_KEY) || '[]');
      if (Array.isArray(a)) for (const x of a) if (typeof x === 'string' && x.length <= 80) deviceTouched.add(x);
    } catch {
      /* unreadable: nothing known */
    }
    return deviceTouched;
  }
  /**
   * Record the device-local settings a set()/update() changed. midiInputName is not a choice (the controller writes
   * the chosen input's name); a keyboard counts per name, so deleting one here also keeps it deleted.
   */
  function noteDeviceWrites(before, after) {
    const b = (before && before.settings) || {};
    const a = (after && after.settings) || {};
    const t = touchedSet();
    const n = t.size;
    for (const k of DEVICE_BLOCK_SETTINGS) {
      if (k === 'midiInputName' || deepEqual(b[k], a[k])) continue;
      if (k !== 'keyboards') {
        t.add(k);
        continue;
      }
      const kb = isObj(b.keyboards) ? b.keyboards : {};
      const ka = isObj(a.keyboards) ? a.keyboards : {};
      for (const name of new Set([...Object.keys(kb), ...Object.keys(ka)])) {
        if (!deepEqual(kb[name], ka[name])) t.add(touchedKeyboard(name));
      }
    }
    if (t.size === n || readOnlyReason !== null) return; // a read-only window's changes are not saved either
    try {
      const cap = DEVICE_BLOCK_SETTINGS.length + KEYBOARDS_MAX * 2;
      storage.setItem(DEVICE_TOUCHED_KEY, JSON.stringify([...t].slice(-cap)));
    } catch {
      /* storage full: this session still knows */
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
    const json = JSON.stringify(state);
    try {
      try {
        storage.setItem(key, json);
      } catch (err) {
        // D8 quota policy: an older kept copy that a newer copy of its version supersedes makes room for the library
        const removed = [];
        for (let gone = removeOneSuperseded(); gone; gone = removeOneSuperseded()) {
          removed.push(gone);
          try {
            storage.setItem(key, json);
            noticeRemoved(removed, 'save your changes');
            break;
          } catch {
            /* remove another */
          }
        }
        if (!removed.length || storage.getItem(key) !== json) {
          noticeRemoved(removed, 'save your changes');
          throw err;
        }
      }
      checkSize(json.length);
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
  // D9 (review E5 M3): saves are not capped. Past the cap the user is told once per session, then at +10 % steps.
  let sizeWarnedAt = 0;
  function checkSize(chars) {
    if (chars <= LIBRARY_MAX_CHARS || (sizeWarnedAt && chars < sizeWarnedAt * SIZE_WARN_STEP)) return;
    sizeWarnedAt = chars;
    const mb = (n) => (n / 1e6).toFixed(1);
    notice({
      type: 'library-size', chars, cap: LIBRARY_MAX_CHARS,
      message: `Your library is now ${mb(chars)} MB, more than the ${mb(LIBRARY_MAX_CHARS)} MB it is meant to hold. `
        + `It is still saved, but a backup over ${mb(LIBRARY_RESTORE_MAX_CHARS)} MB cannot be restored. Remove charts `
        + 'or long notes you no longer need, and export the library from Settings.',
    });
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

  /**
   * Chart view (D7): would storing `chart` on song `id` push the library past LIBRARY_MAX_CHARS (security S2's cap,
   * which keeps every later save inside localStorage)? Only chart writes pay for the JSON size.
   */
  function chartOverflows(id, chart) {
    const old = state.songs[id] && state.songs[id].chart;
    const size = JSON.stringify(state).length - (old ? JSON.stringify(old).length : 0) + JSON.stringify(chart).length;
    return size > LIBRARY_MAX_CHARS;
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
      // v11-scenes: the scenes list is written whole (shared/scenes.js); null / [] removes the field
      if (field === 'scenes') {
        if (rest.length) return null;
        if (value !== null && value !== undefined && !Array.isArray(value)) return null;
        return { segs, value: normalizeScenes(value, song.patch.slots.length) }; // UIA: one entry per slot
      }
      // Chart view (D7): written whole (store.setChart says why a write is refused); null / undefined removes it
      if (field === 'chart') {
        if (rest.length) return null;
        if (value === null || value === undefined) return { segs, value: undefined };
        const chart = normalizeChart(value);
        if (!chart || chartOverflows(id, chart)) return null;
        return { segs, value: chart };
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
        case 'timeSig': {
          // v11-metronome: null / undefined removes it (4/4); an unknown signature is refused
          if (value === null || value === undefined) return { segs, value: undefined };
          const v = validTimeSig(value);
          return v === undefined ? null : { segs, value: v };
        }
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
        // keyboards: device names may contain dots, so only the whole map is a path (store.setKeyboard)
        const whole = k === 'theme' || k === 'audioSleepSec' || k === 'hotkeys' || k === 'updateCheck'
          || k === 'keyboards' || k === 'click' || k === 'midiClockOut' || k === 'dynamicRange'
          || k === 'droneFreeze' || k === 'chartView' || k === 'programChangeChannel'
          || k === 'programChangeAction' || hasOwn(SOUND_2_CHOICES, k);
        return hasOwn(SETTINGS_VALIDATORS, k) || whole ? null : { segs, value: clone(value) };
      }
      // themes-setup: an unknown theme id is stored as the default (never an error, never a dead id)
      if (k === 'theme') return { segs, value: isThemeId(value) ? value : DEFAULT_THEME_ID };
      if (k === 'keyboards') {
        if (value === null || value === undefined) return { segs, value: undefined };
        if (!isObj(value)) return null;
        const kb = normalizeKeyboards(value);
        return { segs, value: Object.keys(kb).length ? kb : undefined }; // v11-touch: empty = absent
      }
      if (k === 'audioSleepSec') {
        const v = validAudioSleepSec(value); // lowres2: a number, rounded and clamped; anything else is refused
        return v === null ? null : { segs, value: v };
      }
      // v11-electron: settings.hotkeys is set whole (normalised: every action, canonical accelerators);
      // settings.updateCheck is a boolean
      if (k === 'hotkeys') {
        const v = normalizeHotkeys(value);
        return v === null ? null : { segs, value: v };
      }
      if (k === 'updateCheck') return typeof value === 'boolean' ? { segs, value } : null;
      if (k === 'chartView') { // Chart view (D7, hidden): true = on; false / null = absent (off)
        if (value === null || value === undefined || value === false) return { segs, value: undefined };
        return value === true ? { segs, value } : null;
      }
      if (k === 'droneFreeze') { // UIB (D5): a boolean; null = back to the default (absent = on)
        if (value === null || value === undefined) return { segs, value: undefined };
        return typeof value === 'boolean' ? { segs, value } : null;
      }
      // Lane S: a channel 0..15 / 'cue' | 'switch'; null = absent (any channel / the action programChangeOf reads)
      if (k === 'programChangeChannel') {
        if (value === null || value === undefined) return { segs, value: undefined };
        const v = validPcChannel(value);
        return v === undefined ? null : { segs, value: v };
      }
      if (k === 'programChangeAction') {
        if (value === null || value === undefined) return { segs, value: undefined };
        return PC_ACTIONS.includes(value) ? { segs, value } : null;
      }
      if (k === 'dynamicRange') {
        if (value === null || value === undefined) return { segs, value: undefined };
        const v = validDynRange(value); // a number, clamped to 1..3; 1 = absent (today's sound)
        return v === null ? null : { segs, value: v === 1 ? undefined : v };
      }
      // v11-metronome: settings.click is set whole (normalised; empty = absent); midiClockOut is a name or null (off)
      if (k === 'click') {
        if (value === null || value === undefined) return { segs, value: undefined };
        const c = normalizeClick(value);
        if (!c) return null;
        return { segs, value: Object.keys(c).length ? c : undefined };
      }
      if (k === 'midiClockOut') {
        if (value === null || value === undefined) return { segs, value: undefined };
        const v = validMidiClockOut(value);
        return v === undefined ? null : { segs, value: v };
      }
      // 2.0 Sound (D1, D2, D4): one of the listed choices (kept as set, the default included); null = back to the
      // default (absent); anything else is refused
      if (hasOwn(SOUND_2_CHOICES, k)) {
        if (value === null || value === undefined) return { segs, value: undefined };
        const v = validSound2(k, value);
        return v === undefined ? null : { segs, value: v };
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
      // UIA: a whole slots array sets the slot count too (1..MAX_SLOTS); when the count changes the whole patch is
      // written, so wheel targets past the new count go back to their default
      if (rest.length === 1) {
        if (!Array.isArray(value)) return null;
        const next = normalizePatch({ ...song.patch, slots: value });
        if (next.slots.length === song.patch.slots.length) return { segs, value: next.slots };
        return { segs: segs.slice(0, -1), value: next };
      }
      const i = Number(a);
      // UIA: only the song's own slots (addSlot / removeSlot change how many it has)
      if (!Number.isInteger(i) || i < 0 || i >= song.patch.slots.length || String(i) !== a) return null;
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
    const n = song.patch.slots.length; // UIA: the targets this song has (isWheelTarget)
    if (k === 'modWheel' || k === 'expression') {
      if (rest.length === 1) return { segs, value: normalizeWheel(value, defaultRouting()[k].target, n) };
      if (a === 'target') return isWheelTarget(value, n) ? { segs, value } : null;
      if (a === 'min' || a === 'max') return finite(value) ? { segs, value: num(value, 0, 1, 0) } : null;
      if (a === 'curve' && rest.length === 2) {
        // v11-touch: 'linear' is the default, so it is stored as absent
        if (value === null || value === undefined || value === 'linear') return { segs, value: undefined };
        return PEDAL_CURVES.includes(value) ? { segs, value } : null;
      }
      return { segs, value: clone(value) };
    }
    if (k === 'volume') {
      if (rest.length === 1) return isObj(value) && isWheelTarget(value.target, n) ? { segs, value: { ...value } } : null;
      if (a === 'target') return isWheelTarget(value, n) ? { segs, value } : null;
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
      if (a === 'pedal' && rest.length === 2) {
        // v11-touch: off is stored as absent
        if (value === null || value === undefined || value === false) return { segs, value: undefined };
        return value === true ? { segs, value } : null;
      }
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

  // ---- patch packs (O-AW-PP)
  const packRecords = () => (isObj(state.meta.packSongs) ? state.meta.packSongs : {});
  /**
   * A pack entry's song, normalised exactly as importJSON reads a song file: the entry's `schema` decides the slot
   * count (none = a 1.x song, 4 slots). @throws {FutureSchemaError} @returns {object|null}
   */
  function packSongOf(e, id) {
    const sch = typeof e.schema === 'number' ? { schema: e.schema } : {};
    const src = clone(e.song);
    if (typeof src.name !== 'string' && e.bank && typeof e.bank.title === 'string') src.name = e.bank.title;
    const lib = migrate({ ...sch, songs: [{ ...src, id: 'pack0' }] });
    const s = lib.songs[lib.songOrder[0]];
    return s ? normalizeSong({ ...s }, id) : null;
  }
  const skipLine = (e, why) => `${(e && typeof e.packId === 'string' && e.packId) || '(unknown pack song)'}: ${why}`;
  function tryPackSong(e, id, res) {
    try {
      const s = packSongOf(e, id);
      if (!s) res.skipped.push(skipLine(e, 'no song in it; skipped'));
      return s;
    } catch (err) {
      const why = err instanceof FutureSchemaError
        ? 'made by a newer version of Worship Rig; skipped'
        : 'not a Worship Rig song; skipped';
      res.skipped.push(skipLine(e, why));
      return null;
    }
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
     * D8/D9: things the user should be told, `{type, message, …}`: 'library-size' (a save past LIBRARY_MAX_CHARS,
     * D9), 'kept-removed' (storage was full and superseded kept copies were removed, D8). Notices from before the
     * first subscriber (load time) are delivered to it. The controller toasts `message`.
     * @param {(n:{type:string, message:string}) => void} fn @returns {() => void} unsubscribe
     */
    onNotice(fn) {
      noticeListeners.add(fn);
      for (const n of notices.splice(0)) {
        try {
          fn(n);
        } catch (err) {
          warn(`notice listener failed: ${err && err.message}`);
        }
      }
      return () => noticeListeners.delete(fn);
    },
    /**
     * D8: the previous libraries this browser profile keeps, newest first: kept copies (1.x text kept at an upgrade,
     * a 2.0 library set aside by 1.x or here, the library a restore replaced) and 1.1.1's separate 1.x library.
     * @returns {{key:string, kind:'migration'|'downgrade'|'restore'|'separate', savedAt:number|null, schema:number,
     *   version:string, songs:number, setlists:number, chars:number, restorable:boolean, error?:string}[]}
     *   (check:false skips the dry-run restore of each copy: restorable is then undefined)
     */
    keptLibraries({ check: dry = true } = {}) {
      const rows = keptEntries().map((e) => ({ ...e }));
      const sep = `${key}${SEPARATE_1X_SUFFIX}`;
      let sepText = null;
      try {
        sepText = storage.getItem(sep);
      } catch {
        /* ignore */
      }
      if (typeof sepText === 'string') {
        const schema = librarySchemaOf(sepText);
        if (schema !== null) rows.push({ key: sep, savedAt: null, kind: 'separate', schema });
      }
      const out = [];
      for (const r of rows) {
        let text = null;
        try {
          text = storage.getItem(r.key);
        } catch {
          /* ignore */
        }
        if (typeof text !== 'string') continue;
        let doc = null;
        try {
          doc = JSON.parse(text);
        } catch {
          doc = null;
        }
        const list = doc && doc.songs;
        const songs = Array.isArray(list) ? list.length : isObj(list) ? Object.keys(list).length : 0;
        const row = {
          key: r.key, kind: r.kind, savedAt: r.savedAt, schema: r.schema, version: versionOfSchema(r.schema), songs,
          setlists: doc && isObj(doc.setlists) ? Object.keys(doc.setlists).length : 0, chars: text.length,
        };
        if (dry) {
          const check = doc ? api.importJSON(doc, { replace: true, dryRun: true }) : { ok: false };
          row.restorable = check.ok === true;
          if (!check.ok) row.error = check.error || 'That copy cannot be read.';
        }
        out.push(row);
      }
      return out.sort((a, b) => (b.savedAt ?? Infinity) - (a.savedAt ?? Infinity) || a.key.localeCompare(b.key));
    },
    /**
     * D8: keep the current library as a kept copy ('restore': before a restore replaces it). Synchronous, so the copy
     * is the library exactly as it is replaced. `protect`: a kept key that making room must not remove (the copy the
     * restore brings back; D8 skeptic K1). @returns {{ok:true, key:string} | {ok:false, error:string}}
     */
    keepCurrent(kind = 'restore', { protect = null } = {}) {
      if (!KEPT_KINDS.includes(kind)) return { ok: false, error: 'unknown kind' };
      const k = keepRaw(JSON.stringify(state), kind, SCHEMA, now(), { protect });
      if (!k) return { ok: false, error: 'Browser storage is full, so the library could not be kept.' };
      return { ok: true, key: k };
    },
    /**
     * D8: replace the library with a kept copy (or 1.1.1's separate library). The copy itself stays kept. The caller
     * (controller.restorePreviousLibrary) keeps the current library first.
     * @returns {{ok:true, songIds:string[], setlistIds:string[]} | {ok:false, error:string}}
     */
    restoreKept(k, { dryRun = false } = {}) {
      const ok = typeof k === 'string' && (k === `${key}${SEPARATE_1X_SUFFIX}` || (k.startsWith(keptPrefix)
        && KEPT_RE.test(k.slice(keptPrefix.length))));
      if (!ok) return { ok: false, error: 'That is not a kept library.' };
      let text = null;
      try {
        text = storage.getItem(k);
      } catch {
        text = null;
      }
      if (typeof text !== 'string') return { ok: false, error: 'That library is no longer kept.' };
      return api.importJSON(text, { replace: true, dryRun });
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
      let parsed;
      try {
        parsed = JSON.parse(r);
        next = migrate(parsed);
      } catch (err) {
        warn(`reload: stored library unreadable (${err && err.message}); keeping the current one`);
        return false;
      }
      // D8 skeptic K3: a second window takes over after a 1.x window saved here; that 1.x library is kept too, as at
      // load (the upgrade below is saved over it). An untouched seed, or a text already kept, is not.
      if (isObj(parsed) && typeof parsed.schema === 'number' && parsed.schema < SCHEMA && isObj(parsed.songs)
        && Object.keys(parsed.songs).length && !(isObj(parsed.meta) && parsed.meta.edited === false)
        && !keptEntries().some((e) => storage.getItem(e.key) === r)) {
        keepRaw(r, 'migration', parsed.schema);
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
      // O-AW-3: Program Change turned on (off → on) with no action stored writes 'cue', so a new 2.0 user gets the
      // safe one; a 1.x library that already has PC on keeps an absent action (= 'switch', programChangeOf)
      const pcOn = v.segs.length === 2 && v.segs[0] === 'settings' && v.segs[1] === 'programChange'
        && v.value === true && !state.settings.programChange && !hasOwn(state.settings, 'programChangeAction');
      const prev = state;
      const paths = [put(v.segs, v.value)];
      if (pcOn) paths.push(put(['settings', 'programChangeAction'], PC_ACTION_DEFAULT));
      if (v.segs[0] === 'settings' && DEVICE_BLOCK_SETTINGS.includes(v.segs[1])) noteDeviceWrites(prev, state); // DS1
      changed(paths);
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
      if (paths.some((p) => p === 'settings' || p.startsWith('settings.'))) noteDeviceWrites(state, next); // DS1
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

    /**
     * UIA (native DECISIONS D3): append a slot to a song (at most MAX_SLOTS). `slot` = a Slot to put there (normalised
     * with that slot's role defaults, e.g. 'Sound 5'), or null / omitted for an empty slot. Nothing else in the song
     * changes; the new slot's index is the old count.
     * @param {string} [id] song id (default: the current song)
     * @param {object|null} [slot]
     * @returns {number} the new slot's index, or -1 (no such song, already MAX_SLOTS, a bad slot)
     */
    addSlot(id = state.settings.currentSongId, slot = null) {
      const s = state.songs[id];
      if (!s) return -1;
      const i = s.patch.slots.length;
      if (i >= MAX_SLOTS) return -1;
      const v = slot === null || slot === undefined ? null : normalizeSlot(slot, i);
      if (slot && !v) return -1;
      changed([put(['songs', id, 'patch', 'slots'], [...s.patch.slots, v])]);
      return i;
    },

    /**
     * UIA: remove slot `i` from a song (it keeps at least one). Later slots move down one place (their role names and
     * colours are positional: Bass after a removed Pad shows as the Pad); a wheel / pedal / knob target on the removed
     * slot goes back to the song's default target ('none' when that slot is gone too), targets on later slots follow
     * their slot, and every scene drops that slot's entry. MIDI-learn mappings are per position (settings) and stay.
     * @param {string} [id] song id (default: the current song)
     * @param {number} [i] slot index (default: the last slot)
     * @returns {boolean}
     */
    removeSlot(id = state.settings.currentSongId, i) {
      const s = state.songs[id];
      if (!s) return false;
      const n = s.patch.slots.length;
      const at = i === undefined ? n - 1 : i;
      if (n <= 1 || !Number.isInteger(at) || at < 0 || at >= n) return false;
      const next = clone(s);
      next.patch.slots.splice(at, 1);
      const shift = (t) => {
        const j = slotGainIndex(t);
        if (j === null || j < at) return t;
        return j === at ? undefined : `slots.${j - 1}.gain`; // undefined: normalizeWheel picks the default
      };
      for (const k of ['modWheel', 'expression', 'volume']) {
        if (isObj(next.patch[k])) next.patch[k].target = shift(next.patch[k].target);
      }
      if (Array.isArray(next.scenes)) {
        for (const sc of next.scenes) if (isObj(sc) && Array.isArray(sc.slots)) sc.slots.splice(at, 1);
      }
      changed([put(['songs', id], normalizeSong(next, id))]);
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

    /**
     * MIDI Learn mapping for a controlId (ids contain dots, so this is not a set() path). null clears. 2.x step 5
     * (O-AW-ML): a new mapping's id must be a fixed Learn row (params.isLearnable) or a continuous PARAMS path
     * (shared/learn.js isLearnablePath; then `{cc, channel, min?, max?, invert?}`); anything else is refused, so a
     * mapping on 'slots.0.mono' or a mistyped path is never stored. Clearing (null) takes any id.
     */
    setMidiLearn(controlId, mapping) {
      if (typeof controlId !== 'string' || isReservedKey(controlId)) return false;
      if (mapping && mapping.cc === 64) {
        warn('setMidiLearn: CC64 is the sustain pedal and cannot be mapped');
        return false;
      }
      if (mapping && !isLearnable(controlId) && !isLearnablePath(controlId)) {
        warn(`setMidiLearn: "${controlId}" is not a learnable control or a continuous parameter`);
        return false;
      }
      if (mapping && isLearnablePath(controlId) && !isLearnable(controlId) && !Number.isInteger(mapping.cc)) {
        warn(`setMidiLearn: "${controlId}" takes a CC (a knob, fader or pedal), not a note`);
        return false;
      }
      const next = { ...state.settings.midiLearn };
      if (mapping) next[controlId] = { ...mapping };
      else delete next[controlId];
      return api.set('settings.midiLearn', next);
    },

    /**
     * v11-touch: merge `fields` into one keyboard's entry of settings.keyboards (names contain dots, so this is not a
     * set() path). A field set to null is removed; `fields` null forgets the keyboard. An entry left empty is dropped.
     * @param {string} name  MIDI device name, or COMPUTER_KEYBOARD
     * @param {{touch?:object|null, remember?:boolean|null}|null} fields
     * @returns {boolean} changed
     */
    setKeyboard(name, fields) {
      if (typeof name !== 'string' || !name || name.length > KEYBOARD_NAME_MAX || isReservedKey(name)) return false;
      const next = { ...(state.settings.keyboards || {}) };
      if (fields === null) delete next[name];
      else if (isObj(fields)) {
        const e = { ...(next[name] || {}), ...fields };
        for (const k of Object.keys(e)) {
          if (e[k] === null || e[k] === undefined || (k === 'remember' && e[k] !== true)) delete e[k];
        }
        if (Object.keys(e).length) next[name] = e;
        else delete next[name];
      } else return false;
      return api.set('settings.keyboards', next);
    },

    /**
     * v11-metronome: merge fields into settings.click (null / undefined removes a field; an empty object = absent).
     * @param {{level?:number, countIn?:number, after?:string, record?:boolean, output?:string}} fields
     * @returns {boolean}
     */
    setClick(fields) {
      if (!isObj(fields)) return false;
      const next = { ...(state.settings.click || {}), ...fields };
      for (const k of Object.keys(next)) if (next[k] === null || next[k] === undefined) delete next[k];
      return api.set('settings.click', next);
    },

    /**
     * Chart view (D7): store, replace or remove (null) a song's chart, with the reason in words when it is refused
     * (empty, over CHART_MAX_CHARS, or a library that would no longer fit LIBRARY_MAX_CHARS).
     * @param {string} id song id
     * @param {{text:string, format?:string, key?:string, name?:string}|null} chart
     * @returns {{ok:true, changed:boolean} | {ok:false, error:string}}
     */
    setChart(id, chart) {
      if (!state.songs[id]) return { ok: false, error: 'That song is no longer in the library.' };
      if (chart === null || chart === undefined) return { ok: true, changed: api.set(`songs.${id}.chart`, null) };
      const err = chartError(chart);
      if (err) return { ok: false, error: err };
      const n = normalizeChart(chart);
      if (chartOverflows(id, n)) {
        return { ok: false, error: 'The library is full (about 2 MB), so the chart was not saved. Remove a chart or a '
          + 'song first.' };
      }
      return { ok: true, changed: api.set(`songs.${id}.chart`, n) };
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

    /**
     * Patch packs, auto mode (O-AW-PP): take the songs of GET /api/user-patches into the library. Idempotent.
     *  - A pack song is added once, at the end of the library order (no setlist), and remembered in meta.packSongs.
     *  - Deleted from the library → remembered, never added again. A pack folder that is gone changes nothing.
     *  - A newer version (entry hash ≠ the one written) replaces the song in place (same id, position, setlists)
     *    only while the song is unedited (its fingerprint still matches); an edited song is never overwritten. An
     *    edited song that already equals the new version (exported back into its pack) is re-recorded, not written
     *    (skeptic PP-2).
     *  - Bank-mode entries are never added here (addPackSong adds one on request); a bank song already in the
     *    library follows the same update / edit / delete rules.
     *  - A bad entry is skipped with a line in `skipped` (and a warning); a song that would push the library past
     *    LIBRARY_MAX_CHARS is skipped and tried again next time.
     * Pack writes are not edits: an untouched factory library stays pristine.
     * @param {object[]} list entries {packId, hash, mode, schema?, song, bank?}
     * @returns {{added:string[], updated:string[], kept:string[], skipped:string[], bank:number}} kept = pack ids
     *   whose newer version was not applied because the song was edited
     */
    topUpPacks(list) {
      const res = { added: [], updated: [], kept: [], skipped: [], bank: 0 };
      if (!Array.isArray(list) || !list.length || readOnlyReason !== null) return res;
      const recs = { ...packRecords() };
      const seen = new Set();
      const paths = [];
      const added = [];
      let relinked = false;
      let size = null;
      // skeptic PP-5: a new record (~packId + 70 chars) is library state too, so it counts against the cap
      const recLen = (packId, id) => packId.length + id.length + 64;
      const fits = (delta) => {
        if (size === null) size = JSON.stringify(state).length;
        if (size + delta > LIBRARY_MAX_CHARS) return false;
        size += delta;
        return true;
      };
      for (const e of list) {
        if (!validPackEntry(e)) {
          res.skipped.push(skipLine(e, 'not a pack song; skipped'));
          continue;
        }
        if (seen.has(e.packId) || isReservedKey(e.packId)) continue;
        seen.add(e.packId);
        const rec = hasOwn(recs, e.packId) && isObj(recs[e.packId]) ? recs[e.packId] : null;
        if (rec) {
          const cur = state.songs[rec.id];
          if (!cur || rec.hash === e.hash) continue; // deleted (remembered) or unchanged
          if (songFingerprint(cur) !== rec.sig) {
            // skeptic PP-2: edited here, but already equal to this pack version (the player exported the edited song
            // back into its pack file): adopt the version without writing the song, so later versions update again
            const next = tryPackSong(e, rec.id, { skipped: [] });
            if (next && songFingerprint(next) === songFingerprint(cur)) {
              recs[e.packId] = { id: rec.id, hash: e.hash, sig: songFingerprint(cur) };
              relinked = true;
              continue;
            }
            res.kept.push(e.packId); // edited here: never overwritten
            continue;
          }
          const song = tryPackSong(e, rec.id, res);
          if (!song) continue;
          if (!fits(JSON.stringify(song).length - JSON.stringify(cur).length)) {
            res.skipped.push(skipLine(e, 'the library is full; not updated'));
            continue;
          }
          paths.push(put(['songs', rec.id], song));
          recs[e.packId] = { id: rec.id, hash: e.hash, sig: songFingerprint(state.songs[rec.id]) };
          res.updated.push(rec.id);
          continue;
        }
        if (packModeOf(e) === 'bank') {
          res.bank += 1;
          continue;
        }
        const id = idGen('song');
        const song = tryPackSong(e, id, res);
        if (!song) continue;
        if (!fits(JSON.stringify(song).length + id.length + 8 + recLen(e.packId, id))) {
          res.skipped.push(skipLine(e, 'the library is full; not added'));
          continue;
        }
        paths.push(put(['songs', id], song));
        recs[e.packId] = { id, hash: e.hash, sig: songFingerprint(state.songs[id]) };
        added.push(id);
      }
      for (const line of res.skipped) warn(`patch pack: ${line}`);
      if (!paths.length && !relinked) return res;
      if (added.length) {
        paths.push(put(['songOrder'], [...state.songOrder, ...added]));
        if (!state.settings.currentSongId) paths.push(put(['settings', 'currentSongId'], added[0]));
      }
      paths.push(put(['meta', 'packSongs'], recs));
      changed(paths, { seed: true });
      res.added = added;
      return res;
    },
    /**
     * Song bank (O-AW-PP): add one pack song on request, at the end of the library order, with the same pack id
     * record as topUpPacks (so later versions update it in place while unedited). Already in the library → that
     * song, nothing added. A bank song deleted earlier may be added again: this is an explicit request.
     * @param {object} e a pack entry
     * @param {{select?:boolean}} [o] select: make it the current song
     * @returns {{ok:true, id:string, existing?:true} | {ok:false, error:string}}
     */
    addPackSong(e, { select = false } = {}) {
      if (!validPackEntry(e) || isReservedKey(e.packId)) return { ok: false, error: 'That is not a pack song.' };
      if (readOnlyReason !== null) return { ok: false, error: 'The library is read-only right now.' };
      const recs = { ...packRecords() };
      const rec = hasOwn(recs, e.packId) && isObj(recs[e.packId]) ? recs[e.packId] : null;
      if (rec && state.songs[rec.id]) return { ok: true, id: rec.id, existing: true };
      const res = { skipped: [] };
      const id = idGen('song');
      const song = tryPackSong(e, id, res);
      if (!song) return { ok: false, error: res.skipped[0] || 'That song could not be read.' };
      const grow = JSON.stringify(song).length + (rec ? 0 : e.packId.length + id.length + 64); // PP-5: the record
      if (JSON.stringify(state).length + grow > LIBRARY_MAX_CHARS) {
        return { ok: false, error: 'The library is full: delete some songs first.' };
      }
      const paths = [put(['songs', id], song), put(['songOrder'], [...state.songOrder, id])];
      recs[e.packId] = { id, hash: e.hash, sig: songFingerprint(state.songs[id]) };
      paths.push(put(['meta', 'packSongs'], recs));
      if (select || !state.settings.currentSongId) paths.push(put(['settings', 'currentSongId'], id));
      changed(paths);
      return { ok: true, id };
    },
    /**
     * Pack songs in the library now. @returns {Object<string,string>} pack id → library song id (deleted ones are
     * left out)
     */
    packSongs() {
      const out = {};
      for (const [k, r] of Object.entries(packRecords())) if (r && state.songs[r.id]) out[k] = r.id;
      return out;
    },
    /** @param {string} songId @returns {string|null} the pack id a library song came from */
    packIdOf(songId) {
      for (const [k, r] of Object.entries(packRecords())) if (r && r.id === songId && state.songs[songId]) return k;
      return null;
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
     * replacePristine (Lane E5): a whole-library file with songs replaces an untouched factory seed (`pristine`)
     *   instead of merging into it. Merging a 1.x export into a fresh 2.0 seed doubled every factory song, renamed
     *   its setlists "(imported)" and dropped its settings (MIDI Learn, Program Change, theme, …).
     * dryRun (Lane E5): every check, nothing changes (the controller checks a backup before it backs up / replaces).
     * The export envelope (`app`, `kind`, `exportedAt`, the backup's `origin` tag) is not library content and is not
     * kept in the state (E5: it was, so an export → re-import was never deep-equal).
     * @returns {{ok:true, songIds:string[], setlistIds:string[], replaced?:true} | {ok:false, error:string}}
     */
    importJSON(text, { replace = false, replacePristine = false, dryRun = false } = {}) {
      const tooBig = { ok: false, error: 'That file is too large to import: the library can hold about 2 MB of songs.' };
      // security S2: a pretty-printed export is ~2–3× its compact size; anything far beyond the cap isn't parsed.
      // D9: a replace may bring up to LIBRARY_RESTORE_MAX_CHARS (1.25×), so its text may be that much larger too.
      const textCap = 4 * (replace || replacePristine ? LIBRARY_RESTORE_MAX_CHARS : LIBRARY_MAX_CHARS);
      if (typeof text === 'string' && text.length > textCap) return tooBig;
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
      let wholeLibrary = false;
      let deviceBlock;
      try {
        if (Array.isArray(doc)) lib = migrate({ songs: doc.map((s, i) => ({ ...s, id: s?.id || `import${i}` })) });
        else if (isObj(doc) && (doc.kind === 'song' || (!doc.songs && isObj(doc.patch)))) {
          const s = doc.kind === 'song' ? doc.song : doc;
          if (!isObj(s)) return { ok: false, error: 'No song found in that file.' };
          if (typeof doc.schema === 'number' && doc.schema > SCHEMA) throw new FutureSchemaError(doc.schema);
          // UIA: a song file's schema decides its slot count (a 2.0 song keeps its 1..16 slots, a 1.x one its 4)
          const sch = typeof doc.schema === 'number' ? { schema: doc.schema } : {};
          lib = migrate({ ...sch, songs: [{ ...s, id: s.id || 'import0' }] });
        } else {
          // E5: any other JSON object (the iPad Files picker offers every .json) is not a library. migrate() makes
          // an empty library out of `{}`, so a replace import of a wrong file emptied the whole library.
          if (!isObj(doc) || !(isObj(doc.songs) || Array.isArray(doc.songs) || doc.kind === 'library')) return notOurs;
          // D11: 1.1.1's device block goes to the caller (applyDeviceSettings), never into the library state (migrate
          // drops it)
          if (hasOwn(doc, DEVICE_SETTINGS_KEY)) deviceBlock = doc[DEVICE_SETTINGS_KEY];
          lib = migrate(doc);
          wholeLibrary = true;
          // E5: the export envelope / backup origin tag (controller.libraryJSON) are not library state
          for (const k of IMPORT_ENVELOPE_KEYS) delete lib[k];
        }
      } catch (err) {
        if (err instanceof FutureSchemaError) return { ok: false, error: 'This file was made by a newer version of Worship Rig.' };
        return { ok: false, error: 'That file is not a Worship Rig library or song.' };
      }
      // E5: a whole library dropped onto an untouched factory seed replaces it (nothing of the user's is lost: the
      // seed is the factory songs, and device-local settings are kept), so its setlists and settings come along
      const asReplace = replace || (replacePristine && wholeLibrary && lib.songOrder.length > 0 && api.pristine);
      if (!lib.songOrder.length && !asReplace) return { ok: false, error: 'No songs found in that file.' };
      // security S2: the library after the import must still fit localStorage (unknown fields are kept, uncapped).
      // D9 (review E5 M3): a whole library replacing this one (a restore) may be up to 1.25× the cap, so a library
      // grown past the cap by edits can still restore its own backup; a merge or a song file still has to fit the cap.
      const after = JSON.stringify(lib).length + (asReplace ? 0 : JSON.stringify(state).length);
      if (after > (asReplace && wholeLibrary ? LIBRARY_RESTORE_MAX_CHARS : LIBRARY_MAX_CHARS)) return tooBig;
      if (asReplace) {
        const keep = Object.fromEntries(DEVICE_LOCAL_SETTINGS.map((k) => [k, state.settings[k]]));
        // an imported library is the user's data, whatever it says (round2-shell #2)
        const meta = { ...lib.meta, factorySeeded: true, edited: true };
        const next = migrate({ ...lib, settings: { ...lib.settings, ...keep }, meta });
        const res = { ok: true, songIds: next.songOrder.slice(), setlistIds: next.setlistOrder.slice() };
        if (!replace) res.replaced = true;
        if (deviceBlock !== undefined) res.deviceSettings = deviceBlock;
        if (dryRun) return res;
        generation += 1; // round2-shell #3: read by the controller's onStore (revert snapshot)
        commit(deepFreeze(next), diffPaths(state, next));
        return res;
      }
      const withBlock = (r) => (deviceBlock !== undefined ? { ...r, deviceSettings: deviceBlock } : r);
      if (dryRun) return withBlock({ ok: true, songIds: lib.songOrder.slice(), setlistIds: lib.setlistOrder.slice() });
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
      return withBlock({ ok: true, songIds, setlistIds });
    },

    /**
     * D11: fill in device-local settings from a 1.1.1 block. Every value is checked again (validDeviceSetting), and
     * only a setting that is still unset here is written (deviceSettingUnset): a setting changed on this machine is
     * never overwritten. `keyboards` merges per keyboard name (an existing entry wins). Device selections must
     * already have been checked by the caller (controller.applyDeviceSettings). Device-local writes are not edits,
     * so a pristine library stays pristine.
     * @param {object} values {key: value} (DEVICE_BLOCK_SETTINGS keys only)
     * @returns {{applied:string[], kept:string[], dropped:string[]}} kept = already set here; dropped = invalid
     */
    applyDeviceSettings(values) {
      const out = { applied: [], kept: [], dropped: [] };
      if (!isObj(values) || readOnlyReason !== null) return out;
      const paths = [];
      const cur = state.settings;
      const touched = touchedSet(); // DS1: changed here, also back to the default
      for (const [k, raw] of Object.entries(values)) {
        const v = isReservedKey(k) ? undefined : validDeviceSetting(k, raw);
        if (v === undefined) {
          out.dropped.push(k);
          continue;
        }
        if (k === 'keyboards') {
          const have = isObj(cur.keyboards) ? cur.keyboards : {};
          // DS1: a keyboard changed or deleted on this machine is never brought back or changed
          const add = Object.entries(v).filter(([name]) => !hasOwn(have, name) && !touched.has(touchedKeyboard(name)));
          const room = Math.max(0, KEYBOARDS_MAX - Object.keys(have).length);
          if (!add.length || !room) {
            out.kept.push(k);
            continue;
          }
          paths.push(put(['settings', 'keyboards'], { ...have, ...Object.fromEntries(add.slice(0, room)) }));
          out.applied.push(k);
          continue;
        }
        if (!deviceSettingUnset(cur, k, touched)) {
          out.kept.push(k);
          continue;
        }
        const def = hasOwn(DEFAULT_SETTINGS, k) ? DEFAULT_SETTINGS[k] : k === 'dynamicRange' ? 1 : undefined;
        if (v === null || deepEqual(v, def)) continue; // the default: nothing to bring
        paths.push(put(['settings', k], v));
        out.applied.push(k);
      }
      if (paths.length) changed(paths);
      return out;
    },
    /**
     * D11 skeptic DS1: the device-local settings changed on this machine (DEVICE_TOUCHED_KEY entries).
     * @returns {string[]}
     */
    deviceSettingsTouched() {
      return [...touchedSet()];
    },
    /**
     * D11: the machine markers that mean "this computer": this origin's own id (INSTALL_ID_KEY, which 1.1.1 Chrome
     * on the same origin wrote) and the ones remembered from same-machine imports. Never creates an id.
     * @returns {string[]}
     */
    machineMarkers() {
      const out = [];
      try {
        const own = storage.getItem(INSTALL_ID_KEY);
        if (validInstallId(own)) out.push(own);
        const known = JSON.parse(storage.getItem(KNOWN_INSTALLS_KEY) || '[]');
        if (Array.isArray(known)) for (const id of known) if (validInstallId(id) && !out.includes(id)) out.push(id);
      } catch {
        /* unreadable: no markers */
      }
      return out;
    },
    /**
     * D11: remember a block's marker as "this computer" (a same-machine import). Newest first, capped.
     * @param {string} id
     * @returns {boolean} stored
     */
    rememberMachineMarker(id) {
      if (!validInstallId(id)) return false;
      let known = [];
      try {
        const k = JSON.parse(storage.getItem(KNOWN_INSTALLS_KEY) || '[]');
        if (Array.isArray(k)) known = k.filter(validInstallId);
      } catch {
        known = [];
      }
      const next = [id, ...known.filter((x) => x !== id)].slice(0, KNOWN_INSTALLS_MAX);
      try {
        storage.setItem(KNOWN_INSTALLS_KEY, JSON.stringify(next));
        return true;
      } catch {
        return false;
      }
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
  // UIA skeptic: a schema-1 library whose copy was kept is saved back as schema 2 now. Left on disk as schema 1 until
  // the first edit, every launch made another copy and the third pruned older backups (BACKUPS_KEEP) of other kinds.
  else if (info.migrationBackupKey) schedulePersist();
  pending.clear(); // nobody is subscribed yet; the initial state is not a change
  return api;
}

/** SPEC §2 alias: `create({storage})`. */
export const create = createStore;
