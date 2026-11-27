// Worship Rig controller (SPEC §6, REVIEW 4.1, 2.1–2.4, 2.10, 1.16, 1.17).
// The ONLY place store and engine meet: song selection (prepare → commit, race-safe), store→engine diffing for the
// current song, perform-time input routing (MIDI + computer keyboard + on-screen), watchdog/restart, wake lock,
// Electron menu wiring and auto-backups. Views call store.set(...) for persisted state and controller.* for actions.
//
// Engine calls used (all feature-detected; a missing method warns once):
//   start, restart({latency, sinkId}), prepare(patch)→token, commit(token,{when}), preload(patches[]),
//   setParam(path, v), setTranspose(semis), setRouting({modWheel,expression,volume,bend,swell}), setTempo(bpm|null),
//   noteOn(note, vel 1..127[, {touch}]) (v11-touch: the keyboard's own curve),
//   noteOff(note), sustain(bool), pitchBend(-1..1), modWheel/expression/volumeCC(0..1),
//   setWheel('virtual', v), swell(bool), allNotesOff(), fadeOutAll(sec), setSinkId(id), setMono(bool),
//   drone.setKey(pc, {minor}), drone.configure(songDrone) (mode + options + params), drone.attachFiles([{name,url}]),
//   setKeyContext(pc, minor) (optional: chord spelling), ctx.{state,currentTime,resume}, latencyMs,
//   events 'statechange' | 'warn' | 'wheel' | 'notes' | 'chord' | 'loading' | 'ready' (re-emitted by the controller).
//   optional: getRuntimeState/applyRuntimeState (engine carries wheels across restart), listInstruments() (param
//   defaults when a param key is removed).
//
// Single instance (H2): start() takes the Web Lock 'rig-instance' ({ifAvailable:true}). If another window of this
// origin holds it, this one is a *secondary*: status.instance = 'secondary', status.instanceMessage is shown by the
// UI, the store is read-only, and neither the engine nor MIDI is started. When the other window closes, the lock is
// granted, the library is re-read from storage and this window starts normally (status.instance = 'primary').
// Restarts (M1): after ANY restart (restartAudio, watchdog, or the engine's own — statechange {restarted:true} or
// {reason:'restart'}) the controller re-sends wheel/expression/volume and the virtual wheel owner, re-sends the held
// pedal, re-attaches pad files (unless the engine kept them) and splits a running recording into a new file (warn).
// shell-3: preload pins ({pin:'replace'} for the setlist, {pin:'add'} for neighbours); a commit the engine refuses
// (restart during an in-flight prepare, engine-core #18) re-runs selectSong once; status.pedal (effective sustain,
// after pedalInvert); 'songSelected' {id, patchSnapshot, songSnapshot} + revertSong(); rescanUserSamples().
// morning-prep (integration-2 round 2 #3): memory policy for decoded samples. No setlist (or an empty one): only the
// current song and its library neighbours are pinned (≤ 3 songs), so the engine's LRU cap can evict the rest. A
// setlist is pinned whole unless its decoded size would pass PIN_BUDGET_MB; then only the current ±2 songs are pinned
// and the rest is warmed unpinned (status.memory.note).
// status.memory = {mode, decodedMB, pinnedMB, capMB, budgetMB, setMB, windowMB, pinnedSongs, note}.
// l8 (local soak L-8): the ±radius window is a byte budget too. Current song first, then neighbours by distance while
// the pinned total stays ≤ PIN_BUDGET_MB; one {pin:'replace'} per switch; a warn if pinnedMB ever passes capMB.
import {
  transposeSemisOf, audioSleepSecOf, COMPUTER_KEYBOARD, sound2Of, programChangeOf, DEVICE_LOCAL_SETTINGS, SCHEMA,
  readDeviceSettings, deviceSettingUnset, DEVICE_SELECTIONS, isTrialId,
} from './store.js';
import { compileTouch } from './shared/touch-curve.js';
import { transposeSemis, mod12, keyName } from './shared/music.js';
import {
  PARAMS, isValidPath, isLearnButton, isLearnable, parsePath, describe, SLOT_COUNT, MAX_SLOTS, slotGainIndex,
} from './shared/params.js';
import { isLearnablePath, ccToValue, valueToCc } from './shared/learn.js';
import { detectKeyFromName } from './shared/keydetect.js';
import { createBus, commandError } from './shared/bus.js';
import { clickSettingsOf } from './shared/click-math.js';
import { createMidiClock } from './midi-clock.js';
import { normalizeBank, packModeOf, validPackEntry } from './shared/patch-packs.js';
import {
  SCENE_MAX, SCENE_GLIDE_SEC, SCENE_STEP_SEC, scenesOf, applyScene, captureScene, levelsOf, levelDiff, stepScene,
  withScene, withoutScene, tweakScene, sceneNameOf, mergeScene, mixOf, fxSettingsOf, paramDiff, sceneHolds,
  absorbEdits, sceneFieldOf, keyShiftOf, keyShiftBetween,
} from './shared/scenes.js';

/** Menu-bar modes (docs/menubar-mode.md): the popover shows at most this many. */
export const MENU_BAR_MAX_MODES = 6;
/** Menu-bar modes when no menu-bar setlist is chosen: the first songs of the current setlist. */
export const MENU_BAR_FALLBACK_MODES = 3;

/** Settings.latency → engine latency option (REVIEW 4.8). */
export const LATENCY_MAP = Object.freeze({ lowest: 'interactive', balanced: 0.01, safe: 0.025 });
export const engineLatency = (settings) => LATENCY_MAP[settings && settings.latency] ?? 'interactive';

/** Computer keyboard (physical key codes) → semitone offset from C of the current octave (C4 at octave 0). */
export const KEY_MAP = Object.freeze({
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11,
  KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16,
});
/** Momentary learnable actions (note-on or CC ≥ 64). */
export const BUTTON_CONTROLS = Object.freeze(['nextSong', 'prevSong', 'panic', 'fadeOutAll', 'swell', 'nextScene',
  'prevScene', 'go', 'cueNext', 'cuePrev']);
/** Web Lock name for the single-instance guard (H2). */
export const INSTANCE_LOCK = 'rig-instance';
export const SECONDARY_MESSAGE = 'Another Worship Rig window is open — this one is read-only and muted. Close the other window to play here.';
/** Chrome: ping the local server so `serve.mjs` knows a window is open (don't open a second one). */
export const HEARTBEAT_MS = 15000;
const PAD_EXT_RE = /\.(mp3|wav|ogg|oga|m4a|aac|aif|aiff|flac|webm)$/i;
/**
 * Every non-dynamic slot param relative to the slot ('gain', 'sends.reverb', 'width', 'eq.low', …), from the PARAMS
 * table, so new strip params reach the engine without a controller change. [rel, segs, default]
 */
const SLOT_PARAMS = PARAMS.filter((e) => e.path.startsWith('slots.<i>.') && !e.dynamic).map((e) => {
  const rel = e.path.slice('slots.<i>.'.length);
  return [rel, rel.split('.'), e.default];
});
const getIn = (o, segs) => segs.reduce((v, k) => (v === null || v === undefined ? undefined : v[k]), o);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const DRONE_NUM = ['gain', 'brightness', 'movement', 'width', 'fade'];
const DRONE_OPTS = ['chordFollow', 'continueAcrossSongs', 'minorUsesRelativeMajorFile'];
const ROUTING_KEYS = ['modWheel', 'expression', 'volume', 'bend', 'swell'];
const KB_VELOCITY = 100;
const WHEEL_NUDGE = 0.1;

/**
 * Global velocity sensitivity (REVIEW 5.2). 1..127 in → 1..127 out.
 * @param {number} v
 * @param {'soft'|'normal'|'hard'|'fixed'} sens
 */
export function applyVelocitySens(v, sens = 'normal') {
  const x = Math.min(127, Math.max(1, Math.round(v))) / 127;
  let y;
  if (sens === 'fixed') return 100;
  if (sens === 'soft') y = Math.pow(x, 0.6); // light touch → louder
  else if (sens === 'hard') y = Math.pow(x, 1.6);
  else y = x;
  return Math.min(127, Math.max(1, Math.round(y * 127)));
}

const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Memory policy (morning-prep). A setlist whose samples decode to more than this is not pinned whole (the engine's
 * LRU cap is 700 MB; pinned buffers can't be evicted, integration-2 round 2 #3).
 */
export const PIN_BUDGET_MB = 600;
/**
 * Songs either side of the current one that may stay pinned: library browsing (≤ 3 songs) and a large setlist. A
 * count limit only: the window is also a byte budget (PIN_BUDGET_MB, L-8), so heavy neighbours are left out.
 */
export const LIBRARY_PIN_RADIUS = 1;
export const LARGE_SET_PIN_RADIUS = 2;
/** Unpinned warming of a large setlist stops at this share of the engine cache cap (it evicts down to 85 %). */
const WARM_SHARE_OF_CAP = 0.8;
export const LARGE_SET_NOTE = 'Large set: loading songs as you go';
/** status.memory.note when the current song alone passes PIN_BUDGET_MB (L-8): it is pinned alone. */
export const songAloneNote = (mb) => `This song alone is ${Math.round(mb)} MB`;
/** A learned CC button held at ≥ 64 fires again after this long (press-only footswitches; round4-controller C9). */
const CC_RETRIGGER_MS = 150;
/**
 * 2.x step 5 (O-AW-ML rule 5): a CC learned to a custom path writes the store at most once per this long (≈ a slider
 * drag's input rate); the last value of a burst is written when the window ends. The fixed 1.x rows are not throttled.
 */
export const LEARN_WRITE_MS = 20;
/** UI v6 U7c: the controlId midi.learn carries while learnCapture() waits (never stored: learn(id, {heard}) stores). */
export const LEARN_CAPTURE_ID = '(capture)';
/** Switch-type pedal CCs (sustain, sostenuto, soft): never a fader (= midi.js PEDAL_CCS, kept here for heardFor). */
const PEDAL_SWITCH_CCS = Object.freeze([64, 66, 67]);
/** L11-8: wait this long after low-resource turns on (release tails end) before the one GC. */
const LOWRES_GC_MS = 3000;
/** 'memory' event note when pinned samples pass the cache cap (round4-controller C5: plain copy, never toasted). */
export const OVER_CAP_NOTE = 'This set is using a lot of memory; songs load as you go.';
const routingOf = (song) => {
  const p = song.patch;
  return { modWheel: p.modWheel, expression: p.expression, volume: p.volume, bend: p.bend, swell: p.swell };
};

/** Value of a §4 path inside a Song (current-song addressing). */
export function songParam(song, path) {
  if (!song) return undefined;
  if (path === 'master.volume') return song.patch.fx.master.volume;
  const segs = path.split('.');
  if (segs[0] === 'drone') return song.drone[segs[1]];
  let o = song.patch;
  for (const s of segs) {
    if (o === null || o === undefined) return undefined;
    o = o[s];
  }
  return o;
}

/**
 * UIA: a sound appeared, went or changed in one of the first `n` slots (the slots the engine plays). A slot added or
 * removed past what the engine plays (slots 5..16 on the web engine) changes nothing it hears.
 */
function structuralChange(pa, pb, n = SLOT_COUNT) {
  const len = Math.min(n, Math.max(pa.slots.length, pb.slots.length));
  for (let i = 0; i < len; i++) {
    const a = pa.slots[i];
    const b = pb.slots[i];
    if (!a !== !b) return true;
    if (a && b && (a.instrument.type !== b.instrument.type || a.instrument.id !== b.instrument.id)) return true;
  }
  return false;
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'number', 'password', 'tel', 'url', 'range', 'date', 'time', 'color', 'month', 'week', 'datetime-local', '']);
function isTextControl(el) {
  if (!el || !el.tagName) return false;
  const tag = String(el.tagName).toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has(String(el.type || '').toLowerCase());
  return !!el.isContentEditable;
}
function isButtonish(el) {
  if (!el || !el.tagName) return false;
  const tag = String(el.tagName).toUpperCase();
  if (tag === 'BUTTON' || tag === 'SUMMARY') return true;
  if (tag === 'INPUT') return ['button', 'submit', 'reset', 'checkbox', 'radio'].includes(String(el.type || '').toLowerCase());
  return typeof el.getAttribute === 'function' && el.getAttribute('role') === 'button';
}

/**
 * @param {object} o
 * @param {ReturnType<import('./store.js').createStore>} o.store
 * @param {object} o.engine  AudioEngine (SPEC §3) or a fake
 * @param {import('./midi.js').MidiInput|null} [o.midi]
 * @param {import('./recorder.js').Recorder|null} [o.recorder]
 * @param {Document|EventTarget|null} [o.doc]
 * @param {Navigator|null} [o.nav]
 * @param {Window|EventTarget|null} [o.win]
 * @param {object|null} [o.rig]  window.rig (Electron)
 * @param {{setTimeout,clearTimeout,setInterval,clearInterval}} [o.timers]
 * @param {() => number} [o.now]
 * @param {number} [o.watchdogMs=1000]
 * @param {boolean} [o.autoRestart=true]
 * @param {number} [o.backupIntervalMs=600000]
 * @param {LockManager|null} [o.locks]  navigator.locks (default); null disables the single-instance guard
 * @param {boolean} [o.heartbeat]  ping /api/heartbeat (default: Chrome on http://127.0.0.1 only)
 * @param {IDBFactory|null} [o.indexedDB]  for the Chrome pad-folder auto-restore
 * @param {number} [o.midiInitTimeoutMs=5000]  L-3: after this long without an answer from requestMIDIAccess,
 *   status.midi says {available:false, reason:'pending', pending:true}; the request keeps going and a late answer
 *   still wires the inputs up. start() never waits for MIDI.
 */
