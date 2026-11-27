// UI6-er O1: an empty library is silent, and PANIC stops a drone left on with no song behind it.
// - The last song deleted (or an empty library imported): the controller turns the drone off (drone.configure
//   {mode:'off'}, the ON tile's path) and fades the voices (fadeOutAll, Fade out's path), once per empty spell.
// - PANIC: as before for every drone a song (or its snapshot) has on or off (engine allNotesOff only); a drone the
//   engine was left playing with no selected song is turned off after allNotesOff.
// - Over the native bridge (BridgeEngine + MockNative, the contract validator): no finding, no warning.
// Back from a trial begun in an empty library: bank-trial.test.mjs "UI6-er O1".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { blankSong } from '../../../app/js/presets.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';
import { rig as bridgeRig, flush } from '../../unit/engine-bridge/helpers.mjs';

async function setup(opts = {}) {
  const store = opts.store || makeStore();
  const engine = opts.engine || fakeEngine();
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const ctl = createController({ store, engine, midi, recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(),
    rig: null, timers: opts.timers || fakeTimers(), now: () => 0 });
  const warns = [];
  const actions = [];
  ctl.addEventListener('warn', (e) => warns.push(e.detail.message));
  ctl.addEventListener('action', (e) => actions.push(e.detail.type));
  await ctl.start();
  await tick();
  return { store, engine, ctl, warns, actions };
}
const deleteAll = (store) => {
  for (const id of store.get().songOrder.slice()) assert.ok(store.deleteSong(id));
};
/** The engine calls that make or stop sound, in order (no preload / setParam noise). */
const SOUND = new Set(['allNotesOff', 'fadeOutAll', 'drone.configure', 'drone.setKey', 'prepare', 'commit']);
const soundCalls = (engine) => engine.calls.filter((c) => SOUND.has(c[0]));

test('UI6-er O1: deleting the last song turns the drone off, then fades the voices, once', async () => {
  const { store, engine, ctl, warns, actions } = await setup();
  try {
    assert.equal(store.currentSong().drone.mode, 'synth', 'the factory song plays a drone');
    engine.clear();
    deleteAll(store);
    await tick();
    assert.equal(store.get().settings.currentSongId, null);
    assert.deepEqual(soundCalls(engine), [['drone.configure', { mode: 'off' }], ['fadeOutAll', 6]],
      'drone off first (its own fade), then Fade out');
    assert.deepEqual(actions, ['fadeOutAll'], 'the views hear Fade out, as from the button');
    // once: more writes in the empty library (settings, an empty setlist) change nothing
    engine.clear();
    store.set('settings.view', 'edit');
    store.set('settings.view', 'perform');
    await tick();
    assert.deepEqual(soundCalls(engine), []);
    assert.equal(ctl.menuBarState().droneOn, false);
    // PANIC afterwards: the drone is already off, so today's PANIC exactly
    engine.clear();
    ctl.panic();
    assert.deepEqual(engine.calls, [['allNotesOff']]);
    // a new song: selected, loaded and its drone configured again (force: the engine's drone is on again)
    engine.clear();
    const b = blankSong({ name: 'After the empty' });
    const id = store.addSong({ ...b, drone: { ...b.drone, mode: 'synth' } });
    await tick();
    await tick();
    assert.equal(store.get().settings.currentSongId, id);
    const conf = engine.of('drone.configure');
    assert.equal(conf.length, 1);
    assert.equal(conf[0][1].mode, 'synth', 'its drone sounds again');
    assert.equal(engine.of('fadeOutAll').length, 0);
    // a second empty spell: silent again, once
    engine.clear();
    actions.length = 0;
    deleteAll(store);
    await tick();
    assert.deepEqual(soundCalls(engine), [['drone.configure', { mode: 'off' }], ['fadeOutAll', 6]]);
    assert.deepEqual(actions, ['fadeOutAll']);
    assert.deepEqual(warns, []);
  } finally {
    ctl.dispose();
  }
});

