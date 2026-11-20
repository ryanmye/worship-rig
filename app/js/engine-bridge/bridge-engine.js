// BridgeEngine: the AudioEngine interface of native/contract/engine-api.json implemented over BRIDGE v1 messages
// (native/docs/ENGINE_CONTRACT.md section 6). Drop-in for `new AudioEngine(...)` behind controller.js: same members,
// same sync/async shape, same events (statechange, ready, loading, instruments, wheel, notes, chord, click, sleep,
// warn). Everything the contract lists as "answered in the JS shim" (6.6) is answered here without a round trip.
//
// Rules for this file: no Web Audio, no DOM (it runs in Node tests), every public member is in the contract
// (test/unit/engine-bridge/surface.test.mjs fails on a missing or an extra one), helpers are underscore-private.
import { BridgeLink, BridgeError, PROTOCOL } from './link.js';
import { EngineClock } from './clock.js';
import { webkitTransport, webkitAvailable } from './transports.js';
import { isValidPath, SLOT_COUNT } from '../shared/params.js';

/** Slots the native core takes (T00c, native DECISIONS D3: slots.0..15); the web PARAMS grammar has SLOT_COUNT. */
const NATIVE_SLOT_COUNT = 16;
import { readEq, eqResponseDb, bandFilter, cutFilters, rbjCoeffs, magDb } from '../shared/eq-math.js';
import { detectKeyFromName } from '../shared/keydetect.js';

export { BridgeError, PROTOCOL };

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const mod12 = (n) => ((Math.round(n) % 12) + 12) % 12;
const finite = (x) => (Number.isFinite(x) ? x : undefined);
const clampMidi = (n) => clamp(Math.round(Number(n) || 0), 0, 127);
const SLEEP_BLOCKERS_NO_AUDIO = Object.freeze(['no-audio']);
const WHEEL_SOURCES = ['mod', 'expr', 'vol', 'virtual'];
const METER_IDLE_MS = 2000; // a meter nobody reads for this long is unsubscribed (contract 6.6)
const METER_RATE_ACTIVE = 30;
const METER_RATE_IDLE = 4;
const PEAK_FRESH_MS = 80; // a tick peak is re-served to a second read within this long (reads run at 60 Hz)

const ZERO_STATS = Object.freeze({
  voices: 0, nodes: 0, retiring: 0, decodedMB: 0, pinnedMB: 0, referencedMB: 0, capMB: 0, sounding: 0, pedaled: 0,
  timers: 0, lowResource: false, slotLevelTaps: 0, reverbUnits: 0, reverbQuietWaiting: false, fxAsleep: [],
});

const DEFAULT_RUNTIME = Object.freeze({
  wheel: Object.freeze({ mod: 0, expr: 1, vol: 1 }), modOwner: 'hw', faded: false, swelling: false,
});

/** Analyser stand-in (contract 6.6): fed by the `tick` peaks and the optional base64 spectrum. */
class AnalyserFacade {
  constructor(engine, ch, ctx) {
    this._engine = engine;
    this._ch = ch;
    this.context = ctx;
    this.fftSize = 2048;
    this.frequencyBinCount = 1024;
    this.minDecibels = -100;
    this.maxDecibels = -30;
    this.smoothingTimeConstant = 0.8;
  }

  /** Writes the latest tick peak at index 0 and zeros elsewhere: enough for meter.js (it takes the max). */
  getFloatTimeDomainData(buf) {
    buf.fill(0);
    if (buf.length) buf[0] = this._engine._readPeak(this._ch);
  }

  getFloatFrequencyData(arr) {
    this._engine._readRta(this._ch, arr);
  }
}

/** AudioContext stand-in: the pieces controller/main/eq-keyboard/midi-clock read (contract 1.1 `ctx`). */
class ContextFacade extends EventTarget {
  constructor(engine) {
    super();
    this._engine = engine;
    this.audioWorklet = undefined; // the recorder worklet is native (`rec`); recorder.js then reports "unavailable"
  }

  get state() {
    return this._engine._st.state;
  }

  get currentTime() {
    return this._engine._clock.currentTime();
  }

  get sampleRate() {
    return this._engine._st.sampleRate;
  }

  get baseLatency() {
    return 0;
  }

  get outputLatency() {
    return this._engine._outputLatencySec();
  }

  getOutputTimestamp() {
    return this._engine._clock.outputTimestamp(this._engine._outputLatencySec());
  }

  /** resume() -> `audio start|wake` (contract 6.6). */
  resume() {
    return this._engine._resumeAudio();
  }

  suspend() {
    return Promise.resolve();
  }
}

/** engine.drone: mirrors of what was sent (cfg/key/files, contract 6.6) plus the three calls. */
class DroneFacade {
  constructor(engine) {
    this._e = engine;
    this.cfg = { mode: 'off', chordFollow: false, continueAcrossSongs: true, minorUsesRelativeMajorFile: true };
    this.key = null; // {pc, minor}
    this.files = new Map(); // 'pc|minor' -> {name, url}
  }

  setKey(pc, { minor = false, fade, when } = {}) {
    const p = mod12(pc);
    const m = !!minor;
    if (this.key && this.key.pc === p && this.key.minor === m) return true;
    this.key = { pc: p, minor: m };
    const key = { pc: p, minor: m };
    if (Number.isFinite(fade)) key.fade = fade;
    this._e._send('drone', { key, ...this._e._whenArg(when) });
    return true;
  }

