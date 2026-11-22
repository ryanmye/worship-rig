// CORE2B (PARITY "UI parity" row 1, UIC O4): engine.getParam is contracted (minor 5, `get {what:'param', path}`).
// The shim answers it synchronously from a mirror: the core's last answer, else its own clamped setParam value, else
// the committed patch; every read that is not a core answer sends one `get param`, whose answer a later setParam or
// commit overrides. Against the mock core here; the real core in devhost.test.mjs (opt-in) and the C++ suite
// `unit.core2b`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, flush } from './helpers.mjs';
import { patchParam } from '../../../app/js/engine-bridge/param-read.js';
import { BridgeEngine } from '../../../app/js/engine-bridge/bridge-engine.js';
import { websocketTransport } from '../../../app/js/engine-bridge/ws-transport.js';
import { startDevhost, devhostBinary } from './devhost-proc.mjs';
import { TEST_PATCH } from './rec-scenario.mjs';

const slot = (id, extra = {}, type = 'sampler') => ({ instrument: { type, id }, ...extra });
const gets = (r) => r.log.toNative.filter((m) => m.op === 'get' && m.what === 'param');

async function songWith(patch) {
  const r = rig();
  const e = r.engine;
  await e.start();
  const token = await e.prepare(patch);
  assert.equal(e.commit(token), true);
  await flush();
  r.log.toNative.length = 0;
  return r;
}

test('CORE2B: getParam answers at once from the committed patch, then from the core (one get param per path)',
  async () => {
    const r = await songWith({ slots: [slot('salamander-piano', { gain: 0.6 }), null, null, null],
      fx: { reverb: { size: 0.3 } } });
    const e = r.engine;
    assert.equal(e.getParam('slots.0.gain'), 0.6, 'synchronous, from the mirror');
    assert.equal(e.getParam('fx.reverb.size'), 0.3);
    assert.equal(gets(r).length, 2, 'each unconfirmed read asks the core');
    assert.equal(e.getParam('slots.0.gain'), 0.6);
    assert.equal(gets(r).length, 2, 'one request in flight per path');
    await flush();
    assert.equal(e.getParam('slots.0.gain'), 0.6, 'the core answered the same value');
    assert.equal(gets(r).length, 2, 'a confirmed value is not asked again');
    assert.equal(e.getParam('slots.1.gain'), undefined, 'empty slot = undefined (audio.js: no cfg)');
    assert.equal(e.getParam('slots.9.gain'), undefined, 'not a slot of this song: invalid path');
    assert.equal(e.getParam('nope.x'), undefined);
    assert.equal(e.getParam('slots.0.params.release'), 0.12, 'instrument param: the catalogue default');
  });

test('CORE2B: setParam is read back at once, clamped as PARAMS clamps it; the core confirms it after the set',
  async () => {
    const r = await songWith({ slots: [slot('salamander-piano'), slot('warm-pad', {}, 'synth'), null, null] });
    const e = r.engine;
    assert.equal(e.setParam('slots.1.gain', 5), true);
    assert.equal(e.getParam('slots.1.gain'), 2, 'clamped to the row max at once');
    e.setParam('slots.1.octave', -1.4);
    assert.equal(e.getParam('slots.1.octave'), -1, 'step 1 rounds');
    e.setParam('slots.1.mono', 2);
    assert.equal(e.getParam('slots.1.mono'), 'highest', 'enum index -> member name');
    const order = r.log.toNative.map((m) => (m.op === 'get' ? `get:${m.path}` : m.op));
    assert.equal(order[0], 'set', 'the pending sets go out first (FIFO: the core answers after applying them)');
    await flush();
    assert.equal(e.getParam('slots.1.gain'), 2);
    assert.equal(e.getParam('slots.1.mono'), 'highest');
  });

test('CORE2B: an answer overtaken by a later setParam or commit is dropped', async () => {
  const r = await songWith({ slots: [slot('salamander-piano', { gain: 0.6 }), null, null, null] });
  const e = r.engine;
  // the loopback delivers synchronously: the core has answered 0.6 before the setParam, the shim reads the answer
  // only at the next microtask, after the write (as a WebView reply that crosses a later UI write)
  assert.equal(e.getParam('slots.0.gain'), 0.6);
  e.setParam('slots.0.gain', 0.3);
  await flush();
  assert.equal(e.getParam('slots.0.gain'), 0.3, 'the 0.6 answer was requested before the set: dropped');
  await flush();
  assert.equal(e.getParam('slots.0.gain'), 0.3, 'the re-ask after the set confirms 0.3');
  assert.equal(e.getParam('fx.delay.feedback'), 0.35); // asks
  const token = await e.prepare({ slots: [slot('salamander-piano', { gain: 0.25 }), null, null, null],
    fx: { delay: { feedback: 0.5 } } });
  e.commit(token);
  await flush();
  assert.equal(e.getParam('slots.0.gain'), 0.25, 'a commit replaces the mirror');
  assert.equal(e.getParam('fx.delay.feedback'), 0.5);
});

