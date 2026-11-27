// Patch packs (2.x step 1, DECISIONS O-AW-PP): store.topUpPacks / addPackSong rules, the shared helpers, the server
// scan (/api/user-patches, /api/health gating, caps) and the controller read (gated, end to end on a real server).
// Every pack and song name here is invented.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import {
  memoryStorage, migrate, LIBRARY_MAX_CHARS, LIBRARY_RESTORE_MAX_CHARS, STORAGE_KEY,
} from '../../../app/js/store.js';
import { blankSong, FACTORY_SONGS } from '../../../app/js/presets.js';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import {
  stableStringify, songFingerprint, normalizeBank, searchBank, bankMatches, validPackEntry, PACK_ID_RE,
} from '../../../app/js/shared/patch-packs.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { createServer, scanUserPatches, hasUserPatches } = require('../../../server.js');

// ------------------------------------------------------------------------------------------ helpers
const song = (name, over = {}) => ({ ...blankSong({ name }), ...over });
let hashN = 0;
const entry = (packId, s, over = {}) => {
  const [pack, rest] = packId.split(':');
  const hash = over.hash || `h${++hashN}`;
  const file = rest.replace(/#.*/, '');
  return { packId, pack, file, n: null, mtime: 1, hash, mode: 'auto', schema: 2, song: s, ...over };
};
const EMPTY = Object.freeze({ added: [], updated: [], kept: [], skipped: [], bank: 0 });
const ids = (st) => st.songOrder;
const lastIds = (st, n) => st.songOrder.slice(-n);
function storeWithWarns(opts = {}) {
  const warns = [];
  const s = makeStore({ warn: (m) => warns.push(m), ...opts });
  return { s, warns };
}

// ------------------------------------------------------------------------------------------ shared helpers
test('shared: stableStringify ignores key order; songFingerprint ignores the library id only', () => {
  assert.equal(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] }), stableStringify({ a: [1, { c: 3, d: 2 }], b: 1 }));
  const a = song('Lantern Hymn');
  assert.equal(songFingerprint({ ...a, id: 'x' }), songFingerprint({ ...a, id: 'y' }));
  assert.notEqual(songFingerprint(a), songFingerprint({ ...a, hearIn: 2 }));
  assert.equal(songFingerprint(null), '');
});

test('shared: normalizeBank keeps valid fields, drops bad ones, needs a title (or the fallback)', () => {
  const b = normalizeBank({ title: ' Copper Fields ', artist: 'The Invented Choir', ccli: 1234567, originalKey: 'Eb',
    bpm: 72.25, timeSig: '6/8', tags: ['slow', 'slow', 'opener', 7], extra: 'x' });
  assert.deepEqual(b, { title: 'Copper Fields', artist: 'The Invented Choir', ccli: '1234567', originalKey: 'Eb',
    bpm: 72.3, timeSig: '6/8', tags: ['slow', 'opener'] });
  const bad = { originalKey: 'H', bpm: 9999, timeSig: '7/7', ccli: 'abc' };
  assert.deepEqual(normalizeBank(bad, 'Fallback'), { title: 'Fallback' });
  assert.equal(normalizeBank({}), null);
  assert.equal(normalizeBank('nope', 'x'), null);
});

test('shared: searchBank matches every word in title or artist (case/accents ignored), sorted by title', () => {
  const items = [{ title: 'Quiet Harbor', artist: 'Mira Okonkwo-Test' },
    { title: 'Ember Psalm', artist: 'Léa Fictional' }, { title: 'Arbor Song', artist: 'Mira Okonkwo-Test' }];
  assert.deepEqual(searchBank(items, '').map((i) => i.title), ['Arbor Song', 'Ember Psalm', 'Quiet Harbor']);
  assert.deepEqual(searchBank(items, 'mira').map((i) => i.title), ['Arbor Song', 'Quiet Harbor']);
  assert.deepEqual(searchBank(items, 'LEA psalm').map((i) => i.title), ['Ember Psalm']);
  assert.deepEqual(searchBank(items, 'harbor okonkwo').map((i) => i.title), ['Quiet Harbor']);
  assert.equal(bankMatches(items[0], 'zzz'), false);
});

test('shared: pack ids and entries', () => {
  for (const ok of ['my-pack:sunday.json', 'My Pack:two words.json', 'p:a.json#0', 'p:a.json#12']) {
    assert.ok(PACK_ID_RE.test(ok), ok);
  }
  for (const bad of ['nocolon.json', 'p:a.txt', 'p:sub/a.json', ':a.json', 'p:a.json#x']) {
    assert.ok(!PACK_ID_RE.test(bad), bad);
  }
  assert.ok(validPackEntry(entry('p:a.json', song('A'))));
  assert.ok(!validPackEntry(entry('p:a.json', { name: 'no patch' })));
  assert.ok(!validPackEntry({ ...entry('p:a.json', song('A')), hash: '' }));
});

// ------------------------------------------------------------------------------------------ store: no packs
test('existing users with no packs see no change: an empty top-up writes nothing; migrate adds nothing', async () => {
  const storage = memoryStorage();
  const a = makeStore({ storage, debounceMs: 0 });
  a.persistNow();
  const before = JSON.stringify(a.get());
  const seen = [];
  a.subscribe((st, paths) => seen.push(...paths));
  for (const l of [[], null, undefined, 'x']) assert.deepEqual(a.topUpPacks(l), EMPTY);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, []);
  assert.equal(JSON.stringify(a.get()), before);
  assert.equal('packSongs' in a.get().meta, false);
  assert.equal(JSON.stringify(migrate(JSON.parse(before))), before, 'migrate of a pack-less library is unchanged');
  assert.equal(a.pristine, true);
  assert.deepEqual(a.packSongs(), {});
});

