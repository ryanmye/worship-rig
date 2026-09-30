#!/usr/bin/env node
// ui-core Phase 2 test: loads the real app (server.js, app/) in full Chromium (new headless) and drives the
// Perform view, the top bar and the component library. `node test/phase2/ui-core/run.mjs` exits 0 on success.
// Screenshots (1440×900 unless noted) → test/phase2/ui-core/screenshots/.
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
const appDir = path.join(repo, 'app');
const shots = path.join(here, 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const require = createRequire(import.meta.url);
const { createServer } = require('../../../server.js');

// The Edit and Settings views' files; while one is absent the page's own 404 for it is expected, nothing else is.
// (hv2-edit-integrate: the H-v2 Edit replaced views/edit.js.)
const SIBLING_FILES = [
  'styles-edit.css', 'js/views/edit/styles-edit-v2.css', 'js/views/edit/shell.js', 'js/views/settings.js',
];
const missingSiblings = SIBLING_FILES.filter((f) => !fs.existsSync(path.join(appDir, f)));

let server;
let base;
let browser;
let context;
let page;
const consoleErrors = [];

function watchConsole(p, sink) {
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url || '';
    if (/status of 404/.test(m.text()) && missingSiblings.some((f) => url.endsWith(`/${f}`))) return;
    sink.push(`${m.text()} @ ${url}`);
  });
  p.on('pageerror', (e) => sink.push(`pageerror: ${e.message}`));
}

/** In-page helpers (RMS via engine analysers, waits). */
const HELPERS = () => {
  const rmsNow = () => {
    const e = window.__rig.engine;
    let worst = -Infinity;
    for (const an of [e.analyserL, e.analyserR]) {
      if (!an) continue;
      const buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      const db = 10 * Math.log10(s / buf.length + 1e-20);
      if (db > worst) worst = db;
    }
    return worst;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__t = {
    rmsNow,
    sleep,
    /** max RMS (dBFS) seen over `ms` */
    async maxRms(ms) {
      let m = -Infinity;
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        m = Math.max(m, rmsNow());
        await sleep(20);
      }
      return m;
    },
    /** average-ish level: median of RMS samples over `ms` */
    async level(ms = 200) {
      const xs = [];
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        xs.push(rmsNow());
        await sleep(20);
      }
      xs.sort((a, b) => a - b);
      return xs[Math.floor(xs.length / 2)];
    },
    /** first time (ms) the level stays ≤ target for 150 ms, or null after `timeout` */
    async until(target, timeout) {
      const t0 = performance.now();
      let okSince = null;
      while (performance.now() - t0 < timeout) {
        const l = rmsNow();
        if (l <= target) {
          okSince ??= performance.now();
          if (performance.now() - okSince >= 150) return performance.now() - t0;
        } else okSince = null;
        await sleep(20);
      }
      return null;
    },
    slotVoices() {
      const e = window.__rig.engine;
      let v = 0;
      for (const sc of [...e.slots, ...e.retiring]) if (sc) v += sc.inst.liveVoiceCount?.() || 0;
      return v;
    },
  };
};

/** Toasts are click-through overlays; clear them so screenshots show the controls underneath. */
async function clearToasts() {
  await page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()));
}

async function waitSong(id) {
  await page.waitForFunction(
    (sid) => {
      const r = window.__rig;
      const s = r.controller.status;
      return !s.loading && s.songId === sid && r.store.get().settings.currentSongId === sid && r.engine.slots.some(Boolean);
    },
    id,
    { timeout: 30000 },
  );
}

async function currentSong() {
  return page.evaluate(() => {
    const s = window.__rig.store.currentSong();
    return { id: s.id, name: s.name, hearIn: s.hearIn, playIn: s.playIn, index: window.__rig.store.currentIndex() };
  });
}

/** Press and hold (mouse) on a control for `ms` — the H-v2 hold gesture (600 ms). */
async function hold(selector, ms = 780) {
  const b = await page.locator(selector).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
  await page.waitForTimeout(80);
}

/** In-page hold (synthetic pointer events) for tests that run inside page.evaluate. */
const HOLD_IN_PAGE = () => {
  window.__holdEl = async (el, ms = 720) => {
    const o = { bubbles: true, pointerId: 7, button: 0, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    await new Promise((res) => setTimeout(res, ms));
    el.dispatchEvent(new PointerEvent('pointerup', o));
  };
};

/**
 * noteOn(60) → sound within 500 ms, noteOff → silence (release allowed).
 * Main output (engine.analyserL/R) must exceed −50 dBFS. Because a drone and reverb tails also live on the main
 * output, the note itself is judged on taps of the current slots' channel strips (post fader + wheel, pre FX):
 * they must carry > −50 dBFS within 500 ms and fall below −70 dBFS within 8 s of noteOff.
 */
async function assertSoundAndRelease(label) {
  const r = await page.evaluate(async () => {
    const t = window.__t;
    const e = window.__rig.engine;
    const c = window.__rig.controller;
    const taps = e.slots.filter(Boolean).map((sc) => {
      const an = new AnalyserNode(e.ctx, { fftSize: 2048 });
      sc.strip.pan.connect(an);
      return { an, sc };
    });
    const tapRms = () => {
      let worst = -Infinity;
      const buf = new Float32Array(2048);
      for (const { an } of taps) {
        an.getFloatTimeDomainData(buf);
        let s2 = 0;
        for (let i = 0; i < buf.length; i++) s2 += buf[i] * buf[i];
        worst = Math.max(worst, 10 * Math.log10(s2 / buf.length + 1e-20));
      }
      return worst;
    };
    const tapBefore = tapRms();
    c.perform.noteOn(60, 100);
    let mainPeak = -Infinity;
    let tapPeak = -Infinity;
    const t0 = performance.now();
    while (performance.now() - t0 < 500) {
      mainPeak = Math.max(mainPeak, t.rmsNow());
      tapPeak = Math.max(tapPeak, tapRms());
      await t.sleep(20);
    }
    c.perform.noteOff(60);
    const t1 = performance.now();
    let tookMs = null;
    let quietSince = null;
    while (performance.now() - t1 < 8000) {
      if (tapRms() < -70) {
        quietSince ??= performance.now();
        if (performance.now() - quietSince > 150) {
          tookMs = quietSince - t1;
          break;
        }
      } else quietSince = null;
      await t.sleep(25);
    }
    for (const { an, sc } of taps) {
      try {
        sc.strip.pan.disconnect(an);
      } catch {
        /* retired */
      }
    }
    return { mainPeak, tapPeak, tapBefore, tookMs, sounding: e.sounding.size };
  });
  assert.ok(r.mainPeak > -50, `${label}: output peak ${r.mainPeak.toFixed(1)} dBFS should exceed −50 dBFS`);
  assert.ok(r.tapPeak > -50, `${label}: the note reaches ${r.tapPeak.toFixed(1)} dBFS on the slot strips within 500 ms (expected > −50)`);
  assert.ok(r.tapBefore < -70, `${label}: slots silent before the note (${r.tapBefore.toFixed(1)})`);
  assert.notEqual(r.tookMs, null, `${label}: slot output did not fall below −70 dBFS within 8 s after noteOff`);
  assert.equal(r.sounding, 0, `${label}: sounding map should be empty after noteOff`);
  return r;
}

before(async () => {
  server = createServer({ appDir, port: 20000 + Math.floor(Math.random() * 20000) });
  const info = await server.listen();
  base = info.url;
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await pinTheme(context, 'classic'); // theme-classic: this suite asserts the base look (Classic tokens/metrics)
  try {
    await context.grantPermissions(['midi'], { origin: base.replace(/\/$/, '') });
  } catch (err) {
    console.log(`# grantPermissions(midi) not supported here: ${err.message}`);
  }
  // Chrome's save dialog can't be driven headless: make REC use the OPFS sink (the no-picker Chrome fallback).
  await context.addInitScript(() => {
    try {
      delete window.showSaveFilePicker;
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
    } catch {
      /* ignore */
    }
  });
  page = await context.newPage();
  watchConsole(page, consoleErrors);
  await page.goto(base);
  await page.waitForFunction(() => !!window.__rig, null, { timeout: 20000 });
  await page.evaluate(HELPERS);
  await page.evaluate(HOLD_IN_PAGE);
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test('boots: overlay (if shown) starts audio, controller becomes ready, favicon + mount points present', async () => {
  const overlayVisible = await page.isVisible('#overlay-start');
  if (overlayVisible) await page.click('#overlay-start');
  await page.waitForFunction(() => window.__rig.engine.ctx?.state === 'running', null, { timeout: 15000 });
  await page.waitForFunction(() => window.__rig.controller.status.ready === true, null, { timeout: 90000 });
  assert.equal(await page.isVisible('#overlay-start'), false, 'overlay hidden once audio runs');
  const dom = await page.evaluate(() => ({
    icon: document.querySelector('link[rel=icon]')?.getAttribute('href'),
    editCss: !!document.querySelector('link[rel=stylesheet][href="./styles-edit.css"]'),
    mounts: ['view-perform', 'view-edit', 'view-settings', 'toasts', 'overlay-start'].map((id) => !!document.getElementById(id)),
    editHidden: document.getElementById('view-edit').hidden,
    settingsHidden: document.getElementById('view-settings').hidden,
    songs: window.__rig.store.navIds().length,
  }));
  assert.ok(dom.icon && dom.icon.endsWith('.svg'));
  const iconRes = await page.request.get(new URL(dom.icon, base).href);
  assert.equal(iconRes.status(), 200);
  assert.ok(dom.editCss, 'styles-edit.css is linked for ui-edit');
  assert.deepEqual(dom.mounts, [true, true, true, true, true]);
  assert.equal(dom.editHidden, true);
  assert.equal(dom.settingsHidden, true);
  assert.ok(dom.songs >= 11, `factory setlist seeded (${dom.songs} songs)`);
  const size = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.song-name')).fontSize));
  const keySize = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.song-key')).fontSize));
  assert.ok(size >= 40, `song name ${size}px ≥ 40px`);
  assert.ok(keySize >= 32, `key ${keySize}px ≥ 32px`);
});

test('every factory song: select from the setlist strip → sound on noteOn(60) → release', async () => {
  const ids = await page.evaluate(() => window.__rig.store.navIds());
  const names = [];
  for (let i = 0; i < ids.length; i++) {
    await page.click(`[data-testid=setlist] .setlist-chip[data-index="${i}"]`);
    await waitSong(ids[i]);
    const s = await currentSong();
    assert.equal(s.index, i);
    assert.equal((await page.textContent('[data-testid=song-name]')).trim(), s.name);
    assert.equal(await page.getAttribute(`[data-testid=setlist] .setlist-chip[data-index="${i}"]`, 'aria-current'), 'true');
    const r = await assertSoundAndRelease(s.name);
    names.push(`${s.name}: out ${r.mainPeak.toFixed(1)} dBFS, slots ${r.tapPeak.toFixed(1)} dBFS, silent ${Math.round(r.tookMs)} ms after noteOff`);
  }
  console.log(`# ${names.join('\n# ')}`);
});

test('next / prev buttons step through the setlist and play', async () => {
  await page.click('[data-testid=setlist] .setlist-chip[data-index="0"]');
  const ids = await page.evaluate(() => window.__rig.store.navIds());
  await waitSong(ids[0]);
  assert.equal(await page.isDisabled('[data-testid=prev-song]'), true, 'prev disabled on the first song');
  await page.click('[data-testid=next-song]');
  await waitSong(ids[1]);
  await page.click('[data-testid=next-song]');
  await waitSong(ids[2]);
  await assertSoundAndRelease('after next');
  await page.click('[data-testid=prev-song]');
  await waitSong(ids[1]);
  await assertSoundAndRelease('after prev');
  assert.equal((await currentSong()).index, 1);
  // buttons don't keep focus after a pointer click (Space = sustain)
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
});

test('slot fader drag → engine.getParam(slots.1.gain) + store + localStorage; no double-click reset in Perform', async () => {
  const ids = await page.evaluate(() => window.__rig.store.navIds());
  await page.click('[data-testid=setlist] .setlist-chip[data-index="0"]');
  await waitSong(ids[0]);
  const before = await page.evaluate(() => window.__rig.engine.getParam('slots.1.gain'));
  const box = await page.locator('[data-testid=slot-fader-1] input').boundingBox();
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + box.height * 0.5);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(x, box.y + box.height * (0.5 - 0.035 * k));
  await page.mouse.up();
  await page.waitForTimeout(150);
  const r = await page.evaluate(() => {
    const s = window.__rig.store.currentSong();
    return { engine: window.__rig.engine.getParam('slots.1.gain'), store: s.patch.slots[1].gain, id: s.id, label: document.querySelector('[data-testid=slot-fader-1] .fader-value').textContent };
  });
  assert.notEqual(r.engine, before, 'engine gain changed');
  assert.ok(r.engine > before, `dragging up raises the gain (${before} → ${r.engine})`);
  assert.ok(Math.abs(r.engine - r.store) < 1e-9, 'engine == store');
  assert.match(r.label, /dB$/);
  const persisted = await page.evaluate(async (id) => {
    window.__rig.store.persistNow();
    const doc = JSON.parse(localStorage.getItem('rig.v1'));
    return doc.songs[id].patch.slots[1].gain;
  }, r.id);
  assert.ok(Math.abs(persisted - r.store) < 1e-9, 'persisted to localStorage');
  // focus released after the drag (computer keyboard keeps playing)
  assert.equal(await page.evaluate(() => document.activeElement?.type === 'range'), false);
  // double-click in Perform does NOT reset (UX B2: a double-tap must not jump the level)
  const beforeDbl = await page.evaluate(() => window.__rig.engine.getParam('slots.1.gain'));
  await page.dblclick('[data-testid=slot-fader-1] input');
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__rig.engine.getParam('slots.1.gain')), beforeDbl, 'dblclick leaves the level alone in Perform');
  await page.evaluate(() => window.__rig.store.set(`songs.${window.__rig.store.currentSong().id}.patch.slots.1.gain`, 0.8));
  await page.waitForTimeout(50);
  // the ON tile is the mute (H-v2): toggles to 0 and back (remembering the level); Slot.muted is first-class
  await page.click('[data-testid=slot-on-1]');
  await page.waitForTimeout(80);
  const mutedState = await page.evaluate(() => {
    const sl = window.__rig.store.currentSong().patch.slots[1];
    const f = document.querySelector('[data-testid=slot-fader-1]');
    return { gain: window.__rig.engine.getParam('slots.1.gain'), muted: sl.muted, before: sl.gainBeforeMute ?? sl.mutedGain, color: getComputedStyle(f).getPropertyValue('--fader-color').trim(), card: document.querySelector('[data-testid=slot-1]').classList.contains('muted'), shown: f.querySelector('.fader-value').textContent };
  });
  assert.equal(mutedState.gain, 0);
  assert.equal(mutedState.muted, true, 'store keeps Slot.muted');
  assert.equal(mutedState.before, 0.8);
  assert.equal(mutedState.color, '#707a88', `muted fader loses its slot colour (UX M3), got ${mutedState.color}`);
  assert.equal(mutedState.card, true, 'slot card marked muted');
  assert.match(mutedState.shown, /dB$/, 'muted fader still shows the remembered level');
  assert.equal(await page.getAttribute('[data-testid=slot-on-1]', 'aria-pressed'), 'false', 'the tile reads OFF');
  await page.click('[data-testid=slot-on-1]');
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.__rig.engine.getParam('slots.1.gain')), 0.8);
  assert.equal(await page.evaluate(() => window.__rig.store.currentSong().patch.slots[1].muted), undefined, 'unmuted: no mute fields');
  // keyboard: focused fader + ArrowUp nudges, and ← doesn't change the song
  const song = (await currentSong()).id;
  await page.focus('[data-testid=slot-fader-1] input');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(80);
  const k = await page.evaluate(() => window.__rig.engine.getParam('slots.1.gain'));
  assert.equal((await currentSong()).id, song, 'arrows on a focused fader do not switch songs');
  assert.ok(Math.abs(k - 0.8) < 1e-9, 'up then left (down) returns to 0.8');
  await page.evaluate(() => document.activeElement.blur());
});

test('key grid → song key (store) → engine.drone.key; displayed key updates', async () => {
  const ids = await page.evaluate(() => window.__rig.store.navIds());
  await page.click('[data-testid=setlist] .setlist-chip[data-index="0"]');
  await waitSong(ids[0]);
  await page.click('[data-testid=key-grid] [data-pc="7"]');
  await page.waitForFunction(() => window.__rig.engine.drone?.key?.pc === 7, null, { timeout: 3000 });
  const s = await currentSong();
  assert.equal(s.hearIn, 7);
  assert.equal((await page.textContent('[data-testid=song-key]')).trim(), 'G');
  assert.equal(await page.getAttribute('[data-testid=key-grid] [data-pc="7"]', 'aria-checked'), 'true');
  // minor
  await page.click('[data-testid=key-quality] [data-value="true"]');
  await page.waitForFunction(() => window.__rig.engine.drone?.key?.minor === true, null, { timeout: 3000 });
  assert.equal((await page.textContent('[data-testid=song-key]')).trim(), 'Gm');
  assert.equal((await page.textContent('[data-testid=key-grid] [data-pc="1"]')).trim(), 'C#m');
  await page.click('[data-testid=key-quality] [data-value="false"]');
  await page.click('[data-testid=key-grid] [data-pc="0"]');
  await page.waitForFunction(() => window.__rig.engine.drone?.key?.pc === 0 && !window.__rig.engine.drone.key.minor, null, { timeout: 3000 });
  // drone: the ON tile turns it off and back on (to the source it had); Synth / My Pads picks the source
  await page.click('[data-testid=drone-mode] [data-value="synth"]');
  await page.waitForFunction(() => window.__rig.engine.drone.cfg.mode === 'synth');
  await page.click('[data-testid=drone-on]');
  await page.waitForFunction(() => window.__rig.store.currentSong().drone.mode === 'off' && window.__rig.engine.drone.cfg.mode === 'off');
  assert.equal(await page.getAttribute('[data-testid=drone-on]', 'aria-pressed'), 'false');
  assert.equal(await page.isVisible('[data-testid=drone-follow]'), false, 'chord-follow only in synth mode');
  await page.click('[data-testid=drone-on]');
  await page.waitForFunction(() => window.__rig.engine.drone.cfg.mode === 'synth');
  assert.equal(await page.isVisible('[data-testid=drone-follow]'), true);
  // the tile remembers the source it switched off (OPTIONS.md round-3 fix 5; no new store field)
  await page.click('[data-testid=drone-mode] [data-value="files"]');
  await page.waitForFunction(() => window.__rig.store.currentSong().drone.mode === 'files');
  await page.click('[data-testid=drone-on]');
  await page.waitForFunction(() => window.__rig.store.currentSong().drone.mode === 'off');
  await page.click('[data-testid=drone-on]');
  await page.waitForFunction(() => window.__rig.store.currentSong().drone.mode === 'files');
  await page.click('[data-testid=drone-mode] [data-value="synth"]');
  await page.waitForFunction(() => window.__rig.engine.drone.cfg.mode === 'synth');
});

test('Swell raises the wheel value over time; pressing again returns', async () => {
  const r = await page.evaluate(async () => {
    const e = window.__rig.engine;
    const t = window.__t;
    document.querySelector('.swell-btn').click();
    await t.sleep(300);
    const a = e.wheelValues().mod;
    await t.sleep(1200);
    const b = e.wheelValues();
    const shown = document.querySelector('.wheel-value').textContent;
    const pressed = document.querySelector('.swell-btn').getAttribute('aria-pressed');
    document.querySelector('.swell-btn').click();
    await t.sleep(300);
    return { a, b: b.mod, swelling: b.swelling, shown, pressed };
  });
  assert.ok(r.b > r.a + 0.05, `wheel rises (${r.a.toFixed(3)} → ${r.b.toFixed(3)})`);
  assert.equal(r.swelling, true);
  assert.equal(r.pressed, 'true');
  // the strip repaints on the next animation frame; under CPU load it can trail the engine by a frame or two
  assert.ok(Math.abs(parseInt(r.shown, 10) - r.b * 100) <= 5, `strip shows ${r.shown} ≈ ${Math.round(r.b * 100)}%`);
});

test('transpose −/+ updates the displayed key, the song and engine.transpose', async () => {
  const s0 = await currentSong();
  assert.equal(s0.hearIn, s0.playIn);
  await page.click('[data-testid=transpose-up]');
  await page.waitForFunction(() => window.__rig.engine.transpose === 1);
  assert.equal((await page.textContent('[data-testid=transpose-val]')).trim(), '+1');
  assert.equal((await page.textContent('[data-testid=song-key]')).trim(), 'Db');
  assert.equal(await page.isVisible('[data-testid=song-playin]'), true, 'shows "you play …" when transposed');
  assert.match(await page.textContent('[data-testid=song-playin]'), /you play C/);
  assert.equal(await page.isVisible('[data-testid=song-bpm]'), false, 'the "you play X · BPM" line gives way to the pill');
  await page.click('[data-testid=transpose-down]');
  await page.click('[data-testid=transpose-down]');
  await page.waitForFunction(() => window.__rig.engine.transpose === -1);
  assert.equal((await page.textContent('[data-testid=transpose-val]')).trim(), '−1');
  assert.equal((await page.textContent('[data-testid=song-key]')).trim(), 'B');
  await page.click('[data-testid=transpose-up]');
  await page.waitForFunction(() => window.__rig.engine.transpose === 0);
  assert.equal(await page.isVisible('[data-testid=song-playin]'), false);
});

test('Panic cuts held + pedaled voices', async () => {
  const ids = await page.evaluate(() => window.__rig.store.navIds());
  const idx = await page.evaluate(() => window.__rig.store.navIds().findIndex((id) => window.__rig.store.getSong(id).name === 'Building Swell'));
  await page.click(`[data-testid=setlist] .setlist-chip[data-index="${idx}"]`);
  await waitSong(ids[idx]);
  const held = await page.evaluate(async () => {
    const c = window.__rig.controller;
    const t = window.__t;
    c.perform.sustain(true);
    for (const n of [48, 55, 60, 64]) c.perform.noteOn(n, 100);
    await t.sleep(900);
    for (const n of [48, 55, 60, 64]) c.perform.noteOff(n);
    await t.sleep(200);
    return { level: await t.level(200), voices: t.slotVoices(), pedaled: window.__rig.engine.pedaled.size };
  });
  assert.ok(held.voices > 0 && held.pedaled > 0, 'pedal holds the chord');
  await page.click('[data-testid=panic]');
  const r = await page.evaluate(async () => {
    const t = window.__t;
    await t.sleep(400);
    const v = t.slotVoices();
    await t.sleep(1100);
    return { voices: v, level: await t.level(200), pedaled: window.__rig.engine.pedaled.size, pedal: window.__rig.engine.pedal };
  });
  assert.equal(r.voices, 0, 'no live voices 400 ms after Panic');
  assert.equal(r.pedaled, 0);
  assert.equal(r.pedal, false);
  assert.ok(r.level < held.level - 10, `level falls ≥ 10 dB (${held.level.toFixed(1)} → ${r.level.toFixed(1)})`);
});

test('REC start/stop changes state, runs the timer and saves (OPFS fallback in headless Chrome)', async () => {
  const dl = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await page.click('#btn-rec');
  await page.waitForFunction(() => window.__rig.controller.status.recording === true, null, { timeout: 10000 });
  assert.equal(await page.getAttribute('#btn-rec', 'aria-pressed'), 'true');
  await page.evaluate(() => window.__rig.controller.perform.noteOn(67, 90));
  await page.waitForTimeout(1300);
  await page.evaluate(() => window.__rig.controller.perform.noteOff(67));
  assert.match(await page.textContent('#rec-time'), /^00:0[1-9]$/);
  await page.click('#btn-rec');
  await page.waitForFunction(() => window.__rig.controller.status.recording === false && window.__rig.recorder.state === 'idle', null, { timeout: 10000 });
  assert.equal(await page.getAttribute('#btn-rec', 'aria-pressed'), 'false');
  await page.waitForSelector('.toast[data-kind=ok]', { timeout: 5000 });
  const d = await dl;
  if (d) assert.match(d.suggestedFilename(), /^Rig .*\.wav$/);
});

