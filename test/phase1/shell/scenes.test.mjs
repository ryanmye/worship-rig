// v11-scenes: song scenes through store → controller → (fake) engine. The stored field (optional, whole writes,
// migrate idempotent), saving what plays, stepping (glide on every changed level, held notes / drone / song switch
// untouched), live moves on top of a scene, the learned footswitch (a CC button), the bus commands and the state's
// optional `scene`, Revert and a song switch going back to the song's own levels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { migrate } from '../../../app/js/store.js';
import { SCENE_GLIDE_SEC } from '../../../app/js/shared/scenes.js';
import { stateError } from '../../../app/js/shared/bus.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

async function setup() {
  const store = makeStore();
  const engine = fakeEngine();
  let wheel = 1;
  engine.wheelValues = () => ({ mod: wheel, expr: 1, vol: 1 });
  engine.setWheel = (src, v, o) => {
    engine.calls.push(o === undefined ? ['setWheel', src, v] : ['setWheel', src, v, o]);
    if (src === 'virtual') wheel = v;
  };
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {}; // skip init() in start()
  const ctl = createController({ store, engine, midi, recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(),
    rig: null, timers: fakeTimers(), now: () => 0 });
  await ctl.start();
  await tick();
  return { store, engine, midi, ctl };
}
const sid = (store) => store.currentSong().id;
const glides = (engine) => engine.of('setParam').filter((c) => c[3] && c[3].glide);
/** Engine calls that would cut a note, the drone or switch the song (a scene change must make none of them). */
const CUTS = ['allNotesOff', 'noteOff', 'prepare', 'commit', 'drone.configure', 'drone.setKey', 'fadeOutAll', 'sustain'];

test('store: song.scenes is optional, written whole, normalised, and migrate stays idempotent', () => {
  const store = makeStore();
  const id = sid(store);
  assert.equal('scenes' in store.currentSong(), false, 'absent until a scene is saved');
  assert.equal(store.set(`songs.${id}.scenes`, [{ slots: [{ gain: 5 }, null, null, null], wheel: 2, junk: 1 }]), true);
  assert.deepEqual(store.currentSong().scenes, [{ slots: [{ gain: 2 }, null, null, null], wheel: 1 }]);
  assert.equal(store.set(`songs.${id}.scenes.0.wheel`, 0.5), false, 'no nested writes');
  assert.equal(store.set(`songs.${id}.scenes`, 'x'), false);
  assert.equal(store.set(`songs.${id}.scenes`, []), true, 'empty list → the field goes');
  assert.equal('scenes' in store.currentSong(), false);
  store.set(`songs.${id}.scenes`, [{ slots: [{ gain: 0.5, muted: true }] }]);
  assert.equal(store.set(`songs.${id}.scenes`, null), true);
  assert.equal('scenes' in store.currentSong(), false);
  // migrate: kept, junk dropped, idempotent; a song with an unusable list loses the field
  const raw = { schema: 1, songs: { a: { name: 'A', scenes: [{ slots: [{ gain: 0.4 }] }, { nope: 1 }] }, b: { name: 'B', scenes: [] } } };
  const once = migrate(raw);
  assert.deepEqual(once.songs.a.scenes, [{ slots: [{ gain: 0.4 }, null, null, null] }]);
  assert.equal('scenes' in once.songs.b, false);
  assert.deepEqual(migrate(once), once);
});