test('UI6-er O1: emptied with the drone off: only a fade; an empty library at start is left alone', async () => {
  {
    const { store, engine, ctl, warns } = await setup();
    try {
      const cur = store.currentSong();
      store.set(`songs.${cur.id}.drone.mode`, 'off');
      await tick();
      assert.equal(engine.of('drone.configure').at(-1)[1].mode, 'off');
      engine.clear();
      deleteAll(store);
      await tick();
      assert.deepEqual(soundCalls(engine), [['fadeOutAll', 6]], 'no drone call for a drone that is off');
      assert.deepEqual(warns, []);
    } finally {
      ctl.dispose();
    }
  }
  {
    // nothing played in this engine yet: a fresh engine is silent, and the views must not show "Faded"
    const store = makeStore();
    deleteAll(store);
    const { engine, ctl, actions } = await setup({ store });
    try {
      store.set('settings.view', 'edit');
      await tick();
      assert.deepEqual(soundCalls(engine), []);
      assert.deepEqual(actions, []);
    } finally {
      ctl.dispose();
    }
  }
});

test('UI6-er O1: PANIC leaves a drone a song or snapshot has on; it stops one left on with no song', async () => {
  // the drone.configure {mode:'off'} of the empty-library step fails once: the drone is left sounding (as before
  // this fix), with no song selected (menuBarState().droneOn false)
  const engine = fakeEngine();
  let failOff = 0;
  const configure = engine.drone.configure;
  engine.drone.configure = (d, ...rest) => {
    if (d && d.mode === 'off' && failOff > 0) {
      failOff -= 1;
      throw new Error('bridge down');
    }
    return configure(d, ...rest);
  };
  const { store, ctl, warns } = await setup({ engine });
  try {
    // a song with its drone on: today's PANIC (allNotesOff only; the drone keeps going, release notes 1.1.0)
    engine.clear();
    ctl.panic();
    assert.deepEqual(engine.calls, [['allNotesOff']]);
    // a snapshot that holds the drone ON over a song whose own drone is off: the drone a song plays (D26.1)
    const cur = store.currentSong();
    assert.ok(ctl.scenes.save(0)); // drone on
    assert.ok(ctl.scenes.go(null));
    store.set(`songs.${cur.id}.drone.mode`, 'off');
    await tick();
    assert.equal(engine.of('drone.configure').at(-1)[1].mode, 'off');
    assert.ok(ctl.scenes.go(0));
    assert.equal(engine.of('drone.configure').at(-1)[1].mode, 'synth', 'the snapshot turns it on');
    engine.clear();
    ctl.panic();
    assert.deepEqual(engine.calls, [['allNotesOff']], 'PANIC as today under the snapshot');
    assert.ok(ctl.scenes.go(null));
    store.set(`songs.${cur.id}.drone.mode`, 'synth');
    await tick();
    assert.equal(engine.of('drone.configure').at(-1)[1].mode, 'synth');
    // the orphan
    failOff = 1;
    engine.clear();
    deleteAll(store);
    await tick();
    assert.ok(warns.some((w) => /drone\.configure failed: bridge down/.test(w)), warns.join(' | '));
    assert.deepEqual(engine.calls.filter((c) => c[0] === 'fadeOutAll'), [['fadeOutAll', 6]]);
    assert.equal(ctl.menuBarState().droneOn, false, 'no song: the state says no drone, yet the engine plays one');
    engine.clear();
    ctl.panic();
    assert.deepEqual(engine.calls, [['allNotesOff'], ['drone.configure', { mode: 'off' }]],
      'today\'s PANIC first, then the orphaned drone off');
    engine.clear();
    ctl.panic();
    assert.deepEqual(engine.calls, [['allNotesOff']], 'once it is off, PANIC is today\'s again');
  } finally {
    ctl.dispose();
  }
});

test('UI6-er O1: PANIC keeps its order and the rest of what it stops (held notes, pedal, swell, click)', async () => {
  const { store, engine, ctl } = await setup();
  try {
    const cur = store.currentSong();
    store.set(`songs.${cur.id}.tempo`, 90);
    await tick();
    ctl.perform.noteOn(60, 100, 'kb');
    ctl.perform.sustain?.(true, 'kb');
    ctl.swell(true);
    ctl.startClick?.();
    engine.clear();
    const status = [];
    ctl.addEventListener('status', (e) => status.push(e.detail.pedal));
    ctl.panic();
    // the base build (v2-native ea7fb9c) sends exactly this here too (probe, not committed)
    assert.deepEqual(engine.calls, [['allNotesOff']], 'a song with its drone on: the drone is left');
    assert.equal(ctl.status.pedal, false);
    // the next swell toggle starts one (round4-controller C8), so the swell state was dropped
    engine.clear();
    assert.equal(ctl.swell(), true);
  } finally {
    ctl.dispose();
  }
});

