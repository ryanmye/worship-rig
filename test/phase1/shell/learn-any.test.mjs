// 2.x step 5 (FX-gap-analysis "MIDI learn", DECISIONS O-AW-ML): MIDI learn for any continuous PARAMS path.
// Store: validation of ids and fields, migrate idempotence, the 1.x format, export / import. Controller: the CC
// mapping and curve, invert / range, the scope rule (follows the current song), pickup, the write throttle, several
// params on one CC, learn() and Perform Lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController, LEARN_WRITE_MS } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { migrate } from '../../../app/js/store.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

const near = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) < eps, msg || `${a} ≈ ${b}`);
const cc = (n, v, ch = 0) => [0xb0 | ch, n, v];

async function setup(opts = {}) {
  const store = opts.store || makeStore();
  const engine = fakeEngine();
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const timers = fakeTimers();
  const clock = { t: 1000 };
  const warns = [];
  const ctl = createController({ store, engine, midi, recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(),
    rig: null, timers, now: () => clock.t });
  ctl.addEventListener('warn', (e) => warns.push(e.detail.message));
  await ctl.start();
  /** inject a CC with the clock moved past the write window (so every message writes at once) */
  const send = (n, v, ch = 0) => {
    clock.t += LEARN_WRITE_MS + 1;
    midi._inject(cc(n, v, ch));
  };
  return { store, engine, midi, timers, clock, ctl, warns, send };
}

// ------------------------------------------------------------------------------------------------- store
test('store.setMidiLearn: custom paths take a CC with min / max / invert; bad paths and notes are refused', () => {
  const warns = [];
  const s = makeStore({ warn: (m) => warns.push(m) });
  assert.equal(s.setMidiLearn('fx.delay.feedback', { cc: 21, channel: 0, min: 0.1, max: 0.5, invert: true }), true);
  assert.deepEqual(s.get().settings.midiLearn['fx.delay.feedback'], { cc: 21, channel: 0, min: 0.1, max: 0.5,
    invert: true });
  assert.equal(s.setMidiLearn('slots.7.sends.reverb', { cc: 22, channel: null }), true, 'any slot below 16');
  for (const bad of ['slots.0.mono', 'slots.0.octave', 'slots.0.sustain', 'fx.nope.x', 'slots.16.sends.reverb',
    'slots.0.params.cutoff', 'fx.delay.sync', 'not a control']) {
    assert.equal(s.setMidiLearn(bad, { cc: 30, channel: 0 }), false, bad);
    assert.equal(s.get().settings.midiLearn[bad], undefined, bad);
  }
  assert.equal(s.setMidiLearn('fx.delay.feedback', { note: 40, channel: 0 }), false, 'a param takes a CC, not a note');
  assert.equal(s.setMidiLearn('nextSong', { note: 40, channel: 0 }), true, 'buttons still take notes');
  assert.equal(s.setMidiLearn('fx.reverb.size', { cc: 64, channel: 0 }), false, 'CC64 stays the sustain pedal');
  assert.ok(warns.some((w) => /not a learnable control/.test(w)));
  // clearing takes any id (an odd key from an import can always be removed)
  assert.equal(s.setMidiLearn('fx.delay.feedback', null), true);
  assert.equal(s.get().settings.midiLearn['fx.delay.feedback'], undefined);
});

test('store: a mapping\'s fields are validated (clamped / dropped) on every write path', () => {
  const s = makeStore();
  s.set('settings.midiLearn', {
    'fx.delay.feedback': { cc: 21, channel: 0, min: -4, max: 'high', invert: 'yes' },
    'slots.0.eq.b2.hz': { cc: 22, channel: 3, min: 200, max: 99999, invert: true },
    nextSong: { note: 36, channel: 9, invert: 'kept: a button is not a path' },
  });
  const ml = s.get().settings.midiLearn;
  assert.deepEqual(ml['fx.delay.feedback'], { cc: 21, channel: 0, min: 0 });
  assert.deepEqual(ml['slots.0.eq.b2.hz'], { cc: 22, channel: 3, min: 200, max: 20000, invert: true });
  assert.deepEqual(ml.nextSong, { note: 36, channel: 9, invert: 'kept: a button is not a path' });
});

