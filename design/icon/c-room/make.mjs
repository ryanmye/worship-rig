// Renders the C-room previews via Playwright Chromium (reuses ../render.mjs renderSvg).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSvg } from '../render.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const uri = (b) => `data:image/png;base64,${Buffer.from(b).toString('base64')}`;
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function comp(out, w, h, bg, png, size, filter = '') {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<body style="margin:0;background:${bg};width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center">
    <img src="${uri(png)}" width="${size}" height="${size}" style="display:block;${filter}"></body>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.screenshot({ path: path.join(HERE, out) });
}
const icon = read('icon.svg'), mono = read('mono.svg');
const i512 = await renderSvg(page, icon, 512);
await comp('preview-512-dark.png', 640, 640, '#0e1014', i512, 512);
await comp('preview-512-light.png', 640, 640, '#f5f1ea', i512, 512);
await comp('preview-32-light.png', 32, 32, '#f5f1ea', await renderSvg(page, icon, 32), 32);
await comp('preview-16-light.png', 16, 16, '#f5f1ea', await renderSvg(page, icon, 16), 16);
const m22 = await renderSvg(page, mono, 22);
await comp('tray-22-light.png', 200, 22, '#f2f0ee', m22, 22);
await comp('tray-22-dark.png', 200, 22, '#28272b', m22, 22, 'filter:invert(1)');
// zoom sheet for inspection only (scratch)
if (process.env.ZOOM) {
  await page.setViewportSize({ width: 400, height: 140 });
  await page.setContent(`<body style="margin:0;background:#f5f1ea;display:flex;gap:10px;padding:6px;image-rendering:pixelated">
    <img src="${uri(await renderSvg(page, icon, 16))}" width="128" height="128" style="image-rendering:pixelated">
    <img src="${uri(await renderSvg(page, icon, 32))}" width="128" height="128" style="image-rendering:pixelated">
    <img src="${uri(m22)}" width="110" height="110" style="image-rendering:pixelated"></body>`);
  await page.screenshot({ path: process.env.ZOOM });
}
await browser.close();
