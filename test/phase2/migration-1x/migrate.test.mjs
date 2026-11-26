// Lane E5: every real 1.x library (test/fixtures/library-1x, made by tools/gen-library-1x-fixtures.mjs with the 1.x
// code itself) through the 2.0 store: migrate, the replace import, the Settings import, export → re-import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  migrate, createStore, memoryStorage, SCHEMA, STORAGE_KEY, DEVICE_LOCAL_SETTINGS, programChangeOf, IMPORT_ENVELOPE_KEYS,
} from '../../../app/js/store.js';
import { FACTORY_SONGS, FACTORY_SINCE, FACTORY_VERSION } from '../../../app/js/presets.js';
import { allFixtures, manifests, fixture, jsonDiff, plain } from './lib.mjs';

const FIXTURES = allFixtures();
const idGen = () => {
  let n = 0;
  return (p) => `${p}-e5-${++n}`;
};
const makeStore = (opts = {}) => createStore({
  storage: memoryStorage(), idGen: idGen(), requestIdle: null, warn: () => {}, autoFlush: false, ...opts,
});
/** The 1.x state a fixture stands for: the localStorage form (what 1.x itself held). */
const stateOf = (ref, name) => JSON.parse(fixture(ref, `${name}.localstorage.json`));
const DEVICE_LOCAL = new Set(DEVICE_LOCAL_SETTINGS);
/**
 * Differences that lose nothing: a setting the file does not carry gets its default (1.x does the same on load:
 * device-local defaults in a backup, and 2.0's hotkeys rows filled in for a v1.0.0 library that has the field).
 * D11 skeptic DS3: migrate() drops 1.1.1's `deviceSettings` block (importJSON hands it to the caller from the file).
 */
const lossy = (diffs) => diffs.filter((d) => !d.startsWith('schema:') && !/^settings\.[^:]+: undefined -> /.test(d)
  && !/^deviceSettings: .* -> undefined$/.test(d));

