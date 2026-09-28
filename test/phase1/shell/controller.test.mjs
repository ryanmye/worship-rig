import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController, applyVelocitySens, LATENCY_MAP, KEY_MAP } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { FACTORY_SONGS } from '../../../app/js/presets.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, key, tick } from './helpers.mjs';

async function setup(opts = {}) {
  const store = opts.store || makeStore();
  const engine = opts.engine || fakeEngine(opts.engineOpts);
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {}; // skip init() in start()
  const doc = opts.doc || fakeDoc();
  const win = new EventTarget();
  const timers = fakeTimers();
  const warns = [];
  const ctl = createController({ store, engine, midi, recorder: opts.recorder || null, doc, nav: opts.nav || null, win, rig: opts.rig || null, timers, now: opts.now || (() => 0), ...opts.ctl });
  ctl.addEventListener('warn', (e) => warns.push(e.detail.message));
  const started = ctl.start();
  if (!opts.noAwait) await started;
  return { store, engine, midi, doc, win, timers, ctl, warns, started };
}

test('start(): engine.start then selectSong sequence: prepare → commit → transpose → routing → drone → tempo → preload', async () => {
  const { engine, store, ctl } = await setup();
  const song = store.currentSong();
  const names = engine.names();
  assert.equal(names[0], 'start');
  const seq = names.filter((n) => ['prepare', 'commit', 'setTranspose', 'setRouting', 'drone.configure', 'drone.setKey', 'setKeyContext', 'setTempo', 'preload'].includes(n));
  assert.deepEqual(seq.slice(0, 8), ['prepare', 'commit', 'setTranspose', 'setRouting', 'setKeyContext', 'drone.setKey', 'drone.configure', 'setTempo']);
  assert.equal(engine.of('prepare')[0][2], song.patch, 'prepare(song.patch)');
  assert.equal(engine.of('commit')[0][1], engine.of('prepare')[0][1], 'commit(token)');
  assert.deepEqual(engine.of('setRouting')[0][1], { modWheel: song.patch.modWheel, expression: song.patch.expression, volume: song.patch.volume, bend: song.patch.bend, swell: song.patch.swell });
  assert.deepEqual(engine.of('drone.setKey')[0].slice(1), [song.hearIn, { minor: false }]);
  assert.deepEqual(engine.of('drone.configure')[0][1], song.drone, 'mode + options + params');
  assert.equal(engine.of('drone.configure')[0][1].mode, 'synth');
  const preloads = engine.of('preload');
  assert.ok(preloads.some((c) => c[1].length === 1), 'neighbour preload (first song has only a next)');
  assert.ok(preloads.some((c) => c[1].length === FACTORY_SONGS.length && c[2] && c[2].pin === 'replace'), 'whole-setlist preload pins (replace)');
  assert.ok(preloads.some((c) => c[1].length === 1 && c[2] && c[2].pin === 'add'), 'neighbour preload adds pins');
  await tick();
  assert.equal(ctl.status.ready, true);
  assert.equal(ctl.status.loading, false);
  assert.equal(ctl.status.songId, song.id);
});

test('selectSong race: double-tap Next → only the latest commits; old keeps playing meanwhile', async () => {
  const { engine, store, ctl } = await setup({ engineOpts: { manual: true }, noAwait: true });
  await tick();
  engine.pending.shift().resolve(); // initial song
  await tick();
  engine.clear();
  const ids = store.navIds();
  const p1 = ctl.nextSong();
  const p2 = ctl.nextSong();
  assert.equal(store.get().settings.currentSongId, ids[2], 'selection moves immediately (UI shows loading)');
  assert.equal(ctl.status.loading, true);
  const [a, b] = engine.pending.splice(0);
  assert.equal(a.patch, store.getSong(ids[1]).patch);
  assert.equal(b.patch, store.getSong(ids[2]).patch);
  b.resolve(); // newer finishes first
  assert.equal(await p2, true);
  a.resolve(); // stale one finishes later → must not commit
  assert.equal(await p1, false);
  const commits = engine.of('commit');
  assert.equal(commits.length, 1);
  assert.equal(commits[0][1], b.token);
  assert.equal(ctl.status.loading, false);
  assert.equal(ctl._debug().appliedId, ids[2]);
});

