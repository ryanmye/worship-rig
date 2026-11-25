// Lane S follow-ups (native/docs/reviews/S-cue-go.md "Follow-up"; DECISIONS O-AW-2, O-AW-3):
// S5 / O-AW-2: every Next GOes a set cue; Prev clears it and steps back.
// S6 / O-AW-3: a 1.x library with PC on (no action stored) keeps 'switch'; turning PC on in 2.0 writes 'cue'.
// S7: Enter = GO only on Perform, with Settings closed and a GO target.
// S8: a warm-up preload that never settles stops reading "loading" after WARM_MAX_MS (30 s).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { migrate, programChangeOf } from '../../../app/js/store.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, key, tick } from './helpers.mjs';

/** fakeEngine + a decoded-sample cache (as in cue-go.test.mjs); pin:'none' preloads stay open until resolved. */
function cachedEngine() {
  const e = fakeEngine();
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
  return e;
}
const sampleDef = (id) => ({ id, layers: [{ samples: [{ url: `/s/${id}/a.ogg` }, { url: `/s/${id}/b.ogg` }] }] });

async function setup({ store = makeStore(), rig = null } = {}) {
  const engine = cachedEngine();
  for (const id of store.get().songOrder) {
    for (const s of store.getSong(id).patch.slots) {
      const id2 = s && s.instrument.type === 'sampler' ? s.instrument.id : null;
      if (id2) engine.registry.samplers.set(id2, sampleDef(id2));
    }
  }
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const doc = fakeDoc();
  const timers = fakeTimers();
  const ctl = createController({ store, engine, midi, doc, nav: null, win: new EventTarget(), rig, timers,
    now: () => 0, locks: null });
  await ctl.start();
  await tick();
  return { engine, store, ctl, midi, doc, timers, ids: store.navIds() };
}
async function at(env, i) {
  assert.equal(await env.ctl.selectSong(env.ids[i], { index: i }), true);
}
const settle = async () => {
  for (let i = 0; i < 4; i++) await tick();
};
const cur = (env) => env.store.currentIndex();
const caps = (t) => [...t.timeouts.values()].filter((x) => x.ms === 30000);

// ---------------------------------------------------------------------------------------------- S5 / O-AW-2
test('O-AW-2: with a cue set, nextSong / → / a learned nextSong / menu / bus all GO the cue', async () => {
  let menuCb = null;
  const rig = { isElectron: true, onMenu: (cb) => ((menuCb = cb), () => (menuCb = null)) };
  const env = await setup({ rig });
  const { ctl, store, midi, doc, ids } = env;
  await at(env, 2);
  // the API
  ctl.cueSong(ids[7], { index: 7 });
  assert.equal(await ctl.nextSong(), true);
  assert.equal(cur(env), 7, 'nextSong played the cue, not ids[3]');
  assert.equal(ctl.status.cue, null, 'spent');
  // → (nothing focused)
  ctl.cueSong(ids[3], { index: 3 });
  key(doc, 'keydown', { code: 'ArrowRight' });
  await settle();
  assert.equal(cur(env), 3, '→ played the cue');
  // ⌘→
  ctl.cueSong(ids[9], { index: 9 });
  key(doc, 'keydown', { code: 'ArrowRight', metaKey: true });
  await settle();
  assert.equal(cur(env), 9, '⌘→ played the cue');
  // a learned nextSong footswitch (the 1.x user's only switch)
  store.setMidiLearn('nextSong', { cc: 81, channel: null });
  ctl.cueSong(ids[5], { index: 5 });
  midi._inject([0xb0, 81, 127]);
  midi._inject([0xb0, 81, 0]);
  await settle();
  assert.equal(cur(env), 5, 'the footswitch played the cue the GO control shows');
  // the app menu (Electron) and the bus (global hotkeys, the menu-bar popover)
  ctl.cueSong(ids[1], { index: 1 });
  menuCb('nextSong');
  await settle();
  assert.equal(cur(env), 1, 'menu Next played the cue');
  ctl.cueSong(ids[11], { index: 11 });
  assert.equal(ctl.handleCommand({ v: 1, type: 'nextSong' }), true);
  await settle();
  assert.equal(cur(env), 11, 'bus nextSong played the cue');
  // nothing cued: Next is the next song (D6)
  assert.equal(await ctl.nextSong(), true);
  assert.equal(cur(env), 12);
  ctl.dispose();
});

test('O-AW-2: Next while the cued GO waits for its samples is the same request (never one past the cue)', async () => {
  const env = await setup();
  const { ctl, engine, store, ids } = env;
  await at(env, 4);
  engine.forget('ep-rhodes');
  ctl.cueSong(ids[5], { index: 5 });
  const g = ctl.go();
  assert.equal(ctl.status.go.waiting, true);
  const n1 = ctl.nextSong();
  const n2 = ctl.nextSong();
  assert.equal(n1, g, 'a learned nextSong during the wait is the GO in flight');
  assert.equal(n2, g);
  assert.equal(store.get().settings.currentSongId, ids[4], 'still the playing song');
  engine.preloads.shift().resolve();
  assert.equal(await g, true);
  assert.equal(cur(env), 5, 'the cue, not ids[6]');
  ctl.dispose();
});

