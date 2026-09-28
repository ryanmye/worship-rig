// Build-time helpers for the angle-A mockups. Output HTML is static and self-contained.

/** Stroke icons, 24×24 viewBox, currentColor. */
const ICONS = {
  piano: '<path d="M3 21V5.5A2.5 2.5 0 0 1 5.5 3H12c3.6 0 5 3.2 6.6 6 1.4 2.4 2.4 4.2 2.4 7v5H3z"/><path d="M3 16.5h18"/><path d="M7 16.5V21M11 16.5V21M15 16.5V21"/>',
  pad: '<path d="M2 10c2.7-4.5 5.3-4.5 8 0s5.3 4.5 8 0c1.3-2.2 2.7-3 4-3"/><path d="M2 16c2.7-4.5 5.3-4.5 8 0s5.3 4.5 8 0c1.3-2.2 2.7-3 4-3" opacity=".55"/>',
  bass: '<path d="M2 12c2.4-8 5.6-8 8 0s5.6 8 8 0" stroke-width="2.6"/><path d="M19 12h3"/>',
  drone: '<circle cx="12" cy="12" r="2.6"/><circle cx="12" cy="12" r="6.2" opacity=".7"/><circle cx="12" cy="12" r="9.8" opacity=".38"/>',
  empty: '<rect x="3.5" y="3.5" width="17" height="17" rx="4" stroke-dasharray="3 3"/><path d="M12 8.5v7M8.5 12h7"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6.5 6v7M10 6v7M14 6v7M17.5 6v7"/><path d="M2 13h20" opacity=".5"/>',
  room: '<path d="M3.5 20V11a8.5 8.5 0 0 1 17 0v9"/><path d="M8 20v-8a4 4 0 0 1 8 0v8"/><path d="M2 20h20"/>',
  echo: '<circle cx="5.5" cy="12" r="3"/><circle cx="12.5" cy="12" r="2.2" opacity=".72"/><circle cx="18.5" cy="12" r="1.5" opacity=".45"/>',
  chorus: '<path d="M2 12c2.5-5 5-5 7.5 0s5 5 7.5 0 3.5-3 5-3"/><path d="M2 15c2.5-5 5-5 7.5 0s5 5 7.5 0 3.5-3 5-3" opacity=".5"/>',
  tape: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><circle cx="8" cy="11.5" r="2.3"/><circle cx="16" cy="11.5" r="2.3"/><path d="M6 19l2-3.2h8l2 3.2"/>',
  speaker: '<path d="M4 9h3.5L13 4.5v15L7.5 15H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  wave: '<path d="M2 12h3l2-6 3 12 3-9 2 5 2-2h5"/>',
  pedal: '<path d="M7 20h10l-1.5-12h-7z"/><path d="M9 8l1-4h4l1 4"/>',
  restart: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/>',
  midi: '<circle cx="12" cy="12" r="9"/><circle cx="7.5" cy="12" r="1" fill="currentColor"/><circle cx="16.5" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="8" r="1" fill="currentColor"/><circle cx="15" cy="8" r="1" fill="currentColor"/><circle cx="12" cy="6.8" r="1" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bars: '<path d="M5 20V11M10 20V5M15 20v-7M20 20V8"/>',
  arrow: '<path d="M4 12h15M14 7l5 5-5 5"/>',
  tap: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.5" opacity=".5"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 11h7M9 15h7M9 7h4"/>',
};

/** Inline SVG icon. */
export function icon(name, size = 20, extra = '') {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${extra}>${ICONS[name]}</svg>`;
}

const rad = (deg) => (deg * Math.PI) / 180;
function arc(cx, cy, r, a0, a1) {
  const p0 = [cx + r * Math.cos(rad(a0)), cy + r * Math.sin(rad(a0))];
  const p1 = [cx + r * Math.cos(rad(a1)), cy + r * Math.sin(rad(a1))];
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${p0[0].toFixed(2)} ${p0[1].toFixed(2)}A${r} ${r} 0 ${large} 1 ${p1[0].toFixed(2)} ${p1[1].toFixed(2)}`;
}

/**
 * A "smart knob": 270° arc, value in the owner's colour, pointer on a dark cap.
 * bipolar=true draws the fill from 12 o'clock (for ±dB controls like Warmth).
 */
