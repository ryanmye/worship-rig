// 1.1.1 (2.0 DECISIONS D11): backups and Settings › Export library carry this machine's device-local settings in the
// optional top-level `deviceSettings` block {v, install, settings}, for Worship Rig 2.0. The library's own settings
// stay without them (security S3), and 1.x never reads the block back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  memoryStorage, DEVICE_LOCAL_SETTINGS, DEVICE_SETTINGS_KEY, DEVICE_SETTINGS_VERSION, INSTALL_ID_KEY, SCHEMA,
} from '../../../app/js/store.js';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

/** Every 1.x device-local setting set to a non-default value (made-up names; no real user data). */
function withDevices(store) {
  const s = store;
  assert.equal(s.set('settings.outputDeviceId', 'dev-0xabc'), true);
  assert.equal(s.set('settings.padFolder', { kind: 'electron', path: '/Volumes/Rig/Pads' }), true);
  assert.equal(s.set('settings.midiInputId', 'input-0x1f2e'), true);
  assert.equal(s.set('settings.midiInputName', 'Stage Piano MIDI Out'), true);
  assert.equal(s.set('settings.menuBarMode', true), true);
  assert.equal(s.set('settings.lowResource', true), true);
  assert.equal(s.set('settings.audioSleepSec', 120), true);
  assert.equal(s.set('settings.hotkeys', { on: true, keys: { panic: 'F13' } }), true);
  assert.equal(s.set('settings.updateCheck', false), true);
  assert.equal(s.set('settings.midiClockOut', 'IAC Driver Bus 1'), true);
  assert.equal(s.set('settings.dynamicRange', 1.4), true);
  s.setKeyboard('Stage Piano MIDI Out', { touch: { shape: 1.4, min: 0.05, max: 1, top: 118 }, remember: true });
  s.setClick({ level: 0.5, countIn: 1 });
  s.set('settings.pedalInvert', true); // library content, not device-local
  return s;
}

test('D11: exportJSON({device:true}) adds the block: {v, install, settings} with every device-local setting set', () => {
  const s = withDevices(makeStore());
  const doc = JSON.parse(s.exportJSON({ device: true }));
  const b = doc[DEVICE_SETTINGS_KEY];
  assert.deepEqual(Object.keys(b).sort(), ['install', 'settings', 'v']);
  assert.equal(b.v, DEVICE_SETTINGS_VERSION);
  assert.match(b.install, /^[0-9a-f]{32}$/, 'a random id: no host, user or device name');
  assert.deepEqual(Object.keys(b.settings).sort(), [...DEVICE_LOCAL_SETTINGS].sort(), 'all 13 1.x keys');
  for (const k of DEVICE_LOCAL_SETTINGS) assert.deepEqual(b.settings[k], s.get().settings[k], k);
  // S3 still holds for the library's own settings; the file is otherwise 1.1.0's
  for (const k of DEVICE_LOCAL_SETTINGS) assert.equal(k in doc.settings, false, k);
  assert.equal(doc.settings.pedalInvert, true);
  assert.equal(doc.schema, SCHEMA, 'no SCHEMA bump');
  const plainDoc = JSON.parse(s.exportJSON());
  assert.equal(DEVICE_SETTINGS_KEY in plainDoc, false, 'without device:true there is no block');
  delete doc[DEVICE_SETTINGS_KEY];
  delete doc.exportedAt;
  delete plainDoc.exportedAt;
  assert.deepEqual(doc, plainDoc, 'the block is the only difference');
  s.dispose();
});

test('D11: an untouched library has a block with the default device settings only (optional ones absent)', () => {
  const s = makeStore();
  const b = s.deviceSettings();
  assert.deepEqual(b.settings, {
    outputDeviceId: 'default', padFolder: null, midiInputId: 'first', midiInputName: null, menuBarMode: false,
    lowResource: false,
  });
  s.dispose();
});

