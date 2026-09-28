import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MidiInput, bendValue, isVirtualPortName } from '../../../app/js/midi.js';

function capture(m) {
  const ev = [];
  for (const t of ['noteon', 'noteoff', 'cc', 'bend', 'program', 'disconnected', 'devices', 'unavailable']) m.addEventListener(t, (e) => ev.push([t, e.detail]));
  return ev;
}
const quiet = { warn: () => {} };

test('note on/off, velocity-0 = off, channels', () => {
  const m = new MidiInput({ nav: null, ...quiet });
  const ev = capture(m);
  m._inject([0x90, 60, 100], 1, 'kb');
  m._inject([0x91, 62, 0], 2, 'kb');
  m._inject([0x80, 60, 64], 3, 'kb');
  assert.deepEqual(ev, [
    ['noteon', { note: 60, velocity: 100, channel: 0, inputId: 'kb', timestamp: 1 }],
    ['noteoff', { note: 62, velocity: 0, channel: 1, inputId: 'kb', timestamp: 2 }],
    ['noteoff', { note: 60, velocity: 64, channel: 0, inputId: 'kb', timestamp: 3 }],
  ]);
});

test('running status across and within packets; realtime bytes interleaved; sysex skipped', () => {
  const m = new MidiInput({ nav: null, ...quiet });
  const ev = capture(m);
  m._inject([0x90, 60, 100, 64, 90], 0, 'a'); // two note-ons, running status
  m._inject([67, 80], 0, 'a'); // running status carried to the next packet
  m._inject([0xf8, 60, 0xfe, 0], 0, 'a'); // clock + active sensing mid-message
  m._inject([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7, 0xb0, 64, 127], 0, 'a'); // sysex then CC
  m._inject([12, 34], 0, 'b'); // stray data on another input → ignored
  assert.deepEqual(ev.map(([t, d]) => [t, d.note ?? d.cc, d.velocity ?? d.value]), [
    ['noteon', 60, 100], ['noteon', 64, 90], ['noteon', 67, 80], ['noteoff', 60, 0], ['cc', 64, 127],
  ]);
});

test('14-bit pitch bend mapping is exact at the extremes and centre', () => {
  assert.equal(bendValue(0, 0), -1);
  assert.equal(bendValue(0, 64), 0);
  assert.equal(bendValue(127, 127), 1);
  const m = new MidiInput({ nav: null, ...quiet });
  const ev = capture(m);
  m._inject([0xe0, 0x00, 0x40]);
  m._inject([0xe0, 0x7f, 0x7f]);
  m._inject([0xe0, 0x00, 0x00]);
  m._inject([0xe0, 0x00, 0x60]); // 12288 → 4096/8191
  assert.deepEqual(ev.map(([, d]) => d.value), [0, 1, -1, 4096 / 8191]);
  assert.equal(ev[0][1].raw, 8192);
});

test('CC value01, program change, aftertouch ignored', () => {
  const m = new MidiInput({ nav: null, ...quiet });
  const ev = capture(m);
  m._inject([0xb3, 1, 127]);
  m._inject([0xc0, 5]);
  m._inject([0xd0, 90]); // channel pressure
  m._inject([0xa0, 60, 90]); // poly AT
  assert.deepEqual(ev, [
    ['cc', { cc: 1, value: 127, value01: 1, channel: 3, inputId: 'test', timestamp: ev[0][1].timestamp }],
    ['program', { program: 5, channel: 0, inputId: 'test', timestamp: ev[1][1].timestamp }],
  ]);
});

test('learn resolves on the next CC or note-on and swallows it; timeout → null', async () => {
  const m = new MidiInput({ nav: null, ...quiet });
  const ev = capture(m);
  const p = m.learn('nextSong');
  assert.equal(m.learning, 'nextSong');
  m._inject([0x80, 60, 0]); // note-off does not complete learning
  m._inject([0xb2, 80, 127], 0, 'foot');
  assert.deepEqual(await p, { cc: 80, channel: 2, inputId: 'foot', controlId: 'nextSong' });
  assert.deepEqual(ev.map((e) => e[0]), ['noteoff'], 'the learning CC was swallowed');
  const p2 = m.learn('panic');
  m._inject([0x90, 36, 100], 0, 'pads');
  assert.deepEqual(await p2, { note: 36, channel: 0, inputId: 'pads', controlId: 'panic' });
  const p3 = m.learn('x', { timeoutMs: 10 });
  assert.equal(await p3, null);
  const p4 = m.learn('y');
  m.cancelLearn();
  assert.equal(await p4, null);
});

