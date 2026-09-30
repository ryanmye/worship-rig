#!/usr/bin/env node
// mini-theme suite: the menu-bar popover (app/mini.html) inherits the theme chosen in Settings (Ryan 2026-09-29).
//   node test/phase2/mini/theme.mjs            (also run by test/phase2/mini/run.mjs after its own tests)
// Tests:
//   bus      state.theme is optional in bus contract v1 (absent / non-empty string valid; '' / 5 / null invalid)
//   classic  pixel-equal to the popover before mini-theme (test/phase2/mini/fixtures/mini-before.css served in place
//            of mini.css on the same DOM): waiting, live, live + flags. Inside the card: ≤ 0.5 % of pixels differ
//            (> 8/255 on any channel); the only other change is the requested frame (1 px hairline + 12 px corners)
//   light    mirror 'daylight-day' before load → light, opaque card: html[data-theme|data-mode], the theme sheet,
//            the card background differs from Classic; omitBackground screenshot: every interior pixel alpha 255,
//            the corner transparent
//   live     Classic popover (page B) + the real app (page A): store.set('settings.theme', 'daylight-day') in A →
//            B re-themes within 1 s without a reload; every frame in between the card is opaque and the enabled theme
//            sheet matches html[data-theme]; and back to Classic
//   bus-theme  a bus state with theme:'studio' → the popover follows (no flash); state without theme → no change
//   themes   every registered, non-coming theme via the mirror: opaque card, 320×440 without overflow (4 and 6
//            modes), screenshot → screenshots/mini-theme-<id>.png
//   errors   zero console.error / pageerror / HTTP ≥ 400 on every page
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { MIDI_PERMISSIONS, pinTheme } from '../../integration/lib.mjs';
import { THEMES, DEFAULT_THEME_ID, byId } from '../../../app/js/shared/themes.js';
import { stateError } from '../../../app/js/shared/bus.js';
import { MINI_W, MINI_H, fakeState, postState, openMini, miniLayoutProblems, shown, startSampler, stopSampler, badFrames,
  CSS_OF } from './theme-lib.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const APP = path.join(ROOT, 'app');
const SHOTS = path.join(HERE, 'screenshots');
const BEFORE_CSS = fs.readFileSync(path.join(HERE, 'fixtures/mini-before.css'), 'utf8');
const { createServer } = require(path.join(ROOT, 'server.js'));
const VERBOSE = !!process.env.VERBOSE;
const argv = process.argv.slice(2);
const ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null;
const want = (k) => !ONLY || ONLY.includes(k);
const CLASSIC_BG = 'rgb(27, 25, 22)'; // #1b1916, the popover's own Classic card
const LIVE = THEMES.filter((t) => !t.coming);

fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const numbers = {};
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
/** A context whose pages see `mirror` in localStorage before any script (boot.js reads it before first paint). */
async function newCtx(mirror, o = {}) {
  const ctx = await browser.newContext({ viewport: { width: MINI_W, height: MINI_H }, deviceScaleFactor: 1,
    reducedMotion: 'reduce', ...o });
  if (mirror) {
    await ctx.addInitScript((id) => {
      try {
        localStorage.setItem('worship-rig.theme', id);
      } catch {
        /* storage blocked */
      }
    }, mirror);
  }
  return ctx;
}
const mini = (ctx, tag, o = {}) => openMini(ctx, origin, { ...o, onPage: (p) => watch(p, tag) });

/**
 * Decode PNGs in the page (lossless, no colour conversion) and compare / inspect them. `inside(x, y)` = the card
 * interior: the 12 px rounded rect inset by the 1 px hairline, with a 1 px safety margin on the corner arcs.
 */
