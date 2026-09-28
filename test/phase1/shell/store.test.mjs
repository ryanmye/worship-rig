import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, memoryStorage, migrate, FutureSchemaError, STORAGE_KEY, SCHEMA, transposeSemisOf, emptyState } from '../../../app/js/store.js';
import { FACTORY_SONGS } from '../../../app/js/presets.js';
import { makeStore, idGen } from './helpers.mjs';

test('fresh start seeds every factory song once, with a setlist and a current song', () => {
  const s = makeStore();
  const st = s.get();
  assert.equal(s.loadInfo.status, 'fresh');
  assert.equal(st.songOrder.length, FACTORY_SONGS.length);
  assert.equal(st.setlistOrder.length, 1);
  assert.deepEqual(st.setlists[st.setlistOrder[0]].songIds, st.songOrder);
  assert.equal(st.settings.currentSongId, st.songOrder[0]);
  assert.equal(st.songs[st.songOrder[0]].factoryId, 'factory:sunday-pad-piano');
  assert.notEqual(st.songOrder[0], 'factory:sunday-pad-piano', 'copies get new ids');
  assert.deepEqual(s.seedFactory(), [], 'second seed is a no-op');
  assert.equal(s.get().songOrder.length, FACTORY_SONGS.length);
  assert.ok(Object.isFrozen(st) && Object.isFrozen(st.songs[st.songOrder[0]].patch.slots[0]));
});

test('seed state persists and reloads with status ok (no re-seed)', async () => {
  const storage = memoryStorage();
  const a = makeStore({ storage, debounceMs: 0 });
  a.persistNow();
  const b = makeStore({ storage });
  assert.equal(b.loadInfo.status, 'ok');
  assert.equal(b.get().songOrder.length, FACTORY_SONGS.length);
  assert.deepEqual(b.get(), a.get());
});

test('migrate is idempotent and preserves unknown fields at every level', () => {
  const s = makeStore();
  const raw = JSON.parse(JSON.stringify(s.get()));
  const id = raw.songOrder[0];
  raw.futureTop = { x: 1 };
  raw.settings.someNewSetting = 'yes';
  raw.songs[id].color = 'teal';
  raw.songs[id].patch.slots[0].customKnob = 0.4;
  raw.songs[id].patch.fx.reverb.shimmer = 0.2;
  raw.songs[id].drone.extra = true;
  raw.setlists[raw.setlistOrder[0]].date = '2026-10-04';
  const m1 = migrate(raw);
  const m2 = migrate(JSON.parse(JSON.stringify(m1)));
  assert.deepEqual(m2, m1);
  assert.deepEqual(m1.futureTop, { x: 1 });
  assert.equal(m1.settings.someNewSetting, 'yes');
  assert.equal(m1.songs[id].color, 'teal');
  assert.equal(m1.songs[id].patch.slots[0].customKnob, 0.4);
  assert.equal(m1.songs[id].patch.fx.reverb.shimmer, 0.2);
  assert.equal(m1.songs[id].drone.extra, true);
  assert.equal(m1.setlists[raw.setlistOrder[0]].date, '2026-10-04');
});

test('migrate fills defaults, clamps, drops dangling ids, and is idempotent on messy input', () => {
  const raw = {
    songs: {
      a: { name: 'A', patch: { slots: [{ instrument: { type: 'sampler', id: 'salamander-piano' }, gain: 9, lowNote: 90, highNote: 20 }, { instrument: { type: 'bogus', id: 'x' } }] }, playIn: 14, tempo: 1000 },
      b: 'not a song',
    },
    setlists: { s1: { name: 'S', songIds: ['a', 'zzz', 'a'] } },
    settings: { latency: 'ultra', currentSongId: 'zzz', view: 'edit' },
  };
  const m = migrate(raw);
  assert.deepEqual(Object.keys(m.songs), ['a']);
  const a = m.songs.a;
  assert.equal(a.patch.slots[0].gain, 2);
  assert.equal(a.patch.slots[0].lowNote, 20);
  assert.equal(a.patch.slots[0].highNote, 90);
  assert.equal(a.patch.slots[1], null);
  assert.equal(a.patch.slots.length, 4);
  assert.equal(a.playIn, 2);
  assert.equal(a.hearIn, 2);
  assert.equal(a.tempo, 300);
  assert.equal(a.patch.modWheel.target, 'slots.1.gain');
  assert.deepEqual(m.setlists.s1.songIds, ['a', 'a']);
  assert.equal(m.settings.latency, 'lowest');
  assert.equal(m.settings.view, 'edit');
  assert.equal(m.settings.currentSongId, 'a');
  assert.equal(m.settings.currentSetlistId, 's1');
  assert.equal(m.schema, SCHEMA);
  assert.deepEqual(migrate(JSON.parse(JSON.stringify(m))), m);
});

