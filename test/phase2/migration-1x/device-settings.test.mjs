// D11: 1.1.1 writes the 1.x device-local settings into its backups and exports (`deviceSettings` block); 2.0 takes
// them in. The fixtures were made by the real 1.1.1 code (test/fixtures/library-1x/v1.1.1, generator --from the
// v1.1.1-prep worktree). Rules under test:
//   - same-machine paths apply the block by themselves: Electron "Import latest backup", the native shell's own /
//     Electron backups folder and its first-launch import;
//   - only settings this machine has not set are filled in; a setting changed here is never overwritten;
//   - device selections (MIDI input, clock output, audio output, pad folder) apply only when found here, else one
//     line names what was skipped;
//   - a picked / received file (native `via: 'picked'`) is never applied by itself;
//   - every value goes through 2.0's own validators; unknown / invalid ones are dropped with a warning;
//   - Settings › Import… only offers the block (inspectDeviceSettings: this computer's marker or not; the checkbox
//     itself is in browser.pw.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createStore, memoryStorage, readDeviceSettings, validDeviceSetting, deviceSettingUnset, DEVICE_SETTINGS_KEY,
  DEVICE_BLOCK_SETTINGS, DEVICE_LOCAL_SETTINGS, INSTALL_ID_KEY, KNOWN_INSTALLS_KEY, KNOWN_INSTALLS_MAX, SCHEMA,
  DEVICE_TOUCHED_KEY, STORAGE_KEY,
} from '../../../app/js/store.js';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { fakeEngine, fakeTimers, fakeDoc, tick } from '../../phase1/shell/helpers.mjs';
import { fixture, electronHost, nativeShell, writeAged, rotationName, snapshot, tmpDir, plain } from './lib.mjs';

const dirs = [];
const mk = (tag) => {
  const d = tmpDir(tag);
  dirs.push(d);
  return d;
};
let savedLocation;
before(() => {
  savedLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: { origin: 'rig://app' }, configurable: true, writable: true });
});
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  if (savedLocation) Object.defineProperty(globalThis, 'location', savedLocation);
  else delete globalThis.location;
});

const R = 'v1.1.1';
const f111 = (name, form = 'backup') => fixture(R, `${name}.${form}.json`);
const blockOf = (text) => JSON.parse(text)[DEVICE_SETTINGS_KEY];
const DEV = blockOf(f111('devices')); // every 1.x device-local setting, Electron pad folder
const RICH = blockOf(f111('rich')); // the same, with an FSA pad folder

let ids = 0;
const makeStore = (opts = {}) => createStore({
  storage: memoryStorage(), idGen: (p) => `${p}-ds${++ids}`, requestIdle: null, warn: () => {}, autoFlush: false, ...opts,
});
/** MIDI ports as Web MIDI gives them (the 2.0 app's ids differ from 1.x's). */
const port = (id, name, type) => ({ id, name, type, state: 'connected', connection: 'closed', manufacturer: '',
  addEventListener() {}, removeEventListener() {}, open: async () => {}, close: async () => {} });
/**
 * The controller with the real store, the given shell, and optionally this computer's devices: MIDI inputs and
 * outputs (names), audio outputs (deviceIds) and the folder the Electron shell serves pads from.
 */
async function setup({ store = makeStore(), rig, inputs = [], outputs = [], audio = [], padsRoot } = {}) {
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {
    inputs: new Map(inputs.map((n, i) => [`in-${i}`, port(`native-in-${i}`, n, 'input')])),
    outputs: new Map(outputs.map((n, i) => [`out-${i}`, port(`native-out-${i}`, n, 'output')])),
    addEventListener() {}, removeEventListener() {},
  };
  const nav = { mediaDevices: { enumerateDevices: async () => audio.map((deviceId) => ({ kind: 'audiooutput', deviceId, label: '' })),
    addEventListener() {}, removeEventListener() {} } };
  if (rig && padsRoot !== undefined) rig.getInfo = async () => ({ padsRoot });
  const warns = [];
  const ctl = createController({
    store, engine: fakeEngine(), midi, recorder: null, doc: fakeDoc(), nav, win: new EventTarget(), rig,
    timers: fakeTimers(), now: () => 0, locks: null, heartbeat: false, indexedDB: null,
  });
  ctl.addEventListener('warn', (e) => warns.push(e.detail.message));
  await ctl.start();
  await tick();
  return { store, ctl, warns };
}
/** An Electron 1.x backups folder whose newest file is `text`. */
function electronFolder(text) {
  const dir = mk('electron');
  writeAged(rotationName(dir), fixture('v1.1.0', 'unicode.backup.json'));
  writeAged(rotationName(dir), text);
  return dir;
}
const HERE = { inputs: ['Stage Piano MIDI Out'], outputs: ['IAC Driver Bus 1'], audio: ['dev-0xabc'],
  padsRoot: '/Volumes/Rig/Pads' };
