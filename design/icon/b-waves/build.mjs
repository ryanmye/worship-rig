// Direction B build: writes icon.svg + mono.svg, renders previews with design/icon/render.mjs (Playwright Chromium).
// node design/icon/b-waves/build.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { renderSvg } from '../render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQ = execFileSync('node', [path.join(HERE, '../squircle.mjs')]).toString().trim();

// A swell: a sustained note's envelope. Rises from `yb` at x=L, holds a long plateau at `yt`, releases to `yb` at x=R.
// `a` / `r` = attack / release widths. Closed down to y=1000 so it fills the squircle below.
const swell = (L, R, yt, yb, a, r) => {
  const f = (v) => +v.toFixed(1);
  return `M${f(L - 200)} ${f(yb)}L${f(L)} ${f(yb)}` +
    `C${f(L + a * 0.55)} ${f(yb)} ${f(L + a * 0.45)} ${f(yt)} ${f(L + a)} ${f(yt)}` +
    `L${f(R - r)} ${f(yt)}` +
    `C${f(R - r * 0.45)} ${f(yt)} ${f(R - r * 0.55)} ${f(yb)} ${f(R)} ${f(yb)}` +
    `L${f(R + 200)} ${f(yb)}L${f(R + 200)} 1000L${f(L - 200)} 1000Z`;
};

const P = {
  bg0: '#241a38', bg1: '#100a1c',   // Sanctuary panel-ish plum -> Sanctuary bg
  back: '#e6ba65', backHi: '#f4d48a', // Sanctuary brass -> lighter (Daylight Day accent #f4b73f family)
  mid: '#4a3670', front: '#2c2046',
  gap: '#100a1c',
};

// v2: three stacked envelope ribbons (the same swell, echoing downward). Brass on top, two plum echoes below.
const R = { sw: [96, 84, 76], dy: 172, h: 128, L: 232, Rx: 792, a: 224, y0: 282 };
const ribbon = (i) => {
  const f = (v) => +v.toFixed(1);
  const yt = R.y0 + i * R.dy, yb = yt + R.h, L = R.L, Rr = R.Rx, a = R.a;
  return `M${f(L)} ${f(yb)}C${f(L + a * 0.55)} ${f(yb)} ${f(L + a * 0.45)} ${f(yt)} ${f(L + a)} ${f(yt)}` +
    `L${f(Rr - a)} ${f(yt)}C${f(Rr - a * 0.45)} ${f(yt)} ${f(Rr - a * 0.55)} ${f(yb)} ${f(Rr)} ${f(yb)}`;
};
const RIB = [
  { d: ribbon(0), stroke: 'url(#brass)', w: R.sw[0] },
  { d: ribbon(1), stroke: '#a47ab8', w: R.sw[1] },
  { d: ribbon(2), stroke: '#644779', w: R.sw[2] },
];

const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <title>Swell</title>
  <!-- Worship Rig, direction B: one sustained swell (attack, long hold, release) echoing down as a pad — brass on plum. -->
  <defs>
    <clipPath id="sq"><path d="${SQ}"/></clipPath>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${P.bg0}"/><stop offset="1" stop-color="${P.bg1}"/>
    </linearGradient>
    <radialGradient id="glow" cx="512" cy="330" r="420" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${P.back}" stop-opacity=".30"/>
      <stop offset="1" stop-color="${P.back}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="brass" x1="0" y1="250" x2="0" y2="490" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${P.backHi}"/><stop offset="1" stop-color="#f4b73f"/>
    </linearGradient>
  </defs>
  <g clip-path="url(#sq)">
    <rect width="1024" height="1024" fill="url(#bg)"/>
    <rect width="1024" height="1024" fill="url(#glow)"/>
  </g>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    ${RIB.slice().reverse().map((r) => `<path d="${r.d}" stroke="${r.stroke}" stroke-width="${r.w}"/>`).join('\n    ')}
  </g>
  <path d="${SQ}" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width="3"/>
</svg>
`;

// Mono template: three stacked envelope lines (the same swell, three breaths), one black stroke shape, no fills.
const env = (L, R, yt, yb, a, r) => {
  const f = (v) => +v.toFixed(1);
  return `M${f(L)} ${f(yb)}C${f(L + a * 0.55)} ${f(yb)} ${f(L + a * 0.45)} ${f(yt)} ${f(L + a)} ${f(yt)}` +
    `L${f(R - r)} ${f(yt)}C${f(R - r * 0.45)} ${f(yt)} ${f(R - r * 0.55)} ${f(yb)} ${f(R)} ${f(yb)}`;
};
const M = { sw: 104, dy: 250, h: 170 };
const monoPaths = [0, 1, 2].map((i) => env(92, 932, 262 + i * M.dy - 0, 262 + i * M.dy + M.h, 330, 330));
const mono = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <title>Swell (template)</title>
  <!-- macOS template tray glyph: pure black on transparent; the system tints it. -->
  <g fill="none" stroke="#000" stroke-width="${M.sw}" stroke-linecap="round" stroke-linejoin="round">
    ${monoPaths.map((d) => `<path d="${d}"/>`).join('\n    ')}
  </g>
</svg>
`;

fs.writeFileSync(path.join(HERE, 'icon.svg'), icon);
fs.writeFileSync(path.join(HERE, 'mono.svg'), mono);

// ---- previews ----
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
const uri = (b, t) => `data:${t};base64,${Buffer.from(b).toString('base64')}`;
async function onBg(pngBuf, w, h, bg, out, x = 0) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<body style="margin:0;background:${bg};width:${w}px;height:${h}px;overflow:hidden">
    <img src="${uri(pngBuf, 'image/png')}" style="position:absolute;left:${x}px;top:${(h - (out.h || 0)) / 2}px"></body>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.screenshot({ path: path.join(HERE, out.name) });
}
const p512 = await renderSvg(page, icon, 512);
await onBg(p512, 640, 640, '#0e1014', { name: 'preview-512-dark.png', h: 512 }, 64);
await onBg(p512, 640, 640, '#f5f1ea', { name: 'preview-512-light.png', h: 512 }, 64);
fs.writeFileSync(path.join(HERE, 'preview-32-light.png'), await renderSvg(page, icon, 32));
fs.writeFileSync(path.join(HERE, 'preview-16-light.png'), await renderSvg(page, icon, 16));
const m22 = await renderSvg(page, mono, 22);
const m22w = await renderSvg(page, mono.replace('stroke="#000"', 'stroke="#fff"'), 22);
await onBg(m22, 200, 22, '#f2f0ee', { name: 'tray-22-light.png', h: 22 }, 89);
await onBg(m22w, 200, 22, '#28272b', { name: 'tray-22-dark.png', h: 22 }, 89);
// zoomed check sheet (scratch, for review only)
await page.setViewportSize({ width: 560, height: 200 });
await page.setContent(`<body style="margin:0;background:#f5f1ea;display:flex;gap:16px;align-items:center;padding:8px">
  <img src="${uri(await renderSvg(page, icon, 16), 'image/png')}" width="128" style="image-rendering:pixelated">
  <img src="${uri(await renderSvg(page, icon, 32), 'image/png')}" width="128" style="image-rendering:pixelated">
  <img src="${uri(m22, 'image/png')}" width="132" style="image-rendering:pixelated;background:#f2f0ee">
  <img src="${uri(m22w, 'image/png')}" width="132" style="image-rendering:pixelated;background:#28272b"></body>`);
await page.waitForFunction(() => [...document.images].every((i) => i.complete));
await page.screenshot({ path: process.env.ZOOM || path.join(HERE, '.zoom.png') });
await browser.close();
console.log('rendered');