test('views: Edit switch shows #view-edit; Settings opens/closes; Perform lock (H-v2 LOCK table): live / hold / frozen', async () => {
  await page.click('[data-testid=view-switch] [data-value="edit"]');
  await page.waitForFunction(() => !document.getElementById('view-edit').hidden && document.getElementById('view-perform').hidden);
  assert.equal(await page.evaluate(() => window.__rig.store.get().settings.view), 'edit');
  assert.equal(await page.isVisible('#btn-quick'), false, 'Quick is a Perform control');
  await page.click('[data-testid=view-switch] [data-value="perform"]');
  await page.waitForFunction(() => document.getElementById('view-edit').hidden && !document.getElementById('view-perform').hidden);
  await page.click('#btn-settings');
  assert.equal(await page.isVisible('#view-settings'), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#view-settings'), false, 'Esc closes Settings');
  // lock
  await page.click('[data-testid=perform-lock]');
  await page.waitForFunction(() => window.__rig.store.get().settings.performLock === true);
  assert.equal(await page.isDisabled('[data-testid=view-switch] [data-value="edit"]'), true);
  assert.equal(await page.isDisabled('#btn-settings'), true);
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=setlist]').classList.contains('locked')), true);
  assert.equal(await page.evaluate(() => document.querySelector('.setlist-chip').draggable), false);
  // ⌘E / ctx.setView while locked stays in Perform
  assert.equal(await page.evaluate(() => window.__rig.ctx.setView('edit')), false);
  assert.equal(await page.evaluate(() => document.getElementById('view-perform').hidden), false);
  // frozen: soundcheck / file-level controls; live: playing moves; hold: key, transpose, Revert (concept §1.3)
  const state = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const all = (s) => [...document.querySelectorAll(s)];
    return {
      mode: all('[data-testid=drone-mode] .seg').every((b) => b.disabled),
      follow: q('[data-testid=drone-follow]').disabled,
      cont: q('[data-testid=drone-continue]').disabled,
      brightness: q('[data-testid=drone-brightness] input').disabled,
      movement: q('[data-testid=drone-movement] input').disabled,
      grid: all('[data-testid=key-grid] .key-btn').some((b) => b.disabled),
      quality: all('[data-testid=key-quality] .seg').some((b) => b.disabled),
      tUp: q('[data-testid=transpose-up]').disabled,
      key: q('[data-testid=key-button]').disabled,
      fader: q('[data-testid=slot-fader-0] input').disabled,
      tile: q('[data-testid=slot-on-0]').disabled,
      chip: q('[data-testid=slot-space-0]').disabled,
      sustain: q('[data-testid=slot-sustain-0]').disabled,
      headerFx: all('[data-testid=space-row] .fxc, [data-testid=echo-row] .fxc').some((b) => b.disabled),
      droneTile: q('[data-testid=drone-on]').disabled,
      wheel: q('.wheel-input').disabled,
      droneLevel: q('[data-testid=drone-gain] input').disabled,
      panic: q('[data-testid=panic]').disabled,
      holdTags: all('.perform .hold-tag').filter((t) => t.offsetParent).length,
    };
  });
  const { holdTags, ...flags } = state;
  assert.deepEqual(flags, { mode: true, follow: true, cont: true, brightness: true, movement: true, grid: false, quality: false, tUp: false, key: false, fader: false, tile: false, chip: false, sustain: false, headerFx: false, droneTile: false, wheel: false, droneLevel: false, panic: false });
  assert.ok(holdTags >= 3, `HOLD tags on KEY, Transpose and Revert while locked (${holdTags})`);
  // live: an ON tile and a strip chip still write the song
  const sus0 = await page.evaluate(() => window.__rig.store.currentSong().patch.slots[0].sustain);
  await page.click('[data-testid=slot-sustain-0]');
  await page.waitForFunction((v) => window.__rig.store.currentSong().patch.slots[0].sustain === !v, sus0);
  await page.click('[data-testid=slot-sustain-0]');
  await page.waitForFunction((v) => window.__rig.store.currentSong().patch.slots[0].sustain === v, sus0);
  await page.click('[data-testid=slot-on-0]');
  await page.waitForFunction(() => window.__rig.store.currentSong().patch.slots[0].muted === true);
  await page.click('[data-testid=slot-on-0]');
  await page.waitForFunction(() => !window.__rig.store.currentSong().patch.slots[0].muted);
  // hold: a tap on the key grid / Transpose does nothing; a 600 ms hold does it
  const keyBefore = await page.evaluate(() => window.__rig.store.currentSong().hearIn);
  const other = (keyBefore + 9) % 12;
  await page.click(`[data-testid=key-grid] [data-pc="${other}"]`);
  await page.click('[data-testid=transpose-up]');
  await page.waitForTimeout(120);
  assert.equal(await page.evaluate(() => window.__rig.store.currentSong().hearIn), keyBefore, 'a tap cannot re-key the song while locked');
  assert.equal(await page.evaluate(() => window.__rig.engine.transpose), 0, 'a tap on Transpose does nothing while locked');
  assert.equal(await page.evaluate(() => document.querySelector('.drone-lockline').classList.contains('hint')), true, 'the short tap flashes the hold hint');
  // a 250 ms press is not enough
  await hold(`[data-testid=key-grid] [data-pc="${other}"]`, 250);
  assert.equal(await page.evaluate(() => window.__rig.store.currentSong().hearIn), keyBefore);
  await hold(`[data-testid=key-grid] [data-pc="${other}"]`);
  await page.waitForFunction((k) => window.__rig.store.currentSong().hearIn === k && window.__rig.engine.drone?.key?.pc === k, other, { timeout: 3000 });
  await hold('[data-testid=transpose-up]');
  await page.waitForFunction(() => window.__rig.engine.transpose === 1);
  await clearToasts();
  await page.mouse.move(700, 450);
  await page.screenshot({ path: path.join(shots, 'perform-locked.png') });
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shots, 'perform-locked-1024.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await hold('[data-testid=transpose-down]');
  await page.waitForFunction(() => window.__rig.engine.transpose === 0);
  await hold(`[data-testid=key-grid] [data-pc="${keyBefore}"]`);
  await page.waitForFunction((k) => window.__rig.store.currentSong().hearIn === k, keyBefore);
  // Major/Minor holds too
  const minor0 = await page.evaluate(() => window.__rig.store.currentSong().minor);
  await page.click(`[data-testid=key-quality] [data-value="${!minor0}"]`);
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.__rig.store.currentSong().minor), minor0);
  await hold(`[data-testid=key-quality] [data-value="${!minor0}"]`);
  await page.waitForFunction((m) => window.__rig.store.currentSong().minor === !m, minor0);
  await hold(`[data-testid=key-quality] [data-value="${minor0}"]`);
  await page.waitForFunction((m) => window.__rig.store.currentSong().minor === m, minor0);
  // a short click does NOT unlock (UX S1) …
  await page.click('[data-testid=perform-lock]');
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => window.__rig.store.get().settings.performLock), true, 'a short click keeps the lock');
  assert.match(await page.textContent('[data-testid=perform-lock]'), /hold to unlock/i);
  // … a 600 ms hold does
  const lb = await page.locator('[data-testid=perform-lock]').boundingBox();
  await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.__rig.store.get().settings.performLock), true, 'still locked 250 ms into the hold');
  await page.waitForTimeout(550);
  await page.mouse.up();
  await page.waitForFunction(() => window.__rig.store.get().settings.performLock === false);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__rig.store.get().settings.performLock), false, 'the click after the hold does not re-lock');
  assert.equal(await page.isDisabled('[data-testid=view-switch] [data-value="edit"]'), false);
  assert.equal(await page.isDisabled('[data-testid=drone-mode] [data-value="synth"]'), false);
  // unlocked, the key grid is one tap again
  await page.click(`[data-testid=key-grid] [data-pc="${other}"]`);
  await page.waitForFunction((k) => window.__rig.store.currentSong().hearIn === k, other);
  await page.click(`[data-testid=key-grid] [data-pc="${keyBefore}"]`);
  await page.waitForFunction((k) => window.__rig.store.currentSong().hearIn === k, keyBefore);
});

/** Fader position (0..1) for a slot gain (taper 2·pos³). */
const gainPos = (g) => Math.cbrt(Math.max(0, g) / 2);

test('relative-drag faders: a tap never jumps; movement is a delta; Shift = fine; wheel too', async () => {
  const ids = await page.evaluate(() => window.__rig.store.navIds());
  await page.click('[data-testid=setlist] .setlist-chip[data-index="0"]');
  await waitSong(ids[0]);
  const gain = () => page.evaluate(() => window.__rig.store.currentSong().patch.slots[0].gain);
  const box = await page.locator('[data-testid=slot-fader-0] input').boundingBox();
  const x = box.x + box.width / 2;
  const g0 = await gain();
  // pointer down at the very top end of the track, then release: < 2 % change
  await page.mouse.move(x, box.y + 3);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(80);
  const g1 = await gain();
  assert.ok(Math.abs(gainPos(g1) - gainPos(g0)) < 0.02, `tap at the track top moved the fader ${(gainPos(g1) - gainPos(g0)).toFixed(3)} (expected < 0.02)`);
  // and at the bottom end
  await page.mouse.move(x, box.y + box.height - 3);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(80);
  assert.ok(Math.abs(gainPos(await gain()) - gainPos(g0)) < 0.02, 'tap at the track bottom does not jump either');
  // drag down by 20 % of the track from wherever you grab it → position −0.20
  const y0 = box.y + box.height * 0.3;
  await page.mouse.move(x, y0);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(x, y0 + box.height * 0.02 * k);
  await page.mouse.up();
  await page.waitForTimeout(80);
  const g2 = await gain();
  const moved = gainPos(g2) - gainPos(g0);
  assert.ok(Math.abs(moved + 0.2) < 0.03, `a 20 % drag moves the fader by −0.20 (got ${moved.toFixed(3)})`);
  // Shift: fine (¼)
  await page.keyboard.down('Shift');
  await page.mouse.move(x, y0);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(x, y0 - box.height * 0.02 * k);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(80);
  const fine = gainPos(await gain()) - gainPos(g2);
  assert.ok(Math.abs(fine - 0.05) < 0.02, `Shift-drag of 20 % moves 5 % (got ${fine.toFixed(3)})`);
  // the drag ends outside the track (pointer capture) without sticking
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=slot-fader-0] input').classList.contains('dragging')), false);
  // wheel strip: a tap on the empty top of the track doesn't swell the pad
  await page.evaluate(() => window.__rig.controller.perform.wheel(0.3));
  await page.waitForTimeout(80);
  const wb = await page.locator('.wheel-input').boundingBox();
  await page.mouse.move(wb.x + wb.width / 2, wb.y + 4);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(80);
  const wv = await page.evaluate(() => window.__rig.engine.wheelValues().mod);
  assert.ok(Math.abs(wv - 0.3) < 0.02, `wheel tap does not jump (0.3 → ${wv.toFixed(3)})`);
  await page.evaluate(() => window.__rig.controller.perform.wheel(1));
  // restore
  await page.evaluate((g) => window.__rig.store.set(`songs.${window.__rig.store.currentSong().id}.patch.slots.0.gain`, g), g0);
});

test('Esc: Panic only in Perform with nothing focused and no dialog; otherwise it cancels / lets go', async () => {
  await page.evaluate(() => {
    window.__panics = 0;
    window.__rig.controller.addEventListener('action', (e) => {
      if (e.detail?.type === 'panic') window.__panics += 1;
    });
    document.activeElement?.blur?.();
  });
  const panics = () => page.evaluate(() => window.__panics);
  await page.keyboard.press('Escape');
  assert.equal(await panics(), 1, 'Perform + nothing focused: Esc = Panic');
  // a focused control: the first Esc only releases focus
  await page.focus('[data-testid=slot-fader-1] input');
  await page.keyboard.press('Escape');
  assert.equal(await panics(), 1, 'Esc on a focused fader does not panic');
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true, 'focus released');
  await page.keyboard.press('Escape');
  assert.equal(await panics(), 2, 'second Esc panics');
  // Perform overlays (step panel, Sing it in…, Quick): Esc closes the overlay and never panics (round-3 fix 4)
  for (const [open, sel] of [
    ['[data-testid=slot-space-0]', '.step-panel'],
    ['[data-testid=key-button]', '[data-testid=sing-it-in]'],
    ['#btn-quick', '[data-testid=quick-sheet]'],
  ]) {
    await page.click(open);
    await page.waitForSelector(sel, { state: 'visible' });
    await page.keyboard.press('Escape');
    await page.waitForSelector(sel, { state: 'hidden' });
    assert.equal(await panics(), 2, `Esc closing ${sel} does not panic`);
  }
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Escape');
  assert.equal(await panics(), 3, 'with nothing open, Esc panics again');
  // Settings open: Esc closes it, no panic
  await page.click('#btn-settings');
  assert.equal(await page.isVisible('#view-settings'), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#view-settings'), false);
  assert.equal(await panics(), 3, 'Esc closing Settings does not panic');
  // Edit view: never panics (⌘. stays the global panic)
  await page.evaluate(() => window.__rig.ctx.setView('edit'));
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Escape');
  assert.equal(await panics(), 3, 'Esc in Edit does not panic');
  await page.keyboard.press('Control+Period');
  assert.equal(await panics(), 4, '⌘/Ctrl+. still panics everywhere');
  await page.evaluate(() => window.__rig.ctx.setView('perform'));
  await page.waitForFunction(() => !document.getElementById('view-perform').hidden);
});

test('banners: stalled sound (48 px Restart), second window, library not saving, newer-library offer', async () => {
  await clearToasts();
  const fake = (patch) => page.evaluate((p) => {
    const c = window.__rig.controller;
    c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status, ...p } }));
  }, patch);
  const real = () => page.evaluate(() => {
    const c = window.__rig.controller;
    c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status } }));
  });
  await fake({ audio: 'stalled' });
  await page.waitForSelector('#audio-banner', { state: 'visible' });
  const m = await page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect();
    const b = r(document.getElementById('audio-banner'));
    const btn = r(document.getElementById('btn-restart-audio'));
    const tb = r(document.getElementById('topbar'));
    const ready = r(document.getElementById('ready-status'));
    return { top: b.top, tbBottom: tb.bottom, width: b.width, vw: innerWidth, btnH: btn.height, btnInsideTopbar: btn.top < tb.bottom, readyOverlap: !(btn.right < ready.left || btn.left > ready.right || btn.bottom < ready.top || btn.top > ready.bottom), text: document.getElementById('audio-banner').textContent, role: document.getElementById('audio-banner').getAttribute('role'), audioText: document.getElementById('audio-text').textContent, toasts: document.querySelectorAll('#toasts .toast').length };
  });
  assert.ok(m.top >= m.tbBottom - 1, 'banner sits under the top bar');
  assert.ok(m.width >= m.vw - 2, 'full width');
  assert.ok(m.btnH >= 48, `Restart button ${m.btnH}px ≥ 48`);
  assert.equal(m.btnInsideTopbar, false);
  assert.equal(m.readyOverlap, false, 'Restart no longer collides with READY (UX B1)');
  assert.equal(m.role, 'alert');
  assert.match(m.text, /Sound stopped/);
  assert.doesNotMatch(m.text, /AudioContext|suspended/i, 'no jargon');
  assert.equal(m.audioText, 'Stopped');
  await page.screenshot({ path: path.join(shots, 'perform-stalled.png') });
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(150);
  const fit = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight }));
  assert.ok(fit.sw <= 1024 && fit.sh <= 700, `banner layout fits 1024×700 (${fit.sw}×${fit.sh})`);
  await page.screenshot({ path: path.join(shots, 'perform-stalled-1024.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await real();
  await page.waitForSelector('#audio-banner', { state: 'hidden' });
  // second window: persistent banner (not a toast)
  await fake({ instance: 'secondary', instanceMessage: 'Another Worship Rig window is open — this one is read-only and muted.' });
  await page.waitForSelector('[data-testid=banner-instance]', { state: 'visible' });
  await page.waitForTimeout(100);
  assert.match(await page.textContent('[data-testid=banner-instance]'), /Another Worship Rig window/);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].some((t) => /another worship rig/i.test(t.textContent))), false, 'not a toast');
  await real();
  await page.waitForSelector('[data-testid=banner-instance]', { state: 'detached' });
  // library not saving
  await fake({ library: { readOnly: false, readOnlyReason: null, persistError: 'QuotaExceededError' } });
  await page.waitForSelector('[data-testid=banner-library]', { state: 'visible' });
  assert.doesNotMatch(await page.textContent('[data-testid=banner-library]'), /Quota/, 'no raw error text');
  await real();
  await page.waitForSelector('[data-testid=banner-library]', { state: 'detached' });
  // newer library from another port: offer calls controller.importLatestBackup
  await page.evaluate(() => {
    const c = window.__rig.controller;
    window.__imp = 0;
    window.__origImport = c.importLatestBackup;
    c.importLatestBackup = async () => {
      window.__imp += 1;
      return { ok: true, songIds: [] };
    };
  });
  await fake({ otherLibrary: { origin: 'http://127.0.0.1:8439', savedAt: Date.now() - 3600e3, path: '/tmp/b.json' } });
  await page.waitForSelector('[data-testid=import-latest-backup]', { state: 'visible' });
  await page.click('[data-testid=import-latest-backup]');
  await page.waitForFunction(() => window.__imp === 1);
  await page.waitForSelector('[data-testid=banner-other-library]', { state: 'detached' });
  await page.evaluate(() => {
    window.__rig.controller.importLatestBackup = window.__origImport;
  });
  await real();
  await clearToasts();
});

test('Revert: counts the changed switches (not faders / mutes), needs a 600 ms hold, restores fader, key and drone', async () => {
  const ids = await page.evaluate(() => window.__rig.store.navIds());
  await page.click('[data-testid=setlist] .setlist-chip[data-index="2"]');
  await waitSong(ids[2]);
  const s0 = await page.evaluate(() => {
    const s = window.__rig.store.currentSong();
    const i = s.patch.slots.findIndex(Boolean);
    return { i, gain: s.patch.slots[i].gain, reverb: s.patch.slots[i].sends.reverb, hearIn: s.hearIn, mode: s.drone.mode };
  });
  assert.equal(await page.isDisabled('[data-testid=revert-song]'), true, 'nothing to revert yet');
  const count = () => page.evaluate(() => document.querySelector('[data-testid=revert-song] .rv-cnt').textContent.trim());
  // a fader (relative drag) and the drone ON tile: Revert is armed, but neither is counted (concept §2, fix 2)
  const box = await page.locator(`[data-testid=slot-fader-${s0.i}] input`).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6);
  await page.mouse.down();
  for (let k = 1; k <= 6; k++) await page.mouse.move(box.x + box.width / 2, box.y + box.height * (0.6 - 0.04 * k));
  await page.mouse.up();
  await page.click('[data-testid=drone-on]');
  await page.waitForTimeout(120);
  assert.equal(await page.isDisabled('[data-testid=revert-song]'), false);
  assert.equal(await count(), 'levels only');
  // a Space step (75 %) is one change, with a white dot on its chip
  const target = Math.abs(s0.reverb - 0.75) < 0.01 ? 0.5 : 0.75;
  await page.click(`[data-testid=slot-space-${s0.i}]`);
  await page.click(`.step-panel .sp-step[data-value="${target}"]`);
  await page.waitForFunction(([i, t]) => Math.abs(window.__rig.store.currentSong().patch.slots[i].sends.reverb - t) < 1e-6, [s0.i, target]);
  assert.equal(await count(), '1 changed');
  assert.equal(await page.isVisible(`[data-testid=slot-space-${s0.i}] .cdi`), true, 'changed dot on the chip');
  // the key (hearIn + playIn) counts once
  await page.click(`[data-testid=key-grid] [data-pc="${(s0.hearIn + 2) % 12}"]`);
  await page.waitForTimeout(120);
  const changed = await page.evaluate((i) => ({ gain: window.__rig.engine.getParam(`slots.${i}.gain`), hearIn: window.__rig.store.currentSong().hearIn }), s0.i);
  assert.notEqual(changed.gain, s0.gain);
  assert.notEqual(changed.hearIn, s0.hearIn);
  assert.equal(await count(), '2 changed');
  // a short click does nothing (Revert always needs the hold: it also un-parks mutes and snaps every fader)
  await page.click('[data-testid=revert-song]');
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.__rig.store.currentSong().hearIn), changed.hearIn, 'a short click does not revert');
  await hold('[data-testid=revert-song]');
  await page.waitForTimeout(150);
  const r = await page.evaluate((i) => {
    const s = window.__rig.store.currentSong();
    return { gain: s.patch.slots[i].gain, reverb: s.patch.slots[i].sends.reverb, engine: window.__rig.engine.getParam(`slots.${i}.gain`), hearIn: s.hearIn, mode: s.drone.mode };
  }, s0.i);
  assert.equal(r.gain, s0.gain, 'fader restored');
  assert.ok(Math.abs(r.engine - s0.gain) < 1e-9, 'engine follows');
  assert.equal(r.reverb, s0.reverb, 'Space send restored');
  assert.equal(r.hearIn, s0.hearIn, 'key restored');
  assert.equal(r.mode, s0.mode);
  await page.waitForFunction((m) => window.__rig.engine.drone.cfg.mode === m, s0.mode);
  assert.equal(await page.isDisabled('[data-testid=revert-song]'), true, 'nothing left to revert');
  assert.equal(await page.isVisible(`[data-testid=slot-space-${s0.i}] .cdi`), false, 'dot gone');
});

test('header Space / Echo chips apply presets; Vibes sit behind "…"; "Song’s own" brings the saved echo back', async () => {
  await clearToasts();
  const checked = (row) => page.evaluate((r) => [...document.querySelectorAll(`[data-testid=${r}-row] .fxrow > .fxc[aria-checked=true]`)].map((b) => b.dataset.id), row);
  const loaded = await page.evaluate(() => JSON.parse(JSON.stringify(window.__rig.views.perform.savedSnapshot.patch)));
  await page.click('[data-testid=space-row] .fxc[data-id="hall"]');
  await page.waitForTimeout(150);
  const fx = await page.evaluate(() => {
    const s = window.__rig.store.currentSong();
    return { size: s.patch.fx.reverb.size, ret: s.patch.fx.reverb.returnGain, eng: window.__rig.engine.getParam('fx.reverb.size'), delay: s.patch.fx.delay.returnGain };
  });
  assert.equal(fx.size, 0.65);
  assert.equal(fx.ret, 1.15);
  assert.ok(Math.abs(fx.eng - 0.65) < 1e-9, 'engine gets the preset');
  assert.deepEqual(await checked('space'), ['hall']);
  assert.equal(await page.isVisible('[data-testid=space-row] .fxc[data-id="hall"] .cd'), loaded.fx.reverb.size !== 0.65, 'changed dot on the chip');
  // manual tweak → no chip lit (the old "Custom")
  await page.evaluate(() => window.__rig.store.set(`songs.${window.__rig.store.currentSong().id}.patch.fx.reverb.size`, 0.3));
  await page.waitForTimeout(80);
  assert.deepEqual(await checked('space'), []);
  // a vibe (behind "…") sets space + echo together; both rows show it
  await page.click('[data-testid=space-row] .fxc.more');
  await page.click('.fx-more .fxc[data-id="vibe:prayer"]');
  await page.waitForTimeout(150);
  assert.deepEqual(await checked('space'), ['cathedral']);
  assert.deepEqual(await checked('echo'), ['ambient-echo']);
  assert.equal(await page.evaluate(() => window.__rig.store.currentSong().patch.fx.delay.sync), '1/4');
  // Echo Off, then Song's own: the loaded echo comes back exactly; slot levels are untouched
  const gains = await page.evaluate(() => window.__rig.store.currentSong().patch.slots.map((s) => s && s.gain));
  await page.click('[data-testid=echo-row] .fxc[data-id="none"]');
  await page.waitForFunction(() => window.__rig.store.currentSong().patch.fx.delay.returnGain === 0);
  await page.click('[data-testid=echo-row] .fxc[data-id="own"]');
  await page.waitForTimeout(120);
  const after = await page.evaluate(() => {
    const s = window.__rig.store.currentSong();
    return { delay: JSON.parse(JSON.stringify(s.patch.fx.delay)), gains: s.patch.slots.map((x) => x && x.gain), dot: !!document.querySelector('[data-testid=echo-row] .fxc.on .cd:not([hidden])') };
  });
  assert.deepEqual(after.delay, loaded.fx.delay, 'fx.delay deep-equals the loaded value');
  assert.deepEqual(after.gains, gains, 'slot levels untouched');
  assert.equal(after.dot, false, 'echo back as loaded: no dot');
  // leave the song as it was
  await hold('[data-testid=revert-song]');
});

test('Next shows the next song name + key; the current chip stays in view; End of set', async () => {
  const ids = await page.evaluate(() => window.__rig.store.navIds());
  await page.click('[data-testid=setlist] .setlist-chip[data-index="0"]');
  await waitSong(ids[0]);
  const exp = await page.evaluate((id) => {
    const s = window.__rig.store.getSong(id);
    return s.name;
  }, ids[1]);
  const nt = (await page.textContent('[data-testid=next-name]')).trim();
  assert.ok(nt.startsWith(`${exp} · `), `Next label "${nt}" names "${exp}" and its key`);
  assert.match(await page.getAttribute('[data-testid=next-song]', 'aria-label'), new RegExp(`Next song: ${exp.replace(/[+()]/g, '\\$&')}`));
  const last = ids.length - 1;
  await page.click('[data-testid=setlist] .setlist-chip[data-index="0"]');
  await page.evaluate((i) => window.__rig.controller.selectSong(window.__rig.store.navIds()[i], { index: i }), last);
  await waitSong(ids[last]);
  await page.waitForTimeout(100);
  const v = await page.evaluate((i) => {
    const strip = document.querySelector('[data-testid=setlist]').getBoundingClientRect();
    const chip = document.querySelector(`.setlist-chip[data-index="${i}"]`).getBoundingClientRect();
    return { inView: chip.left >= strip.left - 1 && chip.right <= strip.right + 1, next: document.querySelector('[data-testid=next-name]').textContent, disabled: document.querySelector('[data-testid=next-song]').disabled };
  }, last);
  assert.equal(v.inView, true, 'current chip scrolled into view');
  assert.equal(v.next, 'End of set');
  assert.equal(v.disabled, true);
  await page.click('[data-testid=setlist] .setlist-chip[data-index="0"]');
  await waitSong(ids[0]);
  const back = await page.evaluate(() => {
    const strip = document.querySelector('[data-testid=setlist]').getBoundingClientRect();
    const chip = document.querySelector('.setlist-chip[data-index="2"]').getBoundingClientRect();
    return chip.right <= strip.right + 1;
  });
  assert.equal(back, true, 'the next two songs are visible after the current one');
});

