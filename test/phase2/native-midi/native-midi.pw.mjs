// Lane NMA, in the real 2.0 app (app/index.html, headless Chromium) on the bridge engine over MockNative, with Web
// MIDI removed from the page as WKWebView has none: midi.js runs unchanged over engine-bridge/native-midi.js, fed by
// MockNative's MIDI ports. A key from a mock port plays (`play on`), the MIDI lamp names the keyboard, MIDI Learn and
// Program Change work, a hot-unplug releases the held notes, the clock-out choice reaches `config.midiClock`. Zero
// console.error, no HTTP >= 400. A page that has Web MIDI (Chromium) keeps it: the adapter is not installed.
// main.js is served with its engine import swapped for engine-bridge/select.js (as the native shell's scheme handler
// and test/unit/engine-bridge/boot-smoke.mjs do); nothing under app/ is edited.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { MIDI_PERMISSIONS, waitRigReady, pinTheme } from '../../integration/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');
const APP = path.join(ROOT, 'app');
const require = createRequire(import.meta.url);
const { createServer } = require(path.join(ROOT, 'server.js'));
const API = fs.readFileSync(path.join(ROOT, 'native/contract/engine-api.json'));
const NEEDLE = "import { AudioEngine } from './engine/index.js';";

const NORD = { id: 'k1', name: 'Nord Stage 3 MIDI Output', manufacturer: 'Clavia', kind: 'input' };
const IAC = { id: 'v1', name: 'IAC Driver Bus 1', manufacturer: 'Apple Inc.', kind: 'input' };
const CLOCK_OUT = { id: 'o1', name: 'Clock Out', manufacturer: 'Roland', kind: 'output' };

let server;
let browser;
let origin;
before(async () => {
  server = createServer({ appDir: APP, port: 0 });
  const info = await server.listen();
  origin = `http://127.0.0.1:${info.port}`;
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

/**
 * A page of the real app on the bridge engine. `webMidi: false` deletes navigator.requestMIDIAccess before any page
 * script (WKWebView); `ports` = MockNative's MIDI ports at boot.
 */
async function openApp({ webMidi = false, ports = [] } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await pinTheme(context, 'classic');
  await context.grantPermissions([...MIDI_PERMISSIONS], { origin });
  await context.route('**/__bridge/engine-api.json', (r) => r.fulfill({ status: 200, body: API,
    contentType: 'application/json' }));
  await context.route('**/js/main.js', async (route) => {
    const src = fs.readFileSync(path.join(APP, 'js/main.js'), 'utf8');
    assert.ok(src.includes(NEEDLE), 'main.js engine import changed: update this test');
    await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8',
      body: src.replace(NEEDLE, "import { AudioEngine } from './engine-bridge/select.js';") });
  });
  await context.addInitScript(({ webMidi: keep, ports: list }) => {
    if (!keep) delete Navigator.prototype.requestMIDIAccess;
    globalThis.__bridgeMockMidiPorts = list;
  }, { webMidi, ports });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url || '?'}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  await page.goto(`${origin}/?engine=bridge-mock`);
  await waitRigReady(page, { timeout: 45000 });
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
  /** Messages the page sent to (mock) native since index `from`, without the envelope. */
  const sent = (from = 0) => ev((k) => globalThis.__bridgeLog.toNative.slice(k).map(({ v, id, ...m }) => m), from);
  const mark = () => ev(() => globalThis.__bridgeLog.toNative.length);
  const listens = async () => (await sent()).filter((m) => m.op === 'midi' && m.action === 'listen').map((m) => m.ids);
  const midiIn = (id, data) => ev(([i, d]) => globalThis.__bridgeMock.midiIn(i, d), [id, data]);
  return { context, page, errors, ev, until, sent, mark, listens, midiIn };
}

