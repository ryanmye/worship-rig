// Lane S review (native/docs/reviews/S-cue-go.md): the skeptic's state-machine probes, kept as regressions.
// S1: a cue / waiting GO on an entry that left the nav list is dropped. S2: no 30 s cap timer outlives its GO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

function cachedEngine({ manualPrepare = false } = {}) {
  const e = fakeEngine({ manual: manualPrepare });
  const loaded = new Set();
  const samplers = new Map();
  e.cache = { entries: new Map(), failed: new Set(), has: (u) => loaded.has(u) };
  e.registry = { samplers };
  e.preloads = [];
  e.preload = (patches, opts = {}) => {
    e.calls.push(['preload', patches, opts]);
    const urls = [];
    for (const p of patches) {
      for (const s of p.slots) {
        if (!s || s.instrument.type !== 'sampler') continue;
        if (!samplers.has(s.instrument.id)) samplers.set(s.instrument.id, sampleDef(s.instrument.id));
        for (const smp of samplers.get(s.instrument.id).layers[0].samples) urls.push(smp.url);
      }
    }
    if (opts.pin !== 'none') {
      for (const u of urls) loaded.add(u);
      return Promise.resolve(true);
    }
    return new Promise((resolve, reject) => e.preloads.push({ patches, reject, resolve: () => {
      for (const u of urls) loaded.add(u);
      resolve(true);
    } }));
  };
  e.forget = (id) => {
    const def = samplers.get(id) || sampleDef(id);
    samplers.set(id, def);
    for (const smp of def.layers[0].samples) loaded.delete(smp.url);
  };
  e.know = (store) => {
    for (const id of store.get().songOrder) {
      for (const s of store.getSong(id).patch.slots) {
        if (s && s.instrument.type === 'sampler' && !samplers.has(s.instrument.id)) {
          samplers.set(s.instrument.id, sampleDef(s.instrument.id));
        }
      }
    }
  };
  return e;
}
const sampleDef = (id) => ({ id, layers: [{ samples: [{ url: `/s/${id}/a.ogg` }, { url: `/s/${id}/b.ogg` }] }] });

async function setup({ manualPrepare = false, store = makeStore() } = {}) {
  const engine = cachedEngine({ manualPrepare });
  engine.know(store);
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const doc = fakeDoc();
  const timers = fakeTimers();
  const warns = [];
  const ctl = createController({ store, engine, midi, doc, nav: null, win: new EventTarget(), rig: null, timers,
    now: () => 0, locks: null });
  ctl.on?.('warn', (e) => warns.push(e.detail));
  const started = ctl.start();
  if (manualPrepare) { await tick(); engine.pending.shift().resolve(); }
  await started;
  await tick();
  return { engine, store, ctl, midi, doc, timers, ids: store.navIds(), warns };
}
async function at(env, i) {
  const p = env.ctl.selectSong(env.ids[i], { index: i });
  await tick();
  if (env.engine.pending.length) env.engine.pending.shift().resolve();
  assert.equal(await p, true);
}


test('S1: removing the cued entry from the setlist drops the cue; GO then plays the next song, not a song off the set',
  async () => {
    const env = await setup();
    const { ctl, store, ids } = env;
    await at(env, 4);
    ctl.cueSong(ids[9], { index: 9 });
    store.removeFromSetlist(store.get().settings.currentSetlistId, 9);
    await tick();
    assert.equal(ctl.status.cue, null);
    assert.deepEqual(ctl.goTarget(), { id: ids[5], index: 5, cued: false });
    assert.equal(await ctl.go(), true);
    assert.equal(store.currentIndex(), 5, 'in the set');
    ctl.dispose();
  });

test('S1: deleting the cued song clears status.cue (no stale ✕ on the GO control)', async () => {
  const env = await setup();
  const { ctl, store, ids } = env;
  await at(env, 4);
  ctl.cueSong(ids[9], { index: 9 });
  store.deleteSong(ids[9]);
  await tick();
  assert.equal(ctl.status.cue, null);
  ctl.dispose();
});

