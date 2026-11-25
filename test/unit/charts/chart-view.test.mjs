// Chart view (D7, hidden): the pure logic in app/js/views/chart/logic.js. The key on show following Easy Transpose
// (heard key / hands key, spelling by the target key), line segments, the auto-scroll pace, the import offers and the
// song-list placeholders. Every chart here is written for the test, not copied from a song.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  keyInfo, chartSourceKey, chartShift, chartView, parseStoredChart, lineSegments, songLineCount, secondsPerLine,
  autoScrollRate, stepIndex, importOffers, offerWrites, readImport, csvPlaceholders, FALLBACK_TEMPO, BARS_PER_LINE,
  CHART_FONT_STEPS, CHART_SPEED_STEPS, CHART_SPEED_DEFAULT,
} from '../../../app/js/views/chart/logic.js';
import { createStore, memoryStorage } from '../../../app/js/store.js';

const PRO = [
  '{title: Paper Boats}', '{key: G}', '{tempo: 76}', '{time: 6/8}',
  '{c: Verse 1}', '[G]Paper boats on a [C]rainy [D]street', '[Em]Folded [C/E]small and [D]neat',
  '{soc}', '[C]Sail a[G]way, [D/F#]sail a[Em]way', '{eoc}', '{c: play it soft}', '{chorus}',
].join('\n');
const PLAIN = ['Morning Test', '', 'Verse', 'C        F      G', 'Counting all the tiles', 'Am   F', 'One by one']
  .join('\n');
const song = (o = {}) => ({ id: 's', name: 'Song', playIn: 7, hearIn: 7, minor: false, tempo: null, ...o });
const chordsOf = (model) => model.sections.flatMap((s) => s.lines.flatMap((l) => l.chords.map((c) => c.chord)));

test('keyInfo: names → pitch class and mode', () => {
  assert.deepEqual(keyInfo('G'), { pc: 7, minor: false });
  assert.deepEqual(keyInfo('Bb'), { pc: 10, minor: false });
  assert.deepEqual(keyInfo('F#m'), { pc: 6, minor: true });
  assert.deepEqual(keyInfo('c minor'), { pc: 0, minor: true });
  assert.deepEqual(keyInfo('Cb'), { pc: 11, minor: false });
  assert.equal(keyInfo('H'), null);
  assert.equal(keyInfo(''), null);
});

test('source key: the chart’s own, else the stored one, else the song’s Play In key', () => {
  const s = song({ playIn: 2, hearIn: 4 });
  assert.deepEqual(chartSourceKey({ key: 'G' }, { key: 'A' }, s), { key: 'G', from: 'chart' });
  assert.deepEqual(chartSourceKey({ key: null }, { key: 'A' }, s), { key: 'A', from: 'stored' });
  assert.deepEqual(chartSourceKey({ key: null }, {}, s), { key: 'D', from: 'song' });
  assert.deepEqual(chartSourceKey({ key: null }, {}, song({ playIn: 4, minor: true })), { key: 'Em', from: 'song' });
});

test('shift: heard key follows hearIn, hands key follows playIn; octaves ignored', () => {
  assert.equal(chartShift(song({ hearIn: 9 }), 'G'), 2);
  assert.equal(chartShift(song({ hearIn: 5 }), 'G'), 10);
  assert.equal(chartShift(song({ playIn: 7, hearIn: 9 }), 'G', 'play'), 0);
  assert.equal(chartShift(song({ playIn: 2, hearIn: 9, transposeOctave: 1 }), 'G', 'play'), 7);
  assert.equal(chartShift(song({ hearIn: 4 }), 'Em'), 0, 'a minor chart: the pitch class is what moves');
  assert.equal(chartShift(song(), 'not a key'), 0);
});

