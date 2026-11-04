// Manifest-driven sampler (SPEC §3.5, REVIEW 2.5, 2.6, 3.10). Decaying instruments only (no loops).
// Manifest (app/samples/manifest.json):
//   { instruments: [{ id, name, category, ext, layers:[{ vel:[lo,hi], dir, notes:['A0','C1',…] }],
//                     release /*τ seconds*/, gainTrim /*dB*/, widthDefault /*stereo width ×, optional*/, group?,
//                     maxMonoLossDb /*optional: per-file anti-phase fix at decode, see processSample*/,
//                     undampedFrom /*optional MIDI note: notes ≥ it ignore note-off (no dampers); null = off*/,
//                     maxSec /*optional decode length cap, s (sustain): null = the legacy 10 s / 16 s rule*/,
//                     license, source, attribution }] }
// Sample URL = <manifest dir>/<layer.dir>/<note>.<ext>. Decoding happens only while an instrument is being
// prepared (its `ready` promise), never at note time.
import { rampTo, setNow } from '../shared/automation.js';
import { parseNoteName } from '../shared/music.js';
import { BasicVoice, BasicAllocator } from './instruments.js';

const ONSET_DB = -50;
/**
 * ci-3: dual-mono tolerance. A stereo file counts as dual mono when max |L − R| over the kept range is at most
 * max(DUAL_MONO_REL × its peak, DUAL_MONO_ABS): −60 dB under the sample's own peak, and never less than −72 dBFS
 * (≈ 8 LSB of 16-bit). Chromium on the macOS runner decodes the same dual-mono MP3s with channels that differ in the
 * last bits (test-mp3 and music-box stayed stereo there: 848 832 vs 424 416 decoded bytes), so an exact compare
 * dropped the v11-memory saving on the Mac. Real stereo content has a side far above either bound.
 */
export const DUAL_MONO_REL = 1e-3;
export const DUAL_MONO_ABS = 2 ** -12;
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
/**
 * Decode length cap (s) for factory pianos / keys without a manifest `maxSec` (sustain): long enough that a pedal-held
 * note rings to the end of its file (the bundled Salamander / VSCO files are ≤ 20 s, tools/samples/download-*.mjs).
 */
export const KEYS_MAX_SEC = 30;
/** Range a manifest `maxSec` is clamped into (s). */
export const MAX_SEC_RANGE = [1, 60];
/** Categories that default to KEYS_MAX_SEC (factory manifests only; user packs keep the legacy cap unless they ask). */
const LONG_CATEGORIES = new Set(['piano', 'ep', 'electric piano', 'electric-piano', 'keys']);
/**
 * The legacy decode cap (REVIEW 2.5/2.6): 10 s above middle C, 16 s at/below. Still used for every set without
 * `maxSec` and for the neighbour-preload copies of long sets (sustain: pin budget).
 * @param {number} midi
 * @returns {number} seconds
 */
