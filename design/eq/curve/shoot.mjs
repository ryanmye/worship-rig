// Screenshots + storyboard for the "curve" EQ prototype.
// Needs the repo served: python3 -m http.server 8460 --directory /home/claude/worship-rig
// Run:   node design/eq/curve/shoot.mjs [baseUrl]
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || 'http://127.0.0.1:8460';
const URL = `${BASE}/design/eq/curve/index.html`;
const out = (f) => path.join(HERE, f);

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
async function open(w, h) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(URL);
  await page.waitForFunction(() => window.__eq && document.querySelector('#bands tbody tr'));
  return page;
}
async function startSound(page, fixed = null) {
  await page.evaluate(async (f) => { window.__eq.ensureAudio(); await window.__eq.preload(); window.__eq.playLoop(f); }, fixed);
  await page.waitForTimeout(1400);
}
async function center(page, sel) {
  const b = await page.locator(sel).boundingBox();
  return b;
}

// 1440×900 hero
{
  const page = await open(1440, 900);
  await startSound(page);
  const gb = await center(page, '#graph');
  const p = await page.evaluate(() => window.__eq.handlePos(2));
  await page.mouse.move(gb.x + p.x, gb.y + p.y); // hover handle 3 → readout
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__eq.atPhase(700));
  await page.screenshot({ path: out('eq.png') });
  await page.close();
}
// 1024×700
{
  const page = await open(1024, 700);
  await page.evaluate(() => window.__eq.selectSlot(3));
  await startSound(page);
  await page.evaluate(() => window.__eq.select(1));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__eq.atPhase(700));
  await page.screenshot({ path: out('eq-1024.png') });
  await page.close();
}
// storyboard: drag band 3 on Keys from 2.5 kHz up into the overtone zone, analyser live
{
  const page = await open(1440, 900);
  await page.evaluate(() => { const b = window.__eq.bands()[2]; b.f = 1760; b.g = 0; b.q = 1.4; });
  await startSound(page, 0);
  const gb = await center(page, '#graph');
  const p0 = await page.evaluate(() => window.__eq.handlePos(2));
  await page.mouse.move(gb.x + p0.x, gb.y + p0.y);
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.evaluate(() => window.__eq.atPhase(700));
  await page.screenshot({ path: out('story-1.png') });
  // up: +9 dB around A5/C6 (still on played notes)
  const t1 = await page.evaluate(() => ({ x: window.__eq.xOfF(880), y: window.__eq.yOfDb(9) }));
  for (let k = 1; k <= 12; k++) {
    await page.mouse.move(gb.x + p0.x + (t1.x - p0.x) * k / 12, gb.y + p0.y + (t1.y - p0.y) * k / 12);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(2600);
  await page.evaluate(() => window.__eq.atPhase(700));
  await page.screenshot({ path: out('story-2.png') });
  // right: past C8 into the air → "overtones only"
  const t2 = await page.evaluate(() => ({ x: window.__eq.xOfF(9000), y: window.__eq.yOfDb(9) }));
  for (let k = 1; k <= 12; k++) {
    await page.mouse.move(gb.x + t1.x + (t2.x - t1.x) * k / 12, gb.y + t1.y);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(2600);
  await page.evaluate(() => window.__eq.atPhase(700));
  await page.screenshot({ path: out('story-3.png') });
  await page.mouse.up();
  await page.close();
}
// numeric check: our RBJ curve vs Chromium's BiquadFilterNode.getFrequencyResponse
{
  const page = await open(1440, 900);
  const worst = await page.evaluate(() => {
    const ctx = new OfflineAudioContext(1, 128, 48000);
    let worst = 0;
    for (const [type, f, g, q] of [['peaking', 440, 9, 1.4], ['lowshelf', 120, -6, 0.7], ['highshelf', 6000, 4.5, 0.7], ['peaking', 60, -5, 3]]) {
      const n = new BiquadFilterNode(ctx, { type, frequency: f, gain: g, Q: q });
      const fr = new Float32Array(200).map((_, i) => 20 * Math.pow(1000, i / 199));
      const mag = new Float32Array(200), ph = new Float32Array(200);
      n.getFrequencyResponse(fr, mag, ph);
      const c = window.__eq.coeffs({ type, f, g, q });
      fr.forEach((x, i) => { worst = Math.max(worst, Math.abs(20 * Math.log10(mag[i]) - window.__eq.magDb(c, x))); });
    }
    return worst;
  });
  console.log('max |RBJ − Chromium| dB:', worst.toFixed(4));
  await page.close();
}
await browser.close();
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors / 4xx');
