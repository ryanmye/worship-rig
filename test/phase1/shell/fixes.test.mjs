// Shell review fixes (reviews/shell.md H1–L10, ui-core/ui-edit findings): one test (or more) per item.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createStore, memoryStorage, migrate, STORAGE_KEY, BACKUPS_KEEP, PERSIST_RETRY_MS } from '../../../app/js/store.js';
import { createController, SECONDARY_MESSAGE } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { FACTORY_SONGS } from '../../../app/js/presets.js';
import { ElectronSink, MemorySink, Recorder } from '../../../app/js/recorder.js';
import { shouldOpenWindow } from '../../../serve.mjs';
import { makeStore, idGen, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { createServer, CSP } = require('../../../server.js');

// ------------------------------------------------------------------------------------------------ helpers
function quotaError() {
  const e = new Error('The quota has been exceeded.');
  e.name = 'QuotaExceededError';
  return e;
}
const backupKeysOf = (st) => st.keys().filter((k) => k.startsWith(`${STORAGE_KEY}.backup-`));

async function setup(opts = {}) {
  const store = opts.store || makeStore();
  const engine = opts.engine || fakeEngine(opts.engineOpts);
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const doc = fakeDoc();
  const timers = opts.timers || fakeTimers();
  const warns = [];
  const ctl = createController({ store, engine, midi, recorder: opts.recorder || null, doc, nav: null, win: new EventTarget(), rig: opts.rig || null, timers, now: () => 0, locks: opts.locks ?? null, heartbeat: false, indexedDB: opts.indexedDB ?? null, ...opts.ctl });
  ctl.addEventListener('warn', (e) => warns.push(e.detail.message));
  const started = ctl.start();
  if (!opts.noAwait) await started;
  return { store, engine, midi, ctl, warns, timers, started };
}
const inject = (midi, bytes, input = 'kbd') => midi._inject(bytes, 0, input);

/** Minimal Web Locks (exclusive, ifAvailable, FIFO waiters). */
function fakeLocks() {
  let held = false;
  const queue = [];
  const grant = (cb, resolve) => {
    held = true;
    Promise.resolve(cb({ name: 'rig-instance' })).then((v) => {
      held = false;
      resolve(v);
      const next = queue.shift();
      if (next) grant(next.cb, next.resolve);
    });
  };
  return {
    get held() {
      return held;
    },
    request(name, opts, cb) {
      return new Promise((resolve) => {
        if (!held) grant(cb, resolve);
        else if (opts && opts.ifAvailable) Promise.resolve(cb(null)).then(resolve);
        else queue.push({ cb, resolve });
      });
    },
  };
}

// ================================================================================================= H1
test('H1: corrupt library + failing backup write → the raw library is never overwritten; read-only until allowOverwrite()', () => {
  const st = memoryStorage({ [STORAGE_KEY]: '{"schema":1,"songs":{BROKEN' });
  const setItem = st.setItem;
  st.setItem = (k, v) => {
    if (k.includes('.backup-')) throw quotaError();
    return setItem(k, v);
  };
  const warns = [];
  const s = createStore({ storage: st, idGen: idGen(), requestIdle: null, warn: (m) => warns.push(m), autoFlush: false, debounceMs: 0 });
  assert.equal(s.loadInfo.status, 'corrupt');
  assert.equal(s.loadInfo.readOnly, true);
  assert.equal(s.loadInfo.readOnlyReason, 'backup-failed');
  assert.match(s.loadInfo.backupError, /quota/);
  assert.equal(s.get().songOrder.length, FACTORY_SONGS.length, 'factory songs in memory');
  assert.equal(s.persistNow(), false);
  assert.equal(st.getItem(STORAGE_KEY), '{"schema":1,"songs":{BROKEN', 'original untouched');
  assert.ok(warns.some((w) => /NOT saved/.test(w)));
  assert.equal(s.unreadableRaw(), '{"schema":1,"songs":{BROKEN');
  // user exported / Electron disk backup succeeded → saving resumes
  assert.equal(s.allowOverwrite(), true);
  assert.equal(s.persistNow(), true);
  assert.equal(JSON.parse(st.getItem(STORAGE_KEY)).songOrder.length, FACTORY_SONGS.length);
});

test('H1: future-schema library with a failing backup is kept too', () => {
  const raw = JSON.stringify({ schema: 2, songs: {} });
  const st = memoryStorage({ [STORAGE_KEY]: raw });
  const setItem = st.setItem;
  st.setItem = (k, v) => (k.includes('.backup-') ? (() => { throw quotaError(); })() : setItem(k, v));
  const s = createStore({ storage: st, idGen: idGen(), requestIdle: null, warn: () => {}, autoFlush: false });
  assert.equal(s.loadInfo.status, 'future-schema');
  s.set('settings.view', 'edit');
  s.persistNow();
  assert.equal(st.getItem(STORAGE_KEY), raw);
});

test(`H1: backup keys are capped at ${BACKUPS_KEEP}; on quota the oldest are pruned and the write retried`, () => {
  const init = { [STORAGE_KEY]: 'garbage' };
  for (const t of [1, 2, 3, 4, 5]) init[`${STORAGE_KEY}.backup-${t}`] = `old${t}`;
  const st = memoryStorage(init);
  const setItem = st.setItem;
  st.setItem = (k, v) => {
    if (k.includes('.backup-') && backupKeysOf(st).length > 2) throw quotaError(); // room for only 3
    return setItem(k, v);
  };
  const s = createStore({ storage: st, idGen: idGen(), requestIdle: null, warn: () => {}, autoFlush: false, now: () => 100 });
  assert.equal(s.loadInfo.status, 'corrupt');
  assert.equal(s.loadInfo.readOnly, false, 'backup succeeded after pruning');
  assert.deepEqual(backupKeysOf(st).sort(), [`${STORAGE_KEY}.backup-100`, `${STORAGE_KEY}.backup-4`, `${STORAGE_KEY}.backup-5`].sort());
  assert.equal(st.getItem(`${STORAGE_KEY}.backup-100`), 'garbage');
});

test('H1 (Electron): the controller saves the unreadable raw library to disk and then allows saving', async () => {
  const st = memoryStorage({ [STORAGE_KEY]: 'not json' });
  const setItem = st.setItem;
  st.setItem = (k, v) => (k.includes('.backup-') ? (() => { throw quotaError(); })() : setItem(k, v));
  const store = createStore({ storage: st, idGen: idGen(), requestIdle: null, warn: () => {}, autoFlush: false });
  const disk = [];
  const rig = { isElectron: true, onMenu: () => () => {}, backupNow: async (text, kind) => (disk.push([kind, text]), { path: '/backups/rig-unreadable-1.json' }) };
  const { ctl, warns } = await setup({ store, rig });
  await tick();
  assert.deepEqual(disk[0], ['unreadable', 'not json']);
  assert.equal(store.loadInfo.readOnly, false);
  assert.equal(ctl.status.library.readOnly, false);
  assert.ok(warns.some((w) => /rig-unreadable-1\.json/.test(w)));
});

// ================================================================================================= M7
test('M7: a failed save is retried with backoff (1 s, 5 s, 30 s) without further edits; onInfo reports it', () => {
  const st = memoryStorage();
  let failing = 2;
  const setItem = st.setItem;
  st.setItem = (k, v) => {
    if (k === STORAGE_KEY && failing > 0) {
      failing -= 1;
      throw quotaError();
    }
    return setItem(k, v);
  };
  const timers = fakeTimers();
  const s = createStore({ storage: st, idGen: idGen(), requestIdle: null, warn: () => {}, autoFlush: false, timers, debounceMs: 300 });
  const infos = [];
  s.onInfo((i) => infos.push(i.persistError));
  timers.runTimeouts(); // debounce → first save fails
  assert.equal(st.getItem(STORAGE_KEY), null);
  assert.deepEqual([...timers.timeouts.values()].map((t) => t.ms), [PERSIST_RETRY_MS[0]]);
  timers.runTimeouts(); // 1 s retry fails
  assert.deepEqual([...timers.timeouts.values()].map((t) => t.ms), [PERSIST_RETRY_MS[1]]);
  timers.runTimeouts(); // 5 s retry succeeds
  assert.ok(st.getItem(STORAGE_KEY), 'saved with no new edit');
  assert.equal(s.loadInfo.persistError, null);
  assert.equal(timers.timeouts.size, 0);
  assert.equal(infos.at(-1), null);
  assert.ok(infos.some((x) => /quota/.test(x)));
});

test('M7: the controller turns a save failure into one warning', async () => {
  const st = memoryStorage();
  const setItem = st.setItem;
  let fail = true;
  st.setItem = (k, v) => (k === STORAGE_KEY && fail ? (() => { throw quotaError(); })() : setItem(k, v));
  const timers = fakeTimers();
  const store = createStore({ storage: st, idGen: idGen(), requestIdle: null, warn: () => {}, autoFlush: false, timers });
  const { warns, ctl } = await setup({ store, timers: fakeTimers() });
  store.persistNow();
  store.persistNow();
  assert.equal(warns.filter((w) => /could not be saved/.test(w)).length, 1);
  assert.match(ctl.status.library.persistError, /quota/);
  fail = false;
  store.persistNow();
  assert.equal(ctl.status.library.persistError, null);
});

// ================================================================================================= L1 / L2
test('L1: numeric params reject NaN/Infinity/strings/null/objects/arrays; bools and enums keep coercion', () => {
  const s = makeStore();
  const before = s.get().songs[s.get().settings.currentSongId].patch.slots[1].gain;
  for (const bad of [NaN, 'abc', '', {}, null, Infinity, -Infinity, [], '0.5']) assert.equal(s.set('slots.1.gain', bad), false, String(bad));
  assert.equal(s.currentSong().patch.slots[1].gain, before);
  assert.equal(s.set('slots.1.gain', 5), true, 'finite numbers are clamped');
  assert.equal(s.currentSong().patch.slots[1].gain, 2);
  assert.equal(s.set('slots.0.params.tone', Infinity), false);
  assert.equal(s.set('slots.0.params.tone', 0.4), true);
  assert.equal(s.set('fx.reverb.size', NaN), false);
  assert.equal(s.set('drone.gain', 'loud'), false);
  assert.equal(s.set('song.patch.modWheel.min', '0.2'), false);
  assert.equal(s.set('song.patch.swell.seconds', Infinity), false);
  assert.equal(s.set('slots.0.sustain', 0), true, 'bool coercion unchanged');
  assert.equal(s.currentSong().patch.slots[0].sustain, false);
});

test('L2: Object.prototype keys are rejected (no throw); __proto__ ids skipped; duplicate array ids both imported', () => {
  const s = makeStore();
  assert.equal(s.set('settings.hasOwnProperty', 1), false);
  assert.equal(s.set('settings.toString', 5), false);
  assert.equal(s.set('settings.__proto__', { polluted: true }), false);
  assert.equal(s.set('songs.__proto__.name', 'x'), false);
  assert.equal(String(s.get().settings), '[object Object]');
  assert.equal({}.polluted, undefined);
  const song = { name: 'A', patch: { slots: [] } };
  const r = s.importJSON(`{"schema":1,"songs":{"__proto__":{"name":"Evil","patch":{}},"ok1":{"name":"Fine","patch":{}}}}`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.songIds.map((id) => s.getSong(id).name), ['Fine']);
  const r2 = s.importJSON(JSON.stringify([{ ...song, id: 'same', name: 'One' }, { ...song, id: 'same', name: 'Two' }]));
  assert.deepEqual(r2.songIds.map((id) => s.getSong(id).name), ['One', 'Two']);
  assert.equal(s.setMidiLearn('constructor', { cc: 20, channel: 0 }), false);
  assert.equal(migrate({ songs: [{ id: 'x', name: 'a' }, { id: 'x', name: 'b' }] }).songOrder.length, 2);
});

// ================================================================================================= mute / aliases
test('slot mute: first-class muted + gainBeforeMute; ui-core mutedGain sequence stays compatible; persisted', () => {
  const storage = memoryStorage();
  const s = makeStore({ storage });
  const id = s.get().settings.currentSongId;
  const slot = () => s.getSong(id).patch.slots[1];
  const g0 = slot().gain;
  assert.equal(slot().muted, undefined, 'unmuted slots carry no mute fields');
  assert.equal(s.set('slots.1.muted', true), true);
  assert.deepEqual([slot().muted, slot().gain, slot().gainBeforeMute, slot().mutedGain], [true, 0, g0, g0]);
  assert.equal(s.set('slots.1.muted', false), true);
  assert.equal(slot().gain, g0);
  assert.equal(slot().gainBeforeMute, undefined);
  // perform.js: mute = mutedGain ← gain, then gain ← 0; unmute = delete mutedGain, then gain ← mutedGain
  s.set(`songs.${id}.patch.slots.1.mutedGain`, slot().gain);
  s.set(`songs.${id}.patch.slots.1.gain`, 0);
  assert.equal(slot().muted, true);
  assert.equal(slot().gainBeforeMute, g0);
  s.persistNow();
  const s2 = makeStore({ storage });
  assert.equal(s2.getSong(id).patch.slots[1].muted, true, 'persisted');
  const g = slot().mutedGain;
  s.set(`songs.${id}.patch.slots.1.mutedGain`, undefined);
  s.set(`songs.${id}.patch.slots.1.gain`, g);
  assert.equal(slot().muted, undefined);
  assert.equal(slot().gain, g0);
  // moving a fader on a muted slot unmutes it
  s.set('slots.1.muted', true);
  s.set('slots.1.gain', 0.5);
  assert.equal(slot().muted, undefined);
  assert.equal(slot().gain, 0.5);
  // old data: gain 0 + mutedGain → muted
  const m = migrate({ songs: { a: { name: 'a', patch: { slots: [null, { instrument: { type: 'synth', id: 'warm-pad' }, gain: 0, mutedGain: 0.7 }] } } } });
  assert.equal(m.songs.a.patch.slots[1].muted, true);
  assert.equal(m.songs.a.patch.slots[1].gainBeforeMute, 0.7);
});

test('store aliases: slots.<i>.instrument / slots.<i> resolve to the current song', () => {
  const s = makeStore();
  const id = s.get().settings.currentSongId;
  assert.equal(s.set('slots.0.instrument', { type: 'synth', id: 'strings' }), true);
  assert.deepEqual(s.getSong(id).patch.slots[0].instrument, { type: 'synth', id: 'strings' });
  assert.equal(s.set('slots.2', null), false, 'already empty');
  assert.equal(s.set('slots.0', null), true);
  assert.equal(s.getSong(id).patch.slots[0], null);
  assert.equal(s.set('slots.9.instrument', { type: 'synth', id: 'strings' }), false);
});

// ================================================================================================= M4
function setlistStore(ids) {
  const s = makeStore();
  const slId = s.get().settings.currentSetlistId;
  s.set(`setlists.${slId}.songIds`, ids(s.get().songOrder));
  return { s, slId, lib: s.get().songOrder };
}

test('M4: removing the current entry → Next goes to the song that followed it, Prev to the one before', () => {
  const { s, slId, lib } = setlistStore((o) => o.slice(0, 8));
  s.selectSongId(lib[4], 4);
  s.removeFromSetlist(slId, 4);
  assert.equal(s.get().settings.currentSongId, lib[4], 'still playing');
  assert.equal(s.currentIndex(), -1);
  assert.equal(s.neighbors().next.id, lib[5]);
  assert.equal(s.neighbors().prev.id, lib[3]);
  s.removeFromSetlist(slId, 0); // an edit before the gap shifts it
  assert.equal(s.neighbors().next.id, lib[5]);
  s.selectSongId(lib[5], s.neighbors().next.index);
  assert.equal(s.get().settings.setlistGap, false);
  assert.equal(s.neighbors().next.id, lib[6]);
});

test('M4: reprise position survives moves, adds and duplicates of other entries', () => {
  const { s, slId, lib } = setlistStore((o) => [o[0], o[1], o[2], o[3], o[4], o[0], o[5]]);
  s.selectSongId(lib[0], 5);
  s.moveSong(slId, 1, 3);
  assert.equal(s.currentIndex(), 5);
  assert.equal(s.next(), lib[5]);
  s.moveSong(slId, 6, 0); // move the last entry to the top (crosses the current one)
  assert.equal(s.currentIndex(), 6);
  s.addToSetlist(slId, lib[7], 0);
  assert.equal(s.currentIndex(), 7);
  s.duplicateSong(lib[0]); // inserted after the CURRENT entry
  const ids = s.currentSetlist().songIds;
  assert.equal(s.currentIndex(), 7);
  assert.equal(s.getSong(ids[8]).name, `${s.getSong(lib[0]).name} (copy)`);
  s.moveSong(slId, 7, 2); // move the current entry itself
  assert.equal(s.currentIndex(), 2);
  assert.equal(s.get().settings.currentSongId, lib[0]);
});

test('M4: deleting the current song selects the one that followed it at the right position (reprise)', () => {
  const { s, lib } = setlistStore((o) => [o[0], o[1], o[2], o[0], o[3]]);
  s.selectSongId(lib[2], 2);
  s.deleteSong(lib[1]);
  assert.equal(s.currentIndex(), 1);
  s.selectSongId(lib[0], 2);
  s.deleteSong(lib[0]); // removes entries 0 and 2 → current becomes lib[3] at index 1
  assert.equal(s.get().settings.currentSongId, lib[3]);
  assert.equal(s.currentIndex(), 1);
});

test('M4: a failed load reverts to the exact setlist entry (reprise), not the first occurrence', async () => {
  const store = makeStore();
  const slId = store.get().settings.currentSetlistId;
  const lib = store.get().songOrder;
  store.set(`setlists.${slId}.songIds`, [lib[0], lib[1], lib[2], lib[0], lib[3]]);
  const { engine, ctl } = await setup({ store, engineOpts: { manual: true }, noAwait: true });
  await tick();
  engine.pending.shift().resolve();
  await tick();
  const p = ctl.selectSong(lib[0], { index: 3 });
  engine.pending.shift().resolve();
  await p;
  assert.equal(store.currentIndex(), 3);
  const n = ctl.nextSong();
  engine.pending.shift().reject(new Error('decode failed'));
  assert.equal(await n, false);
  assert.equal(store.currentIndex(), 3, 'back at the reprise, not index 0');
  assert.equal(store.next(), lib[3]);
});

// ================================================================================================= M3 / L9
test('M3: notes are refcounted per (input, channel, note): a layered second channel keeps sounding', async () => {
  const { engine, midi } = await setup();
  engine.clear();
  inject(midi, [0x90, 60, 100]);
  inject(midi, [0x91, 60, 100]);
  inject(midi, [0x80, 60, 0]);
  assert.equal(engine.of('noteOff').length, 0, 'ch2 still holds 60');
  inject(midi, [0x81, 60, 0]);
  assert.deepEqual(engine.of('noteOff').map((c) => c[1]), [60]);
  inject(midi, [0x90, 62, 100]);
  inject(midi, [0x91, 64, 100]);
  inject(midi, [0xb1, 123, 0]); // all-notes-off on ch2 only
  assert.deepEqual(engine.of('noteOff').map((c) => c[1]), [60, 64]);
  midi.dispatchEvent(new CustomEvent('disconnected', { detail: { inputId: 'kbd' } }));
  assert.deepEqual(engine.of('noteOff').map((c) => c[1]), [60, 64, 62], 'disconnect releases every channel');
});

test('L9: toggling pedalInvert recomputes sustain from the raw pedal (release only; never starts a stuck sustain)', async () => {
  const { engine, midi, store } = await setup();
  engine.clear();
  inject(midi, [0xb0, 64, 127]);
  assert.deepEqual(engine.of('sustain').map((c) => c[1]), [true]);
  store.set('settings.pedalInvert', true);
  await tick();
  assert.deepEqual(engine.of('sustain').map((c) => c[1]), [true, false]);
  inject(midi, [0xb0, 64, 0]); // physical release on an inverted pedal = down
  assert.deepEqual(engine.of('sustain').map((c) => c[1]), [true, false, true]);
  store.set('settings.pedalInvert', false); // raw up, not inverted → released
  await tick();
  assert.deepEqual(engine.of('sustain').map((c) => c[1]), [true, false, true, false]);
  store.set('settings.pedalInvert', true); // would compute "down": not applied until the pedal moves
  await tick();
  assert.equal(engine.of('sustain').length, 4);
});

// ================================================================================================= M2 / L8
test('M2: fader learn ignores notes and pedal CCs (64/66/67) and takes a continuous CC; CC64 → sustain-pedal-reserved', async () => {
  const { engine, midi, ctl, store } = await setup();
  engine.clear();
  let p = ctl.learn('slots.1.gain');
  inject(midi, [0x90, 36, 100]); // a key: played, not learned
  inject(midi, [0xb0, 66, 127]); // sostenuto is never a fader
  inject(midi, [0xb0, 67, 127]); // soft pedal neither
  inject(midi, [0xb0, 121, 0]); // channel mode: ignored
  inject(midi, [0xb0, 11, 20]);
  assert.deepEqual(await p, { cc: 11, channel: 0 });
  assert.deepEqual(store.get().settings.midiLearn['slots.1.gain'], { cc: 11, channel: 0 });
  assert.deepEqual(engine.of('noteOn').map((c) => c[1]), [36]);
  p = ctl.learn('drone.gain');
  inject(midi, [0xb0, 64, 127]);
  assert.deepEqual(await p, { error: 'sustain-pedal-reserved', cc: 64, channel: 0 });
  assert.equal(store.get().settings.midiLearn['drone.gain'], undefined);
  assert.equal(engine.of('sustain').at(-1)[1], true, 'the pedal still sustains');
});

test('M2: button learn takes a note-on or a switch CC press (CC67 ok); CC64 is reserved; old CC64 mappings are ignored', async () => {
  const { engine, midi, ctl, store } = await setup();
  let p = ctl.learn('nextSong');
  inject(midi, [0xb0, 64, 127]);
  assert.equal((await p).error, 'sustain-pedal-reserved');
  p = ctl.learn('nextSong');
  inject(midi, [0xb0, 67, 0]); // release first: ignored
  inject(midi, [0xb0, 67, 127]);
  assert.deepEqual(await p, { cc: 67, channel: 0 });
  p = ctl.learn('panic');
  inject(midi, [0x99, 40, 90]);
  assert.deepEqual(await p, { note: 40, channel: 9 });
  assert.equal(store.setMidiLearn('prevSong', { cc: 64, channel: 0 }), false);
  store.set('settings.midiLearn', { ...store.get().settings.midiLearn, prevSong: { cc: 64, channel: null } }); // legacy data
  inject(midi, [0xb0, 64, 0]); // (the pedal was left down by the first learn attempt)
  engine.clear();
  inject(midi, [0xb0, 64, 127]);
  assert.deepEqual(engine.of('sustain').map((c) => c[1]), [true], 'CC64 sustains, never a learned button');
});

test('M2: optional motion filter (midi.learn {motion}) skips pot jitter', async () => {
  const m = new MidiInput({ nav: null, warn: () => {} });
  const p = m.learn('slots.0.gain', { accept: 'fader', motion: 8 });
  m._inject([0xb0, 1, 60], 0, 'k');
  m._inject([0xb0, 1, 62], 0, 'k'); // jitter
  m._inject([0xb0, 7, 10], 0, 'k');
  m._inject([0xb0, 7, 30], 0, 'k');
  assert.equal((await p).cc, 7);
});

test('L8: the "first" MIDI input is sticky while it stays connected', () => {
  const ports = new Map();
  const mk = (id, name) => ({ id, name, type: 'input', state: 'connected', onmidimessage: null });
  ports.set('b', mk('b', 'Keystation'));
  const m = new MidiInput({ nav: null, warn: () => {} });
  m.access = { inputs: ports };
  m.select('first');
  assert.deepEqual(m.inputs.filter((i) => i.selected).map((i) => i.id), ['b']);
  // a new controller that enumerates first must not steal the selection
  const reordered = new Map([['a', mk('a', 'Arturia')], ['b', ports.get('b')]]);
  m.access.inputs = reordered;
  m._handleStateChange({ port: reordered.get('a') });
  assert.deepEqual(m.inputs.filter((i) => i.selected).map((i) => i.id), ['b']);
  reordered.get('b').state = 'disconnected';
  m._handleStateChange({ port: reordered.get('b') });
  assert.deepEqual(m.inputs.filter((i) => i.selected).map((i) => i.id), ['a'], 're-resolved when it disappears');
});

// ================================================================================================= M1
test('M1: after restartAudio the wheels, CC7, pedal and pad files are re-sent; a files drone is re-applied', async () => {
  const pads = [{ name: 'Pad C.mp3', url: '/pads/t/c.mp3' }];
  const rig = { isElectron: true, onMenu: () => () => {}, listPads: async () => pads };
  const store = makeStore();
  store.set('song.drone.mode', 'files');
  const { engine, midi, ctl } = await setup({ store, rig });
  inject(midi, [0xb0, 1, 25]);
  inject(midi, [0xb0, 11, 64]);
  inject(midi, [0xb0, 7, 30]);
  inject(midi, [0xb0, 64, 127]);
  engine.clear();
  await ctl.restartAudio();
  const after = engine.names();
  assert.ok(after.indexOf('restart') < after.indexOf('modWheel'));
  assert.equal(engine.of('modWheel')[0][1], 25 / 127);
  assert.equal(engine.of('expression')[0][1], 64 / 127);
  assert.equal(engine.of('volumeCC')[0][1], 30 / 127);
  assert.deepEqual(engine.of('sustain').map((c) => c[1]), [true], 'held pedal re-sent');
  assert.deepEqual(engine.of('drone.attachFiles')[0][1], pads);
  const conf = engine.of('drone.configure').map((c) => c[1].mode);
  assert.deepEqual(conf, ['off', 'files'], 'files drone re-applied after the files are back');
  // virtual owner is restored as virtual
  ctl.perform.wheel(0.4);
  engine.clear();
  await ctl.restartAudio();
  assert.deepEqual(engine.of('setWheel')[0].slice(1), ['virtual', 0.4]);
  assert.equal(engine.of('modWheel').length, 0);
});

test('M1: an engine-internal restart (statechange restarted / reason:restart) triggers the same recovery and splits the recording', async () => {
  const rec = new EventTarget();
  const log = [];
  rec.isRecording = true;
  rec.stop = async () => (log.push('stop'), (rec.isRecording = false), { path: '/Music/Worship Rig/Rig 1.wav' });
  rec.start = async () => (log.push('start'), (rec.isRecording = true), { ok: true, path: '/Music/Worship Rig/Rig 1 2.wav' });
  const { engine, midi, ctl, warns } = await setup({ recorder: rec, rig: { isElectron: true, onMenu: () => () => {} } });
  inject(midi, [0xb0, 1, 10]);
  engine.clear();
  const restarted = [];
  ctl.addEventListener('statechange', (e) => restarted.push(e.detail));
  engine.dispatchEvent(new CustomEvent('statechange', { detail: { state: 'running', reason: 'restart' } }));
  await tick();
  await tick();
  assert.equal(engine.of('modWheel')[0][1], 10 / 127);
  assert.deepEqual(log, ['stop', 'start']);
  assert.ok(warns.some((w) => /split/.test(w) && /Rig 1 2\.wav/.test(w)));
  assert.equal(restarted[0].state, 'restarted');
  // our own restartAudio's engine event is not handled twice
  log.length = 0;
  engine.restart = (o) => {
    engine.calls.push(['restart', o]);
    engine.dispatchEvent(new CustomEvent('statechange', { detail: { state: 'running', restarted: true } }));
    return Promise.resolve();
  };
  await ctl.restartAudio();
  assert.deepEqual(log, ['stop', 'start']);
});

test('M1: an engine that carries runtime state across restart is not sent the wheels again', async () => {
  const engine = fakeEngine();
  engine.applyRuntimeState = () => {};
  const { midi, ctl } = await setup({ engine });
  inject(midi, [0xb0, 1, 25]);
  engine.clear();
  await ctl.restartAudio();
  assert.equal(engine.of('modWheel').length, 0);
});

// ================================================================================================= H2
test('H2: a second window is read-only and muted; it takes over when the first one goes away', async () => {
  const locks = fakeLocks();
  const storage = memoryStorage();
  const storeA = makeStore({ storage, debounceMs: 0 });
  storeA.persistNow();
  const a = await setup({ store: storeA, locks });
  assert.equal(a.ctl.status.instance, 'primary');
  const storeB = makeStore({ storage, debounceMs: 0 });
  const engineB = fakeEngine();
  const b = await setup({ store: storeB, engine: engineB, locks });
  assert.equal(b.ctl.status.instance, 'secondary');
  assert.equal(b.ctl.status.instanceMessage, SECONDARY_MESSAGE);
  assert.equal(engineB.of('start').length, 0, 'no audio in the second window');
  assert.equal(storeB.loadInfo.readOnly, true);
  b.ctl.perform.noteOn(60);
  assert.equal(engineB.of('noteOn').length, 0, 'muted');
  // B edits in memory only; A's rename is saved and must survive
  const id = storeA.get().songOrder[0];
  storeA.set(`songs.${id}.name`, 'Renamed in A');
  storeA.persistNow();
  storeB.set('settings.view', 'edit');
  storeB.persistNow();
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).songs[id].name, 'Renamed in A', 'B did not clobber A');
  // A closes → B becomes primary, re-reads the library, starts audio
  a.ctl.dispose();
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(b.ctl.status.instance, 'primary');
  assert.equal(engineB.of('start').length, 1);
  assert.equal(storeB.getSong(id).name, 'Renamed in A');
  assert.equal(storeB.loadInfo.readOnly, false);
});