const S = (store) => store.get().settings;

// ================================================================================================ the fixtures
test('the 1.1.1 fixtures carry the block: all 13 1.x device-local keys, one random marker per profile', () => {
  for (const b of [DEV, RICH]) {
    assert.equal(b.v, 1);
    assert.match(b.install, /^[0-9a-f]{32}$/);
    assert.deepEqual(Object.keys(b.settings).sort(), [...DEVICE_BLOCK_SETTINGS].sort());
  }
  assert.equal(blockOf(f111('rich', 'export')).install, RICH.install, 'backup and export of one profile: one marker');
  assert.notEqual(DEV.install, RICH.install, 'another profile (origin): another marker');
  assert.deepEqual(DEV.settings.padFolder, { kind: 'electron', path: '/Volumes/Rig/Pads' });
  assert.deepEqual(RICH.settings.padFolder, { kind: 'fsa', name: 'Pads' });
  // the library's own settings still hold none of them (security S3), and the file is schema 1
  for (const form of ['backup', 'export']) {
    const doc = JSON.parse(f111('devices', form));
    assert.equal(doc.schema, 1);
    for (const k of DEVICE_BLOCK_SETTINGS) assert.equal(k in doc.settings, false, `${form} ${k}`);
  }
  assert.equal(SCHEMA, 2, 'no SCHEMA bump in 2.0');
  // every value 1.1.1 wrote is valid in 2.0
  const d = readDeviceSettings(DEV);
  assert.deepEqual(d.dropped, []);
  assert.equal(Object.keys(d.settings).length, 13);
});

// ================================================================================================ store
test('store: importJSON hands the block to the caller (replace, pristine replace, merge, dry run), never keeps it', () => {
  for (const opts of [{ replace: true }, { replacePristine: true }, {}, { replace: true, dryRun: true }]) {
    const s = makeStore();
    if (!opts.replacePristine && !opts.replace) s.set('song.tempo', 99); // an edited library: merge
    const before = plain(S(s));
    const r = s.importJSON(f111('devices', 'export'), opts);
    assert.equal(r.ok, true, JSON.stringify(opts));
    assert.deepEqual(r.deviceSettings, DEV, JSON.stringify(opts));
    assert.equal(DEVICE_SETTINGS_KEY in s.get(), false);
    for (const k of DEVICE_LOCAL_SETTINGS) assert.deepEqual(S(s)[k], before[k], `${JSON.stringify(opts)} ${k}: untouched`);
    assert.equal(JSON.parse(s.exportJSON()).deviceSettings, undefined, '2.0 writes no block');
  }
  const s = makeStore();
  assert.equal('deviceSettings' in s.importJSON(fixture('v1.1.0', 'rich.export.json'), { replace: true }), false,
    'a 1.1.0 file has none');
});

test('store: readDeviceSettings drops unknown keys, 2.0-only keys and invalid values; refuses a bad block', () => {
  const raw = plain(DEV);
  Object.assign(raw.settings, {
    polyphony: 128, bufferFrames: 64, chartView: true, someFuture: 1, __proto__x: 2, // unknown / not from 1.x
    dynamicRange: 'loud', hotkeys: 42, midiClockOut: '', audioSleepSec: 'soon', keyboards: [], click: 'on',
  });
  raw.settings.menuBarMode = 'yes';
  raw.settings.padFolder = { kind: 'electron' }; // no path
  const d = readDeviceSettings(raw);
  assert.deepEqual(d.dropped.sort(), ['__proto__x', 'audioSleepSec', 'bufferFrames', 'chartView', 'click',
    'dynamicRange', 'hotkeys', 'keyboards', 'menuBarMode', 'midiClockOut', 'padFolder', 'polyphony', 'someFuture'].sort());
  assert.deepEqual(Object.keys(d.settings).sort(), ['lowResource', 'midiInputId', 'midiInputName', 'outputDeviceId',
    'updateCheck'].sort());
  for (const bad of [null, 42, [], {}, { v: 2, settings: {} }, { v: 1 }, { v: '1', settings: {} }]) {
    assert.equal(readDeviceSettings(bad), null, JSON.stringify(bad));
  }
  assert.equal(readDeviceSettings({ v: 1, install: 'my-mac.local', settings: {} }).install, null, 'not a marker');
  assert.equal(validDeviceSetting('audioSleepSec', 99999), 3600, 'clamped as the store clamps');
  assert.equal(deviceSettingUnset({ midiInputId: 'all' }, 'midiInputName'), false);
});

