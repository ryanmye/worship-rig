// UI v6 U8b: shoot and contrast-audit every v6 screen in every theme (native/docs/lanes/UI6-build-plan.md U8). The
// measuring is tools/themes/audit-lib.mjs (the same code as shoot.mjs, today's screens), with its non-text half on:
// text 4.5 / 3 large, focus rings and textless control boundaries 3 (WCAG 1.4.3 / 1.4.11).
// Used by the CLI (tools/themes/shoot-v6.mjs) and the ui-v6-themes suite (test/phase2/ui-v6-themes/run.mjs).
//
// One fresh browser context per theme, 1280 × 800, the theme pinned before boot the way the app stores it (mirror +
// settings.theme), settings.uiV6 on; a temp My Samples folder with one bank pack (two invented songs) so the Song bank
// has something to browse and try. The states (STATES below) are visited in order; each one is shot, audited and left.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from './audit-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { THEMES, byId } = await import(path.join(ROOT, 'app/js/shared/themes.js'));
const { blankSong } = await import(path.join(ROOT, 'app/js/presets.js'));
const { defaultSlot } = await import(path.join(ROOT, 'app/js/shared/params.js'));
const { MIDI_PERMISSIONS, pinTheme } = await import(path.join(ROOT, 'test/integration/lib.mjs'));

/** The instruments the 2- and 7-instrument shots use (the ui-v6 suite's screenshot set). */
const INSTRUMENTS = [['sampler', 'salamander-piano'], ['synth', 'warm-pad'], ['synth', 'sub-bass'],
  ['synth', 'strings'], ['sampler', 'ep-rhodes'], ['synth', 'square-lead'], ['organ', 'church']];
// written for this audit (never real lyrics)
const CHART = ['{title: Tile Counter}', '{key: G}', '{c: Verse 1}', '[G]Counting every [D/F#]tile along the [Em]hall',
  '[Em]Steady [C]feet and [D]slow', '{soc}', '[C]Count a[G]gain, [D]count a[Em]gain', '{eoc}', '{c: Bridge}',
  '[Em]Nothing [C]holds', '{chorus}'].join('\n');
const NOTES = 'Intro: pad only, 4 bars.\nVerse 1: piano in, soft.\nChorus: full, bass up.\nEnd on the drone.';

/** A temp My Samples folder with one bank pack (invented songs, built-in instruments). */
function bankFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-u8b-'));
  const pack = path.join(dir, 'Samples', 'audit-pack');
  fs.mkdirSync(path.join(pack, 'songs'), { recursive: true });
  fs.writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({ mode: 'bank', name: 'Audit pack' }));
  const song = (name, pc, tempo, inst) => {
    const s = blankSong({ name, playIn: pc, hearIn: pc, tempo });
    s.patch.slots = inst.map((k, i) => defaultSlot(i, { type: INSTRUMENTS[k][0], id: INSTRUMENTS[k][1] }));
    return s;
  };
  const songs = [
    ['lantern.json', song('Lantern Hymn', 3, 68, [0, 1, 3]), { title: 'Lantern Hymn', artist: 'Northgate Testers',
      originalKey: 'Eb', bpm: 68, timeSig: '6/8', tags: ['hymn', 'gentle'] }],
    ['harbour.json', song('Harbour Light', 7, 128, [4, 5, 2]), { title: 'Harbour Light', artist: 'River Testhall',
      originalKey: 'G', bpm: 128, tags: ['upbeat'] }],
  ];
  for (const [f, s, bank] of songs) {
    fs.writeFileSync(path.join(pack, 'songs', f), JSON.stringify({ app: 'worship-rig', kind: 'song', schema: 2, song: s,
      bank }));
  }
  return { root: path.join(dir, 'Samples'), first: 'audit-pack:lantern.json', cleanup: () => fs.rmSync(dir,
    { recursive: true, force: true }) };
}

