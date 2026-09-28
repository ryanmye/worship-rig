// Extra synth patches for genre coverage (modern worship/CCM, gospel/R&B, 80s ballad/synthwave, ambient, lofi, pop).
// Same contract as synth.js (SPEC §3.2): `new SynthExtraInstrument(ctx, prng, patchId, initialParams)`, PATCHES metadata
// with the same shape plus `gainTrim` (dB). The registry merges PATCHES next to synth.js's (type 'synth').
//
// Level: `gainTrim` is APPLIED INSIDE the instrument (output = voices → post chain → trim → ceiling → output), exactly like
// synth.js's built-in `trim`. It is published in the metadata for information/audit only — the registry must NOT apply it
// again. Calibrated by test/phase1/synth-extra/run.mjs --calibrate with the tools/calibrate.mjs method: seeded offline
// render at 48 kHz, C3-E3-G3 (Bass group: single C2) at velocity 96, held 3 s, band RMS 100 Hz–5 kHz (Bass: 40 Hz–5 kHz)
// over 0–3 s, stereo mean-square → −18 dBFS at unity. Any gain-trims.json `synth[<id>]` entry stacks on top (≈ 0 dB).
// Exception, declared as `calibWindow: [0, 1]` on the patch: `pluck` is measured over 0–1 s. Its sound is over after
// ~1 s (−20 dB at 1.07 s for C3), so a 0–3 s mean spends two silent seconds and would trim it ~4 dB hot: at −18 over
// 0–3 s a single vel-.8 note already peaks at −0.5 dBFS raw and the 3-note calibration chord at +0.6 dBFS, i.e. the
// output ceiling would soft-clip every attack at unity gain.
//
// Safety ceiling: every patch ends in a shared (one per instrument) WaveShaper that is exactly linear below −3 dBFS and
// bends smoothly (tanh knee) to an asymptote of −1 dBFS, so the instrument output never exceeds −1 dBFS. Raw peaks at the
// calibrated level (test/phase1/synth-extra): the 3-note vel-96 calibration chord stays under the knee on 8 patches
// (−2.9 … −10.5 dBFS); supersaw-pad's reaches −1.9 and dx-epiano's onset +0.4 dBFS (≈2 dB of shaping on the first
// milliseconds: a decaying EP calibrated on its 0–3 s mean has ~18 dB crest). 8 voices at velocity 127 reach −5 … +7 dBFS
// raw (synth-bass +7.1, dx +5.2, pluck +4.0, pads +0.5…+2.6). No oversampling: it only shapes onset peaks.
//
// CPU (REVIEW 2.x / synth.js conventions): LFOs, filter offsets (cutoff param + morph, cents), PWM duty, vibrato depth,
// chorus, tremolo, width, brightness and saturation are ONE node each per instrument, fanned out to the voices through
// `voice.link` (torn down with the voice). Filter frequency/detune and oscillator detune run k-rate (per 128-sample
// block); per-voice filter envelopes are setTarget/linear automation on those k-rate params. No per-voice convolvers
// or waveshapers. Saws are the shared phase-rotated PeriodicWaves (random start phase per oscillator, REVIEW 3.3).
// All automation goes through shared/automation.js; linearTo/glideTo scheduled ahead pass `{from}` (fixups #1).
import { rampTo, setNow, linearTo } from '../shared/automation.js';
import { noteToFreq } from '../shared/music.js';
import {
  InstrumentBase, makeEnv, phaseRotatedSawWaves, rotatedWaves, softClipCurve, keytrack, clamp, TrackedParam,
} from './voice.js';

const P = (key, label, min, max, def, unit = 'lin', curve = 'lin', extra = {}) =>
  Object.freeze({ key, label, min, max, default: def, unit, curve, ...extra });

const ATTACK = (def, max = 8) => P('attack', 'Attack', 0.002, max, def, 's', 'log');
const DECAY = (def, max = 6) => P('decay', 'Decay', 0.02, max, def, 's', 'log');
const SUSTAIN = (def) => P('sustain', 'Sustain', 0, 1, def);
const RELEASE = (def, max = 12) => P('release', 'Release', 0.03, max, def, 's', 'log');
const CUTOFF = (def, min = 200, max = 14000) => P('cutoff', 'Cutoff', min, max, def, 'Hz', 'log');
const RESO = (def) => P('resonance', 'Resonance', 0, 1, def);
const GLIDE = (def) => P('glide', 'Legato glide', 0, 0.5, def, 's', 'lin');

const patch = (id, name, group, gainTrim, params, extra = {}) =>
  Object.freeze({ id, name, group, gainTrim, ...extra, params: Object.freeze(params) });

/** Patch metadata (listInstruments merges these). Keys are stable: presets store them. `gainTrim` dB, applied internally. */
export const PATCHES = Object.freeze([
  // ---- Synth Pads
  patch('supersaw-pad', 'Supersaw Pad', 'Synth Pads', 0, [
    ATTACK(0.6), DECAY(1.2), SUSTAIN(0.85), RELEASE(2.5), CUTOFF(3000), RESO(0),
    P('detune', 'Detune spread (cents)', 0, 50, 25),
    P('width', 'Stereo width', 0, 1, 0.6),
    P('sub', 'Sub level', 0, 1, 0.3),
  ]),
  patch('juno-pad', 'Juno Pad', 'Synth Pads', 0, [
    ATTACK(0.35), DECAY(1.5), SUSTAIN(0.8), RELEASE(2), CUTOFF(2200), RESO(0.15),
    P('pwmRate', 'PWM rate', 0.05, 6, 0.6, 'Hz', 'log'),
    P('pwmDepth', 'PWM depth', 0, 1, 0.6),
    P('chorus', 'Chorus', 0, 1, 0.6),
    P('chorusRate', 'Chorus rate', 0.1, 2, 0.5, 'Hz', 'log'),
    P('sub', 'Sub level', 0, 1, 0.35),
  ]),
  patch('shimmer-pad', 'Shimmer Pad', 'Synth Pads', 0, [
    ATTACK(1.5), DECAY(2), SUSTAIN(0.9), RELEASE(4, 16), CUTOFF(7000, 500, 16000),
    P('detune', 'Detune (cents)', 0, 25, 7),
    P('octave', 'Octave-up level', 0, 1, 0.35),
    P('bloomTime', 'Octave fade-in', 0.2, 8, 3, 's', 'log'),
    P('tremRate', 'Tremolo rate', 0.05, 4, 0.3, 'Hz', 'log'),
    P('tremDepth', 'Tremolo depth', 0, 1, 0.3),
  ]),
  // ---- Synth Keys
  patch('dx-epiano', 'DX E-Piano', 'Synth Keys', 0, [
    P('decay', 'Decay', 0.3, 3, 1, 'lin', 'log'),
    RELEASE(0.35, 3),
    P('tone', 'Brightness', 0, 2, 1),
    P('tine', 'Tine', 0, 2, 1),
    P('detune', 'Detune (cents)', 0, 12, 3),
    P('chorus', 'Chorus', 0, 1, 0.35),
    GLIDE(0.03),
  ]),
  patch('pluck', 'Pluck', 'Synth Keys', 0, [
    P('decay', 'Decay @C4', 0.1, 4, 0.75, 's', 'log'),
    RELEASE(0.3, 3), CUTOFF(4500), RESO(0.2),
    P('square', 'Square level', 0, 1, 0.5),
    P('detune', 'Detune (cents)', 0, 20, 6),
    GLIDE(0.03),
  ], { calibWindow: [0, 1] }),
  patch('poly-stab', 'Poly Stab', 'Synth Keys', 0, [
    ATTACK(0.005, 1), DECAY(0.45, 3), SUSTAIN(0.5), RELEASE(0.25, 3), CUTOFF(900, 100, 8000), RESO(0.35),
    P('envAmount', 'Filter env amount', 0, 1, 0.6),
    P('detune', 'Detune (cents)', 0, 30, 10),
    GLIDE(0.03),
  ]),
  // ---- Brass & Leads
  patch('analog-brass', 'Analog Brass', 'Brass & Leads', 0, [
    ATTACK(0.06, 2), DECAY(0.4, 3), SUSTAIN(0.85), RELEASE(0.35, 4), CUTOFF(700, 100, 8000),
    P('envAmount', 'Filter env amount', 0, 1, 0.55),
    P('filterAttack', 'Filter attack', 0.005, 1, 0.08, 's', 'log'),
    P('detune', 'Detune (cents)', 0, 30, 8),
    P('vibDepth', 'Vibrato depth (cents)', 0, 30, 7),
    P('vibRate', 'Vibrato rate', 2, 8, 5.2, 'Hz', 'lin'),
    P('vibDelay', 'Vibrato delay', 0, 2, 0.4, 's', 'lin'),
    GLIDE(0.05),
  ]),
  patch('square-lead', 'Square Lead', 'Brass & Leads', 0, [
    ATTACK(0.005, 2), RELEASE(0.2, 4), CUTOFF(3500, 200, 14000), RESO(0.1),
    P('pwm', 'Pulse width', 0, 1, 0),
    P('sub', 'Sub level', 0, 1, 0.4),
    GLIDE(0.06),
    P('vibDepth', 'Vibrato depth (cents)', 0, 40, 10),
    P('vibRate', 'Vibrato rate', 2, 8, 5.5, 'Hz', 'lin'),
    P('vibDelay', 'Vibrato delay', 0, 2, 0.3, 's', 'lin'),
  ]),
  // ---- Bass
  patch('808-sub', '808 Sub', 'Bass', 0, [
    P('decay', 'Decay', 0.2, 8, 2.5, 's', 'log'),
    RELEASE(0.25, 3),
    P('drive', 'Drive', 0, 1, 0.35),
    P('pitchDrop', 'Pitch drop (semitones)', 0, 12, 2),
    P('dropTime', 'Pitch drop time', 0.01, 0.3, 0.06, 's', 'log'),
    GLIDE(0.05),
  ]),
  patch('synth-bass', 'Synth Bass', 'Bass', 0, [
    ATTACK(0.003, 1), DECAY(0.35, 3), SUSTAIN(0.55), RELEASE(0.12, 3), CUTOFF(320, 60, 4000), RESO(0.3),
    P('envAmount', 'Filter env amount', 0, 1, 0.6),
    P('square', 'Square level', 0, 1, 0.5),
    GLIDE(0.03),
  ]),
]);

