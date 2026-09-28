#!/usr/bin/env node
// Electron end-to-end on the REAL app (app/ + main.js + preload.js + server.js), under xvfb:
//   node test/integration/electron-full.mjs [--keep]      (--keep leaves the temp dir for inspection)
//
// Run 1 — `xvfb-run -a npx electron . --no-sandbox` with RIG_SELFTEST=1 (main.js prints one "RIG_SELFTEST {json}" line
//   with the page's window.__RIG_SELFTEST__ + every console message, then quits). The app is served from a throw-away
//   dir (RIG_APP_DIR) whose entries are symlinks to the real app/; only index.html is copied with one extra module
//   script (./__it/probe.js) that drives the real bootstrap through window.__rig. Asserts: page loads from
//   http://127.0.0.1:<port>/, zero console.error, window.__rig exists, three songs selected through the controller
//   each produce sound on the engine analysers (no NaN), a 2 s recording lands in RIG_RECORDINGS_DIR as a valid WAV,
//   exit 0, port released.
// Run 2 — same command WITHOUT RIG_SELFTEST (the normal quit path): the probe plays, records 1 s, stops, then calls
//   window.close() → window-all-closed → app.quit() → will-quit (server + streams closed) → exit 0. Asserts the
//   process exits 0 by itself, the port is released, no Electron process is left behind, and the take is a valid WAV.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { buildAppWrapper, checker, freePort, portIsFree, hasXvfb, inspectWav, repoRoot, PAGE_METER_SRC, sleep } from './lib.mjs';

const KEEP = process.argv.includes('--keep');
const { check, skip, finish } = checker('electron-full');

// ------------------------------------------------------------------------------------------------ probes (page side)
const PROBE_COMMON = `
${PAGE_METER_SRC}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function maxLevel(engine, ms) {
  let m = -Infinity, nan = false;
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { const r = __itMeter(engine); m = Math.max(m, r.db); nan = nan || r.nan; await sleep(20); }
  return { db: +m.toFixed(1), nan };
}
// Electron's console-message event only carries console API calls, not Chromium's own "Failed to load resource"
// network errors that a browser DevTools console shows as errors — so failed loads are read from resource timing.
try { performance.setResourceTimingBufferSize(100000); } catch {}
const failedLoads = () => performance.getEntriesByType('resource').filter((e) => e.responseStatus >= 400).map((e) => \`\${e.responseStatus} \${e.name}\`);
async function boot() {
  for (let i = 0; i < 400 && !window.__rig; i++) await sleep(50);
  if (!window.__rig) throw new Error('window.__rig never appeared');
  await window.__rig.ready;
  await window.__rig.viewsReady;
  const { engine, controller } = window.__rig;
  if (!engine.ctx || engine.ctx.state !== 'running') await controller.resumeAudio();
  return window.__rig;
}
async function waitSong(controller, id) {
  for (let i = 0; i < 400; i++) { const s = controller.status; if (!s.loading && s.songId === id) return true; await sleep(50); }
  return false;
}
const strip = (o) => (o && typeof o === 'object' ? JSON.parse(JSON.stringify(o, (k, v) => (v instanceof Blob ? '[blob]' : v))) : o);
`;