test('O-AW-2: prevSong with a cue set clears it and steps back from the playing song', async () => {
  let menuCb = null;
  const rig = { isElectron: true, onMenu: (cb) => ((menuCb = cb), () => (menuCb = null)) };
  const env = await setup({ rig });
  const { ctl, doc, ids } = env;
  await at(env, 6);
  ctl.cueSong(ids[10], { index: 10 });
  assert.equal(await ctl.prevSong(), true);
  assert.equal(cur(env), 5);
  assert.equal(ctl.status.cue, null);
  ctl.cueSong(ids[10], { index: 10 });
  key(doc, 'keydown', { code: 'ArrowLeft' });
  await settle();
  assert.equal(cur(env), 4, '← too');
  assert.equal(ctl.status.cue, null);
  ctl.cueSong(ids[10], { index: 10 });
  menuCb('prevSong');
  await settle();
  assert.equal(cur(env), 3, 'menu Prev too');
  assert.equal(ctl.status.cue, null);
  ctl.dispose();
});

// ---------------------------------------------------------------------------------------------- S6 / O-AW-3
test('O-AW-3: programChangeOf reads an absent action as switch with PC on (1.x), cue with PC off', () => {
  assert.deepEqual(programChangeOf({ programChange: true }), { on: true, channel: null, action: 'switch' });
  assert.equal(programChangeOf({ programChange: false }).action, 'cue', 'what turning it on will write');
  assert.equal(programChangeOf({}).action, 'cue');
  assert.equal(programChangeOf({ programChange: true, programChangeAction: 'cue' }).action, 'cue');
  assert.equal(programChangeOf({ programChange: false, programChangeAction: 'switch' }).action, 'switch');
  assert.equal(programChangeOf({ programChange: true, programChangeAction: 'jump' }).action, 'switch');
});

test('O-AW-3: store.set turns PC on with action cue when none is stored; never overwrites a choice', () => {
  const s = makeStore();
  assert.equal('programChangeAction' in s.get().settings, false);
  assert.equal(s.set('settings.programChange', true), true);
  assert.equal(s.get().settings.programChangeAction, 'cue', 'off → on writes cue (the settings.js toggle path)');
  s.set('settings.programChangeAction', 'switch');
  s.set('settings.programChange', false);
  s.set('settings.programChange', true);
  assert.equal(s.get().settings.programChangeAction, 'switch', 'a stored choice is kept');
  // a 1.x library: PC already on, no action
  const t = makeStore();
  t.update((d) => {
    d.settings.programChange = true;
  });
  assert.equal('programChangeAction' in t.get().settings, false, 'update() never fills it in');
  assert.equal(t.set('settings.programChange', true), false, 'already on: no write');
  assert.equal('programChangeAction' in t.get().settings, false);
  assert.equal(programChangeOf(t.get().settings).action, 'switch');
  assert.equal(t.set('settings.programChange', 'yes'), false, 'a refused write writes nothing');
  assert.equal('programChangeAction' in t.get().settings, false);
});

test('O-AW-3: export / import / migrate keep "absent = switch" for 1.x and the explicit cue for new users', () => {
  // 1.x library: PC on, no action
  const old = makeStore();
  old.update((d) => {
    d.settings.programChange = true;
  });
  const oldJson = old.exportJSON();
  assert.equal('programChangeAction' in JSON.parse(oldJson).settings, false, 'export does not invent one');
  const once = migrate(JSON.parse(oldJson));
  assert.equal('programChangeAction' in once.settings, false, 'migrate does not fill it in');
  assert.deepEqual(migrate(JSON.parse(JSON.stringify(once))), once, 'migrate is idempotent');
  const b = makeStore();
  assert.equal(b.importJSON(oldJson, { replace: true }).ok, true);
  assert.equal(b.get().settings.programChange, true);
  assert.equal('programChangeAction' in b.get().settings, false, 'a replace-import of a 1.x library stays absent');
  assert.equal(programChangeOf(b.get().settings).action, 'switch');
  // a 2.0 user who turned PC on
  const neu = makeStore();
  neu.set('settings.programChange', true);
  const neuJson = neu.exportJSON();
  assert.equal(JSON.parse(neuJson).settings.programChangeAction, 'cue', 'exported explicitly');
  const twice = migrate(migrate(JSON.parse(neuJson)));
  assert.equal(twice.settings.programChangeAction, 'cue');
  assert.deepEqual(migrate(JSON.parse(JSON.stringify(twice))), twice);
  const c = makeStore();
  assert.equal(c.importJSON(neuJson, { replace: true }).ok, true);
  assert.equal(c.get().settings.programChangeAction, 'cue', 'kept by a replace-import');
  assert.equal(programChangeOf(c.get().settings).action, 'cue');
});

