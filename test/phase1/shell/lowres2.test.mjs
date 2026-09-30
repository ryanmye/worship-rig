// lowres2 (CONTRACT_CHANGES "## lowres2"): settings.audioSleepSec validation, the controller's input-activity clock
// and audio sleep (engine.sleep / wake, status.audio 'asleep' on the bus), and midi.js's 'input' hook.
// lowres2-scope (Ryan 2026-09-30): audio sleep runs ONLY in low-resource mode (settings.lowResource, or auto while
// hidden in menu-bar mode); normal play never sleeps; leaving low-resource wakes at once; a popover `hello` is not
// input (lowres2-critic R2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../../app/js/controller.js';
import {
  AUDIO_SLEEP_DEFAULT_SEC, AUDIO_SLEEP_MAX_SEC, DEVICE_LOCAL_SETTINGS, audioSleepSecOf, memoryStorage, STORAGE_KEY,
} from '../../../app/js/store.js';
import { stateError, AUDIO_STATES } from '../../../app/js/shared/bus.js';
import { MidiInput } from '../../../app/js/midi.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, key, tick } from './helpers.mjs';

// ---- store ------------------------------------------------------------------------------------------------------
test('store: settings.audioSleepSec is optional (default 30), numbers are rounded and clamped, the rest refused', () => {
  const s = makeStore();
  assert.equal('audioSleepSec' in s.get().settings, false, 'absent by default');
  assert.equal(audioSleepSecOf(s.get().settings), AUDIO_SLEEP_DEFAULT_SEC);
  assert.equal(AUDIO_SLEEP_DEFAULT_SEC, 30);
  for (const [v, want] of [[120, 120], [0, 0], [2.4, 2], [-5, 0], [99999, AUDIO_SLEEP_MAX_SEC], [30, 30]]) {
    s.set('settings.audioSleepSec', v);
    assert.equal(s.get().settings.audioSleepSec, want, `set ${v}`);
    assert.equal(audioSleepSecOf(s.get().settings), want);
  }
  for (const bad of ['60', null, true, {}, NaN, Infinity]) {
    s.set('settings.audioSleepSec', bad);
    assert.equal(s.get().settings.audioSleepSec, 30, `refused ${String(bad)}`);
  }
  s.set('settings.audioSleepSec.x', 5);
  assert.equal(s.get().settings.audioSleepSec, 30, 'no sub-path');
  assert.ok(DEVICE_LOCAL_SETTINGS.includes('audioSleepSec'), 'machine behaviour, kept across a replace-import');
  assert.equal(audioSleepSecOf({ audioSleepSec: 'x' }), 30);
  assert.equal(audioSleepSecOf(null), 30);
});

test('store: a stored invalid audioSleepSec is dropped on load, a valid one kept', () => {
  for (const [stored, want] of [['abc', undefined], [45.6, 46], [-1, 0]]) {
    const st = memoryStorage();
    const a = makeStore({ storage: st });
    a.set('settings.audioSleepSec', 30);
    a.persistNow();
    const raw = JSON.parse(st.getItem(STORAGE_KEY));
    raw.settings.audioSleepSec = stored;
    st.setItem(STORAGE_KEY, JSON.stringify(raw));
    const b = makeStore({ storage: st });
    assert.equal(b.get().settings.audioSleepSec, want, JSON.stringify(stored));
  }
});

// ---- bus ----------------------------------------------------------------------------------------------------------
test("bus: 'asleep' is a contract v1 audio state", () => {
  assert.ok(AUDIO_STATES.includes('asleep'));
});