const PROBE_FULL = `${PROBE_COMMON}
(async () => {
  const out = { mode: 'full', origin: location.origin, href: location.href, songs: [] };
  try {
    const rigHandle = await boot();
    out.hasRig = true;
    out.rigKeys = Object.keys(rigHandle);
    const { store, engine, controller } = rigHandle;
    out.isElectron = !!(window.rig && window.rig.isElectron);
    out.info = await window.rig.getInfo();
    const ct0 = engine.ctx.currentTime;
    await sleep(400);
    out.audio = { state: engine.ctx.state, advanced: engine.ctx.currentTime > ct0, sampleRate: engine.ctx.sampleRate, latencyMs: engine.latencyMs };
    out.overlayHidden = document.getElementById('overlay-start').hidden;
    const order = store.get().songOrder;
    // a sampler song, a pad + synth-drone song and a lofi song (factory ids are stable; song ids are per library)
    const want = ['factory:grand-piano', 'factory:sunday-pad-piano', 'factory:lofi-rhodes', 'factory:organ-swell'];
    const byFactory = (fid) => order.find((id) => store.getSong(id)?.factoryId === fid);
    const picks = want.map(byFactory).filter(Boolean).slice(0, 3);
    for (const id of order) if (picks.length < 3 && !picks.includes(id)) picks.push(id);
    for (const id of picks) {
      const committed = await controller.selectSong(id);
      const loaded = await waitSong(controller, id);
      await sleep(200);
      const before = __itMeter(engine).db;
      for (const n of [48, 60, 64, 67]) controller.perform.noteOn(n, 100);
      const lvl = await maxLevel(engine, 900);
      for (const n of [48, 60, 64, 67]) controller.perform.noteOff(n);
      await sleep(300);
      out.songs.push({ id: store.getSong(id)?.factoryId || id, name: store.getSong(id)?.name, committed, loaded, beforeDb: +before.toFixed(1), maxDb: lvl.db, nan: lvl.nan, slots: engine.slots.filter(Boolean).length });
    }
    // 2 s recording through the controller (REC button path) → Electron stream sink → RIG_RECORDINGS_DIR
    out.recStart = strip(await controller.record());
    const t0 = performance.now();
    for (const n of [55, 59, 62]) controller.perform.noteOn(n, 110);
    await sleep(2000);
    for (const n of [55, 59, 62]) controller.perform.noteOff(n);
    out.recStop = strip(await controller.record());
    out.recWallSec = (performance.now() - t0) / 1000;
    // pad releases + the retiring previous song take a few seconds; the drone (if the song has one) keeps sounding
    const kbVoices = () => engine._debugStats().voices - (engine.drone && engine.drone.liveVoiceCount ? engine.drone.liveVoiceCount() : 0);
    const tRel = performance.now();
    while (kbVoices() > 0 && performance.now() - tRel < 15000) await sleep(100);
    out.releaseSec = +((performance.now() - tRel) / 1000).toFixed(2);
    out.stats = engine._debugStats();
    out.keyboardVoices = kbVoices();
    out.failedLoads = failedLoads();
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }
  window.__RIG_SELFTEST__ = out;
})();
`;

const PROBE_QUIT = `${PROBE_COMMON}
(async () => {
  try {
    const { engine, controller } = await boot();
    for (const n of [60, 64, 67]) controller.perform.noteOn(n, 100);
    const r = await controller.record();
    console.log('[it-quit] record start', JSON.stringify(strip(r)));
    await sleep(1000);
    for (const n of [60, 64, 67]) controller.perform.noteOff(n);
    const s = await controller.record();
    console.log('[it-quit] record stop', JSON.stringify(strip(s)));
    await sleep(300);
  } catch (e) {
    console.warn('[it-quit] probe failed', e);
  }
  window.close(); // normal quit path: window-all-closed → app.quit()
})();
`;

// ------------------------------------------------------------------------------------------------ launcher
function electronCmd() {
  const xvfb = hasXvfb();
  if (process.platform === 'linux' && !xvfb && !process.env.DISPLAY) return null;
  return xvfb ? ['xvfb-run', ['-a', 'npx', 'electron', '.', '--no-sandbox']] : ['npx', ['electron', '.', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])]];
}

function launch(env, timeoutMs) {
  const [cmd, args] = electronCmd();
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd: repoRoot, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      const line = out.split('\n').find((l) => l.startsWith('RIG_SELFTEST '));
      let report = null;
      try {
        report = line ? JSON.parse(line.slice('RIG_SELFTEST '.length)) : null;
      } catch (e) {
        report = { parseError: String(e) };
      }
      resolve({ code, signal, timedOut, ms: Date.now() - t0, out, err, report });
    });
  });
}

