// Lane E5, the downgrade story: a 2.0 library offered to the real 1.1 store (`git archive v1.1.0 app/js`, no
// checkout). Skipped, with the reason, when the v1.1.0 tag is not in this clone. The in-app version of the same
// check (1.1's Settings › Import…, "Import latest backup" and localStorage, watching for page errors) is recorded by
// tools/gen-library-1x-fixtures.mjs in test/fixtures/library-1x/v1.1.0/downgrade-v1.1.0.json.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as S2 from '../../../app/js/store.js';
import { ROOT, FIX, fixture, jsonDiff, plain, tmpDir } from './lib.mjs';

const REF = 'v1.1.0';
const has = spawnSync('git', ['-C', ROOT, 'rev-parse', '--verify', '--quiet', `${REF}^{commit}`]).status === 0;
let dir = null;
let S1 = null;
let S111 = null; // D8: 1.1.0 + native/docs/patches/v1.1.1-prep.diff (the unpublished 1.1.1 patch)
const PATCH = path.join(ROOT, 'native/docs/patches/v1.1.1-prep.diff');
before(async () => {
  if (!has) return;
  dir = tmpDir('v11');
  const r = spawnSync('bash', ['-c', `git -C "${ROOT}" archive ${REF} app/js | tar -x -C "${dir}"`]);
  assert.equal(r.status, 0, String(r.stderr));
  S1 = await import(path.join(dir, 'app/js/store.js'));
  if (fs.existsSync(PATCH)) {
    const d2 = path.join(dir, 'p111');
    fs.mkdirSync(d2);
    const r2 = spawnSync('bash', ['-c', `git -C "${ROOT}" archive ${REF} app/js | tar -x -C "${d2}" && cd "${d2}" `
      + `&& git apply --include='app/js/store.js' "${PATCH}"`]);
    assert.equal(r2.status, 0, String(r2.stderr));
    S111 = await import(path.join(d2, 'app/js/store.js'));
  }
});
after(() => dir && fs.rmSync(dir, { recursive: true, force: true }));
const skip = has ? false : `tag ${REF} not in this clone (git fetch origin tag ${REF})`;
const skip111 = skip || (fs.existsSync(PATCH) ? false : 'no native/docs/patches/v1.1.1-prep.diff');

let n = 0;
const opts = (S, extra = {}) => ({
  storage: S.memoryStorage(), idGen: (p) => `${p}-d${++n}`, requestIdle: null, warn: () => {}, autoFlush: false, ...extra,
});
/** A 2.0 library: the 1.1 rich backup imported, plus 2.0-only content (6 slots, PC → cue, a chart, 2.0 settings). */
function library20() {
  const s = S2.createStore(opts(S2));
  assert.equal(s.importJSON(fixture(REF, 'rich.backup.json'), { replace: true }).ok, true);
  const six = s.addSong(null, { name: 'Six-slot song (2.0)' });
  s.addSlot(six, { instrument: { type: 'synth', id: 'warm-pad' } });
  s.addSlot(six, { instrument: { type: 'synth', id: 'glass-pad' } });
  assert.equal(s.getSong(six).patch.slots.length, 6);
  s.set('settings.programChangeAction', 'cue');
  s.set('settings.polyphony', 128);
  assert.equal(s.setChart(six, { format: 'plain', text: 'G  C  D\nla la la' }).ok, true);
  const out = { store: s, six, pretty: s.exportJSON(), compact: s.exportJSON({ pretty: false }), state: plain(s.get()) };
  return out;
}

test('1.1 refuses a 2.0 file (Settings › Import… and "Import latest backup") without throwing or changing anything', { skip }, () => {
  const v2 = library20();
  const s1 = S1.createStore(opts(S1));
  const before1 = plain(s1.get());
  for (const o of [{}, { replace: true }]) {
    for (const text of [v2.pretty, `{"origin":"rig://app",${v2.compact.slice(1)}`]) {
      const r = s1.importJSON(text, o);
      assert.deepEqual(r, { ok: false, error: 'This file was made by a newer version of Worship Rig.' });
    }
  }
  assert.deepEqual(plain(s1.get()), before1);
});