const BY_ID = new Map(PATCHES.map((p) => [p.id, p]));
const CENTS = (ratio) => 1200 * Math.log2(ratio);
const dbToLin = (d) => Math.pow(10, d / 20);
/** Pluck `decay` = time to −20 dB (ln 10 = 2.303 time constants). */
const PLUCK_T20 = Math.LN10;
/** −3 dB/oct above C4 (REVIEW 3.3). */
const keyLevel = (note) => (note > 60 ? Math.pow(10, (-3 * (note - 60)) / 12 / 20) : 1);

// ---- safety ceiling -----------------------------------------------------------------------------------------------
const CEIL_KNEE = Math.pow(10, -3 / 20); // −3 dBFS: exactly linear below
const CEIL_MAX = Math.pow(10, -1 / 20); // −1 dBFS asymptote
const CEIL_RANGE = 4; // the curve spans ±4 (+12 dBFS); the trim gain pre-divides by this
let CEIL_CURVE = null;
function ceilingCurve() {
  if (CEIL_CURVE) return CEIL_CURVE;
  const N = 4097;
  const c = new Float32Array(N);
  const k = CEIL_KNEE;
  const room = CEIL_MAX - k;
  for (let i = 0; i < N; i++) {
    const s = ((i / (N - 1)) * 2 - 1) * CEIL_RANGE;
    const a = Math.abs(s);
    c[i] = Math.sign(s) * (a <= k ? a : k + room * Math.tanh((a - k) / room));
  }
  c[(N - 1) / 2] = 0;
  CEIL_CURVE = c;
  return c;
}

// ---- helpers (mirroring synth.js) ---------------------------------------------------------------------------------
const COS_CACHE = new WeakMap();
/** Cosine-phase sine (starts at +1), cached per context. */
function cosWave(ctx) {
  return fmModWave(ctx, 0);
}
/**
 * Cosine-phase FM modulator advanced by `adv` radians: cos(θ + adv). Chromium integrates an a-rate oscillator
 * frequency with a half-sample lag (measured: the 1:1 FM DC term vanishes at adv = 0.5 · 2πf/fs, at 44.1 and 48 kHz,
 * 130 Hz–1 kHz), so 1:1 modulators are built with that advance. Quantised to 0.002 rad, cached per context.
 */
function fmModWave(ctx, adv) {
  let byCtx = COS_CACHE.get(ctx);
  if (!byCtx) COS_CACHE.set(ctx, (byCtx = new Map()));
  const k = Math.round(adv / 0.002);
  let w = byCtx.get(k);
  if (!w) {
    const e = k * 0.002;
    w = ctx.createPeriodicWave(new Float32Array([0, Math.cos(e)]), new Float32Array([0, -Math.sin(e)]));
    byCtx.set(k, w);
  }
  return w;
}
function kRate(...params) {
  for (const p of params) {
    try {
      p.automationRate = 'k-rate';
    } catch (e) {
      /* stays a-rate */
    }
  }
}
/** Shared filter offset (cents): cutoff param relative to the recipe's base + morph. */
function initFilterMod(inst, baseHz, morphCents) {
  inst.filterBase = baseHz;
  inst.filterMorphCents = morphCents;
  inst.filterCS = inst.sharedSource(new ConstantSourceNode(inst.ctx, { offset: filterOffsetCents(inst) }));
}
function filterOffsetCents(inst) {
  const c = inst.params.cutoff ?? inst.filterBase;
  return CENTS(c / inst.filterBase) + inst.morphX * inst.filterMorphCents;
}
function updateFilterMod(inst, t) {
  rampTo(inst.filterCS.offset, filterOffsetCents(inst), t);
}
function linkFilter(inst, v, ...filters) {
  for (const f of filters) {
    kRate(f.frequency, f.detune, f.Q);
    v.link(inst.filterCS, f.detune);
  }
}
/**
 * Web Audio lowpass/highpass `Q` is the resonance peak in dB, not a linear Q (the spec's biquad formulas use
 * 10^(Q/20)); recipes here are written in linear Q and converted (same as voice.js BUTTER2_Q / BUTTER4_Q).
 */
const qDb = (q) => 20 * Math.log10(q);
const BUTTER2_Q = qDb(Math.SQRT1_2);
const BUTTER4_Q = [qDb(0.5412), qDb(1.3066)];
/** 4-pole LPF from two biquads (linear Q .5412 / q2; q2 = 1.3066 = Butterworth, higher = resonance). */
function lpfPair(inst, v, freq, q2 = 1.3066) {
  const a = v.add(new BiquadFilterNode(inst.ctx, { type: 'lowpass', frequency: freq, Q: BUTTER4_Q[0] }));
  const b = v.add(new BiquadFilterNode(inst.ctx, { type: 'lowpass', frequency: freq, Q: qDb(q2) }));
  a.connect(b);
  return [a, b];
}
/** Oscillator-frequency params of a voice as TrackedParams (lazily from v.data.pitched = [[param, mult]]). */
function tracked(v) {
  if (!v.data.tracked) v.data.tracked = (v.data.pitched || []).map(([param, mult]) => ({ tp: new TrackedParam(param, v.data.f * mult), mult }));
  return v.data.tracked;
}
/** Period-proportional params (PWM delay scalers = mult/f) as TrackedParams. */
function trackedPeriods(v) {
  if (!v.data.trackedP) v.data.trackedP = (v.data.periods || []).map(([param, mult]) => ({ tp: new TrackedParam(param, mult / v.data.f), mult }));
  return v.data.trackedP;
}
function glidePitched(inst, v, note, t) {
  const f = noteToFreq(note);
  const dur = inst.params.glide ?? 0.03;
  for (const e of tracked(v)) e.tp.glide(f * e.mult, t, dur);
  for (const e of trackedPeriods(v)) e.tp.glide(e.mult / f, t, dur);
  v.data.f = f;
}
function standardRelease(inst, v) {
  v.onRelease = (rt) => v.env.release(rt, inst.params.release);
}
/**
 * Start of the render quantum containing `t` (never before now). FM stacks start there so carrier and modulator
 * begin phase-aligned (see dx-epiano); the voice's envelope still starts at `t`.
 */
function blockStart(ctx, t) {
  const q = 128 / ctx.sampleRate;
  return Math.max(ctx.currentTime, Math.floor(t / q + 1e-9) * q);
}
/** Band-limited square PeriodicWaves at 8 start phases (random phase per oscillator, like the saws). Cached. */
function squareWaves(ctx) {
  const H = 511;
  const sin = new Float32Array(H + 1);
  for (let k = 1; k <= H; k += 2) sin[k] = 4 / (Math.PI * k);
  return rotatedWaves(ctx, 'x-square', sin, 8);
}
/** Maximum DelayNode time for a PWM delay of this voice (duty ≤ .95; legato down to ~1 octave). */
const pwmMaxDelay = (f) => clamp(2.2 / f, 0.004, 1);
/**
 * Pulse from one saw: pulse(t) = saw(t) − saw(t − duty·T). The delay time comes from the instrument's shared duty
 * signal (0..1) scaled per voice by `periodG` (gain = 1/f, glided on legato). Returns the pulse node.
 */
