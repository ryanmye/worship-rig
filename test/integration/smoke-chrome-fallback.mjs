#!/usr/bin/env node
// Chrome-fallback smoke (SPEC §1 serve.mjs, §7): the path a user takes without the Electron app.
//   node test/integration/smoke-chrome-fallback.mjs
// 1. `node serve.mjs --port <free>` (no --open) → prints the URL; /api/health answers {ok, app:'worship-rig', pid}.
// 2. Playwright Chromium WITHOUT the autoplay flag (autoplay needs a gesture, like a stock Chrome profile) loads it:
//    the "Click anywhere to start audio" overlay appears, a click starts audio, the computer key A plays a note that
//    reaches the engine analysers; the page's own fetch('/api/health') works; zero console.error.
// 3. A second `node serve.mjs --port <same>` detects the running server (reuse path), prints "already running",
//    exits 0 by itself and launches nothing (a fake google-chrome/chromium/xdg-open on PATH records any launch);
//    the first server keeps serving (same pid in /api/health).
// 4. (Linux, fake browser) `--open` on the reused port while the page heartbeats → no second window ("already
//    open"); `--open` on a reused server nobody has visited → exactly one app window in the dedicated profile.
// 5. SIGINT to the first server → "Stopping…", exit 0, port released.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { checker, freePort, httpGet, portIsFree, repoRoot, sleep, waitFor } from './lib.mjs';

const { check, skip, finish } = checker('chrome-fallback');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-it-serve-'));
const shimDir = path.join(tmp, 'bin');
const shimLog = path.join(tmp, 'launches.log');
fs.mkdirSync(shimDir);
for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'xdg-open', 'open']) {
  const f = path.join(shimDir, name);
  fs.writeFileSync(f, `#!/bin/sh\necho "${name} $*" >> "${shimLog}"\n`);
  fs.chmodSync(f, 0o755);
}
const env = { ...process.env, PATH: `${shimDir}${path.delimiter}${process.env.PATH}`, HOME: tmp };
const launches = () => (fs.existsSync(shimLog) ? fs.readFileSync(shimLog, 'utf8').split('\n').filter(Boolean) : []);

