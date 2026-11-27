// U-CVD (native DECISIONS D32): the colour-blind instrument palettes in styles.css meet their design thresholds for
// every theme × type (tools/themes/cvd-check.mjs: Machado 2009 severity 1.0, OKLab ΔE×100 ≥ 10 between any two of
// the first 8 slots, neighbours ΔL ≥ 0.08, the theme's lamp ink ≥ 4.5 : 1 flat and in the ON label's window).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAll, readPalettes, THEMES, THRESHOLDS, TYPES, measure, simulate, rgb, hex, dE } from
  '../../../tools/themes/cvd-check.mjs';
import { THEMES as REGISTRY } from '../../../app/js/shared/themes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('cvd-check: every registered theme has an rg and a by palette, and every one passes', () => {
  const ids = REGISTRY.map((t) => t.id).sort();
  assert.deepEqual(Object.keys(THEMES).sort(), ids, 'the checker knows every registered theme');
  const pal = readPalettes();
  for (const id of ids) assert.deepEqual(Object.keys(pal[id] || {}).sort(), ['by', 'rg'], id);
  const rows = checkAll();
  assert.equal(rows.length, ids.length * Object.keys(TYPES).length);
  for (const r of rows) {
    const at = `${r.theme} ${r.type}`;
    assert.ok(r.dE >= THRESHOLDS.dE, `${at}: min simulated ΔE ${r.dE.toFixed(2)} (${r.dEPair}, ${r.dEKind})`);
    assert.ok(r.dENormal >= THRESHOLDS.dE, `${at}: min ΔE for normal vision ${r.dENormal.toFixed(2)}`);
    assert.ok(r.dL >= THRESHOLDS.dL, `${at}: neighbour ΔL ${r.dL.toFixed(3)} (${r.dLPair})`);
    assert.ok(r.ink >= THRESHOLDS.ink, `${at}: lamp ink ${r.ink.toFixed(2)}`);
    assert.ok(r.inkWin >= THRESHOLDS.ink, `${at}: lamp ink in the ON window ${r.inkWin.toFixed(2)}`);
    assert.equal(new Set(r.cols).size, 8, `${at}: 8 different colours`);
  }
});

test('cvd-check: the inks and windows it judges by are the theme files’ own', () => {
  for (const [id, t] of Object.entries(THEMES)) {
    const src = fs.readFileSync(path.join(ROOT, t.file), 'utf8').toLowerCase();
    assert.ok(src.includes(t.ink), `${id}: ink ${t.ink} in ${t.file}`);
    const a = Math.round(t.win[1] * 255).toString(16).padStart(2, '0');
    const asHex = `${t.win[0]}${a}`;
    // the window is either #rrggbbaa or a color-mix(in oklab, <ink> 14%, transparent)
    assert.ok(src.includes(asHex) || (t.win[0] === t.ink && src.includes(`${Math.round(t.win[1] * 100)}%`)),
      `${id}: window ${asHex} in ${t.file}`);
  }
});

test('cvd-check: the maths (Machado deutan of pure red, ΔE of black–white, a known failing palette)', () => {
  // Machado 2009 deuteranopia maps sRGB red to a dark olive
  const r = simulate(rgb('#ff0000'), 'deutan').map((v) => Math.round(v * 255));
  assert.ok(Math.abs(r[0] - 164) <= 3 && Math.abs(r[1] - 146) <= 3 && r[2] <= 3, `deutan red ${r}`);
  assert.ok(Math.abs(dE(rgb('#000000'), rgb('#ffffff')) - 100) < 0.01);
  assert.equal(hex(rgb('#a1b2c3')), '#a1b2c3');
  // today's (Off) Classic lamps, 0..3 and the v6 positions 4..6, with 7 = 0 again: the case the setting fixes
  const off = ['#ff8a3d', '#3ddc84', '#4aa8ff', '#b784ff', '#ee84b2', '#c9d867', '#6f9cf0', '#ff8a3d'];
  const m = measure(off, 'rg', THEMES.classic);
  assert.ok(m.dE < THRESHOLDS.dE, `Off Classic under rg: ${m.dE}`);
});

test('styles.css: the cvd rules only match under html.cvd-rg / html.cvd-by (Off is today\'s app)', () => {
  const css = fs.readFileSync(path.join(ROOT, 'app/styles.css'), 'utf8');
  const at = css.indexOf('U-CVD: colour-blind colours');
  assert.ok(at > 0);
  const tail = css.slice(css.lastIndexOf('/*', at)).replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [...tail.matchAll(/([^{}]+)\{[^}]*\}/g)].map((m) => m[1].trim());
  assert.ok(selectors.length > 20);
  for (const sel of selectors) {
    for (const part of sel.split(/,(?![^(]*\))/)) {
      assert.match(part.trim(), /^html(:is\(\.cvd-rg, \.cvd-by\)|\.cvd-(rg|by))/, `unguarded: ${part.trim()}`);
    }
  }
});