test('prepare failure keeps the old song and reverts the selection', async () => {
  const { engine, store, ctl, warns } = await setup({ engineOpts: { manual: true }, noAwait: true });
  await tick();
  engine.pending.shift().resolve();
  await tick();
  const first = store.get().settings.currentSongId;
  const p = ctl.nextSong();
  engine.pending.shift().reject(new Error('decode failed'));
  assert.equal(await p, false);
  assert.equal(store.get().settings.currentSongId, first);
  assert.equal(engine.of('commit').length, 1);
  assert.ok(warns.some((w) => /decode failed/.test(w)));
});

test('edits made while a song is loading are applied right after commit', async () => {
  const { engine, store, ctl } = await setup({ engineOpts: { manual: true }, noAwait: true });
  await tick();
  engine.pending.shift().resolve();
  await tick();
  const p = ctl.nextSong();
  store.set('slots.0.gain', 0.33); // current song = the loading one
  await tick();
  engine.clear();
  engine.pending.shift().resolve();
  await p;
  const sp = engine.of('setParam').filter((c) => c[1] === 'slots.0.gain');
  assert.deepEqual(sp.map((c) => c[2]), [0.33]);
});

test('store → engine diffing: only changed params of the current song; entity edits ignored; instrument change → re-prepare', async () => {
  const { engine, store } = await setup();
  const ids = store.navIds();
  engine.clear();
  store.set('slots.1.gain', 0.4);
  store.set('fx.reverb.size', 0.8);
  store.set('master.volume', 0.3);
  store.set('slots.0.sends.reverb', 0.6);
  store.set('slots.0.params.tone', 0.2);
  store.set('drone.brightness', 0.9);
  store.set(`songs.${ids[3]}.patch.slots.0.gain`, 0.1); // not current
  store.set(`songs.${ids[0]}.name`, 'Renamed'); // entity only
  await tick();
  assert.deepEqual(engine.calls.map((c) => [c[0], c[1], c[2]]), [
    ['setParam', 'slots.0.sends.reverb', 0.6],
    ['setParam', 'slots.0.params.tone', 0.2],
    ['setParam', 'slots.1.gain', 0.4],
    ['setParam', 'fx.reverb.size', 0.8],
    ['setParam', 'master.volume', 0.3],
    ['setParam', 'drone.brightness', 0.9],
  ]);
  engine.clear();
  store.set('song.patch.bend.mode', 'pitch');
  store.set('song.hearIn', 2);
  store.set('song.tempo', 90);
  await tick();
  assert.deepEqual(engine.names(), ['setTranspose', 'setRouting', 'setKeyContext', 'drone.setKey', 'setTempo']);
  assert.equal(engine.of('setTranspose')[0][1], 2);
  engine.clear();
  store.set('song.drone.mode', 'off');
  await tick();
  assert.deepEqual(engine.names(), ['drone.configure']);
  assert.equal(engine.calls[0][1].mode, 'off');
  engine.clear();
  store.set('song.patch.slots.0.instrument', { type: 'sampler', id: 'ep-rhodes' });
  await tick();
  await tick();
  assert.deepEqual(engine.names().slice(0, 2), ['prepare', 'commit']);
  assert.equal(engine.of('prepare')[0][2].slots[0].instrument.id, 'ep-rhodes');
});

test('changing currentSongId from a view selects that song', async () => {
  const { engine, store } = await setup();
  const ids = store.navIds();
  engine.clear();
  store.set('settings.currentSongId', ids[4]);
  await tick();
  await tick();
  assert.equal(engine.of('commit').length, 1);
  assert.equal(engine.of('prepare')[0][2], store.getSong(ids[4]).patch);
});

