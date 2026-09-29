// Parser + planner against six real Apple .exs files (copied from a Logic Pro library; the instrument definitions
// only — no audio). They are Apple content, so they are NOT in the repo: they live in ~/Music/Worship Rig/exs-fixtures
// (override with RIG_EXS_FIXTURES). These pin down the layout in tools/exs/layout.mjs: header counts, zone
// root/keys/velocity, the velocity-range flag vs group velocity, group CC64 "select by", sample 4CC/length, and the
// two-segment zones of consolidated CAFs. Skipped when the fixtures are absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseExs } from '../../../tools/exs/parser.mjs';
import { planInstrument, zoneSlice, planSegments } from '../../../tools/exs/mapping.mjs';

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);
const DIR = expandHome(process.env.RIG_EXS_FIXTURES || '~/Music/Worship Rig/exs-fixtures');
const NAMES = ['Yamaha Grand Piano', 'Grand Piano', 'Steinway Grand Piano 2', 'Steinway Piano 2', 'Flea Market Wurli', 'Lullaby Vibes'];
const missing = NAMES.filter((n) => !fs.existsSync(path.join(DIR, `${n}.exs`)));
const has = missing.length === 0;
if (!has) console.log(`# skipping real .exs tests: ${missing.length}/6 fixtures missing in ${DIR} (set RIG_EXS_FIXTURES)`);
const load = (n) => parseExs(fs.readFileSync(path.join(DIR, `${n}.exs`)));
const plan = (n) => planInstrument(load(n), { name: n });
const opts = { skip: has ? false : `real .exs fixtures not found in ${DIR} (RIG_EXS_FIXTURES)` };
const fileOf = (p, z) => p.samples[z.sampleIndex].fileName;

test('all six parse cleanly: header counts match, key/root/velocity sane', opts, () => {
  const expect = {
    'Yamaha Grand Piano': [688, 8, 477, 'PLANET 3 PIANO'],
    'Grand Piano': [184, 2, 131, 'Grand Piano.exs'],
    'Steinway Grand Piano 2': [224, 20, 1, 'Steinway D-274.exs'],
    'Steinway Piano 2': [280, 25, 1, 'Steinway Piano 2.exs'],
    'Flea Market Wurli': [1, 1, 1, 'Flea Market Wurli'],
    'Lullaby Vibes': [5, 1, 1, 'Lullaby Vibes'],
  };
  for (const [n, [zones, groups, samples, name]] of Object.entries(expect)) {
    const p = load(n);
    assert.equal(p.bigEndian, false, n);
    assert.equal(p.magic, 'TBOS', n);
    assert.equal(p.name, name, n);
    assert.deepEqual(p.counts, { zones, groups, samples, params: 1 }, n);
    assert.equal(p.zones.length, zones, n);
    assert.equal(p.groups.length, groups, n);
    assert.equal(p.samples.length, samples, n);
    assert.deepEqual(p.warnings, [], n);
    for (const z of p.zones) {
      assert.ok(z.rootNote >= 0 && z.rootNote <= 127 && z.keyLow <= z.keyHigh && z.keyHigh <= 127, `${n} ${z.name}`);
      assert.ok(z.velLow <= z.velHigh && z.velHigh <= 127, `${n} ${z.name}`);
      assert.ok(!z.invalid && z.groupIndex >= 0 && z.groupIndex < groups, `${n} ${z.name}`);
    }
  }
});

test('Yamaha Grand Piano: roots equal the file-name prefix, group velocities tile 0..127, sus groups are CC64 64-127', opts, () => {
  const p = load('Yamaha Grand Piano');
  for (const z of p.zones) assert.equal(z.rootNote, parseInt(/^(\d{3})_/.exec(fileOf(p, z))[1], 10), `${z.name} ${fileOf(p, z)}`);
  const z84 = p.zones.find((z) => z.groupIndex === 2 && z.keyLow === 84);
  assert.deepEqual([z84.rootNote, z84.keyHigh, fileOf(p, z84), z84.sampleStart, z84.sampleEnd, z84.velRangeOn], [84, 84, '084_C5KM56_H.wav', 0, 313125, false]);
  assert.deepEqual(p.groups.map((g) => [g.name, g.minVel, g.maxVel, g.select.low, g.select.high]), [
    ['7 ff', 118, 127, 0, 63], ['8 ff sus', 118, 127, 64, 127], ['5 f', 100, 117, 0, 63], ['6 f sus', 100, 117, 64, 127],
    ['3 mf', 65, 99, 0, 63], ['4 mf sus', 65, 99, 64, 127], ['1 piano', 0, 64, 0, 63], ['2 piano sus', 0, 64, 64, 127],
  ]);
  assert.ok(p.groups.every((g) => g.select.type === 'cc' && g.select.number === 64));
  const s = p.samples.find((x) => x.fileName === '061_C#3KM56_H.wav');
  assert.deepEqual([s.length, s.sampleRate, s.bitDepth, s.channels, s.type, s.dataOffset, s.fileSize], [393935, 44100, 16, 2, 'WAVE', 512, 1576252]);
  assert.equal(s.path, '/Library/Application Support/Logic/EXS Factory Samples/01 Acoustic Pianos/Yamaha Grand Piano');
});

