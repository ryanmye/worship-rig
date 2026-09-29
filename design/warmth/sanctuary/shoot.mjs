// Sanctuary theme: screenshots of the REAL app with app/themes/sanctuary/theme.css injected, plus a contrast audit.
// Usage: node design/warmth/sanctuary/shoot.mjs [--only perform,edit,quick,idle,p1024,audit] [--base]
// Nothing under app/ is modified; the theme is injected with page.addStyleTag and its fonts/assets are served by
// server.js from app/themes/sanctuary/ (same origin, so the CSP font-src 'self' holds).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/claude/worship-rig';
const require = createRequire(`${ROOT}/package.json`);
const { chromium } = require('playwright');
const { createServer } = require(`${ROOT}/server.js`);
const here = path.dirname(new URL(import.meta.url).pathname);
const THEME = `${ROOT}/app/themes/sanctuary/theme.css`;
const args = process.argv.slice(2);
const onlyArg = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const want = (k) => !onlyArg || onlyArg.includes(k);
const BASE = args.includes('--base'); // unthemed, for comparison
const tag = BASE ? 'base-' : '';

const server = createServer({ appDir: `${ROOT}/app`, port: 30000 + Math.floor(Math.random() * 9000), userSamples: false });
const { url } = await server.listen();
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];

async function boot(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${width}: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${width}: HTTP ${r.status()} ${r.url()}`); });
  await page.goto(url);
  await page.waitForFunction(() => !!window.__rig && window.__rig.viewsReady, null, { timeout: 30000 });
  if (await page.isVisible('#overlay-start')) await page.click('#overlay-start');
  const id = await page.evaluate(() => {
    const st = window.__rig.store.get();
    return st.songOrder.find((k) => st.songs[k].factoryId === 'factory:sunday-pad-piano');
  });
  await page.evaluate((i) => window.__rig.controller.selectSong(i), id);
  await page.waitForFunction((i) => window.__rig.controller.status.songId === i && !window.__rig.controller.status.loading,
    id, { timeout: 60000 });
  // let the set finish preparing so the top bar says Ready, not Loading n/19
  await page.waitForFunction(() => window.__rig.controller.status.ready, null, { timeout: 180000 }).catch(() => {});
  if (!BASE) {
    await page.addStyleTag({ path: THEME });
    await page.evaluate(() => document.fonts.ready);
  }
  // C major, held (the chord readout, the strip meters and the keyboard show something sounding)
  await page.evaluate(() => { for (const n of [48, 60, 64, 67, 72]) window.__rig.controller.perform.noteOn(n, 92); });
  await page.waitForTimeout(900);
  await clearToasts(page);
  return { ctx, page };
}
async function clearToasts(page) {
  // screenshot hygiene: the headless browser has no MIDI permission, and its two explanatory toasts cover the drone card
  await page.evaluate(() => { const t = document.getElementById('toasts'); if (t) t.replaceChildren(); });
}
const shot = (page, name) => page.screenshot({ path: path.join(here, `${tag}${name}.png`) });

// ---------------------------------------------------------------------------------------------- contrast audit
async function audit(page, label, rootSel = 'body') {
  return page.evaluate(([label, rootSel]) => {
    const parse = (s) => {
      if (!s) return null;
      let m = s.match(/^rgba?\(([^)]+)\)$/);
      if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0] / 255, p[1] / 255, p[2] / 255, p[3] ?? 1]; }
      m = s.match(/^color\(srgb ([^)]+)\)$/);
      if (m) { const p = m[1].split(/[ /]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
      return null;
    };
    const over = (top, bot) => { const a = top[3]; return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1]; };
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const L = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    const cr = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const gradStops = (img) => (img.match(/rgba?\([^)]+\)|color\(srgb [^)]+\)/g) || []).map(parse).filter(Boolean);
    const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    // the background stack under an element: every ancestor's colour + gradient stops, alpha-composited upward
    function backgrounds(el) {
      const chain = [];
      for (let e = el; e; e = e.parentElement) chain.push(e);
      let bases = [[0, 0, 0, 1]];
      for (let i = chain.length - 1; i >= 0; i--) {
        const cs = getComputedStyle(chain[i]);
        const bg = parse(cs.backgroundColor);
        if (bg && bg[3] > 0) bases = bases.map((b) => over(bg, b));
        const stops = cs.backgroundImage && cs.backgroundImage !== 'none' ? gradStops(cs.backgroundImage) : [];
        if (stops.length && !['BODY', 'HTML'].includes(chain[i].tagName)) {
          const opaque = stops.some((s) => s[3] > 0.02);
          if (opaque) bases = bases.flatMap((b) => stops.map((s) => over(s, b)));
        }
        if (['BODY', 'HTML'].includes(chain[i].tagName) && stops.length) {
          // body: the vault gradient's brightest and darkest points
          bases = bases.flatMap((b) => [b, ...stops.filter((s) => s[3] > 0.5).map((s) => over(s, b))]);
        }
      }
      return bases;
    }
    const out = [];
    const seen = new Set();
    const walker = document.createTreeWalker(document.querySelector(rootSel), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const txt = n.textContent.trim();
      if (!txt) continue;
      const el = n.parentElement;
      if (!el || seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || parseFloat(cs.fontSize) === 0) continue;
      let hidden = false; let op = 1; let disabled = false;
      for (let e = el; e; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.display === 'none') hidden = true;
        op *= parseFloat(s.opacity);
        if (e.disabled || e.getAttribute?.('aria-disabled') === 'true') disabled = true;
        if (e.classList?.contains('sr-only') || s.clip === 'rect(0px, 0px, 0px, 0px)') hidden = true;
      }
      if (hidden || op < 0.05) continue; // opacity 0 = intentionally invisible (e.g. the idle 'Loading…' flag)
      const fg = parse(cs.color);
      if (!fg) continue;
      const bgs = backgrounds(el);
      let worst = Infinity; let worstBg = null;
      for (const b of bgs) {
        const f = over([fg[0], fg[1], fg[2], fg[3] * op], b); // opacity of the element dims its text toward the bg
        const c = cr(f, b);
        if (c < worst) { worst = c; worstBg = b; }
      }
      const size = parseFloat(cs.fontSize); const weight = parseInt(cs.fontWeight, 10);
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = large ? 3 : 4.5;
      out.push({ view: label, text: txt.slice(0, 40), cls: (el.className?.baseVal ?? el.className ?? '').toString().slice(0, 50),
        fg: hex(fg), bg: hex(worstBg), ratio: Math.round(worst * 100) / 100, size, weight, large, need, disabled,
        pass: worst >= need, font: cs.fontFamily.split(',')[0] });
    }
    return out;
  }, [label, rootSel]);
}

// ---------------------------------------------------------------------------------------------- idle mock
async function mountIdle(page) {
  await page.evaluate(() => {
    const st = window.__rig.store.get();
    const sl = st.setlists?.[st.currentSetlistId] || Object.values(st.setlists || {})[0];
    const ids = (sl?.songIds || st.songOrder).slice(0, 6);
    const total = (sl?.songIds || st.songOrder).length;
    const songs = ids.map((k) => st.songs[k]).filter(Boolean);
    const keyOf = (s) => (s.key?.root ?? s.key ?? 'C').toString().replace(/[^A-G#b]/g, '') || 'C';
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const first = songs[0];
    const div = document.createElement('div');
    div.className = 'sanct-before';
    div.innerHTML = `
      <div class="sb-wrap">
        <div class="sb-window" aria-hidden="true">
          <i class="sb-halo sanct-breath"></i><i class="sb-glass"></i><i class="sb-light sanct-breath"></i><i class="sb-lead"></i>
          <div class="sb-pad">The pad is ready in <b>${esc(keyOf(first))}</b></div>
        </div>
        <div class="sb-main">
          <div class="sb-day">Sunday morning · 28 September</div>
          <h1 class="sb-title">Before the service</h1>
          <p class="sb-sub"><b>${total} songs</b> in today's set, starting with <b>${esc(first.name)}</b> in ${esc(keyOf(first))}.
            Tap anywhere and the room fills with the pad while people come in.</p>
          <ol class="sb-set">
            ${songs.map((s, i) => `<li class="${i === 0 ? 'first' : ''}"><span>${esc(s.name)}</span><em>${esc(keyOf(s))}</em></li>`).join('')}
            ${total > songs.length ? `<li class="more"><span>and ${total - songs.length} more</span><em></em></li>` : ''}
          </ol>
          <div class="sb-foot">
            <button class="sb-go" type="button">Start the sound</button>
            <div class="sb-last">Last Sunday you ended on <b>Prayer Wash</b><br>Nord Stage 3 · sound OK at 42 ms</div>
          </div>
          <div class="sb-small">Your browser asks for one tap before it can play.</div>
        </div>
      </div>`;
    document.body.append(div);
  });
  // decode the window's SVG layers before the shot (first paint of a CSS background image is async)
  await page.evaluate(() => Promise.all(['glass', 'light', 'lead'].map((n) => {
    const i = new Image(); i.src = `/themes/sanctuary/lancet-${n}.svg`; return i.decode().catch(() => {});
  })));
  // hold the breath at its fullest for the still (the animation is opacity-only; a still can't show it)
  await page.evaluate(() => document.querySelectorAll('.sanct-breath').forEach((e) => { e.style.animationDelay = '-3.2s'; e.style.animationPlayState = 'paused'; }));
  await page.waitForTimeout(900);
}

// ---------------------------------------------------------------------------------------------- run
const report = [];
if (want('perform') || want('edit') || want('quick') || want('idle') || want('audit')) {
  const { ctx, page } = await boot(1440, 900);
  if (want('perform') || want('audit')) {
    await clearToasts(page);
    if (want('perform')) await shot(page, 'perform');
    if (want('audit')) report.push(...await audit(page, 'perform-1440'));
  }
  if (want('quick')) {
    await page.click('#btn-quick');
    await page.waitForTimeout(500);
    await clearToasts(page);
    await shot(page, 'quick');
    if (want('audit')) report.push(...(await audit(page, 'quick-1440')).filter((r) => /^qs|step|seg|btn|toggle|fader|hold|stepper/.test(r.cls) || true));
    await page.click('#btn-quick');
    await page.waitForTimeout(300);
  }
  if (want('idle')) {
    await mountIdle(page);
    await shot(page, 'idle');
    if (want('audit')) report.push(...await audit(page, 'idle-1440', '.sanct-before'));
    await page.evaluate(() => document.querySelector('.sanct-before')?.remove());
  }
  if (want('edit') || want('audit')) {
    await page.click('#view-switch button[data-value="edit"]');
    await page.waitForFunction(() => !document.getElementById('view-edit').hidden && !!document.querySelector('#view-edit .ev2'));
    await page.waitForTimeout(900);
    await clearToasts(page);
    if (want('edit')) await shot(page, 'edit');
    if (want('audit')) report.push(...await audit(page, 'edit-1440'));
    // the drone tab too (the stained-glass window in Edit)
    if (want('edit')) {
      const drone = page.locator('.ev2-tab', { hasText: 'Drone' }).first();
      if (await drone.count()) { await drone.click(); await page.waitForTimeout(500); await clearToasts(page); await shot(page, 'edit-drone');
        if (want('audit')) report.push(...await audit(page, 'edit-drone-1440')); }
    }
  }
  await ctx.close();
}
if (want('p1024') || want('audit')) {
  const { ctx, page } = await boot(1024, 700);
  await clearToasts(page);
  if (want('p1024')) await shot(page, 'perform-1024');
  if (want('audit')) report.push(...await audit(page, 'perform-1024'));
  await page.click('#view-switch button[data-value="edit"]');
  await page.waitForTimeout(1200);
  await clearToasts(page);
  if (want('p1024')) await shot(page, 'edit-1024');
  if (want('audit')) report.push(...await audit(page, 'edit-1024'));
  await ctx.close();
}
if (report.length) {
  fs.writeFileSync(path.join(here, `${tag}contrast-audit.json`), JSON.stringify(report, null, 1));
  const fails = report.filter((r) => !r.pass && !r.disabled);
  const dis = report.filter((r) => !r.pass && r.disabled);
  console.log(`audit: ${report.length} text elements, ${fails.length} failing (enabled), ${dis.length} failing but disabled (exempt)`);
  for (const f of fails) console.log(`  FAIL ${f.view} "${f.text}" .${f.cls} ${f.fg} on ${f.bg} = ${f.ratio} (need ${f.need}, ${f.size}px/${f.weight})`);
  for (const v of [...new Set(report.map((r) => r.view))]) {
    const rs = report.filter((r) => r.view === v && !r.disabled);
    const min = rs.reduce((a, r) => (r.ratio < a.ratio ? r : a), { ratio: 99 });
    const lo = rs.filter((r) => r.ratio < 5.5).sort((a, b) => a.ratio - b.ratio).slice(0, 6)
      .map((r) => `"${r.text}" ${r.fg}/${r.bg} ${r.ratio}`).join(' · ');
    console.log(`  ${v}: ${rs.length} enabled, min ${min.ratio} ("${min.text}" .${min.cls}) | < 5.5: ${lo}`);
  }
  for (const d of dis) console.log(`  exempt (disabled) ${d.view} "${d.text}" ${d.fg} on ${d.bg} = ${d.ratio}`);
}
if (errors.length) console.log('console/HTTP errors:\n  ' + errors.join('\n  '));
await browser.close();
await server.close();
console.log('done');