// ---- controller ---------------------------------------------------------------------------------------------------
/** fakeEngine + the lowres2 sleep API (sleep/wake/sleepState/sleepBlockers, 'sleep' events). */
function sleepyEngine() {
  const e = fakeEngine();
  e.sleepState = 'awake';
  e.blockers = [];
  e.sleepBlockers = () => e.blockers.slice();
  e.sleep = () => {
    e.calls.push(['sleep']);
    e.sleepState = 'asleep';
    e.ctx = { ...e.ctx, state: 'suspended' };
    e.dispatchEvent(new CustomEvent('sleep', { detail: { state: 'asleep' } }));
    return Promise.resolve(true);
  };
  e.wake = () => {
    e.calls.push(['wake']);
    if (e.sleepState === 'awake') return Promise.resolve(false);
    e.sleepState = 'awake';
    e.ctx = { ...e.ctx, state: 'running' };
    e.dispatchEvent(new CustomEvent('sleep', { detail: { state: 'awake', wakeMs: 3 } }));
    return Promise.resolve(true);
  };
  return e;
}
function fakeBus() {
  let cb = null;
  return {
    sent: [],
    lastState: null,
    publish(st) {
      this.lastState = st;
      this.sent.push(st);
    },
    flush() {},
    onCommand(f) {
      cb = f;
      return () => (cb = null);
    },
    close() {},
    send(cmd) {
      if (cb) cb(cmd);
    },
  };
}
async function setup({ sleepSec, recorder = null, lowResource = true } = {}) {
  const store = makeStore();
  if (sleepSec !== undefined) store.set('settings.audioSleepSec', sleepSec);
  if (lowResource) store.set('settings.lowResource', true); // lowres2-scope: sleep only runs in low-resource mode
  const engine = sleepyEngine();
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const doc = fakeDoc();
  const timers = fakeTimers();
  let t = 1000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const bus = fakeBus();
  const ctl = createController({
    store, engine, midi, recorder, doc, nav: null, win: new EventTarget(), rig: null, timers, now: clock.now, bus,
    autoRestart: false,
  });
  await ctl.start();
  await tick();
  return { store, engine, midi, doc, timers, clock, bus, ctl };
}
const idle = (x, ms) => {
  x.clock.advance(ms);
  if (x.engine.ctx.state === 'running') x.engine.ctx.currentTime += ms / 1000; // the audio clock runs (no stall)
  x.timers.runIntervals(); // the watchdog tick runs the sleep check
};

test('controller (lowres2-scope): normal play NEVER sleeps, whatever audioSleepSec and however long idle', async () => {
  for (const sleepSec of [undefined, 2, 30]) {
    const x = await setup({ sleepSec, lowResource: false });
    assert.equal(x.ctl.status.lowResource, false);
    idle(x, 30000);
    idle(x, 600000);
    assert.equal(x.engine.of('sleep').length, 0, `no sleep in normal mode (audioSleepSec ${sleepSec})`);
    assert.equal(x.engine.sleepState, 'awake');
    assert.equal(x.ctl.status.audio, 'running');
    assert.equal(x.ctl._sleepDebug().lowResource, false);
    x.ctl.dispose();
  }
});

test('controller (lowres2-scope): the idle window starts when low-resource turns on; leaving it wakes at once', async () => {
  const x = await setup({ sleepSec: 2, lowResource: false });
  idle(x, 60000); // long idle in normal play
  assert.equal(x.engine.of('sleep').length, 0);
  x.ctl.setLowResource(true);
  assert.equal(x.ctl.status.lowResource, true);
  idle(x, 1000);
  assert.equal(x.engine.of('sleep').length, 0, 'not at once: the window counts from low-resource on');
  idle(x, 1100);
  assert.equal(x.engine.of('sleep').length, 1, 'asleep audioSleepSec after low-resource on');
  assert.equal(x.engine.sleepState, 'asleep');
  const w = x.engine.of('wake').length;
  x.ctl.setLowResource(false); // leaving low-resource: awake now, no input needed
  assert.equal(x.engine.of('wake').length, w + 1, 'woken by leaving low-resource');
  assert.equal(x.engine.sleepState, 'awake');
  assert.equal(x.ctl.status.audio, 'running');
  idle(x, 60000);
  assert.equal(x.engine.of('sleep').length, 1, 'and it stays awake in normal play');
  // auto low-resource (menu-bar mode, window hidden) counts too, and showing the window wakes
  x.store.set('settings.menuBarMode', true);
  x.ctl.setWindowVisible(false);
  assert.equal(x.ctl.status.lowResource, true);
  idle(x, 2100);
  assert.equal(x.engine.sleepState, 'asleep', 'auto low-resource sleeps');
  x.ctl.setWindowVisible(true);
  assert.equal(x.engine.sleepState, 'awake', 'window shown → awake');
  x.ctl.dispose();
});

