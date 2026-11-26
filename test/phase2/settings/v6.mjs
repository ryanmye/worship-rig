// Settings suite, "v6" mode (UI v6 U6; native DECISIONS D21; mockup native/docs/design/mockups/settings.html): the v6
// Settings (views/v6/settings.js) applied to today's Settings while settings.uiV6 is on, in the real app.
//   - flag off: nothing of the v6 Settings is fetched or drawn; an on → off cycle leaves today's Settings DOM as it
//     was;
//   - the control-count proof: every control today's Settings renders is the same element in the v6 Settings, in a
//     category with a visible tab, hidden exactly when today's code hides it (and the same with the flag on at boot);
//   - category summaries (live), search (filter, Enter, Esc), deep links, MIDI Learn and Perform layout categories,
//     theme cards apply themes, the narrow (iPad portrait) drill-in, a Mac-app run (the fixture with a fake rig);
//   - screenshots → $U6_SHOTS (default test/phase2/settings/screenshots/v6/): every category at 1280×800 Sanctuary,
//     820×1180 list + detail, Sanctuary Day.
// Called by run.mjs; results go into its table.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { MIDI_PERMISSIONS, waitRigReady, pinTheme } from '../../integration/lib.mjs';

/** Every control in the Settings dialog, tagged once (expando) so the same element can be found again. */
function inventory(tag) {
  const dlg = document.querySelector('#view-settings .st-dialog');
  const SEL = 'button, select, input, textarea, summary, a[href], [role=radio], [role=switch], [role=tab]';
  window.__u6n ||= 0;
  return [...dlg.querySelectorAll(SEL)].filter((e) => !e.closest('.v6-st-search, .v6-st-back')).map((e) => {
    if (tag && !e.__u6) e.__u6 = ++window.__u6n;
    const panel = e.closest('.st-panel');
    let hidden = false;
    for (let x = e; x && x !== panel && x !== dlg; x = x.parentElement) if (x.hidden) hidden = true;
    const sig = e.dataset.testid || e.dataset.bind || e.getAttribute('aria-label') || e.dataset.cat
      || e.dataset.themeId || e.dataset.control || `${e.tagName}:${(e.textContent || '').trim().slice(0, 30)}`;
    return { id: e.__u6 || 0, sig: `${e.tagName.toLowerCase()}|${sig}`, cat: panel ? panel.dataset.cat : '(nav)',
      hidden };
  });
}

/**
 * @param {{browser: import('playwright').Browser, createServer: Function, ROOT: string, SHOTS: string,
 *   results: object[]}} o
 */