test('S1: a GO waiting for its samples is dropped when another setlist (with the playing song) becomes current',
  async () => {
    const env = await setup();
    const { ctl, store, ids, engine } = env;
    await at(env, 4);
    store.addSetlist('Other', [ids[4], ids[2]]);
    const otherId = store.get().setlistOrder.at(-1);
    engine.forget('ep-rhodes');
    ctl.cueSong(ids[5], { index: 5 });
    const g = ctl.go();
    assert.equal(ctl.status.go.waiting, true);
    store.setCurrentSetlist(otherId);
    await tick();
    assert.equal(ctl.status.go, null, 'dropped');
    assert.equal(ctl.status.cue, null);
    for (const w of engine.preloads.splice(0)) w.resolve();
    assert.equal(await g, false);
    assert.equal(store.get().settings.currentSongId, ids[4], 'still on the playing song');
    assert.equal(store.currentIndex(), 0, 'its entry in the new set');
    ctl.dispose();
  });

test('a cue whose song is in the new setlist too survives the setlist switch (by id); reorder keeps it', async () => {
  const env = await setup();
  const { ctl, store, ids } = env;
  await at(env, 4);
  ctl.cueSong(ids[9], { index: 9 });
  store.moveSong(store.get().settings.currentSetlistId, 9, 6);
  assert.deepEqual(ctl.goTarget(), { id: ids[9], index: 6, cued: true });
  assert.equal(ctl.songState(ids[9], 6).state, 'cued');
  store.addSetlist('Other', [ids[4], ids[9]]);
  store.setCurrentSetlist(store.get().setlistOrder.at(-1));
  assert.deepEqual(ctl.goTarget(), { id: ids[9], index: 1, cued: true });
  ctl.dispose();
});

test('S2: a dropped or disposed GO leaves no 30 s cap timer behind', async () => {
  // S8 follow-up: the warm-up has its own 30 s cap (WARM_MAX_MS), alive while its preload is; so 2 while a GO waits
  const caps = (t) => [...t.timeouts.values()].filter((x) => x.ms === 30000).length;
  const env = await setup();
  await at(env, 4);
  env.engine.forget('ep-rhodes');
  env.ctl.go();
  assert.equal(caps(env.timers), 2, 'the GO cap + the warm-up cap');
  env.ctl.clearCue(); // nothing cued: drops the waiting Next-GO too
  assert.equal(env.ctl.status.go, null);
  assert.equal(caps(env.timers), 1, 'clearCue drops the GO cap; the decode (and its cap) runs on');
  env.ctl.go();
  assert.equal(caps(env.timers), 2, 'the same warm-up is reused: one new GO cap');
  env.ctl.dispose();
  assert.equal(caps(env.timers), 0, 'dispose');
});

test('a preload that rejects (engine restart) still lets a waiting GO switch; nothing left warming', async () => {
  const env = await setup();
  const { ctl, store, ids, engine } = env;
  await at(env, 4);
  engine.forget('ep-rhodes');
  const g = ctl.go();
  engine.preloads.shift().reject(new Error('restarted'));
  assert.equal(await g, true);
  assert.equal(store.get().settings.currentSongId, ids[5]);
  assert.deepEqual(ctl._debug().warming, []);
  ctl.dispose();
});

test('ends: last song Next / cueNext do nothing; an empty setlist navigates the library', async () => {
  const env = await setup();
  const { ctl, store, ids } = env;
  await at(env, ids.length - 1);
  assert.equal(await ctl.nextSong(), false);
  assert.equal(ctl.cueNext(), false);
  assert.equal(ctl.goTarget(), null);
  assert.equal(await ctl.go(), false);
  store.addSetlist('Empty', []);
  store.setCurrentSetlist(store.get().setlistOrder.at(-1));
  assert.equal(store.navIds().length, store.get().songOrder.length);
  ctl.dispose();
});

test('reprise: the twin entry of the playing song can be cued and GO plays that entry', async () => {
  const store = makeStore();
  const slId = store.get().settings.currentSetlistId;
  const lib = store.get().songOrder;
  store.set(`setlists.${slId}.songIds`, [lib[4], lib[5], lib[4]]);
  const env = await setup({ store });
  const { ctl } = env;
  await at(env, 0);
  assert.equal(ctl.cueSong(lib[4], { index: 2 }), true);
  assert.equal(await ctl.go(), true);
  assert.equal(store.currentIndex(), 2);
  assert.equal(ctl.status.cue, null);
  assert.equal(ctl.cueSong(lib[4], { index: 0 }), true, 'the first entry is not the one playing');
  assert.equal(ctl.songState(lib[4], 2).state, 'playing');
  ctl.dispose();
});
