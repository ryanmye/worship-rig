import { createRequire } from 'node:module';
import fs from 'node:fs'; import path from 'node:path';
const require = createRequire('/home/claude/worship-rig/package.json');
const { chromium } = require('playwright');
const { createServer } = require('/home/claude/worship-rig/server.js');
const here = path.dirname(new URL(import.meta.url).pathname);
const server = createServer({ appDir: '/home/claude/worship-rig/app', port: 30000 + Math.floor(Math.random() * 9000), userSamples: false });
const { url } = await server.listen();
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const files = { 'fonts/Figtree.ttf': ['Figtree.ttf', 'font/ttf'], 'fonts/Fraunces.ttf': ['Fraunces.ttf', 'font/ttf'], 'grain.png': ['grain.png', 'image/png'] };
async function run(width, height, themed, tag) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  await page.route('**/themes/warm-preview/**', (r) => {
    const rel = new URL(r.request().url()).pathname.replace('/themes/warm-preview/', '');
    const f = files[rel]; if (!f) return r.fulfill({ status: 404 });
    r.fulfill({ status: 200, contentType: f[1], body: fs.readFileSync(path.join(here, f[0])) });
  });
  await page.goto(url);
  await page.waitForFunction(() => !!window.__rig, null, { timeout: 20000 });
  if (await page.isVisible('#overlay-start')) await page.click('#overlay-start');
  await page.waitForTimeout(6000);
  if (themed) { await page.addStyleTag({ content: fs.readFileSync(path.join(here, 'theme.css'), 'utf8') }); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(500); }
  await page.screenshot({ path: path.join(here, `${tag}-perform-${width}.png`) });
  const edit = page.locator('.tb-views .seg', { hasText: 'Edit' });
  if (await edit.count()) { await edit.first().click(); await page.waitForTimeout(1200); await page.screenshot({ path: path.join(here, `${tag}-edit-${width}.png`) }); }
  await ctx.close();
}
for (const [w, h] of [[1440, 900], [1024, 700]]) { await run(w, h, false, 'base'); await run(w, h, true, 'warm'); }
await browser.close(); await server.close();
console.log('done');
