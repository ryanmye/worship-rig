// FX topology (SPEC §3.1) + low-level engine helpers shared by audio.js / drone.js / sampler.js.
//
// slot channel → fader → wheel → pan ─┬─ dry ─────────────────────────────┐
//                                      ├─ send.reverb → HPF180 → LPF9k → predelay → [convA|convB] ─┤
//                                      ├─ send.delay  → [lineA|lineB] ──────────────────────────┤ → sum → lofi → master → wheel → fade
//                                      └─ send.chorus → 2-voice chorus ─────────────────────────┘    → catcher comp → soft clip → [mono] → out
//
// Every param change goes through shared/automation.js. No setTimeout: timers are audio-clock based
// (AudioTimer), so the whole graph renders identically inside an OfflineAudioContext.
import { rampTo, linearTo, setNow, glideTo } from '../shared/automation.js';
import { createRng, hashSeed } from '../shared/prng.js';
import { describe as describeParam, clamp as clampParam, EQ_BAND_COUNT } from '../shared/params.js';

const TAU = 0.015; // SPEC §3.1 continuous-control smoothing

/**
 * Web Audio lowpass/highpass `Q` is in dB (resonance), not the linear Q of the RBJ cookbook. A 2-pole Butterworth
 * section (linear Q 1/√2) is −3.01 dB; a 4-pole Butterworth is the pair .5412 / 1.3066 = −5.33 / +2.32 dB.
 */
export const BUTTER2_Q = 20 * Math.log10(Math.SQRT1_2);
export const BUTTER4_Q = Object.freeze([20 * Math.log10(0.5412), 20 * Math.log10(1.3066)]);

export function isOfflineContext(ctx) {
  return typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
}

/** Deterministic RNG per subsystem name: independent of creation order (lofi on/off renders stay identical). */
export function rngFor(seed, name) {
  return createRng(hashSeed(`${seed >>> 0}|${name}`));
}

/**
 * Linear ramp from a KNOWN start value. Chromium's cancelAndHoldAtTime does not insert a hold after a completed
 * ramp / setTarget (or on an empty timeline), so a bare automation.linearTo would start from the previous event
 * (verified in Chromium 1194). Anchoring with setNow(from, when) first makes the ramp start exactly at `when`.
 */
export function linFrom(param, from, to, when, dur) {
  setNow(param, from, when);
  return linearTo(param, to, when, dur, { from });
}
/** Exponential glide from a known start value (same anchoring reason as linFrom). */
export function glideFrom(param, from, to, when, dur) {
  setNow(param, from, when);
  return glideTo(param, to, when, dur, { from });
}

/**
 * Equal-power fade drawn as piecewise-linear segments through automation.linearTo (no direct AudioParam calls).
 * Fade in (to > from) follows sin, fade out follows cos, so two uncorrelated signals keep constant power.
 */
