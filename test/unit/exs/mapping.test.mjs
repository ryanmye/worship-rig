import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExs } from '../../../tools/exs/parser.mjs';
import { writeExs } from '../../../tools/exs/writer.mjs';
import { flatName, slugify, classify, planInstrument, subsampleNotes, zoneSlice, sourceKey, planSegments, manifestEntry, estimateBytes, PIANO_RE } from '../../../tools/exs/mapping.mjs';
import { parseNoteName } from '../../../app/js/shared/music.js';
import { normalizeManifest } from '../../../app/js/engine/sampler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(here, '../../../tools/exs/fixtures', n), 'utf8'));
const plan = (desc, opts = {}) => planInstrument(parseExs(writeExs(desc)), { name: desc.name, ...opts });
const notesOf = (L) => L.picks.map((p) => p.note);

test('flatName uses flats and C4 = 60, round-trips through the app parser', () => {
  assert.equal(flatName(60), 'C4');
  assert.equal(flatName(61), 'Db4');
  assert.equal(flatName(21), 'A0');
  assert.equal(flatName(108), 'C8');
  assert.equal(flatName(0), 'C-1');
  assert.equal(flatName(127), 'G9');
  for (let m = 0; m < 128; m++) assert.equal(parseNoteName(flatName(m)), m);
});

test('slugify', () => {
  assert.equal(slugify('Steinway Grand Piano'), 'steinway-grand-piano');
  assert.equal(slugify('  Bösendorfer / Imperial!! '), 'bosendorfer-imperial');
  assert.equal(slugify('***'), 'instrument');
});

test('classify: category, group and release τ from the name', () => {
  const c = (n) => classify(n);
  assert.deepEqual(c('Steinway Grand Piano'), { category: 'piano', release: 0.12 });
  assert.equal(c('Classic Electric Piano').category, 'ep');
  assert.deepEqual(c('Orchestra Strings'), { category: 'strings', group: 'Strings', release: 0.6 });
  assert.deepEqual(c('Boys Choir'), { category: 'choir', group: 'Choir', release: 0.6 });
  assert.deepEqual(c('Warm Pad'), { category: 'pad', group: 'Pads', release: 0.6 });
  assert.equal(c('Steel String Acoustic').category, 'guitar');
  assert.equal(c('Tubular Bells').category, 'mallet');
  assert.equal(c('Steel Drums').category, 'mallet');
  assert.equal(c('Church Organ').release, 0.4);
  assert.equal(c('French Horn').release, 0.4);
  assert.deepEqual(c('Mystery Box'), { category: 'other', group: 'GarageBand', release: 0.12 });
  assert.ok(PIANO_RE.test('Upright Studio') && PIANO_RE.test('Vintage Keys') && !PIANO_RE.test('Strings'));
});

test('piano fixture → one layer per velocity range, release-trigger group skipped, round-robin → first', () => {
  const p = plan(fixture('test-grand-piano.json'));
  assert.equal(p.id, 'test-grand-piano');
  assert.equal(p.category, 'piano');
  assert.deepEqual(p.layers.map((L) => L.vel), [[0, 50], [51, 100], [101, 127]]);
  assert.deepEqual(p.layers.map((L) => L.dir), ['v0-50', 'v51-100', 'v101-127']);
  for (const L of p.layers) assert.deepEqual(notesOf(L), ['C3', 'Eb3', 'Gb3', 'A3', 'C4', 'Eb4', 'Gb4', 'A4', 'C5']);
  const c4 = p.layers[1].picks.find((x) => x.note === 'C4');
  assert.equal(c4.zone.name, 'TP 60 v2', 'first zone wins over its round-robin');
  assert.equal(p.skipped.length, 3);
  assert.ok(p.skipped.every((s) => /release-trigger/.test(s.reason)));
  assert.ok(p.warnings.some((w) => /share a root note/.test(w)));
  // no layer uses a key-off sample
  for (const L of p.layers) for (const x of L.picks) assert.ok(!/rel/.test(x.zone.name));
});

