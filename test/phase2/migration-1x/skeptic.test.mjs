// Lane E5 skeptic (native/docs/reviews/E5-migration.md): attempts to lose data on the 1.x → 2.0 import paths.
// M1 / M2 are fixed in controller.importLatestBackup and fail without the fix; the rest pin behaviour that already
// held (each would catch a regression). M3 was a todo test; D9 fixed it (here, and kept.test.mjs for the size warning).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createStore, memoryStorage, migrate, STORAGE_KEY, LIBRARY_MAX_CHARS, LIBRARY_RESTORE_MAX_CHARS,
  DEVICE_LOCAL_SETTINGS,
} from '../../../app/js/store.js';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { FACTORY_SONGS } from '../../../app/js/presets.js';
import { fakeEngine, fakeTimers, fakeDoc, tick } from '../../phase1/shell/helpers.mjs';
import { fixture, nativeShell, electronHost, writeAged, rotationName, tmpDir, plain, jsonDiff } from './lib.mjs';

const dirs = [];
const mk = (tag) => {
  const d = tmpDir(tag);
  dirs.push(d);
  return d;
};
let savedLocation;
before(() => {
  savedLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: { origin: 'rig://app' }, configurable: true, writable: true });
});
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  if (savedLocation) Object.defineProperty(globalThis, 'location', savedLocation);
  else delete globalThis.location;
});

let ids = 0;
const makeStore = (opts = {}) => createStore({
  storage: memoryStorage(), idGen: (p) => `${p}-k${++ids}`, requestIdle: null, warn: () => {}, autoFlush: false, ...opts,
});
async function setup({ store = makeStore(), rig, timers = fakeTimers() }) {
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const warns = [];
  const ctl = createController({
    store, engine: fakeEngine(), midi, recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(), rig,
    timers, now: () => 0, locks: null, heartbeat: false, indexedDB: null,
  });
  ctl.addEventListener('warn', (e) => warns.push(e.detail.message));
  await ctl.start();
  await tick();
  return { store, ctl, warns, timers };
}
const v1 = (name, form = 'backup') => fixture('v1.1.0', `${name}.${form}.json`);
const v1State = (name) => JSON.parse(fixture('v1.1.0', `${name}.localstorage.json`));
/** A host whose backupNow waits for `release()` (the IPC / native write round trip). */
function slowHost(text) {
  const files = [];
  const waiting = [];
  const rig = {
    isElectron: true, platform: 'darwin', onMenu: () => () => {},
    backupNow: (json) => new Promise((res) => waiting.push(() => {
      files.push(json);
      res({ path: `/backups/rig-${files.length}.json` });
    })),
    latestBackup: async () => ({ path: '/backups/rig-1x.json', origin: null, savedAt: 0, text }),
  };
  return { rig, files, release: () => waiting.splice(0).forEach((f) => f()), waiting };
}

// ===================================================================================== M1: edits during the backup
test('M1: an edit made while the pre-import backup is being written is in that backup (it was in neither)', async () => {
  const host = slowHost(v1('rich'));
  const { store, ctl } = await setup({ rig: host.rig });
  store.set('song.tempo', 97);
  const p = ctl.importLatestBackup();
  await tick();
  assert.equal(host.waiting.length, 1);
  store.set(`songs.${store.get().songOrder[0]}.name`, 'EDIT DURING BACKUP'); // a MIDI fader, a scene, a menu command
  host.release();
  await tick();
  assert.equal(host.waiting.length, 1, 'the library changed under the backup: it is written again');
  host.release();
  const r = await p;
  assert.equal(r.ok, true, r.error);
  assert.ok(host.files.at(-1).includes('EDIT DURING BACKUP'), 'the newest backup holds the edit');
  // and that backup restores the library exactly as it was when it was replaced
  const back = makeStore();
  assert.equal(back.importJSON(host.files.at(-1), { replace: true }).ok, true);
  assert.equal(back.getSong(back.get().songOrder[0]).name, 'EDIT DURING BACKUP');
});

