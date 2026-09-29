// Ember theme preview: serves the REAL app, injects app/themes/ember/theme.css with page.addStyleTag (nothing is
// linked from index.html), takes the screenshots and runs a contrast audit on the rendered pixels.
//   node design/warmth/ember/shoot.mjs            → perform.png perform-1024.png edit.png quick.png idle.png + audit
//   node design/warmth/ember/shoot.mjs --base     → the same shots without the theme (base-*.png), for comparison
//   node design/warmth/ember/shoot.mjs --only perform,edit
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = '/home/claude/worship-rig';
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = require('playwright');
const { createServer } = require(path.join(ROOT, 'server.js'));
const here = path.dirname(new URL(import.meta.url).pathname);
const THEME = path.join(ROOT, 'app/themes/ember/theme.css');
const args = process.argv.slice(2);
const BASE = args.includes('--base');
const only = (args[args.indexOf('--only') + 1] || '').split(',').filter((s) => args.includes('--only') && s);
const want = (k) => !only.length || only.includes(k);
const pre = BASE ? 'base-' : '';

const server = createServer({ appDir: path.join(ROOT, 'app'), port: 31000 + Math.floor(Math.random() * 8000), userSamples: false });
const { url } = await server.listen();
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const consoleErrors = [];

async function boot(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) consoleErrors.push(`${r.status()} ${r.url()}`); });
  await page.goto(url);
  await page.waitForFunction(() => !!window.__rig, null, { timeout: 20000 });
  if (await page.isVisible('#overlay-start')) await page.click('#overlay-start');
  await page.waitForFunction(() => window.__rig.engine.ctx?.state === 'running', null, { timeout: 30000 });
  // "ready" = every song in the set preloaded; on this 2-CPU box that can take minutes, so wait a while, then go on
  await page.waitForFunction(() => window.__rig.controller.status.ready === true, null, { timeout: 45000 }).catch(() => {});
  // select 'Sunday Pad + Piano' from the setlist strip
  const idx = await page.evaluate(() => [...document.querySelectorAll('[data-testid=setlist] .setlist-chip')]
    .findIndex((c) => /Sunday Pad \+ Piano/.test(c.textContent)));
  await page.click(`[data-testid=setlist] .setlist-chip[data-index="${Math.max(0, idx)}"]`);
  await page.waitForFunction(() => !window.__rig.controller.status.loading, null, { timeout: 30000 });
  if (!BASE) {
    await page.addStyleTag({ path: THEME });
    await page.evaluate(() => document.fonts.ready);
  }
  // stills only: this box runs at a few fps under load, so 80 ms colour transitions would still be mid-way
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
  await page.waitForTimeout(400);
  return { ctx, page };
}
const clearToasts = (page) => page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()));
const hold = (page) => page.evaluate(() => {
  const p = window.__rig.controller.perform;
  p.wheel(0.62);
  for (const n of [48, 55, 60, 64, 67, 71]) p.noteOn(n, 104);
});
// wait until the held chord is really sounding (the slot level taps read > 0), so the level glow is real
const sounding = (page) => page.waitForFunction(() => (window.__rig.controller.slotLevel?.(0)?.peak || 0) > 0.01
  && (window.__rig.controller.slotLevel?.(1)?.peak || 0) > 0.005, null, { timeout: 60000, polling: 250 })
  .then(() => true).catch(() => false);
