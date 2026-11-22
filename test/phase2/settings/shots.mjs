#!/usr/bin/env node
// Settings screenshots for reviews (not a test): the real app (Chrome mode) with Settings open, one PNG per category
// at 1440×900 and 820×1180 (iPad portrait) → native/docs/reviews/settings-shots/<tag>-<category>-<w>x<h>.png.
//   node test/phase2/settings/shots.mjs [--tag after] [--mac] [--out <dir>] [--only <cat,...>] [--advanced]
// --mac stands in a minimal fake window.rig ({isElectron:true}) so the Mac category shows. A page without category
// tabs (the 1.x single page) is captured as consecutive scroll positions of .st-body instead (<tag>-page-<n>-…).
// UIB: --out writes elsewhere (native/docs/reviews/<id>-shots/), --only limits the categories, --advanced opens each
// category's Advanced disclosure and scrolls it into view before the shot.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { waitRigReady, pinTheme } from '../../integration/lib.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const argOf = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const OUT = argOf('--out') ? path.resolve(argOf('--out')) : path.join(ROOT, 'native/docs/reviews/settings-shots');
const ONLY = argOf('--only') ? new Set(argOf('--only').split(',')) : null;
const ADVANCED = process.argv.includes('--advanced');
const { createServer } = require(path.join(ROOT, 'server.js'));
const argv = process.argv.slice(2);
const TAG = argv.includes('--tag') ? argv[argv.indexOf('--tag') + 1] : 'after';
const MAC = argv.includes('--mac');
const SIZES = [[1440, 900], [820, 1180]];

fs.mkdirSync(OUT, { recursive: true });
const server = createServer({ appDir: path.join(ROOT, 'app'), port: 0 });
const info = await server.listen();
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const written = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await pinTheme(context, 'classic');
  if (MAC) {
    await context.addInitScript(() => {
      window.rig = { isElectron: true };
    });
  }
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${info.port}/`);
  await waitRigReady(page, { timeout: 30000 });
  const overlay = await page.$('#overlay-start:not([hidden])');
  if (overlay) await overlay.click();
  await page.evaluate(() => window.__rig.ctx.openSettings());
  await page.waitForFunction(() => window.__rig.views.settings.isOpen);
  const clean = () => page.evaluate(() => {
    for (const t of document.querySelectorAll('#toasts > *')) t.remove();
    document.activeElement?.blur?.();
  });
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(250);
    const cats = await page.evaluate(() => [...document.querySelectorAll('#view-settings [role=tab]')]
      .filter((t) => !t.hidden).map((t) => t.dataset.cat));
    if (cats.length) {
      for (const c of cats) {
        if (ONLY && !ONLY.has(c)) continue;
        await page.click(`#view-settings [role=tab][data-cat="${c}"]`);
        await page.evaluate(({ cat, adv }) => {
          const b = document.querySelector('#view-settings .st-body');
          if (b) b.scrollTop = 0;
          const d = adv && document.querySelector(`#view-settings details.st-adv[data-adv="${cat}"]`);
          if (d) {
            d.open = true;
            d.scrollIntoView({ block: 'start' });
          }
        }, { cat: c, adv: ADVANCED });
        await clean();
        await page.waitForTimeout(150);
        const file = path.join(OUT, `${TAG}-${c}${ADVANCED ? '-advanced' : ''}-${w}x${h}.png`);
        await page.screenshot({ path: file });
        written.push(file);
      }
    } else {
      const { total, step } = await page.evaluate(() => {
        const b = document.querySelector('#view-settings .st-body');
        return { total: b.scrollHeight, step: Math.max(200, b.clientHeight - 40) };
      });
      for (let i = 0, y = 0; y < total && i < 8; i += 1, y += step) {
        await page.evaluate((top) => {
          document.querySelector('#view-settings .st-body').scrollTop = top;
        }, y);
        await clean();
        await page.waitForTimeout(150);
        const file = path.join(OUT, `${TAG}-page-${i + 1}-${w}x${h}.png`);
        await page.screenshot({ path: file });
        written.push(file);
      }
    }
  }
  await context.close();
} finally {
  await browser.close();
  await server.close();
}
console.log(written.map((f) => path.relative(ROOT, f)).join('\n'));