// ------------------------------------------------------------------------------------------ store: auto mode
test('topUpPacks adds each auto song once, at the end of the library (no setlist), and is idempotent', () => {
  const { s } = storeWithWarns();
  const st0 = s.get();
  const sl = st0.setlists[st0.setlistOrder[0]].songIds.slice();
  const list = [entry('Grove Pack:lantern-hymn.json', song('Lantern Hymn')),
    entry('Grove Pack:set.json#0', song('Copper Fields')), entry('Grove Pack:set.json#1', song('Quiet Harbor'))];
  const r = s.topUpPacks(list);
  assert.equal(r.added.length, 3);
  const st = s.get();
  assert.deepEqual(lastIds(st, 3), r.added);
  assert.deepEqual(r.added.map((id) => st.songs[id].name), ['Lantern Hymn', 'Copper Fields', 'Quiet Harbor']);
  assert.deepEqual(st.setlists[st.setlistOrder[0]].songIds, sl, 'setlists untouched');
  assert.equal(st.settings.currentSongId, st0.settings.currentSongId, 'current song unchanged');
  assert.equal(s.pristine, true, 'pack writes are not edits');
  assert.deepEqual(s.packSongs(), {
    'Grove Pack:lantern-hymn.json': r.added[0],
    'Grove Pack:set.json#0': r.added[1],
    'Grove Pack:set.json#1': r.added[2],
  });
  assert.equal(s.packIdOf(r.added[1]), 'Grove Pack:set.json#0');
  const json = JSON.stringify(s.get());
  const again = s.topUpPacks(list);
  assert.deepEqual(again, EMPTY);
  assert.equal(JSON.stringify(s.get()), json, 'second top-up changes nothing');
  // duplicate pack ids in one list: first wins
  const r2 = s.topUpPacks([entry('Other:x.json', song('Ember Psalm')), entry('Other:x.json', song('Ember Psalm 2'))]);
  assert.equal(r2.added.length, 1);
  assert.equal(s.get().songs[r2.added[0]].name, 'Ember Psalm');
});

test('pack songs survive a reload and are not added again (two boots)', () => {
  const storage = memoryStorage();
  const list = [entry('Grove Pack:a.json', song('Arbor Song'), { hash: 'aaa' })];
  const a = makeStore({ storage, debounceMs: 0 });
  assert.equal(a.topUpPacks(list).added.length, 1);
  a.persistNow();
  const b = makeStore({ storage });
  assert.equal(b.loadInfo.status, 'ok');
  assert.deepEqual(b.topUpPacks(list).added, []);
  assert.equal(b.get().songOrder.filter((id) => b.get().songs[id].name === 'Arbor Song').length, 1);
  assert.deepEqual(b.get(), a.get());
});

test('schema: none = a 1.x song (4 slots); a schema-2 entry keeps its slot count; a newer one is skipped', () => {
  const { s, warns } = storeWithWarns();
  const six = song('Six Lanes');
  six.patch = { ...six.patch, slots: [...six.patch.slots, null, null] };
  const r = s.topUpPacks([
    entry('P:legacy.json', song('Old Lanes'), { schema: undefined }),
    entry('P:six.json', six),
    entry('P:future.json', song('Tomorrow'), { schema: 99 }),
  ]);
  assert.equal(r.added.length, 2);
  assert.equal(s.get().songs[r.added[0]].patch.slots.length, 4);
  assert.equal(s.get().songs[r.added[1]].patch.slots.length, 6);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /^P:future\.json: made by a newer version/);
  assert.ok(warns.some((w) => /patch pack: P:future\.json/.test(w)));
});

// ------------------------------------------------------------------------------------------ store: updates / edits
test('a newer version replaces an unedited song in place (same id, library position and setlists)', () => {
  const { s } = storeWithWarns();
  const [id] = s.topUpPacks([entry('P:hymn.json', song('Lantern Hymn'), { hash: 'v1' })]).added;
  const sl = s.get().setlistOrder[0];
  s.set(`setlists.${sl}.songIds`, [...s.get().setlists[sl].songIds, id]); // put in a set (not a song edit)
  s.set('songOrder', [id, ...s.get().songOrder.filter((x) => x !== id)]);
  const order = s.get().songOrder.slice();
  const v2 = song('Lantern Hymn', { tempo: 84, notes: 'second version' });
  const r = s.topUpPacks([entry('P:hymn.json', v2, { hash: 'v2' })]);
  assert.deepEqual(r.updated, [id]);
  assert.deepEqual(r.added, []);
  const st = s.get();
  assert.equal(st.songs[id].tempo, 84);
  assert.equal(st.songs[id].notes, 'second version');
  assert.deepEqual(st.songOrder, order);
  assert.ok(st.setlists[sl].songIds.includes(id));
  // same hash again: nothing
  assert.deepEqual(s.topUpPacks([entry('P:hymn.json', v2, { hash: 'v2' })]).updated, []);
});

test('an edited pack song is never overwritten; undoing the edit by hand makes it updatable again', () => {
  const { s } = storeWithWarns();
  const [id] = s.topUpPacks([entry('P:hymn.json', song('Lantern Hymn'), { hash: 'v1' })]).added;
  assert.ok(s.set(`songs.${id}.hearIn`, 3));
  const r = s.topUpPacks([entry('P:hymn.json', song('Lantern Hymn', { tempo: 90 }), { hash: 'v2' })]);
  assert.deepEqual(r.kept, ['P:hymn.json']);
  assert.deepEqual(r.updated, []);
  assert.equal(s.get().songs[id].hearIn, 3);
  assert.equal(s.get().songs[id].tempo, null);
  assert.ok(s.set(`songs.${id}.hearIn`, 0)); // back to what the pack wrote
  const r2 = s.topUpPacks([entry('P:hymn.json', song('Lantern Hymn', { tempo: 90 }), { hash: 'v2' })]);
  assert.deepEqual(r2.updated, [id]);
  assert.equal(s.get().songs[id].tempo, 90);
});

