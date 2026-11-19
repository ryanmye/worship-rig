// Clock mapping (contract 6.3): currentTime = t_tick + (page elapsed), capped at +0.25 s, never decreasing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineClock, CLOCK_CAP_SEC } from '../../../app/js/engine-bridge/clock.js';
import { fakeEnv, rig, flush } from './helpers.mjs';

test('extrapolates between ticks and caps at +0.25 s', () => {
  const env = fakeEnv();
  const c = new EngineClock(env.now);
  c.startRequested();
  c.tick(10);
  assert.equal(c.currentTime(), 10);
  env.advance(100);
  assert.ok(Math.abs(c.currentTime() - 10.1) < 1e-9);
  env.advance(900);
  assert.ok(Math.abs(c.currentTime() - (10 + CLOCK_CAP_SEC)) < 1e-9, 'a silent native engine must look stalled');
  env.advance(5000);
  assert.ok(Math.abs(c.currentTime() - 10.25) < 1e-9);
});

test('a new tick re-anchors; the value never decreases', () => {
  const env = fakeEnv();
  const c = new EngineClock(env.now);
  c.tick(5);
  env.advance(200);
  const a = c.currentTime(); // 5.2
  c.tick(5.1); // native reports a smaller time than the extrapolation (page jitter)
  assert.ok(c.currentTime() >= a, 'monotonic');
  env.advance(400);
  c.tick(5.6);
  assert.ok(c.currentTime() >= 5.6);
});

test('a tick that goes backwards is ignored as an anchor', () => {
  const env = fakeEnv();
  const c = new EngineClock(env.now);
  c.tick(8);
  c.tick(3);
  assert.ok(c.currentTime() >= 8);
});

test('before start the clock free-runs; after startRequested without a tick it stops within 0.25 s', () => {
  const env = fakeEnv();
  const c = new EngineClock(env.now);
  env.advance(3000);
  assert.ok(Math.abs(c.currentTime() - 3) < 1e-9);
  c.startRequested();
  env.advance(2000);
  assert.ok(Math.abs(c.currentTime() - 3.25) < 1e-9);
  env.advance(2000);
  assert.ok(Math.abs(c.currentTime() - 3.25) < 1e-9, 'frozen: controller watchdog will notice');
});

test('the first tick may reset the free-run placeholder (one allowed backwards step)', () => {
  const env = fakeEnv();
  const c = new EngineClock(env.now);
  env.advance(5000);
  c.currentTime();
  c.startRequested();
  c.tick(0.01);
  assert.ok(c.currentTime() < 1);
  env.advance(100);
  assert.ok(c.currentTime() > 0.1);
});

test('getOutputTimestamp: {contextTime: t_tick - outputLatency, performanceTime: page time of the tick}', () => {
  const env = fakeEnv(500);
  const c = new EngineClock(env.now);
  assert.deepEqual(c.outputTimestamp(0.01), { contextTime: 0, performanceTime: 0 });
  env.advance(100);
  c.tick(2);
  env.advance(50);
  assert.deepEqual(c.outputTimestamp(0.0125), { contextTime: 2 - 0.0125, performanceTime: 600 });
});

test('the engine ctx facade follows ticks and reports running at once', async () => {
  const r = rig();
  assert.equal(r.engine.ctx.state, 'running');
  await r.engine.start();
  r.env.advance(500);
  r.mock.emitTick();
  const t0 = r.engine.ctx.currentTime;
  r.env.advance(100);
  assert.ok(r.engine.ctx.currentTime > t0);
  const ts = r.engine.ctx.getOutputTimestamp();
  assert.ok(ts.performanceTime > 0 && ts.contextTime > 0);
  assert.equal(r.engine.ctx.sampleRate, 48000);
  assert.ok(Math.abs(r.engine.ctx.outputLatency - 0.012) < 1e-9);
  assert.equal(r.engine.ctx.baseLatency, 0);
});

test('ctx.currentTime advances once per watchdog second while native ticks (no false stall)', async () => {
  const r = rig();
  await r.engine.start();
  let prev = -1;
  let stuck = 0;
  for (let s = 0; s < 6; s++) {
    for (let k = 0; k < 30; k++) {
      r.env.advance(1000 / 30);
      r.mock.emitTick();
    }
    const t = r.engine.ctx.currentTime;
    if (t <= prev) stuck += 1;
    prev = t;
  }
  assert.equal(stuck, 0);
});

test('when native stops ticking the watchdog sees a stall (two equal reads)', async () => {
  const r = rig();
  await r.engine.start();
  r.mock.emitTick();
  r.env.advance(1000);
  const a = r.engine.ctx.currentTime;
  r.env.advance(1000);
  const b = r.engine.ctx.currentTime;
  r.env.advance(1000);
  const c = r.engine.ctx.currentTime;
  assert.ok(b <= a + 1e-9 && c <= b + 1e-9);
  await flush();
});

test('ctx.resume() starts audio, or wakes it when asleep', async () => {
  const r = rig();
  await r.engine.ctx.resume();
  assert.ok(r.mock.calls.get('audio:start') >= 1);
  assert.ok(await r.engine.sleep());
  assert.equal(r.engine.sleepState, 'asleep');
  await r.engine.ctx.resume();
  assert.equal(r.mock.calls.get('audio:wake'), 1);
  assert.equal(r.engine.sleepState, 'awake');
});
