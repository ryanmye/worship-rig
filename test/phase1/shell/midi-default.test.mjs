// midi-default: hardware keyboards beat virtual/DAW ports; explicit choice remembered by id + name; hot-swap toast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MidiInput, classifyInput, NO_KEYBOARD_HINT } from '../../../app/js/midi.js';
import { createController } from '../../../app/js/controller.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

const quiet = { warn: () => {} };

function port(id, name, manufacturer = '') {
  return { id, name, manufacturer, type: 'input', state: 'connected', connection: 'closed', onmidimessage: null };
}
function fakeAccess(ports) {
  const a = new EventTarget();
  a.inputs = new Map(ports.map((p) => [p.id, p]));
  a.plug = (p) => {
    a.inputs.set(p.id, p);
    p.state = 'connected';
    a.fire(p);
  };
  a.unplug = (p) => {
    p.state = 'disconnected';
    a.fire(p);
  };
  a.fire = (p) => {
    const e = new Event('statechange');
    e.port = p;
    a.dispatchEvent(e);
  };
  return a;
}
const navFor = (access) => ({ requestMIDIAccess: () => Promise.resolve(access) });
const selectedIds = (m) => m.inputs.filter((i) => i.selected).map((i) => i.id).sort();
function capture(m, types = ['devices', 'switched', 'rebind', 'disconnected', 'noteon']) {
  const ev = [];
  for (const t of types) m.addEventListener(t, (e) => ev.push([t, e.detail]));
  return ev;
}
const last = (ev, t) => ev.filter((e) => e[0] === t).at(-1)?.[1];

async function withController(store, access) {
  const engine = fakeEngine();
  const midi = new MidiInput({ nav: navFor(access), ...quiet });
  const ctl = createController({ store, engine, midi, recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(), rig: null, timers: fakeTimers(), now: () => 0 });
  const warns = [];
  ctl.addEventListener('warn', (e) => warns.push(e.detail.message));
  await ctl.start();
  await tick();
  return { engine, midi, ctl, warns };
}

test('classify: DAW / IAC / network ports are virtual; controller vendors rank above generic hardware', () => {
  const v = (name, manufacturer) => classifyInput({ name, manufacturer });
  for (const [n, m] of [
    ['GarageBand Virtual Out', 'Apple Inc.'], ['GarageBand Virtual Out', ''], ['IAC Driver Bus 1', 'Apple Inc.'],
    ['Logic Pro Virtual Out', ''], ['MainStage Virtual Out', ''], ['Network Session 1', ''], ['Session 1', 'Apple Inc.'],
    ['Bluetooth MIDI Connect', ''], ['loopMIDI Port', 'Tobias Erichsen'], ['Midi Through Port-0', 'Midi Through'],
    ['Some Port', 'Apple Inc.'],
  ]) assert.equal(v(n, m).kind, 'virtual', n);
  assert.deepEqual(v('Arturia KeyLab 61', ''), { kind: 'hardware', rank: 3 });
  assert.deepEqual(v('Digital Piano', 'Roland'), { kind: 'hardware', rank: 4 }, 'vendor via manufacturer + "Piano"');
  assert.deepEqual(v('USB MIDI Interface', ''), { kind: 'hardware', rank: 2 });
  assert.deepEqual(v('nanoPAD2', 'Test'), { kind: 'hardware', rank: 1 });
  for (const n of ['MPK mini 3', 'Launchkey 49 MK3', 'Keystation 88 MK3', 'Impact GX61', 'Oxygen Pro 49', 'MiniLab3', 'Komplete Kontrol A49', 'M-Audio Hammer 88']) {
    assert.ok(v(n, '').rank >= 3, n);
  }
  const m = new MidiInput({ nav: null, ...quiet });
  assert.deepEqual(m.classify({ name: 'GarageBand Virtual Out' }), { kind: 'virtual', rank: 0 });
});

test('GarageBand Virtual Out + Arturia KeyLab 61 → the KeyLab is chosen; devices payload carries kind + rank', async () => {
  const gb = port('gb', 'GarageBand Virtual Out', 'Apple Inc.');
  const kl = port('kl', 'Arturia KeyLab 61', 'Arturia');
  const m = new MidiInput({ nav: navFor(fakeAccess([gb, kl])), ...quiet });
  const ev = capture(m);
  assert.equal(await m.init(), true);
  assert.deepEqual(selectedIds(m), ['kl']);
  assert.equal(gb.onmidimessage, null, 'the GarageBand port is not listened to');
  kl.onmidimessage({ data: new Uint8Array([0x90, 60, 100]), timeStamp: 1 });
  assert.equal(last(ev, 'noteon').inputId, 'kl');
  const d = last(ev, 'devices');
  assert.deepEqual(d.inputs.map(({ id, name, manufacturer, kind, rank }) => ({ id, name, manufacturer, kind, rank })), [
    { id: 'gb', name: 'GarageBand Virtual Out', manufacturer: 'Apple Inc.', kind: 'virtual', rank: 0 },
    { id: 'kl', name: 'Arturia KeyLab 61', manufacturer: 'Arturia', kind: 'hardware', rank: 3 },
  ]);
  assert.equal(d.inputs[0].virtual, true, 'Settings tags it "(virtual)"');
  assert.deepEqual([d.mode, d.activeId, d.activeName, d.fallback, d.hint], ['first', 'kl', 'Arturia KeyLab 61', false, null]);
  assert.equal(ev.filter((e) => e[0] === 'switched').length, 0, 'the initial pick is not announced');
});

