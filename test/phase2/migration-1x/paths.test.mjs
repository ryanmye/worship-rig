// Lane E5: the four ways a 1.x library reaches 2.0, end to end through the real store + controller, with the disk
// side played by JS stand-ins for main.js and RigLibrary.swift (lib.mjs) writing real files in a temp dir:
//   1. the Electron backup file (1.x backupNow) → 2.0 "Import latest backup" (Electron host, and the native shell
//      finding it in another app's Application Support/<…>/backups);
//   2. the macOS first-launch offer (pristine probe → staged newest → menu 'importLatestBackup');
//   3. the iPad Files picker / AirDrop replace (current library backed up first; that backup restores it);
//   4. corrupt / truncated input: rig-unreadable-*, no partial import, no backup rotated away.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore, memoryStorage, STORAGE_KEY, DEVICE_LOCAL_SETTINGS } from '../../../app/js/store.js';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { FACTORY_SONGS } from '../../../app/js/presets.js';
import { fakeEngine, fakeTimers, fakeDoc, tick } from '../../phase1/shell/helpers.mjs';
import {
  fixture, electronHost, nativeShell, writeAged, rotationName, snapshot, tmpDir, plain, jsonDiff,
} from './lib.mjs';

const dirs = [];
const mk = (tag) => {
  const d = tmpDir(tag);
  dirs.push(d);
  return d;
};
let savedLocation;
before(() => {
  savedLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  // the native shell's page origin: controller.libraryJSON tags every backup with it (M5)
  Object.defineProperty(globalThis, 'location', { value: { origin: 'rig://app' }, configurable: true, writable: true });
});
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  if (savedLocation) Object.defineProperty(globalThis, 'location', savedLocation);
  else delete globalThis.location;
});

let ids = 0;
const makeStore = (opts = {}) => createStore({
  storage: memoryStorage(), idGen: (p) => `${p}-p${++ids}`, requestIdle: null, warn: () => {}, autoFlush: false, ...opts,
});
async function setup({ store = makeStore(), rig }) {
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const warns = [];
  const ctl = createController({
    store, engine: fakeEngine(), midi, recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(), rig,
    timers: fakeTimers(), now: () => 0, locks: null, heartbeat: false, indexedDB: null,
  });
  ctl.addEventListener('warn', (e) => warns.push(e.detail.message));
  await ctl.start();
  await tick();
  return { store, ctl, warns };
}
const v1 = (name, form = 'backup') => fixture('v1.1.0', `${name}.${form}.json`);
const v1State = (name) => JSON.parse(fixture('v1.1.0', `${name}.localstorage.json`));
const LOCAL = new Set(DEVICE_LOCAL_SETTINGS);
/** The 1.x library, field by field, except this machine's device-local settings and meta.edited. */
function assertIs1x(store, name, label) {
  const d = jsonDiff(v1State(name), plain(store.get())).filter((x) => !x.startsWith('schema:')
    && !x.startsWith('meta.edited:') && !LOCAL.has(/^settings\.([^.:]+)/.exec(x)?.[1]));
  assert.deepEqual(d, [], label);
}
/** A 1.x Electron backups folder: two older backups and the given one as the newest (1.x rotation names). */
function electronFolder(newestText) {
  const dir = mk('electron');
  writeAged(rotationName(dir), v1('deleted-factory'));
  writeAged(rotationName(dir), v1('unicode'));
  writeAged(rotationName(dir), newestText);
  return dir;
}
const edited = (store) => {
  store.set('song.tempo', 97);
  store.set(`songs.${store.get().songOrder[0]}.name`, 'Edited in 2.0');
  return plain(store.get());
};

// ================================================================================================ 1. Electron file
test('Electron host: a 1.x backup file → 2.0 "Import latest backup" gives the 1.x library; a pristine seed is not backed up', async () => {
  const dir = electronFolder(v1('rich'));
  const host = electronHost(dir);
  const before = snapshot(dir);
  const { store, ctl } = await setup({ rig: host.rig });
  assert.equal(store.pristine, true);
  const r = await ctl.onMenu('importLatestBackup');
  assert.equal(r.ok, true, r.error);
  assertIs1x(store, 'rich', 'electron');
  assert.deepEqual(host.calls.filter((c) => c[0] === 'backupNow'), [], 'an untouched seed is not worth a backup');
  assert.deepEqual(snapshot(dir), before, 'the 1.x backups are untouched');
  ctl.dispose?.();
});