export function createController(o) {
  const { store, engine } = o;
  const midi = o.midi || null;
  const recorder = o.recorder || null;
  const doc = o.doc !== undefined ? o.doc : globalThis.document || null;
  const nav = o.nav !== undefined ? o.nav : globalThis.navigator || null;
  const win = o.win !== undefined ? o.win : typeof globalThis.addEventListener === 'function' && globalThis.document ? globalThis : null;
  const rig = o.rig !== undefined ? o.rig : globalThis.rig || null;
  const isElectron = !!(rig && rig.isElectron);
  // L11-8: low-resource drops the decoded buffers, but on macOS the renderer only gives that memory back after a V8
  // GC, and an idle hidden page may go minutes without one (Mac: 1057 MB for 5 min → 392 MB after a GC). Electron
  // exposes gc (main.js --expose-gc); Chrome doesn't, so this is a no-op there.
  const gcNow = o.gc !== undefined ? o.gc : typeof globalThis.gc === 'function' ? () => globalThis.gc() : null;
  const timers = o.timers || {
    setTimeout: (...a) => globalThis.setTimeout(...a),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    setInterval: (...a) => globalThis.setInterval(...a),
    clearInterval: (id) => globalThis.clearInterval(id),
  };
  const now = o.now || (() => Date.now());
  const watchdogMs = o.watchdogMs ?? 1000;
  const autoRestart = o.autoRestart !== false;
  const backupIntervalMs = o.backupIntervalMs ?? 10 * 60 * 1000;
  const locks = o.locks !== undefined ? o.locks : (nav && nav.locks) || null;
  const loc = globalThis.location || null;
  const heartbeatOn = o.heartbeat !== undefined ? !!o.heartbeat : !isElectron && !!loc && loc.protocol === 'http:' && typeof globalThis.fetch === 'function';
  const idbFactory = o.indexedDB !== undefined ? o.indexedDB : globalThis.indexedDB || null;
  const midiInitTimeoutMs = o.midiInitTimeoutMs ?? 5000;
  let secondary = false; // H2: another window holds the instance lock

  const api = new EventTarget();
  const emit = (type, detail) => api.dispatchEvent(new CustomEvent(type, { detail }));
  const warned = new Set();
  const warn = (msg, once = false) => {
    if (once) {
      if (warned.has(msg)) return;
      warned.add(msg);
    }
    console.warn(`[controller] ${msg}`);
    emit('warn', { message: msg });
  };

  // ---- safe engine calls
  /**
   * UIA (native DECISIONS D3): how many slots the engine plays. The bridge engine (2.0 core) takes MAX_SLOTS; the web
   * engine (app/js/engine, the 1.x oracle) stays at SLOT_COUNT, so slots 5..16 are stored and shown but never sent
   * to it (enginePatch / call()'s setParam guard). An engine may say its own number (`maxSlots`).
   * @returns {number}
   */
  function engineSlots() {
    if (!engine) return SLOT_COUNT;
    if (Number.isInteger(engine.maxSlots)) return Math.min(MAX_SLOTS, Math.max(SLOT_COUNT, engine.maxSlots));
    const native = ['setPolyphony', 'setVoiceLimit', 'setBufferFrames'].every((k) => typeof engine[k] === 'function');
    return native ? MAX_SLOTS : SLOT_COUNT;
  }
  /** UIA: true for a slot address past what the engine plays ('slots.5.gain' on the web engine). */
  function pastEngine(path) {
    const m = /^slots\.(\d+)\./.exec(typeof path === 'string' ? path : '');
    return !!m && Number(m[1]) >= engineSlots();
  }
  /**
   * UIA: the patch as the engine gets it: its first engineSlots() slots, and a wheel / pedal / knob target on a slot
   * it does not play becomes 'none'. A song the engine plays whole is passed through as it is.
   */
  function enginePatch(patch) {
    const n = engineSlots();
    if (!patch || !Array.isArray(patch.slots) || patch.slots.length <= n) return patch;
    const out = { ...patch, slots: patch.slots.slice(0, n) };
    for (const k of ['modWheel', 'expression', 'volume']) {
      const t = patch[k] && patch[k].target;
      if (slotGainIndex(t) !== null && slotGainIndex(t, n) === null) out[k] = { ...patch[k], target: 'none' };
    }
    return out;
  }

  // D26.1: the controller's glide of the sends / Space / Echo levels (glideMix, in the scenes section); here because
  // call() reads it
  const mixGlides = new Map(); // path → {from, to, v, k, t0}
  let mixStepping = false;
  function call(name, ...args) {
    if (secondary) return undefined; // muted second window
    if (name === 'setParam' && pastEngine(args[0])) return false; // UIA: never route slots >= 4 to the web engine
    if (name === 'setParam' && !mixStepping && mixGlides.size) mixGlides.delete(args[0]); // D26.1: a later write wins
    const fn = engine && engine[name];
    if (typeof fn !== 'function') {
      warn(`engine.${name}() not available`, true);
      return undefined;
    }
    try {
      return fn.apply(engine, args);
    } catch (err) {
      warn(`engine.${name} failed: ${err && err.message}`);
      return undefined;
    }
  }
  function droneCall(name, ...args) {
    if (secondary) return undefined;
    const d = engine && engine.drone;
    if (!d || typeof d[name] !== 'function') {
      warn(`engine.drone.${name}() not available`, true);
      return undefined;
    }
    try {
      return d[name](...args);
    } catch (err) {
      warn(`engine.drone.${name} failed: ${err && err.message}`);
      return undefined;
    }
  }

  // ---- status
  const status = {
    audio: 'running',
    latencyMs: 0,
    // pending (L-3): requestMIDIAccess has not answered within midiInitTimeoutMs (reason is then 'pending' too)
    midi: {
      available: false, connected: false, name: null, reason: null, pending: false, inputs: [], hint: null,
      fallback: false, standIn: false,
    },
    loading: false,
    ready: false,
    recording: false,
    songId: null,
    // Lane S (D6): cue = the entry GO plays ({id, index}); go = a GO under way ({id, index, waiting}: waiting = for
    // its samples, before the switch starts). Both null when idle.
    cue: null,
    go: null,
    wakeLock: false,
    pedal: false, // effective sustain (MIDI CC64 after pedalInvert, Space, on-screen) for the UI indicator
    instance: 'primary', // 'primary' | 'secondary' (H2)
    instanceMessage: null,
    library: { readOnly: false, readOnlyReason: null, persistError: null }, // store.loadInfo summary (H1/M7)
    otherLibrary: null, // Electron: {origin, savedAt, path} of a newer library backup from another port (M5)
    // morning-prep: 'library' | 'setlist' | 'large-set' (null before the first preload); MB values from
    // engine._debugStats() (null when the engine has none); setMB = decoded size of the whole setlist (estimate)
    memory: { mode: null, decodedMB: null, pinnedMB: null, capMB: null, setMB: null, note: null },
    lowResource: false, // menubar-A: effective low-resource mode (settings.lowResource, or auto while hidden)
    windowVisible: true, // menubar-A: main window shown (setWindowVisible() override, else document visibility)
    popoverOpen: false, // lowres2-critic R2: menu ids popoverShown / popoverHidden (never ends low-resource)
    // v11-metronome: on = the click transport runs (counting = still in the count-in); available = the current song
    // has a tempo; output = the routing in effect ('main' | 'aux'); midiClock = the chosen output name (null = off)
    click: { on: false, counting: false, available: false, output: 'main', midiClock: null, midiClockConnected: false },
    // 2.0 Sound (native DECISIONS D1, D2, D4): native = the engine takes voices / buffer / voice limit (the bridge
    // engine); the rest is what it reported (bufferFrames = granted, voiceLimitEffective = Auto's number, 0 = off;
    // null = not reported). The web engine leaves native false: the settings are stored only.
    // UIB (Settings review item 4): sampleRate = the engine's rate, so Settings shows ms per buffer without engine.ctx
    audioConfig: { native: false, polyphony: null, bufferFrames: null, bufferRequested: null, voiceLimit: null,
      voiceLimitEffective: null, sampleRate: null },
  };
  function setStatus(patch) {
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (!same(status[k], v)) {
        status[k] = v;
        changed = true;
      }
    }
    if (changed) emit('status', { ...status });
  }

  // ---- song application
  let applied = null; // Song snapshot the engine currently reflects
  let appliedId = null;
  let targetId = null; // most recently requested song
  let seq = 0; // latest prepare wins
  let lastDroneKey = null;
  let appliedIndex = -1; // nav position of the applied song at commit (M4)

  function applySongLevel(song, prev, force, { drone = true } = {}) {
    const semis = transposeSemisOf(song);
    if (force || !prev || semis !== transposeSemisOf(prev)) call('setTranspose', semis);
    const r = routingOf({ patch: enginePatch(song.patch) }); // UIA: a target past the engine's slots = 'none'
    if (force || !prev || !same(r, routingOf({ patch: enginePatch(prev.patch) }))) call('setRouting', r);
    if (drone) applyDrone(song, prev, force);
    if (force || !prev || song.tempo !== prev.tempo) call('setTempo', song.tempo ?? null);
    // v11-metronome: the time signature; a new song starts a new bar on the click's next free beat (never delays the
    // switch: the click is its own transport)
    const newSong = !!prev && prev.id !== song.id;
    if (force || !prev || newSong || song.timeSig !== prev.timeSig) {
      optional('setTimeSig', song.timeSig || '4/4', { newBar: newSong || (!!prev && song.timeSig !== prev.timeSig) });
    }
    const avail = Number(song.tempo) > 0;
    if (status.click.available !== avail) setClickStatus({ available: avail });
  }

  function optional(name, ...args) {
    if (secondary) return undefined;
    const fn = engine && engine[name];
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(engine, args);
    } catch (err) {
      warn(`engine.${name} failed: ${err && err.message}`);
      return undefined;
    }
  }

  function applyDrone(song, prev, force) {
    const d = song.drone;
    const pd = prev && prev.drone;
    const key = { pc: song.hearIn, minor: !!song.minor };
    if (force || !lastDroneKey || lastDroneKey.pc !== key.pc || lastDroneKey.minor !== key.minor) {
      optional('setKeyContext', key.pc, key.minor);
      if (!lastDroneKey || lastDroneKey.pc !== key.pc || lastDroneKey.minor !== key.minor) {
        droneCall('setKey', key.pc, { minor: key.minor }); // key first, so a mode change starts in the right key
        lastDroneKey = key;
      }
    }
    if (force || !pd || d.mode !== pd.mode || DRONE_OPTS.some((k) => d[k] !== pd[k])) {
      droneCall('configure', { ...d }); // mode + options + params in one go (same mode → no restart)
    } else {
      for (const k of DRONE_NUM) if (d[k] !== pd[k]) call('setParam', `drone.${k}`, d[k]);
    }
  }

  /** Param-level diff of the current song (no structural change). */
  function applyParamDiff(prev, next) {
    // UIA: the slots the engine plays (slots both songs have; a count change past them is no structural change)
    const n = Math.min(engineSlots(), prev.patch.slots.length, next.patch.slots.length);
    for (let i = 0; i < n; i++) {
      const a = prev.patch.slots[i];
      const b = next.patch.slots[i];
      if (!a || !b || a === b) continue;
      for (const [rel, segs, def] of SLOT_PARAMS) {
        const va = getIn(a, segs);
        const vb = getIn(b, segs);
        if (va !== vb) call('setParam', `slots.${i}.${rel}`, vb === undefined ? def : vb); // removed → table default
      }
      for (const k of Object.keys(b.params)) if (a.params[k] !== b.params[k]) call('setParam', `slots.${i}.params.${k}`, b.params[k]);
      const removed = Object.keys(a.params).filter((k) => !(k in b.params));
      if (removed.length && !resetParams(i, b, removed)) return false; // no defaults known → re-prepare
    }
    const fa = prev.patch.fx;
    const fb = next.patch.fx;
    if (fa !== fb) {
      for (const unit of Object.keys(fb)) {
        if (!fb[unit] || typeof fb[unit] !== 'object' || fa[unit] === fb[unit]) continue;
        for (const k of Object.keys(fb[unit])) {
          const path = unit === 'master' ? `master.${k}` : `fx.${unit}.${k}`;
          if (isValidPath(path) && (!fa[unit] || fa[unit][k] !== fb[unit][k])) call('setParam', path, fb[unit][k]);
        }
      }
    }
  }

  /** A param key was removed from a slot: send the instrument's default (ui-edit #1). @returns {boolean} */
  function resetParams(i, slot, keys) {
    let defs = null;
    try {
      const list = engine && typeof engine.listInstruments === 'function' ? engine.listInstruments() : null;
      const e = Array.isArray(list) ? list.find((x) => x && x.ref && x.ref.type === slot.instrument.type && x.ref.id === slot.instrument.id) : null;
      defs = e && Array.isArray(e.params) ? e.params : null;
    } catch {
      defs = null;
    }
    if (!defs) return false;
    for (const k of keys) {
      const d = defs.find((x) => x && x.key === k);
      if (d && d.default !== undefined && d.default !== null) call('setParam', `slots.${i}.params.${k}`, d.default);
    }
    return true;
  }

  function applyDiff(prev, next) {
    if (!prev || !next || prev === next) return;
    // D23: a slot re-order moved the scene's live moves to the new layout; `prev` still plays them where they were
    const before = liveBefore && liveBefore.song === prev ? liveBefore.live : null;
    liveBefore = null;
    const order = slotOrder && slotOrder.song === prev ? slotOrder.order : null;
    slotOrder = null;
    const a = before || live(prev); // v11-scenes: diff what the engine plays (the playing scene on top of the song)
    // D26.1: an edit of the song's own sends / Space / Echo / drone mode or key under a scene that holds that field
    // (a view, the bus or an import wrote the store) goes on top of the scene like a live move, so it is heard
    const sc = prev.id === next.id ? sceneFor(next) : null;
    if (sc) {
      const tweak = absorbEdits(sceneState.tweak, sc, prev, next, order);
      if (tweak !== sceneState.tweak) sceneState = { ...sceneState, tweak };
    }
    if (structuralChange(prev.patch, next.patch, engineSlots())) {
      reprepare(next.id);
      return;
    }
    const b = live(next);
    if (applyParamDiff(a, b) === false) {
      reprepare(next.id, true);
      return;
    }
    applySongLevel(b, a, false);
    applied = next;
  }

  async function preparePatch(song) {
    const r = call('prepare', enginePatch(song.patch)); // UIA: the web engine gets the first 4 slots
    return r && typeof r.then === 'function' ? await r : r;
  }

  /** Re-prepare the current song's whole patch after an instrument change (gapless commit). */
  let repreparing = null; // id with a pending re-prepare (later edits are caught up after it commits)
  async function reprepare(id, force = false, retried = false) {
    if (repreparing === id && !force) return false;
    const song = store.getSong(id);
    if (!song) return false;
    const my = ++seq;
    repreparing = id;
    setStatus({ loading: true });
    let token;
    const sent = live(song); // v11-scenes: a new instrument mid-scene keeps the scene's levels
    try {
      token = await preparePatch(sent);
    } catch (err) {
      if (my === seq) {
        repreparing = null;
        warn(`could not load the new instrument: ${err && err.message}`);
        setStatus({ loading: false });
      }
      return false;
    }
    if (my !== seq) return false;
    repreparing = null;
    if (call('commit', token, {}) === false) {
      // engine-core #18: a restart during the prepare invalidated the token — prepare again (once)
      if (!retried) return reprepare(id, true, true);
      warn('The audio engine refused the new sound; press the song again to reload it.');
      setStatus({ loading: false });
      return false;
    }
    const prev = applied;
    applied = song;
    appliedId = id;
    // v11-review-fixes R-2: the commit set the slots to the levels captured before the load. A scene step or a live
    // move inside the scene made while it loaded went to the old channels (scenes stay allowed meanwhile), and the
    // playing scene is controller state that catchUp can't see: glide the slots to what that scene plays now.
    const heard = live(song);
    mixGlides.clear(); // D26.1: the new channels start at `sent`; a glide still on its way would step back from there
    for (const [path, v] of levelDiff(levelsOf(sent), levelsOf(heard))) {
      if (path.startsWith('slots.')) call('setParam', path, v, { glide: SCENE_GLIDE_SEC }); // (the drone isn't reset)
    }
    // D26.1: the sends and the Space / Echo of a scene step made meanwhile, the same way
    for (const [path, v] of paramDiff(fxSettingsOf(sent), fxSettingsOf(heard))) call('setParam', path, v);
    glideMix(mixOf(sent), mixOf(heard));
    applySongLevel(heard, live(prev), false);
    catchUp(song);
    setStatus({ loading: false });
    return true;
  }

  function catchUp(snapshot) {
    const cur = store.getSong(snapshot.id);
    if (cur && cur !== snapshot && store.get().settings.currentSongId === snapshot.id) applyDiff(snapshot, cur);
  }

  /**
   * Select a song: prepare → commit → transpose → routing → drone → tempo → preload neighbours.
   * Double-tap safe: only the latest request commits; the old song keeps playing meanwhile.
   * @param {string} id
   * @param {{index?:number, when?:number}} [opts]
   * @returns {Promise<boolean>} true when this request was committed
   */
  function selectSong(id, opts = {}) {
    dropPendingGo(); // Lane S: a direct switch (Edit row, store, start-up) wins over a GO still waiting for its song
    return trackSelect(id, opts);
  }
  /** selectSong without dropping a waiting GO (go()'s own switch); remembers the request for goTo()'s dedupe. */
  function trackSelect(id, opts = {}, dir = 0) {
    const p = applySong(id, opts);
    const mine = { id, index: opts.index, promise: p, dir };
    inflight = mine;
    const done = () => {
      if (inflight === mine) inflight = null;
    };
    p.then(done, done);
    return p;
  }
  async function applySong(id, opts = {}) {
    const retried = !!opts._retried;
    const song = store.getSong(id);
    if (!song) {
      warn(`selectSong: unknown song ${id}`);
      return false;
    }
    const my = ++seq;
    targetId = id;
    repreparing = null;
    winSeq++; // round4-controller C3: an older window (e.g. its phase-2 re-plan) must not re-plan while this one loads
    store.selectSongId(id, opts.index);
    setStatus({ loading: true, songId: id });
    emit('song-loading', { id });
    let token;
    try {
      token = await preparePatch(song);
    } catch (err) {
      if (my === seq) {
        warn(`could not load "${song.name}": ${err && err.message}`);
        setStatus({ loading: false, songId: appliedId });
        if (appliedId && store.getSong(appliedId)) {
          targetId = appliedId;
          store.selectSongId(appliedId, appliedIndex); // back to the exact setlist entry (reprise-safe)
        }
      }
      return false;
    }
    if (my !== seq) return false; // superseded by a newer request
    const snapshot = store.getSong(id) ? song : null;
    if (!snapshot) return false;
    if (call('commit', token, opts.when !== undefined ? { when: opts.when } : {}) === false) {
      // engine-core #18: the engine refused the commit (e.g. restart() re-applied its state during our prepare, so our
      // token is stale). Prepare again, once; otherwise go back to what the engine is playing.
      if (!retried) return applySong(id, { ...opts, _retried: true });
      warn(`could not switch to "${song.name}": the audio engine refused the change`);
      // round2-shell #10: with nothing applied yet the store keeps this song selected, so status follows it
      setStatus({ loading: false, songId: appliedId || id });
      if (appliedId && appliedId !== id && store.getSong(appliedId)) {
        targetId = appliedId;
        store.selectSongId(appliedId, appliedIndex);
      }
      return false;
    }
    const prev = applied;
    applied = song;
    appliedId = id;
    appliedIndex = store.currentIndex();
    pickups.clear();
    dropLearnWrites();
    sceneState = { id, n: null, baseWheel: null, tweak: null }; // v11-scenes: every song starts on its own levels
    mixGlides.clear(); // D26.1: the committed song set every send / return
    slotOrder = null;
    applySongLevel(song, prev, true);
    catchUp(song);
    setStatus({ loading: false, songId: id });
    // round2-shell #4: snapshot the song as committed (catchUp just sent edits made while it loaded), not as requested
    const committed = store.getSong(id) || song;
    // U7a: Back from a Song bank trial brings the song's own Revert snapshot back (taken when it was first selected)
    const base = opts._baseline && opts._baseline.id === id ? opts._baseline.song : committed;
    selected = { id, song: base };
    trialCommitted(id);
    // Lane S: the cue is spent once its entry plays (a cue on another song stays: GO is still to come)
    if (cue && sameEntry(cue, id, appliedIndex)) cue = null;
    publishCue();
    emit('song', { id });
    emitActivity('song'); // idle-cpu-ui: the new song's drone may start sounding now
    emit('songSelected', { id, patchSnapshot: clone(base.patch), songSnapshot: clone(base) });
    preloadNeighbors();
    return true;
  }

  /** The song as it was when last selected (store songs are immutable, so the reference is the snapshot). */
  let selected = null;
  let seenGeneration = store.generation;
  /**
   * Undo every edit to the current song since it was selected: patch, drone, tempo and key fields go back to the
   * snapshot ('songSelected' patchSnapshot/songSnapshot); name, notes and category are kept.
   * @returns {boolean} true when something changed
   */
  function revertSong() {
    if (!selected || !store.getSong(selected.id)) return false;
    const snap = selected.song;
    const id = selected.id;
    let changed = false;
    for (const k of ['patch', 'drone', 'tempo', 'playIn', 'hearIn', 'transposeOctave', 'minor']) {
      if (snap[k] === undefined) continue;
      if (store.set(`songs.${id}.${k}`, clone(snap[k]))) changed = true;
    }
    // v11-metronome: timeSig is optional, so "absent in the snapshot" means 4/4 again (remove it)
    const cur = store.getSong(id);
    if (cur && cur.timeSig !== snap.timeSig && store.set(`songs.${id}.timeSig`, snap.timeSig ?? null)) changed = true;
    if (sceneState.n !== null && sceneState.id === id) goScene(null); // v11-scenes: back to the song's own levels
    if (changed) emit('action', { type: 'revertSong', id });
    return changed;
  }

  // ---- v11-scenes: saved level/wheel states on top of the song (shared/scenes.js). Which one plays is transient.
  // n: index into song.scenes (null = the song's own levels); tweak: live level moves on top of the playing scene
  // (shared/scenes.js tweakScene), dropped at the next scene change; baseWheel: the wheel when the own levels were left
  let sceneState = { id: null, n: null, baseWheel: null, tweak: null };
  /** The playing scene of this song (null = its own levels). */
  const sceneFor = (song) => (song && sceneState.n !== null && sceneState.id === song.id
    ? scenesOf(song)[sceneState.n] || null : null);
  /** The song as the engine plays it: the playing scene and its live moves on top (D26.1: merged, then applied). */
  const live = (song) => {
    const sc = sceneFor(song);
    return sc ? applyScene(song, mergeScene(sc, sceneState.tweak)) : song;
  };
  const wheelNow = () => {
    const w = optional('wheelValues');
    return w && Number.isFinite(w.mod) ? w.mod : wheelState.mod;
  };
  const sceneInfo = () => {
    const song = appliedId ? store.getSong(appliedId) : null;
    const count = scenesOf(song).length;
    const n = song && sceneState.id === song.id && sceneState.n !== null && sceneState.n < count ? sceneState.n : null;
    return { id: song ? song.id : null, n, count };
  };
  /**
   * D23: the store re-ordered song `id`'s slots (insertSlot / moveSlot / removeSlot, or a Revert bringing an earlier
   * order back). The song's scenes moved with the instruments in the same write; the transient live moves on top of
   * the playing scene (sceneState.tweak) are controller state, so they move here, with each instrument. `applied`
   * still plays the old layout until the store notification's applyDiff: what it plays is kept in `liveBefore`.
   * MIDI pickups and pending learned writes are positional (D23 / O-AW-ML rule 2) and stay.
   * @param {{id:string, order:number[]}} e  order[j] = old index of new slot j (-1 = new)
   */
  function onSlotMap({ id, order }) {
    if (!applied || appliedId !== id) return;
    // D26.1: applyDiff pairs each instrument's own sends before / after the re-order (absorbEdits); two re-orders
    // before one store notification compose
    const was = slotOrder && slotOrder.song === applied ? slotOrder.order : null;
    slotOrder = { song: applied, order: was ? order.map((k) => (k >= 0 ? was[k] ?? -1 : -1)) : order.slice() };
    if (sceneState.id !== id || !sceneState.tweak) return;
    if (!liveBefore || liveBefore.song !== applied) liveBefore = { song: applied, live: live(applied) };
    const t = sceneState.tweak;
    const slots = order.map((k) => (k >= 0 && Array.isArray(t.slots) ? t.slots[k] ?? null : null));
    sceneState = { ...sceneState, tweak: { ...t, slots } };
  }
  let liveBefore = null; // {song: applied, live: what it played before a slot re-order} (onSlotMap → applyDiff)
  let slotOrder = null; // D26.1: {song: applied, order} of a slot re-order not diffed yet (onSlotMap → applyDiff)

  // ---- D26.1: the sends and Space / Echo levels glide in SCENE_STEP_SEC steps. The engines glide only slot / drone
  // levels (ENGINE_CONTRACT setParam `glide`); every other row has its τ 15 ms smoothing, so plain setParam writes at
  // each step make the glide (as the web engine's virtual-wheel glide). A step's value follows the clock too
  // (o.now), so a throttled timer only makes fewer, bigger steps and the glide still ends on time. Any other write of
  // a path (a fader, a learned knob, the next diff) ends its glide (call()); a song switch ends them all.
  const SCENE_STEPS = Math.max(1, Math.round(SCENE_GLIDE_SEC / SCENE_STEP_SEC));
  let mixTimer = null;
  /**
   * Glide every mix level that differs between `from` and `to` (mixOf maps) over SCENE_GLIDE_SEC. A path already
   * gliding starts from where its glide is.
   */
  function glideMix(from, to) {
    for (const [path, v] of paramDiff(from, to)) {
      const cur = mixGlides.get(path);
      const start = cur ? cur.v : from[path];
      if (!Number.isFinite(start)) continue;
      mixGlides.set(path, { from: start, to: v, v: start, k: 0, t0: now() });
    }
    if (mixGlides.size && mixTimer === null) mixTimer = timers.setTimeout(mixStep, SCENE_STEP_SEC * 1000);
  }
  function mixStep() {
    mixTimer = null;
    const t = now();
    mixStepping = true;
    try {
      for (const [path, g] of [...mixGlides]) {
        g.k += 1;
        const elapsed = Number.isFinite(t - g.t0) ? (t - g.t0) / (SCENE_GLIDE_SEC * 1000) : 0;
        const f = Math.min(1, Math.max(g.k / SCENE_STEPS, elapsed));
        g.v = f >= 1 ? g.to : g.from + (g.to - g.from) * f;
        if (f >= 1) mixGlides.delete(path);
        call('setParam', path, g.v);
      }
    } finally {
      mixStepping = false;
    }
    if (mixGlides.size) mixTimer = timers.setTimeout(mixStep, SCENE_STEP_SEC * 1000);
  }
  /**
   * D26.1: move the engine from what `a` plays to what `b` plays at a scene change: the drone's ON / sound / key and
   * the Space room / Echo settings exactly as a manual change (applySongLevel → applyDrone; setParam), the slot and
   * drone levels glide in the engine, the sends and Space / Echo levels in steps (glideMix). Never a prepare / commit.
   */
  function sceneMove(a, b) {
    // the drone's level is the glide below, so the manual path sees it unchanged (configure would set it at once)
    const bd = b.drone && a.drone ? { ...b, drone: { ...b.drone, gain: a.drone.gain } } : b;
    applySongLevel(bd, a, false);
    for (const [path, v] of paramDiff(fxSettingsOf(a), fxSettingsOf(b))) call('setParam', path, v);
    for (const [path, v] of levelDiff(levelsOf(a), levelsOf(b))) call('setParam', path, v, { glide: SCENE_GLIDE_SEC });
    glideMix(mixOf(a), mixOf(b));
  }
  /** Leaving the song's own levels: remember its wheel, so stepping back puts the wheel where it was. */
  const leaveBase = () => {
    if (sceneState.id === appliedId && sceneState.n !== null) return;
    sceneState = { id: appliedId, n: null, baseWheel: wheelNow(), tweak: null };
  };
  /**
   * Play scene `n` of the applied song (null = its own levels): every level that differs glides SCENE_GLIDE_SEC from
   * where it is (engine setParam {glide}; D26.1: sends and Space / Echo levels in steps), the Space room / Echo and the
   * drone's ON / sound / key change as a manual change does (sceneMove); held notes and the song switch path are
   * untouched.
   * @param {number|null} n
   * @returns {boolean} false when there is no such scene (or no song is playing yet)
   */
  function goScene(n) {
    if (!applied || targetId !== appliedId) return false; // a song still loading: its scenes start after the commit
    const cur = store.getSong(appliedId);
    if (cur && cur !== applied) applyDiff(applied, cur); // pending edits first, under the scene that played them
    const list = scenesOf(applied);
    if (n !== null && !(Number.isInteger(n) && n >= 0 && n < list.length)) return false;
    const was = sceneFor(applied);
    const from = live(applied);
    leaveBase();
    sceneState = { ...sceneState, n, tweak: null };
    sceneMove(from, live(applied)); // D26.1: levels, sends, Space / Echo and the drone
    const sc = n === null ? null : list[n];
    const wheel = sc ? sc.wheel : was && Number.isFinite(was.wheel) ? sceneState.baseWheel : undefined;
    if (Number.isFinite(wheel) && Math.abs(wheel - (wheelNow() ?? -1)) > 1e-4) {
      virtualWheel = wheel;
      noteWheel('virtual', wheel);
      call('setWheel', 'virtual', wheel, { glide: SCENE_GLIDE_SEC });
    }
    emit('scene', sceneInfo());
    if (bus) publishState();
    return true;
  }
  /** Next / previous scene (one footswitch cycles own → 1 → 2 → 3 → 1; previous walks back to the own levels). */
  const stepSceneBy = (dir) => {
    const i = sceneInfo();
    return i.count ? goScene(stepScene(i.n, i.count, dir)) : false;
  };
  /**
   * Save what plays now (levels, mutes, drone level, the wheel when routed; D26.1: sends, Space / Echo, the drone's
   * ON / sound / key) as scene `n` of the current song: a new scene (n = the count) or over an existing one. That
   * scene then plays.
   * D25 (UI v6 U7c): `o.name` names it (shared/scenes.js sceneNameOf; '' or null = no name, "Scene n"); without
   * `o.name` an existing scene keeps its name, so a re-save from Quick / Update never drops it.
   * D26.1a: `o.keyShift` ({semis, minor?} above the song's key, the Save / Update dialog's chosen key; null = the
   * drone follows the song's key). Without it the scene keeps a chosen key only while the snapshot that plays has
   * one (its key as heard, live moves included); else none.
   * @param {number} n 0-based, ≤ the count, < SCENE_MAX
   * @param {{name?:string|null, keyShift?:{semis:number, minor?:boolean}|null}} [o]
   * @returns {boolean}
   */
  function saveScene(n, o = {}) {
    if (!applied || targetId !== appliedId) return false;
    const cur = store.getSong(appliedId);
    if (cur !== applied) applyDiff(applied, cur); // pending edits first, under the scene that played them
    const heard = live(cur);
    const playing = sceneFor(cur) ? mergeScene(sceneFor(cur), sceneState.tweak) : null;
    const keyShift = o && 'keyShift' in o ? keyShiftOf(o.keyShift)
      : playing?.drone?.keyShift ? keyShiftBetween(heard, cur) : null;
    const scene = captureScene(heard, { wheel: wheelNow(), keyShift });
    const name = o && 'name' in o ? sceneNameOf(o.name) : sceneNameOf(scenesOf(cur)[n]?.name);
    if (scene && name) scene.name = name;
    const next = withScene(scenesOf(cur), n, scene);
    if (!next) return false;
    store.set(`songs.${appliedId}.scenes`, next); // false when unchanged (the same scene saved again)
    const saved = store.getSong(appliedId);
    if (!scenesOf(saved)[n]) return false; // a read-only store
    leaveBase();
    sceneState = { ...sceneState, n, tweak: null };
    if (applied === cur) applied = saved; // only `scenes` changed, and it now plays what was heard …
    // … but for a key chosen in the dialog (D26.1a): the drone goes there. UI6-snap F1: from what was heard to the
    // saved song as it plays now, not to live(applied): during an instrument re-prepare `applied` is still the song
    // before the load, without this scene, and the move took the whole mix to that song's own levels / Space / Echo
    sceneMove(heard, live(saved));
    emit('scene', sceneInfo());
    if (bus) publishState();
    return true;
  }
  /**
   * A move while a scene plays (Perform's faders / ON tiles, a learned MIDI fader, the bus' drone commands): it is
   * heard at once and held on top of the scene (tweakScene); the song's own fields and the saved scene stay. Views call
   * this first and write the store only when it returns false (no scene playing, or a field the scene doesn't hold).
   * The engine gets what a manual change of the same field sends (applyParamDiff + applySongLevel: a level at once, a
   * drone key change crossfades, a reverb room swaps crossfaded).
   * @param {string} path 'slots.<i>.gain' | 'slots.<i>.muted' | 'drone.gain'; D26.1: 'slots.<i>.sends.reverb' |
   *   '.delay', 'fx.reverb.<row>' | 'fx.delay.<row>' (shared/scenes.js SCENE_FX), 'drone.mode', 'drone.key'
   *   ({pc, minor?}; only while the snapshot has a chosen key, D26.1a)
   * @param {number|boolean|string|object} value
   * @returns {boolean} true when the playing scene took it
   */
  function adjustScene(path, value) {
    const song = appliedId && targetId === appliedId ? store.getSong(appliedId) : null;
    const sc = sceneFor(song);
    if (!sc || !sceneHolds(sc, path)) return false; // the song's own field
    if (song !== applied) applyDiff(applied, song);
    const from = live(applied);
    const tweak = tweakScene(sceneState.tweak, from, path, value, applied);
    if (!tweak) return false;
    sceneState = { ...sceneState, tweak };
    const to = live(applied);
    applyParamDiff(from, to);
    applySongLevel(to, from, false);
    emit('scene', sceneInfo());
    if (bus) publishState();
    return true;
  }
  /**
   * D26.1 (views): a view's store write, first offered to the playing scene. When the scene holds the field the
   * address names (shared/scenes.js sceneFieldOf: a send, a Space / Echo row or whole unit, drone.mode) the move goes
   * on top of the scene (adjustScene: heard, transient, kept by Save) and the view writes nothing; else false and
   * the view writes the store as before. Views: `controller.scenes.take(addr, v) || store.set(addr, v)`.
   * @param {string} addr  current-song grammar, 'song.<rel>' or 'songs.<id>.<rel>'
   * @param {*} value
   * @returns {boolean} true when the playing scene took it
   */
  function takeScene(addr, value) {
    const f = sceneFieldOf(addr);
    if (!f || (f.id && f.id !== appliedId)) return false;
    if (!f.unit) return adjustScene(f.path, value);
    const song = appliedId && targetId === appliedId ? store.getSong(appliedId) : null;
    const sc = sceneFor(song);
    const keys = value && typeof value === 'object' ? Object.keys(value) : [];
    // a whole unit ("Song's own"): only when the scene holds every row it writes
    if (!sc || !keys.length || !keys.every((k) => sceneHolds(sc, `fx.${f.unit}.${k}`))) return false;
    for (const k of keys) adjustScene(`fx.${f.unit}.${k}`, value[k]);
    return true;
  }
  /** Delete scene `n` (the playing one glides back to the song's own levels first). @returns {boolean} */
  function removeScene(n) {
    const song = appliedId ? store.getSong(appliedId) : null;
    if (!song || !(n >= 0 && n < scenesOf(song).length)) return false;
    const i = sceneInfo();
    if (i.n === n) goScene(null); // (it also applies pending edits)
    else if (song !== applied) applyDiff(applied, song);
    const before = applied;
    store.set(`songs.${song.id}.scenes`, withoutScene(scenesOf(song), n));
    if (i.n !== null && i.n > n) sceneState = { ...sceneState, n: i.n - 1 };
    if (before === song) applied = store.getSong(song.id); // only `scenes` changed; the same scene still plays
    emit('scene', sceneInfo());
    if (bus) publishState();
    return true;
  }
  const scenes = Object.freeze({
    /** @returns {{id:string|null, n:number|null, count:number}} the playing song, its playing scene, its count */
    state: sceneInfo,
    /** The song as it sounds (its playing scene on top): Perform's faders show this. */
    view: (song) => live(song),
    go: goScene,
    adjust: adjustScene,
    take: takeScene,
    next: () => stepSceneBy(1),
    prev: () => stepSceneBy(-1),
    save: saveScene,
    remove: removeScene,
    max: SCENE_MAX,
  });

  // ---- decoded-sample memory policy (morning-prep; integration-2 round 2 #3)
  let memMode = null; // 'library' | 'setlist' | 'large-set'
  let probing = false; // round4-controller C2: a setlist being sized (memMode 'large-set', reported as 'setlist')
  let memSetMB = null;
  const hasPreload = () => !secondary && !!engine && typeof engine.preload === 'function';
  const patchesOf = (ids) => ids.map((id) => store.getSong(id)).filter(Boolean).map((s) => enginePatch(s.patch));
  /** True when a non-empty setlist drives navigation (store.navIds() is the setlist, not the library). */
  function inSetlist() {
    const sl = store.currentSetlist();
    return !!(sl && Array.isArray(sl.songIds) && sl.songIds.length);
  }
  /**
   * The current song plus up to `radius` nav neighbours either side (unique ids): current first, then by distance,
   * the next song before the previous one at equal distance (L-8: the order the byte budget fills in). In the setlist
   * "gap" state (current entry removed) the window is centred on the gap.
   * @returns {{ids: string[], cur: string|null}}
   */
  function windowCandidates(radius) {
    const ids = store.navIds();
    const n = store.neighbors();
    const cur = store.get().settings.currentSongId;
    const pick = (d) => {
      if (n.index >= 0) return [n.index + d, n.index - d];
      if (Number.isInteger(n.gap)) return [n.gap + d - 1, n.gap - d];
      return [d - 1]; // current song not in the list: its first songs are the next ones
    };
    const hasCur = !!(cur && store.getSong(cur));
    const out = hasCur ? [cur] : [];
    for (let d = 1; d <= radius; d++) {
      for (const j of pick(d)) if (j >= 0 && j < ids.length && !out.includes(ids[j])) out.push(ids[j]);
    }
    return { ids: out, cur: hasCur ? cur : null };
  }
  async function engineCall(name, ...args) {
    const r = call(name, ...args);
    return r && typeof r.then === 'function' ? await r : r;
  }
  async function estimateMB(ids) {
    try {
      const r = await optional('estimatePreloadMB', patchesOf(ids));
      return r && Number.isFinite(r.mb) ? r : null;
    } catch {
      return null;
    }
  }
  // L-8: the newest window applied with {pin:'replace'} ({ids, mb, oversizeMB}); null = none / count window
  let pinPlan = null;
  let overCap = false;
  let aloneNoted = null; // song id the "This song alone is …" 'memory' event last fired for
  /**
   * Refresh status.memory from engine._debugStats() (called after every preload and from the watchdog tick). L-8:
   * pinned bytes can't be evicted, so pinnedMB > capMB means the LRU cap is broken; warn (once per crossing, never
   * throw) so the soak / diagnostics show it.
   */
  function updateMemory() {
    let d = null;
    try {
      d = optional('_debugStats');
    } catch {
      d = null;
    }
    const num = (v) => (Number.isFinite(v) ? v : null);
    const round = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
    const windowed = memMode === 'library' || memMode === 'large-set';
    const plan = windowed ? pinPlan : null;
    const alone = plan && Number.isFinite(plan.oversizeMB) ? songAloneNote(plan.oversizeMB) : null;
    const pinnedMB = num(d && d.pinnedMB);
    const capMB = num(d && d.capMB);
    const over = pinnedMB !== null && capMB !== null && pinnedMB > capMB;
    if (over && !overCap) {
      // round4-controller C5: diagnostics, not a stage toast ('warn' is toasted verbatim by main.js). The console
      // line keeps the L-8 text; the 'memory' event carries the numbers and plain copy for any UI that wants it.
      console.warn(`[controller] pinned samples ${pinnedMB.toFixed(1)} MB exceed the ${capMB} MB cache cap ` +
        `(${memMode}${plan ? `, ${plan.ids.length} songs pinned` : ''}${alone ? `; ${alone}` : ''}; L-8)`);
      emit('memory', { mode: memMode, overCap: true, pinnedMB, capMB, note: OVER_CAP_NOTE });
    }
    overCap = over;
    setStatus({
      memory: {
        mode: probing && memMode === 'large-set' ? 'setlist' : memMode,
        decodedMB: num(d && d.decodedMB),
        pinnedMB,
        capMB,
        budgetMB: PIN_BUDGET_MB,
        setMB: round(memSetMB),
        windowMB: plan ? round(plan.mb) : null,
        pinnedSongs: plan ? plan.ids.length : null,
        note: alone || (memMode === 'large-set' && !probing ? LARGE_SET_NOTE : null),
      },
    });
  }

  let pinSeq = 0;
  let lastPin = null; // ids of the newest {pin:'replace'} set
  /**
   * engine.preload(ids, {pin}) for 'replace' / 'add'. The engine re-applies its pins after decoding, so an older
   * call that finishes after a newer 'replace' would bring its own pins back (e.g. a whole-setlist pin undone by a
   * slower neighbour window): when that happens, the newest replace set is applied again (all decoded, so quick).
   */
  async function pinSongs(ids, pin) {
    if (!hasPreload()) return;
    const my = ++pinSeq;
    if (pin === 'replace') lastPin = ids;
    await engineCall('preload', patchesOf(ids), { pin });
    const newest = lastPin;
    if (my !== pinSeq && newest && newest !== ids) await engineCall('preload', patchesOf(newest), { pin: 'replace' });
  }
  /**
   * L-8: the byte-budget window. The current song is always in (even alone over the budget: it is playing, and its
   * buffers are referenced anyway; `oversizeMB` is then set and nothing else is pinned). Then the candidates in
   * distance order join while the running total (engine.estimatePreloadMB, shared samples counted once) stays
   * ≤ PIN_BUDGET_MB; one that doesn't fit is skipped and a farther, lighter one may still join. With `onlyExact`, a
   * candidate whose size is still a guess (never decoded: BufferCache.estimateBytes prices it at a folder mean or
   * 1.75 MB a sample) is left out and listed in `guessed`, so an under-estimate can't pin past the budget.
   * Returns null when the engine can't estimate (the pre-L-8 count window is used then).
   * @returns {Promise<{ids: string[], mb: number, oversizeMB: number|null, guessed: string[]}|null>}
   */
  async function planWindow(radius, { onlyExact = false } = {}) {
    const { ids: cand, cur } = windowCandidates(radius);
    const out = [];
    const guessed = [];
    let mb = 0;
    let oversizeMB = null;
    if (cur) {
      const e = await estimateMB([cur]);
      if (!e) return null;
      out.push(cur);
      mb = e.mb;
      // round4-controller C3: a current song still loading (a plan made during a switch, or a preloadSetlist() from
      // a nav edit) is priced at its guess too: pin it alone, and treat every neighbour as guessed
      if (onlyExact && e.exact === false) {
        return { ids: out, mb, oversizeMB: null, guessed: cand.filter((id) => id !== cur) };
      }
      if (e.mb > PIN_BUDGET_MB) return { ids: out, mb, oversizeMB: e.mb, guessed };
    }
    for (const id of cand) {
      if (id === cur) continue;
      if (onlyExact) {
        const one = await estimateMB([id]);
        if (!one) return null;
        if (!one.exact) {
          guessed.push(id);
          continue;
        }
      }
      const e = await estimateMB([...out, id]);
      if (!e) return null;
      if (e.mb <= PIN_BUDGET_MB) {
        out.push(id);
        mb = e.mb;
      }
    }
    return { ids: out, mb, oversizeMB, guessed };
  }
  let winSeq = 0;
  /**
   * Pin the window around the current song with one {pin:'replace'} (engine.preload → BufferCache.setPins): the old
   * window is unpinned in the same call that pins the new one, and every other decoded buffer is evictable. (Not
   * 'add': walking through the library with 'add' pins every song visited, which is the 1 GB the soak measured.)
   * L-8: the window is a byte budget (planWindow). Neighbours never decoded are first decoded unpinned
   * ({pin:'none'}) and the window is planned again with their exact sizes. A newer switch supersedes an older
   * window still being planned.
   */
  async function pinWindow(radius) {
    const my = ++winSeq;
    try {
      let plan = await planWindow(radius, { onlyExact: true });
      if (my !== winSeq) return;
      if (!plan) {
        pinPlan = null;
        await pinSongs(windowCandidates(radius).ids, 'replace');
        return;
      }
      pinPlan = plan;
      await pinSongs(plan.ids, 'replace');
      if (!plan.guessed.length || my !== winSeq) return;
      await engineCall('preload', patchesOf(plan.guessed), { pin: 'none' });
      if (my !== winSeq) return;
      // round4-controller C3: exact sizes only here too; a neighbour whose decode didn't stick stays out
      plan = await planWindow(radius, { onlyExact: true });
      if (!plan || my !== winSeq) return;
      pinPlan = plan;
      await pinSongs(plan.ids, 'replace');
    } catch (err) {
      warn(`preload failed: ${err && err.message}`);
    } finally {
      if (my === winSeq) noteAlone();
    }
  }
  /** One 'memory' event per song that alone passes the budget (for a toast; status.memory.note says it too). */
  function noteAlone() {
    const cur = store.get().settings.currentSongId;
    if (!pinPlan || !Number.isFinite(pinPlan.oversizeMB)) return void (aloneNoted = null);
    if (aloneNoted === cur) return;
    aloneNoted = cur;
    emit('memory', { mode: memMode, note: songAloneNote(pinPlan.oversizeMB), songMB: pinPlan.oversizeMB });
  }

  /** After a song switch: keep the pinned window around the new song (policy depends on the nav mode). */
  function preloadNeighbors() {
    if (!hasPreload()) return;
    if (lowResEff) return void pinCurrentOnly().then(updateMemory); // menubar-A: no neighbour preload
    // v11-memory: only the reverb spaces of the songs around this one stay built (a convolver is 15–113 MB)
    const radius = inSetlist() && memMode === 'large-set' ? LARGE_SET_PIN_RADIUS : LIBRARY_PIN_RADIUS;
    optional('retainReverb', patchesOf(windowCandidates(radius).ids));
    if (!inSetlist()) return void pinWindow(LIBRARY_PIN_RADIUS).then(updateMemory);
    // (a setlist still being sized, round4-controller C2, keeps the large-set window meanwhile: memMode is 'large-set')
    if (memMode === 'large-set') return void pinWindow(LARGE_SET_PIN_RADIUS).then(updateMemory);
    // a setlist that fits is pinned whole already: the neighbours join it (engine-core #10), never replace it
    const n = store.neighbors();
    const ids = [n.prev, n.next].filter(Boolean).map((x) => x.id);
    if (!patchesOf(ids).length) return;
    pinSongs(ids, 'add').then(updateMemory, (err) => warn(`preload failed: ${err && err.message}`));
  }

  let preloadSeq = 0;
  /**
   * Warm the decoded cache for the current nav list; status.ready turns true when done.
   * - No setlist / empty setlist → only the current song ± LIBRARY_PIN_RADIUS (library order) is pinned.
   * - Setlist ≤ PIN_BUDGET_MB → the whole setlist is pinned ({pin:'replace'}).
   * - Larger setlist → current ± LARGE_SET_PIN_RADIUS pinned, the rest warmed unpinned (nearest first, while the
   *   cache has room), status.memory.note = LARGE_SET_NOTE.
   */
  async function preloadSetlist() {
    const my = ++preloadSeq;
    const wasLarge = memMode === 'large-set' && !probing; // the large-set 'memory' event already fired
    probing = false;
    setStatus({ ready: false });
    try {
      if (!hasPreload()) {
        /* nothing to warm */
      } else if (lowResEff) {
        await pinCurrentOnly(); // menubar-A: low-resource pin policy
      } else if (!inSetlist()) {
        memMode = 'library';
        memSetMB = null;
        await pinWindow(LIBRARY_PIN_RADIUS);
      } else {
        const ids = [...new Set(store.navIds())];
        const est = await estimateMB(ids);
        if (my !== preloadSeq) return;
        memSetMB = est ? est.mb : null;
        if (est && est.mb > PIN_BUDGET_MB) await preloadLargeSet(my, ids);
        else if (est && est.exact === false) await probeSetlist(my, ids, wasLarge);
        else {
          memMode = 'setlist';
          pinPlan = null;
          winSeq++; // a window still being planned must not replace the whole-set pin
          updateMemory();
          await pinSongs(ids, 'replace'); // the setlist IS the pinned set
          // the first estimate guesses samples never decoded before; now every size is known
          const exact = my === preloadSeq ? await estimateMB(ids) : null;
          if (exact) memSetMB = exact.mb;
          if (my === preloadSeq && exact && exact.mb > PIN_BUDGET_MB) await preloadLargeSet(my, ids);
        }
      }
    } catch (err) {
      warn(`preloading the setlist failed: ${err && err.message}`);
    }
    if (my === preloadSeq) {
      setStatus({ ready: true });
      updateMemory();
    }
  }

  /**
   * round4-controller C2: a setlist whose estimate fits the budget but is partly a guess (samples never decoded,
   * priced by BufferCache.estimateBytes) is not pinned whole on that guess. It gets the large-set treatment first
   * (an exact-only window, the rest warmed unpinned while the running estimate stays ≤ PIN_BUDGET_MB, so nothing
   * warmed is evicted), and is pinned whole only when the estimate is then exact and fits. status.memory reports
   * 'setlist' with no note meanwhile; the large-set 'memory' event fires only if it doesn't fit.
   */
  async function probeSetlist(my, ids, wasLarge) {
    memMode = 'large-set';
    probing = true;
    updateMemory();
    await pinWindow(LARGE_SET_PIN_RADIUS);
    if (my !== preloadSeq) return;
    await warmRest(my, ids, PIN_BUDGET_MB);
    if (my !== preloadSeq) return;
    const exact = await estimateMB(ids);
    if (my !== preloadSeq) return;
    probing = false;
    if (exact) memSetMB = exact.mb;
    if (exact && exact.exact !== false && exact.mb <= PIN_BUDGET_MB) {
      memMode = 'setlist';
      pinPlan = null;
      winSeq++; // a window still being planned (a switch during the probe) must not replace the whole-set pin
      updateMemory();
      await pinSongs(ids, 'replace'); // the setlist IS the pinned set
    } else await preloadLargeSet(my, ids, !wasLarge);
  }

  async function preloadLargeSet(my, ids, announce = memMode !== 'large-set') {
    memMode = 'large-set';
    updateMemory();
    if (announce) emit('memory', { mode: memMode, note: LARGE_SET_NOTE, setMB: memSetMB });
    await pinWindow(LARGE_SET_PIN_RADIUS);
    await warmRest(my, ids);
  }

  /**
   * Warm the set's songs outside the pinned window unpinned, nearest first, while the running estimate stays
   * ≤ `limitMB` (default: WARM_SHARE_OF_CAP of the cache cap, so the LRU doesn't evict what was just warmed).
   */
  async function warmRest(my, ids, limitMB = null) {
    // the songs actually pinned (L-8: a byte-budget window may leave heavy neighbours out; they warm unpinned)
    const win = pinPlan ? [...pinPlan.ids] : windowCandidates(LARGE_SET_PIN_RADIUS).ids;
    const pos = Math.max(0, store.currentIndex());
    const rest = ids
      .map((id, j) => ({ id, d: Math.abs(j - pos) }))
      .filter((x) => !win.includes(x.id))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.id)
      .filter((id, k, a) => a.indexOf(id) === k);
    const warmed = [...win];
    for (const id of rest) {
      if (my !== preloadSeq) return;
      const est = await estimateMB([...warmed, id]);
      if (!est || !Number.isFinite(est.capMB)) break;
      const limit = limitMB !== null ? Math.min(limitMB, est.capMB) : est.capMB * WARM_SHARE_OF_CAP;
      if (est.mb > limit) break;
      await engineCall('preload', patchesOf([id]), { pin: 'none' });
      warmed.push(id);
    }
  }

  // ---- perform input
  const heldBySrc = new Map(); // src → Set<note>; MIDI src = `${inputId}:${channel}` (M3), else 'kb' / 'ui'
  const heldCount = new Map(); // note → number of sources holding it
  const pedalBySrc = new Map(); // src (inputId / 'kb' / 'ui') → bool
  const pedalRaw = new Map(); // MIDI inputId → raw CC64 ≥ 64 (so pedalInvert can be re-applied mid-press, L9)
  const midiSrc = (d) => `${d.inputId}:${d.channel ?? 0}`;
  let pedalDown = false;
  let swellActive = false;
  let virtualWheel = 1;
  const pickups = new Map(); // controlId → {picked, last}
  const buttonState = new Map(); // controlId → pressed

  const settings = () => store.get().settings;

  // ---- v11-touch: per-keyboard touch curves (settings.keyboards, keyed by MIDI device name)
  /** MIDI input id → device name (from the 'devices' events; Web MIDI ids change on a re-plug, names don't). */
  const inputNames = new Map();
  /** input id (or COMPUTER_KEYBOARD) → noteOn options {touch} of a keyboard with its own curve (rebuilt on change). */
  const touchOpts = new Map();
  let touchCapture = null; // captureTouch() listener
  function rebuildTouch() {
    touchOpts.clear();
    const kb = settings().keyboards || {};
    const optsFor = (name) => (kb[name] && kb[name].touch ? { touch: compileTouch(kb[name].touch) } : null);
    for (const [id, name] of inputNames) {
      const o = optsFor(name);
      if (o) touchOpts.set(id, o);
    }
    const own = optsFor(COMPUTER_KEYBOARD);
    if (own) touchOpts.set(COMPUTER_KEYBOARD, own);
  }
  /** v11-touch: names of remembered keyboards → midi ('first' prefers them). */
  function applyRemembered() {
    if (!midi || typeof midi.setRemembered !== 'function') return;
    const kb = settings().keyboards || {};
    midi.setRemembered(Object.keys(kb).filter((n) => kb[n] && kb[n].remember === true));
  }
  function noteDevices(inputs) {
    if (!Array.isArray(inputs)) return;
    inputNames.clear();
    for (const i of inputs) if (i && i.id) inputNames.set(i.id, i.name || '');
    rebuildTouch();
  }
  rebuildTouch();
  /**
   * v11-touch: listen to every played note-on's raw velocity (before the Touch setting or any curve) for the "play
   * soft, then hard" calibration. One listener at a time (a new one replaces the old). The notes still play.
   * @param {(n:{velocity:number, device:string|null, inputId:string|null}) => void} cb  device = the MIDI device's
   *        name, or COMPUTER_KEYBOARD for the on-screen and computer keys
   * @returns {() => void} stop
   */
  function captureTouch(cb) {
    const fn = typeof cb === 'function' ? cb : null;
    touchCapture = fn;
    return () => {
      if (touchCapture === fn) touchCapture = null;
    };
  }
  /** Tell a captureTouch() listener about a played note (raw velocity, before any curve). */
  function captured(velocity, device, inputId) {
    if (!touchCapture) return;
    try {
      touchCapture({ velocity, device, inputId: inputId ?? null });
    } catch (err) {
      console.warn('[controller] touch capture', err);
    }
  }

  function noteOnFrom(src, note, vel, opts) {
    if (!Number.isInteger(note) || note < 0 || note > 127) return;
    noteActivity(src); // lowres2: every note is input (the engine also queues it while the audio wakes)
    let set = heldBySrc.get(src);
    if (!set) heldBySrc.set(src, (set = new Set()));
    if (set.has(note)) return; // duplicate note-on from the same source
    set.add(note);
    const c = heldCount.get(note) || 0;
    heldCount.set(note, c + 1);
    if (c === 0) {
      if (opts) call('noteOn', note, vel, opts); // v11-touch: the keyboard's own curve (its 'normal' slots use it)
      else call('noteOn', note, vel);
    }
  }

  function noteOffFrom(src, note) {
    const set = heldBySrc.get(src);
    if (!set || !set.has(note)) return;
    set.delete(note);
    const c = (heldCount.get(note) || 0) - 1;
    if (c <= 0) {
      heldCount.delete(note);
      call('noteOff', note);
    } else heldCount.set(note, c);
  }

  function updatePedal() {
    const down = [...pedalBySrc.values()].some(Boolean);
    if (down !== pedalDown) {
      pedalDown = down;
      call('sustain', down);
      setStatus({ pedal: down });
    }
  }

  /** Release every note of a source; for a MIDI input id this covers all of its channels. */
  function releaseSource(src) {
    for (const key of [...heldBySrc.keys()]) {
      if (key !== src && !key.startsWith(`${src}:`)) continue;
      const set = heldBySrc.get(key);
      if (set) for (const n of [...set]) noteOffFrom(key, n);
      heldBySrc.delete(key);
    }
    pedalRaw.delete(src);
    if (pedalBySrc.has(src)) {
      pedalBySrc.delete(src);
      updatePedal();
    }
  }
  /**
   * L9: pedalInvert changed → recompute every MIDI pedal from its raw state. A recompute may only RELEASE the
   * sustain (e.g. a reversed pedal at rest stops sustaining at once); it never starts sustaining by itself — the next
   * pedal message sets the real state, so flipping the setting can't leave a stuck pedal.
   */
  function reapplyPedalInvert() {
    const inv = !!settings().pedalInvert;
    for (const [src, raw] of pedalRaw) pedalBySrc.set(src, (inv ? !raw : raw) && !!pedalBySrc.get(src));
    updatePedal();
  }

  function learnedFor(kind, num, channel) {
    return learnedAll(kind, num, channel)[0] ?? null;
  }
  /**
   * Every controlId learned to this note / CC on this channel, in settings.midiLearn order. 2.x step 5 (O-AW-ML
   * rule 4): the first decides what the message is; when it is a fader, every fader mapping on the CC moves (one
   * knob, several params), while a button mapping keeps the 1.x first-match rule.
   */
  function learnedAll(kind, num, channel) {
    if (kind === 'cc' && num === 64) return []; // the sustain pedal is never remapped (M2; old mappings ignored)
    const ml = settings().midiLearn || {};
    const out = [];
    for (const [id, m] of Object.entries(ml)) {
      if (m[kind] === num && (m.channel === null || m.channel === undefined || m.channel === channel)) out.push(id);
    }
    return out;
  }

  const isButtonControl = (id) => BUTTON_CONTROLS.includes(id) || isLearnButton(id);

  function triggerButton(id, pressed) {
    const prev = buttonState.get(id) || false;
    buttonState.set(id, pressed);
    if (id === 'swell') {
      if (pressed !== prev) swell(pressed);
      return;
    }
    if (!pressed || prev) return;
    if (id === 'nextSong') nextSong();
    else if (id === 'prevSong') prevSong();
    else if (id === 'go') go(); // Lane S (D6): a footswitch
    else if (id === 'cueNext') cueStep(1);
    else if (id === 'cuePrev') cueStep(-1);
    else if (id === 'panic') panic();
    else if (id === 'fadeOutAll') fadeOutAll();
    else if (id === 'nextScene') stepSceneBy(1); // v11-scenes: a learned footswitch
    else if (id === 'prevScene') stepSceneBy(-1);
  }

  /**
   * round4-controller C9: a learned CC button. A press-only ("trigger") footswitch sends 127 on every press and
   * never 0, so a value ≥ 64 while already pressed counts as a new press once CC_RETRIGGER_MS has passed since the
   * last one (contact bounce and a held momentary switch stay one press). < 64 is a release. Swell stays level-based.
   * A toggle-mode switch (127 / 0 on alternate presses) still acts on every other press: set it to momentary.
   */
  const ccFired = new Map(); // controlId → now() of the last press
  function ccButton(id, pressed) {
    if (pressed && id !== 'swell' && buttonState.get(id) && now() - (ccFired.get(id) ?? -Infinity) >= CC_RETRIGGER_MS) {
      buttonState.set(id, false);
    }
    if (pressed && !buttonState.get(id)) ccFired.set(id, now());
    triggerButton(id, pressed);
  }

  /**
   * Hardware fader / knob with pickup: ignored until it crosses the stored value (REVIEW 2.1). 2.x step 5 (O-AW-ML):
   * any continuous PARAMS path (shared/learn.js isLearnablePath), mapped along the row's curve between the mapping's
   * min / max (invert runs it backwards); with none of those a level is faderTaper(cc), as in 1.x. The path is in the
   * current-song grammar, so it acts on whichever song plays; a slot the song lacks (or an empty one) is a no-op. A
   * value no CC position stands for (an optional row's null / 'natural') is taken over at once.
   * @param {string} id
   * @param {number} value01
   * @param {{min?:number, max?:number, invert?:boolean}} [m] the mapping
   */
  function learnedFader(id, value01, m) {
    if (!isLearnablePath(id)) return; // UIA: a learned level of slot 5..16 (a song without it: no-op below)
    const song = live(store.currentSong()); // v11-scenes: pick up the level as it sounds
    if (!song) return;
    const p = parsePath(id, MAX_SLOTS);
    if (p.slot !== null && !song.patch.slots[p.slot]) return;
    // skeptic midi-learn-any S1: the store moves to the next song at once, the commit (pickups.clear,
    // dropLearnWrites) only after it loads. In between, a knob picked up on the old song must pick up again, and an
    // old song's pending write must not land, so both are keyed by the song they were made on.
    const sid = song.id;
    const w0 = learnWrites.get(id);
    if (w0 && w0.sid !== sid) dropLearnWrite(id);
    const pend = learnWrites.get(id)?.pending; // a throttled write not stored yet is where the knob already is
    const stored = songParam(song, id);
    const cur = pend !== undefined ? pend : stored === undefined ? describe(id).default : stored;
    const pos = valueToCc(id, cur, m);
    let pu = pickups.get(id);
    if (!pu || pu.sid !== sid) pickups.set(id, (pu = { picked: false, last: null, sid }));
    if (pos === null) pu.picked = true;
    else {
      if (pu.picked && pu.last !== null && Math.abs(pos - pu.last) > 0.02) pu.picked = false; // moved elsewhere
      if (!pu.picked) {
        if (Math.abs(value01 - pos) < 0.02) pu.picked = true;
        else if (pu.last !== null && (pu.last - pos) * (value01 - pos) <= 0) pu.picked = true;
      }
    }
    pu.last = value01;
    if (!pu.picked) return;
    const v = ccToValue(id, value01, m);
    if (SCENE_LEVEL_RE.test(id) && adjustScene(id, v)) return;
    writeLearned(id, v, sid);
  }
  // the rows a scene holds (shared/scenes.js sceneHolds; D26.1: the Space / Echo sends and rows too)
  const SCENE_LEVEL_RE = /^(slots\.\d+\.(gain|sends\.reverb|sends\.delay)|drone\.gain|fx\.(reverb|delay)\.[a-zA-Z]+)$/;

  /**
   * 2.x step 5 (O-AW-ML rule 5): the store write of a learned knob. A fixed 1.x row (params.isLearnable) writes every
   * message, as before. A custom path writes at once when LEARN_WRITE_MS has passed since its last write, else keeps
   * the value and writes the latest one when the window ends (a knob sends up to ~1000 messages/s; every write runs
   * the store notify, the controller diff and the views). Like a slider drag it edits the song (Revert undoes it).
   */
  const learnWrites = new Map(); // path → {at, pending, timer, sid}
  function writeLearned(id, v, sid) {
    if (isLearnable(id)) {
      store.set(id, v);
      return;
    }
    let w = learnWrites.get(id);
    if (!w) learnWrites.set(id, (w = { at: -Infinity, pending: undefined, timer: null, sid }));
    const t = now();
    if (w.timer === null && t - w.at >= LEARN_WRITE_MS) {
      w.at = t;
      store.set(id, v);
      return;
    }
    w.pending = v;
    if (w.timer !== null) return;
    w.timer = timers.setTimeout(() => {
      w.timer = null;
      w.at = now();
      const val = w.pending;
      w.pending = undefined;
      // S1: the store already selected another song (still loading): this value belongs to the one it was played on
      if (val !== undefined && store.get().settings.currentSongId === w.sid) store.set(id, val);
    }, Math.max(0, LEARN_WRITE_MS - (t - w.at)));
  }
  /** One path's pending burst is dropped (S1: it was played on another song). */
  function dropLearnWrite(id) {
    const w = learnWrites.get(id);
    if (w && w.timer !== null) timers.clearTimeout(w.timer);
    learnWrites.delete(id);
  }
  /** A song switch / dispose: a burst still waiting belongs to the song it was played on, so it is dropped. */
  function dropLearnWrites() {
    for (const w of learnWrites.values()) if (w.timer !== null) timers.clearTimeout(w.timer);
    learnWrites.clear();
  }

  const midiHandlers = {
    noteon: (e) => {
      const d = e.detail;
      const learned = learnedFor('note', d.note, d.channel);
      if (learned && isButtonControl(learned)) return triggerButton(learned, d.velocity > 0);
      if (d.velocity === 0) return noteOffFrom(midiSrc(d), d.note);
      captured(d.velocity, inputNames.get(d.inputId) ?? null, d.inputId);
      // v11-touch: a keyboard with its own curve gets the raw velocity (its curve replaces the Touch setting)
      const own = touchOpts.get(d.inputId);
      if (own) noteOnFrom(midiSrc(d), d.note, d.velocity, own);
      else noteOnFrom(midiSrc(d), d.note, applyVelocitySens(d.velocity, settings().velocitySens));
    },
    noteoff: (e) => {
      const d = e.detail;
      const learned = learnedFor('note', d.note, d.channel);
      if (learned && isButtonControl(learned)) return triggerButton(learned, false);
      noteOffFrom(midiSrc(d), d.note);
    },
    cc: (e) => {
      const d = e.detail;
      const learned = learnedAll('cc', d.cc, d.channel);
      if (learned.length) {
        if (isButtonControl(learned[0])) ccButton(learned[0], d.value >= 64);
        else {
          const ml = settings().midiLearn || {};
          for (const id of learned) if (!isButtonControl(id)) learnedFader(id, d.value01, ml[id]);
        }
        return;
      }
      switch (d.cc) {
        case 64: {
          const raw = d.value >= 64;
          pedalRaw.set(d.inputId, raw);
          pedalBySrc.set(d.inputId, settings().pedalInvert ? !raw : raw);
          updatePedal();
          break;
        }
        case 1:
          noteWheel('mod', d.value01);
          call('modWheel', d.value01);
          break;
        case 11:
          noteWheel('expr', d.value01);
          call('expression', d.value01);
          break;
        case 7:
          noteWheel('vol', d.value01);
          call('volumeCC', d.value01);
          break;
        case 120:
        case 123: {
          const src = midiSrc(d); // all-notes-off is per channel
          const set = heldBySrc.get(src);
          if (set) for (const n of [...set]) noteOffFrom(src, n);
          break;
        }
        default:
          break;
      }
    },
    bend: (e) => call('pitchBend', e.detail.value),
    program: (e) => {
      // Lane S: an optional channel filter (S1 risk 8), and PC cues by default (D6: GO is the deliberate action)
      const pc = programChangeOf(settings());
      if (!pc.on) return;
      if (pc.channel !== null && e.detail.channel !== pc.channel) return;
      const ids = store.navIds();
      const p = e.detail.program;
      if (!(p >= 0 && p < ids.length)) return;
      if (pc.action === 'switch') {
        if (cue) {
          cue = null;
          publishCue();
        }
        goTo({ id: ids[p], index: p });
      } else cueSong(ids[p], { index: p });
    },
    disconnected: (e) => releaseSource(e.detail.inputId),
    devices: (e) => {
      const d = e.detail;
      noteDevices(d.inputs);
      const sel = d.inputs.filter((i) => i.selected);
      const hint = d.hint || null;
      // midi-default: announce the all-ports fallback once each time it starts (no hardware keyboard connected)
      if (hint && hint !== status.midi.hint) warn(hint);
      setStatus({
        midi: {
          available: d.available,
          connected: sel.length > 0,
          name: d.activeName || sel.map((i) => i.name).join(', ') || null,
          // L-3: access granted (possibly after the 'pending' soft timeout) → no reason left to report
          reason: d.available ? null : status.midi.reason,
          pending: d.available ? false : !!status.midi.pending,
          inputs: d.inputs,
          hint,
          fallback: !!d.fallback,
          standIn: !!d.standIn,
        },
      });
    },
    // midi-default (4): a hot-plug moved us onto another keyboard
    switched: (e) => {
      noteActivity('midi-switched'); // lowres2: a hot-plug is input
      warn(`Now using ${e.detail.name || 'another MIDI input'}`);
    },
    // midi-default (3): the chosen keyboard came back with a new id (matched by name) → remember the new id
    rebind: (e) => {
      if (secondary || settings().midiInputId === e.detail.inputId) return;
      store.set('settings.midiInputId', e.detail.inputId);
    },
    unavailable: (e) =>
      setStatus({ midi: { ...status.midi, available: false, connected: false, reason: e.detail.reason, pending: false } }),
    activity: (e) => {
      const t = now();
      if (t - lastActivity < 50) return;
      lastActivity = t;
      emit('midi-activity', e.detail);
    },
  };
  let lastActivity = 0;

  // ---- computer keyboard
  const kbHeld = new Map(); // code → note
  let kbOctave = 0;
  let kbSustain = false;

  function activeEl(e) {
    return (doc && doc.activeElement) || (e && e.target) || null;
  }
  /**
   * fixenter (S-cue-go S7 follow-up): the element the key went to. e.target is fixed when the event is dispatched;
   * activeElement is not. Edit's note / tempo fields (and eq-keyboard's) blur themselves on Enter in their own
   * keydown, so they commit through 'change'. By the time the event bubbles to the document, body has focus, and
   * reading activeElement alone took that Enter for "nothing focused" and fired GO (the song switched under the edit).
   * A real element target wins; a target of body / the document (or a fake doc in the node tests) falls back to
   * activeElement.
   */
  function keyEl(e) {
    const t = e && e.target;
    if (t && t.tagName && !(doc && (t === doc.body || t === doc.documentElement))) return t;
    return activeEl(e);
  }
  function nothingFocused(el) {
    return !el || (doc && (el === doc.body || el === doc.documentElement)) || !el.tagName;
  }

  /** S-review S7: Enter = GO here? Perform, Settings not open (main.js marks body.settings-open), a GO target. */
  function enterGoes() {
    if (settings().view !== 'perform') return false;
    const body = doc && doc.body;
    if (body && body.classList && typeof body.classList.contains === 'function'
      && body.classList.contains('settings-open')) return false;
    return !!goTarget();
  }

  function onKeyDown(e) {
    if (e.defaultPrevented) return;
    const el = keyEl(e); // fixenter: not activeElement alone (a field may have blurred itself on this key)
    const inText = isTextControl(el);
    const onButton = isButtonish(el);
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey) {
      if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && !inText && !onButton && !e.repeat) {
        e.preventDefault();
        if (e.code === 'ArrowLeft') prevSong();
        else nextSong();
        return;
      }
      if (isElectron) return; // the app menu owns ⌘. ⌘E ⌘R ⌘⇧F in Electron
      const k = String(e.key || '').toLowerCase();
      if (e.repeat) return;
      if (k === '.') {
        e.preventDefault();
        panic();
      } else if (k === 'e' && !e.shiftKey) {
        e.preventDefault();
        toggleView();
      } else if (k === 'r' && !e.shiftKey) {
        e.preventDefault();
        record();
      } else if (k === 'f' && e.shiftKey) {
        e.preventDefault();
        fadeOutAll();
      }
      return;
    }
    if (e.altKey || mod) return;
    if (inText) return;
    switch (e.code) {
      case 'ArrowLeft':
      case 'ArrowRight':
        if (onButton) return;
        e.preventDefault();
        if (!e.repeat) {
          // Lane S: Shift+←/→ walks the cue; ←/→ stay Prev / Next (1.x)
          if (e.shiftKey) cueStep(e.code === 'ArrowLeft' ? -1 : 1);
          else if (e.code === 'ArrowLeft') prevSong();
          else nextSong();
        }
        return;
      case 'Enter':
      case 'NumpadEnter':
        // Lane S: Enter = GO, only with nothing focused (a focused button keeps its own Enter). S-review S7: only on
        // Perform with Settings closed, and only when the GO control shows a target, so a stray Enter in Edit or
        // Settings (after a dialog closed, say) never changes the song.
        if (!nothingFocused(el) || !enterGoes()) return;
        e.preventDefault();
        if (!e.repeat) go();
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (e.shiftKey) {
          if (!e.repeat) swell();
        } else nudgeWheel(WHEEL_NUDGE);
        return;
      case 'ArrowDown':
        e.preventDefault();
        if (!e.shiftKey) nudgeWheel(-WHEEL_NUDGE);
        return;
      case 'Escape':
        if (!e.repeat) panic();
        return;
      case 'Space':
        if (!nothingFocused(el)) return;
        e.preventDefault();
        if (!e.repeat && !kbSustain) {
          kbSustain = true;
          pedalBySrc.set('kb', true);
          updatePedal();
        }
        return;
      default:
        break;
    }
    if (!settings().computerKeyboard) return;
    if (e.code === 'KeyZ' || e.code === 'KeyX') {
      e.preventDefault();
      if (!e.repeat) kbOctave = Math.max(-3, Math.min(3, kbOctave + (e.code === 'KeyZ' ? -1 : 1)));
      emit('kb-octave', { octave: kbOctave });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(KEY_MAP, e.code)) {
      e.preventDefault();
      if (e.repeat || kbHeld.has(e.code)) return;
      const note = 60 + 12 * kbOctave + KEY_MAP[e.code];
      if (note < 0 || note > 127) return;
      kbHeld.set(e.code, note);
      captured(KB_VELOCITY, COMPUTER_KEYBOARD, null);
      noteOnFrom('kb', note, KB_VELOCITY, touchOpts.get(COMPUTER_KEYBOARD));
    }
  }

  function onKeyUp(e) {
    if (e.code === 'Space' && kbSustain) {
      kbSustain = false;
      pedalBySrc.set('kb', false);
      updatePedal();
      return;
    }
    const note = kbHeld.get(e.code);
    if (note !== undefined) {
      kbHeld.delete(e.code);
      noteOffFrom('kb', note);
    }
  }

  function releaseKeyboard() {
    for (const [code, note] of [...kbHeld]) {
      kbHeld.delete(code);
      noteOffFrom('kb', note);
    }
    if (kbSustain) {
      kbSustain = false;
      pedalBySrc.set('kb', false);
      updatePedal();
    }
  }
  const onBlur = () => releaseKeyboard();
  const onVisibility = () => {
    if (doc && doc.visibilityState === 'hidden') releaseKeyboard();
    else if (doc && doc.visibilityState === 'visible') acquireWakeLock();
  };

  // Last effective wheel values as the engine sees them (M1: re-sent after a restart).
  const wheelState = { mod: null, modOwner: null, expr: null, vol: null };
  function noteWheel(source, value) {
    if (!Number.isFinite(value)) return;
    if (source === 'virtual') {
      wheelState.mod = value;
      wheelState.modOwner = 'virtual';
    } else if (source === 'mod') {
      if (wheelState.modOwner === 'virtual') return; // pickup: the engine confirms a takeover via its 'wheel' event
      wheelState.mod = value;
      wheelState.modOwner = 'hw';
    } else if (source === 'expr') wheelState.expr = value;
    else if (source === 'vol') wheelState.vol = value;
  }
  /** Engine 'wheel' events are authoritative (pickup, swell automation). */
  function onEngineWheel(d) {
    if (!d || !Number.isFinite(d.value)) return;
    if (d.source === 'virtual') noteWheel('virtual', d.value);
    else if (d.source === 'mod') {
      if (d.pickup) {
        wheelState.mod = d.value;
        wheelState.modOwner = 'virtual';
      } else {
        wheelState.mod = d.value;
        wheelState.modOwner = 'hw';
      }
    } else noteWheel(d.source, d.value);
  }

  function setVirtualWheel(v) {
    virtualWheel = v;
    noteWheel('virtual', v);
    call('setWheel', 'virtual', v);
    emit('wheel', { source: 'virtual', value: v });
  }
  function nudgeWheel(delta) {
    setVirtualWheel(Math.max(0, Math.min(1, Math.round((virtualWheel + delta) * 100) / 100)));
  }

  // ---- Lane S (native DECISIONS D6): "Cue, then Go"
  // A cue is controller state only (not persisted): which setlist entry GO plays next. Cueing changes nothing you hear
  // or see about the playing song; it warms the cued song's samples (engine.preload {pin:'none'}). GO switches to the
  // cue (none: the next song). A GO on a song whose samples aren't decoded yet waits for them first (`going`, not
  // started), so the screen keeps the playing song until the switch is quick. Next / Prev are "cue the neighbour of
  // the song you hear, and GO" (1.x muscle memory: one press switches). S1 audit risk 1: a second Next during a load
  // is the same request (stepSong), so it never skips one.
  const GO_WAIT_MAX_MS = 30000; // a decode that takes longer switches anyway (the old song plays until it's ready)
  const WARM_MAX_MS = GO_WAIT_MAX_MS; // S-review S8: a warm-up that never settles stops reading "loading"
  let cue = null; // {id, index}
  let going = null; // {id, index, started, promise}: a GO waiting for its song (started = its selectSong runs)
  let goSeq = 0;
  let inflight = null; // {id, index, promise}: the newest selectSong request (trackSelect)
  const warming = new Map(); // song id → engine.preload promise (cue / GO warm-up)
  const warmTimers = new Set(); // S-review S8: each warm-up's WARM_MAX_MS cap ({timer}), cleared on dispose
  let cueDisposed = false; // dispose(): a late warm-up settling publishes nothing

  /** Nav position of `id`, preferring `index` when it points at that song (setlists may repeat a song). */
  function entryOf(id, index) {
    const ids = store.navIds();
    const at = Number.isInteger(index) && index >= 0 && ids[index] === id ? index : ids.indexOf(id);
    return { id, index: at };
  }
  /**
   * True when `ref` ({id, index}) is the entry (id, index). An index that no longer points at its song (the list
   * was edited) is ignored, so the song id decides.
   */
  function sameEntry(ref, id, index) {
    if (!ref || ref.id !== id) return false;
    const ids = store.navIds();
    const refOk = Number.isInteger(ref.index) && ref.index >= 0 && ids[ref.index] === ref.id;
    const idxOk = Number.isInteger(index) && index >= 0 && ids[index] === id;
    return !(refOk && idxOk) || ref.index === index;
  }
  /** A switch is in flight: the store already shows its target while the applied song still plays. */
  const switching = () => !!appliedId && targetId !== appliedId;
  const isPlaying = (id, index) => !!appliedId && sameEntry({ id: appliedId, index: appliedIndex }, id, index);

  /**
   * Are all of a song's samples decoded? Reads the engine's decoded-sample cache the way main.js's Ready light did
   * (engine.cache.has, cache.failed, registry.samplers; the web engine and the bridge both expose them).
   * @param {string} id
   * @returns {boolean|null} null when the engine can't say (no cache, a secondary window, unknown song)
   */
  function songReady(id) {
    const song = store.getSong(id);
    if (!song || secondary || !engine) return null;
    try {
      const cache = engine.cache;
      const samplers = engine.registry && engine.registry.samplers;
      if (!cache || !cache.entries || !samplers) return null;
      const held = (u) => (typeof cache.has === 'function' ? cache.has(u) : cache.entries.has(u));
      const failed = (u) => !!(cache.failed && typeof cache.failed.has === 'function' && cache.failed.has(u));
      for (const sl of enginePatch(song.patch).slots) {
        if (!sl || sl.instrument.type !== 'sampler') continue;
        const def = samplers.get(sl.instrument.id);
        if (!def) continue;
        for (const L of def.layers || []) {
          for (const smp of L.samples || []) if (!held(smp.url) && !failed(smp.url)) return false;
        }
      }
      return true;
    } catch {
      return null;
    }
  }

  /**
   * One setlist entry's state for the chips and the GO control (D6: playing / cued / loading / ready / not loaded).
   * `load` is the sound side alone ('cold' = not loaded); `state` puts playing, then cued, first.
   * @param {string} id
   * @param {number} [index] nav position (setlists may repeat a song)
   * @returns {{state:'playing'|'cued'|'loading'|'ready'|'cold', load:'playing'|'loading'|'ready'|'cold',
   *   cued:boolean, going:boolean}|null}
   */
  function songState(id, index) {
    if (!id || !store.getSong(id)) return null;
    const playing = isPlaying(id, index);
    const cued = !playing && sameEntry(cue, id, index);
    const isGoing = !playing && !!going && sameEntry(going, id, index);
    let load;
    if (playing) load = 'playing';
    else if (warming.has(id) || isGoing || (status.loading && targetId === id)) load = 'loading';
    else load = songReady(id) === false ? 'cold' : 'ready';
    return { state: playing ? 'playing' : cued ? 'cued' : load, load, cued, going: isGoing };
  }

  /**
   * Decode a song's samples unpinned (cue / GO). S-review S8: a preload that never settles is given up after
   * WARM_MAX_MS (= the GO cap), so the song falls back to what songReady says (not loaded) instead of "loading" for
   * good, and a later cue or GO asks again instead of waiting on the stuck promise.
   * @returns {Promise|null} null when there is nothing to wait for
   */
  function warm(id) {
    if (warming.has(id)) return warming.get(id);
    if (songReady(id) !== false || !hasPreload()) return null;
    const w = { timer: null };
    const cap = new Promise((r) => {
      w.timer = timers.setTimeout(() => {
        w.timer = null;
        r();
      }, WARM_MAX_MS);
    });
    const pre = engineCall('preload', patchesOf([id]), { pin: 'none' })
      .catch((err) => warn(`could not load the cued song: ${err && err.message}`));
    const p = Promise.race([pre, cap]).then(() => {
      if (w.timer !== null) timers.clearTimeout(w.timer);
      w.timer = null;
      warmTimers.delete(w);
      if (warming.get(id) === p) warming.delete(id);
      if (!cueDisposed) publishCue(true); // S re-check R2: a warm-up settling after dispose() emits nothing
    });
    // a preload that settles after the cap: the chips re-read (its samples may be decoded now)
    pre.then(() => {
      if (!cueDisposed && !warming.has(id)) publishCue(true);
    });
    warmTimers.add(w);
    warming.set(id, p);
    return p;
  }

  /** status.cue / status.go (a 'status' event when they change); `force` re-emits for a load-state-only change. */
  function publishCue(force = false) {
    const c = cue ? { id: cue.id, index: cue.index } : null;
    const g = going ? { id: going.id, index: going.index, waiting: !going.started } : null;
    if (force && same(status.cue, c) && same(status.go, g)) emit('status', { ...status });
    else setStatus({ cue: c, go: g });
  }
  /** A GO still waiting for its song is dropped (one already switching runs on: the engine keeps the newest). */
  function dropPendingGo() {
    if (!going || going.started) return;
    if (going.timer !== null) timers.clearTimeout(going.timer); // S-review S2: no 30 s cap left behind
    going = null;
    goSeq++;
    publishCue();
  }
  /**
   * S-review S1: a cue (or a GO still waiting) on an entry that left the nav list (removed from the setlist, the song
   * deleted, another setlist made current) is dropped, so GO never plays a song outside the set the screen shows.
   */
  function dropStaleCue() {
    const ids = store.navIds();
    const gone = (r) => !!r && (!store.getSong(r.id) || !ids.includes(r.id));
    if (gone(going)) dropPendingGo();
    if (gone(cue)) {
      cue = null;
      publishCue();
    }
  }

  /**
   * Cue a song: GO will play it. Changes nothing audible; starts decoding it. Cueing the song that plays clears the
   * cue; cueing the cued entry again keeps it. A new cue drops a GO that is still waiting for its song.
   * @param {string} id
   * @param {{index?:number}} [opts]
   * @returns {boolean} true when a cue is set
   */
  function cueSong(id, opts = {}) {
    if (!store.getSong(id)) return false;
    const e = entryOf(id, opts.index);
    if (isPlaying(e.id, e.index)) {
      clearCue();
      return false;
    }
    if (!(going && sameEntry(going, e.id, e.index))) dropPendingGo();
    cue = e;
    warm(id);
    publishCue();
    return true;
  }
  /** Forget the cue (and a GO still waiting for it). */
  function clearCue() {
    cue = null;
    dropPendingGo();
    publishCue();
  }

  /**
   * What GO plays now: the cue, else what Next would play (stepSong(1): the next song, or the one already on its way
   * when a Next is loading).
   * @returns {{id:string, index:number, cued:boolean}|null}
   */
  function goTarget() {
    if (cue && store.getSong(cue.id)) return { ...entryOf(cue.id, cue.index), cued: true };
    const way = going || (switching() ? inflight : null);
    const n = !way ? store.neighbors().next : way.dir === 1 ? way : neighborOf(way, 1);
    return n ? { id: n.id, index: entryOf(n.id, n.index).index, cued: false } : null;
  }

  /** Switch to an entry, waiting for its samples first when they are known not to be decoded. */
  function goTo(t, dir = 0) {
    if (going && sameEntry(going, t.id, t.index)) return going.promise; // second press while it waits / loads
    if (inflight && switching() && sameEntry(inflight, t.id, t.index)) return inflight.promise;
    dropPendingGo();
    const my = ++goSeq;
    const g = { id: t.id, index: t.index, started: false, promise: null, dir, timer: null };
    going = g;
    const run = () => {
      if (g.timer !== null) timers.clearTimeout(g.timer);
      g.timer = null;
      if (my !== goSeq || going !== g) return false;
      g.started = true;
      publishCue();
      const p = trackSelect(t.id, { index: t.index }, dir);
      const done = () => {
        if (going === g) {
          going = null;
          publishCue();
        }
      };
      p.then(done, done);
      return p;
    };
    const w = warm(t.id);
    if (!w) {
      g.promise = run(); // nothing to wait for: switch now, as 1.x did
      return g.promise;
    }
    publishCue();
    const cap = new Promise((r) => {
      g.timer = timers.setTimeout(r, GO_WAIT_MAX_MS);
    });
    g.promise = Promise.race([w, cap]).then(run);
    return g.promise;
  }

  /**
   * GO: switch to the cued song (none cued: the next song). A cued song that isn't loaded yet is waited for; the
   * playing song stays on screen and in your ears meanwhile. A second GO while it waits does nothing new.
   * @returns {Promise<boolean>} true when the switch committed
   */
  function go() {
    if (!cue || !store.getSong(cue.id)) return stepSong(1);
    return goTo(entryOf(cue.id, cue.index));
  }
  /** The entry `dir` steps from `ref` in the nav list (a ref no longer in it: the store's own neighbours). */
  function neighborOf(ref, dir) {
    const ids = store.navIds();
    const pos = entryOf(ref.id, ref.index).index;
    if (pos < 0) {
      const n = store.neighbors();
      return dir > 0 ? n.next : n.prev;
    }
    const j = pos + dir;
    return j >= 0 && j < ids.length ? { id: ids[j], index: j } : null;
  }
  /**
   * Next / Prev (a cue is replaced). S1 audit risk 1: while a step is on its way (a GO waiting for its samples, or its
   * switch loading), another step in the same direction is that same request, so a double-tap never skips a song.
   * A step the other way goes from the song on its way (what the GO control and, once it loads, the screen show), so
   * Next then Prev comes back; back onto the playing song before anything started just drops the waiting GO.
   * @param {1|-1} dir
   */
  function stepSong(dir) {
    const way = going || (switching() ? inflight : null);
    if (way && way.dir === dir) return way.promise;
    const t = way ? neighborOf(way, dir) : (dir > 0 ? store.neighbors().next : store.neighbors().prev);
    if (!t) return Promise.resolve(false);
    if (cue) {
      cue = null;
      publishCue();
    }
    if (going && !going.started && isPlaying(t.id, t.index)) {
      dropPendingGo();
      return Promise.resolve(false);
    }
    return goTo(t, dir);
  }
  /**
   * Cue the next / previous entry: from the cue, else from the song on its way (a GO or switch), else from the song
   * that plays. Walking onto the playing song clears the cue.
   * @param {1|-1} dir
   * @returns {boolean} true when a cue is set
   */
  function cueStep(dir) {
    const base = cue || going;
    let t;
    if (base) {
      const ids = store.navIds();
      const pos = entryOf(base.id, base.index).index;
      const j = pos < 0 ? (dir > 0 ? 0 : -1) : pos + dir;
      t = j >= 0 && j < ids.length ? { id: ids[j], index: j } : null;
    } else {
      const n = store.neighbors(); // during a switch the store is at the song on its way
      t = dir > 0 ? n.next : n.prev;
    }
    if (!t) return false;
    return cueSong(t.id, { index: t.index });
  }

  // ---- actions
  /**
   * Next: every Next (the learned `nextSong`, →, ⌘→, the menu, the bus, the global hotkey) GOes the cue when one is
   * set, so it plays the song the GO control shows (DECISIONS O-AW-2, review S-cue-go S5); none cued: the next song
   * (D6, 1.x). A press while the cued GO waits or loads is that same request, so it never lands one past the cue.
   * @returns {Promise<boolean>}
   */
  function nextSong() {
    if (cue && store.getSong(cue.id)) return go();
    return stepSong(1);
  }
  /** Prev: clears a cue (stepSong) and steps back from the song you hear, or from the one on its way (O-AW-2). */
  function prevSong() {
    return stepSong(-1);
  }
  function panic() {
    call('allNotesOff');
    heldBySrc.clear();
    heldCount.clear();
    kbHeld.clear();
    pedalBySrc.clear();
    kbSustain = false;
    pedalDown = false;
    setStatus({ pedal: false });
    buttonState.clear();
    swellActive = false; // round4-controller C8: engine.allNotesOff() drops the swell, so the next toggle starts one
    stopClickForPanic();
    emit('action', { type: 'panic' });
  }
  /**
   * v11-decisions (Ryan 2026-11-03, checklist Q18): Panic also stops the click and any count-in. The metronome's
   * stop sends MIDI clock Stop when clock out is on (engine/metronome.js stop → the clock sink). Only while the click
   * runs, so a Panic without a click calls the engine exactly as before. The engine's 'click' event turns Perform's
   * chip off; the status is set here too, for an engine that reports it late.
   */
  function stopClickForPanic() {
    const st = typeof engine?.clickState === 'function' ? optional('clickState') : null;
    if (!(st && st.running) && !status.click.on) return;
    if (stopClick() && (status.click.on || status.click.counting)) setClickStatus({ on: false, counting: false });
  }
  function fadeOutAll(seconds = 6) {
    call('fadeOutAll', seconds);
    emit('action', { type: 'fadeOutAll', seconds });
  }
  function toggleView() {
    const cur = settings().view;
    if (settings().performLock) {
      if (cur !== 'perform') store.set('settings.view', 'perform');
      emit('action', { type: 'toggleView', blocked: 'performLock' });
      return 'perform';
    }
    const v = cur === 'perform' ? 'edit' : 'perform';
    store.set('settings.view', v);
    return v;
  }
  /** Perform-time transpose ±1 semitone: adjusts Hear-In (and the octave so the step never jumps an octave). */
  function transposeBy(delta) {
    const s = store.currentSong();
    if (!s) return false;
    const total = transposeSemisOf(s) + delta;
    if (total < -18 || total > 17) return false;
    const hear = mod12(s.playIn + total);
    const oct = Math.round((total - transposeSemis(s.playIn, hear)) / 12);
    store.set(`songs.${s.id}.hearIn`, hear);
    store.set(`songs.${s.id}.transposeOctave`, oct);
    return true;
  }
  const transposeUp = () => transposeBy(1);
  const transposeDown = () => transposeBy(-1);
  function swell(start) {
    const s = start === undefined ? !swellActive : !!start;
    swellActive = s;
    call('swell', s);
    emit('action', { type: 'swell', active: s });
    return s;
  }
  async function record() {
    if (!recorder) {
      warn('Recording is not available');
      return null;
    }
    try {
      return await recorder.toggle();
    } catch (err) {
      warn(`recording failed: ${err && err.message}`);
      return null;
    }
  }

  // ---- audio health
  let restarting = false;
  let lastT = null;
  let stuckTicks = 0;
  let suspendedTicks = 0;
  let everRan = false;
  let lastAutoRestart = -Infinity;
  let watchdogTimer = null;

  function setAudio(state) {
    const lat = engine && Number.isFinite(engine.latencyMs) ? engine.latencyMs : status.latencyMs;
    setStatus({ audio: state, latencyMs: lat });
  }

  function stalled() {
    if (status.audio !== 'stalled') {
      setAudio('stalled');
      emit('statechange', { state: 'stalled' });
    }
    if (autoRestart && !restarting && now() - lastAutoRestart > 10000) {
      lastAutoRestart = now();
      restartAudio({ auto: true });
    }
  }

  function tick() {
    if (restarting) return;
    if (memMode) updateMemory();
    const ctx = engine && engine.ctx;
    if (!ctx) return;
    // lowres2: suspended on purpose (audio sleep): not a stall, never resumed here; any input wakes it
    const ss = engine.sleepState;
    if (ss === 'asleep' || ss === 'waking') {
      lastT = null;
      stuckTicks = 0;
      suspendedTicks = 0;
      setAudio('asleep');
      return;
    }
    const st = ctx.state;
    const t = ctx.currentTime;
    if (st === 'running') {
      suspendedTicks = 0;
      if (lastT !== null && t <= lastT) stuckTicks += 1;
      else {
        stuckTicks = 0;
        everRan = true;
      }
      lastT = t;
      if (stuckTicks >= 2) stalled();
      else if (stuckTicks === 0) {
        setAudio('running');
        sleepCheck(); // lowres2: after the state is settled (the engine's 'sleep' event then reports 'asleep')
      }
    } else if (st === 'suspended' || st === 'interrupted') {
      lastT = null;
      stuckTicks = 0;
      suspendedTicks += 1;
      setAudio('suspended');
      try {
        const r = ctx.resume && ctx.resume();
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch {
        /* resume can throw on closed contexts */
      }
      if (everRan && suspendedTicks >= 3) stalled();
    } else if (st === 'closed') {
      stalled();
    }
  }

  /** Stop a running take before/after a restart. @returns {Promise<object|null>} the finished part */
  async function stopForRestart() {
    if (!recorder || !recorder.isRecording) return null;
    try {
      return await recorder.stop();
    } catch (err) {
      warn(`could not finish the recording before restarting audio: ${err && err.message}`);
      return {};
    }
  }
  /** Continue a take that a restart interrupted, in a NEW file (Chrome: browser storage, no dialog). */
  async function resumeRecording(part) {
    if (!recorder || !part) return;
    const saved = part.path || part.filename || 'the first part';
    let r = null;
    try {
      r = await recorder.start(isElectron ? {} : { sink: 'opfs' });
    } catch (err) {
      r = { ok: false, error: err && err.message };
    }
    if (r && r.ok) {
      warn(`Audio restarted, so the recording was split: ${saved} is saved; recording continues in ${r.path || r.filename || 'a new file'}${isElectron ? '' : ' (downloaded when you stop)'}.`);
    } else {
      warn(`Audio restarted and the recording stopped (${saved} is saved). Press Record to start a new take.`);
    }
  }

  /**
   * Everything the engine may have lost in a restart (M1). The engine's own getRuntimeState/applyRuntimeState
   * (if present) already carries the wheels; pads are re-attached unless the new drone already has files.
   */
  function afterRestart() {
    lastT = null;
    stuckTicks = 0;
    suspendedTicks = 0;
    // notes died with the old graph; the pedal is re-sent so a held pedal keeps sustaining
    heldBySrc.clear();
    heldCount.clear();
    kbHeld.clear();
    swellActive = false;
    if (pedalDown) call('sustain', true);
    const engineKeepsWheels = !!(engine && typeof engine.applyRuntimeState === 'function');
    if (!engineKeepsWheels) {
      if (wheelState.expr !== null) call('expression', wheelState.expr);
      if (wheelState.vol !== null) call('volumeCC', wheelState.vol);
      if (wheelState.modOwner === 'virtual' && wheelState.mod !== null) call('setWheel', 'virtual', wheelState.mod);
      else if (wheelState.mod !== null) call('modWheel', wheelState.mod);
    }
    if (settings().monoOutput) call('setMono', true);
    const droneReapplied = restorePads();
    // round4-controller C1: engine.restart() re-applies the song level it captured (transpose, routing, tempo, key,
    // drone) even when its own commit was refused because a song switch committed meanwhile, so it can write the
    // old song's values over the new one. Re-send the applied song's level (the drone only if restorePads didn't);
    // a switch still loading applies its own on commit.
    if (applied) {
      if (!droneReapplied) lastDroneKey = null;
      applySongLevel(live(applied), null, true, { drone: !droneReapplied }); // v11-scenes: with the scene
    }
    setAudio(engine && engine.ctx && engine.ctx.state === 'running' ? 'running' : 'suspended');
  }

  /**
   * Re-attach pad files after a restart, and re-apply a files-mode drone that fell back to the synth.
   * @returns {boolean} true when it re-applied the applied song's drone (key + configure)
   */
  function restorePads() {
    if (!padList.length) return false;
    const d = engine && engine.drone;
    const kept = d && d.files instanceof Map && d.files.size > 0;
    if (kept) return false;
    droneCall('attachFiles', padList);
    const heard = applied ? live(applied) : null; // D26.1: a playing scene may hold the drone's sound
    if (heard && heard.drone && heard.drone.mode === 'files') {
      lastDroneKey = null;
      droneCall('configure', { ...heard.drone, mode: 'off' });
      applyDrone(heard, null, true);
      return true;
    }
    return false;
  }

  /**
   * New AudioContext + graph (engine re-applies its state). A running take is split into a new file. A restart asked
   * for while one runs is not dropped (Settings review item 1, UIB): it runs once more right after, so a buffer /
   * latency pick that lands after the first request went out still reaches the engine. Such a request resolves with
   * the result of that follow-up run (UIB skeptic: it used to resolve false at once, so Settings' "Restart audio"
   * pressed during a restart said "Audio restart failed" while the restart was in fact queued).
   */
  let restartAgain = false;
  let restartAgainOpts = {};
  let restartAgainWaiters = [];
  async function restartAudio(opts = {}) {
    if (secondary) return false;
    if (restarting) {
      restartAgain = true;
      restartAgainOpts = opts; // the latest request's own flags (auto or not) go with the follow-up run
      return new Promise((resolve) => restartAgainWaiters.push(resolve));
    }
    restarting = true;
    setAudio('restarting');
    const part = await stopForRestart();
    const s = settings();
    let ok = true;
    try {
      const r = call('restart', { latency: engineLatency(s), sinkId: s.outputDeviceId && s.outputDeviceId !== 'default' ? s.outputDeviceId : undefined });
      if (r && typeof r.then === 'function') await r;
    } catch (err) {
      ok = false;
      warn(`restarting audio failed: ${err && err.message}`);
    }
    if (ok) {
      afterRestart();
      emit('statechange', { state: 'restarted', auto: !!opts.auto });
      // UIC (UIB review O4): `restarting` stays set until the split take has resumed, so a request in that window is
      // queued (restartAgain) instead of starting a second restart that stops the take being resumed
      try {
        await resumeRecording(part);
      } finally {
        restarting = false;
      }
      if (restartAgain) {
        restartAgain = false;
        const waiters = restartAgainWaiters;
        restartAgainWaiters = [];
        let again = false;
        try {
          again = await restartAudio(restartAgainOpts);
        } finally {
          for (const w of waiters) w(again); // never left pending, even if the follow-up throws
        }
        return again;
      }
    } else {
      restarting = false;
      restartAgain = false; // a failed restart does not chain into another (the user retries, or the watchdog)
      const waiters = restartAgainWaiters;
      restartAgainWaiters = [];
      for (const w of waiters) w(false);
      lastT = null;
      stuckTicks = 0;
      setAudio('stalled');
    }
    return ok;
  }

  /** The engine restarted by itself (e.g. setSinkId fell back to restart()): same recovery as restartAudio. */
  let internalRestart = null;
  function onEngineRestarted() {
    if (restarting || internalRestart) return;
    internalRestart = (async () => {
      afterRestart();
      emit('statechange', { state: 'restarted', auto: true, source: 'engine' });
      const part = await stopForRestart();
      await resumeRecording(part);
    })().finally(() => {
      internalRestart = null;
    });
  }

  // ---- pad files (drone 'files' mode)
  let padList = [];
  /**
   * Hand pad files to the drone. @param {{name:string, url:string}[]} list
   * @returns {{count:number, total:number, unmatched:string[]}} unmatched = names whose key couldn't be read
   */
  function attachPads(list) {
    padList = Array.isArray(list) ? list.filter((f) => f && f.url) : [];
    const n = droneCall('attachFiles', padList);
    const unmatched = padList.filter((f) => !detectKeyFromName(f.name || '')).map((f) => f.name);
    const info = { count: Number.isFinite(n) ? n : padList.length - unmatched.length, total: padList.length, unmatched };
    emit('pads', info);
    return info;
  }
  /**
   * Chrome (ui-edit #5): if the saved pad-folder handle (IndexedDB 'worship-rig-ui'/'handles'/'padFolder', written by
   * settings.js) still has read permission, list it and attach without a prompt. Needs no user gesture.
   * @returns {Promise<object|null>} attachPads() info, or null when nothing was restored
   */
  let ownPadUrls = [];
  async function restoreChromePads() {
    const pf = settings().padFolder;
    if (isElectron || !pf || pf.kind !== 'fsa' || !idbFactory || typeof URL === 'undefined' || !URL.createObjectURL) return null;
    const handle = await new Promise((resolve) => {
      let req;
      try {
        req = idbFactory.open('worship-rig-ui', 1);
      } catch {
        return resolve(null);
      }
      req.onupgradeneeded = () => req.result.createObjectStore('handles'); // same schema as settings.js
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        try {
          const g = db.transaction('handles', 'readonly').objectStore('handles').get('padFolder');
          g.onsuccess = () => {
            db.close();
            resolve(g.result || null);
          };
          g.onerror = () => {
            db.close();
            resolve(null);
          };
        } catch {
          db.close();
          resolve(null);
        }
      };
    });
    if (!handle || typeof handle.queryPermission !== 'function') return null;
    try {
      if ((await handle.queryPermission({ mode: 'read' })) !== 'granted') return null;
      const files = [];
      const walk = async (dir, depth) => {
        for await (const entry of dir.values()) {
          if (entry.kind === 'file' && PAD_EXT_RE.test(entry.name)) files.push({ name: entry.name, file: await entry.getFile() });
          else if (entry.kind === 'directory' && depth < 2 && !entry.name.startsWith('.')) await walk(entry, depth + 1);
        }
      };
      await walk(handle, 0);
      for (const u of ownPadUrls) URL.revokeObjectURL(u);
      ownPadUrls = files.map((f) => URL.createObjectURL(f.file));
      const info = attachPads(files.map((f, i) => ({ name: f.name, url: ownPadUrls[i] })));
      emit('pads-restored', { ...info, name: pf.name || handle.name || null });
      return info;
    } catch (err) {
      warn(`Could not reopen the pad folder: ${err && err.message}`, true);
      return null;
    }
  }

  /** Electron: re-list the chosen pad folder (main.js remembers it) and attach. */
  async function reloadPads() {
    if (!rig || typeof rig.listPads !== 'function') return null;
    const r = await rig.listPads();
    if (!Array.isArray(r)) {
      const error = (r && r.error) || 'unknown';
      warn(error === 'missing' ? 'Pad folder not found — is the drive plugged in? Using the synth drone.' : `Could not read the pad folder: ${error}`);
      return { error };
    }
    return attachPads(r);
  }

  async function resumeAudio() {
    if (secondary) {
      warn(SECONDARY_MESSAGE, true);
      return;
    }
    const r = call('start');
    if (r && typeof r.then === 'function') await r.catch((err) => warn(`audio start failed: ${err && err.message}`));
    noteActivity('resume');
    if (engine && typeof engine.wake === 'function' && (engine.sleepState || 'awake') !== 'awake') await engine.wake();
    const ctx = engine && engine.ctx;
    if (ctx && ctx.state !== 'running' && ctx.resume) await ctx.resume().catch(() => {});
    tick();
  }

  // ---- audio sleep (lowres2; CONTRACT_CHANGES "## lowres2")
  // Input-activity clock: every input (MIDI message or hot-plug, computer key, pointer / wheel anywhere in the app, a
  // bus command, a note from any source) restarts it and wakes a sleeping engine at once (before the note, which the
  // engine queues until the context runs). The watchdog tick puts the engine to sleep (engine.sleep(): 150 ms ramp,
  // ctx.suspend()) once nothing plays, nothing records and there was no input for settings.audioSleepSec (0 = never).
  // lowres2-scope (Ryan 2026-09-30): ONLY inside low-resource mode (lowResEff: settings.lowResource, or auto while
  // hidden in menu-bar mode). The idle window counts from the later of the last input and low-resource turning on;
  // leaving low-resource wakes a sleeping (or ramping-down) engine at once (applyLowResource). In normal play the
  // context never sleeps.
  let lastInputAt = now();
  let lastInputKind = null;
  let lowResSince = -Infinity; // now() when low-resource last turned on
  /**
   * Note an input of any kind (lowres2): restarts the audio-sleep clock and wakes sleeping audio.
   * @param {string} [kind] for debugging ('midi', 'key', 'pointer', 'bus', …)
   */
  function noteActivity(kind = 'input') {
    lastInputAt = now();
    lastInputKind = kind;
    emitActivity(kind);
    optional('noteInput'); // v11-reverb-quiet: reverb builds wait for a pause in any input, not only in notes
    if (secondary || !engine || typeof engine.wake !== 'function') return;
    const ss = engine.sleepState;
    if (ss && ss !== 'awake') {
      const p = optional('wake');
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }
  // idle-cpu-ui: 'activity' for the UI's meter clock, which stops every meter loop at silence and restarts on this.
  // Any input (the lowres2 clock above: notes, keys, pointer, wheel, MIDI, bus commands), a song applied, a song /
  // setlist edit (drone, master, levels), recording on/off and an audio wake. At most one event per ACTIVITY_MS: the
  // meters stay awake ≥ 500 ms after a wake, so a throttled repeat never finds them asleep.
  const ACTIVITY_MS = 50;
  let lastActivityAt = -Infinity;
  const activityNow = () => (globalThis.performance && typeof performance.now === 'function' ? performance.now() : Date.now());
  function emitActivity(kind) {
    const t = activityNow();
    if (t - lastActivityAt < ACTIVITY_MS) return;
    lastActivityAt = t;
    emit('activity', { kind });
  }
  /**
   * Watchdog tick: in low-resource mode only (lowres2-scope), sleep when nothing plays, nothing records and no input
   * came for settings.audioSleepSec since low-resource turned on.
   */
  function sleepCheck() {
    if (secondary || restarting || !engine || typeof engine.sleep !== 'function') return;
    if (!lowResEff) return; // lowres2-scope: normal play never sleeps
    const sec = audioSleepSecOf(settings());
    if (!(sec > 0) || (engine.sleepState || 'awake') !== 'awake') return;
    if (now() - Math.max(lastInputAt, lowResSince) < sec * 1000) return;
    if (status.recording || (recorder && recorder.isRecording)) return;
    const ctx = engine.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const blockers = typeof engine.sleepBlockers === 'function' ? engine.sleepBlockers() : ['unknown'];
    if (blockers && blockers.length) return;
    const p = optional('sleep');
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }
  function onEngineSleep(d) {
    if (d.state === 'asleep') setAudio('asleep');
    else if (d.state === 'awake') {
      emitActivity('wake'); // idle-cpu-ui
      lastInputAt = Math.max(lastInputAt, now()); // keep running ≥ audioSleepSec after any wake
      const ctx = engine && engine.ctx;
      setAudio(ctx && ctx.state === 'running' ? 'running' : 'suspended');
    }
  }
  /** Document-level capture listeners (the renderer's own listeners may stop propagation). */
  function listenInput() {
    const on = (kind) => () => noteActivity(kind);
    listen(doc, 'keydown', on('key'), true);
    listen(doc, 'pointerdown', on('pointer'), true);
    listen(doc, 'wheel', on('wheel'), { capture: true, passive: true });
    if (midi) listen(midi, 'input', (e) => noteActivity((e && e.detail && e.detail.kind) || 'midi'));
  }

  // ---- My Samples (user sample packs served by the local server)
  /**
   * Re-scan "My Samples" (Electron: the server re-reads the folders; Chrome: the manifest is re-fetched) and make the
   * engine load it — engine.reloadManifests() when available, otherwise a 'warn' asks for a restart.
   * @returns {Promise<{count:number|null, reloaded:boolean, errors?:string[], error?:string}>}
   */
  async function rescanUserSamples() {
    let count = null;
    let errors = [];
    try {
      if (rig && typeof rig.rescanUserSamples === 'function') {
        const r = await rig.rescanUserSamples();
        if (r && r.error) throw new Error(r.error);
        count = r && Number.isFinite(r.count) ? r.count : null;
        errors = (r && Array.isArray(r.errors) && r.errors) || [];
      } else if (typeof globalThis.fetch === 'function' && loc && loc.protocol === 'http:') {
        const res = await globalThis.fetch('/api/user-samples/manifest.json', { cache: 'no-store' });
        const j = res.ok ? await res.json() : null;
        count = j && Array.isArray(j.instruments) ? j.instruments.length : null;
        errors = (j && Array.isArray(j.errors) && j.errors) || [];
      }
    } catch (err) {
      warn(`Could not rescan My Samples: ${err && err.message}`);
      return { count: null, reloaded: false, error: (err && err.message) || String(err) };
    }
    let reloaded = false;
    if (!secondary && engine && typeof engine.reloadManifests === 'function') {
      try {
        await engine.reloadManifests();
        reloaded = true;
      } catch (err) {
        warn(`Could not load My Samples: ${err && err.message}`);
      }
    } else if (!secondary) {
      warn(`My Samples: ${count ?? 'the'} instrument${count === 1 ? '' : 's'} found. Restart Worship Rig to load them.`);
    }
    if (errors.length) warn(`My Samples: ${errors.length} problem${errors.length === 1 ? '' : 's'} (${errors[0]}${errors.length > 1 ? ', …' : ''})`);
    const info = { count, reloaded, errors };
    emit('user-samples', info);
    return info;
  }

  // ---- patch packs (2.x step 1, DECISIONS O-AW-PP): <My Samples>/<slug>/songs/*.json, served by the local server
  const PACKS_EMPTY = Object.freeze({
    enabled: false, songs: 0, packs: 0, bankSongs: 0, entries: [], packList: [], errors: [],
  });
  let packsInfo = PACKS_EMPTY;
  let packsReady = Promise.resolve(null);
  let packsBusy = null;
  /** The server's /api/* answer for `rel` (relative to the page, like the engine's manifest URLs), or null. */
  async function localJSON(rel) {
    const res = await globalThis.fetch(new URL(rel, loc.href).href, { cache: 'no-store' });
    return res.ok ? res.json().catch(() => null) : null;
  }
  /**
   * Bank items for the Song bank picker: one per bank-mode entry, with `inLibrary` = the library song id when it is
   * there.
   */
  function bankItems(entries) {
    const inLib = typeof store.packSongs === 'function' ? store.packSongs() : {};
    const out = [];
    for (const e of entries) {
      if (packModeOf(e) !== 'bank') continue;
      const name = e.song && typeof e.song.name === 'string' ? e.song.name : e.file.replace(/\.json$/i, '');
      const bank = normalizeBank(e.bank || {}, name) || { title: name };
      out.push({ packId: e.packId, pack: e.pack, ...bank, inLibrary: inLib[e.packId] || null });
    }
    return out;
  }
  function packsSummary(j) {
    const entries = (j && Array.isArray(j.patches) ? j.patches : []).filter(validPackEntry);
    const packList = j && Array.isArray(j.packs) ? j.packs.filter((p) => p && p.songs > 0) : [];
    return {
      enabled: true,
      songs: entries.length,
      packs: packList.length,
      bankSongs: entries.filter((e) => packModeOf(e) === 'bank').length,
      entries,
      packList,
      errors: (j && Array.isArray(j.errors) ? j.errors : []).filter((x) => typeof x === 'string'),
    };
  }
  /**
   * Read the patch packs and take their auto-mode songs into the library (store.topUpPacks: once each, never over an
   * edit, never after a delete). Asks /api/user-patches only when /api/health advertises it ('user-patches'), so a
   * setup without packs, the native shell (rig://, no such feature yet) and node tests make no request that could
   * fail. A muted second window only reads (its store is read-only).
   * @returns {Promise<{enabled:boolean, songs:number, packs:number, bankSongs:number, added:string[],
   *   updated:string[], kept:string[], skipped:string[], errors:string[], error?:string}>}
   */
  async function rescanPatchPacks() {
    if (packsBusy) return packsBusy;
    packsBusy = (async () => {
      const out = { ...PACKS_EMPTY, added: [], updated: [], kept: [], skipped: [] };
      const web = loc && /^(https?|rig):$/.test(loc.protocol) && typeof globalThis.fetch === 'function';
      if (!web) return out;
      try {
        const h = await localJSON('./api/health');
        const feat = h && Array.isArray(h.features) ? h.features : [];
        const on = !!(h && (h.userPatches === true || feat.includes('user-patches')));
        if (!on) {
          packsInfo = PACKS_EMPTY;
          return out;
        }
        packsInfo = packsSummary(await localJSON('./api/user-patches'));
      } catch (err) {
        warn(`Could not read the patch packs: ${err && err.message}`);
        return { ...out, error: (err && err.message) || String(err) };
      }
      const r = !secondary && typeof store.topUpPacks === 'function' ? store.topUpPacks(packsInfo.entries) : null;
      const res = { ...out, ...packsInfo };
      if (r) Object.assign(res, { added: r.added, updated: r.updated, kept: r.kept, skipped: r.skipped });
      if (r && r.updated.length) packSongsUpdated(r.updated);
      const problems = [...res.errors, ...res.skipped];
      if (problems.length) {
        const n = problems.length;
        warn(`Patch packs: ${n} problem${n === 1 ? '' : 's'} (${problems[0]}${n > 1 ? ', …' : ''})`, true);
      }
      emit('user-patches', res);
      return res;
    })().finally(() => {
      packsBusy = null;
    });
    return packsBusy;
  }
  /**
   * Skeptic PP-1: a pack update in place is not an edit. The selected song's Revert snapshot (`selected`, and
   * Perform's own via the 'packSongsUpdated' action) follows the new version; otherwise Revert wrote the old pack
   * version back, which then read as an edit and froze the song against every later pack update.
   * @param {string[]} ids library song ids topUpPacks updated
   */
  function packSongsUpdated(ids) {
    if (selected && ids.includes(selected.id)) {
      const song = store.getSong(selected.id);
      if (song) selected = { id: selected.id, song };
    }
    // UI6-U7a skeptic F2: so does the Revert snapshot Back brings back for the song a trial replaced (a rescan during
    // a trial); otherwise Revert after Back wrote the old pack version back and froze the song against updates
    const b = trial && trial.prev.baseline;
    if (b && ids.includes(b.id)) {
      const song = store.getSong(b.id);
      if (song) trial.prev = { ...trial.prev, baseline: { id: b.id, song } };
    }
    emit('action', { type: 'packSongsUpdated', ids: ids.slice() });
  }
  /**
   * The last patch-pack read: counts for Settings' "Patch packs" line and the Song bank items (searchBank them).
   * @returns {{enabled:boolean, songs:number, packs:number, bankSongs:number, bank:object[], errors:string[]}}
   */
  function patchPacks() {
    const { entries, ...rest } = packsInfo;
    return { ...rest, bank: bankItems(entries) };
  }
  /**
   * Song bank: add one bank song to the library (store.addPackSong; already there → that song). Views call this.
   * @param {string} packId
   * @param {{select?:boolean}} [o]
   * @returns {{ok:true, id:string, existing?:true}|{ok:false, error:string}}
   */
  function addFromBank(packId, o = {}) {
    const e = packsInfo.entries.find((x) => x.packId === packId);
    if (!e) return { ok: false, error: 'That song is no longer in the Song bank. Press Rescan.' };
    if (secondary) return { ok: false, error: SECONDARY_MESSAGE };
    const r = store.addPackSong(e, o);
    const added = r.ok && !r.existing ? [r.id] : [];
    if (r.ok) emit('user-patches', { ...packsInfo, added, updated: [], kept: [], skipped: [], source: 'bank' });
    return r;
  }

  // ---- Song bank Try it (UI v6 U7a, native DECISIONS D17): a bank song plays as a trial song (store.startTrial),
  // nothing saved; Back selects the song it replaced with that song's own Revert snapshot, Keep adds it (addFromBank)
  // and selects it. Any other song committed (GO, a library row, Program Change) also ends the trial.
  let trial = null; // {id, packId, item, prev:{id, index, baseline:{id, song}|null}, start:object}
  const locked = () => !!settings().performLock;
  /** A bank entry's browsing item (patchPacks().bank's shape) by pack id, or null. */
  const bankItemOf = (packId) => bankItems(packsInfo.entries).find((x) => x.packId === packId) || null;
  /**
   * The trial in progress, or null: {id, packId, title, artist?, pack, key, bpm|null, prev:{id, name}|null}.
   * @returns {object|null}
   */
  /**
   * UI6-U7a skeptic F1: where Back goes: the store's trialReturn() while the trial song is selected (the replaced
   * selection as saved, kept on its setlist entry through list edits; the song after it when it was deleted), else
   * the selection remembered at Try it.
   * @param {object} t the trial
   * @returns {{id:string|null, index:number|undefined}}
   */
  function trialBack(t) {
    const r = typeof store.trialReturn === 'function' ? store.trialReturn() : null;
    return r ? { id: r.id, index: r.index } : { id: t.prev.id, index: t.prev.index };
  }
  function trialInfo() {
    if (!trial || !store.getSong(trial.id)) return null;
    const s = store.getSong(trial.id);
    const back = trialBack(trial).id;
    const prev = back ? store.getSong(back) : null;
    return {
      id: trial.id, packId: trial.packId, title: trial.item ? trial.item.title : s.name,
      artist: trial.item && trial.item.artist, pack: trial.item ? trial.item.pack : null,
      key: keyName(s.hearIn, s.minor), bpm: Number.isFinite(s.tempo) ? s.tempo : null,
      playing: appliedId === trial.id,
      prev: prev ? { id: prev.id, name: prev.name } : null,
    };
  }
  /** applySong committed `id`: trial songs other than it go; the trial ends unless `id` is its song. */
  function trialCommitted(id) {
    if (typeof store.trialIds !== 'function') return;
    for (const t of store.trialIds()) if (t !== id) store.endTrial(t);
    if (trial && trial.id !== id) {
      trial = null;
      emit('trial', null);
    } else if (trial) emit('trial', trialInfo());
  }
  /**
   * Song bank › Try it (D17): play a bank song in place of the current one, as a trial: not added to the library,
   * nothing saved, the library not marked edited (store.startTrial). A second Try it replaces the trial and keeps
   * the first one's way Back. Refused under Perform lock (as Edit and + Add song are) and in a muted second window.
   * @param {string} packId
   * @returns {Promise<{ok:true, id:string} | {ok:false, error:string}>}
   */
  async function tryBankSong(packId) {
    if (locked()) return { ok: false, error: 'perform-locked' };
    if (secondary) return { ok: false, error: SECONDARY_MESSAGE };
    if (typeof store.startTrial !== 'function') return { ok: false, error: 'Try it is not available here.' };
    const e = packsInfo.entries.find((x) => x.packId === packId);
    if (!e || packModeOf(e) !== 'bank') {
      return { ok: false, error: 'That song is no longer in the Song bank. Press Rescan.' };
    }
    const r = store.startTrial(e);
    if (!r.ok) return r;
    const curId = settings().currentSongId;
    const prev = trial ? trial.prev : {
      id: appliedId && !isTrialId(appliedId) ? appliedId : curId,
      index: appliedId && !isTrialId(appliedId) ? appliedIndex : store.currentIndex(),
      baseline: selected && !isTrialId(selected.id) ? { id: selected.id, song: selected.song } : null,
    };
    const before = trial;
    trial = { id: r.id, packId, item: bankItemOf(packId), prev, start: store.getSong(r.id) };
    emit('trial', trialInfo());
    const ok = await selectSong(r.id);
    if (!ok) {
      // superseded (another Try it, a GO) or the load failed: this trial song goes; an earlier trial stays
      if (trial && trial.id === r.id) trial = before && store.getSong(before.id) ? before : null;
      store.endTrial(r.id);
      emit('trial', trialInfo());
      return { ok: false, error: 'The song could not be loaded.' };
    }
    return { ok: true, id: r.id };
  }
  /**
   * UI6-U7a O2 (moved here from views/v6/bank/banner.js, polish batch 2 / UI6-polish1 O2, so every Back follows it,
   * the v6 Perform's destroy on a flag flip included): where Back lands when the replaced song's setlist entry was
   * removed during the trial. The rule: the song it replaced plays again, between the entries around the removed one
   * (the store's "gap": no row lit, Next = the entry that followed it, Prev = the one before), exactly as if the entry
   * had been removed while that song played. selectSong drops a gap (selectSongId), so it is read before Back and put
   * back after it.
   * @returns {{id:string, index:number, list:string|null}|null}
   */
  function trialGap() {
    if (typeof store.trialReturn !== 'function' || typeof store.persisted !== 'function') return null;
    if (!store.trialReturn()) return null; // the trial song is not selected: Back goes to the remembered selection
    const st = store.persisted().settings;
    if (st.setlistGap !== true || !Number.isInteger(st.setlistIndex) || st.setlistIndex < 0) return null;
    return { id: st.currentSongId, index: st.setlistIndex, list: settings().currentSetlistId ?? null };
  }
  /** @param {{id:string, index:number, list:string|null}} g */
  function keepTrialGap(g) {
    const st = settings();
    // only when Back went to that song in the same list (a deleted song: Back went on to the next one, no gap)
    if (st.currentSongId !== g.id || (st.currentSetlistId ?? null) !== g.list) return;
    if (g.index > store.navIds().length) return;
    store.set('settings.setlistIndex', g.index);
    store.set('settings.setlistGap', true);
  }
  /**
   * Back from a trial (the banner's "Back to …"): the song it replaced, at the same setlist entry, with its own
   * Revert snapshot (so Revert after Back is Revert before Try it). Live state is a song switch's: the song's own levels,
   * no scene. Allowed under Perform lock (a way out, like GO). Where it goes: trialBack (skeptic F1); into the gap of a
   * removed entry (trialGap). A trial that began in an empty library (UI6-U8a O1): Back ends it and the library is
   * empty again (nothing selected, as after deleting the last song); before, it said "There is no song to go back
   * to." and the trial stayed.
   * @returns {Promise<{ok:boolean, empty?:true, error?:string}>}
   */
  async function backFromTrial() {
    if (!trial) return { ok: false, error: 'no-trial' };
    const t = trial;
    const gap = trialGap();
    const back = trialBack(t);
    const prevSong = back.id && store.getSong(back.id);
    const target = prevSong ? back.id : store.navIds()[0] || store.get().songOrder[0] || null;
    if (!target) return backToEmpty(t);
    // applySong takes the baseline only for its own song (a deleted previous song: the next one, its own snapshot)
    const ok = await selectSong(target, {
      ...(prevSong && Number.isInteger(back.index) && back.index >= 0 ? { index: back.index } : {}),
      _baseline: prevSong ? t.prev.baseline : null,
    });
    if (ok && gap) keepTrialGap(gap);
    return ok ? { ok: true } : { ok: false, error: 'The song could not be loaded.' };
  }
  /**
   * UI6-U8a O1: no library song to go back to. The trial song is deselected (currentSongId null: the empty library's
   * selection, which the store accepts like any write of it) and removed, and the trial ends. The engine keeps the
   * trial's sound loaded, as it keeps a deleted last song's: the keys still play it until a song is added.
   * @param {object} t the trial
   * @returns {{ok:true, empty:true} | {ok:false, error:string}}
   */
  function backToEmpty(t) {
    if (store.get().songOrder.length) return { ok: false, error: 'There is no song to go back to.' };
    dropPendingGo(); // a GO waiting for a song must not land after Back
    if (store.get().settings.currentSongId === t.id) store.set('settings.currentSongId', null);
    if (isTrialId(store.get().settings.currentSongId)) return { ok: false, error: 'The trial could not be ended.' };
    for (const id of store.trialIds()) store.endTrial(id);
    trial = null;
    targetId = null;
    emit('trial', null);
    return { ok: true, empty: true };
  }
  /**
   * Keep the trial (the banner's "Keep it · add to library"): today's Add to library (addFromBank: the same
   * meta.packSongs record, O-AW-PP rules 3–7), then select it; with `setlistId`, also add it to that setlist
   * (store.addToSetlist) and select that entry when it is the current setlist. What the player changed while trying
   * (levels, sounds, key…) is kept too: it is written over the added song, which is then an edit of it (rule 3).
   * Already in the library: that song is selected and left as it is. Refused under Perform lock.
   * @param {{setlistId?:string}} [o]
   * @returns {Promise<{ok:true, id:string, existing?:true, selected:boolean} | {ok:false, error:string}>}
   */
  async function keepTrial(o = {}) {
    if (!trial) return { ok: false, error: 'no-trial' };
    if (locked()) return { ok: false, error: 'perform-locked' };
    const t = trial;
    const r = addFromBank(t.packId);
    if (!r.ok) return r;
    const cur = store.getSong(t.id);
    if (!r.existing && cur && t.start) {
      // UI6-U7a skeptic F3: a field the player removed while trying (4/4 again: timeSig, a chart) goes too (null
      // removes an optional field); only the changed fields were copied, so the kept song still had it
      for (const k of new Set([...Object.keys(cur), ...Object.keys(t.start)])) {
        if (k === 'id' || k === 'name') continue;
        if (JSON.stringify(cur[k]) === JSON.stringify(t.start[k])) continue;
        store.set(`songs.${r.id}.${k}`, k in cur ? clone(cur[k]) : null);
      }
    }
    let index;
    if (o.setlistId && store.addToSetlist(o.setlistId, r.id) && settings().currentSetlistId === o.setlistId) {
      index = store.navIds().lastIndexOf(r.id);
    }
    const ok = await selectSong(r.id, Number.isInteger(index) && index >= 0 ? { index } : {});
    return { ok: true, id: r.id, ...(r.existing ? { existing: true } : {}), selected: ok };
  }

  // ---- wake lock (Chrome) — Electron uses powerSaveBlocker in main
  let wakeLock = null;
  async function acquireWakeLock() {
    if (isElectron || !nav || !nav.wakeLock || typeof nav.wakeLock.request !== 'function') return;
    if (wakeLock && !wakeLock.released) return;
    try {
      wakeLock = await nav.wakeLock.request('screen');
      setStatus({ wakeLock: true });
      wakeLock.addEventListener?.('release', () => setStatus({ wakeLock: false }));
    } catch (err) {
      warn(`screen wake lock unavailable: ${err && err.message}`, true);
    }
  }

  async function onDeviceChange() {
    emit('devicechange', {});
    const id = settings().outputDeviceId;
    if (id && id !== 'default' && nav && nav.mediaDevices && nav.mediaDevices.enumerateDevices) {
      try {
        const devs = await nav.mediaDevices.enumerateDevices();
        if (!devs.some((d) => d.kind === 'audiooutput' && d.deviceId === id)) warn('The selected audio output was disconnected.');
      } catch {
        /* ignore */
      }
    }
    tick();
  }

  /**
   * midi-default (3): an explicit MIDI input is remembered by id AND name (settings.midiInputName), so a re-plugged
   * keyboard with a new id is still found. The Settings view only writes midiInputId; the name is filled in here.
   * @returns {string|null} the name to match
   */
  function rememberMidiInputName(s) {
    const id = s.midiInputId;
    const auto = !id || id === 'first' || id === 'all';
    let name = auto ? null : s.midiInputName || null;
    if (!auto && midi) {
      const hit = (midi.inputs || []).find((i) => i.id === id);
      if (hit && hit.name) name = hit.name;
    }
    if (!secondary && (s.midiInputName ?? null) !== name) store.set('settings.midiInputName', name);
    return name;
  }

  // ---- 2.0 Sound (native DECISIONS D1, D2, D4)
  // settings.polyphony / voiceLimit → config {polyphony} / {voiceLimit}; settings.bufferFrames →
  // audio {bufferFrames}
  // through restartAudio(), so the song is re-applied and a running take is split like any restart. Only the bridge
  // engine has the setters; the web engine (the 1.x oracle: 16/32 voices, Web Audio's own buffer) must not change.
  const SOUND2_SETTERS = Object.freeze({ polyphony: 'setPolyphony', voiceLimit: 'setVoiceLimit',
    bufferFrames: 'setBufferFrames' });
  const engineTakesSound2 = () => !!engine
    && Object.values(SOUND2_SETTERS).every((n) => typeof engine[n] === 'function');
  function takeAudioConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    const next = { ...status.audioConfig, native: true };
    for (const k of ['polyphony', 'bufferFrames', 'bufferRequested', 'voiceLimit', 'voiceLimitEffective',
      'sampleRate']) {
      if (k in cfg) next[k] = cfg[k] ?? null;
    }
    setStatus({ audioConfig: next });
  }
  /**
   * Send one 2.0 Sound setting to the engine (a no-op on the web engine).
   * @param {'polyphony'|'voiceLimit'|'bufferFrames'} key
   * @param {object} s settings
   * @param {{restart?:boolean}} [o] bufferFrames: restart audio now (false at start-up: engine.start() carries it)
   */
  function applySound2(key, s, { restart = true } = {}) {
    if (secondary || !engineTakesSound2()) return;
    const v = sound2Of(s)[key];
    if (key === 'bufferFrames') {
      optional('setBufferFrames', v, { restart: false }); // recorded synchronously; the restart sends it
      if (restart) restartAudio();
      return;
    }
    const r = optional(SOUND2_SETTERS[key], v);
    if (r && typeof r.then === 'function') {
      r.then(takeAudioConfig, (err) => warn(`engine.${SOUND2_SETTERS[key]} failed: ${err && err.message}`));
    }
  }

  // ---- settings reactions
  function onSetting(key, s) {
    switch (key) {
      case 'polyphony':
      case 'voiceLimit':
      case 'bufferFrames':
        applySound2(key, s);
        break;
      case 'latency':
        restartAudio();
        break;
      case 'outputDeviceId':
        if (engine && typeof engine.setSinkId === 'function') {
          const r = call('setSinkId', s.outputDeviceId === 'default' ? '' : s.outputDeviceId);
          if (r && typeof r.catch === 'function') r.catch((err) => warn(`could not switch output: ${err && err.message}`));
        } else restartAudio();
        break;
      case 'monoOutput':
        call('setMono', !!s.monoOutput);
        break;
      case 'midiInputId':
        if (midi) midi.select(s.midiInputId, rememberMidiInputName(s));
        break;
      case 'pedalInvert':
        reapplyPedalInvert();
        break;
      case 'performLock': // 2.x step 5 (O-AW-ML rule 6): no learning under the lock
        if (s.performLock && midi && midi.learning && typeof midi.cancelLearn === 'function') midi.cancelLearn();
        break;
      case 'keyboards':
        rebuildTouch();
        applyRemembered();
        break;
      case 'dynamicRange':
        call('setDynamicRange', s.dynamicRange ?? 1);
        break;
      case 'droneFreeze': // UIB (DECISIONS D5): the 2.0 engine only; the web engine always freezes in low-resource
        optional('setDroneFreeze', s.droneFreeze !== false);
        break;
      case 'click':
        applyClickSettings(s);
        break;
      case 'midiClockOut':
        applyMidiClock(s);
        break;
      default:
        break;
    }
  }

  // ---- click / metronome + MIDI clock out (v11-metronome)
  const midiClock = createMidiClock({
    getAccess: () => (midi && midi.access) || null,
    getCtx: () => (engine && engine.ctx) || null,
    warn: (m) => warn(m, true),
  });
  function setClickStatus(patch) {
    setStatus({ click: { ...status.click, ...patch } });
  }
  /** settings.click → the engine (level, record the click, output routing). */
  function applyClickSettings(s = settings()) {
    const c = clickSettingsOf(s);
    const r = optional('setClick', { level: c.level, record: c.record, output: c.output });
    if (r && r.output) setClickStatus({ output: r.output });
  }
  /** settings.midiClockOut → the clock sink (attached only while an output is chosen; off by default). */
  function applyMidiClock(s = settings()) {
    const name = typeof s.midiClockOut === 'string' && s.midiClockOut ? s.midiClockOut : null;
    const ok = midiClock.setOutput(name);
    optional('setClockSink', name ? midiClock.sink : null);
    setClickStatus({ midiClock: name, midiClockConnected: ok });
  }
  function onEngineClick(d) {
    if (!d) return;
    setClickStatus({ on: !!d.running, counting: !!d.counting, ...(d.output ? { output: d.output } : {}) });
  }
  /**
   * Start the click on the current song's tempo, with settings.click's count-in. Live-safe: the click is its own
   * transport, so a song switch, held notes and the drone are never touched or delayed.
   * @returns {boolean} started
   */
  function startClick() {
    if (secondary) return false;
    const song = applied && store.getSong(applied.id);
    if (!song || !(Number(song.tempo) > 0)) {
      warn('This song has no tempo yet: set one in Edit › Song (or Quick › Tap) to use the click.', true);
      return false;
    }
    noteActivity('click');
    const c = clickSettingsOf(settings());
    const r = optional('clickStart', { countIn: c.countIn, quietAfter: c.after === 'quiet' });
    if (r) emit('action', { type: 'click', on: true });
    return !!r;
  }
  function stopClick() {
    const r = optional('clickStop');
    if (r) emit('action', { type: 'click', on: false });
    return !!r;
  }
  /** Perform's Click chip. @returns {boolean} the click runs now */
  function toggleClick() {
    const st = typeof engine?.clickState === 'function' ? engine.clickState() : null;
    if (st && st.running) {
      stopClick();
      return false;
    }
    return startClick();
  }

  // ---- backups (Electron)
  let backupTimer = null;
  let lastBackup = -Infinity;
  let lastBackupDone = null; // UI6-U6 skeptic F4: the last backup that was written (lastBackup = the last attempt)
  /** Library JSON tagged with this page's origin (M5: backups from another port can be offered for import). */
  function libraryJSON() {
    const json = store.exportJSON({ pretty: false });
    const origin = loc && loc.origin && loc.origin !== 'null' ? loc.origin : null;
    return origin && json.startsWith('{') ? `{"origin":${JSON.stringify(origin)},${json.slice(1)}` : json;
  }
  async function backupNow() {
    if (!rig || typeof rig.backupNow !== 'function' || secondary) return null;
    // round2-shell #2: an untouched factory seed (e.g. a fallback port's empty origin) is never written: as the
    // newest rotation file it would be offered as "a newer library" on the next normal launch (M5)
    if (store.pristine) return null;
    lastBackup = now();
    try {
      const r = await rig.backupNow(libraryJSON());
      if (r && r.error) warn(`backup failed: ${r.error}`);
      else if (r) lastBackupDone = now();
      return r;
    } catch (err) {
      warn(`backup failed: ${err && err.message}`);
      return null;
    }
  }
  function scheduleBackup(delay) {
    if (!rig || typeof rig.backupNow !== 'function' || backupTimer !== null || secondary) return;
    const wait = delay ?? Math.max(60000, lastBackup + backupIntervalMs - now());
    backupTimer = timers.setTimeout(() => {
      backupTimer = null;
      backupNow();
    }, wait);
  }

  // ---- library safety (H1 / M5 / M7)
  function onStoreInfo(info) {
    const lib = { readOnly: !!info.readOnly, readOnlyReason: info.readOnlyReason || null, persistError: info.persistError || null };
    const prev = status.library;
    setStatus({ library: lib });
    if (lib.persistError && !prev.persistError) warn(`Your changes could not be saved (${lib.persistError}). Retrying — export the library from Settings to be safe.`);
    else if (!lib.persistError && prev.persistError) emit('library-saved', {});
  }
  /** Electron: an unreadable library whose localStorage backup failed goes to disk, then saving resumes. */
  async function secureUnreadableLibrary() {
    const info = store.loadInfo;
    const raw = typeof store.unreadableRaw === 'function' ? store.unreadableRaw() : null;
    if (!raw || !rig || typeof rig.backupNow !== 'function') {
      if (info.readOnly && info.readOnlyReason === 'backup-failed') warn('Your saved library could not be read or backed up, so changes are NOT being saved. Export the library from Settings, then reload.');
      return;
    }
    try {
      const r = await rig.backupNow(raw, 'unreadable');
      if (r && r.path) {
        if (typeof store.allowOverwrite === 'function' && store.allowOverwrite()) warn(`Your saved library could not be read; the original was saved to ${r.path}.`);
        return;
      }
    } catch {
      /* fall through */
    }
    if (info.readOnly) warn('Your saved library could not be read or backed up, so changes are NOT being saved. Export the library from Settings.');
  }
  /** Electron (M5): a newer library backup written from another port (origin) can be imported here. */
  async function checkOtherLibrary() {
    if (!rig || typeof rig.getInfo !== 'function') return;
    let info;
    try {
      info = await rig.getInfo();
    } catch {
      return;
    }
    const other = info && info.otherLibrary;
    if (!other || !other.path) return;
    setStatus({ otherLibrary: other });
    emit('library-offer', other);
    const when = other.savedAt ? new Date(other.savedAt).toLocaleString() : 'recently';
    warn(`A newer library from ${other.origin || 'another address'} (saved ${when}) isn't shown here. Use Settings → Import (backups folder), or Rig menu → Import latest backup.`);
  }
  /**
   * Import the newest disk backup (Electron). Default: replace the library (device settings kept) after backing up
   * the current one first — the backup is a whole library, so merging would duplicate every song. Nothing happens
   * when the file cannot be imported, or when the current (edited) library could not be backed up (E5).
   * Also the native shell's path (RigLibrary.swift: first-launch import, File › Import Library Backup…, AirDrop).
   * One import at a time: a second call while one runs gets the first one's result (E5 skeptic M2).
   * @returns {Promise<{ok:boolean, error?:string, songIds?:string[]}>}
   */
  function importLatestBackup(opts) {
    // E5 skeptic M2: a menu fired twice (or a double click) ran two imports. Each wrote a pre-import backup (the
    // native rotation keeps 3), and in the native shell the second one got latestAnywhere() instead of the staged
    // file (it is served once), so it could replace the picked library with an older backup.
    if (importRunning) return importRunning;
    importRunning = importLatestBackupOnce(opts).finally(() => {
      importRunning = null;
    });
    return importRunning;
  }
  let importRunning = null;
  /** The library content a backup holds (device-local settings are never in one), for M1 below. */
  function backedUpPartsOf(st) {
    const settings = Object.keys(st.settings).filter((k) => !DEVICE_LOCAL_SETTINGS.includes(k))
      .map((k) => st.settings[k]);
    return [st.songs, st.songOrder, st.setlists, st.setlistOrder, ...settings];
  }
  const samePartsAs = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  /**
   * E5: the replaced library must exist somewhere first. A failed backup (disk full, the shell gone, a secondary
   * window) used to go ahead and replace it anyway. (A pristine seed has nothing of the user's in it: callers skip.)
   * E5 skeptic M1: backupNow() serialises the library, then waits for the shell to write it. An edit in that wait
   * (a MIDI fader, a scene, a menu-bar command) was in neither the backup nor the imported library. Back up again
   * until a backup holds the library as it is when it is replaced (the parts are frozen, so === is exact).
   * @returns {Promise<{ok:true} | {ok:false, error:'backup failed'}>}
   */
  async function backUpBeforeReplace() {
    let saved = null;
    let settled = false;
    for (let i = 0; i < 3 && !settled; i++) {
      const parts = backedUpPartsOf(store.get());
      saved = await backupNow();
      if (!saved || saved.error || !saved.path) break;
      settled = samePartsAs(parts, backedUpPartsOf(store.get()));
    }
    if (!saved || saved.error || !saved.path) {
      warn('Your current library could not be backed up first, so it was not replaced. Export it from Settings, '
        + 'then try again.');
      return { ok: false, error: 'backup failed' };
    }
    if (!settled) {
      warn('Your library kept changing while it was being backed up, so it was not replaced. Try again.');
      return { ok: false, error: 'backup failed' };
    }
    return { ok: true };
  }
  /**
   * D8: the libraries this browser profile keeps for "Restore previous library…" (store.keptLibraries), newest first.
   * @param {{check?:boolean}} [opts] check:false skips the per-copy restore check (restorable/error left out)
   * @returns {object[]}
   */
  function listPreviousLibraries(opts) {
    return typeof store.keptLibraries === 'function' ? store.keptLibraries(opts) : [];
  }
  /**
   * D8: replace the library with a kept copy (Settings › Restore previous library…). E5 rules: the file is checked
   * first; an edited library is backed up first (the shell's disk backup where there is one, then always a kept copy
   * in this profile, taken in the same task as the replace so it is exact), and nothing is replaced when that fails.
   * One import at a time: it shares importLatestBackup's single-flight guard (E5 skeptic M2).
   * @param {string} key a key from listPreviousLibraries()
   * @returns {Promise<{ok:boolean, error?:string, songIds?:string[], keptKey?:string}>}
   */
  function restorePreviousLibrary(key) {
    if (importRunning) return importRunning;
    importRunning = restorePreviousLibraryOnce(key).finally(() => {
      importRunning = null;
    });
    return importRunning;
  }
  async function restorePreviousLibraryOnce(key) {
    if (typeof store.restoreKept !== 'function') return { ok: false, error: 'not available' };
    if (secondary || store.loadInfo.readOnly) {
      warn('This window is not saving changes, so the library was not replaced.');
      return { ok: false, error: 'read-only' };
    }
    const check = store.restoreKept(key, { dryRun: true });
    if (!check.ok) {
      warn(`Restore failed: ${check.error}`);
      return check;
    }
    let keptKey = null;
    if (!store.pristine) {
      if (rig && typeof rig.backupNow === 'function') {
        const saved = await backUpBeforeReplace();
        if (!saved.ok) return saved;
      }
      // D8 skeptic K1: making room for this copy must never remove the copy being restored
      const kept = store.keepCurrent('restore', { protect: key });
      if (!kept.ok) {
        warn('Your current library could not be kept first, so it was not replaced. Export it from Settings, '
          + 'then try again.');
        return { ok: false, error: 'backup failed' };
      }
      keptKey = kept.key;
    }
    const r = store.restoreKept(key);
    if (r.ok) emit('action', { type: 'restoreLibrary', key, songs: r.songIds.length, keptKey });
    else warn(`Restore failed: ${r.error}`);
    return keptKey && r.ok ? { ...r, keptKey } : r;
  }
  /**
   * D8 (review E5 M4): 1.x in the same Chrome profile set a 2.0 library aside and seeded the factory songs. Opened
   * here, that seed is pristine; say once where the 2.0 library is.
   */
  function offerSetAsideLibrary() {
    if (!store.pristine || typeof store.keptLibraries !== 'function') return;
    const set = store.keptLibraries().find((e) => e.kind === 'downgrade' && e.schema === SCHEMA && e.restorable);
    if (!set) return;
    const when = set.savedAt ? new Date(set.savedAt).toLocaleString() : 'earlier';
    warn(`Your Worship Rig 2.0 library (${set.songs} songs, from ${when}) was set aside by Worship Rig 1.x. To get it `
      + 'back, open Settings › Library & backups › Restore previous library….', true);
  }
  // ---- D11: the 1.x device-local settings of a 1.1.1 backup / export (`deviceSettings` block)
  /**
   * D11: a backup from this computer's own backups folders, not a file someone picked or sent. The native shell says
   * how it got the file (`via`: 'backups' = its own or the Electron app's folder, 'first-launch' = the first-launch
   * import of that folder, 'picked' = File › Import Library Backup… / AirDrop / Open in). Electron's main.js only
   * ever serves its own backups folder.
   * @param {object} b a latestBackup() payload
   * @returns {boolean}
   */
  function backupFromThisMachine(b) {
    // D11 skeptic DS2: 1.1.1 never runs on an iPad, so a block there always came from another computer (and the
    // iPad's Backups folder is open to Files: anything can be dropped into it)
    if (rig && rig.platform === 'ipados') return false;
    if (b && typeof b.via === 'string') return b.via === 'backups' || b.via === 'first-launch';
    return isElectron;
  }
  /**
   * D11: what a device block holds, for Settings › Import… (the checkbox is ticked only for this computer's block).
   * @param {*} raw the block (importJSON's `result.deviceSettings`)
   * @returns {{ok:boolean, sameMachine:boolean, keys:string[], dropped:string[]}}
   */
  function inspectDeviceSettings(raw) {
    const d = readDeviceSettings(raw);
    if (!d) return { ok: false, sameMachine: false, keys: [], dropped: [] };
    const markers = typeof store.machineMarkers === 'function' ? store.machineMarkers() : [];
    return { ok: true, sameMachine: d.install !== null && markers.includes(d.install), keys: Object.keys(d.settings),
      dropped: d.dropped };
  }
  /** D11: plain words for a skipped device selection (one line lists them all). */
  function deviceLabel(k, v) {
    if (k === 'midiInputId') return v ? `the MIDI input "${v}"` : 'the MIDI input';
    if (k === 'midiClockOut') return `the MIDI clock output "${v}"`;
    if (k === 'outputDeviceId') return 'the audio output';
    return 'the My Pads folder';
  }
  /**
   * D11: fill in this machine's unset device-local settings from a 1.1.1 block. Every value goes through the store's
   * validators (unknown and invalid ones are dropped, with one warning); a setting already set here is never changed
   * (store.applyDeviceSettings decides at write time). Device selections apply only if found here: the MIDI input
   * (by name, then id) and the clock output among the connected ports, the audio output among enumerateDevices(),
   * an Electron pad folder only when it is the folder the shell serves now (getInfo().padsRoot); an FSA pad folder
   * never (its handle belongs to the origin that picked it). Missing ones are skipped with one line.
   * @param {*} raw the block
   * @param {{sameMachine?:boolean}} [o] sameMachine: remember the block's marker as this computer's
   * @returns {Promise<{ok:boolean, error?:string, applied:string[], kept:string[], skipped:string[],
   *   dropped:string[]}>}
   */
  async function applyDeviceSettings(raw, { sameMachine = false } = {}) {
    const res = { ok: false, applied: [], kept: [], skipped: [], dropped: [] };
    const d = readDeviceSettings(raw);
    if (!d) {
      warn('The device settings saved with that library could not be read, so none were used.');
      return { ...res, error: 'unreadable' };
    }
    if (secondary || store.loadInfo.readOnly) {
      warn('This window is not saving changes, so the saved device settings were not used.');
      return { ...res, error: 'read-only' };
    }
    res.dropped = d.dropped.slice();
    const values = { ...d.settings };
    const cur = settings();
    const touched = typeof store.deviceSettingsTouched === 'function' ? store.deviceSettingsTouched() : null; // DS1
    const missing = [];
    const skip = (keys, label) => {
      for (const k of keys) delete values[k];
      res.skipped.push(keys[0]);
      missing.push(label);
    };
    // a selection this machine already has is kept as it is, and needs no check (and no note)
    for (const k of DEVICE_SELECTIONS) {
      if (k in values && !deviceSettingUnset(cur, k, touched)) {
        delete values[k];
        if (k !== 'midiInputName') res.kept.push(k);
      }
    }
    if ('midiInputId' in values || 'midiInputName' in values) {
      const id = values.midiInputId;
      const name = values.midiInputName || null;
      delete values.midiInputId;
      delete values.midiInputName;
      if (id === 'all') values.midiInputId = 'all';
      else if (id && id !== 'first') {
        const live = ((midi && midi.inputs) || []).filter((i) => i.state !== 'disconnected');
        const hit = (name && live.find((i) => i.name === name)) || live.find((i) => i.id === id);
        if (hit) {
          values.midiInputId = hit.id; // this app's id for the device (ids differ between apps)
          values.midiInputName = hit.name;
        } else skip(['midiInputId'], deviceLabel('midiInputId', name));
      }
    }
    if (typeof values.midiClockOut === 'string') {
      const outs = (typeof midiClock.outputs === 'function' ? midiClock.outputs() : []) || [];
      if (!outs.some((o) => o.name === values.midiClockOut && o.state !== 'disconnected')) {
        skip(['midiClockOut'], deviceLabel('midiClockOut', values.midiClockOut));
      }
    }
    if (typeof values.outputDeviceId === 'string' && values.outputDeviceId !== 'default') {
      let found = false;
      try {
        const md = nav && nav.mediaDevices;
        const devs = md && typeof md.enumerateDevices === 'function' ? await md.enumerateDevices() : [];
        found = devs.some((x) => x.kind === 'audiooutput' && x.deviceId === values.outputDeviceId);
      } catch {
        found = false;
      }
      if (!found) skip(['outputDeviceId'], deviceLabel('outputDeviceId'));
    }
    if (values.padFolder) {
      const pf = values.padFolder;
      let found = false;
      if (pf.kind === 'electron' && rig && typeof rig.getInfo === 'function') {
        try {
          const info = await rig.getInfo();
          found = !!info && typeof info.padsRoot === 'string' && info.padsRoot === pf.path;
        } catch {
          found = false;
        }
      }
      if (!found) skip(['padFolder'], deviceLabel('padFolder'));
    }
    const w = store.applyDeviceSettings(values);
    res.applied = w.applied;
    res.kept.push(...w.kept);
    res.dropped.push(...w.dropped);
    res.ok = true;
    if (res.dropped.length) {
      warn(`Some saved device settings were not valid here and were left out: ${res.dropped.join(', ')}.`);
    }
    if (missing.length) {
      warn(`Not found on this computer, so left as they are: ${missing.join(', ')}. You can choose them in Settings.`);
    }
    if (sameMachine && d.install && typeof store.rememberMachineMarker === 'function') {
      store.rememberMachineMarker(d.install);
    }
    emit('action', { type: 'deviceSettings', applied: res.applied.slice(), skipped: res.skipped.slice() });
    return res;
  }
  async function importLatestBackupOnce({ replace = true } = {}) {
    if (!rig || typeof rig.latestBackup !== 'function') return { ok: false, error: 'not available' };
    const b = await rig.latestBackup();
    if (!b || b.error || typeof b.text !== 'string') return { ok: false, error: (b && b.error) || 'no backup found' };
    // E5: check the file first. A truncated / unreadable / newer-schema backup used to be "backed up over": each
    // failed try wrote one more rotation file, and the rotation (main.js 10, the native shell 3) then deleted the
    // oldest good backups. Now a file that cannot be imported changes nothing, on disk or in the library.
    const check = store.importJSON(b.text, { replace, dryRun: true });
    if (!check.ok) {
      warn(`Import failed: ${check.error}`);
      return check;
    }
    if (replace && !store.pristine) {
      const saved = await backUpBeforeReplace();
      if (!saved.ok) return saved;
    }
    const r = store.importJSON(b.text, { replace });
    if (r.ok) {
      setStatus({ otherLibrary: null });
      emit('action', { type: 'importBackup', path: b.path, songs: r.songIds.length });
      // D11: a 1.1.1 backup from this computer's backups folder brings its device settings (unset ones only); a
      // file that was picked or sent may come from another computer, so it is only offered (Settings › Import…)
      if (r.deviceSettings !== undefined) {
        const block = r.deviceSettings;
        delete r.deviceSettings;
        if (backupFromThisMachine(b)) r.device = await applyDeviceSettings(block, { sameMachine: true });
        else {
          r.device = { ok: false, error: 'other machine', applied: [], kept: [], skipped: [], dropped: [] };
          warn('That backup also holds the device settings (MIDI, audio, pads) of the computer it came from. They '
            + 'were not used. To choose, import the file with Settings › Library & backups › Import….');
        }
      }
    } else warn(`Import failed: ${r.error}`);
    return r;
  }

  // ---- store subscription
  function onStore(state, paths) {
    if (store.generation !== seenGeneration) {
      // round2-shell #3: the library was swapped (import replace / reload). Song ids survive it, so the revert
      // snapshot would otherwise restore the pre-import song over the imported one.
      seenGeneration = store.generation;
      const song = selected && store.getSong(selected.id);
      selected = song ? { id: selected.id, song } : null;
    }
    let navChanged = false;
    let entityChanged = false;
    let libraryChanged = false;
    for (const p of paths) {
      if (p.startsWith('settings.')) {
        const k = p.split('.')[1];
        onSetting(k, state.settings);
        if (k === 'currentSetlistId') navChanged = true;
      } else if (p.startsWith('setlists.') || p === 'songOrder') {
        navChanged = true;
        entityChanged = true;
      } else if (p.startsWith('songs.')) {
        entityChanged = true;
        if (!isTrialId(p.split('.')[1])) libraryChanged = true;
      }
    }
    // U7a: a trial song is never backed up, so a write to it alone does not schedule one
    if (entityChanged && (libraryChanged || paths.some((p) => !p.startsWith('songs.')))) scheduleBackup();
    const cur = state.settings.currentSongId;
    // idle-cpu-ui: an edit of the current song (drone, master, levels, key) may make sound; background writes to other
    // songs (preload bookkeeping, imports) must not wake the meters
    if (cur && entityChanged && paths.some((p) => p.startsWith(`songs.${cur}.`))) emitActivity('edit');
    if (navChanged) dropStaleCue(); // S-review S1: before a selectSong below, which would also drop a waiting GO
    if (cur && cur !== targetId) {
      selectSong(cur, { index: state.settings.setlistIndex });
    } else if (cur && cur === appliedId && targetId === appliedId) {
      const song = state.songs[cur];
      if (song && song !== applied) applyDiff(applied, song);
    }
    if (navChanged && started) preloadSetlist();
  }

  // ---- menu (Electron)
  function onMenu(id) {
    switch (id) {
      case 'panic':
        return panic();
      case 'fadeOutAll':
        return fadeOutAll();
      case 'nextSong':
        return nextSong();
      case 'prevSong':
        return prevSong();
      case 'toggleView':
        return toggleView();
      case 'record':
        return record();
      case 'restartAudio':
        return restartAudio();
      case 'importLatestBackup':
        return importLatestBackup();
      case 'rescanUserSamples':
        return rescanUserSamples();
      case 'popoverShown':
      case 'popoverHidden':
        // lowres2-critic R2: the menu-bar popover opening is not the main window showing; it must not end
        // low-resource (no thaw, no wake). Recorded for status only. Electron main should send these for the
        // popover (never windowShown / rig:window-visible).
        setStatus({ popoverOpen: id === 'popoverShown' });
        return undefined;
      default:
        emit('menu', { id });
        return undefined;
    }
  }

  // ---- lifecycle
  let started = false;
  const cleanups = [];
  function listen(target, type, fn, opts) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  /**
   * Wire everything up and select the current song. Never throws.
   * @returns {Promise<void>}
   */
  // ---- single instance (H2)
  let releaseLock = null;
  /** @param {boolean} wait false = {ifAvailable:true} @returns {Promise<boolean>} granted */
  function requestInstanceLock(wait) {
    if (!locks || typeof locks.request !== 'function') return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      try {
        const p = locks.request(INSTANCE_LOCK, wait ? { mode: 'exclusive' } : { ifAvailable: true }, (lock) => {
          if (!lock) {
            done(false);
            return undefined;
          }
          done(true);
          return new Promise((release) => {
            releaseLock = release; // held until dispose() / page unload
          });
        });
        if (p && typeof p.catch === 'function') p.catch(() => done(true));
      } catch {
        done(true); // no usable Web Locks: behave as before
      }
    });
  }
  function enterSecondary() {
    secondary = true;
    if (typeof store.setReadOnly === 'function') store.setReadOnly(true, 'second-window');
    setStatus({ instance: 'secondary', instanceMessage: SECONDARY_MESSAGE });
    emit('instance', { instance: 'secondary', message: SECONDARY_MESSAGE });
    warn(SECONDARY_MESSAGE);
    // take over when the other window goes away
    requestInstanceLock(true).then((granted) => {
      if (!granted) return;
      if (!started) {
        // round4-controller C13: disposed while waiting; hold nothing, or no other window could ever take over
        if (releaseLock) releaseLock();
        releaseLock = null;
        return;
      }
      secondary = false;
      // round4-controller C7: songs tapped while muted recorded what the (never started) engine "has"; forget it so
      // the first selectSong sends the key, drone and song level to the fresh engine
      applied = null;
      appliedId = null;
      targetId = null;
      lastDroneKey = null;
      if (typeof store.reload === 'function') store.reload(); // pick up what the other window saved
      // round4-controller C6: deliver the reload diff now, before startPrimary() subscribes onStore. Otherwise it
      // arrives while engine.start() is pending ('latency' → engine.restart() on a context still initialising, and
      // a second selectSong). startPrimary applies the current settings itself; the latency the engine was built
      // with is only read when it starts, so set it here (the engine has never started in this window).
      if (typeof store.flush === 'function') store.flush();
      if (engine && typeof engine.latency !== 'undefined') engine.latency = engineLatency(settings());
      if (typeof store.setReadOnly === 'function') store.setReadOnly(false);
      setStatus({ instance: 'primary', instanceMessage: null });
      emit('instance', { instance: 'primary', message: null });
      startPrimary().catch((err) => warn(`start failed: ${err && err.message}`));
    });
  }

  // ---- heartbeat (Chrome): lets serve.mjs see that a window is open
  let heartbeatTimer = null;
  function heartbeat() {
    if (!heartbeatOn || secondary) return;
    try {
      const r = globalThis.fetch('/api/heartbeat', { cache: 'no-store' });
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch {
      /* ignore */
    }
  }

  /** Electron quit hook (main.js asks before closing: recording? + a last library backup). */
  function installShellHook() {
    if (!isElectron || typeof globalThis !== 'object') return;
    globalThis.__rigShell = {
      recording: () => !!(recorder && recorder.isRecording),
      library: () => (secondary || store.pristine ? null : libraryJSON()), // round2-shell #2 (see backupNow)
    };
  }

  /**
   * Wire everything up and select the current song. Never throws.
   * @returns {Promise<void>}
   */
  async function start() {
    if (started) return;
    started = true;
    if (typeof store.onInfo === 'function') {
      cleanups.push(store.onInfo(onStoreInfo));
      onStoreInfo(store.loadInfo);
    }
    // D8/D9: the store's notices (a library past the size cap, kept copies removed for space) are toasted
    if (typeof store.onNotice === 'function') cleanups.push(store.onNotice((n) => n && n.message && warn(n.message)));
    if (!(await requestInstanceLock(false))) {
      enterSecondary();
      return;
    }
    await startPrimary();
  }

  async function startPrimary() {
    cleanups.push(store.subscribe(onStore));
    if (typeof store.onSlotMap === 'function') cleanups.push(store.onSlotMap(onSlotMap)); // D23
    if (midi) for (const [type, fn] of Object.entries(midiHandlers)) listen(midi, type, fn);
    // v11-metronome: a re-plugged clock output is found again by name
    if (midi) {
      listen(midi, 'devices', () => {
        if (!midiClock.name) return;
        const ok = midiClock.resolve();
        if (ok !== status.click.midiClockConnected) setClickStatus({ midiClockConnected: ok });
      });
    }
    listenInput(); // lowres2: before the note handlers, so a waking key / MIDI note wakes the audio first
    listen(doc, 'keydown', onKeyDown);
    listen(doc, 'keyup', onKeyUp);
    listen(doc, 'visibilitychange', onVisibility);
    listen(win, 'blur', onBlur);
    if (nav && nav.mediaDevices) listen(nav.mediaDevices, 'devicechange', onDeviceChange);
    if (engine) {
      listen(engine, 'statechange', (e) => {
        const d = e.detail || {};
        if (Number.isFinite(d.latencyMs)) setStatus({ latencyMs: d.latencyMs });
        if (d.restarted || d.reason === 'restart') onEngineRestarted();
      });
      listen(engine, 'wheel', (e) => onEngineWheel(e.detail));
      listen(engine, 'sleep', (e) => onEngineSleep(e.detail || {})); // lowres2
      listen(engine, 'click', (e) => onEngineClick(e.detail)); // v11-metronome
      listen(engine, 'audioconfig', (e) => takeAudioConfig(e.detail)); // 2.0 Sound: granted buffer, Auto's limit
      for (const type of ['wheel', 'notes', 'chord', 'loading', 'ready']) listen(engine, type, (e) => emit(type, e.detail));
      listen(engine, 'warn', (e) => emit('warn', { message: (e.detail && e.detail.message) || String(e.detail), source: 'engine' }));
    }
    if (recorder) {
      listen(recorder, 'state', (e) => {
        setStatus({ recording: e.detail.state === 'recording' });
        emitActivity('record'); // idle-cpu-ui
      });
    }
    if (rig && typeof rig.onMenu === 'function') {
      const off = rig.onMenu(onMenu);
      if (typeof off === 'function') cleanups.push(off);
    }
    installShellHook();
    const libInfo = store.loadInfo;
    if (libInfo.status === 'corrupt' || libInfo.status === 'future-schema') secureUnreadableLibrary();
    offerSetAsideLibrary(); // D8

    if (engineTakesSound2()) {
      setStatus({ audioConfig: { ...status.audioConfig, native: true } });
      applySound2('bufferFrames', settings(), { restart: false }); // 2.0 D2: the first start asks for it
    }
    const r = call('start');
    if (r && typeof r.then === 'function') await r.catch((err) => warn(`audio start failed: ${err && err.message}`));
    const s = settings();
    applySound2('polyphony', s); // 2.0 D1 / D4 (no-ops on the web engine)
    applySound2('voiceLimit', s);
    if (s.monoOutput) call('setMono', true);
    if (s.dynamicRange) call('setDynamicRange', s.dynamicRange); // absent = 1, the engine's default
    if (s.droneFreeze === false) optional('setDroneFreeze', false); // UIB (D5): absent = on, the 2.0 engine's default
    if (s.click) applyClickSettings(s); // v11-metronome: absent = the defaults the engine already has
    if (s.outputDeviceId && s.outputDeviceId !== 'default' && engine && typeof engine.setSinkId === 'function') {
      const sr = call('setSinkId', s.outputDeviceId);
      if (sr && typeof sr.catch === 'function') sr.catch((err) => warn(`could not select the saved output: ${err && err.message}`));
    }
    startMidi();
    if (rig && typeof rig.listPads === 'function') await reloadPads().catch((err) => warn(`pad folder: ${err && err.message}`));
    else await restoreChromePads().catch(() => null);
    // O-AW-PP: patch packs are read in the background (pack songs go to the end of the library, so the first song
    // never waits for them); packsReady settles when they are in
    packsReady = rescanPatchPacks().catch(() => null);
    startMenubar(); // menubar-A: bus + low-resource state before the first song and preload
    const cur = store.currentSong();
    if (cur) await selectSong(cur.id, { index: s.setlistIndex });
    preloadSetlist();
    tick();
    watchdogTimer = timers.setInterval(tick, watchdogMs);
    acquireWakeLock();
    if (rig && typeof rig.backupNow === 'function') scheduleBackup(30000);
    if (isElectron) checkOtherLibrary();
    if (heartbeatOn) {
      heartbeat();
      heartbeatTimer = timers.setInterval(heartbeat, HEARTBEAT_MS);
    }
    // L-3: MIDI is deliberately NOT awaited here. requestMIDIAccess can stay pending for as long as Chrome's
    // permission prompt is unanswered (or CoreMIDI init stalls, local-findings L-3), and start() / __rig.ready must
    // settle once audio + song are up. MIDI reports through status.midi and the 'status' event; see midiReady().
  }

  // ---- MIDI init (L-3): concurrent with start(), soft timeout, late answers still wire the inputs up
  let midiPromise = Promise.resolve(false);
  let midiTimer = null;
  let midiGen = 0; // bumped by dispose(): a late answer from a disposed start must not re-attach inputs
  function startMidi() {
    if (!midi) return;
    const gen = ++midiGen;
    let settled = false;
    const clearSoft = () => {
      settled = true;
      if (midiTimer !== null) timers.clearTimeout(midiTimer);
      midiTimer = null;
    };
    applyRemembered(); // v11-touch: known before init() attaches, so the first resolution already prefers them
    midiPromise = (midi.access ? Promise.resolve(true) : midi.init())
      .then((ok) => {
        clearSoft();
        if (gen !== midiGen) return false;
        midi.select(settings().midiInputId, rememberMidiInputName(settings()));
        if (settings().midiClockOut) applyMidiClock(); // v11-metronome: the output list exists from here on
        return ok !== false && !!midi.available;
      })
      .catch((err) => {
        clearSoft();
        if (gen === midiGen) warn(`MIDI init failed: ${err && err.message}`);
        return false;
      });
    if (midiInitTimeoutMs > 0 && !midi.access) {
      midiTimer = timers.setTimeout(() => {
        midiTimer = null;
        if (settled || gen !== midiGen || midi.available) return;
        // Still waiting (permission prompt open, CoreMIDI slow): say so and keep listening for the answer.
        setStatus({ midi: { ...status.midi, available: false, connected: false, reason: 'pending', pending: true } });
      }, midiInitTimeoutMs);
    }
  }

  /**
   * L-3: settles when the current MIDI init has an answer (true = access granted and inputs selected, false =
   * unavailable / no MIDI). It may stay pending indefinitely (unanswered permission prompt), so bound any wait on it.
   * @returns {Promise<boolean>}
   */
  function midiReady() {
    return midiPromise;
  }

  function dispose() {
    goSeq++; // Lane S: a GO still waiting for its song never switches after dispose
    if (going && going.timer !== null) timers.clearTimeout(going.timer); // S-review S2
    going = null;
    for (const w of warmTimers) if (w.timer !== null) timers.clearTimeout(w.timer); // S-review S8
    warmTimers.clear();
    dropLearnWrites(); // 2.x step 5: a throttled knob write never lands after dispose
    cueDisposed = true;
    for (const c of cleanups.splice(0)) {
      try {
        c();
      } catch {
        /* ignore */
      }
    }
    if (watchdogTimer !== null) timers.clearInterval(watchdogTimer);
    watchdogTimer = null;
    if (backupTimer !== null) timers.clearTimeout(backupTimer);
    backupTimer = null;
    if (mixTimer !== null) timers.clearTimeout(mixTimer); // D26.1
    mixTimer = null;
    mixGlides.clear();
    if (lowResGcTimer !== null) timers.clearTimeout(lowResGcTimer);
    lowResGcTimer = null;
    if (heartbeatTimer !== null) timers.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    midiGen++;
    if (midiTimer !== null) timers.clearTimeout(midiTimer);
    midiTimer = null;
    if (wakeLock && !wakeLock.released) wakeLock.release?.().catch?.(() => {});
    if (releaseLock) releaseLock();
    releaseLock = null;
    if (globalThis.__rigShell && isElectron) delete globalThis.__rigShell;
    started = false;
  }

  // ---- MIDI learn
  /**
   * MIDI Learn (M2): faders take only a moving continuous CC; buttons take a note-on or a switch-CC press.
   * The sustain pedal (CC64) is reserved: resolves {error:'sustain-pedal-reserved'} and nothing is saved.
   * 2.x step 5 (O-AW-ML): `controlId` is a fixed Learn row or any continuous PARAMS path (else
   * {error:'not-learnable'}); re-learning a path keeps its min / max / invert. Under Perform Lock nothing is learned
   * ({error:'perform-locked'}; turning the lock on cancels a pending learn): the lock keeps the rig as it is, while
   * learned controls still play.
   * C1: mappings the new one would sit behind or in front of (a button sharing the control) are cleared and listed in
   * `replaced` (absent when none).
   * @returns {Promise<{cc?:number, note?:number, channel:number, replaced?:string[]}|{error:string}|null>} null =
   *   timeout / cancelled
   */
  async function learn(controlId, o = {}) {
    const { heard, ...lo } = o || {};
    if (!heard && (!midi || typeof midi.learn !== 'function')) return null;
    if (settings().performLock) return { error: 'perform-locked' };
    if (!isLearnable(controlId) && !isLearnablePath(controlId)) return { error: 'not-learnable' };
    const accept = isButtonControl(controlId) ? 'button' : 'fader';
    // UI v6 U7c (MIDI Learn on Perform): the knob can come first. `heard` = a control learnCapture() already took;
    // it is checked as midi.learn would have checked it for this kind of target, then stored the same way
    const res = heard ? heardFor(heard, accept) : await midi.learn(controlId, { ...lo, accept });
    if (!res) return null;
    if (settings().performLock) return { error: 'perform-locked' };
    if (res.error) return { error: res.error, cc: res.cc, channel: res.channel };
    const prev = (settings().midiLearn || {})[controlId] || {};
    const range = {};
    for (const k of ['min', 'max', 'invert']) if (prev[k] !== undefined) range[k] = prev[k];
    const mapping = res.cc !== undefined ? { cc: res.cc, channel: res.channel, ...range }
      : { note: res.note, channel: res.channel };
    // skeptic midi-learn-any C1: a CC / note is either one button or any number of faders (O-AW-ML rule 4 reads the
    // first mapping). A learn that would share it across kinds, or with another button, would sit dead behind the
    // first one while the UI said it was learned, so the learn takes the control: those mappings are cleared.
    const replaced = conflictsOf(controlId, mapping);
    for (const id of replaced) store.setMidiLearn(id, null);
    store.setMidiLearn(controlId, mapping); // (false when the same mapping is learned again: nothing changed)
    pickups.delete(controlId);
    return replaced.length ? { ...mapping, replaced } : mapping;
  }
  /**
   * UI v6 U7c: a control learnCapture() took, checked for a target of kind `accept` with midi.js's own rules: a fader
   * takes a CC that is not a pedal switch (CC64 is never learnable); a button takes a note or a CC.
   * @param {{cc?:number, note?:number, channel?:number|null}} h
   * @param {'fader'|'button'} accept
   * @returns {{cc?:number, note?:number, channel:number|null}|{error:string, cc?:number, channel?:number|null}|null}
   */
  function heardFor(h, accept) {
    const ch = Number.isInteger(h && h.channel) && h.channel >= 0 && h.channel < 16 ? h.channel : null;
    const int7 = (x) => Number.isInteger(x) && x >= 0 && x <= 127;
    if (h && int7(h.cc)) {
      if (h.cc === 64) return { error: 'sustain-pedal-reserved', cc: 64, channel: ch };
      if (accept === 'fader' && PEDAL_SWITCH_CCS.includes(h.cc)) return { error: 'needs-knob', cc: h.cc, channel: ch };
      return { cc: h.cc, channel: ch };
    }
    if (h && int7(h.note)) {
      return accept === 'button' ? { note: h.note, channel: ch } : { error: 'needs-knob', channel: ch };
    }
    return null;
  }
  /** skeptic UI6-U7c F1: true for the note / CC (on an overlapping channel) learned to PANIC now. */
  function isPanicControl(m) {
    const p = (settings().midiLearn || {}).panic;
    if (!p || !m) return false;
    const same = m.cc !== undefined ? p.cc === m.cc : p.note === m.note;
    return same && (p.channel === null || p.channel === undefined || p.channel === m.channel);
  }
  /**
   * UI v6 U7c (MIDI Learn on Perform, "1 · Move a knob, fader or pad"): take the next knob, fader, pedal, key or pad
   * without a target yet (midi.js learn accept 'control': like 'any', but bank select / data entry / NRPN numbers are
   * skipped and delivered normally, as for a fader or button learn). The gesture is swallowed like any learning
   * gesture; nothing is stored. Pass the result to learn(id, {heard}) once the player has tapped the target.
   * Refused under Perform Lock (turning the lock on cancels it, as for learn()); cancelLearn() ends it with null.
   * The control learned to PANIC is never taken (skeptic UI6-U7c F1): it plays on and panics.
   * @param {{timeoutMs?:number}} [o]
   * @returns {Promise<{cc?:number, note?:number, channel:number}|{error:string}|null>}
   */
  async function learnCapture(o = {}) {
    if (!midi || typeof midi.learn !== 'function') return null;
    if (settings().performLock) return { error: 'perform-locked' };
    // skeptic UI6-U7c F1: the learned PANIC control is never captured: a PANIC footswitch pressed during a capture
    // (a stuck note while learning) still panics. Re-learning that control goes through Settings › MIDI Learn's table.
    const res = await midi.learn(LEARN_CAPTURE_ID, { timeoutMs: o.timeoutMs, accept: 'control', pass: isPanicControl });
    if (!res) return null;
    if (settings().performLock) return { error: 'perform-locked' };
    if (res.error) return { error: res.error, cc: res.cc, channel: res.channel };
    return res.cc !== undefined ? { cc: res.cc, channel: res.channel } : { note: res.note, channel: res.channel };
  }
  /**
   * C1: the mappings a new `mapping` for `controlId` would contend with: same CC (or note) on an overlapping channel
   * (null = any), when either side is a button. Faders share a CC with faders (one knob, several params).
   * @returns {string[]}
   */
  function conflictsOf(controlId, mapping) {
    const kind = Number.isInteger(mapping.cc) ? 'cc' : 'note';
    const num = mapping[kind];
    const mine = isButtonControl(controlId);
    const ch = mapping.channel;
    const out = [];
    for (const [id, m] of Object.entries(settings().midiLearn || {})) {
      if (id === controlId || !m || m[kind] !== num) continue;
      const overlap = ch === null || ch === undefined || m.channel === null || m.channel === undefined
        || m.channel === ch;
      if (overlap && (mine || isButtonControl(id))) out.push(id);
    }
    return out;
  }

  // ---- menu-bar mode (docs/menubar-mode.md, contract v1; C7 menubar-A)
  // The main renderer publishes a small `state` on the bus (shared/bus.js: Electron relay or BroadcastChannel) and
  // runs the popover's / Tray's `command`s. Modes are songs: the menu-bar setlist, else the first songs of the
  // current setlist. Low-resource mode = settings.lowResource, or automatically while hidden in menu-bar mode.
  let bus = null;
  let ownBus = false; // created here (closed on dispose), not passed in via o.bus
  let menubarStarted = false;
  let lowResGcTimer = null; // L11-8
  let lowResEff = false; // effective low-resource state the engine and memory policy follow
  let windowVisibleOverride = null; // setWindowVisible(): wins over document visibility; null = follow the document
  let lastDroneOnMode = null; // droneToggle: the drone mode before the bus turned it off
  let lastPublished = null; // JSON of the last published state (unchanged states are not re-sent)

  function defaultBus() {
    const g = globalThis;
    if (!doc || doc !== g.document) return null; // tests / headless controllers: no bus unless o.bus is given
    const rigBus = !!(rig && (typeof rig.busPublish === 'function' || typeof rig.onBusCommand === 'function'));
    if (!rigBus && typeof g.BroadcastChannel !== 'function') return null;
    return createBus({ role: 'main', rig });
  }

  const docHidden = () => !!(doc && doc.visibilityState === 'hidden');
  const isWindowVisible = () => (windowVisibleOverride !== null ? windowVisibleOverride : !docHidden());
  /** settings.lowResource, or automatic while the main window is hidden in menu-bar mode. */
  function lowResourceWanted() {
    const s = settings();
    return !!s.lowResource || (!!s.menuBarMode && !isWindowVisible());
  }

  /** Low-resource pin policy: the current song only (engine preload {pin:'replace'}), no neighbours, no warming. */
  async function pinCurrentOnly() {
    memMode = 'current-only';
    memSetMB = null;
    pinPlan = null;
    const cur = store.get().settings.currentSongId;
    if (!hasPreload() || !cur || !store.getSong(cur)) return;
    try {
      await pinSongs([cur], 'replace');
    } catch (err) {
      warn(`preload failed: ${err && err.message}`);
    }
  }

  /**
   * Bring the engine and the memory policy in line with lowResourceWanted(). Turning on pins the current song only;
   * turning off preloads the nav list again (its songs are still decoded unless the LRU needed the room).
   * @returns {boolean} effective state
   */
  function applyLowResource({ preload = true } = {}) {
    const want = lowResourceWanted();
    setStatus({ windowVisible: isWindowVisible() });
    if (want === lowResEff) return want;
    lowResEff = want;
    optional('setLowResource', want);
    if (want) lowResSince = now();
    if (lowResGcTimer !== null) timers.clearTimeout(lowResGcTimer);
    lowResGcTimer = null;
    // L11-8: one GC once the release tails holding dropped buffers have ended
    if (want && gcNow) {
      lowResGcTimer = timers.setTimeout(() => {
        lowResGcTimer = null;
        if (lowResEff) gcNow();
      }, LOWRES_GC_MS);
    }
    else if (engine && typeof engine.wake === 'function' && (engine.sleepState || 'awake') !== 'awake') {
      // lowres2-scope: leaving low-resource wakes the audio now (the engine's 60 ms wake ramp: click-free); a sleep
      // still ramping down is cancelled the same way
      const p = optional('wake');
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
    setStatus({ lowResource: want });
    emit('lowResource', { on: want, auto: want && !settings().lowResource });
    if (preload && started && !secondary) preloadSetlist();
    return want;
  }

  /**
   * Low-resource mode on/off by choice (persists settings.lowResource). While menu-bar mode hides the window it
   * stays on regardless (see lowResourceWanted).
   * @param {boolean} on
   * @returns {boolean} the effective state
   */
  function setLowResource(on) {
    store.set('settings.lowResource', !!on);
    return applyLowResource();
  }

  /**
   * Tell the controller whether the main window counts as visible (Electron main / main.js: the popover is open,
   * the window was hidden to the menu bar, …). null = follow document.visibilityState again.
   * @param {boolean|null} v
   * @returns {boolean} effective low-resource state
   */
  function setWindowVisible(v) {
    windowVisibleOverride = v === null || v === undefined ? null : !!v;
    const r = applyLowResource();
    publishState();
    return r;
  }

  // ---- modes
  const modeOf = (song, index) => ({ id: song.id, name: song.name, key: keyName(song.hearIn, song.minor), index });
  /** Song ids of the menu-bar set: settings.menuBarSetlistId (≤ 6), else the first 3 of the current nav list. */
  function modeIds() {
    const st = store.get();
    const sl = st.settings.menuBarSetlistId ? st.setlists[st.settings.menuBarSetlistId] : null;
    const uniq = (ids) => [...new Set(ids)].filter((id) => store.getSong(id));
    const chosen = sl ? uniq(sl.songIds) : [];
    if (chosen.length) return chosen.slice(0, MENU_BAR_MAX_MODES);
    return uniq(store.navIds()).slice(0, MENU_BAR_FALLBACK_MODES);
  }
  const listModes = () => modeIds().map((id, i) => modeOf(store.getSong(id), i));
  function currentMode() {
    const cur = store.get().settings.currentSongId;
    return listModes().find((m) => m.id === cur) || null;
  }
  function selectMode(id) {
    if (typeof id !== 'string' || !store.getSong(id)) return Promise.resolve(false);
    if (id === store.get().settings.currentSongId && appliedId === id) return Promise.resolve(false); // already on
    return selectSong(id);
  }
  function stepMode(d) {
    const list = listModes();
    if (!list.length) return Promise.resolve(false);
    const cur = currentMode();
    const i = cur ? (cur.index + d + list.length) % list.length : d > 0 ? 0 : list.length - 1;
    return selectMode(list[i].id);
  }
  const modes = Object.freeze({
    /** @returns {{id:string, name:string, key:string, index:number}[]} the menu-bar modes */
    list: listModes,
    /** @returns {{id:string, name:string, key:string, index:number}|null} the current song's mode (null: not a mode) */
    current: currentMode,
    /** @param {string} id @returns {Promise<boolean>} true when the song switched */
    select: selectMode,
    /** Next mode, wrapping (from a song outside the set: the first). @returns {Promise<boolean>} */
    next: () => stepMode(1),
    /** Previous mode, wrapping (from a song outside the set: the last). @returns {Promise<boolean>} */
    prev: () => stepMode(-1),
  });

  // ---- state
  function memoryMB() {
    const pm = globalThis.performance && globalThis.performance.memory; // Chromium only
    const heap = pm && pm.usedJSHeapSize;
    const dec = status.memory && status.memory.decodedMB;
    if (!Number.isFinite(heap) && !Number.isFinite(dec)) return null;
    return Math.round((Number.isFinite(heap) ? heap / 1048576 : 0) + (Number.isFinite(dec) ? dec : 0));
  }
  /**
   * The contract's `state` message for the current moment (published by publishState; handy for tests and views).
   * @returns {object}
   */
  function menuBarState() {
    const song = store.currentSong();
    const mv = song ? Number(songParam(song, 'master.volume')) : 0;
    const master = Number.isFinite(mv) ? Math.min(2, Math.max(0, mv)) : 0;
    const key = song ? keyName(song.hearIn, song.minor) : '';
    const heard = song ? live(song) : null; // D26.1: the drone as it plays (a scene may hold its ON / key)
    const lat = Number(status.latencyMs);
    return {
      v: 1,
      current: song ? { id: song.id, name: song.name, key } : null,
      modes: listModes(),
      master,
      masterDb: master > 0 ? Math.round(20 * Math.log10(master) * 10) / 10 : null,
      droneOn: !!(heard && heard.drone && heard.drone.mode !== 'off'),
      droneKey: heard ? keyName(heard.hearIn, heard.minor) : '',
      // restarting → 'stalled'; 'asleep' (lowres2 audio sleep) is a contract v1 value too
      audio: ['running', 'stalled', 'suspended', 'asleep'].includes(status.audio) ? status.audio : 'stalled',
      latencyMs: Number.isFinite(lat) ? Math.round(lat * 10) / 10 : 0,
      midi: { connected: !!(status.midi && status.midi.connected), name: (status.midi && status.midi.name) || null },
      lowResource: lowResEff,
      recording: !!status.recording,
      windowVisible: isWindowVisible(),
      memoryMB: memoryMB(),
      ...(sceneInfo().count ? { scene: { n: sceneInfo().n, count: sceneInfo().count } } : {}), // v11-scenes
    };
  }
  /**
   * Publish the state on the bus (throttled there to ≤ 4/s; an unchanged state is skipped unless `force`).
   * @param {{force?:boolean, immediate?:boolean}} [opts] immediate: send a throttled state now
   * @returns {object} the state
   */
  function publishState(opts = {}) {
    const st = menuBarState();
    if (!bus || secondary) return st;
    const json = JSON.stringify(st);
    if (!opts.force && json === lastPublished) return st;
    lastPublished = json;
    bus.publish(st);
    if (opts.immediate) bus.flush();
    return st;
  }

  // ---- commands
  /**
   * Run one contract command (from the bus, or directly). Invalid commands are ignored with a console.warn.
   * 'openMain' only emits an 'openMain' event here (Electron main shows the window).
   * @param {object} cmd
   * @returns {boolean} true when the command was valid and handled
   */
  function handleCommand(cmd) {
    const err = commandError(cmd);
    if (err) {
      console.warn(`[controller] ignored a bus command (${err})`);
      return false;
    }
    if (secondary) return false;
    // lowres2: a popover / tray command is input (wakes sleeping audio). lowres2-critic R2: except `hello` (the
    // popover opening / asking for state): it is not a player's input, so it neither wakes the audio nor restarts the
    // idle clock, and the frozen drone stays frozen while the popover is merely open
    if (cmd.type !== 'hello') noteActivity('bus');
    const song = store.currentSong();
    switch (cmd.type) {
      case 'hello':
        publishState({ force: !(bus && bus.lastState), immediate: true });
        break;
      case 'selectMode':
        selectMode(cmd.id);
        break;
      case 'nextMode':
        modes.next();
        break;
      case 'prevMode':
        modes.prev();
        break;
      case 'panic':
        panic();
        break;
      case 'fadeOutAll':
        fadeOutAll();
        break;
      case 'master':
        if (song) store.set(`songs.${song.id}.patch.fx.master.volume`, Math.min(2, Math.max(0, cmd.value)));
        break;
      case 'droneToggle': {
        if (!song) break;
        // D26.1: the drone as it plays (a scene may hold its ON / sound); a scene that holds it takes the toggle
        const heard = live(song);
        let mode;
        if (heard.drone.mode !== 'off') {
          lastDroneOnMode = heard.drone.mode;
          mode = 'off';
        } else {
          const snapMode = selected && selected.id === song.id ? selected.song.drone && selected.song.drone.mode : null;
          mode = lastDroneOnMode || (snapMode === 'files' ? 'files' : 'synth');
        }
        if (!adjustScene('drone.mode', mode)) store.set(`songs.${song.id}.drone.mode`, mode);
        break;
      }
      case 'droneKey': {
        // the key the band hears; the transpose amount is kept (Perform's key grid, setSongKey)
        if (!song) break;
        if (adjustScene('drone.key', { pc: mod12(cmd.pc) })) break; // D26.1: a scene holding the key takes it
        if (song.hearIn === cmd.pc) break;
        const semis = transposeSemis(song.playIn, song.hearIn);
        store.set(`songs.${song.id}.hearIn`, mod12(cmd.pc));
        store.set(`songs.${song.id}.playIn`, mod12(cmd.pc - semis));
        break;
      }
      case 'lowResource':
        setLowResource(cmd.on);
        break;
      case 'record':
        if (cmd.on !== !!(recorder && recorder.isRecording)) record();
        break;
      case 'openMain':
        emit('openMain', {});
        break;
      case 'nextScene': // v11-scenes (global hotkeys, popover)
        stepSceneBy(1);
        break;
      case 'prevScene':
        stepSceneBy(-1);
        break;
      // v11-decisions (Ryan, checklist Q3): the global next / previous hotkeys = Perform's → / ← and the footswitch
      // (gapless switch, the setlist's end stops: no wrap); the popover / Tray keep stepping modes
      case 'nextSong':
        nextSong();
        break;
      case 'prevSong':
        prevSong();
        break;
      default:
        break;
    }
    emit('bus-command', cmd);
    return true;
  }

  function onMenubarStore(state, paths) {
    if (paths.some((p) => p === 'settings.lowResource' || p === 'settings.menuBarMode')) applyLowResource();
    publishState();
  }

  /** Called by startPrimary (before the first song): bus, listeners, low-resource state, first publish. */
  function startMenubar() {
    if (menubarStarted) return;
    menubarStarted = true;
    if (!bus) {
      bus = o.bus !== undefined ? o.bus : defaultBus();
      ownBus = o.bus === undefined && !!bus;
    }
    applyLowResource({ preload: false }); // startPrimary preloads next, under the right policy
    listen(doc, 'visibilitychange', () => {
      applyLowResource();
      publishState();
    });
    cleanups.push(store.subscribe(onMenubarStore));
    listen(api, 'status', () => publishState());
    if (bus) {
      const off = bus.onCommand(handleCommand);
      cleanups.push(() => {
        if (typeof off === 'function') off();
        if (ownBus) bus.close();
        bus = ownBus ? null : bus;
        ownBus = false;
        menubarStarted = false;
        lastPublished = null;
      });
      publishState({ force: true });
    } else {
      cleanups.push(() => {
        menubarStarted = false;
      });
    }
  }

  Object.assign(api, {
    start,
    dispose,
    midiReady,
    selectSong,
    nextSong,
    prevSong,
    // Lane S (D6): Cue, then Go
    cueSong,
    clearCue,
    go,
    cueNext: () => cueStep(1),
    cuePrev: () => cueStep(-1),
    songState,
    songReady,
    goTarget,
    panic,
    fadeOutAll,
    toggleView,
    transposeUp,
    transposeDown,
    transposeBy,
    swell,
    captureTouch,
    record,
    restartAudio,
    resumeAudio,
    preloadSetlist,
    attachPads,
    reloadPads,
    restoreChromePads,
    backupNow,
    /**
     * UI v6 U6 (Settings › Library & Backup summary): when this page last wrote an automatic backup, or null. A failed
     * or refused one does not count (UI6-U6 skeptic F4: the summary said "backed up just now" after a failure).
     */
    lastBackupAt: () => lastBackupDone,
    importLatestBackup,
    applyDeviceSettings,
    inspectDeviceSettings,
    listPreviousLibraries,
    restorePreviousLibrary,
    rescanUserSamples,
    rescanPatchPacks,
    patchPacks,
    addFromBank,
    // UI v6 U7a (D17): Song bank Try it
    tryBankSong,
    backFromTrial,
    keepTrial,
    trial: trialInfo,
    /** U7a: a bank song as the library would take it (store.packSongPreview), for the browser's details. */
    bankSong: (packId) => {
      const e = packsInfo.entries.find((x) => x.packId === packId);
      return e && typeof store.packSongPreview === 'function' ? store.packSongPreview(e) : null;
    },
    revertSong,
    scenes,
    learn,
    learnCapture,
    startClick,
    stopClick,
    toggleClick,
    /** v11-metronome: MIDI outputs for Settings' clock select, and the clock's send / jitter stats. */
    midiOutputs: () => midiClock.outputs(),
    clickOutputs: () => optional('clickOutputs') || { aux: false, channels: 2 },
    midiClockStats: () => midiClock.stats(),
    /**
     * One slot's level for the strip meters (polish-1): engine.slotLevel, null-safe and silent (it is read every
     * frame while a meter shows). Views read levels here, never from the engine.
     * @param {number} i slot 0..engineSlots()-1
     * @returns {{peak:number, rms:number}|null}
     */
    slotLevel: (i) => {
      if (secondary || !engine || typeof engine.slotLevel !== 'function') return null;
      if (!(i >= 0 && i < engineSlots())) return null; // UIA: a slot the engine does not play has no level
      try {
        return engine.slotLevel(i);
      } catch {
        return null;
      }
    },
    /**
     * UIA (native DECISIONS D3): how many slots of a song the engine plays (16 on the 2.0 engine, 4 on the web
     * engine: there slots 5..16 are stored and shown but silent). Views read it to say so.
     * @returns {number}
     */
    engineSlots,
    cancelLearn: () => midi && midi.cancelLearn && midi.cancelLearn(),
    clearLearn: (controlId) => store.setMidiLearn(controlId, null),
    onMenu,
    /**
     * Subscribe to a controller event with its detail ('songSelected', 'song', 'warn', 'status', …).
     * @returns {() => void} unsubscribe
     */
    on(type, cb) {
      const fn = (e) => cb(e.detail);
      api.addEventListener(type, fn);
      return () => api.removeEventListener(type, fn);
    },
    /**
     * idle-cpu-ui: subscribe to activity — anything that may start sound (any input incl. note-on, a song applied, a
     * song edit such as drone / master, recording, an audio wake). Throttled to one call per 50 ms; the UI's meter
     * clock restarts its stopped loop from it.
     * @param {(d:{kind:string}) => void} cb
     * @returns {() => void} unsubscribe
     */
    onActivity(cb) {
      const fn = (e) => cb(e.detail || {});
      api.addEventListener('activity', fn);
      return () => api.removeEventListener('activity', fn);
    },
    /** Subscribe to status; cb is called immediately. @returns {() => void} */
    onStatus(cb) {
      const fn = (e) => cb(e.detail);
      api.addEventListener('status', fn);
      cb({ ...status });
      return () => api.removeEventListener('status', fn);
    },
    /** On-screen / programmatic performance input (source 'ui'). */
    perform: {
      noteOn: (note, vel = KB_VELOCITY) => {
        captured(vel, COMPUTER_KEYBOARD, null);
        // v11-touch: the on-screen keys' own curve (settings.keyboards['@computer']) replaces the Touch setting
        const own = touchOpts.get(COMPUTER_KEYBOARD);
        if (own) noteOnFrom('ui', note, Math.min(127, Math.max(1, Math.round(Number(vel) || 0))), own);
        else noteOnFrom('ui', note, applyVelocitySens(vel, settings().velocitySens));
      },
      noteOff: (note) => noteOffFrom('ui', note),
      sustain: (down) => {
        pedalBySrc.set('ui', !!down);
        updatePedal();
      },
      bend: (v) => call('pitchBend', Math.max(-1, Math.min(1, Number(v) || 0))),
      wheel: (v) => setVirtualWheel(Math.max(0, Math.min(1, Number(v) || 0))),
      nudgeWheel,
      expression: (v) => call('expression', Math.max(0, Math.min(1, Number(v) || 0))),
      releaseAll: () => releaseSource('ui'),
    },
    /** Test/debug hooks. */
    _tick: tick,
    _debug: () => ({
      held: [...heldCount.entries()],
      pedalDown,
      kbOctave,
      virtualWheel,
      swellActive,
      appliedId,
      targetId,
      seq,
      cue: cue && { ...cue },
      going: going && { id: going.id, index: going.index, started: going.started },
      warming: [...warming.keys()],
      pickups: Object.fromEntries(pickups),
      wheels: { ...wheelState },
      heldBySrc: Object.fromEntries([...heldBySrc].map(([k, v]) => [k, [...v]])),
      secondary,
    }),
  });
  // menubar-A (C7): menu-bar mode API (docs/menubar-mode.md)
  Object.assign(api, { modes, setLowResource, setWindowVisible, publishState, menuBarState, handleCommand });
  // O-AW-PP: settles once the boot-time patch-pack read is done (tests; nothing waits on it). A getter, which
  // Object.assign would have read once.
  Object.defineProperty(api, 'packsReady', { get: () => packsReady, enumerable: true });
  // lowres2: input-activity clock + audio sleep
  Object.assign(api, {
    noteActivity,
    _sleepCheck: sleepCheck,
    _sleepDebug: () => ({
      lastInputAt, lastInputKind, idleMs: now() - lastInputAt, sleepSec: audioSleepSecOf(settings()),
      lowResource: lowResEff, lowResSince, // lowres2-scope: the sleep clock only runs in low-resource
    }),
  });
  Object.defineProperty(api, 'bus', { get: () => bus });
  Object.defineProperty(api, 'status', { get: () => ({ ...status }) });
  Object.defineProperty(api, 'isElectron', { value: isElectron });
  Object.defineProperty(api, 'kbOctave', { get: () => kbOctave });
  return api;
}
