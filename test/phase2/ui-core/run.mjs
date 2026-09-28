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

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const appDir = path.join(repo, 'app');
const shots = path.join(here, 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const require = createRequire(import.meta.url);
const { createServer } = require('../../../server.js');

// ui-edit owns these; while they are absent the page's own 404 for them is expected, nothing else is.
const SIBLING_FILES = ['styles-edit.css', 'js/views/edit.js', 'js/views/settings.js'];
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
  const measure = (view) =>
    page.evaluate(async (v) => {
      const { engine, ctx } = window.__rig;
      ctx.setView(v);
      await new Promise((res) => setTimeout(res, 200));
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
      let frames = 0;
      let run = true;
      const tick = () => {
        frames += 1;
        if (run) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await new Promise((res) => setTimeout(res, 800));
      run = false;
      for (const [n] of saved) delete an[n];
      engine.getRuntimeState = origRt;
      return { perFrame: reads / Math.max(1, frames), frames, rt };
    }, view);
  const perf = await measure('perform');
  const edit = await measure('edit');
  await page.evaluate(() => window.__rig.ctx.setView('perform'));
  await page.waitForFunction(() => !document.getElementById('view-perform').hidden);
  console.log(`# analyserL reads/frame: perform ${perf.perFrame.toFixed(2)} (${perf.frames} frames), edit ${edit.perFrame.toFixed(2)}; runtime polls: perform ${perf.rt}, edit ${edit.rt}`);
  assert.ok(perf.perFrame > 0.5 && perf.perFrame < 1.5, `Perform: only the top-bar meter reads (${perf.perFrame.toFixed(2)}/frame)`);
  assert.ok(edit.perFrame > 1.5, `Edit: top-bar + Edit meter (${edit.perFrame.toFixed(2)}/frame)`);
  assert.ok(perf.rt >= 3, `Perform polls the runtime lamps (${perf.rt})`);
  assert.equal(edit.rt, 0, 'no runtime polling while Perform is hidden');
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
  assert.ok(Math.abs(t1 - 120) <= 12, `4 taps 500 ms apart ≈ 120 BPM (got ${t1}, was ${t0})`);
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
