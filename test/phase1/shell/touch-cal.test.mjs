// TOUCH (D43): per-keyboard calibration curves (settings.keyboards[name].velocity) through store → controller →
// (fake) engine: no curve = today's calls, a curve maps the velocity before the engine (linear there, no {touch}),
// 0 = silent, the curve wins over an older {touch} entry, the computer / on-screen keys, the velocity log for
// Settings' histogram, and the store's validation (refused, dropped, idempotent, device-local).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MidiInput } from '../../../app/js/midi.js';
import { createController } from '../../../app/js/controller.js';
import { COMPUTER_KEYBOARD, normalizeKeyboards, migrate } from '../../../app/js/store.js';
import { parseVelocity, compileCurve, calVelocity } from '../../../app/js/shared/velocity-cal.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, key, tick } from './helpers.mjs';

function port(id, name) {
  return { id, name, manufacturer: '', type: 'input', state: 'connected', connection: 'closed', onmidimessage: null };
}
async function setup(ports, store = makeStore()) {
  const engine = fakeEngine();
  const access = new EventTarget();
  access.inputs = new Map(ports.map((p) => [p.id, p]));
  const midi = new MidiInput({ nav: { requestMIDIAccess: () => Promise.resolve(access) }, warn: () => {} });
  const doc = fakeDoc();
  const ctl = createController({ store, engine, midi, recorder: null, doc, nav: null, win: new EventTarget(), rig: null,
    timers: fakeTimers(), now: () => 0 });
  await ctl.start();
  await tick();
  return { store, engine, midi, ctl, doc };
}
const FP10 = 'Roland Digital Piano';
const OTHER = 'Keystation 49 MK3';
const CURVE = parseVelocity('Velocity = [0, 1, 18, 32, 50, 108, 127; 0, 0, 30, 57, 84, 127, 127]').curve;
const on = (midi, id, note, vel) => midi._inject([0x90, note, vel], 0, id);
const off = (midi, id, note) => midi._inject([0x80, note, 0], 0, id);
const VELS = [1, 2, 10, 18, 25, 40, 64, 90, 100, 108, 120, 127];

test('no curve set: the engine gets exactly what it got before (Touch setting, 2-argument noteOn)', async () => {
  for (const sens of ['normal', 'hard']) {
    const store = makeStore();
    store.set('settings.velocitySens', sens);
    store.set('settings.midiInputId', 'all');
    const { engine, midi, ctl } = await setup([port('f', FP10)], store);
    engine.clear();
    VELS.forEach((v, i) => on(midi, 'f', 40 + i, v));
    const got = engine.of('noteOn');
    assert.equal(got.length, VELS.length);
    for (const c of got) assert.equal(c.length, 3, 'noteOn(note, vel): no options');
    if (sens === 'normal') assert.deepEqual(got.map((c) => c[2]), VELS);
    else assert.ok(got.every((c, i) => c[2] <= VELS[i]), 'hard Touch still applies');
    ctl.dispose();
  }
});

test('a calibrated keyboard: velocity mapped before the engine (no {touch}), 0 = silent, others same', async () => {
  const store = makeStore();
  store.set('settings.velocitySens', 'hard'); // must not apply to the calibrated board
  store.set('settings.midiInputId', 'all');
  assert.equal(store.setKeyboard(FP10, { velocity: CURVE }), true);
  const { engine, midi, ctl } = await setup([port('f', FP10), port('k', OTHER)], store);
  const cal = compileCurve(CURVE);
  engine.clear();
  VELS.forEach((v, i) => on(midi, 'f', 40 + i, v));
  const got = engine.of('noteOn');
  const want = VELS.map((v) => calVelocity(cal, v)).filter((v) => v > 0);
  assert.deepEqual(got.map((c) => c[2]), want);
  assert.deepEqual(got.map((c) => c[1]), VELS.map((v, i) => 40 + i).filter((n, i) => calVelocity(cal, VELS[i]) > 0));
  for (const c of got) assert.equal(c.length, 3, 'linear at the engine: no {touch} options');
  assert.equal(got[0][1], 41, 'velocity 1 plays nothing on this curve (out 0)');
  assert.ok(got.every((c) => Number.isInteger(c[2]) && c[2] >= 1 && c[2] <= 127), 'whole velocities (the bridge)');
  // the silent note's note-off sends nothing; a sounding one's does
  engine.clear();
  off(midi, 'f', 40);
  off(midi, 'f', 41);
  assert.deepEqual(engine.of('noteOff').map((c) => c[1]), [41]);
  // the other keyboard keeps the Touch setting
  engine.clear();
  on(midi, 'k', 60, 64);
  assert.ok(engine.of('noteOn')[0][2] < 64);
  assert.equal(engine.of('noteOn')[0].length, 3);
  // live: a new curve applies to the next note; removing it brings the Touch setting back
  store.setKeyboard(FP10, { velocity: { in: [0, 127], out: [0, 63.5] } });
  await tick();
  engine.clear();
  on(midi, 'f', 70, 127);
  assert.equal(engine.of('noteOn')[0][2], 64); // 63.5 rounds up
  store.setKeyboard(FP10, { velocity: null });
  await tick();
  engine.clear();
  on(midi, 'f', 71, 127);
  assert.equal(engine.of('noteOn')[0][2], 127, 'hard Touch at 127 = 127');
  ctl.dispose();
});

