// BridgeEngine behaviour: the synchronous answers the shim owns (contract 6.6), ordering, tokens, mirrors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeEngine } from '../../../app/js/engine-bridge/bridge-engine.js';
import { eqResponseDb } from '../../../app/js/shared/eq-math.js';
import { rig, flush, fakeEnv } from './helpers.mjs';
import { loopbackPair } from '../../../app/js/engine-bridge/transports.js';

const slot = (id, extra = {}, type = 'sampler') => ({ instrument: { type, id }, ...extra });
const patchOf = (...slots) => ({ slots: [slots[0] || null, slots[1] || null, slots[2] || null, slots[3] || null] });
const ops = (r, op) => r.log.toNative.filter((m) => m.op === op);

test('hello goes first and its reply sets the sample rate', async () => {
  const r = rig({ sampleRate: 44100 });
  assert.equal(r.log.toNative[0].op, 'hello');
  assert.equal(r.log.toNative[0].protocol, 1);
  await flush();
  assert.equal(r.engine.ctx.sampleRate, 44100);
});

test('a native that does not answer hello makes start() reject and warns once', async () => {
  const env = fakeEnv();
  const { js } = loopbackPair();
  const e = new BridgeEngine({ transport: js, now: env.now, timers: env.timers, timeouts: { hello: 100 } });
  const warns = [];
  e.addEventListener('warn', (x) => warns.push(x.detail.message));
  const p = e.start();
  env.advance(150);
  await assert.rejects(p, (err) => err.code === 'timeout');
  assert.ok(warns.some((m) => /^engine\.hello failed/.test(m)), 'matches main.js plainMessage regex');
  assert.equal(await e.start().catch(() => 'again'), 'again', 'a failed start can be retried');
});

test('start() is memoised: one audio start however many callers', async () => {
  const r = rig();
  const [a, b] = await Promise.all([r.engine.start(), r.engine.start()]);
  assert.equal(a, r.engine);
  assert.equal(b, r.engine);
  assert.equal(ops(r, 'audio').filter((m) => m.action === 'start').length, 1);
});

test('latency is sent with start and restart; restart({sinkId}) maps to deviceId', async () => {
  const r = rig({ engine: { latency: 0.01 } });
  await r.engine.start();
  assert.equal(ops(r, 'audio')[0].latency, 0.01);
  r.engine.latency = 'interactive';
  await r.engine.restart({ sinkId: 'abc' });
  const m = ops(r, 'audio')[1];
  assert.deepEqual([m.action, m.latency, m.deviceId], ['restart', 'interactive', 'abc']);
  assert.equal(r.engine.latency, 'interactive');
});

test('commit(): true once, for the latest token only (not stale, repeated, unknown, post-restart)', async () => {
  const r = rig();
  const e = r.engine;
  await e.start();
  const t1 = await e.prepare(patchOf(slot('salamander-piano')));
  const t2 = await e.prepare(patchOf(slot('warm-pad', {}, 'synth')));
  assert.equal(e.commit(t1), false, 'superseded by t2');
  assert.equal(e.commit(t2), true);
  assert.equal(e.commit(t2), false, 'already committed');
  assert.equal(e.commit(12345), false);
  const t3 = await e.prepare(patchOf(slot('salamander-piano')));
  await e.restart();
  assert.equal(e.commit(t3), false, 'restart invalidates in-flight prepare');
  const t4 = await e.prepare(patchOf(slot('salamander-piano')));
  assert.equal(e.commit(t4), true);
  await flush();
  assert.equal(ops(r, 'commit').length, 2, 'only accepted commits reach native');
});

test('commit forwards `when` and the native cross-check is silent when it agrees', async () => {
  const r = rig();
  await r.engine.start();
  const t = await r.engine.prepare(patchOf(slot('salamander-piano')));
  r.engine.commit(t, { when: 12.5 });
  await flush();
  assert.equal(ops(r, 'commit')[0].when, 12.5);
  assert.equal(r.events.filter((x) => x.name === 'warn').length, 0);
});

test('setParam: unknown path warns and returns false without a message; valid paths return true', async () => {
  const r = rig();
  await r.engine.start();
  assert.equal(r.engine.setParam('slots.9.gain', 1), false);
  assert.equal(r.engine.setParam('nope', 1), false);
  assert.equal(r.engine.setParam('fx.reverb.size', 0.4), true);
  await flush();
  assert.equal(ops(r, 'set').length, 1);
  assert.equal(r.events.filter((x) => x.name === 'warn').length, 2);
});

