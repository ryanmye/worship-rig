// UI v6 U7b: the chord chart in the v6 layout (app/js/views/v6/chart/; native/docs/lanes/UI6-build-plan.md U7b; D7,
// D12, D16; mockups native/docs/design/mockups/chart.html and dialogs.html "Edit chart"). Run from run.mjs after
// today's chart view tests, in its own context (1280 × 800, Sanctuary):
//   flag combinations: v6 on + chart off = nothing chart-related fetched, drawn or listened to (and the same as the
//   base build's v6: requests, window / document listeners, store listeners, DOM); both on = the Chart module in the
//   sidebar and on the stage; flips both ways (chart off / v6 off = today's chart view);
//   the sidebar module (tab, rail icon, wider while it shows, its own drag width, its place kept while the flag is
//   off);
//   placement ⇥ Sidebar / ⤢ Stage (strips → live mini faders, the sidebar folds to its rail with Chart lit, ▤ Strips,
//   remembered per device across a reload); the mini faders write what the strips write (also under Lock);
//   key on show (song key, Easy Transpose, D12 relative key, Heard / Hands); text size in % (steps, % → 100 %, Fit,
//   ⌘+ / ⌘− / ⌘0, ⌘-scroll, a CDP two-finger pinch, the readout, per place); the px → % migration (once); auto-scroll,
//   jumps and the reading line; the Edit chart dialog (live preview, status line, offers unticked, Save, Cancel,
//   Remove, Esc, Lock); iPad landscape / portrait; screenshots; zero console.error.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { MIDI_PERMISSIONS, waitRigReady, pinTheme } from '../../integration/lib.mjs';

const PREFS = 'worship-rig.chart';
const SIDE = 'worship-rig.v6.sidebar';
const CHART_RE = /\/js\/views\/chart\/|\/js\/views\/v6\/chart\/|styles-chart\.css|styles-v6-chart\.css/;

// written for this test (never real lyrics); one line long enough that Fit has to pick less than 200 %
const LONG = '[G]Counting every tile along the [D/F#]corridor of the [Em]station [C]hall';
const CHART = ['{title: Tile Counter}', '{key: G}', '{c: Verse 1}', LONG, '[Em]Steady [C]feet and [D]slow',
  '{soc}', '[C]Count a[G]gain, [D]count a[Em]gain', '[C]Down the [G]line we [D]go', '{eoc}',
  '{c: Verse 2}', '[G]Paper [C]signs and [D]arrows', '[Em]Pointing [C]where to [D]go', '{chorus}',
  '{c: Bridge}', '[Em]Nothing [C]holds', '[G]nothing [D]stays', '{chorus}'].join('\n');
const EM_CHART = '{key: Em}\n{c: Verse}\n[Em]Grey [C]stone [G]walls [D]here\n';

/**
 * @param {object} x  run.mjs's helpers: {T, browser, origin, ROOT, APP, createServer, assert, SHOTS}
 */
