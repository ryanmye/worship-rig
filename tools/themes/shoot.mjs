#!/usr/bin/env node
// Theme screenshots + contrast audit for ANY registered theme (themes-setup; generalised from the Daylight v2
// design shoot, design/warmth/daylight-v2/shoot.mjs, which this replaces). The theme is applied the way the app does
// it (settings.theme → boot.js + main.js applyTheme), not injected, so what you see is what ships.
//   node tools/themes/shoot.mjs --theme <id> [--out <dir>] [--only perform,quick,edit,eq,mini] [--size 1440x900]
//   default --out: design/warmth/shots/<id>/
// Writes <out>/{perform,quick,edit,edit-tone-eq}.png, <out>/{mini,mini-drone-keys}.png (the menu-bar popover,
// app/mini.html at 320×440, live on the app's real bus state; mini-theme: the critic shoots it per theme), <out>/audit-<shot>-<W>.json (every visible text run: computed
// colour vs the median rendered background behind it, WCAG 4.5 / 3 for large text; disabled controls exempt) and
// <out>/summary.json (per shot: runs, fails, lowest; console/HTTP errors).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = require('playwright');
const { createServer } = require(path.join(ROOT, 'server.js'));
const { THEMES, byId } = await import(path.join(ROOT, 'app/js/shared/themes.js'));
const args = process.argv.slice(2);
const opt = (n, d = null) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const THEME = opt('--theme');
if (!THEME || !byId(THEME)) {
  console.error(`usage: node tools/themes/shoot.mjs --theme <${THEMES.map((t) => t.id).join('|')}> [--out dir] `
    + '[--only perform,quick,edit,eq,mini] [--size 1440x900]');
  process.exit(2);
}
const OUT = path.resolve(opt('--out', path.join(ROOT, 'design/warmth/shots', THEME)));
const only = (opt('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (k) => !only.length || only.includes(k);
const [W, H] = (opt('--size', '1440x900')).split('x').map(Number);
fs.mkdirSync(OUT, { recursive: true });

const server = createServer({ appDir: path.join(ROOT, 'app'), port: 0, userSamples: false });
const { url } = await server.listen();
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const consoleErrors = [];

async function boot() {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1,
    colorScheme: byId(THEME).mode });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) consoleErrors.push(`${r.status()} ${r.url()}`); });
  page.setDefaultTimeout(120000);
  const ready = async () => {
    await page.waitForFunction(() => !!window.__rig, null, { timeout: 120000 });
    if (await page.isVisible('#overlay-start')) await page.click('#overlay-start');
    await page.waitForFunction(() => window.__rig.engine.ctx?.state === 'running', null, { timeout: 120000 });
  };
  await page.goto(url, { timeout: 120000 });
  await ready();
  // the app's own path: settings.theme → mirror → reload → boot.js links it before first paint
  await page.evaluate(async (id) => {
    window.__rig.store.set('settings.theme', id);
    await new Promise((r) => setTimeout(r, 0));
    await window.__rig.theme.pending;
    window.__rig.store.persistNow();
  }, THEME);
  await page.reload({ timeout: 120000 });
  await ready();
  await page.waitForFunction(() => window.__rig.controller.status.ready === true, null, { timeout: 30000 }).catch(() => {});
  const idx = await page.evaluate(() => [...document.querySelectorAll('[data-testid=setlist] .setlist-chip')]
    .findIndex((c) => /Sunday Pad \+ Piano/.test(c.textContent)));
  if (idx >= 0) await page.click(`[data-testid=setlist] .setlist-chip[data-index="${idx}"]`);
  await page.waitForFunction(() => !window.__rig.controller.status.loading, null, { timeout: 240000, polling: 500 });
  await page.evaluate(() => document.fonts.ready);
  // perform.js fits the song name on a resize of the song block, not on a font swap: a 1 px nudge refits it
  await page.setViewportSize({ width: W - 1, height: H });
  await page.waitForTimeout(150);
  await page.setViewportSize({ width: W, height: H });
  // stills only: this box runs at a few fps under load, so transitions would be caught mid-way
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; }' });
  await page.waitForTimeout(400);
  return { ctx, page };
}
const clearToasts = (page) => page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()));
const hold = (page) => page.evaluate(() => {
  const p = window.__rig.controller.perform;
  p.wheel?.(0.62);
  for (const n of [48, 55, 60, 64, 67, 71]) p.noteOn(n, 104);
});
const sounding = (page) => page.waitForFunction(() => (window.__rig.controller.slotLevel?.(0)?.peak || 0) > 0.01, null,
  { timeout: 60000, polling: 250 }).then(() => true).catch(() => false);
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

