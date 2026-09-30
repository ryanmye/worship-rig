#!/usr/bin/env node
// Themes suite (themes-setup; app/themes/README.md, design/warmth/OPTIONS.md §3.1 #7/#8, §5).
//   node test/phase2/themes/run.mjs [--only boot,switch,picker,classic,quick,mini,coverage] [--theme id,id]
// Real app served by server.js, real Chromium. For EVERY registered, non-coming theme (shared/themes.js):
//   boot      localStorage mirror + settings.theme set → reload: #theme-css is in the document while
//             readyState is still "loading" (an init script records it), render-blocking, loaded before first paint;
//             html/body[data-theme|data-mode] + color-scheme right; zero console errors, zero HTTP ≥ 400.
//             Plus "store wins": a stale mirror is corrected at boot.
//   switch    store.set('settings.theme', id) at runtime: every animation frame until the switch lands has exactly
//             one enabled theme sheet and it matches html[data-theme] (never a frame with the old sheet and the new
//             attributes, or none), the body background is never the UA default; a screenshot one frame after the
//             store write → screenshots/switch-<id>.png.
//   picker    Settings › Appearance shows the current theme checked; click and arrow keys write settings.theme;
//             coming themes are not offered.
//   classic   (runs with picker too) the Classic card after another theme: no theme link, and every visible
//             element's computed look + the :root tokens equal a fresh Classic (theme-classic).
//   quick    Quick › This Mac › Theme shows the name and opens Settings › Appearance with focus in the picker.
//   mini      mini.html boots with the mirror's theme too.
//   coverage  each theme file's selectors (nesting resolved, pseudo-elements and :hover/:focus… dropped) checked
//             against the DOM across Perform (idle, held notes, locked), Quick, a toast, Edit (held notes, Advanced ›
//             Tone with the EQ), Settings, and the menu-bar popover (mini.html: waiting, live, 6 modes + flags, drone
//             key sheet; mini-theme). FAIL when > 5 % match nothing, or a selector names a class that no longer
//             exists anywhere in app/ outside app/themes. Per theme → coverage-<id>.json (siblings that share a file
//             are visited together and share the result).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { MIDI_PERMISSIONS, waitRigReady } from '../../integration/lib.mjs';
import { THEMES, DEFAULT_THEME_ID, THEME_MIRROR_KEY, byId } from '../../../app/js/shared/themes.js';
import { parseThemeSelectors, classesOf, deadClassFinder } from './css-selectors.mjs';
import { walkMini } from '../mini/theme-lib.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const APP = path.join(ROOT, 'app');
const SHOTS = path.join(HERE, 'screenshots');
const { createServer } = require(path.join(ROOT, 'server.js'));
const VERBOSE = !!process.env.VERBOSE;
const argv = process.argv.slice(2);
const listArg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1].split(',').map((s) => s.trim()).filter(Boolean) : null);
const ONLY = listArg('--only');
const want = (k) => !ONLY || ONLY.includes(k);
const PICK = listArg('--theme');
const LIVE = THEMES.filter((t) => !t.coming && (!PICK || PICK.includes(t.id)));
const COVERAGE_MAX = 0.05;

fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const notes = [];
const note = (msg) => {
  notes.push(msg);
  console.log(`    NOTE ${msg}`);
};
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
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await context.grantPermissions([...MIDI_PERMISSIONS], { origin });
const errors = [];
const watch = (page, tag) => {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${tag}] ${m.text()} @ ${m.location()?.url || '?'}`);
    else if (VERBOSE) console.log(`   [${tag} ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`[${tag}] HTTP ${r.status()} ${r.url()}`);
  });
};
/** Errors collected since `mark` (an index into `errors`). */
const errorsSince = (mark) => errors.slice(mark);

// Recorded before any page script: when the theme stylesheet enters the document, and what DOMContentLoaded saw.
await context.addInitScript(() => {
  window.__themeBootLog = [];
  const isTheme = (n) => n && n.nodeType === 1 && n.tagName === 'LINK' && n.rel === 'stylesheet'
    && /\/themes\//.test(n.getAttribute('href') || '');
  new MutationObserver((recs) => {
    for (const r of recs) {
      for (const n of r.addedNodes) {
        if (!isTheme(n)) continue;
        window.__themeBootLog.push({ id: n.id, href: n.getAttribute('href'), readyState: document.readyState,
          blocking: n.getAttribute('blocking'), bodyExisted: !!document.body, t: performance.now() });
      }
    }
  }).observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => {
    const l = document.getElementById('theme-css');
    window.__themeDcl = { html: document.documentElement.dataset.theme || null, link: l ? l.getAttribute('href') : null,
      body: document.body ? document.body.dataset.theme || null : null };
  });
});

