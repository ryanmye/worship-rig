// v11-scenes: shared/scenes.js — the stored form, snapshot (capture), overlay (apply), level diff, stepping and the
// live moves held on top of a playing scene (tweakScene). Pure, so no engine and no store here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENE_MAX, SCENE_GLIDE_SEC, normalizeScene, normalizeScenes, scenesOf, captureScene, applyScene, levelsOf, levelDiff,
  stepScene, withScene, withoutScene, tweakScene, sceneMatches,
} from '../../../app/js/shared/scenes.js';

const slot = (gain, extra = {}) => ({ instrument: { type: 'synth', id: 'warm-pad' }, gain, pan: 0, sends: {}, params: {}, ...extra });
const song = (o = {}) => ({
  id: 's1',
  name: 'Song',
  patch: {
    slots: [slot(0.8), slot(0, { muted: true, gainBeforeMute: 0.6, mutedGain: 0.6 }), null, slot(0.5)],
    fx: { reverb: { size: 0.5 } },
    modWheel: { target: 'macro.intensity', min: 0, max: 1 },
  },
  drone: { mode: 'synth', gain: 0.5 },
  ...o,
});

test('constants: at most 3 scenes, a glide inside the agreed 300–800 ms', () => {
  assert.equal(SCENE_MAX, 3);
  assert.ok(SCENE_GLIDE_SEC >= 0.3 && SCENE_GLIDE_SEC <= 0.8);
});

test('normalizeScene / normalizeScenes: clamps, drops junk, absent when empty, idempotent', () => {
  assert.equal(normalizeScene(null), null);
  assert.equal(normalizeScene({ slots: [] }), null, 'nothing usable → null');
  const n = normalizeScene({ slots: [{ gain: 3 }, { gain: 'x' }, { gain: 0.4, muted: true }, 7, { gain: 1 }], drone: { gain: -1 }, wheel: 1.5, extra: 1 });
  assert.deepEqual(n, { slots: [{ gain: 2 }, null, { gain: 0.4, muted: true }, null], drone: { gain: 0 }, wheel: 1 });
  assert.deepEqual(normalizeScene(n), n, 'idempotent');
  assert.equal(normalizeScenes(undefined), undefined);
  assert.equal(normalizeScenes([]), undefined);
  assert.equal(normalizeScenes([null, {}]), undefined);
  const four = [n, n, n, n];
  assert.equal(normalizeScenes(four).length, SCENE_MAX);
  assert.deepEqual(normalizeScenes(normalizeScenes(four)), normalizeScenes(four));
  assert.deepEqual(scenesOf(null), []);
  assert.deepEqual(scenesOf({ scenes: [n] }), [n]);
});

test('captureScene: each filled slot’s level (pre-mute) and ON, the drone level, the wheel only when routed', () => {
  const sc = captureScene(song(), { wheel: 0.25 });
  assert.deepEqual(sc, {
    slots: [{ gain: 0.8 }, { gain: 0.6, muted: true }, null, { gain: 0.5 }], drone: { gain: 0.5 }, wheel: 0.25,
  });
  const unrouted = song();
  unrouted.patch.modWheel = { target: 'none' };
  assert.equal(captureScene(unrouted, { wheel: 0.25 }).wheel, undefined, 'a wheel that drives nothing is not kept');
  assert.equal(captureScene(song()).wheel, undefined, 'no wheel value → none');
  // the legacy mute convention (gain 0 + mutedGain, no `muted`) reads the same
  const legacy = song();
  legacy.patch.slots[1] = slot(0, { mutedGain: 0.6 });
  assert.deepEqual(captureScene(legacy).slots[1], { gain: 0.6, muted: true });
});

test('applyScene: overlays levels and mutes in the store convention, keeps everything else (fx by reference)', () => {
  const s = song();
  assert.equal(applyScene(s, null), s);
  const sc = { slots: [{ gain: 0.3, muted: true }, { gain: 0.9 }, { gain: 1 }, null], drone: { gain: 0 } };
  const out = applyScene(s, sc);
  assert.notEqual(out, s);
  assert.equal(out.patch.fx, s.patch.fx, 'fx untouched (the controller diffs it by reference)');
  assert.deepEqual(out.patch.slots[0], { ...s.patch.slots[0], gain: 0, muted: true, gainBeforeMute: 0.3, mutedGain: 0.3 });
  assert.deepEqual(out.patch.slots[1], slot(0.9), 'unmuted: the mute fields go');
  assert.equal(out.patch.slots[2], null, 'an empty slot stays empty');
  assert.equal(out.patch.slots[3], s.patch.slots[3], 'a slot the scene does not hold stays the song’s');
  assert.equal(out.drone.gain, 0);
  assert.equal(out.drone.mode, 'synth');
  assert.equal(s.patch.slots[0].gain, 0.8, 'the song itself is not changed');
  // capture(apply(s, sc)) gives back sc for the slots it holds
  assert.deepEqual(captureScene(out).slots.slice(0, 2), sc.slots.slice(0, 2));
});

