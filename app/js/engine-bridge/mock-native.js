// MockNative: a JS stand-in for the native engine's bridge side (BRIDGE v1, contract section 6). It plays two roles:
//  1. Validator. Every incoming message is checked against native/contract/engine-api.json (`messages.ops`, the
//     param grammar from shared/params.js, the error codes). Problems become `findings` (and `bad-request` replies),
//     so a shim that drifts from the contract is caught without a native build.
//  2. Plausible peer. It answers every op with a result of the documented shape and emits the documented events
//     (state, tick, notes, wheel, load, click, warn, midi, rec), so the real UI can boot against the bridge in
//     Chromium. It makes no sound.
// The contract JSON is passed in (`api`): Node tests read the file, the browser smoke fetches it.
import { PROTOCOL } from './link.js';
import { isValidPath, MAX_SLOTS, SLOT_COUNT, clamp as clampParam, describe } from '../shared/params.js';
import { patchParam } from './param-read.js';
import { chordName } from '../shared/chords.js';
import { validDynRange } from '../shared/touch-curve.js';

/**
 * hello.minor and caps as the core answers them (native/core/src/bridge/bridge.cpp opHello): minor 1 = T00c
 * (polyphony, bufferFrames, slots16), 2 = voiceLimit (D4), 3 = droneFreeze (D5 / T16), 4 = dynamicRange (T12 O1 /
 * UIB), 5 = getParam (`get {what:'param'}`, CORE2B). T11 O7 / UI wave item 7: the mock used to answer 0; the shim
 * reads it only to skip `get param` on a core older than minor 5.
 */
export const MOCK_MINOR = 5;
export const MOCK_CAPS = Object.freeze(['when', 'testVoice', 'meters', 'rta', 'polyphony', 'bufferFrames', 'slots16',
  'voiceLimit', 'droneFreeze', 'dynamicRange', 'getParam', 'mock']);
/** DECISIONS D4 'auto' per resource profile: mirrors native/core/src/inst/voice_alloc.h kAutoVoiceLimitDesktop/Ipad
 *  (provisional numbers from the Linux bench, ARCHITECTURE 7.1). */
export const AUTO_VOICE_LIMIT = Object.freeze({ desktop: 128, ipad: 64 });
const OPS_NEED_AUDIO = new Set(['prepare', 'commit', 'cache', 'play', 'click', 'rec']);
const GRAMMAR_KEYS = new Set(['v', 'op', 'id']);

