#!/usr/bin/env node
// Menu-bar popover suite (app/mini.html + views/mini.js; docs/menubar-mode.md; C7 menubar-B).
//   node test/phase2/mini/run.mjs
// Two pages in ONE browser context (same origin → one BroadcastChannel 'rig-bus', the browser transport of
// shared/bus.js): page A = the real app (app/index.html: controller + engine publish `state`, run `command`s),
// page B = app/mini.html in a 320×440 viewport. Page B opens first, so the "waiting" state is real.
// Screenshots → test/phase2/mini/screenshots/{mini-waiting,mini,mini-6-modes,mini-drone-keys}.png.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { MIDI_PERMISSIONS, waitRigReady } from '../../integration/lib.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const APP = path.join(ROOT, 'app');
const SHOTS = path.join(HERE, 'screenshots');
const { createServer } = require(path.join(ROOT, 'server.js'));
const VERBOSE = !!process.env.VERBOSE;
const MINI_W = 320;
const MINI_H = 440;

fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const T = async (name, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n      ')}`);
  }
};

const server = createServer({ appDir: APP, port: 0 });
const info = await server.listen();
const origin = `http://127.0.0.1:${info.port}`;
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.grantPermissions([...MIDI_PERMISSIONS], { origin });
const errors = [];
const watch = (page, tag) => {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${tag}] ${m.text()} @ ${m.location()?.url || '?'}`);
    else if (VERBOSE) console.log(`   [${tag} ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
};
const mini = await context.newPage();
watch(mini, 'mini');
await mini.setViewportSize({ width: MINI_W, height: MINI_H });
const app = await context.newPage();
watch(app, 'app');

const evA = (fn, arg) => app.evaluate(fn, arg);
const evB = (fn, arg) => mini.evaluate(fn, arg);
const untilA = (fn, arg, timeout = 15000) => app.waitForFunction(fn, arg, { timeout, polling: 50 });
const untilB = (fn, arg, timeout = 15000) => mini.waitForFunction(fn, arg, { timeout, polling: 50 });
const curId = () => evA(() => window.__rig.store.get().settings.currentSongId);
const modesA = () => evA(() => window.__rig.controller.modes.list());
const masterA = () => evA(() => window.__rig.store.currentSong().patch.fx.master.volume);
/** Every visible element of the popover inside the 320×440 viewport; buttons ≥ 44 px (the sheet's Done: 36). */
const layoutProblems = () =>
  evB(({ W, H }) => {
    const out = [];
    const de = document.documentElement;
    if (de.scrollWidth > W || de.scrollHeight > H) out.push(`document scrolls ${de.scrollWidth}×${de.scrollHeight}`);
    const live = document.querySelector('.mini-live');
    if (live.scrollHeight > live.clientHeight + 1) out.push(`.mini-live overflows ${live.scrollHeight} > ${live.clientHeight}`);
    for (const e of document.querySelectorAll('.mini-live *')) {
      if (!e.getClientRects().length || e.closest('[hidden]')) continue;
      const r = e.getBoundingClientRect();
      if (r.left < -0.5 || r.top < -0.5 || r.right > W + 0.5 || r.bottom > H + 0.5) {
        out.push(`${e.className || e.tagName} outside (${r.left},${r.top},${r.right},${r.bottom})`);
      }
    }
    for (const b of document.querySelectorAll('.mini-live button, .mini-live [role="slider"]')) {
      if (!b.getClientRects().length || b.closest('[hidden]') || b.classList.contains('sheet-done')) continue;
      const r = b.getBoundingClientRect();
      if (r.height < 43.5 || r.width < 43.5) out.push(`target ${b.dataset.testid || b.className} ${r.width}×${r.height}`);
    }
    for (const n of document.querySelectorAll('.m-name, .cur-name')) {
      if (n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).textOverflow !== 'ellipsis' && !n.classList.contains('cur-name')) {
        out.push(`${n.textContent} clipped without ellipsis`);
      }
    }
    return out;
  }, { W: MINI_W, H: MINI_H });