test('MIDI perform: refcount, vel-0 off, sustain CC64 ≥ 64, pedal invert, bend, wheels, velocity sens', async () => {
  const { engine, store, midi } = await setup();
  engine.clear();
  midi._inject([0x90, 60, 127], 0, 'kb');
  midi._inject([0x90, 60, 127], 0, 'port2'); // same note from a second port
  midi._inject([0x90, 60, 100], 0, 'kb'); // duplicate from the same port
  midi._inject([0x80, 60, 0], 0, 'kb');
  midi._inject([0x90, 60, 0], 0, 'port2'); // vel-0 = off
  assert.deepEqual(engine.calls.map((c) => c.slice(0, 3)), [['noteOn', 60, 127], ['noteOff', 60]]);
  engine.clear();
  midi._inject([0xb0, 64, 63], 0, 'kb');
  midi._inject([0xb0, 64, 64], 0, 'kb');
  midi._inject([0xb0, 64, 127], 0, 'kb');
  midi._inject([0xb0, 64, 0], 0, 'kb');
  assert.deepEqual(engine.calls, [['sustain', true], ['sustain', false]]);
  engine.clear();
  store.set('settings.pedalInvert', true);
  midi._inject([0xb0, 64, 0], 0, 'kb');
  midi._inject([0xb0, 64, 127], 0, 'kb');
  assert.deepEqual(engine.calls, [['sustain', true], ['sustain', false]]);
  engine.clear();
  midi._inject([0xe0, 0x7f, 0x7f]);
  midi._inject([0xb0, 1, 127]);
  midi._inject([0xb0, 11, 0]);
  midi._inject([0xb0, 7, 64]);
  assert.deepEqual(engine.calls, [['pitchBend', 1], ['modWheel', 1], ['expression', 0], ['volumeCC', 64 / 127]]);
  engine.clear();
  store.set('settings.velocitySens', 'fixed');
  midi._inject([0x90, 62, 20]);
  assert.deepEqual(engine.calls[0], ['noteOn', 62, 100]);
  assert.equal(applyVelocitySens(64, 'soft') > 64, true);
  assert.equal(applyVelocitySens(64, 'hard') < 64, true);
  assert.equal(applyVelocitySens(0, 'normal'), 1);
});

test('hot-plug: disconnect releases that input’s notes and pedal only', async () => {
  const { engine, midi } = await setup();
  midi._inject([0x90, 60, 100], 0, 'kb');
  midi._inject([0x90, 64, 100], 0, 'kb');
  midi._inject([0x90, 67, 100], 0, 'pads');
  midi._inject([0xb0, 64, 127], 0, 'kb');
  engine.clear();
  midi.dispatchEvent(new CustomEvent('disconnected', { detail: { inputId: 'kb', name: 'Keys' } }));
  assert.deepEqual(engine.calls, [['noteOff', 60], ['noteOff', 64], ['sustain', false]]);
});

