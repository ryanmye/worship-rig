// UI6-snap skeptic review (U-SNAP, D26.1 + D26.1a): persist → reload, Save during an instrument re-prepare (F1),
// overlapping / throttled / cut glides, a tap equal to the song’s own value, Easy Transpose under a chosen key, trial
// songs. native/docs/reviews/UI6-snap.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { createStore, memoryStorage } from '../../../app/js/store.js';
import { SPACE_PRESETS, ECHO_PRESETS, applyPreset } from '../../../app/js/shared/fx-presets.js';
import { SCENE_GLIDE_SEC, SCENE_STEP_SEC } from '../../../app/js/shared/scenes.js';
import { mod12 } from '../../../app/js/shared/music.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

const STEP_MS = SCENE_STEP_SEC * 1000;
const sid = (store) => store.currentSong().id;

async function setup({ manual = false, store = makeStore(), clock = { t: 0 } } = {}) {
  const engine = fakeEngine({ manual });
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const timers = fakeTimers();
  const ctl = createController({ store, engine, midi, recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(),
    rig: null, timers, now: () => clock.t });
  const started = ctl.start();
  await tick();
  if (manual) engine.pending.shift().resolve();
  await started;
  await tick();
  return { store, engine, ctl, timers, clock };
}
function runSteps(timers, max = 1000) {
  let n = 0;
  for (;;) {
    const due = [...timers.timeouts.entries()].filter(([, t]) => t.ms === STEP_MS);
    if (!due.length || n >= max) return n;
    for (const [k, { fn }] of due) {
      timers.timeouts.delete(k);
      fn();
    }
    n += 1;
  }
}
function makeDifferent(store) {
  applyPreset(SPACE_PRESETS.find((p) => p.id === 'hall'), (p, v) => store.set(p, v));
  applyPreset(ECHO_PRESETS.find((p) => p.id === 'dotted'), (p, v) => store.set(p, v));
  store.set('slots.0.sends.reverb', 0.7);
  store.set('slots.0.gain', 0.9);
}
const last = (engine, path) => engine.of('setParam').filter((c) => c[1] === path).at(-1)?.[2];

test('UI6-snap: write → persist → reload keeps a D26.1 scene', async () => {
  const storage = memoryStorage();
  const store = makeStore({ storage });
  const { ctl } = await setup({ store });
  makeDifferent(store);
  store.set(`songs.${sid(store)}.drone.mode`, 'files');
  await tick();
  assert.equal(ctl.scenes.save(0, { keyShift: { semis: 3, minor: true }, name: 'Big' }), true);
  const want = store.currentSong().scenes;
  assert.ok(want[0].fx && want[0].slots[0].sends && want[0].drone.keyShift && want[0].drone.mode);
  store.persistNow();
  const again = createStore({ storage, idGen: () => 'x', requestIdle: null, warn: () => {}, autoFlush: false });
  assert.deepEqual(again.getSong(sid(store)).scenes, want);
});

test('UI6-snap F1: Save during an instrument re-prepare does not move the engine off what was heard', async () => {
  const { store, engine, ctl, timers } = await setup({ manual: true });
  const id = sid(store);
  const own = store.currentSong();
  makeDifferent(store);
  await tick();
  runSteps(timers);
  ctl.scenes.save(0);
  // back to the song's own as selected
  for (const k of ['patch', 'drone']) store.set(`songs.${id}.${k}`, structuredClone(own[k]));
  await tick();
  runSteps(timers);
  assert.equal(ctl.scenes.go(0), true);
  runSteps(timers);
  assert.equal(ctl.scenes.adjust('slots.0.gain', 0.33), true, 'a live move on top of scene 1');
  // a new Keys instrument: re-prepare, slow decode
  store.set(`songs.${id}.patch.slots.0.instrument`, { type: 'synth', id: 'bell' });
  await tick();
  const load = engine.pending.shift();
  assert.ok(load, 're-prepare pending');
  engine.clear();
  assert.equal(ctl.scenes.save(1), true, 'Save as new while it loads');
  runSteps(timers);
  const moved = engine.of('setParam');
  assert.deepEqual(moved, [], `nothing moves: what plays is what was saved (got ${JSON.stringify(moved)})`);
  load.resolve();
  for (let i = 0; i < 4; i++) await tick();
  runSteps(timers);
  assert.equal(ctl.scenes.view(store.currentSong()).patch.slots[0].gain, 0.33);
});