test('M1: a library that keeps changing under three backups is not replaced', async () => {
  const host = slowHost(v1('rich'));
  const { store, ctl, warns } = await setup({ rig: host.rig });
  store.set('song.tempo', 97);
  const p = ctl.importLatestBackup();
  for (let i = 0; i < 3; i++) {
    await tick();
    store.set('song.tempo', 60 + i);
    host.release();
  }
  const r = await p;
  assert.deepEqual(r, { ok: false, error: 'backup failed' });
  assert.equal(store.get().songs[store.get().settings.currentSongId].tempo, 62, 'the library is the user’s own');
  assert.ok(warns.some((w) => /kept changing/.test(w)));
});

test('M1: device-local writes during the backup (MIDI input chosen) do not force another backup', async () => {
  const host = slowHost(v1('rich'));
  const { store, ctl } = await setup({ rig: host.rig });
  store.set('song.tempo', 97);
  const p = ctl.importLatestBackup();
  await tick();
  store.set('settings.midiInputName', 'Stage Piano'); // device-local: never in a backup, kept by the replace
  host.release();
  assert.equal((await p).ok, true);
  assert.equal(host.files.length, 1);
  assert.equal(store.get().settings.midiInputName, 'Stage Piano');
});

// ===================================================================================== M2: two imports at once
test('M2: the native picker fired twice imports the picked file once; one pre-import backup', async () => {
  // before: the second call got latestAnywhere() (the staged file is served once), i.e. an older own or Electron
  // backup, and replaced the picked library with it after the first import finished
  const own = mk('own');
  const eDir = mk('electron');
  writeAged(rotationName(eDir), v1('deleted-factory'));
  const shell = nativeShell({ ownDir: own, electronDirs: [eDir], platform: 'darwin' });
  const { store, ctl } = await setup({ rig: shell.rig });
  store.set('song.tempo', 97);
  const file = writeAged(path.join(mk('inbox'), 'Worship Rig library.json'), v1('rich', 'export'));
  assert.equal(shell.pick(file), 'staged');
  const second = ctl.importLatestBackup(); // e.g. the Settings button pressed while the menu import runs
  const [first] = await shell.shell.settled;
  const r2 = await second;
  assert.equal(first.ok, true, first.error);
  assert.deepEqual(r2, first, 'the second call gets the running import’s result');
  const names = new Set(Object.values(store.get().songs).map((s) => s.name));
  assert.ok(names.has('Grace Overflows (Live)'), 'the picked (rich) library, not the Electron one');
  assert.equal(shell.ownList().length, 1, 'one pre-import backup');
  // after it settles, a new call runs again
  assert.equal((await ctl.importLatestBackup()).ok, true);
});

