#!/usr/bin/env node
// Boot of the real UI (app/) against the NATIVE core: rig-devhost (null audio backend) serves app/ with main.js's
// engine import swapped to engine-bridge/boot-devhost.js, Chromium (headless) opens it, a scripted Perform session
// runs, and the report says how far the UI gets with the modules this build has. NOT wired into run-all.
//   node test/unit/engine-bridge/boot-devhost.mjs [--json] [--out report.json] [--seconds 10] [--headed]
//                                                [--bin path/to/rig-devhost] [--no-recorder-proposal]
// --no-recorder-proposal serves recorder.js unchanged; by default Playwright serves it with the proposed selection
// lines (NativeRecorder for a bridge engine; see the T09 report), so the Record button is exercised end to end.
// Nothing under app/ is edited.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startDevhost, REPO } from './devhost-proc.mjs';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const SECONDS = Number(opt('--seconds', 10));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const RECORDER_IMPORT_ANCHOR = "import { wavHeader } from './shared/wav.js';";
export const RECORDER_CTOR_ANCHOR = '  constructor(o = {}) {\n    super();\n    this.engine = o.engine;';
/** The proposed recorder.js change (2 lines), applied to a served copy. */
export function proposeRecorder(src) {
  if (!src.includes(RECORDER_IMPORT_ANCHOR) || !src.includes(RECORDER_CTOR_ANCHOR)) return null;
  return src
    .replace(RECORDER_IMPORT_ANCHOR, `${RECORDER_IMPORT_ANCHOR}\n`
      + "import { NativeRecorder, isBridgeEngine } from './engine-bridge/native-recorder.js';")
    .replace(RECORDER_CTOR_ANCHOR, '  constructor(o = {}) {\n'
      + '    if (isBridgeEngine(o.engine)) return new NativeRecorder(o); // native engine records natively (G10)\n'
      + '    super();\n    this.engine = o.engine;');
}

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

