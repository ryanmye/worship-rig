// Subtractive / FM synth patches (SPEC §3.3, REVIEW 3.3, 3.7, 3.12). One class, seven recipes.
// CPU notes: filter LFO, filter-cutoff/morph offset, bloom level, chorus and unison-drift LFOs and the bend
// source are ONE node each per instrument, fanned out to every voice's AudioParams (links are torn down with
// the voice). Per-voice modulators exist only where the recipe needs independence (string vibrato, drone drift).
// Saw waves are shared, pre-built, phase-rotated PeriodicWaves (random start phase per oscillator).
import { rampTo, setNow, linearTo } from '../shared/automation.js';
import { noteToFreq } from '../shared/music.js';
import {
  InstrumentBase, makeEnv, phaseRotatedSawWaves, rotatedWaves, softClipCurve, keytrack, clamp, TrackedParam,
  BUTTER2_Q, BUTTER4_Q, qDb, FmDepth, fmIndexCap, sineWaves, triangleWaves, monoBelow, addOutputCeiling,
} from './voice.js';

const P = (key, label, min, max, def, unit = 'lin', curve = 'lin', extra = {}) =>
  Object.freeze({ key, label, min, max, default: def, unit, curve, ...extra });

const ATTACK = (def) => P('attack', 'Attack', 0.002, 8, def, 's', 'log');
const DECAY = (def) => P('decay', 'Decay', 0.02, 6, def, 's', 'log');
const SUSTAIN = (def) => P('sustain', 'Sustain', 0, 1, def);
const RELEASE = (def, max = 12) => P('release', 'Release', 0.03, max, def, 's', 'log');
const CUTOFF = (def, min = 200, max = 14000) => P('cutoff', 'Cutoff', min, max, def, 'Hz', 'log');

/** Patch metadata (listInstruments merges these). Keys are stable: presets store them. */
export const PATCHES = Object.freeze([
  Object.freeze({
    id: 'warm-pad', name: 'Warm Pad', group: 'Synth Pads',
    params: Object.freeze([
      ATTACK(1.2), DECAY(0.5), SUSTAIN(0.8), RELEASE(3), CUTOFF(1800),
      P('resonance', 'Resonance', 0, 1, 0),
      P('lfoRate', 'LFO rate', 0.01, 2, 0.08, 'Hz', 'log'),
      P('lfoDepth', 'LFO depth (cents)', 0, 1200, 300),
      P('detune', 'Detune (cents)', 0, 40, 17),
      P('sub', 'Sub level', 0, 1, 0.5),
    ]),
  }),
  Object.freeze({
    id: 'glass-pad', name: 'Glass Pad', group: 'Synth Pads',
    params: Object.freeze([
      ATTACK(0.8), DECAY(1.5), SUSTAIN(0.85), RELEASE(3.5), CUTOFF(6000),
      P('detune', 'Detune (cents)', 0, 25, 6),
      P('chorus', 'Chorus', 0, 1, 0.6),
      P('bloom', 'Octave bloom', 0, 1, 0),
    ]),
  }),
  Object.freeze({
    id: 'strings', name: 'Strings', group: 'Synth Pads',
    params: Object.freeze([
      ATTACK(0.4), RELEASE(1.8), CUTOFF(4000, 500),
      P('detune', 'Detune (cents)', 0, 30, 12),
      P('vibRate', 'Vibrato rate', 2, 8, 5, 'Hz', 'lin'),
      P('vibDepth', 'Vibrato depth (cents)', 0, 30, 8),
      P('vibDelay', 'Vibrato delay', 0, 2, 0.5, 's', 'lin'),
    ]),
  }),
  Object.freeze({
    id: 'sub-bass', name: 'Sub Bass', group: 'Bass',
    params: Object.freeze([
      ATTACK(0.005), RELEASE(0.25, 4), CUTOFF(250, 60, 1000),
      P('drive', 'Drive', 0, 1, 0.3),
      P('tri', 'Triangle', 0, 1, 0.35),
      P('glide', 'Legato glide', 0, 0.5, 0.03, 's', 'lin'),
    ]),
  }),
  Object.freeze({
    id: 'soft-keys', name: 'Soft Keys', group: 'Synth Keys',
    params: Object.freeze([
      P('decay', 'Decay', 0.3, 3, 1, 'lin', 'log'),
      RELEASE(0.3, 3),
      P('tone', 'Tone', 0, 2, 1),
      P('tine', 'Tine', 0, 2, 1),
      P('tremolo', 'Tremolo', 0, 1, 0.25),
      P('tremRate', 'Tremolo rate', 1, 10, 4.5, 'Hz', 'lin'),
      P('drive', 'Drive', 0, 1, 0.3),
      P('glide', 'Legato glide', 0, 0.5, 0.03, 's', 'lin'),
    ]),
  }),
  Object.freeze({
    id: 'bell', name: 'Bell', group: 'Synth Keys',
    params: Object.freeze([
      ATTACK(0.002), P('decay', 'Decay', 0.5, 12, 4, 's', 'log'), RELEASE(2.5, 8),
      P('ratio', 'FM ratio', 1, 8, 3.5),
      P('index', 'FM index', 0, 6, 2),
      P('indexDecay', 'Index decay', 0.1, 6, 1.2, 's', 'log'),
      P('glide', 'Legato glide', 0, 0.5, 0.03, 's', 'lin'),
    ]),
  }),
  Object.freeze({
    id: 'drone-osc', name: 'Drone Oscillator', group: 'Synth Pads', hidden: true, // drone.js only, not a slot choice
    params: Object.freeze([
      ATTACK(2.5), RELEASE(4, 20), CUTOFF(1400),
      P('detune', 'Detune (cents)', 0, 30, 10),
      P('drift', 'Drift (cents)', 0, 10, 3),
      P('unisonDrift', 'Unison drift (cents)', 0, 15, 4),
      P('sub', 'Sub level', 0, 1, 0.3),
      P('lfoRate', 'LFO rate', 0.01, 2, 0.05, 'Hz', 'log'),
      P('lfoDepth', 'LFO depth (cents)', 0, 1200, 200),
    ]),
  }),
]);

