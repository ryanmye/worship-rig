#!/usr/bin/env node
// ui-edit Playwright suite: Edit view + Settings modal against the real store/engine/controller.
//   node test/phase2/ui-edit/run.mjs            → both modes
//   UIEDIT_MODES=app|fixture node …             → one mode
// Modes:
//   app     — the real app (app/index.html + ui-core's main.js/components) served by server.js at "/".
//   fixture — test/phase2/ui-edit/fixture.html: minimal bootstrap that mounts edit/settings with the FALLBACK
//             component set (exercises views/_fallback-components.js).
// Every mode: zero console.error, then screenshots at 1440×900 and 1024×700 → test/phase2/ui-edit/screenshots/
// <mode>-<size>-{edit,edit-collapsed,settings}.png (+ legacy <mode>-edit.png / <mode>-settings.png; the app-mode
// 1440 shots are also written as edit.png / settings.png).
// Concurrent-edit notes: engine-owned behaviour that another agent is still wiring (slot width/EQ reaching the
// engine, My Samples rescan) is reported as "NOTE" lines, not failures — ui-edit only asserts its own contract.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const APP = path.join(ROOT, 'app');
const SHOTS = path.join(HERE, 'screenshots');
const { createServer } = require(path.join(ROOT, 'server.js'));

const haveApp = fs.existsSync(path.join(APP, 'index.html')) && fs.existsSync(path.join(APP, 'js', 'main.js')) &&
  /mountEdit/.test(fs.readFileSync(path.join(APP, 'js', 'main.js'), 'utf8'));
