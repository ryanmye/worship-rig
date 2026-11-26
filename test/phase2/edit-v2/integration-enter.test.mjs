// fixenter (review S-cue-go S7 follow-up): Enter in a text or number field commits that field and never GOes, in
// Edit, Settings and Perform; Enter with nothing focused on Perform still GOes. Regression: after Lane S (10c3ec7)
// the controller judged "nothing focused" from document.activeElement when the Enter reached the document. Edit's
// note and tempo fields blur themselves on Enter (blur commits via 'change'), so by then body had focus, and the
// Enter switched the song: edit-v2 slot / song failed ("Lowest note", tempo). The real app hid it in Edit because
// Edit sets settings.view = 'edit'; the panel harness keeps the store default 'perform', so it showed there, and so
// would any Perform field that commits the same way.
//
// Part 1 runs the real app (app/index.html + main.js, own server); part 2 the edit-v2 harness (the whole Edit view,
// real store / engine / controller, settings.view 'perform'). Without the controller fix, the Perform blur-on-Enter
// field (part 1) and both harness fields (part 2) GO.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, mountPanelForTest, shutdown } from './harness.mjs';
import { MIDI_PERMISSIONS, pinTheme } from '../../integration/lib.mjs';

const require = createRequire(import.meta.url);
const { createServer } = require(path.join(ROOT, 'server.js'));

let server;
let browser;
let context;
let page;
const errors = [];
const ev = (fn, arg) => page.evaluate(fn, arg);
const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Where the controller stands: the current song, a GO in flight, the cue. */
const goState = (p) => p.evaluate(() => {
  const r = window.__rig;
  return { songId: r.store.get().settings.currentSongId, go: r.controller.status.go, cue: r.controller.status.cue };
});
/** Wait until the controller has the current song loaded (a GO that waited for samples has landed too). */
const settled = (p) => p.waitForFunction(() => {
  const r = window.__rig;
  return r.controller.status.songId === r.store.get().settings.currentSongId && !r.controller.status.loading
    && !r.controller.status.go;
}, null, { timeout: 60000, polling: 50 });

/**
 * Type `value` into `sel`, press Enter, and check the store got `want` (read by `read`, page-side) while the song,
 * the GO state and the cue stayed as they were. The wait after Enter covers GO's own path (a GO switches the store at
 * once, or sets status.go while it waits for samples).
 */
async function enterCommits(p, sel, value, read, want, label) {
  const before = await goState(p);
  await p.fill(sel, value);
  await p.press(sel, 'Enter');
  await p.waitForFunction(([fn, w]) => {
    const v = new Function(`return (${fn})`)()();
    return v === w;
  }, [read.toString(), want], { timeout: 15000, polling: 50 }).catch(async () => {
    const got = await p.evaluate((fn) => new Function(`return (${fn})`)()(), read.toString());
    const now = await goState(p);
    assert.fail(`${label}: Enter did not commit ${JSON.stringify(want)} (store has ${JSON.stringify(got)}; song `
      + `${before.songId} → ${now.songId}, go ${JSON.stringify(now.go)}; a song change means the Enter GOed)`);
  });
  await sleep(400);
  const after = await goState(p);
  assert.deepEqual(after, before, `${label}: Enter in the field never GOes (song / go / cue unchanged)`);
}

/**
 * Page-side: mount two fields under `parentSel`, the two ways the app's fields commit: a number field committing on
 * 'change' (Chromium fires it on Enter) and a text field that blurs itself on Enter and commits on 'change' (Edit's
 * note / tempo pattern). Neither Perform nor (in Chrome) Settings has a text or number field of its own today: the
 * chart import dialog's tempo only reads on Save, Settings has ranges, selects and the Mac-only importer search.
 */
function mountFields(p, parentSel, tag) {
  return p.evaluate(([s, t]) => {
    const host = document.querySelector(s);
    if (!host) throw new Error(`no ${s}`);
    document.getElementById(`fx-enter-${t}`)?.remove();
    const wrap = document.createElement('div');
    wrap.id = `fx-enter-${t}`;
    const num = document.createElement('input');
    num.type = 'number';
    num.className = 'fx-num';
    num.setAttribute('aria-label', 'test tempo');
    num.addEventListener('change', () => window.__rig.store.set('song.tempo', Number(num.value)));
    const txt = document.createElement('input');
    txt.type = 'text';
    txt.className = 'fx-blur';
    txt.setAttribute('aria-label', 'test notes');
    txt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') txt.blur(); // blur commits (change), like panels/song.js tempo and slot.js note fields
    });
    txt.addEventListener('change', () => window.__rig.store.set('song.notes', txt.value));
    wrap.append(num, txt);
    host.append(wrap);
  }, [parentSel, tag]);
}
const readTempo = () => window.__rig.store.currentSong().tempo;
const readNotes = () => window.__rig.store.currentSong().notes;
// what the controller pushed for the field (store → engine diff), so the commit went all the way through
const readLow = () => window.__rig.engine.getParam('slots.0.lowNote');

