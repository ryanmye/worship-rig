#!/usr/bin/env node
// UI v6 suite (D22; native/docs/lanes/UI6-build-plan.md U1; app/js/views/v6/). The real app (app/index.html) in
// Chromium:
//   flag off → today's Perform, nothing of v6 fetched or drawn; flag-off purity against the base build (the app before
//   U1: requests, window / document listeners, intervals, store listeners, DOM, stylesheets; the chart-view review's
//   probe, native/docs/reviews/chart-view.md); flag on (?ui6=1 / __rig.setUiV6) → the v6 Perform: strip controls write
//   the right store paths, ⋯ menu, Add instrument, > 5 instruments scroll with name pills, snapshots (save, edited,
//   Update, fold remembered), song bar (transpose, Sing it in, Space, Setlist cue + GO), Lock / PANIC / Revert holds,
//   on / off cycles leave nothing behind; zero console.error and no HTTP ≥ 400.
//   U2 (views/v6/keyboard.js): range bars at the keys' real positions, drag snaps (black keys too) and writes one end
//   on release, clamp, open ends past the edge, clipped ranges kept, ←/→ / Shift on a focused handle, changed dot +
//   Revert, Lock; the 'range' size in keyboard-harness.html (served at /u2-keyboard-harness.html by a route); a coarse
//   (hasTouch / isMobile) context for the iPad pick-then-drag mode with CDP touch drags.
//   node test/phase2/ui-v6/run.mjs   (screenshots: 1280×800 Sanctuary, 2 / 5 / 7 instruments, U2 drag / iPad pick /
//   Edit range, U3 sidebar open / collapsed / wide / iPad portrait → ./screenshots, or UI6_SHOTS=<dir>).
//   U3 (views/v6/sidebar/, sidebar.tests.mjs): tabs, rail, resize + fold, customize, per-device persistence, the Drone
//   / Setlist / Notes modules (same writes as today's Perform), Lock, iPad portrait.
//   U4 (views/v6/left.js, left.tests.mjs): the left panel's Quick (one sheet, two openers, Esc, TAP and the rest) and
//   wheel column (simulated CC1 / CC11 / CC64 / bend, Swell, relative drag, Lock), 1024×700 fit, iPad portrait with no
//   sideways page scroll; screenshots u4-*.png.
//   U-MOVE + D24 tweaks (move.tests.mjs): Duplicate next to the original, Earlier / Later, the strip drag (mouse, touch,
//   auto-scroll), Lock and the other ways a drag ends, protections keyed on the order (incl. Edit's tab + Undo), PANIC
//   / Lock taps, live range writes (timed) and their restores, pick-first on a mouse, drone %, the 1024×700 fit.
//   U7c (dialogs.tests.mjs): MIDI Learn on Perform (knob first or tap first, outlines / badges, Esc, Lock, song
//   switch, flag off), Arrange (strip handles + the sidebar's list), Save snapshot (names, Update / Save as new) and the
//   song menu; screenshots u7c-*.png (U7C_SHOTS=<dir>).
//   The purity comparison needs git: base = UI6_PURITY_BASE or `git merge-base HEAD v2-native`; it is skipped
//   (with a note) when app/ does not differ from the base.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { MIDI_PERMISSIONS, waitRigReady, pinTheme } from '../../integration/lib.mjs';
import { sidebarTests } from './sidebar.tests.mjs';
import { leftTests } from './left.tests.mjs';
import { moveTests } from './move.tests.mjs';
import { dialogTests } from './dialogs.tests.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const APP = path.join(ROOT, 'app');
const SHOTS = process.env.UI6_SHOTS ? path.resolve(process.env.UI6_SHOTS) : path.join(HERE, 'screenshots');
const { createServer } = require(path.join(ROOT, 'server.js'));
const VERBOSE = !!process.env.VERBOSE;
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
// UI6_ONLY=<regex>: run only the matching tests (plus the boot and the console check), for iterating on one part
const ONLY = process.env.UI6_ONLY ? new RegExp(process.env.UI6_ONLY) : null;
const T = async (name, fn) => {
  if (ONLY && !ONLY.test(name) && !/^flag off: today|^\?ui6=1 mounts|^zero console/.test(name)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    const stack = String(err && err.stack ? err.stack : err).split('\n').slice(0, 8);
    console.log(`  ✗ ${name}\n      ${stack.join('\n      ')}`);
  }
};

// ---- probes shared by the purity boots and the main page: listener / interval counts, store listeners
const PROBE = () => {
  const p = { ael: {}, intervals: 0 };
  window.__probe = p;
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, ...a) {
    const who = this === window ? 'w' : this === document ? 'd' : null;
    if (who) p.ael[`${who}:${type}`] = (p.ael[`${who}:${type}`] || 0) + 1;
    return add.call(this, type, ...a);
  };
  const si = window.setInterval;
  window.setInterval = function (...a) {
    p.intervals += 1;
    return si.apply(this, a);
  };
};
/** store.js with its listener Set exposed (as the chart-view review's routed store.js). */
async function exposeStoreListeners(target) {
  await target.route('**/js/store.js', async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace('const listeners = new Set();',
      'const listeners = new Set(); globalThis.__storeListeners = listeners;');
    await route.fulfill({ response: res, body });
  });
}
const isSample = (u) => /\/samples\/|\.(mp3|wav|ogg|m4a|flac)(\?|$)/i.test(u);

const server = createServer({ appDir: APP, port: 0 });
const info = await server.listen();
const origin = `http://127.0.0.1:${info.port}`;
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });

/** Boot a page on `base` (an origin) with the probes; returns what the purity check compares. */
async function purityBoot(base) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await pinTheme(context, 'sanctuary');
  await context.grantPermissions([...MIDI_PERMISSIONS], { origin: base });
  await context.addInitScript(PROBE);
  await exposeStoreListeners(context);
  const page = await context.newPage();
  const reqs = new Set();
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!isSample(u.pathname)) reqs.add(u.pathname);
  });
  try {
    await page.goto(`${base}/`);
    await waitRigReady(page, { timeout: 40000 });
    await page.waitForFunction(() => !!window.__rig.views.settings && !!window.__rig.views.edit, null,
      { timeout: 30000, polling: 100 });
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => {
      const shape = (el) => {
        const tid = el.getAttribute('data-testid');
        // generated ids (nextId 'fader-12', settings' random 'st-title-0jbc68') are normalised
        const id = el.id.replace(/-[a-z0-9]{6}$/, '-*').replace(/\d+/g, '#');
        return `${el.tagName.toLowerCase()}${id ? `#${id}` : ''}${tid ? `[${tid}]` : ''}`;
      };
      return {
        ael: window.__probe.ael,
        intervals: window.__probe.intervals,
        store: window.__storeListeners ? window.__storeListeners.size : null,
        // toasts come and go on their own clock (MIDI / wake-lock notes), so they are left out. The two Settings rows
        // added on purpose after U3 (lane-small: "Esc always panics" D24.7, the v6 preview switch U1 O3) are left out
        // too: they are the only intended flag-off DOM change (a base that has them has them on both sides).
        dom: [...document.body.querySelectorAll('*')].filter((e) => !e.closest('#toasts > *')
          && !e.closest('[data-testid="setting-row-esc-panics"], [data-testid="setting-row-ui-v6"]'))
          .map(shape).join('\n'),
        css: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href')),
        rig: Object.keys(window.__rig).sort(),
      };
    });
    return { ...r, reqs: [...reqs].sort() };
  } finally {
    await context.close();
  }
}

