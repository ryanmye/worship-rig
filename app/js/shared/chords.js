// Chord naming from physically held notes (SPEC §5.2, REVIEW 1.22).
import { mod12, pcName } from './music.js';

/**
 * Quality templates in table (tie-break) order. `display` is the suffix after the root name.
 * `omit5` marks templates that may also match with the perfect 5th missing.
 * @type {ReadonlyArray<{quality:string, intervals:number[], display:string, omit5?:boolean}>}
 */
export const CHORD_QUALITIES = Object.freeze([
  { quality: 'maj', intervals: [0, 4, 7], display: '' },
  { quality: 'min', intervals: [0, 3, 7], display: 'm' },
  { quality: 'sus2', intervals: [0, 2, 7], display: '2' }, // worship "C2"
  { quality: 'sus4', intervals: [0, 5, 7], display: 'sus4' },
  { quality: '5', intervals: [0, 7], display: '5' },
  { quality: '7', intervals: [0, 4, 7, 10], display: '7', omit5: true },
  { quality: 'maj7', intervals: [0, 4, 7, 11], display: 'maj7', omit5: true },
  { quality: 'min7', intervals: [0, 3, 7, 10], display: 'm7', omit5: true },
  { quality: 'dim', intervals: [0, 3, 6], display: 'dim' },
  { quality: 'aug', intervals: [0, 4, 8], display: 'aug' },
  { quality: 'add9', intervals: [0, 2, 4, 7], display: 'add9' },
  { quality: '6', intervals: [0, 4, 7, 9], display: '6' },
  { quality: 'min6', intervals: [0, 3, 7, 9], display: 'm6' },
  { quality: '9', intervals: [0, 2, 4, 7, 10], display: '9', omit5: true },
  { quality: 'maj9', intervals: [0, 2, 4, 7, 11], display: 'maj9', omit5: true },
  { quality: 'min9', intervals: [0, 2, 3, 7, 10], display: 'm9', omit5: true },
  { quality: '7sus4', intervals: [0, 5, 7, 10], display: '7sus4' },
  { quality: 'dim7', intervals: [0, 3, 6, 9], display: 'dim7' },
  { quality: 'm7b5', intervals: [0, 3, 6, 10], display: 'm7b5' },
].map((q) => Object.freeze({ ...q, intervals: Object.freeze(q.intervals) })));

// Precomputed bitmasks: full templates, then omit-5 variants.
const PATTERNS = [];
CHORD_QUALITIES.forEach((q, order) => {
  const mask = q.intervals.reduce((m, iv) => m | (1 << iv), 0);
  const nonTriad = Math.max(0, q.intervals.length - 3);
  PATTERNS.push({ q, order, mask, omit5: false, nonTriad });
  if (q.omit5) PATTERNS.push({ q, order, mask: mask & ~(1 << 7), omit5: true, nonTriad });
});

/**
 * @typedef {object} ChordResult
 * @property {string} name      display name, e.g. 'C', 'Am7', 'C2', 'C/E', 'A#' (pref sharp), 'C5'
 * @property {number} root      pitch class
 * @property {string} quality   CHORD_QUALITIES[].quality, or 'note' for a single pitch class
 * @property {number|null} bass pitch class passed as bassPc (null when none given)
 * @property {boolean} [omit5]  true when matched a 7th/9th template with the 5th missing
 */

/**
 * Name the chord formed by held pitch classes.
 * Every held pc is tried as root; a match is exact pitch-class-set equality with a template
 * (7/maj7/min7/9/maj9/min9 may omit the 5th). Tie-break: root == bass (when bassPc is null, pcs[0]
 * acts as the preferred root but no slash is written), then full over omit-5, then fewer non-triad
 * tones, then table order.
 * @param {number[]} pcs pitch classes of physically held notes (any ints; duplicates ok; order: lowest first recommended)
 * @param {number|null} [bassPc=null] pitch class of the lowest held note; added to the set if missing
 * @param {'sharp'|'flat'} [pref='flat'] spelling of black-key roots/basses
 * @returns {ChordResult|null} null for nothing held / unrecognised (caller keeps the previous readout)
 */
export function chordName(pcs, bassPc = null, pref = 'flat') {
  const list = Array.isArray(pcs) ? pcs.filter(Number.isFinite).map(mod12) : [];
  const bass = Number.isFinite(bassPc) ? mod12(bassPc) : null;
  if (bass !== null && !list.includes(bass)) list.unshift(bass);
  const distinct = [...new Set(list)];
  if (distinct.length === 0) return null;
  const preferredRoot = bass ?? list[0];

  if (distinct.length === 1) {
    const pc = distinct[0];
    return { name: pcName(pc, pref), root: pc, quality: 'note', bass };
  }

  let best = null;
  let bestRank = null;
  for (const root of distinct) {
    let mask = 0;
    for (const pc of distinct) mask |= 1 << ((pc - root + 12) % 12);
    for (const p of PATTERNS) {
      if (p.mask !== mask) continue;
      const rank = [root === preferredRoot ? 0 : 1, p.omit5 ? 1 : 0, p.nonTriad, p.order];
      if (!bestRank || lexLess(rank, bestRank)) {
        best = { root, p };
        bestRank = rank;
      }
    }
  }
  if (!best) return null;
  const { root, p } = best;
  let name = pcName(root, pref) + p.q.display;
  if (bass !== null && bass !== root) name += '/' + pcName(bass, pref);
  const out = { name, root, quality: p.q.quality, bass };
  if (p.omit5) out.omit5 = true;
  return out;
}

// Ranks are unique per (root, pattern), so the last component always decides a full tie.
function lexLess(a, b) {
  const last = a.length - 1;
  for (let i = 0; i < last; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return a[last] < b[last];
}
