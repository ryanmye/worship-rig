#!/usr/bin/env node
// UIA (native DECISIONS D3) Playwright test: Perform with 1..16 slots (run by ui-core/run.mjs as its own process, or
// alone: `node --test test/phase2/ui-core/slots.mjs`). The real app in Chromium on the web engine:
//   - a 4-slot song keeps today's strip row (no scrolling, the same four strips, no note);
//   - more than four: the row scrolls sideways (four strips' width in view), by keyboard (the focused row keeps ←/→
//     from switching songs), wheel and touch; a strip that takes focus scrolls into view; a song switch starts at
//     the first strip;
//   - Sound 5..16: named and coloured past the four roles, a one-line note before them on the web engine (silent
//     here, they play on the 2.0 engine), their faders write the song and never reach the web engine;
//   - fewer than four: only the song's strips show.
// Zero console errors. Screenshots → test/phase2/ui-core/screenshots/slots-*.png.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { pinTheme } from '../../integration/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const shots = path.join(here, 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const require = createRequire(import.meta.url);
const { createServer } = require('../../../server.js');

let server;
let browser;
let page;
let cdp;
const errors = [];
const ev = (fn, arg) => page.evaluate(fn, arg);
const until = (fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
const clearToasts = () => ev(() => document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()));
/** Bring the current song to `n` slots (new ones: alternating synth sounds). */
const setCount = (n) => ev((k) => {
  const s = window.__rig.store;
  while (s.currentSong().patch.slots.length < k) {
    const i = s.currentSong().patch.slots.length;
    s.addSlot(undefined, { instrument: { type: 'synth', id: i % 2 ? 'warm-pad' : 'soft-keys' } });
  }
  while (s.currentSong().patch.slots.length > k) s.removeSlot();
}, n);
const row = () => ev(() => {
  const r = document.querySelector('.p-slots');
  const shown = [...r.querySelectorAll(':scope > .strip')].filter((x) => !x.hidden);
  return {
    scroll: r.classList.contains('scroll'), sl: r.scrollLeft, sw: r.scrollWidth, cw: r.clientWidth,
    tab: r.getAttribute('tabindex'), strips: r.querySelectorAll(':scope > .strip').length,
    shown: shown.map((x) => Number(x.dataset.slot)),
    note: !document.querySelector('[data-testid=slots-silent-note]').hidden,
    noteBefore: document.querySelector('[data-testid=slots-silent-note]').nextElementSibling?.dataset.slot ?? null,
    silent: shown.filter((x) => x.classList.contains('silent')).map((x) => Number(x.dataset.slot)),
  };
});
/** Strip i entirely inside the row's visible box. */
const stripInView = (i) => ev((k) => {
  const a = document.querySelector('.p-slots').getBoundingClientRect();
  const b = document.querySelector(`[data-testid=slot-${k}]`).getBoundingClientRect();
  return b.left >= a.left - 1 && b.right <= a.right + 1;
}, i);

