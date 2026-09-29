// Daylight theme preview: serves the REAL app, injects app/themes/daylight/theme.css with page.addStyleTag (nothing is
// linked from index.html), takes the screenshots and runs a contrast audit on the rendered pixels.
//   node design/warmth/daylight/shoot.mjs                 → perform.png perform-1024.png edit.png quick.png idle.png
//                                                           today.png perform-dusk.png edit-dusk.png edit-1024.png + audits
//   node design/warmth/daylight/shoot.mjs --only perform,edit
// Day is the default in headless Chromium (prefers-color-scheme: light, so the theme's "auto" resolves to day);
// the -dusk shots set <body data-mode="dusk">, which is what the Quick › Light toggle would do.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = '/home/claude/worship-rig';
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = require('playwright');
const { createServer } = require(path.join(ROOT, 'server.js'));
const here = path.dirname(new URL(import.meta.url).pathname);
const THEME = path.join(ROOT, 'app/themes/daylight/theme.css');
const args = process.argv.slice(2);
const only = (args[args.indexOf('--only') + 1] || '').split(',').filter((s) => args.includes('--only') && s);
const want = (k) => !only.length || only.includes(k);

const server = createServer({ appDir: path.join(ROOT, 'app'), port: 40000 + Math.floor(Math.random() * 8000), userSamples: false });
const { url } = await server.listen();
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const consoleErrors = [];

async function boot(width, height, { dusk = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'light' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) consoleErrors.push(`${r.status()} ${r.url()}`); });
  page.setDefaultTimeout(120000);
  await page.goto(url, { timeout: 120000 });
  await page.waitForFunction(() => !!window.__rig, null, { timeout: 120000 });
  if (await page.isVisible('#overlay-start')) await page.click('#overlay-start');
  await page.waitForFunction(() => window.__rig.engine.ctx?.state === 'running', null, { timeout: 120000 });
  await page.waitForFunction(() => window.__rig.controller.status.ready === true, null, { timeout: 30000 }).catch(() => {});
  const idx = await page.evaluate(() => [...document.querySelectorAll('[data-testid=setlist] .setlist-chip')]
    .findIndex((c) => /Sunday Pad \+ Piano/.test(c.textContent)));
  await page.click(`[data-testid=setlist] .setlist-chip[data-index="${Math.max(0, idx)}"]`);
  await page.waitForFunction(() => !window.__rig.controller.status.loading, null, { timeout: 240000, polling: 500 });
  await page.addStyleTag({ path: THEME });
  if (dusk) await page.evaluate(() => { document.body.dataset.mode = 'dusk'; });
  await page.evaluate(() => document.fonts.ready);
  // perform.js fits the song name on a rename or a resize of the song block, not on a font swap. A linked theme needs
  // document.fonts.ready.then(fitName) (concept.md §8); here a 1 px viewport nudge fires its ResizeObserver.
  const vp = page.viewportSize();
  await page.setViewportSize({ width: vp.width - 1, height: vp.height });
  await page.waitForTimeout(150);
  await page.setViewportSize(vp);
  // stills only: this box runs at a few fps under load, so transitions / unfold animations would be caught mid-way
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; }' });
  await page.waitForTimeout(400);
  return { ctx, page };
}
const clearToasts = (page) => page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()));
const hold = (page) => page.evaluate(() => {
  const p = window.__rig.controller.perform;
  p.wheel(0.62);
  for (const n of [48, 55, 60, 64, 67, 71]) p.noteOn(n, 104);
});
const sounding = (page) => page.waitForFunction(() => (window.__rig.controller.slotLevel?.(0)?.peak || 0) > 0.01
  && (window.__rig.controller.slotLevel?.(1)?.peak || 0) > 0.005, null, { timeout: 60000, polling: 250 })
  .then(() => true).catch(() => false);
