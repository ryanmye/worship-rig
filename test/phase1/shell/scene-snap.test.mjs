// D26.1 (U-SNAP): snapshots (song scenes) also remember each instrument's Space / Echo sends, the song's Space
// room and Echo, and the drone's ON / sound / key. Through store → controller → (fake) engine: what a scene holds
// and how it is normalised, capture, apply (levels glide, sends and Space / Echo levels glide in controller steps,
// the room / echo settings and the drone like a manual change), old scenes unchanged in meaning, no voice restarts,
// live moves transient, a view's store write under a scene heard, slot moves / Revert, migrate / export / import /
// 1.x, and random sequences checked against a model (the engine ends where the controller says the song sounds).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { migrate, normalizeSong } from '../../../app/js/store.js';
import { DRONE_MODES } from '../../../app/js/presets.js';
import { SPACE_PRESETS, ECHO_PRESETS, applyPreset } from '../../../app/js/shared/fx-presets.js';
import {
  SCENE_GLIDE_SEC, SCENE_STEP_SEC, SCENE_FX, SCENE_DRONE_MODES, normalizeScene, normalizeScenes, captureScene,
  applyScene, mergeScene, sceneMatches, sceneHolds, tweakScene, absorbEdits, mixOf, fxSettingsOf,
} from '../../../app/js/shared/scenes.js';
import { createRng } from '../../../app/js/shared/prng.js';
import { mod12 } from '../../../app/js/shared/music.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

const STEPS = Math.round(SCENE_GLIDE_SEC / SCENE_STEP_SEC);
const STEP_MS = SCENE_STEP_SEC * 1000;
/** Engine calls that would cut a note or restart a voice / the patch (a scene change must make none of them). */
const RESTARTS = ['prepare', 'commit', 'allNotesOff', 'noteOff', 'fadeOutAll', 'sustain', 'restart'];
const sid = (store) => store.currentSong().id;

async function setup() {
  const store = makeStore();
  const engine = fakeEngine();
  // clear() keeps what it drops in `history`, so mirror() always starts from the committed patch
  engine.history = [];
  engine.clear = () => engine.history.push(...engine.calls.splice(0));
  let wheel = 1;
  engine.wheelValues = () => ({ mod: wheel, expr: 1, vol: 1 });
  engine.setWheel = (src, v, o) => {
    engine.calls.push(o === undefined ? ['setWheel', src, v] : ['setWheel', src, v, o]);
    if (src === 'virtual') wheel = v;
  };
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const timers = fakeTimers();
  const ctl = createController({ store, engine, midi, recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(),
    rig: null, timers, now: () => 0 });
  await ctl.start();
  await tick();
  return { store, engine, midi, ctl, timers };
}

/** Run the controller's mix-glide steps (only those: the timeouts of SCENE_STEP_SEC). @returns {number} steps run */
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

/** What the fake engine holds now: the committed patch + every later setParam, the drone's mode / gain / key. */
function mirror(engine) {
  const byToken = new Map();
  let patch = null;
  const drone = { mode: null, gain: null, key: null };
  for (const c of [...engine.history, ...engine.calls]) {
    if (c[0] === 'prepare') byToken.set(c[1], structuredClone(c[2]));
    else if (c[0] === 'commit' && byToken.has(c[1])) patch = structuredClone(byToken.get(c[1]));
    else if (c[0] === 'setParam' && patch) {
      const [path, v] = [c[1], c[2]];
      const segs = path.split('.');
      if (segs[0] === 'slots') {
        const s = patch.slots[Number(segs[1])];
        if (!s) continue;
        if (segs[2] === 'sends') s.sends[segs[3]] = v;
        else if (segs.length === 3) s[segs[2]] = v;
      } else if (segs[0] === 'fx') patch.fx[segs[1]][segs[2]] = v;
      else if (segs[0] === 'drone' && segs[1] === 'gain') drone.gain = v;
    } else if (c[0] === 'drone.configure') {
      if ('mode' in c[1]) drone.mode = c[1].mode;
      if ('gain' in c[1]) drone.gain = c[1].gain;
    } else if (c[0] === 'drone.setKey') drone.key = { pc: c[1], minor: !!c[2]?.minor };
  }
  return { patch, drone };
}

/** The engine ends where the controller says the song sounds (every field a scene can hold). */
function assertEngineIs(engine, live, msg = '') {
  const m = mirror(engine);
  for (let i = 0; i < Math.min(4, live.patch.slots.length); i++) {
    const s = live.patch.slots[i];
    if (!s) continue;
    const e = m.patch.slots[i];
    assert.ok(e, `${msg} slot ${i} in the engine`);
    assert.ok(Math.abs(e.gain - s.gain) < 1e-9, `${msg} slots.${i}.gain engine ${e.gain} vs ${s.gain}`);
    for (const k of ['reverb', 'delay']) {
      assert.ok(Math.abs(e.sends[k] - s.sends[k]) < 1e-9,
        `${msg} slots.${i}.sends.${k} engine ${e.sends[k]} vs ${s.sends[k]}`);
    }
  }
  for (const [u, keys] of Object.entries(SCENE_FX)) {
    for (const k of keys) {
      const a = m.patch.fx[u][k];
      const b = live.patch.fx[u][k];
      assert.ok(typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b, `${msg} fx.${u}.${k} engine ${a} vs ${b}`);
    }
  }
  assert.equal(m.drone.mode, live.drone.mode, `${msg} drone mode`);
  assert.ok(Math.abs(m.drone.gain - live.drone.gain) < 1e-9, `${msg} drone gain ${m.drone.gain} vs ${live.drone.gain}`);
  assert.deepEqual(m.drone.key, { pc: live.hearIn, minor: !!live.minor }, `${msg} drone key`);
}

/** Space "Hall" + Echo "Dotted Eighth", the drone on My Pads two semitones up, other sends: a scene unlike the song. */
function makeDifferent(store) {
  const id = sid(store);
  applyPreset(SPACE_PRESETS.find((p) => p.id === 'hall'), (p, v) => store.set(p, v));
  applyPreset(ECHO_PRESETS.find((p) => p.id === 'dotted'), (p, v) => store.set(p, v));
  store.set('slots.0.sends.reverb', 0.7);
  store.set('slots.1.sends.delay', 0.45);
  store.set(`songs.${id}.drone.mode`, 'files');
  const s = store.currentSong();
  store.set(`songs.${id}.hearIn`, mod12(s.hearIn + 2));
  store.set(`songs.${id}.playIn`, mod12(s.playIn + 2));
  store.set(`songs.${id}.minor`, true);
}