test('O-AW-3: a 1.x library with PC on still switches on a Program Change; a fresh enable cues', async () => {
  const store = makeStore();
  store.update((d) => {
    d.settings.programChange = true;
  });
  const env = await setup({ store });
  const { ctl, midi, ids } = env;
  await at(env, 4);
  midi._inject([0xc0, 9]);
  await settle();
  assert.equal(store.get().settings.currentSongId, ids[9], '1.x: the program button switches at once');
  assert.equal(ctl.status.cue, null);
  ctl.dispose();
  const env2 = await setup();
  await at(env2, 4);
  env2.store.set('settings.programChange', true);
  env2.midi._inject([0xc0, 9]);
  await settle();
  assert.equal(env2.store.get().settings.currentSongId, env2.ids[4], 'turned on in 2.0: cues');
  assert.deepEqual(env2.ctl.status.cue, { id: env2.ids[9], index: 9 });
  env2.ctl.dispose();
});

// ---------------------------------------------------------------------------------------------- S7
test('S7: Enter = GO only on Perform, never in Edit or with Settings open, and only with a GO target', async () => {
  const env = await setup();
  const { ctl, store, doc, ids } = env;
  await at(env, 4);
  ctl.cueSong(ids[7], { index: 7 });
  // Edit
  store.set('settings.view', 'edit');
  let ev = key(doc, 'keydown', { code: 'Enter' });
  await settle();
  assert.equal(cur(env), 4, 'Edit: Enter changes nothing');
  assert.equal(ev.defaultPrevented, false, 'and leaves the key alone');
  store.set('settings.view', 'perform');
  // Settings open (main.js marks body.settings-open)
  const open = new Set(['settings-open']);
  doc.body.classList = { contains: (c) => open.has(c) };
  ev = key(doc, 'keydown', { code: 'NumpadEnter' });
  await settle();
  assert.equal(cur(env), 4, 'Settings open: Enter changes nothing');
  assert.equal(ev.defaultPrevented, false);
  open.clear();
  // Perform, a cue: GO
  ev = key(doc, 'keydown', { code: 'Enter' });
  await settle();
  assert.equal(ev.defaultPrevented, true);
  assert.equal(cur(env), 7, 'Perform: Enter GOes the cue');
  // nothing cued: the GO control shows the next song, so Enter is Next
  key(doc, 'keydown', { code: 'Enter' });
  await settle();
  assert.equal(cur(env), 8);
  // the last song, nothing cued: no GO target, Enter is left alone
  await at(env, ids.length - 1);
  assert.equal(ctl.goTarget(), null);
  ev = key(doc, 'keydown', { code: 'Enter' });
  assert.equal(ev.defaultPrevented, false, 'no target: not consumed');
  ctl.dispose();
});

// ---------------------------------------------------------------------------------------------- S8
test('S8: a warm-up preload that never settles stops reading "loading" after 30 s; the next cue asks again',
  async () => {
    const env = await setup();
    const { ctl, engine, timers, ids } = env;
    await at(env, 4);
    engine.forget('ep-rhodes');
    ctl.cueSong(ids[5], { index: 5 });
    assert.equal(ctl.songState(ids[5], 5).load, 'loading');
    assert.equal(engine.preloads.length, 1, 'one warm-up, never resolved');
    const warmCap = [...timers.timeouts.entries()].filter(([, x]) => x.ms === 30000);
    assert.equal(warmCap.length, 1, 'the warm-up is capped');
    timers.timeouts.delete(warmCap[0][0]); // fire it as a real timer does (once, then gone)
    warmCap[0][1].fn();
    await settle();
    assert.deepEqual(ctl._debug().warming, [], 'given up');
    assert.deepEqual(ctl.songState(ids[5], 5), { state: 'cued', load: 'cold', cued: true, going: false },
      'falls back to what songReady says: not loaded');
    ctl.clearCue();
    ctl.cueSong(ids[5], { index: 5 });
    assert.equal(engine.preloads.length, 2, 'a new cue asks the engine again instead of the stuck promise');
    assert.equal(ctl.songState(ids[5], 5).load, 'loading');
    engine.preloads[0].resolve(); // the stuck one settles late: harmless
    engine.preloads[1].resolve();
    await settle();
    assert.equal(ctl.songState(ids[5], 5).load, 'ready');
    assert.equal(caps(timers).length, 0, 'a settled warm-up clears its cap');
    engine.forget('upright-piano');
    ctl.cueSong(ids[13], { index: 13 });
    assert.equal(caps(timers).length, 1);
    ctl.dispose();
    assert.equal(caps(timers).length, 0, 'dispose clears a warm-up cap');
  });