// ------------------------------------------------------------------------------------------------ page helpers
const tid = (id) => `[data-testid="${id}"]`;
const mk = (page) => {
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const until = (fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });
  const settled = () => until(() => {
    const { controller, store } = window.__rig;
    return controller.status.songId === store.get().settings.currentSongId && !controller.status.loading;
  }, null, 240000);
  const setSlots = (n) => ev(({ n: count, list }) => {
    const { store } = window.__rig;
    const id = store.currentSong().id;
    while (store.currentSong().patch.slots.length < count) store.addSlot(id);
    while (store.currentSong().patch.slots.length > count) store.removeSlot(id);
    list.slice(0, count).forEach(([type, iid], i) => {
      const ref = { type, id: iid };
      if (store.currentSong().patch.slots[i]) store.set(`songs.${id}.patch.slots.${i}.instrument`, ref);
      else store.set(`songs.${id}.patch.slots.${i}`, { instrument: ref });
    });
  }, { n, list: INSTRUMENTS });
  const hold = () => ev(() => {
    const p = window.__rig.controller.perform;
    for (const n of [48, 55, 60, 64, 67]) p.noteOn(n, 100);
  });
  const release = () => ev(() => window.__rig.controller.perform.releaseAll());
  const toPerform = async () => {
    await ev(() => {
      window.__rig.ctx.closeSettings?.();
      window.__rig.ctx.setView('perform');
    });
    await until(() => document.body.dataset.view === 'perform');
  };
  const toEdit = async (block) => {
    await ev(() => window.__rig.ctx.setView('edit'));
    await until(() => document.body.dataset.view === 'edit' && !!window.__rig.views.edit?._debug?.v6);
    if (block) await ev((b) => window.__rig.views.edit.editState.select(b), block);
    await page.waitForTimeout(300);
  };
  const editCat = async (cat) => {
    await page.click(tid(`v6e-cat-${cat}`));
    await until((c) => document.querySelector('[data-testid="v6e-ccont"]')?.dataset.cat === c, cat);
  };
  const esc = () => page.keyboard.press('Escape');
  return { ev, until, settled, setSlots, hold, release, toPerform, toEdit, editCat, esc };
};

/**
 * The states, in visiting order. `enter` puts the page in the state (throws = the state is reported as not reached),
 * `leave` puts it back. `group` picks the contact sheet's tile.
 * @type {Array<{id:string, enter:(p:object, x:object)=>Promise<void>, leave?:(p:object, x:object)=>Promise<void>}>}
 */
