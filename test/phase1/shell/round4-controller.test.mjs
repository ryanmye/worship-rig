// round4-controller (reviews/round4-controller.md): regression tests for C1–C9 and C13, from the reviewer's
// experiments (E1 pins, E2 takeover, E4 restart + switch, E5 misc, E6 store lock). Each assert states the correct
// behaviour; against the pre-fix controller/store every test here fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController, engineLatency, PIN_BUDGET_MB, LARGE_SET_NOTE } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { createStore, memoryStorage } from '../../../app/js/store.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

const settle = async (n = 16) => {
  for (let i = 0; i < n; i++) await tick();
};

function mk(store, engine, extra = {}) {
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const ctl = createController({ store, engine, midi, timers: fakeTimers(), heartbeat: false, indexedDB: null,
    recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(), rig: null, now: () => 0, locks: null, ...extra });
  return { ctl, midi };
}

/** Web Locks stand-in: the instance lock is held by "the other window" until `release()` of a waiter. */
function fakeLocks() {
  const waiters = [];
  const held = [];
  return {
    waiters,
    held,
    request(name, opts, cb) {
      if (opts.ifAvailable) return Promise.resolve(cb(null));
      return new Promise((resolve) => waiters.push(() => {
        const p = cb({ name });
        held.push(p);
        resolve(p);
      }));
    },
  };
}

// ---- C1: restart + song switch overlap

/** Token/state model of AudioEngine prepare/commit/restart (audio.js restart → applyState re-applies its capture). */
function modelEngine() {
  const e = new EventTarget();
  e.ctx = { state: 'running', currentTime: 0, resume: () => Promise.resolve() };
  e.latencyMs = 10;
  e.state = { patch: null, transpose: 0, tempo: null, key: null, routing: null };
  e.latest = 0;
  e.holds = [];
  e.prepared = new Map();
  let seq = 0;
  e.start = () => Promise.resolve();
  e.prepare = (patch) => {
    const tok = ++seq;
    e.latest = tok;
    e.prepared.set(tok, patch);
    return new Promise((resolve) => e.holds.push({ tok, release: () => resolve(tok) }));
  };
  e.commit = (tok) => {
    if (tok !== e.latest) return false;
    e.state.patch = e.prepared.get(tok);
    return true;
  };
  e.setTranspose = (s) => { e.state.transpose = s; };
  e.setTempo = (t) => { e.state.tempo = t; };
  e.setRouting = (r) => { e.state.routing = r; };
  e.setKeyContext = () => {};
  e.drone = { setKey: (pc) => { e.state.key = pc; }, configure: () => {} };
  for (const n of ['preload', 'setParam', 'noteOn', 'noteOff', 'sustain', 'allNotesOff', 'setMono', 'swell']) e[n] = () => {};
  e.restart = async () => {
    const s = JSON.parse(JSON.stringify(e.state));
    const patch = e.state.patch;
    await e.start();
    const tok = await e.prepare(patch); // applyState: prepare + commit the captured patch …
    e.commit(tok); // … refused (stale) when a switch prepared meanwhile, and the tail runs anyway:
    e.setRouting(s.routing);
    e.setTranspose(s.transpose);
    e.setTempo(s.tempo);
    e.drone.setKey(s.key);
  };
  e.releaseTok = (tok) => e.holds.splice(e.holds.findIndex((h) => h.tok === tok), 1)[0].release();
  e.releaseAll = async () => {
    while (e.holds.length) {
      e.holds.shift().release();
      await settle();
    }
  };
  return e;
}

test('C1: a switch that commits during restart() keeps its own transpose, tempo and drone key', async () => {
  const store = makeStore();
  store.setCurrentSetlist(null);
  const ids = store.get().songOrder;
  store.selectSongId(ids[0]);
  store.set(`songs.${ids[0]}.hearIn`, 2);
  store.set(`songs.${ids[0]}.tempo`, 70);
  store.set(`songs.${ids[1]}.hearIn`, 7);
  store.set(`songs.${ids[1]}.tempo`, 140);
  store.flush();
  const engine = modelEngine();
  const { ctl } = mk(store, engine);
  const sp = ctl.start();
  await settle();
  await engine.releaseAll();
  await sp;
  await settle();
  assert.equal(engine.state.tempo, 70);
  const r = ctl.restartAudio(); // Restart sound / watchdog / latency change
  await settle();
  const restartTok = engine.holds[0].tok;
  const sel = ctl.nextSong(); // Next at the same moment
  await settle();
  engine.releaseTok(engine.holds.find((h) => h.tok !== restartTok).tok); // the switch's prepare finishes first
  await settle();
  engine.releaseTok(restartTok);
  await settle(30);
  await engine.releaseAll();
  await sel;
  await r;
  await settle(30);
  const cur = store.currentSong();
  assert.equal(cur.id, ids[1]);
  assert.equal(engine.state.patch, cur.patch, 'the new patch');
  assert.equal(engine.state.tempo, 140, 'tempo follows the selected song');
  assert.equal(engine.state.transpose, store.transposeSemisOf(cur), 'transpose follows the selected song');
  assert.equal(engine.state.key, 7, 'drone key follows the selected song');
});

