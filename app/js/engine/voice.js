// Shared voice / envelope / allocation helpers for the synth and organ instruments (SPEC §3.2, REVIEW 1.1, 2.8).
// Rules followed here and by every instrument:
//  * AudioParam automation only through shared/automation.js (cancel-and-hold first), so a release scheduled
//    during an attack ramp really releases.
//  * A Voice owns every node it creates. Sources (oscillators, LFOs, noise bursts) are started through
//    `voice.addSource`; the voice disconnects everything (incl. connections *into* it from shared
//    instrument-level modulators, recorded with `voice.link`) on the LAST source's `onended`. No timers.
//  * Release = time to −60 dB (τ = release/6.9); sources stop at release × 1.3.
import { rampTo, setNow, linearTo, glideTo, releaseTau, stopAfterRelease } from '../shared/automation.js';
import { createRng } from '../shared/prng.js';

/** Max voices per instrument (SPEC §3.2). */
export const MAX_VOICES = 16;
/** Steal fade (SPEC §3.2). */
export const STEAL_FADE = 0.02;

let VOICE_SEQ = 0;

/** Normalise whatever the engine passes as `prng` into an Rng (createRng shape); forks when possible. */
export function asRng(prng) {
  if (prng && typeof prng.next === 'function') return typeof prng.fork === 'function' ? prng.fork() : prng;
  if (typeof prng === 'function') {
    const next = prng;
    const r = createRng(Math.floor(next() * 4294967296) >>> 0);
    return r;
  }
  return createRng(prng ?? 1);
}

/** Current-or-later audio time. */
export function atTime(ctx, when) {
  const now = ctx.currentTime;
  return Number.isFinite(when) && when > now ? when : now;
}

/**
 * One sounding note. Owns its nodes; `kill(when)` stops every source (LFOs included) and the whole
 * sub-graph is disconnected on the last `onended`.
 * state: 'held' → 'released' (envelope releasing) → 'dead';  or → 'killed' (fading/stopping) → 'dead'.
 */
export class Voice {
  /**
   * @param {BaseAudioContext} ctx
   * @param {number} note MIDI note (may be updated by legato)
   * @param {number} when start time
   */
  constructor(ctx, note, when) {
    this.ctx = ctx;
    this.id = ++VOICE_SEQ;
    this.note = note;
    this.startedAt = when;
    this.releasedAt = Infinity;
    this.stopAt = Infinity;
    this.state = 'held';
    /** @type {AudioNode[]} */ this.nodes = [];
    /** @type {AudioScheduledSourceNode[]} */ this.sources = [];
    /** @type {Array<[AudioNode, AudioNode|AudioParam]>} external connections into this voice */
    this._links = [];
    this._pending = 0;
    /** envelope from makeEnv (optional) */ this.env = null;
    /** final per-voice GainNode — steal/kill fades act on it */ this.out = null;
    /** instrument hook `(when) => stopTime` replacing env.release */ this.onRelease = null;
    /** seconds to −60 dB set by the engine from `slots.<i>.release` just before note-off (sustain); 0 = unset */
    this.releaseOverride = 0;
    /** allocator/instrument callbacks run once at teardown */ this._deadCbs = [];
    /** instrument-private data */ this.data = {};
  }

  /** Track a (non-source) node for teardown. @template {AudioNode} T @param {T} node @returns {T} */
  add(node) {
    this.nodes.push(node);
    return node;
  }

  /**
   * Track and start a source. `stopAt` optional early stop for this source only (e.g. a percussion osc);
   * `offset` = AudioBufferSourceNode start offset.
   * @template {AudioScheduledSourceNode} T @param {T} src @param {number} when @param {number} [stopAt]
   * @param {number} [offset]
   * @returns {T}
   */
  addSource(src, when, stopAt, offset) {
    this.nodes.push(src);
    this.sources.push(src);
    this._pending++;
    src._stopAt = Infinity;
    src.onended = () => this._ended();
    if (offset !== undefined) src.start(when, offset);
    else src.start(when);
    if (Number.isFinite(stopAt)) this._stopSource(src, stopAt);
    if (Number.isFinite(this.stopAt)) this._stopSource(src, this.stopAt);
    return src;
  }

  /** Connect a node the voice does NOT own (shared LFO, bend source…) into one of the voice's nodes/params. */
  link(from, to) {
    from.connect(to);
    this._links.push([from, to]);
  }

  /** Live (not yet disconnected) node count — 0 after teardown. */
  get liveNodes() {
    return this.nodes.length;
  }

