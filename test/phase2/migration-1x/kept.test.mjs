// D8 / D9 (native/docs/DECISIONS.md; review E5 M4, M3): kept copies of whole libraries are never rotated away,
// "Restore previous library…" brings one back after keeping the current library, and the size cap warns on saves
// but lets a replace / restore through up to 1.25× (the M3 todo, now real tests).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createStore, memoryStorage, STORAGE_KEY, SCHEMA, LIBRARY_MAX_CHARS, LIBRARY_RESTORE_MAX_CHARS, BACKUPS_KEEP,
  SEPARATE_1X_SUFFIX,
} from '../../../app/js/store.js';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { fakeEngine, fakeTimers, fakeDoc, tick } from '../../phase1/shell/helpers.mjs';
import { fixture, electronHost, tmpDir, plain } from './lib.mjs';

const dirs = [];
const mk = (tag) => {
  const d = tmpDir(tag);
  dirs.push(d);
  return d;
};
let savedLocation;
before(() => {
  savedLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: { origin: 'http://127.0.0.1:8437' }, configurable: true, writable: true });
});
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  if (savedLocation) Object.defineProperty(globalThis, 'location', savedLocation);
  else delete globalThis.location;
});

let ids = 0;
let clock = 1000;
const makeStore = (opts = {}) => createStore({
  storage: memoryStorage(), idGen: (p) => `${p}-q${++ids}`, requestIdle: null, warn: () => {}, autoFlush: false,
  now: () => (clock += 1000), ...opts,
});
async function setup({ store = makeStore(), rig = null } = {}) {
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
const quotaError = () => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
/** A localStorage stand-in with a quota: the sum of key + value lengths may not pass `limit` (as Chromium's ~5.2 M). */
function quotaStorage(limit, initial = {}) {
  const st = memoryStorage(initial);
  const size = () => st.keys().reduce((n, k) => n + k.length + st.getItem(k).length, 0);
  const setItem = st.setItem;
  st.setItem = (k, v) => {
    const old = st.getItem(k);
    const next = size() - (old === null ? 0 : k.length + old.length) + k.length + String(v).length;
    if (next > limit) throw quotaError();
    setItem(k, v);
  };
  st.size = size;
  return st;
}
const keptKeys = (st) => st.keys().filter((k) => k.startsWith(`${STORAGE_KEY}.kept-`)).sort();
const backupKeys = (st) => st.keys().filter((k) => k.startsWith(`${STORAGE_KEY}.backup-`)).sort();
/** A whole library text of a schema, about `chars` long (one song's notes pad it). */
function libText(schema, tag, chars = 0) {
  const s = makeStore({ seed: false });
  const id = s.addSong(null, { name: `Song ${tag}` });
  if (chars) s.set(`songs.${id}.notes`, 'n'.repeat(Math.min(10000, chars)));
  const doc = { ...JSON.parse(JSON.stringify(s.get())), schema };
  if (chars > 10000) doc.pad = 'p'.repeat(Math.max(0, chars - JSON.stringify(doc).length)); // an unknown field
  return JSON.stringify(doc);
}
/**
 * D8 skeptic K2: a later state of the same library (every song and setlist of `text`, plus one more song). Only such
 * a copy supersedes an older one under the quota policy.
 */
function grownFrom(text, tag) {
  const doc = JSON.parse(text);
  const first = Object.values(doc.songs)[0];
  const id = `${first.id}-${tag}`;
  doc.songs[id] = { ...first, id, name: `Song ${tag}` };
  doc.songOrder = [...(doc.songOrder || []), id];
  return JSON.stringify(doc);
}
const v1Text = (name) => fixture('v1.1.0', `${name}.localstorage.json`);

// ===================================================================================== D8: kept, never rotated
test('D8: a migration copy is a kept copy: never rotated, however many backups and launches follow', () => {
  const text = v1Text('rich');
  const storage = memoryStorage({ [STORAGE_KEY]: text });
  const s = makeStore({ storage, debounceMs: 0 });
  const key = s.loadInfo.migrationBackupKey;
  assert.match(key, /^rig\.v1\.kept-\d+\.migration\.s1$/);
  s.dispose();
  // ten launches, each over an unreadable library (the rotation adds a backup and prunes to BACKUPS_KEEP)
  for (let i = 0; i < 10; i++) {
    storage.setItem(STORAGE_KEY, `{"broken ${i}`);
    makeStore({ storage }).dispose();
  }
  assert.equal(backupKeys(storage).length, BACKUPS_KEEP, 'ordinary rotation still applies to other backups');
  assert.equal(storage.getItem(key), text, 'the 1.x copy is untouched');
});

test('D8: a newer library found here is a kept "downgrade" copy; a corrupt one goes to the rotation', () => {
  const future = libText(SCHEMA + 1, 'future');
  const storage = memoryStorage({ [STORAGE_KEY]: future });
  const s = makeStore({ storage });
  assert.equal(s.loadInfo.status, 'future-schema');
  assert.match(s.loadInfo.backupKey, new RegExp(`^rig\\.v1\\.kept-\\d+\\.downgrade\\.s${SCHEMA + 1}$`));
  assert.equal(storage.getItem(s.loadInfo.backupKey), future);
  const row = s.keptLibraries().find((e) => e.key === s.loadInfo.backupKey);
  assert.equal(row.restorable, false, 'a newer library cannot be restored here');
  assert.match(row.error, /newer version/);
  const c = makeStore({ storage: memoryStorage({ [STORAGE_KEY]: '{"nope' }) });
  assert.match(c.loadInfo.backupKey, /^rig\.v1\.backup-\d+$/);
});

test('D8: a whole library in the .backup- rotation (1.x sets a 2.0 library aside there) moves to a kept copy', () => {
  const v2 = libText(2, 'set aside by 1.1');
  const oldStyle = v1Text('rich'); // a 2.0 build before D8 kept its migration copies in the rotation
  const storage = memoryStorage({
    [STORAGE_KEY]: libText(1, 'the 1.x seed'),
    [`${STORAGE_KEY}.backup-100`]: v2,
    [`${STORAGE_KEY}.backup-200`]: oldStyle,
    [`${STORAGE_KEY}.backup-300`]: '{"corrupt',
    [`${STORAGE_KEY}.backup-400`]: v2, // the same text twice is kept once
  });
  const s = makeStore({ storage });
  assert.equal(s.loadInfo.adopted, 3);
  assert.deepEqual(backupKeys(storage), [`${STORAGE_KEY}.backup-300`], 'the unreadable text stays in the rotation');
  assert.equal(storage.getItem(`${STORAGE_KEY}.kept-100.downgrade.s2`), v2, 'its own time kept');
  assert.equal(storage.getItem(`${STORAGE_KEY}.kept-200.migration.s1`), oldStyle);
  assert.equal(storage.getItem(`${STORAGE_KEY}.kept-400.downgrade.s2`), null);
  // and the next launch moves nothing again
  assert.equal(makeStore({ storage }).loadInfo.adopted, undefined);
});

test('D8: when a rotation library cannot be moved (storage full), the rotation never prunes it', () => {
  const v2 = libText(2, 'stuck in the rotation', 3000);
  const init = { [STORAGE_KEY]: '{"broken' };
  for (const t of [1, 2, 3, 4]) init[`${STORAGE_KEY}.backup-${t}`] = `{"old ${t}`;
  init[`${STORAGE_KEY}.backup-0`] = v2; // the oldest key of all
  // a storage whose kept writes fail (full) and every other write succeeds
  const st = memoryStorage(init);
  const set = st.setItem;
  st.setItem = (k, v) => (k.includes('.kept-') ? (() => { throw quotaError(); })() : set(k, v));
  const s = makeStore({ storage: st });
  assert.equal(s.loadInfo.status, 'corrupt');
  assert.equal(st.getItem(`${STORAGE_KEY}.backup-0`), v2, 'the readable library is never pruned');
  assert.equal(backupKeys(st).filter((k) => st.getItem(k) !== v2).length, BACKUPS_KEEP, 'the others rotate');
});

test('D8 quota policy: room is made from older copies of a version that has a newer copy; the newest per version stays', () => {
  const big = 40000;
  const a1 = libText(1, 'a1', big);
  const b1 = grownFrom(a1, 'b1');
  const a2 = libText(2, 'a2', big);
  const b2 = grownFrom(a2, 'b2');
  const init = {
    [`${STORAGE_KEY}.kept-1.migration.s1`]: a1,
    [`${STORAGE_KEY}.kept-2.downgrade.s2`]: a2,
    [`${STORAGE_KEY}.kept-3.migration.s1`]: b1,
    [`${STORAGE_KEY}.kept-4.restore.s2`]: b2,
  };
  const st = quotaStorage(0, init);
  const limit = st.size() + 60000; // the library (~40 K) fits; one more ~40 K kept copy does not
  const storage = quotaStorage(limit, init);
  const s = makeStore({ storage, debounceMs: 0, seed: false });
  const notices = [];
  s.onNotice((n) => notices.push(n));
  s.set(`songs.${s.addSong(null, { name: 'Mine' })}.notes`, 'm'.repeat(10000));
  s.update((d) => {
    d.settings.padding = 'x'.repeat(30000);
  });
  assert.equal(s.persistNow(), true, 'the library is saved');
  const r = s.keepCurrent();
  assert.equal(r.ok, true, 'a superseded copy made room');
  // oldest superseded first: a1 (1.x, b1 is newer), then a2 (2.0, b2 is newer) if needed
  assert.equal(storage.getItem(`${STORAGE_KEY}.kept-1.migration.s1`), null);
  assert.equal(storage.getItem(`${STORAGE_KEY}.kept-3.migration.s1`), b1, 'the newest 1.x copy stays');
  assert.ok(storage.getItem(`${STORAGE_KEY}.kept-4.restore.s2`) === b2, 'the newest 2.0 copy before this one stays');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, 'kept-removed');
  assert.match(notices[0].message, /Browser storage was full/);
  assert.ok(notices[0].removed.some((e) => e.key === `${STORAGE_KEY}.kept-1.migration.s1`));
  // nothing superseded left for 1.x; a further copy may only remove older 2.0 copies, never the last 1.x one
  for (let i = 0; i < 3; i++) s.keepCurrent();
  const left = keptKeys(storage);
  assert.ok(left.includes(`${STORAGE_KEY}.kept-3.migration.s1`), 'the only 1.x copy is never removed');
  assert.ok(left.some((k) => /\.s2(\.\d+)?$/.test(k)), 'a 2.0 copy is kept');
  s.dispose();
});