test('a mute or a level change counts as an edit too (any persisted change to the song)', () => {
  const { s } = storeWithWarns();
  const [id] = s.topUpPacks([entry('P:m.json', song('Muted Lane'), { hash: 'v1' })]).added;
  assert.ok(s.set(`songs.${id}.patch.slots.0.gain`, 0.33));
  const v2 = entry('P:m.json', song('Muted Lane', { tempo: 70 }), { hash: 'v2' });
  assert.deepEqual(s.topUpPacks([v2]).kept, ['P:m.json']);
});

// ------------------------------------------------------------------------------------------ store: delete, folder gone
test('a deleted pack song is remembered: never re-added, even for a newer version; a gone pack changes nothing', () => {
  const { s } = storeWithWarns();
  const list = [entry('P:a.json', song('Arbor Song'), { hash: 'v1' }),
    entry('P:b.json', song('Copper Fields'), { hash: 'v1' })];
  const [a, b] = s.topUpPacks(list).added;
  assert.ok(s.deleteSong(a));
  assert.deepEqual(s.topUpPacks(list).added, []);
  assert.deepEqual(s.topUpPacks([{ ...list[0], hash: 'v2' }]), EMPTY);
  assert.equal(s.get().songOrder.includes(a), false);
  assert.deepEqual(Object.keys(s.get().meta.packSongs), ['P:a.json', 'P:b.json'], 'the record stays');
  // the pack folder removed: an empty list (or one without P:b) leaves b alone
  const json = JSON.stringify(s.get());
  s.topUpPacks([]);
  s.topUpPacks([list[1]]);
  assert.equal(JSON.stringify(s.get()), json);
  assert.ok(s.get().songs[b]);
});

test('meta.packSongs survives migrate idempotently; bad records are dropped, an empty map is dropped', () => {
  const { s } = storeWithWarns();
  s.topUpPacks([entry('P:a.json', song('Arbor Song'))]);
  const raw = JSON.parse(JSON.stringify(s.get()));
  const once = migrate(raw);
  assert.deepEqual(migrate(JSON.parse(JSON.stringify(once))), once);
  assert.deepEqual(once.meta.packSongs, raw.meta.packSongs);
  raw.meta.packSongs['bad id'] = { id: 'x', hash: 'h', sig: 's' };
  raw.meta.packSongs['P:b.json'] = { id: 7 };
  raw.meta.packSongs.__proto__ = { id: 'x', hash: 'h', sig: 's' };
  assert.deepEqual(Object.keys(migrate(raw).meta.packSongs), ['P:a.json']);
  assert.equal('packSongs' in migrate({ ...raw, meta: { ...raw.meta, packSongs: { nope: 1 } } }).meta, false);
  assert.equal('packSongs' in migrate({ ...raw, meta: { ...raw.meta, packSongs: [] } }).meta, false);
});

test('a pack song exports as a plain song file (no pack fields), and re-imports as an independent copy', () => {
  const { s } = storeWithWarns();
  const [id] = s.topUpPacks([entry('P:a.json', song('Arbor Song'))]).added;
  const doc = JSON.parse(s.exportSong(id));
  assert.equal(doc.kind, 'song');
  assert.equal(JSON.stringify(doc).includes('pack'), false);
  const r = s.importJSON(JSON.stringify(doc));
  assert.ok(r.ok);
  assert.equal(s.packIdOf(r.songIds[0]), null);
  assert.equal(s.packIdOf(id), 'P:a.json');
});

// ------------------------------------------------------------------------------------------ store: bad input / caps
test('bad entries are skipped with a warning; good ones in the same list still go in', () => {
  const { s, warns } = storeWithWarns();
  const r = s.topUpPacks([
    { packId: 'P:nohash.json', song: song('X') },
    entry('P:nopatch.json', { name: 'No Patch' }),
    { ...entry('P:y.json', song('Y')), packId: 'bad-id' },
    'string',
    null,
    entry('P:ok.json', song('Arbor Song')),
  ]);
  assert.equal(r.added.length, 1);
  assert.equal(r.skipped.length, 5);
  assert.equal(warns.filter((w) => /^patch pack: /.test(w)).length, 5);
  assert.equal(s.get().songs[r.added[0]].name, 'Arbor Song');
});

// CAP (UI6-cship O1; D9 + the O4 note under D33): one size rule for every add. A pack song that takes the library
// past LIBRARY_MAX_CHARS goes in and the save warns ('library-size'); one that would take it past
// LIBRARY_RESTORE_MAX_CHARS is skipped / refused, writes nothing, with one 'library-full' notice, and is tried again.
const PAST_2MB = 2100000; // a blob this long takes a fresh library past LIBRARY_MAX_CHARS, inside the restore cap
function capStore() {
  const storage = memoryStorage();
  const { s, warns } = storeWithWarns({ storage, debounceMs: 0 });
  const notices = [];
  s.onNotice((n) => notices.push(n));
  return { s, warns, notices, storage };
}
const ofType = (notices, t) => notices.filter((n) => n.type === t);

