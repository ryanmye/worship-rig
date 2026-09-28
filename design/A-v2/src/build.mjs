// node design/A-v2/src/build.mjs [--shots] [--only=a.png,b.png] → writes design/A-v2/*.html (self-contained) + PNGs.
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
  'perform.html': page('Perform — A v2', P, performBody()),
  'perform-chip.html': page('Perform, Space steps open — A v2', P, performBody({ chip: '1-room' })),
  'perform-muted.html': page('Perform, Pad muted — A v2', P, performBody({ muted: 1 })),
  'perform-key.html': page('Perform, Sing it in — A v2', P, performBody({ keyPop: true })),
  'quick-settings.html': page('Quick settings — A v2', P + QUICK_CSS, performBody({ quick: quickSheet() })),
  'quick-problem.html': page('Quick settings, sound stalled — A v2', P + QUICK_CSS, performBody({ quick: quickSheet({ problem: true, qx: 250 }) })),
  'edit.html': page('Edit — A v2', base + EDIT_CSS, editBody('keys')),
  'edit-menu.html': page('Edit, instrument menu — A v2', base + EDIT_CSS, editBody('keys', { menu: true })),
  'edit-space.html': page('Edit, Space selected — A v2', base + EDIT_CSS, editBody('room')),
  'edit-advanced.html': page('Edit, Advanced open — A v2', base + EDIT_CSS, editBody('pad', { advanced: true })),
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
    ['perform-chip.html', 'perform-chip-1024.png', 1024, 700],
    ['perform-muted.html', 'perform-muted.png', 1440, 900],
    ['perform-key.html', 'perform-key.png', 1440, 900],
    ['quick-settings.html', 'quick.png', 1440, 900],
    ['quick-problem.html', 'quick-1024.png', 1024, 700],
    ['edit.html', 'edit.png', 1440, 900],
    ['edit.html', 'edit-1024.png', 1024, 700],
    ['edit-menu.html', 'edit-menu.png', 1440, 900],
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
