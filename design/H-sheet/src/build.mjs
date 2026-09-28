// node design/H-sheet/src/build.mjs [--shots] [--only=a.png,b.png] → writes design/H-sheet/*.html (self-contained) + PNGs.
// Perform and Quick come from H's generators, copied unchanged (perform.mjs, quick.mjs, base.css, helpers.mjs).
// Only Edit is new: edit-sheet.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { page } from './helpers.mjs';
import { performBody, PERFORM_CSS } from './perform.mjs';
import { quickSheet, QUICK_CSS } from './quick.mjs';
import { editBody, EDIT_CSS } from './edit-sheet.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..');
const base = readFileSync(join(here, 'base.css'), 'utf8');
const P = base + PERFORM_CSS;
const E = base + EDIT_CSS;

// Places the word popover under the open word (static mockup; the app would anchor it the same way).
const anchor = `<script>
  (() => {
    const w = document.querySelector('.w.open'), pop = document.querySelector('.amt'), sheet = document.querySelector('.sheet');
    if (!w || !pop || !sheet) return;
    const a = w.getBoundingClientRect(), s = sheet.getBoundingClientRect();
    pop.style.setProperty('--px', (a.left - s.left + a.width / 2 - 44) + 'px');
    pop.style.setProperty('--py', (a.bottom - s.top + 12) + 'px');
  })();
</script>`;

// Opening a line scrolls it fully into view (the app would call scrollIntoView({block: 'nearest'})).
const reveal = `<script>
  (() => { const o = document.querySelector('.ln.open'); if (o) o.scrollIntoView({ block: 'nearest' }); })();
</script>`;

const pages = {
  'perform.html': page('Perform — H-sheet', P, performBody()),
  'perform-step.html': page('Perform, Bass octave steps open — H-sheet', P, performBody({ step: '3-oct' })),
  'quick-settings.html': page('Quick settings — H-sheet', P + QUICK_CSS, performBody({ quick: quickSheet() })),
  'edit.html': page('Edit, song sheet — H-sheet', E, editBody('keys')),
  'edit-word.html': page('Edit, a word tapped — H-sheet', E, editBody('keys', { word: 'space' }) + anchor),
  'edit-advanced.html': page('Edit, Keys Advanced open — H-sheet', E, editBody('keys', { advanced: true }) + reveal),
  'edit-fx.html': page('Edit, Effects line open — H-sheet', E, editBody('fx') + reveal),
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
    ['quick-settings.html', 'quick.png', 1440, 900],
    ['edit.html', 'edit.png', 1440, 900],
    ['edit.html', 'edit-1024.png', 1024, 700],
    ['edit-word.html', 'edit-word.png', 1440, 900],
    ['edit-word.html', 'edit-word-1024.png', 1024, 700],
    ['edit-advanced.html', 'edit-advanced.png', 1440, 900],
    ['edit-fx.html', 'edit-fx.png', 1440, 900],
    ['edit-fx.html', 'edit-fx-1024.png', 1024, 700],
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