test('D8 quota policy: when nothing is superseded, a copy is not kept and the caller is told (nothing removed)', () => {
  const only = libText(1, 'only', 40000);
  const init = { [`${STORAGE_KEY}.kept-1.migration.s1`]: only };
  const storage = quotaStorage(quotaStorage(0, init).size() + 30000, init);
  const s = makeStore({ storage, debounceMs: 0, seed: false });
  s.update((d) => {
    d.settings.padding = 'x'.repeat(20000);
  });
  assert.equal(s.persistNow(), true);
  assert.deepEqual(s.keepCurrent(), { ok: false, error: 'Browser storage is full, so the library could not be kept.' });
  assert.equal(storage.getItem(`${STORAGE_KEY}.kept-1.migration.s1`), only);
  s.dispose();
});

test('D8 quota policy: a library save that does not fit removes a superseded copy (with a notice) and is saved', () => {
  const old = libText(2, 'old', 40000);
  const init = {
    [`${STORAGE_KEY}.kept-1.restore.s2`]: old,
    [`${STORAGE_KEY}.kept-2.restore.s2`]: grownFrom(old, 'new'),
  };
  const storage = quotaStorage(quotaStorage(0, init).size() + 30000, init);
  const s = makeStore({ storage, debounceMs: 0, seed: false });
  const notices = [];
  s.onNotice((n) => notices.push(n));
  s.update((d) => {
    d.settings.padding = 'x'.repeat(40000);
  });
  assert.equal(s.persistNow(), true);
  assert.equal(storage.getItem(`${STORAGE_KEY}.kept-1.restore.s2`), null);
  assert.ok(storage.getItem(`${STORAGE_KEY}.kept-2.restore.s2`));
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /to save your changes/);
  s.dispose();
});