before(async () => {
  server = createServer({ appDir: path.join(repo, 'app'), port: 20000 + Math.floor(Math.random() * 20000) });
  const info = await server.listen();
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await pinTheme(context, 'classic');
  page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(`${m.text()} @ ${m.location()?.url || ''}`));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  cdp = await context.newCDPSession(page);
  await page.goto(info.url);
  await page.waitForFunction(() => window.__rig && window.__rig.controller.status.ready === true, null, { timeout: 90000 });
  await until(() => !window.__rig.controller.status.loading, null, 30000);
  await clearToasts();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test('a 4-slot song: today’s row (four strips, no scrolling, no note); the web engine plays 4', async () => {
  const r = await row();
  assert.deepEqual(r.shown, [0, 1, 2, 3]);
  assert.equal(r.strips, 4, 'no strip built past the song’s four');
  assert.equal(r.scroll, false);
  assert.equal(r.tab, null, 'the row is not a tab stop');
  assert.ok(r.sw <= r.cw + 1);
  assert.equal(r.note, false);
  assert.equal(await ev(() => window.__rig.controller.engineSlots()), 4);
  assert.deepEqual(errors, []);
});

test('6 slots: the row scrolls, four strips’ width in view; Sound 5 / 6 named, coloured, marked silent here', async () => {
  const before = await ev(() => {
    const k = document.querySelector('[data-testid=slot-0]').getBoundingClientRect();
    const r = document.querySelector('.p-slots').getBoundingClientRect();
    return { row: r.width, top: k.top, h: k.height };
  });
  await setCount(6);
  await until(() => document.querySelectorAll('.p-slots > .strip:not([hidden])').length === 6);
  const r = await row();
  assert.deepEqual(r.shown, [0, 1, 2, 3, 4, 5]);
  assert.equal(r.scroll, true);
  assert.equal(r.tab, '0', 'the row takes focus for the keyboard');
  assert.ok(r.sw > r.cw + 50, `scrolls: ${r.sw} > ${r.cw}`);
  assert.equal(r.note, true);
  assert.equal(r.noteBefore, '4', 'the note sits right before Sound 5');
  assert.deepEqual(r.silent, [4, 5]);
  const g = await ev(() => {
    const gap = parseFloat(getComputedStyle(document.querySelector('.p-slots')).columnGap);
    const w = (i) => document.querySelector(`[data-testid=slot-${i}]`).getBoundingClientRect();
    const row = document.querySelector('.p-slots');
    return { gap, w0: w(0).width, w4: w(4).width, top4: w(4).top, h4: w(4).height, cw: row.clientWidth };
  });
  assert.ok(Math.abs(g.w0 - (g.cw - 3 * g.gap) / 4) < 1.5, `a filled strip = a quarter of the row (${g.w0})`);
  assert.equal(g.w4, g.w0);
  // a classic (space-taking) scrollbar may shorten the strips by its height; overlay ones (macOS) do not
  assert.ok(Math.abs(g.top4 - before.top) < 1 && g.h4 <= before.h && g.h4 > before.h - 18, `strip height ${g.h4} ≈ ${before.h}`);
  const tile = await ev(() => {
    const t = document.querySelector('[data-testid=slot-on-4]');
    return { label: t.getAttribute('aria-label'), sub: t.querySelector('.ot-sub').textContent, title: t.title,
      c: getComputedStyle(t).getPropertyValue('--c').trim() };
  });
  assert.equal(tile.label, 'SOUND 5');
  assert.equal(tile.sub, '5');
  assert.match(tile.title, /Sound 5/);
  assert.match(await ev(() => document.querySelector('[data-testid=slot-4]').title), /2\.0 engine/);
  assert.match(await ev(() => document.querySelector('[data-testid=slots-silent-note]').textContent), /Silent here · these play on the 2\.0 engine/);
  assert.match(await ev(() => document.querySelector('[data-testid=slot-fader-4]').textContent), /Sound 5 level|dB/);
  await clearToasts();
  await page.screenshot({ path: path.join(shots, 'slots-6.png') });
  assert.deepEqual(errors, []);
});

test('Sound 5..16 colours mix the theme’s own role colours, also where a theme sets them on body (Ember)', async () => {
  // UIA skeptic: --slot-4..15 were declared on :root only, so a theme that colours the roles on body (Ember, Nave)
  // got Classic's mixes; the colour of strip i must equal the mix of the role colours as that strip sees them
  const probe = () => ev(() => {
    const el = document.querySelector('[data-testid=slot-on-4]');
    const i = document.createElement('i');
    el.append(i);
    i.style.color = 'var(--slot-4)';
    const got = getComputedStyle(i).color;
    i.style.color = 'color-mix(in oklch, var(--slot-0), var(--slot-1))';
    const want = getComputedStyle(i).color;
    i.remove();
    return { got, want, theme: document.documentElement.dataset.theme };
  });
  if ((await row()).strips < 5) await setCount(6);
  for (const th of ['ember', 'classic']) {
    await ev((t) => window.__rig.store.set('settings.theme', t), th);
    await until((t) => document.documentElement.dataset.theme === t, th, 20000);
    const c = await probe();
    assert.equal(c.got, c.want, `${th}: Sound 5 = the mix of this theme's Keys and Pad`);
  }
  assert.deepEqual(errors, []);
});

test('keyboard: the focused row scrolls with ←/→/End/Home and keeps the song; focus reveals a strip', async () => {
  const song = await ev(() => window.__rig.store.get().settings.currentSongId);
  await ev(() => document.querySelector('.p-slots').focus());
  await page.keyboard.press('End');
  await until(() => {
    const r = document.querySelector('.p-slots');
    return r.scrollLeft >= r.scrollWidth - r.clientWidth - 2;
  });
  assert.ok(await stripInView(5));
  await page.keyboard.press('Home');
  await until(() => document.querySelector('.p-slots').scrollLeft === 0);
  await page.keyboard.press('ArrowRight');
  await until(() => document.querySelector('.p-slots').scrollLeft > 20);
  await page.keyboard.press('ArrowLeft');
  await until(() => document.querySelector('.p-slots').scrollLeft === 0);
  assert.equal(await ev(() => window.__rig.store.get().settings.currentSongId), song, '←/→ on the row never switch songs');
  // Tab into Sound 6's controls: the strip scrolls into view
  assert.equal(await stripInView(5), false);
  await ev(() => document.querySelector('[data-testid=slot-on-5]').focus());
  await until(() => {
    const a = document.querySelector('.p-slots').getBoundingClientRect();
    const b = document.querySelector('[data-testid=slot-5]').getBoundingClientRect();
    return b.left >= a.left - 1 && b.right <= a.right + 1;
  });
  await ev(() => document.activeElement?.blur());
  await ev(() => { document.querySelector('.p-slots').scrollLeft = 0; });
});

test('wheel and touch scroll the row', async () => {
  await until(() => document.querySelector('.p-slots').scrollLeft === 0);
  const box = await page.locator('.p-slots').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 60);
  await page.mouse.wheel(300, 0);
  await until(() => document.querySelector('.p-slots').scrollLeft > 50);
  await ev(() => { document.querySelector('.p-slots').scrollLeft = 0; });
  // a touch swipe to the left over the Pad's fader (CDP touch events; a vertical fader lets a sideways pan scroll)
  const padGain = await ev(() => window.__rig.store.currentSong().patch.slots[1].gain);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const f = await page.locator('[data-testid=slot-fader-1] input[type=range]').boundingBox();
  const x = Math.round(f.x + f.width / 2);
  const y = Math.round(f.y + f.height / 2);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let k = 1; k <= 10; k++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - k * 25, y }] });
    await new Promise((r) => setTimeout(r, 16));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until(() => document.querySelector('.p-slots').scrollLeft > 50);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  assert.equal(await ev(() => window.__rig.store.currentSong().patch.slots[1].gain), padGain, 'the swipe left the fader');
  await ev(() => { document.querySelector('.p-slots').scrollLeft = 0; });
});

