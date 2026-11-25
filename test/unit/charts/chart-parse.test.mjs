import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChart, parseChordPro, parsePlainChart, parseSongListCsv, detectFormat, transposeChord, transposeChart,
  transposeKey, normalizeKey, parseHeading, isChord,
} from '../../../app/js/shared/chart-parse.js';

const LINE = 'Here is a line we wrote for testing';

// ---- ChordPro directives
test('title, subtitle, artist and short forms', () => {
  const m = parseChordPro('{title: Test Song}\n{st: A Subtitle}\n{artist: Test Band}\n');
  assert.equal(m.title, 'Test Song');
  assert.equal(m.subtitle, 'A Subtitle');
  assert.equal(m.artist, 'Test Band');
  assert.equal(parseChordPro('{t:Short}').title, 'Short');
  assert.equal(parseChordPro('{subtitle: Sub}').subtitle, 'Sub');
});

test('missing fields are null', () => {
  const m = parseChordPro(`[C]${LINE}`);
  for (const k of ['title', 'artist', 'key', 'tempo', 'timeSig', 'capo', 'ccli']) assert.equal(m[k], null, k);
});

test('{key: Bb}, minor and sharp keys', () => {
  assert.equal(parseChordPro('{key: Bb}').key, 'Bb');
  assert.equal(parseChordPro('{key: F# minor}').key, 'F#m');
  assert.equal(parseChordPro('{key: Am}').key, 'Am');
  assert.equal(parseChordPro('{key: c}').key, 'C');
});

test('bad key warns and stays null', () => {
  const m = parseChordPro('{key: H}');
  assert.equal(m.key, null);
  assert.match(m.warnings[0], /key/i);
});

test('{tempo: 72 bpm} and plain numbers', () => {
  assert.equal(parseChordPro('{tempo: 72 bpm}').tempo, 72);
  assert.equal(parseChordPro('{tempo: 120}').tempo, 120);
  assert.equal(parseChordPro('{tempo: 72.4}').tempo, 72);
});

test('out-of-range tempo warns', () => {
  const m = parseChordPro('{tempo: 5}');
  assert.equal(m.tempo, null);
  assert.equal(m.warnings.length, 1);
});

test('{time: 6/8} and bad time', () => {
  assert.equal(parseChordPro('{time: 6/8}').timeSig, '6/8');
  assert.equal(parseChordPro('{time: 4 / 4}').timeSig, '4/4');
  const m = parseChordPro('{time: waltz}');
  assert.equal(m.timeSig, null);
  assert.equal(m.warnings.length, 1);
});

test('capo, ccli, copyright', () => {
  const m = parseChordPro('{capo: 3}\n{ccli: 1234567}\n{copyright: 2026 Nobody}');
  assert.equal(m.capo, 3);
  assert.equal(m.ccli, '1234567');
  assert.equal(m.copyright, '2026 Nobody');
  assert.equal(parseChordPro('{capo: 0}').capo, null);
});

test('{meta: key G} routes to the field', () => {
  assert.equal(parseChordPro('{meta: key G}').key, 'G');
});

test('unknown directives are kept as warnings, known layout ones are not', () => {
  const m = parseChordPro('{frobnicate: 3}\n{define: C base-fret 1}\n{new_page}');
  assert.equal(m.warnings.length, 1);
  assert.match(m.warnings[0], /Unknown directive \{frobnicate\}/);
});

test('duplicate title keeps the first and warns', () => {
  const m = parseChordPro('{title: One}\n{title: Two}');
  assert.equal(m.title, 'One');
  assert.equal(m.warnings.length, 1);
});

// ---- environments and sections
test('start_of_verse with a label', () => {
  const m = parseChordPro(`{start_of_verse: Verse 1}\n[C]${LINE}\n{end_of_verse}`);
  assert.equal(m.sections.length, 1);
  assert.deepEqual([m.sections[0].name, m.sections[0].kind], ['Verse 1', 'verse']);
});

test('short environments sov/soc/sob', () => {
  const m = parseChordPro('{sov}\nA line\n{eov}\n{soc: Chorus 2}\nB line\n{eoc}\n{sob}\nC line\n{eob}');
  assert.deepEqual(m.sections.map((s) => [s.name, s.kind]),
    [['Verse', 'verse'], ['Chorus 2', 'chorus'], ['Bridge', 'bridge']]);
});

test('label="..." attribute form', () => {
  const m = parseChordPro('{start_of_chorus label="Big Chorus"}\nline\n{end_of_chorus}');
  assert.equal(m.sections[0].name, 'Big Chorus');
});

