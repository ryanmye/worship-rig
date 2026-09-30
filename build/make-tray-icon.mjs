// Rasterises build/trayTemplate.svg (the W·R ligature template glyph; master: design/icon/d-ligature/mono.svg)
// into build/trayTemplate.png (22×22) and build/trayTemplate@2x.png (44×44): black + alpha, 8×8 supersampled.
// The SVG is drawn by Playwright's bundled Chromium onto an 8× canvas and box-filtered here, so the glyph lives in
// one file. Run: node build/make-tray-icon.mjs
// The "Template" suffix makes Electron mark the image as a macOS template image (tinted for the menu bar).
// Also prints the base64 of both PNGs: main.js embeds them (TRAY_ICON_1X/2X) because electron-builder's `files`
// does not ship build/ (buildResources) inside the packaged app.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
// base64 in Node (UTF-8 bytes); the page's btoa would mis-encode non-ASCII comment text.
const SVG = fs.readFileSync(path.join(here, 'trayTemplate.svg')).toString('base64');
const S = 8; // supersampling per axis

/** Coverage (0..1) per pixel of the SVG rendered at size×size, from an S× canvas render box-filtered down. */
async function coverage(page, size) {
  const big = size * S;
  const alpha = await page.evaluate(async ({ svg, big }) => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + svg;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = big;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, big, big);
    const d = g.getImageData(0, 0, big, big).data;
    const a = new Array(big * big);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    return a;
  }, { svg: SVG, big });
  const out = new Float64Array(size * size);
  for (let y = 0; y < big; y++) for (let x = 0; x < big; x++) out[((y / S) | 0) * size + ((x / S) | 0)] += alpha[y * big + x];
  return out.map((v) => v / (255 * S * S));
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, cov) {
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0 + RGBA
    for (let px = 0; px < size; px++) row[1 + px * 4 + 3] = Math.round(255 * cov[py * size + px]); // RGB stay 0
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const browser = await chromium.launch();
let one, two;
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  one = png(22, await coverage(page, 22));
  two = png(44, await coverage(page, 44));
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(here, 'trayTemplate.png'), one);
fs.writeFileSync(path.join(here, 'trayTemplate@2x.png'), two);
console.log('wrote build/trayTemplate.png (22×22) and build/trayTemplate@2x.png (44×44)');
console.log(`TRAY_ICON_1X = '${one.toString('base64')}'`);
console.log(`TRAY_ICON_2X = '${two.toString('base64')}'`);