test('future schema is refused: raw string backed up, app starts fresh', () => {
  const future = JSON.stringify({ schema: SCHEMA + 1, songs: { x: { name: 'From the future' } } });
  const storage = memoryStorage({ [STORAGE_KEY]: future });
  assert.throws(() => migrate(JSON.parse(future)), FutureSchemaError);
  const s = createStore({ storage, now: () => 1234, idGen: idGen(), warn: () => {}, requestIdle: null, autoFlush: false });
  assert.equal(s.loadInfo.status, 'future-schema');
  assert.equal(s.loadInfo.backupKey, `${STORAGE_KEY}.backup-1234`);
  assert.equal(storage.getItem(`${STORAGE_KEY}.backup-1234`), future, 'raw string kept byte-for-byte');
  assert.equal(s.get().songOrder.length, FACTORY_SONGS.length);
});

test('corrupt storage → factory reset with backup', () => {
  const storage = memoryStorage({ [STORAGE_KEY]: '{"songs": [unterminated' });
  const s = createStore({ storage, now: () => 99, idGen: idGen(), warn: () => {}, requestIdle: null, autoFlush: false });
  assert.equal(s.loadInfo.status, 'corrupt');
  assert.equal(storage.getItem(`${STORAGE_KEY}.backup-99`), '{"songs": [unterminated');
  assert.equal(s.get().songOrder.length, FACTORY_SONGS.length);
  const s2 = createStore({ storage: memoryStorage({ [STORAGE_KEY]: '42' }), now: () => 5, idGen: idGen(), warn: () => {}, requestIdle: null, autoFlush: false });
  assert.equal(s2.loadInfo.status, 'corrupt');
});

test('persist is debounced and writes the whole state', async () => {
  const storage = memoryStorage();
  const s = makeStore({ storage, debounceMs: 20 });
  s.set('slots.0.gain', 0.5);
  s.set('slots.0.gain', 0.6);
  assert.equal(storage.getItem(STORAGE_KEY), null, 'not written synchronously');
  await new Promise((r) => setTimeout(r, 60));
  const saved = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(saved.songs[saved.settings.currentSongId].patch.slots[0].gain, 0.6);
  assert.equal(saved.schema, 1);
});

test('set(): current-song param grammar, clamping, canonical changed paths, batching', async () => {
  const s = makeStore();
  const cur = s.get().settings.currentSongId;
  const batches = [];
  s.subscribe((state, paths) => batches.push(paths));
  assert.equal(s.set('slots.1.gain', 3), true);
  assert.equal(s.set('fx.reverb.size', 0.9), true);
  assert.equal(s.set('master.volume', 0.4), true);
  assert.equal(s.set('drone.gain', 0.2), true);
  assert.equal(s.set('slots.0.params.tone', 0.25), true);
  assert.equal(s.set('slots.1.gain', 2), false, 'same value → no change');
  assert.equal(batches.length, 0, 'notifications are batched per microtask');
  await Promise.resolve();
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], [
    `songs.${cur}.patch.slots.1.gain`,
    `songs.${cur}.patch.fx.reverb.size`,
    `songs.${cur}.patch.fx.master.volume`,
    `songs.${cur}.drone.gain`,
    `songs.${cur}.patch.slots.0.params.tone`,
  ]);
  const song = s.currentSong();
  assert.equal(song.patch.slots[1].gain, 2);
  assert.equal(song.patch.fx.master.volume, 0.4);
  assert.equal(song.drone.gain, 0.2);
  assert.equal(song.patch.slots[0].params.tone, 0.25);
  // rejections
  assert.equal(s.set('slots.2.gain', 1), false, 'empty slot');
  assert.equal(s.set('nope.path', 1), false);
  assert.equal(s.set('settings.latency', 'ultra'), false);
  assert.equal(s.set(`songs.${cur}.id`, 'x'), false);
  assert.equal(s.set('songs.missing.name', 'x'), false);
  assert.equal(s.set('song.patch.modWheel.target', 'slots.9.gain'), false);
  assert.equal(s.set('song.patch.modWheel.target', 'macro.wash'), true);
  assert.equal(s.set('song.patch.bend.mode', 'tape'), true);
  assert.equal(s.set('song.hearIn', 14), true);
  assert.equal(s.currentSong().hearIn, 2);
});