const PIX_FN = `(() => {
  const W = ${MINI_W}, H = ${MINI_H}, R = 12;
  const inside = (x, y) => {
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return false;
    const cx = x < R ? R : x >= W - R ? W - R : null;
    const cy = y < R ? R : y >= H - R ? H - R : null;
    if (cx === null || cy === null) return true;
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
    return Math.hypot(dx, dy) <= R - 1.5;
  };
  const decode = async (b64) => {
    const bin = atob(b64); // no fetch(data:): mini.html's CSP connect-src is 'self'
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/png' });
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    return g.getImageData(0, 0, bmp.width, bmp.height).data;
  };
  return { inside, decode, W, H };
})()`;
async function diffShots(page, a, b) {
  return page.evaluate(async ({ a, b, fn }) => {
    const P = (0, eval)(fn);
    const [da, db] = await Promise.all([P.decode(a), P.decode(b)]);
    let all = 0, inner = 0, innerN = 0;
    for (let y = 0; y < P.H; y++) {
      for (let x = 0; x < P.W; x++) {
        const o = (y * P.W + x) * 4;
        const d = Math.max(Math.abs(da[o] - db[o]), Math.abs(da[o + 1] - db[o + 1]), Math.abs(da[o + 2] - db[o + 2]));
        const inn = P.inside(x, y);
        if (inn) innerN++;
        if (d > 8) {
          all++;
          if (inn) inner++;
        }
      }
    }
    const n = P.W * P.H;
    return { allPct: +(100 * all / n).toFixed(3), innerPct: +(100 * inner / innerN).toFixed(3), all, inner, frame: n - innerN };
  }, { a: a.toString('base64'), b: b.toString('base64'), fn: PIX_FN });
}
/** omitBackground screenshot → interior pixels with alpha < 255, and the corner pixel's alpha. */
async function opacity(page) {
  const buf = await page.screenshot({ omitBackground: true });
  return page.evaluate(async ({ b64, fn }) => {
    const P = (0, eval)(fn);
    const d = await P.decode(b64);
    let holes = 0;
    for (let y = 0; y < P.H; y++) for (let x = 0; x < P.W; x++) if (P.inside(x, y) && d[(y * P.W + x) * 4 + 3] < 255) holes++;
    return { holes, corner: d[3], mid: d[((P.H >> 1) * P.W + (P.W >> 1)) * 4 + 3] };
  }, { b64: buf.toString('base64'), fn: PIX_FN });
}
const lum = (rgb) => {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(rgb);
  if (!m) return NaN;
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(+m[1]) + 0.7152 * lin(+m[2]) + 0.0722 * lin(+m[3]);
};