test('keys split differently per register → merged union bands, every band fully covered', () => {
  const zones = [];
  const samples = [];
  const add = (root, lo, hi) => {
    samples.push({ fileName: `${root}-${lo}.wav` });
    zones.push({ root, velLow: lo, velHigh: hi, sample: samples.length - 1 });
  };
  for (const r of [48, 52]) {
    add(r, 0, 63);
    add(r, 64, 127);
  }
  for (const r of [60, 64]) {
    add(r, 0, 40);
    add(r, 41, 90);
    add(r, 91, 127);
  }
  const p = plan({ name: 'Split Piano', zones, samples });
  assert.deepEqual(p.layers.map((L) => L.vel), [[0, 40], [41, 63], [64, 90], [91, 127]]);
  for (const L of p.layers) assert.deepEqual(notesOf(L), ['C3', 'E3', 'C4', 'E4']);
  const pick = (li, note) => p.layers[li].picks.find((x) => x.note === note).zone;
  assert.equal(pick(1, 'C3').velHigh, 63);
  assert.equal(pick(1, 'C4').velLow, 41);
  assert.equal(pick(2, 'C3').velLow, 64);
  assert.equal(pick(2, 'C4').velLow, 41);
});

test('single velocity range → one layer 0..127; velocity gaps are extended at the edges', () => {
  const p = plan({ name: 'Harp', zones: [{ root: 60, velLow: 10, velHigh: 120 }, { root: 67, velLow: 10, velHigh: 120, sample: 1 }], samples: [{ fileName: 'a.wav' }, { fileName: 'b.wav' }] });
  assert.equal(p.layers.length, 1);
  assert.deepEqual(p.layers[0].vel, [0, 127]);
  assert.deepEqual(notesOf(p.layers[0]), ['C4', 'G4']);
});

test('auxiliary groups (by name) and muted groups are skipped even without the trigger flag', () => {
  const p = plan({
    name: 'Grand',
    groups: [{ name: 'Body' }, { name: 'Pedal Noise' }, { name: 'Hidden', mute: true }],
    zones: [{ root: 60, group: 0, sample: 0 }, { root: 62, group: 1, sample: 1 }, { root: 64, group: 2, sample: 2 }],
    samples: [{ fileName: 'a.wav' }, { fileName: 'b.wav' }, { fileName: 'c.wav' }],
  });
  assert.deepEqual(notesOf(p.layers[0]), ['C4']);
  assert.equal(p.skipped.length, 2);
});

test('coarse tune shifts the effective root; loops produce a warning', () => {
  const p = plan(fixture('test-strings.json'));
  assert.equal(p.category, 'strings');
  assert.equal(p.release, 0.6);
  assert.deepEqual(notesOf(p.layers[0]), ['G2', 'D3', 'G3', 'Db4', 'G4', 'Db5', 'G5']);
  assert.ok(p.warnings.some((w) => /one-shot/.test(w)));
});

test('velocity flag off → zone range ignored and the GROUP range applies (as in Logic; verified on real files)', () => {
  const p = plan({
    name: 'P',
    groups: [{ name: 'soft', minVel: 0, maxVel: 63 }, { name: 'loud', minVel: 64, maxVel: 127 }],
    zones: [{ root: 60, velLow: 0, velHigh: 20, velRangeOn: false, group: 0 }, { root: 60, velLow: 108, velHigh: 127, velRangeOn: false, group: 1, sample: 1 }],
    samples: [{ fileName: 'a.wav' }, { fileName: 'b.wav' }],
  });
  assert.deepEqual(p.layers.map((L) => L.vel), [[0, 63], [64, 127]]);
  // flag on → zone ∩ group
  const q = plan({ name: 'Q', groups: [{ name: 'g', minVel: 0, maxVel: 100 }], zones: [{ root: 60, velLow: 50, velHigh: 127, group: 0 }, { root: 60, velLow: 0, velHigh: 49, group: 0, sample: 1 }], samples: [{ fileName: 'a.wav' }, { fileName: 'b.wav' }] });
  assert.deepEqual(q.layers.map((L) => [L.vel, L.picks[0].zone.sampleIndex]), [[[0, 49], 1], [[50, 127], 0]]);
});

