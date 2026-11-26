#!/usr/bin/env node
// UI v6 U7a suite: the Song bank browser and Try it (native DECISIONS D17; views/v6/bank/; mockup
// native/docs/design/mockups/song-bank.html). The real app in Chromium against server.js with My Samples on and two
// bank packs in a temp folder (invented songs, real built-in instruments):
//   no pack: the entries are disabled and nothing is requested; packs appear (Rescan): the browser opens over the
//   stage from Setlist › + Add song › From the Song bank, from Settings › Sounds & Samples (closing Settings) and
//   from Edit's Song bank… (openSettings({section:'bank'})); the keys and PANIC stay live under it; filters (search,
//   key, tempo, feel, packs), detail facts and "also in this song" (only what the song has); Add to library (the same
//   meta.packSongs record as today's add), Add to setlist; Try it (storage bytes, export, meta.edited, the library
//   order unchanged, even after fader moves in the trial), Back (song, setlist entry, Revert snapshot), Keep (added +
//   selected), the banner's Add to setlist, Perform lock, reload ends a trial; My library mode; iPad portrait layout;
//   flag off: today's Settings list, nothing of v6 fetched; zero console.error and no HTTP ≥ 400. U7c: the song menu
//   (⋯ by the song name) on a trial song.
//   node test/phase2/ui-v6-bank/run.mjs   (screenshots → ./screenshots or UI7A_SHOTS=<dir>; UI7A_ONLY=<regex>)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { MIDI_PERMISSIONS, waitRigReady, pinTheme } from '../../integration/lib.mjs';
import { blankSong, defaultFx } from '../../../app/js/presets.js';
import { defaultSlot } from '../../../app/js/shared/params.js';
import { SPACE_PRESETS, ECHO_PRESETS } from '../../../app/js/shared/fx-presets.js';
import { polish1BankTests } from './polish1.tests.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const APP = path.join(ROOT, 'app');
const SHOTS = process.env.UI7A_SHOTS ? path.resolve(process.env.UI7A_SHOTS) : path.join(HERE, 'screenshots');
const ONLY = process.env.UI7A_ONLY ? new RegExp(process.env.UI7A_ONLY) : null;
const { createServer } = require(path.join(ROOT, 'server.js'));
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const T = async (name, fn) => {
  if (ONLY && !ONLY.test(name) && !/^(no pack|packs appear|zero console)/.test(name)) return;
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

// ---------------------------------------------------------------- the fixture: two bank packs (invented songs)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-u7a-'));
const samples = path.join(tmp, 'Samples');
fs.mkdirSync(samples, { recursive: true });
const write = (f, data) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
};
const INST = {
  piano: ['sampler', 'salamander-piano'], pad: ['synth', 'warm-pad'], bass: ['synth', 'sub-bass'],
  strings: ['synth', 'strings'], rhodes: ['sampler', 'ep-rhodes'], lead: ['synth', 'square-lead'],
  organ: ['organ', 'church'],
};
const preset = (list, id) => list.find((p) => p.id === id).params;
function fxWith(space, echo) {
  const fx = defaultFx();
  for (const [p, v] of Object.entries({ ...(space ? preset(SPACE_PRESETS, space) : { 'fx.reverb.returnGain': 0 }),
    ...(echo ? preset(ECHO_PRESETS, echo) : { 'fx.delay.returnGain': 0 }) })) {
    const [, unit, k] = p.split('.');
    fx[unit][k] = v;
  }
  return fx;
}
/** A song body: instruments, key (pc), tempo, time, extras. */
function body(name, { inst, pc = 0, minor = false, tempo, timeSig, drone, space, echo, chart, scenes } = {}) {
  const s = blankSong({ name, playIn: pc, hearIn: pc, minor, tempo: tempo ?? null });
  s.patch.slots = inst.map((k, i) => defaultSlot(i, { type: INST[k][0], id: INST[k][1] }));
  s.patch.fx = fxWith(space, echo);
  if (timeSig) s.timeSig = timeSig;
  if (drone) s.drone = { ...s.drone, mode: 'synth' };
  if (chart) s.chart = { text: '{title: x}\n[C]Words here', format: 'chordpro' };
  if (scenes) {
    s.scenes = Array.from({ length: scenes }, (_, n) => ({ slots: inst.map(() => ({ gain: 0.4 + n / 10 })) }));
  }
  return s;
}
const exportOf = (song, bank) => ({ app: 'worship-rig', kind: 'song', schema: 2, song, bank });
const SUNDAY = [
  ['lantern.json', body('Lantern Hymn', { inst: ['piano', 'pad', 'strings'], pc: 3, tempo: 68, timeSig: '6/8',
    drone: true, space: 'cathedral', echo: 'dotted', chart: true, scenes: 2 }),
  { title: 'Lantern Hymn', artist: 'Northgate Testers', originalKey: 'Eb', bpm: 68, timeSig: '6/8',
    tags: ['hymn', 'gentle'] }],
  ['still.json', body('Still Water', { inst: ['piano', 'pad'], pc: 2, tempo: 72 }),
    { title: 'Still Water', artist: 'River Testhall', originalKey: 'D', bpm: 72, tags: ['ambient', 'communion'] }],
  ['anthem.json', body('Anthem Build', { inst: ['piano', 'lead', 'bass', 'strings'], pc: 11, tempo: 140 }),
    { title: 'Anthem Build', artist: 'Cityline Mock', originalKey: 'B', bpm: 140, tags: ['upbeat', 'big'] }],
  ['gate.json', body('Open Gate', { inst: ['piano', 'pad', 'organ'], pc: 9, tempo: 96, space: 'hall' }),
    { title: 'Open Gate', artist: 'Northgate Testers', originalKey: 'Bb', bpm: 96, tags: ['gentle'] }],
  ['harbour.json', body('Harbour Light', { inst: ['rhodes', 'lead', 'bass'], pc: 7, tempo: 128 }),
    { title: 'Harbour Light', artist: 'River Testhall', originalKey: 'G', bpm: 128, tags: ['upbeat'] }],
];
const DESK = [
  ['quiet.json', body('Quiet Room', { inst: ['rhodes', 'pad'], pc: 0, tempo: 60 }),
    { title: 'Quiet Room', artist: 'Ada Mockmoss', originalKey: 'C', bpm: 60, tags: ['ambient', 'prayer'] }],
  ['evening.json', body('Evening Prayer', { inst: ['piano', 'strings'], pc: 5, tempo: 64, timeSig: '3/4' }),
    { title: 'Evening Prayer', artist: 'Ada Mockmoss', originalKey: 'F', bpm: 64, tags: ['prayer', 'hymn'] }],
];
function writePacks() {
  write(path.join(samples, 'sunday-pack', 'pack.json'), { mode: 'bank', name: 'Sunday pack' });
  for (const [f, s, b] of SUNDAY) write(path.join(samples, 'sunday-pack', 'songs', f), exportOf(s, b));
  write(path.join(samples, 'desk-sounds', 'pack.json'), { mode: 'bank', name: 'Desk sounds' });
  for (const [f, s, b] of DESK) write(path.join(samples, 'desk-sounds', 'songs', f), exportOf(s, b));
}
const LANTERN = 'sunday-pack:lantern.json';
const QUIET = 'desk-sounds:quiet.json';
const HARBOUR = 'sunday-pack:harbour.json';
const GATE = 'sunday-pack:gate.json';

