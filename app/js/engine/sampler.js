// Manifest-driven sampler (SPEC §3.5, REVIEW 2.5, 2.6, 3.10). Decaying instruments only (no loops).
// Manifest (app/samples/manifest.json):
//   { instruments: [{ id, name, category, ext, layers:[{ vel:[lo,hi], dir, notes:['A0','C1',…] }],
//                     release /*τ seconds*/, gainTrim /*dB*/, widthDefault /*stereo width ×, optional*/, group?,
//                     maxMonoLossDb /*optional: per-file anti-phase fix at decode, see processSample*/,
//                     undampedFrom /*optional MIDI note: notes ≥ it ignore note-off (no dampers); null = off*/,
//                     license, source, attribution }] }
// Sample URL = <manifest dir>/<layer.dir>/<note>.<ext>. Decoding happens only while an instrument is being
// prepared (its `ready` promise), never at note time.
import { rampTo, setNow } from '../shared/automation.js';
import { parseNoteName } from '../shared/music.js';
import { BasicVoice, BasicAllocator } from './instruments.js';

const ONSET_DB = -50;
/** 2-pole Butterworth for a Web Audio lowpass (its Q is in dB): −3.01 dB. */
const BUTTER2_Q = 20 * Math.log10(Math.SQRT1_2);
/** Release τ for a manifest entry without `release` (user manifests, "My Samples"). */
export const USER_RELEASE_DEFAULT = 0.15;
/** Range of the sampler `release` param (τ, s): a manifest `release` is clamped into it (round2-engine m3). */
export const RELEASE_RANGE = [0.02, 1.5];
/** Manifest `gainTrim` is clamped to ±this many dB (round2-engine m3: `gainTrim: 40` would be a ×100 gain). */
export const GAIN_TRIM_MAX_DB = 30;
/** Default `undampedFrom` for factory `category: 'piano'` entries: a piano's top ~1.5 octaves have no dampers. */
export const PIANO_UNDAMPED_FROM = 90;
const MB = 1024 * 1024;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const atT = (ctx, when) => (Number.isFinite(when) && when > ctx.currentTime ? when : ctx.currentTime);

const CATEGORY_GROUP = {
  piano: 'Piano',
  ep: 'Electric Piano',
  'electric piano': 'Electric Piano',
  'electric-piano': 'Electric Piano',
  keys: 'Electric Piano',
  mallet: 'Mallets & Bells',
  mallets: 'Mallets & Bells',
  bells: 'Mallets & Bells',
  bell: 'Mallets & Bells',
  guitar: 'Guitar',
  bass: 'Bass',
  organ: 'Organ',
};

function toMidi(n) {
  if (Number.isFinite(n)) return clamp(Math.round(n), 0, 127);
  try {
    return parseNoteName(String(n));
  } catch {
    return null;
  }
}

/**
 * Normalise the manifest into instrument defs. Tolerates an array at top level or `instruments` as an
 * object keyed by id, `vel`/`velocity`, per-layer `files` maps and `url` patterns.
 * Options (secondary "My Samples" manifests): `idPrefix` ('user:') namespaces the ids, `group` is the group for
 * entries without their own `group` field, `defaultRelease` is τ for entries without `release`, `secondary`
 * (default: a non-empty idPrefix) marks a user manifest, `warn(msg)` reports clamped fields.
 * `release` is clamped to RELEASE_RANGE and `gainTrim` to ±GAIN_TRIM_MAX_DB (round2-engine m3).
 * `undampedFrom` (round2-engine M1): notes at/above it ignore note-off. An explicit number or null/false in the
 * entry wins; otherwise factory `category: 'piano'` entries get PIANO_UNDAMPED_FROM and everything else (every
 * user entry, and sustaining categories such as strings/choir/pad/organ) is damped on every key.
 * @returns {Array<{id,name,group,layers:{lo,hi,samples:{midi,url}[]}[],release,gainTrimDb,widthDefault,
 *   undampedFrom,license,params}>}
 */
