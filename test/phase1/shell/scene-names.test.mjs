// D25 (UI v6 U7c, the Save snapshot dialog): an optional `name` per scene. shared/scenes.js sceneNameOf (trim, fold
// whitespace, ≤ SCENE_NAME_MAX, bad values dropped), the store (whole writes, migrate idempotent and keeping it, export
// / import, a scene with only a name is still unusable, a slot move keeps it), and the controller's save(n, {name})
// (a name for a new scene; Update keeps the name unless one is given; '' / null removes it). Also U7c's knob-first
// learn: controller.learnCapture (midi.js accept 'control') and learn(id, {heard}).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { migrate } from '../../../app/js/store.js';
import { sceneNameOf, normalizeScene, normalizeScenes, SCENE_NAME_MAX } from '../../../app/js/shared/scenes.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

async function setup() {
  const store = makeStore();
  const engine = fakeEngine();
  engine.wheelValues = () => ({ mod: 1, expr: 1, vol: 1 });
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {}; // skip init() in start()
  const ctl = createController({ store, engine, midi, recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(),
    rig: null, timers: fakeTimers(), now: () => 0 });
  await ctl.start();
  await tick();
  return { store, engine, midi, ctl };
}
const sid = (store) => store.currentSong().id;

test('sceneNameOf: trimmed, whitespace folded, cut to SCENE_NAME_MAX by code point; bad values are null', () => {
  assert.equal(SCENE_NAME_MAX, 40);
  assert.equal(sceneNameOf('  Piano + Pad,\twarmer \n'), 'Piano + Pad, warmer');
  for (const bad of [undefined, null, '', '   ', 5, true, {}, ['a'], '\u0000\u0007']) assert.equal(sceneNameOf(bad), null);
  assert.equal(sceneNameOf('x'.repeat(41)), 'x'.repeat(40));
  const emoji = `${'a'.repeat(39)}🎹🎹`;
  assert.equal(sceneNameOf(emoji), `${'a'.repeat(39)}🎹`, 'never splits a surrogate pair');
  assert.equal(sceneNameOf(`${'a'.repeat(39)} b`), 'a'.repeat(39), 'no trailing space after the cut');
});

test('normalizeScene keeps a good name and drops a bad one; a name alone is not a usable scene', () => {
  assert.deepEqual(normalizeScene({ slots: [{ gain: 0.5 }], name: ' Verse ' }),
    { slots: [{ gain: 0.5 }, null, null, null], name: 'Verse' });
  assert.deepEqual(normalizeScene({ slots: [{ gain: 0.5 }], name: 7 }), { slots: [{ gain: 0.5 }, null, null, null] });
  assert.deepEqual(normalizeScene({ slots: [{ gain: 0.5 }], name: '  ' }), { slots: [{ gain: 0.5 }, null, null, null] });
  assert.equal(normalizeScene({ name: 'Only a name' }), null);
  assert.deepEqual(normalizeScenes([{ name: 'x' }, { slots: [{ gain: 1 }], name: 'Chorus' }]),
    [{ slots: [{ gain: 1 }, null, null, null], name: 'Chorus' }]);
});

test('store: names travel with whole scene writes, migrate keeps them (idempotent), export / import keep them', () => {
  const store = makeStore();
  const id = sid(store);
  assert.equal(store.set(`songs.${id}.scenes`, [{ slots: [{ gain: 0.4 }], name: 'Quiet verse' },
    { slots: [{ gain: 0.9 }], name: 42 }]), true);
  assert.deepEqual(store.currentSong().scenes.map((s) => s.name), ['Quiet verse', undefined]);
  assert.equal(store.set(`songs.${id}.scenes.0.name`, 'x'), false, 'no nested writes (as for every scene field)');
  // migrate: a schema-1 library with names (good, bad, long) → kept / dropped / cut; then idempotent
  const raw = { schema: 1, songs: { a: { name: 'A', scenes: [{ slots: [{ gain: 0.4 }], name: '  Big   chorus ' },
    { slots: [{ gain: 0.2 }], name: null }, { slots: [{ gain: 0.3 }], name: 'y'.repeat(60) }] } } };
  const once = migrate(raw);
  assert.deepEqual(once.songs.a.scenes.map((s) => s.name), ['Big chorus', undefined, 'y'.repeat(40)]);
  assert.deepEqual(migrate(once), once, 'idempotent');
  // export → import (replace) keeps the name
  const text = store.exportJSON({ pretty: false });
  const other = makeStore();
  assert.equal(other.importJSON(text, { replace: true }).ok, true);
  assert.equal(other.getSong(id).scenes[0].name, 'Quiet verse');
  // a single-song export too
  const one = JSON.parse(store.exportSong(id));
  const songOf = (o) => (o.songs ? Object.values(o.songs)[0] : o.song || o);
  assert.equal(songOf(one).scenes[0].name, 'Quiet verse');
});