const BY_ID = new Map(PATCHES.map((p) => [p.id, p]));
const CENTS = (ratio) => 1200 * Math.log2(ratio);
/** −3 dB/oct above C4 (REVIEW 3.3). */
const keyLevel = (note) => (note > 60 ? Math.pow(10, (-3 * (note - 60)) / 12 / 20) : 1);

// ---- cached waves / buffers (per context) -------------------------------------------------------------
const GLASS_CACHE = new WeakMap();
/** Triangle + sine partials 2 (−6 dB) and 3 (−14 dB); 8 phase rotations for random start phase. */
export function glassWaves(ctx) {
  let w = GLASS_CACHE.get(ctx);
  if (w) return w;
  const H = 63;
  const sin = new Float32Array(H + 1);
  for (let k = 1; k <= H; k += 2) sin[k] = (((k - 1) / 2) % 2 ? -1 : 1) / (k * k); // triangle
  sin[2] = 0.5; // −6 dB
  // −14 dB, keeping the triangle's own (negative) sign: adding +0.2 to its −1/9 left 0.089 (−21 dB, review m3)
  sin[3] = -0.2;
  w = rotatedWaves(ctx, 'glass', sin, 8);
  GLASS_CACHE.set(ctx, w);
  return w;
}

const EP_CLIP_DB = 12; // tanh(4x)/tanh(4)
const EP_CLIP_G = Math.pow(10, EP_CLIP_DB / 20);

/**
 * Seeded, loopable random walk in [−1, 1] (64 control points 1 s apart, circular Catmull-Rom),
 * stored at 3 kHz: one buffer per instrument, each voice plays it from its own offset/rate.
 */
function randomWalkBuffer(ctx, rng) {
  const N = 64;
  const SR = 3000;
  const pts = new Float64Array(N + 1);
  for (let i = 1; i <= N; i++) pts[i] = pts[i - 1] + rng.gaussian();
  const drift = pts[N];
  let mean = 0;
  for (let i = 0; i < N; i++) {
    pts[i] -= (drift * i) / N; // close the loop
    mean += pts[i] / N;
  }
  let m = 1e-9;
  for (let i = 0; i < N; i++) {
    pts[i] -= mean;
    m = Math.max(m, Math.abs(pts[i]));
  }
  for (let i = 0; i < N; i++) pts[i] /= m;
  const len = N * SR;
  const buf = ctx.createBuffer(1, len, SR);
  const d = buf.getChannelData(0);
  const at = (i) => pts[((i % N) + N) % N];
  for (let s = 0; s < len; s++) {
    const x = s / SR;
    const i = Math.floor(x);
    const u = x - i;
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    d[s] = clamp(
      0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u),
      -1, 1,
    );
  }
  return buf;
}

// ---- patch implementations
// `trim` = output gain chosen so a C-E-G chord at velocity 96 sits near −20 dBFS RMS (tools/calibrate.mjs refines). ----------------------------------------------------------------------------
// Each: init(inst) builds instrument-level nodes and connects bus → … → output;
// voice(inst, v, note, vel, t); apply(inst, key, value, t); morph(inst, x, t); glide(inst, v, note, t).

/** Shared filter modulation: LFO (cents) + constant offset (cutoff param + morph, cents). */
function initFilterMod(inst, baseHz, withLfo, morphCents) {
  const ctx = inst.ctx;
  inst.filterBase = baseHz;
  inst.filterCS = inst.sharedSource(new ConstantSourceNode(ctx, { offset: filterOffsetCents(inst, morphCents) }));
  if (withLfo) {
    inst.lfo = inst.sharedSource(new OscillatorNode(ctx, { frequency: inst.params.lfoRate }));
    inst.lfoGain = inst.shared(new GainNode(ctx, { gain: inst.params.lfoDepth }));
    inst.lfo.connect(inst.lfoGain);
  }
}
function filterOffsetCents(inst, morphCents) {
  return CENTS(inst.params.cutoff / inst.filterBase) + inst.morphX * morphCents;
}
// Filter modulation is ≤ a few Hz, so the modulated params run k-rate: Chromium otherwise recomputes biquad
// coefficients every sample for any param with an audio-rate input (~30 % of a 16-voice warm-pad's CPU).
function kRate(...params) {
  for (const p of params) {
    try {
      p.automationRate = 'k-rate';
    } catch (e) {
      /* older engines: stays a-rate */
    }
  }
}
function linkFilter(inst, v, ...filters) {
  for (const f of filters) {
    kRate(f.frequency, f.detune);
    v.link(inst.filterCS, f.detune);
    if (inst.lfoGain) v.link(inst.lfoGain, f.detune);
  }
}
/**
 * 4-pole Butterworth LPF from two biquads (REVIEW 3.3). Web Audio LP Q is in dB: −5.33 / +2.32 dB
 * (linear .5412 / 1.3066); `q2Db` raises the second stage for resonance.
 */
