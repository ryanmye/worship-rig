// Browser side of the golden renderer (tools/golden/render.mjs). One call renders one fixture of fixtures.mjs into an
// OfflineAudioContext at 44.1 kHz with the app's own AudioEngine (app/js/engine), exactly as the app builds it, and
// returns the two channels as base64 float32 plus what the engine resolved (normalized patch, trims, stats).
//
// Isolation: a fixture may INJECT a dry stimulus (stimuli.mjs) at a named node of the engine graph and TAP a named
// node instead of the master output (the TAP/INJECT tables below; native/golden/README.md documents them as the test
// points the native engine must expose). The default tap is 'out' (fx.out → destination, the whole master chain).
import { AudioEngine } from '/js/engine/index.js';
import { Drone } from '/js/engine/drone.js';
import { renderDroneLoop } from '/js/engine/drone-freeze.js';
import { makeStimulus, GOLDEN_SR } from './stimuli.mjs';

const MANIFESTS = ['./samples/manifest.json']; // factory only: no My Samples (no /api/ on this server)

function b64(f32) {
  const u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}

const clone = (x) => JSON.parse(JSON.stringify(x ?? null));

/** Sampler buffers (they carry processSample's `_onsetTrim`) that an AudioBufferSourceNode actually started. */
const STARTED = new Set();
{
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function patchedStart(...a) {
    const b = this.buffer;
    if (b && b._onsetTrim !== undefined) STARTED.add(b);
    return start.apply(this, a);
  };
}

/** The cache entries (URL keys) whose buffers were started: the samples a fixture really plays. */
function samplesUsed(engine) {
  const out = [];
  for (const [key, e] of engine.cache.entries) {
    if (!STARTED.has(e.buffer)) continue;
    const b = e.buffer;
    const raw = key.split('#max=')[0];
    // origin (a random port) is not part of the identity
    const url = /^https?:/.test(raw) ? new URL(raw).pathname : raw;
    out.push({ key, url, frames: b.length, rate: b.sampleRate, channels: b.numberOfChannels,
      dualMono: !!b._dualMono, onsetTrimSec: b._onsetTrim, capped: !!b._capped, monoFix: b._monoFix || null });
  }
  return out.sort((x, y) => (x.key < y.key ? -1 : 1));
}

/**
 * Chromium's own decode of one sample file at the file's NATIVE rate (no resampling): what a decoder-independent
 * native test feeds the sampler (tools/golden/pcm.mjs). `rate` comes from the MP3 header (node side).
 */
export async function decodePcm(url, rate) {
  const ab = await (await fetch(url)).arrayBuffer();
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: rate });
  const buf = await ctx.decodeAudioData(ab);
  const chs = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chs.push(b64(buf.getChannelData(c)));
  return { rate: buf.sampleRate, frames: buf.length, channels: chs, bytes: ab.byteLength };
}

/**
 * Wrap a seeded Rng so its calls are counted per stream name (manifest `randomness`: which PRNG streams a fixture
 * actually consumes). Every method delegates to the original, so the values drawn are unchanged; forks are wrapped
 * under the same name. Counts are method calls (gaussian may draw 0 or 2 values).
 */
function countingRng(rng, name, draws) {
  if (!rng || typeof rng.next !== 'function') return rng;
  const w = Object.create(null);
  for (const k of ['next', 'range', 'int', 'gaussian', 'pick', 'shuffle']) {
    if (typeof rng[k] !== 'function') continue;
    w[k] = (...a) => {
      draws[name] = (draws[name] || 0) + 1;
      return rng[k](...a);
    };
  }
  w.seed = rng.seed;
  w.fork = () => countingRng(rng.fork(), name, draws);
  return w;
}

