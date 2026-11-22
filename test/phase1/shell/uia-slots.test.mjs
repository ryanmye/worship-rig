// UIA (native DECISIONS D3): store SCHEMA 1 → 2 (1..16 slots per song), slot add / remove, and the controller's
// rule that the web engine (the 1.x oracle) never sees a slot past its 4 while the bridge engine gets all of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createStore, memoryStorage, migrate, normalizeSong, STORAGE_KEY, SCHEMA, isWheelTarget,
} from '../../../app/js/store.js';
import { FACTORY_SONGS } from '../../../app/js/presets.js';
import { MAX_SLOTS, SLOT_COUNT } from '../../../app/js/shared/params.js';
import { captureScene } from '../../../app/js/shared/scenes.js';
import { createController } from '../../../app/js/controller.js';
import { makeStore, fakeEngine, tick } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
/** A real 1.x export (schema 1), made with the store at v2-native 47aa596: every factory song, edits, a scene, mutes. */
const V1_TEXT = fs.readFileSync(path.join(here, 'fixtures/uia/library-1x.json'), 'utf8');
const V1 = JSON.parse(V1_TEXT);
const slot = (id = 'warm-pad', type = 'synth') => ({ instrument: { type, id } });

test('SCHEMA is 2', () => {
  assert.equal(SCHEMA, 2);
  assert.equal(V1.schema, 1);
});

test('every factory song: 4 slots, and 2.0 normalises it exactly as the 1.x store did (the 1.x export)', () => {
  const byFactory = new Map(Object.values(V1.songs).map((s) => [s.factoryId, s]));
  let compared = 0;
  for (const p of FACTORY_SONGS) {
    const n = normalizeSong({ ...structuredClone(p), factoryId: p.id }, 'x');
    assert.equal(n.patch.slots.length, SLOT_COUNT, p.id);
    assert.deepEqual(normalizeSong(n, 'x'), n, `${p.id}: idempotent`);
    assert.deepEqual(normalizeSong(n, 'x', { legacy: true }), n, `${p.id}: schema 1 and 2 agree on a 4-slot song`);
    const old = byFactory.get(p.id);
    if (!old || old.customField || old.scenes || old.patch.slots.some((s) => s && s.muted)) continue; // edited ones
    if (old.patch.slots[2] === null && p.patch.slots[2]) continue;
    const { id: _a, ...mine } = n;
    const { id: _b, ...theirs } = old;
    assert.equal(JSON.stringify(mine), JSON.stringify(theirs), `${p.id}: byte for byte`);
    compared += 1;
  }
  assert.ok(compared >= FACTORY_SONGS.length - 2, `compared ${compared}`);
});

test('a 1.x backup migrates with every song byte for byte unchanged; idempotent; unknown fields kept', () => {
  const m = migrate(structuredClone(V1));
  assert.equal(m.schema, 2);
  assert.deepEqual(Object.keys(m.songs), Object.keys(V1.songs));
  for (const [id, s] of Object.entries(V1.songs)) {
    assert.equal(JSON.stringify(m.songs[id]), JSON.stringify(s), id);
    assert.equal(m.songs[id].patch.slots.length, 4);
  }
  assert.deepEqual(m.setlists, V1.setlists);
  assert.deepEqual(m.songOrder, V1.songOrder);
  assert.deepEqual(migrate(structuredClone(m)), m, 'idempotent');
  assert.deepEqual(migrate(JSON.parse(JSON.stringify(m))), m);
  const edited = Object.values(m.songs).find((s) => s.customField);
  assert.deepEqual(edited.customField, { kept: true });
  assert.equal(edited.patch.slots[2], null, 'an empty slot stays an empty slot');
  assert.equal(edited.patch.expression.target, 'slots.2.gain');
  const withScene = Object.values(m.songs).find((s) => s.scenes);
  assert.equal(withScene.scenes[0].slots.length, 4);
  assert.equal(withScene.patch.modWheel.target, 'slots.3.gain');
});

test('schema 1 keeps exactly 4 slots (padded / cut as 1.x did); schema 2 keeps 1..16; more than 16 are cut', () => {
  const songOf = (schema, slots) => migrate({ schema, songs: { a: { name: 'A', patch: { slots } } } }).songs.a;
  const six = Array.from({ length: 6 }, () => slot());
  assert.equal(songOf(1, six).patch.slots.length, 4);
  assert.equal(songOf(1, [slot()]).patch.slots.length, 4);
  assert.equal(songOf(undefined, six).patch.slots.length, 4, 'a file without a schema reads like 1.x');
  assert.equal(songOf(2, six).patch.slots.length, 6);
  assert.equal(songOf(2, [slot()]).patch.slots.length, 1);
  assert.equal(songOf(2, [null, null]).patch.slots.length, 2);
  assert.equal(songOf(2, []).patch.slots.length, 4, 'no slots = a new song’s 4');
  assert.equal(songOf(2, Array.from({ length: 20 }, () => slot())).patch.slots.length, MAX_SLOTS);
  const s6 = songOf(2, six);
  assert.equal(s6.patch.slots[5].sends.reverb, 0.35, 'Sound 6 takes Extra’s defaults');
  assert.deepEqual(migrate(structuredClone({ schema: 2, songs: { a: s6 } })).songs.a, s6, 'idempotent');
});