export const STATES = [
  // ---- Perform, 2 instruments, the sidebar on each module (held notes: lit keys, meters)
  { id: 'perform-2', enter: async (p, x) => {
    await x.setSlots(2);
    await x.ev(() => window.__rig.views.v6.sidebar.open('drone'));
    await x.hold();
    await p.waitForTimeout(700);
  } },
  { id: 'perform-2-setlist', enter: async (p, x) => x.ev(() => window.__rig.views.v6.sidebar.open('setlist')) },
  { id: 'perform-2-notes', enter: async (p, x) => x.ev(() => window.__rig.views.v6.sidebar.open('notes')) },
  { id: 'perform-2-click', enter: async (p, x) => x.ev(() => window.__rig.views.v6.sidebar.open('metronome')),
    leave: async (p, x) => x.release() },
  // ---- 7 instruments (scroll + name pills), then the rail folded
  { id: 'perform-7', enter: async (p, x) => {
    await x.setSlots(7);
    await x.ev(() => window.__rig.views.v6.sidebar.open('drone'));
    await x.settled();
  } },
  // the strips scrolled to the end (positions 5 and 6 out from under the edge fade), one muted (the OFF tile)
  { id: 'perform-7-end', enter: async (p, x) => {
    await x.ev(() => {
      const { store } = window.__rig;
      store.set(`songs.${store.currentSong().id}.patch.slots.3.muted`, true);
      document.querySelector('[data-testid="v6-strips"]').scrollLeft = 1e5;
    });
    await p.waitForTimeout(400);
  }, leave: async (p, x) => x.ev(() => {
    const { store } = window.__rig;
    store.set(`songs.${store.currentSong().id}.patch.slots.3.muted`, false);
    document.querySelector('[data-testid="v6-strips"]').scrollLeft = 0;
  }) },
  { id: 'perform-7-rail', enter: async (p, x) => x.ev(() => window.__rig.views.v6.sidebar.collapse()),
    leave: async (p, x) => x.ev(() => window.__rig.views.v6.sidebar.open('drone')) },
  { id: 'quick', enter: async (p) => p.click(tid('v6-quick')), leave: async (p, x) => x.ev(() => window.__rig.views.v6.closeQuick()) },
  { id: 'range-pick', enter: async (p, x) => x.ev(() => window.__rig.views.v6.kb.pick(0)),
    leave: async (p, x) => x.ev(() => window.__rig.views.v6.kb.pick(null)) },
  { id: 'more-menu', enter: async (p) => p.click(tid('v6-more-0')), leave: async (p, x) => x.esc() },
  { id: 'space-pop', enter: async (p) => p.click(tid('v6-space')), leave: async (p, x) => x.esc() },
  { id: 'add-song', enter: async (p, x) => {
    await x.ev(() => window.__rig.views.v6.sidebar.open('setlist'));
    await p.click(tid('v6-sl-add'));
    await x.until(() => !!document.querySelector('[data-testid="v6-addsong"]'));
  }, leave: async (p, x) => {
    await x.esc();
    await x.ev(() => window.__rig.views.v6.sidebar.open('drone'));
  } },
  { id: 'arrange', enter: async (p, x) => {
    await x.setSlots(3);
    await x.ev(() => window.__rig.views.v6.arrange.enter());
    await x.until(() => window.__rig.views.v6.arrange.active);
  }, leave: async (p, x) => x.ev(() => window.__rig.views.v6.arrange.exit()) },
  { id: 'learn', enter: async (p, x) => {
    // one learned control, so a badge shows too
    await x.ev(() => window.__rig.store.set('settings.midiLearn', { 'slots.1.gain': { cc: 21, channel: 0 } }));
    await x.ev(() => window.__rig.views.v6.learn.enter());
    await x.until(() => window.__rig.views.v6.learn.active);
  }, leave: async (p, x) => {
    await x.ev(() => window.__rig.views.v6.learn.exit());
    await x.ev(() => window.__rig.store.set('settings.midiLearn', {}));
  } },
  { id: 'save-snapshot', enter: async (p, x) => {
    await p.click(tid('v6-snap-save'));
    await x.until(() => !!document.querySelector('[data-testid="v6-savesnap"]'));
  }, leave: async (p, x) => x.esc() },
  { id: 'song-menu', enter: async (p, x) => {
    await p.click(tid('v6-songmenu-btn'));
    await x.until(() => !!document.querySelector('[data-testid="v6-songmenu"]'));
  }, leave: async (p, x) => x.esc() },
  { id: 'locked', enter: async (p, x) => x.ev(() => window.__rig.store.set('settings.performLock', true)),
    leave: async (p, x) => x.ev(() => window.__rig.store.set('settings.performLock', false)) },
  // ---- the Song bank: browse, then try (the banner)
  { id: 'bank', enter: async (p, x, f) => {
    await x.ev(() => window.__rig.views.v6.openBank());
    await x.until(() => window.__rig.views.v6.bank?.isOpen === true);
    await x.ev((id) => window.__rig.views.v6.bank.select(id), f.first);
    await p.waitForTimeout(300);
  } },
  { id: 'bank-trying', enter: async (p, x) => {
    await p.click(tid('v6-bank-try'));
    await x.until(() => window.__rig.controller.trial()?.playing === true, null, 60000);
    await x.settled();
  }, leave: async (p, x) => {
    await p.click(tid('v6-try-back'));
    await x.until(() => !window.__rig.controller.trial());
    await x.settled();
  } },
  // ---- Edit
  { id: 'edit-sound', enter: async (p, x) => {
    await x.setSlots(3);
    await x.toEdit('slot:0');
    await x.editCat('sound');
  } },
  { id: 'edit-range', enter: async (p, x) => x.editCat('range') },
  { id: 'edit-eq', enter: async (p, x) => {
    await x.editCat('eq');
    await p.waitForSelector('#view-edit .eqk', { timeout: 20000 });
    await p.waitForTimeout(400);
  } },
  { id: 'edit-chooser', enter: async (p, x) => {
    await x.editCat('sound');
    await p.click(tid('v6e-change'));
    await x.until(() => !!document.querySelector('[data-testid="v6e-chooser"]'));
  }, leave: async (p, x) => {
    await x.esc();
    await x.until(() => !document.querySelector('[data-testid="v6e-chooser"]'));
  } },
  { id: 'edit-drone', enter: async (p, x) => x.toEdit('drone') },
  { id: 'edit-sends', enter: async (p, x) => {
    await x.toEdit('effects');
    await p.click(tid('v6e-effects-cat-sends'));
    await p.waitForTimeout(200);
  } },
  { id: 'edit-master', enter: async (p, x) => x.toEdit('master'), leave: async (p, x) => x.toPerform() },
  // ---- Settings: every category, then search ('settings-*' is expanded per category at run time)
  { id: 'settings-*' },
  { id: 'settings-search', enter: async (p, x) => {
    await x.ev(() => window.__rig.ctx.openSettings());
    await x.until(() => window.__rig.views.settings.isOpen);
    await p.fill(tid('settings-search'), 'pedal');
    await p.waitForTimeout(250);
  }, leave: async (p, x) => {
    await x.ev(() => window.__rig.ctx.closeSettings());
    await x.until(() => document.getElementById('view-settings').hidden);
  } },
  // ---- the chart (settings.chartView on): on the stage, in the sidebar, the Edit chart dialog
  { id: 'chart-stage', enter: async (p, x) => {
    await x.ev(() => {
      const { store } = window.__rig;
      const id = store.currentSong().id;
      store.setChart(id, { text: window.__auditChart, format: 'chordpro' });
    });
    await x.ev(() => window.__rig.setChartView(true));
    await x.until(() => !!window.__rig.views.chart?.state()?.v6, null, 30000);
    await x.ev(() => window.__rig.views.chart.show());
    await x.ev(() => window.__rig.views.chart.setPlacement('stage'));
    await x.until(() => !!document.querySelector('[data-testid="v6-chart-stage"]'));
    await p.waitForTimeout(300);
  } },
  { id: 'chart-side', enter: async (p, x) => {
    await x.ev(() => window.__rig.views.chart.setPlacement('side'));
    await x.until(() => !!document.querySelector('[data-testid="v6-chart-side"]'));
    await p.waitForTimeout(300);
  } },
  { id: 'chart-editor', enter: async (p, x) => {
    await p.click(tid('v6-chart-edit'));
    await x.until(() => !!document.querySelector('[data-testid="v6-chart-editor"]'));
    await p.waitForTimeout(400);
  }, leave: async (p, x) => {
    await x.esc();
    await x.until(() => !document.querySelector('[data-testid="v6-chart-editor"]'));
  } },
];
/** The strips' "more this way" fade (styles-v6.css .v6-sfade::after, 48 px) over a strip scrolled half out. */
const FADES = [{ sel: '.v6-stripsarea.scroll:not(.atend) .v6-sfade', side: 'right', px: 48 }];
/** Fields found without a boundary: Edit's song name is a title with a ✎ beside it (views/v6/edit/edit.js). */
const BOUNDARY_EXEMPT = ['.ev2-song-name'];
/** The contact sheet's four tiles. */
const SHEET = [['perform-2', 'Perform'], ['edit-sound', 'Edit · Sound'], ['settings-sound', 'Settings · Sound'],
  ['bank', 'Song bank']];

