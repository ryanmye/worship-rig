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
  assert.deepEqual(await ev(() => window.__rig.store.currentSong().scenes[1].slots[0]), { gain: base.gain, muted: true });
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

test('no console errors', () => {
  assert.deepEqual(errors, [], errors.join('\n'));
});
