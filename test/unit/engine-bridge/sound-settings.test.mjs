// UI wave items 4-7 (UIB) on the bridge: config {droneFreeze} (DECISIONS D5) and config {dynamicRange} (T12 O1) from
// the contract through the shim to the mock, the Settings review items 2-4 (the native-only Sound setters are
// contracted, mock-native reports bufferFrames, the shim reports sampleRate with the audio settings) and hello.minor
// as the core answers it (T11 O7). The core side of the same rows: native/core/tests/test_bridge_dynrange.cpp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOCK_CAPS, MOCK_MINOR, checkSpec } from '../../../app/js/engine-bridge/mock-native.js';
import { api, flush, rig } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const configOp = () => api.messages.ops.find((o) => o.op === 'config');
/** The loopback log holds batches (arrays) or single messages; flattened. */
const flat = (list) => list.flatMap((b) => (Array.isArray(b) ? b : [b]));
/** What the page sent to native for one op, without the envelope. */
const sent = (log, op) => flat(log.toNative).filter((m) => m.op === op).map(({ v, id, op: o, ...m }) => m);

test('contract: config carries droneFreeze and dynamicRange, the reply echoes both', () => {
  const op = configOp();
  assert.equal(op.args.droneFreeze, 'bool?');
  assert.equal(op.args.dynamicRange, 'number?');
  assert.match(op.reply, /droneFreeze\?/);
  assert.match(op.reply, /dynamicRange\?/);
  for (const ok of [1, 2.5, 3, 6, undefined]) assert.ok(checkSpec(op.args.dynamicRange, ok).ok, String(ok));
  for (const bad of ['2', true, null, NaN]) assert.ok(!checkSpec(op.args.dynamicRange, bad).ok, String(bad));
});

test('contract (Settings review item 2): the native-only Sound setters and setDynamicRange are listed', () => {
  const by = new Map(api.methods.map((m) => [m.name, m]));
  for (const n of ['setPolyphony', 'setVoiceLimit', 'setBufferFrames', 'setDroneFreeze']) {
    assert.ok(by.has(n), n);
    assert.equal(by.get(n).nativeOnly, true, `${n} is native-only`);
  }
  assert.deepEqual(by.get('setDynamicRange').bridge, { op: 'config', field: 'dynamicRange' });
  assert.deepEqual(by.get('setDroneFreeze').bridge, { op: 'config', field: 'droneFreeze' });
  assert.equal(by.get('setBufferFrames').bridge.op, 'audio');
  // the allow-list is gone from the surface test: the contract is the one list
  const surface = fs.readFileSync(path.join(here, 'surface.test.mjs'), 'utf8');
  assert.doesNotMatch(surface, /'setPolyphony', 'setVoiceLimit', 'setBufferFrames'/);
});

test('hello: the mock answers minor and caps as the core does (5: getParam; 4: dynamicRange; 3: droneFreeze)', async () => {
  const r = rig();
  const h = await r.engine._hello;
  assert.equal(h.minor, MOCK_MINOR);
  assert.equal(MOCK_MINOR, 5); // CORE2B: get {what:'param'}
  assert.ok(h.minor >= 3, 'droneFreeze is minor 3');
  for (const c of ['polyphony', 'bufferFrames', 'slots16', 'voiceLimit', 'droneFreeze', 'dynamicRange', 'getParam']) {
    assert.ok(h.caps.includes(c), c);
  }
  assert.deepEqual(h.caps, [...MOCK_CAPS]);
  // the core's opHello lists the same capability strings (it adds 'rec' only with a recorder service)
  const cpp = fs.readFileSync(path.join(here, '../../../native/core/src/bridge/bridge.cpp'), 'utf8');
  const core = [...cpp.matchAll(/elemStr\("([A-Za-z0-9]+)"\)/g)].map((m) => m[1]).filter((c) => c !== 'rec');
  assert.deepEqual(MOCK_CAPS.filter((c) => c !== 'mock').sort(), [...new Set(core)].sort());
  assert.match(cpp, new RegExp(`kv\\("minor", ${MOCK_MINOR}\\)`), 'core and mock agree on minor');
  r.mock.close();
});

