// Pure music-theory helpers shared by store, engine, controller and UI.
// No DOM, no Web Audio. Keys are pitch-class ints 0..11 (C = 0) plus a `minor` flag.

/** Canonical major key names by pitch class (SPEC §5.1 / REVIEW 4.5). */
export const PC_NAMES_MAJOR = Object.freeze(['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']);
/** Canonical minor key names by pitch class. */
export const PC_NAMES_MINOR = Object.freeze(['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm']);
/** SPEC §5.1 aliases. */
export const KEY_NAMES_MAJOR = PC_NAMES_MAJOR;
export const KEY_NAMES_MINOR = PC_NAMES_MINOR;

const FLAT_NAMES = Object.freeze(['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']);
const SHARP_NAMES = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);
const LETTER_PC = Object.freeze({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 });

// Keys whose chord spelling uses sharps: G D A E B F# major; Em Bm F#m C#m G#m minor.
const SHARP_MAJOR = new Set([7, 2, 9, 4, 11, 6]);
const SHARP_MINOR = new Set([4, 11, 6, 1, 8]);

/**
 * Non-negative modulo 12.
 * @param {number} n
 * @returns {number} 0..11
 */
export function mod12(n) {
  return ((Math.round(n) % 12) + 12) % 12;
}

/**
 * The 12 keys: `{ pc, major: 'Db', minor: 'C#m' }`.
 * @type {ReadonlyArray<{pc:number, major:string, minor:string}>}
 */
export const KEYS = Object.freeze(
  PC_NAMES_MAJOR.map((major, pc) => Object.freeze({ pc, major, minor: PC_NAMES_MINOR[pc] })),
);

/**
 * Canonical key name.
 * @param {number} pc pitch class (any integer, reduced mod 12)
 * @param {boolean} [minor=false]
 * @returns {string} e.g. 'Db', 'F#', 'C#m', 'Bbm'
 */
export function keyName(pc, minor = false) {
  const p = mod12(pc);
  return minor ? PC_NAMES_MINOR[p] : PC_NAMES_MAJOR[p];
}

/**
 * True when the canonical key *name* contains a sharp (F# major; C#m, F#m, G#m).
 * @param {number} pc
 * @param {boolean} [minor=false]
 * @returns {boolean}
 */
export function keyPrefersSharps(pc, minor = false) {
  return keyName(pc, minor).includes('#');
}

/**
 * Accidental preference for spelling chords/notes in a key.
 * Sharp keys: G D A E B F# major, Em Bm F#m C#m G#m minor. Everything else (incl. C / Am) spells with flats.
 * @param {number} pc
 * @param {boolean} [minor=false]
 * @returns {'sharp'|'flat'}
 */
export function spellingPreference(pc, minor = false) {
  const p = mod12(pc);
  return (minor ? SHARP_MINOR : SHARP_MAJOR).has(p) ? 'sharp' : 'flat';
}

/**
 * Pitch-class name.
 * @param {number} pc
 * @param {'sharp'|'flat'} [pref='flat']
 * @returns {string} e.g. 'Db' / 'C#'
 */
export function pcName(pc, pref = 'flat') {
  return (pref === 'sharp' ? SHARP_NAMES : FLAT_NAMES)[mod12(pc)];
}

/**
 * MIDI note name with octave (C4 = 60).
 * @param {number} midi
 * @param {'sharp'|'flat'} [pref='flat']
 * @returns {string} e.g. 'Db4', 'Bb-1'
 */
export function noteName(midi, pref = 'flat') {
  const m = Math.round(midi);
  return pcName(m, pref) + String(Math.floor(m / 12) - 1);
}

const NOTE_RE = /^([A-Ga-g])(#|♯|b|♭)?(-?\d+)$/;

/**
 * Parse a note name into a MIDI number (C4 = 60). Accepts `#`, `♯`, `b`, `♭`, either letter case.
 * @param {string} name e.g. 'Db4', 'C#4', 'c#4', 'Bb-1', 'E♭3'
 * @returns {number} integer 0..127
 * @throws {TypeError} not a string / unparseable; {RangeError} outside 0..127
 */
export function parseNoteName(name) {
  if (typeof name !== 'string') throw new TypeError(`parseNoteName: expected string, got ${typeof name}`);
  const m = NOTE_RE.exec(name.trim());
  if (!m) throw new TypeError(`parseNoteName: invalid note name "${name}"`);
  let pc = LETTER_PC[m[1].toUpperCase()];
  if (m[2] === '#' || m[2] === '♯') pc += 1;
  else if (m[2] === 'b' || m[2] === '♭') pc -= 1;
  const midi = (parseInt(m[3], 10) + 1) * 12 + pc;
  if (midi < 0 || midi > 127) throw new RangeError(`parseNoteName: "${name}" is outside MIDI range 0..127`);
  return midi;
}

/**
 * Easy-Transpose shift: semitones to add to played notes so Play-In sounds as Hear-In.
 * `((hear - play + 18) % 12) - 6`, range -6..+5 (tritone → -6). Octave offset is added by the caller.
 * @param {number} playPc
 * @param {number} hearPc
 * @returns {number} -6..5
 */
export function transposeSemis(playPc, hearPc) {
  return ((mod12(hearPc) - mod12(playPc) + 18) % 12) - 6;
}

/**
 * Equal-tempered frequency.
 * @param {number} midi (may be fractional)
 * @param {number} [a4=440]
 * @returns {number} Hz
 */
export function noteToFreq(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Inverse of noteToFreq: fractional MIDI number (round it for the nearest note; the fraction ×100 is cents).
 * @param {number} freq Hz (> 0)
 * @param {number} [a4=440]
 * @returns {number} fractional MIDI number (NaN for freq <= 0)
 */
export function freqToNote(freq, a4 = 440) {
  if (!(freq > 0)) return NaN;
  return 69 + 12 * Math.log2(freq / a4);
}

/**
 * Relative major of a minor key (A minor → C).
 * @param {number} pc minor-key tonic
 * @returns {number}
 */
export function relativeMajor(pc) {
  return (mod12(pc) + 3) % 12;
}

/**
 * Relative minor of a major key (C → A minor).
 * @param {number} pc major-key tonic
 * @returns {number}
 */
export function relativeMinor(pc) {
  return (mod12(pc) + 9) % 12;
}

/**
 * Round and clamp to a valid MIDI note number (NaN → 0).
 * @param {number} n
 * @returns {number} 0..127
 */
export function clampMidi(n) {
  const r = Math.round(n);
  if (!Number.isFinite(r)) return Number.isNaN(r) ? 0 : r > 0 ? 127 : 0;
  return Math.min(127, Math.max(0, r));
}