test('store: applyDeviceSettings fills only unset settings; keyboards merge per name; device-local writes are no edit', () => {
  const s = makeStore();
  s.set('settings.audioSleepSec', 45);
  s.set('settings.hotkeys', { on: false, keys: {} });
  s.setKeyboard('Stage Piano MIDI Out', { touch: { shape: 2, min: 0, max: 1, top: 127 } });
  const hk = plain(S(s).hotkeys);
  const pristine = s.pristine;
  const w = s.applyDeviceSettings(readDeviceSettings(DEV).settings);
  assert.ok(w.kept.includes('audioSleepSec') && w.kept.includes('hotkeys'));
  assert.equal(S(s).audioSleepSec, 45);
  assert.deepEqual(S(s).hotkeys, hk);
  assert.equal(S(s).hotkeys.on, false);
  assert.equal(S(s).keyboards['Stage Piano MIDI Out'].touch.shape, 2, 'this machine’s curve wins');
  assert.deepEqual(S(s).keyboards['Computer keyboard'], DEV.settings.keyboards['Computer keyboard'], 'a new one is added');
  assert.equal(S(s).menuBarMode, true);
  assert.equal(S(s).dynamicRange, 1.6);
  assert.equal(s.pristine, pristine, 'device-local settings do not count as an edit');
  assert.deepEqual(s.applyDeviceSettings(readDeviceSettings(DEV).settings).applied, [], 'a second time: nothing');
});

test('store: machine markers — this origin’s rig.install and the remembered ones; never created by 2.0', () => {
  const storage = memoryStorage();
  const s = makeStore({ storage });
  assert.deepEqual(s.machineMarkers(), []);
  assert.equal(storage.getItem(INSTALL_ID_KEY), null);
  storage.setItem(INSTALL_ID_KEY, RICH.install); // 1.1.1 Chrome on this origin wrote it
  assert.deepEqual(s.machineMarkers(), [RICH.install]);
  assert.equal(s.rememberMachineMarker('nope'), false);
  for (let i = 0; i < KNOWN_INSTALLS_MAX + 3; i++) s.rememberMachineMarker(i.toString(16).padStart(32, '0'));
  assert.equal(s.rememberMachineMarker(DEV.install), true);
  assert.equal(JSON.parse(storage.getItem(KNOWN_INSTALLS_KEY)).length, KNOWN_INSTALLS_MAX);
  assert.deepEqual(s.machineMarkers().slice(0, 2), [RICH.install, DEV.install]);
  storage.setItem(KNOWN_INSTALLS_KEY, '{broken');
  assert.deepEqual(s.machineMarkers(), [RICH.install]);
});

// ================================================================================================ same machine
test('Electron "Import latest backup": a 1.1.1 backup brings every device setting found here', async () => {
  const dir = electronFolder(f111('devices'));
  const host = electronHost(dir);
  const before = snapshot(dir);
  const { store, ctl, warns } = await setup({ rig: host.rig, ...HERE });
  const r = await ctl.importLatestBackup();
  assert.equal(r.ok, true, r.error);
  assert.equal('deviceSettings' in r, false);
  assert.deepEqual(r.device.skipped, []);
  assert.deepEqual(r.device.dropped, []);
  const st = S(store);
  assert.equal(st.midiInputId, 'native-in-0', 'this app’s id for the keyboard, found by its name');
  assert.equal(st.midiInputName, 'Stage Piano MIDI Out');
  assert.equal(st.midiClockOut, 'IAC Driver Bus 1');
  assert.equal(st.outputDeviceId, 'dev-0xabc');
  assert.deepEqual(st.padFolder, { kind: 'electron', path: '/Volumes/Rig/Pads' });
  for (const k of ['menuBarMode', 'lowResource', 'audioSleepSec', 'hotkeys', 'updateCheck', 'click', 'keyboards',
    'dynamicRange']) assert.deepEqual(st[k], DEV.settings[k], k);
  assert.deepEqual(store.machineMarkers(), [DEV.install], 'remembered as this computer');
  assert.deepEqual(warns.filter((w) => /device|Not found/i.test(w)), []);
  assert.deepEqual(snapshot(dir), before, 'the 1.x folder is only read');
  ctl.dispose?.();
});

