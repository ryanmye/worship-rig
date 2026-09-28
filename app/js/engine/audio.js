// AudioEngine (SPEC §3, §0). The only stateful audio object the controller talks to.
//
// Key rules implemented here:
//  * MainStage switching (§0.3): commit() moves the old slot channels (instrument + its own strip) to `retiring`;
//    physically-held and pedal-held voices keep sounding there until their own release. Only new note-ons reach
//    the new instruments. A retired channel is disposed after its live voice count has been 0 for 1 s
//    (audio-clock polling, never setTimeout).
//  * Voices are tracked by physical key (`sounding: Map<physNote, {slotIndex, instrument, voice}[]>`); split,
//    transpose and velocity curve are evaluated once, at noteOn.
//  * Every public time-sensitive call takes `{ when }` (ctx seconds); internal timing is event-time based, so the
//    engine renders correctly into an OfflineAudioContext.
//  * prepare() does all expensive work (instrument construction, sample decode, reverb IR); commit() only
//    connects and schedules gains.
import { rampTo, setNow } from '../shared/automation.js';
import { hashSeed } from '../shared/prng.js';
import { PARAMS, parsePath, clamp as clampParam, defaultSlot, SLOT_COUNT } from '../shared/params.js';
import { spellingPreference, clampMidi, mod12 } from '../shared/music.js';
import { chordName } from '../shared/chords.js';
import { FxGraph, Channel, AudioTimer, Coalescer, rngFor, isOfflineContext, linFrom, glideFrom, measureCompMakeup, measureGlueRef, resolveSlotEq, slotEqResponse } from './fx.js';
import { InstrumentRegistry } from './instruments.js';
import { BufferCache } from './sampler.js';
import { Drone } from './drone.js';

const MB = 1024 * 1024;
const lerp = (a, b, x) => a + (b - a) * x;
const clamp01 = (x) => Math.min(1, Math.max(0, Number(x) || 0));
const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
// macro.intensity → morph() of these (type:id). organ soft-pad: morph ≥ .5 switches its rotary speed.
const PAD_LIKE = new Set(['synth:warm-pad', 'synth:glass-pad', 'synth:strings', 'synth:supersaw-pad', 'synth:juno-pad', 'synth:shimmer-pad', 'organ:soft-pad']);
/** Default sample manifests, relative to the app root: factory + the optional "My Samples" one. */
export const DEFAULT_MANIFEST_URLS = Object.freeze(['./samples/manifest.json', './api/user-samples/manifest.json']);
const APP_ROOT = new URL('../../', import.meta.url);
const WHEEL_TARGETS = new Set(['drone.gain', 'fx.reverb.returnGain', 'master.volume', 'macro.intensity', 'macro.wash', 'none']);

function paramDefault(path) {
  const e = PARAMS.find((p) => p.path === path);
  return e ? e.default : undefined;
}

/** Default Patch (SPEC §2) filled from the PARAMS table. */
export function defaultPatch() {
  const fx = {};
  for (const e of PARAMS) {
    if (!e.path.startsWith('fx.')) continue;
    const [, unit, key] = e.path.split('.');
    (fx[unit] = fx[unit] || {})[key] = e.default;
  }
  fx.master = { volume: paramDefault('master.volume') };
  return {
    slots: [null, null, null, null],
    fx,
    modWheel: { target: 'slots.1.gain', min: 0, max: 1 },
    expression: { target: 'slots.1.gain', min: 0, max: 1 },
    volume: { target: 'master.volume' },
    bend: { mode: 'pitch', range: 2 },
    swell: { seconds: 8 },
  };
}

/**
 * A slot's stored eq, clamped: every present key with a `slots.<i>.eq.*` PARAMS row, band objects (b1…b8) field by
 * field; anything else dropped (DECISION §3: the old code rebuilt {low, high} and lost every other field).
 */
function normalizeSlotEq(i, eq) {
  const out = {};
  if (!eq || typeof eq !== 'object') return out;
  for (const [k, v] of Object.entries(eq)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const b = {};
      for (const [f, x] of Object.entries(v)) {
        const p = `slots.${i}.eq.${k}.${f}`;
        if (x !== undefined && parsePath(p)) b[f] = clampParam(p, x);
      }
      if (Object.keys(b).length) out[k] = b;
    } else if (parsePath(`slots.${i}.eq.${k}`)) out[k] = clampParam(`slots.${i}.eq.${k}`, v);
  }
  return out;
}

function validTarget(t) {
  return typeof t === 'string' && (WHEEL_TARGETS.has(t) || /^slots\.[0-3]\.gain$/.test(t));
}

/** Fill defaults, clamp everything through params.clamp. Returns a private deep copy. */
export function normalizePatch(patch) {
  const d = defaultPatch();
  const p = clone(patch) || {};
  const out = { ...d, ...p };
  out.fx = {};
  for (const unit of Object.keys(d.fx)) {
    out.fx[unit] = { ...d.fx[unit] };
    for (const [k, v] of Object.entries(p.fx?.[unit] || {})) {
      const path = unit === 'master' ? `master.${k}` : `fx.${unit}.${k}`;
      if (parsePath(path)) out.fx[unit][k] = clampParam(path, v);
    }
  }
  out.slots = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const s = p.slots?.[i];
    if (!s || !s.instrument || !s.instrument.type || !s.instrument.id) {
      out.slots.push(null);
      continue;
    }
    const base = defaultSlot(i, { type: s.instrument.type, id: s.instrument.id });
    const slot = { ...base, ...s, instrument: { type: s.instrument.type, id: s.instrument.id } };
    slot.sends = { ...base.sends, ...(s.sends || {}) };
    slot.params = { ...(s.params || {}) };
    for (const k of ['gain', 'pan', 'octave', 'transpose', 'lowNote', 'highNote', 'sustain', 'mono', 'velocityCurve', 'bendEnabled'])
      slot[k] = clampParam(`slots.${i}.${k}`, slot[k]);
    for (const k of ['reverb', 'delay', 'chorus']) slot.sends[k] = clampParam(`slots.${i}.sends.${k}`, slot.sends[k]);
    slot.width = clampParam(`slots.${i}.width`, s.width);
    slot.eq = normalizeSlotEq(i, s.eq);
    out.slots.push(slot);
  }
  for (const k of ['modWheel', 'expression']) {
    const r = { ...d[k], ...(p[k] || {}) };
    if (!validTarget(r.target)) r.target = d[k].target;
    r.min = clamp01(r.min ?? 0);
    r.max = clamp01(r.max ?? 1);
    out[k] = r;
  }
  out.volume = { ...d.volume, ...(p.volume || {}) };
  if (!validTarget(out.volume.target)) out.volume.target = d.volume.target;
  out.bend = { ...d.bend, ...(p.bend || {}) };
  if (!['pitch', 'morph', 'drone-swell', 'tape', 'none'].includes(out.bend.mode)) out.bend.mode = 'pitch';
  out.bend.range = Math.min(24, Math.max(0, Number(out.bend.range) || 2));
  out.swell = { seconds: Math.min(60, Math.max(0.5, Number(p.swell?.seconds) || 8)) };
  return out;
}

const sameRef = (a, b) => a && b && a.type === b.type && a.id === b.id;

/** Param equality across the shapes instruments use (numbers, booleans stored as 0/1, enum strings). */
function sameVal(a, b) {
  if (a === b) return true;
  const na = typeof a === 'boolean' ? +a : typeof a === 'number' ? a : typeof a === 'string' && a.trim() !== '' ? Number(a) : NaN;
  const nb = typeof b === 'boolean' ? +b : typeof b === 'number' ? b : typeof b === 'string' && b.trim() !== '' ? Number(b) : NaN;
  if (Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) <= 1e-9 * Math.max(1, Math.abs(na));
  return String(a) === String(b);
}

/** Velocity curve (SPEC §2 Slot.velocityCurve). */
export function curveVelocity(vel127, curve) {
  const v = Math.min(1, Math.max(0, (Number(vel127) || 0) / 127));
  if (curve === 'soft') return Math.pow(v, 0.6);
  if (curve === 'hard') return Math.pow(v, 1.6);
  if (curve === 'fixed') return 100 / 127;
  return v;
}

