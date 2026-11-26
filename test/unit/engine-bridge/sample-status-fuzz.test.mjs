// Lane F1 skeptic (review F1, O-AW-4): randomised interleavings of the core's `load {phase:'samples'}` events and
// `get sampleStatus` replies. The transport is FIFO, every core message computes its value when it is sent, and the
// adversary picks when the core answers, when a decode lands (with or without an event), where batches split and
// when the page's microtasks run. Invariant at quiescence: for every sampler id the shim's `_loaded` equals the last
// word the core sent about it (and so the core's truth when every change was reported). A control run with the
// lane-F1 re-ask disabled must diverge on some seed, so the fuzz is not vacuous.
// Lane F2 (O-AW-F2): the core also reports eviction, trim and rate changes, once per control tick, naming only the
// samplers whose state differs from the last word it sent (CacheServiceImpl::emitSampleChanges). The `ticks` mode
// models that: changes land silently and the adversary picks when the tick's diff goes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeEngine } from '../../../app/js/engine-bridge/bridge-engine.js';
import { MockNative } from '../../../app/js/engine-bridge/mock-native.js';
import { loopbackPair } from '../../../app/js/engine-bridge/transports.js';
import { api, fakeEnv, flush } from './helpers.mjs';

const IDS = ['salamander-piano', 'vibes', 'celesta', 'nylon-guitar', 'rhodes'];
const SEEDS = 600;
const STEPS = 80;
/** FUZZ_TRACE=<seed> prints that seed's core messages. */
const TRACE = process.env.FUZZ_TRACE ? Number(process.env.FUZZ_TRACE) : 0;
const log = (seed, ...a) => {
  if (seed === TRACE) console.log(...a);
};

/** mulberry32: a small seeded PRNG (deterministic per seed). */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A core whose sampleStatus answers wait for the adversary; its decodes land when the adversary says. */
class FuzzCore extends MockNative {
  constructor(o) {
    super(o);
    this.truth = new Map(IDS.map((id) => [id, false]));
    this.lastWord = new Map();
    this.pendingSS = [];
  }

  _emitSamples() {} // the adversary sends the events

  op_get(m) {
    if (m.what !== 'sampleStatus') return super.op_get(m);
    this.pendingSS.push(m);
    log(this.seed, 'core asked', m.id, JSON.stringify(m.patches.map((p) => p.slots[0].instrument.id)));
    return undefined;
  }

  answer() {
    const m = this.pendingSS.shift();
    const ids = m.patches.map((p) => p.slots[0].instrument.id);
    const loaded = ids.map((id) => this.truth.get(id) === true);
    ids.forEach((id, i) => this.lastWord.set(id, loaded[i]));
    log(this.seed, 'core answers', m.id, JSON.stringify(ids), JSON.stringify(loaded));
    this._reply(m.id, true, { loaded, failed: ids.map(() => false) });
  }

  /** Lane F2: one control tick's diff, as the core sends it: only the known ids whose truth moved. */
  tick() {
    const loaded = {};
    for (const [id, word] of this.lastWord) {
      if (this.truth.get(id) !== word) loaded[id] = this.truth.get(id);
    }
    const ids = Object.keys(loaded);
    if (!ids.length) return;
    for (const id of ids) this.lastWord.set(id, loaded[id]);
    log(this.seed, 'core tick', JSON.stringify(loaded));
    this._emit('load', { phase: 'samples', loaded });
  }

  change(id, value, event, also) {
    this.truth.set(id, value);
    if (!event) return log(this.seed, 'core silent', id, value);
    const loaded = {};
    for (const x of new Set([id, ...also])) {
      loaded[x] = this.truth.get(x);
      this.lastWord.set(x, loaded[x]);
    }
    log(this.seed, 'core change', id, value, event ? JSON.stringify(loaded) : '(silent)');
    this._emit('load', { phase: 'samples', loaded });
  }
}

