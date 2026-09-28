import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chordName, CHORD_QUALITIES } from '../../../app/js/shared/chords.js';

const C = 0, Db = 1, D = 2, Eb = 3, E = 4, F = 5, Gb = 6, G = 7, Ab = 8, A = 9, Bb = 10, B = 11;
const name = (pcs, bass = null, pref) => chordName(pcs, bass, pref)?.name ?? null;

test('required table', () => {
  assert.equal(name([C, E, G]), 'C');
  assert.equal(name([A, C, E]), 'Am');
  assert.equal(name([C, E, G, B]), 'Cmaj7');
  assert.equal(name([E, G, C], E), 'C/E');
  assert.equal(name([A, C, E, G], A), 'Am7');
  assert.equal(name([C, D, G]), 'C2');
  assert.equal(name([C, F, G]), 'Csus4');
  assert.equal(name([D, Gb, A, C]), 'D7');
  assert.equal(name([G, B, D, Gb, A]), 'Gmaj9');
  assert.equal(name([C, Eb, Gb]), 'Cdim');
  assert.equal(name([C, E, Ab]), 'Caug');
  assert.equal(name([F, A, C, E], F), 'Fmaj7');
  assert.equal(name([Bb, D, F], null, 'sharp'), 'A#');
  assert.equal(name([Bb, D, F], null, 'flat'), 'Bb');
  assert.equal(name([Bb, D, F]), 'Bb'); // default flat
  assert.equal(name([C, G]), 'C5');
  assert.equal(name([C, D]), null);
});

test('result shape', () => {
  assert.deepEqual(chordName([E, G, C], E), { name: 'C/E', root: C, quality: 'maj', bass: E });
  assert.deepEqual(chordName([C, E, G]), { name: 'C', root: C, quality: 'maj', bass: null });
  assert.deepEqual(chordName([C, E, G], C), { name: 'C', root: C, quality: 'maj', bass: C });
});

test('Am7 vs C6 decided by bass', () => {
  assert.equal(name([A, C, E, G], A), 'Am7');
  assert.equal(name([C, E, G, A], C), 'C6');
  assert.equal(name([C, E, G, A], E), 'Am7/E'); // neither root is bass → table order (min7 before 6)
  assert.equal(name([A, C, E, G]), 'Am7'); // no bass: pcs[0] preferred
  assert.equal(name([C, E, G, A]), 'C6');
});

test('sus2 / sus4 / add9 / 2 disambiguation', () => {
  assert.equal(name([C, D, G], C), 'C2');
  assert.equal(name([G, C, D], G), 'Gsus4');
  assert.equal(name([C, F, G], F), 'F2');
  assert.equal(name([C, D, E, G], C), 'Cadd9');
  assert.equal(chordName([C, D, G]).quality, 'sus2');
});

test('every template is recognised in root position with every root', () => {
  for (const q of CHORD_QUALITIES) {
    for (let root = 0; root < 12; root++) {
      const pcs = q.intervals.map((iv) => (root + iv) % 12);
      const r = chordName(pcs, root);
      assert.ok(r, `${q.quality} @ ${root}`);
      assert.equal(r.root, root, `${q.quality} @ ${root}`);
      assert.equal(r.quality, q.quality, `${q.quality} @ ${root}`);
      assert.equal(r.bass, root);
      assert.ok(!r.name.includes('/'));
    }
  }
});

test('display suffixes', () => {
  const expected = {
    maj: 'C', min: 'Cm', sus2: 'C2', sus4: 'Csus4', 5: 'C5', 7: 'C7', maj7: 'Cmaj7', min7: 'Cm7', dim: 'Cdim',
    aug: 'Caug', add9: 'Cadd9', 6: 'C6', min6: 'Cm6', 9: 'C9', maj9: 'Cmaj9', min9: 'Cm9', '7sus4': 'C7sus4',
    dim7: 'Cdim7', m7b5: 'Cm7b5',
  };
  for (const q of CHORD_QUALITIES) assert.equal(name(q.intervals, 0), expected[q.quality], q.quality);
  assert.equal(CHORD_QUALITIES.length, 19);
});

