// D23 (U-MOVE, store + controller): store.insertSlot / store.moveSlot. Everything slot-indexed in the song travels with
// its instrument (the slot itself, scene entries, wheel / pedal / knob targets); MIDI learn stays positional; one write,
// one notification; Revert (a whole-patch write of the snapshot) brings the old order back, scenes included; the
// controller's engine diff ends on the new layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStorage, migrate, normalizeSong } from '../../../app/js/store.js';
import { MAX_SLOTS } from '../../../app/js/shared/params.js';
import { captureScene } from '../../../app/js/shared/scenes.js';
import { createController } from '../../../app/js/controller.js';
import { makeStore, fakeEngine, tick } from './helpers.mjs';

const slot = (id = 'warm-pad', type = 'synth') => ({ instrument: { type, id } });
const inst = (s, id) => s.getSong(id).patch.slots.map((x) => (x ? `${x.instrument.id}@${x.gain}` : null));

/** A 6-slot song with distinct slots (gain, range, sends, EQ, sustain), routed wheels and a scene. */
function sixSlotSong() {
  const s = makeStore();
  const id = s.get().settings.currentSongId;
  s.set('slots.2', slot('soft-keys'));
  s.set('slots.3', slot('warm-pad'));
  s.addSlot(id, slot('soft-keys'));
  s.addSlot(id, slot('warm-pad'));
  for (let i = 0; i < 6; i++) s.set(`slots.${i}.gain`, 0.1 * (i + 1));
  s.set('slots.1.lowNote', 40);
  s.set('slots.1.highNote', 70);
  s.set('slots.1.sends.reverb', 0.77);
  s.set('slots.1.eq.b3.db', 4);
  s.set('slots.1.pan', -0.5);
  s.set(`songs.${id}.patch.modWheel.target`, 'slots.1.gain');
  s.set(`songs.${id}.patch.expression.target`, 'slots.4.gain');
  s.set(`songs.${id}.patch.volume.target`, 'slots.5.gain');
  const sc1 = captureScene(s.getSong(id));
  sc1.slots[1] = { gain: 0.05, muted: true };
  const sc2 = captureScene(s.getSong(id));
  sc2.slots[4] = { gain: 0.9 };
  s.set(`songs.${id}.scenes`, [sc1, sc2]);
  s.setMidiLearn('slots.1.gain', { cc: 20, channel: null });
  s.setMidiLearn('slots.1.sends.reverb', { cc: 21, channel: null });
  s.flush();
  return { s, id };
}

test('moveSlot: the slot and everything slot-indexed travels; the slots between shift by one', () => {
  const { s, id } = sixSlotSong();
  const before = s.getSong(id);
  const learn = structuredClone(s.get().settings.midiLearn);
  assert.ok(s.moveSlot(id, 1, 4)); // 0 1 2 3 4 5 → 0 2 3 4 1 5
  const after = s.getSong(id);
  const order = [0, 2, 3, 4, 1, 5];
  order.forEach((k, j) => assert.deepEqual(after.patch.slots[j], before.patch.slots[k], `slot ${j} = old ${k}`));
  assert.deepEqual([after.patch.slots[4].lowNote, after.patch.slots[4].highNote], [40, 70], 'range travels');
  assert.equal(after.patch.slots[4].sends.reverb, 0.77, 'sends travel');
  assert.equal(after.patch.slots[4].eq.b3.db, 4, 'EQ travels');
  assert.equal(after.patch.modWheel.target, 'slots.4.gain', 'wheel target follows its instrument');
  assert.equal(after.patch.expression.target, 'slots.3.gain', 'a slot shifted down: its target follows');
  assert.equal(after.patch.volume.target, 'slots.5.gain', 'a slot outside the move keeps its target');
  for (let n = 0; n < 2; n++) {
    order.forEach((k, j) => assert.deepEqual(after.scenes[n].slots[j], before.scenes[n].slots[k], `scene ${n}, ${j}`));
  }
  assert.deepEqual(after.scenes[0].slots[4], { gain: 0.05, muted: true });
  assert.deepEqual(s.get().settings.midiLearn, learn, 'MIDI learn is positional (D23): not rewritten');
  // and back the other way (to < from)
  assert.ok(s.moveSlot(id, 4, 1));
  assert.deepEqual(s.getSong(id), before, 'moving it back is the original song exactly');
  // to the ends
  assert.ok(s.moveSlot(id, 5, 0));
  assert.deepEqual(inst(s, id).slice(0, 2), [inst({ getSong: () => before }, id)[5], inst({ getSong: () => before }, id)[0]]);
  assert.equal(s.getSong(id).patch.volume.target, 'slots.0.gain');
});

