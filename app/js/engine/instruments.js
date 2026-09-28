// Instrument registry (SPEC §3, §3.2): merges the sample manifest (sampler), synth patches and organ presets
// into listInstruments(), and creates Instrument instances. synth.js / organ.js (engine-instruments) are
// imported dynamically; when missing or throwing, a built-in 2-oscillator fallback synth stands in for every
// synth id (warm-pad, glass-pad, strings, sub-bass, soft-keys, bell, drone-osc) so the engine always works.
import { rampTo, setNow, linearTo, releaseTau, stopAfterRelease } from '../shared/automation.js';
import { createRng } from '../shared/prng.js';
import { SamplerInstrument, normalizeManifest, USER_RELEASE_DEFAULT } from './sampler.js';

export const MAX_VOICES = 16;
const STEAL_FADE = 0.02;
let VSEQ = 0;

const atT = (ctx, when) => (Number.isFinite(when) && when > ctx.currentTime ? when : ctx.currentTime);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * fetch() with two retries (0.3 s, 0.6 s) on a network error or HTTP 408/429/5xx. The registry's JSON files are
 * fetched once per engine: one reset socket must not leave every instrument untrimmed for the whole session
 * (seen in the audition: "gain-trims.json unavailable (HTTP 408)").
 */
async function fetchRetry(url, opts, tries = 3) {
  let last;
  for (let k = 0; k < tries; k++) {
    if (k) await new Promise((r) => setTimeout(r, 300 * k));
    try {
      const res = await fetch(url, opts);
      if (res.ok || !(res.status === 408 || res.status === 429 || res.status >= 500)) return res;
      last = res;
    } catch (e) {
      last = e;
    }
  }
  if (last instanceof Error) throw last;
  return last;
}

/** Rng object that is also callable (instruments may expect either shape). */
export function callableRng(rng) {
  const f = () => rng.next();
  return Object.assign(f, rng);
}

/**
 * Minimal Voice (SPEC §3.2) used by the sampler and the fallback synth. Owns its nodes; the last source's
 * onended disconnects everything. Interface-compatible with engine-instruments' voice.js
 * (releaseAt / kill / fadeOut / state / note / startedAt).
 */
export class BasicVoice {
  constructor(ctx, note, when) {
    this.ctx = ctx;
    this.id = ++VSEQ;
    this.note = note;
    this.startedAt = when;
    this.releasedAt = Infinity;
    this.stopAt = Infinity;
    this.state = 'held';
    this.nodes = [];
    this.sources = [];
    this.out = null;
    this.release = 0.2; // seconds to −60 dB
    this.ignoreRelease = false;
    this._pending = 0;
    this._dead = [];
  }
  add(n) {
    this.nodes.push(n);
    return n;
  }
  addSource(src, when) {
    this.nodes.push(src);
    this.sources.push(src);
    this._pending++;
    src._stopAt = Infinity;
    src.onended = () => {
      if (--this._pending <= 0) this._teardown();
    };
    return src;
  }
  _stop(t) {
    if (!(t < this.stopAt)) return;
    this.stopAt = t;
    for (const s of this.sources) {
      if (t < s._stopAt) {
        s._stopAt = t;
        try {
          s.stop(Math.max(t, this.startedAt));
        } catch {}
      }
    }
  }
  _teardown() {
    if (this.state === 'dead') return;
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {}
    }
    this.nodes = [];
    this.sources = [];
    this.state = 'dead';
    const cbs = this._dead;
    this._dead = [];
    cbs.forEach((cb) => cb(this));
  }
  onDead(cb) {
    if (this.state === 'dead') cb(this);
    else this._dead.push(cb);
  }
  get liveNodes() {
    return this.nodes.length;
  }
  releaseAt(when) {
    if (this.state !== 'held') return;
    const t = atT(this.ctx, when);
    this.state = 'released';
    this.releasedAt = t;
    // undamped strings (sampler def.undampedFrom, factory pianos ≥ 90): ring to the buffer end
    if (this.ignoreRelease) return;
    rampTo(this.out.gain, 0, t, releaseTau(this.release));
    this._stop(stopAfterRelease(t, this.release));
  }
  /** Click-free kill: exponential fade (τ = fadeSec/6.9 → −60 dB at fadeSec), stop at 1.3 × fadeSec. */
  fadeOut(when, fadeSec = STEAL_FADE) {
    if (this.state === 'dead') return;
    const t = atT(this.ctx, when);
    const f = Math.max(0.003, fadeSec);
    rampTo(this.out.gain, 0, t, releaseTau(f)); // setTarget: always starts from the real current value
    if (this.state !== 'killed') this.releasedAt = Math.min(this.releasedAt, t);
    this.state = 'killed';
    this._stop(stopAfterRelease(t, f));
  }
  /** SPEC §3.2 kill(when): stops every source; faded (20 ms) so a kill never clicks. */
  kill(when, fadeSec = STEAL_FADE) {
    this.fadeOut(when, fadeSec);
  }
}