  get alive() {
    return this.state !== 'dead';
  }

  /** Register a teardown callback. */
  onDead(cb) {
    if (this.state === 'dead') cb(this);
    else this._deadCbs.push(cb);
  }

  // stop() may be called repeatedly and the LAST call wins (verified in Chromium 1194), so keep the earliest.
  _stopSource(src, t) {
    if (!(t < src._stopAt)) return;
    src._stopAt = t;
    try {
      src.stop(Math.max(t, this.startedAt));
    } catch (e) {
      /* already finished */
    }
  }

  _scheduleStop(t) {
    if (!(t < this.stopAt)) return;
    this.stopAt = t;
    for (const s of this.sources) this._stopSource(s, t);
  }

  _ended() {
    if (--this._pending > 0) return;
    this._teardown();
  }

  _teardown() {
    if (this.state === 'dead') return;
    for (const [from, to] of this._links) {
      try {
        from.disconnect(to);
      } catch (e) {
        /* already gone */
      }
    }
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
    this._links = [];
    this.nodes = [];
    this.sources = [];
    this.state = 'dead';
    const cbs = this._deadCbs;
    this._deadCbs = [];
    for (const cb of cbs) cb(this);
  }

  /**
   * Start the release at `when` (idempotent). Uses the instrument's `onRelease` hook, else `env.release`.
   * sustain: with `releaseOverride` (s to −60 dB, the slot's `release`) the envelope releases over that time instead of
   * the instrument's own (the hook still runs, for its side effects: bloom freeze, filter settle); a voice without an
   * envelope fades its `out` gain over it.
   * @param {number} when
   */
  releaseAt(when) {
    if (this.state !== 'held') return;
    const t = atTime(this.ctx, when);
    this.state = 'released';
    this.releasedAt = t;
    const ov = this.releaseOverride > 0 ? this.releaseOverride : 0;
    let stop;
    if (ov && this.env) {
      const own = this.env.release;
      this.env.release = (rt) => own(rt, ov);
      try {
        stop = this.onRelease ? this.onRelease(t) : this.env.release(t);
      } finally {
        this.env.release = own;
      }
    } else if (ov && this.out) {
      if (this.onRelease) this.onRelease(t);
      rampTo(this.out.gain, 0, t, releaseTau(ov));
      stop = stopAfterRelease(t, ov);
    } else stop = this.onRelease ? this.onRelease(t) : this.env ? this.env.release(t) : t;
    if (!Number.isFinite(stop)) stop = t + 0.05;
    this._scheduleStop(stop);
  }

  /**
   * Hard stop of every source at `when` (no fade — use fadeOut for audible voices).
   * @param {number} when
   */
  kill(when) {
    if (this.state === 'dead') return;
    this.state = 'killed';
    this._scheduleStop(atTime(this.ctx, when));
  }

  /**
   * Click-free kill: exponential fade of `out` to −60 dB over `fadeSec`, then stop (steals, re-strikes, panic).
   * @param {number} when
   * @param {number} [fadeSec=0.02]
   */
  fadeOut(when, fadeSec = STEAL_FADE) {
    if (this.state === 'dead') return;
    const t = atTime(this.ctx, when);
    const f = Math.max(0.003, fadeSec);
    if (this.out) rampTo(this.out.gain, 0, t, releaseTau(f));
    if (this.state !== 'killed') this.releasedAt = Math.min(this.releasedAt, t);
    this.state = 'killed';
    this._scheduleStop(stopAfterRelease(t, f));
  }
}

/**
 * ADSR on `gainParam` (param should start at 0, e.g. `new GainNode(ctx,{gain:0})`).
 * Attack: linear 0→peak; decay: exponential approach to s·peak with τ = d/3 (or `dTau`); release: τ = r/6.9.
 * Because every stage goes through cancel-and-hold, `release()` during the attack ramp releases from the
 * value reached at that instant (REVIEW 1.1).
 * @param {BaseAudioContext} ctx
 * @param {AudioParam} gainParam
 * @param {{a:number,d?:number,s?:number,r:number,dTau?:number}} adsr
 * @param {number} when
 * @param {number} [peak=1]
 * @returns {{release(when:number, r?:number):number, killAt:number, attackEnd:number}}
 */