test('status lamps: pedal, drone readout / key grid outline when off, Fade-out "Faded" chip, expression row, Ready text', async () => {
  await clearToasts();
  // pedal
  await page.evaluate(() => window.__rig.controller.perform.sustain(true));
  await page.waitForFunction(() => document.querySelector('[data-testid=pedal-lamp]').classList.contains('down'), null, { timeout: 2000 });
  await page.evaluate(() => window.__rig.controller.perform.sustain(false));
  await page.waitForFunction(() => !document.querySelector('[data-testid=pedal-lamp]').classList.contains('down'), null, { timeout: 2000 });
  // drone readout + grid outline (the tile shows the key the drone plays)
  await page.click('[data-testid=drone-mode] [data-value="synth"]');
  await page.waitForFunction(() => /major|minor/.test(document.querySelector('[data-testid=drone-readout]').textContent));
  assert.match(await page.textContent('[data-testid=drone-readout]'), /^[A-G][b#]? (major|minor) · [−+]?\d/);
  assert.match(await page.textContent('[data-testid=drone-on] .ot-sub'), /^[A-G][b#]? (major|minor)$/);
  await page.click('[data-testid=drone-on]');
  await page.waitForFunction(() => document.querySelector('[data-testid=drone-readout]').textContent === 'Drone off');
  // (background transitions for 80 ms)
  const outlined = await page
    .waitForFunction(() => getComputedStyle(document.querySelector('[data-testid=key-grid] .key-btn.on')).backgroundColor === 'rgba(0, 0, 0, 0)', null, { timeout: 2000 })
    .then(() => true, () => false);
  assert.equal(outlined, true, 'active key is an outline while the drone is off');
  await page.click('[data-testid=drone-on]');
  await page.waitForFunction(() => window.__rig.store.currentSong().drone.mode === 'synth');
  // expression row appears once an expression value arrives
  assert.equal(await page.isVisible('.wheel-extra >> nth=0'), false);
  await page.evaluate(() => window.__rig.controller.perform.expression(0.5));
  await page.waitForFunction(() => {
    const r = document.querySelectorAll('.wheel-extra')[0];
    return !r.hidden && /50%/.test(r.textContent);
  });
  await page.evaluate(() => window.__rig.controller.perform.expression(1));
  // Ready shows words, not only an LED
  assert.equal((await page.textContent('#ready-text')).trim(), 'Ready');
  // fade out → "Faded — play to resume" until the next note
  await page.click('[data-testid=fade-out]');
  await page.waitForSelector('[data-testid=faded-chip]', { state: 'visible' });
  assert.match(await page.textContent('[data-testid=fade-out]'), /Faded/);
  await page.screenshot({ path: path.join(shots, 'perform-faded.png') });
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shots, 'perform-faded-1024.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => window.__rig.controller.perform.noteOn(60, 90));
  await page.waitForSelector('[data-testid=faded-chip]', { state: 'hidden', timeout: 2000 });
  await page.evaluate(() => window.__rig.controller.perform.noteOff(60));
  assert.equal((await page.textContent('[data-testid=fade-out]')).trim(), 'Fade out');
});

test('contrast: tokens and live elements meet the stage thresholds', async () => {
  const r = await page.evaluate(() => {
    const probe = document.createElement('div');
    document.body.append(probe);
    const tok = (name) => {
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color;
    };
    const rgb = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = (c) => {
      const [r, g, b] = rgb(c).map((v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
    };
    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    const panel = tok('--panel');
    const out = {
      faintPanel: ratio(tok('--faint'), panel),
      faintPanel2: ratio(tok('--faint'), tok('--panel-2')),
      mutedPanel: ratio(tok('--muted'), panel),
      textPanel: ratio(tok('--text'), panel),
      ledOffTopbar: ratio(cs('#ready-led').backgroundColor === 'rgba(0, 0, 0, 0)' ? tok('--led-off') : tok('--led-off'), cs('#topbar').backgroundColor),
      toggleLedOff: ratio(tok('--led-off'), tok('--panel-2')),
      trackEdge: ratio(tok('--track-edge'), panel),
      mutedFader: ratio(tok('--muted-fader'), panel),
      recIdle: ratio(cs('.rec-dot').backgroundColor, cs('#btn-rec').backgroundColor),
      panic: ratio(cs('[data-testid=panic]').color, cs('[data-testid=panic]').backgroundColor),
      chipNum: ratio(cs('.setlist-chip:not(.current) .chip-num').color, cs('.setlist-chip:not(.current)').backgroundColor),
      emptySlot: ratio(tok('--faint'), panel),
      accentPanel: ratio(tok('--accent'), panel),
    };
    probe.remove();
    return out;
  });
  const min = { faintPanel: 4.5, faintPanel2: 4.5, mutedPanel: 4.5, textPanel: 7, ledOffTopbar: 3, toggleLedOff: 3, trackEdge: 3, mutedFader: 3, recIdle: 3, panic: 4.5, chipNum: 4.5, emptySlot: 4.5, accentPanel: 4.5 };
  for (const [k, v] of Object.entries(min)) assert.ok(r[k] >= v, `${k} contrast ${r[k]} ≥ ${v}`);
  console.log(`# contrast ${JSON.stringify(r)}`);
  // live hit targets ≥ 44 px (UX M11)
  const small = await page.evaluate(() => {
    const sels = ['[data-testid=view-switch] .seg', '#btn-quick', '#btn-settings', '#btn-rec', '[data-testid=drone-on]', '[data-testid=drone-mode] .seg', '[data-testid=key-quality] .seg', '[data-testid=drone-continue]', '[data-testid=pad-folder-btn]', '[data-testid=key-grid] .key-btn', '[data-testid=key-button]', '[data-testid=transpose-up]', '[data-testid=transpose-down]', '[data-testid=space-row] .fxc', '[data-testid=echo-row] .fxc', '[data-testid=perform-lock]', '[data-testid=panic]', '[data-testid=fade-out]', '[data-testid=revert-song]', '.ontile', '.mchip', '[data-testid=next-song]', '[data-testid=prev-song]', '.setlist-chip', '.swell-btn', '[data-testid=master-fader] input', '[data-testid=drone-gain] input'];
    const bad = [];
    for (const s of sels) for (const el of document.querySelectorAll(s)) {
      if (!el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 43.5) bad.push(`${s} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return bad;
  });
  assert.deepEqual(small, [], `hit targets under 44 px: ${small.join(', ')}`);
});

test('on-screen keyboard plays through the controller and shows held notes + chord', async () => {
  const ids = await page.evaluate(() => window.__rig.store.navIds());
  await page.click('[data-testid=setlist] .setlist-chip[data-index="0"]');
  await waitSong(ids[0]);
  const key = page.locator('[data-testid=piano] .pkey[data-note="60"]');
  const b = await key.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * 0.85);
  await page.mouse.down();
  await page.waitForFunction(() => window.__rig.engine.activeNotes.has(60));
  assert.equal(await key.evaluate((el) => el.classList.contains('held')), true);
  await page.mouse.up();
  await page.waitForFunction(() => !window.__rig.engine.activeNotes.has(60));
  // hold C-E-G for the screenshot: chord readout + highlighted keys
  await page.evaluate(() => [60, 64, 67].forEach((n) => window.__rig.controller.perform.noteOn(n, 90)));
  await page.waitForFunction(() => document.querySelector('.chord-name').textContent.trim() === 'C');
  await page.waitForTimeout(300);
  await clearToasts();
  await page.screenshot({ path: path.join(shots, 'perform-chord.png') });
  await page.evaluate(() => [60, 64, 67].forEach((n) => window.__rig.controller.perform.noteOff(n)));
});

test('responsive: 1024×700 fits without page scroll; notes toggle; big type kept; step panel stays in its strip', async () => {
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(200);
  const m = await page.evaluate(() => {
    const b = document.body;
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    return {
      sw: document.documentElement.scrollWidth,
      sh: document.documentElement.scrollHeight,
      bottom: r('.p-bottom').bottom,
      slotsBottom: r('.p-slots').bottom,
      bottomTop: r('.p-bottom').top,
      fader: r('[data-testid=slot-fader-0] input').height,
      name: parseFloat(getComputedStyle(document.querySelector('.song-name')).fontSize),
      bw: b.clientWidth,
    };
  });
  assert.ok(m.sw <= 1024 && m.sh <= 700, `no overflow (${m.sw}×${m.sh})`);
  assert.ok(m.bottom <= 700, 'bottom row on screen');
  assert.ok(m.slotsBottom <= m.bottomTop, 'slots do not overlap the keyboard row');
  assert.ok(m.fader >= 100, `slot faders stay usable (${m.fader}px)`);
  // H-v2 perform-1024.png sets the title at 30 px to give the faders their throw; 32 here (was 40 before H-v2)
  assert.ok(m.name >= 32, `song name ${m.name}px`);
  // the header Space / Echo rows collapse to two pills that open the same chips
  assert.equal(await page.isVisible('[data-testid=space-row] .fxpill'), true);
  assert.equal(await page.isVisible('[data-testid=space-row] .fxc[data-id="hall"]'), false);
  // a step panel stays inside its own strip (H §5)
  await page.click('[data-testid=slot-echo-0]');
  const geo = await page.evaluate(() => {
    const p = document.querySelector('.step-panel').getBoundingClientRect();
    const s = document.querySelector('[data-testid=slot-0]').getBoundingClientRect();
    return { inside: p.left >= s.left - 0.5 && p.right <= s.right + 0.5 && p.top >= s.top - 0.5 && p.bottom <= s.bottom + 0.5 };
  });
  await page.keyboard.press('Escape');
  assert.equal(geo.inside, true, 'step panel within the strip at 1024×700');
  await page.click('[data-testid=notes-toggle]');
  assert.equal(await page.isVisible('[data-testid=notes]'), true);
  await clearToasts();
  await page.screenshot({ path: path.join(shots, 'perform-1024-notes.png') });
  await page.click('[data-testid=notes-toggle]');
  await page.screenshot({ path: path.join(shots, 'perform-1024-plain.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('components: §13 API shape, set/destroy, double-click reset, keyboard access', async () => {
  const r = await page.evaluate(async () => {
    const C = await import('/js/views/components/index.js');
    const out = {};
    const host = document.createElement('div');
    document.body.append(host);
    const made = {
      fader: C.fader({ path: 'fx.reverb.size', label: 'Size', onChange: () => {} }),
      knob: C.knob({ path: 'fx.delay.time', label: 'Time', onChange: () => {} }),
      toggle: C.toggle({ label: 'T', onChange: () => {} }),
      segmented: C.segmented({ options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], onChange: () => {} }),
      select: C.select({ options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y', group: 'G' }], onChange: () => {} }),
      stepper: C.stepper({ min: -2, max: 2, step: 1, onChange: () => {} }),
      keyGrid: C.keyGrid({ onSelect: () => {} }),
      miniKeyboard: C.miniKeyboard({ low: 0, high: 127, onRange: () => {} }),
      pianoKeyboard: C.pianoKeyboard({ from: 36, to: 96, onNoteOn: () => {}, onNoteOff: () => {} }),
      meter: C.meter({ engine: window.__rig.engine }),
      chordReadout: C.chordReadout(),
      wheelStrip: C.wheelStrip({ onSwell: () => {} }),
      setlistStrip: C.setlistStrip({ onSelect: () => {}, onReorder: () => {} }),
    };
    out.shape = Object.fromEntries(Object.entries(made).map(([k, c]) => [k, c.el instanceof HTMLElement && typeof c.set === 'function' && typeof c.destroy === 'function']));
    for (const c of Object.values(made)) host.append(c.el);
    out.pianoKeys = made.pianoKeyboard.el.querySelectorAll('.pkey').length;
    // fader: log curve, dblclick reset to params default, keyboard nudge, emit coalesced
    const got = [];
    const f = C.fader({ path: 'fx.delay.time', label: 'Time', onChange: (v) => got.push(v) });
    host.append(f.el);
    f.set(1.2);
    out.faderLabel = f.el.querySelector('.fader-value').textContent;
    f.el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    out.afterReset = [f.get(), got.at(-1)];
    f.input.focus();
    f.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    out.afterKey = f.get() > 0.375;
    // taper: 2·pos³ for gains
    const g = C.fader({ path: 'slots.0.gain', onChange: () => {} });
    g.set(0.25);
    out.taperPos = Number(g.input.value);
    // keyGrid names follow major/minor
    made.keyGrid.set({ pc: 6, minor: false });
    out.grid = [made.keyGrid.el.querySelector('[data-pc="6"]').textContent, made.keyGrid.el.querySelector('[data-pc="6"]').getAttribute('aria-checked')];
    made.keyGrid.set({ pc: 6, minor: true });
    out.gridMinor = made.keyGrid.el.querySelector('[data-pc="8"]').textContent;
    // toggle
    made.toggle.el.click();
    out.toggle = made.toggle.el.getAttribute('aria-pressed');
    // segmented keyboard
    const segBtn = made.segmented.el.querySelector('[data-value="a"]');
    made.segmented.set('a');
    segBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    out.seg = made.segmented.get();
    // stepper
    const sv = made.stepper.el.querySelector('.step-value');
    sv.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    out.stepper = made.stepper.get();
    // setlist strip
    made.setlistStrip.set({ songs: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], currentId: 'b' });
    out.setlist = made.setlistStrip.el.querySelector('.current')?.dataset.id;
    const before = made.setlistStrip.el.querySelector('[data-id="a"]');
    made.setlistStrip.set({ currentId: 'a' });
    out.setlistSameNode = made.setlistStrip.el.querySelector('[data-id="a"]') === before;
    // Perform variant: no dblclick reset
    const pf = C.fader({ path: 'fx.delay.time', relative: true, resetOnDoubleClick: false, onChange: () => {} });
    host.append(pf.el);
    pf.set(1.2);
    pf.el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    out.noReset = pf.get();
    pf.destroy();
    // wheel strip extras
    made.wheelStrip.set({ expr: 0.42, vol: null, pedal: true });
    out.wheelExtra = [made.wheelStrip.el.querySelectorAll('.wheel-extra')[0].hidden, made.wheelStrip.el.querySelectorAll('.wheel-extra')[0].textContent, made.wheelStrip.el.querySelectorAll('.wheel-extra')[1].hidden, made.wheelStrip.el.querySelector('.pedal-lamp').classList.contains('down')];
    // instrument groups: new groups in order, unknown ones after, never lumped into Synth Pads
    const G = C.groupInstruments([
      { ref: { type: 'synth', id: 'square-lead' }, name: 'Square Lead', group: 'Brass & Leads' },
      { ref: { type: 'sampler', id: 'user:x' }, name: 'My Pad' },
      { ref: { type: 'synth', id: 'warm-pad' }, name: 'Warm Pad', group: 'Synth Pads' },
      { ref: { type: 'synth', id: 'k' }, name: 'K', group: 'Synth Keys' },
      { ref: { type: 'synth', id: 'z' }, name: 'Z', group: 'Zither' },
    ]);
    out.groups = G.map((g) => g.group);
    out.stage = [C.stageName('Grand Piano (Salamander)', { id: 'grand' }), C.stageName('Rhodes (MusyngKite)', { id: 'rhodes' }), C.stageName('Take (Live)', { id: 'user:a' })];
    // chord
    made.chordReadout.set({ name: 'Dm7' });
    out.chord = made.chordReadout.el.querySelector('.chord-name').textContent;
    // destroy removes
    for (const c of [...Object.values(made), f, g]) c.destroy();
    out.leftovers = host.children.length;
    host.remove();
    return out;
  });
  for (const [k, ok] of Object.entries(r.shape)) assert.equal(ok, true, `${k} returns {el, set, destroy}`);
  assert.equal(r.pianoKeys, 61);
  assert.equal(r.faderLabel, '1.20 s');
  assert.deepEqual(r.afterReset, [0.375, 0.375]);
  assert.equal(r.afterKey, true);
  assert.equal(r.taperPos, 500, 'gain 0.25 = 2·0.5³ → position 500/1000');
  assert.deepEqual(r.grid, ['F#', 'true']);
  assert.equal(r.gridMinor, 'G#m');
  assert.equal(r.toggle, 'true');
  assert.equal(r.seg, 'b');
  assert.equal(r.stepper, -1);
  assert.equal(r.setlist, 'b');
  assert.equal(r.setlistSameNode, true, 'setlist strip patches in place on song switch');
  assert.equal(r.chord, 'Dm7');
  assert.equal(r.noReset, 1.2, 'resetOnDoubleClick:false keeps the value');
  assert.deepEqual(r.wheelExtra, [false, 'Expr42%', true, true]);
  assert.deepEqual(r.groups, ['Synth Pads', 'Synth Keys', 'Brass & Leads', 'My Samples', 'Zither']);
  assert.deepEqual(r.stage, ['Grand Piano', 'Rhodes', 'Take (Live)']);
  assert.equal(r.leftovers, 0);
});

test('song switch patches the DOM in place (no re-render)', async () => {
  const r = await page.evaluate(async () => {
    const rig = window.__rig;
    const SELS = ['.song-name', '[data-testid=slot-fader-0] input', '[data-testid=key-grid] [data-pc="0"]', '.setlist-chip[data-index="1"]', '[data-testid=piano]', '[data-testid=slot-on-0]', '[data-testid=slot-space-0]', '[data-testid=space-row] .fxc[data-id="hall"]', '[data-testid=drone-on]', '[data-testid=revert-song]'];
    const nodes = SELS.map((s) => document.querySelector(s));
    await rig.controller.nextSong();
    await window.__t.sleep(100);
    await rig.controller.prevSong();
    const same = SELS.map((s, i) => document.querySelector(s) === nodes[i]);
    return same;
  });
  assert.deepEqual(r, r.map(() => true));
  assert.equal(r.length, 10);
});

test('no layout shift when values change (chord, key, transpose, fader values)', async () => {
  const r = await page.evaluate(async () => {
    const rig = window.__rig;
    const t = window.__t;
    const sels = ['.song-block', '.transpose', '.chord-readout', '.p-slots', '.p-drone', '[data-testid=slot-fader-0] .fader-value', '.wheel-strip', '#rec-time'];
    const snap = () => sels.map((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(',');
    });
    const a = snap();
    // polish-2A: the readout is live only while ≥ 2 keys are held, so the fake chord comes with a fake 'notes'
    rig.controller.dispatchEvent(new CustomEvent('notes', { detail: { held: new Set([46, 63, 67, 70]) } }));
    rig.controller.dispatchEvent(new CustomEvent('chord', { detail: { chord: { name: 'Ebmaj9/Bb' } } }));
    const s = rig.store.currentSong();
    rig.store.set(`songs.${s.id}.hearIn`, 1);
    rig.store.set(`songs.${s.id}.minor`, true);
    rig.store.set(`songs.${s.id}.patch.slots.0.gain`, 0.001);
    await t.sleep(120);
    const b = snap();
    rig.store.set(`songs.${s.id}.hearIn`, s.hearIn);
    rig.store.set(`songs.${s.id}.minor`, s.minor);
    rig.store.set(`songs.${s.id}.patch.slots.0.gain`, s.patch.slots[0].gain);
    rig.controller.dispatchEvent(new CustomEvent('notes', { detail: { held: new Set() } }));
    rig.controller.dispatchEvent(new CustomEvent('chord', { detail: { chord: null } }));
    await t.sleep(60);
    return { a, b, sels };
  });
  r.sels.forEach((sel, i) => assert.equal(r.b[i], r.a[i], `${sel} moved/resized: ${r.a[i]} → ${r.b[i]}`));
});

// ------------------------------------------------------------------------------------------ round2-ui regressions
const r2Idle = () => page.waitForFunction(() => !window.__rig.controller.status.loading, null, { timeout: 60000 });
async function r2Select(id, index) {
  await page.evaluate(([i, x]) => window.__rig.controller.selectSong(i, x === undefined ? {} : { index: x }), [id, index]);
  await r2Idle();
}

test('round2-ui #1: after Settings is closed with the mouse nothing is focused; Space = sustain, Settings stays shut', async () => {
  await clearToasts();
  await page.evaluate(() => document.activeElement?.blur?.());
  for (const how of ['close-button', 'backdrop']) {
    await page.click('#btn-settings');
    await page.waitForFunction(() => !document.getElementById('view-settings').hidden);
    await page.waitForTimeout(150);
    if (how === 'close-button') await page.click('#view-settings .st-close');
    else await page.mouse.click(4, 896); // the modal backdrop (#view-settings itself)
    await page.waitForFunction(() => document.getElementById('view-settings').hidden);
    await page.waitForTimeout(50);
    const active = await page.evaluate(() => (document.activeElement === document.body ? 'body' : document.activeElement?.id || document.activeElement?.className));
    assert.equal(active, 'body', `${how}: nothing focused after a pointer close (was the gear button)`);
    await page.keyboard.down('Space');
    await page.waitForTimeout(120);
    const pedal = await page.evaluate(() => window.__rig.controller.status.pedal);
    await page.keyboard.up('Space');
    await page.waitForTimeout(250);
    assert.equal(pedal, true, `${how}: Space held = sustain`);
    assert.equal(await page.isVisible('#view-settings'), false, `${how}: Space does not re-open Settings`);
    assert.equal(await page.evaluate(() => window.__rig.controller.status.pedal), false);
  }
  // keyboard users still get their opener back
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Tab'); // keyboard modality, so the programmatic focus below is :focus-visible
  await page.evaluate(() => document.getElementById('btn-settings').focus());
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.getElementById('view-settings').hidden);
  await page.waitForTimeout(100);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('view-settings').hidden);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'btn-settings', 'keyboard open → focus returns to the gear');
  await page.evaluate(() => document.activeElement?.blur?.());
  // one dialog for screen readers (#11): the host drops its placeholder role once settings.js is mounted
  const roles = await page.evaluate(() => {
    const host = document.getElementById('view-settings');
    return { host: host.getAttribute('role'), modal: host.getAttribute('aria-modal'), inner: host.querySelectorAll('[role=dialog][aria-modal=true]').length };
  });
  assert.deepEqual(roles, { host: null, modal: null, inner: 1 }, 'no nested modal dialogs');
});

test('round2-ui #2: a Perform fader drag that is still going when the song changes never writes into the new song', async () => {
  await clearToasts();
  const ids = await page.evaluate(() => window.__rig.store.navIds());
  const [a, b] = [ids[0], ids[1]];
  // give both songs a slot-1 level we can recognise
  await page.evaluate(([a, b]) => {
    const st = window.__rig.store;
    st.set(`songs.${a}.patch.slots.1.gain`, 0.55);
    st.set(`songs.${b}.patch.slots.1.gain`, 0.75);
  }, [a, b]);
  const gains = () => page.evaluate(([a, b]) => ({ a: window.__rig.store.getSong(a).patch.slots[1]?.gain, b: window.__rig.store.getSong(b).patch.slots[1]?.gain }), [a, b]);
  const shown = () => page.evaluate(() => document.querySelector('[data-testid=slot-fader-1] .fader-value').textContent);
  const fmt = (v) => page.evaluate((x) => import('./js/shared/params.js').then((m) => m.formatValue('slots.1.gain', x)), v);
  await r2Select(a);
  const box = await page.locator('[data-testid=slot-fader-1] input').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  // E2: keep moving after the switch, then release
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 20, { steps: 4 });
  await page.waitForTimeout(80);
  const mid = await gains();
  assert.ok(mid.a > 0.55, `A follows the drag (${mid.a})`);
  await r2Select(b); // MIDI Next / program change while the hand is on the fader
  await page.waitForTimeout(60);
  assert.equal(await shown(), await fmt(0.75), 'the fader shows B at once');
  await page.mouse.move(x, y - 40, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  let g = await gains();
  assert.equal(g.b, 0.75, `B untouched by the drag that began on A (got ${g.b})`);
  assert.equal(g.a, mid.a, 'A keeps what was dragged before the switch');
  assert.equal(await shown(), await fmt(0.75));
  // E2b: no movement after the switch
  await r2Select(a);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 15, { steps: 3 });
  await page.waitForTimeout(80);
  await r2Select(b);
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(150);
  g = await gains();
  assert.equal(g.b, 0.75);
  assert.equal(await shown(), await fmt(0.75), 'display = B’s level, not A’s dragged level');
  // a store change during a drag (stash) is shown on release when the drag wrote nothing after it (#2b)
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 10, { steps: 2 });
  await page.waitForTimeout(80);
  await page.evaluate((b) => window.__rig.store.set(`songs.${b}.patch.slots.1.gain`, 0.3), b);
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(120);
  assert.equal(await shown(), await fmt(0.3), 'stashed store value shown after release');
  // top-bar Master (a current-song alias) has the same guard
  const mb = await page.locator('[data-testid=master-fader] input').boundingBox();
  const vol = () => page.evaluate(([a, b]) => [window.__rig.store.getSong(a).patch.fx.master.volume, window.__rig.store.getSong(b).patch.fx.master.volume], [a, b]);
  await r2Select(a);
  const v0 = await vol();
  await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await page.mouse.down();
  await page.mouse.move(mb.x + mb.width / 2 - 20, mb.y + mb.height / 2, { steps: 3 });
  await page.waitForTimeout(80);
  await r2Select(b);
  await page.mouse.move(mb.x + mb.width / 2 - 50, mb.y + mb.height / 2, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  const v1 = await vol();
  assert.equal(v1[1], v0[1], 'B’s master volume untouched');
  await r2Select(a);
});

test('round2-ui #4: setlist gap — no chip is highlighted (not even a reprise), a marker shows where Next continues', async () => {
  const r = await page.evaluate(async () => {
    const { store, controller } = window.__rig;
    const sl = store.currentSetlist();
    const ids = sl.songIds.slice();
    store.addToSetlist(sl.id, ids[0]); // reprise at the end
    await controller.selectSong(ids[0], { index: 0 });
    await new Promise((res) => setTimeout(res, 300));
    store.removeFromSetlist(sl.id, 0);
    await new Promise((res) => setTimeout(res, 200));
    const chips = [...document.querySelectorAll('[data-testid=setlist] .setlist-chip')];
    const out = {
      gap: store.get().settings.setlistGap,
      highlighted: chips.filter((c) => c.classList.contains('current')).length,
      marker: [...document.querySelectorAll('[data-testid=setlist] .setlist-item')].findIndex((li) => li.classList.contains('gap-before')),
      dataGap: document.querySelector('[data-testid=setlist]').dataset.gap,
      next: document.querySelector('[data-testid=next-name]')?.textContent || '',
      first: chips[0]?.querySelector('.chip-name').textContent,
    };
    // leaving the gap (select a song) removes the marker; restore the setlist
    await controller.selectSong(store.navIds()[0], { index: 0 });
    await new Promise((res) => setTimeout(res, 100));
    out.after = { marker: document.querySelectorAll('[data-testid=setlist] .gap-before, [data-testid=setlist] .gap-after').length, highlighted: document.querySelectorAll('[data-testid=setlist] .setlist-chip.current').length };
    store.removeFromSetlist(sl.id, store.currentSetlist().songIds.length - 1);
    store.addToSetlist(sl.id, ids[0], 0);
    await controller.selectSong(ids[0], { index: 0 });
    out.restored = JSON.stringify(store.currentSetlist().songIds) === JSON.stringify(ids);
    return out;
  });
  assert.equal(r.gap, true);
  assert.equal(r.highlighted, 0, 'no chip current in the gap (the reprise was highlighted before)');
  assert.equal(r.marker, 0, 'gap marker before chip 1 (Next plays it)');
  assert.equal(r.dataGap, '0');
  assert.ok(r.next.startsWith(r.first), `Next names chip 1 (${r.next})`);
  assert.deepEqual(r.after, { marker: 0, highlighted: 1 });
  assert.equal(r.restored, true);
  await r2Idle();
});

test('round2-ui #5: holding Enter on the lock button unlocks once and never re-locks from auto-repeat', async () => {
  await page.evaluate(() => window.__rig.store.set('settings.performLock', true));
  await page.evaluate(() => document.querySelector('[data-testid=perform-lock]').focus());
  await page.keyboard.down('Enter');
  const t0 = Date.now();
  const flips = [];
  let last = true;
  while (Date.now() - t0 < 1600) {
    await page.waitForTimeout(33);
    await page.keyboard.down('Enter'); // auto-repeat (repeat: true)
    const v = await page.evaluate(() => window.__rig.store.get().settings.performLock);
    if (v !== last) flips.push([Date.now() - t0, v]);
    last = v;
  }
  await page.keyboard.up('Enter');
  await page.waitForTimeout(150);
  const end = await page.evaluate(() => window.__rig.store.get().settings.performLock);
  assert.equal(flips.length, 1, `one change (unlock) during a 1.6 s hold: ${JSON.stringify(flips)}`);
  assert.equal(flips[0][1], false);
  assert.equal(end, false, 'still unlocked after release');
  // a fresh short Enter press still locks
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__rig.store.get().settings.performLock === true);
  await page.keyboard.down('Enter');
  await page.waitForTimeout(800);
  await page.keyboard.up('Enter');
  await page.waitForFunction(() => window.__rig.store.get().settings.performLock === false);
  await page.evaluate(() => document.activeElement?.blur?.());
});

test('round2-ui #6: Perform slot names follow an instrument-list change (My Samples rescan)', async () => {
  const r = await page.evaluate(async () => {
    const { engine, controller, store } = window.__rig;
    const s = store.currentSong();
    const i = s.patch.slots.findIndex(Boolean);
    const ref = s.patch.slots[i].instrument;
    const el = document.querySelector(`[data-testid=slot-${i}] .slot-inst`);
    const before = el.textContent;
    const orig = engine.listInstruments;
    engine.listInstruments = function () {
      return orig.call(this).map((x) => (x.ref.type === ref.type && x.ref.id === ref.id ? { ...x, name: 'Rescanned Grand' } : x));
    };
    const seen = {};
    try {
      for (const [src, fire] of [
        ['user-samples', () => controller.dispatchEvent(new CustomEvent('user-samples', { detail: {} }))],
        ['rig-instruments-changed', () => window.dispatchEvent(new CustomEvent('rig-instruments-changed'))],
      ]) {
        fire();
        await new Promise((res) => setTimeout(res, 30));
        seen[src] = el.textContent;
        engine.listInstruments = orig; // back, then re-fire through the next source
        window.dispatchEvent(new CustomEvent('rig-instruments-changed'));
        await new Promise((res) => setTimeout(res, 30));
        engine.listInstruments = function () {
          return orig.call(this).map((x) => (x.ref.type === ref.type && x.ref.id === ref.id ? { ...x, name: 'Rescanned Grand' } : x));
        };
      }
    } finally {
      engine.listInstruments = orig;
      window.dispatchEvent(new CustomEvent('rig-instruments-changed'));
    }
    await new Promise((res) => setTimeout(res, 30));
    return { before, seen, after: el.textContent };
  });
  assert.deepEqual(r.seen, { 'user-samples': 'Rescanned Grand', 'rig-instruments-changed': 'Rescanned Grand' });
  assert.equal(r.after, r.before);
});

test('round2-ui #8: the Revert snapshot follows the controller commit, not a store selection request', async () => {
  await clearToasts();
  const ids = await page.evaluate(() => window.__rig.store.navIds());
  await r2Select(ids[3]);
  const r = await page.evaluate(async ([a, b]) => {
    const { store, views, controller } = window.__rig;
    const q = () => document.querySelector('[data-testid=revert-song]').disabled;
    const g0 = store.getSong(a).patch.slots.find(Boolean).gain;
    const i = store.getSong(a).patch.slots.findIndex(Boolean);
    store.set(`songs.${a}.patch.slots.${i}.gain`, g0 * 0.5); // a Perform tweak
    await new Promise((res) => setTimeout(res, 30));
    const tweaked = !q();
    // a switch the engine refuses (engine-core #18): the controller retries once, then puts the store back on A
    let committed = 0;
    const off = controller.on('songSelected', () => (committed += 1));
    const { engine } = window.__rig;
    const commit = engine.commit;
    engine.commit = () => false;
    let onB = null;
    const unsub = store.subscribe((st) => {
      if (!onB && st.settings.currentSongId === b) queueMicrotask(() => (onB = { disabled: q(), snapId: views.perform.savedSnapshot?.id }));
    });
    let ok;
    try {
      ok = await controller.selectSong(b);
    } finally {
      engine.commit = commit;
      unsub();
    }
    await new Promise((res) => setTimeout(res, 30));
    const backOnA = { ok, cur: store.currentSong().id, disabled: q(), snapGain: views.perform.savedSnapshot?.patch.slots[i].gain };
    off();
    await window.__holdEl(document.querySelector('[data-testid=revert-song]')); // Revert is a 600 ms hold (H-v2)
    await new Promise((res) => setTimeout(res, 30));
    const reverted = store.getSong(a).patch.slots[i].gain;
    // a second window taking over (store.reload) re-snapshots: nothing to revert afterwards
    store.set(`songs.${a}.patch.slots.${i}.gain`, g0 * 0.7);
    controller.dispatchEvent(new CustomEvent('instance', { detail: { instance: 'primary' } }));
    await new Promise((res) => setTimeout(res, 30));
    const afterTakeover = q();
    store.set(`songs.${a}.patch.slots.${i}.gain`, g0);
    return { g0, tweaked, onB, backOnA, reverted, committed, afterTakeover };
  }, [ids[3], ids[4]]);
  await r2Idle();
  assert.equal(r.tweaked, true);
  assert.equal(r.committed, 0, 'the refused switch never committed');
  assert.equal(r.onB?.snapId, ids[3], 'while B was requested the snapshot stayed on the committed song');
  assert.equal(r.onB?.disabled, true, 'nothing to revert for an uncommitted selection');
  assert.equal(r.backOnA.ok, false);
  assert.equal(r.backOnA.cur, ids[3], 'controller put the selection back on A');
  assert.equal(r.backOnA.snapGain, r.g0, 'snapshot still “as selected” (the old code re-took it with the tweak)');
  assert.equal(r.backOnA.disabled, false);
  assert.equal(r.reverted, r.g0);
  assert.equal(r.afterTakeover, true, 'store.reload takeover re-snapshots');
  await r2Select(ids[0]);
});

test('round2-ui #10: hidden views do not animate or poll (meters, runtime lamps)', async () => {
  // idle-cpu-ui: the meters share one ≤ 30 fps loop (meterClock), so reads are counted per clock frame and per second,
  // not per display frame (the old "0.25/frame" bounds failed at 120 Hz on the Mac). A held note keeps them awake.
  await page.evaluate(() => window.__rig.controller.perform.noteOn(60, 110));
  const measure = (view) =>
    page.evaluate(async (v) => {
      const { engine, ctx, meters } = window.__rig;
      ctx.setView(v);
      meters.wake();
      await new Promise((res) => setTimeout(res, 250));
      const an = engine.analyserL;
      const proto = Object.getPrototypeOf(an);
      const names = ['getFloatTimeDomainData', 'getByteTimeDomainData', 'getFloatFrequencyData', 'getByteFrequencyData'];
      let reads = 0;
      const saved = names.map((n) => [n, an[n]]);
      for (const n of names) an[n] = function (...a) {
        reads += 1;
        return proto[n].apply(this, a);
      };
      let rt = 0;
      const origRt = engine.getRuntimeState;
      engine.getRuntimeState = function (...a) {
        rt += 1;
        return origRt.apply(this, a);
      };
      const f0 = meters.stats().frames;
      const t0 = performance.now();
      await new Promise((res) => setTimeout(res, 1000));
      const sec = (performance.now() - t0) / 1000;
      const frames = meters.stats().frames - f0;
      for (const [n] of saved) delete an[n];
      engine.getRuntimeState = origRt;
      return { perFrame: reads / Math.max(1, frames), readsPerSec: reads / sec, framesPerSec: frames / sec, rt,
        awake: meters.stats().awake };
    }, view);
  const perf = await measure('perform');
  const edit = await measure('edit');
  await page.evaluate(() => window.__rig.controller.perform.noteOff(60));
  await page.evaluate(() => window.__rig.ctx.setView('perform'));
  await page.waitForFunction(() => !document.getElementById('view-perform').hidden);
  console.log(`# analyserL reads/clock frame: perform ${perf.perFrame.toFixed(2)} (${perf.readsPerSec.toFixed(1)}/s, `
    + `${perf.framesPerSec.toFixed(1)} frames/s), edit ${edit.perFrame.toFixed(2)} (${edit.readsPerSec.toFixed(1)}/s); `
    + `runtime polls: perform ${perf.rt}, edit ${edit.rt}`);
  assert.ok(perf.framesPerSec > 5 && perf.framesPerSec <= 35, `meter loop ≤ 35/s on any display (${perf.framesPerSec.toFixed(1)})`);
  assert.ok(perf.perFrame > 0.8 && perf.perFrame < 1.2, `Perform: only the top-bar meter reads (${perf.perFrame.toFixed(2)}/frame)`);
  assert.ok(perf.readsPerSec <= 35, `Perform: ≤ 35 reads/s (${perf.readsPerSec.toFixed(1)})`);
  // idle-cpu-ui: the top-bar and Edit meters both show engine.analyserL/R and share one read per clock frame
  assert.ok(edit.awake >= 2, `Edit: the top-bar and the Edit meter both run (${edit.awake} awake)`);
  assert.ok(edit.perFrame > 0.8 && edit.perFrame < 1.2, `Edit: one shared read per frame (${edit.perFrame.toFixed(2)}/frame)`);
  assert.ok(edit.readsPerSec <= 35, `Edit: ≤ 35 reads/s (${edit.readsPerSec.toFixed(1)})`);
  assert.ok(perf.rt >= 3, `Perform polls the runtime lamps (${perf.rt})`);
  assert.equal(edit.rt, 0, 'no runtime polling while Perform is hidden');
});

test('polish-1: strip level meters follow the slot, sit beside the fader, stop reading when hidden (tap idles)',
  async () => {
  await selectIndex(await richSongIndex());
  await page.evaluate(() => window.__rig.ctx.setView('perform'));
  await page.waitForFunction(() => !document.getElementById('view-perform').hidden);
  // geometry: inside the fader track, right of the input, no hit area (the fader throw is unchanged)
  const geo = await page.evaluate(() => [0, 1, 2, 3].map((i) => {
    const m = document.querySelector(`[data-testid="slot-level-${i}"]`);
    const inp = document.querySelector(`[data-testid="slot-fader-${i}"] .fader-input`);
    if (!m || !m.getClientRects().length) return null;
    const r = m.getBoundingClientRect();
    const ri = inp.getBoundingClientRect();
    const strip = m.closest('.slot').getBoundingClientRect();
    return { w: r.width, h: r.height, gap: r.left - ri.right, inStrip: r.right <= strip.right, inputH: ri.height,
      pe: getComputedStyle(m).pointerEvents, inTrack: m.parentElement.classList.contains('fader-track') };
  }));
  const shown = geo.filter(Boolean);
  assert.ok(shown.length >= 3, `a meter on every filled strip (${shown.length})`);
  for (const g of shown) {
    assert.equal(g.w, 4, 'a 4 px bar');
    assert.ok(g.gap >= 0 && g.gap <= 8, `beside the fader (gap ${g.gap})`);
    assert.ok(g.inStrip && g.inTrack && g.pe === 'none', JSON.stringify(g));
    assert.ok(g.h > g.inputH * 0.7, `spans the thumb travel (${g.h} of ${g.inputH})`);
  }
  // count controller.slotLevel reads per meter-clock frame: Perform reads each filled strip; Edit on Effects reads none.
  // idle-cpu-ui: one shared ≤ 30 fps loop (meterClock), so the cadence is per clock frame and per second, independent
  // of the display's refresh rate (the old per-display-frame bound, "about every other frame", failed at 120 Hz).
  const measure = (view, block) => page.evaluate(async ([v, b]) => {
    const { controller, ctx, meters } = window.__rig;
    ctx.setView(v);
    if (b) window.__rig.views.edit.editState.select(b);
    meters.wake();
    await new Promise((res) => setTimeout(res, 250));
    const orig = controller.slotLevel;
    const per = [0, 0, 0, 0];
    controller.slotLevel = (i) => {
      per[i] += 1;
      return orig(i);
    };
    const f0 = meters.stats().frames;
    const t0 = performance.now();
    await new Promise((res) => setTimeout(res, 600));
    const sec = (performance.now() - t0) / 1000;
    const frames = meters.stats().frames - f0;
    controller.slotLevel = orig;
    return { per: per.map((n) => n / Math.max(1, frames)), perSec: per.map((n) => n / sec), frames, fps: frames / sec };
  }, [view, block]);
  await page.evaluate(() => window.__rig.controller.perform.noteOn(60, 110));
  const perf = await measure('perform');
  const filled = await page.evaluate(() => window.__rig.store.currentSong().patch.slots.map((s) => !!s));
  // a filled strip that stays silent for SILENT_MS (500 ms) sleeps until the next activity (the note may not reach
  // every strip), so a strip reads once per clock frame or not at all
  perf.per.forEach((n, i) => {
    if (filled[i]) {
      assert.ok(n === 0 || (n > 0.3 && n <= 1.05), `Perform reads slot ${i} once per clock frame or sleeps (${n.toFixed(2)})`);
      assert.ok(perf.perSec[i] <= 35, `slot ${i}: ≤ 35 reads/s (${perf.perSec[i].toFixed(1)})`);
    } else assert.equal(n, 0, `an empty strip's meter is hidden and never reads (slot ${i})`);
  });
  assert.ok(perf.fps <= 35, `meter clock ≤ 35 frames/s (${perf.fps.toFixed(1)})`);
  assert.ok(perf.per.some((n, i) => filled[i] && n > 0.3), `the sounding strips are read (${perf.per.map((n) => n.toFixed(2))})`);
  const lv = await page.evaluate(() => [0, 1, 2, 3].map((i) => Number(document
    .querySelector(`[data-testid="slot-level-${i}"] .lvl-cover`)?.style.transform.replace(/[^0-9.]/g, '') || 1)));
  assert.ok(lv.some((c) => c < 0.9), `a sounding slot lifts its bar (covers ${lv.join(', ')})`);
  await page.evaluate(() => window.__rig.controller.perform.noteOff(60));
  assert.ok(await page.evaluate(() => window.__rig.engine.slotTapCount()) >= 2, 'the engine tapped the read slots');
  const edit = await measure('edit', 'effects');
  assert.deepEqual(edit.per, [0, 0, 0, 0], 'no slot meter reads while Perform is hidden and Edit shows no slot');
  await page.waitForFunction(() => window.__rig.engine.slotTapCount() === 0, null, { timeout: 5000 });
  await page.evaluate(() => window.__rig.ctx.setView('perform'));
  await page.waitForFunction(() => !document.getElementById('view-perform').hidden);
  await page.waitForFunction(() => window.__rig.engine.slotTapCount() >= 1, null, { timeout: 3000 });
});

test('round2-ui #12: arrows on the focused notes panel scroll it and never reach the mod wheel / song nav', async () => {
  const r = await page.evaluate(async () => {
    const { store, engine } = window.__rig;
    const s = store.currentSong();
    const notes0 = s.notes;
    store.set(`songs.${s.id}.notes`, Array.from({ length: 80 }, (_, k) => `line ${k + 1}`).join('\n'));
    document.querySelector('.perform').classList.add('show-notes');
    await new Promise((res) => setTimeout(res, 60));
    const n = document.querySelector('[data-testid=notes]');
    n.focus();
    const mod0 = engine.wheelValues().mod;
    const id0 = store.currentSong().id;
    return { mod0, id0, notes0, top0: n.scrollTop, can: n.scrollHeight > n.clientHeight };
  });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(80);
  const after = await page.evaluate(() => ({ mod: window.__rig.engine.wheelValues().mod, id: window.__rig.store.currentSong().id, top: document.querySelector('[data-testid=notes]').scrollTop }));
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(40);
  const mod2 = await page.evaluate(() => window.__rig.engine.wheelValues().mod);
  await page.evaluate((notes0) => {
    const s = window.__rig.store.currentSong();
    window.__rig.store.set(`songs.${s.id}.notes`, notes0);
    document.querySelector('.perform').classList.remove('show-notes');
    document.activeElement?.blur?.();
  }, r.notes0);
  assert.equal(after.mod, r.mod0, 'mod wheel unchanged by ↓/PageDown on the notes');
  assert.equal(mod2, r.mod0, 'mod wheel unchanged by ↑');
  assert.equal(after.id, r.id0);
  if (r.can) assert.ok(after.top > r.top0, `notes scrolled (${r.top0} → ${after.top})`);
});

// ------------------------------------------------------------------------------------------ H-v2 Perform
/** A nav index whose song has Keys, Pad and Bass (the mockup's layout); falls back to the first song. */
const richSongIndex = () =>
  page.evaluate(() => {
    const { store } = window.__rig;
    const ids = store.navIds();
    const i = ids.findIndex((id) => {
      const sl = store.getSong(id).patch.slots;
      return sl[0] && sl[1] && sl[3];
    });
    return Math.max(0, i);
  });
async function selectIndex(i) {
  const ids = await page.evaluate(() => window.__rig.store.navIds());
  await page.evaluate((x) => window.__rig.controller.selectSong(window.__rig.store.navIds()[x], { index: x }), i);
  await waitSong(ids[i]);
  await page.waitForTimeout(80);
}

test('H-v2 ON tile = the mute: reflects the store both ways; ON = solid slot colour, OFF = grey + struck through', async () => {
  await selectIndex(0);
  const look = (i) =>
    page.evaluate((x) => {
      const t = document.querySelector(`[data-testid=slot-on-${x}]`);
      const probe = document.createElement('i');
      probe.style.color = `var(--slot-${x})`;
      document.body.append(probe);
      const slotColor = getComputedStyle(probe).color;
      probe.remove();
      const cs = getComputedStyle(t);
      return { pressed: t.getAttribute('aria-pressed'), bg: cs.backgroundColor, slotColor, strike: getComputedStyle(t.querySelector('.ot-name')).textDecorationLine, state: t.querySelector('.ot-state').textContent, stripOff: t.closest('.slot').classList.contains('muted') };
    }, i);
  const on = await look(0);
  assert.equal(on.pressed, 'true');
  assert.equal(on.bg, on.slotColor, 'an ON tile is filled with its slot colour');
  assert.equal(on.strike, 'none');
  assert.equal(on.state, 'ON');
  // tap → muted in the store and the engine
  await page.click('[data-testid=slot-on-0]');
  await page.waitForFunction(() => window.__rig.store.currentSong().patch.slots[0].muted === true && window.__rig.engine.getParam('slots.0.gain') === 0);
  const off = await look(0);
  assert.deepEqual({ pressed: off.pressed, bg: off.bg, strike: off.strike, state: off.state, stripOff: off.stripOff }, { pressed: 'false', bg: 'rgb(39, 43, 50)', strike: 'line-through', state: 'OFF', stripOff: true });
  // the range bar over the keyboard goes grey with it
  assert.equal(await page.evaluate(() => document.querySelector('.rbar[data-slot="0"]').classList.contains('off')), true);
  // store → tile (MIDI learn / Edit / another path unmutes)
  await page.evaluate(() => window.__rig.store.set(`songs.${window.__rig.store.currentSong().id}.patch.slots.0.muted`, false));
  await page.waitForFunction(() => document.querySelector('[data-testid=slot-on-0]').getAttribute('aria-pressed') === 'true');
  // no amber under a strip unless locked (amber = lock only, concept §1.2)
  const amber = await page.evaluate(() => {
    const warn = getComputedStyle(document.documentElement).getPropertyValue('--warn').trim();
    const probe = document.createElement('i');
    probe.style.color = warn;
    document.body.append(probe);
    const w = getComputedStyle(probe).color;
    probe.remove();
    return [...document.querySelectorAll('.slot *')].filter((el) => el.offsetParent && [getComputedStyle(el).color, getComputedStyle(el).backgroundColor, getComputedStyle(el).borderTopColor].includes(w)).length;
  });
  assert.equal(amber, 0, 'no --warn colour inside the strips while unlocked');
});

test('H-v2 strip chips write sends.reverb / sends.delay / octave / sustain; "as loaded" mark; an outside tap is swallowed', async () => {
  await selectIndex(0);
  const slot = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__rig.store.currentSong().patch.slots[1])));
  const s0 = await slot();
  const pick = async (chip, value) => {
    await page.click(`[data-testid=${chip}]`);
    await page.waitForSelector('.step-panel');
    await page.click(`.step-panel .sp-step[data-value="${value}"]`);
    await page.waitForSelector('.step-panel', { state: 'detached' });
  };
  const sp = s0.sends.reverb > 0.9 ? 0.5 : 1;
  const ec = s0.sends.delay > 0.2 ? 0 : 0.25;
  await pick('slot-space-1', sp);
  await pick('slot-echo-1', ec);
  await pick('slot-octave-1', -1);
  await page.click('[data-testid=slot-sustain-1]'); // two steps: a tap toggles, no panel
  await page.waitForTimeout(100);
  const s1 = await slot();
  assert.equal(s1.sends.reverb, sp, 'Space → slots.1.sends.reverb');
  assert.equal(s1.sends.delay, ec, 'Echo → slots.1.sends.delay');
  assert.equal(s1.octave, -1, 'Octave → slots.1.octave');
  assert.equal(s1.sustain, !s0.sustain, 'Sustain → slots.1.sustain');
  assert.equal(await page.evaluate(() => window.__rig.engine.getParam('slots.1.octave')), -1, 'engine follows');
  assert.match(await page.textContent('[data-testid=slot-octave-1]'), /Octave\s*−1/);
  // the panel marks the value the song was loaded with, and the chip carries the changed dot
  await page.click('[data-testid=slot-octave-1]');
  const was = await page.evaluate(() => [...document.querySelectorAll('.step-panel .sp-step.was')].map((b) => b.dataset.value));
  assert.deepEqual(was, [String(s0.octave)]);
  assert.equal(await page.isVisible('[data-testid=slot-octave-1] .cdi'), true);
  // an outside tap closes the panel and does not reach what it landed on (another strip's fader)
  const g0 = await page.evaluate(() => window.__rig.store.currentSong().patch.slots[0].gain);
  const fb = await page.locator('[data-testid=slot-fader-0] input').boundingBox();
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height * 0.2, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.step-panel').length), 0, 'panel closed');
  assert.equal(await page.evaluate(() => window.__rig.store.currentSong().patch.slots[0].gain), g0, 'the swallowed tap did not move the Keys fader');
  // … but an ON tile still works through an open panel (round-3 fix 4)
  await page.click('[data-testid=slot-space-1]');
  await page.click('[data-testid=slot-on-0]');
  await page.waitForFunction(() => window.__rig.store.currentSong().patch.slots[0].muted === true);
  await page.click('[data-testid=slot-on-0]');
  // fine slider: a relative drag between the steps
  await page.click('[data-testid=slot-echo-1]');
  const fine = await page.locator('.step-panel .sp-fine input').boundingBox();
  // polish-1: the fine slider fills the panel body (it was 44 px tall under `.fader.compact`); the chip stays ≥ 44 px
  const body = await page.locator('.step-panel .sp-body').boundingBox();
  const chipBox = await page.locator('[data-testid=slot-echo-1]').boundingBox();
  const xBox = await page.locator('.step-panel .sp-x').boundingBox();
  assert.ok(fine.height >= body.height - 2, `fine slider spans the body (${fine.height} of ${body.height})`);
  assert.ok(fine.y >= xBox.y + xBox.height - 1, 'the fine slider starts below the × button');
  assert.ok(chipBox.height >= 44, `the chip keeps a 44 px target (${chipBox.height})`);
  const e0 = await page.evaluate(() => window.__rig.store.currentSong().patch.slots[1].sends.delay);
  await page.mouse.move(fine.x + fine.width / 2, fine.y + fine.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(fine.x + fine.width / 2, fine.y + fine.height * 0.5, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const e1 = await page.evaluate(() => window.__rig.store.currentSong().patch.slots[1].sends.delay);
  assert.ok(e1 > e0 + 0.05, `fine slider raises the Echo send (${e0} → ${e1})`);
  await page.keyboard.press('Escape');
  await hold('[data-testid=revert-song]');
  const back = await slot();
  assert.deepEqual({ r: back.sends.reverb, d: back.sends.delay, o: back.octave, s: back.sustain }, { r: s0.sends.reverb, d: s0.sends.delay, o: s0.octave, s: s0.sustain }, 'Revert puts every chip back');
});

test('H-v2 Sing it in…: the band hears the tapped key, the hands stay in Play-In; the drone follows; Back to', async () => {
  await selectIndex(0);
  const song = () => page.evaluate(() => {
    const s = window.__rig.store.currentSong();
    return { hearIn: s.hearIn, playIn: s.playIn, drone: window.__rig.engine.drone?.key?.pc, t: window.__rig.engine.transpose };
  });
  // start from D / D like the mockup
  await page.evaluate(() => {
    const { store } = window.__rig;
    const s = store.currentSong();
    store.set(`songs.${s.id}.hearIn`, 2);
    store.set(`songs.${s.id}.playIn`, 2);
    store.set(`songs.${s.id}.transposeOctave`, 0);
  });
  await page.waitForFunction(() => window.__rig.engine.drone?.key?.pc === 2);
  await page.click('[data-testid=key-button]');
  await page.waitForSelector('[data-testid=sing-it-in]');
  assert.equal(await page.evaluate(() => document.querySelector('[data-testid=sing-grid] .key-btn.hands')?.dataset.pc), '2', '"you play" marks D');
  await page.click('[data-testid=sing-grid] [data-pc="7"]'); // G
  await page.waitForFunction(() => window.__rig.engine.drone?.key?.pc === 7, null, { timeout: 3000 });
  let s = await song();
  assert.deepEqual({ hearIn: s.hearIn, playIn: s.playIn, t: s.t }, { hearIn: 7, playIn: 2, t: 5 }, 'D → G = +5, hands stay in D');
  assert.equal((await page.textContent('[data-testid=song-key]')).trim(), 'G');
  assert.match(await page.textContent('[data-testid=song-playin]'), /you play D/);
  assert.equal((await page.textContent('[data-testid=transpose-val]')).trim(), '+5');
  assert.match(await page.textContent('[data-testid=sing-it-in] .kp-foot'), /Band hears G · you play D · \+5/);
  await clearToasts();
  await page.screenshot({ path: path.join(shots, 'perform-key.png') });
  await page.click('[data-testid=sing-grid] [data-pc="11"]'); // B
  await page.waitForFunction(() => window.__rig.engine.drone?.key?.pc === 11, null, { timeout: 3000 });
  s = await song();
  assert.deepEqual({ hearIn: s.hearIn, playIn: s.playIn, t: s.t }, { hearIn: 11, playIn: 2, t: -3 }, 'D → B = −3');
  await page.click('[data-testid=sing-back]');
  await page.waitForFunction(() => window.__rig.engine.transpose === 0 && window.__rig.store.currentSong().hearIn === 2);
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid=sing-it-in]', { state: 'detached' });
  await hold('[data-testid=revert-song]');
});

test('H-v2 Quick sheet: TAP sets the song tempo, Swell time steps, This Mac frozen under lock, closes on a song change', async () => {
  await selectIndex(0);
  const t0 = await page.evaluate(() => window.__rig.store.currentSong().tempo);
  await page.click('#btn-quick');
  await page.waitForSelector('[data-testid=quick-sheet]', { state: 'visible' });
  assert.equal(await page.getAttribute('#btn-quick', 'aria-expanded'), 'true');
  // it covers the header + setlist rows only (the strips, keyboard and PANIC stay free)
  const geo = await page.evaluate(() => {
    const q = document.querySelector('[data-testid=quick-sheet]').getBoundingClientRect();
    const hit = (sel) => [...document.querySelectorAll(sel)].some((el) => {
      const r = el.getBoundingClientRect();
      return !(r.right <= q.left || r.left >= q.right || r.bottom <= q.top || r.top >= q.bottom);
    });
    return { strips: hit('.slot'), drone: hit('.p-drone'), keys: hit('.p-keys'), actions: hit('[data-testid=panic], [data-testid=fade-out], [data-testid=revert-song], [data-testid=perform-lock]') };
  });
  assert.deepEqual(geo, { strips: false, drone: false, keys: false, actions: false });
  for (let k = 0; k < 4; k++) {
    await page.click('[data-testid=quick-tap]');
    if (k < 3) await page.waitForTimeout(500);
  }
  await page.waitForTimeout(80);
  const t1 = await page.evaluate(() => window.__rig.store.currentSong().tempo);
  assert.ok(Math.abs(t1 - 120) <= 20, `4 taps 500 ms apart ≈ 120 BPM ±20 (Playwright click overhead on a loaded box; got ${t1}, was ${t0})`);
  assert.match(await page.textContent('[data-testid=quick-sheet] .qs-bpm'), new RegExp(`^${t1}`));
  // Swell time stepper → patch.swell.seconds
  const sw0 = await page.evaluate(() => window.__rig.store.currentSong().patch.swell.seconds);
  await page.click('[data-testid=quick-sheet] .stepper .step-btn.inc');
  await page.waitForFunction((v) => window.__rig.store.currentSong().patch.swell.seconds === v + 1, sw0);
  // Touch writes the machine setting; under lock This Mac is frozen but This song stays live
  const touch0 = await page.evaluate(() => window.__rig.store.get().settings.velocitySens);
  await page.click('[data-testid=quick-sheet] .segmented [data-value="hard"]');
  await page.waitForFunction(() => window.__rig.store.get().settings.velocitySens === 'hard');
  await page.evaluate(() => window.__rig.store.set('settings.performLock', true));
  await page.waitForTimeout(80);
  assert.equal(await page.isDisabled('[data-testid=quick-sheet] .segmented [data-value="soft"]'), true, 'Touch frozen under lock');
  assert.equal(await page.isDisabled('[data-testid=quick-tap]'), false, 'TAP live under lock');
  await page.click('[data-testid=quick-tap]');
  await clearToasts();
  await page.screenshot({ path: path.join(shots, 'perform-quick-locked.png') });
  await page.evaluate(() => window.__rig.store.set('settings.performLock', false));
  await page.evaluate((v) => window.__rig.store.set('settings.velocitySens', v), touch0);
  // Revert covers the Quick tempo and swell edits (H §5)
  await hold('[data-testid=revert-song]');
  const back = await page.evaluate(() => ({ tempo: window.__rig.store.currentSong().tempo, swell: window.__rig.store.currentSong().patch.swell.seconds }));
  assert.deepEqual(back, { tempo: t0, swell: sw0 });
  // a song change closes it
  await selectIndex(1);
  await page.waitForSelector('[data-testid=quick-sheet]', { state: 'hidden' });
  assert.equal(await page.getAttribute('#btn-quick', 'aria-expanded'), 'false');
  await selectIndex(0);
});

test('H-v2 two chips per strip (Settings › Perform view): Octave / Sustain become badges; the fader gets longer', async () => {
  await selectIndex(await richSongIndex());
  const throw4 = await page.evaluate(() => document.querySelector('[data-testid=slot-fader-0] input').getBoundingClientRect().height);
  await page.click('#btn-settings');
  await page.click('[data-testid=setting-perform-chips] [data-value="2"]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('view-settings').hidden);
  assert.equal(await page.evaluate(() => window.__rig.store.get().settings.performChips), 2);
  await page.waitForTimeout(100);
  assert.equal(await page.isVisible('[data-testid=slot-octave-0]'), false);
  assert.equal(await page.isVisible('[data-testid=slot-space-0]'), true);
  // a non-normal Octave shows as a read-only badge (with its changed dot)
  await page.evaluate(() => window.__rig.store.set(`songs.${window.__rig.store.currentSong().id}.patch.slots.0.octave`, 1));
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-testid=slot-0] .oct-badge');
    return b && b.offsetParent && /Oct \+1/.test(b.textContent);
  });
  const throw2 = await page.evaluate(() => document.querySelector('[data-testid=slot-fader-0] input').getBoundingClientRect().height);
  console.log(`# fader throw at 1440×900: 4 chips ${Math.round(throw4)} px, 2 chips ${Math.round(throw2)} px`);
  assert.ok(throw4 >= 240, `4-chip fader ≥ 240 px (${throw4})`);
  assert.ok(throw2 >= 290 && throw2 > throw4 + 40, `2-chip fader ≥ 290 px (${throw2})`);
  await clearToasts();
  await page.screenshot({ path: path.join(shots, 'perform-2chips.png') });
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shots, 'perform-2chips-1024.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => window.__rig.store.set('settings.performChips', 4));
  await hold('[data-testid=revert-song]');
  assert.equal(await page.isVisible('[data-testid=slot-octave-0]'), true);
});

test('H-v2 screenshots: perform, perform-1024, perform-quick, perform-step, perform-off (2 changes, a chord held)', async () => {
  await selectIndex(await richSongIndex());
  await clearToasts();
  // the mockup's two changes: Keys Octave +1, Pad Space 75 %
  await page.click('[data-testid=slot-octave-0]');
  await page.click('.step-panel .sp-step[data-value="1"]');
  const pad = await page.evaluate(() => window.__rig.store.currentSong().patch.slots[1].sends.reverb);
  await page.click('[data-testid=slot-space-1]');
  await page.click(`.step-panel .sp-step[data-value="${Math.abs(pad - 0.75) < 0.01 ? 0.5 : 0.75}"]`);
  await page.waitForSelector('.step-panel', { state: 'detached' });
  assert.equal((await page.textContent('[data-testid=revert-song] .rv-cnt')).trim(), '2 changed');
  await page.evaluate(() => [50, 62, 66, 69].forEach((n) => window.__rig.controller.perform.noteOn(n, 90)));
  await page.waitForTimeout(300);
  await page.mouse.move(700, 880);
  await clearToasts();
  await page.screenshot({ path: path.join(shots, 'perform.png') });
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.waitForTimeout(200);
  await clearToasts();
  await page.screenshot({ path: path.join(shots, 'perform-1024.png') });
  await page.click('#btn-quick');
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shots, 'perform-quick-1024.png') });
  await page.click('#btn-quick');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(200);
  await page.click('#btn-quick');
  await page.waitForTimeout(150);
  await clearToasts();
  await page.screenshot({ path: path.join(shots, 'perform-quick.png') });
  await page.click('#btn-quick');
  await page.click('[data-testid=slot-octave-0]');
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(shots, 'perform-step.png') });
  await page.keyboard.press('Escape');
  await page.click('[data-testid=slot-on-1]');
  await page.waitForTimeout(100);
  await page.mouse.move(700, 880);
  await page.screenshot({ path: path.join(shots, 'perform-off.png') });
  await page.evaluate(() => [50, 62, 66, 69].forEach((n) => window.__rig.controller.perform.noteOff(n)));
  await hold('[data-testid=revert-song]');
  assert.equal(await page.isDisabled('[data-testid=revert-song]'), true);
  await selectIndex(0);
});

