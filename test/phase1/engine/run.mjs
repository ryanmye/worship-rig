// Engine test runner: `node test/phase1/engine/run.mjs [filter]` — exits 0 when every suite passes.
// Serves app/ + fixtures with its own tiny server, runs offline suites (seeded OfflineAudioContext) and
// real-time suites in headless Chromium, and asserts zero console.error on every page.
import { chromium } from 'playwright';
import { startServer } from './server.mjs';
import { generateFixtures } from './gen-fixtures.mjs';

const filter = process.argv[2] || '';
generateFixtures();
const server = await startServer(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const results = [];
let consoleErrors = [];

async function openPage(url) {
  const page = await browser.newPage();
  page.on('console', (m) => {
    // The browser itself logs a console error for every 404; the one deliberate 404 (missing-sample test) is expected.
    const expected404 = /Failed to load resource/.test(m.text()) && /\/__fixtures\/test-keys\/soft\/D4\.wav/.test(m.location()?.url || '');
    if (m.type() === 'error' && !expected404) consoleErrors.push(`${url}: ${m.text()} ${m.location()?.url || ''}`);
    if (process.env.VERBOSE) console.log(`  [${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`${url}: pageerror ${e.message}`));
  await page.goto(`${base}${url}`);
  return page;
}

async function runGroup(group, timeout) {
  const page = await openPage('/__tests/harness.html');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  const names = await page.evaluate((g) => Object.keys(window.__suites[g]), group);
  for (const name of names) {
    if (filter && !`${group}.${name}`.includes(filter)) continue;
    const r = await Promise.race([
      page.evaluate(([g, n]) => window.__run(g, n), [group, name]),
      new Promise((res) => setTimeout(() => res({ pass: false, error: `timeout ${timeout} ms` }), timeout)),
    ]);
    results.push({ name: `${group}.${name}`, ...r });
    const tag = r.pass ? (r.skipped ? 'SKIP' : 'PASS') : r.soft ? 'WARN' : 'FAIL';
    const { pass, ms, ...rest } = r;
    console.log(`${tag}  ${group}.${name}  (${ms ?? '?'} ms)  ${JSON.stringify(rest)}`);
  }
  await page.close();
}

try {
  await runGroup('offline', 120000);
  await runGroup('realtime', 90000);
  // the manual harness page must load cleanly too
  if (!filter || 'test.html'.includes(filter)) {
    const p = await openPage('/js/engine/test.html');
    await p.waitForFunction(() => window.__harnessReady === true, null, { timeout: 20000 }).catch(() => consoleErrors.push('test.html: never became ready'));
    // drive it like a player: start, every preset (real app/samples + synth/organ), a chord each, drone on
    const r = await p.evaluate(async () => {
      document.getElementById('start').click();
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      for (let i = 0; i < 200 && !(window.engine.fx && document.getElementById('state').textContent.startsWith('running')); i++) await wait(100);
      const out = [];
      for (const b of document.getElementById('presets').children) {
        b.click();
        for (let i = 0; i < 300 && !b.classList.contains('on'); i++) await wait(100);
        for (const n of [60, 64, 67]) window.engine.noteOn(n, 100);
        await wait(400);
        const buf = new Float32Array(2048);
        window.engine.analyserL.getFloatTimeDomainData(buf);
        let s = 0;
        for (const v of buf) s += v * v;
        for (const n of [60, 64, 67]) window.engine.noteOff(n);
        out.push({ preset: b.textContent, on: b.classList.contains('on'), rmsDb: +(10 * Math.log10(s / buf.length + 1e-20)).toFixed(1) });
      }
      document.getElementById('dmode').value = 'synth';
      document.getElementById('dmode').dispatchEvent(new Event('change'));
      await wait(1500);
      return { presets: out, stats: window.engine._debugStats() };
    });
    const ok = r.presets.every((x) => x.on && x.rmsDb > -60);
    results.push({ name: 'harness.test.html', pass: ok, ...r });
    console.log(`${ok ? 'PASS' : 'FAIL'}  harness.test.html  ${JSON.stringify(r)}`);
    await p.close();
  }
} finally {
  await browser.close();
  server.close();
}

const hard = results.filter((r) => !r.pass && !r.soft);
const soft = results.filter((r) => !r.pass && r.soft);
console.log(`\n${results.length - hard.length - soft.length}/${results.length} passed, ${soft.length} soft warnings, ${hard.length} failures, ${consoleErrors.length} console errors`);
for (const e of consoleErrors) console.log(`console.error: ${e}`);
process.exit(hard.length || consoleErrors.length ? 1 : 0);