test('no Web MIDI (WKWebView): midi.js runs on the bridge; keys play, Learn, Program Change, lamp, hot-unplug',
  { timeout: 240000 }, async (t) => {
    const a = await openApp({ ports: [NORD, IAC, CLOCK_OUT] });
    try {
      await t.test('boot: the adapter answers requestMIDIAccess; the lamp names the hardware keyboard', async () => {
        assert.equal(await a.ev(() => !!navigator.requestMIDIAccess?.nativeMidi), true);
        await a.until(() => window.__rig.controller.status.midi.connected === true);
        const st = await a.ev(() => {
          const m = window.__rig.controller.status.midi;
          return { available: m.available, name: m.name, inputs: m.inputs.map((i) => [i.id, i.kind]) };
        });
        assert.deepEqual(st, { available: true, name: NORD.name, inputs: [['k1', 'hardware'], ['v1', 'virtual']] });
        await a.until((n) => document.getElementById('midi-name').textContent.trim() === n, NORD.name);
        assert.equal(await a.ev(() => document.getElementById('midi-name').classList.contains('off')), false);
        // one listen to learn the ports, then midi.js's selection: the IAC bus is never connected
        await a.until(() => globalThis.__bridgeMock.midi.listening?.has('k1'));
        assert.deepEqual(await a.listens(), [[], ['k1']]);
        assert.deepEqual(await a.ev(() => globalThis.__bridgeMock.findings), []);
      });

      await t.test('a key on the keyboard → play on / off; the IAC bus does not play', async () => {
        const m0 = await a.mark();
        assert.equal(await a.midiIn('k1', [0x90, 60, 100]), true);
        await a.until((k) => globalThis.__bridgeLog.toNative.slice(k).some((m) => m.op === 'play' && m.e === 'on'), m0);
        assert.equal(await a.midiIn('v1', [0x90, 72, 100]), false);
        await a.midiIn('k1', [0x80, 60, 0]);
        await a.until((k) => globalThis.__bridgeLog.toNative.slice(k).some((m) => m.op === 'play' && m.e === 'off'),
          m0);
        const plays = (await a.sent(m0)).filter((m) => m.op === 'play' && (m.e === 'on' || m.e === 'off'));
        assert.equal(plays.length, 2, JSON.stringify(plays));
        assert.equal(plays[0].e, 'on');
        assert.equal(plays[1].n, plays[0].n);
        assert.ok(plays[0].vel >= 1 && plays[0].vel <= 127, `velocity ${plays[0].vel}`);
        // the sustain pedal arrives as a pedal message
        const m1 = await a.mark();
        await a.midiIn('k1', [0xb0, 64, 127]);
        await a.until((k) => globalThis.__bridgeLog.toNative.slice(k).some((m) => m.op === 'play' && m.e === 'pedal'
          && m.down === true), m1);
        await a.midiIn('k1', [0xb0, 64, 0]);
      });

      await t.test('MIDI Learn: a CC learned to Next song, then that CC moves to the next song', async () => {
        const learning = a.ev(() => window.__rig.controller.learn('nextSong', { timeoutMs: 10000 }));
        await a.until(() => window.__rig.midi.learning === 'nextSong');
        await a.midiIn('k1', [0xb0, 80, 127]);
        const res = await learning;
        assert.deepEqual(res, { cc: 80, channel: 0 });
        const stored = await a.ev(() => window.__rig.store.get().settings.midiLearn.nextSong);
        assert.deepEqual(stored, { cc: 80, channel: 0 });
        const ids = await a.ev(() => window.__rig.store.navIds());
        const cur = await a.ev(() => window.__rig.store.get().settings.currentSongId);
        const next = ids[ids.indexOf(cur) + 1];
        assert.ok(next, 'a next song exists');
        await a.midiIn('k1', [0xb0, 80, 127]);
        await a.until((id) => window.__rig.store.get().settings.currentSongId === id, next);
        await a.midiIn('k1', [0xb0, 80, 0]);
      });

      await t.test('Program Change cues the setlist song', async () => {
        await a.ev(() => window.__rig.store.set('settings.programChange', true));
        try {
          const ids = await a.ev(() => window.__rig.store.navIds());
          await a.midiIn('k1', [0xc0, 3]);
          await a.until((id) => window.__rig.controller.status.cue?.id === id, ids[3]);
          assert.deepEqual(await a.ev(() => window.__rig.controller.status.cue), { id: ids[3], index: 3 });
        } finally {
          await a.ev(() => window.__rig.store.set('settings.programChange', false));
        }
      });

      await t.test('hot-unplug releases the held notes; the lamp falls back; the re-plugged keyboard plays again',
        async () => {
          const m0 = await a.mark();
          await a.midiIn('k1', [0x90, 64, 90]);
          await a.midiIn('k1', [0x90, 67, 90]);
          await a.until((k) => globalThis.__bridgeLog.toNative.slice(k).filter((m) => m.op === 'play'
            && m.e === 'on').length === 2, m0);
          const on = (await a.sent(m0)).filter((m) => m.op === 'play' && m.e === 'on').map((m) => m.n).sort();
          await a.ev(() => globalThis.__bridgeMock.midiUnplug('k1'));
          await a.until(([k, n]) => {
            const off = globalThis.__bridgeLog.toNative.slice(k).filter((m) => m.op === 'play' && m.e === 'off');
            return n.every((x) => off.some((m) => m.n === x));
          }, [m0, on]);
          await a.until(() => window.__rig.controller.status.midi.fallback === true);
          await a.until(() => globalThis.__bridgeMock.midi.listening?.has('v1')
            && !globalThis.__bridgeMock.midi.listening.has('k1'));
          assert.equal(await a.ev(() => window.__rig.midi.access.inputs.get('k1').state), 'disconnected');
          await a.until((n) => document.getElementById('midi-name').textContent.trim() === n, IAC.name);
          // the keyboard comes back: 'first' takes it again (the stand-in was the all-ports fallback, not sticky)
          await a.ev((p) => globalThis.__bridgeMock.midiPlug(p), NORD);
          await a.until((n) => window.__rig.controller.status.midi.name === n, NORD.name);
          await a.until(() => globalThis.__bridgeMock.midi.listening?.has('k1'));
          const m1 = await a.mark();
          assert.equal(await a.midiIn('k1', [0x90, 62, 80]), true);
          await a.until((k) => globalThis.__bridgeLog.toNative.slice(k).some((m) => m.op === 'play' && m.e === 'on'),
            m1);
          await a.midiIn('k1', [0x80, 62, 0]);
        });

      await t.test('MIDI clock out: the chosen output name reaches config.midiClock.port', async () => {
        const outs = await a.ev(() => window.__rig.controller.midiOutputs());
        assert.deepEqual(outs, [{ id: 'o1', name: 'Clock Out', state: 'connected' }]);
        const m0 = await a.mark();
        await a.ev(() => window.__rig.store.set('settings.midiClockOut', 'Clock Out'));
        await a.until((k) => globalThis.__bridgeLog.toNative.slice(k).some((m) => m.op === 'config' && m.midiClock
          && m.midiClock.port === 'Clock Out'), m0);
        assert.equal(await a.ev(() => window.__rig.controller.status.click.midiClockConnected), true);
        await a.ev(() => window.__rig.store.set('settings.midiClockOut', null));
        await a.until((k) => globalThis.__bridgeLog.toNative.slice(k).some((m) => m.op === 'config' && m.midiClock
          && m.midiClock.port === null), m0);
      });

      await t.test('wire and console: every message contract-valid, zero console.error, no HTTP >= 400', async () => {
        assert.deepEqual(await a.ev(() => globalThis.__bridgeMock.findings), []);
        assert.deepEqual(a.errors, []);
      });
    } finally {
      await a.context.close();
    }
  });

test('a page with Web MIDI (Chromium) keeps its own: the adapter is not installed, no midi op is sent',
  { timeout: 120000 }, async () => {
    const a = await openApp({ webMidi: true, ports: [NORD] });
    try {
      assert.equal(await a.ev(() => typeof navigator.requestMIDIAccess), 'function');
      assert.equal(await a.ev(() => !!navigator.requestMIDIAccess.nativeMidi), false);
      assert.equal(await a.ev(() => globalThis.__nativeMidi), null);
      await a.page.waitForTimeout(500);
      assert.deepEqual((await a.sent()).filter((m) => m.op === 'midi'), []);
      assert.deepEqual(a.errors, []);
    } finally {
      await a.context.close();
    }
  });
