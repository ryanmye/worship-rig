// O-AW-4 / review S-cue-go S3: the native core never emits `load {phase:'samples'}`; it answers `get sampleStatus`.
// The shim asks after each preload / prepare and fills the cache facade, so controller.songReady (and main.js's
// "Loading n of N") are right on 2.0. The fake core here is the mock without its `samples` events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeEngine } from '../../../app/js/engine-bridge/bridge-engine.js';
import { MockNative } from '../../../app/js/engine-bridge/mock-native.js';
import { loopbackPair } from '../../../app/js/engine-bridge/transports.js';
import { api, fakeEnv, flush } from './helpers.mjs';
import { websocketTransport } from '../../../app/js/engine-bridge/ws-transport.js';
import { startDevhost, devhostBinary } from './devhost-proc.mjs';

/** Like native/core: no `samples` events; `get sampleStatus` answers from `decoded` / `bad` (sampler ids). */
class CoreLikeNative extends MockNative {
  constructor(o) {
    super(o);
    this.decoded = new Set();
    this.bad = new Set();
    this.asked = []; // the ids of each `get sampleStatus`
    this.hold = null; // when set, sampleStatus replies wait until hold() is called
  }

  _emitSamples() {}

  op_get(m) {
    if (m.what !== 'sampleStatus') return super.op_get(m);
    const ids = (m.patches || []).map((p) => p.slots[0].instrument.id);
    this.asked.push(ids);
    const answer = () => this._reply(m.id, true, {
      loaded: ids.map((id) => this.decoded.has(id) || this.bad.has(id)), failed: ids.map((id) => this.bad.has(id)),
    });
    if (this.hold) {
      const prev = this.hold;
      this.hold = () => {
        prev();
        answer();
        this._flush(); // a held reply goes out on its own batch
      };
      return undefined;
    }
    return answer();
  }

  op_cache(m) {
    if (m.action === 'preload') {
      for (const p of m.patches || []) for (const id of this._samplerIds(p)) this.decoded.add(id);
    }
    return super.op_cache(m);
  }
}

function coreRig() {
  const env = fakeEnv();
  const { js, native, log } = loopbackPair({ schedule: 'sync' });
  const core = new CoreLikeNative({ api, transport: native, now: env.now, timers: env.timers });
  const engine = new BridgeEngine({ transport: js, now: env.now, timers: env.timers });
  const warns = [];
  engine.addEventListener('warn', (e) => warns.push(e.detail.message));
  return { env, core, engine, log, warns, native };
}

const sampler = (id) => ({ instrument: { type: 'sampler', id } });
const synth = (id) => ({ instrument: { type: 'synth', id } });
const song = (...slots) => ({ slots });
/** controller.songReady's own reading of the facade (every sample url of every sampler slot is held or failed). */
function ready(engine, patch) {
  const { cache, registry } = engine;
  for (const s of patch.slots) {
    if (!s || s.instrument.type !== 'sampler') continue;
    const def = registry.samplers.get(s.instrument.id);
    for (const L of def.layers) {
      for (const smp of L.samples) if (!cache.has(smp.url) && !cache.failed.has(smp.url)) return false;
    }
  }
  return true;
}
const sampleGets = (log) => log.toNative.filter((m) => m.op === 'get' && m.what === 'sampleStatus');

test('S3: preload resolves with the facade filled from get sampleStatus (no samples event)', async () => {
  const r = coreRig();
  await r.engine.start();
  const a = song(sampler('salamander-piano'), synth('warm-pad'), sampler('vibes'), null);
  const b = song(sampler('ep-rhodes'), null, null, null);
  assert.equal(ready(r.engine, a), false, 'nothing decoded yet');
  await r.engine.preload([a], { pin: 'none' });
  assert.equal(ready(r.engine, a), true, 'decoded sampler song reads ready once preload resolves');
  assert.equal(ready(r.engine, b), false, 'a song that was not preloaded stays cold');
  assert.deepEqual(r.core.asked, [['salamander-piano', 'vibes']], 'one request, sampler ids only, once each');
  assert.equal(r.warns.length, 0);
});