test('migrate: the 1.x format reads unchanged, custom mappings survive, idempotent', () => {
  const raw = {
    schema: 1, songs: {}, songOrder: [], setlists: {}, setlistOrder: [],
    settings: {
      midiLearn: {
        'slots.1.gain': { cc: 20, channel: null },
        nextSong: { note: 36, channel: 9 },
        'fx.delay.feedback': { cc: 21, channel: 0, min: 0.1, max: 2, invert: true, future: 1 },
        'some.future.id': { cc: 23, channel: 0, min: 'odd' },
      },
    },
    meta: {},
  };
  const a = migrate(structuredClone(raw));
  const ml = a.settings.midiLearn;
  assert.deepEqual(ml['slots.1.gain'], { cc: 20, channel: null }, '1.x fader row as it was');
  assert.deepEqual(ml.nextSong, { note: 36, channel: 9 });
  assert.deepEqual(ml['fx.delay.feedback'], { cc: 21, channel: 0, min: 0.1, max: 0.9, invert: true, future: 1 });
  assert.deepEqual(ml['some.future.id'], { cc: 23, channel: 0, min: 'odd' }, 'an unknown id keeps its fields');
  assert.equal(a.schema, 2, 'no SCHEMA bump: still 2');
  const b = migrate(structuredClone(a));
  assert.deepEqual(b.settings.midiLearn, a.settings.midiLearn, 'idempotent');
  assert.deepEqual(migrate(structuredClone(b)), b);
});

test('export / import: custom mappings travel with the library (replace) with their fields', () => {
  const a = makeStore();
  a.setMidiLearn('slots.1.sends.reverb', { cc: 25, channel: 2, min: 0.1, max: 0.8, invert: true });
  a.setMidiLearn('fx.chorus.rate', { cc: 26, channel: null });
  const text = a.exportJSON();
  const b = makeStore();
  const r = b.importJSON(text, { replace: true });
  assert.ok(r && r.ok !== false, JSON.stringify(r));
  assert.deepEqual(b.get().settings.midiLearn['slots.1.sends.reverb'], { cc: 25, channel: 2, min: 0.1, max: 0.8,
    invert: true });
  assert.deepEqual(b.get().settings.midiLearn['fx.chorus.rate'], { cc: 26, channel: null });
});

// ------------------------------------------------------------------------------------------------- controller
test('a CC learned to a param moves it along the row (linear), with pickup, and reaches the engine', async () => {
  const { store, engine, send } = await setup();
  store.set('fx.delay.feedback', 0.45); // cc position 0.5
  store.setMidiLearn('fx.delay.feedback', { cc: 21, channel: 0 });
  await tick();
  engine.clear();
  const fb = () => store.currentSong().patch.fx.delay.feedback;
  send(21, 0);
  send(21, 30);
  assert.equal(fb(), 0.45, 'pickup: below the stored value, ignored');
  send(21, 100); // crossed 0.5
  near(fb(), 0.9 * (100 / 127));
  send(21, 127);
  near(fb(), 0.9);
  await tick();
  const sets = engine.of('setParam').filter((c) => c[1] === 'fx.delay.feedback');
  assert.ok(sets.length >= 1, 'the store → engine diff sent it');
  near(sets.at(-1)[2], 0.9);
  // moved on screen → pickup resets until the knob crosses again
  store.set('fx.delay.feedback', 0.1);
  send(21, 120);
  assert.equal(fb(), 0.1);
});

test('log rows, taper rows, invert and per-mapping range', async () => {
  const { store, send } = await setup();
  const slot0 = () => store.currentSong().patch.slots[0];
  // log: a bell frequency 200 Hz .. 5 kHz; stored value absent → the row default (640 Hz) is the pickup point
  store.setMidiLearn('slots.0.eq.b4.hz', { cc: 30, channel: 0, min: 200, max: 5000 });
  send(30, 0);
  send(30, 127); // crossed 640 Hz
  near(slot0().eq.b4.hz, 5000, 1e-6);
  send(30, 64);
  near(slot0().eq.b4.hz, Math.exp(Math.log(200) + (64 / 127) * (Math.log(5000) - Math.log(200))), 1e-6);
  // taper: Delay level (dB-display) is 2·pos³, as a learned level fader
  store.set('fx.delay.returnGain', 0);
  store.setMidiLearn('fx.delay.returnGain', { cc: 31, channel: 0 });
  send(31, 0);
  send(31, 90);
  near(store.currentSong().patch.fx.delay.returnGain, 2 * (90 / 127) ** 3);
  // invert: the knob up turns the send down
  store.set('slots.0.sends.reverb', 1);
  store.setMidiLearn('slots.0.sends.reverb', { cc: 32, channel: 0, invert: true });
  send(32, 0); // inverted position of 1 is 0: picked up at once
  near(slot0().sends.reverb, 1);
  send(32, 127);
  near(slot0().sends.reverb, 0);
});