test('the store loads a 1.x library: songs unchanged, a copy of the 1.x text kept first, saved back as schema 2', () => {
  const storage = memoryStorage({ [STORAGE_KEY]: V1_TEXT });
  const s = makeStore({ storage, now: () => 4242, debounceMs: 0 });
  assert.equal(s.loadInfo.status, 'ok');
  assert.equal(s.loadInfo.migratedFrom, 1);
  assert.equal(s.loadInfo.migrationBackupKey, `${STORAGE_KEY}.backup-4242`);
  assert.equal(storage.getItem(`${STORAGE_KEY}.backup-4242`), V1_TEXT, 'the 1.x text byte for byte');
  for (const [id, song] of Object.entries(V1.songs)) assert.equal(JSON.stringify(s.getSong(id)), JSON.stringify(song));
  s.set('settings.view', 'edit');
  s.persistNow();
  const saved = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(saved.schema, 2);
  const again = makeStore({ storage, now: () => 5000 });
  assert.equal(again.loadInfo.migratedFrom, undefined, 'a schema-2 library is not backed up again');
  assert.equal(storage.getItem(`${STORAGE_KEY}.backup-5000`), null);
  // an empty 1.x library (a fresh profile, a test's pinned theme) is not worth a copy
  const st2 = memoryStorage({ [STORAGE_KEY]: JSON.stringify({ schema: 1, songs: {}, settings: { theme: 'classic' } }) });
  makeStore({ storage: st2, now: () => 7 });
  assert.equal(st2.getItem(`${STORAGE_KEY}.backup-7`), null);
});

test('a 2.0 song file keeps its slots; a 1.x one keeps 4; a newer schema is refused', () => {
  const s = makeStore();
  const song = { name: 'Wide', patch: { slots: Array.from({ length: 7 }, (_, i) => (i % 2 ? slot() : null)) } };
  const r = s.importJSON(JSON.stringify({ app: 'worship-rig', kind: 'song', schema: 2, song }));
  assert.ok(r.ok);
  assert.equal(s.getSong(r.songIds[0]).patch.slots.length, 7);
  const r1 = s.importJSON(JSON.stringify({ app: 'worship-rig', kind: 'song', schema: 1, song }));
  assert.equal(s.getSong(r1.songIds[0]).patch.slots.length, 4);
  const rf = s.importJSON(JSON.stringify({ app: 'worship-rig', kind: 'song', schema: 3, song }));
  assert.equal(rf.ok, false);
  // export → import round trip of a 16-slot library
  const id = s.addSong({ name: 'Sixteen', patch: { slots: Array.from({ length: 16 }, () => slot()) } });
  const lib = JSON.parse(s.exportJSON());
  assert.equal(lib.schema, 2);
  assert.equal(lib.songs[id].patch.slots.length, 16);
  const s2 = makeStore();
  assert.ok(s2.importJSON(JSON.stringify(lib), { replace: true }).ok);
  assert.deepEqual(s2.getSong(id), s.getSong(id));
});

test('addSlot: appends an empty slot or a Slot with that slot’s role defaults; at most 16', async () => {
  const s = makeStore();
  const id = s.get().settings.currentSongId;
  const seen = [];
  s.subscribe((_, paths) => seen.push(...paths));
  assert.equal(s.addSlot(id), 4);
  assert.equal(s.getSong(id).patch.slots.length, 5);
  assert.equal(s.getSong(id).patch.slots[4], null);
  await tick();
  assert.ok(seen.includes(`songs.${id}.patch.slots`));
  assert.equal(s.addSlot(id, slot('soft-keys')), 5);
  const s5 = s.getSong(id).patch.slots[5];
  assert.deepEqual([s5.instrument.id, s5.gain, s5.sends.reverb, s5.mono], ['soft-keys', 0.8, 0.35, 'off']);
  assert.equal(s.addSlot(id, { instrument: { type: 'bogus', id: 'x' } }), -1);
  assert.equal(s.addSlot('nope'), -1);
  while (s.getSong(id).patch.slots.length < MAX_SLOTS) assert.ok(s.addSlot(id) > 0);
  assert.equal(s.addSlot(id), -1, '16 is the most');
  // the new slots are addressable through the §4 grammar and the current-song aliases
  assert.ok(s.set('slots.15', slot()));
  assert.ok(s.set('slots.15.gain', 0.3));
  assert.equal(s.getSong(id).patch.slots[15].gain, 0.3);
  assert.ok(s.set('slots.15.eq.b3.db', 3));
  assert.ok(s.set('slots.15.muted', true));
  assert.ok(s.set('slots.15.instrument', { type: 'synth', id: 'soft-keys' }));
  assert.equal(s.set('slots.16.gain', 0.3), false);
  assert.ok(s.set('song.patch.modWheel.target', 'slots.15.gain'));
});