test('save → step: levels glide (SCENE_GLIDE_SEC), the wheel glides, nothing cuts a note; the song stays as saved', async () => {
  const { store, engine, ctl } = await setup();
  const id = sid(store);
  const base = store.currentSong();
  assert.deepEqual(ctl.scenes.state(), { id, n: null, count: 0 });
  assert.equal(ctl.scenes.next(), false, 'no scenes: a footswitch press does nothing');
  assert.equal(ctl.scenes.save(0), true);
  assert.deepEqual(ctl.scenes.state(), { id, n: 0, count: 1 }, 'the saved scene plays');
  ctl.perform.noteOn(60, 100); // a held note must survive every scene change
  // a live move in scene 1 is heard now (no glide), held on top of the scene: song and scene 1 stay as saved
  engine.clear();
  assert.equal(ctl.scenes.adjust('slots.0.gain', 0.2), true);
  assert.deepEqual(engine.of('setParam'), [['setParam', 'slots.0.gain', 0.2]]);
  assert.equal(store.currentSong().patch.slots[0].gain, base.patch.slots[0].gain, 'the song’s own level is untouched');
  assert.equal(store.currentSong().scenes[0].slots[0].gain, base.patch.slots[0].gain, 'scene 1 is untouched');
  assert.equal(ctl.scenes.adjust('slots.1.muted', true), true);
  assert.equal(ctl.scenes.view(store.currentSong()).patch.slots[1].muted, true, 'view = what is heard');
  ctl.perform.wheel(0.3);
  assert.equal(ctl.scenes.save(1), true, 'Save as scene 2 keeps the moves');
  assert.deepEqual(store.currentSong().scenes[1].slots.slice(0, 2), [{ gain: 0.2 }, { gain: base.patch.slots[1].gain, muted: true }]);
  assert.equal(store.currentSong().scenes[1].wheel, 0.3, 'the wheel (the song routes it)');
  await tick();
  // step back to scene 1: every changed level glides, the wheel glides back
  engine.clear();
  assert.equal(ctl.scenes.prev(), true);
  assert.deepEqual(ctl.scenes.state().n, 0);
  const g = glides(engine);
  assert.deepEqual(g.map((c) => c[1]).sort(), ['slots.0.gain', 'slots.1.gain']);
  assert.ok(g.every((c) => c[3].glide === SCENE_GLIDE_SEC));
  assert.deepEqual(g.find((c) => c[1] === 'slots.1.gain')[2], base.patch.slots[1].gain, 'unmuted again at its level');
  assert.deepEqual(engine.of('setWheel'), [['setWheel', 'virtual', store.currentSong().scenes[0].wheel,
    { glide: SCENE_GLIDE_SEC }]]);
  assert.deepEqual(engine.names().filter((n) => CUTS.includes(n)), [], 'no cut, no switch');
  // footswitch cycle: 1 → 2 → 1 (wraps); previous from 1 → the song's own levels, which equal scene 1 here
  ctl.scenes.next();
  assert.equal(ctl.scenes.state().n, 1);
  ctl.scenes.next();
  assert.equal(ctl.scenes.state().n, 0, 'wraps to scene 1');
  engine.clear();
  ctl.scenes.prev();
  assert.equal(ctl.scenes.state().n, null);
  assert.deepEqual(glides(engine), [], 'scene 1 = the own levels: nothing to move');
  assert.deepEqual(engine.names().filter((n) => CUTS.includes(n)), []);
  assert.equal(ctl._debug().held.length, 1, 'the note is still held');
  assert.equal(store.currentSong().patch, base.patch, 'stepping never wrote the song');
});