export async function v6Tests(x) {
  const { T, browser, origin, ROOT, APP, createServer, assert } = x;
  const SHOTS = process.env.U7B_SHOTS ? path.resolve(process.env.U7B_SHOTS) : x.SHOTS;
  fs.mkdirSync(SHOTS, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await pinTheme(context, 'sanctuary');
  await context.grantPermissions([...MIDI_PERMISSIONS], { origin });
  const page = await context.newPage();
  const errors = [];
  let fetches = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url || '?'}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    if (CHART_RE.test(r.url())) fetches.push(r.url());
  });
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
  const tid = (id) => `[data-testid="${id}"]`;
  const st = () => ev(() => window.__rig.views.chart?.state() ?? null);
  const hideToasts = () => page.addStyleTag({ content: '#toasts { display: none !important; }' });
  async function boot(q) {
    await page.goto(`${origin}/${q}`);
    await waitRigReady(page, { timeout: 40000 });
    const overlay = await page.$('#overlay-start:not([hidden])');
    if (overlay) await overlay.click();
    await until(() => !!window.__rig.views.v6 && !!window.__rig.views.settings, null, 30000);
    await hideToasts();
  }
  /** Reload without the first boot's ?chart=0 (both flags are remembered on this device). */
  async function reboot() {
    await page.goto(`${origin}/`);
    await waitRigReady(page, { timeout: 40000 });
    await bothOn();
    await hideToasts();
  }
  const bothOn = () => until(() => !!window.__rig.views.chart?.state()?.v6
    && window.__rig.views.v6.sidebar.modules.includes('chart'), null, 20000);
  /** The current song in C (G → C: a chart written in G shows a 4th up), no Easy Transpose, the chart set. */
  const setSong = (text = CHART) => ev((t) => {
    const { store } = window.__rig;
    const id = store.currentSong().id;
    store.set(`songs.${id}.hearIn`, 0);
    store.set(`songs.${id}.playIn`, 0);
    store.set(`songs.${id}.minor`, false);
    store.setChart(id, { text: t, format: 'chordpro' });
    return id;
  }, text);
  const chordsIn = (sel) => ev((s) => [...document.querySelectorAll(`${s} .chv-line`)].slice(0, 1)
    .flatMap((l) => [...l.querySelectorAll('.chv-ch')].map((c) => c.textContent.trim())), sel);
  /** Record the store paths written while fn runs in the page. */
  const pathsOf = (fn) => ev(async (src) => {
    const { store } = window.__rig;
    const orig = store.set;
    const seen = [];
    store.set = function (p, ...a) {
      seen.push(String(p).replace(/^songs\.[^.]+\./, 'song.'));
      return orig.call(this, p, ...a);
    };
    try {
      // eslint-disable-next-line no-new-func
      await new Function(`return (${src})()`)();
      await new Promise((r) => setTimeout(r, 120));
    } finally {
      store.set = orig;
    }
    return [...new Set(seen)];
  }, fn.toString());

  try {
    // ------------------------------------------------------------------ v6 on, chart off
    await T('U7b v6 on, chart off: nothing chart-related fetched, drawn or in the sidebar', async () => {
      fetches = [];
      await boot('?ui6=1&chart=0'); // a fresh context: nothing stored
      await page.waitForTimeout(800);
      const r = await ev(() => ({
        chart: window.__rig.views.chart,
        flag: 'chartView' in window.__rig.store.get().settings,
        mods: window.__rig.views.v6.sidebar.modules,
        dom: document.querySelectorAll('[data-testid^="v6-chart"], [data-testid="v6-rb-chart"], .v6-chstage, '
          + '[data-testid^="chart-"], link[data-chart-css], link[data-v6-chart-css]').length,
        notesChart: document.querySelector('.v6-notes-chart')?.disabled ?? null,
      }));
      assert.deepEqual(r, { chart: null, flag: false, mods: ['drone', 'setlist', 'notes', 'metronome'], dom: 0,
        notesChart: null });
      assert.deepEqual(fetches, []);
      // the Notes module's "Chart · coming in 2.1" is as before
      await page.click(tid('v6-sb-tab-notes'));
      assert.equal(await ev(() => document.querySelector('.v6-notes-chart').disabled), true);
      assert.match(await ev(() => document.querySelector('.v6-notes-chart').textContent), /coming in 2\.1/);
    });

    await T('U7b v6 on, chart off: the same as the base build’s v6 (requests, listeners, store listeners, DOM)',
      async () => {
        let base = process.env.UI6_PURITY_BASE || '';
        try {
          if (!base) base = execFileSync('git', ['merge-base', 'HEAD', 'v2-native'], { cwd: ROOT }).toString().trim();
        } catch (err) {
          console.log(`      (skipped: no git base: ${String(err.message).split('\n')[0]})`);
          return;
        }
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u7b-base-'));
        try {
          const tar = path.join(tmp, 'app.tar');
          execFileSync('git', ['archive', '-o', tar, base, 'app', ':(exclude)app/samples'], { cwd: ROOT });
          execFileSync('tar', ['-xf', tar, '-C', tmp]);
          fs.symlinkSync(path.join(APP, 'samples'), path.join(tmp, 'app', 'samples'));
          const baseServer = createServer({ appDir: path.join(tmp, 'app'), port: 0 });
          const bi = await baseServer.listen();
          try {
            const a = await v6PurityBoot(browser, `http://127.0.0.1:${bi.port}`);
            const b = await v6PurityBoot(browser, origin);
            assert.deepEqual(b.reqs, a.reqs, 'non-sample requests');
            assert.deepEqual(b.ael, a.ael, 'window / document addEventListener calls by type');
            assert.equal(b.intervals, a.intervals, 'setInterval calls');
            assert.equal(b.store, a.store, 'store listeners');
            assert.ok(a.store > 0, 'the store probe works');
            // (Edit's and Settings' v6 sheets load side by side: their order is a race, so it is compared sorted)
            assert.deepEqual(b.css.slice().sort(), a.css.slice().sort(), 'stylesheets');
            if (b.dom !== a.dom) {
              const al = a.dom.split('\n');
              const bl = b.dom.split('\n');
              const i = al.findIndex((l, k) => l !== bl[k]);
              assert.fail(`DOM differs at element ${i}: base ${JSON.stringify(al.slice(i - 2, i + 3))} branch `
                + `${JSON.stringify(bl.slice(i - 2, i + 3))}`);
            }
            console.log(`      base ${base.slice(0, 8)} (v6 on): ${a.reqs.length} requests, ${a.store} store `
              + `listeners, `
              + `${a.dom.split('\n').length} elements — identical`);
          } finally {
            await baseServer.close();
          }
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      });

    // ------------------------------------------------------------------ both on: the sidebar module
    await T('U7b both on: a Chart module (tab + rail icon), the chart in it at 75 %, the sidebar wider while it shows',
      async () => {
        fetches = [];
        await ev(() => window.__rig.setChartView(true));
        await bothOn();
        assert.ok(fetches.some((u) => u.includes('/views/v6/chart/chart.js')), 'the v6 module');
        assert.ok(!fetches.some((u) => u.includes('/views/chart/index.js')), 'not today’s view');
        assert.equal(await page.isVisible(tid('chart-toggle')), false, 'no Chart toggle in the song bar');
        await setSong();
        const w0 = await ev(() => document.querySelector('.v6-side').getBoundingClientRect().width);
        // orchestrator decision a (UI6-U7b review): a device that never chose shows the chart on the stage; nothing
        // is stored for the placement until the player picks one (then it is remembered)
        assert.equal((await st()).placement, 'stage');
        assert.equal((await st()).onStage, false, 'not up until asked for');
        assert.equal(await ev((k) => 'placement' in JSON.parse(localStorage.getItem(k) || '{}'), PREFS), false);
        await page.click(tid('v6-sb-tab-chart'));
        await until(() => !!document.querySelector('[data-testid="v6-chart-stage"]'));
        assert.equal(await ev((k) => 'placement' in JSON.parse(localStorage.getItem(k) || '{}'), PREFS), false);
        await page.click(`${tid('v6-chart-stage')} ${tid('v6-chart-place')}`);
        await until(() => !!document.querySelector('[data-testid="v6-chart-side"]'));
        assert.equal(await ev((k) => JSON.parse(localStorage.getItem(k)).placement, PREFS), 'side');
        await page.click(tid('v6-sb-tab-drone'));
        await until((w) => Math.abs(document.querySelector('.v6-side').getBoundingClientRect().width - w) < 2, w0);
        await page.click(tid('v6-sb-tab-chart'));
        await until(() => !!document.querySelector('[data-testid="v6-chart-side"]'));
        const s = await st();
        assert.equal(s.placement, 'side');
        assert.equal(s.inSidebar, true);
        assert.equal(s.pct, 75);
        assert.equal(s.px, 18);
        // a fresh panel with a chart: Scroll and Fit are live at once
        assert.deepEqual(await ev(() => ['v6-chart-auto', 'v6-chart-fit', 'v6-chart-faster']
          .map((t) => document.querySelector(`[data-testid="v6-chart-side"] [data-testid="${t}"]`).disabled)),
        [false, false, false]);
        const w1 = await ev(() => document.querySelector('.v6-side').getBoundingClientRect().width);
        assert.ok(w1 > w0 + 100 && Math.abs(w1 - 540) < 2, `540 px while Chart shows (${w0} → ${w1})`);
        await page.click(tid('v6-sb-tab-drone'));
        await until((w) => Math.abs(document.querySelector('.v6-side').getBoundingClientRect().width - w) < 2, w0);
        // the rail has a Chart icon too; it opens the sidebar on Chart
        await page.click(tid('v6-sb-collapse'));
        await page.click(tid('v6-rb-chart'));
        await until(() => !!document.querySelector('[data-testid="v6-chart-side"]'));
        // a drag on the chart's sidebar is kept for Chart only
        const g = await page.locator(tid('v6-sb-grip')).boundingBox();
        await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
        await page.mouse.down();
        await page.mouse.move(g.x - 200, g.y + g.height / 2, { steps: 6 });
        await page.mouse.up();
        const p = await ev((k) => JSON.parse(localStorage.getItem(k)), SIDE);
        assert.ok(p.widths?.chart > 600, `chart width stored: ${JSON.stringify(p.widths)}`);
        assert.equal(p.width ?? null, null, 'the other modules’ width untouched');
        assert.ok(p.order.includes('chart'));
        await page.screenshot({ path: path.join(SHOTS, 'u7b-wide-sidebar-1280.png') });
        await ev((k) => {
          const q = JSON.parse(localStorage.getItem(k));
          delete q.widths;
          localStorage.setItem(k, JSON.stringify(q));
        }, SIDE);
      });

    await T('U7b sidebar ⋯ customize lists Chart: hide / show, ↑ ↓ keep the order with it', async () => {
      await page.click(tid('v6-sb-tab-drone'));
      await page.click(tid('v6-sb-customize'));
      await until(() => !!document.querySelector('[data-testid="v6-cz-chart"]'));
      const order = () => ev(() => [...document.querySelectorAll('.v6-cz')].map((r) => r.dataset.id));
      assert.deepEqual(await order(), ['drone', 'setlist', 'notes', 'metronome', 'chart']);
      await page.click(tid('v6-cz-up-chart'));
      assert.deepEqual(await order(), ['drone', 'setlist', 'notes', 'chart', 'metronome']);
      assert.deepEqual(await ev(() => [...document.querySelectorAll('.v6-sb-tab')].map((b) => b.dataset.id)),
        ['drone', 'setlist', 'notes', 'chart', 'metronome']);
      await page.click(tid('v6-cz-show-chart'));
      await until(() => !document.querySelector('[data-testid="v6-sb-tab-chart"]'));
      await page.click(tid('v6-cz-show-chart'));
      await until(() => !!document.querySelector('[data-testid="v6-sb-tab-chart"]'));
      await page.keyboard.press('Escape');
      await until(() => !document.querySelector('[data-testid="v6-sb-cz"]'));
    });

    await T('U7b key on show: the song key, Easy Transpose, Heard / Hands, D12 relative key', async () => {
      await ev(() => window.__rig.views.chart.show());
      const sel = '[data-testid="v6-chart-sheet"]';
      await until(() => !!document.querySelector('[data-testid="v6-chart-sheet"] .chv-ch'));
      assert.deepEqual(await chordsIn(sel), ['C', 'G/B', 'Am', 'F']);
      assert.match(await page.textContent(tid('v6-chart-key')), /^Key C · written in G · /);
      await page.click(tid('v6-transpose-up'));
      await until(() => document.querySelector('[data-testid="v6-chart-sheet"] .chv-ch')?.textContent.trim() === 'Db');
      await page.click(tid('v6-chart-play'));
      await until(() => document.querySelector('[data-testid="v6-chart-sheet"] .chv-ch')?.textContent.trim() === 'C');
      assert.match(await page.textContent(tid('v6-chart-key')), /\(your hands\)/);
      await page.click(tid('v6-chart-hear'));
      await page.click(tid('v6-transpose-down'));
      await until(() => document.querySelector('[data-testid="v6-chart-sheet"] .chv-ch')?.textContent.trim() === 'C');
      // D12: an Em chart on a song in G matches through its relative key (not Gm Eb Bb F)
      const id = await setSong(EM_CHART);
      await ev((i) => {
        window.__rig.store.set(`songs.${i}.hearIn`, 7);
        window.__rig.store.set(`songs.${i}.playIn`, 7);
      }, id);
      await until(() => document.querySelector('[data-testid="v6-chart-sheet"] .chv-ch')?.textContent.trim() === 'Em');
      assert.deepEqual(await chordsIn(sel), ['Em', 'C', 'G', 'D']);
      assert.match(await page.textContent(tid('v6-chart-key')), /^Key Em/);
      await setSong();
    });

    // ------------------------------------------------------------------ placement
    await T('U7b ⤢ Stage: strips → live mini faders + the chart, the sidebar folds with Chart lit; ▤ Strips; ⇥ Sidebar',
      async () => {
        await ev(() => window.__rig.views.chart.show());
        await until(() => !!document.querySelector('[data-testid="v6-chart-side"]'));
        await page.click(`${tid('v6-chart-side')} ${tid('v6-chart-place')}`);
        await until(() => !!document.querySelector('[data-testid="v6-chart-stage"]'));
        const r = await ev(() => ({
          strips: getComputedStyle(document.querySelector('.v6-stripsarea')).display,
          minis: document.querySelectorAll('[data-testid^="v6-mini-on-"]').length,
          slots: window.__rig.store.currentSong().patch.slots.length,
          rail: document.querySelector('.v6-side').classList.contains('rail'),
          lit: document.querySelector('[data-testid="v6-rb-chart"]').classList.contains('live'),
          side: !!document.querySelector('[data-testid="v6-chart-side"]'),
          place: document.querySelector('[data-testid="v6-chart-stage"] [data-testid="v6-chart-place"]').textContent,
        }));
        assert.equal(r.strips, 'none');
        assert.equal(r.minis, r.slots);
        assert.deepEqual([r.rail, r.lit, r.side, r.place], [true, true, false, '⇥ Sidebar']);
        assert.equal((await st()).pct, 100, 'the stage has its own size (100 %)');
        await page.screenshot({ path: path.join(SHOTS, 'u7b-stage-1280.png') });
        // the Drone icon opens the sidebar on Drone; the chart stays on the stage
        await page.click(tid('v6-rb-drone'));
        await until(() => !document.querySelector('.v6-side').classList.contains('rail'));
        assert.equal(await ev(() => window.__rig.views.v6.sidebar.mounted), 'drone');
        assert.equal((await st()).onStage, true);
        // the Chart tab, with the chart living on the stage, keeps it there and folds the sidebar
        await page.click(tid('v6-sb-tab-chart'));
        await until(() => document.querySelector('.v6-side').classList.contains('rail'));
        assert.equal((await st()).onStage, true);
        // ▤ Strips: the strips come back; the rail's Chart puts it up again
        await page.click(tid('v6-chart-strips'));
        await until(() => !document.querySelector('.v6-chstage'));
        assert.notEqual(await ev(() => getComputedStyle(document.querySelector('.v6-stripsarea')).display), 'none');
        assert.equal(await ev(() => document.querySelector('[data-testid="v6-rb-chart"]').classList.contains('live')),
          false);
        await page.click(tid('v6-rb-chart'));
        await until(() => !!document.querySelector('[data-testid="v6-chart-stage"]'));
        // per device: a reload keeps the stage placement and the chart up
        await reboot();
        await until(() => !!document.querySelector('[data-testid="v6-chart-stage"]'));
        const p = await ev((k) => JSON.parse(localStorage.getItem(k)), PREFS);
        assert.equal(p.placement, 'stage');
        assert.equal(p.stage, true);
        const lib = await ev(() => window.__rig.store.exportJSON());
        assert.ok(!/"placement"|"sidePct"/.test(lib), 'the placement is not in the library');
        // ⇥ Sidebar: the strips back, the sidebar open on Chart
        await page.click(`${tid('v6-chart-stage')} ${tid('v6-chart-place')}`);
        await until(() => !!document.querySelector('[data-testid="v6-chart-side"]'));
        assert.equal(await ev(() => !!document.querySelector('.v6-chstage')), false);
        assert.equal((await st()).placement, 'side');
      });

    await T('U7b mini faders write what the strips write (ON → muted, fader → gain), live under Lock', async () => {
      await ev(() => window.__rig.views.chart.setPlacement('stage'));
      await until(() => !!document.querySelector('[data-testid="v6-mini-on-0"]'));
      const miniOn = await pathsOf(() => document.querySelector('[data-testid="v6-mini-on-0"]').click());
      assert.deepEqual(miniOn, ['song.patch.slots.0.muted']);
      assert.equal(await ev(() => window.__rig.store.currentSong().patch.slots[0].muted), true);
      await page.focus(`${tid('v6-mini-fader-0')} input`);
      const miniF = await pathsOf(() => {
        const i = document.querySelector('[data-testid="v6-mini-fader-0"] input');
        i.value = String(Number(i.value) - 120);
        i.dispatchEvent(new Event('input', { bubbles: true }));
        i.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await ev(() => document.activeElement?.blur());
      // the strip, on the same instrument (▤ Strips)
      await page.click(tid('v6-chart-strips'));
      await until(() => !document.querySelector('.v6-chstage'));
      const stripOn = await pathsOf(() => document.querySelector('[data-testid="v6-on-0"]').click());
      const stripF = await pathsOf(() => {
        const i = document.querySelector('[data-testid="v6-fader-0"] input');
        i.value = String(Number(i.value) - 120);
        i.dispatchEvent(new Event('input', { bubbles: true }));
        i.dispatchEvent(new Event('change', { bubbles: true }));
      });
      assert.deepEqual(stripOn, miniOn);
      assert.deepEqual(miniF, stripF);
      assert.ok(stripF.includes('song.patch.slots.0.gain'), JSON.stringify(stripF));
      // under Lock the mini faders stay live (as the strips' levels and ON)
      await page.click(tid('v6-rb-chart'));
      await until(() => !!document.querySelector('[data-testid="v6-mini-on-0"]'));
      await ev(() => window.__rig.store.set('settings.performLock', true));
      const before = await ev(() => window.__rig.store.currentSong().patch.slots[0].muted === true);
      await page.click(tid('v6-mini-on-0'));
      await until((b) => (window.__rig.store.currentSong().patch.slots[0].muted === true) !== b, before);
      // the store → mini fader direction
      await ev(() => window.__rig.store.set(`songs.${window.__rig.store.currentSong().id}.patch.slots.0.gain`, 0.5));
      await until(() => /dB/.test(document.querySelector('[data-testid="v6-mini-fader-0"] .fader-value').textContent));
      await ev(() => window.__rig.store.set('settings.performLock', false));
      if (await ev(() => window.__rig.store.currentSong().patch.slots[0].muted === true)) {
        await page.click(tid('v6-mini-on-0'));
      }
    });

    // ------------------------------------------------------------------ text size
    await T('U7b text size: A / A steps 50…200, % → 100, Fit, ⌘+ / ⌘− / ⌘0, ⌘-scroll, pinch, readout, per place',
      async () => {
        await until(() => !!document.querySelector('[data-testid="v6-chart-stage"]'));
        const pct = async () => (await st()).pct;
        const steps = [];
        await page.click(tid('v6-chart-pct'));
        for (let i = 0; i < 5; i++) {
          await page.click(tid('v6-chart-bigger'));
          steps.push(await pct());
        }
        assert.deepEqual(steps, [110, 125, 150, 175, 200]);
        assert.equal(await page.isDisabled(tid('v6-chart-bigger')), true);
        assert.equal(await page.textContent(tid('v6-chart-readout')), 'Text 200%');
        assert.equal(await page.isVisible(tid('v6-chart-readout')), true);
        await page.click(tid('v6-chart-pct'));
        assert.equal(await pct(), 100);
        const down = [];
        for (let i = 0; i < 4; i++) {
          await page.click(tid('v6-chart-smaller'));
          down.push(await pct());
        }
        assert.deepEqual(down, [90, 75, 60, 50]);
        assert.equal(await page.isDisabled(tid('v6-chart-smaller')), true);
        assert.equal(await ev(() => parseFloat(getComputedStyle(document.querySelector('[data-testid="v6-chart-sheet"] '
          + '.chv-ly')).fontSize)), 12, '50 % of 24 px');
        // ⌘+ / ⌘− / ⌘0 (Ctrl on this Linux box; the handler takes either)
        await ev(() => document.activeElement?.blur());
        await page.keyboard.press('ControlOrMeta+Equal');
        assert.equal(await pct(), 60);
        await page.keyboard.press('ControlOrMeta+Equal');
        await page.keyboard.press('ControlOrMeta+Minus');
        assert.equal(await pct(), 60);
        await page.keyboard.press('ControlOrMeta+Digit0');
        assert.equal(await pct(), 100);
        // ⌘-scroll / a trackpad pinch (a wheel with a modifier) on the chart
        const cdp = await context.newCDPSession(page);
        const b = await page.locator(tid('v6-chart-body')).boundingBox();
        const wheel = (dy, modifiers) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: b.x + 200,
          y: b.y + 100, deltaX: 0, deltaY: dy, modifiers });
        await wheel(-120, 4); // Meta
        await until(() => window.__rig.views.chart.state().pct === 110);
        await wheel(120, 2); // Ctrl
        await until(() => window.__rig.views.chart.state().pct === 100);
        const y0 = await ev(() => document.querySelector('[data-testid="v6-chart-body"]').scrollTop);
        await wheel(120, 0); // a plain wheel scrolls, no size change
        await page.waitForTimeout(250);
        assert.equal(await pct(), 100);
        assert.ok((await ev(() => document.querySelector('[data-testid="v6-chart-body"]').scrollTop)) > y0);
        // a two-finger pinch on a touch screen (CDP touch events)
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        const touch = (type, d) => cdp.send('Input.dispatchTouchEvent', { type,
          touchPoints: type === 'touchEnd' ? [] : [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }] });
        await touch('touchStart', 40);
        for (const dd of [50, 60, 70, 80]) await touch('touchMove', dd);
        await touch('touchEnd', 0);
        const pinched = await pct();
        assert.ok(pinched > 100, `pinch out: ${pinched}`);
        assert.match(await page.textContent(tid('v6-chart-readout')), /^Text \d+%$/);
        await touch('touchStart', 80);
        for (const dd of [70, 60, 50, 40]) await touch('touchMove', dd);
        await touch('touchEnd', 0);
        assert.ok((await pct()) < pinched, 'pinch in');
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await cdp.detach();
        // Fit: the biggest step whose longest line fits — no line wraps at it, one does a step up
        await page.click(tid('v6-chart-fit'));
        const fitted = await pct();
        const wraps = () => ev(() => [...document.querySelectorAll('[data-testid="v6-chart-sheet"] .chv-line')]
          .some((l) => new Set([...l.children].map((c) => c.offsetTop)).size > 1));
        assert.ok(fitted < 200 && fitted >= 50, `fit ${fitted}`);
        assert.equal(await wraps(), false, `no line wraps at ${fitted}%`);
        await page.click(tid('v6-chart-bigger'));
        assert.equal(await wraps(), true, 'the longest line wraps a step up');
        await page.click(tid('v6-chart-fit'));
        assert.equal(await pct(), fitted);
        await page.click(tid('v6-chart-pct'));
        for (let i = 0; i < 3; i++) await page.click(tid('v6-chart-bigger'));
        assert.equal(await pct(), 150);
        assert.equal(await page.textContent(tid('v6-chart-readout')), 'Text 150%');
        await page.screenshot({ path: path.join(SHOTS, 'u7b-150-1280.png') });
        const stagePct = await pct();
        // per place: the sidebar keeps its own (75 %); both are stored on this device
        await ev(() => window.__rig.views.chart.setPlacement('side'));
        await until(() => window.__rig.views.chart.state().where === 'side');
        assert.equal(await pct(), 75);
        const p = await ev((k) => JSON.parse(localStorage.getItem(k)), PREFS);
        assert.deepEqual([p.pct, p.sidePct], [stagePct, 75]);
        // the text size, scroll and reading stay live under Lock
        await ev(() => window.__rig.store.set('settings.performLock', true));
        await page.click(tid('v6-chart-bigger'));
        assert.equal(await pct(), 90);
        await ev(() => window.__rig.store.set('settings.performLock', false));
        await page.click(tid('v6-chart-smaller'));
      });

    await T('U7b migration: today’s px index becomes the nearest percent once; today’s view keeps its index',
      async () => {
        await ev((k) => localStorage.setItem(k, JSON.stringify({ open: true, font: 5, speed: 5, mode: 'hear',
          placement: 'stage', stage: true })), PREFS); // font 5 = 40 px → 175 % (166.7 %)
        await reboot();
        await until(() => !!document.querySelector('[data-testid="v6-chart-stage"]'));
        assert.equal((await st()).pct, 175);
        let p = await ev((k) => JSON.parse(localStorage.getItem(k)), PREFS);
        assert.deepEqual([p.pct, p.font], [175, 5]);
        // once: a later change of today's index does not move the percent
        await ev((k) => localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k)), font: 0 })),
          PREFS);
        await reboot();
        assert.equal((await st()).pct, 175);
        // today's view (v6 off) reads its own index and keeps the v6 fields when it saves
        await ev(() => window.__rig.setUiV6(false));
        await until(() => !!document.querySelector('[data-testid="chart-toggle"]'), null, 20000);
        assert.equal(await ev(() => window.__rig.views.chart.state().font), 16);
        await page.click('[data-testid="chart-font-up"]');
        p = await ev((k) => JSON.parse(localStorage.getItem(k)), PREFS);
        assert.deepEqual([p.font, p.pct, p.placement], [1, 175, 'stage']);
        await ev(() => window.__rig.setUiV6(true));
        await bothOn();
        await ev(() => window.__rig.views.chart.panel.reset());
      });

    // ------------------------------------------------------------------ scrolling
    await T('U7b auto-scroll with speed, section jumps and the reading line', async () => {
      await until(() => !!document.querySelector('[data-testid="v6-chart-stage"]'));
      await setSong();
      const jumps = (await st()).jumps;
      assert.deepEqual(jumps, ['V1', 'C', 'V2', 'C', 'B', 'C']);
      await page.click(`${tid('v6-chart-jumps')} [data-sec="4"]`);
      await until(() => window.__rig.views.chart.state().section === 4);
      assert.equal(await ev(() => document.querySelector('[data-testid="v6-chart-jumps"] [data-sec="4"]')
        .classList.contains('on')), true);
      assert.equal(await ev(() => document.querySelector('.v6-ch-sheet section.cur h3')?.textContent), 'Bridge');
      // the lit line is the one at the reading line
      const r = await ev(() => {
        const now = document.querySelector('.v6-ch-sheet .now');
        const line = now.getBoundingClientRect();
        const rl = document.querySelector('[data-testid="v6-chart-readline"]').getBoundingClientRect();
        const b = document.querySelector('[data-testid="v6-chart-body"]');
        return { top: line.top, bottom: line.bottom, y: rl.top, off: now.offsetTop, st: b.scrollTop, ch: b.clientHeight,
          bt: b.getBoundingClientRect().top, op: now.offsetParent?.className, max: b.scrollHeight - b.clientHeight };
      });
      assert.ok(r.top <= r.y + 2 && r.bottom >= r.y - 30, JSON.stringify(r));
      await page.click(`${tid('v6-chart-jumps')} [data-sec="0"]`);
      await until(() => window.__rig.views.chart.state().section === 0);
      await page.click(tid('v6-chart-faster'));
      await page.click(tid('v6-chart-faster'));
      assert.equal(await page.textContent(tid('v6-chart-speed')), '1.25×');
      await ev(() => window.__rig.store.set('song.tempo', 300));
      const y0 = await ev(() => document.querySelector('[data-testid="v6-chart-body"]').scrollTop);
      await page.click(tid('v6-chart-auto'));
      assert.equal(await page.getAttribute(tid('v6-chart-auto'), 'aria-pressed'), 'true');
      await until((y) => document.querySelector('[data-testid="v6-chart-body"]').scrollTop > y + 20, y0, 10000);
      await page.click(tid('v6-chart-auto'));
      const y1 = await ev(() => document.querySelector('[data-testid="v6-chart-body"]').scrollTop);
      await page.waitForTimeout(400);
      assert.equal(await ev(() => document.querySelector('[data-testid="v6-chart-body"]').scrollTop), y1, 'stopped');
      await page.click(tid('v6-chart-slower'));
      await page.click(tid('v6-chart-slower'));
    });

    // ------------------------------------------------------------------ Edit chart
    await T('U7b Edit chart: source left, live preview right, status line, offers unticked, Save', async () => {
      await page.click(tid('v6-chart-edit'));
      await until(() => !!document.querySelector('[data-testid="v6-chart-editor"]'));
      assert.equal(await page.inputValue(tid('v6-ce-text')), CHART);
      await until(() => /Written in G · shown in C \(the song’s key\) · 0 problems/
        .test(document.querySelector('[data-testid="v6-ce-status"]').textContent));
      assert.equal(await page.getAttribute(tid('v6-ce-fmt-chordpro'), 'aria-pressed'), 'true');
      const offers = await ev(() => [...document.querySelectorAll('[data-testid="v6-chart-editor"] [data-offer]')]
        .map((b) => [b.dataset.offer, b.checked]));
      assert.ok(offers.some(([f]) => f === 'name') && offers.every(([, c]) => !c), JSON.stringify(offers));
      await page.screenshot({ path: path.join(SHOTS, 'u7b-edit-1280.png') });
      // type: the preview follows
      await page.focus(tid('v6-ce-text'));
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.type('\n{c: Tag}\n[Am]Last tile [F]counted');
      await until(() => [...document.querySelectorAll('[data-testid="v6-ce-psheet"] .chv-ch')]
        .some((c) => c.textContent.trim() === 'Dm'));
      // a problem counts in the status line ("x2" on its own line is not a chord)
      const name0 = await ev(() => window.__rig.store.currentSong().name);
      await page.click(tid('v6-ce-save'));
      await until(() => !document.querySelector('[data-testid="v6-chart-editor"]'));
      const s = await ev(() => window.__rig.store.currentSong());
      assert.ok(s.chart.text.endsWith('[Am]Last tile [F]counted'));
      assert.equal(s.chart.format, 'chordpro');
      assert.equal(s.name, name0, 'the title was offered, not ticked');
      await until(() => [...document.querySelectorAll('[data-testid="v6-chart-sheet"] .chv-ch')]
        .some((c) => c.textContent.trim() === 'Dm'));
    });

    await T('U7b Edit chart: Cancel and Esc discard (no Panic); Remove needs a second tap; Add a chart', async () => {
      await ev(() => {
        window.__panics = 0;
        window.__rig.controller.addEventListener('action', (e) => {
          if (e.detail?.type === 'panic') window.__panics += 1;
        });
      });
      const before = await ev(() => window.__rig.store.currentSong().chart.text);
      await page.click(tid('v6-chart-edit'));
      await until(() => !!document.querySelector('[data-testid="v6-chart-editor"]'));
      await page.fill(tid('v6-ce-text'), '[G]Thrown away');
      await page.click(tid('v6-ce-cancel'));
      await until(() => !document.querySelector('[data-testid="v6-chart-editor"]'));
      assert.equal(await ev(() => window.__rig.store.currentSong().chart.text), before);
      await page.click(tid('v6-chart-edit'));
      await until(() => !!document.querySelector('[data-testid="v6-chart-editor"]'));
      await page.fill(tid('v6-ce-text'), '[G]Thrown away too');
      await page.keyboard.press('Escape');
      await until(() => !document.querySelector('[data-testid="v6-chart-editor"]'));
      assert.equal(await ev(() => window.__rig.store.currentSong().chart.text), before);
      assert.equal(await ev(() => window.__panics), 0, 'Esc closed the dialog, no Panic');
      // the "chords over words" format reads the same text differently
      await page.click(tid('v6-chart-edit'));
      await until(() => !!document.querySelector('[data-testid="v6-chart-editor"]'));
      await page.click(tid('v6-ce-fmt-plain'));
      assert.equal(await page.getAttribute(tid('v6-ce-fmt-plain'), 'aria-pressed'), 'true');
      await page.click(tid('v6-ce-fmt-chordpro'));
      // Remove: a second tap within 3 s
      await page.click(tid('v6-ce-remove'));
      assert.equal(await page.textContent(tid('v6-ce-remove')), 'Remove? Tap again');
      assert.ok(await ev(() => !!window.__rig.store.currentSong().chart));
      await page.click(tid('v6-ce-remove'));
      await until(() => !window.__rig.store.currentSong().chart);
      await until(() => !document.querySelector('[data-testid="v6-chart-empty"]').hidden);
      // Add a chart: the same dialog, empty; an unkeyed chart asks "written in" (default: the song's key)
      await page.click(tid('v6-chart-add'));
      await until(() => !!document.querySelector('[data-testid="v6-chart-editor"]'));
      assert.equal(await ev(() => document.querySelector('[data-testid="v6-chart-editor"]').getAttribute('aria-label')),
        'Add a chart');
      await page.fill(tid('v6-ce-text'), '{c: Verse}\n[C]Plain [F]start [G]here');
      await until(() => !!document.querySelector('[data-testid="v6-chart-editor"] [data-testid="chart-written-in"]'));
      await page.click(tid('v6-ce-save'));
      await until(() => !document.querySelector('[data-testid="v6-chart-editor"]'));
      const ch = await ev(() => window.__rig.store.currentSong().chart);
      assert.equal(ch.key, 'C');
      await setSong();
    });

    await T('U7b Lock: Edit chart refused (button off, an open dialog closes, nothing saved); reading stays live',
      async () => {
        await page.click(tid('v6-chart-edit'));
        await until(() => !!document.querySelector('[data-testid="v6-chart-editor"]'));
        await page.fill(tid('v6-ce-text'), '[G]Lock test');
        await ev(() => window.__rig.store.set('settings.performLock', true));
        await until(() => !document.querySelector('[data-testid="v6-chart-editor"]'));
        assert.equal(await ev(() => window.__rig.store.currentSong().chart.text), CHART);
        assert.equal(await page.isDisabled(tid('v6-chart-edit')), true);
        assert.equal(await ev(async () => !!(await window.__rig.views.chart.openEdit())), false);
        for (const t of ['v6-chart-hear', 'v6-chart-bigger', 'v6-chart-auto', 'v6-chart-place']) {
          assert.equal(await page.isDisabled(tid(t)), false, t);
        }
        await ev(() => window.__rig.store.set('settings.performLock', false));
        await until(() => !document.querySelector('[data-testid="v6-chart-edit"]').disabled);
      });

    await T('U7b contrast ≥ 4.5:1 for the v6 chart’s text on every theme (sheet, header, jumps, mini names)',
      async () => {
        await ev(() => window.__rig.views.chart.setPlacement('stage'));
        await until(() => !!document.querySelector('[data-testid="v6-chart-stage"]'));
        const was = await ev(() => window.__rig.theme.current);
        const ids = await ev(() => import('/js/shared/themes.js').then((m) => m.pickableThemes().map((t) => t.id)));
        assert.ok(ids.length >= 8, `themes: ${ids}`);
        const low = [];
        for (const id of ids) {
          await ev((t) => window.__rig.theme.apply(t), id);
          await page.waitForTimeout(250);
          await ev(() => window.__rig.views.chart.panel.reset());
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
            const ratio = (el) => {
              const fg = rgb(getComputedStyle(el).color);
              const b = bg(el);
              const f = fg.slice(0, 3).map((v, i) => v * fg[3] + b[i] * (1 - fg[3]));
              const [hi, lo] = [lum(f), lum(b)].sort((x, y) => y - x);
              return (hi + 0.05) / (lo + 0.05);
            };
            const out = {};
            for (const sel of ['.chv-ly', '.chv-ch', '.chv-sec-h', '.chv-sec.cur .chv-sec-h', '.v6-ch-key',
              '.v6-ch-key em', '.v6-ch-title', '.v6-ts-n', '.v6-ch-jp', '.v6-mini-nm']) {
              const el = document.querySelector(`[data-testid="v6-chart-stage-host"] ${sel}`);
              if (el) out[sel] = +ratio(el).toFixed(2);
            }
            return out;
          });
          for (const [sel, v] of Object.entries(r)) if (v < 4.5) low.push(`${id} ${sel} ${v}`);
          assert.ok(Object.keys(r).length >= 9, JSON.stringify(r));
        }
        await ev((t) => window.__rig.theme.apply(t), was);
        await page.waitForTimeout(250);
        assert.deepEqual(low, []);
      });

    // ------------------------------------------------------------------ iPad
    await T('U7b iPad landscape (1180 × 820) = the Mac layout; portrait (820 × 1180) = music stand; 1024 × 700',
      async () => {
      await ev(() => window.__rig.views.chart.setPlacement('stage'));
      await page.setViewportSize({ width: 1180, height: 820 });
      await until(() => !!document.querySelector('.v6-minis.cols'));
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOTS, 'u7b-stage-1180.png') });
      await page.setViewportSize({ width: 820, height: 1180 });
      await until(() => !!document.querySelector('.v6-minis.row'));
      const r = await ev(() => {
        const box = (s) => document.querySelector(s)?.getBoundingClientRect();
        const vis = (s) => {
          const e = document.querySelector(s);
          return !!e && getComputedStyle(e).display !== 'none';
        };
        return { minis: box('.v6-minis').bottom, chart: box('[data-testid="v6-chart-stage"]').top,
          left: vis('.v6-board > .v6-left'), side: vis('.v6-board > .v6-side'),
          page: document.documentElement.scrollWidth };
      });
      assert.ok(r.minis <= r.chart + 1, 'the faders sit above the chart');
      assert.deepEqual([r.left, r.side], [false, false]);
      assert.ok(r.page <= 820, `no sideways page scroll (${r.page})`);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOTS, 'u7b-stage-820.png') });
      // the Mac's smallest window (1024 × 700): the stage's tools keep one row, nothing spills sideways
      await page.setViewportSize({ width: 1024, height: 700 });
      await until(() => !!document.querySelector('.v6-minis.cols'));
      await page.waitForTimeout(300);
      const fit = await ev(() => {
        const r1 = document.querySelector('[data-testid="v6-chart-stage"] .v6-ch-r1');
        const mids = [...r1.querySelectorAll('.v6-ch-grp > *')].map((e) => {
          const r = e.getBoundingClientRect();
          return r.top + r.height / 2;
        });
        return { over: r1.scrollWidth - r1.clientWidth, rows: Math.max(...mids) - Math.min(...mids) < 10 ? 1 : 2,
          page: document.documentElement.scrollWidth };
      });
      assert.deepEqual([fit.over <= 1, fit.rows, fit.page <= 1024], [true, 1, true], JSON.stringify(fit));
      await page.click(tid('v6-chart-strips'));
      await until(() => !document.querySelector('.v6-chstage'));
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.click(tid('v6-rb-chart'));
      await until(() => !!document.querySelector('.v6-minis.cols'));
    });

    await T('U7b screenshots: 1280 × 800 Sanctuary, sidebar', async () => {
      await ev(() => window.__rig.views.chart.setPlacement('side'));
      await until(() => !!document.querySelector('[data-testid="v6-chart-side"]'));
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOTS, 'u7b-sidebar-1280.png') });
    });

    // ------------------------------------------------------------------ flips
    await T('U7b flips: chart off → the module and everything of it go (its place kept); v6 off → today’s view',
      async () => {
        await ev(() => window.__rig.setChartView(false));
        const r = await ev(() => ({
          chart: window.__rig.views.chart,
          mods: window.__rig.views.v6.sidebar.modules,
          dom: document.querySelectorAll('[data-testid^="v6-chart"], [data-testid="v6-rb-chart"], .v6-chstage, '
            + 'link[data-chart-css], link[data-v6-chart-css], .v6-board.v6-chart-on').length,
          order: JSON.parse(localStorage.getItem('worship-rig.v6.sidebar')).order,
          tab: window.__rig.views.v6.sidebar.mounted,
        }));
        assert.equal(r.chart, null);
        assert.deepEqual(r.mods, ['drone', 'setlist', 'notes', 'metronome']);
        assert.equal(r.dom, 0);
        assert.ok(r.order.includes('chart'), 'its place in the layout is kept');
        assert.notEqual(r.tab, 'chart');
        await ev(() => window.__rig.setChartView(true));
        await bothOn();
        await until(() => !!document.querySelector('[data-testid="v6-chart-side"]'));
        // v6 off with the chart on: today's chart view, nothing of the v6 chart
        await ev(() => window.__rig.setUiV6(false));
        await until(() => !!document.querySelector('[data-testid="chart-toggle"]'), null, 20000);
        assert.equal(await ev(() => document.querySelectorAll('[data-testid^="v6-chart"], link[data-v6-chart-css]')
          .length), 0);
        assert.equal(await ev(() => window.__rig.views.chart.state().v6 ?? false), false);
        await ev(() => window.__rig.setUiV6(true));
        await bothOn();
        await until(() => !document.querySelector('[data-testid="chart-toggle"]'));
        // the v6 Edit's Chart button opens it on Perform
        await page.click(tid('v6-sb-tab-drone'));
        await ev(() => window.__rig.ctx.setView('edit'));
        await until(() => window.__rig.store.get().settings.view === 'edit');
        await until(() => !!document.querySelector('[data-testid="v6e-chart"]:not([hidden])'));
        await page.click(tid('v6e-chart'));
        await until(() => window.__rig.store.get().settings.view === 'perform');
        await until(() => !!document.querySelector('[data-testid="v6-chart-side"]'));
        // the Notes module's Chart button is live with the flag on
        await page.click(tid('v6-sb-tab-notes'));
        await page.click(tid('v6-notes-chart'));
        await until(() => !!document.querySelector('[data-testid="v6-chart-side"]'));
      });

    // ------------------------------------------------------------------ skeptic UI6-U7b
    await T('U7b skeptic F1: a tap on the chart leaves nothing focused (Space = pedal, Esc = Panic); Tab still scrolls',
      async () => {
        await ev(() => window.__rig.views.chart.setPlacement('stage'));
        await until(() => !!document.querySelector('[data-testid="v6-chart-stage"]'));
        await setSong();
        const body = `${tid('v6-chart-stage')} ${tid('v6-chart-body')}`;
        const b = await page.locator(body).boundingBox();
        await page.mouse.click(b.x + 120, b.y + 80);
        await page.waitForTimeout(50);
        assert.equal(await ev(() => document.activeElement?.dataset?.testid ?? null), null, 'the chart let go');
        const y0 = await ev((s) => document.querySelector(s).scrollTop, body);
        await page.keyboard.down('Space');
        await until(() => window.__rig.controller.status.pedal === true, null, 3000);
        await page.keyboard.up('Space');
        await until(() => window.__rig.controller.status.pedal === false, null, 3000);
        assert.equal(await ev((s) => document.querySelector(s).scrollTop, body), y0, 'Space did not page the chart');
        await ev(() => {
          window.__u7bPanics = 0;
          window.__rig.controller.on('action', (a) => {
            if (a && (a.type === 'panic' || a.action === 'panic')) window.__u7bPanics++;
          });
        });
        await page.mouse.click(b.x + 120, b.y + 80);
        await page.keyboard.press('Escape');
        await until(() => window.__u7bPanics === 1, null, 3000);
        // the keyboard path is kept: focused from the keyboard, ↓ scrolls the chart (not the mod wheel)
        await page.keyboard.press('Shift');
        await ev((s) => document.querySelector(s).focus(), body);
        assert.equal(await ev(() => document.activeElement?.dataset?.testid), 'v6-chart-body');
        await page.keyboard.press('ArrowDown');
        assert.ok((await ev((s) => document.querySelector(s).scrollTop, body)) > y0, '↓ scrolls the focused chart');
        await ev(() => document.activeElement?.blur());
      });

    await T('U7b skeptic F2: a hand on a mini fader plus a finger scrolling the chart is not a pinch', async () => {
      await page.setViewportSize({ width: 1180, height: 820 });
      await until(() => !!document.querySelector('.v6-minis.cols [data-testid="v6-mini-fader-0"]'));
      await page.waitForTimeout(200);
      const pct0 = (await st()).pct;
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      try {
        const f = await page.locator(tid('v6-mini-fader-0')).boundingBox();
        const b = await page.locator(`${tid('v6-chart-stage')} ${tid('v6-chart-body')}`).boundingBox();
        const fx = f.x + f.width / 2;
        const fy = f.y + f.height / 2;
        const T2 = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
        await T2('touchStart', [{ x: fx, y: fy, id: 1 }]);
        await T2('touchStart', [{ x: fx, y: fy, id: 1 }, { x: b.x + 40, y: fy, id: 2 }]);
        for (let k = 1; k <= 8; k++) {
          await T2('touchMove', [{ x: fx, y: fy - k, id: 1 }, { x: b.x + 40, y: fy + k * 40, id: 2 }]);
        }
        await T2('touchEnd', []);
        await page.waitForTimeout(150);
        assert.equal((await st()).pct, pct0, 'the text size stays');
        // a real pinch on the chart still steps it
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        await T2('touchStart', [{ x: cx - 40, y: cy, id: 1 }, { x: cx + 40, y: cy, id: 2 }]);
        for (const dd of [50, 60, 70, 80]) {
          await T2('touchMove', [{ x: cx - dd, y: cy, id: 1 }, { x: cx + dd, y: cy, id: 2 }]);
        }
        await T2('touchEnd', []);
        assert.ok((await st()).pct > pct0, 'pinch out on the chart');
      } finally {
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await cdp.detach();
        await ev(() => window.__rig.views.chart.panel.reset());
        await page.setViewportSize({ width: 1280, height: 800 });
      }
    });

    await T('U7b skeptic F3: Edit chart over the size cap shows no preview (and can’t be saved)', async () => {
      await ev(() => window.__rig.views.chart.openEdit());
      await until(() => !!document.querySelector('[data-testid="v6-ce-text"]'));
      const r = await ev(() => new Promise((res) => {
        const ta = document.querySelector('[data-testid="v6-ce-text"]');
        const line = '[G]Counting every tile along the [D/F#]corridor of the hall\n';
        ta.value = line.repeat(Math.ceil(70000 / line.length));
        ta.dispatchEvent(new Event('input'));
        setTimeout(() => res({
          lines: document.querySelectorAll('[data-testid="v6-ce-psheet"] .chv-line').length,
          save: document.querySelector('[data-testid="v6-ce-save"]').disabled,
          err: document.querySelector('[data-testid="v6-chart-editor"] [data-testid="chart-error"]').textContent,
          empty: document.querySelector('.v6-ce-pempty').textContent,
        }), 350);
      }));
      assert.equal(r.lines, 0, 'nothing drawn');
      assert.equal(r.save, true, 'Save off');
      assert.match(r.err, /too large/);
      assert.match(r.empty, /Too large to show/);
      await page.click(tid('v6-ce-cancel'));
      await until(() => !document.querySelector('[data-testid="v6-chart-editor"]'));
    });

    await T('U7b skeptic F4: a chart set on a trial song (Try it) says it is not saved yet', async () => {
      const id = await ev(() => {
        const { store } = window.__rig;
        const song = JSON.parse(JSON.stringify(store.currentSong()));
        delete song.id;
        song.name = 'Trial Tiles';
        delete song.chart;
        const r = store.startTrial({ packId: 'u7b-test:trial.json', hash: 'u7b1', mode: 'bank', song });
        store.set('settings.currentSongId', r.id);
        return r.id;
      });
      await until((i) => window.__rig.views.chart.state().songId === i, id);
      await ev(() => window.__rig.views.chart.openEdit());
      await until(() => !!document.querySelector('[data-testid="v6-ce-text"]'));
      assert.match(await page.textContent('.v6-ce-h'), /trying this song: Keep it to save the chart/);
      await page.fill(tid('v6-ce-text'), '{key: G}\n[G]Tried [C]words');
      await page.waitForTimeout(350);
      await page.click(tid('v6-ce-save'));
      await until(() => !document.querySelector('[data-testid="v6-chart-editor"]'));
      assert.match(await page.textContent('#toasts'), /Chart set for this try\. Keep it to save it/);
      assert.ok(!/Tried \[C\]words/.test(await ev(() => window.__rig.store.exportJSON())), 'not in the library');
      await ev(() => {
        const { store } = window.__rig;
        const back = store.songsInOrder()[0].id;
        const trial = store.get().settings.currentSongId;
        store.set('settings.currentSongId', back);
        store.endTrial(trial);
      });
    });

    await T('U7b zero console.error, no HTTP ≥ 400', async () => {
      assert.deepEqual(errors, []);
    });
  } finally {
    await context.close();
  }
}

