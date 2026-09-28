// Worship Rig controller (SPEC §6, REVIEW 4.1, 2.1–2.4, 2.10, 1.16, 1.17).
// The ONLY place store and engine meet: song selection (prepare → commit, race-safe), store→engine diffing for the
// current song, perform-time input routing (MIDI + computer keyboard + on-screen), watchdog/restart, wake lock,
// Electron menu wiring and auto-backups. Views call store.set(...) for persisted state and controller.* for actions.
//
// Engine calls used (all feature-detected; a missing method warns once):
//   start, restart({latency, sinkId}), prepare(patch)→token, commit(token,{when}), preload(patches[]),
//   setParam(path, v), setTranspose(semis), setRouting({modWheel,expression,volume,bend,swell}), setTempo(bpm|null),
//   noteOn(note, vel 1..127), noteOff(note), sustain(bool), pitchBend(-1..1), modWheel/expression/volumeCC(0..1),
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
// status.memory = {mode, decodedMB, pinnedMB, capMB, setMB, note}.
import { transposeSemisOf } from './store.js';
import { transposeSemis, mod12 } from './shared/music.js';
import { PARAMS, isValidPath, isLearnButton, faderTaper, inverseTaper, SLOT_COUNT } from './shared/params.js';
import { detectKeyFromName } from './shared/keydetect.js';

/** Settings.latency → engine latency option (REVIEW 4.8). */
export const LATENCY_MAP = Object.freeze({ lowest: 'interactive', balanced: 0.01, safe: 0.025 });
export const engineLatency = (settings) => LATENCY_MAP[settings && settings.latency] ?? 'interactive';

/** Computer keyboard (physical key codes) → semitone offset from C of the current octave (C4 at octave 0). */
export const KEY_MAP = Object.freeze({
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11,
  KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16,
});
/** Momentary learnable actions (note-on or CC ≥ 64). */
export const BUTTON_CONTROLS = Object.freeze(['nextSong', 'prevSong', 'panic', 'fadeOutAll', 'swell']);
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
/** Songs either side of the current one that stay pinned: library browsing (≤ 3 songs) and a large setlist. */
export const LIBRARY_PIN_RADIUS = 1;
export const LARGE_SET_PIN_RADIUS = 2;
/** Unpinned warming of a large setlist stops at this share of the engine cache cap (it evicts down to 85 %). */
const WARM_SHARE_OF_CAP = 0.8;
export const LARGE_SET_NOTE = 'Large set: loading songs as you go';
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