test('store: a slot move / insert keeps each scene\'s name (the entries move, the name stays)', () => {
  const store = makeStore();
  const id = sid(store);
  store.set(`songs.${id}.scenes`, [{ slots: [{ gain: 0.1 }, { gain: 0.2 }, { gain: 0.3 }, { gain: 0.4 }],
    name: 'Bridge' }]);
  assert.equal(store.moveSlot(id, 0, 2), true);
  assert.equal(store.currentSong().scenes[0].name, 'Bridge');
  assert.deepEqual(store.currentSong().scenes[0].slots.slice(0, 3).map((s) => s.gain), [0.2, 0.3, 0.1]);
  assert.ok(store.insertSlot(id, 0, null) >= 0);
  assert.equal(store.currentSong().scenes[0].name, 'Bridge');
});

test('controller.scenes.save(n, {name}): a new scene named; Update keeps the name; a new name renames; "" removes',
  async () => {
    const { store, ctl } = await setup();
    const id = sid(store);
    assert.equal(ctl.scenes.save(0, { name: '  Soft start ' }), true);
    assert.equal(store.currentSong().scenes[0].name, 'Soft start');
    // Update (no name given: the Quick sheet's Save scene n, the row's Update) keeps it
    store.set(`songs.${id}.patch.slots.0.gain`, 0.33);
    ctl.scenes.go(null);
    assert.equal(ctl.scenes.save(0), true);
    assert.equal(store.currentSong().scenes[0].name, 'Soft start');
    // a name given renames; '' / null leaves it unnamed ("Scene 1")
    assert.equal(ctl.scenes.save(0, { name: 'Intro' }), true);
    assert.equal(store.currentSong().scenes[0].name, 'Intro');
    assert.equal(ctl.scenes.save(0, { name: '' }), true);
    assert.equal('name' in store.currentSong().scenes[0], false);
    // Save as new with a name; without one: unnamed
    assert.equal(ctl.scenes.save(1, { name: 'Big' }), true);
    assert.equal(ctl.scenes.save(2), true);
    assert.deepEqual(store.currentSong().scenes.map((s) => s.name ?? null), [null, 'Big', null]);
    assert.equal(ctl.scenes.save(3, { name: 'Too many' }), false, 'SCENE_MAX stays 3');
  });

