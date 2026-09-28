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

// L14: the popover loads /mini.html from the app dir; the fixture app has none, so bring the real one (and its
// mini.* siblings; the cloud's views/mini.js comes through the js → app/js symlink)
function addMiniPage(fx) {
  const appDir = path.join(repoRoot, 'app');
  for (const f of fs.readdirSync(appDir).filter((n) => /^mini\./.test(n))) {
    fs.copyFileSync(path.join(appDir, f), path.join(fx.app, f));
  }
}

function boot(fx) {
  addMiniPage(fx);
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

test('menu-bar mode (L14): tray, menu from the bus state, IPC relay both ways, popover, hide-on-close', () => {
  const m = run.report.menubar;
  assert.ok(m && !m.error, JSON.stringify(m && m.error));
  const isMac = process.platform === 'darwin';
  // setMenuBarMode(true) from the page: tray (macOS only in v1), persisted in rig-shell.json
  assert.equal(m.before.on, false);
  assert.equal(m.setMenuBarMode.on, true);
  assert.equal(m.tray, isMac);
  assert.equal(m.shellConfig, true);
  assert.equal(m.menuBeforeState[0], 'Worship Rig is starting…');
  // a state published through window.rig.busPublish rebuilds the menu
  assert.equal(m.publish.ok, true);
  assert.match(m.menu[1].label, /^Memory: \d+ MB$/, 'main + renderer RSS line');
  assert.equal(m.menu[1].enabled, false);
  assert.deepEqual(m.menu.map((i) => i.label).filter((l) => !l.startsWith('Memory: ')), [
    'Now: Selftest Pad + Piano  (D)', 'Selftest Opener  (G)', 'Selftest Pad + Piano  (D)', 'Selftest Closer  (E)',
    'Previous', 'Next', 'Panic (all notes off)', 'Low-resource mode', 'Open Worship Rig', 'Quit Worship Rig',
  ]);
  assert.equal(m.menu[0].enabled, false, 'the current-mode line is a label');
  assert.deepEqual(m.menu.filter((i) => i.type === 'radio').map((i) => i.checked), [false, true, false]);
  assert.deepEqual(m.menu.filter((i) => i.type === 'checkbox').map((i) => [i.label, i.checked]), [['Low-resource mode', true]]);
  // payload validation: size cap, JSON, shape, command types/fields, version; the good state survives
  for (const [k, re] of Object.entries({
    publishTooBig: /too large/, publishNotJson: /invalid JSON/, publishNoModes: /modes/, commandUnknown: /unknown command/,
    commandBadMaster: /master\.value/, commandWrongVersion: /v:1/,
  })) assert.match(String(m.rejects[k]), re, k);
  assert.equal(m.stateKept, true);
  // tray menu clicks → commands in the main renderer (window.rig.onBusCommand)
  assert.deepEqual(m.trayCommands, [
    { v: 1, type: 'selectMode', id: 'st-3' }, { v: 1, type: 'nextMode' }, { v: 1, type: 'lowResource', on: false },
  ]);
  // popover: 320×440 from the same origin, gets the last state on subscribe, its commands reach the main renderer
  assert.equal(m.popoverShown, true);
  assert.equal(new URL(m.popoverUrl).pathname, '/mini.html');
  assert.equal(new URL(m.popoverUrl).origin, run.report.result.origin);
  assert.deepEqual(m.popoverSize, [320, 440]);
  assert.equal(m.popoverState, 'Selftest Pad + Piano');
  assert.equal(m.popoverBridgeState.popoverOpen, true);
  assert.equal(m.popoverCommand.ok, true);
  assert.ok(m.popoverCommands.some((c) => c.type === 'prevMode'), JSON.stringify(m.popoverCommands));
  assert.equal(m.popoverHiddenByEsc, true);
  assert.equal(m.popoverToggled, true);
  assert.deepEqual(m.popoverTransitions, ['show', 'hide', 'show', 'hide']);
  assert.equal(m.after.popoverOpen, false);
  // window events on the Rig menu channel (onMenu ids): the popover opening is not "shown"
  assert.deepEqual(m.eventsOnEnable, ['windowShown'], 'setMenuBarMode(true) reports the current window state');
  assert.deepEqual(m.eventsDuringPopover, []);
  // setMenuBarMode(false) is the source of truth too: tray gone, renderer back to the document's visibility
  assert.equal(m.setMenuBarModeOff.on, false);
  assert.equal(m.trayAfterOff, false);
  assert.deepEqual(m.eventsOnDisable, ['windowFollowDocument']);
  if (isMac) {
    assert.deepEqual(m.hideOnClose, { destroyed: false, visible: false, dock: false }, 'close hides, dock icon hidden');
    assert.equal(m.hideBackup, true, 'hiding still writes the library backup (M5)');
    assert.deepEqual(m.eventsOnHide, ['windowHidden']);
    assert.deepEqual(m.eventsOnOpenMain, ['windowShown']);
    assert.equal(m.openMain.ok, true);
    assert.deepEqual(m.afterOpenMain, { visible: true, dock: true }, 'openMain shows the window and the dock icon');
  }
  // the popover page adds no console errors and no HTTP ≥ 400 (checked by the zero-errors test above, which also
  // counts the popover's console)
  assert.ok(!run.report.httpErrors.some((h) => /mini/.test(h.url)));
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
