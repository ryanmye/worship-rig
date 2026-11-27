// Song scenes (v11-scenes; BACKLOG A "Sunday Keys patch snapshots"): up to SCENE_MAX saved "live" states per song,
// stepped by a footswitch, Perform, the bus or a global hotkey. Pure: no DOM, no Web Audio.
//
// What a scene holds: what Perform's faders, ON tiles and wheel move while playing, and (D26.1) the mix around them:
// each instrument's Space / Echo sends, the song's Space room and Echo, and the drone's ON / sound / key. Never the
// instruments themselves, octave, sustain, range, EQ / tone or the other effects, and nothing that restarts a voice:
//   slots[i] = {gain, muted?, sends?}  each filled slot's level (the pre-mute level while muted), its ON tile, and
//                                      (D26.1) sends {reverb?, delay?} = slots.<i>.sends.reverb / .delay
//   drone    = {gain?, mode?, key?}    the drone level; (D26.1) mode 'off' | 'synth' | 'files' (ON + sound: Synth / My
//                                      Pads) and key {pc 0..11, minor}: the key the drone plays (the key grid's
//                                      song.hearIn / minor). Absolute, because today's key grid writes the song's own
//                                      key: "tap D, Save, tap back to C" must give a snapshot in D. So a scene does
//                                      not follow a later Easy Transpose of the song (Update it to move it).
//   fx       = {reverb?, delay?}       (D26.1) the Space room = fx.reverb.{size, damp, predelay, returnGain} and the
//                                      Echo = fx.delay.{time, feedback, pingpong, tone, sync, returnGain}: what the
//                                      song bar's Space / Echo pickers (shared/fx-presets.js) and Edit › Effects
//                                      write
//   wheel    = 0..1                    the mod-wheel position, only when the song routes the wheel somewhere
// Every field is optional: a scene without one (every scene saved before D26.1) leaves it as the song has it, so old
// scenes keep their meaning. Saving captures all of them (captureScene). A scene change glides every level (slot and
// drone levels in the engine; sends and the Space / Echo levels in the controller's SCENE_STEP_SEC steps); the room /
// echo settings and the drone's ON / sound / key go through the same engine calls as a manual change (the reverb's
// crossfaded swap, the delay's two lines, the drone's key crossfade and fades), so nothing is cut or restarted.
// Stored as the optional song field `scenes` (an array, absent until a scene is saved; no SCHEMA change). The song's
// own fields stay its base: a scene is an overlay the controller applies on top while it plays (applyScene), so
// Revert, the Edit changed dots (ctx.getBaseline) and the next time the song loads all keep meaning the song itself.
// Which scene plays is transient (controller), and every song starts on its own levels (no scene). Moves made while a
// scene plays (Perform's faders, ON tiles, a learned MIDI fader, controller.scenes.adjust) are a transient tweak on top
// of it (tweakScene, mergeScene): heard at once, kept by "Save as scene", dropped at the next scene change.
// UIA (native DECISIONS D3): `slots` has one entry per slot of the song, at least SLOT_COUNT (so a 1.x scene keeps
// its 4) and at most MAX_SLOTS; store.removeSlot drops a removed slot's entry from every scene, and (D23)
// store.insertSlot / moveSlot move each entry (its sends included) with its slot.
// D25 (UI v6 U7c, the Save snapshot dialog): an optional `name` (a string, trimmed, at most SCENE_NAME_MAX characters;
// absent = "Scene n"). It names the scene and holds nothing else; no SCHEMA change, and a scene with only a name is
// still unusable (dropped).
import { SLOT_COUNT, MAX_SLOTS, clamp, describe } from './params.js';
import { mod12, transposeSemis } from './music.js';

