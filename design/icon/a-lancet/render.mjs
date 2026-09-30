// Previews for direction A (Lancet). Reuses renderSvg() from ../render.mjs (Playwright Chromium, deviceScaleFactor 1).
//   node design/icon/a-lancet/render.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const uri = (s) => `data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`;

async function shot(page, { w, h, bg, img, size, filter = '' }, out) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<body style="margin:0"><div id="c" style="width:${w}px;height:${h}px;background:${bg};
    display:flex;align-items:center;justify-content:center"><img src="${img}" width="${size}" height="${size}"
    style="display:block;${filter}"></div></body>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.locator('#c').screenshot({ path: path.join(HERE, out) });
}

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
try {
  const icon = uri(read('icon.svg'));
  const mono = uri(read('mono.svg'));
  await shot(page, { w: 640, h: 640, bg: '#0e1014', img: icon, size: 512 }, 'preview-512-dark.png');
  await shot(page, { w: 640, h: 640, bg: '#f5f1ea', img: icon, size: 512 }, 'preview-512-light.png');
  // Small sizes: full 1024 icon grid on the light ground, then a high-quality downsample (sips, Lanczos-style).
  const big = path.join(HERE, '.tmp-1024-light.png');
  await shot(page, { w: 1024, h: 1024, bg: '#f5f1ea', img: icon, size: 1024 }, '.tmp-1024-light.png');
  for (const s of [32, 16]) {
    execFileSync('sips', ['-z', String(s), String(s), big, '--out', path.join(HERE, `preview-${s}-light.png`)], { stdio: 'ignore' });
  }
  fs.unlinkSync(big);
  // Tray: template glyph at 22 px on a light strip (black) and a dark strip (macOS tints templates white).
  await shot(page, { w: 200, h: 22, bg: '#f2f0ee', img: mono, size: 22 }, 'tray-22-light.png');
  await shot(page, { w: 200, h: 22, bg: '#28272b', img: mono, size: 22, filter: 'filter:invert(1)' }, 'tray-22-dark.png');
  console.log('ok');
} finally { await browser.close(); }