  configure(d = {}, { when } = {}) {
    for (const k of ['chordFollow', 'continueAcrossSongs', 'minorUsesRelativeMajorFile']) {
      if (k in d) this.cfg[k] = !!d[k];
    }
    if ('mode' in d && ['off', 'synth', 'files'].includes(d.mode)) this.cfg.mode = d.mode;
    this._e._send('drone', { config: { ...d }, ...this._e._whenArg(when) });
  }

  attachFiles(list = []) {
    this.files.clear();
    let n = 0;
    const out = [];
    for (const f of list) {
      const k = detectKeyFromName(f.name || f.url || f.path || '');
      if (!k) continue;
      const id = `${k.pc}|${k.minor}`;
      if (this.files.has(id)) continue;
      this.files.set(id, { name: f.name, url: f.url });
      out.push({ name: f.name, path: f.path ?? f.url });
      n += 1;
    }
    this._e._send('drone', { files: out });
    return n;
  }
}

export class BridgeEngine extends EventTarget {
  /**
   * @param {object} [opts]
   * @param {{post:Function, onMessage:Function}} [opts.transport] default: the WKWebView transport
   * @param {'interactive'|number} [opts.latency]
   * @param {()=>number} [opts.now] page clock in ms (tests inject a fake)
   * @param {{setTimeout:Function, clearTimeout:Function}} [opts.timers]
   * @param {object} [opts.timeouts] per-op reply timeouts, ms (link.js DEFAULT_TIMEOUTS)
   * @param {string} [opts.app] reported in `hello`
   */
  constructor(opts = {}) {
    super();
    this._now = opts.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this._timers = opts.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) };
    this._latency = opts.latency ?? 'interactive';
    this._clock = new EngineClock(this._now);
    /** Engine/device state as native last reported it. ctx.state is 'running' at once (WEBKIT_AUDIT 6). */
    this._st = { state: 'running', sleep: 'awake', latencyMs: 0, sampleRate: 48000, deviceId: 'default', channels: 2 };
    /** Count of `state` events seen; an `audio` reply's snapshot never overwrites a newer event (_audioReq). */
    this._stSeq = 0;
    this._ctx = new ContextFacade(this);
    this.drone = new DroneFacade(this);
    this._started = false;
    this._startP = null;
    this._unavailable = null;
    this._epoch = 0;
    this._tokens = new Map(); // token -> {patch, epoch, committed, superseded}
    this._latestToken = 0;
    this._patch = null; // mirror of the committed patch (getEqResponse, getSlotPlayRange)
    this._transpose = 0;
    this._tempo = null;
    this._lowResource = false;
    /** 2.0 Sound (native DECISIONS D1, D2, D4): the buffer to ask for at the next start/restart (null = host's). */
    this._bufferFrames = null;
    /** What native last reported (replies, `state` events); null = not reported yet. Emitted as `audioconfig`. */
    this._audioCfg = { polyphony: null, bufferFrames: null, bufferRequested: null, voiceLimit: null,
      voiceLimitEffective: null };
    this._instrumentsAll = [];
    this._instruments = [];
    this._samplers = new Map();
    this._loaded = new Map(); // pseudo sample url -> true
    this._failed = new Set();
    this._warned = new Set();
    this._pendingSets = [];
    this._setScheduled = false;
    this._tick = null;
    this._blockers = SLEEP_BLOCKERS_NO_AUDIO;
    this._pedal = false;
    this._held = 0;
    this._runtime = DEFAULT_RUNTIME;
    this._stats = ZERO_STATS;
    this._click = null;
    this._clockSink = null;
    this._peaks = [this._newPeak(), this._newPeak()];
    this._rta = { b64: null, bytes: null, readAt: 0 };
    this._slots = [null, null, null, null]; // latest tick [peak, rms] per slot
    this._slotRead = [0, 0, 0, 0]; // page time of the last slotLevel(i) read, 0 = unsubscribed
    this._rtaOn = false;
    this._meterRate = null;
    this._sweepTimer = null;
    this._analysers = [new AnalyserFacade(this, 0, this._ctx), new AnalyserFacade(this, 1, this._ctx)];
    this._tap = { context: this._ctx, connect: (n) => n, disconnect: () => {} };
    this._cacheFacade = {
      entries: new Map(), failed: this._failed, has: (u) => this._loaded.has(u),
    };
    this._registryFacade = { samplers: this._samplers, list: () => this._instrumentsAll };
    this._link = new BridgeLink(opts.transport || webkitTransport(), {
      timers: this._timers,
      timeouts: opts.timeouts,
      onEvent: (m) => this._onEvent(m),
      onProtocolError: (i) => this._warn(`engine bridge protocol problem: ${i.reason}`),
    });
    this._hello = this._link.request('hello', { protocol: PROTOCOL, app: opts.app || 'worship-rig-ui', caps: [] })
      .then((r) => {
        this._info = r || null;
        if (!r || r.protocol !== PROTOCOL) {
          throw new BridgeError('protocol', `native speaks protocol ${r && r.protocol}`);
        }
        if (Number.isFinite(r.sampleRate)) this._st.sampleRate = r.sampleRate;
        return r;
      })
      .catch((err) => {
        this._unavailable = err;
        this._warn(`engine.hello failed: ${err && err.message}`);
        return null;
      });
  }

  // ----------------------------------------------------------------------------------------------- plumbing
  /** True when a WKWebView bridge exists on this page (main.js uses it to choose which engine to build). */
  static _available(win = globalThis) {
    return webkitAvailable(win);
  }

  _flushSets() {
    this._setScheduled = false;
    const list = this._pendingSets;
    if (!list.length) return;
    this._pendingSets = [];
    if (list.length === 1) {
      const [path, value, glide] = list[0];
      this._link.send('set', glide ? { path, value, glide } : { path, value });
    } else this._link.send('set', { batch: list });
  }

  _send(op, args = {}) {
    this._flushSets();
    return this._link.send(op, args);
  }

  _req(op, args = {}, o) {
    this._flushSets();
    return this._link.request(op, args, o);
  }

  _whenArg(when) {
    return Number.isFinite(when) ? { when } : {};
  }

  _warn(message, once = true) {
    if (once) {
      if (this._warned.has(message)) return;
      this._warned.add(message);
    }
    this._emit('warn', { message });
  }

  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  _outputLatencySec() {
    return Math.max(0, (this._st.latencyMs || 0) / 1000);
  }

  /**
   * An `audio` request whose reply carries a state snapshot. The snapshot is applied only when no `state` event
   * arrived after the request went out: the core emits a `state` event for every change, and an event delivered in
   * the same batch/read as the reply (`[re:2 {state:'suspended'}]` then `{ev:'state', state:'running'}`) is
   * dispatched before this continuation runs, so applying the older snapshot then would undo it (T09 review: ctx
   * stuck at 'suspended' with the device running, seen against rig-devhost under Node's WebSocket).
   */
  async _audioReq(args) {
    const seq = this._stSeq;
    const r = await this._req('audio', args);
    if (this._stSeq === seq) this._applyState(r);
    this._takeAudioCfg(r); // the granted buffer is the answer to this request, whatever events came first
    return r;
  }

  /**
   * 2.0 Sound (D1, D2, D4): polyphony / bufferFrames / voiceLimit / voiceLimitEffective from a reply or a `state`
   * event. Fields the message lacks keep their last value; a change is emitted as `audioconfig` (Settings shows the
   * granted buffer and the Auto voice limit through the controller).
   */
  _takeAudioCfg(s) {
    if (!s || typeof s !== 'object') return;
    const c = this._audioCfg;
    const next = { ...c };
    if (Number.isFinite(s.polyphony) && s.polyphony > 0) next.polyphony = s.polyphony;
    if (Number.isFinite(s.bufferFrames) && s.bufferFrames > 0) next.bufferFrames = s.bufferFrames;
    if (s.voiceLimit === 0 || s.voiceLimit === 'off') next.voiceLimit = 'off';
    else if (s.voiceLimit === 'auto' || (Number.isFinite(s.voiceLimit) && s.voiceLimit > 0)) {
      next.voiceLimit = s.voiceLimit;
    }
    if (Number.isFinite(s.voiceLimitEffective) && s.voiceLimitEffective >= 0) {
      next.voiceLimitEffective = s.voiceLimitEffective;
    } else if (next.voiceLimit !== c.voiceLimit) {
      // a new mode without the core's number: a fixed limit is its own number, Auto's is unknown until reported
      next.voiceLimitEffective = next.voiceLimit === 'off' ? 0 : next.voiceLimit === 'auto' ? null : next.voiceLimit;
    }
    next.bufferRequested = this._bufferFrames;
    if (Object.keys(next).every((k) => next[k] === c[k])) return;
    this._audioCfg = next;
    this._emit('audioconfig', { ...next });
  }

  /** A `config` request for one 2.0 Sound field; resolves with the audio settings after the reply (never rejects). */
  async _configReq(args, assumed) {
    try {
      await this._ready();
      const r = await this._req('config', args);
      // a core that answers with an empty reply took the value as sent (contract: the reply echoes what it knows)
      this._takeAudioCfg({ ...assumed, ...(r && typeof r === 'object' ? r : {}) });
    } catch (err) {
      this._warn(`engine.config ${Object.keys(args).join(',')} failed: ${err && err.message}`);
    }
    return { ...this._audioCfg };
  }

  _applyState(s) {
    if (!s || typeof s !== 'object') return false;
    let changed = false;
    for (const k of ['state', 'sleep', 'latencyMs', 'sampleRate', 'deviceId', 'channels']) {
      if (s[k] !== undefined && s[k] !== this._st[k]) {
        this._st[k] = s[k];
        if (k !== 'sleep') changed = true; // sleep has its own event
      }
    }
    return changed;
  }

  async _ready() {
    await this._hello;
    if (this._unavailable) throw this._unavailable;
  }

  _resumeAudio() {
    if (this._st.sleep !== 'awake') return this.wake().then(() => undefined);
    return this.start().then(() => undefined);
  }

  // ----------------------------------------------------------------------------------------------- native -> JS
  _onEvent(m) {
    switch (m.ev) {
      case 'state': return this._onState(m);
      case 'tick': return this._onTick(m);
      case 'notes': {
        this._emit('notes', { held: new Set(m.held || []) });
        if ('chord' in m) this._emit('chord', { chord: m.chord || null });
        return undefined;
      }
      case 'wheel': {
        const d = { source: m.source, value: m.value };
        if (m.hardware !== undefined) d.hardware = m.hardware;
        if (m.pickup !== undefined) d.pickup = m.pickup;
        return this._emit('wheel', d);
      }
      case 'load': return this._onLoad(m);
      case 'click': {
        const { v, ev, ...state } = m;
        this._click = state;
        return this._emit('click', state);
      }
      case 'warn': return this._warn(String(m.message ?? ''));
      case 'midi': return this._emit('midi', m);
      case 'rec': return this._emit('rec', m);
      default: return undefined; // unknown events are ignored (contract 6.2)
    }
  }

  _onState(m) {
    this._stSeq += 1;
    const prevSleep = this._st.sleep;
    const changed = this._applyState(m);
    this._takeAudioCfg(m); // D2: the granted buffer after a restart / device change
    if (m.restarted) {
      this._epoch += 1; // an in-flight prepare token is dead (contract 1.1 restart)
      this._tokens.clear();
    }
    if (changed || m.restarted) {
      const d = { state: this._st.state, latencyMs: this._st.latencyMs };
      if (m.restarted) d.restarted = true;
      this._emit('statechange', d);
      this._ctx.dispatchEvent(new Event('statechange'));
    }
    if (this._st.sleep !== prevSleep || m.wakeMs !== undefined) {
      const s = this._st.sleep;
      if (s === 'sleeping' || s === 'asleep' || s === 'awake') {
        const d = { state: s };
        if (m.wakeMs !== undefined) d.wakeMs = m.wakeMs;
        if (m.queued !== undefined) d.queued = m.queued;
        this._emit('sleep', d);
      }
    }
    return undefined;
  }

  _onTick(m) {
    this._clock.tick(m.t);
    this._tick = m;
    const now = this._now();
    if (Array.isArray(m.out)) {
      for (let ch = 0; ch < 2; ch++) {
        const v = Number(m.out[ch]) || 0;
        const p = this._peaks[ch];
        p.pending = Math.max(p.pending, v);
        p.last = v;
        p.perf = now;
        p.unread = true;
      }
    }
    if (Array.isArray(m.slots)) this._slots = m.slots;
    if (typeof m.rta === 'string') {
      this._rta.b64 = m.rta;
      this._rta.bytes = null;
    }
    if (Array.isArray(m.blockers)) this._blockers = m.blockers;
    if (m.pedal !== undefined) this._pedal = !!m.pedal;
    if (m.held !== undefined) this._held = m.held;
    if (m.runtime) this._runtime = { ...DEFAULT_RUNTIME, ...m.runtime };
    if (m.stats) this._stats = m.stats;
    if (Number.isFinite(m.hostLatency)) this._st.latencyMs = m.hostLatency * 1000;
  }

  _onLoad(m) {
    switch (m.phase) {
      case 'slot': return this._emit('loading', { slot: m.slot, progress: m.progress, token: m.token });
      case 'start': return this._emit('ready', { phase: 'start' });
      case 'preload':
        return this._emit('ready', {
          phase: 'preload', decodedMB: m.decodedMB, pinnedMB: m.pinnedMB, deferred: m.deferred,
        });
      case 'instruments':
        return this._refreshInstruments().then(() => this._emit('instruments', { count: this._instruments.length }),
          (err) => this._warn(`engine.listInstruments failed: ${err && err.message}`));
      case 'samples': {
        for (const [id, ok] of Object.entries(m.loaded || {})) {
          const url = this._sampleUrl(id);
          if (ok) {
            this._loaded.set(url, true);
            this._cacheFacade.entries.set(url, true);
            this._failed.delete(url);
          } else {
            this._loaded.delete(url);
            this._cacheFacade.entries.delete(url);
          }
        }
        return undefined;
      }
      default: return undefined;
    }
  }

  _sampleUrl(id) {
    return `native-sample:${id}`;
  }

  async _refreshInstruments(reload = false) {
    const list = await this._req('get', reload ? { what: 'instruments', reload: true } : { what: 'instruments' });
    this._setInstruments(Array.isArray(list) ? list : []);
    return this._instruments;
  }

  _setInstruments(all) {
    this._instrumentsAll = all;
    this._instruments = all.filter((e) => !e.hidden);
    this._samplers.clear();
    for (const e of all) {
      if (!e.ref || e.ref.type !== 'sampler') continue;
      const midi = Array.isArray(e.range) ? e.range[0] : 0;
      this._samplers.set(e.ref.id, { id: e.ref.id, layers: [{ samples: [{ url: this._sampleUrl(e.ref.id), midi }] }] });
    }
  }

  // ----------------------------------------------------------------------------------------------- lifecycle
  get latency() {
    return this._latency;
  }

  set latency(v) {
    this._latency = v;
  }

  get latencyMs() {
    return this._st.latencyMs;
  }

  get ctx() {
    return this._ctx;
  }

  get sleepState() {
    return this._st.sleep;
  }

  start() {
    if (!this._startP) {
      this._clock.startRequested();
      this._startP = this._doStart();
      this._startP.catch(() => {
        this._startP = null; // a failed start can be retried
      });
    }
    return this._startP;
  }

  async _doStart() {
    await this._ready();
    await this._audioReq({ action: 'start', latency: this._latency, ...this._bufferArg() });
    this._started = true;
    await this._refreshInstruments();
    return this;
  }

  async restart({ latency, sinkId } = {}) {
    await this._ready();
    if (latency !== undefined) this._latency = latency;
    this._epoch += 1;
    this._tokens.clear();
    const args = { action: 'restart', latency: this._latency, ...this._bufferArg() };
    if (typeof sinkId === 'string') args.deviceId = sinkId;
    this._clock.startRequested();
    await this._audioReq(args);
    this._started = true;
    return this;
  }

  async setSinkId(id) {
    await this._ready();
    await this._audioReq({ action: 'output', deviceId: id === 'default' ? '' : String(id ?? '') });
    return true;
  }

  async sleep({ ramp = 0.15 } = {}) {
    if (!this._started || this._st.sleep !== 'awake') return false;
    const r = await this._req('audio', { action: 'sleep', ramp });
    return !!(r && r.done);
  }

  async wake({ ramp } = {}) {
    if (!this._started) return false;
    const r = await this._req('audio', { action: 'wake', ...(Number.isFinite(ramp) ? { ramp } : {}) });
    return !!(r && r.done);
  }

  sleepBlockers() {
    return Array.from(this._blockers);
  }

  setLowResource(on) {
    const v = !!on;
    this._lowResource = v;
    this._send('config', { lowResource: v });
    if (v) this._slots = [null, null, null, null];
    return v;
  }

  /** `audio` start/restart: the requested buffer (D2), only once something asked for one (contract: 0 = host's). */
  _bufferArg() {
    return this._bufferFrames ? { bufferFrames: this._bufferFrames } : {};
  }

  /**
   * 2.0 (native DECISIONS D1): voices per sound, 32 | 64 | 128. Sends `config {polyphony}`.
   * @param {number} n
   * @returns {Promise<object>} the audio settings native reported (see `audioconfig`); never rejects
   */
  setPolyphony(n) {
    const v = Number(n);
    if (![32, 64, 128].includes(v)) {
      this._warn(`engine.setPolyphony: ${n} is not 32, 64 or 128`);
      return Promise.resolve({ ...this._audioCfg });
    }
    return this._configReq({ polyphony: v }, { polyphony: v });
  }

  /**
   * 2.0 (D4): total live voices across all sounds: 'auto' | 128 | 256 | 512 | 'off' (also 0). Sends
   * `config {voiceLimit}` with 'off' as 0; the reply's voiceLimitEffective is the number Auto chose (0 = off).
   * @param {'auto'|'off'|number} v
   * @returns {Promise<object>} the audio settings native reported; never rejects
   */
  setVoiceLimit(v) {
    const n = Number(v);
    const wire = v === 'off' || v === 0 ? 0 : v === 'auto' ? 'auto' : [128, 256, 512].includes(n) ? n : null;
    if (wire === null) {
      this._warn(`engine.setVoiceLimit: ${v} is not auto, 128, 256, 512 or off`);
      return Promise.resolve({ ...this._audioCfg });
    }
    return this._configReq({ voiceLimit: wire }, { voiceLimit: wire });
  }

  /**
   * 2.0 (D2): the audio buffer to ask the device for, 64 | 128 | 256 | 512 frames. It travels as `audio {bufferFrames}`
   * on the next start/restart; with {restart:true} (the default) a running engine restarts now. The controller passes
   * {restart:false} and restarts through restartAudio(), which re-applies the song afterwards.
   * @param {number} n
   * @param {{restart?:boolean}} [opts]
   * @returns {Promise<object>} the audio settings after the restart (bufferFrames = what the device granted)
   */
  async setBufferFrames(n, { restart = true } = {}) {
    const v = Number(n);
    if (![64, 128, 256, 512].includes(v)) {
      this._warn(`engine.setBufferFrames: ${n} is not 64, 128, 256 or 512`);
      return { ...this._audioCfg };
    }
    this._bufferFrames = v;
    this._takeAudioCfg({}); // bufferRequested
    if (restart && this._started) await this.restart();
    return { ...this._audioCfg };
  }

  // ----------------------------------------------------------------------------------------------- songs, memory
  async prepare(patch) {
    await this.start();
    const epoch = this._epoch;
    const r = await this._req('prepare', { patch });
    const token = r && r.token;
    if (!Number.isInteger(token)) throw new BridgeError('internal', 'prepare reply without a token', { op: 'prepare' });
    for (const [t, e] of this._tokens) if (t < token) e.superseded = true;
    this._tokens.set(token, { patch, epoch, committed: false, superseded: epoch !== this._epoch });
    this._latestToken = Math.max(this._latestToken, token);
    return token;
  }

  /** Synchronous like the JS engine: the shim knows the latest token and whether it was committed (6.6). */
  commit(token, { when } = {}) {
    const e = this._tokens.get(token);
    const ok = !!e && !e.committed && !e.superseded && e.epoch === this._epoch && token === this._latestToken;
    if (!ok) return false;
    e.committed = true;
    this._applyPatchMirror(e.patch);
    for (const t of this._tokens.keys()) if (t <= token) this._tokens.delete(t);
    this._tokens.set(token, e);
    this._req('commit', { token, ...this._whenArg(when) }).then(
      (r) => {
        if (!r || r.committed === false) this._warn('engine.commit failed: native did not accept the token');
      },
      (err) => this._warn(`engine.commit failed: ${err && err.message}`),
    );
    return true;
  }

  async preload(patches, { pin = 'auto' } = {}) {
    await this.start();
    await this._req('cache', { action: 'preload', patches: patches || [], pin });
    return true;
  }

  async estimatePreloadMB(patches) {
    await this.start();
    const r = await this._req('cache', { action: 'estimate', patches: patches || [] });
    return r;
  }

  retainReverb(patches) {
    if (!this._started) return false;
    this._send('cache', { action: 'retainReverb', patches: patches || [] });
    return true;
  }

  async reloadManifests() {
    await this.start();
    return this._refreshInstruments(true);
  }

  listInstruments() {
    return this._instruments;
  }

  get cache() {
    return this._cacheFacade;
  }

  get registry() {
    return this._registryFacade;
  }

  _debugStats() {
    return { ...ZERO_STATS, ...this._stats, lowResource: this._lowResource };
  }

  // ----------------------------------------------------------------------------------------------- parameters
  setParam(path, value, { when, glide = 0 } = {}) {
    if (!this._validPath(path)) {
      this._warn(`Unknown parameter "${path}"`);
      return false;
    }
    const m = /^slots\.(\d+)\./.exec(path);
    if (m && this._patch && !this._patch.slots[Number(m[1])]) return false; // empty slot: nothing to set
    this._mirrorSet(path, value);
    const v = value === undefined ? null : value;
    const g = Number.isFinite(glide) && glide > 0 ? glide : 0;
    if (Number.isFinite(when)) {
      this._flushSets();
      this._link.send('set', { path, value: v, ...(g ? { glide: g } : {}), when });
      return true;
    }
    this._pendingSets.push(g ? [path, v, g] : [path, v]);
    if (!this._setScheduled) {
      this._setScheduled = true;
      queueMicrotask(() => this._flushSets());
    }
    return true;
  }

  setTranspose(semis) {
    this._transpose = clamp(Math.round(Number(semis) || 0), -48, 48);
    this._send('song', { transpose: this._transpose });
  }

  setRouting(r, { when } = {}) {
    this._send('song', { routing: r || {}, ...this._whenArg(when) });
  }

  setTempo(bpm) {
    const t = Number(bpm);
    this._tempo = t > 0 ? t : null;
    this._send('song', { tempo: this._tempo });
  }

  setTimeSig(sig, { newBar } = {}) {
    this._send('song', { timeSig: String(sig), ...(newBar !== undefined ? { newBar: !!newBar } : {}) });
  }

  setKeyContext(pc, minor) {
    this._send('song', { key: { pc: mod12(pc), minor: !!minor } });
  }

  setMono(on) {
    this._send('config', { mono: !!on });
  }

  eqAudition(slot, mode = 'on', { when } = {}) {
    const i = Number(slot);
    if (!Number.isInteger(i) || i < 0 || i >= this._slotLimit()) return false;
    const eqAudition = { slot: i, mode: mode === 'bypass' ? 'bypass' : 'on' };
    this._send('config', { eqAudition, ...this._whenArg(when) });
    return true;
  }

  getEqResponse(slot, freqs, { perBand = false } = {}) {
    const cfg = this._patch && this._patch.slots[slot];
    if (!cfg || !freqs) return null;
    const fs = this._st.sampleRate;
    const nyq = fs / 2;
    const f = Array.from(freqs, (x) => Math.min(x, nyq));
    const eq = cfg.eq || {};
    const total = Float32Array.from(eqResponseDb(eq, f, fs));
    if (!perBand) return total;
    const model = readEq(eq);
    const bands = {};
    const curve = (spec) => Float32Array.from(f, (hz) => (spec ? magDb(rbjCoeffs(spec, fs), hz, fs) : 0));
    for (const s of cutFilters(model)) bands[s.cut === 'low' ? 'lc' : 'hc'] = curve(s);
    for (const b of model.bands) bands[`b${b.k}`] = curve(bandFilter(b));
    return { total, bands };
  }

  getSlotPlayRange(slot) {
    const cfg = this._patch && this._patch.slots[slot];
    if (!cfg) return null;
    const octave = Number(cfg.octave) || 0;
    const trans = Number(cfg.transpose) || 0;
    const physLow = Number.isFinite(cfg.lowNote) ? cfg.lowNote : 0;
    const physHigh = Number.isFinite(cfg.highNote) ? cfg.highNote : 127;
    const shift = this._transpose + 12 * octave + trans;
    const lo = Math.max(0, physLow + shift);
    const hi = Math.min(127, physHigh + shift);
    let range = null;
    if (cfg.instrument && cfg.instrument.type === 'sampler') {
      const e = this._instrumentsAll.find((x) => x.ref && x.ref.type === 'sampler' && x.ref.id === cfg.instrument.id);
      if (e && Array.isArray(e.range)) range = [e.range[0], e.range[1]];
    }
    const out = { lowNote: null, highNote: null, sampledLow: null, sampledHigh: null, transpose: shift };
    Object.assign(out, { physLow, physHigh, instrumentRange: range });
    if (lo > hi) return out;
    out.lowNote = lo;
    out.highNote = hi;
    const sl = range ? Math.max(lo, range[0]) : lo;
    const sh = range ? Math.min(hi, range[1]) : hi;
    if (sl <= sh) {
      out.sampledLow = sl;
      out.sampledHigh = sh;
    }
    return out;
  }

  _applyPatchMirror(patch) {
    const p = JSON.parse(JSON.stringify(patch || {}));
    // T00c (D3): a song may carry up to NATIVE_SLOT_COUNT slots; the mirror keeps at least the web engine's 4
    const n = Math.min(NATIVE_SLOT_COUNT, Math.max(SLOT_COUNT, Array.isArray(p.slots) ? p.slots.length : 0));
    p.slots = Array.from({ length: n }, (_, i) => (p.slots && p.slots[i]) || null);
    this._patch = p;
  }

  /** Slot indices of the committed song: max(4, its slot entries) <= NATIVE_SLOT_COUNT (T00c, D3); 4 before one. */
  _slotLimit() {
    return this._patch ? this._patch.slots.length : SLOT_COUNT;
  }

  /**
   * The web PARAMS grammar (slots.0..3), plus slots.4..15 of the committed song (T00c, D3: the native core takes
   * 16 slots; the UI wave moves the grammar itself).
   * @param {string} path
   * @returns {boolean}
   */
  _validPath(path) {
    if (isValidPath(path)) return true;
    const m = /^slots\.(\d+)\.(.+)$/.exec(path);
    if (!m || String(Number(m[1])) !== m[1]) return false;
    const i = Number(m[1]);
    return i >= SLOT_COUNT && i < NATIVE_SLOT_COUNT && !!(this._patch && this._patch.slots[i]) &&
      isValidPath(`slots.0.${m[2]}`);
  }

  _mirrorSet(path, value) {
    if (!this._patch) return;
    const segs = path.split('.');
    let o;
    let rest;
    if (segs[0] === 'slots') {
      o = this._patch.slots[Number(segs[1])];
      rest = segs.slice(2);
    } else if (segs[0] === 'fx') {
      this._patch.fx = this._patch.fx || {};
      o = this._patch.fx[segs[1]] = this._patch.fx[segs[1]] || {};
      rest = segs.slice(2);
    } else if (segs[0] === 'master') {
      this._patch.fx = this._patch.fx || {};
      o = this._patch.fx.master = this._patch.fx.master || {};
      rest = segs.slice(1);
    } else return; // drone.*: not mirrored here
    if (!o) return;
    for (let i = 0; i < rest.length - 1; i++) {
      if (!o[rest[i]] || typeof o[rest[i]] !== 'object') o[rest[i]] = {};
      o = o[rest[i]];
    }
    o[rest[rest.length - 1]] = value;
  }

  // ----------------------------------------------------------------------------------------------- perform input
  noteOn(note, vel = 100, { when, touch } = {}) {
    if (!this._started) return false;
    if (!(Number(vel) > 0)) return this.noteOff(note, { when });
    this._send('play', {
      e: 'on', n: clampMidi(note), vel: clamp(Math.round(Number(vel)), 1, 127),
      ...(touch ? { touch } : {}), ...this._whenArg(when),
    });
    return true;
  }

  noteOff(note, { when } = {}) {
    if (!this._started) return false;
    this._send('play', { e: 'off', n: clampMidi(note), ...this._whenArg(when) });
    return true;
  }

  sustain(down, { when } = {}) {
    if (!this._started) return false;
    this._send('play', { e: 'pedal', down: !!down, ...this._whenArg(when) });
    return true;
  }

  pitchBend(x, { when } = {}) {
    if (!this._started) return;
    this._send('play', { e: 'bend', x: clamp(Number(x) || 0, -1, 1), ...this._whenArg(when) });
  }

  modWheel(v, o) {
    return this.setWheel('mod', v, o);
  }

  expression(v, o) {
    return this.setWheel('expr', v, o);
  }

  volumeCC(v, o) {
    return this.setWheel('vol', v, o);
  }

  setWheel(source, v, { when, glide } = {}) {
    if (!WHEEL_SOURCES.includes(source) || !this._started) return false;
    const g = source === 'virtual' && Number.isFinite(glide) && glide > 0 ? { glide } : {};
    this._send('play', { e: 'wheel', src: source, value: clamp(Number(v) || 0, 0, 1), ...g, ...this._whenArg(when) });
    return true;
  }

  swell(start, { when } = {}) {
    if (!this._started) return false;
    this._send('play', { e: 'swell', ...(start === undefined ? {} : { start: !!start }), ...this._whenArg(when) });
    return true;
  }

  allNotesOff({ when } = {}) {
    this._send('play', { e: 'panic', ...this._whenArg(when) });
  }

  fadeOutAll(seconds = 6, { when } = {}) {
    const s = Number.isFinite(Number(seconds)) ? Number(seconds) : 6;
    this._send('play', { e: 'fade', seconds: Math.max(0.05, s), ...this._whenArg(when) });
  }

  noteInput({ when } = {}) {
    this._send('play', { e: 'input', ...this._whenArg(when) });
  }

  wheelValues() {
    const r = this._runtime;
    return { mod: r.wheel.mod, expr: r.wheel.expr, vol: r.wheel.vol, owner: r.modOwner, swelling: !!r.swelling };
  }

  getRuntimeState() {
    const r = this._runtime;
    return { wheel: { ...r.wheel }, modOwner: r.modOwner, faded: !!r.faded };
  }

  /** No-op: native state survives device restarts (contract 6.6). */
  applyRuntimeState() {}

  get pedal() {
    return this._pedal;
  }

  // ----------------------------------------------------------------------------------------------- click, clock
  /**
   * The JS engine answers synchronously with {t0, downbeat}. Native answers later (the `click` event carries the
   * downbeat), so the return is the shim's estimate: truthy when the click can start, null when it cannot.
   */
  clickStart({ countIn = 0, quietAfter = false, when } = {}) {
    if (!this._started || !(this._tempo > 0)) return null;
    const t0 = Math.max(Number.isFinite(when) ? when : 0, this._clock.currentTime()) + 0.06;
    this._req('click', { action: 'start', countIn, quietAfter, ...this._whenArg(when) }).catch(
      (err) => this._warn(`engine.clickStart failed: ${err && err.message}`),
    );
    return { t0, downbeat: null };
  }

  clickStop({ when } = {}) {
    const was = !!(this._click && (this._click.running || this._click.counting));
    this._send('click', { action: 'stop', ...this._whenArg(when) });
    return was;
  }

  setClick(cfg = {}, { when } = {}) {
    if (!this._started) return null;
    const aux = this._st.channels >= 4;
    const out = cfg.output === 'aux' && aux ? 'aux' : 'main';
    const args = { action: 'config', ...this._whenArg(when) };
    if (Number.isFinite(cfg.level)) args.level = clamp(cfg.level, 0, 1);
    if (cfg.record !== undefined) args.record = !!cfg.record;
    if (cfg.output !== undefined) args.output = out;
    this._send('click', args);
    return { output: out, auxAvailable: aux };
  }

  clickState() {
    return this._click ? { ...this._click } : null;
  }

  clickOutputs() {
    return { aux: this._st.channels >= 4, channels: this._st.channels };
  }

  /**
   * MIDI clock out is native (contract 3.10/5). The sink function itself cannot run natively; only whether one is
   * attached, and its port id when the app tags it (`sink.portId`), reach native. Gap: see SHELL.md.
   */
  setClockSink(fn) {
    this._clockSink = typeof fn === 'function' ? fn : null;
    this._send('config', { midiClock: { port: fn ? (fn.portId ?? 'auto') : null } });
  }

  // ----------------------------------------------------------------------------------------------- meters
  _newPeak() {
    return { pending: 0, last: 0, perf: 0, unread: false };
  }

  get analyserL() {
    return this._analysers[0];
  }

  get analyserR() {
    return this._analysers[1];
  }

  get recordTap() {
    return this._tap;
  }

  _touchMeters() {
    if (this._meterRate !== METER_RATE_ACTIVE) {
      this._meterRate = METER_RATE_ACTIVE;
      this._sendMeters();
    }
    this._armSweep();
  }

  _sendMeters() {
    const slots = [];
    this._slotRead.forEach((t, i) => {
      if (t) slots.push(i);
    });
    this._send('config', { meters: { rate: this._meterRate ?? METER_RATE_IDLE, slots, rta: this._rtaOn } });
  }

  _armSweep() {
    if (this._sweepTimer !== null) return;
    this._sweepTimer = this._timers.setTimeout(() => {
      this._sweepTimer = null;
      this._sweep();
    }, 1000);
  }

  /** Unsubscribes meters nobody read for METER_IDLE_MS; drops to the idle tick rate when none is left. */
  _sweep() {
    const now = this._now();
    let change = false;
    let any = false;
    this._slotRead.forEach((t, i) => {
      if (!t) return;
      if (now - t > METER_IDLE_MS) {
        this._slotRead[i] = 0;
        this._slots[i] = null;
        change = true;
      } else any = true;
    });
    if (this._rtaOn) {
      if (now - this._rta.readAt > METER_IDLE_MS) {
        this._rtaOn = false;
        this._rta.b64 = null;
        this._rta.bytes = null;
        change = true;
      } else any = true;
    }
    const lastPeakRead = this._lastPeakRead || 0;
    if (now - lastPeakRead <= METER_IDLE_MS) any = true;
    if (!any && this._meterRate !== METER_RATE_IDLE) {
      this._meterRate = METER_RATE_IDLE;
      change = true;
    }
    if (change) this._sendMeters();
    if (any) this._armSweep();
  }

  _readPeak(ch) {
    if (this._st.state !== 'running' || this._st.sleep === 'asleep') return 0;
    const now = this._now();
    this._lastPeakRead = now;
    this._touchMeters();
    const p = this._peaks[ch];
    if (p.unread) {
      const v = p.pending;
      p.pending = 0;
      p.unread = false;
      return v;
    }
    return now - p.perf < PEAK_FRESH_MS ? p.last : 0;
  }

  _readRta(ch, arr) {
    const now = this._now();
    this._rta.readAt = now;
    if (!this._rtaOn) {
      this._rtaOn = true;
      if (this._meterRate === METER_RATE_ACTIVE) this._sendMeters(); // else _touchMeters sends the new set
    }
    this._touchMeters();
    if (!this._rta.bytes && this._rta.b64) {
      try {
        const bin = atob(this._rta.b64);
        const b = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
        this._rta.bytes = b;
      } catch {
        this._rta.b64 = null;
      }
    }
    const b = this._rta.bytes;
    const n = Math.min(arr.length, 1024);
    const off = ch * 1024;
    for (let i = 0; i < n; i++) arr[i] = b && b.length >= off + 1024 ? -b[off + i] / 2 : -120;
    for (let i = n; i < arr.length; i++) arr[i] = -120;
  }

  slotLevel(i) {
    if (!Number.isInteger(i) || i < 0 || i >= this._slotLimit() || !this._started) return null;
    if (!this._patch || !this._patch.slots[i] || this._lowResource) return { peak: 0, rms: 0 };
    const now = this._now();
    const added = !this._slotRead[i];
    this._slotRead[i] = now;
    if (added && this._meterRate === METER_RATE_ACTIVE) this._sendMeters(); // else _touchMeters sends the new set
    this._touchMeters();
    const s = this._slots[i];
    return s ? { peak: Number(s[0]) || 0, rms: Number(s[1]) || 0 } : { peak: 0, rms: 0 };
  }

  // ----------------------------------------------------------------------------------------------- shutdown
  /** Close the link and timers (tests, hot reload). Underscore: not part of the contract. */
  _dispose() {
    if (this._sweepTimer !== null) this._timers.clearTimeout(this._sweepTimer);
    this._sweepTimer = null;
    this._link.close();
  }
}