test('1.1 opening an origin whose localStorage holds a 2.0 library: future-schema, the 2.0 text kept, a fresh seed', { skip }, () => {
  const v2 = library20();
  const storage = S1.memoryStorage({ [S1.STORAGE_KEY]: v2.compact });
  const s1 = S1.createStore(opts(S1, { storage }));
  assert.equal(s1.loadInfo.status, 'future-schema');
  assert.ok(storage.getItem(s1.loadInfo.backupKey) === v2.compact, 'byte for byte, under rig.v1.backup-<ts>');
  assert.equal(s1.get().schema, 1);
  assert.ok(s1.get().songOrder.length > 0, 'factory seed');
});

test('2.0 Chrome first loads a 1.x library: a copy of the 1.x text stays for a downgrade', { skip }, () => {
  const text = fixture(REF, 'rich.localstorage.json');
  const storage = S2.memoryStorage({ [S2.STORAGE_KEY]: text });
  const s2 = S2.createStore(opts(S2, { storage, debounceMs: 0, now: () => 1000 }));
  const key = s2.loadInfo.migrationBackupKey;
  s2.set('song.tempo', 101);
  s2.dispose();
  // what 1.1 then sees on that origin: the schema-2 library is unreadable to it, the 1.x copy is still there
  const s1 = S1.createStore(opts(S1, { storage, now: () => 2000 })); // (a later launch: another backup key)
  assert.equal(s1.loadInfo.status, 'future-schema');
  assert.ok(storage.getItem(key) === text, 'the 1.x library, intact, for a manual restore');
  const restored = S1.createStore(opts(S1, { storage: S1.memoryStorage({ [S1.STORAGE_KEY]: storage.getItem(key) }) }));
  assert.equal(restored.loadInfo.status, 'ok');
  assert.deepEqual(plain(restored.get()), JSON.parse(text));
});

test('a 2.0 file with "schema" edited to 1: what 1.1 keeps and what it drops', { skip }, () => {
  const v2 = library20();
  const s1 = S1.createStore(opts(S1));
  const r = s1.importJSON(v2.pretty.replace('"schema": 2', '"schema": 1'), { replace: true });
  assert.equal(r.ok, true);
  const got = plain(s1.get());
  const drops = jsonDiff(v2.state, got).filter((d) => !d.startsWith('schema:')
    && !/^(app|kind|exportedAt):/.test(d)); // 1.1 keeps the envelope in its state (2.0 no longer does, E5)
  // slots 5 and 6 of the 6-slot song are cut (1.x has exactly 4); 2.0's device-local settings were never exported
  const six = v2.six;
  const songDrops = drops.filter((d) => !d.startsWith('settings.'));
  assert.deepEqual(songDrops.map((d) => d.split(':')[0]), [`songs.${six}.patch.slots.4`, `songs.${six}.patch.slots.5`]);
  assert.ok(songDrops.every((d) => / -> undefined$/.test(d)), songDrops.join('\n'));
  const DEVICE = new Set(S2.DEVICE_LOCAL_SETTINGS);
  const settingDrops = drops.filter((d) => d.startsWith('settings.')).map((d) => d.split(/[.:]/)[1]);
  assert.ok(settingDrops.every((k) => DEVICE.has(k)), `only device-local settings differ: ${settingDrops}`);
  // 2.0-only fields ride along as unknown fields (1.x ignores them): the chart, programChangeAction ('cue' → 1.x
  // jumps, its only behaviour); everything 1.x knows is unchanged
  const s = got.songs[six];
  assert.equal(s.chart.text, 'G  C  D\nla la la');
  assert.equal(got.settings.programChangeAction, 'cue');
  for (const id of v2.state.songOrder.filter((x) => x !== six)) assert.deepEqual(got.songs[id], v2.state.songs[id]);
});