// the level bars are drawn by levelMeter.js in rAF; on a loaded box that can lag, so wait until a bar has moved
const metersMoved = (page) => page.waitForFunction(() => [...document.querySelectorAll('.perform .slot .lvl-cover')]
  .some((c) => /scaleY\(0\.[0-8]/.test(c.style.transform)), null, { timeout: 20000, polling: 200 })
  .then(() => page.evaluate(() => [...document.querySelectorAll('.perform .slot .lvl-cover')].map((c) => c.style.transform)))
  .catch(() => 'meters did not move');
const release = (page) => page.evaluate(() => window.__rig.controller.perform.releaseAll());

/** Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced: what Chromium screenshots are) → RGBA bytes. */
function decodePng(buf) {
  let p = 8; let w = 0; let h = 0; let ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p + 4, p + 8); const d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3; const raw = zlib.inflateSync(Buffer.concat(idat)); const stride = w * bpp;
  const out = new Uint8Array(w * h * 4); const prev = new Uint8Array(stride); const cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0; const b = prev[i]; const c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c; const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; out[o] = cur[x * bpp]; out[o + 1] = cur[x * bpp + 1]; out[o + 2] = cur[x * bpp + 2]; out[o + 3] = 255; }
    prev.set(cur);
  }
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------- contrast audit (rendered pixels)
// 1. Collect every visible text run (direct text nodes) with its colour, size, weight and effective opacity.
// 2. Re-shoot with all text transparent, so each run's box holds only what is really behind it (gradients, grain,
//    translucent panels, glows included).
// 3. Median background pixel per run vs the text colour (alpha/opacity blended onto that background).
async function audit(page, label) {
  const runs = await page.evaluate(() => {
    const out = [];
    const vw = innerWidth, vh = innerHeight;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n; let id = 0;
    while ((n = walker.nextNode())) {
      if (!n.textContent.trim()) continue;
      const el = n.parentElement;
      if (!el || el.closest('script,style,noscript,[hidden],svg')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility !== 'visible' || cs.display === 'none') continue;
      if (parseFloat(cs.fontSize) < 1) continue; // font-size:0 tricks (drone-swell-text)
      const r = document.createRange(); r.selectNodeContents(n);
      const rects = [...r.getClientRects()].filter((q) => q.width > 2 && q.height > 4);
      if (!rects.length) continue;
      const q = rects[0];
      if (q.right < 0 || q.bottom < 0 || q.left > vw || q.top > vh) continue;
      // covered by something else (an open sheet, a popover, a scrolled-away row under the keyboard)? not visible text
      const hit = document.elementFromPoint(Math.min(vw - 1, q.left + q.width / 2), Math.min(vh - 1, q.top + q.height / 2));
      if (hit && !(el.contains(hit) || hit.contains(el))) continue;
      // clipped by an overflow ancestor? (setlist strip scroll, ellipsis)
      let op = 1; let disabled = false; let a = el;
      while (a) { const s = getComputedStyle(a); op *= parseFloat(s.opacity); if (a.disabled || a.getAttribute?.('aria-disabled') === 'true') disabled = true; a = a.parentElement; }
      if (op < 0.05) continue;
      out.push({ id: id++, text: n.textContent.trim().slice(0, 40), color: cs.color, size: parseFloat(cs.fontSize),
        weight: parseInt(cs.fontWeight, 10), op, disabled, cls: (el.className && el.className.baseVal === undefined ? el.className : '').toString().slice(0, 60),
        tag: el.tagName.toLowerCase(), rect: { x: Math.max(0, q.left), y: Math.max(0, q.top), w: Math.min(q.width, vw - q.left), h: Math.min(q.height, vh - q.top) } });
    }
    return out;
  });
  const hide = await page.addStyleTag({ content: '*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; }' });
  await page.waitForTimeout(120);
  const buf = await page.screenshot();
  await hide.evaluate((n) => n.remove());
  const img = decodePng(buf);
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const parse = (c) => {
    const m = c.match(/[\d.]+(e-?\d+)?/g).map(Number);
    if (c.startsWith('color(')) return { rgb: m.slice(0, 3).map((v) => v * 255), a: m.length > 3 ? m[3] : 1 }; // color(srgb r g b / a)
    return { rgb: m.slice(0, 3), a: m.length > 3 ? m[3] : 1 };
  };
  const results = [];
  for (const r of runs) {
    const px = [];
    const x0 = Math.round(r.rect.x), y0 = Math.round(r.rect.y), x1 = Math.round(r.rect.x + r.rect.w), y1 = Math.round(r.rect.y + r.rect.h);
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 2) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const i = (y * img.width + x) * 4; px.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
    }
    if (!px.length) continue;
    const lum = px.map((q) => [L(q), q]).sort((a, b) => a[0] - b[0]);
    const med = lum[Math.floor(lum.length / 2)][1];
    const { rgb, a } = parse(r.color);
    const alpha = a * r.op;
    const fg = rgb.map((c, k) => c * alpha + med[k] * (1 - alpha));
    const cr = ratio(fg, med);
    const large = r.size >= 24 || (r.size >= 18.66 && r.weight >= 700);
    const need = large ? 3 : 4.5;
    results.push({ ...r, bg: `rgb(${med.join(',')})`, cr: Math.round(cr * 100) / 100, need, pass: cr >= need });
  }
  const fails = results.filter((r) => !r.pass && !r.disabled);
  const dis = results.filter((r) => !r.pass && r.disabled);
  const minRow = results.filter((r) => !r.disabled).sort((a, b) => a.cr - b.cr).slice(0, 8);
  fs.writeFileSync(path.join(here, `audit-${pre}${label}.json`), JSON.stringify({ label, count: results.length, fails, disabledFails: dis, lowest: minRow }, null, 1));
  console.log(`[audit ${label}] ${results.length} text runs, ${fails.length} fail, ${dis.length} disabled (exempt) below`);
  for (const f of fails) console.log(`  FAIL ${f.cr} < ${f.need}  "${f.text}"  .${f.cls}  fg ${f.color} op ${f.op.toFixed(2)} bg ${f.bg}`);
  for (const f of minRow.slice(0, 5)) console.log(`  low  ${f.cr}  "${f.text}"  .${f.cls}`);
  return { count: results.length, fails: fails.length };
}