test('chartView: transpose follows Easy Transpose live, spelled for the target key', () => {
  const chart = { text: PRO, format: 'chordpro' };
  const at = (o, mode) => chartView(song({ chart, ...o }), mode);
  const g = at({});
  assert.equal(g.shift, 0);
  assert.equal(g.shownKey, 'G');
  assert.deepEqual(chordsOf(g.model), ['G', 'C', 'D', 'Em', 'C/E', 'D', 'C', 'G', 'D/F#', 'Em']);
  const a = at({ hearIn: 9 });
  assert.equal(a.shownKey, 'A');
  assert.deepEqual(chordsOf(a.model), ['A', 'D', 'E', 'F#m', 'D/F#', 'E', 'D', 'A', 'E/G#', 'F#m']);
  const f = at({ hearIn: 5 });
  assert.equal(f.shownKey, 'F');
  assert.deepEqual(chordsOf(f.model), ['F', 'Bb', 'C', 'Dm', 'Bb/D', 'C', 'Bb', 'F', 'C/E', 'Dm'], 'flats in F');
  const eb = at({ hearIn: 3 });
  assert.equal(eb.shownKey, 'Eb');
  assert.ok(chordsOf(eb.model).includes('Ab') && !chordsOf(eb.model).some((c) => c.includes('#')), 'flat key');
  const fs = at({ hearIn: 6 });
  assert.equal(fs.shownKey, 'F#');
  assert.ok(chordsOf(fs.model).includes('D#m') && chordsOf(fs.model).includes('C#/E#') === false, 'sharp key');
  // hands mode: Easy Transpose moves the sound, the chart stays in the hands' key
  const hands = at({ playIn: 7, hearIn: 9 }, 'play');
  assert.equal(hands.shift, 0);
  assert.equal(hands.shownKey, 'G');
  // the parse is cached by text, and the stored model is never mutated by a transpose
  assert.equal(parseStoredChart(chart), parseStoredChart({ ...chart }));
  assert.equal(parseStoredChart(chart).sections[0].lines[0].chords[0].chord, 'G');
  assert.equal(chartView(song()), null, 'no chart');
});

test('chartView: an unkeyed chart uses the stored key, else Play In (so it moves by the Easy Transpose amount)', () => {
  const s = song({ playIn: 0, hearIn: 0, chart: { text: PLAIN, format: 'plain' } });
  const c = chartView(s);
  assert.equal(c.keyFrom, 'song');
  assert.equal(c.shownKey, 'C');
  assert.deepEqual(chordsOf(c.model), ['C', 'F', 'G', 'Am', 'F']);
  const eb = chartView({ ...s, hearIn: 3 });
  assert.equal(eb.shift, 3);
  assert.equal(eb.shownKey, 'Eb');
  assert.equal(chartView({ ...s, hearIn: 3 }, 'play').shift, 0, 'hands mode: as written');
  assert.deepEqual(chordsOf(eb.model), ['Eb', 'Ab', 'Bb', 'Cm', 'Ab'], 'flats, from the target key');
  const stored = chartView({ ...s, hearIn: 2, chart: { text: PLAIN, format: 'plain', key: 'C' } });
  assert.equal(stored.keyFrom, 'stored');
  assert.equal(stored.shift, 2);
  assert.deepEqual(chordsOf(stored.model), ['D', 'G', 'A', 'Bm', 'G']);
});

test('chartView follows a real store: Transpose up / Easy Transpose writes re-key the chart', () => {
  const store = createStore({ storage: memoryStorage(), warn: () => {}, requestIdle: null, autoFlush: false });
  const id = store.currentSong().id;
  store.set(`songs.${id}.playIn`, 7);
  store.set(`songs.${id}.hearIn`, 7);
  store.setChart(id, { text: PRO, format: 'chordpro' });
  assert.equal(chartView(store.currentSong()).shownKey, 'G');
  store.set(`songs.${id}.hearIn`, 8); // what controller.transposeUp writes
  const up = chartView(store.currentSong());
  assert.equal(up.shownKey, 'Ab');
  assert.equal(chordsOf(up.model)[0], 'Ab');
  assert.equal(chartView(store.currentSong(), 'play').shownKey, 'G');
  store.set(`songs.${id}.playIn`, 5); // Easy Transpose: play in F
  assert.equal(chartView(store.currentSong(), 'play').shownKey, 'F');
});

test('lineSegments: one segment per chord from its `at`, plus a leading chordless one', () => {
  assert.deepEqual(lineSegments({ lyric: 'Paper boats on a rainy street', chords: [{ at: 0, chord: 'G' },
    { at: 17, chord: 'C' }, { at: 23, chord: 'D' }] }), [
    { chord: 'G', annotation: false, text: 'Paper boats on a ' },
    { chord: 'C', annotation: false, text: 'rainy ' },
    { chord: 'D', annotation: false, text: 'street' },
  ]);
  assert.deepEqual(lineSegments({ lyric: 'and then', chords: [{ at: 4, chord: 'Am', annotation: true }] }), [
    { chord: '', annotation: false, text: 'and ' }, { chord: 'Am', annotation: true, text: 'then' }]);
  assert.deepEqual(lineSegments({ lyric: '', chords: [{ at: 0, chord: 'C' }, { at: 0, chord: 'G' }] }), [
    { chord: 'C', annotation: false, text: '' }, { chord: 'G', annotation: false, text: '' }]);
  assert.deepEqual(lineSegments({ lyric: 'no chords', chords: [] }),
    [{ chord: '', annotation: false, text: 'no chords' }]);
  assert.deepEqual(lineSegments({ lyric: 'ab', chords: [{ at: 99, chord: 'E' }] }),
    [{ chord: '', annotation: false, text: 'ab' }, { chord: 'E', annotation: false, text: '' }], 'clamped');
  const emoji = lineSegments({ lyric: 'go 🙂 now', chords: [{ at: 6, chord: 'F' }] });
  assert.equal(emoji.map((s) => s.text).join(''), 'go 🙂 now');
});

