// v11-electron: the store's settings.hotkeys / settings.updateCheck (optional, device-local, normalised; SCHEMA 1)
// and shell-mirror.js (store → window.rig.setHotkeys / setUpdateCheck, like main.js mirrors menuBarMode).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_LOCAL_SETTINGS, SCHEMA, memoryStorage, STORAGE_KEY } from '../../../app/js/store.js';
import { DEFAULT_HOTKEYS } from '../../../app/js/shared/hotkeys.js';
import { mirrorShellSettings } from '../../../app/js/shell-mirror.js';
import { makeStore, tick } from './helpers.mjs';

test('store: hotkeys and updateCheck stay absent until set (schema stays 1)', () => {
  const s = makeStore();
  assert.equal(SCHEMA, 1);
  assert.equal('hotkeys' in s.get().settings, false);
  assert.equal('updateCheck' in s.get().settings, false);
});

test('store: settings.hotkeys is set whole and normalised; nested paths and junk are refused', () => {
  const s = makeStore();
  assert.notEqual(s.set('settings.hotkeys', { on: true, keys: { nextSong: 'cmd+ctrl+alt+n' } }), false);
  const hk = s.get().settings.hotkeys;
  assert.equal(hk.on, true);
  assert.equal(hk.keys.nextSong, 'Control+Alt+Command+N');
  assert.equal(hk.keys.panic, DEFAULT_HOTKEYS.panic, 'missing actions get the defaults');
  const before = s.get().settings.hotkeys;
  s.set('settings.hotkeys.on', false);
  s.set('settings.hotkeys', 'on');
  s.set('settings.hotkeys', [1, 2]);
  assert.deepEqual(s.get().settings.hotkeys, before, 'refused: the old value stays');
});

test('store: updateCheck takes a boolean only', () => {
  const s = makeStore();
  s.set('settings.updateCheck', false);
  assert.equal(s.get().settings.updateCheck, false);
  s.set('settings.updateCheck', 'no');
  assert.equal(s.get().settings.updateCheck, false);
  s.set('settings.updateCheck', true);
  assert.equal(s.get().settings.updateCheck, true);
});

test('store: a stored library with bad values loads clean (bad hotkeys/updateCheck dropped, good ones normalised)', () => {
  const storage = memoryStorage();
  const lib = { schema: 1, songs: {}, setlists: {}, meta: {}, settings: { hotkeys: 'garbage', updateCheck: 'maybe' } };
  storage.setItem(STORAGE_KEY, JSON.stringify(lib));
  const a = makeStore({ storage });
  assert.equal('hotkeys' in a.get().settings, false);
  assert.equal('updateCheck' in a.get().settings, false);
  const storage2 = memoryStorage();
  storage2.setItem(STORAGE_KEY, JSON.stringify({ ...lib, settings: { hotkeys: { on: true, keys: { panic: 'alt+ctrl+cmd+k' } } } }));
  const b = makeStore({ storage: storage2 });
  assert.equal(b.get().settings.hotkeys.keys.panic, 'Control+Alt+Command+K');
  assert.equal(b.get().settings.hotkeys.on, true);
});

test('v11-decisions: a stored settings.hotkeys with nextMode / prevMode loads as nextSong / prevSong', () => {
  const storage = memoryStorage();
  const keys = { nextMode: 'Control+Alt+Command+N', prevMode: '', panic: 'F13' };
  const lib = { schema: 1, songs: {}, setlists: {}, meta: {}, settings: { hotkeys: { on: true, keys } } };
  storage.setItem(STORAGE_KEY, JSON.stringify(lib));
  const s = makeStore({ storage });
  const hk = s.get().settings.hotkeys;
  assert.equal(hk.on, true);
  assert.equal(hk.keys.nextSong, 'Control+Alt+Command+N', 'the saved combination moved');
  assert.equal(hk.keys.prevSong, '', 'a saved "none" stays none');
  assert.equal(hk.keys.panic, 'F13');
  assert.ok(!('nextMode' in hk.keys) && !('prevMode' in hk.keys));
  s.dispose();
  const again = makeStore({ storage });
  assert.deepEqual(again.get().settings.hotkeys, hk, 'idempotent across a reload');
});

test('store: both are device-local — not exported, kept across a replace-import, and not an edit', () => {
  assert.ok(DEVICE_LOCAL_SETTINGS.includes('hotkeys') && DEVICE_LOCAL_SETTINGS.includes('updateCheck'));
  const a = makeStore();
  a.set('settings.hotkeys', { on: true, keys: DEFAULT_HOTKEYS });
  a.set('settings.updateCheck', false);
  const doc = JSON.parse(a.exportJSON());
  assert.equal('hotkeys' in doc.settings, false);
  assert.equal('updateCheck' in doc.settings, false);
  const b = makeStore();
  b.set('settings.updateCheck', false);
  assert.equal(b.importJSON(a.exportJSON(), { replace: true }).ok, true);
  assert.equal(b.get().settings.updateCheck, false, 'this machine keeps its choice');
  assert.equal('hotkeys' in b.get().settings, false, 'absent stays absent');
});

/** window.rig stand-in recording the mirror calls. */
function fakeRig() {
  const calls = [];
  return {
    calls,
    setHotkeys: async (cfg) => (calls.push(['hotkeys', cfg]), { on: cfg.on, paused: false, keys: {} }),
    setUpdateCheck: async (on) => (calls.push(['update', on]), { enabled: on }),
  };
}

test('shell-mirror: sends the current values once, then only real changes', async () => {
  const store = makeStore();
  const rig = fakeRig();
  const stop = mirrorShellSettings({ store, rig });
  assert.deepEqual(rig.calls.splice(0), [
    ['hotkeys', { on: false, keys: { ...DEFAULT_HOTKEYS } }],
    ['update', true],
  ], 'absent = shortcuts off, checking on');
  store.set('settings.lowResource', true); // another setting: nothing to send
  await tick();
  assert.deepEqual(rig.calls, []);
  store.set('settings.hotkeys', { on: true, keys: DEFAULT_HOTKEYS });
  store.set('settings.updateCheck', false);
  await tick();
  assert.deepEqual(rig.calls.splice(0), [['hotkeys', { on: true, keys: { ...DEFAULT_HOTKEYS } }], ['update', false]]);
  store.set('settings.hotkeys', { on: true, keys: DEFAULT_HOTKEYS }); // same value
  await tick();
  assert.deepEqual(rig.calls, []);
  stop();
  store.set('settings.updateCheck', true);
  await tick();
  assert.deepEqual(rig.calls, [], 'stopped');
});

test('shell-mirror: Chrome (no window.rig) is a no-op', () => {
  const stop = mirrorShellSettings({ store: makeStore(), rig: null });
  assert.equal(typeof stop, 'function');
  stop();
});
