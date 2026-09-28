// Playwright (full Chromium, new headless): server Range/MIME/pads traversal + recorder worklet → OPFS/mock-rig/memory.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import path from 'node:path';
import { buildFixture, repoRoot } from './fixture.mjs';
import { MIDI_PERMISSIONS, waitRigReady } from '../../integration/lib.mjs';

const require = createRequire(import.meta.url);
const { createServer } = require('../../../server.js');

const fx = buildFixture();
const port = Number(process.env.RIG_TEST_PORT) || 18437 + Math.floor(Math.random() * 1000);
let server;
let browser;
let context;
let page;
const consoleErrors = [];

before(async () => {
  server = createServer({ appDir: fx.app, port, padsRoot: fx.pads, userSamples: [fx.userSamples] });
  const info = await server.listen();
  assert.equal(info.reused, false);
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  context = await browser.newContext();
  await context.grantPermissions(['midi'], { origin: `http://127.0.0.1:${info.port}` });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${info.port}/pw.html`);
  await page.waitForFunction(() => window.__ready === true);
});

after(async () => {
  await browser?.close();
  await server?.close();
  fx.cleanup();
});

test('server via the browser: MIME, health, /api/pads, Range 206/416, traversal blocked', async () => {
  const p2 = await context.newPage(); // negative probes log "Failed to load resource" → keep them off the main page
  await p2.goto(page.url());
  await p2.waitForFunction(() => window.__ready === true);
  const r = await p2.evaluate(() => window.checks.httpChecks({ negative: true }));
  await p2.close();
  const pos = await page.evaluate(() => window.checks.httpChecks());
  assert.equal(pos.range.status, 206);
  assert.equal(r.jsType, 'text/javascript; charset=utf-8');
  assert.equal(r.workletType, 'text/javascript; charset=utf-8');
  assert.deepEqual([r.health.ok, r.health.app], [true, 'worship-rig']);
  assert.equal(r.pads.length, 1);
  assert.equal(r.pads[0].name, 'Pad - A.wav');
  assert.equal(r.range.status, 206);
  assert.match(r.range.contentRange, /^bytes 0-99\/\d+$/);
  assert.equal(r.range.length, 100);
  assert.equal(r.range.type, 'audio/wav');
  assert.equal(r.range416, 416);
  assert.deepEqual(r.traversal, [404, 404, 404]);
  assert.equal(r.dotdot, 404);
});

test('pad file streams through <audio> + MediaElementSource (same-origin → real signal)', async () => {
  const rms = await page.evaluate(async () => {
    const pads = await (await fetch('/api/pads')).json();
    return window.checks.mediaElementRms(pads[0].url);
  });
  assert.ok(rms > 0.05, `rms ${rms}`);
});

test('My Samples through the real engine code: registry health gate + normalizeManifest URLs decode in Chromium', async () => {
  const r = await page.evaluate(async () => {
    const { normalizeManifest } = await import('./js/engine/sampler.js');
    const { InstrumentRegistry } = await import('./js/engine/instruments.js');
    const reg = new InstrumentRegistry({ manifestUrls: ['./js/engine/gain-trims.json', './api/user-samples/manifest.json'], useModules: false });
    const allowed = await reg._optionalAllowed(new URL('./api/user-samples/manifest.json', location.href).href);
    const url = new URL('./api/user-samples/manifest.json', location.href).href;
    const json = await (await fetch(url, { cache: 'no-store' })).json();
    const defs = normalizeManifest(json, url, { idPrefix: 'user:', group: 'My Samples' });
    const sample = defs[0].layers[0].samples[0];
    const ab = await (await fetch(sample.url)).arrayBuffer();
    const ctx = new OfflineAudioContext(2, 44100, 44100);
    const buf = await ctx.decodeAudioData(ab);
    return { allowed, ids: defs.map((d) => d.id), group: defs[0].group, midi: sample.midi, url: sample.url, seconds: buf.duration };
  });
  assert.equal(r.allowed, true, '/api/health advertises userSamples, so the engine requests the manifest');
  assert.deepEqual(r.ids, ['user:test-keys']);
  assert.equal(r.group, 'My Samples');
  assert.equal(r.midi, 57);
  assert.match(r.url, /\/user-samples\/[^/]+\/Test%20Keys\/v%201\/A3\.wav$/);
  assert.ok(Math.abs(r.seconds - 1) < 0.01, `decoded ${r.seconds} s`);
});

test('recorder worklet → OPFS sink: 1 s real-time take is a valid, non-silent 16-bit stereo WAV', async () => {
  const r = await page.evaluate(() => window.checks.recordOnce({ sink: 'opfs', seconds: 1 }));
  assert.equal(r.started.ok, true, JSON.stringify(r.started));
  assert.equal(r.result.sink, 'opfs');
  assert.match(r.result.filename, /^Rig \d{4}-\d{2}-\d{2} \d{4}( \d+)?\.wav$/);
  const a = r.analysis;
  assert.equal(a.header.format, 1);
  assert.equal(a.header.channels, 2);
  assert.equal(a.header.bitsPerSample, 16);
  assert.equal(a.header.sampleRate, r.ctxRate);
  assert.equal(a.header.riffOk, true);
  assert.equal(a.header.dataBytes, a.frames * 4);
  assert.equal(a.fileBytes, 44 + a.header.dataBytes);
  assert.ok(Math.abs(a.seconds - 1) <= 0.2, `duration ${a.seconds}`);
  assert.ok(Math.abs(r.result.durationSec - a.seconds) < 1e-9);
  assert.ok(a.rmsDb > -12 && a.rmsDb < -6, `rms ${a.rmsDb} dBFS (0.5-amplitude sine ≈ −9 dBFS)`);
  assert.ok(a.peak > 0.45 && a.peak <= 0.51, `peak ${a.peak}`);
  assert.equal(a.nan, 0);
  assert.ok(r.levels >= 5 && r.maxLevel > 0.45, `level events ${r.levels}`);
  assert.deepEqual(r.states, ['starting', 'recording', 'stopping', 'idle']);
});

test('recorder → Electron sink against a mock window.rig: header re-patched during the take and at close', async () => {
  const r = await page.evaluate(async () => {
    const rig = window.checks.mockRig();
    return window.checks.recordOnce({ sink: 'electron', rig, seconds: 1.2, headerIntervalSec: 0.3 });
  });
  assert.equal(r.result.sink, 'electron');
  assert.equal(r.rigLog.opens, 1);
  assert.equal(r.rigLog.closes, 1);
  assert.ok(r.rigLog.patches >= 4, `patches ${r.rigLog.patches}`);
  assert.equal(r.analysis.header.dataBytes, r.analysis.frames * 4);
  assert.ok(Math.abs(r.analysis.seconds - 1.2) <= 0.2);
  assert.ok(r.analysis.rmsDb > -12);
});

test('recorder → memory sink (last-resort fallback) produces a valid WAV blob', async () => {
  const r = await page.evaluate(() => window.checks.recordOnce({ sink: 'memory', seconds: 0.5 }));
  assert.equal(r.result.sink, 'memory');
  assert.ok(Math.abs(r.analysis.seconds - 0.5) <= 0.2);
  assert.equal(r.analysis.header.channels, 2);
});

test('worklet loader retries via blob: URL when addModule(url) fails', async () => {
  const r = await page.evaluate(() => window.checks.blobRetry());
  assert.deepEqual(r, { how: 'blob', nodeOk: true });
});

test('MIDI init degrades to a warning here (no ALSA sequencer in CI)', async () => {
  const r = await page.evaluate(() => window.checks.midiInit());
  if (!r.ok) assert.ok(['failed', 'denied', 'unsupported'].includes(r.reason));
});

test('zero console errors on the fixture page', () => {
  assert.deepEqual(consoleErrors, []);
});

test('recorder with an unloadable worklet → visible "unavailable" state (separate page)', async () => {
  const p2 = await context.newPage();
  await p2.goto(page.url());
  await p2.waitForFunction(() => window.__ready === true);
  const r = await p2.evaluate(() => window.checks.unavailableRecorder());
  assert.deepEqual(r, { ok: false, state: 'unavailable' });
  await p2.close();
});

test('H2: real Web Locks — a second page of the same origin is secondary (muted, read-only) and takes over when the first closes', async () => {
  const pa = await context.newPage();
  await pa.goto(page.url());
  await pa.waitForFunction(() => window.__ready === true);
  const a = await pa.evaluate(() => window.checks.instanceGuard());
  assert.deepEqual([a.instance, a.started, a.readOnly], ['primary', 1, false]);
  const pb = await context.newPage();
  await pb.goto(page.url());
  await pb.waitForFunction(() => window.__ready === true);
  const b = await pb.evaluate(() => window.checks.instanceGuard());
  assert.equal(b.instance, 'secondary');
  assert.match(b.message, /Another Worship Rig window is open/);
  assert.equal(b.started, 0, 'no audio engine started in the second window');
  assert.equal(b.readOnly, true);
  await pa.close(); // releases the lock
  await pb.waitForFunction(() => window.__instance.ctl.status.instance === 'primary', null, { timeout: 5000 });
  const after = await pb.evaluate(() => ({ started: window.__instance.engine.started, readOnly: window.__instance.store.loadInfo.readOnly }));
  assert.deepEqual(after, { started: 1, readOnly: false });
  await pb.close();
});

test('L7: the server sends CSP + X-Frame-Options on the fixture HTML and the page still runs (worklet blob: retry ok)', async () => {
  const r = await page.evaluate(async () => {
    const res = await fetch(location.pathname, { cache: 'no-store' });
    return { csp: res.headers.get('content-security-policy'), xfo: res.headers.get('x-frame-options') };
  });
  assert.match(r.csp, /default-src 'self'/);
  assert.match(r.csp, /frame-ancestors 'none'/);
  assert.equal(r.xfo, 'DENY');
});

test('L-3: real app — __rig.ready resolves while requestMIDIAccess never answers; "pending" after 5 s; a late answer connects', async () => {
  const srv = createServer({ appDir: path.join(repoRoot, 'app'), port: 0 });
  const info = await srv.listen();
  const origin = `http://127.0.0.1:${info.port}`;
  const ctx = await browser.newContext();
  await ctx.grantPermissions([...MIDI_PERMISSIONS], { origin });
  // requestMIDIAccess that stays pending until the test answers it (an unanswered Chrome prompt / stalled CoreMIDI)
  await ctx.addInitScript(() => {
    const calls = [];
    window.__midiReq = calls;
    Object.defineProperty(Navigator.prototype, 'requestMIDIAccess', {
      configurable: true,
      value: () => new Promise((resolve, reject) => calls.push({ resolve, reject })),
    });
  });
  const p = await ctx.newPage();
  try {
    await p.goto(`${origin}/`);
    const t0 = Date.now();
    await waitRigReady(p, { timeout: 30000, what: 'real app: window.__rig.ready with MIDI pending' });
    const boot = await p.evaluate(() => ({
      calls: window.__midiReq.length, audio: window.__rig.controller.status.audio, midi: window.__rig.controller.status.midi,
    }));
    console.log(`# __rig.ready after ${Date.now() - t0} ms with MIDI pending; audio=${boot.audio}`);
    assert.equal(boot.calls, 1, 'the app asked for MIDI once');
    assert.equal(boot.midi.available, false);
    await p.waitForFunction(() => window.__rig.controller.status.midi.reason === 'pending', null, { timeout: 15000 });
    assert.equal(await p.evaluate(() => window.__rig.controller.status.midi.pending), true);
    const toasts = await p.evaluate(() => document.getElementById('toasts')?.textContent || '');
    if (toasts.trim()) console.log(`# toasts while pending: ${toasts.trim().slice(0, 200)}`);
    // the user finally answers the prompt: one hardware keyboard
    const got = await p.evaluate(async () => {
      const port = { id: 'kb', name: 'Roland Digital Piano', manufacturer: 'Roland', type: 'input', state: 'connected' };
      port.onmidimessage = null;
      const access = new EventTarget();
      access.inputs = new Map([['kb', port]]);
      window.__fakePort = port;
      window.__midiReq[0].resolve(access);
      const c = window.__rig.controller;
      for (let i = 0; i < 100 && !c.status.midi.connected; i++) await new Promise((r) => setTimeout(r, 20));
      const activity = new Promise((res) => c.addEventListener('midi-activity', (e) => res(e.detail), { once: true }));
      port.onmidimessage?.({ data: new Uint8Array([0x90, 60, 100]), timeStamp: performance.now() });
      const act = await Promise.race([activity, new Promise((r) => setTimeout(() => r(null), 2000))]);
      port.onmidimessage?.({ data: new Uint8Array([0x80, 60, 0]), timeStamp: performance.now() });
      const m = c.status.midi;
      return {
        connected: m.connected, available: m.available, name: m.name, reason: m.reason, pending: m.pending,
        wired: typeof port.onmidimessage === 'function', selection: window.__rig.midi.selection, act,
      };
    });
    assert.deepEqual(
      [got.available, got.connected, got.name, got.reason, got.pending, got.wired],
      [true, true, 'Roland Digital Piano', null, false, true],
    );
    assert.equal(got.act && got.act.inputId, 'kb', 'a note from the late-attached port reaches the controller');
  } finally {
    await ctx.close();
    await srv.close();
  }
});