test('Yamaha plan: 3 layers S/M/H (ff and f merge), no pedal-down (ped_*) samples', opts, () => {
  const p = load('Yamaha Grand Piano');
  const pl = plan('Yamaha Grand Piano');
  assert.deepEqual(pl.layers.map((L) => [L.vel, L.picks.length]), [[[0, 64], 80], [[65, 99], 86], [[100, 127], 86]]);
  assert.equal(pl.skipped.length, 344);
  assert.ok(pl.skipped.every((s) => /sustain-pedal-down group "\d (ff|f|mf|piano) sus" \(CC64 64-127\)/.test(s.reason)));
  const files = (i) => pl.layers[i].picks.map((x) => fileOf(p, x.zone));
  assert.ok(files(0).every((f) => /KM56_[SM]\.wav$/.test(f)), 'soft layer: _S (Apple borrows _M for A0, C1, Db1)');
  assert.ok(files(1).every((f) => /KM56_M\.wav$/.test(f)));
  assert.ok(files(2).every((f) => /KM56_H\.wav$/.test(f)));
  assert.ok(pl.layers.every((L) => L.picks.every((x) => !/ped/.test(fileOf(p, x.zone)))));
  const c6 = pl.layers[2].picks.find((x) => x.note === 'C6');
  assert.equal(fileOf(p, c6.zone), '084_C5KM56_H.wav', 'Apple names C3 = 60; the app names C4 = 60');
  assert.deepEqual([pl.layers[2].picks[0].note, pl.layers[2].picks.at(-1).note], ['A0', 'C8']);
  // baked levels: piano −2 dB, mf −1 dB, f 0 dB (group volume)
  assert.deepEqual(pl.layers.map((L) => L.picks.find((x) => x.note === 'C4').zone.gainDb), [-2, -1, 0]);
});

test('Grand Piano: zone velocity ranges (flag on) are used; "Sustain pedal #2" (CC64 64-127) skipped, #1 kept', opts, () => {
  const p = load('Grand Piano');
  assert.ok(p.zones.every((z) => z.velRangeOn));
  assert.deepEqual(p.groups.map((g) => [g.name, g.select]), [
    ['Sustain pedal #1', { type: 'cc', number: 64, low: 0, high: 63 }],
    ['Sustain pedal #2', { type: 'cc', number: 64, low: 64, high: 127 }],
  ]);
  const pl = plan('Grand Piano');
  assert.deepEqual(pl.layers.map((L) => [L.vel, L.picks.length]), [[[0, 51], 23], [[52, 88], 23], [[89, 127], 23]]);
  assert.equal(pl.skipped.length, 92);
  const z = p.zones[1];
  assert.deepEqual([z.name, z.rootNote, z.sampleStart, z.sampleEnd, z.fineTune], ['Zone #299', 60, 560, 471193, -2]);
});