test('tab environment keeps raw lines and ignores brackets', () => {
  const m = parseChordPro('{start_of_tab}\ne|--[3]--|\n{end_of_tab}');
  assert.equal(m.sections[0].kind, 'tab');
  assert.equal(m.sections[0].lines[0].lyric, 'e|--[3]--|');
  assert.deepEqual(m.sections[0].lines[0].chords, []);
});

test('grid environment', () => {
  const m = parseChordPro('{sog}\n| C . . . | G . . . |\n{eog}');
  assert.equal(m.sections[0].kind, 'grid');
  assert.equal(m.sections[0].lines.length, 1);
});

test('comment that names a section starts that section', () => {
  const m = parseChordPro(`{c: Chorus}\n[G]${LINE}\n{comment: Verse 2}\n[C]${LINE}`);
  assert.deepEqual(m.sections.map((s) => s.name), ['Chorus', 'Verse 2']);
});

test('other comments become comment lines', () => {
  const m = parseChordPro('{sov}\n{ci: Softly}\nline\n{eov}');
  assert.deepEqual(m.sections[0].lines[0], { lyric: 'Softly', chords: [], comment: true });
});

test('unmatched end and unclosed environment warn', () => {
  assert.equal(parseChordPro('{eov}').warnings.length, 1);
  assert.match(parseChordPro('{sov}\nline').warnings.at(-1), /unclosed/);
});

test('bare {chorus} recall makes a marker section', () => {
  const m = parseChordPro('{soc}\nx\n{eoc}\n{sov}\ny\n{eov}\n{chorus}');
  assert.equal(m.sections.at(-1).recall, true);
});

test('heading lines work inside ChordPro too', () => {
  const m = parseChordPro(`Verse 1:\n[C]${LINE}\n[Bridge]\n[F]${LINE}`);
  assert.deepEqual(m.sections.map((s) => s.kind), ['verse', 'bridge']);
});

// ---- inline chords
test('inline chord positions follow the lyric', () => {
  const m = parseChordPro('[C]Here [G]is a [Am]line');
  const l = m.sections[0].lines[0];
  assert.equal(l.lyric, 'Here is a line');
  assert.deepEqual(l.chords, [{ at: 0, chord: 'C' }, { at: 5, chord: 'G' }, { at: 10, chord: 'Am' }]);
});

test('chords with no lyric', () => {
  const l = parseChordPro('[C][G][Am]').sections[0].lines[0];
  assert.equal(l.lyric, '');
  assert.deepEqual(l.chords.map((c) => c.at), [0, 0, 0]);
});

test('lyric with no chords', () => {
  assert.deepEqual(parseChordPro(LINE).sections[0].lines[0], { lyric: LINE, chords: [] });
});

test('chord after the last word clamps to lyric end', () => {
  const l = parseChordPro('end[D]').sections[0].lines[0];
  assert.deepEqual(l.chords, [{ at: 3, chord: 'D' }]);
});

test('unclosed bracket stays literal with a warning', () => {
  const m = parseChordPro('oops [C no end');
  assert.equal(m.sections[0].lines[0].lyric, 'oops [C no end');
  assert.equal(m.warnings.length, 1);
});

test('unicode accidentals and annotations', () => {
  const l = parseChordPro('[B♭]a [*Softly]b').sections[0].lines[0];
  assert.equal(l.chords[0].chord, 'Bb');
  assert.equal(l.chords[1].chord, 'Softly');
});

// ---- input hygiene
test('CRLF, lone CR and BOM', () => {
  const m = parseChordPro('﻿{title: T}\r\n{key: G}\r\n[G]Line one\r\n[C]Line two\r');
  assert.equal(m.title, 'T');
  assert.equal(m.key, 'G');
  assert.equal(m.sections[0].lines.length, 2);
  assert.equal(m.sections[0].lines[0].lyric, 'Line one');
});

test('empty and non-string input never throw', () => {
  for (const v of ['', '   \n\n', null, undefined, 42, {}]) {
    const m = parseChart(v);
    assert.deepEqual(m.sections, []);
    assert.ok(m.warnings.length >= 1);
  }
});

test('tabs expand to 4-column stops in lyric lines', () => {
  const l = parseChordPro('\t[C]word').sections[0].lines[0];
  assert.equal(l.lyric, '    word');
  assert.equal(l.chords[0].at, 4);
});

test('# lines are ChordPro comments', () => {
  const m = parseChordPro('# a note\n[C]x');
  assert.equal(m.sections[0].lines.length, 1);
});

