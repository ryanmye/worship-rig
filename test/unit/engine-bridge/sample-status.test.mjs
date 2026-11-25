// O-AW-4 / review S-cue-go S3: the native core never emits `load {phase:'samples'}`; it answers `get sampleStatus`.
// The shim asks after each preload / prepare and fills the cache facade, so controller.songReady (and main.js's
// "Loading n of N") are right on 2.0. The fake core here is the mock without its `samples` events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeEngine } from '../../../app/js/engine-bridge/bridge-engine.js';
import { MockNative } from '../../../app/js/engine-bridge/mock-native.js';
import { loopbackPair } from '../../../app/js/engine-bridge/transports.js';
import { api, fakeEnv, flush } from './helpers.mjs';

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
