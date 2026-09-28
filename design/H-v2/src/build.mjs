// node design/H-v2/src/build.mjs [--shots] [--only=a.png,b.png] → writes design/H-v2/*.html (self-contained) + PNGs.
// Also prints the measured fader throw (px) for the 4-chip and 2-chip strips at 1440 and 1024.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { page } from './helpers.mjs';
import { performBody, PERFORM_CSS } from './perform.mjs';
import { quickSheet, QUICK_CSS } from './quick.mjs';
import { editBody, EDIT_CSS } from './edit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..');
const base = readFileSync(join(here, 'base.css'), 'utf8');
const P = base + PERFORM_CSS;

const pages = {
  'perform.html': page('Perform — H-v2', P, performBody()),
  'perform-2chips.html': page('Perform, two chips per strip — H-v2', P, performBody({ chips: 2 })),
  'perform-off.html': page('Perform, Pad switched off — H-v2', P, performBody({ off: 1 })),
  'perform-locked.html': page('Perform, locked (behaviour change) — H-v2', P, performBody({ locked: true })),
  'perform-step.html': page('Perform, Keys octave steps open — H-v2', P, performBody({ step: '0-oct' })),
  'perform-key.html': page('Perform, Sing it in — H-v2', P, performBody({ keyPop: true })),
  'quick-settings.html': page('Quick settings — H-v2', P + QUICK_CSS, performBody({ quick: quickSheet() })),
  'edit.html': page('Edit — H-v2', base + EDIT_CSS, editBody('keys')),
  'edit-wiring.html': page('Edit, wiring shown — H-v2', base + EDIT_CSS, editBody('keys', { wire: true })),
  'edit-effects.html': page('Edit, Effects tab — H-v2', base + EDIT_CSS, editBody('effects')),
};
for (const [f, html] of Object.entries(pages)) writeFileSync(join(out, f), html);
console.log('wrote', Object.keys(pages).join(', '));

if (process.argv.includes('--shots')) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const shots = [
    ['perform.html', 'perform.png', 1440, 900],
    ['perform.html', 'perform-1024.png', 1024, 700],
    ['perform-2chips.html', 'perform-2chips.png', 1440, 900],
    ['perform-2chips.html', 'perform-2chips-1024.png', 1024, 700],
    ['perform-off.html', 'perform-off.png', 1440, 900],
    ['perform-off.html', 'perform-off-1024.png', 1024, 700],
    ['perform-locked.html', 'perform-locked.png', 1440, 900],
    ['perform-step.html', 'perform-step.png', 1440, 900],
    ['perform-key.html', 'perform-key.png', 1440, 900],
    ['quick-settings.html', 'quick.png', 1440, 900],
    ['edit.html', 'edit.png', 1440, 900],
    ['edit.html', 'edit-1024.png', 1024, 700],
    ['edit-wiring.html', 'edit-wiring.png', 1440, 900],
    ['edit-effects.html', 'edit-effects.png', 1440, 900],
  ];
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
  for (const [src, png, w, h] of shots) {
    if (only && !only.includes(png)) continue;
    const p = await browser.newPage();
    await p.setViewportSize({ width: w, height: h });
    await p.goto('file://' + join(out, src));
    await p.screenshot({ path: join(out, png) });
    if (src.startsWith('perform') && !src.includes('key')) {
      const t = await p.evaluate(() => [...document.querySelectorAll('.strip:not(.empty) .vf-track')].map((e) => Math.round(e.getBoundingClientRect().height)));
      console.log(`${png}: fader track heights ${t.join(', ')} px`);
    }
    await p.close();
  }
  // 50 % legibility check for ON vs OFF (brief item 2): the 1024 OFF shot, halved.
  if (!only || only.includes('perform-off-1024.png')) {
    const p = await browser.newPage({ deviceScaleFactor: 0.5 });
    await p.setViewportSize({ width: 1024, height: 700 });
    await p.goto('file://' + join(out, 'perform-off.html'));
    await p.screenshot({ path: join(out, 'perform-off-1024-50pct.png') });
    await p.close();
  }
  await browser.close();
  console.log('shots done');
}
