// Reply correlation, timeouts, ordering and error mapping of the BRIDGE v1 link (contract 6.1-6.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeLink, BridgeError, DEFAULT_TIMEOUTS } from '../../../app/js/engine-bridge/link.js';
import { fakeEnv } from './helpers.mjs';

/** A transport whose far end is the test itself. */
function manual() {
  const sent = [];
  let cb = null;
  return {
    sent,
    deliver: (m) => cb && cb(m),
    t: {
      post: (m) => sent.push(m),
      onMessage: (f) => {
        cb = f;
        return () => {
          cb = null;
        };
      },
    },
  };
}

test('requests carry v, op and increasing integer ids; send() carries no id', () => {
  const m = manual();
  const link = new BridgeLink(m.t, { timers: fakeEnv().timers });
  link.request('get', { what: 'devices' }).catch(() => {});
  link.request('get', { what: 'stats' }).catch(() => {});
  link.send('play', { e: 'panic' });
  assert.deepEqual(m.sent[0], { v: 1, op: 'get', id: 1, what: 'devices' });
  assert.equal(m.sent[1].id, 2);
  assert.equal('id' in m.sent[2], false);
  assert.equal(link.pending.size, 2);
});

test('replies resolve the matching request even when they arrive out of order', async () => {
  const m = manual();
  const link = new BridgeLink(m.t, { timers: fakeEnv().timers });
  const a = link.request('prepare', { patch: {} });
  const b = link.request('get', { what: 'stats' });
  m.deliver({ v: 1, re: 2, ok: true, result: 'quick' });
  m.deliver({ v: 1, re: 1, ok: true, result: { token: 7 } });
  assert.equal(await b, 'quick');
  assert.deepEqual(await a, { token: 7 });
  assert.equal(link.pending.size, 0);
});

test('an error reply rejects with a BridgeError carrying code, op and detail', async () => {
  const m = manual();
  const link = new BridgeLink(m.t, { timers: fakeEnv().timers });
  const p = link.request('commit', { token: 3 });
  m.deliver({ v: 1, re: 1, ok: false, error: { code: 'stale-token', message: 'gone', detail: { token: 3 } } });
  await assert.rejects(p, (e) => e instanceof BridgeError && e.code === 'stale-token' && e.op === 'commit'
    && e.detail.token === 3);
});

test('a request times out after its per-op budget; a late reply is counted and ignored', async () => {
  const env = fakeEnv();
  const m = manual();
  const link = new BridgeLink(m.t, { timers: env.timers, timeouts: { get: 500 } });
  const p = link.request('get', { what: 'stats' });
  const q = link.request('prepare', { patch: {} });
  env.advance(499);
  assert.equal(link.pending.size, 2);
  env.advance(2);
  await assert.rejects(p, (e) => e.code === 'timeout' && e.op === 'get');
  assert.equal(link.pending.size, 1);
  m.deliver({ v: 1, re: 1, ok: true, result: {} });
  assert.equal(link.stats.lateReplies, 1);
  env.advance(DEFAULT_TIMEOUTS.prepare);
  await assert.rejects(q, (e) => e.code === 'timeout');
  assert.equal(link.stats.timeouts, 2);
  assert.equal(env.pending(), 0);
});

test('a reply clears its timer', async () => {
  const env = fakeEnv();
  const m = manual();
  const link = new BridgeLink(m.t, { timers: env.timers });
  const p = link.request('hello', { protocol: 1, app: 't' });
  assert.equal(env.pending(), 1);
  m.deliver({ v: 1, re: 1, ok: true, result: {} });
  await p;
  assert.equal(env.pending(), 0);
});

test('batches are processed strictly in order, replies and events interleaved', async () => {
  const m = manual();
  const seen = [];
  let link;
  const onEvent = (e) => seen.push(`${e.ev}:pending=${link.pending.size}`);
  link = new BridgeLink(m.t, { timers: fakeEnv().timers, onEvent });
  const p = link.request('get', { what: 'devices' });
  m.deliver([{ v: 1, ev: 'notes', held: [] }, { v: 1, re: 1, ok: true, result: 'x' }, { v: 1, ev: 'wheel' }]);
  assert.equal(await p, 'x');
  // the reply sat between the two events: it was still pending for the first, already consumed for the second
  assert.deepEqual(seen, ['notes:pending=1', 'wheel:pending=0']);
});

test('events with another protocol version are dropped and reported; unknown fields are ignored', () => {
  const m = manual();
  const bad = [];
  const seen = [];
  const link = new BridgeLink(m.t, {
    timers: fakeEnv().timers, onEvent: (e) => seen.push(e), onProtocolError: (i) => bad.push(i.reason),
  });
  m.deliver({ v: 2, ev: 'tick' });
  m.deliver({ v: 1, ev: 'tick', future: true });
  m.deliver('garbage');
  m.deliver({ v: 1 });
  assert.equal(seen.length, 1);
  assert.deepEqual(bad, ['protocol', 'not-an-object', 'no-ev-or-re']);
});

test('a reply with a different protocol version rejects the request with code protocol', async () => {
  const m = manual();
  const link = new BridgeLink(m.t, { timers: fakeEnv().timers });
  const p = link.request('hello', {});
  m.deliver({ v: 9, re: 1, ok: true, result: {} });
  await assert.rejects(p, (e) => e.code === 'protocol');
});

test('a throwing event handler does not stop the rest of the batch', () => {
  const m = manual();
  const seen = [];
  const link = new BridgeLink(m.t, {
    timers: fakeEnv().timers,
    onEvent: (e) => {
      if (e.ev === 'a') throw new Error('boom');
      seen.push(e.ev);
    },
  });
  m.deliver([{ v: 1, ev: 'a' }, { v: 1, ev: 'b' }]);
  assert.deepEqual(seen, ['b']);
  assert.equal(link.stats.badMessages, 1);
});

test('close() rejects everything in flight and later requests', async () => {
  const env = fakeEnv();
  const m = manual();
  const link = new BridgeLink(m.t, { timers: env.timers });
  const p = link.request('get', { what: 'stats' });
  link.close();
  await assert.rejects(p, (e) => e.code === 'closed');
  await assert.rejects(link.request('get', {}), (e) => e.code === 'closed');
  assert.equal(link.send('play', { e: 'panic' }), false);
  assert.equal(env.pending(), 0);
});

test('a transport that throws in post() rejects the request and reports', async () => {
  const bad = [];
  const link = new BridgeLink({
    post() {
      throw new Error('no handler');
    },
    onMessage: () => () => {},
  }, { timers: fakeEnv().timers, onProtocolError: (i) => bad.push(i.reason) });
  await assert.rejects(link.request('hello', {}), (e) => e.code === 'closed');
  assert.deepEqual(bad, ['post-failed']);
  assert.equal(link.send('play', {}), false);
});

test('the transport must provide post and onMessage', () => {
  assert.throws(() => new BridgeLink({}), TypeError);
});