test('moveSlot: bad arguments and no-ops change nothing; one write, one notification, persisted', async () => {
  const { s, id } = sixSlotSong();
  const before = s.getSong(id);
  for (const [f, t] of [[1, 1], [-1, 2], [0, 6], [6, 0], [1.5, 2], ['1', 2], [undefined, 2], [1, null]]) {
    assert.equal(s.moveSlot(id, f, t), false, `${f} → ${t}`);
  }
  assert.equal(s.moveSlot('nope', 0, 1), false);
  assert.equal(s.getSong(id), before, 'the very same object: nothing written');
  const seen = [];
  s.subscribe((_, paths) => seen.push(paths));
  const maps = [];
  s.onSlotMap((e) => maps.push(e));
  assert.ok(s.moveSlot(id, 0, 2));
  assert.deepEqual(maps, [{ id, order: [1, 2, 0, 3, 4, 5] }], 'the slot map, synchronously');
  assert.equal(seen.length, 0, 'the notification is batched');
  await tick();
  assert.deepEqual(seen, [[`songs.${id}`]], 'one notification, one path');
  // the current-song default id
  assert.ok(s.moveSlot(undefined, 2, 0));
  assert.deepEqual(s.getSong(id), before);
  // persisted, and normalise / migrate leave the moved song as it is
  const storage = memoryStorage();
  const p = makeStore({ storage, debounceMs: 0 });
  const pid = p.get().settings.currentSongId;
  p.addSlot(pid, slot('soft-keys'));
  p.set(`songs.${pid}.patch.modWheel.target`, 'slots.4.gain');
  assert.ok(p.moveSlot(pid, 4, 0));
  p.persistNow();
  const q = makeStore({ storage });
  assert.deepEqual(q.getSong(pid), p.getSong(pid));
  assert.equal(q.getSong(pid).patch.modWheel.target, 'slots.0.gain');
  assert.deepEqual(normalizeSong(structuredClone(p.getSong(pid)), pid), p.getSong(pid));
  assert.deepEqual(migrate(structuredClone(p.get())), p.get(), 'migrate stays idempotent');
});

test('insertSlot: after i, later slots shift up with their targets and scene entries; Duplicate copies', async () => {
  const { s, id } = sixSlotSong();
  const before = s.getSong(id);
  const learn = structuredClone(s.get().settings.midiLearn);
  const seen = [];
  s.subscribe((_, paths) => seen.push(paths));
  // Duplicate of slot 1: a deep copy goes right after it
  assert.equal(s.insertSlot(id, 1, structuredClone(before.patch.slots[1])), 2);
  await tick();
  assert.deepEqual(seen, [[`songs.${id}`]], 'one notification');
  const a = s.getSong(id);
  assert.equal(a.patch.slots.length, 7);
  assert.deepEqual(a.patch.slots[2], before.patch.slots[1], 'the copy is the original, field for field');
  assert.deepEqual(a.patch.slots[1], before.patch.slots[1]);
  for (let j = 3; j < 7; j++) assert.deepEqual(a.patch.slots[j], before.patch.slots[j - 1]);
  assert.equal(a.patch.modWheel.target, 'slots.1.gain', 'a target on the original stays on the original');
  assert.equal(a.patch.expression.target, 'slots.5.gain');
  assert.equal(a.patch.volume.target, 'slots.6.gain');
  assert.equal(a.scenes[0].slots[2], null, 'scenes don’t cover the new slot by default');
  assert.deepEqual(a.scenes[0].slots[1], before.scenes[0].slots[1]);
  assert.deepEqual(a.scenes[1].slots[5], before.scenes[1].slots[4]);
  assert.deepEqual(s.get().settings.midiLearn, learn, 'MIDI learn untouched');
  // scenesFrom: the copy follows the scenes like its original
  assert.equal(s.insertSlot(id, 2, structuredClone(a.patch.slots[2]), { scenesFrom: 1 }), 3);
  assert.deepEqual(s.getSong(id).scenes[0].slots[3], { gain: 0.05, muted: true });
  // an empty slot at the front (-1), and the default (= addSlot)
  assert.equal(s.insertSlot(id, -1), 0);
  assert.equal(s.getSong(id).patch.slots[0], null);
  assert.equal(s.getSong(id).patch.modWheel.target, 'slots.2.gain');
  const n = s.getSong(id).patch.slots.length;
  assert.equal(s.insertSlot(id), n);
  assert.equal(s.getSong(id).patch.slots.length, n + 1);
  assert.deepEqual(migrate(structuredClone(s.get())), s.get(), 'migrate stays idempotent');
});