export const legacyCapSec = (midi) => (midi > 60 ? 10 : 16);
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
 * `maxSec` (sustain): the decode length cap in seconds, clamped to MAX_SEC_RANGE; null/false = the legacy 10 s / 16 s
 * rule. Absent: factory piano / ep / keys entries get KEYS_MAX_SEC, everything else the legacy rule. It travels in
 * `decodeOpts.maxSec` (processSample).
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
    let maxSec = !secondary && LONG_CATEGORIES.has(cat) ? KEYS_MAX_SEC : null;
    if ('maxSec' in inst) {
      const m = Number(inst.maxSec);
      const off = inst.maxSec == null || inst.maxSec === false || !(m > 0);
      maxSec = off ? null : clamp(m, MAX_SEC_RANGE[0], MAX_SEC_RANGE[1]);
    }
    const decodeOpts = {};
    const loss = Number(inst.maxMonoLossDb);
    if (Number.isFinite(loss) && inst.maxMonoLossDb != null) decodeOpts.maxMonoLossDb = loss;
    if (maxSec) decodeOpts.maxSec = maxSec;
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
      maxSec,
      decodeOpts: Object.keys(decodeOpts).length ? decodeOpts : undefined,
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
 * start = max(0, first sample > −50 dBFS − 1 ms) with a 2 ms raised-cosine fade-in; length ≤ `opts.maxSec` when given
 * (sustain: pianos / keys, so a pedal-held note rings to its natural end), else ≤ 10 s above C4 (16 s at/below); the
 * 1 s fade-out is applied only when the sample is actually truncated. `buf._natural` = the frames after the onset
 * trim (uncapped), `buf._capped` = whether it was truncated (BufferCache keys and exact size estimates).
 * Optional `maxMonoLossDb` (manifest, per instrument): a stereo file whose mono-sum loss (stereo RMS − RMS((L+R)/2))
 * exceeds it — anti-phase mic content, e.g. Salamander C5 ≈ 8 dB — gets its side scaled down to exactly that loss,
 * with the mid raised so the stereo RMS is unchanged (same loudness in stereo, no hole on a mono PA). Baked once at
 * decode, so it costs nothing at note time. `buf._monoFix = {lossDb, mid, side}` records what was done.
 * v11-memory: a stereo file with identical channels comes back as a 1-channel buffer (`buf._dualMono` true; ci-3:
 * identical within DUAL_MONO_REL / DUAL_MONO_ABS, `buf._lrDiff` = the measured max |L − R|).
 * @param {AudioBuffer} buf
 * @param {number} midi
 * @param {{maxMonoLossDb?:number, maxSec?:number}} [opts]
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
  const capSec = Number(opts?.maxSec) > 0 ? Number(opts.maxSec) : legacyCapSec(midi);
  const cap = Math.round(capSec * sr);
  const len = Math.max(1, Math.min(buf.length - start, cap));
  const capped = buf.length - start > cap;
  // v11-memory: a stereo file whose two channels are identical (most Musyng Kite sets are dual mono) is kept as ONE
  // channel: half the decoded bytes. The sampler voice up-mixes it back to two identical channels
  // (SamplerInstrument.noteOn, env channelCountMode 'explicit'), so the output is the same bit for bit when the
  // channels are. ci-3: "identical" within decoder noise (DUAL_MONO_REL / _ABS); channel 0 is kept, so R moves by at
  // most that bound (≤ −60 dB re peak), where the Mac's decoder differs in the last bits.
  const lr = chans.length === 2 ? lrDiff(chans[0], chans[1], start, start + len) : null;
  const dualMono = !!lr && lr.diff <= Math.max(DUAL_MONO_REL * lr.peak, DUAL_MONO_ABS);
  const used = dualMono ? chans.slice(0, 1) : chans;
  const out = new AudioBuffer({ numberOfChannels: used.length, length: len, sampleRate: sr });
  const fi = Math.min(len, Math.round(0.002 * sr));
  const fo = capped ? Math.min(len, Math.round(1.0 * sr)) : 0;
  const maxLoss = Number(opts?.maxMonoLossDb);
  const monoFix = used.length === 2 && Number.isFinite(maxLoss) && maxLoss > 0;
  const fadeIn = (o) => {
    for (let i = 0; i < fi; i++) o[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fi);
  };
  const fadeOut = (o) => {
    for (let i = 0; i < fo; i++) o[o.length - 1 - i] *= i / fo;
  };
  if (monoFix || fi + fo > len) {
    // the mid/side fix needs whole channels in JS (and a cut shorter than both fades gets them as before)
    const os = used.map((d) => {
      const o = d.slice(start, start + len);
      fadeIn(o);
      fadeOut(o);
      return o;
    });
    if (monoFix) {
      // sustain critic: the mid/side factors are measured on exactly what the legacy 10 / 16 s cap keeps (incl. its
      // 1 s fade), so a long variant is the legacy buffer plus a tail, not a re-balanced copy (the whole-buffer
      // stats moved every Salamander note by up to 3.4e-5 in the first seconds)
      const legacyLen = Math.max(1, Math.min(buf.length - start, Math.round(legacyCapSec(midi) * sr)));
      // the legacy fade is already in the data when this IS the legacy cut (len === legacyLen); weigh it in otherwise
      const legacyFade = len > legacyLen ? Math.min(legacyLen, Math.round(1.0 * sr)) : 0;
      out._monoFix = limitMonoLoss(os[0], os[1], maxLoss, { statsLen: legacyLen, fadeLen: legacyFade });
    }
    os.forEach((o, c) => out.copyToChannel(o, c));
  } else {
    // v11-memory (performance #1): no full-length slice() per channel: the kept range is copied straight from the
    // decoded data, and only the two short faded ends go through small temporary arrays (same values). Never
    // getChannelData() on `out`: a channel array handed to JS counts its whole backing store in V8's heap.
    used.forEach((d, c) => {
      out.copyToChannel(d.subarray(start, start + len), c);
      if (fi) {
        const h = d.slice(start, start + fi);
        fadeIn(h);
        out.copyToChannel(h, c, 0);
      }
      if (fo) {
        const t = d.slice(start + len - fo, start + len);
        fadeOut(t);
        out.copyToChannel(t, c, len - fo);
      }
    });
  }
  out._dualMono = dualMono;
  out._lrDiff = lr ? lr.diff : null; // ci-3: max |L − R| of the kept range (Infinity: stopped early, real stereo)
  out._onsetTrim = start / sr;
  out._natural = buf.length - start;
  out._capped = capped;
  return out;
}