test('D8: keptLibraries lists kept copies and 1.1.1\'s separate library, newest first, with version and counts', () => {
  const storage = memoryStorage({
    [`${STORAGE_KEY}.kept-1000.migration.s1`]: v1Text('rich'),
    [`${STORAGE_KEY}.kept-3000.downgrade.s2`]: libText(2, 'two'),
    [`${STORAGE_KEY}.kept-2000.restore.s2`]: libText(2, 'three'),
    [`${STORAGE_KEY}${SEPARATE_1X_SUFFIX}`]: libText(1, 'separate'),
    [`${STORAGE_KEY}.kept-junk`]: 'not ours', // not a kept-copy name: ignored
  });
  const s = makeStore({ storage });
  const rows = s.keptLibraries();
  assert.deepEqual(rows.map((r) => [r.kind, r.version]), [
    ['separate', '1.x'], ['downgrade', '2.0'], ['restore', '2.0'], ['migration', '1.x'],
  ]);
  assert.ok(rows.every((r) => r.restorable), JSON.stringify(rows.map((r) => r.error)));
  const rich = JSON.parse(v1Text('rich'));
  assert.equal(rows[3].songs, rich.songOrder.length);
  assert.equal(rows[3].setlists, Object.keys(rich.setlists).length);
  assert.equal(rows[3].savedAt, 1000);
  // restoreKept takes only those keys
  for (const k of [STORAGE_KEY, `${STORAGE_KEY}.kept-junk`, `${STORAGE_KEY}.backup-1`, 'other', null]) {
    assert.equal(s.restoreKept(k).ok, false, String(k));
  }
  const r = s.restoreKept(`${STORAGE_KEY}.kept-1000.migration.s1`);
  assert.equal(r.ok, true);
  assert.deepEqual(s.get().songOrder, rich.songOrder);
  assert.ok(storage.getItem(`${STORAGE_KEY}.kept-1000.migration.s1`), 'the copy stays kept after a restore');
});