test('set(): entity paths for songs/settings/setlists and instrument change resets params', () => {
  const s = makeStore();
  const [a, b] = s.get().songOrder;
  assert.ok(s.set(`songs.${b}.name`, 'Renamed'));
  assert.equal(s.getSong(b).name, 'Renamed');
  assert.ok(s.set('settings.latency', 'safe'));
  assert.ok(s.set('settings.pedalInvert', true));
  assert.ok(s.set(`songs.${a}.patch.slots.0.params.tone`, 0.3));
  assert.ok(s.set(`songs.${a}.patch.slots.0.instrument`, { type: 'sampler', id: 'ep-rhodes' }));
  assert.deepEqual(s.getSong(a).patch.slots[0].params, {}, 'instrument-specific params reset');
  assert.equal(s.getSong(a).patch.slots[0].gain, 0.8, 'other slot settings kept');
  assert.ok(s.set(`songs.${a}.patch.slots.2`, { instrument: { type: 'synth', id: 'bell' } }));
  assert.equal(s.getSong(a).patch.slots[2].sends.delay, 0.2, 'Extra role defaults');
  assert.ok(s.set(`songs.${a}.patch.slots.2`, null));
  assert.equal(s.getSong(a).patch.slots[2], null);
  const sl = s.get().setlistOrder[0];
  assert.ok(s.set(`setlists.${sl}.songIds`, [b, a, 'ghost']));
  assert.deepEqual(s.get().setlists[sl].songIds, [b, a]);
  assert.ok(s.setMidiLearn('slots.1.gain', { cc: 20, channel: 0 }));
  assert.deepEqual(s.get().settings.midiLearn['slots.1.gain'], { cc: 20, channel: 0 });
  assert.ok(s.setMidiLearn('slots.1.gain', null));
  assert.deepEqual(s.get().settings.midiLearn, {});
});

test('update() validates, diffs and notifies', async () => {
  const s = makeStore();
  const id = s.get().songOrder[2];
  let got = null;
  s.subscribe((st, paths) => (got = paths));
  assert.ok(s.update((d) => { d.songs[id].name = 'X'; d.songs[id].patch.slots[1].gain = 7; }));
  await Promise.resolve();
  assert.deepEqual(got.sort(), [`songs.${id}.name`, `songs.${id}.patch.slots.1.gain`].sort());
  assert.equal(s.getSong(id).patch.slots[1].gain, 2);
  assert.equal(s.update(() => {}), false);
});

test('Song.transposeSemis = music.transposeSemis + 12·octave', () => {
  assert.equal(transposeSemisOf({ playIn: 0, hearIn: 2, transposeOctave: 0 }), 2);
  assert.equal(transposeSemisOf({ playIn: 0, hearIn: 10, transposeOctave: 0 }), -2);
  assert.equal(transposeSemisOf({ playIn: 0, hearIn: 6, transposeOctave: 0 }), -6);
  assert.equal(transposeSemisOf({ playIn: 7, hearIn: 0, transposeOctave: 1 }), 17);
  const s = makeStore();
  s.set('song.playIn', 7);
  s.set('song.hearIn', 9);
  assert.equal(s.transposeSemisOf(s.currentSong()), 2);
});

test('setlist navigation: next/prev, index with repeats, move/add/remove, current setlist switch', () => {
  const s = makeStore();
  const ids = s.get().songOrder;
  const sl = s.get().setlistOrder[0];
  assert.equal(s.currentIndex(), 0);
  assert.equal(s.prev(), null);
  assert.equal(s.next(), ids[1]);
  const last = ids.length - 1;
  s.selectSongId(ids[last]);
  assert.equal(s.next(), null);
  assert.equal(s.prev(), ids[last - 1]);
  // a set with a reprise
  const set2 = s.addSetlist('Sunday', [ids[3], ids[5], ids[3]], { select: true });
  assert.equal(s.get().settings.currentSetlistId, set2);
  assert.equal(s.get().settings.currentSongId, ids[3], 'current song moved into the new setlist');
  s.selectSongId(ids[3], 2);
  assert.equal(s.currentIndex(), 2);
  assert.equal(s.next(), null);
  assert.equal(s.prev(), ids[5]);
  s.selectSongId(ids[3], 0);
  assert.equal(s.next(), ids[5]);
  assert.ok(s.moveSong(set2, 2, 0));
  assert.deepEqual(s.get().setlists[set2].songIds, [ids[3], ids[3], ids[5]]);
  assert.ok(s.removeFromSetlist(set2, 0));
  assert.ok(s.addToSetlist(set2, ids[7], 1));
  assert.deepEqual(s.get().setlists[set2].songIds, [ids[3], ids[7], ids[5]]);
  assert.ok(s.moveSong(null, 0, 3));
  assert.equal(s.get().songOrder[3], ids[0]);
  assert.ok(s.setCurrentSetlist(sl));
  assert.ok(s.deleteSetlist(set2));
  assert.equal(s.get().setlistOrder.length, 1);
});