test('scope rule: a mapping follows the current song; a slot the song lacks is a no-op', async () => {
  const { store, ctl, send, warns } = await setup();
  store.setMidiLearn('slots.1.sends.reverb', { cc: 40, channel: 0 });
  const first = store.get().settings.currentSongId;
  store.set('slots.1.sends.reverb', 0);
  send(40, 0);
  send(40, 64);
  near(store.getSong(first).patch.slots[1].sends.reverb, 64 / 127);
  // the next song: the same knob now moves *its* slot 1, and the first song keeps its value
  await ctl.nextSong();
  await tick();
  const second = store.get().settings.currentSongId;
  assert.notEqual(second, first);
  store.set('slots.1.sends.reverb', 0);
  send(40, 0);
  send(40, 100);
  near(store.getSong(second).patch.slots[1].sends.reverb, 100 / 127);
  near(store.getSong(first).patch.slots[1].sends.reverb, 64 / 127, 1e-9, 'the first song is untouched');
  // a slot past the song's count
  store.setMidiLearn('slots.9.sends.reverb', { cc: 41, channel: 0 });
  const before = JSON.stringify(store.currentSong());
  send(41, 0);
  send(41, 127);
  assert.equal(JSON.stringify(store.currentSong()), before, 'nothing written');
  assert.deepEqual(warns.filter((w) => /slots\.9/.test(w)), [], 'and no warning');
});

test('throttle: one store write per LEARN_WRITE_MS, then the last value; a song switch drops it', async () => {
  const { store, timers, clock, midi, ctl } = await setup();
  store.set('fx.reverb.size', 0);
  store.setMidiLearn('fx.reverb.size', { cc: 50, channel: 0 });
  let writes = 0;
  const off = store.subscribe((_s, paths) => {
    if (paths.some((p) => p.endsWith('.patch.fx.reverb.size'))) writes++;
  });
  clock.t += 100;
  midi._inject(cc(50, 0)); // pickup at 0, writes 0 (unchanged: no notify)
  for (let v = 1; v <= 60; v++) midi._inject(cc(50, v)); // same instant: one window
  await tick();
  near(store.currentSong().patch.fx.reverb.size, 0, 1e-9, 'the window\'s first message wrote; the rest wait');
  assert.equal(timers.timeouts.size >= 1, true, 'a trailing write is scheduled');
  timers.runTimeouts();
  await tick();
  near(store.currentSong().patch.fx.reverb.size, 60 / 127, 1e-9, 'the trailing write lands the last value');
  assert.ok(writes <= 2, `≤ 2 store notifies for 61 messages (got ${writes})`);
  // pickup keeps tracking through the throttled value (it would otherwise read the stale store and drop the knob)
  clock.t += 1;
  midi._inject(cc(50, 61));
  midi._inject(cc(50, 70));
  timers.runTimeouts();
  near(store.currentSong().patch.fx.reverb.size, 70 / 127);
  // a song switch drops a pending write: it belonged to the song it was played on
  clock.t += 1;
  midi._inject(cc(50, 80));
  const first = store.get().settings.currentSongId;
  await ctl.nextSong();
  await tick();
  timers.runTimeouts();
  near(store.getSong(first).patch.fx.reverb.size, 70 / 127, 1e-9, 'the pending 80 was dropped');
  off();
});