/** Wire summary from the rig-devhost log: requests per op, error replies by op and code, events by kind. */
function wireSummary(logFile) {
  const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : [];
  const sent = {};
  const ops = new Map();
  const errors = {};
  const events = {};
  const warns = new Set();
  const flat = (m) => (Array.isArray(m) ? m.flatMap(flat) : [m]);
  for (const l of lines) {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    for (const m of flat(e.msg)) {
      if (e.dir === 'in') {
        const k = `${m.op}${m.action ? `:${m.action}` : m.what ? `:${m.what}` : m.e ? `:${m.e}` : ''}`;
        sent[k] = (sent[k] || 0) + 1;
        if (m.id !== undefined) ops.set(m.id, k);
      } else if (m.re !== undefined) {
        if (!m.ok) {
          const k = `${ops.get(m.re) || '?'} -> ${m.error && m.error.code}: ${m.error && m.error.message}`;
          errors[k] = (errors[k] || 0) + 1;
        }
      } else if (m.ev) {
        events[m.ev] = (events[m.ev] || 0) + 1;
        if (m.ev === 'warn') warns.add(String(m.message).slice(0, 160));
      }
    }
  }
  return { messages: lines.length, sent, errorReplies: errors, events, warnings: [...warns] };
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-boot-devhost-'));
  const logFile = path.join(work, 'bridge.jsonl');
  const host = await startDevhost({ bin: opt('--bin'), extra: ['--log', logFile, '--recordings', work] });
  const api = JSON.parse(fs.readFileSync(path.join(REPO, 'native/contract/engine-api.json'), 'utf8'));
  const contract = contractNames(api);
  const { chromium } = require(path.join(REPO, 'node_modules/playwright'));
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
  let recorderProposal = !flag('--no-recorder-proposal');
  if (recorderProposal) {
    const src = fs.readFileSync(path.join(REPO, 'app/js/recorder.js'), 'utf8');
    const patched = proposeRecorder(src);
    if (!patched) recorderProposal = 'anchor-missing';
    else {
      await page.route('**/js/recorder.js', (route) => route.fulfill({
        status: 200, contentType: 'text/javascript; charset=utf-8', body: patched,
      }));
    }
  }
  const t0 = Date.now();
  await page.goto(`${host.base}/?spy=1`, { waitUntil: 'load' });
  const booted = await page.evaluate(async () => {
    const deadline = Date.now() + 20000;
    while (!globalThis.__rig && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (!globalThis.__rig) return false;
    try {
      await Promise.race([globalThis.__rig.ready, new Promise((r) => setTimeout(r, 15000))]);
    } catch {
      /* reported below */
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
    const raw = globalThis.__bridgeRaw;
    return {
      audioText: txt('#audio-text'), latency: txt('#audio-latency'), readyText: txt('#ready-text'),
      audioBannerVisible: vis('#audio-banner'), startOverlayVisible: vis('#overlay-start'),
      toasts: [...document.querySelectorAll('#toasts > *')].map((e) => e.textContent.trim().slice(0, 140)),
      status: r ? (({ audio, latencyMs, ready }) => ({ audio, latencyMs, ready }))(r.controller.status) : null,
      ctxState: raw ? raw.ctx.state : null,
      ctxTime: raw ? Number(raw.ctx.currentTime.toFixed(3)) : null,
      shimStarted: raw ? raw._started : null,
      instruments: raw ? raw.listInstruments().length : null,
      peak: raw ? Math.max(raw._peaks[0].last, raw._peaks[1].last) : null,
      ticks: raw ? raw._clock.ticks : null,
      transport: globalThis.__devhostTransport ? { state: globalThis.__devhostTransport.state,
        ...globalThis.__devhostTransport.stats } : null,
    };
  });
  await sleep(1500);
  const bootUi = await ui();
  const bootMs = Date.now() - t0;
  const steps = [];
  const step = async (name, fn) => {
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ...(detail !== undefined ? { detail } : {}) });
    } catch (e) {
      steps.push({ name, ok: false, error: String(e && e.message).slice(0, 240) });
    }
  };
  const seg = (SECONDS * 1000) / 10;
  await page.mouse.click(700, 450);
  await step('start overlay / gesture', async () => page.evaluate(async () => {
    const b = document.querySelector('#overlay-start button, #btn-start-audio');
    if (b && b.getClientRects().length) b.click();
    await new Promise((r) => setTimeout(r, 300));
    return document.querySelector('#overlay-start') ? !document.querySelector('#overlay-start').hidden : null;
  }));
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await step('chord on computer keys (peak on the meters)', async () => {
    for (const k of ['KeyA', 'KeyD', 'KeyG']) await page.keyboard.down(k);
    await sleep(seg);
    const peak = await page.evaluate(() => {
      const e = globalThis.__bridgeRaw;
      const b = new Float32Array(2048);
      e.analyserL.getFloatTimeDomainData(b);
      return b[0];
    });
    for (const k of ['KeyA', 'KeyD', 'KeyG']) await page.keyboard.up(k);
    return { peak };
  });
  await step('sustain + wheels + swell', async () => {
    await page.keyboard.down('Space');
    await page.keyboard.press('KeyS');
    await page.keyboard.up('Space');
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
  await step('store edits drive set / song / drone / config', async () => {
    await page.evaluate(() => {
      const { store, controller } = globalThis.__rig;
      store.set('song.tempo', 92);
      store.set('slots.0.gain', 0.55);
      store.set('slots.0.pan', -0.2);
      store.set('fx.reverb.size', 0.7);
      store.set('fx.delay.feedback', 0.4);
      store.set('master.volume', 0.6);
      store.set('song.drone.mode', 'synth');
      controller.transposeUp();
      controller.perform.bend(0.4);
      controller.perform.noteOn(64, 90);
    });
    await sleep(seg);
    await page.evaluate(() => {
      globalThis.__rig.controller.perform.noteOff(64);
      globalThis.__rig.controller.perform.bend(0);
    });
  });
  await step('click on/off', async () => {
    await page.evaluate(() => globalThis.__rig.controller.toggleClick());
    await sleep(seg / 2);
    await page.evaluate(() => globalThis.__rig.controller.toggleClick());
  });
  await step('record a take with the Record path (controller.record)', async () => page.evaluate(async () => {
    const { controller } = globalThis.__rig;
    const a = await controller.record();
    await new Promise((r) => setTimeout(r, 1200));
    const b = await controller.record();
    return { start: a, stop: b && { path: b.path, durationSec: b.durationSec, sink: b.sink, error: b.error } };
  }));
  await step('Edit view and back', async () => {
    await page.evaluate(() => globalThis.__rig.ctx.setView('edit'));
    await sleep(seg / 2);
    await page.evaluate(() => globalThis.__rig.ctx.setView('perform'));
  });
  await step('Settings open / close', async () => {
    await page.click('#btn-settings');
    await sleep(seg / 2);
    await page.keyboard.press('Escape');
  });
  await step('panic, fade out, restart audio', async () => {
    await page.evaluate(() => {
      globalThis.__rig.controller.panic();
      globalThis.__rig.controller.fadeOutAll(1);
    });
    await sleep(seg / 2);
    await page.evaluate(() => globalThis.__rig.controller.restartAudio());
    await sleep(seg);
  });
  const endUi = await ui();
  const seen = await page.evaluate(() => ({ ...(globalThis.__bridgeSeen || {}) }));
  const link = await page.evaluate(() => (globalThis.__bridgeRaw ? { ...globalThis.__bridgeRaw._link.stats } : null));
  await browser.close();
  await host.stop();
  const summaryLine = (host.stderr().match(/rig-devhost: audio: .*/) || [''])[0];
  const missingOnShim = Object.keys(seen).filter((k) => k.startsWith('undefined:')).map((k) => k.slice(10))
    .filter((n) => !['slotAnalysers', 'auditionNote'].includes(n));
  const touched = Object.keys(seen).filter((k) => !k.startsWith('has:') && !k.startsWith('undefined:'));
  const notInContract = touched.filter((n) => !n.startsWith('_') && !n.startsWith('ctx.') && n !== 'drone'
    && !contract.has(n) && !['constructor', 'removeEventListener', 'dispatchEvent', 'toJSON'].includes(n));
  const wavs = fs.readdirSync(work).filter((f) => f.endsWith('.wav'))
    .map((f) => ({ name: f, bytes: fs.statSync(path.join(work, f)).size }));
  const report = {
    boot: { ok: booted, ms: bootMs, ui: bootUi },
    session: { seconds: SECONDS, steps, ui: endUi, recorderProposal },
    engineMembers: { touched: touched.length, missingOnShim, notInContract },
    wire: { link, ...wireSummary(logFile) },
    recordings: wavs,
    devhost: summaryLine.replace(/^rig-devhost: /, ''),
    sanitizer: host.stderr().match(/(ERROR: AddressSanitizer|runtime error|WARNING: ThreadSanitizer).*/g) || [],
    page: problems,
  };
  fs.rmSync(work, { recursive: true, force: true });
  if (opt('--out')) fs.writeFileSync(opt('--out'), `${JSON.stringify(report, null, 2)}\n`);
  if (flag('--json')) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  process.exitCode = report.page.pageErrors.length || !report.boot.ok ? 1 : 0;
}

function printReport(r) {
  const L = (s = '') => console.log(s);
  L(`BOOT  ok=${r.boot.ok}  ${r.boot.ms} ms`);
  L(`  UI after boot: ${JSON.stringify(r.boot.ui)}`);
  L(`SESSION (${r.session.seconds} s, recorder proposal: ${r.session.recorderProposal})`);
  for (const s of r.session.steps) {
    L(`  ${s.ok ? 'ok ' : 'FAIL'} ${s.name}${s.error ? `  ${s.error}` : ''}${s.detail ? `  ${JSON.stringify(s.detail)}`
      : ''}`);
  }
  L(`  UI at end: ${JSON.stringify(r.session.ui)}`);
  L(`ENGINE MEMBERS touched ${r.engineMembers.touched}; missing on shim: ${r.engineMembers.missingOnShim.join(', ')
    || '(none)'}; not in contract: ${r.engineMembers.notInContract.join(', ') || '(none)'}`);
  L(`WIRE  ${r.wire.messages} logged payloads; link ${JSON.stringify(r.wire.link)}`);
  L(`  sent: ${JSON.stringify(r.wire.sent)}`);
  L(`  events: ${JSON.stringify(r.wire.events)}`);
  L('  error replies (what the core does not do yet):');
  for (const [k, n] of Object.entries(r.wire.errorReplies)) L(`    ${n} x ${k}`);
  L(`  warn events: ${r.wire.warnings.length}`);
  for (const w of r.wire.warnings.slice(0, 20)) L(`    ${w}`);
  L(`RECORDINGS ${JSON.stringify(r.recordings)}`);
  L(`DEVHOST ${r.devhost}`);
  L(`SANITIZER ${r.sanitizer.length ? r.sanitizer.join('\n  ') : '(none)'}`);
  L('PAGE');
  for (const [k, v] of Object.entries(r.page)) {
    L(`  ${k}: ${v.length}${v.length ? `\n    ${v.slice(0, 15).join('\n    ')}` : ''}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