test('slot paths stop at the song’s own slot count', () => {
  const s = makeStore();
  const id = s.get().settings.currentSongId;
  assert.equal(s.set('slots.4.gain', 0.5), false, 'a 4-slot song has no slot 4');
  assert.equal(s.set('slots.4', slot()), false);
  assert.equal(s.set(`songs.${id}.patch.modWheel.target`, 'slots.4.gain'), false);
  assert.equal(isWheelTarget('slots.3.gain'), true);
  assert.equal(isWheelTarget('slots.4.gain'), false);
  assert.equal(isWheelTarget('slots.4.gain', 5), true);
  assert.equal(isWheelTarget('macro.wash', 1), true);
  s.addSlot(id, slot());
  assert.ok(s.set('slots.4.gain', 0.5));
  assert.ok(s.set(`songs.${id}.patch.modWheel.target`, 'slots.4.gain'));
});

test('removeSlot: later slots move down, wheel targets and scenes follow, at least one slot stays', () => {
  const s = makeStore();
  const id = s.get().settings.currentSongId;
  for (let i = 0; i < 3; i++) s.addSlot(id, slot(i % 2 ? 'warm-pad' : 'soft-keys'));
  assert.equal(s.getSong(id).patch.slots.length, 7);
  s.set(`songs.${id}.patch.modWheel.target`, 'slots.5.gain');
  s.set(`songs.${id}.patch.expression.target`, 'slots.4.gain');
  s.set(`songs.${id}.patch.volume.target`, 'slots.6.gain');
  const live = s.getSong(id);
  const sc = captureScene(live);
  assert.equal(sc.slots.length, 7);
  s.set(`songs.${id}.scenes`, [sc]);
  const sixth = s.getSong(id).patch.slots[5];
  assert.ok(s.removeSlot(id, 4));
  const after = s.getSong(id);
  assert.equal(after.patch.slots.length, 6);
  assert.deepEqual(after.patch.slots[4], sixth, 'slot 5 moved to 4');
  assert.equal(after.patch.modWheel.target, 'slots.4.gain', 'follows its slot');
  assert.equal(after.patch.volume.target, 'slots.5.gain');
  assert.equal(after.patch.expression.target, 'slots.1.gain', 'the removed slot’s target → the default');
  assert.equal(after.scenes[0].slots.length, 6);
  assert.deepEqual(after.scenes[0].slots[4], sc.slots[5]);
  // default: the last slot; never the only one
  assert.ok(s.removeSlot(id));
  assert.equal(s.getSong(id).patch.slots.length, 5);
  while (s.getSong(id).patch.slots.length > 1) assert.ok(s.removeSlot(id));
  assert.equal(s.removeSlot(id), false, 'one slot stays');
  assert.equal(s.getSong(id).patch.modWheel.target, 'none', 'a 1-slot song has no Pad level to fall back to');
  assert.equal(s.removeSlot(id, 3), false);
  assert.equal(s.removeSlot('nope'), false);
  assert.deepEqual(migrate(structuredClone(s.get())), s.get(), 'still idempotent');
});

test('a whole slots array changes the count; the wheel targets are re-checked with it', () => {
  const s = makeStore();
  const id = s.get().settings.currentSongId;
  s.addSlot(id, slot());
  s.set(`songs.${id}.patch.modWheel.target`, 'slots.4.gain');
  assert.ok(s.set(`songs.${id}.patch.slots`, s.getSong(id).patch.slots.slice(0, 3)));
  assert.equal(s.getSong(id).patch.slots.length, 3);
  assert.equal(s.getSong(id).patch.modWheel.target, 'slots.1.gain');
});

/** A controller over a fake engine; `native` adds the 2.0 setters the bridge engine has. */
async function rig({ native = false } = {}) {
  const store = makeStore();
  const engine = fakeEngine();
  if (native) for (const k of ['setPolyphony', 'setVoiceLimit', 'setBufferFrames']) engine[k] = () => {};
  const c = createController({ store, engine, doc: null, nav: null, win: null, rig: null, locks: null, heartbeat: false,
    timers: { setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {} } });
  await c.start();
  await tick();
  await tick();
  return { store, engine, c };
}
const callsOf = (engine, name) => engine.calls.filter((x) => x[0] === name);

