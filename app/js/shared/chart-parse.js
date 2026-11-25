// Chart parser (Lane C2, part 1): ChordPro, plain chord-over-lyrics text and the WorshipTools Planning song-list CSV
// → one normalised model. Pure: no DOM, no Web Audio, no fetch (CLAUDE.md: shared/ stays pure). Never throws on bad
// input; anything odd becomes a string in `model.warnings`. Design note: native/docs/lanes/C2-parser.md.
//
// Model: {title, subtitle, artist, key, tempo, timeSig, capo, ccli, copyright,
//         sections:[{name, kind, lines:[{lyric, chords:[{at, chord, annotation?}]}]}], warnings:[]}
// `at` is a UTF-16 index into `lyric` (what String#slice takes, 0..lyric.length); it never splits a surrogate pair
// or a base letter from its combining mark (C2 review F6). key/tempo/timeSig/capo are null when missing.
// No regex here may backtrack super-linearly: every line of a user file goes through them (C2 review F1).

/** File extensions read as ChordPro. */
export const CHORDPRO_EXTS = Object.freeze(['cho', 'chopro', 'chordpro', 'chord', 'crd', 'pro']);

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const NOTE_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
// Key spellings used when a key is transposed (same tables as music.js KEY_NAMES_*).
const KEY_MAJOR = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const KEY_MINOR = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];
const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm']);

const mod12 = (n) => ((n % 12) + 12) % 12;

/** Replace unicode accidentals with ASCII. */
const ascii = (s) => String(s).replace(/♯/g, '#').replace(/♭/g, 'b');

// ---------------------------------------------------------------------------------------------------------------
// Chords

