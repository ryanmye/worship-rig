#!/usr/bin/env node
// Chart view suite (D7, hidden; app/js/views/chart/). The real app (app/index.html) in Chromium:
//   flag off → no chart DOM, no chart module or stylesheet fetched; flag on → import a chart through the "Add chart…"
//   dialog (a file written for this test, never real lyrics), offers unticked except what we tick, the chart renders,
//   Perform's Transpose re-keys the chords, big type, auto-scroll, a committed song switch swaps the chart, the flag
//   off again removes everything; zero console.error and no HTTP ≥ 400.
//   node test/phase2/chart/run.mjs      (screenshot → test/phase2/chart/screenshots/chart.png)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { MIDI_PERMISSIONS, waitRigReady, pinTheme } from '../../integration/lib.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const APP = path.join(ROOT, 'app');
const SHOTS = path.join(HERE, 'screenshots');
const { createServer } = require(path.join(ROOT, 'server.js'));
const VERBOSE = !!process.env.VERBOSE;
fs.mkdirSync(SHOTS, { recursive: true });

// written for this test; long enough to scroll
const verse = (n) => [`{c: Verse ${n}}`, '[G]Paper boats on a [C]rainy [D]street', '[Em]Folded [C/E]small and [D]neat',
  '[G]Drifting past the [C]corner [D]light', '[Em]Out of [C]view by [D]night'].join('\n');
const CHART = ['{title: Paper Boats}', '{key: G}', '{tempo: 76}', verse(1),
  '{soc}', '[C]Sail a[G]way, [D/F#]sail a[Em]way', '[C]Down the [G]drain and [D]gone', '{eoc}',
  verse(2), '{chorus}', verse(3), '{chorus}', verse(4)].join('\n');

const results = [];
const T = async (name, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    const stack = String(err && err.stack ? err.stack : err).split('\n').slice(0, 8);
    console.log(`  ✗ ${name}\n      ${stack.join('\n      ')}`);
  }
};