/** Scenes per song. */
export const SCENE_MAX = 3;
/** D25: the longest scene name kept (longer ones are cut there; the v6 dialog's field has the same maxlength). */
export const SCENE_NAME_MAX = 40;
/** A scene change glides every level this long (v11-scenes: agreed 300–800 ms, no setting). */
export const SCENE_GLIDE_SEC = 0.5;
/**
 * D26.1: the step of the controller's glide of the sends and the Space / Echo levels. The engines glide only slot and
 * drone levels (ENGINE_CONTRACT setParam: `glide` is for slots.<i>.gain and drone.gain); every other row moves with
 * its own τ 15 ms smoothing, so the controller walks those in steps (as the web engine walks a virtual-wheel glide).
 */
export const SCENE_STEP_SEC = 0.05;
/** D26.1: the sends a scene keeps per instrument (Space, Echo; not the chorus). */
export const SCENE_SENDS = Object.freeze(['reverb', 'delay']);
/**
 * D26.1: the Space room and the Echo a scene keeps: exactly the rows shared/fx-presets.js SPACE_PRESETS / ECHO_PRESETS
 * set, so a scene holds whichever preset (or "Custom" setting) and its level was playing.
 */
export const SCENE_FX = Object.freeze({
  reverb: Object.freeze(['size', 'damp', 'predelay', 'returnGain']),
  delay: Object.freeze(['time', 'feedback', 'pingpong', 'tone', 'sync', 'returnGain']),
});
/** D26.1: drone modes a scene can hold (= presets.js DRONE_MODES; shared/ stays free of presets.js). */
export const SCENE_DRONE_MODES = Object.freeze(['off', 'synth', 'files']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const gainOf = (v) => (fin(v) ? clamp('slots.0.gain', v) : null);
const EPS = 1e-6;
const FX_UNITS = Object.keys(SCENE_FX);
/** The levels among SCENE_FX (they glide; the rest is sent like a manual change). */
const isFxLevel = (k) => k === 'returnGain';

/**
 * A scene's value for a param row, or null: numbers clamped to the row (a non-finite one dropped), a boolean row only
 * a boolean, an enum row only one of its values (a bad value is dropped, never coerced).
 */
function rowValue(path, v) {
  const e = describe(path);
  if (!e) return null;
  if (e.unit === 'bool') return typeof v === 'boolean' ? v : null;
  if (e.unit === 'enum') return e.enum.includes(v) ? v : null;
  return fin(v) ? clamp(path, v) : null;
}

/** The level a slot plays at before its mute (store convention: gain 0 + gainBeforeMute while muted). */
function slotLevel(slot) {
  const before = fin(slot.gainBeforeMute) ? slot.gainBeforeMute : fin(slot.mutedGain) ? slot.mutedGain : null;
  const muted = slot.muted === true || (slot.muted === undefined && slot.gain === 0 && before !== null);
  return { gain: muted ? (before ?? 0) : slot.gain, muted };
}

/**
 * D25: a scene name as stored: a string with its whitespace runs folded to one space and trimmed, cut to
 * SCENE_NAME_MAX characters (by code point, so an emoji is never split); null for anything else or an empty name.
 * @param {*} v
 * @returns {string|null}
 */
export function sceneNameOf(v) {
  if (typeof v !== 'string') return null;
  // control characters out (a pasted tab / newline is whitespace and folds to one space)
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const cps = [...t];
  return cps.length > SCENE_NAME_MAX ? cps.slice(0, SCENE_NAME_MAX).join('').trimEnd() : t;
}

/** UIA: entries a scene's `slots` gets: the song's slot count (default SLOT_COUNT), never under SLOT_COUNT. */
const entriesFor = (n) => Math.max(SLOT_COUNT, Math.min(MAX_SLOTS, Number.isInteger(n) ? n : SLOT_COUNT));

/** D26.1: {reverb?, delay?} with the valid sends of `raw`, or null when none is. */
function sendsOf(raw) {
  if (!isObj(raw)) return null;
  const out = {};
  for (const k of SCENE_SENDS) {
    const v = rowValue(`slots.0.sends.${k}`, raw[k]);
    if (v !== null) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** D26.1: {reverb?: {...}, delay?: {...}} with the valid SCENE_FX rows of `raw`, or null when none is. */
function fxOf(raw) {
  if (!isObj(raw)) return null;
  const out = {};
  for (const u of FX_UNITS) {
    if (!isObj(raw[u])) continue;
    const o = {};
    for (const k of SCENE_FX[u]) {
      const v = rowValue(`fx.${u}.${k}`, raw[u][k]);
      if (v !== null) o[k] = v;
    }
    if (Object.keys(o).length) out[u] = o;
  }
  return Object.keys(out).length ? out : null;
}

/** D26.1: a drone key as stored ({pc: 0..11, minor: boolean}), or null. */
function keyOf(raw) {
  if (!isObj(raw) || !Number.isInteger(raw.pc) || typeof raw.minor !== 'boolean') return null;
  return { pc: mod12(raw.pc), minor: raw.minor };
}

/** D26.1: the drone entry ({gain?, mode?, key?}), or null when nothing in it is valid. */
function droneOf(raw) {
  if (!isObj(raw)) return null;
  const out = {};
  const g = gainOf(raw.gain);
  if (g !== null) out.gain = clamp('drone.gain', g);
  if (SCENE_DRONE_MODES.includes(raw.mode)) out.mode = raw.mode;
  const key = keyOf(raw.key);
  if (key) out.key = key;
  return Object.keys(out).length ? out : null;
}

/**
 * A scene in its stored form, or null when nothing in it is usable. Every field is optional and checked on its own
 * (a bad value is dropped, the rest kept); unknown fields are dropped.
 * @param {*} raw
 * @param {number} [slotCount] the song's slot count (UIA; default SLOT_COUNT: 1.x scenes, 4 entries)
 * @returns {{slots:Array<{gain:number, muted?:true, sends?:object}|null>, drone?:object, fx?:object, wheel?:number,
 *   name?:string}|null}
 */
export function normalizeScene(raw, slotCount) {
  if (!isObj(raw)) return null;
  const src = Array.isArray(raw.slots) ? raw.slots : [];
  const slots = [];
  let any = false;
  const n = entriesFor(slotCount);
  for (let i = 0; i < n; i++) {
    const s = src[i];
    const g = isObj(s) ? gainOf(s.gain) : null;
    if (g === null) slots.push(null); // an entry is the slot's level first: sends alone don't make one (D26.1)
    else {
      const e = s.muted === true ? { gain: g, muted: true } : { gain: g };
      const sends = sendsOf(s.sends);
      if (sends) e.sends = sends;
      slots.push(e);
      any = true;
    }
  }
  const out = { slots };
  const drone = droneOf(raw.drone);
  if (drone) {
    out.drone = drone;
    any = true;
  }
  const fx = fxOf(raw.fx);
  if (fx) {
    out.fx = fx;
    any = true;
  }
  if (fin(raw.wheel)) {
    out.wheel = Math.min(1, Math.max(0, raw.wheel));
    any = true;
  }
  const name = sceneNameOf(raw.name); // D25: optional; a bad value is dropped, it never makes a scene usable
  if (name) out.name = name;
  return any ? out : null;
}

/**
 * The stored `scenes` field: at most SCENE_MAX usable scenes, in order (unusable entries dropped).
 * @param {*} raw
 * @param {number} [slotCount] the song's slot count (UIA)
 * @returns {object[]|undefined} undefined = no scenes (the field stays absent)
 */
export function normalizeScenes(raw, slotCount) {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.map((sc) => normalizeScene(sc, slotCount)).filter(Boolean).slice(0, SCENE_MAX);
  return out.length ? out : undefined;
}

/** @param {object|null} song @returns {object[]} the song's scenes ([] when it has none) */
export const scenesOf = (song) => (song && Array.isArray(song.scenes) ? song.scenes : []);

/** True when the song routes the mod wheel somewhere (a scene keeps the wheel only then). */
const wheelRouted = (song) => {
  const t = song && song.patch && song.patch.modWheel ? song.patch.modWheel.target : null;
  return typeof t === 'string' && t !== '' && t !== 'none';
};

/**
 * Snapshot of what the song plays now (pass the live song: applyScene's result while a scene plays).
 * D26.1: also each filled slot's Space / Echo sends, the Space room and Echo (SCENE_FX) and the drone's mode and key.
 * @param {object} song
 * @param {{wheel?:number|null}} [o]  the mod wheel's position now (kept when the song routes the wheel)
 * @returns {object|null} a stored-form scene
 */
export function captureScene(song, { wheel = null } = {}) {
  if (!song || !song.patch) return null;
  const slots = [];
  const n = entriesFor(song.patch.slots.length);
  for (let i = 0; i < n; i++) {
    const s = song.patch.slots[i];
    if (!s) slots.push(null);
    else {
      const l = slotLevel(s);
      const e = l.muted ? { gain: l.gain, muted: true } : { gain: l.gain };
      if (isObj(s.sends)) e.sends = s.sends; // normalizeScene keeps the SCENE_SENDS ones
      slots.push(e);
    }
  }
  const d = song.drone || null;
  const drone = { gain: d ? d.gain : null, mode: d ? d.mode : null };
  if (d && fin(song.hearIn)) drone.key = { pc: song.hearIn, minor: !!song.minor };
  const raw = { slots, drone, fx: song.patch.fx };
  if (fin(wheel) && wheelRouted(song)) raw.wheel = wheel;
  return normalizeScene(raw, n);
}

/** A slot entry with `b` (a tweak's) over `a` (the scene's): the level as a unit, the sends key by key. */
function mergeEntry(a, b) {
  if (!b) return a ?? null;
  if (!a) return b;
  const lvl = fin(b.gain) ? b : a;
  const e = {};
  if (fin(lvl.gain)) {
    e.gain = lvl.gain;
    if (lvl.muted) e.muted = true;
  }
  if (a.sends || b.sends) e.sends = { ...a.sends, ...b.sends };
  return e;
}

/**
 * D26.1: a scene with the live moves made while it plays (a tweakScene result) on top: what the controller plays.
 * The tweak wins field by field (a slot's level and ON as one, each send, each drone field, each fx row).
 * @param {object|null} scene
 * @param {object|null} tweak
 * @returns {object|null}
 */
export function mergeScene(scene, tweak) {
  if (!tweak) return scene;
  if (!scene) return tweak;
  const a = Array.isArray(scene.slots) ? scene.slots : [];
  const b = Array.isArray(tweak.slots) ? tweak.slots : [];
  const slots = Array.from({ length: Math.max(a.length, b.length) }, (_, i) => mergeEntry(a[i], b[i]));
  const out = { ...scene, slots };
  if (scene.drone || tweak.drone) out.drone = { ...scene.drone, ...tweak.drone };
  if (scene.fx || tweak.fx) {
    out.fx = {};
    for (const u of FX_UNITS) {
      if (scene.fx?.[u] || tweak.fx?.[u]) out.fx[u] = { ...scene.fx?.[u], ...tweak.fx?.[u] };
    }
  }
  return out;
}

/**
 * The song as it plays with `scene` on top: each filled slot the scene covers gets the scene's level and mute (store
 * convention) and (D26.1) its sends; the drone its level, mode and key; the fx the scene's Space / Echo rows.
 * Everything else, and the song's identity, stays; patch.fx is the same object when the scene holds no fx.
 * The drone key: hearIn = key.pc and minor = key.minor; playIn moves with it, so the song's transpose
 * (transposeSemis) and the instruments' pitch never change (as the key grid's manual change).
 * @param {object} song
 * @param {object|null} scene  a stored scene, or mergeScene(scene, tweak)
 * @returns {object} a new song object (not frozen), or `song` itself when there is no scene
 */
export function applyScene(song, scene) {
  if (!song || !scene) return song;
  const slots = song.patch.slots.map((s, i) => {
    const sc = scene.slots ? scene.slots[i] : null;
    if (!s || !sc) return s;
    let out = s;
    if (fin(sc.gain)) {
      const { muted: _m, gainBeforeMute: _b, mutedGain: _g, ...rest } = s;
      out = sc.muted ? { ...rest, gain: 0, muted: true, gainBeforeMute: sc.gain, mutedGain: sc.gain }
        : { ...rest, gain: sc.gain };
    }
    if (isObj(sc.sends)) {
      const sends = { ...out.sends };
      for (const k of SCENE_SENDS) if (fin(sc.sends[k])) sends[k] = sc.sends[k];
      out = { ...out, sends };
    }
    return out;
  });
  const sd = scene.drone;
  let drone = song.drone;
  const live = { ...song };
  if (sd && song.drone) {
    drone = { ...song.drone };
    if (fin(sd.gain)) drone.gain = sd.gain;
    if (SCENE_DRONE_MODES.includes(sd.mode)) drone.mode = sd.mode;
    if (isObj(sd.key) && fin(sd.key.pc) && fin(song.hearIn)) {
      const semis = transposeSemis(song.playIn, song.hearIn);
      live.hearIn = mod12(sd.key.pc);
      live.playIn = mod12(live.hearIn - semis);
      live.minor = !!sd.key.minor;
    }
  }
  let fx = song.patch.fx;
  if (isObj(scene.fx) && isObj(fx)) {
    for (const u of FX_UNITS) {
      const o = scene.fx[u];
      if (!isObj(o) || !isObj(fx[u])) continue;
      if (fx === song.patch.fx) fx = { ...fx };
      fx[u] = { ...fx[u] };
      for (const k of SCENE_FX[u]) if (o[k] !== undefined) fx[u][k] = o[k];
    }
  }
  live.patch = { ...song.patch, slots, fx };
  live.drone = drone;
  return live;
}

/**
 * The engine levels a song plays at: 'slots.<i>.gain' (0 while muted: the engine only sees gain) and 'drone.gain'.
 * @param {object} song
 * @returns {Object<string, number>}
 */
export function levelsOf(song) {
  const out = {};
  if (!song) return out;
  song.patch.slots.forEach((s, i) => {
    if (s) out[`slots.${i}.gain`] = s.gain;
  });
  if (song.drone) out['drone.gain'] = song.drone.gain;
  return out;
}

/**
 * D26.1: the other levels a scene moves, which the controller glides in SCENE_STEP_SEC steps: each filled slot's
 * 'slots.<i>.sends.reverb' / '.delay' and 'fx.reverb.returnGain' (Space level) / 'fx.delay.returnGain' (Echo level).
 * @param {object} song
 * @returns {Object<string, number>}
 */
export function mixOf(song) {
  const out = {};
  if (!song) return out;
  song.patch.slots.forEach((s, i) => {
    if (!s || !isObj(s.sends)) return;
    for (const k of SCENE_SENDS) if (fin(s.sends[k])) out[`slots.${i}.sends.${k}`] = s.sends[k];
  });
  const fx = song.patch.fx;
  for (const u of FX_UNITS) if (isObj(fx?.[u]) && fin(fx[u].returnGain)) out[`fx.${u}.returnGain`] = fx[u].returnGain;
  return out;
}

/**
 * D26.1: the Space room / Echo settings a scene moves that are not levels ('fx.reverb.size' … 'fx.delay.sync'). A
 * change is sent as a manual one is (engine.setParam without a glide: the reverb's crossfaded swap, the delay's
 * second line), never stepped.
 * @param {object} song
 * @returns {Object<string, number|boolean|string>}
 */
export function fxSettingsOf(song) {
  const out = {};
  const fx = song && song.patch ? song.patch.fx : null;
  for (const u of FX_UNITS) {
    if (!isObj(fx?.[u])) continue;
    for (const k of SCENE_FX[u]) if (!isFxLevel(k) && fx[u][k] !== undefined) out[`fx.${u}.${k}`] = fx[u][k];
  }
  return out;
}

/**
 * The level writes that take `from` to `to` (paths in both, values differing by more than 1e-6).
 * @param {Object<string, number>} from
 * @param {Object<string, number>} to
 * @returns {Array<[string, number]>}
 */
export function levelDiff(from, to) {
  return Object.entries(to).filter(([p, v]) => p in from && Math.abs(from[p] - v) > EPS);
}

/**
 * D26.1: levelDiff for any row: numbers by 1e-6, booleans / strings by identity.
 * @param {Object<string, *>} from
 * @param {Object<string, *>} to
 * @returns {Array<[string, *]>}
 */
export function paramDiff(from, to) {
  return Object.entries(to).filter(([p, v]) => p in from
    && (fin(v) && fin(from[p]) ? Math.abs(from[p] - v) > EPS : from[p] !== v));
}

/**
 * Next / previous scene. `n` is the playing scene's index (null = the song's own levels). Next from the song's own
 * goes to scene 1 and wraps from the last scene to scene 1, so ONE footswitch cycles the scenes; previous walks back
 * to the song's own levels and stops there.
 * @param {number|null} n
 * @param {number} count  saved scenes
 * @param {1|-1} dir
 * @returns {number|null}
 */
export function stepScene(n, count, dir) {
  if (!(count > 0)) return null;
  const cur = n === null || n === undefined ? null : Math.min(n, count - 1);
  if (dir > 0) return cur === null || cur >= count - 1 ? 0 : cur + 1;
  return cur === null || cur === 0 ? null : cur - 1;
}

/**
 * Scenes with scene `n` set to `scene` (n ≤ the count: replace one, or add the next). @returns {object[]|null}
 */
export function withScene(scenes, n, scene) {
  const list = Array.isArray(scenes) ? scenes.slice() : [];
  if (!Number.isInteger(n) || n < 0 || n > list.length || n >= SCENE_MAX || !scene) return null;
  list[n] = scene;
  return list;
}

/** Scenes without scene `n` (later ones move up). @returns {object[]} */
export function withoutScene(scenes, n) {
  const list = Array.isArray(scenes) ? scenes.slice() : [];
  if (Number.isInteger(n) && n >= 0 && n < list.length) list.splice(n, 1);
  return list;
}

const SLOT_TWEAK_RE = /^slots\.(0|[1-9]\d?)\.(gain|muted|sends\.reverb|sends\.delay)$/;
const FX_RE = /^fx\.(reverb|delay)\.([A-Za-z]+)$/;

/**
 * True when the scene holds the field a live move at `path` would change (so the move belongs on top of the scene,
 * controller.scenes.adjust). Paths: 'slots.<i>.gain' | 'slots.<i>.muted' (the slot's entry), and (D26.1)
 * 'slots.<i>.sends.reverb' | '.delay', 'fx.reverb.<row>' | 'fx.delay.<row>' (SCENE_FX), 'drone.gain' | 'drone.mode'
 * | 'drone.key'.
 * @param {object|null} scene
 * @param {string} path
 * @returns {boolean}
 */
export function sceneHolds(scene, path) {
  if (!scene) return false;
  const p = String(path);
  const d = scene.drone;
  if (p === 'drone.gain') return !!d && fin(d.gain);
  if (p === 'drone.mode') return !!d && d.mode !== undefined;
  if (p === 'drone.key') return !!d && isObj(d.key);
  let m = SLOT_TWEAK_RE.exec(p);
  if (m) {
    const e = Array.isArray(scene.slots) ? scene.slots[Number(m[1])] : null;
    return m[2].startsWith('sends.') ? !!e && !!e.sends && fin(e.sends[m[2].slice(6)]) : !!e;
  }
  m = FX_RE.exec(p);
  return !!m && SCENE_FX[m[1]].includes(m[2]) && scene.fx?.[m[1]]?.[m[2]] !== undefined;
}

/**
 * A live move while a scene plays (Perform's faders and ON tiles, a learned MIDI fader). It is held on top of
 * the scene until the next scene change, and "Save as scene" keeps it; the song's own levels and the saved scene stay
 * as they were. So building scenes one after another never rewrites the song's own levels (it always starts on them)
 * or the scene saved a moment ago.
 * @param {object|null} tweak  the moves so far: a partial scene ({slots:[…one per slot, at least 4], drone?, fx?}) or
 *   null
 * @param {object} live  the song as it sounds now (applyScene of the scene and the tweak)
 * @param {string} path  'slots.<i>.gain' | 'slots.<i>.muted' | 'drone.gain', and (D26.1) 'slots.<i>.sends.reverb' |
 *   '.delay', 'fx.reverb.<row>' | 'fx.delay.<row>' (SCENE_FX), 'drone.mode' ('off' | 'synth' | 'files'),
 *   'drone.key' ({pc, minor?}: the key the drone plays; minor absent = as it plays now)
 * @param {number|boolean|string|object} value
 * @returns {object|null} the new tweak; null for anything a scene doesn't hold, a bad value or an empty slot
 */
export function tweakScene(tweak, live, path, value) {
  if (!live || !live.patch) return null;
  const n = entriesFor(live.patch.slots.length);
  const out = { slots: tweak && Array.isArray(tweak.slots) ? tweak.slots.slice() : Array(n).fill(null) };
  while (out.slots.length < n) out.slots.push(null);
  if (tweak && tweak.drone) out.drone = tweak.drone;
  if (tweak && tweak.fx) out.fx = tweak.fx;
  const p = String(path);
  if (p === 'drone.gain') {
    if (!fin(value)) return null;
    out.drone = { ...out.drone, gain: clamp('drone.gain', value) };
    return out;
  }
  if (p === 'drone.mode') {
    if (!SCENE_DRONE_MODES.includes(value)) return null;
    out.drone = { ...out.drone, mode: value };
    return out;
  }
  if (p === 'drone.key') {
    if (!isObj(value) || !fin(value.pc)) return null;
    const minor = value.minor === undefined ? !!live.minor : value.minor === true;
    out.drone = { ...out.drone, key: { pc: mod12(value.pc), minor } };
    return out;
  }
  const f = FX_RE.exec(p);
  if (f) {
    if (!SCENE_FX[f[1]].includes(f[2])) return null;
    const v = rowValue(p, value);
    if (v === null) return null;
    out.fx = { ...out.fx, [f[1]]: { ...out.fx?.[f[1]], [f[2]]: v } };
    return out;
  }
  const m = SLOT_TWEAK_RE.exec(p);
  const i = m ? Number(m[1]) : -1;
  const slot = m && i < n ? live.patch.slots[i] : null;
  if (!slot) return null;
  const prev = out.slots[i] || null;
  let e;
  if (m[2].startsWith('sends.')) {
    const v = rowValue(p, value);
    if (v === null) return null;
    e = { ...prev, sends: { ...prev?.sends, [m[2].slice(6)]: v } };
  } else {
    const l = slotLevel(slot);
    if (m[2] === 'muted') e = value === true ? { gain: l.gain, muted: true } : { gain: l.gain };
    else {
      if (!fin(value)) return null;
      // a fader raised on a muted slot switches it on (the store's muteWrite does the same for the song's own levels)
      e = l.muted && !(value > 0) ? { gain: l.gain, muted: true } : { gain: gainOf(value) };
    }
    if (prev && prev.sends) e.sends = prev.sends;
  }
  out.slots[i] = e;
  return out;
}

/**
 * D26.1: the song's own fields changed under a playing scene (a view, the bus or an import wrote the store) for
 * fields the scene holds (sends, Space / Echo rows, drone mode / key; not the levels, which views move through
 * controller.scenes.adjust as before). Without this the scene would keep playing its value and the change would not
 * be heard; with it the change goes on top of the scene like a live move (the tweak) until the next scene change.
 * `order` (a slot re-order between prev and next: order[j] = prev index of next slot j, -1 = new) pairs the slots.
 * The drone key: a change of the song's own key (the key grid) makes the drone play that key.
 * @param {object|null} tweak
 * @param {object|null} scene  the playing scene (next's)
 * @param {object} prev  the song's own fields before
 * @param {object} next  … and after
 * @param {number[]|null} [order]
 * @returns {object|null} the new tweak, or `tweak` itself when nothing was absorbed
 */
export function absorbEdits(tweak, scene, prev, next, order = null) {
  if (!scene || !prev || !next || prev === next || !prev.patch || !next.patch) return tweak;
  let out = null;
  const t = () => {
    if (!out) {
      const n = entriesFor(next.patch.slots.length);
      const slots = tweak && Array.isArray(tweak.slots) ? tweak.slots.slice() : Array(n).fill(null);
      out = { ...(tweak || {}), slots };
      while (out.slots.length < n) out.slots.push(null);
    }
    return out;
  };
  const ss = Array.isArray(scene.slots) ? scene.slots : [];
  next.patch.slots.forEach((b, j) => {
    const i = order ? order[j] : j;
    const a = Number.isInteger(i) && i >= 0 ? prev.patch.slots[i] : null;
    const e = ss[j];
    if (!a || !b || !e || !e.sends || a.sends === b.sends) return;
    for (const k of SCENE_SENDS) {
      if (!fin(e.sends[k]) || !fin(b.sends?.[k]) || a.sends?.[k] === b.sends[k]) continue;
      const o = t();
      o.slots[j] = { ...o.slots[j], sends: { ...o.slots[j]?.sends, [k]: b.sends[k] } };
    }
  });
  const fa = prev.patch.fx;
  const fb = next.patch.fx;
  if (scene.fx && fa !== fb && isObj(fa) && isObj(fb)) {
    for (const u of FX_UNITS) {
      if (!scene.fx[u] || !isObj(fa[u]) || !isObj(fb[u]) || fa[u] === fb[u]) continue;
      for (const k of SCENE_FX[u]) {
        if (scene.fx[u][k] === undefined || fb[u][k] === undefined || fa[u][k] === fb[u][k]) continue;
        const o = t();
        o.fx = { ...o.fx, [u]: { ...o.fx?.[u], [k]: fb[u][k] } };
      }
    }
  }
  const d = scene.drone;
  if (d && prev.drone && next.drone) {
    if (d.mode !== undefined && prev.drone.mode !== next.drone.mode) {
      const o = t();
      o.drone = { ...o.drone, mode: next.drone.mode };
    }
    if (d.key && (prev.hearIn !== next.hearIn || !!prev.minor !== !!next.minor)) {
      const o = t();
      o.drone = { ...o.drone, key: { pc: mod12(next.hearIn), minor: !!next.minor } };
    }
  }
  return out || tweak;
}

/**
 * True when the song (live) plays exactly what the scene holds: levels and mutes, and (D26.1) the sends, Space / Echo
 * rows and drone fields the scene has (a field it lacks is the song's own, so it always matches). The wheel isn't
 * compared: it moves while playing. Used to tell whether "Save as scene n" would change anything.
 * @param {object|null} scene
 * @param {object} song  the live song
 * @returns {boolean}
 */
export function sceneMatches(scene, song) {
  const cur = captureScene(song);
  if (!scene || !cur) return false;
  const near = (a, b) => (fin(a) && fin(b) ? Math.abs(a - b) <= EPS : a === b);
  for (let i = 0; i < Math.max(scene.slots.length, cur.slots.length); i++) {
    const a = scene.slots[i];
    const b = cur.slots[i];
    if (!a || !b) continue;
    if (!!a.muted !== !!b.muted || Math.abs(a.gain - b.gain) > EPS) return false;
    if (a.sends) for (const k of Object.keys(a.sends)) if (!near(a.sends[k], b.sends?.[k])) return false;
  }
  const sd = scene.drone;
  const cd = cur.drone;
  if (sd && cd) {
    if (fin(sd.gain) && !near(sd.gain, cd.gain)) return false;
    if (sd.mode !== undefined && sd.mode !== cd.mode) return false;
    if (sd.key && cd.key && (sd.key.pc !== cd.key.pc || sd.key.minor !== cd.key.minor)) return false;
  }
  if (scene.fx) {
    for (const u of FX_UNITS) {
      for (const [k, v] of Object.entries(scene.fx[u] || {})) if (!near(v, cur.fx?.[u]?.[k])) return false;
    }
  }
  return true;
}