test('setDroneFreeze: config {droneFreeze} with the new state, echoed by the mock', async () => {
  const r = rig();
  await r.engine.start();
  assert.equal(r.engine.setDroneFreeze(false), false);
  assert.equal(r.engine.setDroneFreeze(true), true);
  assert.equal(r.engine.setDroneFreeze(undefined), true, 'absent = on (D5 default)');
  await flush();
  assert.deepEqual(sent(r.log, 'config').filter((m) => 'droneFreeze' in m),
    [{ droneFreeze: false }, { droneFreeze: true }, { droneFreeze: true }]);
  assert.equal(r.mock.droneFreeze, true);
  assert.deepEqual(await r.engine._link.request('config', { droneFreeze: false }), { droneFreeze: false });
  assert.deepEqual(r.mock.findings, []);
  r.mock.close();
});

test('setDynamicRange: validated like the web engine (validDynRange, else 1), sent as config {dynamicRange}',
  async () => {
    const r = rig();
    await r.engine.start();
    // TOUCH (D43): the cap is 6 (60 dB for pianos)
    const cases = [[2, 2], [2.345, 2.35], [0.2, 1], [9, 6], [4.5, 4.5], ['wide', 1], [NaN, 1], [undefined, 1],
      [1.5, 1.5]];
    for (const [v, want] of cases) assert.equal(r.engine.setDynamicRange(v), want, String(v));
    await flush();
    assert.deepEqual(sent(r.log, 'config').filter((m) => 'dynamicRange' in m).map((m) => m.dynamicRange),
      cases.map(([, w]) => w));
    assert.equal(r.mock.dynamicRange, 1.5);
    const st = await r.engine._link.request('get', { what: 'state' });
    assert.equal(st.dynamicRange, 1.5);
    // the mock clamps like the core (Model::setDynamicRange) when a caller sends a raw number
    assert.deepEqual(await r.engine._link.request('config', { dynamicRange: 7 }), { dynamicRange: 6 });
    await assert.rejects(r.engine._link.request('config', { dynamicRange: 'x' }), (e) => e.code === 'bad-request');
    assert.ok(r.mock.findings.every((f) => f.field === 'dynamicRange' && f.kind === 'type'));
    r.mock.close();
  });

test('Settings review item 3: mock-native reports bufferFrames in audio replies and state events', async () => {
  const r = rig();
  const cfgs = [];
  r.engine.addEventListener('audioconfig', (e) => cfgs.push(e.detail));
  await r.engine.setBufferFrames(256, { restart: false });
  await r.engine.start();
  assert.equal(r.mock.bufferFrames, 256);
  assert.equal(r.engine._audioCfg.bufferFrames, 256, 'the audio start reply carries the grant');
  // a device that rounds the request (iPad): the state event after a restart carries the granted size
  r.mock.grantFrames = 192;
  await r.engine.restart();
  assert.equal(r.engine._audioCfg.bufferFrames, 192);
  assert.equal(r.engine._audioCfg.bufferRequested, 256);
  const states = flat(r.log.toJs).filter((m) => m.ev === 'state');
  assert.ok(states.length >= 2 && states.every((m) => Number.isFinite(m.bufferFrames)), 'every state event');
  assert.ok(cfgs.some((c) => c.bufferFrames === 192));
  assert.deepEqual(r.mock.findings, []);
  r.mock.close();
});

test('Settings review item 4: the audio settings carry the engine sample rate (Settings reads no engine.ctx)',
  async () => {
    const r = rig({ sampleRate: 44100 });
    const cfgs = [];
    r.engine.addEventListener('audioconfig', (e) => cfgs.push(e.detail));
    await r.engine.start();
    assert.equal(r.engine._audioCfg.sampleRate, 44100);
    assert.equal(cfgs.at(-1).sampleRate, 44100);
    r.mock._emit('state', r.mock._state({ sampleRate: 96000 }));
    r.mock._flush();
    await flush();
    assert.equal(cfgs.at(-1).sampleRate, 96000);
    r.mock.close();
  });
