#!/usr/bin/env node
// U-CVD (native DECISIONS D32): the colour-blind instrument palettes, checked. Reads the palettes from styles.css (the
// block between `cvd:palettes begin` / `cvd:palettes end`) and, for every theme × type, prints:
//   - the minimum OKLab ΔE×100 between any two of the first 8 slots under Machado 2009 (severity 1.0) simulation of
//     that type ('rg' = deutan AND protan, the worse of the two; 'by' = tritan), and under normal vision;
//   - the minimum OKLab L difference between neighbouring slots (0–1, …, 6–7, and 7–0: slot 8 repeats slot 0),
//     normal and simulated (the smaller one);
//   - the lowest WCAG contrast of the theme's lamp ink on a lamp (flat) and in the ON label's window (the theme's
//     window colour composited over the lamp, as the ON tile draws it).
// Thresholds (CONTRACT_CHANGES "## U-CVD"): ΔE ≥ 10, ΔL ≥ 0.08, ink ≥ 4.5 in both. The browser audit
// (test/phase2/ui-v6-themes, with cvd on) measures what is actually drawn; this is the design-time check.
//   node tools/themes/cvd-check.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const STYLES = path.join(ROOT, 'app/styles.css');
export const THRESHOLDS = Object.freeze({ dE: 10, dL: 0.08, ink: 4.5 });
/** The CVD types the setting offers, and the Machado deficiencies each one must survive. */
export const TYPES = Object.freeze({ rg: ['deutan', 'protan'], by: ['tritan'] });

/**
 * Each theme's lamp ink and the ON label's window (styles.css / the theme file's `.ontile .ot-state` background),
 * as resolved in Chromium (tools: getComputedStyle on a lit v6 ON tile). `file` + `ink` are checked against the
 * theme source by test/unit/shared/cvd-palettes.test.mjs, so a theme change that moves them fails there.
 */
export const THEMES = Object.freeze({
  classic: { ink: '#0d0f12', win: ['#0d0f12', 0.18], file: 'app/styles.css' },
  sanctuary: { ink: '#150f08', win: ['#fff8e8', 0.22], file: 'app/themes/sanctuary-v2/theme.css' },
  'sanctuary-day': { ink: '#fffaf0', win: ['#1a0a14', 0.22], file: 'app/themes/sanctuary-v2/theme.css' },
  'daylight-stage': { ink: '#1d1712', win: ['#1d1712', 0.14], file: 'app/themes/daylight-v2/theme.css' },
  'daylight-day': { ink: '#241a10', win: ['#241a10', 0.14], file: 'app/themes/daylight-v2/theme.css' },
  studio: { ink: '#1f1915', win: ['#1f1915', 0.14], file: 'app/themes/studio/theme.css' },
  ember: { ink: '#1e130e', win: ['#fff6ea', 0.32], file: 'app/themes/ember/theme.css' },
  nave: { ink: '#150f08', win: ['#150f08', 0.19], file: 'app/themes/sanctuary/theme.css' },
});

// ------------------------------------------------------------------------------------------------ colour maths
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const enc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);
/** '#rrggbb' → [r, g, b] in 0..1 (gamma-encoded sRGB). */
export const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
/** [r, g, b] in 0..1 → '#rrggbb' (clamped). */
export const hex = (c) => `#${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16)
  .padStart(2, '0')).join('')}`;
/** WCAG relative luminance of an encoded sRGB triple. */
export const lum = (c) => {
  const [r, g, b] = c.map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast ratio of two encoded sRGB triples. */
export const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** `over` at `alpha` composited on `under` (encoded sRGB, as a browser blends an rgba() fill). */
export const over = (top, alpha, under) => under.map((u, i) => top[i] * alpha + u * (1 - alpha));
/** Encoded sRGB → OKLab [L, a, b]. */
export function oklab(c) {
  const [r, g, b] = c.map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}
/** OKLab → encoded sRGB, unclamped (a component outside 0..1 = out of gamut). */
export function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const lr = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  return lr.map((v) => (v < 0 ? -enc(-v) : enc(v)));
}
/** Machado, Oliveira & Fernandes 2009, severity 1.0 (linear RGB). */
export const MACHADO = Object.freeze({
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
});
/** The colour as a viewer with `kind` (deutan / protan / tritan, or 'normal') sees it (encoded sRGB). */
export function simulate(c, kind) {
  if (kind === 'normal') return c;
  const l = c.map(lin);
  return MACHADO[kind].map((row) => enc(Math.min(1, Math.max(0, row[0] * l[0] + row[1] * l[1] + row[2] * l[2]))));
}
/** OKLab ΔE × 100. */
export const dE = (a, b) => {
  const p = oklab(a);
  const q = oklab(b);
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};

// ------------------------------------------------------------------------------------------------ palettes
/**
 * Read the palettes from styles.css: `html.cvd-<type>[data-theme="<id>"] … { --slot-0: #…; … --slot-7: #…; }`.
 * @param {string} [file]
 * @returns {Record<string, Record<string, string[]>>} theme id → type → the 8 hex colours
 */