test('CAP: pack top-up past 2 MB adds and warns at the save; past the restore cap skipped (and tried again later)',
  () => {
    const { s, notices, storage } = capStore();
    assert.ok(PAST_2MB > LIBRARY_MAX_CHARS && PAST_2MB < LIBRARY_RESTORE_MAX_CHARS);
    const big = song('Heavy Anthem', { blob: 'x'.repeat(PAST_2MB) }); // unknown fields are kept, uncapped
    const r = s.topUpPacks([entry('P:big.json', big), entry('P:small.json', song('Light Anthem'))]);
    assert.equal(r.added.length, 2, 'past 2 MB: added (D9)');
    assert.deepEqual(r.skipped, []);
    const size = JSON.stringify(s.get()).length;
    assert.ok(size > LIBRARY_MAX_CHARS && size <= LIBRARY_RESTORE_MAX_CHARS, `${size}`);
    assert.equal(s.persistNow(), true, 'saved');
    assert.equal(storage.getItem(STORAGE_KEY), JSON.stringify(s.get()));
    assert.equal(ofType(notices, 'library-size').length, 1, 'the D9 save warning');
    assert.equal(ofType(notices, 'library-full').length, 0);
    // the next one would pass 2.5 MB: skipped, nothing written, one notice, not remembered
    const huge = song('Huge Anthem', { blob: 'y'.repeat(LIBRARY_RESTORE_MAX_CHARS - PAST_2MB) });
    const before = JSON.stringify(s.get());
    const r2 = s.topUpPacks([entry('P:huge.json', huge), entry('P:huge2.json', song('Huge Too', { blob: 'z' }))]);
    assert.equal(r2.added.length, 1, 'a small one still fits');
    assert.match(r2.skipped[0], /^P:huge\.json: the library is full; not added/);
    const full = ofType(notices, 'library-full');
    assert.equal(full.length, 1);
    assert.match(full[0].message, /^The patch pack song “Huge Anthem” was not added: the library would be 2\.\d/);
    assert.match(full[0].message, /a backup over 2\.5 MB cannot be restored/);
    assert.equal('P:huge.json' in s.get().meta.packSongs, false, 'not remembered: it can go in once there is room');
    assert.ok(JSON.stringify(s.get()).length <= LIBRARY_RESTORE_MAX_CHARS);
    // all refused: nothing written at all
    const before2 = JSON.stringify(s.get());
    const r3 = s.topUpPacks([entry('P:huge.json', huge), entry('P:huge3.json', song('Huge Three', { blob: 'w'.repeat(
      LIBRARY_RESTORE_MAX_CHARS) }))]);
    assert.deepEqual(r3.added, []);
    assert.equal(r3.skipped.length, 2);
    assert.equal(JSON.stringify(s.get()), before2, 'a refused top-up writes nothing');
    assert.equal(ofType(notices, 'library-full').length, 2, 'one notice per top-up');
    assert.match(ofType(notices, 'library-full')[1].message, /^2 patch pack songs were not added: /);
    assert.notEqual(before, before2);
    // once there is room it goes in
    s.deleteSong(r.added[0]);
    assert.equal(s.topUpPacks([entry('P:huge.json', huge)]).added.length, 1);
  });

test('CAP: a pack update past the restore cap is not applied (the old version stays) and says so', () => {
  const { s, notices } = capStore();
  const v1 = entry('P:grow.json', song('Growing Hymn'));
  const [id] = s.topUpPacks([v1]).added;
  s.topUpPacks([entry('P:filler.json', song('Filler', { blob: 'f'.repeat(PAST_2MB) }))]);
  const v2 = { ...v1, hash: 'h-grown', song: song('Growing Hymn', { blob: 'g'.repeat(LIBRARY_RESTORE_MAX_CHARS) }) };
  const before = JSON.stringify(s.get());
  const r = s.topUpPacks([v2]);
  assert.deepEqual(r.updated, []);
  assert.match(r.skipped[0], /^P:grow\.json: the library is full; not updated/);
  assert.equal(JSON.stringify(s.get()), before);
  assert.equal(s.get().songs[id].blob, undefined);
  assert.match(ofType(notices, 'library-full')[0].message, /^The patch pack song “Growing Hymn” was not updated: /);
});

test('CAP: Song bank add past 2 MB goes through and warns at the save; past the restore cap refused, nothing written',
  () => {
    const { s, notices, storage } = capStore();
    const big = { ...entry('B:big.json', song('Bank Anthem', { blob: 'x'.repeat(PAST_2MB) })), mode: 'bank' };
    const a = s.addPackSong(big);
    assert.equal(a.ok, true, 'past 2 MB: added (D9)');
    assert.ok(JSON.stringify(s.get()).length > LIBRARY_MAX_CHARS);
    assert.equal(s.persistNow(), true);
    assert.equal(storage.getItem(STORAGE_KEY), JSON.stringify(s.get()));
    assert.equal(ofType(notices, 'library-size').length, 1);
    const huge = { ...entry('B:huge.json', song('Bank Colossus', { blob: 'y'.repeat(LIBRARY_RESTORE_MAX_CHARS -
      PAST_2MB) })), mode: 'bank' };
    const before = JSON.stringify(s.get());
    const r = s.addPackSong(huge, { select: true });
    assert.equal(r.ok, false);
    assert.equal(r.notified, true, 'the views do not toast it a second time');
    assert.match(r.error, /^“Bank Colossus” was not added: the library would be 2\.\d MB, /);
    assert.equal(JSON.stringify(s.get()), before, 'nothing written (song, order, record, selection)');
    const full = ofType(notices, 'library-full');
    assert.equal(full.length, 1);
    assert.equal(full[0].message, r.error);
    assert.equal(full[0].cap, LIBRARY_RESTORE_MAX_CHARS);
  });

test('read-only library: topUpPacks / addPackSong write nothing', () => {
  const { s } = storeWithWarns();
  s.setReadOnly(true, 'second-window');
  assert.deepEqual(s.topUpPacks([entry('P:a.json', song('Arbor Song'))]).added, []);
  assert.equal(s.addPackSong({ ...entry('P:a.json', song('Arbor Song')), mode: 'bank' }).ok, false);
});

