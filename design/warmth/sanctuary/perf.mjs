// Relative paint/raster cost with a chord held (meters running), alternating variants in one browser so a busy shared
// container slows them equally:
//   base     today's theme
//   vault0   Sanctuary with the vault painted on body's own background (the first version)
//   sanct    Sanctuary as shipped: the vault on a fixed body::after with its own compositor layer
// Headless Chromium, software raster, 2 CPUs: compare the variants, don't read the numbers as Mac milliseconds.
import { createRequire } from 'node:module';
const ROOT = '/home/claude/worship-rig';
const require = createRequire(`${ROOT}/package.json`);
const { chromium } = require('playwright');
const { createServer } = require(`${ROOT}/server.js`);
const server = createServer({ appDir: `${ROOT}/app`, port: 30000 + Math.floor(Math.random() * 9000), userSamples: false });
const { url } = await server.listen();
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const VAULT_ON_BODY = `body { background: url('/themes/sanctuary/grain.png') repeat,
  radial-gradient(90% 60% at 50% -18%, #1f2458 0%, #14163c 38%, transparent 72%),
  radial-gradient(55% 28% at 50% 112%, #e6ba651c 0%, transparent 70%), #0a0c1e !important; }
  body::after { display: none !important; }`;

async function run(mode) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(url);
  await page.waitForFunction(() => !!window.__rig && window.__rig.viewsReady, null, { timeout: 30000 });
  if (await page.isVisible('#overlay-start')) await page.click('#overlay-start');
  if (mode !== 'base') {
    await page.addStyleTag({ path: `${ROOT}/app/themes/sanctuary/theme.css` });
    if (mode === 'vault0') await page.addStyleTag({ content: VAULT_ON_BODY });
    if (mode === 'still') await page.addStyleTag({ content: '.p-drone::before { animation: none !important; }' });
    if (mode === 'noglass') await page.addStyleTag({ content: '.p-drone::before { display: none !important; }' });
    if (mode === 'novault') await page.addStyleTag({ content: 'body::after { display: none !important; }' });
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
const MODES = (process.argv[2] || 'base,vault0,sanct').split(',');
for (let i = 0; i < 3; i++) for (const m of MODES) { const r = await run(m); rows.push(r); console.log(JSON.stringify(r)); }
for (const m of MODES) {
  const rs = rows.filter((r) => r.mode === m).map((r) => r.paintMs + r.rasterMs).sort((a, b) => a - b);
  console.log(`${m}: paint+raster per 5 s, median ${rs[1]} ms (runs ${rs.join(', ')})`);
}
await browser.close();
await server.close();
