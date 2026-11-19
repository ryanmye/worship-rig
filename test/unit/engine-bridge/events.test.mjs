// Native -> JS event fan-out (contract 6.5): each bridge event becomes the contract's JS event(s).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './helpers.mjs';

const st = (o = {}) => ({ v: 1, ev: 'state', state: 'running', sleep: 'awake', latencyMs: 12, sampleRate: 48000,
  deviceId: 'default', channels: 2, ...o });
const names = (r) => r.events.map((e) => e.name);
const last = (r, n) => r.events.filter((e) => e.name === n).pop();

test('start emits statechange then ready{start}', async () => {
  const r = rig();
  await r.engine.start();
  assert.deepEqual(names(r), ['statechange', 'ready']);
  assert.deepEqual(r.events[0].detail, { state: 'running', latencyMs: 12 });
  assert.deepEqual(r.events[1].detail, { phase: 'start' });
  assert.equal(r.engine.latencyMs, 12);
});

test('state: a changed device state emits statechange; sleep transitions emit sleep', async () => {
  const r = rig();
  await r.engine.start();
  r.events.length = 0;
  r.native.post(st({ state: 'suspended', sleep: 'asleep' }));
  assert.deepEqual(names(r), ['statechange', 'sleep']);
  assert.deepEqual(last(r, 'sleep').detail, { state: 'asleep' });
  assert.equal(r.engine.sleepState, 'asleep');
  r.events.length = 0;
  r.native.post(st({ state: 'running', sleep: 'awake', wakeMs: 9, queued: 2 }));
  assert.deepEqual(last(r, 'sleep').detail, { state: 'awake', wakeMs: 9, queued: 2 });
  r.events.length = 0;
  r.native.post(st({ state: 'running', sleep: 'awake' }));
  assert.deepEqual(names(r), [], 'an identical state is not an event');
});

test("the 'waking' sleep state is not announced as a sleep event", async () => {
  const r = rig();
  await r.engine.start();
  r.events.length = 0;
  r.native.post(st({ sleep: 'waking' }));
  assert.deepEqual(names(r), []);
  assert.equal(r.engine.sleepState, 'waking');
});

test('state restarted:true emits statechange{restarted} and kills in-flight prepare tokens', async () => {
  const r = rig();
  await r.engine.start();
  const tok = await r.engine.prepare({ slots: [null, null, null, null] });
  r.events.length = 0;
  r.native.post(st({ restarted: true }));
  assert.deepEqual(last(r, 'statechange').detail, { state: 'running', latencyMs: 12, restarted: true });
  assert.equal(r.engine.commit(tok), false);
});

test('notes: held becomes a Set; chord only when the key is present', async () => {
  const r = rig();
  await r.engine.start();
  r.events.length = 0;
  r.native.post({ v: 1, ev: 'notes', held: [60, 64] });
  r.native.post({ v: 1, ev: 'notes', held: [60, 64, 67], chord: { name: 'C', root: 0, quality: 'maj', bass: 0 } });
  r.native.post({ v: 1, ev: 'notes', held: [], chord: null });
  assert.deepEqual(names(r), ['notes', 'notes', 'chord', 'notes', 'chord']);
  assert.ok(r.events[0].detail.held instanceof Set);
  assert.deepEqual([...r.events[1].detail.held], [60, 64, 67]);
  assert.equal(r.events[2].detail.chord.name, 'C');
  assert.equal(r.events[4].detail.chord, null);
});

test('wheel keeps hardware and pickup flags', async () => {
  const r = rig();
  r.native.post({ v: 1, ev: 'wheel', source: 'mod', value: 0.4, hardware: true, pickup: true });
  r.native.post({ v: 1, ev: 'wheel', source: 'expr', value: 1 });
  assert.deepEqual(r.events.map((e) => e.detail), [
    { source: 'mod', value: 0.4, hardware: true, pickup: true }, { source: 'expr', value: 1 },
  ]);
});