export function makeEnv(ctx, gainParam, adsr, when, peak = 1) {
  const t = atTime(ctx, when);
  const a = Math.max(0.002, Number(adsr.a) || 0);
  const s = adsr.s === undefined ? 1 : Math.max(0, Math.min(1, adsr.s));
  setNow(gainParam, 0, t); // anchor: the ramp must start at `t`, not at the previous event
  linearTo(gainParam, peak, t, a, { from: 0 });
  const dTau = adsr.dTau > 0 ? adsr.dTau : Math.max(0.001, Number(adsr.d) || 0.001) / 3;
  if (s < 1) rampTo(gainParam, peak * s, t + a, dTau);
  const env = {
    attackEnd: t + a,
    killAt: Infinity,
    release(rt, r = adsr.r) {
      const tt = atTime(ctx, rt);
      const rr = Math.max(0.005, Number(r) || 0);
      rampTo(gainParam, 0, tt, releaseTau(rr));
      env.killAt = stopAfterRelease(tt, rr);
      return env.killAt;
    },
  };
  return env;
}

/**
 * A pitch-like AudioParam that is only ever moved by exponential glides (oscillator frequencies).
 * Chromium's cancelAndHoldAtTime inserts no hold when no event spans `when`, and after a setTargetAtTime it
 * holds 0 for a following ramp — so a bare glideTo would start early or from 0. We therefore track the
 * value analytically and anchor it with setNow(value-at-t) before every glideTo (verified in Chromium 1194).
 */
export class TrackedParam {
  /** @param {AudioParam} param @param {number} value its current (intrinsic) value */
  constructor(param, value) {
    this.param = param;
    this.v0 = this.v1 = value;
    this.t0 = this.t1 = 0;
  }

  valueAt(t) {
    if (t >= this.t1 || this.t1 <= this.t0) return this.v1;
    if (t <= this.t0) return this.v0;
    return this.v0 * Math.pow(this.v1 / this.v0, (t - this.t0) / (this.t1 - this.t0));
  }

  /** Exponential glide to `value` over `dur` seconds starting at `t` (dur 0 = step). */
  glide(value, t, dur) {
    const cur = this.valueAt(t);
    setNow(this.param, cur, t);
    if (dur > 0) glideTo(this.param, value, t, dur, { from: cur });
    else setNow(this.param, value, t);
    this.v0 = cur;
    this.v1 = value;
    this.t0 = t;
    this.t1 = t + Math.max(0, dur);
  }
}

/**
 * Keeps the voices of one instrument, steals when full (oldest-released first, then oldest-held, 20 ms fade).
 */
export class VoiceAllocator {
  /** @param {number} [max=16] @param {number} [stealFade=0.02] */
  constructor(max = MAX_VOICES, stealFade = STEAL_FADE) {
    this.max = max;
    this.stealFade = stealFade;
    /** @type {Set<Voice>} voices not yet torn down (incl. killed-but-fading) */
    this.voices = new Set();
    this.steals = 0;
  }

  /** Voices that count toward the polyphony limit at `when` (not killed/dead). */
  _playing() {
    const out = [];
    for (const v of this.voices) if (v.state === 'held' || v.state === 'released') out.push(v);
    return out;
  }

  /**
   * Free slots so one more voice fits; returns the stolen voices.
   * @param {number} when
   * @returns {Voice[]}
   */
  makeRoom(when) {
    const playing = this._playing();
    const stolen = [];
    while (playing.length >= this.max) {
      // oldest-released (release already happened by `when`) first, else oldest-held
      let victim = null;
      for (const v of playing) {
        if (v.state === 'released' && v.releasedAt <= when && (!victim || v.releasedAt < victim.releasedAt)) victim = v;
      }
      if (!victim) for (const v of playing) if (!victim || v.startedAt < victim.startedAt) victim = v;
      playing.splice(playing.indexOf(victim), 1);
      victim.fadeOut(when, this.stealFade);
      stolen.push(victim);
      this.steals++;
    }
    return stolen;
  }

  /** @param {Voice} v */
  add(v) {
    this.voices.add(v);
    v.onDead((x) => this.voices.delete(x));
    return v;
  }

  /** Voices still holding nodes. */
  get size() {
    return this.voices.size;
  }

  /** Any voice physically held (state 'held')? `except` is ignored. */
  anyHeld(except) {
    for (const v of this.voices) if (v !== except && v.state === 'held') return true;
    return false;
  }

  /** Fade out everything. */
  allOff(when, fadeSec = 0.03) {
    for (const v of [...this.voices]) v.fadeOut(when, fadeSec);
  }

  /** Hard kill everything. */
  killAll(when) {
    for (const v of [...this.voices]) v.kill(when);
  }

  /** Total live nodes owned by voices. */
  liveNodes() {
    let n = 0;
    for (const v of this.voices) n += v.liveNodes;
    return n;
  }
}

