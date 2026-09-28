// "Changed since the song was loaded" (H-v2 concept §2, implementation §1 "Baseline + dots").
// Pure: compares a song (the store's current copy) with its Revert snapshot (perform.js `snap.song`) and returns the
// switch-type paths that differ. Perform draws a white dot on each changed control and Revert counts them.
//
// What counts (the watch list): the moves a player makes with a tap: a slot's instrument, Space/Echo/Chorus sends,
// Octave, Sustain; the shared Space (reverb) and Echo (delay) as one entry each; the song key, tempo, swell time; the
// drone's source and switches.
// What never counts:
//  - Faders and levels (slot gain, drone gain, master): continuous playing, so the count would never be 0 (concept §2).
//  - Mutes (`slots.<i>.muted` / the old gain 0 + `mutedGain` convention) and the drone ON tile (mode ↔ 'off'): mutes
//    are playing moves too (OPTIONS.md round-3 fix 2). Revert still restores all of these; they just carry no dot.
// Paths are relative to the song object ('patch.slots.0.octave', 'patch.fx.reverb', 'hearIn'), so a caller builds the
// store path as `songs.<id>.<path>`.

/** Slots in a patch (SPEC §2). The diff also expands `<i>` over longer arrays if a patch ever has them. */
const SLOT_COUNT = 4;

/**
 * Default watch list. `<i>` expands to every slot index; a trailing `.*` compares the whole object and reports the
 * group path once (a Space preset touches four reverb params but is one change).
 */
export const DIFF_WATCH = Object.freeze([
  'patch.slots.<i>.instrument',
  'patch.slots.<i>.sends.reverb',
  'patch.slots.<i>.sends.delay',
  'patch.slots.<i>.sends.chorus',
  'patch.slots.<i>.octave',
  'patch.slots.<i>.sustain',
  'patch.fx.reverb.*',
  'patch.fx.delay.*',
  'hearIn',
  'playIn',
  'transposeOctave',
  'minor',
  'tempo',
  'patch.swell.seconds',
  'drone.mode',
  'drone.chordFollow',
  'drone.continueAcrossSongs',
]);

/** Numbers closer than this are equal (store clamping and JSON round trips never move a value by more). */
const EPS = 1e-6;

/** Per-path comparators that override plain equality. */
const SAME = {
  // The drone ON tile writes mode 'off' ↔ 'synth'|'files'; that is a mute, not a change (round-3 fix 2). Only a change
  // of source (Synth ↔ My Pads) counts.
  'drone.mode': (a, b) => a === b || a === 'off' || b === 'off' || a === undefined || b === undefined,
};

const isObj = (v) => v !== null && typeof v === 'object';

/** Deep equality with a numeric tolerance; `undefined` and a missing key are the same. */
export function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number')
    return Math.abs(a - b) <= EPS || (Number.isNaN(a) && Number.isNaN(b));
  if (!isObj(a) || !isObj(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (!sameValue(a[k], b[k])) return false;
  return true;
}

function getPath(obj, path) {
  let o = obj;
  for (const k of path.split('.')) {
    if (!isObj(o)) return undefined;
    o = o[k];
  }
  return o;
}

function slotCount(song, base) {
  const n = (s) => (Array.isArray(s?.patch?.slots) ? s.patch.slots.length : 0);
  return Math.max(SLOT_COUNT, n(song), n(base));
}

/**
 * Store paths (relative to the song) whose value differs between `song` and its snapshot `base`.
 * Order is stable for display: slot paths first, slot by slot (in watch-list order within a slot), then the
 * song-level paths in watch-list order.
 * @param {object|null} song  the song as it is now (store copy)
 * @param {object|null} base  the Revert snapshot of the same song
 * @param {readonly string[]} [watch=DIFF_WATCH]
 * @returns {Set<string>} e.g. {'patch.slots.0.octave', 'patch.fx.reverb'}; empty when either side is missing
 */
export function changedPaths(song, base, watch = DIFF_WATCH) {
  const out = new Set();
  if (!isObj(song) || !isObj(base)) return out;
  const n = slotCount(song, base);
  const strip = (pattern) => (pattern.endsWith('.*') ? pattern.slice(0, -2) : pattern);
  const slotPats = watch.filter((p) => p.includes('<i>')).map(strip);
  const paths = [];
  for (let i = 0; i < n; i++) for (const pat of slotPats) paths.push(pat.replace('<i>', String(i)));
  for (const pat of watch) if (!pat.includes('<i>')) paths.push(strip(pat));
  for (const p of paths) {
    const a = getPath(song, p);
    const b = getPath(base, p);
    const same = SAME[p] ? SAME[p](a, b) : sameValue(a, b);
    if (!same) out.add(p);
  }
  return out;
}

/**
 * Number of changes Revert would show ("↺ Revert · ● 2 changed").
 * @param {object|null} song
 * @param {object|null} base
 * @returns {number}
 */
export function changedCount(song, base) {
  return changedPaths(song, base).size;
}

/**
 * Is `path` (or anything under it) in the changed set? `hasChange(paths, 'patch.slots.1')` → any change on slot 1.
 * @param {Set<string>|string[]} paths
 * @param {string} prefix
 * @returns {boolean}
 */
export function hasChange(paths, prefix) {
  for (const p of paths) if (p === prefix || p.startsWith(`${prefix}.`)) return true;
  return false;
}

/**
 * The drone mode the ON tile should switch to (OPTIONS.md round-3 fix 5): the snapshot's source when it had one,
 * else Synth. No new store field, so after a reload a song saved with the drone OFF comes back as Synth.
 * @param {object|null} base  the Revert snapshot (or any song object with `drone.mode`)
 * @returns {'synth'|'files'}
 */
export function droneOnMode(base) {
  const m = base?.drone?.mode;
  return m === 'files' ? 'files' : 'synth';
}
