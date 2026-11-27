// Lane NMA: NativeMidiAccess (app/js/engine-bridge/native-midi.js) against MockNative, with the real midi.js and
// midi-clock.js on top: the Web MIDI surface they read, listen sets per selection mode, hot-plug, timestamps, send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, fakeEnv, flush } from './helpers.mjs';
import { BridgeEngine } from '../../../app/js/engine-bridge/bridge-engine.js';
import { MockNative } from '../../../app/js/engine-bridge/mock-native.js';
import { loopbackPair } from '../../../app/js/engine-bridge/transports.js';
import { NativeMidiAccess, installNativeMidi } from '../../../app/js/engine-bridge/native-midi.js';
import { MidiInput, NO_KEYBOARD_HINT } from '../../../app/js/midi.js';
import { createMidiClock } from '../../../app/js/midi-clock.js';

const NORD = { id: 'k1', name: 'Nord Stage 3 MIDI Output', manufacturer: 'Clavia', kind: 'input' };
const IAC = { id: 'v1', name: 'IAC Driver Bus 1', manufacturer: 'Apple Inc.', kind: 'input' };
const KEYSTATION = { id: 'k2', name: 'Keystation 49 MK3 USB', manufacturer: 'M-Audio', kind: 'input' };
const CLOCK_OUT = { id: 'o1', name: 'Clock Out', manufacturer: 'Roland', kind: 'output' };

/** Engine + MockNative (with MIDI ports) + a navigator without Web MIDI + the adapter installed on it. */
function setup({ ports = [NORD, IAC, CLOCK_OUT] } = {}) {
  const env = fakeEnv();
  const { js, native, log } = loopbackPair({ schedule: 'sync' });
  const mock = new MockNative({ api, transport: native, now: env.now, timers: env.timers, midiPorts: ports });
  const engine = new BridgeEngine({ transport: js, now: env.now, timers: env.timers });
  const nav = {};
  const access = installNativeMidi(engine, { nav });
  const events = [];
  const midi = new MidiInput({ nav, now: env.now, warn: () => {} });
  for (const t of ['noteon', 'noteoff', 'cc', 'program', 'disconnected', 'devices', 'switched', 'input']) {
    midi.addEventListener(t, (e) => events.push([t, e.detail]));
  }
  const listens = () => log.toNative.filter((m) => m.op === 'midi' && m.action === 'listen').map((m) => m.ids);
  const of = (t) => events.filter((e) => e[0] === t).map((e) => e[1]);
  return { env, mock, engine, nav, access, midi, events, of, listens, log };
}

test('install: only on a navigator without Web MIDI; sysex is refused; a second engine re-targets', async () => {
  const env = fakeEnv();
  const { js } = loopbackPair();
  const engine = new BridgeEngine({ transport: js, now: env.now, timers: env.timers });
  const own = () => Promise.resolve('chrome');
  const chrome = { requestMIDIAccess: own };
  assert.equal(installNativeMidi(engine, { nav: chrome }), null);
  assert.equal(chrome.requestMIDIAccess, own, 'Chrome / Electron keep their own Web MIDI');
  assert.equal(installNativeMidi(null, { nav: {} }), null);
  const nav = {};
  const a = installNativeMidi(engine, { nav });
  assert.ok(a instanceof NativeMidiAccess);
  assert.equal(typeof nav.requestMIDIAccess, 'function');
  await assert.rejects(nav.requestMIDIAccess({ sysex: true }), /SysEx/);
  const b = installNativeMidi(engine, { nav });
  assert.notEqual(a, b);
  assert.equal(nav.requestMIDIAccess.nativeMidi.access, b);
});

test('requestMIDIAccess: one listen request, its reply is the port snapshot (inputs / outputs Maps)', async () => {
  const r = setup();
  const access = await r.nav.requestMIDIAccess({ sysex: false });
  assert.equal(access, r.access);
  assert.equal(await r.nav.requestMIDIAccess(), access, 'idempotent');
  assert.deepEqual(r.listens(), [[]], 'one listen, nobody attached yet');
  assert.ok(access.inputs instanceof Map && access.outputs instanceof Map);
  assert.deepEqual([...access.inputs.keys()], ['k1', 'v1']);
  assert.deepEqual([...access.outputs.keys()], ['o1']);
  const k = access.inputs.get('k1');
  assert.deepEqual({ id: k.id, name: k.name, manufacturer: k.manufacturer, type: k.type, state: k.state },
    { id: 'k1', name: NORD.name, manufacturer: 'Clavia', type: 'input', state: 'connected' });
  assert.equal(k.connection, 'closed');
  assert.equal(access.outputs.get('o1').type, 'output');
  assert.equal(access.sysexEnabled, false);
  assert.deepEqual(r.mock.findings, [], 'every message is contract-valid');
});