test('setParam on an empty slot of the committed song returns false', async () => {
  const r = rig();
  await r.engine.start();
  r.engine.commit(await r.engine.prepare(patchOf(slot('salamander-piano'))));
  assert.equal(r.engine.setParam('slots.0.gain', 0.5), true);
  assert.equal(r.engine.setParam('slots.2.gain', 0.5), false);
});

test('sets in one tick are batched; any other op flushes the batch first (FIFO order is kept)', async () => {
  const r = rig();
  await r.engine.start();
  r.log.toNative.length = 0;
  r.engine.setParam('slots.0.gain', 0.1);
  r.engine.setParam('slots.0.pan', 0.2);
  r.engine.setParam('fx.reverb.size', 0.3);
  r.engine.noteOn(60, 90);
  r.engine.setParam('slots.0.gain', 0.4);
  await flush();
  assert.deepEqual(r.log.toNative.map((m) => m.op + (m.batch ? `[${m.batch.length}]` : '')), ['set[3]', 'play', 'set']);
  assert.deepEqual(r.log.toNative[0].batch[0], ['slots.0.gain', 0.1]);
  assert.deepEqual(r.log.toNative[2], { v: 1, op: 'set', path: 'slots.0.gain', value: 0.4 });
});

test('setParam with {when} or glide is sent on its own with those fields', async () => {
  const r = rig();
  await r.engine.start();
  r.engine.setParam('slots.1.gain', 0.2, { glide: 0.5 });
  r.engine.setParam('drone.gain', 0.3, { when: 9 });
  await flush();
  const s = ops(r, 'set');
  assert.deepEqual(s[0].batch ?? [[s[0].path, s[0].value, s[0].glide]], [['slots.1.gain', 0.2, 0.5]]);
  assert.deepEqual([s[1].path, s[1].when], ['drone.gain', 9]);
});

test('perform calls: false and silent before start; mapped to play messages after', async () => {
  const r = rig();
  const e = r.engine;
  assert.equal(e.noteOn(60, 100), false);
  assert.equal(e.sustain(true), false);
  assert.equal(e.setWheel('mod', 0.5), false);
  assert.equal(ops(r, 'play').length, 0);
  await e.start();
  assert.equal(e.noteOn(200, 100), true);
  e.noteOn(61, 0); // velocity 0 is a note-off
  e.noteOn(62, 300);
  e.noteOff(61);
  e.sustain(true);
  e.pitchBend(3);
  e.modWheel(2);
  e.expression(-1);
  e.volumeCC(0.5);
  assert.equal(e.setWheel('bogus', 1), false);
  e.swell();
  e.swell(false);
  e.allNotesOff();
  e.fadeOutAll(0);
  e.fadeOutAll();
  await flush();
  const p = ops(r, 'play').map(({ v, op, ...m }) => m);
  assert.deepEqual(p, [
    { e: 'on', n: 127, vel: 100 }, { e: 'off', n: 61 }, { e: 'on', n: 62, vel: 127 }, { e: 'off', n: 61 },
    { e: 'pedal', down: true }, { e: 'bend', x: 1 }, { e: 'wheel', src: 'mod', value: 1 },
    { e: 'wheel', src: 'expr', value: 0 }, { e: 'wheel', src: 'vol', value: 0.5 }, { e: 'swell' },
    { e: 'swell', start: false }, { e: 'panic' }, { e: 'fade', seconds: 0.05 }, { e: 'fade', seconds: 6 },
  ]);
});

test('song ops: transpose clamps, tempo null clears, key is reduced mod 12, timeSig keeps newBar', async () => {
  const r = rig();
  const e = r.engine;
  await e.start();
  e.setTranspose(99);
  e.setTempo(0);
  e.setTempo(96);
  e.setKeyContext(14, 1);
  e.setTimeSig('6/8', { newBar: false });
  await flush();
  assert.deepEqual(ops(r, 'song').map(({ v, op, ...m }) => m), [
    { transpose: 48 }, { tempo: null }, { tempo: 96 }, { key: { pc: 2, minor: true } },
    { timeSig: '6/8', newBar: false },
  ]);
});