// ---------------------------------------------------------------------------------------------------- pure

test('normalizeScene (D26.1): sends, Space / Echo rows and drone mode / key are optional, bad values dropped, '
  + 'idempotent; old scenes unchanged', () => {
  const old = { slots: [{ gain: 0.5 }, { gain: 0.2, muted: true }, null, null], drone: { gain: 0.3 }, wheel: 0.4 };
  assert.deepEqual(normalizeScene(old), old, 'a scene saved before D26.1 is kept exactly');
  const raw = {
    slots: [{ gain: 0.5, sends: { reverb: 3, delay: 'x', chorus: 0.5, junk: 1 } }, { sends: { reverb: 0.4 } },
      { gain: 0.2, sends: 7 }, { gain: 0.1, sends: { delay: -1 } }],
    drone: { gain: 0.4, mode: 'loud', key: { pc: 14, minor: true }, brightness: 1 },
    fx: { reverb: { size: 0.65, damp: '0.4', predelay: 9, returnGain: NaN, extra: 1 },
      delay: { sync: '1/8d', pingpong: 1, tone: 0.45, time: 0.01 }, chorus: { rate: 1 }, lofi: { amount: 1 } },
  };
  const n = normalizeScene(raw);
  assert.deepEqual(n, {
    slots: [{ gain: 0.5, sends: { reverb: 1 } }, null, { gain: 0.2 }, { gain: 0.1, sends: { delay: 0 } }],
    drone: { gain: 0.4, key: { pc: 2, minor: true } },
    fx: { reverb: { size: 0.65, predelay: 0.2 }, delay: { sync: '1/8d', tone: 0.45, time: 0.05 } },
  }, 'clamped like the param rows; a send alone is no slot entry; chorus / lofi / brightness are not scene fields');
  assert.deepEqual(normalizeScene(n), n, 'idempotent');
  assert.deepEqual(normalizeScene({ slots: [], fx: { delay: { returnGain: 0.5 } } }),
    { slots: [null, null, null, null], fx: { delay: { returnGain: 0.5 } } }, 'an fx row alone is a usable scene');
  assert.deepEqual(normalizeScene({ drone: { mode: 'off' } }),
    { slots: [null, null, null, null], drone: { mode: 'off' } });
  assert.equal(normalizeScene({ drone: { key: { pc: 1.5, minor: false } }, name: 'n' }), null, 'bad key, a name only');
  assert.equal(normalizeScene({ drone: { key: { pc: 1, minor: 'yes' } } }), null);
  assert.deepEqual([...SCENE_DRONE_MODES], [...DRONE_MODES], 'the drone modes are presets.js’s');
  assert.equal(normalizeScenes([{ fx: { reverb: { size: 'big' } } }]), undefined);
});

test('captureScene / applyScene (D26.1): what a scene keeps, and the song as it plays with it', () => {
  const store = makeStore();
  const own = store.currentSong();
  const sc = captureScene(own);
  assert.deepEqual(sc.slots.slice(0, 2), [
    ...[0, 1].map((i) => ({ gain: own.patch.slots[i].gain,
      sends: { reverb: own.patch.slots[i].sends.reverb, delay: own.patch.slots[i].sends.delay } })),
  ], 'chorus send not kept');
  assert.deepEqual(sc.drone, { gain: own.drone.gain, mode: own.drone.mode, key: { pc: own.hearIn, minor: own.minor } });
  assert.deepEqual(Object.keys(sc.fx.reverb).sort(), [...SCENE_FX.reverb].sort());
  assert.deepEqual(Object.keys(sc.fx.delay).sort(), [...SCENE_FX.delay].sort());
  // apply: a scene two semitones up, minor, My Pads, Hall
  const up2 = mod12(own.hearIn + 2);
  const scene = normalizeScene({ ...sc, drone: { ...sc.drone, mode: 'files', key: { pc: up2, minor: true } },
    fx: { reverb: SPACE_PRESETS.find((p) => p.id === 'hall').params && { size: 0.65, returnGain: 1.15 } },
    slots: [{ gain: 0.3, sends: { reverb: 0.9 } }] });
  const live = applyScene(own, scene);
  assert.equal(live.hearIn, mod12(own.hearIn + 2));
  assert.equal(live.playIn, mod12(own.playIn + 2), 'playIn moves with it: the transpose stays');
  assert.equal(live.minor, true);
  assert.equal(live.drone.mode, 'files');
  assert.equal(live.patch.slots[0].sends.reverb, 0.9);
  assert.equal(live.patch.slots[0].sends.delay, own.patch.slots[0].sends.delay, 'a send the scene lacks: the song’s');
  assert.equal(live.patch.slots[0].sends.chorus, own.patch.slots[0].sends.chorus);
  assert.equal(live.patch.fx.reverb.size, 0.65);
  assert.equal(live.patch.fx.reverb.damp, own.patch.fx.reverb.damp);
  assert.equal(live.patch.fx.delay, own.patch.fx.delay, 'a unit the scene lacks is the song’s object');
  assert.equal(live.patch.fx.chorus, own.patch.fx.chorus);
  assert.equal(own.patch.fx.reverb.size !== 0.65, true, 'the song itself is untouched');
  // the key is absolute: the song's own key moved later (key grid / Hear In) leaves the scene's drone key, and the
  // scene keeps the song's transpose
  const moved = { ...own, hearIn: mod12(own.hearIn + 5) };
  const lm = applyScene(moved, scene);
  assert.equal(lm.hearIn, up2);
  assert.equal(((lm.hearIn - lm.playIn + 18) % 12) - 6, ((moved.hearIn - moved.playIn + 18) % 12) - 6);
  // capture(apply) gives the scene back
  const back = captureScene(live);
  assert.deepEqual(back.drone, { gain: own.drone.gain, mode: 'files', key: { pc: up2, minor: true } });
  assert.equal(sceneMatches(scene, live), true);
  assert.equal(sceneMatches(scene, own), false, 'the song’s own (C, synth, Stage) is not that scene');
  assert.equal(sceneMatches({ slots: scene.slots, drone: { key: { pc: own.hearIn, minor: true } } }, live), false);
  // an old scene (levels only) matches whatever the song's own sends / fx / drone are
  const otherFx = applyScene(own, { slots: [], fx: { reverb: { size: 0.1 } } });
  assert.equal(sceneMatches({ slots: [{ gain: own.patch.slots[0].gain }] }, otherFx), true);
});