const metersMoved = (page) => page.waitForFunction(() => [...document.querySelectorAll('.perform .slot .lvl-cover')]
  .some((c) => /scaleY\(0\.[0-8]/.test(c.style.transform)), null, { timeout: 20000, polling: 200 })
  .then(() => 'meters moving').catch(() => 'meters did not move');
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
  fs.writeFileSync(path.join(here, `audit-${label}.json`), JSON.stringify({ label, count: results.length, fails: fails.map(strip),
    disabledFails: dis.map(strip), lowest: minRow.map(strip), glare: glare(shot) }, null, 1));
  console.log(`[audit ${label}] ${results.length} text runs, ${fails.length} fail, ${dis.length} disabled (exempt) below`);
  for (const f of fails) console.log(`  FAIL ${f.cr} < ${f.need}  "${f.text}"  .${f.cls}  fg ${f.fg} op ${f.op.toFixed(2)} bg ${f.bg}`);
  for (const f of minRow.slice(0, 5)) console.log(`  low  ${f.cr}  "${f.text}"  .${f.cls}`);
  return { count: results.length, fails: fails.length, lowest: minRow[0] ? `${minRow[0].cr} "${minRow[0].text}"` : '' };
}
async function shoot(page, name, label) {
  const file = path.join(here, `${name}.png`);
  await page.screenshot({ path: file });
  return audit(page, label || name, file);
}