test('sustain-pedal-down groups (CC64 64-127) are skipped; pedal-up and "No Dampers" groups are kept', () => {
  const p = plan({
    name: 'Grand',
    groups: [
      { name: 'Sustain pedal #1', selectCC: { number: 64, low: 0, high: 63 } },
      { name: 'Sustain pedal #2', selectCC: { number: 64, low: 64, high: 127 } },
      { name: 'V2 No Dampers', selectCC: { number: 64, low: 0, high: 63 }, keyLow: 92, keyHigh: 127 },
    ],
    zones: [{ root: 60, group: 0, sample: 0 }, { root: 62, group: 1, sample: 1 }, { root: 96, group: 2, sample: 2 }],
    samples: [{ fileName: 'a.wav' }, { fileName: 'b.wav' }, { fileName: 'c.wav' }],
  });
  assert.deepEqual(notesOf(p.layers[0]), ['C4', 'C7']);
  assert.equal(p.skipped.length, 1);
  assert.match(p.skipped[0].reason, /sustain-pedal-down group "Sustain pedal #2" \(CC64 64-127\)/);
});

test('a borrowed neighbour sample never displaces the zone whose key range contains the root', () => {
  // Yamaha "1 piano": key 41 plays 042_ped_s (root 42) and comes before key 42's own zone in file order.
  const p = plan({
    name: 'P',
    zones: [{ root: 42, keyLow: 41, keyHigh: 41, sample: 0 }, { root: 42, keyLow: 42, keyHigh: 42, sample: 1 }],
    samples: [{ fileName: '042_ped_s.wav' }, { fileName: '042_F#1KM56_S.wav' }],
  });
  assert.equal(p.layers[0].picks[0].zone.sampleIndex, 1);
});

test('bands that play the same audio merge (Yamaha ff/f), even if one borrows a neighbour for a root or two', () => {
  const samples = [];
  const zones = [];
  for (const r of [48, 50, 52, 53]) {
    samples.push({ fileName: `${r}_H.wav` });
    zones.push({ root: r, keyLow: r, keyHigh: r, velLow: 100, velHigh: 117, sample: samples.length - 1, sampleStart: 0 });
    zones.push({ root: r === 50 ? 52 : r, keyLow: r, keyHigh: r, velLow: 118, velHigh: 127, sample: r === 50 ? samples.length : samples.length - 1, sampleStart: r === 48 ? 35 : 0 });
  }
  const p = plan({ name: 'P', zones, samples });
  assert.deepEqual(p.layers.map((L) => L.vel), [[0, 127]]);
  assert.deepEqual(notesOf(p.layers[0]), ['C3', 'D3', 'E3', 'F3']);
});

test('reversed zones and bad sample indices are skipped', () => {
  const p = plan({ name: 'P', zones: [{ root: 60, reverse: true, sample: 0 }, { root: 62, sample: 9 }, { root: 64, sample: 0 }], samples: [{ fileName: 'a.wav' }] });
  assert.deepEqual(notesOf(p.layers[0]), ['E4']);
  assert.equal(p.skipped.length, 2);
});

test('subsampleNotes: minor-third grid first, then even thinning; ends kept', () => {
  const all = Array.from({ length: 88 }, (_, i) => 21 + i);
  const grid = subsampleNotes(all, 30);
  assert.equal(grid.length, 30);
  assert.equal(grid[0], 21);
  assert.equal(grid[29], 108);
  assert.ok(grid.every((m, i) => i === 0 || m - grid[i - 1] >= 3));
  const ten = subsampleNotes(all, 10);
  assert.equal(ten.length, 10);
  assert.equal(ten[0], 21);
  assert.equal(ten[9], 108);
  assert.deepEqual(subsampleNotes([60, 61, 62], 5), [60, 61, 62]);
  assert.deepEqual(subsampleNotes([60, 61, 62, 63, 64], 1), [62]);
  assert.deepEqual(subsampleNotes([60, 61, 62, 63, 64], 0), [60, 61, 62, 63, 64]);
  // top note within a minor third of the last grid note replaces it
  assert.deepEqual(subsampleNotes([60, 61, 62, 63, 64, 65, 66, 67], 3), [60, 63, 67]);
});

