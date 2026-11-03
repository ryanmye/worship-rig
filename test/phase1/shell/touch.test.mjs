// v11-touch: per-keyboard touch curves (settings.keyboards), the slot's own curve, the expression taper and the
// pedal-swell combo through store → controller → (fake) engine, the calibration capture, and remembered devices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MidiInput, REMEMBERED_RANK } from '../../../app/js/midi.js';
import { createController } from '../../../app/js/controller.js';
import { COMPUTER_KEYBOARD, normalizeKeyboards, migrate } from '../../../app/js/store.js';
import { compileTouch, touchAt } from '../../../app/js/shared/touch-curve.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, key, tick } from './helpers.mjs';

function port(id, name, manufacturer = '') {
  return { id, name, manufacturer, type: 'input', state: 'connected', connection: 'closed', onmidimessage: null };
}
function fakeAccess(ports) {
  const a = new EventTarget();
  a.inputs = new Map(ports.map((p) => [p.id, p]));
  a.plug = (p) => {
    a.inputs.set(p.id, p);
    p.state = 'connected';
    const e = new Event('statechange');
    e.port = p;
    a.dispatchEvent(e);
  };
  return a;
}
async function setup(ports, store = makeStore()) {
  const engine = fakeEngine();
  const access = fakeAccess(ports);
  const midi = new MidiInput({ nav: { requestMIDIAccess: () => Promise.resolve(access) }, warn: () => {} });
  const doc = fakeDoc();
  const ctl = createController({ store, engine, midi, recorder: null, doc, nav: null, win: new EventTarget(), rig: null,
    timers: fakeTimers(), now: () => 0 });
  await ctl.start();
  await tick();
  return { store, engine, midi, ctl, access, doc };
}
const KEYS = 'Keystation 49 MK3';
const OTHER = 'Roland A-49';
const play = (midi, id, note, vel) => midi._inject([0x90, note, vel], 0, id);

test('store: settings.keyboards is absent until set, validated, and an emptied map goes away', () => {
  const store = makeStore();
  assert.equal('keyboards' in store.get().settings, false);
  assert.equal(store.setKeyboard(KEYS, { touch: { shape: 9, min: -1, top: 64.4 } }), true);
  assert.deepEqual(store.get().settings.keyboards, { [KEYS]: { touch: { shape: 4, min: 0, max: 1, top: 64 } } });
  store.setKeyboard(KEYS, { remember: true });
  store.setKeyboard('USB-MIDI 1.0 (port 2)', { remember: true }); // dots in a name are fine (not a set() path)
  assert.equal(store.get().settings.keyboards[KEYS].remember, true);
  assert.equal(store.get().settings.keyboards['USB-MIDI 1.0 (port 2)'].remember, true);
  store.setKeyboard(KEYS, { touch: null });
  assert.deepEqual(store.get().settings.keyboards[KEYS], { remember: true });
  store.setKeyboard(KEYS, { remember: false }); // nothing left → the entry goes
  assert.equal(KEYS in store.get().settings.keyboards, false);
  store.setKeyboard('USB-MIDI 1.0 (port 2)', null); // forget
  assert.equal('keyboards' in store.get().settings, false, 'empty map removed');
  assert.equal(store.setKeyboard('__proto__', { remember: true }), false);
  assert.equal(store.set('settings.keyboards.x', {}), false, 'only the whole map is a path');
  // normalizer: junk dropped, unknown fields kept; migrate is idempotent with it
  const n = normalizeKeyboards({ a: { remember: 'yes', touch: 4, note: 'x' }, b: 5, '': { remember: true }, c: {} });
  assert.deepEqual(n, { a: { note: 'x' } });
  const lib = { schema: 1, songs: {}, settings: { keyboards: { [KEYS]: { touch: { shape: 2 }, remember: true } } } };
  const once = migrate(lib);
  assert.deepEqual(migrate(once).settings.keyboards, once.settings.keyboards);
  assert.deepEqual(once.settings.keyboards[KEYS].touch, { shape: 2, min: 0, max: 1, top: 127 });
});

test('store: slot touch rows / custom curve, expression.curve and swell.pedal are optional and validated', () => {
  const store = makeStore();
  const song = store.currentSong();
  const before = JSON.stringify(song.patch);
  assert.equal(store.set('slots.0.velocityCurve', 'custom'), true);
  assert.equal(store.set('slots.0.touch.shape', 0.5), true);
  assert.equal(store.set('slots.0.touch.top', 300), true);
  const s0 = store.currentSong().patch.slots[0];
  assert.deepEqual(s0.touch, { shape: 0.5, top: 127 }, 'only the rows that were set');
  assert.equal(store.set('slots.0.touch.min', 'x'), false);
  // expression curve: 'log' stored, 'linear' = absent, junk refused
  assert.equal(store.set('song.patch.expression.curve', 'log'), true);
  assert.equal(store.currentSong().patch.expression.curve, 'log');
  assert.equal(store.set('song.patch.expression.curve', 'exp'), false);
  store.set('song.patch.expression.curve', 'linear');
  assert.equal('curve' in store.currentSong().patch.expression, false);
  // swell.pedal: true stored, false = absent
  assert.equal(store.set('song.patch.swell.pedal', true), true);
  assert.equal(store.currentSong().patch.swell.pedal, true);
  assert.equal(store.set('song.patch.swell.pedal', 'on'), false);
  store.set('song.patch.swell.pedal', false);
  assert.equal('pedal' in store.currentSong().patch.swell, false);
  // the untouched parts of the patch: a v1.0 library reads exactly as before
  const other = store.get().songs[store.get().songOrder[1]].patch;
  assert.equal('curve' in other.expression, false);
  assert.equal('pedal' in other.swell, false);
  assert.ok(before.length > 0);
});

