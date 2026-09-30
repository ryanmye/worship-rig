// Icon renderer (Playwright's bundled Chromium; no rsvg-convert on this Mac).
//   node design/icon/render.mjs                      → <letter>-<slug>-512.png for each master + options.png
//   node design/icon/render.mjs --dir process/v1 --out process/options-v1.png --no-png   (proposer sheet)
//   node design/icon/render.mjs --svg a.svg --size 1024 --out icon.png [--crop]          (one file; phase 2)
// deviceScaleFactor 1, so a 16 px render is the real 16 px raster Chromium produces from the vector.
// --crop renders only the squircle body (viewBox 100 100 824 824): what a favicon / touch icon should use.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const has = (k) => args.includes(k);

const uri = (buf, type) => `data:${type};base64,${Buffer.from(buf).toString('base64')}`;
const cropped = (svg) => svg.replace(/viewBox="[^"]*"/, 'viewBox="100 100 824 824"');

/** Render an SVG string to a PNG buffer at size×size (transparent background). */
export async function renderSvg(page, svg, size, { crop = false } = {}) {
  const src = uri(crop ? cropped(svg) : svg, 'image/svg+xml');
  await page.setContent(`<body style="margin:0;background:transparent">
    <img id="i" src="${src}" width="${size}" height="${size}" style="display:block"></body>`);
  await page.waitForFunction(() => document.getElementById('i').complete);
  return page.locator('#i').screenshot({ omitBackground: true });
}

/** Find the direction masters in a folder: [{letter, slug, svg, mono}] sorted a..d. */
export function findSets(dir) {
  return fs.readdirSync(dir).filter((f) => /^[a-d]-[a-z0-9-]+\.svg$/.test(f) && !f.endsWith('-mono.svg')).sort()
    .map((f) => {
      const base = f.slice(0, -4);
      const svg = fs.readFileSync(path.join(dir, f), 'utf8');
      const title = (svg.match(/<title>([^<]*)<\/title>/) || [])[1] || base;
      return { letter: base[0], slug: base.slice(2), base, title, svg,
        mono: fs.readFileSync(path.join(dir, `${base}-mono.svg`), 'utf8') };
    });
}

async function sheet(page, sets, out, heading) {
  const rows = [];
  for (const s of sets) {
    const p16 = uri(await renderSvg(page, s.svg, 16), 'image/png');
    const p32 = uri(await renderSvg(page, s.svg, 32, { crop: true }), 'image/png');
    const m22 = uri(await renderSvg(page, s.mono, 22), 'image/png');
    const big = uri(s.svg, 'image/svg+xml');
    rows.push(`<div class="row">
      <div class="lab"><b>${s.letter}</b><span>${s.title}</span></div>
      <div class="c big dark"><img src="${big}" width="512" height="512"></div>
      <div class="c big light"><img src="${big}" width="512" height="512"></div>
      <div class="c sm dark"><img src="${p32}" width="32" height="32"></div>
      <div class="c sm light"><img src="${p32}" width="32" height="32"></div>
      <div class="c sm light"><img src="${p16}" width="16" height="16"></div>
      <div class="c sm light"><img class="px" src="${p16}" width="64" height="64"></div>
      <div class="c menus">
        <div class="bar lightbar"><img src="${m22}" width="22" height="22"></div>
        <div class="bar darkbar"><img class="inv" src="${m22}" width="22" height="22"></div>
        <img class="px" src="${m22}" width="88" height="88">
      </div></div>`);
  }
  await page.setViewportSize({ width: 1760, height: 800 });
  await page.setContent(`<style>
    body{margin:0;background:#d9d4cb;font:15px -apple-system,Helvetica,sans-serif;color:#27211b;padding:24px}
    h1{font-size:20px;margin:0 0 4px} p{margin:0 0 16px;color:#5a5048}
    .hdr,.row{display:grid;grid-template-columns:150px 536px 536px 64px 64px 64px 96px 150px;gap:8px;align-items:center}
    .hdr div{font-size:12px;color:#5a5048;text-align:center}
    .row{margin-bottom:8px}
    .lab b{display:block;font-size:44px;line-height:1} .lab span{font-size:14px;display:block;margin-top:6px}
    .c{display:flex;align-items:center;justify-content:center;height:536px;border-radius:6px}
    .dark{background:#0e1014} .light{background:#f5f1ea}
    .sm{height:96px} .px{image-rendering:pixelated}
    .menus{flex-direction:column;gap:10px;height:auto}
    .bar{width:150px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:3px}
    .lightbar{background:#f2f0ee} .darkbar{background:#28272b} .inv{filter:invert(1)}
  </style>
  <h1>${heading}</h1>
  <p>Worship Rig app-icon directions · real rasters at deviceScaleFactor 1 · 32 px uses the favicon crop (squircle body only);
  16 px is the full icon grid as Finder/icns draws it · menu-bar glyphs are the mono template (black; macOS tints it white on dark).</p>
  <div class="hdr"><div></div><div>512 on #0e1014</div><div>512 on #f5f1ea</div><div>32 dark</div><div>32 light</div>
  <div>16 light</div><div>16 ×4 zoom</div><div>tray 22 px: light / dark / ×4</div></div>
  ${rows.join('\n')}`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.screenshot({ path: out, fullPage: true });
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  try {
    if (opt('--svg')) {
      const svg = fs.readFileSync(opt('--svg'), 'utf8');
      fs.writeFileSync(opt('--out'), await renderSvg(page, svg, Number(opt('--size', 1024)), { crop: has('--crop') }));
      return;
    }
    const dir = path.resolve(HERE, opt('--dir', '.'));
    const sets = findSets(dir);
    if (!has('--no-png')) {
      for (const s of sets) fs.writeFileSync(path.join(dir, `${s.base}-512.png`), await renderSvg(page, s.svg, 512));
    }
    const out = path.resolve(HERE, opt('--out', 'options.png'));
    await sheet(page, sets, out, opt('--heading', 'Worship Rig · app icon: four directions (refined)'));
    console.log('wrote', out);
  } finally { await browser.close(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