const CHORD_SUFFIX = /^(?:maj|min|dim|aug|sus|add|alt|no|[mM+°ø()#b,/\d-])*$/;
const BASS_RE = /^[A-G][#b]?$/;

/**
 * Split a chord symbol into root, quality/extension suffix and optional bass note.
 * @param {string} chord e.g. 'F#m7b5/C'
 * @returns {{root:string, suffix:string, bass:string|null}|null} null when it is not a chord symbol
 */
export function splitChord(chord) {
  if (typeof chord !== 'string') return null;
  let s = ascii(chord.trim());
  if (!s) return null;
  let bass = null;
  const slash = s.lastIndexOf('/');
  if (slash > 0 && BASS_RE.test(s.slice(slash + 1))) {
    bass = s.slice(slash + 1);
    s = s.slice(0, slash);
  }
  const m = /^([A-G][#b]?)(.*)$/.exec(s);
  if (!m || !CHORD_SUFFIX.test(m[2])) return null;
  return { root: m[1], suffix: m[2], bass };
}

/**
 * True when the token is a chord symbol (C, F#m7, Bb/D, Dsus4, Cadd9/E, ...).
 * @param {string} tok
 * @returns {boolean}
 */
export function isChord(tok) {
  return splitChord(tok) !== null;
}

function pcOf(note) {
  return mod12(NOTE_PC[note[0]] + (note[1] === '#' ? 1 : note[1] === 'b' ? -1 : 0));
}

const LETTERS = 'CDEFGAB';
// Single accidentals a band reads as a typo on a live chart; they fall back to the plain name (E# → F).
const ODD_NAMES = new Set(['E#', 'B#', 'Cb', 'Fb']);

// Scale degree (letter step from the tonic) for each semitone above it: the harmonic chromatic scale, the same for
// major and minor. Major C: C Db D Eb E F F# G Ab A Bb B; minor A: A Bb B C C# D D# E F F# G G#.
const DEGREE_OF_INTERVAL = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6];

// Letter steps from a chord's root to a slash bass, by semitones: 3rd, 5th, 7th, 9th, ... (b5, b6 unless augmented).
const BASS_STEPS = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6];

/** Note name for (letter, pitch class), or null when that needs a double accidental or is E#/B#/Cb/Fb. */
function nameOn(L, pc) {
  const acc = mod12(pc - NOTE_PC[L]);
  const name = acc === 0 ? L : acc === 1 ? L + '#' : acc === 11 ? L + 'b' : null;
  return name && !ODD_NAMES.has(name) ? name : null;
}

/** The key's own spelling of a pitch class (scale notes as the key spells them, others by DEGREE_OF_INTERVAL). */
function keyNoteName(key, pc) {
  const tonic = key.endsWith('m') ? key.slice(0, -1) : key;
  const L = LETTERS[(LETTERS.indexOf(tonic[0]) + DEGREE_OF_INTERVAL[mod12(pc - pcOf(tonic))]) % 7];
  return nameOn(L, pc) ?? (keyPrefersFlats(key) ? FLAT_NAMES : SHARP_NAMES)[pc];
}

/**
 * Spell one note moved by `n` semitones (C2 review F2). Without keys: from `names`. With both keys: a note the author
 * spelled the way the old key would (Eb in G, or a simplified A for Bbb in Db) takes the new key's own spelling; a
 * note spelled on purpose otherwise (G# in C's E/G#) keeps its interval, so the letter moves with the key.
 */
function spellNote(note, n, names, fromKey, toKey) {
  const pc = mod12(pcOf(note) + n);
  if (!fromKey || !toKey) return names[pc];
  if (note === keyNoteName(fromKey, pcOf(note))) return keyNoteName(toKey, pc);
  const shift = LETTERS.indexOf(toKey[0]) - LETTERS.indexOf(fromKey[0]);
  return nameOn(LETTERS[(LETTERS.indexOf(note[0]) + shift + 7) % 7], pc) ?? keyNoteName(toKey, pc);
}

/**
 * Transpose one chord symbol. Slash chords move their bass too; extensions are kept verbatim. Text that is not a
 * chord (N.C., %, annotations) comes back unchanged.
 * With `fromKey` and `toKey` the spelling follows the keys (C2 review F2): a bVI in G (Eb) becomes Db in F, not C#,
 * and E/G# in C becomes A/C# in F. A double accidental or E#/B#/Cb/Fb is never written (F instead of E#). A slash
 * bass is spelled as a tone of its chord in every mode.
 * @param {string} chord
 * @param {number} semitones any integer (negative = down)
 * @param {{preferFlats?:boolean, fromKey?:string, toKey?:string}} [opts] preferFlats (used without keys): true =
 *   flats, false = sharps, absent = flats iff the input already uses a flat
 * @returns {string}
 */
export function transposeChord(chord, semitones, opts = {}) {
  const parts = splitChord(chord);
  if (!parts) return typeof chord === 'string' ? chord : '';
  const n = Number.isFinite(semitones) ? Math.round(semitones) : 0;
  if (mod12(n) === 0) return ascii(chord.trim());
  let flats = opts && typeof opts.preferFlats === 'boolean' ? opts.preferFlats : null;
  if (flats === null) flats = parts.root[1] === 'b' || (parts.bass !== null && parts.bass[1] === 'b');
  const names = flats ? FLAT_NAMES : SHARP_NAMES;
  const fromKey = opts && opts.fromKey ? normalizeKey(opts.fromKey) : null;
  const toKey = opts && opts.toKey ? normalizeKey(opts.toKey) : null;
  const root = spellNote(parts.root, n, names, fromKey, toKey);
  let out = root + parts.suffix;
  if (parts.bass) {
    // The bass of a slash chord is spelled as a tone of its chord (D/F#, never D/Gb; Bmaj7/D#), C2 review F2.
    const pc = mod12(pcOf(parts.bass) + n);
    const iv = mod12(pc - pcOf(root));
    const step = iv === 8 && /aug|\+|#5/.test(parts.suffix) ? 4 : BASS_STEPS[iv];
    out += '/' + (nameOn(LETTERS[(LETTERS.indexOf(root[0]) + step) % 7], pc)
      ?? spellNote(parts.bass, n, names, fromKey, toKey));
  }
  return out;
}

/**
 * Normalise a key name: 'bb' → 'Bb', 'F# minor' → 'F#m', 'C major' → 'C'.
 * @param {string} s
 * @returns {string|null} null when it is not a key
 */
export function normalizeKey(s) {
  if (typeof s !== 'string') return null;
  const m = /^([A-Ga-g])([#b♯♭]?)\s*(.*)$/.exec(s.trim());
  if (!m) return null;
  const rest = m[3].trim();
  const root = m[1].toUpperCase() + ascii(m[2]);
  if (rest === 'M' || /^(maj|major)$/i.test(rest) || rest === '') return root;
  if (rest === 'm' || /^(min|minor|-)$/i.test(rest)) return root + 'm';
  return null;
}

/**
 * Transpose a key name, spelling the result with the usual key spelling (Bb, F#, Ebm, C#m).
 * @param {string} key
 * @param {number} semitones
 * @returns {string|null} null when `key` is not a key
 */
export function transposeKey(key, semitones) {
  const k = normalizeKey(key);
  if (!k) return null;
  const n = Number.isFinite(semitones) ? Math.round(semitones) : 0;
  if (mod12(n) === 0) return k;
  const minor = k.endsWith('m');
  const pc = pcOf(minor ? k.slice(0, -1) : k);
  return (minor ? KEY_MINOR : KEY_MAJOR)[mod12(pc + n)];
}

/**
 * Whether a key is conventionally written with flats (F, Bb, Eb, ... Dm, Gm, Cm ...).
 * @param {string} key
 * @returns {boolean}
 */
export function keyPrefersFlats(key) {
  const k = normalizeKey(key);
  if (!k) return false;
  // Any flat-named tonic (Gb, Cb, Abm, ...) is a flat key, not only the table's 12 spellings (C2 review F10).
  return k[1] === 'b' || FLAT_KEYS.has(k);
}

// ---------------------------------------------------------------------------------------------------------------
// Model helpers

function emptyModel() {
  return {
    title: null, subtitle: null, artist: null, key: null, tempo: null, timeSig: null, capo: null, ccli: null,
    copyright: null, sections: [], warnings: [],
  };
}

function prepare(text) {
  let s = typeof text === 'string' ? text : '';
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.replace(/\r\n?/g, '\n');
}

// Monospace cell width, an approximation of East Asian Width W/F plus the common emoji blocks (C2 review F6).
const WIDE_RE = new RegExp('[\\u1100-\\u115f\\u2e80-\\u303e\\u3041-\\u33ff\\u3400-\\u4dbf\\u4e00-\\u9fff'
  + '\\ua000-\\ua4cf\\uac00-\\ud7a3\\uf900-\\ufaff\\ufe30-\\ufe4f\\uff00-\\uff60\\uffe0-\\uffe6'
  + '\\u{1f300}-\\u{1f64f}\\u{1f680}-\\u{1f6ff}\\u{1f900}-\\u{1f9ff}\\u{1fa70}-\\u{1faff}\\u{20000}-\\u{3fffd}]', 'u');
const ZERO_WIDTH_RE = /^[\p{M}​-‍⁠︀-️]$/u;

function cellWidth(ch) {
  if (ch.charCodeAt(0) < 0x300) return 1; // Latin fast path: nothing below U+0300 is wide or combining
  if (ZERO_WIDTH_RE.test(ch)) return 0;
  return WIDE_RE.test(ch) ? 2 : 1;
}

/**
 * Map a monospace column (from a chord line) to a UTF-16 index into `lyric`: the index of the character whose cell
 * covers `col`. Combining marks stay with their base letter and surrogate pairs are never split (C2 review F6).
 */
function colToIndex(lyric, col) {
  let w = 0;
  for (let i = 0; i < lyric.length;) {
    const ch = String.fromCodePoint(lyric.codePointAt(i));
    const cw = cellWidth(ch);
    if (cw > 0 && col < w + cw) return i;
    w += cw;
    i += ch.length;
  }
  return lyric.length;
}

/** Expand tabs to 4-column stops so chord columns line up the way they looked in an editor. */
function expandTabs(line) {
  if (!line.includes('\t')) return line;
  const out = [];
  let w = 0;
  for (const ch of line) {
    if (ch === '\t') {
      const pad = 4 - (w % 4);
      out.push(' '.repeat(pad));
      w += pad;
    } else {
      out.push(ch);
      w += cellWidth(ch);
    }
  }
  return out.join('');
}

const HEADING_WORDS = {
  verse: ['Verse', 'verse'], chorus: ['Chorus', 'chorus'], refrain: ['Refrain', 'chorus'],
  'pre-chorus': ['Pre-Chorus', 'prechorus'], prechorus: ['Pre-Chorus', 'prechorus'],
  'pre chorus': ['Pre-Chorus', 'prechorus'], bridge: ['Bridge', 'bridge'], tag: ['Tag', 'tag'],
  intro: ['Intro', 'intro'], outro: ['Outro', 'outro'], ending: ['Ending', 'outro'], coda: ['Coda', 'outro'],
  interlude: ['Interlude', 'interlude'], turnaround: ['Turnaround', 'interlude'], vamp: ['Vamp', 'interlude'],
  instrumental: ['Instrumental', 'instrumental'], solo: ['Solo', 'instrumental'], hook: ['Hook', 'other'],
};
// The old single HEADING_RE had four adjacent \s* runs and took >10 s on 'Verse' + 4000 spaces + '!' (C2 review F1).
// Now: a length cap, then anchored strips with one quantifier each, then a plain match.
const HEADING_MAX = 64;
const HEADING_CORE_RE = new RegExp(
  '^(' + Object.keys(HEADING_WORDS).join('|').replace(/ /g, ' ?') + ')(?: ?(\\d{1,2}[a-z]?|[a-z]))?$', 'i');
const REPEAT_TOKEN_RE = /^\(?(?:x ?\d{1,2}|\d{1,2} ?x)\)?$/i;
const DECOR_LEAD = '[*#=- ';
const DECOR_TAIL = ']*:=-# ';

/** Strip '[', '*', '=', '-' ... decoration, and parentheses only when they wrap the whole text ('(Verse 2)'). */
function stripDecor(s) {
  let a = 0;
  let b = s.length;
  for (;;) {
    while (a < b && DECOR_LEAD.includes(s[a])) a++;
    while (b > a && DECOR_TAIL.includes(s[b - 1])) b--;
    if (b - a < 2 || s[a] !== '(' || s[b - 1] !== ')') break;
    a++;
    b--;
  }
  return s.slice(a, b);
}

/**
 * Recognise a section heading line: 'Verse 1', 'Chorus:', '[Bridge]', 'Tag', 'Pre-Chorus', 'Intro', 'Chorus 2x',
 * 'Verse 1 (soft)'. A repeat mark ('x2', '2x', '(x2)') or a trailing parenthetical is dropped from the name.
 * @param {string} text
 * @returns {{name:string, kind:string}|null}
 */
export function parseHeading(text) {
  let s = String(text ?? '').replace(/\s/g, ' ').trim();
  if (!s || s.length > HEADING_MAX) return null;
  s = stripDecor(s);
  // Peel trailing repeat marks and parentheticals ('Chorus 2x', 'Verse 1 (x2)', 'Bridge (build) x2').
  for (let guard = 0; guard < 4; guard++) {
    const sp = s.lastIndexOf(' ');
    const tail = sp >= 0 ? s.slice(sp + 1) : '';
    if (sp > 0 && REPEAT_TOKEN_RE.test(tail)) s = stripDecor(s.slice(0, sp));
    else if (sp > 0 && /^\d{1,2}$/.test(tail) && /x$/i.test(s.slice(0, sp))) s = stripDecor(s.slice(0, sp - 1));
    else if (s.endsWith(')') && s.lastIndexOf('(') > 0) s = stripDecor(s.slice(0, s.lastIndexOf('(')));
    else break;
  }
  const m = HEADING_CORE_RE.exec(s.replace(/ +/g, ' '));
  if (!m) return null;
  const [canon, kind] = HEADING_WORDS[m[1].toLowerCase()];
  return { name: m[2] ? `${canon} ${m[2].toUpperCase()}` : canon, kind };
}

function kindOfEnv(word) {
  const w = word.toLowerCase();
  const table = {
    verse: 'verse', chorus: 'chorus', bridge: 'bridge', tab: 'tab', grid: 'grid', intro: 'intro', outro: 'outro',
    prechorus: 'prechorus', 'pre-chorus': 'prechorus', tag: 'tag', interlude: 'interlude',
    instrumental: 'instrumental',
  };
  return table[w] ?? 'other';
}

/** Field directives shared by ChordPro and the plain-text header. Returns false when `name` is not a field. */
function setField(model, name, rawValue, warn) {
  const value = String(rawValue ?? '').trim();
  const once = (field, v) => {
    if (model[field] !== null && model[field] !== v) warn(`Duplicate ${name}; kept "${model[field]}", ignored "${v}"`);
    else model[field] = v;
  };
  switch (name) {
    case 'title': case 't':
      if (value) once('title', value);
      return true;
    case 'subtitle': case 'st': case 'su':
      if (value) once('subtitle', value);
      return true;
    case 'artist': case 'by':
      if (value) once('artist', value);
      return true;
    case 'author': case 'composer': case 'lyricist': case 'words': case 'music':
      if (value && model.artist === null) model.artist = value;
      return true;
    case 'copyright':
      if (value) once('copyright', value);
      return true;
    case 'key': {
      const k = normalizeKey(value);
      if (k) once('key', k);
      else warn(`Unreadable key "${value}"`);
      return true;
    }
    case 'tempo': case 'bpm': {
      const m = /(\d+(?:\.\d+)?)/.exec(value);
      const bpm = m ? Math.round(Number(m[1])) : NaN;
      if (bpm >= 20 && bpm <= 400) once('tempo', bpm);
      else warn(`Unreadable tempo "${value}"`);
      return true;
    }
    case 'time': {
      const m = /^(\d{1,2})\s*\/\s*(\d{1,2})$/.exec(value);
      if (m) once('timeSig', `${Number(m[1])}/${Number(m[2])}`);
      else warn(`Unreadable time signature "${value}"`);
      return true;
    }
    case 'capo': {
      const m = /^(\d{1,2})(?!\d)/.exec(value); // '3rd fret' reads as 3 (C2 review F13)
      if (!m) warn(`Unreadable capo "${value}"`);
      else if (Number(m[1]) > 0) once('capo', Number(m[1]));
      return true;
    }
    case 'ccli': {
      const digits = value.replace(/[\s#.]/g, '');
      if (/^\d+$/.test(digits)) once('ccli', digits);
      else if (value) warn(`Unreadable CCLI number "${value}"`);
      return true;
    }
    default:
      return false;
  }
}

/** Parse `[C]lyr[G]ics` into {lyric, chords}. Unclosed '[' stays literal text. */
function parseInline(line, warn) {
  let lyric = '';
  const chords = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '[') {
      const end = line.indexOf(']', i + 1);
      if (end < 0) {
        warn('Unclosed "[" kept as text');
        lyric += line.slice(i);
        break;
      }
      const inner = line.slice(i + 1, end).trim();
      if (inner.startsWith('*')) {
        // ChordPro annotation: shown like a chord, never transposed (C2 review F8).
        const text = inner.slice(1).trim();
        if (text) chords.push({ at: lyric.length, chord: text, annotation: true });
      } else if (inner) chords.push({ at: lyric.length, chord: ascii(inner) });
      i = end + 1;
    } else {
      lyric += ch;
      i++;
    }
  }
  const trimmed = lyric.trimEnd();
  return { lyric: trimmed, chords: chords.map((c) => ({ ...c, at: Math.min(c.at, trimmed.length) })) };
}

// ---------------------------------------------------------------------------------------------------------------
// ChordPro

const IGNORED_DIRECTIVES = new Set([
  'define', 'chord', 'new_page', 'np', 'new_physical_page', 'npp', 'column_break', 'colb', 'columns', 'col',
  'pagetype', 'textsize', 'ts', 'textfont', 'tf', 'chordsize', 'cs', 'chordfont', 'cf', 'chordcolour', 'textcolour',
  'titlesize', 'titlefont', 'titlecolour', 'tabsize', 'tabfont', 'highlight', 'image', 'diagrams', 'album', 'year',
  'sorttitle', 'duration', 'tag', 'transpose', 'no_grid', 'ng', 'grid', 'new_song', 'ns', 'footersize', 'footerfont',
  'footercolour', 'headersize', 'headerfont', 'headercolour', 'start_of_part', 'end_of_part',
  // C2 review F11: more spec directives that carry nothing the model holds.
  'arranger', 'titles', 'tabcolour', 'gridfont', 'gridsize', 'gridcolour', 'labelfont', 'labelsize', 'tocfont',
  'tocsize', 'toccolour', 'chordcolor', 'textcolor', 'pagesize',
]);
const ENV_SHORT = { sov: 'verse', soc: 'chorus', sob: 'bridge', sot: 'tab', sog: 'grid' };
const ENV_END_SHORT = { eov: 'verse', eoc: 'chorus', eob: 'bridge', eot: 'tab', eog: 'grid' };
// Delegate environments hold another notation (ABC's [CEG] is not a chord): their lines stay raw (C2 review F11).
const RAW_ENVS = new Set(['tab', 'grid', 'abc', 'ly', 'svg', 'textblock', 'musicxml']);

function envLabel(value) {
  const m = /label\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/i.exec(value);
  if (m) return (m[1] ?? m[2] ?? m[3] ?? '').trim();
  return value.trim();
}

/** One `{name-selector: value}` body → {name, selector, value}, or null when it is not a directive. */
function readDirectiveBody(body) {
  const m = /^\s*([A-Za-z_]\w*)(?:-([\w!]+))?/.exec(body);
  if (!m) return null;
  const rest = body.slice(m[0].length);
  let value;
  if (rest === '') value = '';
  else if (rest.trimStart().startsWith(':')) value = rest.trimStart().slice(1);
  else if (/^\s/.test(rest)) value = rest;
  else return null;
  return { name: m[1], selector: m[2] ?? null, value: value.trim() };
}

/**
 * A line that holds only directives → their list; null when it is a lyric line. Linear: the old one-regex version
 * was cubic on '{t' + spaces with no '}' (C2 review F1). '{title: A}{key: G}' is two directives (F7).
 */
function readDirectiveLine(line) {
  const s = line.trim();
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '{') break;
    const end = s.indexOf('}', i + 1);
    if (end < 0) break;
    const d = readDirectiveBody(s.slice(i + 1, end));
    if (!d) break;
    out.push(d);
    i = end + 1;
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  }
  if (i >= s.length && out.length) return out;
  // Not a clean run: read it as one directive whose value may hold braces ('{c: use {this}}').
  const d = readDirectiveBody(s.slice(1, -1));
  return d ? [d] : null;
}

/**
 * Parse ChordPro text.
 * @param {string} text
 * @returns {object} chart model (see file header)
 */
export function parseChordPro(text) {
  const model = emptyModel();
  const src = prepare(text);
  let cur = null;
  let env = null; // {kind, raw}
  let lineNo = 0;
  const warn = (msg) => model.warnings.push(`Line ${lineNo}: ${msg}`);
  const open = (name, kind) => {
    cur = { name, kind, lines: [] };
    model.sections.push(cur);
    return cur;
  };
  const section = () => cur ?? open('', 'other');

  const directive = (nameRaw, valueRaw, selector) => {
    const name = nameRaw.toLowerCase();
    const value = valueRaw.trim();
    if (selector) {
      // {title-guitar: ...} applies to one instrument or user only (ChordPro 6 selectors); this rig ignores them.
      warn(`Conditional directive {${nameRaw}-${selector}} ignored`);
      return;
    }
    if (name.startsWith('x_')) return; // spec: custom x_ directives are ignored silently
    if (name === 'meta') {
      const m = /^(\S+)\s*(.*)$/.exec(value);
      if (m && setField(model, m[1].toLowerCase(), m[2], warn)) return;
      return;
    }
    if (setField(model, name, value, warn)) return;
    if (name === 'comment' || name === 'c' || name === 'comment_italic' || name === 'ci' || name === 'comment_box'
      || name === 'cb' || name === 'highlight') {
      if (!value) return;
      const h = env ? null : parseHeading(value);
      if (h) open(h.name, h.kind);
      else section().lines.push({ lyric: value, chords: [], comment: true });
      return;
    }
    const startShort = ENV_SHORT[name];
    const startLong = /^start_of_(.+)$/.exec(name);
    if (startShort || startLong) {
      const word = startShort ?? startLong[1];
      if (env) warn(`{${name}} inside an unclosed ${env.kind} block; closing it`);
      const kind = kindOfEnv(word);
      const label = envLabel(value);
      const dflt = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      open(label || dflt, kind);
      env = { kind, raw: RAW_ENVS.has(kind) || RAW_ENVS.has(word.toLowerCase()) };
      return;
    }
    const endShort = ENV_END_SHORT[name];
    const endLong = /^end_of_(.+)$/.exec(name);
    if (endShort || endLong) {
      if (!env) warn(`{${name}} without a matching start`);
      env = null;
      cur = null;
      return;
    }
    if (name === 'chorus') {
      // Recall of the chorus: keep a marker section so the importer can show/expand it.
      const s = open(value || 'Chorus', 'chorus');
      s.recall = true;
      cur = null;
      return;
    }
    if (IGNORED_DIRECTIVES.has(name)) return;
    warn(`Unknown directive {${nameRaw}}`);
  };

  const rawLines = src.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    lineNo = i + 1;
    const raw = rawLines[i].trimEnd(); // not /\s+$/: quadratic on a long inner run of spaces (C2 review F1)
    const ds = readDirectiveLine(raw);
    if (ds) {
      for (const d of ds) directive(d.name, d.value, d.selector);
      continue;
    }
    if (env && env.raw) {
      section().lines.push({ lyric: raw, chords: [] });
      continue;
    }
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    if (!env) {
      const h = parseHeading(raw);
      if (h) {
        open(h.name, h.kind);
        continue;
      }
    }
    section().lines.push(parseInline(expandTabs(raw), warn));
  }
  if (env) model.warnings.push(`End of file: unclosed ${env.kind} block`);
  finish(model, src);
  return model;
}

function finish(model, src) {
  model.sections = model.sections.filter((s) => s.lines.length > 0 || s.recall);
  if (!src.trim()) model.warnings.push('Empty chart');
  else if (!model.sections.length && !model.title && !model.warnings.length) {
    model.warnings.push('No chart content found');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Plain chord-over-lyrics

const CHORD_LINE_EXTRA = new Set(['|', '||', '|:', ':|', '/', '-', '%', 'N.C.', 'NC', '.', '>', '~']);

/**
 * Read one chord-line token. Bar marks stuck to a chord ('|G', 'D:|') and a pair of parentheses ('(C)', an optional
 * chord) are peeled off; `off` is where the chord starts inside the token (C2 review F4).
 * @returns {{chord:string, off:number}|'extra'|null} null = not a chord-line token
 */
function chordToken(t) {
  if (CHORD_LINE_EXTRA.has(t) || REPEAT_TOKEN_RE.test(t)) return 'extra';
  let a = 0;
  let b = t.length;
  while (a < b && (t[a] === '|' || t[a] === ':')) a++;
  while (b > a && (t[b - 1] === '|' || t[b - 1] === ':')) b--;
  if (a === b) return 'extra';
  if (t[a] === '(' && t[b - 1] === ')' && b - a > 2) {
    a++;
    b--;
  }
  const c = t.slice(a, b);
  return isChord(c) ? { chord: ascii(c), off: a } : null;
}

/** Chords of a chord line with their columns, or null when the line is not a chord line (needs one chord). */
function readChordLine(line) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(line))) {
    const r = chordToken(m[0]);
    if (r === null) return null;
    if (r !== 'extra') out.push({ col: m.index + r.off, chord: r.chord });
  }
  return out.length ? out : null;
}

/** 'Intro: G C D' / 'Tag | G | D |' → the heading and the chord part, else null (C2 review F5). */
function headingWithChords(line) {
  const m = /^([^:|]{1,40})[:|]\s*(.*)$/.exec(line.trim());
  if (!m || !m[2]) return null;
  const h = parseHeading(m[1]);
  const chords = h ? readChordLine(m[2]) : null;
  return chords ? { heading: h, chords } : null;
}

// One quantified run before the field and none after it: '(.+?)\s*$' was quadratic on inner spaces (C2 review F1).
const PLAIN_META_RE = /^\s*(title|artist|by|author|key|tempo|bpm|time|capo|ccli|copyright)\s*[:=](.*)$/i;

/**
 * Parse plain chord-over-lyrics text: chord-only lines attach to the following lyric line by column.
 * @param {string} text
 * @returns {object} chart model
 */
export function parsePlainChart(text) {
  const model = emptyModel();
  const src = prepare(text);
  const lines = src.split('\n').map((l) => expandTabs(l).trimEnd());
  let cur = null;
  let lineNo = 0;
  let header = true;
  const warn = (msg) => model.warnings.push(`Line ${lineNo}: ${msg}`);
  const open = (name, kind) => {
    cur = { name, kind, lines: [] };
    model.sections.push(cur);
  };
  // Per-line memo: each line is classified once, not five times (a 100 KB one-line chord run took 170 ms before).
  const memo = new Map();
  const info = (k) => {
    let r = memo.get(k);
    if (!r) {
      const l = lines[k];
      const chords = readChordLine(l);
      const heading = !chords && l.trim() ? parseHeading(l) : null;
      r = { chords, heading, hc: chords || heading || !l.trim() ? null : headingWithChords(l) };
      memo.set(k, r);
    }
    return r;
  };
  const startsBlock = (k) => k < lines.length && (info(k).heading !== null || info(k).hc !== null);

  for (let i = 0; i < lines.length; i++) {
    lineNo = i + 1;
    const line = lines[i];
    if (!line.trim()) continue;
    if (header) {
      const mm = PLAIN_META_RE.exec(line);
      if (mm && mm[2].trim() && setField(model, mm[1].toLowerCase(), mm[2], warn)) continue;
      // Title guess: a lone first line followed by a blank line (or a heading), not chords, not a heading.
      if (model.title === null && !model.sections.length && !info(i).chords && !startsBlock(i)
        && line.trim().length <= 60 && i + 1 < lines.length && (!lines[i + 1].trim() || startsBlock(i + 1))) {
        model.title = line.trim();
        model.warnings.push(`Line ${lineNo}: title guessed from the first line`);
        continue;
      }
    }
    header = false;
    const { heading, hc } = info(i);
    if (heading) {
      open(heading.name, heading.kind);
      continue;
    }
    if (hc) {
      open(hc.heading.name, hc.heading.kind);
      cur.lines.push({ lyric: '', chords: hc.chords.map((t) => ({ at: 0, chord: t.chord })) });
      continue;
    }
    if (!cur) open('', 'other');
    const toks = info(i).chords;
    if (toks) {
      const next = lines[i + 1];
      if (next !== undefined && next.trim() && !info(i + 1).chords && !startsBlock(i + 1)) {
        const lyric = next;
        cur.lines.push({ lyric, chords: toks.map((t) => ({ at: colToIndex(lyric, t.col), chord: t.chord })) });
        i++;
      } else {
        cur.lines.push({ lyric: '', chords: toks.map((t) => ({ at: 0, chord: t.chord })) });
      }
    } else {
      cur.lines.push({ lyric: line, chords: [] });
    }
  }
  finish(model, src);
  return model;
}

// ---------------------------------------------------------------------------------------------------------------
// Format detection and the entry point

/**
 * Decide how to read a file from its name and text.
 * @param {string} name file name (only the extension matters)
 * @param {string} text file contents
 * @returns {'chordpro'|'plain'|'csv'}
 */
export function detectFormat(name, text) {
  const ext = /\.([A-Za-z0-9]+)$/.exec(String(name ?? '').trim())?.[1].toLowerCase() ?? '';
  const s = prepare(text);
  if (CHORDPRO_EXTS.includes(ext)) return 'chordpro';
  if (ext === 'csv') return 'csv';
  // Line by line, not two /m regexes: those crossed newlines and were quadratic in the file size (C2 review F1).
  // Inline chords count only when the bracket holds a chord, so '[Chorus]:' stays plain (F12).
  for (const line of s.split('\n')) {
    if (readDirectiveLine(line)) return 'chordpro';
    const re = /\[([^\]\n]{1,24})\]/g;
    let m;
    let n = 0;
    while ((m = re.exec(line))) {
      if (!isChord(m[1])) continue;
      const after = line[m.index + m[0].length];
      if (++n >= 2 || (after !== undefined && after.trim() !== '')) return 'chordpro';
    }
  }
  if (ext === 'txt' || ext === '') {
    const first = s.split('\n', 1)[0].toLowerCase();
    if (/^(title|song|name)\s*[,;\t]/.test(first.replace(/"/g, '')) && /(author|artist|ccli)/.test(first)) return 'csv';
  }
  return 'plain';
}

/**
 * Parse one chart file. `opts.format` overrides detection. A CSV is a song list, not a chart: it yields an empty model
 * with a warning (use parseSongListCsv).
 * @param {string} text
 * @param {{name?:string, format?:'chordpro'|'plain'|'csv'}} [opts]
 * @returns {object} chart model
 */
export function parseChart(text, opts = {}) {
  try {
    const format = opts.format ?? detectFormat(opts.name ?? '', text);
    if (format === 'chordpro') return parseChordPro(text);
    if (format === 'csv') {
      const m = emptyModel();
      m.warnings.push('This is a song list (CSV), not a chart; use parseSongListCsv');
      return m;
    }
    return parsePlainChart(text);
  } catch (err) { // belt and braces: the contract is "never throw"
    const m = emptyModel();
    m.warnings.push(`Parser error: ${err && err.message ? err.message : err}`);
    return m;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Transposition of a whole chart

/**
 * Transpose a chart. Returns a new model (the input is not changed). The key is respelled from the KEY_MAJOR/MINOR
 * tables; with a key, chords are spelled for the new key (transposeChord fromKey/toKey, C2 review F2).
 * With no key, sharps vs flats follow the chart's own accidentals, else the first chord. n ≡ 0 (mod 12) is an exact
 * copy. Annotations, tab and grid sections are never transposed. Never throws.
 * @param {object} model chart model
 * @param {number} semitones
 * @returns {object}
 */
export function transposeChart(model, semitones) {
  let out;
  try {
    out = JSON.parse(JSON.stringify(model ?? emptyModel()));
  } catch { // circular or BigInt: not a chart model; the contract is "never throw" (C2 review F9)
    out = emptyModel();
    out.warnings.push('transposeChart: input is not a chart model');
    return out;
  }
  const n = Number.isFinite(semitones) ? Math.round(semitones) : 0;
  if (!out || typeof out !== 'object' || mod12(n) === 0 || !Array.isArray(out.sections)) return out;
  // Only well-formed pieces are touched; junk entries are kept as they are (F9).
  const chordLists = [];
  for (const s of out.sections) {
    if (!s || typeof s !== 'object' || s.kind === 'tab' || s.kind === 'grid' || !Array.isArray(s.lines)) continue;
    for (const l of s.lines) {
      if (l && Array.isArray(l.chords)) {
        chordLists.push(l.chords.filter((c) => c && typeof c.chord === 'string' && !c.annotation));
      }
    }
  }
  const all = chordLists.flat();
  let flats;
  const fromKey = typeof out.key === 'string' ? normalizeKey(out.key) : null;
  if (fromKey) {
    out.key = transposeKey(fromKey, n); // spelling then comes from the keys, not from `flats`
  } else {
    const nFlat = all.filter((c) => /^[A-G]b|\/[A-G]b/.test(c.chord)).length;
    const nSharp = all.filter((c) => /^[A-G]#|\/[A-G]#/.test(c.chord)).length;
    if (nFlat !== nSharp) {
      // The chart's own accidentals decide: flat-spelled stays flat-spelled.
      flats = nFlat > nSharp;
    } else if (all.length) {
      const p = splitChord(all[0].chord);
      const minor = p && /^m(?!aj)|^min/.test(p.suffix);
      flats = p ? keyPrefersFlats(transposeKey(p.root + (minor ? 'm' : ''), n)) : false;
    } else flats = false;
  }
  const toKey = fromKey ? out.key : null;
  for (const c of all) c.chord = transposeChord(c.chord, n, { preferFlats: flats, fromKey, toKey });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// WorshipTools Planning song-list CSV

function parseCsvRows(text) {
  const s = prepare(text);
  const firstLine = s.split('\n', 1)[0];
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let q = false;
  for (const ch of firstLine) {
    if (ch === '"') q = !q;
    else if (!q && ch in counts) counts[ch]++;
  }
  const delim = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  const rows = [];
  let row = [];
  let field = '';
  q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"' && field === '') q = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return { rows, unterminated: q };
}

const norm = (h) => h.toLowerCase().replace(/[^a-z]/g, '');
// A quoted cell may hold a line break (RFC 4180); a title or author shows on one line (C2 review F14).
const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/**
 * Parse a WorshipTools Planning song list (Songs › Export list): title, author, CCLI → placeholder songs, each a
 * chart model with no sections. Columns are found by header name, case-insensitively.
 * @param {string} text
 * @returns {{songs:object[], warnings:string[]}}
 */
export function parseSongListCsv(text) {
  const result = { songs: [], warnings: [] };
  try {
    const { rows, unterminated } = parseCsvRows(text);
    if (unterminated) result.warnings.push('Unterminated quote in CSV; last field may be cut off');
    const body = rows.filter((r) => r.some((c) => c.trim() !== ''));
    if (!body.length) {
      result.warnings.push('Empty song list');
      return result;
    }
    const head = body[0].map(norm);
    const find = (names) => head.findIndex((h) => names.includes(h));
    const iTitle = find(['title', 'songtitle', 'song', 'name', 'songname']);
    const iAuthor = find(['author', 'authors', 'artist', 'artists', 'writer', 'writers', 'songwriter', 'songwriters',
      'composer', 'composers']);
    const iCcli = find(['ccli', 'cclisong', 'cclisongnumber', 'ccliclisong', 'ccliclisongnumber', 'cclinumber',
      'ccliclinumber', 'cclisong', 'songnumber']);
    if (iTitle < 0) {
      result.warnings.push('No title column found in the CSV header');
      return result;
    }
    for (let r = 1; r < body.length; r++) {
      const row = body[r];
      const title = oneLine(row[iTitle]);
      if (!title) {
        result.warnings.push(`Row ${r + 1}: no title; skipped`);
        continue;
      }
      const m = emptyModel();
      m.title = title;
      const author = iAuthor >= 0 ? oneLine(row[iAuthor]) : '';
      if (author) m.artist = author;
      const ccli = iCcli >= 0 ? (row[iCcli] ?? '').replace(/[\s#.,]/g, '') : ''; // '1,234,567' (C2 review F14)
      if (/^\d+$/.test(ccli)) m.ccli = ccli;
      else if (ccli) m.warnings.push(`Unreadable CCLI number "${ccli}"`);
      result.songs.push(m);
    }
  } catch (err) {
    result.warnings.push(`Parser error: ${err && err.message ? err.message : err}`);
  }
  return result;
}