test('U7c knob first: learnCapture takes the next control (structural CCs skipped), learn(id, {heard}) stores it '
  + 'with the usual rules (kind, sustain pedal, conflicts, Lock)', async () => {
  const { store, midi, ctl } = await setup();
  // a capture: bank select / NRPN numbers are delivered normally, the next real CC is taken (and swallowed)
  const seen = [];
  midi.addEventListener('cc', (e) => seen.push(e.detail.cc));
  let p = ctl.learnCapture({ timeoutMs: 1000 });
  midi._inject([0xb0, 99, 1]);
  midi._inject([0xb0, 0, 0]);
  midi._inject([0xb0, 21, 40]);
  assert.deepEqual(await p, { cc: 21, channel: 0 });
  assert.deepEqual(seen, [99, 0], 'structural CCs played on; the learning gesture was swallowed');
  assert.deepEqual(store.get().settings.midiLearn || {}, {}, 'a capture stores nothing');
  // a key / pad is taken too
  p = ctl.learnCapture({ timeoutMs: 1000 });
  midi._inject([0x91, 36, 100]);
  assert.deepEqual(await p, { note: 36, channel: 1 });
  // CC64: the sustain pedal is reserved
  p = ctl.learnCapture({ timeoutMs: 1000 });
  midi._inject([0xb0, 64, 127]);
  assert.equal((await p).error, 'sustain-pedal-reserved');
  // cancelLearn ends a capture with null
  p = ctl.learnCapture({ timeoutMs: 1000 });
  ctl.cancelLearn();
  assert.equal(await p, null);

  // learn(id, {heard}): the same mapping as a learn that heard the knob itself
  assert.deepEqual(await ctl.learn('slots.1.gain', { heard: { cc: 21, channel: 0 } }), { cc: 21, channel: 0 });
  assert.deepEqual(store.get().settings.midiLearn['slots.1.gain'], { cc: 21, channel: 0 });
  assert.deepEqual(await ctl.learn('slots.1.sends.reverb', { heard: { cc: 21, channel: 0 } }), { cc: 21, channel: 0 },
    'faders share a CC (O-AW-ML rule 4)');
  // a fader target refuses a key / pad or a pedal switch; a button takes a key
  assert.equal((await ctl.learn('slots.0.gain', { heard: { note: 36, channel: 1 } })).error, 'needs-knob');
  assert.equal((await ctl.learn('slots.0.gain', { heard: { cc: 67, channel: 0 } })).error, 'needs-knob');
  assert.equal((await ctl.learn('panic', { heard: { cc: 64, channel: 0 } })).error, 'sustain-pedal-reserved');
  assert.deepEqual(await ctl.learn('panic', { heard: { note: 36, channel: 1 } }), { note: 36, channel: 1 });
  // C1: a button on a fader's CC takes the control (the faders are cleared and reported)
  const r = await ctl.learn('fadeOutAll', { heard: { cc: 21, channel: 0 } });
  assert.deepEqual(r.replaced.sort(), ['slots.1.gain', 'slots.1.sends.reverb']);
  assert.equal(store.get().settings.midiLearn['slots.1.gain'], undefined);
  // not learnable, a bad heard, Lock
  assert.equal((await ctl.learn('slots.0.octave', { heard: { cc: 30, channel: 0 } })).error, 'not-learnable');
  assert.equal(await ctl.learn('slots.0.gain', { heard: { cc: 300 } }), null);
  store.set('settings.performLock', true);
  assert.equal((await ctl.learn('slots.0.gain', { heard: { cc: 30, channel: 0 } })).error, 'perform-locked');
  assert.equal((await ctl.learnCapture()).error, 'perform-locked');
  store.set('settings.performLock', false);
  // the lock coming on during a capture cancels it
  p = ctl.learnCapture({ timeoutMs: 1000 });
  store.set('settings.performLock', true);
  await tick();
  const after = await p;
  assert.ok(after === null || after.error === 'perform-locked', JSON.stringify(after));
  store.set('settings.performLock', false);
  ctl.dispose?.();
});

test('skeptic UI6-U7c F1: a capture never takes the control learned to PANIC (it panics); other learns still can',
  async () => {
    const { store, midi, ctl } = await setup();
    let panics = 0;
    ctl.addEventListener('action', (e) => {
      if (e.detail?.type === 'panic') panics += 1;
    });
    store.set('settings.midiLearn', { panic: { cc: 80, channel: null } });
    let p = ctl.learnCapture({ timeoutMs: 1000 });
    midi._inject([0xb3, 80, 127]); // the PANIC footswitch on any channel: delivered, it panics
    midi._inject([0xb3, 80, 0]);
    await tick();
    assert.equal(panics, 1, 'the PANIC footswitch panicked while a capture waited');
    assert.equal(midi.learning, '(capture)', 'the capture still waits');
    midi._inject([0xb0, 21, 40]);
    assert.deepEqual(await p, { cc: 21, channel: 0 });
    // a note learned to PANIC on channel 10: that pad passes, the same note on another channel is captured
    store.set('settings.midiLearn', { panic: { note: 36, channel: 9 } });
    p = ctl.learnCapture({ timeoutMs: 1000 });
    midi._inject([0x99, 36, 100]);
    midi._inject([0x89, 36, 0]);
    await tick();
    assert.equal(panics, 2);
    midi._inject([0x90, 36, 100]);
    assert.deepEqual(await p, { note: 36, channel: 0 });
    // Settings' table learn (midi.learn without `pass`) still takes it: re-learning the PANIC control goes there
    p = midi.learn('panic', { timeoutMs: 1000, accept: 'button' });
    midi._inject([0x99, 36, 100]);
    assert.equal((await p).note, 36);
    assert.equal(panics, 2, 'that learn swallowed it, as today');
    ctl.dispose?.();
  });
