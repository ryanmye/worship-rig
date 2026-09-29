// Menu-bar mode (docs/menubar-mode.md, contract v1; C7 menubar-A): shared/bus.js, controller.modes /
// setLowResource / setWindowVisible / publishState / handleCommand, and the store's menu-bar settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBus, stateError, commandError, isValidState, BUS_THROTTLE_MS, BUS_CHANNEL, COMMAND_TYPES,
} from '../../../app/js/shared/bus.js';
import { createController, MENU_BAR_MAX_MODES, MENU_BAR_FALLBACK_MODES } from '../../../app/js/controller.js';
import { DEFAULT_SETTINGS, DEVICE_LOCAL_SETTINGS, memoryStorage, STORAGE_KEY } from '../../../app/js/store.js';
import { MidiInput } from '../../../app/js/midi.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

// ---- fakes ------------------------------------------------------------------------------------------------------
/** In-process BroadcastChannel stand-in: every instance on a name gets every other instance's messages (async). */
function fakeBroadcast() {
  const hub = new Map();
  class FakeBC {
    constructor(name) {
      this.name = name;
      this.onmessage = null;
      this.closed = false;
      if (!hub.has(name)) hub.set(name, new Set());
      hub.get(name).add(this);
    }
    postMessage(data) {
      if (this.closed) throw new Error('closed');
      const copy = structuredClone(data);
      for (const other of hub.get(this.name)) {
        if (other !== this) queueMicrotask(() => !other.closed && other.onmessage && other.onmessage({ data: copy }));
      }
    }
    close() {
      this.closed = true;
      hub.get(this.name).delete(this);
    }
  }
  FakeBC.hub = hub;
  return FakeBC;
}

/** Manual clock + timeouts for the bus throttle. */
function clock() {
  let t = 0;
  let id = 0;
  const pending = new Map();
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => (pending.set(++id, { fn, at: t + ms }), id),
      clearTimeout: (i) => pending.delete(i),
    },
    advance(ms) {
      t += ms;
      for (const [i, p] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (p.at <= t) {
          pending.delete(i);
          p.fn();
        }
      }
    },
    pending,
  };
}

function withWarnSpy(fn) {
  const orig = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const r = fn(warns);
    return r && typeof r.then === 'function' ? r.finally(() => (console.warn = orig)).then(() => warns) : (console.warn = orig, warns);
  } catch (e) {
    console.warn = orig;
    throw e;
  }
}

function goodState(over = {}) {
  return {
    v: 1, current: { id: 'a', name: 'Sunday Pad + Piano', key: 'D' }, modes: [{ id: 'a', name: 'Sunday Pad + Piano', key: 'D', index: 0 }],
    master: 0.5, masterDb: -6, droneOn: true, droneKey: 'D', audio: 'running', latencyMs: 12,
    midi: { connected: true, name: 'Keystation 49es' }, lowResource: false, recording: false, windowVisible: true, memoryMB: 417,
    ...over,
  };
}

class FakeRecorder extends EventTarget {
  constructor() {
    super();
    this.isRecording = false;
    this.toggles = 0;
  }
  async toggle() {
    this.toggles++;
    this.isRecording = !this.isRecording;
    this.dispatchEvent(new CustomEvent('state', { detail: { state: this.isRecording ? 'recording' : 'idle' } }));
    return { ok: true };
  }
}

