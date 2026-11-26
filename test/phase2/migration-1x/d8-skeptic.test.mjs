// D8/D9 skeptic (native/docs/reviews/D8-D9.md): tries to lose a library with the real stores. 1.1.0 is
// `git archive v1.1.0 app/js`; 1.1.1 is that plus native/docs/patches/v1.1.1-prep.diff. One localStorage, the three
// versions taking turns in random order (seeded), with edits, crashes, restores and storage that fills up.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as S2 from '../../../app/js/store.js';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { fakeEngine, fakeTimers, fakeDoc, tick } from '../../phase1/shell/helpers.mjs';
import { ROOT, fixture, tmpDir, plain } from './lib.mjs';

const REF = 'v1.1.0';
const has = spawnSync('git', ['-C', ROOT, 'rev-parse', '--verify', '--quiet', `${REF}^{commit}`]).status === 0;
const PATCH = path.join(ROOT, 'native/docs/patches/v1.1.1-prep.diff');
const skip = has && fs.existsSync(PATCH) ? false : `needs tag ${REF} and ${PATCH}`;
let dir = null;
let S1 = null;
let S111 = null;
let savedLocation;
before(async () => {
  savedLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: { origin: 'http://127.0.0.1:8437' }, configurable: true, writable: true });
  if (skip) return;
  dir = tmpDir('d8sk');
  for (const [sub, patch] of [['v110', false], ['v111', true]]) {
    const d = path.join(dir, sub);
    fs.mkdirSync(d);
    const r = spawnSync('bash', ['-c', `git -C "${ROOT}" archive ${REF} app/js | tar -x -C "${d}"`
      + (patch ? ` && cd "${d}" && git apply --include='app/js/store.js' "${PATCH}"` : '')]);
    assert.equal(r.status, 0, String(r.stderr));
  }
  S1 = await import(path.join(dir, 'v110/app/js/store.js'));
  S111 = await import(path.join(dir, 'v111/app/js/store.js'));
});
after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  if (savedLocation) Object.defineProperty(globalThis, 'location', savedLocation);
  else delete globalThis.location;
});

/** mulberry32 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const NEVER = { setTimeout: () => 0, clearTimeout: () => {} }; // persists only on persistNow (close) / load
let n = 0;
const opts = (S, extra = {}) => ({
  storage: S.memoryStorage(), idGen: (p) => `${p}-k${++n}`, requestIdle: null, warn: () => {}, autoFlush: false,
  timers: NEVER, ...extra,
});
const namesOf = (lib) => JSON.stringify(Object.values((lib && lib.songs) || {}).map((x) => x.name).sort());
const copyOf = (st) => S2.memoryStorage(Object.fromEntries(st.keys().map((k) => [k, st.getItem(k)])));
const restoredNames = new Map(); // text → song names after a 2.0 replace import (what restoreKept does), or null
function namesAfterRestore(text) {
  if (!restoredNames.has(text)) {
    const t = S2.createStore(opts(S2));
    const r = t.importJSON(text, { replace: true });
    restoredNames.set(text, r.ok ? namesOf(t.get()) : null);
  }
  return restoredNames.get(text);
}
/** Every library 2.0 would open or offer under "Restore previous library…" if it started now (on a copy). */
function reachableIn20(storage) {
  const c = copyOf(storage);
  const s = S2.createStore(opts(S2, { storage: c }));
  const out = new Map();
  if (s.loadInfo.status === 'ok') out.set(namesOf(s.get()), 'rig.v1');
  for (const row of s.keptLibraries({ check: false })) {
    const got = namesAfterRestore(c.getItem(row.key));
    if (got && !out.has(got)) out.set(got, row.key);
  }
  return out;
}

const V = { '1.1.0': () => S1, '1.1.1': () => S111, '2.0': () => S2 };
/**
 * One random sequence. Each session: open (load), maybe restore a kept library (2.0), maybe edit (a uniquely named
 * song, sometimes a deleted song too), then close (persist) or crash (nothing written after load).
 * After every session every library that was ever saved must be reachable in 2.0.
 */