test('best rank wins over enumeration order; ties keep enumeration order', async () => {
  const usb = port('usb', 'USB MIDI Interface');
  const piano = port('p', 'Digital Piano', 'Roland');
  const m = new MidiInput({ nav: navFor(fakeAccess([usb, piano])), ...quiet });
  await m.init();
  assert.deepEqual(selectedIds(m), ['p']);
  const a = port('a', 'Keystation 49');
  const b = port('b', 'Launchkey 49');
  const m2 = new MidiInput({ nav: navFor(fakeAccess([a, b])), ...quiet });
  await m2.init();
  assert.deepEqual(selectedIds(m2), ['a']);
});

test('only virtual ports → listen to all of them with the status hint; a keyboard plugged later takes over', async () => {
  const gb = port('gb', 'GarageBand Virtual Out', 'Apple Inc.');
  const iac = port('iac', 'IAC Driver Bus 1', 'Apple Inc.');
  const access = fakeAccess([gb, iac]);
  const m = new MidiInput({ nav: navFor(access), ...quiet });
  const ev = capture(m);
  await m.init();
  assert.deepEqual(selectedIds(m), ['gb', 'iac'], 'never one virtual port silently');
  let d = last(ev, 'devices');
  assert.deepEqual([d.fallback, d.hint, d.activeId], [true, NO_KEYBOARD_HINT, null]);
  assert.equal(NO_KEYBOARD_HINT, 'No keyboard found — listening to all MIDI ports');
  assert.equal(m.selection, 'first', 'the automatic setting is unchanged');

  const kl = port('kl', 'Arturia KeyLab 61');
  access.plug(kl);
  assert.deepEqual(selectedIds(m), ['kl']);
  d = last(ev, 'devices');
  assert.deepEqual([d.fallback, d.hint, d.activeId], [false, null, 'kl']);
  assert.deepEqual(last(ev, 'switched'), { inputId: 'kl', name: 'Arturia KeyLab 61', previousId: null, previousName: null, standIn: false });
  assert.deepEqual(ev.filter((e) => e[0] === 'disconnected').map((e) => e[1].inputId).sort(), ['gb', 'iac'], 'virtual notes released');

  // explicitly choosing 'all' is not a fallback: no hint
  m.select('all');
  assert.equal(last(ev, 'devices').hint, null);
  // no ports at all: nothing to listen to, no hint (main.js shows its own "no keyboard" toast)
  const m3 = new MidiInput({ nav: navFor(fakeAccess([])), ...quiet });
  const ev3 = capture(m3);
  await m3.init();
  assert.deepEqual([last(ev3, 'devices').fallback, last(ev3, 'devices').hint], [true, null]);
});

test('explicit choice by id AND name: a re-plugged device with a new id is found by name (MidiInput)', async () => {
  const piano = port('p', 'Digital Piano', 'Roland'); // ranks higher than the KeyLab
  const kl2 = port('kl-new', 'Arturia KeyLab 61');
  const m = new MidiInput({ nav: navFor(fakeAccess([piano, kl2])), ...quiet });
  const ev = capture(m);
  await m.init();
  m.select('kl-old', 'Arturia KeyLab 61');
  assert.deepEqual(selectedIds(m), ['kl-new']);
  assert.deepEqual(last(ev, 'rebind'), { inputId: 'kl-new', previousId: 'kl-old', name: 'Arturia KeyLab 61' });
  assert.equal(m.selection, 'kl-new');
  assert.equal(last(ev, 'devices').mode, 'device');
});