// ===================================================================================== D8: the controller action
test('D8: restorePreviousLibrary keeps the edited library first (exactly as replaced), then restores', async () => {
  const text = v1Text('rich');
  const storage = memoryStorage({ [`${STORAGE_KEY}.kept-5.migration.s1`]: text });
  const { store, ctl } = await setup({ store: makeStore({ storage, debounceMs: 0 }) });
  const mine = store.addSong(null, { name: 'Mine, edited in 2.0' });
  const before = JSON.stringify(store.get());
  const r = await ctl.restorePreviousLibrary(`${STORAGE_KEY}.kept-5.migration.s1`);
  assert.equal(r.ok, true, r.error);
  assert.match(r.keptKey, /^rig\.v1\.kept-\d+\.restore\.s2$/);
  assert.equal(storage.getItem(r.keptKey), before, 'byte for byte the library that was replaced');
  assert.equal(store.getSong(mine), null);
  // and it comes back the same way
  const back = await ctl.restorePreviousLibrary(r.keptKey);
  assert.equal(back.ok, true, back.error);
  assert.equal(store.getSong(mine).name, 'Mine, edited in 2.0');
  assert.equal(ctl.listPreviousLibraries().filter((e) => e.kind === 'restore').length, 2);
});

test('D8: restorePreviousLibrary refuses when the current library cannot be kept, and changes nothing', async () => {
  const st = memoryStorage({ [`${STORAGE_KEY}.kept-5.migration.s1`]: v1Text('rich') });
  const set = st.setItem;
  const { store, ctl, warns } = await setup({ store: makeStore({ storage: st, debounceMs: 0 }) });
  store.addSong(null, { name: 'Mine' });
  const before = plain(store.get());
  st.setItem = (k, v) => (k.includes('.kept-') ? (() => { throw quotaError(); })() : set(k, v));
  assert.deepEqual(await ctl.restorePreviousLibrary(`${STORAGE_KEY}.kept-5.migration.s1`), { ok: false, error: 'backup failed' });
  assert.deepEqual(plain(store.get()), before);
  assert.ok(warns.some((w) => /could not be kept first/.test(w)));
});