function sequence(seed, { sessions = 10 } = {}) {
  const r = rng(seed);
  // D11: a second stream, so the D8 sequences stay exactly what they were: 1.1.1 sessions export with the device
  // block (writing rig.install), 2.0 sessions take the newest such export's block in (device-local writes only)
  const r2 = rng(seed * 7919 + 1);
  let exported = null;
  let marker = null;
  const pick = (a) => a[Math.floor(r() * a.length)];
  const start = pick(['empty', 'rich-1x', 'unicode-1x', 'deleted-factory-1x']);
  const init = start === 'empty' ? {} : { [S2.STORAGE_KEY]: fixture(REF, `${start.replace(/-1x$/, '')}.localstorage.json`) };
  const storage = S2.memoryStorage(init);
  const saved = []; // {label, names}
  if (start !== 'empty') saved.push({ label: start, names: namesOf(JSON.parse(init[S2.STORAGE_KEY])), v: '1.x' });
  let t = Date.UTC(2026, 10, 1);
  const trace = [start];
  for (let i = 0; i < sessions; i++) {
    t += 3600000 + Math.floor(r() * 86400000);
    const v = pick(['1.1.0', '1.1.1', '2.0', '2.0']);
    const S = V[v]();
    const s = S.createStore(opts(S, { storage, now: () => t }));
    const step = [v];
    // which library this session continues: its own key's library, in its own format (a later save of the same
    // library replaces the earlier state, as any save does). 2.0 opening a 1.x library is a migration, not this.
    const loaded = namesOf(s.get());
    const ownFormat = v !== '2.0' || s.loadInfo.migratedFrom === undefined;
    let restored = false;
    if (v === '2.0' && r() < 0.45) {
      const rows = s.keptLibraries().filter((e) => e.restorable);
      if (rows.length) {
        const row = pick(rows);
        // controller.restorePreviousLibrary: an edited library is kept first, then the replace (same task)
        if (!s.pristine) assert.equal(s.keepCurrent().ok, true, `seed ${seed}: keepCurrent`);
        assert.equal(s.restoreKept(row.key).ok, true, `seed ${seed}: restore ${row.key}`);
        step.push(`restore ${row.kind}`);
        restored = true;
      }
    }
    if (r() < 0.75) {
      s.addSong(null, { name: `S${seed}.${i} (${v})` });
      step.push('edit');
      if (r() < 0.2) {
        const mine = s.get().songOrder.filter((id) => !String(id).startsWith('factory:'));
        if (mine.length > 1) {
          s.deleteSong(pick(mine.slice(0, -1)));
          step.push('delete');
        }
      }
    }
    if (v === '1.1.1' && r2() < 0.6) {
      exported = s.exportJSON({ pretty: false, device: true });
      const b = JSON.parse(exported).deviceSettings;
      if (marker) assert.equal(b.install, marker, `seed ${seed}: one marker per profile`);
      marker = b.install;
      step.push('export+device');
    }
    if (v === '2.0' && exported && r2() < 0.5) {
      const dry = s.importJSON(exported, { replace: true, dryRun: true });
      assert.equal(dry.ok, true, `seed ${seed}: 1.1.1 export`);
      const d = S2.readDeviceSettings(dry.deviceSettings);
      assert.deepEqual(d.dropped, [], `seed ${seed}: every 1.1.1 value valid in 2.0`);
      s.applyDeviceSettings(d.settings);
      assert.deepEqual(s.machineMarkers(), [marker], `seed ${seed}: same origin, same marker`);
      step.push('device-in');
    }
    const crash = r() < 0.12;
    if (!crash) s.persistNow();
    step.push(crash ? 'crash' : 'close');
    const lib = crash ? null : s.get();
    if (!crash && ownFormat && !restored && namesOf(lib) !== loaded) {
      const fam = v === '2.0' ? '2.0' : '1.x';
      for (let j = saved.length - 1; j >= 0; j--) if (saved[j].names === loaded && saved[j].v === fam) saved.splice(j, 1);
    }
    if (!crash && !s.pristine) {
      saved.push({ label: `session ${i + 1} ${step.join(' ')}`, names: namesOf(lib), v: v === '2.0' ? '2.0' : '1.x' });
    }
    trace.push(step.join(' '));
    if (marker) assert.equal(storage.getItem(S2.INSTALL_ID_KEY), marker, `seed ${seed}: rig.install never changes`);
    const reach = reachableIn20(storage);
    for (const sv of saved) {
      if (!reach.has(sv.names)) {
        assert.fail(`seed ${seed}: "${sv.label}" is lost after session ${i + 1}\n  ${trace.join('\n  ')}`);
      }
    }
  }
  return trace;
}