test('controller: explicit choice persists by name across an id change (store + restart)', async () => {
  const store = makeStore();
  const piano = port('p', 'Digital Piano', 'Roland');
  const kl = port('kl-1', 'Arturia KeyLab 61');
  const access = fakeAccess([piano, kl]);
  const { midi, ctl, warns } = await withController(store, access);
  assert.deepEqual(selectedIds(midi), ['p'], 'automatic: best rank');
  store.set('settings.midiInputId', 'kl-1'); // what the Settings view writes
  await tick();
  assert.deepEqual(selectedIds(midi), ['kl-1']);
  assert.equal(store.get().settings.midiInputName, 'Arturia KeyLab 61', 'the name is remembered alongside the id');

  // unplug + replug under a new id (another USB port / OS re-enumeration)
  access.unplug(kl);
  access.inputs.delete('kl-1');
  const kl2 = port('kl-2', 'Arturia KeyLab 61');
  access.plug(kl2);
  await tick();
  await tick();
  assert.deepEqual(selectedIds(midi), ['kl-2']);
  assert.equal(store.get().settings.midiInputId, 'kl-2', 'the new id is persisted');
  assert.equal(store.get().settings.midiInputName, 'Arturia KeyLab 61');
  assert.deepEqual(warns.filter((w) => w.startsWith('Now using')), ['Now using Digital Piano', 'Now using Arturia KeyLab 61'], 'stand-in while unplugged, then back');
  ctl.dispose?.();

  // restart: saved id is stale, name still matches → not the higher-ranked piano
  const store2 = makeStore();
  store2.set('settings.midiInputId', 'kl-2');
  store2.set('settings.midiInputName', 'Arturia KeyLab 61');
  await tick();
  const kl3 = port('kl-3', 'Arturia KeyLab 61');
  const r = await withController(store2, fakeAccess([port('p', 'Digital Piano', 'Roland'), kl3]));
  assert.deepEqual(selectedIds(r.midi), ['kl-3']);
  assert.equal(store2.get().settings.midiInputId, 'kl-3');
  assert.equal(r.warns.filter((w) => w.startsWith('Now using')).length, 0, 'no toast for the startup pick');

  // back to automatic clears the remembered name
  store2.set('settings.midiInputId', 'first');
  await tick();
  await tick();
  assert.equal(store2.get().settings.midiInputName, null);
  assert.deepEqual(selectedIds(r.midi), ['p']);
  r.ctl.dispose?.();
});

test('controller: hot-swap — chosen keyboard gone, another hardware keyboard stands in with a warn toast', async () => {
  const store = makeStore();
  const gb = port('gb', 'GarageBand Virtual Out', 'Apple Inc.');
  const kl = port('kl', 'Arturia KeyLab 61');
  const access = fakeAccess([gb, kl]);
  const { midi, engine, ctl, warns } = await withController(store, access);
  store.set('settings.midiInputId', 'kl');
  await tick();
  access.unplug(kl);
  await tick();
  // nothing but GarageBand left → all ports + hint (warned once)
  assert.deepEqual(selectedIds(midi), ['gb']);
  assert.equal(ctl.status.midi.hint, NO_KEYBOARD_HINT);
  assert.equal(warns.filter((w) => w === NO_KEYBOARD_HINT).length, 1);
  const ks = port('ks', 'Keystation 49');
  access.plug(ks);
  await tick();
  assert.deepEqual(selectedIds(midi), ['ks']);
  assert.equal(warns.at(-1), 'Now using Keystation 49');
  assert.equal(ctl.status.midi.hint, null);
  assert.equal(ctl.status.midi.standIn, true);
  assert.equal(ctl.status.midi.name, 'Keystation 49');
  assert.equal(store.get().settings.midiInputId, 'kl', 'the stand-in does not overwrite the choice');
  // notes from the stand-in play
  engine.clear();
  ks.onmidimessage({ data: new Uint8Array([0x90, 64, 90]), timeStamp: 2 });
  assert.ok(engine.names().includes('noteOn'));
  // the chosen keyboard returns → back to it, announced
  access.plug(kl);
  await tick();
  assert.deepEqual(selectedIds(midi), ['kl']);
  assert.equal(warns.at(-1), 'Now using Arturia KeyLab 61');
  assert.equal(ctl.status.midi.standIn, false);
  ctl.dispose?.();
});

test("automatic ('first'): the sticky keyboard disappears → the other hardware keyboard, announced", async () => {
  const store = makeStore();
  const a = port('a', 'Keystation 49');
  const b = port('b', 'Launchkey 49');
  const access = fakeAccess([a]);
  const { midi, ctl, warns } = await withController(store, access);
  access.plug(b);
  await tick();
  assert.deepEqual(selectedIds(midi), ['a'], 'L8: a new keyboard does not steal the selection');
  assert.equal(warns.filter((w) => w.startsWith('Now using')).length, 0);
  access.unplug(a);
  await tick();
  assert.deepEqual(selectedIds(midi), ['b']);
  assert.equal(warns.at(-1), 'Now using Launchkey 49');
  ctl.dispose?.();
});