test('Steinway Grand Piano 2: consolidated CAF, two-segment zones, group key ranges, 4 layers × 30 notes', opts, () => {
  const p = load('Steinway Grand Piano 2');
  const s = p.samples[0];
  assert.deepEqual([s.fileName, s.type, s.length, s.sampleRate, s.bitDepth, s.channels, s.dataOffset, s.fileSize], ['Steinway Piano_consolidated.caf', 'caff', 45988864, 44100, 16, 2, 4096, 183959552]);
  const z1 = p.zones[0];
  assert.deepEqual([z1.name, z1.rootNote, z1.keyLow, z1.keyHigh, z1.sampleStart, z1.sampleEnd, z1.segment2, z1.loopStart, z1.loopEnd], ['Zone #1', 21, 0, 22, 0, 179064, { start: 180224, end: 802559 }, 796034, 801399]);
  // SEGMENT2_END = LOOP_END + (SEGMENT2_START − SAMPLE_END) for zones that own their tail
  assert.equal(z1.segment2.end, z1.loopEnd + (z1.segment2.start - z1.sampleEnd));
  assert.ok(p.zones.every((z) => z.segment2), 'every zone has a second segment');
  assert.deepEqual(p.groups.slice(0, 4).map((g) => [g.keyLow, g.keyHigh]), [[0, 28], [29, 40], [41, 91], [92, 127]]);
  const pl = plan('Steinway Grand Piano 2');
  assert.deepEqual(pl.layers.map((L) => [L.vel, L.picks.length]), [[[0, 39], 30], [[40, 59], 30], [[60, 89], 30], [[90, 127], 30]]);
  assert.deepEqual(pl.layers[0].picks.map((x) => x.midi), [21, 24, 27, 30, 33, 36, 39, 42, 46, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84, 87, 90, 93, 96, 99, 102, 105, 108]);
  assert.ok(pl.skipped.every((x) => /sustain-pedal-down group "p\d - Steinway pedal/.test(x.reason)));
  assert.ok(pl.layers[0].picks.some((x) => /No Dampers/.test(p.groups[x.zone.groupIndex].name)), '"No Dampers" = top-octave key range, kept');
  // louder layers: own attack, shared tail of the softest layer
  const c4 = pl.layers.map((L) => L.picks.find((x) => x.midi === 60).zone);
  assert.deepEqual(c4.map((z) => z.sampleStart), [11357184, 17400832, 21217280, 25033728]);
  assert.ok(c4.every((z) => z.segment2.start === 11490304 && z.segment2.end === 11706096));
  const seg = planSegments(zoneSlice(c4[3], s), s.length, 16 * 44100);
  assert.deepEqual(seg.segments, [{ start: 25033728, end: 25166028 }, { start: 11490304, end: 11706096 }]);
  assert.equal(seg.truncated, false);
});

test('Steinway Piano 2: same CAF regions, zone volume −5/−6 dB, V5 (90-120) + V6 (121-127) merge', opts, () => {
  const p = load('Steinway Piano 2');
  const z2 = p.zones.find((z) => z.name === 'Zone #2');
  assert.deepEqual([z2.rootNote, z2.volume, z2.sampleStart, z2.sampleEnd, z2.segment2], [24, -5, 803840, 980240, { start: 980992, end: 1922399 }]);
  const pl = plan('Steinway Piano 2');
  assert.deepEqual(pl.layers.map((L) => L.vel), [[0, 39], [40, 59], [60, 89], [90, 127]]);
  assert.ok(pl.layers.every((L) => L.picks.length === 30));
});

test('Keyboard Collection: consolidated 24-bit CAFs, velocity flag on, single-segment offsets', opts, () => {
  const w = load('Flea Market Wurli');
  const z = w.zones[0];
  assert.deepEqual([z.rootNote, z.keyLow, z.keyHigh, z.velLow, z.velHigh, z.velRangeOn, z.sampleStart, z.sampleEnd, z.segment2], [72, 0, 127, 1, 127, true, 8192, 387179, null]);
  assert.deepEqual([w.samples[0].fileName, w.samples[0].type, w.samples[0].bitDepth, w.samples[0].length], ['Flea Market Wurli_consolidated.caf', 'caff', 24, 396288]);
  const v = load('Lullaby Vibes');
  assert.deepEqual(v.zones.map((x) => [x.rootNote, x.keyLow, x.keyHigh, x.sampleStart, x.sampleEnd]), [
    [48, 0, 42, 8192, 364075], [60, 43, 54, 380928, 823351], [72, 55, 66, 840704, 1290237], [84, 67, 78, 1306624, 1659445], [96, 79, 127, 1676288, 1899780],
  ]);
  const pl = plan('Lullaby Vibes');
  assert.equal(pl.category, 'mallet');
  assert.deepEqual(pl.layers.map((L) => L.picks.map((x) => x.note)), [['C3', 'C4', 'C5', 'C6', 'C7']]);
});
