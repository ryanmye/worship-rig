// Transports for the BRIDGE v1 link (contract 6.1). A transport is {post(msg), onMessage(cb) -> off, close?()}.
//  - webkitTransport: WKWebView. JS -> native with window.webkit.messageHandlers.rig.postMessage(obj) (a plain
//    JSON-able object, no stringify); native -> JS through window.__rigNative.receive(batch), called by
//    evaluateJavaScript with one message or an ordered array (a JSON string is accepted too).
//  - loopbackPair: two connected ends in one realm (tests, and the Chromium boot against mock-native.js).

/** @param {object} [win] */
export function webkitAvailable(win = globalThis) {
  const h = win && win.webkit && win.webkit.messageHandlers && win.webkit.messageHandlers.rig;
  return !!(h && typeof h.postMessage === 'function');
}

/**
 * WKWebView transport. Installs window.__rigNative.receive. Batches that native delivered before this ran (a user
 * script may park them in `__rigNative.queue`) are replayed in order on the first onMessage().
 * @param {{win?:object}} [o]
 */
export function webkitTransport({ win = globalThis } = {}) {
  if (!webkitAvailable(win)) throw new Error('webkitTransport: window.webkit.messageHandlers.rig is not available');
  const handler = win.webkit.messageHandlers.rig;
  const listeners = new Set();
  const root = win.__rigNative && typeof win.__rigNative === 'object' ? win.__rigNative : (win.__rigNative = {});
  const parked = Array.isArray(root.queue) ? root.queue.splice(0) : [];
  const deliver = (batch) => {
    let b = batch;
    if (typeof b === 'string') {
      try {
        b = JSON.parse(b);
      } catch {
        return;
      }
    }
    for (const l of [...listeners]) l(b);
  };
  root.receive = deliver;
  return {
    kind: 'webkit',
    post(msg) {
      handler.postMessage(msg);
    },
    onMessage(cb) {
      listeners.add(cb);
      if (parked.length) {
        const p = parked.splice(0);
        for (const b of p) cb(typeof b === 'string' ? JSON.parse(b) : b);
      }
      return () => listeners.delete(cb);
    },
    close() {
      listeners.clear();
      if (root.receive === deliver) root.receive = () => {};
    },
  };
}

/**
 * Two connected ends. `js.post(m)` arrives at the callbacks registered with `native.onMessage` and vice versa. Messages
 * are structured-cloned through JSON (as the real bridge does), so a test cannot pass live objects by accident.
 * @param {{schedule?:'sync'|'microtask'|'macrotask'|((fn:Function)=>void), clone?:boolean}} [o]
 */
export function loopbackPair({ schedule = 'sync', clone = true } = {}) {
  const run = typeof schedule === 'function' ? schedule
    : schedule === 'microtask' ? (fn) => queueMicrotask(fn)
      : schedule === 'macrotask' ? (fn) => setTimeout(fn, 0) : (fn) => fn();
  const log = { toNative: [], toJs: [] };
  const make = (inbox, outbox, outLog) => {
    const listeners = inbox;
    return {
      kind: 'loopback',
      post(msg) {
        const m = clone ? JSON.parse(JSON.stringify(msg)) : msg;
        outLog.push(m);
        run(() => {
          for (const l of [...outbox]) l(m);
        });
      },
      onMessage(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      close() {
        listeners.clear();
      },
    };
  };
  const jsInbox = new Set();
  const nativeInbox = new Set();
  const js = make(jsInbox, nativeInbox, log.toNative);
  const native = make(nativeInbox, jsInbox, log.toJs);
  return { js, native, log };
}