console.log(`\n[mini] ${origin}`);
try {
  // ------------------------------------------------------------------------------------------ waiting
  await T('waiting: "Waiting for Worship Rig…" until a state arrives; hello now and every 2 s', async () => {
    await mini.goto(`${origin}/mini.html`);
    await untilB(() => !!window.__mini);
    assert.equal(await evB(() => document.getElementById('mini').dataset.state), 'waiting');
    assert.ok(await mini.isVisible('[data-testid="mini-waiting"]'));
    assert.match(await mini.textContent('.wait-title'), /Waiting for Worship Rig…/);
    await sleep(2300);
    const hellos = await evB(() => window.__mini.sent.filter((c) => c.type === 'hello').length);
    assert.ok(hellos >= 2, `hello resent while waiting (${hellos})`);
    assert.equal(await evB(() => window.__mini.bus.transport.command), 'broadcast');
    await mini.screenshot({ path: path.join(SHOTS, 'mini-waiting.png') });
  });

  // ------------------------------------------------------------------------------------------ boot the app
  await T('app boots (page A) and answers: mini goes live with the modes', async () => {
    await app.goto(`${origin}/`);
    await waitRigReady(app, { timeout: 90000, what: '[mini] app window.__rig.ready' });
    const overlay = await app.$('#overlay-start:not([hidden])');
    if (overlay) await overlay.click();
    await untilA(() => window.__rig.engine.ctx && window.__rig.engine.ctx.state === 'running', null, 20000);
    await untilA(() => window.__rig.controller.status.songId === window.__rig.store.get().settings.currentSongId
      && !window.__rig.controller.status.loading, null, 30000);
    await untilB(() => document.getElementById('mini').dataset.state === 'live', null, 5000);
    const modes = await modesA();
    assert.ok(modes.length >= 2, `≥ 2 modes (${modes.length})`);
    await untilB((n) => document.querySelectorAll('[data-testid^="mini-mode-"]').length === n, Math.min(6, modes.length));
    const names = await evB(() => [...document.querySelectorAll('.mode .m-name')].map((e) => e.textContent));
    assert.deepEqual(names, modes.slice(0, 6).map((m) => m.name));
    const hellosAfter = await evB(() => window.__mini.sent.filter((c) => c.type === 'hello').length);
    await sleep(2200);
    assert.equal(await evB(() => window.__mini.sent.filter((c) => c.type === 'hello').length), hellosAfter,
      'no more hellos once live');
  });

  // ------------------------------------------------------------------------------------------ modes
  await T('modes: clicking mode 2 switches the app\'s song; the mini highlights it; big name + key', async () => {
    const modes = await modesA();
    await mini.click('[data-testid="mini-mode-1"]');
    await untilA((id) => window.__rig.store.get().settings.currentSongId === id, modes[1].id);
    await untilB((id) => {
      const b = document.querySelector('[data-testid="mini-mode-1"]');
      return b.classList.contains('current') && b.getAttribute('aria-pressed') === 'true' && b.dataset.id === id
        && document.querySelectorAll('.mode.current').length === 1;
    }, modes[1].id);
    assert.equal(await mini.textContent('[data-testid="mini-current"]'), modes[1].name);
    if (modes[1].key) assert.equal(await mini.textContent('[data-testid="mini-key"]'), `Key ${modes[1].key}`);
  });

  await T('keyboard: 1–3 select modes', async () => {
    const modes = await modesA();
    await mini.locator('body').click({ position: { x: 160, y: 434 } }); // the status line: focus the page, no button
    for (const i of [0, Math.min(2, modes.length - 1), 1]) {
      await mini.keyboard.press(String(i + 1));
      await untilA((id) => window.__rig.store.get().settings.currentSongId === id, modes[i].id);
      await untilB((i) => document.querySelector(`[data-testid="mini-mode-${i}"]`).classList.contains('current'), i);
    }
  });

  await T('prev / next step through the modes (wrapping)', async () => {
    const modes = await modesA();
    const idx = async () => {
      const id = await curId();
      return modes.findIndex((m) => m.id === id);
    };
    const start = await idx();
    await mini.click('[data-testid="mini-next"]');
    await untilA((id) => window.__rig.store.get().settings.currentSongId === id, modes[(start + 1) % modes.length].id);
    await mini.click('[data-testid="mini-prev"]');
    await untilA((id) => window.__rig.store.get().settings.currentSongId === id, modes[start].id);
  });

  // ------------------------------------------------------------------------------------------ master
  await T('master: relative drag changes master.volume in the app; a tap does not jump; dB label', async () => {
    await untilA(() => !window.__rig.controller.status.loading);
    const before = await masterA();
    const box = await mini.locator('[data-testid="mini-master"]').boundingBox();
    // a tap far right of the thumb: relative drag never jumps
    await mini.mouse.click(box.x + box.width - 16, box.y + box.height / 2);
    // mac-findings L-28: a trackpad tap-to-click that wobbles 2 px between down and up is still a tap
    const y = box.y + box.height / 2;
    await mini.mouse.move(box.x + 60, y);
    await mini.mouse.down();
    await mini.mouse.move(box.x + 62, y);
    await mini.mouse.up();
    await sleep(400);
    assert.ok(Math.abs((await masterA()) - before) < 1e-9, 'tap does not change the master');
    assert.equal(await evB(() => window.__mini.sent.filter((c) => c.type === 'master').length), 0, 'a tap sends nothing');
    // drag right by 50 px
    await mini.mouse.move(box.x + 40, y);
    await mini.mouse.down();
    for (let dx = 5; dx <= 50; dx += 5) await mini.mouse.move(box.x + 40 + dx, y);
    await mini.mouse.up();
    // L-28 (Mac only, recurring): at 120 Hz the moves come faster than the 50 ms send throttle, so the values reach the
    // app in batches and "> before + 0.05" could be met by an intermediate one. Wait for the value the mini sent LAST.
    const sentLast = await evB(() => window.__mini.sent.filter((c) => c.type === 'master').at(-1)?.value);
    assert.ok(Number.isFinite(sentLast), 'the drag sent the master');
    await untilA((v) => Math.abs(window.__rig.store.currentSong().patch.fx.master.volume - v) < 1e-6, sentLast);
    const after = await masterA();
    assert.ok(after > before + 0.05, `the drag raised the master (${before} → ${after})`);
    const expectPos = Math.cbrt(before / 2) + 50 / (box.width - 24);
    assert.ok(Math.abs(after - 2 * expectPos ** 3) < 0.02, `taper mapping (${after} vs ${2 * expectPos ** 3})`);
    await untilA((v) => Math.abs(window.__rig.engine.getParam('master.volume') - v) < 1e-6, after);
    const db = await mini.textContent('[data-testid="mini-master-db"]');
    const want = 20 * Math.log10(after);
    assert.match(db, /^[+−]?\d+\.\d dB$/);
    assert.ok(Math.abs(Number(db.replace('−', '-').replace(' dB', '')) - want) < 0.11, `${db} vs ${want.toFixed(2)}`);
    // the app is the source of truth: a change there comes back to the mini. L-28: this reset reaches the mini within
    // 400 ms of its last send (at once here; on the Mac it always did), which the old time-based echo guard dropped
    // for good: the app publishes only on change. Two quick changes in a row must both show.
    const miniIs = (v) => untilB((x) => Math.abs(Number(document.querySelector('[data-testid="mini-master"]')
      .getAttribute('aria-valuenow')) - x) < 1e-3, v, 3000);
    await evA((v) => window.__rig.store.set('master.volume', v), 0.7);
    await miniIs(0.7);
    await evA((v) => window.__rig.store.set('master.volume', v), before);
    await miniIs(before);
    // keyboard: → nudges up
    await mini.focus('[data-testid="mini-master"]');
    await mini.keyboard.press('ArrowRight');
    await untilA((b) => window.__rig.store.currentSong().patch.fx.master.volume > b, before);
    await evA((v) => window.__rig.store.set('master.volume', v), before);
  });

  // ------------------------------------------------------------------------------------------ panic
  await T('panic: a short press does nothing; a 600 ms hold panics (held notes released)', async () => {
    await evA(() => {
      const c = window.__rig.controller;
      window.__panics = 0;
      c.addEventListener('bus-command', (e) => {
        if (e.detail?.type === 'panic') window.__panics += 1;
      });
      c.perform.noteOn(62, 100);
    });
    await untilA(() => window.__rig.controller._debug().held.some(([n]) => n === 62));
    const box = await mini.locator('[data-testid="mini-panic"]').boundingBox();
    await mini.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await mini.mouse.down();
    await sleep(200);
    await mini.mouse.up();
    await sleep(700);
    assert.equal(await evA(() => window.__panics), 0, 'short press = no panic');
    assert.match(await mini.textContent('.panic-sub'), /keep holding/);
    assert.ok(await evA(() => window.__rig.controller._debug().held.some(([n]) => n === 62)), 'note still held');
    await mini.mouse.down();
    await sleep(750);
    await mini.mouse.up();
    await untilA(() => window.__panics === 1);
    await untilA(() => !window.__rig.controller._debug().held.some(([n]) => n === 62));
    await sleep(300);
    assert.equal(await evA(() => window.__panics), 1, 'exactly one panic');
  });

  // ------------------------------------------------------------------------------------------ drone
  await T('drone: key sheet click sets the drone key; the pill toggles the drone', async () => {
    await mini.click('[data-testid="mini-drone-keys"]');
    await untilB(() => !document.querySelector('[data-testid="mini-drone-sheet"]').hidden);
    assert.equal(await mini.getAttribute('[data-testid="mini-drone-keys"]', 'aria-expanded'), 'true');
    assert.deepEqual(await layoutProblems(), []);
    const pc = await evA(() => (window.__rig.store.currentSong().hearIn + 5) % 12);
    await mini.click(`[data-testid="mini-dk-${pc}"]`);
    await untilA((pc) => window.__rig.store.currentSong().hearIn === pc, pc);
    await untilB((pc) => document.querySelector(`[data-testid="mini-dk-${pc}"]`).classList.contains('on')
      && document.querySelectorAll('.dk.on').length === 1, pc);
    await mini.screenshot({ path: path.join(SHOTS, 'mini-drone-keys.png') });
    await mini.keyboard.press('Escape');
    await untilB(() => document.querySelector('[data-testid="mini-drone-sheet"]').hidden);
    const wasOn = await evA(() => window.__rig.store.currentSong().drone.mode !== 'off');
    await mini.click('[data-testid="mini-drone"]');
    await untilA((w) => (window.__rig.store.currentSong().drone.mode !== 'off') === !w, wasOn);
    await untilB((w) => document.querySelector('[data-testid="mini-drone"]').getAttribute('aria-pressed') === String(!w), wasOn);
    await mini.click('[data-testid="mini-drone"]');
    await untilA((w) => (window.__rig.store.currentSong().drone.mode !== 'off') === w, wasOn);
  });

  // ------------------------------------------------------------------------------------------ low-resource
  await T('low-resource: Eco → app status + engine stats + <html data-low-resource>, meters stop; and back', async () => {
    // meter work per animation frame (as ui-core "round2-ui #10"): analyser reads (top-bar / Edit meters) and
    // controller.slotLevel reads (Perform's strip meters), counted against our own rAF tick
    const meterReads = () =>
      evA(async () => {
        const { engine, controller } = window.__rig;
        const an = engine.analyserL;
        const proto = Object.getPrototypeOf(an);
        const names = ['getFloatTimeDomainData', 'getByteTimeDomainData', 'getFloatFrequencyData', 'getByteFrequencyData'];
        let reads = 0;
        for (const n of names) an[n] = function (...a) {
          reads += 1;
          return proto[n].apply(this, a);
        };
        // idle-cpu-ui: the meters sleep at silence and run ≤ 30×/s (meterClock); a held note keeps them awake
        controller.perform.noteOn(60, 100);
        window.__rig.meters?.wake?.();
        const origSl = controller.slotLevel;
        let sl = 0;
        controller.slotLevel = function (...a) {
          sl += 1;
          return origSl.apply(this, a);
        };
        let frames = 0;
        let run = true;
        const tick = () => {
          frames += 1;
          if (run) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        // ≥ 1 s and ≥ 20 display frames (idle-cpu-ui critic: at load ≈ 10 the page once got 3 frames in 1 s, so the
        // 30 fps meter clock ran 3 times and "reads > 5" failed on the box, not on the app); 6 s cap
        const t0 = performance.now();
        while (performance.now() - t0 < 1000 || (frames < 20 && performance.now() - t0 < 6000)) {
          await new Promise((r) => setTimeout(r, 50));
        }
        run = false;
        for (const n of names) delete an[n];
        controller.slotLevel = origSl;
        controller.perform.noteOff(60);
        return { frames, reads, analyser: reads / Math.max(1, frames), slot: sl / Math.max(1, frames) };
      });
    await app.bringToFront(); // a background tab's rAF is throttled; measure the app as the front page
    const before = await meterReads();
    await mini.click('[data-testid="mini-lowres"]');
    await untilA(() => window.__rig.controller.status.lowResource === true && window.__rig.engine._debugStats().lowResource === true
      && window.__rig.store.get().settings.lowResource === true);
    await untilA(() => document.documentElement.hasAttribute('data-low-resource'));
    await untilB(() => document.querySelector('[data-testid="mini-lowres"]').getAttribute('aria-checked') === 'true');
    await untilA(() => window.__rig.engine._debugStats().slotLevelTaps === 0, null, 5000);
    await sleep(300); // IntersectionObserver callbacks
    const during = await meterReads();
    const fmt = (m) => `analyser ${m.analyser.toFixed(2)}/frame, slotLevel ${m.slot.toFixed(2)}/frame (${m.frames} frames)`;
    console.log(`      meters: normal ${fmt(before)} → low-resource ${fmt(during)}`);
    // ≈ 30 reads/s whatever the display rate (idle-cpu-ui: per display frame this is 0.25 at 120 Hz)
    assert.ok(before.reads > 5, `meters run normally (${fmt(before)})`);
    assert.ok(during.frames > 5, `frames still run (${during.frames})`);
    assert.equal(during.analyser + during.slot, 0, `no meter reads in low-resource (${fmt(during)})`);
    assert.equal(await evA(() => getComputedStyle(document.querySelector('#meter-mount .meter')).display), 'none');
    await mini.click('[data-testid="mini-lowres"]');
    await untilA(() => window.__rig.controller.status.lowResource === false && window.__rig.engine._debugStats().lowResource === false);
    await untilA(() => !document.documentElement.hasAttribute('data-low-resource'));
    await untilB(() => document.querySelector('[data-testid="mini-lowres"]').getAttribute('aria-checked') === 'false');
    await mini.bringToFront();
  });

  // ------------------------------------------------------------------------------------------ status + layout
  await T('status line: audio · latency · MIDI', async () => {
    const t = await mini.textContent('[data-testid="mini-status"]');
    assert.match(t, /^Sound (OK|paused|stopped|…) · (\d+|—) ms · .+$/);
    assert.match(await evB(() => document.querySelector('.mini-status .led').className), /led (ok|warn|bad)/);
     // lowres2: the app's audio sleep shows as "Audio asleep" with an ok LED (a second popover on a fake bus)
    const asleep = await evB(async () => {
      const m = await import('/js/views/mini.js');
      const host = document.createElement('div');
      document.body.append(host);
      const base = window.__mini.state || {};
      const v = m.mountMini(host, { bus: { send() {}, onState(cb) {
        cb({ ...base, audio: 'asleep', latencyMs: 12, midi: { connected: false } });
        return () => {};
      } } });
      const out = { pure: m.statusLine({ audio: 'asleep', latencyMs: 12, midi: { connected: false } }),
        text: host.querySelector('[data-testid="mini-status"]').textContent,
        led: host.querySelector('.mini-status .led').className };
      v.destroy?.();
      host.remove();
      return out;
    });
    assert.deepEqual(asleep.pure, { text: 'Audio asleep · 12 ms · No MIDI keyboard', led: 'ok' });
    assert.match(asleep.text, /^Audio asleep · 12 ms · /);
    assert.equal(asleep.led, 'led ok');
  });

  await T('layout: 320×440, no overflow, ≥ 44 px targets; screenshot', async () => {
    await evB(() => document.activeElement?.blur?.());
    assert.deepEqual(await layoutProblems(), []);
    await mini.screenshot({ path: path.join(SHOTS, 'mini.png') });
  });

  await T('6 modes: menu-bar setlist → 2 columns, still no overflow; screenshot', async () => {
    const ids = await evA(() => {
      const s = window.__rig.store;
      const ids = s.get().songOrder.slice(0, 6);
      const id = s.addSetlist('Menu bar test', ids);
      s.set('settings.menuBarSetlistId', id);
      return ids;
    });
    assert.equal(ids.length, 6, 'the factory library has ≥ 6 songs');
    await untilB(() => document.querySelectorAll('.mode').length === 6 && document.querySelector('.modes').classList.contains('two-col'));
    assert.deepEqual(await layoutProblems(), []);
    await mini.click('[data-testid="mini-mode-4"]');
    await untilA((id) => window.__rig.store.get().settings.currentSongId === id, ids[4]);
    await untilA(() => !window.__rig.controller.status.loading, null, 30000);
    await untilB(() => document.querySelector('[data-testid="mini-mode-4"]').classList.contains('current'));
    await mini.keyboard.press('6');
    await untilA((id) => window.__rig.store.get().settings.currentSongId === id, ids[5]);
    await untilA(() => !window.__rig.controller.status.loading, null, 30000);
    await untilB(() => document.querySelector('[data-testid="mini-mode-5"]').classList.contains('current'));
    await evB(() => document.activeElement?.blur?.());
    await sleep(150);
    await mini.screenshot({ path: path.join(SHOTS, 'mini-6-modes.png') });
  });

  await T('fade out → controller fadeOutAll (bus-command)', async () => {
    await evA(() => {
      window.__fades = 0;
      window.__rig.controller.addEventListener('bus-command', (e) => {
        if (e.detail?.type === 'fadeOutAll') window.__fades += 1;
      });
    });
    await mini.click('[data-testid="mini-fade"]');
    await untilA(() => window.__fades === 1);
  });

  await T('zero console.error (both pages)', async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  await context.close();
  await browser.close();
  await server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nmini: ${results.length - failed.length}/${results.length} passed`);
// mini-theme suite (test/phase2/mini/theme.mjs) in its own process, serially after this one (its `live` test boots
// its own app page but waits only for the store, not audio). `--only base` skips it.
let themeFailed = false;
if (!process.argv.includes('--only') || process.argv[process.argv.indexOf('--only') + 1] !== 'base') {
  const r = spawnSync(process.execPath, [path.join(HERE, 'theme.mjs'), '--only', 'bus,classic,light,live,bus-theme,themes'],
    { stdio: 'inherit', timeout: 480000 });
  themeFailed = r.status !== 0;
}
process.exit(failed.length || themeFailed ? 1 : 0);