test('missing devices are skipped with one line; the other settings still come over', async () => {
  const host = electronHost(electronFolder(f111('devices')));
  const { store, ctl, warns } = await setup({ rig: host.rig, padsRoot: '/Users/other/Pads' });
  const r = await ctl.importLatestBackup();
  assert.equal(r.ok, true);
  assert.deepEqual(r.device.skipped.sort(), ['midiClockOut', 'midiInputId', 'outputDeviceId', 'padFolder']);
  const st = S(store);
  assert.equal(st.midiInputId, 'first');
  assert.equal(st.midiInputName, null);
  assert.equal(st.outputDeviceId, 'default');
  assert.equal(st.padFolder, null);
  assert.equal(st.midiClockOut, undefined);
  assert.equal(st.menuBarMode, true);
  assert.deepEqual(st.keyboards, DEV.settings.keyboards);
  const lines = warns.filter((w) => /Not found on this computer/.test(w));
  assert.equal(lines.length, 1, JSON.stringify(warns));
  assert.match(lines[0], /the MIDI input "Stage Piano MIDI Out", the MIDI clock output "IAC Driver Bus 1", the audio output, the My Pads folder/);
  // an FSA pad folder (1.1.1 in Chrome) never applies: its handle belongs to the origin that picked it
  const host2 = electronHost(electronFolder(f111('rich')));
  const b = await setup({ rig: host2.rig, ...HERE });
  const r2 = await b.ctl.importLatestBackup();
  assert.ok(r2.device.skipped.includes('padFolder'));
  assert.equal(S(b.store).padFolder, null);
  ctl.dispose?.();
  b.ctl.dispose?.();
});

test('no overwrite: settings changed in 2.0 stay, also through a replace of an edited library', async () => {
  const host = electronHost(electronFolder(f111('devices')));
  const { store, ctl } = await setup({ rig: host.rig, ...HERE, inputs: ['Stage Piano MIDI Out', 'Other Keys'] });
  store.set('song.tempo', 97); // edited: the replace backs it up first
  store.set('settings.midiInputId', 'native-in-1');
  store.set('settings.outputDeviceId', 'dev-0xabc-2');
  store.set('settings.audioSleepSec', 45);
  store.set('settings.menuBarMode', false); // already the default: no change, so 1.x's value may fill it (DS1 below)
  store.set('settings.lowResource', true);
  store.set('settings.updateCheck', true);
  store.set('settings.hotkeys', { on: false, keys: {} });
  store.set('settings.dynamicRange', 1.2);
  store.setClick({ level: 0.9 });
  store.setKeyboard('Stage Piano MIDI Out', { remember: true });
  const mine = plain(S(store));
  const r = await ctl.importLatestBackup();
  assert.equal(r.ok, true);
  const st = S(store);
  for (const k of ['midiInputId', 'outputDeviceId', 'audioSleepSec', 'lowResource', 'updateCheck', 'hotkeys',
    'dynamicRange', 'click']) assert.deepEqual(st[k], mine[k], k);
  assert.deepEqual(st.keyboards['Stage Piano MIDI Out'], { remember: true });
  assert.ok(st.keyboards['Computer keyboard'], 'a keyboard this machine did not have is added');
  assert.equal(st.menuBarMode, true);
  assert.ok(r.device.kept.includes('midiInputId') && r.device.kept.includes('outputDeviceId'));
  assert.equal(r.device.skipped.length, 0, 'kept selections are not checked, so not reported missing');
  ctl.dispose?.();
});