export function knob(v, color, size = 72, { bipolar = false, stroke } = {}) {
  const s = size, c = s / 2, r = s / 2 - (stroke || s * 0.09) / 2 - 1, sw = stroke || s * 0.09;
  const a0 = 135, a1 = 405, av = a0 + (a1 - a0) * v;
  const mid = 270;
  let fill = '';
  if (bipolar) {
    if (Math.abs(v - 0.5) > 0.004) fill = v > 0.5 ? arc(c, c, r, mid, av) : arc(c, c, r, av, mid);
  } else if (v > 0.004) fill = arc(c, c, r, a0, av);
  const capR = r - sw * 0.9;
  const px = c + (capR - s * 0.07) * Math.cos(rad(av)), py = c + (capR - s * 0.07) * Math.sin(rad(av));
  const px0 = c + capR * 0.35 * Math.cos(rad(av)), py0 = c + capR * 0.35 * Math.sin(rad(av));
  return `<svg class="knob-svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
    <path d="${arc(c, c, r, a0, a1)}" stroke="var(--track)" stroke-width="${sw}" fill="none" stroke-linecap="round"/>
    ${fill ? `<path d="${fill}" stroke="${color}" stroke-width="${sw}" fill="none" stroke-linecap="round"/>` : ''}
    ${bipolar ? `<circle cx="${c}" cy="${(c - r - sw / 2 - 2.5).toFixed(1)}" r="1.6" fill="var(--faint)"/>` : ''}
    <circle cx="${c}" cy="${c}" r="${capR.toFixed(1)}" fill="url(#capgrad)" stroke="#3d4450" stroke-width="1"/>
    <path d="M${px0.toFixed(1)} ${py0.toFixed(1)}L${px.toFixed(1)} ${py.toFixed(1)}" stroke="#f3f5f8" stroke-width="${Math.max(2.2, s * 0.04).toFixed(1)}" stroke-linecap="round"/>
  </svg>`;
}

/** SVG defs used by knobs (one per page). */
export const SVG_DEFS = `<svg width="0" height="0" style="position:absolute"><defs>
  <radialGradient id="capgrad" cx="45%" cy="35%" r="70%"><stop offset="0" stop-color="#343a45"/><stop offset="1" stop-color="#1c2027"/></radialGradient>
</defs></svg>`;

/** Vertical fader (same look as the app's slot fader). pos 0..1. */
export function vfader(pos, color, { muted = false } = {}) {
  const p = (pos * 100).toFixed(1);
  return `<div class="vfader${muted ? ' is-muted' : ''}">
    <div class="vf-track"><div class="vf-fill" style="height:${p}%;background:${color}"></div></div>
    <div class="vf-thumb" style="bottom:calc(${p}% - 13px)"></div>
  </div>`;
}

/** Horizontal slider. */
export function hfader(pos, color, cls = '') {
  const p = (pos * 100).toFixed(1);
  return `<div class="hfader ${cls}"><div class="hf-track"><div class="hf-fill" style="width:${p}%;background:${color}"></div></div><div class="hf-thumb" style="left:calc(${p}% - 11px)"></div></div>`;
}

const BLACK = new Set([1, 3, 6, 8, 10]);
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Piano keyboard from..to (MIDI), percentage-positioned so it scales.
 * ranges: [{low, high, color, label}] drawn as bars above the keys.
 */
export function keyboard(from, to, { held = [], ranges = [], showRanges = true, labels = true } = {}) {
  const whites = [];
  for (let n = from; n <= to; n++) if (!BLACK.has(n % 12)) whites.push(n);
  const W = 100 / whites.length;
  const span = (n) => {
    if (!BLACK.has(n % 12)) { const i = whites.indexOf(n); return [i * W, (i + 1) * W]; }
    const i = whites.indexOf(n - 1); const cx = (i + 1) * W; return [cx - W * 0.31, cx + W * 0.31];
  };
  const heldSet = new Set(held);
  let keys = '';
  whites.forEach((n, i) => {
    const lab = labels && n % 12 === 0 ? `<span>${NAMES[0]}${Math.floor(n / 12) - 1}</span>` : '';
    keys += `<div class="wk${heldSet.has(n) ? ' held' : ''}" style="left:${(i * W).toFixed(3)}%;width:${W.toFixed(3)}%">${lab}</div>`;
  });
  for (let n = from; n <= to; n++) {
    if (!BLACK.has(n % 12)) continue;
    const [a, b] = span(n);
    keys += `<div class="bk${heldSet.has(n) ? ' held' : ''}" style="left:${a.toFixed(3)}%;width:${(b - a).toFixed(3)}%"></div>`;
  }
  let bars = '';
  if (showRanges && ranges.length) {
    ranges.forEach((r, j) => {
      const lo = Math.max(from, r.low), hi = Math.min(to, r.high);
      const a = span(lo)[0], b = span(hi)[1];
      const openL = r.low < from, openR = r.high > to;
      bars += `<div class="rbar${openL ? ' open-l' : ''}${openR ? ' open-r' : ''}${r.dim ? ' dim' : ''}" style="top:${j * 7}px;left:${a.toFixed(2)}%;width:${(b - a).toFixed(2)}%;--c:${r.color}">${r.label ? `<em>${r.label}</em>` : ''}</div>`;
    });
  }
  return `<div class="kbd">${showRanges && ranges.length ? `<div class="rbars" style="height:${ranges.length * 7}px">${bars}</div>` : ''}<div class="keys">${keys}</div></div>`;
}

/** Wrap a page: inline CSS + body. */
export function page(title, css, body, bodyClass = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${css}</style></head>
<body class="${bodyClass}">${SVG_DEFS}${body}</body></html>
`;
}