test('D8 skeptic: 240 random 1.1.0 / 1.1.1 / 2.0 sequences on one storage: every saved library stays reachable in 2.0 (D11: with device exports)', { skip, timeout: 600000 }, () => {
  const counts = { '1.1.0': 0, '1.1.1': 0, '2.0': 0, restore: 0, crash: 0, after111: 0, deviceOut: 0, deviceIn: 0 };
  for (let seed = 1; seed <= 240; seed++) {
    const tr = sequence(seed);
    for (let i = 1; i < tr.length; i++) {
      const v = tr[i].split(' ')[0];
      counts[v] += 1;
      if (/restore/.test(tr[i])) counts.restore += 1;
      if (/crash/.test(tr[i])) counts.crash += 1;
      if (/export\+device/.test(tr[i])) counts.deviceOut += 1;
      if (/device-in/.test(tr[i])) counts.deviceIn += 1;
      if (v === '1.1.0' && /^1\.1\.1/.test(tr[i - 1] || '')) counts.after111 += 1;
    }
  }
  // the mix really covered the interleavings asked for
  for (const k of Object.keys(counts)) assert.ok(counts[k] > 50, `${k}: ${counts[k]}`);
});

// ============================================================================================ quota (stand-in)
const quotaError = () => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
function quotaStorage(limit, initial = {}) {
  const st = S2.memoryStorage(initial);
  const size = () => st.keys().reduce((m, k) => m + k.length + st.getItem(k).length, 0);
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
const keptOf = (st) => st.keys().filter((k) => k.includes('.kept-'));
/** A 2.0 library of about `chars` characters: user songs with long notes (ids `u<tag>-<i>`). */
function bigLib(tag, chars, schema = 2) {
  const s = S2.createStore(opts(S2, { seed: false }));
  for (let i = 0; s && JSON.stringify(s.get()).length < chars; i++) {
    const id = s.addSong(null, { name: `${tag} ${i}` });
    s.set(`songs.${id}.notes`, 'n'.repeat(Math.min(10000, chars - JSON.stringify(s.get()).length)));
  }
  return JSON.stringify({ ...JSON.parse(JSON.stringify(s.get())), schema });
}

test('K1: storage full while restoring an older copy must not delete the very copy being restored', { skip: false }, async () => {
  const K = `${S2.STORAGE_KEY}.kept-`;
  const old2 = bigLib('Real', 900000); // the user's real 2.0 library, set aside by 1.1.0
  const new2 = bigLib('Trivial', 20000); // a newer, small 2.0 copy (e.g. a factory-seed session kept by a restore)
  const cur = bigLib('Current', 900000);
  const init = { [`${K}1000.downgrade.s2`]: old2, [`${K}2000.restore.s2`]: new2, [S2.STORAGE_KEY]: cur };
  const storage = quotaStorage(quotaStorage(0, init).size() + 100000, init); // no room for another ~0.9 M copy
  const store = S2.createStore(opts(S2, { storage, debounceMs: 0 }));
  store.set('settings.view', 'edit'); // edited: the restore keeps it first
  store.persistNow();
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const ctl = createController({
    store, engine: fakeEngine(), midi, recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(), rig: null,
    timers: fakeTimers(), now: () => 0, locks: null, heartbeat: false, indexedDB: null,
  });
  await ctl.start();
  await tick();
  const r = await ctl.restorePreviousLibrary(`${K}1000.downgrade.s2`);
  const where = keptOf(storage);
  const reachable = [storage.getItem(S2.STORAGE_KEY), ...where.map((k) => storage.getItem(k))];
  assert.ok(reachable.includes(old2) || namesOf(store.get()) === namesOf(JSON.parse(old2)),
    `the library the user asked for still exists (result ${JSON.stringify(r)}; kept ${where.join(', ')})`);
  ctl.dispose?.();
});

test('K2: storage full on a save must not delete a different, bigger library while a trivial copy of its version stays', { skip: false }, () => {
  const K = `${S2.STORAGE_KEY}.kept-`;
  // the user's real 2.0 library, set aside twice by 1.1.0: an older state of it, then a later one with more songs
  const g = S2.createStore(opts(S2, { seed: false }));
  const grow = (to) => {
    while (JSON.stringify(g.get()).length < to) g.set(`songs.${g.addSong(null, { name: 'Real' })}.notes`, 'n'.repeat(10000));
    return JSON.stringify(g.get());
  };
  const realOlder = grow(850000);
  const real = grow(900000);
  const trivial = bigLib('Trivial', 15000); // a later, different 2.0 library set aside the same way
  const init = { [`${K}500.downgrade.s2`]: realOlder, [`${K}1000.downgrade.s2`]: real, [`${K}2000.downgrade.s2`]: trivial };
  const storage = quotaStorage(quotaStorage(0, init).size() + 100000, init);
  const s = S2.createStore(opts(S2, { storage, debounceMs: 0, seed: false }));
  s.addSong(null, { name: 'mine' });
  assert.equal(s.persistNow(), true);
  const stored = storage.getItem(S2.STORAGE_KEY);
  s.update((d) => {
    d.settings.padding = 'x'.repeat(1200000); // more than the one superseded copy frees
  });
  const ok = s.persistNow();
  assert.ok(storage.getItem(`${K}500.downgrade.s2`) === null, 'the older copy of the same library went');
  assert.ok(storage.getItem(`${K}1000.downgrade.s2`) === real, 'the real library is never removed for a trivial one');
  assert.equal(ok, false, 'the save fails (retry + warning) instead');
  assert.ok(storage.getItem(S2.STORAGE_KEY) === stored, 'rig.v1 is the last good save');
});

test('quota, random: fill until writes fail; the newest copy of each version always stays; a failed save leaves rig.v1 intact', { skip: false }, () => {
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed * 7919);
    const limit = 400000 + Math.floor(r() * 600000);
    const storage = quotaStorage(limit, {});
    let lastSaved = null;
    const everKept = new Set(); // schemas that ever had a kept copy
    let t = 1e12;
    for (let i = 0; i < 25; i++) {
      t += 1000;
      const s = S2.createStore(opts(S2, { storage, now: () => t, debounceMs: 0 }));
      if (lastSaved !== null) assert.equal(JSON.stringify(s.get()), lastSaved, `seed ${seed}: rig.v1 is the last good save`);
      const act = r();
      if (act < 0.3) {
        s.keepCurrent();
      } else if (act < 0.4) {
        // a 1.x library and a 2.0 library set aside in the rotation by 1.1.0 (adopted at the next load)
        try {
          storage.setItem(`${S2.STORAGE_KEY}.backup-${t}`, bigLib(`B${i}`, 20000 + Math.floor(r() * 80000), r() < 0.5 ? 1 : 2));
        } catch {
          /* full */
        }
      }
      const id = s.addSong(null, { name: `q${i}` });
      s.set(`songs.${id}.notes`, 'n'.repeat(Math.floor(r() * 10000)));
      const before = storage.getItem(S2.STORAGE_KEY);
      const ok = s.persistNow();
      if (ok) lastSaved = JSON.stringify(s.get());
      else assert.equal(storage.getItem(S2.STORAGE_KEY), before, `seed ${seed}: a failed save leaves rig.v1 as it was`);
      for (const k of keptOf(storage)) everKept.add(Number(/\.s(\d+)/.exec(k)[1]));
      for (const sc of everKept) {
        assert.ok(keptOf(storage).some((k) => new RegExp(`\\.s${sc}(\\.\\d+)?$`).test(k)),
          `seed ${seed} step ${i}: the last copy of schema ${sc} was removed`);
      }
      for (const k of keptOf(storage)) JSON.parse(storage.getItem(k)); // never a truncated copy
      s.dispose();
    }
  }
});

