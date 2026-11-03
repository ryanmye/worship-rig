// v11-importer: the in-app GarageBand importer through the REAL Electron main (preload → ipcMain → importer-host.js →
// utilityProcess worker → tools/exs/importer.mjs), on a SYNTHETIC library (test/unit/exs/fake-library.mjs) with a
// fake ffmpeg. main.js runs importerSelftest() when RIG_SELFTEST=1 and RIG_GB_LIBRARY are set. Runs on a free port
// (RIG_PORT), not 8438, so it never collides with electron.boot.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { repoRoot } from './fixture.mjs';
import { electronEnv } from '../../integration/lib.mjs';
import { buildLibrary } from '../../unit/exs/fake-library.mjs';

// The library and a minimal app dir: one page whose script only says "ready" (window.__RIG_SELFTEST__), so main's
// poll goes on to importerSelftest(); the shell fixture's own steps (recording, hide-on-close) are electron.boot.mjs's.
const L = buildLibrary({ missingStrings: true });
const fx = {
  app: path.join(L.T, 'app'),
  userSamples: path.join(L.T, 'Music', 'Worship Rig', 'Samples'),
  userData: path.join(L.T, 'userData'),
  recordings: path.join(L.T, 'recordings'),
};
fs.mkdirSync(fx.app, { recursive: true });
fs.mkdirSync(fx.userSamples, { recursive: true });
fs.writeFileSync(path.join(fx.app, 'index.html'), '<!doctype html><meta charset="utf-8"><title>importer</title>'
  + '<link rel="icon" href="data:,"><script src="selftest.js"></script>');
// main's menu-bar self-test opens the popover (mini.html) on any page: a blank one keeps it free of 404s
fs.writeFileSync(path.join(fx.app, 'mini.html'), '<!doctype html><meta charset="utf-8"><title>mini</title><link rel="icon" href="data:,">');
fs.writeFileSync(path.join(fx.app, 'selftest.js'), 'window.__RIG_SELFTEST__ = { ready: true, isElectron: !!(window.rig && window.rig.isElectron) };\n');
let run;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

before(async () => {
  const port = await freePort();
  run = await new Promise((resolve) => {
    const hasXvfb = spawnSync('which', ['xvfb-run']).status === 0;
    const isLinux = process.platform === 'linux';
    const cmd = isLinux && hasXvfb ? 'xvfb-run' : 'npx';
    const args = isLinux && hasXvfb ? ['-a', 'npx', 'electron', '.', '--no-sandbox'] : ['electron', '.', ...(isLinux ? ['--no-sandbox'] : [])];
    const child = spawn(cmd, args, {
      cwd: repoRoot,
      env: electronEnv({
        RIG_SELFTEST: '1',
        RIG_PORT: String(port),
        RIG_APP_DIR: fx.app,
        RIG_USER_SAMPLES: fx.userSamples,
        RIG_USER_DATA: fx.userData,
        RIG_RECORDINGS_DIR: fx.recordings,
        RIG_SELFTEST_TIMEOUT_MS: '40000',
        RIG_GB_LIBRARY: L.lib,
        FFMPEG: L.ffmpeg,
        AFCONVERT: L.noBin,
        FAKE_FFMPEG_MS: '5',
        ELECTRON_ENABLE_LOGGING: '0',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const killer = setTimeout(() => child.kill('SIGKILL'), 180000);
    child.on('close', (code) => {
      clearTimeout(killer);
      const line = out.split('\n').find((l) => l.startsWith('RIG_SELFTEST '));
      resolve({ code, out, err, report: line ? JSON.parse(line.slice('RIG_SELFTEST '.length)) : null });
    });
  });
  if (!run.report || !run.report.importer) console.log('electron exit', run.code, 'stdout:\n', run.out.slice(-4000), '\nstderr (tail):\n', run.err.slice(-3000));
});
after(() => L.cleanup());

test('Electron: scan through the preload lists the synthetic instruments with keys, no paths', () => {
  assert.equal(run.code, 0, run.err.slice(-2000));
  assert.deepEqual(run.report.result, { ready: true, isElectron: true });
  const g = run.report.importer;
  assert.ok(g && !g.error, JSON.stringify(g));
  assert.equal(g.statusBefore.state, 'idle');
  assert.equal(g.scan.ok, true, JSON.stringify(g.scan));
  assert.deepEqual(g.scan.instruments.map((i) => [i.name, i.found, i.needed]), [['Test Grand Piano', 27, 27], ['Test Strings Ensemble', 0, 7]]);
  assert.ok(g.scan.instruments.every((i) => /^[0-9a-f]{16}$/.test(i.key) && !('exsPath' in i)));
  assert.equal(g.scan.out, fx.userSamples, 'the output folder is the My Samples folder (RIG_USER_SAMPLES)');
  assert.equal(g.scan.encoder.ffmpeg, true);
});

test('Electron: a path or a non-array is never accepted as a selection', () => {
  const g = run.report.importer;
  assert.deepEqual(g.badKeys, { error: 'unknown-instrument' });
  assert.deepEqual(g.badType, { error: 'bad-request' });
});

test('Electron: the import runs in the utility process, progress reaches the page, the rescan finds the new pack', () => {
  const g = run.report.importer;
  assert.deepEqual(g.start, { ok: true, total: 1 });
  assert.equal(g.final.state, 'done', JSON.stringify(g.final));
  assert.deepEqual(g.final.items.map((i) => [i.name, i.state, i.notes]), [['Test Grand Piano', 'done', 27]]);
  assert.equal(g.pushed[0], 'importing');
  assert.equal(g.pushed.at(-1), 'done');
  assert.ok(g.pushed.length >= 3, `${g.pushed.length} progress events`);
  assert.ok(g.written.includes('test-grand-piano'), g.written.join(', '));
  assert.ok(fs.existsSync(path.join(fx.userSamples, 'test-grand-piano', 'manifest.json')));
  assert.deepEqual(g.written.filter((f) => f.startsWith('.')), [], 'no work folder left');
  assert.ok(g.rescan.packs.some((p) => p.slug === 'test-grand-piano'), JSON.stringify(g.rescan));
  assert.ok(g.manifestIds.includes('test-grand-piano'), g.manifestIds.join(', '));
  assert.equal(run.report.consoleErrors, 0, JSON.stringify(run.report.console.filter((c) => c.level === 'error')));
});