export class AudioEngine extends EventTarget {
  /**
   * @param {{context?:BaseAudioContext, seed?:number|string, latency?:'interactive'|number, manifestUrl?:string,
   *          manifestUrls?:string[], instrumentModules?:boolean, lofi?:boolean, glue?:boolean, cacheMB?:number,
   *          sinkId?:string, clipOversample?:'none'|'2x'|'4x'}} [opts]
   * manifestUrls: [factory, ...optional "My Samples" manifests], relative URLs resolve against the app root.
   * Default DEFAULT_MANIFEST_URLS; a lone `manifestUrl` (tests) means just that one.
   */
  constructor(opts = {}) {
    super();
    this.ctx = opts.context || null;
    this._ownCtx = !opts.context;
    this.seed = typeof opts.seed === 'string' ? hashSeed(opts.seed) : (Number(opts.seed ?? 1) >>> 0);
    this.latency = opts.latency ?? 'interactive';
    this.sinkId = opts.sinkId ?? 'default';
    const urls = Array.isArray(opts.manifestUrls) && opts.manifestUrls.length ? opts.manifestUrls : opts.manifestUrl ? [opts.manifestUrl] : DEFAULT_MANIFEST_URLS;
    this.manifestUrls = urls.map((u) => new URL(u, APP_ROOT).href);
    this.manifestUrl = this.manifestUrls[0];
    this._lofiOpt = opts.lofi !== false;
    this._glueOpt = opts.glue !== false;
    this._clipOs = ['none', '2x', '4x'].includes(opts.clipOversample) ? opts.clipOversample : 'none';
    this._warned = new Set();
    this.cache = new BufferCache({ capBytes: (opts.cacheMB ?? 700) * MB, warn: (m) => this._warn(m) });
    this.registry = new InstrumentRegistry({
      manifestUrls: this.manifestUrls,
      bufferCache: this.cache,
      warn: (m) => this._warn(m),
      useModules: opts.instrumentModules !== false,
    });
    this._irCache = new Map();
    this._resetState();
    this._patch = normalizePatch({});
    this._routing = { modWheel: this._patch.modWheel, expression: this._patch.expression, volume: this._patch.volume, bend: this._patch.bend, swell: this._patch.swell };
    this.transpose = 0;
    this.tempo = null;
    this.keyPref = 'flat';
    this._keyCtx = { pc: 0, minor: false };
    this._startP = null;
    this._tokenSeq = 0;
    this._latestToken = 0;
    this._plan = null;
    this._instSeq = 0;
    this._monoOut = false;
  }

  _resetState() {
    this.slots = [null, null, null, null];
    this.retiring = [];
    this.held = new Set();
    this.sounding = new Map();
    this.pedal = false;
    this.pedaled = new Set();
    this.bend = 0;
    this.wheel = { mod: 1, expr: 1, vol: 1 };
    this._modOwner = 'hw';
    this._pickup = null;
    this._swell = null;
    this._fade = null;
    this._lastChord = null;
    this._pollArmed = false;
    this._morphBend = 0;
    this._tapeX = 0;
    this._tapeSegs = []; // scheduled delay-time segments {t0, dur, from, to}, ascending t0
  }

  // ----- lifecycle -----------------------------------------------------------------------------------------------
  get offline() {
    return isOfflineContext(this.ctx);
  }

  /** Idempotent. Offline ctx: skips resume; files-mode drone disabled (warn on use). */
  start() {
    if (!this._startP) this._startP = this._start();
    return this._startP;
  }

