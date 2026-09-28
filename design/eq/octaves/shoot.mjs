// Screenshots + storyboard for the "octaves" EQ prototype. Serves the repo itself on a free port.
//   node design/eq/octaves/shoot.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.mp3': 'audio/mpeg', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.normalize(path.join(ROOT, decodeURIComponent(req.url.split('?')[0])));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/design/eq/octaves/index.html`;

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
async function open(w, h) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#inst option'));
  return page;
}
const caption = (page, n, text) => page.evaluate(([n, text]) => {
  let d = document.getElementById('__cap');
  if (!d) { d = document.createElement('div'); d.id = '__cap'; document.body.append(d);
    d.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9;background:#ffc94d;color:#1a1400;font:700 15px/1.3 system-ui,sans-serif;' +
      'padding:10px 14px;border-radius:10px;box-shadow:0 6px 24px #0008;max-width:520px'; }
  d.innerHTML = `<span style="opacity:.6">${n}/3 ·</span> ${text}`;
}, [n, text]);
const canvasPt = async (page, u, db) => page.evaluate(([u, db]) => {
  const P = window.EQPROTO, r = document.getElementById('eq').getBoundingClientRect();
  return { x: r.left + P.X(u), y: r.top + P.Y(db) };
}, [u, db]);
// start audio + loop, let samples decode and the analyser fill
async function warm(page, ms = 2500) {
  await page.evaluate(() => { window.EQPROTO.ensureAudio(); window.EQPROTO.toggleLoop(true); });
  await page.waitForTimeout(ms);
}

// 1440 × 900 hero
{
  const page = await open(1440, 900);
  await warm(page, 3000);
  // hover a key for the tooltip
  const k = await page.evaluate(() => { const r = document.getElementById('eq').getBoundingClientRect(), P = window.EQPROTO;
    return { x: r.left + P.X(P.uC(64)), y: r.top + P.L.kbY + P.L.kbH - 12 }; });
  await page.mouse.move(k.x, k.y);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(HERE, 'eq.png') });
  // smooth + bass slot variant (extra evidence of greying)
  await page.evaluate(() => { window.EQPROTO.selectSlot(3); document.getElementById('smooth').click(); });
  await page.mouse.move(5, 5);
  await page.waitForTimeout(2200);
  await page.screenshot({ path: path.join(HERE, 'eq-bass-smooth.png') });
  await page.close();
}
// 1024 × 700
{
  const page = await open(1024, 700);
  await warm(page, 2500);
  await page.screenshot({ path: path.join(HERE, 'eq-1024.png') });
  await page.close();
}
// storyboard: drag the A4–A5 bar (440–880 Hz) from 0 to +10 dB on a flat Keys slot, with the loop running
{
  const page = await open(1440, 900);
  await page.selectOption('#preset', 'Flat');
  await warm(page, 3000);
  const uMid = await page.evaluate(() => { const g = window.EQPROTO.groups(window.EQPROTO.cur(), window.EQPROTO.eqCur())[4]; return (g.u0 + g.u1) / 2; });
  const a = await canvasPt(page, uMid, 0);
  await page.mouse.move(a.x, a.y);
  await page.waitForTimeout(300);
  await caption(page, 1, 'Keys looping C3–C8, EQ flat: the filled spectrum (after EQ) sits on the dotted one (before).');
  await page.screenshot({ path: path.join(HERE, 'story-1.png') });
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { const p = await canvasPt(page, uMid, i * 0.55); await page.mouse.move(p.x, p.y); await page.waitForTimeout(30); }
  await page.waitForTimeout(700);
  await caption(page, 2, 'Dragging the A4–A5 bar: the chip reads Peak 622 Hz · Q 0.70 · dB live, the white curve is the real filter.');
  await page.screenshot({ path: path.join(HERE, 'story-2.png') });
  for (let i = 1; i <= 8; i++) { const p = await canvasPt(page, uMid, 5.5 + i * 0.57); await page.mouse.move(p.x, p.y); await page.waitForTimeout(30); }
  await page.mouse.up();
  await page.mouse.move(5, 890);
  await page.waitForTimeout(1600);
  await caption(page, 3, 'Released at +10 dB: C5, E5 and G5 (440–880 Hz) now rise above the dotted “before” line.');
  await page.screenshot({ path: path.join(HERE, 'story-3.png') });
  const probe = await page.evaluate(() => ({ g: window.EQPROTO.eqCur().g.slice(), f: window.EQPROTO.A.filters.map((f) => [f.frequency.value, f.Q.value, f.gain.value]) }));
  console.log('after drag', JSON.stringify(probe));
  await page.close();
}
// extra: Pad slot (synth), Alt-click widen A3–A4 into A3–A5, then fit a pasted EQ
{
  const page = await open(1440, 900);
  await page.evaluate(() => window.EQPROTO.selectSlot(1));
  await warm(page, 2000);
  const uMid = await page.evaluate(() => { const g = window.EQPROTO.groups(window.EQPROTO.cur(), window.EQPROTO.eqCur()).find((g) => g.k === 5); return (g.u0 + g.u1) / 2; });
  const p = await canvasPt(page, uMid, -2);
  await page.keyboard.down('Alt'); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up(); await page.keyboard.up('Alt');
  await page.fill('#imp', 'Preamp: -4 dB\nFilter 1: ON PK Fc 250 Hz Gain -3.0 dB Q 1.41\nFilter 2: ON HSC Fc 8000 Hz Gain 4 dB\nFilter 3: ON PK Fc 3100 Hz Gain -5 dB Q 6');
  await page.click('#fit');
  await page.mouse.move(5, 890);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(HERE, 'eq-pad-fit.png') });
  console.log('pad', JSON.stringify(await page.evaluate(() => ({ eq: window.EQPROTO.eqCur(), msg: document.getElementById('fitmsg').textContent }))));
  await page.evaluate(() => window.EQPROTO.selectSlot(2));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(HERE, 'eq-extra.png') });
  await page.close();
}
await browser.close();
server.close();
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors / 4xx');
