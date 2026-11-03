// Song scenes (v11-scenes; BACKLOG A "Sunday Keys patch snapshots"): up to SCENE_MAX saved "live" states per song,
// stepped by a footswitch, Perform, the bus or a global hotkey. Pure: no DOM, no Web Audio.
//
// What a scene holds: exactly what Perform's faders, ON tiles and wheel move while playing, nothing that changes the
// sound itself (instruments, sends, effects, key) and nothing that would restart a voice:
//   slots[i] = {gain, muted?}  each filled slot's level (the pre-mute level while muted) and its ON tile
//   drone    = {gain}          the drone level (not its ON tile: drone.mode 'off' ↔ on restarts the drone)
//   wheel    = 0..1            the mod-wheel position, only when the song routes the wheel somewhere
// Stored as the optional song field `scenes` (an array, absent until a scene is saved; SCHEMA stays 1). The song's
// own fields stay its base: a scene is an overlay the controller applies on top while it plays (applyScene), so
// Revert, the Edit changed dots (ctx.getBaseline) and the next time the song loads all keep meaning the song itself.
// Which scene plays is transient (controller), and every song starts on its own levels (no scene).
import { SLOT_COUNT, clamp } from './params.js';

/** Scenes per song. */
export const SCENE_MAX = 3;
/** A scene change glides every level this long (v11-scenes: agreed 300–800 ms, no setting). */
export const SCENE_GLIDE_SEC = 0.5;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const gainOf = (v) => (fin(v) ? clamp('slots.0.gain', v) : null);
const EPS = 1e-6;

/** The level a slot plays at before its mute (store convention: gain 0 + gainBeforeMute while muted). */
function slotLevel(slot) {
  const before = fin(slot.gainBeforeMute) ? slot.gainBeforeMute : fin(slot.mutedGain) ? slot.mutedGain : null;
  const muted = slot.muted === true || (slot.muted === undefined && slot.gain === 0 && before !== null);
  return { gain: muted ? (before ?? 0) : slot.gain, muted };
}

/**
 * A scene in its stored form, or null when nothing in it is usable.
 * @param {*} raw
 * @returns {{slots:Array<{gain:number, muted?:true}|null>, drone?:{gain:number}, wheel?:number}|null}
 */
export function normalizeScene(raw) {
  if (!isObj(raw)) return null;
  const src = Array.isArray(raw.slots) ? raw.slots : [];
  const slots = [];
  let any = false;
  for (let i = 0; i < SLOT_COUNT; i++) {
    const s = src[i];
    const g = isObj(s) ? gainOf(s.gain) : null;
    if (g === null) slots.push(null);
    else {
      slots.push(s.muted === true ? { gain: g, muted: true } : { gain: g });
      any = true;
    }
  }
  const out = { slots };
  const dg = isObj(raw.drone) ? gainOf(raw.drone.gain) : null;
  if (dg !== null) {
    out.drone = { gain: clamp('drone.gain', dg) };
    any = true;
  }
  if (fin(raw.wheel)) {
    out.wheel = Math.min(1, Math.max(0, raw.wheel));
    any = true;
  }
  return any ? out : null;
}

/**
 * The stored `scenes` field: at most SCENE_MAX usable scenes, in order (unusable entries dropped).
 * @param {*} raw
 * @returns {object[]|undefined} undefined = no scenes (the field stays absent)
 */
export function normalizeScenes(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.map(normalizeScene).filter(Boolean).slice(0, SCENE_MAX);
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
 * @param {object} song
 * @param {{wheel?:number|null}} [o]  the mod wheel's position now (kept when the song routes the wheel)
 * @returns {object|null} a stored-form scene
 */
export function captureScene(song, { wheel = null } = {}) {
  if (!song || !song.patch) return null;
  const slots = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const s = song.patch.slots[i];
    if (!s) slots.push(null);
    else {
      const l = slotLevel(s);
      slots.push(l.muted ? { gain: l.gain, muted: true } : { gain: l.gain });
    }
  }
  const raw = { slots, drone: { gain: song.drone ? song.drone.gain : null } };
  if (fin(wheel) && wheelRouted(song)) raw.wheel = wheel;
  return normalizeScene(raw);
}

