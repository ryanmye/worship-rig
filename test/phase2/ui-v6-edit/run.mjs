#!/usr/bin/env node
// UI v6 Edit suite (U5a; native DECISIONS D15, D18; native/docs/lanes/UI6-build-plan.md U5; app/js/views/v6/edit/).
// The real app (app/index.html) in Chromium:
//   flag off → today's Edit (views/edit/shell.js), nothing of views/v6/edit fetched, drawn or linked; flag-off purity
//   against the base build (the ui-v6 suite's probe: requests, listeners, intervals, store listeners, DOM, CSS);
//   flag on → the v6 Edit: same external interface (setView('edit', {block, focus}) → editState.select), library /
//   header / rig tabs by instrument name / Drone · Effects · Master in the v6 frame, the instrument panel's category
//   list (switching, per-device persistence, summaries, changed dots incl. Range), every category writes today's
//   slot-panel paths (data-bind union compared with today's slot panel + real writes), the Range keyboard drag,
//   Set lowest by playing, the Change instrument menu, Tone EQ mount / destroy without leaks, library fold, iPad
//   portrait (tabs row, no strip, drawer), flag flips both ways, screenshots, zero console.error / HTTP ≥ 400.
//   node test/phase2/ui-v6-edit/run.mjs   (screenshots → /home/claude/design-out/u5 when it exists, else
//   ./screenshots; UI6E_SHOTS=<dir> overrides; UI6E_ONLY=<regex> runs a subset)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { MIDI_PERMISSIONS, waitRigReady, pinTheme } from '../../integration/lib.mjs';
import { u5bTests } from './u5b.tests.mjs';
import { skepticU5bTests } from './skeptic-u5b.tests.mjs';
import { polish1EditTests } from './polish1.tests.mjs';
import { editRangeTests } from './editrange.tests.mjs';
import { polish2EditTests } from './polish2.tests.mjs';
import { snaplineEditTests } from './snapline.tests.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const APP = path.join(ROOT, 'app');
const DESIGN_OUT = '/home/claude/design-out/u5';
const SHOTS = process.env.UI6E_SHOTS ? path.resolve(process.env.UI6E_SHOTS)
  : fs.existsSync(DESIGN_OUT) ? DESIGN_OUT : path.join(HERE, 'screenshots');
const { createServer } = require(path.join(ROOT, 'server.js'));
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const ONLY = process.env.UI6E_ONLY ? new RegExp(process.env.UI6E_ONLY) : null;
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

// ---- the ui-v6 suite's purity probes (listener / interval counts, store listeners)
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