test('D8: with a shell, the disk backup must succeed too; a pristine library is replaced without a backup', async () => {
  const st = memoryStorage({ [`${STORAGE_KEY}.kept-5.migration.s1`]: v1Text('rich') });
  const failing = electronHost(mk('fail'), { fail: 'disk full' });
  const a = await setup({ store: makeStore({ storage: st, debounceMs: 0 }), rig: failing.rig });
  a.store.addSong(null, { name: 'Mine' });
  assert.deepEqual(await a.ctl.restorePreviousLibrary(`${STORAGE_KEY}.kept-5.migration.s1`), { ok: false, error: 'backup failed' });
  assert.equal(keptKeys(st).length, 1, 'no kept copy written either');
  const host = electronHost(mk('ok'));
  const b = await setup({ store: makeStore({ storage: st, debounceMs: 0 }), rig: host.rig });
  b.store.addSong(null, { name: 'Mine' });
  const r = await b.ctl.restorePreviousLibrary(`${STORAGE_KEY}.kept-5.migration.s1`);
  assert.equal(r.ok, true, r.error);
  assert.equal(host.list().length, 1, 'one disk backup');
  assert.ok(r.keptKey);
  // pristine: a factory seed is replaced with no copy at all
  const st2 = memoryStorage({ [`${STORAGE_KEY}.kept-5.migration.s1`]: v1Text('rich') });
  const c = makeStore({ storage: st2 });
  c.seedFactory();
  const pc = await setup({ store: c });
  assert.equal(c.pristine, true);
  const r2 = await pc.ctl.restorePreviousLibrary(`${STORAGE_KEY}.kept-5.migration.s1`);
  assert.equal(r2.ok, true);
  assert.equal(r2.keptKey, undefined);
  assert.equal(keptKeys(st2).length, 1);
});

test('D8: one import at a time (shared with importLatestBackup), and a read-only window does not restore', async () => {
  const st = memoryStorage({ [`${STORAGE_KEY}.kept-5.migration.s1`]: v1Text('rich') });
  let release;
  const rig = {
    isElectron: true, platform: 'darwin', onMenu: () => () => {},
    backupNow: () => new Promise((res) => {
      release = () => res({ path: '/b/1.json' });
    }),
    latestBackup: async () => ({ path: '/b/x.json', text: v1Text('rich') }),
  };
  const { store, ctl } = await setup({ store: makeStore({ storage: st, debounceMs: 0 }), rig });
  store.addSong(null, { name: 'Mine' });
  const p1 = ctl.restorePreviousLibrary(`${STORAGE_KEY}.kept-5.migration.s1`);
  const p2 = ctl.importLatestBackup();
  const p3 = ctl.restorePreviousLibrary(`${STORAGE_KEY}.kept-5.migration.s1`);
  assert.equal(p2, p1);
  assert.equal(p3, p1);
  await tick();
  release();
  assert.equal((await p1).ok, true);
  store.setReadOnly(true);
  const r = await ctl.restorePreviousLibrary(`${STORAGE_KEY}.kept-5.migration.s1`);
  assert.deepEqual(r, { ok: false, error: 'read-only' });
});

