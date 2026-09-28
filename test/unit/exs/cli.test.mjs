// End-to-end CLI tests on a synthetic "Apple library" in a temp dir. afconvert is replaced by a fake (AFCONVERT env)
// that copies its input and logs its arguments, and ffmpeg is hidden (FFMPEG env → missing binary), so these exercise
// the afconvert path on Linux. The ffmpeg path (real encoding, consolidated CAF cuts) is covered by convert.test.mjs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeExs } from '../../../tools/exs/writer.mjs';
import { buildWav, readWavInfo } from '../../../tools/exs/wav.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const CLI = path.join(repo, 'tools/import-garageband.mjs');
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(repo, 'tools/exs/fixtures', n), 'utf8'));

let T;
let FAKE;
let LOG;

function wav(frames) {
  const d = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) d.writeInt16LE(i % 32000, i * 4);
  return buildWav({ channels: 2, sampleRate: 44100, bitsPerSample: 16 }, d);
}

before(() => {
  T = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-import-'));
  const lib = path.join(T, 'lib');
  const inst = path.join(lib, 'Sampler Instruments');
  fs.mkdirSync(inst, { recursive: true });
  const piano = fixture('test-grand-piano.json');
  const strings = fixture('test-strings.json');
  fs.writeFileSync(path.join(inst, 'Test Grand Piano.exs'), writeExs(piano));
  fs.writeFileSync(path.join(inst, 'Test Strings Ensemble.exs'), writeExs(strings));
  fs.writeFileSync(path.join(inst, 'Broken.exs'), Buffer.from('not an exs file at all'));
  const ps = path.join(lib, 'Sampler Files', 'Test Piano');
  fs.mkdirSync(ps, { recursive: true });
  for (const s of piano.samples) fs.writeFileSync(path.join(ps, s.fileName), wav(441));
  // strings ship as .caf on disk although the .exs says .aif (stem fallback); content is WAV for the fake converter
  const ss = path.join(lib, 'EXS Factory Samples', 'Test Strings');
  fs.mkdirSync(ss, { recursive: true });
  for (const s of strings.samples) fs.writeFileSync(path.join(ss, s.fileName.replace(/\.aif$/, '.caf')), wav(88200));
  FAKE = path.join(T, 'afconvert');
  LOG = path.join(T, 'afconvert.log');
  fs.writeFileSync(
    FAKE,
    `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === '-h') process.exit(0);
fs.appendFileSync(${JSON.stringify(LOG)}, a.join(' ') + '\\n');
if (process.env.FAKE_NO_AAC && a.includes('m4af')) { console.error('encoder unavailable'); process.exit(1); }
const [src, dst] = a.slice(-2);
fs.copyFileSync(src, dst);
`,
  );
  fs.chmodSync(FAKE, 0o755);
});

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, '--root', path.join(T, 'lib'), '--cache', path.join(T, 'idx.json'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, AFCONVERT: FAKE, FFMPEG: path.join(T, 'no-ffmpeg'), ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('usage / argument errors', () => {
  assert.equal(spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [CLI], { encoding: 'utf8' }).status, 2);
  const bad = spawnSync(process.execPath, [CLI, '--list', '--format', 'flac'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--format must be mp3, m4a or wav/);
  assert.equal(spawnSync(process.execPath, [CLI, '--bogus'], { encoding: 'utf8' }).status, 2);
});

test('--list shows both instruments with resolved sample counts and the unparseable file', () => {
  const r = run(['--list']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Test Grand Piano\s+EXS\s+31\s+27\/27\s+3\s+27/);
  assert.match(r.out, /Test Strings Ensemble\s+EXS\s+7\s+7\/7\s+1\s+7/);
  assert.match(r.out, /2 instrument\(s\)/);
  assert.match(r.out, /Broken\.exs: (not an EXS file|file too short)/);
  assert.ok(fs.existsSync(path.join(T, 'idx.json')), 'index cached');
  assert.ok(!fs.existsSync(LOG) || !fs.readFileSync(LOG, 'utf8').trim(), 'listing converts nothing');
});

test('--dump prints the parse and the plan; --json is machine-readable', () => {
  const f = path.join(T, 'lib/Sampler Instruments/Test Grand Piano.exs');
  const r = run(['--dump', f, '--hex']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /little-endian \(TBOS\)/);
  assert.match(r.out, /zones \(31\)/);
  assert.match(r.out, /layer vel 51-100 → v51-100\/\s+9 notes: C3 Eb3/);
  assert.match(r.out, /skipped 3 zone\(s\): release-trigger group "Key Off"/);
  assert.match(r.out, /raw bytes of the first chunk/);
  const j = JSON.parse(run(['--dump', f, '--json']).out);
  assert.equal(j.parsed.zones.length, 31);
  assert.deepEqual(j.plan.layers.map((L) => L.vel), [[0, 50], [51, 100], [101, 127]]);
  assert.equal(run(['--dump', path.join(T, 'lib/Sampler Instruments/Broken.exs')]).code, 1);
});

test('--dry writes nothing', () => {
  const out = path.join(T, 'out-dry');
  const r = run(['--import', 'grand', '--dry', '--out', out]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\[dry\] Test Grand Piano/);
  assert.match(r.out, /layer vel 0-50: 9\/9 notes/);
  assert.ok(!fs.existsSync(out));
});

test('--import writes manifest + one file per note, m4a by default without ffmpeg', () => {
  const out = path.join(T, 'out');
  fs.rmSync(LOG, { force: true });
  const r = run(['--import', 'GRAND', '--out', out]);
  assert.equal(r.code, 0, r.err + r.out);
  const dir = path.join(out, 'test-grand-piano');
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(m), ['instruments'], 'same top-level shape as app/samples/manifest.json');
  assert.equal(m.instruments.length, 1);
  const inst = m.instruments[0];
  assert.equal(inst.id, 'test-grand-piano');
  assert.equal(inst.ext, 'm4a');
  assert.equal(inst.category, 'piano');
  assert.equal(inst.release, 0.12);
  assert.equal(inst.gainTrim, 0);
  assert.equal(inst.license, 'personal-use');
  assert.equal(inst.attribution, 'Apple Logic/GarageBand sound library — personal use only, not redistributable');
  assert.equal(inst.source, 'EXS Sampler Instruments/Test Grand Piano.exs');
  assert.ok(!('loop' in inst));
  assert.equal(inst.layers.length, 3);
  for (const L of inst.layers) for (const n of L.notes) assert.ok(fs.existsSync(path.join(dir, L.dir, `${n}.m4a`)), `${L.dir}/${n}.m4a`);
  assert.ok(!fs.existsSync(path.join(dir, '_src')));
  assert.deepEqual(fs.readdirSync(out).filter((f) => f.startsWith('.')), [], 'no temp dirs left');
  const calls = fs.readFileSync(LOG, 'utf8').trim().split('\n');
  // m4a is lossy, so every file is lowered by LOSSY_HEADROOM_DB: afconvert can't apply gain, so each source goes
  // whole-file → WAV once, is levelled in JS and then encoded (instead of one direct whole-file encode).
  assert.equal(calls.length, 1 + 27 * 2, 'a one-off format probe + each of the 27 sources: one WAV decode, one m4a encode');
  assert.equal(calls.filter((c) => c.startsWith('-f m4af -d aac -b 192000 ')).length, 28);
  assert.ok(calls.every((c) => c.startsWith('-f m4af -d aac -b 192000 ') || c.startsWith('-f WAVE -d LEI16 ')));
  assert.match(r.out, /Personal use only/);
  assert.match(r.out, /Rescan samples/);
});

