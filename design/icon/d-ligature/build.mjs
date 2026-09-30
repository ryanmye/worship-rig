// Worship Rig, direction D: a W·R ligature. Generates icon.svg, mono.svg and the previews.
//   node design/icon/d-ligature/build.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSvg } from '../render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQ = 'M642.22 100C723.36 100 763.93 100 800.51 112.07L807.6 113.81C855.28 131.16 892.84 168.72 910.19 216.4L911.93 223.49C924 260.07 924 300.64 924 381.78L924 642.22C924 723.36 924 763.93 911.93 800.51L910.19 807.6C892.84 855.28 855.28 892.84 807.6 910.19L800.51 911.93C763.93 924 723.36 924 642.22 924L381.78 924C300.64 924 260.07 924 223.49 911.93L216.4 910.19C168.72 892.84 131.16 855.28 113.81 807.6L112.07 800.51C100 763.93 100 723.36 100 642.22L100 381.78C100 300.64 100 260.07 112.07 223.49L113.81 216.4C131.16 168.72 168.72 131.16 216.4 113.81L223.49 112.07C260.07 100 300.64 100 381.78 100Z';

// Palette (app/js/shared/themes.js): Sanctuary plum #100a1c / panel #191327, brass #e6ba65, text #f5ecd8;
// Daylight Day accent #f4b73f. Body plum is lifted one step so the tile holds against a dark Dock.
const P = { plumTop: '#2a1d44', plumBot: '#140c24', brass: '#e6ba65', brassHi: '#f4d48a' };

/** The ligature as stroked geometric centre-lines (mitred corners, clipped flat at cap height and baseline).
 *  W = an upturned M: two upright stems joined along the baseline by a pointed notch, |_/\\_|. That is also the
 *  sustain-pedal bracket from piano scores (down, hold, re-pedal notch, hold, up): the quiet musical cue.
 *  The W's right stem IS the R's stem; the R's bowl and leg hang off it. */
function mark(g) {
  const { L, top, base, s, w, f, apex, rb, bw, legDx } = g;
  const h = s / 2, S = L + w;                 // shared stem x
  const yb = base - h;                        // baseline stroke centre
  const by0 = top + h, by1 = by0 + 2 * rb;    // bowl centre-line top / bottom
  const d = [
    `M${L} ${top - 60}V${yb}H${L + f}L${L + w / 2} ${apex}L${S - f} ${yb}H${S}V${top - 60}`,
    `M${S} ${yb}V${base + 60}`,
    `M${S} ${by0}H${S + bw}A${rb} ${rb} 0 0 1 ${S + bw} ${by1}H${S}`,
    `M${S + bw - 10} ${by1}L${S + bw - 10 + legDx} ${base + 200}`,
  ].join('');
  return { d, clip: [L - h - 60, top, S + bw + legDx + 400, base - top] };
}

const G = { top: 300, base: 724, s: 90, w: 380, f: 34, apex: 450, rb: 96, bw: 62, legDx: 160 };
function centred(g) {
  const S = g.w, by1 = g.top + g.s / 2 + 2 * g.rb;
  const footX = S + g.bw - 10 + g.legDx * (g.base - by1) / (g.base + 200 - by1);
  const right = Math.max(footX + g.s * 0.6, S + g.bw + g.rb + g.s / 2);
  const width = right + g.s / 2;
  return { ...g, L: 512 - width / 2 + g.s / 2, width };
}

function body(g, fill, id = 'm') {
  const m = mark(g);
  const [cx, cy, cw, ch] = m.clip;
  return `<clipPath id="${id}c"><rect x="${cx}" y="${cy}" width="${cw}" height="${ch}"/></clipPath>
    <g clip-path="url(#${id}c)"><path d="${m.d}" fill="none" stroke="${fill}" stroke-width="${g.s}" stroke-linejoin="miter" stroke-miterlimit="4"/></g>`;
}

function iconSvg() {
  const g = centred(G);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <title>Ligature</title>
  <!-- Worship Rig, direction D: W and R share one stem; the W is drawn as a sustain-pedal bracket |_/\\_|. Brass on plum. -->
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P.plumTop}"/><stop offset="1" stop-color="${P.plumBot}"/></linearGradient>
    <linearGradient id="br" x1="0" y1="${G.top}" x2="0" y2="${G.base}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${P.brassHi}"/><stop offset="1" stop-color="${P.brass}"/></linearGradient>
    <filter id="sh" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity=".28"/></filter>
  </defs>
  <path d="${SQ}" fill="url(#bg)" filter="url(#sh)"/>
  <path d="${SQ}" fill="none" stroke="#fff" stroke-opacity=".07" stroke-width="4"/>
  ${body(g, 'url(#br)')}
</svg>
`;
}

function monoSvg() {
  // Heavier strokes for the 22 px template; square viewBox cropped to the mark.
  const g = centred({ ...G, s: 104, w: 390, f: 30, apex: 460, rb: 98, bw: 58 });
  const pad = 14, top = g.top - pad, h = g.base - g.top + 2 * pad;
  const w = g.width + 2 * pad, side = Math.max(w, h);
  const x = 512 - side / 2, y = top - (side - h) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x.toFixed(1)} ${y.toFixed(1)} ${side.toFixed(1)} ${side.toFixed(1)}" width="22" height="22">
  <title>Ligature (template)</title>
  ${body(g, '#000')}
</svg>
`;
}

const icon = iconSvg(), mono = monoSvg();
fs.writeFileSync(path.join(HERE, 'icon.svg'), icon);
fs.writeFileSync(path.join(HERE, 'mono.svg'), mono);

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
const uri = (b) => `data:image/png;base64,${Buffer.from(b).toString('base64')}`;
async function shot(w, h, bg, inner, out) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<body style="margin:0;width:${w}px;height:${h}px;background:${bg};display:flex;align-items:center;justify-content:center">${inner}</body>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.screenshot({ path: path.resolve(HERE, out), clip: { x: 0, y: 0, width: w, height: h } });
}
try {
  const p512 = uri(await renderSvg(page, icon, 512));
  const p32 = uri(await renderSvg(page, icon, 32));
  const p16 = uri(await renderSvg(page, icon, 16));
  const m22 = uri(await renderSvg(page, mono, 22));
  await shot(640, 640, '#0e1014', `<img src="${p512}" width="512" height="512">`, 'preview-512-dark.png');
  await shot(640, 640, '#f5f1ea', `<img src="${p512}" width="512" height="512">`, 'preview-512-light.png');
  await shot(48, 48, '#f5f1ea', `<img src="${p32}" width="32" height="32">`, 'preview-32-light.png');
  await shot(32, 32, '#f5f1ea', `<img src="${p16}" width="16" height="16">`, 'preview-16-light.png');
  await shot(200, 22, '#f2f0ee', `<img src="${m22}" width="22" height="22">`, 'tray-22-light.png');
  await shot(200, 22, '#28272b', `<img src="${m22}" width="22" height="22" style="filter:invert(1)">`, 'tray-22-dark.png');
  // zoomed inspection sheet (scratch)
  if (process.env.ZOOM) {
    await shot(560, 200, '#f5f1ea', `<img src="${p16}" width="128" height="128" style="image-rendering:pixelated;margin:8px"><img src="${p32}" width="128" height="128" style="image-rendering:pixelated;margin:8px"><img src="${m22}" width="176" height="176" style="image-rendering:pixelated;margin:8px">`, process.env.ZOOM);
  }
} finally { await browser.close(); }
console.log('ok');