export async function runV6({ browser, createServer, ROOT, SHOTS, results }) {
  const mode = 'v6';
  const OUT = process.env.U6_SHOTS || path.join(SHOTS, 'v6');
  fs.mkdirSync(OUT, { recursive: true });
  const userSamplesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-settings-v6-'));
  const server = createServer({ appDir: path.join(ROOT, 'app'), port: 0, userSamples: [userSamplesDir] });
  const info = await server.listen();
  const origin = `http://127.0.0.1:${info.port}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await pinTheme(context, 'sanctuary');
  await context.grantPermissions([...MIDI_PERMISSIONS], { origin });
  // store.js with its listener Set exposed (the ui-v6 suite's probe)
  await context.route('**/js/store.js', async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace('const listeners = new Set();',
      'const listeners = new Set(); globalThis.__storeListeners = listeners;');
    await route.fulfill({ response: res, body });
  });
  const page = await context.newPage();
  const errors = [];
  const reqs = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url || '?'}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('request', (r) => reqs.push(new URL(r.url()).pathname));
  const T = async (name, fn) => {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ mode, name, ok: true });
      console.log(`  ✓ [${mode}] ${name} (${Date.now() - t0} ms)`);
    } catch (err) {
      results.push({ mode, name, ok: false, err });
      console.log(`  ✗ [${mode}] ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6)
        .join('\n      ')}`);
      try {
        await page.evaluate(() => {
          window.__rig.views.settings.v6?.search('');
          if (window.__rig.views.settings.isOpen) window.__rig.ctx.closeSettings();
        });
      } catch { /* the next test reports its own failure */ }
    }
  };
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
  const open = async (section) => {
    await ev((s) => window.__rig.ctx.openSettings(s ? { section: s } : {}), section || null);
    await until(() => window.__rig.views.settings.isOpen);
  };
  const close = async () => {
    await ev(() => window.__rig.ctx.closeSettings());
    await until(() => document.getElementById('view-settings').hidden);
  };
  const cat = async (id) => {
    await page.click(`#view-settings [role=tab][data-cat="${id}"]`);
    await until((c) => !document.querySelector(`#view-settings [role=tabpanel][data-cat="${c}"]`).hidden, id);
  };
  const setV6 = async (on) => {
    await ev((b) => window.__rig.store.set('settings.uiV6', b ? true : null), on);
    if (on) await until(() => !!window.__rig.views.settings.v6, null, 20000);
    else await until(() => !window.__rig.views.settings.v6);
  };
  /** Let Settings' async renders land (My Samples' /api/health → Rescan, the About rows) before comparing. */
  const settle = async () => {
    await until(() => !!document.querySelector('.st-samples-rescan'), null, 8000).catch(() => {});
    await until(() => document.querySelectorAll('#view-settings .st-about dt').length > 0, null, 8000).catch(() => {});
    await page.waitForTimeout(300);
  };
  const tabCats = () => ev(() => [...document.querySelectorAll('#view-settings [role=tab]')].map((t) => t.dataset.cat));
  const sum = (id) => page.textContent(`[data-testid="settings-sum-${id}"]`);
  const clean = () => ev(() => {
    for (const t of document.querySelectorAll('#toasts > *')) t.remove();
    for (const c of document.querySelectorAll('.st-body')) c.scrollTop = 0;
    document.activeElement?.blur?.();
  });
  /** The shape of today's Settings DOM (tags, classes, testids, hidden), statuses' text left out. */
  const shape = () => ev(() => [...document.querySelectorAll('#view-settings *')].map((e) => {
    const id = e.id.replace(/-[a-z0-9]{6}$/, '-*');
    return `${e.tagName}${id ? `#${id}` : ''}.${[...e.classList].sort().join('.')}`
      + `${e.dataset.testid ? `[${e.dataset.testid}]` : ''}${e.hidden ? '[hidden]' : ''}`;
  }).join('\n'));

  console.log(`\n[${mode}] ${origin} (the app; settings.uiV6 off at boot, then on)`);
  try {
    let base = null;
    let today = null;
    await T('boot (flag off): today’s Settings, nothing of the v6 Settings fetched or drawn', async () => {
      await page.goto(`${origin}/`);
      await until(() => !!(window.__rig && window.__rig.views && window.__rig.views.settings), null, 30000);
      await waitRigReady(page, { timeout: 40000, what: `[${mode}] window.__rig.ready` });
      const ov = await page.$('#overlay-start:not([hidden])');
      if (ov) await ov.click();
      await page.waitForTimeout(800);
      await open();
      assert.equal(await ev(() => window.__rig.views.settings.v6), null);
      assert.equal(await ev(() => document.querySelectorAll('.v6-st, link[data-v6-settings-css], .v6-st-sum').length),
        0);
      assert.ok(!reqs.some((u) => /views\/v6\/settings|styles-v6-settings/.test(u)), 'no v6 Settings request');
      assert.deepEqual(await tabCats(),
        ['sound', 'keyboards', 'samples', 'look', 'library', 'about']);
      base = await ev(() => ({ store: window.__storeListeners.size }));
      await cat('sound');
      await settle();
      today = await ev(inventory, true);
      await close();
    });

    await T('every control of today’s Settings is still there with the flag on (same element, reachable, same '
      + 'hidden state); deep categories in the v6 order', async () => {
      await open();
      await settle();
      const shapeOff = await shape();
      await setV6(true);
      const now = await ev(inventory, false);
      const byId = new Map(now.filter((x) => x.id).map((x) => [x.id, x]));
      // today's code rebuilds a few controls on open / close (the pedal test, the pad and My Samples buttons): those
      // are matched by signature among the untagged ones; every other control must be the very same element
      const fresh = now.filter((x) => !x.id);
      const rebuilt = [];
      const missing = [];
      const pair = new Map();
      for (const x of today) {
        if (byId.has(x.id)) {
          pair.set(x, byId.get(x.id));
          continue;
        }
        const i = fresh.findIndex((y) => y.sig === x.sig);
        if (i < 0) missing.push(x.sig);
        else {
          rebuilt.push(x.sig);
          pair.set(x, fresh.splice(i, 1)[0]);
        }
      }
      assert.deepEqual(missing, [], 'every control of today is in the v6 Settings');
      const changed = today.filter((x) => pair.get(x).hidden !== x.hidden);
      assert.deepEqual(changed.map((x) => x.sig), [], 'hidden exactly when today hides it');
      // reachable: the control's category has a visible tab in the nav
      const unreachable = await ev((list) => list.filter((x) => {
        if (x.cat === '(nav)') return false;
        const t = document.querySelector(`#view-settings [role=tab][data-cat="${x.cat}"]`);
        return !t || t.hidden || getComputedStyle(t).display === 'none';
      }).map((x) => x.sig), now);
      assert.deepEqual(unreachable, []);
      const added = fresh;
      console.log(`    control count: today ${today.length} (${today.length - rebuilt.length} the same element, `
        + `${rebuilt.length} rebuilt by today's code: ${rebuilt.join(', ')}); v6 ${now.length} = ${today.length} `
        + `+ ${added.length} new (${added.map((x) => x.sig.split('|')[1]).join(', ')})`);
      assert.equal(now.length, today.length + added.length);
      assert.deepEqual(await tabCats(),
        ['sound', 'keyboards', 'midilearn', 'samples', 'layout', 'look', 'library', 'about']);
      // learnSection moved into MIDI Learn; Perform view stays in Look (the preview switch where Ryan knows it)
      assert.equal(await ev(() => document.querySelector('[data-section="learn"]').closest('.st-panel').dataset.cat),
        'midilearn');
      assert.equal(await ev(() => document.querySelector('[data-section="perform"]').closest('.st-panel').dataset.cat),
        'look');
      // live off again (Settings open on a v6-only category): today's Settings exactly as it was
      await cat('midilearn');
      await setV6(false);
      assert.equal(await ev(() => window.__rig.views.settings.category), 'keyboards', 'falls back to Keyboards & MIDI');
      await ev(() => window.__rig.views.settings._debug.showCategory('sound'));
      const shapeAgain = await shape();
      if (shapeAgain !== shapeOff) {
        const a = shapeOff.split('\n');
        const b = shapeAgain.split('\n');
        const i = a.findIndex((x, k) => x !== b[k]);
        assert.fail(`an on → off cycle changed today’s Settings DOM at line ${i}: ${a.slice(i - 2, i + 3).join(' | ')}`
          + ` ≠ ${b.slice(i - 2, i + 3).join(' | ')} (${a.length} vs ${b.length} nodes)`);
      }
      assert.equal(await ev(() => document.querySelectorAll('.v6-st, link[data-v6-settings-css], .v6-st-sum, '
        + '[data-settings-search]').length), 0);
      assert.equal(await ev(() => window.__storeListeners.size), base.store, 'store listeners back to boot');
      await settle();
      const again = await ev(inventory, false);
      assert.deepEqual(again.map((x) => `${x.sig}|${x.cat}|${x.hidden}`),
        today.map((x) => `${x.sig}|${x.cat}|${x.hidden}`), 'today’s controls, categories and hidden states again');
      await close();
    });

    await T('flag on at boot: the same controls by signature (none missing)', async () => {
      await ev(() => window.__rig.store.set('settings.uiV6', true));
      await page.reload();
      await until(() => !!window.__rig?.views?.settings?.v6, null, 30000);
      await waitRigReady(page, { timeout: 40000 });
      await open();
      // My Samples' Rescan and the About rows come after an async /api/health
      if (today.some((x) => /Rescan/.test(x.sig))) await until(() => !!document.querySelector('.st-samples-rescan'));
      await page.waitForTimeout(300);
      const now = await ev(inventory, false);
      const have = new Map();
      for (const x of now) have.set(x.sig, (have.get(x.sig) || 0) + 1);
      const miss = [];
      for (const x of today) {
        if (!have.get(x.sig)) miss.push(x.sig);
        else have.set(x.sig, have.get(x.sig) - 1);
      }
      assert.deepEqual(miss, []);
      await close();
    });

    await T('category summaries: each category’s state under its name, live', async () => {
      await open('sound');
      assert.match(await sum('sound'), /^System default · (\d+ ms|Lowest|Balanced|Safe)$/);
      assert.match(await sum('keyboards'), / · Normal touch$/);
      await ev(() => window.__rig.store.set('settings.velocitySens', 'hard'));
      await until(() => /Heavy touch$/.test(document.querySelector('[data-testid="settings-sum-keyboards"]')
        .textContent));
      await ev(() => window.__rig.store.set('settings.velocitySens', 'normal'));
      assert.equal(await sum('midilearn'), 'nothing learned yet');
      await ev(() => window.__rig.store.setMidiLearn('slots.0.gain', { cc: 20, channel: 0 }));
      await until(() => document.querySelector('[data-testid="settings-sum-midilearn"]').textContent
        === '1 control learned');
      assert.equal(await sum('layout'), 'sidebar open · snapshots shown');
      assert.equal(await sum('look'), 'Sanctuary · dark');
      assert.match(await sum('library'), /^\d+ songs · Export to back up$/);
      assert.equal(await sum('about'), 'Chrome');
      assert.equal(await sum('samples'), 'built-in sounds');
      await ev(() => window.__rig.store.set('settings.theme', 'daylight-day'));
      await until(() => document.querySelector('[data-testid="settings-sum-look"]').textContent
        === 'Daylight Day · Day');
      await ev(() => window.__rig.store.set('settings.theme', 'sanctuary'));
      await until(() => document.querySelector('[data-testid="settings-sum-look"]').textContent === 'Sanctuary · dark');
      await close();
    });

    await T('MIDI Learn category: the learned list with Forget (= the row’s own Clear), the D20 rule, Learn… and '
      + 'today’s table', async () => {
      await open('midilearn');
      assert.equal(await ev(() => window.__rig.views.settings.category), 'midilearn');
      assert.match(await page.textContent('[data-testid="settings-learn-rule"]'), /Revert puts the song back/);
      const row = await page.textContent('[data-testid="settings-learned"] .v6-st-lrn');
      assert.match(row, /CC 20 · ch 1→Keys level/);
      assert.ok(await page.$('[data-testid="settings-panel-midilearn"] .st-learn-table tr[data-control="swell"]'));
      await page.click('[data-testid="settings-learned"] .v6-st-forget');
      await until(() => !window.__rig.store.get().settings.midiLearn['slots.0.gain']);
      await until(() => document.querySelector('[data-testid="settings-sum-midilearn"]').textContent
        === 'nothing learned yet');
      assert.match(await page.textContent('[data-testid="settings-learned"]'), /Nothing learned yet/);
      await page.click('[data-testid="settings-learn-new"]');
      assert.equal(await ev(() => document.activeElement?.classList.contains('st-learn')), true,
        'Learn… goes to the first Learn button');
      await close();
    });

    await T('Perform layout: the sidebar’s customize list reaches the live v6 sidebar (hide, order, Starts) and the '
      + 'snapshots row folds', async () => {
      await page.click('#view-switch button[data-value="perform"]').catch(() => {});
      await until(() => !!document.querySelector('.v6-side [data-testid="v6-sb-tab-notes"]'), null, 20000);
      await open('layout');
      assert.equal(await ev(() => window.__rig.views.settings.category), 'layout');
      await page.click('[data-testid="settings-sidebar-modules"] [data-testid="v6-cz-show-notes"]');
      await until(() => !document.querySelector('.v6-side [data-testid="v6-sb-tab-notes"]'));
      assert.deepEqual(await ev(() => JSON.parse(localStorage.getItem('worship-rig.v6.sidebar')).hidden), ['notes']);
      await page.click('[data-testid="settings-sidebar-modules"] [data-testid="v6-cz-show-notes"]');
      await until(() => !!document.querySelector('.v6-side [data-testid="v6-sb-tab-notes"]'));
      await page.click('[data-testid="settings-sidebar-modules"] [data-testid="v6-cz-up-setlist"]');
      await until(() => document.querySelector('.v6-side .v6-sb-tab')?.dataset.id === 'setlist');
      await page.click('[data-testid="settings-sidebar-modules"] [data-testid="v6-cz-up-drone"]');
      await until(() => document.querySelector('.v6-side .v6-sb-tab')?.dataset.id === 'drone');
      await page.click('[data-testid="settings-sidebar-modules"] [data-testid="v6-sb-starts-collapsed"]');
      await until(() => JSON.parse(localStorage.getItem('worship-rig.v6.sidebar')).starts === 'collapsed');
      await page.click('[data-testid="settings-sidebar-modules"] [data-testid="v6-sb-starts-open"]');
      await until(() => JSON.parse(localStorage.getItem('worship-rig.v6.sidebar')).starts === 'open');
      await page.click('[data-testid="setting-snapshots-row"] [data-value="folded"]');
      await until(() => document.querySelector('.v6-perform').classList.contains('snaps-folded'));
      await until(() => document.querySelector('[data-testid="settings-sum-layout"]').textContent
        === 'sidebar open · snapshots folded');
      assert.equal(await ev(() => localStorage.getItem('worship-rig.v6.snapshots')), 'folded');
      await page.click('[data-testid="setting-snapshots-row"] [data-value="shown"]');
      await until(() => !document.querySelector('.v6-perform').classList.contains('snaps-folded'));
      // the sidebar's own ⋯ shows what Settings changed (one storage, one set of rules)
      await close();
    });

    await T('search: filters categories and rows by label / hint, Enter jumps on, Esc clears (and only then closes)',
      async () => {
        await open('sound');
        await page.fill('[data-testid="settings-search"]', 'pedal');
        await until(() => /of \d+|found/.test(document.querySelector('[data-testid="settings-search-count"]')
          .textContent));
        const r = await ev(() => ({
          hits: window.__rig.views.settings.v6.hits.map((x) => x.cat),
          nohit: [...document.querySelectorAll('#view-settings .st-tab.v6-st-nohit')].map((t) => t.dataset.cat),
          cur: window.__rig.views.settings.category,
        }));
        assert.ok(r.hits.includes('keyboards'), 'the Sustain pedal row');
        assert.ok(r.nohit.includes('look') && r.nohit.includes('about'), `categories without a match hide: ${r.nohit}`);
        // Enter until the Keyboards category: the Sustain pedal row is marked, Touch is filtered out
        for (let i = 0; i < 6 && (await ev(() => window.__rig.views.settings.category)) !== 'keyboards'; i++) {
          await page.press('[data-testid="settings-search"]', 'Enter');
        }
        assert.equal(await ev(() => window.__rig.views.settings.category), 'keyboards');
        const kb = await ev(() => {
          const p = document.querySelector('[data-testid="settings-panel-keyboards"]');
          const rows = [...p.querySelectorAll('.st-row')];
          const vis = (e) => !!(e.offsetWidth || e.offsetHeight);
          return { pedal: rows.filter((x) => /Sustain pedal/.test(x.textContent)).map(vis),
            touch: rows.filter((x) => /^Touch/.test(x.textContent)).map(vis) };
        });
        assert.deepEqual(kb.pedal, [true]);
        assert.deepEqual(kb.touch, [false]);
        // a row in a closed Advanced opens it while searching; clearing closes it again
        await page.fill('[data-testid="settings-search"]', 'mono output');
        await until(() => window.__rig.views.settings.category === 'sound');
        assert.equal(await ev(() => document.querySelector('[data-testid="settings-advanced-sound"]').open), true);
        // nothing found: the whole list stays
        await page.fill('[data-testid="settings-search"]', 'zzqx');
        assert.equal(await page.textContent('[data-testid="settings-search-count"]'), 'No match');
        assert.equal(await ev(() => document.querySelectorAll('#view-settings .st-tab.v6-st-nohit').length), 0);
        await page.fill('[data-testid="settings-search"]', 'ember');
        assert.equal(await ev(() => window.__rig.views.settings.category), 'look', 'theme names are found');
        await page.keyboard.press('Escape');
        await until(() => window.__rig.views.settings.v6.query === '');
        assert.equal(await ev(() => window.__rig.views.settings.isOpen), true, 'the first Esc only clears the search');
        assert.equal(await ev(() => document.querySelectorAll('.v6-st-miss, .v6-st-nohit, .v6-st-hit').length), 0);
        assert.equal(await ev(() => document.querySelector('[data-testid="settings-advanced-sound"]').open), false);
        await page.keyboard.press('Escape');
        await until(() => !window.__rig.views.settings.isOpen);
      });

    await T('deep links land where they did (1.x names, aliases) and on the new categories', async () => {
      const want = {
        learn: 'midilearn', 'midi-learn': 'midilearn', midilearn: 'midilearn', layout: 'layout', appearance: 'look',
        theme: 'look', menubar: 'look', perform: 'look', pads: 'samples', bank: 'samples', samples: 'samples',
        backups: 'library', 'voice-limit': 'sound', midi: 'keyboards', keyboard: 'keyboards', 'esc-panics': null,
        about: 'about', diagnostics: 'about',
      };
      for (const [s, c] of Object.entries(want)) {
        if (!c) continue;
        await open(s);
        assert.equal(await ev(() => window.__rig.views.settings.category), c, `open({section:'${s}'})`);
        await close();
      }
      await open('voice-limit');
      assert.equal(await ev(() => document.querySelector('[data-testid="settings-advanced-sound"]').open), true);
      await close();
    });

    await T('Look: theme preview cards apply themes (and Daylight’s Day / Stage / Auto stays)', async () => {
      await open('appearance');
      assert.equal(await ev(() => document.querySelectorAll('#view-settings .st-theme .v6-tprev').length), 8);
      await page.click('[data-testid="theme-card-ember"]');
      await until(() => window.__rig.store.get().settings.theme === 'ember'
        && document.documentElement.dataset.theme === 'ember');
      await page.click('[data-testid="theme-card-daylight-day"]');
      await until(() => document.documentElement.dataset.theme === 'daylight-day');
      assert.equal(await ev(() => !document.querySelector('.st-row-light').hidden), true);
      await page.click('[data-testid="theme-card-sanctuary"]');
      await until(() => document.documentElement.dataset.theme === 'sanctuary');
      await close();
    });

    await T('screenshots: every category at 1280×800 (Sanctuary), search, Sanctuary Day', async () => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await open('sound');
      const cats = await tabCats();
      for (const c of cats) {
        await cat(c);
        await clean();
        await page.waitForTimeout(150);
        await page.screenshot({ path: path.join(OUT, `u6-${c}-1280.png`) });
      }
      await page.fill('[data-testid="settings-search"]', 'pedal');
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(OUT, 'u6-search-1280.png') });
      await page.keyboard.press('Escape');
      await ev(() => window.__rig.store.set('settings.theme', 'sanctuary-day'));
      await until(() => document.documentElement.dataset.theme === 'sanctuary-day');
      for (const c of ['look', 'layout']) {
        await cat(c);
        await clean();
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(OUT, `u6-${c}-1280-sanctuary-day.png`) });
      }
      await ev(() => window.__rig.store.set('settings.theme', 'sanctuary'));
      await close();
    });

    await T('iPad portrait 820×1180: the categories drill in (list → category with back), a deep link opens its '
      + 'category', async () => {
      await page.setViewportSize({ width: 820, height: 1180 });
      await open();
      await until(() => window.__rig.views.settings.v6.drill === 'list');
      assert.equal(await ev(() => getComputedStyle(document.querySelector('#view-settings .st-body')).display), 'none');
      assert.equal(await ev(() => document.querySelector('#view-settings .st-nav').getAttribute('aria-orientation')),
        'vertical');
      await clean();
      await page.screenshot({ path: path.join(OUT, 'u6-ipad-list-820.png') });
      await cat('look');
      await until(() => window.__rig.views.settings.v6.drill === 'detail');
      assert.equal(await page.textContent('[data-testid="settings-crumb"]'), 'Look');
      await clean();
      await page.screenshot({ path: path.join(OUT, 'u6-ipad-look-820.png') });
      await page.click('[data-testid="settings-back"]');
      await until(() => window.__rig.views.settings.v6.drill === 'list');
      await close();
      await open('pads');
      await until(() => window.__rig.views.settings.v6.drill === 'detail'
        && window.__rig.views.settings.category === 'samples');
      await close();
      await page.setViewportSize({ width: 1280, height: 800 });
      await open();
      await until(() => window.__rig.views.settings.v6.drill === null);
      await close();
    });

  } finally {
    await T('zero console.error', async () => {
      assert.deepEqual(errors, []);
    });
    await context.close();
    await server.close();
  }
  await runMacPart({ browser, createServer, ROOT, OUT, results });
}

