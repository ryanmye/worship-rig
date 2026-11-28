// Remote lane (D45, native/docs/lanes/REMOTE.md): bus contract v1's optional `scene.name` / `locked` state fields and
// the optional command `via: 'remote'`; the controller publishes both fields and refuses a remote's commands under
// Perform Lock (all but panic) and any remote command outside D34's list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBus, stateError, commandError, SCENE_NAME_MAX as BUS_SCENE_NAME_MAX } from '../../../app/js/shared/bus.js';
import { SCENE_NAME_MAX } from '../../../app/js/shared/scenes.js';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

const base = () => ({
  v: 1, current: { id: 'a', name: 'A', key: 'D' }, modes: [], master: 1, masterDb: 0, droneOn: false, droneKey: 'D',
  audio: 'running', latencyMs: 5, midi: { connected: false, name: null }, lowResource: false, recording: false,
  windowVisible: true, memoryMB: null,
});

async function setup() {
  const store = makeStore();
  const engine = fakeEngine();
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const ctl = createController({ store, engine, midi, recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(),
    rig: null, timers: fakeTimers(), now: () => 0 });
  const refused = [];
  ctl.addEventListener('bus-refused', (e) => refused.push(e.detail));
  await ctl.start();
  await tick();
  return { store, engine, ctl, refused };
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

test('bus: scene.name and locked are optional; checked when present', () => {
  assert.equal(BUS_SCENE_NAME_MAX, SCENE_NAME_MAX, 'bus.js repeats scenes.js SCENE_NAME_MAX');
  assert.equal(stateError(base()), null);
  assert.equal(stateError({ ...base(), locked: true }), null);
  assert.equal(stateError({ ...base(), locked: false }), null);
  assert.equal(stateError({ ...base(), locked: 1 }), 'locked');
  assert.equal(stateError({ ...base(), locked: null }), 'locked');
  const sc = (extra) => ({ ...base(), scene: { n: 0, count: 2, ...extra } });
  assert.equal(stateError(sc({})), null);
  assert.equal(stateError(sc({ name: 'Bridge' })), null);
  assert.equal(stateError(sc({ name: '' })), null, 'an empty name is a string (the controller never sends one)');
  assert.equal(stateError(sc({ name: 'x'.repeat(40) })), null);
  assert.equal(stateError(sc({ name: '😀'.repeat(40) })), null, '40 code points (80 UTF-16 units)');
  assert.equal(stateError(sc({ name: 'x'.repeat(41) })), 'scene.name');
  assert.equal(stateError(sc({ name: 3 })), 'scene.name');
  assert.equal(stateError(sc({ name: null })), 'scene.name');
  assert.equal(stateError({ ...base(), scene: { n: 5, count: 2, name: 'x' } }), 'scene', 'scene checks come first');
});

test('bus: command via is optional and only "remote"', () => {
  assert.equal(commandError({ v: 1, type: 'panic' }), null);
  assert.equal(commandError({ v: 1, type: 'panic', via: 'remote' }), null);
  assert.equal(commandError({ v: 1, type: 'nextSong', via: 'remote' }), null);
  assert.equal(commandError({ v: 1, type: 'panic', via: 'tray' }), 'via');
  assert.equal(commandError({ v: 1, type: 'panic', via: null }), 'via');
  assert.equal(commandError({ v: 1, type: 'nope', via: 'x' }), 'unknown type "nope"', 'type is checked first');
  assert.equal(commandError({ v: 1, type: 'droneToggle', on: true }), null);
  assert.equal(commandError({ v: 1, type: 'droneToggle', on: 'x' }), 'droneToggle.on');
});

test('bus: a relayed remote hello is not answered by the bus (no throttle bypass)', () => {
  const sent = [];
  let onCmd = null;
  const bus = createBus({ role: 'main', rig: { busPublish: (j) => sent.push(j), onBusCommand: (cb) => { onCmd = cb; } },
    BroadcastChannel: null, timers: { setTimeout: () => 0, clearTimeout: () => {} }, now: () => 0, warn: () => {} });
  bus.publish(base());
  assert.equal(sent.length, 1);
  for (let i = 0; i < 20; i++) onCmd(JSON.stringify({ v: 1, type: 'hello', via: 'remote' }));
  assert.equal(sent.length, 1, 'remote hellos send nothing');
  onCmd(JSON.stringify({ v: 1, type: 'hello' }));
  assert.equal(sent.length, 2, 'a popover hello is answered at once, as before');
});

test('controller: droneToggle with on sets the drone (absolute); without on it flips as before', async () => {
  const { store, ctl } = await setup();
  const id = store.currentSong().id;
  store.set(`songs.${id}.drone.mode`, 'synth');
  const mode = () => store.currentSong().drone.mode;
  assert.equal(ctl.handleCommand({ v: 1, type: 'droneToggle', on: true, via: 'remote' }), true);
  assert.equal(mode(), 'synth', 'already on: unchanged');
  ctl.handleCommand({ v: 1, type: 'droneToggle', on: false, via: 'remote' });
  ctl.handleCommand({ v: 1, type: 'droneToggle', on: false, via: 'remote' });
  assert.equal(mode(), 'off', 'two offs: still off');
  ctl.handleCommand({ v: 1, type: 'droneToggle', on: true, via: 'remote' });
  ctl.handleCommand({ v: 1, type: 'droneToggle', on: true, via: 'remote' });
  assert.equal(mode(), 'synth', 'back to the mode it had');
  ctl.handleCommand({ v: 1, type: 'droneToggle' });
  assert.equal(mode(), 'off', 'no on: a flip');
});

test('controller: the state carries locked (Perform Lock) and the playing snapshot name', async () => {
  const { store, ctl } = await setup();
  let st = ctl.menuBarState();
  assert.equal(stateError(st), null);
  assert.equal(st.locked, false);
  assert.equal('scene' in st, false, 'no scenes: no scene field');
  store.set('settings.performLock', true);
  await settle();
  assert.equal(ctl.menuBarState().locked, true);
  store.set('settings.performLock', false);
  await settle();
  assert.equal(ctl.scenes.save(0, { name: '  Verse   one ' }), true);
  assert.equal(ctl.scenes.save(1), true);
  await settle();
  assert.equal(ctl.scenes.go(0), true);
  await settle();
  st = ctl.menuBarState();
  assert.equal(stateError(st), null);
  assert.deepEqual(st.scene, { n: 0, count: 2, name: 'Verse one' }, 'snapshot 1 carries its D25 name');
  ctl.handleCommand({ v: 1, type: 'nextScene' });
  await settle();
  st = ctl.menuBarState();
  assert.deepEqual(st.scene, { n: 1, count: 2 }, 'an unnamed snapshot sends no name (the remote says "Scene 2")');
  assert.equal(stateError(st), null);
});

test('controller: via remote, Lock refuses everything but panic; other commands are unaffected by via', async () => {
  const { store, engine, ctl, refused } = await setup();
  const nav = store.navIds();
  assert.ok(nav.length >= 2);
  store.set('settings.performLock', true);
  await settle();
  const before = store.currentSong().id;
  assert.equal(ctl.handleCommand({ v: 1, type: 'nextSong', via: 'remote' }), false);
  assert.equal(ctl.handleCommand({ v: 1, type: 'droneToggle', via: 'remote' }), false);
  assert.equal(ctl.handleCommand({ v: 1, type: 'nextScene', via: 'remote' }), false);
  await settle();
  assert.equal(store.currentSong().id, before, 'locked: the song did not change');
  assert.deepEqual(refused.map((r) => [r.type, r.reason]),
    [['nextSong', 'locked'], ['droneToggle', 'locked'], ['nextScene', 'locked']]);
  engine.clear();
  assert.equal(ctl.handleCommand({ v: 1, type: 'panic', via: 'remote' }), true, 'PANIC always works');
  assert.ok(engine.names().includes('allNotesOff'));
  // a local command (no via: the menu-bar popover, hotkeys) is not gated here
  assert.equal(ctl.handleCommand({ v: 1, type: 'nextSong' }), true);
  store.set('settings.performLock', false);
  await settle();
  const mid = store.currentSong().id;
  assert.equal(ctl.handleCommand({ v: 1, type: 'prevSong', via: 'remote' }), true);
  await settle();
  assert.notEqual(store.currentSong().id, mid, 'unlocked: the remote steps songs');
});

test('controller: a remote may only send D34\'s commands, locked or not', async () => {
  const { store, ctl, refused } = await setup();
  for (const cmd of [
    { type: 'master', value: 0 }, { type: 'selectMode', id: store.navIds()[1] }, { type: 'record', on: true },
    { type: 'lowResource', on: true }, { type: 'droneKey', pc: 3 }, { type: 'fadeOutAll' }, { type: 'hello' },
    { type: 'openMain' }, { type: 'nextMode' }, { type: 'prevMode' },
  ]) {
    assert.equal(ctl.handleCommand({ v: 1, ...cmd, via: 'remote' }), false, cmd.type);
  }
  assert.ok(refused.every((r) => r.reason === 'not-allowed'));
  assert.equal(refused.length, 10);
  assert.equal(store.get().settings.lowResource, false);
});