// ---------------------------------------------------------------- mocks (screenshot only; the real thing needs JS)
const MOCK_CSS = `
.dl-mock { font-family: var(--font); color: var(--text); }
/* before-service "Today" sheet: what the required start click could look like */
.dl-welcome { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center;
  background: light-dark(rgb(243 239 231 / .80), rgb(14 12 10 / .80)); }
.dl-sheet { width: 820px; display: grid; grid-template-columns: 1.2fr 1fr; border-radius: 22px; overflow: hidden;
  background: var(--dl-pop); border: 1px solid var(--line-2); box-shadow: var(--dl-pop-shadow); }
.dl-sheet-l { padding: 30px 32px 28px; }
.dl-sheet-r { padding: 30px 28px 28px; background: var(--panel-2); border-left: 1px solid var(--line); display: flex; flex-direction: column; gap: 16px; }
.dl-kick { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 650; color: var(--muted); }
.dl-kick img { width: 26px; height: 26px; }
.dl-day { font: 650 46px/1.05 var(--dl-title); letter-spacing: -.02em; margin: 14px 0 4px; }
.dl-date { font-size: 16px; color: var(--muted); font-weight: 550; }
.dl-set { margin-top: 22px; display: flex; align-items: baseline; gap: 10px; }
.dl-set b { font-size: 17px; }
.dl-set span { font-size: 14px; color: var(--muted); }
.dl-songs { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.dl-songs li { display: grid; grid-template-columns: 22px 1fr auto; align-items: center; gap: 8px; min-height: 36px;
  padding: 0 10px; border-radius: 9px; font-size: 16px; font-weight: 600; }
.dl-songs li.first { background: color-mix(in oklab, var(--accent) 22%, var(--panel)); box-shadow: inset 3px 0 0 var(--accent); }
.dl-songs .n { color: var(--faint); font-size: 13px; font-variant-numeric: tabular-nums; }
.dl-songs .k { font-size: 13px; font-weight: 700; color: var(--muted); padding: 1px 8px; border-radius: 10px; background: var(--panel-3); }
.dl-songs li.first .n { color: var(--muted); }
.dl-songs li.first .k { color: var(--accent-ink); background: var(--accent); }
.dl-songs .more { color: var(--muted); font-weight: 550; font-size: 14px; }
.dl-card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; box-shadow: var(--dl-card-shadow); }
.dl-card h4 { margin: 0 0 6px; font-size: 13px; font-weight: 650; color: var(--muted); }
.dl-card p { margin: 0; font-size: 15px; line-height: 1.45; }
.dl-card p b { font-weight: 650; }
.dl-card .dl-dots { display: flex; gap: 6px; margin-top: 10px; }
.dl-card .dl-dots i { flex: 1; height: 6px; border-radius: 3px; background: var(--c); }
.dl-go { margin-top: auto; min-height: 58px; border-radius: 14px; border: 1px solid color-mix(in oklab, var(--accent) 70%, var(--text));
  background: var(--accent); color: var(--accent-ink); font: 700 19px/1 var(--font); display: flex; align-items: center; justify-content: center; gap: 10px;
  box-shadow: inset 0 -3px 0 color-mix(in oklab, var(--accent) 65%, var(--text)), 0 10px 22px -12px color-mix(in oklab, var(--accent) 80%, var(--text)); }
.dl-small { font-size: 12.5px; color: var(--muted); text-align: center; }
.dl-light { display: flex; gap: 0; border: 1px solid var(--line-2); border-radius: 10px; overflow: hidden; background: var(--panel); }
.dl-light span { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 40px; font-size: 14px; font-weight: 650; color: var(--muted); }
.dl-light span + span { border-left: 1px solid var(--line-2); }
.dl-light span.on { background: var(--accent); color: var(--accent-ink); }
.dl-ic { display: inline-block; flex: none; width: 18px; height: 18px; background: currentColor; -webkit-mask: var(--m) center / contain no-repeat; mask: var(--m) center / contain no-repeat; }
/* the Today card on Perform (top of the Notes column) */
.dl-today { flex: none; border-radius: 12px; padding: 11px 12px 12px; margin: -2px -4px 4px;
  background: color-mix(in oklab, var(--accent) 12%, var(--panel)); border: 1px solid color-mix(in oklab, var(--accent) 45%, var(--line)); }
.dl-today-h { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 650; color: var(--dl-accent-text); }
.dl-today-d { font: 650 22px/1.1 var(--dl-title); margin: 5px 0 2px; }
.dl-today-s { font-size: 13.5px; color: var(--muted); line-height: 1.4; }
.dl-today-s b { color: var(--text); font-weight: 650; }
.dl-today-bar { display: flex; gap: 3px; margin-top: 9px; }
.dl-today-bar i { flex: 1; height: 5px; border-radius: 3px; background: var(--line-2); }
.dl-today-bar i.done { background: var(--dl-accent-text); }
.dl-today-bar i.now { background: var(--accent); }
`;
const IC = (f) => `<i class="dl-ic" style="--m:url('/themes/daylight/${f}.svg')"></i>`;
const WELCOME = `
<div class="dl-welcome dl-mock" data-mock="today-sheet">
  <div class="dl-sheet">
    <div class="dl-sheet-l">
      <div class="dl-kick"><img src="/themes/daylight/mark.svg" alt="">Today</div>
      <div class="dl-day">Sunday morning</div>
      <div class="dl-date">4 October · your 38th Sunday with the rig</div>
      <div class="dl-set"><b>My Set</b><span>6 songs · about 32 minutes · starts in C</span></div>
      <ol class="dl-songs">
        <li class="first"><span class="n">1</span><span>Sunday Pad + Piano</span><span class="k">C</span></li>
        <li><span class="n">2</span><span>Building Swell</span><span class="k">C</span></li>
        <li><span class="n">3</span><span>Prayer Wash</span><span class="k">D</span></li>
        <li><span class="n">4</span><span>Organ Swell</span><span class="k">G</span></li>
        <li><span class="n"></span><span class="more">and 2 more</span><span></span></li>
      </ol>
    </div>
    <div class="dl-sheet-r">
      <div class="dl-card"><h4>Last time</h4><p>Sunday 28 September, <b>52 minutes</b>. You finished on <b>Prayer Wash</b> in D.</p></div>
      <div class="dl-card"><h4>Since then</h4><p><b>Building Swell</b> has a longer pad swell. Nothing else changed.</p></div>
      <div class="dl-light"><span>${IC('sun')}Day</span><span class="on">${IC('moon')}Stage</span><span>Auto</span></div>
      <button class="dl-go" type="button">Start sound</button>
      <div class="dl-small">Your browser needs one tap before it can play.</div>
    </div>
  </div>
</div>`;
const TODAY = `
<div class="dl-today dl-mock" data-mock="today-card">
  <div class="dl-today-h">${IC('today')}Practice for Sunday</div>
  <div class="dl-today-d">Sunday 4 October</div>
  <div class="dl-today-s">in 6 days · song <b>1 of 6</b> · last played <b>Prayer Wash</b> in D, 28 Sept</div>
  <div class="dl-today-bar"><i class="now"></i><i></i><i></i><i></i><i></i><i></i></div>
</div>`;

