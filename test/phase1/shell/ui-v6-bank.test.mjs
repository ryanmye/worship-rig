// UI v6 U7a: the Song bank browser's pure model (app/js/views/v6/bank/model.js): tempo bands, key / tag / pack
// options, filtering (search = searchBank's rules), "also in this song". Song and artist names are invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEMPO_BANDS, tempoBand, keyPc, alsoIn, instrumentsOf, bankRow, libraryRow, keyOptions, tagOptions, packOptions,
  filterRows,
} from '../../../app/js/views/v6/bank/model.js';
import { blankSong, defaultFx } from '../../../app/js/presets.js';
import { SPACE_PRESETS, ECHO_PRESETS } from '../../../app/js/shared/fx-presets.js';

const item = (packId, title, o = {}) => ({ packId, pack: packId.split(':')[0], title, inLibrary: null, ...o });
const song = (o = {}) => ({ ...blankSong(), ...o });

test('tempo bands: Slow < 80 ≤ Mid < 115 ≤ Fast; no tempo = no band', () => {
  assert.deepEqual(TEMPO_BANDS.map((b) => b.id), ['slow', 'mid', 'fast']);
  assert.deepEqual([60, 79.9, 80, 114, 115, 200].map(tempoBand), ['slow', 'slow', 'mid', 'mid', 'fast', 'fast']);
  assert.equal(tempoBand(null), null);
  assert.equal(tempoBand(Number.NaN), null);
});

test('rows: the song body’s key / tempo / time first, the bank metadata as the fallback', () => {
  const r = bankRow(item('p:a.json', 'Arbor', { originalKey: 'Eb', bpm: 70, timeSig: '3/4', tags: ['slow'] }),
    song({ hearIn: 2, tempo: 72 }), { p: 'Pack P' });
  assert.deepEqual([r.key, r.originalKey, r.bpm, r.timeSig, r.packName], ['D', 'Eb', 72, '3/4', 'Pack P']);
  const n = bankRow(item('p:b.json', 'Bare', { originalKey: 'F', bpm: 66 }), null);
  assert.deepEqual([n.key, n.bpm, n.timeSig, n.packName], ['F', 66, '4/4', 'p']);
  const l = libraryRow({ ...song({ name: 'Mine', hearIn: 9, minor: true, tempo: 90 }), id: 's1' });
  assert.deepEqual([l.kind, l.id, l.title, l.key, l.bpm, l.inLibrary], ['lib', 's1', 'Mine', 'Am', 90, 's1']);
});

test('options: keys by pitch class (major first), tags by use, packs by name', () => {
  const rows = [
    bankRow(item('b:1.json', 'One', { tags: ['gentle', 'hymn'] }), song({ hearIn: 3 })),
    bankRow(item('a:2.json', 'Two', { tags: ['gentle'] }), song({ hearIn: 0 })),
    bankRow(item('a:3.json', 'Three', { tags: ['big'] }), song({ hearIn: 0, minor: true })),
  ];
  assert.deepEqual(keyOptions(rows), ['C', 'Cm', 'Eb']);
  assert.deepEqual(tagOptions(rows), [{ tag: 'gentle', n: 2 }, { tag: 'big', n: 1 }, { tag: 'hymn', n: 1 }]);
  assert.deepEqual(packOptions(rows).map((p) => [p.slug, p.n]), [['a', 2], ['b', 1]]);
  assert.equal(keyPc('F#m'), 6);
  assert.equal(keyPc('nope'), 99);
});

test('filterRows: every group must match, any chosen tag, packs off, search by title / artist (accents)', () => {
  const rows = [
    bankRow(item('a:1.json', 'Lantern Hymn', { artist: 'Northgate', tags: ['hymn'] }), song({ hearIn: 3, tempo: 68 })),
    bankRow(item('a:2.json', 'Harbour Light', { artist: 'Ríver Hall', tags: ['upbeat'] }), song({ tempo: 128 })),
    bankRow(item('b:3.json', 'Quiet Room', { artist: 'River Hall', tags: ['prayer'] }), song({ tempo: 60 })),
    bankRow(item('b:4.json', 'No Tempo'), song()),
  ];
  const t = (f) => filterRows(rows, f).map((r) => r.title);
  assert.deepEqual(t({}), ['Harbour Light', 'Lantern Hymn', 'No Tempo', 'Quiet Room']);
  assert.deepEqual(t({ q: 'river' }), ['Harbour Light', 'Quiet Room']);
  assert.deepEqual(t({ key: 'Eb' }), ['Lantern Hymn']);
  assert.deepEqual(t({ tempo: 'slow' }), ['Lantern Hymn', 'Quiet Room']);
  assert.deepEqual(t({ tags: ['hymn', 'prayer'] }), ['Lantern Hymn', 'Quiet Room']);
  assert.deepEqual(t({ tags: ['hymn'], tempo: 'fast' }), []);
  assert.deepEqual(t({ packsOff: ['a'] }), ['No Tempo', 'Quiet Room']);
  assert.deepEqual(t({ key: 'any', tempo: 'any', q: '' }).length, 4);
});

test('alsoIn: only what the song has; instrumentsOf skips empty slots, keeps positions', () => {
  const bare = song();
  bare.patch.fx = defaultFx();
  bare.patch.fx.reverb.returnGain = 0;
  bare.patch.fx.delay.returnGain = 0;
  assert.deepEqual(alsoIn(bare), []);
  const full = song({ hearIn: 3, drone: { ...bare.drone, mode: 'synth' }, chart: { text: 'x' } });
  full.patch.fx = defaultFx();
  for (const [p, v] of Object.entries({ ...SPACE_PRESETS.find((x) => x.id === 'cathedral').params,
    ...ECHO_PRESETS.find((x) => x.id === 'dotted').params })) {
    const [, u, k] = p.split('.');
    full.patch.fx[u][k] = v;
  }
  assert.deepEqual(alsoIn(full), ['Drone on Eb', 'Space: Cathedral', 'Echo: Dotted Eighth', 'chart ✓']);
  full.patch.fx.reverb.size = 0.123;
  assert.equal(alsoIn(full)[1], 'Space: Custom');
  assert.deepEqual(alsoIn(null), []);
  const s = song();
  s.patch.slots = [s.patch.slots[0], null, s.patch.slots[1]];
  assert.deepEqual(instrumentsOf(s, (ref) => ref.id), [{ i: 0, name: 'salamander-piano' }, { i: 2, name: 'warm-pad' }]);
});