test('fixtures: both 1.x tags and 1.1.1, every scenario, all three forms, each file under 200 KB', () => {
  const ms = manifests();
  assert.deepEqual(ms.map((m) => m.ref).sort(), ['v1.0.0', 'v1.1.0', 'v1.1.1']);
  const v11 = ms.find((m) => m.ref === 'v1.1.0');
  assert.deepEqual(Object.keys(v11.scenarios).sort(), ['deleted-factory', 'empty', 'huge', 'pristine', 'rich', 'unicode']);
  // D11: 1.1.1 is the uncommitted v1.1.1-prep worktree (generator --from), on top of v1.1.0
  const v111 = ms.find((m) => m.ref === 'v1.1.1');
  assert.deepEqual(Object.keys(v111.scenarios).sort(), ['devices', 'pristine', 'rich']);
  assert.equal(v111.source.kind, 'worktree');
  assert.equal(v111.source.head, v11.commit);
  assert.ok(v111.source.uncommitted.some((l) => /app\/js\/store\.js$/.test(l)), 'made by the patched store');
  for (const m of ms) {
    assert.match(m.commit, /^[0-9a-f]{40}$/);
    for (const [name, sc] of Object.entries(m.scenarios)) {
      for (const f of Object.values(sc.files)) assert.ok(f.bytes < 200 * 1024, `${m.ref}/${f.file} ${f.bytes} B`);
      // 1.x never backs up an untouched factory seed (round2-shell #2): only the pristine library has no backup
      assert.equal(!!sc.files.backup, name !== 'pristine', `${m.ref} ${name}`);
      assert.equal(sc.pristine, name === 'pristine');
    }
  }
  for (const fx of FIXTURES) {
    const doc = JSON.parse(fx.text);
    assert.equal(doc.schema, 1, `${fx.ref} ${fx.name}.${fx.form}`);
    if (fx.form === 'backup') assert.match(fx.text, /^\{"origin":"http:\/\/127\.0\.0\.1:\d+","app":"worship-rig","kind":"library"/);
    if (fx.form === 'export') assert.match(fx.text, /^\{\n {2}"app": "worship-rig",\n {2}"kind": "library"/);
  }
  const huge = stateOf('v1.1.0', 'huge');
  const chars = JSON.stringify(huge).length;
  assert.ok(chars > 1.9e6 && chars < 2e6, `huge library ${chars} chars (cap 2 000 000)`);
});

test('the rich fixtures hold every 1.x feature (the generator really set them)', () => {
  for (const ref of ['v1.1.0', 'v1.0.0']) {
    const st = stateOf(ref, 'rich');
    const u = Object.values(st.songs).find((s) => s.name === 'Grace Overflows (Live)');
    const s0 = u.patch.slots[0];
    assert.equal(s0.width, 0.6);
    assert.deepEqual(s0.eq.b2, { on: true, hz: 450, db: 2.5, q: 1.4 });
    assert.equal(s0.release, 1.8);
    assert.equal(s0.pedalHold, 6);
    assert.equal(s0.futureKnob.a, 1, 'unknown slot field');
    assert.deepEqual(u.patch.slots[2].instrument, { type: 'sampler', id: 'user:my-grand' });
    assert.equal(u.patch.slots[3].muted, true);
    assert.deepEqual([u.patch.fx.eq.low, u.patch.fx.comp.amount], [2, 0.4]);
    assert.deepEqual([u.drone.mode, u.tempo, u.timeSig, u.ccli], ['synth', 68, '6/8', '7654321']);
    assert.equal(st.settings.programChange, true, 'clicked in Settings');
    assert.equal(st.settings.pedalInvert, true, 'clicked in Settings');
    assert.deepEqual(st.settings.midiLearn['master.volume'], { cc: 7, channel: 0 });
    assert.equal(st.settings.someFutureSetting.on, true);
    assert.equal(st.meta.note, 'unknown meta field');
    assert.equal(st.setlists[st.setlistOrder[2]].color, 'teal');
    const factory = Object.values(st.songs).filter((s) => s.factoryId);
    assert.equal(factory.length, FACTORY_SONGS.length - 2 + 1, '2 factory songs deleted, 1 song made from one');
    if (ref === 'v1.1.0') {
      assert.equal(u.scenes.length, 2);
      assert.notDeepEqual(u.scenes[0], u.scenes[1]);
      assert.equal(st.settings.theme, 'studio', 'clicked in Settings');
      assert.equal(st.settings.keyboards['Stage Piano MIDI Out'].remember, true);
    }
  }
});

test('migrate: every fixture, every form → schema 2 with nothing lost (field by field)', () => {
  for (const fx of FIXTURES) {
    const raw = JSON.parse(fx.text);
    const m = migrate(raw);
    assert.equal(m.schema, SCHEMA);
    // the only difference anywhere is the schema number: songs, slots, scenes, setlists, settings, meta, unknowns
    assert.deepEqual(lossy(jsonDiff(raw, m)), [], `${fx.ref} ${fx.name}.${fx.form}`);
    if (fx.ref === 'v1.1.0' && fx.form === 'localstorage') {
      assert.deepEqual(jsonDiff(raw, m).filter((d) => !d.startsWith('schema:')), [], `${fx.name}: identical`);
    }
    for (const id of m.songOrder) assert.equal(m.songs[id].patch.slots.length, 4, `${fx.name} ${id}: 4-slot`);
    assert.deepEqual(m.songOrder, raw.songOrder);
    assert.deepEqual(Object.keys(m.songs).sort(), Object.keys(raw.songs).sort(), 'song ids stable');
    const fids = (st) => Object.values(st.songs).map((s) => s.factoryId || null).sort();
    assert.deepEqual(fids(m), fids(raw), 'factoryId stable');
  }
});

test('migrate is idempotent on every fixture (twice = once)', () => {
  for (const fx of FIXTURES) {
    const once = migrate(JSON.parse(fx.text));
    assert.deepEqual(migrate(plain(once)), once, `${fx.ref} ${fx.name}.${fx.form}`);
  }
});

test('the 2.0 store loads each 1.x localStorage library: unchanged, the 1.x text kept first, saved as schema 2', () => {
  for (const fx of FIXTURES.filter((f) => f.form === 'localstorage')) {
    const storage = memoryStorage({ [STORAGE_KEY]: fx.text });
    const store = createStore({ storage, idGen: idGen(), requestIdle: null, warn: () => {}, autoFlush: false, debounceMs: 0 });
    const raw = JSON.parse(fx.text);
    assert.equal(store.loadInfo.status, 'ok');
    assert.deepEqual(lossy(jsonDiff(raw, plain(store.get()))), [], `${fx.ref} ${fx.name}`);
    // D8: an untouched 1.x factory seed holds nothing of the user's, so no copy is kept of it
    const kept = raw.songOrder.length > 0 && !(raw.meta && raw.meta.edited === false);
    if (kept) {
      assert.equal(store.loadInfo.migratedFrom, 1);
      assert.match(store.loadInfo.migrationBackupKey, /^rig\.v1\.kept-\d+\.migration\.s1$/);
      assert.equal(storage.getItem(store.loadInfo.migrationBackupKey), fx.text, `${fx.name}: exact 1.x text kept`);
    } else assert.equal(store.loadInfo.migrationBackupKey, undefined, 'an empty library or a 1.x seed needs no copy');
    store.dispose();
    // an empty 1.x library (or an untouched seed) is left as it is until the first edit (1.x can still read it)
    assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).schema, kept ? 2 : 1, fx.name);
  }
});