test('load: slot -> loading, preload -> ready{preload}, instruments -> refresh then instruments', async () => {
  const r = rig();
  await r.engine.start();
  r.events.length = 0;
  r.native.post({ v: 1, ev: 'load', phase: 'slot', slot: 2, progress: 0.5, token: 4 });
  r.native.post({ v: 1, ev: 'load', phase: 'preload', decodedMB: 10, pinnedMB: 8, deferred: 1 });
  assert.deepEqual(r.events.map((e) => [e.name, e.detail]), [
    ['loading', { slot: 2, progress: 0.5, token: 4 }],
    ['ready', { phase: 'preload', decodedMB: 10, pinnedMB: 8, deferred: 1 }],
  ]);
  r.events.length = 0;
  r.native.post({ v: 1, ev: 'load', phase: 'instruments', count: 43 });
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(r.events.map((e) => [e.name, e.detail]), [['instruments', { count: 43 }]]);
});

test('load samples feeds the cache/registry facades main.js reads for "Loading n/m"', async () => {
  const r = rig();
  await r.engine.start();
  const def = r.engine.registry.samplers.get('salamander-piano');
  const url = def.layers[0].samples[0].url;
  assert.equal(r.engine.cache.has(url), false);
  r.native.post({ v: 1, ev: 'load', phase: 'samples', loaded: { 'salamander-piano': true } });
  assert.equal(r.engine.cache.has(url), true);
  assert.ok(r.engine.cache.entries.has(url));
  assert.equal(r.engine.registry.samplers.get('warm-pad'), undefined, 'only samplers are listed');
  r.native.post({ v: 1, ev: 'load', phase: 'samples', loaded: { 'salamander-piano': false } });
  assert.equal(r.engine.cache.has(url), false);
});

test('click event carries the metronome state and updates clickState()', async () => {
  const r = rig();
  const s = {
    running: true, counting: false, bpm: 90, sig: '4/4', output: 'main', level: 0.5, record: false, downbeat: 3,
  };
  r.native.post({ v: 1, ev: 'click', ...s });
  assert.deepEqual(r.events[0], { name: 'click', detail: s });
  assert.deepEqual(r.engine.clickState(), s);
});

test('warn events are deduplicated per message, like the JS engine', () => {
  const r = rig();
  r.native.post({ v: 1, ev: 'warn', message: 'engine.noteOn failed: x' });
  r.native.post({ v: 1, ev: 'warn', message: 'engine.noteOn failed: x' });
  r.native.post({ v: 1, ev: 'warn', message: 'other' });
  assert.deepEqual(r.events.map((e) => e.detail.message), ['engine.noteOn failed: x', 'other']);
});

test('midi and rec events are forwarded for the adapters; unknown events are ignored', () => {
  const r = rig();
  const got = [];
  r.engine.addEventListener('midi', (e) => got.push(['midi', e.detail.type]));
  r.engine.addEventListener('rec', (e) => got.push(['rec', e.detail.state]));
  r.native.post({ v: 1, ev: 'midi', type: 'ports', ports: [] });
  r.native.post({ v: 1, ev: 'rec', state: 'recording' });
  r.native.post({ v: 1, ev: 'future-thing' });
  assert.deepEqual(got, [['midi', 'ports'], ['rec', 'recording']]);
});

test('every contracted event is produced by some native event', async () => {
  const r = rig();
  await r.engine.start();
  r.native.post({ v: 1, ev: 'load', phase: 'slot', slot: 0, progress: 1, token: 1 });
  r.native.post({ v: 1, ev: 'load', phase: 'preload', decodedMB: 1, pinnedMB: 1, deferred: 0 });
  r.native.post({ v: 1, ev: 'load', phase: 'instruments', count: 1 });
  r.native.post({ v: 1, ev: 'wheel', source: 'mod', value: 0 });
  r.native.post({ v: 1, ev: 'notes', held: [60], chord: null });
  r.native.post({ v: 1, ev: 'click', running: false });
  r.native.post(st({ sleep: 'asleep' }));
  r.native.post({ v: 1, ev: 'warn', message: 'w' });
  await new Promise((res) => setImmediate(res));
  const seen = new Set(names(r));
  const missing = r.engine && [...['statechange', 'ready', 'loading', 'instruments', 'wheel', 'notes', 'chord', 'click',
    'sleep', 'warn']].filter((n) => !seen.has(n));
  assert.deepEqual(missing, []);
});