test('learned controls: button on CC ≥ 64 (edge), note-mapped button, fader pickup, program change gating', async () => {
  const { engine, store, midi, ctl } = await setup();
  const ids = store.navIds();
  store.setMidiLearn('nextSong', { cc: 80, channel: 0 });
  store.setMidiLearn('panic', { note: 36, channel: 9 });
  store.setMidiLearn('slots.1.gain', { cc: 20, channel: null });
  store.setMidiLearn('swell', { cc: 81, channel: 0 });
  engine.clear();
  midi._inject([0xb0, 80, 127]);
  midi._inject([0xb0, 80, 127]); // held — no repeat
  await tick();
  await tick();
  assert.equal(store.get().settings.currentSongId, ids[1]);
  midi._inject([0xb0, 80, 0]);
  midi._inject([0xb0, 80, 100]);
  await tick();
  await tick();
  assert.equal(store.get().settings.currentSongId, ids[2]);
  engine.clear();
  midi._inject([0x99, 36, 100]);
  assert.deepEqual(engine.names(), ['allNotesOff'], 'note-mapped panic does not play a note');
  engine.clear();
  midi._inject([0xb0, 81, 127]);
  midi._inject([0xb0, 81, 0]);
  assert.deepEqual(engine.calls, [['swell', true], ['swell', false]]);
  // fader pickup: stored gain → position; hardware ignored until it crosses
  store.set('slots.1.gain', 0.25); // position = cbrt(0.125) = 0.5
  await tick();
  const g = () => store.currentSong().patch.slots[1].gain;
  midi._inject([0xb0, 20, 0]); // 0.0 — far below
  midi._inject([0xb0, 20, 25]); // 0.197 — still below
  assert.equal(g(), 0.25);
  midi._inject([0xb0, 20, 90]); // 0.709 — crossed 0.5 → picked up
  assert.ok(Math.abs(g() - 2 * (90 / 127) ** 3) < 1e-9);
  midi._inject([0xb0, 20, 100]);
  assert.ok(Math.abs(g() - 2 * (100 / 127) ** 3) < 1e-9);
  store.set('slots.1.gain', 0.02); // moved on screen → pickup resets
  midi._inject([0xb0, 20, 101]);
  assert.equal(g(), 0.02);
  // program change gating
  const before = store.get().settings.currentSongId;
  midi._inject([0xc0, 5]);
  await tick();
  assert.equal(store.get().settings.currentSongId, before, 'ignored when disabled');
  store.set('settings.programChange', true);
  midi._inject([0xc0, 5]);
  await tick();
  await tick();
  assert.equal(store.get().settings.currentSongId, ids[5]);
  assert.equal(ctl.status.songId, ids[5]);
});

test('computer keyboard: notes C4..E5, z/x octave, repeat ignored, focus rules, space sustain, blur releases', async () => {
  const { engine, store, doc, win, ctl } = await setup();
  const ids = store.navIds();
  engine.clear();
  key(doc, 'keydown', { code: 'KeyA' });
  key(doc, 'keydown', { code: 'KeyA', repeat: true });
  key(doc, 'keyup', { code: 'KeyA' });
  key(doc, 'keydown', { code: 'Semicolon' });
  key(doc, 'keyup', { code: 'Semicolon' });
  assert.deepEqual(engine.calls, [['noteOn', 60, 100], ['noteOff', 60], ['noteOn', 76, 100], ['noteOff', 76]]);
  assert.equal(Object.keys(KEY_MAP).length, 17);
  engine.clear();
  key(doc, 'keydown', { code: 'KeyX' });
  key(doc, 'keydown', { code: 'KeyA' });
  key(doc, 'keydown', { code: 'KeyZ' });
  key(doc, 'keydown', { code: 'KeyZ' });
  key(doc, 'keyup', { code: 'KeyA' }); // released at the pitch it started
  assert.deepEqual(engine.calls, [['noteOn', 72, 100], ['noteOff', 72]]);
  assert.equal(ctl.kbOctave, -1);
  key(doc, 'keydown', { code: 'KeyX' });
  // focus in a text field / range → no notes, no song keys
  engine.clear();
  doc.activeElement = { tagName: 'INPUT', type: 'text' };
  key(doc, 'keydown', { code: 'KeyA' });
  key(doc, 'keydown', { code: 'ArrowRight' });
  doc.activeElement = { tagName: 'INPUT', type: 'range' };
  key(doc, 'keydown', { code: 'ArrowLeft' });
  doc.activeElement = { tagName: 'TEXTAREA' };
  key(doc, 'keydown', { code: 'Space' });
  assert.deepEqual(engine.calls, []);
  assert.equal(store.get().settings.currentSongId, ids[0]);
  // button focused: notes OK, arrows and space are the button's
  doc.activeElement = { tagName: 'BUTTON' };
  key(doc, 'keydown', { code: 'ArrowRight' });
  key(doc, 'keydown', { code: 'Space' });
  key(doc, 'keydown', { code: 'KeyS' });
  assert.deepEqual(engine.calls, [['noteOn', 62, 100]]);
  key(doc, 'keyup', { code: 'KeyS' });
  // nothing focused: arrows change songs, space = sustain
  doc.activeElement = doc.body;
  engine.clear();
  const ev = key(doc, 'keydown', { code: 'Space' });
  assert.equal(ev.defaultPrevented, true);
  key(doc, 'keydown', { code: 'Space', repeat: true });
  key(doc, 'keyup', { code: 'Space' });
  assert.deepEqual(engine.calls, [['sustain', true], ['sustain', false]]);
  key(doc, 'keydown', { code: 'ArrowRight' });
  await tick();
  await tick();
  assert.equal(store.get().settings.currentSongId, ids[1]);
  key(doc, 'keydown', { code: 'ArrowLeft', metaKey: true });
  await tick();
  await tick();
  assert.equal(store.get().settings.currentSongId, ids[0]);
  // computerKeyboard off → no notes but shortcuts still work
  store.set('settings.computerKeyboard', false);
  engine.clear();
  key(doc, 'keydown', { code: 'KeyA' });
  assert.deepEqual(engine.calls, []);
  store.set('settings.computerKeyboard', true);
  // blur releases held keys
  key(doc, 'keydown', { code: 'KeyD' });
  key(doc, 'keydown', { code: 'Space' });
  engine.clear();
  win.dispatchEvent(new Event('blur'));
  assert.deepEqual(engine.calls, [['noteOff', 64], ['sustain', false]]);
  // a view that already handled the key (preventDefault) wins
  engine.clear();
  const pre = new Event('keydown', { cancelable: true });
  Object.assign(pre, { code: 'KeyA', key: 'a', repeat: false });
  pre.preventDefault();
  doc.dispatchEvent(pre);
  assert.deepEqual(engine.calls, []);
});