test('the recorded in-app downgrade run (1.1 UI): no page errors, the library untouched, schema-2 refused', () => {
  const rep = JSON.parse(fs.readFileSync(path.join(FIX, REF, 'downgrade-v1.1.0.json'), 'utf8'));
  for (const [k, v] of Object.entries(rep.cases)) {
    assert.deepEqual(v.errors.filter((e) => e.startsWith('pageerror')), [], k);
  }
  assert.match(rep.cases.settingsImport.toast, /newer version/);
  assert.equal(rep.cases.settingsImport.libraryUnchanged, true);
  assert.equal(rep.cases.importLatestBackup.libraryUnchanged, true);
  assert.equal(rep.cases.localStorageSchema2.status, 'future-schema');
  assert.equal(rep.cases.localStorageSchema2.keptIsSchema2, true);
  assert.equal(rep.cases.schemaEditedTo1.sixSlotSongSlots, 4);
});

// ===================================================================================== D8: same-profile ping-pong
// One Chrome profile (one localStorage), the versions taking turns: 2.0 → 1.1 → 2.0 → 1.1 → 2.0. Every library that
// ever existed (a snapshot at each window close) must still be in storage and restorable by 2.0. Each launch is a
// user session with one edit (a song named after it), so every snapshot is a different library.
const namesOf = (lib) => Object.values(lib.songs || {}).map((x) => x.name).sort();
/** Can a 2.0 store on a copy of this storage get back a library with exactly these song names? */
function restorable(storage, names, label) {
  const keys = storage.keys();
  const copy = () => S2.memoryStorage(Object.fromEntries(keys.map((k) => [k, storage.getItem(k)])));
  const want = JSON.stringify(names);
  const live = S2.createStore(opts(S2, { storage: copy() }));
  if (live.loadInfo.status === 'ok' && JSON.stringify(namesOf(live.get())) === want) return 'rig.v1';
  for (const row of live.keptLibraries()) {
    const t = S2.createStore(opts(S2, { storage: copy() }));
    const r = t.restoreKept(row.key);
    if (r.ok && JSON.stringify(namesOf(t.get())) === want) return row.key;
  }
  assert.fail(`${label}: lost (${names.length} songs, e.g. ${names.filter((n) => /^Session/.test(n)).join(', ')})`);
  return null;
}
function pingPong({ v11, edit1x = true }) {
  const storage = S2.memoryStorage({ [S2.STORAGE_KEY]: fixture(REF, 'rich.localstorage.json') });
  const snaps = [{ label: 'the 1.x library before 2.0', names: namesOf(JSON.parse(storage.getItem(S2.STORAGE_KEY))) }];
  let t = Date.UTC(2026, 10, 1);
  const order = ['2.0', '1.1', '2.0', '1.1', '2.0'];
  const log = [];
  order.forEach((v, i) => {
    t += 86400000;
    const S = v === '2.0' ? S2 : v11;
    const s = S.createStore(opts(S, { storage, now: () => t, debounceMs: 0 }));
    if (v === '2.0') {
      // the user finds their 2.0 library in "Restore previous library…" when 1.x set it aside (newest first)
      const set = s.keptLibraries().find((e) => e.kind === 'downgrade' && e.schema === 2 && e.restorable);
      if (set && i > 0 && storage.getItem(S2.STORAGE_KEY) && JSON.parse(storage.getItem(S2.STORAGE_KEY)).schema === 1) {
        if (!s.pristine) assert.equal(s.keepCurrent().ok, true);
        assert.equal(s.restoreKept(set.key).ok, true);
        log.push(`${v}: restored ${set.key}`);
      }
    }
    if (v === '2.0' || edit1x) s.addSong(null, { name: `Session ${i + 1} (${v})` });
    s.persistNow();
    s.dispose();
    // an untouched 1.x factory seed holds nothing of the user's: it is not a library to keep (D8)
    if (!s.pristine) snaps.push({ label: `after session ${i + 1} (${v})`, names: namesOf(s.get()) });
    for (const sn of snaps) restorable(storage, sn.names, `${sn.label}, checked after session ${i + 1}`);
  });
  return { storage, snaps, log };
}