function lpfPair(inst, v, freq, q2Db = BUTTER4_Q[1]) {
  const ctx = inst.ctx;
  const a = v.add(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: freq, Q: BUTTER4_Q[0] }));
  const b = v.add(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: freq, Q: q2Db }));
  a.connect(b);
  return [a, b];
}
/** warm-pad resonance 0..1 → second-stage Q (dB): 0 = Butterworth (flat), 1 = +12 dB peak of the pair. */
const RES_DB = 14.93;
const resQ = (res) => BUTTER4_Q[1] + res * RES_DB;
/**
 * "Mono below 150 Hz" (SPEC §3.3, review m7): corner of the side-channel 4-pole HPF. At 150 Hz itself a 150 Hz
 * corner still leaves the side at −3 dB (measured C2 pad: side −15 dB re mid below 150 Hz); 200 Hz gives
 * −24 dB (C2) … −33 dB (G2) while keeping the stereo spread above ~250 Hz.
 */
const MONO_SIDE_HPF = 200;
/** Static high-pass on the instrument bus (was one per voice: LTI, identical sum, ~12–14 % less CPU). */
function busHpf(inst, freq) {
  return inst.shared(new BiquadFilterNode(inst.ctx, { type: 'highpass', frequency: freq, Q: BUTTER2_Q }));
}
function sawStack(inst, v, f, dets, pans, t, dest) {
  const out = [];
  for (let i = 0; i < dets.length; i++) {
    const o = inst.osc(v, inst.rng.pick(inst.saws), f, dets[i], t);
    const pn = v.add(new StereoPannerNode(inst.ctx, { pan: pans[i] }));
    o.connect(pn).connect(dest);
    out.push(o);
  }
  return out;
}
/** Oscillator-frequency params of a voice as TrackedParams (created lazily from v.data.pitched/f). */
function tracked(v) {
  if (!v.data.tracked) v.data.tracked = (v.data.pitched || []).map(([param, mult]) => ({ tp: new TrackedParam(param, v.data.f * mult), mult }));
  return v.data.tracked;
}
function glidePitched(inst, v, note, t) {
  const f = noteToFreq(note);
  const dur = inst.params.glide ?? 0.03;
  for (const e of tracked(v)) e.tp.glide(f * e.mult, t, dur);
  v.data.f = f;
}
function standardRelease(inst, v) {
  v.onRelease = (rt) => v.env.release(rt, inst.params.release);
}