test('insertSlot: refused when full or with bad arguments (nothing written)', () => {
  const { s, id } = sixSlotSong();
  const before = s.getSong(id);
  for (const after of [-2, 6, 1.5, '1', null]) assert.equal(s.insertSlot(id, after), -1, `after ${after}`);
  assert.equal(s.insertSlot(id, 0, { instrument: { type: 'bogus', id: 'x' } }), -1, 'a bad slot');
  assert.equal(s.insertSlot(id, 0, slot(), { scenesFrom: 6 }), -1, 'scenesFrom must be a slot');
  assert.equal(s.insertSlot('nope', 0), -1);
  assert.equal(s.getSong(id), before);
  while (s.getSong(id).patch.slots.length < MAX_SLOTS) assert.ok(s.insertSlot(id, 0, slot()) === 1);
  const full = s.getSong(id);
  assert.equal(s.insertSlot(id, 0, slot()), -1, '16 is the most');
  assert.equal(s.getSong(id), full);
  assert.equal(full.patch.modWheel.target, `slots.${1 + MAX_SLOTS - 6}.gain`, 'the wheel followed every insert');
});

const SAVED_FIELDS = ['patch', 'drone', 'tempo', 'hearIn', 'playIn', 'transposeOctave', 'minor']; // perform.js
const savedJSON = (s) => JSON.stringify(SAVED_FIELDS.map((k) => s[k]));
/** Perform's Revert (perform.js / v6 perform.js revertSong): write back each saved field that differs. */
function performRevert(s, id, snap) {
  const cur = s.getSong(id);
  for (const k of SAVED_FIELDS) if (JSON.stringify(cur[k]) !== JSON.stringify(snap[k])) s.set(`songs.${id}.${k}`, snap[k]);
}

test('Revert: a reordered song counts as changed; Revert brings back the old order, scenes and targets exactly', () => {
  const { s, id } = sixSlotSong();
  const snap = structuredClone(s.getSong(id)); // Perform's snapshot (a clone, as v6 takes it)
  s.set('slots.0.gain', 0.33); // an edit before the move
  assert.ok(s.moveSlot(id, 1, 5));
  s.set('slots.2.gain', 0.44); // and one after it
  assert.ok(s.insertSlot(id, 5, structuredClone(s.getSong(id).patch.slots[5]), { scenesFrom: 5 }));
  assert.notEqual(savedJSON(s.getSong(id)), savedJSON(snap), 'changed (Perform’s count, Edit’s dots)');
  performRevert(s, id, snap);
  assert.deepEqual(s.getSong(id), snap, 'the song as it was: slots, targets and every scene entry');
  // a move made after the Revert still travels from the restored order
  assert.ok(s.moveSlot(id, 0, 1));
  performRevert(s, id, snap);
  assert.deepEqual(s.getSong(id), snap);
});

test('Revert after removeSlot gets the removed slot’s scene entries back (in memory; the removeSlot precedent)', () => {
  const { s, id } = sixSlotSong();
  const snap = structuredClone(s.getSong(id));
  assert.ok(s.removeSlot(id, 1));
  assert.deepEqual(s.getSong(id).scenes[0].slots[1], snap.scenes[0].slots[2]);
  performRevert(s, id, snap);
  assert.deepEqual(s.getSong(id), snap);
});