export function equalPowerFade(param, from, to, when, dur, segs = 16) {
  if (!(dur > 0)) return setNow(param, to, when);
  setNow(param, from, when); // anchor (see linFrom)
  const up = to >= from;
  const d = dur / segs;
  let prev = from;
  for (let k = 1; k <= segs; k++) {
    const x = (k / segs) * (Math.PI / 2);
    const v = k === segs ? to : up ? from + (to - from) * Math.sin(x) : to + (from - to) * Math.cos(x);
    linearTo(param, v, when + (k - 1) * d, d, { from: prev }); // each segment starts where the previous ended
    prev = v;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Audio-clock timer. Realtime: one ConstantSourceNode armed for the earliest deadline (onended). Offline:
// OfflineAudioContext.suspend(t) → callbacks → resume(), which is sample-deterministic.
// Callbacks receive max(scheduled time, currentTime) so automation they schedule is never in the past.
export class AudioTimer {
  constructor(ctx) {
    this.ctx = ctx;
    this.offline = isOfflineContext(ctx);
    this._queue = []; // realtime: sorted [{t, cb, cancelled}]
    this._armed = new Map(); // node -> t
    this._sink = null;
    this._suspends = new Map(); // offline: frameIndex -> entries
    this._inSuspend = false;
    this._immediate = [];
    this._disposed = false;
  }

  /** Schedule cb(t) at audio time `when`. Returns a cancel function. */
  at(when, cb) {
    const entry = { t: Math.max(Number.isFinite(when) ? when : 0, 0), cb, cancelled: false };
    if (this._disposed) return () => {};
    if (this.offline) this._atOffline(entry);
    else this._atRealtime(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  _fire(entry) {
    if (entry.cancelled || this._disposed) return;
    entry.cancelled = true;
    try {
      entry.cb(Math.max(entry.t, this.ctx.currentTime));
    } catch (e) {
      console.warn('[engine] timer callback failed:', e);
    }
  }

  _atRealtime(entry) {
    const q = this._queue;
    let i = q.length;
    while (i > 0 && q[i - 1].t > entry.t) i--;
    q.splice(i, 0, entry);
    this._ensureArmed();
  }

  _ensureArmed() {
    if (!this._queue.length || this._disposed) return;
    const next = this._queue[0].t;
    const now = this.ctx.currentTime;
    for (const t of this._armed.values()) if (t <= next + 0.001 && t >= now - 0.05) return;
    const ctx = this.ctx;
    if (!this._sink) {
      this._sink = new GainNode(ctx, { gain: 0 });
      this._sink.connect(ctx.destination);
    }
    const src = new ConstantSourceNode(ctx, { offset: 0 });
    src.connect(this._sink);
    this._armed.set(src, next);
    src.onended = () => {
      src.disconnect();
      this._armed.delete(src);
      this._drain();
    };
    src.start(now);
    src.stop(Math.max(next, now));
  }

  _drain() {
    const now = this.ctx.currentTime + 0.003; // within a render quantum counts as due
    while (this._queue.length && this._queue[0].t <= now) this._fire(this._queue.shift());
    while (this._queue.length && this._queue[0].cancelled) this._queue.shift();
    this._ensureArmed();
  }

  _atOffline(entry) {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const k = Math.ceil((entry.t * sr) / 128 - 1e-6);
    const t = (k * 128) / sr;
    const cur = ctx.currentTime;
    if (t <= cur + 1e-9) {
      if (this._inSuspend) this._immediate.push(entry);
      else queueMicrotask(() => this._fire(entry));
      return;
    }
    if (t >= ctx.length / sr) return; // beyond the render: never fires
    let list = this._suspends.get(k);
    if (!list) {
      list = [];
      this._suspends.set(k, list);
      let p;
      try {
        p = ctx.suspend(t);
      } catch (e) {
        this._suspends.delete(k);
        queueMicrotask(() => this._fire(entry));
        return;
      }
      p.then(
        () => {
          this._suspends.delete(k);
          this._inSuspend = true;
          for (let i = 0; i < list.length; i++) this._fire(list[i]);
          while (this._immediate.length) this._fire(this._immediate.shift());
          this._inSuspend = false;
          ctx.resume().catch(() => {});
        },
        () => {
          this._suspends.delete(k);
          for (const e of list) queueMicrotask(() => this._fire(e));
        },
      );
    }
    list.push(entry);
  }

  pendingCount() {
    return this._queue.length + [...this._suspends.values()].reduce((a, l) => a + l.length, 0);
  }

  dispose() {
    this._disposed = true;
    for (const n of this._armed.keys()) {
      try {
        n.onended = null;
        n.stop();
        n.disconnect();
      } catch {}
    }
    this._armed.clear();
    this._queue.length = 0;
    try {
      this._sink?.disconnect();
    } catch {}
  }
}

/** ≤ 1 update per `interval` seconds per key (SPEC §3.1); the latest value wins (trailing flush via the timer). */
export class Coalescer {
  constructor(timer, interval = 0.01) {
    this.timer = timer;
    this.interval = interval;
    this.last = new Map();
    this.pending = new Map();
  }
  push(key, when, apply) {
    const last = this.last.get(key);
    if (last === undefined || when - last >= this.interval) {
      this.last.set(key, when);
      this.pending.delete(key);
      apply(when);
      return;
    }
    const had = this.pending.has(key);
    this.pending.set(key, apply);
    if (!had) {
      this.timer.at(last + this.interval, (t) => {
        const fn = this.pending.get(key);
        this.pending.delete(key);
        if (fn) {
          this.last.set(key, t);
          fn(t);
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Reverb IR (SPEC §3.1 / REVIEW 3.2): per channel independent seeded noise in 7 octave bands, each with its own
// RT60; 30 ms cosine fade-in; 6–10 random early taps 7–60 ms; low shelf −6 dB < 150 Hz; own energy normalisation.
const IR_BANDS = [125, 250, 500, 1000, 2000, 4000, 8000];
const IR_RT = [1.2, 1.1, 1.0, 0.9, 0.8, 0.5, 0.3];
const IR_DAMP_W = [0, 0, 0, 0.25, 0.5, 0.75, 1]; // how strongly `damp` shortens/lengthens each band
export const IR_BUCKETS = [1.5, 2, 2.8, 3.8, 5, 6.5, 8];
const IR_ENERGY = 0.35; // per-channel Σx² (white-noise power gain ≈ −4.6 dB); same for every bucket

/** size 0..1 → RT seconds (size × 9 s), quantised to the nearest bucket in the log domain. */
export function reverbBucket(size) {
  const rt = Math.max(0.01, Number(size) || 0) * 9;
  let best = IR_BUCKETS[0];
  for (const b of IR_BUCKETS) if (Math.abs(Math.log(b / rt)) < Math.abs(Math.log(best / rt))) best = b;
  return best;
}
const dampQ = (d) => Math.round(Math.min(1, Math.max(0, Number(d) || 0)) * 10) / 10;

function biquadCoefs(type, f, sr, q, gainDb = 0) {
  const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const alpha = sw / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'bandpass') {
    b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else {
    // low shelf (RBJ, S = 1)
    const A = Math.pow(10, gainDb / 40);
    const al = (sw / 2) * Math.sqrt(2);
    const sa = 2 * Math.sqrt(A) * al;
    b0 = A * (A + 1 - (A - 1) * cw + sa);
    b1 = 2 * A * (A - 1 - (A + 1) * cw);
    b2 = A * (A + 1 - (A - 1) * cw - sa);
    a0 = A + 1 + (A - 1) * cw + sa;
    a1 = -2 * (A - 1 + (A + 1) * cw);
    a2 = A + 1 + (A - 1) * cw - sa;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

/** One band of the IR noise (band-passed, decaying) over [i0, i1); a plain function so the hot loop optimises. */
function irBandChunk(out, i0, i1, st, next) {
  const { b0, b1, b2, a1, a2, decay } = st;
  let { env, x1, x2, y1, y2 } = st;
  for (let i = i0; i < i1; i++) {
    const x = next() * 2 - 1;
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    out[i] += y * env;
    env *= decay;
  }
  st.env = env; st.x1 = x1; st.x2 = x2; st.y1 = y1; st.y2 = y2;
}

/**
 * The reverb IR DSP as a generator: it yields every 16 k samples so the main-thread fallback can run it in
 * ≤ 4 ms slices (buildIRChannelsAsync). The worker and the synchronous path run it straight through. One
 * implementation → the worker, chunked and synchronous IRs are bit-identical.
 * @returns {Generator<undefined, Float32Array[]>} returns the two normalised channels
 */
function* irGen(sr, next, sizeSec, damp) {
  const rts = IR_RT.map((f, k) => sizeSec * f * (1 + (0.5 - dampQ(damp)) * 0.8 * IR_DAMP_W[k]));
  const len = Math.ceil(1.1 * Math.max(...rts) * sr);
  const chans = [];
  for (let c = 0; c < 2; c++) {
    const out = new Float32Array(len);
    for (let k = 0; k < IR_BANDS.length; k++) {
      const [b0, b1, b2, a1, a2] = biquadCoefs('bandpass', IR_BANDS[k], sr, Math.SQRT2);
      const st = { b0, b1, b2, a1, a2, decay: Math.exp(-6.9 / (rts[k] * sr)) /* −60 dB at rt */, env: 1, x1: 0, x2: 0, y1: 0, y2: 0 };
      for (let i0 = 0; i0 < len; i0 += 16384) {
        irBandChunk(out, i0, Math.min(len, i0 + 16384), st, next);
        yield;
      }
    }
    // 30 ms cosine fade-in
    const fi = Math.floor(0.03 * sr);
    for (let i = 0; i < fi && i < len; i++) out[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fi);
    // early reflections: 6–10 random taps, 7–60 ms, random L/R gain and sign
    let early = 0;
    const ew = Math.min(len, Math.floor(0.08 * sr));
    for (let i = 0; i < ew; i++) early += out[i] * out[i];
    const eRms = Math.sqrt(early / Math.max(1, ew)) || 0.01;
    const taps = 6 + Math.floor(next() * 5);
    for (let t = 0; t < taps; t++) {
      const pos = Math.floor((0.007 + next() * 0.053) * sr);
      if (pos < len) out[pos] += (next() < 0.5 ? -1 : 1) * (1 + next() * 3) * eRms;
    }
    // low shelf −6 dB below 150 Hz
    const [s0, s1, s2, sa1, sa2] = biquadCoefs('lowshelf', 150, sr, 0.707, -6);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < len; i++) {
      const x = out[i];
      const y = s0 * x + s1 * x1 + s2 * x2 - sa1 * y1 - sa2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      out[i] = y;
    }
    chans.push(out);
    yield;
  }
  // own energy normalisation (convolver.normalize = false): every bucket has the same power gain
  let e = 0;
  for (const ch of chans) for (let i = 0; i < ch.length; i++) e += ch[i] * ch[i];
  const g = Math.sqrt((IR_ENERGY * 2) / (e || 1));
  for (const ch of chans) for (let i = 0; i < ch.length; i++) ch[i] *= g;
  return chans;
}

const asNext = (prng) => (typeof prng === 'function' ? prng : () => prng.next());

/** Where IRs were computed (tests/diagnostics): main-thread sync, worker, main-thread chunked fallback. */
export const irStats = { sync: 0, worker: 0, chunked: 0 };

/** The two IR channels, computed synchronously (worker, offline, tests). */
export function buildIRChannels(sr, prng, sizeSec, damp = 0.5) {
  if (!IN_WORKER) irStats.sync++;
  const g = irGen(sr, asNext(prng), sizeSec, damp);
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

function irBuffer(sr, chans) {
  const buf = new AudioBuffer({ numberOfChannels: 2, length: chans[0].length, sampleRate: sr });
  chans.forEach((ch, c) => buf.copyToChannel(ch, c));
  return buf;
}

/**
 * Build a stereo reverb IR synchronously. Pure JS; the engine itself only calls this in an OfflineAudioContext
 * (realtime IRs come from the worker, see buildIRChannelsAsync).
 * @param {BaseAudioContext|{sampleRate:number}} ctx
 * @param {{next:()=>number}|(()=>number)} prng
 * @param {number} sizeSec RT60 at 500 Hz (a bucket value)
 * @param {number} damp 0..1 (0.5 = nominal table; higher = darker/shorter HF)
 * @returns {AudioBuffer}
 */
export function buildIR(ctx, prng, sizeSec, damp = 0.5) {
  return irBuffer(ctx.sampleRate, buildIRChannels(ctx.sampleRate, prng, sizeSec, damp));
}

// IR worker: this very module, loaded as a module Worker (same code → bit-identical IRs). Fallback when a
// worker can't start (or doesn't answer within 8 s): the same generator on the main thread in ≤ 4 ms slices.
const IN_WORKER = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;
let IRW = null; // {worker, pending:Map} | false
let IRW_SEQ = 0;
function irWorker() {
  if (IRW !== null) return IRW;
  try {
    if (typeof Worker === 'undefined') throw new Error('no Worker');
    const worker = new Worker(new URL(import.meta.url), { type: 'module', name: 'reverb-ir' });
    const W = { worker, pending: new Map(), lastHeard: 0 };
    worker.onmessage = (ev) => {
      W.lastHeard = Date.now(); // any message (job started / done) proves the worker is alive
      if (ev.data?.started) return;
      const p = W.pending.get(ev.data?.id);
      if (!p) return;
      W.pending.delete(ev.data.id);
      clearTimeout(p.timer);
      if (ev.data.error) p.fail(new Error(ev.data.error));
      else {
        irStats.worker++;
        p.resolve(ev.data.chans);
      }
    };
    const broken = () => {
      IRW = false;
      for (const p of W.pending.values()) {
        clearTimeout(p.timer);
        p.fail(new Error('IR worker unavailable'));
      }
      W.pending.clear();
      try {
        worker.terminate();
      } catch {}
    };
    worker.onerror = (ev) => {
      ev?.preventDefault?.();
      broken();
    };
    worker.onmessageerror = broken;
    IRW = W;
  } catch {
    IRW = false;
  }
  return IRW;
}

async function irChunked(sr, seed, sizeSec, damp) {
  irStats.chunked++;
  const rng = createRng(seed);
  const g = irGen(sr, () => rng.next(), sizeSec, damp);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let t0 = now();
  let r = g.next();
  while (!r.done) {
    if (now() - t0 > 4) {
      await new Promise((res) => setTimeout(res, 0));
      t0 = now();
    }
    r = g.next();
  }
  return r.value;
}

/**
 * IR channels off the main thread (module Worker), falling back to ≤ 4 ms main-thread slices.
 * @param {number} sr
 * @param {number} seed uint32 (createRng seed)
 * @returns {Promise<Float32Array[]>}
 */
export function buildIRChannelsAsync(sr, seed, sizeSec, damp) {
  const W = irWorker();
  if (!W) return irChunked(sr, seed, sizeSec, damp);
  return new Promise((resolve) => {
    const id = ++IRW_SEQ;
    const fail = () => resolve(irChunked(sr, seed, sizeSec, damp));
    // watchdog: fall back only when the worker has been silent for 10 s (jobs queue behind each other, so a
    // per-request deadline would fire on a busy but healthy worker)
    const entry = { resolve, fail, timer: 0 };
    const arm = () => {
      entry.timer = setTimeout(() => {
        if (!W.pending.has(id)) return;
        if (Date.now() - W.lastHeard < 10000) return arm();
        W.pending.delete(id);
        fail();
      }, 10000);
    };
    W.lastHeard = Math.max(W.lastHeard, Date.now());
    arm();
    W.pending.set(id, entry);
    W.worker.postMessage({ id, sr, seed, sizeSec, damp });
  });
}

if (IN_WORKER) {
  self.onmessage = (ev) => {
    const { id, sr, seed, sizeSec, damp } = ev.data || {};
    self.postMessage({ id, started: true });
    try {
      const rng = createRng(seed);
      const chans = buildIRChannels(sr, () => rng.next(), sizeSec, damp);
      self.postMessage({ id, chans }, chans.map((c) => c.buffer));
    } catch (e) {
      self.postMessage({ id, error: String(e?.message || e) });
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Reverb (REVIEW engine-core #6/#7). input → HPF180 → LPF9k → one "unit" per IR:
//   unit = [predelay A → gain A, predelay B → gain B] → ConvolverNode → out gain → ret → wheel
// Units are kept in a small LRU pool keyed by IR (size bucket | damp | sampleRate), so a song switch to a size
// that was prepared or preloaded costs no IR math and no `convolver.buffer =` on the switch path.
//  * IR arrays are computed in a module Worker (buildIRChannelsAsync); only OfflineAudioContext renders (and
//    the engine-start fallback) build synchronously. prepare() awaits stage(); commit never builds anything.
//  * IR change: equal-power crossfade (0.8 s) between two units; the incoming unit's predelay is set while it
//    is still disconnected (silent), so the new predelay rides the crossfade.
//  * Predelay change on the same IR: the unit's idle predelay line is set (its gain is 0) and the two lines
//    crossfade over 0.5 s. No DelayNode.delayTime is ever ramped on a live input → no pitch warp.
const IR_CACHE_MAX = 12;
/** Resolves in an idle period with ≥ `ms` to spare (or after `maxWait` ms regardless): one per convolver buffer set. */
function idlePeriod(ms, maxWait = 5000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const ask = () =>
      requestIdleCallback(
        (dl) => {
          if (dl.didTimeout || dl.timeRemaining() >= ms || Date.now() - t0 > maxWait) resolve();
          else ask();
        },
        { timeout: Math.max(1, maxWait - (Date.now() - t0)) },
      );
    ask();
  });
}
const REVERB_UNITS_MAX = 10;
const clampPd = (v) => Math.min(0.5, Math.max(0, Number(v) || 0));

class Reverb {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env; // {seed, timer, irCache, offline}
    this.input = new GainNode(ctx);
    this.hpf = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 180, Q: BUTTER2_Q });
    this.lpf = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 9000, Q: BUTTER2_Q });
    this.ret = new GainNode(ctx, { gain: 1 }); // fx.reverb.returnGain
    this.wheel = new GainNode(ctx, { gain: 1 }); // wheel/macro multiplier on the return
    this.output = this.wheel;
    this.input.connect(this.hpf).connect(this.lpf);
    this.ret.connect(this.wheel);
    this.units = new Map(); // key -> unit (LRU order)
    this.active = null;
    this.size = 0.5;
    this.damp = 0.5;
    this.predelayV = 0.02;
    this.fade = 0.8;
    this.pdFade = 0.5;
    this._reqSeq = 0;
    this._target = null; // IR key the reverb is at or heading to (commitTo / request); null → the active unit's
    this._inflight = new Map(); // key -> {p: Promise<unit>, hurry}
    this._keep = new Set(); // staged keys (never evicted before their commit)
    this._disposed = false;
    // debug stat (leak checks compare engines): static nodes + two units' worth, independent of the pool size
    this.nodeCount = 5 + 2 * 6;
  }

  irKey(size, damp) {
    return `${reverbBucket(size)}|${dampQ(damp)}|${this.ctx.sampleRate}`;
  }
  /** The IR key the reverb is at, or will be at once a pending commit/request has landed (round2-engine M2). */
  get targetKey() {
    return this._target ?? this.active?.key ?? null;
  }
  _seedFor(key) {
    return hashSeed(`${this.env.seed >>> 0}|ir|${key}`);
  }
  _cachedIR(key) {
    const cache = this.env.irCache;
    const ir = cache.get(key);
    if (ir) {
      cache.delete(key);
      cache.set(key, ir);
    }
    return ir || null;
  }
  _storeIR(key, ir) {
    const cache = this.env.irCache;
    cache.set(key, ir);
    while (cache.size > IR_CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  /** Synchronous IR (offline renders / tests only; realtime code paths use irAsync). */
  getIR(size, damp) {
    const key = this.irKey(size, damp);
    let ir = this._cachedIR(key);
    if (!ir) {
      ir = buildIR(this.ctx, createRng(this._seedFor(key)), reverbBucket(size), damp);
      this._storeIR(key, ir);
    }
    return { key, ir };
  }

  /** IR off the main thread (worker); resolves from the cache when possible. */
  async irAsync(size, damp) {
    const key = this.irKey(size, damp);
    const hit = this._cachedIR(key);
    if (hit) return { key, ir: hit };
    const sr = this.ctx.sampleRate;
    const chans = await buildIRChannelsAsync(sr, this._seedFor(key), reverbBucket(size), damp);
    let ir = this._cachedIR(key);
    if (!ir) {
      ir = irBuffer(sr, chans);
      this._storeIR(key, ir);
    }
    return { key, ir };
  }

  /** The only place a ConvolverNode gets its buffer. */
  _newUnit(key, ir) {
    const ctx = this.ctx;
    const pd = [0, 1].map(() => new DelayNode(ctx, { maxDelayTime: 0.5, delayTime: this.predelayV }));
    const pg = [new GainNode(ctx, { gain: 1 }), new GainNode(ctx, { gain: 0 })];
    const conv = new ConvolverNode(ctx, { disableNormalization: true });
    conv.buffer = ir;
    const out = new GainNode(ctx, { gain: 0 });
    pd.forEach((d, i) => d.connect(pg[i]).connect(conv));
    conv.connect(out).connect(this.ret);
    const u = { key, pd, pg, conv, out, cur: 0, pdV: [this.predelayV, this.predelayV], pdBusyUntil: 0, state: 'idle', idleAt: 0, connected: false };
    this.units.set(key, u);
    this._evict();
    return u;
  }
  _touch(u) {
    this.units.delete(u.key);
    this.units.set(u.key, u);
  }
  _evict() {
    if (this.units.size <= REVERB_UNITS_MAX) return;
    for (const u of [...this.units.values()]) {
      if (this.units.size <= REVERB_UNITS_MAX) break;
      if (u === this.active || u.state !== 'idle' || u.connected || this._keep.has(u.key)) continue;
      this.units.delete(u.key);
      for (const n of [...u.pd, ...u.pg, u.conv, u.out]) {
        try {
          n.disconnect();
        } catch {}
      }
    }
  }

  /** Synchronous unit (offline, or already pooled). */
  _unitSync(size, damp) {
    const key = this.irKey(size, damp);
    let u = this.units.get(key);
    if (!u) u = this._newUnit(key, this.getIR(size, damp).ir);
    else this._touch(u);
    return u;
  }

  /**
   * Unit via the worker. `idle` (ms): set the convolver buffer (Chromium does its FFT partitioning synchronously on
   * the main thread) in an idle period, waiting at most `idle` ms for one. prepare() doesn't wait (it resolves as
   * soon as the unit exists); preload warming and live size edits do.
   */
  _unitAsync(size, damp, { idle = 0 } = {}) {
    const key = this.irKey(size, damp);
    const have = this.units.get(key);
    if (have) {
      this._touch(have);
      return Promise.resolve(have);
    }
    const running = this._inflight.get(key);
    if (running) {
      if (!(idle > 0)) running.hurry(); // prepare needs it now: stop waiting for an idle period
      return running.p;
    }
    let hurry = () => {};
    const hurried = new Promise((r) => (hurry = r));
    const p = (async () => {
      const { ir } = await this.irAsync(size, damp);
      if (idle > 0 && !this.env.offline && typeof requestIdleCallback === 'function') await Promise.race([idlePeriod(40, idle), hurried]);
      if (this._disposed) return null;
      return this.units.get(key) || this._newUnit(key, ir);
    })().finally(() => this._inflight.delete(key));
    this._inflight.set(key, { p, hurry });
    return p;
  }

  /** Resolves when every unit being built (worker IR + idle-time buffer set) exists. */
  settled() {
    return Promise.all([...this._inflight.values()].map((x) => x.p.catch(() => null)));
  }

  /** Engine start: the first IR (worker; offline builds synchronously). */
  async init(size, damp) {
    const u = this.env.offline ? this._unitSync(size, damp) : await this._unitAsync(size, damp);
    if (!u || this._disposed) return;
    this.size = size;
    this.damp = damp;
    if (this.active) return; // a commit already activated something
    this._setUnitPd(u, this.predelayV);
    this._connect(u);
    setNow(u.out.gain, 1, 0);
    u.state = 'active';
    this.active = u;
  }

  _connect(u) {
    if (u.connected) return;
    for (const d of u.pd) this.lpf.connect(d);
    u.connected = true;
  }
  _disconnect(u) {
    if (!u.connected) return;
    for (const d of u.pd) {
      try {
        this.lpf.disconnect(d);
      } catch {}
    }
    u.connected = false;
  }
  /** Predelay on a unit that is silent (disconnected): immediate, line A carries it. */
  _setUnitPd(u, p) {
    const now = this.ctx.currentTime;
    u.cur = 0;
    u.pdV = [p, p];
    for (const d of u.pd) setNow(d.delayTime, p, now);
    setNow(u.pg[0].gain, 1, now);
    setNow(u.pg[1].gain, 0, now);
    u.pdBusyUntil = 0;
    u.pdPending = null;
  }

  /**
   * prepare-phase: make sure a unit (IR + convolver buffer) exists for (size, damp). Resolves when ready.
   * @returns {Promise<{key, size, damp}>}
   */
  async stage(size, damp) {
    const key = this.irKey(size, damp);
    this._keep = new Set([key]);
    if (!(this.active && this.active.key === key)) {
      if (this.env.offline) this._unitSync(size, damp);
      else await this._unitAsync(size, damp);
    }
    return { key, size, damp };
  }

  /** Preload: warm a unit in idle time (realtime only; never blocks). */
  warm(size, damp) {
    if (this.env.offline) return Promise.resolve(null);
    return this._unitAsync(size, damp, { idle: 5000 }).catch(() => null);
  }

  /** commit-phase: switch to a staged IR and/or predelay. Cheap: gains and connections only. */
  commitTo(stage, predelay, when) {
    this.predelayV = clampPd(predelay);
    if (stage) {
      this._target = stage.key;
      ++this._reqSeq; // a live request still in its debounce belongs to the previous song: drop it
    }
    if (!stage || (this.active && stage.key === this.active.key)) {
      if (stage) {
        this.size = stage.size;
        this.damp = stage.damp;
      }
      this._pdTo(this.active, this.predelayV, when);
      return;
    }
    const u = this.units.get(stage.key);
    if (!u) {
      // evicted between prepare and commit (should not happen): the async path swaps when it's ready
      this.request(stage.size, stage.damp, when - 0.3);
      return;
    }
    this._swapUnit(u, stage, when, ++this._reqSeq);
  }
  /** Back-compat alias used by older call sites: IR only, current predelay. */
  swapTo(stage, when) {
    this.commitTo(stage, this.predelayV, when);
  }

  _swapUnit(u, st, when, seq) {
    if (u === this.active) {
      this._pdTo(u, this.predelayV, when);
      return;
    }
    if (u.state === 'fading' && u.idleAt > when) {
      // the unit we want is still fading out from a previous switch: swap as soon as it is idle
      this.env.timer.at(u.idleAt + 0.001, (tt) => {
        if (seq === this._reqSeq) this._swapUnit(u, st, tt, seq);
      });
      return;
    }
    this._setUnitPd(u, this.predelayV); // u is disconnected → silent
    this._connect(u);
    u.state = 'active';
    equalPowerFade(u.out.gain, 0, 1, when, this.fade);
    const out = this.active;
    if (out) {
      out.state = 'fading';
      out.idleAt = when + this.fade + 0.05;
      equalPowerFade(out.out.gain, 1, 0, when, this.fade);
      // disconnect the silent convolver's input after the fade (REVIEW 1.15)
      this.env.timer.at(out.idleAt, () => {
        if (out !== this.active && out.state === 'fading') {
          this._disconnect(out);
          out.state = 'idle';
          this._evict();
        }
      });
    }
    this.active = u;
    this._touch(u);
    this.size = st.size;
    this.damp = st.damp;
  }

  /** Predelay change on a live unit: crossfade to its idle predelay line (no delayTime ramp on live input). */
  _pdTo(u, p, when) {
    if (!u) return;
    if (!u.connected) {
      this._setUnitPd(u, p);
      return;
    }
    if (Math.abs(u.pdV[u.cur] - p) < 1e-6 && !(u.pdBusyUntil > when)) return;
    if (u.pdBusyUntil > when) {
      // a predelay crossfade is still running: apply the latest value once it has finished
      const first = u.pdPending == null;
      u.pdPending = p;
      if (first) {
        this.env.timer.at(u.pdBusyUntil, (tt) => {
          const q = u.pdPending;
          u.pdPending = null;
          if (q != null && u === this.active) this._pdTo(u, q, tt);
        });
      }
      return;
    }
    if (Math.abs(u.pdV[u.cur] - p) < 1e-6) return;
    const nx = 1 - u.cur;
    setNow(u.pd[nx].delayTime, p, when); // that line's gain is 0 at `when`
    u.pdV[nx] = p;
    equalPowerFade(u.pg[u.cur].gain, 1, 0, when, this.pdFade);
    equalPowerFade(u.pg[nx].gain, 0, 1, when, this.pdFade);
    u.cur = nx;
    u.pdBusyUntil = when + this.pdFade + 0.005;
  }

  /** Live size/damp edit (knob, macro.wash): debounced 300 ms (event time), then an off-thread unit + swap. */
  request(size, damp, when) {
    const seq = ++this._reqSeq;
    this._target = this.irKey(size, damp);
    this.env.timer.at(when + 0.3, (tt) => {
      if (seq !== this._reqSeq) return;
      const key = this.irKey(size, damp);
      if (this.active && this.active.key === key) {
        this.size = size;
        this.damp = damp;
        return;
      }
      const st = { key, size, damp };
      if (this.env.offline || this.units.has(key)) {
        this._swapUnit(this._unitSync(size, damp), st, tt, seq);
        return;
      }
      this._unitAsync(size, damp, { idle: 1000 }).then(
        (u) => {
          if (u && seq === this._reqSeq && !this._disposed) this._swapUnit(u, st, this.ctx.currentTime, seq);
        },
        () => {},
      );
    });
  }

  /** Live predelay edit (after the engine's coalescer). */
  setPredelay(v, when) {
    this.predelayV = clampPd(v);
    this._pdTo(this.active, this.predelayV, when);
  }

  dispose() {
    this._disposed = true;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Delay: two lines (each a stereo pair with a feedback matrix so ping-pong is just gains), tone LPF in the loop,
// feedback ≤ .9. Time changes > 5 % crossfade to the other line (no pitch-warped tails, REVIEW 1.14).
// Chromium renders a feedback cycle one render quantum (128 frames) late per pass, and with two DelayNodes in
// crossing cycles (the old dL/dR pair) the quantum lands on *some* edges only (measured: plain echo k at
// 375·k + 2.9·(k−1) ms; ping-pong L3 2.9 ms early vs R2). So a line is ONE stereo DelayNode in ONE cycle
// (d → tone LPF → split → 4 feedback gains → merge → d), whose delayTime is `time − Q`, behind a fixed Q pre-delay:
// echo 1 = Q + (time − Q), every further pass (time − Q) + Q → echoes exactly `time` apart in both modes (engine-3).
class DelayLine {
  constructor(ctx, input, output) {
    this.ctx = ctx;
    const n = (o) => new GainNode(ctx, o);
    const mono = { channelCount: 1, channelCountMode: 'explicit' };
    this.q = 128 / ctx.sampleRate;
    this.gate = n({ gain: 0 }); // input gate (per line)
    this.pre = new DelayNode(ctx, { maxDelayTime: 0.02, delayTime: this.q });
    this.split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    this.inLL = n({ gain: 1, ...mono });
    this.inRR = n({ gain: 1, ...mono });
    this.inRL = n({ gain: 0, ...mono });
    this.mergeIn = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    this.d = new DelayNode(ctx, { maxDelayTime: 2, delayTime: 0.375 - this.q, channelCount: 2, channelCountMode: 'explicit' });
    this.lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 5000, Q: BUTTER2_Q, channelCount: 2, channelCountMode: 'explicit' });
    this.splitFb = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    this.fbLL = n({ gain: 0, ...mono });
    this.fbRR = n({ gain: 0, ...mono });
    this.fbLR = n({ gain: 0, ...mono });
    this.fbRL = n({ gain: 0, ...mono });
    this.mergeFb = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    this.out = n({ gain: 0 });
    input.connect(this.gate).connect(this.pre).connect(this.split);
    this.split.connect(this.inLL, 0).connect(this.mergeIn, 0, 0);
    this.split.connect(this.inRL, 1).connect(this.mergeIn, 0, 0);
    this.split.connect(this.inRR, 1).connect(this.mergeIn, 0, 1);
    this.mergeIn.connect(this.d);
    this.d.connect(this.lp).connect(this.splitFb);
    this.splitFb.connect(this.fbLL, 0).connect(this.mergeFb, 0, 0);
    this.splitFb.connect(this.fbRL, 1).connect(this.mergeFb, 0, 0);
    this.splitFb.connect(this.fbRR, 1).connect(this.mergeFb, 0, 1);
    this.splitFb.connect(this.fbLR, 0).connect(this.mergeFb, 0, 1);
    this.mergeFb.connect(this.d);
    this.lp.connect(this.out).connect(output);
    // (Butterworth tone LPF: no resonant peak, which would build up on every repeat)
    this.time = 0.375;
    this.state = 'idle';
    this.idleAt = 0;
    this.nodeCount = 17;
  }
  setFeedback(fb, pingpong, when, tc = TAU) {
    const f = Math.min(0.9, Math.max(0, fb));
    rampTo(this.fbLL.gain, pingpong ? 0 : f, when, tc);
    rampTo(this.fbRR.gain, pingpong ? 0 : f, when, tc);
    rampTo(this.fbLR.gain, pingpong ? f : 0, when, tc);
    rampTo(this.fbRL.gain, pingpong ? f : 0, when, tc);
  }
  setPingpong(pp, when) {
    // ping-pong: mono sum into the left line, cross feedback bounces L↔R
    rampTo(this.inLL.gain, pp ? 0.5 : 1, when, TAU);
    rampTo(this.inRL.gain, pp ? 0.5 : 0, when, TAU);
    rampTo(this.inRR.gain, pp ? 0 : 1, when, TAU);
  }
  setTone(hz, when) {
    rampTo(this.lp.frequency, hz, when, TAU);
  }
  setTimeNow(t, when) {
    this.time = t;
    this._tg = { t0: when, dur: 0, from: t, to: t };
    setNow(this.d.delayTime, t - this.q, when);
  }
  _timeAt(when) {
    const g = this._tg;
    if (!g) return this.time;
    if (!(g.dur > 0) || when >= g.t0 + g.dur) return g.to;
    if (when <= g.t0) return g.from;
    return g.from + ((g.to - g.from) * (when - g.t0)) / g.dur;
  }
  /** Small (≤ 5 %) time change: linear glide slow enough that the echoes shift by ≤ 5 % in pitch (REVIEW #20). */
  glideTime(t, when) {
    const from = this._timeAt(when);
    this.time = t;
    const dur = Math.max(0.5, 20 * Math.abs(t - from));
    this._tg = { t0: when, dur, from, to: t };
    linFrom(this.d.delayTime, from - this.q, t - this.q, when, dur);
  }
}

class Delay {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.input = new GainNode(ctx);
    this.ret = new GainNode(ctx, { gain: 1 });
    this.output = this.ret;
    this.lines = [new DelayLine(ctx, this.input, this.ret), new DelayLine(ctx, this.input, this.ret)];
    this.active = this.lines[0];
    setNow(this.active.gate.gain, 1, 0);
    setNow(this.active.out.gain, 1, 0);
    this.active.state = 'active';
    this.p = { time: 0.375, feedback: 0.35, pingpong: false, tone: 0.5, sync: 'off', returnGain: 1 };
    this.tempo = null;
    this.fbScale = 1; // panic
    this.washFb = null; // macro.wash override target
    this._pendingSwitch = null;
    this.nodeCount = 2 + 2 * 17;
  }
  effectiveTime() {
    const s = this.p.sync;
    if (s && s !== 'off' && this.tempo > 0) {
      const beat = 60 / this.tempo;
      const mult = s === '1/4' ? 1 : s === '1/8d' ? 0.75 : 0.5;
      return Math.min(1.9, Math.max(0.02, beat * mult));
    }
    return Math.min(1.9, Math.max(0.02, this.p.time));
  }
  effectiveFb() {
    const fb = this.washFb ?? this.p.feedback;
    return Math.min(0.9, Math.max(0, fb));
  }
  toneHz() {
    return 1200 * Math.pow(10, Math.min(1, Math.max(0, this.p.tone))); // 1.2 k → 12 k
  }
  applyAll(when) {
    for (const l of this.lines) {
      l.setPingpong(this.p.pingpong, when);
      l.setTone(this.toneHz(), when);
    }
    this.active.setFeedback(this.effectiveFb(), this.p.pingpong, when);
    rampTo(this.ret.gain, this.p.returnGain, when, TAU);
    this.updateTime(when);
  }
  updateTime(when) {
    const t = this.effectiveTime();
    const cur = this.active.time;
    if (Math.abs(t - cur) / cur <= 0.05) {
      if (t !== cur) this.active.glideTime(t, when);
      return;
    }
    this._switchTo(t, when);
  }
  _switchTo(t, when) {
    const other = this.lines.find((l) => l !== this.active);
    const ready = other.state === 'idle' && other.idleAt <= when;
    if (!ready) {
      // flush the other line (fast fade, zero feedback, wait one delay period so its buffer is empty), then retry
      if (other.state !== 'flushing') {
        other.state = 'flushing';
        rampTo(other.out.gain, 0, when, 0.006);
        rampTo(other.gate.gain, 0, when, 0.003);
        other.setFeedback(0, this.p.pingpong, when, 0.005);
        other.idleAt = when + other.time + 0.06;
      }
      this._pendingSwitch = t;
      const seq = (this._switchSeq = (this._switchSeq || 0) + 1);
      this.env.timer.at(other.idleAt, (tt) => {
        if (seq !== this._switchSeq) return;
        other.state = 'idle';
        this._switchTo(this.effectiveTime(), tt);
      });
      return;
    }
    const old = this.active;
    other.setTimeNow(t, when);
    other.setFeedback(this.effectiveFb() * this.fbScale, this.p.pingpong, when, 0.005);
    rampTo(other.gate.gain, 1, when, 0.005);
    setNow(other.out.gain, 1, when);
    other.state = 'active';
    this.active = other;
    // old line: close its input, let its echoes ring out with their original time, then retire it
    rampTo(old.gate.gain, 0, when, 0.005);
    const fb = Math.max(0.01, this.effectiveFb());
    const tail = Math.min(8, old.time * Math.ceil(Math.log(0.001) / Math.log(fb)) + 0.1);
    old.state = 'ringing';
    old.idleAt = when + tail;
    const seq = (old._seq = (old._seq || 0) + 1);
    this.env.timer.at(when + tail, (tt) => {
      if (old._seq !== seq || old === this.active) return;
      rampTo(old.out.gain, 0, tt, 0.01);
      old.setFeedback(0, this.p.pingpong, tt, 0.01);
      old.state = 'flushing';
      old.idleAt = tt + old.time + 0.1;
      this.env.timer.at(old.idleAt, () => {
        if (old._seq === seq && old !== this.active) old.state = 'idle';
      });
    });
  }
  /**
   * Panic: feedback → 0, then restore (pure automation, no timer). SPEC says 200 ms; we hold it for
   * max(200 ms, one delay period + 50 ms) so the echoes already in the line cannot re-enter the loop.
   */
  panic(when) {
    const hold = Math.max(0.2, Math.max(...this.lines.map((l) => l.time)) + 0.05);
    for (const l of this.lines) {
      const target = l === this.active ? this.effectiveFb() : 0;
      l.setFeedback(0, this.p.pingpong, when, 0.005);
      if (target > 0) {
        for (const g of [l.fbLL, l.fbRR, l.fbLR, l.fbRL]) {
          const pp = this.p.pingpong;
          const v = g === l.fbLL || g === l.fbRR ? (pp ? 0 : target) : pp ? target : 0;
          rampTo(g.gain, v, when + hold, 0.02);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Chorus: 2 voices, 7 ms base, ±2 ms × depth, rate .15–1.5 Hz, voices 90° apart, L/R.
class Chorus {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.input = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit' });
    this.ret = new GainNode(ctx, { gain: 1 });
    this.output = this.ret;
    this.merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    this.merge.connect(this.ret);
    const rng = rngFor(env.seed, 'chorus');
    const phase0 = rng.next() * Math.PI * 2;
    this.voices = [0, 1].map((i) => {
      const d = new DelayNode(ctx, { maxDelayTime: 0.05, delayTime: 0.007 });
      const ph = phase0 + (i * Math.PI) / 2;
      // sine LFO with an explicit start phase: sin(ωt+φ) = sinφ·cos(ωt) + cosφ·sin(ωt)
      const wave = new PeriodicWave(ctx, { real: [0, Math.sin(ph)], imag: [0, Math.cos(ph)], disableNormalization: true });
      const lfo = new OscillatorNode(ctx, { frequency: 0.4, periodicWave: wave });
      const depth = new GainNode(ctx, { gain: 0.001 });
      lfo.connect(depth).connect(d.delayTime);
      this.input.connect(d).connect(this.merge, 0, i);
      lfo.start(0);
      return { d, lfo, depth };
    });
    this.nodeCount = 3 + 6;
  }
  setRate(hz, when) {
    const r = Math.min(1.5, Math.max(0.15, hz));
    this.voices.forEach((v, i) => rampTo(v.lfo.frequency, r * (i ? 1.07 : 1), when, 0.05));
  }
  setDepth(x, when) {
    this.voices.forEach((v) => rampTo(v.depth.gain, 0.002 * Math.min(1, Math.max(0, x)), when, 0.05));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Lofi (after reverb, before master; REVIEW 3.9). amount 0 ⇒ wet chain disconnected (bit-exact bypass).
// The wet chain runs at −12 dB (LOFI_PRE) so the WaveShapers (which clamp input to ±1) have 12 dB of headroom;
// the curves are drawn in the scaled domain (same character up to +12 dBFS) and LOFI_MAKEUP restores the level.
const LOFI_PRE = 0.25;
function tanhCurve(driveDb, n = 4096, pre = LOFI_PRE) {
  // tanh(g·x)/g: unity small-signal gain, peaks saturate; g = drive (0 → +9 dB)
  const c = new Float32Array(n);
  const g = Math.pow(10, driveDb / 20);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) / pre;
    c[i] = (driveDb <= 0.01 ? x : Math.tanh(g * x) / g) * pre;
  }
  return c;
}
function quantCurve(bits, n = 32768, pre = LOFI_PRE) {
  const c = new Float32Array(n);
  const steps = Math.pow(2, bits - 1);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) / pre;
    c[i] = (Math.round(x * steps) / steps) * pre;
  }
  return c;
}

const CURVES = new Map(); // shared lofi curves (a few dozen keys at most)

class Lofi {
  constructor(ctx, env, input, output) {
    this.ctx = ctx;
    this.env = env;
    this.input = input;
    this.dry = new GainNode(ctx, { gain: 1 });
    this.output = output;
    input.connect(this.dry).connect(output);
    // wet chain (built once; connected only while engaged)
    this.wetIn = new GainNode(ctx, { gain: LOFI_PRE });
    this.drive = new GainNode(ctx, { gain: 1 });
    this.sat = new WaveShaperNode(ctx, { oversample: '4x' });
    this.quant = new WaveShaperNode(ctx, { oversample: 'none' });
    this.tape = new DelayNode(ctx, { maxDelayTime: 1.0, delayTime: 0.005 });
    this.wowLfo = new OscillatorNode(ctx, { frequency: 0.35 });
    this.wowDepth = new GainNode(ctx, { gain: 0 });
    this.flutLfo = new OscillatorNode(ctx, { frequency: 5 });
    this.flutDepth = new GainNode(ctx, { gain: 0 });
    this.lpf = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 18000, Q: BUTTER2_Q });
    this.hpf = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 20, Q: BUTTER2_Q });
    this.crackleBpf = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 2500, Q: 0.8 });
    this.crackleGain = new GainNode(ctx, { gain: 0 });
    this.makeup = new GainNode(ctx, { gain: 1 / LOFI_PRE });
    this.wet = new GainNode(ctx, { gain: 0 });
    this.wetIn.connect(this.drive).connect(this.sat).connect(this.quant).connect(this.tape).connect(this.hpf).connect(this.lpf).connect(this.makeup).connect(this.wet);
    this.crackleBpf.connect(this.crackleGain).connect(this.wet);
    // wet-path latency: tape delay (5 ms base + up to 2 ms wow) + the 4x oversampler (~192 frames) + one quantum.
    // The dry→wet crossfade starts after it, so the wet onset (a step) happens while the wet gain is still 0.
    this.engageDelay = 0.0075 + 320 / ctx.sampleRate;
    this.wowLfo.connect(this.wowDepth).connect(this.tape.delayTime);
    this.flutLfo.connect(this.flutDepth).connect(this.tape.delayTime);
    this.wowLfo.start(0);
    this.flutLfo.start(0);
    // crackle: sparse random impulses in a 6 s seeded loop
    const rng = rngFor(env.seed, 'crackle');
    const sr = ctx.sampleRate;
    const cb = new AudioBuffer({ numberOfChannels: 2, length: Math.floor(sr * 6), sampleRate: sr });
    for (let c = 0; c < 2; c++) {
      const d = new Float32Array(cb.length);
      const n = 60 + Math.floor(rng.next() * 30);
      for (let i = 0; i < n; i++) {
        const p = Math.floor(rng.next() * (d.length - 8));
        const a = (0.3 + rng.next() * 0.7) * (rng.next() < 0.5 ? -1 : 1);
        for (let j = 0; j < 6; j++) d[p + j] += a * Math.exp(-j * 0.8);
      }
      cb.copyToChannel(d, c);
    }
    this.crackleBuf = cb;
    this.crackleSrc = null;
    this.p = { amount: 0, wow: 0.5, flutter: 0.5, crackle: 0.3, bits: 0.5, tone: 0.5, saturation: 0.5 };
    this.engaged = false;
    this._xf = { t0: 0, dur: 0, from: 1, to: 1 }; // last dry-gain crossfade (wet = 1 − dry)
    this.holds = new Set(); // e.g. 'tape' bend mode keeps the wet chain engaged at amount 0
    this._seq = 0;
    this._satKey = null;
    this._bitsKey = null;
    this.tapeActive = false;
    this.nodeCount = 16;
  }
  _dryAt(t) {
    const x = this._xf;
    if (t <= x.t0) return x.from;
    if (!(x.dur > 0) || t >= x.t0 + x.dur) return x.to;
    return x.from + ((x.to - x.from) * (t - x.t0)) / x.dur;
  }
  get _dryV() {
    return this._xf.to;
  }
  static _keys(p) {
    const a = p.amount;
    const driveDb = 9 * Math.min(1, a * 2 * p.saturation);
    // bits 16 → 11 (never below 10) scaled by amount × bits
    return { dk: Math.round(driveDb * 4) / 4, bits: Math.max(10, Math.round(16 - 5 * Math.min(1, a * (0.5 + p.bits)))) };
  }
  static _curve(kind, key) {
    const k = `${kind}|${key}`;
    let c = CURVES.get(k);
    if (!c) {
      c = kind === 't' ? tanhCurve(key) : quantCurve(key);
      CURVES.set(k, c);
    }
    return c;
  }
  /** prepare-phase: compute (cache) the curves a lofi setting will need, so commit only assigns them. */
  warmCurves(p) {
    const { dk, bits } = Lofi._keys({ ...this.p, ...(p || {}) });
    Lofi._curve('t', dk);
    if (bits < 16) Lofi._curve('q', bits);
  }
  _updateCurves() {
    const { dk, bits } = Lofi._keys(this.p);
    if (dk !== this._satKey) {
      this.sat.curve = Lofi._curve('t', dk);
      this._satKey = dk;
    }
    if (bits !== this._bitsKey) {
      this.quant.curve = bits >= 16 ? null : Lofi._curve('q', bits);
      this._bitsKey = bits;
    }
  }
  apply(when) {
    const a = this.p.amount;
    this._updateCurves();
    if (!this.tapeActive) {
      rampTo(this.wowDepth.gain, 0.002 * a * this.p.wow, when, 0.05);
      rampTo(this.flutDepth.gain, 0.00003 * a * this.p.flutter, when, 0.05);
      const lpHz = 18000 * Math.pow(3500 / 18000, a * (0.4 + 0.6 * (1 - this.p.tone)));
      rampTo(this.lpf.frequency, lpHz, when, TAU);
    }
    const hpHz = 20 * Math.pow(6, a * (0.5 + 0.5 * (1 - this.p.tone)));
    rampTo(this.hpf.frequency, hpHz, when, TAU);
    const crDb = -60 + 22 * Math.min(1, this.p.crackle);
    rampTo(this.crackleGain.gain, a > 0 && this.p.crackle > 0 ? Math.pow(10, crDb / 20) * Math.min(1, a * 1.5) * 4 : 0, when, 0.05);
    this._engage(a > 0 || this.holds.size > 0, when);
  }
  _engage(on, when) {
    if (on === this.engaged) return;
    this.engaged = on;
    const seq = ++this._seq;
    if (on) {
      if (!this._wetConnected) {
        this.input.connect(this.wetIn);
        this.wet.connect(this.output);
        this._wetConnected = true;
      }
      if (!this.crackleSrc) {
        this.crackleSrc = new AudioBufferSourceNode(this.ctx, { buffer: this.crackleBuf, loop: true });
        this.crackleSrc.connect(this.crackleBpf);
        this.crackleSrc.start(when);
      }
      // 30 ms crossfade (linear: dry and wet are correlated), started after the wet path's latency
      const w = when + this.engageDelay;
      const from = this._dryAt(w);
      linFrom(this.dry.gain, from, 0, w, 0.03);
      linFrom(this.wet.gain, 1 - from, 1, w, 0.03);
      this._xf = { t0: w, dur: 0.03, from, to: 0 };
    } else {
      const from = this._dryAt(when);
      linFrom(this.dry.gain, from, 1, when, 0.03); // linear ramp ends exactly at 1.0 → bit-exact afterwards
      linFrom(this.wet.gain, 1 - from, 0, when, 0.03);
      this._xf = { t0: when, dur: 0.03, from, to: 1 };
      this.env.timer.at(when + 0.04, () => {
        if (seq !== this._seq || this.engaged) return;
        try {
          this.input.disconnect(this.wetIn);
        } catch {}
        try {
          this.wet.disconnect(this.output);
        } catch {}
        this._wetConnected = false;
        if (this.crackleSrc) {
          const s = this.crackleSrc;
          this.crackleSrc = null;
          s.onended = () => s.disconnect();
          s.stop();
        }
      });
    }
  }
  hold(name, on, when) {
    if (on) this.holds.add(name);
    else this.holds.delete(name);
    this._engage(this.p.amount > 0 || this.holds.size > 0, when);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Soft ceiling: linear below the knee, tanh above, asymptote −0.3 dBFS. Pre-gain .5 maps ±2 into the curve domain.
function clipCurve(n = 16384) {
  const c = new Float32Array(n);
  const ceil = Math.pow(10, -0.3 / 20);
  const k = 0.5;
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 2;
    const ax = Math.abs(x);
    const y = ax < k ? ax : k + (ceil - k) * Math.tanh((ax - k) / (ceil - k));
    c[i] = Math.sign(x) * y;
  }
  return c;
}

let MAKEUP_P = null;
/**
 * Chromium's DynamicsCompressor applies an automatic makeup gain ((1/fullRangeGain)^0.6, ≈ +1.1 dB for the
 * catcher settings). Measured once with a tiny offline render (−30 dBFS sine, far below the threshold).
 * @returns {Promise<number>} linear makeup factor (1 when it can't be measured)
 */
export function measureCompMakeup() {
  if (!MAKEUP_P) {
    MAKEUP_P = (async () => {
      try {
        const sr = 44100;
        const n = Math.round(sr * 0.5); // the compressor's gain settles within ~0.3 s
        const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: n, sampleRate: sr });
        const o = new OscillatorNode(ctx, { frequency: 1000 });
        const g = new GainNode(ctx, { gain: Math.pow(10, -30 / 20) });
        const comp = new DynamicsCompressorNode(ctx, { threshold: -3, knee: 3, ratio: 12, attack: 0.003, release: 0.25 });
        o.connect(g).connect(comp).connect(ctx.destination);
        o.start(0);
        const d = (await ctx.startRendering()).getChannelData(0);
        let s = 0;
        for (let i = n - 4410; i < n; i++) s += d[i] * d[i]; // last 100 ms
        const outRms = Math.sqrt(s / 4410);
        const inRms = Math.pow(10, -30 / 20) / Math.SQRT2;
        const m = outRms / inRms;
        return m > 0.5 && m < 2 ? m : 1;
      } catch {
        return 1;
      }
    })();
  }
  return MAKEUP_P;
}

// ---------------------------------------------------------------------------------------------------------------
// Slot EQ (design/eq/DECISION.md §3, overridden by design/eq/AMENDMENT.md §2/§5: WING-style variable bands).
//
//   input (wOut) → [lowCut] → [b1 … b8 that are on] → [highCut] → sideGain → output (pan)
//
// Only engaged filters are wired, so a slot costs what it uses (bench, 4 slots × 30 s stereo noise @ 48 kHz: a
// GainNode ≈ 4 ms, a static biquad ≈ 27 ms; a dry/wet pair per band would cost 30 GainNodes per slot, ≈ 4 biquads).
// Two ways a change reaches the audio, both click-free:
//   • in place: Hz glides, Q and gain ramp (TAU), every biquad param k-rate (DECISION §3: ramping a-rate coefficients
//     cost 5×). A band switched off, or to 'off', within the peak/shelf family ramps to 0 dB and stays in place: a
//     0 dB peaking/shelving biquad is bit-exact identity. A type change within that family fades the band to 0 dB
//     over 30 ms, swaps the type at identity, fades back in (AMENDMENT §2).
//   • chain switch: the set of wired filters must change (a band added, a cut engaged or bypassed, a notch/cut type
//     switched): a second chain with the new set is wired beside the live one, warms up muted for EQ_WARM (its
//     biquads start from zero state), then a linear EQ_XFADE crossfade (the two chains carry the same, correlated
//     signal) hands over and the old chain is detached. This is DECISION's cut "dry/wet crossfade bypass", generalised.
//     Leftover identity bands are dropped at the next switch.
// A graph change is never made while it could be heard: connect/disconnect only touch muted or not-yet-audible
// paths (two separate connect calls are not atomic against the render thread).
/** cutHz at or below this is "off" (a 20 Hz Butterworth is −1.07 dB at A0, DECISION §3). */
export const EQ_CUT_OFF_HZ = 20.5;
/** hiCutHz at or above this is "off" (same threshold as shared/eq-math.js). */
export const EQ_HICUT_OFF_HZ = 19999;
/** In-place type switch: fade out, swap at 0 dB, fade in (each, seconds; AMENDMENT §2). */
export const EQ_TYPE_FADE = 0.03;
/** Chain switch: muted warm-up of the new chain, then the crossfade (seconds). */
export const EQ_WARM = 0.05;
export const EQ_XFADE = 0.03;
const EQ_FIELDS = ['on', 'type', 'hz', 'db', 'q'];
/** Stored band type → BiquadFilterNode type. */
const EQ_WEB = Object.freeze({ lowshelf: 'lowshelf', peak: 'peaking', highshelf: 'highshelf', notch: 'notch', lowcut: 'highpass', highcut: 'lowpass' });
/** Types that are the identity at 0 dB (they can stay wired while off). */
const EQ_IDENTITY = new Set(['lowshelf', 'peaking', 'highshelf']);
const eqUsesQ = (web) => web === 'peaking' || web === 'notch' || web === 'highpass' || web === 'lowpass';
/**
 * Pre-AMENDMENT rows read as a band while that band has no stored b-rows: eq.low / eq.lowHz = b1 (the 120 Hz low
 * shelf), eq.high / eq.highHz = b8 (6 kHz high shelf) — AMENDMENT §4 — and DECISION's mid1* / mid2* bells = b2 / b3.
 */
const EQ_LEGACY = Object.freeze({
  1: { type: 'lowshelf', db: 'low', hz: 'lowHz' },
  2: { type: 'peak', db: 'mid1', hz: 'mid1Hz', q: 'mid1Q' },
  3: { type: 'peak', db: 'mid2', hz: 'mid2Hz', q: 'mid2Q' },
  [EQ_BAND_COUNT]: { type: 'highshelf', db: 'high', hz: 'highHz' },
});
const eqClamp = (key, v) => clampParam(`slots.0.eq.${key}`, v);
const eqDefault = (key) => describeParam(`slots.0.eq.${key}`)?.default;
const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Effective slot EQ of a stored (sparse) `slot.eq`: every band with its fields filled and clamped.
 * A band with any stored b-row takes the PARAMS defaults for its missing fields (as shared/eq-math.js readEq does);
 * a band with none reads the legacy rows (EQ_LEGACY) over the PARAMS defaults (b1 / b8: on, 120 Hz / 6 kHz shelves).
 * @param {object} [raw] slot.eq
 * @returns {{bands:{on:boolean,type:string,hz:number,db:number,q:number}[], cutHz:number, hiCutHz:number}}
 */
export function resolveSlotEq(raw) {
  const eq = isPlainObj(raw) ? raw : {};
  const bands = [];
  for (let k = 1; k <= EQ_BAND_COUNT; k++) {
    const b = {};
    for (const f of EQ_FIELDS) b[f] = eqDefault(`b${k}.${f}`);
    const st = isPlainObj(eq[`b${k}`]) ? eq[`b${k}`] : null;
    const stored = st && EQ_FIELDS.some((f) => st[f] !== undefined);
    const L = EQ_LEGACY[k];
    if (stored) {
      for (const f of EQ_FIELDS) if (st[f] !== undefined) b[f] = eqClamp(`b${k}.${f}`, st[f]);
    } else if (L) {
      const has = (key) => key && eq[key] !== undefined;
      if (has(L.db) || has(L.hz) || has(L.q)) {
        b.on = true;
        b.type = L.type;
        b.hz = eqDefault(L.hz); // the legacy row's own default (DECISION's bell 1 is 400 Hz, not b2's 210)
        if (L.q) b.q = eqDefault(L.q);
      }
      if (has(L.db)) b.db = eqClamp(`b${k}.db`, eqClamp(L.db, eq[L.db]));
      if (has(L.hz)) b.hz = eqClamp(`b${k}.hz`, eqClamp(L.hz, eq[L.hz]));
      if (has(L.q)) b.q = eqClamp(`b${k}.q`, eqClamp(L.q, eq[L.q]));
    }
    bands.push(b);
  }
  return {
    bands,
    cutHz: eq.cutHz === undefined ? eqDefault('cutHz') : eqClamp('cutHz', eq.cutHz),
    hiCutHz: eq.hiCutHz === undefined ? eqDefault('hiCutHz') : eqClamp('hiCutHz', eq.hiCutHz),
  };
}

/** Wired filter ids of a resolved EQ, in chain order ('lc', 'b1'…'b8', 'hc'). */
export function slotEqMembers(eq) {
  const out = [];
  if (eq.cutHz > EQ_CUT_OFF_HZ) out.push('lc');
  eq.bands.forEach((b, i) => {
    if (b.on && b.type !== 'off') out.push(`b${i + 1}`);
  });
  if (eq.hiCutHz < EQ_HICUT_OFF_HZ) out.push('hc');
  return out;
}

/**
 * Biquad settings of one filter id: {web, hz, Q?, db?, engaged}. web is null for a band of type 'off'.
 * Dedicated cuts are 2nd-order Butterworth (BUTTER2_Q); band cuts take Q in dB from the band's linear q.
 */
function eqSpec(eq, id) {
  if (id === 'lc') return { web: 'highpass', hz: eq.cutHz, Q: BUTTER2_Q, engaged: eq.cutHz > EQ_CUT_OFF_HZ };
  if (id === 'hc') return { web: 'lowpass', hz: eq.hiCutHz, Q: BUTTER2_Q, engaged: eq.hiCutHz < EQ_HICUT_OFF_HZ };
  const b = eq.bands[Number(id.slice(1)) - 1];
  const web = EQ_WEB[b.type] || null;
  const engaged = !!(b.on && web);
  const s = { web, hz: b.hz, engaged };
  if (web === 'peaking' || web === 'notch') s.Q = b.q;
  else if (web === 'highpass' || web === 'lowpass') s.Q = 20 * Math.log10(b.q);
  if (EQ_IDENTITY.has(web)) s.db = engaged ? b.db : 0;
  return s;
}

/**
 * Summed magnitude response (dB) of a resolved EQ at `freqs`, through BiquadFilterNode.getFrequencyResponse on
 * unconnected "shadow" biquads that hold the target settings (the live nodes may be mid-ramp or mid-switch).
 * Frequencies above Nyquist are evaluated at Nyquist (Web Audio returns NaN there).
 * @param {BaseAudioContext} ctx
 * @param {object} eq resolveSlotEq() result
 * @param {ArrayLike<number>} freqs Hz
 * @param {Map} cache per-caller Map id → {key, node} (one shadow node per filter id, rebuilt when its spec changes)
 * @param {boolean} [perBand]
 * @returns {Float32Array|{total:Float32Array, bands:Object<string, Float32Array>}}
 */
export function slotEqResponse(ctx, eq, freqs, cache, perBand = false) {
  const n = freqs.length;
  const nyq = ctx.sampleRate / 2;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = Math.min(nyq, Math.max(0, Number(freqs[i]) || 0));
  const total = new Float32Array(n);
  const bands = {};
  const mag = new Float32Array(n);
  const ph = new Float32Array(n);
  for (const id of slotEqMembers(eq)) {
    const s = eqSpec(eq, id);
    const key = `${s.web}|${s.hz}|${s.Q}|${s.db}`;
    let e = cache.get(id);
    if (!e || e.key !== key) {
      const node = new BiquadFilterNode(ctx, { type: s.web, frequency: s.hz, Q: s.Q ?? 1, gain: s.db ?? 0 });
      cache.set(id, (e = { key, node }));
    }
    e.node.getFrequencyResponse(f, mag, ph);
    const out = perBand ? (bands[id] = new Float32Array(n)) : null;
    for (let i = 0; i < n; i++) {
      const d = 20 * Math.log10(Math.max(mag[i], 1e-12));
      total[i] += d;
      if (out) out[i] = d;
    }
  }
  return perBand ? { total, bands } : total;
}

/** The EQ section of a Channel (see the section comment above). */
export class SlotEq {
  /**
   * @param {BaseAudioContext} ctx
   * @param {AudioNode} input
   * @param {AudioNode} output
   * @param {AudioTimer|null} timer without one (a bare strip in a test) every change applies as a step
   */
  constructor(ctx, input, output, timer = null) {
    this.ctx = ctx;
    this.input = input;
    this.output = output;
    this.timer = timer;
    this.raw = {};
    this.want = resolveSlotEq({});
    this.active = this._side(slotEqMembers(this.want), 1);
    this.incoming = null; // the chain fading in during a switch
    this._seq = 0;
    this._dirty = false;
    this._shadow = new Map();
    this.switches = 0; // chain switches started (tests, _debugStats)
  }

  /** Live AudioNodes (both chains while switching). */
  get nodeCount() {
    const c = (s) => (s ? s.nodes.size + 1 : 0);
    return c(this.active) + c(this.incoming);
  }

  /**
   * Target a stored slot.eq (sparse; absent = defaults). Only what differs from the current target moves.
   * @param {object} raw
   * @param {number} when
   * @param {boolean} [step] nothing sounding yet (fresh channel): rebuild / set instantly
   */
  set(raw, when, step = false) {
    this.raw = isPlainObj(raw) ? raw : {};
    this.want = resolveSlotEq(this.raw);
    this._reconcile(when, step || !this.timer);
  }

  /** Target response in dB at `freqs` (slotEqResponse). */
  response(freqs, perBand = false) {
    return slotEqResponse(this.ctx, this.want, freqs, this._shadow, perBand);
  }

  _node(id) {
    const s = eqSpec(this.want, id);
    const web = s.web || 'peaking'; // never wired while 'off' (slotEqMembers)
    const n = new BiquadFilterNode(this.ctx, { type: web, frequency: s.hz, Q: s.Q ?? 1, gain: s.db ?? 0 });
    for (const p of [n.frequency, n.Q, n.gain, n.detune]) {
      try {
        p.automationRate = 'k-rate'; // DECISION §3 CPU table: a ramping a-rate biquad recomputes per sample
      } catch {}
    }
    Object.assign(n, { _id: id, _web: web, _webTarget: web, _hz: s.hz, _Q: s.Q, _db: s.db ?? 0, _fading: false, _fadeSeq: 0, _dead: false });
    return n;
  }

  /** A chain of `ids`, wired input → … → gain → output; gain starts at `g`. */
  _side(ids, g) {
    const gain = new GainNode(this.ctx, { gain: g });
    const nodes = new Map();
    let prev = null;
    let first = gain;
    for (const id of ids) {
      const n = this._node(id);
      nodes.set(id, n);
      if (prev) prev.connect(n);
      else first = n;
      prev = n;
    }
    if (prev) prev.connect(gain);
    gain.connect(this.output);
    this.input.connect(first); // last: the chain only starts to carry signal once it is complete
    return { gain, nodes, first, ids: ids.slice() };
  }

  _drop(side) {
    if (!side) return;
    try {
      this.input.disconnect(side.first);
    } catch {}
    for (const n of side.nodes.values()) {
      n._dead = true;
      try {
        n.disconnect();
      } catch {}
    }
    try {
      side.gain.disconnect();
    } catch {}
  }

  /** True when the live chain cannot reach the target in place (see the section comment). */
  _needsSwitch(members) {
    const nodes = this.active.nodes;
    for (const id of members) if (!nodes.has(id)) return true;
    for (const [id, n] of nodes) {
      const s = eqSpec(this.want, id);
      if (!s.engaged) {
        if (!EQ_IDENTITY.has(n._webTarget)) return true; // a notch / cut cannot idle as identity
      } else if (s.web !== n._webTarget && !(EQ_IDENTITY.has(s.web) && EQ_IDENTITY.has(n._webTarget))) return true;
    }
    return false;
  }

  _reconcile(when, step) {
    const members = slotEqMembers(this.want);
    if (step) {
      const same = !this.incoming && members.length === this.active.ids.length && members.every((id, i) => id === this.active.ids[i]);
      if (!same || [...this.active.nodes.values()].some((n) => n._web !== eqSpec(this.want, n._id).web)) {
        ++this._seq; // cancels a pending switch / fade
        this._drop(this.incoming);
        this._drop(this.active);
        this.incoming = null;
        this._dirty = false;
        this.active = this._side(members, 1);
      } else this._applyParams(when, true);
      return;
    }
    if (this.incoming) {
      this._dirty = true; // re-checked when the switch has finished
      this._applyParams(when, false);
      return;
    }
    this._applyParams(when, false); // also on a switch: the outgoing chain stays audible for EQ_WARM
    if (this._needsSwitch(members)) this._switch(members, when);
  }

  _switch(members, when) {
    const seq = ++this._seq;
    const old = this.active;
    const side = this._side(members, 0);
    this.incoming = side;
    this.switches += 1;
    const t1 = when + EQ_WARM;
    linFrom(side.gain.gain, 0, 1, t1, EQ_XFADE);
    linFrom(old.gain.gain, 1, 0, t1, EQ_XFADE);
    this.timer.at(t1 + EQ_XFADE + 0.005, (tt) => {
      if (seq !== this._seq) return;
      this._drop(old);
      this.active = side;
      this.incoming = null;
      if (this._dirty) {
        this._dirty = false;
        this._reconcile(tt, false);
      }
    });
  }

  /** Hz / Q / gain (and in-place type fades) of every live node toward the target. */
  _applyParams(when, step) {
    for (const side of [this.active, this.incoming]) {
      if (!side) continue;
      for (const n of side.nodes.values()) {
        const s = eqSpec(this.want, n._id);
        if (s.web && s.web !== n._webTarget && EQ_IDENTITY.has(s.web) && EQ_IDENTITY.has(n._webTarget)) {
          if (step) {
            n.type = n._web = n._webTarget = s.web;
          } else {
            this._fadeType(n, s.web, when);
          }
        }
        if (s.hz !== n._hz) {
          if (step) setNow(n.frequency, s.hz, when);
          else glideTo(n.frequency, s.hz, when, TAU, { from: n._hz });
          n._hz = s.hz;
        }
        if (s.Q !== undefined && s.Q !== n._Q && eqUsesQ(n._web) && s.web === n._web) {
          if (step) setNow(n.Q, s.Q, when);
          else rampTo(n.Q, s.Q, when, TAU);
          n._Q = s.Q;
        }
        if (EQ_IDENTITY.has(n._web) && !n._fading) {
          const g = s.web === n._web ? s.db ?? 0 : 0; // engaged in another type → at 0 dB until its swap
          if (g !== n._db) {
            if (step) setNow(n.gain, g, when);
            else rampTo(n.gain, g, when, TAU);
            n._db = g;
          }
        }
      }
    }
  }

  /** Peak/shelf type change in place: 30 ms to 0 dB, swap at identity, 30 ms back (AMENDMENT §2). */
  _fadeType(n, web, when) {
    n._webTarget = web;
    if (n._fading) return; // the pending swap reads _webTarget
    n._fading = true;
    const seq = ++n._fadeSeq;
    linFrom(n.gain, n._db, 0, when, EQ_TYPE_FADE);
    n._db = 0;
    this.timer.at(when + EQ_TYPE_FADE, (tt) => {
      if (n._dead || seq !== n._fadeSeq) return;
      n._fading = false;
      if (!EQ_IDENTITY.has(n._webTarget)) return; // turned into a notch/cut meanwhile: a switch replaces this node
      n.type = n._web = n._webTarget;
      const s = eqSpec(this.want, n._id);
      if (s.Q !== undefined && eqUsesQ(n._web)) {
        setNow(n.Q, s.Q, tt);
        n._Q = s.Q;
      }
      const g = s.web === n._web ? s.db ?? 0 : 0;
      if (g !== 0) linFrom(n.gain, 0, g, tt, EQ_TYPE_FADE);
      n._db = g;
      if (!this.incoming && this._needsSwitch(slotEqMembers(this.want))) this._reconcile(tt, false);
    });
  }

  dispose() {
    ++this._seq;
    this._drop(this.incoming);
    this._drop(this.active);
    this.incoming = null;
    this._shadow.clear();
  }
}

/**
 * Per-slot channel strip: fader → wheel → width (M/S) → EQ (SlotEq: cuts + up to 8 bands) → pan → dry + 3
 * post-fader sends. Owned by one instrument instance.
 *
 * Width, channel-count agnostic (a mono instrument stays mono, so the StereoPanner keeps its mono law):
 *   M = speakers down-mix of x ((L+R)/2, or x itself for mono), S⃗ = x − M = (S, −S) (0 for mono)
 *   out = x + (min(w,1) − 1)·S⃗ + max(w − 1, 0)·HPF₂₁₅₀(S⃗)
 * i.e. w ≤ 1 scales the whole side (0 = mono), w > 1 widens only the side above 150 Hz (the lows are never widened).
 * w = 1 → both side gains are exactly 0 and the shelves at 0 dB are identity biquads: bit-exact to the old strip.
 */
export class Channel {
  constructor(ctx, fx, slotIndex) {
    this.ctx = ctx;
    this.slotIndex = slotIndex;
    this.fader = new GainNode(ctx, { gain: 0 });
    this.wheel = new GainNode(ctx, { gain: 1 });
    // width
    this.wIn = new GainNode(ctx, { gain: 1 });
    this.wMid = new GainNode(ctx, { gain: 1, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    this.wNeg = new GainNode(ctx, { gain: -1 });
    this.wSide = new GainNode(ctx, { gain: 1 });
    this.wNarrow = new GainNode(ctx, { gain: 0 });
    // 2-pole: its phase is near 0 well above 150 Hz, so the added side adds in phase (a 4-pole's 180° at fc made
    // widening *cut* the side around 150–250 Hz). Lows are never widened (side ×0.93…1 below ~75 Hz at w 1.5).
    this.wHp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 150, Q: BUTTER2_Q });
    this.wWide = new GainNode(ctx, { gain: 0 });
    this.wOut = new GainNode(ctx, { gain: 1 });
    this.pan = new StereoPannerNode(ctx, { pan: 0 });
    this.sends = {
      reverb: new GainNode(ctx, { gain: 0 }),
      delay: new GainNode(ctx, { gain: 0 }),
      chorus: new GainNode(ctx, { gain: 0 }),
    };
    this.input = this.fader;
    this.fader.connect(this.wheel).connect(this.wIn);
    this.wIn.connect(this.wOut);
    this.wIn.connect(this.wSide);
    this.wIn.connect(this.wMid).connect(this.wNeg).connect(this.wSide);
    this.wSide.connect(this.wNarrow).connect(this.wOut);
    this.wSide.connect(this.wHp).connect(this.wWide).connect(this.wOut);
    // EQ (wOut → … → pan): at the defaults a 120 Hz low shelf + 6 kHz high shelf at 0 dB, i.e. the old strip exactly
    this.eq = new SlotEq(ctx, this.wOut, this.pan, fx.env?.timer ?? null);
    this.pan.connect(fx.sum);
    this.pan.connect(this.sends.reverb).connect(fx.reverb.input);
    this.pan.connect(this.sends.delay).connect(fx.delay.input);
    this.pan.connect(this.sends.chorus).connect(fx.chorus.input);
    this.width = 1;
  }
  /** Live AudioNodes: 14 fixed + the EQ's chains (17 with the default two shelves: their biquads + the chain gain). */
  get nodeCount() {
    return 14 + this.eq.nodeCount;
  }
  /** Compatibility (engine-3 tests): the live b1 / b8 biquads, when wired. */
  get eqLow() {
    return this.eq.active.nodes.get('b1');
  }
  get eqHigh() {
    return this.eq.active.nodes.get(`b${EQ_BAND_COUNT}`);
  }
  /** Effective width (slot width × the instrument's widthDefault), 0..∞ (clamped to 0..2.25). */
  setWidth(w, when, step = false) {
    const x = Math.min(2.25, Math.max(0, Number.isFinite(w) ? w : 1));
    this.width = x;
    const narrow = Math.min(1, x) - 1;
    const wide = Math.max(0, x - 1);
    if (step) {
      setNow(this.wNarrow.gain, narrow, when);
      setNow(this.wWide.gain, wide, when);
    } else {
      rampTo(this.wNarrow.gain, narrow, when, TAU);
      rampTo(this.wWide.gain, wide, when, TAU);
    }
  }
  /**
   * Target a stored slot.eq ({b1…b8, cutHz, hiCutHz, low, high, …}; absent keys = defaults): SlotEq.set.
   * Legacy form setEq(lowDb, highDb, when, step) (engine-3): merges eq.low / eq.high (undefined = unchanged).
   * @param {object|number} eq
   * @param {number} when
   * @param {boolean} [step]
   */
  setEq(eq, when, step = false) {
    if (!isPlainObj(eq)) {
      const [low, high, w, st] = arguments;
      const raw = { ...this.eq.raw };
      if (low !== undefined) raw.low = low;
      if (high !== undefined) raw.high = high;
      return this.eq.set(raw, w, !!st);
    }
    return this.eq.set(eq, when, step);
  }
  dispose() {
    this.eq.dispose();
    for (const n of [this.fader, this.wheel, this.wIn, this.wMid, this.wNeg, this.wSide, this.wNarrow, this.wHp, this.wWide, this.wOut, this.pan, this.sends.reverb, this.sends.delay, this.sends.chorus]) {
      try {
        n.disconnect();
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Glue compressor (engine-3): fx.comp.amount a ∈ (0, 1] → threshold −24a dB, ratio 1 + 3a, knee 6, attack 10 ms,
// release 250 ms. Chromium's DynamicsCompressor adds an automatic makeup gain that depends on threshold/ratio/knee,
// so the total gain on a reference tone (1 kHz sine, amplitude 0.1 = −23.01 dBFS RMS, the same reference as the
// catcher's makeup test) is measured once per page for a = 0, .1, …, 1 and cancelled after the compressor
// (interpolated in dB between the grid points): that tone passes at unity for every amount.
/** Seconds between connecting the glue compressor and its dry→wet crossfade (detector settle, round2-engine M3). */
export const GLUE_ENGAGE_DELAY = 0.3;
export const GLUE = Object.freeze({ thrDb: -24, ratio: 4, knee: 6, attack: 0.01, release: 0.25, refAmp: 0.1, grid: 10 });
export function glueSettings(a) {
  const x = Math.min(1, Math.max(0, Number(a) || 0));
  return { threshold: GLUE.thrDb * x, ratio: 1 + (GLUE.ratio - 1) * x, knee: GLUE.knee, attack: GLUE.attack, release: GLUE.release };
}
let GLUE_P = null;
/** @returns {Promise<number[]>} total compressor gain (dB) on the reference tone at amount k/grid, k = 0..grid */
export function measureGlueRef() {
  if (!GLUE_P) {
    GLUE_P = (async () => {
      const N = GLUE.grid + 1;
      try {
        const sr = 44100;
        const n = Math.round(sr * 0.8); // attack 10 ms / release 250 ms: settled well before 0.7 s
        const ctx = new OfflineAudioContext({ numberOfChannels: N, length: n, sampleRate: sr });
        const o = new OscillatorNode(ctx, { frequency: 1000 });
        const g = new GainNode(ctx, { gain: GLUE.refAmp });
        const merge = new ChannelMergerNode(ctx, { numberOfInputs: N });
        o.connect(g);
        for (let k = 0; k < N; k++) {
          const c = new DynamicsCompressorNode(ctx, glueSettings(k / GLUE.grid));
          g.connect(c).connect(merge, 0, k);
        }
        merge.connect(ctx.destination);
        o.start(0);
        const buf = await ctx.startRendering();
        const inRms = GLUE.refAmp / Math.SQRT2;
        const out = [];
        for (let k = 0; k < N; k++) {
          const d = buf.getChannelData(k);
          let s = 0;
          for (let i = n - 4410; i < n; i++) s += d[i] * d[i];
          const gDb = 20 * Math.log10(Math.sqrt(s / 4410) / inRms);
          out.push(Number.isFinite(gDb) && Math.abs(gDb) < 30 ? gDb : 0);
        }
        return out;
      } catch {
        return new Array(N).fill(0);
      }
    })();
  }
  return GLUE_P;
}
function glueRefDb(table, a) {
  if (!table || !table.length) return 0;
  const x = Math.min(1, Math.max(0, a)) * (table.length - 1);
  const i = Math.min(table.length - 2, Math.floor(x));
  return table[i] + (table[i + 1] - table[i]) * (x - i);
}

/** The whole static FX + master graph. */
export class FxGraph {
  constructor(ctx, { seed = 0, timer, irCache, lofi = true, clipOversample = 'none', glue = true } = {}) {
    this.ctx = ctx;
    this.env = { seed, timer, irCache: irCache || new Map(), offline: isOfflineContext(ctx) };
    this.sum = new GainNode(ctx, { gain: 1 });
    this.reverb = new Reverb(ctx, this.env);
    this.delay = new Delay(ctx, this.env);
    this.chorus = new Chorus(ctx, this.env);
    this.reverb.output.connect(this.sum);
    this.delay.output.connect(this.sum);
    this.chorus.output.connect(this.sum);
    this.master = new GainNode(ctx, { gain: Math.pow(10, -6 / 20) });
    // master EQ (after lofi, before the master gain): identity biquads at 0 dB
    this.eqIn = new GainNode(ctx, { gain: 1 });
    this.eqLow = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 100, gain: 0 });
    this.eqMid = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1000, Q: 0.8, gain: 0 });
    this.eqHigh = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 8000, gain: 0 });
    this.eqIn.connect(this.eqLow).connect(this.eqMid).connect(this.eqHigh);
    if (lofi) this.lofi = new Lofi(ctx, this.env, this.sum, this.eqIn);
    else {
      this.lofi = null;
      this.sum.connect(this.eqIn);
    }
    // glue compressor: eqHigh → glueDry (1) → master, and while engaged eqHigh → glue → glueWet → master
    this.glueDry = new GainNode(ctx, { gain: 1 });
    this.eqHigh.connect(this.glueDry).connect(this.master);
    this.glue = glue ? new DynamicsCompressorNode(ctx, glueSettings(1)) : null;
    this.glueWet = glue ? new GainNode(ctx, { gain: 0 }) : null;
    this.glueRef = null; // measureGlueRef() table (dB), set by setGlueRef
    this.glueAmount = 0;
    this.glueEngaged = false;
    this._glueConnected = false;
    this._glueSeq = 0;
    this._glueXf = { t0: 0, dur: 0, from: 1, to: 1 }; // dry-gain crossfade (wet = makeup × (1 − dry))
    // The dry→wet crossfade starts this long after the compressor's input is connected. The lookahead alone
    // (256 + 128 frames ≈ 8.7 ms) is not enough: a DynamicsCompressor that has just started to receive signal (or
    // whose detector froze at a stale level while it was detached) over-reduces for ~100–200 ms, a 3–4.5 dB level
    // dip at every engage (round2-engine M3). 0.3 s lets the detector settle first; late engage is inaudible here.
    this.glueDelay = GLUE_ENGAGE_DELAY;
    this.masterWheel = new GainNode(ctx, { gain: 1 });
    this.fadeGain = new GainNode(ctx, { gain: 1 });
    // stereo / mono selection BEFORE the catcher and the ceiling (REVIEW engine-core #5): the mono sum (−3 dB)
    // is limited like everything else, so mono output can never exceed the −0.3 dBFS ceiling.
    this.stereo = new GainNode(ctx, { gain: 1 });
    this.mono = new GainNode(ctx, { gain: 0, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    this.preComp = new GainNode(ctx, { gain: 1 });
    this.comp = new DynamicsCompressorNode(ctx, { threshold: -3, knee: 3, ratio: 12, attack: 0.003, release: 0.25 });
    // .5 maps ±2 into the clip curve domain; × 1/makeup cancels the compressor's automatic makeup gain (measured
    // at engine start, see measureCompMakeup) so the chain is unity below the threshold.
    this.clipPre = new GainNode(ctx, { gain: 0.5 });
    this.compMakeup = 1;
    // Oversampling 'none' by default (CONTRACT_CHANGES): the curve is exactly linear below −6 dBFS, and Chromium's
    // 4x resampler adds 192 frames (4.4 ms) to every note on top of the compressor's 264-frame lookahead.
    this.clip = new WaveShaperNode(ctx, { curve: clipCurve(), oversample: clipOversample });
    this.out = new GainNode(ctx, { gain: 1 });
    this.master.connect(this.masterWheel).connect(this.fadeGain);
    this.fadeGain.connect(this.stereo).connect(this.preComp);
    this.fadeGain.connect(this.mono).connect(this.preComp);
    this.preComp.connect(this.comp).connect(this.clipPre).connect(this.clip).connect(this.out);
    this.recordTap = new GainNode(ctx, { gain: 1 });
    this.out.connect(this.recordTap);
    this.out.connect(ctx.destination);
    this.splitter = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    this.analyserL = new AnalyserNode(ctx, { fftSize: 2048 });
    this.analyserR = new AnalyserNode(ctx, { fftSize: 2048 });
    this.out.connect(this.splitter);
    this.splitter.connect(this.analyserL, 0);
    this.splitter.connect(this.analyserR, 1);
    this.monoOn = false;
    this._staticNodes = 1 + this.reverb.nodeCount + this.delay.nodeCount + this.chorus.nodeCount + (this.lofi ? this.lofi.nodeCount : 0) + 14 + 5 + (this.glue ? 2 : 0);
  }
  /** Live node count of the static graph (+ the crackle source while lofi is engaged, + armed timer nodes). */
  get nodeCount() {
    const t = this.env.timer;
    return this._staticNodes + (this.lofi?.crackleSrc ? 1 : 0) + (t?._armed ? t._armed.size + (t._sink ? 1 : 0) : 0);
  }
  setMono(on, when) {
    this.monoOn = !!on;
    // mono path: explicit 1-ch downmix = .5(L+R); × √2 → (L+R)·0.707 = "sum −3 dB"
    const was = this._monoV || 0;
    this._monoV = on ? 1 : 0;
    linFrom(this.stereo.gain, 1 - was, on ? 0 : 1, when, 0.05);
    linFrom(this.mono.gain, was * Math.SQRT2, on ? Math.SQRT2 : 0, when, 0.05);
  }
  /** Master EQ gains in dB (undefined = unchanged). */
  setEq({ low, mid, high } = {}, when, step = false) {
    const c = (d) => Math.min(12, Math.max(-12, Number(d) || 0));
    const f = step ? (p, v) => setNow(p, v, when) : (p, v) => rampTo(p, v, when, TAU);
    if (low !== undefined) f(this.eqLow.gain, c(low));
    if (mid !== undefined) f(this.eqMid.gain, c(mid));
    if (high !== undefined) f(this.eqHigh.gain, c(high));
  }
  setGlueRef(table) {
    if (Array.isArray(table) && table.length === GLUE.grid + 1) this.glueRef = table.slice();
  }
  /** Linear makeup that puts the reference tone at unity for amount `a`. */
  glueMakeup(a) {
    return Math.pow(10, -glueRefDb(this.glueRef, a) / 20);
  }
  _glueDryAt(t) {
    const x = this._glueXf;
    if (t <= x.t0) return x.from;
    if (!(x.dur > 0) || t >= x.t0 + x.dur) return x.to;
    return x.from + ((x.to - x.from) * (t - x.t0)) / x.dur;
  }
  /**
   * fx.comp.amount. 0 → true bypass: the compressor is disconnected (after a 30 ms crossfade back to the dry path).
   * > 0 → engaged: dry→compressed crossfade (30 ms, linear) starting GLUE_ENGAGE_DELAY (0.3 s) after the compressor
   * is connected, so its detector has settled (no engage dip) and its lookahead onset lands while the wet gain is 0. While engaged the output is delayed by that lookahead (≈ 5.8 ms).
   */
  setGlue(a, when) {
    if (!this.glue) return false;
    const x = Math.min(1, Math.max(0, Number(a) || 0));
    this.glueAmount = x;
    const on = x > 0;
    if (on) {
      const st = glueSettings(x);
      const mk = this.glueMakeup(x);
      if (!this.glueEngaged) {
        // parameters step while the compressor is still silent in the mix
        setNow(this.glue.threshold, st.threshold, when);
        setNow(this.glue.ratio, st.ratio, when);
        this.glueEngaged = true;
        ++this._glueSeq; // cancels a pending disconnect
        if (!this._glueConnected) {
          this.eqHigh.connect(this.glue).connect(this.glueWet).connect(this.master);
          this._glueConnected = true;
        }
        const w = when + this.glueDelay;
        const from = this._glueDryAt(w);
        linFrom(this.glueDry.gain, from, 0, w, 0.03);
        linFrom(this.glueWet.gain, (1 - from) * mk, mk, w, 0.03);
        this._glueXf = { t0: w, dur: 0.03, from, to: 0 };
        this._glueMk = mk;
      } else {
        rampTo(this.glue.threshold, st.threshold, when, TAU);
        rampTo(this.glue.ratio, st.ratio, when, TAU);
        const X = this._glueXf;
        const busy = when < X.t0 + X.dur;
        // still settling (before the crossfade): the wet stays 0 and the crossfade keeps its start, new makeup
        if (busy && when < X.t0) linFrom(this.glueWet.gain, (1 - X.from) * mk, mk, X.t0, X.dur);
        else if (busy) linFrom(this.glueWet.gain, this._glueMk * (1 - this._glueDryAt(when)), mk, when, Math.max(0.005, X.t0 + X.dur - when));
        else rampTo(this.glueWet.gain, mk, when, TAU);
        this._glueMk = mk;
      }
      return true;
    }
    if (!this.glueEngaged) return true;
    this.glueEngaged = false;
    const seq = ++this._glueSeq;
    const from = this._glueDryAt(when);
    linFrom(this.glueDry.gain, from, 1, when, 0.03); // ends exactly at 1.0 → bit-exact dry afterwards
    linFrom(this.glueWet.gain, (1 - from) * this._glueMk, 0, when, 0.03);
    this._glueXf = { t0: when, dur: 0.03, from, to: 1 };
    this.env.timer.at(when + 0.04, () => {
      if (seq !== this._glueSeq || this.glueEngaged) return;
      try {
        this.eqHigh.disconnect(this.glue);
      } catch {}
      try {
        this.glueWet.disconnect(this.master);
      } catch {}
      this._glueConnected = false;
    });
    return true;
  }
  /** Cancel the compressor's automatic makeup gain (linear factor, measured once per engine). */
  setCompMakeup(m) {
    if (!(m > 0.5 && m < 2)) return;
    this.compMakeup = m;
    setNow(this.clipPre.gain, 0.5 / m, 0);
  }
  dispose() {
    this.reverb.dispose();
    this.env.timer = { at: () => () => {} };
    try {
      this.out.disconnect();
    } catch {}
  }
}

export { TAU, glideTo };