before(async () => {
  server = createServer({ appDir: path.join(ROOT, 'app'), port: 0 });
  const info = await server.listen();
  const origin = `http://127.0.0.1:${info.port}`;
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await pinTheme(context, 'classic');
  await context.grantPermissions(MIDI_PERMISSIONS, { origin });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url || '?'}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${origin}/`, { timeout: 30000 });
  await until(() => !!(window.__rig && window.__rig.views), null, 30000);
  await until(() => window.__rig.engine.ctx && window.__rig.engine.ctx.state === 'running', null, 30000);
  await ev(() => window.__rig.viewsReady);
  await settled(page);
  const overlay = await page.$('#overlay-start:not([hidden])');
  if (overlay) await overlay.click();
});
after(async () => {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await server?.close?.();
  await shutdown();
});

// ---------------------------------------------------------------------------------------------------------------
test('enter: Perform with nothing focused — Enter is GO (the control the field cases below lean on)', async () => {
  assert.equal(await ev(() => window.__rig.store.get().settings.view), 'perform');
  await ev(() => document.activeElement?.blur?.());
  const before = await goState(page);
  const next = await ev(() => window.__rig.store.neighbors().next?.id || null);
  assert.ok(next, 'the library has a next song');
  await page.keyboard.press('Enter');
  await until((n) => window.__rig.store.get().settings.currentSongId === n || !!window.__rig.controller.status.go,
    next, 15000);
  await settled(page);
  assert.notEqual((await goState(page)).songId, before.songId, 'GO switched the song');
});

test('enter: Perform — Enter in a number field and in a blur-on-Enter text field commits, never GOes', async () => {
  await settled(page);
  await mountFields(page, '#view-perform', 'perform');
  await enterCommits(page, '#fx-enter-perform .fx-num', '97', readTempo, 97, 'Perform number field');
  // the case that GOed before the fix: the field's own keydown blurs it, so body has focus when Enter bubbles
  await enterCommits(page, '#fx-enter-perform .fx-blur', 'enter perform', readNotes, 'enter perform',
    'Perform blur-on-Enter field');
  await ev(() => document.getElementById('fx-enter-perform').remove());
});

test('enter: Settings — Enter in either kind of field commits, never GOes, Settings stays open', async () => {
  await page.click('#btn-settings');
  await until(() => document.body.classList.contains('settings-open'));
  const inner = '#view-settings [role="dialog"]';
  const dlg = await ev((s) => (document.querySelector(s) ? s : '#view-settings'), inner);
  await mountFields(page, dlg, 'settings');
  await enterCommits(page, '#fx-enter-settings .fx-num', '101', readTempo, 101, 'Settings number field');
  await enterCommits(page, '#fx-enter-settings .fx-blur', 'enter settings', readNotes, 'enter settings',
    'Settings blur-on-Enter field');
  assert.ok(await ev(() => document.body.classList.contains('settings-open')), 'Settings is still open');
  await ev(() => document.getElementById('fx-enter-settings').remove());
  await page.keyboard.press('Escape');
  await until(() => !document.body.classList.contains('settings-open'));
});

test('enter: Edit (real app) — Lowest note and tempo commit on Enter, never GO', async () => {
  await settled(page);
  const id = await ev(() => {
    const st = window.__rig.store.get();
    return st.songOrder.find((k) => st.songs[k].factoryId === 'factory:sunday-pad-piano');
  });
  await ev((i) => window.__rig.controller.selectSong(i), id);
  await settled(page);
  await page.click('#view-switch button[data-value="edit"]');
  await until(() => !document.getElementById('view-edit').hidden && !!document.querySelector('#view-edit .ev2'));
  await ev(() => window.__rig.views.edit.editState.select('slot:0', { focus: 'range' }));
  const low = '#view-edit [data-bind="slots.0.lowNote"]';
  await until((s) => !!document.querySelector(s)?.getClientRects().length, low);
  await ev(() => document.activeElement?.blur?.());
  await enterCommits(page, low, 'C3', readLow, 48, 'Edit Lowest note');
  await ev(() => window.__rig.views.edit.editState.select('song', { focus: 'tempo' }));
  const tempo = '#view-edit .ev2-song-tempo';
  await until((s) => !!document.querySelector(s)?.getClientRects().length, tempo);
  await enterCommits(page, tempo, '92', readTempo, 92, 'Edit tempo');
  assert.equal(await ev(() => window.__rig.store.get().settings.view), 'edit');
  assert.deepEqual(errors, [], `console errors:\n${errors.join('\n')}`);
});

test('enter: Edit panels under settings.view "perform" (edit-v2 harness) — Enter commits, never GOes', async () => {
  // the state that showed the bug: Edit's fields mounted while the controller thinks Perform is up, a GO target set
  const t = await mountPanelForTest(null, { full: true, song: 'factory:sunday-pad-piano' });
  try {
    assert.equal(await t.ev(() => window.__rig.store.get().settings.view), 'perform');
    assert.ok(await t.ev(() => !!window.__rig.store.neighbors().next), 'a next song (GO has a target)');
    await t.select('slot:0', { focus: 'range' });
    const low = `${t.host} [data-bind="slots.0.lowNote"]`;
    await t.until((s) => !!document.querySelector(s)?.getClientRects().length, low);
    await t.ev(() => document.activeElement?.blur?.());
    await enterCommits(t.page, low, 'C3', readLow, 48,
      'harness Lowest note');
    await t.select('song', { focus: 'tempo' });
    const tempo = `${t.host} .ev2-song-tempo`;
    await t.until((s) => !!document.querySelector(s)?.getClientRects().length, tempo);
    await enterCommits(t.page, tempo, '96', readTempo, 96, 'harness tempo');
    t.assertNoConsoleErrors();
  } finally {
    await t.close();
  }
});
