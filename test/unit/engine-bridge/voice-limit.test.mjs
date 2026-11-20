// DECISIONS D4 conformance: `config {voiceLimit}` ('auto' | 128 | 256 | 512 | 0 = off) in the contract, and the mock
// answering it like the core (native/core bridge.cpp opConfig + Model::voiceLimitJson): the reply and `get state`
// echo the mode and the effective number per resource profile; anything else is a bad-request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeEngine } from '../../../app/js/engine-bridge/bridge-engine.js';
import { AUTO_VOICE_LIMIT, MockNative, checkSpec } from '../../../app/js/engine-bridge/mock-native.js';
import { loopbackPair } from '../../../app/js/engine-bridge/transports.js';
import { api, fakeEnv, rig } from './helpers.mjs';

const configOp = () => api.messages.ops.find((o) => o.op === 'config');

test('the contract carries config.voiceLimit and the reply fields (D4)', () => {
  const op = configOp();
  assert.equal(op.args.voiceLimit, "'auto'|128|256|512|0?");
  assert.match(op.reply, /voiceLimit\?/);
  assert.match(op.reply, /voiceLimitEffective\?/);
  for (const ok of ['auto', 128, 256, 512, 0, undefined]) assert.ok(checkSpec(op.args.voiceLimit, ok).ok, String(ok));
  for (const bad of ['off', '128', 64, 300, -1, 128.5, true]) {
    assert.ok(!checkSpec(op.args.voiceLimit, bad).ok, JSON.stringify(bad));
  }
});

test('the mock: default auto (desktop), manual values and off are echoed with the effective number', async () => {
  const r = rig();
  await r.engine.start();
  const link = r.engine._link;
  let st = await link.request('get', { what: 'state' });
  assert.equal(st.voiceLimit, 'auto');
  assert.equal(st.voiceLimitEffective, AUTO_VOICE_LIMIT.desktop);
  assert.equal(st.polyphony, 64);
  for (const n of [128, 256, 512]) {
    assert.deepEqual(await link.request('config', { voiceLimit: n }), { voiceLimit: n, voiceLimitEffective: n });
  }
  assert.deepEqual(await link.request('config', { voiceLimit: 0 }), { voiceLimit: 0, voiceLimitEffective: 0 });
  st = await link.request('get', { what: 'state' });
  assert.equal(st.voiceLimit, 0);
  assert.equal(st.voiceLimitEffective, 0);
  assert.deepEqual(await link.request('config', { voiceLimit: 'auto', polyphony: 128 }),
    { polyphony: 128, voiceLimit: 'auto', voiceLimitEffective: AUTO_VOICE_LIMIT.desktop });
  assert.deepEqual(r.mock.findings, []);
});

test('the mock: invalid voiceLimit values are bad-request and change nothing', async () => {
  const r = rig();
  await r.engine.start();
  const link = r.engine._link;
  await link.request('config', { voiceLimit: 256 });
  for (const bad of ['off', '128', 64, 300, 128.5, true]) {
    await assert.rejects(link.request('config', { voiceLimit: bad }), (e) => e.code === 'bad-request', String(bad));
  }
  const st = await link.request('get', { what: 'state' });
  assert.equal(st.voiceLimit, 256);
  assert.ok(r.mock.findings.every((f) => f.kind === 'type' && f.field === 'voiceLimit'));
});

test('the mock: auto follows the resource profile (iPad 64, desktop 128)', async () => {
  assert.deepEqual({ ...AUTO_VOICE_LIMIT }, { desktop: 128, ipad: 64 });
  const env = fakeEnv();
  const { js, native } = loopbackPair({ schedule: 'sync' });
  const mock = new MockNative({ api, transport: native, now: env.now, timers: env.timers, profile: 'ipad' });
  const engine = new BridgeEngine({ transport: js, now: env.now, timers: env.timers });
  await engine.start();
  const r = await engine._link.request('config', { voiceLimit: 'auto' });
  assert.deepEqual(r, { voiceLimit: 'auto', voiceLimitEffective: AUTO_VOICE_LIMIT.ipad });
  assert.deepEqual(mock.findings, []);
  mock.close();
});