const MODES = (process.env.UIEDIT_MODES || (haveApp ? 'app,fixture' : 'fixture')).split(',').map((s) => s.trim()).filter(Boolean);
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
  const userSamplesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-ui-edit-samples-'));
  const server = createServer({ appDir: mode === 'app' ? APP : ROOT, port: 0, userSamples: [userSamplesDir] });
  const info = await server.listen();
  const origin = `http://127.0.0.1:${info.port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await context.grantPermissions(['midi', 'midi-sysex'], { origin });
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
  const song = () => ev(() => window.__rig.store.currentSong());
  const setRange = (sel, pos1000) =>
    ev(({ sel, pos }) => {
      const input = document.querySelector(sel);
      if (!input) throw new Error(`no range input for ${sel}`);
      input.value = String(pos);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { sel, pos: pos1000 });
  const rangeOf = (bind) => `[data-bind="${bind}"] input[type=range]`;
  const selectOf = (bind) => `select[data-bind="${bind}"], [data-bind="${bind}"] select`;
  const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
  /** Open collapsible Edit sections (details.ed-sec[data-sec=id]); fires 'toggle' → persisted like a user click. */
  const openSec = (...ids) =>
    ev((ids) => {
      for (const id of ids) for (const d of document.querySelectorAll(`details.ed-sec[data-sec="${id}"]`)) d.open = true;
    }, ids).then(() => sleep(30));
  const panicCounter = () =>
    ev(() => {
      if (!window.__panics) {
        window.__panics = { n: 0 };
        window.__rig.controller.addEventListener('action', (e) => {
          if (e.detail && e.detail.type === 'panic') window.__panics.n += 1;
        });
      }
      return window.__panics.n;
    });
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
      await page.goto(mode === 'app' ? `${origin}/` : `${origin}/test/phase2/ui-edit/fixture.html`);
      await until(() => !!(window.__rig && window.__rig.views && window.__rig.views.edit && window.__rig.views.settings), null, 20000);
      await ev(() => window.__rig.ready);
      if (mode === 'app') {
        const overlay = await page.$('#overlay-start:not([hidden])');
        if (overlay) await overlay.click();
        await page.click('#view-switch button[data-value="edit"]');
        await until(() => !document.getElementById('view-edit').hidden);
      }
      await until(() => window.__rig.engine.ctx && window.__rig.engine.ctx.state === 'running');
      await until(() => document.querySelectorAll('.ed-slot').length === 4);
      const src = await ev(() => window.__rig.views.edit._debug.components);
      assert.equal(src, mode === 'app' ? 'ui-core' : 'fallback');
      const s = await song();
      assert.equal(await page.inputValue('.ed-song-title'), s.name);
      await until(() => window.__rig.controller.status.songId === window.__rig.store.get().settings.currentSongId && !window.__rig.controller.status.loading, null, 30000);
    });

    // ------------------------------------------------------------------------------------------ instruments
    await T('instrument picker lists engine instruments by group, with "— empty —"', async () => {
      const r = await ev(() => {
        const sel = document.querySelector('.ed-slot[data-slot="0"] .ed-picker');
        const list = window.__rig.engine.listInstruments();
        return {
          groups: [...sel.querySelectorAll('optgroup')].map((g) => g.label),
          first: sel.options[0].textContent,
          n: sel.options.length,
          list: list.length,
          hasDroneOsc: list.some((x) => x.ref.id === 'drone-osc'),
          droneOscOption: [...sel.options].some((o) => o.value === 'synth:drone-osc'),
        };
      });
      assert.equal(r.first, '— empty —');
      assert.equal(r.n, r.list + 1 - (r.hasDroneOsc ? 1 : 0)); // the drone's internal voice is not offered
      assert.equal(r.droneOscOption, false);
      assert.ok(r.groups.includes('Piano') && r.groups.includes('Synth Pads') && r.groups.includes('Organ'), r.groups.join(','));
    });

    await T('instrument change → engine slot instrument changes, card rebuilt, sound plays', async () => {
      await page.selectOption('.ed-slot[data-slot="0"] .ed-picker', 'synth:soft-keys');
      await until(() => window.__rig.engine.slots[0] && window.__rig.engine.slots[0].ref.id === 'soft-keys', null, 30000);
      const s = await song();
      assert.deepEqual(s.patch.slots[0].instrument, { type: 'synth', id: 'soft-keys' });
      await until(() => /Soft Keys/.test(document.querySelector('.ed-slot[data-slot="0"] .ed-params summary')?.textContent || ''));
      await until(() => !window.__rig.controller.status.loading);
      const db = await playAndMeasure(60);
      assert.ok(db > -50, `soft-keys RMS ${db.toFixed(1)} dBFS`);
    });

    await T('empty a slot and fill it again (defaultSlot)', async () => {
      await page.selectOption('.ed-slot[data-slot="2"] .ed-picker', '');
      await until(() => window.__rig.store.currentSong().patch.slots[2] === null && !window.__rig.engine.slots[2]);
      assert.ok(await page.$('.ed-slot[data-slot="2"].empty'));
      await page.selectOption('.ed-slot[data-slot="2"] .ed-picker', 'synth:bell');
      await until(() => window.__rig.engine.slots[2] && window.__rig.engine.slots[2].ref.id === 'bell', null, 30000);
      const s = await song();
      assert.equal(s.patch.slots[2].sends.delay, 0.2); // Extra role default
      assert.ok(await page.$('.ed-slot[data-slot="2"] [data-bind="slots.2.gain"]'));
    });

    // ------------------------------------------------------------------------------------------ faders
    await T('slot fader → store (taper) → engine.getParam; keyboard; double-click reset', async () => {
      await setRange(rangeOf('slots.0.gain'), 600);
      await until(() => Math.abs(window.__rig.store.currentSong().patch.slots[0].gain - 2 * 0.6 ** 3) < 0.01);
      const g = await ev(() => [window.__rig.store.currentSong().patch.slots[0].gain, window.__rig.engine.getParam('slots.0.gain')]);
      assert.ok(near(g[0], g[1]), `store ${g[0]} engine ${g[1]}`);
      const label = await page.textContent('[data-bind="slots.0.gain"] output');
      assert.match(label, /dB$/);
      // keyboard
      await page.focus(rangeOf('slots.0.gain'));
      await page.keyboard.press('ArrowRight');
      await until((prev) => window.__rig.store.currentSong().patch.slots[0].gain > prev + 1e-4, g[0]);
      await page.evaluate(() => document.activeElement.blur());
      // double-click → default 0.8
      await page.dblclick('[data-bind="slots.0.gain"] input[type=range]');
      await until(() => Math.abs(window.__rig.engine.getParam('slots.0.gain') - 0.8) < 1e-9);
    });

    await T('pan / octave / transpose / sustain / mono reach the engine', async () => {
      await openSec('slot0-more');
      await setRange(rangeOf('slots.0.pan'), 250); // −0.5
      await until(() => Math.abs(window.__rig.engine.getParam('slots.0.pan') + 0.5) < 0.01);
      await page.click('[data-bind="slots.0.octave"] button[aria-label$="up"]');
      await until(() => window.__rig.engine.getParam('slots.0.octave') === 1);
      await page.click('[data-bind="slots.0.octave"] button[aria-label$="down"]');
      await until(() => window.__rig.engine.getParam('slots.0.octave') === 0);
      await page.click('[data-bind="slots.0.transpose"] button[aria-label$="up"]');
      await until(() => window.__rig.engine.getParam('slots.0.transpose') === 1);
      await page.click('[data-bind="slots.0.transpose"] button[aria-label$="down"]');
      const before = await ev(() => window.__rig.engine.getParam('slots.0.sustain'));
      await page.click('[data-bind="slots.0.sustain"]');
      await until((b) => window.__rig.engine.getParam('slots.0.sustain') === !b, before);
      await page.click('[data-bind="slots.0.sustain"]');
      await page.selectOption(selectOf('slots.0.mono'), 'highest');
      await until(() => window.__rig.engine.getParam('slots.0.mono') === 'highest');
      await page.selectOption(selectOf('slots.0.mono'), 'off');
      await setRange(rangeOf('slots.0.pan'), 500);
    });

    await T('split: note fields + mini keyboard write lowNote/highNote', async () => {
      await page.fill('[data-bind="slots.0.lowNote"]', 'C3');
      await page.press('[data-bind="slots.0.lowNote"]', 'Enter');
      await until(() => window.__rig.engine.getParam('slots.0.lowNote') === 48);
      await page.fill('[data-bind="slots.0.highNote"]', '72');
      await page.press('[data-bind="slots.0.highNote"]', 'Enter');
      await until(() => window.__rig.engine.getParam('slots.0.highNote') === 72);
      assert.equal(await page.inputValue('[data-bind="slots.0.highNote"]'), 'C5');
      await page.click('.ed-slot[data-slot="0"] .ed-split-full');
      await until(() => window.__rig.engine.getParam('slots.0.lowNote') === 0 && window.__rig.engine.getParam('slots.0.highNote') === 127);
      // drag on the mini keyboard: left part moves the low bound up
      const box = await page.locator('.ed-slot[data-slot="0"] [data-bind="slots.0.split"]').boundingBox();
      await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
      await until(() => window.__rig.engine.getParam('slots.0.lowNote') > 30 && window.__rig.engine.getParam('slots.0.lowNote') < 70);
      await page.click('.ed-slot[data-slot="0"] .ed-split-full');
      await until(() => window.__rig.engine.getParam('slots.0.lowNote') === 0);
    });

    await T('sends + instrument params reach the engine', async () => {
      await openSec('slot1-more');
      await setRange(rangeOf('slots.1.sends.reverb'), 800);
      await until(() => /Reverb 80%/.test(document.querySelector('.ed-slot[data-slot="1"] .ed-sends-sum').textContent));
      await until(() => Math.abs(window.__rig.engine.getParam('slots.1.sends.reverb') - 0.8) < 0.002);
      await page.click('.ed-slot[data-slot="0"] .ed-params > summary');
      const key = await ev(() => window.__rig.engine.listInstruments().find((x) => x.ref.id === 'soft-keys').params.find((p) => p.key === 'tremolo').key);
      await setRange(rangeOf(`slots.0.params.${key}`), 900);
      await until(() => Math.abs(window.__rig.store.currentSong().patch.slots[0].params.tremolo - 0.9) < 0.002);
      const v = await ev(() => [window.__rig.store.currentSong().patch.slots[0].params.tremolo, window.__rig.engine.getParam('slots.0.params.tremolo')]);
      assert.ok(near(v[0], v[1]), `store ${v[0]} engine ${v[1]}`);
      // double-click resets to the instrument default (0.25)
      await page.dblclick(rangeOf('slots.0.params.tremolo'));
      await until(() => Math.abs(window.__rig.engine.getParam('slots.0.params.tremolo') - 0.25) < 1e-9);
    });

    await T('FX: reverb / delay (sync, pingpong) / chorus / lofi / master reach the engine', async () => {
      await openSec('fx-reverb', 'fx-delay', 'fx-chorus', 'fx-lofi', 'fx-master');
      await setRange(rangeOf('fx.reverb.size'), 800);
      await until(() => Math.abs(window.__rig.engine.getParam('fx.reverb.size') - 0.8) < 0.002);
      await setRange(rangeOf('fx.delay.feedback'), 500);
      await until(() => Math.abs(window.__rig.engine.getParam('fx.delay.feedback') - 0.45) < 0.002);
      await page.selectOption(selectOf('fx.delay.sync'), '1/4');
      await until(() => window.__rig.engine.getParam('fx.delay.sync') === '1/4');
      assert.ok(await ev(() => document.querySelector('[data-bind="fx.delay.time"] input').disabled), 'time disabled when synced');
      await page.selectOption(selectOf('fx.delay.sync'), 'off');
      await until(() => !document.querySelector('[data-bind="fx.delay.time"] input').disabled);
      const pp = await ev(() => window.__rig.engine.getParam('fx.delay.pingpong'));
      await page.click('[data-bind="fx.delay.pingpong"]');
      await until((b) => window.__rig.engine.getParam('fx.delay.pingpong') === !b, pp);
      await setRange(rangeOf('fx.chorus.depth'), 300);
      await until(() => Math.abs(window.__rig.engine.getParam('fx.chorus.depth') - 0.3) < 0.002);
      await setRange(rangeOf('fx.lofi.amount'), 400);
      await until(() => Math.abs(window.__rig.engine.getParam('fx.lofi.amount') - 0.4) < 0.002);
      await page.click('.ed-lofi-more summary');
      await setRange(rangeOf('fx.lofi.crackle'), 700);
      await until(() => Math.abs(window.__rig.engine.getParam('fx.lofi.crackle') - 0.7) < 0.002);
      await setRange(rangeOf('fx.lofi.amount'), 0);
      await setRange(rangeOf('master.volume'), 700);
      await until(() => Math.abs(window.__rig.engine.getParam('master.volume') - 2 * 0.7 ** 3) < 0.01);
      assert.ok((await playAndMeasure(64)) > -50, 'still sounds after FX edits');
    });

    await T('routing + drone controls write the song', async () => {
      await openSec('routing', 'drone');
      await page.selectOption(selectOf('song.patch.modWheel.target'), 'macro.wash');
      await until(() => window.__rig.store.currentSong().patch.modWheel.target === 'macro.wash' && window.__rig.engine._routing.modWheel.target === 'macro.wash');
      await page.selectOption(selectOf('song.patch.bend.mode'), 'tape');
      await until(() => window.__rig.engine._routing.bend.mode === 'tape');
      await page.click('[data-bind="song.drone.mode"] button[data-value="synth"]');
      await until(() => window.__rig.store.currentSong().drone.mode === 'synth');
      await setRange(rangeOf('drone.brightness'), 700);
      await until(() => Math.abs(window.__rig.engine.getParam('drone.brightness') - 0.7) < 0.002);
      await page.click('[data-bind="song.drone.mode"] button[data-value="files"]');
      await until(() => document.querySelector('[data-bind="song.drone.chordFollow"]').classList.contains('ed-disabled'));
      await page.click('[data-bind="song.drone.mode"] button[data-value="off"]');
      await until(() => window.__rig.store.currentSong().drone.mode === 'off');
    });

    // ------------------------------------------------------------------------------------------ song level
    await T('Easy Transpose: Hear In / octave / minor → engine transpose + key names', async () => {
      await openSec('transpose');
      await page.selectOption('select[data-bind="song.playIn"]', '0');
      await page.selectOption('select[data-bind="song.hearIn"]', '2');
      await until(() => window.__rig.engine.transpose === 2);
      await page.click('[data-bind="song.transposeOctave"] button[data-value="1"]');
      await until(() => window.__rig.engine.transpose === 14);
      await page.click('[data-bind="song.transposeOctave"] button[data-value="0"]');
      await until(() => window.__rig.engine.transpose === 2);
      await page.selectOption('select[data-bind="song.hearIn"]', '10'); // Bb → −2 (shortest way)
      await until(() => window.__rig.engine.transpose === -2);
      assert.equal(await page.textContent('select[data-bind="song.hearIn"] option[value="10"]'), 'Bb');
      await page.click('[data-bind="song.minor"]');
      await until(() => document.querySelector('select[data-bind="song.hearIn"] option[value="1"]').textContent === 'C#m');
      assert.match(await page.textContent('.ed-tr-readout'), /Bbm/);
      await page.click('[data-bind="song.minor"]');
      await page.selectOption('select[data-bind="song.hearIn"]', '0');
      await until(() => window.__rig.engine.transpose === 0);
    });

    await T('tap tempo (4 taps @ 500 ms) → ~120 BPM in store and engine', async () => {
      // first tap is a real click; the rest are timed in-page (Playwright's click latency would skew the BPM). The
      // expected BPM comes from the actual click times, so a loaded machine (late timers) can't fail the test.
      await ev(() => {
        window.__taps = [];
        document.querySelector('.ed-tap').addEventListener('click', () => window.__taps.push(performance.now()), { capture: true });
      });
      await page.click('.ed-tap');
      await ev(async () => {
        const b = document.querySelector('.ed-tap');
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, 500));
          b.click();
        }
      });
      await until(() => window.__rig.store.currentSong().tempo !== null);
      const t = await ev(() => [window.__rig.store.currentSong().tempo, window.__rig.engine.tempo]);
      let seq = [];
      for (const x of await ev(() => window.__taps)) {
        if (seq.length && x - seq[seq.length - 1] > 2000) seq = []; // same reset rule as the view
        seq.push(x);
      }
      seq = seq.slice(-4);
      const want = 60000 / ((seq[seq.length - 1] - seq[0]) / (seq.length - 1));
      assert.ok(Math.abs(t[0] - want) <= 1.5, `tempo ${t[0]} vs ${want.toFixed(1)} from the click times`);
      if (Math.abs(t[0] - 120) > 4) note(mode, `tap timers ran late on this machine (${want.toFixed(1)} BPM for 500 ms taps)`);
      await until((x) => window.__rig.engine.tempo === x, t[0]);
      assert.equal(await page.inputValue('.ed-tempo'), String(t[0]));
      await page.fill('.ed-tempo', '96');
      await page.press('.ed-tempo', 'Enter');
      await until(() => window.__rig.store.currentSong().tempo === 96);
    });

    await T('song name + notes edit', async () => {
      await page.fill('.ed-song-title', 'My Edited Song');
      await page.press('.ed-song-title', 'Enter');
      await until(() => window.__rig.store.currentSong().name === 'My Edited Song');
      await until(() => document.querySelector('.ed-song.current .ed-song-name')?.textContent === 'My Edited Song');
      await openSec('notes');
      await page.fill('.ed-notes', 'Verse soft, chorus big.');
      await page.locator('.ed-notes').blur();
      await until(() => window.__rig.store.currentSong().notes === 'Verse soft, chorus big.');
      assert.equal(await page.textContent('details[data-sec="notes"] .ed-sec-sum'), 'Verse soft, chorus big.');
    });

    await T('store → view updates in place (no rebuild on param change or song switch)', async () => {
      await ev(() => {
        document.querySelector('.ed-slot[data-slot="0"]').__mark = 1;
        document.querySelector('[data-bind="slots.0.gain"]').__mark = 1;
        window.__rig.store.set('slots.0.gain', 1);
      });
      await until(() => {
        const i = document.querySelector('[data-bind="slots.0.gain"] input[type=range]');
        return Math.abs(Number(i.value) - Math.round(Math.cbrt(0.5) * 1000)) <= 1;
      });
      assert.equal(await ev(() => document.querySelector('[data-bind="slots.0.gain"]').__mark), 1, 'fader element kept');
      // switch to the second song in the list (different instruments) → cards kept, values refreshed
      const target = await ev(() => {
        const rows = [...document.querySelectorAll('.ed-song:not(.current)')];
        const r = rows.find((x) => /Organ Swell/.test(x.textContent)) || rows[0];
        return r.dataset.id;
      });
      await page.click(`.ed-song[data-id="${target}"] .ed-song-name`);
      await until((id) => window.__rig.controller.status.songId === id && !window.__rig.controller.status.loading, target, 30000);
      await until((id) => document.querySelector('.ed-song-title').value === window.__rig.store.getSong(id).name, target);
      assert.equal(await ev(() => document.querySelector('.ed-slot[data-slot="0"]').__mark), 1, 'slot card element kept');
      const s = await song();
      const picker = await page.inputValue('.ed-slot[data-slot="0"] .ed-picker');
      assert.equal(picker, s.patch.slots[0] ? `${s.patch.slots[0].instrument.type}:${s.patch.slots[0].instrument.id}` : '');
      assert.ok((await playAndMeasure(60)) > -50, 'switched song sounds');
    });


    // ------------------------------------------------------------------------------------------ round2-ui
    /** Two songs of the current list with a slot 0, and a switch the way MIDI Next / program change does it. */
    const r2Pair = () =>
      ev(() => {
        const st = window.__rig.store;
        const ids = st.navIds().filter((id) => st.getSong(id)?.patch.slots[0]);
        const cur = st.currentSong().id;
        const a = ids.includes(cur) ? cur : ids[0];
        return [a, ids.find((x) => x !== a && st.getSong(x).name !== st.getSong(a).name)];
      });
    const r2Select = async (id) => {
      await ev((i) => window.__rig.controller.selectSong(i), id);
      await until((i) => window.__rig.controller.status.songId === i && !window.__rig.controller.status.loading, id, 30000);
      await sleep(60);
    };

    await T('round2-ui #3: name / notes / tempo typed before a non-pointer song switch go to the song they were typed in', async () => {
      const [a, b] = await r2Pair();
      await r2Select(a);
      const snap = () => ev(([a, b]) => {
        const st = window.__rig.store;
        const f = (s) => ({ name: s.name, notes: s.notes, tempo: s.tempo });
        return { a: f(st.getSong(a)), b: f(st.getSong(b)) };
      }, [a, b]);
      const s0 = await snap();
      // title
      await page.click('.ed-song-title');
      await page.keyboard.press('End');
      await page.keyboard.type(' (live)');
      await r2Select(b);
      assert.equal(await page.inputValue('.ed-song-title'), s0.b.name, 'the title field shows the new song at once');
      await page.keyboard.press('Enter');
      await sleep(80);
      let s1 = await snap();
      assert.equal(s1.a.name, `${s0.a.name} (live)`, 'the typed name went to the song it was typed in');
      assert.equal(s1.b.name, s0.b.name, 'the next song is not renamed');
      // notes (debounced flush)
      await r2Select(a);
      await openSec('notes');
      await page.click('textarea.ed-notes');
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' x');
      await r2Select(b);
      await page.keyboard.type('y');
      await sleep(700);
      s1 = await snap();
      assert.equal(s1.b.notes, s0.b.notes, 'B’s notes not replaced by A’s text');
      assert.equal(s1.a.notes, `${s0.a.notes || ''} x`, 'A keeps what was typed in it');
      assert.equal(await page.inputValue('textarea.ed-notes'), s0.b.notes || '', 'the notes field shows B');
      // tempo
      await r2Select(a);
      await page.fill('.ed-tempo', '97');
      await r2Select(b);
      s1 = await snap();
      assert.equal(s1.a.tempo, 97);
      assert.equal(s1.b.tempo, s0.b.tempo, 'B’s tempo unchanged');
      // put things back
      await ev(([a, s]) => {
        const st = window.__rig.store;
        st.set(`songs.${a}.name`, s.name);
        st.set(`songs.${a}.notes`, s.notes);
        st.set(`songs.${a}.tempo`, s.tempo);
      }, [a, s0.a]);
      await r2Select(a);
    });

    await T('round2-ui #2: an Edit fader drag still going at a song switch never writes into the new song', async () => {
      // same slot-0 instrument in both songs, so the slot card (and the fader under the pointer) is kept
      const [a, b] = await ev(() => {
        const st = window.__rig.store;
        const ids = st.navIds().filter((id) => st.getSong(id)?.patch.slots[0]);
        const key = (id) => JSON.stringify(st.getSong(id).patch.slots[0].instrument);
        for (const x of ids) for (const y of ids) if (x !== y && key(x) === key(y)) return [x, y];
        st.set(`songs.${ids[1]}.patch.slots.0.instrument`, st.getSong(ids[0]).patch.slots[0].instrument);
        return [ids[0], ids[1]];
      });
      await ev(([a, b]) => {
        window.__rig.store.set(`songs.${a}.patch.slots.0.gain`, 0.5);
        window.__rig.store.set(`songs.${b}.patch.slots.0.gain`, 0.7);
      }, [a, b]);
      await r2Select(a);
      const loc = page.locator(rangeOf('slots.0.gain')).first();
      await loc.scrollIntoViewIfNeeded();
      const box = await loc.boundingBox();
      const y = box.y + box.height / 2;
      const x0 = box.x + box.width * 0.5;
      await page.mouse.move(x0, y);
      await page.mouse.down();
      await page.mouse.move(x0 + box.width * 0.2, y, { steps: 4 });
      await sleep(80);
      const midA = await ev((a) => window.__rig.store.getSong(a).patch.slots[0].gain, a);
      assert.notEqual(midA, 0.5, 'the drag moves A');
      await r2Select(b);
      await page.mouse.move(x0 + box.width * 0.35, y, { steps: 4 });
      await page.mouse.up();
      await sleep(120);
      const g = await ev(([a, b]) => [window.__rig.store.getSong(a).patch.slots[0].gain, window.__rig.store.getSong(b).patch.slots[0].gain], [a, b]);
      assert.equal(g[1], 0.7, `B untouched (got ${g[1]})`);
      assert.equal(g[0], midA, 'A keeps the level dragged before the switch');
      const shownPos = await ev((sel) => Number(document.querySelector(sel).value), rangeOf('slots.0.gain'));
      assert.ok(Math.abs(shownPos - Math.round(Math.cbrt(0.7 / 2) * 1000)) <= 2, `fader shows B (pos ${shownPos})`);
      // the next drag works normally again
      await page.mouse.move(x0, y);
      await page.mouse.down();
      await page.mouse.move(x0 - box.width * 0.1, y, { steps: 3 });
      await page.mouse.up();
      await sleep(80);
      assert.notEqual(await ev((b) => window.__rig.store.getSong(b).patch.slots[0].gain, b), 0.7, 'a fresh drag writes');
      await ev(() => document.activeElement?.blur?.());
      await r2Select(a);
    });

    await T('round2-ui #7: factory browser headings use presets CATEGORY_LABELS ("Synth", not "synth")', async () => {
      await page.click('.ed-add-factory');
      const heads = await ev(() => [...document.querySelectorAll('.ed-h3')].map((e) => e.textContent));
      await page.click('.ed-add-factory');
      assert.ok(heads.includes('Synth'), `headings: ${heads.join(', ')}`);
      assert.ok(!heads.some((t) => /^[a-z]/.test(t)), `no raw category ids: ${heads.join(', ')}`);
    });

    // ------------------------------------------------------------------------------------------ ui-edit-2
    await T('M4: slot cards carry the four slot colours (computed --role / border / role label)', async () => {
      const r = await ev(() => {
        const probe = document.createElement('span');
        document.body.append(probe);
        const resolve = (c) => {
          probe.style.color = '';
          probe.style.color = c;
          return getComputedStyle(probe).color;
        };
        const want = [0, 1, 2, 3].map((i) => resolve(`var(--slot-${i})`));
        const accent = resolve('var(--accent)');
        const got = [0, 1, 2, 3].map((i) => {
          const card = document.querySelector(`.ed-slot[data-slot="${i}"]`);
          return {
            border: getComputedStyle(card).borderTopColor,
            role: getComputedStyle(card.querySelector('.ed-slot-role')).color,
            prop: resolve(getComputedStyle(card).getPropertyValue('--role').trim()),
          };
        });
        probe.remove();
        return { want, accent, got };
      });
      assert.equal(new Set(r.want).size, 4, `four distinct slot colours: ${r.want}`);
      r.got.forEach((g, i) => {
        assert.equal(g.border, r.want[i], `slot ${i} border`);
        assert.equal(g.role, r.want[i], `slot ${i} role label`);
        assert.equal(g.prop, r.want[i], `slot ${i} --role`);
        assert.notEqual(g.border, r.accent);
      });
    });

    await T('M1: Esc in Edit closes the confirm, never panics; body[data-dialog-open] while a confirm is open', async () => {
      const p0 = await panicCounter();
      await ev(() => window.__rig.controller.perform.noteOn(62, 100));
      // song-row delete confirm
      await page.hover('.ed-song[data-index="1"]');
      await page.click('.ed-song[data-index="1"] .ed-act-del');
      await until(() => !!document.querySelector('.ed-song.confirming'));
      assert.equal(await ev(() => document.body.dataset.dialogOpen), '1');
      assert.match(await page.textContent('.ed-song.confirming .ed-row-confirm-q'), /Remove “.+” from this set, or delete it/);
      await page.keyboard.press('Escape');
      await until(() => !document.querySelector('.ed-song.confirming'));
      await until(() => document.body.dataset.dialogOpen === undefined);
      // setlist delete confirm
      await page.click('.ed-sets button[title="Delete setlist"]');
      await until(() => !document.querySelector('.ed-sets .ed-confirm').hidden && document.body.dataset.dialogOpen === '1');
      await page.keyboard.press('Escape');
      await until(() => document.querySelector('.ed-sets .ed-confirm').hidden);
      // nothing open: Esc is still not Panic inside Edit
      await ev(() => document.activeElement?.blur?.());
      await page.keyboard.press('Escape');
      await sleep(100);
      assert.equal(await panicCounter(), p0, 'no panic from Esc in Edit');
      assert.ok(await ev(() => window.__rig.controller._debug().held.some(([n]) => n === 62)), 'held note survives Esc');
      assert.ok(await ev(() => window.__rig.store.get().setlistOrder.length >= 1), 'nothing deleted');
      await ev(() => window.__rig.controller.perform.noteOff(62));
      // ⌘./Ctrl+. is still the global panic (Chrome; Electron's menu owns it)
      if (!(await ev(() => !!(window.rig && window.rig.isElectron)))) {
        await page.keyboard.press('Control+Period');
        await until((p) => window.__panics.n === p + 1, p0);
      }
    });

    await T('collapsed by default; section open state persists (localStorage)', async () => {
      const r = await ev(() => ({
        stored: JSON.parse(localStorage.getItem('worship-rig.edit.sections') || '{}'),
        comp: !!document.querySelector('details.ed-sec[data-sec="fx-comp"]'),
        glueOpen: document.querySelector('details.ed-sec[data-sec="fx-comp"]')?.open ?? null,
        more3: document.querySelector('.ed-slot[data-slot="3"] details.ed-more')?.open ?? null,
      }));
      // sections the user never opened are closed; the ones the tests opened are remembered
      assert.equal(r.glueOpen === null ? false : r.glueOpen, false);
      if (r.more3 !== null) assert.equal(r.more3, false, 'Bass "More" closed by default');
      assert.equal(r.stored['fx-reverb'], true);
      assert.equal(r.stored['slot0-more'], true);
      // close via the header (real click) → persisted as false
      await page.click('details.ed-sec[data-sec="fx-chorus"] > summary');
      await until(() => JSON.parse(localStorage.getItem('worship-rig.edit.sections'))['fx-chorus'] === false);
      // headers carry a one-line summary
      const sums = await ev(() => [...document.querySelectorAll('.ed-right details.ed-sec .ed-sec-sum')].map((x) => x.textContent));
      assert.ok(sums.every((t) => t.length > 0), sums.join(' | '));
    });

    await T('presets: Space / Echo / Vibe apply through the store; tweak → "Custom"', async () => {
      await page.selectOption('select[data-preset="space"]', 'hall');
      await until(() => Math.abs(window.__rig.store.currentSong().patch.fx.reverb.size - 0.65) < 1e-9 && Math.abs(window.__rig.engine.getParam('fx.reverb.size') - 0.65) < 1e-6);
      assert.equal(await page.inputValue('select[data-preset="space"]'), 'hall');
      assert.match(await page.textContent('.ed-preset-blurb'), /concert hall/i);
      await page.selectOption('select[data-preset="vibe"]', 'set');
      await until(() => window.__rig.store.currentSong().patch.fx.delay.sync === '1/8d' && window.__rig.engine.getParam('fx.delay.pingpong') === true);
      assert.equal(await page.inputValue('select[data-preset="vibe"]'), 'set');
      assert.equal(await page.inputValue('select[data-preset="space"]'), 'stage');
      assert.equal(await page.inputValue('select[data-preset="echo"]'), 'dotted');
      await setRange(rangeOf('fx.reverb.size'), 300);
      await until(() => document.querySelector('select[data-preset="space"]').value === 'custom');
      const r = await ev(() => {
        const sp = document.querySelector('select[data-preset="space"]');
        return { space: sp.selectedOptions[0].textContent, vibe: document.querySelector('select[data-preset="vibe"]').value, echo: document.querySelector('select[data-preset="echo"]').value };
      });
      assert.deepEqual(r, { space: 'Custom', vibe: 'custom', echo: 'dotted' });
      await page.selectOption('select[data-preset="vibe"]', 'sunday');
      await until(() => document.querySelector('select[data-preset="vibe"]').value === 'sunday');
    });

    await T('new strip/master params render only when params.describe has them; labels, reset, store (engine when wired)', async () => {
      const paths = ['slots.0.width', 'slots.0.eq.low', 'slots.0.eq.high', 'fx.eq.low', 'fx.eq.mid', 'fx.eq.high', 'fx.comp.amount'];
      const url = mode === 'app' ? '/js/shared/params.js' : '/app/js/shared/params.js';
      const have = await ev(async ({ url, paths }) => {
        const { describe } = await import(url);
        return Object.fromEntries(paths.map((p) => [p, !!describe(p) && !describe(p).dynamic]));
      }, { url, paths });
      await openSec('slot0-more', 'fx-eq', 'fx-comp');
      for (const p of paths) {
        const present = await ev((p) => !!document.querySelector(`[data-bind="${p}"]`), p);
        assert.equal(present, have[p], `${p}: rendered=${present} described=${have[p]}`);
      }
      if (have['slots.0.eq.low']) {
        await setRange(rangeOf('slots.0.eq.low'), 750); // −12..12 → +6 dB
        await until(() => Math.abs((window.__rig.store.currentSong().patch.slots[0].eq || {}).low - 6) < 0.05);
        assert.match(await page.textContent('[data-bind="slots.0.eq.low"] output'), /^\+6\.0 dB$/);
        await page.dblclick(rangeOf('slots.0.eq.low'));
        await until(() => window.__rig.store.currentSong().patch.slots[0].eq.low === 0);
      }
      if (have['slots.0.width']) {
        await setRange(rangeOf('slots.0.width'), 400); // 0..1.5 → 0.6
        await until(() => Math.abs(window.__rig.store.currentSong().patch.slots[0].width - 0.6) < 0.002);
        assert.equal(await page.textContent('[data-bind="slots.0.width"] output'), '60%');
        await sleep(150);
        const eng = await ev(() => window.__rig.engine.getParam('slots.0.width'));
        if (!(Math.abs(eng - 0.6) < 0.002)) note(mode, `store slots.0.width=0.6 but engine.getParam=${eng} — controller.applyParamDiff does not diff slot width/eq yet (shell)`);
        await page.dblclick(rangeOf('slots.0.width'));
        await until(() => window.__rig.store.currentSong().patch.slots[0].width === 1);
      }
      if (have['fx.eq.low']) {
        await setRange(rangeOf('fx.eq.low'), 625); // +3 dB
        await until(() => Math.abs(window.__rig.store.currentSong().patch.fx.eq.low - 3) < 0.05);
        await until(() => Math.abs(window.__rig.engine.getParam('fx.eq.low') - 3) < 0.05);
        assert.match(await page.textContent('details[data-sec="fx-eq"] .ed-sec-sum'), /Low \+3\.0 dB/);
        await page.dblclick(rangeOf('fx.eq.low'));
        await until(() => window.__rig.store.currentSong().patch.fx.eq.low === 0);
        assert.equal(await page.textContent('details[data-sec="fx-eq"] .ed-sec-sum'), 'Flat');
      }
      if (have['fx.comp.amount']) {
        await setRange(rangeOf('fx.comp.amount'), 500);
        await until(() => Math.abs(window.__rig.engine.getParam('fx.comp.amount') - 0.5) < 0.002);
        assert.equal(await page.textContent('details[data-sec="fx-comp"] .ed-sec-sum'), '50%');
        await page.dblclick(rangeOf('fx.comp.amount'));
        await until(() => window.__rig.store.currentSong().patch.fx.comp.amount === 0);
      }
    });

    await T('picker groups: engine group order; "Brass & Leads" after Synth Keys when synth-extra is loaded', async () => {
      const r = await ev(() => {
        const list = window.__rig.engine.listInstruments();
        const sel = document.querySelector('.ed-slot[data-slot="0"] .ed-picker');
        return {
          engineGroups: [...new Set(list.map((x) => x.group))],
          labels: [...sel.querySelectorAll('optgroup')].map((g) => g.label),
          brass: list.filter((x) => x.group === 'Brass & Leads').map((x) => `${x.ref.type}:${x.ref.id}`),
          inBrass: [...sel.querySelectorAll('optgroup[label="Brass & Leads"] option')].map((o) => o.value),
        };
      });
      if (r.brass.length) {
        const L = r.labels;
        assert.ok(L.includes('Brass & Leads'), L.join(','));
        if (L.includes('Synth Keys')) assert.ok(L.indexOf('Brass & Leads') > L.indexOf('Synth Keys'), L.join(','));
        if (L.includes('Mallets & Bells')) assert.ok(L.indexOf('Brass & Leads') < L.indexOf('Mallets & Bells'), L.join(','));
        assert.deepEqual(r.inBrass.sort(), r.brass.sort());
      } else note(mode, `synth-extra not loaded (engine groups: ${r.engineGroups.join(', ')}) — Brass & Leads check skipped`);
      if (r.labels.includes('My Samples')) assert.equal(r.labels.at(-1), 'My Samples');
      for (const g of r.engineGroups) if (g) assert.ok(r.labels.includes(g) || g === 'Synth Pads', `group ${g} shown`);
    });

    await T('mute toggle (Slot.muted) + velocity-curve sparkline + More summary', async () => {
      await page.click('.ed-slot[data-slot="1"] .ed-mute');
      await until(() => window.__rig.store.currentSong().patch.slots[1].muted === true && window.__rig.engine.getParam('slots.1.gain') === 0);
      assert.ok(await page.$('.ed-slot[data-slot="1"].muted'));
      await page.click('.ed-slot[data-slot="1"] .ed-mute');
      await until(() => !window.__rig.store.currentSong().patch.slots[1].muted && window.__rig.engine.getParam('slots.1.gain') > 0);
      await openSec('slot0-more');
      assert.equal(await ev(() => document.querySelector('.ed-slot[data-slot="0"] .ed-vel-spark').dataset.curve), 'normal');
      await page.selectOption(selectOf('slots.0.velocityCurve'), 'soft');
      await until(() => document.querySelector('.ed-slot[data-slot="0"] .ed-vel-spark').dataset.curve === 'soft' && window.__rig.engine.getParam('slots.0.velocityCurve') === 'soft');
      // the graph is really drawn (non-empty pixels) in the slot colour
      const px = await ev(() => {
        const c = document.querySelector('.ed-slot[data-slot="0"] .ed-vel-spark');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let k = 3; k < d.length; k += 4) if (d[k] > 0) n++;
        return n;
      });
      assert.ok(px > 50, `sparkline pixels ${px}`);
      assert.match(await page.textContent('.ed-slot[data-slot="0"] details.ed-more .ed-sec-sum'), /Light touch/);
      await page.selectOption(selectOf('slots.0.velocityCurve'), 'normal');
    });

    await T('song search appears for > 8 songs and filters rows', async () => {
      const cur = await ev(() => window.__rig.store.get().settings.currentSetlistId);
      await page.selectOption('.ed-sets select', '');
      await until(() => !document.querySelector('.ed-search').hidden);
      await page.fill('.ed-search', 'organ');
      await until(() => {
        const vis = [...document.querySelectorAll('.ed-song:not([hidden]) .ed-song-name')].map((x) => x.textContent);
        return vis.length >= 1 && vis.every((t) => /organ/i.test(t));
      });
      await page.press('.ed-search', 'Escape');
      await until(() => document.querySelector('.ed-search').value === '' && [...document.querySelectorAll('.ed-song')].every((r) => !r.hidden));
      await page.selectOption('.ed-sets select', cur);
      await until((c) => window.__rig.store.get().settings.currentSetlistId === c, cur);
    });

    await T('removing the current song from the set shows where Next continues (settings.setlistGap)', async () => {
      const r0 = await ev(() => {
        const st = window.__rig.store;
        const ids = st.currentSetlist().songIds;
        return { id: ids[1], next: st.getSong(ids[2]).name, setId: st.currentSetlist().id };
      });
      await page.click(`.ed-song[data-index="1"] .ed-song-name`);
      await until((id) => window.__rig.store.get().settings.currentSongId === id && !window.__rig.controller.status.loading, r0.id, 30000);
      await page.hover('.ed-song[data-index="1"]');
      await page.click('.ed-song[data-index="1"] .ed-act-del');
      await page.click('.ed-song.confirming .ed-remove-from-set');
      await until(() => window.__rig.store.get().settings.setlistGap === true);
      await until((n) => !document.querySelector('.ed-gap-note').hidden && document.querySelector('.ed-gap-note').textContent.includes(n), r0.next);
      assert.ok(await page.$('.ed-songs .ed-gap-row'));
      assert.equal(await page.$('.ed-song.current'), null, 'no row claims to be current');
      // put it back where it was and select it again → gap cleared
      await ev(({ setId, id }) => {
        window.__rig.store.addToSetlist(setId, id, 1);
        window.__rig.controller.selectSong(id, { index: 1 });
      }, r0);
      await until(() => document.querySelector('.ed-gap-note').hidden && !document.querySelector('.ed-gap-row'));
    });

    // ------------------------------------------------------------------------------------------ list
    await T('add song from factory browser → appears in setlist and is selected', async () => {
      const before = await ev(() => window.__rig.store.currentSetlist().songIds.length);
      await page.click('.ed-add-factory');
      assert.match(await page.textContent('[data-factory-id="factory:glass-ocean"] .ed-browser-desc'), /glassy pad/);
      await page.click('[aria-label="Add Glass Ocean"]');
      await until((n) => window.__rig.store.currentSetlist().songIds.length === n + 1, before);
      const r = await ev(() => {
        const st = window.__rig.store;
        const ids = st.currentSetlist().songIds;
        const id = ids[ids.length - 1];
        return { id, name: st.getSong(id).name, factoryId: st.getSong(id).factoryId, cur: st.get().settings.currentSongId };
      });
      assert.equal(r.name, 'Glass Ocean');
      assert.equal(r.factoryId, 'factory:glass-ocean');
      assert.equal(r.cur, r.id);
      await until((id) => !!document.querySelector(`.ed-song.current[data-id="${id}"]`), r.id);
      await until((id) => window.__rig.controller.status.songId === id && !window.__rig.controller.status.loading, r.id, 30000);
      await page.click('.ed-add-factory'); // close the browser
    });

    await T('reorder: Alt+↑ keyboard and drag-and-drop → store.moveSong order', async () => {
      const ids0 = await ev(() => window.__rig.store.currentSetlist().songIds.slice());
      const n = ids0.length;
      await page.focus(`.ed-song[data-index="${n - 1}"]`);
      await page.keyboard.press('Alt+ArrowUp');
      await until(({ id, n }) => window.__rig.store.currentSetlist().songIds[n - 2] === id, { id: ids0[n - 1], n });
      await until((n) => document.activeElement?.dataset?.index === String(n - 2), n);
      // plain ↑ moves focus only (and must not nudge the wheel)
      const wheel = await ev(() => window.__rig.controller._debug().virtualWheel);
      await page.keyboard.press('ArrowUp');
      assert.equal(await ev(() => document.activeElement.dataset.index), String(n - 3));
      assert.equal(await ev(() => window.__rig.controller._debug().virtualWheel), wheel);
      // drag row 0 onto the lower half of row 2 → lands at index 2
      const ids1 = await ev(() => window.__rig.store.currentSetlist().songIds.slice());
      const box = await page.locator('.ed-song[data-index="2"]').boundingBox();
      await page.dragAndDrop('.ed-song[data-index="0"] .ed-grip', '.ed-song[data-index="2"]', { targetPosition: { x: 40, y: box.height - 4 } });
      await until((id) => window.__rig.store.currentSetlist().songIds[2] === id, ids1[0]);
      const ids2 = await ev(() => window.__rig.store.currentSetlist().songIds.slice());
      assert.deepEqual(ids2.slice(0, 3), [ids1[1], ids1[2], ids1[0]]);
      await ev(() => document.activeElement?.blur());
    });

    await T('rename inline, duplicate, delete with confirm', async () => {
      // row actions show on hover / focus (like the Finder), so hover first as a user would
      await page.hover('.ed-song[data-index="0"]');
      await page.click('.ed-song[data-index="0"] .ed-act-rename');
      await page.fill('.ed-song-rename', 'Opener');
      await page.press('.ed-song-rename', 'Enter');
      await until(() => window.__rig.store.getSong(window.__rig.store.currentSetlist().songIds[0]).name === 'Opener');
      const n = await ev(() => window.__rig.store.currentSetlist().songIds.length);
      await page.hover('.ed-song[data-index="0"]');
      await page.click('.ed-song[data-index="0"] .ed-act-dup');
      await until((n) => window.__rig.store.currentSetlist().songIds.length === n + 1, n);
      const dupId = await ev(() => window.__rig.store.currentSetlist().songIds[1]);
      assert.equal(await ev((id) => window.__rig.store.getSong(id).name, dupId), 'Opener (copy)');
      await page.hover(`.ed-song[data-id="${dupId}"]`);
      await page.click(`.ed-song[data-id="${dupId}"] .ed-act-del`);
      assert.ok(await page.$(`.ed-song[data-id="${dupId}"].confirming`));
      assert.equal(await ev(() => window.__rig.store.currentSetlist().songIds.length), n + 1, 'nothing deleted before confirm');
      await page.click(`.ed-song[data-id="${dupId}"] .ed-confirm-delete`);
      await until((id) => !window.__rig.store.getSong(id), dupId);
      assert.equal(await ev(() => window.__rig.store.currentSetlist().songIds.length), n);
    });

    await T('setlist: new (inline rename) + select + delete', async () => {
      const cur = await ev(() => window.__rig.store.get().settings.currentSetlistId);
      await page.click('.ed-sets button[title="New setlist"]');
      await page.fill('.ed-sets input[aria-label="Setlist name"]', 'Sunday AM');
      await page.press('.ed-sets input[aria-label="Setlist name"]', 'Enter');
      await until(() => window.__rig.store.currentSetlist()?.name === 'Sunday AM');
      assert.match(await page.textContent('.ed-list .ed-h2'), /Sunday AM/);
      await page.selectOption('.ed-sets select', cur);
      await until((c) => window.__rig.store.get().settings.currentSetlistId === c, cur);
      const newId = await ev(() => Object.values(window.__rig.store.get().setlists).find((s) => s.name === 'Sunday AM').id);
      await page.selectOption('.ed-sets select', newId);
      await page.click('.ed-sets button[title="Delete setlist"]');
      await page.click('.ed-sets .ed-confirm .ed-danger');
      await until((id) => !window.__rig.store.get().setlists[id], newId);
      await page.selectOption('.ed-sets select', cur);
    });

    await T('export library → valid JSON → re-import (merge)', async () => {
      await openSec('library-file');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.ed-export')]);
      assert.match(dl.suggestedFilename(), /^Worship Rig library \d{4}-\d{2}-\d{2}\.json$/);
      const text = fs.readFileSync(await dl.path(), 'utf8');
      const doc = JSON.parse(text);
      assert.equal(doc.app, 'worship-rig');
      assert.equal(doc.kind, 'library');
      const n = await ev(() => window.__rig.store.get().songOrder.length);
      assert.equal(doc.songOrder.length, n);
      await page.setInputFiles('.ed-io input[type=file]', { name: 'lib.json', mimeType: 'application/json', buffer: Buffer.from(text) });
      await until((n) => window.__rig.store.get().songOrder.length === 2 * n, n);
      // a garbage file is refused with a message, not an exception
      await page.setInputFiles('.ed-io input[type=file]', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{nope') });
      await until(() => [...document.querySelectorAll('#toasts .toast')].some((t) => /not valid JSON/.test(t.textContent)));
    });

    await T('reset to factory (factory-derived song)', async () => {
      const id = await ev(() => {
        const st = window.__rig.store;
        return st.currentSetlist().songIds.find((x) => st.getSong(x).factoryId === 'factory:glass-ocean');
      });
      await page.click(`.ed-song[data-id="${id}"] .ed-song-name`);
      await until((id) => window.__rig.store.get().settings.currentSongId === id && document.querySelector('.ed-song-title').value === 'Glass Ocean', id);
      await setRange(rangeOf('fx.reverb.size'), 100);
      await until(() => Math.abs(window.__rig.store.currentSong().patch.fx.reverb.size - 0.1) < 0.002);
      await page.click('.ed-reset-btn');
      await page.click('.ed-reset-confirm');
      await until(() => Math.abs(window.__rig.store.currentSong().patch.fx.reverb.size - 0.82) < 1e-9);
      await until(() => Math.abs(Number(document.querySelector('[data-bind="fx.reverb.size"] input').value) - 820) <= 1);
    });

    await T('on-screen keyboard plays through controller.perform', async () => {
      const key = page.locator('.ed-bottom [data-note="67"]').first();
      const b = await key.boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height * 0.8);
      await page.mouse.down();
      await until(() => window.__rig.controller._debug().held.some(([n]) => n === 67));
      await until(() => document.querySelector('.ed-bottom [data-note="67"]').classList.contains('held'));
      await page.mouse.up();
      await until(() => !window.__rig.controller._debug().held.some(([n]) => n === 67));
    });

    const cleanForShot = () =>
      ev(() => {
        for (const t of document.querySelectorAll('#toasts > *')) t.remove();
        for (const c of document.querySelectorAll('.ed-left, .ed-center, .ed-right, .ed-songs, .st-body')) c.scrollTop = 0;
        document.activeElement?.blur?.();
      });

    const SIZES = [[1440, 900], [1024, 700]];
    await T('screenshots edit + edit-collapsed at 1440×900 and 1024×700; no horizontal overflow', async () => {
      // a song with Keys + Pad makes a representative shot
      const id = await ev(() => {
        const st = window.__rig.store;
        return st.currentSetlist().songIds.find((x) => st.getSong(x).patch.slots[0] && st.getSong(x).patch.slots[1]);
      });
      if (id) {
        await page.click(`.ed-song[data-id="${id}"] .ed-song-name`);
        await until((id) => window.__rig.controller.status.songId === id && !window.__rig.controller.status.loading, id, 30000);
      }
      for (const [w, hgt] of SIZES) {
        await page.setViewportSize({ width: w, height: hgt });
        // collapsed = what a first-time user sees
        await ev(() => {
          for (const d of document.querySelectorAll('.ed details.ed-sec')) d.open = false;
        });
        await cleanForShot();
        await sleep(300);
        const over = await ev(() => {
          const bad = [];
          if (document.documentElement.scrollWidth > innerWidth + 1) bad.push(`page ${document.documentElement.scrollWidth}>${innerWidth}`);
          for (const c of document.querySelectorAll('.ed-left, .ed-center, .ed-right')) if (c.scrollWidth > c.clientWidth + 1) bad.push(`${c.className} ${c.scrollWidth}>${c.clientWidth}`);
          const card = document.querySelector('.ed-slot[data-slot="0"]').getBoundingClientRect();
          return { bad, slot0Top: card.top, vh: innerHeight };
        });
        assert.deepEqual(over.bad, [], `overflow at ${w}×${hgt}`);
        assert.ok(over.slot0Top < over.vh - 150, `Keys card visible without scrolling at ${w}×${hgt} (top ${over.slot0Top})`);
        await page.screenshot({ path: path.join(SHOTS, `${mode}-${w}x${hgt}-edit-collapsed.png`) });
        // expanded: a working set of sections open
        await openSec('transpose', 'slot0-more', 'fx-reverb', 'fx-delay');
        await cleanForShot();
        await sleep(300);
        const over2 = await ev(() => [...document.querySelectorAll('.ed-left, .ed-center, .ed-right')].filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => c.className));
        assert.deepEqual(over2, [], `overflow (expanded) at ${w}×${hgt}`);
        await page.screenshot({ path: path.join(SHOTS, `${mode}-${w}x${hgt}-edit.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      fs.copyFileSync(path.join(SHOTS, `${mode}-1440x900-edit.png`), path.join(SHOTS, `${mode}-edit.png`));
      if (mode === 'app') fs.copyFileSync(path.join(SHOTS, 'app-edit.png'), path.join(SHOTS, 'edit.png'));
    });

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

    await T('settings: pedal polarity detector suggests invert and applies it', async () => {
      await page.click('.st-pedal-test');
      await until(() => /Press your sustain pedal now/.test(document.querySelector('.st-pedal').textContent));
      await ev(() => window.__rig.midi._inject([0xb0, 64, 0]));
      await until(() => !!document.querySelector('.st-pedal-result[data-invert="true"]'));
      await page.click('.st-pedal-apply');
      await until(() => window.__rig.store.get().settings.pedalInvert === true);
      await page.click('.st-pedal-test');
      await ev(() => window.__rig.midi._inject([0xb0, 64, 127]));
      await until(() => !!document.querySelector('.st-pedal-result[data-invert="false"]'));
      await page.click('.st-pedal-apply');
      await until(() => window.__rig.store.get().settings.pedalInvert === false);
      assert.equal(await ev(() => window.__rig.controller._debug().pedalDown), false, 'no stuck pedal');
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

    await T('destroy() cleans up and remount works', async () => {
      const r = await ev(async (url) => {
        const { mountEdit } = await import(url);
        const host = document.createElement('div');
        document.body.append(host);
        const v = mountEdit(host, window.__rig.ctx);
        const had = host.querySelectorAll('.ed-slot').length;
        const stored = JSON.parse(localStorage.getItem('worship-rig.edit.sections') || '{}');
        const restored = Object.entries(stored).every(([id, open]) => {
          const d = host.querySelector(`details.ed-sec[data-sec="${id}"]`);
          return !d || d.open === open;
        });
        if (!restored) throw new Error('section open state not restored on remount');
        v.destroy();
        const after = host.childElementCount;
        host.remove();
        return { had, after };
      }, mode === 'app' ? '/js/views/edit.js' : '/app/js/views/edit.js');
      assert.deepEqual(r, { had: 4, after: 0 });
    });
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
console.log(`\nui-edit: ${results.length - failed.length}/${results.length} passed (modes: ${MODES.join(', ')})`);
process.exit(failed.length ? 1 : 0);
