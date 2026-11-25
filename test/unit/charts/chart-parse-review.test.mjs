// Skeptic tests for the chart parser (native/docs/reviews/C2-parser.md). Every chart here was written for the test;
// no song text is copied. Findings are cited as F<n>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChart, parseChordPro, parsePlainChart, parseSongListCsv, detectFormat, transposeChord, transposeChart,
  transposeKey, keyPrefersFlats, parseHeading, isChord, splitChord,
} from '../../../app/js/shared/chart-parse.js';

const chordsOf = (line) => line.chords.map((c) => c.chord);
const firstLine = (m) => m.sections[0].lines[0];

// ---------------------------------------------------------------------------------------------------------------
// 1. Never throws, bounded time (F1, F9)

/** Small seeded PRNG so a failure is reproducible. */
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

const ALPHABET = [
  '{', '}', '[', ']', '|', ':', '\t', '\r', '\n', '\r\n', ' ', '  ', '\0', '"', ',', ';', '*', '#', '/', '(', ')',
  'C', 'G', 'Am', 'F#m7', 'Bb/D', 'x2', 'Verse 1', 'Chorus', 'title', 'sov', 'eoc', 'start_of_tab', 'label="',
  '😀', '\ud83d', '\ude00', 'שלום', 'é', 'é', '主', '﻿', '‍', '♭', '♯', 'N.C.', '-', '=', 'x',
];

function randomText(r, len) {
  let s = '';
  while (s.length < len) s += ALPHABET[Math.floor(r() * ALPHABET.length)];
  return s;
}

function checkModel(m, label, src = '') {
  assert.ok(m && Array.isArray(m.sections) && Array.isArray(m.warnings), label);
  for (const s of m.sections) {
    for (const l of s.lines) {
      assert.equal(typeof l.lyric, 'string', label);
      for (const c of l.chords) {
        assert.ok(Number.isInteger(c.at) && c.at >= 0 && c.at <= l.lyric.length, `${label}: at ${c.at}`);
        // F6: never between the halves of a surrogate pair (for well-formed input; '\ud83d[C]\ude00' joins).
        if (typeof src === 'string' && !src.isWellFormed()) continue;
        const hi = l.lyric.charCodeAt(c.at - 1);
        const lo = l.lyric.charCodeAt(c.at);
        assert.ok(!(hi >= 0xd800 && hi < 0xdc00 && lo >= 0xdc00 && lo < 0xe000), `${label}: split pair at ${c.at}`);
      }
    }
  }
  JSON.stringify(m);
}

test('fuzz: 400 random charts through every entry point never throw', () => {
  const r = rng(0xc2);
  for (let k = 0; k < 400; k++) {
    const t = randomText(r, 1 + Math.floor(r() * 400));
    for (const fmt of ['chordpro', 'plain', 'csv', undefined]) {
      checkModel(parseChart(t, { format: fmt }), `#${k} ${fmt}`, t);
    }
    checkModel(parseChordPro(t), `#${k} cpro`, t);
    const p = parsePlainChart(t);
    checkModel(p, `#${k} plain`, t);
    assert.ok(Array.isArray(parseSongListCsv(t).songs));
    assert.ok(['chordpro', 'plain', 'csv'].includes(detectFormat('x.txt', t)));
    parseHeading(t);
    for (const n of [1, -5, 6]) checkModel(transposeChart(p, n), `#${k} transpose`, t);
  }
});

test('fuzz: random UTF-16 code units (lone surrogates, NUL, controls)', () => {
  const r = rng(7);
  for (let k = 0; k < 100; k++) {
    let t = '';
    for (let i = 0; i < 300; i++) t += String.fromCharCode(Math.floor(r() * 0x10000));
    checkModel(parseChart(t), `#${k}`, t);
    checkModel(parseChart(t, { format: 'chordpro' }), `#${k}`, t);
    assert.ok(Array.isArray(parseSongListCsv(t).songs));
  }
});

test('1 MB inputs parse in bounded time', () => {
  const r = rng(99);
  const big = randomText(r, 1 << 20);
  const t0 = performance.now();
  checkModel(parseChart(big, { format: 'chordpro' }), 'cpro 1MB', big);
  checkModel(parseChart(big, { format: 'plain' }), 'plain 1MB', big);
  parseSongListCsv(big);
  detectFormat('x.txt', big);
  assert.ok(performance.now() - t0 < 10000, `1 MB took ${performance.now() - t0} ms`);
});