const server = createServer({ appDir: APP, port: 0, userSamples: [samples], docsDir: null });
const info = await server.listen();
const origin = `http://127.0.0.1:${info.port}`;
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });

const errors = [];
const v6Fetches = [];
const reqs = [];
let context;
let page;
async function newPage(viewport = { width: 1280, height: 800 }) {
  context = await browser.newContext({ viewport });
  await pinTheme(context, 'sanctuary');
  await context.grantPermissions([...MIDI_PERMISSIONS], { origin });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url || '?'}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    reqs.push(new URL(r.url()).pathname);
    if (/\/js\/views\/v6\/|styles-v6/.test(r.url())) v6Fetches.push(r.url());
  });
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
}
const ev = (fn, arg) => page.evaluate(fn, arg);
const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
const tid = (id) => `[data-testid="${id}"]`;
const settled = () => until(() => {
  const { controller, store } = window.__rig;
  return controller.status.songId === store.get().settings.currentSongId && !controller.status.loading;
}, null, 30000);
async function boot(q = '') {
  await page.goto(`${origin}/${q}`);
  await waitRigReady(page, { timeout: 40000 });
  const overlay = await page.$('#overlay-start:not([hidden])');
  if (overlay) await overlay.click();
  await settled();
  await ev(() => window.__rig.controller.packsReady);
}
const bankOpen = () => ev(() => !!window.__rig.views.v6?.bank?.isOpen);
const shownRows = () => ev(() => window.__rig.views.v6.bank.rows.map((r) => r.title));
const raw = () => ev(() => localStorage.getItem('rig.v1'));
async function hold(sel, ms = 850) {
  const b = await page.locator(sel).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}
async function openFromSetlist() {
  await page.click(tid('v6-sb-tab-setlist'));
  await page.click(tid('v6-sl-add'));
  await until(() => !!document.querySelector('[data-testid="v6-addsong"]'));
  await page.click(tid('v6-add-bank'));
  await until(() => window.__rig.views.v6.bank?.isOpen === true);
}
const closeBank = () => ev(() => window.__rig.views.v6.bank?.close());
const shot = (name) => page.screenshot({ path: path.join(SHOTS, name) });
/** Wait past the store's save debounce and flush it, so "nothing saved" means nothing (not "not yet"). */
const flushed = async () => {
  await page.waitForTimeout(450);
  await ev(() => window.__rig.store.persistNow());
};