test('native shell: the first-launch import and "Import latest backup" apply the block; a picked file does not', async () => {
  // first launch (via 'first-launch')
  const eDir = electronFolder(f111('devices'));
  const shell = nativeShell({ ownDir: mk('own'), electronDirs: [eDir] });
  const a = await setup({ rig: shell.rig, ...HERE });
  assert.equal(await shell.firstLaunch(a.store), 'imported');
  const [r] = await shell.shell.settled;
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.device.applied.includes('midiInputId') && r.device.applied.includes('keyboards'), true);
  assert.equal(S(a.store).midiInputId, 'native-in-0');
  assert.deepEqual(a.store.machineMarkers(), [DEV.install]);
  // File › Import Library Backup… / AirDrop of the same file (via 'picked'): the library, not the device settings
  const file = writeAged(`${mk('picked')}/rig-from-the-mac.json`, f111('devices'));
  const s2 = nativeShell({ ownDir: mk('own2'), electronDirs: [] });
  const b = await setup({ rig: s2.rig, ...HERE });
  assert.equal(s2.pick(file), 'staged');
  const [r2] = await s2.shell.settled;
  assert.equal(r2.ok, true);
  assert.equal(r2.device.error, 'other machine');
  assert.equal(S(b.store).menuBarMode, false);
  assert.equal(S(b.store).midiInputId, 'first');
  assert.equal(S(b.store).keyboards, undefined);
  assert.deepEqual(b.store.machineMarkers(), []);
  assert.equal(b.warns.filter((w) => /holds the device settings/.test(w)).length, 1);
  // the native menu "Import latest backup" (no staged file): the Electron folder, via 'backups'
  const s3 = nativeShell({ ownDir: mk('own3'), electronDirs: [electronFolder(f111('rich'))] });
  const c = await setup({ rig: s3.rig, ...HERE });
  const r3 = await c.ctl.importLatestBackup();
  assert.equal(r3.ok, true);
  assert.equal(S(c.store).midiClockOut, 'IAC Driver Bus 1');
  for (const x of [a, b, c]) x.ctl.dispose?.();
});

test('a shell payload without `via` is this machine only in Electron (main.js serves just its own folder)', async () => {
  const text = f111('devices');
  const rig = { isElectron: false, platform: 'darwin', onMenu: () => () => {}, backupNow: async () => ({ path: '/x' }),
    latestBackup: async () => ({ path: '/somewhere/rig-20261101-000000.json', origin: null, savedAt: 1, text }) };
  const { store, ctl } = await setup({ rig, ...HERE });
  const r = await ctl.importLatestBackup();
  assert.equal(r.ok, true);
  assert.equal(r.device.error, 'other machine');
  assert.equal(S(store).menuBarMode, false);
  ctl.dispose?.();
});

test('invalid values are dropped with one warning; the valid ones apply', async () => {
  const doc = JSON.parse(f111('devices'));
  Object.assign(doc.deviceSettings.settings, { dynamicRange: 'loud', hotkeys: 42, polyphony: 128, bogus: true });
  const host = electronHost(electronFolder(`{"origin":"http://127.0.0.1:8438",${JSON.stringify(doc).slice(1)}`));
  const { store, ctl, warns } = await setup({ rig: host.rig, ...HERE });
  const r = await ctl.importLatestBackup();
  assert.equal(r.ok, true);
  assert.deepEqual(r.device.dropped.sort(), ['bogus', 'dynamicRange', 'hotkeys', 'polyphony']);
  const st = S(store);
  assert.equal(st.dynamicRange, undefined);
  assert.equal(st.hotkeys, undefined);
  assert.equal(st.polyphony, undefined, 'a 2.0-only setting never comes from a file');
  assert.equal(st.bogus, undefined);
  assert.equal(st.menuBarMode, true);
  const w = warns.filter((x) => /not valid here/.test(x));
  assert.equal(w.length, 1);
  assert.match(w[0], /bogus/);
  // an unreadable block: the library still imports, nothing of the block is used
  doc.deviceSettings = { v: 9, settings: { menuBarMode: true } };
  const host2 = electronHost(electronFolder(JSON.stringify(doc)));
  const b = await setup({ rig: host2.rig, ...HERE });
  const r2 = await b.ctl.importLatestBackup();
  assert.equal(r2.ok, true);
  assert.equal(r2.device.error, 'unreadable');
  assert.equal(S(b.store).menuBarMode, false);
  ctl.dispose?.();
  b.ctl.dispose?.();
});

