// node design/A/src/build.mjs [--shots]  → writes design/A/*.html (self-contained) and optionally PNGs.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { page } from './helpers.mjs';
import { performBody, PERFORM_CSS } from './perform.mjs';
import { quickDrawer, QUICK_CSS } from './quick.mjs';
import { editBody, EDIT_CSS } from './edit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..');
const base = readFileSync(join(here, 'base.css'), 'utf8');

const pages = {
  'perform.html': page('Perform — angle A', base + PERFORM_CSS, performBody()),
  'perform-chip.html': page('Perform chip popover — angle A', base + PERFORM_CSS, performBody({ popover: true })),
  'quick-settings.html': page('Quick settings — angle A', base + PERFORM_CSS + QUICK_CSS, performBody({ quick: quickDrawer() })),
  'edit.html': page('Edit — angle A', base + EDIT_CSS, editBody('keys')),
  'edit-space.html': page('Edit, Space selected — angle A', base + EDIT_CSS, editBody('room')),
  'edit-advanced.html': page('Edit, Advanced open — angle A', base + EDIT_CSS, editBody('pad', { advanced: true })),
};
for (const [f, html] of Object.entries(pages)) writeFileSync(join(out, f), html);
console.log('wrote', Object.keys(pages).join(', '));

if (process.argv.includes('--shots')) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const shots = [
    ['perform.html', 'perform.png', 1440, 900],
    ['perform.html', 'perform-1024.png', 1024, 700],
    ['perform-chip.html', 'perform-chip.png', 1440, 900],
    ['quick-settings.html', 'quick.png', 1440, 900],
    ['quick-settings.html', 'quick-1024.png', 1024, 700],
    ['edit.html', 'edit.png', 1440, 900],
    ['edit.html', 'edit-1024.png', 1024, 700],
    ['edit-space.html', 'edit-space.png', 1440, 900],
    ['edit-advanced.html', 'edit-advanced.png', 1440, 900],
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