test('UI6-snap: overlapping scene changes, a throttled clock, dispose', async () => {
  const clock = { t: 0 };
  const { store, engine, ctl, timers } = await setup({ clock });
  const id = sid(store);
  const own = store.currentSong();
  const r0 = own.patch.slots[0].sends.reverb;
  store.set(`songs.${id}.scenes`, [
    { slots: [{ gain: own.patch.slots[0].gain, sends: { reverb: 1 } }] },
    { slots: [{ gain: own.patch.slots[0].gain, sends: { reverb: 0 } }] }]);
  await tick();
  ctl.scenes.go(0);
  for (let k = 0; k < 4; k++) {
    clock.t += STEP_MS;
    const [[key, t]] = [...timers.timeouts.entries()].filter(([, x]) => x.ms === STEP_MS);
    timers.timeouts.delete(key);
    t.fn();
  }
  const mid = last(engine, 'slots.0.sends.reverb');
  assert.ok(mid > r0 && mid < 1, `mid-glide ${mid}`);
  engine.clear();
  ctl.scenes.go(1);
  clock.t += STEP_MS;
  runSteps(timers, 1);
  const first = last(engine, 'slots.0.sends.reverb');
  assert.ok(first < mid && first > 0, `second glide starts from where the first is (${first} after ${mid})`);
  // hidden tab: the next step comes 2 s late, the glide ends on its value
  clock.t += 2000;
  engine.clear();
  assert.equal(runSteps(timers, 1), 1);
  assert.equal(last(engine, 'slots.0.sends.reverb'), 0);
  assert.equal(runSteps(timers), 0, 'ended');
  // dispose mid-glide: no timer left
  ctl.scenes.go(0);
  ctl.dispose?.();
  assert.equal([...timers.timeouts.values()].filter((x) => x.ms === STEP_MS).length, 0);
});

test('UI6-snap: tap equal to the song’s own value under a snapshot is heard and not written', async () => {
  const { store, engine, ctl, timers } = await setup();
  const id = sid(store);
  const own = store.currentSong();
  store.set(`songs.${id}.scenes`, [{ slots: [{ gain: own.patch.slots[0].gain, sends: { reverb: 0.95 } }],
    fx: { reverb: { size: 0.99 } } }]);
  await tick();
  const before = store.get();
  ctl.scenes.go(0);
  runSteps(timers);
  engine.clear();
  for (const addr of [`songs.${id}.patch.slots.0.sends.reverb`, 'slots.0.sends.reverb',
    'song.patch.slots.0.sends.reverb']) {
    engine.clear();
    assert.equal(ctl.scenes.take(addr, own.patch.slots[0].sends.reverb), true, addr);
    assert.equal(last(engine, 'slots.0.sends.reverb'), own.patch.slots[0].sends.reverb, addr);
    ctl.scenes.take(addr, 0.95);
  }
  assert.equal(ctl.scenes.take('fx.reverb.size', own.patch.fx.reverb.size), true);
  assert.equal(last(engine, 'fx.reverb.size'), own.patch.fx.reverb.size);
  assert.equal(ctl.scenes.take(`songs.${id}.patch.fx.reverb`, { ...own.patch.fx.reverb }), false,
    'a whole unit the scene holds only partly: the view writes the song');
  await tick();
  assert.equal(store.get(), before, 'nothing written');
  assert.deepEqual(engine.of('setTranspose'), []);
});

