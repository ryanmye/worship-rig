// round2-shell (reviews/round2-shell.md): #1 realpath bypass through a directory named like an audio file (My Samples
// and pads), #5 object-map pack manifests, #6 out-of-root pack links reported, #2 pristine library never backed up,
// #3 revert snapshot refreshed by an import, #4 revert snapshot taken at commit time, #10 first-select double refusal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createStore, memoryStorage } from '../../../app/js/store.js';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { makeStore, idGen, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { createServer } = require('../../../server.js');

function req(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}
const json = (r) => JSON.parse(r.body.toString('utf8'));
const BIN = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 251));
const write = (f, data) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
};

// ------------------------------------------------------------------------------------------ server
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-round2-'));
const root = path.join(tmp, 'Samples');
const pads = path.join(tmp, 'pads');
const port = 20000 + Math.floor(Math.random() * 20000);
let srv;

before(async () => {
  fs.mkdirSync(path.join(tmp, 'app'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'app', 'index.html'), '<!doctype html>');
  write(path.join(tmp, 'secret.txt'), 'TOP SECRET');
  // #1: pack with a folder named like an audio file whose index.html links outside, and a plain index.html one
  write(path.join(root, 'Evil', 'manifest.json'), JSON.stringify({ instruments: [{ id: 'ev', layers: [{ vel: [0, 127], dir: 'v', notes: ['C4'] }] }] }));
  write(path.join(root, 'Evil', 'v', 'C4.wav'), BIN);
  fs.mkdirSync(path.join(root, 'Evil', 'v', 'evil.wav'));
  fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(root, 'Evil', 'v', 'evil.wav', 'index.html'));
  write(path.join(root, 'Evil', 'v', 'plain.wav', 'index.html'), '<h1>pack html</h1>');
  // in-pack links stay allowed; the Content-Type follows the requested name, not the link target's
  write(path.join(root, 'Evil', 'blobs', 'abc123'), BIN);
  fs.symlinkSync(path.join(root, 'Evil', 'blobs', 'abc123'), path.join(root, 'Evil', 'v', 'D4.wav'));
  // #5: object-map manifest (app/samples/manifest.json form) and a manifest with no instrument list
  write(path.join(root, 'MapForm', 'manifest.json'), JSON.stringify({ instruments: { mf: { name: 'Map Form', layers: [{ vel: [0, 127], dir: 'm', notes: ['C4'] }] } } }));
  write(path.join(root, 'MapForm', 'm', 'C4.wav'), BIN);
  write(path.join(root, 'NoList', 'manifest.json'), JSON.stringify({ name: 'nothing here' }));
  // #6: a pack linked from outside the root
  write(path.join(tmp, 'External', 'BigPiano', 'manifest.json'), JSON.stringify([{ id: 'big', layers: [{ vel: [0, 127], notes: ['C4'] }] }]));
  fs.symlinkSync(path.join(tmp, 'External', 'BigPiano'), path.join(root, 'BigPiano'), 'dir');
  // #1 (pads): the same trick in the pads folder
  write(path.join(pads, 'D.wav'), BIN);
  write(path.join(tmp, 'pad-secret.txt'), 'PAD SECRET');
  fs.mkdirSync(path.join(pads, 'C.wav'));
  fs.symlinkSync(path.join(tmp, 'pad-secret.txt'), path.join(pads, 'C.wav', 'index.html'));
  srv = createServer({ appDir: path.join(tmp, 'app'), port, userSamples: [root], padsRoot: pads, docsDir: null });
  await srv.listen();
});
after(async () => {
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('round2-shell #1: /user-samples never serves a directory index (x.wav/index.html → outside = 404)', async () => {
  const m = json(await req(port, '/api/user-samples/manifest.json'));
  const dir = m.instruments.find((i) => i.id === 'ev').layers[0].dir;
  const ok = await req(port, `${dir}/C4.wav`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, BIN);
  const evil = await req(port, `${dir}/evil.wav`);
  assert.equal(evil.status, 404, 'was 200 "TOP SECRET" as text/html');
  assert.doesNotMatch(evil.body.toString(), /SECRET/);
  assert.equal((await req(port, `${dir}/evil.wav/`)).status, 404);
  assert.equal((await req(port, `${dir}/plain.wav`)).status, 404, 'a non-link index.html is not served either');
  const linked = await req(port, `${dir}/D4.wav`);
  assert.equal(linked.status, 200, 'an in-pack link still works');
  assert.equal(linked.headers['content-type'], 'audio/wav', 'type from the requested name (target has no extension)');
  assert.deepEqual(linked.body, BIN);
});

test('round2-shell #1: /pads never serves a directory index either', async () => {
  const base = srv.padsBaseUrl();
  assert.equal((await req(port, `${base}D.wav`)).status, 200);
  const evil = await req(port, `${base}C.wav`);
  assert.equal(evil.status, 404, 'was 200 "PAD SECRET"');
  assert.doesNotMatch(evil.body.toString(), /SECRET/);
  assert.equal((await req(port, '/')).status, 200, 'the app route still resolves index.html');
});

test('round2-shell #5/#6: object-map manifests load; no-list manifests and out-of-root links are reported', async () => {
  const m = json(await req(port, '/api/user-samples/manifest.json'));
  const mf = m.instruments.find((i) => i.id === 'mf');
  assert.ok(mf, 'object-map form {instruments:{id:{…}}} is read (was count 0, no error)');
  assert.equal(mf.name, 'Map Form');
  assert.match(mf.layers[0].dir, /\/MapForm\/m$/);
  assert.deepEqual(m.packs.find((p) => p.slug === 'MapForm'), { slug: 'MapForm', count: 1 });
  assert.equal((await req(port, `${mf.layers[0].dir}/C4.wav`)).status, 200);
  const errs = m.errors.join('\n');
  assert.match(errs, /NoList.*no instrument list/);
  assert.match(errs, /BigPiano: is a link to a folder outside My Samples/);
  assert.ok(!m.instruments.some((i) => i.id === 'big'), 'still skipped (a link could widen what is served)');
});

// ------------------------------------------------------------------------------------------ store / controller
async function setupCtl(opts = {}) {
  const store = opts.store || makeStore();
  const engine = opts.engine || fakeEngine(opts.engineOpts);
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const warns = [];
  const ctl = createController({ store, engine, midi, recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(), rig: opts.rig || null, timers: opts.timers || fakeTimers(), now: () => 0, locks: null, heartbeat: false, indexedDB: null, ...opts.ctl });
  ctl.addEventListener('warn', (e) => warns.push(e.detail.message));
  await ctl.start();
  return { store, engine, midi, ctl, warns };
}

test('round2-shell #2: a fresh factory seed is pristine until edited; navigation/device settings do not count', async () => {
  const store = makeStore();
  assert.equal(store.pristine, true);
  assert.equal(store.get().meta.edited, false);
  const ids = store.navIds();
  store.selectSongId(ids[2]);
  store.set('settings.midiInputId', 'kbd-1');
  store.set('settings.outputDeviceId', 'usb');
  store.seedFactory(); // no-op / top-up: a seed write
  await tick();
  assert.equal(store.pristine, true, 'selecting songs and device-local settings keep it pristine');
  assert.equal(store.set('song.tempo', 97), true);
  await tick();
  assert.equal(store.pristine, false);
  assert.equal(store.get().meta.edited, true);
  store.dispose();
  // persisted: a reload of that storage is still "edited"; a library from before this field (absent) is not pristine
  const storage = memoryStorage();
  const a = createStore({ storage, idGen: idGen(), requestIdle: null, warn: () => {}, autoFlush: false });
  a.set('song.name', 'Mine');
  a.dispose();
  const b = createStore({ storage, idGen: idGen(), requestIdle: null, warn: () => {}, autoFlush: false });
  assert.equal(b.pristine, false);
  const legacy = JSON.parse(storage.getItem(storage.keys()[0]));
  delete legacy.meta.edited;
  const c = createStore({ storage: memoryStorage({ [storage.keys()[0]]: JSON.stringify(legacy) }), idGen: idGen(), requestIdle: null, warn: () => {}, autoFlush: false });
  assert.equal(c.pristine, false, 'a library from before meta.edited is treated as edited');
  const imported = makeStore();
  assert.equal(imported.importJSON(b.exportJSON(), { replace: true }).ok, true);
  assert.equal(imported.pristine, false, 'an imported library is the user\'s data');
});

test('round2-shell #2: the controller writes no disk backup and no close backup for a pristine library', async () => {
  const backups = [];
  const rig = { isElectron: true, backupNow: async (text) => (backups.push(text), { path: `/b/${backups.length}.json` }), getInfo: async () => ({}) };
  const timers = fakeTimers();
  const { ctl, store } = await setupCtl({ rig, timers });
  assert.equal(store.pristine, true);
  assert.equal(await ctl.backupNow(), null);
  timers.runTimeouts();
  await tick();
  assert.equal(backups.length, 0, 'pristine: not written (it would become the M5 "newer library" offer)');
  assert.equal(globalThis.__rigShell.library(), null, 'finishClose gets no library');
  store.set('slots.0.gain', 0.4);
  await tick();
  const r = await ctl.backupNow();
  assert.ok(r && r.path, 'an edited library is backed up as before');
  assert.equal(backups.length, 1);
  assert.equal(typeof globalThis.__rigShell.library(), 'string');
  ctl.dispose();
});

test('round2-shell #4: the songSelected/revert snapshot is the song as committed (edits made while it loaded)', async () => {
  const { ctl, store, engine } = await setupCtl();
  // from here on, prepare() waits for the test (a slow sampler load)
  const pending = [];
  engine.prepare = (patch) => new Promise((resolve) => pending.push(() => resolve(`tok${pending.length}`)));
  engine.pending = pending;
  const ids = store.navIds();
  const events = [];
  ctl.on('songSelected', (d) => events.push(d));
  const p = ctl.selectSong(ids[1]);
  await tick();
  assert.equal(engine.pending.length, 1);
  store.set(`songs.${ids[1]}.patch.slots.0.gain`, 0.31); // fader moved while the sampler loads
  await tick();
  engine.pending.shift()();
  assert.equal(await p, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].patchSnapshot.slots[0].gain, 0.31, 'was the pre-edit 0.7');
  assert.equal(events[0].songSnapshot.patch.slots[0].gain, 0.31);
  assert.equal(ctl.revertSong(), false, 'Revert does not undo the edit made during loading');
  assert.equal(store.getSong(ids[1]).patch.slots[0].gain, 0.31);
});

test('round2-shell #3: an import (replace) refreshes the revert snapshot of the selected song', async () => {
  const { ctl, store } = await setupCtl();
  const ids = store.navIds();
  await ctl.selectSong(ids[0]);
  const lib = JSON.parse(store.exportJSON());
  lib.songs[ids[0]].patch.slots[0].gain = 0.123;
  lib.songs[ids[0]].tempo = 111;
  assert.equal(store.importJSON(JSON.stringify(lib), { replace: true }).ok, true);
  await tick();
  assert.equal(store.get().settings.currentSongId, ids[0], 'same song id after the import');
  assert.equal(ctl.revertSong(), false, 'was true, writing back gain 0.8 / tempo null');
  const s = store.getSong(ids[0]);
  assert.equal(s.patch.slots[0].gain, 0.123);
  assert.equal(s.tempo, 111);
  // edits after the import revert to the imported values
  store.set('slots.0.gain', 0.5);
  await tick();
  assert.equal(ctl.revertSong(), true);
  await tick();
  assert.equal(store.getSong(ids[0]).patch.slots[0].gain, 0.123);
});

test('round2-shell #10: a double refusal on the very first select keeps status.songId on the selected song', async () => {
  const engine = fakeEngine();
  engine.commit = (...a) => (engine.calls.push(['commit', ...a]), false);
  const { ctl, store, warns } = await setupCtl({ engine });
  const cur = store.get().settings.currentSongId;
  assert.ok(cur);
  assert.equal(ctl.status.loading, false);
  assert.equal(ctl.status.songId, cur, 'was null while the store selected the song');
  assert.ok(warns.some((w) => /refused/.test(w)));
});
