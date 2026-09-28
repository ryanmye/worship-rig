// Shared note-name helpers for the samples download/build scripts.
// MIDI 21 = A0, MIDI 108 = C8 (standard convention used by both sample sources).

const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const A0 = 21;
export const C8 = 108;

export function octaveOf(midi) {
  return Math.floor(midi / 12) - 1;
}

export function flatName(midi) {
  return `${FLAT_NAMES[midi % 12]}${octaveOf(midi)}`;
}

export function sharpName(midi) {
  return `${SHARP_NAMES[midi % 12]}${octaveOf(midi)}`;
}

// All chromatic MIDI notes A0..C8 inclusive.
export function chromaticRange(lo = A0, hi = C8) {
  const out = [];
  for (let m = lo; m <= hi; m++) out.push(m);
  return out;
}

// Every minor third (3 semitones) from A0 up to C8 inclusive: 30 notes.
export function minorThirdRange(lo = A0, hi = C8) {
  const out = [];
  for (let m = lo; m <= hi; m += 3) out.push(m);
  return out;
}

export function midiFromNoteNumber(midi) {
  return midi;
}
