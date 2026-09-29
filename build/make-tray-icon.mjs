// Rasterises build/trayTemplate.svg's glyph (kept in sync by hand: same numbers below) into
// build/trayTemplate.png (22×22) and build/trayTemplate@2x.png (44×44): black + alpha, 8×8 supersampled.
// No dependencies (zlib + a CRC32 table). Run: node build/make-tray-icon.mjs
// The "Template" suffix makes Electron mark the image as a macOS template image (tinted for the menu bar).
// Also prints the base64 of both PNGs: main.js embeds them (TRAY_ICON_1X/2X) because electron-builder's `files`
// does not ship build/ (buildResources) inside the packaged app.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const W = 2.4; // bar stroke width (viewBox units)
const BARS = [[5.5, 9.6], [9.17, 4.2], [12.83, 6.9], [16.5, 11.2]]; // [x, top]; all end at y 14.4
const BAR_BOTTOM = 14.4;
const BASE = { x: 3, y: 17, w: 16, h: 2, r: 1 };

/** Is point (x, y) (viewBox units) inside the glyph? */
function inside(x, y) {
  for (const [bx, top] of BARS) {
    const cy = Math.min(Math.max(y, top), BAR_BOTTOM); // capsule = segment ⊕ disc
    if ((x - bx) ** 2 + (y - cy) ** 2 <= (W / 2) ** 2) return true;
  }
  const { x: rx, y: ry, w, h, r } = BASE;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
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

function png(size) {
  const S = 8;
  const scale = 22 / size;
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0 + RGBA
    for (let px = 0; px < size; px++) {
      let hit = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) if (inside((px + (sx + 0.5) / S) * scale, (py + (sy + 0.5) / S) * scale)) hit++;
      }
      row[1 + px * 4 + 3] = Math.round((255 * hit) / (S * S)); // RGB stay 0 (black)
    }
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

const one = png(22);
const two = png(44);
fs.writeFileSync(path.join(here, 'trayTemplate.png'), one);
fs.writeFileSync(path.join(here, 'trayTemplate@2x.png'), two);
console.log('wrote build/trayTemplate.png (22×22) and build/trayTemplate@2x.png (44×44)');
console.log(`TRAY_ICON_1X = '${one.toString('base64')}'`);
console.log(`TRAY_ICON_2X = '${two.toString('base64')}'`);