async function purityBoot(base, q = '') {
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
    await page.goto(`${base}/${q}`);
    await waitRigReady(page, { timeout: 40000 });
    await page.waitForFunction(() => !!window.__rig.views.settings && !!window.__rig.views.edit, null,
      { timeout: 30000, polling: 100 });
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => {
      const shape = (el) => {
        const tid = el.getAttribute('data-testid');
        const id = el.id.replace(/-[a-z0-9]{6}$/, '-*').replace(/\d+/g, '#');
        return `${el.tagName.toLowerCase()}${id ? `#${id}` : ''}${tid ? `[${tid}]` : ''}`;
      };
      return {
        ael: window.__probe.ael,
        intervals: window.__probe.intervals,
        store: window.__storeListeners ? window.__storeListeners.size : null,
        // C-SHIP: the "Chord charts" row (a Settings row added on purpose, like the two before it) is left out, and
        // the Chart toggle is counted apart (`chart`)
        dom: [...document.body.querySelectorAll('*')].filter((e) => !e.closest('#toasts > *')
          && !e.closest('[data-testid="setting-row-esc-panics"], [data-testid="setting-row-ui-v6"], '
            + '[data-testid="setting-row-cvd"], ' // U-CVD (D32): the third intended Settings row
            + '[data-testid="setting-row-chart-view"], [data-testid="chart-toggle"]'))
          .map(shape).join('\n'),
        chart: [...document.querySelectorAll('[data-testid="chart-toggle"], [class*="chv-"], #perform-chart')]
          .map((e) => e.dataset.testid || e.id || e.className),
        edit: [...document.querySelectorAll('#view-edit *')].map(shape).join('\n'),
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
const v6EditFetches = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url || '?'}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('request', (r) => {
  if (/\/js\/views\/v6\/edit\/|styles-v6-edit\.css/.test(r.url())) v6EditFetches.push(r.url());
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
const INSTRUMENTS = [['sampler', 'salamander-piano'], ['synth', 'warm-pad'], ['synth', 'sub-bass']];
const setSlots = (n) => ev(({ n, list }) => {
  const { store } = window.__rig;
  const id = store.currentSong().id;
  while (store.currentSong().patch.slots.length < n) store.addSlot(id);
  while (store.currentSong().patch.slots.length > n) store.removeSlot(id);
  list.slice(0, n).forEach(([type, iid], i) => {
    const ref = { type, id: iid };
    if (store.currentSong().patch.slots[i]) store.set(`songs.${id}.patch.slots.${i}.instrument`, ref);
    else store.set(`songs.${id}.patch.slots.${i}`, { instrument: ref });
  });
  return store.currentSong().patch.slots.length;
}, { n, list: INSTRUMENTS });
const inst = () => '__rig.views.edit._debug.instance()';
const toEdit = async () => {
  await ev(() => window.__rig.ctx.setView('edit'));
  await until(() => document.body.dataset.view === 'edit');
};
const choose = async (cat) => {
  await page.click(tid(`v6e-cat-${cat}`));
  await until((c) => document.querySelector('[data-testid="v6e-ccont"]')?.dataset.cat === c, cat);
};
/**
 * U5b: in the open instrument chooser, show the kind that holds `value` ('type:id') and click its tile (null: the
 * first tile that is not `not`). Returns the value clicked.
 */
const chooserPick = (value, not) => ev(({ v, n }) => {
  const dlg = document.querySelector('[data-testid="v6e-chooser"]');
  for (const c of dlg.querySelectorAll('.v6e-ch-cat:not([disabled])')) {
    c.click();
    const tiles = [...document.querySelectorAll('[data-testid="v6e-chooser"] .v6e-ch-tile')];
    const t = v ? tiles.find((x) => x.dataset.value === v) : tiles.find((x) => x.dataset.value !== n);
    if (t) {
      t.click();
      return t.dataset.value;
    }
  }
  return null;
}, { v: value || null, n: not || null });
/** Open the chooser on the shown instrument, pick `value` (or any other sound) and press Use. */
async function changeInstrument(value, not) {
  await page.click(tid('v6e-change'));
  await until(() => !!document.querySelector('[data-testid="v6e-chooser"]'));
  const v = await chooserPick(value, not);
  await page.click(tid('v6e-ch-use'));
  await until(() => !document.querySelector('[data-testid="v6e-chooser"]'));
  return v;
}
/** The store writes a function causes, as song-relative paths (store.set wrapped for the duration). */
async function writesOf(fn) {
  await ev(() => {
    const { store } = window.__rig;
    window.__writes = [];
    if (!store.__wrapped) {
      const orig = store.set.bind(store);
      store.set = (p, v) => {
        window.__writes?.push(p);
        return orig(p, v);
      };
      store.__wrapped = true;
    }
  });
  await fn();
  await page.waitForTimeout(100);
  return ev(() => window.__writes.map((p) => p.replace(/^songs\.[^.]+\.patch\./, '').replace(/^songs\.[^.]+\./, '')));
}
const rectOf = (sel) => ev((s) => {
  const r = document.querySelector(s).getBoundingClientRect();
  return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2,
    cy: r.top + r.height / 2 };
}, sel);

let todayBinds = [];
/** U5b: today's Drone / Effects / Master panels' bound addresses (flag off), the reference for the v6 panels. */
const todayShared = {};
let baseListeners = 0;
try {
  await T('flag off: today’s Edit; nothing of the v6 Edit fetched, drawn or linked', async () => {
    await page.goto(`${origin}/`);
    await waitRigReady(page, { timeout: 40000 });
    const overlay = await page.$('#overlay-start:not([hidden])');
    if (overlay) await overlay.click();
    await settled();
    await until(() => !!window.__rig.views.settings && !!window.__rig.views.edit, null, 20000);
    const r = await ev(() => ({
      flag: 'uiV6' in window.__rig.store.get().settings,
      today: !!document.querySelector('#view-edit > .ev2:not(.v6-edit)'),
      v6: document.querySelectorAll('.v6-edit, [data-testid^="v6e-"]').length,
      css: !!document.querySelector('link[data-v6-edit-css], link[href*="styles-v6-edit"]'),
      debugV6: !!window.__rig.views.edit._debug.v6,
    }));
    assert.deepEqual(r, { flag: false, today: true, v6: 0, css: false, debugV6: false });
    assert.deepEqual(v6EditFetches, []);
    // today's slot panel's bound controls for slot 0 (Advanced open), the reference for "same paths"
    await setSlots(3);
    await toEdit();
    await ev(() => window.__rig.views.edit.editState.select('slot:0'));
    await until(() => !!document.querySelector('#view-edit [data-sec="slot0-adv"]'));
    await ev(() => {
      document.querySelector('#view-edit [data-sec="slot0-adv"]').open = true;
    });
    await page.waitForTimeout(300);
    todayBinds = await ev(() => [...new Set([...document.querySelectorAll('#ev2-panel [data-bind^="slots.0."]')]
      .map((e) => e.dataset.bind))].sort());
    await ev(() => {
      document.querySelector('#view-edit [data-sec="slot0-adv"]').open = false;
      window.__rig.ctx.setView('perform');
    });
    assert.ok(todayBinds.length >= 15, todayBinds.join());
    for (const b of ['drone', 'effects', 'master']) {
      await ev((id) => window.__rig.views.edit.editState.select(id), b);
      await until((id) => !!document.querySelector(`#view-edit [data-panel="${id}"] [data-bind]`), b);
      todayShared[b] = await ev(() => [...new Set([...document.querySelectorAll('#ev2-panel [data-bind]')]
        .map((e) => e.dataset.bind))].sort());
    }
    await ev(() => window.__rig.views.edit.editState.select('slot:0'));
    baseListeners = await ev(() => window.__storeListeners.size);
  });

  await T('flag-off purity vs the base build: requests, listeners, intervals, store listeners, DOM (Edit too), CSS',
    async () => {
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
      }
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui6e-base-'));
      try {
        const tar = path.join(tmp, 'app.tar');
        execFileSync('git', ['archive', '-o', tar, base, 'app', ':(exclude)app/samples'], { cwd: ROOT });
        execFileSync('tar', ['-xf', tar, '-C', tmp]);
        fs.symlinkSync(path.join(APP, 'samples'), path.join(tmp, 'app', 'samples'));
        const baseServer = createServer({ appDir: path.join(tmp, 'app'), port: 0 });
        const bi = await baseServer.listen();
        try {
          // C-SHIP (D33): charts off is an explicit false (?chart=0, a no-op on a base that predates C-SHIP);
          // charts on (nothing stored, no charts) differs only by the Chart toggle on Perform
          const a = await purityBoot(`http://127.0.0.1:${bi.port}`, '?chart=0');
          for (const [b, what] of [[await purityBoot(origin, '?chart=0'), 'charts off'],
            [await purityBoot(origin), 'charts on, no charts']]) {
            assert.deepEqual(b.reqs, a.reqs, `${what}: non-sample requests`);
            assert.deepEqual(b.ael, a.ael, `${what}: window / document addEventListener calls by type`);
            assert.equal(b.intervals, a.intervals, `${what}: setInterval calls`);
            assert.equal(b.store, a.store, `${what}: store listeners`);
            assert.deepEqual(b.css, a.css, `${what}: stylesheets`);
            assert.equal(b.edit, a.edit, `${what}: today’s Edit DOM shape`);
            assert.equal(b.dom, a.dom, `${what}: DOM shape`);
            assert.deepEqual(b.rig, a.rig, `${what}: __rig keys`);
            assert.deepEqual(b.chart, what === 'charts off' ? [] : ['chart-toggle'], `${what}: chart DOM`);
          }
          assert.deepEqual(a.chart, [], 'the base, charts off');
          console.log(`      base ${base.slice(0, 8)} (?chart=0): ${a.reqs.length} requests, ${a.store} store `
            + 'listeners, '
            + `${a.intervals} intervals, ${a.dom.split('\n').length} elements (${a.edit.split('\n').length} in Edit)`
            + ' — identical with charts off; charts on, no charts: identical + the Chart toggle');
        } finally {
          await baseServer.close();
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

  await T('?ui6=1 mounts the v6 Edit (CSS linked once): library, header, rig tabs by instrument, panel, keys',
    async () => {
      await page.goto(`${origin}/?ui6=1`);
      await waitRigReady(page, { timeout: 40000 });
      await until(() => !!window.__rig.views.v6 && !!window.__rig.views.edit?._debug?.v6, null, 30000);
      await settled();
      await setSlots(3);
      await toEdit();
      await until(() => document.querySelectorAll('.v6e-rt[data-block^="slot:"]').length === 3);
      const r = await ev(() => ({
        root: !!document.querySelector('#view-edit > .v6.v6-edit[data-testid="v6-edit"]'),
        css: document.querySelectorAll('link[data-v6-edit-css]').length,
        v6css: document.querySelectorAll('link[data-v6-css]').length,
        mounted: window.__rig.views.edit._debug.mounted(),
        parts: ['v6e-lib', 'v6e-head', 'v6e-rig', 'v6e-panel', 'v6e-inst', 'v6e-cnav', 'v6e-stage', 'v6e-bank',
          'v6e-timesig'].filter((t) => !document.querySelector(`[data-testid="${t}"]`)),
        tabs: [...document.querySelectorAll('.v6e-rt[data-block]')].map((t) => t.dataset.block),
        names: [...document.querySelectorAll('.v6e-rt[data-block^="slot:"] .v6e-rt-name')].map((x) => x.textContent),
        colors: [...document.querySelectorAll('.v6e-rt[data-block^="slot:"]')]
          .map((t) => t.style.getPropertyValue('--c')),
        db: document.querySelector('.v6e-rt[data-block="slot:0"] .v6e-rt-sub').textContent,
        sent: document.querySelector('[data-testid="v6e-sentence"] .ev2-tok')?.textContent,
        strip: !!document.querySelector('[data-testid="v6e-stage"] .v6-strip[data-testid="v6-strip-0"]'),
        // D15: no Keys / Pad / Extra / Bass label anywhere (instrument names such as "Warm Pad" are fine)
        roles: document.querySelector('[data-testid="v6-edit"]').innerText.split(/\n|\t/)
          .some((l) => /^(keys|pad|extra|bass)$/i.test(l.trim())),
        selected: window.__rig.views.edit.editState.selected,
      }));
      const s = await song();
      assert.deepEqual(r, {
        root: true, css: 1, v6css: 1, mounted: ['setlist', 'song-header', 'bottom', 'slot'], parts: [],
        tabs: ['slot:0', 'slot:1', 'slot:2', 'drone', 'effects', 'master'],
        names: ['Grand Piano', 'Warm Pad', 'Sub Bass'].map((x, k) => r.names[k]), // checked below
        colors: ['var(--slot-0)', 'var(--slot-1)', 'var(--slot-2)'], db: r.db, sent: r.names[0], strip: true,
        roles: false, selected: 'slot:0',
      });
      assert.ok(r.names.every((n) => n && !/^(Keys|Pad|Extra|Bass)$/i.test(n)), r.names.join());
      assert.match(r.db, /dB$/);
      assert.equal(s.patch.slots.length, 3);
      assert.ok(v6EditFetches.some((u) => u.endsWith('/styles-v6-edit.css')));
    });

  await T('C-SHIP (D33): the header’s Chart button shows by default and opens the chart on Perform; hidden when off',
    async () => {
      await toEdit();
      assert.equal(await ev(() => window.__rig.views.chart), null, 'not loaded before it is used');
      assert.equal(await page.isVisible(tid('v6e-chart')), true);
      await page.click(tid('v6e-chart'));
      await until(() => document.body.dataset.view === 'perform' && !!window.__rig.views.chart?.state()?.onStage,
        null, 20000);
      await ev(() => window.__rig.views.chart.closeStage());
      await until(() => !document.querySelector('.v6-chstage'));
      await toEdit();
      await ev(() => window.__rig.store.set('settings.chartView', false));
      await until(() => !document.querySelector('[data-testid="v6e-chart"]')?.checkVisibility?.());
      assert.equal(await page.isVisible(tid('v6e-chart')), false);
      assert.equal(await ev(() => window.__rig.views.chart), null, 'off: the chart goes');
      await ev(() => window.__rig.store.set('settings.chartView', null));
      await until(() => !!document.querySelector('[data-testid="v6e-chart"]')?.checkVisibility?.());
      await ev(() => window.__rig.ctx.setView('perform'));
      await until(() => document.body.dataset.view === 'perform');
    });

  await T('external interface: setView(edit, {block, focus}) selects; Drone / Effects / Master (U5b: category '
    + 'panels) and Song mount in the v6 frame; Perform’s Change opens the chooser', async () => {
    await ev(() => window.__rig.ctx.setView('edit', { block: 'slot:1', focus: 'instrument' }));
    await until(() => window.__rig.views.edit.editState.selected === 'slot:1'
      && !!document.querySelector('[data-testid="v6e-chooser"]'));
    assert.equal(await ev(() => document.activeElement?.closest('[data-testid="v6e-chooser"]') !== null), true);
    await page.keyboard.press('Escape');
    await until(() => !document.querySelector('[data-testid="v6e-chooser"]'));
    for (const id of ['drone', 'effects', 'master', 'song']) {
      await ev((b) => window.__rig.views.edit.editState.select(b), id);
      const want = id;
      await until((b) => (b === 'song' ? document.querySelector(`.v6e-legacy [data-panel="${b}"]`)
        : document.querySelector(`.v6e-host[data-panel="${b}"] [data-testid="v6e-${b}"]`)), want);
      const tabOn = await ev((b) => document.querySelector(`.v6e-rt[data-block="${b}"]`)?.classList.contains('on')
        ?? null, id);
      assert.equal(tabOn, id === 'song' ? null : true, id);
    }
    // the header's KEY chip opens today's song panel (focus key), Notes the notes
    await page.click('.v6e-head .ev2-song-keychip');
    await until(() => window.__rig.views.edit.editState.selected === 'song');
    await page.click(tid('v6e-tab-slot-0'));
    await until(() => !!document.querySelector('[data-testid="v6e-inst"][data-slot="0"]'));
    // Perform's strip Change → Edit picker on that slot
    await ev(() => window.__rig.ctx.setView('perform'));
    await until(() => document.body.dataset.view === 'perform');
    await page.click(tid('v6-change-2'));
    await until(() => document.body.dataset.view === 'edit' && window.__rig.views.edit.editState.selected === 'slot:2'
      && !!document.querySelector('[data-testid="v6e-chooser"]'));
    await page.keyboard.press('Escape');
    await until(() => !document.querySelector('[data-testid="v6e-chooser"]'));
    await ev(() => window.__rig.views.edit.editState.select('slot:0'));
  });

  await T('category list: switching, aria, summaries, per-device persistence (focus jumps are not remembered)',
    async () => {
      await ev(() => localStorage.removeItem('worship-rig.v6.edit'));
      for (const c of ['sound', 'eq', 'range', 'touch', 'sustain', 'sends', 'adv']) {
        await choose(c);
        const r = await ev((x) => ({
          sel: document.querySelector(`[data-testid="v6e-cat-${x}"]`).getAttribute('aria-selected'),
          others: [...document.querySelectorAll('.v6e-cn[aria-selected="true"]')].length,
          saved: JSON.parse(localStorage.getItem('worship-rig.v6.edit') || '{}').cat,
          sum: document.querySelector(`[data-testid="v6e-cat-${x}"] small`).textContent,
        }), c);
        assert.deepEqual({ ...r, sum: !!r.sum }, { sel: 'true', others: 1, saved: c, sum: true }, c);
      }
      // summaries say the state
      await ev(() => {
        const { store } = window.__rig;
        const id = store.currentSong().id;
        store.set(`songs.${id}.patch.slots.0.velocityCurve`, 'hard');
        store.set(`songs.${id}.patch.slots.0.lowNote`, 48);
        store.set(`songs.${id}.patch.slots.0.highNote`, 72);
      });
      await until(() => document.querySelector('[data-testid="v6e-cat-touch"] small').textContent === 'Heavy'
        && document.querySelector('[data-testid="v6e-cat-range"] small').textContent.startsWith('C3–C5'));
      // ↓ moves through the list
      await page.focus(tid('v6e-cat-adv'));
      await page.keyboard.press('Home');
      await until(() => document.querySelector('[data-testid="v6e-ccont"]').dataset.cat === 'sound');
      // remembered after a reload
      await choose('sustain');
      await page.reload();
      await waitRigReady(page, { timeout: 40000 });
      await until(() => !!window.__rig.views.edit?._debug?.v6, null, 30000);
      await toEdit();
      await until(() => document.querySelector('[data-testid="v6e-ccont"]')?.dataset.cat === 'sustain');
      // a sentence word jumps (range) without changing the remembered category
      await page.click('[data-testid="v6e-sentence"] .ev2-tok >> nth=1');
      await until(() => document.querySelector('[data-testid="v6e-ccont"]').dataset.cat === 'range');
      assert.equal(await ev(() => JSON.parse(localStorage.getItem('worship-rig.v6.edit')).cat), 'sustain');
    });

  await T('every category writes today’s slot-panel paths (data-bind union ⊇ today’s; real writes)', async () => {
    const v6Binds = new Set();
    for (const c of ['sound', 'eq', 'range', 'touch', 'sustain', 'sends', 'adv']) {
      await choose(c);
      for (const b of await ev(() => [...document.querySelectorAll('[data-testid="v6e-inst"] [data-bind^="slots.0."]')]
        .map((e) => e.dataset.bind))) v6Binds.add(b);
    }
    // the strip carries the level / ON (not data-bound), and the range is the 88-key bar instead of the mini keyboard
    const expected = todayBinds.filter((b) => !['slots.0.muted', 'slots.0.gain', 'slots.0.split'].includes(b));
    const missing = expected.filter((b) => !v6Binds.has(b));
    assert.deepEqual(missing, [], `today binds ${todayBinds.join()} · v6 ${[...v6Binds].join()}`);
    // real writes: one control per category
    await choose('sound');
    let w = await writesOf(() => ev(() => {
      const inp = document.querySelector('[data-smart="warmth"] input');
      inp.value = '800';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }));
    assert.ok(w.length && w.every((p) => /^slots\.0\.eq\./.test(p)), `warmth → ${w}`);
    await choose('touch');
    w = await writesOf(() => page.click('[data-testid="v6e-ccont"] .segmented button >> text=Fixed'));
    assert.deepEqual(w, ['slots.0.velocityCurve']);
    await choose('sustain');
    w = await writesOf(() => page.click('[data-testid="v6e-ccont"] [data-bind="slots.0.sustain"]'));
    assert.deepEqual(w, ['slots.0.sustain']);
    w = await writesOf(() => ev(() => {
      const inp = document.querySelector('[data-bind="slots.0.release"] input');
      inp.value = '300';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }));
    assert.deepEqual(w, ['slots.0.release']);
    await choose('sends');
    w = await writesOf(() => ev(() => {
      const inp = document.querySelector('[data-bind="slots.0.sends.reverb"] input');
      inp.value = '700';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }));
    assert.deepEqual(w, ['slots.0.sends.reverb']);
    await choose('range');
    w = await writesOf(() => page.click(tid('v6e-whole')));
    assert.deepEqual(w, ['slots.0.lowNote', 'slots.0.highNote']);
    w = await writesOf(() => page.click('[data-bind="slots.0.octave"] .step-btn.inc'));
    assert.deepEqual(w, ['slots.0.octave']);
    w = await writesOf(async () => {
      await page.fill(tid('v6e-lowNote'), 'C3');
      await page.press(tid('v6e-lowNote'), 'Enter');
    });
    assert.deepEqual(w, ['patch.slots.0.lowNote'.replace('patch.', '')]);
    await choose('adv');
    w = await writesOf(() => page.click('[data-bind="slots.0.transpose"] .step-btn.inc'));
    assert.deepEqual(w, ['slots.0.transpose']);
    w = await writesOf(() => page.click('[data-bind="slots.0.bendEnabled"]'));
    assert.deepEqual(w, ['slots.0.bendEnabled']);
    const s = await song();
    assert.deepEqual([s.patch.slots[0].velocityCurve, s.patch.slots[0].lowNote, s.patch.slots[0].octave,
      s.patch.slots[0].transpose], ['fixed', 48, 1, 1]);
  });

  await T('changed dots: Range (lowNote / highNote / octave), Space & Echo, Sustain; tab dot; Revert clears',
    async () => {
    await ev(() => {
      const { store } = window.__rig;
      window.__rig.ctx.setView('perform');
      store.resetToFactory(store.currentSong().id);
    });
    await setSlots(3);
    // a fresh baseline: v6 Perform takes the Revert snapshot when the view comes back from Edit
    await ev(() => window.__rig.ctx.setView('edit'));
    await ev(() => window.__rig.ctx.setView('perform'));
    await toEdit();
    await ev(() => window.__rig.views.edit.editState.select('slot:0'));
    const dots = () => ev(() => Object.fromEntries([...document.querySelectorAll('.v6e-cn')]
      .map((b) => [b.dataset.cat, !b.querySelector('.v6e-cd').hidden])));
    const tabDot = () => ev(() => !document.querySelector('.v6e-rt[data-block="slot:0"] .v6e-rt-cd').hidden);
    await until(() => [...document.querySelectorAll('.v6e-cn .v6e-cd')].every((d) => d.hidden));
    assert.equal(await tabDot(), false);
    await ev(() => {
      const { store } = window.__rig;
      store.set(`songs.${store.currentSong().id}.patch.slots.0.lowNote`, 40);
    });
    await until(() => !document.querySelector('[data-testid="v6e-cat-range"] .v6e-cd').hidden);
    assert.deepEqual(await dots(), { sound: false, eq: false, range: true, touch: false, sustain: false,
      sends: false, adv: false });
    assert.equal(await tabDot(), true);
    await ev(() => {
      const { store } = window.__rig;
      const id = store.currentSong().id;
      store.set(`songs.${id}.patch.slots.0.sends.delay`, 0.6);
      store.set(`songs.${id}.patch.slots.0.sustain`, false);
    });
    await until(() => !document.querySelector('[data-testid="v6e-cat-sends"] .v6e-cd').hidden
      && !document.querySelector('[data-testid="v6e-cat-sustain"] .v6e-cd').hidden);
    // the Range bar carries the dot too (keyboard.js `changed`)
    await choose('range');
    assert.equal(await ev(() => document.querySelector('[data-testid="v6e-range-kbd-bar-0"]')
      .classList.contains('changed')), true);
    // Revert (v6 Perform's) restores the song: every dot goes
    await ev(() => window.__rig.ctx.setView('perform'));
    await until(() => document.body.dataset.view === 'perform');
    // revert through the store as the v6 Revert does (SAVED_FIELDS), whatever its button gesture
    await ev(() => {
      const { store, ctx } = window.__rig;
      const base = ctx.getBaseline();
      store.set(`songs.${base.id}.patch`, base.patch);
    });
    await toEdit();
    await until(() => [...document.querySelectorAll('.v6e-cn .v6e-cd')].every((d) => d.hidden)
      && document.querySelector('.v6e-rt[data-block="slot:0"] .v6e-rt-cd').hidden);
  });

  await T('Range: the 88-key bar drag writes lowNote in Edit (only that end, live, final value as dragged); Set '
    + 'highest by playing; Esc',
    async () => {
    await choose('range');
    await ev(() => {
      const { store } = window.__rig;
      const id = store.currentSong().id;
      store.set(`songs.${id}.patch.slots.0.lowNote`, 36);
      store.set(`songs.${id}.patch.slots.0.highNote`, 84);
    });
    await until(() => document.querySelectorAll('.v6-kbd-range .pkey.out').length === 88 - 49);
    const k = await rectOf('.v6-kbd-range .pkey[data-note="48"]');
    const hd = await rectOf(tid('v6e-range-kbd-hlo-0'));
    const w = await writesOf(async () => {
      await page.mouse.move(hd.cx, hd.cy);
      await page.mouse.down();
      await page.mouse.move(k.l + 1, hd.cy, { steps: 10 });
      await page.mouse.up();
    });
    // D24.2 (UI6-U5a review R1a): the drag writes live (≤ 1 per 50 ms) and its final value on release, so there may
    // be several writes, all of slots.0.lowNote
    assert.ok(w.length >= 1 && w.every((p) => p === 'slots.0.lowNote'), `writes: ${w}`);
    const s = await song();
    assert.deepEqual([s.patch.slots[0].lowNote, s.patch.slots[0].highNote], [48, 84]);
    // Set highest by playing: arm, then a key (the controller's held notes)
    await page.click(tid('v6e-arm-high'));
    assert.equal(await page.getAttribute(tid('v6e-arm-high'), 'aria-pressed'), 'true');
    await ev(() => window.__rig.controller.perform.noteOn(79, 90));
    await until(() => window.__rig.store.currentSong().patch.slots[0].highNote === 79);
    await ev(() => window.__rig.controller.perform.noteOff(79));
    assert.equal(await page.getAttribute(tid('v6e-arm-high'), 'aria-pressed'), 'false');
    // Esc disarms without a panic
    await page.click(tid('v6e-arm-low'));
    await page.keyboard.press('Escape');
    assert.equal(await page.getAttribute(tid('v6e-arm-low'), 'aria-pressed'), 'false');
  });

  await T('Change instrument ▾ (U5b: the chooser) writes slots.<i>.instrument with Undo; Esc closes it', async () => {
    let target = null;
    const w = await writesOf(async () => {
      target = await changeInstrument('synth:warm-pad');
    });
    assert.equal(target, 'synth:warm-pad');
    assert.deepEqual(w, ['slots.0.instrument']);
    const s = await song();
    assert.equal(`${s.patch.slots[0].instrument.type}:${s.patch.slots[0].instrument.id}`, target);
    await until((t) => document.querySelector('.v6e-rt[data-block="slot:0"] .v6e-rt-name').textContent
      === document.querySelector('[data-testid="v6e-sentence"] .ev2-tok').textContent, target);
    await page.click(tid('v6e-change'));
    await until(() => !!document.querySelector('[data-testid="v6e-chooser"]'));
    await page.keyboard.press('Escape');
    await until(() => !document.querySelector('[data-testid="v6e-chooser"]'));
    await ev(() => {
      const { store } = window.__rig;
      const ref = { type: 'sampler', id: 'salamander-piano' };
      store.set(`songs.${store.currentSong().id}.patch.slots.0.instrument`, ref);
    });
  });

  // ---- after the rebase onto lane-moveui (native/docs/reviews/UI6-U5a.md R1–R3)
  /** Slot ranges of a song (default: the shown one). */
  const ranges = (id) => ev((sid) => {
    const { store } = window.__rig;
    const s = sid ? store.getSong(sid) : store.currentSong();
    return s.patch.slots.map((x) => (x ? [x.lowNote, x.highNote] : null));
  }, id || null);
  const names3 = () => ev(() => window.__rig.store.currentSong().patch.slots
    .map((x) => (x ? `${x.instrument.type}:${x.instrument.id}` : null)));
  /** Press slot k's low handle and drag it to key 48 (≥ one live write), keeping the button down. */
  async function holdLowAt48(k) {
    await choose('range');
    await until((kk) => !!document.querySelector(`[data-testid="v6e-range-kbd-hlo-${kk}"]`), k);
    const key = await rectOf('.v6-kbd-range .pkey[data-note="48"]');
    const hd = await rectOf(tid(`v6e-range-kbd-hlo-${k}`));
    await page.mouse.move(hd.cx, hd.cy);
    await page.mouse.down();
    await page.mouse.move(key.l + 1, hd.cy, { steps: 10 });
    await page.waitForTimeout(150); // the trailing live write (LIVE_MS 50)
    await until((kk) => window.__rig.store.currentSong().patch.slots[kk].lowNote === 48, k);
  }
  const R1_SET = () => ev(() => {
    const { store } = window.__rig;
    const id = store.currentSong().id;
    for (const [i, lo, hi] of [[0, 36, 84], [1, 40, 90], [2, 28, 60]]) {
      store.set(`songs.${id}.patch.slots.${i}.lowNote`, lo);
      store.set(`songs.${id}.patch.slots.${i}.highNote`, hi);
    }
  });
  const selectSlot = async (k) => {
    await ev((kk) => window.__rig.views.edit.editState.select(`slot:${kk}`), k);
    await until((kk) => window.__rig.views.edit._debug.instance()?._debug.slot() === kk, k);
  };

  await T('R1: a live range drag dropped by an instrument switch, a song switch, leaving Edit or a slot move puts '
    + 'the start value back on its own instrument', async () => {
    await setSlots(3);
    await toEdit();
    await selectSlot(0);
    await R1_SET();
    // (a) instrument switch mid-drag: slot 0's range comes back, slot 1's is untouched
    await holdLowAt48(0);
    await selectSlot(1);
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.deepEqual((await ranges()).slice(0, 3), [[36, 84], [40, 90], [28, 60]], 'instrument switch');
    // (b) song switch mid-drag: the restore goes into the song the drag wrote, never into the next one
    await selectSlot(0);
    const ids = await ev(() => {
      const { store } = window.__rig;
      const cur = store.currentSong().id;
      const other = Object.keys(store.get().songs).find((x) => x !== cur && store.getSong(x).patch.slots[0]);
      return { cur, other };
    });
    assert.ok(ids.other, 'a second song with an instrument');
    const otherBefore = await ranges(ids.other);
    await holdLowAt48(0);
    await ev((o) => window.__rig.controller.selectSong(o), ids.other);
    await until((o) => window.__rig.store.get().settings.currentSongId === o, ids.other);
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.deepEqual((await ranges(ids.cur)).slice(0, 3), [[36, 84], [40, 90], [28, 60]], 'song switch: old song');
    assert.deepEqual(await ranges(ids.other), otherBefore, 'song switch: the next song is untouched');
    await settled();
    await ev((c) => window.__rig.controller.selectSong(c), ids.cur);
    await until((c) => window.__rig.store.get().settings.currentSongId === c, ids.cur);
    await settled();
    // (c) leaving Edit mid-drag (⌘E without a pointer: setView)
    await selectSlot(0);
    await holdLowAt48(0);
    await ev(() => window.__rig.ctx.setView('perform'));
    await until(() => document.body.dataset.view === 'perform');
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.deepEqual((await ranges()).slice(0, 3), [[36, 84], [40, 90], [28, 60]], 'leaving Edit');
    await toEdit();
    // (d) the instrument moves mid-drag (store.moveSlot, as the v6 Perform's ⋯ Later): the restore follows it to its
    // new place, and the selected tab follows too
    await selectSlot(0);
    await holdLowAt48(0);
    const order0 = await names3();
    assert.ok(await ev(() => {
      const { store } = window.__rig;
      return store.moveSlot(store.currentSong().id, 0, 1);
    }));
    await until(() => window.__rig.views.edit.editState.selected === 'slot:1');
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.deepEqual((await names3()).slice(0, 3), [order0[1], order0[0], order0[2]]);
    assert.deepEqual((await ranges()).slice(0, 3), [[40, 90], [36, 84], [28, 60]], 'slot move');
    assert.equal(await ev(() => window.__rig.views.edit._debug.instance()._debug.slot()), 1);
    await ev(() => {
      const { store } = window.__rig;
      store.moveSlot(store.currentSong().id, 1, 0);
    });
    await until(() => window.__rig.views.edit.editState.selected === 'slot:0');
  });

  await T('R2: in Edit the strip’s name opens Range for its instrument (not remembered); no ⠿ grip', async () => {
    await setSlots(3);
    await selectSlot(1);
    await choose('sound');
    const who = `[data-testid="v6e-stage"] ${tid('v6-who-1')}`;
    const a = await ev((sel) => {
      const el = document.querySelector(sel);
      const grip = document.querySelector('[data-testid="v6e-stage"] [data-testid="v6-grip-1"]');
      return { role: el.getAttribute('role'), pressed: el.getAttribute('aria-pressed'), title: el.title,
        grip: grip ? getComputedStyle(grip).display : 'absent' };
    }, who);
    assert.equal(a.role, 'button');
    assert.equal(a.pressed, null, 'no toggle state: Edit never picks a bar');
    assert.match(a.title, /Range/);
    assert.equal(a.grip, 'none');
    await page.click(who);
    await until(() => document.querySelector('[data-testid="v6e-ccont"]')?.dataset.cat === 'range');
    assert.equal(await ev(() => window.__rig.views.edit.editState.selected), 'slot:1');
    assert.equal(await ev(() => window.__rig.views.edit._debug.prefs().cat), 'sound', 'a jump is not remembered');
    // the keyboard way: Enter on the focused name
    await choose('sound');
    await page.focus(who);
    await page.keyboard.press('Enter');
    await until(() => document.querySelector('[data-testid="v6e-ccont"]')?.dataset.cat === 'range');
    await choose('sound');
  });

  await T('R3: the selected tab follows its instrument through a move; Remove / Change instrument → move → Undo '
    + 'lands on the right instrument', async () => {
    await setSlots(3);
    await toEdit();
    const sid = await ev(() => window.__rig.store.currentSong().id);
    const mv = (from, to) => ev(([f, t]) => window.__rig.store.moveSlot(window.__rig.store.currentSong().id, f, t),
      [from, to]);
    const clearToasts = () => ev(() => document.getElementById('toasts')?.replaceChildren());
    const undoToast = async () => {
      await until(() => !!document.querySelector('#toasts .toast-action'));
      await ev(() => [...document.querySelectorAll('#toasts .toast-action')].pop().click());
    };
    // (a) select instrument 2, move it (as the v6 Perform's ⋯ Earlier) → Edit still shows it
    await selectSlot(1);
    const n0 = await names3();
    assert.ok(await mv(1, 0));
    await until(() => window.__rig.views.edit.editState.selected === 'slot:0');
    await until(() => window.__rig.views.edit._debug.instance()?._debug.slot() === 0);
    assert.equal((await names3())[0], n0[1]);
    assert.equal(await ev(() => document.querySelector('.v6e-rt[aria-selected="true"]')?.dataset.block), 'slot:0');
    // a move of other instruments shifts it too: 0 → 2 moves the shown one (now at 0) to 2
    assert.ok(await mv(0, 2));
    await until(() => window.__rig.views.edit.editState.selected === 'slot:2');
    await setSlots(3);
    // (b) Remove → move → Undo: the sound comes back into its own (moved) place, not onto its neighbour
    await selectSlot(1);
    const before = await names3();
    await clearToasts();
    await page.click(tid('v6e-change'));
    await page.click(tid('v6e-ch-remove'));
    await page.click('.v6e-confirm .v6e-remove');
    await until(() => window.__rig.store.currentSong().patch.slots[1] === null);
    assert.ok(await mv(1, 2)); // the empty place goes last; the third instrument comes to 1
    await until(() => window.__rig.views.edit.editState.selected === 'slot:2');
    await until(() => {
      const b = document.querySelector('[data-testid="v6e-ccont"] .v6e-undo-btn');
      return b && b.offsetParent !== null;
    });
    await undoToast();
    await until(() => !!window.__rig.store.currentSong().patch.slots[2]);
    assert.deepEqual((await names3()).slice(0, 3), [before[0], before[2], before[1]], 'Remove → move → Undo');
    // (c) Change instrument → move → Undo: the old instrument comes back on the moved slot
    await setSlots(3);
    await selectSlot(0);
    const was = await names3();
    await clearToasts();
    const target = await changeInstrument(null, 'sampler:salamander-piano');
    await until((t) => {
      const x = window.__rig.store.currentSong().patch.slots[0].instrument;
      return `${x.type}:${x.id}` === t;
    }, target);
    assert.ok(await mv(0, 2));
    await undoToast();
    await until(() => window.__rig.store.currentSong().patch.slots[2].instrument.id === 'salamander-piano');
    assert.deepEqual((await names3()).slice(0, 3), [was[1], was[2], was[0]], 'Change → move → Undo');
    // the removed-since branch: Change, then remove that instrument, then Undo → refused, nothing written
    await setSlots(3);
    await selectSlot(0);
    await clearToasts();
    await changeInstrument(target);
    await until((t) => {
      const x = window.__rig.store.currentSong().patch.slots[0].instrument;
      return `${x.type}:${x.id}` === t;
    }, target);
    await ev(() => window.__rig.store.removeSlot(window.__rig.store.currentSong().id, 0));
    const after = await names3();
    await undoToast();
    await page.waitForTimeout(150);
    assert.deepEqual(await names3(), after, 'Undo of a removed instrument writes nothing');
    assert.equal(sid, await ev(() => window.__rig.store.currentSong().id));
    await clearToasts();
    await setSlots(3);
    await selectSlot(0);
  });

  await T('skeptic after the rebase F1: Esc mid-drag puts the start value back (no commit); pointercancel; the '
    + 'dragged instrument removed; a pointermove in the slot map’s own task writes no other instrument', async () => {
    await setSlots(3);
    await toEdit();
    await selectSlot(0);
    const hitEvent = (type, x, y) => ev(([t, xx, yy]) => document.querySelector('[data-testid="v6e-range-kbd-hit"]')
      .dispatchEvent(new PointerEvent(t, { pointerId: 1, bubbles: true, pointerType: 'mouse', clientX: xx,
        clientY: yy, buttons: 1 })), [type, x, y]);
    // (a) Esc: the drag ends with its start value; the release writes nothing (failed before the fix: [48, 84])
    await R1_SET();
    await holdLowAt48(0);
    await page.keyboard.press('Escape');
    assert.equal(await ev(() => window.__rig.views.edit._debug.instance()._debug.kb().dragging), false);
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.deepEqual((await ranges()).slice(0, 3), [[36, 84], [40, 90], [28, 60]], 'Esc');
    // (b) pointercancel (a touch the OS takes over)
    await holdLowAt48(0);
    await hitEvent('pointercancel', 0, 0);
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.deepEqual((await ranges()).slice(0, 3), [[36, 84], [40, 90], [28, 60]], 'pointercancel');
    // (c) a pointermove in the same task as a move (before the microtask cancel) is refused, never written to the
    // instrument now at the dragged index; the cancel then restores the moved instrument
    const n0 = await names3();
    await holdLowAt48(0);
    const key = await rectOf('.v6-kbd-range .pkey[data-note="60"]');
    const hd = await rectOf(tid('v6e-range-kbd-hlo-0'));
    const w = await ev(({ x, y }) => {
      const { store } = window.__rig;
      const out = [];
      const orig = store.set;
      store.set = (p, v) => (out.push(p.replace(/^songs\.[^.]+\.patch\./, '')), orig.call(store, p, v));
      store.moveSlot(store.currentSong().id, 0, 1);
      document.querySelector('[data-testid="v6e-range-kbd-hit"]').dispatchEvent(new PointerEvent('pointermove',
        { pointerId: 1, bubbles: true, pointerType: 'mouse', clientX: x, clientY: y, buttons: 1 }));
      return new Promise((res) => setTimeout(() => {
        store.set = orig;
        res(out);
      }, 200));
    }, { x: key.l + 1, y: hd.cy });
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.deepEqual(w, ['slots.1.lowNote'], 'only the restore, on the moved instrument');
    assert.deepEqual((await names3()).slice(0, 3), [n0[1], n0[0], n0[2]]);
    assert.deepEqual((await ranges()).slice(0, 3), [[40, 90], [36, 84], [28, 60]], 'same-task move');
    await ev(() => window.__rig.store.moveSlot(window.__rig.store.currentSong().id, 1, 0));
    await until(() => window.__rig.views.edit.editState.selected === 'slot:0');
    // (d) the dragged instrument removed mid-drag: nothing is restored onto the one that takes its place
    await holdLowAt48(0);
    await ev(() => window.__rig.store.removeSlot(window.__rig.store.currentSong().id, 0));
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.deepEqual((await ranges()).slice(0, 2), [[40, 90], [28, 60]], 'removed');
    await setSlots(3);
    await selectSlot(0);
  });

  await T('Tone EQ: today’s eqKeyboard mounts on open and is destroyed on leave; no leaked store listeners',
    async () => {
    await choose('sound');
    const l0 = await ev(() => window.__storeListeners.size);
    const t0 = await ev(() => window.__rig.views.edit._debug.instance()._debug.tone());
    for (let k = 0; k < 3; k++) {
      await choose('eq');
      await until(() => !!document.querySelector('[data-testid="v6e-ccont"] .v6e-tonehost > *'));
      await choose('range');
      await choose('sound');
    }
    const t = await ev(() => window.__rig.views.edit._debug.instance()._debug.tone());
    assert.deepEqual(t, { mounted: false, created: t0.created + 3, destroyed: t0.destroyed + 3 });
    assert.equal(t0.created, t0.destroyed);
    assert.equal(await ev(() => window.__storeListeners.size), l0);
    // switching instruments while the EQ is open rebuilds it on the other slot
    await choose('eq');
    await page.click(tid('v6e-tab-slot-1'));
    await until(() => document.querySelector('[data-testid="v6e-inst"]').dataset.slot === '1');
    const t2 = await ev(() => window.__rig.views.edit._debug.instance()._debug.tone());
    assert.equal(t2.mounted, true);
    assert.equal(t2.created - t2.destroyed, 1);
    await page.click(tid('v6e-tab-slot-0'));
    await choose('sound');
  });

  await T('+ Add: an empty instrument at the end, selected with its picker; the strip on the right is Perform’s',
    async () => {
      const n0 = (await song()).patch.slots.length;
      await page.click(tid('v6e-add'));
      await until((n) => window.__rig.store.currentSong().patch.slots.length === n + 1, n0);
      await until((n) => window.__rig.views.edit.editState.selected === `slot:${n}`
        && !!document.querySelector('[data-testid="v6e-chooser"]'), n0);
      assert.equal(await ev((n) => document.querySelector(`.v6e-rt[data-block="slot:${n}"] .v6e-rt-name`).textContent,
        n0), 'Empty');
      await page.keyboard.press('Escape');
      // the strip: ON tile = the mute (same write as Perform)
      await ev(() => window.__rig.views.edit.editState.select('slot:1'));
      const w = await writesOf(() => page.click('[data-testid="v6e-stage"] [data-testid="v6-on-1"]'));
      assert.deepEqual(w, ['slots.1.muted']);
      await until(() => window.__rig.store.currentSong().patch.slots[1].muted === true);
      await page.click('[data-testid="v6e-stage"] [data-testid="v6-on-1"]');
      await until(() => !window.__rig.store.currentSong().patch.slots[1].muted);
      await setSlots(3);
      await until(() => document.querySelectorAll('.v6e-rt[data-block^="slot:"]').length === 3);
      await ev(() => window.__rig.views.edit.editState.select('slot:0'));
    });

  await T('library fold: ⟨ folds to a rail, remembered per device; ⟩ brings it back', async () => {
    await page.click(tid('v6e-lib-fold'));
    await until(() => document.querySelector('[data-testid="v6e-lib"]').hidden
      && !document.querySelector('[data-testid="v6e-lib-rail"]').hidden);
    assert.equal(await ev(() => JSON.parse(localStorage.getItem('worship-rig.v6.edit')).lib), 'folded');
    await page.reload();
    await waitRigReady(page, { timeout: 40000 });
    await until(() => !!window.__rig.views.edit?._debug?.v6, null, 30000);
    await toEdit();
    assert.equal(await ev(() => document.querySelector('[data-testid="v6e-lib"]').hidden), true);
    await ev(() => document.getElementById('toasts')?.replaceChildren());
    await ev(() => document.activeElement?.blur?.());
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, 'u5-edit-library-folded-1280.png') });
    await page.click(tid('v6e-lib-unfold'));
    await until(() => !document.querySelector('[data-testid="v6e-lib"]').hidden);
    assert.equal(await ev(() => JSON.parse(localStorage.getItem('worship-rig.v6.edit')).lib), undefined);
  });

  await T('flag flips: v6 Edit ⇄ today’s Edit, stylesheet linked / removed, no store listeners left behind',
    async () => {
      for (let k = 0; k < 2; k++) {
        assert.equal(await ev(() => window.__rig.setUiV6(false)), false);
        await until(() => !!document.querySelector('#view-edit > .ev2:not(.v6-edit)')
          && !window.__rig.views.edit._debug.v6);
        assert.equal(await ev(() => !!document.querySelector('link[data-v6-edit-css]')), false);
        assert.equal(await ev(() => window.__rig.setUiV6(true)), true);
        await until(() => !!document.querySelector('#view-edit > .v6-edit') && window.__rig.views.edit._debug.v6);
        assert.equal(await ev(() => document.querySelectorAll('link[data-v6-edit-css]').length), 1);
      }
      await ev(() => window.__rig.setUiV6(false));
      await until(() => !window.__rig.views.edit._debug.v6 && !window.__rig.views.v6);
      await page.waitForTimeout(300);
      assert.equal(await ev(() => window.__storeListeners.size), baseListeners);
      // today's Edit keeps today's 1024 px page minimum at iPad portrait (the v6 Edit's portrait rule is its own)
      await page.setViewportSize({ width: 820, height: 1180 });
      await toEdit();
      assert.equal(await ev(() => getComputedStyle(document.body).minWidth), '1024px');
      await page.setViewportSize({ width: 1280, height: 800 });
      await ev(() => window.__rig.setUiV6(true));
      await until(() => !!window.__rig.views.edit?._debug?.v6 && !!window.__rig.views.v6);
    });

  await T('screenshots 1280×800 Sanctuary: Sound, Tone EQ, Range', async () => {
    await ev(() => {
      const { store, controller } = window.__rig;
      controller.scenes?.go(null);
      store.resetToFactory(store.currentSong().id);
    });
    await setSlots(3);
    await ev(() => window.__rig.ctx.setView('perform'));
    await toEdit();
    await ev(() => window.__rig.views.edit.editState.select('slot:0'));
    for (const c of ['sound', 'eq', 'range']) {
      await choose(c);
      await ev(() => document.getElementById('toasts')?.replaceChildren());
      await ev(() => document.activeElement?.blur?.());
      await page.mouse.move(5, 790);
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(SHOTS, `u5-edit-${c}-1280.png`) });
    }
    // nothing scrolls sideways at 1280 or 1024, in any category (skeptic UI6-U5a F3: only Range was checked, and
    // Tone EQ's pane scrolled 115 px sideways at 1024 × 700, its A / B toggle and band table clipped)
    for (const [w, hgt] of [[1280, 800], [1024, 700]]) {
      await page.setViewportSize({ width: w, height: hgt });
      for (const c of ['sound', 'eq', 'range', 'touch', 'sustain', 'sends', 'adv']) {
        await choose(c);
        await page.waitForTimeout(c === 'eq' ? 400 : 150);
        const over = await ev(() => [document.scrollingElement, ...document.querySelectorAll('.v6-edit, .v6e-main, '
          + '.v6e-inst, .v6e-ccont')].filter((e) => e.scrollWidth > e.clientWidth + 1)
          .map((e) => `${e.className || 'page'} +${e.scrollWidth - e.clientWidth}`));
        assert.deepEqual(over, [], `${w}×${hgt} ${c}`);
      }
      // the eqKeyboard's summary names the slot's role ("Keys plays …", D15): not shown in the v6 Edit
      await choose('eq');
      assert.equal(await ev(() => !!document.querySelector('.v6e-tonehost .eqk-summary')?.offsetParent), false);
    }
    await choose('range');
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await T('iPad portrait 820×1180: categories as a row of tabs, no strip, no sideways scroll; ☰ Songs drawer',
    async () => {
      await page.setViewportSize({ width: 820, height: 1180 });
      try {
        await choose('sound');
        await page.waitForTimeout(300);
        const r = await ev(() => ({
          dir: getComputedStyle(document.querySelector('[data-testid="v6e-cnav"]')).flexDirection,
          stage: getComputedStyle(document.querySelector('[data-testid="v6e-stage"]')).display,
          lib: getComputedStyle(document.querySelector('[data-testid="v6e-lib"]')).display,
          side: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth + 1,
          rows: new Set([...document.querySelectorAll('.v6e-cn')].map((b) => Math.round(b.getBoundingClientRect().top)))
            .size,
        }));
        assert.deepEqual(r, { dir: 'row', stage: 'none', lib: 'none', side: false, rows: r.rows });
        assert.ok(r.rows <= 2, `${r.rows} rows of category tabs`);
        await ev(() => document.getElementById('toasts')?.replaceChildren());
        await page.screenshot({ path: path.join(SHOTS, 'u5-edit-ipad-portrait-820.png') });
        await page.click('.v6e-head .ev2-song-songsbtn');
        await until(() => getComputedStyle(document.querySelector('[data-testid="v6e-lib"]')).display === 'flex');
        await page.keyboard.press('Escape');
        await until(() => getComputedStyle(document.querySelector('[data-testid="v6e-lib"]')).display === 'none');
      } finally {
        await page.setViewportSize({ width: 1280, height: 800 });
      }
    });

  // skeptic UI6-U5a F1: the category list is a tablist with its orientation, each tab controls the pane and the pane
  // is labelled by the chosen tab (before: no orientation, no ids / aria-controls, the pane only aria-label'd)
  // skeptic UI6-U5a F2: at 1024 × 700 all seven rows fit, and a remembered Advanced is in sight (before: 349 px of rows
  // in a 308 px list, Advanced below the fold with the list at scrollTop 0)
  await T('skeptic U5a F1/F2: category tablist semantics; the chosen row in sight at 1024×700', async () => {
    await toEdit();
    await ev(() => window.__rig.views.edit.editState.select('slot:0'));
    await choose('touch');
    const aria = await ev(() => {
      const nav = document.querySelector('[data-testid="v6e-cnav"]');
      const cont = document.querySelector('[data-testid="v6e-ccont"]');
      const tabs = [...nav.querySelectorAll('[role="tab"]')];
      const on = nav.querySelector('[aria-selected="true"]');
      return {
        orient: nav.getAttribute('aria-orientation'),
        ids: tabs.every((t) => t.id && document.getElementById(t.id) === t),
        controls: tabs.every((t) => t.getAttribute('aria-controls') === cont.id && !!cont.id),
        labelledby: cont.getAttribute('aria-labelledby') === on.id,
        label: cont.hasAttribute('aria-label'),
      };
    });
    assert.deepEqual(aria, { orient: 'vertical', ids: true, controls: true, labelledby: true, label: false });
    await page.setViewportSize({ width: 820, height: 1180 });
    try {
      await choose('sound');
      assert.equal(await page.getAttribute(tid('v6e-cnav'), 'aria-orientation'), 'horizontal');
    } finally {
      await page.setViewportSize({ width: 1280, height: 800 });
    }
    await page.setViewportSize({ width: 1024, height: 700 });
    try {
      await choose('adv');
      // a fresh mount (flag flip) with Advanced remembered, the list scrolled to the top
      await ev(() => window.__rig.setUiV6(false));
      await ev(() => window.__rig.setUiV6(true));
      await until(() => !!window.__rig.views.edit?._debug?.v6 && !!document.querySelector('[data-testid="v6e-cnav"]'));
      await ev(() => window.__rig.views.edit.editState.select('slot:0'));
      await page.waitForTimeout(300);
      const r = await ev(() => {
        const nav = document.querySelector('[data-testid="v6e-cnav"]');
        const n = nav.getBoundingClientRect();
        const inSight = (el) => {
          const b = el.getBoundingClientRect();
          return b.top >= n.top - 1 && b.bottom <= n.bottom + 1;
        };
        return {
          cat: window.__rig.views.edit._debug.instance()._debug.cat(),
          all: [...nav.querySelectorAll('.v6e-cn')].every(inSight),
          over: nav.scrollHeight - nav.clientHeight,
        };
      });
      assert.deepEqual(r, { cat: 'adv', all: true, over: 0 }, JSON.stringify(r));
      await choose('sound');
    } finally {
      await page.setViewportSize({ width: 1280, height: 800 });
    }
  });

  // skeptic UI6-U5a F4: the library column's setlist head at 1024 px squeezed + Setlist / Rename / Delete below their
  // text (overlapping words "+ SetliRenamDelete"); at 1280 they ran 2–4 px past their boxes
  await T('skeptic U5a F4: the library’s setlist buttons keep their text inside, without overlap (1024, 1280)',
    async () => {
      await toEdit();
      for (const [w, hgt] of [[1024, 700], [1280, 800]]) {
        await page.setViewportSize({ width: w, height: hgt });
        await page.waitForTimeout(200);
        const r = await ev(() => {
          const bs = [...document.querySelectorAll('[data-testid="v6e-lib"] .ev2-list-setbtn')];
          const rects = bs.map((b) => b.getBoundingClientRect());
          return {
            n: bs.length,
            clipped: bs.filter((b) => b.scrollWidth > b.clientWidth).map((b) => b.textContent),
            overlap: rects.some((a, k) => k > 0 && a.left < rects[k - 1].right - 0.5 && a.top < rects[k - 1].bottom),
            inside: rects.every((a) => a.right <= document.querySelector('[data-testid="v6e-lib"]')
              .getBoundingClientRect().right),
          };
        });
        assert.deepEqual(r, { n: 3, clipped: [], overlap: false, inside: true }, `${w}: ${JSON.stringify(r)}`);
      }
      await page.setViewportSize({ width: 1280, height: 800 });
    });

  // ---------------------------------------------------------------- U5b (u5b.tests.mjs)
  await u5bTests({
    T, page, ev, until, tid, song, setSlots, toEdit, writesOf, assert, HERE, chooserPick, changeInstrument,
    todayShared: () => todayShared,
  });
  await skepticU5bTests({ T, page, ev, until, tid, toEdit, assert, settled });
  // ---------------------------------------------------------------- UI v6 polish batch 1 (polish1.tests.mjs)
  await polish1EditTests({ T, page, ev, until, tid, toEdit, assert, settled });
  // ---------------------------------------------------------------- U-EDITRANGE (editrange.tests.mjs, D26.2)
  await editRangeTests({ T, page, ev, until, tid, toEdit, assert, settled, setSlots });
  // ---------------------------------------------------------------- polish batch 2 (polish2.tests.mjs)
  await polish2EditTests({ T, page, ev, until, tid, toEdit, assert, settled });
  // ---------------------------------------------------------------- U-SNAP follow-up (snapline.tests.mjs, O1 / O2)
  await snaplineEditTests({ T, page, ev, until, tid, toEdit, assert, settled });

  await T('zero console.error, no HTTP ≥ 400', async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  await context.close();
  await browser.close();
  await server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nui-v6-edit: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