test('a calibration curve takes the place of an older {touch} curve on the same keyboard', async () => {
  const store = makeStore();
  store.set('settings.midiInputId', 'all');
  store.setKeyboard(FP10, { touch: { shape: 0.5, min: 0.1, max: 1, top: 100 } });
  const { engine, midi, ctl } = await setup([port('f', FP10)], store);
  engine.clear();
  on(midi, 'f', 60, 40);
  assert.ok(engine.of('noteOn')[0][3]?.touch, 'old entry: raw velocity + {touch}, as in v11-touch');
  assert.equal(engine.of('noteOn')[0][2], 40);
  store.setKeyboard(FP10, { velocity: CURVE, touch: null }); // what Settings writes when the player saves points
  await tick();
  engine.clear();
  on(midi, 'f', 61, 40);
  assert.deepEqual(engine.of('noteOn')[0], ['noteOn', 61, calVelocity(compileCurve(CURVE), 40)]);
  // a hand-edited entry with both: the points win
  store.setKeyboard(FP10, { touch: { shape: 2 } });
  await tick();
  engine.clear();
  on(midi, 'f', 62, 40);
  assert.equal(engine.of('noteOn')[0].length, 3);
  ctl.dispose();
});

test('the on-screen and computer keys use the @computer curve (computer keys = velocity 100 through it)', async () => {
  const store = makeStore();
  store.setKeyboard(COMPUTER_KEYBOARD, { velocity: { in: [0, 50, 127], out: [0, 20, 100] } });
  const { engine, ctl, doc } = await setup([], store);
  engine.clear();
  ctl.perform.noteOn(60, 50);
  ctl.perform.noteOn(62, 0.4); // rounds to 0 → 1 raw → 0.4 out → silent
  key(doc, 'keydown', { code: 'KeyD' }); // E4 (C4 is held by the on-screen note)
  const got = engine.of('noteOn');
  assert.equal(got[0][2], 20);
  assert.equal(got.length, 2, 'the near-zero on-screen note is silent');
  assert.equal(got[1][2], Math.round(20 + (80 * 50) / 77), 'computer key: 100 through the curve');
  ctl.dispose();
});

test('recentVelocities: the last 200 raw velocities per keyboard, oldest first, for Settings\' histogram', async () => {
  const store = makeStore();
  store.set('settings.midiInputId', 'all');
  store.setKeyboard(FP10, { velocity: CURVE });
  const { midi, ctl } = await setup([port('f', FP10), port('k', OTHER)], store);
  assert.deepEqual(ctl.recentVelocities(FP10), []);
  for (let i = 0; i < 250; i++) on(midi, 'f', 30 + (i % 50), 1 + (i % 127)); // includes silent ones: still logged
  on(midi, 'k', 60, 77);
  const r = ctl.recentVelocities(FP10);
  assert.equal(r.length, 200);
  assert.equal(r[0], 1 + (50 % 127), 'oldest kept = the 51st note');
  assert.equal(r.at(-1), 1 + (249 % 127));
  assert.deepEqual(ctl.recentVelocities(OTHER), [77]);
  ctl.perform.noteOn(60, 33);
  assert.deepEqual(ctl.recentVelocities(COMPUTER_KEYBOARD), [33]);
  ctl.dispose();
});

test('store: velocity curves validated (refused on set, dropped on load), migrate() idempotent, device-local', () => {
  const store = makeStore();
  assert.equal(store.setKeyboard(FP10, { velocity: { in: [0, 64, 60], out: [0, 64, 127] } }), false, 'not monotone');
  assert.equal(store.setKeyboard(FP10, { velocity: { in: [0], out: [0] } }), false, 'one point');
  assert.equal(store.setKeyboard(FP10, { velocity: 'Velocity = [0, 127; 0, 127]' }), false, 'text is parsed first');
  assert.equal('keyboards' in store.get().settings, false, 'nothing written');
  assert.equal(store.setKeyboard(FP10, { velocity: { in: [0, 64.004, 127], out: [0, 80, 127] } }), true);
  assert.deepEqual(store.get().settings.keyboards[FP10].velocity, { in: [0, 64, 127], out: [0, 80, 127] });
  const n = normalizeKeyboards({ a: { velocity: { in: [0, 1], out: [5, 4] }, remember: true }, b: { velocity: 3 } });
  assert.deepEqual(n, { a: { remember: true } }, 'invalid curves dropped, the rest kept');
  const lib = { schema: 2, songs: {}, settings: { keyboards: { [FP10]: { velocity: CURVE, touch: { shape: 2 } } } } };
  const once = migrate(lib);
  assert.deepEqual(once.settings.keyboards[FP10].velocity, CURVE);
  assert.deepEqual(migrate(JSON.parse(JSON.stringify(once))).settings.keyboards, once.settings.keyboards);
  const text = store.exportJSON();
  assert.doesNotMatch(text, /Roland|"velocity"/, 'device-local: not in a library export');
  store.dispose();
});
