// edit-v2 test harness (views/edit/CONTRACT.md §7): serve the real app with server.js on a free port, boot
// store + engine + controller in test/phase2/edit-v2/harness.html, and mount ONE panel module (or the whole H-v2
// Edit view) in an empty page. One Chromium and one server per test process, one browser context per mount.
//
//   import { mountPanelForTest, smoke, shutdown } from '../harness.mjs';
//   after(shutdown);
//   const t = await mountPanelForTest('slot', { panelOpts: { slot: 1 } });
//   await t.setParam('slots.1.sends.reverb', 0.75);  …  await t.close();
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../../..');
export const SHOTS = path.join(HERE, 'screenshots');
const { createServer } = require(path.join(ROOT, 'server.js'));
const VERBOSE = !!process.env.VERBOSE;

/** The ctx fields every panel module can rely on (CONTRACT.md §3). */
export const CTX_FIELDS = Object.freeze([
  'store', 'controller', 'engine', 'toast', 'C', 'editState', 'song', 'songId', 'set', 'valueOf', 'subscribe',
  'listen', 'onLeaveSong', 'onEscape', 'markDialog', 'songField', 'fieldSongId', 'setTitle', 'instruments',
  'findInstrument', 'held', 'select', 'cleanup', 'host',
]);
/** Region modules (no sentence title); every other id is a block panel. */
export const REGIONS = Object.freeze({ setlist: 'left', 'song-header': 'head', bottom: 'bottom' });

let shared = null; // { server, origin, browser, samplesDir }
async function boot() {
  if (shared) return shared;
  // My Samples on with an empty scan root: the real /api paths without 404s (same as the ui-edit suite)
  const samplesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-edit-v2-samples-'));
  const server = createServer({ appDir: ROOT, port: 0, userSamples: [samplesDir] });
  const info = await server.listen();
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  shared = { server, origin: `http://127.0.0.1:${info.port}`, browser, samplesDir };
  return shared;
}

