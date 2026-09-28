// Screenshot the angle-C mockups. Run from the repo root: node design/C/src/shoot.mjs
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = [
  ['perform.html', 'perform.png', 1440, 900],
  ['perform.html', 'perform-1024.png', 1024, 700],
  ['quick-settings.html', 'quick.png', 1440, 900],
  ['quick-settings.html', 'quick-1024.png', 1024, 700],
  ['edit.html', 'edit.png', 1440, 900],
  ['edit-fx.html', 'edit-fx.png', 1440, 900],
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [src, out, w, h] of SHOTS) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto('file://' + join(DIR, src));
  await page.screenshot({ path: join(DIR, out) });
  const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight }));
  console.log(out, JSON.stringify(overflow));
}
await browser.close();