// ------------------------------------------------------------------------------------------ store: bank mode
test('bank mode: never auto-added; addPackSong adds one once; delete then add again is allowed; updates follow', () => {
  const { s } = storeWithWarns();
  const n0 = s.get().songOrder.length;
  const bank = [entry('Bank:a.json', song('Arbor Song'), { mode: 'bank', hash: 'v1' }),
    entry('Bank:b.json', song('Ember Psalm'), { mode: 'bank', hash: 'v1' })];
  const r = s.topUpPacks(bank);
  assert.equal(r.bank, 2);
  assert.deepEqual(r.added, []);
  assert.equal(s.get().songOrder.length, n0);
  const a = s.addPackSong(bank[0]);
  assert.ok(a.ok && !a.existing);
  assert.equal(s.get().songOrder.at(-1), a.id);
  assert.equal(s.pristine, false, 'a song the player added is an edit');
  assert.deepEqual(s.addPackSong(bank[0]), { ok: true, id: a.id, existing: true });
  assert.equal(s.get().songOrder.length, n0 + 1);
  assert.equal(s.topUpPacks(bank).bank, 1, 'the added one is no longer counted as bank-only');
  // updates in place while unedited
  const v2 = { ...bank[0], hash: 'v2', song: song('Arbor Song', { tempo: 66 }) };
  assert.deepEqual(s.topUpPacks([v2]).updated, [a.id]);
  // delete → not re-added by top-up; an explicit add brings it back (new id)
  s.deleteSong(a.id);
  assert.deepEqual(s.topUpPacks([v2]).added, []);
  const again = s.addPackSong(v2, { select: true });
  assert.ok(again.ok && !again.existing && again.id !== a.id);
  assert.equal(s.get().settings.currentSongId, again.id);
  assert.equal(s.get().songs[again.id].tempo, 66);
  assert.equal(s.addPackSong({ packId: 'nope' }).ok, false);
});

// ------------------------------------------------------------------------------------------ server
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-packs-'));
const rootA = path.join(tmp, 'project', 'user-samples');
const rootB = path.join(tmp, 'Music', 'Worship Rig', 'Samples');
const noPacks = path.join(tmp, 'no-packs');
const write = (f, data) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
};
const exportOf = (s, bank) => ({
  app: 'worship-rig', kind: 'song', schema: 2, exportedAt: '2026-11-25T00:00:00Z', song: s, ...(bank ? { bank } : {}),
});
const port = 20000 + Math.floor(Math.random() * 20000);
const ARBOR_BANK = Object.freeze({
  title: 'Arbor Song', artist: 'Mira Testwell', ccli: '0000001', originalKey: 'D', bpm: 68, timeSig: '3/4',
  tags: ['slow'],
});
let srv;
const req = (p, headers = {}, prt = port) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: prt, path: p, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
  });
  r.on('error', reject);
  r.end();
});
const jget = async (p, prt) => JSON.parse((await req(p, {}, prt)).body);