test('polish-1 / polish-2A (local L-3): MIDI "pending" = starting (info), "denied" → site settings, "failed" → replug',
  async () => {
    await clearToasts();
    const r = await page.evaluate(async () => {
      const c = window.__rig.controller;
      const real = { ...c.status };
      const fire = (midi) => c.dispatchEvent(new CustomEvent('status', { detail: { ...real, midi } }));
      const read = () => {
        const led = document.getElementById('midi-led');
        return {
          name: document.getElementById('midi-name').textContent,
          warn: led.classList.contains('warn'),
          bad: led.classList.contains('bad'),
          title: document.getElementById('midi-status').title,
          toasts: [...document.querySelectorAll('#toasts > *')].map((x) => ({ text: x.textContent, kind: x.dataset.kind })),
        };
      };
      const out = {};
      fire({ available: false, connected: false, reason: 'pending', pending: true, inputs: [] });
      await new Promise((res) => setTimeout(res, 50));
      out.pending = read();
      fire({ available: false, connected: false, reason: 'denied', pending: false, inputs: [] });
      await new Promise((res) => setTimeout(res, 30));
      out.denied = read();
      fire({ available: false, connected: false, reason: 'failed', pending: false, inputs: [] });
      await new Promise((res) => setTimeout(res, 30));
      out.failed = read();
      c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status } })); // back to the real status
      return out;
    });
    const P = 'MIDI starting… answer the browser’s permission prompt if it appears.';
    assert.equal(r.pending.name, 'Starting…');
    assert.ok(r.pending.warn && !r.pending.bad, 'amber, not red');
    assert.equal(r.pending.title, P);
    const pt = r.pending.toasts.find((x) => x.text.includes(P));
    assert.ok(pt, `a "starting" toast (${r.pending.toasts.map((x) => x.text).join(' | ')})`);
    assert.equal(pt.kind, 'info', 'pending is info, not a warning');
    assert.ok(!r.pending.toasts.some((x) => /could not start|reload/i.test(x.text)), 'no failure / reload advice while pending');
    // the lamp and its tooltip carry the advice (a toast only shows once per session: midiHintShown)
    assert.equal(r.denied.name, 'Blocked');
    assert.ok(r.denied.bad, 'denied is red');
    assert.equal(r.denied.title, 'MIDI was blocked — allow it in the browser’s site settings.');
    assert.equal(r.failed.name, 'Error');
    assert.match(r.failed.title, /unplug and replug the keyboard/);
    await clearToasts();
  });