const page = await context.newPage();
watch(page, 'app');
page.setDefaultTimeout(60000);
const ev = (fn, arg) => page.evaluate(fn, arg);

async function bootApp(url = `${origin}/`) {
  await page.goto(url);
  await waitRigReady(page, { timeout: 120000, what: '[themes] window.__rig.ready' });
  const overlay = await page.$('#overlay-start:not([hidden])');
  if (overlay) await overlay.click();
  await page.waitForFunction(() => window.__rig.engine.ctx && window.__rig.engine.ctx.state === 'running', null,
    { timeout: 30000, polling: 100 });
  await ev(() => window.__rig.theme.pending);
}
/** Theme state as the page shows it. */
const pageTheme = () => ev(() => {
  const html = document.documentElement;
  const enabled = [...document.querySelectorAll('link[rel=stylesheet]')]
    .filter((l) => /\/themes\//.test(l.getAttribute('href') || '') && l.media !== 'not all');
  return {
    html: html.dataset.theme || null, htmlMode: html.dataset.mode || null, colorScheme: html.style.colorScheme,
    body: document.body.dataset.theme || null, bodyMode: document.body.dataset.mode || null,
    links: enabled.map((l) => ({ id: l.id, href: l.getAttribute('href') })),
    pendingNext: document.querySelectorAll('link[data-theme-next]').length,
    mirror: localStorage.getItem('worship-rig.theme'), store: window.__rig.store.get().settings.theme ?? null,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  };
});
function assertThemeShown(st, t, where) {
  const shim = t.body || { theme: t.id, mode: t.mode };
  assert.equal(st.html, t.id, `${where}: html[data-theme]`);
  assert.equal(st.htmlMode, t.mode, `${where}: html[data-mode]`);
  assert.equal(st.colorScheme, t.mode, `${where}: color-scheme`);
  assert.equal(st.body, shim.theme, `${where}: body[data-theme]`);
  assert.equal(st.bodyMode, shim.mode, `${where}: body[data-mode]`);
  assert.deepEqual(st.links, t.css ? [{ id: 'theme-css', href: t.css }] : [], `${where}: exactly the theme's sheet`);
  assert.equal(st.pendingNext, 0, `${where}: no half-loaded sheet left`);
  assert.equal(st.mirror, t.id, `${where}: localStorage mirror`);
}
/**
 * The boot-time link of theme `t` as the init script logged it: no flash. html/body[data-theme] already set at
 * DOMContentLoaded; the sheet inserted while the document is loading, before <body>, render-blocking, exactly once
 * (no runtime re-link), and loaded before first paint.
 */
async function assertBootLinked(t, log) {
  assert.equal(log.dcl.html, t.id, 'html[data-theme] at DOMContentLoaded');
  assert.equal(log.dcl.body, t.body ? t.body.theme : t.id, 'body[data-theme] at DOMContentLoaded');
  if (t.css) {
    assert.equal(log.dcl.link, t.css, '#theme-css present at DOMContentLoaded');
    const first = log.log.find((e) => e.id === 'theme-css');
    assert.ok(first, 'theme link inserted');
    assert.equal(first.readyState, 'loading', 'inserted while the document is still loading');
    assert.equal(first.bodyExisted, false, 'inserted before <body> exists');
    assert.equal(first.blocking, 'render', 'blocking=render');
    assert.equal(log.log.filter((e) => e.id === 'theme-css').length, 1, 'no re-link at runtime (store agreed)');
    const paint = await ev((href) => {
      const res = performance.getEntriesByType('resource').find((e) => e.name.endsWith(href));
      const fp = performance.getEntriesByType('paint').find((e) => e.name === 'first-paint');
      return { resEnd: res ? res.responseEnd : null, fp: fp ? fp.startTime : null };
    }, t.css);
    if (paint.resEnd !== null && paint.fp !== null) {
      assert.ok(paint.resEnd <= paint.fp, `sheet loaded (${paint.resEnd.toFixed(0)} ms) before first paint (${paint.fp.toFixed(0)} ms)`);
    } else note(`${t.id}: no paint/resource timing (${JSON.stringify(paint)})`);
  } else {
    assert.equal(log.dcl.link, null, 'classic links no theme file');
  }
}
/** Put a theme in the store (and so the mirror) and persist, for a reload. */
const storeTheme = (id) => ev(async (tid) => {
  window.__rig.store.set('settings.theme', tid);
  await new Promise((r) => setTimeout(r, 0));
  await window.__rig.theme.pending;
  window.__rig.store.persistNow();
}, id);

console.log(`\n[themes] ${origin}  themes: ${LIVE.map((t) => t.id).join(', ')}`);
try {
  await T('first boot, nothing stored: the default (Sanctuary) is linked before first paint, no flash', async () => {
    assert.equal(DEFAULT_THEME_ID, 'sanctuary', "Ryan's default (themes-final)");
    const mark = errors.length;
    await bootApp(); // a new browser context: empty localStorage, no mirror, no library
    const log = await ev(() => ({ log: window.__themeBootLog, dcl: window.__themeDcl }));
    const st = await pageTheme();
    assert.equal(st.store, null, 'settings.theme stays absent');
    assertThemeShown(st, byId(DEFAULT_THEME_ID), 'default');
    await assertBootLinked(byId(DEFAULT_THEME_ID), log);
    assert.deepEqual(errorsSince(mark), []);
  });

  if (want('boot')) {
    for (const t of LIVE) {
      await T(`boot ${t.id}: link before DOMContentLoaded, render-blocking, attrs, no errors / 404s`, async () => {
        await storeTheme(t.id);
        const mark = errors.length;
        await bootApp();
        const log = await ev(() => ({ log: window.__themeBootLog, dcl: window.__themeDcl }));
        const st = await pageTheme();
        assertThemeShown(st, t, 'after boot');
        await assertBootLinked(t, log);
        assert.deepEqual(errorsSince(mark), [], 'console errors / HTTP ≥ 400');
      });
    }
    await T('boot: the store wins over a stale mirror (and fixes the mirror)', async () => {
      // theme-classic: a and b must use different files. Siblings (sanctuary / sanctuary-day) only flip attributes,
      // synchronously in main.js before DOMContentLoaded, so __themeDcl would already show the store's id (T5).
      const files = THEMES.filter((t) => t.css && !t.coming);
      const a = files[0].id;
      const b = files.find((t) => t.css !== files[0].css).id;
      await storeTheme(a);
      await ev((id) => localStorage.setItem('worship-rig.theme', id), b); // e.g. a library imported elsewhere
      const mark = errors.length;
      await bootApp();
      assertThemeShown(await pageTheme(), byId(a), 'reconciled');
      assert.equal(await ev(() => window.__themeDcl.html), b, 'boot.js used the mirror first');
      assert.deepEqual(errorsSince(mark), []);
    });
    await T('boot: an unknown id in the mirror and in the library falls back to the default without errors', async () => {
      await ev(() => {
        const raw = JSON.parse(localStorage.getItem('rig.v1'));
        raw.settings.theme = 'retired-theme';
        localStorage.setItem('rig.v1', JSON.stringify(raw));
        localStorage.setItem('worship-rig.theme', 'retired-theme');
      });
      const mark = errors.length;
      await page.reload();
      await waitRigReady(page, { timeout: 120000 });
      await ev(() => window.__rig.theme.pending);
      const st = await pageTheme();
      assertThemeShown(st, byId(DEFAULT_THEME_ID), 'fallback');
      assert.equal(st.store, DEFAULT_THEME_ID);
      assert.deepEqual(errorsSince(mark), []);
    });
  }

  if (want('switch')) {
    // start from a theme with a file, then walk every theme (file ↔ file, file ↔ none, same file siblings)
    const order = [...LIVE.filter((t) => t.id !== DEFAULT_THEME_ID), byId(DEFAULT_THEME_ID)].filter(Boolean);
    await storeTheme(DEFAULT_THEME_ID);
    for (const t of order) {
      await T(`switch → ${t.id}: one consistent sheet every frame, never unstyled, then settled`, async () => {
        const mark = errors.length;
        const map = Object.fromEntries(THEMES.map((x) => [x.id, x.css]));
        const frames = await ev(async ({ id, cssOf }) => {
          const out = [];
          const sample = () => {
            const enabled = [...document.querySelectorAll('link[rel=stylesheet]')]
              .filter((l) => /\/themes\//.test(l.getAttribute('href') || '') && l.media !== 'not all')
              .map((l) => l.getAttribute('href'));
            const bs = getComputedStyle(document.body);
            out.push({ theme: document.documentElement.dataset.theme, enabled, want: cssOf[document.documentElement.dataset.theme],
              bg: bs.backgroundColor, img: bs.backgroundImage });
          };
          window.__rig.store.set('settings.theme', id);
          sample();
          const t0 = performance.now();
          while (window.__rig.theme.current !== id && performance.now() - t0 < 5000) {
            await new Promise((r) => requestAnimationFrame(r));
            sample();
          }
          await window.__rig.theme.pending;
          for (let i = 0; i < 3; i++) {
            await new Promise((r) => requestAnimationFrame(r));
            sample();
          }
          return out;
        }, { id: t.id, cssOf: map });
        for (const [i, f] of frames.entries()) {
          assert.deepEqual(f.enabled, f.want ? [f.want] : [], `frame ${i}: sheet matches html[data-theme]=${f.theme}`);
          assert.ok(!(f.bg === 'rgba(0, 0, 0, 0)' && f.img === 'none'), `frame ${i}: body background is the UA default`);
        }
        assert.equal(frames.at(-1).theme, t.id);
        assertThemeShown(await pageTheme(), t, 'settled');
        // one frame after a store write, as a picture: old or new theme, never unstyled
        const back = order[(order.indexOf(t) + order.length - 1) % order.length];
        await ev(async (id) => {
          window.__rig.store.set('settings.theme', id);
          await window.__rig.theme.pending;
        }, back.id);
        await ev(async (id) => {
          window.__rig.store.set('settings.theme', id);
          await new Promise((r) => requestAnimationFrame(r));
        }, t.id);
        await page.screenshot({ path: path.join(SHOTS, `switch-${t.id}.png`) });
        const bg = await ev(() => getComputedStyle(document.body).backgroundColor);
        assert.notEqual(bg, 'rgba(0, 0, 0, 0)');
        await ev(() => window.__rig.theme.pending);
        // themes-final T1/T2: the warmed FontFace copies carry every descriptor and are gone once the switch lands,
        // so the chord keeps its face's metric overrides (51/51 on a fresh boot; 56/51 with the old copies)
        const fx = await ev(async () => {
          await document.fonts.ready;
          const c = document.querySelector('.chord-name');
          const key = (f) => [f.family, f.style, f.weight, f.stretch, f.unicodeRange, f.featureSettings, f.display,
            f.ascentOverride, f.descentOverride, f.lineGapOverride, f.sizeAdjust].join('|');
          const seen = new Set();
          const dups = [];
          for (const f of document.fonts) {
            if (seen.has(key(f))) dups.push(key(f));
            seen.add(key(f));
          }
          return { sh: c.scrollHeight, ch: c.clientHeight, dups };
        });
        assert.ok(fx.sh <= fx.ch, `.chord-name scrollHeight ${fx.sh} ≤ clientHeight ${fx.ch} after a runtime switch`);
        assert.deepEqual(fx.dups, [], 'document.fonts: no duplicate family + descriptor faces');
        assert.deepEqual(errorsSince(mark), []);
      });
    }
  }

  if (want('picker')) {
    await T('Settings › Appearance: pickable themes only, current checked, click + arrows write settings.theme', async () => {
      const mark = errors.length;
      await storeTheme('studio');
      await ev(() => window.__rig.ctx.openSettings());
      await page.waitForSelector('[data-testid="setting-theme"]', { state: 'visible' });
      const cards = await ev(() => [...document.querySelectorAll('[data-testid="setting-theme"] [role=radio]')]
        .map((c) => ({ id: c.dataset.themeId, checked: c.getAttribute('aria-checked'), tab: c.tabIndex,
          strip: c.querySelectorAll('.st-theme-strip > i').length, text: c.textContent })));
      assert.deepEqual(cards.map((c) => c.id), THEMES.filter((t) => !t.coming).map((t) => t.id));
      assert.deepEqual(cards.filter((c) => c.checked === 'true').map((c) => c.id), ['studio']);
      assert.deepEqual(cards.filter((c) => c.tab === 0).map((c) => c.id), ['studio'], 'roving tabindex');
      assert.ok(cards.every((c) => c.strip === 4), '4-colour strip');
      assert.ok(cards.every((c) => /Light|Dark/.test(c.text)), 'light/dark tag');
      await page.click('[data-testid="theme-card-ember"]');
      await page.waitForFunction(() => window.__rig.store.get().settings.theme === 'ember');
      await ev(() => window.__rig.theme.pending);
      assert.equal((await pageTheme()).html, 'ember');
      assert.equal(await page.getAttribute('[data-testid="theme-card-ember"]', 'aria-checked'), 'true');
      await page.focus('[data-testid="theme-card-ember"]');
      await page.keyboard.press('ArrowRight');
      const ids = cards.map((c) => c.id);
      const next = ids[(ids.indexOf('ember') + 1) % ids.length];
      await page.waitForFunction((id) => window.__rig.store.get().settings.theme === id, next);
      assert.equal(await ev(() => document.activeElement.dataset.themeId), next, 'focus follows');
      await page.keyboard.press('Home');
      await page.waitForFunction((id) => window.__rig.store.get().settings.theme === id, ids[0]);
      await ev(() => window.__rig.theme.pending);
      await page.screenshot({ path: path.join(SHOTS, 'settings-appearance.png') });
      await ev(() => window.__rig.ctx.closeSettings());
      assert.deepEqual(errorsSince(mark), []);
    });
  }

  if (want('picker') || want('classic')) {
    // theme-classic: Classic is the rollback, so picking it after any other theme must give back exactly the base
    // look (styles.css alone): no theme sheet, and every visible element's computed look equal to a fresh Classic.
    await T('Settings › Appearance › Classic card after another theme restores the base look exactly', async () => {
      const mark = errors.length;
      const away = THEMES.find((t) => t.css && !t.coming).id;
      const look = () => ev(() => {
        const skip = '.led, .meter, .meter *, .lvl-meter, .lvl-meter *, canvas, #ready-status, #ready-status *, #toasts, '
          + '#toasts *'; // live readouts and transient toasts (#toasts' height follows whatever toast is up)
        const props = ['color', 'background-color', 'background-image', 'font-family', 'font-size', 'font-weight',
          'letter-spacing', 'border-top-color', 'border-top-width', 'border-radius', 'box-shadow', 'text-shadow',
          'opacity', 'width', 'height'];
        document.activeElement?.blur?.();
        const out = {};
        const rootCs = getComputedStyle(document.documentElement);
        for (const sh of document.styleSheets) {
          let rules = [];
          try { rules = [...sh.cssRules]; } catch { /* cross-origin */ }
          for (const r of rules) {
            if (r.selectorText !== ':root' || !r.style) continue;
            for (const k of r.style) if (k.startsWith('--')) out[`:root ${k}`] = rootCs.getPropertyValue(k).trim();
          }
        }
        let i = 0;
        for (const el of document.querySelectorAll('body *')) {
          if (el.matches(skip) || el.closest('[hidden]') || !el.getClientRects().length) continue;
          const cs = getComputedStyle(el);
          out[`${i++} ${el.tagName} ${String(el.className?.baseVal ?? el.className).slice(0, 40)}`] =
            props.map((k) => cs.getPropertyValue(k)).join(' | ');
        }
        return out;
      });
      const diffs = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
      const pick = async (id) => {
        await ev(() => window.__rig.ctx.openSettings({ section: 'appearance' }));
        await page.waitForSelector(`[data-testid="theme-card-${id}"]`, { state: 'visible' });
        await page.click(`[data-testid="theme-card-${id}"]`);
        await page.waitForFunction((tid) => window.__rig.store.get().settings.theme === tid, id);
        // the store notifies its subscribers after the write, so `pending` is only this switch's promise once
        // applyTheme has started (theme.current = the id); awaiting it earlier awaited the previous switch (flake:
        // "sanctuary changes the look (1 diffs)")
        await page.waitForFunction((tid) => window.__rig.theme.current === tid, id);
        await ev(() => window.__rig.theme.pending);
        await page.waitForFunction((tid) => document.documentElement.dataset.theme === tid, id);
        await ev(() => window.__rig.ctx.closeSettings());
        await ev(() => document.fonts.ready);
        await sleep(400);
      };
      await storeTheme('classic');
      await ev(() => window.__rig.store.set('settings.view', 'perform'));
      await sleep(400);
      const base = await look();
      assert.ok(Object.keys(base).length > 100, `walked ${Object.keys(base).length} entries`);
      await pick(away);
      assert.equal((await pageTheme()).html, away);
      const themed = await look();
      assert.ok(diffs(base, themed).length > 20, `${away} changes the look (${diffs(base, themed).length} diffs)`);
      await pick('classic');
      const st = await pageTheme();
      assert.equal(st.html, 'classic');
      assert.equal(st.body, 'classic');
      assert.deepEqual(st.links, [], 'no theme sheet left enabled');
      // stylesheets only: boot.js's rel=preload of the boot-time theme stays in <head> and styles nothing
      assert.equal(await ev(() => document.querySelectorAll('link[rel=stylesheet][href*="/themes/"]').length), 0,
        'no theme stylesheet at all, enabled or pending');
      const back = await look();
      const d = diffs(base, back);
      assert.deepEqual(d.map((k) => `${k}: ${base[k]} → ${back[k]}`), [], 'Classic after a theme = fresh Classic');
      await page.screenshot({ path: path.join(SHOTS, 'classic-restored.png') });
      assert.deepEqual(errorsSince(mark), []);
    });
  }

  if (want('quick')) {
    await T('Quick › This Mac › Theme: shows the name, opens Settings › Appearance focused on the picker', async () => {
      const mark = errors.length;
      await storeTheme('nave');
      await ev(() => window.__rig.store.set('settings.view', 'perform'));
      await page.click('#btn-quick');
      await page.waitForSelector('[data-testid="quick-theme"]', { state: 'visible' });
      assert.match(await page.textContent('[data-testid="quick-theme"]'), /^Theme: Nave ▸$/);
      await page.click('[data-testid="quick-theme"]');
      await page.waitForSelector('[data-testid="settings-appearance"]', { state: 'visible' });
      await page.waitForFunction(() => document.activeElement?.dataset?.themeId === 'nave', null, { timeout: 5000 });
      assert.equal(await page.isVisible('[data-testid="quick-sheet"]'), false, 'the sheet closed');
      await ev(() => window.__rig.ctx.closeSettings());
      // under Perform lock the row is frozen with the rest of This Mac
      await ev(() => window.__rig.store.set('settings.performLock', true));
      await page.click('#btn-quick');
      await page.waitForSelector('[data-testid="quick-theme"]', { state: 'visible' });
      assert.equal(await page.isDisabled('[data-testid="quick-theme"]'), true);
      await page.click('#btn-quick');
      await ev(() => window.__rig.store.set('settings.performLock', false));
      assert.deepEqual(errorsSince(mark), []);
    });
  }

  if (want('mini')) {
    await T('mini.html follows the mirror: attrs + sheet before DOMContentLoaded, no errors', async () => {
      const mark = errors.length;
      await storeTheme('studio');
      const mini = await context.newPage();
      watch(mini, 'mini');
      await mini.setViewportSize({ width: 320, height: 440 });
      await mini.goto(`${origin}/mini.html`);
      await mini.waitForFunction(() => !!window.__themeDcl);
      const r = await mini.evaluate(() => ({ dcl: window.__themeDcl, mode: document.documentElement.dataset.mode,
        body: document.body.dataset.theme }));
      assert.deepEqual(r.dcl, { html: 'studio', link: '/themes/studio/theme.css', body: 'studio' });
      assert.equal(r.mode, 'dark');
      await sleep(500);
      await mini.screenshot({ path: path.join(SHOTS, 'mini-studio.png') });
      await mini.close();
      assert.deepEqual(errorsSince(mark), []);
    });
  }

  if (want('coverage')) {
    const deadFinder = deadClassFinder(APP);
    const files = new Map(); // css → [theme]
    for (const t of LIVE) if (t.css) files.set(t.css, [...(files.get(t.css) || []), t]);
    for (const [css, group] of files) {
      await T(`coverage ${group.map((t) => t.id).join(' + ')} (${css}): ≤ 5 % unmatched, no dead classes`, async () => {
        const mark = errors.length;
        const text = fs.readFileSync(path.join(APP, css), 'utf8');
        const sels = parseThemeSelectors(text);
        const checks = sels.map((s) => s.match);
        const matched = new Set();
        const invalid = new Set();
        const states = [];
        const collect = async (label, on = page) => { // on: the page to check (the mini popover: walkMini)
          const r = await on.evaluate((list) => list.map((sel) => {
            if (!sel) return 'skip';
            try {
              return document.querySelector(sel) ? 1 : 0;
            } catch {
              return 'invalid';
            }
          }), checks);
          r.forEach((v, i) => {
            if (v === 1) matched.add(i);
            else if (v === 'invalid') invalid.add(i);
          });
          states.push(label);
        };
        for (const t of group) {
          await storeTheme(t.id);
          await walkStates(collect, t.id);
        }
        const considered = sels.map((s, i) => i).filter((i) => checks[i] && !invalid.has(i));
        const unmatched = considered.filter((i) => !matched.has(i));
        const dead = [];
        for (const i of considered) {
          const gone = classesOf(sels[i].part).filter((c) => !deadFinder(c));
          if (gone.length) dead.push({ selector: sels[i].part, context: sels[i].context, classes: gone, line: sels[i].line });
        }
        const pct = considered.length ? unmatched.length / considered.length : 0;
        const report = {
          css, themes: group.map((t) => t.id), generated: new Date().toISOString(), states,
          total: considered.length, matched: considered.length - unmatched.length, unmatched: unmatched.length,
          unmatchedPct: +(pct * 100).toFixed(1), limitPct: COVERAGE_MAX * 100,
          deadClasses: dead,
          unmatchedSelectors: unmatched.map((i) => ({ selector: sels[i].part, context: sels[i].context, line: sels[i].line,
            dead: dead.some((d) => d.line === sels[i].line && d.selector === sels[i].part) })),
          invalid: [...invalid].map((i) => ({ selector: sels[i].part, resolved: checks[i], line: sels[i].line })),
          skipped: sels.filter((s) => !s.match).map((s) => ({ selector: s.part, line: s.line, why: s.why })),
        };
        for (const t of group) fs.writeFileSync(path.join(HERE, `coverage-${t.id}.json`), JSON.stringify(report, null, 1));
        console.log(`    ${group.map((t) => t.id).join('+')}: ${report.total} selectors, ${report.unmatched} unmatched `
          + `(${report.unmatchedPct} %), ${dead.length} with dead classes, ${invalid.size} invalid`);
        assert.deepEqual(errorsSince(mark), [], 'console errors / HTTP ≥ 400 during the walk');
        assert.ok(pct <= COVERAGE_MAX && !dead.length,
          `${report.unmatchedPct} % unmatched (limit 5 %), ${dead.length} dead-class selectors `
          + `(${dead.slice(0, 6).map((d) => d.classes.join('/')).join(', ')}) → ${path.relative(ROOT, path.join(HERE, `coverage-${group[0].id}.json`))}`);
      });
    }
  }
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}

/** Visit the app states whose DOM the themes style; `collect(label)` after each. */
async function walkStates(collect, id) {
  const clearToasts = () => ev(() => document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()));
  const hold = () => ev(() => {
    const p = window.__rig.controller.perform;
    p.wheel?.(0.62);
    for (const n of [48, 55, 60, 61, 64, 66, 67, 71]) p.noteOn(n, 118);
    p.sustain?.(true);
  });
  const release = () => ev(() => {
    window.__rig.controller.perform.sustain?.(false);
    window.__rig.controller.perform.releaseAll();
  });
  /** A best-effort extra state: never fails the walk (the app may have moved the control), only notes it. */
  const extra = async (label, enter, leave) => {
    try {
      await enter();
      await sleep(350);
      await collect(`${id}:${label}`);
    } catch (err) {
      note(`${id}: state ${label} skipped (${String(err.message || err).split('\n')[0]})`);
    }
    try {
      await leave?.();
    } catch {
      /* best effort */
    }
    await sleep(150);
  };
  // a clean start whatever an earlier test left open (Settings, lock, the Quick sheet)
  await ev(() => {
    window.__rig.ctx.closeSettings();
    window.__rig.store.set('settings.performLock', false);
    window.__rig.store.set('settings.view', 'perform');
  });
  if (await page.isVisible('[data-testid="quick-sheet"]')) await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.__rig.controller.status.loading, null, { timeout: 240000, polling: 500 });
  await sleep(300);
  await collect(`${id}:perform`);
  await hold();
  await sleep(900);
  await collect(`${id}:perform-held`);
  await ev(() => window.__rig.ui.toast('Theme coverage toast', 'warn'));
  await collect(`${id}:toast`);
  await clearToasts();
  await release();
  await extra('banner', () => ev(() => window.__rig.ui.setBanner('theme-coverage',
    { kind: 'info', text: 'Theme coverage banner', short: 'Coverage' })),
  () => ev(() => window.__rig.ui.setBanner('theme-coverage', null)));
  await extra('low-resource', () => ev(() => document.documentElement.toggleAttribute('data-low-resource', true)),
    () => ev(() => document.documentElement.toggleAttribute('data-low-resource', false)));
  const padTile = () => page.locator('.perform .slot').nth(1).locator('.ontile').first().click({ timeout: 5000 });
  await extra('slot-muted', padTile, padTile);
  await extra('key-pop', () => page.click('.perform .song-sub [aria-haspopup="true"]', { timeout: 5000 }),
    () => page.keyboard.press('Escape'));
  await extra('step-panel', () => page.locator('.perform .slot button', { hasText: /Octave/ }).first().click({ timeout: 5000 }),
    () => page.keyboard.press('Escape'));
  await extra('faded', async () => {
    await page.click('[data-testid="fade-out"]', { timeout: 5000 });
    await page.waitForSelector('.btn-fade.faded', { timeout: 12000 });
  }, async () => {
    await hold();
    await sleep(300);
    await release();
  });
  await hold();
  await page.click('#btn-quick');
  await page.waitForSelector('[data-testid="quick-sheet"]', { state: 'visible' });
  await collect(`${id}:quick`);
  await page.click('#btn-quick');
  await release();
  await ev(() => window.__rig.store.set('settings.performLock', true));
  await sleep(200);
  await collect(`${id}:perform-locked`);
  await ev(() => window.__rig.store.set('settings.performLock', false));
  await ev(() => window.__rig.store.set('settings.view', 'edit'));
  await page.waitForSelector('#view-edit .ev2', { state: 'visible', timeout: 60000 });
  await sleep(600);
  await hold();
  await sleep(600);
  await collect(`${id}:edit-held`);
  await release();
  // every block tab (Keys · Pad · Extra · Bass · Drone | Effects · Master), then back to the first
  const tabs = await ev(() => [...document.querySelectorAll('#view-edit [role=tab]')].map((t) => t.id).filter(Boolean));
  for (const tid of tabs) await extra(`edit-${tid}`, () => page.click(`#${tid}`, { timeout: 5000 }));
  if (tabs[0]) await page.click(`#${tabs[0]}`).catch(() => {});
  const tone = await ev(async () => {
    const adv = document.querySelector('#view-edit details[data-sec="slot0-adv"]');
    const tn = document.querySelector('#view-edit details[data-sec="slot0-tone"]');
    if (!adv) return 'no Advanced section';
    adv.open = true;
    await new Promise((r) => setTimeout(r, 50));
    const t2 = tn || document.querySelector('#view-edit details[data-sec="slot0-tone"]');
    if (!t2) return 'no Tone section';
    t2.open = true;
    return 'ok';
  });
  if (tone === 'ok') {
    await page.waitForSelector('#view-edit .eqk', { timeout: 20000 }).catch(() => note(`${id}: EQ did not mount`));
    await sleep(400);
    await collect(`${id}:edit-tone-eq`);
    await ev(() => {
      const adv = document.querySelector('#view-edit details[data-sec="slot0-adv"]');
      if (adv) adv.open = false;
    });
  } else note(`${id}: ${tone}`);
  await ev(() => window.__rig.store.set('settings.view', 'perform'));
  await ev(() => window.__rig.ctx.openSettings());
  await page.waitForSelector('#view-settings:not([hidden])');
  await sleep(300);
  await collect(`${id}:settings`);
  await ev(() => window.__rig.ctx.closeSettings());
  // mini-theme: the menu-bar popover (app/mini.html, 320×440, fake bus state: waiting · live · 6 modes + flags ·
  // drone key sheet) in its own context with the mirror = id; test/phase2/mini/theme-lib.mjs
  await walkMini({ browser, origin, id, collect, onPage: (p) => watch(p, `mini:${id}`) });
}

const failed = results.filter((r) => !r.ok);
const errs = [...new Set(errors)];
if (errs.length) console.log(`\n  console errors / HTTP ≥ 400 (${errs.length}):\n    ${errs.slice(0, 20).join('\n    ')}`);
console.log(`\n[themes] ${results.length - failed.length}/${results.length} passed${notes.length ? `, ${notes.length} note(s)` : ''}`);
process.exit(failed.length ? 1 : 0);