const IMPL = {
  // Warm pad: 5 saws 0/±9/±17¢ panned ±0.6, sub tri −12 dB, HPF 120, LPF pair 1.8 kHz (keytrack 50 %,
  // velocity ±30 %), LFO .08 Hz ±300¢ on filter detune, ADSR 1.2/.5/.8/3, −3 dB/oct above C4, morph +2400¢.
  'warm-pad': {
    trim: 0.55,
    morphCents: 2400,
    init(inst) {
      initFilterMod(inst, 1800, true, this.morphCents);
      inst.hpf = busHpf(inst, 120);
      inst.monoLow = monoBelow(inst, MONO_SIDE_HPF);
      inst.bus.connect(inst.hpf).connect(inst.monoLow.input);
      inst.monoLow.output.connect(inst.output);
    },
    voice(inst, v, note, vel, t) {
      const ctx = inst.ctx;
      const p = inst.params;
      const f = noteToFreq(note);
      const outer = p.detune;
      const inner = (outer * 9) / 17;
      const sum = v.add(new GainNode(ctx, { gain: 0.2 }));
      const saws = sawStack(inst, v, f, [0, -inner, inner, -outer, outer], [0, 0.3, -0.3, -0.6, 0.6], t, sum);
      const sub = inst.osc(v, 'triangle', f / 2, 0, t);
      const subG = v.add(new GainNode(ctx, { gain: p.sub * 1.12 })); // .5 → −12 dB re the saw stack
      sub.connect(subG).connect(sum);
      const fc = 1800 * keytrack(note, 60, 0.5) * (0.7 + 0.6 * vel);
      const [l1, l2] = lpfPair(inst, v, fc, resQ(p.resonance));
      linkFilter(inst, v, l1, l2);
      const envG = v.add(new GainNode(ctx, { gain: 0 }));
      v.out = v.add(new GainNode(ctx, { gain: (0.55 + 0.45 * vel) * keyLevel(note) }));
      sum.connect(l1); // HPF 120 Hz is on the instrument bus
      l2.connect(envG).connect(v.out).connect(inst.bus);
      v.env = makeEnv(ctx, envG.gain, { a: p.attack, d: p.decay, s: p.sustain, r: p.release }, t);
      standardRelease(inst, v);
      Object.assign(v.data, { f, saws, subG, l1, l2, pitched: [...saws.map((o) => [o.frequency, 1]), [sub.frequency, 0.5]] });
    },
    apply(inst, key, val, t) {
      if (key === 'cutoff') rampTo(inst.filterCS.offset, filterOffsetCents(inst, this.morphCents), t);
      else if (key === 'lfoRate') rampTo(inst.lfo.frequency, val, t);
      else if (key === 'lfoDepth') rampTo(inst.lfoGain.gain, val, t);
      else if (key === 'resonance') inst.forVoices((v) => rampTo(v.data.l2.Q, resQ(val), t));
      else if (key === 'sub') inst.forVoices((v) => rampTo(v.data.subG.gain, val * 1.12, t));
      else if (key === 'detune') {
        const d = [0, (-val * 9) / 17, (val * 9) / 17, -val, val];
        inst.forVoices((v) => v.data.saws.forEach((o, i) => rampTo(o.detune, d[i], t)));
      }
    },
    morph(inst, x, t) {
      rampTo(inst.filterCS.offset, filterOffsetCents(inst, this.morphCents), t);
    },
  },

  // Glass pad: tri + sine partials 2/3 (−6/−14 dB), two detuned copies with a shared chorus LFO,
  // "octave bloom" voice (+12) whose level = bloom param + morph (one shared control node).
  'glass-pad': {
    trim: 0.4,
    init(inst) {
      const ctx = inst.ctx;
      initFilterMod(inst, 6000, false, 0);
      inst.bloomCS = inst.sharedSource(new ConstantSourceNode(ctx, { offset: this.bloomLevel(inst) }));
      inst.chorusLfo = inst.sharedSource(new OscillatorNode(ctx, { frequency: inst.rng.range(0.25, 0.4) }));
      inst.chorusPos = inst.shared(new GainNode(ctx, { gain: inst.params.chorus * 8 }));
      inst.chorusNeg = inst.shared(new GainNode(ctx, { gain: -inst.params.chorus * 8 }));
      inst.chorusLfo.connect(inst.chorusPos);
      inst.chorusLfo.connect(inst.chorusNeg);
      inst.hpf = busHpf(inst, 120);
      inst.bus.connect(inst.hpf).connect(inst.output);
    },
    bloomLevel(inst) {
      return clamp(inst.params.bloom + inst.morphX, 0, 1) * 0.6;
    },
    voice(inst, v, note, vel, t) {
      const ctx = inst.ctx;
      const p = inst.params;
      const f = noteToFreq(note);
      const ws = glassWaves(ctx);
      const pick = () => inst.rng.pick(ws);
      const sum = v.add(new GainNode(ctx, { gain: 0.26 }));
      // centre + two detuned side copies (the centre keeps the beating partial, not a full-depth tremolo)
      const c = inst.osc(v, pick(), f, 0, t);
      const a = inst.osc(v, pick(), f, -p.detune, t);
      const b = inst.osc(v, pick(), f, p.detune, t);
      v.link(inst.chorusNeg, a.detune);
      v.link(inst.chorusPos, b.detune);
      const sideG = v.add(new GainNode(ctx, { gain: 0.7 }));
      const pa = v.add(new StereoPannerNode(ctx, { pan: -0.5 }));
      const pb = v.add(new StereoPannerNode(ctx, { pan: 0.5 }));
      c.connect(sum);
      a.connect(pa).connect(sideG);
      b.connect(pb).connect(sideG);
      sideG.connect(sum);
      const bloom = inst.osc(v, pick(), 2 * f, 0, t);
      const bloomG = v.add(new GainNode(ctx, { gain: 0 }));
      v.link(inst.bloomCS, bloomG.gain);
      bloom.connect(bloomG).connect(sum);
      // linear Q .6 (slightly under Butterworth) = −4.44 dB in Web Audio's LP units
      const lpf = v.add(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 6000 * keytrack(note, 60, 0.3) * (0.8 + 0.4 * vel), Q: qDb(0.6) }));
      linkFilter(inst, v, lpf);
      const envG = v.add(new GainNode(ctx, { gain: 0 }));
      v.out = v.add(new GainNode(ctx, { gain: (0.55 + 0.45 * vel) * keyLevel(note) }));
      sum.connect(lpf).connect(envG).connect(v.out).connect(inst.bus); // HPF 120 Hz on the bus
      v.env = makeEnv(ctx, envG.gain, { a: p.attack, d: p.decay, s: p.sustain, r: p.release }, t);
      standardRelease(inst, v);
      Object.assign(v.data, { f, a, b, pitched: [[c.frequency, 1], [a.frequency, 1], [b.frequency, 1], [bloom.frequency, 2]] });
    },
    apply(inst, key, val, t) {
      if (key === 'cutoff') rampTo(inst.filterCS.offset, filterOffsetCents(inst, 0), t);
      else if (key === 'bloom') rampTo(inst.bloomCS.offset, this.bloomLevel(inst), t);
      else if (key === 'chorus') {
        rampTo(inst.chorusPos.gain, val * 8, t);
        rampTo(inst.chorusNeg.gain, -val * 8, t);
      } else if (key === 'detune') inst.forVoices((v) => {
        rampTo(v.data.a.detune, -val, t);
        rampTo(v.data.b.detune, val, t);
      });
    },
    morph(inst, x, t) {
      rampTo(inst.bloomCS.offset, this.bloomLevel(inst), t, 0.05);
    },
  },

  // Strings: 5-voice unison saw, A .4 R 1.8, delayed vibrato (.5 s onset, 5 Hz ±8¢, per voice),
  // LPF 4 kHz (pair), HPF 150 Hz; morph = brightness (+1600¢ on the LPF).
  strings: {
    trim: 0.46,
    morphCents: 1600,
    init(inst) {
      initFilterMod(inst, 4000, false, this.morphCents);
      inst.hpf = busHpf(inst, 150);
      inst.bus.connect(inst.hpf).connect(inst.output);
    },
    voice(inst, v, note, vel, t) {
      const ctx = inst.ctx;
      const p = inst.params;
      const f = noteToFreq(note);
      const d = p.detune;
      const sum = v.add(new GainNode(ctx, { gain: 0.2 }));
      const saws = sawStack(inst, v, f, [0, -d / 2, d / 2, d, -d], [0, -0.25, 0.25, -0.5, 0.5], t, sum);
      // delayed vibrato: per-voice LFO (slightly random rate), depth fades in after vibDelay
      const vib = new OscillatorNode(ctx, { frequency: p.vibRate * (1 + 0.04 * inst.rng.gaussian()) });
      v.addSource(vib, t);
      const vibG = v.add(new GainNode(ctx, { gain: 0 }));
      // depth is exactly 0 until t + vibDelay, then ramps to vibDepth over 0.4 s: anchor AT the onset (setNow) and
      // start the ramp from that known 0 ({from}: param.value would be read at the current time, not the onset)
      setNow(vibG.gain, 0, t + p.vibDelay);
      linearTo(vibG.gain, p.vibDepth, t + p.vibDelay, 0.4, { from: 0 });
      vib.connect(vibG);
      for (const o of saws) vibG.connect(o.detune);
      const [l1, l2] = lpfPair(inst, v, 4000 * keytrack(note, 60, 0.25) * (0.8 + 0.4 * vel));
      linkFilter(inst, v, l1, l2);
      const envG = v.add(new GainNode(ctx, { gain: 0 }));
      v.out = v.add(new GainNode(ctx, { gain: (0.5 + 0.5 * vel) * keyLevel(note) }));
      sum.connect(l1); // HPF 150 Hz on the bus
      l2.connect(envG).connect(v.out).connect(inst.bus);
      v.env = makeEnv(ctx, envG.gain, { a: p.attack, d: 0.3, s: 1, r: p.release }, t);
      standardRelease(inst, v);
      Object.assign(v.data, { f, saws, vib, vibG, pitched: saws.map((o) => [o.frequency, 1]) });
    },
    apply(inst, key, val, t) {
      if (key === 'cutoff') rampTo(inst.filterCS.offset, filterOffsetCents(inst, this.morphCents), t);
      else if (key === 'vibRate') inst.forVoices((v) => rampTo(v.data.vib.frequency, val, t));
      else if (key === 'vibDepth') inst.forVoices((v) => { if (t >= v.startedAt + inst.params.vibDelay) rampTo(v.data.vibG.gain, val, t); });
      else if (key === 'detune') {
        const d = [0, -val / 2, val / 2, val, -val];
        inst.forVoices((v) => v.data.saws.forEach((o, i) => rampTo(o.detune, d[i], t)));
      }
    },
    morph(inst, x, t) {
      rampTo(inst.filterCS.offset, filterOffsetCents(inst, this.morphCents), t);
    },
  },

  // Sub bass: sine + tri + 2nd harmonic, symmetric tanh soft-clip, LPF 250 Hz. The 2nd harmonic that
  // keeps the bass audible on small PAs is ADDED (a phase-locked 2f sine per voice, level from drive) instead
  // of coming from an asymmetric shaper: an even-order curve on the voice sum produces a DC offset that follows
  // every note on/off and turns into a sub-sonic thump through the DC blocker (measured −37 dBFS right after
  // allOff). Drive (+ morph) = H2 level + tanh input gain, all automatable. Mono legato is the engine's job;
  // legatoTo glides (glide param, 30 ms).
  // Shaper oversample 'none': measured identical to '2x' against a 176.4 kHz reference (review m2) and saves
  // 130 frames (3 ms) of note latency. Random start phase (m8): sine, tri and H2 share one rotation index
  // (H2 uses rotation 2i, i.e. it stays phase-locked to the fundamental, so the symmetric tanh still makes no DC).
  'sub-bass': {
    trim: 0.28,
    init(inst) {
      const ctx = inst.ctx;
      inst.sines = sineWaves(ctx);
      inst.tris = triangleWaves(ctx);
      inst.h2CS = inst.sharedSource(new ConstantSourceNode(ctx, { offset: 0 }));
      inst.pre = inst.shared(new GainNode(ctx, { gain: 1 }));
      inst.shaper = inst.shared(new WaveShaperNode(ctx, { curve: softClipCurve(EP_CLIP_DB), oversample: 'none' }));
      inst.post = inst.shared(new GainNode(ctx, { gain: 1 }));
      inst.lpf = inst.shared(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: inst.params.cutoff, Q: BUTTER2_Q }));
      inst.bus.connect(inst.pre).connect(inst.shaper).connect(inst.post).connect(inst.lpf).connect(inst.output);
      this.setDrive(inst, 0);
    },
    setDrive(inst, t) {
      const d = clamp(inst.params.drive + inst.morphX, 0, 1);
      const k = 0.4 + 2.2 * d; // input scale into tanh(4x)/tanh(4)
      rampTo(inst.pre.gain, k / EP_CLIP_G, t, 0.02);
      rampTo(inst.post.gain, (Math.tanh(EP_CLIP_G) / k) * (1 - 0.3 * d), t, 0.02);
      rampTo(inst.h2CS.offset, 0.08 + 0.3 * d, t, 0.02); // H2 ≈ −22 dB (drive 0) … −8 dB (drive 1)
    },
    voice(inst, v, note, vel, t) {
      const ctx = inst.ctx;
      const p = inst.params;
      const f = noteToFreq(note);
      const rot = inst.rng.int(0, 7);
      const sum = v.add(new GainNode(ctx, { gain: 0.5 }));
      const s = inst.osc(v, inst.sines[rot], f, 0, t);
      const tr = inst.osc(v, inst.tris[rot], f, 0, t);
      const h2 = inst.osc(v, inst.sines[(2 * rot) % 8], 2 * f, 0, t);
      const trG = v.add(new GainNode(ctx, { gain: p.tri * 0.8 }));
      const h2G = v.add(new GainNode(ctx, { gain: 0 }));
      v.link(inst.h2CS, h2G.gain);
      s.connect(sum);
      tr.connect(trG).connect(sum);
      h2.connect(h2G).connect(sum);
      const envG = v.add(new GainNode(ctx, { gain: 0 }));
      v.out = v.add(new GainNode(ctx, { gain: 0.6 + 0.4 * vel }));
      sum.connect(envG).connect(v.out).connect(inst.bus);
      v.env = makeEnv(ctx, envG.gain, { a: p.attack, s: 1, r: p.release }, t);
      standardRelease(inst, v);
      Object.assign(v.data, { f, trG, pitched: [[s.frequency, 1], [tr.frequency, 1], [h2.frequency, 2]] });
    },
    apply(inst, key, val, t) {
      if (key === 'drive') this.setDrive(inst, t);
      else if (key === 'cutoff') rampTo(inst.lpf.frequency, val, t);
      else if (key === 'tri') inst.forVoices((v) => rampTo(v.data.trG.gain, val * 0.8, t));
    },
    morph(inst, x, t) {
      this.setDrive(inst, t);
    },
  },

  // Soft keys (FM EP, REVIEW 3.7): 1:1 modulator index .3+1.5·vel decaying to .2 (τ .4 s); tine modulator
  // 14:1 index .8 (τ 30 ms); amp decay τ 3 s @C3 → .8 s @C6 (log-interpolated); soft saturation; stereo
  // tremolo 4.5 Hz; morph = tremolo depth.
  // Bus: 20 Hz DC blocker → drive → tanh (oversample 'none', ≡ 4x measured, −178 frames) → tremolo.
  //  * The 1:1 pair's first lower sideband sits on 0 Hz, so the voice sum carries a note-synchronous DC offset
  //    (audition E1, −0.05…−0.076): blocked before the saturator, once per instrument.
  //  * Tremolo = linear antiphase L/R gains (Suitcase style): gL = 1 − d(1+lfo)/2, gR = 1 − d(1−lfo)/2, so each
  //    side is an amplitude tremolo, the image auto-pans, and the mono sum is constant (review m4). A norm gain
  //    keeps the per-side RMS at the old equal-power panner's 1/√2 for every depth (calibration unchanged).
  //  * FM indices are capped against Nyquist per note (Carson) and rescaled on legato (m6, m9).
  'soft-keys': {
    trim: 0.6,
    init(inst) {
      const ctx = inst.ctx;
      const mono = { channelCount: 1, channelCountMode: 'explicit' };
      inst.dc = inst.shared(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 20, Q: BUTTER2_Q }));
      inst.pre = inst.shared(new GainNode(ctx, { gain: 1 }));
      inst.shaper = inst.shared(new WaveShaperNode(ctx, { curve: softClipCurve(EP_CLIP_DB), oversample: 'none' }));
      inst.post = inst.shared(new GainNode(ctx, { gain: 1, ...mono }));
      const d = this.tremDepth(inst);
      const tr = this.tremGains(d);
      inst.tremL = inst.shared(new GainNode(ctx, { gain: tr.base, ...mono }));
      inst.tremR = inst.shared(new GainNode(ctx, { gain: tr.base, ...mono }));
      inst.tremPos = inst.shared(new GainNode(ctx, { gain: tr.mod }));
      inst.tremNeg = inst.shared(new GainNode(ctx, { gain: -tr.mod }));
      inst.tremNorm = inst.shared(new GainNode(ctx, { gain: tr.norm }));
      const merge = inst.shared(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
      inst.tremLfo = inst.sharedSource(new OscillatorNode(ctx, { frequency: inst.params.tremRate }));
      inst.tremLfo.connect(inst.tremPos).connect(inst.tremR.gain);
      inst.tremLfo.connect(inst.tremNeg).connect(inst.tremL.gain);
      inst.bus.connect(inst.dc).connect(inst.pre).connect(inst.shaper).connect(inst.post);
      inst.post.connect(inst.tremL).connect(merge, 0, 0);
      inst.post.connect(inst.tremR).connect(merge, 0, 1);
      merge.connect(inst.tremNorm).connect(inst.output);
      this.setDrive(inst, 0);
    },
    tremDepth(inst) {
      return clamp(inst.params.tremolo + inst.morphX, 0, 1) * 0.9;
    },
    /** base = 1 − d/2, mod = d/2 (LFO ±1), norm: per-side RMS = 1/√2 (the old panner's) at any depth. */
    tremGains(d) {
      const base = 1 - d / 2;
      return { base, mod: d / 2, norm: Math.SQRT1_2 / Math.sqrt(base * base + (d * d) / 8) };
    },
    setTrem(inst, t) {
      const g = this.tremGains(this.tremDepth(inst));
      rampTo(inst.tremL.gain, g.base, t);
      rampTo(inst.tremR.gain, g.base, t);
      rampTo(inst.tremPos.gain, g.mod, t);
      rampTo(inst.tremNeg.gain, -g.mod, t);
      rampTo(inst.tremNorm.gain, g.norm, t);
    },
    setDrive(inst, t) {
      const k = 0.5 + 2.5 * inst.params.drive; // input scale into the tanh
      rampTo(inst.pre.gain, k / EP_CLIP_G, t, 0.02);
      rampTo(inst.post.gain, Math.tanh(EP_CLIP_G) / k, t, 0.02);
    },
    ampTau(note) {
      // τ 3 s at C3 (48) → 0.8 s at C6 (84), log-interpolated, extrapolated and clamped outside
      return clamp(3 * Math.pow(0.8 / 3, (note - 48) / 36), 0.35, 6);
    },
    /** Index caps for a carrier at f: 1:1 modulator, then the 14:1 tine above what the 1:1 pair already uses. */
    caps(sr, f, i1) {
      const c1 = fmIndexCap(sr, f, f);
      return { c1, cT: fmIndexCap(sr, f, 14 * f, Math.min(i1, c1) * f) };
    },
    voice(inst, v, note, vel, t) {
      const ctx = inst.ctx;
      const p = inst.params;
      const f = noteToFreq(note);
      const car = inst.osc(v, 'sine', f, 0, t);
      const m1 = inst.osc(v, 'sine', f, 0, t);
      const i0 = (0.3 + 1.5 * vel) * p.tone;
      const { c1, cT } = this.caps(ctx.sampleRate, f, i0);
      const m1G = v.add(new GainNode(ctx, { gain: 0 })); // deviation = index · f_mod
      const fm1 = new FmDepth(m1G.gain, { i0, floor: 0.2 * p.tone, tau: 0.4, fm: f, cap: c1, t0: t });
      m1.connect(m1G).connect(car.frequency);
      const pitched = [[car.frequency, 1], [m1.frequency, 1]];
      const iT = 0.8 * p.tine * (0.4 + 0.6 * vel);
      let fmT = null;
      // tine only where some of its first sideband fits under 0.45·sr (m9: the old gate checked 14f alone)
      if (iT > 0 && cT > 0.02) {
        const tine = inst.osc(v, 'sine', 14 * f, 0, t);
        v._stopSource(tine, t + 0.3); // τ 30 ms → silent long before; saves CPU
        const tG = v.add(new GainNode(ctx, { gain: 0 }));
        fmT = new FmDepth(tG.gain, { i0: iT, floor: 0, tau: 0.03, fm: 14 * f, cap: cT, t0: t });
        tine.connect(tG).connect(car.frequency);
        pitched.push([tine.frequency, 14]);
      }
      const envG = v.add(new GainNode(ctx, { gain: 0 }));
      v.out = v.add(new GainNode(ctx, { gain: (0.15 + 0.85 * vel) * 0.5 }));
      car.connect(envG).connect(v.out).connect(inst.bus);
      v.env = makeEnv(ctx, envG.gain, { a: 0.002, s: 0, dTau: this.ampTau(note) * p.decay, r: p.release }, t);
      standardRelease(inst, v);
      Object.assign(v.data, { f, fm1, fmT, pitched });
    },
    glide(inst, v, note, t) {
      glidePitched(inst, v, note, t);
      const f = v.data.f;
      const dur = inst.params.glide ?? 0.03;
      const { fm1, fmT } = v.data;
      const { c1, cT } = this.caps(inst.ctx.sampleRate, f, fm1.index(t + dur));
      fm1.retune(f, c1, t, dur); // in-flight index kept, deviation follows f (m6)
      if (fmT && t < v.startedAt + 0.3) fmT.retune(14 * f, cT, t, dur);
    },
    apply(inst, key, val, t) {
      if (key === 'tremolo') this.setTrem(inst, t);
      else if (key === 'tremRate') rampTo(inst.tremLfo.frequency, val, t);
      else if (key === 'drive') this.setDrive(inst, t);
    },
    morph(inst, x, t) {
      this.setTrem(inst, t);
    },
  },

  // Bell: 2-op FM, ratio 3.5 (morph → 5.1), index 2 decaying (τ indexDecay) to .3, long keytracked decay.
  // The index is capped per note so the Carson bandwidth f + (I+1)·r·f stays under 0.45·sr (review M3: C7 at
  // morph 1 folded to an inharmonic growl); ratio/morph changes and legato rescale the in-flight deviation and
  // re-apply the cap (m6). Carrier and modulator start at random phases (m8: 16 phase-0 sines stacked to +6 dBFS).
  bell: {
    trim: 0.5,
    init(inst) {
      inst.sines = sineWaves(inst.ctx);
      inst.bus.connect(inst.output);
    },
    ratio(inst) {
      return inst.params.ratio + inst.morphX * (5.1 - 3.5);
    },
    cap(inst, f, r) {
      return fmIndexCap(inst.ctx.sampleRate, f, r * f);
    },
    voice(inst, v, note, vel, t) {
      const ctx = inst.ctx;
      const p = inst.params;
      const f = noteToFreq(note);
      const r = this.ratio(inst);
      const car = inst.osc(v, inst.rng.pick(inst.sines), f, 0, t);
      const mod = inst.osc(v, inst.rng.pick(inst.sines), f * r, 0, t);
      const i0 = p.index * (0.6 + 0.4 * vel);
      const mG = v.add(new GainNode(ctx, { gain: 0 }));
      const fmd = new FmDepth(mG.gain, { i0, floor: 0.15 * i0, tau: p.indexDecay, fm: r * f, cap: this.cap(inst, f, r), t0: t });
      mod.connect(mG).connect(car.frequency);
      const envG = v.add(new GainNode(ctx, { gain: 0 }));
      v.out = v.add(new GainNode(ctx, { gain: (0.25 + 0.75 * vel) * 0.5 * keyLevel(note) }));
      car.connect(envG).connect(v.out).connect(inst.bus);
      const tau = p.decay * keytrack(note, 60, -0.5) / 3; // decay param ≈ time to −26 dB
      v.env = makeEnv(ctx, envG.gain, { a: p.attack, s: 0, dTau: tau, r: p.release }, t);
      standardRelease(inst, v);
      Object.assign(v.data, { mod, f, fmd, pitched: [[car.frequency, 1], [mod.frequency, r]] });
    },
    retune(inst, v, t) {
      const e = tracked(v)[1];
      e.mult = this.ratio(inst);
      e.tp.glide(v.data.f * e.mult, t, 0.02);
      v.data.fmd.retune(v.data.f * e.mult, this.cap(inst, v.data.f, e.mult), t, 0.02);
    },
    glide(inst, v, note, t) {
      glidePitched(inst, v, note, t);
      const r = tracked(v)[1].mult;
      v.data.fmd.retune(v.data.f * r, this.cap(inst, v.data.f, r), t, inst.params.glide ?? 0.03);
    },
    apply(inst, key, val, t) {
      if (key === 'ratio') inst.forVoices((v) => this.retune(inst, v, t));
    },
    morph(inst, x, t) {
      inst.forVoices((v) => this.retune(inst, v, t));
    },
  },

  // Drone oscillator (for drone.js): warm-pad-like voice (4 saws + sub tri, HPF 80 Hz, LPF pair) with
  // per-voice ±3¢ random-walk drift (seeded loop buffer, own offset/rate per voice) and an extra slow
  // unison drift (one shared ~0.02 Hz LFO spreading the saw pairs in opposite directions).
  'drone-osc': {
    trim: 0.45,
    morphCents: 1200,
    init(inst) {
      const ctx = inst.ctx;
      initFilterMod(inst, 1400, true, this.morphCents);
      inst.walk = randomWalkBuffer(ctx, inst.rng);
      inst.uniLfo = inst.sharedSource(new OscillatorNode(ctx, { frequency: inst.rng.range(0.015, 0.03) }));
      inst.uniPos = inst.shared(new GainNode(ctx, { gain: inst.params.unisonDrift }));
      inst.uniNeg = inst.shared(new GainNode(ctx, { gain: -inst.params.unisonDrift }));
      inst.uniLfo.connect(inst.uniPos);
      inst.uniLfo.connect(inst.uniNeg);
      inst.hpf = busHpf(inst, 80);
      inst.monoLow = monoBelow(inst, MONO_SIDE_HPF);
      inst.bus.connect(inst.hpf).connect(inst.monoLow.input);
      inst.monoLow.output.connect(inst.output);
    },
    voice(inst, v, note, vel, t) {
      const ctx = inst.ctx;
      const p = inst.params;
      const f = noteToFreq(note);
      const d = p.detune;
      const sum = v.add(new GainNode(ctx, { gain: 0.22 }));
      const saws = sawStack(inst, v, f, [-d, -d / 3, d / 3, d], [-0.5, 0.2, -0.2, 0.5], t, sum);
      const sub = inst.osc(v, 'triangle', f / 2, 0, t);
      const subG = v.add(new GainNode(ctx, { gain: p.sub * 1.12 }));
      sub.connect(subG).connect(sum);
      // per-voice drift: random-walk buffer → cents → every oscillator of this voice
      const walk = new AudioBufferSourceNode(ctx, { buffer: inst.walk, loop: true, playbackRate: inst.rng.range(0.6, 1.4) });
      const driftG = v.add(new GainNode(ctx, { gain: p.drift }));
      walk.connect(driftG);
      for (const o of [...saws, sub]) driftG.connect(o.detune);
      v.addSource(walk, t, undefined, inst.rng.range(0, inst.walk.duration));
      // shared slow unison drift
      v.link(inst.uniNeg, saws[0].detune);
      v.link(inst.uniPos, saws[1].detune);
      v.link(inst.uniNeg, saws[2].detune);
      v.link(inst.uniPos, saws[3].detune);
      const [l1, l2] = lpfPair(inst, v, 1400 * keytrack(note, 60, 0.5) * (0.7 + 0.6 * vel));
      linkFilter(inst, v, l1, l2);
      const envG = v.add(new GainNode(ctx, { gain: 0 }));
      v.out = v.add(new GainNode(ctx, { gain: (0.55 + 0.45 * vel) * keyLevel(note) }));
      sum.connect(l1); // HPF 80 Hz on the bus
      l2.connect(envG).connect(v.out).connect(inst.bus);
      v.env = makeEnv(ctx, envG.gain, { a: p.attack, d: 1, s: 1, r: p.release }, t);
      standardRelease(inst, v);
      Object.assign(v.data, { f, saws, subG, driftG, pitched: [...saws.map((o) => [o.frequency, 1]), [sub.frequency, 0.5]] });
    },
    apply(inst, key, val, t) {
      if (key === 'cutoff') rampTo(inst.filterCS.offset, filterOffsetCents(inst, this.morphCents), t);
      else if (key === 'lfoRate') rampTo(inst.lfo.frequency, val, t);
      else if (key === 'lfoDepth') rampTo(inst.lfoGain.gain, val, t);
      else if (key === 'unisonDrift') {
        rampTo(inst.uniPos.gain, val, t);
        rampTo(inst.uniNeg.gain, -val, t);
      } else if (key === 'drift') inst.forVoices((v) => rampTo(v.data.driftG.gain, val, t));
      else if (key === 'sub') inst.forVoices((v) => rampTo(v.data.subG.gain, val * 1.12, t));
      else if (key === 'detune') {
        const d = [-val, -val / 3, val / 3, val];
        inst.forVoices((v) => v.data.saws.forEach((o, i) => rampTo(o.detune, d[i], t)));
      }
    },
    morph(inst, x, t) {
      rampTo(inst.filterCS.offset, filterOffsetCents(inst, this.morphCents), t);
    },
  },
};

/**
 * SPEC §3.2 Instrument for the synth patches.
 * `new SynthInstrument(ctx, prng, patchId, initialParams)`.
 */
export class SynthInstrument extends InstrumentBase {
  constructor(ctx, prng, patchId, initialParams) {
    let meta = BY_ID.get(patchId);
    if (!meta) {
      console.warn(`[synth] unknown patch "${patchId}", using warm-pad`);
      meta = BY_ID.get('warm-pad');
    }
    super(ctx, prng, meta, initialParams);
    this.patchId = meta.id;
    this.impl = IMPL[meta.id];
    this.saws = phaseRotatedSawWaves(ctx, 8);
    setNow(this.output.gain, this.impl.trim, 0);
    this.impl.init(this);
    addOutputCeiling(this); // m8: static soft ceiling (linear < −4 dBFS, asymptote −1 dBFS); `trimNode` = old output
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

export default SynthInstrument;