/** Shared polyphony handling: max 16 (sampler: 32), steal oldest-released then oldest-held with a 20 ms fade. */
export class BasicAllocator {
  constructor(max = MAX_VOICES) {
    this.max = max;
    this.voices = new Set();
  }
  makeRoom(when) {
    const playing = [...this.voices].filter((v) => v.state === 'held' || v.state === 'released');
    while (playing.length >= this.max) {
      let victim = null;
      for (const v of playing) if (v.state === 'released' && (!victim || v.releasedAt < victim.releasedAt)) victim = v;
      if (!victim) for (const v of playing) if (!victim || v.startedAt < victim.startedAt) victim = v;
      playing.splice(playing.indexOf(victim), 1);
      victim.fadeOut(when, STEAL_FADE);
    }
  }
  add(v) {
    this.voices.add(v);
    v.onDead((x) => this.voices.delete(x));
    return v;
  }
  allOff(when, fade) {
    for (const v of [...this.voices]) v.fadeOut(when, fade);
  }
  liveNodes() {
    let n = 0;
    for (const v of this.voices) n += v.liveNodes;
    return n;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Fallback synth: sine + triangle per voice, instrument-level LPF (tone/morph). Deliberately simple and
// deterministic; `tri: 0` gives a pure sine (used by the transpose FFT test).
const FALLBACK_PRESETS = {
  'warm-pad': { name: 'Warm Pad', group: 'Synth Pads', attack: 1.2, decay: 0.5, sustain: 0.8, release: 3, tri: 0.5, tone: 0.55, drift: 3 },
  'glass-pad': { name: 'Glass Pad', group: 'Synth Pads', attack: 0.8, decay: 0.5, sustain: 0.85, release: 3, tri: 0.25, tone: 0.8, drift: 3 },
  strings: { name: 'Strings', group: 'Synth Pads', attack: 0.4, decay: 0.3, sustain: 0.9, release: 1.8, tri: 0.6, tone: 0.65, drift: 2 },
  'sub-bass': { name: 'Sub Bass', group: 'Bass', attack: 0.01, decay: 0.2, sustain: 1, release: 0.25, tri: 0.3, tone: 0.3, drift: 0 },
  'soft-keys': { name: 'Soft Keys', group: 'Synth Keys', attack: 0.005, decay: 2.5, sustain: 0.15, release: 0.5, tri: 0.4, tone: 0.6, drift: 0 },
  bell: { name: 'Bell', group: 'Mallets & Bells', attack: 0.003, decay: 3, sustain: 0.05, release: 1.5, tri: 0.2, tone: 0.9, drift: 0 },
  'drone-osc': { name: 'Drone Oscillator', group: 'Synth Pads', attack: 2, decay: 0.1, sustain: 1, release: 4, tri: 0.4, tone: 0.5, drift: 3 },
};
export const FALLBACK_SYNTH_IDS = Object.keys(FALLBACK_PRESETS);

function fallbackParams(p) {
  return [
    { key: 'attack', label: 'Attack', min: 0.002, max: 8, default: p.attack, unit: 's', curve: 'log' },
    { key: 'release', label: 'Release', min: 0.02, max: 12, default: p.release, unit: 's', curve: 'log' },
    { key: 'tone', label: 'Tone', min: 0, max: 1, default: p.tone, unit: 'lin', curve: 'lin' },
    { key: 'tri', label: 'Triangle mix', min: 0, max: 1, default: p.tri, unit: 'lin', curve: 'lin' },
    { key: 'movement', label: 'Movement', min: 0, max: 1, default: 0.3, unit: 'lin', curve: 'lin' },
  ];
}

export class FallbackSynth {
  constructor(ctx, prng, def, initialParams = {}) {
    this.ctx = ctx;
    this.id = def.id;
    this.preset = FALLBACK_PRESETS[def.id] || FALLBACK_PRESETS['warm-pad'];
    this.rng = prng && typeof prng.next === 'function' ? prng : createRng(1);
    this.meta = { id: def.id, params: fallbackParams(this.preset) };
    this.params = {};
    for (const p of this.meta.params) {
      const v = initialParams && Number.isFinite(Number(initialParams[p.key])) ? Number(initialParams[p.key]) : p.default;
      this.params[p.key] = clamp(v, p.min, p.max);
    }
    this.output = new GainNode(ctx, { gain: 0.5 });
    this.lpf = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: this._cutoff(0), Q: 20 * Math.log10(Math.SQRT1_2) }); // Butterworth (Q is dB)
    this.lpf.connect(this.output);
    this.alloc = new BasicAllocator();
    this.bend = 0;
    this.morphX = 0;
    this.disposed = false;
    this.ready = Promise.resolve();
    this.isFallback = true;
  }
  _cutoff(morph) {
    // tone 0..1 → 300 Hz..18 kHz (log); morph adds up to +2 octaves
    return Math.min(20000, 300 * Math.pow(60, this.params.tone) * Math.pow(2, 2 * morph));
  }
  noteOn(note, vel01, when) {
    if (this.disposed) return null;
    const ctx = this.ctx;
    const t = atT(ctx, when);
    const n = clamp(Math.round(note), 0, 127);
    this.alloc.makeRoom(t);
    const v = new BasicVoice(ctx, n, t);
    const p = this.preset;
    const f = 440 * Math.pow(2, (n - 69) / 12);
    const jitter = p.drift ? (this.rng.next() * 2 - 1) * p.drift : 0;
    const det = this.bend * 100 + jitter;
    const env = v.add(new GainNode(ctx, { gain: 0 }));
    const s = v.addSource(new OscillatorNode(ctx, { type: 'sine', frequency: f, detune: det }), t);
    const tr = v.addSource(new OscillatorNode(ctx, { type: 'triangle', frequency: f, detune: det }), t);
    const sg = v.add(new GainNode(ctx, { gain: 1 - 0.5 * this.params.tri }));
    const tg = v.add(new GainNode(ctx, { gain: this.params.tri }));
    s.connect(sg).connect(env);
    tr.connect(tg).connect(env);
    v.oscs = [s, tr];
    v.detuneJitter = jitter;
    if (p.drift && this.params.movement > 0) {
      // slow random-ish drift: LFO on detune, rate/phase from the seeded rng (drone "movement")
      const lfo = v.addSource(new OscillatorNode(ctx, { frequency: 0.05 + this.rng.next() * 0.1 }), t);
      const lg = v.add(new GainNode(ctx, { gain: p.drift * this.params.movement }));
      lfo.connect(lg);
      lg.connect(s.detune);
      lg.connect(tr.detune);
    }
    env.connect(this.lpf);
    v.out = env;
    v.release = this.params.release;
    const peak = 0.25 + 0.75 * clamp(vel01, 0, 1);
    const a = Math.max(0.002, this.params.attack);
    setNow(env.gain, 0, t); // anchor: the attack ramp must start at t (see fx.linFrom)
    linearTo(env.gain, peak, t, a, { from: 0 });
    if (p.sustain < 1) rampTo(env.gain, peak * p.sustain, t + a, Math.max(0.01, p.decay / 3));
    for (const o of v.sources) o.start(t);
    return this.alloc.add(v);
  }
  noteOff(voice, when) {
    voice?.releaseAt?.(when);
  }
  fadeOutVoice(voice, when, fadeSec = 0.03) {
    voice?.fadeOut?.(when, fadeSec);
  }
  legatoTo(voice, note, when) {
    if (!voice || voice.state !== 'held' || !voice.oscs) return voice;
    const f = 440 * Math.pow(2, (note - 69) / 12);
    for (const o of voice.oscs) rampTo(o.frequency, f, atT(this.ctx, when), 0.01);
    voice.note = note;
    return voice;
  }
  allOff(when, fadeSec = 0.03) {
    this.alloc.allOff(atT(this.ctx, when), fadeSec);
  }
  setParam(key, value, when) {
    const p = this.meta.params.find((x) => x.key === key);
    if (!p) return false;
    this.params[key] = clamp(Number(value), p.min, p.max);
    if (key === 'tone') rampTo(this.lpf.frequency, this._cutoff(this.morphX), atT(this.ctx, when), 0.015);
    return true;
  }
  getParam(key) {
    return this.params[key];
  }
  morph(x, when) {
    this.morphX = clamp(Number(x) || 0, 0, 1);
    rampTo(this.lpf.frequency, this._cutoff(this.morphX), atT(this.ctx, when), 0.03);
  }
  setBend(semis, when) {
    this.bend = Number(semis) || 0;
    const t = atT(this.ctx, when);
    for (const v of this.alloc.voices) {
      if (v.state === 'dead' || !v.oscs) continue;
      for (const o of v.oscs) rampTo(o.detune, this.bend * 100 + v.detuneJitter, t, 0.008);
    }
  }
  liveVoiceCount() {
    return this.alloc.voices.size;
  }
  liveNodeCount() {
    return this.alloc.liveNodes() + (this.disposed ? 0 : 2);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.alloc.allOff(this.ctx.currentTime, 0.01);
    try {
      this.lpf.disconnect();
      this.output.disconnect();
    } catch {}
  }
}