test('H2: serve.mjs opens Chrome only when no window pinged the reused server recently', () => {
  assert.equal(shouldOpenWindow({ reused: false }, true), true);
  assert.equal(shouldOpenWindow({ reused: true, clientSeenMsAgo: 5000 }, true), false);
  assert.equal(shouldOpenWindow({ reused: true, clientSeenMsAgo: null }, true), true, 'server alive but window closed');
  assert.equal(shouldOpenWindow({ reused: true, clientSeenMsAgo: 120000 }, true), true);
  assert.equal(shouldOpenWindow({ reused: false }, false), false);
});

// ================================================================================================= UI findings
test('ui-core #1: toggleView respects performLock', async () => {
  const { ctl, store } = await setup();
  store.set('settings.performLock', true);
  assert.equal(ctl.toggleView(), 'perform');
  assert.equal(store.get().settings.view, 'perform');
  store.set('settings.performLock', false);
  assert.equal(ctl.toggleView(), 'edit');
});

test('ui-edit #1: removing an instrument param sends its default; unknown defaults → re-prepare', async () => {
  const engine = fakeEngine();
  engine.listInstruments = () => [{ ref: { type: 'sampler', id: 'salamander-piano' }, params: [{ key: 'tone', default: 1 }, { key: 'release', default: 0.12 }] }];
  const { store } = await setup({ engine });
  const cur = store.currentSong();
  assert.equal(cur.patch.slots[0].instrument.id, 'salamander-piano');
  store.set('slots.0.params.tone', 0.3);
  await tick();
  engine.clear();
  store.set('slots.0.params', {});
  await tick();
  assert.deepEqual(engine.of('setParam').map((c) => c.slice(1)), [['slots.0.params.tone', 1]]);
  engine.listInstruments = () => [];
  store.set('slots.0.params.tone', 0.5);
  await tick();
  engine.clear();
  store.set('slots.0.params', {});
  await tick();
  assert.equal(engine.of('prepare').length, 1, 're-prepared to reset the instrument');
});