// ---- plain text
const PLAIN = [
  'Test Song', '', 'Key: G', 'Tempo: 80', '', 'Verse 1', 'G         C', LINE, 'Am        D', 'Second line here', '',
  'Chorus:', 'C  G  D', '', '[Bridge]', 'Em', 'No chords on this one', 'Tag', 'G',
].join('\n');

test('plain chart: meta, headings and chord attachment', () => {
  const m = parsePlainChart(
    PLAIN.replace('Test Song\n\nKey: G\nTempo: 80\n\n', 'Title: Test Song\nKey: G\nTempo: 80\n\n'));
  assert.equal(m.title, 'Test Song');
  assert.equal(m.key, 'G');
  assert.equal(m.tempo, 80);
  assert.deepEqual(m.sections.map((s) => s.name), ['Verse 1', 'Chorus', 'Bridge', 'Tag']);
  const v = m.sections[0].lines;
  assert.equal(v[0].lyric, LINE);
  assert.deepEqual(v[0].chords, [{ at: 0, chord: 'G' }, { at: 10, chord: 'C' }]);
  assert.equal(v.length, 2);
});

test('plain chart: chord-only lines and lyric-only lines', () => {
  const m = parsePlainChart('Chorus:\nC  G  D\n\nBridge\nEm\nPlain words only');
  assert.deepEqual(m.sections[0].lines, [{ lyric: '', chords: [
    { at: 0, chord: 'C' }, { at: 0, chord: 'G' }, { at: 0, chord: 'D' }] }]);
  assert.deepEqual(m.sections[1].lines[0].chords, [{ at: 0, chord: 'Em' }]);
  assert.equal(m.sections[1].lines[0].lyric, 'Plain words only');
});

test('plain chart: first-line title guess warns', () => {
  const m = parsePlainChart(PLAIN);
  assert.equal(m.title, 'Test Song');
  assert.ok(m.warnings.some((w) => /guessed/.test(w)));
});

test('plain chart: chord column past the lyric clamps', () => {
  const m = parsePlainChart('C      G\nshort');
  assert.equal(m.sections[0].lines[0].chords[1].at, 5);
});

test('plain chart: tabs align chord columns', () => {
  const m = parsePlainChart('\tC\n\tword');
  assert.equal(m.sections[0].lines[0].chords[0].at, 4);
});

test('plain chart: CRLF + BOM', () => {
  const m = parsePlainChart('﻿Verse 1\r\nC\r\nline\r\n');
  assert.equal(m.sections[0].lines[0].lyric, 'line');
});

test('headings: variety, and non-headings', () => {
  for (const [s, name, kind] of [
    ['Verse 1', 'Verse 1', 'verse'], ['CHORUS:', 'Chorus', 'chorus'], ['[Bridge]', 'Bridge', 'bridge'],
    ['Tag', 'Tag', 'tag'], ['Intro', 'Intro', 'intro'], ['Pre-Chorus', 'Pre-Chorus', 'prechorus'],
    ['Pre chorus 2', 'Pre-Chorus 2', 'prechorus'], ['(Verse 2)', 'Verse 2', 'verse'],
    ['Outro x2', 'Outro', 'outro'], ['--- Interlude ---', 'Interlude', 'interlude'],
  ]) assert.deepEqual(parseHeading(s), { name, kind }, s);
  assert.equal(parseHeading(LINE), null);
  assert.equal(parseHeading('Verse of the day is long'), null);
});

test('isChord table', () => {
  for (const c of ['C', 'F#m7b5', 'Bb/D', 'Dsus4', 'Cadd9/E', 'G6/9', 'Am7', 'Cmaj7', 'E7(#9)', 'D/F#']) {
    assert.ok(isChord(c), c);
  }
  for (const c of ['Dad', 'Bed', 'H', 'chorus', 'N.C.', '', 'A line']) assert.ok(!isChord(c), c);
});

// ---- detectFormat
test('detectFormat', () => {
  assert.equal(detectFormat('a.cho', ''), 'chordpro');
  for (const e of ['chopro', 'chordpro', 'chord', 'crd', 'pro']) {
    assert.equal(detectFormat('x.' + e, 'plain'), 'chordpro');
  }
  assert.equal(detectFormat('a.txt', '{title: X}\n[C]hi'), 'chordpro');
  assert.equal(detectFormat('a.txt', 'Verse 1\nC   G\nwords'), 'plain');
  assert.equal(detectFormat('a.txt', 'wo[C]rds here'), 'chordpro');
  assert.equal(detectFormat('songs.csv', 'x'), 'csv');
  assert.equal(detectFormat('songs.txt', 'Title,Author,CCLI\nA,B,1'), 'csv');
  assert.equal(detectFormat(undefined, undefined), 'plain');
});