/** Nodes a stimulus can be injected into. */
const INJECT = {
  'fx.sum': (e) => e.fx.sum, // the dry/return sum, before lofi
  'fx.reverb.input': (e) => e.fx.reverb.input, // reverb send bus (HPF 180 → LPF 9k → predelay → IR → return)
  'fx.delay.input': (e) => e.fx.delay.input,
  'fx.chorus.input': (e) => e.fx.chorus.input, // mono input (channelCount 1)
  'fx.eqIn': (e) => e.fx.eqIn, // master EQ input (after lofi)
  'fx.preComp': (e) => e.fx.preComp, // catcher compressor → soft clip → out
  'slot0.strip': (e) => e.slots[0].strip.input, // slot 0 strip: fader → wheel → width → EQ → pan
};
/** Nodes that can replace the master output as the recorded signal. */
const TAP = {
  out: (e) => e.fx.out,
  'fx.sum': (e) => e.fx.sum,
  'fx.reverb.output': (e) => e.fx.reverb.output, // after return gain and wheel
  'fx.delay.output': (e) => e.fx.delay.output,
  'fx.chorus.output': (e) => e.fx.chorus.output,
  'fx.lofi.output': (e) => e.fx.eqIn, // lofi writes into eqIn: tapping eqIn = the lofi chain's output
  'fx.eqOut': (e) => e.fx.eqHigh, // master EQ output
  'fx.master': (e) => e.fx.master, // after glue + master volume
  'slot0.pan': (e) => e.slots[0].strip.pan, // slot 0 post-strip (instrument → trim → strip), before sends/sum
  'slot1.pan': (e) => e.slots[1].strip.pan,
};

/**
 * Apply one timed event. Events are issued up front in time order with {when} (as tools/lib/render-page.js), EXCEPT
 * the types a fixture lists in `setup.live`: those are called at their time by the engine's own AudioTimer (the
 * offline timer suspends the render at the first 128-frame quantum boundary >= t and calls with when = that boundary).
 * Needed where the engine reads state at call time that another event changes: `swell` is a state machine on timers
 * (a later stop issued up front would replace the start before it ran), and `routing` changes `_routing` at call
 * time while `bend` / `wheel` read it (issued up front they would all see the first routing).
 */
function dispatch(engine, ev, ctx, live) {
  if (!live.has(ev.type)) return applyEvent(engine, ev, ctx);
  engine.timer.at(ev.t, (tt) => applyEvent(engine, { ...ev, t: tt }, ctx));
  return true;
}
function applyEvent(engine, ev, ctx) {
  const when = ev.t;
  switch (ev.type) {
    case 'noteOn':
      return engine.noteOn(ev.note, ev.vel, ev.touch ? { when, touch: ev.touch } : { when });
    case 'noteOff':
      return engine.noteOff(ev.note, { when });
    case 'pedal':
      return engine.sustain(!!ev.down, { when });
    case 'cc':
      // controller.js mapping for the standard CCs: 1 mod wheel, 11 expression, 7 volume, 64 sustain (≥ 64 = down)
      if (ev.cc === 1) return engine.setWheel('mod', ev.value / 127, { when });
      if (ev.cc === 11) return engine.setWheel('expr', ev.value / 127, { when });
      if (ev.cc === 7) return engine.volumeCC(ev.value / 127, { when });
      if (ev.cc === 64) return engine.sustain(ev.value >= 64, { when });
      throw new Error(`cc ${ev.cc} not mapped`);
    case 'wheel':
      return engine.setWheel(ev.source, ev.value, { when, glide: ev.glide || 0 });
    case 'bend':
      return engine.pitchBend(ev.value, { when });
    case 'param':
      return engine.setParam(ev.path, ev.value, { when, glide: ev.glide || 0 });
    case 'droneKey':
      return engine.drone.setKey(ev.pc, { minor: !!ev.minor, when, ...(ev.fade ? { fade: ev.fade } : {}) });
    case 'clickStart':
      return engine.clickStart({ when, countIn: ev.countIn || 0, quietAfter: !!ev.quietAfter });
    case 'clickStop':
      return engine.clickStop({ when });
    case 'swell':
      return engine.swell(!!ev.start, { when });
    // ---- T17 additions (calls without a `when` argument apply at call time; events are issued in time order) ----
    case 'transpose':
      return engine.setTranspose(ev.semis); // read by the next noteOn / noteOff call
    case 'keyContext':
      return engine.setKeyContext(ev.pc, !!ev.minor);
    case 'routing':
      return engine.setRouting(ev.routing, when);
    case 'panic':
      return engine.allNotesOff({ when });
    case 'fadeOut':
      return engine.fadeOutAll(ev.seconds, { when });
    case 'monoOut':
      return engine.setMono(!!ev.on);
    case 'eqAudition':
      return engine.eqAudition(ev.slot, ev.mode, { when });
    case 'commit': {
      // a song switch: patch `ev.next` of setup.next was prepare()d before the render started
      const tok = ctx.tokens[ev.next];
      if (ev.retain) engine.retainReverb([ctx.nextPatches[ev.next]]);
      if (!engine.commit(tok, { when })) throw new Error(`commit ${ev.next} refused`);
      return true;
    }
    case 'retainReverb':
      return engine.retainReverb([ctx.nextPatches[ev.next]]);
    default:
      throw new Error(`unknown event type ${ev.type}`);
  }
}