test('one CC can drive several params; a fixed row keeps writing on every message (1.x)', async () => {
  const { store, clock, midi, send } = await setup();
  store.set('fx.delay.feedback', 0);
  store.set('slots.0.sends.delay', 0);
  store.setMidiLearn('fx.delay.feedback', { cc: 60, channel: null });
  store.setMidiLearn('slots.0.sends.delay', { cc: 60, channel: 0, max: 0.5 });
  send(60, 0);
  send(60, 127);
  near(store.currentSong().patch.fx.delay.feedback, 0.9);
  near(store.currentSong().patch.slots[0].sends.delay, 0.5);
  // fixed row: no throttle, every message lands at the same instant
  store.set('slots.1.gain', 0);
  store.setMidiLearn('slots.1.gain', { cc: 61, channel: 0 });
  clock.t += 100;
  midi._inject(cc(61, 0));
  midi._inject(cc(61, 50));
  near(store.currentSong().patch.slots[1].gain, 2 * (50 / 127) ** 3);
  midi._inject(cc(61, 60));
  near(store.currentSong().patch.slots[1].gain, 2 * (60 / 127) ** 3);
});

test('an optional row with no number (release = the instrument\'s own) is taken over at once', async () => {
  const { store, send } = await setup();
  assert.equal(store.currentSong().patch.slots[0].release, undefined);
  store.setMidiLearn('slots.0.release', { cc: 70, channel: 0 });
  send(70, 0);
  near(store.currentSong().patch.slots[0].release, 0.05);
});

test('learn(): any continuous path, keeps an earlier range; refuses others; Perform Lock blocks it', async () => {
  const { store, midi, ctl, send } = await setup();
  store.setMidiLearn('fx.delay.feedback', { cc: 21, channel: 0, min: 0.2, invert: true });
  let p = ctl.learn('fx.delay.feedback');
  assert.equal(midi.learning, 'fx.delay.feedback');
  midi._inject(cc(33, 10, 1));
  assert.deepEqual(await p, { cc: 33, channel: 1, min: 0.2, invert: true });
  assert.deepEqual(store.get().settings.midiLearn['fx.delay.feedback'], { cc: 33, channel: 1, min: 0.2, invert: true });
  // a fader-type learn ignores notes (a param takes a knob)
  p = ctl.learn('slots.0.pan');
  midi._inject([0x90, 60, 100]);
  assert.equal(midi.learning, 'slots.0.pan', 'a note does not complete a param learn');
  midi._inject(cc(34, 64));
  assert.deepEqual(await p, { cc: 34, channel: 0 });
  assert.deepEqual(await ctl.learn('slots.0.mono'), { error: 'not-learnable' });
  assert.deepEqual(await ctl.learn('slots.0.params.cutoff'), { error: 'not-learnable' });
  assert.equal(midi.learning, null);
  // Perform Lock: nothing is learned, a pending learn is cancelled, learned knobs still play
  store.set('settings.performLock', true);
  await tick();
  assert.deepEqual(await ctl.learn('fx.reverb.size'), { error: 'perform-locked' });
  assert.equal(midi.learning, null);
  store.set('settings.performLock', false);
  await tick();
  p = ctl.learn('fx.reverb.size');
  assert.equal(midi.learning, 'fx.reverb.size');
  store.set('settings.performLock', true);
  await tick();
  assert.equal(await p, null, 'cancelled by the lock');
  assert.equal(midi.learning, null);
  assert.equal(store.get().settings.midiLearn['fx.reverb.size'], undefined);
  store.set('slots.0.pan', 0);
  send(34, 64);
  send(34, 127);
  near(store.currentSong().patch.slots[0].pan, 1, 1e-9, 'a learned knob works under the lock');
});

// ----------------------------------------------------------------------------------------- skeptic fixes
test('C1: a learn takes its CC from a button (and a button from faders); faders still share', async () => {
  const { store, midi, ctl, send } = await setup();
  store.setMidiLearn('nextSong', { cc: 20, channel: 0 });
  store.setMidiLearn('fx.delay.feedback', { cc: 22, channel: null });
  // a knob learned on the footswitch's CC: before the fix it sat dead behind 'nextSong' (first match is a button)
  let p = ctl.learn('slots.1.sends.reverb');
  midi._inject(cc(20, 10));
  assert.deepEqual(await p, { cc: 20, channel: 0, replaced: ['nextSong'] });
  assert.equal(store.get().settings.midiLearn.nextSong, undefined);
  store.set('slots.1.sends.reverb', 0);
  send(20, 0);
  send(20, 127);
  near(store.currentSong().patch.slots[1].sends.reverb, 1, 1e-9, 'the knob now moves the send');
  // another fader on the same CC shares it (rule 4): nothing replaced
  p = ctl.learn('fx.reverb.size');
  midi._inject(cc(20, 5));
  assert.deepEqual(await p, { cc: 20, channel: 0 });
  assert.ok(store.get().settings.midiLearn['slots.1.sends.reverb']);
  // a button learned on a CC with faders (any channel overlaps) clears them
  p = ctl.learn('panic');
  midi._inject(cc(22, 127, 3));
  assert.deepEqual(await p, { cc: 22, channel: 3, replaced: ['fx.delay.feedback'] });
  // another channel does not overlap
  store.setMidiLearn('fx.chorus.depth', { cc: 23, channel: 1 });
  p = ctl.learn('prevSong');
  midi._inject(cc(23, 127, 2));
  assert.deepEqual(await p, { cc: 23, channel: 2 });
  assert.ok(store.get().settings.midiLearn['fx.chorus.depth']);
});

