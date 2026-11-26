// Patch packs in the real app (2.x step 1, DECISIONS O-AW-PP): Chromium against server.js with My Samples on and
// RIG_USER_SAMPLES pointing at a temp folder (as serve.mjs / the Mac app run it).
//  1. no packs: the library is the plain factory seed, /api/user-patches is never requested
//  2. a pack appears: its auto songs are added once across two boots; the bank song is not
//  3. a file change: the edited song keeps the edit, the unedited one updates in place
//  4. Settings › My Samples: the "Patch packs" line, Rescan, the Song bank (search, Add to library, once)
// Every boot: zero console errors, zero responses >= 400. Song and pack names are invented.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { MIDI_PERMISSIONS, waitRigReady } from '../../integration/lib.mjs';
import { repoRoot } from './fixture.mjs';
import { blankSong, FACTORY_SONGS } from '../../../app/js/presets.js';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-packs-pw-'));
const samples = path.join(tmp, 'Samples');
const prevEnv = process.env.RIG_USER_SAMPLES;
process.env.RIG_USER_SAMPLES = samples; // createServer({userSamples:true}) reads it, like the real launchers
const { createServer } = require('../../../server.js');

const port = 18437 + 1000 + Math.floor(Math.random() * 1000);
const origin = `http://127.0.0.1:${port}`;
let server;
let browser;
let context;
const write = (f, data) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
};
const exportOf = (song, bank) => ({ app: 'worship-rig', kind: 'song', schema: 2, song, ...(bank ? { bank } : {}) });
const song = (name, over = {}) => ({ ...blankSong({ name }), ...over });

