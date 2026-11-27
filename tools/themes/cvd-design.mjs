#!/usr/bin/env node
// U-CVD (D32): how the colour-blind palettes in styles.css were found. For each theme × type, a seeded search in
// OKLCH (gamut-mapped by chroma) for 8 lamp colours that maximise the smallest simulated ΔE×100 between any two
// (Machado 2009, severity 1.0; 'rg' = deutan and protan, 'by' = tritan), with hard floors: neighbour ΔL ≥ 0.09,
// the theme's lamp ink ≥ 5.2 : 1 flat and ≥ 4.9 : 1 in the ON label's window (margins over the audit's 4.5 for the
// lamps' gradients), and soft pulls toward the theme's own first four hues, toward chroma, and away from the drone.
// Prints the CSS block; `--write` replaces the block between the cvd:palettes markers in styles.css.
// Deterministic (seeded); tools/themes/cvd-check.mjs is the check.
//   node tools/themes/cvd-design.mjs [--theme id] [--type rg|by] [--seed n] [--write]
import fs from 'node:fs';
import { THEMES, TYPES, STYLES, rgb, hex, oklab, fromOklab, simulate, dE, contrast, over, NEIGHBOURS,
  checkAll, readPalettes } from './cvd-check.mjs';

/** Each theme's own first four lamps (Off) and its drone, the soft targets. */
const SEED = {
  classic: { slots: ['#ff8a3d', '#3ddc84', '#4aa8ff', '#b784ff'], drone: '#e8d9a8' },
  sanctuary: { slots: ['#f78955', '#4ec491', '#7ad1f7', '#af80e1'], drone: '#edd9a6' },
  'sanctuary-day': { slots: ['#a63d02', '#006e46', '#02648c', '#7847a6'], drone: '#755002' },
  'daylight-stage': { slots: ['#e9833d', '#66cf7e', '#139be5', '#e398fe'], drone: '#eddcae' },
  'daylight-day': { slots: ['#f28a4c', '#79c68f', '#7cc4ee', '#b495db'], drone: '#e4d3a8' },
  studio: { slots: ['#f47e4f', '#6fd183', '#9edaff', '#bd90d9'], drone: '#ebd9ae' },
  ember: { slots: ['#e68867', '#a9daa4', '#80b9de', '#bb79b5'], drone: '#edd9aa' },
  nave: { slots: ['#f7775f', '#5fc98a', '#7ad1f7', '#bc8ae0'], drone: '#edd9a6' },
};
const FLOOR = { dL: 0.09, ink: 5.2, win: 4.9 };

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const inGamut = (c) => c.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
/** OKLCH → encoded sRGB, chroma reduced until it fits. */
function toRgb([L, C, h]) {
  const at = (c) => fromOklab([L, c * Math.cos(h), c * Math.sin(h)]);
  let c = C;
  if (!inGamut(at(c))) {
    let lo = 0;
    let hi = C;
    for (let k = 0; k < 18; k++) {
      const mid = (lo + hi) / 2;
      if (inGamut(at(mid))) lo = mid;
      else hi = mid;
    }
    c = lo;
  }
  return at(c).map((v) => Math.min(1, Math.max(0, v)));
}
const hueOf = (h) => {
  const [, a, b] = oklab(rgb(h));
  return Math.atan2(b, a);
};
const angle = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

function score(P, type, theme, seed) {
  const c = P.map((p) => rgb(hex(toRgb(p)))); // judge the hex that will be written
  const kinds = TYPES[type];
  const ink = rgb(theme.ink);
  const win = rgb(theme.win[0]);
  let pen = 0;
  for (const x of c) {
    pen += Math.max(0, FLOOR.ink - contrast(ink, x)) * 40;
    pen += Math.max(0, FLOOR.win - contrast(ink, over(win, theme.win[1], x))) * 40;
  }
  for (const [i, j] of NEIGHBOURS) {
    for (const k of ['normal', ...kinds]) {
      const d = Math.abs(oklab(simulate(c[i], k))[0] - oklab(simulate(c[j], k))[0]);
      pen += Math.max(0, FLOOR.dL - d) * 400;
    }
  }
  let min = Infinity;
  let soft = 0;
  for (const k of kinds) {
    const s = c.map((x) => simulate(x, k));
    for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) min = Math.min(min, dE(s[i], s[j]));
    const dr = simulate(rgb(seed.drone), k);
    for (const x of s) soft -= Math.max(0, 9 - dE(x, dr)) * 0.3; // away from the drone's lamp
  }
  let nmin = Infinity;
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) nmin = Math.min(nmin, dE(c[i], c[j]));
  // the theme's own hues first: slots 0..3 stay within ~25° of the theme's lamps (orange, green, blue, purple)
  for (let i = 0; i < 4; i++) {
    const a = angle(P[i][2], hueOf(seed.slots[i]));
    soft -= a * 1.5 + Math.max(0, a - 0.44) * 30;
  }
  c.forEach((p, i) => {
    const C = Math.hypot(oklab(p)[1], oklab(p)[2]);
    // colourful, not grey, not neon; the first four (the theme's own) keep their colour most
    soft -= Math.max(0, (i < 4 ? 0.11 : 0.06) - C) * 60 + Math.max(0, C - 0.17) * 25;
  });
  if (process.env.CVD_PURE) return { v: min - pen, min, pen };
  // the floor first (up to 11.5: 1.5 over the threshold), then normal vision (up to 18), then the look
  return { v: 3 * Math.min(min, 11.5) + Math.min(nmin, 18) - pen + soft, min, pen };
}

