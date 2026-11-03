#!/usr/bin/env node
// Settings Playwright suite (views/settings.js), moved out of the retired ui-edit suite (hv2-edit-integrate).
//   node test/phase2/settings/run.mjs            → both modes
//   SETTINGS_MODES=app|fixture|mac node …        → one mode
// Modes:
//   app     — the real app (app/index.html + main.js: Perform, the H-v2 Edit and Settings) served by server.js at "/".
//             The page switches to Edit first, so Settings is tested over the new Edit view (Esc ownership, focus).
//   fixture — test/phase2/settings/fixture.html: a minimal bootstrap that mounts ONLY Settings with the FALLBACK
//             component set (exercises views/_fallback-components.js).
//   mac     — the fixture with a fake window.rig (v11-electron, mac.mjs): global shortcuts and the update line, which
//             only exist in the Mac app. Its own tests only.
// Every mode: the 11 settings tests from ui-edit, zero console.error, screenshots at 1440×900 and 1024×700 →
// test/phase2/settings/screenshots/<mode>-<size>-settings.png (+ settings.png for the app at 1440).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { MIDI_PERMISSIONS, waitRigReady, pinTheme } from '../../integration/lib.mjs';
import { runMac } from './mac.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const APP = path.join(ROOT, 'app');
const SHOTS = path.join(HERE, 'screenshots');
const { createServer } = require(path.join(ROOT, 'server.js'));

const haveApp = fs.existsSync(path.join(APP, 'index.html')) && fs.existsSync(path.join(APP, 'js', 'main.js')) &&
  /mountSettings/.test(fs.readFileSync(path.join(APP, 'js', 'main.js'), 'utf8'));
const MODES = (process.env.SETTINGS_MODES || (haveApp ? 'app,fixture,mac' : 'fixture,mac')).split(',').map((s) => s.trim()).filter(Boolean);
const VERBOSE = !!process.env.VERBOSE;

fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const notes = [];
const note = (mode, msg) => {
  notes.push(`[${mode}] ${msg}`);
  console.log(`    NOTE [${mode}] ${msg}`);
};