test('parseChart dispatches by name', () => {
  assert.equal(parseChart('{title: T}', { name: 'x.txt' }).title, 'T');
  assert.equal(parseChart('Title: T\nVerse\nC\nhi', { name: 'x.txt' }).title, 'T');
  assert.match(parseChart('a,b', { format: 'csv' }).warnings[0], /song list/);
});

// ---- transposition
test('transposeChord basics', () => {
  assert.equal(transposeChord('C', 2), 'D');
  assert.equal(transposeChord('Am7', 3), 'Cm7');
  assert.equal(transposeChord('F#m', -2), 'Em');
  assert.equal(transposeChord('C', 1, { preferFlats: true }), 'Db');
  assert.equal(transposeChord('C', 1, { preferFlats: false }), 'C#');
  assert.equal(transposeChord('C', 1), 'C#');
  assert.equal(transposeChord('Bb', 2), 'C');
  assert.equal(transposeChord('N.C.', 2), 'N.C.');
});

test('transposeChord slash chords and extensions', () => {
  assert.equal(transposeChord('C/E', 2), 'D/F#');
  assert.equal(transposeChord('C/E', 2, { preferFlats: true }), 'D/F#'); // C2 review F2: bass is the 3rd
  assert.equal(transposeChord('Dsus4/A', 5), 'Gsus4/D');
  assert.equal(transposeChord('Cadd9', 7), 'Gadd9');
  assert.equal(transposeChord('G6/9', 2), 'A6/9');
  assert.equal(transposeChord('Bbmaj7/D', 1), 'Bmaj7/D#'); // C2 review F2: bass is the 3rd
  assert.equal(transposeChord('Ebm7b5', -1), 'Dm7b5');
});

test('transposeChord: +12 and -12 are identity, any spelling', () => {
  for (const c of ['C', 'Db', 'C#m7', 'Bb/D', 'F#sus4', 'Ebmaj7']) {
    assert.equal(transposeChord(c, 12), c);
    assert.equal(transposeChord(c, -12), c);
  }
});

test('transposeChord: 12 single steps equal identity (sharps and flats)', () => {
  for (const [c, flats] of [['C', false], ['Am7/G', false], ['Eb', true], ['Bbm/Db', true]]) {
    let x = c;
    for (let i = 0; i < 12; i++) x = transposeChord(x, 1, { preferFlats: flats });
    assert.equal(x, c);
  }
});

test('transposeKey and normalizeKey', () => {
  assert.equal(transposeKey('G', 3), 'Bb');
  assert.equal(transposeKey('Em', 1), 'Fm');
  assert.equal(transposeKey('A', 1), 'Bb');
  assert.equal(transposeKey('Bb', 12), 'Bb');
  assert.equal(transposeKey('nope', 1), null);
  assert.equal(normalizeKey('bb'), 'Bb');
});

const SAMPLE = '{title: T}\n{key: G}\n{sov}\n[G]Here is [C/E]a line [Em7]we wrote\n[D]for tes[Dsus4]ting\n{eov}';

test('transposeChart: +12 is an exact copy, input untouched', () => {
  const m = parseChordPro(SAMPLE);
  const snap = JSON.stringify(m);
  assert.deepEqual(transposeChart(m, 12), m);
  assert.deepEqual(transposeChart(m, -24), m);
  transposeChart(m, 3);
  assert.equal(JSON.stringify(m), snap);
});

test('transposeChart: up then down round trips', () => {
  const m = parseChordPro(SAMPLE);
  for (const n of [1, 2, 5, 7, -3]) assert.deepEqual(transposeChart(transposeChart(m, n), -n), m, String(n));
});

test('transposeChart: flat key spells with flats, sharp key with sharps', () => {
  const up3 = transposeChart(parseChordPro(SAMPLE), 3); // G -> Bb
  assert.equal(up3.key, 'Bb');
  assert.deepEqual(up3.sections[0].lines[0].chords.map((c) => c.chord), ['Bb', 'Eb/G', 'Gm7']);
  assert.equal(up3.sections[0].lines[1].chords[0].chord, 'F');
  const up2 = transposeChart(parseChordPro(SAMPLE), 2); // G -> A
  assert.equal(up2.key, 'A');
  assert.equal(up2.sections[0].lines[0].chords[1].chord, 'D/F#');
});