test('--max-notes-per-layer applies per layer', () => {
  const p = plan(fixture('test-grand-piano.json'), { maxNotesPerLayer: 4 });
  for (const L of p.layers) assert.deepEqual(notesOf(L), ['C3', 'A3', 'Eb4', 'C5']);
});

test('zoneSlice / sourceKey', () => {
  const smp = { length: 1000 };
  assert.equal(zoneSlice({ sampleStart: 0, sampleEnd: 0 }, smp), null);
  assert.equal(zoneSlice({ sampleStart: 0, sampleEnd: 999 }, smp), null);
  assert.deepEqual(zoneSlice({ sampleStart: 100, sampleEnd: 0 }, smp), { start: 100, end: null });
  assert.deepEqual(zoneSlice({ sampleStart: 100, sampleEnd: 500 }, smp), { start: 100, end: 500 });
  assert.deepEqual(zoneSlice({ sampleStart: 0, sampleEnd: 500 }, smp), { start: 0, end: 500 });
  assert.equal(zoneSlice({ sampleStart: 0, sampleEnd: 500 }, { length: 0 }).end, 500);
  assert.equal(zoneSlice({ sampleStart: 600, sampleEnd: 500 }, smp).end, null);
  assert.equal(sourceKey({ sampleIndex: 3, sampleStart: 0, sampleEnd: 0 }, smp), '3');
  assert.equal(sourceKey({ sampleIndex: 3, sampleStart: 10, sampleEnd: 20 }, smp), '3@10-20');
});

test('estimateBytes: mp3 / AAC / WAV, shared files counted once, --max-seconds cap', () => {
  const smp = [{ fileName: 'a.wav', length: 88200, sampleRate: 44100, channels: 2 }, { fileName: 'b.wav', length: 44100 * 30, sampleRate: 44100, channels: 2 }];
  const p = plan({ name: 'P', zones: [{ root: 60, velLow: 0, velHigh: 63 }, { root: 60, velLow: 64, velHigh: 127, sample: 0 }, { root: 72, sample: 1 }], samples: smp });
  assert.equal(p.layers.length, 1, 'two velocity bands playing the same file merge into one layer');
  const one = [{ ...p.layers[0], picks: p.layers[0].picks.filter((x) => x.midi === 60) }];
  const twice = [one[0], { ...one[0] }];
  assert.equal(estimateBytes(twice, smp, 'm4a'), 48000);
  assert.equal(estimateBytes(twice, smp, 'wav'), 352800);
  assert.equal(estimateBytes(twice, smp, 'mp3'), 40000, '160 kb/s = 20000 B/s');
  // 30 s file above C4: auto cap = 11 s
  const hi = [{ ...p.layers[0], picks: p.layers[0].picks.filter((x) => x.midi === 72) }];
  assert.equal(estimateBytes(hi, smp, 'mp3', { maxSeconds: 'auto' }), 11 * 20000);
  assert.equal(estimateBytes(hi, smp, 'mp3', { maxSeconds: 0 }), 30 * 20000);
});