test('S3: a sampler the core reports not decoded reads false; failed samples never wait', async () => {
  const r = coreRig();
  await r.engine.start();
  const a = song(sampler('salamander-piano'), null, null, null);
  await r.engine.preload([a]);
  assert.equal(ready(r.engine, a), true);
  r.core.decoded.delete('salamander-piano'); // evicted
  await r.engine.preload([song(sampler('vibes'))]);
  assert.equal(ready(r.engine, a), true, 'stale until the shim asks about it again');
  r.core.op_cache = function (m) { return MockNative.prototype.op_cache.call(this, m); }; // preload decodes nothing
  await r.engine.preload([a]);
  assert.equal(ready(r.engine, a), false, 'a later preload re-asks and drops the stale true');
  r.core.bad.add('salamander-piano');
  await r.engine.preload([a]);
  assert.equal(ready(r.engine, a), true, 'failed samples count as done (songReady never waits on them)');
});

test('S3: concurrent preloads coalesce into at most one more request; no request per read', async () => {
  const r = coreRig();
  await r.engine.start();
  r.core.hold = () => {};
  const p1 = r.engine.preload([song(sampler('salamander-piano'))]);
  await flush();
  assert.equal(sampleGets(r.log).length, 1, 'first round in flight');
  const p2 = r.engine.preload([song(sampler('vibes'))]);
  const p3 = r.engine.preload([song(sampler('ep-rhodes'), sampler('vibes'))]);
  await flush();
  assert.equal(sampleGets(r.log).length, 1, 'later ids wait for the round in flight');
  const release = r.core.hold;
  r.core.hold = null;
  release();
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(r.core.asked, [['salamander-piano'], ['vibes', 'ep-rhodes']], 'one follow-up round, deduped');
  const before = sampleGets(r.log).length;
  for (let i = 0; i < 50; i++) ready(r.engine, song(sampler('vibes'))); // chips polling every 500 ms
  r.env.advance(5000); // ticks
  await flush();
  assert.equal(sampleGets(r.log).length, before, 'reads and ticks never ask the core');
});

test('S3: prepare asks once for samplers not known decoded, without delaying its token', async () => {
  const r = coreRig();
  await r.engine.start();
  r.core.decoded.add('salamander-piano'); // a realtime prepare is answered once its samples are decoded
  const p = song(sampler('salamander-piano'), synth('warm-pad'), null, null);
  r.core.hold = () => {};
  const tok = await r.engine.prepare(p);
  assert.ok(Number.isInteger(tok), 'the token does not wait for sampleStatus');
  const release = r.core.hold;
  r.core.hold = null;
  release();
  await flush();
  assert.equal(ready(r.engine, p), true);
  assert.equal(r.engine.commit(tok), true);
  await r.engine.prepare(p);
  await flush();
  assert.deepEqual(r.core.asked, [['salamander-piano']], 'a known-decoded sampler is not asked again on prepare');
  await r.engine.prepare(song(synth('warm-pad'), null, null, null));
  await flush();
  assert.equal(r.core.asked.length, 1, 'no sampler: no request');
});

test('S3: the samples event still fills the facade (mock / a core that emits it); a bad reply only warns', async () => {
  const r = coreRig();
  await r.engine.start();
  r.native.post({ v: 1, ev: 'load', phase: 'samples', loaded: { vibes: true } });
  assert.equal(ready(r.engine, song(sampler('vibes'))), true);
  r.native.post({ v: 1, ev: 'load', phase: 'samples', loaded: { vibes: false } });
  assert.equal(ready(r.engine, song(sampler('vibes'))), false);
  r.core.op_get = function (m) {
    if (m.what === 'sampleStatus') return this._reply(m.id, true, { loaded: [] });
    return CoreLikeNative.prototype.op_get.call(this, m);
  };
  assert.equal(await r.engine.preload([song(sampler('vibes'))]), true, 'preload still resolves');
  assert.equal(r.warns.filter((w) => /sampleStatus/.test(w)).length, 1);
});