/** Close the shared browser and server. Call it from node:test `after()`. */
export async function shutdown() {
  if (!shared) return;
  const s = shared;
  shared = null;
  await s.browser.close().catch(() => {});
  await s.server.close?.();
  fs.rmSync(s.samplesDir, { recursive: true, force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Mount one registered panel (or the full view) in a fresh browser context.
 * @param {string|null} panelId  'slot' | 'drone' | 'effects' | 'master' | 'song' | 'song-header' | 'setlist' | 'bottom'
 *                               (null with {full:true})
 * @param {object} [o]
 * @param {object} [o.panelOpts]     mount options, e.g. {slot: 2} or {focus: 'wheels'}
 * @param {boolean} [o.full]         mount the whole view (shell.mountEdit) instead of one panel
 * @param {{width:number,height:number}} [o.viewport]  default 1440×900
 * @param {string} [o.song]          factory id ('factory:glass-ocean'), song name or song id to select first
 * @param {boolean} [o.waitLoaded=true]  wait until the controller has loaded the current song (engine params valid)
 * @param {'ui-core'|'fallback'} [o.components='ui-core']
 * @returns {Promise<object>} the test handle (see CONTRACT.md §7)
 */
export async function mountPanelForTest(panelId, o = {}) {
  const { origin, browser } = await boot();
  const viewport = o.viewport || { width: 1440, height: 900 };
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  await context.grantPermissions(['midi', 'midi-sysex'], { origin });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url || '?'}`);
    else if (VERBOSE) console.log(`   [page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const q = new URLSearchParams();
  if (o.full) q.set('full', '1');
  else q.set('panel', panelId);
  if (o.panelOpts) q.set('opts', JSON.stringify(o.panelOpts));
  if (o.song) q.set('song', o.song);
  if (o.components === 'fallback') q.set('components', 'fallback');

  const ev = (fn, arg) => page.evaluate(fn, arg);
  const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
  await page.goto(`${origin}/test/phase2/edit-v2/harness.html?${q}`);
  await until(() => !!(window.__ev2 && window.__ev2.ready), null, 20000);
  await ev(() => window.__rig.ready);
  await until(() => window.__rig.engine.ctx && window.__rig.engine.ctx.state === 'running', null, 20000);
  if (o.waitLoaded !== false) {
    await until(() => {
      const r = window.__rig;
      const id = r.store.get().settings.currentSongId;
      return !id || (r.controller.status.songId === id && !r.controller.status.loading);
    }, null, 30000);
  }

  const t = {
    page, context, origin, errors, panelId: o.full ? null : panelId, full: !!o.full,
    /** CSS selector of the mounted panel's host (block panel body or region host). */
    host: o.full ? '#view-edit .ev2' : `#view-edit [data-panel="${panelId}"]`,
    ev, until, sleep,
    /** The current song (plain JSON). */
    song: () => ev(() => window.__rig.store.currentSong()),
    /** store.set(addr, v) in the page; §4 grammar or 'song.<field>'. @returns {Promise<boolean>} */
    setParam: (addr, v) => ev(([a, x]) => window.__rig.store.set(a, x), [addr, v]),
    /** Current song value for a §4 address / 'song.<field>' (PARAMS default when absent). */
    readParam: (addr) => ev(async (a) => {
      const { relOf, getIn } = await import('/app/js/views/edit/lib.js');
      const { describe } = await import('/app/js/shared/params.js');
      const v = getIn(window.__rig.store.currentSong(), relOf(a));
      return v === undefined ? describe(a)?.default ?? null : v;
    }, addr),
    /** engine.getParam(path) (what the controller pushed to the engine). */
    engineParam: (p) => ev((x) => window.__rig.engine.getParam(x), p),
    /** Wait until engine.getParam(path) is within eps of v. */
    untilEngine: (p, v, eps = 1e-3, timeout = 15000) =>
      until(([x, want, e]) => {
        const g = window.__rig.engine.getParam(x);
        return typeof want === 'number' ? Math.abs(g - want) <= e : g === want;
      }, [p, v, eps], timeout),
    /** Set an <input type=range> by position (0..1000 for word sliders / faders) and fire input + change. */
    setRange: (sel, pos) => ev(([s, p]) => {
      const input = document.querySelector(s);
      if (!input) throw new Error(`no range input for ${s}`);
      input.value = String(p);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, [sel, pos]),
    click: (sel, opts) => page.click(sel, opts),
    /** editState.select(blockId, opts) in the page. */
    select: (id, opts) => ev(([i, x]) => window.__rig.view.editState.select(i, x || {}), [id, opts]),
    /** Screenshot of the page → screenshots/<name>.png. @returns {Promise<string>} path */
    async screenshot(name) {
      fs.mkdirSync(SHOTS, { recursive: true });
      const file = path.join(SHOTS, `${name}.png`);
      await ev(() => {
        for (const x of document.querySelectorAll('#toasts > *')) x.remove();
        document.activeElement?.blur?.();
      });
      await page.screenshot({ path: file });
      return file;
    },
    /** Play a note through controller.perform and return the peak short-window RMS (dBFS) over ~500 ms. */
    async playAndMeasure(note = 60) {
      await ev((n) => window.__rig.controller.perform.noteOn(n, 110), note);
      const db = await ev(async () => {
        const an = window.__rig.engine.analyserL;
        const buf = new Float32Array(an.fftSize);
        let best = -Infinity;
        const t0 = performance.now();
        while (performance.now() - t0 < 500) {
          an.getFloatTimeDomainData(buf);
          let s = 0;
          for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
          best = Math.max(best, 10 * Math.log10(s / buf.length + 1e-20));
          await new Promise((r) => setTimeout(r, 25));
        }
        return best;
      });
      await ev((n) => window.__rig.controller.perform.noteOff(n), note);
      return db;
    },
    /** Switch song the way MIDI Next / program change does (no pointer), and wait until it is loaded. */
    async selectSong(idOrName) {
      const id = await ev((x) => {
        const st = window.__rig.store.get();
        return st.songs[x] ? x : st.songOrder.find((k) => st.songs[k].name === x || st.songs[k].factoryId === x);
      }, idOrName);
      assert.ok(id, `no song ${idOrName}`);
      await ev((i) => window.__rig.controller.selectSong(i), id);
      await until((i) => window.__rig.controller.status.songId === i && !window.__rig.controller.status.loading, id, 30000);
      return id;
    },
    /** Assert that nothing was logged with console.error / no page errors so far. */
    assertNoConsoleErrors() {
      assert.deepEqual(errors, [], `console errors:\n${errors.join('\n')}`);
    },
    async close() {
      await context.close().catch(() => {});
    },
  };
  return t;
}

/**
 * Generic smoke check for a mounted panel (every panel's first test keeps calling it):
 * the host exists and rendered something, the panel ctx has every CONTRACT.md §3 field, a block panel set a
 * non-empty sentence title, a store write round-trips (store → engine), and there were no console errors.
 * @param {object} t  handle from mountPanelForTest
 */
export async function smoke(t) {
  const r = await t.ev(({ host, fields }) => {
    const el = document.querySelector(host);
    const pc = window.__rig.panelCtx;
    return {
      host: !!el,
      children: el ? el.childElementCount : 0,
      missing: pc ? fields.filter((f) => !(f in pc)) : ['<no panel ctx>'],
      title: document.querySelector('#view-edit .ev2-title .ev2-sent')?.textContent || '',
      source: window.__ev2.components,
    };
  }, { host: t.host, fields: CTX_FIELDS });
  assert.ok(r.host, `panel host ${t.host} exists`);
  assert.ok(r.children > 0, 'panel rendered something');
  assert.deepEqual(r.missing, [], 'panel ctx fields');
  if (!(t.panelId in REGIONS)) assert.ok(r.title.trim().length > 0, 'block panel set a sentence title');
  assert.equal(r.source, 'ui-core', 'ui-core components loaded');
  // store → engine round trip (proves the controller is live under the harness)
  const before = await t.readParam('master.volume');
  assert.equal(await t.setParam('master.volume', 1), true);
  assert.equal(await t.readParam('master.volume'), 1);
  await t.untilEngine('master.volume', 1, 1e-6);
  await t.setParam('master.volume', before);
  t.assertNoConsoleErrors();
}
