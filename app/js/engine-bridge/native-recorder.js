// NativeRecorder (G10, SHELL.md "Recording ownership"): the public surface of recorder.js's Recorder over the
// native `rec` op and `rec` events. Native owns the take end to end (tap, writer thread, 16-bit WAV in the shell's
// recordings folder, header refresh every second); JS only sends `rec {action:'start'|'stop'}` (a `filename` only
// when the caller passes one, never a `dir`) and turns `rec` events into the Recorder's events:
//   'state' {state:'idle'|'starting'|'recording'|'stopping'|'unavailable', sink?, filename?, path?, result?, reason?}
//   'level' {peakL, peakR, peak}      (native sends them at ~10 Hz while recording)
//   'warn'  {message}
// The sink is always 'native'; the controller's `{sink:'opfs'}` (non-Electron) is ignored. A take that native ends on
// its own (sample-rate change, write error) goes idle with its result and a warning, like a capped memory take.
// No imports: recorder.js can select it without pulling the bridge into the Web build (proposal in the T09 report).

/**
 * True for a BridgeEngine (also through boot-mock's spy proxy): the engine whose ctx has no AudioWorklet because
 * recording is native. Duck-typed on purpose (no import of bridge-engine.js here).
 */
export function isBridgeEngine(engine) {
  try {
    const link = engine && typeof engine._req === 'function' && engine._link;
    return !!(link && typeof link.request === 'function');
  } catch {
    return false;
  }
}

const baseName = (p) => (typeof p === 'string' ? p.split(/[\\/]/).pop() : null);

export class NativeRecorder extends EventTarget {
  /**
   * @param {object} o
   * @param {object} o.engine BridgeEngine (emits 'rec' events, `_req(op, args)` requests)
   * @param {Window} [o.win]
   * @param {(op:string, args:object)=>Promise<any>} [o.request] default engine._req
   * @param {() => number} [o.now] ms clock for `elapsed` when the engine has no ctx clock
   */
  constructor(o = {}) {
    super();
    this.engine = o.engine;
    this.win = o.win || globalThis;
    this.now = o.now || (() => Date.now());
    this._hasRequest = typeof o.request === 'function';
    this._request = o.request || ((op, args) => this.engine._req(op, args));
    this._state = 'idle';
    this._path = null;
    this._filename = null;
    this._ctxT0 = null;
    this._t0 = 0;
    this._lastSec = 0;
    this._stopEv = null;
    this._onRec = (e) => this._onRecEvent((e && e.detail) || {});
    this._onPageHide = () => {
      // the shell (and rig-devhost) also post `rec stop` for a dead page; this covers a plain navigation
      if (this.isRecording) this._send({ action: 'stop' });
    };
    if (this.engine && typeof this.engine.addEventListener === 'function') {
      this.engine.addEventListener('rec', this._onRec);
    }
  }

  get state() {
    return this._state;
  }

  get isRecording() {
    return this._state === 'recording';
  }

  /** Seconds recorded so far: engine time since the start reply (time pauses with the engine, like the take). */
  get elapsed() {
    if (this._state !== 'recording' && this._state !== 'stopping') return this._lastSec;
    const ctx = this.engine && this.engine.ctx;
    if (this._ctxT0 !== null && ctx && Number.isFinite(ctx.currentTime)) {
      return Math.max(0, ctx.currentTime - this._ctxT0);
    }
    return Math.max(0, (this.now() - this._t0) / 1000);
  }

