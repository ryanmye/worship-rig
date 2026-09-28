// Detect a musical key from a pad file name (SPEC §5.3, REVIEW 1.13).
// Tokenise first (no \b — `_` is a word char and `#` isn't), letters and m/M are case-sensitive.
import { keyName } from './music.js';

const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Single token: letter, optional accidental, optional quality (incl. 7th-chord spellings that imply the mode).
const SINGLE_RE =
  /^([A-G])(#|♯|b|♭|sharp|flat)?(maj7|Maj7|M7|min7|m7|minor|Minor|major|Major|min|Min|maj|Maj|m|M)?$/;
// Letter + octave digit ("Pad C3"): only used when it is the sole candidate.
const OCTAVE_RE = /^([A-G])(#|♯|b|♭)?(-?\d)$/;
const ACC_WORD_RE = /^(flat|sharp)$/i;
const QUALITY_WORD_RE = /^(minor|min|major|maj)$/i;

/**
 * Split a file name into tokens: strips directories and extension, splits on `/[\s_\-().,\[\]]+/`.
 * @param {string} name
 * @returns {string[]}
 */
export function tokenize(name) {
  if (typeof name !== 'string') return [];
  const base = name.replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]{1,5}$/, '');
  return base.split(/[\s_\-().,[\]]+/).filter(Boolean);
}

function accidentalOffset(acc) {
  if (!acc) return 0;
  const a = acc.toLowerCase();
  if (a === '#' || a === '♯' || a === 'sharp') return 1;
  return -1; // b ♭ flat
}

function isMinorQuality(q) {
  // 'm', 'm7', 'min', 'min7', 'minor', 'Min', 'Minor' → minor; 'M', 'M7', 'maj*', 'Maj*', 'major' → major
  return q === 'm' || q === 'm7' || /^min/i.test(q);
}

/**
 * Parse a key expression starting at tokens[i]: "Bb", "F#m", "CM7", "E flat", "E flat minor", "F minor".
 * @returns {{pc:number, minor:boolean, len:number, explicit:boolean, bare:boolean, letter:string}|null}
 */
function parseKeyExpr(tokens, i) {
  const m = SINGLE_RE.exec(tokens[i] ?? '');
  if (!m) return null;
  let acc = m[2] || '';
  let quality = m[3] || '';
  let len = 1;
  if (!acc && ACC_WORD_RE.test(tokens[i + len] ?? '')) {
    acc = tokens[i + len];
    len++;
  }
  if (!quality && QUALITY_WORD_RE.test(tokens[i + len] ?? '')) {
    quality = tokens[i + len];
    len++;
  }
  const pc = (((LETTER_PC[m[1]] + accidentalOffset(acc)) % 12) + 12) % 12;
  const explicit = Boolean(acc || quality);
  return { pc, minor: quality ? isMinorQuality(quality) : false, len, explicit, bare: !explicit, letter: m[1] };
}

/**
 * Detect the key named in a file name.
 * Scoring: "key of X" / "in X" → 3; token with accidental or quality → 2; bare capital letter → 1.
 * A bare "A" (the English article) counts only when it is the last candidate. Letter+octave tokens ("C3")
 * count (confidence 1) only when there are no other candidates and they all agree.
 * The highest score wins; highest-scoring candidates naming different keys → null.
 * @param {string} name file name or path
 * @returns {{pc:number, minor:boolean, keyName:string, confidence:1|2|3}|null}
 */
export function detectKeyFromName(name) {
  const tokens = tokenize(name);
  /** @type {{pc:number, minor:boolean, score:number, pos:number, bareA?:boolean}[]} */
  const cands = [];
  const octaveCands = [];
  for (let i = 0; i < tokens.length; ) {
    const lower = tokens[i].toLowerCase();
    if (lower === 'key' && (tokens[i + 1] ?? '').toLowerCase() === 'of') {
      const k = parseKeyExpr(tokens, i + 2);
      if (k) {
        cands.push({ pc: k.pc, minor: k.minor, score: 3, pos: i });
        i += 2 + k.len;
        continue;
      }
    }
    if (lower === 'in') {
      const k = parseKeyExpr(tokens, i + 1);
      if (k) {
        cands.push({ pc: k.pc, minor: k.minor, score: 3, pos: i });
        i += 1 + k.len;
        continue;
      }
    }
    const k = parseKeyExpr(tokens, i);
    if (k) {
      cands.push({ pc: k.pc, minor: k.minor, score: k.explicit ? 2 : 1, bareA: k.bare && k.letter === 'A', pos: i });
      i += k.len;
      continue;
    }
    const o = OCTAVE_RE.exec(tokens[i]);
    if (o) octaveCands.push({ pc: (((LETTER_PC[o[1]] + accidentalOffset(o[2])) % 12) + 12) % 12, minor: false, score: 1, pos: i });
    i++;
  }

  // Article rule: a bare "A" followed by any later candidate (incl. "C3"-style) is not a key.
  const lastPos = Math.max(-1, ...cands.map((c) => c.pos), ...octaveCands.map((c) => c.pos));
  const counted = cands.filter((c) => !(c.bareA && c.pos !== lastPos));
  const pool = counted.length ? counted : octaveCands;
  if (!pool.length) return null;
  const best = Math.max(...pool.map((c) => c.score));
  const top = pool.filter((c) => c.score === best);
  const first = top[0];
  if (top.some((c) => c.pc !== first.pc || c.minor !== first.minor)) return null;
  return { pc: first.pc, minor: first.minor, keyName: keyName(first.pc, first.minor), confidence: /** @type {1|2|3} */ (best) };
}