// ============================================================================================ adoption
test('adoption at load: many 1.1.0 / 2.0 rotation keys; idempotent, no duplicate, nothing dropped, times kept', { skip: false }, () => {
  const r = rng(42);
  const init = {};
  const readable = new Map(); // text → ts
  for (let i = 0; i < 40; i++) {
    const ts = 1e12 + i * 1000;
    const kind = r();
    let text;
    if (kind < 0.35) text = bigLib(`v1-${i % 7}`, 3000, 1); // some identical texts (i % 7)
    else if (kind < 0.7) text = bigLib(`v2-${i % 5}`, 3000, 2);
    else if (kind < 0.85) text = '{"schema":2,"songs":{"a":'; // truncated
    else text = JSON.stringify({ hello: i }); // JSON, not a library
    init[`${S2.STORAGE_KEY}.backup-${ts}`] = text;
    if (kind < 0.7 && !readable.has(text)) readable.set(text, ts);
  }
  // a pre-existing kept copy of one of them: not kept twice
  const [dupText, dupTs] = [...readable][0];
  init[`${S2.STORAGE_KEY}.kept-${dupTs - 1}.migration.s1`] = dupText;
  const storage = S2.memoryStorage(init);
  const unreadable = Object.keys(init).filter((k) => k.includes('.backup-') && !readable.has(init[k]));
  let first = null;
  for (let pass = 0; pass < 4; pass++) {
    const s = S2.createStore(opts(S2, { storage, now: () => 2e12 + pass }));
    s.persistNow();
    s.dispose();
    const kept = keptOf(storage).sort();
    const texts = kept.map((k) => storage.getItem(k));
    // every distinct readable text, once (the pre-existing kept copy counts)
    assert.equal(new Set(texts).size, texts.length, 'no duplicate');
    for (const [text] of readable) assert.ok(texts.includes(text), 'nothing dropped');
    for (const [text, ts] of readable) {
      if (text === dupText) continue;
      const k = kept[texts.indexOf(text)];
      assert.ok(k.includes(`.kept-${ts}.`), `${k} keeps its time ${ts}`);
    }
    // unreadable rotation keys stay (up to what 2.0's own rotation would prune; 2.0 wrote no backup here)
    for (const k of unreadable) assert.ok(storage.getItem(k) !== null, `${k} (unreadable) stays`);
    if (first) assert.deepEqual(kept, first, 'idempotent');
    first = kept;
  }
  // then 1.1.0 prunes its rotation as usual: no library is in it any more
  if (S1) {
    const t0 = S1.createStore(opts(S1, { storage: S1.memoryStorage(Object.fromEntries(storage.keys().map((k) => [k, storage.getItem(k)]))) }));
    t0.dispose();
  }
});