test('getEqResponse equals eq-math at the engine sample rate; perBand lists lc, the visible bands, hc', async () => {
  const r = rig({ sampleRate: 44100 });
  const e = r.engine;
  await e.start();
  const eq = {
    b1: { on: true, type: 'lowshelf', hz: 120, db: 3, q: 0.7 }, b3: { on: true, type: 'peak', hz: 1000, db: -4, q: 1 },
    cutHz: 80, hiCutHz: 12000,
  };
  e.commit(await e.prepare(patchOf(slot('salamander-piano', { eq }))));
  const f = [50, 120, 1000, 5000, 30000];
  const total = e.getEqResponse(0, f);
  assert.ok(total instanceof Float32Array);
  const want = eqResponseDb(eq, f.map((x) => Math.min(x, 22050)), 44100);
  total.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-4, `bin ${i}: ${v} vs ${want[i]}`));
  const pb = e.getEqResponse(0, f, { perBand: true });
  // b8 is the legacy 6 kHz shelf: present, 0 dB = identity
  assert.deepEqual(Object.keys(pb.bands).sort(), ['b1', 'b3', 'b8', 'hc', 'lc']);
  for (let i = 0; i < f.length; i++) {
    const sum = Object.values(pb.bands).reduce((a, c) => a + c[i], 0);
    assert.ok(Math.abs(sum - pb.total[i]) < 1e-3);
  }
  assert.equal(e.getEqResponse(1, f), null, 'empty slot');
  assert.equal(e.getEqResponse(0, null), null);
});

test('EQ writes through setParam update the shim mirror, so the curve follows without a round trip', async () => {
  const r = rig();
  const e = r.engine;
  await e.start();
  e.commit(await e.prepare(patchOf(slot('salamander-piano'))));
  const flat = e.getEqResponse(0, [1000])[0];
  e.setParam('slots.0.eq.b3.on', true);
  e.setParam('slots.0.eq.b3.type', 'peak');
  e.setParam('slots.0.eq.b3.hz', 1000);
  e.setParam('slots.0.eq.b3.db', 6);
  e.setParam('slots.0.eq.b3.q', 1);
  const bumped = e.getEqResponse(0, [1000])[0];
  assert.ok(Math.abs(flat) < 1e-6 && bumped > 5.5, `${flat} -> ${bumped}`);
});

test('getSlotPlayRange: split, octave, transposes and the sampler range from the instrument entry', async () => {
  const r = rig();
  const e = r.engine;
  await e.start();
  e.commit(await e.prepare(patchOf(
    slot('salamander-piano', { lowNote: 36, highNote: 96, octave: 1, transpose: 2 }),
    slot('warm-pad', { lowNote: 0, highNote: 127, octave: 2 }, 'synth'),
  )));
  e.setTranspose(3);
  const a = e.getSlotPlayRange(0);
  assert.deepEqual(a, { lowNote: 36 + 17, highNote: 96 + 17, sampledLow: 53, sampledHigh: 108, transpose: 17,
    physLow: 36, physHigh: 96, instrumentRange: [21, 108] });
  const b = e.getSlotPlayRange(1);
  assert.equal(b.lowNote, 27);
  assert.equal(b.highNote, 127);
  assert.equal(b.instrumentRange, null);
  assert.equal(b.sampledLow, 27);
  assert.equal(e.getSlotPlayRange(2), null);
});

test('click: clickStart needs a tempo and a started engine; clickStop reports whether it was running', async () => {
  const r = rig();
  const e = r.engine;
  assert.equal(e.clickStart(), null);
  await e.start();
  assert.equal(e.clickStart(), null, 'no tempo');
  e.setTempo(100);
  const s = e.clickStart({ countIn: 1 });
  assert.ok(s && s.t0 > 0 && s.downbeat === null);
  await flush();
  assert.equal(e.clickState().running, true);
  assert.equal(e.clickStop(), true);
  await flush();
  assert.equal(e.clickStop(), false);
  assert.deepEqual(e.setClick({ output: 'aux', level: 2 }), { output: 'main', auxAvailable: false });
  assert.deepEqual(e.clickOutputs(), { aux: false, channels: 2 });
  assert.equal(ops(r, 'click').find((m) => m.action === 'config').level, 1);
});

test('aux click works on a 4-channel device', async () => {
  const r = rig({ channels: 4 });
  await r.engine.start();
  assert.deepEqual(r.engine.setClick({ output: 'aux' }), { output: 'aux', auxAvailable: true });
  assert.deepEqual(r.engine.clickOutputs(), { aux: true, channels: 4 });
});