test('virtual wheel ↑/↓, Shift+↑ swell toggle, Esc panic, Chrome ⌘ shortcuts (not in Electron)', async () => {
  const { engine, doc, store } = await setup();
  engine.clear();
  key(doc, 'keydown', { code: 'ArrowDown' });
  key(doc, 'keydown', { code: 'ArrowDown' });
  key(doc, 'keydown', { code: 'ArrowUp' });
  assert.deepEqual(engine.calls.map((c) => c[2]), [0.9, 0.8, 0.9]);
  assert.ok(engine.calls.every((c) => c[0] === 'setWheel' && c[1] === 'virtual'));
  engine.clear();
  key(doc, 'keydown', { code: 'ArrowUp', shiftKey: true });
  key(doc, 'keydown', { code: 'ArrowUp', shiftKey: true });
  key(doc, 'keydown', { code: 'Escape' });
  assert.deepEqual(engine.calls, [['swell', true], ['swell', false], ['allNotesOff']]);
  engine.clear();
  key(doc, 'keydown', { code: 'Period', key: '.', metaKey: true });
  key(doc, 'keydown', { code: 'KeyE', key: 'e', metaKey: true });
  key(doc, 'keydown', { code: 'KeyF', key: 'F', metaKey: true, shiftKey: true });
  assert.deepEqual(engine.names(), ['allNotesOff', 'fadeOutAll']);
  assert.equal(store.get().settings.view, 'edit');
  // Electron: the app menu owns these accelerators
  const e2 = await setup({ rig: { isElectron: true, onMenu: () => () => {} } });
  e2.engine.clear();
  key(e2.doc, 'keydown', { code: 'Period', key: '.', metaKey: true });
  assert.deepEqual(e2.engine.calls, []);
});

test('transpose up/down steps through the tritone without an octave jump; drone follows Hear-In', async () => {
  const { engine, store, ctl } = await setup();
  store.set('song.playIn', 0);
  store.set('song.hearIn', 5); // +5
  await tick();
  engine.clear();
  assert.equal(ctl.transposeUp(), true); // +6 → hear F#, octave 0 gives −6, so octave becomes +1
  await tick();
  assert.equal(store.currentSong().hearIn, 6);
  assert.equal(store.currentSong().transposeOctave, 1);
  assert.deepEqual(engine.of('setTranspose').map((c) => c[1]), [6]);
  assert.deepEqual(engine.of('drone.setKey').map((c) => c.slice(1)), [[6, { minor: false }]]);
  ctl.transposeDown();
  ctl.transposeDown();
  await tick();
  assert.equal(engine.of('setTranspose').at(-1)[1], 4);
});

