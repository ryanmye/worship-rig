// Lane N0 (NMA review O3): a failed first `midi listen` no longer leaves the page without MIDI for its life. A
// retryable failure (link timeout, busy, not-started, internal) is retried after LISTEN_RETRY_MS, then on the next
// `ports` event (a hot-plug); requestMIDIAccess() stays pending meanwhile (the controller's L-3 "starting" state) and
// midi.js wires the inputs up when it resolves. Anything else rejects at once (the existing NMA test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, flush } from './helpers.mjs';
import { BridgeEngine } from '../../../app/js/engine-bridge/bridge-engine.js';
import { loopbackPair } from '../../../app/js/engine-bridge/transports.js';
import { installNativeMidi, LISTEN_RETRY_MS } from '../../../app/js/engine-bridge/native-midi.js';
import { MidiInput } from '../../../app/js/midi.js';

const NORD = { id: 'k1', name: 'Nord Stage 3 MIDI Output', manufacturer: 'Clavia', kind: 'input', state: 'connected' };

/** Engine over a loopback whose native side answers nothing by itself; the test replies by hand. */
function setup() {
  const env = fakeEnv();
  const { js, native, log } = loopbackPair({ schedule: 'sync' });
  native.onMessage(() => {});
  const engine = new BridgeEngine({ transport: js, now: env.now, timers: env.timers });
  const nav = {};
  const access = installNativeMidi(engine, { nav });
  const midi = new MidiInput({ nav, now: env.now, warn: () => {} });
  const unavailable = [];
  midi.addEventListener('unavailable', (e) => unavailable.push(e.detail.reason));
  const listens = () => log.toNative.filter((m) => m.op === 'midi' && m.action === 'listen');
  const reply = (req, body) => native.post({ v: 1, re: req.id, ...body });
  const settled = (p) => {
    const box = { done: false, value: undefined };
    p.then((v) => Object.assign(box, { done: true, value: v }));
    return box;
  };
  return { env, native, engine, nav, access, midi, unavailable, listens, reply, settled };
}

test('the backoff: 1 s, 2 s, 4 s, 8 s, then hot-plug only', () => {
  assert.deepEqual([...LISTEN_RETRY_MS], [1000, 2000, 4000, 8000]);
  assert.ok(Object.isFrozen(LISTEN_RETRY_MS));
});

test('a first listen that times out is retried after 1 s; the late success wires midi.js up, no "failed"',
  async () => {
    const r = setup();
    const init = r.settled(r.midi.init());
    await flush();
    assert.equal(r.listens().length, 1);
    r.env.advance(10000); // BridgeLink's midi timeout (link.js DEFAULT_TIMEOUTS.midi)
    await flush();
    assert.equal(r.listens().length, 1, 'not yet: waiting 1 s');
    assert.equal(r.access.stats.listenRetries, 1);
    r.env.advance(999);
    await flush();
    assert.equal(r.listens().length, 1);
    r.env.advance(1);
    await flush();
    const second = r.listens()[1];
    assert.ok(second, 'retried after 1 s');
    assert.equal(init.done, false, 'requestMIDIAccess stays pending meanwhile');
    r.reply(second, { ok: true, result: { ports: [NORD] } });
    await flush();
    await flush();
    assert.equal(init.done, true);
    assert.equal(init.value, true);
    assert.deepEqual(r.unavailable, []);
    assert.equal(r.midi.available, true);
    assert.equal(r.access.inputs.get('k1').state, 'connected');
    await flush();
    assert.deepEqual(r.listens().at(-1).ids, ['k1'], 'midi.js attached the keyboard: the listen set follows');
  });

test('busy every time: retries at 1, 2, 4, 8 s, then waits; a hot-plug (`ports`) retries and succeeds', async () => {
  const r = setup();
  const init = r.settled(r.midi.init());
  await flush();
  const fail = async () => {
    r.reply(r.listens().at(-1), { ok: false, error: { code: 'busy', message: 'audio restart in progress' } });
    await flush();
  };
  await fail();
  for (const ms of LISTEN_RETRY_MS) {
    const n = r.listens().length;
    r.env.advance(ms - 1);
    await flush();
    assert.equal(r.listens().length, n, `not before ${ms} ms`);
    r.env.advance(1);
    await flush();
    assert.equal(r.listens().length, n + 1, `retried after ${ms} ms`);
    await fail();
  }
  const n = r.listens().length;
  assert.equal(n, 1 + LISTEN_RETRY_MS.length);
  r.env.advance(600000);
  await flush();
  assert.equal(r.listens().length, n, 'backoff spent: no timer retries any more');
  assert.equal(init.done, false);
  assert.deepEqual(r.unavailable, [], 'never reported "failed": the controller shows "starting"');
  // the player replugs the keyboard: the core reports its ports
  r.native.post({ v: 1, ev: 'midi', type: 'ports', ports: [NORD] });
  await flush();
  const again = r.listens().at(-1);
  assert.equal(r.listens().length, n + 1, 'the hot-plug retried at once');
  r.reply(again, { ok: true, result: { ports: [NORD] } });
  await flush();
  await flush();
  assert.equal(init.done, true);
  assert.equal(r.midi.available, true);
  assert.equal(r.access.stats.listenRetries, 1 + LISTEN_RETRY_MS.length);
});

test('a hot-plug during the backoff wait retries at once (and cancels the timer)', async () => {
  const r = setup();
  r.settled(r.midi.init());
  await flush();
  r.reply(r.listens()[0], { ok: false, error: { code: 'not-started', message: 'no engine yet' } });
  await flush();
  r.native.post({ v: 1, ev: 'midi', type: 'ports', ports: [NORD] });
  await flush();
  assert.equal(r.listens().length, 2);
  r.reply(r.listens()[1], { ok: true, result: { ports: [NORD] } });
  await flush();
  r.env.advance(5000);
  await flush();
  assert.equal(r.listens().filter((m) => m.id !== undefined).length, 2, 'the cancelled timer sent nothing');
});

test('a non-retryable error still rejects at once; dispose() stops a pending retry', async () => {
  const a = setup();
  const p = a.midi.init();
  await flush();
  a.reply(a.listens()[0], { ok: false, error: { code: 'unsupported', message: 'no midi service' } });
  assert.equal(await p, false);
  assert.deepEqual(a.unavailable, ['failed']);
  assert.equal(a.access.stats.listenRetries, 0);

  const b = setup();
  b.settled(b.midi.init());
  await flush();
  b.reply(b.listens()[0], { ok: false, error: { code: 'internal', message: 'x' } });
  await flush();
  b.access.dispose();
  b.env.advance(60000);
  b.native.post({ v: 1, ev: 'midi', type: 'ports', ports: [NORD] });
  await flush();
  assert.equal(b.listens().length, 1, 'disposed: no retry by timer or hot-plug');
});