/** What a replace import of a 1.x file must give: the 1.x state, except this machine's device-local settings. */
function expectReplaced(st1x, got, before, label) {
  const diffs = jsonDiff(st1x, plain(got)).filter((d) => !d.startsWith('schema:'));
  const allowed = diffs.filter((d) => {
    const k = /^settings\.([^.:]+)/.exec(d)?.[1];
    if (k && DEVICE_LOCAL.has(k)) return false; // checked below
    if (d.startsWith('meta.edited:')) return false; // an imported library is the user's (round2-shell #2)
    return true;
  });
  assert.deepEqual(allowed, [], label);
  for (const k of DEVICE_LOCAL) assert.deepEqual(got.settings[k], before.settings[k], `${label}: this machine's ${k}`);
  assert.equal(got.meta.edited, true);
  for (const k of IMPORT_ENVELOPE_KEYS) assert.equal(k in got, false, `${label}: no ${k} in the state`);
}

test('replace import of every 1.x backup and export: the 1.x library, this machine’s device settings', () => {
  for (const fx of FIXTURES.filter((f) => f.form !== 'localstorage')) {
    const store = makeStore();
    store.set('settings.polyphony', 128); // 2.0 device-local choices survive
    store.set('settings.midiInputName', 'This Mac keyboard');
    const before = plain(store.get());
    const r = store.importJSON(fx.text, { replace: true });
    assert.equal(r.ok, true, `${fx.ref} ${fx.name}.${fx.form}: ${r.error}`);
    expectReplaced(stateOf(fx.ref, fx.name), store.get(), before, `${fx.ref} ${fx.name}.${fx.form}`);
    store.dispose();
  }
});

test('device-local settings are not in a 1.x file (1.x export rule S3/Q7): curves, hotkeys, click stay behind', () => {
  // Not a 2.0 loss: 1.x itself leaves them out of every backup and export. The release notes tell Ryan to redo them.
  for (const form of ['backup', 'export']) {
    const doc = JSON.parse(fixture('v1.1.0', `rich.${form}.json`));
    const local = stateOf('v1.1.0', 'rich');
    const missing = Object.keys(local.settings).filter((k) => !(k in doc.settings)).sort();
    assert.deepEqual(missing, ['audioSleepSec', 'click', 'dynamicRange', 'hotkeys', 'keyboards', 'lowResource', 'menuBarMode',
      'midiClockOut', 'midiInputId', 'midiInputName', 'outputDeviceId', 'padFolder', 'updateCheck'].sort(), form);
    for (const k of missing) assert.ok(DEVICE_LOCAL.has(k), k);
  }
});

test('programChange on in 1.x → \'switch\' in 2.0 (O-AW-3); no programChangeAction is written by the import', () => {
  for (const form of ['backup', 'export']) {
    const store = makeStore();
    assert.equal(store.importJSON(fixture('v1.1.0', `rich.${form}.json`), { replace: true }).ok, true);
    const s = store.get().settings;
    assert.equal(s.programChange, true);
    assert.equal('programChangeAction' in s, false);
    assert.equal(programChangeOf(s).action, 'switch');
    assert.equal(programChangeOf(s).on, true);
    store.dispose();
  }
  const off = makeStore();
  off.importJSON(fixture('v1.1.0', 'deleted-factory.backup.json'), { replace: true });
  assert.equal(programChangeOf(off.get().settings).on, false);
  off.dispose();
});

test('settings that are library content come over exactly (midiLearn, latency, touch, pedal, theme, unknowns)', () => {
  const store = makeStore();
  store.importJSON(fixture('v1.1.0', 'rich.backup.json'), { replace: true });
  const s = store.get().settings;
  const x = stateOf('v1.1.0', 'rich').settings;
  for (const k of ['midiLearn', 'latency', 'velocitySens', 'pedalInvert', 'theme', 'computerKeyboard', 'monoOutput',
    'menuBarSetlistId', 'currentSetlistId', 'currentSongId', 'setlistIndex', 'performChips', 'someFutureSetting']) {
    assert.deepEqual(s[k], x[k], k);
  }
  store.dispose();
});

test('seedFactory after the import: nothing new for a 1.x library (same factory version); deleted songs stay deleted', () => {
  for (const name of ['rich', 'deleted-factory', 'empty']) {
    const store = makeStore();
    store.importJSON(fixture('v1.1.0', `${name}.backup.json`), { replace: true });
    const order = store.get().songOrder.slice();
    assert.deepEqual(store.seedFactory(), [], name);
    assert.deepEqual(store.get().songOrder, order, name);
    store.dispose();
  }
});