export function normalizeManifest(json, manifestUrl, { idPrefix = '', group: defaultGroup = null, defaultRelease = 0.12, secondary = !!idPrefix, warn = null } = {}) {
  let list = Array.isArray(json) ? json : json?.instruments;
  if (list && !Array.isArray(list)) list = Object.entries(list).map(([id, v]) => ({ id, ...v }));
  if (!Array.isArray(list)) return [];
  const base = new URL('.', new URL(manifestUrl, typeof location !== 'undefined' ? location.href : 'http://localhost/'));
  const out = [];
  for (const inst of list) {
    if (!inst || !inst.id || !Array.isArray(inst.layers)) continue;
    const ext = inst.ext || inst.format || 'mp3';
    const layers = [];
    for (const L of inst.layers) {
      const vel = L.vel || L.velocity || [0, 127];
      const dir = L.dir ?? inst.dir ?? inst.id;
      const samples = [];
      const add = (note, rel) => {
        const midi = toMidi(note);
        if (midi === null) return;
        samples.push({ midi, url: new URL(rel, base).href });
      };
      if (L.files && typeof L.files === 'object') for (const [note, rel] of Object.entries(L.files)) add(note, rel);
      else for (const note of L.notes || inst.notes || []) add(note, `${dir}/${note}.${L.ext || ext}`);
      samples.sort((a, b) => a.midi - b.midi);
      if (samples.length) layers.push({ lo: Number(vel[0]) || 0, hi: Number(vel[1] ?? 127), samples });
    }
    if (!layers.length) continue;
    layers.sort((a, b) => a.lo - b.lo);
    const cat = String(inst.category || '').toLowerCase();
    const relRaw = Number.isFinite(inst.release) && inst.release > 0 ? inst.release : defaultRelease;
    const release = clamp(relRaw, RELEASE_RANGE[0], RELEASE_RANGE[1]);
    const trimRaw = Number.isFinite(inst.gainTrim) ? inst.gainTrim : 0;
    const gainTrimDb = clamp(trimRaw, -GAIN_TRIM_MAX_DB, GAIN_TRIM_MAX_DB);
    if (warn && release !== relRaw) warn(`Sample manifest: ${inst.id} release ${relRaw} s clamped to ${release} s.`);
    if (warn && gainTrimDb !== trimRaw) warn(`Sample manifest: ${inst.id} gainTrim ${trimRaw} dB clamped to ${gainTrimDb} dB.`);
    let undampedFrom = !secondary && cat === 'piano' ? PIANO_UNDAMPED_FROM : null;
    if ('undampedFrom' in inst) {
      const u = Number(inst.undampedFrom);
      const off = inst.undampedFrom == null || inst.undampedFrom === false || !Number.isFinite(u);
      undampedFrom = off ? null : clamp(Math.round(u), 0, 128);
    }
    const wd = Number(inst.widthDefault);
    out.push({
      id: `${idPrefix}${inst.id}`,
      name: inst.name || inst.id,
      group: (typeof inst.group === 'string' && inst.group.trim()) || defaultGroup || CATEGORY_GROUP[cat] || 'Piano',
      layers,
      release,
      gainTrimDb,
      undampedFrom,
      widthDefault: inst.widthDefault != null && Number.isFinite(wd) ? clamp(wd, 0, 1.5) : 1,
      decodeOpts: Number.isFinite(Number(inst.maxMonoLossDb)) && inst.maxMonoLossDb != null ? { maxMonoLossDb: Number(inst.maxMonoLossDb) } : undefined,
      license: inst.license || null,
      attribution: inst.attribution || null,
      params: [
        { key: 'release', label: 'Release (τ)', min: RELEASE_RANGE[0], max: RELEASE_RANGE[1], default: release, unit: 's', curve: 'log' },
        { key: 'tone', label: 'Tone', min: 0, max: 1, default: 1, unit: 'lin', curve: 'lin' },
      ],
    });
  }
  return out;
}

/**
 * Onset trim + length cap (REVIEW 2.5/2.6), baked into a new buffer so playback is a plain start(t):
 * start = max(0, first sample > −50 dBFS − 1 ms) with a 2 ms raised-cosine fade-in; length ≤ 10 s above C4
 * (16 s at/below) with a 1 s fade-out when capped.
 * Optional `maxMonoLossDb` (manifest, per instrument): a stereo file whose mono-sum loss (stereo RMS − RMS((L+R)/2))
 * exceeds it — anti-phase mic content, e.g. Salamander C5 ≈ 8 dB — gets its side scaled down to exactly that loss,
 * with the mid raised so the stereo RMS is unchanged (same loudness in stereo, no hole on a mono PA). Baked once at
 * decode, so it costs nothing at note time. `buf._monoFix = {lossDb, mid, side}` records what was done.
 * @param {AudioBuffer} buf
 * @param {number} midi
 * @param {{maxMonoLossDb?:number}} [opts]
 * @returns {AudioBuffer}
 */