// ============================================================================================ restore edge cases
async function ctlFor(store, extra = {}) {
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const warns = [];
  const ctl = createController({
    store, engine: fakeEngine(), midi, recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(), rig: null,
    timers: fakeTimers(), now: () => 0, locks: null, heartbeat: false, indexedDB: null, ...extra,
  });
  ctl.addEventListener('warn', (e) => warns.push(e.detail.message));
  await ctl.start();
  await tick();
  return { ctl, warns };
}

test('restore: a crash after the kept copy, or after the replace but before the save, loses nothing', { skip: false }, () => {
  const K = `${S2.STORAGE_KEY}.kept-`;
  const target = bigLib('Target', 30000);
  for (const crashAt of ['after-keep', 'after-replace']) {
    const storage = S2.memoryStorage({ [`${K}1.downgrade.s2`]: target });
    const s = S2.createStore(opts(S2, { storage, now: () => 5000 }));
    s.addSong(null, { name: 'Current work' });
    s.persistNow();
    const cur = storage.getItem(S2.STORAGE_KEY);
    assert.equal(s.keepCurrent().ok, true);
    if (crashAt === 'after-replace') assert.equal(s.restoreKept(`${K}1.downgrade.s2`).ok, true);
    // crash: nothing more is written. Next launch:
    const s2 = S2.createStore(opts(S2, { storage, now: () => 9000 }));
    assert.equal(JSON.stringify(s2.get()), cur, `${crashAt}: rig.v1 is the pre-restore library`);
    const texts = keptOf(storage).map((k) => storage.getItem(k));
    assert.ok(texts.includes(target), `${crashAt}: the target is still kept`);
    assert.ok(texts.some((x) => namesOf(JSON.parse(x)) === namesOf(JSON.parse(cur))), `${crashAt}: and the current copy`);
  }
});

