// WebSocket transport for the BRIDGE v1 link (contract 6.1), used against the native dev host (native/devhost,
// `rig-devhost`): the same {post, onMessage, close} shape as transports.js, so BridgeLink/BridgeEngine run unchanged.
// JS -> native: one JSON text frame per message. native -> JS: one text frame per core on_event payload (a message
// or an ordered array, exactly what `__rigNative.receive` gets under WKWebView).
//
// No reconnect: a new socket is a new page for the dev host (it posts panic + rec stop for the old one and the core
// expects `hello` first), so a lost connection is reported as a closed device and the page is reloaded by the user.
// Pure JS, no DOM: runs in Node (global WebSocket, Node 22) and in Chromium.

export const DEVHOST_WS_PATH = '/__rig/ws';

/**
 * Where the dev host listens: `?devhost=ws://host:port/__rig/ws` if given, else the page's own origin (rig-devhost
 * serves the app and the socket on one port).
 * @param {{search?:string, protocol?:string, host?:string}} [loc]
 */
export function devhostUrl(loc = globalThis.location) {
  try {
    const q = new URLSearchParams((loc && loc.search) || '').get('devhost');
    if (q) return q;
  } catch {
    /* no URLSearchParams: fall through */
  }
  const proto = loc && loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${(loc && loc.host) || '127.0.0.1:8440'}${DEVHOST_WS_PATH}`;
}

/**
 * @param {object} o
 * @param {string} o.url
 * @param {Function} [o.WebSocketImpl] default globalThis.WebSocket
 * @param {(state:'open'|'closed'|'error', info?:object)=>void} [o.onStatus]
 * @param {number} [o.maxQueued] messages held while connecting (then post throws)
 * @param {boolean} [o.synthesizeClose] on an unexpected close, deliver a `warn` (code 'device') and a
 *   `state {state:'closed'}` event to the listeners, as native would for a lost device (default true)
 */
export function websocketTransport({
  url, WebSocketImpl = globalThis.WebSocket, onStatus, maxQueued = 4096, synthesizeClose = true,
} = {}) {
  if (typeof WebSocketImpl !== 'function') throw new Error('websocketTransport: no WebSocket implementation');
  if (!url) throw new Error('websocketTransport: url is required');
  const ws = new WebSocketImpl(url);
  const listeners = new Set();
  const parked = [];
  const outbox = [];
  const stats = { sent: 0, received: 0, badFrames: 0, queuedBeforeOpen: 0 };
  let state = 'connecting';
  let closedByUs = false;
  const tell = (s, info) => {
    if (!onStatus) return;
    try {
      onStatus(s, info);
    } catch {
      /* a status listener must not break the transport */
    }
  };
  const deliver = (batch) => {
    if (!listeners.size) {
      parked.push(batch);
      return;
    }
    for (const l of [...listeners]) l(batch);
  };
  ws.onopen = () => {
    if (state !== 'connecting') return;
    state = 'open';
    for (const s of outbox.splice(0)) ws.send(s);
    tell('open');
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') {
      stats.badFrames += 1; // the bridge is JSON text only (contract 6.1: no binary payloads)
      return;
    }
    let b;
    try {
      b = JSON.parse(ev.data);
    } catch {
      stats.badFrames += 1;
      return;
    }
    stats.received += 1;
    deliver(b);
  };
  ws.onerror = () => tell('error');
  ws.onclose = (ev) => {
    const was = state;
    state = 'closed';
    outbox.length = 0;
    const info = { code: ev && ev.code, reason: (ev && ev.reason) || '', wasOpen: was === 'open' };
    tell('closed', info);
    if (closedByUs || !synthesizeClose) return;
    const why = info.reason || (was === 'open' ? 'connection lost' : 'could not connect');
    deliver([
      { v: 1, ev: 'warn', code: 'device', message: `Native dev host: ${why} (${info.code ?? '?'}); reload the page` },
      { v: 1, ev: 'state', state: 'closed' },
    ]);
  };
  return {
    kind: 'websocket',
    url,
    stats,
    get state() {
      return state;
    },
    /** Throws once closed (BridgeLink then rejects the request with 'closed' instead of waiting for a timeout). */
    post(msg) {
      if (state === 'closed') throw new Error(`websocket closed (${url})`);
      const s = JSON.stringify(msg);
      if (state === 'connecting') {
        if (outbox.length >= maxQueued) throw new Error('websocket not open yet: send queue full');
        outbox.push(s);
        stats.queuedBeforeOpen += 1;
      } else ws.send(s);
      stats.sent += 1;
    },
    /** Batches that arrived before the first listener are replayed to it, in order. */
    onMessage(cb) {
      listeners.add(cb);
      if (parked.length) for (const b of parked.splice(0)) cb(b);
      return () => listeners.delete(cb);
    },
    close() {
      closedByUs = true;
      listeners.clear();
      if (state !== 'closed') {
        try {
          ws.close(1000, 'page closed the bridge');
        } catch {
          /* already closing */
        }
      }
    },
  };
}