test('Settings › Import… offer: this computer’s marker or not (inspectDeviceSettings); applying it never overwrites', async () => {
  const storage = memoryStorage();
  const { store, ctl } = await setup({ store: makeStore({ storage }), ...HERE });
  const block = store.importJSON(f111('devices', 'export'), { replacePristine: true, dryRun: true }).deviceSettings;
  assert.deepEqual(ctl.inspectDeviceSettings(block).sameMachine, false, 'a marker this computer never saw');
  assert.equal(ctl.inspectDeviceSettings(block).keys.length, 13);
  storage.setItem(INSTALL_ID_KEY, DEV.install); // 1.1.1 Chrome on this origin
  assert.equal(ctl.inspectDeviceSettings(block).sameMachine, true);
  assert.equal(ctl.inspectDeviceSettings({ ...block, install: undefined }).sameMachine, false);
  assert.equal(ctl.inspectDeviceSettings({ nope: 1 }).ok, false);
  // learned on a same-machine path
  const s2 = makeStore();
  const b = await setup({ store: s2, ...HERE });
  assert.equal(b.ctl.inspectDeviceSettings(block).sameMachine, false);
  s2.rememberMachineMarker(DEV.install);
  assert.equal(b.ctl.inspectDeviceSettings(block).sameMachine, true);
  // the file import itself never applies it; the ticked box does, through applyDeviceSettings
  assert.equal(store.importJSON(f111('devices', 'export'), { replacePristine: true }).ok, true);
  assert.equal(S(store).menuBarMode, false);
  store.set('settings.audioSleepSec', 10);
  const d = await ctl.applyDeviceSettings(block);
  assert.equal(d.ok, true);
  assert.equal(S(store).menuBarMode, true);
  assert.equal(S(store).audioSleepSec, 10);
  assert.deepEqual(store.machineMarkers(), [DEV.install], 'a file import never adds a marker');
  ctl.dispose?.();
  b.ctl.dispose?.();
});

test('a read-only window applies nothing', async () => {
  const host = electronHost(electronFolder(f111('devices')));
  const { store, ctl, warns } = await setup({ rig: host.rig, ...HERE });
  const realInfo = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(store), 'loadInfo')
    || Object.getOwnPropertyDescriptor(store, 'loadInfo');
  Object.defineProperty(store, 'loadInfo', { get: () => ({ ...realInfo.get.call(store), readOnly: true }), configurable: true });
  const d = await ctl.applyDeviceSettings(DEV);
  assert.equal(d.error, 'read-only');
  assert.equal(S(store).menuBarMode, false);
  assert.ok(warns.some((w) => /not saving changes/.test(w)));
  ctl.dispose?.();
});

// ================================================================================================ D11 skeptic
test('DS1: a setting changed in 2.0 and set back to its default is never overwritten (store and controller)', async () => {
  const storage = memoryStorage();
  const s = makeStore({ storage });
  assert.deepEqual(s.deviceSettingsTouched(), []);
  s.set('settings.menuBarMode', true);
  s.set('settings.menuBarMode', false); // back to the default
  s.setClick({ level: 0.3 });
  s.setClick({ level: null }); // click back to absent
  s.set('settings.dynamicRange', 1.4);
  s.set('settings.dynamicRange', 1);
  s.setKeyboard('Computer keyboard', { remember: true });
  s.setKeyboard('Computer keyboard', null); // deleted here
  s.set('settings.midiInputName', 'auto-written by the controller'); // not a choice: not recorded
  assert.deepEqual(s.deviceSettingsTouched().sort(),
    ['click', 'dynamicRange', 'keyboards:Computer keyboard', 'menuBarMode']);
  assert.deepEqual(JSON.parse(storage.getItem(DEVICE_TOUCHED_KEY)).sort(), s.deviceSettingsTouched().sort());
  for (const k of ['menuBarMode', 'click', 'dynamicRange']) assert.equal(deviceSettingUnset(S(s), k), true, k);
  for (const k of ['menuBarMode', 'click', 'dynamicRange']) {
    assert.equal(deviceSettingUnset(S(s), k, s.deviceSettingsTouched()), false, `${k}: touched`);
  }
  const w = s.applyDeviceSettings(readDeviceSettings(DEV).settings);
  assert.ok(['menuBarMode', 'click', 'dynamicRange'].every((k) => w.kept.includes(k)), JSON.stringify(w));
  assert.equal(S(s).menuBarMode, false);
  assert.equal(S(s).click, undefined);
  assert.equal(S(s).dynamicRange, undefined);
  assert.equal(S(s).keyboards['Computer keyboard'], undefined, 'a keyboard deleted here stays deleted');
  assert.ok(S(s).keyboards['Stage Piano MIDI Out'], 'one never touched here is still added');
  assert.equal(S(s).lowResource, true, 'an untouched one is filled in');
  // the record outlives the window (same origin), and a later store reads it
  const s2 = makeStore({ storage });
  assert.ok(s2.deviceSettingsTouched().includes('menuBarMode'));
  // update() writes are recorded too
  s2.update((d) => {
    d.settings.updateCheck = false;
  });
  assert.ok(s2.deviceSettingsTouched().includes('updateCheck'));
  // the controller's device selections: a MIDI input chosen and set back to "first" stays "first"
  const host = electronHost(electronFolder(f111('devices')));
  const st3 = makeStore();
  st3.set('settings.midiInputId', 'native-in-0');
  st3.set('settings.midiInputId', 'first');
  const { ctl } = await setup({ store: st3, rig: host.rig, ...HERE });
  const r = await ctl.importLatestBackup();
  assert.equal(r.ok, true, r.error);
  assert.equal(S(st3).midiInputId, 'first');
  assert.ok(r.device.kept.includes('midiInputId'));
  assert.equal(S(st3).menuBarMode, true, 'untouched ones still come over');
  ctl.dispose?.();
});