console.log(`\n[mini-theme] ${origin}`);
try {
  if (want('bus')) {
    await T('bus: state.theme is optional in contract v1 (v stays 1)', async () => {
      assert.equal(stateError(fakeState()), null);
      assert.equal(stateError(fakeState({ theme: 'studio' })), null);
      assert.equal(stateError(fakeState({ theme: 'not-registered' })), null, 'any id on the wire; the popover resolves it');
      for (const bad of ['', 5, null, {}]) assert.equal(stateError(fakeState({ theme: bad })), 'theme', JSON.stringify(bad));
      assert.equal(fakeState({ theme: 'studio' }).v, 1);
    });
  }

  if (want('classic')) {
    await T('Classic: pixel-equal to the popover before mini-theme (inside the card ≤ 0.5 %); only the frame is new', async () => {
      const ctx = await newCtx('classic');
      try {
        const states = {
          waiting: null,
          live: fakeState(),
          flags: fakeState({ nModes: 6, recording: true, lowResource: true, audio: 'stalled',
            current: { id: 'fake:choir', name: 'Choir Swell', key: 'B♭' } }),
        };
        const rows = {};
        for (const [name, st] of Object.entries(states)) {
          const shots = [];
          for (const before of [true, false]) {
            const p = await mini(ctx, before ? 'mini-before' : 'mini', {
              state: st,
              before: before ? (pg) => pg.route('**/mini.css', (r) => r.fulfill({ contentType: 'text/css', body: BEFORE_CSS })) : undefined,
            });
            if (name === 'flags') {
              await p.click('[data-testid="mini-drone-keys"]'); // + the drone key sheet
              await p.mouse.move(0, 0);
            }
            if (!before) {
              const s = await shown(p);
              assert.equal(s.theme, 'classic');
              assert.deepEqual(s.sheets, []);
              assert.equal(s.bg, CLASSIC_BG);
              assert.equal(s.radius, '12px');
            }
            await sleep(150);
            shots.push(await p.screenshot());
            if (!before) fs.writeFileSync(path.join(SHOTS, `mini-classic-${name}.png`), shots[1]);
            await p.close();
          }
          const pix = await ctx.newPage();
          const d = await diffShots(pix, shots[0], shots[1]);
          await pix.close();
          rows[name] = d;
          console.log(`    ${name}: inside the card ${d.inner} px differ (${d.innerPct} %), whole popover ${d.all} px `
            + `(${d.allPct} %; frame ring + corners = ${d.frame} px)`);
          assert.ok(d.innerPct <= 0.5, `${name}: ${d.innerPct} % of the card interior differs`);
          assert.ok(d.all - d.inner <= d.frame, `${name}: differences outside the frame ring`);
        }
        numbers.classic = rows;
      } finally {
        await ctx.close();
      }
    });
  }

  if (want('light')) {
    await T("light: mirror 'daylight-day' before load → a light, opaque card from the theme's tokens", async () => {
      const ctx = await newCtx('daylight-day');
      try {
        const p = await mini(ctx, 'mini-day');
        const s = await shown(p);
        assert.equal(s.theme, 'daylight-day');
        assert.equal(s.mode, 'light');
        assert.equal(s.scheme, 'light');
        assert.deepEqual(s.sheets, [byId('daylight-day').css]);
        assert.notEqual(s.bg, CLASSIC_BG);
        assert.ok(lum(s.bg) > 0.7, `light card (${s.bg}, L ${lum(s.bg).toFixed(3)})`);
        assert.ok(lum(s.color) < 0.1, `dark ink (${s.color})`);
        const tok = await p.evaluate(() => {
          const cs = getComputedStyle(document.querySelector('.mini-frame'));
          const probe = document.createElement('i');
          document.querySelector('.mini-frame').append(probe);
          probe.style.color = 'var(--bg)';
          const bg = getComputedStyle(probe).color;
          probe.remove();
          return { bg, frame: cs.backgroundColor };
        });
        assert.equal(tok.frame, tok.bg, 'the card paints the theme --bg');
        const o = await opacity(p);
        assert.equal(o.holes, 0, `${o.holes} see-through pixels inside the card`);
        // outside the 12 px radius only the soft outer shadow may show (its tail reaches the corner at alpha ~2)
        assert.ok(o.corner <= 16, `the corner outside the 12 px radius is see-through (alpha ${o.corner})`);
        assert.equal(o.mid, 255);
        numbers.light = { bg: s.bg, L: +lum(s.bg).toFixed(3), holes: o.holes };
        await p.screenshot({ path: path.join(SHOTS, 'mini-daylight-day.png'), omitBackground: true });
        assert.deepEqual(await miniLayoutProblems(p), []);
        await p.close();
      } finally {
        await ctx.close();
      }
    });
  }

  if (want('live')) {
    await T('live: store.set(settings.theme) in the app (page A) re-themes the open popover (page B) ≤ 1 s, no reload, no flash', async () => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      await context_permissions(ctx);
      await pinTheme(ctx, 'classic');
      try {
        const B = await mini(ctx, 'mini', { state: null }); // waiting; the app answers its hello
        const A = await ctx.newPage();
        watch(A, 'app');
        await A.goto(`${origin}/`);
        // only the store and the theme switch matter here, not audio: don't wait for __rig.ready (on a saturated box
        // the song load alone can take > 2 min)
        await A.waitForFunction(() => !!(window.__rig && window.__rig.store && window.__rig.theme), null,
          { timeout: 120000, polling: 100 });
        await A.evaluate(() => window.__rig.theme.pending);
        assert.equal((await shown(B)).theme, 'classic');
        await B.evaluate(() => {
          window.__noReload = 1;
          window.__flips = [];
          new MutationObserver(() => window.__flips.push({ t: Date.now(), theme: document.documentElement.dataset.theme }))
            .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        });
        const runs = [];
        for (const id of ['daylight-day', 'daylight-stage', 'studio', 'classic']) {
          await startSampler(B, CSS_OF);
          const t0 = await A.evaluate((tid) => {
            const t = Date.now();
            window.__rig.store.set('settings.theme', tid);
            return t;
          }, id);
          await B.waitForFunction((tid) => document.documentElement.dataset.theme === tid
            && !document.querySelector('link[data-theme-next]'), id, { timeout: 10000, polling: 20 });
          await sleep(100);
          const frames = await stopSampler(B);
          const flip = await B.evaluate((tid) => window.__flips.filter((f) => f.theme === tid).pop()?.t, id);
          const ms = flip - t0;
          const s = await shown(B);
          assert.equal(s.theme, id);
          assert.deepEqual(s.sheets, byId(id).css ? [byId(id).css] : []);
          const bad = badFrames(frames);
          assert.deepEqual(bad, [], `${id}: ${bad.length} of ${frames.length} frames see-through or mismatched`);
          assert.equal(await B.evaluate(() => window.__noReload), 1, 'no reload');
          runs.push({ id, ms, frames: frames.length });
          console.log(`    → ${id}: popover re-themed ${ms} ms after store.set, ${frames.length} frames checked, bg ${s.bg}`);
          assert.ok(ms <= 1000, `${id}: ${ms} ms > 1 s`);
          await A.evaluate(() => window.__rig.theme.pending);
        }
        numbers.live = runs;
        assert.equal((await shown(B)).bg, CLASSIC_BG, 'back to the Classic card');
        await B.screenshot({ path: path.join(SHOTS, 'mini-live-classic.png') });
      } finally {
        await ctx.close();
      }
    });
  }

  if (want('bus-theme')) {
    await T("bus: a state with theme:'studio' → the popover follows (no flash); without theme → unchanged", async () => {
      const ctx = await newCtx('classic');
      try {
        const p = await mini(ctx, 'mini-bus');
        assert.equal((await shown(p)).theme, 'classic');
        for (const id of ['studio', 'daylight-day']) {
          await startSampler(p, CSS_OF);
          await postState(p, fakeState({ theme: id }));
          await p.waitForFunction((tid) => document.documentElement.dataset.theme === tid
            && !document.querySelector('link[data-theme-next]'), id, { timeout: 10000, polling: 20 });
          await sleep(100);
          const bad = badFrames(await stopSampler(p));
          assert.deepEqual(bad, [], `${id}: see-through / mismatched frames`);
          const s = await shown(p);
          assert.deepEqual(s.sheets, [byId(id).css]);
          assert.notEqual(s.bg, CLASSIC_BG);
        }
        await p.screenshot({ path: path.join(SHOTS, 'mini-bus-daylight-day.png') });
        await postState(p, fakeState({ current: { id: 'fake:warm-strings', name: 'Warm Strings', key: 'G' } }));
        await p.waitForFunction(() => document.querySelector('[data-testid="mini-current"]').textContent === 'Warm Strings');
        assert.equal((await shown(p)).theme, 'daylight-day', 'a state without theme leaves the theme alone');
        await postState(p, fakeState({ theme: 'no-such-theme' }));
        await p.waitForFunction((d) => document.documentElement.dataset.theme === d, DEFAULT_THEME_ID, { timeout: 10000 });
        assert.equal(await p.evaluate(() => window.__mini.theme.current), DEFAULT_THEME_ID, 'unknown id → the default, as the app');
        await p.close();
      } finally {
        await ctx.close();
      }
    });
  }

  if (want('themes')) {
    for (const t of LIVE) {
      await T(`theme ${t.id} (${t.mode}): opaque card, 320×440 without overflow (4 and 6 modes), no errors`, async () => {
        const mark = errors.length;
        const ctx = await newCtx(t.id);
        try {
          const p = await mini(ctx, `mini-${t.id}`);
          const s = await shown(p);
          assert.equal(s.theme, t.id);
          assert.equal(s.mode, t.mode);
          assert.deepEqual(s.sheets, t.css ? [t.css] : []);
          assert.equal(s.radius, '12px');
          if (t.mode === 'light') assert.ok(lum(s.bg) > 0.5, `light card ${s.bg}`);
          else assert.ok(lum(s.bg) < 0.1, `dark card ${s.bg}`);
          const o = await opacity(p);
          assert.equal(o.holes, 0, `${o.holes} see-through pixels inside the card`);
          assert.deepEqual(await miniLayoutProblems(p), [], '4 modes');
          await p.screenshot({ path: path.join(SHOTS, `mini-theme-${t.id}.png`), omitBackground: true });
          await postState(p, fakeState({ nModes: 6, recording: true, lowResource: true }));
          await p.waitForFunction(() => document.querySelectorAll('.modes.two-col .mode').length === 6);
          assert.deepEqual(await miniLayoutProblems(p), [], '6 modes');
          (numbers.themes ||= {})[t.id] = { bg: s.bg, holes: o.holes };
          await p.close();
        } finally {
          await ctx.close();
        }
        assert.deepEqual(errors.slice(mark), []);
      });
    }
  }

  await T('zero console.error / pageerror / HTTP ≥ 400', async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}

async function context_permissions(ctx) {
  await ctx.grantPermissions([...MIDI_PERMISSIONS], { origin });
}

const failed = results.filter((r) => !r.ok);
if (VERBOSE || process.env.MINI_THEME_NUMBERS) console.log(JSON.stringify(numbers, null, 1));
fs.writeFileSync(path.join(SHOTS, 'mini-theme-numbers.json'), JSON.stringify(numbers, null, 1));
console.log(`\nmini-theme: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