test('levelsOf / levelDiff: engine levels (0 while muted) and the writes between two states', () => {
  const s = song();
  assert.deepEqual(levelsOf(s), { 'slots.0.gain': 0.8, 'slots.1.gain': 0, 'slots.3.gain': 0.5, 'drone.gain': 0.5 });
  const b = applyScene(s, { slots: [{ gain: 0.8 }, { gain: 0.6 }, null, { gain: 0.2 }], drone: { gain: 0.5 } });
  assert.deepEqual(levelDiff(levelsOf(s), levelsOf(b)), [['slots.1.gain', 0.6], ['slots.3.gain', 0.2]]);
  assert.deepEqual(levelDiff(levelsOf(s), levelsOf(s)), []);
  assert.deepEqual(levelDiff({ 'slots.0.gain': 0.5 }, { 'slots.0.gain': 0.5 + 1e-8 }), [], '1e-6 tolerance');
});

test('stepScene: one footswitch cycles own → 1 → 2 → 3 → 1; previous walks back to the own levels and stops', () => {
  assert.equal(stepScene(null, 0, 1), null, 'no scenes: nothing');
  assert.equal(stepScene(null, 3, 1), 0);
  assert.equal(stepScene(0, 3, 1), 1);
  assert.equal(stepScene(2, 3, 1), 0, 'wraps to scene 1, not to the own levels');
  assert.equal(stepScene(0, 1, 1), 0, 'one scene: stays');
  assert.equal(stepScene(2, 3, -1), 1);
  assert.equal(stepScene(0, 3, -1), null);
  assert.equal(stepScene(null, 3, -1), null);
  assert.equal(stepScene(5, 2, -1), 0, 'an index past the list (a deleted scene) is clamped first');
});

test('withScene / withoutScene: replace or add the next one, never a gap, never more than 3', () => {
  const a = { slots: [{ gain: 1 }, null, null, null] };
  const b = { slots: [{ gain: 0.5 }, null, null, null] };
  assert.deepEqual(withScene(undefined, 0, a), [a]);
  assert.equal(withScene([], 1, a), null, 'no gap');
  assert.deepEqual(withScene([a], 0, b), [b], 'replace');
  assert.deepEqual(withScene([a, a], 2, b), [a, a, b]);
  assert.equal(withScene([a, a, a], 3, b), null, 'max 3');
  assert.equal(withScene([a], 0, null), null);
  assert.deepEqual(withoutScene([a, b], 0), [b]);
  assert.deepEqual(withoutScene([a, b], 5), [a, b]);
});

test('tweakScene: live moves on top of a scene (fader, ON tile, drone level); a raised fader switches a slot on', () => {
  const live = applyScene(song(), { slots: [{ gain: 0.8 }, { gain: 0.6, muted: true }, null, null], drone: { gain: 0.5 } });
  let t = tweakScene(null, live, 'slots.0.gain', 0.4);
  assert.deepEqual(t.slots, [{ gain: 0.4 }, null, null, null]);
  t = tweakScene(t, applyScene(live, t), 'slots.1.muted', false);
  assert.deepEqual(t.slots[1], { gain: 0.6 }, 'ON tile: keeps the level');
  t = tweakScene(t, applyScene(live, t), 'drone.gain', 0.1);
  assert.deepEqual(t.drone, { gain: 0.1 });
  assert.deepEqual(t.slots[0], { gain: 0.4 }, 'earlier moves are kept');
  const raised = tweakScene(null, live, 'slots.1.gain', 0.7);
  assert.deepEqual(raised.slots[1], { gain: 0.7 }, 'fader up on a muted slot: on (the store does the same)');
  const zero = tweakScene(null, live, 'slots.1.gain', 0);
  assert.deepEqual(zero.slots[1], { gain: 0.6, muted: true }, 'fader to 0 on a muted slot: stays muted at its level');
  assert.equal(tweakScene(null, live, 'slots.2.gain', 0.5), null, 'an empty slot');
  assert.equal(tweakScene(null, live, 'fx.reverb.size', 0.5), null, 'not a level');
  assert.equal(tweakScene(null, live, 'slots.0.gain', NaN), null);
  // what you hear after the moves = scene + tweak, and Save keeps exactly that
  const heard = applyScene(live, t);
  assert.deepEqual(captureScene(heard).slots.slice(0, 2), [{ gain: 0.4 }, { gain: 0.6 }]);
  assert.equal(captureScene(heard).drone.gain, 0.1);
});

test('sceneMatches: levels and mutes (the wheel is not compared)', () => {
  const s = song();
  const sc = captureScene(s, { wheel: 0.1 });
  assert.equal(sceneMatches(sc, s), true);
  assert.equal(sceneMatches({ ...sc, wheel: 0.9 }, s), true);
  assert.equal(sceneMatches(captureScene(applyScene(s, { slots: [{ gain: 0.1 }, null, null, null] })), s), false);
  assert.equal(sceneMatches(null, s), false);
});