function serve(args) {
  const child = spawn(process.execPath, ['serve.mjs', ...args], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const p = { child, out: '', code: undefined, signal: undefined };
  child.stdout.on('data', (d) => (p.out += d));
  child.stderr.on('data', (d) => (p.out += d));
  p.exited = new Promise((r) =>
    child.on('exit', (code, signal) => {
      p.code = code;
      p.signal = signal;
      r(code);
    }),
  );
  return p;
}
const exitWithin = (p, ms) => Promise.race([p.exited.then(() => true), sleep(ms).then(() => false)]);

const port = await freePort();
const url = `http://127.0.0.1:${port}/`;
let first = null;
let browser = null;
try {
  // ---- 1. first server
  first = serve(['--port', String(port)]);
  const up = await waitFor(() => first.out.includes(`running at ${url}`) || first.code !== undefined, { timeout: 15000, what: 'serve.mjs to print its URL' }).catch(() => false);
  check('serve.mjs (no --open) starts and prints its URL', up && first.code === undefined, first.out.trim().split('\n')[0]);
  const h = await httpGet(port, '/api/health');
  const health = h && h.status === 200 ? JSON.parse(h.body.toString()) : null;
  check('/api/health → {ok:true, app:"worship-rig"} from this process', health && health.ok === true && health.app === 'worship-rig' && health.pid === first.child.pid, JSON.stringify(health));
  check('no browser launched without --open', launches().length === 0, launches().join(' | '));

  // ---- 2. Chromium
  // No --autoplay-policy flag: Chromium's default policy applies to the app's own AudioContext (it is created by page
  // script, not by page.evaluate, which Playwright runs with a user gesture), so the context starts 'suspended'.
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await context.grantPermissions(['midi'], { origin: url.replace(/\/$/, '') });
  } catch {
    /* not supported here */
  }
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`${m.text()} @ ${m.location()?.url || ''}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => !!window.__rig, null, { timeout: 30000 });
  const overlayShown = await page.waitForSelector('#overlay-start:not([hidden])', { state: 'visible', timeout: 8000 }).then(() => true, () => false);
  const stateBefore = await page.evaluate(() => window.__rig.engine.ctx && window.__rig.engine.ctx.state);
  check('start overlay shown while audio needs a gesture', overlayShown && stateBefore === 'suspended', `ctx ${stateBefore}`);
  if (overlayShown) await page.click('#overlay-start');
  const running = await page.waitForFunction(() => window.__rig.engine.ctx && window.__rig.engine.ctx.state === 'running' && document.getElementById('overlay-start').hidden, null, { timeout: 10000 }).then(() => true, () => false);
  check('click → AudioContext running, overlay hidden', running, JSON.stringify(await page.evaluate(() => ({ ctx: window.__rig.engine.ctx && window.__rig.engine.ctx.state, overlayHidden: document.getElementById('overlay-start').hidden }))));
  await page.evaluate(() => window.__rig.ready);
  const songReady = await page.waitForFunction(() => !window.__rig.controller.status.loading && window.__rig.engine.slots.some(Boolean), null, { timeout: 30000 }).then(() => true, () => false);
  check('current song loaded after the click', songReady, JSON.stringify(await page.evaluate(() => ({ status: window.__rig.controller.status, slots: window.__rig.engine.slots.map((s) => !!s) }))));
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  // inline meter (the app's CSP has no 'unsafe-eval', so nothing is eval'd in the page)
  const measure = (ms) =>
    page.evaluate(async (ms) => {
      let m = -Infinity;
      let nan = false;
      const e = window.__rig.engine;
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        for (const an of [e.analyserL, e.analyserR]) {
          const buf = new Float32Array(an.fftSize);
          an.getFloatTimeDomainData(buf);
          let s = 0;
          for (const v of buf) {
            if (!Number.isFinite(v)) nan = true;
            else s += v * v;
          }
          m = Math.max(m, 10 * Math.log10(s / buf.length + 1e-20));
        }
        await new Promise((res) => setTimeout(res, 20));
      }
      return { db: +m.toFixed(1), nan };
    }, ms);
  const quiet = await measure(200);
  await page.keyboard.down('a');
  const played = await measure(700);
  const held = await page.evaluate(() => window.__rig.controller._debug().held);
  await page.keyboard.up('a');
  check('computer key A plays a note: analysers > −50 dBFS, no NaN', played.db > -50 && !played.nan, `quiet ${quiet.db} → ${played.db} dBFS, held ${JSON.stringify(held)}`);
  const pageHealth = await page.evaluate(() => fetch('/api/health').then((r) => r.json()));
  check("page's own fetch('/api/health') works (same origin)", pageHealth.ok === true && pageHealth.app === 'worship-rig', JSON.stringify(pageHealth));

  // ---- 3. second serve on the same port: reuse, exit, open nothing
  const second = serve(['--port', String(port)]);
  const exited2 = await exitWithin(second, 10000);
  if (!exited2) second.child.kill('SIGKILL');
  check('second serve.mjs on the same port exits by itself with 0', exited2 && second.code === 0, `exited ${exited2}, code ${second.code}`);
  check('second serve.mjs reports reuse ("already running")', /already running/i.test(second.out) && second.out.includes(url), second.out.trim());
  check('second serve.mjs launched no browser', launches().length === 0, launches().join(' | '));
  const h2 = await httpGet(port, '/api/health');
  const health2 = h2 && h2.status === 200 ? JSON.parse(h2.body.toString()) : null;
  check('first server still serving (same pid)', health2 && health2.pid === first.child.pid, JSON.stringify(health2));

  // ---- 4. --open on a reused port (fake browser records launches)
  if (process.platform === 'linux') {
    // 4a. a window is alive (this page heartbeats) → no second window, just the "already open" hint
    const third = serve(['--port', String(port), '--open']);
    const exited3 = await exitWithin(third, 10000);
    if (!exited3) third.child.kill('SIGKILL');
    await sleep(300);
    check('--open while a window is alive (heartbeat) → exit 0, no second window, "already open" hint', exited3 && third.code === 0 && launches().length === 0 && /already open/i.test(third.out), launches().join(' | ') || third.out.trim().split('\n').pop());
    // 4b. a server nobody has visited yet (clientSeenMsAgo null) → --open launches exactly one app window
    const port2 = await freePort();
    const url2 = `http://127.0.0.1:${port2}/`;
    const other = serve(['--port', String(port2)]);
    await waitFor(() => other.out.includes(`running at ${url2}`), { timeout: 15000, what: 'second server' }).catch(() => null);
    const fourth = serve(['--port', String(port2), '--open']);
    const exited4 = await exitWithin(fourth, 10000);
    if (!exited4) fourth.child.kill('SIGKILL');
    await sleep(300); // the detached fake browser writes its line asynchronously
    const l = launches();
    check('--open on a reused server with no window → exactly one app window, same URL, dedicated profile', exited4 && fourth.code === 0 && l.length === 1 && l[0].includes(`--app=${url2}`) && l[0].includes('--user-data-dir='), l.join(' | ') || fourth.out.trim());
    other.child.kill('SIGINT');
    await exitWithin(other, 5000);
  } else skip('--open launch lines', `fake-browser check is Linux-only (platform ${process.platform})`);

  check('zero console.error in the page', consoleErrors.length === 0, consoleErrors.join(' | '));
  await browser.close();
  browser = null;

  // ---- 5. shutdown
  first.child.kill('SIGINT');
  const exited1 = await exitWithin(first, 10000);
  check('SIGINT → first server stops cleanly (exit 0)', exited1 && first.code === 0 && /Stopping/.test(first.out), `code ${first.code}, signal ${first.signal}`);
  check('port released', await portIsFree(port));
} catch (e) {
  check(`smoke crashed: ${(e && e.message) || e}`, false, e && e.stack);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (first && first.code === undefined) first.child.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(finish());