test('mergeScene / tweakScene / sceneHolds / absorbEdits (D26.1)', () => {
  const store = makeStore();
  const own = store.currentSong();
  const sc = captureScene(own);
  let t = tweakScene(null, applyScene(own, sc), 'slots.0.sends.reverb', 0.9);
  assert.deepEqual(t.slots[0], { sends: { reverb: 0.9 } }, 'a send alone: no level in the tweak');
  t = tweakScene(t, applyScene(own, mergeScene(sc, t)), 'slots.0.gain', 0.2);
  assert.deepEqual(t.slots[0], { gain: 0.2, sends: { reverb: 0.9 } }, 'the level keeps the send');
  t = tweakScene(t, applyScene(own, mergeScene(sc, t)), 'slots.0.muted', true);
  assert.deepEqual(t.slots[0], { gain: 0.2, muted: true, sends: { reverb: 0.9 } });
  t = tweakScene(t, applyScene(own, mergeScene(sc, t)), 'fx.delay.sync', '1/4');
  t = tweakScene(t, applyScene(own, mergeScene(sc, t)), 'drone.mode', 'off');
  t = tweakScene(t, applyScene(own, mergeScene(sc, t)), 'drone.key', { pc: own.hearIn + 15 });
  assert.deepEqual(t.drone, { mode: 'off', key: { pc: mod12(own.hearIn + 3), minor: own.minor } });
  assert.equal(tweakScene(t, own, 'drone.key', { pc: 'D' }), null);
  assert.equal(tweakScene(t, own, 'drone.mode', 'loud'), null);
  assert.equal(tweakScene(t, own, 'fx.delay.sync', '1/16'), null, 'a bad enum value');
  assert.equal(tweakScene(t, own, 'fx.delay.pingpong', 1), null, 'a boolean row takes booleans only');
  assert.equal(tweakScene(t, own, 'slots.0.sends.chorus', 0.5), null, 'the chorus send is not a scene field');
  assert.equal(tweakScene(t, own, 'slots.2.sends.reverb', 0.5), null, 'an empty slot');
  const m = mergeScene(sc, t);
  const heard = applyScene(own, m);
  assert.equal(heard.patch.slots[0].gain, 0);
  assert.equal(heard.patch.slots[0].gainBeforeMute, 0.2);
  assert.equal(heard.patch.slots[0].sends.reverb, 0.9);
  assert.equal(heard.patch.slots[0].sends.delay, sc.slots[0].sends.delay, 'the scene’s other send');
  assert.equal(heard.patch.fx.delay.sync, '1/4');
  assert.equal(heard.patch.fx.delay.feedback, sc.fx.delay.feedback);
  assert.equal(heard.drone.mode, 'off');
  assert.equal(heard.hearIn, mod12(own.hearIn + 3));
  assert.equal(heard.drone.gain, sc.drone.gain);
  // sceneHolds
  const old = { slots: [{ gain: 0.5 }, null, null, null], drone: { gain: 0.2 } };
  assert.deepEqual(['slots.0.gain', 'slots.0.muted', 'slots.0.sends.reverb', 'slots.1.gain', 'drone.gain', 'drone.mode',
    'drone.key', 'fx.reverb.size'].map((p) => sceneHolds(old, p)),
  [true, true, false, false, true, false, false, false]);
  assert.deepEqual(['slots.0.sends.reverb', 'slots.0.sends.chorus', 'drone.mode', 'drone.key', 'fx.reverb.size',
    'fx.delay.sync', 'fx.chorus.rate', 'master.volume'].map((p) => sceneHolds(sc, p)),
  [true, false, true, true, true, true, false, false]);
  // absorbEdits: the song's own field changes under a scene holding it → on top (heard); not for old scenes / levels
  const next = structuredClone(own);
  next.patch.slots[1].sends.delay = 0.66;
  next.patch.fx.reverb.size = 0.11;
  next.patch.fx.chorus.rate = 2;
  next.patch.slots[0].gain = 0.01;
  next.drone.mode = 'off';
  next.hearIn = mod12(own.hearIn + 1);
  const a = absorbEdits(null, sc, own, next);
  assert.deepEqual(a.slots[1], { sends: { delay: 0.66 } });
  assert.equal(a.slots[0], null, 'levels are not absorbed (views move them through scenes.adjust)');
  assert.deepEqual(a.fx, { reverb: { size: 0.11 } });
  assert.deepEqual(a.drone, { mode: 'off', key: { pc: next.hearIn, minor: own.minor } }, 'a key change: that key');
  assert.equal(absorbEdits(null, old, own, next), null, 'an old scene holds none of it: nothing');
  assert.equal(absorbEdits(t, sc, own, own), t);
  // a re-order: next slot 0 is prev slot 1 (its send did not change), next slot 1 is prev slot 0
  const swapped = structuredClone(own);
  swapped.patch.slots = [own.patch.slots[1], own.patch.slots[0], null, null];
  const scSwapped = { ...sc, slots: [sc.slots[1], sc.slots[0], null, null] };
  assert.equal(absorbEdits(null, scSwapped, own, swapped, [1, 0, 2, 3]), null, 'paired by instrument: no edit');
  assert.notEqual(absorbEdits(null, scSwapped, own, swapped), null, 'positional pairing would see edits');
});

// ---------------------------------------------------------------------------------------------------- controller

test('capture on Save: the scene holds the sends, Space / Echo and the drone as they play', async () => {
  const { store, ctl } = await setup();
  makeDifferent(store);
  await tick();
  assert.equal(ctl.scenes.save(0), true);
  const own = store.currentSong();
  const sc = own.scenes[0];
  assert.deepEqual(sc.slots[0].sends, { reverb: 0.7, delay: own.patch.slots[0].sends.delay });
  assert.equal(sc.slots[1].sends.delay, 0.45);
  assert.deepEqual(sc.drone, { gain: own.drone.gain, mode: 'files', key: { pc: own.hearIn, minor: true } },
    'the key as it plays');
  assert.equal(sc.fx.reverb.size, SPACE_PRESETS.find((p) => p.id === 'hall').params['fx.reverb.size']);
  assert.equal(sc.fx.delay.sync, '1/8d');
  assert.equal(sceneMatches(sc, ctl.scenes.view(own)), true);
});

