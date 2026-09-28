// L-3 (reviews/local-findings.md): controller.start() must not wait for Web MIDI. requestMIDIAccess can stay pending
// while Chrome's permission prompt is open or CoreMIDI init stalls; start() settles once audio + song are up, a
// 5 s soft timeout reports status.midi.reason = 'pending', and a late answer still attaches and selects inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MidiInput } from '../../../app/js/midi.js';
import { createController } from '../../../app/js/controller.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

const quiet = { warn: () => {} };

function port(id, name, manufacturer = '') {
  return { id, name, manufacturer, type: 'input', state: 'connected', connection: 'closed', onmidimessage: null };
}
function fakeAccess(ports) {
  const a = new EventTarget();
  a.inputs = new Map(ports.map((p) => [p.id, p]));
  return a;
}
/** navigator whose requestMIDIAccess stays pending until resolve()/reject() (never, if neither is called). */
function pendingNav() {
  const nav = { calls: 0 };
  nav.requestMIDIAccess = () => {
    nav.calls += 1;
    return new Promise((resolve, reject) => Object.assign(nav, { resolve, reject }));
  };
  return nav;
}
const within = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} did not settle within ${ms} ms`)), ms))]);

function setup(nav, { store = makeStore(), timers = fakeTimers(), midiInitTimeoutMs } = {}) {
  const engine = fakeEngine();
  const midi = new MidiInput({ nav, ...quiet });
  const ctl = createController({
    store, engine, midi, recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(), rig: null, timers,
    now: () => 0, midiInitTimeoutMs,
  });
  const statuses = [];
  ctl.addEventListener('status', (e) => statuses.push(e.detail.midi));
  return { engine, midi, ctl, timers, store, statuses };
}

test('L-3: start() resolves within 1 s while requestMIDIAccess never answers; song and audio are up', async () => {
  const nav = pendingNav();
  const { ctl, engine, midi } = setup(nav);
  const t0 = Date.now();
  await within(ctl.start(), 1000, 'controller.start()');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(nav.calls, 1, 'MIDI init was requested during start');
  await tick(); // preloadSetlist (not awaited by start either) flips status.ready
  assert.equal(ctl.status.ready, true, 'song ready');
  assert.ok(engine.of('start').length === 1 && engine.of('commit').length >= 1, 'audio started and the song committed');
  assert.equal(midi.access, null);
  assert.equal(ctl.status.midi.available, false);
  assert.equal(ctl.status.midi.reason, null, 'no reason before the soft timeout');
  ctl.dispose();
});

test('L-3: soft timeout → status.midi {available:false, reason:"pending", pending:true}; timer is 5 s by default', async () => {
  const nav = pendingNav();
  const { ctl, timers, statuses } = setup(nav);
  await ctl.start();
  const soft = [...timers.timeouts.values()].filter((t) => t.ms === 5000);
  assert.equal(soft.length, 1, 'one 5 s MIDI soft-timeout timer');
  timers.runTimeouts();
  assert.deepEqual(
    [ctl.status.midi.available, ctl.status.midi.connected, ctl.status.midi.reason, ctl.status.midi.pending],
    [false, false, 'pending', true],
  );
  assert.equal(statuses.at(-1).reason, 'pending', "reported through the 'status' event");
  ctl.dispose();
});

test('L-3: late resolution after the soft timeout attaches the chosen input, wires onmidimessage, clears pending', async () => {
  const nav = pendingNav();
  const store = makeStore();
  const a = port('a', 'Arturia KeyLab 61', 'Arturia');
  const b = port('b', 'USB MIDI Interface');
  store.set('settings.midiInputId', 'b'); // explicit choice: the lower-ranked port must still win
  const { ctl, engine, midi, timers } = setup(nav, { store });
  await ctl.start();
  timers.runTimeouts();
  assert.equal(ctl.status.midi.reason, 'pending');
  let settledMidi = null;
  ctl.midiReady().then((v) => (settledMidi = v));
  nav.resolve(fakeAccess([a, b]));
  await tick();
  await tick();
  assert.equal(settledMidi, true, 'midiReady() resolves true after the late answer');
  assert.equal(midi.available, true);
  assert.equal(typeof b.onmidimessage, 'function', 'the chosen port is listened to');
  assert.equal(a.onmidimessage, null, 'the other port is not');
  assert.equal(midi.selection, 'b');
  const m = ctl.status.midi;
  assert.deepEqual([m.available, m.connected, m.name, m.reason, m.pending], [true, true, 'USB MIDI Interface', null, false]);
  engine.clear();
  b.onmidimessage({ data: new Uint8Array([0x90, 60, 100]), timeStamp: 1 });
  b.onmidimessage({ data: new Uint8Array([0x80, 60, 0]), timeStamp: 2 });
  assert.equal(engine.of('noteOn').length, 1, 'a note from the late-attached port reaches the engine');
  assert.equal(engine.of('noteOn')[0][1], 60);
  assert.equal(engine.of('noteOff').length, 1);
  ctl.dispose();
});

test('L-3: late resolution BEFORE the soft timeout: no "pending" ever shown, and the timer is cleared', async () => {
  const nav = pendingNav();
  const { ctl, timers, statuses } = setup(nav);
  await ctl.start();
  nav.resolve(fakeAccess([port('k', 'Roland Digital Piano')]));
  await tick();
  assert.equal([...timers.timeouts.values()].filter((t) => t.ms === 5000).length, 0, 'soft timer cleared');
  timers.runTimeouts();
  assert.ok(statuses.every((m) => m.reason !== 'pending'));
  assert.equal(ctl.status.midi.connected, true);
  ctl.dispose();
});

test('L-3: messages injected while init is pending still play (handlers are wired before MIDI answers)', async () => {
  const nav = pendingNav();
  const { ctl, engine, midi } = setup(nav);
  await ctl.start();
  engine.clear();
  midi._inject([0x90, 64, 90]);
  midi._inject([0x90, 64, 0]);
  assert.equal(engine.of('noteOn').length, 1);
  assert.equal(engine.of('noteOff').length, 1);
  ctl.dispose();
});

test('L-3: a pending request that is later denied surfaces reason "denied" (pending cleared); unsupported too', async () => {
  const nav = pendingNav();
  const { ctl, timers } = setup(nav);
  await ctl.start();
  timers.runTimeouts();
  assert.equal(ctl.status.midi.reason, 'pending');
  const err = new Error('Permission denied');
  err.name = 'NotAllowedError';
  nav.reject(err);
  assert.equal(await within(ctl.midiReady(), 1000, 'midiReady()'), false);
  assert.deepEqual([ctl.status.midi.available, ctl.status.midi.reason, ctl.status.midi.pending], [false, 'denied', false]);
  ctl.dispose();

  const u = setup({}); // navigator without requestMIDIAccess
  await within(u.ctl.start(), 1000, 'controller.start()');
  assert.equal(u.ctl.status.midi.reason, 'unsupported');
  assert.equal(await u.ctl.midiReady(), false);
  u.ctl.dispose();
});

test('L-3: dispose() while pending → a late answer neither re-selects nor reaches the engine/status', async () => {
  const nav = pendingNav();
  const store = makeStore();
  store.set('settings.midiInputId', 'all');
  const { ctl, timers, engine, midi, statuses } = setup(nav, { store });
  await ctl.start();
  ctl.dispose();
  assert.equal([...timers.timeouts.values()].filter((t) => t.ms === 5000).length, 0, 'soft timer dropped');
  const k = port('k', 'Roland Digital Piano');
  nav.resolve(fakeAccess([k]));
  await tick();
  // MidiInput.init() itself attaches its default ('first') pick; the controller's select() must not run any more
  assert.equal(midi.selection, 'first', "the disposed controller did not apply settings.midiInputId ('all')");
  engine.clear();
  k.onmidimessage?.({ data: new Uint8Array([0x90, 60, 100]), timeStamp: 1 });
  assert.equal(engine.of('noteOn').length, 0, 'nothing reaches the engine after dispose');
  assert.ok(statuses.every((m) => !m.available), 'the late grant never reached controller.status.midi');
  assert.equal(ctl.status.midi.available, false);
});

test('L-3: real timers: status flips to pending after midiInitTimeoutMs, and back to connected on a late answer', async () => {
  const nav = pendingNav();
  const timers = {
    setTimeout: (...a) => setTimeout(...a), clearTimeout: (i) => clearTimeout(i),
    setInterval: () => 0, clearInterval: () => {},
  };
  const { ctl } = setup(nav, { timers, midiInitTimeoutMs: 40 });
  await within(ctl.start(), 1000, 'controller.start()');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(ctl.status.midi.reason, 'pending');
  nav.resolve(fakeAccess([port('k', 'Korg microKEY')]));
  await tick();
  assert.deepEqual([ctl.status.midi.connected, ctl.status.midi.reason], [true, null]);
  ctl.dispose();
});
