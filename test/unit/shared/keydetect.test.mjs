import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectKeyFromName, tokenize } from '../../../app/js/shared/keydetect.js';

// [name, expected keyName | null, pc?, minor?]
const TABLE = [
  ['Pad - B.mp3', 'B', 11, false],
  ['Bb Worship Pad.mp3', 'Bb', 10, false],
  ['Ambient_Pad_-_F#m.mp3', 'F#m', 6, true],
  ['Pad E flat.mp3', 'Eb', 3, false],
  ['Pad 10 - G.mp3', 'G', 7, false],
  ['Key of G# pad (Ab).wav', 'Ab', 8, false],
  ['A Mighty Fortress Pad in D.mp3', 'D', 2, false],
  ['Emin.mp3', 'Em', 4, true],
  ['CM7 Pad.mp3', 'C', 0, false],
  ['Pad_Bb_minor.mp3', 'Bbm', 10, true],
  ['Deep Ambient.mp3', null],
  ['Pad C3.mp3', 'C', 0, false],
  ['random.mp3', null],
  ['Pad in C#.mp3', 'Db', 1, false],
  ['Db Major Pad.wav', 'Db', 1, false],
  ['A minor.mp3', 'Am', 9, true],
  ['Warm Pads - F# Major.mp3', 'F#', 6, false],
  ['01 C.mp3', 'C', 0, false],
  ['Shimmer Pad Eb (D#).mp3', 'Eb', 3, false],
  ['pad_e.mp3', null],
  ['Pad Am7.mp3', 'Am', 9, true],
  ['Cb pad.mp3', 'B', 11, false],
  ['Pads in the key of E.mp3', 'E', 4, false],
  ['G and D.mp3', null],
  // extra coverage
  ['Pad Fb.mp3', 'E', 4, false],
  ['Pad E#.mp3', 'F', 5, false],
  ['Pad B#.mp3', 'C', 0, false],
  ['Pad E flat minor.mp3', 'Ebm', 3, true],
  ['Pad F sharp.mp3', 'F#', 6, false],
  ['Pad F Sharp Minor.mp3', 'F#m', 6, true],
  ['Pad Eflat.mp3', 'Eb', 3, false],
  ['Pad C♯m.mp3', 'C#m', 1, true],
  ['Pad E♭.mp3', 'Eb', 3, false],
  ['Pad Cmaj7.mp3', 'C', 0, false],
  ['Pad CMaj7.mp3', 'C', 0, false],
  ['Pad Dm7.mp3', 'Dm', 2, true],
  ['Pad Gmin7.mp3', 'Gm', 7, true],
  ['Pad GM.mp3', 'G', 7, false],
  ['Pad Gm.mp3', 'Gm', 7, true],
  ['Pad Bbmaj.mp3', 'Bb', 10, false],
  ['Pad Bbmajor.mp3', 'Bb', 10, false],
  ['Pad Bbminor.mp3', 'Bbm', 10, true],
  ['Pad G Min.mp3', 'Gm', 7, true],
  ['Pad G maj.mp3', 'G', 7, false],
  ['Key of E flat pad.mp3', 'Eb', 3, false],
  ['KEY OF A.mp3', 'A', 9, false],
  ['Pad In F minor.mp3', 'Fm', 5, true],
  ['Swell in Bbm (ambient).mp3', 'Bbm', 10, true],
  ['A Pad.mp3', 'A', 9, false], // bare A is the last candidate → counted
  ['A Pad C3.mp3', 'C', 0, false], // article A followed by a later candidate is dropped
  ['A Pad Ab.mp3', 'Ab', 8, false],
  ['[Worship] Pad, D.m4a', 'D', 2, false],
  ['/Users/ryan/Pads/Foundations - Db.wav', 'Db', 1, false],
  ['C:\\Pads\\Pad - E.wav', 'E', 4, false],
  ['Pad - G', 'G', 7, false], // no extension
  ['Pad C major (Cm).mp3', null], // explicit tie between different keys
  ['Pad C (Cm).mp3', 'Cm', 0, true], // explicit (2) beats bare (1)
  ['C Pad C.mp3', 'C', 0, false], // agreeing candidates
  ['Pad C3 D3.mp3', null], // conflicting octave-style candidates
  ['Pad C3 C4.mp3', 'C', 0, false],
  ['Pad Eb C3.mp3', 'Eb', 3, false], // regular candidate beats octave-style token
  ['in the morning.mp3', null], // "in" followed by a non-key
  ['key of life.mp3', null],
  ['Pad key of.mp3', null], // trailing 'key of' with nothing after
  ['Pad in.mp3', null],
  ['Pad key D.mp3', 'D', 2, false], // 'key' without 'of' is just a word
  ['Pad Cx.mp3', null],
  ['Pad H.mp3', null],
  ['Pad b.mp3', null],
  ['Pad cm.mp3', null],
  ['Pad Bb (in F).mp3', 'F', 5, false], // score 3 beats score 2
  ['Pad key of D in G.mp3', null], // two score-3 candidates disagree
];

for (const [name, key, pc, minor] of TABLE) {
  test(`detectKeyFromName(${JSON.stringify(name)}) → ${key}`, () => {
    const r = detectKeyFromName(name);
    if (key === null) {
      assert.equal(r, null);
      return;
    }
    assert.ok(r, 'expected a result');
    assert.equal(r.keyName, key);
    assert.equal(r.pc, pc);
    assert.equal(r.minor, minor);
    assert.ok([1, 2, 3].includes(r.confidence));
  });
}

test('confidence levels', () => {
  assert.equal(detectKeyFromName('Pad - B.mp3').confidence, 1);
  assert.equal(detectKeyFromName('Pad C3.mp3').confidence, 1);
  assert.equal(detectKeyFromName('Bb Worship Pad.mp3').confidence, 2);
  assert.equal(detectKeyFromName('Pad E flat.mp3').confidence, 2);
  assert.equal(detectKeyFromName('Pad Am.mp3').confidence, 2);
  assert.equal(detectKeyFromName('Key of G# pad (Ab).wav').confidence, 3);
  assert.equal(detectKeyFromName('A Mighty Fortress Pad in D.mp3').confidence, 3);
});

test('result shape', () => {
  assert.deepEqual(detectKeyFromName('Ambient_Pad_-_F#m.mp3'), { pc: 6, minor: true, keyName: 'F#m', confidence: 2 });
});

test('non-string input → null', () => {
  assert.equal(detectKeyFromName(undefined), null);
  assert.equal(detectKeyFromName(null), null);
  assert.equal(detectKeyFromName(42), null);
  assert.equal(detectKeyFromName(''), null);
});

test('tokenize', () => {
  assert.deepEqual(tokenize('Ambient_Pad_-_F#m.mp3'), ['Ambient', 'Pad', 'F#m']);
  assert.deepEqual(tokenize('Key of G# pad (Ab).wav'), ['Key', 'of', 'G#', 'pad', 'Ab']);
  assert.deepEqual(tokenize('a/b/[x] y, z.flac'), ['x', 'y', 'z']);
  assert.deepEqual(tokenize('no extension'), ['no', 'extension']);
  assert.deepEqual(tokenize('Pad.v2.mp3'), ['Pad', 'v2']);
  assert.deepEqual(tokenize('  '), []);
  assert.deepEqual(tokenize(null), []);
});