// F1: each of these took seconds to minutes before the fix ('Verse' + 4000 spaces + '!' > 10 s). A linear parser
// does 100 KB in ~10-60 ms here; the 600 ms ceiling only leaves room for a slow shared CI box.
const PATHOLOGICAL = {
  'inner spaces': () => 'a' + ' '.repeat(1e5) + 'b',
  'heading + spaces': () => 'Verse' + ' '.repeat(1e5) + '!',
  'directive, no close': () => '{t' + ' '.repeat(1e5) + 'x',
  'meta + spaces': () => 'key: a' + ' '.repeat(1e5) + 'b',
  'open brackets': () => '[A'.repeat(5e4),
  'directive lines': () => '{t\n'.repeat(33333),
  'newlines then brace': () => '\n'.repeat(1e5) + '{x',
  braces: () => '{'.repeat(1e5),
  'close brackets': () => ']'.repeat(1e5),
  'long chord run': () => 'C '.repeat(5e4) + 'x',
  'chord suffix run': () => 'C' + 'm'.repeat(1e5) + 'x',
  'bracket + spaces': () => '[' + ' '.repeat(1e5) + 'x',
  quotes: () => '"'.repeat(1e5),
  'heading words': () => 'Chorus '.repeat(14286),
  'bars': () => '|'.repeat(1e5) + 'x',
};
for (const [name, make] of Object.entries(PATHOLOGICAL)) {
  test(`ReDoS: ${name} (100 KB) stays linear`, () => {
    const s = make();
    for (const [fn, f] of [['plain', parsePlainChart], ['chordpro', parseChordPro], ['csv', parseSongListCsv],
      ['detect', (t) => detectFormat('x.txt', t)], ['heading', parseHeading], ['isChord', isChord]]) {
      const t0 = performance.now();
      f(s);
      const dt = performance.now() - t0;
      assert.ok(dt < 600, `${fn} took ${dt.toFixed(0)} ms`);
    }
  });
}