test('seedFactory tops up an older factory version once, at the end, skipping songs the library still has', () => {
  // A library from before shell-3 (factoryVersion 1) made by editing the real 1.1 rich backup's meta.
  const doc = JSON.parse(fixture('v1.1.0', 'deleted-factory.backup.json'));
  doc.meta.factoryVersion = 1;
  const store = makeStore();
  store.importJSON(JSON.stringify(doc), { replace: true });
  const order = store.get().songOrder.slice();
  const have = new Set(Object.values(store.get().songs).map((s) => s.factoryId).filter(Boolean));
  const want = FACTORY_SONGS.map((f) => f.factoryId || f.id).filter((fid) => FACTORY_SINCE[fid] > 1 && !have.has(fid));
  assert.ok(want.length >= 1, 'the fixture deleted at least one since:2 song');
  const added = store.seedFactory();
  assert.equal(added.length, want.length);
  assert.deepEqual(store.get().songOrder.slice(0, order.length), order, 'existing order untouched');
  assert.deepEqual(store.get().songOrder.slice(order.length), added, 'appended at the end');
  assert.deepEqual(added.map((id) => store.getSong(id).factoryId).sort(), want.sort());
  assert.equal(store.get().meta.factoryVersion, FACTORY_VERSION);
  assert.deepEqual(store.seedFactory(), [], 'once');
  store.dispose();
});

test('export from 2.0 → re-import (replace) gives a deep-equal library, for every 1.x fixture', () => {
  for (const fx of FIXTURES.filter((f) => f.form !== 'localstorage')) {
    const a = makeStore();
    assert.equal(a.importJSON(fx.text, { replace: true }).ok, true);
    const out = a.exportJSON();
    const b = makeStore();
    assert.equal(b.importJSON(out, { replace: true }).ok, true);
    assert.deepEqual(plain(b.get()), plain(a.get()), `${fx.ref} ${fx.name}.${fx.form}`);
    const strip = (t) => t.replace(/"exportedAt": "[^"]+"/, '');
    assert.equal(strip(b.exportJSON()), strip(out), 'export text identical too');
    a.dispose();
    b.dispose();
  }
});

test('Settings › Import… of a 1.x export into a fresh 2.0 library replaces the untouched seed (E5)', () => {
  for (const ref of ['v1.1.0', 'v1.0.0']) {
    const store = makeStore();
    assert.equal(store.pristine, true);
    const before = plain(store.get());
    const r = store.importJSON(fixture(ref, 'rich.export.json'), { replacePristine: true });
    assert.equal(r.ok, true);
    assert.equal(r.replaced, true);
    // before E5 this merged: 19 + 20 songs, "My Set (imported)", and no MIDI Learn / Program Change / theme
    expectReplaced(stateOf(ref, 'rich'), store.get(), before, `${ref} rich.export`);
    store.dispose();
  }
});

test('Settings › Import… into an edited library still merges (settings untouched); an empty file never wipes a seed', () => {
  const store = makeStore();
  store.set('song.tempo', 99);
  const n = store.get().songOrder.length;
  const r = store.importJSON(fixture('v1.1.0', 'rich.export.json'), { replacePristine: true });
  assert.equal(r.ok, true);
  assert.equal(r.replaced, undefined);
  assert.equal(store.get().songOrder.length, n + 20);
  assert.equal(store.get().settings.programChange, false);
  store.dispose();
  const fresh = makeStore();
  const before = plain(fresh.get());
  assert.equal(fresh.importJSON(fixture('v1.1.0', 'empty.export.json'), { replacePristine: true }).ok, false);
  assert.deepEqual(plain(fresh.get()), before);
  fresh.dispose();
  // the plain merge (no option, e.g. Edit's setlist panel) is unchanged
  const m = makeStore();
  assert.equal(m.importJSON(fixture('v1.1.0', 'rich.export.json')).replaced, undefined);
  assert.equal(m.get().songOrder.length, FACTORY_SONGS.length + 20);
  m.dispose();
});

test('dryRun checks everything and changes nothing', () => {
  const store = makeStore();
  const before = plain(store.get());
  const gen = store.generation;
  assert.equal(store.importJSON(fixture('v1.1.0', 'rich.backup.json'), { replace: true, dryRun: true }).ok, true);
  assert.equal(store.importJSON(fixture('v1.1.0', 'rich.export.json'), { dryRun: true }).ok, true);
  const t = fixture('v1.1.0', 'rich.backup.json');
  assert.equal(store.importJSON(t.slice(0, t.length / 2), { replace: true, dryRun: true }).ok, false);
  assert.deepEqual(plain(store.get()), before);
  assert.equal(store.generation, gen);
  store.dispose();
});

test('the near-cap 1.x library imports (2 M characters): 2.0 adds nothing that would push it over', () => {
  const store = makeStore();
  const r = store.importJSON(fixture('v1.1.0', 'huge.backup.json'), { replace: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.songIds.length, 200);
  assert.ok(JSON.stringify(store.get()).length < 2e6);
  store.dispose();
});