test("midi.js 'first' over the adapter: listens to the hardware keyboard only; a note reaches noteon", async () => {
  const r = setup();
  assert.equal(await r.midi.init(), true);
  assert.equal(r.midi.available, true);
  await flush();
  assert.deepEqual(r.listens(), [[], ['k1']], 'the IAC bus is never connected');
  assert.deepEqual(r.midi.active, { id: 'k1', name: NORD.name, fallback: false, standIn: false });
  assert.equal(r.access.inputs.get('k1').connection, 'open');
  r.env.advance(5);
  assert.equal(r.mock.midiIn('k1', [0x90, 60, 100]), true);
  assert.equal(r.mock.midiIn('v1', [0x90, 61, 100]), false, 'not listened: the shell does not forward it');
  const on = r.of('noteon');
  assert.equal(on.length, 1);
  assert.deepEqual({ ...on[0], timestamp: undefined },
    { note: 60, velocity: 100, channel: 0, inputId: 'k1', timestamp: undefined });
  r.mock.midiIn('k1', [0x80, 60, 0]);
  r.mock.midiIn('k1', [0xb0, 64, 127]);
  r.mock.midiIn('k1', [0xc1, 4]);
  assert.equal(r.of('noteoff').length, 1);
  assert.deepEqual(r.of('cc').map((d) => [d.cc, d.value]), [[64, 127]]);
  assert.deepEqual(r.of('program').map((d) => [d.program, d.channel]), [[4, 1]]);
  assert.deepEqual(r.mock.findings, []);
});

test("'all' and 'device' selections become the listen set; one listen per change", async () => {
  const r = setup();
  await r.midi.init();
  await flush();
  r.midi.select('all');
  await flush();
  assert.deepEqual(r.listens().at(-1), ['k1', 'v1']);
  r.midi.select('v1');
  await flush();
  assert.deepEqual(r.listens().at(-1), ['v1']);
  const n = r.listens().length;
  r.midi.select('v1'); // same selection: re-attached, same set → nothing sent
  await flush();
  assert.equal(r.listens().length, n);
  r.mock.midiIn('v1', [0x90, 64, 90]);
  assert.equal(r.of('noteon').at(-1).inputId, 'v1');
});

test('no hardware: listens to every port with the hint; a keyboard plugged in takes over (switched)', async () => {
  const r = setup({ ports: [IAC] });
  await r.midi.init();
  await flush();
  assert.deepEqual(r.listens().at(-1), ['v1']);
  assert.equal(r.of('devices').at(-1).hint, NO_KEYBOARD_HINT);
  r.mock.midiPlug(KEYSTATION);
  await flush();
  assert.equal(r.access.inputs.get('k2').state, 'connected');
  assert.deepEqual(r.listens().at(-1), ['k2']);
  assert.deepEqual(r.of('input').at(-1), { inputId: 'k2', kind: 'hotplug' });
  assert.equal(r.of('switched').at(-1).inputId, 'k2');
  assert.equal(r.of('disconnected').at(-1).inputId, 'v1', 'the dropped fallback port releases its notes');
});