/** Electron processes whose command line mentions `marker` (our temp dir) — should be none after exit. */
function leftovers(marker) {
  const r = spawnSync('pgrep', ['-af', 'electron'], { encoding: 'utf8' });
  if (r.status !== 0 && !r.stdout) return [];
  return r.stdout.split('\n').filter((l) => l.includes(marker) || false);
}

function dumpOnFailure(run) {
  console.log('--- electron stdout (tail) ---\n' + run.out.slice(-3000));
  console.log('--- electron stderr (tail) ---\n' + run.err.slice(-3000));
}

// ------------------------------------------------------------------------------------------------ main
if (!electronCmd()) {
  skip('electron-full', 'no xvfb-run and no DISPLAY');
  process.exit(finish());
}

const port = (await portIsFree(8438)) ? 8438 : await freePort();
console.log(`# electron-full: port ${port}${port === 8438 ? '' : ' (8438 busy)'}`);

// ---------------- run 1: RIG_SELFTEST
const w1 = buildAppWrapper(PROBE_FULL, { prefix: 'rig-it-electron-' });
try {
  const run = await launch(
    { RIG_SELFTEST: '1', RIG_SELFTEST_TIMEOUT_MS: '90000', RIG_APP_DIR: w1.app, RIG_USER_DATA: w1.userData, RIG_RECORDINGS_DIR: w1.recordings, RIG_PORT: String(port) },
    150000,
  );
  const rep = run.report;
  const res = rep && rep.result;
  console.log(`# run 1 finished in ${(run.ms / 1000).toFixed(1)} s, exit ${run.code}${run.signal ? ` (${run.signal})` : ''}`);
  if (!check('selftest report printed (RIG_SELFTEST line)', !!rep && !rep.parseError, rep ? rep.parseError || '' : 'no line')) dumpOnFailure(run);
  check('no selftest timeout / load error', rep && !rep.timeout && !rep.loadError, rep ? JSON.stringify({ timeout: rep.timeout, loadError: rep.loadError }) : '');
  check(`window loaded from http://127.0.0.1:${port}/`, rep && rep.url === `http://127.0.0.1:${port}/` && res && res.origin === `http://127.0.0.1:${port}`, rep && `${rep.url} / origin ${res && res.origin}`);
  if (res && res.error) console.log(`# probe error: ${res.error}`);
  check('probe ran without throwing', res && !res.error, res && res.error ? res.error.split('\n')[0] : '');
  check('window.__rig exists (store, engine, controller, midi, recorder)', res && res.hasRig && ['store', 'engine', 'controller', 'midi', 'recorder'].every((k) => res.rigKeys.includes(k)), res && (res.rigKeys || []).join(','));
  check('window.rig bridge says isElectron', res && res.isElectron === true);
  check('AudioContext running and advancing', res && res.audio && res.audio.state === 'running' && res.audio.advanced, res && JSON.stringify(res.audio));
  check('start overlay hidden (autoplay allowed in Electron)', res && res.overlayHidden === true);
  const songs = (res && res.songs) || [];
  check('three songs selected', songs.length === 3 && songs.every((s) => s.committed && s.loaded), songs.map((s) => `${s.id}:${s.committed}/${s.loaded}`).join(' '));
  for (const s of songs) check(`sound: ${s.id} chord > −50 dBFS on the analysers, no NaN`, s.maxDb > -50 && !s.nan, `max ${s.maxDb} dBFS (before ${s.beforeDb}), slots ${s.slots}`);
  // recording
  const start = res && res.recStart;
  const stop = res && res.recStop;
  check('recording started on the electron sink', start && start.ok === true && start.sink === 'electron', JSON.stringify(start));
  const recFiles = fs.existsSync(w1.recordings) ? fs.readdirSync(w1.recordings).filter((f) => f.endsWith('.wav')) : [];
  const recPath = stop && stop.path;
  check('recording stopped; file is inside the recordings folder', stop && !stop.error && recPath && path.resolve(recPath).startsWith(w1.recordings + path.sep) && fs.existsSync(recPath), `${recPath} (folder: ${recFiles.join(', ') || 'empty'})`);
  if (recPath && fs.existsSync(recPath)) {
    const wav = inspectWav(fs.readFileSync(recPath));
    check('recording is a valid 16-bit stereo PCM WAV (header sizes consistent)', wav.ok && wav.channels === 2 && wav.bits === 16, wav.problems.join('; ') || `${wav.channels} ch, ${wav.bits}-bit, ${wav.sampleRate} Hz`);
    check('recording length ≈ 2 s (±0.35 s)', Math.abs(wav.seconds - 2) <= 0.35, `${wav.seconds.toFixed(3)} s (probe wall clock ${res.recWallSec?.toFixed(2)} s)`);
    check('recording is not silent', wav.peak > 1000, `peak ${wav.peak}, RMS ${wav.rmsDb.toFixed(1)} dBFS`);
  }
  check('keyboard voices back to 0 after release (≤ 15 s)', res && res.keyboardVoices === 0, res && `after ${res.releaseSec} s: ${JSON.stringify(res.stats)}`);
  const errs = rep ? (rep.console || []).filter((c) => c.level === 'error') : [];
  check('zero console.error', rep && rep.consoleErrors === 0 && errs.length === 0, errs.map((e) => e.message).join(' | ') || `${rep?.consoleWarnings ?? '?'} warnings`);
  const fl = (res && res.failedLoads) || [];
  check('no failed resource loads (HTTP ≥ 400; Chrome would log each as a console error)', res && Array.isArray(res.failedLoads) && fl.length === 0, fl.length ? `${fl.length}: ${fl.slice(0, 8).join(', ')}` : '');
  if (rep && rep.consoleWarnings) for (const c of rep.console.filter((c) => c.level === 'warning')) console.log(`# console.warn: ${c.message.slice(0, 200)}`);
  check('exit code 0, not killed', run.code === 0 && !run.timedOut, `code ${run.code}, signal ${run.signal}, timedOut ${run.timedOut}`);
  check('port released after exit', await portIsFree(port));
  check('no Electron process left behind', leftovers(w1.tmp).length === 0, leftovers(w1.tmp).join(' | '));
} finally {
  if (!KEEP) w1.cleanup();
  else console.log(`# kept ${w1.tmp}`);
}