test('controller (lowres2-critic R2): a popover hello / popoverShown neither wakes the audio nor ends low-resource', async () => {
  const x = await setup({ sleepSec: 2 });
  idle(x, 2100);
  assert.equal(x.engine.sleepState, 'asleep');
  const w = x.engine.of('wake').length;
  const before = x.ctl._sleepDebug().lastInputAt;
  x.bus.send({ v: 1, type: 'hello' });
  await tick();
  assert.equal(x.engine.of('wake').length, w, 'hello does not wake');
  assert.equal(x.engine.sleepState, 'asleep');
  assert.equal(x.ctl._sleepDebug().lastInputAt, before, 'nor restart the idle clock');
  assert.ok(x.bus.sent.length && x.bus.sent[x.bus.sent.length - 1].audio === 'asleep', 'hello still gets the state');
  x.ctl.onMenu('popoverShown');
  assert.equal(x.ctl.status.popoverOpen, true);
  assert.equal(x.ctl.status.lowResource, true, 'the popover open is not the main window');
  assert.equal(x.engine.sleepState, 'asleep');
  x.ctl.onMenu('popoverHidden');
  assert.equal(x.ctl.status.popoverOpen, false);
  // a real command wakes
  x.bus.send({ v: 1, type: 'nextMode' });
  assert.equal(x.engine.of('wake').length, w + 1, 'a real popover command wakes');
  assert.equal(x.engine.sleepState, 'awake');
  x.ctl.dispose();
});

test('controller: sleeps after audioSleepSec with no input (low-resource); status.audio "asleep" is published; the tick leaves it alone', async () => {
  const x = await setup();
  idle(x, 29000);
  assert.equal(x.engine.of('sleep').length, 0, 'not before 30 s (default)');
  idle(x, 1500);
  assert.equal(x.engine.of('sleep').length, 1);
  assert.equal(x.ctl.status.audio, 'asleep');
  const st = x.ctl.menuBarState();
  assert.equal(st.audio, 'asleep');
  assert.equal(stateError(st), null, 'a valid contract state');
  await tick();
  assert.ok(x.bus.sent.some((s) => s.audio === 'asleep'), 'published on the bus');
  x.engine.clear();
  idle(x, 5000); // watchdog while asleep: no resume, no stall, no second sleep
  assert.deepEqual(x.engine.names().filter((n) => n === 'ctx.resume' || n === 'sleep' || n === 'restart'), []);
  assert.equal(x.ctl.status.audio, 'asleep');
  x.ctl.dispose();
});

test('controller: every kind of input wakes it and restarts the clock', async () => {
  const x = await setup({ sleepSec: 2 });
  const sleepNow = () => {
    idle(x, 2100);
    assert.equal(x.engine.sleepState, 'asleep');
  };
  const wakes = () => x.engine.of('wake').length;
  const inputs = {
    'MIDI note': () => x.midi._inject([0x90, 60, 100]),
    'MIDI CC (pedal)': () => x.midi._inject([0xb0, 64, 127]),
    'computer key': () => key(x.doc, 'keydown', { code: 'F13', key: 'F13' }),
    'pointer anywhere': () => x.doc.dispatchEvent(new Event('pointerdown')),
    wheel: () => x.doc.dispatchEvent(new Event('wheel')),
    'popover command': () => x.bus.send({ v: 1, type: 'prevMode' }), // lowres2-critic R2: not `hello`
    'on-screen note': () => x.ctl.perform.noteOn(62),
  };
  for (const [name, fire] of Object.entries(inputs)) {
    sleepNow();
    const n = wakes();
    fire();
    assert.equal(wakes(), n + 1, name);
    assert.equal(x.engine.sleepState, 'awake', name);
    assert.equal(x.ctl.status.audio, 'running', name);
    idle(x, 1500);
    assert.equal(x.engine.sleepState, 'awake', `${name}: stays awake ≥ audioSleepSec after the wake`);
    x.ctl.perform.releaseAll();
    x.midi._inject([0xb0, 64, 0]);
  }
  // realtime MIDI (clock, active sensing) is not a player's input
  sleepNow();
  x.midi._inject([0xfe]);
  x.midi._inject([0xf8]);
  assert.equal(x.engine.sleepState, 'asleep', 'active sensing / clock do not wake');
  x.ctl.dispose();
});

