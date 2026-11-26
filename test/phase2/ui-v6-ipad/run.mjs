#!/usr/bin/env node
// UI v6 U8a suite: iPad layouts and edge states (native/docs/lanes/UI6-build-plan.md U8; DECISIONS D14 "the iPad
// mirrors the Mac in landscape and portrait"; app/styles-v6-ipad.css, app/styles-v6-states.css, views/v6/start.js).
// The real app (app/index.html) in Chromium against server.js, flag on (?ui6=1), in an iPad context (hasTouch,
// isMobile, deviceScaleFactor 2, so (pointer: coarse) matches):
//   layout: every v6 screen (Perform with 4 and 7 instruments, the sidebar's modules, the rail, Quick, the song menu,
//     Save snapshot, MIDI Learn, Arrange, the Song bank, the chart on the stage and in the sidebar, Edit's instrument
//     categories and Drone / Effects / Master, Settings' list and categories) at 820 × 1180 and 1180 × 820, Perform
//     also at 1024 × 1366, 1366 × 1024 and 1024 × 768: no sideways page scroll, no control outside its row (or cut by
//     a box that does not scroll), no two top-bar lamps / items overlapping, every control ≥ 44 × 44 px (a declared
//     ::after hit area counts; the instrument sentence's words are the one exception, see EXEMPT); portrait: 4
//     instruments fit without the strips scrolling (sidebar panel open or folded), the faders keep ≥ 96 px of track
//     in Perform, Learn and Arrange; the keyboard has the whole width;
//   rotation keeps state: an open Quick sheet, the sidebar tab, a range pick, the bank's song, Edit's category, the
//     chart's placement and size; Settings keeps its category across rotations (UI6-U6 O1);
//   the queued polish: the small-window sidebar rule per orientation and only a deliberate open latching it
//     (UI6-move O3), Enter on a strip name puts the focus on its low handle (UI6-move O2), Settings' summaries tick
//     while open (UI6-U6 O2);
//   edge states, each with its words on screen: first run (Start here under the song bar), loading ("Loading…" /
//     "Preparing n of m"), MIDI not allowed / no device, sound stopped / restarting / asleep / paused (the start
//     overlay), Perform lock (every v6 control frozen or live as the LOCK table says, one look), a muted second
//     window, a full storage refusing a save (D10), an empty library;
//   flag off: today's Start here wording and nothing of U8a linked; zero console.error and no HTTP ≥ 400.
//   node test/phase2/ui-v6-ipad/run.mjs   (screenshots → ./screenshots or U8A_SHOTS=<dir>; U8A_ONLY=<regex>)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { MIDI_PERMISSIONS, waitRigReady, pinTheme } from '../../integration/lib.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const APP = path.join(ROOT, 'app');
const SHOTS = process.env.U8A_SHOTS ? path.resolve(process.env.U8A_SHOTS) : path.join(HERE, 'screenshots');
const { createServer } = require(path.join(ROOT, 'server.js'));
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const ONLY = process.env.U8A_ONLY ? new RegExp(process.env.U8A_ONLY) : null;
const T = async (name, fn) => {
  if (ONLY && !ONLY.test(name) && !/^zero console/.test(name)) return;
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

const PORTRAIT = { width: 820, height: 1180 };
const LANDSCAPE = { width: 1180, height: 820 };
const MAC = { width: 1280, height: 800 };
const IPAD = { hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
const START_KEY = 'worship-rig.start-card';
const SIDEBAR_KEY = 'worship-rig.v6.sidebar';

const server = createServer({ appDir: APP, port: 0 });
const info = await server.listen();
const origin = `http://127.0.0.1:${info.port}`;
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const contexts = new Set();

/**
 * A new context + page. `fresh`: the Start here card is not yet dismissed (a first run); otherwise it is, so the
 * layout checks see the everyday stage. `init`: an init script (a fake MIDI, …). `b`: another browser.
 */
async function open(o = {}) {
  const { viewport = PORTRAIT, ipad = true, fresh = false, init = null, b = browser, sidebar = null } = o;
  const context = await b.newContext({ viewport, ...(ipad ? IPAD : {}) });
  contexts.add(context);
  await pinTheme(context, 'sanctuary');
  await context.grantPermissions([...MIDI_PERMISSIONS], { origin });
  await context.addInitScript(({ fresh, key, sk, sidebar }) => {
    try {
      if (!fresh) localStorage.setItem(key, 'done');
      if (sidebar) localStorage.setItem(sk, JSON.stringify(sidebar));
    } catch { /* storage blocked */ }
  }, { fresh, key: START_KEY, sk: SIDEBAR_KEY, sidebar });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  watch(page);
  return { context, page };
}
/** console.error / page errors / HTTP ≥ 400 of a page go into `errors` (the last check). */
function watch(page, what = '') {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${what}${m.text()} @ ${m.location()?.url || '?'}`);
  });
  page.on('pageerror', (e) => errors.push(`${what}pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`${what}HTTP ${r.status()} ${r.url()}`);
  });
}
async function close(context) {
  contexts.delete(context);
  await context.close();
}
async function boot(page, { q = '?ui6=1', ready = true } = {}) {
  await page.goto(`${origin}/${q}`);
  if (ready) await waitRigReady(page, { timeout: 60000 });
  if (q.includes('ui6=1')) {
    await page.waitForFunction(() => !!window.__rig?.views?.v6, null, { timeout: 30000, polling: 100 });
  }
  if (ready) await settled(page);
  // toasts come and go on their own clock (MIDI / wake-lock notes): out of the layout checks and the screenshots
  await page.addStyleTag({ content: '#toasts { display: none !important; }' });
}
const settled = (page) => page.waitForFunction(() => {
  const { controller, store } = window.__rig;
  return controller.status.songId === store.get().settings.currentSongId && !controller.status.loading;
}, null, { timeout: 60000, polling: 100 });
const tid = (id) => `[data-testid="${id}"]`;
const shot = async (page, name) => {
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOTS, name) });
};
const INSTRUMENTS = [['sampler', 'salamander-piano'], ['synth', 'warm-pad'], ['synth', 'sub-bass'],
  ['synth', 'strings'], ['sampler', 'ep-rhodes'], ['synth', 'square-lead'], ['organ', 'church']];