/**
 * The song as it plays with `scene` on top: each filled slot the scene covers gets the scene's level and mute (store
 * convention), and the drone its level. Everything else, and the song's identity, stays; patch.fx is the same object.
 * @param {object} song
 * @param {object|null} scene
 * @returns {object} a new song object (not frozen), or `song` itself when there is no scene
 */
export function applyScene(song, scene) {
  if (!song || !scene) return song;
  const slots = song.patch.slots.map((s, i) => {
    const sc = scene.slots ? scene.slots[i] : null;
    if (!s || !sc) return s;
    const { muted: _m, gainBeforeMute: _b, mutedGain: _g, ...rest } = s;
    return sc.muted ? { ...rest, gain: 0, muted: true, gainBeforeMute: sc.gain, mutedGain: sc.gain } : { ...rest, gain: sc.gain };
  });
  const drone = scene.drone ? { ...song.drone, gain: scene.drone.gain } : song.drone;
  return { ...song, patch: { ...song.patch, slots }, drone };
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
 * The level writes that take `from` to `to` (paths in both, values differing by more than 1e-6).
 * @param {Object<string, number>} from
 * @param {Object<string, number>} to
 * @returns {Array<[string, number]>}
 */
export function levelDiff(from, to) {
  return Object.entries(to).filter(([p, v]) => p in from && Math.abs(from[p] - v) > EPS);
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

/**
 * A live level move while a scene plays (Perform's faders and ON tiles, a learned MIDI fader). It is held on top of
 * the scene until the next scene change, and "Save as scene" keeps it; the song's own levels and the saved scene stay
 * as they were. So building scenes one after another never rewrites the song's own levels (it always starts on them)
 * or the scene saved a moment ago.
 * @param {object|null} tweak  the moves so far: a partial scene ({slots:[…4], drone?}) or null
 * @param {object} live  the song as it sounds now (applyScene of the scene and the tweak)
 * @param {string} path  'slots.<i>.gain' | 'slots.<i>.muted' | 'drone.gain'
 * @param {number|boolean} value
 * @returns {object|null} the new tweak; null for anything that isn't a level of a filled slot or the drone
 */
export function tweakScene(tweak, live, path, value) {
  if (!live || !live.patch) return null;
  const out = { slots: tweak && Array.isArray(tweak.slots) ? tweak.slots.slice() : [null, null, null, null] };
  if (tweak && tweak.drone) out.drone = tweak.drone;
  if (path === 'drone.gain') {
    if (!fin(value)) return null;
    out.drone = { gain: clamp('drone.gain', value) };
    return out;
  }
  const m = /^slots\.([0-3])\.(gain|muted)$/.exec(String(path));
  const slot = m ? live.patch.slots[Number(m[1])] : null;
  if (!slot) return null;
  const l = slotLevel(slot);
  let e;
  if (m[2] === 'muted') e = value === true ? { gain: l.gain, muted: true } : { gain: l.gain };
  else {
    if (!fin(value)) return null;
    // a fader raised on a muted slot switches it on (the store's muteWrite does the same for the song's own levels)
    e = l.muted && !(value > 0) ? { gain: l.gain, muted: true } : { gain: gainOf(value) };
  }
  out.slots[Number(m[1])] = e;
  return out;
}

/**
 * True when the song (live) plays exactly the scene's levels and mutes (the wheel isn't compared: it moves while
 * playing). Used to tell whether "Save as scene n" would change anything.
 */
export function sceneMatches(scene, song) {
  const cur = captureScene(song);
  if (!scene || !cur) return false;
  for (let i = 0; i < SLOT_COUNT; i++) {
    const a = scene.slots[i];
    const b = cur.slots[i];
    if (!a || !b) continue;
    if (!!a.muted !== !!b.muted || Math.abs(a.gain - b.gain) > EPS) return false;
  }
  if (scene.drone && cur.drone && Math.abs(scene.drone.gain - cur.drone.gain) > EPS) return false;
  return true;
}