// ---- C2 / C3: pins priced on guessed sizes

const SIZES = { 'salamander-piano': 333, 'upright-piano': 421, 'ep-rhodes': 93, clavinet: 48, 'ep-wurli': 47,
  'music-box': 45, celesta: 45 };
// BufferCache.estimateBytes with nothing decoded: 1.75 MB × the manifest's sample count
const GUESSES = { 'salamander-piano': 158, 'upright-piano': 121, 'ep-rhodes': 140, clavinet: 154, 'ep-wurli': 154,
  'music-box': 154, celesta: 154 };

/** Fake engine: real sizes once decoded, guesses before; prepare decodes the song (manual resolve). */
function guessEngine(store, { holdNone = false } = {}) {
  const engine = fakeEngine({ manual: true });
  const idOf = (patch) => store.get().songOrder.find((id) => store.getSong(id).patch === patch);
  const instrOf = (id) => (store.getSong(id).patch.slots || [])
    .filter((sl) => sl && sl.instrument && sl.instrument.type === 'sampler').map((sl) => sl.instrument.id);
  const realMB = (ids) => [...new Set(ids.flatMap(instrOf))].reduce((a, k) => a + (SIZES[k] || 0), 0);
  engine.instrOf = instrOf;
  engine.decoded = new Set();
  engine.pinned = new Set();
  engine.pinLog = []; // [currentSongId, pinned, pin, real MB pinned]
  engine.held = [];
  engine.holdNone = holdNone;
  const apply = (ids, opts) => {
    if (opts.pin === 'replace') engine.pinned = new Set(ids);
    else if (opts.pin === 'add') for (const id of ids) engine.pinned.add(id);
    for (const k of ids.flatMap(instrOf)) engine.decoded.add(k);
    engine.pinLog.push([store.get().settings.currentSongId, [...engine.pinned], opts.pin, realMB([...engine.pinned])]);
  };
  engine.preload = (patches, opts) => {
    const ids = patches.map(idOf);
    engine.calls.push(['preload', patches, opts, ids]);
    if (engine.holdNone && opts.pin === 'none') {
      return new Promise((resolve) => engine.held.push(() => {
        apply(ids, opts);
        resolve(true);
      }));
    }
    apply(ids, opts);
    return Promise.resolve(true);
  };
  engine.estimatePreloadMB = (patches) => {
    const ks = [...new Set([...new Set(patches.map(idOf))].flatMap(instrOf))];
    const exact = ks.every((k) => engine.decoded.has(k));
    const mb = ks.reduce((a, k) => a + (engine.decoded.has(k) ? SIZES[k] || 0 : GUESSES[k] || 0), 0);
    return Promise.resolve({ mb, exact, samples: 0, capMB: 700 });
  };
  engine.realPinnedMB = () => realMB([...engine.pinned]);
  engine._debugStats = () => ({ decodedMB: 0, pinnedMB: engine.realPinnedMB(), capMB: 700 });
  const basePrepare = engine.prepare;
  engine.prepare = (patch) => {
    const p = basePrepare(patch);
    const last = engine.pending[engine.pending.length - 1];
    const r = last.resolve;
    last.resolve = () => {
      for (const k of instrOf(idOf(patch))) engine.decoded.add(k);
      r();
    };
    return p;
  };
  engine.worst = () => engine.pinLog.reduce((m, x) => Math.max(m, x[3]), 0);
  return engine;
}
const drain = async (engine) => {
  while (engine.pending.length) {
    engine.pending.shift().resolve();
    await settle();
  }
};
async function startGuess(store, opts) {
  const engine = guessEngine(store, opts);
  const { ctl } = mk(store, engine);
  const events = [];
  const warns = [];
  ctl.addEventListener('memory', (e) => events.push(e.detail));
  ctl.addEventListener('warn', (e) => warns.push(e.detail.message));
  const sp = ctl.start();
  await settle();
  await drain(engine);
  await sp;
  await settle(30);
  await drain(engine);
  await settle(30);
  return { engine, ctl, events, warns };
}
const byFactory = (store, f) => store.get().songOrder.find((id) => store.getSong(id).factoryId === `factory:${f}`);