// -----------------------------------------------------------------------------------------------------------
async function runMode(mode, browser) {
  // My Samples on, with an empty scan root: exercises the Settings panel and the real rescan path without 404s
  const userSamplesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-settings-samples-'));
  const server = createServer({ appDir: mode === 'app' ? APP : ROOT, port: 0, userSamples: [userSamplesDir] });
  const info = await server.listen();
  const origin = `http://127.0.0.1:${info.port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await pinTheme(context, 'classic'); // theme-classic: assert the base look whatever the default theme is
  // L-4: 'midi' only (test/README.md "Web MIDI in the browser suites"); MIDI Learn etc. use midi._inject
  await context.grantPermissions([...MIDI_PERMISSIONS], { origin });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url || '?'}`);
    else if (VERBOSE) console.log(`   [${mode} ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  const T = async (name, fn) => {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ mode, name, ok: true });
      console.log(`  ✓ [${mode}] ${name} (${Date.now() - t0} ms)`);
    } catch (err) {
      results.push({ mode, name, ok: false, err });
      console.log(`  ✗ [${mode}] ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n      ')}`);
      // CI-1: a failed test must not leave Settings open: the modal covers #btn-settings, so every later
      // openSettings() timed out on the click and one failure was reported as five (macos-14 run of 2026-09-30).
      try {
        if (await page.evaluate(() => !document.getElementById('view-settings')?.hidden)) {
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => document.getElementById('view-settings').hidden, null, { timeout: 5000 });
        }
      } catch { /* the next test reports its own failure */ }
    }
  };
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
  /** peak short-window RMS (dBFS) at the engine analyser over `ms` */
  const rmsDb = (ms = 400) =>
    ev(async (ms) => {
      const an = window.__rig.engine.analyserL;
      const buf = new Float32Array(an.fftSize);
      let best = -Infinity;
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        best = Math.max(best, 10 * Math.log10(s / buf.length + 1e-20));
        await new Promise((r) => setTimeout(r, 25));
      }
      return best;
    }, ms);
  const playAndMeasure = async (note = 60) => {
    await ev((n) => window.__rig.controller.perform.noteOn(n, 110), note);
    const db = await rmsDb(500);
    await ev((n) => window.__rig.controller.perform.noteOff(n), note);
    return db;
  };

  console.log(`\n[${mode}] ${origin}`);
  try {
    // ------------------------------------------------------------------------------------------ boot
    await T('boot: app + views mounted, audio running', async () => {
      await page.goto(mode === 'app' ? `${origin}/` : `${origin}/test/phase2/settings/fixture.html`);
      await until(() => !!(window.__rig && window.__rig.views && window.__rig.views.settings), null, 20000);
      await waitRigReady(page, { timeout: 30000, what: `[${mode}] window.__rig.ready` }); // L-4
      if (mode === 'app') {
        const overlay = await page.$('#overlay-start:not([hidden])');
        if (overlay) await overlay.click();
        // Settings over the H-v2 Edit view (views/edit/shell.js)
        await until(() => !!window.__rig.views.edit, null, 20000);
        await page.click('#view-switch button[data-value="edit"]');
        await until(() => !document.getElementById('view-edit').hidden && !!document.querySelector('#view-edit .ev2'));
      }
      await until(() => window.__rig.engine.ctx && window.__rig.engine.ctx.state === 'running');
      await until(() => window.__rig.controller.status.songId === window.__rig.store.get().settings.currentSongId && !window.__rig.controller.status.loading, null, 30000);
    });

    const cleanForShot = () =>
      ev(() => {
        for (const t of document.querySelectorAll('#toasts > *')) t.remove();
        for (const c of document.querySelectorAll('.st-body')) c.scrollTop = 0;
        document.activeElement?.blur?.();
      });
    const SIZES = [[1440, 900], [1024, 700]];

    // ------------------------------------------------------------------------------------------ settings
    const openSettings = async () => {
      if (mode === 'app') await page.click('#btn-settings');
      else await ev(() => window.__rig.ctx.openSettings());
      await until(() => !document.getElementById('view-settings').hidden && window.__rig.views.settings.isOpen);
    };

    await T('settings: open, outputs listed, screenshot, close button', async () => {
      await openSettings();
      assert.ok((await page.locator('select.st-output option').count()) >= 1);
      assert.equal(await page.textContent('.st-learn-table tbody tr:first-child th'), 'Keys level');
      assert.ok(await page.$('tr[data-control="swell"]'), 'swell row present');
      // polish-2B naming (ux-round2 #5): the reverb return is "Space level", as in Edit's Wheels & pedal
      assert.equal(await page.textContent('tr[data-control="fx.reverb.returnGain"] th'), 'Space level');
      assert.equal(await ev(() => /Reverb level/.test(document.querySelector('.st-learn-table').textContent)), false);
      assert.equal(await ev(() => document.body.dataset.dialogOpen), '1', 'dialog flag while Settings is open');
      for (const [w, hgt] of SIZES) {
        await page.setViewportSize({ width: w, height: hgt });
        await cleanForShot();
        await sleep(300);
        await page.screenshot({ path: path.join(SHOTS, `${mode}-${w}x${hgt}-settings.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      fs.copyFileSync(path.join(SHOTS, `${mode}-1440x900-settings.png`), path.join(SHOTS, `${mode}-settings.png`));
      if (mode === 'app') fs.copyFileSync(path.join(SHOTS, 'app-settings.png'), path.join(SHOTS, 'settings.png'));
      await page.click('.st-close');
      await until(() => document.getElementById('view-settings').hidden && !window.__rig.views.settings.isOpen);
      if (mode === 'app') assert.equal(await ev(() => document.body.classList.contains('settings-open')), false);
      await until(() => document.body.dataset.dialogOpen === undefined);
    });

    await T('settings: latency change persists and restarts audio; sound after restart', async () => {
      await openSettings();
      await page.click('[data-bind="settings.latency"] button[data-value="balanced"]');
      await until(() => window.__rig.store.get().settings.latency === 'balanced');
      await until(() => window.__rig.engine.latency === 0.01 && window.__rig.controller.status.audio === 'running' && window.__rig.engine.ctx.state === 'running', null, 20000);
      await until(() => /"latency":"balanced"/.test(localStorage.getItem('rig.v1') || ''), null, 5000);
      await sleep(200);
      assert.ok((await playAndMeasure(60)) > -50, 'sound after restart');
      await page.click('[data-bind="settings.latency"] button[data-value="lowest"]');
      await until(() => window.__rig.engine.latency === 'interactive' && window.__rig.controller.status.audio === 'running', null, 20000);
      await until(() => /"latency":"lowest"/.test(localStorage.getItem('rig.v1') || ''), null, 5000);
    });

    await T('settings: mono / velocity / program change / computer keyboard persist', async () => {
      await page.click('[data-bind="settings.monoOutput"]');
      await until(() => window.__rig.store.get().settings.monoOutput === true && window.__rig.engine._monoOut === true);
      await page.click('[data-bind="settings.monoOutput"]');
      await until(() => window.__rig.store.get().settings.monoOutput === false && window.__rig.engine._monoOut === false);
      await page.click('[data-bind="settings.velocitySens"] button[data-value="soft"]');
      await until(() => window.__rig.store.get().settings.velocitySens === 'soft');
      await page.click('[data-bind="settings.velocitySens"] button[data-value="normal"]');
      await page.click('[data-bind="settings.programChange"]');
      await until(() => window.__rig.store.get().settings.programChange === true);
      await page.click('[data-bind="settings.programChange"]');
      await page.click('[data-bind="settings.computerKeyboard"]');
      await until(() => window.__rig.store.get().settings.computerKeyboard === false);
      await page.click('[data-bind="settings.computerKeyboard"]');
      await until(() => window.__rig.store.get().settings.computerKeyboard === true);
      await page.selectOption('select.st-midi-input', 'all');
      await until(() => window.__rig.store.get().settings.midiInputId === 'all' && window.__rig.midi.selection === 'all');
      await page.selectOption('select.st-midi-input', 'first');
      await until(() => /"computerKeyboard":true/.test(localStorage.getItem('rig.v1') || ''), null, 5000);
    });

    await T('settings: MIDI Learn (CC fader with pickup, note button, clear) via midi._inject', async () => {
      await page.click('tr[data-control="slots.1.gain"] .st-learn');
      await until(() => window.__rig.midi.learning === 'slots.1.gain');
      assert.match(await page.textContent('tr[data-control="slots.1.gain"] .st-map'), /Move a knob/);
      await ev(() => window.__rig.midi._inject([0xb0, 21, 64]));
      await until(() => window.__rig.store.get().settings.midiLearn['slots.1.gain']?.cc === 21);
      await until(() => document.querySelector('tr[data-control="slots.1.gain"] .st-map').textContent === 'CC 21 · ch 1');
      // pickup: sweep the hardware fader up → takes over after crossing, ends at the top (2.0 = +6 dB)
      await ev(async () => {
        for (let v = 0; v <= 127; v += 4) window.__rig.midi._inject([0xb0, 21, v]);
        window.__rig.midi._inject([0xb0, 21, 127]);
      });
      await until(() => window.__rig.store.currentSong().patch.slots[1] && Math.abs(window.__rig.store.currentSong().patch.slots[1].gain - 2) < 1e-9);
      await until(() => Math.abs(window.__rig.engine.getParam('slots.1.gain') - 2) < 1e-9);
      // button learned from a note
      await page.click('tr[data-control="nextSong"] .st-learn');
      await until(() => window.__rig.midi.learning === 'nextSong');
      await ev(() => window.__rig.midi._inject([0x91, 36, 100]));
      await until(() => document.querySelector('tr[data-control="nextSong"] .st-map').textContent === 'Note C2 · ch 2');
      assert.deepEqual(await ev(() => window.__rig.store.get().settings.midiLearn.nextSong), { note: 36, channel: 1 });
      // cancel a pending learn
      await page.click('tr[data-control="panic"] .st-learn');
      await until(() => window.__rig.midi.learning === 'panic');
      await page.click('tr[data-control="panic"] .st-learn');
      await until(() => window.__rig.midi.learning === null);
      // clear
      await page.click('tr[data-control="nextSong"] .st-clear');
      await until(() => !window.__rig.store.get().settings.midiLearn.nextSong);
      assert.equal(await page.textContent('tr[data-control="nextSong"] .st-map'), '—');
      await page.click('tr[data-control="slots.1.gain"] .st-clear');
      await ev(() => window.__rig.store.set('slots.1.gain', 0.7));
    });

    // hardware-fixes: the test samples BOTH states (press → settle → release → settle) and decides from the pair
    const pedalStep = (step) => until((st) => !!document.querySelector(`.st-pedal-prompt[data-step="${st}"]`), step);
    const cc64 = (v) => ev((x) => window.__rig.midi._inject([0xb0, 64, x]), v);
    await T('settings: pedal polarity detector samples pressed + released, suggests invert and applies it', async () => {
      await page.click('.st-pedal-test');
      await until(() => /Press your sustain pedal now/.test(document.querySelector('.st-pedal').textContent));
      await pedalStep('press');
      await cc64(0); // reversed: pressed reads "up"
      await pedalStep('release');
      assert.equal(await ev(() => !!document.querySelector('.st-pedal-result')), false, 'no verdict from one state');
      await cc64(127);
      await until(() => !!document.querySelector('.st-pedal-result[data-invert="true"]'));
      assert.match(await page.textContent('.st-pedal-result'), /sent 0 pressed and 127 released/);
      await page.click('.st-pedal-apply');
      await until(() => window.__rig.store.get().settings.pedalInvert === true);
      await page.click('.st-pedal-test');
      await pedalStep('press');
      await cc64(127);
      await pedalStep('release');
      await cc64(0);
      await until(() => !!document.querySelector('.st-pedal-result[data-invert="false"]'));
      await page.click('.st-pedal-apply');
      await until(() => window.__rig.store.get().settings.pedalInvert === false);
      assert.equal(await ev(() => window.__rig.controller._debug().pedalDown), false, 'no stuck pedal');
    });

    await T('settings: pedal test — a quick tap asks again; a continuous pedal settles; the release step ignores '
      + '"still down" values; the pair rule; the plug-in-with-pedal-UP copy', async () => {
      // a switch pedal tapped (127 then 0 inside the settle window) ends on the released value: ask again
      await page.click('.st-pedal-test');
      await pedalStep('press');
      await ev(() => {
        window.__rig.midi._inject([0xb0, 64, 127]);
        window.__rig.midi._inject([0xb0, 64, 0]);
      });
      await until(() => /keep it down until/.test(document.querySelector('.st-pedal-prompt')?.textContent || ''));
      assert.equal(await ev(() => document.querySelector('.st-pedal-prompt').dataset.step), 'press');
      // a continuous (half-)pedal ramps: the value it rests on counts; repeats of "down" in the release step don't
      await ev(() => [20, 50, 90, 127].forEach((v) => window.__rig.midi._inject([0xb0, 64, v])));
      await pedalStep('release');
      await cc64(127);
      await cc64(100);
      await new Promise((r) => setTimeout(r, 450));
      assert.equal(await ev(() => document.querySelector('.st-pedal-prompt')?.dataset.step), 'release',
        'values on the pressed side do not end the release step');
      await ev(() => [60, 20, 0].forEach((v) => window.__rig.midi._inject([0xb0, 64, v])));
      await until(() => !!document.querySelector('.st-pedal-result[data-invert="false"]'));
      assert.match(await page.textContent('.st-pedal-result'), /sent 127 pressed and 0 released — normal/);
      assert.equal(await ev(() => !!document.querySelector('.st-pedal-apply')), false, 'setting already right: no button');
      const rule = await ev(async (url) => {
        const m = await import(url);
        return [m.inferPedalPolarity(127, 0), m.inferPedalPolarity(0, 127), m.inferPedalPolarity(127, 90),
          m.inferPedalPolarity(10, 0), m.inferPedalPolarity(64, 63), m.inferPedalInvert(0)];
      }, mode === 'app' ? '/js/views/settings.js' : '/app/js/views/settings.js');
      assert.deepEqual(rule, [false, true, null, null, false, true]);
      await page.click('.st-pedal-again');
      await pedalStep('press');
      await page.click('.st-pedal button'); // Cancel
      const tip = await page.textContent('.st-pedal');
      assert.match(tip, /with your foot off the pedal \(pedal UP\)/);
    });


    await T('settings: touch (velocity) copy in plain words', async () => {
      await page.click('[data-bind="settings.velocitySens"] button[data-value="hard"]');
      await until(() => /play firmly/.test(document.querySelector('.st-vel-hint').textContent));
      await page.click('[data-bind="settings.velocitySens"] button[data-value="normal"]');
      await until(() => /harder you play, the louder/.test(document.querySelector('.st-vel-hint').textContent));
      await until(() => /"velocitySens":"normal"/.test(localStorage.getItem('rig.v1') || ''), null, 5000);
    });

    // v11-touch: Your keyboards — the on-screen keys row, the guided "play soft, then hard" fit (through the real
    // controller.captureTouch), the curve reaching engine.noteOn as {touch}, Back to standard, Remember / Forget
    await T('settings: Your keyboards — fit the on-screen keys to a soft/hard touch, use it, remember / forget', async () => {
      const row = '.st-kbs [data-keyboard="@computer"]';
      await until((r) => !!document.querySelector(r), row);
      assert.match(await page.textContent(`${row} .st-kb-name`), /On-screen & computer keys/);
      assert.match(await page.textContent(`${row} .st-kb-sum`), /Standard touch/);
      assert.equal(await ev(() => 'keyboards' in window.__rig.store.get().settings), false, 'nothing saved by default');
      await page.click(`${row} .st-kb-touch`);
      await until((r) => !document.querySelector(`${r} .st-kb-edit`).hidden, row);
      // T3: the diagram's reference diagonal is a theme token, not white-on-paper
      assert.equal(await ev((r) => getComputedStyle(document.querySelector(`${r} .st-kb-ref`)).stroke !== 'none', row), true);
      const play = (vels) => ev(async (vs) => {
        let n = 48;
        for (const v of vs) {
          window.__rig.controller.perform.noteOn(n, v);
          window.__rig.controller.perform.noteOff(n);
          n += 1;
          await new Promise((r) => setTimeout(r, 20));
        }
      }, vels);
      // the computer keys play at one strength: soft = hard → a plain "nothing to fit" message
      await page.click(`${row} .st-kb-fitbtn`);
      await until((r) => document.querySelector(`${r} .st-kb-prompt`)?.dataset.step === 'soft', row);
      await play([100, 100, 100, 100, 100, 100]);
      await until((r) => document.querySelector(`${r} .st-kb-prompt`)?.dataset.step === 'hard', row);
      await play([100, 100, 100, 100, 100, 100]);
      await until((r) => document.querySelector(`${r} .st-kb-result`)?.dataset.result === 'same', row);
      // again with the on-screen keys' range (higher on a key = softer)
      await page.click(`${row} .st-kb-again`);
      await play([24, 26, 22, 25, 23, 24]);
      await play([96, 100, 98, 97, 99, 98]);
      await until((r) => document.querySelector(`${r} .st-kb-result`)?.dataset.result === 'ok', row);
      assert.match(await page.textContent(`${row} .st-kb-result`), /around 24, hard around 98/);
      await page.locator('.st-kbs').scrollIntoViewIfNeeded();
      await page.locator('.st-kbs').screenshot({ path: path.join(SHOTS, `${mode}-keyboards-fit.png`) });
      await page.click(`${row} .st-kb-use`);
      await until(() => !!window.__rig.store.get().settings.keyboards?.['@computer']?.touch);
      const t = await ev(() => window.__rig.store.get().settings.keyboards['@computer'].touch);
      assert.equal(t.top, 98);
      assert.ok(t.shape < 1, `a light touch fits a lighter curve (${t.shape})`);
      await until((r) => /Own touch/.test(document.querySelector(`${r} .st-kb-sum`).textContent), row);
      // played notes now carry the curve; the velocity is raw (the Touch setting no longer applies to these keys)
      const call = await ev(() => {
        const e = window.__rig.engine;
        const orig = e.noteOn;
        let got = null;
        e.noteOn = function (...a) {
          got = [a[1], !!(a[2] && a[2].touch)];
          return orig.apply(this, a);
        };
        window.__rig.controller.perform.noteOn(72, 40);
        window.__rig.controller.perform.noteOff(72);
        e.noteOn = orig;
        return got;
      });
      assert.deepEqual(call, [40, true]);
      // a slider edit writes the whole curve; Back to standard removes it
      await ev((r) => {
        const i = document.querySelector(`${r} input[data-touch="min"]`);
        i.value = '0.2';
        i.dispatchEvent(new Event('input', { bubbles: true }));
      }, row);
      await until(() => window.__rig.store.get().settings.keyboards['@computer'].touch.min === 0.2);
      await page.click(`${row} .st-kb-std`);
      await until(() => !('keyboards' in window.__rig.store.get().settings));
      // a saved MIDI keyboard that is not plugged in: Remember toggles, Forget drops it
      await ev(() => window.__rig.store.setKeyboard('Test Board 61', { remember: true }));
      const tb = '.st-kbs [data-keyboard="Test Board 61"]';
      await until((r) => !!document.querySelector(r), tb);
      assert.match(await page.textContent(`${tb} .st-kb-state`), /not connected/);
      assert.equal(await page.getAttribute(`${tb} .st-kb-remember`, 'aria-pressed'), 'true');
      assert.deepEqual(await ev(() => window.__rig.midi.remembered), ['Test Board 61']);
      await page.click(`${tb} .st-kb-forget`);
      await until((r) => !document.querySelector(r), tb);
      assert.deepEqual(await ev(() => window.__rig.midi.remembered), []);
      await page.click(`${row} .st-kb-touch`); // close the editor again
    });

    await T('settings: MIDI Learn refuses the sustain pedal with a plain message', async () => {
      await page.click('tr[data-control="slots.0.gain"] .st-learn');
      await until(() => window.__rig.midi.learning === 'slots.0.gain');
      await ev(() => window.__rig.midi._inject([0xb0, 64, 127]));
      await until(() => /sustain pedal/i.test(document.querySelector('tr[data-control="slots.0.gain"] .st-map').textContent));
      assert.equal(await ev(() => window.__rig.store.get().settings.midiLearn['slots.0.gain'] ?? null), null);
      await ev(() => window.__rig.midi._inject([0xb0, 64, 0]));
      if (await ev(() => window.__rig.midi.learning)) await ev(() => window.__rig.controller.cancelLearn?.());
    });

    await T('settings: pads-restored hides Reconnect', async () => {
      await ev(() => window.__rig.store.set('settings.padFolder', { kind: 'fsa', name: 'Test Pads' }));
      await until(() => /Test Pads/.test(document.querySelector('.st-pad-info').textContent) && !!document.querySelector('.st-pads-reload'));
      await ev(() => window.__rig.controller.dispatchEvent(new CustomEvent('pads-restored', { detail: { count: 3, total: 4, unmatched: ['x.wav'], name: 'Test Pads' } })));
      await until(() => !document.querySelector('.st-pads-reload') && /3 of 4 pad files/.test(document.querySelector('.st-pad-status').textContent));
      await ev(() => window.__rig.store.set('settings.padFolder', null));
    });

    await T('settings: Import latest backup (confirm → controller.importLatestBackup) when disk backups exist', async () => {
      const hadRig = await ev(() => !!window.rig);
      if (hadRig) {
        note(mode, 'window.rig present — backup import stub test skipped');
        return;
      }
      await ev(() => {
        window.rig = { latestBackup: async () => null };
        const c = window.__rig.controller;
        window.__restoreCalls = 0;
        window.__origImport = c.importLatestBackup;
        c.importLatestBackup = async () => {
          window.__restoreCalls += 1;
          return { ok: true, songIds: ['a', 'b'] };
        };
      });
      await page.click('.st-close');
      await openSettings();
      await page.click('.st-import-backup');
      assert.match(await page.textContent('.st-restore-q'), /Replace your whole library/);
      assert.equal(await ev(() => window.__restoreCalls), 0, 'nothing happens before confirm');
      await page.click('.st-import-backup-confirm');
      await until(() => window.__restoreCalls === 1 && !!document.querySelector('.st-import-backup'));
      await ev(() => {
        delete window.rig;
        window.__rig.controller.importLatestBackup = window.__origImport;
      });
      await page.click('.st-close');
      await openSettings();
      assert.equal(await page.$('.st-import-backup'), null, 'hidden in Chrome (no disk backups)');
    });

    await T('settings: My Samples panel (folder, real rescan → live reload or Reload prompt) + GarageBand guide link', async () => {
      await until((d) => (document.querySelector('.st-samples-path')?.textContent || '').includes(d), userSamplesDir);
      assert.equal(await page.getAttribute('.st-doc-link', 'href'), 'docs/garageband-import.md');
      assert.match(await page.textContent('.st-howto'), /import-garageband\.mjs --import/);
      await ev(() => {
        window.__instEvents = 0;
        window.addEventListener('rig-instruments-changed', () => (window.__instEvents += 1));
      });
      await page.click('.st-samples-rescan');
      await until(() => window.__instEvents === 1 || !!document.querySelector('.st-samples-reload'));
      if (await page.$('.st-samples-reload')) note(mode, 'rescan could not reload live (engine.reloadManifests missing?) — Settings shows Reload');
      assert.match(await page.textContent('.st-samples-status'), /sample instrument|Reload|restart/i);
    });

    await T('settings: diagnostics + Esc closes without Panic', async () => {
      await sleep(1100);
      const stats = await page.textContent('.st-stats');
      assert.match(stats, /Decoded samples: [\d.]+ MB( \([\d.]+ MB kept loaded\))?( · [^·]+)? · Voices: \d+/); // morning-prep: pinned MB, note
      await ev(() => window.__rig.controller.perform.noteOn(62, 100));
      await page.keyboard.press('Escape');
      await until(() => document.getElementById('view-settings').hidden);
      assert.ok(await ev(() => window.__rig.controller._debug().held.some(([n]) => n === 62)), 'Esc must not panic while Settings is open');
      await ev(() => window.__rig.controller.perform.noteOff(62));
    });

    await T('settings: MIDI "pending" = starting (answer the prompt, no reload); "denied" → site settings; "failed" → replug (polish-2A)', async () => {
      await openSettings();
      const texts = await ev(async () => {
        const c = window.__rig.controller;
        const real = { ...c.status };
        // CI-1: Settings renders a status event synchronously, so read the line in the same task as the fake event.
        // The old 50 ms wait let a real status event (latency updates, MIDI 'denied' on the device-less macos-14
        // runner) repaint the line first: "pending" read back as "MIDI was blocked…".
        const read = (midi) => {
          c.dispatchEvent(new CustomEvent('status', { detail: { ...real, midi: { available: false, connected: false, inputs: [], ...midi } } }));
          return document.querySelector('.st-midi-input').parentElement.querySelector('.st-status').textContent;
        };
        const out = {
          pending: read({ reason: 'pending', pending: true }),
          denied: read({ reason: 'denied', pending: false }),
          failed: read({ reason: 'failed', pending: false }),
        };
        c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status } }));
        return out;
      });
      assert.equal(texts.pending, 'MIDI starting… answer the browser’s permission prompt if it appears.');
      assert.doesNotMatch(texts.pending, /reload|blocked|isn’t available/i);
      assert.equal(texts.denied, 'MIDI was blocked — allow it in the browser’s site settings.');
      assert.match(texts.failed, /unplug and replug the keyboard/);
      await page.click('.st-close');
      await until(() => document.getElementById('view-settings').hidden);
    });

    // critics-fix (reviews/onboarding.md O5, O9; local hardware pass "pedal wording")
    await T('settings: critics-fix O5/O9 — no-keyboard line names the computer keys; full key map; raw path and the '
      + 'resource line tucked away; "modes" defined; pedal tip', async () => {
      await openSettings();
      const r = await ev(async () => {
        const c = window.__rig.controller;
        const real = { ...c.status };
        // CI-1: read in the same task as the fake event (see the "pending" test above)
        c.dispatchEvent(new CustomEvent('status', { detail: { ...real, midi: { available: true, connected: false, inputs: [] } } }));
        const midiLine = document.querySelector('.st-midi-input').parentElement.querySelector('.st-status').textContent;
        c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status } }));
        const kb = [...document.querySelectorAll('#view-settings section[aria-label="Computer keyboard"] *')]
          .map((x) => x.textContent).join(' ');
        const path = document.querySelector('.st-samples-path');
        const res = document.querySelector('[data-testid="setting-mb-resource"]');
        const mb = document.querySelector('[data-testid="settings-menubar"]');
        return {
          midiLine, kb,
          pathInHowto: !path || !!path.closest('details.st-howto'),
          resInDiag: !!res && !!res.closest('details.st-diag') && !mb.contains(res),
          mbText: mb.textContent,
          pedal: document.querySelector('.st-pedal').textContent,
        };
      });
      assert.equal(r.midiLine, 'No keyboard connected — plug one in (it connects by itself), or play the computer keys A–;.');
      assert.match(r.kb, /A W S E D F T G Y H U J K O L P ; = notes from middle C/);
      assert.match(r.kb, /←\/→ = previous \/ next song/);
      assert.ok(r.pathInHowto, 'the raw My Samples folder path sits inside the GarageBand disclosure');
      assert.ok(r.resInDiag, 'the low-resource debug line is under Diagnostics, not in the Menu bar section');
      assert.match(r.mbText, /Menu-bar songs/);
      assert.match(r.mbText, /“modes”/);
      assert.doesNotMatch(r.mbText, /Low-resource: (on|off) ·/);
      assert.match(r.pedal, /with your foot off the pedal/);
      await page.click('.st-close');
      await until(() => document.getElementById('view-settings').hidden);
    });

    // hardware-fixes (hardware pass: Bluetooth 176 ms vs 20 ms on the dock): > 60 ms output latency → one-line hint
    // under Latency, dismissed per output device NAME. The fake status is re-sent on every poll, so a real status
    // event in between can't make it flaky; enumerateDevices is faked to give the default output a Bluetooth label.
    await T('settings: output latency > 60 ms shows the Bluetooth hint; × dismisses it for that device name only',
      async () => {
        await openSettings();
        try {
          await ev(() => {
            const md = navigator.mediaDevices;
            window.__fakeOut = 'JBL Charge 5 (Bluetooth)';
            md.enumerateDevices = async () => [
              { kind: 'audiooutput', deviceId: 'default', label: `Default - ${window.__fakeOut}`, groupId: 'g' },
            ];
            localStorage.removeItem('worship-rig.latency-hint.dismissed');
            const c = window.__rig.controller;
            // CI-1: pin the fake latency onto every status event, real ones included. Re-sending it on each poll
            // isn't enough: a real event (watchdog stall/restart on a slow, device-less runner) landing between a
            // poll and the next read or the × click repaints the real latency and hides the hint.
            window.__pinLat = null;
            c.dispatchEvent = (e) => {
              if (window.__pinLat !== null && e.type === 'status' && e.detail) e.detail.latencyMs = window.__pinLat;
              return EventTarget.prototype.dispatchEvent.call(c, e);
            };
            window.__fakeLat = (ms) => {
              window.__pinLat = ms;
              c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status, latencyMs: ms } }));
            };
          });
          const hint = '[data-testid="settings-latency-hint"]';
          const shownAt = (ms) => until(([m, sel]) => {
            window.__fakeLat(m);
            const el = document.querySelector(sel);
            return el && !el.hidden;
          }, [ms, hint]);
          const hiddenAt = (ms) => until(([m, sel]) => {
            window.__fakeLat(m);
            return document.querySelector(sel).hidden;
          }, [ms, hint]);
          await shownAt(176);
          assert.equal(await page.textContent(`${hint} .lh-text`),
            'Bluetooth output adds ~176 ms — use the headphone jack or a dock for live playing');
          assert.match(await ev(() => document.querySelector('.st-status.warn')?.textContent || ''), /176 ms — high/);
          const box = await ev((sel) => {
            const t = document.querySelector(`${sel} .lh-text`);
            return { clipped: t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1,
              lines: Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight)) };
          }, hint);
          // Settings' column is narrower than the sentence: it wraps (≤ 2 lines) instead of ellipsizing
          assert.ok(!box.clipped && box.lines <= 2, `the whole sentence shows in Settings (${JSON.stringify(box)})`);
          await hiddenAt(20); // the dock
          await hiddenAt(60); // "exceeds 60 ms"
          await shownAt(61);
          await page.click(`${hint} .lh-x`);
          await hiddenAt(176);
          assert.deepEqual(await ev(() => JSON.parse(localStorage.getItem('worship-rig.latency-hint.dismissed'))),
            ['JBL Charge 5 (Bluetooth)']);
          // another Bluetooth device (a new name) warns again
          await ev(() => {
            window.__fakeOut = 'AirPods';
            navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
          });
          await shownAt(176);
        } catch (err) {
          console.log(`      (latency hint) ${err && err.message}`);
          throw err;
        } finally {
          await ev(() => {
            delete navigator.mediaDevices.enumerateDevices; // back to MediaDevices.prototype's
            localStorage.removeItem('worship-rig.latency-hint.dismissed');
            const c = window.__rig.controller;
            delete c.dispatchEvent; // back to EventTarget.prototype's (CI-1 pin)
            window.__pinLat = null;
            c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status } }));
          });
          if (await ev(() => !document.getElementById('view-settings').hidden)) await page.click('.st-close');
          await until(() => document.getElementById('view-settings').hidden);
        }
      });

    // C7 menubar-B (docs/menubar-mode.md): the "Menu bar" section
    await T('settings: Menu bar — mode toggle, set picker → modes, low-resource → controller + engine, resource line', async () => {
      await openSettings();
      const sec = page.locator('[data-testid="settings-menubar"]');
      await sec.scrollIntoViewIfNeeded();
      assert.equal(await sec.locator('h2').textContent(), 'Menu bar');
      // menu-bar mode (persisted; Electron main gets it via rig.setMenuBarMode from main.js)
      await page.click('[data-testid="setting-mb-mode"]');
      await until(() => window.__rig.store.get().settings.menuBarMode === true);
      await page.click('[data-testid="setting-mb-mode"]');
      await until(() => window.__rig.store.get().settings.menuBarMode === false);
      // set picker: a new setlist shows up at once; choosing it sets settings.menuBarSetlistId and the modes line
      const setId = await ev(() => window.__rig.store.addSetlist('Menu bar set', window.__rig.store.get().songOrder.slice(0, 4)));
      await until((id) => !!document.querySelector(`[data-testid="setting-mb-set"] option[value="${id}"]`), setId);
      await page.selectOption('[data-testid="setting-mb-set"]', setId);
      await until((id) => window.__rig.store.get().settings.menuBarSetlistId === id, setId);
      const names = await ev(() => (window.__rig.controller.modes?.list?.() || []).map((m) => m.name));
      if (names.length) {
        assert.equal(names.length, 4, 'controller lists the 4 songs of the set');
        await until((t) => document.querySelector('[data-testid="setting-mb-modes"]').textContent === t, `Modes: ${names.join(' · ')}`);
      } else note(mode, 'controller.modes.list missing — modes line computed in settings.js');
      await page.selectOption('[data-testid="setting-mb-set"]', '');
      await until(() => window.__rig.store.get().settings.menuBarSetlistId === null);
      // low-resource: the controller and engine follow; the resource line reads the engine's stats every second
      await page.click('[data-testid="setting-mb-lowres"]');
      await until(() => window.__rig.store.get().settings.lowResource === true && window.__rig.controller.status.lowResource === true);
      await until(() => window.__rig.engine._debugStats().lowResource === true);
      await until(() => /^Low-resource: on/.test(document.querySelector('[data-testid="setting-mb-resource"]').textContent)
        && /level taps 0/.test(document.querySelector('[data-testid="setting-mb-resource"]').textContent), null, 8000);
      if (mode === 'app') await until(() => document.documentElement.hasAttribute('data-low-resource'));
      await sec.scrollIntoViewIfNeeded();
      await ev(() => {
        for (const t of document.querySelectorAll('#toasts > *')) t.remove();
        document.activeElement?.blur?.();
      });
      await sleep(200);
      await sec.screenshot({ path: path.join(SHOTS, `${mode}-menubar.png`) });
      await page.click('[data-testid="setting-mb-lowres"]');
      await until(() => window.__rig.controller.status.lowResource === false && window.__rig.engine._debugStats().lowResource === false);
      await until(() => /^Low-resource: off/.test(document.querySelector('[data-testid="setting-mb-resource"]').textContent), null, 3000);
      if (mode === 'app') await until(() => !document.documentElement.hasAttribute('data-low-resource'));
      // open at login: Mac app only (window.rig.setLoginItem); in Chrome a hint instead of the switch
      const hasLogin = await ev(() => typeof window.rig?.setLoginItem === 'function');
      assert.equal(await page.$('[data-testid="setting-mb-login"]') !== null, hasLogin);
      if (!hasLogin) assert.match(await page.textContent('.st-mb-login-hint'), /Mac app/);
      // Chrome: "Open mini panel" opens app/mini.html in a 320×440 popup (the BroadcastChannel transport)
      assert.ok(await page.$('[data-testid="setting-mb-open-mini"]'), 'mini panel button in Chrome');
      if (mode === 'app') {
        const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('[data-testid="setting-mb-open-mini"]')]);
        await popup.waitForLoadState();
        assert.match(popup.url(), /\/mini\.html$/);
        await popup.waitForFunction(() => document.getElementById('mini')?.dataset.state === 'live', null, { timeout: 10000 });
        await popup.close();
      }
      await ev((id) => window.__rig.store.deleteSetlist(id), setId);
      await page.click('.st-close');
      await until(() => document.getElementById('view-settings').hidden);
    });

    // v11-metronome: Click output (outputs 3–4 only on a 4+ channel device), Record the click, MIDI clock out. The
    // clock goes to a fake Web MIDI output (no MIDI devices here): its timestamps give the scheduling jitter.
    await T('settings: v11-metronome — Click output / Record the click → engine; MIDI clock out → timed clock, '
      + 'Start / Stop', async () => {
      await openSettings();
      const out = '[data-testid="setting-click-output"]';
      await page.locator(out).scrollIntoViewIfNeeded();
      assert.equal(await page.getAttribute(`${out} button[data-value="main"]`, 'aria-checked'), 'true');
      const aux = await ev(() => window.__rig.engine.clickOutputs());
      // headless Chromium's output has 2 channels: Outputs 3–4 is offered but disabled, and the hint says why
      assert.equal(await page.isDisabled(`${out} button[data-value="aux"]`), !aux.aux);
      assert.match(await page.textContent('[data-testid="setting-click-output-hint"]'),
        aux.aux ? /Outputs 3–4 sends the click there only/ : /needs an audio interface with 4 or more outputs/);
      await page.click('[data-testid="setting-click-record"]');
      await until(() => window.__rig.store.get().settings.click?.record === true
        && window.__rig.engine.clickState().record === true);
      await page.click('[data-testid="setting-click-record"]');
      await until(() => !window.__rig.store.get().settings.click && window.__rig.engine.clickState().record === false);
      // MIDI clock out: a fake output appears in the list; choosing it attaches the clock sink
      await ev(() => {
        const sent = [];
        const port = {
          id: 'fake-clock', name: 'Fake Clock Out', type: 'output', state: 'connected',
          send: (data, ts) => sent.push({ b: data[0], ts, at: performance.now() }),
        };
        const m = window.__rig.midi;
        window.__clock = { sent, prev: m.access };
        m.access = { inputs: m.access?.inputs || new Map(), outputs: new Map([[port.id, port]]) };
        m._emitDevices();
      });
      const sel = '[data-testid="setting-midi-clock"]';
      await until((s) => !!document.querySelector(`${s} option[value="Fake Clock Out"]`), sel);
      assert.equal(await page.inputValue(sel), '', 'off by default');
      await page.selectOption(sel, 'Fake Clock Out');
      await until(() => window.__rig.controller.status.click.midiClockConnected === true);
      await page.click('.st-close');
      await until(() => document.getElementById('view-settings').hidden);
      // run the click 4 s at 120 BPM: Start before the first clock, 24 per beat, Stop at the end
      const orig = await ev(() => window.__rig.store.currentSong().tempo);
      await ev(() => window.__rig.store.set('song.tempo', 120));
      await until(() => window.__rig.engine.tempo === 120);
      await ev(() => window.__rig.controller.startClick());
      await sleep(4000);
      await ev(() => window.__rig.controller.stopClick());
      await sleep(300);
      const r = await ev(() => {
        const s = window.__clock.sent;
        const clocks = s.filter((x) => x.b === 0xf8);
        const ideal = 60000 / 120 / 24;
        // gaps between pulses that were both sent ahead of time (a main-thread stall longer than the 300 ms
        // look-ahead makes a pump late on this loaded box: those pulses go out at once and are counted as late)
        const onTime = (x) => x.ts > x.at;
        const dev = [];
        for (let i = 1; i < clocks.length; i++) {
          if (onTime(clocks[i]) && onTime(clocks[i - 1])) dev.push(clocks[i].ts - clocks[i - 1].ts - ideal);
        }
        const leads = s.map((x) => x.ts - x.at);
        return {
          outliers: dev.filter((d) => Math.abs(d) > 1).length,
          n: clocks.length, first: s[0]?.b, last: s.at(-1)?.b, starts: s.filter((x) => x.b === 0xfa).length,
          maxDevMs: Math.max(...dev.map(Math.abs)), rmsDevMs: Math.sqrt(dev.reduce((a, d) => a + d * d, 0) / dev.length),
          minLeadMs: Math.min(...leads), maxLeadMs: Math.max(...leads),
          stats: window.__rig.controller.midiClockStats(),
        };
      });
      note(mode, `MIDI clock (fake output, 120 BPM, ${r.n} pulses): timestamp jitter max ${r.maxDevMs.toFixed(3)} ms, `
        + `rms ${r.rmsDevMs.toFixed(3)} ms; sent ${r.minLeadMs.toFixed(1)}–${r.maxLeadMs.toFixed(1)} ms ahead; `
        + `late ${r.stats.late}, anchor resets ${r.stats.resets}`);
      assert.equal(r.first, 0xfa, 'Start first (no count-in: the first click is the downbeat)');
      assert.equal(r.starts, 1);
      assert.equal(r.last, 0xfc, 'Stop last');
      assert.ok(r.n > 150 && r.n < 220, `≈ 4 s × 48 pulses/s (${r.n})`);
      // on the grid; an audio-thread glitch (headless Chromium skips render quanta under load) moves the audio clock
      // against performance.now(), the map re-anchors (ClockMap resetMs) and that one gap is off by the glitch
      assert.ok(r.outliers <= 2 * (r.stats.resets - 1), `pulse timestamps on the grid (${JSON.stringify(r)})`);
      if (r.stats.resets === 1) assert.ok(r.maxDevMs < 1, `max ${r.maxDevMs} ms`);
      assert.ok(r.stats.late <= r.n * 0.05, `at most a stall's worth of late pulses (${r.stats.late})`);
      if (r.stats.late === 0) assert.ok(r.minLeadMs > 0, `every message is sent ahead of its time (${r.minLeadMs} ms)`);
      // off again: the sink is detached, nothing more is sent
      await ev(() => window.__rig.store.set('settings.midiClockOut', null));
      await until(() => window.__rig.controller.status.click.midiClock === null);
      await ev((t) => {
        window.__rig.store.set('song.tempo', t);
        window.__rig.midi.access = window.__clock.prev;
        window.__rig.midi._emitDevices();
      }, orig);
    });

    // polish-1: the retired Edit's .ed-* rules are pruned; what remains is exactly what settings.js renders
    if (mode === 'app') {
      await T('settings: styles-settings.css keeps only the .ed-* classes Settings renders (polish-1)', async () => {
        await openSettings();
        const r = await ev(() => {
          const sheet = [...document.styleSheets].find((s) => /styles-settings\.css/.test(s.href || ''));
          const cls = new Set();
          const walk = (rules) => {
            for (const x of rules) {
              if (x.selectorText) for (const m of x.selectorText.matchAll(/\.(ed(?:-[\w-]+)?)\b/g)) cls.add(m[1]);
              else if (x.cssRules) walk(x.cssRules);
            }
          };
          walk(sheet.cssRules);
          const btn = document.querySelector('#view-settings button.ed-btn');
          return { cls: [...cls].sort(), btn: !!btn, btnH: btn ? parseFloat(getComputedStyle(btn).minHeight) : 0,
            select: !!document.querySelector('#view-settings select.ed-select') };
        });
        assert.deepEqual(r.cls, ['ed-btn', 'ed-danger', 'ed-select'], 'only the classes settings.js uses');
        assert.ok(r.btn && r.select, 'Settings renders .ed-btn and .ed-select');
        assert.ok(r.btnH >= 30, `an .ed-btn keeps its styling (min-height ${r.btnH})`);
        await page.click('.st-close');
        await until(() => document.getElementById('view-settings').hidden);
      });
    }

  } finally {
    await T('zero console.error', async () => {
      assert.deepEqual(errors, []);
    });
    await context.close();
    await server.close();
  }
}

// -----------------------------------------------------------------------------------------------------------
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  for (const m of MODES) {
    if (m === 'mac') await runMac({ browser, createServer, ROOT, SHOTS, results });
    else await runMode(m, browser);
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
if (notes.length) console.log(`\nnotes (not failures):\n  ${notes.join('\n  ')}`);
console.log(`\nsettings: ${results.length - failed.length}/${results.length} passed (modes: ${MODES.join(', ')})`);
process.exit(failed.length ? 1 : 0);