// ---------------------------------------------------------------------------------------------------------------
const GROUPS = ['Piano', 'Electric Piano', 'Organ', 'Synth Pads', 'Synth Keys', 'Mallets & Bells', 'Guitar', 'Bass'];

function metaList(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x.filter((e) => e && e.id);
  if (typeof x === 'object') return Object.entries(x).map(([id, e]) => ({ id, ...(e || {}) }));
  return [];
}

function findClass(mod, preferred) {
  for (const name of preferred) if (typeof mod[name] === 'function' && mod[name].prototype?.noteOn) return mod[name];
  if (typeof mod.default === 'function' && mod.default.prototype?.noteOn) return mod.default;
  for (const v of Object.values(mod)) if (typeof v === 'function' && v.prototype && typeof v.prototype.noteOn === 'function' && /Instrument$/.test(v.name)) return v;
  return null;
}

/**
 * Registry: `await init()` once (fetches the manifest and gain-trims.json, imports synth.js / organ.js /
 * synth-extra.js), then `list()` and synchronous `create()`.
 *  * Synth patches come from synth.js `PATCHES` plus synth-extra.js `PATCHES` (its own `SynthExtraInstrument`
 *    class); each def remembers which class builds it. Entries marked `hidden: true` (drone-osc) are left out of
 *    list() but stay creatable (drone.js) and keep their params (paramsFor).
 *  * gain-trims.json (dB, tools/calibrate.mjs): synth/organ instances get a trim GainNode after their output;
 *    `registry.gainTrims` = {synth:{}, organ:{}, droneTrim} (the audition/calibrate shim checks for it).
 */