test('hot-unplug: the port goes disconnected, midi.js releases it, listen drops it; re-plug listens again', async () => {
  const r = setup({ ports: [NORD, KEYSTATION] });
  await r.midi.init();
  await flush();
  assert.equal(r.midi.active.id, 'k2', 'Keystation (vendor + USB in the name) outranks the Nord (vendor only)');
  const k2 = r.access.inputs.get('k2');
  const portEvents = [];
  k2.onstatechange = (e) => portEvents.push(e.port.state);
  const accessEvents = [];
  r.access.addEventListener('statechange', (e) => accessEvents.push([e.port.id, e.port.state]));
  r.mock.midiIn('k2', [0x90, 60, 100]);
  r.mock.midiUnplug('k2');
  await flush();
  assert.equal(k2.state, 'disconnected');
  assert.ok(r.access.inputs.has('k2'), 'a disconnected port stays in the map (as in Chrome)');
  assert.deepEqual(portEvents, ['disconnected']);
  assert.deepEqual(accessEvents, [['k2', 'disconnected']]);
  assert.deepEqual(r.of('disconnected').at(-1), { inputId: 'k2', name: KEYSTATION.name });
  assert.equal(r.midi.active.id, 'k1', 'the Nord stands in');
  assert.deepEqual(r.listens().at(-1), ['k1']);
  r.mock.midiPlug(KEYSTATION);
  await flush();
  assert.equal(k2.state, 'connected');
  assert.equal(r.access.inputs.get('k2'), k2, 'the same port object comes back');
  assert.deepEqual(accessEvents.at(-1), ['k2', 'connected']);
  assert.equal(r.midi.active.id, 'k1', "'first' is sticky (L8): the replugged board does not take over");
  r.midi.select('k2');
  await flush();
  assert.deepEqual(r.listens().at(-1), ['k2']);
  assert.equal(r.mock.midiIn('k2', [0x90, 62, 80]), true);
  assert.equal(r.of('noteon').at(-1).note, 62);
});

test('timestamps: engine seconds → performance.now() ms through the last tick; stale or no clock → now', async () => {
  const r = setup();
  await r.midi.init();
  await flush();
  const port = r.access.inputs.get('k1');
  const got = [];
  port.addEventListener('midimessage', (e) => got.push(e));
  r.mock.midiIn('k1', [0x90, 60, 1], { ts: 0.5 }); // before any tick: no clock map yet
  assert.equal(got.at(-1).timeStamp, r.env.now());
  await r.engine.start();
  r.env.advance(1000);
  r.mock.emitTick();
  const c = r.engine._clock;
  assert.ok(c.t > 0);
  r.env.advance(20);
  r.mock.midiIn('k1', [0x90, 60, 2], { ts: c.t + 0.010 });
  assert.ok(Math.abs(got.at(-1).timeStamp - (c.perf + 10)) < 1e-6, `${got.at(-1).timeStamp} vs ${c.perf + 10}`);
  assert.ok(got.at(-1).data instanceof Uint8Array);
  assert.deepEqual([...got.at(-1).data], [0x90, 60, 2]);
  r.mock.midiIn('k1', [0x90, 60, 3], { ts: c.t + 5 }); // ahead of the page: never in the future
  assert.equal(got.at(-1).timeStamp, r.env.now());
  r.mock.midiIn('k1', [0x90, 60, 4], { ts: c.t - 30 }); // a stale map (asleep): now
  assert.equal(got.at(-1).timeStamp, r.env.now());
  assert.equal(r.of('noteon').at(-1).timestamp, r.env.now(), 'midi.js gets the mapped timestamp');
});

test('a reply snapshot older than a ports event does not undo it', async () => {
  const env = fakeEnv();
  const { js, native, log } = loopbackPair({ schedule: 'sync' });
  native.onMessage(() => {});
  const engine = new BridgeEngine({ transport: js, now: env.now, timers: env.timers });
  const nav = {};
  installNativeMidi(engine, { nav });
  const p = nav.requestMIDIAccess();
  await flush();
  const req = log.toNative.find((m) => m.op === 'midi');
  assert.deepEqual(req.ids, []);
  // one batch: the reply (built first) then a newer port report; the event is dispatched before the continuation
  native.post([
    { v: 1, re: req.id, ok: true, result: { ports: [{ ...NORD, state: 'connected' }] } },
    { v: 1, ev: 'midi', type: 'ports', ports: [{ ...KEYSTATION, state: 'connected' }] },
  ]);
  const access = await p;
  assert.equal(access.inputs.get('k2').state, 'connected');
  assert.equal(access.inputs.has('k1'), false, 'the older snapshot was not applied');
});