test('D8: 2.0 ↔ 1.1.0 in one profile, twice: no library is ever lost, each one restores in 2.0', { skip }, () => {
  const { storage, log } = pingPong({ v11: S1 });
  assert.equal(log.length, 2, log.join('; '));
  // 1.1.0 still adds its rotation keys; none of them holds a library any more (each moved to a kept copy)
  const kept = storage.keys().filter((k) => k.includes('.kept-'));
  assert.ok(kept.length >= 6, kept.join(', '));
  for (const k of storage.keys().filter((x) => x.includes('.backup-'))) {
    assert.throws(() => S2.migrate(JSON.parse(storage.getItem(k))), `${k} would have been moved`);
  }
});

test('D8: 2.0 ↔ 1.1.0, with no edits in 1.1: 2.0 opens the 1.x seed, and the set-aside 2.0 library restores', { skip }, () => {
  const { log } = pingPong({ v11: S1, edit1x: false });
  assert.equal(log.length, 2, log.join('; '));
});

test('D8: 2.0 ↔ 1.1.1 in one profile, twice: 1.1.1 never writes the 2.0 key; its separate library restores in 2.0', { skip: skip111 }, () => {
  const storage = S2.memoryStorage({ [S2.STORAGE_KEY]: fixture(REF, 'rich.localstorage.json') });
  let t = Date.UTC(2026, 10, 1);
  let v2text = null;
  for (let i = 0; i < 5; i++) {
    t += 86400000;
    const v = i % 2 ? '1.1.1' : '2.0';
    const S = v === '2.0' ? S2 : S111;
    const writes = [];
    const set = storage.setItem;
    const rm = storage.removeItem;
    storage.setItem = (k, val) => (writes.push(k), set(k, val));
    storage.removeItem = (k) => (writes.push(`rm ${k}`), rm(k));
    const s = S.createStore(opts(S, { storage, now: () => t, debounceMs: 0 }));
    s.addSong(null, { name: `Session ${i + 1} (${v})` });
    s.persistNow();
    s.dispose();
    storage.setItem = set;
    storage.removeItem = rm;
    if (v === '1.1.1') {
      assert.deepEqual(s.loadInfo.newerLibrary, { schema: 2, key: S2.STORAGE_KEY });
      assert.equal(storage.getItem(S2.STORAGE_KEY), v2text, 'the 2.0 library byte for byte');
      assert.deepEqual([...new Set(writes)], [`${S2.STORAGE_KEY}${S2.SEPARATE_1X_SUFFIX}`], 'only its own key');
    } else {
      v2text = storage.getItem(S2.STORAGE_KEY);
      assert.equal(JSON.parse(v2text).schema, 2);
      assert.ok(namesOf(s.get()).includes('Session 1 (2.0)'), 'one 2.0 library, never replaced');
    }
  }
  const s = S2.createStore(opts(S2, { storage }));
  const sep = s.keptLibraries().find((e) => e.kind === 'separate');
  assert.ok(sep && sep.restorable);
  assert.equal(s.keepCurrent().ok, true);
  assert.equal(s.restoreKept(sep.key).ok, true);
  assert.ok(namesOf(s.get()).includes('Session 4 (1.1.1)'));
  assert.ok(namesOf(s.get()).includes('Session 2 (1.1.1)'));
});

