#!/usr/bin/env node
// Settings Playwright suite (views/settings.js), moved out of the retired ui-edit suite (hv2-edit-integrate).
//   node test/phase2/settings/run.mjs            → both modes
//   SETTINGS_MODES=app|fixture|mac|bridge node … → one mode
// Modes:
//   app     — the real app (app/index.html + main.js: Perform, the H-v2 Edit and Settings) served by server.js at "/".
//             The page switches to Edit first, so Settings is tested over the new Edit view (Esc ownership, focus).
//   fixture — test/phase2/settings/fixture.html: a minimal bootstrap that mounts ONLY Settings with the FALLBACK
//             component set (exercises views/_fallback-components.js).
//   mac     — the fixture with a fake window.rig (v11-electron, mac.mjs): global shortcuts and the update line, which
//             only exist in the Mac app. Its own tests only.
//   bridge  — the fixture on the 2.0 BridgeEngine over MockNative (sound2.mjs): Settings › Sound's voices, buffer
//             size and voice limit reaching the engine as config / audio messages. Its own tests only.
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
import { runBridge } from './sound2.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const APP = path.join(ROOT, 'app');
const SHOTS = path.join(HERE, 'screenshots');
const { createServer } = require(path.join(ROOT, 'server.js'));

const haveApp = fs.existsSync(path.join(APP, 'index.html')) && fs.existsSync(path.join(APP, 'js', 'main.js')) &&
  /mountSettings/.test(fs.readFileSync(path.join(APP, 'js', 'main.js'), 'utf8'));
