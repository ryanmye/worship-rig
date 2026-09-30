#!/usr/bin/env node
// Settings Playwright suite (views/settings.js), moved out of the retired ui-edit suite (hv2-edit-integrate).
//   node test/phase2/settings/run.mjs            → both modes
//   SETTINGS_MODES=app|fixture node …            → one mode
// Modes:
//   app     — the real app (app/index.html + main.js: Perform, the H-v2 Edit and Settings) served by server.js at "/".
//             The page switches to Edit first, so Settings is tested over the new Edit view (Esc ownership, focus).
//   fixture — test/phase2/settings/fixture.html: a minimal bootstrap that mounts ONLY Settings with the FALLBACK
//             component set (exercises views/_fallback-components.js).
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

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const APP = path.join(ROOT, 'app');
const SHOTS = path.join(HERE, 'screenshots');
const { createServer } = require(path.join(ROOT, 'server.js'));

const haveApp = fs.existsSync(path.join(APP, 'index.html')) && fs.existsSync(path.join(APP, 'js', 'main.js')) &&
  /mountSettings/.test(fs.readFileSync(path.join(APP, 'js', 'main.js'), 'utf8'));
const MODES = (process.env.SETTINGS_MODES || (haveApp ? 'app,fixture' : 'fixture')).split(',').map((s) => s.trim()).filter(Boolean);
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
        const read = async (midi) => {
          c.dispatchEvent(new CustomEvent('status', { detail: { ...real, midi: { available: false, connected: false, inputs: [], ...midi } } }));
          await new Promise((res) => setTimeout(res, 50));
          return document.querySelector('.st-midi-input').parentElement.querySelector('.st-status').textContent;
        };
        const out = {
          pending: await read({ reason: 'pending', pending: true }),
          denied: await read({ reason: 'denied', pending: false }),
          failed: await read({ reason: 'failed', pending: false }),
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
        c.dispatchEvent(new CustomEvent('status', { detail: { ...real, midi: { available: true, connected: false, inputs: [] } } }));
        await new Promise((res) => setTimeout(res, 50));
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
            window.__fakeLat = (ms) => c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status, latencyMs: ms } }));
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

    // polish-1: the retired Edit's .ed-* rules are pruned; what remains is exactly what settings.js renders
    if (mode === 'app') {
      await T('settings: styles-edit.css keeps only the .ed-* classes Settings renders (polish-1 prune)', async () => {
        await openSettings();
        const r = await ev(() => {
          const sheet = [...document.styleSheets].find((s) => /styles-edit\.css/.test(s.href || ''));
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
  for (const m of MODES) await runMode(m, browser);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
if (notes.length) console.log(`\nnotes (not failures):\n  ${notes.join('\n  ')}`);
console.log(`\nsettings: ${results.length - failed.length}/${results.length} passed (modes: ${MODES.join(', ')})`);
process.exit(failed.length ? 1 : 0);
