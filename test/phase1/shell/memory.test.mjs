// morning-prep: decoded-sample memory policy (integration-2 round 2 #3). With no setlist the controller used to pin
// every song of the library ({pin:'replace'} on store.navIds()), so the engine's 700 MB LRU cap could not evict
// (1023.6 MB in the soak). These tests model the engine's pin set from the controller's preload calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController, PIN_BUDGET_MB, LARGE_SET_NOTE, songAloneNote } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { FACTORY_SONGS } from '../../../app/js/presets.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await tick();
};

/**
 * Fake engine whose preload() records pins like BufferCache (replace = set, add = union, none = warm only) and
 * whose estimatePreloadMB() prices every song at `mbPerSong` (deduplicated; `exact` once every song was preloaded).
 * `exactMB` overrides the price once a song was preloaded (an estimate that turns out low after decoding).
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
      // like BufferCache.estimateBytes: exact once every song was decoded (preloaded) before
      const exact = ids.every((id) => engine.warmed.has(id));
      return Promise.resolve({ mb: ids.reduce((s, id) => s + price(id), 0), exact, samples: ids.length, capMB });
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
  // L-8: never-decoded window neighbours are decoded unpinned first (then pinned with exact sizes); skip those
  const win = set.slice(0, 3);
  const warm = preloads(engine).filter((c) => c[2].pin === 'none').flatMap((c) => c[3]).filter((id) => !win.includes(id));
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
  assert.deepEqual(ctl.status.memory, {
    mode: 'library', decodedMB: 123.4, pinnedMB: 45.6, capMB: 700, budgetMB: PIN_BUDGET_MB, setMB: null,
    windowMB: 40, pinnedSongs: 2, note: null, // L-8: first song + next, 20 MB each
  });
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
  // L-8: a window still being planned when the next switch arrives is dropped before it pins (winSeq), so only
  // windows that reached engine.preload are held here
  assert.ok(held.length >= 1 && held.length <= 2, `held ${held.length}`);
  held[held.length - 1](); // the newer window (around 10) finishes first
  await settle();
  if (held.length === 2) held[0](); // the older window (around 5) finishes last and re-applies its pins
  await settle();
  assert.deepEqual([...engine.pinned].sort(), [order[9], order[10], order[11]].sort(), 'newest window pinned');
});

// ---- L-8 (local Mac soak, reviews/local-findings.md): pinned 754 MB on gospel-stab-b3 and 939 MB on upright-pad
// (cap 700) with the count window (current ±2). Sizes per sampler instrument, decoded, as the soak implies:
// Salamander 333 MB (morning-prep), upright 421 (754 − 333), clav+wurli and music-box+celesta ≈ 185 together
// (939 − 754). Synth/organ-only songs cost nothing.
const L8_MB = { 'salamander-piano': 333, 'upright-piano': 421, 'ep-rhodes': 93, clavinet: 48, 'ep-wurli': 47,
  'music-box': 45, celesta: 45 };

/**
 * Fake engine priced per sampler instrument (shared instruments counted once, like BufferCache). Pins follow
 * BufferCache: 'replace' = set, 'add' = union. pinnedMB / decodedMB in _debugStats come from the pinned set.
 */
function instrEngine(store, { sizes = L8_MB, capMB = 700 } = {}) {
  const engine = fakeEngine();
  const idOf = (patch) => store.get().songOrder.find((id) => store.getSong(id).patch === patch);
  const instrOf = (id) => (store.getSong(id).patch.slots || [])
    .filter((sl) => sl && sl.instrument && sl.instrument.type === 'sampler').map((sl) => sl.instrument.id);
  const mbOf = (ids) => [...new Set(ids.flatMap(instrOf))].reduce((a, k) => a + (sizes[k] || 0), 0);
  engine.pinned = new Set();
  engine.decoded = new Set(); // instrument ids (sizes are known per sample once decoded, shared between songs)
  engine.pinLog = []; // [currentSongId, pinned ids after the call, pin mode]
  engine.preload = (patches, opts) => {
    const ids = patches.map(idOf);
    engine.calls.push(['preload', patches, opts, ids]);
    if (opts.pin === 'replace') engine.pinned = new Set(ids);
    else if (opts.pin === 'add') for (const id of ids) engine.pinned.add(id);
    for (const k of ids.flatMap(instrOf)) engine.decoded.add(k);
    engine.pinLog.push([store.get().settings.currentSongId, [...engine.pinned], opts.pin, mbOf([...engine.pinned])]);
    return Promise.resolve(true);
  };
  engine.estimatePreloadMB = (patches) => {
    const ids = [...new Set(patches.map(idOf))];
    const exact = ids.flatMap(instrOf).every((k) => engine.decoded.has(k)); // no samplers → exact (0 MB)
    return Promise.resolve({ mb: mbOf(ids), exact, samples: 0, capMB });
  };
  engine.pinnedMB = () => mbOf([...engine.pinned]);
  engine._debugStats = () => {
    const mb = engine.pinnedMB();
    return { voices: 0, nodes: 0, decodedMB: mb, pinnedMB: mb, capMB };
  };
  return engine;
}