test('CORE2B: the mock core answers get param like the core: value absent = undefined, unknown-param', async () => {
  const r = await songWith({ slots: [slot('salamander-piano', { gain: 0.6, release: 2 }), null, null, null] });
  const e = r.engine;
  assert.deepEqual(await e._req('get', { what: 'param', path: 'slots.0.gain' }), { path: 'slots.0.gain', value: 0.6 });
  assert.deepEqual(await e._req('get', { what: 'param', path: 'slots.0.release' }),
    { path: 'slots.0.release', value: 2 });
  assert.deepEqual(await e._req('get', { what: 'param', path: 'slots.1.gain' }), { path: 'slots.1.gain' });
  await assert.rejects(e._req('get', { what: 'param', path: 'slots.0.nope' }), (err) => err.code === 'unknown-param');
  await assert.rejects(e._req('get', { what: 'param' }), (err) => err.code === 'bad-request', 'path is required');
});

test('CORE2B: patchParam reads a patch like audio.js getParam', () => {
  const p = { slots: [{ instrument: { type: 'synth', id: 'warm-pad' }, gain: 0.5, sends: { reverb: 0.2 },
    eq: { b2: { db: 3 } } }], fx: { master: { volume: 1.2 } } };
  assert.equal(patchParam(p, 'slots.0.gain'), 0.5);
  assert.equal(patchParam(p, 'slots.0.sends.reverb'), 0.2);
  assert.equal(patchParam(p, 'slots.0.sends.delay'), 0, 'absent row: the PARAMS default');
  assert.equal(patchParam(p, 'slots.0.release'), undefined, 'optional row: undefined when absent');
  assert.equal(patchParam(p, 'slots.0.pedalHold'), 'natural', 'absent pedalHold: normalizePatch stores \'natural\'');
  assert.equal(patchParam(p, 'slots.0.eq.b2.db'), 3);
  assert.equal(patchParam(p, 'slots.1.gain'), undefined);
  assert.equal(patchParam(p, 'master.volume'), 1.2);
  assert.equal(patchParam(p, 'fx.delay.feedback'), 0.35);
  assert.equal(patchParam(null, 'drone.width'), 0.7);
});

// ---- the real core (opt-in like devhost.test.mjs: RIG_DEVHOST=1 or a rig-devhost path) ---------------------------
const enabled = !!process.env.RIG_DEVHOST && !!devhostBinary();
const skip = enabled ? false : 'opt-in: set RIG_DEVHOST=1 (or a rig-devhost path) after building native/devhost';
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

test('CORE2B on rig-devhost: getParam reads the core; pedal / held and swelling come from the core\'s ticks',
  { skip }, async () => {
    const host = await startDevhost({ extra: ['--seed', '9'] });
    const engine = new BridgeEngine({ transport: websocketTransport({ url: host.wsUrl }), app: 'core2b' });
    try {
      const info = await engine._hello;
      assert.ok(info.minor >= 5 && info.caps.includes('getParam'), `hello minor ${info.minor}`);
      await engine.start().catch(() => {});
      engine._started = true;
      const token = await engine.prepare({ slots: [{ ...TEST_PATCH.slots[0], gain: 0.5 }, null, null, null],
        fx: { reverb: { size: 0.3 } } });
      assert.equal(engine.commit(token), true);
      assert.equal(engine.getParam('slots.0.gain'), 0.5);
      engine.setParam('slots.0.gain', 7);
      engine.setParam('slots.0.mono', 1);
      assert.equal(engine.getParam('slots.0.gain'), 2, 'clamped at once');
      assert.equal(engine.getParam('slots.0.mono'), 'lowest');
      await wait(150);
      // confirmed by the core: the mirror entries now hold the core's answers
      assert.deepEqual(engine._params.get('slots.0.gain'), { value: 2, confirmed: true });
      assert.deepEqual(engine._params.get('slots.0.mono'), { value: 'lowest', confirmed: true });
      assert.equal(engine.getParam('fx.reverb.size'), 0.3);
      await wait(150);
      assert.deepEqual(engine._params.get('fx.reverb.size'), { value: 0.3, confirmed: true });
      assert.deepEqual(await engine._req('get', { what: 'param', path: 'slots.1.gain' }), { path: 'slots.1.gain' });
      // the pedal lamp: still lit well past the shim's 400 ms optimistic window (UIC S1), held = the held key
      engine.noteOn(60, 100);
      engine.sustain(true);
      for (const ms of [600, 1000, 1500]) {
        await wait(ms === 600 ? 600 : ms - (ms === 1000 ? 600 : 1000));
        assert.equal(engine.pedal, true, `pedal at ${ms} ms`);
        assert.equal(engine._held, 1, `held at ${ms} ms`);
      }
      engine.sustain(false);
      engine.noteOff(60);
      await wait(700);
      assert.equal(engine.pedal, false);
      assert.equal(engine._held, 0);
      // swelling from the tick (contract 6.5), past the optimistic window
      engine.swell(true);
      await wait(1000);
      assert.equal(engine.wheelValues().swelling, true);
      engine.allNotesOff();
      await wait(700);
      assert.equal(engine.wheelValues().swelling, false);
    } finally {
      engine._dispose?.();
      await host.stop();
    }
  });
