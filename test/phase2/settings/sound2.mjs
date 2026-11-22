// Settings suite, "bridge" mode (2.0, native DECISIONS D1, D2, D4): Settings › Sound's Voices per sound, Buffer size
// and Total voice limit against the 2.0 engine. The settings fixture boots BridgeEngine over MockNative
// (?engine=bridge-mock, engine-bridge/boot-mock.js) instead of the Web Audio engine; the loopback transport's log
// (globalThis.__bridgeLog.toNative) shows exactly what the controller sent: config {polyphony}, config {voiceLimit}
// ('off' → 0) and audio {bufferFrames} on start / restart. Called by run.mjs; results go into its table.
// UIB (UI wave items 4-6): Freeze drone to save CPU → config {droneFreeze}; the Range slider → config {dynamicRange};
// a buffer pick during a slow restart is not dropped (Settings review item 1); the granted-size line is shown from
// mock-native's own bufferFrames (item 3) and the engine's sampleRate (item 4).
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { MIDI_PERMISSIONS, waitRigReady, pinTheme } from '../../integration/lib.mjs';

/**
 * @param {{browser: import('playwright').Browser, createServer: Function, ROOT: string, SHOTS: string,
 *   results: object[]}} o
 */
export async function runBridge({ browser, createServer, ROOT, SHOTS, results }) {
  const mode = 'bridge';
  const server = createServer({ appDir: ROOT, port: 0 });
  const info = await server.listen();
  const origin = `http://127.0.0.1:${info.port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await pinTheme(context, 'classic');
  await context.grantPermissions([...MIDI_PERMISSIONS], { origin });
  // boot-mock.js fetches the contract from /__bridge/engine-api.json (boot-smoke's server serves it; server.js not)
  const api = fs.readFileSync(path.join(ROOT, 'native/contract/engine-api.json'));
  await context.route('**/__bridge/engine-api.json', (r) => r.fulfill({ status: 200, body: api,
    contentType: 'application/json' }));
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url || '?'}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const notes = [];
  const T = async (name, fn) => {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ mode, name, ok: true });
      console.log(`  ✓ [${mode}] ${name} (${Date.now() - t0} ms)`);
    } catch (err) {
      results.push({ mode, name, ok: false, err });
      console.log(`  ✗ [${mode}] ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6)
        .join('\n      ')}`);
    }
  };
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
  /** The 2.0 Sound messages the page sent so far (config polyphony / voiceLimit, audio start / restart). */
  const sent = () => ev(() => globalThis.__bridgeLog.toNative
    .filter((m) => (m.op === 'config' && ('polyphony' in m || 'voiceLimit' in m)) || m.op === 'audio')
    .map(({ v, id, ...m }) => m));
  const mark = () => ev(() => globalThis.__bridgeLog.toNative.length);
  const sentSince = (n) => ev((k) => globalThis.__bridgeLog.toNative.slice(k)
    .filter((m) => (m.op === 'config' && ('polyphony' in m || 'voiceLimit' in m)) || m.op === 'audio')
    .map(({ v, id, ...m }) => m), n);
  const openSound = async () => {
    await ev(() => window.__rig.ctx.openSettings({ section: 'voices' }));
    await until(() => window.__rig.views.settings.isOpen && window.__rig.views.settings.category === 'sound');
  };
  const close = async () => {
    await page.click('.st-close');
    await until(() => document.getElementById('view-settings').hidden);
  };

  console.log(`\n[${mode}] ${origin} (BridgeEngine over MockNative)`);
  try {
    await T('boot: the fixture on the 2.0 bridge engine (mock native); the start-up sends the stored Sound settings',
      async () => {
        await page.goto(`${origin}/test/phase2/settings/fixture.html?engine=bridge-mock`);
        await until(() => !!(window.__rig && window.__rig.views && window.__rig.views.settings), null, 20000);
        await waitRigReady(page, { timeout: 30000, what: `[${mode}] window.__rig.ready` });
        assert.equal(await ev(() => !!globalThis.__bridgeMock && typeof window.__rig.engine.setPolyphony), 'function');
        await until(() => window.__rig.controller.status.audioConfig.native === true);
        // defaults (nothing stored): buffer 128 rides on audio start, then polyphony 64 and voice limit Auto
        await until(() => globalThis.__bridgeLog.toNative.some((m) => m.op === 'config' && 'voiceLimit' in m));
        const s = await sent();
        const start = s.find((m) => m.op === 'audio' && m.action === 'start');
        assert.equal(start && start.bufferFrames, 128, `audio start asks for 128 frames (${JSON.stringify(s)})`);
        assert.deepEqual(s.filter((m) => m.op === 'config'), [{ op: 'config', polyphony: 64 },
          { op: 'config', voiceLimit: 'auto' }]);
      });

    await T('Settings › Sound on the 2.0 engine: no "2.0 only" note; Voices per sound → config {polyphony}',
      async () => {
        await openSound();
        assert.equal(await page.isVisible('[data-testid="settings-engine-note"]'), false);
        const n = await mark();
        await page.click('[data-testid="setting-polyphony"] button[data-value="128"]');
        await until(() => window.__rig.controller.status.audioConfig.polyphony === 128);
        assert.deepEqual(await sentSince(n), [{ op: 'config', polyphony: 128 }]);
        assert.equal(await ev(() => window.__rig.store.get().settings.polyphony), 128);
        await page.click('[data-testid="setting-polyphony"] button[data-value="32"]');
        await until(() => window.__rig.controller.status.audioConfig.polyphony === 32);
      });

    await T('Buffer size → audio restart {bufferFrames} through controller.restartAudio (song re-applied); the '
      + 'granted size and its latency show when the engine reports them', async () => {
      const n = await mark();
      const songId = await ev(() => window.__rig.controller.status.songId);
      await page.click('[data-testid="setting-buffer-frames"] button[data-value="512"]');
      await until(() => window.__rig.controller.status.audio === 'running'
        && globalThis.__bridgeLog.toNative.some((m) => m.op === 'audio' && m.action === 'restart'
          && m.bufferFrames === 512));
      const s = await sentSince(n);
      assert.equal(s.filter((m) => m.op === 'audio').length, 1, `one restart (${JSON.stringify(s)})`);
      assert.equal(await ev(() => window.__rig.controller.status.audioConfig.bufferRequested), 512);
      assert.equal(await ev(() => window.__rig.controller.status.songId), songId, 'same song after the restart');
      // Settings review item 3: mock-native reports the grant like the core (audio reply + state event); item 4:
      // the ms come from the sample rate the engine reported (status.audioConfig.sampleRate), not engine.ctx
      await until(() => window.__rig.controller.status.audioConfig.bufferFrames === 512);
      assert.equal(await ev(() => window.__rig.controller.status.audioConfig.sampleRate), 48000);
      await until(() => /^10\.7 ms per buffer/.test(document.querySelector('[data-testid="setting-buffer-granted"]')
        .textContent));
      // a granted size other than the request (the iPad rounds it) is said plainly; pushed as a state event
      await ev(() => globalThis.__bridgeMock._emit('state', globalThis.__bridgeMock._state({ bufferFrames: 256 })));
      await until(() => window.__rig.controller.status.audioConfig.bufferFrames === 256);
      await until(() => /^Device gave 256\. 5\.3 ms per buffer/.test(
        document.querySelector('[data-testid="setting-buffer-granted"]').textContent));
      // a 44.1 kHz device: the line follows the rate the engine reports
      await ev(() => globalThis.__bridgeMock._emit('state', globalThis.__bridgeMock._state({ bufferFrames: 256,
        sampleRate: 44100 })));
      await until(() => /^Device gave 256\. 5\.8 ms per buffer/.test(
        document.querySelector('[data-testid="setting-buffer-granted"]').textContent));
      await ev(() => globalThis.__bridgeMock._emit('state', globalThis.__bridgeMock._state({})));
      await page.click('[data-testid="setting-buffer-frames"] button[data-value="128"]');
      await until(() => globalThis.__bridgeLog.toNative.some((m) => m.op === 'audio' && m.action === 'restart'
        && m.bufferFrames === 128) && window.__rig.controller.status.audio === 'running');
    });

    await T('Settings review item 1: a buffer pick made while a (slow) restart runs is not dropped: one more '
      + 'restart follows and the engine ends on the stored size', async () => {
      // the mock answers restarts after 400 ms, as a real device reopen may take
      await ev(() => {
        const m = globalThis.__bridgeMock;
        m.__opAudio = m.__opAudio || m.op_audio;
        m.op_audio = function slow(msg) {
          if (msg.action !== 'restart') return m.__opAudio.call(m, msg);
          setTimeout(() => {
            m.__opAudio.call(m, msg);
            m._flush();
          }, 400);
          return undefined;
        };
      });
      const n = await mark();
      await page.click('[data-testid="setting-buffer-frames"] button[data-value="256"]');
      await until(() => window.__rig.controller.status.audio === 'restarting');
      await page.waitForTimeout(60);
      await page.click('[data-testid="setting-buffer-frames"] button[data-value="512"]'); // during the restart
      await until(() => globalThis.__bridgeLog.toNative.filter((m) => m.op === 'audio' && m.action === 'restart')
        .length >= 2 && window.__rig.controller.status.audio === 'running'
        && window.__rig.controller.status.audioConfig.bufferFrames === 512, null, 10000);
      const restarts = (await sentSince(n)).filter((m) => m.op === 'audio');
      assert.deepEqual(restarts.map((m) => m.bufferFrames), [256, 512], JSON.stringify(restarts));
      assert.equal(await ev(() => globalThis.__bridgeMock.bufferFrames), 512, 'the engine runs the stored size');
      assert.equal(await ev(() => window.__rig.store.get().settings.bufferFrames), 512);
      await ev(() => {
        const m = globalThis.__bridgeMock;
        m.op_audio = m.__opAudio;
      });
      await page.click('[data-testid="setting-buffer-frames"] button[data-value="128"]');
      await until(() => window.__rig.controller.status.audioConfig.bufferFrames === 128
        && window.__rig.controller.status.audio === 'running');
    });

    await T('Total voice limit (Advanced) → config {voiceLimit}: Off = 0, a number, Auto; Auto shows the engine\'s '
      + 'number when reported', async () => {
      const d = '[data-testid="settings-advanced-sound"]';
      if ((await page.getAttribute(d, 'open')) === null) await page.click(`${d} > summary`);
      const n = await mark();
      await page.click('[data-testid="setting-voice-limit"] button[data-value="off"]');
      await until(() => window.__rig.controller.status.audioConfig.voiceLimit === 'off');
      await page.click('[data-testid="setting-voice-limit"] button[data-value="256"]');
      await until(() => window.__rig.controller.status.audioConfig.voiceLimit === 256);
      await page.click('[data-testid="setting-voice-limit"] button[data-value="auto"]');
      await until(() => window.__rig.controller.status.audioConfig.voiceLimit === 'auto');
      assert.deepEqual(await sentSince(n), [{ op: 'config', voiceLimit: 0 }, { op: 'config', voiceLimit: 256 },
        { op: 'config', voiceLimit: 'auto' }]);
      assert.equal(await ev(() => window.__rig.store.get().settings.voiceLimit), 'auto');
      const eff = await ev(() => window.__rig.controller.status.audioConfig.voiceLimitEffective);
      if (Number.isFinite(eff) && eff > 0) {
        await until((e) => document.querySelector('[data-testid="setting-voice-limit-effective"]').textContent
          === `Auto: ${e} voices on this device`, eff);
      } else notes.push(`mock-native's voiceLimit reply has no Auto number (voiceLimitEffective ${eff})`);
      // the engine's number from a state event / reply reaches the line (what T00c's core sends with get state)
      await ev(() => globalThis.__bridgeMock._emit('state', globalThis.__bridgeMock._state({ voiceLimit: 'auto',
        voiceLimitEffective: 384 })));
      await until(() => document.querySelector('[data-testid="setting-voice-limit-effective"]').textContent
        === 'Auto: 384 voices on this device');
      await page.locator('[data-testid="settings-panel-sound"]')
        .screenshot({ path: path.join(SHOTS, 'bridge-sound.png') });
    });

    await T('Freeze drone to save CPU (D5, Advanced) → config {droneFreeze}; on by default, nothing sent at boot; '
      + 'no "2.0 engine" note on the 2.0 engine', async () => {
      const cfg = (k) => ev((key) => globalThis.__bridgeLog.toNative
        .filter((m) => m.op === 'config' && key in m).map(({ v, id, ...m }) => m), k);
      assert.deepEqual(await cfg('droneFreeze'), [], 'absent = on = the core default: nothing sent at start-up');
      const tog = '[data-testid="setting-drone-freeze"]';
      assert.equal(await page.getAttribute(tog, 'aria-checked'), 'true');
      assert.equal(await page.isVisible('[data-testid="setting-drone-freeze-note"]'), false);
      await page.click(tog);
      await until(() => globalThis.__bridgeMock.droneFreeze === false);
      assert.equal(await ev(() => window.__rig.store.get().settings.droneFreeze), false);
      await page.click(tog);
      await until(() => globalThis.__bridgeMock.droneFreeze === true);
      assert.deepEqual(await cfg('droneFreeze'), [{ op: 'config', droneFreeze: false },
        { op: 'config', droneFreeze: true }]);
      await page.locator('[data-testid="settings-advanced-sound"]')
        .screenshot({ path: path.join(SHOTS, 'bridge-sound-advanced.png') });
      await close();
      for (const k of ['polyphony', 'bufferFrames', 'voiceLimit', 'droneFreeze']) {
        await ev((key) => window.__rig.store.set(`settings.${key}`, null), k);
      }
    });

    await T('Range (settings.dynamicRange, Keyboards & MIDI) → config {dynamicRange}; the mock answers the range in '
      + 'force like the core', async () => {
      const cfg = () => ev(() => globalThis.__bridgeLog.toNative
        .filter((m) => m.op === 'config' && 'dynamicRange' in m).map((m) => m.dynamicRange));
      assert.deepEqual(await cfg(), [], 'absent = 1 = the core default: nothing sent at start-up');
      await ev(() => window.__rig.ctx.openSettings({ section: 'keyboards' }));
      await until(() => window.__rig.views.settings.category === 'keyboards');
      await page.locator('[data-testid="setting-dynamic-range"]').fill('2'); // the slider's input event
      await until(() => globalThis.__bridgeMock.dynamicRange === 2);
      await ev(() => window.__rig.store.set('settings.dynamicRange', null)); // back to today's sound
      await until(() => globalThis.__bridgeMock.dynamicRange === 1);
      assert.deepEqual(await cfg(), [2, 1]);
      await close();
    });

    await T('boot with Freeze off and a Range stored: the start-up sends config {droneFreeze:false} and '
      + '{dynamicRange}', async () => {
      await ev(() => {
        window.__rig.store.set('settings.droneFreeze', false);
        window.__rig.store.set('settings.dynamicRange', 2.5);
      });
      await until(() => /"droneFreeze":false/.test(localStorage.getItem('rig.v1') || ''), null, 5000);
      await page.reload();
      await until(() => !!(window.__rig && window.__rig.views && window.__rig.views.settings), null, 20000);
      await waitRigReady(page, { timeout: 30000, what: `[${mode}] window.__rig.ready after reload` });
      await until(() => globalThis.__bridgeMock.droneFreeze === false && globalThis.__bridgeMock.dynamicRange === 2.5);
      await ev(() => {
        window.__rig.store.set('settings.droneFreeze', null);
        window.__rig.store.set('settings.dynamicRange', null);
      });
      await until(() => globalThis.__bridgeMock.droneFreeze === true && globalThis.__bridgeMock.dynamicRange === 1);
    });
  } finally {
    await T('zero console.error', async () => {
      assert.deepEqual(errors, []);
    });
    for (const x of notes) console.log(`    NOTE [${mode}] ${x}`);
    await context.close();
    await server.close();
  }
}