// ------------------------------------------------------------------------------------------ polish-2A (ux-round2)
// round4-perform P9: + short-and-wide windows (1366×700, 1280×720), which must get the 1024×700 throw (≥ 140)
const VIEWPORTS = [[1280, 800], [1366, 768], [1440, 860], [1440, 900], [1512, 900], [1024, 700], [1366, 700], [1280, 720]];

/**
 * In-page: every Perform / top-bar element that clips (overflow ≠ visible, or an ellipsis) or must stay whole
 * (chips, tiles, buttons, lamps, the song name) and whose content is wider or taller than its box.
 */
const OVERFLOW_PROBE = () => {
  const vis = (el) => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
  // scrollers by design (setlist strip, notes), the inputs themselves, and overlays that are not open here
  // (+ a connected keyboard's name: any length, so it ellipsizes by design; the MIDI *state* words must not)
  const skip = '.setlist-strip, .notes-text, .piano, .fader-input, .wheel-input, .drone-readout, .step-panel, .qs, .keypop, .fx-more, '
    + '.lvl-meter, .midi-name:not(.off)';
  const FIT = '.fxc, .fxpill, .mchip, .ontile .ot-label, .seg, .key-btn, .btn, .toggle, .hold-btn, .tb-item, .tb-status, .nav-next-name, '
    + '.wheel-target, .song-name, .song-sub, .transpose-row, .drone-head, .drone-toggles, .drone-row, .slot-mods, .slot-tag, .p-head > *, .p-main > *';
  const name = (el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}${el.dataset.testid ? `[${el.dataset.testid}]` : ''} `
    + `"${el.textContent.trim().replace(/\s+/g, ' ').slice(0, 28)}"`;
  const bad = new Set();
  for (const root of [document.getElementById('topbar'), document.getElementById('banners'), document.getElementById('view-perform')]) {
    for (const el of root.querySelectorAll('*')) {
      if (!vis(el) || el.closest(skip)) continue;
      const cs = getComputedStyle(el);
      const clipsX = cs.overflowX !== 'visible' || cs.textOverflow === 'ellipsis' || el.matches(FIT);
      const clipsY = cs.overflowY !== 'visible' || el.matches(FIT);
      if (clipsX && el.scrollWidth > el.clientWidth + 1) bad.add(`X ${name(el)} ${el.scrollWidth}>${el.clientWidth}`);
      if (clipsY && el.scrollHeight > el.clientHeight + 1) bad.add(`Y ${name(el)} ${el.scrollHeight}>${el.clientHeight}`);
    }
  }
  const r = (s) => document.querySelector(s).getBoundingClientRect();
  const audio = r('#audio-text');
  const lat = r('#audio-latency');
  return {
    bad: [...bad],
    doc: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    throw: Math.round(r('[data-testid=slot-fader-0] input').height * 10) / 10,
    title: parseFloat(getComputedStyle(document.querySelector('.song-name')).fontSize),
    audioGap: Math.round((lat.left - audio.right) * 10) / 10,
    audioWhole: document.getElementById('audio-text').scrollWidth <= document.getElementById('audio-text').clientWidth,
  };
};

test('polish-2A responsive (ux-round2 L1 / #1, L-6): six windows — nothing clips, fader throw ≥ 200 at ≥ 800 tall, ≥ 140 at 700',
  async () => {
    await selectIndex(0);
    // L-6: a long connected keyboard name squeezes the lamps the way SF Pro does on the Mac
    const squeeze = () => page.evaluate(() => {
      const c = window.__rig.controller;
      c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status, latencyMs: 42,
        midi: { available: true, connected: true, name: 'Keystation 49es MK3 USB MIDI Keyboard', inputs: [{ id: 'k' }], reason: null } } }));
    });
    const rows = [];
    for (const [w, hgt] of VIEWPORTS) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.waitForTimeout(250);
      await squeeze();
      await clearToasts();
      await page.waitForTimeout(80);
      const m = await page.evaluate(OVERFLOW_PROBE);
      rows.push(`${w}×${hgt} throw ${m.throw} title ${m.title}px audio→latency gap ${m.audioGap}`);
      await page.screenshot({ path: path.join(shots, `responsive-${w}x${hgt}.png`) });
      assert.deepEqual(m.bad, [], `${w}×${hgt}: clipped / overflowing: ${m.bad.join(' · ')}`);
      assert.ok(m.doc[0] <= w && m.doc[1] <= hgt, `${w}×${hgt}: no page scroll (${m.doc})`);
      const min = hgt >= 800 ? 200 : 140;
      assert.ok(m.throw >= min, `${w}×${hgt}: fader throw ${m.throw} px ≥ ${min}`);
      assert.ok(m.title >= 32, `${w}×${hgt}: song name ${m.title}px`);
      if ([1280, 1366, 1440].includes(w)) {
        assert.ok(m.audioGap >= 0, `${w}×${hgt}: "Sound OK" ends before the latency (gap ${m.audioGap})`);
        assert.ok(m.audioWhole, `${w}×${hgt}: "Sound OK" is not clipped`);
      }
    }
    console.log(`# ${rows.join('\n# ')}`);
    // mac-findings L-26: at 1024 × 700 on the Mac (SF Pro) "Minor" (55 > 53) and "Movement" (61 > 54) clipped while
    // the Linux faces fit. SFsim = FreeSans widths scaled 105 % (≈ SF Pro Text at these sizes: the Mac's own numbers
    // sit between the 105 % and 109 % stand-ins) and 112 % (margin), with SF's vertical metrics. Only over FreeSans:
    // the Mac runs the loop above in real SF Pro, and a scaled Helvetica Neue is wider than SF (see L-21b), so it
    // would fail on a stand-in artefact. Also: the drone toggles stay one line each (they wrapped from ~108 % before).
    const sfOk = await page.evaluate(async () => {
      const f = new FontFace('SFprobe', 'local("FreeSans")');
      try { await f.load(); return true; } catch { return false; }
    });
    if (!sfOk) console.log('# L-26: FreeSans not installed (macOS runs real SF Pro above) — stand-in pass skipped');
    else {
      try {
        await page.setViewportSize({ width: 1024, height: 700 });
        for (const adj of [105, 112]) {
          await page.evaluate((a) => {
            document.getElementById('sfsim-l26')?.remove();
            const st = document.createElement('style');
            st.id = 'sfsim-l26';
            const m = `size-adjust:${a}%;ascent-override:${Math.round(95 / a * 100)}%;descent-override:${Math.round(24 / a * 100)}%;`
              + 'line-gap-override:0%';
            st.textContent = `@font-face{font-family:SFsim;src:local("FreeSans");${m}}`
              + '@font-face{font-family:SFsim;font-weight:600 900;src:local("FreeSans Bold"),local("FreeSansBold");'
              + `${m}}`
              + ':root{--font:SFsim,sans-serif;--font-display:SFsim,sans-serif}';
            document.head.append(st);
          }, adj);
          await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          });
          await squeeze();
          await clearToasts();
          await page.waitForTimeout(80);
          const m = await page.evaluate(OVERFLOW_PROBE);
          const lines = await page.evaluate(() => [
            ...document.querySelectorAll('#view-perform .drone-toggles .toggle-text')]
            .map((t) => {
              const rg = document.createRange();
              rg.selectNodeContents(t);
              return [t.textContent, new Set([...rg.getClientRects()].map((x) => Math.round(x.top))).size];
            }));
          await page.screenshot({ path: path.join(shots, `responsive-1024x700-sf${adj}.png`) });
          assert.deepEqual(m.bad, [], `L-26 1024×700 @${adj}%: clipped / overflowing: ${m.bad.join(' · ')}`);
          assert.ok(m.doc[0] <= 1024 && m.doc[1] <= 700, `L-26 @${adj}%: no page scroll (${m.doc})`);
          assert.ok(m.throw >= 140, `L-26 @${adj}%: fader throw ${m.throw} px ≥ 140`);
          for (const [t, n] of lines) assert.equal(n, 1, `L-26 @${adj}%: drone toggle "${t}" is one line (${n})`);
        }
      } finally {
        await page.evaluate(() => document.getElementById('sfsim-l26')?.remove());
      }
    }
    // four filled strips (no factory song has four): the narrowest strips keep their tiles, chips and badges whole
    const saved = await page.evaluate(() => {
      const r = window.__rig;
      const s = r.store.currentSong();
      const keep = JSON.stringify(s.patch.slots);
      const filled = s.patch.slots.filter(Boolean);
      for (let i = 0; i < 4; i++) if (!s.patch.slots[i]) r.store.set(`songs.${s.id}.patch.slots.${i}`, JSON.parse(JSON.stringify(filled[i % filled.length])));
      return { id: s.id, keep };
    });
    await page.waitForFunction(() => window.__rig.engine.slots.filter(Boolean).length === 4 && !window.__rig.controller.status.loading, null, { timeout: 30000 });
    try {
      for (const [w, hgt] of [[1366, 768], [1440, 900], [1024, 700]]) {
        await page.setViewportSize({ width: w, height: hgt });
        await page.waitForTimeout(250);
        await clearToasts();
        const m = await page.evaluate(OVERFLOW_PROBE);
        // an instrument's name may ellipsize (any length, full name in its tooltip); nothing else may
        const bad = m.bad.filter((x) => !/span\.slot-inst /.test(x));
        await page.screenshot({ path: path.join(shots, `responsive-4strips-${w}x${hgt}.png`) });
        assert.deepEqual(bad, [], `4 strips at ${w}×${hgt}: ${bad.join(' · ')}`);
      }
    } finally {
      await page.evaluate(({ id, keep }) => {
        const slots = JSON.parse(keep);
        slots.forEach((sl, i) => window.__rig.store.set(`songs.${id}.patch.slots.${i}`, sl));
      }, saved);
      await page.evaluate(() => window.__rig.controller.dispatchEvent(new CustomEvent('status', { detail: { ...window.__rig.controller.status } })));
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(150);
    }
  });

test('polish-2A banners (ux-round2 L2 / #2): one 32 px strip with a chevron; unfolded over the stage; ≥ 130 px throw at 1024',
  async () => {
    await clearToasts();
    const ui = (fn, arg) => page.evaluate(fn, arg);
    await ui(() => {
      const u = window.__rig.ui;
      u.setBanner('t-warn', { kind: 'warn', short: 'Another Worship Rig window is open — this one is muted',
        text: 'Worship Rig is already open in another window. This one is muted and read-only — close it and use the other window.' });
      u.setBanner('t-danger', { kind: 'danger', short: 'Changes are NOT being saved',
        text: 'Your saved library could not be read or backed up, so changes are NOT being saved. Export it from Settings before you edit.',
        actions: [{ label: 'Open Settings', run: () => { window.__bannerRan = (window.__bannerRan || 0) + 1; } }] });
      u.setBanner('t-info', { kind: 'info', text: 'A newer song library (saved yesterday) is available from an earlier session.',
        actions: [{ label: 'Not now', run: () => {} }] });
    });
    const geo = () => ui(() => {
      const r = (el) => el.getBoundingClientRect();
      const strip = document.querySelector('[data-testid=banner-strip]');
      const shown = [...strip.querySelectorAll('.banner')].filter((b) => b.offsetParent !== null);
      return {
        bannersH: document.getElementById('banners').offsetHeight,
        stripH: Math.round(r(strip).height),
        shown: shown.map((b) => b.dataset.testid),
        count: strip.querySelector('.bstrip-count').textContent,
        expanded: strip.querySelector('[data-testid=banner-expand]').getAttribute('aria-expanded'),
        listBottom: r(strip.querySelector('.bstrip-list')).bottom,
        throw: r(document.querySelector('[data-testid=slot-fader-0] input')).height,
        doc: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
        msgClipped: shown.map((b) => { const m = b.querySelector('.banner-msg'); return m.offsetParent !== null && m.scrollWidth > m.clientWidth + 1; }),
      };
    });
    for (const [w, hgt] of [[1440, 900], [1024, 700]]) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.waitForTimeout(250);
      const g = await geo();
      assert.equal(g.bannersH, 32, `${w}: three persistent banners take one 32 px strip (${g.bannersH})`);
      assert.deepEqual(g.shown, ['banner-t-danger'], 'folded: the most urgent one shows');
      assert.equal(g.count, '+2');
      assert.ok(g.doc[0] <= w && g.doc[1] <= hgt, `${w}: fits (${g.doc})`);
      if (w === 1024) assert.ok(g.throw >= 130, `1024×700 with a banner: fader throw ${g.throw} px ≥ 130`);
      await clearToasts();
      await page.screenshot({ path: path.join(shots, `banner-strip-${w}.png`) });
    }
    // the chevron unfolds every message in full over the stage; the layout keeps 32 px; Esc folds it without a panic
    await page.click('[data-testid=banner-expand]');
    const open = await geo();
    assert.equal(open.expanded, 'true');
    assert.deepEqual(open.shown, ['banner-t-danger', 'banner-t-warn', 'banner-t-info'], 'danger → warn → info');
    assert.equal(open.bannersH, 32, 'unfolded, it still takes 32 px of layout');
    assert.ok(open.listBottom > 32 + 56 * 2, 'the list drops over the stage');
    assert.deepEqual(open.msgClipped, [false, false, false], 'full texts, not ellipsized');
    const btn = await page.locator('[data-testid=banner-t-danger] .banner-btn').boundingBox();
    assert.ok(btn.height >= 44, `unfolded buttons are 44 px (${btn.height})`);
    await page.screenshot({ path: path.join(shots, 'banner-strip-open-1024.png') });
    await page.evaluate(() => window.__rig.controller.perform.noteOn(64, 90));
    await page.keyboard.press('Escape');
    const afterEsc = await geo();
    assert.equal(afterEsc.expanded, 'false', 'Esc folds the strip');
    assert.ok(await page.evaluate(() => window.__rig.engine.activeNotes.has(64)), 'that Esc did not panic');
    await page.evaluate(() => window.__rig.controller.perform.noteOff(64));
    // one banner: no count; its action works from the folded strip
    await ui(() => { window.__rig.ui.setBanner('t-warn', null); window.__rig.ui.setBanner('t-info', null); });
    const one = await geo();
    assert.equal(one.count, '');
    await page.click('[data-testid=banner-t-danger] .banner-btn');
    assert.equal(await page.evaluate(() => window.__bannerRan), 1);
    await ui(() => window.__rig.ui.setBanner('t-danger', null));
    const none = await geo();
    assert.equal(none.bannersH, 0, 'no banners: no strip');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(150);
  });

test('polish-2A toasts (ux-round2 L3 / #3): bottom-right above the keyboard row, clear of the header chips; still click-through',
  async () => {
    for (const [w, hgt] of [[1440, 900], [1024, 700]]) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.waitForTimeout(200);
      await clearToasts();
      const r = await page.evaluate(async () => {
        const { toast } = window.__rig.ui;
        const tag = Math.random().toString(36).slice(2, 6); // identical live toasts merge (×N), so each run is new
        toast(`Your screen might dim during long songs. Keep the laptop plugged in. (${tag})`, 'info', { ms: 0 });
        toast(`Sound restarted. (${tag})`, 'ok', { ms: 0 });
        await new Promise((res) => setTimeout(res, 250));
        const box = (el) => el.getBoundingClientRect();
        const hit = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
        const ts = [...document.querySelectorAll('#toasts .toast')].map(box);
        const head = box(document.querySelector('.p-head'));
        const nav = box(document.querySelector('.p-nav'));
        const bottom = box(document.querySelector('.p-bottom'));
        const t0 = ts[0];
        const under = document.elementFromPoint(t0.left + t0.width / 2, t0.top + t0.height / 2);
        return {
          n: ts.length,
          overHead: ts.some((t) => hit(t, head) || hit(t, nav)),
          overBottom: ts.some((t) => hit(t, bottom)),
          rightGap: innerWidth - Math.max(...ts.map((t) => t.right)),
          lowest: Math.max(...ts.map((t) => t.bottom)),
          bottomTop: bottom.top,
          pe: getComputedStyle(document.querySelector('#toasts .toast')).pointerEvents,
          clickThrough: !under.closest('#toasts'),
        };
      });
      assert.equal(r.n, 2);
      assert.equal(r.overHead, false, `${w}: no toast over the header chips or the setlist`);
      assert.equal(r.overBottom, false, `${w}: no toast over the keyboard / PANIC row`);
      assert.ok(r.lowest <= r.bottomTop && r.bottomTop - r.lowest <= 24, `${w}: just above the bottom row (${r.lowest} vs ${r.bottomTop})`);
      assert.ok(r.rightGap >= 8 && r.rightGap <= 24, `${w}: at the right edge (${r.rightGap})`);
      assert.equal(r.pe, 'none');
      assert.equal(r.clickThrough, true, 'a tap on a toast reaches what is under it');
      await page.screenshot({ path: path.join(shots, `toasts-${w}.png`) });
      await clearToasts();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(150);
  });

/** In-page WCAG contrast of an element's text against what it is painted on (opacity, alpha and grayscale composited). */
const CONTRAST_PROBE = () => {
  const rgba = (c) => { const m = (c.match(/[\d.]+/g) || []).map(Number); return [m[0] || 0, m[1] || 0, m[2] || 0, m.length > 3 ? m[3] : 1]; };
  const lum = ([r, g, b]) => {
    const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const mix = (a, b, t) => a.map((v, i) => v * t + b[i] * (1 - t));
  window.__contrast = (el) => {
    let op = 1;
    let gray = false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      op *= parseFloat(cs.opacity);
      if (/grayscale\(1\)/.test(cs.filter)) gray = true;
    }
    let bg = null;
    for (let n = el; n && n.nodeType === 1 && !bg; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c[3] > 0.5) bg = c.slice(0, 3);
    }
    bg ||= rgba(getComputedStyle(document.body).backgroundColor).slice(0, 3);
    const fgc = rgba(getComputedStyle(el).color);
    let fg = mix(fgc.slice(0, 3), bg, fgc[3] * op);
    if (gray) { const g = 0.2126 * fg[0] + 0.7152 * fg[1] + 0.0722 * fg[2]; fg = [g, g, g]; }
    const [x, y] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
  };
};

test('polish-2A contrast + hit targets (ux-round2 #6, #7, #9): Restart, PANIC "Esc", 44 px live controls at 1024, OFF strips ≥ 3:1',
  async () => {
    await selectIndex(0);
    await clearToasts();
    await page.evaluate(CONTRAST_PROBE);
    const c = await page.evaluate(async () => {
      const ctl = window.__rig.controller;
      ctl.dispatchEvent(new CustomEvent('status', { detail: { ...ctl.status, audio: 'stalled' } }));
      await new Promise((res) => setTimeout(res, 50));
      const out = {
        restart: window.__contrast(document.getElementById('btn-restart-audio')),
        panicEsc: window.__contrast(document.querySelector('[data-testid=panic] .panic-k')),
        panic: window.__contrast(document.querySelector('[data-testid=panic] .panic-l')),
      };
      ctl.dispatchEvent(new CustomEvent('status', { detail: { ...ctl.status } }));
      return out;
    });
    console.log(`# contrast polish-2A ${JSON.stringify(c)}`);
    assert.ok(c.restart >= 4.5, `Restart sound ${c.restart}:1 ≥ 4.5`);
    assert.ok(c.panicEsc >= 4.5, `PANIC "Esc" ${c.panicEsc}:1 ≥ 4.5`);
    assert.ok(c.panic >= 4.5, `PANIC ${c.panic}:1 ≥ 4.5`);
    // an OFF strip: its live controls stay readable (≥ 3:1); the fader is what dims
    await page.evaluate(() => {
      const s = window.__rig.store.currentSong();
      window.__rig.store.set(`songs.${s.id}.patch.slots.1.muted`, true);
    });
    await page.waitForFunction(() => document.querySelector('[data-testid=slot-1]').classList.contains('muted'));
    const off = await page.evaluate(() => {
      const strip = document.querySelector('[data-testid=slot-1]');
      const texts = [...strip.querySelectorAll('.mchip .mc-label, .mchip .mc-value, .slot-inst, .wb-val, .slot-badge, .fader-value')]
        .filter((el) => el.offsetParent !== null && el.textContent.trim());
      const eff = (el) => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; };
      return {
        low: texts.map((el) => [el.textContent.trim(), window.__contrast(el)]).filter(([, r]) => r < 3),
        all: texts.map((el) => `${el.textContent.trim()} ${window.__contrast(el)}`),
        chipOpacity: Math.min(...[...strip.querySelectorAll('.mchip')].map(eff)),
        trackOpacity: eff(strip.querySelector('.fader-track')),
      };
    });
    console.log(`# OFF strip ${off.all.join(' · ')} · track opacity ${off.trackOpacity}`);
    assert.deepEqual(off.low, [], 'OFF-strip text under 3:1');
    assert.equal(off.chipOpacity, 1, 'the chips on an OFF strip are not dimmed (they stay live)');
    assert.ok(off.trackOpacity <= 0.5, `the fader track is dimmed (${off.trackOpacity})`);
    await page.screenshot({ path: path.join(shots, 'perform-off-strip.png') });
    await page.evaluate(() => {
      const s = window.__rig.store.currentSong();
      window.__rig.store.set(`songs.${s.id}.patch.slots.1.muted`, false);
    });
    // 1024: the live compact controls are 44 px targets
    await page.setViewportSize({ width: 1024, height: 700 });
    await page.waitForTimeout(250);
    const small = await page.evaluate(() => {
      const sels = ['.swell-btn', '[data-testid=key-button]', '[data-testid=space-row] .fxpill', '[data-testid=echo-row] .fxpill',
        '[data-testid=transpose-up]', '[data-testid=transpose-down]', '.ontile', '.mchip', '[data-testid=panic]', '[data-testid=perform-lock]'];
      const bad = [];
      const sizes = {};
      for (const s of sels) for (const el of document.querySelectorAll(s)) {
        if (!el.offsetParent) continue;
        const r = el.getBoundingClientRect();
        sizes[s] = `${Math.round(r.width)}×${Math.round(r.height)}`;
        if (r.height < 43.5 || r.width < 43.5) bad.push(`${s} ${sizes[s]}`);
      }
      return { bad, sizes };
    });
    console.log(`# 1024 targets ${JSON.stringify(small.sizes)}`);
    assert.deepEqual(small.bad, [], `1024 targets under 44 px: ${small.bad.join(', ')}`);
    for (const chip of ['slot-space-0', 'slot-octave-1']) {
      await page.click(`[data-testid=${chip}]`);
      await page.waitForSelector('.step-panel');
      const p = await page.evaluate(() => {
        const panel = document.querySelector('.step-panel');
        const pr = panel.getBoundingClientRect();
        const strip = panel.parentElement.getBoundingClientRect();
        const tile = panel.parentElement.querySelector('.ontile').getBoundingClientRect();
        return {
          steps: [...panel.querySelectorAll('.sp-step')].map((b) => Math.round(b.getBoundingClientRect().height)),
          inside: pr.top >= strip.top - 0.5 && pr.bottom <= strip.bottom + 0.5,
          tileFree: pr.top >= tile.bottom - 0.5,
          stepsInside: [...panel.querySelectorAll('.sp-step')].every((b) => b.getBoundingClientRect().bottom <= pr.bottom),
        };
      });
      assert.ok(p.steps.every((x) => x >= 44), `${chip} step panel steps ${p.steps} ≥ 44 at 1024`);
      assert.ok(p.inside && p.stepsInside, `${chip}: the panel and its steps stay inside the strip`);
      assert.ok(p.tileFree, `${chip}: the ON tile stays tappable above the panel`);
      if (chip === 'slot-space-0') await page.screenshot({ path: path.join(shots, 'perform-step-1024.png') });
      await page.keyboard.press('Escape');
      await page.waitForSelector('.step-panel', { state: 'detached' });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(150);
  });