export class InstrumentRegistry {
  /**
   * @param {object} o
   * @param {string} [o.manifestUrl]     the factory manifest (a failure warns)
   * @param {string[]} [o.manifestUrls] [factory, ...secondary]; secondary ("My Samples") manifests are optional: a
   *   missing one is a silent no-op, their ids become `user:<id>`, group 'My Samples' unless the entry has its own
   *   `group`, sample dirs resolve against that manifest's URL, `release` defaults to 0.15 s.
   */
  constructor({ manifestUrl, manifestUrls, bufferCache, warn = () => {}, useModules = true, gainTrimsUrl } = {}) {
    this.manifestUrls = (Array.isArray(manifestUrls) && manifestUrls.length ? manifestUrls : [manifestUrl]).filter(Boolean);
    this.manifestUrl = this.manifestUrls[0] ?? null;
    this.cache = bufferCache;
    this.warn = warn;
    this.useModules = useModules;
    this.gainTrimsUrl = gainTrimsUrl ?? new URL('./gain-trims.json', import.meta.url).href;
    this.samplers = new Map(); // id -> normalized def
    this.synth = null; // {defs: Map<id, def & {_build}>}
    this.organ = null;
    this.gainTrims = { synth: {}, organ: {}, droneTrim: 0 };
    this.synthModuleLoaded = false;
    this._init = null;
  }

  init() {
    if (!this._init) this._init = Promise.all([this._loadManifest(), this._loadModules(), this._loadTrims()]).then(() => this);
    return this._init;
  }