const WAVE_CACHE = new WeakMap();

/**
 * Let context `to` use the PeriodicWaves already built for `from` (same sample rate only). lowres2-critic R4: every
 * frozen-drone render is a new OfflineAudioContext, and rebuilding drone-osc's 8 phase-rotated saws (512 harmonics)
 * plus its triangles there cost ≈ 8–10 ms of main thread per render. Chromium's PeriodicWave is not bound to its
 * context (a wave built on the realtime context renders identically in an OfflineAudioContext: max diff 0).
 * @param {BaseAudioContext} from
 * @param {BaseAudioContext} to
 * @returns {boolean} shared
 */
export function shareWaveCache(from, to) {
  if (!from || !to || from === to || from.sampleRate !== to.sampleRate || WAVE_CACHE.has(to)) return false;
  let byKey = WAVE_CACHE.get(from);
  if (!byKey) WAVE_CACHE.set(from, (byKey = new Map()));
  WAVE_CACHE.set(to, byKey);
  return true;
}

/**
 * `n` PeriodicWaves of the same spectrum (sine coefficients `sin[k]`) time-shifted by 2π·i/n: the same
 * waveform started at n different phases. Cached per context under `key` (build in prepare).
 * @param {BaseAudioContext} ctx
 * @param {string} key
 * @param {ArrayLike<number>} sin sine coefficient per harmonic (index 0 ignored)
 * @param {number} [n=8]
 * @returns {PeriodicWave[]}
 */
export function rotatedWaves(ctx, key, sin, n = 8) {
  let byKey = WAVE_CACHE.get(ctx);
  if (!byKey) WAVE_CACHE.set(ctx, (byKey = new Map()));
  const k = `${key}/${n}`;
  if (byKey.has(k)) return byKey.get(k);
  const H = sin.length - 1;
  const waves = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    const real = new Float32Array(H + 1);
    const imag = new Float32Array(H + 1);
    for (let h = 1; h <= H; h++) {
      real[h] = sin[h] * Math.sin(h * th); // sin(h(ωt+θ)) = sin(hωt)cos(hθ) + cos(hωt)sin(hθ)
      imag[h] = sin[h] * Math.cos(h * th);
    }
    waves.push(ctx.createPeriodicWave(real, imag)); // normalised: all rotations share the same peak
  }
  byKey.set(k, waves);
  return waves;
}

/**
 * `n` band-limited sawtooth PeriodicWaves whose harmonics are phase-rotated by 2π·i/n (i.e. the same saw
 * started at n different phases). Picking one at random per oscillator gives random start phase, so notes
 * don't all share the same comb-filtered attack (REVIEW 3.3). Cached per context.
 * @param {BaseAudioContext} ctx
 * @param {number} [n=8]
 * @returns {PeriodicWave[]}
 */
export function phaseRotatedSawWaves(ctx, n = 8) {
  const H = 512;
  const sin = new Float32Array(H + 1);
  for (let k = 1; k <= H; k++) sin[k] = ((k % 2 ? 1 : -1) * 2) / (Math.PI * k); // Σ (−1)^(k+1)·2/(πk)·sin(kωt)
  return rotatedWaves(ctx, 'saw', sin, n);
}

const CLIP_CACHE = new Map();

/**
 * Symmetric soft-clip curve y = tanh(g·x)/tanh(g), g = 10^(driveDb/20), over x ∈ [−1, 1] (odd length so 0→0).
 * Use with pre-/post-gain nodes so the drive amount stays automatable.
 * @param {number} driveDb
 * @returns {Float32Array}
 */
export function softClipCurve(driveDb) {
  const key = Math.round(driveDb * 100);
  if (CLIP_CACHE.has(key)) return CLIP_CACHE.get(key);
  const g = Math.pow(10, driveDb / 20);
  const N = 2049;
  const c = new Float32Array(N);
  const norm = Math.tanh(g);
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    c[i] = Math.tanh(g * x) / norm;
  }
  c[(N - 1) / 2] = 0;
  CLIP_CACHE.set(key, c);
  return c;
}

/**
 * Keytracking multiplier: 2^(amount·(note − refNote)/12). amount 1 = follows pitch fully, 0.5 = 50 %.
 * @param {number} note
 * @param {number} refNote
 * @param {number} amount
 * @returns {number}
 */
export function keytrack(note, refNote, amount) {
  return Math.pow(2, (amount * (note - refNote)) / 12);
}