async function l8Setup({ library = false, sizes } = {}) {
  const store = makeStore(); // seed: "My Set" = the 19 factory songs in library order (the soak's set)
  if (library) store.setCurrentSetlist(null);
  const engine = instrEngine(store, { sizes });
  const ctl = mkCtl(store, engine);
  const events = [];
  const warns = [];
  ctl.addEventListener('memory', (e) => events.push(e.detail));
  ctl.addEventListener('warn', (e) => warns.push(e.detail.message));
  await ctl.start();
  await settle(16);
  return { store, engine, ctl, events, warns };
}

/** The ids of the current ±radius nav window. */
const windowOf = (store, radius) => {
  const ids = store.navIds();
  const i = ids.indexOf(store.get().settings.currentSongId);
  return ids.slice(Math.max(0, i - radius), i + radius + 1);
};

for (const mode of ['large-set', 'library']) {
  test(`memory L-8 (${mode}): a 44-switch walk over the soak's sizes never pins more than ${PIN_BUDGET_MB} MB`, async () => {
    const { store, engine, ctl, warns } = await l8Setup({ library: mode === 'library' });
    const radius = mode === 'library' ? 1 : 2;
    assert.equal(ctl.status.memory.mode, mode);
    const n = store.navIds().length;
    assert.equal(n, FACTORY_SONGS.length);
    // start() pins the first song's neighbour with 'add' before preloadSetlist() picks the policy (engine-core #10,
    // controller.test.mjs); the replace that follows drops it. From here on, only the switches count.
    engine.pinLog.length = 0;
    let dir = 1;
    let peak = 0;
    const seen = {};
    for (let step = 0; step < 44; step++) {
      const i = store.currentIndex();
      if (i + dir < 0 || i + dir >= n) dir = -dir;
      await (dir > 0 ? ctl.nextSong() : ctl.prevSong());
      await settle(16);
      const cur = store.get().settings.currentSongId;
      const pinned = [...engine.pinned];
      const mb = engine.pinnedMB();
      peak = Math.max(peak, mb);
      seen[store.getSong(cur).factoryId] = mb;
      assert.ok(mb <= PIN_BUDGET_MB, `step ${step} on ${cur}: pinned ${mb} MB > ${PIN_BUDGET_MB}`);
      assert.ok(pinned.includes(cur), `step ${step}: the current song is pinned`);
      const win = windowOf(store, radius);
      const outside = pinned.filter((id) => !win.includes(id));
      assert.deepEqual(outside, [], `step ${step}: nothing outside ±${radius} pinned`);
      assert.equal(ctl.status.memory.pinnedMB, mb);
      assert.ok(ctl.status.memory.windowMB <= PIN_BUDGET_MB);
      assert.equal(ctl.status.memory.pinnedSongs, pinned.length);
      assert.equal(ctl.status.memory.budgetMB, PIN_BUDGET_MB);
    }
    // every pin state the engine ever held (also mid-switch) stayed within the budget
    const worst = engine.pinLog.reduce((m, r) => Math.max(m, r[3]), 0);
    assert.ok(worst <= PIN_BUDGET_MB, `worst pin state ${worst} MB`);
    assert.ok(!engine.pinLog.some((r) => r[2] === 'add'), 'windows are replaced, never added to');
    assert.deepEqual(warns.filter((w) => /cache cap/.test(w)), []);
    if (mode === 'large-set') {
      // the two L-8 spots: gospel-stab (anthem 333 + upright 421 = 754 before) and upright-pad (939 before)
      assert.equal(seen['factory:gospel-stab-b3'], 421 + 95, 'gospel-stab: upright + clav-funk, Salamander left out');
      assert.equal(seen['factory:upright-pad'], 421 + 95, 'upright-pad: + clav-funk; music-box (606) and anthem out');
    }
    assert.ok(peak > 400, `the walk reached the heavy songs (peak ${peak} MB)`);
  });
}