test('a positional whole-slots write is not a re-order; a library replace forgets the lineage', () => {
  const { s, id } = sixSlotSong();
  const maps = [];
  s.onSlotMap((e) => maps.push(e));
  const slots = structuredClone(s.getSong(id).patch.slots);
  [slots[0], slots[1]] = [slots[1], slots[0]];
  const scenes = structuredClone(s.getSong(id).scenes);
  assert.ok(s.set(`songs.${id}.patch.slots`, slots), 'Edit-style whole-array write');
  assert.deepEqual(s.getSong(id).scenes, scenes, 'scenes stay positional');
  assert.deepEqual(maps, []);
  // export → replace: the earlier layout is not matched against the imported library
  const text = s.exportJSON ? s.exportJSON() : JSON.stringify(s.get());
  assert.ok(s.moveSlot(id, 2, 3));
  const before = structuredClone(s.getSong(id));
  assert.ok(s.importJSON(text, { replace: true }).ok);
  maps.length = 0;
  assert.ok(s.set(`songs.${id}.patch`, before.patch));
  assert.deepEqual(maps, [], 'no lineage across a library replace');
});

// ---- controller

async function rig({ native = true } = {}) {
  const store = makeStore();
  const engine = fakeEngine();
  if (native) for (const k of ['setPolyphony', 'setVoiceLimit', 'setBufferFrames']) engine[k] = () => {};
  const c = createController({ store, engine, doc: null, nav: null, win: null, rig: null, locks: null, heartbeat: false,
    timers: { setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {} } });
  await c.start();
  await settle();
  return { store, engine, c };
}
const settle = async () => {
  for (let i = 0; i < 4; i++) await tick();
};
const callsOf = (engine, name) => engine.calls.filter((x) => x[0] === name);
const refs = (patch) => patch.slots.map((x) => (x ? `${x.instrument.type}:${x.instrument.id}` : null));

test('controller: a move re-prepares the engine with the new layout (the removeSlot path); routing follows', async () => {
  for (const native of [true, false]) {
    const { store, engine, c } = await rig({ native });
    const id = store.get().settings.currentSongId;
    store.set('slots.2', slot('soft-keys'));
    store.set('song.patch.modWheel.target', 'slots.2.gain');
    await settle();
    const n0 = callsOf(engine, 'prepare').length;
    assert.ok(store.moveSlot(id, 2, 0));
    await settle();
    assert.equal(callsOf(engine, 'prepare').length, n0 + 1, 'one re-prepare (gapless commit; held notes ring out)');
    const p = callsOf(engine, 'prepare').at(-1)[2];
    assert.deepEqual(refs(p), refs(store.getSong(id).patch), 'the engine plays each instrument at its new index');
    assert.ok(callsOf(engine, 'commit').length >= 2);
    assert.equal(callsOf(engine, 'setRouting').at(-1)[1].modWheel.target, 'slots.0.gain', 'the wheel followed');
    c.dispose?.();
  }
});

test('controller: swapping two slots of the same instrument is a param diff per index (no re-prepare)', async () => {
  const { store, engine, c } = await rig();
  const id = store.get().settings.currentSongId;
  store.set('slots.2', slot('warm-pad'));
  store.set('slots.1.gain', 0.2);
  store.set('slots.2.gain', 0.6);
  store.set('slots.2.sends.reverb', 0.9);
  await settle();
  const n0 = callsOf(engine, 'prepare').length;
  engine.clear();
  assert.ok(store.moveSlot(id, 2, 1));
  await settle();
  assert.equal(callsOf(engine, 'prepare').length, 0, 'same instruments at the same indices: no re-prepare');
  assert.ok(n0 > 0);
  const sent = new Map(callsOf(engine, 'setParam').map(([, p, v]) => [p, v]));
  const song = store.getSong(id);
  assert.equal(sent.get('slots.1.gain'), song.patch.slots[1].gain);
  assert.equal(sent.get('slots.2.gain'), song.patch.slots[2].gain);
  assert.equal(sent.get('slots.1.sends.reverb'), 0.9);
  assert.equal(sent.get('slots.2.sends.reverb'), song.patch.slots[2].sends.reverb);
  c.dispose?.();
});

