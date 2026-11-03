// importer-host.js (v11-importer): the Electron-main side of the in-app GarageBand importer, driven with the
// child_process.fork worker adapter (main.js uses utilityProcess; same messages) against a SYNTHETIC library and a
// fake ffmpeg (test/unit/exs/fake-library.mjs). Covers: scan → opaque keys (no paths reach the page), key / limit
// validation, one operation at a time, progress snapshots, Stop, and a worker that dies.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildLibrary } from '../exs/fake-library.mjs';

const require = createRequire(import.meta.url);
const { createGarageBandImporter, forkWorker, LIMITS, keyOf } = require('../../../importer-host.js');

let L;
before(() => {
  L = buildLibrary();
});
after(() => L.cleanup());

function make({ ms = 0, out = L.out, onProgress } = {}) {
  const env = { ...process.env, FFMPEG: L.ffmpeg, AFCONVERT: L.noBin, FAKE_FFMPEG_MS: String(ms) };
  const snaps = [];
  const logs = [];
  const imp = createGarageBandImporter({
    spawn: () => forkWorker(undefined, { env }),
    roots: [L.lib], out: () => out, allowedOut: () => [L.out], cache: L.cache, jobs: 1,
    log: (...a) => logs.push(a.join(' ')),
    onProgress: (s) => {
      snaps.push(s);
      if (onProgress) onProgress(s, imp);
    },
  });
  return { imp, snaps, logs };
}

const settle = (imp, ms = 20000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = setInterval(() => {
    const s = imp.status();
    if (s.state !== 'importing' && !s.busy) {
      clearInterval(tick);
      resolve(s);
    } else if (Date.now() - t0 > ms) {
      clearInterval(tick);
      reject(new Error(`still ${s.state} after ${ms} ms`));
    }
  }, 25);
});

test('scan: instruments with opaque keys and no absolute paths; limits and encoder for the dialog', async () => {
  const { imp } = make();
  const r = await imp.scan();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.instruments.map((i) => i.name), ['Test Grand Piano', 'Test Strings Ensemble']);
  const exsPath = path.join(L.lib, 'Sampler Instruments', 'Test Grand Piano.exs');
  assert.equal(r.instruments[0].key, keyOf(exsPath));
  assert.ok(!JSON.stringify(r.instruments).includes(L.lib), 'no library path in the instrument list');
  assert.equal(r.encoder.ffmpeg, true);
  assert.deepEqual(r.limits, { maxPerImport: LIMITS.maxPerImport, maxTotalMb: LIMITS.maxTotalMb });
  assert.equal(r.parseErrors, 1);
  assert.equal(imp.status().state, 'idle');
});

test('start: unknown keys, empty / oversized selections and instruments without sounds are refused', async () => {
  const M = buildLibrary({ missingStrings: true });
  try {
    const env = { ...process.env, FFMPEG: M.ffmpeg, AFCONVERT: M.noBin };
    const imp = createGarageBandImporter({ spawn: () => forkWorker(undefined, { env }), roots: [M.lib], out: () => M.out, cache: M.cache });
    assert.equal(imp.start(['x']).error, 'unknown-instrument', 'nothing scanned yet');
    const r = await imp.scan();
    const strings = r.instruments.find((i) => i.id === 'test-strings-ensemble');
    assert.equal(strings.found, 0);
    assert.equal(imp.start([]).error, 'nothing-selected');
    assert.equal(imp.start('abc').error, 'nothing-selected');
    assert.equal(imp.start([strings.key]).error, 'no-samples');
    assert.equal(imp.start(['../../etc/passwd']).error, 'unknown-instrument', 'a path is never a key');
    assert.equal(imp.start(Array.from({ length: LIMITS.maxPerImport + 1 }, (_, i) => `k${i}`)).error, 'too-many');
    assert.equal(imp.status().state, 'idle', 'nothing started');
  } finally {
    M.cleanup();
  }
});