test('ui-core #7: on-screen notes use settings.velocitySens; perform.wheel emits "wheel"', async () => {
  const { engine, ctl, store } = await setup();
  store.set('settings.velocitySens', 'fixed');
  engine.clear();
  ctl.perform.noteOn(60, 40);
  assert.deepEqual(engine.of('noteOn')[0].slice(1), [60, 100]);
  const got = [];
  ctl.addEventListener('wheel', (e) => got.push(e.detail));
  ctl.perform.wheel(0.3);
  assert.deepEqual(got, [{ source: 'virtual', value: 0.3 }]);
});

test('ui-edit #5: Chrome pad folder is re-attached at startup when the saved handle still has permission', async () => {
  const files = [{ kind: 'file', name: 'Pad - C.mp3', getFile: async () => new Blob(['x']) }, { kind: 'file', name: 'notes.txt', getFile: async () => new Blob(['y']) }];
  const handle = { name: 'Pads', queryPermission: async () => 'granted', values: async function* () { yield* files; } };
  const idb = {
    open() {
      const req = {};
      queueMicrotask(() => {
        req.result = {
          close() {},
          transaction: () => ({ objectStore: () => ({ get: () => { const g = {}; queueMicrotask(() => { g.result = handle; g.onsuccess(); }); return g; } }) }),
        };
        req.onsuccess();
      });
      return req;
    },
  };
  const store = makeStore();
  store.set('settings.padFolder', { kind: 'fsa', name: 'Pads' });
  const { engine } = await setup({ store, indexedDB: idb });
  const att = engine.of('drone.attachFiles');
  assert.equal(att.length, 1);
  assert.deepEqual(att[0][1].map((f) => f.name), ['Pad - C.mp3']);
  assert.match(att[0][1][0].url, /^blob:/);
  handle.queryPermission = async () => 'prompt';
  const again = await setup({ store, indexedDB: idb });
  assert.equal(again.engine.of('drone.attachFiles').length, 0, 'no prompt at startup');
});