// ---- filter Q (review m1) ---------------------------------------------------------------------------------
// Web Audio `lowpass`/`highpass` Q is a resonance in dB (alpha = sin w0 / (2·10^(Q/20))); bandpass/peaking Q is
// linear. So a "Butterworth Q .707" written as a number is really +0.7 dB of resonance. Always convert.
/** Linear biquad Q → the dB value a Web Audio lowpass/highpass expects. */
export const qDb = (q) => 20 * Math.log10(q);
/** 2-pole Butterworth (linear Q 1/√2) for a Web Audio LP/HP: −3.01 dB (−3 dB at fc, maximally flat). */
export const BUTTER2_Q = qDb(Math.SQRT1_2);
/** 4-pole Butterworth as two biquads (linear Q .5412 / 1.3066): −5.33 / +2.32 dB. */
export const BUTTER4_Q = Object.freeze([qDb(0.5412), qDb(1.3066)]);

// ---- FM Nyquist guard (review M3, m6, m9) ------------------------------------------------------------------
/** FM sidebands must stay below this fraction of the sample rate. */
export const FM_EDGE = 0.45;
/**
 * Sidebands counted above the index: Carson's rule is I + 1 (98 % of the power); that still folds the
 * (I+2)-th sideband back at −26…−29 dB of the total on E6–G6 bells, so the guard uses I + 1.5
 * (every bell note/morph/index/ratio corner then aliases < −33 dB, measured).
 */
export const FM_MARGIN = 1.5;

/**
 * Largest FM index whose sidebands stay under `edge`·sr: f + extraHz + (I + FM_MARGIN)·fm ≤ edge·sr.
 * `extraHz` = upper bandwidth already used by other modulators on the same carrier (their I·fm).
 * Depends on f and fm, so it is a per-note, keytracked (and ratio-tracked) index limit.
 * @param {number} sr @param {number} f carrier Hz @param {number} fm modulator Hz @param {number} [extraHz=0]
 * @param {number} [edge=FM_EDGE]
 * @returns {number} ≥ 0 (Infinity when fm ≤ 0)
 */
export function fmIndexCap(sr, f, fm, extraHz = 0, edge = FM_EDGE) {
  if (!(fm > 0)) return Infinity;
  return Math.max(0, (edge * sr - f - extraHz) / fm - FM_MARGIN);
}

/**
 * Deviation (Hz) on an FM modulator's gain param: index(t)·fm, index(t) = floor + (i0 − floor)·e^{−(t − t0)/τ},
 * limited to `cap` (hold at the cap until the decay falls under it — scheduled exactly, no timers).
 * `retune(fm, cap, t, dur)` rescales the in-flight deviation when fm moves (legato, ratio/morph), so the
 * *index* (brightness) stays where the envelope has it instead of the deviation in Hz staying fixed.
 */
export class FmDepth {
  /**
   * @param {AudioParam} param modulator GainNode.gain
   * @param {{i0:number, floor?:number, tau?:number, fm:number, cap?:number, t0:number}} o
   */
  constructor(param, { i0, floor = 0, tau = Infinity, fm, cap = Infinity, t0 }) {
    Object.assign(this, { param, i0, floor, tau, fm, cap, t0 });
    this._g = null; // current retune glide {t, t1, from, to}
    this._schedule(t0, NaN, 0);
  }

  /** Nominal (uncapped) index at `t`. */
  index(t) {
    if (!(this.tau < Infinity)) return this.i0;
    return this.floor + (this.i0 - this.floor) * Math.exp(-Math.max(0, t - this.t0) / this.tau);
  }

  /** Scheduled deviation (Hz) at `t`. */
  valueAt(t) {
    const g = this._g;
    if (g && t < g.t1) return t <= g.t ? g.from : g.from + ((g.to - g.from) * (t - g.t)) / (g.t1 - g.t);
    return Math.min(this.index(t), this.cap) * this.fm;
  }

  _schedule(t, from, dur) {
    const p = this.param;
    const t1 = t + Math.max(0, dur);
    const iT = this.index(t1);
    const v1 = Math.min(iT, this.cap) * this.fm;
    if (dur > 0 && Number.isFinite(from)) {
      if (from > 1e-3 && v1 > 1e-3) glideTo(p, v1, t, dur, { from }); // ∝ fm, which glides exponentially
      else linearTo(p, v1, t, dur, { from });
      this._g = { t, t1, from, to: v1 };
    } else {
      setNow(p, v1, t);
      this._g = null;
    }
    if (!(this.tau < Infinity) || !(iT > this.floor)) return;
    const target = Math.min(this.floor, this.cap) * this.fm;
    if (iT <= this.cap) rampTo(p, target, t1, this.tau);
    else if (this.cap > this.floor) {
      // held at the cap until the nominal decay crosses it, then the same exponential
      const tc = this.t0 + this.tau * Math.log((this.i0 - this.floor) / (this.cap - this.floor));
      rampTo(p, target, Math.max(t1, tc), this.tau);
    }
  }