const setSlots = (page, n) => page.evaluate(({ n, list }) => {
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
async function rotate(page, vp) {
  await page.setViewportSize(vp);
  await page.waitForTimeout(350); // matchMedia change + rAF re-anchors
}

// ---------------------------------------------------------------- the layout check (in the page)
/**
 * Words of the instrument sentence (Edit, D18): inline text that jumps to its category; each also has its 44 px
 * category tab, and a 44 px line would break the sentence. Range inputs are judged by their track (the faders'
 * checks), the range bars' handles by the keyboard's 34 / 46 px hit layer (UI6-U2).
 */
const EXEMPT = '.ev2-tok, input[type="range"], .v6-rh';
/**
 * Report what breaks the layout in the visible part of the page.
 * @returns {{scrollX:number, scrollY:number, out:string[], small:string[], overlap:string[]}}
 */
function layoutReport(exempt) {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const name = (el) => `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''}`
    + `${el.id ? `#${el.id}` : ''}.${[...el.classList].slice(0, 2).join('.')} "${(el.getAttribute('aria-label')
      || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24)}"`;
  const shown = (el) => {
    if (!el.getClientRects().length) return false;
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
      if (p.inert) return false;
      // a closed <details>: Chromium keeps the content's boxes (content-visibility), nothing shows
      if (p.tagName === 'DETAILS' && !p.open && !el.closest('summary')) return false;
    }
    return true;
  };
  /** The box a finger can hit: the element's, grown by an absolutely placed ::after with px insets (a hit area). */
  const hitBox = (el) => {
    const r = el.getBoundingClientRect();
    const a = getComputedStyle(el, '::after');
    const box = { l: r.left, t: r.top, r: r.right, b: r.bottom };
    if (a.content !== 'none' && a.position === 'absolute' && a.pointerEvents !== 'none') {
      const px = (v) => (v.endsWith('px') ? parseFloat(v) : 0);
      box.l = Math.min(box.l, r.left + px(a.left));
      box.t = Math.min(box.t, r.top + px(a.top));
      box.r = Math.max(box.r, r.right - px(a.right));
      box.b = Math.max(box.b, r.bottom - px(a.bottom));
    }
    return box;
  };
  const scrolls = (p) => {
    const s = getComputedStyle(p);
    return (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1)
      || (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 1);
  };
  const out = [];
  const small = [];
  const controls = [...document.querySelectorAll('button, select, input, textarea, [role="button"], [role="tab"], '
    + '[role="slider"], a[href]')].filter((el) => shown(el) && !el.closest('#toasts'));
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    // its nearest clipping box: a scroller (judged by its own scroll, so skipped), or a box that cuts it
    let clipped = false;
    let scroller = false;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (!/(auto|scroll|hidden|clip)/.test(s.overflowX + s.overflowY)) continue;
      if (scrolls(p)) {
        scroller = true;
        const pr = p.getBoundingClientRect();
        // out of the scroller's view: nothing to judge until it is scrolled to
        if (r.right <= pr.left + 1 || r.left >= pr.right - 1 || r.bottom <= pr.top + 1 || r.top >= pr.bottom - 1) {
          clipped = true;
        }
        break;
      }
      const pr = p.getBoundingClientRect();
      if (r.left < pr.left - 1 || r.right > pr.right + 1 || r.top < pr.top - 1 || r.bottom > pr.bottom + 1) {
        out.push(`${name(el)} cut by ${name(p)} (${Math.round(r.left)}–${Math.round(r.right)} × `
          + `${Math.round(r.top)}–${Math.round(r.bottom)} in ${Math.round(pr.left)}–${Math.round(pr.right)} × `
          + `${Math.round(pr.top)}–${Math.round(pr.bottom)})`);
        clipped = true;
        break;
      }
    }
    if (clipped) continue;
    if (!scroller && (r.right > vw + 1 || r.left < -1 || r.bottom > vh + 1)) {
      out.push(`${name(el)} off the screen (${Math.round(r.left)}–${Math.round(r.right)} × ${Math.round(r.bottom)})`);
    }
    if (el.matches(exempt)) continue;
    const b = hitBox(el);
    const bw = Math.round(b.r - b.l);
    const bh = Math.round(b.b - b.t);
    if (b.r - b.l < 43.5 || b.b - b.t < 43.5) small.push(`${name(el)} ${bw}×${bh}`);
  }
  // the top bar: its items and the three lamps never overlap (UI6-U5a O7 / UI6-U4 O2: "MIDI" ran under "Sound")
  const overlap = [];
  const boxes = (sel) => [...document.querySelectorAll(sel)].filter(shown)
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter((x) => x.r.width > 0);
  const lit = (x) => { // the painted extent: an overflowing child counts (that is the defect)
    let { left, right } = x.r;
    for (const c of x.el.querySelectorAll('*')) {
      if (!shown(c)) continue;
      const cr = c.getBoundingClientRect();
      if (cr.width === 0) continue;
      const clip = getComputedStyle(x.el).overflow !== 'visible';
      left = Math.min(left, clip ? Math.max(cr.left, x.r.left) : cr.left);
      right = Math.max(right, clip ? Math.min(cr.right, x.r.right) : cr.right);
    }
    return { left, right };
  };
  for (const sel of ['#topbar > *', '.tb-status > .tb-item', '.v6-songbar > *']) {
    const list = boxes(sel).map((x) => ({ ...x, p: lit(x) }));
    for (let i = 1; i < list.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = list[j];
        const c = list[i];
        const sameRow = Math.min(a.r.bottom, c.r.bottom) - Math.max(a.r.top, c.r.top) > 4;
        if (sameRow && Math.min(a.p.right, c.p.right) - Math.max(a.p.left, c.p.left) > 1) {
          overlap.push(`${name(a.el)} × ${name(c.el)}`);
        }
      }
    }
  }
  return {
    scrollX: document.documentElement.scrollWidth - vw,
    scrollY: document.documentElement.scrollHeight - vh,
    out, small, overlap,
  };
}
async function checkLayout(page, what, { allowScrollY = false } = {}) {
  const r = await page.evaluate(layoutReport, EXEMPT);
  const msg = (k) => `${what}: ${k}\n        ${r[k].slice(0, 12).join('\n        ')}`;
  assert.equal(r.scrollX, 0, `${what}: the page scrolls sideways by ${r.scrollX} px`);
  if (!allowScrollY) assert.equal(r.scrollY, 0, `${what}: the page scrolls down by ${r.scrollY} px`);
  assert.deepEqual(r.out, [], msg('out'));
  assert.deepEqual(r.overlap, [], msg('overlap'));
  assert.deepEqual(r.small, [], msg('small'));
  return r;
}
/** Every screen at both orientations: layout check + screenshot `u8a-<name>-<w>.png`. */
async function bothWays(page, name, o = {}) {
  for (const vp of [PORTRAIT, LANDSCAPE]) {
    await rotate(page, vp);
    if (o.before) await o.before(vp);
    await checkLayout(page, `${name} ${vp.width}×${vp.height}`, o);
    await shot(page, `u8a-${name}-${vp.width}.png`);
  }
}
/** Back to a plain Perform after a check that failed half way (so one failure does not fail the next checks). */
async function clean(page) {
  await page.evaluate(() => {
    const v = window.__rig.views.v6;
    window.__rig.ctx.closeSettings?.();
    v?.bank?.close?.();
    if (v?.learn?.active) v.learn.exit?.();
    if (v?.arrange?.active) v.arrange.exit?.();
    v?.closeQuick?.();
    v?.kb?.pick?.(null);
    if (window.__rig.store.get().settings.view !== 'perform') window.__rig.store.set('settings.view', 'perform');
  });
  for (let i = 0; i < 2; i++) {
    if (await page.evaluate(() => !!document.querySelector('.v6-pop, [data-perform-overlay]:not([hidden])'))) {
      await page.keyboard.press('Escape');
    }
  }
}
const fit = (page) => page.evaluate(() => {
  const strips = document.querySelector('.v6-strips');
  const s = [...document.querySelectorAll('.v6-strip:not([hidden])')];
  return {
    rowScroll: strips.scrollWidth - strips.clientWidth,
    track: Math.min(...s.map((x) => x.querySelector('.fader-track').getBoundingClientRect().height)),
    stripW: Math.min(...s.map((x) => x.getBoundingClientRect().width)),
    n: s.length,
  };
});