test('apply: levels glide in the engine, sends + Space / Echo levels glide in steps, room / echo / drone like a '
  + 'manual change; nothing restarts or cuts; the song is never written', async () => {
  const { store, engine, ctl, timers } = await setup();
  const id = sid(store);
  const base = store.currentSong();
  // the manual change, as Perform / the Space picker / the key grid make it, from the song's own state
  makeDifferent(store);
  await tick();
  runSteps(timers);
  const manual = engine.calls.filter((c) => c[0] !== 'setParam' || !/returnGain|sends|gain$/.test(c[1]));
  assert.equal(ctl.scenes.save(0), true);
  ctl.revertSong(); // the song as selected again (Stage / no echo / synth / its key); scene 1 = the different one
  await tick();
  runSteps(timers);
  assert.deepEqual(store.currentSong().patch, base.patch);
  ctl.perform.noteOn(60, 100);
  engine.clear();
  assert.equal(ctl.scenes.go(0), true);
  const sent = engine.calls.slice();
  assert.deepEqual(sent.filter((c) => RESTARTS.includes(c[0])), [], 'no prepare / commit / note off / fade');
  // room / echo settings: the same setParams as the manual change (no glide option), in one go
  const fxOf = (calls) => calls.filter((c) => c[0] === 'setParam' && /^fx\./.test(c[1]) && !/returnGain/.test(c[1]))
    .map((c) => c.slice(1)).sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(fxOf(sent), fxOf(manual), 'Space room / Echo settings as the picker sends them');
  assert.ok(fxOf(sent).length >= 4);
  // the drone: key crossfade + key context + configure (mode), as the manual change, the level aside
  const droneOf = (calls) => calls.filter((c) => ['drone.setKey', 'setKeyContext'].includes(c[0]));
  assert.deepEqual(droneOf(sent), droneOf(manual).slice(-2), 'the drone key: setKeyContext + drone.setKey');
  const conf = sent.filter((c) => c[0] === 'drone.configure');
  assert.equal(conf.length, 1);
  assert.equal(conf[0][1].mode, 'files');
  assert.equal(conf[0][1].gain, base.drone.gain, 'configure keeps the level where it is (the level glides)');
  // nothing stepped yet: the sends and returns are not written at once
  assert.deepEqual(sent.filter((c) => c[0] === 'setParam' && /sends|returnGain/.test(c[1])), []);
  // steps: SCENE_GLIDE_SEC / SCENE_STEP_SEC plain writes per path, evenly, ending on the scene's value
  engine.clear();
  assert.equal(runSteps(timers), STEPS);
  const sc = store.currentSong().scenes[0];
  const steps = (p) => engine.of('setParam').filter((c) => c[1] === p);
  const rev0 = steps('slots.0.sends.reverb');
  assert.equal(rev0.length, STEPS);
  assert.ok(rev0.every((c) => c.length === 3), 'plain writes (the engine’s τ 15 ms smoothing between steps)');
  const from = base.patch.slots[0].sends.reverb;
  rev0.forEach((c, k) => assert.ok(Math.abs(c[2] - (from + (0.7 - from) * (k + 1) / STEPS)) < 1e-9, `step ${k}`));
  assert.equal(rev0.at(-1)[2], 0.7);
  assert.equal(steps('fx.reverb.returnGain').at(-1)[2], sc.fx.reverb.returnGain);
  assert.equal(steps('fx.delay.returnGain').at(-1)[2], sc.fx.delay.returnGain);
  assert.deepEqual(steps('slots.1.sends.reverb'), [], 'an unchanged send is not written');
  assert.deepEqual(engine.calls.filter((c) => RESTARTS.includes(c[0])), []);
  assertEngineIs(engine, ctl.scenes.view(store.currentSong()), 'scene 1');
  assert.equal(ctl._debug().held.length, 1, 'the held note is still held');
  assert.deepEqual(store.currentSong().patch, base.patch, 'stepping never wrote the song');
  assert.equal(store.currentSong().hearIn, base.hearIn);
  assert.equal(store.currentSong().drone.mode, base.drone.mode);
  // back to the song's own: everything back, the same way
  engine.clear();
  ctl.scenes.go(null);
  runSteps(timers);
  assert.deepEqual(engine.calls.filter((c) => RESTARTS.includes(c[0])), []);
  assertEngineIs(engine, store.currentSong(), 'own');
  assert.equal(engine.of('drone.configure').at(-1)[1].mode, base.drone.mode);
  // the menu-bar state shows the drone as it plays
  ctl.scenes.go(0);
  assert.equal(ctl.menuBarState().droneOn, true);
  assert.notEqual(ctl.menuBarState().droneKey, ctl.menuBarState().current.key,
    'the drone’s key, the song’s own key');
  void id;
});