/**
 * max |a[i] − b[i]| and max |a[i]| over [from, to) (v11-memory / ci-3: dual-mono detection). Stops at the first
 * difference above 0.01 (−40 dBFS: above either tolerance for any sample peaking under 10), reporting Infinity, so a
 * real stereo file still costs only a few samples.
 * @returns {{diff:number, peak:number}}
 */
function lrDiff(a, b, from, to) {
  let diff = 0;
  let peak = 0;
  for (let i = from; i < to; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > diff) {
      if (d > 0.01) return { diff: Infinity, peak };
      diff = d;
    }
    const v = Math.abs(a[i]);
    if (v > peak) peak = v;
  }
  return { diff, peak };
}

/**
 * In place: scale side/mid so the mono-sum loss is at most `capDb`, keeping M² + S² (see processSample).
 * `statsLen` / `fadeLen` (sustain critic): measure over the first `statsLen` frames with a linear fade-out over the
 * last `fadeLen` of them (what the legacy cap keeps), so every decode variant of a file gets the same factors.
 * @param {Float32Array} L
 * @param {Float32Array} R
 * @param {number} capDb
 * @param {{statsLen?:number, fadeLen?:number}} [o]
 */
export function limitMonoLoss(L, R, capDb, { statsLen = L.length, fadeLen = 0 } = {}) {
  let mm = 0;
  let ss = 0;
  const n = Math.min(L.length, statsLen);
  const f0 = n - Math.min(n, fadeLen);
  for (let i = 0; i < n; i++) {
    // same weight (and the same float32 product) as processSample's fade: o[len-1-j] *= j / fo
    const w = i < f0 ? 1 : (n - 1 - i) / fadeLen;
    const l = w === 1 ? L[i] : Math.fround(L[i] * w);
    const r = w === 1 ? R[i] : Math.fround(R[i] * w);
    const m = 0.5 * (l + r);
    const s = 0.5 * (l - r);
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
 * Variants (sustain): a buffer is stored under a KEY, not its URL. keyOf(url, midi, maxSec) is the URL itself for
 * the legacy 10 s / 16 s cap and `<url>#max=<s>` for a long cap. Once a URL has been decoded, its natural length is
 * known (`meta`), and a long key whose buffer would be identical to the legacy one (the sample is shorter than both
 * caps) collapses to the URL, so only truncated samples are held twice. Pins, `sizes` and estimateBytes() take keys;
 * failure marks and invalidate() take URLs (every variant of that URL).
 */
const RETRY_AFTER_MS = 30000;
/**
 * Decoded size assumed for a sample no instrument of its kind has decoded yet (estimateBytes). Measured: the 591
 * factory-song samples decode to 1023.6 MB at 44.1 kHz (integration-2 soak) = 1.73 MB each (morning-prep).
 */
export const DEFAULT_SAMPLE_BYTES = 1.75 * MB;
const VARIANT_SEP = '#max=';
/** URL part of a cache key. @param {string} key @returns {string} */
export const urlOfKey = (key) => {
  const i = key.indexOf(VARIANT_SEP);
  return i < 0 ? key : key.slice(0, i);
};
/** Long cap of a cache key in seconds (null = the legacy cap). @param {string} key @returns {number|null} */
const maxOfKey = (key) => {
  const i = key.indexOf(VARIANT_SEP);
  return i < 0 ? null : Number(key.slice(i + VARIANT_SEP.length));
};
export class BufferCache {
  constructor({ capBytes = 700 * MB, lowWater = 0.85, warn = () => {}, fetchTimeoutMs = 10000, retries = 2,
    retryDelayMs = 400 } = {}) {
    this.capBytes = capBytes;
    this.lowWaterBytes = capBytes * lowWater;
    this.warn = warn;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.retries = retries;
    this.retryDelayMs = retryDelayMs;
    this.entries = new Map(); // key -> {buffer, bytes, refs:Set, lastUsed}
    this.inflight = new Map(); // key -> Promise<AudioBuffer|null>
    this.pinned = new Set(); // keys
    this.failed = new Map(); // url -> {at, permanent}
    this.bytes = 0;
    this.sizes = new Map(); // key -> decoded bytes, kept after eviction (estimateBytes; a number per key)
    this.meta = new Map(); // url -> {nat (frames after the onset trim), ch, sr, midi}, kept after eviction (sustain)
    // v11-polish (BACKLOG B memory, sustain-critic R1): a legacy-cap copy dropped because its long variant is decoded
    // (supersede): legacy key → long key, and back. The long buffer then answers for the legacy key: has(), acquire()
    // and a pin on the legacy key (it keeps the long one from being evicted).
    this.superseded = new Map();
    this.supersededBy = new Map();
    this.longKeys = new Map(); // url → Set of its long keys ever decoded
    // v11-memory (switch headroom): null = pins are absolute (the pre-v11 rule). A Set (the engine sets it from its
    // first prepare on: the keys of the playing and the incoming song) = the cap is hard: once the unpinned buffers
    // are gone, pinned buffers outside this set and referenced by no instrument are evicted too, LRU first, just
    // enough to stay ≤ capBytes. Referenced buffers are never evicted (gapless rule).
    this.protect = null;
    this._tick = 0;
  }
  /** A key (or the legacy key it stands in for) is in `protect`. */
  _protected(key) {
    if (!this.protect) return true;
    if (this.protect.has(key)) return true;
    const legacy = this.supersededBy.get(key);
    return legacy !== undefined && this.protect.has(legacy);
  }
  /** Decoded bytes referenced by a live instrument (they can't be evicted: gapless rule). */
  get referencedBytes() {
    let b = 0;
    for (const e of this.entries.values()) if (e.refs.size) b += e.bytes;
    return b;
  }
  /**
   * v11-memory: can `extra` more bytes be decoded with the cache ≤ capBytes, evicting only what is neither pinned nor
   * referenced? (Preload warming defers a decode that would push out other pinned songs: AudioEngine._rewarmPins.)
   * @param {number} extra
   * @returns {boolean}
   */
  roomFor(extra) {
    if (this.bytes + extra <= this.capBytes) return true;
    let free = 0;
    for (const [k, e] of this.entries) {
      if (!e.refs.size && !this._isPinned(k) && !(this.protect && this._protected(k))) free += e.bytes;
    }
    return this.bytes - free + extra <= this.capBytes;
  }
  /** A decoded long variant of `url`, if any (sustain variants). @returns {string|null} */
  _longOf(url) {
    for (const k of this.longKeys.get(url) || []) if (this.entries.has(k)) return k;
    return null;
  }
  /** The long key now standing in for legacy key `key`, if its buffer is held. @returns {string|null} */
  _standIn(key) {
    const k = this.superseded.get(key);
    return k && this.entries.has(k) ? k : null;
  }
  /** A pin on this key, or on the legacy key it stands in for. */
  _isPinned(key) {
    if (this.pinned.has(key)) return true;
    const legacy = this.supersededBy.get(key);
    return !!legacy && this.pinned.has(legacy);
  }
  /** Remove a decoded entry (and its stand-in links). */
  _deleteEntry(key) {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.bytes -= e.bytes;
    const legacy = this.supersededBy.get(key);
    if (legacy !== undefined) {
      this.supersededBy.delete(key);
      this.superseded.delete(legacy);
    }
  }
  /**
   * v11-polish (the leaner long-cap swap): `owner` now plays `longKey` instead of the legacy-cap copy `url` (its
   * neighbour preload). The legacy copy goes at once when nothing else references it, pinned or not: the long buffer
   * answers for it from then on (a pin on `url` holds the long buffer instead, has(url) is true, acquire(url) returns
   * it). Before, the legacy copy stayed cached (pinned by the old window, then unpinned until the LRU reached it):
   * +160 MB for a piano song and a higher peak during the switch.
   * @param {string} url the legacy key
   * @param {string} longKey
   * @param {object} owner
   */
  supersede(url, longKey, owner) {
    const e = this.entries.get(url);
    if (e) e.refs.delete(owner);
    if (e && !e.refs.size && longKey !== url && this.entries.has(longKey)) {
      this._deleteEntry(url);
      this.superseded.set(url, longKey);
      this.supersededBy.set(longKey, url);
    }
    this._evict();
  }
  get decodedMB() {
    return this.bytes / MB;
  }
  /** Decoded bytes held by pinned keys (pins on keys not decoded yet count 0). */
  get pinnedBytes() {
    let b = 0;
    const seen = new Set();
    for (const u of this.pinned) {
      const k = this.entries.has(u) ? u : this._standIn(u); // a superseded legacy pin holds its long buffer
      if (!k || seen.has(k)) continue;
      seen.add(k);
      b += this.entries.get(k).bytes;
    }
    return b;
  }
  get pinnedMB() {
    return this.pinnedBytes / MB;
  }
  /**
   * Cache key of a sample at a decode cap (sustain). No `maxSec` → the URL (legacy cap). A long cap →
   * `<url>#max=<s>`, unless the URL's natural length is known and both caps give the same buffer (then the URL: shared).
   * @param {string} url
   * @param {number} midi  the sample's note (the legacy cap depends on it)
   * @param {number|null|undefined} maxSec
   * @returns {string}
   */
  keyOf(url, midi, maxSec) {
    const m = Number(maxSec);
    if (!(m > 0)) return url;
    const meta = this.meta.get(url);
    if (meta) {
      const legacy = Math.round(legacyCapSec(meta.midi ?? midi) * meta.sr);
      if (Math.min(meta.nat, legacy) === Math.min(meta.nat, Math.round(m * meta.sr))) return url;
    }
    return `${url}${VARIANT_SEP}${m}`;
  }
  /** @param {string} key @returns {boolean} a decoded buffer is held under this key */
  has(key) {
    return this.entries.has(key) || !!this._standIn(key);
  }
  /**
   * Decoded size of a set of cache keys (deduplicated), without decoding anything: exact for keys decoded before
   * (also when evicted since) and for any variant of a URL whose natural length is known (sustain), else the mean size
   * of the known keys sharing the key's folder and variant (an instrument layer), else DEFAULT_SAMPLE_BYTES.
   * `unknown` = how many keys were estimated.
   * @param {Iterable<string>} urls  cache keys (a plain URL is the legacy-cap key)
   * @returns {{bytes:number, unknown:number, count:number}}
   */
  estimateBytes(urls) {
    // v11-polish: a legacy key whose long variant is held is served by that buffer (acquire's stand-in), so it costs
    // the long buffer's size, counted once with the long key itself (the pin budget stays true: CONTRACT_CHANGES
    // "## v11-polish")
    const uniq = new Set();
    for (const k of urls) {
      const held = this.entries.has(k) ? null : this._standIn(k) || (k === urlOfKey(k) ? this._longOf(k) : null);
      uniq.add(held || k);
    }
    const groupOf = (k) => {
      const u = urlOfKey(k);
      return `${u.slice(0, u.lastIndexOf('/') + 1)}${k.slice(u.length)}`;
    };
    let byDir = null;
    let bytes = 0;
    let unknown = 0;
    for (const k of uniq) {
      const url = urlOfKey(k);
      if (this.failed.get(url)?.permanent) continue; // a missing file costs nothing
      const known = this.sizes.get(k);
      if (known !== undefined) {
        bytes += known;
        continue;
      }
      const meta = this.meta.get(url);
      if (meta) {
        const m = maxOfKey(k);
        const cap = Math.round((m > 0 ? m : legacyCapSec(meta.midi)) * meta.sr);
        bytes += meta.ch * Math.max(1, Math.min(meta.nat, cap)) * 4;
        continue;
      }
      if (!byDir) {
        byDir = new Map();
        for (const [key, v] of this.sizes) {
          const d = groupOf(key);
          const a = byDir.get(d) || { n: 0, sum: 0 };
          a.n += 1;
          a.sum += v;
          byDir.set(d, a);
        }
      }
      const a = byDir.get(groupOf(k));
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
   * maxMonoLossDb, maxSec) applies at the first decode of a key; callers pass the instrument def's value every time.
   * `opts.maxSec` picks the variant (keyOf): no maxSec = the legacy cap.
   */
  async acquire(url, ctx, midi, owner, opts) {
    let key = this.keyOf(url, midi, opts?.maxSec);
    let e = this.entries.get(key);
    if (!e && this._standIn(key)) e = this.entries.get(this._standIn(key)); // superseded: the long buffer answers
    if (!e && key === url) {
      // v11-polish: a legacy-cap request (a neighbour preload) for a URL whose long variant is decoded (the song just
      // left) takes the long buffer instead of decoding a second, shorter copy of the same file (the +160 MB of
      // short neighbour copies after a switch away from a piano song). Same audio up to the legacy cap.
      const long = this._longOf(url);
      if (long) {
        this.superseded.set(url, long);
        this.supersededBy.set(long, url);
        e = this.entries.get(long);
      }
    }
    if (!e) {
      if (this._skip(url)) return null;
      let p = this.inflight.get(key);
      if (!p) {
        p = this._load(url, ctx, midi, opts).finally(() => this.inflight.delete(key));
        this.inflight.set(key, p);
      }
      const buffer = await p;
      if (!buffer) return null;
      // the first decode of a URL learns its natural length: a long key may collapse to the URL (same buffer)
      key = this.keyOf(url, midi, opts?.maxSec);
      e = this.entries.get(key);
      if (!e) {
        const bytes = buffer.numberOfChannels * buffer.length * 4;
        this._evict(bytes); // v11-memory: make room first, so decodedMB never passes the cap by the new buffer
        e = { buffer, bytes, refs: new Set(), lastUsed: 0 };
        this.entries.set(key, e);
        if (key !== url) {
          if (!this.longKeys.has(url)) this.longKeys.set(url, new Set());
          this.longKeys.get(url).add(key);
        }
        this.bytes += bytes;
        this.sizes.set(key, bytes);
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
      const out = processSample(decoded, midi, opts);
      this.meta.set(url, { nat: out._natural, ch: out.numberOfChannels, sr: out.sampleRate, midi });
      return out;
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
  /** Drop one owner's reference to one key (sustain: an instrument that moved to a sample's long variant). */
  drop(key, owner) {
    this.entries.get(key)?.refs.delete(owner);
    this._evict();
  }
  /**
   * Forget these URLs (a My Samples rescan, round2-engine m2): their failure marks are cleared (a fixed file is
   * fetched again) and decoded buffers no live instrument references are dropped (a re-imported file at the same
   * URL is decoded again), every variant of each URL. Buffers still referenced keep playing in their instruments;
   * pins are left alone.
   * @param {Iterable<string>} urls
   * @returns {{failed:number, dropped:number}} how many failure marks and buffers were removed
   */
  invalidate(urls) {
    let failed = 0;
    let dropped = 0;
    const set = new Set([...urls].map(urlOfKey));
    for (const u of set) {
      if (this.failed.delete(u)) failed++;
      this.meta.delete(u); // a re-imported file may differ in length
    }
    for (const k of [...this.sizes.keys()]) if (set.has(urlOfKey(k))) this.sizes.delete(k);
    for (const [k, e] of [...this.entries]) {
      if (!set.has(urlOfKey(k)) || e.refs.size) continue;
      this._deleteEntry(k);
      dropped++;
    }
    return { failed, dropped };
  }
  /**
   * v11-memory: drop every decoded buffer that is neither pinned, referenced nor protected (low-resource mode: the
   * evictable LRU content is not needed while hidden in the menu bar; the window comes back on leaving it).
   * @returns {number} bytes freed
   */
  trimUnpinned() {
    const before = this.bytes;
    for (const [k, e] of [...this.entries]) {
      if (!e.refs.size && !this._isPinned(k) && !(this.protect && this._protected(k))) this._deleteEntry(k);
    }
    return before - this.bytes;
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
  /**
   * Over the cap (counting `incoming` bytes about to be inserted): evict unpinned, unreferenced buffers LRU-first
   * down to the low-water mark. v11-memory: if that is not enough and `protect` is set, unreferenced pinned buffers
   * outside `protect` follow, LRU-first, only until the cap holds (their pins stay: a later preload or
   * AudioEngine._rewarmPins decodes them again when there is room).
   * @param {number} [incoming]
   */
  _evict(incoming = 0) {
    const limit = this.capBytes - incoming;
    if (this.bytes <= limit) return;
    const lru = (a, b) => a[1].lastUsed - b[1].lastUsed;
    const target = Math.min(this.lowWaterBytes, limit);
    // (with `protect` set, the playing / incoming song's unreferenced copies are not victims: the prepare reuses them)
    const free = ([u, e]) => !e.refs.size && !this._isPinned(u) && !(this.protect && this._protected(u));
    const cands = [...this.entries.entries()].filter(free).sort(lru);
    for (const [u] of cands) {
      if (this.bytes <= target) break;
      this._deleteEntry(u);
    }
    if (this.bytes <= limit || !this.protect) return;
    const pinned = [...this.entries.entries()].filter(([u, e]) => !e.refs.size && !this._protected(u)).sort(lru);
    for (const [u] of pinned) {
      if (this.bytes <= limit) break;
      this._deleteEntry(u);
      this.evictedPinned = (this.evictedPinned || 0) + 1;
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

  /**
   * Decode (or take from the cache) every sample at the instrument's cap (`decodeOpts.maxSec`, sustain). A sample
   * whose long variant isn't decoded yet but whose legacy-cap copy is (a neighbour preload, see
   * AudioEngine._sampleJobs) starts on that copy, so the switch stays as quick as before; `upgraded` then decodes the
   * long variants in the background and swaps them in (notes started before keep their buffer).
   */
  async _load(onProgress) {
    const jobs = [];
    this.def.layers.forEach((L, li) => L.samples.forEach((s) => jobs.push({ li, s })));
    const opts = this.def.decodeOpts;
    const maxSec = opts?.maxSec;
    const legacyOpts = maxSec ? { ...opts, maxSec: undefined } : opts;
    const upgrades = [];
    let done = 0;
    const total = jobs.length || 1;
    onProgress?.(0);
    let i = 0;
    const worker = async () => {
      while (i < jobs.length && !this.disposed) {
        const { li, s } = jobs[i++];
        const key = this.cache.keyOf(s.url, s.midi, maxSec);
        const fallback = maxSec && key !== s.url && !this.cache.has(key) && this.cache.has(s.url);
        const buffer = await this.cache.acquire(s.url, this.ctx, s.midi, this, fallback ? legacyOpts : opts);
        if (buffer) {
          const entry = { midi: s.midi, buffer };
          this.layers[li].samples.push(entry);
          if (fallback) upgrades.push({ entry, s });
        }
        onProgress?.(++done / total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
    for (const L of this.layers) L.samples.sort((a, b) => a.midi - b.midi);
    this.layers = this.layers.filter((L) => L.samples.length);
    if (!this.layers.length && !this.disposed) this.warn(`${this.def.name}: no samples could be loaded.`);
    onProgress?.(1);
    /** Resolves once every sample plays its long variant (sustain); `this.upgrades` = how many were swapped. */
    this.upgraded = upgrades.length ? this._upgrade(upgrades) : Promise.resolve(0);
  }

  /** Background: decode the long variants of samples that started on their legacy-cap copy, one at a time. */
  async _upgrade(list) {
    let n = 0;
    for (const { entry, s } of list) {
      if (this.disposed) break;
      const buf = await this.cache.acquire(s.url, this.ctx, s.midi, this, this.def.decodeOpts);
      if (this.disposed) {
        // sustain critic: disposed while this decode was in flight: acquire() referenced the long buffer after
        // dispose()'s release, which would hold it (unevictable) for the page's life
        this.cache.release(this);
        break;
      }
      if (!buf || buf === entry.buffer) continue;
      entry.buffer = buf;
      n++;
      // v11-polish: the legacy copy goes as soon as the long one is in (was drop(): kept until the LRU reached it)
      this.cache.supersede(s.url, this.cache.keyOf(s.url, s.midi, this.def.decodeOpts?.maxSec), this);
    }
    this.upgrades = n;
    return n;
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
    // v11-memory: 'explicit' 2 channels up-mixes a dual-mono (1-channel) buffer to two identical channels here, so
    // the tone filter, the strip's panner and width see the same stereo signal as before (a mono input would take
    // StereoPanner's mono law: −3 dB at centre). A stereo buffer passes unchanged.
    const env = v.add(new GainNode(ctx, {
      gain: 0, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    }));
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