test('D8: a pristine library with a 2.0 library set aside by 1.x: one warning says where it is', async () => {
  const v2 = libText(2, 'the user’s 2.0 library');
  const seed = makeStore();
  seed.seedFactory();
  const seed1 = JSON.stringify({ ...JSON.parse(JSON.stringify(seed.get())), schema: 1 });
  const storage = memoryStorage({ [STORAGE_KEY]: seed1, [`${STORAGE_KEY}.backup-${Date.UTC(2026, 10, 20)}`]: v2 });
  const s = makeStore({ storage });
  assert.equal(s.pristine, true);
  assert.equal(s.loadInfo.migrationBackupKey, undefined, 'a 1.x factory seed is not kept');
  const { warns, ctl } = await setup({ store: s });
  const w = warns.filter((x) => /set aside by Worship Rig 1\.x/.test(x));
  assert.equal(w.length, 1);
  assert.match(w[0], /Restore previous library/);
  const row = ctl.listPreviousLibraries()[0];
  assert.equal(row.kind, 'downgrade');
  assert.equal((await ctl.restorePreviousLibrary(row.key)).ok, true);
  assert.ok(Object.values(s.get().songs).some((x) => x.name === 'Song the user’s 2.0 library'));
});

// ===================================================================================== D9: the size cap
/** A library of ~`chars` characters, as a replace-import file (12 songs with 10 000-character notes, plus padding). */
function hugeLibrary(chars) {
  const s = makeStore();
  const notes = 'n'.repeat(10000);
  const per = 10000 + 2000;
  for (let i = 0; i * per < chars - 20000; i++) s.set(`songs.${s.addSong(null, { name: `S${i}` })}.notes`, notes);
  return s;
}

test('D9 / M3: a library grown past the cap by edits is saved (with a warning) and restores its own backup', async () => {
  const g = hugeLibrary(LIBRARY_MAX_CHARS - 30000);
  const st = memoryStorage({ [STORAGE_KEY]: JSON.stringify(g.get()) });
  const { store, warns } = await setup({ store: makeStore({ storage: st, debounceMs: 0 }) });
  const order = store.get().songOrder;
  for (let i = 0; i < 6; i++) store.set(`songs.${order[i]}.notes`, `${'N'.repeat(9999)}${i}`);
  // C-SHIP skeptic (O4 per D9): a new song past the cap is an ordinary save: it is added, and the save warns
  assert.ok(store.addSong(null, { name: 'one more' }), 'an add past the cap goes through');
  for (let i = 0; i < 4; i++) {
    const id = store.addSong(null, { name: `more ${i}` });
    assert.ok(id, `add ${i} past the cap goes through`);
    store.set(`songs.${id}.notes`, 'n'.repeat(10000));
  }
  assert.equal(store.persistNow(), true, 'the save is not refused');
  const size = JSON.stringify(store.get()).length;
  assert.ok(size > LIBRARY_MAX_CHARS, `grown past the cap by ordinary writes (${size})`);
  assert.equal(JSON.parse(st.getItem(STORAGE_KEY)).songOrder.length, store.get().songOrder.length, 'saved');
  await tick();
  assert.equal(warns.filter((w) => /more than the 2\.0 MB/.test(w)).length, 1, 'the controller toasts the notice');
  // its own backup (Electron / native: libraryJSON with the origin tag) and its export restore it
  const backup = `{"origin":"rig://app",${store.exportJSON({ pretty: false }).slice(1)}`;
  for (const text of [backup, store.exportJSON()]) {
    const t = makeStore();
    const r = t.importJSON(text, { replace: true });
    assert.equal(r.ok, true, r.error);
    assert.equal(t.get().songOrder.length, store.get().songOrder.length);
  }
  // and a pristine replace (Settings › Import… on a fresh seed)
  const fresh = makeStore();
  fresh.seedFactory();
  assert.equal(fresh.importJSON(backup, { replacePristine: true }).replaced, true);
});