/** Split on `|` outside brackets and quotes. */
function splitAlts(spec) {
  const out = [];
  let depth = 0;
  let q = false;
  let cur = '';
  for (const ch of spec) {
    if (ch === "'") q = !q;
    if (!q && (ch === '{' || ch === '[')) depth += 1;
    if (!q && (ch === '}' || ch === ']')) depth -= 1;
    if (ch === '|' && depth === 0 && !q) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Check a value against one contract type spec ("int", "'a'|'b'?", "string[]?", "{pc, minor}?", ...).
 * @returns {{optional:boolean, ok:boolean, unknown?:string}}
 */
export function checkSpec(spec, value) {
  let s = String(spec).trim();
  const optional = s.endsWith('?') && !s.endsWith('|?');
  if (optional) s = s.slice(0, -1);
  if (value === undefined) return { optional, ok: optional };
  let unknown;
  const one = (alt) => {
    const a = alt.trim();
    if (/^'.*'$/.test(a)) return value === a.slice(1, -1);
    if (/^-?\d+(\.\d+)?$/.test(a)) return value === Number(a);
    if (a === 'null') return value === null;
    if (a === 'int') return Number.isInteger(value);
    if (a === 'string' || a === 'ParamPath' || a === 'id') return typeof value === 'string';
    if (a === 'bool') return typeof value === 'boolean';
    if (['s', 'number', 'engine s', '0..1'].includes(a)) {
      return typeof value === 'number' && Number.isFinite(value) && (a !== '0..1' || (value >= 0 && value <= 1));
    }
    if (a === 'any') return true;
    if (a.endsWith('[]')) {
      if (!Array.isArray(value)) return false;
      const inner = a.slice(0, -2);
      const okItem = (x) => (inner === 'string' ? typeof x === 'string' : inner === 'int' ? Number.isInteger(x) : true);
      return value.every(okItem);
    }
    if (a.startsWith('[')) return Array.isArray(value);
    if (a.startsWith('{') || ['object', 'Patch', 'Routing', 'touch', 'SongDrone'].includes(a)) return isObj(value);
    unknown = a;
    return true;
  };
  return { optional, ok: splitAlts(s).some(one), unknown };
}

/** @param {{api:object, transport:{post:Function,onMessage:Function}, now?:()=>number, timers?:object,
 *   autoTick?:boolean, seed?:number, sampleRate?:number, channels?:number, devices?:object[],
 *   profile?:'desktop'|'ipad', midiPorts?:Array<{id:string, name?:string, manufacturer?:string,
 *   kind?:'input'|'output'}>}} o */
export class MockNative {
  constructor(o) {
    if (!o || !o.api || !o.transport) throw new TypeError('MockNative needs {api, transport}');
    this.api = o.api;
    this.transport = o.transport;
    this.now = o.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.timers = o.timers || {
      setInterval: (f, ms) => setInterval(f, ms), clearInterval: (h) => clearInterval(h),
    };
    this.sampleRate = o.sampleRate || 48000;
    this.channels = o.channels || 2;
    this.seed = o.seed ?? 1;
    this.devices = o.devices || [
      { id: 'default', name: 'Mock output', channels: this.channels, default: true, sampleRates: [44100, 48000] },
    ];
    this.ops = new Map(this.api.messages.ops.map((op) => [op.op, op]));
    this.errorCodes = new Set(this.api.messages.errors);
    /** Everything the validator did not like: {kind, op, ...}. kinds: unknown-op, unknown-field, missing, type,
     *  bad-enum, protocol, before-hello, unknown-param, spec-gap, unrecognised-spec. */
    this.findings = [];
    /** op[:action|e] -> count, for the smoke ("which contracted messages did the UI send"). */
    this.calls = new Map();
    this.received = [];
    this.helloDone = false;
    this.audio = { started: false, startPerf: 0, epoch: 0, frames0: 0, asleepAt: null, asleepTotal: 0 };
    this.st = { sleep: 'awake', deviceId: 'default', latency: 'interactive' };
    this.nextToken = 1;
    this.latestToken = 0;
    this.committedToken = 0;
    this.patch = null;
    this.held = new Map(); // note -> vel
    this.chord = null;
    this._chordKey = 'null';
    this.pedal = false;
    this.wheel = { mod: 0, expr: 1, vol: 1 };
    this.modOwner = 'hw';
    this.faded = false;
    this.swelling = false;
    this.lowResource = false;
    // config {polyphony} (D1) and {voiceLimit} (D4), echoed like the core (bridge.cpp opConfig, Model::stateJson)
    this.profile = o.profile === 'ipad' ? 'ipad' : 'desktop';
    this.polyphony = 64;
    this.voiceLimit = 'auto';
    // D2: audio {bufferFrames} as requested (kept across restarts, 0 / absent = the host's 128), echoed as the grant
    // in audio replies and state events (Settings review item 3); a test can set `grantFrames` to stand in for a
    // device that rounds the request (iPad)
    this.bufferFrames = 128;
    this.grantFrames = null;
    this.droneFreeze = true; // D5 (config {droneFreeze}, default true)
    this.dynamicRange = 1; // T12 O1 (config {dynamicRange}, 1..3, default 1)
    this.meters = { rate: 4, slots: [], rta: false };
    this.click = { running: false, counting: false, bpm: null, sig: '4/4', output: 'main', level: 0.5, record: false,
      downbeat: null };
    this.tempo = null;
    this.params = new Map();
    this.peak = [0, 0];
    this.tickCount = 0;
    this._out = [];
    this._unspec = new Set();
    this._timer = null;
    /** Lane NMA: MIDI ports (key 'input:<id>' / 'output:<id>'), the listened source ids (null = no listen yet: no
     *  source connected), and logs of listens and sends. o.midiPorts = the ports present at start. */
    this.midi = { ports: new Map(), listening: null, listens: [], sent: [], route: false, forwarded: 0, filtered: 0 };
    for (const p of o.midiPorts || []) {
      const kind = p.kind === 'output' ? 'output' : 'input';
      this.midi.ports.set(`${kind}:${p.id}`, { id: p.id, name: p.name || '', manufacturer: p.manufacturer || '',
        state: 'connected', kind });
    }
    this._offMsg = o.transport.onMessage((m) => this.receive(m));
    this.autoTick = !!o.autoTick;
    this._lastPerf = this.now();
    this._clockT = 0;
    this._running = false;
  }

  close() {
    if (this._timer !== null) this.timers.clearInterval(this._timer);
    this._timer = null;
    if (typeof this._offMsg === 'function') this._offMsg();
  }

  // ------------------------------------------------------------------------------------------- engine time
  /** Engine time (s): frames rendered / sample rate; runs only while the device is open and awake. */
  t() {
    const p = this.now();
    if (this._running) this._clockT += (p - this._lastPerf) / 1000;
    this._lastPerf = p;
    return this._clockT;
  }

  _setRunning(on) {
    this.t();
    this._running = on;
  }

  // ------------------------------------------------------------------------------------------- output
  _emit(ev, data = {}) {
    this._out.push({ v: PROTOCOL, ev, ...data });
  }

  _reply(id, ok, payload) {
    if (id === undefined) return;
    if (ok) this._out.push({ v: PROTOCOL, re: id, ok: true, result: payload });
    else this._out.push({ v: PROTOCOL, re: id, ok: false, error: payload });
  }

  _flush() {
    if (!this._out.length) return;
    const batch = this._out;
    this._out = [];
    this.transport.post(batch);
  }

  _fail(msg, code, message, detail) {
    if (!this.errorCodes.has(code)) this.findings.push({ kind: 'bad-error-code', code });
    if (msg.id !== undefined) this._reply(msg.id, false, { code, message, ...(detail ? { detail } : {}) });
    else this._emit('warn', { message, code, op: msg.op });
  }

  _find(kind, msg, extra = {}) {
    this.findings.push({ kind, op: msg && msg.op, ...extra });
  }

  // ------------------------------------------------------------------------------------------- validation
  /** @returns {string|null} a problem description (the message is rejected) or null */
  validate(msg) {
    if (!isObj(msg)) {
      this._find('type', msg, { detail: 'not an object' });
      return 'message is not an object';
    }
    if (msg.v !== PROTOCOL) {
      this._find('protocol', msg, { v: msg.v });
      return 'protocol';
    }
    const def = this.ops.get(msg.op);
    if (!def) {
      this._find('unknown-op', msg, { op: msg.op });
      return 'unknown-op';
    }
    let problem = null;
    const batch = msg.op === 'set' && msg.batch !== undefined;
    for (const [field, spec] of Object.entries(def.args)) {
      // spec gap: `set` lists path/value as required but the batch form has neither
      if (msg.op === 'set' && (field === 'path' || field === 'value') && batch) continue;
      if (msg.op === 'set' && field === 'value' && msg.path !== undefined && msg.value === undefined) {
        if (!('value' in msg)) {
          problem = problem || 'set without value';
          this._find('missing', msg, { field });
        }
        continue;
      }
      const r = checkSpec(spec, msg[field]);
      if (r.unknown && !this._unspec.has(`${msg.op}.${field}`)) {
        this._unspec.add(`${msg.op}.${field}`);
        this._find('unrecognised-spec', msg, { field, spec });
      }
      if (msg[field] === undefined && !r.optional) {
        // `value` may legitimately be null/absent after JSON round trip of undefined: treat as missing
        this._find('missing', msg, { field });
        problem = problem || `missing ${field}`;
      } else if (!r.ok) {
        this._find('type', msg, { field, spec, got: JSON.stringify(msg[field]) });
        problem = problem || `bad ${field}`;
      }
    }
    for (const k of Object.keys(msg)) {
      if (GRAMMAR_KEYS.has(k) || k in def.args) continue;
      this._find('unknown-field', msg, { field: k });
    }
    if (batch && Array.isArray(msg.batch)) {
      for (const e of msg.batch) {
        if (!Array.isArray(e) || typeof e[0] !== 'string' || e.length < 2 || e.length > 3) {
          this._find('type', msg, { field: 'batch', got: JSON.stringify(e) });
          problem = problem || 'bad batch entry';
        }
      }
    }
    if (msg.op === 'set' && !batch && msg.path === undefined) problem = problem || 'set without path';
    if (msg.op === 'play' && !problem) problem = this._playShape(msg);
    return problem;
  }

  _playShape(msg) {
    const need = {
      on: ['n'], off: ['n'], pedal: ['down'], wheel: ['src', 'value'], bend: ['x'], swell: [], panic: [], fade: [],
      input: [],
    }[msg.e];
    if (!need) return null; // enum failure already reported by checkSpec
    for (const f of need) {
      if (msg[f] === undefined) {
        this._find('missing', msg, { field: f, e: msg.e });
        return `play ${msg.e} needs ${f}`;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------------------------------- receive
  receive(batch) {
    const list = Array.isArray(batch) ? batch : [batch];
    for (const m of list) this._handle(m);
    this._flush();
  }

  _count(msg) {
    const sub = msg.action ?? msg.e ?? msg.what;
    const key = sub !== undefined ? `${msg.op}:${sub}` : String(msg.op);
    this.calls.set(key, (this.calls.get(key) || 0) + 1);
  }

  _handle(msg) {
    this.received.push(msg);
    if (isObj(msg) && typeof msg.op === 'string') this._count(msg);
    const problem = this.validate(msg);
    if (isObj(msg) && msg.op !== 'hello' && !this.helloDone) this._find('before-hello', msg);
    if (problem) {
      const code = problem === 'protocol' ? 'protocol' : problem === 'unknown-op' ? 'unknown-op' : 'bad-request';
      return this._fail(isObj(msg) ? msg : {}, code, `${isObj(msg) ? msg.op : '?'}: ${problem}`);
    }
    if (OPS_NEED_AUDIO.has(msg.op) && !this.audio.started) {
      return this._fail(msg, 'not-started', `${msg.op} before audio start`);
    }
    try {
      const fn = this[`op_${msg.op}`];
      return fn.call(this, msg);
    } catch (err) {
      return this._fail(msg, 'internal', `${msg.op}: ${err && err.message}`);
    }
  }

  // ------------------------------------------------------------------------------------------- state events
  _state(extra = {}) {
    return {
      state: this.audio.started ? 'running' : 'suspended', sleep: this.st.sleep, latencyMs: 12,
      sampleRate: this.sampleRate, deviceId: this.st.deviceId, channels: this.channels,
      bufferFrames: this.grantFrames ?? this.bufferFrames, ...extra,
    };
  }

  op_hello(m) {
    if (m.protocol !== PROTOCOL) return this._fail(m, 'protocol', `protocol ${m.protocol} not supported`);
    this.helloDone = true;
    return this._reply(m.id, true, {
      protocol: PROTOCOL, minor: MOCK_MINOR, engine: 'worship-rig-core mock 0.0', caps: [...MOCK_CAPS],
      sampleRate: this.sampleRate, seed: this.seed,
    });
  }

  op_audio(m) {
    switch (m.action) {
      case 'start':
      case 'restart': {
        const restarted = m.action === 'restart';
        if (restarted) this.audio.epoch += 1;
        if (m.deviceId !== undefined) this.st.deviceId = m.deviceId || 'default';
        if (m.latency !== undefined) this.st.latency = m.latency;
        if (m.bufferFrames !== undefined) this.bufferFrames = m.bufferFrames || 128;
        const first = !this.audio.started;
        this.audio.started = true;
        this.st.sleep = 'awake';
        this._setRunning(true);
        this._emit('state', this._state(restarted ? { restarted: true } : {}));
        if (first) this._emit('load', { phase: 'start' });
        this._ensureTicker();
        return this._reply(m.id, true, this._state());
      }
      case 'output':
        this.st.deviceId = m.deviceId || 'default';
        this._emit('state', this._state());
        return this._reply(m.id, true, this._state());
      case 'sleep':
      case 'wake': {
        if (!this.audio.started) return this._fail(m, 'not-started', `${m.action} before audio start`);
        const sleep = m.action === 'sleep';
        const changed = (this.st.sleep === 'awake') === sleep;
        if (changed) {
          this.st.sleep = sleep ? 'asleep' : 'awake';
          this._setRunning(!sleep);
          this._emit('state', this._state(sleep ? {} : { wakeMs: 8, queued: 0 }));
        }
        return this._reply(m.id, true, { done: changed });
      }
      default:
        return this._fail(m, 'bad-request', `audio action ${m.action}`);
    }
  }

  // ------------------------------------------------------------------------------------------- songs, cache
  _samplerIds(patch) {
    const ids = [];
    for (const s of (patch && patch.slots) || []) {
      if (s && s.instrument && s.instrument.type === 'sampler') ids.push(s.instrument.id);
    }
    return ids;
  }

  _emitSamples(patches) {
    const loaded = {};
    for (const p of patches) for (const id of this._samplerIds(p)) loaded[id] = true;
    if (Object.keys(loaded).length) this._emit('load', { phase: 'samples', loaded });
  }

  op_prepare(m) {
    const token = this.nextToken++;
    this.latestToken = token;
    ((m.patch && m.patch.slots) || []).forEach((s, slot) => {
      if (!s) return;
      this._emit('load', { phase: 'slot', slot, progress: 0.5, token });
      this._emit('load', { phase: 'slot', slot, progress: 1, token });
    });
    this._emitSamples([m.patch]);
    this._plans = this._plans || new Map();
    this._plans.set(token, m.patch);
    return this._reply(m.id, true, { token });
  }

  op_commit(m) {
    if (!(this._plans && this._plans.has(m.token))) return this._fail(m, 'stale-token', `unknown token ${m.token}`);
    const ok = m.token === this.latestToken && m.token !== this.committedToken;
    if (ok) {
      this.committedToken = m.token;
      this.patch = this._plans.get(m.token);
      this.params.clear(); // CORE2B: `get param` reads the committed patch until the next set
    }
    return this._reply(m.id, true, { committed: ok });
  }

  op_cache(m) {
    const patches = m.patches || [];
    if (m.action === 'preload') {
      this._emitSamples(patches);
      const mb = 12 * patches.length;
      this._emit('load', { phase: 'preload', decodedMB: mb, pinnedMB: mb, deferred: 0 });
      return this._reply(m.id, true, { decodedMB: mb, pinnedMB: mb, deferred: 0 });
    }
    if (m.action === 'estimate') {
      const samples = 40 * patches.length;
      return this._reply(m.id, true, { mb: 1.75 * samples, exact: false, samples, capMB: 700 });
    }
    return this._reply(m.id, true, { ok: true });
  }

  op_set(m) {
    const one = (path, value) => {
      // UIC (UIA review O2): the core takes slots.0..15 since T00c (params.cpp); the default bound was 1.x's 4
      if (!isValidPath(path, MAX_SLOTS)) {
        this._find('unknown-param', m, { path });
        return false;
      }
      this.params.set(path, value);
      return true;
    };
    if (m.batch) {
      const applied = m.batch.map((e) => one(e[0], e[1]));
      return this._reply(m.id, true, { applied });
    }
    if (!isValidPath(m.path, MAX_SLOTS)) return this._fail(m, 'unknown-param', `Unknown parameter "${m.path}"`);
    return this._reply(m.id, true, { applied: one(m.path, m.value) });
  }

  op_song(m) {
    if (m.tempo !== undefined) {
      this.tempo = m.tempo;
      this.click.bpm = m.tempo;
    }
    if (m.timeSig) this.click.sig = m.timeSig;
    return this._reply(m.id, true, {});
  }

  op_drone(m) {
    const r = {};
    if (m.files) r.files = m.files.length;
    if (m.key) r.changed = true;
    return this._reply(m.id, true, r);
  }

  // ------------------------------------------------------------------------------------------- perform
  _noteState() {
    const notes = [...this.held.keys()].sort((a, b) => a - b);
    const ev = { held: notes };
    let chord = null;
    if (notes.length >= 2) {
      const r = chordName(notes.map((n) => n % 12), notes[0] % 12);
      if (r && typeof r === 'object') chord = r;
    }
    const key = JSON.stringify(chord);
    if (key !== this._chordKey) {
      this._chordKey = key;
      ev.chord = chord;
    }
    this._emit('notes', ev);
  }

  op_play(m) {
    switch (m.e) {
      case 'on':
        this.held.set(m.n, m.vel ?? 100);
        this._noteState();
        break;
      case 'off':
        this.held.delete(m.n);
        this._noteState();
        break;
      case 'pedal':
        this.pedal = !!m.down;
        break;
      case 'wheel':
        if (m.src !== 'virtual') this.wheel[m.src] = m.value;
        this._emit('wheel', { source: m.src, value: m.value });
        break;
      case 'panic':
        this.held.clear();
        this.pedal = false;
        this._noteState();
        break;
      case 'fade':
        this.faded = true;
        break;
      default:
        break;
    }
    if (m.e === 'on' && this.faded) this.faded = false;
    return this._reply(m.id, true, { ok: true });
  }

  op_click(m) {
    if (m.action === 'start') {
      if (!(this.tempo > 0)) return this._reply(m.id, true, null);
      const t = this.t();
      this.click.running = true;
      this.click.counting = (m.countIn || 0) > 0;
      this.click.downbeat = t + 0.06;
      this._emit('click', { ...this.click });
      return this._reply(m.id, true, { t0: t + 0.06, downbeat: t + 0.06 });
    }
    if (m.action === 'stop') {
      const was = this.click.running;
      this.click.running = false;
      this.click.counting = false;
      this._emit('click', { ...this.click });
      return this._reply(m.id, true, { wasRunning: was });
    }
    if (m.level !== undefined) this.click.level = m.level;
    if (m.record !== undefined) this.click.record = m.record;
    if (m.output !== undefined) this.click.output = this.channels >= 4 ? m.output : 'main';
    this._emit('click', { ...this.click });
    return this._reply(m.id, true, { output: this.click.output, auxAvailable: this.channels >= 4 });
  }

  op_config(m) {
    const r = {};
    if (m.lowResource !== undefined) {
      this.lowResource = !!m.lowResource;
      r.lowResource = this.lowResource;
    }
    if (m.eqAudition) r.eqAudition = Number.isInteger(m.eqAudition.slot);
    if (m.polyphony !== undefined) r.polyphony = this.polyphony = m.polyphony;
    if (m.voiceLimit !== undefined && m.voiceLimit !== null) {
      this.voiceLimit = m.voiceLimit;
      Object.assign(r, this._voiceLimitFields());
    }
    if (typeof m.droneFreeze === 'boolean') r.droneFreeze = this.droneFreeze = m.droneFreeze;
    // bridge.cpp opConfig -> Model::setDynamicRange: validDynRange (1..6 since TOUCH D43), a non-finite number = 1
    if (typeof m.dynamicRange === 'number') r.dynamicRange = this.dynamicRange = validDynRange(m.dynamicRange) ?? 1;
    if (m.meters) {
      this.meters = {
        rate: m.meters.rate ?? this.meters.rate, slots: m.meters.slots ?? this.meters.slots,
        rta: m.meters.rta ?? this.meters.rta,
      };
      if (this._timer !== null) this._ensureTicker(true);
    }
    return this._reply(m.id, true, r);
  }

  /** D4: `{voiceLimit: 'auto'|n, voiceLimitEffective: n}` (0 = off), as the core's Model::voiceLimitJson. */
  _voiceLimitFields() {
    const eff = this.voiceLimit === 'auto' ? AUTO_VOICE_LIMIT[this.profile] : this.voiceLimit;
    return { voiceLimit: this.voiceLimit, voiceLimitEffective: eff };
  }

  op_get(m) {
    switch (m.what) {
      case 'instruments':
        return this._reply(m.id, true, this.api.instruments.list.map((e) => ({ ...e })));
      case 'stats':
        return this._reply(m.id, true, this._stats());
      case 'devices':
        return this._reply(m.id, true, this.devices);
      case 'sampleStatus': {
        const ps = m.patches || [];
        return this._reply(m.id, true, { loaded: ps.map(() => true), failed: ps.map(() => false) });
      }
      case 'param': {
        // CORE2B: like the core (model/param_read.cpp): the latest set (clamped as PARAMS clamps it; instrument
        // params as sent), else the committed patch; `value` absent = undefined; outside the grammar = unknown-param
        if (typeof m.path !== 'string') return this._fail(m, 'bad-request', "get param: 'path' is required");
        if (!isValidPath(m.path, MAX_SLOTS)) return this._fail(m, 'unknown-param', `Unknown parameter "${m.path}"`);
        let value;
        if (this.params.has(m.path)) {
          const raw = this.params.get(m.path);
          try {
            value = describe(m.path)?.dynamic ? raw : clampParam(m.path, raw);
          } catch {
            value = raw;
          }
        } else value = patchParam(this.patch, m.path, this.api.instruments.list);
        return this._reply(m.id, true, value === undefined ? { path: m.path } : { path: m.path, value });
      }
      case 'state':
        return this._reply(m.id, true, {
          patch: this.patch, routing: {}, transpose: 0, tempo: this.tempo, timeSig: this.click.sig, keyContext: null,
          drone: {}, mono: false, runtime: this._runtime(), click: { ...this.click }, sleep: this.st.sleep,
          polyphony: this.polyphony, ...this._voiceLimitFields(), dynamicRange: this.dynamicRange,
        });
      default:
        return this._fail(m, 'bad-request', `get ${m.what}`);
    }
  }

  // ------------------------------------------------------------------------------------------- MIDI (lane NMA)
  // The mock stands in for the core (midi_service.cpp) AND the shell (RigMIDI.swift) together: `listen` sets which
  // sources are connected (none before the first one, as RigMIDI connects none) and replies the present ports
  // without an event; a port report (midiSetPorts / midiPlug / midiUnplug, the shell's hot-plug) emits
  // `midi {type:'ports'}`; midiIn() forwards one message from a listened, connected input as `midi {type:'msg'}`
  // with `ts` in engine seconds; `send` is logged in midiSent.

  /** Present ports as the core lists them (PortTable::json). */
  _midiPortList() {
    return [...this.midi.ports.values()].map((p) => ({ ...p }));
  }

  /**
   * Replace the port list (a CoreMIDI setup change) and emit the `ports` event.
   * @param {Array<{id:string, name?:string, manufacturer?:string, state?:string, kind?:'input'|'output'}>} list
   */
  midiSetPorts(list) {
    this.midi.ports = new Map();
    for (const p of list || []) {
      if (!p || typeof p.id !== 'string' || !p.id) continue;
      this.midi.ports.set(`${p.kind === 'output' ? 'output' : 'input'}:${p.id}`, {
        id: p.id, name: p.name || '', manufacturer: p.manufacturer || '',
        state: p.state === 'disconnected' ? 'disconnected' : 'connected',
        kind: p.kind === 'output' ? 'output' : 'input',
      });
    }
    this._emit('midi', { type: 'ports', ports: this._midiPortList() });
    this._flush();
  }

  /** Plug a port in (or update it). */
  midiPlug(port) {
    const key = `${port.kind === 'output' ? 'output' : 'input'}:${port.id}`;
    const rest = [...this.midi.ports.entries()].filter(([k]) => k !== key).map(([, p]) => p);
    this.midiSetPorts([...rest, port]);
  }

  /** Unplug a port: it leaves the list (CoreMIDI removes the endpoint). */
  midiUnplug(id, kind = 'input') {
    this.midiSetPorts([...this.midi.ports.entries()].filter(([k]) => k !== `${kind}:${id}`).map(([, p]) => p));
  }

  /**
   * One complete message from input `id`, as CoreMIDI delivers it. Forwarded only from a listened, present input.
   * @param {string} id
   * @param {number[]} data
   * @param {{ts?:number}} [o] engine seconds (default: now)
   * @returns {boolean} forwarded
   */
  midiIn(id, data, o = {}) {
    const p = this.midi.ports.get(`input:${id}`);
    if (!p || p.state === 'disconnected' || !this.midi.listening || !this.midi.listening.has(id)) {
      this.midi.filtered += 1;
      return false;
    }
    this.midi.forwarded += 1;
    this._emit('midi', { type: 'msg', port: id, data: [...data], ts: o.ts ?? this.t(), handled: false });
    this._flush();
    return true;
  }

  op_midi(m) {
    if (m.action === 'listen') {
      this.midi.listening = new Set(Array.isArray(m.ids) ? m.ids.filter((x) => typeof x === 'string') : []);
      this.midi.listens.push([...this.midi.listening]);
      return this._reply(m.id, true, { ports: this._midiPortList() });
    }
    if (m.action === 'send') {
      const isByte = (b) => Number.isInteger(b) && b >= 0 && b <= 255;
      const ok = typeof m.port === 'string' && Array.isArray(m.data) && m.data.length > 0 && m.data.every(isByte);
      if (ok) {
        const when = m.when !== undefined ? { when: m.when } : {};
        this.midi.sent.push({ port: m.port, data: [...m.data], ...when });
      }
      return this._reply(m.id, true, { sent: ok });
    }
    if (m.action === 'route') {
      this.midi.route = !!m.on;
      return this._reply(m.id, true, { on: this.midi.route });
    }
    return this._fail(m, 'bad-request', `midi: unknown action ${m.action}`);
  }

  op_rec(m) {
    if (m.action === 'start') {
      this._rec = { t: this.t() };
      this._emit('rec', { state: 'recording', path: '/tmp/mock.wav' });
      return this._reply(m.id, true, { path: '/tmp/mock.wav' });
    }
    const secs = this._rec ? this.t() - this._rec.t : 0;
    this._rec = null;
    this._emit('rec', { state: 'stopped', path: '/tmp/mock.wav' });
    const bytes = Math.round(secs * this.sampleRate * 4);
    return this._reply(m.id, true, { path: '/tmp/mock.wav', seconds: secs, bytes });
  }

  // ------------------------------------------------------------------------------------------- ticks
  _runtime() {
    return { wheel: { ...this.wheel }, modOwner: this.modOwner, faded: this.faded, swelling: this.swelling };
  }

  _stats() {
    return {
      voices: this.held.size, nodes: 0, retiring: 0, decodedMB: 0, pinnedMB: 0, referencedMB: 0, capMB: 700,
      sounding: this.held.size, pedaled: this.pedal ? 1 : 0, timers: 0, lowResource: this.lowResource, slotLevelTaps: 0,
    };
  }

  /** Emit one tick now (tests call this; the auto ticker calls it at `meters.rate`). */
  emitTick() {
    if (!this.audio.started || this.st.sleep === 'asleep') return;
    this.tickCount += 1;
    const level = Math.min(1, [...this.held.values()].reduce((a, v) => a + (v / 127) * 0.2, 0));
    this.peak = this.peak.map((p) => Math.max(level, p * 0.85));
    const t = this.t();
    const tick = {
      t, frames: Math.round(t * this.sampleRate), out: [this.peak[0], this.peak[1]],
      blockers: this.held.size ? ['voices'] : [], pedal: this.pedal, held: this.held.size, runtime: this._runtime(),
      cpu: 0.02,
    };
    if (this.meters.slots.length) {
      const on = (i) => this.meters.slots.includes(i);
      // contract tick row: one pair per slot of the song, at least 4, at most 16 (UIC: was always 4)
      const songSlots = (this.patch && this.patch.slots && this.patch.slots.length) || 0;
      const n = Math.min(MAX_SLOTS, Math.max(SLOT_COUNT, songSlots));
      tick.slots = Array.from({ length: n }, (_, i) => (on(i) ? [this.peak[0], this.peak[0] * 0.7] : [0, 0]));
    }
    if (this.meters.rta) {
      const bytes = new Uint8Array(2048);
      for (let i = 0; i < 2048; i++) bytes[i] = 200 - ((i % 1024) >> 3);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      tick.rta = btoa(bin);
    }
    if (this.tickCount % Math.max(1, Math.round(this.meters.rate)) === 0) tick.stats = this._stats();
    this._emit('tick', tick);
    this._flush();
  }

  _ensureTicker(reset = false) {
    if (!this.autoTick) return;
    if (this._timer !== null && !reset) return;
    if (this._timer !== null) this.timers.clearInterval(this._timer);
    this._timer = this.timers.setInterval(() => this.emitTick(), Math.round(1000 / Math.max(1, this.meters.rate)));
  }

  /** @returns {{ops:Object<string,number>, findings:object[]}} summary for reports */
  summary() {
    return { calls: Object.fromEntries(this.calls), findings: this.findings };
  }
}
