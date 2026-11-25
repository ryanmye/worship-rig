// Lane S (native DECISIONS D6): "Cue, then Go". The controller's cue / GO / Next state machine with a fake engine that
// has a decoded-sample cache (engine.cache / registry.samplers, as the web engine and the bridge expose them) and a
// manual engine.preload, so "the cued song is still loading" can be held open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, key, tick } from './helpers.mjs';

/** fakeEngine + a sample cache: every sampler instrument has 2 samples; `warmAll` pre-decodes them. */
function cachedEngine({ manualPrepare = false } = {}) {
  const e = fakeEngine({ manual: manualPrepare });
  const loaded = new Set();
  const samplers = new Map();
  e.cache = { entries: new Map(), failed: new Set(), has: (u) => loaded.has(u) };
  e.registry = { samplers };
  e.preloads = []; // pin:'none' warm-ups, held open until resolved
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
      for (const u of urls) loaded.add(u); // the controller's own pins: decoded at once here
      return Promise.resolve(true);
    }
    return new Promise((resolve) => e.preloads.push({ patches, resolve: () => {
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
    for (const id of store.navIds()) {
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
  const ctl = createController({ store, engine, midi, doc, nav: null, win: new EventTarget(), rig: null, timers,
    now: () => 0, locks: null });
  const started = ctl.start();
  if (manualPrepare) {
    await tick();
    engine.pending.shift().resolve();
  }
  await started;
  await tick();
  const ids = store.navIds();
  // ids[4] Grand Piano (salamander), ids[5] Rhodes (ep-rhodes), ids[13] Upright (upright-piano), ids[2] synth only
  return { engine, store, ctl, midi, doc, timers, ids };
}
const prepares = (engine) => engine.of('prepare').length;
const warmUps = (engine) => engine.of('preload').filter((c) => c[2] && c[2].pin === 'none').length;

/** Select index i and wait for its commit (manual-prepare engines: resolve it). */
async function at(env, i) {
  const p = env.ctl.selectSong(env.ids[i], { index: i });
  await tick();
  if (env.engine.pending.length) env.engine.pending.shift().resolve();
  assert.equal(await p, true);
  assert.equal(env.store.get().settings.currentSongId, env.ids[i]);
}

test('cue: nothing changes about the playing song; the cued song warms (pin none) and shows cued / loading → ready',
  async () => {
    const env = await setup();
    const { ctl, engine, store, ids } = env;
    await at(env, 4);
    const before = prepares(engine);
    assert.equal(ctl.songState(ids[5], 5).state, 'ready', 'the set is pinned (decoded) at start');
    engine.forget('ep-rhodes');
    assert.deepEqual(ctl.songState(ids[5], 5), { state: 'cold', load: 'cold', cued: false, going: false });
    assert.equal(ctl.cueSong(ids[5], { index: 5 }), true);
    assert.equal(store.get().settings.currentSongId, ids[4], 'the store keeps the playing song');
    assert.equal(prepares(engine), before, 'no prepare on a cue');
    assert.equal(warmUps(engine), 1);
    assert.deepEqual(ctl.status.cue, { id: ids[5], index: 5 });
    assert.deepEqual(ctl.songState(ids[5], 5), { state: 'cued', load: 'loading', cued: true, going: false });
    assert.equal(ctl.songState(ids[4], 4).state, 'playing');
    assert.deepEqual(ctl.goTarget(), { id: ids[5], index: 5, cued: true });
    ctl.cueSong(ids[5], { index: 5 }); // the same entry again: kept, no second warm-up
    assert.equal(warmUps(engine), 1);
    engine.preloads.shift().resolve();
    await tick();
    assert.deepEqual(ctl.songState(ids[5], 5), { state: 'cued', load: 'ready', cued: true, going: false });
    ctl.dispose();
  });

test('GO while the cued song is loading waits for it; the old song stays; a second GO is the same request',
  async () => {
  const env = await setup();
  const { ctl, engine, store, ids } = env;
  await at(env, 4);
  engine.forget('ep-rhodes');
  ctl.cueSong(ids[5], { index: 5 });
  const before = prepares(engine);
  const g1 = ctl.go();
  const g2 = ctl.go();
  assert.equal(g2, g1);
  assert.deepEqual(ctl.status.go, { id: ids[5], index: 5, waiting: true });
  assert.equal(ctl.songState(ids[5], 5).going, true);
  await tick();
  assert.equal(prepares(engine), before, 'no prepare until the samples are in');
  assert.equal(store.get().settings.currentSongId, ids[4], 'Perform keeps the playing song meanwhile');
  engine.preloads.shift().resolve();
  assert.equal(await g1, true);
  assert.equal(store.get().settings.currentSongId, ids[5]);
  assert.equal(ctl.status.songId, ids[5]);
  assert.equal(ctl.status.cue, null, 'the cue is spent');
  assert.equal(ctl.status.go, null);
  assert.equal(ctl.songState(ids[5], 5).state, 'playing');
  ctl.dispose();
});

test('GO with nothing cued plays the next song; a warm song switches at once (1.x timing)', async () => {
  const env = await setup();
  const { ctl, store, ids } = env;
  await at(env, 4);
  const p = ctl.go();
  assert.equal(store.get().settings.currentSongId, ids[5], 'store moves in the same tick (song was warm)');
  assert.equal(await p, true);
  ctl.dispose();
});

test('double Next while the next song is still decoding never skips one (S1 risk 1)', async () => {
  const env = await setup();
  const { ctl, engine, store, ids } = env;
  await at(env, 4);
  engine.forget('ep-rhodes');
  const p1 = ctl.nextSong();
  const p2 = ctl.nextSong();
  assert.equal(p2, p1);
  assert.equal(warmUps(engine), 1);
  engine.preloads.shift().resolve();
  assert.equal(await p1, true);
  assert.equal(store.get().settings.currentSongId, ids[5], 'one step, not two');
  ctl.dispose();
});

test('during a switch: Next again is the same request; Prev goes back from the song on its way', async () => {
  const env = await setup({ manualPrepare: true });
  const { ctl, engine, store, ids } = env;
  await at(env, 4);
  const n1 = ctl.nextSong(); // warm → prepare now (pending)
  assert.equal(store.get().settings.currentSongId, ids[5]);
  assert.equal(ctl.nextSong(), n1, 'the song already on its way');
  assert.equal(ctl.go(), n1, 'GO with nothing cued = Next: the same request');
  assert.deepEqual(ctl.goTarget(), { id: ids[5], index: 5, cued: false });
  assert.equal(engine.pending.length, 1);
  const pv = ctl.prevSong(); // Next then Prev comes back (S1 risk 1 covers repeats, not corrections)
  assert.equal(store.get().settings.currentSongId, ids[4]);
  assert.equal(ctl.prevSong(), pv, 'a second Prev is the same request too');
  for (const x of engine.pending.splice(0).reverse()) x.resolve();
  assert.equal(await pv, true);
  assert.equal(await n1, false, 'superseded');
  assert.equal(ctl._debug().appliedId, ids[4]);
  ctl.dispose();
});

test('Prev while a Next still waits for its samples drops the GO; nothing switches', async () => {
  const env = await setup();
  const { ctl, engine, store, ids } = env;
  await at(env, 4);
  engine.forget('ep-rhodes');
  const n1 = ctl.nextSong();
  assert.equal(ctl.status.go.waiting, true);
  const before = prepares(engine);
  assert.equal(await ctl.prevSong(), false);
  assert.equal(ctl.status.go, null);
  engine.preloads.shift().resolve();
  assert.equal(await n1, false);
  assert.equal(prepares(engine), before);
  assert.equal(store.get().settings.currentSongId, ids[4]);
  ctl.dispose();
});

test('clearCue and a new cue drop a GO still waiting; a direct selectSong does too', async () => {
  const env = await setup();
  const { ctl, engine, store, ids } = env;
  await at(env, 4);
  engine.forget('ep-rhodes');
  engine.forget('upright-piano');
  ctl.cueSong(ids[5], { index: 5 });
  const g = ctl.go();
  ctl.clearCue();
  assert.equal(ctl.status.go, null);
  assert.equal(ctl.status.cue, null);
  const before = prepares(engine);
  engine.preloads.shift().resolve();
  assert.equal(await g, false);
  assert.equal(prepares(engine), before);
  assert.equal(store.get().settings.currentSongId, ids[4]);
  // a new cue while waiting
  engine.forget('ep-rhodes');
  ctl.cueSong(ids[5], { index: 5 });
  const g2 = ctl.go();
  ctl.cueSong(ids[13], { index: 13 });
  assert.equal(ctl.status.go, null, 'the new cue drops the waiting GO');
  for (const w of engine.preloads.splice(0)) w.resolve();
  assert.equal(await g2, false);
  assert.equal(store.get().settings.currentSongId, ids[4]);
  // a direct switch (an Edit row) while a GO waits
  engine.forget('upright-piano');
  const g3 = ctl.go(); // the cue (13)
  assert.equal(ctl.status.go.waiting, true);
  const direct = ctl.selectSong(ids[2], { index: 2 });
  assert.equal(ctl.status.go, null);
  assert.equal(await direct, true);
  for (const w of engine.preloads.splice(0)) w.resolve();
  assert.equal(await g3, false);
  assert.equal(store.get().settings.currentSongId, ids[2]);
  assert.deepEqual(ctl.status.cue, { id: ids[13], index: 13 }, 'a cue on another song survives a direct switch');
  ctl.dispose();
});

test('a GO waits at most GO_WAIT_MAX_MS for the decode, then switches (the old song plays until prepare is done)',
  async () => {
    const env = await setup();
    const { ctl, engine, store, ids, timers } = env;
    await at(env, 4);
    engine.forget('ep-rhodes');
    const g = ctl.go();
    assert.equal(ctl.status.go.waiting, true);
    const cap = [...timers.timeouts.values()].find((t) => t.ms === 30000);
    assert.ok(cap, 'a 30 s cap');
    cap.fn();
    assert.equal(await g, true);
    assert.equal(store.get().settings.currentSongId, ids[5]);
    engine.preloads.shift()?.resolve();
    ctl.dispose();
  });

test('cueing the playing song clears the cue; cueNext / cuePrev walk from the cue; onto the playing song clears',
  async () => {
    const env = await setup();
    const { ctl, ids } = env;
    await at(env, 4);
    assert.equal(ctl.cueNext(), true);
    assert.deepEqual(ctl.status.cue, { id: ids[5], index: 5 });
    ctl.cueNext();
    assert.deepEqual(ctl.status.cue, { id: ids[6], index: 6 });
    ctl.cuePrev();
    ctl.cuePrev(); // walks onto the playing song
    assert.equal(ctl.status.cue, null);
    ctl.cueSong(ids[7], { index: 7 });
    assert.equal(ctl.cueSong(ids[4], { index: 4 }), false, 'the playing chip');
    assert.equal(ctl.status.cue, null);
    ctl.dispose();
  });

test('Next GOes the cue (O-AW-2); a reprise entry is its own chip (index decides)', async () => {
  const store = makeStore();
  const slId = store.get().settings.currentSetlistId;
  const lib = store.get().songOrder;
  store.set(`setlists.${slId}.songIds`, [lib[0], lib[4], lib[2], lib[4], lib[5]]);
  const env = await setup({ store });
  const { ctl, ids } = env;
  await at(env, 1);
  assert.equal(ctl.songState(ids[3], 3).state, 'ready', 'the reprise of the playing song is not "playing"');
  assert.equal(ctl.songState(ids[1], 1).state, 'playing');
  ctl.cueSong(ids[3], { index: 3 });
  assert.equal(ctl.songState(ids[3], 3).state, 'cued');
  assert.equal(ctl.songState(ids[1], 1).state, 'playing');
  // DECISIONS O-AW-2 (review S5): with a cue set, Next plays the cue (it used to replace it with the neighbour)
  assert.equal(await ctl.nextSong(), true);
  assert.equal(env.store.currentIndex(), 3, 'Next plays the cued reprise entry');
  assert.equal(ctl.status.cue, null, 'the cue is spent');
  assert.equal(await ctl.nextSong(), true);
  assert.equal(env.store.currentIndex(), 4, 'nothing cued: Next is the next song (D6)');
  await ctl.prevSong();
  ctl.cueSong(ids[1], { index: 1 });
  assert.equal(await ctl.go(), true);
  assert.equal(env.store.currentIndex(), 1, 'GO plays the cued entry of the playing song’s twin');
  ctl.dispose();
});

test('Program Change: cue by default, channel filter, switch by choice; learned go / cueNext buttons; keys',
  async () => {
  const env = await setup();
  const { ctl, store, midi, doc, ids } = env;
  await at(env, 4);
  store.set('settings.programChange', true);
  midi._inject([0xc0, 9]);
  assert.deepEqual(ctl.status.cue, { id: ids[9], index: 9 });
  assert.equal(store.get().settings.currentSongId, ids[4]);
  store.set('settings.programChangeChannel', 15);
  midi._inject([0xc0, 10]); // channel 1: filtered
  assert.deepEqual(ctl.status.cue, { id: ids[9], index: 9 });
  midi._inject([0xcf, 10]); // channel 16
  assert.deepEqual(ctl.status.cue, { id: ids[10], index: 10 });
  assert.equal(store.set('settings.programChangeChannel', 16), false, '0..15 only');
  assert.equal(store.set('settings.programChangeAction', 'jump'), false);
  // learned footswitches
  store.setMidiLearn('go', { cc: 80, channel: null });
  store.setMidiLearn('cueNext', { note: 30, channel: null });
  store.setMidiLearn('cuePrev', { note: 31, channel: null });
  midi._inject([0x90, 31, 100]);
  midi._inject([0x80, 31, 0]);
  assert.deepEqual(ctl.status.cue, { id: ids[9], index: 9 });
  midi._inject([0x90, 30, 100]);
  midi._inject([0x80, 30, 0]);
  assert.deepEqual(ctl.status.cue, { id: ids[10], index: 10 });
  midi._inject([0xb0, 80, 127]);
  await tick();
  await tick();
  assert.equal(store.get().settings.currentSongId, ids[10]);
  midi._inject([0xb0, 80, 0]);
  // keys: Shift+→ cues the next, Enter is GO (nothing focused)
  key(doc, 'keydown', { code: 'ArrowRight', shiftKey: true });
  assert.deepEqual(ctl.status.cue, { id: ids[11], index: 11 });
  key(doc, 'keydown', { code: 'Enter' });
  await tick();
  await tick();
  assert.equal(store.get().settings.currentSongId, ids[11]);
  // Enter on a focused control is the control's
  ctl.cueNext();
  doc.activeElement = { tagName: 'BUTTON' };
  key(doc, 'keydown', { code: 'Enter' });
  await tick();
  assert.equal(store.get().settings.currentSongId, ids[11]);
  doc.activeElement = doc.body;
  // switch mode: the 1.x jump
  store.set('settings.programChangeAction', 'switch');
  midi._inject([0xcf, 2]);
  await tick();
  await tick();
  assert.equal(store.get().settings.currentSongId, ids[2]);
  assert.equal(ctl.status.cue, null, 'a PC switch replaces the cue');
  store.set('settings.programChangeChannel', null);
  assert.equal('programChangeChannel' in store.get().settings, false, 'null = back to any channel (absent)');
  ctl.dispose();
});

test('songReady: null without a cache (fakes / secondary); a song with no sampler is always ready', async () => {
  const env = await setup();
  const { ctl, engine, ids } = env;
  assert.equal(ctl.songReady(ids[2]), true, 'synth only');
  engine.forget('salamander-piano');
  assert.equal(ctl.songReady(ids[4]), false);
  engine.cache.failed.add('/s/salamander-piano/a.ogg');
  engine.cache.failed.add('/s/salamander-piano/b.ogg');
  assert.equal(ctl.songReady(ids[4]), true, 'a failed sample is not waited for');
  delete engine.cache;
  assert.equal(ctl.songReady(ids[4]), null);
  assert.equal(ctl.songState(ids[4], 4).load, 'ready', 'unknown reads as ready (nothing to wait for)');
  ctl.dispose();
});