test('panic / fadeOutAll / toggleView / swell / menu wiring', async () => {
  let menuCb = null;
  const rig = { isElectron: true, onMenu: (cb) => ((menuCb = cb), () => (menuCb = null)) };
  const { engine, store, ctl, midi } = await setup({ rig });
  midi._inject([0x90, 60, 100], 0, 'kb');
  engine.clear();
  ctl.panic();
  midi._inject([0x80, 60, 0], 0, 'kb'); // after panic the note-off is a no-op
  assert.deepEqual(engine.calls, [['allNotesOff']]);
  engine.clear();
  menuCb('fadeOutAll');
  assert.deepEqual(engine.calls, [['fadeOutAll', 6]]);
  menuCb('toggleView');
  assert.equal(store.get().settings.view, 'edit');
  menuCb('nextSong');
  await tick();
  await tick();
  assert.equal(store.get().settings.currentSongId, store.navIds()[1]);
  let other = null;
  ctl.addEventListener('menu', (e) => (other = e.detail.id));
  menuCb('openSettings');
  assert.equal(other, 'openSettings');
  ctl.dispose();
  assert.equal(menuCb, null, 'unsubscribed on dispose');
});

test('watchdog: advancing clock = running; frozen clock → stalled → auto restart (latency/sink from settings); suspended → resume', async () => {
  let t = 0;
  const { engine, timers, ctl, store } = await setup({ now: () => t });
  store.set('settings.latency', 'safe');
  await tick();
  engine.clear();
  const statuses = [];
  ctl.addEventListener('status', (e) => statuses.push(e.detail.audio));
  engine.ctx.currentTime = 1;
  timers.runIntervals();
  assert.equal(ctl.status.audio, 'running');
  timers.runIntervals(); // no advance (1)
  timers.runIntervals(); // no advance (2) → stalled
  t = 20000;
  await tick();
  assert.ok(statuses.includes('stalled'));
  const restarts = engine.of('restart');
  assert.equal(restarts.length, 1);
  assert.deepEqual(restarts[0][1], { latency: LATENCY_MAP.safe, sinkId: undefined });
  await tick();
  assert.equal(ctl.status.audio, 'running');
  // suspended → resume attempts, no restart before the context ever ran again? (it ran before → restart after 3 ticks)
  engine.clear();
  engine.ctx.state = 'suspended';
  timers.runIntervals();
  assert.equal(ctl.status.audio, 'suspended');
  assert.deepEqual(engine.names(), ['ctx.resume']);
});

test('watchdog never auto-restarts a context that has not started yet (Chrome click-to-start)', async () => {
  const engine = fakeEngine();
  engine.ctx.state = 'suspended';
  const { timers, ctl } = await setup({ engine });
  for (let i = 0; i < 5; i++) timers.runIntervals();
  assert.equal(ctl.status.audio, 'suspended');
  assert.equal(engine.of('restart').length, 0);
  assert.equal(engine.of('ctx.resume').length >= 5, true);
});

test('settings reactions: mono, output device, MIDI input, latency → restart', async () => {
  const { engine, store, midi } = await setup();
  let selected = null;
  midi.select = (s) => (selected = s);
  engine.clear();
  store.set('settings.monoOutput', true);
  store.set('settings.outputDeviceId', 'usb-1');
  store.set('settings.midiInputId', 'all');
  await tick();
  assert.deepEqual(engine.calls, [['setMono', true], ['setSinkId', 'usb-1']]);
  assert.equal(selected, 'all');
  engine.clear();
  store.set('settings.latency', 'balanced');
  await tick();
  assert.deepEqual(engine.of('restart')[0][1], { latency: 0.01, sinkId: 'usb-1' });
});

