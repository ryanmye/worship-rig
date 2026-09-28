// node design/H/src/build.mjs [--shots] [--only=a.png,b.png] → writes design/H/*.html (self-contained) + PNGs.
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
  'perform.html': page('Perform — H', P, performBody()),
  'perform-step.html': page('Perform, Bass octave steps open — H', P, performBody({ step: '3-oct' })),
  'perform-space.html': page('Perform, Pad Space steps open — H', P, performBody({ step: '1-room' })),
  'perform-off.html': page('Perform, Pad switched off — H', P, performBody({ off: 1 })),
  'perform-locked.html': page('Perform, locked — H', P, performBody({ locked: true })),
  'perform-key.html': page('Perform, Sing it in — H', P, performBody({ keyPop: true })),
  'quick-settings.html': page('Quick settings — H', P + QUICK_CSS, performBody({ quick: quickSheet() })),
  'quick-problem.html': page('Quick settings, sound stalled — H', P + QUICK_CSS, performBody({ quick: quickSheet({ problem: true, qx: 250 }) })),
  'edit.html': page('Edit — H', base + EDIT_CSS, editBody('keys')),
  'edit-pad.html': page('Edit, Pad selected — H', base + EDIT_CSS, editBody('pad')),
  'edit-space.html': page('Edit, Space selected — H', base + EDIT_CSS, editBody('room')),
};
for (const [f, html] of Object.entries(pages)) writeFileSync(join(out, f), html);
console.log('wrote', Object.keys(pages).join(', '));

if (process.argv.includes('--shots')) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const shots = [
    ['perform.html', 'perform.png', 1440, 900],
    ['perform.html', 'perform-1024.png', 1024, 700],
    ['perform-step.html', 'perform-step.png', 1440, 900],
    ['perform-space.html', 'perform-space-1024.png', 1024, 700],
    ['perform-off.html', 'perform-off.png', 1440, 900],
    ['perform-locked.html', 'perform-locked.png', 1440, 900],
    ['perform-key.html', 'perform-key.png', 1440, 900],
    ['quick-settings.html', 'quick.png', 1440, 900],
    ['quick-problem.html', 'quick-1024.png', 1024, 700],
    ['edit.html', 'edit.png', 1440, 900],
    ['edit.html', 'edit-1024.png', 1024, 700],
    ['edit-pad.html', 'edit-pad.png', 1440, 900],
    ['edit-space.html', 'edit-space.png', 1440, 900],
  ];
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
  for (const [src, png, w, h] of shots) {
    if (only && !only.includes(png)) continue;
    const p = await browser.newPage();
    await p.setViewportSize({ width: w, height: h });
    await p.goto('file://' + join(out, src));
    await p.screenshot({ path: join(out, png) });
    await p.close();
  }
  await browser.close();
  console.log('shots done');
}
