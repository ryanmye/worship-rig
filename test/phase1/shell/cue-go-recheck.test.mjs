// Lane S re-check (native/docs/reviews/S-cue-go.md "Re-check"): R2, a warm-up preload that settles after dispose()
// must not emit a 'status' event (the S8 cap timers are cleared, but the race's own then() still ran publishCue).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../../app/js/controller.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

const sampleDef = (id) => ({ id, layers: [{ samples: [{ url: `/s/${id}/a.ogg` }] }] });

test('S re-check R2: a cue warm-up that settles after dispose() emits no status event', async () => {
  const store = makeStore();
  const engine = fakeEngine();
  const loaded = new Set();
  const samplers = new Map();
  engine.cache = { entries: new Map(), failed: new Set(), has: (u) => loaded.has(u) };
  engine.registry = { samplers };
  const pending = [];
  engine.preload = (patches, opts = {}) => {
    engine.calls.push(['preload', patches, opts]);
    const urls = [];
    for (const p of patches) {
      for (const s of p.slots) {
        if (!s || s.instrument.type !== 'sampler') continue;
        if (!samplers.has(s.instrument.id)) samplers.set(s.instrument.id, sampleDef(s.instrument.id));
        urls.push(samplers.get(s.instrument.id).layers[0].samples[0].url);
      }
    }
    if (opts.pin !== 'none') {
      for (const u of urls) loaded.add(u);
      return Promise.resolve(true);
    }
    return new Promise((resolve) => pending.push(() => resolve(true)));
  };
  const ctl = createController({ store, engine, midi: null, doc: fakeDoc(), nav: null, win: new EventTarget(),
    timers: fakeTimers(), now: () => 0, locks: null });
  await ctl.start();
  await tick();
  const ids = store.navIds();
  // a sampler song that is not decoded: forget its samples so the cue warms it
  const j = ids.findIndex((id, i) => i > 0 && store.getSong(id).patch.slots.some((s) => s
    && s.instrument.type === 'sampler'));
  assert.ok(j > 0, 'the default library has a sampler song past the first');
  for (const s of store.getSong(ids[j]).patch.slots) {
    if (s && s.instrument.type === 'sampler') {
      if (!samplers.has(s.instrument.id)) samplers.set(s.instrument.id, sampleDef(s.instrument.id));
      loaded.delete(samplers.get(s.instrument.id).layers[0].samples[0].url);
    }
  }
  assert.equal(ctl.songReady(ids[j]), false);
  ctl.cueSong(ids[j], { index: j });
  assert.equal(ctl.songState(ids[j], j).load, 'loading');
  assert.equal(pending.length, 1, 'one warm-up in flight');
  ctl.dispose();
  let events = 0;
  ctl.addEventListener('status', () => events++);
  pending[0]();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(events, 0, 'nothing is published after dispose');
});
