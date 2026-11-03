// The in-app importer module (v11-importer, tools/exs/importer.mjs): scanLibrary / importInstruments on a SYNTHETIC
// library (test/unit/exs/fake-library.mjs: .exs from the writer, generated WAVs, a fake ffmpeg), path checks, limits,
// cancel, and ffmpeg discovery. Runs in-process; the worker / host round trip is test/unit/shell/importer-host.test.mjs.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLibrary, repo } from './fake-library.mjs';
import {
  scanLibrary, importInstruments, findFfmpeg, defaultJobs, insideDir, APP_LIMITS, freeBytes, libraryRoots,
} from '../../../tools/exs/importer.mjs';
import { DEFAULT_INSTRUMENT_ROOTS } from '../../../tools/exs/sample-index.mjs';

let L;
const saved = {};
before(() => {
  L = buildLibrary();
  for (const k of ['FFMPEG', 'AFCONVERT', 'FAKE_FFMPEG_MS']) saved[k] = process.env[k];
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  L.cleanup();
});
beforeEach(() => {
  process.env.FFMPEG = L.ffmpeg;
  process.env.AFCONVERT = L.noBin;
  process.env.FAKE_FFMPEG_MS = '0';
});

const exs = (name) => path.join(L.lib, 'Sampler Instruments', `${name}.exs`);
const base = () => ({ roots: [L.lib], out: L.out, cache: L.cache, allowedOut: [L.out], freeBytes: 1e12, jobs: 2 });

test('scanLibrary: instruments with sample counts, sizes, encoder; unparseable files counted; nothing written', () => {
  const r = scanLibrary({ roots: [L.lib], out: L.out, cache: L.cache });
  assert.deepEqual(r.instruments.map((i) => i.name), ['Test Grand Piano', 'Test Strings Ensemble']);
  const p = r.instruments[0];
  assert.equal(p.exsPath, exs('Test Grand Piano'));
  assert.equal(p.id, 'test-grand-piano');
  assert.equal(p.category, 'piano');
  assert.deepEqual([p.found, p.needed, p.layers, p.notes, p.installed], [27, 27, 3, 27, false]);
  assert.ok(p.estBytes > 0 && p.sourceBytes > 0, `${p.estBytes} / ${p.sourceBytes}`);
  // the audio the import needs (27 of the folder's WAVs; release-trigger samples are skipped), 4410 frames each
  const dir = path.join(L.lib, 'Sampler Files', 'Test Piano');
  assert.ok(fs.readdirSync(dir).length > 27);
  assert.equal(p.sourceBytes, 27 * fs.statSync(path.join(dir, fs.readdirSync(dir)[0])).size);
  assert.equal(r.parseErrors, 1, 'Broken.exs');
  assert.deepEqual(r.encoder, { encoder: 'ffmpeg', format: 'mp3', ffmpeg: true, afconvert: false, error: null });
  assert.deepEqual(r.roots, [{ path: L.lib, exists: true }]);
  assert.ok(!fs.existsSync(L.out), 'a scan writes nothing to the output folder');
});

test('scanLibrary: no library → empty list (not an error); no converter → encoder.error "no-encoder"', () => {
  const r = scanLibrary({ roots: [path.join(L.T, 'nope')], out: L.out, cache: L.cache });
  assert.deepEqual(r.instruments, []);
  assert.equal(r.roots[0].exists, false);
  process.env.FFMPEG = L.noBin;
  const n = scanLibrary({ roots: [L.lib], out: L.out, cache: L.cache });
  assert.equal(n.encoder.error, 'no-encoder');
  assert.equal(n.instruments.length, 2, 'the list still shows (sizes as mp3)');
  assert.deepEqual(libraryRoots(null).instRoots, DEFAULT_INSTRUMENT_ROOTS, 'no roots → the Apple locations, as the CLI');
});