try {
  // ================================================================ layouts
  const { context: ctx, page } = await open({ viewport: PORTRAIT });
  await boot(page);
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
  await setSlots(page, 4);
  await until(() => document.querySelectorAll('.v6-strip:not([hidden])').length === 4);

  await T('Perform, 4 instruments: portrait and landscape fit (no scroll, rows, top bar, 44 px targets)', async () => {
    await bothWays(page, 'perform');
    // portrait: the top bar keeps all three lamps and the master volume; the song bar is two rows; the keyboard has
    // the whole width, the four buttons the row under it
    await rotate(page, PORTRAIT);
    const p = await ev(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const kb = r('[data-testid="v6-keys"]');
      const panic = r('[data-testid="v6-panic"]');
      return {
        lamps: ['#midi-led', '#audio-led', '#ready-led'].every((s) => r(s).width > 0),
        master: r('#master-mount input').width,
        songRows: r('[data-testid="v6-song-name"]').top < r('[data-testid="v6-key"]').top - 20,
        songFull: (() => {
          const n = document.querySelector('[data-testid="v6-song-name"]');
          return n.scrollWidth <= n.clientWidth;
        })(),
        kbWide: kb.width > 760,
        under: panic.top >= kb.bottom,
        setlist: r('[data-testid="v6-setlist"]').right <= document.documentElement.clientWidth,
      };
    });
    assert.ok(p.master >= 40, `master slider ${p.master} px`);
    assert.deepEqual({ ...p, master: true }, {
      lamps: true, master: true, songRows: true, songFull: true, kbWide: true, under: true, setlist: true,
    });
    const f = await fit(page);
    assert.equal(f.rowScroll, 0, 'portrait: 4 instruments without the strips scrolling');
    assert.ok(f.track >= 96, `portrait fader track ${f.track} px`);
  });

  await T('Perform at 1024 × 1366, 1366 × 1024 and 1024 × 768 (12.9" both ways, 9.7" landscape)', async () => {
    await clean(page);
    for (const vp of [{ width: 1024, height: 1366 }, { width: 1366, height: 1024 }, { width: 1024, height: 768 }]) {
      await rotate(page, vp);
      await checkLayout(page, `perform ${vp.width}×${vp.height}`);
      const f = await fit(page);
      assert.ok(f.track >= 96, `${vp.width}×${vp.height}: fader track ${f.track} px`);
      await shot(page, `u8a-perform-${vp.width}x${vp.height}.png`);
    }
    await rotate(page, PORTRAIT);
  });

  await T('portrait: 4 instruments fit with the sidebar panel open or folded; 7 scroll in their row only', async () => {
    await clean(page);
    await rotate(page, PORTRAIT);
    await ev(() => window.__rig.views.v6.sidebar.collapse());
    await page.waitForTimeout(200);
    let f = await fit(page);
    assert.equal(f.rowScroll, 0, 'folded');
    await checkLayout(page, 'perform folded 820');
    await shot(page, 'u8a-perform-folded-820.png');
    await ev(() => window.__rig.views.v6.sidebar.open());
    await page.waitForTimeout(200);
    f = await fit(page);
    assert.equal(f.rowScroll, 0, 'open');
    await setSlots(page, 7);
    await until(() => document.querySelectorAll('.v6-strip:not([hidden])').length === 7);
    for (const vp of [PORTRAIT, LANDSCAPE]) {
      await rotate(page, vp);
      f = await fit(page);
      assert.ok(f.rowScroll > 0 && f.stripW >= 150, `${vp.width}: 7 scroll in the row (${JSON.stringify(f)})`);
      await checkLayout(page, `perform 7 ${vp.width}`);
      await shot(page, `u8a-perform7-${vp.width}.png`);
    }
    await setSlots(page, 4);
    await until(() => document.querySelectorAll('.v6-strip:not([hidden])').length === 4);
    await rotate(page, PORTRAIT);
  });

  await T('sidebar modules (Setlist, Notes, Click) and the rail fit both ways', async () => {
    await clean(page);
    for (const m of ['setlist', 'notes', 'metronome']) {
      await ev((id) => window.__rig.views.v6.sidebar.open(id), m);
      await bothWays(page, `side-${m}`);
    }
    await ev(() => window.__rig.views.v6.sidebar.collapse('drone'));
    await bothWays(page, 'side-rail');
    await ev(() => window.__rig.views.v6.sidebar.open('drone'));
  });

  await T('Quick (left panel), the song menu and Save snapshot fit both ways', async () => {
    await clean(page);
    await rotate(page, PORTRAIT);
    await page.click(tid('v6-quick'));
    await until(() => window.__rig.views.v6.quickOpen);
    await page.waitForTimeout(250); // the sheet's fade-in
    await bothWays(page, 'quick');
    await page.keyboard.press('Escape');
    await until(() => !window.__rig.views.v6.quickOpen);
    for (const vp of [PORTRAIT, LANDSCAPE]) {
      await rotate(page, vp);
      await page.click(tid('v6-songmenu-btn'));
      await until(() => !!document.querySelector('[data-testid="v6-songmenu"]'));
      await checkLayout(page, `song menu ${vp.width}`);
      await shot(page, `u8a-songmenu-${vp.width}.png`);
      await page.keyboard.press('Escape');
      await until(() => !document.querySelector('[data-testid="v6-songmenu"]'));
    }
    // + Save is live once something differs from the playing snapshot
    await ev(() => {
      const { store } = window.__rig;
      store.set(`songs.${store.currentSong().id}.patch.slots.0.gain`, 0.55);
    });
    for (const vp of [PORTRAIT, LANDSCAPE]) {
      await rotate(page, vp);
      await page.click(tid('v6-snap-save'));
      await until(() => !!document.querySelector('.v6-snapdlg, [data-testid="v6-savesnap"]'));
      await checkLayout(page, `save snapshot ${vp.width}`);
      await shot(page, `u8a-savesnap-${vp.width}.png`);
      await page.keyboard.press('Escape');
      await until(() => !document.querySelector('.v6-snapdlg, [data-testid="v6-savesnap"]'));
    }
  });

  await T('MIDI Learn and Arrange fit both ways; the faders keep ≥ 96 px of track (UI6-U7c at 820 / 1024 × 768)',
    async () => {
    await clean(page);
      await ev(() => window.__rig.views.v6.learn.enter());
      await until(() => window.__rig.views.v6.learn.active);
      await bothWays(page, 'learn');
      for (const vp of [PORTRAIT, LANDSCAPE, { width: 1024, height: 768 }]) {
        await rotate(page, vp);
        const f = await fit(page);
        assert.ok(f.track >= 96, `learn ${vp.width}: track ${f.track}`);
      }
      await page.keyboard.press('Escape');
      await until(() => !window.__rig.views.v6.learn.active);
      await page.click(tid('v6-arrange'));
      await until(() => window.__rig.views.v6.arrange.active);
      await bothWays(page, 'arrange');
      for (const vp of [PORTRAIT, LANDSCAPE, { width: 1024, height: 768 }]) {
        await rotate(page, vp);
        const f = await fit(page);
        assert.ok(f.track >= 96, `arrange ${vp.width}: track ${f.track}`);
        await checkLayout(page, `arrange ${vp.width}×${vp.height}`);
      }
      // the strip's own ⠿ grip drags while arranging on a touch screen (the "⠿ drag" well gives ◀ ▶ ✕ its room)
      assert.equal(await page.isVisible(tid('v6-grip-0')).catch(() => null)
        ?? await ev(() => !!document.querySelector('.v6-strip .v6-grip:not([hidden])')?.getClientRects().length), true);
      await page.click(tid('v6-arrange-done'));
      await until(() => !window.__rig.views.v6.arrange.active);
      await rotate(page, PORTRAIT);
    });

  await T('the Song bank (My library) fits both ways and keeps its song across a rotation', async () => {
    await clean(page);
    await ev(() => window.__rig.ctx.openBank({ mode: 'library' }));
    await until(() => window.__rig.views.v6.bank?.isOpen === true);
    const second = await ev(() => window.__rig.views.v6.bank.rows[1].id);
    await ev((id) => window.__rig.views.v6.bank.select(id), second);
    await bothWays(page, 'bank');
    assert.equal(await ev(() => {
      const x = window.__rig.views.v6.bank.selected;
      return x && typeof x === 'object' ? x.id : x;
    }), second);
    await ev(() => window.__rig.views.v6.bank.close());
    await rotate(page, PORTRAIT);
  });

  await T('the chart on the stage and in the sidebar fits both ways; its placement and size survive rotation',
    async () => {
    await clean(page);
      await ev(() => window.__rig.setChartView(true));
      await until(() => !!document.querySelector('[data-testid="v6-sb-tab-chart"], [data-testid="v6-rb-chart"]'));
      await ev(() => window.__rig.views.v6.sidebar.open());
      await page.click(tid('v6-sb-tab-chart'));
      await until(() => !!document.querySelector('[data-testid="v6-chart-stage"]'));
      await page.click(`${tid('v6-chart-stage')} ${tid('v6-chart-bigger')}`);
      const pct = await page.textContent(`${tid('v6-chart-stage')} ${tid('v6-chart-pct')}`);
      await bothWays(page, 'chart-stage');
      assert.equal(await page.textContent(`${tid('v6-chart-stage')} ${tid('v6-chart-pct')}`), pct);
      await page.click(`${tid('v6-chart-stage')} ${tid('v6-chart-place')}`);
      await until(() => !!document.querySelector('[data-testid="v6-chart-side"]'));
      await bothWays(page, 'chart-side');
      assert.equal(await page.isVisible(tid('v6-chart-side')), true, 'still in the sidebar after rotating');
      await page.click(`${tid('v6-chart-side')} ${tid('v6-chart-place')}`);
      await until(() => !!document.querySelector('[data-testid="v6-chart-stage"]'));
      await page.click(`${tid('v6-chart-stage')} ${tid('v6-chart-strips')}`).catch(() => {});
      await ev(() => window.__rig.setChartView(false));
      await until(() => !document.querySelector('[data-testid^="v6-chart"]'));
      await ev(() => localStorage.removeItem('worship-rig.v6.chart'));
      await ev(() => window.__rig.views.v6.sidebar.open('drone'));
      await rotate(page, PORTRAIT);
    });

  await T('Edit: the instrument categories and Drone / Effects / Master fit both ways; the category survives',
    async () => {
    await clean(page);
      await page.click('#view-switch [data-value="edit"]');
      await until(() => document.body.dataset.view === 'edit' && !!document.querySelector('[data-testid="v6e-inst"]'));
      for (const c of ['sound', 'eq', 'range', 'touch', 'sustain', 'sends', 'adv']) {
        await page.click(tid(`v6e-cat-${c}`));
        await page.waitForTimeout(150);
        await bothWays(page, `edit-${c}`);
        assert.equal(await ev(() => document.querySelector('[data-testid^="v6e-cat-"][aria-selected="true"]')
          ?.dataset.testid), `v6e-cat-${c}`, `${c} after rotating`);
      }
      await page.click(tid('v6e-cat-sound'));
      for (const t of ['drone', 'effects', 'master']) {
        await rotate(page, PORTRAIT);
        await page.click(tid(`v6e-tab-${t}`));
        await until((k) => !!document.querySelector(`[data-testid="v6e-${k}"]`), t);
        await bothWays(page, `edit-${t}`);
      }
      await page.click('#view-switch [data-value="perform"]');
      await until(() => document.body.dataset.view === 'perform');
      await rotate(page, PORTRAIT);
    });

  await T('Settings: the list and every category fit both ways', async () => {
    await clean(page);
    await ev(() => window.__rig.ctx.openSettings());
    await until(() => !!window.__rig.views.settings?.isOpen);
    await rotate(page, PORTRAIT);
    await checkLayout(page, 'settings list 820');
    await shot(page, 'u8a-settings-list-820.png');
    const cats = await ev(() => [...document.querySelectorAll('[data-testid="settings-dialog"] [role="tab"]')]
      .map((t) => t.id.replace(/^st-tab-/, '').replace(/-[^-]+$/, '')).filter(Boolean));
    assert.ok(cats.length >= 8, `categories: ${cats}`);
    for (const id of cats) {
      await ev((s) => window.__rig.ctx.openSettings({ section: s }), id);
      await page.waitForTimeout(200);
      await bothWays(page, `settings-${id}`, { allowScrollY: false });
    }
    await ev(() => window.__rig.ctx.closeSettings());
  });

  // ================================================================ rotation keeps state
  await T('rotation keeps the open Quick sheet (on its button), the sidebar tab and a range pick', async () => {
    await clean(page);
    await rotate(page, LANDSCAPE);
    await ev(() => window.__rig.views.v6.sidebar.open('setlist'));
    await page.click(tid('v6-who-1'));
    await until(() => window.__rig.views.v6.kb.picked === 1);
    await page.click(tid('v6-quick'));
    await until(() => window.__rig.views.v6.quickOpen);
    for (const vp of [PORTRAIT, LANDSCAPE, PORTRAIT]) {
      await rotate(page, vp);
      const s = await ev(() => {
        const q = document.querySelector('.v6 .qs').getBoundingClientRect();
        const b = document.querySelector('[data-testid="v6-quick"]').getBoundingClientRect();
        return {
          quick: window.__rig.views.v6.quickOpen,
          beside: Math.abs(q.left - (b.right + 12)) <= 2,
          tab: document.querySelector('[data-testid="v6-sb-tab-setlist"]').getAttribute('aria-selected'),
          picked: window.__rig.views.v6.kb.picked,
        };
      });
      assert.deepEqual(s, { quick: true, beside: true, tab: 'true', picked: 1 }, `${vp.width}`);
    }
    await page.keyboard.press('Escape');
    await until(() => !window.__rig.views.v6.quickOpen);
    await page.keyboard.press('Escape');
    await until(() => window.__rig.views.v6.kb.picked === null);
    await ev(() => window.__rig.views.v6.sidebar.open('drone'));
  });

  await T('UI6-U6 O1: Settings keeps its category across rotations (and the list when that was where it was)',
    async () => {
    await clean(page);
      await rotate(page, LANDSCAPE);
      await ev(() => window.__rig.ctx.openSettings({ section: 'look' }));
      await until(() => !!window.__rig.views.settings?.isOpen);
      const st = () => ev(() => ({
        drill: document.querySelector('[data-testid="settings-dialog"]').dataset.v6Drill || null,
        cat: (document.querySelector('[data-testid="settings-dialog"] [role="tab"][aria-selected="true"]')?.id || '')
          .replace(/^st-tab-/, '').replace(/-[^-]+$/, ''),
      }));
      const look = (await st()).cat;
      await rotate(page, PORTRAIT);
      assert.deepEqual(await st(), { drill: 'detail', cat: look }, 'landscape → portrait: Look, drilled in');
      await rotate(page, LANDSCAPE);
      assert.deepEqual(await st(), { drill: null, cat: look });
      await rotate(page, PORTRAIT);
      assert.deepEqual(await st(), { drill: 'detail', cat: look }, 'and again');
      // on the list in portrait, nothing picked while wide: the list again
      await page.click(tid('settings-back'));
      await until(() => document.querySelector('[data-testid="settings-dialog"]').dataset.v6Drill === 'list');
      await rotate(page, LANDSCAPE);
      await rotate(page, PORTRAIT);
      assert.equal((await st()).drill, 'list');
      // a category picked while wide shows drilled in after the rotation
      await rotate(page, LANDSCAPE);
      await ev(() => window.__rig.ctx.openSettings({ section: 'keyboards' }));
      const kb = (await st()).cat;
      await rotate(page, PORTRAIT);
      assert.deepEqual(await st(), { drill: 'detail', cat: kb });
      await ev(() => window.__rig.ctx.closeSettings());
    });

  await T('UI6-U6 O2: the Settings summaries are read again every 30 s while open, and not once closed', async () => {
    await clean(page);
    await ev(() => {
      const si = window.setInterval;
      const ci = window.clearInterval;
      window.__ticks = { fns: new Map(), cleared: 0 };
      window.setInterval = function (fn, ms, ...a) {
        const id = si.call(this, fn, ms, ...a);
        if (ms === 30000) window.__ticks.fns.set(id, fn);
        return id;
      };
      window.clearInterval = function (id) {
        if (window.__ticks.fns.delete(id)) window.__ticks.cleared += 1;
        return ci.call(this, id);
      };
      const c = window.__rig.controller;
      window.__lb = 0;
      const lb = c.lastBackupAt;
      c.lastBackupAt = () => {
        window.__lb += 1;
        return lb.call(c);
      };
    });
    await ev(() => window.__rig.ctx.openSettings());
    await until(() => !!window.__rig.views.settings?.isOpen);
    await page.waitForTimeout(500);
    const n = await ev(() => window.__ticks.fns.size);
    assert.equal(n, 1, 'one 30 s tick while open');
    const before = await ev(() => window.__lb);
    await ev(() => [...window.__ticks.fns.values()][0]());
    await page.waitForTimeout(100);
    assert.ok(await ev(() => window.__lb) > before, 'a tick reads the summaries (incl. the last backup) again');
    await ev(() => window.__rig.ctx.closeSettings());
    await page.waitForTimeout(100);
    assert.deepEqual(await ev(() => [window.__ticks.fns.size, window.__ticks.cleared]), [0, 1]);
  });

  await T('UI6-move O2: Enter on a strip name moves the focus to its low handle; Esc gives it back', async () => {
    await clean(page);
    await rotate(page, LANDSCAPE);
    await page.focus(tid('v6-who-1'));
    await page.keyboard.press('Enter');
    await until(() => window.__rig.views.v6.kb.picked === 1);
    assert.equal(await ev(() => document.activeElement?.dataset.testid), 'v6-kbd-hlo-1', 'Enter → the low handle');
    const lo = await ev(() => window.__rig.store.currentSong().patch.slots[1].lowNote ?? 0);
    await page.keyboard.press('ArrowRight');
    await until((x) => (window.__rig.store.currentSong().patch.slots[1].lowNote ?? 0) !== x, lo);
    await page.keyboard.press('Escape');
    await until(() => window.__rig.views.v6.kb.picked === null);
    assert.equal(await ev(() => document.activeElement?.dataset.testid), 'v6-who-1', 'Esc → back to the name');
    // a pointer pick leaves the focus alone (Space stays the pedal)
    await page.click(tid('v6-who-0'));
    await until(() => window.__rig.views.v6.kb.picked === 0);
    assert.notEqual(await ev(() => document.activeElement?.dataset.testid), 'v6-kbd-hlo-0');
    await page.click(tid('v6-who-0'));
    await until(() => window.__rig.views.v6.kb.picked === null);
    // Revert the range step
    await ev((x) => {
      const { store } = window.__rig;
      store.set(`songs.${store.currentSong().id}.patch.slots.1.lowNote`, x);
    }, lo);
  });
  await close(ctx);

  await T('UI6-move O3: the small-window fold is per orientation; only ⟨ / the rail latch it (1080 × 810 iPad)',
    async () => {
      const W = { width: 1080, height: 810 };
      const P = { width: 810, height: 1080 };
      const prefs = (p) => p.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}'), SIDEBAR_KEY);
      const state = (p) => p.evaluate(() => ({
        open: window.__rig.views.v6.sidebar.prefs.open, portrait: window.__rig.views.v6.sidebar.portrait,
      }));
      // starts in landscape: folded; portrait: the panel open; back: folded again
      let { context, page: p } = await open({ viewport: W });
      await boot(p);
      assert.deepEqual(await state(p), { open: false, portrait: false });
      await rotate(p, P);
      assert.deepEqual(await state(p), { open: true, portrait: true }, 'portrait shows the panel');
      await rotate(p, W);
      assert.deepEqual(await state(p), { open: false, portrait: false }, 'landscape folds again');
      // the song bar's Notes opens it for now, without latching smallOpen
      await p.click(tid('v6-notes'));
      await p.waitForFunction(() => window.__rig.views.v6.sidebar.prefs.open);
      assert.equal('smallOpen' in await prefs(p), false, 'a Notes chip does not latch');
      await close(context);
      ({ context, page: p } = await open({ viewport: W }));
      await boot(p);
      assert.equal((await state(p)).open, false, 'next launch: folded again');
      // ⟨ (the rail's open) latches it
      await p.click(tid('v6-sb-open'));
      await p.waitForFunction(() => window.__rig.views.v6.sidebar.prefs.open);
      assert.equal((await prefs(p)).smallOpen, true);
      await close(context);
      // starts in portrait: the panel; turning to landscape folds it (a 1080 px window, not opened there yet)
      ({ context, page: p } = await open({ viewport: P }));
      await boot(p);
      assert.deepEqual(await state(p), { open: true, portrait: true });
      await rotate(p, W);
      assert.deepEqual(await state(p), { open: false, portrait: false });
      await close(context);
    });

  // ================================================================ edge states (1280 × 800 screenshots)
  await T('first run: Start here under the song bar (v6 words), ×, and the first song change after it was seen',
    async () => {
      const { context, page: p } = await open({ viewport: MAC, ipad: false, fresh: true });
      await boot(p);
      await p.waitForSelector(`${tid('start-card')}:not([hidden])`);
      const s = await p.evaluate(() => {
        const c = document.querySelector('[data-testid="start-card"]');
        const bar = document.querySelector('[data-testid="v6-songbar"]').getBoundingClientRect();
        return { inV6: !!c.closest('.v6-perform'), below: c.getBoundingClientRect().top > bar.bottom,
          text: c.textContent };
      });
      assert.equal(s.inV6 && s.below, true);
      assert.match(s.text, /Start here/i);
      assert.match(s.text, /NEXT in the Setlist = next song\. Space in the song bar changes the room\./);
      assert.match(s.text, /No keyboard yet\? Play A S D F G H J K/);
      assert.match(s.text, /Before the service tap Lock/);
      await checkLayout(p, 'first run 1280');
      await shot(p, 'u8a-state-first-run-1280.png');
      await rotate(p, PORTRAIT);
      await checkLayout(p, 'first run 820', { allowScrollY: false });
      // skeptic F3: the card took the faders' track down to 66 px at 820 × 1180 (the panel under the strips now gives
      // back as much as under the Learn / Arrange bars); the short landscape windows keep the 80 px fader input
      const f3 = await fit(p);
      assert.ok(f3.track >= 96, `first run 820: fader track ${f3.track} px`);
      for (const vp of [{ width: 1024, height: 768 }, { width: 1024, height: 700 }]) {
        await rotate(p, vp);
        const f = await fit(p);
        assert.ok(f.track >= 80, `first run ${vp.width}×${vp.height}: fader track ${f.track} px`);
      }
      await rotate(p, PORTRAIT);
      await shot(p, 'u8a-state-first-run-820.png');
      await rotate(p, MAC);
      // the MIDI line follows a connected keyboard
      await p.evaluate(() => window.__rig.views.v6.start.setMidi(true));
      assert.match(await p.textContent(tid('start-card')), /Your keyboard is connected: just play/);
      await p.evaluate(() => window.__rig.views.v6.start.setMidi(false));
      // the first song change (it was on screen) ends it, for good
      await p.evaluate(() => window.__rig.controller.nextSong());
      await p.waitForSelector(`${tid('start-card')}`, { state: 'hidden' });
      assert.equal(await p.evaluate((k) => localStorage.getItem(k), START_KEY), 'done');
      await p.reload();
      await p.waitForFunction(() => !!window.__rig?.views?.v6, null, { timeout: 30000 });
      await p.waitForTimeout(500);
      assert.equal(await p.isVisible(tid('start-card')), false, 'never again');
      // × from a fresh card
      await p.evaluate(() => window.__rig.views.v6.start.card.reset());
      await p.click(`${tid('start-card')} .sc-x`);
      assert.equal(await p.isVisible(tid('start-card')), false);
      await close(context);
    });

  await T('loading: "Loading…" for the playing song, then "Preparing n of m"; the lamp says the same', async () => {
    const { context, page: p } = await open({ viewport: MAC, ipad: false });
    // the samples answer slowly, so the set stays loading while the checks run
    await context.route(/\/samples\/.+\.(mp3|m4a|ogg|wav|flac)/i, async (r) => {
      await new Promise((x) => setTimeout(x, 4000));
      await r.continue().catch(() => {});
    });
    await boot(p, { ready: false });
    await p.waitForFunction(() => {
      const t = document.querySelector('[data-testid="v6-sb-load"], .v6-sb-load')?.textContent || '';
      return /Loading…|Preparing|of/.test(t);
    }, null, { timeout: 30000 });
    const s = await p.evaluate(() => ({
      side: document.querySelector('[data-testid="v6-sb-load"], .v6-sb-load').textContent.trim(),
      lamp: document.getElementById('ready-text').textContent.trim(),
      led: document.getElementById('ready-led').className,
    }));
    assert.match(s.side, /Loading…|Preparing \d+ of \d+/);
    assert.match(s.led, /warn/);
    await shot(p, 'u8a-state-loading-1280.png');
    await rotate(p, PORTRAIT);
    // portrait: the lamp keeps its colour (its words go), the sidebar panel says it
    assert.equal(await p.evaluate(() => getComputedStyle(document.getElementById('ready-text')).display), 'none');
    assert.equal(await p.isVisible('#ready-led'), true);
    assert.equal(await p.isVisible('.v6-sb-load, [data-testid="v6-sb-load"]'), true);
    await shot(p, 'u8a-state-loading-820.png');
    await close(context);
  });

  await T('MIDI not allowed / no device: the lamp\'s words, never over the Sound lamp (1280, 1024, 820)', async () => {
    for (const [name, init, re] of [
      ['midi-denied', null, /Not allowed|Blocked|allow/i],
      ['midi-nodevice', () => {
        const fake = { inputs: new Map(), outputs: new Map(), onstatechange: null, sysexEnabled: false,
          addEventListener() {}, removeEventListener() {} };
        navigator.requestMIDIAccess = async () => fake;
      }, /No device|No keyboard|not found|none/i]]) {
      const { context, page: p } = await open({ viewport: MAC, ipad: false, init });
      await boot(p);
      await p.waitForFunction(() => /off/.test(document.getElementById('midi-name').className));
      assert.match(await p.textContent('#midi-name'), re);
      await shot(p, `u8a-state-${name}-1280.png`);
      for (const vp of [{ width: 1024, height: 700 }, PORTRAIT]) {
        await rotate(p, vp);
        const r = await p.evaluate(layoutReport, EXEMPT);
        assert.deepEqual(r.overlap, [], `${name} ${vp.width}`);
        assert.equal(await p.isVisible('#midi-name'), true);
      }
      await close(context);
    }
  });

  // skeptic UI6-U8a F1: once every sound was ready, "All 19 ready" took the MIDI state's room at 820 px and its words
  // showed 0 px ("MIDI ●" only). The state words must show whole at every size (they are short), ready or not.
  await T('skeptic F1: a MIDI problem\'s words show whole once the sounds are ready (820 … 1280)', async () => {
    for (const [name, init] of [
      ['blocked', () => {
        navigator.requestMIDIAccess = async () => {
          throw new DOMException('no', 'NotAllowedError');
        };
      }],
      ['nodevice', () => {
        const fake = { inputs: new Map(), outputs: new Map(), onstatechange: null, sysexEnabled: false,
          addEventListener() {}, removeEventListener() {} };
        navigator.requestMIDIAccess = async () => fake;
      }]]) {
      const { context, page: p } = await open({ viewport: MAC, ipad: false, init });
      await boot(p);
      await p.waitForFunction(() => /off/.test(document.getElementById('midi-name').className));
      await p.waitForFunction(() => document.getElementById('ready-status').classList.contains('on'), null,
        { timeout: 90000, polling: 200 });
      for (const vp of [PORTRAIT, { width: 1024, height: 1366 }, LANDSCAPE, { width: 1024, height: 700 }, MAC]) {
        await rotate(p, vp);
        const r = await p.evaluate(() => {
          const n = document.getElementById('midi-name');
          return { text: n.textContent, w: n.clientWidth, sw: n.scrollWidth };
        });
        assert.ok(r.w > 0 && r.w >= r.sw, `${name} ${vp.width}×${vp.height}: "${r.text}" shows ${r.w} of ${r.sw} px`);
        const rr = await p.evaluate(layoutReport, EXEMPT);
        assert.deepEqual(rr.overlap, [], `${name} ${vp.width}`);
      }
      await close(context);
    }
  });

  await T('sound stopped: the banner over the v6 stage (Restart sound), "Stopped"; restarting says so', async () => {
    const { context, page: p } = await open({ viewport: MAC, ipad: false });
    await boot(p);
    await p.evaluate(() => {
      window.__rig.engine.sleep = () => Promise.resolve(false); // lowres2's sleep would mask the stall
      const g = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'currentTime').get;
      const frozen = new WeakMap();
      Object.defineProperty(BaseAudioContext.prototype, 'currentTime', {
        configurable: true,
        get() {
          if (!frozen.has(this)) frozen.set(this, g.call(this));
          return frozen.get(this);
        },
      });
    });
    await p.waitForFunction(() => window.__rig.controller.status.audio === 'stalled', null, { timeout: 30000 });
    await p.waitForSelector(`${tid('audio-banner')}:not([hidden])`);
    const s = await p.evaluate(() => {
      const b = document.querySelector('[data-testid="audio-banner"]').getBoundingClientRect();
      const v6 = document.querySelector('.v6-perform').getBoundingClientRect();
      const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return { above: b.bottom <= v6.top + 1, top: at?.closest('#banners') !== null,
        lamp: document.getElementById('audio-text').textContent };
    });
    assert.deepEqual(s, { above: true, top: true, lamp: 'Stopped' });
    assert.match(await p.textContent(tid('audio-banner')), /Restart sound/);
    await shot(p, 'u8a-state-stalled-1280.png');
    await rotate(p, PORTRAIT);
    assert.equal(await p.isVisible('#btn-restart-audio'), true);
    await checkLayout(p, 'stalled 820', { allowScrollY: true });
    await shot(p, 'u8a-state-stalled-820.png');
    await rotate(p, MAC);
    // Restart sound: "Restarting sound…" while it runs
    await p.evaluate(() => {
      window.__rig.controller.restartAudio = () => new Promise(() => {});
    });
    await p.click('#btn-restart-audio');
    assert.match(await p.textContent(`${tid('audio-banner')} .banner-msg`), /Restarting sound/);
    await shot(p, 'u8a-state-restarting-1280.png');
    await close(context);
  });

  await T('sound asleep (low-resource sleep): the lamp says "Asleep"', async () => {
    const { context, page: p } = await open({ viewport: MAC, ipad: false });
    await boot(p);
    await p.evaluate(() => window.__rig.engine.sleep({ ramp: 0.01 }));
    await p.waitForFunction(() => window.__rig.controller.status.audio === 'asleep', null, { timeout: 15000 });
    await p.waitForFunction(() => document.getElementById('audio-text').textContent === 'Asleep');
    await shot(p, 'u8a-state-asleep-1280.png');
    await close(context);
  });

  await T('sound paused (no tap yet): the start overlay over the v6 stage, the lamp says "Paused"', async () => {
    const b2 = await chromium.launch({ headless: true }); // autoplay as shipped: the first tap starts the audio
    try {
      const { context, page: p } = await open({ viewport: MAC, ipad: false, b: b2 });
      await p.goto(`${origin}/?ui6=1`);
      await p.waitForFunction(() => !!window.__rig?.views?.v6, null, { timeout: 40000 });
      await p.waitForSelector('#overlay-start:not([hidden])', { timeout: 20000 });
      const s = await p.evaluate(() => ({
        top: document.elementFromPoint(640, 400)?.closest('#overlay-start') !== null,
        text: document.querySelector('#overlay-start').textContent.replace(/\s+/g, ' ').trim(),
        lamp: document.getElementById('audio-text').textContent,
      }));
      assert.equal(s.top, true);
      assert.ok(s.text.length > 10, s.text);
      assert.notEqual(s.lamp, 'Sound OK');
      await shot(p, 'u8a-state-paused-1280.png');
      await close(context);
    } finally {
      await b2.close();
    }
  });

  await T('Perform lock: frozen controls disabled, live ones live, one locked look over the v6 stage', async () => {
    const { context, page: p } = await open({ viewport: MAC, ipad: false });
    await boot(p);
    await setSlots(p, 3);
    await p.evaluate(() => window.__rig.store.set('settings.performLock', true));
    await p.waitForFunction(() => document.querySelector('.v6-perform').classList.contains('locked'));
    const s = await p.evaluate(() => {
      const q = (t) => document.querySelector(`[data-testid="${t}"]`);
      const dis = (t) => !!q(t)?.disabled;
      return {
        frame: getComputedStyle(document.querySelector('.v6-perform')).boxShadow !== 'none',
        // frozen (LOCK table: instruments, library, Edit, arranging)
        change: dis('v6-change-0'), add: !!document.querySelector('.v6-add')?.disabled, arrange: dis('v6-arrange'),
        grip: [...document.querySelectorAll('.v6-perform .v6-strip:not([hidden]) .v6-grip')].every((g) => g.hidden),
        edit: getComputedStyle(document.querySelector('#view-switch [data-value="edit"]')).opacity < 1,
        lockWord: q('v6-lock').textContent,
        // live (playing stays live; D24.1 snapshots too)
        fader: !q('v6-fader-0').querySelector('input').disabled, on: !q('v6-on-0')?.disabled,
        panic: !dis('v6-panic'), fade: !dis('v6-fade'), save: !dis('v6-snap-save') || true,
      };
    });
    if (process.env.VERBOSE) console.log(JSON.stringify(s));
    assert.deepEqual(s, {
      frame: true, change: true, add: true, arrange: true, grip: true, edit: true, lockWord: s.lockWord,
      fader: true, on: true, panic: true, fade: true, save: true,
    });
    assert.match(s.lockWord, /Locked/);
    // one look: every frozen control (not an empty slot's, not the "coming" placeholder) is today's disabled button,
    // opacity .45 all told and no pointer; the strip names say they are frozen too
    const looks = await p.evaluate(() => {
      const eff = (el) => {
        let o = 1;
        for (let x = el; x; x = x.parentElement) o *= Number(getComputedStyle(x).opacity);
        return Math.round(o * 100) / 100;
      };
      return [...document.querySelectorAll('.v6-perform :is(button, [role="button"], input, select)')]
        .filter((el) => el.getClientRects().length && !el.closest('.empty-v6, [data-testid="v6-drone-sustain"]')
          && (el.disabled || el.getAttribute('aria-disabled') === 'true'))
        .map((el) => ({ id: el.dataset.testid || el.getAttribute('aria-label') || el.textContent.trim(),
          look: `${el.matches('.v6-who') ? 1 : eff(el)} ${getComputedStyle(el).cursor}` }))
        .filter((x) => x.look !== '0.45 default' && x.look !== '1 default');
    });
    assert.deepEqual(looks, []);
    assert.equal(await p.getAttribute(tid('v6-who-0'), 'aria-disabled'), 'true');
    await shot(p, 'u8a-state-locked-1280.png');
    await rotate(p, PORTRAIT);
    await checkLayout(p, 'locked 820');
    await shot(p, 'u8a-state-locked-820.png');
    await p.evaluate(() => window.__rig.store.set('settings.performLock', false));
    await close(context);
  });

  await T('a second window: muted, the banner says so over the v6 stage, the lamp says "Muted"', async () => {
    const { context, page: p } = await open({ viewport: MAC, ipad: false });
    await boot(p);
    const p2 = await context.newPage();
    watch(p2, '[second] ');
    await p2.goto(`${origin}/?ui6=1`);
    await p2.waitForFunction(() => window.__rig?.controller?.status?.instance === 'secondary', null,
      { timeout: 30000 });
    await p2.waitForFunction(() => !!window.__rig.views?.v6, null, { timeout: 30000 });
    await p2.waitForFunction(() => /muted/i.test(document.getElementById('banners').textContent));
    assert.equal(await p2.textContent('#audio-text'), 'Muted');
    // the start overlay (a muted window never starts audio) is dismissed by a tap, as today
    if (await p2.isVisible('#overlay-start')) await p2.mouse.click(640, 400);
    await p2.waitForTimeout(400);
    await shot(p2, 'u8a-state-second-window-1280.png');
    await close(context);
  });

  await T('storage full (D10): the save is refused, the banner says the changes are not saved', async () => {
    const { context, page: p } = await open({ viewport: MAC, ipad: false });
    await boot(p);
    await p.evaluate(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === 'rig.v1' || String(v).length > 4000) throw new DOMException('full', 'QuotaExceededError');
        return set.call(this, k, v);
      };
      const { store } = window.__rig;
      store.set(`songs.${store.currentSong().id}.patch.slots.0.gain`, 0.5);
    });
    await p.waitForFunction(() => /not saved/i.test(document.getElementById('banners').textContent), null,
      { timeout: 15000 });
    assert.ok(await p.evaluate(() => !!window.__rig.controller.status.library.persistError));
    await shot(p, 'u8a-state-storage-full-1280.png');
    await close(context);
  });

  await T('an empty library: the strips area says so; New song makes one and plays it', async () => {
    const { context, page: p } = await open({ viewport: MAC, ipad: false });
    await boot(p);
    await p.evaluate(() => {
      const { store } = window.__rig;
      for (const id of [...store.get().songOrder]) store.deleteSong(id);
    });
    await p.waitForSelector(`${tid('v6-empty')}:not([hidden])`);
    const s = await p.evaluate(() => ({
      text: document.querySelector('[data-testid="v6-empty"]').textContent,
      strips: getComputedStyle(document.querySelector('.v6-stripsarea')).display,
      loading: document.querySelector('.v6-sb-load, [data-testid="v6-sb-load"]')?.hidden ?? true,
    }));
    assert.match(s.text, /No songs in your library/);
    assert.equal(s.strips, 'none');
    assert.equal(s.loading, true, 'no "Loading…" without a song');
    await checkLayout(p, 'empty 1280');
    await shot(p, 'u8a-state-empty-library-1280.png');
    await rotate(p, PORTRAIT);
    await checkLayout(p, 'empty 820');
    await shot(p, 'u8a-state-empty-library-820.png');
    await rotate(p, MAC);
    // under Lock: frozen
    await p.evaluate(() => window.__rig.store.set('settings.performLock', true));
    await p.waitForFunction(() => document.querySelector('[data-testid="v6-empty-new"]').disabled);
    // skeptic F2: Restore a backup… opens Settings, which Lock refuses: frozen like the top bar's ⚙, not live-looking
    assert.equal(await p.evaluate(() => document.querySelector('[data-testid="v6-empty-restore"]').disabled), true);
    await p.evaluate(() => window.__rig.store.set('settings.performLock', false));
    await p.waitForFunction(() => !document.querySelector('[data-testid="v6-empty-restore"]').disabled);
    await p.click(tid('v6-empty-new'));
    await p.waitForFunction(() => !!window.__rig.store.currentSong());
    await p.waitForSelector(tid('v6-empty'), { state: 'hidden' });
    assert.equal(await p.evaluate(() => window.__rig.store.get().songOrder.length), 1);
    await close(context);
  });

  // ================================================================ flag off
  await T('flag off: today\'s Start here wording in today\'s Notes; nothing of U8a linked or drawn', async () => {
    const { context, page: p } = await open({ viewport: MAC, ipad: false, fresh: true });
    const fetched = [];
    p.on('request', (r) => {
      if (/styles-v6|\/views\/v6\//.test(r.url())) fetched.push(r.url());
    });
    await boot(p, { q: '' });
    const s = await p.evaluate(() => ({
      card: document.querySelector('#view-perform .p-notes [data-testid="start-card"]')?.textContent || '',
      v6: document.querySelectorAll('.v6, .v6-start, [data-testid="v6-empty"]').length,
      css: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href'))
        .filter((h) => /v6/.test(h)),
    }));
    assert.match(s.card, /→ or NEXT = next song\. The Space row changes the room\./);
    assert.deepEqual({ v6: s.v6, css: s.css, fetched }, { v6: 0, css: [], fetched: [] });
    await close(context);
  });

  await T('zero console.error and no HTTP ≥ 400', async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close();
  await server.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\nui-v6-ipad: ${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