  _setState(state, extra = {}) {
    this._state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: { state, ...extra } }));
  }

  _warn(message) {
    console.warn(`[recorder] ${message}`);
    this.dispatchEvent(new CustomEvent('warn', { detail: { message } }));
  }

  _unavailable(reason) {
    this._warn(`Recording unavailable: ${reason}`);
    this._setState('unavailable', { reason });
  }

  _send(args) {
    try {
      const link = this.engine && this.engine._link;
      if (link && typeof link.send === 'function') link.send('rec', args);
    } catch {
      /* the page is going away */
    }
  }

  /** Recording needs a native engine; nothing to load. @returns {Promise<boolean>} */
  async init() {
    if (!this._hasRequest && !isBridgeEngine(this.engine)) {
      this._unavailable('no native engine');
      return false;
    }
    if (this._state === 'unavailable') this._setState('idle');
    return true;
  }

  /**
   * @param {{filename?:string, sink?:string}} [o] `sink` is ignored (native writes the file)
   * @returns {Promise<{ok:boolean, sink?:string, filename?:string, path?:string, error?:string, code?:string}>}
   */
  async start(o = {}) {
    if (this._state === 'recording' || this._state === 'starting' || this._state === 'stopping') {
      return { ok: false, error: `busy (${this._state})` };
    }
    if (!(await this.init())) return { ok: false, error: 'Recording unavailable' };
    this._setState('starting');
    try {
      if (this.engine && typeof this.engine.start === 'function') await this.engine.start();
    } catch {
      /* the shim's start() also lists instruments; if audio itself is not running, `rec` answers not-started */
    }
    let r;
    try {
      r = await this._request('rec', { action: 'start', ...(o.filename ? { filename: String(o.filename) } : {}) });
    } catch (err) {
      const message = (err && err.message) || String(err);
      if (err && err.code === 'unsupported') {
        this._unavailable(message);
        return { ok: false, error: 'Recording unavailable', code: err.code };
      }
      this._setState('idle');
      return { ok: false, error: message, code: err && err.code };
    }
    const path = (r && r.path) || null;
    this._path = path;
    this._filename = baseName(path) || o.filename || null;
    const ctx = this.engine && this.engine.ctx;
    this._ctxT0 = ctx && Number.isFinite(ctx.currentTime) ? ctx.currentTime : null;
    this._t0 = this.now();
    this._stopEv = null;
    this.win.addEventListener?.('pagehide', this._onPageHide);
    this._setState('recording', { sink: 'native', filename: this._filename, path });
    return { ok: true, sink: 'native', filename: this._filename, path };
  }

  _onRecEvent(m) {
    if (m.level && this._state === 'recording') {
      const peakL = Number(m.level.peakL) || 0;
      const peakR = Number(m.level.peakR) || 0;
      this.dispatchEvent(new CustomEvent('level', { detail: { peakL, peakR, peak: Math.max(peakL, peakR) } }));
      return;
    }
    if (m.state !== 'stopped' && m.state !== 'error') return; // 'recording' without level: the start echo
    if (this._state === 'stopping' || this._state === 'starting') {
      this._stopEv = m; // ours (stop) or a start that failed late: the reply path builds the result
      return;
    }
    if (this._state !== 'recording') return;
    // native ended the take by itself (rate change, disk error): finish like Recorder's capped memory take
    this.win.removeEventListener?.('pagehide', this._onPageHide);
    const result = this._result(null, m);
    if (m.state === 'error') this._warn(`writing the recording failed: ${result.error}`);
    else if (m.message) {
      this._warn(`${m.message}. ${result.filename || 'The take'} is saved; press Record to continue.`);
    }
    this._lastSec = result.durationSec;
    this._setState('idle', { result });
  }

  _result(reply, ev) {
    const path = (reply && reply.path !== undefined ? reply.path : ev && ev.path) ?? this._path;
    const seconds = Number((reply && reply.seconds) ?? (ev && ev.seconds));
    const bytes = Number((reply && reply.bytes) ?? (ev && ev.bytes));
    const ctx = this.engine && this.engine.ctx;
    const result = {
      sink: 'native',
      filename: baseName(path) || this._filename,
      path: path || null,
      durationSec: Number.isFinite(seconds) ? seconds : this.elapsed,
      bytes: Number.isFinite(bytes) ? bytes : 0,
      dataBytes: Number.isFinite(bytes) ? Math.max(0, bytes - 44) : 0,
      sampleRate: ctx && ctx.sampleRate,
    };
    if (ev && ev.droppedFrames) result.droppedFrames = ev.droppedFrames;
    if (ev && ev.state === 'error') result.error = ev.message || 'write failed';
    return result;
  }

  /**
   * Stop and finalise (native closes the file).
   * @returns {Promise<{sink, filename, path, durationSec, bytes, dataBytes, sampleRate, error?, droppedFrames?}|null>}
   */
  async stop() {
    if (this._state !== 'recording') return null;
    this._setState('stopping');
    this.win.removeEventListener?.('pagehide', this._onPageHide);
    let reply = null;
    let error = null;
    try {
      reply = await this._request('rec', { action: 'stop' });
    } catch (err) {
      error = (err && err.message) || String(err);
    }
    const ev = this._stopEv;
    this._stopEv = null;
    const result = this._result(reply, ev);
    if (result.error) this._warn(`writing the recording failed: ${result.error}`);
    if (error) {
      result.error = result.error || error;
      this._warn(`could not finish the recording: ${error}`);
    }
    if (result.droppedFrames) {
      this._warn(`The recording skipped ${result.droppedFrames} frames (the disk could not keep up).`);
    }
    this._lastSec = result.durationSec;
    this._setState('idle', { result });
    return result;
  }

  /** Toggle helper for the REC button. */
  async toggle(o) {
    return this.isRecording ? this.stop() : this.start(o);
  }

  /** Stop listening to the engine (tests, hot reload). */
  dispose() {
    if (this.engine && typeof this.engine.removeEventListener === 'function') {
      this.engine.removeEventListener('rec', this._onRec);
    }
    this.win.removeEventListener?.('pagehide', this._onPageHide);
  }
}
