// Lane N0: the controller in the native 2.0 app (window.rig from app/js/native-shell, rig.shell === 'native').
//   - __rigShell is merged into (recording / library beside the shell's menu / menuReady), never replaced, and
//     dispose() removes only what it added (NATIVE-GAPS §0 finding 3: replacing it broke the native menu dispatcher
//     and the first-launch import probe)
//   - ⌘. ⌘E ⌘R ⌘⇧F stay the page's until the shell says its menu owns them (rig.menuOwnsShortcuts, lane N5)
//   - navigator.wakeLock is asked for unless the shell keeps the display awake itself (rig.keepsAwake, lane N5)
//   - Electron is unchanged: its __rigShell is the controller's own, replaced and deleted as before
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, key, tick } from './helpers.mjs';
import { loadShell } from '../../unit/native-shell/fake-shell.mjs';

afterEach(() => {
  delete globalThis.__rigShell;
});

/** The real native-shell files in a vm; their window.rig and __rigShell become the controller's. */
function nativeRig(config) {
  const { win } = loadShell({ config, handlers: { backupNow: () => ({ path: '/b/1.json' }), getInfo: () => ({}) } });
  globalThis.__rigShell = win.__rigShell;
  return win.rig;
}

async function setup({ rig, nav = null } = {}) {
  const store = makeStore();
  const engine = fakeEngine();
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const doc = fakeDoc();
  const ctl = createController({ store, engine, midi, recorder: null, doc, nav, win: new EventTarget(), rig,
    timers: fakeTimers(), now: () => 0, locks: null, heartbeat: false, indexedDB: null });
  await ctl.start();
  return { store, engine, ctl, doc };
}

test('native: the controller merges recording() / library() into the shell’s __rigShell and keeps menu()', async () => {
  const rig = nativeRig();
  const shell = globalThis.__rigShell;
  const menu = shell.menu;
  const { ctl, store } = await setup({ rig });
  assert.equal(globalThis.__rigShell, shell, 'the same object: not replaced');
  assert.equal(shell.menu, menu);
  assert.equal(shell.menuReady(), true, 'controller.onMenu registered through rig.onMenu');
  assert.equal(typeof shell.call, 'function');
  assert.equal(shell.recording(), false);
  assert.equal(shell.library(), null, 'pristine: no close backup (round2-shell #2)');
  store.set('song.tempo', 97);
  await tick();
  assert.equal(typeof shell.library(), 'string');
  ctl.dispose();
  assert.equal(globalThis.__rigShell, shell, 'dispose() leaves the shell’s object');
  assert.equal(shell.recording, undefined, 'its own members are removed');
  assert.equal(shell.library, undefined);
  assert.equal(shell.menu, menu, 'the shell’s members stay');
  assert.equal(shell.native, true);
});

test('native: dispose() leaves a recording() the shell put back after the controller (not the controller’s)',
  async () => {
    const rig = nativeRig();
    const shell = globalThis.__rigShell;
    const { ctl } = await setup({ rig });
    const theirs = () => true;
    shell.recording = theirs;
    ctl.dispose();
    assert.equal(shell.recording, theirs);
  });

test('native: a menu id from the shell reaches the controller (the first-launch import path)', async () => {
  const rig = nativeRig();
  const { ctl } = await setup({ rig });
  const got = [];
  ctl.addEventListener('menu', (e) => got.push(e.detail.id));
  globalThis.__rigShell.menu('openSettings');
  await tick();
  assert.deepEqual(got, ['openSettings']);
  ctl.dispose();
});

test('native: ⌘. ⌘E ⌘R ⌘⇧F are the page’s while rig.menuOwnsShortcuts is false; skipped once it is true', async () => {
  const off = await setup({ rig: nativeRig({ platform: 'macos', menuOwnsShortcuts: false }) });
  off.engine.clear();
  const ev = key(off.doc, 'keydown', { key: '.', code: 'Period', metaKey: true });
  assert.equal(ev.defaultPrevented, true, 'the page handled ⌘.');
  assert.ok(off.engine.calls.some((c) => c[0] === 'allNotesOff'), JSON.stringify(off.engine.calls));
  off.ctl.dispose();
  delete globalThis.__rigShell;

  const on = await setup({ rig: nativeRig({ platform: 'macos', menuOwnsShortcuts: true }) });
  on.engine.clear();
  const ev2 = key(on.doc, 'keydown', { key: '.', code: 'Period', metaKey: true });
  assert.equal(ev2.defaultPrevented, false, 'left to the native menu');
  assert.ok(!on.engine.calls.some((c) => c[0] === 'allNotesOff'));
  on.ctl.dispose();
});

test('native: navigator.wakeLock unless rig.keepsAwake', async () => {
  const asked = [];
  const nav = { wakeLock: { request: async (t) => (asked.push(t), { released: false, release: async () => {} }) } };
  const a = await setup({ rig: nativeRig({ platform: 'macos', keepsAwake: false }), nav });
  await tick();
  assert.deepEqual(asked, ['screen']);
  a.ctl.dispose();
  delete globalThis.__rigShell;
  const b = await setup({ rig: nativeRig({ platform: 'macos', keepsAwake: true }), nav });
  await tick();
  assert.deepEqual(asked, ['screen'], 'the shell keeps the display awake itself');
  b.ctl.dispose();
});

test('Electron unchanged: the controller owns __rigShell (replaced, then deleted); the menu owns the shortcuts',
  async () => {
    globalThis.__rigShell = { stale: true };
    const rig = { isElectron: true, backupNow: async () => ({ path: '/b.json' }), getInfo: async () => ({}) };
    const asked = [];
    const nav = { wakeLock: { request: async (t) => (asked.push(t), { released: false }) } };
    const { ctl, doc, engine } = await setup({ rig, nav });
    assert.deepEqual(Object.keys(globalThis.__rigShell).sort(), ['library', 'recording']);
    engine.clear();
    const ev = key(doc, 'keydown', { key: '.', code: 'Period', metaKey: true });
    assert.equal(ev.defaultPrevented, false);
    await tick();
    assert.deepEqual(asked, [], 'Electron: powerSaveBlocker, no wake lock');
    ctl.dispose();
    assert.equal(globalThis.__rigShell, undefined);
  });

test('Chrome unchanged: no window.rig, no __rigShell from the controller', async () => {
  const { ctl } = await setup({ rig: null });
  assert.equal(globalThis.__rigShell, undefined);
  ctl.dispose();
});