test('M5 (renderer): a newer backup from another port is offered; importLatestBackup replaces after backing up', async () => {
  const src = makeStore();
  src.set(`songs.${src.get().songOrder[0]}.name`, 'From 8439');
  const text = `{"origin":"http://127.0.0.1:8439",${src.exportJSON({ pretty: false }).slice(1)}`;
  const backups = [];
  const rig = {
    isElectron: true,
    onMenu: () => () => {},
    getInfo: async () => ({ port: 8438, otherLibrary: { path: '/b/rig-1.json', origin: 'http://127.0.0.1:8439', savedAt: 1 } }),
    latestBackup: async () => ({ path: '/b/rig-1.json', origin: 'http://127.0.0.1:8439', savedAt: 1, text }),
    backupNow: async (j) => (backups.push(j), { path: '/b/rig-2.json' }),
  };
  const offers = [];
  const store = makeStore();
  store.set('song.tempo', 99); // an edited library (a pristine seed is never backed up: round2-shell #2)
  const { ctl, warns } = await setup({ store, rig, ctl: {} });
  ctl.addEventListener('library-offer', (e) => offers.push(e.detail));
  await tick();
  assert.equal(ctl.status.otherLibrary.origin, 'http://127.0.0.1:8439');
  assert.ok(warns.some((w) => /8439/.test(w)));
  const r = await ctl.onMenu('importLatestBackup');
  assert.equal(r.ok, true);
  assert.equal(backups.length, 1, 'current library backed up first');
  assert.equal(store.getSong(store.get().songOrder[0]).name, 'From 8439');
  assert.equal(store.get().songOrder.length, FACTORY_SONGS.length, 'replaced, not merged');
});