export function processSample(buf, midi, opts = {}) {
  const sr = buf.sampleRate;
  const thr = Math.pow(10, ONSET_DB / 20);
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  let onset = buf.length;
  for (const d of chans) {
    for (let i = 0; i < d.length && i < onset; i++) {
      if (Math.abs(d[i]) > thr) {
        onset = i;
        break;
      }
    }
  }
  if (onset >= buf.length) onset = 0;
  const start = Math.max(0, onset - Math.round(0.001 * sr));
  const cap = Math.round((midi > 60 ? 10 : 16) * sr);
  const len = Math.max(1, Math.min(buf.length - start, cap));
  const capped = buf.length - start > cap;
  const out = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length: len, sampleRate: sr });
  const fi = Math.min(len, Math.round(0.002 * sr));
  const fo = capped ? Math.min(len, Math.round(1.0 * sr)) : 0;
  const os = chans.map((d) => {
    const o = d.slice(start, start + len);
    for (let i = 0; i < fi; i++) o[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fi);
    for (let i = 0; i < fo; i++) o[len - 1 - i] *= i / fo;
    return o;
  });
  const maxLoss = Number(opts?.maxMonoLossDb);
  if (os.length === 2 && Number.isFinite(maxLoss) && maxLoss > 0) out._monoFix = limitMonoLoss(os[0], os[1], maxLoss);
  os.forEach((o, c) => out.copyToChannel(o, c));
  out._onsetTrim = start / sr;
  return out;
}

/** In place: scale side/mid so the mono-sum loss is at most `capDb`, keeping M² + S² (see processSample). */
export function limitMonoLoss(L, R, capDb) {
  let mm = 0;
  let ss = 0;
  for (let i = 0; i < L.length; i++) {
    const m = 0.5 * (L[i] + R[i]);
    const s = 0.5 * (L[i] - R[i]);
    mm += m * m;
    ss += s * s;
  }
  const lossDb = mm > 0 ? 10 * Math.log10((mm + ss) / mm) : 0;
  if (!(mm > 0) || !(ss > 0) || lossDb <= capDb + 1e-3) return { lossDb, mid: 1, side: 1 };
  const k = Math.pow(10, capDb / 10) - 1; // target S²/M²
  const a = Math.sqrt((mm + ss) / ((1 + k) * mm));
  const b = a * Math.sqrt((k * mm) / ss);
  for (let i = 0; i < L.length; i++) {
    const m = 0.5 * (L[i] + R[i]) * a;
    const s = 0.5 * (L[i] - R[i]) * b;
    L[i] = m + s;
    R[i] = m - s;
  }
  return { lossDb, mid: a, side: b };
}

/**
 * Decoded-buffer LRU shared by all sampler instances (and surviving engine.restart()). Budget by
 * channels × frames × 4 bytes (VERIFY Q4), not performance.memory. Buffers referenced by a live instrument or
 * pinned (setlist preload) are never evicted. Once over `capBytes`, eviction goes down to `lowWaterBytes` (85 % of
 * the cap, morning-prep): a small margin so a walk through the library doesn't evict on every single acquire and the
 * steady state sits clearly under the cap.
 * Fetches time out (fetchTimeoutMs, 10 s) and transient failures (network error, timeout, HTTP 5xx/408/429) are
 * retried twice; a URL that still fails is skipped, and retried again by a later acquire (next prepare) after
 * RETRY_AFTER_MS. A 404/410 or an undecodable file is a permanent skip (warned once).
 */
const RETRY_AFTER_MS = 30000;
/**
 * Decoded size assumed for a sample no instrument of its kind has decoded yet (estimateBytes). Measured: the 591
 * factory-song samples decode to 1023.6 MB at 44.1 kHz (integration-2 soak) = 1.73 MB each (morning-prep).
 */
