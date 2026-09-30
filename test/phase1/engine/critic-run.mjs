// lowres2 critic runner: `node test/phase1/engine/critic-run.mjs [name…]` — runs critic-lowres2.mjs cases one page
// each (serially), with renderer RSS (/proc) and a forced GC exposed to the page for the memory case.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { startServer } from './server.mjs';
import { generateFixtures } from './gen-fixtures.mjs';

const only = process.argv.slice(2);
generateFixtures();
const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info'] });
// RSS of this browser's renderer processes only (other agents' browsers share the box)
const bcdp = await browser.newBrowserCDPSession();
const rendererRssMB = async () => {
  const { processInfo } = await bcdp.send('SystemInfo.getProcessInfo');
  let kb = 0;
  for (const p of processInfo.filter((x) => x.type === 'renderer')) {
    try {
      const st = fs.readFileSync(`/proc/${p.id}/status`, 'utf8');
      kb += Number((st.match(/VmRSS:\s+(\d+)/) || [])[1] || 0);
    } catch {}
  }
  return +(kb / 1024).toFixed(1);
};
let failed = 0;
try {
  const probe = await browser.newPage();
  await probe.goto(`${base}/__tests/harness.html`);
  const names = await probe.evaluate(async () => Object.keys((await import('/__tests/critic-lowres2.mjs')).critic));
  await probe.close();
  for (const name of names) {
    if (only.length && !only.includes(name)) continue;
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
      if (process.env.VERBOSE) console.log(`  [${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`pageerror ${e.message}`));
    const cdp = await page.context().newCDPSession(page);
    await page.exposeFunction('__rss', () => rendererRssMB());
    await page.exposeFunction('__gc', async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      return true;
    });
    await page.goto(`${base}/__tests/harness.html`);
    await page.waitForFunction(() => window.__ready === true);
    const t0 = Date.now();
    const r = await Promise.race([
      page.evaluate(async (n) => {
        try {
          return await (await import('/__tests/critic-lowres2.mjs')).critic[n]();
        } catch (e) {
          return { pass: false, error: String((e && e.stack) || e) };
        }
      }, name),
      new Promise((res) => setTimeout(() => res({ pass: false, error: 'timeout 600 s' }), 600000)),
    ]);
    r.consoleErrors = errors;
    if (!r.pass || errors.length) failed++;
    console.log(`${r.pass && !errors.length ? 'PASS' : 'FAIL'}  ${name}  (${Date.now() - t0} ms)  ${JSON.stringify(r)}`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
