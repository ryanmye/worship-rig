// Electron boot test: `xvfb-run -a npx electron . --no-sandbox` with a fixture app dir.
// main.js (RIG_SELFTEST=1) loads http://127.0.0.1:8438/, runs fixtures/app/electron-selftest.js, prints one
// "RIG_SELFTEST {json}" line with the page results + console error/warning counts, and quits itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildFixture, repoRoot } from './fixture.mjs';
import { electronEnv } from '../../integration/lib.mjs';
import { parseWavHeader } from '../../../app/js/shared/wav.js';

const require = createRequire(import.meta.url);
const { createServer } = require('../../../server.js');

const fx = buildFixture();
let run;

function boot(fx) {
  return new Promise((resolve) => {
    const hasXvfb = spawnSync('which', ['xvfb-run']).status === 0;
    const isLinux = process.platform === 'linux';
    const cmd = isLinux && hasXvfb ? 'xvfb-run' : 'npx';
    const args = isLinux && hasXvfb ? ['-a', 'npx', 'electron', '.', '--no-sandbox'] : ['electron', '.', ...(isLinux ? ['--no-sandbox'] : [])];
    const child = spawn(cmd, args, {
      cwd: repoRoot,
      env: electronEnv({
        RIG_SELFTEST: '1',
        RIG_APP_DIR: fx.app,
        RIG_PADS_DIR: fx.pads,
        RIG_USER_SAMPLES: fx.userSamples,
        RIG_USER_DATA: fx.userData,
        RIG_RECORDINGS_DIR: fx.recordings,
        RIG_SELFTEST_TIMEOUT_MS: '40000',
        ELECTRON_ENABLE_LOGGING: '0',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const killer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.on('close', (code) => {
      clearTimeout(killer);
      const line = out.split('\n').find((l) => l.startsWith('RIG_SELFTEST '));
      resolve({ code, out, err, report: line ? JSON.parse(line.slice('RIG_SELFTEST '.length)) : null });
    });
  });
}

before(async () => {
  run = await boot(fx);
  if (!run.report) console.log('electron stdout:\n', run.out, '\nstderr (tail):\n', run.err.slice(-4000));
});
after(() => fx.cleanup());

test('boots, loads from 127.0.0.1:8438 and quits by itself with exit 0', () => {
  assert.ok(run.report, 'selftest report printed');
  assert.equal(run.code, 0);
  assert.equal(run.report.timeout, undefined);
  assert.equal(run.report.port, 8438);
  assert.equal(run.report.url, 'http://127.0.0.1:8438/');
  assert.equal(run.report.result.origin, 'http://127.0.0.1:8438');
});

test('window.rig bridge: isElectron, getInfo, pads, onMenu', () => {
  const r = run.report.result;
  assert.equal(r.isElectron, true);
  assert.equal(r.platform, process.platform);
  const info = r.steps.info;
  assert.equal(info.port, 8438);
  assert.equal(info.userData, fx.userData);
  assert.equal(info.recordingsDir, fx.recordings);
  assert.equal(info.padsRoot, fx.pads);
  assert.match(r.steps.padsBaseUrl, /^\/pads\/[A-Za-z0-9_-]+\/$/);
  assert.deepEqual(r.steps.listPads.map((p) => p.path), ['Sunday/Pad - A.wav']);
  assert.ok(r.steps.listPads[0].url.startsWith(r.steps.padsBaseUrl));
  assert.equal(r.steps.onMenu, true);
});

test('same-origin server inside Electron: /pads Range → 206 with correct Content-Range; module MIME', () => {
  const h = run.report.result.steps.http;
  assert.equal(h.range.status, 206);
  const size = fs.statSync(path.join(fx.pads, 'Sunday', 'Pad - A.wav')).size;
  assert.equal(h.range.contentRange, `bytes 0-99/${size}`);
  assert.equal(h.range.length, 100);
  assert.equal(h.jsType, 'text/javascript; charset=utf-8');
  assert.equal(h.health.app, 'worship-rig');
});

test('recorder worklet loads (incl. blob: retry path)', () => {
  assert.deepEqual(run.report.result.steps.worklet, { how: 'blob', nodeOk: true });
});

test('MIDI: permission allowed; failure on this Linux box surfaces as a warning, not an error', () => {
  const m = run.report.result.steps.midi;
  if (!m.ok) assert.ok(['failed', 'unsupported'].includes(m.reason), `reason ${m.reason} (denied would mean the permission handler blocked MIDI)`);
});

const DELIBERATE_404 = '/__selftest-404.json';

test('zero console errors; HTTP responses ≥ 400 are counted too (integration #2: only the deliberate probe 404s)', () => {
  const errs = run.report.console.filter((c) => c.level === 'error');
  assert.deepEqual(errs.map((c) => c.message), [`HTTP 404 GET http://127.0.0.1:8438${DELIBERATE_404}`]);
  assert.equal(run.report.consoleErrors, 1);
  assert.deepEqual(run.report.httpErrors.map((h) => [h.status, new URL(h.url).pathname]), [[404, DELIBERATE_404]]);
  assert.equal(run.report.result.steps.probe404, 404);
});

test('My Samples in Electron: userSamplesDir/getInfo roots, rescan count, manifest + sample served (Range)', () => {
  const st = run.report.result.steps;
  assert.equal(st.userSamplesDir.path, fx.userSamples);
  assert.deepEqual(st.userSamplesDir.roots, [fx.userSamples]);
  assert.equal(st.userSamplesDir.exists, true);
  assert.equal(st.info.userSamplesDir, fx.userSamples);
  assert.equal(st.rescanUserSamples.count, 1);
  assert.deepEqual(st.rescanUserSamples.instruments, [{ id: 'test-keys', name: 'Test Keys (GarageBand)', pack: 'Test Keys' }]);
  const u = st.userSamplesHttp;
  assert.equal(u.health, true);
  assert.deepEqual(u.ids, ['test-keys']);
  assert.match(u.url, /\/user-samples\/[A-Za-z0-9_-]+\/Test%20Keys\/v%201\/A3\.wav$/);
  assert.equal(u.status, 206);
  assert.equal(u.type, 'audio/wav');
});

test('auto-backups land in userData/backups and only the newest 10 are kept', () => {
  const b = run.report.result.steps.backup;
  assert.ok(b.path && b.path.startsWith(path.join(fx.userData, 'backups')));
  const files = fs.readdirSync(path.join(fx.userData, 'backups')).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 10);
  const newest = files.map((f) => JSON.parse(fs.readFileSync(path.join(fx.userData, 'backups', f), 'utf8'))).map((j) => j.n);
  assert.ok(newest.includes(11), 'the latest backup survived');
});

test('streamOpen refuses paths outside the recordings folder unless chosen in the save dialog', () => {
  assert.match(run.report.result.steps.streamOpenDenied.error, /not allowed/);
});

test('Electron recording streams a valid WAV to the recordings folder (when audio runs here)', (t) => {
  const r = run.report.result.steps.record;
  if (r.skipped) return t.skip(r.skipped);
  assert.equal(r.started.ok, true, JSON.stringify(r.started));
  assert.equal(r.result.sink, 'electron');
  assert.ok(r.result.path.startsWith(fx.recordings), r.result.path);
  const buf = fs.readFileSync(r.result.path);
  const h = parseWavHeader(buf);
  assert.equal(h.channels, 2);
  assert.equal(h.bitsPerSample, 16);
  assert.equal(h.dataBytes, buf.length - 44);
  const secs = h.dataBytes / 4 / h.sampleRate;
  assert.ok(Math.abs(secs - 1) <= 0.25, `duration ${secs}`);
  const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, h.dataBytes / 2);
  let peak = 0;
  for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak > 10000, `peak ${peak}`);
});

test('L4: a bare recording name never overwrites: the second take gets " 2"', () => {
  const e = run.report.result.steps.exclusive;
  assert.equal(e.a, path.join(fx.recordings, 'dup.wav'));
  assert.equal(e.b, path.join(fx.recordings, 'dup 2.wav'));
});

test('M6: a reload finishes the page\'s open recording stream, with sizes fixed from the file', () => {
  const st = run.report.result.steps;
  assert.equal(st.afterReload.write.error, 'unknown stream', 'closed on navigation, not at quit');
  const buf = fs.readFileSync(st.abandoned.path);
  assert.equal(buf.length, 1044);
  const h = parseWavHeader(buf);
  assert.equal(h.dataBytes, 1000, 'header says 1000 data bytes although the page never patched it');
});

test('M5 (backups): latestBackup returns the newest rotation file', () => {
  assert.equal(run.report.result.steps.latestBackup.n, 11);
});

test('M5: with 8438 held by another Worship Rig server, Electron runs its own server on 8439 and pads still work', async () => {
  const fx2 = buildFixture();
  const other = createServer({ appDir: fx2.app, port: 8438 });
  const oi = await other.listen();
  let run2;
  try {
    assert.equal(oi.port, 8438, 'test needs 8438 free to hold it');
    fs.mkdirSync(path.join(fx2.userData, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(fx2.userData, 'backups', 'rig-20260101-000000.json'), '{"origin":"http://127.0.0.1:8438","app":"worship-rig","kind":"library","songs":{}}');
    run2 = await boot(fx2);
  } finally {
    await other.close();
  }
  try {
    if (!run2.report) console.log('electron stdout:\n', run2.out, '\nstderr (tail):\n', run2.err.slice(-4000));
    assert.ok(run2.report, 'selftest report printed');
    assert.equal(run2.code, 0);
    assert.equal(run2.report.port, 8439);
    assert.equal(run2.report.result.origin, 'http://127.0.0.1:8439');
    const info = run2.report.result.steps.info;
    assert.deepEqual([info.port, info.preferredPort, info.portChanged, info.reusedServer], [8439, 8438, true, false]);
    assert.equal(info.otherLibrary && info.otherLibrary.origin, 'http://127.0.0.1:8438', 'the 8438 library backup is offered');
    assert.equal(run2.report.result.steps.http.range.status, 206, 'pads served by our own server');
    assert.equal(run2.report.result.steps.listPads[0].path, 'Sunday/Pad - A.wav');
    assert.deepEqual(run2.report.httpErrors.map((h) => new URL(h.url).pathname), [DELIBERATE_404]);
    assert.equal(run2.report.consoleErrors, 1);
  } finally {
    fx2.cleanup();
  }
});

test('L-14: window.close hides the window (menu-bar mode) instead of quitting, and sends windowHidden', (t) => {
  const h = run.report.result.steps.hideOnClose;
  assert.ok(h, 'selftest page ran the hideOnClose step');
  if (h.skipped) return t.skip(`L-14 hook absent: ${h.skipped}; request is in reviews/for-local.md "## L-14"`);
  assert.equal(h.thrown, undefined, h.thrown);
  assert.equal(h.before.windowVisible, true, 'window visible before close');
  assert.equal(h.alive, true, 'the page kept running after window.close()');
  assert.ok(h.ids.includes('windowHidden'), `windowHidden sent over rig:menu, got ${JSON.stringify(h.ids)}`);
  assert.equal(h.after.windowVisible, false, 'window hidden');
  assert.equal(h.after.windowDestroyed, false, 'window hidden, not destroyed');
});