function design(id, type, seedN = 1) {
  const theme = THEMES[id];
  const seed = SEED[id];
  const light = contrast(rgb(theme.ink), [1, 1, 1]) > contrast(rgb(theme.ink), [0, 0, 0]); // dark ink → light lamps
  const Lr = light ? [0.6, 0.95] : [0.25, 0.56];
  const rand = rng(seedN * 7919 + id.length * 104729 + (type === 'rg' ? 1 : 2));
  let best = null;
  for (let restart = 0; restart < 24; restart++) {
    // start: the theme's hues for 0..3, then spread; lightness alternating high / low
    let P = Array.from({ length: 8 }, (_, i) => {
      const h = i < 4 ? hueOf(seed.slots[i]) : rand() * 2 * Math.PI;
      const L = Lr[0] + (Lr[1] - Lr[0]) * (i % 2 ? 0.25 + rand() * 0.2 : 0.65 + rand() * 0.25);
      return [L, 0.08 + rand() * 0.1, h];
    });
    let cur = score(P, type, theme, seed);
    let T = 2;
    for (let it = 0; it < 9000; it++) {
      const Q = P.map((p) => p.slice());
      const i = Math.floor(rand() * 8);
      const k = Math.floor(rand() * 3);
      const step = [0.03, 0.03, 0.4][k] * (0.2 + T);
      Q[i][k] += (rand() * 2 - 1) * step;
      Q[i][0] = Math.min(Lr[1], Math.max(Lr[0], Q[i][0]));
      Q[i][1] = Math.min(0.32, Math.max(0.02, Q[i][1]));
      const s = score(Q, type, theme, seed);
      if (s.v > cur.v || rand() < Math.exp((s.v - cur.v) / (T * 0.5 + 1e-3))) {
        P = Q;
        cur = s;
      }
      T *= 0.9994;
      if (!best || cur.v > best.s.v) best = { P: P.map((p) => p.slice()), s: cur };
    }
  }
  return best.P.map((p) => hex(toRgb(p)));
}

/** The CSS block for styles.css. */
function block(pal) {
  const L = ['/* cvd:palettes begin (generated by tools/themes/cvd-design.mjs; checked by tools/themes/cvd-check.mjs) */'];
  for (const [id, byType] of Object.entries(pal)) {
    for (const type of Object.keys(TYPES)) {
      const cols = byType[type];
      if (!cols) continue;
      const decl = cols.map((c, i) => `--slot-${i}: ${c};`);
      L.push(`html.cvd-${type}[data-theme="${id}"], html.cvd-${type}[data-theme="${id}"] > body {`);
      L.push(`  ${decl.slice(0, 4).join(' ')}`);
      L.push(`  ${decl.slice(4).join(' ')}`);
      L.push(`  --cvd-ink: ${THEMES[id].ink};`);
      L.push('}');
    }
  }
  L.push('/* cvd:palettes end */');
  return L.join('\n');
}

const argv = process.argv.slice(2);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const ids = opt('--theme') ? [opt('--theme')] : Object.keys(THEMES);
const types = opt('--type') ? [opt('--type')] : Object.keys(TYPES);
// --write with --theme / --type re-designs those and keeps the other palettes in styles.css
let had = {};
try {
  had = readPalettes();
} catch {
  had = {};
}
const pal = Object.fromEntries(Object.keys(THEMES).map((id) => [id, { ...(had[id] || {}) }]));
const seedN = Number(opt('--seed')) || 1;
for (const id of ids) {
  for (const type of types) {
    pal[id][type] = design(id, type, seedN);
    console.error(`designed ${id} ${type}: ${pal[id][type].join(' ')}`);
  }
}
const css = block(pal);
if (argv.includes('--write')) {
  const src = fs.readFileSync(STYLES, 'utf8');
  const a = src.indexOf('/* cvd:palettes begin');
  const b = src.indexOf('/* cvd:palettes end */');
  if (a < 0 || b < a) throw new Error('styles.css has no cvd:palettes block to replace');
  fs.writeFileSync(STYLES, src.slice(0, a) + css + src.slice(b + '/* cvd:palettes end */'.length));
  for (const r of checkAll()) console.log(`${r.theme} ${r.type}: ΔE ${r.dE?.toFixed(1)} ΔL ${r.dL?.toFixed(3)} `
    + `ink ${r.ink?.toFixed(2)} / ${r.inkWin?.toFixed(2)} ${r.ok ? 'ok' : 'FAIL'}`);
} else {
  console.log(css);
}