  _userOpts() {
    return { idPrefix: 'user:', group: 'My Samples', defaultRelease: USER_RELEASE_DEFAULT, secondary: true, warn: (m) => this.warn(m) };
  }

  async _loadManifest() {
    const [primary, ...secondary] = this.manifestUrls;
    const results = await Promise.all([
      primary ? this._fetchManifest(primary, false) : null,
      ...secondary.map((u) => this._fetchManifest(u, true)),
    ]);
    results.forEach((r, i) => {
      if (!r || r.failed) return;
      const opts = i === 0 ? {} : this._userOpts();
      for (const d of normalizeManifest(r.json, r.url, opts)) if (!this.samplers.has(d.id)) this.samplers.set(d.id, d);
    });
  }

  /**
   * Re-fetch the secondary ("My Samples") manifests: `user:` entries are replaced by the new set (instances already
   * built keep their def and keep playing). The health answer is re-read too (the folder may have been attached).
   * A *failed* reload (network error, 5xx, unreadable JSON — as opposed to "not served": health flag off, 404, or
   * an empty list) keeps the previous `user:` entries and warns, so a song's user instrument never turns into the
   * fallback synth mid-set (round2-engine m1). A successful reload also clears the sample cache's failure marks
   * and unreferenced buffers for every user sample URL (old and new), so Rescan picks up fixed or re-imported
   * files (round2-engine m2).
   * @returns {Promise<number>} number of user instruments now registered
   */
  async reloadSecondary() {
    const [, ...secondary] = this.manifestUrls;
    this._health = new Map();
    const results = await Promise.all(secondary.map((u) => this._fetchManifest(u, true)));
    const oldIds = [...this.samplers.keys()].filter((id) => id.startsWith('user:'));
    const failed = results.find((r) => r && r.failed);
    if (failed) {
      this.warn(`My Samples reload failed (${failed.error}); keeping the ${oldIds.length} instrument(s) already loaded.`);
      return oldIds.length;
    }
    const urls = new Set();
    const addUrls = (d) => {
      for (const L of d.layers || []) for (const smp of L.samples || []) urls.add(smp.url);
    };
    for (const id of oldIds) {
      addUrls(this.samplers.get(id));
      this.samplers.delete(id);
    }
    let n = 0;
    for (const r of results) {
      if (!r) continue;
      for (const d of normalizeManifest(r.json, r.url, this._userOpts())) {
        if (this.samplers.has(d.id)) continue;
        this.samplers.set(d.id, d);
        addUrls(d);
        n++;
      }
    }
    this.cache?.invalidate?.(urls);
    return n;
  }

  /**
   * Chromium logs "Failed to load resource … 404" to the console for ANY failed fetch() (GET and HEAD alike, verified
   * headless), so an optional manifest under /api/ is only requested when the server's /api/health says it serves
   * one (`userSamples: true`, or 'user-samples' in `features`). No health route / flag → skipped without a request.
   * @returns {Promise<'yes'|'no'|'failed'>} 'failed': the health check itself could not be read (network, 5xx)
   */
  async _optionalStatus(url) {
    let u;
    try {
      u = new URL(url, typeof location !== 'undefined' ? location.href : 'http://localhost/');
    } catch {
      return 'no';
    }
    const i = u.pathname.indexOf('/api/');
    if (i < 0) return 'yes'; // a plain static URL the caller vouches for
    const health = new URL(`${u.pathname.slice(0, i)}/api/health`, u).href;
    this._health = this._health || new Map();
    if (!this._health.has(health)) {
      this._health.set(
        health,
        fetch(health, { cache: 'no-store' })
          .then((r) => {
            if (r.ok) return r.json().catch(() => null); // not our server: nothing served
            return r.status >= 500 || r.status === 408 || r.status === 429 ? 'failed' : null;
          })
          .catch(() => 'failed'),
      );
    }
    const h = await this._health.get(health);
    if (h === 'failed') return 'failed';
    return h && (h.userSamples === true || (Array.isArray(h.features) && h.features.includes('user-samples'))) ? 'yes' : 'no';
  }

  /** @returns {Promise<boolean>} the optional manifest may be requested (shell tests call this directly) */
  async _optionalAllowed(url) {
    return (await this._optionalStatus(url)) === 'yes';
  }

