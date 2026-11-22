// UIC (UIB review O1, PARITY "UI parity"): the shim answers `pedal`, wheelValues() and getRuntimeState() at once
// after a perform call, as audio.js does, instead of from the next 30 Hz tick; a disagreeing tick built before native
// saw the call does not undo it, a confirming tick or OPTIMISTIC_MS (400 ms) hands the value back to the core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, flush } from './helpers.mjs';

const RT = { wheel: { mod: 0, expr: 1, vol: 1 }, modOwner: 'hw', faded: false, swelling: false };
/** A tick from native with the given pedal / runtime (as one built before the shim's call reached it). */
const tick = (r, o = {}) => r.native.post({
  v: 1, ev: 'tick', t: 1, frames: 48000, out: [0, 0], blockers: [], pedal: false, held: 0, cpu: 0,
  ...o, runtime: { ...RT, ...(o.runtime || {}), wheel: { ...RT.wheel, ...((o.runtime && o.runtime.wheel) || {}) } },
});

async function started() {
  const r = rig();
  await r.engine.start();
  r.mock.autoTick = false; // only the ticks this test posts
  await flush();
  return r;
}

test('UIC: sustain() sets engine.pedal at once; a stale tick does not undo it; a confirming tick hands it back',
  async () => {
  const r = await started();
  const e = r.engine;
  assert.equal(e.pedal, false);
  e.sustain(true);
  assert.equal(e.pedal, true, 'answered at once like audio.js');
  tick(r, { pedal: false }); // built before native saw the pedal
  assert.equal(e.pedal, true, 'a stale tick within 400 ms does not undo it');
  tick(r, { pedal: true });
  assert.equal(e.pedal, true);
  tick(r, { pedal: false }); // confirmed: the core rules again (a hardware pedal on native's direct path)
  assert.equal(e.pedal, false);
});

test('UIC: an unconfirmed optimistic value gives way to the core after 400 ms', async () => {
  const r = await started();
  const e = r.engine;
  e.sustain(true);
  r.env.advance(399);
  tick(r, { pedal: false });
  assert.equal(e.pedal, true);
  r.env.advance(2);
  tick(r, { pedal: false });
  assert.equal(e.pedal, false, 'native never took it: its value wins');
});

test('UIC: wheels, swell, fade and panic answer wheelValues() / getRuntimeState() at once', async () => {
  const r = await started();
  const e = r.engine;
  e.setWheel('expr', 0.5);
  e.volumeCC(0.25);
  assert.deepEqual(e.wheelValues(), { mod: 0, expr: 0.5, vol: 0.25, owner: 'hw', swelling: false });
  tick(r); // stale: expr 1, vol 1
  assert.equal(e.wheelValues().expr, 0.5);
  assert.equal(e.wheelValues().vol, 0.25);
  e.setWheel('virtual', 0.7);
  assert.deepEqual(e.getRuntimeState(),
    { wheel: { mod: 0.7, expr: 0.5, vol: 0.25 }, modOwner: 'virtual', faded: false });
  // hardware mod while the virtual value owns the wheel: pickup is native's, so the mirror waits for the tick
  e.modWheel(0.1);
  assert.equal(e.wheelValues().mod, 0.7);
  tick(r, { runtime: { wheel: { mod: 0.7, expr: 0.5, vol: 0.25 }, modOwner: 'virtual' } });
  assert.equal(e.wheelValues().owner, 'virtual');
  e.swell();
  assert.equal(e.wheelValues().swelling, true);
  tick(r, { runtime: { wheel: { mod: 0.7, expr: 0.5, vol: 0.25 }, modOwner: 'virtual', swelling: false } });
  assert.equal(e.wheelValues().swelling, true, 'stale tick');
  e.fadeOutAll(3);
  assert.equal(e.getRuntimeState().faded, true);
  e.noteOn(60, 90);
  assert.equal(e.getRuntimeState().faded, false, 'audio.js: the next note un-fades');
  e.sustain(true);
  e.allNotesOff();
  assert.equal(e.pedal, false, 'Panic lifts the pedal');
  assert.equal(e.wheelValues().swelling, false, 'and ends a swell');
  // scheduled calls ({when}) are not mirrored: they happen later
  e.sustain(true, { when: 5 });
  assert.equal(e.pedal, false);
  await flush();
});

test('UIC: clickStop() answers clickState().running false at once; native\'s click event confirms', async () => {
  // messages are held until pump(): native has not answered the stop yet when clickState() is read
  const q = [];
  const r = rig({ schedule: (fn) => q.push(fn) });
  const pump = async () => {
    for (let i = 0; i < 20; i++) {
      while (q.length) q.shift()();
      await flush();
    }
  };
  const e = r.engine;
  const st = e.start();
  await pump();
  await st;
  r.native.post({ v: 1, ev: 'click', running: true, counting: false, bpm: 100, sig: '4/4', output: 'main', level: 0.6,
    record: false, downbeat: 1 });
  await pump();
  assert.equal(e.clickState().running, true);
  assert.equal(e.clickStop(), true, 'it was running');
  assert.equal(e.clickState().running, false, 'audio.js: stopped at the call, before native answers');
  assert.equal(e.clickState().bpm, 100, 'the rest of the state is kept');
  assert.equal(e.clickStop(), false, 'a second stop: nothing was running');
  await pump();
  assert.equal(e.clickState().running, false, 'native\'s click event agrees');
});
