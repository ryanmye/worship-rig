// NativeMidiAccess (lane NMA; contract 5 "v1 default", 6.4 `midi`, 6.5 `midi` events; WEBKIT_AUDIT A5): the Web MIDI
// surface midi.js and midi-clock.js read, fed by the native bridge, for a page without Web MIDI (WKWebView). midi.js
// runs unchanged: `navigator.requestMIDIAccess({sysex:false})` resolves with an object that has
//   inputs / outputs        Map<id, port> (Web MIDI's maplike: values(), get(), size, forEach)
//   onstatechange / addEventListener('statechange')   an Event with `.port` on every connect / disconnect
//   sysexEnabled            false
// and ports with id, name, manufacturer, version, type, state ('connected'|'disconnected'), connection, onstatechange,
// open() / close(); inputs: onmidimessage / addEventListener('midimessage') with {data: Uint8Array, timeStamp} in
// performance.now() time; outputs: send(data, timestamp) and clear().
//
// Wire (native core midi_service.cpp is the reference):
//   - `midi listen {ids}` with exactly the inputs that have a message handler (midi.js attaches the port(s) its
//     'first' / 'all' / 'device' policy chose, and detaches on a hot-plug or select()): one message per microtask,
//     only when the set changed. The first one (`ids: []` or the set at that moment) is a request whose reply
//     `{ports}` is the port snapshot: the shell publishes its ports before the page exists, so the first `ports`
//     event is gone by the time this runs. Why not "listen to all and filter here" (LANE NMA): every unselected
//     source would cross the WebView bridge, CoreMIDI would connect the virtual ports midi.js deliberately ignores,
//     and the v1.1 direct path (`midi route`) plays whatever the core forwards, so the core's listen set must be
//     midi.js's selection.
//   - `{ev:'midi', type:'ports', ports:[{id, name, manufacturer, state, kind}]}`: the present ports. A known port
//     missing from the list is 'disconnected' (it stays in the map, as Chrome keeps it; midi.js filters on state).
//   - `{ev:'midi', type:'msg', port, data, ts, handled}`: one complete channel message; `ts` is engine seconds,
//     mapped to page ms through the engine clock (the last tick's {t, perf}, engine-bridge/clock.js).
//   - output.send(data, ts) → `midi send {port, data, when?}` (`when` = ts mapped to engine seconds when ahead).
// No DOM beyond EventTarget / Event; runs in Node tests.

/** A mapped timestamp older than this is a stale clock (engine asleep, no tick yet): the message gets now(). */
const STALE_TS_MS = 1000;

const isByte = (b) => Number.isInteger(b) && b >= 0 && b <= 255;

function domError(name, message) {
  if (typeof DOMException === 'function') return new DOMException(message, name);
  const e = new Error(message);
  e.name = name;
  return e;
}

/** An Event carrying extra read-only fields (Event.timeStamp is a prototype getter: an own property shadows it). */
function makeEvent(type, fields) {
  const e = new Event(type);
  for (const [k, v] of Object.entries(fields)) Object.defineProperty(e, k, { value: v, enumerable: true });
  return e;
}

class NativeMidiPort extends EventTarget {
  /**
   * @param {NativeMidiAccess} access
   * @param {{id:string, name?:string, manufacturer?:string, state?:string, kind?:string}} p
   */
  constructor(access, p) {
    super();
    this._access = access;
    this.id = String(p.id);
    this.type = p.kind === 'output' ? 'output' : 'input';
    this.name = '';
    this.manufacturer = '';
    this.version = '';
    this.state = 'disconnected';
    this._open = false; // open() was called
    this._onstate = null;
    this._update(p);
  }

  _update(p) {
    this.name = typeof p.name === 'string' ? p.name : '';
    this.manufacturer = typeof p.manufacturer === 'string' ? p.manufacturer : '';
  }

  get connection() {
    if (this.state === 'disconnected') return this._wanted() ? 'pending' : 'closed';
    return this._wanted() ? 'open' : 'closed';
  }