test('a listen that fails rejects requestMIDIAccess (midi.js: unavailable "failed"); a retry can succeed', async () => {
  const env = fakeEnv();
  const { js, native, log } = loopbackPair({ schedule: 'sync' });
  native.onMessage(() => {});
  const engine = new BridgeEngine({ transport: js, now: env.now, timers: env.timers });
  const nav = {};
  installNativeMidi(engine, { nav });
  const midi = new MidiInput({ nav, warn: () => {} });
  const un = [];
  midi.addEventListener('unavailable', (e) => un.push(e.detail.reason));
  const init = midi.init();
  await flush();
  const req = log.toNative.find((m) => m.op === 'midi');
  native.post({ v: 1, re: req.id, ok: false, error: { code: 'unsupported', message: 'no midi service' } });
  assert.equal(await init, false);
  assert.deepEqual(un, ['failed']);
  const again = nav.requestMIDIAccess();
  await flush();
  const req2 = log.toNative.filter((m) => m.op === 'midi').at(-1);
  assert.notEqual(req2.id, req.id);
  native.post({ v: 1, re: req2.id, ok: true, result: { ports: [] } });
  assert.equal((await again).inputs.size, 0);
});

test('a message for a port midi.js detached (in flight) or a malformed one is dropped', async () => {
  const r = setup();
  await r.midi.init();
  await flush();
  r.mock._emit('midi', { type: 'msg', port: 'v1', data: [0x90, 1, 1], ts: 0, handled: false });
  r.mock._emit('midi', { type: 'msg', port: 'k1', data: [300], ts: 0, handled: false });
  r.mock._emit('midi', { type: 'msg', port: 'nope', data: [0x90, 1, 1], ts: 0, handled: false });
  r.mock._flush();
  assert.equal(r.of('noteon').length, 0);
  assert.equal(r.access.stats.dropped, 3);
});

test('output.send → midi send {port, data, when?}; Web MIDI errors for bad bytes, SysEx, a disconnected port',
  async () => {
    const r = setup();
    const access = await r.nav.requestMIDIAccess();
    await r.engine.start();
    r.env.advance(500);
    r.mock.emitTick();
    const out = access.outputs.get('o1');
    out.send([0xf8]);
    out.send(new Uint8Array([0xfa]), r.env.now() + 40);
    out.send([0xfc], r.env.now() - 5); // in the past: now
    assert.deepEqual(r.mock.midi.sent.map((s) => s.data), [[0xf8], [0xfa], [0xfc]]);
    assert.equal(r.mock.midi.sent[0].when, undefined);
    assert.ok(Math.abs(r.mock.midi.sent[1].when - (r.engine._clock.t + 0.04)) < 1e-9);
    assert.equal(r.mock.midi.sent[2].when, undefined);
    assert.throws(() => out.send([256]), TypeError);
    assert.throws(() => out.send([]), TypeError);
    assert.throws(() => out.send([0xf0, 1, 0xf7]), /SysEx/);
    r.mock.midiUnplug('o1', 'output');
    assert.equal(out.state, 'disconnected');
    assert.throws(() => out.send([0xf8]), (e) => e.name === 'InvalidStateError');
    assert.deepEqual(r.mock.findings, []);
  });

test('midi-clock.js over the adapter: outputs, setOutput by name, the sink is tagged with the chosen name', async () => {
  const r = setup();
  await r.midi.init();
  const ctx = r.engine.ctx;
  const clock = createMidiClock({ getAccess: () => r.midi.access, getCtx: () => ctx });
  assert.deepEqual(clock.outputs(), [{ id: 'o1', name: 'Clock Out', state: 'connected' }]);
  assert.equal(clock.setOutput('Clock Out'), true);
  assert.equal(clock.connected, true);
  assert.equal(clock.sink.portId, 'Clock Out', 'BridgeEngine.setClockSink sends it as config.midiClock.port');
  r.engine.setClockSink(clock.sink);
  const cfg = r.log.toNative.filter((m) => m.op === 'config' && m.midiClock).at(-1);
  assert.deepEqual(cfg.midiClock, { port: 'Clock Out' });
  r.mock.midiUnplug('o1', 'output');
  assert.equal(clock.resolve(), false);
  assert.equal(clock.setOutput(null), false);
  assert.equal(clock.sink.portId, null);
  r.engine.setClockSink(null);
  assert.deepEqual(r.log.toNative.filter((m) => m.op === 'config' && m.midiClock).at(-1).midiClock, { port: null });
});
