// Message validation against engine-api.json: the mock rejects bad traffic, and everything BridgeEngine sends passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSpec } from '../../../app/js/engine-bridge/mock-native.js';
import { api, rig, flush } from './helpers.mjs';

const PATCH = {
  slots: [
    { instrument: { type: 'sampler', id: 'salamander-piano' }, octave: 0, transpose: 0, lowNote: 0, highNote: 127 },
    { instrument: { type: 'synth', id: 'warm-pad' } }, null, null,
  ],
};

test('checkSpec understands the contract type strings', () => {
  assert.ok(checkSpec('int', 3).ok);
  assert.ok(!checkSpec('int', 3.5).ok);
  assert.ok(checkSpec('bool?', undefined).ok);
  assert.ok(!checkSpec('bool', undefined).ok);
  assert.ok(checkSpec("'start'|'stop'", 'stop').ok);
  assert.ok(!checkSpec("'start'|'stop'", 'go').ok);
  assert.ok(checkSpec("'interactive'|s?", 0.01).ok);
  assert.ok(checkSpec("'interactive'|s?", 'interactive').ok);
  assert.ok(checkSpec('number|null?', null).ok);
  assert.ok(checkSpec('string[]?', ['a']).ok);
  assert.ok(!checkSpec('string[]?', [1]).ok);
  assert.ok(checkSpec('0..1?', 0.5).ok);
  assert.ok(!checkSpec('0..1?', 1.5).ok);
  assert.ok(checkSpec('16?', 16).ok);
  assert.ok(checkSpec('{pc, minor}?', { pc: 1, minor: false }).ok);
  assert.ok(!checkSpec('{pc, minor}?', [1]).ok);
  assert.ok(checkSpec('[[path, value, glide?]]?', [['a', 1]]).ok);
});

function bad(r, msg) {
  const before = r.mock.findings.length;
  r.native.post(msg); // not used: messages travel js -> native
  return before;
}

test('the mock rejects malformed requests with the contract error codes', async () => {
  const r = rig();
  await r.engine.start();
  const link = r.engine._link;
  await assert.rejects(link.request('nope', {}), (e) => e.code === 'unknown-op');
  await assert.rejects(link.request('audio', { action: 'explode' }), (e) => e.code === 'bad-request');
  await assert.rejects(link.request('commit', {}), (e) => e.code === 'bad-request');
  await assert.rejects(link.request('set', { path: 'bogus.path', value: 1 }), (e) => e.code === 'unknown-param');
  await assert.rejects(link.request('play', { e: 'on' }), (e) => e.code === 'bad-request');
  await assert.rejects(link.request('commit', { token: 999 }), (e) => e.code === 'stale-token');
  const kinds = r.mock.findings.map((f) => f.kind);
  for (const k of ['unknown-op', 'type', 'missing']) assert.ok(kinds.includes(k), k);
  void bad;
});

test('requests before audio start get not-started; fire-and-forget errors come back as warn events', async () => {
  const r = rig();
  await assert.rejects(r.engine._link.request('prepare', { patch: {} }), (e) => e.code === 'not-started');
  r.engine._link.send('play', { e: 'on' });
  await flush();
  const w = r.events.filter((e) => e.name === 'warn').map((e) => e.detail.message);
  assert.ok(w.some((m) => /play/.test(m)));
});

test('unknown fields are tolerated but recorded (contract 6.2: ignored both ways)', async () => {
  const r = rig();
  await r.engine.start();
  await r.engine._link.request('get', { what: 'stats', surprise: 1 });
  assert.ok(r.mock.findings.some((f) => f.kind === 'unknown-field' && f.field === 'surprise'));
});

test('a message with another protocol version is refused', async () => {
  const r = rig();
  r.js.post({ v: 2, op: 'hello', id: 5, protocol: 1, app: 'x' });
  await flush();
  assert.ok(r.mock.findings.some((f) => f.kind === 'protocol'));
});

test('hello with the wrong protocol rejects; the engine reports itself unavailable', async () => {
  const r = rig();
  await assert.rejects(r.engine._link.request('hello', { protocol: 7, app: 'x' }), (e) => e.code === 'protocol');
});

