// Shared HTML helpers for the angle-D mockups (static; no runtime JS in the output).
import { readFileSync } from 'node:fs';
const here = new URL('.', import.meta.url);
export const css = (name) => readFileSync(new URL(name, here), 'utf8');

export function page(title, styles, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${styles}
</style></head>
<body>
${body}
</body></html>
`;
}

export function topbar({ view = 'perform', masterOpen = false, midi = 'Nord Stage 3' } = {}) {
  const bars = [6, 11, 16, 9].map((h) => `<b style="height:${h}px"></b>`).join('');
  return `<header class="topbar">
  <div class="brand"><i>${bars}</i><span class="t">Worship Rig</span></div>
  <div class="viewtabs"><span class="${view === 'perform' ? 'on' : ''}">Perform</span><span class="${view === 'edit' ? 'on' : ''}">Edit</span></div>
  <span class="btn gear" aria-label="Settings">${gearSvg()}</span>
  <div class="status">
    <span><i class="led ok"></i>MIDI <em>${midi}</em></span>
    <span><i class="led ok"></i>Sound OK <em>12 ms</em></span>
    <span style="color:var(--ok)"><i class="led ok"></i>READY</span>
  </div>
  <span class="btn rec"><i class="dot"></i>REC</span>
  <span class="timer">00:00</span>
  <div class="hmeter"><b></b><b></b></div>
  <div class="master-grp${masterOpen ? ' open' : ''}"><span class="cap">Master</span>
    <div class="hslider" style="--v:62%"></div><span class="val">−6.0 dB</span><span class="chev">${masterOpen ? '▴' : '▾'}</span></div>
</header>`;
}

export function gearSvg() {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>`;
}

/** Vertical fader: v = 0..1 position, c = CSS colour. */
export const vf = (v, c) => `<div class="vf" style="--v:${v};--c:${c}"><div class="tr"><i></i></div><div class="th"></div></div>`;
/** Stereo meter, m = fill percent. */
export const vm = (l, r = l) => `<div class="vm"><b style="--m:${l}%"></b><b style="--m:${r}%"></b></div>`;
export const knob = (v, c, label = '', size) =>
  `<div class="knob" style="--v:${v};--c:${c}${size ? `;--s:${size}px` : ''}"><span>${label}</span></div>`;

/** 61-key keyboard C2..C7 (36..96); held = Set of midi notes. */
export function keyboard(held = new Set(), from = 36, to = 96, labels = true) {
  const isBlack = (n) => [1, 3, 6, 8, 10].includes(n % 12);
  const whites = [];
  for (let n = from; n <= to; n++) if (!isBlack(n)) whites.push(n);
  const W = 100 / whites.length;
  let html = '';
  for (const n of whites) {
    const lab = labels && n % 12 === 0 ? `<em>C${Math.floor(n / 12) - 1}</em>` : '';
    html += `<div class="w${held.has(n) ? ' h' : ''}">${lab}</div>`;
  }
  let wi = 0;
  for (let n = from; n <= to; n++) {
    if (!isBlack(n)) { wi++; continue; }
    const left = wi * W - W * 0.3;
    html += `<div class="b${held.has(n) ? ' h' : ''}" style="left:${left}%;width:${W * 0.6}%"></div>`;
  }
  return `<div class="kb">${html}</div>`;
}
