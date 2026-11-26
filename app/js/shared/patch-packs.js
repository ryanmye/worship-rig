// Patch packs (2.x step 1, FX-gap-analysis "Where personal content goes"; DECISIONS O-AW-PP). Pure: no DOM, no
// Web Audio. Shared by store.topUpPacks / addPackSong (edit detection, entry checks) and the Song bank picker
// (search). The server (server.js scanUserPatches) does the file-level checks; these are the client's own, because
// the store never trusts what it is handed.
//
// A pack entry, as GET /api/user-patches lists it:
//   { packId:'<slug>:<file>[#n]', pack:'<slug>', file:'<name>.json', n:null|<index>, mtime:<ms>, hash:'<hex>',
//     mode:'auto'|'bank', schema?:<number>, song:{…export-format song…}, bank?:{title, artist, ccli?, originalKey,
//     bpm, timeSig, tags[]} }

/** Pack modes (`<slug>/pack.json` "mode"; absent = 'auto'). */
export const PACK_MODES = Object.freeze(['auto', 'bank']);
/** `<slug>:<file>` or `<slug>:<file>#<n>`: a slug and a file name without ':' / '/' and a .json file. */
export const PACK_ID_RE = /^[^:/\\\0]{1,200}:[^/\\\0]{1,240}\.json(#\d{1,4})?$/i;
export const PACK_ID_MAX = 460;
export const BANK_TEXT_MAX = 120;
export const BANK_TAGS_MAX = 16;
export const BANK_TAG_MAX = 40;
/** Keys such as "C", "F#", "Bb", "Ebm", "C#m". */
export const BANK_KEY_RE = /^[A-G](#|b)?m?$/;
/** Time signatures the metronome knows (click-math validTimeSig accepts these; kept loose here: n/d). */
export const BANK_TIMESIG_RE = /^\d{1,2}\/(2|4|8|16)$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = BANK_TEXT_MAX) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * JSON with object keys sorted, so the same song always gives the same text whatever order its keys were written in
 * (a store write appends a new optional key at the end; an edit undone by hand must read as unedited again).
 * @param {*} v
 * @returns {string}
 */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

/**
 * cyrb53: a fast 53-bit string hash. Only ever compares a song with its own earlier state, so collisions between
 * different songs do not matter. @param {string} s @returns {string} 14 hex digits
 */
export function hash53(s) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * Edit fingerprint of a library song (O-AW-PP rule 3): every stored field except its library `id`. Recorded when the
 * pack writes the song; a song whose fingerprint still matches has not been edited, so a newer pack version may
 * replace it. Any persisted change counts (sounds, levels, mutes, key, notes, chart), and undoing it by hand
 * counts as unedited again.
 * @param {object} song a normalised song
 * @returns {string}
 */
export function songFingerprint(song) {
  if (!isObj(song)) return '';
  const { id, ...rest } = song;
  return hash53(stableStringify(rest));
}

/**
 * Bank metadata, cleaned: unknown fields dropped, bad values dropped (never kept), `title` required.
 * @param {*} raw
 * @param {string} [fallbackTitle] the song's name when the bank block has no title
 * @returns {{title:string, artist?:string, ccli?:string, originalKey?:string, bpm?:number, timeSig?:string,
 *   tags?:string[]}|null}
 */
export function normalizeBank(raw, fallbackTitle) {
  if (!isObj(raw)) return null;
  const title = text(raw.title) || text(fallbackTitle);
  if (!title) return null;
  const out = { title };
  const artist = text(raw.artist);
  if (artist) out.artist = artist;
  const ccli = typeof raw.ccli === 'number' ? String(raw.ccli) : raw.ccli;
  if (typeof ccli === 'string' && /^\d{1,12}$/.test(ccli.trim())) out.ccli = ccli.trim();
  const key = typeof raw.originalKey === 'string' ? raw.originalKey.trim() : '';
  if (BANK_KEY_RE.test(key)) out.originalKey = key;
  const bpm = raw.bpm;
  if (typeof bpm === 'number' && Number.isFinite(bpm) && bpm >= 20 && bpm <= 400) out.bpm = Math.round(bpm * 10) / 10;
  const sig = typeof raw.timeSig === 'string' ? raw.timeSig.trim() : '';
  if (BANK_TIMESIG_RE.test(sig)) out.timeSig = sig;
  if (Array.isArray(raw.tags)) {
    const tags = [...new Set(raw.tags.map((t) => text(t, BANK_TAG_MAX)).filter(Boolean))].slice(0, BANK_TAGS_MAX);
    if (tags.length) out.tags = tags;
  }
  return out;
}

/**
 * True when a pack entry has the shape topUpPacks / addPackSong can use (the song itself is normalised later).
 * @param {*} e
 * @returns {boolean}
 */
export function validPackEntry(e) {
  return isObj(e) && typeof e.packId === 'string' && e.packId.length <= PACK_ID_MAX && PACK_ID_RE.test(e.packId)
    && typeof e.hash === 'string' && e.hash.length > 0 && e.hash.length <= 64 && isObj(e.song) && isObj(e.song.patch);
}

/** @param {*} e @returns {'auto'|'bank'} */
export const packModeOf = (e) => (e && e.mode === 'bank' ? 'bank' : 'auto');

/** Letters NFD does not split (skeptic PP-4: "Søren" must match "soren"). */
const FOLD_EXTRA = Object.freeze({
  ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i',
});
const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[øæœßłđðþı]/g, (c) => FOLD_EXTRA[c]);

/**
 * Song bank search (provisional picker): every word of `query` must appear in the title or the artist (case and
 * accents ignored). An empty query matches everything.
 * @param {{title:string, artist?:string}} item
 * @param {string} query
 * @returns {boolean}
 */
export function bankMatches(item, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${fold(item && item.title)} ${fold(item && item.artist)}`;
  return words.every((w) => hay.includes(w));
}

/**
 * Filter and sort bank items for the picker: matches of `query`, by title then artist.
 * @template {{title:string, artist?:string}} T
 * @param {T[]} items
 * @param {string} [query]
 * @returns {T[]}
 */
export function searchBank(items, query = '') {
  const opts = { sensitivity: 'base', numeric: true };
  const cmp = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, opts);
  return (Array.isArray(items) ? items : []).filter((it) => bankMatches(it, query))
    .sort((a, b) => cmp(a.title, b.title) || cmp(a.artist, b.artist));
}