test('songLineCount: comments skipped, a repeated chorus counts again', () => {
  const m = parseStoredChart({ text: PRO, format: 'chordpro' });
  assert.equal(m.sections.at(-1).recall, true);
  assert.equal(songLineCount(m), 2 + 1 + 1, 'verse 2 + chorus 1 + chorus again 1 (the comment is not a line)');
  assert.equal(songLineCount(null), 0);
});

test('auto-scroll pace: BARS_PER_LINE bars per line at the tempo, the felt beat in compound meters', () => {
  assert.equal(BARS_PER_LINE, 2);
  assert.equal(secondsPerLine(120, '4/4'), 4);
  assert.equal(secondsPerLine(90, '3/4'), 4);
  assert.equal(secondsPerLine(60, '6/8'), 4, '6/8 = 2 dotted-quarter beats a bar');
  assert.equal(secondsPerLine(null), (2 * 4 * 60) / FALLBACK_TEMPO);
  assert.equal(secondsPerLine(0, '4/4'), (2 * 4 * 60) / FALLBACK_TEMPO);
  // 10 lines at 120 in 4/4 = 40 s to cover 800 px → 20 px/s; ×1.5 → 30
  assert.equal(autoScrollRate({ tempo: 120, timeSig: '4/4', lines: 10, scrollPx: 800 }), 20);
  assert.equal(autoScrollRate({ tempo: 120, lines: 10, scrollPx: 800, multiplier: 1.5 }), 30);
  assert.ok(Math.abs(autoScrollRate({ tempo: 60, timeSig: '6/8', lines: 10, scrollPx: 800 }) - 20) < 1e-9);
  const zero = [{ lines: 0, scrollPx: 800 }, { lines: 5, scrollPx: 0 }, { lines: 5, scrollPx: 100, multiplier: 0 }];
  for (const o of zero) {
    assert.equal(autoScrollRate({ tempo: 100, ...o }), 0);
  }
  assert.equal(CHART_SPEED_STEPS[CHART_SPEED_DEFAULT], 1);
  assert.equal(stepIndex(CHART_SPEED_STEPS, 0, -1), 0);
  assert.equal(stepIndex(CHART_FONT_STEPS, CHART_FONT_STEPS.length - 1, 1), CHART_FONT_STEPS.length - 1);
  assert.equal(stepIndex(CHART_FONT_STEPS, 2, 1), 3);
  assert.equal(stepIndex(CHART_FONT_STEPS, 99, -1), 0);
});

test('import offers: title, key, tempo and time are offered when they differ, never when the same', () => {
  const m = parseStoredChart({ text: PRO, format: 'chordpro' });
  const s = song({ name: 'Untitled', playIn: 0, hearIn: 0, tempo: 100 });
  const { offers, notes, askTempo } = importOffers(m, s);
  assert.deepEqual(offers.map((o) => [o.field, o.from, o.to]), [
    ['name', 'Untitled', 'Paper Boats'], ['key', 'C', 'G'], ['tempo', '100 BPM', '76 BPM'], ['timeSig', '4/4', '6/8']]);
  assert.deepEqual(notes, []);
  assert.equal(askTempo, false);
  const same = importOffers(m, song({ name: 'Paper Boats', tempo: 76, timeSig: '6/8' }));
  assert.deepEqual(same.offers, []);
  // what the song can't hold is not offered and says why; a missing tempo is asked for (O-AW-1)
  const odd = parseStoredChart({ text: '{key: Em}\n{tempo: 400}\n{time: 7/8}\n[Em]x', format: 'chordpro' });
  const r = importOffers(odd, song({ hearIn: 4, minor: false }));
  assert.deepEqual(r.offers.map((o) => [o.field, o.to]), [['key', 'Em']], 'E major → E minor is a key change');
  assert.equal(r.notes.length, 2);
  assert.match(r.notes[0], /400 BPM/);
  assert.match(r.notes[1], /7\/8/);
  assert.equal(r.askTempo, false, 'the chart has a tempo, just an unusable one');
  const none = parseStoredChart({ text: PLAIN, format: 'plain' });
  assert.equal(importOffers(none, song()).askTempo, true);
  assert.equal(importOffers(none, song({ tempo: 90 })).askTempo, false);
});