test('Electron host: an edited 2.0 library is backed up first, and that backup restores it exactly', async () => {
  const dir = electronFolder(v1('rich'));
  const host = electronHost(dir);
  const { store, ctl } = await setup({ rig: host.rig });
  const mine = edited(store);
  assert.equal((await ctl.importLatestBackup()).ok, true);
  assertIs1x(store, 'rich', 'imported');
  const newest = host.list()[0];
  const saved = fs.readFileSync(newest.path, 'utf8');
  assert.match(saved, /^\{"origin":"rig:\/\/app","app":"worship-rig","kind":"library","schema":2/);
  // restore: that file is now the newest backup, so "Import latest backup" again brings the 2.0 library back
  assert.equal((await ctl.importLatestBackup()).ok, true);
  assert.deepEqual(jsonDiff(mine, plain(store.get())), []);
});

test('native shell (macOS): "Import latest backup" finds the Electron app’s backups; they are never pruned', async () => {
  const eDir = electronFolder(v1('rich'));
  const own = mk('own');
  const shell = nativeShell({ ownDir: own, electronDirs: [eDir] });
  const before = snapshot(eDir);
  const { store, ctl } = await setup({ rig: shell.rig });
  edited(store);
  // own rotation fills (lane F1, O-AW-F1: 10, as main.js; it was 3)
  for (let i = 0; i < 12; i++) assert.equal((await ctl.importLatestBackup()).ok, true);
  assert.deepEqual(snapshot(eDir), before);
  assert.equal(shell.ownList().length, 10);
});

// ================================================================================================ 2. first launch
test('native first launch: pristine → asked once → the newest Electron backup is imported; the answer is kept', async () => {
  const eDir = electronFolder(v1('rich'));
  const own = mk('own');
  const shell = nativeShell({ ownDir: own, electronDirs: [eDir] });
  const before = snapshot(eDir);
  const { store } = await setup({ rig: shell.rig });
  assert.equal(await shell.firstLaunch(store), 'imported');
  const [r] = await shell.shell.settled;
  assert.equal(r.ok, true, r.error);
  assertIs1x(store, 'rich', 'first launch');
  assert.deepEqual(shell.dialogs, ['Import your Worship Rig library?']);
  assert.deepEqual(snapshot(eDir), before, 'Electron backups untouched');
  assert.deepEqual(shell.ownList(), [], 'nothing of ours to back up yet (pristine)');
  // next launch: not asked again, even with a fresh library
  const again = await setup({ rig: nativeShell({ ownDir: own, electronDirs: [eDir], defaults: shell.defaults }).rig });
  assert.equal(await nativeShell({ ownDir: own, electronDirs: [eDir], defaults: shell.defaults }).firstLaunch(again.store),
    'answered before');
});

test('native first launch (review F1): Yes imports the Electron file the offer dated, not a newer own backup',
  async () => {
    // a truncated newest Electron file is skipped (E5 item 3); our own rotation holds a newer good library (a site
    // data reset left the page pristine again). Before review F1, Yes staged latestAnywhere(): the own file, which
    // the dialog ("saved by the previous Worship Rig on <date of the Electron file>") never named.
    const t = v1('rich');
    const eDir = mk('electron');
    writeAged(rotationName(eDir), t);
    writeAged(rotationName(eDir), t.slice(0, Math.floor(t.length / 2)));
    const own = mk('own');
    writeAged(rotationName(own), v1('unicode'));
    const shell = nativeShell({ ownDir: own, electronDirs: [eDir] });
    const { store } = await setup({ rig: shell.rig });
    assert.equal(await shell.firstLaunch(store), 'imported');
    const [r] = await shell.shell.settled;
    assert.equal(r.ok, true, r.error);
    assertIs1x(store, 'rich', 'the dated Electron library');
  });

test('native first launch: declined, or the library already edited → nothing changes', async () => {
  const eDir = electronFolder(v1('rich'));
  const no = nativeShell({ ownDir: mk('own'), electronDirs: [eDir], confirm: () => false });
  const a = await setup({ rig: no.rig });
  const seed = plain(a.store.get());
  assert.equal(await no.firstLaunch(a.store), 'declined');
  assert.deepEqual(plain(a.store.get()), seed);
  assert.equal(no.defaults.get('rig.electronImportAnswered.v1'), true);
  const busy = nativeShell({ ownDir: mk('own'), electronDirs: [eDir] });
  const b = await setup({ rig: busy.rig });
  const mine = edited(b.store);
  assert.equal(await busy.firstLaunch(b.store), 'not pristine');
  assert.deepEqual(plain(b.store.get()), mine);
  assert.deepEqual(busy.dialogs, []);
  const none = nativeShell({ ownDir: mk('own'), electronDirs: [mk('empty')] });
  assert.equal(await none.firstLaunch((await setup({ rig: none.rig })).store), 'no electron backup');
});

test('native first launch: the 1.0, empty, unicode and near-cap 1.x libraries come over too', async () => {
  for (const [ref, name] of [['v1.0.0', 'rich'], ['v1.1.0', 'empty'], ['v1.1.0', 'unicode'], ['v1.1.0', 'huge']]) {
    const eDir = mk('electron');
    writeAged(rotationName(eDir), fixture(ref, `${name}.backup.json`));
    const shell = nativeShell({ ownDir: mk('own'), electronDirs: [eDir] });
    const { store } = await setup({ rig: shell.rig });
    assert.equal(await shell.firstLaunch(store), 'imported', name);
    const [r] = await shell.shell.settled;
    assert.equal(r.ok, true, `${ref} ${name}: ${r.error}`);
    const want = JSON.parse(fixture(ref, `${name}.localstorage.json`));
    assert.deepEqual(store.get().songOrder, want.songOrder, name);
    assert.deepEqual(store.get().setlistOrder, want.setlistOrder, name);
    for (const id of want.songOrder) assert.deepEqual(plain(store.getSong(id)), want.songs[id], `${name} ${id}`);
  }
});

// ================================================================================================ 3. iPad picker
test('iPad Files picker (replace): the current library is backed up first; that backup restores it', async () => {
  const own = mk('ipad-own');
  const shell = nativeShell({ ownDir: own, platform: 'ipados' }); // no Electron folders on the iPad
  const { store } = await setup({ rig: shell.rig });
  const mine = edited(store);
  const inbox = mk('inbox');
  const file = writeAged(path.join(inbox, 'Worship Rig library 2026-11-20.json'), v1('rich', 'export'));
  assert.equal(shell.pick(file), 'staged');
  const [r] = await shell.shell.settled;
  assert.equal(r.ok, true, r.error);
  assertIs1x(store, 'rich', 'picker');
  const backups = shell.ownList();
  assert.equal(backups.length, 1);
  // restore through the same picker, from the backup file (Files › On My iPad › Worship Rig › Backups)
  assert.equal(shell.pick(backups[0].path), 'staged');
  const [r2] = await shell.shell.settled;
  assert.equal(r2.ok, true);
  assert.deepEqual(jsonDiff(mine, plain(store.get())), [], 'restored exactly');
});

test('iPad AirDrop "Open in": asked first; declined changes nothing', async () => {
  const shell = nativeShell({ ownDir: mk('own'), platform: 'ipados', confirm: (t) => !/Import this library/.test(t) });
  const { store } = await setup({ rig: shell.rig });
  const mine = edited(store);
  const file = writeAged(path.join(mk('inbox'), 'rig-20261120-101010.json'), v1('rich'));
  assert.equal(shell.pick(file, { openIn: true }), 'declined');
  assert.deepEqual(plain(store.get()), mine);
  assert.deepEqual(shell.ownList(), []);
});

test('picker: a JSON file that is not a library (E5) is refused; before, it replaced the library with an empty one', async () => {
  const shell = nativeShell({ ownDir: mk('own'), platform: 'ipados' });
  const { store, warns } = await setup({ rig: shell.rig });
  const mine = edited(store);
  for (const [n, text] of [['package.json', '{"name":"x","version":"1.0.0"}'], ['settings.json', '{}'],
    ['song-list.json', '{"origin":"rig://app"}']]) {
    const file = writeAged(path.join(mk('inbox'), n), text);
    assert.equal(shell.pick(file), 'staged');
    const [r] = await shell.shell.settled;
    assert.equal(r.ok, false, n);
    assert.deepEqual(plain(store.get()), mine, `${n}: library unchanged`);
  }
  assert.deepEqual(shell.ownList(), [], 'and no backup rotated');
  assert.ok(warns.some((w) => /not a Worship Rig library/.test(w)));
  const bad = writeAged(path.join(mk('inbox'), 'notes.json'), 'not json at all');
  assert.equal(shell.pick(bad), 'not a library', 'the shell itself refuses non-JSON');
});

// ================================================================================================ 4. corrupt input
test('a truncated 1.x library in localStorage → rig-unreadable-* (exact text) on disk, a fresh seed, nothing partial', async () => {
  for (const [label, raw] of [['truncated', v1('rich', 'localstorage').slice(0, 20000)],
    ['future schema', JSON.stringify({ ...v1State('rich'), schema: 3 })]]) {
    const storage = memoryStorage({ [STORAGE_KEY]: raw });
    const store = makeStore({ storage });
    assert.equal(store.loadInfo.status, label === 'truncated' ? 'corrupt' : 'future-schema');
    assert.equal(storage.getItem(store.loadInfo.backupKey), raw, 'kept in localStorage too');
    const own = mk('own');
    const shell = nativeShell({ ownDir: own });
    await setup({ store, rig: shell.rig });
    const files = fs.readdirSync(own).filter((f) => f.startsWith('rig-unreadable-'));
    assert.equal(files.length, 1, label);
    assert.equal(fs.readFileSync(path.join(own, files[0]), 'utf8'), raw, `${label}: byte for byte`);
    assert.equal(store.get().songOrder.length, FACTORY_SONGS.length, 'a fresh factory seed');
    const names = new Set(Object.values(store.get().songs).map((s) => s.name));
    assert.equal(names.has('Grace Overflows (Live)'), false, 'no part of the unreadable library');
  }
});

test('a truncated newest backup (E5): never served; the newest good one is imported, nothing pruned', async () => {
  // E5 open item 3 (lane F1): RigBackups.latestAnywhere used to serve the newest readable file, truncated or not, so
  // the import was refused while the older good backups were never offered. It now skips what does not parse.
  const own = mk('own');
  writeAged(rotationName(own), v1('unicode'));
  writeAged(rotationName(own), v1('deleted-factory'));
  const t = v1('rich');
  writeAged(rotationName(own), t.slice(0, Math.floor(t.length * 0.6)));
  const shell = nativeShell({ ownDir: own });
  const { store, ctl, warns } = await setup({ rig: shell.rig });
  edited(store);
  const disk = snapshot(own);
  const r = await ctl.importLatestBackup();
  assert.equal(r.ok, true, r.error);
  assertIs1x(store, 'deleted-factory', 'the newest good backup');
  const after = snapshot(own);
  for (const [n, text] of Object.entries(disk)) assert.equal(after[n], text, `${n} kept (rotation 10)`);
  assert.equal(Object.keys(after).length, 4, 'plus the pre-import backup');
  assert.ok(!warns.some((w) => /Import failed/.test(w)));
});

test('only bad backups (truncated, newer schema, not a library): import refused, library and folder as they were',
  async () => {
    const own = mk('own');
    const t = v1('rich');
    writeAged(rotationName(own), JSON.stringify({ ...JSON.parse(t), schema: 3 }));
    writeAged(rotationName(own), '{"name":"x","version":"1.0.0"}');
    writeAged(rotationName(own), JSON.stringify({ kind: 'song', schema: 2, song: { name: 'one song' } }));
    writeAged(rotationName(own), t.slice(0, 5000));
    const shell = nativeShell({ ownDir: own });
    const { store, ctl, warns } = await setup({ rig: shell.rig });
    const mine = edited(store);
    const disk = snapshot(own);
    const r = await ctl.importLatestBackup();
    assert.equal(r.ok, false, 'nothing that parses as a library: "no backup found"');
    assert.deepEqual(plain(store.get()), mine, 'no partial import');
    assert.deepEqual(snapshot(own), disk, 'no file written, none deleted');
    assert.equal(warns.filter((w) => /Import failed/.test(w)).length, 0, 'none of them reached importJSON');
  });

test('Electron host: a truncated or newer-schema newest backup leaves library and folder as they were', async () => {
  const t = v1('rich');
  for (const bad of [t.slice(0, 5000), `${t.slice(0, -1)},"extra":`, JSON.stringify({ ...JSON.parse(t), schema: 9 })]) {
    const dir = electronFolder(bad);
    const host = electronHost(dir);
    const { store, ctl } = await setup({ rig: host.rig });
    const mine = edited(store);
    const disk = snapshot(dir);
    assert.equal((await ctl.importLatestBackup()).ok, false);
    assert.deepEqual(plain(store.get()), mine);
    assert.deepEqual(snapshot(dir), disk);
  }
});

test('the current library cannot be backed up (E5): nothing is replaced; a pristine seed still imports', async () => {
  const dir = electronFolder(v1('rich'));
  const host = electronHost(dir, { fail: 'ENOSPC: no space left on device' });
  const { store, ctl, warns } = await setup({ rig: host.rig });
  const mine = edited(store);
  const r = await ctl.importLatestBackup();
  assert.deepEqual(r, { ok: false, error: 'backup failed' }); // before E5: replaced anyway, the edits gone
  assert.deepEqual(plain(store.get()), mine);
  assert.ok(warns.some((w) => /could not be backed up first/.test(w)));
  const fresh = await setup({ rig: electronHost(dir, { fail: 'ENOSPC' }).rig });
  assert.equal((await fresh.ctl.importLatestBackup()).ok, true, 'nothing to lose in an untouched seed');
  assertIs1x(fresh.store, 'rich', 'pristine + failing disk');
});