test('importInstruments: converts into the output folder, reports progress, installs atomically; rescan sees it', async () => {
  const events = [];
  const r = await importInstruments({ ...base(), exsPaths: [exs('Test Grand Piano')], onProgress: (e) => events.push(e) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.cancelled, false);
  assert.deepEqual(r.results.map((x) => [x.id, x.ok, x.notes, x.layers]), [['test-grand-piano', true, 27, 3]]);
  const m = JSON.parse(fs.readFileSync(path.join(L.out, 'test-grand-piano', 'manifest.json'), 'utf8'));
  assert.equal(m.instruments[0].license, 'personal-use');
  assert.equal(m.instruments[0].ext, 'mp3');
  assert.deepEqual(fs.readdirSync(L.out).filter((f) => f.startsWith('.')), [], 'no work folders left');
  assert.equal(events[0].event, 'start');
  assert.deepEqual(events[0].items.map((x) => x.id), ['test-grand-piano']);
  const files = events.filter((e) => e.event === 'file');
  assert.equal(files.length, 27);
  assert.deepEqual(files.at(-1), { event: 'file', index: 0, done: 27, files: 27 });
  assert.ok(events.some((e) => e.event === 'instrument' && e.files === 27));
  assert.equal(events.at(-1).event, 'instrumentDone');
  assert.equal(events.at(-1).ok, true);
  const again = scanLibrary({ roots: [L.lib], out: L.out, cache: L.cache });
  assert.equal(again.instruments.find((i) => i.id === 'test-grand-piano').installed, true);
});

test('importInstruments: paths outside the library, traversal, bad output folders and limits are refused', async () => {
  const outside = path.join(L.T, 'Elsewhere.exs');
  fs.copyFileSync(exs('Test Grand Piano'), outside);
  const run = (o) => importInstruments({ ...base(), exsPaths: [exs('Test Grand Piano')], ...o });
  assert.equal((await run({ exsPaths: [outside] })).error, 'bad-path');
  assert.equal((await run({ exsPaths: [path.join(L.lib, 'Sampler Instruments', '..', '..', 'Elsewhere.exs')] })).error, 'bad-path');
  assert.equal((await run({ exsPaths: ['Sampler Instruments/Test Grand Piano.exs'] })).error, 'bad-path', 'relative');
  // a symlink inside the library that points outside it
  const link = path.join(L.lib, 'Sampler Instruments', 'Sneaky.exs');
  fs.symlinkSync(outside, link);
  try {
    assert.equal((await run({ exsPaths: [link] })).error, 'bad-path');
  } finally {
    fs.rmSync(link);
  }
  const notExs = path.join(L.lib, 'Sampler Files', 'Test Piano', fs.readdirSync(path.join(L.lib, 'Sampler Files', 'Test Piano'))[0]);
  assert.equal((await run({ exsPaths: [notExs] })).error, 'bad-path', 'only .exs files');
  assert.equal((await run({ exsPaths: [] })).error, 'nothing-selected');
  const many = Array.from({ length: APP_LIMITS.maxPerImport + 1 }, (_, i) => path.join(L.lib, `x${i}.exs`));
  assert.equal((await run({ exsPaths: many })).error, 'too-many');
  assert.equal((await run({ out: path.join(repo, 'app', 'samples', 'gb') })).error, 'bad-out', 'never into app/');
  assert.equal((await run({ out: path.join(L.T, 'not-a-scan-root') })).error, 'bad-out', 'outside the My Samples roots');
  assert.equal((await run({ out: 'relative/out' })).error, 'bad-out');
  const space = await run({ freeBytes: 1024 });
  assert.equal(space.error, 'no-space');
  assert.ok(space.estBytes > 0);
  process.env.FFMPEG = L.noBin;
  assert.equal((await run({})).error, 'no-encoder');
  assert.ok(!fs.existsSync(path.join(L.out, 'elsewhere')));
});

test('importInstruments: an abort stops at once, discards the current instrument and skips the rest', async () => {
  process.env.FAKE_FFMPEG_MS = '150';
  const out = path.join(L.out, 'cancel-test');
  const ctl = new AbortController();
  const events = [];
  const t0 = Date.now();
  const r = await importInstruments({
    ...base(), out, allowedOut: [L.out], jobs: 1, signal: ctl.signal,
    exsPaths: [exs('Test Grand Piano'), exs('Test Strings Ensemble')],
    onProgress: (e) => {
      events.push(e);
      if (e.event === 'file' && e.done === 2) ctl.abort();
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.cancelled, true);
  assert.deepEqual(r.results.map((x) => [x.id, x.ok, x.cancelled]), [['test-grand-piano', false, true], ['test-strings-ensemble', false, true]]);
  assert.ok(Date.now() - t0 < 3000, `stopped quickly (${Date.now() - t0} ms; 27 files would take ≥ 4 s)`);
  assert.ok(events.filter((e) => e.event === 'file').length <= 3);
  assert.deepEqual(fs.existsSync(out) ? fs.readdirSync(out) : [], [], 'no pack, no work folder, no .part file');
});

test('importInstruments: an instrument whose sounds are missing fails in its row, the others still import', async () => {
  const M = buildLibrary({ missingStrings: true });
  try {
    const r = await importInstruments({ ...base(), roots: [M.lib], out: M.out, allowedOut: [M.out], cache: M.cache,
      exsPaths: [path.join(M.lib, 'Sampler Instruments', 'Test Strings Ensemble.exs'), path.join(M.lib, 'Sampler Instruments', 'Test Grand Piano.exs')] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.results.map((x) => [x.id, x.ok, x.reason ?? null]), [['test-strings-ensemble', false, 'no-samples'], ['test-grand-piano', true, null]]);
    assert.deepEqual(fs.readdirSync(M.out).sort(), ['test-grand-piano']);
  } finally {
    M.cleanup();
  }
});

test('findFfmpeg: $FFMPEG, then PATH, then Homebrew\'s folders (a Finder-launched app has no /opt/homebrew/bin on PATH)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffdir-'));
  try {
    assert.equal(findFfmpeg({ env: {}, dirs: [dir], onPath: () => false }), null);
    fs.writeFileSync(path.join(dir, 'ffmpeg'), '#!/bin/sh\n');
    fs.chmodSync(path.join(dir, 'ffmpeg'), 0o755);
    assert.equal(findFfmpeg({ env: {}, dirs: ['/nope', dir], onPath: () => false }), path.join(dir, 'ffmpeg'));
    assert.equal(findFfmpeg({ env: {}, dirs: [dir], onPath: () => true }), 'ffmpeg');
    assert.equal(findFfmpeg({ env: { FFMPEG: '/x/ffmpeg' }, dirs: [dir], onPath: () => false }), null, '$FFMPEG is final');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('defaultJobs leaves two cores for audio and UI; insideDir / freeBytes', () => {
  assert.deepEqual([1, 2, 3, 4, 8, 16].map((n) => defaultJobs(n)), [1, 1, 1, 2, 4, 4]);
  assert.equal(insideDir(path.join(L.out, 'a', 'b'), L.out), true);
  assert.equal(insideDir(L.out, L.out), true);
  assert.equal(insideDir(`${L.out}-other`, L.out), false);
  assert.equal(insideDir(path.join(L.out, '..', 'x'), L.out), false);
  assert.ok(freeBytes(path.join(L.T, 'does', 'not', 'exist')) > 0, 'the nearest existing parent');
});