test('polish-2A chord readout (ux-round2 G1 / #8): released note by note it idles on the chord, never on a leftover note',
  async () => {
    await selectIndex(0);
    const r = await page.evaluate(async () => {
      const p = window.__rig.controller.perform;
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      p.releaseAll(); // nothing left held by an earlier test
      p.sustain(false);
      await sleep(40);
      const read = () => {
        const el = document.querySelector('.chord-readout');
        return `${el.querySelector('.chord-name').textContent}${el.classList.contains('live') ? '*' : ''}`;
      };
      const out = [];
      for (const n of [50, 62, 66, 69]) { p.noteOn(n, 90); await sleep(40); }
      out.push(read());
      for (const n of [50, 62, 66, 69]) { p.noteOff(n); await sleep(40); out.push(read()); }
      // a lone key never becomes the readout
      p.noteOn(69, 90); await sleep(40); out.push(read());
      p.noteOff(69); await sleep(40);
      // the pedal: keys released while it's down leave the readout idle (it holds the sound, not the hands)
      p.sustain(true);
      for (const n of [52, 55, 59]) { p.noteOn(n, 90); await sleep(30); }
      out.push(read());
      for (const n of [52, 55, 59]) { p.noteOff(n); await sleep(30); }
      out.push(read());
      p.sustain(false);
      await sleep(40);
      return out;
    });
    console.log(`# chord readout: ${r.join(' | ')}`);
    assert.equal(r[0], 'D*', 'D major held → live "D"');
    assert.deepEqual(r.slice(1, 5), ['D*', 'D*', 'D', 'D'], 'with < 2 keys left it idles on "D" (dimmed), never "A"');
    assert.equal(r[5], 'D', 'a lone A does not replace the chord');
    assert.equal(r[6], 'Em*');
    assert.equal(r[7], 'Em', 'pedal-held notes do not keep the readout live');
  });

// ------------------------------------------------------------------------------------------ round4-perform
// reviews/round4-perform.md P1–P13 (each test names its finding)

test('round4-perform P1: the bottom-row hold captions (Revert, unlock) are drawn inside the view', async () => {
  await selectIndex(0);
  const capIn = (sel) => page.evaluate((s) => {
    const cap = document.querySelector(`${s} .hb-cap`);
    const c = cap.getBoundingClientRect();
    const v = document.getElementById('view-perform').getBoundingClientRect();
    return { shown: !cap.hidden, top: c.top, bottom: c.bottom, vTop: v.top, vBottom: v.bottom, h: c.height };
  }, sel);
  try {
    for (const [w, hgt] of [[1440, 900], [1024, 700], [1280, 800]]) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.waitForTimeout(200);
      await page.click('[data-testid=drone-on]'); // arms Revert
      await page.waitForFunction(() => !document.querySelector('[data-testid=revert-song]').disabled);
      await page.click('[data-testid=revert-song]'); // a tap: the hint
      let m = await capIn('[data-testid=revert-song]');
      assert.ok(m.shown && m.h > 10, `${w}×${hgt}: Revert hint shown`);
      assert.ok(m.top >= m.vTop && m.bottom <= m.vBottom, `${w}×${hgt}: Revert caption ${m.top}–${m.bottom} inside the view ${m.vTop}–${m.vBottom}`);
      await hold('[data-testid=revert-song]');
      await page.waitForFunction(() => document.querySelector('[data-testid=revert-song]').disabled);
      await page.click('[data-testid=perform-lock]');
      await page.waitForFunction(() => window.__rig.store.get().settings.performLock === true);
      await page.waitForTimeout(700); // the click that locked leaves no hint behind
      await page.click('[data-testid=perform-lock]'); // a tap while locked: the "press and hold" hint
      m = await capIn('[data-testid=perform-lock]');
      assert.ok(m.shown, `${w}×${hgt}: unlock hint shown`);
      assert.ok(m.top >= m.vTop && m.bottom <= m.vBottom, `${w}×${hgt}: Lock caption ${m.top}–${m.bottom} inside the view ${m.vTop}–${m.vBottom}`);
      if (w === 1024) {
        await clearToasts();
        await page.screenshot({ path: path.join(shots, 'round4-holdcap-1024.png') });
      }
      await hold('[data-testid=perform-lock]');
      await page.waitForFunction(() => window.__rig.store.get().settings.performLock === false);
    }
  } finally {
    await page.evaluate(() => window.__rig.store.set('settings.performLock', false));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(150);
  }
});

// ------------------------------------------------------------------------------------------ hardware-fixes
// reviews/hardware-checklist.md results log (Ryan at the Keystation, built app) + BACKLOG B first bullet

test('hardware-fixes L-23: every hold caption is measured when shown and stays inside the window (lock hint at '
  + '1280×720 and 1440×900 on the bottom row; transpose captions inside their panel)', async () => {
  await selectIndex(0);
  const capBox = (sel) => page.evaluate((s) => {
    const cap = document.querySelector(`${s} .hb-cap`);
    const c = cap.getBoundingClientRect();
    const b = document.querySelector(s).getBoundingClientRect();
    const p = document.querySelector('.transpose').getBoundingClientRect();
    return { shown: !cap.hidden, l: c.left, t: c.top, r: c.right, b: c.bottom, h: c.height, text: cap.textContent,
      vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight, place: cap.dataset.place || '',
      btnTop: b.top, pl: p.left, pr: p.right };
  }, sel);
  const inWindow = (m) => m.l >= 0 && m.t >= 0 && m.r <= m.vw && m.b <= m.vh;
  try {
    await page.evaluate(() => window.__rig.store.set('settings.performLock', true));
    for (const [w, hgt] of [[1280, 720], [1440, 900], [1024, 700], [1366, 768]]) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.waitForTimeout(250);
      await page.click('[data-testid=perform-lock]'); // a tap while locked: the "press and hold" hint
      let m = await capBox('[data-testid=perform-lock]');
      assert.ok(m.shown && m.h > 10, `${w}×${hgt}: unlock hint shown`);
      assert.ok(inWindow(m), `${w}×${hgt}: unlock hint ${JSON.stringify(m)} fully inside the window`);
      assert.ok(m.b <= m.btnTop, `${w}×${hgt}: drawn above the bottom-row button (${m.b} ≤ ${m.btnTop})`);
      assert.equal(m.text, 'press and hold (0.6 s)');
      // the caption while holding (a different, measured-again text), then release early: hint again
      await page.hover('[data-testid=perform-lock]');
      await page.mouse.down();
      await page.waitForTimeout(150);
      m = await capBox('[data-testid=perform-lock]');
      assert.ok(m.shown && inWindow(m), `${w}×${hgt}: "keep holding" inside the window ${JSON.stringify(m)}`);
      await page.mouse.up();
      assert.equal(await page.evaluate(() => window.__rig.store.get().settings.performLock), true, 'a short press keeps it');
      for (const sel of ['[data-testid=transpose-down]', '[data-testid=transpose-up]']) {
        await page.click(sel);
        m = await capBox(sel);
        assert.ok(m.shown && inWindow(m), `${w}×${hgt}: ${sel} hint inside the window`);
        assert.ok(m.l >= m.pl - 0.5 && m.r <= m.pr + 0.5, `${w}×${hgt}: ${sel} hint ${m.l}–${m.r} inside the Transpose panel ${m.pl}–${m.pr}`);
      }
      if (w === 1280) {
        await page.click('[data-testid=perform-lock]');
        await clearToasts();
        await page.screenshot({ path: path.join(shots, 'hwfix-lock-hint-1280x720.png') });
      }
    }
    // a caption pinned against the window's bottom edge flips above; against the right edge it slides left
    const flip = await page.evaluate(async () => {
      const { holdButton } = await import('/js/views/components/holdButton.js');
      const out = {};
      for (const [k, css] of [['bottom', 'left:300px;bottom:2px'], ['right', 'right:0;top:200px'], ['top', 'left:300px;top:0']]) {
        const hb = holdButton({ label: 'X', requireHold: true });
        hb.el.style.cssText = `position:fixed;${css};width:60px;height:40px`;
        document.body.append(hb.el);
        hb.el.click();
        const c = hb.el.querySelector('.hb-cap').getBoundingClientRect();
        out[k] = { place: hb.el.querySelector('.hb-cap').dataset.place || '', inside: c.left >= 0 && c.top >= 0
          && c.right <= document.documentElement.clientWidth && c.bottom <= document.documentElement.clientHeight };
        hb.destroy();
      }
      return out;
    });
    assert.deepEqual(flip, { bottom: { place: 'above', inside: true }, right: { place: '', inside: true },
      top: { place: '', inside: true } });
  } finally {
    await page.evaluate(() => window.__rig.store.set('settings.performLock', false));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(150);
  }
});

test('hardware-fixes 2b (Mac polish-2A at 1366×768: transpose row 140 > 137): the value takes what the buttons leave, '
  + '"+5" / "−18" / "+17" fit in wide display faces: no spill out of the value box, never over a ± button', async () => {
  await selectIndex(0);
  // a transient hold caption (the previous test's hints, 1.6 s) is an overlay, not row content: let it go first
  await page.waitForFunction(() => [...document.querySelectorAll('.hb-cap')].every((c) => c.hidden), null, { timeout: 5000 });
  const setT = (v) => page.evaluate(async (want) => {
    const { transposeSemisOf } = await import('/js/store.js');
    const r = window.__rig;
    r.controller.transposeBy(want - transposeSemisOf(r.store.currentSong()));
    await new Promise((res) => setTimeout(res, 60));
  }, v);
  const rows = [];
  try {
    // DejaVu Sans Bold digits (0.70 em) are wider than SF Pro Display Heavy's (≈ 0.67 em, 2.2ch = 44 px on the Mac):
    // with the old 2.2ch min-width it reproduces the Mac's overflow on Linux. Its minus (.84 em) is wider still, so
    // "−18" here is a worst case for SF (44.6 px at 20 px; the tightest room is 46 px at 1440×900).
    for (const font of ['DejaVu Sans', 'Liberation Sans']) {
      await page.evaluate((f) => document.documentElement.style.setProperty('--font-display', `'${f}'`), font);
      for (const [w, hgt] of [[1366, 768], [1280, 720], [1440, 900], [1024, 700]]) {
        await page.setViewportSize({ width: w, height: hgt });
        await page.waitForTimeout(200);
        for (const v of [0, 5, -18, 17]) {
          await setT(v);
          const m = await page.evaluate(() => {
            const row = document.querySelector('.transpose-row');
            const val = row.querySelector('.transpose-val');
            const btns = [...row.querySelectorAll('.hold-btn')];
            const rg = document.createRange();
            rg.selectNodeContents(val);
            const t = rg.getBoundingClientRect();
            return { row: [row.scrollWidth, row.clientWidth], val: [val.scrollWidth, val.clientWidth], text: val.textContent,
              btns: btns.map((b) => [b.scrollWidth, b.clientWidth]), fs: getComputedStyle(val).fontSize,
              ink: [t.left - btns[0].getBoundingClientRect().right, btns[1].getBoundingClientRect().left - t.right] };
          });
          rows.push(`${font} ${w}×${hgt} ${m.text}: row ${m.row.join('/')} val ${m.val.join('/')} @${m.fs} `
            + `clear ${m.ink.map((x) => x.toFixed(1)).join('/')}`);
          // the row and the buttons clip (FIT in OVERFLOW_PROBE): no tolerance there
          assert.ok(m.row[0] <= m.row[1] + 1, `${font} ${w}×${hgt} ${m.text}: row ${m.row[0]} > ${m.row[1]}`);
          for (const [sw, cw] of m.btns) assert.ok(sw <= cw + 1, `${font} ${w}×${hgt}: a ± button's content fits`);
          // themes-final: the value box is the whole room between the buttons (no row gap), so it has no slack to
          // spill into; +1 is scrollWidth's rounding only. The text box itself never reaches a button.
          assert.ok(m.val[0] <= m.val[1] + 1, `${font} ${w}×${hgt} ${m.text}: value ${m.val[0]} > ${m.val[1]} + 1`);
          assert.ok(Math.min(...m.ink) >= 0, `${font} ${w}×${hgt} ${m.text}: text over a ± button (${m.ink.join(', ')})`);
        }
      }
    }
    console.log(`# ${rows.join('\n# ')}`);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.waitForTimeout(200);
    await setT(0);
    await page.evaluate(() => document.documentElement.style.removeProperty('--font-display'));
    await clearToasts();
    const m = await page.evaluate(OVERFLOW_PROBE);
    assert.deepEqual(m.bad, [], `1366×768: ${m.bad.join(' · ')}`);
  } finally {
    await page.evaluate(() => document.documentElement.style.removeProperty('--font-display'));
    await setT(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(150);
  }
});

test('hardware-fixes: Quick shows "Bluetooth output adds ~176 ms…" in its header while the output latency is > 60 ms; '
  + '× dismisses it per device name (shared with Settings)', async () => {
  await selectIndex(0);
  await page.evaluate(() => {
    window.__fakeOut = 'JBL Charge 5 (Bluetooth)';
    navigator.mediaDevices.enumerateDevices = async () => [
      { kind: 'audiooutput', deviceId: 'default', label: `Default - ${window.__fakeOut}`, groupId: 'g' },
    ];
    localStorage.removeItem('worship-rig.latency-hint.dismissed');
    const c = window.__rig.controller;
    window.__fakeLat = (ms) => c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status, latencyMs: ms } }));
  });
  const hint = '[data-testid=quick-latency-hint]';
  const state = (ms) => page.evaluate(async ([m, sel]) => {
    window.__fakeLat(m);
    await new Promise((res) => setTimeout(res, 120));
    const el = document.querySelector(sel);
    const t = el.querySelector('.lh-text');
    const head = document.querySelector('.qs-h');
    // mac-findings: the text may wrap to two lines (SF Pro); "whole" = no horizontal or vertical cut of the text box
    const lh = parseFloat(getComputedStyle(t).lineHeight);
    return { shown: !el.hidden, text: t.textContent, clipped: t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1,
      lines: Math.round(t.clientHeight / lh), x: Math.round(document.querySelector('.qs-h .qs-x').getBoundingClientRect().width),
      head: head.scrollWidth <= head.clientWidth + 1, sub: document.querySelector('.qs-sub').offsetParent !== null };
  }, [ms, hint]);
  try {
    await page.click('#btn-quick');
    await page.waitForSelector('[data-testid=quick-sheet]:not([hidden])');
    for (const [w, hgt] of [[1440, 900], [1280, 720], [1024, 700]]) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.waitForTimeout(200);
      let m = await state(176);
      assert.ok(m.shown, `${w}: shown at 176 ms`);
      assert.equal(m.text, 'Bluetooth output adds ~176 ms — use the headphone jack or a dock for live playing');
      assert.ok(!m.clipped, `${w}×${hgt}: the whole line shows`);
      assert.ok(m.head, `${w}: the Quick header does not overflow`);
      assert.equal(m.sub, false, 'it takes the subtitle\'s place');
      if (w === 1280) {
        await clearToasts();
        await page.screenshot({ path: path.join(shots, 'hwfix-quick-latency-1280x720.png') });
      }
      m = await state(20);
      assert.equal(m.shown, false, `${w}: hidden at 20 ms (the dock)`);
    }
    // mac-findings (Mac ui-core at 1280 × 720: "the whole line shows" failed in SF Pro): under the SF stand-in
    // (FreeSans × 105 % ≈ SF Pro Text, × 112 % margin; FreeSans-only, as L-26) the sentence wraps to ≤ 2 lines, every
    // glyph inside the text box, and the header's × keeps its 44 px (it shrank to 41 px before).
    const sfOk = await page.evaluate(async () => {
      const f = new FontFace('SFprobe', 'local("FreeSans")');
      try { await f.load(); return true; } catch { return false; }
    });
    if (!sfOk) console.log('# Bluetooth hint: FreeSans not installed (macOS runs real SF Pro above) — stand-in pass skipped');
    else {
      try {
        const rows = [];
        for (const adj of [105, 112]) {
          await page.evaluate((a) => {
            document.getElementById('sfsim-bt')?.remove();
            const st = document.createElement('style');
            st.id = 'sfsim-bt';
            const m = `size-adjust:${a}%;ascent-override:${Math.round(95 / a * 100)}%;descent-override:${Math.round(24 / a * 100)}%;`
              + 'line-gap-override:0%';
            st.textContent = `@font-face{font-family:SFsim;src:local("FreeSans");${m}}`
              + '@font-face{font-family:SFsim;font-weight:600 900;src:local("FreeSans Bold"),local("FreeSansBold");'
              + `${m}}`
              + ':root{--font:SFsim,sans-serif;--font-display:SFsim,sans-serif}';
            document.head.append(st);
          }, adj);
          for (const [w, hgt] of [[1440, 900], [1366, 768], [1280, 720], [1024, 700]]) {
            await page.setViewportSize({ width: w, height: hgt });
            await page.waitForTimeout(150);
            await page.evaluate(() => document.fonts.ready);
            const m = await state(176);
            rows.push(`${adj}% ${w}: ${m.lines} line(s)`);
            assert.ok(m.shown && !m.clipped, `${w}×${hgt} @${adj}%: the whole sentence shows`);
            assert.ok(m.lines <= 2, `${w}×${hgt} @${adj}%: ≤ 2 lines (${m.lines})`);
            assert.ok(m.head, `${w} @${adj}%: the Quick header does not overflow`);
            assert.ok(m.x >= (w <= 1250 ? 36 : 44), `${w} @${adj}%: × keeps its width (${m.x})`);
          }
        }
        console.log(`# Bluetooth hint under SFsim: ${rows.join(' · ')}`);
      } finally {
        await page.evaluate(() => document.getElementById('sfsim-bt')?.remove());
      }
    }
    assert.equal((await state(60)).shown, false, '60 ms is not "above 60"');
    await state(176);
    await page.click(`${hint} .lh-x`);
    assert.equal((await state(176)).shown, false, 'dismissed for this output');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('worship-rig.latency-hint.dismissed'))),
      ['JBL Charge 5 (Bluetooth)']);
    // another output name (AirPods) warns again
    await page.evaluate(() => { window.__fakeOut = 'AirPods'; navigator.mediaDevices.dispatchEvent(new Event('devicechange')); });
    await page.waitForFunction(() => { window.__fakeLat(176); return !document.querySelector('[data-testid=quick-latency-hint]').hidden; },
      null, { timeout: 5000, polling: 100 });
  } finally {
    await page.evaluate(() => {
      delete navigator.mediaDevices.enumerateDevices;
      localStorage.removeItem('worship-rig.latency-hint.dismissed');
      const c = window.__rig.controller;
      c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status } }));
    });
    if (await page.isVisible('[data-testid=quick-sheet]')) await page.click('#btn-quick');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(150);
  }
});

test('round4-perform P2 (local L-20): the song name\'s line box holds tall-metric fonts (no +1 slack); the KEY row still fits',
  async () => {
    await selectIndex(0);
    const rows = [];
    try {
      // L-20 (Mac, SF Pro): "SFsim" / "SFstress" stand in for SF Pro Display, which Linux CI does not have: FreeSans widths
      // with SF's vertical metrics (ascent .95 + descent .24 = 1.19 em; the overrides are divided by size-adjust, which scales
      // them) and a stress face at 1.23 em, just inside the 1.25 em line box. The CSS rule is what makes this
      // font-independent, so this proves it rather than pinning a pixel value.
      await page.evaluate(() => {
        const st = document.createElement('style');
        st.id = 'sfsim-l20';
        st.textContent = '@font-face{font-family:SFsim;src:local("FreeSans");size-adjust:105%;ascent-override:90%;'
          + 'descent-override:23%;line-gap-override:0%}@font-face{font-family:SFstress;src:local("FreeSans");size-adjust:112%;'
          + 'ascent-override:89%;descent-override:21%;line-gap-override:0%}';
        document.head.append(st);
      });
      for (const font of ['Carlito', 'DejaVu Sans', 'SFsim', 'SFstress']) {
        for (const [w, hgt] of [[1280, 800], [1440, 900], [1024, 700], [1366, 700]]) {
          await page.setViewportSize({ width: w, height: hgt });
          await page.waitForTimeout(200);
          const m = await page.evaluate(async (f) => {
            const n = document.querySelector('.song-name');
            n.style.fontFamily = `"${f}", var(--font-display)`;
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            const block = document.querySelector('.song-block').getBoundingClientRect();
            const sub = document.querySelector('.song-sub').getBoundingClientRect();
            return { sh: n.scrollHeight, ch: n.clientHeight, subBottom: sub.bottom, blockBottom: block.bottom, fs: getComputedStyle(n).fontSize,
              lh: parseFloat(getComputedStyle(n).lineHeight), ff: getComputedStyle(n).fontFamily.slice(0, 24) };
          }, font);
          rows.push(`${font} ${w}×${hgt} ${m.sh}/${m.ch} (${m.fs})`);
          assert.ok(m.sh <= m.ch, `${font} ${w}×${hgt}: .song-name scrollHeight ${m.sh} ≤ clientHeight ${m.ch}`);
          // L-20: the box is line-height × 1 line whatever the font (a metric-tolerant bound, not a 40 px pixel value)
          assert.ok(Math.abs(m.ch - m.lh) <= 1, `${font} ${w}×${hgt}: .song-name box ${m.ch} = line-height ${m.lh} × 1 line`);
          assert.ok(m.subBottom <= m.blockBottom + 0.5, `${font} ${w}×${hgt}: the KEY row ends inside the song block (${m.subBottom} ≤ ${m.blockBottom})`);
        }
      }
      console.log(`# ${rows.join(' · ')}`);
    } finally {
      await page.evaluate(() => {
        document.querySelector('.song-name').style.fontFamily = '';
        document.getElementById('sfsim-l20')?.remove();
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(150);
    }
  });

test('round4-perform P3: Quick › "If something\'s wrong" says Paused / Muted like the top bar; Paused resumes in one click',
  async () => {
    await selectIndex(0);
    await page.click('#btn-quick');
    await page.waitForSelector('[data-testid=quick-sheet]', { state: 'visible' });
    try {
      const r = await page.evaluate(async () => {
        const c = window.__rig.controller;
        const real = { ...c.status };
        const read = () => {
          const ok = document.querySelector('[data-testid=quick-sheet] .qs-ok');
          const now = document.querySelector('[data-testid=quick-restart]');
          return {
            text: ok.querySelector('.qs-ok-t').textContent,
            led: ok.querySelector('.led').className,
            top: document.getElementById('audio-text').textContent,
            oneClick: !now.hidden,
            label: now.textContent.trim(),
            holdShown: !document.querySelector('[data-testid=quick-sheet] .qs-restart-hold').hidden,
          };
        };
        const out = {};
        // the controller's 1 s tick re-emits the real status; each read happens in the same task as its dispatch
        c.dispatchEvent(new CustomEvent('status', { detail: { ...real, audio: 'suspended' } }));
        out.paused = read();
        window.__resumed = 0;
        const orig = c.resumeAudio;
        c.resumeAudio = async () => { window.__resumed += 1; };
        document.querySelector('[data-testid=quick-restart]').click();
        c.resumeAudio = orig;
        out.resumed = window.__resumed;
        c.dispatchEvent(new CustomEvent('status', { detail: { ...real, instance: 'secondary' } }));
        out.muted = read();
        c.dispatchEvent(new CustomEvent('status', { detail: { ...real, audio: 'running', instance: 'primary' } }));
        out.ok = read();
        c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status } }));
        return out;
      });
      assert.deepEqual(r.paused, { text: 'Sound paused', led: 'led warn', top: 'Paused', oneClick: true, label: 'Resume sound', holdShown: false });
      assert.equal(r.resumed, 1, 'Resume sound → controller.resumeAudio()');
      assert.equal(r.muted.text, 'Muted (another window is open)');
      assert.equal(r.muted.led, 'led warn');
      assert.equal(r.muted.top, 'Muted');
      assert.equal(r.ok.text, 'Sound OK');
      assert.equal(r.ok.led, 'led ok');
      assert.equal(r.ok.holdShown, true, 'OK: restart stays a 1 s hold');
    } finally {
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-testid=quick-sheet]', { state: 'hidden' });
    }
  });

test('round4-perform P4: "Open Settings" from the unfolded banner strip folds it; the Settings close button is the hit target',
  async () => {
    await clearToasts();
    await page.evaluate(() => {
      const u = window.__rig.ui;
      u.setBanner('t-lib', { kind: 'danger', short: 'Changes are NOT being saved', text: 'Changes are not being saved right now.',
        actions: [{ label: 'Open Settings', testid: 't-open-settings', run: () => window.__rig.ctx.openSettings({ section: 'backups' }) }] });
      u.setBanner('t-warn', { kind: 'warn', short: 'Another window is open', text: 'Another Worship Rig window is open.' });
    });
    try {
      await page.click('[data-testid=banner-expand]');
      await page.waitForFunction(() => document.querySelector('[data-testid=banner-strip]').classList.contains('open'));
      await page.click('[data-testid=t-open-settings]');
      await page.waitForSelector('#view-settings', { state: 'visible' });
      const m = await page.evaluate(() => {
        const x = document.querySelector('#view-settings .st-close');
        const b = x.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return { open: document.querySelector('[data-testid=banner-strip]').classList.contains('open'), hit: !!hit && x.contains(hit) };
      });
      assert.deepEqual(m, { open: false, hit: true });
      await page.click('#view-settings .st-close');
      await page.waitForSelector('#view-settings', { state: 'hidden' });
    } finally {
      await page.evaluate(() => {
        window.__rig.ui.setBanner('t-lib', null);
        window.__rig.ui.setBanner('t-warn', null);
      });
      await page.waitForTimeout(100);
    }
  });