test('zoneSlice / planSegments: two-segment consolidated zones and truncation', () => {
  const caf = { length: 45988864 };
  // Steinway Grand Piano 2 "Zone #1": attack 0..179064, tail 180224..802559 (silence padding in between)
  const z1 = { sampleIndex: 0, sampleStart: 0, sampleEnd: 179064, segment2: { start: 180224, end: 802559 } };
  assert.deepEqual(zoneSlice(z1, caf), { start: 0, end: 179064, segment2: { start: 180224, end: 802559 } });
  assert.equal(sourceKey(z1, caf), '0@0-179064+180224-802559');
  const all = planSegments(zoneSlice(z1, caf), caf.length, 0);
  assert.deepEqual(all.segments, [{ start: 0, end: 179064 }, { start: 180224, end: 802559 }]);
  assert.equal(all.frames, 179064 + 622335);
  assert.equal(all.truncated, false);
  const cut = planSegments(zoneSlice(z1, caf), caf.length, 17 * 44100);
  assert.deepEqual(cut.segments, [{ start: 0, end: 179064 }, { start: 180224, end: 180224 + 17 * 44100 - 179064 }]);
  assert.equal(cut.frames, 17 * 44100);
  assert.equal(cut.truncated, true);
  // a louder layer's zone pointing back at the softest layer's tail (segment 2 BEFORE segment 1)
  const z5 = { sampleIndex: 0, sampleStart: 22815744, sampleEnd: 22994808, segment2: { start: 180224, end: 802559 } };
  assert.deepEqual(planSegments(zoneSlice(z5, caf), caf.length, 0).segments, [{ start: 22815744, end: 22994808 }, { start: 180224, end: 802559 }]);
  // overlapping segment 2 is ignored; whole file / open end
  assert.equal(zoneSlice({ sampleStart: 0, sampleEnd: 500, segment2: { start: 100, end: 900 } }, { length: 1000 }).segment2, undefined);
  assert.deepEqual(planSegments(null, 1000, 0), { segments: [{ start: 0, end: null }], frames: 1000, truncated: false });
  assert.deepEqual(planSegments({ start: 100, end: null }, 0, 50), { segments: [{ start: 100, end: 150 }], frames: 50, truncated: false });
});

test('manifestEntry matches the app schema and loads through the engine normalizer', () => {
  const p = plan(fixture('test-grand-piano.json'));
  const inst = manifestEntry(p, { ext: 'm4a', origin: 'GarageBand', source: 'GarageBand Instrument Library/x.exs' });
  const bundled = JSON.parse(fs.readFileSync(path.join(here, '../../../app/samples/manifest.json'), 'utf8')).instruments[0];
  const optional = new Set(['widthDefault', 'maxMonoLossDb']);
  assert.deepEqual(Object.keys(inst), Object.keys(bundled).filter((k) => !optional.has(k)), 'same keys, same order');
  assert.equal(inst.name, 'Test Grand Piano (GarageBand)');
  assert.equal(inst.gainTrim, 0);
  assert.equal(inst.release, 0.12);
  assert.equal(inst.license, 'personal-use');
  assert.equal(inst.attribution, 'Apple Logic/GarageBand sound library — personal use only, not redistributable');
  assert.deepEqual(inst.layers[0], { vel: [0, 50], dir: 'v0-50', notes: ['C3', 'Eb3', 'Gb3', 'A3', 'C4', 'Eb4', 'Gb4', 'A4', 'C5'] });
  const defs = normalizeManifest({ instruments: [inst] }, 'http://127.0.0.1:8438/user-samples/test-grand-piano/manifest.json');
  assert.equal(defs.length, 1);
  assert.equal(defs[0].layers.length, 3);
  assert.equal(defs[0].layers[0].samples[0].url, 'http://127.0.0.1:8438/user-samples/test-grand-piano/v0-50/C3.m4a');
  assert.equal(defs[0].layers[2].samples[4].midi, 60);
  // group only for categories the engine does not map itself
  const s = manifestEntry(plan(fixture('test-strings.json')), { ext: 'wav' });
  assert.equal(s.group, 'Strings');
  assert.equal(s.ext, 'wav');
  // empty layers dropped
  const w = manifestEntry(p, { ext: 'm4a', writtenLayers: [{ vel: [0, 63], dir: 'a', notes: [] }, { vel: [64, 127], dir: 'b', notes: ['C4'] }] });
  assert.deepEqual(w.layers, [{ vel: [64, 127], dir: 'b', notes: ['C4'] }]);
});
