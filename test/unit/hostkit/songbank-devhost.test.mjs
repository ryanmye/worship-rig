// Lane N1, end to end on the NATIVE core: the real app (UI v6) in Chromium against rig-devhost --user-samples, i.e.
// the route the Mac / iPad scheme handler serves (rig_hostkit), the real store and controller, the native engine
// on the null audio backend. A My Samples folder with spaces and non-ASCII in its path is made at test time (invented
// songs on built-in synths; no audio files):
//   empty folder: /api/health says no packs, /api/user-patches is never requested, the Song bank entry is disabled;
//   packs written + Rescan: the auto pack's song joins the library once, the bank lists its two songs; Song bank ›
//   Try it plays one (nothing saved); Keep adds it to the library; Settings shows the folder and the bank;
//   zero console errors, no HTTP >= 400.
// Opt-in, as test/unit/engine-bridge/devhost.test.mjs: RIG_DEVHOST=1 (or a rig-devhost path) after building
// native/devhost; skipped otherwise.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDevhost, devhostBinary } from '../engine-bridge/devhost-proc.mjs';
import { MIDI_PERMISSIONS, waitRigReady, pinTheme } from '../../integration/lib.mjs';
import { blankSong } from '../../../app/js/presets.js';
import { defaultSlot } from '../../../app/js/shared/params.js';

const enabled = !!process.env.RIG_DEVHOST && !!devhostBinary();
const skip = enabled ? false : 'opt-in: set RIG_DEVHOST=1 (or a rig-devhost path) after building native/devhost';
const tid = (id) => `[data-testid="${id}"]`;

let host;
let browser;
let page;
let dir;
let samples;
const errors = [];
const reqs = [];

const write = (f, data) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
};
function song(name, pc, tempo, ids) {
  const s = blankSong({ name, playIn: pc, hearIn: pc, tempo });
  s.patch.slots = ids.map((id, i) => defaultSlot(i, { type: 'synth', id }));
  return s;
}
const exportOf = (s, bank) => ({ app: 'worship-rig', kind: 'song', schema: 2, song: s, ...(bank ? { bank } : {}) });
function writePacks() {
  write(path.join(samples, 'Sunday Bank Ü', 'pack.json'), { mode: 'bank', name: 'Sunday bank' });
  write(path.join(samples, 'Sunday Bank Ü', 'songs', 'lantern hymn.json'), exportOf(song('Lantern Hymn', 3, 68,
    ['warm-pad', 'strings']), { title: 'Lantern Hymn', artist: 'Northgate Testers', originalKey: 'Eb', bpm: 68 }));
  write(path.join(samples, 'Sunday Bank Ü', 'songs', 'still water.json'), exportOf(song('Still Water', 2, 72,
    ['warm-pad']), { title: 'Still Water', artist: 'River Testhall', originalKey: 'D', bpm: 72 }));
  write(path.join(samples, 'Cedar Keys', 'songs', 'auto 1.json'), exportOf(song('Cedar Auto', 0, 80, ['strings'])));
}
const LANTERN = 'Sunday Bank Ü:lantern hymn.json';
const ev = (fn, arg) => page.evaluate(fn, arg);
const until = (fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
const settled = () => until(() => {
  const { controller, store } = window.__rig;
  return controller.status.songId === store.get().settings.currentSongId && !controller.status.loading;
}, null, 30000);

before(async () => {
  if (!enabled) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig n1 Ä-'));
  samples = path.join(dir, 'Music', 'Worship Rig', 'Samples');
  fs.mkdirSync(samples, { recursive: true });
  host = await startDevhost({ extra: ['--user-samples', samples, '--recordings', path.join(dir, 'rec'), '--seed', '7'] });
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await pinTheme(context, 'sanctuary');
  await context.grantPermissions([...MIDI_PERMISSIONS], { origin: host.base });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url || '?'}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('request', (r) => reqs.push(new URL(r.url()).pathname));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
});