test('restore: a read-only window and a second window refuse; undo brings the pre-restore library back exactly', async () => {
  const K = `${S2.STORAGE_KEY}.kept-`;
  const target = bigLib('Target', 30000);
  const storage = S2.memoryStorage({ [`${K}1.downgrade.s2`]: target });
  let clock = 5000;
  const store = S2.createStore(opts(S2, { storage, now: () => (clock += 1000), debounceMs: 0 }));
  store.addSong(null, { name: 'Current work' });
  store.persistNow();
  const before0 = JSON.stringify(store.get());
  // read-only (H2 second window: setReadOnly)
  store.setReadOnly(true, 'second-window');
  const { ctl } = await ctlFor(store);
  assert.deepEqual(await ctl.restorePreviousLibrary(`${K}1.downgrade.s2`), { ok: false, error: 'read-only' });
  assert.equal(keptOf(storage).length, 1, 'nothing kept, nothing replaced');
  store.setReadOnly(false);
  // a second window whose instance lock is held elsewhere
  const locks = { request: (name, o, cb) => (o && o.ifAvailable ? Promise.resolve(cb(null)) : new Promise(() => {})) };
  const st2 = S2.createStore(opts(S2, { storage, now: () => (clock += 1000) }));
  const { ctl: second } = await ctlFor(st2, { locks });
  assert.deepEqual(await second.restorePreviousLibrary(`${K}1.downgrade.s2`), { ok: false, error: 'read-only' });
  // the real restore, then undo
  const r = await ctl.restorePreviousLibrary(`${K}1.downgrade.s2`);
  assert.equal(r.ok, true, r.error);
  assert.equal(namesOf(store.get()), namesOf(JSON.parse(target)));
  store.persistNow();
  const undo = ctl.listPreviousLibraries().find((e) => e.key === r.keptKey);
  assert.ok(undo && undo.restorable);
  const r2 = await ctl.restorePreviousLibrary(r.keptKey);
  assert.equal(r2.ok, true, r2.error);
  const a = JSON.parse(JSON.stringify(store.get()));
  const b = JSON.parse(before0);
  delete a.meta;
  delete b.meta;
  assert.deepEqual(a, b, 'undo: the library as it was before the restore');
  // the restored target is still kept (restoring does not consume it)
  assert.ok(keptOf(storage).some((k) => storage.getItem(k) === target));
});