// ===================================================================================== data shapes
test('unknown fields at every level survive replace, merge, reload and export → re-import', () => {
  const st = v1State('rich');
  const id = st.songOrder.find((i) => st.songs[i].patch.slots[0] && st.songs[i].patch.slots[0].eq);
  const s = st.songs[id];
  const U = { u: [1, { deep: 'x' }] };
  st.futureTop = U;
  Object.assign(s, { futureSong: U });
  Object.assign(s.patch, { futurePatch: U });
  Object.assign(s.patch.slots[0], { futureSlot: U });
  Object.assign(s.patch.slots[0].instrument, { futureInstrument: U });
  Object.assign(s.patch.slots[0].sends, { futureSend: U });
  Object.assign(s.patch.slots[0].eq, { futureEq: U });
  Object.assign(s.patch.fx, { futureFx: U });
  Object.assign(s.patch.fx.reverb, { futureReverb: U });
  Object.assign(s.patch.modWheel, { futureWheel: U });
  Object.assign(s.drone, { futureDrone: U });
  Object.assign(st.setlists[st.setlistOrder[0]], { futureSetlist: U });
  Object.assign(st.settings, { futureSetting: U });
  Object.assign(st.settings.midiLearn[Object.keys(st.settings.midiLearn)[0]], { futureLearn: U });
  Object.assign(st.meta, { futureMeta: U });
  const paths = ['futureTop', `songs.${id}.futureSong`, `songs.${id}.patch.futurePatch`,
    `songs.${id}.patch.slots.0.futureSlot`, `songs.${id}.patch.slots.0.instrument.futureInstrument`,
    `songs.${id}.patch.slots.0.sends.futureSend`, `songs.${id}.patch.slots.0.eq.futureEq`,
    `songs.${id}.patch.fx.futureFx`, `songs.${id}.patch.fx.reverb.futureReverb`,
    `songs.${id}.patch.modWheel.futureWheel`, `songs.${id}.drone.futureDrone`,
    `setlists.${st.setlistOrder[0]}.futureSetlist`, 'settings.futureSetting', 'meta.futureMeta'];
  const at = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
  const text = JSON.stringify(st);
  // replace
  const a = makeStore();
  assert.equal(a.importJSON(text, { replace: true }).ok, true);
  for (const p of paths) assert.deepEqual(at(a.get(), p), U, `replace: ${p}`);
  const learned = Object.values(a.get().settings.midiLearn).find((v) => v.futureLearn);
  assert.deepEqual(learned && learned.futureLearn, U, 'replace: midiLearn entry');
  // export → re-import (2.0 backup / export file)
  const b = makeStore();
  assert.equal(b.importJSON(a.exportJSON(), { replace: true }).ok, true);
  // M5 (low, pre-existing): an unknown TOP-LEVEL field is kept in the state but exportJSON writes only the known
  // keys, so it is not in any backup or export. 1.x never wrote one (its envelope keys are stripped on purpose).
  assert.deepEqual(jsonDiff(plain(a.get()), plain(b.get())), [`futureTop: ${JSON.stringify(U)} -> undefined`]);
  // same-origin load from localStorage
  const c = makeStore({ storage: memoryStorage({ [STORAGE_KEY]: text }) });
  for (const p of paths) assert.deepEqual(at(c.get(), p), U, `load: ${p}`);
  // merge keeps the song- and setlist-level ones (settings / meta / top level are not merged, by design)
  const m = makeStore();
  const r = m.importJSON(text);
  const newId = r.songIds[st.songOrder.indexOf(id)];
  for (const p of paths.filter((x) => x.startsWith('songs.'))) {
    assert.deepEqual(at(m.get(), p.replace(id, newId)), U, `merge: ${p}`);
  }
  assert.deepEqual(m.get().setlists[r.setlistIds[0]].futureSetlist, U);
});

test('setlists that name deleted songs, repeated songs, duplicate ids: nothing that exists is dropped', () => {
  const st = v1State('rich');
  const sl = st.setlistOrder[0];
  const [a, b] = st.songOrder;
  st.setlists[sl].songIds = [a, 'song_gone', a, b, 'song_gone2', a];
  st.songOrder = [a, a, ...st.songOrder, 'song_gone'];
  st.settings.currentSongId = 'song_gone';
  const s = makeStore();
  assert.equal(s.importJSON(JSON.stringify(st), { replace: true }).ok, true);
  assert.deepEqual(s.get().setlists[sl].songIds, [a, a, b, a], 'a song twice in a set stays twice');
  assert.equal(s.get().songOrder.length, 20, 'each song once in the library order');
  assert.ok(s.get().songs[s.get().settings.currentSongId], 'a current song that exists');
  const m = makeStore();
  const r = m.importJSON(JSON.stringify(st));
  const got = m.get().setlists[r.setlistIds[0]].songIds;
  assert.equal(got.length, 4);
  assert.equal(got[0], got[1]);
  // a hand-written array library with a duplicate id: both songs kept
  const arr = { kind: 'library', songs: [{ id: 'x', name: 'A' }, { id: 'x', name: 'B' }] };
  const h = makeStore();
  assert.equal(h.importJSON(JSON.stringify(arr), { replace: true }).ok, true);
  assert.deepEqual(h.get().songOrder.map((i) => h.get().songs[i].name), ['A', 'B']);
});