function pwmPulse(inst, v, saw, f, level) {
  const ctx = inst.ctx;
  const periodG = v.add(new GainNode(ctx, { gain: 1 / f }));
  const dl = v.add(new DelayNode(ctx, { delayTime: 0, maxDelayTime: pwmMaxDelay(f) }));
  const inv = v.add(new GainNode(ctx, { gain: -1 }));
  const sum = v.add(new GainNode(ctx, { gain: level }));
  v.link(inst.dutyCS, periodG);
  if (inst.pwmG) v.link(inst.pwmG, periodG);
  periodG.connect(dl.delayTime);
  saw.connect(sum);
  saw.connect(dl).connect(inv).connect(sum);
  return { sum, periodG };
}

/**
 * Shared 2-voice stereo chorus (Juno-style): mono in, L = dry + wetA, R = dry + wetB, the two delay lines modulated
 * by one triangle LFO in anti-phase. Mono-compatible (both wets are pitch-modulated copies of the dry).
 */
function buildChorus(inst, input, rate) {
  const ctx = inst.ctx;
  const mono = inst.shared(new GainNode(ctx, { gain: 1, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' }));
  const merger = inst.shared(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
  const dry = inst.shared(new GainNode(ctx, { gain: 1 }));
  const dA = inst.shared(new DelayNode(ctx, { delayTime: 0.0035, maxDelayTime: 0.02 }));
  const dB = inst.shared(new DelayNode(ctx, { delayTime: 0.0035, maxDelayTime: 0.02 }));
  const wA = inst.shared(new GainNode(ctx, { gain: 0 }));
  const wB = inst.shared(new GainNode(ctx, { gain: 0 }));
  const lfo = inst.sharedSource(new OscillatorNode(ctx, { type: 'triangle', frequency: rate }));
  const modA = inst.shared(new GainNode(ctx, { gain: 0 }));
  const modB = inst.shared(new GainNode(ctx, { gain: 0 }));
  input.connect(mono);
  mono.connect(dry);
  mono.connect(dA);
  mono.connect(dB);
  lfo.connect(modA).connect(dA.delayTime);
  lfo.connect(modB).connect(dB.delayTime);
  dry.connect(merger, 0, 0);
  dry.connect(merger, 0, 1);
  dA.connect(wA).connect(merger, 0, 0);
  dB.connect(wB).connect(merger, 0, 1);
  const ch = { out: merger, lfo, modA, modB, wA, wB, dry };
  ch.set = (amount, t) => {
    const c = clamp(amount, 0, 1);
    const depth = (0.4 + 1.6 * c) / 1000; // ± seconds around 3.5 ms
    const w = 0.8 * c;
    rampTo(modA.gain, depth, t, 0.03);
    rampTo(modB.gain, -depth, t, 0.03);
    rampTo(wA.gain, w, t, 0.03);
    rampTo(wB.gain, w, t, 0.03);
    rampTo(dry.gain, 1 / (1 + 0.45 * w), t, 0.03); // keeps the summed level roughly constant
  };
  return ch;
}

/** Common output stage: head → trim (level · gainTrim) → safety ceiling → output. */
function initOut(inst, head, level) {
  const ctx = inst.ctx;
  // always a stereo output (mono patches = dual mono): the engine's per-slot StereoPannerNode pans a MONO input with
  // the equal-power law (−3 dB per side at centre) but passes a stereo input through at unity, so without this the
  // mono patches would sit 3 dB under their calibration inside the engine (measured with tools/calibrate.mjs)
  inst.output.channelCount = 2;
  inst.output.channelCountMode = 'explicit';
  inst.output.channelInterpretation = 'speakers';
  inst.trimG = inst.shared(new GainNode(ctx, { gain: (level * dbToLin(inst.meta.gainTrim || 0)) / CEIL_RANGE }));
  inst.ceil = inst.shared(new WaveShaperNode(ctx, { curve: ceilingCurve(), oversample: 'none' }));
  head.connect(inst.trimG).connect(inst.ceil).connect(inst.output);
  inst.trimNode = inst.trimG; // same names as synth.js / voice.js addOutputCeiling (tests tap trimNode, pre-ceiling)
  inst.ceiling = inst.ceil;
}

// ---- patch implementations ----------------------------------------------------------------------------------------
// Each: level (internal gain staging before gainTrim), init(inst) → builds shared nodes and calls initOut,
// voice(inst, v, note, vel, t), apply(inst, key, value, t), morph(inst, x, t), optional glide(inst, v, note, t).

const IMPL = {
  // Supersaw pad (CCM anthem): 7 saws spread ±detune (0, ±⅓, ±⅔, ±1 × spread, ±1.5¢ jitter) with random phases,
  // centre + alternating L/R; shared M/S width stage; HPF 100 Hz; LPF pair 3 kHz keytracked 50 % (vel ±25 %); subtle sine sub
  // (f/2, injected after the HPF, centred = mono lows); A .6 R 2.5; −3 dB/oct above C4. morph: +2400¢ filter, +0.4 width.
  'supersaw-pad': {
    level: 0.624,
    morphCents: 2400,
    offs: [0, -1 / 3, 1 / 3, -2 / 3, 2 / 3, -1, 1],
    // channel routing instead of 7 StereoPanners (CPU): centre saw → both, the others alternate hard L/R; the shared
    // M/S stage sets the actual width (default .6 → sides at ±60 %)
    sides: [2, 0, 1, 1, 0, 0, 1], // 0 = L, 1 = R, 2 = both
    init(inst) {
      const ctx = inst.ctx;
      initFilterMod(inst, 3000, this.morphCents);
      const split = inst.shared(new ChannelSplitterNode(ctx, { numberOfOutputs: 2 }));
      const merge = inst.shared(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
      inst.msA = [inst.shared(new GainNode(ctx)), inst.shared(new GainNode(ctx))]; // L→L, R→R
      inst.msB = [inst.shared(new GainNode(ctx)), inst.shared(new GainNode(ctx))]; // R→L, L→R
      inst.bus.connect(split);
      split.connect(inst.msA[0], 0).connect(merge, 0, 0);
      split.connect(inst.msB[0], 1).connect(merge, 0, 0);
      split.connect(inst.msA[1], 1).connect(merge, 0, 1);
      split.connect(inst.msB[1], 0).connect(merge, 0, 1);
      this.setWidth(inst, 0);
      initOut(inst, merge, this.level);
    },
    width(inst) {
      return clamp(inst.params.width + 0.4 * inst.morphX, 0, 1);
    },
    setWidth(inst, t) {
      const w = this.width(inst);
      for (const g of inst.msA) rampTo(g.gain, (1 + w) / 2, t, 0.02);
      for (const g of inst.msB) rampTo(g.gain, (1 - w) / 2, t, 0.02);
    },
    voice(inst, v, note, vel, t) {
      const ctx = inst.ctx;
      const p = inst.params;
      const f = noteToFreq(note);
      const sumL = v.add(new GainNode(ctx, { gain: 0.19 }));
      const sumR = v.add(new GainNode(ctx, { gain: 0.19 }));
      const sum = v.add(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
      sumL.connect(sum, 0, 0);
      sumR.connect(sum, 0, 1);
      const saws = [];
      const jit = this.offs.map((o) => (o === 0 ? 0 : inst.rng.range(-1.5, 1.5)));
      for (let i = 0; i < 7; i++) {
        const o = inst.osc(v, inst.rng.pick(inst.saws), f, this.offs[i] * p.detune + jit[i], t);
        if (this.sides[i] !== 1) o.connect(sumL);
        if (this.sides[i] !== 0) o.connect(sumR);
        saws.push(o);
      }
      const hpf = v.add(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 100, Q: BUTTER2_Q }));
      kRate(hpf.frequency, hpf.Q, hpf.detune);
      const fc = 3000 * keytrack(note, 60, 0.5) * (0.75 + 0.5 * vel);
      const [l1, l2] = lpfPair(inst, v, fc, 1.31 + p.resonance * 4.7);
      linkFilter(inst, v, l1, l2);
      const sub = inst.osc(v, 'sine', f / 2, 0, t);
      const subG = v.add(new GainNode(ctx, { gain: p.sub * 0.5 }));
      sub.connect(subG).connect(l1);
      const envG = v.add(new GainNode(ctx, { gain: 0 }));
      v.out = v.add(new GainNode(ctx, { gain: (0.55 + 0.45 * vel) * keyLevel(note) }));
      sum.connect(hpf).connect(l1);
      l2.connect(envG).connect(v.out).connect(inst.bus);
      v.env = makeEnv(ctx, envG.gain, { a: p.attack, d: p.decay, s: p.sustain, r: p.release }, t);
      standardRelease(inst, v);
      Object.assign(v.data, { f, saws, jit, subG, l2, pitched: [...saws.map((o) => [o.frequency, 1]), [sub.frequency, 0.5]] });
    },
    apply(inst, key, val, t) {
      if (key === 'cutoff') updateFilterMod(inst, t);
      else if (key === 'width') this.setWidth(inst, t);
      else if (key === 'resonance') inst.forVoices((v) => rampTo(v.data.l2.Q, qDb(1.31 + val * 4.7), t));
      else if (key === 'sub') inst.forVoices((v) => rampTo(v.data.subG.gain, val * 0.5, t));
      else if (key === 'detune') inst.forVoices((v) => v.data.saws.forEach((o, i) => rampTo(o.detune, this.offs[i] * val + v.data.jit[i], t)));
    },
    morph(inst, x, t) {
      updateFilterMod(inst, t);
      this.setWidth(inst, t);
    },
  },

  // Juno pad (80s / dreamy): one DCO saw turned into a pulse by subtracting a delayed copy (true PWM: delay = duty·T,
  // duty = .5 ± .42·depth from one shared LFO) + square sub (f/2); soft 4-pole LPF (Q .54/.8, keytrack 50 %);
  // mono voices → shared 2-voice stereo chorus (Juno-style, anti-phase triangle). morph: chorus +.4, filter +1200¢.
  'juno-pad': {
    level: 0.506,
    morphCents: 1200,
    init(inst) {
      const ctx = inst.ctx;
      initFilterMod(inst, 2200, this.morphCents);
      inst.dutyCS = inst.sharedSource(new ConstantSourceNode(ctx, { offset: 0.5 }));
      inst.pwmLfo = inst.sharedSource(new OscillatorNode(ctx, { frequency: inst.params.pwmRate }));
      inst.pwmG = inst.shared(new GainNode(ctx, { gain: inst.params.pwmDepth * 0.42 }));
      inst.pwmLfo.connect(inst.pwmG);
      inst.chorus = buildChorus(inst, inst.bus, inst.params.chorusRate);
      inst.chorus.set(this.chorusAmt(inst), 0);
      initOut(inst, inst.chorus.out, this.level);
    },
    chorusAmt(inst) {
      return clamp(inst.params.chorus + 0.4 * inst.morphX, 0, 1);
    },
    voice(inst, v, note, vel, t) {
      const ctx = inst.ctx;
      const p = inst.params;
      const f = noteToFreq(note);
      const saw = inst.osc(v, inst.rng.pick(inst.saws), f, 0, t);
      const { sum, periodG } = pwmPulse(inst, v, saw, f, 0.32);
      const sub = inst.osc(v, inst.rng.pick(inst.squares), f / 2, 0, t);
      const subG = v.add(new GainNode(ctx, { gain: p.sub * 0.35 }));
      sub.connect(subG).connect(sum);
      const hpf = v.add(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 60, Q: BUTTER2_Q }));
      kRate(hpf.frequency, hpf.Q, hpf.detune);
      const fc = 2200 * keytrack(note, 60, 0.5) * (0.75 + 0.5 * vel);
      const [l1, l2] = lpfPair(inst, v, fc, 0.8 + p.resonance * 4);
      linkFilter(inst, v, l1, l2);
      const envG = v.add(new GainNode(ctx, { gain: 0 }));
      v.out = v.add(new GainNode(ctx, { gain: (0.55 + 0.45 * vel) * keyLevel(note) }));
      sum.connect(hpf).connect(l1);
      l2.connect(envG).connect(v.out).connect(inst.bus);
      v.env = makeEnv(ctx, envG.gain, { a: p.attack, d: p.decay, s: p.sustain, r: p.release }, t);
      standardRelease(inst, v);
      Object.assign(v.data, { f, subG, l2, pitched: [[saw.frequency, 1], [sub.frequency, 0.5]], periods: [[periodG.gain, 1]] });
    },
    apply(inst, key, val, t) {
      if (key === 'cutoff') updateFilterMod(inst, t);
      else if (key === 'pwmRate') rampTo(inst.pwmLfo.frequency, val, t);
      else if (key === 'pwmDepth') rampTo(inst.pwmG.gain, val * 0.42, t);
      else if (key === 'chorus') inst.chorus.set(this.chorusAmt(inst), t);
      else if (key === 'chorusRate') rampTo(inst.chorus.lfo.frequency, val, t);
      else if (key === 'resonance') inst.forVoices((v) => rampTo(v.data.l2.Q, qDb(0.8 + val * 4), t));
      else if (key === 'sub') inst.forVoices((v) => rampTo(v.data.subG.gain, val * 0.35, t));
    },
    morph(inst, x, t) {
      updateFilterMod(inst, t);
      inst.chorus.set(this.chorusAmt(inst), t);
    },
  },

  // Shimmer pad (ambient): glassy wave (triangle + partials 2/4), centre + two quieter detuned sides (±.6 pan), an octave-up voice
  // (same wave at 2f) that fades in linearly over bloomTime (3 s; frozen at release) × shared level (octave + morph);
  // HPF 150, gentle LPF 7 kHz (keytrack 30 %); shared slow stereo tremolo (L/R 90° apart). morph: octave-up level.
  'shimmer-pad': {
    level: 0.857,
    init(inst) {
      const ctx = inst.ctx;
      initFilterMod(inst, 7000, 0);
      inst.octCS = inst.sharedSource(new ConstantSourceNode(ctx, { offset: this.octLevel(inst) }));
      const split = inst.shared(new ChannelSplitterNode(ctx, { numberOfOutputs: 2 }));
      const merge = inst.shared(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
      const d = inst.params.tremDepth * 0.5;
      inst.tremGL = inst.shared(new GainNode(ctx, { gain: 1 - d }));
      inst.tremGR = inst.shared(new GainNode(ctx, { gain: 1 - d }));
      inst.tremLfoL = inst.sharedSource(new OscillatorNode(ctx, { frequency: inst.params.tremRate }));
      inst.tremLfoR = inst.sharedSource(new OscillatorNode(ctx, { type: 'custom', periodicWave: cosWave(ctx), frequency: inst.params.tremRate }));
      inst.tremDL = inst.shared(new GainNode(ctx, { gain: d }));
      inst.tremDR = inst.shared(new GainNode(ctx, { gain: d }));
      inst.tremLfoL.connect(inst.tremDL).connect(inst.tremGL.gain);
      inst.tremLfoR.connect(inst.tremDR).connect(inst.tremGR.gain);
      inst.bus.connect(split);
      split.connect(inst.tremGL, 0).connect(merge, 0, 0);
      split.connect(inst.tremGR, 1).connect(merge, 0, 1);
      initOut(inst, merge, this.level);
    },
    octLevel(inst) {
      return clamp(inst.params.octave + inst.morphX, 0, 1) * 0.7;
    },
    waves(ctx) {
      const H = 48;
      const sin = new Float32Array(H + 1);
      for (let k = 1; k <= H; k += 2) sin[k] = (((k - 1) / 2) % 2 ? -1 : 1) / (k * k); // triangle
      sin[2] += 0.28; // glassy even partials
      sin[4] += 0.1;
      return rotatedWaves(ctx, 'shimmer', sin, 8);
    },
    voice(inst, v, note, vel, t) {
      const ctx = inst.ctx;
      const p = inst.params;
      const f = noteToFreq(note);
      const ws = this.waves(ctx);
      const sum = v.add(new GainNode(ctx, { gain: 0.3 }));
      // centre + two quieter sides at asymmetric detune (−d, +.6·d): two equal detuned copies beat at full depth in
      // a mono sum (a 2 Hz, ~15 dB tremolo at C4); a dominant centre and unequal beat rates keep the motion gentle
      const c = inst.osc(v, inst.rng.pick(ws), f, 0, t);
      const a = inst.osc(v, inst.rng.pick(ws), f, -p.detune, t);
      const b = inst.osc(v, inst.rng.pick(ws), f, 0.6 * p.detune, t);
      const pa = v.add(new StereoPannerNode(ctx, { pan: -0.6 }));
      const pb = v.add(new StereoPannerNode(ctx, { pan: 0.6 }));
      const sideG = v.add(new GainNode(ctx, { gain: 0.45 }));
      c.connect(sum);
      a.connect(pa).connect(sideG);
      b.connect(pb).connect(sideG);
      sideG.connect(sum);
      const oct = inst.osc(v, inst.rng.pick(ws), 2 * f, 0, t);
      const octEnv = v.add(new GainNode(ctx, { gain: 0 }));
      const octLvl = v.add(new GainNode(ctx, { gain: 0 }));
      setNow(octEnv.gain, 0, t);
      linearTo(octEnv.gain, 1, t, p.bloomTime, { from: 0 });
      v.link(inst.octCS, octLvl.gain);
      oct.connect(octEnv).connect(octLvl).connect(sum);
      const hpf = v.add(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 150, Q: BUTTER2_Q }));
      kRate(hpf.frequency, hpf.Q, hpf.detune);
      const lpf = v.add(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 7000 * keytrack(note, 60, 0.3) * (0.8 + 0.4 * vel), Q: qDb(0.6) }));
      linkFilter(inst, v, lpf);
      const envG = v.add(new GainNode(ctx, { gain: 0 }));
      v.out = v.add(new GainNode(ctx, { gain: (0.55 + 0.45 * vel) * keyLevel(note) }));
      sum.connect(hpf).connect(lpf).connect(envG).connect(v.out).connect(inst.bus);
      v.env = makeEnv(ctx, envG.gain, { a: p.attack, d: p.decay, s: p.sustain, r: p.release }, t);
      const bloom = p.bloomTime;
      v.onRelease = (rt) => {
        // freeze the octave fade-in where it is: a still-rising bloom must not swell a releasing note
        setNow(octEnv.gain, clamp((rt - t) / bloom, 0, 1), rt);
        return v.env.release(rt, inst.params.release);
      };
      Object.assign(v.data, { f, a, b, pitched: [[c.frequency, 1], [a.frequency, 1], [b.frequency, 1], [oct.frequency, 2]] });
    },
    apply(inst, key, val, t) {
      if (key === 'cutoff') updateFilterMod(inst, t);
      else if (key === 'octave') rampTo(inst.octCS.offset, this.octLevel(inst), t, 0.05);
      else if (key === 'tremRate') {
        rampTo(inst.tremLfoL.frequency, val, t);
        rampTo(inst.tremLfoR.frequency, val, t);
      } else if (key === 'tremDepth') {
        for (const g of [inst.tremGL, inst.tremGR]) rampTo(g.gain, 1 - val * 0.5, t);
        for (const g of [inst.tremDL, inst.tremDR]) rampTo(g.gain, val * 0.5, t);
      } else if (key === 'detune') inst.forVoices((v) => {
        rampTo(v.data.a.detune, -val, t);
        rampTo(v.data.b.detune, 0.6 * val, t);
      });
    },
    morph(inst, x, t) {
      rampTo(inst.octCS.offset, this.octLevel(inst), t, 0.05);
    },
  },

  // DX-style tine EP (80s ballad / gospel), three FM stacks per voice:
  //   A, B  "body": 1:1 carrier/modulator (B detuned +detune¢, −4.4 dB → slow beating), index .3 + 1.4·vel² → 30 %
  //         (τ .9 s); amp decay τ 2.6 s @C3 → .7 s @C6 (× decay).
  //   T     "tine": carrier f + 14:1 modulator, index (.35 + 1.9·vel)·tine decaying τ 45 ms (Nyquist-capped per
  //         note); its carrier decays faster (τ .45 s @C4, keytracked) — the bright bell-like attack.
  // Brightness is two shared signals scaling the modulators through per-voice gains (body tone·(1 + .4·morph), tine
  // tone·(1 + 1.5·morph)), so brightness/morph also move held notes. Shared stereo chorus (chorus param). morph: FM index (brightness).
  // DC hygiene (measured in Chromium): with f_c = f_m the n = −1 sideband sits at exactly 0 Hz with amplitude
  // J1(I)·sin(phase error). (1) Modulators run in COSINE phase (phase = θ + I·sinθ → that sideband is sin(0) = 0; sine
  // phase leaves J1(I)·cos(I) ≈ 6 % DC). (2) The tine is its own stack: a decaying 14:1 modulator on the body carrier
  // left a permanent ≈ .28 rad phase offset (Chromium's a-rate FM lags ~¾ sample → 14× larger at 14f) = 15 % DC.
  // (3) FM stacks start on a render-quantum boundary: Chromium advances an a-rate-modulated oscillator's phase through
  // the not-yet-started frames of its first block, a random 0–2.9 ms carrier/modulator skew (up to 56 % DC measured);
  // the amp envelope still starts at the note's exact time. (4) Chromium's a-rate frequency integration lags half a
  // sample, i.e. a phase error of π·f/fs (1.2 % DC at C3, 10 % at C6): the 1:1 modulators are pre-advanced by exactly
  // that (fmModWave). One shared 20 Hz DC-blocking HPF catches whatever is left (bend/legato move f slightly).
  'dx-epiano': {
    level: 0.471,
    init(inst) {
      const ctx = inst.ctx;
      inst.brightCS = inst.sharedSource(new ConstantSourceNode(ctx, { offset: this.bright(inst) }));
      inst.tineCS = inst.sharedSource(new ConstantSourceNode(ctx, { offset: this.tineBright(inst) }));
      inst.dcBlock = inst.shared(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 20, Q: BUTTER2_Q }));
      inst.bus.connect(inst.dcBlock);
      inst.chorus = buildChorus(inst, inst.dcBlock, 0.7);
      inst.chorus.set(inst.params.chorus, 0);
      initOut(inst, inst.chorus.out, this.level);
    },
    // body index moves less than the tine: 1:1 FM loses its fundamental around I ≈ 1.8 (J0 = J2), so the body stays
    // mostly below that and brightness/morph/velocity work mainly through the 14:1 tine
    bright(inst) {
      return inst.params.tone * (1 + 0.4 * inst.morphX);
    },
    tineBright(inst) {
      return inst.params.tone * (1 + 1.5 * inst.morphX);
    },
    ampTau(note) {
      return clamp(2.6 * Math.pow(0.7 / 2.6, (note - 48) / 36), 0.3, 6);
    },
    /**
     * One FM stack: carrier + cosine-phase modulator at `ratio`; modulator deviation through a brightness gain.
     * `rot` rotates carrier and modulator together (= a time shift of the whole stack: their alignment is kept).
     */
    stack(inst, v, f, det, ratio, dev0, tb, brightCS = inst.brightCS, rot = 0) {
      const ctx = inst.ctx;
      const car = inst.osc(v, rot ? fmModWave(ctx, rot - Math.PI / 2) : 'sine', f, det, tb); // sin(θ + rot)
      const fm = f * ratio * Math.pow(2, det / 1200);
      const adv = ratio === 1 ? (Math.PI * fm) / ctx.sampleRate : 0;
      const mod = inst.osc(v, fmModWave(ctx, ratio * rot + adv), f * ratio, det, tb);
      const brightG = v.add(new GainNode(ctx, { gain: 0 }));
      v.link(brightCS, brightG.gain);
      const modG = v.add(new GainNode(ctx, { gain: dev0 }));
      mod.connect(modG).connect(brightG).connect(car.frequency);
      return { car, mod, modG };
    },
    voice(inst, v, note, vel, t) {
      const ctx = inst.ctx;
      const p = inst.params;
      const f = noteToFreq(note);
      const i1 = 0.3 + 1.4 * vel * vel;
      // random start phase per note (0–7 render quanta early, all stacks together so carrier/modulator alignment is
      // kept): simultaneous chord notes then don't all begin at phase 0 (coherent onset peak). A and B share it —
      // key-synced like a DX7 EP, drifting apart slowly (3¢ at C3 ≈ one beat per 4 s); a random A/B offset would
      // start some notes near cancellation (up to −20 dB; measured ±1 dB level scatter between seeds)
      const q = 128 / ctx.sampleRate;
      const tb = Math.max(ctx.currentTime, blockStart(ctx, t) - inst.rng.int(0, 7) * q);
      const A = this.stack(inst, v, f, 0, 1, i1 * f, tb);
      // B is key-synced in phase with A (any fixed offset cancels some harmonic at the onset: 90° removes H2) and sits
      // 4.4 dB under A: onset 1.6× instead of 2× (less peaky) and a gentler beat (±4 dB instead of full nulls)
      const B = this.stack(inst, v, f, p.detune, 1, i1 * f, tb);
      const bG = v.add(new GainNode(ctx, { gain: 0.6 }));
      for (const s of [A, B]) {
        setNow(s.modG.gain, i1 * f, t);
        rampTo(s.modG.gain, 0.3 * i1 * f, t, 0.9);
      }
      const pitched = [[A.car.frequency, 1], [A.mod.frequency, 1], [B.car.frequency, 1], [B.mod.frequency, 1]];
      const envG = v.add(new GainNode(ctx, { gain: 0 }));
      v.out = v.add(new GainNode(ctx, { gain: (0.2 + 0.8 * vel) * 0.5 * keyLevel(note + 12) }));
      A.car.connect(envG);
      B.car.connect(bG).connect(envG);
      const fT = 14 * f;
      // Nyquist guard (same rule as voice.js fmIndexCap): f + (I + 1.5)·fT ≤ .45·fs with I the effective index after
      // the shared tine brightness; above ≈ A4 this caps the tine progressively, above ≈ B5 there is none
      const capI = (0.45 * ctx.sampleRate - f) / fT - 1.5;
      const iT = Math.min((0.35 + 1.9 * vel) * p.tine, capI / Math.max(1e-3, this.tineBright(inst)));
      if (iT > 0.02) {
        const hi = clamp((0.4 * ctx.sampleRate - fT) / (0.15 * ctx.sampleRate), 0, 1); // tine carrier level fades near the top
        const dev = iT * fT;
        const T = this.stack(inst, v, f, 0, 14, dev, tb, inst.tineCS);
        setNow(T.modG.gain, dev, t);
        rampTo(T.modG.gain, 0, t, 0.045);
        const tauT = 0.45 * keytrack(note, 60, -0.5);
        const tEnv = v.add(new GainNode(ctx, { gain: 0 }));
        setNow(tEnv.gain, 0, t);
        linearTo(tEnv.gain, 0.7 * hi, t, 0.001, { from: 0 });
        rampTo(tEnv.gain, 0, t + 0.001, tauT);
        v._stopSource(T.car, t + 8 * tauT); // −70 dB: saves CPU on long notes
        v._stopSource(T.mod, t + 8 * tauT);
        T.car.connect(tEnv).connect(envG);
        pitched.push([T.car.frequency, 1], [T.mod.frequency, 14]);
      }
      envG.connect(v.out).connect(inst.bus);
      v.env = makeEnv(ctx, envG.gain, { a: 0.001, s: 0, dTau: this.ampTau(note) * p.decay, r: p.release }, t);
      standardRelease(inst, v);
      Object.assign(v.data, { f, i1, modGs: [A.modG, B.modG], B, pitched });
    },
    glide(inst, v, note, t) {
      glidePitched(inst, v, note, t);
      for (const g of v.data.modGs) rampTo(g.gain, 0.3 * v.data.i1 * v.data.f, t, 0.05);
    },
    apply(inst, key, val, t) {
      if (key === 'tone') {
        rampTo(inst.brightCS.offset, this.bright(inst), t);
        rampTo(inst.tineCS.offset, this.tineBright(inst), t);
      }
      else if (key === 'chorus') inst.chorus.set(val, t);
      else if (key === 'detune') inst.forVoices((v) => {
        rampTo(v.data.B.car.detune, val, t);
        rampTo(v.data.B.mod.detune, val, t);
      });
    },
    morph(inst, x, t) {
      rampTo(inst.brightCS.offset, this.bright(inst), t);
      rampTo(inst.tineCS.offset, this.tineBright(inst), t);
    },
  },

  // Pluck (modern worship / pop arps): saw + square (±detune/2) → 4-pole LPF whose cutoff follows its own decay
  // (peak = cutoff · keytrack 50 % · vel, falling to ~2.2·f with τ = decay/4), amp decay to −20 dB at
  // decay · 2^(−(note−60)/36) (≈1.2 s @C2 → .47 s @C6) × (1 + 1.5·morph). Mono, dry, transient-clean for delay sends.
  // morph: decay length (also applied to held notes).
  pluck: {
    level: 0.628,
    init(inst) {
      initFilterMod(inst, 4500, 0);
      initOut(inst, inst.bus, this.level);
    },
    decayAt(inst, note) {
      return inst.params.decay * Math.pow(2, -(note - 60) / 36) * (1 + 1.5 * inst.morphX);
    },
    voice(inst, v, note, vel, t) {
      const ctx = inst.ctx;
      const p = inst.params;
      const f = noteToFreq(note);
      // saw and square start in phase (fundamentals add; ±detune/2 then drifts them slowly): with a random relative
      // phase each pluck's level would scatter by several dB (a half-cycle offset cancels the fundamentals)
      const ph = inst.rng.int(0, inst.saws.length - 1);
      const saw = inst.osc(v, inst.saws[ph], f, -p.detune / 2, t);
      const sq = inst.osc(v, inst.squares[ph], f, p.detune / 2, t);
      const sum = v.add(new GainNode(ctx, { gain: 0.5 }));
      const sqG = v.add(new GainNode(ctx, { gain: p.square * 0.6 }));
      saw.connect(sum);
      sq.connect(sqG).connect(sum);
      const dk = this.decayAt(inst, note);
      const peak = Math.min(18000, 4500 * keytrack(note, 60, 0.5) * (0.45 + 0.75 * vel));
      const floor = Math.min(peak, Math.max(250, 2.2 * f));
      const [l1, l2] = lpfPair(inst, v, peak, 1.0 + p.resonance * 4);
      linkFilter(inst, v, l1, l2);
      for (const fl of [l1, l2]) {
        setNow(fl.frequency, peak, t);
        rampTo(fl.frequency, floor, t + 0.002, dk / 4);
      }
      const envG = v.add(new GainNode(ctx, { gain: 0 }));
      v.out = v.add(new GainNode(ctx, { gain: (0.3 + 0.7 * vel) * keyLevel(note) }));
      sum.connect(l1);
      l2.connect(envG).connect(v.out).connect(inst.bus);
      v.env = makeEnv(ctx, envG.gain, { a: 0.002, s: 0, dTau: dk / PLUCK_T20, r: p.release }, t);
      standardRelease(inst, v);
      Object.assign(v.data, { f, sqG, l2, envG, pitched: [[saw.frequency, 1], [sq.frequency, 1]] });
    },
    apply(inst, key, val, t) {
      if (key === 'cutoff') updateFilterMod(inst, t);
      else if (key === 'square') inst.forVoices((v) => rampTo(v.data.sqG.gain, val * 0.6, t));
      else if (key === 'resonance') inst.forVoices((v) => rampTo(v.data.l2.Q, qDb(1.0 + val * 4), t));
      else if (key === 'decay') this.redecay(inst, t);
    },
    redecay(inst, t) {
      // held notes continue their decay at the new rate from wherever they are (released ones keep releasing)
      inst.forVoices((v) => {
        if (v.state === 'held' && t > v.env.attackEnd) rampTo(v.data.envG.gain, 0, t, this.decayAt(inst, v.note) / PLUCK_T20);
      });
    },
    morph(inst, x, t) {
      this.redecay(inst, t);
    },
  },

  // Poly stab (gospel / R&B): 2 saws ±detune (panned ±.35) + square (−5 dB), short attack, medium decay/sustain;
  // 4-pole LPF (Q .54 / .9 + 5·res) at cutoff · keytrack 50 % with a per-voice filter envelope on the biquads' detune
  // (peak = envAmount · 3600¢ · (.5 + .5·vel), τ = decay/2.5). morph: +env amount (new notes) and +resonance (live).
  'poly-stab': {
    level: 0.832,
    init(inst) {
      initFilterMod(inst, 900, 0);
      initOut(inst, inst.bus, this.level);
    },
    q2(inst) {
      return 0.9 + clamp(inst.params.resonance + 0.45 * inst.morphX, 0, 1) * 5;
    },
    envCents(inst, vel) {
      return clamp(inst.params.envAmount + 0.5 * inst.morphX, 0, 1.4) * 3600 * (0.5 + 0.5 * vel);
    },
    voice(inst, v, note, vel, t) {
      const ctx = inst.ctx;
      const p = inst.params;
      const f = noteToFreq(note);
      const sum = v.add(new GainNode(ctx, { gain: 0.3 }));
      const s1 = inst.osc(v, inst.rng.pick(inst.saws), f, -p.detune, t);
      const s2 = inst.osc(v, inst.rng.pick(inst.saws), f, p.detune, t);
      const sq = inst.osc(v, inst.rng.pick(inst.squares), f, 0, t);
      const p1 = v.add(new StereoPannerNode(ctx, { pan: -0.35 }));
      const p2 = v.add(new StereoPannerNode(ctx, { pan: 0.35 }));
      const sqG = v.add(new GainNode(ctx, { gain: 0.55 }));
      s1.connect(p1).connect(sum);
      s2.connect(p2).connect(sum);
      sq.connect(sqG).connect(sum);
      const fc = 900 * keytrack(note, 60, 0.5);
      const [l1, l2] = lpfPair(inst, v, fc, this.q2(inst));
      linkFilter(inst, v, l1, l2);
      const ec = this.envCents(inst, vel);
      const a = Math.max(0.002, p.attack);
      for (const fl of [l1, l2]) {
        setNow(fl.detune, ec, t);
        rampTo(fl.detune, 0, t + a, p.decay / 2.5);
      }
      const envG = v.add(new GainNode(ctx, { gain: 0 }));
      v.out = v.add(new GainNode(ctx, { gain: (0.3 + 0.7 * vel) * keyLevel(note) }));
      sum.connect(l1);
      l2.connect(envG).connect(v.out).connect(inst.bus);
      v.env = makeEnv(ctx, envG.gain, { a, d: p.decay, s: p.sustain, r: p.release }, t);
      standardRelease(inst, v);
      Object.assign(v.data, { f, s1, s2, l2, pitched: [[s1.frequency, 1], [s2.frequency, 1], [sq.frequency, 1]] });
    },
    apply(inst, key, val, t) {
      if (key === 'cutoff') updateFilterMod(inst, t);
      else if (key === 'resonance') inst.forVoices((v) => rampTo(v.data.l2.Q, qDb(this.q2(inst)), t));
      else if (key === 'detune') inst.forVoices((v) => {
        rampTo(v.data.s1.detune, -val, t);
        rampTo(v.data.s2.detune, val, t);
      });
    },
    morph(inst, x, t) {
      inst.forVoices((v) => rampTo(v.data.l2.Q, qDb(this.q2(inst)), t));
    },
  },

  // Analog brass (synthwave / worship swells): 3 saws (0, ±detune; panned 0/±.4) → HPF 80 → 4-pole LPF at
  // cutoff · keytrack 60 % · vel; filter envelope on the biquads' detune: 0 → peak linear over filterAttack (80 ms),
  // then τ .3 s down to 35 % of peak (sustained brightness), closes with the amp release. Peak = envAmount (+.45·morph)
  // · 3600¢ · (.6 + .4·vel). Vibrato: one shared LFO × depth, per-voice onset (0 until vibDelay, then .4 s ramp).
  // morph: filter env amount (new notes; held notes' sustained brightness follows).
  'analog-brass': {
    level: 0.586,
    init(inst) {
      const ctx = inst.ctx;
      initFilterMod(inst, 700, 0);
      inst.vibLfo = inst.sharedSource(new OscillatorNode(ctx, { frequency: inst.params.vibRate }));
      inst.vibD = inst.shared(new GainNode(ctx, { gain: inst.params.vibDepth }));
      inst.vibLfo.connect(inst.vibD);
      initOut(inst, inst.bus, this.level);
    },
    peakCents(inst, vel) {
      return clamp(inst.params.envAmount + 0.45 * inst.morphX, 0, 1.4) * 3600 * (0.6 + 0.4 * vel);
    },
    voice(inst, v, note, vel, t) {
      const ctx = inst.ctx;
      const p = inst.params;
      const f = noteToFreq(note);
      const d = p.detune;
      const sum = v.add(new GainNode(ctx, { gain: 0.33 }));
      const saws = [];
      [[0, 0], [-d, -0.4], [d, 0.4]].forEach(([det, pan]) => {
        const o = inst.osc(v, inst.rng.pick(inst.saws), f, det, t);
        const pn = v.add(new StereoPannerNode(ctx, { pan }));
        o.connect(pn).connect(sum);
        saws.push(o);
      });
      const vibG = v.add(new GainNode(ctx, { gain: 0 }));
      setNow(vibG.gain, 0, t + p.vibDelay);
      linearTo(vibG.gain, 1, t + p.vibDelay, 0.4, { from: 0 });
      v.link(inst.vibD, vibG);
      for (const o of saws) vibG.connect(o.detune);
      const hpf = v.add(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 80, Q: BUTTER2_Q }));
      kRate(hpf.frequency, hpf.Q, hpf.detune);
      const [l1, l2] = lpfPair(inst, v, 700 * keytrack(note, 60, 0.6) * (0.7 + 0.5 * vel), 1.0);
      linkFilter(inst, v, l1, l2);
      const pk = this.peakCents(inst, vel);
      const fa = p.filterAttack;
      for (const fl of [l1, l2]) {
        setNow(fl.detune, 0, t);
        linearTo(fl.detune, pk, t, fa, { from: 0 });
        rampTo(fl.detune, pk * 0.35, t + fa, 0.3);
      }
      const envG = v.add(new GainNode(ctx, { gain: 0 }));
      v.out = v.add(new GainNode(ctx, { gain: (0.45 + 0.55 * vel) * keyLevel(note) }));
      sum.connect(hpf).connect(l1);
      l2.connect(envG).connect(v.out).connect(inst.bus);
      v.env = makeEnv(ctx, envG.gain, { a: p.attack, d: p.decay, s: p.sustain, r: p.release }, t);
      v.onRelease = (rt) => {
        const r = inst.params.release;
        for (const fl of [l1, l2]) rampTo(fl.detune, 0, rt, r / 4);
        return v.env.release(rt, r);
      };
      Object.assign(v.data, { f, saws, l1, l2, vel, attackEnd: t + fa, pitched: saws.map((o) => [o.frequency, 1]) });
    },
    apply(inst, key, val, t) {
      if (key === 'cutoff') updateFilterMod(inst, t);
      else if (key === 'vibRate') rampTo(inst.vibLfo.frequency, val, t);
      else if (key === 'vibDepth') rampTo(inst.vibD.gain, val, t);
      else if (key === 'envAmount') this.resustain(inst, t);
      else if (key === 'detune') inst.forVoices((v) => {
        rampTo(v.data.saws[1].detune, -val, t);
        rampTo(v.data.saws[2].detune, val, t);
      });
    },
    resustain(inst, t) {
      inst.forVoices((v) => {
        if (v.state !== 'held' || t < v.data.attackEnd) return;
        const c = this.peakCents(inst, v.data.vel) * 0.35;
        rampTo(v.data.l1.detune, c, t, 0.05);
        rampTo(v.data.l2.detune, c, t, 0.05);
      });
    },
    morph(inst, x, t) {
      this.resustain(inst, t);
    },
  },

  // Square lead: pulse (saw − delayed saw; duty .5 = square → .1 with pwm/morph, shared duty signal) + square sub
  // (f/2), 4-pole LPF 3.5 kHz keytrack 70 % (+1200¢ on morph), A 5 ms S 1 R .2; delayed vibrato (shared LFO, per-voice
  // onset); legatoTo = portamento (glide 60 ms; the PWM delay glides with the period). morph: pulse width + brightness.
  'square-lead': {
    level: 0.25,
    morphCents: 1200,
    init(inst) {
      const ctx = inst.ctx;
      initFilterMod(inst, 3500, this.morphCents);
      inst.dutyCS = inst.sharedSource(new ConstantSourceNode(ctx, { offset: this.duty(inst) }));
      inst.vibLfo = inst.sharedSource(new OscillatorNode(ctx, { frequency: inst.params.vibRate }));
      inst.vibD = inst.shared(new GainNode(ctx, { gain: inst.params.vibDepth }));
      inst.vibLfo.connect(inst.vibD);
      initOut(inst, inst.bus, this.level);
    },
    duty(inst) {
      return 0.5 - 0.4 * clamp(inst.params.pwm + 0.6 * inst.morphX, 0, 1);
    },
    voice(inst, v, note, vel, t) {
      const ctx = inst.ctx;
      const p = inst.params;
      const f = noteToFreq(note);
      const saw = inst.osc(v, inst.rng.pick(inst.saws), f, 0, t);
      const { sum, periodG } = pwmPulse(inst, v, saw, f, 0.4);
      const sub = inst.osc(v, inst.rng.pick(inst.squares), f / 2, 0, t);
      const subG = v.add(new GainNode(ctx, { gain: p.sub * 0.4 }));
      sub.connect(subG).connect(sum);
      const vibG = v.add(new GainNode(ctx, { gain: 0 }));
      setNow(vibG.gain, 0, t + p.vibDelay);
      linearTo(vibG.gain, 1, t + p.vibDelay, 0.3, { from: 0 });
      v.link(inst.vibD, vibG);
      vibG.connect(saw.detune);
      vibG.connect(sub.detune);
      const [l1, l2] = lpfPair(inst, v, 3500 * keytrack(note, 60, 0.7) * (0.8 + 0.4 * vel), 1.0 + p.resonance * 4);
      linkFilter(inst, v, l1, l2);
      const envG = v.add(new GainNode(ctx, { gain: 0 }));
      v.out = v.add(new GainNode(ctx, { gain: (0.5 + 0.5 * vel) * keyLevel(note) }));
      sum.connect(l1);
      l2.connect(envG).connect(v.out).connect(inst.bus);
      v.env = makeEnv(ctx, envG.gain, { a: p.attack, s: 1, r: p.release }, t);
      standardRelease(inst, v);
      Object.assign(v.data, { f, subG, l2, pitched: [[saw.frequency, 1], [sub.frequency, 0.5]], periods: [[periodG.gain, 1]] });
    },
    apply(inst, key, val, t) {
      if (key === 'cutoff') updateFilterMod(inst, t);
      else if (key === 'pwm') rampTo(inst.dutyCS.offset, this.duty(inst), t);
      else if (key === 'sub') inst.forVoices((v) => rampTo(v.data.subG.gain, val * 0.4, t));
      else if (key === 'resonance') inst.forVoices((v) => rampTo(v.data.l2.Q, qDb(1.0 + val * 4), t));
      else if (key === 'vibRate') rampTo(inst.vibLfo.frequency, val, t);
      else if (key === 'vibDepth') rampTo(inst.vibD.gain, val, t);
    },
    morph(inst, x, t) {
      updateFilterMod(inst, t);
      rampTo(inst.dutyCS.offset, this.duty(inst), t);
    },
  },

  // 808 sub: sine starting pitchDrop semitones sharp, exponential glide to pitch over dropTime (2 st / 60 ms); amp
  // 2 ms attack, decay to −40 dB over `decay` (2.5 s) while held; shared symmetric tanh saturation (no oversampling:
  // a ≤ 200 Hz sine's tanh harmonics stay far below Nyquist, and 2x/4x would add 3–4 ms latency) with drive + morph
  // → input gain (level-compensated), then LPF 6 kHz. Symmetric curve = no DC. legatoTo glides (808 slides).
  // morph: drive.
  '808-sub': {
    level: 0.517,
    init(inst) {
      const ctx = inst.ctx;
      inst.pre = inst.shared(new GainNode(ctx, { gain: 1 }));
      inst.shaper = inst.shared(new WaveShaperNode(ctx, { curve: softClipCurve(12), oversample: 'none' }));
      inst.post = inst.shared(new GainNode(ctx, { gain: 1 }));
      inst.lpf = inst.shared(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 6000, Q: BUTTER2_Q }));
      inst.bus.connect(inst.pre).connect(inst.shaper).connect(inst.post).connect(inst.lpf);
      this.setDrive(inst, 0);
      initOut(inst, inst.lpf, this.level);
    },
    setDrive(inst, t) {
      const G = Math.pow(10, 12 / 20);
      const d = clamp(inst.params.drive + inst.morphX, 0, 1);
      const k = 0.3 + 5.7 * Math.pow(d, 1.5); // input scale into tanh(G·x)/tanh(G): clean → growling
      rampTo(inst.pre.gain, k / G, t, 0.02);
      rampTo(inst.post.gain, (Math.tanh(G) / k) * (1 + 1.6 * d), t, 0.02); // partial level compensation
    },
    voice(inst, v, note, vel, t) {
      const ctx = inst.ctx;
      const p = inst.params;
      const f = noteToFreq(note);
      const f0 = f * Math.pow(2, p.pitchDrop / 12);
      const o = inst.osc(v, 'sine', f0, 0, t);
      const tp = new TrackedParam(o.frequency, f0);
      tp.glide(f, t, p.dropTime);
      v.data.tracked = [{ tp, mult: 1 }];
      const envG = v.add(new GainNode(ctx, { gain: 0 }));
      v.out = v.add(new GainNode(ctx, { gain: 0.35 + 0.65 * vel }));
      o.connect(envG).connect(v.out).connect(inst.bus);
      v.env = makeEnv(ctx, envG.gain, { a: 0.002, s: 0, dTau: p.decay / 4.6, r: p.release }, t);
      standardRelease(inst, v);
      Object.assign(v.data, { f, pitched: [[o.frequency, 1]] });
    },
    apply(inst, key, val, t) {
      if (key === 'drive') this.setDrive(inst, t);
    },
    morph(inst, x, t) {
      this.setDrive(inst, t);
    },
  },

  // Synth bass: saw + square (−6 dB × square) → 4-pole LPF (Q .54 / .9 + 4·res) at cutoff · keytrack 50 %, fast filter
  // envelope on detune (peak envAmount · 3600¢ · (.4 + .6·vel), τ 80 ms); amp A 3 ms D .35 S .55 R .12; mono voice.
  // morph: cutoff (+2400¢).
  'synth-bass': {
    level: 0.544,
    morphCents: 2400,
    init(inst) {
      initFilterMod(inst, 320, this.morphCents);
      initOut(inst, inst.bus, this.level);
    },
    voice(inst, v, note, vel, t) {
      const ctx = inst.ctx;
      const p = inst.params;
      const f = noteToFreq(note);
      // saw and square share one start phase (DCO-style reset): at the same pitch a random relative phase changes each
      // note's level by up to 10 dB (measured: square a half-cycle off cancels the fundamentals). In phase = the
      // fundamentals add = maximum punch
      const ph = inst.rng.int(0, inst.saws.length - 1);
      const saw = inst.osc(v, inst.saws[ph], f, 0, t);
      const sq = inst.osc(v, inst.squares[ph], f, 0, t);
      const sum = v.add(new GainNode(ctx, { gain: 0.55 }));
      const sqG = v.add(new GainNode(ctx, { gain: p.square }));
      saw.connect(sum);
      sq.connect(sqG).connect(sum);
      const [l1, l2] = lpfPair(inst, v, 320 * keytrack(note, 36, 0.5), 0.9 + p.resonance * 4);
      linkFilter(inst, v, l1, l2);
      const ec = p.envAmount * 3600 * (0.4 + 0.6 * vel);
      for (const fl of [l1, l2]) {
        setNow(fl.detune, ec, t);
        rampTo(fl.detune, 0, t + 0.003, 0.08);
      }
      const envG = v.add(new GainNode(ctx, { gain: 0 }));
      v.out = v.add(new GainNode(ctx, { gain: 0.4 + 0.6 * vel }));
      sum.connect(l1);
      l2.connect(envG).connect(v.out).connect(inst.bus);
      v.env = makeEnv(ctx, envG.gain, { a: p.attack, d: p.decay, s: p.sustain, r: p.release }, t);
      standardRelease(inst, v);
      Object.assign(v.data, { f, sqG, l2, pitched: [[saw.frequency, 1], [sq.frequency, 1]] });
    },
    apply(inst, key, val, t) {
      if (key === 'cutoff') updateFilterMod(inst, t);
      else if (key === 'square') inst.forVoices((v) => rampTo(v.data.sqG.gain, val, t));
      else if (key === 'resonance') inst.forVoices((v) => rampTo(v.data.l2.Q, qDb(0.9 + val * 4), t));
    },
    morph(inst, x, t) {
      updateFilterMod(inst, t);
    },
  },
};