  _wanted() {
    return this._open;
  }

  get onstatechange() {
    return this._onstate;
  }

  set onstatechange(fn) {
    this._onstate = typeof fn === 'function' ? fn : null;
  }

  _fireState() {
    const ev = makeEvent('statechange', { port: this });
    this.dispatchEvent(ev);
    if (this._onstate) this._onstate.call(this, ev);
  }

  /** @returns {Promise<NativeMidiPort>} */
  open() {
    if (!this._open) {
      this._open = true;
      this._access._listenChanged();
    }
    return Promise.resolve(this);
  }

  /** @returns {Promise<NativeMidiPort>} */
  close() {
    if (this._open) {
      this._open = false;
      this._access._listenChanged();
    }
    return Promise.resolve(this);
  }
}

class NativeMidiInput extends NativeMidiPort {
  constructor(access, p) {
    super(access, p);
    this._onmsg = null;
    this._msgFns = new Set(); // 'midimessage' listeners (a second add of the same one is a no-op, as in the DOM)
  }

  _wanted() {
    return this._open || !!this._onmsg || this._msgFns.size > 0;
  }

  get onmidimessage() {
    return this._onmsg;
  }

  /** Setting a handler opens the port (Web MIDI); clearing it is how midi.js detaches, so it closes it here. */
  set onmidimessage(fn) {
    const next = typeof fn === 'function' ? fn : null;
    if (next === this._onmsg) return;
    this._onmsg = next;
    this._access._listenChanged();
  }

  addEventListener(type, fn, opts) {
    super.addEventListener(type, fn, opts);
    if (type === 'midimessage' && fn && !this._msgFns.has(fn)) {
      this._msgFns.add(fn);
      this._access._listenChanged();
    }
  }

  removeEventListener(type, fn, opts) {
    super.removeEventListener(type, fn, opts);
    if (type === 'midimessage' && this._msgFns.delete(fn)) this._access._listenChanged();
  }

  _deliver(data, timeStamp, handled) {
    const ev = makeEvent('midimessage', { data, timeStamp, handled: !!handled });
    if (this._msgFns.size > 0) this.dispatchEvent(ev);
    if (this._onmsg) this._onmsg.call(this, ev);
  }
}

class NativeMidiOutput extends NativeMidiPort {
  /**
   * Web MIDI send: bytes now, or at `timestamp` (performance.now() ms). Throws like Web MIDI: TypeError for bytes
   * that are not 0..255 (or SysEx, which needs `sysex: true`), InvalidStateError on a disconnected port.
   * @param {ArrayLike<number>} data
   * @param {number} [timestamp]
   */
  send(data, timestamp) {
    const bytes = Array.from(data || [], Number);
    if (!bytes.length || !bytes.every(isByte)) throw new TypeError('MIDIOutput.send: invalid MIDI message');
    if (bytes.includes(0xf0)) throw domError('InvalidAccessError', 'MIDIOutput.send: SysEx needs sysex access');
    if (this.state === 'disconnected') throw domError('InvalidStateError', 'MIDIOutput.send: port is disconnected');
    this._access._sendOut(this.id, bytes, timestamp);
  }

  clear() {
    /* nothing is queued on this side: native schedules each send at its host time */
  }
}