// ---------------- run 2: normal quit path (no RIG_SELFTEST)
const w2 = buildAppWrapper(PROBE_QUIT, { prefix: 'rig-it-electron-quit-' });
try {
  const run = await launch({ RIG_SELFTEST: '', ELECTRON_ENABLE_LOGGING: '1', RIG_APP_DIR: w2.app, RIG_USER_DATA: w2.userData, RIG_RECORDINGS_DIR: w2.recordings, RIG_PORT: String(port) }, 90000);
  console.log(`# run 2 finished in ${(run.ms / 1000).toFixed(1)} s, exit ${run.code}${run.signal ? ` (${run.signal})` : ''}`);
  const ok = check('window.close() → app quits by itself with exit 0', run.code === 0 && !run.timedOut, `code ${run.code}, signal ${run.signal}, timedOut ${run.timedOut}`);
  if (!ok) dumpOnFailure(run);
  check('port released after quit', await portIsFree(port));
  check('no Electron process left behind', leftovers(w2.tmp).length === 0, leftovers(w2.tmp).join(' | '));
  const files = fs.existsSync(w2.recordings) ? fs.readdirSync(w2.recordings).filter((f) => f.endsWith('.wav')) : [];
  if (check('take written before quitting', files.length === 1, files.join(', ') || 'none')) {
    const wav = inspectWav(fs.readFileSync(path.join(w2.recordings, files[0])));
    check('take is a valid, finalized WAV (≈1 s)', wav.ok && Math.abs(wav.seconds - 1) <= 0.35 && wav.peak > 1000, wav.problems.join('; ') || `${wav.seconds.toFixed(3)} s, peak ${wav.peak}`);
  }
} finally {
  if (!KEEP) w2.cleanup();
  else console.log(`# kept ${w2.tmp}`);
}

process.exit(finish());
