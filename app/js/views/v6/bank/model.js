// Song bank browser model (UI v6 U7a, native DECISIONS D17; mockup native/docs/design/mockups/song-bank.html). Pure:
// no DOM, no store or controller calls, so the filters are unit-tested in node (test/phase1/shell/ui-v6-bank.test.mjs).
// The browser (bank.js) turns controller.patchPacks().bank (+ controller.bankSong(packId), the song as the library
// would take it) or the library's own songs into rows, and filters them here.
// Rules (O-AW-PP rule 8): bank metadata is for browsing; the song body holds the sound, the key and the tempo. A row's
// key / tempo / time are the song body's (what Try it plays), falling back to the bank metadata when the body has
// none; search is searchBank's (every word in the title or artist, case and accents ignored).
import { searchBank } from '../../../shared/patch-packs.js';
import { keyName } from '../../../shared/music.js';
import { SPACE_PRESETS, ECHO_PRESETS, matchPreset } from '../../../shared/fx-presets.js';

/**
 * Tempo filter bands (U7a's choice, logged in CONTRACT_CHANGES "UI v6 U7a"): Slow below 80 BPM, Mid 80 to 114,
 * Fast 115 and up. Worship ballads sit at 60–76, mid songs at 80–110 and up-tempo ones at 120+, so the edges fall
 * between the usual groups. A song without a tempo matches only Any.
 */
export const TEMPO_BANDS = Object.freeze([
  Object.freeze({ id: 'slow', label: 'Slow', min: 0, max: 80 }),
  Object.freeze({ id: 'mid', label: 'Mid', min: 80, max: 115 }),
  Object.freeze({ id: 'fast', label: 'Fast', min: 115, max: Infinity }),
]);

/**
 * @param {number|null|undefined} bpm
 * @returns {'slow'|'mid'|'fast'|null}
 */
export function tempoBand(bpm) {
  if (typeof bpm !== 'number' || !Number.isFinite(bpm)) return null;
  const b = TEMPO_BANDS.find((x) => bpm >= x.min && bpm < x.max);
  return b ? b.id : null;
}