test('re-import replaces the folder (no stale files)', () => {
  const out = path.join(T, 'out');
  const dir = path.join(out, 'test-grand-piano');
  fs.writeFileSync(path.join(dir, 'stale.txt'), 'x');
  const r = run(['--import', 'grand', '--out', out, '--format', 'wav', '--max-notes-per-layer', '4']);
  assert.equal(r.code, 0, r.err);
  assert.ok(!fs.existsSync(path.join(dir, 'stale.txt')));
  const inst = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).instruments[0];
  assert.equal(inst.ext, 'wav');
  assert.deepEqual(inst.layers[0].notes, ['C3', 'A3', 'Eb4', 'C5']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'v0-50')).sort(), ['A3.wav', 'C3.wav', 'C5.wav', 'Eb4.wav']);
});

test('AAC failure on the first file falls back to WAV for the whole run', () => {
  const out = path.join(T, 'out-fallback');
  const r = run(['--import', 'grand', '--out', out], { FAKE_NO_AAC: '1' });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /falling back to 16-bit WAV/);
  const inst = JSON.parse(fs.readFileSync(path.join(out, 'test-grand-piano/manifest.json'), 'utf8')).instruments[0];
  assert.equal(inst.ext, 'wav');
  assert.ok(fs.existsSync(path.join(out, 'test-grand-piano/v0-50/C3.wav')));
});