test('a drone key change is the manual one (crossfade); a drone ON → OFF is the manual fade; old scenes leave the '
  + 'drone, sends and fx alone', async () => {
  const { store, engine, ctl, timers } = await setup();
  const id = sid(store);
  const own = store.currentSong();
  // key: scene = song key + 5, as the key grid would do it
  const sc = captureScene(own);
  store.set(`songs.${id}.scenes`, [{ ...sc, drone: { ...sc.drone, key: { pc: mod12(own.hearIn + 5), minor: false } } },
    { ...sc, drone: { ...sc.drone, mode: 'off' } },
    { slots: [{ gain: 0.3 }, { gain: 0.2 }], drone: { gain: 0.1 } }]); // scene 3: saved before D26.1
  await tick();
  engine.clear();
  ctl.scenes.go(0);
  const viaScene = engine.calls.filter((c) => ['drone.setKey', 'setKeyContext', 'drone.configure'].includes(c[0]));
  ctl.scenes.go(null);
  engine.clear();
  store.set(`songs.${id}.hearIn`, mod12(own.hearIn + 5));
  store.set(`songs.${id}.playIn`, mod12(own.playIn + 5));
  await tick();
  const viaGrid = engine.calls.filter((c) => ['drone.setKey', 'setKeyContext', 'drone.configure'].includes(c[0]));
  assert.deepEqual(viaScene, viaGrid, 'the same engine calls as the key grid');
  assert.equal(viaScene.filter((c) => c[0] === 'drone.setKey').length, 1);
  assert.deepEqual(engine.of('setTranspose'), [], 'the instruments’ transpose stays');
  store.set(`songs.${id}.hearIn`, own.hearIn);
  store.set(`songs.${id}.playIn`, own.playIn);
  await tick();
  // OFF: configure({mode:'off'}) as the ON tile's write does
  engine.clear();
  ctl.scenes.go(1);
  const off = engine.of('drone.configure');
  assert.equal(off.length, 1);
  assert.equal(off[0][1].mode, 'off');
  ctl.scenes.go(null);
  engine.clear();
  store.set(`songs.${id}.drone.mode`, 'off');
  await tick();
  assert.deepEqual(engine.of('drone.configure').map((c) => c[1]), off.map((c) => c[1]), 'as the ON tile');
  store.set(`songs.${id}.drone.mode`, own.drone.mode);
  await tick();
  // an old scene: levels only; the song's own sends / fx / drone keep playing and stay editable as before
  engine.clear();
  ctl.scenes.go(2);
  runSteps(timers);
  assert.deepEqual(engine.calls.filter((c) => c[0] !== 'setParam' || !/gain$/.test(c[1])), [],
    'levels only: no send, fx or drone call');
  engine.clear();
  store.set('slots.0.sends.reverb', 0.61); // Perform's Space chip under the old scene: heard, an edit of the song
  store.set('fx.reverb.size', 0.2);
  await tick();
  assert.deepEqual(engine.of('setParam').map((c) => c.slice(1)).sort(),
    [['fx.reverb.size', 0.2], ['slots.0.sends.reverb', 0.61]]);
  assert.equal(store.currentSong().patch.slots[0].sends.reverb, 0.61);
  assertEngineIs(engine, ctl.scenes.view(store.currentSong()), 'old scene');
});

test('live moves on a scene that holds the field are transient (scenes.adjust): heard at once, the song and the '
  + 'scene untouched, kept by Save, dropped at the next change; learned knobs and the bus too', async () => {
  const { store, engine, midi, ctl, timers } = await setup();
  const id = sid(store);
  ctl.scenes.save(0);
  const own = store.currentSong();
  const saved = own.scenes[0];
  engine.clear();
  assert.equal(ctl.scenes.adjust('slots.1.sends.reverb', 0.05), true);
  assert.deepEqual(engine.of('setParam').map((c) => c.slice(1)), [['slots.1.sends.reverb', 0.05]], 'at once');
  assert.equal(ctl.scenes.adjust('fx.delay.sync', '1/4'), true);
  assert.equal(ctl.scenes.adjust('fx.reverb.returnGain', 0.3), true);
  assert.equal(ctl.scenes.adjust('drone.key', { pc: mod12(own.hearIn + 7), minor: true }), true);
  assert.equal(ctl.scenes.adjust('drone.mode', 'files'), true);
  assert.equal(ctl.scenes.adjust('slots.1.sends.chorus', 0.5), false, 'not a scene field: the song’s own');
  assert.equal(ctl.scenes.adjust('fx.chorus.rate', 1), false);
  assert.deepEqual(engine.of('drone.setKey').at(-1).slice(1), [mod12(own.hearIn + 7), { minor: true }]);
  assert.equal(engine.of('drone.configure').at(-1)[1].mode, 'files');
  assert.ok(engine.of('setParam').some((c) => c[1] === 'fx.delay.sync' && c[2] === '1/4' && c.length === 3));
  assert.equal(store.currentSong(), own, 'the song (and its scenes) untouched');
  assertEngineIs(engine, ctl.scenes.view(own), 'tweaked');
  // the bus: the drone toggle / key go on top of the scene too
  assert.equal(ctl.handleCommand({ v: 1, type: 'droneToggle' }), true);
  assert.equal(ctl.scenes.view(store.currentSong()).drone.mode, 'off');
  assert.equal(ctl.menuBarState().droneOn, false);
  ctl.handleCommand({ v: 1, type: 'droneToggle' });
  assert.equal(ctl.scenes.view(store.currentSong()).drone.mode, 'files', 'back to the sound it had');
  ctl.handleCommand({ v: 1, type: 'droneKey', pc: mod12(own.hearIn + 2) });
  assert.equal(ctl.scenes.view(store.currentSong()).hearIn, mod12(own.hearIn + 2));
  assert.equal(store.currentSong(), own, 'still untouched');
  // a learned knob on a send: on top of the scene, not a song edit
  store.setMidiLearn('slots.0.sends.delay', { cc: 30, channel: null });
  await tick();
  const sd = ctl.scenes.view(store.currentSong()).patch.slots[0].sends.delay;
  midi._inject([0xb0, 30, Math.round(sd * 127)]); // picked up where it is
  midi._inject([0xb0, 30, 127]);
  assert.equal(ctl.scenes.view(store.currentSong()).patch.slots[0].sends.delay, 1);
  assert.equal(store.currentSong().patch.slots[0].sends.delay, own.patch.slots[0].sends.delay, 'the song’s own');
  // Save as new keeps every move
  assert.equal(ctl.scenes.save(1), true);
  const s2 = store.currentSong().scenes[1];
  assert.equal(s2.slots[1].sends.reverb, 0.05);
  assert.equal(s2.slots[0].sends.delay, 1);
  assert.equal(s2.fx.delay.sync, '1/4');
  assert.deepEqual(s2.drone.key, { pc: mod12(own.hearIn + 2), minor: true });
  assert.equal(s2.drone.mode, 'files');
  assert.deepEqual(store.currentSong().scenes[0], saved, 'scene 1 untouched');
  // the next change drops the moves: scene 1 again exactly
  ctl.scenes.go(0);
  runSteps(timers);
  assertEngineIs(engine, applyScene(store.currentSong(), saved), 'scene 1 again');
  assert.equal(store.currentSong().patch, own.patch);
  void id;
});