test('a learned footswitch (CC button, press-only too) steps the scenes; bus commands and the published state', async () => {
  const { store, engine, midi, ctl } = await setup();
  const id = sid(store);
  ctl.scenes.save(0);
  ctl.scenes.adjust('slots.0.gain', 0.1);
  ctl.scenes.save(1);
  ctl.scenes.go(null);
  store.setMidiLearn('nextScene', { cc: 85, channel: 0 });
  store.setMidiLearn('prevScene', { cc: 86, channel: 0 });
  await tick();
  engine.clear();
  midi._inject([0xb0, 85, 127]);
  assert.equal(ctl.scenes.state().n, 0);
  midi._inject([0xb0, 85, 127]); // held: no repeat
  assert.equal(ctl.scenes.state().n, 0);
  midi._inject([0xb0, 85, 0]);
  midi._inject([0xb0, 85, 127]);
  assert.equal(ctl.scenes.state().n, 1);
  assert.ok(glides(engine).some((c) => c[1] === 'slots.0.gain' && Math.abs(c[2] - 0.1) < 1e-9));
  midi._inject([0xb0, 86, 127]);
  assert.equal(ctl.scenes.state().n, 0);
  assert.deepEqual(engine.names().filter((n) => n === 'noteOn' || n === 'modWheel'), [], 'the CC is not played');
  // bus: nextScene / prevScene; the state carries {n, count} while the song has scenes
  assert.equal(ctl.handleCommand({ v: 1, type: 'nextScene' }), true);
  assert.equal(ctl.scenes.state().n, 1);
  ctl.handleCommand({ v: 1, type: 'prevScene' });
  ctl.handleCommand({ v: 1, type: 'prevScene' });
  assert.equal(ctl.scenes.state().n, null);
  const st = ctl.menuBarState();
  assert.deepEqual(st.scene, { n: null, count: 2 });
  assert.equal(stateError(st), null);
  assert.notEqual(stateError({ ...st, scene: { n: 5, count: 2 } }), null);
  store.set(`songs.${id}.scenes`, null);
  await tick();
  assert.equal('scene' in ctl.menuBarState(), false, 'no scenes: the field is absent');
});

test('a learned MIDI fader moves the playing scene live (pickup on the level as heard), not the song', async () => {
  const { store, midi, ctl } = await setup();
  ctl.scenes.save(0);
  ctl.scenes.adjust('slots.1.gain', 0.25); // position cbrt(0.125) = 0.5
  store.setMidiLearn('slots.1.gain', { cc: 20, channel: null });
  await tick();
  const own = store.currentSong().patch.slots[1].gain;
  midi._inject([0xb0, 20, 0]); // far below 0.5: not picked up
  assert.equal(ctl.scenes.view(store.currentSong()).patch.slots[1].gain, 0.25);
  midi._inject([0xb0, 20, 90]); // crossed → picked up
  assert.ok(Math.abs(ctl.scenes.view(store.currentSong()).patch.slots[1].gain - 2 * (90 / 127) ** 3) < 1e-9);
  assert.equal(store.currentSong().patch.slots[1].gain, own, 'the song’s own level is untouched');
});

test('Revert and a song switch go back to the song’s own levels; a deleted scene; Edit-style base writes', async () => {
  const { store, engine, ctl } = await setup();
  const id = sid(store);
  ctl.scenes.save(0);
  ctl.scenes.adjust('drone.gain', 0.05);
  ctl.scenes.save(1);
  assert.equal(ctl.scenes.state().n, 1);
  // a base write while a scene plays: the scene keeps the level it holds (no engine write for it)
  engine.clear();
  store.set(`songs.${id}.drone.gain`, 1.5);
  await tick();
  assert.deepEqual(engine.of('setParam').filter((c) => c[1] === 'drone.gain'), []);
  // Revert: the song as selected, and its own levels again
  engine.clear();
  assert.equal(ctl.revertSong(), true);
  await tick();
  assert.equal(ctl.scenes.state().n, null);
  assert.ok(engine.of('setParam').some((c) => c[1] === 'drone.gain'), 'the drone level goes back');
  assert.equal(store.currentSong().scenes.length, 2, 'Revert keeps the saved scenes');
  // delete the playing scene: it glides back first; a later scene moves up
  ctl.scenes.go(1);
  engine.clear();
  assert.equal(ctl.scenes.remove(1), true);
  assert.equal(ctl.scenes.state().n, null);
  assert.ok(glides(engine).some((c) => c[1] === 'drone.gain'));
  assert.equal(store.currentSong().scenes.length, 1);
  // a song switch: the new song starts on its own levels; the old one's scene is forgotten
  ctl.scenes.go(0);
  await ctl.nextSong();
  await tick();
  assert.deepEqual(ctl.scenes.state(), { id: sid(store), n: null, count: 0 });
  await ctl.prevSong();
  await tick();
  assert.deepEqual(ctl.scenes.state(), { id, n: null, count: 1 }, 'back on the first song: its own levels');
});