/** The Mac-app category order and summaries on the settings fixture (repo root served) with a fake window.rig. */
async function runMacPart({ browser, createServer, ROOT, OUT, results }) {
  const mode = 'v6';
  const server = createServer({ appDir: ROOT, port: 0 });
  const info = await server.listen();
  const origin = `http://127.0.0.1:${info.port}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await pinTheme(context, 'sanctuary');
  await context.grantPermissions([...MIDI_PERMISSIONS], { origin });
  await context.addInitScript(() => {
    window.rig = { isElectron: true, getInfo: async () => ({ version: '2.0.0', electron: '44', port: 8438 }) };
    const raw = localStorage.getItem('rig.v1');
    const lib = raw ? JSON.parse(raw) : { schema: 1, songs: {}, setlists: {}, meta: {}, settings: {} };
    lib.settings = { ...(lib.settings || {}), uiV6: true };
    localStorage.setItem('rig.v1', JSON.stringify(lib));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const name = 'Mac app (fixture, fake rig): Mac category before About, summaries "menu bar off · updates on" and the '
    + 'version; zero console.error';
  const t0 = Date.now();
  try {
    await page.goto(`${origin}/test/phase2/settings/fixture.html`);
    await page.waitForFunction(() => !!window.__rig?.views?.settings?.v6, null, { timeout: 30000 });
    await waitRigReady(page, { timeout: 30000 });
    await page.evaluate(() => window.__rig.ctx.openSettings({ section: 'mac' }));
    await page.waitForFunction(() => window.__rig.views.settings.category === 'mac');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#view-settings [role=tab]')]
      .map((t) => t.dataset.cat)), ['sound', 'keyboards', 'midilearn', 'samples', 'layout', 'look', 'library', 'mac',
      'about']);
    await page.waitForFunction(() => document.querySelector('[data-testid="settings-sum-about"]').textContent
      === 'Version 2.0.0', null, { timeout: 5000 });
    assert.equal(await page.textContent('[data-testid="settings-sum-mac"]'), 'menu bar off · updates on');
    assert.match(await page.textContent('[data-testid="settings-sum-library"]'), /songs · automatic backups$/);
    await page.screenshot({ path: path.join(OUT, 'u6-mac-1280.png') });
    assert.deepEqual(errors, []);
    results.push({ mode, name, ok: true });
    console.log(`  ✓ [${mode}] ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ mode, name, ok: false, err });
    console.log(`  ✗ [${mode}] ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6)
      .join('\n      ')}`);
  } finally {
    await context.close();
    await server.close();
  }
}