test('D9: the size warning comes once per session, then again at each further 10 % of growth', () => {
  const st = memoryStorage();
  const s = makeStore({ storage: st, debounceMs: 0 });
  const notices = [];
  s.onNotice((n) => notices.push(n));
  const grow = (to) => {
    s.update((d) => {
      d.settings.padding = 'x'.repeat(Math.max(0, to - (JSON.stringify(s.get()).length - (d.settings.padding || '').length)));
    });
    s.persistNow();
    return JSON.stringify(s.get()).length;
  };
  grow(LIBRARY_MAX_CHARS - 1000);
  assert.equal(notices.length, 0, 'under the cap: nothing');
  const first = grow(LIBRARY_MAX_CHARS + 1000);
  assert.equal(notices.length, 1);
  assert.deepEqual([notices[0].type, notices[0].chars, notices[0].cap], ['library-size', first, LIBRARY_MAX_CHARS]);
  grow(Math.floor(first * 1.05));
  grow(Math.floor(first * 1.09));
  assert.equal(notices.length, 1, 'less than 10 % more: no repeat');
  const second = grow(Math.ceil(first * 1.1) + 10);
  assert.equal(notices.length, 2);
  grow(Math.floor(second * 1.08));
  assert.equal(notices.length, 2);
  grow(Math.ceil(second * 1.1) + 10);
  assert.equal(notices.length, 3);
  // a new session warns again at once
  const again = makeStore({ storage: st, debounceMs: 0 });
  const n2 = [];
  again.onNotice((n) => n2.push(n));
  again.set('settings.view', 'edit');
  again.persistNow();
  assert.equal(n2.length, 1);
  // notices from before the first subscriber are delivered to it (load-time ones)
  const late = [];
  const s3 = makeStore({ storage: st, debounceMs: 0 });
  s3.set('settings.view', 'perform');
  s3.persistNow();
  s3.onNotice((n) => late.push(n));
  assert.equal(late.length, 1);
});

test('D9: a replace / restore imports up to 1.25× the cap; above that, and a merge above 1×, are refused', () => {
  const pad = (n) => {
    const l = JSON.parse(JSON.stringify(makeStore().get()));
    l.songs.a = { id: 'a', name: 'A', notes: '' };
    l.songOrder = ['a'];
    l.pad = '';
    l.pad = 'p'.repeat(n - JSON.stringify(l).length);
    return JSON.stringify(l);
  };
  const tooBig = /too large/;
  assert.equal(LIBRARY_RESTORE_MAX_CHARS, 2500000);
  // (migrate() fills song "a" in with its defaults, a few K, so the accepted file is a little under the limit)
  for (const [n, ok] of [[LIBRARY_RESTORE_MAX_CHARS - 20000, true], [LIBRARY_RESTORE_MAX_CHARS + 50, false]]) {
    const s = makeStore();
    const before = plain(s.get());
    const r = s.importJSON(pad(n), { replace: true });
    assert.equal(r.ok, ok, `${n}: ${r.error}`);
    if (!ok) {
      assert.match(r.error, tooBig);
      assert.deepEqual(plain(s.get()), before, 'refused: nothing changed');
    }
    const p = makeStore();
    p.seedFactory();
    assert.equal(p.importJSON(pad(n), { replacePristine: true }).ok, ok, `pristine replace ${n}`);
  }
  // merge: the result must still fit the cap itself
  const m = makeStore();
  assert.match(m.importJSON(pad(LIBRARY_MAX_CHARS + 1000)).error, tooBig);
  assert.equal(m.importJSON(pad(LIBRARY_MAX_CHARS - 50000)).ok, true);
  // a pretty-printed restore of a 1.25× library is not refused by the text pre-check
  const s = makeStore();
  const pretty = JSON.stringify(JSON.parse(pad(LIBRARY_RESTORE_MAX_CHARS - 20000)), null, 2);
  assert.ok(pretty.length > LIBRARY_RESTORE_MAX_CHARS);
  assert.equal(s.importJSON(pretty, { replace: true }).ok, true);
});