async function renderFreeze(fx, t0) {
  // the frozen-drone loop (lowres2): renderDroneLoop renders its own OfflineAudioContext; an offline engine supplies
  // the registry (drone-osc instrument, gain trims) and, when asked, the reverb IR of the given space
  const s = fx.setup;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 128, sampleRate: GOLDEN_SR });
  const engine = new AudioEngine({ context: ctx, seed: fx.seed, manifestUrls: MANIFESTS });
  await engine.start();
  let reverb = null;
  if (s.reverb) {
    const { ir } = engine.fx.reverb.getIR(s.reverb.size, s.reverb.damp);
    reverb = { ir, predelay: s.reverb.predelay, wet: s.reverb.wet };
  }
  const res = await renderDroneLoop({
    DroneClass: Drone,
    registry: engine.registry,
    seed: fx.seed,
    sampleRate: GOLDEN_SR,
    key: s.key,
    params: s.params,
    trimDb: Number(engine.registry.gainTrims?.droneTrim) || 0,
    reverb,
    loopSec: s.loopSec,
    prerollSec: s.prerollSec,
    seamSec: s.seamSec,
  });
  const out = {
    sr: GOLDEN_SR,
    L: b64(res.buffer.getChannelData(0)),
    R: b64(res.buffer.getChannelData(1)),
    warnings: [],
    resolved: { droneTrimDb: Number(engine.registry.gainTrims?.droneTrim) || 0, seam: res.seam, loopSec: res.loopSec },
    ms: Math.round(performance.now() - t0),
  };
  engine.dispose();
  return out;
}

/**
 * Render one fixture (see fixtures.mjs for the schema).
 * @param {object} fx
 * @returns {Promise<object>}
 */