test('midiLearn with odd keys: kept (dots, emoji, spaces, numbers), prototype keys refused, no pollution', () => {
  const st = v1State('rich');
  st.settings.midiLearn = {
    'slots.7.gain': { cc: 2, channel: 0 }, 'a.b.c': { cc: 3, channel: null }, 0: { note: 4, channel: null },
    '😀': { cc: 8, channel: null }, 'nextSong ': { cc: 9, channel: null }, toString: { cc: 5, channel: null },
  };
  const raw = JSON.stringify(st).replace('"midiLearn":{', '"midiLearn":{"__proto__":{"cc":11},"constructor":{"cc":12},');
  const s = makeStore();
  assert.equal(s.importJSON(raw, { replace: true }).ok, true);
  const ml = s.get().settings.midiLearn;
  for (const k of ['slots.7.gain', 'a.b.c', '0', '😀', 'nextSong ']) assert.ok(Object.hasOwn(ml, k), k);
  // isReservedKey (L2) refuses Object.prototype names; no control id is one, so nothing real is lost
  for (const k of ['__proto__', 'constructor', 'toString']) assert.equal(Object.hasOwn(ml, k), false, k);
  assert.equal(({}).cc, undefined, 'no prototype pollution');
  const back = makeStore();
  back.importJSON(s.exportJSON(), { replace: true });
  assert.deepEqual(back.get().settings.midiLearn, ml);
});

test('instruments whose pack or id is missing here keep their reference (nothing is swapped for a default)', () => {
  const st = v1State('rich');
  const id = st.songOrder.find((i) => st.songs[i].patch.slots.some((x) => x && x.instrument.id === 'user:my-grand'));
  const slots = st.songs[id].patch.slots;
  slots[0].instrument = { type: 'sampler', id: 'user:pack-not-on-this-mac', futureField: 1 };
  slots[1].instrument = { type: 'sampler', id: 'factory-id-from-a-newer-build' };
  const s = makeStore();
  assert.equal(s.importJSON(JSON.stringify(st), { replace: true }).ok, true);
  const got = s.get().songs[id].patch.slots.map((x) => x && x.instrument);
  assert.deepEqual(got[0], slots[0].instrument);
  assert.deepEqual(got[1], slots[1].instrument);
  assert.ok(got.some((x) => x && x.id === 'user:my-grand'));
});

test('NFC and NFD names stay byte for byte (songs, setlists); merge treats them as different names', () => {
  const nfc = 'Café Ångström';
  const nfd = nfc.normalize('NFD');
  assert.notEqual(nfc, nfd);
  const st = v1State('rich');
  const [a, b] = st.songOrder;
  st.songs[a].name = nfc;
  st.songs[b].name = nfd;
  st.setlists[st.setlistOrder[0]].name = nfd;
  const s = makeStore();
  s.importJSON(JSON.stringify(st), { replace: true });
  assert.equal(s.get().songs[a].name, nfc);
  assert.equal(s.get().songs[b].name, nfd);
  assert.equal(s.get().setlists[st.setlistOrder[0]].name, nfd);
  const back = makeStore();
  back.importJSON(s.exportJSON(), { replace: true });
  assert.equal(back.get().songs[b].name, nfd);
});

