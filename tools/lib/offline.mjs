// Node side of the offline renderer: headless Chromium (Playwright) + tools/lib/server.mjs + render-page.html.
//   const r = await openRenderer();  const out = await r.render(job);  await r.close();
// out.chs = [Float32Array L, Float32Array R]. Console errors/warnings from the page are collected per render.
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

function unb64(s) {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

export async function openRenderer({ verbose = !!process.env.VERBOSE } = {}) {
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  let log = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') log.push(`[${m.type()}] ${m.text()}`);
    if (verbose) console.log(`  [page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => log.push(`[pageerror] ${e.message}`));
  await page.goto(`${base}/__lib/render-page.html`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  return {
    async listInstruments() {
      return page.evaluate(() => window.__list());
    },
    async render(job) {
      log = [];
      const r = await page.evaluate((j) => window.__render(j), job);
      return { ...r, chs: [unb64(r.L), unb64(r.R)], L: undefined, R: undefined, console: log.slice() };
    },
    async close() {
      await browser.close();
      server.close();
    },
  };
}