const summary = {};
try {
  if (want('perform') || want('quick') || want('edit') || want('idle') || want('today')) {
    const { ctx, page } = await boot(1440, 900);
    await page.addStyleTag({ content: MOCK_CSS });
    // the mock's mask icons: make sure they are decoded before any still is taken
    await page.evaluate(() => Promise.all(['sun', 'moon', 'today', 'mark'].map((f) => {
      const i = new Image(); i.src = `/themes/daylight/${f}.svg`; return i.decode().catch(() => {});
    })));
    await hold(page);
    console.log('sounding:', await sounding(page), await metersMoved(page));
    await page.waitForTimeout(800);
    await clearToasts(page);
    if (want('perform')) summary.perform = await shoot(page, 'perform', 'perform-1440');
    if (want('quick')) {
      await page.click('#btn-quick');
      await page.waitForTimeout(400);
      await clearToasts(page);
      summary.quick = await shoot(page, 'quick', 'quick-1440');
      await page.click('#btn-quick');
      await page.waitForTimeout(200);
    }
    if (want('today')) {
      await page.evaluate((html) => document.querySelector('.p-notes').insertAdjacentHTML('afterbegin', html), TODAY);
      await page.waitForTimeout(200);
      await clearToasts(page);
      summary.today = await shoot(page, 'today', 'today-1440');
      await page.evaluate(() => document.querySelector('.dl-today')?.remove());
    }
    await release(page);
    if (want('edit')) {
      await page.locator('.tb-views .seg', { hasText: 'Edit' }).first().click();
      await page.waitForTimeout(1200);
      await hold(page);
      await page.waitForTimeout(700);
      await clearToasts(page);
      summary.edit = await shoot(page, 'edit', 'edit-1440');
      await release(page);
      await page.locator('.tb-views .seg', { hasText: 'Perform' }).first().click();
      await page.waitForTimeout(600);
    }
    if (want('idle')) {
      await clearToasts(page);
      await page.evaluate(() => { document.body.dataset.mode = 'dusk'; });
      await page.evaluate((html) => document.body.insertAdjacentHTML('beforeend', html), WELCOME);
      await page.waitForTimeout(300);
      summary.idle = await shoot(page, 'idle', 'idle-1440');
    }
    await ctx.close();
  }
  if (want('dusk')) {
    const { ctx, page } = await boot(1440, 900, { dusk: true });
    await hold(page);
    console.log('sounding:', await sounding(page), await metersMoved(page));
    await page.waitForTimeout(800);
    await clearToasts(page);
    summary.performDusk = await shoot(page, 'perform-dusk', 'perform-dusk-1440');
    await release(page);
    await page.locator('.tb-views .seg', { hasText: 'Edit' }).first().click();
    await page.waitForTimeout(1200);
    await clearToasts(page);
    summary.editDusk = await shoot(page, 'edit-dusk', 'edit-dusk-1440');
    await ctx.close();
  }
  if (want('perform-1024')) {
    const { ctx, page } = await boot(1024, 700);
    await hold(page);
    console.log('sounding:', await sounding(page), await metersMoved(page));
    await page.waitForTimeout(800);
    await clearToasts(page);
    summary.perform1024 = await shoot(page, 'perform-1024', 'perform-1024');
    await ctx.close();
  }
  if (want('edit-1024')) {
    const { ctx, page } = await boot(1024, 700);
    await page.locator('.tb-views .seg', { hasText: 'Edit' }).first().click();
    await page.waitForTimeout(1200);
    await clearToasts(page);
    summary.edit1024 = await shoot(page, 'edit-1024', 'edit-1024');
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
const errs = consoleErrors.filter((e) => !/MIDI|midi|requestMIDIAccess/.test(e));
console.log('summary', JSON.stringify(summary, null, 1), '\nconsole/HTTP errors (non-MIDI):', errs.length ? errs : 'none');
