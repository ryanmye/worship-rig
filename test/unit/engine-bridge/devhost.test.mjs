// End to end against the real native core: BridgeEngine + NativeRecorder over the WebSocket transport to rig-devhost
// (null audio backend). Opt-in, because it needs the C++ build: RIG_DEVHOST=1 (binary at
// native/core/build-t09/rig-devhost) or RIG_DEVHOST=<path to rig-devhost>. Skipped otherwise.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeEngine } from '../../../app/js/engine-bridge/bridge-engine.js';
import { websocketTransport } from '../../../app/js/engine-bridge/ws-transport.js';
import { NativeRecorder } from '../../../app/js/engine-bridge/native-recorder.js';
import { startDevhost, devhostBinary } from './devhost-proc.mjs';
import { TEST_PATCH } from './rec-scenario.mjs';

const enabled = !!process.env.RIG_DEVHOST && !!devhostBinary();
const skip = enabled ? false : 'opt-in: set RIG_DEVHOST=1 (or a rig-devhost path) after building native/devhost';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let host;
let dir;

before(async () => {
  if (!enabled) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-devhost-e2e-'));
  host = await startDevhost({ extra: ['--recordings', dir, '--seed', '9'] });
});

after(async () => {
  if (host) await host.stop();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await wait(20);
  }
  return fn();
}

test('HTTP side: the app, the swapped main.js import, the contract', { skip }, async () => {
  const root = await fetch(`${host.base}/`);
  assert.equal(root.status, 200);
  const main = await (await fetch(`${host.base}/js/main.js`)).text();
  assert.match(main, /from '\.\/engine-bridge\/boot-devhost\.js'/);
  const api = await (await fetch(`${host.base}/__bridge/engine-api.json`)).json();
  assert.ok(Array.isArray(api.methods));
  assert.equal((await fetch(`${host.base}/api/health`)).status, 200);
});

test('BridgeEngine on the native core: hello, audio, clock, a note on the meters, a take, page replacement',
  { skip }, async (t) => {
    const transport = websocketTransport({ url: host.wsUrl });
    const engine = new BridgeEngine({ transport, app: 'devhost-e2e' });
    const warns = [];
    engine.addEventListener('warn', (e) => warns.push(e.detail.message));
    const info = await engine._hello;
    assert.equal(info.protocol, 1);
    assert.match(info.engine, /^worship-rig-core/);
    try {
      await engine.start();
      t.diagnostic('engine.start(): ok (get instruments answered)');
    } catch (err) {
      // wave 1: no InstrumentService yet (T11), so the shim's start() fails after `audio start` succeeded
      t.diagnostic(`engine.start(): ${err.code} (${err.message})`);
      assert.equal(err.code, 'unsupported');
    }
    await until(() => engine.ctx.state === 'running');
    assert.equal(engine.ctx.state, 'running');
    assert.equal(engine.ctx.sampleRate, 48000);
    const t0 = engine.ctx.currentTime;
    await wait(500);
    const t1 = engine.ctx.currentTime;
    assert.ok(t1 - t0 > 0.3 && t1 - t0 < 0.8, `engine clock advanced ${t1 - t0} s in 0.5 s`);
    const { token } = await engine._req('prepare', { patch: TEST_PATCH });
    assert.equal((await engine._req('commit', { token })).committed, true);
    engine._started = true; // the shim's start() did not finish (see above); noteOn needs it
    engine.noteOn(69, 110);
    let peak = 0;
    const buf = new Float32Array(2048);
    await until(() => {
      engine.analyserL.getFloatTimeDomainData(buf); // the first read subscribes the meters (30 Hz ticks)
      peak = Math.max(peak, buf[0]);
      return peak > 0.01;
    });
    assert.ok(peak > 0.01, `tick peak ${peak}`);
    const rec = new NativeRecorder({ engine });
    const r = await rec.start();
    assert.equal(r.ok, true, JSON.stringify(r));
    await wait(600);
    const res = await rec.stop();
    assert.ok(res.durationSec > 0.4, `take ${res.durationSec} s`);
    assert.ok(fs.existsSync(res.path), res.path);
    assert.equal(fs.statSync(res.path).size, res.bytes);
    engine.noteOff(69);

    // a second page takes over: the first sees its device closed (warn + state closed), the second works
    const t2 = websocketTransport({ url: host.wsUrl });
    const engine2 = new BridgeEngine({ transport: t2, app: 'devhost-e2e-2' });
    assert.equal((await engine2._hello).protocol, 1);
    await until(() => engine.ctx.state === 'closed');
    assert.equal(engine.ctx.state, 'closed');
    assert.ok(warns.some((w) => /replaced by a newer page/.test(w)), warns.join('\n'));
    engine2._dispose();
    engine._dispose();
  });
