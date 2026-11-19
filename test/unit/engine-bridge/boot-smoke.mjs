#!/usr/bin/env node
// Boot smoke: the real UI (app/) against BridgeEngine + MockNative in Chromium. NOT wired into run-all.
//   node test/unit/engine-bridge/boot-smoke.mjs [--json] [--out report.json] [--seconds 10] [--headed]
// How: a tiny static server serves app/ untouched, plus /__bridge/engine-api.json. The page is opened with
// ?engine=bridge-mock and Playwright serves a COPY of js/main.js whose only difference is the engine import
// (./engine/index.js -> ./engine-bridge/select.js); nothing under app/ is edited. boot-mock.js wraps the engine in a
// spy, so the report lists every engine member the UI touched during boot and a scripted Perform session, any member
// the shim lacks (a contract gap), and what the mock saw on the wire (validation findings included).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const appDir = path.join(root, 'app');
const apiPath = path.join(root, 'native/contract/engine-api.json');
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const SECONDS = Number(opt('--seconds', 10));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8',
};

function serve() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (u.pathname === '/__bridge/engine-api.json') return send(200, fs.readFileSync(apiPath));
    if (u.pathname === '/api/health') {
      return send(200, JSON.stringify({ ok: true, app: 'worship-rig', version: 'smoke', userSamples: false }));
    }
    if (u.pathname.startsWith('/api/user-samples')) return send(200, JSON.stringify({ instruments: [] }));
    if (u.pathname === '/api/heartbeat' || u.pathname === '/favicon.ico') return send(204, '');
    let p = path.normalize(decodeURIComponent(u.pathname));
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(appDir, p);
    if (!file.startsWith(appDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(404, 'not found', 'text/plain');
    }
    return send(200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

/** Contract member names, expanded the way surface.test.mjs does. */
function contractNames(api) {
  const names = new Set();
  for (const m of api.methods) {
    if (m.kind === 'ctor') continue;
    const parts = m.name.split(' / ').map((s) => s.trim());
    const prefix = parts[0].includes('.') ? `${parts[0].split('.')[0]}.` : '';
    parts.forEach((p, i) => names.add(i > 0 && !p.includes('.') ? prefix + p : p));
  }
  return names;
}

/** Playwright's own Chromium; else a preinstalled build (this box has a newer one than the lockfile's). */
async function launch(chromium) {
  const headless = !flag('--headed');
  try {
    return await chromium.launch({ headless });
  } catch (e) {
    const roots = [process.env.BRIDGE_CHROMIUM, process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers',
      path.join(os.homedir(), '.cache/ms-playwright')].filter(Boolean);
    for (const r of roots) {
      if (!fs.existsSync(r)) continue;
      if (fs.statSync(r).isFile()) return chromium.launch({ headless, executablePath: r });
      for (const d of fs.readdirSync(r).sort().reverse()) {
        for (const sub of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/headless_shell',
          'chrome-linux64/chrome', 'chrome-linux/chrome']) {
          const exe = path.join(r, d, sub);
          if (fs.existsSync(exe)) return chromium.launch({ headless, executablePath: exe });
        }
      }
    }
    throw e;
  }
}

/** Entries of a __bridgeSeen snapshot without the `has:` probes. */
const members = (seen, entries = false) => {
  const e = Object.entries(seen).filter(([k]) => !k.startsWith('has:'));
  return entries ? e : e.map(([k]) => k);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const api = JSON.parse(fs.readFileSync(apiPath, 'utf8'));
  const contract = contractNames(api);
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const { chromium } = require(path.join(root, 'node_modules/playwright'));
  const browser = await launch(chromium);
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const problems = { console: [], pageErrors: [], failedRequests: [], http: [] };
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.console.push(`${m.type()}: ${m.text()}`.slice(0, 300));
  });
  page.on('pageerror', (e) => problems.pageErrors.push(String(e && e.stack ? e.stack : e).slice(0, 400)));
  page.on('requestfailed', (r) => problems.failedRequests.push(`${r.url()} ${r.failure() && r.failure().errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.http.push(`${r.status()} ${r.url()}`);
  });
  // the COPY of the boot path: identical main.js except where the engine comes from
  await page.route('**/js/main.js', async (route) => {
    const src = fs.readFileSync(path.join(appDir, 'js/main.js'), 'utf8');
    const needle = "import { AudioEngine } from './engine/index.js';";
    if (!src.includes(needle)) throw new Error('main.js engine import line changed; update boot-smoke.mjs');
    await route.fulfill({
      status: 200, contentType: MIME['.js'],
      body: src.replace(needle, "import { AudioEngine } from './engine-bridge/select.js';"),
    });
  });
  const t0 = Date.now();
  await page.goto(`${base}/?engine=bridge-mock`, { waitUntil: 'load' });
  const booted = await page.evaluate(async () => {
    const deadline = Date.now() + 20000;
    while (!globalThis.__rig && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (!globalThis.__rig) return false;
    try {
      await Promise.race([globalThis.__rig.ready, new Promise((r) => setTimeout(r, 15000))]);
    } catch {
      /* reported below through the UI snapshot */
    }
    return true;
  });
  const ui = () => page.evaluate(() => {
    const txt = (s) => (document.querySelector(s) ? document.querySelector(s).textContent.trim() : null);
    const vis = (s) => {
      const e = document.querySelector(s);
      return !!e && !e.hidden && e.getClientRects().length > 0;
    };
    const r = globalThis.__rig;
    return {
      audioText: txt('#audio-text'), latency: txt('#audio-latency'), readyText: txt('#ready-text'),
      midi: txt('#midi-name'), audioBannerVisible: vis('#audio-banner'), startOverlayVisible: vis('#overlay-start'),
      toasts: [...document.querySelectorAll('#toasts > *')].map((e) => e.textContent.trim().slice(0, 120)),
      status: r ? (({ audio, latencyMs, ready }) => ({ audio, latencyMs, ready }))(r.controller.status) : null,
      ctxState: r ? r.engine.ctx.state : null,
    };
  });
  const seenNow = () => page.evaluate(() => ({ ...(globalThis.__bridgeSeen || {}) }));
  const wire = () => page.evaluate(() => (globalThis.__bridgeMock ? globalThis.__bridgeMock.summary() : null));
  await sleep(1500);
  const bootUi = await ui();
  const bootSeen = await seenNow();
  const bootWire = await wire();
  const bootMs = Date.now() - t0;

  // ---- scripted Perform session
  const steps = [];
  const step = async (name, fn) => {
    try {
      await fn();
      steps.push({ name, ok: true });
    } catch (e) {
      steps.push({ name, ok: false, error: String(e && e.message).slice(0, 200) });
    }
  };
  const seg = (SECONDS * 1000) / 10;
  await page.mouse.click(700, 450); // any gesture; harmless with a native engine
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await step('chord on computer keys', async () => {
    for (const k of ['KeyA', 'KeyD', 'KeyG']) await page.keyboard.down(k);
    await sleep(seg);
    for (const k of ['KeyA', 'KeyD', 'KeyG']) await page.keyboard.up(k);
  });
  await step('sustain pedal + notes', async () => {
    await page.keyboard.down('Space');
    await page.keyboard.down('KeyS');
    await sleep(seg / 2);
    await page.keyboard.up('KeyS');
    await page.keyboard.up('Space');
    await sleep(seg / 2);
  });
  await step('wheel nudges + swell', async () => {
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Shift+ArrowUp');
    await sleep(seg);
  });
  await step('next / previous song', async () => {
    await page.keyboard.press('ArrowRight');
    await sleep(seg);
    await page.keyboard.press('ArrowLeft');
    await sleep(seg);
  });
  await step('on-screen keys by pointer', async () => {
    const box = await page.evaluate(() => {
      const k = document.querySelector('[data-note]');
      if (!k) return null;
      const r = k.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height * 0.7 };
    });
    if (!box) throw new Error('no [data-note] element found');
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await sleep(seg / 2);
    await page.mouse.up();
  });
  await step('store edits drive setParam / song / drone / config', async () => {
    await page.evaluate(() => {
      const { store, controller } = globalThis.__rig;
      store.set('song.tempo', 92);
      store.set('slots.0.gain', 0.55);
      store.set('slots.0.pan', -0.2);
      store.set('slots.0.octave', 1);
      store.set('fx.reverb.size', 0.7);
      store.set('fx.delay.feedback', 0.4);
      store.set('master.volume', 0.6);
      store.set('slots.0.eq.b2.on', true);
      store.set('slots.0.eq.b2.type', 'peak');
      store.set('slots.0.eq.b2.hz', 800);
      store.set('slots.0.eq.b2.db', 4);
      store.set('song.drone.mode', 'synth');
      store.set('drone.gain', 0.3);
      controller.transposeUp();
      controller.perform.bend(0.4);
      controller.perform.expression(0.6);
      controller.perform.sustain(true);
      controller.perform.noteOn(64, 90);
    });
    await sleep(seg);
    await page.evaluate(() => {
      const { controller } = globalThis.__rig;
      controller.perform.noteOff(64);
      controller.perform.sustain(false);
      controller.perform.bend(0);
    });
  });
  await step('click on/off', async () => {
    await page.evaluate(() => { globalThis.__rig.controller.toggleClick(); });
    await sleep(seg / 2);
    await page.evaluate(() => { globalThis.__rig.controller.toggleClick(); });
  });
  await step('settings that reach the engine (mono, click, output, low-resource)', async () => {
    await page.evaluate(() => {
      const { store } = globalThis.__rig;
      store.set('settings.monoOutput', true);
      store.set('settings.outputDeviceId', 'mock-device');
      store.set('settings.click', { level: 0.4, record: true });
      store.set('settings.midiClockOut', 'Mock Out');
      store.set('settings.lowResource', true);
    });
    await sleep(seg);
    await page.evaluate(() => {
      const { store } = globalThis.__rig;
      store.set('settings.lowResource', false);
      store.set('settings.monoOutput', false);
    });
    await sleep(seg / 2);
  });
  await step('Edit view: open Advanced (EQ analyser, play range) and back', async () => {
    await page.evaluate(() => globalThis.__rig.ctx.setView('edit'));
    await sleep(seg / 2);
    await page.evaluate(async () => {
      let d = null;
      const tab = document.querySelector('#view-edit [role=tab][data-block]');
      if (tab) tab.click();
      for (let i = 0; i < 100 && !d; i++) {
        d = document.querySelector('#view-edit details[data-sec$="-adv"]');
        if (!d) await new Promise((r) => setTimeout(r, 50));
      }
      if (!d) {
        const ve = document.querySelector('#view-edit');
        throw new Error(`no Advanced section (view-edit hidden=${ve.hidden}, ${ve.querySelectorAll('*').length} nodes)`);
      }
      d.open = true;
      d.dispatchEvent(new Event('toggle'));
    });
    await sleep(seg);
    await page.evaluate(() => globalThis.__rig.ctx.setView('perform'));
  });
  await step('Settings open / close', async () => {
    await page.click('#btn-settings');
    await sleep(seg);
    await page.keyboard.press('Escape');
  });
  await step('panic and fade out', async () => {
    await page.evaluate(() => { globalThis.__rig.controller.panic(); globalThis.__rig.controller.fadeOutAll(1); });
    await sleep(seg / 2);
    await page.keyboard.press('KeyA');
  });
  await step('restart audio', async () => {
    await page.evaluate(() => globalThis.__rig.controller.restartAudio());
    await sleep(seg);
  });
  const endUi = await ui();
  const endSeen = await seenNow();
  const endWire = await wire();
  const rawStats = await page.evaluate(() => {
    const raw = globalThis.__bridgeRaw;
    return raw ? { ...raw._link.stats } : null;
  });
  await browser.close();
  srv.close();

  // ---- analysis
  // feature-detected by eq-keyboard.js and absent from the Web engine too (ENGINE_CONTRACT 1.7): not a gap
  const OPTIONAL_PROBES = new Set(['slotAnalysers', 'auditionNote']);
  const optionalProbes = new Set();
  const IGNORE = new Set(['constructor', 'removeEventListener', 'dispatchEvent', 'toJSON', 'inspect', 'nodeType']);
  const memberOf = (k) => (k.startsWith('has:') ? null : k.replace(/^undefined:/, ''));
  const touched = new Set();
  const notInContract = new Set();
  const missingOnShim = new Set();
  for (const k of Object.keys(endSeen)) {
    const name = memberOf(k);
    if (!name || IGNORE.has(name)) continue;
    if (OPTIONAL_PROBES.has(name)) {
      optionalProbes.add(name);
      continue;
    }
    if (k.startsWith('undefined:')) missingOnShim.add(name);
    if (name === 'drone' || name.startsWith('ctx.') || contract.has(name)) touched.add(name);
    else notInContract.add(name);
  }
  const ctxMembers = [...touched].filter((n) => n.startsWith('ctx.')).sort();
  const topTouched = [...touched].filter((n) => !n.startsWith('ctx.') && n !== 'drone').sort();
  const untouched = [...contract].filter((n) => !touched.has(n) && !(n === 'ctx' && ctxMembers.length)).sort();
  const report = {
    boot: { ok: booted, ms: bootMs, ui: bootUi, engineCallsDuringBoot: members(bootSeen).length },
    session: { seconds: SECONDS, steps, ui: endUi },
    engineMembers: {
      touchedByUi: topTouched, ctxMembersTouched: ctxMembers,
      optionalProbes: [...optionalProbes].sort(), notInContract: [...notInContract].sort(),
      missingOnShim: [...missingOnShim].sort(),
      contractMembersNeverTouched: untouched,
      counts: Object.fromEntries(members(endSeen, true).sort((a, b) => b[1] - a[1]).slice(0, 25)),
    },
    wire: {
      afterBoot: bootWire && bootWire.calls, afterSession: endWire && endWire.calls,
      findings: endWire ? endWire.findings : null, link: rawStats,
    },
    page: problems,
  };
  if (opt('--out')) fs.writeFileSync(opt('--out'), `${JSON.stringify(report, null, 2)}\n`);
  if (flag('--json')) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  const bad = report.page.pageErrors.length || !report.boot.ok || report.engineMembers.notInContract.length
    || report.engineMembers.missingOnShim.length
    || (report.wire.findings || []).some((f) => f.kind !== 'unknown-field');
  process.exitCode = bad ? 1 : 0;
}

function printReport(r) {
  const L = (s = '') => console.log(s);
  L(`BOOT  ok=${r.boot.ok}  ${r.boot.ms} ms  engine member reads: ${r.boot.engineCallsDuringBoot}`);
  L(`  UI after boot: ${JSON.stringify(r.boot.ui)}`);
  L(`SESSION (${r.session.seconds} s)`);
  for (const s of r.session.steps) L(`  ${s.ok ? 'ok ' : 'FAIL'} ${s.name}${s.error ? `  ${s.error}` : ''}`);
  L(`  UI at end: ${JSON.stringify(r.session.ui)}`);
  L('ENGINE MEMBERS touched by the UI');
  L(`  ${r.engineMembers.touchedByUi.join(', ')}`);
  L(`  ctx.*: ${r.engineMembers.ctxMembersTouched.join(', ')}`);
  L(`  optional probes (absent in the Web engine too): ${r.engineMembers.optionalProbes.join(', ') || '(none)'}`);
  L(`  NOT IN CONTRACT: ${r.engineMembers.notInContract.join(', ') || '(none)'}`);
  L(`  MISSING ON SHIM: ${r.engineMembers.missingOnShim.join(', ') || '(none)'}`);
  L(`  contract members never touched: ${r.engineMembers.contractMembersNeverTouched.join(', ')}`);
  L('WIRE (messages the mock received)');
  L(`  after boot: ${JSON.stringify(r.wire.afterBoot)}`);
  L(`  after session: ${JSON.stringify(r.wire.afterSession)}`);
  L(`  link: ${JSON.stringify(r.wire.link)}`);
  L(`  validation findings: ${JSON.stringify(r.wire.findings)}`);
  L('PAGE');
  for (const [k, v] of Object.entries(r.page)) {
    L(`  ${k}: ${v.length}${v.length ? `\n    ${v.slice(0, 12).join('\n    ')}` : ''}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