test('transposeChart never throws on malformed models (F9)', () => {
  const circ = { sections: [] };
  circ.self = circ;
  for (const m of [{ sections: [null] }, { sections: [{ lines: null }] }, { sections: [{ lines: [null] }] },
    { sections: [{ lines: [{ chords: [null, 5, { chord: 3 }] }] }] }, { key: 'G', sections: [{ lines: [{}] }] },
    { key: 42, sections: [] }, circ, 'text', 7, { sections: 'x' }]) {
    assert.doesNotThrow(() => transposeChart(m, 2), JSON.stringify(m === circ ? 'circular' : m));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 2. ChordPro against the spec

test('directive names and short forms, any case', () => {
  const cases = [
    ['{title: X}', 'title', 'X'], ['{t: X}', 'title', 'X'], ['{TITLE:X}', 'title', 'X'],
    ['{ Title : X }', 'title', 'X'],
    ['{subtitle: S}', 'subtitle', 'S'], ['{st: S}', 'subtitle', 'S'], ['{artist: A}', 'artist', 'A'],
    ['{composer: A}', 'artist', 'A'], ['{lyricist: A}', 'artist', 'A'], ['{copyright: 2026 Nobody}', 'copyright',
      '2026 Nobody'], ['{key: Eb}', 'key', 'Eb'], ['{Key: f# minor}', 'key', 'F#m'], ['{tempo: 132}', 'tempo', 132],
    ['{time: 12/8}', 'timeSig', '12/8'], ['{capo: 2}', 'capo', 2], ['{capo: 3rd fret}', 'capo', 3],
    ['{ccli: 7654321}', 'ccli', '7654321'], ['{meta: artist M}', 'artist', 'M'], ['{meta: time 3/4}', 'timeSig', '3/4'],
  ];
  for (const [src, field, want] of cases) assert.equal(parseChordPro(src)[field], want, src);
});

test('comment aliases c / ci / cb / highlight make comment lines', () => {
  for (const d of ['c', 'comment', 'ci', 'comment_italic', 'cb', 'comment_box', 'highlight']) {
    const m = parseChordPro(`{sov}\n{${d}: gently}\n{eov}`);
    assert.deepEqual(firstLine(m), { lyric: 'gently', chords: [], comment: true }, d);
  }
});

test('section labels: sov value, label= attribute, long and short, any case', () => {
  const names = (t) => parseChordPro(t).sections.map((s) => [s.name, s.kind]);
  assert.deepEqual(names('{sov: Verse 2}\nx\n{eov}'), [['Verse 2', 'verse']]);
  assert.deepEqual(names('{sov Verse 2}\nx\n{eov}'), [['Verse 2', 'verse']]);
  assert.deepEqual(names('{start_of_verse label="Verse 2"}\nx\n{end_of_verse}'), [['Verse 2', 'verse']]);
  assert.deepEqual(names("{start_of_verse: label='Verse 3'}\nx\n{end_of_verse}"), [['Verse 3', 'verse']]);
  assert.deepEqual(names('{SOC}\nx\n{EOC}'), [['Chorus', 'chorus']]);
  assert.deepEqual(names('{start_of_bridge: Lift}\nx\n{eob}'), [['Lift', 'bridge']]);
  assert.deepEqual(names('{start_of_intro}\n[G]x\n{end_of_intro}'), [['Intro', 'intro']]);
});

test('two directives on one line are both read (F7)', () => {
  const m = parseChordPro('{title: A}{key: G}');
  assert.equal(m.title, 'A');
  assert.equal(m.key, 'G');
  assert.equal(parseChordPro('{c: use {this} please}\nx').sections[0].lines[0].lyric, 'use {this} please');
});

test('x_ directives are silent, selectors are ignored with a warning, delegate blocks stay raw (F11)', () => {
  assert.deepEqual(parseChordPro('{x_app_state: 3}\n[C]x').warnings, []);
  const sel = parseChordPro('{title-guitar: G only}\n{title: Real}\n[C]x');
  assert.equal(sel.title, 'Real');
  assert.match(sel.warnings[0], /Conditional directive/);
  const abc = parseChordPro('{start_of_abc}\n[CEG]2 z2|\n{end_of_abc}');
  assert.deepEqual(firstLine(abc), { lyric: '[CEG]2 z2|', chords: [] });
  const grid = parseChordPro('{sog}\n| [C] . . . |\n{eog}');
  assert.deepEqual(firstLine(grid), { lyric: '| [C] . . . |', chords: [] });
});

test('nested and unclosed environments, stray braces and brackets', () => {
  const m = parseChordPro('{sov}\n[C]a\n{soc}\n[G]b\n{eoc}\n{eov}\n{ no close\n[D no close\n}');
  assert.deepEqual(m.sections.map((s) => s.kind), ['verse', 'chorus', 'other']);
  assert.ok(m.warnings.some((w) => /inside an unclosed verse/.test(w)));
  assert.ok(m.warnings.some((w) => /without a matching start/.test(w)));
  const tail = m.sections[2].lines.map((l) => l.lyric);
  assert.deepEqual(tail, ['{ no close', '[D no close', '}']);
});

test('chords at the end of a line clamp to the trimmed lyric', () => {
  assert.deepEqual(firstLine(parseChordPro('word [D]')).chords, [{ at: 4, chord: 'D' }]);
  assert.deepEqual(firstLine(parseChordPro('word   [D]  [A]  ')).chords,
    [{ at: 4, chord: 'D' }, { at: 4, chord: 'A' }]);
  assert.equal(firstLine(parseChordPro('word   [D]')).lyric, 'word');
});

test('chord positions under multi-byte text (ChordPro): surrogates, combining marks, RTL, NUL', () => {
  let l = firstLine(parseChordPro('[C]😀 [G]x[D]'));
  assert.deepEqual(l.chords.map((c) => c.at), [0, 3, 4]);
  assert.equal(l.lyric.slice(3), 'x');
  l = firstLine(parseChordPro('Café [F]au'));
  assert.equal(l.lyric.slice(l.chords[0].at), 'au');
  l = firstLine(parseChordPro('[C]שלום [G]עולם'));
  assert.equal(l.lyric.slice(l.chords[1].at), 'עולם');
  l = firstLine(parseChordPro('[C]a\0b[G]c'));
  assert.equal(l.lyric, 'a\0bc');
  assert.equal(l.chords[1].at, 3);
});

test('annotations [*text] are kept, flagged, and never transposed (F8)', () => {
  const m = parseChordPro('{key: C}\n[*Am feel]x [*E]y [C]z');
  assert.deepEqual(firstLine(m).chords.map((c) => [c.chord, !!c.annotation]),
    [['Am feel', true], ['E', true], ['C', false]]);
  assert.deepEqual(chordsOf(firstLine(transposeChart(m, 2))), ['Am feel', 'E', 'D']);
});

test('CRLF, lone CR and BOM really split and strip', () => {
  const m = parseChordPro('{title: T}\r[C]one\r[G]two\r\n[D]three');
  assert.equal(m.title, 'T');
  assert.deepEqual(m.sections[0].lines.map((l) => l.lyric), ['one', 'two', 'three']);
  assert.deepEqual(firstLine(parseChordPro('﻿[C]word')), { lyric: 'word', chords: [{ at: 0, chord: 'C' }] });
  const p = parsePlainChart('Verse 1\rG     C\rwords go here\r');
  assert.deepEqual(p.sections.map((s) => s.name), ['Verse 1']);
  assert.deepEqual(firstLine(p).chords, [{ at: 0, chord: 'G' }, { at: 6, chord: 'C' }]);
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Plain-text heuristics

test('headings: repeat marks, numbers, decorations (F3)', () => {
  for (const [s, name] of [
    ['Chorus 2x', 'Chorus'], ['CHORUS 3X', 'Chorus'], ['Chorus x2', 'Chorus'], ['Chorus (x2)', 'Chorus'],
    ['Tag x 2', 'Tag'], ['Verse 2 (2x)', 'Verse 2'], ['Verse 10:', 'Verse 10'], ['Verse 1a', 'Verse 1A'],
    ['Bridge (build) x2', 'Bridge'], ['== Outro ==', 'Outro'], ['Pre-Chorus 1', 'Pre-Chorus 1'], ['VERSE 3', 'Verse 3'],
  ]) assert.equal(parseHeading(s)?.name, name, s);
  for (const s of ['Verse of the day', 'Bridges and walls', 'Chorus of voices rising', 'The tag', '1st verse x']) {
    assert.equal(parseHeading(s), null, s);
  }
});

test('lyric words that look like chords: only all-chord lines are chord lines', () => {
  // 'Be', 'Dad', 'Bed', 'Add' are not chords; a lyric line with one of them is a lyric.
  for (const w of ['Be', 'Dad', 'Bed', 'Add', 'Ebbs', 'Gm.', 'Am I', 'BE STILL', 'A DAD', 'EMMA']) {
    assert.ok(!isChord(w) || w.includes(' '), w);
  }
  const m = parsePlainChart('Verse\nG         D\nAm I here, Dad\nA bed to rest\nBE STILL NOW');
  assert.deepEqual(m.sections[0].lines.map((l) => [l.lyric, chordsOf(l)]),
    [['Am I here, Dad', ['G', 'D']], ['A bed to rest', []], ['BE STILL NOW', []]]);
});

test('known ambiguity: a lyric line made only of chord-like words reads as chords', () => {
  // 'A' alone or 'Am' alone is a valid chord line; the parser cannot tell (documented, review open item).
  const m = parsePlainChart('Verse\nAm\nEm\nwords here');
  assert.deepEqual(m.sections[0].lines.map((l) => [l.lyric, chordsOf(l)]), [['', ['Am']], ['words here', ['Em']]]);
});

test('chord lines with bars, repeat marks and optional chords (F4)', () => {
  const read = (t) => firstLine(parsePlainChart('Verse\n' + t + '\nsome words here now'));
  assert.deepEqual(read('| G | C | D | x2').chords, [{ at: 2, chord: 'G' }, { at: 6, chord: 'C' },
    { at: 10, chord: 'D' }]);
  assert.deepEqual(read('|G   |C   |D  :|').chords.map((c) => [c.at, c.chord]), [[1, 'G'], [6, 'C'], [11, 'D']]);
  assert.deepEqual(chordsOf(read('G C D 2x')), ['G', 'C', 'D']);
  assert.deepEqual(chordsOf(read('|: G  C :|  (x4)')), ['G', 'C']);
  assert.deepEqual(read('G   (C)  D').chords.map((c) => [c.at, c.chord]), [[0, 'G'], [5, 'C'], [9, 'D']]);
  assert.deepEqual(chordsOf(read('N.C.  G  %  /')), ['G']);
  assert.deepEqual(read('G  C  and then').chords, []);
});

test('heading and chords on one line; it is not taken for the title (F5)', () => {
  const m = parsePlainChart('Intro: G  C  D\nVerse 1\nG\nhello\nTag | Em | C |');
  assert.equal(m.title, null);
  assert.deepEqual(m.sections.map((s) => [s.name, s.lines.map((l) => chordsOf(l).join(' '))]),
    [['Intro', ['G C D']], ['Verse 1', ['G']], ['Tag', ['Em C']]]);
});

test('plain columns under multi-byte lyrics map by display cell (F6)', () => {
  const at = (chordLine, lyric) => {
    const l = firstLine(parsePlainChart(`Verse\n${chordLine}\n${lyric}`));
    return l.chords.map((c) => l.lyric.slice(c.at, c.at + 2));
  };
  assert.deepEqual(at('   C    G', '😀😀 word word'), ['😀', 'd ']); // emoji are 2 cells wide
  assert.deepEqual(at('    C', 'Café au lait'), [' a']); // combining accent is 0 cells
  assert.deepEqual(at('C    G', '主啊 你好'), ['主啊', '你好']); // CJK are 2 cells
  assert.deepEqual(at('C    G', 'שלום עולם'), ['של', 'עו']); // RTL: logical order, 1 cell each
  assert.deepEqual(at('\tC', '\tété'), ['ét']);
});

test('plain header: meta lines, empty values are not meta', () => {
  const m = parsePlainChart('Title: T\nKey : Bb\nTempo: 68 bpm\nTime: 6/8\nCapo:\nVerse\nG\nword');
  assert.deepEqual([m.title, m.key, m.tempo, m.timeSig], ['T', 'Bb', 68, '6/8']);
  assert.ok(m.sections.some((s) => s.lines.some((l) => l.lyric === 'Capo:')));
});

test('detectFormat: bracketed words that are not chords stay plain (F12)', () => {
  assert.equal(detectFormat('a.txt', '[Chorus]:\nG\nwords'), 'plain');
  assert.equal(detectFormat('a.txt', '[Verse 1]\nG   C\nwords'), 'plain');
  assert.equal(detectFormat('a.txt', 'one [G]two [C]three'), 'chordpro');
  assert.equal(detectFormat('a.txt', '\n\n  {title: X}  \n'), 'chordpro');
  assert.equal(detectFormat('a.txt', 'email {at} home'), 'plain');
});

// ---------------------------------------------------------------------------------------------------------------
// 4. Transposition against a music-theory table built here, not from the implementation

const LET = 'CDEFGAB';
const NAT = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const pcOf = (n) => (NAT[n[0]] + (n[1] === '#' ? 1 : n[1] === 'b' ? -1 : 0) + 12) % 12;
// Key signatures by count: + sharps, - flats. The relative major gives a minor key's signature.
const SIG = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6 };
const SHARP_ORDER = 'FCGDAEB';
const FLAT_ORDER = 'BEADGCF';
const REL_MAJOR = { Am: 'C', Em: 'G', Bm: 'D', 'F#m': 'A', 'C#m': 'E', 'G#m': 'B', Ebm: 'Gb', Bbm: 'Db', Fm: 'Ab',
  Cm: 'Eb', Gm: 'Bb', Dm: 'F' };
const MAJ_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MIN_KEYS = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];

function sigAcc(key, letter) {
  const n = SIG[key.endsWith('m') ? REL_MAJOR[key] : key];
  if (n > 0) return SHARP_ORDER.slice(0, n).includes(letter) ? 1 : 0;
  return FLAT_ORDER.slice(0, -n).includes(letter) ? -1 : 0;
}
const isFlatKey = (key) => SIG[key.endsWith('m') ? REL_MAJOR[key] : key] < 0;

/** Theory spelling of scale degree d (0..6) altered by `shift` semitones in `key`, with the review's fallback. */
function degreeName(key, d, shift) {
  return degreeSpell(key, d, shift).name;
}

function degreeSpell(key, d, shift) {
  const tonic = key.endsWith('m') ? key.slice(0, -1) : key;
  const L = LET[(LET.indexOf(tonic[0]) + d) % 7];
  const acc = sigAcc(key, L) + shift;
  const pc = (NAT[L] + acc + 24) % 12;
  const name = acc === 0 ? L : acc === 1 ? L + '#' : acc === -1 ? L + 'b' : null;
  // Fallback (review choice): no double accidentals, no E#/B#/Cb/Fb on a live chart.
  if (name === null || ['E#', 'B#', 'Cb', 'Fb'].includes(name)) {
    return { name: (isFlatKey(key) ? FLATS : SHARPS)[pc], fellBack: true };
  }
  return { name, fellBack: false };
}

/** True when writing this vocabulary entry in `key` needed the fallback (its letter no longer says its degree). */
function usedFallback(key, [d, s, , bd, bs]) {
  return degreeSpell(key, d, s).fellBack || (bd !== undefined && degreeSpell(key, bd, bs).fellBack);
}
const VALID_NOTE = /^[A-G][#b]?$/;

// The review's documented reading of an ambiguous root: in Db, 'A' is both the true #5 and the simplified bVI (Bbb);
// 'D' is both #1 and the simplified b2 (Ebb). The parser reads such a root as the key's own (flat-side) degree. A
// root is ambiguous when the key's harmonic-chromatic spelling of its pitch class needs the fallback and lands on it.
const HC_DEGREE = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6];
function ambiguous(key, src, i) {
  const root = splitChord(chordsOf(firstLine(src))[i]).root;
  const tonic = key.endsWith('m') ? key.slice(0, -1) : key;
  const pc = pcOf(root);
  const L = LET[(LET.indexOf(tonic[0]) + HC_DEGREE[(pc - pcOf(tonic) + 12) % 12]) % 7];
  const acc = (pc - NAT[L] + 12) % 12;
  const plain = (acc === 0 || acc === 1 || acc === 11) && !['E#', 'B#', 'Cb', 'Fb'].includes(acc === 0 ? L
    : L + (acc === 1 ? '#' : 'b'));
  return !plain && (isFlatKey(key) ? FLATS : SHARPS)[pc] === root;
}

// [root degree, root shift, quality, bass degree?, bass shift?]
const MAJOR_VOCAB = [
  [0, 0, ''], [1, 0, 'm7'], [2, 0, 'm'], [3, 0, 'maj7'], [4, 0, 'sus4'], [5, 0, 'm'], [6, 0, 'm7b5'],
  [0, 0, '', 2, 0], [3, 0, '', 0, 0], [4, 0, '7', 6, 0], [0, 0, 'add9'], [4, 0, 'aug'],
  [2, -1, ''], [5, -1, 'add9'], [6, -1, ''], [2, 0, '', 4, 1], [3, 1, 'dim'], [0, 1, 'dim7'],
];
const MINOR_VOCAB = [
  [0, 0, 'm'], [1, 0, 'm7b5'], [2, 0, ''], [3, 0, 'm7'], [4, 0, 'm'], [5, 0, 'maj7'], [6, 0, ''],
  [4, 0, '7'], [0, 0, 'm', 2, 0], [6, 1, 'dim7'], [3, 0, 'm', 0, 0],
];

function vocabChart(key, vocab) {
  return vocab.map(([d, s, q, bd, bs]) => degreeName(key, d, s) + q + (bd === undefined ? ''
    : '/' + degreeName(key, bd, bs)));
}

function chartIn(key, vocab) {
  const chords = vocabChart(key, vocab);
  return parseChordPro(`{key: ${key}}\n` + chords.map((c, i) => `[${c}]w${i} `).join(''));
}

for (const [label, keys, vocab] of [['major', MAJ_KEYS, MAJOR_VOCAB], ['minor', MIN_KEYS, MINOR_VOCAB]]) {
  test(`transposeChart (${label}): every key to every key matches the theory table`, () => {
    let checked = 0;
    let exempt = 0;
    for (let from = 0; from < 12; from++) {
      const src = chartIn(keys[from], vocab);
      for (let n = -11; n <= 11; n++) {
        if (n === 0) continue;
        const to = keys[(from + n + 12) % 12];
        const out = transposeChart(src, n);
        assert.equal(out.key, to, `${keys[from]} ${n}`);
        const want = vocabChart(to, vocab);
        const got = chordsOf(firstLine(out));
        // F2: exact theory spelling, unless the source had to be written with a fallback (Fdim for E#dim): then its
        // degree is gone, and only the pitch classes and a plain spelling (no E#, no double accidental) are checked.
        const bad = got.map((g, i) => {
          if (g === want[i]) return null;
          if (!usedFallback(keys[from], vocab[i]) && !ambiguous(keys[from], src, i)) return `${want[i]}≠${g}`;
          exempt++;
          const pg = splitChord(g);
          const pw = splitChord(want[i]);
          const ok = pg && VALID_NOTE.test(pg.root) && !['E#', 'B#', 'Cb', 'Fb'].includes(pg.root)
            && pcOf(pg.root) === pcOf(pw.root) && pg.suffix === pw.suffix
            && (pg.bass === null ? pw.bass === null : pcOf(pg.bass) === pcOf(pw.bass));
          return ok ? null : `${want[i]}≠${g} (fallback source)`;
        }).filter(Boolean);
        assert.deepEqual(bad, [], `${keys[from]} → ${to}`);
        checked += got.length;
      }
    }
    assert.ok(checked > 2500, String(checked));
    // Exempt (fallback or ambiguous source) cases are a small minority; logged for the review.
    assert.ok(exempt < checked / 20, `${exempt} of ${checked} exempt`);
    console.log(`# theory ${label}: ${checked} chords, ${exempt} exempt`);
  });
}

test('borrowed chords: bVI in G is Eb, not D#; E/G# in C becomes A/C# in F (F2)', () => {
  const g = transposeChart(parseChordPro('{key: A}\n[A]a [F]b [G]c [D/F#]d'), -2);
  assert.deepEqual(chordsOf(firstLine(g)), ['G', 'Eb', 'F', 'C/E']);
  const f = transposeChart(parseChordPro('{key: C}\n[C]a [E/G#]b [Bb]c [Ab]d'), 5);
  assert.deepEqual(chordsOf(firstLine(f)), ['F', 'A/C#', 'Eb', 'Db']);
  // A source that wrote the fallback (Fdim for E#dim in F#) still lands on the diatonic F#dim in G.
  const fs = transposeChart(parseChordPro('{key: F#}\n[Fdim]a [B]b'), 1);
  assert.deepEqual(chordsOf(firstLine(fs)), ['F#dim', 'C']);
});

/** Major third above a root, spelled as a third (letter + 2); E#/B#/doubles fall back to the plain name. */
function thirdOf(root) {
  const L = LET[(LET.indexOf(root[0]) + 2) % 7];
  const pc = (pcOf(root) + 4) % 12;
  const acc = (pc - NAT[L] + 12) % 12;
  const name = acc === 0 ? L : acc === 1 ? L + '#' : acc === 11 ? L + 'b' : null;
  if (name && !['E#', 'B#', 'Cb', 'Fb'].includes(name)) return name;
  return (root[1] === 'b' ? FLATS : SHARPS)[pc];
}

test('transposeChord: 12 roots × 9 qualities × slash against pitch-class arithmetic, both tables', () => {
  const QUALS = ['', 'm', '7', 'maj7', 'sus4', 'add9', 'm7b5', 'dim', 'aug'];
  let count = 0;
  for (const names of [SHARPS, FLATS]) {
    for (let r = 0; r < 12; r++) {
      for (const q of QUALS) {
        for (const slash of [null, (r + 4) % 12]) {
          const chord = names[r] + q + (slash === null ? '' : '/' + names[slash]);
          for (let n = -11; n <= 11; n++) {
            for (const preferFlats of [true, false]) {
              const out = transposeChord(chord, n, { preferFlats });
              const tbl = preferFlats ? FLATS : SHARPS;
              const root = tbl[(r + n + 24) % 12];
              const want = n === 0 ? chord // ≡ 0 returns the input as written
                : root + q + (slash === null ? '' : '/' + thirdOf(root));
              assert.equal(out, want, `${chord} ${n} ${preferFlats}`);
              // Round trip ±n with the same table gives the input back when it was spelled from that table.
              if (names === tbl && slash === null) assert.equal(transposeChord(out, -n, { preferFlats }), chord);
              count++;
            }
          }
        }
      }
    }
  }
  assert.ok(count > 10000);
});

test('transposeChord with no options keeps flats when the input has one, else sharps', () => {
  assert.equal(transposeChord('Ab', 2), 'Bb');
  assert.equal(transposeChord('Ebm7', -1), 'Dm7');
  assert.equal(transposeChord('Ebm7', 1), 'Em7');
  assert.equal(transposeChord('Dbmaj7', 2), 'Ebmaj7');
  assert.equal(transposeChord('G#', 2), 'A#');
  assert.equal(transposeChord('C/Bb', 1), 'Db/B');
});

test('round trip ±1..±11 over whole charts in every key is the identity', () => {
  for (const [keys, vocab] of [[MAJ_KEYS, MAJOR_VOCAB.slice(0, 12)], [MIN_KEYS, MINOR_VOCAB]]) {
    for (const k of keys) {
      const m = chartIn(k, vocab);
      for (let n = 1; n <= 11; n++) {
        for (const s of [n, -n]) assert.deepEqual(transposeChart(transposeChart(m, s), -s), m, `${k} ${s}`);
      }
    }
  }
});

test('key respelling: fewest accidentals; ties F#/Gb and Ebm/D#m follow music.js', () => {
  // Db (5b) over C# (7#), B (5#) over Cb (7b), G#m (5#) over Abm (7b), Bbm (5b) over A#m (7#), C#m (4#) over Dbm.
  for (let pc = 0; pc < 12; pc++) {
    assert.equal(transposeKey('C', pc), MAJ_KEYS[pc]);
    assert.equal(transposeKey('Cm', pc), MIN_KEYS[pc]);
  }
  assert.equal(transposeKey('Gb', 12), 'Gb'); // ≡ 0 keeps the author's spelling
  assert.equal(transposeKey('Gb', 1), 'G');
  assert.equal(transposeKey('Em', 4), 'G#m');
  for (const k of ['Gb', 'Cb', 'Abm', 'Dbm', 'F', 'Dm', 'Cm', 'Fm']) assert.ok(keyPrefersFlats(k), k);
  for (const k of ['C', 'Am', 'F#', 'C#', 'D#m', 'G#m', 'B']) assert.ok(!keyPrefersFlats(k), k);
});

test('transposeChart never touches tab/grid sections, even if they carry chords', () => {
  const m = { key: null, sections: [{ name: 't', kind: 'tab', lines: [{ lyric: '', chords: [{ at: 0, chord: 'C' }] }] },
    { name: 'v', kind: 'verse', lines: [{ lyric: '', chords: [{ at: 0, chord: 'C' }] }] }] };
  const t = transposeChart(m, 2);
  assert.equal(t.sections[0].lines[0].chords[0].chord, 'C');
  assert.equal(t.sections[1].lines[0].chords[0].chord, 'D');
});

test('splitChord rejects junk tokens a lyric might hold', () => {
  for (const s of ['C/H', 'C/e', 'H7', 'c', 'Am,G', 'C D', 'Do', 'Ebony']) assert.equal(splitChord(s), null, s);
  assert.deepEqual(splitChord('F#m7b5/C'), { root: 'F#', suffix: 'm7b5', bass: 'C' });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. CSV (RFC 4180)

test('CSV: embedded quotes, commas, CRLF and line breaks inside quotes', () => {
  const r = parseSongListCsv('Title,Author,CCLI\r\n"Two\r\nLines","Q ""R"" S, T",1\r\n"A ""quoted"" one",,"2"\r\n');
  assert.deepEqual(r.songs.map((s) => [s.title, s.artist, s.ccli]),
    [['Two Lines', 'Q "R" S, T', '1'], ['A "quoted" one', null, '2']]);
});

test('CSV: header variants and column order', () => {
  for (const head of ['Song Title,Writer(s),CCLI Song #', 'name;composer;CCLI Number', 'TITLE\tAUTHORS\tccli',
    'ID,Song Name,Song Writers,CCLI #']) {
    const d = head.includes(';') ? ';' : head.includes('\t') ? '\t' : ',';
    const cells = head.startsWith('ID') ? ['9', 'T', 'W', '3'] : ['T', 'W', '3'];
    const r = parseSongListCsv(head + '\n' + cells.join(d));
    assert.deepEqual(r.songs.map((s) => [s.title, s.artist, s.ccli]), [['T', 'W', '3']], head);
  }
});

test('CSV: CCLI with thousands separators; ragged rows; a quoted empty last row', () => {
  const r = parseSongListCsv('Title,Author,CCLI\nT,A,"1,234,567"\nU\nV,B,8,extra\n""');
  assert.deepEqual(r.songs.map((s) => [s.title, s.artist, s.ccli]),
    [['T', 'A', '1234567'], ['U', null, null], ['V', 'B', '8']]);
});