  async _start() {
    if (!this.ctx) this.ctx = this._newContext();
    if (!this.offline && this.ctx.state !== 'running') {
      try {
        await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 1500))]);
      } catch (e) {
        this._warn(`AudioContext resume failed: ${e.message || e}`);
      }
    }
    this._build();
    await Promise.all([
      this.registry.init(),
      this._reverbInit,
      measureCompMakeup().then((m) => this.fx?.setCompMakeup(m)),
      measureGlueRef().then((t) => {
        this.fx?.setGlueRef(t);
        if (this.fx?.glueEngaged) this.fx.setGlue(this._patch.fx.comp.amount, this.ctx.currentTime); // refresh makeup
      }),
    ]);
    this._afterRegistry();
    this.ctx.onstatechange = () => this._emit('statechange', { state: this.ctx.state, latencyMs: this.latencyMs });
    this._emit('statechange', { state: this.ctx.state, latencyMs: this.latencyMs });
    this._emit('ready', { phase: 'start' });
    return this;
  }

  _newContext() {
    const o = { latencyHint: this.latency === 'interactive' || this.latency == null ? 'interactive' : Number(this.latency) };
    if (this.sinkId && this.sinkId !== 'default') o.sinkId = this.sinkId;
    try {
      return new AudioContext(o);
    } catch (e) {
      delete o.sinkId;
      return new AudioContext(o);
    }
  }

  _build() {
    const ctx = this.ctx;
    this.timer = new AudioTimer(ctx);
    this.coalesce = new Coalescer(this.timer, 0.01);
    this.fx = new FxGraph(ctx, { seed: this.seed, timer: this.timer, irCache: this._irCache, lofi: this._lofiOpt, clipOversample: this._clipOs, glue: this._glueOpt });
    this.fx.reverb.predelayV = this._patch.fx.reverb.predelay;
    this._reverbInit = this.fx.reverb.init(this._effReverbSize(), this._patch.fx.reverb.damp).catch((e) => this._warn(`Reverb IR build failed: ${e.message || e}`));
    this._applyFx(this._patch.fx, 0, null, true);
    this.drone = new Drone({
      ctx,
      registry: this.registry,
      rng: rngFor(this.seed, 'drone'),
      timer: this.timer,
      sum: this.fx.sum,
      reverbIn: this.fx.reverb.input,
      warn: (m) => this._warn(m),
    });
    if (this._monoOut) this.fx.setMono(true, 0);
    if (this.tempo) this.fx.delay.tempo = this.tempo;
  }

  /** After registry.init(): drone synth trim (gain-trims.json droneTrim) and the drone's reusable instruments. */
  _afterRegistry() {
    const d = this.drone;
    if (!d) return;
    const real = !!this.registry.synthModuleLoaded;
    const db = real ? Number(this.registry.gainTrims?.droneTrim) || 0 : 0;
    d.setTrim(db);
    d.warm(); // realtime: one reusable drone-osc instrument built in idle time (not on the first key change)
  }

  get recordTap() {
    return this.fx?.recordTap || null;
  }
  get analyserL() {
    return this.fx?.analyserL || null;
  }
  get analyserR() {
    return this.fx?.analyserR || null;
  }
  get latencyMs() {
    const c = this.ctx;
    if (!c) return 0;
    return ((c.baseLatency || 0) + (c.outputLatency || 0)) * 1000;
  }

  /** New context + graph, re-applies the current state. Decoded buffers (cache) survive. */
  async restart({ latency, sinkId } = {}) {
    if (latency !== undefined) this.latency = latency;
    if (sinkId !== undefined) this.sinkId = sinkId;
    const state = this.getState();
    const files = this.drone?.files ? [...this.drone.files.entries()] : null;
    const old = this.ctx;
    this._teardown();
    if (old && !isOfflineContext(old)) {
      try {
        await old.close();
      } catch {}
    }
    this.ctx = this._newContext();
    this._ownCtx = true;
    this._startP = null;
    await this.start();
    // the new Drone keeps the pad files, so a files-mode drone comes back as files (not the synth fallback)
    if (files && this.drone) this.drone.files = new Map(files);
    await this.applyState(state);
    this._emit('statechange', { state: this.ctx.state, latencyMs: this.latencyMs, restarted: true });
    return this;
  }

  async setSinkId(id) {
    this.sinkId = id || 'default';
    if (this.ctx && typeof this.ctx.setSinkId === 'function') {
      try {
        await this.ctx.setSinkId(this.sinkId === 'default' ? '' : this.sinkId);
        this._emit('statechange', { state: this.ctx.state, latencyMs: this.latencyMs });
        return true;
      } catch (e) {
        this._warn(`setSinkId failed (${e.message || e}); restarting audio.`);
      }
    }
    await this.restart({ sinkId: this.sinkId });
    return true;
  }

  setMono(on) {
    this._monoOut = !!on;
    this.fx?.setMono(this._monoOut, this.ctx.currentTime);
  }

  _teardown() {
    for (const sc of [...this.slots, ...this.retiring]) if (sc) this._disposeChannel(sc);
    if (this._plan) this._discardPlan(this._plan);
    this._plan = null;
    this.drone?.dispose();
    this.timer?.dispose();
    this.fx?.dispose();
    this._resetState();
  }

  dispose() {
    this._teardown();
    if (this._ownCtx && this.ctx && !this.offline) this.ctx.close().catch(() => {});
    this._startP = null;
  }

  // ----- events / helpers ----------------------------------------------------------------------------------------
  _emit(type, detail) {
    try {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    } catch (e) {
      console.warn('[engine] listener error', e);
    }
  }
  _warn(message, once = true) {
    if (once) {
      if (this._warned.has(message)) return;
      this._warned.add(message);
    }
    console.warn(`[engine] ${message}`);
    this._emit('warn', { message });
  }
  _t(when) {
    const now = this.ctx ? this.ctx.currentTime : 0;
    return Number.isFinite(when) && when > now ? when : now;
  }

  /** Audio-clock callback (tests use it to act mid-render in an OfflineAudioContext). */
  at(when, cb) {
    if (!this.timer) {
      this._warn('engine.at() before start(); ignored.');
      return () => {};
    }
    return this.timer.at(when, cb);
  }

  // ----- instruments ---------------------------------------------------------------------------------------------
  listInstruments() {
    return this.registry.list();
  }

  /**
   * Re-read the "My Samples" manifests (controller.rescanUserSamples after the server rescanned the folders).
   * Songs already prepared keep their instruments; new prepares see the new list. Emits 'instruments' {count}.
   * @returns {Promise<object[]>} listInstruments()
   */
  async reloadManifests() {
    await this.registry.init();
    const count = await this.registry.reloadSecondary();
    this._emit('instruments', { count });
    return this.listInstruments();
  }

  // ----- patch lifecycle -----------------------------------------------------------------------------------------
  /**
   * Build everything for `patchState`. Resolves with a token; only the latest token can be committed.
   * @returns {Promise<number>}
   */
  async prepare(patchState) {
    await this.start();
    const token = ++this._tokenSeq;
    this._latestToken = token;
    if (this._plan) this._discardPlan(this._plan);
    this._plan = null;
    const p = normalizePatch(patchState);
    const plan = { token, patch: p, slots: [], created: [], reverb: null, committed: false };
    // reverb unit (IR off the main thread + convolver buffer) in parallel with the instruments. The size staged is
    // the *effective* one: with a wheel on macro.wash it is lerp(size, .9, wash) under the new song's routing, so
    // commit lands on the washed IR directly (round2-engine M2: it used to land on the plain size and stay there).
    const R2 = { ...this._routing };
    this._routingInto(R2, p);
    const W2 = this._macro('macro.wash', R2);
    const stageSize = W2 === null ? p.fx.reverb.size : lerp(p.fx.reverb.size, 0.9, W2);
    const reverbP = this.fx.reverb.stage(stageSize, p.fx.reverb.damp).then(
      (st) => (plan.reverb = st),
      (e) => this._warn(`Reverb IR build failed: ${e?.message || e}`),
    );
    this.fx.lofi?.warmCurves(p.fx.lofi);
    const ctx = this.ctx;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = p.slots[i];
      const cur = this.slots[i];
      if (!s) plan.slots.push(null);
      // same instrument with the same effective params → keep the instance; otherwise a fresh one (so no
      // setting of the previous song leaks into this one, and any expensive rebuild happens here, not in commit)
      else if (cur && sameRef(cur.ref, s.instrument) && this._paramsMatch(cur, s)) plan.slots.push({ reuse: cur, cfg: s });
      else {
        const ref = s.instrument;
        const rng = rngFor(this.seed, `inst|${i}|${ref.type}|${ref.id}|${++this._instSeq}`);
        let inst;
        try {
          inst = this.registry.create(ctx, rng, ref, s.params, { onProgress: (x) => this._emit('loading', { slot: i, progress: x, token }) });
        } catch (e) {
          this._warn(`Instrument ${ref.type}:${ref.id} failed: ${e.message || e}`);
          plan.slots.push(null);
          continue;
        }
        const strip = new Channel(ctx, this.fx, i);
        inst.output.connect(strip.input);
        const sc = this._newSlotChannel(i, ref, inst, strip, s);
        plan.created.push(sc);
        plan.slots.push({ fresh: sc, cfg: s });
      }
    }
    await Promise.all([
      reverbP,
      ...plan.created.map((sc) =>
        Promise.resolve(sc.inst.ready).catch((e) => this._warn(`${sc.ref.id} failed to load: ${e?.message || e}`)),
      ),
    ]);
    if (token !== this._latestToken) {
      this._discardPlan(plan);
      return token;
    }
    this._plan = plan;
    return token;
  }

  _discardPlan(plan) {
    if (plan.committed) return;
    for (const sc of plan.created) this._disposeChannel(sc);
    plan.created = [];
  }

  /** The instance's effective params (inst.getParam, else its cfg, else the default) equal `cfg.params`? */
  _paramsMatch(sc, cfg) {
    for (const m of this.registry.paramsFor(sc.ref)) {
      const want = cfg.params?.[m.key] ?? m.default;
      const have = typeof sc.inst.getParam === 'function' ? sc.inst.getParam(m.key) : sc.cfg?.params?.[m.key] ?? m.default;
      if (have !== undefined && !sameVal(have, want)) return false;
    }
    return true;
  }

  _newSlotChannel(index, ref, inst, strip, cfg) {
    return {
      index,
      ref: { ...ref },
      inst,
      strip,
      cfg,
      morph: 0, // last morph sent (the instrument starts at 0; commit sends the current value)
      mono: { notes: new Map(), cur: null, pedalHold: false },
      retiring: false,
      zeroSince: null,
    };
  }

  /** Gapless swap (§0.3). Returns false for a stale/superseded/already-committed token. Cheap: gains only. */
  commit(token, { when } = {}) {
    const plan = this._plan;
    if (!plan || plan.token !== token || token !== this._latestToken || plan.committed) return false;
    plan.committed = true;
    this._plan = null;
    const t = this._t(when);
    const p = plan.patch;
    // the new routing first (state only), so fresh strips start at their real wheel factor (REVIEW #11)
    const oldBend = this._routing.bend.mode;
    this._setRoutingState({ modWheel: p.modWheel, expression: p.expression, volume: p.volume, bend: p.bend, swell: p.swell });
    const I = this._macro('macro.intensity');
    for (let i = 0; i < SLOT_COUNT; i++) {
      const cur = this.slots[i];
      const ps = plan.slots[i];
      if (!ps) {
        if (cur) this._retire(cur, t);
        this.slots[i] = null;
        continue;
      }
      if (ps.reuse) {
        if (ps.reuse === cur) {
          this._applySlotCfg(cur, ps.cfg, t, false);
          continue;
        }
        // the channel we planned to reuse is gone (restart/applyState in between): leave the slot empty
        if (cur) this._retire(cur, t);
        this.slots[i] = null;
        continue;
      }
      if (cur) this._retire(cur, t);
      this.slots[i] = ps.fresh;
      this._applySlotCfg(ps.fresh, ps.cfg, t, true);
      const sc = ps.fresh;
      setNow(sc.strip.wheel.gain, this._slotWheelFactor(i, I), t);
      sc.morph = this._morphFor(sc, I);
      sc.inst.morph?.(sc.morph, t);
    }
    this._patch = p;
    Object.assign(this._patch, { modWheel: this._routing.modWheel, expression: this._routing.expression, volume: this._routing.volume, bend: this._routing.bend, swell: this._routing.swell });
    this._applyFx(p.fx, t, plan.reverb, false);
    if (oldBend !== this._routing.bend.mode) this._neutralBend(oldBend, t);
    this._applyWheels(t, 0.03);
    this.drone.songChanged({ when: t });
    this._emit('stats', this._debugStats());
    return true;
  }

  /**
   * Warm the decoded-sample cache (and reverb units, in idle time) for a set of songs; their buffers are pinned
   * (never evicted). `pin`: 'add' (union with the pins already held, so a neighbour preload never unpins the
   * setlist), 'replace' (the pin set becomes exactly these songs), 'none', or 'auto' (default: 'replace' for
   * more than 2 songs — a setlist — else 'add' — prev/next neighbours).
   */
  async preload(patchStates = [], { pin = 'auto' } = {}) {
    await this.start();
    if (pin === 'auto') pin = patchStates.length > 2 ? 'replace' : 'add';
    const { urls, jobs, patches } = this._sampleJobs(patchStates);
    for (const p of patches) this.fx.reverb.warm(p.fx.reverb.size, p.fx.reverb.damp); // off-thread IR, idle-time buffer
    const doPin = () => {
      if (pin === 'replace') this.cache.setPins(urls);
      else if (pin !== 'none') this.cache.pin(urls);
    };
    doPin();
    let i = 0;
    const worker = async () => {
      while (i < jobs.length) {
        const s = jobs[i++];
        await this.cache.acquire(s.url, this.ctx, s.midi, null, s.opts);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
    doPin();
    this._emit('ready', { phase: 'preload', decodedMB: this.cache.decodedMB, pinnedMB: this.cache.pinnedMB });
    return true;
  }

  /** Sample URLs (and decode jobs) the sampler slots of these patches use; unknown instruments are skipped. */
  _sampleJobs(patchStates) {
    const urls = [];
    const jobs = [];
    const patches = [];
    for (const ps of patchStates) {
      const p = normalizePatch(ps);
      patches.push(p);
      for (const s of p.slots) {
        if (!s || s.instrument.type !== 'sampler') continue;
        const def = this.registry.samplers.get(s.instrument.id);
        if (!def) continue;
        for (const L of def.layers) for (const smp of L.samples) {
          urls.push(smp.url);
          jobs.push({ ...smp, opts: def.decodeOpts });
        }
      }
    }
    return { urls, jobs, patches };
  }

  /**
   * Decoded size the samples of these songs would take (shared samples counted once), without decoding: exact for
   * samples decoded before, estimated for the rest (BufferCache.estimateBytes). The controller uses it to decide how
   * much of a setlist to pin (morning-prep). Loads the registry first (start()).
   * @param {object[]} patchStates
   * @returns {Promise<{mb:number, exact:boolean, samples:number, capMB:number}>}
   */
  async estimatePreloadMB(patchStates = []) {
    await this.start();
    const est = this.cache.estimateBytes(this._sampleJobs(patchStates).urls);
    return { mb: est.bytes / MB, exact: est.unknown === 0, samples: est.count, capMB: this.cache.capBytes / MB };
  }

  _applySlotCfg(sc, cfg, t, fresh) {
    const s = sc.strip;
    const prev = sc.cfg;
    sc.cfg = cfg;
    if (fresh) {
      // nothing sounds on a fresh channel yet: step values are inaudible
      setNow(s.fader.gain, cfg.gain, t);
      setNow(s.pan.pan, cfg.pan, t);
      for (const k of ['reverb', 'delay', 'chorus']) setNow(s.sends[k].gain, cfg.sends[k], t);
      s.setWidth(this._effWidth(sc, cfg), t, true);
      s.setEq(cfg.eq || {}, t, true);
    } else {
      rampTo(s.fader.gain, cfg.gain, t);
      rampTo(s.pan.pan, cfg.pan, t);
      s.setWidth(this._effWidth(sc, cfg), t);
      s.setEq(cfg.eq || {}, t);
      for (const k of ['reverb', 'delay', 'chorus']) rampTo(s.sends[k].gain, cfg.sends[k], t);
      // every param to the new song's value or the default (no leak from the previous song, REVIEW #1)
      const metas = this.registry.paramsFor(sc.ref);
      for (const m of metas) {
        const want = cfg.params?.[m.key] ?? m.default;
        const have = typeof sc.inst.getParam === 'function' ? sc.inst.getParam(m.key) : prev?.params?.[m.key] ?? m.default;
        if (want !== undefined && !sameVal(have, want)) sc.inst.setParam?.(m.key, want, t);
      }
      for (const [k, v] of Object.entries(cfg.params || {})) if (!metas.some((m) => m.key === k) && prev?.params?.[k] !== v) sc.inst.setParam?.(k, v, t);
      if (prev?.bendEnabled && !cfg.bendEnabled) sc.inst.setBend?.(0, t);
    }
  }

  /** Slot width × the instrument's own widthDefault (sampler manifest; 1 for everything else). */
  _effWidth(sc, cfg = sc.cfg) {
    const w = Number.isFinite(cfg?.width) ? cfg.width : 1;
    const d = Number.isFinite(sc.inst?.widthDefault) ? sc.inst.widthDefault : 1;
    return w * d;
  }

  _retire(sc, t) {
    if (sc.retiring) return;
    sc.retiring = true;
    sc.zeroSince = null;
    this.retiring.push(sc);
    this._pollRetiring(t);
  }

  _pollRetiring(t) {
    if (this._pollArmed || !this.retiring.length) return;
    this._pollArmed = true;
    this.timer.at(t + 0.25, (tt) => {
      this._pollArmed = false;
      let changed = false;
      for (const sc of this.retiring.slice()) {
        const live = sc.inst.liveVoiceCount ? sc.inst.liveVoiceCount() : 0;
        if (live === 0) {
          if (sc.zeroSince === null) sc.zeroSince = tt;
          if (tt - sc.zeroSince >= 1) {
            this._disposeChannel(sc);
            this.retiring = this.retiring.filter((x) => x !== sc);
            for (const e of [...this.pedaled]) if (e.channel === sc) this.pedaled.delete(e);
            changed = true;
          }
        } else sc.zeroSince = null;
      }
      if (changed) this._emit('stats', this._debugStats());
      if (this.retiring.length) this._pollRetiring(tt);
    });
  }

  _disposeChannel(sc) {
    try {
      sc.inst.dispose();
    } catch (e) {
      console.warn('[engine] dispose failed', e);
    }
    sc.strip.dispose();
  }

  // ----- FX ------------------------------------------------------------------------------------------------------
  _applyFx(fx, t, reverbStage, init) {
    const F = this.fx;
    F.reverb.commitTo(reverbStage, fx.reverb.predelay, t);
    rampTo(F.reverb.ret.gain, fx.reverb.returnGain, t);
    Object.assign(F.delay.p, fx.delay);
    F.delay.washFb = this._washFb();
    F.delay.applyAll(t);
    F.chorus.setRate(fx.chorus.rate, t);
    F.chorus.setDepth(fx.chorus.depth, t);
    rampTo(F.chorus.ret.gain, fx.chorus.returnGain, t);
    if (F.lofi) {
      Object.assign(F.lofi.p, fx.lofi);
      F.lofi.apply(t);
    }
    F.setEq(fx.eq, t, init);
    F.setGlue(fx.comp.amount, t);
    if (init) setNow(F.master.gain, fx.master.volume, t);
    else rampTo(F.master.gain, fx.master.volume, t);
    if (!init) this._applyWheels(t);
  }

  // ----- params (§4 grammar) -------------------------------------------------------------------------------------
  /**
   * @param {string} path
   * @param {*} value
   * @param {{when?:number}} [o]
   * @returns {boolean}
   */
  setParam(path, value, { when } = {}) {
    const d = parsePath(path);
    if (!d) {
      this._warn(`Unknown parameter "${path}"`);
      return false;
    }
    const t = this._t(when);
    if (d.slot !== null) return this._setSlotParam(d, path, value, t);
    let v;
    try {
      v = clampParam(path, value);
    } catch {
      return false;
    }
    const [head, unit, key] = path.split('.');
    if (head === 'drone') {
      if (!this.drone) {
        this._warn(`${path} before start(); ignored.`);
        return false;
      }
      this.drone.setParam(unit, v, t);
      return true;
    }
    if (head === 'master') {
      this._patch.fx.master.volume = v;
      if (this.fx) this.coalesce.push(path, t, (tt) => rampTo(this.fx.master.gain, v, tt));
      return true;
    }
    if (!this._patch.fx[unit]) return false;
    this._patch.fx[unit][key] = v;
    if (!this.fx) return true; // stored; applied by start()
    const F = this.fx;
    if (unit === 'reverb') {
      if (key === 'size' || key === 'damp') F.reverb.request(this._effReverbSize(), this._patch.fx.reverb.damp, t);
      else if (key === 'predelay') this.coalesce.push(path, t, (tt) => F.reverb.setPredelay(v, tt));
      else this.coalesce.push(path, t, (tt) => rampTo(F.reverb.ret.gain, v, tt));
    } else if (unit === 'delay') {
      F.delay.p[key] = v;
      if (key === 'returnGain') this.coalesce.push(path, t, (tt) => rampTo(F.delay.ret.gain, v, tt));
      else if (key === 'feedback') {
        F.delay.washFb = this._washFb();
        this.coalesce.push(path, t, (tt) => F.delay.active.setFeedback(F.delay.effectiveFb(), F.delay.p.pingpong, tt));
      } else if (key === 'time' || key === 'sync') this.coalesce.push('fx.delay.time', t, (tt) => F.delay.updateTime(tt));
      else this.coalesce.push(path, t, (tt) => F.delay.applyAll(tt));
    } else if (unit === 'chorus') {
      if (key === 'rate') this.coalesce.push(path, t, (tt) => F.chorus.setRate(v, tt));
      else if (key === 'depth') this.coalesce.push(path, t, (tt) => F.chorus.setDepth(v, tt));
      else this.coalesce.push(path, t, (tt) => rampTo(F.chorus.ret.gain, v, tt));
    } else if (unit === 'lofi') {
      if (!F.lofi) return false;
      F.lofi.p[key] = v;
      this.coalesce.push('fx.lofi', t, (tt) => F.lofi.apply(tt));
    } else if (unit === 'eq') {
      this.coalesce.push(path, t, (tt) => F.setEq({ [key]: v }, tt));
    } else if (unit === 'comp') {
      this.coalesce.push(path, t, (tt) => F.setGlue(this._patch.fx.comp.amount, tt));
    }
    return true;
  }

  _setSlotParam(d, path, value, t) {
    const cfg = this._patch.slots[d.slot];
    if (!cfg || !this.coalesce) return false;
    const sc = this.slots[d.slot];
    if (d.key) {
      const meta = this.registry.paramsFor(cfg.instrument).find((p) => p.key === d.key);
      let v = value;
      if (meta && typeof value !== 'boolean' && typeof value !== 'string') v = Math.min(meta.max, Math.max(meta.min, Number(value)));
      cfg.params[d.key] = v;
      if (sc) this.coalesce.push(path, t, (tt) => sc.inst.setParam?.(d.key, v, tt));
      return true;
    }
    const v = clampParam(path, value);
    const rest = path.split('.').slice(2);
    if (rest[0] === 'sends') {
      cfg.sends[rest[1]] = v;
      if (sc) this.coalesce.push(path, t, (tt) => rampTo(sc.strip.sends[rest[1]].gain, v, tt));
      return true;
    }
    if (rest[0] === 'eq') {
      // eq.<key> or eq.b<k>.<field> (AMENDMENT §4). One coalesce key per slot EQ: a drag moves hz and db together,
      // and SlotEq.set diffs the whole target anyway.
      const eq = (cfg.eq = { ...(cfg.eq || {}) });
      if (rest.length === 3) eq[rest[1]] = { ...(eq[rest[1]] && typeof eq[rest[1]] === 'object' ? eq[rest[1]] : {}), [rest[2]]: v };
      else eq[rest[1]] = v;
      if (sc) this.coalesce.push(`slots.${d.slot}.eq`, t, (tt) => sc.strip.setEq(cfg.eq, tt));
      return true;
    }
    const key = rest[0];
    cfg[key] = v;
    if (!sc) return true;
    if (key === 'gain') this.coalesce.push(path, t, (tt) => rampTo(sc.strip.fader.gain, v, tt));
    else if (key === 'width') this.coalesce.push(path, t, (tt) => sc.strip.setWidth(this._effWidth(sc, cfg), tt));
    else if (key === 'pan') this.coalesce.push(path, t, (tt) => rampTo(sc.strip.pan.pan, v, tt));
    else if (key === 'bendEnabled' && !v) sc.inst.setBend?.(0, t);
    else if (key === 'bendEnabled' && v && this._routing.bend.mode === 'pitch') sc.inst.setBend?.(this.bend * this._routing.bend.range, t);
    // octave/transpose/lowNote/highNote/sustain/mono/velocityCurve: evaluated at the next noteOn
    return true;
  }

  getParam(path) {
    const d = parsePath(path);
    if (!d) return undefined;
    if (d.slot !== null) {
      const cfg = this._patch.slots[d.slot];
      if (!cfg) return undefined;
      if (d.key) return cfg.params[d.key] ?? this.registry.paramsFor(cfg.instrument).find((p) => p.key === d.key)?.default;
      const rest = path.split('.').slice(2);
      if (rest[0] === 'eq') {
        // b-rows: the effective value (a band without b-rows reads eq.low / eq.high …); other rows: stored ?? default
        if (rest.length === 3) return resolveSlotEq(cfg.eq).bands[Number(rest[1].slice(1)) - 1][rest[2]];
        if (rest[1] === 'cutHz' || rest[1] === 'hiCutHz') return resolveSlotEq(cfg.eq)[rest[1]];
        return cfg.eq?.[rest[1]] ?? PARAMS.find((e) => e.path === `slots.<i>.eq.${rest[1]}`)?.default;
      }
      return rest[0] === 'sends' ? cfg.sends[rest[1]] : cfg[rest[0]];
    }
    const [head, unit, key] = path.split('.');
    if (head === 'drone') return this.drone ? this.drone.getParam(unit) : undefined;
    if (head === 'master') return this._patch.fx.master.volume;
    return this._patch.fx[unit]?.[key];
  }

  /**
   * Target magnitude response (dB) of a slot's EQ at `freqs`, from the stored eq (not the live, possibly ramping,
   * nodes): the product over the wired filters of BiquadFilterNode.getFrequencyResponse, at this context's sample
   * rate (DECISION §7: 44.1 vs 48 kHz differ near 20 kHz). For the editor curve and the mini sparkline.
   * @param {number} slotIndex 0..3
   * @param {ArrayLike<number>} freqs Hz (above Nyquist → evaluated at Nyquist)
   * @param {{perBand?:boolean}} [opts] perBand: also each wired filter's own curve, keyed 'lc' | 'b1'…'b8' | 'hc'
   * @returns {Float32Array|{total:Float32Array, bands:Object<string, Float32Array>}|null} null: no slot / no context
   */
  getEqResponse(slotIndex, freqs, { perBand = false } = {}) {
    const cfg = this._patch.slots[slotIndex];
    if (!cfg || !this.ctx || !freqs) return null;
    this._eqShadow = this._eqShadow || [new Map(), new Map(), new Map(), new Map()];
    return slotEqResponse(this.ctx, resolveSlotEq(cfg.eq), freqs, this._eqShadow[slotIndex], perBand);
  }

  /**
   * Where a slot plays, in sounding MIDI notes (DECISION §5 greying): the split (on the physical key) shifted by
   * 12·octave + slot transpose + song transpose, clipped to 0..127 (noteOn skips notes outside); and the part of that
   * the instrument has real samples for (sampler manifest layers; synth/organ: all of it). Outside
   * [sampledLow, sampledHigh] but inside [lowNote, highNote] the sampler repitches its nearest sample ("stretched").
   * @param {number} slotIndex 0..3
   * @returns {{lowNote:number|null, highNote:number|null, sampledLow:number|null, sampledHigh:number|null,
   *   transpose:number, physLow:number, physHigh:number, instrumentRange:[number, number]|null}|null}
   *   null for an empty slot; lowNote/highNote null when every note is shifted out of 0..127
   */
  getSlotPlayRange(slotIndex) {
    const cfg = this._patch.slots[slotIndex];
    if (!cfg) return null;
    const shift = this.transpose + 12 * cfg.octave + cfg.transpose;
    const lo = Math.max(0, cfg.lowNote + shift);
    const hi = Math.min(127, cfg.highNote + shift);
    let range = null;
    if (cfg.instrument.type === 'sampler') {
      const def = this.registry.samplers?.get(cfg.instrument.id);
      let a = Infinity;
      let b = -Infinity;
      for (const L of def?.layers || []) for (const smp of L.samples || []) {
        a = Math.min(a, smp.midi);
        b = Math.max(b, smp.midi);
      }
      if (a <= b) range = [a, b];
    }
    const out = { lowNote: null, highNote: null, sampledLow: null, sampledHigh: null, transpose: shift };
    Object.assign(out, { physLow: cfg.lowNote, physHigh: cfg.highNote, instrumentRange: range });
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

  setTranspose(semis) {
    this.transpose = Math.max(-48, Math.min(48, Math.round(Number(semis) || 0)));
  }

  setTempo(bpm) {
    this.tempo = Number(bpm) > 0 ? Number(bpm) : null;
    if (!this.fx) return; // stored; applied by start()
    this.fx.delay.tempo = this.tempo;
    if (this.fx.delay.p.sync !== 'off') this.fx.delay.updateTime(this._t());
  }

  setKeyContext(pc, minor = false) {
    this._keyCtx = { pc: mod12(pc), minor: !!minor };
    this.keyPref = spellingPreference(pc, minor);
    this._updateChord(true);
  }

  // ----- wheels / routing / macros -------------------------------------------------------------------------------
  setRouting(r = {}, { when } = {}) {
    const t = this._t(when);
    const oldBend = this._routing.bend.mode;
    this._setRoutingState(r);
    if (r.bend && oldBend !== this._routing.bend.mode) this._neutralBend(oldBend, t);
    Object.assign(this._patch, { modWheel: this._routing.modWheel, expression: this._routing.expression, volume: this._routing.volume, bend: this._routing.bend, swell: this._routing.swell });
    this._applyWheels(t, 0.03);
  }

  /** Routing state only (no audio). */
  _setRoutingState(r = {}) {
    this._routingInto(this._routing, r);
  }

  /** Merge routing `r` into `R` (sub-objects are replaced, never mutated, so a shallow copy of R is safe). */
  _routingInto(R, r = {}) {
    for (const k of ['modWheel', 'expression']) {
      if (!r[k]) continue;
      const x = { ...R[k], ...r[k] };
      if (!validTarget(x.target)) x.target = R[k].target;
      x.min = clamp01(x.min);
      x.max = clamp01(x.max);
      R[k] = x;
    }
    if (r.volume && validTarget(r.volume.target)) R.volume = { ...r.volume };
    if (r.bend) {
      R.bend = { ...R.bend, ...r.bend };
      if (!['pitch', 'morph', 'drone-swell', 'tape', 'none'].includes(R.bend.mode)) R.bend.mode = 'pitch';
    }
    if (r.swell) R.swell = { seconds: Math.min(60, Math.max(0.5, Number(r.swell.seconds) || 8)) };
  }

  /** Leave the old bend mode neutral. */
  _neutralBend(oldMode, t) {
    const b = this.bend;
    this.bend = 0;
    this._applyBend(t, oldMode);
    this.bend = b;
  }

  /** Wheel/expression/volume (and macro.intensity for the pad) factor of slot i's strip. */
  _slotWheelFactor(i, I = this._macro('macro.intensity')) {
    let f = this._factorFor(`slots.${i}.gain`);
    if (I !== null && i === 1) f *= lerp(0.35, 1, I);
    return f;
  }

  _factorFor(target) {
    const R = this._routing;
    let f = 1;
    if (R.modWheel.target === target) f *= lerp(R.modWheel.min, R.modWheel.max, this.wheel.mod);
    if (R.expression.target === target) f *= lerp(R.expression.min, R.expression.max, this.wheel.expr);
    if (R.volume.target === target) f *= this.wheel.vol;
    return f;
  }
  _macro(name, R = this._routing) {
    let x = null;
    if (R.modWheel.target === name) x = lerp(R.modWheel.min, R.modWheel.max, this.wheel.mod);
    if (R.expression.target === name) x = (x ?? 1) * lerp(R.expression.min, R.expression.max, this.wheel.expr);
    if (R.volume.target === name) x = (x ?? 1) * this.wheel.vol;
    return x;
  }
  _effReverbSize() {
    const w = this._macro('macro.wash');
    const s = this._patch.fx.reverb.size;
    return w === null ? s : lerp(s, 0.9, w);
  }
  _washFb() {
    const w = this._macro('macro.wash');
    return w === null ? null : lerp(this._patch.fx.delay.feedback, 0.75, w);
  }

  _applyWheels(t, tc = 0.015) {
    if (!this.fx) return;
    const I = this._macro('macro.intensity');
    const W = this._macro('macro.wash');
    this.slots.forEach((sc, i) => {
      if (sc) rampTo(sc.strip.wheel.gain, this._slotWheelFactor(i, I), t, tc);
    });
    rampTo(this.drone.wheel.gain, this._factorFor('drone.gain'), t, tc);
    let rv = this._factorFor('fx.reverb.returnGain');
    if (I !== null) rv *= lerp(0.8, 1.15, I);
    if (W !== null) rv *= lerp(1, 1.6, W);
    rampTo(this.fx.reverb.wheel.gain, rv, t, tc);
    rampTo(this.fx.masterWheel.gain, this._factorFor('master.volume'), t, tc);
    // wash: reverb size (debounced idle-convolver swap, only when the bucket changes) + delay feedback
    const D = this.fx.delay;
    const fb = W === null ? null : lerp(this._patch.fx.delay.feedback, 0.75, W);
    if (fb !== D.washFb) {
      D.washFb = fb;
      D.active.setFeedback(D.effectiveFb(), D.p.pingpong, t, 0.05);
    }
    // compare with the IR the reverb is at or heading to (committed / requested), not with the last bucket this
    // function asked for: a commit or a restart resets the reverb behind its back (round2-engine M2)
    const eff = this._effReverbSize();
    const damp = this._patch.fx.reverb.damp;
    if (this.fx.reverb.irKey(eff, damp) !== this.fx.reverb.targetKey) this.fx.reverb.request(eff, damp, t);
    this._applyMorph(t, I);
  }

  _morphFor(sc, I = this._macro('macro.intensity')) {
    const bendMorph = this._routing.bend.mode === 'morph' ? Math.abs(this.bend) : 0;
    const pad = PAD_LIKE.has(`${sc.ref.type}:${sc.ref.id}`);
    return Math.max(bendMorph, pad && I !== null ? I : 0);
  }

  _applyMorph(t, I = this._macro('macro.intensity')) {
    this.slots.forEach((sc) => {
      if (!sc || !sc.inst.morph) return;
      const m = this._morphFor(sc, I);
      if (m !== sc.morph) {
        sc.morph = m;
        sc.inst.morph(m, t);
      }
    });
  }

  /**
   * @param {'mod'|'expr'|'vol'|'virtual'} source
   * @param {number} value01
   */
  setWheel(source, value01, { when } = {}) {
    return this._setWheel(source, value01, this._t(when), false);
  }

  _setWheel(source, value01, t, fromSwell) {
    const v = clamp01(value01);
    if (source === 'virtual') {
      if (!fromSwell) this._swell = null;
      this.wheel.mod = v;
      this._modOwner = 'virtual';
      this._pickup = { lastHw: null };
    } else if (source === 'mod') {
      if (this._modOwner === 'virtual') {
        // pickup: hardware takes over only once it reaches/crosses the virtual value
        const cur = this.wheel.mod;
        const last = this._pickup?.lastHw ?? null;
        const crossed = Math.abs(v - cur) <= 0.03 || (last !== null && (last - cur) * (v - cur) <= 0);
        this._pickup = { lastHw: v };
        if (!crossed) {
          this._emit('wheel', { source: 'mod', value: cur, hardware: v, pickup: true });
          return false;
        }
        this._modOwner = 'hw';
        this._swell = null;
      }
      this.wheel.mod = v;
    } else if (source === 'expr') this.wheel.expr = v;
    else if (source === 'vol') this.wheel.vol = v;
    else return false;
    if (this.coalesce) this.coalesce.push('wheels', t, (tt) => this._applyWheels(tt)); // before start(): stored only
    this._emit('wheel', { source, value: source === 'virtual' ? v : this.wheel[source === 'expr' ? 'expr' : source === 'vol' ? 'vol' : 'mod'] });
    return true;
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
  /** Current effective wheel values (UI strip). */
  wheelValues() {
    return { ...this.wheel, owner: this._modOwner, swelling: !!this._swell };
  }

  /** Swell button: mod wheel 0 → 1 over swell.seconds; again (or start=false) → back to the pre-swell value over 4 s. */
  swell(start, { when } = {}) {
    if (!this.timer) {
      this._warn('Swell before start(); ignored.');
      return false;
    }
    const t = this._t(when);
    if (start === undefined) start = !(this._swell && this._swell.dir === 'up');
    const seq = (this._swellSeq = (this._swellSeq || 0) + 1);
    if (start) {
      const pre = this._swell?.pre ?? this.wheel.mod;
      this._swell = { seq, dir: 'up', pre, from: 0, to: 1, t0: t, dur: this._routing.swell.seconds };
      this._setWheel('virtual', this.wheel.mod, t, true); // take ownership (pickup for hardware)
    } else {
      if (!this._swell) return false;
      const pre = this._swell.pre;
      this._swell = { seq, dir: 'down', pre, from: this.wheel.mod, to: pre, t0: t, dur: 4 };
    }
    const sw = this._swell;
    const step = (tt) => {
      if (this._swell !== sw) return;
      const x = Math.min(1, (tt - sw.t0) / sw.dur);
      // up-swell starts with a 60 ms dip to 0 so the pad builds from silence without a click
      let v;
      if (sw.dir === 'up') v = tt - sw.t0 < 0.06 && sw.t0 === t ? lerp(sw.pre, 0, (tt - sw.t0) / 0.06) : lerp(sw.from, sw.to, x);
      else v = lerp(sw.from, sw.to, x);
      this._setWheel('virtual', v, tt, true);
      if (x >= 1) {
        if (sw.dir === 'down') this._swell = null;
        return;
      }
      this.timer.at(tt + 0.05, step);
    };
    step(t);
    return true;
  }

  // ----- bend ----------------------------------------------------------------------------------------------------
  pitchBend(x, { when } = {}) {
    const t = this._t(when);
    this.bend = Math.max(-1, Math.min(1, Number(x) || 0));
    if (!this.coalesce) return; // before start(): stored only
    this.coalesce.push('bend', t, (tt) => this._applyBend(tt, this._routing.bend.mode));
  }

  _applyBend(t, mode) {
    if (!this.fx) return;
    const x = this.bend;
    if (mode === 'pitch') {
      const semis = x * this._routing.bend.range;
      for (const sc of [...this.slots, ...this.retiring]) if (sc && sc.cfg.bendEnabled) sc.inst.setBend?.(semis, t);
    } else if (mode === 'morph') this._applyMorph(t);
    else if (mode === 'drone-swell') this.drone.bendSwell(x, t);
    else if (mode === 'tape') this._tape(x, t);
  }

  _tape(x, t) {
    const L = this.fx.lofi;
    if (!L) {
      this._warn('Tape bend needs the lofi chain (disabled in this engine).');
      return;
    }
    // Schedule slightly ahead in realtime so the ramp's anchor is never in the audio thread's past, and anchor
    // it on the analytically tracked delay time (never on a stale `.value`, REVIEW #9).
    if (!this.offline) t = Math.max(t, this.ctx.currentTime + Math.min(0.05, (this.ctx.baseLatency || 0.01) + 0.01));
    if (x === this._tapeX) return;
    this._tapeX = x;
    // bend events never land before an earlier one (a coalescer flush can carry an older time than a message
    // that was applied directly with a lookahead/`when`): keeps the delay-time timeline monotonic
    const last = this._tapeSegs[this._tapeSegs.length - 1];
    if (last && t < last.t0) t = last.t0;
    const seq = (this._tapeSeq = (this._tapeSeq || 0) + 1);
    if (x < 0) {
      // tape-stop: a delay line whose delay time grows makes pitch fall by (1 − slope); LPF closes with depth
      L.hold('tape', true, t);
      L.tapeActive = true;
      const depth = -x;
      const slope = 0.5 * depth;
      const cur = this._tapeAt(t);
      const dur = Math.max(0.1, (0.95 - cur) / Math.max(0.01, slope));
      linFrom(L.tape.delayTime, cur, 0.95, t, dur); // linear growth of the delay time = constant pitch drop
      this._tapeSeg(t, dur, cur, 0.95);
      rampTo(L.lpf.frequency, 18000 * Math.pow(0.08, depth), t, 0.15);
      rampTo(L.lpf.Q, 0.707, t, 0.05);
    } else if (x > 0) {
      // push up: resonant low-pass sweep down; the delay time holds where it is (no pitch jump)
      L.hold('tape', true, t);
      L.tapeActive = true;
      const cur = this._tapeAt(t);
      linFrom(L.tape.delayTime, cur, cur, t, 0.01);
      this._tapeSeg(t, 0, cur, cur);
      rampTo(L.lpf.frequency, 18000 * Math.pow(0.04, x), t, 0.05);
      rampTo(L.lpf.Q, 0.707 + 5 * x, t, 0.05);
    } else {
      // recover over 1 s, then drop the hold (lofi bypass again if amount is 0)
      const cur = this._tapeAt(t);
      linFrom(L.tape.delayTime, cur, 0.005, t, 1);
      this._tapeSeg(t, 1, cur, 0.005);
      rampTo(L.lpf.Q, 0.707, t, 0.2);
      L.tapeActive = false;
      L.apply(t);
      this.timer.at(t + 1.05, (tt) => {
        if (seq === this._tapeSeq) L.hold('tape', false, tt);
      });
    }
  }

  /** Tape delay time at t, evaluated on the scheduled segments exactly as the AudioParam timeline will (5 ms idle). */
  _tapeAt(t) {
    let g = null;
    for (const x of this._tapeSegs) if (x.t0 <= t) g = x;
    if (!g) return this._tapeSegs.length ? this._tapeSegs[0].from : 0.005;
    if (!(g.dur > 0) || t >= g.t0 + g.dur) return g.to;
    return g.from + ((g.to - g.from) * (t - g.t0)) / g.dur;
  }
  /** Record a new segment from t (cancel-and-hold semantics: later segments are dropped). */
  _tapeSeg(t0, dur, from, to) {
    const segs = this._tapeSegs.filter((x) => x.t0 < t0);
    segs.push({ t0, dur, from, to });
    this._tapeSegs = segs.slice(-8);
  }
  get _tapeTrack() {
    return this._tapeSegs[this._tapeSegs.length - 1] || null;
  }

  // ----- perform input -------------------------------------------------------------------------------------------
  noteOn(note, vel = 100, { when } = {}) {
    if (!this.fx) return false;
    if (!(Number(vel) > 0)) return this.noteOff(note, { when }); // MIDI convention: velocity 0 = note-off
    const t = this._t(when);
    const n = clampMidi(note);
    if (this._fade) {
      // next noteOn after fadeOutAll restores the master instantly (5 ms smoothing)
      this._fade = null;
      rampTo(this.fx.fadeGain.gain, 1, t, 0.005);
    }
    if (this.sounding.has(n)) this.noteOff(n, { when: t }); // duplicate note-on = re-strike
    this.held.add(n);
    const entries = [];
    this.slots.forEach((sc, i) => {
      if (!sc) return;
      const c = sc.cfg;
      if (n < c.lowNote || n > c.highNote) return; // split on the physical note
      const sn = n + this.transpose + 12 * c.octave + c.transpose;
      if (sn < 0 || sn > 127) {
        this._warn(`Note out of range after transpose (slot ${i}); skipped.`);
        return;
      }
      const v01 = curveVelocity(vel, c.velocityCurve);
      if (c.mono && c.mono !== 'off') {
        try {
          this._monoOn(sc, n, sn, v01, t);
        } catch (e) {
          this._warn(`${sc.ref.id} noteOn failed: ${e.message || e}`);
        }
        entries.push({ slotIndex: i, instrument: sc.inst, voice: null, channel: sc, mono: true, phys: n });
        return;
      }
      // re-strike of a pedaled note on this slot: fade the old voice 30 ms, then start the new one
      for (const pe of this.pedaled) {
        if (pe.voice?.state === 'dead') {
          this.pedaled.delete(pe); // rang out while the pedal stayed down
          continue;
        }
        if (pe.channel === sc && pe.soundingNote === sn) {
          this._fadeVoice(sc.inst, pe.voice, t, 0.03);
          this.pedaled.delete(pe);
        }
      }
      let voice = null;
      try {
        voice = sc.inst.noteOn(sn, v01, t);
      } catch (e) {
        this._warn(`${sc.ref.id} noteOn failed: ${e.message || e}`);
      }
      if (voice) entries.push({ slotIndex: i, instrument: sc.inst, voice, channel: sc, soundingNote: sn, phys: n });
    });
    this.sounding.set(n, entries);
    this._notesChanged(t);
    return true;
  }

  noteOff(note, { when } = {}) {
    if (!this.fx) return false;
    const t = this._t(when);
    const n = clampMidi(note);
    this.held.delete(n);
    const entries = this.sounding.get(n);
    if (entries) {
      this.sounding.delete(n);
      for (const e of entries) {
        if (e.mono) this._monoOff(e.channel, n, t);
        else if (this.pedal && e.channel.cfg.sustain) this.pedaled.add(e);
        else e.instrument.noteOff(e.voice, t);
      }
    }
    this._notesChanged(t);
    return true;
  }

  sustain(down, { when } = {}) {
    if (!this.fx) return false;
    const t = this._t(when);
    const d = !!down;
    if (d === this.pedal) return true;
    this.pedal = d;
    if (!d) {
      for (const e of this.pedaled) e.instrument.noteOff(e.voice, t);
      this.pedaled.clear();
      for (const sc of [...this.slots, ...this.retiring]) {
        if (sc && sc.mono.pedalHold && sc.mono.notes.size === 0 && sc.mono.cur) {
          sc.inst.noteOff(sc.mono.cur.voice, t);
          sc.mono.cur = null;
          sc.mono.pedalHold = false;
        }
      }
    }
    return true;
  }

  _fadeVoice(inst, voice, t, sec) {
    if (!voice) return;
    if (typeof inst.fadeOutVoice === 'function') inst.fadeOutVoice(voice, t, sec);
    else if (typeof voice.fadeOut === 'function') voice.fadeOut(t, sec);
    else voice.kill?.(t, sec);
  }

  _monoTarget(sc) {
    let best = null;
    for (const [phys, x] of sc.mono.notes) {
      if (!best || (sc.cfg.mono === 'highest' ? phys > best.phys : phys < best.phys)) best = { phys, ...x };
    }
    return best;
  }
  _monoSwitch(sc, target, t) {
    const m = sc.mono;
    m.pedalHold = false;
    const cur = m.cur;
    if (cur && cur.voice && cur.voice.state === 'held' && typeof sc.inst.legatoTo === 'function') {
      sc.inst.legatoTo(cur.voice, target.sn, t); // 30 ms-class legato glide
      m.cur = { phys: target.phys, sn: target.sn, voice: cur.voice };
      return;
    }
    if (cur && cur.voice) this._fadeVoice(sc.inst, cur.voice, t, 0.03); // legato retrigger: 30 ms crossfade
    const voice = sc.inst.noteOn(target.sn, target.v, t);
    m.cur = { phys: target.phys, sn: target.sn, voice };
  }
  _monoOn(sc, phys, sn, v, t) {
    sc.mono.notes.set(phys, { sn, v });
    const target = this._monoTarget(sc);
    if (!sc.mono.cur || sc.mono.cur.phys !== target.phys || sc.mono.pedalHold) this._monoSwitch(sc, target, t);
  }
  _monoOff(sc, phys, t) {
    const m = sc.mono;
    m.notes.delete(phys);
    if (!m.cur || m.cur.phys !== phys) return;
    if (m.notes.size) {
      this._monoSwitch(sc, this._monoTarget(sc), t);
      return;
    }
    if (this.pedal && sc.cfg.sustain) {
      m.pedalHold = true; // pedal only defers the final release
      return;
    }
    sc.inst.noteOff(m.cur.voice, t);
    m.cur = null;
  }

  /** Panic: 30 ms fade on every voice, clear pedal & sounding, bend → 0, delay feedback → 0 for 200 ms. Drone untouched. */
  allNotesOff({ when } = {}) {
    if (!this.fx) return;
    const t = this._t(when);
    for (const sc of [...this.slots, ...this.retiring]) {
      if (!sc) continue;
      try {
        sc.inst.allOff(t, 0.03);
      } catch (e) {
        console.warn('[engine] allOff failed', e);
      }
      sc.mono = { notes: new Map(), cur: null, pedalHold: false };
    }
    this.sounding.clear();
    this.pedaled.clear();
    this.held.clear();
    this.pedal = false;
    this._swell = null;
    const mode = this._routing.bend.mode;
    this.bend = 0;
    this._applyBend(t, mode);
    this.fx.delay.panic(t);
    this._notesChanged(t);
  }

  /** Master fade incl. drone; voices are cut once silent; the next noteOn restores the master instantly. */
  fadeOutAll(seconds = 6, { when } = {}) {
    if (!this.fx) return;
    const t = this._t(when);
    const s = Math.max(0.05, Number(seconds) || 6);
    const from = this._fade ? this.fx.fadeGain.gain.value : 1;
    const f = (this._fade = { t, s });
    glideFrom(this.fx.fadeGain.gain, from, 0, t, s);
    this.timer.at(t + s, (tt) => {
      if (this._fade !== f) return;
      for (const sc of [...this.slots, ...this.retiring]) if (sc) sc.inst.allOff(tt, 0.03);
      for (const sc of [...this.slots, ...this.retiring]) if (sc) sc.mono = { notes: new Map(), cur: null, pedalHold: false };
      this.sounding.clear();
      this.pedaled.clear();
    });
  }

  get activeNotes() {
    return new Set(this.held);
  }

  heldChord() {
    const notes = [...this.held].sort((a, b) => a - b);
    if (!notes.length) return null;
    return chordName(notes.map(mod12), mod12(notes[0]), this.keyPref);
  }

  _notesChanged(t) {
    this._emit('notes', { held: new Set(this.held) });
    this._updateChord(false);
    this.drone?.notesChanged(this.held, t);
  }
  _updateChord(force) {
    const c = this.held.size ? this.heldChord() : null;
    // 2 notes that aren't a 5th → null → keep the previous readout while notes are held
    const next = c || (this.held.size ? this._lastChord : null);
    if (force || (next?.name ?? null) !== (this._lastChord?.name ?? null)) {
      this._lastChord = next;
      this._emit('chord', { chord: next });
    }
  }

  // ----- state (tests / audition) --------------------------------------------------------------------------------
  getState() {
    return {
      patch: clone(this._patch),
      routing: clone(this._routing),
      transpose: this.transpose,
      tempo: this.tempo,
      keyContext: { ...this._keyCtx },
      drone: this.drone ? this.drone.getState() : null,
      mono: this._monoOut,
      runtime: this.getRuntimeState(),
    };
  }

  /** Performance state that isn't in the patch: wheel values and owner (pickup), and whether fadeOutAll is in effect. */
  getRuntimeState() {
    return { wheel: { ...this.wheel }, modOwner: this._modOwner, faded: !!this._fade };
  }

  /** Restores getRuntimeState() (restart). Hardware that was driving the wheel keeps it; a virtual value needs pickup. */
  applyRuntimeState(r, { when } = {}) {
    if (!r) return;
    for (const k of ['mod', 'expr', 'vol']) if (Number.isFinite(r.wheel?.[k])) this.wheel[k] = clamp01(r.wheel[k]);
    this._swell = null;
    if (r.modOwner === 'virtual') {
      this._modOwner = 'virtual';
      this._pickup = { lastHw: null };
    } else {
      this._modOwner = 'hw';
      this._pickup = null;
    }
    if (!this.fx) return;
    const t = this._t(when);
    this._applyWheels(t, 0.005);
    if (r.faded) {
      this._fade = { t, s: 0 };
      setNow(this.fx.fadeGain.gain, 0, t);
    }
  }

  async applyState(s = {}) {
    await this.start();
    if (s.runtime) this.applyRuntimeState(s.runtime); // before the patch: fresh strips start at these wheel values
    if (s.patch) {
      const tok = await this.prepare(s.patch);
      this.commit(tok);
    }
    if (s.routing) this.setRouting(s.routing);
    if (Number.isFinite(s.transpose)) this.setTranspose(s.transpose);
    if ('tempo' in s) this.setTempo(s.tempo);
    if (s.keyContext) this.setKeyContext(s.keyContext.pc, s.keyContext.minor);
    if (typeof s.mono === 'boolean') this.setMono(s.mono);
    if (s.drone) {
      this.drone.configure({ ...s.drone, ...(s.drone.params || {}), mode: 'off' });
      if (s.drone.key) this.drone.setKey(s.drone.key.pc, { minor: s.drone.key.minor });
      this.drone.setMode(s.drone.mode);
    }
    return true;
  }

  _debugStats() {
    let voices = 0;
    let nodes = this.fx ? this.fx.nodeCount : 0;
    for (const sc of [...this.slots, ...this.retiring]) {
      if (!sc) continue;
      voices += sc.inst.liveVoiceCount?.() || 0;
      // strip + voices + the instrument's own shared nodes (output, filters, LFOs) where it exposes them
      nodes += sc.strip.nodeCount + (sc.inst.liveNodeCount?.() || 0) + (sc.inst._sharedNodes ? sc.inst._sharedNodes.length + 1 : 0);
    }
    if (this.drone) {
      voices += this.drone.liveVoiceCount();
      nodes += this.drone.liveNodeCount();
    }
    return {
      voices,
      nodes,
      retiring: this.retiring.length,
      decodedMB: Math.round(this.cache.decodedMB * 10) / 10,
      pinnedMB: Math.round(this.cache.pinnedMB * 10) / 10, // morning-prep: how much of decodedMB the LRU can't evict
      capMB: Math.round((this.cache.capBytes / MB) * 10) / 10,
      sounding: this.sounding.size,
      pedaled: this.pedaled.size,
      timers: this.timer ? this.timer.pendingCount() : 0,
    };
  }
}