// ================================================================================================= recorder (M6 / L5)
test('M6: ElectronSink.close still requests the final header after a write error', async () => {
  const calls = [];
  const rig = {
    streamOpen: async () => ({ id: 1, path: '/r.wav' }),
    streamWrite: async (id, b) => (calls.push(['write', b.byteLength]), b.byteLength !== 44 ? { error: 'disk full' } : { bytes: 44 }),
    streamPatchHeader: async (id, b) => (calls.push(['patch', new DataView(b).getUint32(40, true)]), { ok: true }),
    streamClose: async () => (calls.push(['close']), { path: '/r.wav', bytes: 44 }),
  };
  const sink = new ElectronSink(rig, 'r.wav', { flushBytes: 8 });
  await sink.open(48000, 2);
  sink.write(new ArrayBuffer(16));
  await sink.chain;
  assert.ok(sink.error);
  await assert.rejects(sink.close(16), /disk full/);
  assert.deepEqual(calls.slice(-2), [['patch', 16], ['close']]);
});

test('L5: the memory sink stops itself at memoryMaxSec with a warning', async () => {
  const r = new Recorder({ engine: {}, win: new EventTarget(), rig: null, memoryMaxSec: 2, memoryWarnSec: 1 });
  const warns = [];
  r.addEventListener('warn', (e) => warns.push(e.detail.message));
  let stopped = 0;
  r.stop = async () => (stopped += 1);
  r._sink = new MemorySink('x.wav');
  r._sr = 1000;
  r._frames = 0;
  r._bytes = 0;
  r._lastHeaderFrames = 0;
  r._state = 'recording';
  for (let i = 0; i < 5; i++) r._onMessage({ type: 'chunk', frames: 1000, buf: new ArrayBuffer(4000), peakL: 0, peakR: 0 });
  assert.equal(stopped, 1);
  assert.ok(warns.some((w) => /stopped after/.test(w)));
  assert.ok(warns.some((w) => /in memory/.test(w)));
});