/**
 * SPEC §3.2 Instrument for the extra synth patches.
 * `new SynthExtraInstrument(ctx, prng, patchId, initialParams)`.
 */
export class SynthExtraInstrument extends InstrumentBase {
  constructor(ctx, prng, patchId, initialParams) {
    let meta = BY_ID.get(patchId);
    if (!meta) {
      console.warn(`[synth-extra] unknown patch "${patchId}", using supersaw-pad`);
      meta = BY_ID.get('supersaw-pad');
    }
    super(ctx, prng, meta, initialParams);
    this.patchId = meta.id;
    this.impl = IMPL[meta.id];
    this.saws = phaseRotatedSawWaves(ctx, 8);
    this.squares = squareWaves(ctx);
    this.impl.init(this);
  }

  _buildVoice(v, note, vel, t) {
    this.impl.voice(this, v, note, vel, t);
  }

  _applyParam(key, value, t) {
    if (this.impl.apply) this.impl.apply(this, key, value, t);
  }

  _morph(x, t) {
    if (this.impl.morph) this.impl.morph(this, x, t);
  }

  _glide(v, note, t) {
    if (this.impl.glide) this.impl.glide(this, v, note, t);
    else glidePitched(this, v, note, t);
  }
}

export default SynthExtraInstrument;