after(async () => {
  if (browser) await browser.close();
  if (host) await host.stop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('Song bank from My Samples on the native core (rig-devhost): no pack, Rescan, Try it, Keep', { skip, timeout: 240000 },
  async () => {
    await page.goto(`${host.base}/?ui6=1`);
    await waitRigReady(page, { timeout: 60000 });
    const overlay = await page.$('#overlay-start:not([hidden])');
    if (overlay) await overlay.click();
    await settled();
    await ev(() => window.__rig.controller.packsReady);
    assert.equal(await ev(() => window.__rig.engine.constructor.name), 'BridgeEngine', 'the native engine');

    // an empty My Samples folder: health says so, nothing is requested, the entry is off
    const h0 = await ev(async () => (await fetch('/api/health')).json());
    assert.deepEqual([h0.userSamples, h0.userPatches, h0.features], [true, false, ['user-samples']]);
    assert.equal(reqs.includes('/api/user-patches'), false, 'never requested without a pack');
    await until(() => !!window.__rig.views.v6);
    await page.click(tid('v6-sb-tab-setlist'));
    await page.click(tid('v6-sl-add'));
    await until(() => !!document.querySelector('[data-testid="v6-addsong"]'));
    assert.equal(await page.isDisabled(tid('v6-add-bank')), true);
    await page.keyboard.press('Escape');

    // packs appear (Settings › Rescan runs this): the auto song joins the library, the bank fills
    writePacks();
    const r = await ev(async () => {
      const x = await window.__rig.controller.rescanPatchPacks();
      const p = window.__rig.controller.patchPacks();
      const st = window.__rig.store.get();
      return { enabled: x.enabled, songs: x.songs, bank: x.bankSongs, added: x.added.length, errors: x.errors,
        skipped: x.skipped, titles: p.bank.map((b) => b.title), auto: st.songOrder.map((id) => st.songs[id].name)
          .filter((n) => n === 'Cedar Auto').length };
    });
    assert.deepEqual(r, { enabled: true, songs: 3, bank: 2, added: 1, errors: [], skipped: [],
      titles: ['Lantern Hymn', 'Still Water'], auto: 1 });
    assert.equal(reqs.filter((x) => x === '/api/user-patches').length, 1);
    const again = await ev(async () => (await window.__rig.controller.rescanPatchPacks()).added.length);
    assert.equal(again, 0, 'each auto song once');

    // Song bank › Try it: plays on the native engine, nothing saved
    await page.click(tid('v6-sb-tab-setlist'));
    await page.click(tid('v6-sl-add'));
    await until(() => !!document.querySelector('[data-testid="v6-addsong"]'));
    await page.click(tid('v6-add-bank'));
    await until(() => window.__rig.views.v6.bank?.isOpen === true);
    assert.deepEqual(await ev(() => window.__rig.views.v6.bank.rows.map((x) => x.title)), ['Lantern Hymn', 'Still Water']);
    const n0 = await ev(() => window.__rig.store.get().songOrder.length);
    await ev((id) => window.__rig.views.v6.bank.select(id), LANTERN);
    await page.click(tid('v6-bank-try'));
    await until(() => window.__rig.controller.trial()?.playing === true);
    await settled();
    assert.equal(await ev(() => window.__rig.store.currentSong().name), 'Lantern Hymn');
    assert.equal(await page.textContent(tid('v6-try-name')), 'Trying “Lantern Hymn”');
    assert.equal(await ev(() => window.__rig.store.get().songOrder.length), n0, 'a trial is not in the library');
    await ev(async () => {  // a note through the bridge on the trial song
      window.__rig.engine.noteOn(60, 100);
      await new Promise((ok) => setTimeout(ok, 200));
      window.__rig.engine.noteOff(60);
    });

    // Keep: in the library (the pack record), selected
    await page.click(tid('v6-try-keep'));
    await until(() => !window.__rig.controller.trial());
    await settled();
    const k = await ev((pid) => {
      const { store } = window.__rig;
      const rec = store.get().meta.packSongs[pid];
      return { n: store.get().songOrder.length, rec: !!rec, cur: store.currentSong().id === (rec && rec.id),
        name: store.currentSong().name };
    }, LANTERN);
    assert.deepEqual(k, { n: n0 + 1, rec: true, cur: true, name: 'Lantern Hymn' });

    // Settings › Sounds & Samples: the My Samples folder (the devhost's root, spaces and non-ASCII) and the bank
    await ev(() => window.__rig.ctx.openSettings({ section: 'samples' }));
    await until(() => !document.querySelector('[data-testid="settings-open-bank"]')?.disabled);
    assert.equal(await page.textContent(tid('settings-bank-note')), '2 ready-made songs from your packs');
    await until((p) => document.querySelector('.st-samples-path')?.textContent === `Folder: ${p}`, samples);
    await ev(() => window.__rig.ctx.closeSettings());
    await page.waitForTimeout(500);
    assert.deepEqual(errors, []);
  });