// ================================================================================================= server (L6 / L7 / M5)
function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('L7: app HTML gets CSP + X-Frame-Options; test fixtures under test/ are exempt', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-csp-'));
  fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html>');
  fs.mkdirSync(path.join(tmp, 'test'));
  fs.writeFileSync(path.join(tmp, 'test', 'f.html'), '<!doctype html>');
  fs.writeFileSync(path.join(tmp, 'a.js'), '//');
  const srv = createServer({ appDir: tmp, port: 0 });
  const { port } = await srv.listen();
  try {
    const h = await get(port, '/');
    assert.equal(h.headers['content-security-policy'], CSP);
    assert.match(CSP, /script-src 'self' blob:/);
    assert.match(CSP, /frame-ancestors 'none'/);
    assert.equal(h.headers['x-frame-options'], 'DENY');
    const f = await get(port, '/test/f.html');
    assert.equal(f.headers['content-security-policy'], undefined);
    assert.equal(f.headers['x-frame-options'], 'DENY');
    const js = await get(port, '/a.js');
    assert.equal(js.headers['content-security-policy'], undefined);
  } finally {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('L6: symlinks escaping the pad folder are neither listed nor served; the listing is cached until a folder changes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-pads-'));
  const pads = path.join(tmp, 'pads');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(pads, 'Sub'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(pads, 'Pad C.mp3'), 'a');
  fs.writeFileSync(path.join(pads, 'Sub', 'Pad D.mp3'), 'b');
  fs.writeFileSync(path.join(outside, 'secret.mp3'), 'secret');
  fs.symlinkSync(outside, path.join(pads, 'link'));
  fs.symlinkSync(path.join(outside, 'secret.mp3'), path.join(pads, 'file-link.mp3'));
  fs.symlinkSync(path.join(pads, 'Sub'), path.join(pads, 'inside-link'));
  const srv = createServer({ appDir: tmp, port: 0, padsRoot: pads });
  const { port } = await srv.listen();
  try {
    const list = await srv.listPads();
    assert.equal(list.length, 2, 'escaping links skipped; the inside link and its target are one directory');
    assert.ok(list.some((p) => p.path === 'Pad C.mp3'));
    assert.ok(list.some((p) => /^(Sub|inside-link)\/Pad D\.mp3$/.test(p.path)));
    const base = srv.padsBaseUrl();
    assert.equal((await get(port, `${base}link/secret.mp3`)).status, 404);
    assert.equal((await get(port, `${base}file-link.mp3`)).status, 404);
    assert.equal((await get(port, `${base}Pad%20C.mp3`)).status, 200);
    const again = await srv.listPads();
    assert.deepEqual(again.map((p) => p.path), list.map((p) => p.path));
    fs.writeFileSync(path.join(pads, 'Sub', 'Pad E.mp3'), 'c'); // subfolder mtime changes
    const third = await srv.listPads();
    assert.ok(third.some((p) => /Pad E\.mp3$/.test(p.path)), 'cache invalidated by the new file');
  } finally {
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('M5/H2: reuse:false never reuses another Worship Rig server; reuse reports whether a window pinged it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-reuse-'));
  fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html>');
  const base = 20000 + Math.floor(Math.random() * 20000);
  const a = createServer({ appDir: tmp, port: base });
  const ia = await a.listen();
  assert.equal(ia.port, base);
  const b = createServer({ appDir: tmp, port: base, reuse: false });
  const c = createServer({ appDir: tmp, port: base });
  try {
    const ib = await b.listen();
    assert.equal(ib.reused, false);
    assert.equal(ib.port, base + 1);
    assert.deepEqual(ib.busyWithRig, [base]);
    const ic = await c.listen();
    assert.equal(ic.reused, true);
    assert.equal(ic.clientSeenMsAgo, null);
    assert.equal((await get(base, '/api/heartbeat')).status, 200);
    const h = JSON.parse((await get(base, '/api/health')).body);
    assert.ok(h.clientSeenMsAgo >= 0 && h.clientSeenMsAgo < 5000);
  } finally {
    await b.close();
    await a.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
