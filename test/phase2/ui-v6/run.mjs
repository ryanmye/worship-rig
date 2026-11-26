#!/usr/bin/env node
// UI v6 suite (D22; native/docs/lanes/UI6-build-plan.md U1; app/js/views/v6/). The real app (app/index.html) in
// Chromium:
//   flag off → today's Perform, nothing of v6 fetched or drawn; flag-off purity against the base build (the app before
//   U1: requests, window / document listeners, intervals, store listeners, DOM, stylesheets; the chart-view review's
//   probe, native/docs/reviews/chart-view.md); flag on (?ui6=1 / __rig.setUiV6) → the v6 Perform: strip controls write
//   the right store paths, ⋯ menu, Add instrument, > 5 instruments scroll with name pills, snapshots (save, edited,
//   Update, fold remembered), song bar (transpose, Sing it in, Space, Setlist cue + GO), Lock / PANIC / Revert holds,
//   on / off cycles leave nothing behind; zero console.error and no HTTP ≥ 400.
//   node test/phase2/ui-v6/run.mjs   (screenshots: 1280×800 Sanctuary, 2 / 5 / 7 instruments → ./screenshots, or
//   UI6_SHOTS=<dir>). The purity comparison needs git: base = UI6_PURITY_BASE or `git merge-base HEAD v2-native`; it is
//   skipped (with a note) when app/ does not differ from the base.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
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
const SHOTS = process.env.UI6_SHOTS ? path.resolve(process.env.UI6_SHOTS) : path.join(HERE, 'screenshots');
const { createServer } = require(path.join(ROOT, 'server.js'));
const VERBOSE = !!process.env.VERBOSE;
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const T = async (name, fn) => {
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
        // toasts come and go on their own clock (MIDI / wake-lock notes), so they are left out
        dom: [...document.body.querySelectorAll('*')].filter((e) => !e.closest('#toasts > *')).map(shape).join('\n'),
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
        // the only intended difference: __rig.setUiV6 (and the views.v6 getter)
        assert.deepEqual(b.rig.filter((k) => !a.rig.includes(k)), ['setUiV6']);
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

  await T('Change opens Edit’s instrument picker on that slot; ⋯ Earlier / Later are disabled (coming)', async () => {
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
    assert.deepEqual({ ...r, title: /^Coming/.test(r.title) },
      { earlier: true, later: true, title: true, role: 'dialog' });
    // Esc closes the menu without a panic
    await armPanics();
    await page.keyboard.press('Escape');
    await until(() => !document.querySelector('[data-testid="v6-menu-0"]'));
    assert.equal(await ev(() => window.__panics), 0);
  });

  await T('⋯ Duplicate appends a copy; Remove needs a hold; Open in Edit; + Add instrument → Edit picker', async () => {
    const n0 = (await song()).patch.slots.length;
    await page.click(tid('v6-more-0'));
    await page.click(tid('v6-dup-0'));
    await until((n) => window.__rig.store.currentSong().patch.slots.length === n + 1, n0);
    const s = await song();
    assert.deepEqual(s.patch.slots[n0].instrument, s.patch.slots[0].instrument);
    await until((n) => document.querySelectorAll('.v6-strip:not([hidden])').length === n + 1, n0);
    // Remove: a short press does nothing, a hold removes
    await page.click(tid(`v6-more-${n0}`));
    await page.click(tid(`v6-remove-${n0}`));
    await page.waitForTimeout(200);
    assert.equal((await song()).patch.slots.length, n0 + 1, 'a tap does not remove');
    if (!(await page.$(tid(`v6-menu-${n0}`)))) await page.click(tid(`v6-more-${n0}`));
    await hold(tid(`v6-remove-${n0}`));
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
    assert.equal(await ev(() => document.querySelector('[data-testid="v6-pills"]').hidden), true);
  });

  await T('snapshots: + Save, chips play, edited · Update · Save as new, Own levels', async () => {
    await setSlots(2);
    // a clean song state: no scenes yet
    await ev(() => window.__rig.store.set(`songs.${window.__rig.store.currentSong().id}.scenes`, []));
    await until(() => document.querySelectorAll('[data-testid^="v6-snap-"][data-n]').length === 0);
    await page.click(tid('v6-snap-save'));
    await until(() => (window.__rig.store.currentSong().scenes || []).length === 1);
    await until(() => document.querySelector('[data-testid="v6-snap-1"]')?.classList.contains('plate'));
    assert.equal(await page.textContent(tid('v6-snap-1')), 'Scene 1');
    assert.equal(await ev(() => document.querySelector('[data-testid="v6-snap-dirty"]').hidden), true);
    // a level move while the scene plays → "edited"
    await page.click(tid('v6-on-0'));
    await until(() => !document.querySelector('[data-testid="v6-snap-dirty"]').hidden);
    // Update saves it into scene 1; the line goes
    await page.click(tid('v6-snap-update'));
    await until(() => document.querySelector('[data-testid="v6-snap-dirty"]').hidden);
    assert.equal((await song()).scenes[0].slots[0].muted, true);
    // edit again → Save as new = scene 2
    await page.click(tid('v6-on-0'));
    await until(() => !document.querySelector('[data-testid="v6-snap-dirty"]').hidden);
    await page.click(tid('v6-snap-new'));
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
    // Notes
    await page.click(tid('v6-notes'));
    await until(() => !!document.querySelector('[data-testid="v6-notes-pop"]'));
    await page.click(tid('v6-notes'));
    await until(() => !document.querySelector('[data-testid="v6-notes-pop"]'));
    // Setlist: tap the next entry = cue; GO plays it
    const first = s0.id;
    await page.click(tid('v6-setlist'));
    await until(() => !!document.querySelector('[data-testid="v6-setlist-pop"]'));
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

  await T('Revert, PANIC and Lock need a hold; Lock freezes Change / Add / Remove', async () => {
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
    // PANIC: a tap does nothing, a hold panics
    await armPanics();
    await page.click(tid('v6-panic'));
    await page.waitForTimeout(150);
    assert.equal(await ev(() => window.__panics), 0);
    await hold(tid('v6-panic'));
    await until(() => window.__panics === 1);
    // Lock: hold to lock
    await page.click(tid('v6-lock'));
    await page.waitForTimeout(150);
    assert.equal(await ev(() => !!window.__rig.store.get().settings.performLock), false, 'a tap does not lock');
    await hold(tid('v6-lock'));
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