test('C2: launching with a small setlist sized on guesses never pins it whole past the budget', async () => {
  const store = makeStore();
  const f = (x) => byFactory(store, x);
  store.setCurrentSetlist(store.addSetlist('Sunday', [f('grand-piano'), f('prayer-wash'), f('upright-pad'),
    f('building-swell')]));
  const { engine, ctl, events, warns } = await startGuess(store);
  // guessed 333 + 121 = 454 ≤ 600, really 754: the old controller pinned all of it (754 MB > the 700 MB cap)
  assert.ok(engine.worst() <= PIN_BUDGET_MB, `pinned ${engine.worst()} MB`);
  assert.equal(ctl.status.memory.mode, 'large-set');
  assert.equal(ctl.status.memory.setMB, 754, 'exact size after the sizing pass');
  assert.deepEqual(events.map((e) => e.note), [LARGE_SET_NOTE], "one 'memory' event, only once it doesn't fit");
  assert.deepEqual(warns.filter((w) => /cache cap/.test(w)), []);
});

test('C2: a guessed setlist that really fits is pinned whole after sizing, reported as setlist throughout', async () => {
  const store = makeStore();
  const f = (x) => byFactory(store, x);
  const rhodes = store.get().songOrder.find((id) => {
    const k = guessEngine(store).instrOf(id);
    return k.length && k.every((x) => x === 'ep-rhodes');
  });
  assert.ok(rhodes, 'a Rhodes-only factory song');
  const set = [f('grand-piano'), f('prayer-wash'), rhodes, f('building-swell')];
  store.setCurrentSetlist(store.addSetlist('Sunday', set));
  const engine = guessEngine(store);
  const { ctl } = mk(store, engine);
  const modes = [];
  ctl.addEventListener('status', () => ctl.status.memory && modes.push([ctl.status.memory.mode, ctl.status.memory.note]));
  const events = [];
  ctl.addEventListener('memory', (e) => events.push(e.detail));
  const sp = ctl.start();
  await settle();
  await drain(engine);
  await sp;
  await settle(40);
  await drain(engine);
  await settle(40);
  assert.deepEqual([...engine.pinned].sort(), [...set].sort(), 'the whole set pinned (333 + 93 = 426 MB)');
  assert.ok(engine.worst() <= PIN_BUDGET_MB);
  assert.equal(ctl.status.memory.mode, 'setlist');
  assert.equal(ctl.status.memory.setMB, 426);
  assert.deepEqual(events, [], 'no large-set event');
  assert.ok(modes.every(([m, n]) => m !== 'large-set' && n !== LARGE_SET_NOTE), JSON.stringify(modes));
});

test('C3: a phase-2 re-plan finishing during the next switch does not pin around the loading song', async () => {
  const store = makeStore(); // "My Set" = 19 factory songs → large-set
  const { engine, ctl } = await startGuess(store);
  const order = store.navIds();
  const idx = (x) => order.indexOf(byFactory(store, x));
  engine.holdNone = true;
  const p1 = ctl.selectSong(order[idx('clav-funk')]); // its neighbours (upright, music-box) warm unpinned, held
  await settle();
  await drain(engine);
  await p1;
  await settle();
  engine.decoded.delete('upright-piano');
  const p2 = ctl.selectSong(order[idx('upright-pad')]); // prepare held
  await settle();
  engine.pinLog.length = 0;
  engine.holdNone = false;
  for (const fn of engine.held.splice(0)) fn(); // the older window's warm finishes → its re-plan
  await settle(30);
  assert.ok(engine.worst() <= PIN_BUDGET_MB, `pinned ${engine.worst()} MB before the switch commits`);
  // the superseded window stops (winSeq moves when the switch starts): the song still playing stays pinned
  assert.ok(engine.pinned.has(order[idx('clav-funk')]), 'the playing song stays pinned while the next one loads');
  await drain(engine);
  await p2;
  await settle(30);
  assert.ok(engine.worst() <= PIN_BUDGET_MB);
  assert.ok(engine.pinned.has(order[idx('upright-pad')]));
});