// ---------------------------------------------------------------- welcome mock (screenshot only)
const WELCOME = `
<div class="ember-welcome" data-mock="welcome">
  <div class="ew-card">
    <div class="ew-hello">
      <img class="ew-mark" src="/themes/ember/mark.svg" alt="">
      <div class="ew-day">Sunday<br>morning.</div>
      <div class="ew-sub">The sounds are warming up. Tap anywhere to light the room.</div>
      <button class="ew-go" type="button"><i></i>Light the room</button>
      <div class="ew-small">Your browser needs one tap before it can make sound.</div>
    </div>
    <div class="ew-today">
      <h3>Today</h3>
      <h4>My Set · 11 songs, starts in C</h4>
      <ol class="ew-songs">
        <li><span class="n">1</span><span>Sunday Pad + Piano</span><span class="k">C</span></li>
        <li><span class="n">2</span><span>Building Swell</span><span class="k">C</span></li>
        <li><span class="n">3</span><span>Prayer Wash</span><span class="k">C</span></li>
        <li><span class="n">4</span><span>Organ Swell</span><span class="k">C</span></li>
        <li><span class="n"></span><span class="more">and 7 more</span><span></span></li>
      </ol>
      <div class="ew-last">Last time: <b>Sunday, 21 Sept</b>, 52 min.<br>You ended on <b>Prayer Wash</b> in D.</div>
      <div class="ew-lamps">
        <span style="--c: var(--slot-0)">Keys</span><span style="--c: var(--slot-1)">Pad</span>
        <span class="cold" style="--c: var(--slot-2)">Extra</span><span style="--c: var(--drone)">Drone</span>
      </div>
    </div>
  </div>
</div>`;

const summary = {};
try {
  if (want('perform') || want('quick') || want('edit') || want('idle')) {
    const { ctx, page } = await boot(1440, 900);
    await hold(page);
    console.log('sounding:', await sounding(page), await metersMoved(page));
    await page.waitForTimeout(800);
    await clearToasts(page);
    if (want('perform')) {
      await page.screenshot({ path: path.join(here, `${pre}perform.png`) });
      summary.perform = await audit(page, 'perform-1440');
    }
    if (want('quick')) {
      await page.click('#btn-quick');
      await page.waitForTimeout(400);
      await clearToasts(page);
      await page.screenshot({ path: path.join(here, `${pre}quick.png`) });
      summary.quick = await audit(page, 'quick-1440');
      await page.click('#btn-quick');
      await page.waitForTimeout(200);
    }
    await release(page);
    if (want('edit')) {
      await page.locator('.tb-views .seg', { hasText: 'Edit' }).first().click();
      await page.waitForTimeout(1200);
      await hold(page);
      await page.waitForTimeout(700);
      await clearToasts(page);
      await page.screenshot({ path: path.join(here, `${pre}edit.png`) });
      summary.edit = await audit(page, 'edit-1440');
      await release(page);
      await page.locator('.tb-views .seg', { hasText: 'Perform' }).first().click();
      await page.waitForTimeout(600);
    }
    if (want('idle') && !BASE) {
      await clearToasts(page);
      await page.evaluate((html) => document.body.insertAdjacentHTML('beforeend', html), WELCOME);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(here, 'idle.png') });
      summary.idle = await audit(page, 'idle-1440');
    }
    await ctx.close();
  }
  if (want('perform-1024')) {
    const { ctx, page } = await boot(1024, 700);
    await hold(page);
    console.log('sounding:', await sounding(page), await metersMoved(page));
    await page.waitForTimeout(800);
    await clearToasts(page);
    await page.screenshot({ path: path.join(here, `${pre}perform-1024.png`) });
    summary.perform1024 = await audit(page, 'perform-1024');
    await ctx.close();
  }
  if (want('edit-1024')) {
    const { ctx, page } = await boot(1024, 700);
    await page.locator('.tb-views .seg', { hasText: 'Edit' }).first().click();
    await page.waitForTimeout(1200);
    await clearToasts(page);
    await page.screenshot({ path: path.join(here, `${pre}edit-1024.png`) });
    summary.edit1024 = await audit(page, 'edit-1024');
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
const errs = consoleErrors.filter((e) => !/MIDI|midi|requestMIDIAccess/.test(e));
console.log('summary', JSON.stringify(summary), 'console/HTTP errors (non-MIDI):', errs.length ? errs : 'none');
