// Meter coalescing: the tick stream feeds the analyser facades, slotLevel and the RTA (contract 6.5-6.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';

const tick = (r, o) => {
  r.native.post({ v: 1, ev: 'tick', t: r.mock.t(), frames: 0, out: [0, 0], blockers: [], pedal: false, held: 0,
    runtime: {}, cpu: 0, ...o });
};
const peakL = (r) => {
  const b = new Float32Array(2048);
  r.engine.analyserL.getFloatTimeDomainData(b);
  return { v: b[0], rest: b.slice(1).every((x) => x === 0) };
};

async function started() {
  const r = rig();
  await r.engine.start();
  return r;
}

test('analyser: writes the tick peak at index 0 and zeros elsewhere', async () => {
  const r = await started();
  tick(r, { out: [0.5, 0.25] });
  assert.deepEqual(peakL(r), { v: 0.5, rest: true });
  const b = new Float32Array(2048);
  r.engine.analyserR.getFloatTimeDomainData(b);
  assert.equal(b[0], 0.25);
  assert.equal(r.engine.analyserL.fftSize, 2048);
  assert.equal(r.engine.analyserL.frequencyBinCount, 1024);
  assert.equal(r.engine.analyserL.context, r.engine.ctx);
});

test('several ticks between two reads coalesce to their maximum, never missing a peak', async () => {
  const r = await started();
  peakL(r);
  r.env.advance(10);
  tick(r, { out: [0.2, 0] });
  tick(r, { out: [0.9, 0] });
  tick(r, { out: [0.1, 0] });
  assert.equal(peakL(r).v, Math.fround(0.9));
});

test('a second read inside one tick period re-serves the tick; later reads see silence', async () => {
  const r = await started();
  tick(r, { out: [0.6, 0.6] });
  assert.equal(peakL(r).v, Math.fround(0.6));
  r.env.advance(16);
  assert.equal(peakL(r).v, Math.fround(0.6), 'a 60 Hz reader must not flicker against a 30 Hz tick');
  r.env.advance(200);
  assert.equal(peakL(r).v, 0, 'no tick for a while: silence');
});

test('asleep or suspended: the facades read 0 (meter.js checks context.state too)', async () => {
  const r = await started();
  tick(r, { out: [0.6, 0.6] });
  r.native.post({ v: 1, ev: 'state', state: 'suspended', sleep: 'asleep', latencyMs: 12, sampleRate: 48000,
    deviceId: 'default', channels: 2 });
  assert.equal(r.engine.ctx.state, 'suspended');
  assert.equal(peakL(r).v, 0);
});

test('the first meter read raises the tick rate to 30 Hz; two idle seconds drop it to 4 Hz', async () => {
  const r = await started();
  const rates = () => r.log.toNative.filter((m) => m.op === 'config' && m.meters).map((m) => m.meters.rate);
  assert.deepEqual(rates(), []);
  peakL(r);
  assert.deepEqual(rates(), [30]);
  for (let i = 0; i < 5; i++) {
    r.env.advance(500);
    peakL(r);
  }
  assert.deepEqual(rates(), [30], 'reads keep the subscription, no resend');
  r.env.advance(3500);
  assert.deepEqual(rates(), [30, 4]);
  assert.equal(r.env.pending(), 0, 'no timers left behind');
});

test('slotLevel: null before start or for a bad index; zeros for an empty slot; values from tick.slots', async () => {
  const r = rig();
  assert.equal(r.engine.slotLevel(0), null);
  await r.engine.start();
  assert.equal(r.engine.slotLevel(7), null);
  assert.equal(r.engine.slotLevel(-1), null);
  const tok = await r.engine.prepare({ slots: [{ instrument: { type: 'synth', id: 'warm-pad' } }, null, null, null] });
  assert.ok(r.engine.commit(tok));
  assert.deepEqual(r.engine.slotLevel(1), { peak: 0, rms: 0 }, 'empty slot');
  assert.deepEqual(r.engine.slotLevel(0), { peak: 0, rms: 0 }, 'first read subscribes; nothing yet');
  const sub = r.log.toNative.filter((m) => m.op === 'config' && m.meters).pop();
  assert.deepEqual(sub.meters.slots, [0]);
  tick(r, { slots: [[0.4, 0.3], [0, 0], [0, 0], [0, 0]] });
  assert.deepEqual(r.engine.slotLevel(0), { peak: 0.4, rms: 0.3 });
  r.env.advance(3500);
  const last = r.log.toNative.filter((m) => m.op === 'config' && m.meters).pop();
  assert.deepEqual(last.meters.slots, [], 'unsubscribed after 2 s without a read');
});

test('slotLevel is zeros in low-resource mode', async () => {
  const r = await started();
  const tok = await r.engine.prepare({ slots: [{ instrument: { type: 'synth', id: 'warm-pad' } }, null, null, null] });
  r.engine.commit(tok);
  assert.equal(r.engine.setLowResource(true), true);
  assert.deepEqual(r.engine.slotLevel(0), { peak: 0, rms: 0 });
});

test('RTA: first getFloatFrequencyData subscribes, decodes base64 0.5 dB steps, releases after 2 s', async () => {
  const r = await started();
  const arr = new Float32Array(1024);
  r.engine.analyserL.getFloatFrequencyData(arr);
  assert.ok(arr.every((x) => x === -120), 'no spectrum yet');
  assert.equal(r.log.toNative.filter((m) => m.op === 'config' && m.meters && m.meters.rta).length, 1);
  const bytes = new Uint8Array(2048);
  bytes[0] = 20; // L bin 0: -10 dB
  bytes[1023] = 200; // L last bin: -100 dB
  bytes[1024] = 60; // R bin 0: -30 dB
  tick(r, { rta: Buffer.from(bytes).toString('base64') });
  r.engine.analyserL.getFloatFrequencyData(arr);
  assert.equal(arr[0], -10);
  assert.equal(arr[1023], -100);
  const arrR = new Float32Array(1024);
  r.engine.analyserR.getFloatFrequencyData(arrR);
  assert.equal(arrR[0], -30);
  r.env.advance(3500);
  assert.equal(r.log.toNative.filter((m) => m.op === 'config' && m.meters).pop().meters.rta, false);
});

test('tick fields feed the sync getters: wheels, pedal, blockers, stats, runtime', async () => {
  const r = await started();
  assert.deepEqual(r.engine.sleepBlockers(), ['no-audio']);
  tick(r, {
    blockers: ['voices', 'pedal'], pedal: true,
    runtime: { wheel: { mod: 0.3, expr: 0.8, vol: 0.9 }, modOwner: 'virtual', faded: true, swelling: true },
    stats: { voices: 5, decodedMB: 120, pinnedMB: 80, capMB: 700, retiring: 1, nodes: 40 },
  });
  assert.deepEqual(r.engine.sleepBlockers(), ['voices', 'pedal']);
  assert.equal(r.engine.pedal, true);
  assert.deepEqual(r.engine.wheelValues(), { mod: 0.3, expr: 0.8, vol: 0.9, owner: 'virtual', swelling: true });
  assert.deepEqual(r.engine.getRuntimeState(), { wheel: { mod: 0.3, expr: 0.8, vol: 0.9 }, modOwner: 'virtual', faded: true });
  const s = r.engine._debugStats();
  assert.equal(s.voices, 5);
  assert.equal(s.decodedMB, 120);
  assert.equal(s.lowResource, false);
  assert.equal(s.slotLevelTaps, 0, 'fields the app reads exist even when native omits them');
});