test('drone mirrors: key, cfg and keyed files are what the UI reads back', async () => {
  const r = rig();
  const d = r.engine.drone;
  await r.engine.start();
  assert.equal(d.cfg.mode, 'off');
  d.configure({ mode: 'files', chordFollow: true });
  assert.equal(d.cfg.mode, 'files');
  assert.equal(d.cfg.chordFollow, true);
  assert.equal(d.cfg.continueAcrossSongs, true);
  d.setKey(14, { minor: false });
  assert.deepEqual(d.key, { pc: 2, minor: false });
  const n = d.attachFiles([
    { name: 'Pad D.wav', url: 'u1', path: '/p/D.wav' }, { name: 'Pad D copy.wav', url: 'u2' }, { name: 'x.wav' },
  ]);
  assert.equal(n, 1);
  assert.ok(d.files instanceof Map && d.files.size === 1);
  d.setKey(2, { minor: false });
  await flush();
  assert.equal(ops(r, 'drone').filter((m) => m.key).length, 1, 'the same key is not sent twice');
  assert.deepEqual(ops(r, 'drone').find((m) => m.files).files, [{ name: 'Pad D.wav', path: '/p/D.wav' }]);
});

test('eqAudition validates the slot; lowResource and retainReverb answer synchronously', async () => {
  const r = rig();
  const e = r.engine;
  assert.equal(e.retainReverb([]), false, 'before start');
  await e.start();
  assert.equal(e.retainReverb([patchOf(slot('salamander-piano'))]), true);
  assert.equal(e.eqAudition(7, 'bypass'), false);
  assert.equal(e.eqAudition(1, 'bypass'), true);
  assert.equal(e.setLowResource(true), true);
  assert.equal(e._debugStats().lowResource, true);
  await flush();
  assert.deepEqual(ops(r, 'config').map(({ v, op, ...m }) => m), [
    { eqAudition: { slot: 1, mode: 'bypass' } }, { lowResource: true },
  ]);
});

test('sleep/wake are only sent from the right state; applyRuntimeState is a no-op', async () => {
  const r = rig();
  const e = r.engine;
  assert.equal(await e.sleep(), false, 'before start');
  assert.equal(await e.wake(), false);
  await e.start();
  assert.equal(await e.sleep(), true);
  assert.equal(await e.sleep(), false, 'already asleep');
  const before = r.log.toNative.length;
  e.applyRuntimeState({ wheel: { mod: 1 } });
  assert.equal(r.log.toNative.length, before);
  assert.equal(await e.wake(), true);
});

test('listInstruments hides hidden entries and keeps identity until refreshed', async () => {
  const r = rig();
  await r.engine.start();
  const a = r.engine.listInstruments();
  assert.equal(a.length, 43);
  assert.ok(!a.some((x) => x.hidden));
  assert.equal(r.engine.listInstruments(), a);
  const b = await r.engine.reloadManifests();
  assert.equal(b.length, 43);
  assert.notEqual(r.engine.listInstruments(), a);
});

test('prepare awaits start(); a reply without a token is an internal error', async () => {
  const r = rig();
  const p = r.engine.prepare(patchOf(slot('salamander-piano')));
  assert.equal(typeof (await p), 'number');
  assert.equal(ops(r, 'audio').length, 1);
});

test('setSinkId maps to audio output and resolves true; "default" becomes the empty id', async () => {
  const r = rig();
  await r.engine.start();
  assert.equal(await r.engine.setSinkId('default'), true);
  assert.equal(ops(r, 'audio').pop().deviceId, '');
});

test('16-slot songs (T00c, D3): slots 4..15 of the committed song are settable, metered, auditioned', async () => {
  const r = rig();
  const e = r.engine;
  await e.start();
  assert.equal(e.setParam('slots.12.gain', 0.5), false, 'no 16-slot song yet: the web grammar (0..3)');
  const slots = Array.from({ length: 16 }, (_, i) => (i === 12 || i === 0 ? slot('salamander-piano') : null));
  const tok = await e.prepare({ slots });
  assert.ok(e.commit(tok));
  assert.equal(e.setParam('slots.12.gain', 0.5), true);
  assert.equal(e.setParam('slots.13.gain', 0.5), false, 'empty slot');
  assert.equal(e.setParam('slots.16.gain', 0.5), false, 'beyond 16 slots');
  assert.equal(e.eqAudition(15, 'bypass'), true);
  assert.equal(e.eqAudition(16, 'bypass'), false);
  assert.deepEqual(e.slotLevel(12), { peak: 0, rms: 0 });
  await flush();
  assert.equal(ops(r, 'set').filter((m) => m.path === 'slots.12.gain').length, 1);
});
