// Relative paint/raster cost with a chord held (meters running), alternating variants in one browser so a busy shared
// container slows them equally:
//   base     today's theme
//   v1       Sanctuary v1 (app/themes/sanctuary)
//   v2       Sanctuary v2 (app/themes/sanctuary-v2): panel wash gradients, lit-glass tiles, the small window breathing
//   still    v2 with the window's breathing stopped
// Headless Chromium, software raster, 2 CPUs: compare the variants, don't read the numbers as Mac milliseconds.
// Usage: node design/warmth/sanctuary-v2/perf.mjs [base,v1,v2,still]
import { createRequire } from 'node:module';
const ROOT = '/home/claude/worship-rig';
const require = createRequire(`${ROOT}/package.json`);
const { chromium } = require('playwright');
const { createServer } = require(`${ROOT}/server.js`);
const server = createServer({ appDir: `${ROOT}/app`, port: 30000 + Math.floor(Math.random() * 9000), userSamples: false });
const { url } = await server.listen();
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
async function run(mode) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(url);
  await page.waitForFunction(() => !!window.__rig && window.__rig.viewsReady, null, { timeout: 30000 });
  if (await page.isVisible('#overlay-start')) await page.click('#overlay-start');
  if (mode !== 'base') {
    await page.addStyleTag({ path: `${ROOT}/app/themes/${mode === 'v1' ? 'sanctuary' : 'sanctuary-v2'}/theme.css` });
    if (mode === 'still') await page.addStyleTag({ content: '.p-drone::before { animation: none !important; }' });
    await page.evaluate(() => document.fonts.ready);
  }
  await page.evaluate(() => { for (const n of [48, 60, 64, 67, 72]) window.__rig.controller.perform.noteOn(n, 92); });
  await page.waitForTimeout(2000);
  const cdp = await page.context().newCDPSession(page);
  const events = [];
  cdp.on('Tracing.dataCollected', (e) => events.push(...e.value));
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline',
    transferMode: 'ReportEvents' });
  await page.waitForTimeout(5000);
  await cdp.send('Tracing.end');
  await done;
  const sum = (n) => Math.round(events.filter((e) => e.name === n && e.dur).reduce((a, e) => a + e.dur, 0) / 1000);
  const r = { mode, paints: events.filter((e) => e.name === 'Paint').length, paintMs: sum('Paint'), rasterMs: sum('RasterTask') };
  await page.context().close();
  return r;
}
const rows = [];
const MODES = (process.argv[2] || 'base,v1,v2,still').split(',');
for (let i = 0; i < 3; i++) for (const m of MODES) { const r = await run(m); rows.push(r); console.log(JSON.stringify(r)); }
for (const m of MODES) {
  const rs = rows.filter((r) => r.mode === m).map((r) => r.paintMs + r.rasterMs).sort((a, b) => a - b);
  console.log(`${m}: paint+raster per 5 s, median ${rs[1]} ms (runs ${rs.join(', ')})`);
}
await browser.close();
await server.close();