async function setup(opts = {}) {
  const store = opts.store || makeStore();
  if (opts.settings) for (const [k, v] of Object.entries(opts.settings)) store.set(`settings.${k}`, v);
  const engine = fakeEngine();
  engine.setLowResource = (on) => engine.calls.push(['setLowResource', on]);
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const doc = opts.doc || fakeDoc();
  const BC = opts.BC || fakeBroadcast();
  const clk = opts.clk || clock();
  const bus = opts.bus !== undefined ? opts.bus : createBus({ role: 'main', rig: null, BroadcastChannel: BC, timers: clk.timers, now: clk.now });
  const recorder = opts.recorder || null;
  const ctl = createController({ store, engine, midi, recorder, doc, nav: null, win: new EventTarget(), rig: null, timers: fakeTimers(), now: () => 0, bus });
  const events = [];
  for (const t of ['openMain', 'lowResource', 'bus-command']) ctl.addEventListener(t, (e) => events.push([t, e.detail]));
  await ctl.start();
  await tick();
  await tick();
  return { store, engine, ctl, doc, BC, clk, bus, events, recorder };
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

// ---- bus: validation ----------------------------------------------------------------------------------------------
test('bus: state validation follows contract v1 (required fields, v:1, nullable current/masterDb/memoryMB/midi.name)', () => {
  assert.equal(stateError(goodState()), null);
  assert.equal(stateError(goodState({ current: null, masterDb: null, memoryMB: null, midi: { connected: false, name: null } })), null);
  assert.equal(stateError(goodState({ v: 2 })), 'v must be 1');
  assert.equal(stateError(goodState({ audio: 'restarting' })), 'audio');
  assert.equal(stateError(goodState({ master: 2.5 })), 'master');
  assert.equal(stateError(goodState({ modes: [{ id: 'a', name: 'x', key: 'D' }] })), 'modes');
  for (const k of ['droneOn', 'lowResource', 'recording', 'windowVisible', 'latencyMs', 'droneKey', 'midi']) {
    const s = goodState();
    delete s[k];
    assert.notEqual(stateError(s), null, `missing ${k}`);
  }
});

test('bus: command validation covers every type and its payload', () => {
  assert.equal(COMMAND_TYPES.length, 12);
  for (const type of ['hello', 'nextMode', 'prevMode', 'panic', 'fadeOutAll', 'droneToggle', 'openMain']) assert.equal(commandError({ v: 1, type }), null, type);
  assert.equal(commandError({ v: 1, type: 'selectMode', id: 'factory:x' }), null);
  assert.notEqual(commandError({ v: 1, type: 'selectMode' }), null);
  assert.equal(commandError({ v: 1, type: 'master', value: 2 }), null);
  assert.notEqual(commandError({ v: 1, type: 'master', value: 2.01 }), null);
  assert.notEqual(commandError({ v: 1, type: 'master', value: NaN }), null);
  assert.equal(commandError({ v: 1, type: 'droneKey', pc: 11 }), null);
  assert.notEqual(commandError({ v: 1, type: 'droneKey', pc: 12 }), null);
  assert.notEqual(commandError({ v: 1, type: 'droneKey', pc: 1.5 }), null);
  assert.equal(commandError({ v: 1, type: 'lowResource', on: true }), null);
  assert.notEqual(commandError({ v: 1, type: 'lowResource', on: 1 }), null);
  assert.equal(commandError({ v: 1, type: 'record', on: false }), null);
  assert.notEqual(commandError({ v: 1, type: 'record' }), null);
  assert.notEqual(commandError({ v: 1, type: 'reboot' }), null);
  assert.notEqual(commandError({ type: 'panic' }), null, 'v required on the wire');
});

// ---- bus: throttle, hello, transports -----------------------------------------------------------------------------
test('bus: state publishes are throttled to ≤ 4/s with a trailing send of the newest state', async () => {
  const BC = fakeBroadcast();
  const clk = clock();
  const main = createBus({ role: 'main', rig: null, BroadcastChannel: BC, timers: clk.timers, now: clk.now });
  const mini = createBus({ role: 'mini', rig: null, BroadcastChannel: BC, hello: false });
  const got = [];
  mini.subscribe((s) => got.push(s.master));
  for (let i = 0; i < 10; i++) {
    main.publish(goodState({ master: i / 10 }));
    clk.advance(10);
  }
  assert.equal(main.sent, 1, 'leading edge only inside the window');
  clk.advance(BUS_THROTTLE_MS);
  assert.equal(main.sent, 2, 'one trailing send');
  await settle();
  assert.deepEqual(got, [0, 0.9], 'first and newest; nothing in between');
  // a burst over 2 s: never more than 4 sends per second
  const t0 = main.sent;
  for (let i = 0; i < 200; i++) {
    main.publish(goodState({ master: (i % 20) / 10 }));
    clk.advance(10);
  }
  clk.advance(1000);
  assert.ok(main.sent - t0 <= 9, `${main.sent - t0} sends in ~2 s (≤ 4/s + trailing)`);
  assert.equal(main.lastState.master, 1.9);
  main.close();
  mini.close();
  assert.equal(BC.hub.get(BUS_CHANNEL).size, 0, 'channels closed');
});

test('bus: hello gets the latest state at once (inside the throttle window); the first subscribe says hello', async () => {
  const BC = fakeBroadcast();
  const clk = clock();
  const main = createBus({ role: 'main', rig: null, BroadcastChannel: BC, timers: clk.timers, now: clk.now });
  const cmds = [];
  main.onCommand((c) => cmds.push(c.type));
  main.publish(goodState({ master: 0.1 }));
  main.publish(goodState({ master: 0.2 })); // pending (trailing)
  const mini = createBus({ role: 'mini', rig: null, BroadcastChannel: BC });
  const got = [];
  mini.subscribe((s) => got.push(s.master));
  await settle();
  assert.deepEqual(cmds, ['hello']);
  assert.deepEqual(got, [0.2], 'hello answered immediately with the newest state');
  assert.equal(clk.pending.size, 0, 'the pending trailing send was folded into the reply');
  main.close();
  mini.close();
});

test('bus: invalid messages are dropped with a console.warn (both directions)', async () => {
  const BC = fakeBroadcast();
  const main = createBus({ role: 'main', rig: null, BroadcastChannel: BC });
  const mini = createBus({ role: 'mini', rig: null, BroadcastChannel: BC, hello: false });
  const cmds = [];
  const states = [];
  main.onCommand((c) => cmds.push(c));
  mini.subscribe((s) => states.push(s));
  const raw = new BC(BUS_CHANNEL);
  const warns = await withWarnSpy(async () => {
    raw.postMessage({ v: 1, type: 'master', value: 7 });
    raw.postMessage({ v: 1, type: 'selfDestruct' });
    raw.postMessage({ v: 1, current: null }); // a broken state
    assert.equal(main.publish({ v: 1 }), false, 'main refuses to publish an invalid state');
    assert.equal(mini.command({ type: 'droneKey', pc: 99 }), false);
    await settle();
  });
  assert.equal(cmds.length, 0);
  assert.equal(states.length, 0);
  assert.ok(warns.length >= 5, warns.join('\n'));
  assert.ok(warns.some((w) => /master\.value/.test(w)) && warns.some((w) => /unknown type/.test(w)));
  raw.close();
  main.close();
  mini.close();
});

test('bus: Electron transport (rig preload methods, JSON strings), detected per method', async () => {
  const relay = { toMain: null, toMini: new Set(), published: [], commanded: [] };
  const rigMain = {
    busPublish: (json) => {
      relay.published.push(json);
      for (const cb of relay.toMini) cb(json);
    },
    onBusCommand: (cb) => {
      relay.toMain = cb;
      return () => (relay.toMain = null);
    },
  };
  const rigMini = {
    miniSubscribe: (cb) => (relay.toMini.add(cb), () => relay.toMini.delete(cb)),
    miniCommand: (json) => {
      relay.commanded.push(json);
      relay.toMain && relay.toMain(json);
    },
  };
  const main = createBus({ role: 'main', rig: rigMain, BroadcastChannel: null });
  const mini = createBus({ role: 'mini', rig: rigMini, BroadcastChannel: null });
  assert.deepEqual(main.transport, { publish: 'rig', commands: 'rig', subscribe: 'none', command: 'none' });
  assert.deepEqual(mini.transport, { publish: 'none', commands: 'none', subscribe: 'rig', command: 'rig' });
  const cmds = [];
  main.onCommand((c) => cmds.push(c));
  main.publish(goodState());
  const got = [];
  mini.subscribe((s) => got.push(s));
  mini.command({ type: 'selectMode', id: 'a' });
  assert.equal(typeof relay.published[0], 'string', 'busPublish(json)');
  assert.equal(typeof relay.commanded[0], 'string', 'miniCommand(json)');
  assert.deepEqual(cmds.map((c) => c.type), ['hello', 'selectMode']);
  assert.equal(got.length, 1, 'hello answered over the relay');
  assert.ok(isValidState(got[0]));
  main.close();
  mini.close();
  assert.equal(relay.toMain, null, 'close() unsubscribes from the relay');
  assert.equal(relay.toMini.size, 0);
  // only busPublish in the preload: commands still arrive over BroadcastChannel
  const BC = fakeBroadcast();
  const half = createBus({ role: 'main', rig: { busPublish: () => {} }, BroadcastChannel: BC });
  assert.deepEqual(half.transport, { publish: 'rig', commands: 'broadcast', subscribe: 'none', command: 'none' });
  half.close();
});

test('bus: real BroadcastChannel (Node) round trip main ↔ mini', async (t) => {
  if (typeof globalThis.BroadcastChannel !== 'function') return t.skip('no BroadcastChannel');
  const main = createBus({ role: 'main', rig: null });
  const mini = createBus({ role: 'mini', rig: null });
  assert.equal(main.transport.publish, 'broadcast');
  main.publish(goodState({ master: 1.25 }));
  const got = new Promise((res) => mini.subscribe(res));
  const cmd = new Promise((res) => main.onCommand((c) => c.type === 'panic' && res(c)));
  const s = await got; // via hello
  assert.equal(s.master, 1.25);
  mini.command({ type: 'panic' });
  assert.deepEqual(await cmd, { v: 1, type: 'panic' });
  main.close();
  mini.close();
});

// ---- store --------------------------------------------------------------------------------------------------------
test('store: menu-bar settings — defaults, validation, dangling set id, device-local', () => {
  assert.equal(DEFAULT_SETTINGS.menuBarSetlistId, null);
  assert.equal(DEFAULT_SETTINGS.lowResource, false);
  assert.equal(DEFAULT_SETTINGS.menuBarMode, false);
  assert.ok(DEVICE_LOCAL_SETTINGS.includes('menuBarMode') && DEVICE_LOCAL_SETTINGS.includes('lowResource'));
  const store = makeStore();
  const s = store.get().settings;
  assert.equal(s.menuBarSetlistId, null);
  assert.equal(s.lowResource, false);
  assert.equal(s.menuBarMode, false);
  assert.equal(store.set('settings.lowResource', 'yes'), false);
  assert.equal(store.set('settings.menuBarMode', 1), false);
  assert.equal(store.set('settings.menuBarSetlistId', 'nope'), false, 'unknown setlist refused');
  const id = store.addSetlist('Menu', store.get().songOrder.slice(0, 2));
  assert.ok(store.set('settings.menuBarSetlistId', id));
  assert.ok(store.set('settings.lowResource', true));
  assert.ok(store.set('settings.menuBarMode', true));
  store.flush();
  assert.equal(store.get().settings.menuBarSetlistId, id);
  store.deleteSetlist(id);
  assert.equal(store.get().settings.menuBarSetlistId, null, 'deleting the menu-bar set falls back');
  // a saved library whose menu-bar set is gone (hand-edited / partial import) loads with the fallback
  const storage = memoryStorage();
  const a = makeStore({ storage });
  const sid = a.addSetlist('Gone soon', a.get().songOrder.slice(0, 1));
  a.set('settings.menuBarSetlistId', sid);
  a.persistNow();
  const raw = JSON.parse(storage.getItem(STORAGE_KEY));
  delete raw.setlists[sid];
  raw.setlistOrder = raw.setlistOrder.filter((x) => x !== sid);
  storage.setItem(STORAGE_KEY, JSON.stringify(raw));
  assert.equal(makeStore({ storage }).get().settings.menuBarSetlistId, null);
});

// ---- controller: modes --------------------------------------------------------------------------------------------
test('controller.modes: fallback = first 3 of the current setlist; a chosen setlist gives ≤ 6 (no repeats)', async () => {
  const { store, ctl } = await setup();
  const nav = store.navIds();
  assert.equal(MENU_BAR_FALLBACK_MODES, 3);
  assert.deepEqual(ctl.modes.list().map((m) => m.id), nav.slice(0, 3));
  const m0 = ctl.modes.list()[0];
  const s0 = store.getSong(nav[0]);
  assert.deepEqual(Object.keys(m0).sort(), ['id', 'index', 'key', 'name']);
  assert.equal(m0.name, s0.name);
  assert.equal(m0.index, 0);
  assert.equal(typeof m0.key, 'string');
  assert.ok(m0.key.length >= 1);
  const order = store.get().songOrder;
  const id = store.addSetlist('Menu bar', [order[5], order[6], order[5], ...order.slice(7, 14)]);
  store.set('settings.menuBarSetlistId', id);
  const list = ctl.modes.list();
  assert.equal(list.length, MENU_BAR_MAX_MODES);
  assert.deepEqual(list.map((m) => m.id), [order[5], order[6], ...order.slice(7, 11)], 'repeat dropped, capped at 6');
  assert.deepEqual(list.map((m) => m.index), [0, 1, 2, 3, 4, 5]);
  store.set(`setlists.${id}.songIds`, []);
  assert.deepEqual(ctl.modes.list().map((m) => m.id), nav.slice(0, 3), 'an empty menu-bar set falls back');
  ctl.dispose();
});

test('controller.modes: select / next / prev wrap; from a song outside the set next → first, prev → last', async () => {
  const { store, ctl } = await setup();
  const order = store.get().songOrder;
  const set = [order[2], order[4], order[6]];
  const id = store.addSetlist('Menu', set);
  store.set('settings.menuBarSetlistId', id);
  await settle();
  assert.equal(ctl.modes.current(), null, 'current song is not a mode');
  assert.equal(await ctl.modes.next(), true);
  assert.equal(store.get().settings.currentSongId, set[0]);
  assert.equal(ctl.modes.current().index, 0);
  await ctl.modes.next();
  await ctl.modes.next();
  assert.equal(store.get().settings.currentSongId, set[2]);
  await ctl.modes.next();
  assert.equal(store.get().settings.currentSongId, set[0], 'next wraps');
  await ctl.modes.prev();
  assert.equal(store.get().settings.currentSongId, set[2], 'prev wraps');
  assert.equal(await ctl.modes.select(set[1]), true);
  assert.equal(ctl.modes.current().id, set[1]);
  assert.equal(await ctl.modes.select(set[1]), false, 'already on it: no re-prepare');
  assert.equal(await ctl.modes.select('nope'), false);
  await ctl.selectSong(order[0]);
  await ctl.modes.prev();
  assert.equal(store.get().settings.currentSongId, set[2], 'outside the set: prev → last');
  ctl.dispose();
});

// ---- controller: commands -----------------------------------------------------------------------------------------
test('controller: every contract command is handled', async () => {
  const recorder = new FakeRecorder();
  const { store, engine, ctl, events } = await setup({ recorder });
  const nav = store.navIds();
  const cur = () => store.currentSong();
  assert.equal(ctl.handleCommand({ v: 1, type: 'selectMode', id: nav[1] }), true);
  await settle();
  assert.equal(cur().id, nav[1]);
  ctl.handleCommand({ v: 1, type: 'nextMode' });
  await settle();
  assert.equal(cur().id, nav[2]);
  ctl.handleCommand({ v: 1, type: 'prevMode' });
  await settle();
  assert.equal(cur().id, nav[1]);
  engine.clear();
  ctl.handleCommand({ v: 1, type: 'panic' });
  assert.ok(engine.names().includes('allNotesOff'));
  ctl.handleCommand({ v: 1, type: 'fadeOutAll' });
  assert.ok(engine.names().includes('fadeOutAll'));
  ctl.handleCommand({ v: 1, type: 'master', value: 1.5 });
  assert.equal(cur().patch.fx.master.volume, 1.5);
  // drone toggle: off, then back to the mode it had
  store.set(`songs.${cur().id}.drone.mode`, 'files');
  ctl.handleCommand({ v: 1, type: 'droneToggle' });
  assert.equal(cur().drone.mode, 'off');
  ctl.handleCommand({ v: 1, type: 'droneToggle' });
  assert.equal(cur().drone.mode, 'files');
  // drone key = the key the band hears; the transpose amount is kept
  store.set(`songs.${cur().id}.playIn`, 0);
  store.set(`songs.${cur().id}.hearIn`, 2); // +2
  ctl.handleCommand({ v: 1, type: 'droneKey', pc: 7 });
  assert.equal(cur().hearIn, 7);
  assert.equal(cur().playIn, 5);
  engine.clear();
  ctl.handleCommand({ v: 1, type: 'lowResource', on: true });
  assert.equal(store.get().settings.lowResource, true);
  assert.deepEqual(engine.of('setLowResource').at(-1), ['setLowResource', true]);
  ctl.handleCommand({ v: 1, type: 'lowResource', on: false });
  assert.deepEqual(engine.of('setLowResource').at(-1), ['setLowResource', false]);
  ctl.handleCommand({ v: 1, type: 'record', on: true });
  await settle();
  assert.equal(recorder.isRecording, true);
  assert.equal(ctl.status.recording, true);
  ctl.handleCommand({ v: 1, type: 'record', on: true });
  await settle();
  assert.equal(recorder.toggles, 1, 'record on while recording: nothing');
  ctl.handleCommand({ v: 1, type: 'record', on: false });
  await settle();
  assert.equal(recorder.isRecording, false);
  ctl.handleCommand({ v: 1, type: 'openMain' });
  assert.ok(events.some(([t]) => t === 'openMain'));
  const warns = withWarnSpy(() => {
    assert.equal(ctl.handleCommand({ v: 1, type: 'master', value: 9 }), false);
    assert.equal(ctl.handleCommand({ type: 'panic' }), false);
  });
  assert.equal(warns.length, 2);
  assert.equal(cur().patch.fx.master.volume, 1.5, 'invalid master ignored');
  const handled = events.filter(([t]) => t === 'bus-command').map(([, c]) => c.type);
  for (const t of ['selectMode', 'nextMode', 'prevMode', 'panic', 'fadeOutAll', 'master', 'droneToggle', 'droneKey', 'lowResource', 'record', 'openMain']) {
    assert.ok(handled.includes(t), t);
  }
  ctl.dispose();
});

test('controller: commands arrive over the bus from a mini endpoint (BroadcastChannel transport)', async () => {
  const BC = fakeBroadcast();
  const { store, ctl, bus } = await setup({ BC });
  const mini = createBus({ role: 'mini', rig: null, BroadcastChannel: BC });
  const states = [];
  mini.subscribe((s) => states.push(s));
  await settle();
  assert.ok(states.length >= 1, 'hello → state');
  assert.equal(states.at(-1).current.id, store.currentSong().id);
  mini.command({ type: 'master', value: 0.25 });
  await settle();
  assert.equal(store.currentSong().patch.fx.master.volume, 0.25);
  mini.close();
  ctl.dispose();
  assert.equal(BC.hub.get(BUS_CHANNEL).size, 1, 'a passed-in bus is left to its owner');
  bus.close();
  assert.equal(BC.hub.get(BUS_CHANNEL).size, 0);
});

// ---- controller: state + publishing -------------------------------------------------------------------------------
test('controller: menuBarState() is a valid contract state and follows song / master / drone / recording', async () => {
  const { store, ctl } = await setup();
  const s = ctl.menuBarState();
  assert.equal(stateError(s), null, JSON.stringify(s));
  const song = store.currentSong();
  assert.equal(s.current.id, song.id);
  assert.equal(s.current.name, song.name);
  assert.equal(s.droneKey, s.current.key);
  assert.equal(s.modes.length, 3);
  assert.equal(s.lowResource, false);
  assert.equal(s.windowVisible, true);
  assert.equal(s.latencyMs, 12);
  store.set(`songs.${song.id}.patch.fx.master.volume`, 1);
  assert.equal(ctl.menuBarState().masterDb, 0);
  store.set(`songs.${song.id}.patch.fx.master.volume`, 0);
  assert.equal(ctl.menuBarState().masterDb, null, '−∞ dB → null (JSON-safe)');
  store.set(`songs.${song.id}.drone.mode`, 'off');
  assert.equal(ctl.menuBarState().droneOn, false);
  ctl.dispose();
});

test('controller: publishes on every relevant change, throttled by the bus (≤ 4/s), newest state last', async () => {
  const BC = fakeBroadcast();
  const clk = clock();
  const { store, ctl, bus } = await setup({ BC, clk });
  const mini = createBus({ role: 'mini', rig: null, BroadcastChannel: BC, hello: false });
  const got = [];
  mini.subscribe((s) => got.push(s));
  clk.advance(1000);
  const sent0 = bus.sent;
  const id = store.currentSong().id;
  for (let i = 0; i <= 40; i++) {
    store.set(`songs.${id}.patch.fx.master.volume`, i / 20); // a fader drag: 41 changes in 1 s
    await tick();
    clk.advance(25);
  }
  clk.advance(BUS_THROTTLE_MS);
  await settle();
  const sends = bus.sent - sent0;
  assert.ok(sends >= 2 && sends <= 6, `${sends} sends for 41 changes over ~1.3 s`);
  assert.equal(got.at(-1).master, 2, 'the trailing send carries the newest value');
  // an unchanged state is not re-sent
  const before = bus.sent;
  ctl.publishState();
  clk.advance(1000);
  assert.equal(bus.sent, before);
  // song change → published
  await ctl.nextSong();
  await settle();
  clk.advance(1000);
  await settle();
  assert.equal(got.at(-1).current.id, store.currentSong().id);
  mini.close();
  ctl.dispose();
});

test('controller: hello → an immediate state even before anything changed', async () => {
  const BC = fakeBroadcast();
  const clk = clock();
  const { ctl, bus } = await setup({ BC, clk });
  assert.ok(bus.lastState, 'first state published at start');
  const mini = createBus({ role: 'mini', rig: null, BroadcastChannel: BC });
  let got = null;
  mini.subscribe((s) => (got = s));
  await settle();
  assert.ok(got && isValidState(got));
  assert.equal(clk.pending.size, 0, 'no waiting on the throttle');
  // a controller without a bus answers hello through publishState's return value (no throw)
  assert.equal(ctl.handleCommand({ v: 1, type: 'hello' }), true);
  mini.close();
  ctl.dispose();
});

// ---- controller: low resource -------------------------------------------------------------------------------------
test('controller: setLowResource → engine.setLowResource, pins the current song only, memory.mode current-only', async () => {
  const { store, engine, ctl, events } = await setup();
  engine.clear();
  assert.equal(ctl.setLowResource(true), true);
  await settle();
  assert.equal(store.get().settings.lowResource, true, 'persisted');
  assert.deepEqual(engine.of('setLowResource'), [['setLowResource', true]]);
  const pre = engine.of('preload');
  assert.ok(pre.length >= 1);
  const cur = store.currentSong();
  assert.ok(pre.every((c) => c[1].length === 1 && c[1][0] === cur.patch && c[2].pin === 'replace'), 'current only, replace');
  assert.equal(ctl.status.memory.mode, 'current-only');
  assert.equal(ctl.status.lowResource, true);
  assert.equal(ctl.menuBarState().lowResource, true);
  assert.ok(events.some(([t, d]) => t === 'lowResource' && d.on === true));
  // switching songs: still the current song only (no neighbour 'add')
  engine.clear();
  await ctl.nextSong();
  await settle();
  const pre2 = engine.of('preload');
  assert.ok(pre2.length >= 1 && pre2.every((c) => c[1].length === 1 && c[2].pin === 'replace' && c[1][0] === store.currentSong().patch));
  // off: the setlist preload comes back
  engine.clear();
  assert.equal(ctl.setLowResource(false), false);
  await settle();
  assert.deepEqual(engine.of('setLowResource'), [['setLowResource', false]]);
  assert.ok(engine.of('preload').some((c) => c[1].length > 1), 'nav list preloaded again');
  assert.notEqual(ctl.status.memory.mode, 'current-only');
  assert.equal(ctl.status.lowResource, false);
  ctl.dispose();
});

test('controller: a persisted settings.lowResource applies before the first preload', async () => {
  const store = makeStore();
  store.set('settings.lowResource', true);
  const { engine, ctl } = await setup({ store });
  await settle();
  const names = engine.names();
  assert.ok(names.indexOf('setLowResource') >= 0 && names.indexOf('setLowResource') < names.indexOf('prepare'));
  assert.ok(engine.of('preload').every((c) => c[1].length === 1), 'never more than the current song');
  assert.equal(ctl.status.memory.mode, 'current-only');
  ctl.dispose();
});

test('controller: auto low-resource while hidden in menu-bar mode; setWindowVisible overrides', async () => {
  const doc = fakeDoc();
  const { store, engine, ctl } = await setup({ doc });
  const hide = (h) => {
    doc.visibilityState = h ? 'hidden' : 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
  };
  hide(true);
  assert.equal(ctl.status.lowResource, false, 'not in menu-bar mode: a hidden tab stays normal');
  assert.equal(ctl.status.windowVisible, false);
  store.set('settings.menuBarMode', true);
  await settle();
  assert.equal(ctl.status.lowResource, true, 'menu-bar mode + hidden → low-resource');
  assert.equal(ctl.menuBarState().windowVisible, false);
  assert.equal(store.get().settings.lowResource, false, 'auto: the setting is untouched');
  ctl.setWindowVisible(true); // e.g. the popover opened
  assert.equal(ctl.status.lowResource, false);
  ctl.setWindowVisible(null); // back to document visibility (hidden)
  assert.equal(ctl.status.lowResource, true);
  hide(false);
  assert.equal(ctl.status.lowResource, false);
  ctl.setWindowVisible(false);
  assert.equal(ctl.status.lowResource, true, 'main process says hidden');
  store.set('settings.menuBarMode', false);
  await settle();
  assert.equal(ctl.status.lowResource, false);
  const flips = engine.of('setLowResource').map((c) => c[1]);
  assert.deepEqual(flips, [true, false, true, false, true, false]);
  ctl.dispose();
});

test('controller: no bus without a real document (tests / headless) — nothing published, no BroadcastChannel', async () => {
  const store = makeStore();
  const engine = fakeEngine();
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const c2 = createController({ store, engine, midi, doc: fakeDoc(), nav: null, win: new EventTarget(), rig: null, timers: fakeTimers(), now: () => 0 });
  await c2.start();
  assert.equal(c2.bus, null);
  assert.ok(isValidState(c2.publishState()), 'publishState still returns the state');
  c2.dispose();
});