test('S re-check R1: reloadManifests (a My Samples rescan) re-asks every known sampler; a dropped one reads false',
  async () => {
    const r = coreRig();
    await r.engine.start();
    const a = song(sampler('salamander-piano'), sampler('vibes'), null, null);
    await r.engine.preload([a]);
    assert.equal(ready(r.engine, a), true);
    r.core.decoded.delete('vibes'); // the core's rescan invalidated this sampler's buffers
    await r.engine.reloadManifests();
    assert.deepEqual(r.core.asked.at(-1).sort(), ['salamander-piano', 'vibes'], 'one round for every known id');
    assert.equal(ready(r.engine, song(sampler('salamander-piano'))), true);
    assert.equal(ready(r.engine, a), false, 'no stale true after a rescan');
    const n = r.core.asked.length;
    const fresh = coreRig();
    await fresh.engine.start();
    await fresh.engine.reloadManifests();
    assert.equal(fresh.core.asked.length, 0, 'nothing known: no request');
    assert.equal(r.core.asked.length, n);
  });

// ---- lane F1 (O-AW-4): the core emits `load {phase:'samples'}` itself; the sampleStatus fallback stays --------------
/** native/core after lane F1: a `samples` event before each preload reply and before each prepare reply. */
class EmittingCore extends CoreLikeNative {
  _emitSamples(patches) {
    const loaded = {};
    for (const p of patches) {
      for (const id of this._samplerIds(p)) loaded[id] = this.decoded.has(id) || this.bad.has(id);
    }
    if (Object.keys(loaded).length) this._emit('load', { phase: 'samples', loaded });
  }

  op_prepare(m) {
    for (const id of this._samplerIds(m.patch)) this.decoded.add(id); // a realtime prepare decodes, then answers
    return super.op_prepare(m);
  }
}

function emittingRig() {
  const env = fakeEnv();
  const { js, native, log } = loopbackPair({ schedule: 'sync' });
  const core = new EmittingCore({ api, transport: native, now: env.now, timers: env.timers });
  const engine = new BridgeEngine({ transport: js, now: env.now, timers: env.timers });
  const warns = [];
  engine.addEventListener('warn', (e) => warns.push(e.detail.message));
  return { env, core, engine, log, warns, native };
}

test('F1: with the core\'s samples events the facade is filled from them; a prepare then asks nothing', async () => {
  const r = emittingRig();
  await r.engine.start();
  const a = song(sampler('salamander-piano'), synth('warm-pad'), null, null);
  await r.engine.preload([a]);
  assert.equal(ready(r.engine, a), true);
  assert.deepEqual(r.core.asked, [['salamander-piano']], 'the fallback still asks once per preload (belt and braces)');
  const b = song(sampler('vibes'), null, null, null);
  const tok = await r.engine.prepare(b);
  await flush();
  assert.equal(ready(r.engine, b), true, 'filled from the prepare\'s event');
  assert.equal(r.core.asked.length, 1, 'the event made the sampler known: no sampleStatus after the prepare');
  assert.equal(r.engine.commit(tok), true);
  // proof that the events alone fill it: the fallback switched off
  const q = emittingRig();
  await q.engine.start();
  q.engine._refreshSampleStatus = () => Promise.resolve();
  await q.engine.preload([a]);
  assert.equal(ready(q.engine, a), true, 'from the preload event alone');
  assert.equal(ready(q.engine, b), false);
  await q.engine.prepare(b);
  assert.equal(ready(q.engine, b), true, 'from the prepare event alone');
  assert.equal(sampleGets(q.log).length, 0);
  assert.equal(r.warns.length + q.warns.length, 0);
});