test('transposeChart: key of Eb, -1 gives D and +1 gives E; enharmonics in flat keys', () => {
  const m = parseChordPro('{key: Eb}\n[Eb]a [Ab]b [Bb/D]c [Cm]d');
  assert.equal(transposeChart(m, -1).key, 'D');
  const f = transposeChart(parseChordPro('{key: C}\n[C]a [F]b [G]c'), 5); // C -> F
  assert.equal(f.key, 'F');
  assert.deepEqual(f.sections[0].lines[0].chords.map((c) => c.chord), ['F', 'Bb', 'C']);
  const db = transposeChart(parseChordPro('{key: C}\n[C]a [Am]b [F]c'), 1);
  assert.equal(db.key, 'Db');
  assert.deepEqual(db.sections[0].lines[0].chords.map((c) => c.chord), ['Db', 'Bbm', 'Gb']);
});

test('transposeChart without a key follows the chart accidentals', () => {
  const flat = transposeChart(parseChordPro('[Bb]a [Eb]b'), 1);
  assert.deepEqual(flat.sections[0].lines[0].chords.map((c) => c.chord), ['B', 'E']);
  const flat2 = transposeChart(parseChordPro('[Bb]a [Eb]b'), 2);
  assert.deepEqual(flat2.sections[0].lines[0].chords.map((c) => c.chord), ['C', 'F']);
  const sharp = transposeChart(parseChordPro('[F#]a [C#m]b'), 1);
  assert.deepEqual(sharp.sections[0].lines[0].chords.map((c) => c.chord), ['G', 'Dm']);
});

test('transposeChart leaves tab sections, comments and capo alone', () => {
  const m = parseChordPro('{capo: 2}\n{sot}\nC|--3--\n{eot}\n{sov}\n{c: Softly}\n[C]x\n{eov}');
  const t = transposeChart(m, 2);
  assert.equal(t.capo, 2);
  assert.equal(t.sections[0].lines[0].lyric, 'C|--3--');
  assert.equal(t.sections[1].lines[0].lyric, 'Softly');
  assert.equal(t.sections[1].lines[1].chords[0].chord, 'D');
});

test('transposeChart tolerates junk', () => {
  assert.doesNotThrow(() => transposeChart(null, 2));
  assert.doesNotThrow(() => transposeChart({}, 2));
  assert.doesNotThrow(() => transposeChart(parseChordPro(SAMPLE), NaN));
});

// ---- CSV
test('CSV: title, author, CCLI → placeholders', () => {
  const r = parseSongListCsv(
    'Title,Author,CCLI\nSong One,A. Writer,1111111\n"Song, Two","B. Writer, C. Writer",2222222\n');
  assert.equal(r.songs.length, 2);
  assert.equal(r.songs[0].title, 'Song One');
  assert.equal(r.songs[0].artist, 'A. Writer');
  assert.equal(r.songs[0].ccli, '1111111');
  assert.equal(r.songs[1].title, 'Song, Two');
  assert.equal(r.songs[1].artist, 'B. Writer, C. Writer');
  assert.deepEqual(r.songs[0].sections, []);
  assert.equal(r.songs[0].key, null);
});

test('CSV: BOM, CRLF, header variants, quotes, blank rows', () => {
  const r = parseSongListCsv(
    '\ufeff"Song Title","Authors","CCLI Song #"\r\n"Say ""Hi"" Song","X",3333\r\n\r\n,,\r\nNext,,\r\n');
  assert.deepEqual(r.songs.map((s) => s.title), ['Say "Hi" Song', 'Next']);
  assert.equal(r.songs[0].ccli, '3333');
  assert.equal(r.songs[1].artist, null);
});

test('CSV: semicolon delimiter, missing title cell, bad CCLI', () => {
  const r = parseSongListCsv('title;author;ccli\nA;B;12x\n;Nobody;5\n');
  assert.equal(r.songs.length, 1);
  assert.equal(r.songs[0].ccli, null);
  assert.equal(r.songs[0].warnings.length, 1);
  assert.equal(r.warnings.length, 1);
});

test('CSV: empty, headerless, and junk input never throw', () => {
  assert.equal(parseSongListCsv('').songs.length, 0);
  assert.ok(parseSongListCsv('').warnings.length);
  assert.match(parseSongListCsv('a,b\n1,2').warnings[0], /title column/);
  assert.doesNotThrow(() => parseSongListCsv(null));
  assert.match(parseSongListCsv('Title\n"open').warnings[0], /Unterminated/);
});