const ALL_MODES = haveApp ? 'app,fixture,mac,bridge' : 'fixture,mac,bridge';
const MODES = (process.env.SETTINGS_MODES || ALL_MODES).split(',').map((s) => s.trim()).filter(Boolean);
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
    // 2.0 restructure: one category at a time, so a control is clickable only once its category is on show
    const cat = async (id) => {
      await page.click(`#view-settings [role=tab][data-cat="${id}"]`);
      await until((c) => !document.querySelector(`#view-settings [role=tabpanel][data-cat="${c}"]`).hidden, id);
    };
    /** Show a category and open its "Advanced" disclosure (the rarely used rows). */
    const adv = async (id) => {
      await cat(id);
      const d = `#view-settings [data-testid="settings-advanced-${id}"]`;
      if ((await page.getAttribute(d, 'open')) === null) await page.click(`${d} > summary`);
      await until((sel) => document.querySelector(sel).open, d);
    };
    const closeSettings = async () => {
      await page.click('.st-close');
      await until(() => document.getElementById('view-settings').hidden);
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
      await cat('sound');
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
      await adv('sound'); // Mono output is a Sound › Advanced row
      await page.click('[data-bind="settings.monoOutput"]');
      await until(() => window.__rig.store.get().settings.monoOutput === true && window.__rig.engine._monoOut === true);
      await page.click('[data-bind="settings.monoOutput"]');
      await until(() => window.__rig.store.get().settings.monoOutput === false && window.__rig.engine._monoOut === false);
      await adv('keyboards'); // Song buttons (program change) is a Keyboards & MIDI › Advanced row
      await page.click('[data-bind="settings.velocitySens"] button[data-value="soft"]');
      await until(() => window.__rig.store.get().settings.velocitySens === 'soft');
      await page.click('[data-bind="settings.velocitySens"] button[data-value="normal"]');
      await page.click('[data-bind="settings.programChange"]');
      // Lane S (D6) + O-AW-3: turning PC on writes 'cue' (absent with PC on = the 1.x 'switch'); both actions are
      // stored explicitly; a channel is an explicit choice, Any = absent
      await until(() => window.__rig.store.get().settings.programChange === true
        && window.__rig.store.get().settings.programChangeAction === 'cue');
      assert.equal(await page.getAttribute('[data-testid="setting-pc-action"] button[data-value="cue"]',
        'aria-checked'), 'true');
      await page.click('[data-testid="setting-pc-action"] button[data-value="switch"]');
      await until(() => window.__rig.store.get().settings.programChangeAction === 'switch');
      await page.click('[data-testid="setting-pc-action"] button[data-value="cue"]');
      await until(() => window.__rig.store.get().settings.programChangeAction === 'cue');
      await page.selectOption('[data-testid="setting-pc-channel"]', '15');
      await until(() => window.__rig.store.get().settings.programChangeChannel === 15);
      await page.selectOption('[data-testid="setting-pc-channel"]', '');
      await until(() => !('programChangeChannel' in window.__rig.store.get().settings));
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
      await cat('keyboards');
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

    await T('settings: MIDI Learn lists a level row per slot of the current song (UIC, UIA review O1)', async () => {
      await cat('keyboards');
      const rowIds = () => ev(() => [...document.querySelectorAll('.st-learn-table tbody tr')]
        .map((r) => r.dataset.control));
      const before = await rowIds();
      assert.equal(before.length, 17, 'a 4-slot song: the 1.x rows + Lane S go / cueNext / cuePrev');
      assert.equal(before.filter((id) => /^slots\.\d+\.gain$/.test(id)).length, 4);
      // grow the song to 6 slots (Sound 5 and 6 copy a filled slot so a learned fader has something to move)
      const restore = () => ev(() => {
        const st = window.__rig.store;
        while (st.currentSong().patch.slots.length > 4) st.removeSlot();
        if (st.get().settings.midiLearn['slots.5.gain']) st.setMidiLearn('slots.5.gain', null);
        window.__rig.controller.cancelLearn?.();
      });
      try {
        await ev(() => {
          const st = window.__rig.store;
          const src = st.currentSong().patch.slots.find(Boolean);
          while (st.currentSong().patch.slots.length < 6) st.addSlot(undefined, structuredClone(src));
        });
        await until(() => !!document.querySelector('tr[data-control="slots.5.gain"]'));
        const grown = await rowIds();
        assert.equal(grown.length, 19);
        assert.deepEqual(grown.slice(0, 7), ['slots.0.gain', 'slots.1.gain', 'slots.2.gain', 'slots.3.gain',
          'slots.4.gain', 'slots.5.gain', 'drone.gain'], 'the levels stay together');
        assert.equal(await page.textContent('tr[data-control="slots.5.gain"] th'), 'Sound 6 level');
        const label = await page.getAttribute('tr[data-control="slots.5.gain"] .st-learn', 'aria-label');
        assert.equal(label, 'Learn Sound 6 level');
        // learn Sound 6 from the table and move it with the hardware fader (pickup: sweep up past the stored level)
        await page.click('tr[data-control="slots.5.gain"] .st-learn');
        await until(() => window.__rig.midi.learning === 'slots.5.gain');
        await ev(() => window.__rig.midi._inject([0xb0, 22, 64]));
        await until(() => window.__rig.store.get().settings.midiLearn['slots.5.gain']?.cc === 22);
        await until(() => document.querySelector('tr[data-control="slots.5.gain"] .st-map')
          .textContent === 'CC 22 · ch 1');
        await ev(async () => {
          for (let v = 0; v <= 127; v += 4) window.__rig.midi._inject([0xb0, 22, v]);
          window.__rig.midi._inject([0xb0, 22, 127]);
        });
        await until(() => Math.abs(window.__rig.store.currentSong().patch.slots[5].gain - 2) < 1e-9);
        // back to 4 slots: Sound 5 leaves the table, the mapped Sound 6 stays so it can still be cleared
        await ev(() => {
          const st = window.__rig.store;
          while (st.currentSong().patch.slots.length > 4) st.removeSlot();
        });
        await until(() => !document.querySelector('tr[data-control="slots.4.gain"]'));
        assert.ok(await page.$('tr[data-control="slots.5.gain"]'), 'a mapped level past the song stays listed');
        await page.click('tr[data-control="slots.5.gain"] .st-clear');
        await until(() => !window.__rig.store.get().settings.midiLearn['slots.5.gain']);
        await until(() => !document.querySelector('tr[data-control="slots.5.gain"]'));
        assert.deepEqual(await rowIds(), before, '4 slots again: the 1.x table');
      } finally {
        await restore(); // a failure here must not leave a 6-slot song for the later tests
      }
    });

    // 2.x step 5 (O-AW-ML): custom mappings (any continuous param) are listed under the fixed rows, with Remove
    await T('settings: MIDI Learn lists custom param knobs with Remove; re-learn keeps invert (O-AW-ML)', async () => {
      await cat('keyboards');
      const SEL = '.st-learn-custom tr[data-control="slots.1.sends.reverb"]';
      try {
        assert.equal(await ev(() => document.querySelectorAll('.st-learn-custom tr').length), 0, 'none: no group');
        await ev(() => window.__rig.store.setMidiLearn('slots.1.sends.reverb', { cc: 74, channel: 0, invert: true }));
        await until((s) => !!document.querySelector(s), SEL);
        assert.equal(await page.textContent(`${SEL} th`), 'Pad reverb send');
        assert.equal(await page.textContent(`${SEL} .st-map`), 'CC 74 · ch 1 · inverted');
        assert.equal(await page.textContent(`${SEL} .st-remove`), 'Remove');
        assert.match(await page.textContent('.st-learn-custom tr.st-learn-group'), /Parameter knobs/);
        // skeptic midi-learn-any: a picture of the custom row under the fixed ones
        await page.locator(SEL).scrollIntoViewIfNeeded();
        fs.mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: path.join(SHOTS, `${mode}-learn-custom.png`) });
        // the fixed table is unchanged (17 rows for a 4-slot song) and the custom row is not one of them
        assert.equal(await ev(() => document.querySelectorAll('.st-learn-table tbody:not(.st-learn-custom) tr')
          .length), 17);
        // re-learn from the row: the new CC keeps `invert`
        await page.click(`${SEL} .st-learn`);
        await until(() => window.__rig.midi.learning === 'slots.1.sends.reverb');
        await ev(() => window.__rig.midi._inject([0xb2, 75, 30]));
        await until(() => window.__rig.store.get().settings.midiLearn['slots.1.sends.reverb']?.cc === 75);
        assert.deepEqual(await ev(() => window.__rig.store.get().settings.midiLearn['slots.1.sends.reverb']),
          { cc: 75, channel: 2, invert: true });
        await until((s) => document.querySelector(`${s} .st-map`).textContent === 'CC 75 · ch 3 · inverted', SEL);
        // the knob moves the send (inverted: knob down = full send); pickup from the stored value
        await ev(() => window.__rig.store.set('slots.1.sends.reverb', 0.5));
        await ev(async () => {
          for (let v = 127; v >= 0; v -= 8) {
            window.__rig.midi._inject([0xb2, 75, v]);
            await new Promise((r) => setTimeout(r, 25));
          }
          window.__rig.midi._inject([0xb2, 75, 0]);
        });
        await until(() => Math.abs(window.__rig.store.currentSong().patch.slots[1].sends.reverb - 1) < 1e-9);
        await until(() => Math.abs(window.__rig.engine.getParam('slots.1.sends.reverb') - 1) < 1e-6);
        // Remove: the mapping and its row go, the group header too
        await page.click(`${SEL} .st-remove`);
        await until(() => !window.__rig.store.get().settings.midiLearn['slots.1.sends.reverb']);
        await until(() => !document.querySelector('.st-learn-custom tr'));
      } finally {
        await ev(() => {
          window.__rig.controller.cancelLearn?.();
          window.__rig.store.setMidiLearn('slots.1.sends.reverb', null);
        });
      }
    });

    // hardware-fixes: the test samples BOTH states (press → settle → release → settle) and decides from the pair
    const pedalStep = (step) => until((st) => !!document.querySelector(`.st-pedal-prompt[data-step="${st}"]`), step);
    const cc64 = (v) => ev((x) => window.__rig.midi._inject([0xb0, 64, x]), v);
    await T('settings: pedal polarity detector samples pressed + released, suggests invert and applies it', async () => {
      await cat('keyboards');
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
      await cat('keyboards');
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
      await cat('keyboards');
      await page.click('[data-bind="settings.velocitySens"] button[data-value="hard"]');
      await until(() => /play firmly/.test(document.querySelector('.st-vel-hint').textContent));
      await page.click('[data-bind="settings.velocitySens"] button[data-value="normal"]');
      await until(() => /harder you play, the louder/.test(document.querySelector('.st-vel-hint').textContent));
      await until(() => /"velocitySens":"normal"/.test(localStorage.getItem('rig.v1') || ''), null, 5000);
    });

    // v11-touch: Your keyboards — the on-screen keys row, the guided "play soft, then hard" fit (through the real
    // controller.captureTouch), the curve reaching engine.noteOn as {touch}, Back to standard, Remember / Forget
    await T('settings: Your keyboards — fit the on-screen keys to a soft/hard touch, use it, remember / forget', async () => {
      await cat('keyboards');
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
      assert.match(await page.textContent(`${row} .st-kb-result`), /play at about 15% and full volume/, 'FIT_SOFT_TARGET');
      // screenshot pass 2026-11-20: btn()'s {class} used to replace the tag's .ed-btn, leaving native grey buttons
      const unstyled = await ev((r) => [...document.querySelectorAll(`.st-kbs button`)]
        .filter((b) => !b.classList.contains('ed-btn')).map((b) => b.className), row);
      assert.deepEqual(unstyled, [], 'every Your keyboards button keeps .ed-btn');
      await page.locator('.st-kbs').scrollIntoViewIfNeeded();
      await page.locator('.st-kbs').screenshot({ path: path.join(SHOTS, `${mode}-keyboards-fit.png`) });
      await page.click(`${row} .st-kb-use`);
      await until(() => !!window.__rig.store.get().settings.keyboards?.['@computer']?.touch);
      const t = await ev(() => window.__rig.store.get().settings.keyboards['@computer'].touch);
      assert.equal(t.top, 98);
      // soft 24 of full-at-98 lands on FIT_SOFT_TARGET (0.15, Ryan Q5)
      assert.ok(Math.abs(Math.pow(24 / 98, t.shape) - 0.15) < 0.01, `soft notes land on 15 % (${t.shape})`);
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
      await cat('keyboards');
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
      await cat('library');
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

    await T('settings: Restore previous library… (D8) lists the kept copies; confirm keeps the current one, restores', async () => {
      const k = await ev(() => {
        const st = window.__rig.store;
        st.addSong(null, { name: 'D8 before' });
        const r = st.keepCurrent('downgrade'); // stands in for a 2.0 library 1.x set aside
        st.addSong(null, { name: 'D8 after' });
        return r.key;
      });
      assert.ok(k, 'kept');
      await page.click('.st-close');
      await openSettings();
      await cat('library');
      await page.click('.st-restore-previous');
      await until(() => document.querySelectorAll('.st-previous-row').length > 0);
      const row = page.locator(`.st-previous-row[data-key="${k}"]`);
      assert.match(await row.textContent(), /2\.0 library · .* · \d+ songs, \d+ setlists? · set aside/);
      await row.locator('.st-previous-restore').click();
      assert.match(await page.textContent('.st-previous .st-restore-q'), /Replace your whole library/);
      assert.equal(await ev(() => Object.values(window.__rig.store.get().songs).some((x) => x.name === 'D8 after')), true,
        'nothing happens before confirm');
      await page.click('.st-previous-confirm');
      await until(() => !Object.values(window.__rig.store.get().songs).some((x) => x.name === 'D8 after')
        && !!document.querySelector('.st-restore-previous'));
      const kinds = await ev(() => window.__rig.controller.listPreviousLibraries().map((e) => e.kind));
      assert.ok(kinds.includes('restore'), `the replaced library was kept first: ${kinds}`);
      // put the test's library back the same way (the newest 'restore' copy)
      const back = await ev(async () => {
        const c = window.__rig.controller;
        const r = c.listPreviousLibraries().find((e) => e.kind === 'restore');
        return (await c.restorePreviousLibrary(r.key)).ok;
      });
      assert.equal(back, true);
      assert.equal(await ev(() => Object.values(window.__rig.store.get().songs).some((x) => x.name === 'D8 after')), true);
    });

    await T('settings: My Samples panel (folder, real rescan → live reload or Reload prompt) + GarageBand guide link', async () => {
      await cat('samples');
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
        await cat('sound'); // the hint's box is measured below: its category must be on show
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
      await cat('look'); // Chrome has no Mac category: its Menu bar section closes Look
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
      await adv('sound'); // Record the click and Clock out are Sound › Advanced rows
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

    // ------------------------------------------------------------------------------------------ 2.0 restructure
    // native/docs/DECISIONS.md "Settings page restructure" + D1/D2/D4: sidebar categories, Advanced, deep links,
    // narrow strip, the remembered category, and the three 2.0 Sound settings (stored only on the web engine)
    const CHROME_TABS = ['Sound', 'Keyboards & MIDI', 'Sounds & Samples', 'Look', 'Library & Backup', 'About'];
    const shown = () => ev(() => window.__rig.views.settings.category);

    await T('2.0 settings: a sidebar tab list, one category at a time; every 1.x section lands in its category',
      async () => {
      await openSettings();
      const r = await ev(() => {
        const host = document.getElementById('view-settings');
        const tabs = [...host.querySelectorAll('[role=tablist] [role=tab]')];
        const panels = [...host.querySelectorAll('[role=tabpanel]')];
        const where = {};
        for (const sec of host.querySelectorAll('.st-section[aria-label]')) {
          where[sec.getAttribute('aria-label')] = sec.closest('[role=tabpanel]')?.dataset.cat ?? null;
        }
        const advRows = {};
        for (const d of host.querySelectorAll('details.st-adv')) {
          advRows[d.dataset.adv] = [...d.querySelectorAll('[data-bind]')].map((b) => b.dataset.bind);
        }
        const ids = ['setting-click-output', 'setting-click-output-hint', 'setting-click-record', 'setting-midi-clock',
          'setting-perform-chips', 'setting-theme', 'settings-appearance', 'settings-menubar', 'setting-mb-mode',
          'setting-mb-set', 'setting-mb-modes', 'setting-mb-lowres', 'setting-mb-resource', 'setting-mb-open-mini',
          'settings-latency-hint', 'setting-polyphony', 'setting-buffer-frames', 'setting-voice-limit',
          'settings-engine-note', 'setting-drone-freeze', 'setting-drone-freeze-note'];
        return {
          labels: tabs.map((t) => t.textContent),
          orientation: host.querySelector('[role=tablist]').getAttribute('aria-orientation'),
          visible: panels.filter((p) => !p.hidden).length,
          selected: tabs.filter((t) => t.getAttribute('aria-selected') === 'true').length,
          tabbable: tabs.filter((t) => t.tabIndex === 0).length,
          wired: tabs.every((t) => document.getElementById(t.getAttribute('aria-controls'))
            ?.getAttribute('aria-labelledby') === t.id),
          where, advRows,
          testids: Object.fromEntries(ids.map((id) => [id, host.querySelectorAll(`[data-testid="${id}"]`).length])),
        };
      });
      assert.deepEqual(r.labels, CHROME_TABS, 'no Mac category outside the Mac app');
      assert.equal(r.orientation, 'vertical');
      assert.deepEqual([r.visible, r.selected, r.tabbable, r.wired], [1, 1, 1, true]);
      assert.deepEqual(r.where, {
        Audio: 'sound', 'Voices and buffer': 'sound', Click: 'sound',
        MIDI: 'keyboards', 'Computer keyboard': 'keyboards', 'MIDI Learn': 'keyboards',
        'My Pads': 'samples', 'My Samples': 'samples',
        Appearance: 'look', 'Perform view': 'look', 'Menu bar': 'look',
        Library: 'library', About: 'about', Diagnostics: 'about',
      });
      assert.deepEqual(r.advRows, {
        sound: ['settings.monoOutput', 'settings.voiceLimit', 'settings.droneFreeze', 'settings.click.record',
          'settings.midiClockOut'],
        keyboards: ['settings.programChange', 'settings.programChangeAction', 'settings.programChangeChannel'],
      });
      for (const [id, n] of Object.entries(r.testids)) assert.equal(n, 1, `data-testid ${id} kept, once`);
      // each tab shows its own panel and hides the others
      for (const id of ['sound', 'keyboards', 'samples', 'look', 'library', 'about']) {
        await cat(id);
        const vis = await ev(() => [...document.querySelectorAll('#view-settings [role=tabpanel]')]
          .filter((p) => !p.hidden).map((p) => p.dataset.cat));
        assert.deepEqual(vis, [id]);
        assert.equal(await page.getAttribute(`[data-testid="settings-tab-${id}"]`, 'aria-selected'), 'true');
      }
      await closeSettings();
    });

    await T('2.0 settings: arrow keys move and select (wrapping, Home / End), focus is visible, the computer keyboard '
      + 'never sees them, Tab enters the panel', async () => {
      await openSettings();
      await cat('sound');
      await ev(() => {
        window.__arrowsSeen = 0;
        window.__arrowSpy = (e) => {
          if (/^Arrow|^Home$|^End$/.test(e.key)) window.__arrowsSeen += 1;
        };
        document.addEventListener('keydown', window.__arrowSpy); // where the controller listens (bubbling)
      });
      try {
        await page.focus('[data-testid="settings-tab-sound"]');
        const step = async (key, want) => {
          await page.keyboard.press(key);
          await until((c) => window.__rig.views.settings.category === c
            && document.activeElement?.dataset?.cat === c, want);
        };
        await step('ArrowDown', 'keyboards');
        const ring = await ev(() => {
          const t = document.activeElement;
          return { visible: t.matches(':focus-visible'), outline: getComputedStyle(t).outlineStyle,
            width: parseFloat(getComputedStyle(t).outlineWidth) };
        });
        assert.ok(ring.visible && ring.outline !== 'none' && ring.width >= 2,
          `visible focus (${JSON.stringify(ring)})`);
        await step('ArrowRight', 'samples');
        await step('ArrowUp', 'keyboards');
        await step('ArrowLeft', 'sound');
        await step('ArrowUp', 'about'); // wraps
        await step('Home', 'sound');
        await step('End', 'about');
        await step('ArrowDown', 'sound');
        assert.equal(await ev(() => window.__arrowsSeen), 0, 'arrows stay in the tab list (mod wheel / song keys)');
        assert.equal(await ev(() => window.__rig.store.get().settings.currentSongId), await ev(() =>
          window.__rig.controller.status.songId), 'no song change');
        const tabbables = await ev(() => [...document.querySelectorAll('#view-settings [role=tab]')]
          .filter((t) => t.tabIndex === 0).map((t) => t.dataset.cat));
        assert.deepEqual(tabbables, ['sound'], 'roving tabindex follows the selection');
        await page.keyboard.press('Tab');
        assert.equal(await ev(() => document.activeElement?.closest('[role=tabpanel]')?.dataset.cat), 'sound',
          'Tab goes from the tab list into the panel on show');
      } finally {
        await ev(() => document.removeEventListener('keydown', window.__arrowSpy));
      }
      await closeSettings();
    });

    await T('2.0 settings: deep links land on the right category (1.x names, aliases, while open, '
      + 'rig-open-settings)', async () => {
      const LINKS = [
        ['pads', 'samples', 'My Pads'], ['appearance', 'look', 'Appearance'], ['backups', 'library', 'Library'],
        ['midi', 'keyboards', 'MIDI'], ['theme', 'look', 'Appearance'], ['voices', 'sound', 'Voices and buffer'],
        ['learn', 'keyboards', 'MIDI Learn'], ['menubar', 'look', 'Menu bar'], ['mac', 'look', 'Menu bar'],
        ['diagnostics', 'about', null],
        ['library', 'library', null], ['about', 'about', null], // (About has nothing to focus in Chrome)
      ];
      for (const [section, want, label] of LINKS) {
        await ev((sec) => window.__rig.ctx.openSettings({ section: sec }), section);
        await until((c) => window.__rig.views.settings.isOpen && window.__rig.views.settings.category === c, want);
        if (label) {
          // focus lands in the named section (Quick › Theme focuses the checked card)
          await until((l) => document.activeElement?.closest('.st-section')?.getAttribute('aria-label') === l, label);
        }
        await closeSettings();
      }
      // while open: main.js (and the fixture) pass the section to the open view
      await ev(() => window.__rig.ctx.openSettings({ section: 'pads' }));
      await until(() => window.__rig.views.settings.category === 'samples');
      await ev(() => window.__rig.ctx.openSettings({ section: 'appearance' }));
      await until(() => window.__rig.views.settings.category === 'look'
        && document.activeElement?.getAttribute('role') === 'radio');
      // review: a section with nothing to focus (Diagnostics) reached while open hides the focused theme card;
      // focus stays in the dialog, on that category's tab, never on <body>
      await ev(() => window.__rig.ctx.openSettings({ section: 'diagnostics' }));
      await until(() => window.__rig.views.settings.category === 'about'
        && document.activeElement?.dataset?.testid === 'settings-tab-about');
      await closeSettings();
      if (mode === 'app') {
        // Quick › This Mac › Theme (quickSheet has no ctx) and perform.js's "pads" go through main.js
        await ev(() => document.dispatchEvent(new CustomEvent('rig-open-settings',
          { detail: { section: 'appearance' } })));
        await until(() => window.__rig.views.settings.isOpen && window.__rig.views.settings.category === 'look');
        await closeSettings();
      }
      // an unknown name opens where the viewer was last
      await ev(() => localStorage.setItem('worship-rig.settings.category', 'library'));
      await ev(() => window.__rig.ctx.openSettings({ section: 'no-such-thing' }));
      await until(() => window.__rig.views.settings.category === 'library');
      await closeSettings();
      // review: the voice limit is a Sound › Advanced row; its link opens Advanced and focuses the choice itself
      await ev(() => window.__rig.ctx.openSettings({ section: 'voice-limit' }));
      await until(() => window.__rig.views.settings.category === 'sound'
        && document.querySelector('#view-settings [data-testid="settings-advanced-sound"]').open
        && !!document.activeElement?.closest('[data-testid="setting-voice-limit"]'));
      await closeSettings();
    });

    await T('2.0 settings: the last category is remembered per viewer (localStorage); deep links don\'t overwrite it; '
      + 'blocked storage still opens', async () => {
      await openSettings();
      await cat('keyboards');
      assert.equal(await ev(() => localStorage.getItem('worship-rig.settings.category')), 'keyboards');
      await closeSettings();
      await openSettings();
      assert.equal(await shown(), 'keyboards');
      await closeSettings();
      await ev(() => window.__rig.ctx.openSettings({ section: 'pads' }));
      await until(() => window.__rig.views.settings.category === 'samples');
      await closeSettings();
      assert.equal(await ev(() => localStorage.getItem('worship-rig.settings.category')), 'keyboards');
      await openSettings();
      assert.equal(await shown(), 'keyboards');
      await closeSettings();
      // storage blocked (private window, site data off): getItem / setItem throw; Settings still opens and switches
      await ev(() => {
        window.__lsGet = Storage.prototype.getItem;
        window.__lsSet = Storage.prototype.setItem;
        Storage.prototype.getItem = function () { throw new DOMException('blocked', 'SecurityError'); };
        Storage.prototype.setItem = function () { throw new DOMException('blocked', 'SecurityError'); };
      });
      try {
        await openSettings();
        assert.equal(await shown(), 'sound', 'nothing remembered: the first category');
        await cat('about');
        assert.equal(await shown(), 'about');
        await closeSettings();
      } finally {
        await ev(() => {
          Storage.prototype.getItem = window.__lsGet;
          Storage.prototype.setItem = window.__lsSet;
        });
      }
      await ev(() => localStorage.setItem('worship-rig.settings.category', 'sound'));
    });

    await T('2.0 settings: narrow dialog (iPad portrait, narrow windows) → a horizontally scrolling tab strip on '
      + 'top; wide → the sidebar; no page scroll sideways', async () => {
      await openSettings();
      const layout = () => ev(() => {
        const nav = document.querySelector('#view-settings [role=tablist]');
        const body = document.querySelector('#view-settings .st-body');
        const tabs = [...nav.querySelectorAll('[role=tab]')].map((t) => t.getBoundingClientRect());
        const n = nav.getBoundingClientRect();
        const b = body.getBoundingClientRect();
        return {
          rows: new Set(tabs.map((t) => Math.round(t.top))).size,
          cols: new Set(tabs.map((t) => Math.round(t.left))).size,
          navAbove: n.bottom <= b.top + 1, navLeft: n.right <= b.left + 1, overflowX: getComputedStyle(nav).overflowX,
          scrolls: nav.scrollWidth > nav.clientWidth + 1,
          orient: nav.getAttribute('aria-orientation'), // review: follows the layout (arrows work both ways)
          // sideways scrolling inside Settings: the dialog past the window, or a panel wider than its column (the
          // page under the modal is the app's own business: Perform has a 1024 px minimum)
          pageX: (() => {
            const d = document.querySelector('#view-settings .st-dialog');
            return d.getBoundingClientRect().right > innerWidth + 1 || d.scrollWidth > d.clientWidth + 1
              || body.scrollWidth > body.clientWidth + 1;
          })(),
        };
      });
      try {
        for (const [w, hgt] of [[820, 1180], [700, 900], [390, 844]]) {
          await page.setViewportSize({ width: w, height: hgt });
          await sleep(150);
          const l = await layout();
          assert.equal(l.rows, 1, `${w}: one row of tabs (${JSON.stringify(l)})`);
          assert.ok(l.navAbove && !l.navLeft, `${w}: the strip sits on top`);
          assert.equal(l.overflowX, 'auto', `${w}: the strip scrolls sideways`);
          assert.equal(l.orient, 'horizontal', `${w}: a row of tabs says so`);
          assert.equal(l.pageX, false, `${w}: nothing in Settings scrolls sideways`);
          if (w === 390) {
            assert.ok(l.scrolls, '390: more tabs than fit');
            await cat('about'); // Playwright scrolls the strip to reach it; the view keeps it in sight
            const inView = await ev(() => {
              const nav = document.querySelector('#view-settings [role=tablist]').getBoundingClientRect();
              const t = document.querySelector('[data-testid="settings-tab-about"]').getBoundingClientRect();
              return t.left >= nav.left - 1 && t.right <= nav.right + 1;
            });
            assert.ok(inView, 'the selected tab is in view');
            await cat('sound');
          }
        }
        for (const [w, hgt] of [[1440, 900], [1024, 700]]) {
          await page.setViewportSize({ width: w, height: hgt });
          await sleep(150);
          const l = await layout();
          assert.ok(l.cols === 1 && l.rows === CHROME_TABS.length && l.navLeft,
            `${w}: the sidebar (${JSON.stringify(l)})`);
          assert.equal(l.pageX, false);
          assert.equal(l.orient, 'vertical', `${w}: the sidebar says so`);
        }
      } finally {
        await page.setViewportSize({ width: 1440, height: 900 });
      }
      await closeSettings();
    });

    await T('2.0 Sound: voices per sound / buffer size / total voice limit persist (device-local); the web engine '
      + 'stores them only and says so', async () => {
      await ev(() => window.__rig.ctx.openSettings({ section: 'voices' }));
      await until(() => window.__rig.views.settings.category === 'sound');
      const checked = (tid) => ev((t) => document.querySelector(`[data-testid="${t}"] [aria-checked="true"]`)
        ?.dataset.value ?? null, tid);
      assert.deepEqual([await checked('setting-polyphony'), await checked('setting-buffer-frames'),
        await checked('setting-voice-limit')], ['64', '128', 'auto'], 'defaults: 64 / 128 / Auto');
      assert.equal(await ev(() => ['polyphony', 'bufferFrames', 'voiceLimit']
        .some((k) => k in window.__rig.store.get().settings)), false, 'absent until chosen');
      // the web engine (1.x oracle) has no setters: a one-line note, nothing sent, no restart
      assert.equal(await page.isVisible('[data-testid="settings-engine-note"]'), true);
      assert.match(await page.textContent('[data-testid="settings-engine-note"]'), /apply with the 2\.0 engine/);
      assert.equal(await ev(() => typeof window.__rig.engine.setPolyphony), 'undefined');
      assert.equal(await ev(() => window.__rig.controller.status.audioConfig.native), false);
      const ctx0 = await ev(() => { window.__ctx0 = window.__rig.engine.ctx; return true; });
      assert.ok(ctx0);
      await page.click('[data-testid="setting-polyphony"] button[data-value="128"]');
      await page.click('[data-testid="setting-buffer-frames"] button[data-value="256"]');
      await adv('sound');
      await page.click('[data-testid="setting-voice-limit"] button[data-value="off"]');
      await until(() => {
        const s = window.__rig.store.get().settings;
        return s.polyphony === 128 && s.bufferFrames === 256 && s.voiceLimit === 'off';
      });
      await until(() => /"polyphony":128/.test(localStorage.getItem('rig.v1') || '')
        && /"bufferFrames":256/.test(localStorage.getItem('rig.v1') || '')
        && /"voiceLimit":"off"/.test(localStorage.getItem('rig.v1') || ''), null, 5000);
      assert.equal(await ev(() => window.__rig.engine.ctx === window.__ctx0 && window.__rig.controller.status.audio),
        'running', 'no audio restart on the web engine');
      await page.click('[data-testid="setting-voice-limit"] button[data-value="512"]');
      await until(() => window.__rig.store.get().settings.voiceLimit === 512);
      // off-list values are refused (never clamped); an export never carries this machine's choice
      const r = await ev(() => {
        const st = window.__rig.store;
        st.set('settings.polyphony', 100);
        st.set('settings.bufferFrames', 96);
        st.set('settings.voiceLimit', 1000);
        const exp = JSON.parse(st.exportJSON()).settings;
        return { s: st.get().settings, exported: ['polyphony', 'bufferFrames', 'voiceLimit'].filter((k) => k in exp) };
      });
      assert.deepEqual([r.s.polyphony, r.s.bufferFrames, r.s.voiceLimit], [128, 256, 512]);
      assert.deepEqual(r.exported, [], 'device-local: not exported');
      // the UI follows the store (another window, an import)
      await ev(() => window.__rig.store.set('settings.polyphony', 32));
      await until(() => document.querySelector('[data-testid="setting-polyphony"] [aria-checked="true"]')
        ?.dataset.value === '32');
      // back to the defaults (absent)
      const KEYS = ['polyphony', 'bufferFrames', 'voiceLimit'];
      await ev((ks) => ks.forEach((k) => window.__rig.store.set(`settings.${k}`, null)), KEYS);
      await until((ks) => !ks.some((k) => k in window.__rig.store.get().settings), KEYS);
      assert.deepEqual([await checked('setting-polyphony'), await checked('setting-buffer-frames'),
        await checked('setting-voice-limit')], ['64', '128', 'auto']);
      await page.locator('[data-testid="settings-panel-sound"]')
        .screenshot({ path: path.join(SHOTS, `${mode}-sound.png`) });
      await closeSettings();
    });

    await T('2.0 Sound (D5, UIB): "Freeze drone to save CPU" in Advanced, on by default (absent), persists '
      + '(device-local); the web engine always freezes, so it is stored only and the row says so', async () => {
      await ev(() => window.__rig.ctx.openSettings({ section: 'drone-freeze' })); // deep link opens Advanced
      await until(() => window.__rig.views.settings.category === 'sound'
        && document.querySelector('[data-testid="settings-advanced-sound"]').open);
      const tog = '[data-testid="setting-drone-freeze"]';
      // ui-core's toggle says aria-pressed, the fallback set's switch aria-checked
      const on = () => ev((t) => {
        const b = document.querySelector(t);
        return b.getAttribute('aria-pressed') ?? b.getAttribute('aria-checked');
      }, tog);
      await until((t) => document.activeElement === document.querySelector(t), tog);
      assert.equal(await on(), 'true', 'default on');
      assert.equal(await ev(() => 'droneFreeze' in window.__rig.store.get().settings), false, 'absent until chosen');
      assert.equal(await page.isVisible('[data-testid="setting-drone-freeze-note"]'), true);
      assert.match(await page.textContent('[data-testid="setting-drone-freeze-note"]'), /2\.0 engine/);
      assert.equal(await ev(() => typeof window.__rig.engine.setDroneFreeze), 'undefined', 'web engine: no setter');
      await page.click(tog);
      await until(() => window.__rig.store.get().settings.droneFreeze === false);
      assert.equal(await on(), 'false');
      await until(() => /"droneFreeze":false/.test(localStorage.getItem('rig.v1') || ''), null, 5000);
      const r = await ev(() => {
        const st = window.__rig.store;
        st.set('settings.droneFreeze', 'no'); // refused: a boolean or null only
        return { v: st.get().settings.droneFreeze, exported: 'droneFreeze' in JSON.parse(st.exportJSON()).settings };
      });
      assert.deepEqual(r, { v: false, exported: false }, 'refuses non-booleans; device-local: not exported');
      await ev(() => window.__rig.store.set('settings.droneFreeze', null)); // back to the default (absent = on)
      await until((t) => {
        const b = document.querySelector(t);
        return (b.getAttribute('aria-pressed') ?? b.getAttribute('aria-checked')) === 'true';
      }, tog);
      assert.equal(await ev(() => 'droneFreeze' in window.__rig.store.get().settings), false);
      await closeSettings();
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
    else if (m === 'bridge') await runBridge({ browser, createServer, ROOT, SHOTS, results });
    else await runMode(m, browser);
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
if (notes.length) console.log(`\nnotes (not failures):\n  ${notes.join('\n  ')}`);
console.log(`\nsettings: ${results.length - failed.length}/${results.length} passed (modes: ${MODES.join(', ')})`);
process.exit(failed.length ? 1 : 0);
