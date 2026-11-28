#!/usr/bin/env node
// Browser remote suite (remote lane, D34 / D45; native/docs/lanes/REMOTE.md §2.5, §4).
//   node test/phase2/remote/run.mjs
// 1. Old browsers: app/remote/index.html's script parses as ES5 (acorn, ecmaVersion 5) and uses none of the newer
//    APIs listed below; its CSS uses no custom properties, flex or grid; it loads nothing from anywhere else.
// 2. Chromium (Playwright) against the real server: rig-remote-dev (native/core/tools/hostkit/remote_dev.cpp, the
//    rig_remote server on stdin/stdout). Built on demand with CMake into native/core/build/remote-dev when
//    RIG_REMOTE_DEV is not set; without CMake the browser part is skipped (reported, not failed).
// Screenshots → test/phase2/remote/screenshots/ (git-ignored).
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as acorn from 'acorn';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const PAGE = path.join(ROOT, 'app/remote/index.html');
const SHOTS = path.join(HERE, 'screenshots');
const VERBOSE = !!process.env.VERBOSE;
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const T = async (name, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 8).join('\n      ')}`);
  }
};

// ---- 1. old-browser checks (no browser needed)
const html = fs.readFileSync(PAGE, 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');

/** APIs missing from Safari on iOS 7 (or 9) that ES5 parsing can't catch. [pattern, why] */
const BANNED = [
  [/\bfetch\s*\(/, 'fetch (iOS 10.3+)'], [/\bPromise\b/, 'Promise (iOS 8+)'], [/\.classList\b/, 'classList (partial)'],
  [/\bObject\.(assign|entries|values)\b/, 'Object.assign/entries/values'], [/\bArray\.(from|of)\b/, 'Array.from/of'],
  [/\.(includes|startsWith|endsWith|padStart|padEnd|repeat|find|findIndex|fill)\s*\(/, 'ES2015+ method'],
  [/\bnew\s+(Map|Set|WeakMap|WeakSet|Proxy|URL|URLSearchParams|AbortController)\b/, 'ES2015+/new web API'],
  [/\bSymbol\b/, 'Symbol'], [/\bqueueMicrotask\b|\brequestIdleCallback\b/, 'newer scheduling API'],
  [/\.closest\s*\(|\.matches\s*\(|\.append\s*\(|\.prepend\s*\(|\.remove\s*\(\s*\)/, 'newer DOM method'],
  [/addEventListener\([^)]*,\s*\{/, 'addEventListener options object'], [/\bconsole\.(error|warn)\b/, 'console noise'],
  [/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write/, 'HTML injection sink (names come from the Mac)'],
  [/\beval\s*\(|new\s+Function\b/, 'eval'],
];

await T('ES5: one inline script, parses with acorn ecmaVersion 5', async () => {
  assert.equal(scripts.length, 1, 'exactly one <script>');
  assert.ok(!/\bsrc\s*=/.test(scripts[0][1]), 'inline, no src');
  const src = scripts[0][2];
  acorn.parse(src, { ecmaVersion: 5, sourceType: 'script' });
  // and the parse really is strict about it: the same text with one ES2015 line fails
  assert.throws(() => acorn.parse(`${src}\nconst x = () => 1;`, { ecmaVersion: 5 }));
});

await T('old browsers: no post-ES5 APIs, no HTML sinks, nothing loaded from elsewhere', async () => {
  const src = scripts[0][2].replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [re, why] of BANNED) assert.ok(!re.test(src), `script uses ${why}: ${re}`);
  assert.ok(!/<link\b/i.test(html), 'no <link>');
  assert.ok(!/<(img|iframe|object|embed|video|audio)\b/i.test(html), 'no external media');
  assert.ok(!/https?:\/\//i.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'no absolute URLs');
  assert.ok(!/@import|@font-face|url\(/i.test(styles), 'no CSS imports, fonts or url()');
  assert.ok(!/var\(--|--[a-z-]+\s*:/i.test(styles), 'no CSS custom properties (iOS 9.3+)');
  assert.ok(!/display:\s*(flex|grid|inline-flex)/i.test(styles), 'no flex/grid (iOS 7 needs prefixes)');
  assert.ok(/<meta charset="utf-8">/i.test(html));
  assert.ok(Buffer.byteLength(html) < 32 * 1024, `small (${Buffer.byteLength(html)} bytes)`);
});

// ---- 2. Chromium against the real server
function findDevHost() {
  if (process.env.RIG_REMOTE_DEV) return process.env.RIG_REMOTE_DEV;
  const core = path.join(ROOT, 'native/core');
  for (const d of fs.readdirSync(core).filter((n) => n.startsWith('build')).sort()) {
    for (const sub of ['', 'remote-dev', 'release', 'debug', 'dev-remote']) {
      const p = path.join(core, d, sub, 'rig-remote-dev');
      if (fs.existsSync(p)) return p;
    }
  }
  if (spawnSync('cmake', ['--version']).status !== 0) return null;
  const dir = path.join(core, 'build/remote-dev');
  console.log('  … building rig-remote-dev (cmake, once)');
  const cfg = spawnSync('cmake', ['-S', core, '-B', dir, '-DCMAKE_BUILD_TYPE=Release',
    ...(spawnSync('ninja', ['--version']).status === 0 ? ['-G', 'Ninja'] : [])], { stdio: VERBOSE ? 'inherit' : 'ignore' });
  if (cfg.status !== 0) return null;
  const b = spawnSync('cmake', ['--build', dir, '--target', 'rig-remote-dev', '-j', '2'], { stdio: VERBOSE ? 'inherit' : 'ignore' });
  const p = path.join(dir, 'rig-remote-dev');
  return b.status === 0 && fs.existsSync(p) ? p : null;
}

/** rig-remote-dev as the Mac: lines in (state/code/forget/info), commands out. */
async function startHost(extra = []) {
  const bin = findDevHost();
  if (!bin) return null;
  const child = spawn(bin, ['--page', PAGE, '--any-port', ...extra], { stdio: ['pipe', 'pipe', 'inherit'] });
  const cmds = [];
  let lastInfo = null;
  const waiters = [];
  const rl = readline.createInterface({ input: child.stdout });
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  rl.on('line', (line) => {
    if (VERBOSE) console.log(`   [host] ${line}`);
    if (line.startsWith('ready ')) resolveReady(Number(line.slice(6)));
    else if (line.startsWith('cmd ')) cmds.push(JSON.parse(line.slice(4)));
    else if (line.startsWith('info ')) lastInfo = JSON.parse(line.slice(5));
    for (const w of waiters.splice(0)) w();
  });
  const port = await Promise.race([ready, sleep(5000).then(() => null)]);
  assert.ok(port, 'rig-remote-dev did not start');
  const host = {
    port, cmds, child,
    send: (line) => child.stdin.write(`${line}\n`),
    async info() {
      lastInfo = null;
      host.send('info');
      for (let i = 0; i < 100 && !lastInfo; i++) await sleep(20);
      return lastInfo;
    },
    state: (over = {}) => host.send(`state ${JSON.stringify({ ...baseState(), ...over })}`),
    async takeCmds(n, ms = 3000) {
      const t0 = Date.now();
      while (cmds.length < n && Date.now() - t0 < ms) await sleep(20);
      return cmds.splice(0);
    },
    stop() {
      try { child.stdin.write('stop\n'); } catch { /* gone */ }
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    },
  };
  return host;
}

function baseState() {
  return {
    v: 1, current: { id: 'a', name: 'Goodness of God', key: 'A' }, modes: [], master: 1, masterDb: 0, droneOn: false,
    droneKey: 'A', audio: 'running', latencyMs: 5, midi: { connected: false, name: null }, lowResource: false,
    recording: false, windowVisible: true, memoryMB: null, locked: false,
  };
}

let chromium = null;
try {
  ({ chromium } = await import('playwright'));
} catch {
  chromium = null;
}
const host = chromium ? await startHost() : null;
let browser = null;
if (!host) {
  console.log(`  - browser tests SKIPPED: ${chromium ? 'rig-remote-dev not built and no cmake' : 'no playwright'}`);
} else {
  browser = await chromium.launch({ headless: true });
}
const origin = host ? `http://127.0.0.1:${host.port}` : '';
const errors = [];
async function newPage({ noWebSocket = false, allow401 = false, viewport = { width: 375, height: 667 } } = {}) {
  const ctx = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  if (noWebSocket) await page.addInitScript(() => { window.WebSocket = undefined; });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (allow401 && /status of 40[13]/.test(m.text())) return;
    errors.push(`${m.text()} @ ${m.location()?.url || '?'}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return { ctx, page };
}
const textOf = (page, id) => page.$eval(`#${id}`, (el) => el.textContent);
const visible = (page, id) => page.$eval(`#${id}`, (el) => !/\bhidden\b/.test(el.className));
async function waitText(page, id, want, ms = 4000) {
  const t0 = Date.now();
  let got;
  while (Date.now() - t0 < ms) {
    got = await textOf(page, id);
    if (want instanceof RegExp ? want.test(got) : got === want) return got;
    await sleep(30);
  }
  throw new Error(`#${id}: wanted ${want}, got ${JSON.stringify(got)}`);
}

if (host) {
  await T('pair from the QR link: the code leaves the address bar; waiting, then the song from the Mac', async () => {
    const { ctx, page } = await newPage();
    const { code } = await host.info();
    await page.goto(`${origin}/#p=${code}`);
    await waitText(page, 'status', 'Waiting for the Mac…');
    assert.equal(new URL(page.url()).hash, '', 'the code is gone from the URL');
    assert.equal(await visible(page, 'main'), true);
    host.state();
    await waitText(page, 'song', 'Goodness of God');
    await waitText(page, 'status', 'Connected');
    assert.equal(await textOf(page, 'snap'), '—', 'no snapshots');
    assert.equal(await textOf(page, 'drone'), 'Drone: off');
    await page.screenshot({ path: path.join(SHOTS, 'remote.png') });
    const tok = await page.evaluate(() => localStorage.getItem('worship-rig.remote.token'));
    assert.match(tok, /^[0-9a-f]{32}$/);
    // a reload keeps the pairing
    await page.reload();
    await waitText(page, 'song', 'Goodness of God');
    await ctx.close();
  });

  await T('every button sends its bus command (tap = touch), with via remote', async () => {
    const { ctx, page } = await newPage();
    const { code } = await host.info();
    await page.goto(`${origin}/#p=${code}`);
    host.state({ scene: { n: 0, count: 3, name: 'Verse' } });
    await waitText(page, 'snap', 'Verse');
    host.cmds.splice(0);
    for (const id of ['prevSong', 'nextSong', 'prevSnap', 'nextSnap', 'drone', 'panic']) await page.tap(`#${id}`);
    const got = await host.takeCmds(6);
    assert.deepEqual(got, [
      { v: 1, type: 'prevSong', via: 'remote' }, { v: 1, type: 'nextSong', via: 'remote' },
      { v: 1, type: 'prevScene', via: 'remote' }, { v: 1, type: 'nextScene', via: 'remote' },
      { v: 1, type: 'droneToggle', on: true, via: 'remote' }, { v: 1, type: 'panic', via: 'remote' },
    ]);
    host.state({ droneOn: true, scene: { n: 1, count: 3 } });
    await waitText(page, 'drone', 'Drone: on');
    assert.equal(await textOf(page, 'snap'), 'Scene 2', 'an unnamed snapshot');
    await page.click('#drone'); // a mouse click works too (no double send from touch + click)
    assert.deepEqual(await host.takeCmds(1), [{ v: 1, type: 'droneToggle', on: false, via: 'remote' }]);
    await page.tap('#drone');
    await sleep(300);
    assert.equal(host.cmds.splice(0).length, 1, 'one tap, one command');
    host.state({ scene: { n: null, count: 3 } });
    await waitText(page, 'snap', 'Song levels');
    await page.screenshot({ path: path.join(SHOTS, 'remote-drone-on.png') });
    await ctx.close();
  });

  await T('Lock: every button but PANIC is disabled and refused; unlocked again works', async () => {
    const { ctx, page } = await newPage();
    const { code } = await host.info();
    await page.goto(`${origin}/#p=${code}`);
    host.state({ locked: true });
    await page.waitForFunction(() => document.getElementById('nextSong').disabled);
    assert.equal(await visible(page, 'locked'), true);
    for (const id of ['prevSong', 'nextSong', 'prevSnap', 'nextSnap', 'drone']) {
      assert.equal(await page.$eval(`#${id}`, (el) => el.disabled), true, id);
    }
    host.cmds.splice(0);
    await page.tap('#nextSong', { force: true });
    await page.tap('#panic');
    assert.deepEqual(await host.takeCmds(1), [{ v: 1, type: 'panic', via: 'remote' }]);
    await sleep(200);
    assert.equal(host.cmds.length, 0, 'nothing else');
    // even a crafted request is refused by the server while locked
    const tok = await page.evaluate(() => localStorage.getItem('worship-rig.remote.token'));
    const r = await page.evaluate(async (t) => {
      const x = await fetch('/api/cmd', { method: 'POST', headers: { 'X-Rig-Token': t, 'Content-Type': 'application/json' },
        body: '{"cmd":"nextSong","id":"z1"}' });
      return x.json();
    }, tok);
    assert.deepEqual(r, { id: 'z1', ok: false, error: 'locked' });
    await page.screenshot({ path: path.join(SHOTS, 'remote-locked.png') });
    host.state({ locked: false });
    await page.waitForFunction(() => !document.getElementById('nextSong').disabled);
    await page.tap('#nextSong');
    assert.deepEqual(await host.takeCmds(1), [{ v: 1, type: 'nextSong', via: 'remote' }]);
    await ctx.close();
  });

  await T('names from the Mac are text, never markup', async () => {
    const { ctx, page } = await newPage();
    const { code } = await host.info();
    await page.goto(`${origin}/#p=${code}`);
    const evil = '<img src=x onerror="window.__pwned=1">';
    host.state({ current: { id: 'a', name: evil, key: 'A' }, scene: { n: 0, count: 1, name: '<b>x</b>' } });
    await waitText(page, 'song', evil);
    assert.equal(await textOf(page, 'snap'), '<b>x</b>');
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    assert.equal(await page.$$eval('img, b', (els) => els.length), 0);
    await ctx.close();
  });

  await T('typing a wrong code, then the right one', async () => {
    const { ctx, page } = await newPage({ allow401: true }); // the wrong code's 403 is logged by Chromium
    await page.goto(origin);
    assert.equal(await visible(page, 'pair'), true);
    const { code } = await host.info();
    const wrong = code === '000000' ? '000001' : '000000';
    await page.fill('#code', '12');
    await page.tap('#pairBtn');
    await waitText(page, 'pairNote', 'The code is 6 digits.');
    await page.fill('#code', wrong);
    await page.tap('#pairBtn');
    await waitText(page, 'pairNote', /not right/);
    await page.screenshot({ path: path.join(SHOTS, 'remote-pair.png') });
    await page.fill('#code', code);
    await page.tap('#pairBtn');
    await page.waitForFunction(() => !/hidden/.test(document.getElementById('main').className));
    await ctx.close();
  });

  await T('no WebSocket: long polling still shows changes and sends commands', async () => {
    const { ctx, page } = await newPage({ noWebSocket: true });
    const { code } = await host.info();
    await page.goto(`${origin}/#p=${code}`);
    host.state({ current: { id: 'b', name: 'Way Maker', key: 'E' } });
    await waitText(page, 'song', 'Way Maker');
    await waitText(page, 'status', 'Connected (slow mode)');
    const t0 = Date.now();
    host.state({ current: { id: 'c', name: 'Holy Forever', key: 'C' } });
    await waitText(page, 'song', 'Holy Forever');
    assert.ok(Date.now() - t0 < 1500, 'a long poll answers as soon as the Mac changes');
    host.cmds.splice(0);
    await page.tap('#nextSong');
    assert.deepEqual(await host.takeCmds(1), [{ v: 1, type: 'nextSong', via: 'remote' }]);
    await ctx.close();
  });

  await T('Forget phones: a WebSocket page and a polling page both go back to pairing', async () => {
    const a = await newPage({ allow401: true });
    const b = await newPage({ noWebSocket: true, allow401: true });
    const { code } = await host.info();
    await a.page.goto(`${origin}/#p=${code}`);
    await b.page.goto(`${origin}/#p=${code}`);
    host.state();
    await waitText(a.page, 'song', 'Goodness of God');
    await waitText(b.page, 'song', 'Goodness of God');
    host.send('forget');
    await a.page.waitForFunction(() => !/hidden/.test(document.getElementById('pair').className), null, { timeout: 5000 });
    await b.page.waitForFunction(() => !/hidden/.test(document.getElementById('pair').className), null, { timeout: 15000 });
    assert.match(await textOf(a.page, 'pairNote'), /isn’t paired any more/);
    await a.ctx.close();
    await b.ctx.close();
  });

  await T('the page answers with a strict CSP and no-store; a second site gets nothing', async () => {
    const { ctx, page } = await newPage();
    const res = await page.goto(origin);
    const h = res.headers();
    assert.match(h['content-security-policy'], /default-src 'none'/);
    assert.match(h['content-security-policy'], new RegExp(`connect-src 'self' ws://127\\.0\\.0\\.1:${host.port}`));
    assert.equal(h['cache-control'], 'no-store');
    assert.equal(h['x-frame-options'], 'DENY');
    await ctx.close();
  });

  await T('zero console errors across the suite', async () => {
    assert.deepEqual(errors, []);
  });
}

if (browser) await browser.close();
if (host) host.stop();
const failed = results.filter((r) => !r.ok);
console.log(`\nremote: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