test('controller: no sleep while something plays, records, or with audioSleepSec 0', async () => {
  const recorder = Object.assign(new EventTarget(), { isRecording: false, toggle: async () => null });
  const x = await setup({ sleepSec: 2, recorder });
  x.engine.blockers = ['voices'];
  idle(x, 5000);
  assert.equal(x.engine.of('sleep').length, 0, 'voices');
  x.engine.blockers = ['drone'];
  idle(x, 5000);
  assert.equal(x.engine.of('sleep').length, 0, 'drone');
  x.engine.blockers = [];
  recorder.isRecording = true;
  recorder.dispatchEvent(new CustomEvent('state', { detail: { state: 'recording' } }));
  idle(x, 5000);
  assert.equal(x.engine.of('sleep').length, 0, 'recording');
  recorder.isRecording = false;
  recorder.dispatchEvent(new CustomEvent('state', { detail: { state: 'idle' } }));
  x.store.set('settings.audioSleepSec', 0);
  idle(x, 60000);
  assert.equal(x.engine.of('sleep').length, 0, '0 = never');
  x.store.set('settings.audioSleepSec', 2);
  idle(x, 100);
  assert.equal(x.engine.of('sleep').length, 1, 'sleeps once allowed');
  x.ctl.dispose();
});

test('controller: resumeAudio wakes a sleeping engine; an engine without the sleep API never sleeps', async () => {
  const x = await setup({ sleepSec: 2 });
  idle(x, 2100);
  assert.equal(x.engine.sleepState, 'asleep');
  await x.ctl.resumeAudio();
  assert.equal(x.engine.sleepState, 'awake');
  x.ctl.dispose();
  const store = makeStore();
  store.set('settings.audioSleepSec', 2);
  store.set('settings.lowResource', true);
  const engine = fakeEngine();
  const timers = fakeTimers();
  let t = 0;
  const ctl = createController({
    store, engine, doc: fakeDoc(), nav: null, win: new EventTarget(), rig: null, timers, now: () => t, autoRestart: false,
  });
  await ctl.start();
  t += 60000;
  engine.ctx.currentTime += 60;
  timers.runIntervals();
  assert.equal(ctl.status.audio, 'running');
  ctl.noteActivity('test'); // harmless without engine.wake
  ctl.dispose();
});

// ---- midi.js ------------------------------------------------------------------------------------------------------
test("midi: 'input' comes before the message's own event, not for realtime bytes; a connecting port is input", () => {
  const m = new MidiInput({ nav: null, warn: () => {} });
  const seen = [];
  for (const t of ['input', 'noteon', 'cc']) m.addEventListener(t, (e) => seen.push([t, e.detail.kind ?? null]));
  m._inject([0x90, 60, 100]);
  assert.deepEqual(seen.map((x) => x[0]), ['input', 'noteon']);
  assert.equal(seen[0][1], 'message');
  seen.length = 0;
  m._inject([0xfe]);
  m._inject([0xf8, 0xf8]);
  assert.deepEqual(seen, [], 'active sensing / clock');
  m._inject([0xb0, 1, 64]);
  assert.deepEqual(seen.map((x) => x[0]), ['input', 'cc']);
  seen.length = 0;
  m.access = { inputs: new Map() };
  m._handleStateChange({ port: { id: 'k1', type: 'input', state: 'connected', name: 'Keys' } });
  assert.deepEqual(seen, [['input', 'hotplug']]);
});