const server = createServer({ appDir: APP, port: 0 });
const info = await server.listen();
const origin = `http://127.0.0.1:${info.port}`;
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await pinTheme(context, 'classic');
await context.grantPermissions([...MIDI_PERMISSIONS], { origin });
const page = await context.newPage();
const errors = [];
const chartFetches = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url || '?'}`);
  else if (VERBOSE) console.log(`   [${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('request', (r) => {
  if (/\/js\/views\/chart\/|styles-chart\.css/.test(r.url())) chartFetches.push(r.url());
});
page.on('response', (r) => {
  if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
});
const ev = (fn, arg) => page.evaluate(fn, arg);
const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
const firstChord = () => ev(() => document.querySelector('#perform-chart .chv-ch')?.textContent ?? null);
const chords = () => ev(() => [...document.querySelectorAll('#perform-chart .chv-line')].slice(0, 2)
  .flatMap((l) => [...l.querySelectorAll('.chv-ch')].map((c) => c.textContent)));

try {
  await T('boot with the flag off: no chart DOM, nothing of the chart fetched', async () => {
    await page.goto(`${origin}/`);
    await waitRigReady(page, { timeout: 30000 });
    const overlay = await page.$('#overlay-start:not([hidden])');
    if (overlay) await overlay.click();
    await until(() => window.__rig.controller.status.songId === window.__rig.store.get().settings.currentSongId
      && !window.__rig.controller.status.loading, null, 30000);
    await until(() => !!window.__rig.views.settings && !!window.__rig.views.edit, null, 20000);
    const r = await ev(() => ({
      flag: 'chartView' in window.__rig.store.get().settings,
      view: window.__rig.views.chart,
      dom: document.querySelectorAll('[class*="chv-"], #perform-chart, [data-testid^="chart-"]').length,
      css: !!document.querySelector('link[data-chart-css]'),
    }));
    assert.deepEqual(r, { flag: false, view: null, dom: 0, css: false });
    assert.deepEqual(chartFetches, []);
  });

  await T('flag on: a Chart toggle after Notes; the panel opens on the empty state', async () => {
    assert.equal(await ev(() => window.__rig.setChartView(true)), true);
    await until(() => !!document.querySelector('[data-testid="chart-toggle"]'));
    assert.equal(await ev(() => document.querySelector('[data-testid="chart-toggle"]').previousElementSibling
      ?.dataset.testid), 'notes-toggle');
    assert.ok(chartFetches.some((u) => u.endsWith('/styles-chart.css')));
    // the song in G, no transpose, so the chart's key is the song's (no key offer)
    await ev(() => {
      const { store } = window.__rig;
      const id = store.currentSong().id;
      store.set(`songs.${id}.playIn`, 7);
      store.set(`songs.${id}.hearIn`, 7);
      store.set(`songs.${id}.minor`, false);
    });
    await page.click('[data-testid="chart-toggle"]');
    await until(() => !document.getElementById('perform-chart').hidden);
    assert.equal(await page.isVisible('[data-testid="chart-empty"]'), true);
    assert.equal(await page.getAttribute('[data-testid="chart-toggle"]', 'aria-pressed'), 'true');
  });

  await T('import: file → review with offers (unticked); tick Title only; Save stores the source text', async () => {
    const before = await ev(() => {
      const s = window.__rig.store.currentSong();
      return { name: s.name, tempo: s.tempo ?? null };
    });
    await page.click('[data-testid="chart-add-empty"]');
    await until(() => !!document.querySelector('[data-testid="chart-import"]'));
    await page.setInputFiles('[data-testid="chart-file"]',
      { name: 'paper-boats.cho', mimeType: 'text/plain', buffer: Buffer.from(CHART) });
    await until(() => /Read as ChordPro/.test(document.querySelector('[data-testid="chart-summary"]')?.textContent));
    const offers = await ev(() => [...document.querySelectorAll('[data-offer]')]
      .map((b) => [b.dataset.offer, b.checked]));
    assert.ok(offers.some(([f]) => f === 'name'), 'title offered');
    assert.ok(!offers.some(([f]) => f === 'key'), 'same key: not offered');
    assert.ok(offers.every(([, c]) => c === false), 'nothing ticked by default');
    // skeptic V8: a review with no parser warnings showed the word "null"
    assert.doesNotMatch(await page.textContent('[data-testid="chart-review"]'), /\bnull\b|undefined/);
    await page.check('[data-offer="name"]');
    await page.click('[data-testid="chart-save"]');
    await until(() => !document.querySelector('[data-testid="chart-import"]'));
    const s = await ev(() => {
      const x = window.__rig.store.currentSong();
      return { name: x.name, tempo: x.tempo ?? null, chart: x.chart };
    });
    assert.equal(s.name, 'Paper Boats');
    assert.equal(s.tempo, before.tempo, 'tempo was offered, not ticked: unchanged');
    assert.deepEqual(s.chart, { text: CHART, format: 'chordpro', name: 'paper-boats.cho' });
    await until(() => !!document.querySelector('#perform-chart .chv-ch'));
    assert.deepEqual(await chords(), ['G', 'C', 'D', 'Em', 'C/E', 'D']);
    assert.equal(await page.textContent('[data-testid="chart-key"]'), 'Key G');
    assert.equal(await ev(() => document.querySelectorAll('#perform-chart .chv-sec-h').length), 7);
  });

  await T('Perform Transpose + re-keys the chords live (flats for Ab); hands mode shows G', async () => {
    await page.click('[data-testid="transpose-up"]');
    await until(() => document.querySelector('#perform-chart .chv-ch')?.textContent === 'Ab');
    assert.deepEqual(await chords(), ['Ab', 'Db', 'Eb', 'Fm', 'Db/F', 'Eb']);
    assert.match(await page.textContent('[data-testid="chart-key"]'), /^Key Ab · written in G/);
    await page.click('#perform-chart [data-mode="play"]');
    await until(() => document.querySelector('#perform-chart .chv-ch')?.textContent === 'G');
    await page.click('#perform-chart [data-mode="hear"]');
    await until(() => document.querySelector('#perform-chart .chv-ch')?.textContent === 'Ab');
    await page.click('[data-testid="transpose-up"]');
    await until(() => document.querySelector('#perform-chart .chv-ch')?.textContent === 'A');
    assert.deepEqual(await chords(), ['A', 'D', 'E', 'F#m', 'D/F#', 'E'], 'sharps for A');
  });

  await T('big type steps, manual scroll and auto-scroll', async () => {
    const size = () => ev(() => parseFloat(getComputedStyle(document.querySelector('.chv-sheet')).fontSize));
    const s0 = await size();
    await page.click('[data-testid="chart-font-up"]');
    await page.click('[data-testid="chart-font-up"]');
    assert.ok((await size()) > s0, 'bigger');
    await page.screenshot({ path: path.join(SHOTS, 'chart.png') });
    const body = '#perform-chart .chv-body';
    assert.ok(await ev((b) => document.querySelector(b).scrollHeight > document.querySelector(b).clientHeight, body));
    await page.click('[data-testid="chart-page-down"]');
    const y1 = await ev((b) => document.querySelector(b).scrollTop, body);
    assert.ok(y1 > 0, 'page down scrolls');
    await page.click('[data-testid="chart-page-up"]');
    assert.equal(await ev((b) => document.querySelector(b).scrollTop, body), 0);
    const st = await ev(() => window.__rig.views.chart.state());
    assert.ok(st.rate > 0 && st.lines === 22, JSON.stringify(st));
    await page.click('[data-testid="chart-speed-up"]');
    await page.click('[data-testid="chart-speed-up"]');
    assert.equal(await page.textContent('[data-testid="chart-speed"]'), '×1.25');
    // a fast tempo so the test needn't wait: the pace scales with it
    await ev(() => window.__rig.store.set('song.tempo', 300));
    await page.click('[data-testid="chart-auto"]');
    assert.equal(await page.getAttribute('[data-testid="chart-auto"]', 'aria-pressed'), 'true');
    await until((b) => document.querySelector(b).scrollTop > 20, body, 10000);
    await page.click('[data-testid="chart-auto"]');
    const y2 = await ev((b) => document.querySelector(b).scrollTop, body);
    await page.waitForTimeout(400);
    assert.equal(await ev((b) => document.querySelector(b).scrollTop, body), y2, 'stopped');
  });

  await T('a committed song switch swaps the chart (and back)', async () => {
    const first = await ev(() => window.__rig.store.currentSong().id);
    await page.click('[data-testid="chart-auto"]'); // auto on; a switch stops it and goes to the top
    await ev(() => window.__rig.controller.nextSong());
    await until((id) => window.__rig.store.currentSong().id !== id, first);
    await until(() => !document.querySelector('[data-testid="chart-empty"]').hidden);
    assert.equal(await ev(() => document.querySelectorAll('#perform-chart .chv-ch').length), 0);
    const st = await ev(() => window.__rig.views.chart.state());
    assert.equal(st.auto, false);
    assert.equal(st.hasChart, false);
    await ev(() => window.__rig.controller.prevSong());
    await until((id) => window.__rig.store.currentSong().id === id, first);
    await until(() => document.querySelector('#perform-chart .chv-ch')?.textContent === 'A');
    assert.equal(await ev(() => document.querySelector('#perform-chart .chv-body').scrollTop), 0);
  });

  await T('Perform lock freezes Add / Remove; Remove needs a second tap', async () => {
    await ev(() => window.__rig.store.set('settings.performLock', true));
    await until(() => document.querySelector('[data-testid="chart-remove"]').disabled);
    assert.equal(await page.isDisabled('[data-testid="chart-add"]'), true);
    await ev(() => window.__rig.store.set('settings.performLock', false));
    await until(() => !document.querySelector('[data-testid="chart-remove"]').disabled);
    await page.click('[data-testid="chart-remove"]');
    assert.equal(await page.textContent('[data-testid="chart-remove"]'), 'Remove? Tap again');
    assert.equal(await ev(() => !!window.__rig.store.currentSong().chart), true);
    await page.click('[data-testid="chart-remove"]');
    await until(() => !window.__rig.store.currentSong().chart);
    await until(() => !document.querySelector('[data-testid="chart-empty"]').hidden);
  });

  await T('paste + a song-list CSV makes placeholder songs', async () => {
    const n0 = await ev(() => window.__rig.store.songsInOrder().length);
    await page.click('[data-testid="chart-add-empty"]');
    await until(() => !!document.querySelector('[data-testid="chart-import"]'));
    await page.fill('[data-testid="chart-paste"]', 'Title,Author,CCLI\nTest Song One,A. Writer,111\nTest Song Two,,\n');
    await until(() => /Add 2 songs/.test(document.querySelector('[data-testid="chart-save"]').textContent));
    assert.doesNotMatch(await page.textContent('[data-testid="chart-review"]'), /\bnull\b|undefined/);
    await page.click('[data-testid="chart-save"]');
    await until((n) => window.__rig.store.songsInOrder().length === n + 2, n0);
    const added = await ev(() => window.__rig.store.songsInOrder().slice(-2).map((s) => [s.name, s.notes]));
    assert.deepEqual(added, [['Test Song One', 'A. Writer · CCLI 111'], ['Test Song Two', '']]);
  });

  await T('Esc closes the dialog without a Panic (and Esc with nothing open does panic)', async () => {
    // skeptic V2: the controller's Esc handler calls its own panic(), not controller.panic, so wrapping the method
    // counted nothing. Count the 'action' events panic() emits instead, with a positive control after the close.
    await ev(() => {
      window.__panics = 0;
      window.__rig.controller.addEventListener('action', (e) => {
        if (e.detail?.type === 'panic') window.__panics += 1;
      });
    });
    await page.click('[data-testid="chart-add-empty"]');
    await until(() => !!document.querySelector('[data-testid="chart-import"]'));
    await page.keyboard.press('Escape');
    await until(() => !document.querySelector('[data-testid="chart-import"]'));
    assert.equal(await ev(() => window.__panics), 0);
    assert.equal(await ev(() => document.body.dataset.dialogOpen ?? null), null);
    await ev(() => document.activeElement?.blur?.());
    await page.keyboard.press('Escape');
    await until(() => window.__panics === 1, null, 5000);
  });

  await T('the dialog keeps Tab inside it; a keyboard-opened one gives focus back', async () => {
    await page.focus('[data-testid="chart-add-empty"]');
    await page.keyboard.press('Enter');
    await until(() => !!document.querySelector('[data-testid="chart-import"]'));
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab');
      assert.equal(await ev(() => !!document.activeElement?.closest('[data-testid="chart-import"]')), true, `tab ${i}`);
    }
    await page.keyboard.press('Escape');
    await until(() => !document.querySelector('[data-testid="chart-import"]'));
    assert.equal(await ev(() => document.activeElement?.dataset.testid), 'chart-add-empty');
    await ev(() => document.activeElement?.blur?.());
  });

  await T('Lock closes an open dialog (nothing saved); a view gone mid-load opens no dialog', async () => {
    await page.click('[data-testid="chart-add-empty"]');
    await until(() => !!document.querySelector('[data-testid="chart-import"]'));
    await page.fill('[data-testid="chart-paste"]', '[G]Lock test line');
    await ev(() => window.__rig.store.set('settings.performLock', true));
    await until(() => !document.querySelector('[data-testid="chart-import"]'));
    assert.equal(await ev(() => !!window.__rig.store.currentSong().chart), false);
    await ev(() => window.__rig.store.set('settings.performLock', false));
    // skeptic V3: openImport awaits import.js; a flag-off in between used to leave an orphan dialog on <body>
    const orphans = await ev(async () => {
      window.__rig.views.chart.openImport();
      await window.__rig.setChartView(false);
      await new Promise((r) => setTimeout(r, 300));
      return document.querySelectorAll('.chv-dlg-host').length;
    });
    assert.equal(orphans, 0);
    assert.equal(await ev(() => window.__rig.setChartView(true)), true);
    await until(() => !!document.querySelector('[data-testid="chart-toggle"]'));
  });

  await T('contrast ≥ 4.5:1 for chart text on every theme; 44 px targets in the panel', async () => {
    // skeptic V6 / V7. Daylight Day's --accent is a fill (1.7:1 as text); the chart reads --accent-text first.
    await ev(() => {
      const { store } = window.__rig;
      const text = '{key: G}\n{c: Verse}\n[G]Paper [C]boats\n{c: play it soft}\n';
      store.setChart(store.currentSong().id, { text, format: 'chordpro' });
      window.__rig.views.chart.open();
    });
    await until(() => !!document.querySelector('#perform-chart .chv-ch'));
    const ids = await ev(() => import('/js/shared/themes.js').then((m) => m.pickableThemes().map((t) => t.id)));
    assert.ok(ids.length >= 8, `themes: ${ids}`);
    const low = [];
    for (const id of ids) {
      await ev((t) => window.__rig.theme.apply(t), id);
      await page.waitForTimeout(300);
      const r = await ev(() => {
        const rgb = (c) => {
          const m = c.match(/rgba?\(([^)]+)\)/);
          if (m) {
            const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
            return [p[0], p[1], p[2], p[3] ?? 1];
          }
          const n = c.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/);
          return n ? [n[1] * 255, n[2] * 255, n[3] * 255, n[4] === undefined ? 1 : +n[4]] : null;
        };
        const lum = (c) => {
          const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
        };
        const bg = (el) => {
          const layers = [];
          for (let e = el; e; e = e.parentElement) {
            const c = rgb(getComputedStyle(e).backgroundColor);
            if (c && c[3] > 0) {
              layers.push(c);
              if (c[3] >= 1) break;
            }
          }
          return layers.reverse().reduce((o, c) => o.map((v, i) => v * (1 - c[3]) + c[i] * c[3]), [0, 0, 0]);
        };
        const ratio = (sel) => {
          const el = document.querySelector(sel);
          const fg = rgb(getComputedStyle(el).color);
          const b = bg(el);
          const f = fg.slice(0, 3).map((v, i) => v * fg[3] + b[i] * (1 - fg[3]));
          const [hi, lo] = [lum(f), lum(b)].sort((x, y) => y - x);
          return (hi + 0.05) / (lo + 0.05);
        };
        return Object.fromEntries(['.chv-ly', '.chv-ch', '.chv-sec-h', '.chv-comment', '.chv-key']
          .map((s) => [s, +ratio(`#perform-chart ${s}`).toFixed(2)]));
      });
      for (const [sel, v] of Object.entries(r)) if (v < 4.5) low.push(`${id} ${sel} ${v}`);
    }
    await ev(() => window.__rig.theme.apply('classic'));
    assert.deepEqual(low, []);
    const small = await ev(() => [...document.querySelectorAll('#perform-chart button')].filter((b) => b.offsetParent)
      .map((b) => [b.dataset.testid || b.textContent, b.getBoundingClientRect()])
      .filter(([, r]) => r.width < 43.5 || r.height < 43.5).map(([n, r]) => `${n} ${r.width}x${r.height}`));
    assert.deepEqual(small, []);
  });

  await T('flag off: the toggle, panel and stylesheet go away', async () => {
    assert.equal(await ev(() => window.__rig.setChartView(false)), false);
    const r = await ev(() => ({
      flag: 'chartView' in window.__rig.store.get().settings,
      view: window.__rig.views.chart,
      dom: document.querySelectorAll('[class*="chv-"], #perform-chart, [data-testid^="chart-"]').length,
      css: !!document.querySelector('link[data-chart-css]'),
    }));
    assert.deepEqual(r, { flag: false, view: null, dom: 0, css: false });
  });

  await T('?chart=1 turns it on at boot (and the chart open state is remembered)', async () => {
    await page.goto(`${origin}/?chart=1`);
    await waitRigReady(page, { timeout: 30000 });
    await until(() => !!document.querySelector('[data-testid="chart-toggle"]'), null, 20000);
    assert.equal(await ev(() => window.__rig.store.get().settings.chartView), true);
    assert.equal(await ev(() => !document.getElementById('perform-chart').hidden), true);
    await page.goto(`${origin}/?chart=0`);
    await waitRigReady(page, { timeout: 30000 });
    assert.equal(await ev(() => 'chartView' in window.__rig.store.get().settings), false);
    assert.equal(await ev(() => !!document.querySelector('[data-testid="chart-toggle"]')), false);
  });

  await T('zero console.error, no HTTP ≥ 400', async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  await context.close();
  await browser.close();
  await server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nchart: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