test('a view writing the song under a scene that holds the field (no scenes.adjust): heard at once, until the next '
  + 'scene change; the write is a song edit (Revert undoes it)', async () => {
  const { store, engine, ctl, timers } = await setup();
  const id = sid(store);
  ctl.scenes.save(0);
  const saved = store.currentSong().scenes[0];
  engine.clear();
  store.set('slots.1.sends.reverb', 0.03); // v6 strip Space chip (v.setSlot)
  applyPreset(SPACE_PRESETS.find((p) => p.id === 'cathedral'), (p, v) => store.set(p, v)); // song bar Space picker
  store.set(`songs.${id}.drone.mode`, 'off'); // the drone module's ON tile
  await tick();
  const heard = ctl.scenes.view(store.currentSong());
  assert.equal(heard.patch.slots[1].sends.reverb, 0.03);
  assert.equal(heard.patch.fx.reverb.size, 0.9);
  assert.equal(heard.drone.mode, 'off');
  assert.ok(engine.of('setParam').some((c) => c[1] === 'slots.1.sends.reverb' && c[2] === 0.03), 'heard at once');
  assert.equal(engine.of('drone.configure').at(-1)[1].mode, 'off');
  assertEngineIs(engine, heard, 'absorbed');
  assert.deepEqual(store.currentSong().scenes[0], saved, 'the scene is not rewritten');
  assert.equal(store.currentSong().patch.slots[1].sends.reverb, 0.03, 'the song was edited (a changed dot)');
  // the next scene change: the scene's own values again
  ctl.scenes.go(null);
  ctl.scenes.go(0);
  runSteps(timers);
  assertEngineIs(engine, applyScene(store.currentSong(), saved), 'scene again');
  // Revert: the song as selected; its own levels
  assert.equal(ctl.revertSong(), true);
  await tick();
  runSteps(timers);
  assert.equal(ctl.scenes.state().n, null);
  assertEngineIs(engine, store.currentSong(), 'reverted');
  assert.equal(store.currentSong().patch.slots[1].sends.reverb, saved.slots[1].sends.reverb);
});

test('glide: a manual write mid-glide wins (ends that path’s glide); a second change mid-glide starts where the '
  + 'glide is; a song switch ends them', async () => {
  const { store, engine, ctl, timers } = await setup();
  const id = sid(store);
  const own = store.currentSong();
  const sc = captureScene(own);
  const at = (r) => ({ ...sc, slots: [{ ...sc.slots[0], sends: { ...sc.slots[0].sends, reverb: r } }, sc.slots[1]] });
  store.set(`songs.${id}.scenes`, [at(1), at(0)]);
  await tick();
  ctl.scenes.go(0);
  const step = () => {
    const due = [...timers.timeouts.entries()].find(([, t]) => t.ms === STEP_MS);
    timers.timeouts.delete(due[0]);
    due[1].fn();
  };
  for (let k = 0; k < 4; k++) step();
  const r0 = own.patch.slots[0].sends.reverb;
  const mid = r0 + (1 - r0) * 4 / STEPS;
  assert.ok(Math.abs(engine.of('setParam').filter((c) => c[1] === 'slots.0.sends.reverb').at(-1)[2] - mid) < 1e-9);
  // the next scene mid-glide: from `mid` to 0 in STEPS steps
  engine.clear();
  ctl.scenes.go(1);
  assert.equal(runSteps(timers), STEPS);
  const w = engine.of('setParam').filter((c) => c[1] === 'slots.0.sends.reverb').map((c) => c[2]);
  assert.equal(w.length, STEPS);
  assert.ok(Math.abs(w[0] - mid * (1 - 1 / STEPS)) < 1e-9, 'starts where the glide was');
  assert.equal(w.at(-1), 0);
  // a live move mid-glide: no step after it
  ctl.scenes.go(0);
  step();
  engine.clear();
  assert.equal(ctl.scenes.adjust('slots.0.sends.reverb', 0.42), true);
  runSteps(timers);
  assert.deepEqual(engine.of('setParam').filter((c) => c[1] === 'slots.0.sends.reverb').map((c) => c[2]), [0.42]);
  // a song switch mid-glide: the new song's commit sets every send; no step of the old glide lands
  ctl.scenes.go(1);
  step();
  await ctl.nextSong();
  await tick();
  engine.clear();
  runSteps(timers);
  assert.deepEqual(engine.of('setParam').filter((c) => /sends|returnGain/.test(c[1])), []);
  // dispose clears the step timer
  ctl.dispose();
  assert.equal([...timers.timeouts.values()].filter((t) => t.ms === STEP_MS).length, 0);
});

test('slot move / insert / remove and Revert keep each scene’s sends on their instrument (store + controller)',
  async () => {
    const { store, engine, ctl, timers } = await setup();
    const id = sid(store);
    const selected = structuredClone(store.currentSong()); // the controller's Revert snapshot (as selected)
    store.set('slots.2', { instrument: { type: 'synth', id: 'warm-pad' } });
    await tick();
    store.set('slots.0.sends.reverb', 0.11);
    store.set('slots.1.sends.reverb', 0.22);
    store.set('slots.2.sends.reverb', 0.33);
    await tick();
    assert.equal(ctl.scenes.save(0), true);
    const before = store.currentSong();
    const rev = (s) => s.scenes[0].slots.map((e) => e?.sends?.reverb ?? null);
    assert.deepEqual(rev(before), [0.11, 0.22, 0.33, null]);
    assert.ok(store.moveSlot(id, 0, 2));
    assert.deepEqual(rev(store.currentSong()), [0.22, 0.33, 0.11, null], 'entries travel with their instrument');
    await tick();
    await tick();
    runSteps(timers);
    assert.equal(ctl.scenes.state().n, 0, 'still in the scene');
    const live = ctl.scenes.view(store.currentSong());
    assert.deepEqual(live.patch.slots.slice(0, 3).map((s) => s.sends.reverb), [0.22, 0.33, 0.11]);
    assertEngineIs(engine, live, 'after the move');
    const ins = store.insertSlot(id, 0, null, { scenesFrom: 0 }); // Duplicate-style: the copy follows the scenes
    assert.equal(ins, 1);
    assert.deepEqual(rev(store.currentSong()), [0.22, 0.22, 0.33, 0.11, null]);
    assert.ok(store.removeSlot(id, 1));
    assert.deepEqual(rev(store.currentSong()), [0.22, 0.33, 0.11, null]);
    await tick();
    // Revert (the controller's): the old order, the scene entries with it
    assert.ok(ctl.revertSong());
    await tick();
    await tick();
    runSteps(timers);
    assert.deepEqual(store.currentSong().patch, selected.patch);
    assert.deepEqual(rev(store.currentSong()), [0.11, 0.22, 0.33, null], 'back on the old order');
    assertEngineIs(engine, store.currentSong(), 'reverted');
    // a live send move travels with its instrument too
    ctl.scenes.go(0);
    assert.ok(ctl.scenes.adjust('slots.0.sends.reverb', 0.9));
    assert.ok(store.moveSlot(id, 0, 1));
    await tick();
    await tick();
    runSteps(timers);
    assert.equal(ctl.scenes.view(store.currentSong()).patch.slots[1].sends.reverb, 0.9);
    assert.equal(ctl.scenes.view(store.currentSong()).patch.slots[0].sends.reverb, 0.22);
    assertEngineIs(engine, ctl.scenes.view(store.currentSong()), 'moved with a live move');
  });