before(async () => {
  // a My Samples pack with an instrument and songs that use it
  write(path.join(rootA, 'Grove Keys', 'manifest.json'), {
    instruments: [{ id: 'grove-piano', name: 'Grove Piano', ext: 'wav',
      layers: [{ vel: [0, 127], dir: 'v1', notes: ['C4'] }] }],
  });
  const usesGrove = song('Lantern Hymn');
  usesGrove.patch.slots[0] = { ...usesGrove.patch.slots[0], instrument: { type: 'sampler', id: 'user:grove-piano' } };
  write(path.join(rootA, 'Grove Keys', 'songs', 'lantern-hymn.json'), exportOf({ ...usesGrove, id: 'song_old' }));
  const grove = path.join(rootA, 'Grove Keys', 'songs');
  write(path.join(grove, 'sunday-set.json'), [exportOf(song('Copper Fields')), song('Quiet Harbor')]);
  write(path.join(rootA, 'Grove Keys', 'songs', '.hidden.json'), exportOf(song('Hidden')));
  write(path.join(rootA, 'Grove Keys', 'songs', 'readme.txt'), 'not json');
  // problems
  const ghost = song('Ghost Keys');
  ghost.patch.slots[0] = { ...ghost.patch.slots[0], instrument: { type: 'sampler', id: 'user:not-there' } };
  write(path.join(rootA, 'Grove Keys', 'songs', 'ghost.json'), exportOf(ghost));
  write(path.join(rootA, 'Broken', 'songs', 'bad.json'), '{ not json');
  write(path.join(rootA, 'Broken', 'songs', 'library.json'), { app: 'worship-rig', kind: 'library', songs: {} });
  const broken = path.join(rootA, 'Broken', 'songs');
  write(path.join(broken, 'slots.json'), exportOf(song('Too Wide', { patch: { slots: new Array(17).fill(null) } })));
  write(path.join(broken, 'big.json'), exportOf(song('Huge', { blob: 'x'.repeat(1024 * 1024 + 10) })));
  let deep = {};
  const deepRoot = deep;
  for (let i = 0; i < 80; i++) deep = deep.n = {};
  write(path.join(rootA, 'Broken', 'songs', 'deep.json'), exportOf(song('Deep', { deep: deepRoot })));
  write(path.join(rootA, 'Broken', 'songs', 'nosong.json'), { kind: 'song', song: { name: 'No Patch' } });
  // a bank pack in the second root, with metadata
  write(path.join(rootB, 'Hymn Bank', 'pack.json'), { mode: 'bank', name: 'Invented Hymn Bank' });
  write(path.join(rootB, 'Hymn Bank', 'songs', 'arbor.json'), exportOf(song('Arbor Song', { tempo: 68 }),
    ARBOR_BANK));
  write(path.join(rootB, 'Hymn Bank', 'songs', 'ember.json'),
    { ...song('Ember Psalm'), bank: { title: 'Ember Psalm', artist: 'Léa Fictional' } });
  // the same slug in the later root: skipped
  write(path.join(rootB, 'Grove Keys', 'songs', 'dupe.json'), exportOf(song('Dupe')));
  // bad pack.json mode
  write(path.join(rootB, 'Odd Mode', 'pack.json'), { mode: 'everything' });
  write(path.join(rootB, 'Odd Mode', 'songs', 'one.json'), exportOf(song('Odd One')));
  // a link out of the root
  const outside = path.join(tmp, 'outside-pack');
  write(path.join(outside, 'songs', 'x.json'), exportOf(song('Outside')));
  fs.symlinkSync(outside, path.join(rootB, 'Linked Out'), 'dir');
  // a songs/ file linking outside its pack
  write(path.join(tmp, 'secret.json'), exportOf(song('Secret')));
  fs.symlinkSync(path.join(tmp, 'secret.json'), path.join(rootB, 'Hymn Bank', 'songs', 'zz-link.json'));
  // a My Samples root with only instrument packs (no songs/)
  write(path.join(noPacks, 'Only Samples', 'manifest.json'), { instruments: [] });
  srv = createServer({ appDir: path.join(tmp, 'app'), port, userSamples: [rootA, rootB], docsDir: null });
  write(path.join(tmp, 'app', 'index.html'), '<!doctype html>');
  await srv.listen();
});
after(async () => {
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('server: the scan lists auto and bank songs with stable ids, hashes, mtimes and checked entries', async () => {
  const r = await srv.rescanUserPatches();
  const byId = Object.fromEntries(r.patches.map((p) => [p.packId, p]));
  assert.deepEqual(Object.keys(byId), ['Grove Keys:ghost.json', 'Grove Keys:lantern-hymn.json',
    'Grove Keys:sunday-set.json#0', 'Grove Keys:sunday-set.json#1', 'Hymn Bank:arbor.json', 'Hymn Bank:ember.json',
    'Odd Mode:one.json']);
  const lh = byId['Grove Keys:lantern-hymn.json'];
  assert.equal(lh.pack, 'Grove Keys');
  assert.equal(lh.file, 'lantern-hymn.json');
  assert.equal(lh.n, null);
  assert.equal(lh.mode, 'auto');
  assert.equal(lh.schema, 2);
  assert.equal(lh.song.name, 'Lantern Hymn');
  assert.equal('id' in lh.song, false, 'library ids are dropped');
  assert.ok(Number.isFinite(lh.mtime) && /^[0-9a-f]{16}$/.test(lh.hash));
  assert.equal(byId['Grove Keys:sunday-set.json#1'].n, 1);
  assert.equal(byId['Grove Keys:sunday-set.json#1'].schema, undefined, 'a bare song carries no schema (a 1.x song)');
  const arbor = byId['Hymn Bank:arbor.json'];
  assert.equal(arbor.mode, 'bank');
  assert.deepEqual(arbor.bank, ARBOR_BANK);
  assert.equal(byId['Hymn Bank:ember.json'].bank.artist, 'Léa Fictional');
  assert.equal('bank' in byId['Hymn Bank:ember.json'].song, false, 'a bare song\'s bank field is lifted out');
  assert.equal(byId['Odd Mode:one.json'].mode, 'auto');
  assert.deepEqual(r.packs.map((p) => [p.slug, p.mode, p.songs]), [['Broken', 'auto', 0], ['Grove Keys', 'auto', 4],
    ['Hymn Bank', 'bank', 2], ['Odd Mode', 'auto', 1]]);
  assert.equal(r.packs.find((p) => p.slug === 'Hymn Bank').name, 'Invented Hymn Bank');
  const err = r.errors.join('\n');
  for (const re of [/Broken\/songs\/bad\.json: not valid JSON/, /library\.json: a whole library/,
    /slots\.json: "patch\.slots" must be a list of 1 to 16/, /big\.json: is larger than 1 MB/,
    /deep\.json: nested too deeply/, /nosong\.json: no song in it/, /ghost\.json: uses "user:not-there"/,
    /Grove Keys: a pack named "Grove Keys" was already found/, /Odd Mode\/pack\.json: "mode" must be "auto" or "bank"/,
    /Linked Out: is a link to a folder outside/, /zz-link\.json: is a link to a file outside the pack/]) {
    assert.match(err, re);
  }
  assert.doesNotMatch(err, /lantern-hymn\.json: uses/, 'user:grove-piano is a My Samples instrument');
  assert.doesNotMatch(err, /Hidden|readme/);
});

test('server: the hash follows content, not mtime; one changed array entry changes only its hash', async () => {
  const f = path.join(rootA, 'Grove Keys', 'songs', 'sunday-set.json');
  const h0 = Object.fromEntries((await srv.rescanUserPatches()).patches.map((p) => [p.packId, p.hash]));
  const t = new Date(Date.now() + 60000);
  fs.utimesSync(f, t, t);
  const r1 = await srv.rescanUserPatches();
  const p1 = r1.patches.find((p) => p.packId === 'Grove Keys:sunday-set.json#0');
  assert.equal(p1.hash, h0['Grove Keys:sunday-set.json#0']);
  assert.equal(p1.mtime, Math.round(fs.statSync(f).mtimeMs));
  write(f, [exportOf(song('Copper Fields')), song('Quiet Harbor', { tempo: 99 })]);
  const h2 = Object.fromEntries((await srv.rescanUserPatches()).patches.map((p) => [p.packId, p.hash]));
  assert.equal(h2['Grove Keys:sunday-set.json#0'], h0['Grove Keys:sunday-set.json#0']);
  assert.notEqual(h2['Grove Keys:sunday-set.json#1'], h0['Grove Keys:sunday-set.json#1']);
});

test('server: caps on files per pack and songs per file', async () => {
  const root = path.join(tmp, 'caps');
  for (let i = 0; i < 202; i++) write(path.join(root, 'Many', 'songs', `s${i}.json`), exportOf(song(`Made Up ${i}`)));
  write(path.join(root, 'Wide', 'songs', 'list.json'), Array.from({ length: 105 }, (_, i) => song(`Listed ${i}`)));
  const r = await scanUserPatches([root]);
  assert.equal(r.patches.filter((p) => p.pack === 'Many').length, 200);
  assert.equal(r.patches.filter((p) => p.pack === 'Wide').length, 100);
  assert.match(r.errors.join('\n'), /Many\/songs: more than 200 files/);
  assert.match(r.errors.join('\n'), /Wide\/songs\/list\.json: more than 100 songs/);
});

test('server: /api/health advertises user-patches only when a pack has songs; the list is always 200', async () => {
  const h = await jget('/api/health');
  assert.equal(h.userPatches, true);
  assert.deepEqual(h.features, ['user-samples', 'user-patches']);
  const l = await jget('/api/user-patches');
  assert.equal(l.kind, 'user-patches');
  assert.equal(l.enabled, true);
  assert.ok(l.patches.length >= 7);
  assert.equal((await req('/app/api/user-patches')).status, 200, 'answered under a page prefix too');
  // no packs (instrument packs only) / missing roots / My Samples off: the old health, and an empty 200 list
  const p2 = port + 1;
  const appDir = path.join(tmp, 'app');
  const s2 = createServer({ appDir, port: p2, userSamples: [noPacks, path.join(tmp, 'nope')], docsDir: null });
  const p3 = port + 2;
  const s3 = createServer({ appDir, port: p3, docsDir: null });
  await s2.listen();
  await s3.listen();
  try {
    const h2 = await jget('/api/health', p2);
    assert.equal(h2.userPatches, false);
    assert.deepEqual(h2.features, ['user-samples'], 'unchanged for a setup without packs');
    const h3 = await jget('/api/health', p3);
    assert.equal(h3.userPatches, false);
    assert.deepEqual(h3.features, []);
    for (const prt of [p2, p3]) {
      const r = await req('/api/user-patches', {}, prt);
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.body).patches, []);
    }
    assert.equal(await hasUserPatches([noPacks]), false);
    assert.equal(await hasUserPatches([rootA]), true);
  } finally {
    await s2.close();
    await s3.close();
  }
});