test('size cap: a library at the cap imports; this machine’s kept settings may take it a little past (not refused)', () => {
  const st = JSON.parse(v1('huge').replace(/^\{"origin":"[^"]+",/, '{'));
  const pad = (target) => {
    const l = plain(st);
    l.songs[l.songOrder[0]].ccli = '';
    const base = JSON.stringify(migrate(l)).length;
    l.songs[l.songOrder[0]].ccli = 'x'.repeat(target - base);
    return JSON.stringify(l);
  };
  const s = makeStore();
  s.update((d) => {
    d.settings.hotkeys = { on: true, keys: { nextSong: 'F13', panic: 'F14' } };
  });
  const mine = plain(s.get().settings.hotkeys);
  const r = s.importJSON(pad(LIBRARY_MAX_CHARS - 10), { replace: true });
  assert.equal(r.ok, true, 'the cap counts the library content, which is what a backup of it carries');
  assert.deepEqual(plain(s.get().settings.hotkeys), mine);
  assert.ok(JSON.stringify(s.get()).length > LIBRARY_MAX_CHARS, 'M6: a few chars past the cap (informational)');
  // far over the cap (the text pre-check, before parsing) is refused and changes nothing
  const t = makeStore();
  const before0 = plain(t.get());
  assert.equal(t.importJSON('x'.repeat(4 * LIBRARY_MAX_CHARS + 1), { replace: true }).ok, false);
  assert.deepEqual(plain(t.get()), before0);
});

test('M3 (D9): a library grown past the cap by edits is saved, warned about, and restores its own backup', () => {
  const st = JSON.parse(v1('huge').replace(/^\{"origin":"[^"]+",/, '{'));
  const g = makeStore();
  assert.equal(g.importJSON(JSON.stringify(st), { replace: true }).ok, true);
  const order = g.get().songOrder;
  for (let i = 0; i < 12; i++) g.set(`songs.${order[i]}.notes`, 'n'.repeat(10000));
  assert.ok(JSON.stringify(g.get()).length > LIBRARY_MAX_CHARS, 'grown past the cap by ordinary writes');
  const backup = `{"origin":"rig://app",${g.exportJSON({ pretty: false }).slice(1)}`;
  assert.ok(backup.length <= LIBRARY_RESTORE_MAX_CHARS, `${backup.length} chars: inside the 1.25× restore limit`);
  assert.equal(makeStore().importJSON(backup, { replace: true }).ok, true);
  assert.equal(makeStore().importJSON(g.exportJSON(), { replace: true }).ok, true, 'and its pretty export');
  // the save itself is not refused; it raises one size notice (the controller toasts it: kept.test.mjs)
  const storage = memoryStorage();
  const h = makeStore({ storage, debounceMs: 0 });
  const notices = [];
  h.onNotice((n) => notices.push(n.type));
  assert.equal(h.importJSON(JSON.stringify(g.get()), { replace: true }).ok, true);
  assert.equal(h.persistNow(), true);
  assert.equal(storage.getItem(STORAGE_KEY).length, JSON.stringify(h.get()).length);
  assert.deepEqual(notices, ['library-size']);
  // a merge past the cap is still refused (only a replace / restore gets the 1.25×)
  assert.match(makeStore().importJSON(backup).error, /too large/);
});

// ===================================================================================== factory songs + top-up
test('factory songs edited / untouched / deleted in 1.x keep their state through the import and the next launches', () => {
  const st = v1State('deleted-factory');
  const storage = memoryStorage();
  const s = makeStore({ storage, debounceMs: 0 });
  assert.equal(s.importJSON(JSON.stringify(st), { replace: true }).ok, true);
  s.dispose();
  // the next launches: main.js calls seedFactory(FACTORY_SONGS) every time
  for (let i = 0; i < 2; i++) {
    const again = makeStore({ storage, debounceMs: 0 });
    assert.deepEqual(again.seedFactory(FACTORY_SONGS), [], 'nothing re-added (same factory version)');
    const fids = new Set(Object.values(again.get().songs).map((x) => x.factoryId).filter(Boolean));
    for (const sng of Object.values(st.songs)) assert.deepEqual(plain(again.get().songs[sng.id]).name, sng.name);
    assert.equal(again.get().songOrder.length, st.songOrder.length);
    assert.ok(fids.size <= FACTORY_SONGS.length);
    again.dispose();
  }
});

// ===================================================================================== interrupted / quota
test('a crash in the store write after the backup: library unchanged, the backup restores it', async () => {
  const host = electronHost(mk('electron'));
  const { store, ctl } = await setup({ rig: host.rig });
  store.set('song.tempo', 97);
  writeAged(rotationName(host.dir), v1('rich')); // the 1.x file as the newest
  const mine = plain(store.get());
  const real = store.importJSON;
  store.importJSON = (t, o = {}) => {
    if (!o.dryRun) throw new Error('crash in the write');
    return real.call(store, t, o);
  };
  await assert.rejects(ctl.importLatestBackup(), /crash in the write/);
  store.importJSON = real;
  assert.deepEqual(plain(store.get()), mine);
  const newest = host.list()[0];
  const back = makeStore();
  assert.equal(back.importJSON(fs.readFileSync(newest.path, 'utf8'), { replace: true }).ok, true);
  assert.equal(back.get().songs[back.get().settings.currentSongId].tempo, 97);
  // the M2 guard is released after a throw: the next call runs (it imports the newest file, the 2.0 backup)
  assert.equal((await ctl.importLatestBackup()).ok, true);
  assert.equal(store.get().songs[store.get().settings.currentSongId].tempo, 97);
});

test('localStorage quota during the replace: the old library stays on disk until a save succeeds; a crash keeps it', async () => {
  const base = memoryStorage();
  let full = false;
  const storage = {
    getItem: base.getItem, removeItem: base.removeItem, key: base.key, keys: base.keys,
    get length() {
      return base.length;
    },
    setItem(k, v) {
      if (full && k === STORAGE_KEY) throw Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });
      base.setItem(k, v);
    },
  };
  const timers = fakeTimers();
  const store = makeStore({ storage, timers, debounceMs: 0 });
  store.set('song.tempo', 97);
  store.persistNow();
  const saved = base.getItem(STORAGE_KEY);
  const host = electronHost(mk('electron'));
  const { ctl, warns } = await setup({ store, rig: host.rig, timers });
  writeAged(rotationName(host.dir), v1('rich'));
  full = true;
  assert.equal((await ctl.importLatestBackup()).ok, true);
  for (let i = 0; i < 3; i++) timers.runTimeouts();
  assert.equal(base.getItem(STORAGE_KEY), saved, 'setItem is all or nothing: the old library, whole');
  assert.ok(store.loadInfo.persistError);
  assert.ok(warns.some((w) => /could not be saved/.test(w)), 'the user is told');
  const reborn = makeStore({ storage: base });
  assert.equal(reborn.get().songs[reborn.get().settings.currentSongId].tempo, 97, 'a crash now: the old library');
  full = false;
  store.persistNow();
  assert.notEqual(base.getItem(STORAGE_KEY), saved, 'saved once the quota allows');
});

// ===================================================================================== pristine (O-AW-E5)
test('O-AW-E5: only an untouched library is replaced by Settings › Import…; every kind of edit makes it merge', () => {
  const merges = {
    'a setting (latency)': (s) => s.set('settings.latency', 'balanced'),
    'the library order': (s) => s.set('songOrder', s.get().songOrder.slice().reverse()),
    'a setlist order': (s) => s.moveSong(s.get().setlistOrder[0], 0, 2),
    'a new setlist': (s) => s.addSetlist('Mine', []),
    'MIDI Learn': (s) => s.setMidiLearn('nextSong', { note: 60, channel: null }),
    'Program Change': (s) => s.set('settings.programChange', true),
    'pedal polarity': (s) => s.set('settings.pedalInvert', true),
    'the view': (s) => s.set('settings.view', 'edit'),
    'a chart': (s) => s.setChart(s.get().songOrder[0], { format: 'plain', text: 'G C D' }),
    'a deleted song': (s) => s.deleteSong(s.get().songOrder[0]),
    'a song level': (s) => s.set('slots.0.gain', 0.5),
  };
  for (const [what, edit] of Object.entries(merges)) {
    const s = makeStore();
    edit(s);
    assert.equal(s.pristine, false, what);
    const mine = plain(s.get());
    const r = s.importJSON(v1('rich', 'export'), { replacePristine: true });
    assert.equal(r.ok && !r.replaced, true, `${what}: merged`);
    for (const [id, song] of Object.entries(mine.songs)) assert.deepEqual(plain(s.get().songs[id]), song, `${what}: ${id}`);
    const j = (v) => JSON.stringify(v);
    for (const k of Object.keys(mine.settings)) assert.equal(j(s.get().settings[k]), j(mine.settings[k]), `${what}: ${k}`);
  }
  // still pristine (replaced): navigation, device-local settings (kept by the replace), the theme
  const replaces = {
    'a song selected': (s) => s.selectSongId(s.get().songOrder[3]),
    'keyboards (device-local)': (s) => s.setKeyboard('Stage', { remember: true }),
    'hotkeys (device-local)': (s) => s.set('settings.hotkeys', { on: true, keys: { panic: 'F13' } }),
    'the theme (look)': (s) => s.set('settings.theme', 'studio'),
  };
  for (const [what, edit] of Object.entries(replaces)) {
    const s = makeStore();
    edit(s);
    assert.equal(s.pristine, true, what);
    const local = Object.fromEntries(DEVICE_LOCAL_SETTINGS.map((k) => [k, s.get().settings[k]]));
    assert.equal(s.importJSON(v1('rich', 'export'), { replacePristine: true }).replaced, true, what);
    const j = (v) => JSON.stringify(v);
    for (const k of DEVICE_LOCAL_SETTINGS) assert.equal(j(s.get().settings[k]), j(local[k]), `${what}: ${k} kept`);
  }
});

test('O-AW-E5: pristine is persisted both ways (an edit before a relaunch still merges)', () => {
  const st = memoryStorage();
  const a = makeStore({ storage: st, debounceMs: 0 });
  a.set('settings.latency', 'balanced');
  a.dispose();
  const b = makeStore({ storage: st });
  assert.equal(b.pristine, false);
  assert.equal(b.importJSON(v1('rich', 'export'), { replacePristine: true }).replaced, undefined);
  const st2 = memoryStorage();
  makeStore({ storage: st2, debounceMs: 0 }).dispose();
  assert.equal(makeStore({ storage: st2 }).pristine, true);
});

// ===================================================================================== dryRun
test('dryRun: no storage write, no event, no generation bump, no meta.edited flip, for every option and input', async () => {
  let writes = 0;
  const base = memoryStorage();
  const storage = {
    getItem: base.getItem, key: base.key, keys: base.keys,
    get length() {
      return base.length;
    },
    setItem: (k, v) => {
      writes += 1;
      base.setItem(k, v);
    },
    removeItem: (k) => {
      writes += 1;
      base.removeItem(k);
    },
  };
  for (const edited of [false, true]) {
    const s = makeStore({ storage, debounceMs: 0 });
    if (edited) s.set('song.tempo', 99);
    s.persistNow();
    await tick(); // the edit's own notification (a microtask) is not a dryRun event
    const w0 = writes;
    let events = 0;
    s.subscribe(() => {
      events += 1;
    });
    const gen = s.generation;
    const before0 = JSON.stringify(s.get());
    const inputs = [v1('rich'), v1('rich', 'export'), v1('empty'), v1('pristine', 'export'), '{}', '{"songs":{}}',
      'not json', JSON.stringify({ ...v1State('rich'), schema: 9 }), v1('rich').slice(0, 900)];
    for (const t of inputs) {
      for (const o of [{ replace: true }, {}, { replacePristine: true }]) s.importJSON(t, { ...o, dryRun: true });
    }
    await tick();
    assert.equal(writes - w0, 0);
    assert.equal(events, 0);
    assert.equal(s.generation, gen);
    assert.equal(JSON.stringify(s.get()), before0);
    assert.equal(s.pristine, !edited);
    s.dispose();
  }
});