test('offer writes: only the ticked ones; a key keeps the Easy Transpose amount', () => {
  const m = parseStoredChart({ text: PRO, format: 'chordpro' });
  const s = song({ name: 'Untitled', playIn: 0, hearIn: 2, tempo: 100 }); // play in C, hear D (+2)
  const { offers } = importOffers(m, s);
  assert.deepEqual(offerWrites([], s), []);
  const key = offers.find((o) => o.field === 'key');
  assert.deepEqual(offerWrites([key], s), [['hearIn', 7], ['playIn', 5], ['minor', false]], 'hear G, play F');
  assert.deepEqual(offerWrites(offers.filter((o) => o.field !== 'key'), s),
    [['name', 'Paper Boats'], ['tempo', 76], ['timeSig', '6/8']]);
  assert.deepEqual(offerWrites([{ field: 'timeSig', value: '4/4' }], s), [['timeSig', null]], '4/4 = absent');
  assert.deepEqual(offerWrites([{ field: 'tempo', value: 999 }], s), [['tempo', 300]]);
  assert.deepEqual(offerWrites([{ field: 'bogus', value: 1 }, null], s), []);
});

test('readImport + csvPlaceholders: a song list makes placeholder songs for new titles only', () => {
  const csv = 'Title,Author,CCLI Number\nPaper Boats,A. Writer,1234567\n"Morning Test",,\npaper  boats,,\nOld One,,\n';
  const r = readImport(csv, { name: 'songs.csv' });
  assert.equal(r.kind, 'csv');
  assert.equal(r.songs.length, 4);
  const p = csvPlaceholders(r.songs, ['old one']);
  assert.deepEqual(p.add,
    [{ name: 'Paper Boats', notes: 'A. Writer · CCLI 1234567' }, { name: 'Morning Test', notes: '' }]);
  assert.deepEqual(p.skipped, ['paper boats', 'Old One'], 'the parser puts a title on one line');
  const c = readImport(PRO, { name: 'x.cho' });
  assert.equal(c.kind, 'chart');
  assert.equal(c.format, 'chordpro');
  assert.equal(readImport(PLAIN).format, 'plain');
  assert.equal(readImport(PRO, { format: 'plain' }).format, 'plain', 'the format choice wins over detection');
});

// skeptic V1 (native/docs/reviews/chart-view.md): a chart whose mode differs from the song's
test('shift: a relative-key chart keeps the song’s key signature; a parallel one keeps its tonic', () => {
  const em = { text: '{key: Em}\n[Em]a [C]b [G]c [D]d\n', format: 'chordpro' };
  const g = { text: '{key: G}\n[G]a [C]b [D]c [Em]d\n', format: 'chordpro' };
  // Em chart on a song set to G: shown as written (was Gm Eb Bb F over a G drone)
  let v = chartView(song({ chart: em }));
  assert.equal(v.shift, 0);
  assert.deepEqual(chordsOf(v.model), ['Em', 'C', 'G', 'D']);
  // G chart on a song set to Em
  v = chartView(song({ chart: g, playIn: 4, hearIn: 4, minor: true }));
  assert.deepEqual(chordsOf(v.model), ['G', 'C', 'D', 'Em']);
  // Easy Transpose still moves it by exactly the transpose amount, in both modes
  v = chartView(song({ chart: em, playIn: 7, hearIn: 9 }));
  assert.equal(v.shownKey, 'F#m');
  assert.deepEqual(chordsOf(v.model), ['F#m', 'D', 'A', 'E']);
  assert.deepEqual(chordsOf(chartView(song({ chart: em, playIn: 7, hearIn: 9 }), 'play').model), ['Em', 'C', 'G', 'D']);
  // the chart written in the heard key's relative (F#m on a G → A song) matches through Hear In
  const fsm = { text: '{key: F#m}\n[F#m]a [D]b\n', format: 'chordpro' };
  assert.equal(chartView(song({ chart: fsm, playIn: 7, hearIn: 9 })).shift, 0);
  assert.equal(chartView(song({ chart: fsm, playIn: 7, hearIn: 9 }), 'play').shift, 10);
  // parallel (Em chart, song E): the tonic match stays
  assert.equal(chartShift(song({ playIn: 4, hearIn: 4 }), 'Em'), 0);
  // neither tonic nor relative matches: the tonic match stays (Am chart → song D major: +5)
  assert.equal(chartShift(song({ playIn: 2, hearIn: 2 }), 'Am'), 5);
  // for every song key and transpose, Heard − Hands is the transpose amount
  for (let p = 0; p < 12; p++) {
    for (let t = 0; t < 12; t++) {
      for (const minor of [false, true]) {
        const s = song({ playIn: p, hearIn: (p + t) % 12, minor });
        for (const key of ['Em', 'G', 'Bbm', 'C#']) {
          assert.equal((chartShift(s, key) - chartShift(s, key, 'play') + 12) % 12, t, `${p} ${t} ${minor} ${key}`);
        }
      }
    }
  }
});