test('S1: across a song switch still loading, an old pending write never lands and pickup starts again', async () => {
  const { store, timers, clock, midi, ctl } = await setup();
  const first = store.get().settings.currentSongId;
  store.set('fx.reverb.size', 0);
  store.setMidiLearn('fx.reverb.size', { cc: 50, channel: 0 });
  clock.t += 100;
  midi._inject(cc(50, 0)); // picked at 0, writes
  midi._inject(cc(50, 90)); // same window: pending 90
  // the store selects the next song at once; its load (and the commit's dropLearnWrites) comes later
  const order = store.get().songOrder;
  const second = order[(order.indexOf(first) + 1) % order.length];
  store.set(`songs.${second}.patch.fx.reverb.size`, 0.5);
  store.selectSongId(second);
  timers.runTimeouts();
  near(store.getSong(second).patch.fx.reverb.size, 0.5, 1e-9, 'the old song\'s 90 did not land on the new one');
  near(store.getSong(first).patch.fx.reverb.size, 0, 1e-9);
  // the knob, picked up on the old song, has to cross the new song's value first
  clock.t += 100;
  midi._inject(cc(50, 20));
  near(store.getSong(second).patch.fx.reverb.size, 0.5, 1e-9, 'not picked up yet');
  clock.t += 100;
  midi._inject(cc(50, 100)); // crosses 0.5
  timers.runTimeouts();
  near(store.getSong(second).patch.fx.reverb.size, 100 / 127, 1e-9);
  void ctl;
});

test('M1: a fader / button learn skips bank select, data entry and NRPN / RPN CCs', async () => {
  const { midi, ctl } = await setup();
  let p = ctl.learn('fx.delay.feedback');
  // an NRPN knob: 99, 98 (parameter number), 6, 38 (data); a PC pedal: 0, 32 (bank) first
  for (const [n, v] of [[99, 1], [98, 20], [6, 64], [38, 0], [0, 0], [32, 0], [100, 0], [101, 0], [96, 1], [97, 1]]) {
    midi._inject(cc(n, v));
    assert.equal(midi.learning, 'fx.delay.feedback', `CC ${n} does not complete the learn`);
  }
  midi._inject(cc(74, 30));
  assert.deepEqual(await p, { cc: 74, channel: 0 });
  p = ctl.learn('nextSong');
  midi._inject(cc(0, 127));
  midi._inject(cc(99, 127));
  assert.equal(midi.learning, 'nextSong');
  midi._inject(cc(80, 127));
  assert.deepEqual(await p, { cc: 80, channel: 0 });
});

test('L1: a knob on Pedal hold picks up at natural (top), fades below, and gets back to natural', async () => {
  const { store, send, timers } = await setup();
  assert.equal(store.currentSong().patch.slots[0].pedalHold, undefined);
  store.setMidiLearn('slots.0.pedalHold', { cc: 71, channel: 0 });
  send(71, 60); // natural sits at the top: the knob at 60 has not crossed it
  assert.equal(store.currentSong().patch.slots[0].pedalHold, undefined);
  send(71, 127);
  send(71, 0);
  near(store.currentSong().patch.slots[0].pedalHold, 2);
  send(71, 127);
  timers.runTimeouts();
  assert.equal(store.currentSong().patch.slots[0].pedalHold, undefined, 'the top removes the field (natural)');
});