async function runSeed(seed, { silent, disableFix, ticks = false, noTick = false }) {
  const rnd = prng(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const subset = () => IDS.filter(() => rnd() < 0.4);
  const env = fakeEnv();
  const { js, native } = loopbackPair({ schedule: 'sync' });
  const core = new FuzzCore({ api, transport: native, now: env.now, timers: env.timers });
  const engine = new BridgeEngine({ transport: js, now: env.now, timers: env.timers });
  const warns = [];
  engine.addEventListener('warn', (e) => warns.push(e.detail.message));
  core.seed = seed;
  if (seed === TRACE) { // FUZZ_TRACE=<seed>: print what the core sent, batch by batch
    const orig = core._flush.bind(core);
    core._flush = () => {
      if (core._out.length) log(seed, 'flush', JSON.stringify(core._out.map((m) => m.re ?? m.phase ?? m.ev)));
      orig();
    };
  }
  await engine.start();
  if (disableFix) Object.defineProperty(engine, '_ssAsking', { get: () => new Map(), set: () => {} });
  const song = (ids) => ({ slots: ids.map((id) => ({ instrument: { type: 'sampler', id } })) });
  const inflight = [];
  for (let s = 0; s < STEPS; s++) {
    const r = rnd();
    if (r < 0.18) inflight.push(engine._refreshSampleStatus(subset()));
    else if (r < 0.22) inflight.push(engine.preload([song(subset())], { pin: 'none' }).catch(() => {}));
    else if (r < 0.26) inflight.push(engine.prepare(song(subset().slice(0, 4))).catch(() => {}));
    else if (r < 0.46) {
      if (core.pendingSS.length) core.answer();
    } else if (r < 0.66) {
      // ticks: a preload / prepare / re-warm event names its ids (30 %); eviction, trim, rate changes are silent
      core.change(pick(IDS), rnd() < 0.7, ticks ? rnd() < 0.3 : !silent || rnd() < 0.75, subset());
    } else if (ticks && r < 0.74) {
      if (!noTick) core.tick();
    } else if (r < 0.82) core._flush();
    else if (r < 0.92) for (let k = Math.floor(rnd() * 4); k >= 0; k--) await null; // a few microtasks only
    else await flush(); // a macrotask: every pending microtask runs
  }
  // quiesce: the core answers everything, nothing more changes
  for (let i = 0; i < 500; i++) {
    if (ticks && !noTick) core.tick(); // the control loop keeps ticking
    while (core.pendingSS.length) core.answer();
    core._flush();
    await flush();
    if (!core.pendingSS.length && !core._out.length && engine._ssNext === null && engine._ssBusy === null) break;
  }
  await Promise.all(inflight);
  assert.equal(core.pendingSS.length, 0, `seed ${seed}: quiesced`);
  const got = new Map(IDS.map((id) => [id, engine._loaded.has(engine._sampleUrl(id))]));
  const want = new Map(IDS.map((id) => [id, core.lastWord.get(id) === true]));
  engine._dispose?.();
  core.close();
  const known = new Map([...core.lastWord.keys()].map((id) => [id, core.truth.get(id)]));
  return { got, want, truth: core.truth, known, lastWord: core.lastWord, warns };
}

const differs = (a, b) => [...a.keys()].filter((k) => a.get(k) !== b.get(k));

test(`F1 skeptic: ${SEEDS} seeded interleavings, every change reported: _loaded = the core's truth`, async () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const { got, want, truth, warns } = await runSeed(seed, { silent: false, disableFix: false });
    assert.deepEqual(differs(got, truth), [], `seed ${seed}: _loaded ${JSON.stringify([...got])} truth ${
      JSON.stringify([...truth])}`);
    assert.deepEqual(differs(got, want), [], `seed ${seed}: last word`);
    assert.deepEqual(warns, [], `seed ${seed}: no warn`);
  }
});

test(`F1 skeptic: ${SEEDS} seeded interleavings with unreported changes (a core before lane F2): _loaded = the core's `
  + 'last word',
  async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { got, want } = await runSeed(seed + 100000, { silent: true, disableFix: false });
      assert.deepEqual(differs(got, want), [], `seed ${seed + 100000}: ${JSON.stringify([...got])} vs ${
        JSON.stringify([...want])}`);
    }
  });

test('F1 skeptic: control, the re-ask disabled: the same fuzz finds a stale `_loaded` (the test can fail)',
  async () => {
    let bad = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { got, truth } = await runSeed(seed, { silent: false, disableFix: true });
      if (differs(got, truth).length) bad += 1;
    }
    assert.ok(bad > 0, 'without the lane-F1 re-ask some interleaving must leave an older reply as the last word');
  });

test(`F2: ${SEEDS} seeded interleavings, silent changes reported by per-tick diffs: every known sampler = the truth`,
  async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { got, want, known, lastWord, warns } = await runSeed(seed + 200000, { ticks: true });
      assert.deepEqual(differs(got, want), [], `seed ${seed + 200000}: last word`);
      assert.deepEqual(differs(lastWord, known), [], `seed ${seed + 200000}: a known sampler left stale`);
      assert.deepEqual(warns, [], `seed ${seed + 200000}: no warn`);
    }
  });

test('F2: control, the tick diff disabled: the same fuzz leaves a known sampler stale (the test can fail)',
  async () => {
    let bad = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { known, lastWord } = await runSeed(seed + 200000, { ticks: true, noTick: true });
      if (differs(lastWord, known).length) bad += 1;
    }
    assert.ok(bad > 0, 'without the lane-F2 tick an evicted / trimmed sampler keeps its last word');
  });