test('F1: an event behind an older sampleStatus reply in one batch: the reply cannot have the last word', async () => {
  const r = emittingRig();
  await r.engine.start();
  const a = song(sampler('salamander-piano'), null, null, null);
  r.core.hold = () => {}; // round 1's reply is sent by hand below
  const p = r.engine.preload([a]);
  await flush();
  const gets = sampleGets(r.log);
  assert.equal(gets.length, 1, 'round 1 in flight');
  r.core.hold = null;
  // the core answered round 1 while the decode was still running (false); in the same control turn the decode
  // lands and its event goes out in the same batch, after the reply. The reply's handler runs in a microtask, after
  // the event: without the re-ask the older `false` would be the last word.
  r.core.decoded.delete('salamander-piano');
  r.core._reply(gets[0].id, true, { loaded: [false], failed: [false] });
  r.core.decoded.add('salamander-piano');
  r.core._emit('load', { phase: 'samples', loaded: { 'salamander-piano': true } });
  r.core._flush();
  await p;
  await flush();
  assert.equal(sampleGets(r.log).length, 2, 'one more round for the overlapping id');
  assert.equal(ready(r.engine, a), true, 'the newest answer wins');
  // the other order (event, then a newer reply) needs nothing more; an event with no round in flight asks nothing
  r.native.post({ v: 1, ev: 'load', phase: 'samples', loaded: { vibes: true } });
  await flush();
  assert.equal(sampleGets(r.log).length, 2);
  assert.equal(ready(r.engine, song(sampler('vibes'))), true);
  assert.equal(r.warns.length, 0);
});

// ---- the real core (opt-in like devhost.test.mjs: RIG_DEVHOST=1 or a rig-devhost path) ---------------------------
const enabled = !!process.env.RIG_DEVHOST && !!devhostBinary();
const skip = enabled ? false : 'opt-in: set RIG_DEVHOST=1 (or a rig-devhost path) after building native/devhost';
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

test('F1 on rig-devhost: the core\'s samples events alone fill _loaded (preload, cold and warm prepare)', { skip },
  async () => {
    const host = await startDevhost({ extra: ['--seed', '3'] });
    const engine = new BridgeEngine({ transport: websocketTransport({ url: host.wsUrl }), app: 'lane-f1' });
    const events = [];
    const onLoad = engine._onLoad.bind(engine);
    engine._onLoad = (m) => {
      if (m.phase === 'samples' || m.phase === 'preload') events.push({ ...m, at: Date.now() });
      return onLoad(m);
    };
    const asked = [];
    const fallback = engine._refreshSampleStatus.bind(engine);
    engine._refreshSampleStatus = (ids) => {
      asked.push(ids);
      return Promise.resolve(); // switched off: whatever _loaded holds now came from the core's events
    };
    const url = (id) => engine._sampleUrl(id);
    try {
      const info = await engine._hello;
      assert.ok(info.minor >= 5, `hello minor ${info.minor}`);
      await engine.start().catch(() => {});
      engine._started = true;
      assert.equal(engine._loaded.size, 0);
      // a cold preload (real MP3 decodes): one samples event, before the preload event, naming the sampler true
      await engine.preload([song(sampler('vibes'), synth('warm-pad'), null, null)], { pin: 'add' });
      const ev = events.filter((e) => e.phase === 'samples');
      assert.equal(ev.length, 1, JSON.stringify(events));
      assert.deepEqual(ev[0].loaded, { vibes: true });
      assert.ok(events.indexOf(ev[0]) < events.findIndex((e) => e.phase === 'preload'), 'before load {preload}');
      assert.equal(engine._loaded.has(url('vibes')), true, 'filled from the event');
      // a cold prepare: its event once the samples are decoded (the CORE2A reply comes after them)
      const tok = await engine.prepare(song(sampler('celesta'), null, null, null));
      assert.equal(engine._loaded.has(url('celesta')), true, 'filled from the prepare event before the token');
      assert.equal(engine.commit(tok), true);
      // a warm prepare: an event again, still true
      const n = events.length;
      await engine.prepare(song(sampler('vibes'), null, null, null));
      await wait(50);
      assert.deepEqual(events.slice(n).filter((e) => e.phase === 'samples').map((e) => e.loaded), [{ vibes: true }]);
      // the events agree with the core's own answer
      const st = await engine._req('get', { what: 'sampleStatus', patches: [song(sampler('vibes')),
        song(sampler('celesta')), song(sampler('salamander-piano'))] });
      assert.deepEqual(st.loaded, [true, true, false]);
      assert.equal(engine._loaded.has(url('salamander-piano')), false, 'never named: never claimed');
      // the fallback back on: a prepare of samplers the events made known asks nothing; a preload still asks once
      engine._refreshSampleStatus = (ids) => {
        asked.push(ids);
        return fallback(ids);
      };
      asked.length = 0;
      await engine.prepare(song(sampler('celesta'), sampler('vibes'), null, null));
      assert.deepEqual(asked, [[]], 'no id to ask about after a prepare');
      await engine.preload([song(sampler('vibes'))], { pin: 'none' });
      assert.deepEqual(asked.at(-1), ['vibes'], 'belt and braces after a preload');
      assert.equal(engine._loaded.has(url('vibes')), true);
    } finally {
      engine._dispose?.();
      await host.stop();
    }
  });