// ---------------------------------------------------------------- contrast audit (computed text colour vs rendered bg)
// 1. Every visible text run: computed colour (normalised to RGBA through a 1 px canvas, since the theme's color-mix()
//    and light-dark() colours compute to oklab()), size, weight, effective opacity.
// 2. Re-shoot with all text transparent, so each run's box holds only what is really behind it.
// 3. Median background pixel per run vs the text colour (alpha/opacity blended onto that background).
function glare(file) {
  const img = decodePng(fs.readFileSync(file));
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  let bright = 0; let sum = 0; const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4; const L = 0.2126 * lin(img.data[o]) + 0.7152 * lin(img.data[o + 1]) + 0.0722 * lin(img.data[o + 2]);
    sum += L; if (L > 0.45) bright++;
  }
  return { meanLum: +(sum / n).toFixed(4), brightShare: +(bright / n).toFixed(4) };
}
async function audit(page, label, shot) {
  const runs = await page.evaluate(() => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const g = cv.getContext('2d', { willReadFrequently: true });
    const rgba = (c) => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
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
      if (parseFloat(cs.fontSize) < 1) continue;
      const r = document.createRange(); r.selectNodeContents(n);
      const rects = [...r.getClientRects()].filter((q) => q.width > 2 && q.height > 4);
      if (!rects.length) continue;
      const q = rects[0];
      if (q.right < 0 || q.bottom < 0 || q.left > vw || q.top > vh) continue;
      const hit = document.elementFromPoint(Math.min(vw - 1, q.left + q.width / 2), Math.min(vh - 1, q.top + q.height / 2));
      if (hit && !(el.contains(hit) || hit.contains(el))) continue;
      let op = 1; let disabled = false; let a = el;
      while (a) { const s = getComputedStyle(a); op *= parseFloat(s.opacity); if (a.disabled || a.getAttribute?.('aria-disabled') === 'true') disabled = true; a = a.parentElement; }
      if (op < 0.05) continue;
      out.push({ id: id++, text: n.textContent.trim().slice(0, 40), color: cs.color, rgba: rgba(cs.color), size: parseFloat(cs.fontSize),
        weight: parseInt(cs.fontWeight, 10), op, disabled, cls: (el.className && el.className.baseVal === undefined ? el.className : '').toString().slice(0, 60),
        tag: el.tagName.toLowerCase(), rect: { x: Math.max(0, q.left), y: Math.max(0, q.top), w: Math.min(q.width, vw - q.left), h: Math.min(q.height, vh - q.top) } });
    }
    // v2: the CSS voice bridge writes words with ::after on an element whose own text is font-size 0. Audit those too
    // (the element's box is the pseudo's box, since its own text takes no space).
    for (const el of document.body.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (parseFloat(cs.fontSize) >= 1 || cs.display === 'none' || cs.visibility !== 'visible') continue;
      const ps = getComputedStyle(el, '::after');
      if (!/^["']/.test(ps.content)) continue;
      const q = el.getBoundingClientRect();
      if (q.width < 2 || q.height < 4 || q.right < 0 || q.bottom < 0 || q.left > vw || q.top > vh) continue;
      if (el.closest('[hidden]')) continue;
      let op = 1; let disabled = false; let a = el;
      while (a) { const s2 = getComputedStyle(a); op *= parseFloat(s2.opacity); a = a.parentElement; }
      out.push({ id: id++, text: `::after ${ps.content.slice(1, -1).slice(0, 36)}`, color: ps.color, rgba: rgba(ps.color), size: parseFloat(ps.fontSize),
        weight: parseInt(ps.fontWeight, 10), op, disabled, cls: String(el.className || '').slice(0, 60), tag: el.tagName.toLowerCase(),
        rect: { x: Math.max(0, q.left), y: Math.max(0, q.top), w: Math.min(q.width, vw - q.left), h: Math.min(q.height, vh - q.top) } });
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
    const [cr0, cg0, cb0, a] = r.rgba;
    const alpha = a * r.op;
    const fg = [cr0, cg0, cb0].map((c, k) => c * alpha + med[k] * (1 - alpha));
    const cr = ratio(fg, med);
    const large = r.size >= 24 || (r.size >= 18.66 && r.weight >= 700);
    const need = large ? 3 : 4.5;
    results.push({ ...r, fg: `rgb(${fg.map(Math.round).join(',')})`, bg: `rgb(${med.join(',')})`, cr: Math.round(cr * 100) / 100, need, pass: cr >= need });
  }
  const fails = results.filter((r) => !r.pass && !r.disabled);
  const dis = results.filter((r) => !r.pass && r.disabled);
  const minRow = results.filter((r) => !r.disabled).sort((a, b) => a.cr - b.cr).slice(0, 8);
  const strip = ({ rgba, rect, ...r }) => r;
  fs.writeFileSync(path.join(OUT, `audit-${label}.json`), JSON.stringify({ label, count: results.length, fails: fails.map(strip),
    disabledFails: dis.map(strip), lowest: minRow.map(strip), glare: glare(shot) }, null, 1));
  console.log(`[audit ${label}] ${results.length} text runs, ${fails.length} fail, ${dis.length} disabled (exempt) below`);
  for (const f of fails) console.log(`  FAIL ${f.cr} < ${f.need}  "${f.text}"  .${f.cls}  fg ${f.fg} op ${f.op.toFixed(2)} bg ${f.bg}`);
  for (const f of minRow.slice(0, 5)) console.log(`  low  ${f.cr}  "${f.text}"  .${f.cls}`);
  return { count: results.length, fails: fails.length, lowest: minRow[0] ? `${minRow[0].cr} "${minRow[0].text}"` : '' };
}
async function shoot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  return audit(page, `${name}-${W}`, file);
}

const summary = { theme: THEME, size: `${W}x${H}`, shots: {} };
try {
  const { ctx, page } = await boot();
  summary.shown = await page.evaluate(() => ({ html: document.documentElement.dataset.theme,
    css: document.getElementById('theme-css')?.getAttribute('href') ?? null }));
  await hold(page);
  summary.sounding = await sounding(page);
  await page.waitForTimeout(800);
  await clearToasts(page);
  if (want('perform')) summary.shots.perform = await shoot(page, 'perform');
  if (want('quick')) {
    await page.click('#btn-quick');
    await page.waitForTimeout(400);
    await clearToasts(page);
    summary.shots.quick = await shoot(page, 'quick');
    await page.click('#btn-quick');
    await page.waitForTimeout(200);
  }
  await release(page);
  if (want('edit') || want('eq')) {
    await page.evaluate(() => window.__rig.store.set('settings.view', 'edit'));
    await page.waitForSelector('#view-edit .ev2', { state: 'visible' });
    await page.waitForTimeout(1200);
    if (want('edit')) {
      await hold(page);
      await page.waitForTimeout(700);
      await clearToasts(page);
      summary.shots.edit = await shoot(page, 'edit');
      await release(page);
    }
    if (want('eq')) {
      // the slot EQ sits straight in Advanced (Ryan 2026-09-30: no Tone disclosure)
      const ok = await page.evaluate(() => {
        const adv = document.querySelector('#view-edit details[data-sec="slot0-adv"]');
        if (!adv) return false;
        adv.open = true;
        return true;
      });
      if (ok && await page.waitForSelector('#view-edit .eqk', { timeout: 20000 }).then(() => true, () => false)) {
        await page.waitForTimeout(600);
        await page.evaluate(() => document.querySelector('#view-edit .eqk')?.scrollIntoView({ block: 'end' }));
        await page.waitForTimeout(400);
        await clearToasts(page);
        summary.shots.eq = await shoot(page, 'edit-tone-eq');
      } else summary.shots.eq = 'Advanced / EQ did not mount';
    }
  }
  if (want('mini')) {
    // the menu-bar popover (app/mini.html) in the same context: it boots from the mirror the app wrote and goes live
    // on the app's real bus state (BroadcastChannel 'rig-bus'); the audit runs on the 320×440 page
    const mp = await ctx.newPage();
    mp.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[mini] ${m.text()}`); });
    mp.on('response', (r) => { if (r.status() >= 400) consoleErrors.push(`[mini] ${r.status()} ${r.url()}`); });
    await mp.setViewportSize({ width: 320, height: 440 });
    await mp.goto(new URL('mini.html', url).href, { timeout: 120000 });
    await mp.waitForFunction(() => document.getElementById('mini')?.dataset.state === 'live', null, { timeout: 60000 });
    await mp.evaluate(() => document.fonts.ready);
    await mp.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; }' });
    await mp.waitForTimeout(300);
    summary.miniShown = await mp.evaluate(() => document.documentElement.dataset.theme);
    const shootMini = async (name) => {
      const file = path.join(OUT, `${name}.png`);
      await mp.screenshot({ path: file });
      return audit(mp, `${name}-320`, file);
    };
    summary.shots.mini = await shootMini('mini');
    await mp.click('[data-testid="mini-drone-keys"]');
    await mp.mouse.move(0, 0);
    await mp.waitForTimeout(200);
    summary.shots.miniKeys = await shootMini('mini-drone-keys');
    await mp.close();
  }
  await ctx.close();
} finally {
  await browser.close();
  await server.close();
}
summary.errors = consoleErrors.filter((e) => !/MIDI|midi|requestMIDIAccess/.test(e));
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
console.log('summary', JSON.stringify(summary, null, 1));
process.exit(summary.errors.length ? 1 : 0);