test('server: with a secret (Electron, S4) /api/user-patches needs the key; /api/health does not', async () => {
  const p4 = port + 3;
  const s4 = createServer({ appDir: path.join(tmp, 'app'), port: p4, userSamples: [rootA], docsDir: null,
    secret: 'k3y' });
  await s4.listen();
  try {
    assert.equal((await req('/api/user-patches', {}, p4)).status, 403);
    assert.equal((await req('/api/user-patches', { 'x-rig-key': 'k3y' }, p4)).status, 200);
    assert.equal((await req('/api/health', {}, p4)).status, 200);
  } finally {
    await s4.close();
  }
});

// ------------------------------------------------------------------------------------------ controller (end to end)
async function withLocation(href, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: new URL(href), configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (had) Object.defineProperty(globalThis, 'location', had);
    else delete globalThis.location;
  }
}
const newController = (store, midi) => createController({
  store, engine: fakeEngine(), midi, recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(), rig: null,
  timers: fakeTimers(), now: () => 0, locks: null, heartbeat: false, indexedDB: null,
});
async function controllerOn(href, store) {
  return withLocation(href, async () => {
    const midi = new MidiInput({ nav: null, warn: () => {} });
    midi.access = {};
    const ctl = newController(store, midi);
    const warns = [];
    ctl.addEventListener('warn', (e) => warns.push(e.detail.message));
    await ctl.start();
    const boot = await ctl.packsReady;
    return { ctl, boot, warns };
  });
}

test('controller: boot adds auto songs once and lists the bank; addFromBank; a 2nd boot adds nothing', async () => {
  const storage = memoryStorage();
  const store = makeStore({ storage, debounceMs: 0 });
  const n0 = store.get().songOrder.length;
  const { ctl, boot, warns } = await controllerOn(`http://127.0.0.1:${port}/`, store);
  assert.equal(boot.enabled, true);
  assert.equal(boot.added.length, 5, 'Grove Keys ×4 and Odd Mode ×1 (auto); the bank pack is not added');
  assert.equal(store.get().songOrder.length, n0 + 5);
  assert.ok(warns.some((w) => /^Patch packs: \d+ problems/.test(w)));
  const p = ctl.patchPacks();
  assert.equal(p.songs, 7);
  assert.equal(p.packs, 3);
  assert.equal(p.bankSongs, 2);
  const found = searchBank(p.bank, 'mira').map((b) => [b.title, b.artist, b.originalKey, b.inLibrary]);
  assert.deepEqual(found, [['Arbor Song', 'Mira Testwell', 'D', null]]);
  const add = ctl.addFromBank('Hymn Bank:arbor.json');
  assert.ok(add.ok);
  assert.equal(store.get().songs[add.id].tempo, 68);
  assert.equal(ctl.patchPacks().bank.find((b) => b.packId === 'Hymn Bank:arbor.json').inLibrary, add.id);
  assert.equal(ctl.addFromBank('Hymn Bank:arbor.json').existing, true);
  assert.equal(ctl.addFromBank('Hymn Bank:gone.json').ok, false);
  ctl.dispose();
  store.persistNow();
  const again = makeStore({ storage });
  const n1 = again.get().songOrder.length;
  const second = await controllerOn(`http://127.0.0.1:${port}/`, again);
  assert.deepEqual(second.boot.added, []);
  assert.equal(again.get().songOrder.length, n1);
  second.ctl.dispose();
});