export const DEFAULT_SAMPLE_BYTES = 1.75 * MB;
export class BufferCache {
  constructor({ capBytes = 700 * MB, lowWater = 0.85, warn = () => {}, fetchTimeoutMs = 10000, retries = 2,
    retryDelayMs = 400 } = {}) {
    this.capBytes = capBytes;
    this.lowWaterBytes = capBytes * lowWater;
    this.warn = warn;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.retries = retries;
    this.retryDelayMs = retryDelayMs;
    this.entries = new Map(); // url -> {buffer, bytes, refs:Set, lastUsed}
    this.inflight = new Map();
    this.pinned = new Set();
    this.failed = new Map(); // url -> {at, permanent}
    this.bytes = 0;
    this.sizes = new Map(); // url -> decoded bytes, kept after eviction (estimateBytes; a number per URL)
    this._tick = 0;
  }
  get decodedMB() {
    return this.bytes / MB;
  }
  /** Decoded bytes held by pinned URLs (pins on URLs not decoded yet count 0). */
  get pinnedBytes() {
    let b = 0;
    for (const u of this.pinned) b += this.entries.get(u)?.bytes || 0;
    return b;
  }
  get pinnedMB() {
    return this.pinnedBytes / MB;
  }
  /**
   * Decoded size of a set of sample URLs (deduplicated), without decoding anything: exact for URLs decoded before
   * (also when evicted since), else the mean size of the known URLs sharing the URL's folder (an instrument layer),
   * else DEFAULT_SAMPLE_BYTES. `unknown` = how many URLs were estimated.
   * @param {Iterable<string>} urls
   * @returns {{bytes:number, unknown:number, count:number}}
   */
  estimateBytes(urls) {
    const uniq = new Set(urls);
    const dirOf = (u) => u.slice(0, u.lastIndexOf('/') + 1);
    let byDir = null;
    let bytes = 0;
    let unknown = 0;
    for (const u of uniq) {
      if (this.failed.get(u)?.permanent) continue; // a missing file costs nothing
      const known = this.sizes.get(u);
      if (known !== undefined) {
        bytes += known;
        continue;
      }
      if (!byDir) {
        byDir = new Map();
        for (const [k, v] of this.sizes) {
          const d = dirOf(k);
          const a = byDir.get(d) || { n: 0, sum: 0 };
          a.n += 1;
          a.sum += v;
          byDir.set(d, a);
        }
      }
      const a = byDir.get(dirOf(u));
      bytes += a ? a.sum / a.n : DEFAULT_SAMPLE_BYTES;
      unknown += 1;
    }
    return { bytes, unknown, count: uniq.size };
  }
  _skip(url) {
    const f = this.failed.get(url);
    if (!f) return false;
    if (f.permanent || Date.now() - f.at < RETRY_AFTER_MS) return true;
    this.failed.delete(url); // transient failure long enough ago: try again
    return false;
  }
  /**
   * Decode (once) and reference a sample. Resolves null on failure (warn once per URL). `opts` (processSample:
   * maxMonoLossDb) applies at the first decode of a URL; callers pass the instrument def's value every time.
   */
  async acquire(url, ctx, midi, owner, opts) {
    let e = this.entries.get(url);
    if (!e) {
      if (this._skip(url)) return null;
      let p = this.inflight.get(url);
      if (!p) {
        p = this._load(url, ctx, midi, opts).finally(() => this.inflight.delete(url));
        this.inflight.set(url, p);
      }
      const buffer = await p;
      if (!buffer) return null;
      e = this.entries.get(url);
      if (!e) {
        const bytes = buffer.numberOfChannels * buffer.length * 4;
        e = { buffer, bytes, refs: new Set(), lastUsed: 0 };
        this.entries.set(url, e);
        this.bytes += bytes;
        this.sizes.set(url, bytes);
      }
    }
    if (owner) e.refs.add(owner);
    e.lastUsed = ++this._tick;
    this._evict();
    return e.buffer;
  }
  async _fetchOnce(url) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), this.fetchTimeoutMs) : null;
    try {
      const res = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.transient = res.status >= 500 || res.status === 408 || res.status === 429;
        throw err;
      }
      return await res.arrayBuffer();
    } catch (e) {
      if (e && e.transient !== undefined) throw e;
      // network error or timeout (AbortError): transient (DOMException properties are read-only → wrap)
      const err = new Error(e?.name === 'AbortError' ? `timed out after ${this.fetchTimeoutMs / 1000} s` : e?.message || String(e));
      err.transient = true;
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async _load(url, ctx, midi, opts) {
    let ab = null;
    let err = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        ab = await this._fetchOnce(url);
        err = null;
        break;
      } catch (e) {
        err = e;
        if (!e.transient) break;
        if (attempt < this.retries) await new Promise((r) => setTimeout(r, this.retryDelayMs * (attempt + 1)));
      }
    }
    try {
      if (err) throw err;
      const decoded = await ctx.decodeAudioData(ab);
      return processSample(decoded, midi, opts);
    } catch (e) {
      const permanent = !e?.transient;
      if (!this.failed.has(url)) this.warn(`Sample missing or undecodable, skipped: ${url} (${e?.message || e})`);
      this.failed.set(url, { at: Date.now(), permanent });
      return null;
    }
  }
  release(owner) {
    for (const e of this.entries.values()) e.refs.delete(owner);
    this._evict();
  }
  /**
   * Forget these URLs (a My Samples rescan, round2-engine m2): their failure marks are cleared (a fixed file is
   * fetched again) and decoded buffers no live instrument references are dropped (a re-imported file at the same
   * URL is decoded again). Buffers still referenced keep playing in their instruments; pins are left alone.
   * @param {Iterable<string>} urls
   * @returns {{failed:number, dropped:number}} how many failure marks and buffers were removed
   */
  invalidate(urls) {
    let failed = 0;
    let dropped = 0;
    for (const u of urls) {
      if (this.failed.delete(u)) failed++;
      this.sizes.delete(u); // a re-imported file may differ in length
      const e = this.entries.get(u);
      if (e && !e.refs.size) {
        this.entries.delete(u);
        this.bytes -= e.bytes;
        dropped++;
      }
    }
    return { failed, dropped };
  }
  /** Add to the pin set (union): a neighbour preload never unpins the setlist (REVIEW #12). */
  pin(urls) {
    for (const u of urls) this.pinned.add(u);
    this._evict();
  }
  /** Replace the pin set (e.g. a new setlist). */
  setPins(urls) {
    this.pinned = new Set(urls);
    this._evict();
  }
  /** Remove these URLs from the pin set. */
  unpin(urls) {
    for (const u of urls) this.pinned.delete(u);
    this._evict();
  }
  _evict() {
    if (this.bytes <= this.capBytes) return;
    const cands = [...this.entries.entries()]
      .filter(([u, e]) => !e.refs.size && !this.pinned.has(u))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [u, e] of cands) {
      if (this.bytes <= this.lowWaterBytes) break;
      this.entries.delete(u);
      this.bytes -= e.bytes;
    }
  }
}

