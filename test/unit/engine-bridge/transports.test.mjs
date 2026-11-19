import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webkitTransport, webkitAvailable, loopbackPair } from '../../../app/js/engine-bridge/transports.js';
import { BridgeEngine } from '../../../app/js/engine-bridge/bridge-engine.js';

function fakeWindow() {
  const posted = [];
  return { posted, webkit: { messageHandlers: { rig: { postMessage: (m) => posted.push(m) } } } };
}

test('webkitAvailable only when window.webkit.messageHandlers.rig.postMessage exists', () => {
  assert.equal(webkitAvailable({}), false);
  assert.equal(webkitAvailable({ webkit: { messageHandlers: {} } }), false);
  assert.equal(webkitAvailable(fakeWindow()), true);
  assert.equal(BridgeEngine._available({}), false);
});

test('webkitTransport posts objects as they are and receives batches through __rigNative.receive', () => {
  const win = fakeWindow();
  const t = webkitTransport({ win });
  const got = [];
  const off = t.onMessage((m) => got.push(m));
  t.post({ v: 1, op: 'hello', id: 1 });
  assert.deepEqual(win.posted, [{ v: 1, op: 'hello', id: 1 }]);
  win.__rigNative.receive([{ v: 1, ev: 'tick' }, { v: 1, ev: 'notes' }]);
  win.__rigNative.receive({ v: 1, ev: 'wheel' });
  win.__rigNative.receive('{"v":1,"ev":"click"}');
  win.__rigNative.receive('not json');
  assert.deepEqual(got, [[{ v: 1, ev: 'tick' }, { v: 1, ev: 'notes' }], { v: 1, ev: 'wheel' }, { v: 1, ev: 'click' }]);
  off();
  win.__rigNative.receive({ v: 1, ev: 'x' });
  assert.equal(got.length, 3);
});

test('batches parked by a document-start user script are replayed on the first listener', () => {
  const win = fakeWindow();
  win.__rigNative = { queue: [{ v: 1, ev: 'state' }, '{"v":1,"ev":"tick"}'] };
  const t = webkitTransport({ win });
  const got = [];
  t.onMessage((m) => got.push(m));
  assert.deepEqual(got, [{ v: 1, ev: 'state' }, { v: 1, ev: 'tick' }]);
  assert.equal(win.__rigNative.queue.length, 0);
});

test('webkitTransport without the handler throws a clear error', () => {
  assert.throws(() => webkitTransport({ win: {} }), /messageHandlers\.rig/);
});

test('loopbackPair clones through JSON, keeps order and logs both directions', async () => {
  const { js, native, log } = loopbackPair({ schedule: 'microtask' });
  const atNative = [];
  native.onMessage((m) => atNative.push(m));
  const live = { v: 1, op: 'x', set: new Set([1]), n: undefined, k: 1 };
  js.post(live);
  js.post({ v: 1, op: 'y' });
  assert.deepEqual(atNative, [], 'microtask schedule: not yet');
  await Promise.resolve();
  assert.deepEqual(atNative.map((m) => m.op), ['x', 'y']);
  assert.deepEqual(atNative[0].set, {}, 'cloned through JSON, not shared');
  assert.equal(log.toNative.length, 2);
});

test('loopbackPair: native -> js and close()', () => {
  const { js, native } = loopbackPair();
  const got = [];
  js.onMessage((m) => got.push(m));
  native.post([{ ev: 'a' }]);
  js.close();
  native.post({ ev: 'b' });
  assert.deepEqual(got, [[{ ev: 'a' }]]);
});

test('BridgeEngine picks the webkit transport by default and talks through it', async () => {
  const win = fakeWindow();
  const prev = globalThis.webkit;
  const prevNative = globalThis.__rigNative;
  globalThis.webkit = win.webkit;
  try {
    const e = new BridgeEngine();
    assert.equal(win.posted[0].op, 'hello');
    assert.equal(win.posted[0].v, 1);
    assert.equal(typeof win.posted[0].id, 'number');
    const result = { protocol: 1, sampleRate: 44100 };
    globalThis.__rigNative.receive({ v: 1, re: win.posted[0].id, ok: true, result });
    await new Promise((r) => setImmediate(r));
    assert.equal(e.ctx.sampleRate, 44100);
    e._dispose();
  } finally {
    globalThis.webkit = prev;
    globalThis.__rigNative = prevNative;
  }
});