try {
  await newPage();

  await T('no pack: today’s app asks nothing; v6 entries disabled; the browser says so', async () => {
    await boot();
    assert.equal(reqs.includes('/api/user-patches'), false, 'never requested without a pack');
    await boot('?ui6=1');
    await until(() => !!window.__rig.views.v6);
    await page.click(tid('v6-sb-tab-setlist'));
    await page.click(tid('v6-sl-add'));
    await until(() => !!document.querySelector('[data-testid="v6-addsong"]'));
    assert.equal(await page.isDisabled(tid('v6-add-bank')), true);
    assert.match(await page.textContent(tid('v6-add-bank')), /no Song bank packs/);
    await page.keyboard.press('Escape');
    await ev(() => window.__rig.ctx.openSettings({ section: 'samples' }));
    await until(() => !!document.querySelector('[data-testid="settings-open-bank"]'));
    assert.equal(await page.isDisabled(tid('settings-open-bank')), true);
    await ev(() => window.__rig.ctx.closeSettings());
    await ev(() => window.__rig.ctx.openBank());
    await until(() => !!document.querySelector('[data-testid="v6-bank-none"]'));
    assert.match(await page.textContent(tid('v6-bank-none')), /No Song bank songs yet/);
    await closeBank();
  });

  await T('packs appear: Rescan lists 7 bank songs; + Add song › From the Song bank opens the browser', async () => {
    writePacks();
    const r = await ev(async () => {
      const x = await window.__rig.controller.rescanPatchPacks();
      return { enabled: x.enabled, bank: x.bankSongs, added: x.added.length };
    });
    assert.deepEqual(r, { enabled: true, bank: 7, added: 0 });
    await openFromSetlist();
    assert.equal(await page.isVisible(tid('v6-bank')), true);
    assert.equal(await page.textContent(tid('v6-bank-count')), '7 songs from 2 packs in My Samples');
    assert.deepEqual(await shownRows(), ['Anthem Build', 'Evening Prayer', 'Harbour Light', 'Lantern Hymn',
      'Open Gate', 'Quiet Room', 'Still Water']);
    // over the strips and the sidebar; the left panel, keys, PANIC stay visible beside / under it
    const box = await ev(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const b = r('[data-testid="v6-bank"]');
      return { left: Math.round(b.left - r('[data-testid="v6-left"]').right),
        right: Math.round(r('[data-testid="v6-board"]').right - b.right),
        bottomAbovePiano: b.bottom <= r('[data-testid="v6-piano"]').top,
        strips: getComputedStyle(document.querySelector('.v6-stripsarea')).visibility,
        inert: document.querySelector('[data-testid="v6-right"]').inert };
    });
    assert.ok(box.left >= 0 && box.left <= 16, `beside the left panel (${box.left})`);
    assert.equal(box.right, 0);
    assert.deepEqual([box.bottomAbovePiano, box.strips, box.inert], [true, 'hidden', true]);
    await ev((id) => window.__rig.views.v6.bank.select(id), LANTERN);
    // the actions stay inside the browser at the smallest stage (snapshots row shown): the facts scroll instead
    const fit = await ev(() => document.querySelector('[data-testid="v6-bank-try"]').getBoundingClientRect().bottom
      <= document.querySelector('[data-testid="v6-bank"]').getBoundingClientRect().bottom + 1);
    assert.equal(fit, true);
    await shot('u7a-browse-1280.png');
  });

  await T('keys and PANIC stay live under the open browser', async () => {
    assert.equal(await bankOpen(), true);
    await ev(() => {
      window.__panics = 0;
      window.__rig.controller.addEventListener('action', (e) => {
        if (e.detail?.type === 'panic') window.__panics += 1;
      });
    });
    await page.click(tid('v6-panic'));
    await until(() => window.__panics >= 1);
    const k = await page.locator('[data-testid="v6-piano"] [data-note]').first().boundingBox();
    if (k) {
      await page.mouse.move(k.x + k.width / 2, k.y + k.height - 8);
      await page.mouse.down();
      await page.waitForTimeout(150);
      const held = await ev(() => window.__rig.controller._debug().held.length);
      await page.mouse.up();
      assert.ok(held >= 1, 'a key on the on-screen keyboard plays');
    }
    assert.equal(await bankOpen(), true, 'a tap outside does not close it');
  });

  // skeptic (UI6-U7a): D24.7 with the browser open. Off: Esc closes it first (no panic), the next Esc panics. On
  // ("Esc always panics"): one Esc panics and closes it. Typing in its search keeps the Esc (closes, never panics).
  await T('Esc: closes the browser first, then panics; "Esc always panics" does both; search keeps its Esc',
    async () => {
    const panics = () => ev(() => window.__panics);
    await page.click(tid('v6-bank-count'));
    const p0 = await panics();
    await page.keyboard.press('Escape');
    assert.equal(await bankOpen(), false, 'the first Esc closes the browser');
    assert.equal(await panics(), p0, '… and does not panic');
    await page.keyboard.press('Escape');
    await until((n) => window.__panics === n + 1, p0);
    await ev(() => window.__rig.store.set('settings.escPanics', true));
    try {
      await ev(() => window.__rig.ctx.openBank({}));
      await page.click(tid('v6-bank-count'));
      const p1 = await panics();
      await page.keyboard.press('Escape');
      await until((n) => window.__panics === n + 1, p1);
      assert.equal(await bankOpen(), false, 'on: the same Esc closes it');
      await ev(() => window.__rig.ctx.openBank({}));
      await page.fill(tid('v6-bank-search'), 'river');
      const p2 = await panics();
      // polish batch 1 (UI6-U7a O1): the first Esc in a search box with text clears it, the next one closes
      await page.keyboard.press('Escape');
      assert.equal(await bankOpen(), true);
      assert.equal(await page.inputValue(tid('v6-bank-search')), '');
      await page.keyboard.press('Escape');
      assert.equal(await bankOpen(), false);
      assert.equal(await panics(), p2, 'typing in the search: Esc never panics');
    } finally {
      await ev(() => window.__rig.store.set('settings.escPanics', null));
    }
    await ev(() => window.__rig.ctx.openBank({}));
    await page.fill(tid('v6-bank-search'), '');
    assert.equal(await bankOpen(), true);
  });

  await T('filters: search (title / artist, accents), key, tempo bands, feel tags (any of), packs, clear', async () => {
    const set = (f) => ev((x) => window.__rig.views.v6.bank.setFilter(x), f);
    await page.fill(tid('v6-bank-search'), 'river');
    await until(() => window.__rig.views.v6.bank.rows.length === 2);
    assert.deepEqual(await shownRows(), ['Harbour Light', 'Still Water']);
    await page.fill(tid('v6-bank-search'), 'LÁNTERN');
    await until(() => window.__rig.views.v6.bank.rows.length === 1);
    await page.fill(tid('v6-bank-search'), '');
    await page.click(tid('v6-bank-key-Eb'));
    assert.deepEqual(await shownRows(), ['Lantern Hymn']);
    assert.equal(await page.getAttribute(tid('v6-bank-key-Eb'), 'aria-pressed'), 'true');
    await page.click(tid('v6-bank-key-any'));
    await page.click(tid('v6-bank-tempo-slow'));
    assert.deepEqual(await shownRows(), ['Evening Prayer', 'Lantern Hymn', 'Quiet Room', 'Still Water']);
    await page.click(tid('v6-bank-tempo-mid'));
    assert.deepEqual(await shownRows(), ['Open Gate']);
    await page.click(tid('v6-bank-tempo-fast'));
    assert.deepEqual(await shownRows(), ['Anthem Build', 'Harbour Light']);
    await page.click(tid('v6-bank-tempo-any'));
    await page.click(tid('v6-bank-tag-prayer'));
    assert.deepEqual(await shownRows(), ['Evening Prayer', 'Quiet Room']);
    await page.click(tid('v6-bank-tag-communion'));
    assert.deepEqual(await shownRows(), ['Evening Prayer', 'Quiet Room', 'Still Water'], 'any chosen tag');
    await page.click(tid('v6-bank-tag-prayer'));
    await page.click(tid('v6-bank-tag-communion'));
    await page.click(tid('v6-bank-pack-desk-sounds'));
    assert.equal((await shownRows()).length, 5);
    assert.ok(!(await shownRows()).includes('Quiet Room'));
    // across groups every filter applies; no match → Clear filters
    await set({ key: 'C', tempo: 'fast' });
    await until(() => !!document.querySelector('[data-testid="v6-bank-clear"]'));
    assert.match(await page.textContent(tid('v6-bank-none')), /No song matches/);
    await page.click(tid('v6-bank-clear'));
    assert.equal((await shownRows()).length, 7);
    assert.equal(await page.isChecked(tid('v6-bank-pack-desk-sounds')), true);
  });

  await T('detail: facts, instruments, also in this song (only what the song has), tags', async () => {
    await ev((id) => window.__rig.views.v6.bank.select(id), LANTERN);
    const det = await ev(() => {
      const d = document.querySelector('[data-testid="v6-bank-detail"]');
      return {
        title: d.querySelector('h3').textContent,
        by: d.querySelector('.v6-bank-by').textContent,
        facts: [...d.querySelectorAll('.v6-bank-fact')].map((f) => [f.querySelector('small').textContent,
          f.querySelector('b').textContent]),
        inst: [...d.querySelectorAll('.v6-bank-inst span')].map((x) => x.textContent),
        also: d.querySelector('[data-testid="v6-bank-also"]')?.textContent,
        tags: [...d.querySelectorAll('.v6-bank-tg')].map((x) => x.textContent),
        dots: document.querySelectorAll('.v6-bank-row.sel .v6-bank-dots i').length,
      };
    });
    assert.equal(det.title, 'Lantern Hymn');
    assert.equal(det.by, 'Northgate Testers · from Sunday pack');
    assert.deepEqual(det.facts, [['Key', 'Eb'], ['Tempo', '68'], ['Time', '6/8'], ['Snapshots', '2']]);
    assert.equal(det.inst.length, 3);
    assert.ok(det.inst.every((n) => n && !/^(Keys|Pad|Extra|Bass)$/.test(n)), det.inst.join());
    assert.equal(det.also, 'Drone on Eb · Space: Cathedral · Echo: Dotted Eighth · chart ✓');
    assert.deepEqual(det.tags, ['hymn', 'gentle']);
    assert.equal(det.dots, 3);
    // a song with none of them: no "also" line; a reverb only: Space alone
    await ev((id) => window.__rig.views.v6.bank.select(id), QUIET);
    assert.equal(await page.$(tid('v6-bank-also')), null);
    await ev((id) => window.__rig.views.v6.bank.select(id), GATE);
    assert.equal(await page.textContent(tid('v6-bank-also')), 'Space: Hall');
    assert.match(await page.textContent(tid('v6-bank-detail')), /original Bb/, 'the bank key, where it differs');
  });

  await T('Add to library: today’s add (same record, at the end); In library badge; Add to setlist', async () => {
    const before = await ev(() => window.__rig.store.get().songOrder.length);
    await ev((id) => window.__rig.views.v6.bank.select(id), QUIET);
    await page.click(tid('v6-bank-addlib'));
    const r = await ev((pid) => {
      const { store } = window.__rig;
      const rec = store.get().meta.packSongs[pid];
      return { n: store.get().songOrder.length, last: store.get().songOrder.at(-1), rec,
        name: store.getSong(rec.id).name,
        inLib: window.__rig.controller.patchPacks().bank.find((b) => b.packId === pid).inLibrary };
    }, QUIET);
    assert.equal(r.n, before + 1);
    assert.equal(r.last, r.rec.id);
    assert.equal(r.inLib, r.rec.id);
    assert.equal(r.name, 'Quiet Room');
    await until((id) => /In library/.test(document.querySelector(`[data-testid="v6-bank-row-${id}"]`).textContent),
      QUIET);
    assert.equal(await page.isDisabled(tid('v6-bank-addlib')), true);
    // the same record a plain controller.addFromBank writes (sig = the fingerprint of what was added)
    const same = await ev(async (pid) => {
      const { songFingerprint } = await import('./js/shared/patch-packs.js');
      const { store } = window.__rig;
      const rec = store.get().meta.packSongs[pid];
      return rec.sig === songFingerprint(store.getSong(rec.id)) && window.__rig.controller.addFromBank(pid).existing;
    }, QUIET);
    assert.equal(same, true);
    // Add to setlist ▾ on a song not in the library: added to the library, then to the setlist
    await ev((id) => window.__rig.views.v6.bank.select(id), HARBOUR);
    const sl = await ev(() => window.__rig.store.currentSetlist().id);
    const n0 = await ev(() => window.__rig.store.currentSetlist().songIds.length);
    await page.click(tid('v6-bank-addset'));
    await until(() => !!document.querySelector('[data-testid="v6-bank-setpop"]'));
    await page.click(tid(`v6-bank-setlist-${sl}`));
    await until((n) => window.__rig.store.currentSetlist().songIds.length === n + 1, n0);
    const h = await ev((pid) => {
      const { store } = window.__rig;
      const id = store.get().meta.packSongs[pid]?.id;
      return { id, inSet: store.currentSetlist().songIds.at(-1) === id, inLib: store.get().songOrder.includes(id) };
    }, HARBOUR);
    assert.deepEqual([h.inSet, h.inLib], [true, true]);
    assert.equal(await bankOpen(), true, 'the browser stays open');
  });

  let prev;
  await T('Try it: the bank song plays; nothing saved (storage, export, edited, order); banner; Back restores',
    async () => {
      // a known place to come back to: the 2nd setlist entry, with an unsaved edit (Revert must still undo it)
      await closeBank();
      prev = await ev(async () => {
        const { store, controller } = window.__rig;
        const id = store.navIds()[1];
        await controller.selectSong(id, { index: 1 });
        const si = store.getSong(id).patch.slots.findIndex(Boolean);
        store.set(`songs.${id}.patch.slots.${si}.gain`, 0.21);
        return { id, si, name: store.getSong(id).name };
      });
      await settled();
      await flushed();
      const before = await ev(() => ({
        raw: localStorage.getItem('rig.v1'),
        exp: JSON.parse(window.__rig.store.exportJSON()),
        edited: window.__rig.store.get().meta.edited,
        order: window.__rig.store.get().songOrder.slice(),
        baseline: JSON.stringify(window.__rig.ctx.getBaseline()),
      }));
      await openFromSetlist();
      await ev((id) => window.__rig.views.v6.bank.select(id), LANTERN);
      await page.click(tid('v6-bank-try'));
      await until(() => window.__rig.controller.trial()?.playing === true);
      await settled();
      assert.equal(await bankOpen(), false, 'Try it closes the browser');
      const t = await ev(() => ({
        trial: window.__rig.controller.trial(),
        cur: window.__rig.store.currentSong().name,
        strips: document.querySelectorAll('.v6-strip:not([hidden])').length,
        song: document.querySelector('.v6-song')?.textContent,
      }));
      assert.equal(t.cur, 'Lantern Hymn');
      assert.equal(t.strips, 3);
      assert.equal(t.trial.prev.id, prev.id);
      assert.equal(await page.isVisible(tid('v6-trybar')), true);
      assert.equal(await page.textContent(tid('v6-try-name')), 'Trying “Lantern Hymn”');
      assert.equal(await page.textContent(tid('v6-try-meta')),
        'from the Song bank · Eb · 68 bpm · nothing saved yet');
      assert.equal(await page.textContent(tid('v6-try-back')), `Back to ${prev.name}`);
      await shot('u7a-trying-1280.png');
      // play with it: a fader and the ON tile, then wait past the save debounce
      await ev(() => {
        const inp = document.querySelector('[data-testid="v6-fader-0"] input');
        inp.value = String(Math.max(0, Number(inp.value) - 120));
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.click(tid('v6-on-1'));
      await until(() => window.__rig.store.currentSong().patch.slots[1].muted === true);
      await flushed();
      const during = await ev(() => ({
        raw: localStorage.getItem('rig.v1'),
        exp: JSON.parse(window.__rig.store.exportJSON()),
        edited: window.__rig.store.get().meta.edited,
        order: window.__rig.store.get().songOrder.slice(),
        sets: Object.values(window.__rig.store.get().setlists).flatMap((s) => s.songIds),
        trialIds: window.__rig.store.trialIds(),
      }));
      assert.equal(during.raw, before.raw, 'localStorage byte for byte');
      assert.deepEqual({ ...during.exp, exportedAt: 0 }, { ...before.exp, exportedAt: 0 }, 'export / backup source');
      assert.equal(during.edited, before.edited);
      assert.deepEqual(during.order, before.order);
      assert.equal(during.sets.some((x) => x.startsWith('trial:')), false);
      assert.equal(during.trialIds.length, 1);
      // Back
      await page.click(tid('v6-try-back'));
      await until(() => !window.__rig.controller.trial());
      await settled();
      const back = await ev(() => ({
        id: window.__rig.store.currentSong().id,
        index: window.__rig.store.currentIndex(),
        baseline: JSON.stringify(window.__rig.ctx.getBaseline()),
        trialIds: window.__rig.store.trialIds(),
      }));
      assert.deepEqual([back.id, back.index, back.trialIds], [prev.id, 1, []]);
      assert.equal(back.baseline, before.baseline, 'the Revert snapshot from before Try it');
      assert.equal(await page.isVisible(tid('v6-trybar')), false);
      await flushed();
      assert.equal(await raw(), before.raw, 'still nothing saved after Back');
      // Revert after Back = Revert before Try it
      await hold('[data-testid="v6-revert"]');
      await until((p) => window.__rig.store.getSong(p.id).patch.slots[p.si].gain !== 0.21, prev);
    });

  await T('Keep it: added to the library (today’s record) and selected; banner Add to setlist keeps + adds',
    async () => {
      await ev((pid) => window.__rig.controller.tryBankSong(pid), LANTERN);
      await until(() => window.__rig.controller.trial()?.playing === true);
      const n0 = await ev(() => window.__rig.store.get().songOrder.length);
      await page.click(tid('v6-try-keep'));
      await until(() => !window.__rig.controller.trial());
      await settled();
      const k = await ev((pid) => {
        const { store } = window.__rig;
        const rec = store.get().meta.packSongs[pid];
        return { n: store.get().songOrder.length, cur: store.currentSong().id, rec, last: store.get().songOrder.at(-1),
          name: store.currentSong().name };
      }, LANTERN);
      assert.equal(k.n, n0 + 1);
      assert.equal(k.cur, k.rec.id);
      assert.equal(k.last, k.rec.id);
      assert.equal(k.name, 'Lantern Hymn');
      assert.equal(await page.isVisible(tid('v6-trybar')), false);
      // the banner's Add to setlist ▾: keep + add to that setlist, that entry selected
      const evening = 'desk-sounds:evening.json';
      await ev((pid) => window.__rig.controller.tryBankSong(pid), evening);
      await until(() => window.__rig.controller.trial()?.playing === true);
      const sl = await ev(() => window.__rig.store.currentSetlist().id);
      await page.click(tid('v6-try-addset'));
      await until(() => !!document.querySelector('[data-testid="v6-bank-setpop"]'));
      await page.click(tid(`v6-bank-setlist-${sl}`));
      await until(() => !window.__rig.controller.trial());
      await settled();
      const e = await ev((pid) => {
        const { store } = window.__rig;
        const id = store.get().meta.packSongs[pid].id;
        return { cur: store.currentSong().id === id, last: store.currentSetlist().songIds.at(-1) === id,
          index: store.currentIndex() === store.currentSetlist().songIds.length - 1 };
      }, evening);
      assert.deepEqual(e, { cur: true, last: true, index: true });
    });

  await T('Perform lock: Try it / Add refused, Keep frozen, Back live', async () => {
    await ev(() => window.__rig.store.set('settings.performLock', true));
    await ev(() => window.__rig.ctx.openBank());
    await until(() => window.__rig.views.v6.bank?.isOpen === true);
    await ev((id) => window.__rig.views.v6.bank.select(id), 'sunday-pack:still.json');
    assert.equal(await page.isDisabled(tid('v6-bank-try')), true);
    assert.equal(await page.isDisabled(tid('v6-bank-addlib')), true);
    assert.equal(await page.isDisabled(tid('v6-bank-addset')), true);
    assert.deepEqual(await ev(() => window.__rig.controller.tryBankSong('sunday-pack:still.json')),
      { ok: false, error: 'perform-locked' });
    await closeBank();
    // a trial started before the lock: Keep frozen, Back works
    await ev(() => window.__rig.store.set('settings.performLock', false));
    const id0 = await ev(() => window.__rig.store.currentSong().id);
    await ev(() => window.__rig.controller.tryBankSong('sunday-pack:still.json'));
    await until(() => window.__rig.controller.trial()?.playing === true);
    await ev(() => window.__rig.store.set('settings.performLock', true));
    await until(() => document.querySelector('[data-testid="v6-try-keep"]').disabled);
    assert.equal(await page.isDisabled(tid('v6-try-addset')), true);
    assert.deepEqual(await ev(() => window.__rig.controller.keepTrial()), { ok: false, error: 'perform-locked' });
    await page.click(tid('v6-try-back'));
    await until(() => !window.__rig.controller.trial());
    assert.equal(await ev(() => window.__rig.store.currentSong().id), id0);
    await ev(() => window.__rig.store.set('settings.performLock', false));
  });

  // U7c (views/v6/song-menu.js; closes UI6-U7a review O3 for the song menu): a trial song is not in the library
  await T('U7c song menu on a trial song: Rename / Duplicate / Export / Delete say Keep it first; Add to setlist keeps '
    + 'it first; Reset stays', async () => {
    const lib0 = await ev(() => window.__rig.store.get().songOrder.length);
    await ev((pid) => window.__rig.controller.tryBankSong(pid), 'sunday-pack:anthem.json');
    await until(() => window.__rig.controller.trial()?.playing === true);
    await page.click(tid('v6-songmenu-btn'));
    await until(() => !!document.querySelector('[data-testid="v6-songmenu"]'));
    const m = await ev(() => Object.fromEntries(['rename', 'dup', 'set', 'export', 'delete', 'reset'].map((k) => {
      const b = document.querySelector(`[data-testid="v6-sm-${k}"]`);
      return [k, { off: b.disabled, small: b.querySelector('small')?.textContent || '' }];
    })));
    for (const k of ['rename', 'dup', 'export', 'delete']) {
      assert.deepEqual([k, m[k].off, m[k].small], [k, true, 'Keep it first']);
    }
    assert.equal(m.set.off, false);
    assert.match(m.set.small, /keeps it in your library first/);
    assert.match(await page.textContent(`${tid('v6-songmenu')} .v6-pop-h`), /trying/);
    // Add to setlist ▸ = the banner's: keep + add to that setlist
    const sl = await ev(() => window.__rig.store.currentSetlist().id);
    await page.click(tid('v6-sm-set'));
    await until(() => !!document.querySelector('[data-testid="v6-bank-setpop"]'));
    await page.click(tid(`v6-bank-setlist-${sl}`));
    await until(() => !window.__rig.controller.trial());
    await settled();
    const k = await ev(({ pid, sl }) => {
      const { store } = window.__rig;
      const id = store.get().meta.packSongs[pid]?.id;
      return { n: store.get().songOrder.length, cur: store.currentSong().id === id,
        inSet: store.get().setlists[sl].songIds.includes(id), trialIds: store.trialIds() };
    }, { pid: 'sunday-pack:anthem.json', sl });
    assert.deepEqual(k, { n: lib0 + 1, cur: true, inSet: true, trialIds: [] });
    // the kept song is a library song: the menu is whole again
    await page.click(tid('v6-songmenu-btn'));
    await until(() => !!document.querySelector('[data-testid="v6-songmenu"]'));
    assert.equal(await page.isDisabled(tid('v6-sm-dup')), false);
    await page.keyboard.press('Escape');
  });

  await T('reload while trying: the trial is gone, the song before it is back', async () => {
    const id0 = await ev(() => window.__rig.store.currentSong().id);
    await ev((pid) => window.__rig.controller.tryBankSong(pid), GATE);
    await until(() => window.__rig.controller.trial()?.playing === true);
    await ev(() => window.__rig.store.set('settings.theme', 'sanctuary')); // no-op write
    await ev(() => window.__rig.store.persistNow());
    await boot();
    await until(() => !!window.__rig.views.v6);
    const r = await ev(() => ({ cur: window.__rig.store.currentSong().id, trial: window.__rig.controller.trial(),
      ids: window.__rig.store.trialIds(), banner: !document.querySelector('[data-testid="v6-trybar"]').hidden }));
    assert.deepEqual(r, { cur: id0, trial: null, ids: [], banner: false });
  });

  await T('Settings › Open Song bank… closes Settings and opens the browser; today’s list is not shown there',
    async () => {
      await ev(() => window.__rig.ctx.openSettings({ section: 'samples' }));
      await until(() => !!document.querySelector('[data-testid="settings-open-bank"]:not(:disabled)'));
      assert.equal(await ev(() => {
        const b = document.querySelector('#view-settings details.st-bank');
        return b ? b.getClientRects().length : 0;
      }), 0, 'today’s list hidden in the v6 Settings');
      await page.click(tid('settings-open-bank'));
      await until(() => window.__rig.views.v6.bank?.isOpen === true);
      assert.equal(await ev(() => document.getElementById('view-settings').hidden), true);
      await closeBank();
      // Edit's Song bank… (openSettings({section: 'bank'})) lands on Perform with the browser
      await page.click('#view-switch [data-value="edit"]');
      await until(() => document.body.dataset.view === 'edit');
      await ev(() => window.__rig.ctx.openSettings({ section: 'bank' }));
      await until(() => document.body.dataset.view === 'perform' && window.__rig.views.v6.bank?.isOpen === true);
      // Esc closes it (no panic: Esc always panics is off)
      await page.keyboard.press('Escape');
      await until(() => window.__rig.views.v6.bank.isOpen === false);
    });

  await T('My library: the player’s songs, Try it switches to one, Add to setlist; badge Playing', async () => {
    await ev(() => window.__rig.ctx.openBank({ mode: 'library' }));
    await until(() => window.__rig.views.v6.bank?.mode === 'library');
    const n = await ev(() => window.__rig.store.get().songOrder.length);
    assert.equal(await ev(() => window.__rig.views.v6.bank.rows.length), n);
    assert.equal(await page.textContent(tid('v6-bank-count')), `${n} songs in your library`);
    assert.equal(await page.isVisible(tid('v6-bank-addlib')), false);
    assert.equal(await ev(() => document.querySelector('.v6-bank-grp.g-packs').hidden), true);
    const cur = await ev(() => window.__rig.store.currentSong().id);
    assert.match(await page.textContent(tid(`v6-bank-row-${cur}`)), /Playing/);
    const target = await ev((c) => window.__rig.store.get().songOrder.find((id) => id !== c), cur);
    await ev((id) => window.__rig.views.v6.bank.select(id), target);
    await shot('u7a-library-1280.png');
    await page.click(tid('v6-bank-try'));
    await until((id) => window.__rig.store.currentSong().id === id, target);
    await settled();
    assert.equal(await ev(() => window.__rig.controller.trial()), null, 'a plain switch, not a trial');
    // back to the bank mode with the toggle
    await ev(() => window.__rig.ctx.openBank({ mode: 'library' }));
    await page.click(tid('v6-bank-mode-bank'));
    await until(() => window.__rig.views.v6.bank.mode === 'bank');
    assert.equal(await ev(() => window.__rig.views.v6.bank.rows.length), 7);
    await closeBank();
  });

  await T('screens: setlist entry 1280×800; 1180×820; iPad portrait 820×1180 (filters on top, detail under)',
    async () => {
      await closeBank();
      await page.click(tid('v6-sb-tab-setlist'));
      await page.click(tid('v6-sl-add'));
      await until(() => !!document.querySelector('[data-testid="v6-addsong"]'));
      await shot('u7a-setlist-entry-1280.png');
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 1180, height: 820 });
      await ev(() => window.__rig.ctx.openBank({ mode: 'bank' }));
      await ev((id) => window.__rig.views.v6.bank.select(id), LANTERN);
      await page.waitForTimeout(200);
      const wide = await ev(() => ({ sx: document.documentElement.scrollWidth <= window.innerWidth,
        act: document.querySelector('[data-testid="v6-bank-try"]').getBoundingClientRect().bottom
          <= document.querySelector('[data-testid="v6-bank"]').getBoundingClientRect().bottom + 1 }));
      assert.deepEqual(wide, { sx: true, act: true });
      await shot('u7a-browse-1180.png');
      await closeBank();
      await ev((pid) => window.__rig.controller.tryBankSong(pid), LANTERN);
      await until(() => window.__rig.controller.trial()?.playing === true);
      await shot('u7a-trying-1180.png');
      await ev(() => window.__rig.controller.backFromTrial());
      await until(() => !window.__rig.controller.trial());
      await page.setViewportSize({ width: 820, height: 1180 });
      await ev(() => window.__rig.ctx.openBank({ mode: 'bank' }));
      await ev((id) => window.__rig.views.v6.bank.select(id), LANTERN);
      await page.waitForTimeout(250);
      const p = await ev(() => {
        const r = (s) => document.querySelector(s).getBoundingClientRect();
        return {
          sx: document.documentElement.scrollWidth <= window.innerWidth,
          order: r('[data-testid="v6-bank-filters"]').bottom <= r('[data-testid="v6-bank-list"]').top + 1
            && r('[data-testid="v6-bank-list"]').bottom <= r('[data-testid="v6-bank-detail"]').top + 1,
          tempoHidden: getComputedStyle(document.querySelector('.v6-bank-grp.g-tempo')).display === 'none',
          full: Math.round(r('[data-testid="v6-bank"]').width) === Math.round(r('[data-testid="v6-board"]').width),
        };
      });
      assert.deepEqual(p, { sx: true, order: true, tempoHidden: true, full: true });
      await shot('u7a-browse-ipad-820.png');
      await closeBank();
      await ev((pid) => window.__rig.controller.tryBankSong(pid), LANTERN);
      await until(() => window.__rig.controller.trial()?.playing === true);
      await shot('u7a-trying-ipad-820.png');
      await ev(() => window.__rig.controller.backFromTrial());
      await until(() => !window.__rig.controller.trial());
      await page.setViewportSize({ width: 1280, height: 800 });
    });

  // ---- UI v6 polish batch 1 (polish1.tests.mjs: UI6-U7a O1–O3)
  await polish1BankTests({ T, page, ev, until, tid, settled, assert, closeBank, QUIET });

  await T('flag off (a fresh profile, packs present): today’s Settings Song bank list; nothing of v6 fetched',
    async () => {
      await context.close();
      v6Fetches.length = 0;
      await newPage();
      await boot();
      assert.equal(await ev(() => window.__rig.views.v6), null);
      assert.equal(await ev(() => typeof window.__rig.controller.trial()), 'object');
      await ev(() => window.__rig.ctx.openSettings({ section: 'bank' }));
      await until(() => document.querySelector('details.st-bank')?.open === true);
      assert.equal(await ev(() => document.querySelectorAll('.st-bank-item').length), 7);
      assert.deepEqual(v6Fetches, []);
      assert.equal(await ev(() => document.querySelectorAll('.v6, [data-testid^="v6-"]').length), 0);
      await ev(() => window.__rig.ctx.closeSettings());
    });

  await T('zero console.error and no HTTP ≥ 400', async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  await browser.close();
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

const bad = results.filter((r) => !r.ok);
console.log(`\nui-v6-bank: ${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