  /** New modulator frequency / cap from `t`, reached over `dur` seconds. */
  retune(fm, cap, t, dur = 0) {
    const from = this.valueAt(t);
    this.fm = fm;
    this.cap = cap;
    this._schedule(t, from, dur);
  }
}

// ---- random start phase (review m8) ------------------------------------------------------------------------
/** 8 phase rotations of a sine (rotation i = phase 2πi/8; rotation (k·i) mod 8 is the k-th harmonic locked to it). */
export function sineWaves(ctx, n = 8) {
  return rotatedWaves(ctx, 'sine', [0, 1], n);
}

/** 8 phase rotations of a band-limited triangle (63 harmonics; peak 1 like the built-in type). */
export function triangleWaves(ctx, n = 8) {
  const sin = new Float32Array(64);
  for (let k = 1; k <= 63; k += 2) sin[k] = (((k - 1) / 2) % 2 ? -1 : 1) / (k * k);
  return rotatedWaves(ctx, 'tri', sin, n);
}

// ---- instrument-bus stages ---------------------------------------------------------------------------------
/**
 * Low-band-mono bus stage (SPEC §3.3 warm-pad "mono below 150 Hz", review m7): out = M ± HPF₄(S), M = (L+R)/2,
 * S = (L−R)/2, 4-pole Butterworth (corner `freq`) on the side only. The mid — and so the mono fold-down — is
 * untouched; the side keeps everything above `freq`. 9 nodes per instrument, registered with `inst.shared`.
 * @param {{ctx:BaseAudioContext, shared:(n:AudioNode)=>AudioNode}} inst
 * @param {number} [freq=150]
 * @returns {{input:AudioNode, output:AudioNode}}
 */