const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await pinTheme(context, 'sanctuary');
await context.grantPermissions([...MIDI_PERMISSIONS], { origin });
await exposeStoreListeners(context);
const page = await context.newPage();
const errors = [];
const v6Fetches = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url || '?'}`);
  else if (VERBOSE) console.log(`   [${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('request', (r) => {
  if (/\/js\/views\/v6\/|styles-v6\.css/.test(r.url())) v6Fetches.push(r.url());
});
page.on('response', (r) => {
  if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
});
const ev = (fn, arg) => page.evaluate(fn, arg);
const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
const tid = (id) => `[data-testid="${id}"]`;
const song = () => ev(() => JSON.parse(JSON.stringify(window.__rig.store.currentSong())));
const settled = () => until(() => {
  const { controller, store } = window.__rig;
  return controller.status.songId === store.get().settings.currentSongId && !controller.status.loading;
}, null, 30000);
/** Press and hold a hold button (holdButton, 600 ms) with the mouse. */
async function hold(sel, ms = 850) {
  const b = await page.locator(sel).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}
/** Give the current song `n` slots, filled with real instruments in order (the screenshots' set). */
const INSTRUMENTS = [['sampler', 'salamander-piano'], ['synth', 'warm-pad'], ['synth', 'sub-bass'],
  ['synth', 'strings'], ['sampler', 'ep-rhodes'], ['synth', 'square-lead'], ['organ', 'church']];
const setSlots = (n) => ev(({ n, list }) => {
  const { store } = window.__rig;
  const id = store.currentSong().id;
  while (store.currentSong().patch.slots.length < n) store.addSlot(id);
  while (store.currentSong().patch.slots.length > n) store.removeSlot(id);
  list.slice(0, n).forEach(([type, iid], i) => {
    const ref = { type, id: iid };
    // an empty slot takes a whole slot (the store refuses a path inside a null slot)
    if (store.currentSong().patch.slots[i]) store.set(`songs.${id}.patch.slots.${i}.instrument`, ref);
    else store.set(`songs.${id}.patch.slots.${i}`, { instrument: ref });
  });
  return store.currentSong().patch.slots.length;
}, { n, list: INSTRUMENTS });
const v6On = () => ev(() => !!window.__rig.views.v6);
/** Count the controller's panic actions from now on (one listener per page load; resets the count). */
const armPanics = () => ev(() => {
  window.__panics = 0;
  if (window.__panicHooked) return;
  window.__panicHooked = true;
  window.__rig.controller.addEventListener('action', (e) => {
    if (e.detail?.type === 'panic') window.__panics += 1;
  });
});

try {
  await T('flag off: today’s Perform; nothing of v6 fetched, drawn or linked', async () => {
    await page.goto(`${origin}/`);
    await waitRigReady(page, { timeout: 40000 });
    const overlay = await page.$('#overlay-start:not([hidden])');
    if (overlay) await overlay.click();
    await settled();
    await until(() => !!window.__rig.views.settings && !!window.__rig.views.edit, null, 20000);
    const r = await ev(() => ({
      flag: 'uiV6' in window.__rig.store.get().settings,
      v6: window.__rig.views.v6,
      today: !!document.querySelector('#view-perform > .perform'),
      dom: document.querySelectorAll('.v6, [data-testid^="v6-"]').length,
      css: !!document.querySelector('link[data-v6-css], link[href*="styles-v6"]'),
      perform: window.__rig.views.perform === window.__rig.views.perform && !!window.__rig.views.perform?.chartMounts,
    }));
    assert.deepEqual(r, { flag: false, v6: null, today: true, dom: 0, css: false, perform: true });
    assert.deepEqual(v6Fetches, []);
    // ?ui6=0 with the flag absent is a no-op: no store write
    assert.equal(await ev(() => window.__rig.store.set('settings.uiV6', null)), false);
  });

  await T('flag-off purity vs the base build: requests, listeners, intervals, store listeners, DOM, CSS', async () => {
    let base = process.env.UI6_PURITY_BASE || '';
    try {
      if (!base) base = execFileSync('git', ['merge-base', 'HEAD', 'v2-native'], { cwd: ROOT }).toString().trim();
      execFileSync('git', ['diff', '--quiet', base, '--', 'app'], { cwd: ROOT });
      console.log(`      (skipped: app/ is the same as ${base.slice(0, 8)}; set UI6_PURITY_BASE to compare)`);
      return;
    } catch (err) {
      if (!base) {
        console.log(`      (skipped: no git base: ${String(err.message).split('\n')[0]})`);
        return;
      }
      // git diff --quiet exits 1 when app/ differs: compare
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui6-base-'));
    try {
      const tar = path.join(tmp, 'app.tar');
      execFileSync('git', ['archive', '-o', tar, base, 'app', ':(exclude)app/samples'], { cwd: ROOT });
      execFileSync('tar', ['-xf', tar, '-C', tmp]);
      fs.symlinkSync(path.join(APP, 'samples'), path.join(tmp, 'app', 'samples'));
      const baseServer = createServer({ appDir: path.join(tmp, 'app'), port: 0 });
      const bi = await baseServer.listen();
      try {
        const a = await purityBoot(`http://127.0.0.1:${bi.port}`);
        const b = await purityBoot(origin);
        assert.deepEqual(b.reqs, a.reqs, 'non-sample requests');
        assert.deepEqual(b.ael, a.ael, 'window / document addEventListener calls by type');
        assert.equal(b.intervals, a.intervals, 'setInterval calls');
        assert.equal(b.store, a.store, 'store listeners');
        assert.ok(a.store > 0, 'the store probe works');
        assert.deepEqual(b.css, a.css, 'stylesheets');
        if (b.dom !== a.dom) {
          const al = a.dom.split('\n');
          const bl = b.dom.split('\n');
          const i = al.findIndex((l, k) => l !== bl[k]);
          const near = (l) => JSON.stringify(l.slice(Math.max(0, i - 3), i + 4));
          assert.fail(`DOM shape differs at element ${i} (${al.length} vs ${bl.length} elements): base ${near(al)} `
            + `branch ${near(bl)}`);
        }
        // the only intended difference: __rig.setUiV6 (and the views.v6 getter) when the base predates U1; none
        // against a base that already has U1 (skeptic UI6-U2 F1: after the rebase onto 2fff370 the merge-base holds
        // setUiV6, and the old `['setUiV6']` check failed although the flag-off app was identical)
        assert.deepEqual(a.rig.filter((k) => !b.rig.includes(k)), [], '__rig keys the branch lost');
        const extra = b.rig.filter((k) => !a.rig.includes(k));
        assert.ok(extra.every((k) => k === 'setUiV6'), `__rig keys only the branch has: ${extra}`);
        console.log(`      base ${base.slice(0, 8)}: ${a.reqs.length} requests, ${a.store} store listeners, `
          + `${a.intervals} intervals, ${a.dom.split('\n').length} elements — identical`);
      } finally {
        await baseServer.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  let baseListeners = 0;
  await T('?ui6=1 mounts the v6 Perform (CSS linked once); Edit and back keep it', async () => {
    baseListeners = await ev(() => window.__storeListeners.size);
    await page.goto(`${origin}/?ui6=1`);
    await waitRigReady(page, { timeout: 40000 });
    await until(() => !!window.__rig.views.v6, null, 20000);
    await settled();
    assert.equal(await ev(() => window.__rig.store.get().settings.uiV6), true);
    const r = await ev(() => ({
      v6: !!document.querySelector('#view-perform > .v6[data-testid="v6-perform"]'),
      old: !!document.querySelector('#view-perform .perform'),
      css: document.querySelectorAll('link[data-v6-css]').length,
      rows: ['v6-songbar', 'v6-snaps', 'v6-board', 'v6-bottom', 'v6-left', 'v6-right', 'v6-piano']
        .filter((t) => !document.querySelector(`[data-testid="${t}"]`)),
      strips: document.querySelectorAll('.v6-strip:not([hidden])').length,
      slots: window.__rig.store.currentSong().patch.slots.length,
      baseline: window.__rig.ctx.getBaseline()?.id === window.__rig.store.currentSong().id,
    }));
    assert.deepEqual({ ...r, strips: r.strips === r.slots }, {
      v6: true, old: false, css: 1, rows: [], strips: true, slots: r.slots, baseline: true,
    });
    assert.ok(v6Fetches.some((u) => u.endsWith('/styles-v6.css')));
    await page.click('#view-switch [data-value="edit"]');
    await until(() => document.body.dataset.view === 'edit');
    await page.click('#view-switch [data-value="perform"]');
    await until(() => document.body.dataset.view === 'perform' && !document.getElementById('view-perform').hidden);
    assert.equal(await v6On(), true);
    // strip names are the instruments' (D15: no Keys / Pad / Extra / Bass)
    const names = await ev(() => [...document.querySelectorAll('.v6-strip:not([hidden]) .v6-nm')]
      .map((x) => x.textContent));
    assert.ok(names.every((n) => !/^(Keys|Pad|Extra|Bass)$/i.test(n)), names.join());
  });

  await T('strip controls write the right store paths (fader, ON, Space, Echo, Octave, Sustain)', async () => {
    assert.equal(await setSlots(2), 2);
    await until(() => document.querySelectorAll('.v6-strip:not([hidden])').length === 2);
    const id = (await song()).id;
    // fader: an input event on the range → songs.<id>.patch.slots.0.gain
    const g0 = (await song()).patch.slots[0].gain;
    await ev(() => {
      const inp = document.querySelector('[data-testid="v6-fader-0"] input');
      inp.value = String(Math.max(0, Number(inp.value) - 150));
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until((g) => window.__rig.store.currentSong().patch.slots[0].gain < g - 0.01, g0);
    // ON tile = the mute
    await page.click(tid('v6-on-1'));
    await until(() => window.__rig.store.currentSong().patch.slots[1].muted === true);
    assert.equal(await page.getAttribute(tid('v6-on-1'), 'aria-pressed'), 'false');
    const muted = await ev(() => document.querySelector('[data-testid="v6-strip-1"]').classList.contains('muted'));
    assert.equal(muted, true);
    await page.click(tid('v6-on-1'));
    await until(() => !window.__rig.store.currentSong().patch.slots[1].muted);
    // Space: the step panel, a step → sends.reverb
    await page.click(tid('v6-space-0'));
    await until(() => !!document.querySelector('[data-testid="v6-strip-0"] .step-panel'));
    const steps = await ev(() => [...document.querySelectorAll('[data-testid="v6-strip-0"] .step-panel .sp-step')]
      .map((b) => b.textContent));
    await page.locator('[data-testid="v6-strip-0"] .step-panel .sp-step').first().click();
    await until(() => !document.querySelector('[data-testid="v6-strip-0"] .step-panel'));
    const s1 = await song();
    assert.ok(Number.isFinite(s1.patch.slots[0].sends.reverb), JSON.stringify(steps));
    // Echo
    await page.click(tid('v6-echo-1'));
    await page.locator('[data-testid="v6-strip-1"] .step-panel .sp-step').last().click();
    await until(() => !document.querySelector('[data-testid="v6-strip-1"] .step-panel'));
    const e1 = (await song()).patch.slots[1].sends.delay;
    // Octave: the top step (+2 or +1)
    await page.click(tid('v6-octave-0'));
    await page.locator('[data-testid="v6-strip-0"] .step-panel .sp-step').first().click();
    await until(() => (window.__rig.store.currentSong().patch.slots[0].octave || 0) !== 0);
    // Sustain cycles
    const sus0 = (await song()).patch.slots[1].sustain !== false;
    await page.click(tid('v6-sustain-1'));
    await until((was) => (window.__rig.store.currentSong().patch.slots[1].sustain !== false) !== was, sus0);
    assert.equal(typeof e1, 'number');
    assert.equal((await song()).id, id, 'still the same song');
    // the changed dots follow (white dot on the octave chip)
    assert.equal(await ev(() => !document.querySelector('[data-testid="v6-octave-0"] .cdi').hidden), true);
  });

  await T('Change opens Edit’s instrument picker on that slot; ⋯ Earlier off on the first, Later on', async () => {
    await page.click(tid('v6-change-1'));
    await until(() => document.body.dataset.view === 'edit');
    assert.equal(await ev(() => window.__rig.views.edit.editState.selected), 'slot:1');
    await ev(() => window.__rig.ctx.setView('perform'));
    await until(() => document.body.dataset.view === 'perform');
    await page.click(tid('v6-more-0'));
    await until(() => !!document.querySelector('[data-testid="v6-menu-0"]'));
    const r = await ev(() => ({
      earlier: document.querySelector('[data-testid="v6-earlier-0"]').disabled,
      later: document.querySelector('[data-testid="v6-later-0"]').disabled,
      title: document.querySelector('[data-testid="v6-later-0"]').title,
      role: document.querySelector('[data-testid="v6-menu-0"]').getAttribute('role'),
    }));
    assert.deepEqual({ ...r, title: /right/.test(r.title) },
      { earlier: true, later: false, title: true, role: 'dialog' });
    // Esc closes the menu without a panic
    await armPanics();
    await page.keyboard.press('Escape');
    await until(() => !document.querySelector('[data-testid="v6-menu-0"]'));
    assert.equal(await ev(() => window.__panics), 0);
  });

  await T('⋯ Duplicate puts a copy next to it; Remove needs a hold; Open in Edit; + Add instrument → Edit picker',
    async () => {
    const n0 = (await song()).patch.slots.length;
    await page.click(tid('v6-more-0'));
    await page.click(tid('v6-dup-0'));
    await until((n) => window.__rig.store.currentSong().patch.slots.length === n + 1, n0);
    const s = await song();
    assert.deepEqual(s.patch.slots[1].instrument, s.patch.slots[0].instrument, 'the copy sits next to it (D23.2)');
    await until((n) => document.querySelectorAll('.v6-strip:not([hidden])').length === n + 1, n0);
    // Remove (the copy): a short press does nothing, a hold removes
    await page.click(tid('v6-more-1'));
    await page.click(tid('v6-remove-1'));
    await page.waitForTimeout(200);
    assert.equal((await song()).patch.slots.length, n0 + 1, 'a tap does not remove');
    if (!(await page.$(tid('v6-menu-1')))) await page.click(tid('v6-more-1'));
    await hold(tid('v6-remove-1'));
    await until((n) => window.__rig.store.currentSong().patch.slots.length === n, n0);
    // Open in Edit
    await page.click(tid('v6-more-1'));
    await page.click(tid('v6-open-edit-1'));
    await until(() => document.body.dataset.view === 'edit');
    await ev(() => window.__rig.ctx.setView('perform'));
    await until(() => document.body.dataset.view === 'perform');
    // + Add instrument: an empty slot at the end, then Edit
    await page.click(tid('v6-add'));
    await until((n) => window.__rig.store.currentSong().patch.slots.length === n + 1, n0);
    await until(() => document.body.dataset.view === 'edit');
    assert.equal((await song()).patch.slots[n0], null, 'an empty slot');
    await ev(() => window.__rig.ctx.setView('perform'));
    await until(() => document.body.dataset.view === 'perform');
    await until((n) => document.querySelector(`[data-testid="v6-name-${n}"]`)?.textContent === 'Empty', n0);
    assert.equal(await page.textContent(tid(`v6-change-${n0}`)), 'Choose');
  });

  await T('> 5 instruments: five-across width, the row scrolls, name pills light and jump', async () => {
    assert.equal(await setSlots(7), 7);
    await until(() => document.querySelectorAll('.v6-strip:not([hidden])').length === 7);
    await page.waitForTimeout(300);
    const r = await ev(() => {
      const row = document.querySelector('[data-testid="v6-strips"]');
      const strips = [...row.querySelectorAll('.v6-strip:not([hidden])')];
      const pills = [...document.querySelectorAll('[data-testid^="v6-pill-"]:not([hidden])')];
      return {
        scroll: document.querySelector('.v6-stripsarea').classList.contains('scroll'),
        pillsShown: !document.querySelector('[data-testid="v6-pills"]').hidden,
        pills: pills.map((p) => p.textContent),
        lit: pills.map((p) => p.classList.contains('vis')),
        overflow: row.scrollWidth > row.clientWidth,
        across: row.clientWidth / strips[0].getBoundingClientRect().width,
        widths: new Set(strips.map((s) => Math.round(s.getBoundingClientRect().width))).size,
      };
    });
    assert.equal(r.scroll, true);
    assert.equal(r.pillsShown, true);
    assert.equal(r.pills.length, 7);
    assert.ok(!r.pills.some((p) => /^(Keys|Pad|Extra|Bass)$/i.test(p)), r.pills.join());
    assert.equal(r.overflow, true);
    assert.ok(r.across > 5 && r.across < 6, `strips across: ${r.across}`);
    assert.equal(r.widths, 1, 'every strip the same width');
    assert.deepEqual(r.lit, [true, true, true, true, true, false, false]);
    await page.click(tid('v6-pill-6'));
    await until(() => document.querySelector('[data-testid="v6-pill-6"]').classList.contains('vis'));
    assert.equal(await ev(() => document.querySelector('[data-testid="v6-pill-0"]').classList.contains('vis')), false);
    assert.ok(await ev(() => document.querySelector('[data-testid="v6-strips"]').scrollLeft > 0));
    // the pill buttons are 44 px targets around the 28 px pill (DESIGN_PHILOSOPHY)
    const box = await ev(() => {
      const r0 = document.querySelector('[data-testid="v6-pill-2"]').getBoundingClientRect();
      const t = document.querySelector('[data-testid="v6-pill-2"] .v6-pill-t').getBoundingClientRect();
      return { h: r0.height, w: r0.width, t: t.height };
    });
    assert.ok(box.h >= 44 && box.w >= 44 && box.t === 28, JSON.stringify(box));
    await page.click(tid('v6-pill-0'));
    await until(() => document.querySelector('[data-testid="v6-pill-0"]').classList.contains('vis'));
    // back to five: no scroll, no pills
    await setSlots(5);
    await until(() => !document.querySelector('.v6-stripsarea').classList.contains('scroll'));
    // skeptic UI6-U3: since U3 the pills also follow the measured overflow, which the row re-reads on the next frame
    // (strips-row.js `visible`); asserting in the same frame as the class change raced it under load (1 of 3 runs)
    await until(() => document.querySelector('[data-testid="v6-pills"]').hidden, null, 5000);
    assert.equal(await ev(() => document.querySelector('.v6-stripsarea').classList.contains('overflow')), false);
  });

  await T('snapshots: + Save, chips play, edited · Update · Save as new, Own levels', async () => {
    await setSlots(2);
    // a clean song state: no scenes yet
    await ev(() => window.__rig.store.set(`songs.${window.__rig.store.currentSong().id}.scenes`, []));
    await until(() => document.querySelectorAll('[data-testid^="v6-snap-"][data-n]').length === 0);
    // U7c: + Save opens the Save snapshot dialog; an empty name = "Scene 1" (D25)
    await page.click(tid('v6-snap-save'));
    await until(() => !!document.querySelector('[data-testid="v6-savesnap"]'));
    await page.fill(tid('v6-savesnap-name'), '');
    await page.click(tid('v6-savesnap-new'));
    await until(() => (window.__rig.store.currentSong().scenes || []).length === 1);
    await until(() => document.querySelector('[data-testid="v6-snap-1"]')?.classList.contains('plate'));
    assert.equal(await page.textContent(tid('v6-snap-1')), 'Scene 1');
    assert.equal(await ev(() => document.querySelector('[data-testid="v6-snap-dirty"]').hidden), true);
    // a level move while the scene plays → "edited"
    await page.click(tid('v6-on-0'));
    await until(() => !document.querySelector('[data-testid="v6-snap-dirty"]').hidden);
    // skeptic UI6-U1 F4: Update / Save as new are 44 px targets like the rest of the stage
    const linkSizes = await ev(() => ['v6-snap-update', 'v6-snap-new'].map((t) => {
      const r = document.querySelector(`[data-testid="${t}"]`).getBoundingClientRect();
      return r.width >= 43.5 && r.height >= 43.5 ? 'ok' : `${t} ${r.width}x${r.height}`;
    }));
    assert.deepEqual(linkSizes, ['ok', 'ok']);
    // Update saves it into scene 1; the line goes
    await page.click(tid('v6-snap-update'));
    await until(() => document.querySelector('[data-testid="v6-snap-dirty"]').hidden);
    assert.equal((await song()).scenes[0].slots[0].muted, true);
    // edit again → Save as new = scene 2
    await page.click(tid('v6-on-0'));
    await until(() => !document.querySelector('[data-testid="v6-snap-dirty"]').hidden);
    await page.click(tid('v6-snap-new'));
    await until(() => !!document.querySelector('[data-testid="v6-savesnap"]'));
    await page.click(tid('v6-savesnap-new'));
    await until(() => (window.__rig.store.currentSong().scenes || []).length === 2);
    await until(() => document.querySelector('[data-testid="v6-snap-2"]')?.classList.contains('plate'));
    // Own levels / Scene 1 by tap
    await page.click(tid('v6-snap-own'));
    await until(() => window.__rig.controller.scenes.state().n === null);
    await page.click(tid('v6-snap-1'));
    await until(() => window.__rig.controller.scenes.state().n === 0);
    assert.equal(await page.getAttribute(tid('v6-snap-1'), 'aria-pressed'), 'true');
    await page.click(tid('v6-snap-own'));
    await until(() => window.__rig.controller.scenes.state().n === null);
  });

  await T('snapshots fold into the song bar chip; the fold is remembered after a reload', async () => {
    await page.click(tid('v6-snap-fold'));
    await until(() => document.querySelector('[data-testid="v6-snaps"]').hidden);
    assert.equal(await page.isVisible(tid('v6-snap-chip')), true);
    assert.equal(await ev(() => localStorage.getItem('worship-rig.v6.snapshots')), 'folded');
    await page.reload();
    await waitRigReady(page, { timeout: 40000 });
    await until(() => !!window.__rig.views.v6, null, 20000);
    await settled();
    assert.equal(await ev(() => document.querySelector('[data-testid="v6-snaps"]').hidden), true);
    assert.equal(await page.textContent(`${tid('v6-snap-chip')} .v6-snapchip-n`), 'Own levels');
    await page.click(tid('v6-snap-chip'));
    await until(() => !document.querySelector('[data-testid="v6-snaps"]').hidden);
    assert.equal(await ev(() => localStorage.getItem('worship-rig.v6.snapshots')), null);
    assert.equal(await page.isVisible(tid('v6-snap-chip')), false);
  });

  await T('song bar: Transpose + / "you play", Sing it in, Space room, Notes, Setlist cue + GO', async () => {
    const s0 = await song();
    await page.click(tid('v6-transpose-up'));
    await until((h0) => window.__rig.store.currentSong().hearIn === (h0 + 1) % 12, s0.hearIn);
    assert.equal(await page.isVisible(tid('v6-playin')), true);
    assert.match(await page.textContent(tid('v6-playin')), /^you play /);
    await page.click(tid('v6-transpose-down'));
    await until((h0) => window.__rig.store.currentSong().hearIn === h0, s0.hearIn);
    assert.equal(await page.isVisible(tid('v6-playin')), false);
    // Sing it in: opens, Esc closes it (no panic)
    await armPanics();
    await page.click(tid('v6-key'));
    await until(() => !!document.querySelector('[data-testid="v6-sing"]'));
    await page.keyboard.press('Escape');
    await until(() => !document.querySelector('[data-testid="v6-sing"]'));
    assert.equal(await ev(() => window.__panics), 0);
    // Space room: Hall
    await page.click(tid('v6-space'));
    await page.click(tid('v6-room-hall'));
    await until(() => document.querySelector('[data-testid="v6-space"] .v6-space-t').textContent === 'Hall');
    // Notes (U3: the button opens the sidebar on its Notes module)
    await page.click(tid('v6-notes'));
    await until(() => !!document.querySelector('[data-testid="v6-notes-mod"]'));
    assert.equal(await page.getAttribute(tid('v6-notes'), 'aria-pressed'), 'true');
    // Setlist (U3: in the sidebar): tap the next entry = cue; GO plays it
    const first = s0.id;
    await page.click(tid('v6-setlist'));
    await until(() => !!document.querySelector('[data-testid="v6-setlist-mod"]'));
    const cur = await ev(() => window.__rig.store.currentIndex());
    await page.click(tid(`v6-sl-${cur + 1}`));
    await until(() => !!window.__rig.controller.status.cue);
    await until(() => {
      const next = document.querySelector(`[data-testid="v6-sl-${window.__rig.store.currentIndex() + 1}"]`);
      return /cued/.test(next?.className || '');
    });
    await page.click(tid('v6-go'));
    await until((id) => window.__rig.store.currentSong().id !== id, first, 20000);
    await settled();
    assert.match(await page.textContent(tid('v6-song-name')), new RegExp(
      (await song()).name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await ev(() => window.__rig.controller.prevSong());
    await until((id) => window.__rig.store.currentSong().id === id, first, 20000);
    await settled();
  });

  await T('Revert needs a hold; PANIC a tap; Lock a tap, unlock a hold; Lock freezes Change / Add / Remove',
    async () => {
    // Revert: transpose, then hold
    const h0 = (await song()).hearIn;
    await page.click(tid('v6-transpose-up'));
    await until((x) => window.__rig.store.currentSong().hearIn !== x, h0);
    await until(() => !document.querySelector('[data-testid="v6-revert"]').disabled);
    await page.click(tid('v6-revert'));
    await page.waitForTimeout(150);
    assert.notEqual((await song()).hearIn, h0, 'a tap does not revert');
    await hold(tid('v6-revert'));
    await until((x) => window.__rig.store.currentSong().hearIn === x, h0);
    // PANIC: a tap panics (D23.1, as today's Perform)
    await armPanics();
    await page.click(tid('v6-panic'));
    await until(() => window.__panics === 1);
    // Lock: a tap locks (D23.1, as today's Perform: unlocking needs the hold)
    await page.click(tid('v6-lock'));
    await until(() => window.__rig.store.get().settings.performLock === true);
    const r = await ev(() => ({
      change: document.querySelector('[data-testid="v6-change-0"]').disabled,
      add: document.querySelector('[data-testid="v6-add"]').disabled,
      cls: document.querySelector('.v6').classList.contains('locked'),
      fader: document.querySelector('[data-testid="v6-fader-0"] input').disabled,
    }));
    assert.deepEqual(r, { change: true, add: true, cls: true, fader: false });
    await page.click(tid('v6-more-0'));
    assert.equal(await page.isDisabled(tid('v6-remove-0')), true);
    assert.equal(await page.isDisabled(tid('v6-dup-0')), true);
    await page.keyboard.press('Escape');
    // transpose needs a hold while locked
    const h1 = (await song()).hearIn;
    await page.click(tid('v6-transpose-up'));
    await page.waitForTimeout(150);
    assert.equal((await song()).hearIn, h1);
    await hold(tid('v6-transpose-up'));
    await until((x) => window.__rig.store.currentSong().hearIn !== x, h1);
    await hold(tid('v6-transpose-down'));
    await hold(tid('v6-lock'));
    await until(() => !window.__rig.store.get().settings.performLock);
  });

  // ---------------------------------------------------------------- U2: the keyboard with range bars
  const KB = 'v6-kbd';
  /** Set a slot's range in an order the store never swaps (normalizeSlot swaps a crossed pair). */
  const setRange = (i, lo, hi) => ev(({ i, lo, hi }) => {
    const { store } = window.__rig;
    const p = `songs.${store.currentSong().id}.patch.slots.${i}`;
    store.set(`${p}.lowNote`, 0);
    store.set(`${p}.highNote`, 127);
    store.set(`${p}.lowNote`, lo);
    store.set(`${p}.highNote`, hi);
  }, { i, lo, hi });
  const rangeOf = async (i) => {
    const s = (await song()).patch.slots[i];
    return [s.lowNote, s.highNote];
  };
  const rangeIs = (i, lo, hi) => until(({ i, lo, hi }) => {
    const s = window.__rig.store.currentSong().patch.slots[i];
    return s.lowNote === lo && s.highNote === hi;
  }, { i, lo, hi });
  /** Rect of a key / bar / handle on a page. */
  const rectOf = (pg, sel) => pg.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2,
      cy: r.top + r.height / 2 };
  }, sel);
  const keyRect = (pg, note, scope = '.v6-kbd') => rectOf(pg, `${scope} .pkey[data-note="${note}"]`);
  /**
   * D24.3: on Perform an instrument's range is picked first on every pointer: click its strip name unless it is
   * already the picked one (a second click would finish the pick).
   */
  async function pickOn(pg, i) {
    const on = await pg.evaluate((k) => document.querySelector(`[data-testid="v6-strip-${k}"]`)
      ?.classList.contains('range-picked'), i);
    if (on) return;
    await pg.click(`[data-testid="v6-who-${i}"]`);
    await pg.waitForFunction((k) => document.querySelector(`[data-testid="v6-strip-${k}"]`)
      .classList.contains('range-picked'), i, { timeout: 15000, polling: 50 });
  }
  /** Press a handle's centre, move to x in steps (mid() runs while still held), release. Picks a Perform bar first. */
  async function dragHandle(pg, sel, x, mid) {
    const m = /"v6-kbd-h(?:lo|hi)-(\d+)"/.exec(sel);
    if (m) await pickOn(pg, Number(m[1]));
    const b = await rectOf(pg, sel);
    await pg.mouse.move(b.cx, b.cy);
    await pg.mouse.down();
    await pg.mouse.move(x, b.cy, { steps: 10 });
    if (mid) await mid();
    await pg.mouse.up();
  }
  const near = (a, b, tol = 1.01) => Math.abs(a - b) <= tol;

  await T('U2 range bars: one per instrument, position colours, black keys at their real positions', async () => {
    await ev(() => window.__rig.ctx.setView('perform'));
    await setSlots(3);
    await setRange(0, 40, 61); // E2 – Db4 (a black key)
    await setRange(1, 36, 96);
    await setRange(2, 30, 59); // F#1 is below C2: clipped on the left
    await until(() => document.querySelectorAll('.v6-kbd .v6-rbar').length === 3);
    const b0 = await rectOf(page, tid(`${KB}-bar-0`));
    const k40 = await keyRect(page, 40);
    const k61 = await keyRect(page, 61);
    assert.ok(near(b0.l, k40.l) && near(b0.r, k61.r), `bar 0 ${b0.l}–${b0.r} vs keys ${k40.l}–${k61.r}`);
    const r = await ev(() => [...document.querySelectorAll('.v6-kbd .v6-rbar')].map((b) => ({
      c: b.style.getPropertyValue('--c'), clipL: b.classList.contains('clip-l'), clipR: b.classList.contains('clip-r'),
      lo: b.querySelector('.v6-rh.l').getAttribute('aria-valuetext'),
      hi: b.querySelector('.v6-rh.r').getAttribute('aria-valuetext'),
    })));
    assert.deepEqual(r.map((x) => x.c), ['var(--slot-0)', 'var(--slot-1)', 'var(--slot-2)']);
    assert.deepEqual(r.map((x) => [x.clipL, x.clipR]), [[false, false], [false, false], [true, false]]);
    assert.equal(r[0].hi, 'Db4');
    assert.match(r[2].lo, /^Gb1, outside the keys shown/);
    // 34 px tall hit layer over the thin bars
    const hit = await rectOf(page, tid(`${KB}-hit`));
    assert.ok(hit.h >= 34, `hit layer ${hit.h} px`);
    assert.ok((await rectOf(page, tid(`${KB}-bar-0`))).h < 10, 'the bars stay thin');
  });

  await T('U2 drag: snaps to keys (black too), label while dragging, one write on release, only that end', async () => {
    const before = (await song()).patch.slots[2];
    const name = await page.textContent(tid('v6-name-2'));
    const k54 = await keyRect(page, 54); // Gb3, a black key
    let mid = null;
    await dragHandle(page, tid(`${KB}-hhi-2`), k54.r + 2, async () => {
      await page.waitForTimeout(120); // past the 50 ms throttle (D24.2)
      mid = await ev(() => ({
        tip: document.querySelector('[data-testid="v6-kbd-tip"]').textContent,
        shown: !document.querySelector('[data-testid="v6-kbd-tip"]').hidden,
        hi: window.__rig.store.currentSong().patch.slots[2].highNote,
        barR: document.querySelector('[data-testid="v6-kbd-bar-2"]').getBoundingClientRect().right,
      }));
    });
    assert.equal(mid.shown, true);
    assert.equal(mid.tip, `${name} · Gb1–Gb3`);
    assert.equal(mid.hi, 54, 'written live while dragging (D24.2)');
    assert.ok(near(mid.barR, k54.r), `bar end ${mid.barR} on the key's edge ${k54.r}`);
    await rangeIs(2, 30, 54);
    const after = (await song()).patch.slots[2];
    assert.deepEqual({ ...after, highNote: 59 }, before, 'only highNote changed');
    // the drag's label goes; the picked bar keeps its plain label (D24.3)
    assert.equal(await ev(() => document.querySelector('[data-testid="v6-kbd-tip"]').classList.contains('live')),
      false);
    // a white key: the lowest end of bar 1 onto A2 (45)
    const k45 = await keyRect(page, 45);
    await dragHandle(page, tid(`${KB}-hlo-1`), k45.l - 1);
    await rangeIs(1, 45, 96);
  });

  await T('U2 clamp: lowest stays below highest; past the edge = every key that way (0 / 127)', async () => {
    await setRange(0, 40, 61);
    const k61 = await keyRect(page, 61);
    await dragHandle(page, tid(`${KB}-hlo-0`), k61.r + 200);
    await rangeIs(0, 60, 61);
    // the highest end onto the right edge and past it → 127 ("and up")
    const kbr = await rectOf(page, tid('v6-piano'));
    let tip = '';
    await dragHandle(page, tid(`${KB}-hhi-0`), kbr.r + 30, async () => {
      tip = await page.textContent(tid(`${KB}-tip`));
    });
    assert.match(tip, / · C4 and up$/);
    await rangeIs(0, 60, 127);
    // the lowest end past the left edge → 0; the bar now runs off both ends (edge markers)
    await dragHandle(page, tid(`${KB}-hlo-0`), kbr.l - 40);
    await rangeIs(0, 0, 127);
    assert.deepEqual(await ev(() => {
      const b = document.querySelector('[data-testid="v6-kbd-bar-0"]');
      return [b.classList.contains('clip-l'), b.classList.contains('clip-r'),
        b.querySelector('.v6-rh.l').classList.contains('beyond')];
    }), [true, true, true]);
  });

  await T('U2 ranges outside C2–C7: drawn clipped with a marker, kept unless that end is dragged', async () => {
    await setRange(0, 21, 108); // A0–C8
    await setRange(1, 100, 120); // wholly above C7: a stub at the right edge
    await page.waitForTimeout(100);
    const kbr = await rectOf(page, tid('v6-piano'));
    const stub = await rectOf(page, tid(`${KB}-bar-1`));
    assert.ok(stub.w > 2 && near(stub.r, kbr.r, 1.5), `stub ${stub.l}–${stub.r}, keys end ${kbr.r}`);
    assert.equal(await ev(() => document.querySelector('[data-testid="v6-kbd-bar-1"]').classList.contains('clip-r')),
      true);
    // a press without a move on the clipped end writes nothing
    await pickOn(page, 0);
    const h0 = await rectOf(page, tid(`${KB}-hlo-0`));
    await page.mouse.move(h0.cx, h0.cy);
    await page.mouse.down();
    await page.mouse.move(h0.cx + 2, h0.cy);
    await page.mouse.up();
    await page.waitForTimeout(100);
    assert.deepEqual(await rangeOf(0), [21, 108]);
    // dragging the other end keeps the clipped one
    const k72 = await keyRect(page, 72);
    await dragHandle(page, tid(`${KB}-hhi-0`), k72.r);
    await rangeIs(0, 21, 72);
    assert.deepEqual(await rangeOf(1), [100, 120], 'an untouched bar keeps its range');
  });

  await T('U2 keys: handles focusable, ←/→ a semitone, Shift an octave, aria-valuetext; no song change', async () => {
    await setRange(2, 48, 72);
    const id = (await song()).id;
    await pickOn(page, 2); // D24.3: only the picked bar's handles are in the tab order
    await page.focus(tid(`${KB}-hlo-2`));
    assert.equal(await ev(() => document.activeElement.getAttribute('role')), 'slider');
    await page.keyboard.press('ArrowRight');
    await rangeIs(2, 49, 72);
    await page.keyboard.press('Shift+ArrowRight');
    await rangeIs(2, 61, 72);
    await page.keyboard.press('ArrowLeft');
    await rangeIs(2, 60, 72);
    assert.equal(await page.getAttribute(tid(`${KB}-hlo-2`), 'aria-valuetext'), 'C4');
    assert.equal(await page.getAttribute(tid(`${KB}-hlo-2`), 'aria-valuemax'), '71');
    // the tip shows for the focused handle
    assert.match(await page.textContent(tid(`${KB}-tip`)), / · C4–C5$/);
    await page.focus(tid(`${KB}-hhi-2`));
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft'); // clamps at lowest + 1
    await rangeIs(2, 60, 61);
    assert.equal((await song()).id, id, 'arrows on a handle never change the song');
    await ev(() => document.activeElement.blur());
  });

  await T('U2 range edits count like any edit: changed count, Revert restores', async () => {
    await setRange(2, 48, 84);
    // a fresh Revert snapshot: Edit and back takes it (perform.js)
    await ev(() => window.__rig.ctx.setView('edit'));
    await until(() => document.body.dataset.view === 'edit');
    await ev(() => window.__rig.ctx.setView('perform'));
    await until(() => document.body.dataset.view === 'perform');
    await until(() => document.querySelector('[data-testid="v6-revert"]').disabled);
    const [lo] = await rangeOf(2);
    const k = await keyRect(page, lo + 12);
    await dragHandle(page, tid(`${KB}-hlo-2`), k.l);
    await until((x) => window.__rig.store.currentSong().patch.slots[2].lowNote === x, lo + 12);
    await until(() => !document.querySelector('[data-testid="v6-revert"]').disabled);
    assert.ok((await ev(() => window.__rig.views.perform.changedPaths)).some((p) => /slots\.2\.lowNote$/.test(p)));
    assert.equal(await page.getAttribute(tid('v6-revert'), 'data-count'), '1');
    assert.equal(await ev(() => document.querySelector('[data-testid="v6-kbd-bar-2"]').classList.contains('changed')),
      true, 'the bar carries the changed dot');
    await hold(tid('v6-revert'));
    await until((x) => window.__rig.store.currentSong().patch.slots[2].lowNote === x, lo);
    await until(() => !document.querySelector('[data-testid="v6-kbd-bar-2"]').classList.contains('changed'));
  });

  await T('U2 Lock: no range edits (drag, arrows); handles hidden and out of the tab order', async () => {
    await setRange(0, 48, 72);
    await hold(tid('v6-lock'));
    await until(() => window.__rig.store.get().settings.performLock === true);
    const r = await ev(() => ({
      handles: [...document.querySelectorAll('.v6-kbd .v6-rh')].map((x) => [x.tabIndex,
        x.getAttribute('aria-disabled'), getComputedStyle(x).display]),
      hit: getComputedStyle(document.querySelector('[data-testid="v6-kbd-hit"]')).pointerEvents,
    }));
    assert.ok(r.handles.every(([t, a, dsp]) => t === -1 && a === 'true' && dsp === 'none'), JSON.stringify(r));
    assert.equal(r.hit, 'none');
    const b = await rectOf(page, tid(`${KB}-bar-0`));
    await page.mouse.move(b.r, b.cy);
    await page.mouse.down();
    await page.mouse.move(b.r + 120, b.cy, { steps: 6 });
    await page.mouse.up();
    await ev(() => {
      const hd = document.querySelector('[data-testid="v6-kbd-hhi-0"]');
      hd.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(150);
    assert.deepEqual(await rangeOf(0), [48, 72]);
    await hold(tid('v6-lock'));
    await until(() => !window.__rig.store.get().settings.performLock);
    assert.equal(await page.getAttribute(tid(`${KB}-hhi-0`), 'tabindex'), '-1', 'not picked: out of the tab order');
    await pickOn(page, 0);
    assert.equal(await page.getAttribute(tid(`${KB}-hhi-0`), 'tabindex'), '0');
  });

  await T('U2 skeptic: a slot shift or a hidden view drops a drag; a one-key range never moves the wrong way',
    async () => {
      // F3: removing slot 0 mid-drag of slot 2's end used to write that end into the old slot 3
      await setSlots(4);
      await setRange(0, 36, 96);
      await setRange(1, 40, 80);
      await setRange(2, 48, 72);
      await setRange(3, 60, 84);
      await until(() => document.querySelectorAll('.v6-kbd .v6-rbar').length === 4);
      const before = (await song()).patch.slots.map((s) => [s.lowNote, s.highNote]);
      await pickOn(page, 2);
      const h2 = await rectOf(page, tid(`${KB}-hhi-2`));
      const k65 = await keyRect(page, 65);
      await page.mouse.move(h2.cx, h2.cy);
      await page.mouse.down();
      await page.mouse.move(k65.r, h2.cy, { steps: 6 });
      await ev(() => {
        const { store } = window.__rig;
        store.removeSlot(store.currentSong().id, 0);
      });
      await page.waitForTimeout(100);
      assert.equal(await ev(() => document.querySelector('.v6-kbd').classList.contains('dragging')), false,
        'the drag is dropped');
      await page.mouse.move(k65.r + 3, h2.cy);
      await page.mouse.up();
      await page.waitForTimeout(150);
      assert.deepEqual((await song()).patch.slots.map((s) => [s.lowNote, s.highNote]), before.slice(1),
        'the live writes were put back (D24.2), on the instrument, not the shifted neighbour');
      // F4: a view switch mid-drag; the release used to write 0 / 127 (the hidden keys measure 0 px)
      await setSlots(3);
      await setRange(1, 40, 80);
      await pickOn(page, 1);
      const h1 = await rectOf(page, tid(`${KB}-hhi-1`));
      const k70 = await keyRect(page, 70);
      await page.mouse.move(h1.cx, h1.cy);
      await page.mouse.down();
      await page.mouse.move(k70.r, h1.cy, { steps: 6 });
      await ev(() => window.__rig.ctx.setView('edit'));
      await until(() => document.body.dataset.view === 'edit');
      await page.mouse.move(k70.r - 40, h1.cy, { steps: 3 });
      await page.mouse.up();
      await page.waitForTimeout(150);
      assert.deepEqual(await rangeOf(1), [40, 80], 'nothing written by the hidden drag');
      await ev(() => window.__rig.ctx.setView('perform'));
      await until(() => document.body.dataset.view === 'perform');
      assert.equal(await ev(() => document.querySelector('.v6-kbd').classList.contains('dragging')), false);
      // F5: a stored one-key range (today's Edit allows it): → on its lowest end, ← on its highest and a short
      // inward drag change nothing (they used to move the end a key the other way); valuenow stays within min..max
      await setRange(2, 60, 60);
      await pickOn(page, 2);
      await page.focus(tid(`${KB}-hlo-2`));
      await page.keyboard.press('ArrowRight');
      await page.focus(tid(`${KB}-hhi-2`));
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(150);
      assert.deepEqual(await rangeOf(2), [60, 60]);
      const aria = await ev(() => ['lo', 'hi'].map((e) => {
        const x = document.querySelector(`[data-testid="v6-kbd-h${e}-2"]`);
        return ['valuemin', 'valuenow', 'valuemax'].map((k) => Number(x.getAttribute(`aria-${k}`)));
      }));
      assert.ok(aria.every(([a, n, b]) => a <= n && n <= b), JSON.stringify(aria));
      await ev(() => document.activeElement.blur());
      const l2 = await rectOf(page, tid(`${KB}-hlo-2`));
      await page.mouse.move(l2.cx, l2.cy);
      await page.mouse.down();
      await page.mouse.move(l2.cx + 8, l2.cy, { steps: 3 });
      await page.mouse.up();
      await page.waitForTimeout(150);
      assert.deepEqual(await rangeOf(2), [60, 60]);
      await page.focus(tid(`${KB}-hlo-2`));
      await page.keyboard.press('ArrowLeft'); // outward still works
      await rangeIs(2, 59, 60);
      await ev(() => document.activeElement.blur());
    });

  await T('U2 Edit › Range size (harness): 88 keys A0–C8, one bar, outside dimmed, shorter, drag, arrows', async () => {
    const hp = await context.newPage();
    hp.on('console', (m) => {
      if (m.type() === 'error') errors.push(`[harness] ${m.text()}`);
    });
    hp.on('pageerror', (e) => errors.push(`[harness] pageerror: ${e.message}`));
    hp.on('response', (res) => {
      if (res.status() >= 400) errors.push(`[harness] HTTP ${res.status()} ${res.url()}`);
    });
    const body = fs.readFileSync(path.join(HERE, 'keyboard-harness.html'), 'utf8');
    await hp.route('**/u2-keyboard-harness.html*', (r) => r.fulfill({ body, contentType: 'text/html' }));
    try {
      await hp.setViewportSize({ width: 700, height: 300 });
      await hp.goto(`${origin}/u2-keyboard-harness.html?size=range`);
      await hp.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
      const R = 'v6-range-kbd';
      const r = await hp.evaluate(() => {
        const keys = [...document.querySelectorAll('.v6-kbd-range .pkey')].map((k) => Number(k.dataset.note));
        const el = document.querySelector('.v6-kbd-range');
        return {
          n: keys.length, first: keys[0], last: keys[keys.length - 1],
          bars: document.querySelectorAll('.v6-kbd-range .v6-rbar').length,
          h: el.getBoundingClientRect().height,
          out: document.querySelectorAll('.v6-kbd-range .pkey.out').length,
          tip: document.querySelector('[data-testid="v6-range-kbd-tip"]').textContent,
          tipShown: !document.querySelector('[data-testid="v6-range-kbd-tip"]').hidden,
        };
      });
      assert.deepEqual(r, { n: 88, first: 21, last: 108, bars: 1, h: r.h, out: 0, tip: 'Grand Piano · every key',
        tipShown: true });
      assert.ok(r.h <= 100, `height ${r.h}`);
      await hp.evaluate(() => window.__h.set(0, 48, 72));
      await hp.waitForFunction(() => document.querySelectorAll('.v6-kbd-range .pkey.out').length === 88 - 25);
      assert.equal(await hp.textContent(tid(`${R}-tip`)), 'Grand Piano · C3–C5');
      const k60 = await keyRect(hp, 60, '.v6-kbd-range');
      await dragHandle(hp, tid(`${R}-hlo-0`), k60.l);
      await hp.waitForFunction(() => window.__h.state.slots[0].lo === 60);
      // D24.2: live writes while dragging (one end only), the last one is the release value
      const ws = await hp.evaluate(() => window.__h.writes);
      assert.ok(ws.every(([i, f]) => i === 0 && f === 'lowNote'), JSON.stringify(ws));
      assert.deepEqual(ws[ws.length - 1].slice(0, 3), [0, 'lowNote', 60]);
      await hp.waitForFunction(() => document.querySelectorAll('.v6-kbd-range .pkey.out').length === 88 - 13);
      await hp.focus(tid(`${R}-hhi-0`));
      await hp.keyboard.press('Shift+ArrowRight');
      await hp.waitForFunction(() => window.__h.state.slots[0].hi === 84);
      await hp.evaluate(() => document.activeElement.blur());
      await hp.waitForTimeout(150);
      await hp.screenshot({ path: path.join(SHOTS, 'u2-edit-range-harness.png') });
      // locked: no writes
      await hp.evaluate(() => window.__h.lock(true));
      const n0 = await hp.evaluate(() => window.__h.writes.length);
      const hr = await rectOf(hp, tid(`${R}-bar-0`));
      await hp.mouse.move(hr.l, hr.cy);
      await hp.mouse.down();
      await hp.mouse.move(hr.l - 80, hr.cy, { steps: 5 });
      await hp.mouse.up();
      assert.equal(await hp.evaluate(() => window.__h.writes.length), n0);
      // coarse: the one bar is live straight away, with 26 px handles (no pick step in Edit)
      await hp.goto(`${origin}/u2-keyboard-harness.html?size=range&coarse=1`);
      await hp.waitForFunction(() => window.__ready === true);
      const hd = await rectOf(hp, tid(`${R}-hlo-0`));
      assert.ok(near(hd.w, 26), `coarse handle ${hd.w} px`);
      await hp.evaluate(() => window.__h.set(0, 48, 72));
      const k50 = await keyRect(hp, 50, '.v6-kbd-range');
      await dragHandle(hp, tid(`${R}-hlo-0`), k50.l);
      await hp.waitForFunction(() => window.__h.state.slots[0].lo === 50);
    } finally {
      await hp.close();
    }
  });

  await T('U2 iPad (coarse): tap a strip, outline + "changing range", only its bar, 26 px handles', async () => {
    const tc = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true });
    await pinTheme(tc, 'sanctuary');
    await tc.grantPermissions([...MIDI_PERMISSIONS], { origin });
    const tp = await tc.newPage();
    tp.on('console', (m) => {
      if (m.type() === 'error') errors.push(`[touch] ${m.text()}`);
    });
    tp.on('pageerror', (e) => errors.push(`[touch] pageerror: ${e.message}`));
    tp.on('response', (res) => {
      if (res.status() >= 400) errors.push(`[touch] HTTP ${res.status()} ${res.url()}`);
    });
    const tev = (fn, arg) => tp.evaluate(fn, arg);
    const tuntil = (fn, arg) => tp.waitForFunction(fn, arg, { timeout: 15000, polling: 50 });
    const cdp = await tc.newCDPSession(tp);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent',
      { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    async function touchDrag(x0, y, x1) {
      await touch('touchStart', x0, y);
      for (let k = 1; k <= 8; k++) await touch('touchMove', x0 + (x1 - x0) * k / 8, y);
      await touch('touchEnd');
    }
    try {
      await tp.goto(`${origin}/?ui6=1`);
      await waitRigReady(tp, { timeout: 40000 });
      await tuntil(() => !!window.__rig.views.v6);
      await tuntil(() => {
        const { controller, store } = window.__rig;
        return controller.status.songId === store.get().settings.currentSongId && !controller.status.loading;
      });
      assert.equal(await tev(() => matchMedia('(pointer: coarse)').matches), true, 'the context is coarse');
      await tev(({ list }) => {
        const { store } = window.__rig;
        const id = store.currentSong().id;
        while (store.currentSong().patch.slots.length < 3) store.addSlot(id);
        list.slice(0, 3).forEach(([type, iid], i) => {
          const ref = { type, id: iid };
          if (store.currentSong().patch.slots[i]) store.set(`songs.${id}.patch.slots.${i}.instrument`, ref);
          else store.set(`songs.${id}.patch.slots.${i}`, { instrument: ref });
        });
        const p = (i) => `songs.${id}.patch.slots.${i}`;
        store.set(`${p(1)}.lowNote`, 0);
        store.set(`${p(1)}.highNote`, 127);
        store.set(`${p(1)}.lowNote`, 48);
        store.set(`${p(1)}.highNote`, 84);
        window.__notes = 0;
        window.__rig.controller.addEventListener('notes', () => { window.__notes += 1; });
        window.__panics = 0;
        window.__rig.controller.addEventListener('action', (e) => {
          if (e.detail?.type === 'panic') window.__panics += 1;
        });
      }, { list: INSTRUMENTS });
      await tuntil(() => document.querySelectorAll('.v6-kbd .v6-rbar').length === 3);
      await tev(() => document.getElementById('toasts')?.replaceChildren());
      const r0 = await tev(() => ({
        coarse: document.querySelector('.v6').classList.contains('coarse'),
        role: document.querySelector('[data-testid="v6-who-1"]').getAttribute('role'),
        handles: [...document.querySelectorAll('.v6-kbd .v6-rh')].filter((x) => getComputedStyle(x).display !== 'none')
          .length,
      }));
      assert.deepEqual(r0, { coarse: true, role: 'button', handles: 0 });
      // not picked: a touch drag on Warm Pad's end does not move it
      // (its handles are not drawn: press where the end is)
      const bar1 = await rectOf(tp, tid(`${KB}-bar-1`));
      await touchDrag(bar1.r - 2, bar1.cy, bar1.r - 120);
      await tp.waitForTimeout(150);
      assert.deepEqual(await tev(() => {
        const s = window.__rig.store.currentSong().patch.slots[1];
        return [s.lowNote, s.highNote];
      }), [48, 84]);
      // that touch landed on the bar, which picks it (D18: "tap the instrument first" — its bar counts)
      await tuntil(() => window.__rig.views.v6 && document.querySelector('[data-testid="v6-strip-1"]')
        .classList.contains('range-picked'));
      // tap another strip's name to switch
      const who2 = await rectOf(tp, tid('v6-who-2'));
      await tp.touchscreen.tap(who2.cx, who2.cy);
      await tuntil(() => document.querySelector('[data-testid="v6-strip-2"]').classList.contains('range-picked'));
      const r1 = await tev(() => ({
        one: document.querySelector('[data-testid="v6-strip-1"]').classList.contains('range-picked'),
        flag: !document.querySelector('[data-testid="v6-pickflag-2"]').hidden,
        flagText: document.querySelector('[data-testid="v6-pickflag-2"]').textContent,
        outline: getComputedStyle(document.querySelector('[data-testid="v6-strip-2"]')).outlineStyle,
        picking: document.querySelector('.v6-kbd').classList.contains('picking'),
        hint: document.querySelector('[data-testid="v6-kbd-pickhint"]').textContent,
        dim: [0, 1, 2].map((i) => Number(getComputedStyle(document.querySelector(`[data-testid="v6-kbd-bar-${i}"]`))
          .opacity)),
        handles: [...document.querySelectorAll('.v6-kbd .v6-rh')].filter((x) => getComputedStyle(x).display !== 'none')
          .map((x) => [x.dataset.testid, Math.round(x.getBoundingClientRect().width)]),
      }));
      assert.deepEqual(r1, {
        one: false, flag: true, flagText: 'changing range', outline: 'solid', picking: true, hint: r1.hint,
        dim: [0.3, 0.3, 1], handles: [['v6-kbd-hlo-2', 26], ['v6-kbd-hhi-2', 26]],
      });
      assert.match(r1.hint, /^Drag the ends of .+ · tap another instrument to switch · tap the keys to finish$/);
      // a touch drag on the picked bar's highest end → written on release
      const sl2 = await tev(() => window.__rig.store.currentSong().patch.slots[2].highNote);
      const hi2 = await rectOf(tp, tid(`${KB}-hhi-2`));
      const k = await keyRect(tp, 72);
      await touchDrag(hi2.cx, hi2.cy, k.r);
      await tuntil(() => window.__rig.store.currentSong().patch.slots[2].highNote === 72);
      assert.notEqual(sl2, 72);
      // skeptic UI6-U2 F2: drag an end, then at once tap another instrument's name: it switches. Chromium drops the
      // click of a tap that soon after a quick touch drag (this test's former flake: 2 of 5 runs under load)
      const hi2b = await rectOf(tp, tid(`${KB}-hhi-2`));
      const k71 = await keyRect(tp, 71);
      const who1a = await rectOf(tp, tid('v6-who-1'));
      await touchDrag(hi2b.cx, hi2b.cy, k71.r);
      await tp.touchscreen.tap(who1a.cx, who1a.cy);
      await tuntil(() => document.querySelector('[data-testid="v6-strip-1"]').classList.contains('range-picked'));
      await tuntil(() => window.__rig.store.currentSong().patch.slots[2].highNote === 71);
      // and back to the first one, again straight after a drag (on bar 1 this time)
      const hi1 = await rectOf(tp, tid(`${KB}-hhi-1`));
      const k83 = await keyRect(tp, 83);
      await touchDrag(hi1.cx, hi1.cy, k83.r);
      await tp.touchscreen.tap(who2.cx, who2.cy);
      await tuntil(() => document.querySelector('[data-testid="v6-strip-2"]').classList.contains('range-picked'));
      await tuntil(() => window.__rig.store.currentSong().patch.slots[1].highNote === 83);
      // the same, deterministically: a touch press + release with no click picks; a click that follows is not a
      // second toggle; a press that moves (the row scrolling) picks nothing
      const tapNoClick = (i, { click = false, dx = 0 } = {}) => tev(({ i, click, dx }) => {
        const w = document.querySelector(`[data-testid="v6-who-${i}"]`);
        const r = w.getBoundingClientRect();
        const o = { pointerType: 'touch', pointerId: 77, isPrimary: true, bubbles: true, cancelable: true,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        w.dispatchEvent(new PointerEvent('pointerdown', o));
        w.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: o.clientX + dx }));
        if (click) w.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return [0, 1, 2].map((k) => document.querySelector(`[data-testid="v6-strip-${k}"]`).classList
          .contains('range-picked'));
      }, { i, click, dx });
      assert.deepEqual(await tapNoClick(1), [false, true, false], 'pointerup alone picks');
      assert.deepEqual(await tapNoClick(2, { click: true }), [false, false, true], 'pointerup + click: one toggle');
      assert.deepEqual(await tapNoClick(1, { dx: 40 }), [false, false, true], 'a press that moved picks nothing');
      // skeptic UI6-U2 F6: a second finger on the keys while one drags an end plays its note and keeps the drag
      // (it used to cancel the drag, unpick and swallow the note)
      {
        const hd = await rectOf(tp, tid(`${KB}-hhi-2`));
        const k69 = await keyRect(tp, 69);
        const k40 = await keyRect(tp, 40);
        const P = (x) => ({ x, y: hd.cy, id: 1 });
        const at = (m) => hd.cx + (k69.r - hd.cx) * m / 8;
        const td = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
        const n0 = await tev(() => window.__notes);
        await td('touchStart', [P(at(0))]);
        for (let m = 1; m <= 4; m++) await td('touchMove', [P(at(m))]);
        await td('touchStart', [P(at(4)), { x: k40.cx, y: k40.b - 10, id: 2 }]);
        await tuntil((n) => window.__notes > n, n0);
        assert.equal(await tev(() => document.querySelector('.v6-kbd').classList.contains('dragging')), true,
          'the drag goes on');
        await td('touchEnd', [P(at(4))]); // finger 2 lifts
        for (let m = 5; m <= 8; m++) await td('touchMove', [P(at(m))]);
        await td('touchEnd', []);
        await tuntil(() => window.__rig.store.currentSong().patch.slots[2].highNote === 69);
        assert.equal(await tev(() => document.querySelector('.v6-kbd').classList.contains('picking')), true);
      }
      // tap the keys: finishes, plays nothing
      const notes0 = await tev(() => window.__notes);
      const key = await keyRect(tp, 60);
      await tp.touchscreen.tap(key.cx, key.b - 10);
      await tuntil(() => !document.querySelector('.v6-kbd').classList.contains('picking'));
      await tp.waitForTimeout(150);
      assert.equal(await tev(() => window.__notes), notes0, 'the finishing tap plays no note');
      assert.equal(await tev(() => document.querySelector('[data-testid="v6-strip-2"]').classList
        .contains('range-picked')), false);
      // Esc finishes too, without a panic
      await tp.touchscreen.tap(who2.cx, who2.cy);
      await tuntil(() => document.querySelector('.v6-kbd').classList.contains('picking'));
      await tp.keyboard.press('Escape');
      await tuntil(() => !document.querySelector('.v6-kbd').classList.contains('picking'));
      assert.equal(await tev(() => window.__panics), 0);
      // locked: tapping a name picks nothing
      await tev(() => window.__rig.store.set('settings.performLock', true));
      await tp.touchscreen.tap(who2.cx, who2.cy);
      await tp.waitForTimeout(200);
      assert.equal(await tev(() => document.querySelector('.v6-kbd').classList.contains('picking')), false);
      await tev(() => window.__rig.store.set('settings.performLock', false));
      // the screenshot: Warm Pad picked, as the mockup's "iPad · pick, then drag a range"
      const who1 = await rectOf(tp, tid('v6-who-1'));
      await tp.touchscreen.tap(who1.cx, who1.cy);
      await tuntil(() => document.querySelector('.v6-kbd').classList.contains('picking'));
      await tev(() => document.getElementById('toasts')?.replaceChildren());
      await tp.waitForTimeout(300);
      await tp.screenshot({ path: path.join(SHOTS, 'u2-ipad-pick-1180.png') });
      await tp.keyboard.press('Escape');
    } finally {
      await tc.close();
    }
  });

  await T('U2 screenshot: 1280×800 Sanctuary, Sub Bass range being dragged', async () => {
    await ev(() => window.__rig.ctx.setView('perform'));
    await setSlots(3);
    await setRange(0, 0, 127);
    await setRange(1, 0, 127);
    await setRange(2, 36, 71);
    await ev(() => document.getElementById('toasts')?.replaceChildren());
    await page.waitForTimeout(200);
    const k = await keyRect(page, 59);
    await dragHandle(page, tid(`${KB}-hhi-2`), k.r, async () => {
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(SHOTS, 'u2-drag-1280.png') });
    });
    await rangeIs(2, 36, 59);
    await page.mouse.move(5, 5);
  });

  // ---------------------------------------------------------------- U3: the right sidebar (sidebar.tests.mjs)
  // D24.7 (lane-small): Settings › Keyboards & MIDI › "Esc always panics", per device; main.js listens only while on
  await T('D24.7 Esc always panics: on, Esc on the v6 Perform panics at once with a popover / the Quick sheet open '
    + '(and still closes it); Edit and Settings keep their Esc; off = today', async () => {
    await ev(() => window.__rig.ctx.setView('perform'));
    await until(() => document.body.dataset.view === 'perform');
    await ev(() => document.activeElement?.blur?.());
    // skeptic UI6-move F1: since D24.3 the U2 checks above leave a range pick open (pick first on a mouse too), and
    // the pick is an overlay that takes an Esc of its own: start from nothing open
    await ev(() => window.__rig.views.v6?.kb.pick(null));
    const held = () => ev(() => window.__rig.controller._debug().held.length);
    const sing = async () => {
      await page.click(tid('v6-key'));
      await until(() => !!document.querySelector('[data-testid="v6-sing"]'));
    };
    // off (absent): today's rule, Esc closes the popover first, the next Esc panics
    assert.equal(await ev(() => 'escPanics' in window.__rig.store.get().settings), false);
    await armPanics();
    await sing();
    await page.keyboard.press('Escape');
    await until(() => !document.querySelector('[data-testid="v6-sing"]'));
    assert.equal(await ev(() => window.__panics), 0);
    await ev(() => document.activeElement?.blur?.());
    await page.keyboard.press('Escape');
    await until(() => window.__panics === 1);
    // on: one Esc = a panic, and the popover still closes
    await ev(() => window.__rig.store.set('settings.escPanics', true));
    try {
      await armPanics();
      await sing();
      await ev(() => window.__rig.controller.perform.noteOn(62, 100));
      assert.equal(await held(), 1);
      await page.keyboard.press('Escape');
      await until(() => window.__panics === 1 && !document.querySelector('[data-testid="v6-sing"]'));
      assert.equal(await held(), 0, 'the held note is let go');
      // the Quick sheet open (non-modal; Esc closes it today without a panic)
      await page.click('#btn-quick');
      await until(() => window.__rig.views.perform.quickOpen === true);
      await page.keyboard.press('Escape');
      await until(() => window.__panics === 2 && window.__rig.views.perform.quickOpen === false);
      // a focused control: today the first Esc only lets go of it
      await page.focus(tid('v6-transpose-up'));
      await page.keyboard.press('Escape');
      await until(() => window.__panics === 3);
      // a held-down Esc (auto-repeat) is one panic
      await page.keyboard.down('Escape');
      await page.keyboard.down('Escape');
      await page.keyboard.up('Escape');
      await until(() => window.__panics === 4);
      await page.waitForTimeout(150);
      assert.equal(await ev(() => window.__panics), 4);
      // skeptic UI6-small F1: typing keeps its Esc (a text field, an IME composition), and so does a modal dialog on
      // Perform (the chart's dialog, typed into: U7b, on the v6 Perform the Edit chart dialog): it closes without a
      // panic, today's rule
      await ev(() => window.__rig.setChartView(true));
      await until(() => !!window.__rig.views.chart);
      await ev(() => window.__rig.views.chart.openEdit());
      await until(() => !!document.querySelector('[data-testid="v6-ce-text"]'));
      await page.focus(tid('v6-ce-text'));
      await page.keyboard.type('G C D');
      await ev(() => window.__rig.controller.perform.noteOn(62, 100));
      await page.keyboard.press('Escape');
      await until(() => !document.querySelector('[data-testid="v6-ce-text"]'));
      await page.waitForTimeout(100);
      assert.equal(await ev(() => window.__panics), 4, 'Add chart (a modal, typed into): Esc cancels, no panic');
      assert.equal(await held(), 1, 'the held note plays on');
      await ev(() => window.__rig.setChartView(false));
      const typing = await ev(() => {
        const i = document.createElement('input');
        document.querySelector('[data-testid="v6-perform"]').append(i);
        i.focus();
        i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true,
          isComposing: true }));
        const ime = window.__panics;
        i.focus(); // today's rule let go of the field on that Esc (main.js), as it does for any focused control
        i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        const text = window.__panics;
        i.remove();
        return { ime, text };
      });
      assert.deepEqual(typing, { ime: 4, text: 4 }, 'a text field / IME composition: no panic');
      await ev(() => window.__rig.controller.perform.noteOff(62));
      // Edit and Settings keep their Esc
      await ev(() => window.__rig.ctx.setView('edit'));
      await until(() => document.body.dataset.view === 'edit');
      await page.keyboard.press('Escape');
      await ev(() => window.__rig.ctx.setView('perform'));
      await until(() => document.body.dataset.view === 'perform');
      await ev(() => window.__rig.ctx.openSettings());
      await until(() => !document.getElementById('view-settings').hidden);
      await page.keyboard.press('Escape');
      await until(() => document.getElementById('view-settings').hidden);
      assert.equal(await ev(() => window.__panics), 4, 'no panic from Edit or Settings');
    } finally {
      // off again: today's rule is back
      await ev(() => window.__rig.store.set('settings.escPanics', null));
      await ev(() => window.__rig.ctx.setView('perform'));
    }
    await armPanics();
    await sing();
    await page.keyboard.press('Escape');
    await until(() => !document.querySelector('[data-testid="v6-sing"]'));
    await page.waitForTimeout(100);
    assert.equal(await ev(() => window.__panics), 0);
  });

  await sidebarTests({ T, page, browser, origin, ev, until, tid, song, settled, hold, setSlots, SHOTS, assert });

  // ---------------------------------------------------------------- U4: the left panel (left.tests.mjs)
  await leftTests({ T, page, browser, origin, ev, until, tid, song, settled, setSlots, SHOTS, assert });

  await T('skeptic UI6-small F4 (UI6-U1 O4): a flag flip keeps the Revert snapshot (unsaved changes stay changes)',
    async () => {
      await ev(() => window.__rig.ctx.setView('perform'));
      await settled();
      const sid = (await song()).id;
      const was = await ev(() => window.__rig.ctx.getBaseline().patch.fx.reverb.returnGain);
      const now = was > 0.5 ? 0.2 : 0.8;
      await ev(({ sid, now }) => window.__rig.store.set(`songs.${sid}.patch.fx.reverb.returnGain`, now), { sid, now });
      const probe = () => ev(() => ({ base: window.__rig.ctx.getBaseline().patch.fx.reverb.returnGain,
        changed: window.__rig.views.perform.changedPaths.length > 0, v6: !!window.__rig.views.v6 }));
      const start = await probe();
      try {
        for (const on of [!start.v6, start.v6]) {
          await ev((o) => window.__rig.setUiV6(o), on);
          assert.deepEqual(await probe(), { base: was, changed: true, v6: on },
            `after the flip to ${on ? 'v6' : 'today'}`);
        }
      } finally {
        await ev(({ sid, was }) => window.__rig.store.set(`songs.${sid}.patch.fx.reverb.returnGain`, was), { sid, was });
      }
    });

  // ---------------------------------------------------------------- U-MOVE + D24 tweaks (move.tests.mjs)
  await moveTests({ T, page, browser, origin, ev, until, tid, song, settled, hold, setSlots, SHOTS, assert, rectOf,
    keyRect, dragHandle, pickOn, setRange, armPanics, errors, KB });

  // ---------------------------------------------------------------- U7c (dialogs.tests.mjs)
  await dialogTests({ T, page, ev, until, tid, song, settled, hold, setSlots, SHOTS, assert, rectOf, armPanics });

  await T('on / off cycles: today’s Perform comes back whole; nothing of v6 is left behind', async () => {
    for (let k = 0; k < 3; k++) {
      assert.equal(await ev(() => window.__rig.setUiV6(false)), false);
      const off = await ev(() => ({
        today: !!document.querySelector('#view-perform > .perform'),
        dom: document.querySelectorAll('.v6, [data-testid^="v6-"]').length,
        css: !!document.querySelector('link[data-v6-css]'),
        flag: 'uiV6' in window.__rig.store.get().settings,
        listeners: window.__storeListeners.size,
        quick: typeof window.__rig.views.perform.toggleQuick,
      }));
      assert.deepEqual({ ...off, listeners: off.listeners === baseListeners }, {
        today: true, dom: 0, css: false, flag: false, listeners: true, quick: 'function',
      }, `cycle ${k}: ${off.listeners} store listeners vs ${baseListeners} at boot`);
      assert.equal(await ev(() => window.__rig.setUiV6(true)), true);
      await until(() => !!document.querySelector('[data-testid="v6-perform"]'));
    }
    // the top-bar Quick button opens the sheet in v6 too
    await page.click('#btn-quick');
    await until(() => window.__rig.views.perform.quickOpen === true);
    await page.click('#btn-quick');
    await until(() => window.__rig.views.perform.quickOpen === false);
  });

  // skeptic UI6-U1 F1 / F2 (native/docs/reviews/UI6-U1.md)
  await T('a Remove that shifts the slots: empty strips show no stale level / sends; open ⋯ menus close', async () => {
    await ev(() => window.__rig.ctx.setView('perform'));
    await ev(() => window.__rig.controller.scenes.go(null));
    assert.equal(await setSlots(4), 4);
    // slot 1 gets a loud, wet, octave-up sound; slot 2 is empty
    await ev(() => {
      const { store } = window.__rig;
      const id = store.currentSong().id;
      store.set(`songs.${id}.patch.slots.1.gain`, 0.9);
      store.set(`songs.${id}.patch.slots.1.sends.reverb`, 0.8);
      store.set(`songs.${id}.patch.slots.1.octave`, 1);
      store.set(`songs.${id}.patch.slots.2`, null);
    });
    await until(() => document.querySelector('[data-testid="v6-name-2"]')?.textContent === 'Empty');
    // F2: slot 3's ⋯ menu is open when slot 0 goes (Edit, a learned control, another window…)
    await page.click(tid('v6-more-3'));
    await until(() => !!document.querySelector('[data-testid="v6-menu-3"]'));
    await ev(() => {
      const { store } = window.__rig;
      store.removeSlot(store.currentSong().id, 0);
    });
    // F1: the old slot 1 is now 0 and the empty slot is now 1; strip 1 must not keep 0.9 / 80 % / +1
    await until(() => document.querySelector('[data-testid="v6-name-1"]')?.textContent === 'Empty');
    const r = await ev(() => {
      const s1 = document.querySelector('[data-testid="v6-strip-1"]');
      const val = s1.querySelector('.fader-value');
      return {
        menus: document.querySelectorAll('.v6-pop').length,
        fader: Number(s1.querySelector('input').value),
        valueShown: !!val && getComputedStyle(val).visibility !== 'hidden',
        chips: ['space', 'echo', 'octave'].map((c) => document.querySelector(`[data-testid="v6-${c}-1"]`)
          .classList.contains('on')),
        dots: s1.querySelectorAll('.cdi:not([hidden])').length,
      };
    });
    assert.deepEqual(r, { menus: 0, fader: r.fader, valueShown: false, chips: [false, false, false], dots: 0 });
    assert.ok(r.fader <= Number(await page.getAttribute('[data-testid="v6-fader-1"] input', 'min')) + 1e-9,
      `empty strip fader at ${r.fader}`);
  });

  // skeptic UI6-U1 F3: the Mac app's minimum window (main.js minWidth / minHeight 1024 × 700)
  await T('1024×700 with 4 and 7 instruments: the fader keeps a ≥ 100 px track clear of its dB readout', async () => {
    await page.setViewportSize({ width: 1024, height: 700 });
    try {
      for (const n of [4, 7]) {
        assert.equal(await setSlots(n), n);
        await until((k) => document.querySelectorAll('.v6-strip:not([hidden])').length === k, n);
        await page.waitForTimeout(300);
        const r = await ev(() => {
          const s = document.querySelector('[data-testid="v6-strip-0"]');
          const box = (sel) => s.querySelector(sel).getBoundingClientRect();
          const tr = box('.fader-track');
          const inp = box('.fader-track input');
          const val = box('.fader-value');
          const btn = box('.v6-btns').bottom <= s.getBoundingClientRect().bottom + 0.5;
          return { track: Math.round(tr.height), clear: inp.bottom <= val.top + 0.5, buttonsInside: btn };
        });
        assert.ok(r.track >= 100 && r.clear && r.buttonsInside, `${n} instruments: ${JSON.stringify(r)}`);
      }
    } finally {
      await page.setViewportSize({ width: 1280, height: 800 });
    }
  });

  await T('screenshots: 1280×800 Sanctuary, 2 / 5 / 7 instruments', async () => {
    await ev(() => window.__rig.ctx.setView('perform'));
    // the factory song as shipped (the tests above changed its levels, chips, room and scenes)
    await ev(() => {
      const { store, controller } = window.__rig;
      controller.scenes.go(null);
      store.resetToFactory(store.currentSong().id);
    });
    for (const n of [2, 5, 7]) {
      await setSlots(n);
      await until((k) => document.querySelectorAll('.v6-strip:not([hidden])').length === k, n);
      await ev(() => document.getElementById('toasts')?.replaceChildren());
      await ev(() => document.activeElement?.blur?.());
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOTS, `perform-v6-${n}.png`) });
    }
    // 44 px targets on the stage (the range bars are display only)
    const small = await ev(() => [...document.querySelectorAll('.v6 button')].filter((b) => b.offsetParent
      && !b.closest('.v6-pop'))
      .map((b) => [b.dataset.testid || b.textContent.trim(), b.getBoundingClientRect()])
      .filter(([, r]) => r.width < 43.5 || r.height < 43.5).map(([n, r]) => `${n} ${r.width}x${r.height}`));
    assert.deepEqual(small, []);
  });

  await T('zero console.error, no HTTP ≥ 400', async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  await context.close();
  await browser.close();
  await server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nui-v6: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
