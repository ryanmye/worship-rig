// BRIDGE v1 link layer (native/docs/ENGINE_CONTRACT.md section 6.1-6.2): envelope, id correlation, timeouts, in-order
// delivery of native batches. No engine knowledge lives here, so the MIDI adapter and the recorder bridge can reuse it.
// Pure JS, no DOM: runs in Node tests and in a WebView.

export const PROTOCOL = 1;

/** Error codes of the bridge (engine-api.json messages.errors) plus the two the link itself raises. */
export class BridgeError extends Error {
  /**
   * @param {string} code contract code ('bad-request', 'not-started', ...) or 'timeout' / 'closed' (link-local)
   * @param {string} message
   * @param {{op?:string, detail?:any}} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.op = extra.op;
    this.detail = extra.detail;
  }
}

/** Per-op reply timeouts in ms. A decode-heavy prepare or preload is allowed to take minutes on a cold cache. */
export const DEFAULT_TIMEOUTS = Object.freeze({
  hello: 5000, audio: 20000, prepare: 120000, commit: 10000, cache: 300000, set: 10000, song: 10000, drone: 10000,
  play: 10000, click: 10000, config: 10000, get: 15000, midi: 10000, rec: 15000,
});
const FALLBACK_TIMEOUT_MS = 10000;

/**
 * @typedef {{post:(msg:object)=>void, onMessage:(cb:(m:object|object[])=>void)=>(()=>void)|void, close?:()=>void}} Transport
 */

export class BridgeLink {
  /**
   * @param {Transport} transport
   * @param {{timers?:{setTimeout:Function, clearTimeout:Function}, timeouts?:object,
   *   onEvent?:(msg:object)=>void, onProtocolError?:(info:object)=>void}} [o]
   */
  constructor(transport, o = {}) {
    if (!transport || typeof transport.post !== 'function' || typeof transport.onMessage !== 'function') {
      throw new TypeError('BridgeLink: transport needs post(msg) and onMessage(cb)');
    }
    this.transport = transport;
    this.timers = o.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) };
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...(o.timeouts || {}) };
    this.onEvent = o.onEvent || null;
    this.onProtocolError = o.onProtocolError || null;
    /** @type {Map<number, {resolve:Function, reject:Function, timer:any, op:string, sentAt:number}>} */
    this.pending = new Map();
    this.nextId = 1;
    this.stats = { sent: 0, requests: 0, replies: 0, events: 0, timeouts: 0, lateReplies: 0, badMessages: 0 };
    this.closed = false;
    const off = transport.onMessage((m) => this._receive(m));
    this._off = typeof off === 'function' ? off : null;
  }

  /**
   * Fire-and-forget message (no id, so native never replies; its errors come back as `warn` events).
   * @returns {boolean} false when the transport refused it
   */
  send(op, args = {}) {
    return this._post({ v: PROTOCOL, op, ...args });
  }

  /**
   * Request with exactly one reply.
   * @returns {Promise<any>} the reply `result`; rejects with BridgeError (error reply, 'timeout', 'closed')
   */
  request(op, args = {}, { timeoutMs } = {}) {
    if (this.closed) return Promise.reject(new BridgeError('closed', `bridge closed (${op})`, { op }));
    const id = this.nextId++;
    const ms = timeoutMs ?? this.timeouts[op] ?? FALLBACK_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, op, timer: null, sentAt: Date.now() };
      entry.timer = this.timers.setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.stats.timeouts += 1;
        reject(new BridgeError('timeout', `${op} timed out after ${ms} ms`, { op }));
      }, ms);
      this.pending.set(id, entry);
      this.stats.requests += 1;
      if (!this._post({ v: PROTOCOL, op, id, ...args })) {
        this.pending.delete(id);
        this.timers.clearTimeout(entry.timer);
        reject(new BridgeError('closed', `transport refused ${op}`, { op }));
      }
    });
  }

  /** Reject everything in flight and stop listening. */
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._off) this._off();
    for (const [id, e] of this.pending) {
      this.timers.clearTimeout(e.timer);
      e.reject(new BridgeError('closed', `bridge closed (${e.op})`, { op: e.op }));
      this.pending.delete(id);
    }
    if (typeof this.transport.close === 'function') this.transport.close();
  }

  _post(msg) {
    if (this.closed) return false;
    try {
      this.transport.post(msg);
      this.stats.sent += 1;
      return true;
    } catch (err) {
      this._bad({ reason: 'post-failed', message: String(err && err.message), op: msg.op });
      return false;
    }
  }

  _bad(info) {
    this.stats.badMessages += 1;
    if (this.onProtocolError) {
      try {
        this.onProtocolError(info);
      } catch {
        /* a listener must not break delivery */
      }
    }
  }

  /**
   * One message or an ordered array (native batches one main-thread turn). Strictly in order. Arrays may nest: the
   * Swift shell joins several core callbacks (each already a message or an array) into one evaluateJavaScript call.
   */
  _receive(batch) {
    if (Array.isArray(batch)) for (const m of batch) this._receive(m);
    else this._one(batch);
  }

  _one(m) {
    if (!m || typeof m !== 'object') return this._bad({ reason: 'not-an-object' });
    if (m.re !== undefined) {
      const e = this.pending.get(m.re);
      if (!e) {
        this.stats.lateReplies += 1;
        return undefined;
      }
      this.pending.delete(m.re);
      this.timers.clearTimeout(e.timer);
      this.stats.replies += 1;
      if (m.v !== PROTOCOL) {
        e.reject(new BridgeError('protocol', `reply with protocol v${m.v}`, { op: e.op }));
      } else if (m.ok) e.resolve(m.result);
      else {
        const er = m.error || {};
        e.reject(new BridgeError(er.code || 'internal', er.message || `${e.op} failed`, { op: e.op, detail: er.detail }));
      }
      return undefined;
    }
    if (m.ev === undefined) return this._bad({ reason: 'no-ev-or-re', msg: m });
    if (m.v !== PROTOCOL) return this._bad({ reason: 'protocol', v: m.v, ev: m.ev });
    this.stats.events += 1;
    if (this.onEvent) {
      try {
        this.onEvent(m);
      } catch (err) {
        this._bad({ reason: 'handler-threw', ev: m.ev, message: String(err && err.message) });
      }
    }
    return undefined;
  }
}
