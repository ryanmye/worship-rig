// Remote lane (D45): app/js/native-shell/40-bus.js, the Mac command bus and rig.remote, over a fake rigShell handler.
// Then shared/bus.js running on top of it, as the controller uses it in the native app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadShell, plain } from './fake-shell.mjs';
import { createBus } from '../../../app/js/shared/bus.js';

const state = {
  v: 1, current: null, modes: [], master: 1, masterDb: 0, droneOn: false, droneKey: '', audio: 'running',
  latencyMs: 0, midi: { connected: false, name: null }, lowResource: false, recording: false, windowVisible: true,
  memoryMB: null, locked: false,
};

test('busPublish sends the JSON text (objects stringified); onBusCommand gets what Swift relays', async () => {
  const { win, handler } = loadShell({ handlers: { busPublish: () => ({ ok: true }) } });
  const rig = win.rig;
  assert.equal(typeof rig.busPublish, 'function');
  assert.deepEqual(plain(await rig.busPublish('{"v":1}')), { ok: true });
  await rig.busPublish({ v: 1 });
  assert.deepEqual(handler.calls.map((c) => c.json), ['{"v":1}', '{"v":1}']);
  const got = [];
  const off = rig.onBusCommand((j) => got.push(j));
  const off2 = rig.onBusCommand(() => { throw new Error('x'); });
  win.__rigShell.bus('{"v":1,"type":"panic","via":"remote"}');
  win.__rigShell.bus({ not: 'a string' }); // ignored
  off();
  off2();
  win.__rigShell.bus('{"v":1,"type":"nextSong"}');
  assert.deepEqual(got, ['{"v":1,"type":"panic","via":"remote"}']);
  assert.equal(rig.onBusCommand('nope')(), undefined);
});

test('rig.remote on macOS: calls, and onInfo gets the parsed info Swift pushes; none on the iPad', async () => {
  const { win, handler } = loadShell({
    handlers: { remoteInfo: () => ({ on: false }), remoteSetEnabled: (b) => ({ on: b.on }), remoteNewCode: () => ({}),
      remoteForgetAll: () => ({}) },
  });
  const r = win.rig.remote;
  assert.deepEqual(plain(await r.info()), { on: false });
  assert.deepEqual(plain(await r.setEnabled(true)), { on: true });
  assert.deepEqual(plain(await r.setEnabled('yes')), { on: false }, 'only true switches it on');
  await r.newCode();
  await r.forgetAll();
  assert.deepEqual(handler.calls.map((c) => c.m), ['remoteInfo', 'remoteSetEnabled', 'remoteSetEnabled', 'remoteNewCode',
    'remoteForgetAll']);
  const infos = [];
  const off = r.onInfo((i) => infos.push(plain(i)));
  win.__rigShell.remoteInfo('{"on":true,"port":8450}');
  win.__rigShell.remoteInfo('not json');
  off();
  win.__rigShell.remoteInfo('{"on":false}');
  assert.deepEqual(infos, [{ on: true, port: 8450 }]);
  const ipad = loadShell({ config: { platform: 'ipados' } });
  assert.equal(typeof ipad.win.rig.busPublish, 'function', 'the bus is on both');
  assert.equal(ipad.win.rig.remote, undefined, 'the remote is the Mac app\'s (D34)');
});

test('injected twice: one set of members, commands delivered once', () => {
  const { win, run } = loadShell();
  const first = win.rig.busPublish;
  run();
  assert.equal(win.rig.busPublish, first);
  const got = [];
  win.rig.onBusCommand((j) => got.push(j));
  win.__rigShell.bus('{"v":1,"type":"panic"}');
  assert.equal(got.length, 1);
});

test('shared/bus.js over the shell: publish → busPublish, relayed commands → onCommand (checked again)', async () => {
  const { win, handler } = loadShell({ handlers: { busPublish: () => ({ ok: true }) } });
  const warns = [];
  const bus = createBus({ role: 'main', rig: win.rig, BroadcastChannel: null, now: () => 0,
    timers: { setTimeout: () => 0, clearTimeout: () => {} }, warn: (m) => warns.push(m) });
  assert.deepEqual(bus.transport, { publish: 'rig', commands: 'rig', subscribe: 'none', command: 'none' });
  assert.equal(bus.publish(state), true);
  assert.deepEqual(JSON.parse(handler.calls[0].json), state);
  const cmds = [];
  bus.onCommand((c) => cmds.push(c));
  win.__rigShell.bus('{"v":1,"type":"droneToggle","on":true,"via":"remote"}');
  win.__rigShell.bus('{"v":1,"type":"panic","via":"elsewhere"}');
  assert.deepEqual(cmds, [{ v: 1, type: 'droneToggle', on: true, via: 'remote' }]);
  assert.deepEqual(warns, ['dropped an invalid command (via)']);
});