test('round4-perform P5: opening and closing "Sing it in…" does not leak its DOM (CDP DOM counters after GC)', async () => {
  await selectIndex(0);
  const cdp = await context.newCDPSession(page);
  const counters = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    await page.waitForTimeout(50);
    await cdp.send('HeapProfiler.collectGarbage');
    return cdp.send('Memory.getDOMCounters');
  };
  // in-page clicks + Esc with two frames between (the popover is laid out and painted): Playwright's own
  // click / waitForSelector keep element references of their own and would show as a leak here
  const cycle = (n) => page.evaluate(async (count) => {
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const b = document.querySelector('[data-testid=key-button]');
    let opened = 0;
    for (let k = 0; k < count; k++) {
      b.click();
      await frames();
      opened += document.querySelectorAll('[data-testid=sing-it-in]').length;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await frames();
    }
    return { opened, left: document.querySelectorAll('[data-testid=sing-it-in]').length };
  }, n);
  try {
    await cycle(3); // warm-up
    await clearToasts();
    const a = await counters();
    const c = await cycle(40);
    assert.deepEqual(c, { opened: 40, left: 0 });
    await page.waitForTimeout(300);
    const b = await counters();
    const dn = b.nodes - a.nodes;
    const dl = b.jsEventListeners - a.jsEventListeners;
    console.log(`# Sing it in… ×40: Δnodes ${dn}, Δlisteners ${dl}`);
    assert.ok(dn < 20, `Δnodes ${dn} < 20 after 40 open/close cycles (was ≈ +52 per open)`);
    assert.ok(dl < 20, `Δlisteners ${dl} < 20 (was ≈ +26 per open)`);
  } finally {
    await cdp.detach();
  }
});

test('round4-perform P6: under lock the newer-library offer has only "Not now"; unlocking brings "Use that library" back at once',
  async () => {
    await clearToasts();
    const r = await page.evaluate(async () => {
      const { controller: c, store } = window.__rig;
      const buttons = () => [...document.querySelectorAll('[data-testid=banner-other-library] .banner-btn')].map((b) => b.textContent);
      const other = { origin: 'http://127.0.0.1:8439', savedAt: Date.now() - 3600e3, path: '/tmp/b.json' };
      const out = {};
      store.set('settings.performLock', true);
      for (let k = 0; k < 5; k++) await Promise.resolve();
      c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status, otherLibrary: other } }));
      out.locked = buttons();
      // no status tick in between: the lock change itself re-renders the banners (microtasks only)
      store.set('settings.performLock', false);
      for (let k = 0; k < 8; k++) await Promise.resolve();
      out.unlocked = buttons();
      c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status } }));
      return out;
    });
    assert.deepEqual(r.locked, ['Not now'], 'no one-tap library replacement under lock');
    assert.deepEqual(r.unlocked, ['Use that library', 'Not now']);
    const lock = await page.evaluate(async () => (await import('/js/views/perform.js')).LOCK);
    for (const item of ['banner: Open Settings / Use that library', 'pad folder choose / change']) {
      assert.ok(lock.frozen.includes(item), `LOCK.frozen has "${item}"`);
    }
    for (const item of ['pad folder Rescan (Mac app, pads loaded)', 'top bar: master volume / REC / Quick', 'Notes toggle']) {
      assert.ok(lock.live.includes(item), `LOCK.live has "${item}"`);
    }
    // the top-bar items the table calls live really are live under lock
    await page.evaluate(() => window.__rig.store.set('settings.performLock', true));
    await page.waitForTimeout(80);
    const tb = await page.evaluate(() => ({
      master: document.querySelector('[data-testid=master-fader] input').disabled,
      rec: document.getElementById('btn-rec').disabled,
      quick: document.getElementById('btn-quick').disabled,
    }));
    await page.evaluate(() => window.__rig.store.set('settings.performLock', false));
    assert.deepEqual(tb, { master: false, rec: false, quick: false });
  });

test('round4-perform P7 / P8: the MIDI "starting" toast goes when MIDI answers; an error toast outlives later infos', async () => {
  await clearToasts();
  const r = await page.evaluate(async () => {
    const { controller: c, ui } = window.__rig;
    const P = 'MIDI starting… answer the browser’s permission prompt if it appears.';
    const live = () => [...document.querySelectorAll('#toasts > .toast:not(.leaving)')].map((t) => t.querySelector('.toast-msg').textContent);
    const out = {};
    // P7: the once-per-session pending toast (shown by the polish-1 test) is re-created here
    ui.toast(P, 'info', { ms: 10000 });
    c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status, midi: { available: false, connected: false, reason: 'pending', pending: true, inputs: [] } } }));
    out.pending = live().includes(P);
    await new Promise((res) => setTimeout(res, 50));
    c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status, midi: { available: true, connected: true, name: 'Keystation', inputs: [{ id: 'k' }], reason: null } } }));
    await new Promise((res) => setTimeout(res, 300));
    out.connected = live().includes(P);
    out.lamp = document.getElementById('midi-name').textContent;
    c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status } }));
    document.querySelectorAll('#toasts .toast').forEach((t) => t.remove());
    // P8
    ui.toast('round4 P8 error', 'error');
    ui.toast('round4 P8 info one');
    ui.toast('round4 P8 info two');
    out.stack = live();
    ui.toast('round4 P8 warn');
    out.stack2 = live();
    return out;
  });
  assert.equal(r.pending, true);
  assert.equal(r.connected, false, 'the "starting" toast is dismissed once MIDI is connected');
  assert.equal(r.lamp, 'Keystation');
  assert.deepEqual(r.stack, ['round4 P8 error', 'round4 P8 info two'], 'the oldest info goes first, not the error');
  assert.deepEqual(r.stack2, ['round4 P8 error', 'round4 P8 warn']);
  await page.waitForTimeout(250);
  await clearToasts();
});

test('round4-perform P10: "Sing it in…" and "Back to" keep a saved octave; +7 (octave flip) then Back still returns to 0',
  async () => {
    await selectIndex(0);
    const rebaseline = async () => {
      await page.evaluate(() => window.__rig.store.set('settings.view', 'edit'));
      await page.waitForFunction(() => !document.getElementById('view-edit').hidden);
      await page.evaluate(() => window.__rig.store.set('settings.view', 'perform'));
      await page.waitForFunction(() => !document.getElementById('view-perform').hidden);
    };
    const song = () => page.evaluate(() => {
      const s = window.__rig.store.currentSong();
      return { hearIn: s.hearIn, playIn: s.playIn, oct: s.transposeOctave || 0,
        revert: document.querySelector('[data-testid=revert-song]').disabled, back: document.querySelector('[data-testid=sing-back]')?.disabled };
    });
    const set = (h, p, o) => page.evaluate(([a, b, c]) => {
      const { store } = window.__rig;
      const s = store.currentSong();
      store.set(`songs.${s.id}.hearIn`, a);
      store.set(`songs.${s.id}.playIn`, b);
      store.set(`songs.${s.id}.transposeOctave`, c);
    }, [h, p, o]);
    const orig = await page.evaluate(() => {
      const s = window.__rig.store.currentSong();
      return [s.hearIn, s.playIn, s.transposeOctave || 0];
    });
    try {
      await set(2, 2, 1); // D, one octave up, saved
      await rebaseline();
      assert.equal((await page.textContent('[data-testid=transpose-val]')).trim(), '+12');
      await page.click('[data-testid=key-button]');
      await page.waitForSelector('[data-testid=sing-it-in]');
      let s = await song();
      assert.equal(s.back, true, '"Back to D" is disabled at the saved +12');
      await page.click('[data-testid=sing-grid] [data-pc="7"]'); // G
      await page.waitForFunction(() => window.__rig.store.currentSong().hearIn === 7);
      s = await song();
      assert.deepEqual([s.hearIn, s.playIn, s.oct], [7, 2, 1], 'D → G keeps the octave (+17)');
      assert.equal((await page.textContent('[data-testid=transpose-val]')).trim(), '+17');
      await page.click('[data-testid=sing-back]');
      await page.waitForFunction(() => window.__rig.store.currentSong().hearIn === 2);
      s = await song();
      assert.deepEqual([s.hearIn, s.oct, s.revert, s.back], [2, 1, true, true], 'Back returns to the saved +12: nothing to revert');
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-testid=sing-it-in]', { state: 'detached' });
      // the ordinary path with no saved octave: +7 flips transposeOctave to 1; Back still goes to 0
      await set(2, 2, 0);
      await rebaseline();
      await page.evaluate(() => window.__rig.controller.transposeBy(7));
      await page.waitForFunction(() => window.__rig.store.currentSong().transposeOctave === 1);
      await page.click('[data-testid=key-button]');
      await page.waitForSelector('[data-testid=sing-it-in]');
      await page.click('[data-testid=sing-back]');
      await page.waitForFunction(() => window.__rig.engine.transpose === 0);
      s = await song();
      assert.deepEqual([s.hearIn, s.oct, s.revert], [2, 0, true]);
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-testid=sing-it-in]', { state: 'detached' });
    } finally {
      await set(...orig);
      await rebaseline();
    }
  });

test('round4-perform P11 / P12 / P13: Quick sheet clears the strips below 900 px; "Space level" on the wheel; no re-fit per write',
  async () => {
    await selectIndex(0);
    try {
      for (const [w, hgt] of [[1280, 800], [1366, 768], [1366, 700], [1440, 900], [1024, 700]]) {
        await page.setViewportSize({ width: w, height: hgt });
        await page.waitForTimeout(200);
        await page.click('#btn-quick');
        await page.waitForSelector('[data-testid=quick-sheet]', { state: 'visible' });
        const m = await page.evaluate(() => ({
          qs: document.querySelector('[data-testid=quick-sheet]').getBoundingClientRect().bottom,
          strips: Math.min(...[...document.querySelectorAll('.slot, .p-drone, .p-wheel')].map((e) => e.getBoundingClientRect().top)),
        }));
        assert.ok(m.qs <= m.strips + 0.5, `${w}×${hgt}: Quick ends at ${m.qs}, the strips start at ${m.strips}`);
        await page.keyboard.press('Escape');
        await page.waitForSelector('[data-testid=quick-sheet]', { state: 'hidden' });
      }
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(150);
    }
    assert.equal(await page.evaluate(async () => (await import('/js/views/perform.js')).wheelTargetLabel('fx.reverb.returnGain')), 'Space level');
    // P13: fader writes don't re-run the name fit (it reads the name's computed style and forces a layout)
    const calls = await page.evaluate(async () => {
      const { store } = window.__rig;
      const n = document.querySelector('.song-name');
      const s = store.currentSong();
      const i = s.patch.slots.findIndex(Boolean);
      const g0 = s.patch.slots[i].gain;
      let c = 0;
      const orig = window.getComputedStyle;
      window.getComputedStyle = function (el, ...a) {
        if (el === n) c += 1;
        return orig.call(this, el, ...a);
      };
      try {
        for (let k = 0; k < 20; k++) {
          store.set(`songs.${s.id}.patch.slots.${i}.gain`, g0 * (k % 2 ? 0.9 : 1));
          await new Promise((r) => requestAnimationFrame(r));
        }
      } finally {
        window.getComputedStyle = orig;
        store.set(`songs.${s.id}.patch.slots.${i}.gain`, g0);
      }
      return c;
    });
    assert.equal(calls, 0, `the song name was re-fitted ${calls}× during 20 fader writes`);
  });

// ---------------------------------------------------------------------------------------------- critics-fix (C6)
// reviews/onboarding.md O1–O3, O11, O13, O14, "first 60 seconds"; reviews/performance.md #2, #3; idle-cpu R1, R4

test('critics-fix O1: holding Lock 1.3 s or 2 s unlocks and stays unlocked; the next plain click still locks', async () => {
  await selectIndex(0);
  const isLocked = () => page.evaluate(() => window.__rig.store.get().settings.performLock);
  const lb = await page.locator('[data-testid=perform-lock]').boundingBox();
  const holdFor = async (ms) => {
    await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(ms);
    await page.mouse.up();
  };
  try {
    for (const ms of [2000, 1300]) {
      await page.click('[data-testid=perform-lock]');
      await page.waitForFunction(() => window.__rig.store.get().settings.performLock === true);
      await page.waitForTimeout(700);
      await holdFor(ms);
      await page.waitForTimeout(900); // the old 600 ms window has long passed
      assert.equal(await isLocked(), false, `a ${ms} ms hold leaves the view unlocked (was re-locked by the release click)`);
    }
    // the swallowed click is only the one that ended the hold: the next tap locks again at once
    await page.click('[data-testid=perform-lock]');
    await page.waitForFunction(() => window.__rig.store.get().settings.performLock === true, null, { timeout: 2000 });
    // keyboard: a 2 s Enter hold still unlocks (round2-ui #5), and nothing is left swallowed for the next Enter
    await page.focus('[data-testid=perform-lock]');
    await page.keyboard.down('Enter');
    await page.waitForTimeout(2000);
    await page.keyboard.up('Enter');
    await page.waitForTimeout(200);
    assert.equal(await isLocked(), false, 'a 2 s Enter hold unlocks and stays unlocked');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__rig.store.get().settings.performLock === true, null, { timeout: 2000 });
  } finally {
    await page.evaluate(() => {
      window.__rig.store.set('settings.performLock', false);
      document.activeElement?.blur?.();
    });
  }
});

test('critics-fix O2: "Loading…" sits in the KEY row and never over the song title (1440 / 1280 / 1024)', async () => {
  await selectIndex(0);
  try {
    for (const [w, hgt] of [[1440, 900], [1280, 800], [1024, 700]]) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.waitForTimeout(200);
      const g = await page.evaluate(() => {
        const block = document.querySelector('.song-block');
        block.classList.add('loading');
        const r = (el) => el.getBoundingClientRect();
        const chip = document.querySelector('.song-loading');
        const name = document.querySelector('.song-name');
        const sub = document.querySelector('.song-sub');
        const notes = document.querySelector('.song-sub .notes-btn');
        const c = r(chip);
        const n = r(name);
        const out = {
          shown: getComputedStyle(chip).display !== 'none' && c.width > 10,
          overlapName: !(c.bottom <= n.top || c.top >= n.bottom || c.right <= n.left || c.left >= n.right),
          inSub: chip.parentElement === sub && c.top >= r(sub).top - 1 && c.bottom <= r(sub).bottom + 1,
          clearOfNotes: !notes || !notes.offsetParent || c.right <= r(notes).left + 0.5,
          inBlock: c.right <= r(block).right,
          bpmHidden: getComputedStyle(document.querySelector('.song-bpm')).display === 'none',
        };
        block.classList.remove('loading');
        out.hiddenAfter = getComputedStyle(chip).display === 'none';
        return out;
      });
      assert.deepEqual(g, { shown: true, overlapName: false, inSub: true, clearOfNotes: true, inBlock: true, bpmHidden: true,
        hiddenAfter: true }, `${w}×${hgt}: ${JSON.stringify(g)}`);
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(150);
  }
});

test('critics-fix O3 / O14 / O11 / O13: loading tooltip says "play now"; a suspended context never shows "Sound OK"; '
  + 'REC says Saving…; a tap on locked Edit / ⚙ says why', async () => {
  await selectIndex(0);
  const r = await page.evaluate(async () => {
    const { controller: c, engine: e, recorder } = window.__rig;
    const real = { ...c.status };
    const out = {};
    c.dispatchEvent(new CustomEvent('status', { detail: { ...real, ready: false } }));
    out.loadingTitle = document.getElementById('ready-status').title;
    // O14: the controller says running, the context is still gesture-blocked
    Object.defineProperty(e.ctx, 'state', { get: () => 'suspended', configurable: true });
    c.dispatchEvent(new CustomEvent('status', { detail: { ...real, audio: 'running' } }));
    out.blocked = document.getElementById('audio-text').textContent;
    delete e.ctx.state;
    c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status, ready: true } }));
    out.readyTitle = document.getElementById('ready-status').title;
    out.ok = document.getElementById('audio-text').textContent;
    c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status } }));
    // O11
    recorder.dispatchEvent(new CustomEvent('state', { detail: { state: 'stopping' } }));
    const t = document.getElementById('rec-time');
    out.saving = { text: t.textContent, cls: t.className, w: t.getBoundingClientRect().width };
    recorder.dispatchEvent(new CustomEvent('state', { detail: { state: 'idle' } }));
    out.after = t.className;
    return out;
  });
  assert.match(r.loadingTitle, /You can play now/);
  assert.equal(r.blocked, 'Paused', 'a gesture-blocked context reads Paused, not Sound OK');
  assert.equal(r.ok, 'Sound OK');
  assert.match(r.readyTitle, /loaded and switches instantly/);
  assert.equal(r.saving.text, 'Saving…');
  assert.match(r.saving.cls, /\bon\b/);
  assert.match(r.saving.cls, /\bsaving\b/);
  assert.doesNotMatch(r.after, /\bsaving\b/);
  // O13
  await clearToasts();
  await page.click('[data-testid=perform-lock]');
  await page.waitForFunction(() => window.__rig.store.get().settings.performLock === true);
  try {
    // (identical toasts merge: the second tap shows as ×2 on the first one)
    for (const [k, sel] of ['[data-testid=view-switch] [data-value="edit"]', '#btn-settings'].entries()) {
      assert.equal(await page.isDisabled(sel), true, `${sel} disabled under lock`);
      const b = await page.locator(sel).boundingBox();
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      await page.waitForFunction((n) => [...document.querySelectorAll('#toasts .toast')].some((x) => /hold Lock to unlock/.test(x.textContent)
        && (n === 0 || /×2/.test(x.textContent))), k, { timeout: 3000 });
    }
    assert.equal(await page.evaluate(() => window.__rig.store.get().settings.view), 'perform');
  } finally {
    await page.evaluate(() => window.__rig.store.set('settings.performLock', false));
    await clearToasts();
  }
  // a tap on them unlocked shows nothing of the kind
  await page.mouse.move(5, 895);
  await page.mouse.down();
  await page.mouse.up();
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].some((x) => /hold Lock/.test(x.textContent))), false);
});

test('critics-fix "first 60 seconds": Start here card (once, closes on × or the next song) and key letters on the piano',
  async () => {
    const card = '[data-testid=start-card]';
    await selectIndex(1);
    await selectIndex(0);
    // a song change (here, or earlier in the suite) closed the card for good, and localStorage says so
    assert.equal(await page.evaluate(() => localStorage.getItem('worship-rig.start-card')), 'done');
    assert.equal(await page.isVisible(card), false);
    await page.evaluate(() => window.__rig.views.perform.startCard.reset());
    await page.waitForSelector(card, { state: 'visible' });
    const g = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const n = document.querySelector('.p-notes').getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { text: el.textContent, inNotes: el.parentElement.classList.contains('p-notes'), fits: r.left >= n.left && r.right <= n.right + 0.5,
        overflowX: el.scrollWidth > el.clientWidth + 1 };
    }, card);
    assert.ok(g.inNotes && g.fits && !g.overflowX, JSON.stringify(g));
    assert.match(g.text, /No keyboard yet\? Play A S D F G H J K/);
    assert.match(g.text, /next song/);
    assert.match(g.text, /tap Lock\. To unlock, hold it/);
    await clearToasts();
    await page.screenshot({ path: path.join(shots, 'critics-start-card.png') });
    // a connected keyboard changes the first line
    const connected = await page.evaluate((sel) => {
      const c = window.__rig.controller;
      const real = { ...c.status };
      c.dispatchEvent(new CustomEvent('status', { detail: { ...real, midi: { ...real.midi, connected: true, available: true, name: 'Test Keys' } } }));
      const t = document.querySelector(sel).textContent;
      const letters = document.querySelectorAll('.piano .pkey-letter').length;
      c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status } }));
      return { t, letters };
    }, card);
    assert.match(connected.t, /Your keyboard is connected/);
    assert.equal(connected.letters, 0, 'no key letters while a MIDI keyboard is connected');
    // the next song closes it for good
    await selectIndex(1);
    assert.equal(await page.isVisible(card), false, 'closed by the first song change');
    assert.equal(await page.evaluate(() => localStorage.getItem('worship-rig.start-card')), 'done');
    await selectIndex(0);
    assert.equal(await page.isVisible(card), false, 'and it stays closed');
    // × closes it too
    await page.evaluate(() => window.__rig.views.perform.startCard.reset());
    await page.click(`${card} .sc-x`);
    assert.equal(await page.isVisible(card), false);
    assert.equal(await page.evaluate(() => localStorage.getItem('worship-rig.start-card')), 'done');
    // key letters: A…; over C4…E5 while no MIDI keyboard is connected; Z/X move them an octave
    const letters = () => page.evaluate(() => [...document.querySelectorAll('.piano .pkey-letter')]
      .map((s) => `${s.parentElement.dataset.note}:${s.textContent}`));
    const connectedNow = await page.evaluate(() => !!window.__rig.controller.status.midi?.connected);
    if (connectedNow) console.log('# a MIDI keyboard is connected here: key-letter checks skipped');
    else {
      let l = await letters();
      assert.equal(l.length, 17);
      assert.ok(l.includes('60:A') && l.includes('61:W') && l.includes('76:;'), l.join(' '));
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.keyboard.press('KeyX');
      await page.waitForFunction(() => !!document.querySelector('.piano .pkey[data-note="72"] .pkey-letter'));
      l = await letters();
      assert.ok(l.includes('72:A') && l.includes('88:;') && !l.includes('60:A'), l.join(' '));
      await page.keyboard.press('KeyZ');
      await page.waitForFunction(() => document.querySelector('.piano .pkey[data-note="60"] .pkey-letter')?.textContent === 'A');
      await page.evaluate(() => window.__rig.store.set('settings.computerKeyboard', false));
      assert.equal((await letters()).length, 0, 'none with the computer keyboard off');
      await page.evaluate(() => window.__rig.store.set('settings.computerKeyboard', true));
      assert.equal((await letters()).length, 17);
    }
  });

test('critics-fix performance #2 / idle-cpu R1, R4: meters update ≤ ~30×/s, stop their frame loops when silent, wake on a '
  + 'note, hide while the window is hidden', async () => {
  await selectIndex(4); // Grand Piano: no drone, so silence is reachable
  const r = await page.evaluate(async () => {
    const { controller: c } = window.__rig;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    // idle-cpu-ui: every meter runs on one shared rAF callback (meterClock 'meterFrame'); 'level' counts the strip
    // meters' reads (controller.slotLevel)
    const counts = { frame: 0, loop: 0 };
    const orig = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => {
      if (cb && cb.name === 'meterFrame') counts.frame += 1;
      return orig.call(window, cb);
    };
    const origLevel = c.slotLevel;
    c.slotLevel = (i) => {
      counts.loop += 1;
      return origLevel(i);
    };
    let fillWrites = 0;
    const mo = new MutationObserver((ms) => {
      for (const m of ms) if (m.target.classList.contains('meter-fill')) fillWrites += 1;
    });
    mo.observe(document.getElementById('meter-mount'), { attributes: true, subtree: true, attributeFilter: ['style'] });
    const window1 = async (ms) => {
      counts.frame = 0;
      counts.loop = 0;
      fillWrites = 0;
      await sleep(ms);
      return { frame: counts.frame, loop: counts.loop, fillWrites };
    };
    try {
      // quiet: wait for the tail to die and the meters to go to sleep
      const t0 = performance.now();
      while (performance.now() - t0 < 15000) {
        const w = await window1(500);
        if (w.frame === 0 && w.loop === 0) break;
      }
      const silent = await window1(1000);
      c.perform.noteOn(60, 110);
      c.perform.noteOn(64, 110);
      await sleep(150);
      const playing = await window1(1000);
      const bars = [...document.querySelectorAll('.p-slots .lvl-cover')].map((x) => x.style.transform);
      c.perform.noteOff(60);
      c.perform.noteOff(64);
      // R4: a hidden window hides the meters (their IntersectionObservers stop the loops)
      c.dispatchEvent(new CustomEvent('menu', { detail: { id: 'windowHidden' } }));
      await sleep(50);
      const hidden = { attr: document.documentElement.hasAttribute('data-window-hidden'),
        meter: getComputedStyle(document.querySelector('#meter-mount .meter')).display };
      c.dispatchEvent(new CustomEvent('menu', { detail: { id: 'windowShown' } }));
      await sleep(50);
      hidden.after = document.documentElement.hasAttribute('data-window-hidden');
      // LOCAL's preload event (every mode): window 'rig:window-visible' {detail:{visible}}
      window.dispatchEvent(new CustomEvent('rig:window-visible', { detail: { visible: false } }));
      hidden.dom = document.documentElement.hasAttribute('data-window-hidden');
      window.dispatchEvent(new CustomEvent('rig:window-visible', { detail: { visible: true } }));
      hidden.domAfter = document.documentElement.hasAttribute('data-window-hidden');
      return { silent, playing, bars, hidden };
    } finally {
      mo.disconnect();
      window.requestAnimationFrame = orig;
      c.slotLevel = origLevel;
    }
  });
  assert.deepEqual(r.silent, { frame: 0, loop: 0, fillWrites: 0 }, `silent: no meter frames, no writes (${JSON.stringify(r.silent)})`);
  assert.ok(r.playing.frame > 10 && r.playing.frame <= 36, `a note wakes the shared meter loop (${r.playing.frame} frames/s)`);
  assert.ok(r.playing.loop > 10, `a note wakes the slot meters (${r.playing.loop} reads/s)`);
  // two bars (L, R) at ≤ ~30 updates a second each, plus scheduling slack
  assert.ok(r.playing.fillWrites > 5 && r.playing.fillWrites <= 2 * 36, `top-bar fill writes in 1 s: ${r.playing.fillWrites}`);
  assert.ok(r.bars.some((t) => Number(t.replace(/[^0-9.]/g, '') || 1) < 0.9), `a slot bar lifts (${r.bars.join(', ')})`);
  assert.deepEqual(r.hidden, { attr: true, meter: 'none', after: false, dom: true, domAfter: false });
});

test('critics-fix performance #3: a wheel held still writes nothing; a moving wheel touches only the indicator', async () => {
  await selectIndex(1); // Building Swell: the wheel drives a slot fader
  const r = await page.evaluate(async () => {
    const { controller: c } = window.__rig;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    c.perform.wheel(0.5);
    await sleep(200);
    const muts = [];
    const mo = new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.target.closest?.('.lvl-meter')) continue; // the slot level bars follow the sound, not the wheel
        muts.push(`${m.type}:${m.target.className || m.target.nodeName}:${m.attributeName || ''}`);
      }
    });
    const opts = { attributes: true, childList: true, characterData: true, subtree: true };
    mo.observe(document.querySelector('.p-wheel'), opts);
    mo.observe(document.querySelector('.p-slots'), opts);
    for (let i = 0; i < 20; i++) {
      c.perform.wheel(0.5);
      await new Promise((res) => requestAnimationFrame(res));
    }
    const still = muts.splice(0);
    for (let i = 0; i < 20; i++) {
      c.perform.wheel(0.5 + i / 50);
      await new Promise((res) => requestAnimationFrame(res));
    }
    await sleep(50);
    const moving = muts.splice(0);
    mo.disconnect();
    c.perform.wheel(1);
    const ind = document.querySelector('.p-slots .fader-indicator:not([hidden])');
    return { still, moving, indOnSelf: !!ind && ind.style.getPropertyValue('--ind') !== '',
      rootInd: [...document.querySelectorAll('.p-slots .fader')].some((f) => f.style.getPropertyValue('--ind') !== '') };
  });
  assert.deepEqual(r.still, [], `a still wheel: no DOM writes (${r.still.slice(0, 6).join(' ')})`);
  assert.ok(r.moving.length > 0, 'a moving wheel is drawn');
  assert.ok(r.moving.every((m) => !/childList/.test(m)), `text changes in place, no node swaps (${r.moving.filter((m) => /childList/.test(m)).slice(0, 4)})`);
  assert.ok(r.indOnSelf && !r.rootInd, '--ind lives on the indicator, not the fader root');
});