export class NativeMidiAccess extends EventTarget {
  /**
   * @param {object} o
   * @param {object} o.engine BridgeEngine: 'midi' events, `_req(op, args)` / `_send(op, args)`, `_clock` ({t, perf})
   * @param {() => number} [o.now] page clock, ms (default: the engine's)
   * @param {(cb:Function) => void} [o.defer] schedules the listen flush (default queueMicrotask)
   */
  constructor(o = {}) {
    super();
    this.engine = o.engine;
    this._now = o.now || (this.engine && this.engine._now) || (() => performance.now());
    this._defer = o.defer || ((cb) => queueMicrotask(cb));
    /** @type {Map<string, NativeMidiInput>} */
    this.inputs = new Map();
    /** @type {Map<string, NativeMidiOutput>} */
    this.outputs = new Map();
    this.sysexEnabled = false;
    this._onstate = null;
    this._ready = null; // the first listen's promise (requestMIDIAccess)
    this._sentIds = null; // the ids of the last `midi listen` sent (sorted, joined)
    this._flushQueued = false;
    this._portsSeq = 0; // `ports` events seen: an older reply snapshot never overwrites a newer event
    this.stats = { messages: 0, dropped: 0, listens: 0, sends: 0, portReports: 0 };
    this._onMidi = (e) => this._onEvent((e && e.detail) || {});
    if (this.engine && typeof this.engine.addEventListener === 'function') {
      this.engine.addEventListener('midi', this._onMidi);
    }
  }

  get onstatechange() {
    return this._onstate;
  }

  set onstatechange(fn) {
    this._onstate = typeof fn === 'function' ? fn : null;
  }

  /**
   * The first `midi listen` (a request): its reply is the port snapshot. Resolves with this access; rejects with
   * the bridge's error (midi.js reports 'failed'). Idempotent.
   * @returns {Promise<NativeMidiAccess>}
   */
  start() {
    if (this._ready) return this._ready;
    const ids = this._wantIds();
    this._sentIds = ids.join('\n');
    const seq = this._portsSeq;
    this.stats.listens += 1;
    this._ready = Promise.resolve()
      .then(() => this.engine._req('midi', { action: 'listen', ids }))
      .then((r) => {
        if (this._portsSeq === seq && r && Array.isArray(r.ports)) this._applyPorts(r.ports);
        return this;
      });
    this._ready.catch(() => {
      this._ready = null; // a later requestMIDIAccess() may try again
      this._sentIds = null;
    });
    return this._ready;
  }

  /** Stop listening to every port and detach from the engine. */
  dispose() {
    if (this.engine && typeof this.engine.removeEventListener === 'function') {
      this.engine.removeEventListener('midi', this._onMidi);
    }
  }

  // ------------------------------------------------------------------------------------------- native → JS
  _onEvent(m) {
    if (m.type === 'ports' && Array.isArray(m.ports)) {
      this._portsSeq += 1;
      this._applyPorts(m.ports);
    } else if (m.type === 'msg') this._onMsg(m);
  }

  /** Apply a port report: new ports appear, known ones absent from it go 'disconnected'; each change is announced. */
  _applyPorts(list) {
    this.stats.portReports += 1;
    const seen = new Set();
    const changed = [];
    for (const p of list) {
      if (!p || typeof p.id !== 'string' || !p.id) continue;
      const kind = p.kind === 'output' ? 'output' : 'input';
      const map = kind === 'output' ? this.outputs : this.inputs;
      seen.add(`${kind}:${p.id}`);
      let port = map.get(p.id);
      if (!port) {
        port = kind === 'output' ? new NativeMidiOutput(this, p) : new NativeMidiInput(this, p);
        map.set(port.id, port);
      } else port._update(p);
      const state = p.state === 'disconnected' ? 'disconnected' : 'connected';
      if (port.state !== state) {
        port.state = state;
        changed.push(port);
      }
    }
    for (const [kind, map] of [['input', this.inputs], ['output', this.outputs]]) {
      for (const port of map.values()) {
        if (!seen.has(`${kind}:${port.id}`) && port.state !== 'disconnected') {
          port.state = 'disconnected';
          changed.push(port);
        }
      }
    }
    for (const port of changed) {
      port._fireState();
      const ev = makeEvent('statechange', { port });
      this.dispatchEvent(ev);
      if (this._onstate) this._onstate.call(this, ev);
    }
  }