test('controller: a keyboard with its own curve sends the raw velocity + {touch}; others keep the Touch setting', async () => {
  const store = makeStore();
  store.set('settings.velocitySens', 'hard');
  store.set('settings.midiInputId', 'all');
  const touch = { shape: 0.5, min: 0.1, max: 1, top: 100 };
  store.setKeyboard(KEYS, { touch });
  const { engine, midi } = await setup([port('k', KEYS, 'M-Audio'), port('r', OTHER, 'Roland')], store);
  engine.clear();
  play(midi, 'k', 60, 40);
  play(midi, 'r', 62, 40);
  const [a, b] = engine.of('noteOn');
  assert.equal(a[2], 40, 'raw velocity: the curve replaces the Touch setting for this keyboard');
  assert.ok(a[3] && a[3].touch, 'its compiled curve rides along');
  assert.ok(Math.abs(touchAt(a[3].touch, 40) - touchAt(compileTouch(touch), 40)) < 1e-12);
  assert.equal(b.length, 3, 'no options for a keyboard without its own curve (call shape unchanged)');
  assert.ok(b[2] < 40, 'Heavy Touch still applies to the other keyboard');
  // the curve follows the settings live; forgetting the keyboard restores the Touch setting for it
  store.setKeyboard(KEYS, { touch: { shape: 2 } });
  await tick();
  engine.clear();
  play(midi, 'k', 64, 40);
  assert.equal(engine.of('noteOn')[0][3].touch.g, 2);
  store.setKeyboard(KEYS, null);
  await tick();
  engine.clear();
  play(midi, 'k', 65, 40);
  assert.equal(engine.of('noteOn')[0].length, 3);
});

test('controller: on-screen + computer keys use the @computer entry; captureTouch reports raw velocities', async () => {
  const store = makeStore();
  const { engine, midi, ctl, doc } = await setup([port('k', KEYS, 'M-Audio')], store);
  const seen = [];
  const stop = ctl.captureTouch((n) => seen.push(n));
  engine.clear();
  ctl.perform.noteOn(60, 30);
  play(midi, 'k', 62, 90);
  key(doc, 'keydown', { code: 'KeyD' }); // E4 (C4 is held by the on-screen note)
  assert.deepEqual(seen.map((n) => [n.velocity, n.device]), [[30, COMPUTER_KEYBOARD], [90, KEYS], [100, COMPUTER_KEYBOARD]]);
  assert.deepEqual(engine.of('noteOn').map((c) => c.length), [3, 3, 3], 'no curves yet: unchanged calls');
  stop();
  ctl.perform.noteOn(64, 50);
  assert.equal(seen.length, 3, 'stopped');
  store.setKeyboard(COMPUTER_KEYBOARD, { touch: { shape: 1, min: 0.5, max: 0.5 } });
  await tick();
  engine.clear();
  ctl.perform.noteOn(65, 30);
  key(doc, 'keydown', { code: 'KeyG' });
  const calls = engine.of('noteOn');
  assert.equal(calls[0][2], 30);
  assert.equal(touchAt(calls[0][3].touch, 30), 0.5);
  assert.equal(calls[1][2], 100);
  assert.ok(calls[1][3].touch, 'the computer keys share the entry');
});

test('midi: a remembered device wins "first keyboard", even with a virtual-looking name; sticky choice holds', async () => {
  const store = makeStore();
  store.setKeyboard('IAC Driver Bus 1', { remember: true }); // e.g. a hardware keyboard routed through a bus
  const { midi, access } = await setup([port('k', KEYS, 'M-Audio'), port('i', 'IAC Driver Bus 1', 'Apple Inc.')], store);
  assert.deepEqual(midi.remembered, ['IAC Driver Bus 1']);
  assert.deepEqual(midi.inputs.filter((i) => i.selected).map((i) => i.id), ['i']);
  assert.equal(midi.inputs.find((i) => i.id === 'i').rank, REMEMBERED_RANK);
  assert.equal(midi.inputs.find((i) => i.id === 'i').remembered, true);
  // forgetting it re-resolves to the heuristic pick
  store.setKeyboard('IAC Driver Bus 1', null);
  await tick();
  assert.deepEqual(midi.inputs.filter((i) => i.selected).map((i) => i.id), ['k']);
  // remembering a board plugged in later does not move the sticky port mid-song (L8)
  store.setKeyboard(OTHER, { remember: true });
  await tick();
  access.plug(port('r', OTHER, 'Roland'));
  assert.deepEqual(midi.inputs.filter((i) => i.selected).map((i) => i.id), ['k']);
});