test('a new instrument mid-scene is prepared with the scene’s levels', async () => {
  const { store, engine, ctl } = await setup();
  const id = sid(store);
  ctl.scenes.save(0);
  ctl.scenes.adjust('slots.0.gain', 0.123);
  await tick();
  engine.clear();
  store.set(`songs.${id}.patch.slots.0.instrument`, { type: 'synth', id: 'bell' });
  await tick();
  await tick();
  const p = engine.of('prepare').at(-1);
  assert.ok(p, 'a re-prepare');
  assert.equal(p[2].slots[0].gain, 0.123);
  assert.equal(ctl.scenes.state().n, 0, 'still in the scene');
});

// v11-review-fixes R-2: the commit puts the slots at the levels captured before the load; a scene step and a live
// move inside the scene made while the new instrument loads (a slow decode: fakeEngine manual) must win after it.
test('a scene step / live move during an instrument re-prepare is not undone by the commit', async () => {
  const store = makeStore();
  const engine = fakeEngine({ manual: true });
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const ctl = createController({ store, engine, midi, recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(),
    rig: null, timers: fakeTimers(), now: () => 0 });
  const started = ctl.start();
  await tick();
  engine.pending.shift().resolve();
  await started;
  await tick();
  const id = sid(store);
  const base = store.currentSong().patch.slots.map((s) => s && s.gain);
  // scene 1: Keys 0.2; scene 2: Keys 0.8 (other slots stay the song's own)
  store.set(`songs.${id}.scenes`, [{ slots: [{ gain: 0.2 }, null, null, null] }, { slots: [{ gain: 0.8 }, null, null, null] }]);
  await tick();
  assert.equal(ctl.scenes.go(0), true);
  // a new Keys instrument: a structural change → re-prepare with scene 1's levels; the decode is slow
  store.set(`songs.${id}.patch.slots.0.instrument`, { type: 'synth', id: 'bell' });
  await tick();
  const load = engine.pending.shift();
  assert.ok(load, 're-prepare pending');
  assert.equal(load.patch.slots[0].gain, 0.2, 'prepared with scene 1');
  assert.equal(ctl.scenes.go(1), true, 'a scene step is not blocked by the load');
  engine.clear();
  load.resolve();
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(engine.of('commit').length, 1);
  const after = engine.calls.slice(engine.names().indexOf('commit'));
  const keys = after.filter((c) => c[0] === 'setParam' && c[1] === 'slots.0.gain');
  assert.deepEqual(keys.map((c) => c.slice(1)), [['slots.0.gain', 0.8, { glide: SCENE_GLIDE_SEC }]],
    'after the commit Keys goes to scene 2 (what Perform shows), once');
  assert.equal(ctl.scenes.view(store.currentSong()).patch.slots[0].gain, 0.8);
  assert.ok(!after.some((c) => c[0] === 'setParam' && /^slots\.[1-3]\.gain$/.test(c[1])), 'unchanged slots are not re-sent');
  // a live move inside the scene during a second load wins too
  store.set(`songs.${id}.patch.slots.0.instrument`, { type: 'synth', id: 'warm-pad' });
  await tick();
  const load2 = engine.pending.shift();
  assert.equal(load2.patch.slots[0].gain, 0.8);
  assert.equal(ctl.scenes.adjust('slots.0.gain', 0.45), true);
  engine.clear();
  load2.resolve();
  for (let i = 0; i < 4; i++) await tick();
  const keys2 = engine.of('setParam').filter((c) => c[1] === 'slots.0.gain');
  assert.deepEqual(keys2.map((c) => c[2]), [0.45]);
  assert.deepEqual(store.currentSong().patch.slots.map((s) => s && s.gain), base, 'the song’s own levels untouched');
});
