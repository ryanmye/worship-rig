// OWNER: shell / integrator (views/edit/CONTRACT.md §6, §8). The H-v2 Edit inside the REAL app (app/index.html +
// main.js: top bar, Perform, Edit, Settings), after hv2-edit-integrate wired views/edit/shell.js in place of the old
// views/edit.js. Panel behaviour is tested per panel (panels/*.test.mjs); this file covers what only the whole app
// can show: boot with zero console errors at 1440 and 1024, the header chips → Song panel focus, header rename → the
// setlist row, tabs never interrupt sound, Show wiring, the Tone EQ in the slot panel (mount, b-rows, engine curve,
// no leak across song switches), Perform ⇄ Edit keeping the Revert baseline consistent, section open state across a
// reload (ui-edit "collapsed by default; section open state persists"), and "nothing lost" (every PARAMS address a
// factory song uses has a control). Screenshots → screenshots/edit-{1440,1024,tone-eq,wiring}.png.
//
// Own server (appDir = app/, like ui-edit's "app" mode) and one page for the whole file, tests in order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright';
import { ROOT, SHOTS } from './harness.mjs';
import { MIDI_PERMISSIONS, pinTheme } from '../../integration/lib.mjs';

const require = createRequire(import.meta.url);
const { createServer } = require(path.join(ROOT, 'server.js'));
const VERBOSE = !!process.env.VERBOSE;

let server;
let browser;
let context;
let page;
let samplesDir;
const errors = [];
const httpErrors = [];
const ev = (fn, arg) => page.evaluate(fn, arg);
const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tabSel = (id) => `#view-edit .ev2-tab[data-block="${id}"]`;
const noErrors = () => {
  assert.deepEqual(errors, [], `console errors:\n${errors.join('\n')}`);
  assert.deepEqual(httpErrors, [], `HTTP errors:\n${httpErrors.join('\n')}`);
};
/** Screenshot of the whole page (toasts removed, nothing focused) → screenshots/<name>.png */
async function shot(name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await ev(() => {
    for (const x of document.querySelectorAll('#toasts > *')) x.remove();
    document.activeElement?.blur?.();
  });
  await sleep(250);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}
/** Wait until the controller has the current song loaded. */
const loaded = () => until(() => {
  const r = window.__rig;
  const id = r.store.get().settings.currentSongId;
  return r.controller.status.songId === id && !r.controller.status.loading;
}, null, 60000);
/** Controller song switch (as MIDI Next does) + wait for the load. */
async function selectSong(idOrFactory) {
  const id = await ev((x) => {
    const st = window.__rig.store.get();
    return st.songs[x] ? x : st.songOrder.find((k) => st.songs[k].factoryId === x || st.songs[k].name === x);
  }, idOrFactory);
  assert.ok(id, `song ${idOrFactory}`);
  await ev((i) => window.__rig.controller.selectSong(i), id);
  await until((i) => window.__rig.controller.status.songId === i && !window.__rig.controller.status.loading, id, 60000);
  return id;
}
const edit = () => ev(() => !!window.__rig.views.edit);
const selectBlock = (id, opts) => ev(([i, o]) => window.__rig.views.edit.editState.select(i, o || {}), [id, opts]);
/** Horizontal overflow anywhere in the Edit view (page, regions, panel body). */
const overflow = () => ev(() => {
  const bad = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) bad.push(`page ${document.documentElement.scrollWidth}`);
  for (const c of document.querySelectorAll('#view-edit .ev2-left, #view-edit .ev2-head, #view-edit .ev2-rig, '
    + '#view-edit .ev2-body, #view-edit .ev2-bottom, #view-edit .ev2-tabs')) {
    if (c.scrollWidth > c.clientWidth + 1) bad.push(`${c.className} ${c.scrollWidth}>${c.clientWidth}`);
  }
  return bad;
});
/** Perform's changed paths and Edit's, for the current song. */
const bothChanges = () => ev(() => ({
  perform: [...window.__rig.views.perform.changedPaths].sort(),
  edit: [...window.__rig.views.edit.editState.changes].sort(),
  revert: document.querySelector('[data-testid="revert-song"]')?.dataset.count ?? null,
}));
const toneState = () => ev(() => {
  const d = window.__rig.views.edit._debug.instance('slot')._debug.tone();
  return { mounted: d.mounted, created: d.created, destroyed: d.destroyed };
});

