// WebSocket transport (ws-transport.js) on a fake WebSocket, through BridgeLink/BridgeEngine. The same transport
// against the real rig-devhost is devhost.test.mjs (opt-in: RIG_DEVHOST=1 or a binary path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { websocketTransport, devhostUrl, DEVHOST_WS_PATH } from '../../../app/js/engine-bridge/ws-transport.js';
import { BridgeLink } from '../../../app/js/engine-bridge/link.js';
import { BridgeEngine } from '../../../app/js/engine-bridge/bridge-engine.js';

class FakeWS {
  static last = null;
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closedWith = null;
    FakeWS.last = this;
  }
  send(s) {
    if (typeof s !== 'string') throw new Error('text only');
    this.sent.push(s);
  }
  close(code, reason) {
    this.closedWith = { code, reason };
    setTimeout(() => this.onclose && this.onclose({ code, reason }), 0);
  }
  // test side
  open() {
    this.onopen();
  }
  recv(x) {
    this.onmessage({ data: typeof x === 'string' ? x : JSON.stringify(x) });
  }
  drop(code = 1006, reason = '') {
    this.onclose({ code, reason });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('devhostUrl: ?devhost= wins, else the page origin (ws / wss)', () => {
  assert.equal(devhostUrl({ search: '?devhost=ws://10.0.0.2:9000/__rig/ws', protocol: 'http:', host: 'x' }),
    'ws://10.0.0.2:9000/__rig/ws');
  assert.equal(devhostUrl({ search: '', protocol: 'http:', host: '127.0.0.1:8440' }),
    `ws://127.0.0.1:8440${DEVHOST_WS_PATH}`);
  assert.equal(devhostUrl({ search: '?spy=1', protocol: 'https:', host: 'h:1' }), `wss://h:1${DEVHOST_WS_PATH}`);
  assert.equal(devhostUrl(undefined), `ws://127.0.0.1:8440${DEVHOST_WS_PATH}`);
});

test('posts before open are queued in order and flushed on open; one JSON text frame each', () => {
  const t = websocketTransport({ url: 'ws://x/__rig/ws', WebSocketImpl: FakeWS });
  const ws = FakeWS.last;
  assert.equal(t.state, 'connecting');
  t.post({ v: 1, op: 'hello', id: 1 });
  t.post({ v: 1, op: 'audio', id: 2, action: 'start' });
  assert.equal(ws.sent.length, 0);
  ws.open();
  assert.equal(t.state, 'open');
  assert.deepEqual(ws.sent.map((s) => JSON.parse(s).op), ['hello', 'audio']);
  t.post({ v: 1, op: 'play', e: 'on', n: 60, vel: 90 });
  assert.equal(ws.sent.length, 3);
  assert.equal(t.stats.queuedBeforeOpen, 2);
  assert.equal(t.stats.sent, 3);
});

test('incoming frames: parsed, batches delivered whole, early batches replayed to the first listener', () => {
  const t = websocketTransport({ url: 'ws://x', WebSocketImpl: FakeWS });
  const ws = FakeWS.last;
  ws.open();
  ws.recv({ v: 1, ev: 'tick', t: 1 }); // before any listener: parked
  const got = [];
  t.onMessage((b) => got.push(b));
  ws.recv([{ v: 1, ev: 'state', state: 'running' }, { v: 1, re: 1, ok: true, result: {} }]);
  ws.recv('{not json');
  ws.onmessage({ data: new ArrayBuffer(4) });
  assert.equal(got.length, 2);
  assert.equal(got[0].ev, 'tick');
  assert.ok(Array.isArray(got[1]) && got[1].length === 2);
  assert.equal(t.stats.badFrames, 2);
  assert.equal(t.stats.received, 2);
});

test('lost connection: new requests fail fast as closed; the page sees warn + state closed', async () => {
  const t = websocketTransport({ url: 'ws://x', WebSocketImpl: FakeWS });
  const ws = FakeWS.last;
  const events = [];
  const link = new BridgeLink(t, { onEvent: (m) => events.push(m) });
  const p = link.request('get', { what: 'state' });
  ws.open();
  ws.drop(1006, '');
  // an in-flight request waits for its own timeout (the link has no transport-close hook; boot-devhost.js closes
  // the link on a lost socket, which rejects it) but every new one is refused at once
  await assert.rejects(link.request('hello'), (e) => e.code === 'closed');
  assert.deepEqual(events.map((e) => e.ev), ['warn', 'state']);
  assert.equal(events[0].code, 'device');
  assert.match(events[0].message, /connection lost \(1006\); reload the page/);
  assert.equal(events[1].state, 'closed');
  link.close();
  await assert.rejects(p, (e) => e.code === 'closed');
});

test('close() from our side: no synthesized events, socket closed with 1000', async () => {
  const t = websocketTransport({ url: 'ws://x', WebSocketImpl: FakeWS });
  const ws = FakeWS.last;
  const got = [];
  t.onMessage((b) => got.push(b));
  ws.open();
  t.close();
  await tick();
  assert.equal(ws.closedWith.code, 1000);
  assert.equal(got.length, 0);
  assert.throws(() => t.post({ v: 1, op: 'play' }), /closed/);
});

test('BridgeEngine over the transport: hello round trip, a lost host shows up as ctx.state closed + warn', async () => {
  const t = websocketTransport({ url: 'ws://x', WebSocketImpl: FakeWS });
  const ws = FakeWS.last;
  const engine = new BridgeEngine({ transport: t });
  const warns = [];
  const states = [];
  engine.addEventListener('warn', (e) => warns.push(e.detail.message));
  engine.addEventListener('statechange', (e) => states.push(e.detail.state));
  ws.open();
  const hello = JSON.parse(ws.sent[0]);
  assert.equal(hello.op, 'hello');
  const result = { protocol: 1, minor: 0, engine: 'fake', caps: [], sampleRate: 44100 };
  ws.recv({ v: 1, re: hello.id, ok: true, result });
  await tick();
  assert.equal(engine.ctx.sampleRate, 44100);
  ws.drop(1001, 'rig-devhost shutting down');
  assert.equal(engine.ctx.state, 'closed');
  assert.deepEqual(states, ['closed']);
  assert.match(warns.join('\n'), /Native dev host: rig-devhost shutting down/);
  engine._dispose();
});

test('a missing WebSocket implementation or url is a constructor error', () => {
  assert.throws(() => websocketTransport({ url: 'ws://x', WebSocketImpl: null }), /no WebSocket/);
  assert.throws(() => websocketTransport({ WebSocketImpl: FakeWS }), /url is required/);
});