test('UI6-er O1 over the native bridge: empty library and PANIC send only contracted messages', async () => {
  const r = bridgeRig();
  const { store, ctl, warns } = await setup({ engine: r.engine });
  try {
    await flush();
    const from = r.log.toNative.length;
    deleteAll(store);
    await tick();
    await flush();
    ctl.panic();
    await flush();
    const sent = r.log.toNative.slice(from).filter((m) => m.op === 'drone' || (m.op === 'play'
      && ['fade', 'panic'].includes(m.e)));
    assert.deepEqual(sent.map((m) => (m.op === 'drone' ? `drone:${m.config?.mode}` : `play:${m.e}`)),
      ['drone:off', 'play:fade', 'play:panic']);
    assert.deepEqual(r.mock.findings, [], JSON.stringify(r.mock.findings));
    assert.deepEqual(warns, []);
  } finally {
    ctl.dispose();
  }
});

test('UI6-er O1: an audio restart in the empty library does not bring the last song\'s drone back', async () => {
  const { store, engine, ctl, warns } = await setup();
  try {
    deleteAll(store);
    await tick();
    assert.deepEqual(engine.of('drone.configure').at(-1)[1], { mode: 'off' });
    engine.clear();
    assert.equal(await ctl.restartAudio(), true);
    await tick();
    const on = engine.of('drone.configure').filter((c) => c[1].mode !== 'off');
    assert.deepEqual(on, [], 'no drone.configure turning it on again');
    // a new song afterwards still gets its drone
    const b = blankSong({ name: 'After the restart' });
    store.addSong({ ...b, drone: { ...b.drone, mode: 'synth' } });
    await tick();
    await tick();
    assert.equal(engine.of('drone.configure').at(-1)[1].mode, 'synth');
    assert.deepEqual(warns, []);
  } finally {
    ctl.dispose();
  }
});

test('UI6-fu F1: the same library brought back after the empty spell plays its song\'s drone again', async () => {
  // Skeptic UI6-fu F1: a library restored over the empty one (Import… replace, a kept library, a backup) keeps its
  // song ids. The deleted song was still `targetId` / `appliedId`, so onStore took the brought-back song for the
  // one already playing (applyDiff: same drone mode, no configure) and the engine's drone stayed off under a song
  // whose drone, menu bar and tiles all said ON.
  const { store, engine, ctl, warns } = await setup();
  try {
    const cur = store.currentSong();
    assert.equal(cur.drone.mode, 'synth');
    for (const id of store.get().songOrder.slice()) if (id !== cur.id) assert.ok(store.deleteSong(id));
    await tick();
    const backup = JSON.stringify({ kind: 'library', schema: 2, songs: { [cur.id]: store.getSong(cur.id) },
      songOrder: [cur.id], setlists: {}, setlistOrder: [] });
    assert.ok(store.deleteSong(cur.id));
    await tick();
    assert.deepEqual(engine.of('drone.configure').at(-1)[1], { mode: 'off' }, 'the empty library silenced it');
    engine.clear();
    const r = store.importJSON(backup, { replace: true });
    assert.equal(r.ok, true);
    await tick();
    await tick();
    assert.equal(store.get().settings.currentSongId, cur.id, 'the same id is selected again');
    assert.equal(ctl.menuBarState().droneOn, true);
    const conf = engine.of('drone.configure');
    assert.equal(conf.length, 1, 'its drone is configured again');
    assert.equal(conf[0][1].mode, 'synth');
    assert.equal(engine.of('commit').length, 1, 'selected as any song (prepare / commit)');
    // the undo a player reaches for: every song deleted, then Settings › Restore previous library (a kept copy, D8)
    const kept = store.keepCurrent('restore');
    assert.equal(kept.ok, true);
    deleteAll(store);
    await tick();
    assert.deepEqual(engine.of('drone.configure').at(-1)[1], { mode: 'off' });
    engine.clear();
    const back = await ctl.restorePreviousLibrary(kept.key);
    assert.equal(back.ok, true, JSON.stringify(back));
    await tick();
    await tick();
    assert.equal(store.get().settings.currentSongId, cur.id);
    assert.deepEqual(engine.of('drone.configure').map((c) => c[1].mode), ['synth'], 'its drone on again');
    assert.deepEqual(warns, []);
  } finally {
    ctl.dispose();
  }
});