test('memory L-8: a switch replaces the window in one call — the previous window is never left pinned', async () => {
  const { store, engine, ctl } = await l8Setup();
  const order = store.navIds();
  const jumps = [13, 12, 0, 18, 4, 13, 14, 2];
  for (const k of jumps) {
    engine.pinLog.length = 0;
    await ctl.selectSong(order[k]);
    await settle(16);
    const win = windowOf(store, 2);
    // every pin state during this switch is a subset of the new window: an old window never survives a call
    for (const [, pinned, pin] of engine.pinLog) {
      assert.ok(pin === 'replace' || pin === 'none', `pin mode ${pin}`);
      assert.deepEqual(pinned.filter((id) => !win.includes(id)), [], `switch to ${k}: stale pins ${pinned}`);
    }
    assert.ok(engine.pinned.has(order[k]));
  }
});

test('memory L-8: a song that alone passes the budget is pinned alone, with a note and one warn over the cap', async () => {
  const sizes = { ...L8_MB, 'upright-piano': 812 };
  const { store, engine, ctl, events, warns } = await l8Setup({ sizes });
  const up = store.navIds().find((id) => store.getSong(id).factoryId === 'factory:upright-pad');
  await ctl.selectSong(up);
  await settle(16);
  assert.deepEqual([...engine.pinned], [up], 'only the oversized current song is pinned');
  assert.equal(ctl.status.memory.note, songAloneNote(812));
  assert.equal(ctl.status.memory.note, 'This song alone is 812 MB');
  assert.equal(ctl.status.memory.pinnedSongs, 1);
  assert.ok(events.some((e) => e.note === 'This song alone is 812 MB' && e.songMB === 812), "a 'memory' event");
  // 812 > 700: the post-preload check warns (once per crossing), never throws
  assert.equal(warns.filter((w) => /exceed the 700 MB cache cap/.test(w)).length, 1, warns.join(' | '));
  const tickWarns = warns.length;
  // neighbours that include the oversized song are left out by the budget; the note goes with it
  await ctl.selectSong(store.navIds()[12]); // gospel-stab: upright (812) doesn't fit, clav-funk does
  await settle(16);
  assert.ok(!engine.pinned.has(up), 'the oversized neighbour is not pinned');
  assert.ok(engine.pinnedMB() <= PIN_BUDGET_MB);
  assert.equal(ctl.status.memory.note, LARGE_SET_NOTE);
  assert.equal(warns.length, tickWarns, 'no further warn once back under the cap');
});

test('memory L-8: never-decoded neighbours are decoded unpinned first, then pinned with exact sizes', async () => {
  const { store, engine, ctl } = await l8Setup();
  const order = store.navIds();
  const fid = (id) => store.getSong(id).factoryId;
  const at = (f) => order.find((id) => fid(id) === f);
  const clav = at('factory:clav-funk'); // index 14; upright (13) and music-box (15) never decoded yet
  assert.equal(order.indexOf(clav), 14);
  engine.pinLog.length = 0;
  engine.clear();
  await ctl.selectSong(clav);
  await settle(16);
  const reps = engine.pinLog.filter((r) => r[2] === 'replace');
  const warm = engine.pinLog.findIndex((r) => r[2] === 'none');
  const w = engine.calls.filter((c) => c[0] === 'preload' && c[2].pin === 'none')[0][3].map(fid).sort();
  assert.deepEqual(w, ['factory:music-box-lullaby', 'factory:upright-pad'], 'the guessed neighbours warm unpinned');
  // first replace: current + the neighbours whose size is exact (synth/organ-only songs), no guessed ones
  assert.deepEqual(reps[0][1].map(fid).sort(), ['factory:clav-funk', 'factory:dream-juno', 'factory:gospel-stab-b3']);
  assert.ok(engine.pinLog.findIndex((r) => r[2] === 'replace') < warm, 'pinned before the warm');
  // then, with exact sizes: music-box joins (95 + 90 = 185), upright (421 → 606) doesn't
  assert.deepEqual([...engine.pinned].map(fid).sort(),
    ['factory:clav-funk', 'factory:dream-juno', 'factory:gospel-stab-b3', 'factory:music-box-lullaby']);
  assert.equal(engine.pinnedMB(), 185);
  assert.equal(ctl.status.memory.windowMB, 185);
});