export function monoBelow(inst, freq = 150) {
  const ctx = inst.ctx;
  const mono = { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' };
  const input = inst.shared(new GainNode(ctx, { gain: 1, channelCount: 2, channelCountMode: 'explicit' }));
  const split = inst.shared(new ChannelSplitterNode(ctx, { numberOfOutputs: 2 }));
  const mid = inst.shared(new GainNode(ctx, { gain: 1, ...mono })); // speakers down-mix: (L+R)/2
  const sL = inst.shared(new GainNode(ctx, { gain: 0.5, ...mono }));
  const sR = inst.shared(new GainNode(ctx, { gain: -0.5, ...mono }));
  const h1 = inst.shared(new BiquadFilterNode(ctx, { type: 'highpass', frequency: freq, Q: BUTTER4_Q[0], ...mono }));
  const h2 = inst.shared(new BiquadFilterNode(ctx, { type: 'highpass', frequency: freq, Q: BUTTER4_Q[1], ...mono }));
  const sNeg = inst.shared(new GainNode(ctx, { gain: -1, ...mono }));
  const out = inst.shared(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
  input.connect(mid);
  input.connect(split);
  split.connect(sL, 0);
  split.connect(sR, 1);
  sL.connect(h1);
  sR.connect(h1);
  h1.connect(h2);
  mid.connect(out, 0, 0);
  mid.connect(out, 0, 1);
  h2.connect(out, 0, 0);
  h2.connect(sNeg).connect(out, 0, 1);
  return { input, output: out };
}

const CEIL_CACHE = new Map();
/**
 * Static soft ceiling over x ∈ [−range, range] (curve index u ∈ [−1, 1] ↔ x = range·u): identity up to the
 * knee, then k + (c − k)·tanh((|x| − k)/(c − k)) — slope 1 at the knee, asymptote c. Odd, so no DC.
 * @param {number} [ceilDb=-1] @param {number} [kneeDb=-6] @param {number} [range=4]
 * @returns {Float32Array}
 */
export function softCeilingCurve(ceilDb = -1, kneeDb = -6, range = 4) {
  const key = `${ceilDb}/${kneeDb}/${range}`;
  if (CEIL_CACHE.has(key)) return CEIL_CACHE.get(key);
  const c = Math.pow(10, ceilDb / 20);
  const k = Math.pow(10, kneeDb / 20);
  const N = 8193;
  const curve = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = range * ((i / (N - 1)) * 2 - 1);
    const a = Math.abs(x);
    const y = a <= k ? a : k + (c - k) * Math.tanh((a - k) / (c - k));
    curve[i] = Math.sign(x) * y;
  }
  curve[(N - 1) / 2] = 0;
  CEIL_CACHE.set(key, curve);
  return curve;
}

/**
 * Per-instrument output ceiling (review m8): a memoryless soft-knee WaveShaper after the instrument's trim, so
 * 16 voices at velocity 1 peak ≤ −1 dBFS without any gain riding (no pumping, no lookahead latency:
 * oversample 'none'). Exactly linear below the knee (−4 dBFS), i.e. inert at calibrated playing levels (a
 * C-E-G at velocity 96 peaks ≤ −5.4 dBFS on every patch/preset — the bell's FM onset is the highest).
 * Call at the END of a constructor: the old `inst.output` (trim) becomes `inst.trimNode` and keeps every
 * internal connection; `inst.output` becomes the ceiling's output (what the engine connects).
 * @param {InstrumentBase} inst
 * @param {{ceilDb?:number, kneeDb?:number}} [o]
 * @returns {GainNode} the new output
 */
export function addOutputCeiling(inst, { ceilDb = -1, kneeDb = -4 } = {}) {
  const ctx = inst.ctx;
  const R = 4; // handles up to +12 dBFS before the curve's end
  const trim = inst.output;
  inst.shared(trim);
  const pre = inst.shared(new GainNode(ctx, { gain: 1 / R }));
  const shaper = inst.shared(new WaveShaperNode(ctx, { curve: softCeilingCurve(ceilDb, kneeDb, R), oversample: 'none' }));
  const out = new GainNode(ctx, { gain: 1 });
  trim.connect(pre).connect(shaper).connect(out);
  inst.trimNode = trim;
  inst.ceiling = shaper;
  inst.output = out;
  return out;
}

/** Linear interpolation. */
export const lerp = (a, b, x) => a + (b - a) * x;
/** Clamp. */
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Resolve a param table + overrides into a values object (numbers clamped, bools/enums passed through).
 * @param {Array<{key:string,min?:number,max?:number,default:any,unit:string,enum?:string[]}>} params
 * @param {object} [overrides]
 */
export function resolveParams(params, overrides = {}) {
  const out = {};
  for (const p of params) out[p.key] = coerceParam(p, overrides && p.key in overrides ? overrides[p.key] : p.default);
  return out;
}

/** Coerce one value to a param's type/range (invalid → default). */
export function coerceParam(p, value) {
  if (p.unit === 'bool') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value >= 0.5;
    if (typeof value === 'string') return ['true', 'on', '1'].includes(value.toLowerCase());
    return !!p.default;
  }
  if (p.unit === 'enum') {
    if (p.enum.includes(value)) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return p.enum[clamp(Math.round(value), 0, p.enum.length - 1)];
    return p.default;
  }
  const v = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(v)) return p.default;
  let r = clamp(v, p.min, p.max);
  if (p.step === 1) r = Math.round(r);
  return r;
}

/**
 * Shared plumbing for SynthInstrument / OrganInstrument (SPEC §3.2 Instrument):
 * output GainNode, voice bus, allocator, bend source (cents → every oscillator's detune), param store,
 * shared-node bookkeeping for dispose. Subclasses implement `_buildVoice(v, note, vel, t)`,
 * `_applyParam(key, value, t)`, `_morph(x, t)`, `_glide(v, note, t)`.
 */
export class InstrumentBase {
  /**
   * @param {BaseAudioContext} ctx
   * @param {*} prng Rng from shared/prng.js (forked), a () => [0,1) function, or a seed
   * @param {{id:string, params:object[]}} meta
   * @param {object} [initialParams]
   */
  constructor(ctx, prng, meta, initialParams) {
    this.ctx = ctx;
    this.rng = asRng(prng);
    this.meta = meta;
    this.id = meta.id;
    this.params = resolveParams(meta.params, initialParams || {});
    this.morphX = 0;
    this.bendSemis = 0;
    this.disposed = false;
    this._sharedNodes = [];
    this._sharedSources = [];
    /** Instrument output (stereo). */
    this.output = new GainNode(ctx, { gain: 1 });
    /** Sum of all voices; subclasses route it to `output` through their post chain. */
    this.bus = this.shared(new GainNode(ctx, { gain: 1 }));
    this.alloc = new VoiceAllocator(MAX_VOICES, STEAL_FADE);
    /** Pitch bend in cents, summed into every oscillator's detune (one node per instrument). */
    this.bendCS = this.sharedSource(new ConstantSourceNode(ctx, { offset: 0 }));
    this.ready = Promise.resolve();
  }