// ---- fake Web MIDI access for init/select/hot-plug
function fakePort(id, name) {
  return { id, name, manufacturer: 'Test', type: 'input', state: 'connected', connection: 'closed', onmidimessage: null };
}
function fakeAccess(ports) {
  const a = new EventTarget();
  a.inputs = new Map(ports.map((p) => [p.id, p]));
  a.fire = (port) => {
    const e = new Event('statechange');
    e.port = port;
    a.dispatchEvent(e);
  };
  return a;
}

test('init: unsupported / denied / failed → unavailable (warn, no throw)', async () => {
  const warns = [];
  const m1 = new MidiInput({ nav: {}, warn: (w) => warns.push(w) });
  const e1 = capture(m1);
  assert.equal(await m1.init(), false);
  assert.equal(e1.find((e) => e[0] === 'unavailable')[1].reason, 'unsupported');
  const denied = Object.assign(new Error('nope'), { name: 'SecurityError' });
  const m2 = new MidiInput({ nav: { requestMIDIAccess: () => Promise.reject(denied) }, warn: (w) => warns.push(w) });
  const e2 = capture(m2);
  assert.equal(await m2.init(), false);
  assert.equal(e2.find((e) => e[0] === 'unavailable')[1].reason, 'denied');
  const m3 = new MidiInput({ nav: { requestMIDIAccess: () => Promise.reject(new Error('Platform dependent initialization failed.')) }, warn: (w) => warns.push(w) });
  assert.equal(await m3.init(), false);
  assert.equal(m3.unavailableReason, 'failed');
  assert.equal(warns.length, 3);
});

test("select 'first' skips virtual ports; 'all'; by id; sysex never requested", async () => {
  const iac = fakePort('iac', 'IAC Driver Bus 1');
  const kb = fakePort('kb', 'Arturia KeyLab 61');
  const pads = fakePort('pads', 'nanoPAD2');
  const access = fakeAccess([iac, kb, pads]);
  let opts = null;
  const m = new MidiInput({ nav: { requestMIDIAccess: (o) => ((opts = o), Promise.resolve(access)) }, ...quiet });
  const ev = capture(m);
  assert.equal(await m.init(), true);
  assert.deepEqual(opts, { sysex: false });
  assert.deepEqual(m.inputs.filter((i) => i.selected).map((i) => i.id), ['kb']);
  assert.equal(typeof kb.onmidimessage, 'function');
  assert.equal(iac.onmidimessage, null);
  assert.ok(isVirtualPortName('IAC Driver Bus 1') && !isVirtualPortName('Arturia KeyLab 61'));
  kb.onmidimessage({ data: new Uint8Array([0x90, 60, 90]), timeStamp: 5 });
  assert.deepEqual(ev.filter((e) => e[0] === 'noteon')[0][1], { note: 60, velocity: 90, channel: 0, inputId: 'kb', timestamp: 5 });
  m.select('all');
  assert.deepEqual(m.inputs.filter((i) => i.selected).map((i) => i.id).sort(), ['iac', 'kb', 'pads']);
  m.select('pads');
  assert.deepEqual(m.inputs.filter((i) => i.selected).map((i) => i.id), ['pads']);
  const disc = ev.filter((e) => e[0] === 'disconnected').map((e) => e[1].inputId).sort();
  assert.deepEqual(disc, ['iac', 'kb'], 'inputs dropped by select() release their notes');
});

test('hot-plug: disconnect emits release; reconnect re-attaches a fresh handler', async () => {
  const kb = fakePort('kb', 'Keystation 49');
  const access = fakeAccess([kb]);
  const m = new MidiInput({ nav: { requestMIDIAccess: () => Promise.resolve(access) }, ...quiet });
  const ev = capture(m);
  await m.init();
  const h1 = kb.onmidimessage;
  kb.connection = 'open';
  access.fire(kb); // connection churn only → ignored
  assert.equal(ev.filter((e) => e[0] === 'disconnected').length, 0);
  kb.state = 'disconnected';
  access.fire(kb);
  assert.deepEqual(ev.filter((e) => e[0] === 'disconnected').map((e) => e[1]), [{ inputId: 'kb', name: 'Keystation 49' }]);
  assert.equal(kb.onmidimessage, null);
  assert.equal(m.inputs[0].selected, false);
  kb.state = 'connected';
  access.fire(kb);
  assert.equal(typeof kb.onmidimessage, 'function');
  assert.notEqual(kb.onmidimessage, h1);
  assert.equal(m.inputs[0].selected, true);
  const devices = ev.filter((e) => e[0] === 'devices').at(-1)[1];
  assert.equal(devices.available, true);
  assert.deepEqual(devices.selected, ['kb']);
});