export async function renderFixture(fx) {
  const t0 = performance.now();
  if (fx.kind === 'drone-freeze') return renderFreeze(fx, t0);
  STARTED.clear();
  const s = fx.setup || {};
  const sr = GOLDEN_SR;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(fx.seconds * sr), sampleRate: sr });
  const engine = new AudioEngine({ context: ctx, seed: fx.seed, manifestUrls: MANIFESTS });
  const warnings = [];
  engine.addEventListener('warn', (ev) => warnings.push(ev.detail?.message));
  // fx.* / master.* before start(): start() builds the reverb unit, delay, lofi and glue for the song's values, so
  // commit at t 0 does not crossfade from the default space (a 0.8 s IR swap) or engage the glue late
  const patch = s.patch || {};
  for (const [unit, vals] of Object.entries(patch.fx || {})) {
    for (const [k, v] of Object.entries(vals)) {
      engine.setParam(unit === 'master' ? `master.${k}` : `fx.${unit}.${k}`, v);
    }
  }
  await engine.start();
  const draws = {};
  const reg = engine.registry;
  const create = reg.create.bind(reg);
  let instSeq = 0;
  reg.create = (c, rng, ref, params, opts) => {
    const name = ref && ref.type !== 'synth' && ref.type !== 'organ' && ref.type !== 'sampler' ? `inst|${ref.id}`
      : `inst|${ref?.type}|${ref?.id}|#${++instSeq}`;
    return create(c, countingRng(rng, name, draws), ref, params, opts);
  };
  if (engine.drone?.o?.rng) engine.drone.o.rng = countingRng(engine.drone.o.rng, 'drone', draws);
  if (s.tempo) engine.setTempo(s.tempo);
  if (s.timeSig) engine.setTimeSig(s.timeSig);
  if (s.dynamicRange) engine.setDynamicRange(s.dynamicRange); // TOUCH (D43): settings.dynamicRange, before the song
  if (s.click) engine.setClick(s.click, { when: 0 });
  const tok = await engine.prepare(patch);
  if (!engine.commit(tok, { when: 0 })) throw new Error('commit refused');
  // song switches (events type 'commit'): the later patches are prepared up front, committed at their event time
  const nextCtx = { tokens: [], nextPatches: s.next || [] };
  for (const np of nextCtx.nextPatches) nextCtx.tokens.push(await engine.prepare(np));
  engine.setTranspose(s.transpose || 0);
  if (s.keyContext) engine.setKeyContext(s.keyContext.pc, !!s.keyContext.minor);
  if (s.drone && s.drone.mode && s.drone.mode !== 'off') {
    const { key, ...cfg } = s.drone;
    engine.drone.setKey(key?.pc ?? 0, { minor: !!key?.minor, when: 0 });
    engine.drone.configure(cfg, { when: 0 });
  }
  if (s.wheel) {
    if (Number.isFinite(s.wheel.mod)) engine.setWheel('mod', s.wheel.mod, { when: 0 });
    if (Number.isFinite(s.wheel.expr)) engine.setWheel('expr', s.wheel.expr, { when: 0 });
  }
  // test points
  let stimDef = null;
  if (s.inject) {
    const node = INJECT[s.inject.at]?.(engine);
    if (!node) throw new Error(`inject point ${s.inject.at} unavailable`);
    const st = makeStimulus(s.inject.stimulus, sr);
    stimDef = st.def;
    const buf = new AudioBuffer({ numberOfChannels: 2, length: st.L.length, sampleRate: sr });
    buf.copyToChannel(st.L, 0);
    buf.copyToChannel(st.R, 1);
    const src = new AudioBufferSourceNode(ctx, { buffer: buf });
    const g = new GainNode(ctx, { gain: s.inject.gain ?? 1 });
    src.connect(g).connect(node);
    // slots connect their instrument to the strip on the first note (idle-cpu #1); a stimulus needs no note
    src.start(s.inject.start ?? 0);
  }
  const tapName = s.tap || 'out';
  if (tapName !== 'out') {
    const node = TAP[tapName]?.(engine);
    if (!node) throw new Error(`tap point ${tapName} unavailable`);
    engine.fx.out.disconnect(ctx.destination);
    node.connect(ctx.destination);
  }
  const resolved = {
    patch: clone(engine._patch),
    routing: clone(engine._routing),
    trims: clone(engine.registry.gainTrims),
    slots: engine.slots.map((sc) => (sc ? {
      ref: sc.ref, params: clone(sc.cfg?.params), widthDefault: sc.inst.widthDefault ?? 1,
      fallback: !!sc.inst.isFallback,
    } : null)),
    stimulus: stimDef,
  };
  const evs = [...(fx.events || [])].sort((a, b) => a.t - b.t);
  const live = new Set(s.live || []);
  for (const ev of evs) dispatch(engine, ev, nextCtx, live);
  const buf = await ctx.startRendering();
  resolved.stats = engine._debugStats();
  resolved.samplesUsed = samplesUsed(engine);
  resolved.finalPatch = s.next?.length ? clone(engine._patch) : undefined;
  resolved.rngCalls = draws;
  resolved.reverbKey = engine.fx.reverb.active?.key ?? null;
  engine.dispose();
  return {
    sr: buf.sampleRate,
    L: b64(buf.getChannelData(0)),
    R: b64(buf.getChannelData(1)),
    warnings,
    resolved,
    ms: Math.round(performance.now() - t0),
  };
}