test('store: migrate idempotent, export / import round trip, a 1.x library unaffected, the fingerprint counts a '
  + 'richer save', async () => {
  const { store, ctl } = await setup();
  const id = sid(store);
  makeDifferent(store);
  await tick();
  ctl.scenes.save(0, { name: 'Bridge' });
  const song = store.currentSong();
  assert.deepEqual(normalizeSong(song, id), song, 'normalizeSong keeps a D26.1 scene as it is');
  const lib = JSON.parse(store.exportJSON({ pretty: false }));
  const once = migrate(lib);
  assert.deepEqual(once.songs[id].scenes, song.scenes);
  assert.deepEqual(migrate(once), once, 'idempotent');
  const other = makeStore();
  assert.equal(other.importJSON(store.exportJSON({ pretty: false }), { replace: true }).ok, true);
  assert.deepEqual(other.getSong(id).scenes, song.scenes, 'library export / import');
  const one = JSON.parse(store.exportSong(id));
  const songOf = (o) => (o.songs ? Object.values(o.songs)[0] : o.song || o);
  assert.deepEqual(songOf(one).scenes, song.scenes, 'single-song export');
  // a 1.x (schema 1) library with 1.x scenes: exactly as before (4 entries, levels only)
  const raw = { schema: 1, songs: { a: { name: 'A', scenes: [{ slots: [{ gain: 0.4 }, { gain: 0.2, muted: true }],
    drone: { gain: 0.3 }, wheel: 0.5 }] } } };
  const m = migrate(raw);
  assert.deepEqual(m.songs.a.scenes, [{ slots: [{ gain: 0.4 }, { gain: 0.2, muted: true }, null, null],
    drone: { gain: 0.3 }, wheel: 0.5 }]);
  assert.deepEqual(migrate(m), m);
  // a whole-scenes write with junk in the new fields: dropped, the rest kept
  store.set(`songs.${id}.scenes`, [{ slots: [{ gain: 0.5, sends: { reverb: 'x' } }], fx: { reverb: { size: -3 } },
    drone: { mode: 'x', key: { pc: -1, minor: false } } }]);
  assert.deepEqual(store.currentSong().scenes, [{ slots: [{ gain: 0.5 }, null, null, null],
    fx: { reverb: { size: 0 } }, drone: { key: { pc: 11, minor: false } } }]);
});

// ---------------------------------------------------------------------------------------------------- model

test('random sequences vs a model: the engine always ends where the scene + live moves say; scene ops never '
  + 'restart a voice; saved scenes = capture of what played; the song’s own fields change only by store writes',
async () => {
  const PATHS = ['slots.0.gain', 'slots.1.gain', 'slots.0.muted', 'slots.1.muted', 'slots.0.sends.reverb',
    'slots.1.sends.delay', 'fx.reverb.size', 'fx.reverb.returnGain', 'fx.delay.sync', 'fx.delay.returnGain',
    'fx.delay.pingpong', 'drone.gain', 'drone.mode', 'drone.key'];
  for (let seed = 1; seed <= 24; seed++) {
    const rng = createRng(seed);
    const pick = (a) => a[Math.floor(rng.next() * a.length)];
    const { store, engine, ctl, timers } = await setup();
    const id = sid(store);
    ctl.perform.noteOn(64, 90);
    const valueFor = (p) => {
      if (p.endsWith('.muted')) return rng.next() < 0.5;
      if (p === 'drone.mode') return pick(['off', 'synth', 'files']);
      if (p === 'drone.key') return { pc: Math.floor(rng.next() * 12), minor: rng.next() < 0.5 };
      if (p === 'fx.delay.sync') return pick(['off', '1/4', '1/8d', '1/8']);
      if (p === 'fx.delay.pingpong') return rng.next() < 0.5;
      return Math.round(rng.next() * 100) / 100;
    };
    /** A view's write of the song's own field (what the store gets without scenes.adjust). */
    const storeWrite = (p, v) => {
      let changed;
      if (p === 'drone.key') {
        const s = store.currentSong();
        const semis = ((s.hearIn - s.playIn + 18) % 12) - 6;
        changed = [store.set(`songs.${id}.hearIn`, v.pc), store.set(`songs.${id}.playIn`, mod12(v.pc - semis)),
          store.set(`songs.${id}.minor`, v.minor)].some(Boolean);
      } else if (p === 'drone.mode') changed = store.set(`songs.${id}.drone.mode`, v);
      else changed = store.set(p, v);
      // a write that changes a field a scene holds (not a level: views move levels through scenes.adjust) is heard at
      // once. KNOWN GAP (report): a write equal to the song's own value changes nothing in the store, so the
      // controller never sees it; only a view calling scenes.adjust first makes that one heard.
      if (changed && (!/gain$|muted$/.test(p) || /returnGain$/.test(p))) written.push([p, v]);
    };
    const written = [];
    const checkHeard = () => {
      const heard = ctl.scenes.view(store.currentSong());
      for (const [p, v] of written.splice(0)) {
        const got = p === 'drone.key' ? { pc: heard.hearIn, minor: heard.minor } : p === 'drone.mode' ? heard.drone.mode
          : p.split('.').reduce((o, k) => o?.[k], heard.patch);
        assert.deepEqual(got, v, `seed ${seed}: the store write of ${p} is heard`);
      }
    };
    for (let k = 0; k < 30; k++) {
      const op = pick(['go', 'go', 'next', 'prev', 'save', 'adjust', 'adjust', 'write', 'move', 'revert']);
      const own0 = store.currentSong();
      const count = (own0.scenes || []).length;
      const restarts0 = engine.calls.filter((c) => RESTARTS.includes(c[0])).length;
      let sceneOp = true;
      if (op === 'go') ctl.scenes.go(pick([null, ...Array.from({ length: count }, (_, i) => i)]));
      else if (op === 'next') ctl.scenes.next();
      else if (op === 'prev') ctl.scenes.prev();
      else if (op === 'save') {
        const n = Math.min(count, 2, Math.floor(rng.next() * (count + 1)));
        const heard = ctl.scenes.view(own0);
        assert.equal(ctl.scenes.save(n), true);
        const want = captureScene(heard);
        const got = store.currentSong().scenes[n];
        assert.deepEqual({ ...got, wheel: undefined, name: undefined }, { ...want, wheel: undefined, name: undefined },
          `seed ${seed} op ${k}: saved = what played`);
      } else if (op === 'adjust') {
        const p = pick(PATHS);
        const v = valueFor(p);
        if (!ctl.scenes.adjust(p, v)) {
          sceneOp = false;
          storeWrite(p, v);
        } else assert.equal(store.currentSong(), own0, `seed ${seed} op ${k}: adjust never writes the song`);
      } else if (op === 'write') {
        sceneOp = false;
        const p = pick(PATHS);
        storeWrite(p, valueFor(p));
      } else if (op === 'move') {
        sceneOp = false;
        store.moveSlot(id, 0, 1);
      } else if (op === 'revert') {
        sceneOp = false;
        ctl.revertSong();
      }
      if (sceneOp) {
        assert.equal(engine.calls.filter((c) => RESTARTS.includes(c[0])).length, restarts0,
          `seed ${seed} op ${k} (${op}): no restart`);
        if (op !== 'save') assert.equal(store.currentSong(), own0, `seed ${seed} op ${k}: the song is not written`);
      }
      await tick();
      await tick();
      checkHeard();
      if (rng.next() < 0.7) runSteps(timers); // sometimes the next op comes mid-glide
      if (op === 'go' || op === 'next' || op === 'prev') {
        const st = ctl.scenes.state();
        const own = store.currentSong();
        const want = st.n === null ? own : applyScene(own, own.scenes[st.n]);
        const got = ctl.scenes.view(own);
        assert.deepEqual(mixOf(got), mixOf(want), `seed ${seed} op ${k}: a scene change drops the live moves`);
        assert.deepEqual(fxSettingsOf(got), fxSettingsOf(want));
        assert.deepEqual([got.drone.mode, got.hearIn, got.minor], [want.drone.mode, want.hearIn, want.minor]);
      }
    }
    runSteps(timers);
    await tick();
    assertEngineIs(engine, ctl.scenes.view(store.currentSong()), `seed ${seed} end`);
    assert.equal(engine.calls.filter((c) => ['allNotesOff', 'noteOff', 'fadeOutAll'].includes(c[0])).length, 0);
    assert.equal(ctl._debug().held.length, 1, `seed ${seed}: the held note survived`);
    ctl.dispose();
  }
});