test('driving every contracted member sends only valid messages and covers all 14 ops', async () => {
  const r = rig({ channels: 4 });
  const e = r.engine;
  await e.start();
  const tok = await e.prepare(PATCH);
  assert.equal(e.commit(tok, { when: 5 }), true);
  await e.preload([PATCH], { pin: 'add' });
  assert.equal((await e.estimatePreloadMB([PATCH])).capMB, 700);
  assert.equal(e.retainReverb([PATCH]), true);
  await e.reloadManifests();
  e.listInstruments();
  e.setParam('slots.0.gain', 0.7, { when: 6, glide: 0.5 });
  e.setParam('slots.0.pan', 0.1);
  e.setParam('fx.reverb.size', 0.6);
  e.setParam('master.volume', 0.5);
  e.setParam('drone.gain', 0.4);
  e.setParam('slots.0.params.release', 0.2);
  e.setTranspose(2);
  e.setRouting({ modWheel: { target: 'tone' } }, { when: 7 });
  e.setTempo(90);
  e.setTimeSig('3/4', { newBar: true });
  e.setKeyContext(7, true);
  e.setMono(true);
  assert.equal(e.eqAudition(0, 'bypass', { when: 7 }), true);
  e.drone.setKey(2, { minor: true, fade: 3, when: 7 });
  e.drone.configure({ mode: 'synth', gain: 0.5 }, { when: 7 });
  const pads = [{ name: 'Pad C.wav', path: '/p/Pad C.wav' }, { name: 'junk.wav', path: '/p/j' }];
  assert.equal(e.drone.attachFiles(pads), 1);
  e.noteInput();
  e.noteOn(60, 100, { touch: { shape: 1, min: 0, max: 1, top: 127 } });
  e.noteOff(60);
  e.sustain(true);
  e.pitchBend(0.5);
  e.modWheel(0.2);
  e.expression(0.3);
  e.volumeCC(0.4);
  e.setWheel('virtual', 0.5, { glide: 0.2 });
  e.swell(true);
  e.allNotesOff();
  e.fadeOutAll(3);
  assert.ok(e.clickStart({ countIn: 1 }));
  e.setClick({ level: 0.5, record: true, output: 'aux' });
  e.clickStop();
  e.setClockSink(() => {});
  e.setLowResource(true);
  await e.setSinkId('default');
  assert.equal(await e.sleep(), true);
  assert.equal(await e.wake(), true);
  await e.restart({ latency: 0.01, sinkId: 'default' });
  await e._link.request('midi', { action: 'listen', ids: ['mock-in'] });
  await e._link.request('midi', { action: 'route', on: true, pedalInvert: false });
  await e._link.request('midi', { action: 'send', port: 'p', data: [248] });
  await e._link.request('rec', { action: 'start', bits: 16 });
  await e._link.request('rec', { action: 'stop' });
  await e._link.request('get', { what: 'stats' });
  await e._link.request('get', { what: 'devices' });
  await e._link.request('get', { what: 'sampleStatus', patches: [PATCH] });
  await e._link.request('get', { what: 'state' });
  await flush();
  assert.deepEqual(r.mock.findings.filter((f) => f.kind !== 'unknown-field'), []);
  const unknown = r.mock.findings.filter((f) => f.kind === 'unknown-field').map((f) => `${f.op}.${f.field}`);
  // G1 (song/drone/config `when`) is closed in engine-api.spec.mjs: driving the surface sends no unlisted field
  assert.deepEqual([...new Set(unknown)].sort(), []);
  const ops = new Set([...r.mock.calls.keys()].map((k) => k.split(':')[0]));
  assert.deepEqual([...ops].sort(), api.messages.ops.map((o) => o.op).sort());
  for (const ev of ['on', 'off', 'pedal', 'wheel', 'bend', 'swell', 'panic', 'fade', 'input']) {
    assert.ok(r.mock.calls.get(`play:${ev}`) >= 1, `play ${ev}`);
  }
  for (const a of ['start', 'restart', 'output', 'sleep', 'wake']) assert.ok(r.mock.calls.get(`audio:${a}`) >= 1, a);
});