/**
 * Sampled (decaying) instruments get 32 voices, not §3.2's 16: a pedalled piano run easily holds more than 16
 * ringing notes. Same steal policy (oldest-released, then oldest-held, 20 ms fade) via BasicAllocator.
 */
export const SAMPLER_MAX_VOICES = 32;

/** Sampler Instrument (SPEC §3.2 interface). */
export class SamplerInstrument {
  constructor(ctx, prng, def, initialParams = {}, { cache, warn = () => {}, onProgress } = {}) {
    this.ctx = ctx;
    this.def = def;
    this.id = def.id;
    this.cache = cache || new BufferCache({ warn });
    this.warn = warn;
    this.params = {};
    for (const p of def.params) {
      const v = Number(initialParams?.[p.key]);
      this.params[p.key] = Number.isFinite(v) ? clamp(v, p.min, p.max) : p.default;
    }
    this.multiLayer = def.layers.length > 1;
    this.output = new GainNode(ctx, { gain: Math.pow(10, def.gainTrimDb / 20) });
    /** Stereo width this instrument ships at (manifest widthDefault); the engine's slot width multiplies it. */
    this.widthDefault = Number.isFinite(def.widthDefault) ? def.widthDefault : 1;
    // Butterworth; tone 1 (no morph) puts the corner at Nyquist, where Chromium's lowpass is an exact bypass
    this.tone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: this._toneHz(), Q: BUTTER2_Q });
    this.tone.connect(this.output);
    this.alloc = new BasicAllocator(SAMPLER_MAX_VOICES);
    this.layers = def.layers.map((L) => ({ lo: L.lo, hi: L.hi, samples: [] }));
    this.bend = 0;
    this.morphX = 0;
    this.disposed = false;
    this.ready = this._load(onProgress);
  }

  urls() {
    return this.def.layers.flatMap((L) => L.samples.map((s) => s.url));
  }

  async _load(onProgress) {
    const jobs = [];
    this.def.layers.forEach((L, li) => L.samples.forEach((s) => jobs.push({ li, s })));
    let done = 0;
    const total = jobs.length || 1;
    onProgress?.(0);
    let i = 0;
    const worker = async () => {
      while (i < jobs.length && !this.disposed) {
        const { li, s } = jobs[i++];
        const buffer = await this.cache.acquire(s.url, this.ctx, s.midi, this, this.def.decodeOpts);
        if (buffer) this.layers[li].samples.push({ midi: s.midi, buffer });
        onProgress?.(++done / total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
    for (const L of this.layers) L.samples.sort((a, b) => a.midi - b.midi);
    this.layers = this.layers.filter((L) => L.samples.length);
    if (!this.layers.length && !this.disposed) this.warn(`${this.def.name}: no samples could be loaded.`);
    onProgress?.(1);
  }

  _toneHz() {
    const t = clamp(this.params.tone ?? 1, 0, 1);
    const f = 500 * Math.pow(40, clamp(t + 0.3 * (this.morphX || 0), 0, 1));
    return f >= 19999 ? this.ctx.sampleRate / 2 : f;
  }

  /** Velocity 0..127 → layer (containing it, else nearest). */
  layerFor(vel127) {
    let best = null;
    let bd = Infinity;
    for (const L of this.layers) {
      const d = vel127 < L.lo ? L.lo - vel127 : vel127 > L.hi ? vel127 - L.hi : 0;
      if (d < bd) {
        bd = d;
        best = L;
      }
    }
    return best;
  }

  /** Nearest sampled note in a layer (tie → the lower sample, i.e. repitch up). */
  static nearest(samples, note) {
    let best = null;
    for (const s of samples) if (!best || Math.abs(s.midi - note) < Math.abs(best.midi - note)) best = s;
    return best;
  }

  noteOn(note, vel01, when) {
    if (this.disposed || !this.layers.length) return null;
    const ctx = this.ctx;
    const t = atT(ctx, when);
    const n = clamp(Math.round(note), 0, 127);
    const v01 = clamp(Number.isFinite(vel01) ? vel01 : 0.8, 0, 1);
    const L = this.layerFor(Math.round(v01 * 127));
    const s = SamplerInstrument.nearest(L.samples, n);
    this.alloc.makeRoom(t);
    const v = new BasicVoice(ctx, n, t);
    const src = v.addSource(
      new AudioBufferSourceNode(ctx, { buffer: s.buffer, playbackRate: Math.pow(2, (n - s.midi) / 12), detune: this.bend * 100 }),
      t,
    );
    const env = v.add(new GainNode(ctx, { gain: 0 }));
    let head = src;
    let gDb;
    if (this.multiLayer) gDb = -10 * (1 - v01); // layers carry the dynamics: only a −10 dB span
    else {
      gDb = -24 * (1 - v01); // single layer: −24 dB span + LPF 2 k → 12 k with velocity
      const lp = v.add(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2000 * Math.pow(6, v01), Q: BUTTER2_Q }));
      head.connect(lp);
      head = lp;
    }
    head.connect(env).connect(this.tone);
    setNow(env.gain, Math.pow(10, gDb / 20), t); // 2 ms fade-in is baked into the buffer
    v.out = env;
    v.src = src;
    v.release = clamp(this.params.release, 0.005, 5) * 6.9; // params.release is τ; BasicVoice wants time-to-−60 dB
    // undamped strings: only where the manifest says so (factory pianos by default), never a sustaining user pack,
    // which would otherwise ring at full level to the end of its sample after note-off (round2-engine M1)
    const ud = this.def.undampedFrom;
    v.ignoreRelease = ud != null && n >= ud;
    src.start(t);
    return this.alloc.add(v);
  }
  noteOff(voice, when) {
    voice?.releaseAt?.(when);
  }
  fadeOutVoice(voice, when, fadeSec = 0.03) {
    voice?.fadeOut?.(when, fadeSec);
  }
  allOff(when, fadeSec = 0.03) {
    this.alloc.allOff(atT(this.ctx, when), fadeSec);
  }
  setParam(key, value, when) {
    const p = this.def.params.find((x) => x.key === key);
    if (!p) return false;
    this.params[key] = clamp(Number(value), p.min, p.max);
    if (key === 'tone') rampTo(this.tone.frequency, this._toneHz(), atT(this.ctx, when), 0.015);
    return true;
  }
  getParam(key) {
    return this.params[key];
  }
  morph(x, when) {
    this.morphX = clamp(Number(x) || 0, 0, 1);
    rampTo(this.tone.frequency, this._toneHz(), atT(this.ctx, when), 0.03);
  }
  setBend(semis, when) {
    this.bend = Number(semis) || 0;
    const t = atT(this.ctx, when);
    for (const v of this.alloc.voices) if (v.src && v.state !== 'dead') rampTo(v.src.detune, this.bend * 100, t, 0.008);
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
    this.cache.release(this);
    try {
      this.tone.disconnect();
      this.output.disconnect();
    } catch {}
  }
}