test('C3: setCurrentSetlist whose first song is still loading plans no window on its guess', async () => {
  const store = makeStore();
  store.setCurrentSetlist(null);
  const { engine } = await startGuess(store);
  const f = (x) => byFactory(store, x);
  const anthem = store.get().songOrder.find((id) => engine.instrOf(id).includes('salamander-piano'));
  for (const k of ['salamander-piano', 'ep-rhodes', 'clavinet', 'ep-wurli', 'music-box', 'celesta']) engine.decoded.add(k);
  engine.decoded.delete('upright-piano');
  const setId = store.addSetlist('Sunday', [f('upright-pad'), anthem, f('clav-funk'), f('music-box-lullaby')]);
  engine.pinLog.length = 0;
  store.setCurrentSetlist(setId); // current → upright-pad (prepare held); preloadSetlist runs meanwhile
  await settle(30);
  assert.ok(engine.worst() <= PIN_BUDGET_MB, `pinned ${engine.worst()} MB while upright-pad was loading`);
  await drain(engine);
  await settle(40);
  assert.ok(engine.worst() <= PIN_BUDGET_MB, `pinned ${engine.worst()} MB`);
});

test('C3: a nav edit during a jump to an undecoded heavy song keeps the pins within the budget', async () => {
  const store = makeStore();
  const { engine, ctl } = await startGuess(store);
  const order = store.navIds();
  assert.equal(ctl.status.memory.mode, 'large-set');
  const p0 = ctl.selectSong(order[2]);
  await settle();
  await drain(engine);
  await p0;
  await settle(30);
  engine.decoded = new Set(['salamander-piano', 'clavinet', 'ep-wurli']);
  const p = ctl.selectSong(order[13]); // upright-pad, prepare held
  await settle();
  engine.pinLog.length = 0;
  store.addToSetlist(store.get().settings.currentSetlistId, order[18]); // Edit view nav edit → preloadSetlist()
  await settle(40);
  assert.ok(engine.worst() <= PIN_BUDGET_MB, `pinned ${engine.worst()} MB (old: 849)`);
  await drain(engine);
  await p;
  await settle(40);
  assert.ok(engine.worst() <= PIN_BUDGET_MB);
});

// ---- C4: H1 lock

test('C4: the backup-failed lock survives a second-window round trip; the unreadable library is not overwritten', () => {
  const data = new Map([['rig.v1', '{corrupt']]);
  const storage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => {
      if (k.includes('backup')) throw new Error('QuotaExceededError');
      data.set(k, v);
    },
    removeItem: (k) => data.delete(k),
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i],
  };
  const store = createStore({ storage, requestIdle: null, warn: () => {}, autoFlush: false });
  assert.equal(store.loadInfo.readOnlyReason, 'backup-failed');
  assert.equal(store.setReadOnly(true, 'second-window'), false, 'enterSecondary keeps the H1 reason');
  store.setReadOnly(false); // takeover
  assert.equal(store.loadInfo.readOnlyReason, 'backup-failed');
  store.persistNow();
  assert.equal(data.get('rig.v1'), '{corrupt', 'the only copy is untouched');
  assert.equal(store.allowOverwrite(), true, 'an explicit disk backup still unlocks it');
  assert.equal(store.loadInfo.readOnly, false);
});

// ---- C5 is covered in memory.test.mjs ("a song that alone passes the budget …")

// ---- C6 / C7 / C13: secondary → primary takeover

