#!/usr/bin/env node
// v11-scenes Playwright test (run by ui-core/run.mjs as its own process, or alone: `node test/phase2/ui-core/scenes.mjs`).
// The real app in Chromium: nothing shows for a song without scenes; Quick › "Save as scene n"; Perform's scene
// numbers; a live move inside a scene; stepping with the numbers, the bus and a footswitch learned in Settings ›
// MIDI (a fake CC through midi._inject); held notes survive; a song switch starts on the song's own levels; Edit ›
// Song lists and deletes scenes. Zero console errors. Screenshots → test/phase2/ui-core/screenshots/scenes-*.png.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { pinTheme, MIDI_PERMISSIONS } from '../../integration/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const shots = path.join(here, 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const require = createRequire(import.meta.url);
const { createServer } = require('../../../server.js');

let server;
let browser;
let page;
const errors = [];
const ev = (fn, arg) => page.evaluate(fn, arg);
const until = (fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout });
const sceneState = () => ev(() => window.__rig.controller.scenes.state());
const clearToasts = () => ev(() => document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()));

before(async () => {
  server = createServer({ appDir: path.join(repo, 'app'), port: 20000 + Math.floor(Math.random() * 20000) });
  const info = await server.listen();
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await pinTheme(context, 'classic');
  try {
    await context.grantPermissions(MIDI_PERMISSIONS, { origin: info.url.replace(/\/$/, '') });
  } catch {
    /* not supported here: MIDI is driven through midi._inject anyway */
  }
  page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(`${m.text()} @ ${m.location()?.url || ''}`));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(info.url);
  await page.waitForFunction(() => window.__rig && window.__rig.controller.status.ready === true, null, { timeout: 90000 });
  await until(() => !window.__rig.controller.status.loading, null, 30000);
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test('quiet by default: no scene numbers; Quick offers only "Save as scene 1"', async () => {
  assert.equal(await page.isVisible('[data-testid=scene-dots]'), false);
  assert.equal(await ev(() => 'scenes' in window.__rig.store.currentSong()), false);
  await page.click('#btn-quick');
  await page.waitForSelector('[data-testid=quick-sheet]', { state: 'visible' });
  assert.equal(await page.isVisible('[data-testid=quick-scenes]'), true);
  assert.deepEqual(await ev(() => [...document.querySelectorAll('[data-testid=quick-scenes] button')].map((b) => b.textContent)), ['1']);
});

test('Save as scene 1 → the numbers appear with 1 lit; a live move in it leaves the song alone; Save as scene 2', async () => {
  await clearToasts();
  await page.click('[data-testid=quick-scene-1]');
  await until(() => window.__rig.controller.scenes.state().n === 0);
  assert.match(await page.textContent('#toasts'), /Saved as scene 1/);
  await page.click('[data-testid=quick-sheet] .qs-x');
  await page.waitForSelector('[data-testid=scene-dots]', { state: 'visible' });
  assert.equal(await page.getAttribute('[data-testid=scene-1]', 'aria-pressed'), 'true');
  const base = await ev(() => JSON.parse(JSON.stringify(window.__rig.store.currentSong().patch.slots[0])));
  // switch KEYS off inside scene 1: heard now, the song's own slot and scene 1 stay as saved
  await page.click('[data-testid=slot-on-0]');
  await until(() => window.__rig.engine.getParam('slots.0.gain') === 0);
  const s = await ev(() => window.__rig.store.currentSong());
  assert.deepEqual(s.patch.slots[0], base, 'the song’s own Keys slot is untouched');
  assert.equal(s.scenes[0].slots[0].muted, undefined, 'scene 1 is untouched');
  assert.equal(await page.getAttribute('[data-testid=slot-on-0]', 'aria-pressed'), 'false', 'the tile shows what is heard');
  await page.click('#btn-quick');
  await page.click('[data-testid=quick-scene-2]');
  await until(() => window.__rig.controller.scenes.state().n === 1);
  // (D26.1: the entry also holds the instrument's Space / Echo sends; test/phase1/shell/scene-snap.test.mjs)
  assert.deepEqual(await ev(() => window.__rig.store.currentSong().scenes[1].slots[0]),
    { gain: base.gain, muted: true, sends: { reverb: base.sends.reverb, delay: base.sends.delay } });
  assert.deepEqual(await ev(() => [...document.querySelectorAll('[data-testid=quick-scenes] button')].map((b) => b.textContent)), ['1', '2', '3']);
  await page.screenshot({ path: path.join(shots, 'scenes-quick.png') });
  await page.click('[data-testid=quick-sheet] .qs-x');
  await clearToasts();
  await page.screenshot({ path: path.join(shots, 'scenes-perform.png') });
});

test('the numbers step the scenes: a held note survives, the level glides, the lit number follows', async () => {
  await ev(() => window.__rig.controller.perform.noteOn(60, 100));
  await page.click('[data-testid=scene-1]');
  assert.equal((await sceneState()).n, 0);
  assert.equal(await page.getAttribute('[data-testid=scene-1]', 'aria-pressed'), 'true');
  // mid-glide the fader is on its way (not a step), then it arrives
  const mid = await ev(async () => {
    await new Promise((r) => setTimeout(r, 120));
    return window.__rig.engine.slots[0].faderMove;
  });
  assert.equal(mid.dur, 0.5, 'a 0.5 s glide');
  assert.equal(mid.from, 0);
  await until(() => window.__rig.engine.getParam('slots.0.gain') > 0.1);
  assert.equal(await ev(() => window.__rig.engine.sounding.has(60)), true, 'the held note keeps sounding');
  assert.equal(await page.getAttribute('[data-testid=slot-on-0]', 'aria-pressed'), 'true', 'scene 1: Keys on again');
  // tap the lit number: back to the song's own levels (none lit)
  await page.click('[data-testid=scene-1]');
  assert.equal((await sceneState()).n, null);
  assert.equal(await page.getAttribute('[data-testid=scene-1]', 'aria-pressed'), 'false');
  // the bus (global hotkeys, menu-bar popover)
  assert.equal(await ev(() => window.__rig.controller.handleCommand({ v: 1, type: 'nextScene' })), true);
  assert.equal((await sceneState()).n, 0);
  await ev(() => window.__rig.controller.handleCommand({ v: 1, type: 'prevScene' }));
  assert.equal((await sceneState()).n, null);
  await ev(() => window.__rig.controller.perform.noteOff(60));
});

test('a footswitch learned in Settings › MIDI (fake CC) steps the scenes: own → 1 → 2 → 1', async () => {
  await ev(() => window.__rig.ctx.openSettings({ section: 'midi' }));
  await page.waitForSelector('tr[data-control="nextScene"] .st-learn', { state: 'visible' });
  assert.equal(await page.textContent('tr[data-control="nextScene"] th'), 'Next scene');
  await page.click('tr[data-control="nextScene"] .st-learn');
  await until(() => window.__rig.midi.learning === 'nextScene');
  await ev(() => window.__rig.midi._inject([0xb0, 85, 127]));
  await until(() => window.__rig.store.get().settings.midiLearn.nextScene?.cc === 85);
  await ev(() => window.__rig.midi._inject([0xb0, 85, 0]));
  await ev(() => window.__rig.ctx.closeSettings());
  await page.waitForTimeout(200);
  assert.equal((await sceneState()).n, null, 'learning did not step');
  const press = () => ev(async () => {
    window.__rig.midi._inject([0xb0, 85, 127]);
    await new Promise((r) => setTimeout(r, 30));
    window.__rig.midi._inject([0xb0, 85, 0]);
  });
  await press();
  assert.equal((await sceneState()).n, 0);
  await press();
  assert.equal((await sceneState()).n, 1);
  await until(() => document.querySelector('[data-testid=scene-2]').classList.contains('on'));
  await press();
  assert.equal((await sceneState()).n, 0, 'one footswitch cycles: wraps to scene 1');
});

test('a song switch starts on the song’s own levels; Edit › Song lists the scenes and deletes one', async () => {
  const first = await ev(() => window.__rig.store.currentSong().id);
  await page.click('[data-testid=next-song]');
  await until(() => !window.__rig.controller.status.loading && window.__rig.controller.status.songId !== window.__rig.store.navIds()[0]);
  assert.equal(await page.isVisible('[data-testid=scene-dots]'), false, 'the next song has no scenes');
  await page.click('[data-testid=prev-song]');
  await until((id) => !window.__rig.controller.status.loading && window.__rig.controller.status.songId === id, first);
  await page.waitForSelector('[data-testid=scene-dots]', { state: 'visible' });
  assert.deepEqual(await sceneState(), { id: first, n: null, count: 2 }, 'back on its own levels');
  // Edit › Song: two rows, delete scene 2
  await ev(() => window.__rig.store.set('settings.view', 'edit'));
  await ev(() => document.querySelectorAll('.ev2-song-chip')[0]?.click());
  await page.waitForSelector('[data-testid=edit-scenes] .ev2-song-scene', { state: 'visible' });
  assert.equal(await page.locator('[data-testid=edit-scenes] .ev2-song-scene').count(), 2);
  await page.screenshot({ path: path.join(shots, 'scenes-edit.png') });
  await page.click('[data-testid=edit-scenes] .ev2-song-scene[data-n="1"] .ev2-song-scenedel');
  await until(() => window.__rig.store.currentSong().scenes.length === 1);
  assert.equal(await page.locator('[data-testid=edit-scenes] .ev2-song-scene').count(), 1);
  await ev(() => window.__rig.store.set('settings.view', 'perform'));
  assert.deepEqual(await ev(() => [...document.querySelectorAll('[data-testid=scene-dots] button')].map((b) => b.textContent)), ['1']);
});

// D26.1 (U-SNAP) views, flag off: today's Perform card and Edit v2 under a snapshot that holds the room / drone
test('D26.1: under snapshot "Hall" (own room Stage) today’s Perform shows Hall; tapping Stage, a key, the drone ON '
  + 'tile and Edit › Effects › Stage are heard and the song is NOT written; the next change drops them', async () => {
  const { HALL_SCENE, HEARD } = await import('../ui-v6/snap.tests.mjs');
  await ev(() => window.__rig.store.set('settings.view', 'perform'));
  const { up2, own } = await ev(HALL_SCENE);
  await until(() => !window.__rig.controller.status.loading);
  await ev(() => window.__rig.controller.scenes.go(0));
  await until(() => window.__rig.engine.getParam('fx.reverb.size') === 0.65);
  let h = await ev(HEARD);
  const before = h.json;
  const checked = (sel) => ev((x) => document.querySelector(x)?.getAttribute('aria-checked'), sel);
  await until(() => document.querySelector('[data-testid=space-row] .fxc[data-id="stage"]')?.getAttribute(
    'aria-checked') === 'false');
  // Space row → Stage
  await ev(() => document.querySelector('[data-testid=space-row] .fxc[data-id="stage"]').click());
  await until(() => window.__rig.engine.getParam('fx.reverb.size') === 0.42);
  assert.equal((await ev(HEARD)).json, before, 'Space: not written');
  await until(() => document.querySelector('[data-testid=space-row] .fxc[data-id="stage"]')?.getAttribute(
    'aria-checked') === 'true');
  assert.equal(await checked('[data-testid=space-row] .fxc[data-id="stage"]'), 'true');
  // key grid: the snapshot's key shows; another key is heard, not written
  assert.equal(await ev((pc) => document.querySelector(`[data-testid=key-grid] .key-btn[data-pc="${pc}"]`)
    ?.getAttribute('aria-checked'), up2), 'true');
  const up4 = (own + 4) % 12;
  await ev((pc) => document.querySelector(`[data-testid=key-grid] .key-btn[data-pc="${pc}"]`).click(), up4);
  await until((pc) => window.__rig.engine.drone?.key?.pc === pc, up4);
  assert.equal((await ev(HEARD)).json, before, 'key: not written');
  // ON tile
  await page.click('[data-testid=drone-on]');
  await until(() => window.__rig.engine.drone?.cfg?.mode === 'off');
  h = await ev(HEARD);
  assert.deepEqual([h.viewMode, h.ownMode], ['off', 'synth']);
  assert.equal(h.json, before, 'ON tile: not written');
  // the next change: the snapshot again
  await ev(() => {
    window.__rig.controller.scenes.go(null);
    window.__rig.controller.scenes.go(0);
  });
  await until((pc) => window.__rig.engine.drone?.key?.pc === pc && window.__rig.engine.drone.cfg.mode === 'synth'
    && window.__rig.engine.getParam('fx.reverb.size') === 0.65, up2);
  // Edit v2 › Effects › Space › Stage
  await ev(() => window.__rig.store.set('settings.view', 'edit'));
  await ev(() => window.__rig.views.edit.editState.select('effects'));
  const stage = '.ev2-fx-pchips[data-preset="space"] .ev2-fx-pc[data-id="stage"]';
  await page.waitForSelector(stage, { timeout: 10000 });
  assert.equal(await ev(() => document.querySelector('.ev2-fx-pchips[data-preset="space"] .ev2-fx-pc[data-id="hall"]')
    ?.getAttribute('aria-pressed')), 'true', 'Edit shows the snapshot’s Hall');
  await ev((x) => document.querySelector(x).click(), stage);
  await until(() => window.__rig.engine.getParam('fx.reverb.size') === 0.42);
  assert.equal((await ev(HEARD)).json, before, 'Edit › Effects: not written');
  await ev(() => window.__rig.store.set('settings.view', 'perform'));
  await ev(() => window.__rig.controller.scenes.go(null));
});

// UI6-snap F3: Edit v2 › Effects' send chips read the song's own sends under a snapshot that holds them
test('UI6-snap F3: Edit v2 › Effects under a snapshot holding Keys’ Space send shows the snapshot’s value',
  async () => {
    await ev(() => window.__rig.store.set('settings.view', 'perform'));
    await ev(() => {
      const { store, controller } = window.__rig;
      const s = store.currentSong();
      controller.scenes.go(null);
      store.set(`songs.${s.id}.patch.slots.0.sends.reverb`, 0.25);
      store.set(`songs.${s.id}.scenes`, [{ slots: [{ gain: s.patch.slots[0].gain, sends: { reverb: 0.9 } }] }]);
    });
    await until(() => !window.__rig.controller.status.loading);
    await ev(() => window.__rig.controller.scenes.go(0));
    await ev(() => window.__rig.store.set('settings.view', 'edit'));
    await ev(() => window.__rig.views.edit.editState.select('effects'));
    await page.waitForSelector('[data-testid=fx-reverb-0]', { state: 'attached', timeout: 10000 });
    await until(() => /90%/.test(document.querySelector('[data-testid=fx-reverb-0]')?.getAttribute('aria-label')
      || ''));
    await ev(() => window.__rig.controller.scenes.go(null));
    await until(() => /25%/.test(document.querySelector('[data-testid=fx-reverb-0]')?.getAttribute('aria-label')
      || ''));
    await ev(() => {
      const { store } = window.__rig;
      store.set(`songs.${store.currentSong().id}.scenes`, null);
      store.set('settings.view', 'perform');
    });
  });

// UI6-snap O1 (flag off): today's Edit says when its Space / Echo / drone controls change a playing scene (for now)
// rather than the song: "Changing scene “Scene 1” for now: Update keeps it, Own levels edits the song" under the
// header's chips; Update saves over the scene (Edit › Song's Save), Own levels goes back to the song's own levels.
test('UI6-snap O1: today’s Edit header line while a scene plays; Update / Own levels; none without one', async () => {
  await ev(() => window.__rig.store.set('settings.view', 'perform'));
  await ev(() => {
    const { store, controller } = window.__rig;
    const s = store.currentSong();
    controller.scenes.go(null);
    store.set(`songs.${s.id}.patch.slots.0.sends.reverb`, 0.25);
    store.set(`songs.${s.id}.scenes`, [{ name: 'Named in v6', slots: [{ gain: s.patch.slots[0].gain,
      sends: { reverb: 0.9 } }] }]);
  });
  await until(() => !window.__rig.controller.status.loading);
  await ev(() => window.__rig.store.set('settings.view', 'edit'));
  await until(() => document.body.dataset.view === 'edit');
  // (the element is made the first time a scene plays in Edit, the F3 test above; hidden since)
  assert.equal(await ev(() => !!document.querySelector('[data-testid=edit-snapline]:not([hidden])')), false,
    'no line while no scene plays');
  await ev(() => window.__rig.controller.scenes.go(0));
  await until(() => !!document.querySelector('[data-testid=edit-snapline]:not([hidden])'));
  const l = await ev(() => {
    const el = document.querySelector('[data-testid=edit-snapline]');
    const head = el.closest('.ev2-head').getBoundingClientRect();
    const chips = el.parentElement.querySelector('.ev2-song-head').getBoundingClientRect();
    const b = el.getBoundingClientRect();
    return { text: el.innerText.replace(/\s+/g, ' ').trim(), below: b.top >= chips.bottom - 1,
      inside: b.bottom <= head.bottom + 1 && b.right <= head.right + 1, h: b.height,
      hint: getComputedStyle(document.querySelector('.ev2-song-livehint')).display };
  });
  // D25: today's UI says "Scene n", not the v6 name
  assert.equal(l.text, 'Changing scene “Scene 1” for now: Update keeps it, Own levels edits the song');
  assert.ok(l.below && l.inside && l.h < 26, JSON.stringify(l));
  assert.equal(l.hint, 'none', 'the LIVE hint ("saved with it") gives way meanwhile');
  await page.screenshot({ path: path.join(shots, 'scenes-edit-snapline.png') });
  // a change on top of the scene, then Update keeps it in the scene (the song's own stays 25 %)
  await ev(() => window.__rig.controller.scenes.take('slots.0.sends.reverb', 0.5));
  await clearToasts();
  await page.click('[data-testid=edit-snap-update]');
  await until(() => window.__rig.store.currentSong().scenes[0].slots[0].sends.reverb === 0.5);
  const after1 = await ev(() => {
    const s = window.__rig.store.currentSong();
    return [s.scenes[0].name, s.patch.slots[0].sends.reverb, window.__rig.controller.scenes.state().n];
  });
  assert.deepEqual(after1, ['Named in v6', 0.25, 0]);
  await until(() => [...document.querySelectorAll('#toasts .toast')].some((t) => /“Scene 1” updated\./
    .test(t.textContent)));
  await page.click('[data-testid=edit-snap-own]');
  await until(() => window.__rig.controller.scenes.state().n === null);
  await until(() => document.querySelector('[data-testid=edit-snapline]').hidden === true);
  assert.equal(await ev(() => !!document.querySelector('.ev2-head.ev2-snapping')), false);
  await ev(() => {
    const { store } = window.__rig;
    store.set(`songs.${store.currentSong().id}.scenes`, null);
    store.set('settings.view', 'perform');
  });
});

// UI6-er O1 (flag off): delete the last song from Edit's ⋯ Song menu → the drone goes off and the voices fade (the web
// engine's drone and fade), Perform shows today's faded chip; PANIC (Esc) then has nothing left to stop. Empties this
// page's library: the last test before the console check.
test('UI6-er O1: deleting the last song from Edit’s song menu silences the drone and the voices', async () => {
  await ev(() => {
    const { store } = window.__rig;
    const keep = store.currentSong().id;
    for (const id of [...store.get().songOrder]) if (id !== keep) store.deleteSong(id);
    store.set(`songs.${keep}.drone.mode`, 'synth');
    store.set('settings.view', 'edit');
  });
  await until(() => window.__rig.engine.drone.sounding === true && document.body.dataset.view === 'edit');
  await page.click('.ev2-song-menubtn');
  await page.click('.ev2-song-mi[data-act=delete]');
  await page.click('.ev2-song-go[data-act=delete-go]');
  await until(() => window.__rig.store.get().songOrder.length === 0);
  const heard = () => ev(() => {
    const { engine } = window.__rig;
    return { drone: engine.drone.cfg.mode, sounding: engine.drone.sounding, faded: engine.getRuntimeState().faded };
  });
  assert.deepEqual(await heard(), { drone: 'off', sounding: false, faded: true });
  await ev(() => window.__rig.store.set('settings.view', 'perform'));
  await until(() => document.body.dataset.view === 'perform');
  await until(() => document.querySelector('[data-testid=faded-chip]')?.hidden === false);
  await page.keyboard.press('Escape');
  assert.deepEqual(await heard(), { drone: 'off', sounding: false, faded: true });
});

test('no console errors', () => {
  assert.deepEqual(errors, [], errors.join('\n'));
});