test('restore near the 2.5 M limit: works with room, refuses cleanly without it (real-size quota stand-in)', async () => {
  const K = `${S2.STORAGE_KEY}.kept-`;
  const near = bigLib('Near', S2.LIBRARY_RESTORE_MAX_CHARS - 30000);
  assert.ok(near.length > S2.LIBRARY_MAX_CHARS);
  for (const [limit, expectOk] of [[5200000, true], [3000000, false]]) {
    const storage = quotaStorage(limit, { [`${K}1.downgrade.s2`]: near });
    const store = S2.createStore(opts(S2, { storage, now: () => 5000, debounceMs: 0 }));
    store.addSong(null, { name: 'Current work' });
    store.persistNow();
    const cur = storage.getItem(S2.STORAGE_KEY);
    const { ctl } = await ctlFor(store);
    const r = await ctl.restorePreviousLibrary(`${K}1.downgrade.s2`);
    const saved = store.persistNow();
    if (expectOk) {
      assert.equal(r.ok, true, r.error);
      assert.equal(saved, true, 'the 2.4 M library is saved next to its kept copy and the small undo copy');
      assert.equal(namesOf(JSON.parse(storage.getItem(S2.STORAGE_KEY))), namesOf(JSON.parse(near)));
    } else if (r.ok && !saved) {
      assert.equal(storage.getItem(S2.STORAGE_KEY), cur, 'a failed save leaves rig.v1 as the old library');
    }
    // the target copy stays, or (storage full on the save) it went because it is now the saved library itself
    assert.ok(storage.getItem(`${K}1.downgrade.s2`) === near
      || namesOf(JSON.parse(storage.getItem(S2.STORAGE_KEY))) === namesOf(JSON.parse(near)), 'the target is never lost');
    if (!expectOk && r.ok && saved) assert.ok(keptOf(storage).some((k) => storage.getItem(k) === cur), 'undo copy');
  }
});

// ============================================================================================ D9
test('D9: past the cap every edit is saved; the toast comes once, then at +10 %; merge and song files over 2 M refused', async () => {
  const base = bigLib('Big', S2.LIBRARY_MAX_CHARS - 5000);
  const storage = S2.memoryStorage({ [S2.STORAGE_KEY]: base });
  const store = S2.createStore(opts(S2, { storage, debounceMs: 0 }));
  const { warns } = await ctlFor(store);
  for (let i = 0; i < 40; i++) {
    const id = store.addSong(null, { name: `grow ${i}` });
    store.set(`songs.${id}.notes`, 'g'.repeat(10000));
    assert.equal(store.persistNow(), true);
    assert.equal(storage.getItem(S2.STORAGE_KEY), JSON.stringify(store.get()), `edit ${i} saved`);
  }
  await tick();
  const size = JSON.stringify(store.get()).length;
  const toasts = warns.filter((w) => /more than the 2\.0 MB/.test(w));
  // first warning just past 2.0 M, then ≥ 1.1× that: ~2.2 M; 2.4 M is under 2.2×1.1 = 2.42 M → 2 toasts
  assert.equal(toasts.length, size >= S2.LIBRARY_MAX_CHARS * 1.1 * 1.1 ? 3 : 2, `${size}: ${toasts.length}`);
  // a merge of the same library, or a song file over 2 M, is refused
  const t = S2.createStore(opts(S2));
  assert.match(t.importJSON(store.exportJSON()).error, /too large/);
  const song = { kind: 'song', song: { ...store.getSong(store.get().songOrder[0]), notes: 'z'.repeat(10000), pad: 'p'.repeat(2100000) } };
  assert.equal(t.importJSON(JSON.stringify(song)).ok, false);
  assert.equal(t.importJSON(JSON.stringify(song), { replace: true }).ok, false, 'a song file is not a whole library');
  // the over-cap library restores (it is ≤ 2.5 M)
  assert.ok(size < S2.LIBRARY_RESTORE_MAX_CHARS);
  assert.equal(S2.createStore(opts(S2)).importJSON(store.exportJSON(), { replace: true }).ok, true);
});