function structuralChange(pa, pb) {
  for (let i = 0; i < SLOT_COUNT; i++) {
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
  function call(name, ...args) {
    if (secondary) return undefined; // muted second window
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
    midi: { available: false, connected: false, name: null, reason: null, inputs: [], hint: null, fallback: false, standIn: false },
    loading: false,
    ready: false,
    recording: false,
    songId: null,
    wakeLock: false,
    pedal: false, // effective sustain (MIDI CC64 after pedalInvert, Space, on-screen) for the UI indicator
    instance: 'primary', // 'primary' | 'secondary' (H2)
    instanceMessage: null,
    library: { readOnly: false, readOnlyReason: null, persistError: null }, // store.loadInfo summary (H1/M7)
    otherLibrary: null, // Electron: {origin, savedAt, path} of a newer library backup from another port (M5)
    // morning-prep: 'library' | 'setlist' | 'large-set' (null before the first preload); MB values from
    // engine._debugStats() (null when the engine has none); setMB = decoded size of the whole setlist (estimate)
    memory: { mode: null, decodedMB: null, pinnedMB: null, capMB: null, setMB: null, note: null },
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

  function applySongLevel(song, prev, force) {
    const semis = transposeSemisOf(song);
    if (force || !prev || semis !== transposeSemisOf(prev)) call('setTranspose', semis);
    const r = routingOf(song);
    if (force || !prev || !same(r, routingOf(prev))) call('setRouting', r);
    applyDrone(song, prev, force);
    if (force || !prev || song.tempo !== prev.tempo) call('setTempo', song.tempo ?? null);
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
    for (let i = 0; i < SLOT_COUNT; i++) {
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
    if (structuralChange(prev.patch, next.patch)) {
      reprepare(next.id);
      return;
    }
    if (applyParamDiff(prev, next) === false) {
      reprepare(next.id, true);
      return;
    }
    applySongLevel(next, prev, false);
    applied = next;
  }

  async function preparePatch(song) {
    const r = call('prepare', song.patch);
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
    try {
      token = await preparePatch(song);
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
    applySongLevel(song, prev, false);
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
  async function selectSong(id, opts = {}) {
    const retried = !!opts._retried;
    const song = store.getSong(id);
    if (!song) {
      warn(`selectSong: unknown song ${id}`);
      return false;
    }
    const my = ++seq;
    targetId = id;
    repreparing = null;
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
      if (!retried) return selectSong(id, { ...opts, _retried: true });
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
    applySongLevel(song, prev, true);
    catchUp(song);
    setStatus({ loading: false, songId: id });
    // round2-shell #4: snapshot the song as committed (catchUp just sent edits made while it loaded), not as requested
    const committed = store.getSong(id) || song;
    selected = { id, song: committed };
    emit('song', { id });
    emit('songSelected', { id, patchSnapshot: clone(committed.patch), songSnapshot: clone(committed) });
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
    if (changed) emit('action', { type: 'revertSong', id });
    return changed;
  }

  // ---- decoded-sample memory policy (morning-prep; integration-2 round 2 #3)
  let memMode = null; // 'library' | 'setlist' | 'large-set'
  let memSetMB = null;
  const hasPreload = () => !secondary && !!engine && typeof engine.preload === 'function';
  const patchesOf = (ids) => ids.map((id) => store.getSong(id)).filter(Boolean).map((s) => s.patch);
  /** True when a non-empty setlist drives navigation (store.navIds() is the setlist, not the library). */
  function inSetlist() {
    const sl = store.currentSetlist();
    return !!(sl && Array.isArray(sl.songIds) && sl.songIds.length);
  }
  /**
   * The current song plus up to `radius` nav neighbours either side (unique ids, current first). In the setlist
   * "gap" state (current entry removed) the window is centred on the gap.
   */
  function windowIds(radius) {
    const ids = store.navIds();
    const n = store.neighbors();
    const cur = store.get().settings.currentSongId;
    let lo;
    let hi;
    if (n.index >= 0) [lo, hi] = [n.index - radius, n.index + radius];
    else if (Number.isInteger(n.gap)) [lo, hi] = [n.gap - radius, n.gap + radius - 1];
    else [lo, hi] = [0, radius - 1]; // current song not in the list: its first songs are the next ones
    const out = cur && store.getSong(cur) ? [cur] : [];
    for (let j = Math.max(0, lo); j <= Math.min(ids.length - 1, hi); j++) if (!out.includes(ids[j])) out.push(ids[j]);
    return out;
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
  /** Refresh status.memory from engine._debugStats() (called after preloads and from the watchdog tick). */
  function updateMemory() {
    let d = null;
    try {
      d = optional('_debugStats');
    } catch {
      d = null;
    }
    const num = (v) => (Number.isFinite(v) ? v : null);
    const round = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
    setStatus({
      memory: {
        mode: memMode,
        decodedMB: num(d && d.decodedMB),
        pinnedMB: num(d && d.pinnedMB),
        capMB: num(d && d.capMB),
        setMB: round(memSetMB),
        note: memMode === 'large-set' ? LARGE_SET_NOTE : null,
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
   * Pin the window around the current song with {pin:'replace'}: the pinned set is exactly these ≤ 2·radius+1
   * songs, so every other decoded buffer is evictable. (Not 'add': walking through the library with 'add' pins
   * every song visited, which is the 1 GB the soak measured.)
   */
  async function pinWindow(radius) {
    try {
      await pinSongs(windowIds(radius), 'replace');
    } catch (err) {
      warn(`preload failed: ${err && err.message}`);
    }
  }

  /** After a song switch: keep the pinned window around the new song (policy depends on the nav mode). */
  function preloadNeighbors() {
    if (!hasPreload()) return;
    if (!inSetlist()) return void pinWindow(LIBRARY_PIN_RADIUS).then(updateMemory);
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
    setStatus({ ready: false });
    try {
      if (!hasPreload()) {
        /* nothing to warm */
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
        else {
          memMode = 'setlist';
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

  async function preloadLargeSet(my, ids) {
    const first = memMode !== 'large-set';
    memMode = 'large-set';
    updateMemory();
    if (first) emit('memory', { mode: memMode, note: LARGE_SET_NOTE, setMB: memSetMB });
    await pinWindow(LARGE_SET_PIN_RADIUS);
    // warm the rest unpinned, nearest first; stop before the LRU would start evicting what was just warmed
    const win = windowIds(LARGE_SET_PIN_RADIUS);
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
      if (!est || !Number.isFinite(est.capMB) || est.mb > est.capMB * WARM_SHARE_OF_CAP) break;
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

  function noteOnFrom(src, note, vel) {
    if (!Number.isInteger(note) || note < 0 || note > 127) return;
    let set = heldBySrc.get(src);
    if (!set) heldBySrc.set(src, (set = new Set()));
    if (set.has(note)) return; // duplicate note-on from the same source
    set.add(note);
    const c = heldCount.get(note) || 0;
    heldCount.set(note, c + 1);
    if (c === 0) call('noteOn', note, vel);
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
    if (kind === 'cc' && num === 64) return null; // the sustain pedal is never remapped (M2; old mappings ignored)
    const ml = settings().midiLearn || {};
    for (const [id, m] of Object.entries(ml)) {
      if (m[kind] === num && (m.channel === null || m.channel === undefined || m.channel === channel)) return id;
    }
    return null;
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
    else if (id === 'panic') panic();
    else if (id === 'fadeOutAll') fadeOutAll();
  }

  /** Hardware fader with pickup: ignored until it crosses the stored value (REVIEW 2.1). */
  function learnedFader(id, value01) {
    if (!isValidPath(id)) return;
    const cur = songParam(store.currentSong(), id);
    if (cur === undefined || cur === null) return;
    const pos = inverseTaper(cur);
    let pu = pickups.get(id);
    if (!pu) pickups.set(id, (pu = { picked: false, last: null }));
    if (pu.picked && pu.last !== null && Math.abs(pos - pu.last) > 0.02) pu.picked = false; // moved elsewhere (UI/song)
    if (!pu.picked) {
      if (Math.abs(value01 - pos) < 0.02) pu.picked = true;
      else if (pu.last !== null && (pu.last - pos) * (value01 - pos) <= 0) pu.picked = true;
    }
    pu.last = value01;
    if (pu.picked) store.set(id, faderTaper(value01));
  }

  const midiHandlers = {
    noteon: (e) => {
      const d = e.detail;
      const learned = learnedFor('note', d.note, d.channel);
      if (learned && isButtonControl(learned)) return triggerButton(learned, d.velocity > 0);
      if (d.velocity === 0) return noteOffFrom(midiSrc(d), d.note);
      noteOnFrom(midiSrc(d), d.note, applyVelocitySens(d.velocity, settings().velocitySens));
    },
    noteoff: (e) => {
      const d = e.detail;
      const learned = learnedFor('note', d.note, d.channel);
      if (learned && isButtonControl(learned)) return triggerButton(learned, false);
      noteOffFrom(midiSrc(d), d.note);
    },
    cc: (e) => {
      const d = e.detail;
      const learned = learnedFor('cc', d.cc, d.channel);
      if (learned) {
        if (isButtonControl(learned)) triggerButton(learned, d.value >= 64);
        else learnedFader(learned, d.value01);
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
      if (!settings().programChange) return;
      const ids = store.navIds();
      const p = e.detail.program;
      if (p >= 0 && p < ids.length) selectSong(ids[p], { index: p });
    },
    disconnected: (e) => releaseSource(e.detail.inputId),
    devices: (e) => {
      const d = e.detail;
      const sel = d.inputs.filter((i) => i.selected);
      const hint = d.hint || null;
      // midi-default: announce the all-ports fallback once each time it starts (no hardware keyboard connected)
      if (hint && hint !== status.midi.hint) warn(hint);
      setStatus({
        midi: {
          available: d.available,
          connected: sel.length > 0,
          name: d.activeName || sel.map((i) => i.name).join(', ') || null,
          reason: status.midi.reason,
          inputs: d.inputs,
          hint,
          fallback: !!d.fallback,
          standIn: !!d.standIn,
        },
      });
    },
    // midi-default (4): a hot-plug moved us onto another keyboard
    switched: (e) => warn(`Now using ${e.detail.name || 'another MIDI input'}`),
    // midi-default (3): the chosen keyboard came back with a new id (matched by name) → remember the new id
    rebind: (e) => {
      if (secondary || settings().midiInputId === e.detail.inputId) return;
      store.set('settings.midiInputId', e.detail.inputId);
    },
    unavailable: (e) => setStatus({ midi: { ...status.midi, available: false, connected: false, reason: e.detail.reason } }),
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
  function nothingFocused(el) {
    return !el || (doc && (el === doc.body || el === doc.documentElement)) || !el.tagName;
  }

  function onKeyDown(e) {
    if (e.defaultPrevented) return;
    const el = activeEl(e);
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
          if (e.code === 'ArrowLeft') prevSong();
          else nextSong();
        }
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
      noteOnFrom('kb', note, KB_VELOCITY);
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

  // ---- actions
  function nextSong() {
    const n = store.neighbors().next;
    if (!n) return Promise.resolve(false);
    return selectSong(n.id, { index: n.index });
  }
  function prevSong() {
    const p = store.neighbors().prev;
    if (!p) return Promise.resolve(false);
    return selectSong(p.id, { index: p.index });
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
    emit('action', { type: 'panic' });
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
      else if (stuckTicks === 0) setAudio('running');
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
    restorePads();
    setAudio(engine && engine.ctx && engine.ctx.state === 'running' ? 'running' : 'suspended');
  }

  /** Re-attach pad files after a restart, and re-apply a files-mode drone that fell back to the synth. */
  function restorePads() {
    if (!padList.length) return;
    const d = engine && engine.drone;
    const kept = d && d.files instanceof Map && d.files.size > 0;
    if (kept) return;
    droneCall('attachFiles', padList);
    if (applied && applied.drone && applied.drone.mode === 'files') {
      lastDroneKey = null;
      droneCall('configure', { ...applied.drone, mode: 'off' });
      applyDrone(applied, null, true);
    }
  }

  /** New AudioContext + graph (engine re-applies its state). A running take is split into a new file. */
  async function restartAudio(opts = {}) {
    if (restarting || secondary) return false;
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
    restarting = false;
    if (ok) {
      afterRestart();
      emit('statechange', { state: 'restarted', auto: !!opts.auto });
      await resumeRecording(part);
    } else {
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
    const ctx = engine && engine.ctx;
    if (ctx && ctx.state !== 'running' && ctx.resume) await ctx.resume().catch(() => {});
    tick();
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

  // ---- settings reactions
  function onSetting(key, s) {
    switch (key) {
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
      default:
        break;
    }
  }

  // ---- backups (Electron)
  let backupTimer = null;
  let lastBackup = -Infinity;
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
   * the current one first — the backup is a whole library, so merging would duplicate every song.
   * @returns {Promise<{ok:boolean, error?:string, songIds?:string[]}>}
   */
  async function importLatestBackup({ replace = true } = {}) {
    if (!rig || typeof rig.latestBackup !== 'function') return { ok: false, error: 'not available' };
    const b = await rig.latestBackup();
    if (!b || b.error || typeof b.text !== 'string') return { ok: false, error: (b && b.error) || 'no backup found' };
    if (replace) await backupNow(); // the backup we are about to replace from stays the newest source of truth
    const r = store.importJSON(b.text, { replace });
    if (r.ok) {
      setStatus({ otherLibrary: null });
      emit('action', { type: 'importBackup', path: b.path, songs: r.songIds.length });
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
    for (const p of paths) {
      if (p.startsWith('settings.')) {
        const k = p.split('.')[1];
        onSetting(k, state.settings);
        if (k === 'currentSetlistId') navChanged = true;
      } else if (p.startsWith('setlists.') || p === 'songOrder') {
        navChanged = true;
        entityChanged = true;
      } else if (p.startsWith('songs.')) entityChanged = true;
    }
    if (entityChanged) scheduleBackup();
    const cur = state.settings.currentSongId;
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
      if (!granted || !started) return;
      secondary = false;
      if (typeof store.reload === 'function') store.reload(); // pick up what the other window saved
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
    if (!(await requestInstanceLock(false))) {
      enterSecondary();
      return;
    }
    await startPrimary();
  }

  async function startPrimary() {
    cleanups.push(store.subscribe(onStore));
    if (midi) for (const [type, fn] of Object.entries(midiHandlers)) listen(midi, type, fn);
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
      for (const type of ['wheel', 'notes', 'chord', 'loading', 'ready']) listen(engine, type, (e) => emit(type, e.detail));
      listen(engine, 'warn', (e) => emit('warn', { message: (e.detail && e.detail.message) || String(e.detail), source: 'engine' }));
    }
    if (recorder) {
      listen(recorder, 'state', (e) => setStatus({ recording: e.detail.state === 'recording' }));
    }
    if (rig && typeof rig.onMenu === 'function') {
      const off = rig.onMenu(onMenu);
      if (typeof off === 'function') cleanups.push(off);
    }
    installShellHook();
    const libInfo = store.loadInfo;
    if (libInfo.status === 'corrupt' || libInfo.status === 'future-schema') secureUnreadableLibrary();

    const r = call('start');
    if (r && typeof r.then === 'function') await r.catch((err) => warn(`audio start failed: ${err && err.message}`));
    const s = settings();
    if (s.monoOutput) call('setMono', true);
    if (s.outputDeviceId && s.outputDeviceId !== 'default' && engine && typeof engine.setSinkId === 'function') {
      const sr = call('setSinkId', s.outputDeviceId);
      if (sr && typeof sr.catch === 'function') sr.catch((err) => warn(`could not select the saved output: ${err && err.message}`));
    }
    const midiReady = midi
      ? (midi.access ? Promise.resolve(true) : midi.init())
          .then(() => midi.select(settings().midiInputId, rememberMidiInputName(settings())))
          .catch((err) => warn(`MIDI init failed: ${err && err.message}`))
      : Promise.resolve();
    if (rig && typeof rig.listPads === 'function') await reloadPads().catch((err) => warn(`pad folder: ${err && err.message}`));
    else await restoreChromePads().catch(() => null);
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
    await midiReady;
  }

  function dispose() {
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
    if (heartbeatTimer !== null) timers.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
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
   * @returns {Promise<{cc?:number, note?:number, channel:number}|{error:string}|null>} null = timeout / cancelled
   */
  async function learn(controlId, o = {}) {
    if (!midi || typeof midi.learn !== 'function') return null;
    const accept = isButtonControl(controlId) ? 'button' : 'fader';
    const res = await midi.learn(controlId, { ...o, accept });
    if (!res) return null;
    if (res.error) return { error: res.error, cc: res.cc, channel: res.channel };
    const mapping = res.cc !== undefined ? { cc: res.cc, channel: res.channel } : { note: res.note, channel: res.channel };
    store.setMidiLearn(controlId, mapping);
    pickups.delete(controlId);
    return mapping;
  }

  Object.assign(api, {
    start,
    dispose,
    selectSong,
    nextSong,
    prevSong,
    panic,
    fadeOutAll,
    toggleView,
    transposeUp,
    transposeDown,
    transposeBy,
    swell,
    record,
    restartAudio,
    resumeAudio,
    preloadSetlist,
    attachPads,
    reloadPads,
    restoreChromePads,
    backupNow,
    importLatestBackup,
    rescanUserSamples,
    revertSong,
    learn,
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
    /** Subscribe to status; cb is called immediately. @returns {() => void} */
    onStatus(cb) {
      const fn = (e) => cb(e.detail);
      api.addEventListener('status', fn);
      cb({ ...status });
      return () => api.removeEventListener('status', fn);
    },
    /** On-screen / programmatic performance input (source 'ui'). */
    perform: {
      noteOn: (note, vel = KB_VELOCITY) => noteOnFrom('ui', note, applyVelocitySens(vel, settings().velocitySens)),
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
      pickups: Object.fromEntries(pickups),
      wheels: { ...wheelState },
      heldBySrc: Object.fromEntries([...heldBySrc].map(([k, v]) => [k, [...v]])),
      secondary,
    }),
  });
  Object.defineProperty(api, 'status', { get: () => ({ ...status }) });
  Object.defineProperty(api, 'isElectron', { value: isElectron });
  Object.defineProperty(api, 'kbOctave', { get: () => kbOctave });
  return api;
}