/** Open the app once (a new page in the shared context = same localStorage), with error / 4xx collection. */
async function boot() {
  const page = await context.newPage();
  const errors = [];
  const bad = [];
  const paths = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`);
  });
  page.on('request', (r) => paths.push(new URL(r.url()).pathname));
  await page.goto(`${origin}/`);
  await waitRigReady(page, { timeout: 60000 });
  const packs = await page.evaluate(async () => {
    const r = await window.__rig.controller.packsReady;
    return r ? { enabled: r.enabled, added: r.added.length, updated: r.updated.length, kept: r.kept.length } : null;
  });
  return { page, errors, bad, paths, packs };
}
const library = (page) => page.evaluate(() => {
  const st = window.__rig.store.get();
  return {
    order: st.songOrder.slice(),
    names: st.songOrder.map((id) => st.songs[id].name),
    packSongs: window.__rig.store.packSongs(),
    meta: Object.keys(st.meta),
    tempo: Object.fromEntries(st.songOrder.map((id) => [id, st.songs[id].tempo])),
  };
});
async function close(b) {
  await b.page.evaluate(() => window.__rig.store.persistNow());
  await b.page.close();
  assert.deepEqual(b.errors, [], 'zero console errors');
  assert.deepEqual(b.bad, [], 'zero responses >= 400');
}

before(async () => {
  fs.mkdirSync(path.join(samples, 'Only Samples'), { recursive: true });
  write(path.join(samples, 'Only Samples', 'manifest.json'), { instruments: [] });
  server = createServer({ appDir: path.join(repoRoot, 'app'), port, userSamples: true, reuse: false, docsDir: null });
  await server.listen();
  const args = ['--autoplay-policy=no-user-gesture-required'];
  browser = await chromium.launch({ channel: 'chromium', headless: true, args });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(MIDI_PERMISSIONS, { origin });
});
after(async () => {
  await browser?.close();
  await server?.close();
  if (prevEnv === undefined) delete process.env.RIG_USER_SAMPLES;
  else process.env.RIG_USER_SAMPLES = prevEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('no packs: the plain factory library, no /api/user-patches request, no Patch packs line', async () => {
  const b = await boot();
  assert.deepEqual(b.packs && b.packs.enabled, false);
  const lib = await library(b.page);
  assert.equal(lib.order.length, FACTORY_SONGS.length);
  assert.equal(lib.meta.includes('packSongs'), false);
  assert.ok(b.paths.includes('/api/health'));
  assert.equal(b.paths.includes('/api/user-patches'), false, 'never requested without the feature');
  await b.page.evaluate(() => window.__rig.ctx.openSettings({ section: 'samples' }));
  const ui = await b.page.evaluate(() => ({
    line: document.querySelector('#view-settings .st-packs-status')?.hidden,
    bank: document.querySelector('#view-settings .st-bank')?.hidden,
  }));
  assert.deepEqual(ui, { line: true, bank: true });
  await close(b);
});

let ids = {};
test('a pack appears: auto songs are added once across two boots (at the end); the bank song is not', async () => {
  write(path.join(samples, 'Cedar Pack', 'songs', 'lantern-hymn.json'), exportOf(song('Lantern Hymn', { tempo: 70 })));
  write(path.join(samples, 'Cedar Pack', 'songs', 'evening.json'), [exportOf(song('Copper Fields', { tempo: 80 }))]);
  write(path.join(samples, 'Invented Bank', 'pack.json'), { mode: 'bank' });
  write(path.join(samples, 'Invented Bank', 'songs', 'arbor.json'), exportOf(song('Arbor Song', { tempo: 66 }),
    { title: 'Arbor Song', artist: 'Mira Testwell', originalKey: 'D', bpm: 66, timeSig: '3/4' }));
  write(path.join(samples, 'Invented Bank', 'songs', 'ember.json'),
    exportOf(song('Ember Psalm'), { title: 'Ember Psalm', artist: 'Léa Fictional' }));
  const b1 = await boot();
  assert.deepEqual(b1.packs, { enabled: true, added: 2, updated: 0, kept: 0 });
  const lib = await library(b1.page);
  assert.equal(lib.order.length, FACTORY_SONGS.length + 2);
  assert.deepEqual(lib.names.slice(-2), ['Copper Fields', 'Lantern Hymn']);
  ids = lib.packSongs;
  assert.deepEqual(Object.keys(ids).sort(), ['Cedar Pack:evening.json#0', 'Cedar Pack:lantern-hymn.json']);
  await b1.page.waitForFunction(() => [...document.querySelectorAll('.toast-msg')]
    .some((t) => /Patch packs: 2 songs added/.test(t.textContent)));
  await close(b1);
  const b2 = await boot();
  assert.deepEqual(b2.packs, { enabled: true, added: 0, updated: 0, kept: 0 });
  const lib2 = await library(b2.page);
  assert.deepEqual(lib2.order, lib.order, 'the second boot adds nothing');
  await close(b2);
});

test('a file change: the edited song keeps the edit; the unedited one updates in place', async () => {
  const b1 = await boot();
  const hymn = ids['Cedar Pack:lantern-hymn.json'];
  const fields = ids['Cedar Pack:evening.json#0'];
  assert.ok(await b1.page.evaluate((id) => window.__rig.store.set(`songs.${id}.name`, 'Lantern Hymn (my keys)'), hymn));
  await close(b1);
  write(path.join(samples, 'Cedar Pack', 'songs', 'lantern-hymn.json'), exportOf(song('Lantern Hymn', { tempo: 75 })));
  write(path.join(samples, 'Cedar Pack', 'songs', 'evening.json'), [exportOf(song('Copper Fields', { tempo: 88 }))]);
  const b2 = await boot();
  assert.deepEqual(b2.packs, { enabled: true, added: 0, updated: 1, kept: 1 });
  const lib = await library(b2.page);
  const at = (id) => lib.order.indexOf(id);
  assert.equal(lib.names[at(hymn)], 'Lantern Hymn (my keys)');
  assert.equal(lib.tempo[hymn], 70, 'the edited song is not overwritten');
  assert.equal(lib.tempo[fields], 88, 'the unedited song took the new version');
  assert.equal(at(fields), FACTORY_SONGS.length, 'in place: same id, same position');
  await close(b2);
});

test('Settings › My Samples: Patch packs line, Rescan, Song bank search and Add to library (once)', async () => {
  const b = await boot();
  const { page } = b;
  await page.evaluate(() => window.__rig.ctx.openSettings({ section: 'samples' }));
  await page.waitForSelector('#view-settings .st-packs-status:not([hidden])');
  assert.equal(await page.textContent('#view-settings .st-packs-status'),
    'Patch packs: 4 songs from 2 packs, 2 of them in the Song bank.');
  // a third Cedar song, found by Rescan without a restart
  write(path.join(samples, 'Cedar Pack', 'songs', 'quiet-harbor.json'), exportOf(song('Quiet Harbor')));
  await page.click('#view-settings .st-packs-rescan');
  await page.waitForFunction(() => /5 songs from 2 packs/
    .test(document.querySelector('#view-settings .st-packs-status').textContent));
  assert.equal((await library(page)).names.at(-1), 'Quiet Harbor');
  // the bank
  await page.click('#view-settings .st-bank > summary');
  const titles = () => page.$$eval('#view-settings .st-bank-item .st-bank-title',
    (els) => els.map((e) => e.textContent));
  assert.deepEqual(await titles(), ['Arbor Song', 'Ember Psalm']);
  await page.fill('#view-settings .st-bank-search', 'mira');
  assert.deepEqual(await titles(), ['Arbor Song']);
  const meta = await page.textContent('#view-settings .st-bank-item .st-bank-meta');
  assert.match(meta, /Mira Testwell · Key D · 66 BPM · 3\/4/);
  const n0 = (await library(page)).order.length;
  await page.click('#view-settings .st-bank-item .st-bank-add');
  const lib = await library(page);
  assert.equal(lib.order.length, n0 + 1);
  assert.equal(lib.names.at(-1), 'Arbor Song');
  const disabled = await page.getAttribute('#view-settings .st-bank-item .st-bank-add', 'disabled');
  assert.notEqual(disabled, null, 'now "In library"');
  await page.fill('#view-settings .st-bank-search', 'zzz-no-such');
  assert.equal(await page.textContent('#view-settings .st-bank-none'), 'No song matches.');
  await close(b);
  // a reboot: nothing more is added (the bank song stays once; the auto songs stay once)
  const b2 = await boot();
  assert.deepEqual(b2.packs, { enabled: true, added: 0, updated: 0, kept: 1 });
  const lib2 = await library(b2.page);
  assert.equal(lib2.order.length, n0 + 1);
  assert.equal(lib2.names.filter((n) => n === 'Arbor Song').length, 1);
  await close(b2);
});

test('skeptic PP-1/PP-3: a Rescan update of the shown song moves Perform\'s Revert snapshot; bank targets ≥ 44 px',
  async () => {
    const b = await boot();
    const { page } = b;
    const fields = ids['Cedar Pack:evening.json#0'];
    await page.evaluate((id) => window.__rig.controller.selectSong(id), fields);
    write(path.join(samples, 'Cedar Pack', 'songs', 'evening.json'), [exportOf(song('Copper Fields', { tempo: 96 }))]);
    const r = await page.evaluate(() => window.__rig.controller.rescanPatchPacks().then((x) => x.updated));
    assert.deepEqual(r, [fields]);
    const perf = await page.evaluate(() => ({
      snap: window.__rig.views.perform.savedSnapshot.tempo,
      changed: window.__rig.views.perform.changedPaths,
    }));
    assert.deepEqual(perf, { snap: 96, changed: [] }, 'no changed dots: the update is not an edit');
    await page.evaluate(() => window.__rig.ctx.openSettings({ section: 'samples' }));
    await page.waitForSelector('#view-settings .st-packs-status:not([hidden])');
    await page.click('#view-settings .st-bank > summary');
    const sizes = await page.$$eval(
      '#view-settings .st-packs-rescan, #view-settings .st-bank > summary, #view-settings .st-bank-search, '
        + '#view-settings .st-bank-add',
      (els) => els.map((e) => [e.className, Math.round(e.getBoundingClientRect().height),
        e.getAttribute('aria-label')]),
    );
    for (const [cls, hgt] of sizes) assert.ok(hgt >= 44, `${cls}: ${hgt} px`);
    const labels = sizes.filter(([cls]) => /st-bank-add/.test(cls)).map((x) => x[2]);
    assert.deepEqual(labels, ['Arbor Song: in library', 'Add Ember Psalm to library']);
    await close(b);
  });