  /**
   * @returns {Promise<{json,url}|{failed:true,error:string}|null>} null = not served (optional manifest absent);
   *   `failed` only for optional manifests (the factory one warns and returns null)
   */
  async _fetchManifest(url, optional) {
    try {
      if (optional) {
        const allowed = await this._optionalStatus(url);
        if (allowed === 'failed') throw new Error('health check failed');
        if (allowed !== 'yes') return null;
      }
      const res = await fetchRetry(url, optional ? { cache: 'no-store' } : undefined);
      if (!res.ok) {
        if (optional && (res.status === 404 || res.status === 410)) return null; // no sample folder: silent no-op
        throw new Error(`HTTP ${res.status}`);
      }
      return { json: await res.json(), url: res.url || String(url) };
    } catch (e) {
      if (optional) {
        console.info(`[engine] optional sample manifest ${url} not loaded (${e.message || e}).`);
        return { failed: true, error: e.message || String(e) };
      }
      this.warn(`Sample manifest unavailable (${url}): ${e.message || e}. Sampled instruments disabled.`);
      return null;
    }
  }

  async _loadTrims() {
    const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
    const clean = (o) => {
      const out = {};
      for (const [k, v] of Object.entries(o && typeof o === 'object' ? o : {})) if (Number.isFinite(Number(v))) out[k] = Number(v);
      return out;
    };
    try {
      if (!this.gainTrimsUrl) return;
      const res = await fetchRetry(this.gainTrimsUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      this.gainTrims = { synth: clean(j.synth), organ: clean(j.organ), droneTrim: num(j.droneTrim) };
    } catch (e) {
      this.gainTrims = { synth: {}, organ: {}, droneTrim: 0 };
      this.warn(`gain-trims.json unavailable (${e.message || e}); instruments play untrimmed.`);
    }
  }

  async _loadModules() {
    if (!this.useModules) return;
    const load = async (file, metaNames, classNames, factoryNames, { optional = false } = {}) => {
      try {
        const mod = await import(new URL(`./${file}`, import.meta.url).href);
        const cls = findClass(mod, classNames);
        const factory = factoryNames.map((n) => mod[n]).find((f) => typeof f === 'function' && !f.prototype?.noteOn) || null;
        if (!cls && !factory) throw new Error('no Instrument class/factory export');
        const build = cls ? (ctx, rng, id, params) => new cls(ctx, rng, id, params) : (ctx, rng, id, params) => factory(ctx, rng, id, params);
        const defs = new Map();
        for (const n of metaNames) for (const d of metaList(mod[n])) defs.set(d.id, { ...d, _build: build, _module: file });
        if (!defs.size) throw new Error('no PATCHES/PRESETS metadata export');
        return { defs };
      } catch (e) {
        if (optional) console.info(`[engine] ${file} not loaded (${e.message || e}).`);
        else this.warn(`${file} unavailable (${e.message || e}); using the built-in fallback.`);
        return null;
      }
    };
    const [synth, organ, extra] = await Promise.all([
      load('synth.js', ['PATCHES', 'SYNTH_PATCHES'], ['SynthInstrument', 'Synth'], ['createSynth', 'createInstrument']),
      load('organ.js', ['PRESETS', 'ORGAN_PRESETS'], ['OrganInstrument', 'Organ'], ['createOrgan', 'createInstrument']),
      load('synth-extra.js', ['PATCHES'], ['SynthExtraInstrument'], ['createSynthExtra'], { optional: true }),
    ]);
    this.synthModuleLoaded = !!synth;
    if (extra) {
      if (synth) for (const [id, d] of extra.defs) if (!synth.defs.has(id)) synth.defs.set(id, d);
      // synth.js missing: extra patches still work; the core ids fall back to FallbackSynth
      this.synth = synth || extra;
    } else this.synth = synth;
    this.organ = organ;
  }

  /** Every instrument including hidden ones (paramsFor/has/create use this). */
  _all() {
    const out = [];
    for (const d of this.samplers.values()) {
      const e = { ref: { type: 'sampler', id: d.id }, name: d.name, group: d.group, params: d.params, license: d.license || null, hidden: !!d.hidden };
      if (d.widthDefault !== 1) e.widthDefault = d.widthDefault;
      out.push(e);
    }
    const synthDefs = [...(this.synthModuleLoaded ? [] : FALLBACK_SYNTH_IDS.map((id) => ({ id, fallback: true, hidden: id === 'drone-osc' }))), ...(this.synth ? this.synth.defs.values() : [])];
    const seen = new Set();
    for (const d of synthDefs) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const fb = FALLBACK_PRESETS[d.id];
      const group = typeof d.group === 'string' && d.group.trim() ? d.group : fb?.group || 'Synth Pads';
      const e = {
        ref: { type: 'synth', id: d.id },
        name: d.name || fb?.name || d.id,
        group,
        params: d.fallback ? fallbackParams(fb) : d.params || [],
        license: d.license || null,
        hidden: !!d.hidden || d.id === 'drone-osc',
      };
      // optional metadata passed through for tools: the calibration window of a short sound (synth-extra `pluck`)
      if (Array.isArray(d.calibWindow) && d.calibWindow.length === 2) e.calibWindow = d.calibWindow.slice();
      out.push(e);
    }
    if (this.organ) {
      for (const d of this.organ.defs.values()) {
        out.push({ ref: { type: 'organ', id: d.id }, name: d.name || d.id, group: 'Organ', params: d.params || [], license: d.license || null, hidden: !!d.hidden });
      }
    }
    return out;
  }