// ------------------------------------------------------------------------------------------ idle-cpu-ui
/** Select a song by name (ids are generated) and wait for it; the drone mode is forced when given. */
async function selectByName(name, droneMode) {
  const idx = await page.evaluate(([n, dm]) => {
    const { store } = window.__rig;
    const ids = store.navIds();
    const i = ids.findIndex((id) => store.getSong(id).name === n);
    if (i >= 0 && dm) store.set(`songs.${ids[i]}.drone.mode`, dm);
    return i;
  }, [name, droneMode || null]);
  assert.ok(idx >= 0, `song ${name} in the setlist`);
  await selectIndex(idx);
}
/** In-page: counts every rAF callback, master-analyser read and slotLevel read from now on (idempotent). */
const UI_COUNTERS = () => {
  if (window.__uic) return;
  const C = (window.__uic = { raf: 0, an: 0, slot: 0 });
  const oRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) {
    return oRaf.call(window, (t) => {
      C.raf += 1;
      return cb(t);
    });
  };
  // the stereo meters read engine.analyserL/R (the engine's own fx idle / freeze taps are other AnalyserNodes)
  const e = window.__rig.engine;
  for (const an of [e.analyserL, e.analyserR]) {
    const proto = Object.getPrototypeOf(an);
    for (const m of ['getFloatTimeDomainData', 'getByteTimeDomainData', 'getFloatFrequencyData', 'getByteFrequencyData']) {
      an[m] = function (...x) {
        C.an += 1;
        return proto[m].apply(this, x);
      };
    }
  }
  const c = window.__rig.controller;
  const o = c.slotLevel;
  c.slotLevel = (i) => {
    C.slot += 1;
    return o(i);
  };
};
/** Rates per second over `ms` (rAF callbacks, analyser reads, slotLevel reads, meter-clock frames). */
const uiRates = (ms) => page.evaluate(async (w) => {
  const C = window.__uic;
  const m = window.__rig.meters;
  const a = { ...C, frames: m.stats().frames };
  const t0 = performance.now();
  await new Promise((res) => setTimeout(res, w));
  const sec = (performance.now() - t0) / 1000;
  const r = (k) => Math.round(((k === 'frames' ? m.stats().frames : C[k]) - a[k]) / sec * 10) / 10;
  return { raf: r('raf'), an: r('an'), slot: r('slot'), frames: r('frames'), stats: m.stats() };
}, ms);
/** Wait until the meter clock has run `n` more frames (a resumed loop; generous bound for a loaded box). */
const metersRun = async (n = 5, timeout = 5000) => {
  const f0 = await page.evaluate(() => window.__rig.meters.stats().frames);
  await page.waitForFunction(([a, k]) => window.__rig.meters.stats().frames >= a + k, [f0, n], { timeout, polling: 50 });
};
/** Wait until every meter sleeps (the shared loop stopped): silence below −90 dBFS for 500 ms. */
const metersAsleep = (timeout = 20000) => page.waitForFunction(() => {
  const s = window.__rig.meters.stats();
  return s.awake === 0 && !s.scheduled;
}, null, { timeout, polling: 100 });

test('idle-cpu-ui: silent → the meter loop stops (rAF ≤ 1/s, ≤ 5 style recalcs in 3 s); a note restarts it within '
  + '100 ms; drone on → ≤ 35 rAF/s; low-resource → 0 rAF, 0 analyser reads, lamps at 1 Hz; no reload', async () => {
  await page.waitForFunction(() => window.__rig.controller.status.ready === true, null, { timeout: 600000, polling: 500 });
  await page.evaluate(() => window.__rig.ctx.setView('perform'));
  await selectByName('Grand Piano'); // no drone: silence is reachable
  await page.evaluate(UI_COUNTERS);
  await page.mouse.move(2, 890); // park the pointer on nothing hoverable
  await metersAsleep();
  await page.waitForTimeout(2000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metric = async (n) => (await cdp.send('Performance.getMetrics')).metrics.find((x) => x.name === n)?.value ?? 0;
  const rc0 = await metric('RecalcStyleCount');
  const lay0 = await metric('LayoutCount');
  const silent = await uiRates(3000);
  const recalcs = (await metric('RecalcStyleCount')) - rc0;
  const layouts = (await metric('LayoutCount')) - lay0;
  await cdp.detach().catch(() => {});
  console.log(`# silent: ${JSON.stringify(silent)} recalcs ${recalcs} layouts ${layouts} in 3 s`);
  assert.ok(silent.raf <= 1, `silent: rAF callbacks/s ${silent.raf} ≤ 1`);
  assert.equal(silent.frames, 0, 'silent: no meter frames');
  assert.equal(silent.slot, 0, 'silent: strip meters are not read');
  assert.ok(silent.an <= 2.5, `silent: only the 1 Hz safety probe reads the master analysers (${silent.an}/s)`);
  assert.ok(recalcs <= 5, `silent: ${recalcs} style recalcs in 3 s (≤ 5)`);

  // a note-on restarts the loop within 100 ms (the controller's activity signal, not a poll)
  const wake = await page.evaluate(async () => {
    const m = window.__rig.meters;
    const f0 = m.stats().frames;
    const t0 = performance.now();
    window.__rig.controller.perform.noteOn(64, 110);
    while (m.stats().frames === f0 && performance.now() - t0 < 1000) await new Promise((res) => setTimeout(res, 2));
    const ms = performance.now() - t0;
    const lift = () => Number((document.querySelector('#meter-mount .meter-fill')?.style.transform || '')
      .replace(/[^0-9.]/g, '') || 0);
    while (lift() <= 0.1 && performance.now() - t0 < 2000) await new Promise((res) => setTimeout(res, 20));
    const fill = document.querySelector('#meter-mount .meter-fill')?.style.transform || '';
    window.__rig.controller.perform.noteOff(64);
    return { ms, fill };
  });
  console.log(`# note-on → first meter frame ${wake.ms.toFixed(1)} ms; fill ${wake.fill}`);
  assert.ok(wake.ms < 100, `a note restarts the meters within 100 ms (${wake.ms.toFixed(1)} ms)`);
  assert.ok(Number(wake.fill.replace(/[^0-9.]/g, '') || 0) > 0.1, `the top-bar bar lifts (${wake.fill})`);

  // drone on: the loop runs, capped at ~30 frames/s whatever the refresh rate; the hold moves without layout
  await selectByName('Sunday Pad + Piano', 'synth');
  await metersRun(10, 10000);
  const droneOn = await uiRates(2000);
  const holdStyles = await page.evaluate(() => [...document.querySelectorAll('#meter-mount .meter-hold')]
    .map((x) => x.getAttribute('style') || ''));
  console.log(`# drone on: ${JSON.stringify(droneOn)}`);
  assert.ok(droneOn.frames > 10, `drone on: the meters run (${droneOn.frames} frames/s)`);
  assert.ok(droneOn.raf <= 35, `drone on: rAF callbacks/s ${droneOn.raf} ≤ 35`);
  assert.ok(droneOn.an <= 2 * 35, `drone on: analyser reads/s ${droneOn.an} ≤ 70 (L + R per frame)`);
  assert.deepEqual(holdStyles, ['', ''], 'the peak hold is moved by its track transform, never by left/bottom');
  // the moved track never makes the bar overflow (polish-2A clip check), and the hold sits at the peak: its right edge
  // at the track's translate (a vertical meter too: its bottom edge at the peak)
  const holdGeo = await page.evaluate(async () => {
    const C = await import('/js/views/components/index.js');
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:10px;top:10px;width:200px;height:120px;display:flex;gap:20px;z-index:9';
    document.body.append(host);
    const h = C.meter({ engine: window.__rig.engine });
    const v = C.meter({ engine: window.__rig.engine, vertical: true });
    host.append(h.el, v.el);
    const out = [];
    for (let k = 0; k < 40 && out.length < 1; k++) {
      await new Promise((res) => setTimeout(res, 50));
      const hb = h.el.querySelector('.meter-bar');
      const tr = hb.querySelector('.meter-hold-track').style.transform;
      const p = Number(tr.replace(/[^0-9.]/g, '') || 0);
      if (p > 5) {
        const bar = hb.getBoundingClientRect();
        const hold = hb.querySelector('.meter-hold').getBoundingClientRect();
        const vb = v.el.querySelector('.meter-bar');
        const vbar = vb.getBoundingClientRect();
        const vhold = vb.querySelector('.meter-hold').getBoundingClientRect();
        const vp = 100 - Number(vb.querySelector('.meter-hold-track').style.transform.replace(/[^0-9.]/g, '') || 0);
        out.push({ p, holdRight: (hold.right - bar.left) / bar.width * 100, over: hb.scrollWidth - hb.clientWidth,
          vp, vHoldBottom: (vbar.bottom - vhold.bottom) / vbar.height * 100, vOver: vb.scrollHeight - vb.clientHeight });
      }
    }
    h.destroy();
    v.destroy();
    host.remove();
    return out[0] || null;
  });
  console.log(`# hold geometry: ${JSON.stringify(holdGeo)}`);
  assert.ok(holdGeo, 'the drone lifts the peak hold');
  assert.ok(Math.abs(holdGeo.holdRight - holdGeo.p) < 1.5, `horizontal hold ends at the peak (${JSON.stringify(holdGeo)})`);
  assert.ok(Math.abs(holdGeo.vHoldBottom - holdGeo.vp) < 2.5, `vertical hold sits at the peak (${JSON.stringify(holdGeo)})`);
  assert.equal(holdGeo.over, 0, 'no horizontal overflow from the moved hold');
  assert.equal(holdGeo.vOver, 0, 'no vertical overflow from the moved hold');

  // low-resource (controller → <html data-low-resource>, main.js): no frames, no reads, runtime lamps at 1 Hz
  await page.evaluate(() => window.__rig.controller.setLowResource(true));
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-low-resource'));
  await page.waitForTimeout(300);
  const rt = await page.evaluate(() => {
    const e = window.__rig.engine;
    window.__rtCount = 0;
    const o = e.getRuntimeState;
    window.__rtRestore = () => (e.getRuntimeState = o);
    e.getRuntimeState = function (...a) {
      window.__rtCount += 1;
      return o.apply(this, a);
    };
  });
  void rt;
  const low = await uiRates(2500);
  const lowRt = await page.evaluate(() => {
    window.__rtRestore();
    return window.__rtCount;
  });
  console.log(`# low-resource, drone on: ${JSON.stringify(low)} runtime polls ${lowRt} in 2.5 s`);
  assert.equal(low.raf, 0, 'low-resource: 0 rAF callbacks/s');
  assert.equal(low.an, 0, 'low-resource: no analyser reads');
  assert.equal(low.slot, 0, 'low-resource: no slot level reads');
  assert.ok(lowRt <= 4, `low-resource: pedal / wheel lamps poll at 1 Hz (${lowRt} in 2.5 s)`);
  await page.evaluate(() => window.__rig.controller.setLowResource(false));
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-low-resource'));
  // the bare attribute (as the Mac test set it) works the same, and removing it resumes without a reload
  await page.evaluate(() => document.documentElement.setAttribute('data-low-resource', '1'));
  await page.waitForTimeout(300);
  const attr = await uiRates(1500);
  await page.evaluate(() => document.documentElement.removeAttribute('data-low-resource'));
  await metersRun(5);
  const back = await uiRates(1000);
  console.log(`# data-low-resource="1": ${JSON.stringify(attr)}; removed: ${JSON.stringify(back)}`);
  assert.deepEqual([attr.raf, attr.an, attr.slot], [0, 0, 0], 'data-low-resource="1": no rAF, no reads');
  assert.ok(back.frames > 5, `attribute removed: the meters resume (${back.frames} frames/s)`);
  await selectByName('Grand Piano');
});

test('idle-cpu-ui critic: a meter back from low-resource shows the current level at once (no stale bar)', async () => {
  await page.waitForFunction(() => window.__rig.controller.status.ready === true, null, { timeout: 600000, polling: 500 });
  // the level fell to silence while the clock was blocked: the first frame after the restart must release to it (dt =
  // this meter's own gap), not replay the old bar from where it stopped at 20 dB/s (dt = one clock frame)
  const r = await page.evaluate(async () => {
    const C = await import('/js/views/components/index.js');
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    let amp = 0.5; // −6 dBFS → bar at 0.9
    const an = { fftSize: 256, getFloatTimeDomainData: (b) => b.fill(amp) };
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:10px;top:10px;width:200px;height:40px;z-index:9';
    document.body.append(host);
    const m = C.meter({ analysers: () => [an, an] });
    host.append(m.el);
    const fill = () => Number(m.el.querySelector('.meter-fill').style.transform.replace(/[^0-9.]/g, '') || 0);
    const until = async (ok, t = 5000) => {
      const t0 = performance.now();
      while (!ok() && performance.now() - t0 < t) await sleep(10);
    };
    await until(() => fill() > 0.85);
    const loud = fill();
    const de = document.documentElement;
    de.setAttribute('data-low-resource', '1');
    await sleep(200);
    const held = fill();
    amp = 0;
    await sleep(1500);
    de.removeAttribute('data-low-resource');
    await until(() => fill() < held - 0.001);
    const back = fill();
    m.destroy();
    host.remove();
    return { loud, held, back };
  });
  console.log(`# stale-bar check: ${JSON.stringify(r)}`);
  assert.ok(r.loud > 0.85, `the test meter lifts (${r.loud})`);
  assert.ok(r.back < 0.05, `first frame after low-resource: the bar is at the current (silent) level, not ${r.back}`);
});

test('idle-cpu-ui R4: a hidden window stops the meters from rig:window-visible / visibilitychange in every mode', async () => {
  await page.waitForFunction(() => window.__rig.controller.status.ready === true, null, { timeout: 600000, polling: 500 });
  await selectByName('Sunday Pad + Piano', 'synth');
  await page.evaluate(UI_COUNTERS);
  await page.evaluate(() => window.__rig.store.set('settings.menuBarMode', false));
  await metersRun(5, 10000);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rig:window-visible', { detail: { visible: false } })));
  await page.waitForTimeout(300);
  const hidden = await uiRates(1500);
  const st = await page.evaluate(() => ({ attr: document.documentElement.hasAttribute('data-window-hidden'),
    vis: window.__rig.controller.status.windowVisible }));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rig:window-visible', { detail: { visible: true } })));
  await metersRun(3);
  const shown = await uiRates(1000);
  // visibilitychange (a hidden document) does the same
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(300);
  const docHidden = await uiRates(1000);
  const st2 = await page.evaluate(() => {
    const r = { attr: document.documentElement.hasAttribute('data-window-hidden'), vis: window.__rig.controller.status.windowVisible };
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
    return r;
  });
  await metersRun(3);
  const after = await uiRates(1000);
  console.log(`# hidden ${JSON.stringify(hidden)} shown ${JSON.stringify(shown)} doc-hidden ${JSON.stringify(docHidden)}`);
  assert.deepEqual(st, { attr: true, vis: false }, 'rig:window-visible false → data-window-hidden + setWindowVisible(false)');
  assert.deepEqual([hidden.raf, hidden.an, hidden.slot], [0, 0, 0], 'hidden: no rAF, no reads (menu-bar mode off)');
  assert.ok(shown.frames > 5, `shown again: the meters resume (${shown.frames}/s)`);
  assert.deepEqual(st2, { attr: true, vis: false }, 'visibilitychange hidden → the same');
  assert.deepEqual([docHidden.raf, docHidden.an], [0, 0], 'hidden document: no rAF, no reads');
  assert.ok(after.frames > 5, `visible again: the meters resume (${after.frames}/s)`);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-window-hidden')), false);
  await selectByName('Grand Piano');
});

test('L-24: a focus loss never toggles the focused drone tile or commits a hold (blur, Space/Enter held across it)',
  async () => {
  await page.waitForFunction(() => window.__rig.controller.status.ready === true, null, { timeout: 600000, polling: 500 });
  await page.evaluate(() => window.__rig.ctx.setView('perform'));
  await selectByName('Sunday Pad + Piano', 'synth');
  const mode = () => page.evaluate(() => ({ store: window.__rig.store.currentSong().drone.mode,
    engine: window.__rig.engine.drone.getState().mode }));
  const setOn = () => page.evaluate(() => window.__rig.store.set(`songs.${window.__rig.store.currentSong().id}.drone.mode`,
    'synth'));
  const focusTile = async () => {
    await page.evaluate(() => document.activeElement?.blur?.());
    // Tab from the element just before the tile, as a keyboard user gets there
    await page.evaluate(() => {
      const t = document.querySelector('[data-testid=drone-on]');
      const all = [...document.querySelectorAll('button, input, select, textarea, [tabindex]')].filter((x) =>
        x.tabIndex >= 0 && !x.disabled && x.getClientRects().length);
      all[all.indexOf(t) - 1].focus();
    });
    await page.keyboard.press('Tab');
    return page.evaluate(() => document.activeElement?.dataset?.testid);
  };
  const winBlurFocus = () => page.evaluate(async () => {
    const t = document.activeElement;
    window.dispatchEvent(new Event('blur'));
    t?.dispatchEvent(new FocusEvent('blur'));
    t?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await new Promise((res) => setTimeout(res, 120));
    window.dispatchEvent(new Event('focus'));
    t?.dispatchEvent(new FocusEvent('focus'));
  });
  // another page comes to the front, then this one again (a real focus loss on a desktop; headless emulates focus)
  const realBlurFocus = async () => {
    const p2 = await context.newPage();
    await p2.bringToFront();
    await page.waitForTimeout(150);
    await page.bringToFront();
    await p2.close();
  };
  const results = {};
  const run = async (label, fn) => {
    await setOn();
    await page.waitForTimeout(150);
    const focused = await focusTile();
    assert.equal(focused, 'drone-on', `${label}: the tile has focus`);
    await fn();
    await page.waitForTimeout(250);
    results[label] = await mode();
  };
  await run('window blur/focus', winBlurFocus);
  await run('real focus loss', realBlurFocus);
  await run('Space down → blur → focus → Space up', async () => {
    await page.keyboard.down('Space');
    await winBlurFocus();
    await page.keyboard.up('Space');
  });
  // (headless Chromium emulates focus per page, so "another page in front" delivers no blur: a Space held across it is
  // an ordinary press there, which the "a real press still works" check below covers)
  await run('Space down → element blur → refocus → Space up', async () => {
    await page.keyboard.down('Space');
    await page.evaluate(() => document.activeElement.blur());
    await page.evaluate(() => document.querySelector('[data-testid=drone-on]').focus());
    await page.keyboard.up('Space');
  });
  for (const [k, v] of Object.entries(results)) assert.deepEqual(v, { store: 'synth', engine: 'synth' }, `${k}: drone unchanged`);
  // a real press still works: Space down/up on the focused tile toggles once; Enter held with auto-repeat toggles once
  await setOn();
  await focusTile();
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  assert.equal((await mode()).store, 'off', 'Space press on the focused tile turns the drone off');
  await setOn();
  await focusTile();
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter'); // auto-repeat
  await page.keyboard.down('Enter');
  await realBlurFocus();
  await page.keyboard.up('Enter');
  await page.waitForTimeout(200);
  assert.equal((await mode()).store, 'off', 'Enter held: one toggle, its auto-repeats never toggle back');
  await setOn();
  await page.evaluate(() => document.activeElement?.blur?.());

  // holds: a pointer hold keeps focus off the button, so only the window blur can cancel it
  const holds = await page.evaluate(async () => {
    const { store } = window.__rig;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const o = { bubbles: true, pointerId: 9, button: 0, pointerType: 'mouse', isPrimary: true };
    store.set('settings.performLock', true);
    await sleep(100);
    const lock = document.querySelector('[data-testid=perform-lock]');
    lock.dispatchEvent(new PointerEvent('pointerdown', o));
    await sleep(250);
    window.dispatchEvent(new Event('blur'));
    await sleep(700);
    lock.dispatchEvent(new PointerEvent('pointerup', o));
    lock.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await sleep(100);
    const stillLocked = store.get().settings.performLock;
    // the key grid under lock (perform.js holdGate)
    const hear0 = store.currentSong().hearIn;
    const key = [...document.querySelectorAll('[data-testid=key-grid] .key-btn')].find((b) => Number(b.dataset.pc) !== hear0);
    key.dispatchEvent(new PointerEvent('pointerdown', o));
    await sleep(250);
    window.dispatchEvent(new Event('blur'));
    await sleep(700);
    key.dispatchEvent(new PointerEvent('pointerup', o));
    await sleep(100);
    const hear1 = store.currentSong().hearIn;
    // transpose under lock (holdButton requireHold)
    const tr0 = store.currentSong().playIn;
    const up = document.querySelector('[data-testid=transpose-up]');
    up.dispatchEvent(new PointerEvent('pointerdown', o));
    await sleep(250);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await sleep(700);
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
    up.dispatchEvent(new PointerEvent('pointerup', o));
    await sleep(100);
    const tr1 = store.currentSong().playIn;
    // a completed hold still works (unlock)
    await window.__holdEl(lock, 750);
    await sleep(100);
    return { stillLocked, hearSame: hear1 === hear0, transposeSame: tr1 === tr0, unlocked: !store.get().settings.performLock };
  });
  await page.evaluate(() => window.__rig.store.set('settings.performLock', false));
  assert.deepEqual(holds, { stillLocked: true, hearSame: true, transposeSame: true, unlocked: true },
    'a window blur / hidden document abandons a pointer hold (unlock, key grid, transpose); a full hold still works');
  const diag = await page.evaluate(() => window.__rig.diag.drone.slice(-1)[0]);
  assert.ok(diag && diag.to && Array.isArray(diag.setBy), `drone.mode changes are logged with their call site (${JSON.stringify(diag)?.slice(0, 200)})`);
  await selectByName('Grand Piano');
});

test('lowres2 requests: audio asleep → top bar "Asleep" with an ok LED; Quick › This Mac says how to wake it', async () => {
  await page.waitForFunction(() => window.__rig.controller.status.ready === true, null, { timeout: 600000, polling: 500 });
  await page.evaluate(() => window.__rig.ctx.setView('perform'));
  await page.click('#btn-quick');
  await page.waitForSelector('[data-testid=quick-sheet]', { state: 'visible' });
  try {
    const r = await page.evaluate(() => {
      const c = window.__rig.controller;
      const real = { ...c.status };
      const read = () => ({
        top: document.getElementById('audio-text').textContent,
        led: document.getElementById('audio-led').className,
        mac: document.querySelector('[data-testid=quick-sheet] section[aria-label="This Mac"] .qs-scope').textContent,
        qsLed: document.querySelector('[data-testid=quick-sheet] .qs-ok .led').className,
      });
      // the controller's 1 s tick re-emits the real status; each read happens in the same task as its dispatch
      c.dispatchEvent(new CustomEvent('status', { detail: { ...real, audio: 'asleep', latencyMs: 12, instance: 'primary' } }));
      const asleep = read();
      c.dispatchEvent(new CustomEvent('status', { detail: { ...real, audio: 'running', latencyMs: 12, instance: 'primary' } }));
      const awake = read();
      c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status } }));
      return { asleep, awake };
    });
    console.log(`# asleep ${JSON.stringify(r.asleep)}`);
    assert.equal(r.asleep.top, 'Asleep');
    assert.equal(r.asleep.led, 'led ok', 'asleep is a normal state, not a warning');
    assert.equal(r.asleep.mac, 'Audio asleep — play a note or press a key to wake');
    assert.equal(r.asleep.qsLed, 'led ok');
    assert.equal(r.awake.top, 'Sound OK');
    assert.equal(r.awake.mac, 'every song · soundcheck settings');
  } finally {
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid=quick-sheet]', { state: 'hidden' });
  }
});

test('L-30: rig menu ids trayHidden / trayShown → one info toast per session + the Settings › Menu bar note', async () => {
  const TEXT = 'The menu-bar icon is hidden — your Mac’s menu bar is full. Hide a few items in System Settings › '
    + 'Control Center, or use the Rig menu › Show Worship Rig.';
  await clearToasts();
  // the ids arrive exactly as Electron main sends them: preload rig.onMenu(cb) calls controller.onMenu(id)
  const fire = (id) => page.evaluate((i) => window.__rig.controller.onMenu(i), id);
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => ({
    text: t.querySelector('.toast-msg').textContent, kind: t.dataset.kind, action: t.querySelector('.toast-action')?.textContent })));
  const note = () => page.evaluate(() => {
    const n = document.querySelector('[data-testid=menubar-tray-hidden]');
    return { hidden: n.hidden, visible: n.offsetParent !== null, text: n.textContent,
      attr: document.documentElement.hasAttribute('data-tray-hidden') };
  });
  await page.click('#btn-settings');
  await page.waitForFunction(() => !document.getElementById('view-settings').hidden);
  assert.deepEqual((await note()).hidden, true, 'no note while the tray is visible');
  await fire('trayHidden');
  const t1 = await toasts();
  assert.deepEqual(t1, [{ text: TEXT, kind: 'info', action: 'Dismiss' }], 'one dismissible info toast with the exact words');
  const n1 = await note();
  assert.deepEqual([n1.hidden, n1.visible, n1.text, n1.attr], [false, true, TEXT, true], 'the Settings note shows, same words');
  // dismiss, then a repeat in the same session shows no second toast
  await page.click('#toasts .toast-action');
  await page.waitForFunction(() => document.querySelectorAll('#toasts .toast').length === 0);
  await fire('trayHidden');
  assert.deepEqual(await toasts(), [], 'not repeated in the same session');
  assert.equal((await note()).hidden, false, 'the note stays while hidden');
  await fire('trayShown');
  const n2 = await note();
  assert.deepEqual([n2.hidden, n2.attr], [true, false], 'trayShown clears the note and the state');
  assert.deepEqual(await toasts(), [], 'trayShown shows no toast');
  // the note follows the state when Settings is reopened
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('view-settings').hidden);
  await fire('trayHidden');
  await page.click('#btn-settings');
  await page.waitForFunction(() => !document.getElementById('view-settings').hidden);
  assert.equal((await note()).visible, true, 'reopened Settings shows the note while hidden');
  await fire('trayShown');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('view-settings').hidden);
  await clearToasts();
});

test('no console errors on the main page', () => {
  assert.deepEqual(consoleErrors, [], consoleErrors.join('\n'));
});

test('first run without autoplay permission: "Click anywhere to start audio" overlay → audio runs', async () => {
  const b2 = await chromium.launch({ channel: 'chromium', headless: true });
  const errs = [];
  try {
    const ctx2 = await b2.newContext({ viewport: { width: 1440, height: 900 } });
    const p2 = await ctx2.newPage();
    watchConsole(p2, errs);
    await p2.goto(base);
    await p2.waitForFunction(() => !!window.__rig);
    await p2.waitForTimeout(900);
    const state = await p2.evaluate(() => window.__rig.engine.ctx?.state);
    const overlay = await p2.isVisible('#overlay-start');
    if (state === 'running') {
      assert.equal(overlay, false, 'no overlay when audio already runs');
      console.log('# this headless build allows autoplay without a gesture; overlay correctly stayed hidden');
    } else {
      assert.equal(overlay, true, `overlay shown while the context is ${state}`);
      // critics-fix O14: the top bar agrees with the overlay (it said "Sound OK" under "Click anywhere to start audio")
      assert.notEqual((await p2.textContent('#audio-text')).trim(), 'Sound OK', 'no "Sound OK" while audio waits for a click');
      await p2.screenshot({ path: path.join(shots, 'start-overlay.png') });
      await p2.mouse.click(700, 450);
      await p2.waitForFunction(() => window.__rig.engine.ctx.state === 'running', null, { timeout: 10000 });
      await p2.waitForFunction(() => document.getElementById('overlay-start').hidden, null, { timeout: 5000 });
    }
    await p2.waitForFunction(() => window.__rig.controller.status.songId !== null, null, { timeout: 30000 });
  } finally {
    await b2.close();
  }
  assert.deepEqual(errs, [], errs.join('\n'));
});