test('F2 on rig-devhost: a cache trim (low resource, the memory-pressure trim as an op) turns the trimmed song\'s '
  + 'songReady false, by one event naming it alone', { skip }, async () => {
  const host = await startDevhost({ extra: ['--seed', '3'] });
  const engine = new BridgeEngine({ transport: websocketTransport({ url: host.wsUrl }), app: 'lane-f2' });
  const events = [];
  const onLoad = engine._onLoad.bind(engine);
  engine._onLoad = (m) => {
    if (m.phase === 'samples') events.push(m);
    return onLoad(m);
  };
  const samplesSince = (n) => events.slice(n).map((e) => e.loaded);
  try {
    await engine._hello;
    await engine.start().catch(() => {});
    engine._started = true;
    if (!engine.registry.samplers.size) await engine._refreshInstruments();
    const playing = song(sampler('vibes'), null, null, null);
    const other = song(sampler('celesta'), null, null, null);
    const tok = await engine.prepare(playing);
    assert.equal(engine.commit(tok), true);
    await engine.preload([other], { pin: 'none' }); // decoded, unpinned: what a trim gives back
    await wait(100);
    assert.equal(ready(engine, playing), true);
    assert.equal(ready(engine, other), true, 'before: the chip reads ready');
    const n = events.length;
    // Model::setLowResource -> CacheServiceImpl::setLowResource -> BufferCache::trimUnpinned, the same trim as
    // rig_host_memory_pressure(1) (which the devhost has no op for)
    engine.setLowResource(true);
    for (let i = 0; i < 100 && !samplesSince(n).length; i++) await wait(20);
    await wait(150); // nothing else follows
    assert.deepEqual(samplesSince(n), [{ celesta: false }], 'one event, the changed sampler only');
    assert.equal(ready(engine, other), false, 'after: the trimmed song\'s chip is not ready (was: stale ready)');
    assert.equal(ready(engine, playing), true, 'the playing song keeps its samples');
    const st = await engine._req('get', { what: 'sampleStatus', patches: [playing, other] });
    assert.deepEqual(st.loaded, [true, false], 'the event agrees with the core');
    const m = events.length;
    engine.setLowResource(false); // restores pins, drops nothing: no event
    await wait(200);
    assert.deepEqual(samplesSince(m), []);
  } finally {
    engine._dispose?.();
    await host.stop();
  }
});