  _onMsg(m) {
    const port = this.inputs.get(String(m.port));
    if (!port || !port._wanted() || !Array.isArray(m.data) || !m.data.length || !m.data.every(isByte)) {
      this.stats.dropped += 1; // a message in flight while the listen set changed, or a malformed one
      return;
    }
    this.stats.messages += 1;
    port._deliver(Uint8Array.from(m.data), this._perfOf(m.ts), m.handled);
  }

  /** Engine seconds → page ms through the last tick ({t, perf}); stale or missing → now. Never in the future. */
  _perfOf(ts) {
    const now = this._now();
    const c = this.engine && this.engine._clock;
    if (!c || c.t === null || c.t === undefined || !Number.isFinite(ts)) return now;
    const p = c.perf + (ts - c.t) * 1000;
    if (!Number.isFinite(p) || p < now - STALE_TS_MS) return now;
    return Math.min(p, now);
  }

  /** Page ms → engine seconds, or undefined (= now) when the time is not ahead or there is no clock yet. */
  _engineOf(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= this._now()) return undefined;
    const c = this.engine && this.engine._clock;
    if (!c || c.t === null || c.t === undefined) return undefined;
    return c.t + (timestamp - c.perf) / 1000;
  }

  // ------------------------------------------------------------------------------------------- JS → native
  _wantIds() {
    return [...this.inputs.values()].filter((p) => p._wanted()).map((p) => p.id).sort();
  }

  /** A port's handler / open state changed: send the new listen set once this turn's changes are done. */
  _listenChanged() {
    if (this._flushQueued) return;
    this._flushQueued = true;
    this._defer(() => {
      this._flushQueued = false;
      this._flushListen();
    });
  }

  _flushListen() {
    if (!this._ready) return; // before start(): the first listen carries the set
    const ids = this._wantIds();
    const key = ids.join('\n');
    if (key === this._sentIds) return;
    this._sentIds = key;
    this.stats.listens += 1;
    this.engine._send('midi', { action: 'listen', ids });
  }

  _sendOut(port, data, timestamp) {
    const when = this._engineOf(timestamp);
    this.stats.sends += 1;
    const args = { action: 'send', port, data };
    if (when !== undefined) args.when = when;
    this.engine._send('midi', args);
  }
}

/**
 * Give a page without Web MIDI a `navigator.requestMIDIAccess` backed by the bridge engine (WKWebView). Does nothing
 * when the navigator already has one (Chrome, Electron, the devhost in Chrome): their pages are untouched. A second
 * engine on the same page (tests) re-targets the polyfill installed here.
 * @param {object} engine BridgeEngine (the raw one, not boot-mock's counting proxy)
 * @param {{nav?:object}} [o]
 * @returns {NativeMidiAccess|null} the access object, or null when the navigator has its own Web MIDI
 */
export function installNativeMidi(engine, { nav = globalThis.navigator } = {}) {
  if (!nav || !engine) return null;
  const existing = nav.requestMIDIAccess;
  if (typeof existing === 'function' && !existing.nativeMidi) return null;
  if (existing && existing.nativeMidi) existing.nativeMidi.access.dispose();
  const access = new NativeMidiAccess({ engine });
  const requestMIDIAccess = (opts) => {
    if (opts && opts.sysex) {
      return Promise.reject(domError('NotSupportedError', 'SysEx is not available in this app'));
    }
    return access.start();
  };
  requestMIDIAccess.nativeMidi = { access };
  Object.defineProperty(nav, 'requestMIDIAccess', { value: requestMIDIAccess, configurable: true, writable: true });
  // skeptic NMA F1: the core outlives the page. After a reload (Settings › My Samples "Reload" is a plain
  // location.reload(); only a web-content crash makes the shell post a panic) it still sounds the notes and holds
  // the sustain of the previous page, whose key-ups and pedal lift now reach a controller that holds nothing, so
  // they are dropped and the notes / pedal stick. Release them before this page plays anything (right after
  // `hello`). On a first boot nothing sounds; the drone is left alone (allNotesOff's contract).
  engine.allNotesOff();
  return access;
}