  /** SPEC §3 listInstruments() shape (hidden entries, e.g. drone-osc, omitted). */
  list() {
    return this._all()
      .filter((x) => !x.hidden)
      .map(({ hidden, ...x }) => x);
  }

  paramsFor(ref) {
    const e = this._all().find((x) => x.ref.type === ref?.type && x.ref.id === ref?.id);
    return e ? e.params : [];
  }

  has(ref) {
    if (!ref) return false;
    if (ref.type === 'sampler') return this.samplers.has(ref.id);
    if (ref.type === 'synth') return (this.synth && this.synth.defs.has(ref.id)) || (!this.synthModuleLoaded && ref.id in FALLBACK_PRESETS);
    if (ref.type === 'organ') return !!this.organ?.defs.has(ref.id);
    return false;
  }

  /** Wrap a real synth/organ instance's output in its gain-trims.json trim. */
  _trim(ctx, type, id, inst) {
    const db = Number(this.gainTrims?.[type]?.[id]);
    if (!Number.isFinite(db) || db === 0) return inst;
    const g = new GainNode(ctx, { gain: Math.pow(10, db / 20) });
    inst.output.connect(g);
    inst._untrimmedOutput = inst.output;
    inst.output = g; // callers connect `inst.output` after create(); dispose() disconnects this node
    inst.trimDb = db;
    return inst;
  }

  /**
   * Create an instrument (synchronous construction; sampler decoding runs behind `ready`).
   * Unknown refs degrade to the fallback synth (warn).
   * @returns {object} Instrument
   */
  create(ctx, prng, ref, params = {}, opts = {}) {
    const rng = callableRng(prng && typeof prng.next === 'function' ? prng : createRng(1));
    const type = ref?.type;
    const id = ref?.id;
    if (type === 'sampler') {
      const def = this.samplers.get(id);
      if (def) return new SamplerInstrument(ctx, rng, def, params, { cache: this.cache, warn: this.warn, onProgress: opts.onProgress });
      this.warn(`Unknown sampled instrument "${id}"; using a synth instead.`);
      return new FallbackSynth(ctx, rng, { id: 'soft-keys' }, {});
    }
    const mod = type === 'organ' ? this.organ : type === 'synth' ? this.synth : null;
    const def = mod?.defs.get(id);
    if (def) {
      try {
        // synth.js / organ.js / synth-extra.js take the patch/preset *id* (`new SynthInstrument(ctx, prng, patchId, params)`)
        const inst = def._build(ctx, rng, id, params);
        if (inst && typeof inst.noteOn === 'function' && inst.output) {
          if (!inst.ready) inst.ready = Promise.resolve();
          return this._trim(ctx, type, id, inst);
        }
        throw new Error('factory returned no Instrument');
      } catch (e) {
        this.warn(`${type}:${id} failed to build (${e.message || e}); using the fallback synth.`);
      }
    } else if (type === 'organ') {
      this.warn(`Organ "${id}" unavailable; using the fallback synth.`);
    } else if (!(id in FALLBACK_PRESETS)) {
      this.warn(`Unknown instrument ${type}:${id}; using the fallback synth.`);
    }
    return new FallbackSynth(ctx, rng, { id: id in FALLBACK_PRESETS ? id : type === 'organ' ? 'strings' : 'warm-pad' }, params);
  }
}