const PC_OF = Object.freeze({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 });
/** Pitch class of a key name ("Eb", "F#m"), for sorting. @param {string} k @returns {number} */
export function keyPc(k) {
  const m = /^([A-G])(#|b)?(m)?$/.exec(String(k || ''));
  if (!m) return 99;
  return (PC_OF[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? 11 : 0)) % 12;
}
const isMinorKey = (k) => /m$/.test(String(k || ''));

const fx = (song, path) => {
  const [a, b, c] = String(path).split('.');
  if (a === 'fx') return song?.patch?.fx?.[b]?.[c];
  if (a === 'master') return song?.patch?.fx?.master?.[b];
  return undefined;
};

/**
 * "Also in this song": only what the song body has (D17). Drone (when on, in the song's key), Space (when the reverb
 * is up: its preset's name, else "Custom"), Echo (when the delay is up), the chart.
 * @param {object|null} song a normalised song
 * @returns {string[]}
 */
export function alsoIn(song) {
  if (!song || !song.patch) return [];
  const out = [];
  if (song.drone && song.drone.mode && song.drone.mode !== 'off') {
    out.push(`Drone on ${keyName(song.hearIn, song.minor)}${song.drone.mode === 'files' ? ' (My Pads)' : ''}`);
  }
  if (Number(fx(song, 'fx.reverb.returnGain')) > 0) {
    const p = matchPreset(SPACE_PRESETS, (x) => fx(song, x));
    out.push(`Space: ${p ? p.name : 'Custom'}`);
  }
  if (Number(fx(song, 'fx.delay.returnGain')) > 0) {
    const p = matchPreset(ECHO_PRESETS, (x) => fx(song, x));
    out.push(`Echo: ${p ? p.name : 'Custom'}`);
  }
  if (song.chart) out.push('chart ✓');
  return out;
}

/**
 * The song's instruments in order (empty slots left out), each with its position (D15: colour by position).
 * @param {object|null} song
 * @param {(ref:object) => string} name instrument display name (lib.js instrumentNames().name)
 * @returns {{i:number, name:string}[]}
 */
export function instrumentsOf(song, name) {
  const slots = song && song.patch && Array.isArray(song.patch.slots) ? song.patch.slots : [];
  const out = [];
  slots.forEach((s, i) => {
    if (s && s.instrument) out.push({ i, name: name(s.instrument) });
  });
  return out;
}

/**
 * A browser row for a Song bank item.
 * @param {object} it controller.patchPacks().bank[n]
 * @param {object|null} song controller.bankSong(packId)
 * @param {Object<string,string>} [packNames] slug → pack.json name
 * @returns {object}
 */
export function bankRow(it, song, packNames = {}) {
  const key = song ? keyName(song.hearIn, song.minor) : it.originalKey || '';
  const bpm = song && Number.isFinite(song.tempo) ? song.tempo : Number.isFinite(it.bpm) ? it.bpm : null;
  return {
    kind: 'bank', id: it.packId, title: it.title, artist: it.artist || '', pack: it.pack,
    packName: packNames[it.pack] || it.pack, key, originalKey: it.originalKey || '', bpm,
    timeSig: (song && song.timeSig) || it.timeSig || '4/4', tags: Array.isArray(it.tags) ? it.tags.slice() : [],
    inLibrary: it.inLibrary || null, ccli: it.ccli || '', song,
  };
}

/**
 * A browser row for one of the player's own songs ("My library").
 * @param {object} song
 * @param {{packId?:string|null, item?:object|null}} [from] the bank item it came from, if any (its artist and tags)
 * @returns {object}
 */
export function libraryRow(song, from = {}) {
  const it = from.item || null;
  return {
    kind: 'lib', id: song.id, title: song.name, artist: (it && it.artist) || '', pack: it ? it.pack : null,
    packName: '', key: keyName(song.hearIn, song.minor), originalKey: '',
    bpm: Number.isFinite(song.tempo) ? song.tempo : null,
    timeSig: song.timeSig || '4/4', tags: it && Array.isArray(it.tags) ? it.tags.slice() : [], inLibrary: song.id,
    ccli: '', song,
  };
}

/**
 * Key filter options: the keys the rows have, by pitch class (major before minor).
 * @param {object[]} rows
 * @returns {string[]}
 */
export function keyOptions(rows) {
  const keys = [...new Set(rows.map((r) => r.key).filter(Boolean))];
  return keys.sort((a, b) => keyPc(a) - keyPc(b) || Number(isMinorKey(a)) - Number(isMinorKey(b))
    || a.localeCompare(b));
}

/**
 * Feel filter options: every tag with its count, most used first.
 * @param {object[]} rows
 * @returns {{tag:string, n:number}[]}
 */
export function tagOptions(rows) {
  const n = new Map();
  for (const r of rows) for (const t of r.tags) n.set(t, (n.get(t) || 0) + 1);
  return [...n].map(([tag, c]) => ({ tag, n: c })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
}

/**
 * Packs filter options, in the rows' order of first appearance.
 * @param {object[]} rows
 * @returns {{slug:string, name:string, n:number}[]}
 */
export function packOptions(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!r.pack) continue;
    const o = out.get(r.pack) || { slug: r.pack, name: r.packName || r.pack, n: 0 };
    o.n += 1;
    out.set(r.pack, o);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Filter (and sort, by title then artist) rows. Across groups every filter must match; inside Feel any chosen tag
 * matches (gentle or ambient). Packs: a row of a pack in `packsOff` is left out.
 * @param {object[]} rows
 * @param {{q?:string, key?:string, tempo?:string, tags?:Set<string>|string[], packsOff?:Set<string>|string[]}} f
 * @returns {object[]}
 */
export function filterRows(rows, f = {}) {
  const tags = new Set(f.tags || []);
  const off = new Set(f.packsOff || []);
  const key = f.key && f.key !== 'any' ? f.key : null;
  const tempo = f.tempo && f.tempo !== 'any' ? f.tempo : null;
  const kept = rows.filter((r) => (!key || r.key === key)
    && (!tempo || tempoBand(r.bpm) === tempo)
    && (!tags.size || r.tags.some((t) => tags.has(t)))
    && (!r.pack || !off.has(r.pack)));
  return searchBank(kept, f.q || '');
}