test('DS1: a read-only window keeps its record in memory only', () => {
  const storage = memoryStorage();
  const s = makeStore({ storage });
  s.setReadOnly(true);
  s.set('settings.menuBarMode', true);
  assert.equal(storage.getItem(DEVICE_TOUCHED_KEY), null);
  assert.deepEqual(s.applyDeviceSettings({ lowResource: true }).applied, [], 'and applies nothing');
});

test('DS2: on the iPad no path auto-applies a block, not even its own Backups folder (open to Files)', async () => {
  const own = mk('ipad-own');
  writeAged(rotationName(own), f111('devices')); // a Mac's backup dropped into Files › Worship Rig › Backups
  const shell = nativeShell({ ownDir: own, platform: 'ipados' });
  const { store, ctl, warns } = await setup({ rig: shell.rig, ...HERE });
  const r = await ctl.importLatestBackup();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.device.error, 'other machine');
  assert.equal(S(store).menuBarMode, false);
  assert.equal(S(store).keyboards, undefined);
  assert.deepEqual(store.machineMarkers(), []);
  assert.equal(warns.filter((w) => /holds the device settings/.test(w)).length, 1);
  // an older shell that still says 'backups' on the iPad: refused by the platform as well
  const rig = { ...shell.rig, latestBackup: async () => ({ path: '/x/rig-1.json', origin: null, savedAt: 1,
    text: f111('devices'), via: 'backups' }) };
  const b = await setup({ rig, ...HERE });
  const r2 = await b.ctl.importLatestBackup();
  assert.equal(r2.device.error, 'other machine');
  assert.equal(S(b.store).menuBarMode, false);
  ctl.dispose?.();
  b.ctl.dispose?.();
});

test('DS3: a block stored by 1.1.0 / pre-D11 2.0 (unknown field in rig.v1) never enters 2.0 state', () => {
  const lib = JSON.parse(fixture('v1.1.0', 'rich.localstorage.json'));
  lib.deviceSettings = DEV; // what 1.1.0 keeps after importing a 1.1.1 file
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify(lib));
  const s = makeStore({ storage });
  assert.equal(DEVICE_SETTINGS_KEY in s.get(), false, 'load');
  assert.equal(S(s).menuBarMode ?? false, lib.settings.menuBarMode ?? false, 'and nothing of it is applied');
  s.persistNow();
  assert.equal(DEVICE_SETTINGS_KEY in JSON.parse(storage.getItem(STORAGE_KEY)), false, 'saved without it');
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...JSON.parse(storage.getItem(STORAGE_KEY)), deviceSettings: DEV }));
  s.reload();
  assert.equal(DEVICE_SETTINGS_KEY in s.get(), false, 'reload');
  s.update((d) => ({ ...d, deviceSettings: DEV }));
  assert.equal(DEVICE_SETTINGS_KEY in s.get(), false, 'update');
  // a file still hands it over
  assert.deepEqual(s.importJSON(JSON.stringify(lib), { replace: true, dryRun: true }).deviceSettings, DEV);
});