test('controller, web engine: a 4-slot song is passed through as it is; slots past 4 never reach the engine', async () => {
  const { store, engine, c } = await rig();
  assert.equal(c.engineSlots(), 4);
  const id = store.get().settings.currentSongId;
  const prep = callsOf(engine, 'prepare').at(-1);
  assert.equal(prep[2], store.getSong(id).patch, 'the very same patch object (byte-for-byte 1.x behaviour)');
  store.addSlot(id, slot());
  store.addSlot(id, slot('soft-keys'));
  await tick();
  await tick();
  const n0 = callsOf(engine, 'prepare').length;
  store.set('slots.5.gain', 0.2);
  store.set('slots.4.sends.reverb', 0.9);
  store.set('song.patch.modWheel.target', 'slots.5.gain');
  await tick();
  await tick();
  assert.equal(callsOf(engine, 'prepare').length, n0, 'adding slots past 4 is no structural change here');
  for (const [, p] of callsOf(engine, 'setParam')) assert.ok(!/^slots\.([4-9]|1\d)\./.test(p), p);
  const r = callsOf(engine, 'setRouting').at(-1)[1];
  assert.equal(r.modWheel.target, 'none', 'a wheel on a silent slot drives nothing on the web engine');
  // a new instrument on slot 0 re-prepares with the first 4 slots only
  store.set('slots.0.instrument', { type: 'synth', id: 'soft-keys' });
  await tick();
  await tick();
  const p = callsOf(engine, 'prepare').at(-1)[2];
  assert.equal(p.slots.length, 4);
  assert.equal(p.modWheel.target, 'none');
  assert.equal(c.slotLevel(5), null);
  assert.ok(store.setMidiLearn('slots.5.gain', { cc: 20, channel: null }), 'a slot past 4 is a learn target');
  c.dispose?.();
});

test('controller, bridge engine: every slot is sent (prepare, setParam, routing)', async () => {
  const { store, engine, c } = await rig({ native: true });
  assert.equal(c.engineSlots(), 16);
  const id = store.get().settings.currentSongId;
  for (let i = 4; i < 16; i++) store.addSlot(id, slot(i % 2 ? 'warm-pad' : 'soft-keys'));
  await tick();
  await tick();
  await new Promise((r) => setTimeout(r, 10));
  const p = callsOf(engine, 'prepare').at(-1)[2];
  assert.equal(p.slots.length, 16);
  store.set('slots.15.gain', 0.25);
  store.set('song.patch.modWheel.target', 'slots.15.gain');
  await tick();
  await tick();
  assert.ok(callsOf(engine, 'setParam').some(([, path, v]) => path === 'slots.15.gain' && v === 0.25));
  assert.equal(callsOf(engine, 'setRouting').at(-1)[1].modWheel.target, 'slots.15.gain');
  // scenes cover slot 16 too
  assert.ok(c.scenes.save(0)); // scene 1 holds Sound 16 at 0.25 (and now plays)
  assert.ok(c.scenes.go(null));
  store.set('slots.15.gain', 0.9); // the song's own level
  await tick();
  const glides = () => callsOf(engine, 'setParam').filter(([, path, , o]) => path === 'slots.15.gain' && o?.glide);
  const n = glides().length;
  assert.ok(c.scenes.go(0));
  assert.deepEqual(glides().slice(n).map((x) => x[2]), [0.25], 'scene 1 glides Sound 16 back to 0.25');
  c.dispose?.();
});

test('a learned MIDI fader on Sound 6 moves that slot of the song (pickup); a song without it ignores it', async () => {
  const { MidiInput } = await import('../../../app/js/midi.js');
  const { fakeDoc, fakeTimers } = await import('./helpers.mjs');
  const store = makeStore();
  const engine = fakeEngine();
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const c = createController({ store, engine, midi, doc: fakeDoc(), nav: null, win: new EventTarget(), rig: null,
    timers: fakeTimers(), now: () => 0 });
  await c.start();
  const id = store.get().settings.currentSongId;
  store.setMidiLearn('slots.5.gain', { cc: 21, channel: null });
  midi._inject([0xb0, 21, 127]); // a 4-slot song: nothing to move, nothing written
  assert.equal(store.getSong(id).patch.slots.length, 4);
  store.addSlot(id, slot());
  store.addSlot(id, slot('soft-keys'));
  store.set('slots.5.gain', 0.25); // fader position 0.5
  await tick();
  midi._inject([0xb0, 21, 64]); // ≈ 0.504: picks up
  midi._inject([0xb0, 21, 100]);
  await tick();
  assert.ok(Math.abs(store.getSong(id).patch.slots[5].gain - 2 * (100 / 127) ** 3) < 1e-9);
  for (const [, p] of callsOf(engine, 'setParam')) assert.ok(!p.startsWith('slots.5.'), 'the web engine hears nothing');
  c.dispose?.();
});