test('D11: the install id is made once per storage (rig.install), reused by later stores, remade when invalid', () => {
  const storage = memoryStorage();
  const a = makeStore({ storage });
  assert.equal(storage.getItem(INSTALL_ID_KEY), null, 'not written until a block is made');
  const id = a.installId();
  assert.equal(storage.getItem(INSTALL_ID_KEY), id);
  assert.equal(a.installId(), id);
  a.dispose();
  const b = makeStore({ storage });
  assert.equal(b.deviceSettings().install, id, 'a later launch on the same origin: same marker');
  b.dispose();
  const other = makeStore();
  assert.notEqual(other.installId(), id, 'another origin / machine: another marker');
  other.dispose();
  storage.setItem(INSTALL_ID_KEY, 'my-macbook.local');
  const c = makeStore({ storage });
  const fresh = c.installId();
  assert.match(fresh, /^[0-9a-f]{32}$/);
  assert.notEqual(fresh, 'my-macbook.local');
  c.dispose();
  // storage that refuses writes: an id for this session, nothing thrown
  const ro = memoryStorage();
  ro.setItem = () => {
    throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
  };
  const d = makeStore({ storage: ro });
  assert.match(d.installId(), /^[0-9a-f]{32}$/);
  assert.equal(d.installId(), d.installId());
  d.dispose();
});

test('D11: 1.1.1 never reads the block back: replace and merge drop it and keep this machine\'s settings', () => {
  const a = withDevices(makeStore());
  const text = a.exportJSON({ device: true });
  const b = makeStore();
  b.set('settings.outputDeviceId', 'usb-b');
  assert.equal(b.importJSON(text, { replace: true }).ok, true);
  assert.equal(DEVICE_SETTINGS_KEY in b.get(), false, 'not kept in the state');
  assert.equal(b.get().settings.outputDeviceId, 'usb-b');
  assert.equal(b.get().settings.midiInputName, null);
  assert.equal(b.get().settings.keyboards, undefined);
  assert.equal(b.get().settings.pedalInvert, true);
  assert.deepEqual(b.get().songs, a.get().songs);
  const c = makeStore();
  const r = c.importJSON(text);
  assert.equal(r.ok, true);
  assert.equal(DEVICE_SETTINGS_KEY in c.get(), false);
  assert.equal(c.get().settings.padFolder, null);
  for (const s of [a, b, c]) s.dispose();
});

test('D11: controller.backupNow writes the block, tagged with the origin, with the same install id each time', async () => {
  const backups = [];
  const rig = { isElectron: true, onMenu: () => () => {}, backupNow: async (json) => (backups.push(json), { path: '/x' }) };
  const store = withDevices(makeStore());
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const savedLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: { origin: 'http://127.0.0.1:8438' }, configurable: true });
  let ctl;
  try {
    ctl = createController({
      store, engine: fakeEngine(), midi, recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(), rig,
      timers: fakeTimers(), now: () => 0,
    });
  } finally {
    if (savedLocation) Object.defineProperty(globalThis, 'location', savedLocation);
    else delete globalThis.location;
  }
  await ctl.start();
  await tick();
  await ctl.backupNow();
  await ctl.backupNow();
  assert.equal(backups.length >= 2, true);
  const docs = backups.map((t) => JSON.parse(t));
  for (const [i, d] of docs.entries()) {
    assert.ok(backups[i].startsWith('{"origin":"http://127.0.0.1:8438",'), 'M5 origin tag first, as before');
    assert.equal(d.app, 'worship-rig');
    assert.equal(d[DEVICE_SETTINGS_KEY].install, store.installId());
    assert.equal(d[DEVICE_SETTINGS_KEY].settings.midiInputName, 'Stage Piano MIDI Out');
    assert.deepEqual(d[DEVICE_SETTINGS_KEY].settings.padFolder, { kind: 'electron', path: '/Volumes/Rig/Pads' });
    for (const k of DEVICE_LOCAL_SETTINGS) assert.equal(k in d.settings, false, k);
  }
  ctl.dispose?.();
  store.dispose();
});