test('recording is stopped before an audio restart; record() toggles the recorder', async () => {
  const rec = new EventTarget();
  const log = [];
  rec.isRecording = false;
  rec.toggle = async () => { rec.isRecording = !rec.isRecording; log.push(rec.isRecording ? 'start' : 'stop'); rec.dispatchEvent(new CustomEvent('state', { detail: { state: rec.isRecording ? 'recording' : 'idle' } })); };
  rec.stop = async () => { rec.isRecording = false; log.push('stop'); };
  const { ctl } = await setup({ recorder: rec });
  await ctl.record();
  assert.equal(ctl.status.recording, true);
  await ctl.restartAudio();
  assert.deepEqual(log, ['start', 'stop']);
});

test('Electron auto-backup of the library via rig.backupNow', async () => {
  const backups = [];
  const rig = { isElectron: true, onMenu: () => () => {}, backupNow: async (json) => (backups.push(JSON.parse(json)), { path: '/x' }) };
  const { timers, store } = await setup({ rig });
  timers.runTimeouts();
  await tick();
  assert.equal(backups.length, 0, 'an untouched factory seed is not backed up (round2-shell #2)');
  store.set(`songs.${store.navIds()[0]}.name`, 'Changed');
  await tick();
  timers.runTimeouts();
  await tick();
  assert.equal(backups.length, 1);
  assert.equal(backups[0].app, 'worship-rig');
  assert.equal(backups[0].songs[store.navIds()[0]].name, 'Changed');
});

test('missing engine methods degrade to a single warning (no throw)', async () => {
  const engine = fakeEngine();
  delete engine.drone;
  delete engine.setTempo;
  const { warns, ctl } = await setup({ engine });
  await ctl.nextSong();
  assert.equal(warns.filter((w) => /setTempo/.test(w)).length, 1);
  assert.equal(warns.filter((w) => /drone.setKey/.test(w)).length, 1);
});

test('pad folder (Electron): listed at start, attached to the drone, unmatched names reported, re-attached after restart', async () => {
  const pads = [{ name: 'Pad - C.mp3', url: '/pads/t/Pad%20-%20C.mp3' }, { name: 'F#m Pad.wav', url: '/pads/t/F%23m.wav' }, { name: 'random.mp3', url: '/pads/t/random.mp3' }];
  let listResult = pads;
  const rig = { isElectron: true, onMenu: () => () => {}, listPads: async () => listResult };
  const infos = [];
  const store = makeStore();
  const engine = fakeEngine();
  const ctlP = setup({ rig, store, engine, noAwait: true });
  const { ctl, warns } = await ctlP;
  ctl.addEventListener('pads', (e) => infos.push(e.detail));
  await ctlP.then((x) => x.started);
  const attachIdx = engine.names().indexOf('drone.attachFiles');
  assert.ok(attachIdx >= 0 && attachIdx < engine.names().indexOf('prepare'), 'pads attached before the first song');
  engine.clear();
  await ctl.restartAudio();
  assert.deepEqual(engine.of('drone.attachFiles')[0][1], pads);
  listResult = { error: 'missing' };
  const r = await ctl.reloadPads();
  assert.deepEqual(r, { error: 'missing' });
  assert.ok(warns.some((w) => /Pad folder not found/.test(w)));
  const info = ctl.attachPads(pads);
  assert.deepEqual(info, { count: 2, total: 3, unmatched: ['random.mp3'] });
  assert.deepEqual(infos.at(-1), info);
});

test('engine warn/chord/notes events are re-emitted by the controller', async () => {
  const { engine, ctl } = await setup();
  const got = [];
  ctl.addEventListener('warn', (e) => got.push(['warn', e.detail.message]));
  ctl.addEventListener('chord', (e) => got.push(['chord', e.detail.chord]));
  engine.dispatchEvent(new CustomEvent('warn', { detail: { message: 'sample missing' } }));
  engine.dispatchEvent(new CustomEvent('chord', { detail: { chord: { name: 'G' } } }));
  assert.deepEqual(got, [['warn', 'sample missing'], ['chord', { name: 'G' }]]);
});
