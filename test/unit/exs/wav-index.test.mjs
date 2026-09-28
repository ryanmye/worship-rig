import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readWavInfo, buildWav, sliceWav } from '../../../tools/exs/wav.mjs';
import { buildIndex, loadOrBuildIndex, resolveSample, storedDirParts, walkFiles } from '../../../tools/exs/sample-index.mjs';

function pcm16(frames, channels = 2) {
  const d = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) d.writeInt16LE((i % 30000) * (c ? -1 : 1), (i * channels + c) * 2);
  return buildWav({ channels, sampleRate: 44100, bitsPerSample: 16 }, d);
}

test('readWavInfo / buildWav', () => {
  const w = pcm16(100);
  const i = readWavInfo(w);
  assert.equal(i.channels, 2);
  assert.equal(i.sampleRate, 44100);
  assert.equal(i.bitsPerSample, 16);
  assert.equal(i.blockAlign, 4);
  assert.equal(i.dataOffset, 44);
  assert.equal(i.dataLength, 400);
  assert.throws(() => readWavInfo(Buffer.from('nope')), /RIFF/);
});

test('readWavInfo skips extra chunks (LIST, odd-sized)', () => {
  const w = pcm16(10, 1);
  const extra = Buffer.concat([Buffer.from('LIST'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc'), Buffer.from([0])]);
  const buf = Buffer.concat([w.subarray(0, 36), extra, w.subarray(36)]);
  const i = readWavInfo(buf);
  assert.equal(i.dataOffset, 36 + extra.length + 8);
  assert.equal(i.dataLength, 20);
});

test('sliceWav keeps exactly frames [start, end)', () => {
  const w = pcm16(1000);
  const s = sliceWav(w, 100, 350);
  const i = readWavInfo(s);
  assert.equal(i.dataLength / i.blockAlign, 250);
  assert.equal(s.readInt16LE(i.dataOffset), 100);
  assert.equal(s.readInt16LE(i.dataOffset + 2), -100);
  assert.equal(readWavInfo(sliceWav(w, 900, null)).dataLength / 4, 100);
  assert.equal(readWavInfo(sliceWav(w, 900, 5000)).dataLength / 4, 100);
  assert.equal(readWavInfo(sliceWav(w, 5000, null)).dataLength, 0);
});

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exs-index-'));
  const mk = (rel, body = 'x') => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };
  return { root, mk };
}

test('walkFiles skips dot-dirs; buildIndex indexes audio only, case-insensitively', () => {
  const { root, mk } = tree();
  mk('A/one.WAV');
  mk('A/.hidden/two.wav');
  mk('B/readme.txt');
  mk('B/three.caf');
  assert.equal(walkFiles(root, () => true).length, 3);
  const idx = buildIndex([root]);
  assert.deepEqual(Object.keys(idx.files).sort(), ['one.wav', 'three.caf']);
  assert.equal(idx.count, 2);
});

test('resolveSample: next to .exs, index name, stored-path tiebreak, stem with other extension', () => {
  const { root, mk } = tree();
  const exs = mk('Inst/Piano.exs');
  const local = mk('Inst/local.wav');
  const a = mk('Samples/Piano A/C3.aif');
  const b = mk('Samples/Piano B/C3.aif');
  const caf = mk('Samples/Strings/Str 60.caf');
  const idx = buildIndex([path.join(root, 'Samples')]);
  assert.deepEqual(resolveSample({ fileName: 'local.wav' }, exs, idx), { path: local, how: 'next to .exs' });
  assert.equal(resolveSample({ fileName: 'c3.AIF', path: '/Volumes/Old/Piano B' }, exs, idx).path, b);
  assert.equal(resolveSample({ fileName: 'C3.aif', path: 'Macintosh HD:Library:Piano A' }, exs, idx).path, a);
  const r = resolveSample({ fileName: 'Str 60.aif', path: '' }, exs, idx);
  assert.equal(r.path, caf);
  assert.match(r.how, /stem/);
  assert.equal(resolveSample({ fileName: 'nothing.wav' }, exs, idx), null);
  assert.equal(resolveSample({ fileName: '' }, exs, idx), null);
  // stored absolute path that exists here
  const abs = mk('Elsewhere/abs.wav');
  assert.deepEqual(resolveSample({ fileName: 'abs.wav', path: path.dirname(abs) }, exs, { files: {} }), { path: abs, how: 'stored path' });
});

test('storedDirParts handles POSIX and HFS paths', () => {
  assert.deepEqual(storedDirParts('/Library/Foo Bar/'), ['library', 'foo bar']);
  assert.deepEqual(storedDirParts('Macintosh HD:Library:X'), ['macintosh hd', 'library', 'x']);
  assert.deepEqual(storedDirParts(''), []);
});

test('loadOrBuildIndex caches, reuses, and rebuilds on demand or when roots change', () => {
  const { root, mk } = tree();
  mk('S/a.wav');
  const cache = path.join(root, 'cache', 'idx.json');
  const r1 = loadOrBuildIndex([path.join(root, 'S')], cache);
  assert.equal(r1.rebuilt, true);
  assert.ok(fs.existsSync(cache));
  const r2 = loadOrBuildIndex([path.join(root, 'S')], cache);
  assert.equal(r2.rebuilt, false);
  assert.ok(r2.index.files['a.wav']);
  assert.equal(loadOrBuildIndex([path.join(root, 'S')], cache, { rebuild: true }).rebuilt, true);
  assert.equal(loadOrBuildIndex([path.join(root, 'S'), root], cache).rebuilt, true, 'different roots → rebuild');
  fs.writeFileSync(cache, '{broken');
  assert.equal(loadOrBuildIndex([path.join(root, 'S')], cache).rebuilt, true);
});
