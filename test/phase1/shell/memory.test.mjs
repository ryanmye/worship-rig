// morning-prep: decoded-sample memory policy (integration-2 round 2 #3). With no setlist the controller used to pin
// every song of the library ({pin:'replace'} on store.navIds()), so the engine's 700 MB LRU cap could not evict
// (1023.6 MB in the soak). These tests model the engine's pin set from the controller's preload calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController, PIN_BUDGET_MB, LARGE_SET_NOTE } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { FACTORY_SONGS } from '../../../app/js/presets.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await tick();
};

/**
 * Fake engine whose preload() records pins like BufferCache (replace = set, add = union, none = warm only) and
 * whose estimatePreloadMB() prices every song at `mbPerSong` (deduplicated). `exactMB` overrides the price once a
 * song was preloaded (an estimate that turns out low after decoding).
 */
function pinEngine(store, { mbPerSong = 20, exactMB = null, capMB = 700, estimate = true } = {}) {
  const engine = fakeEngine();
  const idOf = (patch) => store.get().songOrder.find((id) => store.getSong(id).patch === patch);
  engine.pinned = new Set();
  engine.warmed = new Set();
  engine.preload = (patches, opts) => {
    const ids = patches.map(idOf);
    engine.calls.push(['preload', patches, opts, ids]);
    if (opts.pin === 'replace') engine.pinned = new Set(ids);
    else if (opts.pin === 'add') for (const id of ids) engine.pinned.add(id);
    for (const id of ids) engine.warmed.add(id);
    return Promise.resolve(true);
  };
  const price = (id) => (exactMB !== null && engine.warmed.has(id) ? exactMB : mbPerSong);
  if (estimate) {
    engine.estimatePreloadMB = (patches) => {
      const ids = [...new Set(patches.map(idOf))];
      return Promise.resolve({ mb: ids.reduce((s, id) => s + price(id), 0), exact: false, samples: ids.length, capMB });
    };
  }
  engine._debugStats = () => ({ voices: 0, nodes: 0, decodedMB: 123.4, pinnedMB: 45.6, capMB });
  return engine;
}

function mkCtl(store, engine, timers = fakeTimers()) {
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const o = { recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(), rig: null, now: () => 0, locks: null };
  return createController({ store, engine, midi, timers, heartbeat: false, indexedDB: null, ...o });
}

async function setup({ setlist = null, engineOpts = {} } = {}) {
  const store = makeStore();
  store.setCurrentSetlist(null); // the seed selects "My Set" (every factory song)
  if (setlist) {
    const ids = typeof setlist === 'number' ? store.get().songOrder.slice(0, setlist) : setlist;
    store.setCurrentSetlist(store.addSetlist('Sunday', ids));
  }
  const engine = pinEngine(store, engineOpts);
  const events = [];
  const timers = fakeTimers();
  const ctl = mkCtl(store, engine, timers);
  ctl.addEventListener('memory', (e) => events.push(e.detail));
  await ctl.start();
  await settle();
  return { store, engine, ctl, events, timers };
}

const preloads = (engine) => engine.of('preload');

test('memory: no setlist → only the current song and its library neighbours are pinned (never the library)', async () => {
  const { store, engine, ctl } = await setup();
  const order = store.get().songOrder;
  assert.equal(store.currentSetlist(), null);
  assert.ok(preloads(engine).every((c) => c[1].length <= 3), 'no preload of more than 3 songs');
  assert.ok(!preloads(engine).some((c) => c[1].length === FACTORY_SONGS.length), 'the whole library is never preloaded');
  assert.deepEqual([...engine.pinned].sort(), [order[0], order[1]].sort(), 'first song: itself + next');
  assert.equal(ctl.status.memory.mode, 'library');
  assert.equal(ctl.status.memory.note, null);
  assert.equal(ctl.status.ready, true);
  // walk the whole library (the soak warm-up): the pin set stays ≤ 3 songs around the current one
  for (let i = 1; i < order.length; i++) {
    await ctl.nextSong();
    await settle();
    const want = [order[i - 1], order[i], order[i + 1]].filter(Boolean);
    assert.deepEqual([...engine.pinned].sort(), want.sort(), `song ${i}: prev/current/next only`);
  }
  assert.ok(preloads(engine).every((c) => ['replace', 'add', 'none'].includes(c[2].pin)), 'never the engine default');
});

test('memory: default seed ("My Set" = the 19 factory songs, ~1 GB decoded) takes the large-set path', async () => {
  const store = makeStore();
  const n = store.navIds().length;
  assert.equal(n, FACTORY_SONGS.length);
  const engine = pinEngine(store, { mbPerSong: 54 }); // 19 × 54 ≈ 1026 MB, the soak's 1023.6
  const ctl = mkCtl(store, engine);
  await ctl.start();
  await settle();
  assert.equal(ctl.status.memory.mode, 'large-set');
  assert.ok(engine.pinned.size <= 5, `pinned ${engine.pinned.size} songs`);
  assert.ok(!engine.of('preload').some((c) => c[2].pin === 'replace' && c[1].length > 5));
});

test('memory: an empty setlist counts as no setlist', async () => {
  const { engine, ctl } = await setup({ setlist: [] });
  assert.ok(engine.pinned.size <= 3 && engine.pinned.size >= 1);
  assert.equal(ctl.status.memory.mode, 'library');
});