before(async () => {
  samplesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-edit-v2-int-samples-'));
  server = createServer({ appDir: path.join(ROOT, 'app'), port: 0, userSamples: [samplesDir] });
  const info = await server.listen();
  const origin = `http://127.0.0.1:${info.port}`;
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await pinTheme(context, 'classic'); // theme-classic: assert the base look whatever the default theme is
  await context.grantPermissions(MIDI_PERMISSIONS, { origin }); // L-4: 'midi' only (test/README.md, Web MIDI)
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url || '?'}`);
    else if (VERBOSE) console.log(`   [page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) httpErrors.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(`${origin}/`, { timeout: 30000 });
  await until(() => !!(window.__rig && window.__rig.views), null, 30000);
  await until(() => window.__rig.engine.ctx && window.__rig.engine.ctx.state === 'running', null, 30000);
  await ev(() => window.__rig.viewsReady);
  await loaded();
});
after(async () => {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await server?.close?.();
  if (samplesDir) fs.rmSync(samplesDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------
test('integration: the app boots the H-v2 Edit (not views/edit.js); 1440 and 1024 fit; zero console errors', async () => {
  assert.ok(await edit(), 'main.js mounted an Edit view');
  const overlay = await page.$('#overlay-start:not([hidden])');
  if (overlay) await overlay.click();
  await page.click('#view-switch button[data-value="edit"]');
  await until(() => !document.getElementById('view-edit').hidden && !!document.querySelector('#view-edit .ev2'));
  const r = await ev(() => ({
    mounted: window.__rig.views.edit._debug.mounted().sort(),
    tabs: [...document.querySelectorAll('#view-edit .ev2-tab')].map((x) => x.dataset.block),
    old: !!document.querySelector('#view-edit .ed'),
    components: window.__rig.views.edit._debug.components,
    css: getComputedStyle(document.querySelector('#view-edit .ev2')).display,
    baseline: window.__rig.views.edit.editState.baseline === window.__rig.views.perform.savedSnapshot,
  }));
  assert.deepEqual(r.mounted, ['bottom', 'setlist', 'slot', 'song-header']);
  assert.deepEqual(r.tabs, ['slot:0', 'slot:1', 'slot:2', 'slot:3', 'drone', 'effects', 'master']);
  assert.equal(r.old, false, 'no .ed (views/edit.js) markup');
  assert.equal(r.components, 'ui-core');
  assert.equal(r.css, 'grid', 'styles-edit-v2.css is linked');
  assert.ok(r.baseline, 'Edit counts changes against Perform’s Revert snapshot (ctx.getBaseline)');
  // a song with Keys + Pad makes a representative shot (like the mockup's Sunday Pad + Piano)
  await selectSong('factory:sunday-pad-piano');
  await selectBlock('slot:0');
  for (const [w, hgt, name] of [[1440, 900, 'edit-1440'], [1024, 700, 'edit-1024']]) {
    await page.setViewportSize({ width: w, height: hgt });
    await sleep(300);
    assert.deepEqual(await overflow(), [], `no horizontal overflow at ${w}×${hgt}`);
    const g = await ev(() => {
      const rect = (s) => document.querySelector(s)?.getBoundingClientRect();
      return { panel: rect('#view-edit .ev2-panel'), bottom: rect('#view-edit .ev2-bottom'), vh: innerHeight };
    });
    assert.ok(g.panel.height > 250, `panel has room at ${w}×${hgt} (${Math.round(g.panel.height)} px)`);
    assert.ok(g.bottom.bottom <= g.vh + 1, `keyboard row on screen at ${w}×${hgt}`);
    await shot(name);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  noErrors();
});

test('integration: header KEY / BPM / Notes chips open the Song panel with the right control focused', async () => {
  for (const [chip, sec, tag] of [['key', 'song-key', 'SELECT'], ['bpm', 'song-tempo', 'INPUT'], ['notes', 'song-notes',
    'TEXTAREA']]) {
    await selectBlock('slot:1');
    const sel = chip === 'bpm' ? '#view-edit .ev2-song-bpmnum' : `#view-edit .ev2-song-chip[data-chip="${chip}"]`;
    await page.locator(sel).first().click();
    await until(([s]) => window.__rig.views.edit.editState.selected === 'song'
      && !!document.activeElement?.closest?.(`[data-sec="${s}"]`), [sec], 5000).catch(async (err) => {
      const d = await ev(() => ({
        sel: window.__rig.views.edit.editState.selected, opts: window.__rig.views.edit.editState.opts,
        active: document.activeElement?.outerHTML?.slice(0, 120),
      }));
      throw new Error(`${chip}: ${JSON.stringify(d)} ${err.message}`);
    });
    assert.equal(await ev(() => document.activeElement.tagName), tag, `${chip} focuses a ${tag}`);
    assert.equal(await ev(() => window.__rig.views.edit.editState.opts.focus), chip === 'bpm' ? 'tempo' : chip);
  }
  await ev(() => document.activeElement?.blur());
  noErrors();
});

test('integration: a rename in the header updates the setlist row (ui-edit "song name + notes edit")', async () => {
  const s = await ev(() => window.__rig.store.currentSong());
  const input = '#view-edit .ev2-song-name';
  await page.fill(input, 'Sunday Pad + Piano (late)');
  await page.press(input, 'Enter');
  await until((id) => window.__rig.store.getSong(id).name === 'Sunday Pad + Piano (late)', s.id);
  await until((id) => /Sunday Pad \+ Piano \(late\)/
    .test(document.querySelector(`#view-edit .ev2-list-row[data-id="${id}"]`)?.textContent || ''), s.id);
  // Perform's header follows too (one store, two views)
  await until(() => /\(late\)/.test(document.querySelector('#view-perform')?.textContent || ''));
  await page.fill(input, s.name);
  await page.press(input, 'Enter');
  await until(([id, n]) => window.__rig.store.getSong(id).name === n, [s.id, s.name]);
  noErrors();
});

test('integration: switching tabs never interrupts a held note', async () => {
  await ev(() => window.__rig.controller.perform.noteOn(60, 110));
  const rms = () => ev(async () => {
    const an = window.__rig.engine.analyserL;
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return 10 * Math.log10(s / buf.length + 1e-20);
  });
  await sleep(250);
  const before = await rms();
  assert.ok(before > -50, `note sounds (${before.toFixed(1)} dBFS)`);
  for (const id of ['slot:1', 'slot:2', 'slot:3', 'drone', 'effects', 'master', 'slot:0']) {
    await page.click(tabSel(id));
    await until((x) => window.__rig.views.edit.editState.selected === x, id);
  }
  const held = await ev(() => window.__rig.controller._debug().held.some(([n]) => n === 60));
  assert.ok(held, 'the note is still held after visiting every tab');
  const afterDb = await rms();
  assert.ok(afterDb > -60, `still sounding after the tab tour (${afterDb.toFixed(1)} dBFS)`);
  await ev(() => window.__rig.controller.perform.noteOff(60));
  noErrors();
});

test('integration: Show wiring toggles the strip, shows the sends, never writes the store', async () => {
  const before = await ev(() => JSON.stringify(window.__rig.store.currentSong()));
  await page.click('#view-edit .ev2-wiretog');
  await until(() => !document.querySelector('#view-edit .ev2-wire').hidden);
  assert.equal(await page.getAttribute('#view-edit .ev2-wiretog', 'aria-checked'), 'true');
  const cells = await ev(() => {
    const s = window.__rig.store.currentSong();
    return [...document.querySelectorAll('#view-edit .ev2-wv[data-slot]')].map((e) => ({
      shown: Number(e.dataset.value),
      want: Math.round((Number(s.patch.slots[Number(e.dataset.slot)]?.sends?.[e.dataset.lane]) || 0) * 100),
    }));
  });
  assert.ok(cells.length >= 6, `wiring cells: ${cells.length}`);
  for (const c of cells) assert.equal(c.shown, c.want);
  assert.deepEqual(await overflow(), []);
  // polish-1: the lane labels ("Echo song’s own") are never ellipsized and never run into "to Master"
  for (const [w, hgt] of [[1440, 900], [1024, 700]]) {
    await page.setViewportSize({ width: w, height: hgt });
    await sleep(250);
    const labels = await ev(() => {
      const out = document.querySelector('#view-edit .ev2-wout').getBoundingClientRect();
      return [...document.querySelectorAll('#view-edit .ev2-wn')].map((b) => {
        const s = b.querySelector('span');
        return { text: b.textContent, clipped: s.scrollWidth > s.clientWidth + 0.5,
          gap: Math.round(out.left - b.getBoundingClientRect().right) };
      });
    });
    assert.equal(labels.length, 3);
    for (const l of labels) {
      assert.equal(l.clipped, false, `"${l.text}" is not ellipsized at ${w}`);
      assert.ok(l.gap >= 0, `"${l.text}" ends before "to Master" at ${w} (gap ${l.gap})`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(250);
  await shot('edit-wiring');
  // a lane button selects Effects with its focus
  await page.click('#view-edit .ev2-wn >> nth=1');
  await until(() => window.__rig.views.edit.editState.selected === 'effects'
    && window.__rig.views.edit.editState.opts.focus === 'delay');
  await page.click('#view-edit .ev2-wiretog');
  await until(() => document.querySelector('#view-edit .ev2-wire').hidden);
  assert.equal(await ev(() => JSON.stringify(window.__rig.store.currentSong())), before, 'the store is untouched');
  await selectBlock('slot:0');
  noErrors();
});

test('integration: Keys › Advanced › Tone mounts the EQ; a band writes b-rows; the engine curve follows', async () => {
  await selectBlock('slot:0');
  await until(() => !!window.__rig.views.edit._debug.instance('slot'));
  assert.deepEqual(await toneState(), { mounted: false, created: 0, destroyed: 0 }, 'lazy: nothing mounted yet');
  await ev(() => {
    const adv = document.querySelector('#view-edit details[data-sec="slot0-adv"]');
    adv.open = true;
    document.querySelector('#view-edit details[data-sec="slot0-tone"]').open = true;
  });
  await until(() => !!document.querySelector('#view-edit .ev2-slot-tone-host .eqk'));
  assert.equal((await toneState()).mounted, true);
  // geometry from the component itself, after scrolling the plot into view
  await ev(() => document.querySelector('#view-edit .eqk-plot').scrollIntoView({ block: 'center' }));
  await sleep(300);
  const geo = (fn, arg) => ev(([f, a]) => window.__rig.views.edit._debug.instance('slot')._debug.tone().inst.debug()[f](a),
    [fn, arg]);
  const eq = () => ev(() => window.__rig.store.currentSong().patch.slots[0].eq || {});
  const resp = (hz) => ev((f) => {
    const src = typeof window.__rig.controller.getEqResponse === 'function' ? window.__rig.controller : window.__rig.engine;
    const r = src.getEqResponse(0, new Float32Array([f]));
    return r ? r[0] : null;
  }, hz);
  const before = await eq();
  // double-tap empty graph twice: b2, then b3 (legacy shelves migrate on the first edit)
  await page.mouse.dblclick(await geo('xOfMidi', 69), await geo('yOfDb', 7));
  await until(() => window.__rig.store.currentSong().patch.slots[0].eq?.b2?.type === 'peak');
  await page.mouse.dblclick(await geo('xOfMidi', 84), await geo('yOfDb', -7));
  await until(() => window.__rig.store.currentSong().patch.slots[0].eq?.b3?.type === 'peak');
  const e = await eq();
  assert.deepEqual(Object.keys(e.b3).sort(), ['db', 'hz', 'on', 'q', 'type'], 'b3 has all five rows');
  assert.equal(e.b1.type, 'lowshelf', 'b1 migrated from the legacy low shelf');
  const hz = e.b3.hz;
  const flat = await resp(hz);
  assert.ok(Math.abs(flat) < 0.5, `0 dB band leaves the curve flat at ${Math.round(hz)} Hz (${flat})`);
  // +6 dB on the selected band (b3) with the keyboard: ↑ = +0.5 dB
  await page.locator('#view-edit .eqk-plot').focus();
  await page.keyboard.press('3');
  for (let k = 0; k < 12; k++) await page.keyboard.press('ArrowUp');
  await until(() => Math.abs((window.__rig.store.currentSong().patch.slots[0].eq?.b3?.db ?? 0) - 6) < 0.01);
  await until((f) => {
    const src = typeof window.__rig.controller.getEqResponse === 'function' ? window.__rig.controller : window.__rig.engine;
    const r = src.getEqResponse(0, new Float32Array([f]));
    return r && Math.abs(r[0] - 6) < 0.5;
  }, hz, 10000);
  assert.ok(Math.abs((await ev(() => window.__rig.engine.getParam('slots.0.eq.b3.db'))) - 6) < 1e-6, 'engine b3 +6 dB');
  // the header sparkline shows once the EQ is not flat; the Tone summary counts bands
  await until(() => !document.querySelector('#view-edit .ev2-slot-eqmini').hidden);
  assert.match(await page.textContent('#view-edit details[data-sec="slot0-tone"] .ev2-sec-sum'), /^Shaped · \d+ bands?$/);
  // Warmth (the smart slider) now moves b1, the migrated low shelf — not the dead legacy row
  await ev(() => {
    const input = document.querySelector('#view-edit [data-bind="slots.0.eq.low"] input[type=range]');
    input.value = '750';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await until(() => Math.abs((window.__rig.store.currentSong().patch.slots[0].eq?.b1?.db ?? 0) - 6) < 0.05);
  await until(() => Math.abs(window.__rig.engine.getParam('slots.0.eq.b1.db') - 6) < 0.05);
  await ev(() => document.querySelector('#view-edit .eqk')?.scrollIntoView({ block: 'end' }));
  await shot('edit-tone-eq');
  // put the song's EQ back (one store write of the whole object, like an import)
  await ev((b) => window.__rig.store.set(`songs.${window.__rig.store.currentSong().id}.patch.slots.0.eq`, b), before);
  noErrors();
});

test('integration: song switches while Tone is open destroy the editor; no store subscriptions leak', async () => {
  // count live store subscriptions from now on (the EQ and its sparkline subscribe to the store directly)
  await ev(() => {
    const st = window.__rig.store;
    if (st.__subWrapped) return;
    const orig = st.subscribe.bind(st);
    window.__subs = 0;
    st.subscribe = (fn) => {
      window.__subs += 1;
      const off = orig(fn);
      let done = false;
      return () => {
        if (!done) window.__subs -= 1;
        done = true;
        return off();
      };
    };
    st.__subWrapped = true;
  });
  // two songs whose slot 0 instruments differ, so each switch rebuilds the slot body
  const [a, b] = await ev(() => {
    const st = window.__rig.store;
    const cur = st.currentSong();
    const key = (s) => JSON.stringify(s.patch.slots[0]?.instrument || null);
    const other = st.navIds().map((id) => st.getSong(id)).find((s) => s.patch.slots[0] && key(s) !== key(cur));
    return [cur.id, other.id];
  });
  // re-open Tone under the wrapper so its subscription is counted
  await ev(() => {
    document.querySelector('#view-edit details[data-sec="slot0-tone"]').open = false;
  });
  await until(() => !window.__rig.views.edit._debug.instance('slot')._debug.tone().mounted);
  await ev(() => {
    document.querySelector('#view-edit details[data-sec="slot0-tone"]').open = true;
  });
  await until(() => window.__rig.views.edit._debug.instance('slot')._debug.tone().mounted);
  const s0 = await toneState();
  const subs0 = await ev(() => window.__subs);
  assert.ok(subs0 >= 1, `the open editor subscribes (${subs0})`);
  for (const id of [b, a, b, a]) {
    const old = await ev(() => window.__rig.views.edit._debug.instance('slot')._debug.tone().inst);
    assert.ok(old !== undefined);
    await selectSong(id);
    await until(() => {
      const d = window.__rig.views.edit._debug.instance('slot')._debug.tone();
      return d.mounted && !!document.querySelector('#view-edit .ev2-slot-tone-host .eqk');
    }, null, 10000);
  }
  const s1 = await toneState();
  assert.equal(s1.created - s0.created, 4, 'one editor per rebuild (Tone stays open across songs)');
  assert.equal(s1.destroyed - s0.destroyed, 4, 'every replaced editor was destroyed');
  assert.equal(s1.created - s1.destroyed, 1, 'exactly one live editor');
  assert.equal(await ev(() => window.__subs), subs0, 'store subscriptions back to where they were');
  assert.equal(await ev(() => document.querySelectorAll('#view-edit .eqk').length), 1);
  // closing Advanced destroys it too
  await ev(() => {
    document.querySelector('#view-edit details[data-sec="slot0-adv"]').open = false;
  });
  await until(() => !window.__rig.views.edit._debug.instance('slot')._debug.tone().mounted);
  assert.equal(await ev(() => window.__subs), subs0 - 1, 'the closed editor unsubscribed');
  noErrors();
});

test('integration: Perform ⇄ Edit keep one Revert baseline (same changed paths, same count)', async () => {
  await selectSong('factory:sunday-pad-piano');
  // in Perform: one change (Keys octave) → Perform and Edit agree
  await page.click('#view-switch button[data-value="perform"]');
  await until(() => !document.getElementById('view-perform').hidden);
  await ev(() => window.__rig.store.set('slots.0.octave', 1));
  await until(() => window.__rig.views.perform.changedPaths.includes('patch.slots.0.octave'));
  let c = await bothChanges();
  assert.deepEqual(c.edit, c.perform, 'Edit (hidden) counts against Perform’s snapshot');
  assert.equal(c.revert, '1');
  // in Edit: the Keys tab has the dot, the footer says 1; a second change (Pad reverb send) → both 2
  await page.click('#view-switch button[data-value="edit"]');
  await until(() => !document.getElementById('view-edit').hidden);
  await selectBlock('slot:0');
  await until(() => !document.querySelector('#view-edit .ev2-tab[data-block="slot:0"] .ev2-tab-cd').hidden);
  await until(() => /^1 change since/.test(document.querySelector('#view-edit .ev2-slot-chgtext')?.textContent || ''));
  await ev(() => window.__rig.store.set('slots.1.sends.reverb', 0.95));
  await until(() => window.__rig.views.edit.editState.changes.size === 2);
  c = await bothChanges();
  assert.deepEqual(c.edit, c.perform);
  assert.equal(c.edit.length, 2);
  // back to Perform: leaving Edit makes the edits the new baseline (perform.js) — and Edit follows it
  await page.click('#view-switch button[data-value="perform"]');
  await until(() => !document.getElementById('view-perform').hidden);
  await until(() => window.__rig.views.perform.changedPaths.length === 0);
  c = await bothChanges();
  assert.deepEqual(c.edit, [], 'Edit’s dots clear with Perform’s new snapshot');
  assert.equal(c.revert, '0');
  await page.click('#view-switch button[data-value="edit"]');
  await until(() => !document.getElementById('view-edit').hidden);
  assert.equal(await ev(() => document.querySelector('#view-edit .ev2-tab[data-block="slot:0"] .ev2-tab-cd').hidden),
    true);
  await ev(() => {
    window.__rig.store.set('slots.0.octave', 0);
    window.__rig.store.set('slots.1.sends.reverb', 0.5);
  });
  c = await bothChanges();
  assert.deepEqual(c.edit, c.perform);
  noErrors();
});

test('integration: round3-edit M1 — a chip panel left open over a keyboard view switch never eats Esc (Panic) or a tap',
  async () => {
    await ev(() => {
      if (!window.__panics) {
        window.__panics = { n: 0 };
        window.__rig.controller.addEventListener('action', (e) => {
          if (e.detail && e.detail.type === 'panic') window.__panics.n += 1;
        });
      }
    });
    const panics = () => ev(() => window.__panics.n);
    const overlays = () => ev(async () => (await import('/js/views/components/overlay.js')).openOverlayCount());
    await page.click('#view-switch button[data-value="edit"]');
    await until(() => !document.getElementById('view-edit').hidden);
    await selectSong('factory:sunday-pad-piano');
    await selectBlock('slot:0');
    // Edit: open Keys › Space, then Ctrl+E (Chrome; ⌘E in the Mac app goes through the same toggleView)
    await page.click('#view-edit [data-testid="ev2-slot-reverb-0"]');
    await until(() => !!document.querySelector('#view-edit .step-panel'));
    await ev(() => document.activeElement?.blur?.());
    await page.keyboard.press('Control+e');
    await until(() => !document.getElementById('view-perform').hidden);
    assert.equal(await ev(() => !!document.querySelector('#view-edit .step-panel')), false, 'the Edit panel closed');
    assert.equal(await overlays(), 0);
    const p0 = await panics();
    await page.keyboard.press('Escape');
    await until((n) => window.__panics.n === n + 1, p0);
    // the first tap on a Perform strip chip opens its panel (nothing invisible swallows it)
    await page.click('[data-testid="slot-space-0"]');
    await until(() => !!document.querySelector('#view-perform .step-panel'));
    // reverse: a Perform panel open, Ctrl+E to Edit, back to Perform — Esc panics on the first press
    await page.keyboard.press('Control+e');
    await until(() => !document.getElementById('view-edit').hidden);
    await page.keyboard.press('Escape'); // Edit: never Panic; the hidden Perform panel is pruned, not "closed by Esc"
    assert.equal(await panics(), p0 + 1);
    assert.equal(await ev(() => !!document.querySelector('#view-perform .step-panel')), false, 'hidden panel pruned');
    await page.keyboard.press('Control+e');
    await until(() => !document.getElementById('view-perform').hidden);
    await page.keyboard.press('Escape');
    await until((n) => window.__panics.n === n + 2, p0);
    // the overlay stack itself: an overlay inside a [hidden] view is closed ('hidden') instead of eating Esc
    const r = await ev(async () => {
      const m = await import('/js/views/components/overlay.js');
      const el = document.createElement('div');
      document.getElementById('view-edit').append(el);
      const log = [];
      m.openOverlay({ el, onClose: (why) => log.push(why) });
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      window.dispatchEvent(e);
      el.remove();
      return { log, prevented: e.defaultPrevented, n: m.openOverlayCount() };
    });
    assert.deepEqual(r, { log: ['hidden'], prevented: false, n: 0 });
    await selectBlock('slot:0');
    noErrors();
  });

test('integration: round4-edit-lib M1 — ⌘Z in Perform after a song switch leaves the previous song’s notes alone',
  async () => {
    // E6d: Electron's Edit ▸ Undo (role editMenu, main.js) is webContents.undo(), a frame-level undo like Ctrl+Z here
    await page.click('#view-switch button[data-value="edit"]');
    await until(() => !document.getElementById('view-edit').hidden);
    const a = await selectSong('factory:sunday-pad-piano');
    const b = await ev(() => {
      const st = window.__rig.store.get();
      return st.songOrder.find((x) => st.songs[x].factoryId === 'factory:organ-swell');
    });
    assert.ok(b, 'organ-swell');
    await ev(([x, y]) => {
      window.__rig.store.set(`songs.${x}.notes`, 'Song A notes.');
      window.__rig.store.set(`songs.${y}.notes`, 'Song B notes, not A.');
    }, [a, b]);
    await selectBlock('song', { focus: 'notes' });
    const area = '#view-edit textarea.ev2-song-notes';
    await page.waitForSelector(area);
    await page.click(area);
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Typed in A.');
    await ev(() => document.activeElement.blur()); // blur flushes
    const typed = 'Song A notes. Typed in A.';
    assert.equal(await ev((x) => window.__rig.store.getSong(x).notes, a), typed);
    await selectSong(b); // MIDI Next / a setlist tap
    await until((s) => document.querySelector(s).value === 'Song B notes, not A.', area);
    await page.click('#view-switch button[data-value="perform"]');
    await until(() => !document.getElementById('view-perform').hidden);
    await ev((s) => {
      window.__m1ev = [];
      document.querySelector(s).addEventListener('input', (e) => window.__m1ev.push(e.inputType), { once: true });
    }, area);
    await ev(() => document.activeElement?.blur?.());
    await page.keyboard.press('Control+z');
    await sleep(1000); // > the 500 ms notes debounce
    assert.deepEqual(await ev(() => window.__m1ev), ['historyUndo'], 'the undo reached the hidden notes field');
    assert.equal(await ev((x) => window.__rig.store.getSong(x).notes, a), typed, 'A keeps its notes (was B’s)');
    assert.equal(await ev((y) => window.__rig.store.getSong(y).notes, b), 'Song B notes, not A.', 'B unchanged');
    await ev(([x, y]) => {
      window.__rig.store.set(`songs.${x}.notes`, '');
      window.__rig.store.set(`songs.${y}.notes`, '');
    }, [a, b]);
    await selectSong(a);
    noErrors();
  });

test('integration: Perform’s empty-slot “+” opens Edit on that slot with the instrument menu open', async () => {
  await page.click('#view-switch button[data-value="perform"]');
  await until(() => !document.getElementById('view-perform').hidden);
  const i = await ev(() => window.__rig.store.currentSong().patch.slots.findIndex((x) => !x));
  assert.ok(i >= 0, 'the song has an empty slot');
  await page.click(`[data-testid="slot-add-${i}"]`);
  await until((k) => !document.getElementById('view-edit').hidden
    && window.__rig.views.edit.editState.selected === `slot:${k}`
    && !document.querySelector('#view-edit .ev2-slot-menu')?.hidden, i);
  assert.equal(await ev(() => window.__rig.views.edit.editState.opts.focus), 'instrument');
  await page.keyboard.press('Escape'); // closes the menu, never panics
  await until(() => document.querySelector('#view-edit .ev2-slot-menu').hidden);
  await selectBlock('slot:0');
  noErrors();
});

test('integration: sections are collapsed by default and their open state survives a reload', async () => {
  const st = await ev(() => JSON.parse(localStorage.getItem('worship-rig.edit2.sections') || '{}'));
  // everything this file opened was recorded; a section never touched is closed
  await selectBlock('master');
  await until(() => !!document.querySelector('#view-edit details[data-sec="master-tape"]'));
  const closed = await ev((s) => [...document.querySelectorAll('#view-edit details.ev2-sec')]
    .filter((d) => !(d.dataset.sec in s)).every((d) => !d.open), st);
  assert.ok(closed, 'untouched sections start closed');
  await ev(() => {
    document.querySelector('#view-edit details[data-sec="master-tape"]').open = true;
  });
  await until(() => JSON.parse(localStorage.getItem('worship-rig.edit2.sections') || '{}')['master-tape'] === true);
  await page.reload();
  await until(() => !!(window.__rig && window.__rig.views && window.__rig.views.edit), null, 30000);
  await until(() => window.__rig.engine.ctx && window.__rig.engine.ctx.state === 'running', null, 30000);
  await loaded();
  const overlay = await page.$('#overlay-start:not([hidden])');
  if (overlay) await overlay.click();
  await until(() => !document.getElementById('view-edit').hidden); // settings.view = 'edit' persisted
  await selectBlock('master');
  await until(() => document.querySelector('#view-edit details[data-sec="master-tape"]')?.open === true);
  noErrors();
});

test('integration: nothing lost — every PARAMS address a factory song uses has a control (≤ 2 clicks)', async () => {
  const r = await ev(async () => {
    const { describe } = await import('/js/shared/params.js');
    const st = window.__rig.store.get();
    const v = window.__rig.views.edit;
    // addresses (slot index → <i>) used by the factory songs
    const want = new Set();
    const walk = (o, pre, fn) => {
      for (const [k, x] of Object.entries(o || {})) {
        const p = pre ? `${pre}.${k}` : k;
        if (x && typeof x === 'object' && !Array.isArray(x)) walk(x, p, fn);
        else fn(p, x);
      }
    };
    for (const id of st.songOrder) {
      const s = st.songs[id];
      if (!s.factoryId) continue;
      s.patch.slots.forEach((sl, i) => sl && walk(sl, `slots.${i}`, (p) => {
        if (/\.(instrument|muted)(\.|$)|\.params\./.test(p)) return; // instrument: the menu; params: per instrument
        want.add(p.replace(/^slots\.\d+/, 'slots.<i>'));
      }));
      walk(s.patch.fx, 'fx', (p) => want.add(p.replace(/^fx\.master\./, 'master.')));
      walk(s.drone, 'drone', (p) => want.add(p));
      for (const k of ['modWheel', 'expression', 'volume', 'bend', 'swell']) {
        walk(s.patch[k], `song.patch.${k}`, (p) => want.add(p));
      }
      for (const k of ['hearIn', 'playIn', 'transposeOctave', 'minor']) if (k in s) want.add(`song.${k}`);
    }
    // what Edit binds: every block, top-level sections opened (1 click on the tab + 1 on a section) vs all opened
    const collect = (deep) => {
      const got = new Set();
      for (const b of ['slot:0', 'slot:1', 'slot:2', 'slot:3', 'drone', 'effects', 'master', 'song']) {
        v.editState.select(b);
        for (const d of document.querySelectorAll('#view-edit .ev2-body details')) {
          if (deep || !d.parentElement.closest('details')) d.open = true;
        }
        for (const e of document.querySelectorAll('#view-edit [data-bind]')) {
          got.add(e.dataset.bind.replace(/^slots\.\d+/, 'slots.<i>'));
        }
      }
      return got;
    };
    const two = collect(false);
    const all = collect(true);
    // the drone's source and switches are bound as song.drone.* ('song.<field>' grammar)
    const norm = (a) => a.replace(/^drone\.(mode|chordFollow|continueAcrossSongs|minorUsesRelativeMajorFile)$/,
      'song.drone.$1');
    const has = (set, a) => set.has(a) || set.has(norm(a)) || [...set].some((x) => x === a || a.startsWith(`${x}.`));
    const valid = [...want].filter((a) => !!describe(a.replace('<i>', '0')) || a.startsWith('song.'));
    v.editState.select('slot:0');
    return {
      n: valid.length,
      missing: valid.filter((a) => !has(all, a)).sort(),
      deep: valid.filter((a) => has(all, a) && !has(two, a)).sort(),
    };
  });
  console.log(`  nothing-lost: ${r.n} addresses; missing ${JSON.stringify(r.missing)}; 3+ clicks ${JSON.stringify(r.deep)}`);
  // The slot EQ rows (eq.*) are edited in the Tone editor (canvas + table, no data-bind); tempo/name/notes are
  // song-bound text fields. Everything else must be bound.
  const allowed = (a) => /^slots\.<i>\.eq\./.test(a);
  assert.deepEqual(r.missing.filter((a) => !allowed(a)), [], 'unbound addresses');
  noErrors();
});