test('controller: no user-patches feature → no list request; without a location it stays off', async () => {
  const p5 = port + 4;
  const seen = [];
  const s5 = createServer({ appDir: path.join(tmp, 'app'), port: p5, userSamples: [noPacks], docsDir: null });
  await s5.listen();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, o) => {
    seen.push(new URL(u).pathname);
    return realFetch(u, o);
  };
  try {
    const store = makeStore();
    const before = JSON.stringify(store.get());
    const { ctl, boot } = await controllerOn(`http://127.0.0.1:${p5}/`, store);
    assert.equal(boot.enabled, false);
    assert.deepEqual(seen, ['/api/health']);
    assert.equal(JSON.stringify(store.get()), before, 'no change for a library without packs');
    assert.equal(ctl.patchPacks().enabled, false);
    ctl.dispose();
  } finally {
    globalThis.fetch = realFetch;
    await s5.close();
  }
  // no location at all (node): no request, disabled
  const store = makeStore();
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const ctl = newController(store, midi);
  await ctl.start();
  assert.equal((await ctl.packsReady).enabled, false);
  ctl.dispose();
  assert.ok(FACTORY_SONGS.length > 0);
});

// ------------------------------------------------------------------------------------------ skeptic (O-AW-PP review)
test('skeptic PP-1: a Rescan that updates the selected song in place moves its Revert snapshot along', async () => {
  const root = path.join(tmp, 'pp1');
  const file = path.join(root, 'Rebase Pack', 'songs', 'arbor.json');
  write(file, exportOf(song('Arbor Song', { tempo: 70 })));
  const p6 = port + 6;
  const s6 = createServer({ appDir: path.join(tmp, 'app'), port: p6, userSamples: [root], docsDir: null });
  await s6.listen();
  try {
    const store = makeStore({ debounceMs: 0 });
    const { ctl, boot } = await controllerOn(`http://127.0.0.1:${p6}/`, store);
    const [id] = boot.added;
    assert.ok(await ctl.selectSong(id));
    const actions = [];
    ctl.addEventListener('action', (e) => actions.push(e.detail));
    write(file, exportOf(song('Arbor Song', { tempo: 90 })));
    const r = await ctl.rescanPatchPacks();
    assert.deepEqual(r.updated, [id]);
    assert.equal(store.getSong(id).tempo, 90);
    assert.ok(actions.some((a) => a.type === 'packSongsUpdated' && a.ids.includes(id)), 'Perform re-snapshots on it');
    assert.equal(ctl.revertSong(), false, 'nothing to revert: the update is not an edit');
    assert.equal(store.getSong(id).tempo, 90);
    write(file, exportOf(song('Arbor Song', { tempo: 100 })));
    assert.deepEqual((await ctl.rescanPatchPacks()).updated, [id], 'still unedited, so the next version applies');
    ctl.dispose();
  } finally {
    await s6.close();
  }
});

test('skeptic PP-2: an edited song exported back into its pack file is re-recorded (not written), then updates', () => {
  const { s } = storeWithWarns();
  const [id] = s.topUpPacks([entry('P:loop.json', song('Lantern Hymn'), { hash: 'v1' })]).added;
  assert.ok(s.set(`songs.${id}.tempo`, 77)); // an edit here
  const exported = JSON.parse(s.exportSong(id));
  const before = s.get().songs[id];
  const r = s.topUpPacks([entry('P:loop.json', exported.song, { hash: 'v2', schema: exported.schema })]);
  assert.deepEqual([r.updated, r.kept], [[], []]);
  assert.equal(s.get().songs[id], before, 'the song itself is not written');
  assert.equal(s.get().meta.packSongs['P:loop.json'].hash, 'v2');
  const v3 = s.topUpPacks([entry('P:loop.json', { ...exported.song, notes: 'v3' }, { hash: 'v3' })]);
  assert.deepEqual(v3.updated, [id]);
  assert.equal(s.get().songs[id].notes, 'v3');
  // a different edit stays protected
  assert.ok(s.set(`songs.${id}.tempo`, 81));
  assert.deepEqual(s.topUpPacks([entry('P:loop.json', { ...exported.song, notes: 'v4' }, { hash: 'v4' })]).kept,
    ['P:loop.json']);
  assert.equal(s.get().songs[id].tempo, 81);
});

test('skeptic PP-4: bank search folds letters NFD does not split (ø, æ, ß, ł)', () => {
  assert.ok(bankMatches({ title: 'Copper Fields', artist: 'Søren Ærø' }, 'soren AERO'));
  assert.ok(bankMatches({ title: 'Straße' }, 'strasse'));
  assert.ok(bankMatches({ title: 'Łąka' }, 'laka'));
  assert.ok(bankMatches({ title: 'Léa' }, 'LÉA'), 'decomposed input still matches');
});

test('skeptic PP-6: an instrument-only duplicate pack is no patch-pack problem; long names are named', async () => {
  const r1 = path.join(tmp, 'pp6a');
  const r2 = path.join(tmp, 'pp6b');
  write(path.join(r1, 'Same Keys', 'manifest.json'), { instruments: [] });
  write(path.join(r2, 'Same Keys', 'manifest.json'), { instruments: [] });
  write(path.join(r1, 'Songs Here', 'songs', 'a.json'), exportOf(song('Arbor Song')));
  write(path.join(r1, 'Songs Here', 'songs', `${'n'.repeat(241)}.json`), exportOf(song('Long Name')));
  const r = await scanUserPatches([r1, r2]);
  assert.deepEqual(r.patches.map((p) => p.packId), ['Songs Here:a.json']);
  assert.equal(r.errors.some((e) => /Same Keys/.test(e)), false);
  assert.match(r.errors.join('\n'), /file name must be at most 245 characters/);
  assert.equal(await hasUserPatches([r2]), false);
  write(path.join(r2, 'Same Keys', 'songs', 'b.json'), exportOf(song('Copper Fields')));
  const r3 = await scanUserPatches([r1, r2]);
  assert.match(r3.errors.join('\n'), /a pack named "Same Keys" was already found/);
  assert.equal(r3.patches.some((p) => p.pack === 'Same Keys'), false);
});