/**
 * Shoot + audit the v6 screens.
 * @param {object} o
 * @param {string[]} [o.themes]  theme ids (default: every pickable theme)
 * @param {string} o.out         per theme <out>/<id>/{<state>.png, audit-<state>-1280.json, summary.json}
 * @param {string[]} [o.only]    state ids (prefix match: 'settings' = every Settings category)
 * @param {string} [o.sheets]    contact sheets → <sheets>/<id>.png
 * @param {boolean} [o.ui]       the non-text half (focus rings, boundaries); default true
 * @param {(s:string)=>void} [o.log]
 * @returns {Promise<{themes:object, totals:{text:number, rings:number, bounds:number, errors:number, missed:number}}>}
 */
export async function shootV6(o) {
  const log = o.log || console.log;
  const ui = o.ui !== false;
  const themes = (o.themes && o.themes.length ? o.themes : THEMES.filter((t) => !t.coming).map((t) => t.id));
  for (const id of themes) if (!byId(id)) throw new Error(`unknown theme ${id}`);
  const want = (id) => !o.only || !o.only.length || o.only.some((k) => id === k || id.startsWith(k));
  const { chromium } = require('playwright');
  const { createServer } = require(path.join(ROOT, 'server.js'));
  const fx = bankFixture();
  const server = createServer({ appDir: path.join(ROOT, 'app'), port: 0, userSamples: [fx.root], docsDir: null });
  const { url } = await server.listen();
  const origin = new URL(url).origin;
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const all = {};
  const totals = { text: 0, rings: 0, bounds: 0, errors: 0, missed: 0 };
  try {
    for (const id of themes) {
      const out = path.join(o.out, id);
      fs.mkdirSync(out, { recursive: true });
      const t = byId(id);
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
        colorScheme: t.mode });
      await pinTheme(ctx, id);
      await ctx.grantPermissions([...MIDI_PERMISSIONS], { origin });
      await ctx.addInitScript(([chart]) => { window.__auditChart = chart; }, [CHART]);
      const page = await ctx.newPage();
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
      page.setDefaultTimeout(60000);
      const x = mk(page);
      const sum = { theme: id, size: '1280x800', shots: {}, missed: {} };
      try {
        await page.goto(`${url}?ui6=1`, { timeout: 120000 });
        await page.waitForFunction(() => !!window.__rig?.views?.v6, null, { timeout: 120000 });
        if (await page.isVisible('#overlay-start')) await page.click('#overlay-start');
        await page.waitForFunction(() => window.__rig.engine.ctx?.state === 'running', null, { timeout: 120000 });
        await x.ev(() => window.__rig.controller.packsReady);
        await x.settled();
        sum.shown = await x.ev(() => document.documentElement.dataset.theme);
        await x.ev((n) => {
          const { store } = window.__rig;
          store.set(`songs.${store.currentSong().id}.notes`, n);
        }, NOTES);
        await x.ev(() => document.fonts.ready);
        // stills only: this box runs at a few fps under load, so transitions would be caught mid-way
        await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; '
          + 'animation-duration: 0s !important; animation-delay: 0s !important; }' });
        const list = [];
        for (const s of STATES) {
          if (s.id !== 'settings-*') {
            list.push(s);
            continue;
          }
          // today's categories, read from the mounted v6 Settings (one state per category)
          await x.ev(() => window.__rig.ctx.openSettings());
          await x.until(() => window.__rig.views.settings.isOpen && !!window.__rig.views.settings.v6);
          const cats = await x.ev(() => [...document.querySelectorAll('#view-settings [role=tab]')]
            .map((b) => b.dataset.cat));
          await x.ev(() => window.__rig.ctx.closeSettings());
          for (const c of cats) {
            list.push({ id: `settings-${c}`, enter: async (p, xx) => {
              await xx.ev(() => window.__rig.ctx.openSettings());
              await xx.until(() => window.__rig.views.settings.isOpen);
              await p.click(`#view-settings [role=tab][data-cat="${c}"]`);
              await xx.until((cc) => !document.querySelector(`#view-settings [role=tabpanel][data-cat="${cc}"]`)
                .hidden, c);
              await xx.ev(() => { for (const b of document.querySelectorAll('.st-body')) b.scrollTop = 0; });
            }, leave: async (p, xx) => {
              await xx.ev(() => window.__rig.ctx.closeSettings());
              await xx.until(() => document.getElementById('view-settings').hidden);
            } });
          }
        }
        for (const s of list) {
          const run = want(s.id);
          try {
            // a skipped state is still entered when a later one builds on it (Edit categories, bank → trying)
            await s.enter(page, x, fx);
          } catch (err) {
            sum.missed[s.id] = String(err.message || err).split('\n')[0];
            totals.missed += run ? 1 : 0;
            log(`  [${id}] ${s.id}: not reached (${sum.missed[s.id]})`);
            await s.leave?.(page, x).catch(() => {});
            continue;
          }
          if (run) {
            await x.ev(() => {
              document.getElementById('toasts')?.replaceChildren();
              document.activeElement?.blur?.();
            });
            await page.mouse.move(640, 2);
            await page.waitForTimeout(250);
            const file = path.join(out, `${s.id}.png`);
            await page.screenshot({ path: file });
            const r = await audit(page, { out, label: `${s.id}-1280`, shot: file, ui, quiet: !o.verbose, fades: FADES,
              boundaryExempt: BOUNDARY_EXEMPT });
            const row = { count: r.count, fails: r.fails, lowest: r.lowest };
            if (r.ui) Object.assign(row, { rings: r.ui.rings, ringFails: r.ui.ringFails.length, bounds: r.ui.bounds,
              boundFails: r.ui.boundFails.length });
            sum.shots[s.id] = row;
            totals.text += r.fails;
            totals.rings += r.ui ? r.ui.ringFails.length : 0;
            totals.bounds += r.ui ? r.ui.boundFails.length : 0;
            const bad = r.fails + (r.ui ? r.ui.ringFails.length + r.ui.boundFails.length : 0);
            log(`  [${id}] ${s.id}: ${r.count} text, ${r.fails} fail` + (r.ui ? ` · rings ${r.ui.rings}/${r.ui.ringFails
              .length} fail · edges ${r.ui.bounds}/${r.ui.boundFails.length} fail` : '') + (bad ? '' : ` · low ${r.lowest}`));
            if (bad) {
              for (const f of r.failRows) log(`      TEXT ${f.cr} < ${f.need} "${f.text}" .${f.cls} ${f.fg} on ${f.bg}`);
              for (const f of r.ui?.ringFails || []) log(`      RING ${f.kind} ${f.cr} <${f.tag}> "${f.text}" .${f.cls} ${f.testid} ${f.ring || 'no visible change'} on ${f.bg || ''}`);
              for (const f of r.ui?.boundFails || []) log(`      EDGE ${f.kind} ${f.cr} (${f.kind === 'field' ? `border ${f.border}, fill ${f.fill}` : `thumb ${f.thumb}`}) <${f.tag}> .${f.cls} ${f.testid} on ${f.bg}`);
            }
          }
          await s.leave?.(page, x);
          await page.waitForTimeout(150);
        }
      } finally {
        sum.errors = [...new Set(errors.filter((e) => !/MIDI|midi|requestMIDIAccess/.test(e)))];
        totals.errors += sum.errors.length;
        fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(sum, null, 1));
        all[id] = sum;
        await ctx.close();
      }
      if (o.sheets) await contactSheet(browser, out, path.join(o.sheets, `${id}.png`), t.name);
    }
  } finally {
    await browser.close();
    await server.close();
    fx.cleanup();
  }
  return { themes: all, totals };
}

/** Four of the theme's shots in a 2 × 2 grid with captions (full size), as one PNG. */
async function contactSheet(browser, dir, file, name) {
  const tiles = SHEET.filter(([s]) => fs.existsSync(path.join(dir, `${s}.png`)));
  if (!tiles.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const p = await browser.newPage({ viewport: { width: 2580, height: 1700 }, deviceScaleFactor: 1 });
  const img = (s) => `data:image/png;base64,${fs.readFileSync(path.join(dir, `${s}.png`)).toString('base64')}`;
  await p.setContent(`<!doctype html><html><body style="margin:0;background:#222;color:#eee;font:600 20px system-ui">
    <div style="padding:8px 14px">${name} — UI v6 at 1280 × 800</div>
    <div style="display:grid;grid-template-columns:1280px 1280px;gap:20px;padding:0 0 10px 10px">
    ${tiles.map(([s, cap]) => `<figure style="margin:0"><figcaption style="padding:4px 0">${cap}</figcaption>
      <img src="${img(s)}" width="1280" height="800" style="display:block"></figure>`).join('')}
    </div></body></html>`);
  await p.waitForTimeout(200);
  await p.screenshot({ path: file, fullPage: true });
  await p.close();
}