test('add / duplicate / delete / resetToFactory songs', () => {
  const s = makeStore();
  const ids = s.get().songOrder;
  const sl = s.get().setlistOrder[0];
  const blank = s.addSong();
  assert.equal(s.getSong(blank).name, 'New Song');
  assert.equal(s.get().setlists[sl].songIds.at(-1), blank, 'added to the current setlist');
  const lib = s.addSong(FACTORY_SONGS[4], { setlistId: null });
  assert.equal(s.getSong(lib).factoryId, 'factory:grand-piano');
  assert.ok(!s.get().setlists[sl].songIds.includes(lib));
  const dup = s.duplicateSong(ids[1]);
  assert.equal(s.getSong(dup).name, `${s.getSong(ids[1]).name} (copy)`);
  assert.equal(s.get().songOrder[2], dup);
  assert.equal(s.get().setlists[sl].songIds[2], dup);
  // delete current → neighbour becomes current
  s.selectSongId(ids[1]);
  assert.ok(s.deleteSong(ids[1]));
  assert.equal(s.getSong(ids[1]), null);
  assert.ok(!s.get().setlists[sl].songIds.includes(ids[1]));
  assert.equal(s.get().settings.currentSongId, dup);
  // reset to factory keeps key
  s.set(`songs.${ids[0]}.hearIn`, 5);
  s.set(`songs.${ids[0]}.patch.fx.reverb.size`, 0.1);
  assert.ok(s.resetToFactory(ids[0]));
  assert.equal(s.getSong(ids[0]).patch.fx.reverb.size, FACTORY_SONGS[0].patch.fx.reverb.size);
  assert.equal(s.getSong(ids[0]).hearIn, 5);
  assert.equal(s.resetToFactory(blank), false);
});

test('export/import roundtrip: merge adds copies with new ids; replace restores exactly (device-local kept)', () => {
  const a = makeStore();
  a.set('slots.1.gain', 1.3);
  a.addSetlist('Christmas', a.get().songOrder.slice(0, 3));
  const json = a.exportJSON();
  const doc = JSON.parse(json);
  assert.equal(doc.app, 'worship-rig');
  assert.equal(doc.schema, 1);

  const b = makeStore({ idGen: (p) => `b_${p}_${Math.random().toString(36).slice(2)}` });
  const before = b.get().songOrder.length;
  const r = b.importJSON(json);
  assert.equal(r.ok, true);
  assert.equal(r.songIds.length, FACTORY_SONGS.length);
  assert.equal(b.get().songOrder.length, before + FACTORY_SONGS.length);
  assert.ok(r.songIds.every((id) => !a.get().songs[id]), 'new ids');
  assert.equal(r.setlistIds.length, 2);
  const names = r.setlistIds.map((id) => b.get().setlists[id].name);
  assert.deepEqual(names, ['My Set (imported)', 'Christmas']);
  assert.equal(b.get().setlists[r.setlistIds[1]].songIds.length, 3);
  assert.ok(b.get().setlists[r.setlistIds[1]].songIds.every((id) => r.songIds.includes(id)), 'setlist ids remapped');
  assert.equal(b.getSong(r.songIds[0]).patch.slots[1].gain, 1.3);

  b.set('settings.outputDeviceId', 'usb-interface');
  const r2 = b.importJSON(json, { replace: true });
  assert.equal(r2.ok, true);
  assert.deepEqual(b.get().songs, a.get().songs);
  assert.deepEqual(b.get().setlists, a.get().setlists);
  assert.equal(b.get().settings.outputDeviceId, 'usb-interface');

  // single song export/import
  const one = a.exportSong(a.get().songOrder[3]);
  const r3 = b.importJSON(one);
  assert.equal(r3.ok, true);
  assert.equal(r3.songIds.length, 1);
  assert.equal(b.getSong(r3.songIds[0]).name, a.getSong(a.get().songOrder[3]).name);

  assert.equal(b.importJSON('nope').ok, false);
  assert.equal(b.importJSON(JSON.stringify({ schema: 99, songs: {} })).ok, false);
  assert.match(b.importJSON(JSON.stringify({ schema: 99, songs: {} })).error, /newer version/);
});

test('emptyState + seed:false leaves an empty library', () => {
  const s = makeStore({ seed: false });
  assert.equal(s.get().songOrder.length, 0);
  assert.equal(s.currentSong(), null);
  assert.equal(s.set('slots.0.gain', 1), false);
  assert.equal(emptyState(0).schema, 1);
});