test('import: progress snapshots per instrument, then done; one operation at a time', async () => {
  const { imp, snaps } = make({ ms: 5 });
  const r = await imp.scan();
  const started = imp.start(r.instruments.map((i) => i.key));
  assert.deepEqual(started, { ok: true, total: 2 });
  assert.equal(imp.start(r.instruments.map((i) => i.key)).error, 'busy');
  assert.equal((await imp.scan()).error, 'busy');
  const s = await settle(imp);
  assert.equal(s.state, 'done', JSON.stringify(s));
  assert.deepEqual([s.imported, s.failed, s.total, s.format], [2, 0, 2, 'mp3']);
  assert.deepEqual(s.items.map((i) => [i.name, i.state, i.done, i.files, i.notes]), [
    ['Test Grand Piano', 'done', 27, 27, 27], ['Test Strings Ensemble', 'done', 7, 7, 7]]);
  assert.equal(snaps[0].state, 'importing');
  assert.ok(snaps.some((x) => x.items[0].state === 'converting' && x.items[0].done > 0 && x.items[0].done < 27), 'mid-way progress');
  assert.equal(snaps.at(-1).state, 'done');
  // throttled: far fewer snapshots than the 34 file events, but every state change got through
  assert.ok(snaps.length < 40, `${snaps.length} snapshots`);
  assert.ok(fs.existsSync(path.join(L.out, 'test-grand-piano', 'manifest.json')));
  assert.ok(fs.existsSync(path.join(L.out, 'test-strings-ensemble', 'manifest.json')));
  const again = await imp.scan();
  assert.equal(again.instruments.every((i) => i.installed), true);
});

test('cancel: Stop mid-import → cancelled, the current instrument is not installed, no work folder left', async () => {
  const out = path.join(L.out, 'stop');
  fs.mkdirSync(out, { recursive: true });
  let asked = false;
  const { imp } = make({
    ms: 120, out,
    onProgress: (s, i) => {
      if (!asked && s.items[0] && s.items[0].done >= 2) {
        asked = true;
        assert.deepEqual(i.cancel(), { ok: true });
      }
    },
  });
  const r = await imp.scan();
  imp.start(r.instruments.map((i) => i.key));
  const t0 = Date.now();
  const s = await settle(imp);
  assert.equal(s.state, 'cancelled', JSON.stringify(s));
  assert.equal(s.imported, 0);
  assert.deepEqual(s.items.map((i) => i.state), ['cancelled', 'cancelled']);
  assert.ok(Date.now() - t0 < 4000, `${Date.now() - t0} ms`);
  assert.deepEqual(fs.readdirSync(out), []);
  assert.equal(imp.cancel().ok, false, 'nothing left to stop');
});

test('a worker that dies mid-import → failed with a reason; the next scan works', async () => {
  let killed = false;
  const env = { ...process.env, FFMPEG: L.ffmpeg, AFCONVERT: L.noBin, FAKE_FFMPEG_MS: '150' };
  let last = null;
  const imp = createGarageBandImporter({
    spawn: () => {
      last = forkWorker(undefined, { env });
      return last;
    },
    roots: [L.lib], out: () => path.join(L.out, 'crash'), allowedOut: () => [L.out], cache: L.cache, jobs: 1,
    onProgress: (s) => {
      if (!killed && s.items[0] && s.items[0].done >= 1) {
        killed = true;
        process.kill(last.pid, 'SIGKILL'); // a crash (SIGTERM is the app quitting: that one cancels cleanly)
      }
    },
  });
  const r = await imp.scan();
  imp.start([r.instruments[0].key]);
  const s = await settle(imp);
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'worker-exit');
  assert.equal((await imp.scan()).ok, true);
  imp.dispose();
});

test('SIGTERM (the app quitting) cancels the import cleanly: no half-written pack or work folder', async () => {
  const out = path.join(L.out, 'quit');
  fs.mkdirSync(out, { recursive: true });
  let quit = false;
  const { imp } = make({
    ms: 150, out,
    onProgress: (s, i) => {
      if (!quit && s.items[0] && s.items[0].done >= 1) {
        quit = true;
        i.dispose();
      }
    },
  });
  const r = await imp.scan();
  imp.start([r.instruments[0].key]);
  await new Promise((res) => {
    const t = setInterval(() => {
      if (quit) {
        clearInterval(t);
        res();
      }
    }, 20);
  });
  await new Promise((res) => setTimeout(res, 1500));
  assert.deepEqual(fs.readdirSync(out), []);
});

test('the worker refuses an output folder outside the My Samples roots (even if main asked for it)', async () => {
  const { imp } = make({ out: path.join(L.T, 'outside-roots') });
  const r = await imp.scan();
  imp.start([r.instruments[0].key]);
  const s = await settle(imp);
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'bad-out');
  assert.ok(!fs.existsSync(path.join(L.T, 'outside-roots', 'test-grand-piano')));
});