test('UI6-snap: Easy Transpose while a chosen-key snapshot plays, then leaving it', async () => {
  const { store, engine, ctl, timers } = await setup();
  const id = sid(store);
  const own = store.currentSong();
  ctl.scenes.save(0, { keyShift: { semis: 5 } });
  runSteps(timers);
  assert.equal(engine.of('drone.setKey').at(-1)[1], mod12(own.hearIn + 5));
  engine.clear();
  // Easy Transpose: the song's key + 2 (hearIn and playIn), as the Song panel writes it
  store.set(`songs.${id}.hearIn`, mod12(own.hearIn + 2));
  store.set(`songs.${id}.playIn`, mod12(own.playIn + 2));
  await tick();
  assert.equal(engine.of('drone.setKey').at(-1)[1], mod12(own.hearIn + 7), 'the chosen key moves with the song');
  assert.deepEqual(engine.of('setTranspose'), [], 'the transpose amount is unchanged');
  engine.clear();
  ctl.scenes.go(null);
  assert.equal(engine.of('drone.setKey').at(-1)[1], mod12(own.hearIn + 2), 'back to the song’s key');
  assert.deepEqual(engine.of('setTranspose'), []);
  // a transpose change (playIn only) under the snapshot
  ctl.scenes.go(0);
  engine.clear();
  store.set(`songs.${id}.playIn`, mod12(own.playIn + 4));
  await tick();
  assert.equal(engine.of('setTranspose').length, 1, 'a real transpose change is sent');
  assert.deepEqual(engine.of('drone.setKey'), [], 'the drone stays (hearIn unchanged)');
});

test('UI6-snap: a trial song’s snapshot edits are never saved', async () => {
  const { blankSong } = await import('../../../app/js/presets.js');
  const storage = memoryStorage();
  const store = makeStore({ storage, debounceMs: 0 });
  store.seedFactory();
  store.persistNow();
  const { ctl, timers } = await setup({ store });
  store.persistNow();
  const before = storage.getItem('rig.v1');
  const r = store.startTrial({ packId: 'Bank:a.json', pack: 'Bank', file: 'a.json', n: null, mtime: 1, hash: 'h',
    mode: 'bank', schema: 2, song: { ...blankSong({ name: 'Trial' }) } });
  assert.equal(r.ok, true);
  assert.equal(await ctl.selectSong(r.id), true);
  applyPreset(SPACE_PRESETS.find((p) => p.id === 'hall'), (p, v) => store.set(p, v));
  await tick();
  assert.equal(ctl.scenes.save(0, { keyShift: { semis: 4 } }), true);
  ctl.scenes.take('fx.reverb.size', 0.1);
  runSteps(timers);
  store.persistNow();
  await tick();
  const after = JSON.parse(storage.getItem('rig.v1'));
  assert.ok(!JSON.stringify(after).includes('trial:'), 'no trial song saved');
  assert.deepEqual(Object.keys(after.songs).sort(), Object.keys(JSON.parse(before).songs).sort());
});

test('UI6-snap: song switch and re-prepare commit mid-glide', async () => {
  const { store, engine, ctl, timers } = await setup({ manual: true });
  const id = sid(store);
  const own = store.currentSong();
  store.set(`songs.${id}.scenes`, [{ slots: [{ gain: own.patch.slots[0].gain, sends: { reverb: 1 } }],
    fx: { reverb: { returnGain: 1.8 } } }]);
  await tick();
  ctl.scenes.go(0);
  runSteps(timers, 3);
  // re-prepare mid-glide: the commit's patch is the scene's target, and no step comes after it
  store.set(`songs.${id}.patch.slots.0.instrument`, { type: 'synth', id: 'bell' });
  await tick();
  const load = engine.pending.shift();
  assert.equal(load.patch.slots[0].sends.reverb, 1, 'prepared with the scene’s send');
  runSteps(timers, 2); // steps on the old channels meanwhile
  load.resolve();
  for (let i = 0; i < 4; i++) await tick();
  engine.clear();
  runSteps(timers);
  assert.deepEqual(engine.of('setParam').filter((c) => /sends|returnGain/.test(c[1])), [], 'no step after commit');
  // song switch mid-glide
  ctl.scenes.go(null);
  runSteps(timers, 3);
  const other = store.get().songOrder.find((x) => x !== id);
  const p = ctl.selectSong(other);
  await tick();
  runSteps(timers, 2); // the old song still plays while the new one loads: steps go on
  engine.pending.shift().resolve();
  await p;
  engine.clear();
  runSteps(timers);
  assert.deepEqual(engine.of('setParam'), [], 'no old-song step after the switch');
});