test('Sound 5..16 faders write the song; the web engine never hears a slot past 4', async () => {
  await setCount(16);
  await until(() => document.querySelectorAll('.p-slots > .strip:not([hidden])').length === 16);
  const r = await row();
  assert.equal(r.strips, 16);
  assert.deepEqual(r.silent, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  // ON tile of Sound 16: the song's mute flips, the engine is not asked
  await ev(() => document.querySelector('.p-slots').scrollTo({ left: 99999 }));
  await until(() => {
    const a = document.querySelector('.p-slots').getBoundingClientRect();
    const b = document.querySelector('[data-testid=slot-15]').getBoundingClientRect();
    return b.right <= a.right + 1;
  });
  await page.click('[data-testid=slot-on-15]');
  await until(() => window.__rig.store.currentSong().patch.slots[15].muted === true);
  assert.equal(await ev(() => window.__rig.engine.getParam('slots.15.gain')), undefined);
  assert.equal(await ev(() => window.__rig.engine._patch.slots.length), 4, 'the web engine holds four slots');
  await page.click('[data-testid=slot-on-15]');
  await until(() => !window.__rig.store.currentSong().patch.slots[15].muted);
  // range bars: one per strip, packed into the four rows' height
  const bars = await ev(() => {
    const b = document.querySelector('[data-testid=range-bars]');
    const shown = [...b.querySelectorAll('.rbar')].filter((x) => !x.hidden);
    return { dense: b.classList.contains('dense'), n: shown.length,
      bottom: Math.max(...shown.map((x) => x.getBoundingClientRect().bottom)) - b.getBoundingClientRect().top };
  });
  assert.equal(bars.dense, true);
  assert.equal(bars.n, 14, 'Extra and Bass are empty in this song');
  assert.ok(bars.bottom <= 23.5, `bars stay in the 23 px band (${bars.bottom})`);
  await ev(() => { document.querySelector('.p-slots').scrollLeft = 0; });
  await clearToasts();
  await page.screenshot({ path: path.join(shots, 'slots-16.png') });
  // the 2.0 engine plays all 16: no note, nothing silent (an engine that says so; the bridge engine does)
  await ev(() => { window.__rig.engine.maxSlots = 16; window.__rig.store.set('slots.0.pan', 0.01); });
  await until(() => document.querySelector('[data-testid=slots-silent-note]').hidden);
  assert.deepEqual((await row()).silent, []);
  await ev(() => { delete window.__rig.engine.maxSlots; window.__rig.store.set('slots.0.pan', 0); });
  await until(() => !document.querySelector('[data-testid=slots-silent-note]').hidden);
  assert.deepEqual(errors, []);
});

test('a song switch starts the row at its first strip; fewer than four slots show only theirs', async () => {
  await ev(() => { document.querySelector('.p-slots').scrollLeft = 400; });
  const id = await ev(() => window.__rig.store.currentSong().id);
  await ev(() => window.__rig.controller.nextSong());
  await until((x) => window.__rig.controller.status.songId !== x && !window.__rig.controller.status.loading, id, 30000);
  const r = await row();
  assert.equal(r.scroll, false, 'the next song has four slots');
  assert.equal(r.sl, 0);
  assert.deepEqual(r.shown, [0, 1, 2, 3]);
  assert.equal(r.note, false);
  await ev((x) => window.__rig.controller.selectSong(x), id);
  await until((x) => window.__rig.controller.status.songId === x && !window.__rig.controller.status.loading, id, 30000);
  assert.equal((await row()).sl, 0);
  await setCount(2);
  await until(() => document.querySelectorAll('.p-slots > .strip:not([hidden])').length === 2);
  const r2 = await row();
  assert.deepEqual(r2.shown, [0, 1]);
  assert.equal(r2.scroll, false);
  await clearToasts();
  await page.screenshot({ path: path.join(shots, 'slots-2.png') });
  await setCount(4);
  await until(() => document.querySelectorAll('.p-slots > .strip:not([hidden])').length === 4);
  assert.deepEqual(errors, []);
});