// ============================================================================================ 1.1.1 = 1.1.0
test('1.1.1 without a 2.0 library behaves exactly like 1.1.0 (same storage writes, state and loadInfo)', { skip }, () => {
  const starts = {
    empty: {},
    rich: { [S1.STORAGE_KEY]: fixture(REF, 'rich.localstorage.json') },
    pristine: { [S1.STORAGE_KEY]: fixture(REF, 'pristine.localstorage.json') },
    corrupt: { [S1.STORAGE_KEY]: '{"schema":1,"songs":{' },
    notLib: { [S1.STORAGE_KEY]: '[1,2,3]' },
    backups: {
      [S1.STORAGE_KEY]: fixture(REF, 'rich.localstorage.json'),
      [`${S1.STORAGE_KEY}.backup-1`]: 'x', [`${S1.STORAGE_KEY}.backup-2`]: 'y', [`${S1.STORAGE_KEY}.backup-3`]: 'z',
    },
    corruptWithBackups: {
      [S1.STORAGE_KEY]: 'nope', [`${S1.STORAGE_KEY}.backup-1`]: 'x', [`${S1.STORAGE_KEY}.backup-2`]: 'y',
      [`${S1.STORAGE_KEY}.backup-3`]: 'z',
    },
  };
  for (const [name, init] of Object.entries(starts)) {
    const run = (S) => {
      const log = [];
      const st = S.memoryStorage({ ...init });
      const set = st.setItem;
      const rm = st.removeItem;
      st.setItem = (k, v) => (log.push(['set', k, v]), set(k, v));
      st.removeItem = (k) => (log.push(['rm', k]), rm(k));
      let i = 0;
      const s = S.createStore({
        storage: st, idGen: (p) => `${p}-${++i}`, requestIdle: null, warn: (m) => log.push(['warn', m]), autoFlush: false,
        timers: NEVER, now: () => 777,
      });
      const info0 = s.loadInfo;
      const id = s.addSong(null, { name: 'x' });
      s.set(`songs.${id}.notes`, 'hello');
      s.importJSON(fixture(REF, 'unicode.export.json'));
      s.persistNow();
      s.dispose();
      return { log, info0, state: plain(s.get()), keys: st.keys().sort().map((k) => [k, st.getItem(k)]) };
    };
    const a = run(S1);
    const b = run(S111);
    assert.deepEqual(b, a, `${name}: 1.1.1 differs from 1.1.0`);
  }
});

test('K3: a 2.0 window that takes over after a 1.1.0 window saved keeps that 1.x library (reload), once', { skip }, () => {
  const storage = S2.memoryStorage({ [S2.STORAGE_KEY]: fixture(REF, 'rich.localstorage.json') });
  const waiting = S2.createStore(opts(S2, { storage, now: () => 1e12 })); // second window: read-only, waits
  waiting.setReadOnly(true, 'second-window');
  const one = S1.createStore(opts(S1, { storage, now: () => 1e12 + 1 })); // the 1.1.0 window (primary) edits
  one.addSong(null, { name: 'Edited in 1.1.0 while 2.0 waited' });
  one.persistNow();
  one.dispose();
  const v1edited = storage.getItem(S2.STORAGE_KEY);
  waiting.reload(); // the 1.1.0 window closed: 2.0 takes over and saves its upgrade over the 1.x text
  waiting.setReadOnly(false);
  waiting.persistNow();
  assert.equal(JSON.parse(storage.getItem(S2.STORAGE_KEY)).schema, 2);
  const texts = keptOf(storage).map((k) => storage.getItem(k));
  assert.ok(texts.includes(v1edited), 'the 1.x text as 1.1.0 saved it is kept');
  waiting.reload();
  assert.equal(keptOf(storage).filter((k) => storage.getItem(k) === v1edited).length, 1, 'not kept twice');
});

test('K4 (open, 1.1.0 only): a waiting 1.1 window that takes over after 2.0 closes; 1.1.0 saves over 2.0\'s later edits, 1.1.1 does not', { skip }, () => {
  for (const [S, loses] of [[S1, true], [S111, false]]) {
    const storage = S2.memoryStorage();
    const two = S2.createStore(opts(S2, { storage, now: () => 1e12 }));
    two.addSong(null, { name: 'Before the 1.1 window opened' });
    two.persistNow();
    const one = S.createStore(opts(S, { storage, now: () => 1e12 + 1 })); // second window: read-only, waiting
    one.setReadOnly(true, 'second-window');
    two.addSong(null, { name: 'After the 1.1 window opened' });
    two.persistNow();
    two.dispose(); // 2.0 closes; the 1.1 window takes over (controller: reload, then saving resumes)
    one.reload();
    one.setReadOnly(false);
    one.addSong(null, { name: 'In 1.1' });
    one.persistNow();
    const reach = reachableIn20(storage);
    const want = namesOf(two.get());
    assert.equal(!reach.has(want), loses, `${S === S1 ? '1.1.0' : '1.1.1'}`);
  }
});