test('C6: takeover applies the other window’s latency before start(); no restart() and one prepare', async () => {
  const storage = memoryStorage();
  const other = makeStore({ storage });
  other.persistNow();
  const store = makeStore({ storage });
  const engine = fakeEngine();
  engine.latency = engineLatency(store.get().settings); // as main.js constructs it
  let startResolve;
  engine.start = () => {
    engine.calls.push(['start', engine.latency]);
    return new Promise((r) => {
      startResolve = r;
    });
  };
  const locks = fakeLocks();
  const { ctl } = mk(store, engine, { locks });
  const viewPaths = [];
  store.subscribe((s, paths) => viewPaths.push(...paths)); // a view: still gets the reload diff
  await ctl.start();
  assert.equal(ctl.status.instance, 'secondary');
  const ids = other.navIds();
  const before = store.get().settings.latency;
  const next = before === 'safe' ? 'balanced' : 'safe';
  other.set('settings.latency', next);
  other.selectSongId(ids[3], 3);
  other.persistNow();
  engine.clear();
  locks.waiters.shift()(); // the other window closed
  await settle();
  assert.deepEqual(engine.names(), ['start'], 'nothing but start() while it is pending');
  assert.equal(engine.calls[0][1], engineLatency({ latency: next }), 'the engine starts with the new latency');
  assert.ok(viewPaths.includes('settings.latency'), 'views still see the reloaded settings');
  startResolve();
  await settle(30);
  assert.equal(engine.of('restart').length, 0, 'no restart');
  assert.equal(engine.of('prepare').length, 1, 'the song is prepared once');
  assert.equal(store.get().settings.currentSongId, ids[3]);
  assert.equal(ctl.status.instance, 'primary');
});

test('C7: a song tapped in the secondary window still gets its drone key after takeover', async () => {
  const storage = memoryStorage();
  const store = makeStore({ storage });
  store.setCurrentSetlist(null);
  const ids = store.get().songOrder;
  store.set(`songs.${ids[2]}.hearIn`, 9);
  store.selectSongId(ids[0]);
  store.persistNow();
  const locks = fakeLocks();
  const engine = fakeEngine();
  const { ctl } = mk(store, engine, { locks });
  await ctl.start();
  assert.equal(ctl.status.instance, 'secondary');
  await ctl.selectSong(ids[2]); // muted window: no engine calls
  const other = makeStore({ storage });
  other.selectSongId(ids[2]);
  other.persistNow();
  engine.clear();
  locks.waiters.shift()();
  await settle(40);
  assert.ok(engine.of('drone.setKey').some((c) => c[1] === 9), JSON.stringify(engine.of('drone.setKey')));
});

test('C13: a controller disposed while secondary releases the instance lock when it is granted', async () => {
  const locks = fakeLocks();
  const { ctl } = mk(makeStore(), fakeEngine(), { locks });
  await ctl.start();
  assert.equal(ctl.status.instance, 'secondary');
  ctl.dispose();
  locks.waiters.shift()();
  await settle();
  const released = await Promise.race([Promise.resolve(locks.held[0]).then(() => true), settle(10).then(() => false)]);
  assert.equal(released, true, 'the lock callback settles, so another window can take over');
});

// ---- C8: panic during a swell

test('C8: after Panic during a swell, the next Swell toggle starts a swell', async () => {
  const engine = fakeEngine();
  const { ctl } = mk(makeStore(), engine);
  await ctl.start();
  await settle();
  assert.equal(ctl.swell(), true);
  ctl.panic(); // engine.allNotesOff() drops the swell
  engine.clear();
  assert.equal(ctl.swell(), true);
  assert.deepEqual(engine.of('swell'), [['swell', true]]);
});

// ---- C9: learned CC buttons

test('C9: a press-only footswitch (127 every press) advances on every press; bounce and held stay one press', async () => {
  const store = makeStore();
  store.setMidiLearn('nextSong', { cc: 80, channel: 0 });
  store.setMidiLearn('swell', { cc: 81, channel: 0 });
  let t = 0;
  const engine = fakeEngine();
  const { ctl, midi } = mk(store, engine, { now: () => t });
  await ctl.start();
  await settle();
  const i0 = store.currentIndex();
  const send = async (cc, v, at) => {
    t = at;
    midi._inject([0xb0, cc, v]);
    await settle();
  };
  await send(80, 127, 1000);
  await send(80, 127, 1010); // contact bounce
  assert.equal(store.currentIndex() - i0, 1);
  await send(80, 127, 2000);
  await send(80, 127, 3000);
  assert.equal(store.currentIndex() - i0, 3, 'press-only: every press');
  await send(80, 0, 3100); // a momentary switch: release, press, release
  await send(80, 127, 4000);
  await send(80, 0, 4100);
  assert.equal(store.currentIndex() - i0, 4, 'momentary: one per press, release does nothing');
  engine.clear();
  await send(81, 127, 5000);
  await send(81, 127, 6000); // swell stays level-triggered (held = swelling)
  await send(81, 0, 7000);
  assert.deepEqual(engine.of('swell'), [['swell', true], ['swell', false]]);
});