test('controller: a scene’s live level move travels with its instrument; Revert brings the layout back', async () => {
  const { store, engine, c } = await rig();
  const id = store.get().settings.currentSongId;
  const selected = structuredClone(store.getSong(id)); // the controller's Revert snapshot (the song as selected)
  store.set('slots.2', slot('warm-pad'));
  store.set('slots.1.gain', 0.2);
  store.set('slots.2.gain', 0.6);
  await settle();
  assert.ok(c.scenes.save(0)); // scene 1 holds slots 1 and 2 (and plays)
  assert.ok(c.scenes.adjust('slots.1.gain', 0.35), 'a live move on top of the scene (transient)');
  assert.equal(c.scenes.view(store.getSong(id)).patch.slots[1].gain, 0.35);
  engine.clear();
  assert.ok(store.moveSlot(id, 1, 2)); // the 0.35 instrument goes to index 2
  await settle();
  const view = c.scenes.view(store.getSong(id));
  assert.equal(view.patch.slots[2].gain, 0.35, 'the live move followed its instrument');
  assert.equal(view.patch.slots[1].gain, 0.6, 'the other one plays its scene level');
  const sent = new Map(callsOf(engine, 'setParam').map(([, p, v]) => [p, v]));
  assert.equal(sent.get('slots.1.gain'), 0.6, 'the engine diff ends on the new layout');
  assert.equal(sent.get('slots.2.gain'), 0.35);
  // the controller's Revert: the old order, the scene entries with it, the song's own levels
  assert.ok(c.revertSong());
  await settle();
  const back = store.getSong(id);
  assert.deepEqual(back.patch, selected.patch);
  assert.deepEqual(back.scenes[0].slots.slice(1, 3).map(({ sends: _s, ...lvl }) => lvl), [{ gain: 0.2 }, { gain: 0.6 }],
    'scene 1 is back on the old order'); // (D26.1: the entries also hold the sends)
  assert.equal(c.scenes.state().n, null, 'Revert goes back to the song’s own levels (as before D23)');
  c.dispose?.();
});

// ---- U-MOVE skeptic (reviews/U-MOVE-store.md)

test('skeptic F1: a long fader drag after a move does not push the Revert layout out of the lineage', () => {
  let t = 0;
  const s = makeStore({ now: () => t });
  const id = s.get().settings.currentSongId;
  ['soft-keys', 'warm-pad', 'soft-keys', 'warm-pad'].forEach((x, i) => s.set(`slots.${i}`, slot(x)));
  for (let i = 0; i < 4; i++) s.set(`slots.${i}.gain`, 0.1 * (i + 1));
  s.set(`songs.${id}.scenes`, [{ slots: [{ gain: 0.11 }, { gain: 0.22 }, { gain: 0.33 }, { gain: 0.44 }] }]);
  const drag = (i, n) => {
    for (let k = 0; k < n; k++) {
      t += 16; // ~60 writes a second
      s.set(`slots.${i}.gain`, 0.3 + (k % 50) / 100);
    }
    t += 3000;
  };
  // 1. snapshot at song select, a move, then 600 drag writes (≈ 10 s, 2.3 × the history)
  t += 5000;
  let snap = structuredClone(s.getSong(id));
  t += 5000;
  assert.ok(s.moveSlot(id, 0, 3));
  t += 2000;
  drag(1, 600);
  s.set(`songs.${id}.patch`, snap.patch);
  assert.deepEqual(s.getSong(id), snap, 'scenes back on their instruments');
  // 2. a snapshot in the middle of a run (Edit left after some drags), more drags, a move, more drags
  drag(2, 400);
  t += 4000;
  snap = structuredClone(s.getSong(id));
  t += 4000;
  drag(0, 400);
  assert.ok(s.moveSlot(id, 2, 0));
  drag(3, 400);
  s.set(`songs.${id}.patch`, snap.patch);
  assert.deepEqual(s.getSong(id), snap);
  // 3. same clock instant everywhere (a script): the layout right before the move is a run's end, always kept
  const u = makeStore({ now: () => 0 });
  const uid = u.get().settings.currentSongId;
  ['soft-keys', 'warm-pad', 'soft-keys', 'warm-pad'].forEach((x, i) => u.set(`slots.${i}`, slot(x)));
  u.set(`songs.${uid}.scenes`, [{ slots: [{ gain: 0.11 }, { gain: 0.22 }, { gain: 0.33 }, { gain: 0.44 }] }]);
  const usnap = structuredClone(u.getSong(uid));
  assert.ok(u.moveSlot(uid, 1, 2));
  for (let k = 0; k < 700; k++) u.set('slots.0.gain', (k % 90) / 100);
  u.set(`songs.${uid}.patch`, usnap.patch);
  assert.deepEqual(u.getSong(uid), usnap);
});