  /** Register an instrument-level node (disconnected at dispose). */
  shared(node) {
    this._sharedNodes.push(node);
    return node;
  }

  /** Register and start an instrument-level source (LFOs, control constants). */
  sharedSource(src) {
    this._sharedNodes.push(src);
    this._sharedSources.push(src);
    src.start(this.ctx.currentTime);
    return src;
  }

  _t(when) {
    return atTime(this.ctx, when);
  }

  /** @returns {Voice|null} */
  noteOn(note, vel01, when) {
    if (this.disposed) return null;
    const t = this._t(when);
    const n = clamp(Math.round(Number(note) || 0), 0, 127);
    const vel = clamp(Number.isFinite(vel01) ? vel01 : 0.8, 0, 1);
    this.alloc.makeRoom(t);
    const v = new Voice(this.ctx, n, t);
    try {
      this._buildVoice(v, n, vel, t);
    } catch (e) {
      console.warn(`[${this.id}] noteOn failed:`, e);
      v.kill(t);
      if (!v.sources.length) v._teardown();
    }
    return this.alloc.add(v);
  }

  noteOff(voice, when) {
    if (voice && typeof voice.releaseAt === 'function') voice.releaseAt(this._t(when));
  }

  /** Click-free kill of one voice (re-strike of a pedaled note: 30 ms). */
  fadeOutVoice(voice, when, fadeSec = 0.03) {
    if (voice && typeof voice.fadeOut === 'function') voice.fadeOut(this._t(when), fadeSec);
  }

  allOff(when, fadeSec = 0.03) {
    this.alloc.allOff(this._t(when), fadeSec);
  }

  setParam(key, value, when) {
    if (this.disposed) return false;
    const p = this.meta.params.find((x) => x.key === key);
    if (!p) {
      console.warn(`[${this.id}] unknown param "${key}"`);
      return false;
    }
    const v = coerceParam(p, value);
    this.params[key] = v;
    try {
      this._applyParam(key, v, this._t(when));
    } catch (e) {
      console.warn(`[${this.id}] setParam ${key} failed:`, e);
    }
    return true;
  }

  getParam(key) {
    return this.params[key];
  }

  morph(x01, when) {
    if (this.disposed) return;
    const x = clamp(Number(x01) || 0, 0, 1);
    this.morphX = x;
    this._morph(x, this._t(when));
  }

  setBend(semis, when) {
    if (this.disposed) return;
    const s = Number(semis) || 0;
    this.bendSemis = s;
    rampTo(this.bendCS.offset, s * 100, this._t(when), 0.008);
  }

  /** Mono legato: retune a sounding voice to `note` (glide). */
  legatoTo(voice, note, when) {
    if (!voice || voice.state === 'dead' || this.disposed) return voice;
    const n = clamp(Math.round(Number(note) || 0), 0, 127);
    voice.note = n;
    this._glide(voice, n, this._t(when));
    return voice;
  }

  liveVoiceCount() {
    return this.alloc.size;
  }

  liveNodeCount() {
    return this.alloc.liveNodes();
  }

  /** Iterate voices that still sound (held/released). */
  forVoices(fn) {
    for (const v of this.alloc.voices) if (v.state === 'held' || v.state === 'released') fn(v);
  }

  /** Oscillator helper: bend-linked, tracked, started. `wave` = PeriodicWave or a type string. */
  osc(v, wave, freq, detune, t) {
    const opts = { frequency: freq, detune: detune || 0 };
    if (typeof wave === 'string') opts.type = wave;
    else {
      opts.type = 'custom';
      opts.periodicWave = wave;
    }
    const o = new OscillatorNode(this.ctx, opts);
    // detune only carries bend / vibrato / drift (≤ 8 Hz): k-rate saves the per-sample pitch computation
    try {
      o.detune.automationRate = 'k-rate';
    } catch (e) {
      /* stays a-rate */
    }
    v.link(this.bendCS, o.detune);
    v.addSource(o, t);
    return o;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const now = this.ctx.currentTime;
    this.alloc.killAll(now);
    for (const s of this._sharedSources) {
      try {
        s.stop(now);
      } catch (e) {
        /* ignore */
      }
    }
    for (const n of this._sharedNodes) {
      try {
        n.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
    try {
      this.output.disconnect();
    } catch (e) {
      /* ignore */
    }
  }

  // subclass hooks
  _buildVoice() {}
  _applyParam() {}
  _morph() {}
  _glide() {}
}