/** Boot `base` with the v6 Perform on and the chart off; what the purity check compares (as ui-v6's purityBoot). */
async function v6PurityBoot(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await pinTheme(context, 'sanctuary');
  await context.grantPermissions([...MIDI_PERMISSIONS], { origin: base });
  await context.addInitScript(() => {
    const p = { ael: {}, intervals: 0 };
    window.__probe = p;
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, ...a) {
      const who = this === window ? 'w' : this === document ? 'd' : null;
      if (who) p.ael[`${who}:${type}`] = (p.ael[`${who}:${type}`] || 0) + 1;
      return add.call(this, type, ...a);
    };
    const si = window.setInterval;
    window.setInterval = function (...a) {
      p.intervals += 1;
      return si.apply(this, a);
    };
  });
  await context.route('**/js/store.js', async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace('const listeners = new Set();',
      'const listeners = new Set(); globalThis.__storeListeners = listeners;');
    await route.fulfill({ response: res, body });
  });
  const page = await context.newPage();
  const reqs = new Set();
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!/\/samples\/|\.(mp3|wav|ogg|m4a|flac)(\?|$)/i.test(u.pathname)) reqs.add(u.pathname);
  });
  try {
    await page.goto(`${base}/?ui6=1`);
    await waitRigReady(page, { timeout: 40000 });
    await page.waitForFunction(() => !!window.__rig.views.v6 && !!window.__rig.views.settings, null,
      { timeout: 30000, polling: 100 });
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => {
      const shape = (el) => {
        const tid = el.getAttribute('data-testid');
        const id = el.id.replace(/-[a-z0-9]{6}$/, '-*').replace(/\d+/g, '#');
        return `${el.tagName.toLowerCase()}${id ? `#${id}` : ''}${tid ? `[${tid}]` : ''}`;
      };
      return {
        ael: window.__probe.ael,
        intervals: window.__probe.intervals,
        store: window.__storeListeners ? window.__storeListeners.size : null,
        dom: [...document.body.querySelectorAll('*')].filter((e) => !e.closest('#toasts > *')).map(shape).join('\n'),
        // (styles-v6-settings.css is linked by an absolute URL: its origin differs between the two servers)
        css: [...document.querySelectorAll('link[rel=stylesheet]')]
          .map((l) => new URL(l.getAttribute('href'), location.href).pathname),
      };
    });
    return { ...r, reqs: [...reqs].sort() };
  } finally {
    await context.close();
  }
}