test('skeptic F2: Revert after a Duplicate at the end cuts the copy’s scene entries (a later add starts empty)', () => {
  const s = makeStore();
  const id = s.get().settings.currentSongId;
  ['soft-keys', 'warm-pad', 'soft-keys', 'warm-pad'].forEach((x, i) => s.set(`slots.${i}`, slot(x)));
  s.set(`songs.${id}.scenes`, [{ slots: [{ gain: 0.11 }, { gain: 0.22 }, { gain: 0.33 }, { gain: 0.44 }] }]);
  const snap = structuredClone(s.getSong(id));
  const maps = [];
  s.onSlotMap((e) => maps.push(e.order));
  assert.equal(s.insertSlot(id, 3, structuredClone(snap.patch.slots[3]), { scenesFrom: 3 }), 4);
  assert.deepEqual(s.getSong(id).scenes[0].slots[4], { gain: 0.44 });
  s.set(`songs.${id}.patch`, snap.patch);
  assert.deepEqual(s.getSong(id), snap, 'the song as it was, scenes included (4 entries)');
  assert.deepEqual(maps.at(-1), [0, 1, 2, 3]);
  assert.equal(s.addSlot(id, slot('warm-pad')), 4);
  assert.equal(s.getSong(id).scenes[0].slots[4] ?? null, null, 'the new slot is not covered by the scene');
  // the 1.x-era path: add, save a scene that covers it, Revert
  const t = makeStore();
  const tid = t.get().settings.currentSongId;
  const tsnap = structuredClone(t.getSong(tid));
  t.addSlot(tid, slot('warm-pad'));
  t.set(`songs.${tid}.scenes`, [captureScene(t.getSong(tid))]);
  t.set(`songs.${tid}.patch`, tsnap.patch);
  assert.equal(t.getSong(tid).scenes[0].slots.length, 4, 'cut to the restored slots, as a reload would');
  t.addSlot(tid, slot('soft-keys'));
  assert.equal(t.getSong(tid).scenes[0].slots[4] ?? null, null);
});

test('skeptic F3: a removed slot’s kept scene entries come back only while the scene count is the same', () => {
  const s = makeStore();
  const id = s.get().settings.currentSongId;
  ['soft-keys', 'warm-pad', 'soft-keys', 'warm-pad'].forEach((x, i) => s.set(`slots.${i}`, slot(x)));
  const two = [{ slots: [{ gain: 0.1 }, { gain: 0.2 }, { gain: 0.3 }, { gain: 0.4 }] },
    { slots: [{ gain: 0.5 }, { gain: 0.6 }, { gain: 0.7 }, { gain: 0.8 }] }];
  s.set(`songs.${id}.scenes`, two);
  const snap = structuredClone(s.getSong(id));
  assert.ok(s.removeSlot(id, 1));
  s.set(`songs.${id}.scenes`, [s.getSong(id).scenes[1]]); // the first scene deleted
  s.set(`songs.${id}.patch`, snap.patch);
  assert.deepEqual(s.getSong(id).scenes, [{ slots: [{ gain: 0.5 }, null, { gain: 0.7 }, { gain: 0.8 }] }],
    'the slot is back uncovered, never with the deleted scene’s level');
  // the same count: the entries come back (the builder's removeSlot + Revert)
  s.set(`songs.${id}.scenes`, two);
  const snap2 = structuredClone(s.getSong(id));
  assert.ok(s.removeSlot(id, 2));
  s.set(`songs.${id}.patch`, snap2.patch);
  assert.deepEqual(s.getSong(id), snap2);
});