// ============================================================================================ D11: the device block
const f111 = (file) => fixture('v1.1.1', file);
test('D11: 1.1.0 ignores 1.1.1\'s deviceSettings block (replace, merge, backup tag); its own device settings stay', { skip }, () => {
  for (const file of ['devices.export.json', 'devices.backup.json', 'rich.export.json']) {
    const s1 = S1.createStore(opts(S1));
    s1.set('settings.outputDeviceId', 'usb-here');
    s1.set('settings.midiInputName', 'Keys here');
    const mine = plain(s1.get().settings);
    const r = s1.importJSON(f111(file), { replace: true });
    assert.equal(r.ok, true, `${file}: ${r.error}`);
    for (const k of S1.DEVICE_LOCAL_SETTINGS) assert.deepEqual(s1.get().settings[k], mine[k], `${file} ${k}`);
    assert.equal('deviceSettings' in JSON.parse(s1.exportJSON()), false, '1.1.0 never writes the block on');
    const m = S1.createStore(opts(S1));
    assert.equal(m.importJSON(f111(file)).ok, true, `${file} merge`);
    assert.equal(m.get().settings.midiInputName, null);
    s1.dispose();
    m.dispose();
  }
});

test('D11 skeptic DS3: the block 1.1.0 stores after importing a 1.1.1 file never enters 2.0 on the same origin', { skip }, () => {
  const storage = S1.memoryStorage();
  const s1 = S1.createStore(opts(S1, { storage }));
  assert.equal(s1.importJSON(f111('devices.export.json'), { replace: true }).ok, true);
  s1.persistNow();
  s1.dispose();
  const raw = JSON.parse(storage.getItem(S1.STORAGE_KEY));
  assert.ok(raw.deviceSettings, '1.1.0 keeps the block in rig.v1 (unknown top-level field)');
  const s2 = S2.createStore(opts(S2, { storage }));
  assert.equal('deviceSettings' in s2.get(), false);
  assert.equal(s2.get().settings.menuBarMode ?? false, false, 'nothing of it applied');
  assert.equal(s2.get().songOrder.length, raw.songOrder.length, 'the library itself came over');
  s2.dispose();
});

test('D11: an older 2.0 build (v2-native HEAD, before D11) keeps the block as an unknown field and uses none of it', async () => {
  const has2 = spawnSync('git', ['-C', ROOT, 'cat-file', '-e', 'HEAD:app/js/store.js']).status === 0;
  const d = tmpDir('old2');
  try {
    assert.equal(has2, true);
    const r0 = spawnSync('bash', ['-c', `git -C "${ROOT}" archive HEAD app/js | tar -x -C "${d}"`]);
    assert.equal(r0.status, 0, String(r0.stderr));
    const Old = await import(path.join(d, 'app/js/store.js'));
    if (typeof Old.readDeviceSettings === 'function') return; // HEAD already has D11 (after commit): nothing to test
    const s = Old.createStore(opts(Old));
    const before = plain(s.get().settings);
    const r = s.importJSON(f111('devices.backup.json'), { replace: true });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(plain(s.get().deviceSettings), JSON.parse(f111('devices.backup.json')).deviceSettings);
    for (const k of Old.DEVICE_LOCAL_SETTINGS) assert.deepEqual(s.get().settings[k], before[k], k);
    assert.equal('deviceSettings' in JSON.parse(s.exportJSON()), false);
    s.dispose();
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('D11: the patched 1.1.1 store (the diff in this branch) writes the block that this 2.0 reads', { skip: skip111 }, () => {
  const storage = S111.memoryStorage();
  const s = S111.createStore(opts(S111, { storage }));
  s.set('settings.midiClockOut', 'IAC Driver Bus 1');
  s.setKeyboard('Stage Piano MIDI Out', { remember: true });
  const text = s.exportJSON({ device: true });
  const block = JSON.parse(text).deviceSettings;
  assert.equal(block.install, storage.getItem(S111.INSTALL_ID_KEY));
  const s2 = S2.createStore(opts(S2, { storage }));
  const r = s2.importJSON(text, { replacePristine: true });
  assert.equal(r.ok, true);
  const d = S2.readDeviceSettings(r.deviceSettings);
  assert.deepEqual(d.dropped, []);
  assert.equal(d.settings.midiClockOut, 'IAC Driver Bus 1');
  assert.deepEqual(s2.machineMarkers(), [block.install], 'same origin (Chrome): 2.0 reads 1.1.1\'s marker');
  s.dispose();
  s2.dispose();
});