test('more voicings', () => {
  assert.equal(name([E, G, B, D], E), 'Em7');
  assert.equal(name([G, B, D, F], G), 'G7');
  assert.equal(name([B, D, F, A], B), 'Bm7b5');
  assert.equal(name([D, F, A, B], D), 'Dm6');
  assert.equal(name([B, D, F, Ab], B), 'Bdim7');
  assert.equal(name([D, F, Ab, B], D), 'Ddim7');
  assert.equal(name([G, C, D, F], G), 'G7sus4');
  assert.equal(name([D, E, Gb, A, C], D), 'D9');
  assert.equal(name([A, B, C, E, G], A), 'Am9');
  assert.equal(name([C, E, G, D], G), 'Cadd9/G');
  assert.equal(name([E, Ab, B], E), 'E');
  assert.equal(name([Ab, C, Eb], Ab), 'Ab');
  assert.equal(name([Ab, C, Eb], Ab, 'sharp'), 'G#');
  assert.equal(name([Gb, Bb, Db], Bb, 'sharp'), 'F#/A#');
  assert.equal(name([Gb, Bb, Db], Bb, 'flat'), 'Gb/Bb');
  assert.equal(name([D, Gb, A], Gb, 'sharp'), 'D/F#');
  assert.equal(name([C, Eb, G], Eb), 'Cm/Eb');
});

test('omit5 variants', () => {
  const r = chordName([C, E, Bb], C);
  assert.equal(r.name, 'C7');
  assert.equal(r.omit5, true);
  assert.equal(name([C, E, B], C), 'Cmaj7');
  assert.equal(name([A, C, G], A), 'Am7');
  assert.equal(name([C, D, E, Bb], C), 'C9');
  assert.equal(name([C, D, E, B], C), 'Cmaj9');
  assert.equal(name([C, D, Eb, Bb], C), 'Cm9');
  assert.equal(chordName([C, E, G, Bb], C).omit5, undefined);
});

test('duplicates, octave-equivalents and unnormalised pcs', () => {
  assert.equal(name([C, E, G, C, G, E]), 'C');
  assert.equal(name([12, 16, 19]), 'C');
  assert.equal(name([60, 64, 67], 52), 'C/E');
  assert.equal(name([-12, -8, -5]), 'C');
});

test('single pitch class → note', () => {
  assert.deepEqual(chordName([Db]), { name: 'Db', root: Db, quality: 'note', bass: null });
  assert.deepEqual(chordName([Db, Db], null, 'sharp'), { name: 'C#', root: Db, quality: 'note', bass: null });
  assert.deepEqual(chordName([E], E), { name: 'E', root: E, quality: 'note', bass: E });
});

test('two pitch classes: power chord or null', () => {
  assert.equal(name([C, G]), 'C5');
  assert.equal(name([G, C], C), 'C5'); // 4th inverted, C in bass
  assert.equal(name([G, C], G), 'C5/G'); // 4th with G in bass: root C, slash rule
  assert.equal(name([G, C]), 'C5');
  assert.equal(name([C, E]), null);
  assert.equal(name([C, Gb]), null);
  assert.equal(name([C, Eb]), null);
  assert.equal(name([C, D]), null);
});

test('unrecognised → null', () => {
  assert.equal(name([C, Db, D]), null);
  assert.equal(name([C, Db, D, Eb, E]), null);
  assert.equal(name([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), null);
});

test('empty / invalid input', () => {
  assert.equal(chordName([]), null);
  assert.equal(chordName(null), null);
  assert.equal(chordName(undefined), null);
  assert.equal(chordName([NaN, 'x']), null);
  assert.equal(chordName([C, E, G], NaN).bass, null);
});

test('bassPc missing from pcs is added', () => {
  assert.equal(name([G, C], E), 'C/E');
  assert.equal(name([], C), 'C');
});

test('symmetric chords resolve by preferred root', () => {
  assert.equal(name([E, Ab, C]), 'Eaug');
  assert.equal(name([E, Ab, C], Ab), 'Abaug');
  assert.equal(name([Eb, Gb, A, C]), 'Ebdim7');
  assert.equal(name([A, C, Eb, Gb], A), 'Adim7');
});

test('table order when the bass is not a possible root', () => {
  // {C,D,G} over D: C2/D and Gsus4/D tie on every other rank → table order (sus2 before sus4)
  assert.equal(name([C, D, G], D), 'C2/D');
  assert.equal(name([G, C, D], D), 'C2/D');
  assert.equal(name([F, G, C], C), 'Csus4');
});