test('memory: a setlist within the budget is pinned whole ({pin:replace}); neighbours join it ({pin:add})', async () => {
  const { store, engine, ctl, events } = await setup({ setlist: 8, engineOpts: { mbPerSong: 50 } }); // 400 MB
  const set = store.navIds();
  assert.equal(set.length, 8);
  assert.ok(preloads(engine).some((c) => c[2].pin === 'replace' && c[1].length === 8), 'whole setlist, replace');
  assert.deepEqual([...engine.pinned].sort(), [...set].sort());
  assert.equal(ctl.status.memory.mode, 'setlist');
  assert.equal(ctl.status.memory.setMB, 400);
  assert.equal(ctl.status.memory.note, null);
  assert.equal(events.length, 0);
  engine.clear();
  await ctl.nextSong();
  await settle();
  const pre = preloads(engine);
  assert.ok(pre.length >= 1 && pre.every((c) => c[2].pin === 'add' && c[1].length <= 2), 'neighbours: add');
  assert.equal(engine.pinned.size, 8, 'the setlist stays pinned');
});

test(`memory: a setlist over ${PIN_BUDGET_MB} MB pins current ±2 and warms the rest unpinned, nearest first`, async () => {
  // 12 songs × 60 MB = 720 MB > 600. Window (first song ±2) = 3 songs; warming stops at 0.8 × 700 = 560 MB.
  const { store, engine, ctl, events } = await setup({ setlist: 12, engineOpts: { mbPerSong: 60 } });
  const set = store.navIds();
  assert.deepEqual([...engine.pinned].sort(), set.slice(0, 3).sort(), 'current (index 0) + 2 after it');
  assert.ok(!preloads(engine).some((c) => c[2].pin === 'replace' && c[1].length > 5), 'never pins the whole set');
  const warm = preloads(engine).filter((c) => c[2].pin === 'none').map((c) => c[3][0]);
  assert.deepEqual(warm, set.slice(3, 9), 'warmed unpinned in set order until 9 × 60 = 540 MB (the 10th would pass 560)');
  assert.equal(ctl.status.memory.mode, 'large-set');
  assert.equal(ctl.status.memory.note, LARGE_SET_NOTE);
  assert.equal(ctl.status.memory.setMB, 720);
  assert.deepEqual(events.map((e) => e.note), [LARGE_SET_NOTE], "one 'memory' event");
  assert.equal(ctl.status.ready, true);
  // moving through the set moves the pinned window with it (replace, ≤ 5 songs)
  for (let i = 1; i < 6; i++) {
    await ctl.nextSong();
    await settle();
  }
  assert.equal(store.currentIndex(), 5);
  assert.deepEqual([...engine.pinned].sort(), set.slice(3, 8).sort(), 'index 5: 3..7 pinned');
});

test('memory: an estimate that turns out low after decoding downgrades to the large-set policy', async () => {
  // first estimate 8 × 50 = 400 MB (pinned whole), exact sizes after the preload 8 × 90 = 720 MB
  const { store, engine, ctl } = await setup({ setlist: 8, engineOpts: { mbPerSong: 50, exactMB: 90 } });
  assert.ok(preloads(engine).some((c) => c[2].pin === 'replace' && c[1].length === 8), 'pinned whole first');
  assert.equal(ctl.status.memory.mode, 'large-set');
  assert.ok(engine.pinned.size <= 5, `pins shrank to the window (${engine.pinned.size})`);
  assert.ok(engine.pinned.has(store.get().settings.currentSongId));
});

test('memory: an engine without estimatePreloadMB keeps the old setlist behaviour (pin the setlist)', async () => {
  const { engine, ctl } = await setup({ setlist: 8, engineOpts: { estimate: false } });
  assert.ok(preloads(engine).some((c) => c[2].pin === 'replace' && c[1].length === 8));
  assert.equal(ctl.status.memory.mode, 'setlist');
  assert.equal(ctl.status.memory.setMB, null);
});

test('memory: status.memory carries decodedMB / pinnedMB / capMB from engine._debugStats()', async () => {
  const { ctl, timers } = await setup();
  assert.deepEqual(ctl.status.memory, { mode: 'library', decodedMB: 123.4, pinnedMB: 45.6, capMB: 700, setMB: null, note: null });
  timers.runIntervals(); // the watchdog tick refreshes it
  assert.equal(ctl.status.memory.decodedMB, 123.4);
});

test('memory: an older, slower replace that finishes last does not win (newest window re-applied)', async () => {
  const store = makeStore();
  store.setCurrentSetlist(null);
  const engine = pinEngine(store);
  const held = [];
  const base = engine.preload;
  let hold = false;
  engine.preload = (patches, opts) => {
    if (!hold) return base(patches, opts);
    return new Promise((resolve) => held.push(() => resolve(base(patches, opts))));
  };
  const ctl = mkCtl(store, engine);
  await ctl.start();
  await settle();
  const order = store.get().songOrder;
  hold = true;
  await ctl.selectSong(order[5]);
  await ctl.selectSong(order[10]);
  await settle();
  hold = false;
  assert.equal(held.length, 2);
  held[1](); // the newer window (around 10) finishes first
  await settle();
  held[0](); // the older window (around 5) finishes last and re-applies its pins
  await settle();
  assert.deepEqual([...engine.pinned].sort(), [order[9], order[10], order[11]].sort(), 'newest window pinned');
});