test('scenes.take (the views’ funnel): a field the playing scene holds goes on top of it, transient; anything else '
  + 'is the view’s own store write', async () => {
  const { store, engine, ctl, timers } = await setup();
  const id = sid(store);
  // the song's own room Stage; scene 1 = Hall, drone off
  applyPreset(SPACE_PRESETS.find((p) => p.id === 'stage'), (p, v) => store.set(p, v));
  await tick();
  const own = store.currentSong();
  const hall = SPACE_PRESETS.find((p) => p.id === 'hall').params;
  const sc = captureScene(own);
  store.set(`songs.${id}.scenes`, [{ ...sc, fx: { ...sc.fx, reverb: { size: hall['fx.reverb.size'],
    damp: hall['fx.reverb.damp'], predelay: hall['fx.reverb.predelay'], returnGain: hall['fx.reverb.returnGain'] } },
  drone: { ...sc.drone, mode: 'off' } }]);
  await tick();
  ctl.scenes.go(0);
  runSteps(timers);
  const before = store.currentSong();
  engine.clear();
  // tapping Stage in the song bar (v6 applySpace / today's applyPreset: songs.<id>.patch.fx.reverb.<row>)
  for (const [p, v] of Object.entries(SPACE_PRESETS.find((x) => x.id === 'stage').params)) {
    assert.equal(ctl.scenes.take(`songs.${id}.patch.${p}`, v), true, p);
  }
  await tick();
  assert.equal(store.currentSong(), before, 'the song is NOT written (its own room was Stage already)');
  assert.ok(engine.of('setParam').some((c) => c[1] === 'fx.reverb.size' && c[2] === 0.42), 'heard');
  assert.equal(ctl.scenes.view(store.currentSong()).patch.fx.reverb.size, 0.42);
  // the other address forms; a whole unit ("Song's own"); drone.mode
  assert.equal(ctl.scenes.take('fx.reverb.damp', 0.3), true);
  assert.equal(ctl.scenes.take('song.drone.mode', 'synth'), true);
  assert.equal(ctl.scenes.view(store.currentSong()).drone.mode, 'synth');
  assert.equal(ctl.scenes.take(`songs.${id}.patch.fx.reverb`, { ...own.patch.fx.reverb }), true);
  assert.deepEqual(ctl.scenes.view(store.currentSong()).patch.fx.reverb, own.patch.fx.reverb);
  assert.equal(ctl.scenes.take(`songs.${id}.patch.slots.0.sends.reverb`, 0.33), true);
  // not the scene's: the view writes the store itself
  assert.equal(ctl.scenes.take('fx.chorus.rate', 1), false, 'not a scene field');
  assert.equal(ctl.scenes.take(`songs.${id}.patch.slots.0.sends.chorus`, 0.1), false);
  assert.equal(ctl.scenes.take(`songs.${id}.hearIn`, 3), false, 'the key goes through adjust(drone.key)');
  assert.equal(ctl.scenes.take('songs.other.patch.fx.reverb.size', 0.1), false, 'another song');
  assert.equal(store.currentSong(), before, 'still not written');
  // Update keeps the taps; the next change drops them
  ctl.scenes.save(0);
  const saved = store.currentSong().scenes[0];
  assert.equal(saved.slots[0].sends.reverb, 0.33);
  assert.equal(saved.drone.mode, 'synth');
  assert.deepEqual(saved.fx.reverb, own.patch.fx.reverb);
  ctl.scenes.go(null);
  assert.equal(ctl.scenes.take('fx.reverb.size', 0.1), false, 'no scene plays: the store write');
  void id;
});