export function readPalettes(file = STYLES) {
  const css = fs.readFileSync(file, 'utf8');
  const a = css.indexOf('cvd:palettes begin');
  const b = css.indexOf('cvd:palettes end');
  if (a < 0 || b < a) throw new Error(`no cvd:palettes block in ${file}`);
  const out = {};
  const re = /html\.cvd-(rg|by)\[data-theme="([a-z-]+)"\][^{]*\{([^}]*)\}/g;
  for (const m of css.slice(a, b).matchAll(re)) {
    const [, type, id, body] = m;
    const cols = [];
    for (let i = 0; i < 8; i++) {
      const v = new RegExp(`--slot-${i}:\\s*(#[0-9a-f]{6})\\b`, 'i').exec(body);
      if (!v) throw new Error(`${id} ${type}: --slot-${i} is not a #rrggbb value`);
      cols.push(v[1].toLowerCase());
    }
    (out[id] ||= {})[type] = cols;
  }
  return out;
}

/** Neighbours in the 16-slot cycle that slots 0..7 make (8 repeats 0). */
export const NEIGHBOURS = Object.freeze([[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 0]]);

/**
 * The numbers for one palette.
 * @param {string[]} cols  8 hex colours
 * @param {'rg'|'by'} type
 * @param {{ink:string, win:[string, number]}} theme
 * @returns {{dE:number, dEPair:string, dEKind:string, dENormal:number, dL:number, dLPair:string, ink:number,
 *   inkWin:number, inkAt:string}}
 */
export function measure(cols, type, theme) {
  const c = cols.map(rgb);
  let best = { dE: Infinity };
  for (const kind of TYPES[type]) {
    const s = c.map((x) => simulate(x, kind));
    for (let i = 0; i < 8; i++) {
      for (let j = i + 1; j < 8; j++) {
        const v = dE(s[i], s[j]);
        if (v < best.dE) best = { dE: v, dEPair: `${i}–${j}`, dEKind: kind };
      }
    }
  }
  let dENormal = Infinity;
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) dENormal = Math.min(dENormal, dE(c[i], c[j]));
  let dL = { v: Infinity };
  for (const [i, j] of NEIGHBOURS) {
    for (const kind of ['normal', ...TYPES[type]]) {
      const v = Math.abs(oklab(simulate(c[i], kind))[0] - oklab(simulate(c[j], kind))[0]);
      if (v < dL.v) dL = { v, pair: `${i}–${j}` };
    }
  }
  const ink = rgb(theme.ink);
  const win = rgb(theme.win[0]);
  let flat = Infinity;
  let inWin = Infinity;
  let inkAt = '';
  for (let i = 0; i < 8; i++) {
    flat = Math.min(flat, contrast(ink, c[i]));
    const w = contrast(ink, over(win, theme.win[1], c[i]));
    if (w < inWin) {
      inWin = w;
      inkAt = String(i);
    }
  }
  return { dE: best.dE, dEPair: best.dEPair, dEKind: best.dEKind, dENormal, dL: dL.v, dLPair: dL.pair, ink: flat,
    inkWin: inWin, inkAt };
}

/**
 * Every theme × type: the numbers and whether they meet THRESHOLDS.
 * @returns {Array<{theme:string, type:string, cols:string[], ok:boolean} & ReturnType<typeof measure>>}
 */
export function checkAll(file = STYLES) {
  const pal = readPalettes(file);
  const rows = [];
  for (const [id, theme] of Object.entries(THEMES)) {
    for (const type of Object.keys(TYPES)) {
      const cols = pal[id]?.[type];
      if (!cols) {
        rows.push({ theme: id, type, cols: null, ok: false, missing: true });
        continue;
      }
      const m = measure(cols, type, theme);
      const ok = m.dE >= THRESHOLDS.dE && m.dL >= THRESHOLDS.dL && m.ink >= THRESHOLDS.ink
        && m.inkWin >= THRESHOLDS.ink;
      rows.push({ theme: id, type, cols, ok, ...m });
    }
  }
  return rows;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = checkAll();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 1));
  } else {
    const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');
    console.log(`U-CVD palettes (styles.css), thresholds ΔE×100 ≥ ${THRESHOLDS.dE}, neighbour ΔL ≥ `
      + `${THRESHOLDS.dL}, ink ≥ ${THRESHOLDS.ink}`);
    console.log('theme           type  min ΔE sim (pair, kind)    ΔE normal  min ΔL (pair)   ink flat  ink in window');
    for (const r of rows) {
      if (r.missing) {
        console.log(`${r.theme.padEnd(15)} ${r.type}    MISSING`);
        continue;
      }
      console.log(`${r.theme.padEnd(15)} ${r.type.padEnd(4)}  ${f(r.dE).padStart(5)} (${r.dEPair}, ${r.dEKind})`
        .padEnd(46) + `${f(r.dENormal).padStart(6)}     ${f(r.dL, 3)} (${r.dLPair})     ${f(r.ink, 2).padStart(5)}`
        + `     ${f(r.inkWin, 2).padStart(5)} (slot ${r.inkAt})  ${r.ok ? 'ok' : 'FAIL'}`);
    }
    const bad = rows.filter((r) => !r.ok);
    console.log(bad.length ? `\n${bad.length} palette(s) under the thresholds` : `\nall ${rows.length} palettes pass`);
    process.exitCode = bad.length ? 1 : 0;
  }
}