test('strings: stem fallback (.aif → .caf), slice applied, sustaining metadata', () => {
  const out = path.join(T, 'out-strings');
  const r = run(['--import', 'strings', '--out', out, '--format', 'wav']);
  assert.equal(r.code, 0, r.err);
  const dir = path.join(out, 'test-strings-ensemble');
  const inst = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).instruments[0];
  assert.equal(inst.release, 0.6);
  assert.equal(inst.group, 'Strings');
  assert.deepEqual(inst.layers[0].notes, ['G2', 'D3', 'G3', 'Db4', 'G4', 'Db5', 'G5']);
  // zone 2 (root 55 = G3) plays frames 4410..48510 of an 88200-frame file
  const g3 = readWavInfo(fs.readFileSync(path.join(dir, 'v0-127', 'G3.wav')));
  assert.equal(g3.dataLength / g3.blockAlign, 44100);
  const d3 = readWavInfo(fs.readFileSync(path.join(dir, 'v0-127', 'D3.wav')));
  assert.equal(d3.dataLength / d3.blockAlign, 88200);
  assert.match(r.out, /one-shot/);
});

test('--pianos selects by name; missing samples are reported and skipped', () => {
  const missing = path.join(T, 'lib/Sampler Files/Test Piano/TP 60 v1.wav');
  const keep = fs.readFileSync(missing);
  fs.rmSync(missing);
  try {
    const out = path.join(T, 'out-pianos');
    const r = run(['--pianos', '--out', out]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(fs.readdirSync(out), ['test-grand-piano']);
    assert.match(r.out, /1 sample\(s\) not found/);
    const inst = JSON.parse(fs.readFileSync(path.join(out, 'test-grand-piano/manifest.json'), 'utf8')).instruments[0];
    assert.ok(!inst.layers[0].notes.includes('C4'));
    assert.ok(inst.layers[1].notes.includes('C4'));
  } finally {
    fs.writeFileSync(missing, keep);
  }
});

test('no match → exit 1; missing afconvert → exit 1 with a clear message (dry still works)', () => {
  const r = run(['--import', 'zzz-nothing', '--dry']);
  assert.equal(r.code, 1);
  assert.match(r.err, /No instrument matched/);
  const n = run(['--import', 'grand', '--out', path.join(T, 'never')], { AFCONVERT: path.join(T, 'does-not-exist') });
  assert.equal(n.code, 1);
  assert.match(n.err, /Neither ffmpeg nor afconvert was found/);
  assert.equal(run(['--import', 'grand', '--dry'], { AFCONVERT: path.join(T, 'does-not-exist') }).code, 0);
});

test('no instrument folders → exit 1 with guidance', () => {
  const r = spawnSync(process.execPath, [CLI, '--list', '--root', path.join(T, 'nope')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No instrument folders found/);
});
