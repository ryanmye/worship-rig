import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PC_NAMES_MAJOR, PC_NAMES_MINOR, KEY_NAMES_MAJOR, KEY_NAMES_MINOR, KEYS, mod12, keyName, keyPrefersSharps,
  spellingPreference, pcName, noteName, parseNoteName, transposeSemis, noteToFreq, freqToNote,
  relativeMajor, relativeMinor, clampMidi,
} from '../../../app/js/shared/music.js';

test('name tables and aliases', () => {
  assert.deepEqual([...PC_NAMES_MAJOR], ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']);
  assert.deepEqual([...PC_NAMES_MINOR], ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm']);
  assert.equal(KEY_NAMES_MAJOR, PC_NAMES_MAJOR);
  assert.equal(KEY_NAMES_MINOR, PC_NAMES_MINOR);
  assert.ok(Object.isFrozen(PC_NAMES_MAJOR));
});

test('KEYS has 12 {pc, major, minor}', () => {
  assert.equal(KEYS.length, 12);
  KEYS.forEach((k, i) => {
    assert.equal(k.pc, i);
    assert.equal(k.major, PC_NAMES_MAJOR[i]);
    assert.equal(k.minor, PC_NAMES_MINOR[i]);
  });
  assert.deepEqual({ ...KEYS[1] }, { pc: 1, major: 'Db', minor: 'C#m' });
});

test('mod12 handles negatives and large values', () => {
  assert.equal(mod12(-1), 11);
  assert.equal(mod12(-12), 0);
  assert.equal(mod12(25), 1);
  assert.equal(mod12(0), 0);
});

test('keyName', () => {
  assert.equal(keyName(0), 'C');
  assert.equal(keyName(6, false), 'F#');
  assert.equal(keyName(1, true), 'C#m');
  assert.equal(keyName(3, true), 'Ebm');
  assert.equal(keyName(-2), 'Bb');
  assert.equal(keyName(13, true), 'C#m');
});

test('keyPrefersSharps: only names containing #', () => {
  const majors = Array.from({ length: 12 }, (_, pc) => keyPrefersSharps(pc, false));
  const minors = Array.from({ length: 12 }, (_, pc) => keyPrefersSharps(pc, true));
  assert.deepEqual(majors.map((v, i) => (v ? i : -1)).filter((i) => i >= 0), [6]);
  assert.deepEqual(minors.map((v, i) => (v ? i : -1)).filter((i) => i >= 0), [1, 6, 8]);
  assert.equal(keyPrefersSharps(0), false);
});

test('spellingPreference', () => {
  for (const pc of [7, 2, 9, 4, 11, 6]) assert.equal(spellingPreference(pc, false), 'sharp', `major ${pc}`);
  for (const pc of [0, 5, 10, 3, 8, 1]) assert.equal(spellingPreference(pc, false), 'flat', `major ${pc}`);
  for (const pc of [4, 11, 6, 1, 8]) assert.equal(spellingPreference(pc, true), 'sharp', `minor ${pc}`);
  for (const pc of [9, 2, 7, 0, 5, 10, 3]) assert.equal(spellingPreference(pc, true), 'flat', `minor ${pc}`);
  assert.equal(spellingPreference(7), 'sharp'); // default major
});

test('pcName', () => {
  assert.equal(pcName(1), 'Db');
  assert.equal(pcName(1, 'flat'), 'Db');
  assert.equal(pcName(1, 'sharp'), 'C#');
  assert.equal(pcName(6), 'Gb');
  assert.equal(pcName(6, 'sharp'), 'F#');
  assert.equal(pcName(10, 'sharp'), 'A#');
  assert.equal(pcName(4, 'sharp'), 'E');
  assert.equal(pcName(-1), 'B');
});

test('noteName', () => {
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(61), 'Db4');
  assert.equal(noteName(61, 'sharp'), 'C#4');
  assert.equal(noteName(21), 'A0');
  assert.equal(noteName(108), 'C8');
  assert.equal(noteName(0), 'C-1');
  assert.equal(noteName(10), 'Bb-1');
  assert.equal(noteName(127), 'G9');
  assert.equal(noteName(59.6), 'C4'); // rounds
});

test('parseNoteName accepts all spellings', () => {
  const cases = {
    C4: 60, 'C#4': 61, 'c#4': 61, Db4: 61, 'D♭4': 61, 'C♯4': 61, 'Bb-1': 10, 'E♭3': 51, A0: 21, C8: 108,
    'C-1': 0, G9: 127, B3: 59, Cb4: 59, 'B#3': 60, bb4: 70, b4: 71, '  A4 ': 69, 'Fb4': 64, 'E#4': 65,
  };
  for (const [name, midi] of Object.entries(cases)) assert.equal(parseNoteName(name), midi, name);
});

test('parseNoteName round-trips noteName for every MIDI note, both prefs', () => {
  for (let m = 0; m < 128; m++) {
    assert.equal(parseNoteName(noteName(m, 'flat')), m);
    assert.equal(parseNoteName(noteName(m, 'sharp')), m);
  }
});

test('parseNoteName throws on invalid', () => {
  for (const bad of ['', 'H4', 'C', '4', 'C##4', 'Cx4', 'C4.5', 'Do4', 'C 4', 'C#']) {
    assert.throws(() => parseNoteName(bad), TypeError, bad);
  }
  assert.throws(() => parseNoteName(60), TypeError);
  assert.throws(() => parseNoteName(null), TypeError);
  assert.throws(() => parseNoteName('Cb-1'), RangeError); // -1
  assert.throws(() => parseNoteName('G#9'), RangeError); // 128
  assert.throws(() => parseNoteName('C10'), RangeError);
});

test('transposeSemis: range -6..+5, tritone → -6', () => {
  assert.equal(transposeSemis(0, 0), 0);
  assert.equal(transposeSemis(0, 2), 2); // play C hear D
  assert.equal(transposeSemis(2, 0), -2);
  assert.equal(transposeSemis(0, 5), 5); // play C hear F: up a 4th
  assert.equal(transposeSemis(0, 7), -5); // play C hear G: down a 4th
  assert.equal(transposeSemis(0, 6), -6); // tritone
  assert.equal(transposeSemis(6, 0), -6); // tritone other way
  assert.equal(transposeSemis(11, 0), 1);
  assert.equal(transposeSemis(0, 11), -1);
  assert.equal(transposeSemis(7, 2), -5); // G → D
  for (let p = 0; p < 12; p++) {
    for (let h = 0; h < 12; h++) {
      const s = transposeSemis(p, h);
      assert.ok(s >= -6 && s <= 5, `${p}->${h} = ${s}`);
      assert.equal(mod12(p + s), h);
    }
  }
  assert.equal(transposeSemis(-12, 14), 2); // unnormalised inputs
});

test('noteToFreq / freqToNote', () => {
  assert.equal(noteToFreq(69), 440);
  assert.equal(noteToFreq(81), 880);
  assert.ok(Math.abs(noteToFreq(60) - 261.6255653) < 1e-6);
  assert.equal(noteToFreq(69, 442), 442);
  assert.equal(freqToNote(440), 69);
  assert.ok(Math.abs(freqToNote(261.6255653) - 60) < 1e-6);
  assert.ok(Math.abs(freqToNote(442, 442) - 69) < 1e-12);
  for (let m = 0; m < 128; m += 7) assert.ok(Math.abs(freqToNote(noteToFreq(m)) - m) < 1e-9);
  assert.ok(Number.isNaN(freqToNote(0)));
  assert.ok(Number.isNaN(freqToNote(-5)));
});

test('relativeMajor / relativeMinor', () => {
  assert.equal(relativeMajor(9), 0); // Am → C
  assert.equal(relativeMajor(4), 7); // Em → G
  assert.equal(relativeMajor(11), 2);
  assert.equal(relativeMinor(0), 9);
  assert.equal(relativeMinor(7), 4);
  for (let pc = 0; pc < 12; pc++) assert.equal(relativeMinor(relativeMajor(pc)), pc);
});

test('clampMidi', () => {
  assert.equal(clampMidi(60), 60);
  assert.equal(clampMidi(60.4), 60);
  assert.equal(clampMidi(-3), 0);
  assert.equal(clampMidi(200), 127);
  assert.equal(clampMidi(NaN), 0);
  assert.equal(clampMidi(Infinity), 127);
  assert.equal(clampMidi(-Infinity), 0);
});
