// Tonewheel organ (SPEC §3.4, REVIEW 3.6): additive tone from ONE oscillator per voice at f/2 playing a
// PeriodicWave (disableNormalization) that contains the nine drawbar harmonics; key click, Hammond-style
// shared percussion, tanh overdrive and a two-rotor rotary simulation after the voice sum.
import { rampTo, setNow, linearTo } from '../shared/automation.js';
import { noteToFreq } from '../shared/music.js';
import { InstrumentBase, makeEnv, softClipCurve, TrackedParam, sineWaves, BUTTER2_Q, addOutputCeiling } from './voice.js';

/** Harmonic number (relative to f/2) for drawbars 16′ 5⅓′ 8′ 4′ 2⅔′ 2′ 1⅗′ 1⅓′ 1′. */
export const DRAWBAR_HARMONICS = Object.freeze([1, 3, 2, 4, 6, 8, 10, 12, 16]);
const FOOTAGES = ['16′', '5⅓′', '8′', '4′', '2⅔′', '2′', '1⅗′', '1⅓′', '1′'];
/** Drawbar step → linear amplitude (≈ 3 dB per step). */
export const drawbarAmp = (d) => (d ? Math.pow(10, (-3 * (8 - d)) / 20) : 0);

const ROTARY = Object.freeze({
  slow: { horn: 0.8, drum: 0.7 },
  fast: { horn: 6.8, drum: 5.9 },
  hornTau: 0.3,
  drumTau: 1.5,
  crossover: 800,
  hornDelay: 0.001, // base, s
  // ±0.35 ms, NEGATIVE: the delay is shortest when the AM (loudness) peaks, i.e. when the horn points at the mic.
  // Pitch (−d(delay)/dt) therefore peaks 90° BEFORE loudness — rising and getting louder while approaching, like
  // a real Leslie (review m5; measured with a 5 kHz probe: pitch leads AM by ≈ +90°, was −91°).
  hornDelayDepth: -0.00035,
  hornAm: { center: (1 + Math.pow(10, -3 / 20)) / 2, depth: (1 - Math.pow(10, -3 / 20)) / 2 }, // 3 dB
  drumAm: { center: (1 + Math.pow(10, -2 / 20)) / 2, depth: (1 - Math.pow(10, -2 / 20)) / 2 }, // 2 dB
});

const CLIP_DB = 12; // tanh(4x)/tanh(4); drive scales the input into it
const CLIP_G = Math.pow(10, CLIP_DB / 20);
/**
 * Overdrive oversampling (review m2): 'none' ≡ '4x' up to drive .5 (measured, gospel/full), '2x' above
 * (full at drive 1: none −29 dB aliases, 2x −69 dB). Oversampling costs 128 (2x) / 192 (4x) frames of latency.
 */
const overdriveOversample = (drive) => (drive > 0.5 ? '2x' : 'none');
/** Hammond percussion: 3rd harmonic, τ .2 s, shared envelope (single trigger). */
const PERC = { level: 0.9, tau: 0.2 };
const VOICE_GAIN = 0.1; // 9 full drawbars sum to ≤ ~0.9 peak per voice (drive stays meaningful)
/** Output trim per preset: C-E-G at velocity 96 ≈ −20 dBFS RMS (tools/calibrate.mjs refines). */
const PRESET_TRIM = { gospel: 0.45, 'soft-pad': 0.55, full: 0.45, church: 0.75 };

function presetParams(bars, { percussion = false, click = 0.5, drive = 0.3, rotary = 'slow', release = 0.08 } = {}) {
  const d = String(bars).split('').map(Number);
  const p = [];
  for (let i = 0; i < 9; i++) {
    p.push(Object.freeze({ key: `drawbar${i + 1}`, label: FOOTAGES[i], min: 0, max: 8, default: d[i], unit: 'lin', curve: 'lin', step: 1 }));
  }
  p.push(Object.freeze({ key: 'percussion', label: 'Percussion', min: 0, max: 1, default: percussion, unit: 'bool', curve: 'lin' }));
  p.push(Object.freeze({ key: 'click', label: 'Key click', min: 0, max: 1, default: click, unit: 'lin', curve: 'lin' }));
  p.push(Object.freeze({ key: 'drive', label: 'Drive', min: 0, max: 1, default: drive, unit: 'lin', curve: 'lin' }));
  p.push(Object.freeze({ key: 'rotary', label: 'Rotary', default: rotary, unit: 'enum', curve: 'lin', enum: Object.freeze(['slow', 'fast', 'off']) }));
  p.push(Object.freeze({ key: 'release', label: 'Release', min: 0.01, max: 4, default: release, unit: 's', curve: 'log' }));
  return Object.freeze(p);
}

/** Organ presets (metadata for listInstruments; params carry each preset's defaults). */
export const PRESETS = Object.freeze([
  Object.freeze({ id: 'gospel', name: 'Gospel Organ', group: 'Organ', params: presetParams('888800000', { percussion: true, click: 0.5, drive: 0.35, rotary: 'fast', release: 0.08 }) }),
  Object.freeze({ id: 'soft-pad', name: 'Soft Organ', group: 'Organ', params: presetParams('008800000', { percussion: false, click: 0.2, drive: 0.1, rotary: 'slow', release: 0.15 }) }),
  Object.freeze({ id: 'full', name: 'Full Organ', group: 'Organ', params: presetParams('888888888', { percussion: false, click: 0.5, drive: 0.5, rotary: 'slow', release: 0.08 }) }),
  Object.freeze({ id: 'church', name: 'Church Organ', group: 'Organ', params: presetParams('806000000', { percussion: false, click: 0.1, drive: 0, rotary: 'off', release: 1.5 }) }),
]);
const BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

const WAVE_CACHE = new WeakMap();
/** Phase rotations per registration: tonewheels free-run, so voices start at random phase (review m8). */
export const WAVE_ROTATIONS = 8;
/**
 * The drawbar registration as WAVE_ROTATIONS PeriodicWaves, rotation i = the same wave started at phase 2πi/8
 * of the 16′ fundamental (harmonic h shifted by h·θ). Cached per context.
 * @param {BaseAudioContext} ctx
 * @param {number[]} bars nine values 0..8
 * @returns {PeriodicWave[]}
 */
export function drawbarWaves(ctx, bars) {
  let m = WAVE_CACHE.get(ctx);
  if (!m) WAVE_CACHE.set(ctx, (m = new Map()));
  const key = bars.join('');
  if (m.has(key)) return m.get(key);
  const amp = new Float32Array(17);
  for (let i = 0; i < 9; i++) amp[DRAWBAR_HARMONICS[i]] += drawbarAmp(bars[i]);
  const waves = [];
  for (let r = 0; r < WAVE_ROTATIONS; r++) {
    const th = (2 * Math.PI * r) / WAVE_ROTATIONS;
    const real = new Float32Array(17);
    const imag = new Float32Array(17);
    for (let h = 1; h <= 16; h++) {
      real[h] = amp[h] * Math.sin(h * th);
      imag[h] = amp[h] * Math.cos(h * th);
    }
    waves.push(ctx.createPeriodicWave(real, imag, { disableNormalization: true }));
  }
  m.set(key, waves);
  return waves;
}
/** Rotation 0 (sine phase) of a registration — kept for callers of the single-wave API. */
export function drawbarWave(ctx, bars) {
  return drawbarWaves(ctx, bars)[0];
}

const CLICK_CACHE = new WeakMap();
/** 4 variants of a 4 ms Hann-windowed noise burst (seeded), shared per context. */
function clickBuffers(ctx, rng) {
  if (CLICK_CACHE.has(ctx)) return CLICK_CACHE.get(ctx);
  const len = Math.max(8, Math.round(0.004 * ctx.sampleRate));
  const bufs = [];
  for (let k = 0; k < 4; k++) {
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (rng.next() * 2 - 1) * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
    bufs.push(b);
  }
  CLICK_CACHE.set(ctx, bufs);
  return bufs;
}

/**
 * SPEC §3.2 Instrument: `new OrganInstrument(ctx, prng, presetId, initialParams)`.
 * Graph: voices → bus → (+ click BPF) → drive pre → tanh 4x → post → { dry | rotary } → output.
 */
export class OrganInstrument extends InstrumentBase {
  constructor(ctx, prng, presetId, initialParams) {
    let meta = BY_ID.get(presetId);
    if (!meta) {
      console.warn(`[organ] unknown preset "${presetId}", using gospel`);
      meta = BY_ID.get('gospel');
    }
    super(ctx, prng, meta, initialParams);
    this.presetId = meta.id;
    this.waves = drawbarWaves(ctx, this._bars()); // built here = in prepare
    this.sines = sineWaves(ctx);
    this._percT = -Infinity; // shared percussion envelope: last trigger time
    this._waveTimer = null;
    this.clicks = clickBuffers(ctx, this.rng);

    // key click: shared band-pass 2–4 kHz (centre 2.83 kHz, Q ≈ 1.41), level = click param
    this.clickBpf = this.shared(new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 2830, Q: 1.41 }));
    this.clickG = this.shared(new GainNode(ctx, { gain: this.params.click * 1.5 }));
    this.clickBpf.connect(this.clickG).connect(this.bus);

    // overdrive (tanh) with automatable pre/post gains; oversampling only where it buys something (m2)
    this.pre = this.shared(new GainNode(ctx, { gain: 1 }));
    this.shaper = this.shared(new WaveShaperNode(ctx, { curve: softClipCurve(CLIP_DB), oversample: overdriveOversample(this.params.drive) }));
    this.post = this.shared(new GainNode(ctx, { gain: 1 }));
    this.bus.connect(this.pre).connect(this.shaper).connect(this.post);
    this._setDrive(0);

    // dry / rotary crossfade
    const rot = this.params.rotary;
    this.dryG = this.shared(new GainNode(ctx, { gain: rot === 'off' ? 1 : 0 }));
    this.rotG = this.shared(new GainNode(ctx, { gain: rot === 'off' ? 0 : 1 }));
    this.post.connect(this.dryG).connect(this.output);
    this.post.connect(this.rotG);
    this._buildRotary(this._rotaryTarget() || 'slow');
    // silent sink that keeps the debounce timers' ConstantSources pulled
    this._sink = this.shared(new GainNode(ctx, { gain: 0 }));
    this._sink.connect(this.output);
    setNow(this.output.gain, PRESET_TRIM[this.presetId] ?? 0.5, 0);
    addOutputCeiling(this); // m8: static soft ceiling (linear < −4 dBFS, asymptote −1 dBFS); `trimNode` = old output
  }

  _bars() {
    const b = [];
    for (let i = 1; i <= 9; i++) b.push(this.params[`drawbar${i}`]);
    return b;
  }

  // Rotary: 800 Hz crossover; horn = modulated delay (±.35 ms) + 3 dB AM; drum = 2 dB AM.
  // Each rotor: one speed ConstantSource drives a sin and a cos oscillator (L/R mics 90° apart, phase-locked);
  // speed changes are setTargetAtTime on the speed (inertia τ horn .3 s, drum 1.5 s).
  _buildRotary(speed) {
    const ctx = this.ctx;
    const S = ROTARY[speed];
    const mono = { channelCount: 1, channelCountMode: 'explicit' };
    // Butterworth pair (Web Audio Q in dB: −3.01): each branch −3 dB at 800 Hz, |LP|² + |HP|² = 1 (review m1;
    // the old "Q .707" was +0.7 dB of resonance: the rotary path measured +2.8…+3.7 dB re dry at 500–800 Hz).
    const lo = this.shared(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: ROTARY.crossover, Q: BUTTER2_Q, ...mono }));
    const hi = this.shared(new BiquadFilterNode(ctx, { type: 'highpass', frequency: ROTARY.crossover, Q: BUTTER2_Q, ...mono }));
    this.rotG.connect(lo);
    this.rotG.connect(hi);
    this.xover = [lo, hi];
    const merger = this.shared(new ChannelMergerNode(ctx, { numberOfInputs: 2 }));
    merger.connect(this.output);
    const rotor = (freq, am, withDelay) => {
      const speedCS = this.sharedSource(new ConstantSourceNode(ctx, { offset: freq }));
      const sin = new OscillatorNode(ctx, { frequency: 0 });
      const cos = new OscillatorNode(ctx, {
        frequency: 0, type: 'custom',
        periodicWave: ctx.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0]), { disableNormalization: true }),
      });
      speedCS.connect(sin.frequency);
      speedCS.connect(cos.frequency);
      const t0 = ctx.currentTime;
      this.shared(sin);
      this.shared(cos);
      this._sharedSources.push(sin, cos);
      sin.start(t0);
      cos.start(t0);
      const outs = [];
      for (const [ch, lfo] of [[0, sin], [1, cos]]) {
        let src = withDelay.input;
        if (withDelay.on) {
          const dl = this.shared(new DelayNode(ctx, { maxDelayTime: 0.01, delayTime: ROTARY.hornDelay, ...mono }));
          const dg = this.shared(new GainNode(ctx, { gain: ROTARY.hornDelayDepth }));
          lfo.connect(dg).connect(dl.delayTime);
          src.connect(dl);
          src = dl;
        }
        const amG = this.shared(new GainNode(ctx, { gain: am.center, ...mono }));
        const amD = this.shared(new GainNode(ctx, { gain: am.depth }));
        lfo.connect(amD).connect(amG.gain);
        src.connect(amG).connect(merger, 0, ch);
        outs.push(amG);
      }
      return speedCS;
    };
    this.hornSpeed = rotor(S.horn, ROTARY.hornAm, { on: true, input: hi });
    this.drumSpeed = rotor(S.drum, ROTARY.drumAm, { on: false, input: lo });
    this.rotarySpeed = speed;
  }

  _setRotarySpeed(speed, t) {
    if (speed !== 'fast' && speed !== 'slow') return;
    this.rotarySpeed = speed;
    rampTo(this.hornSpeed.offset, ROTARY[speed].horn, t, ROTARY.hornTau);
    rampTo(this.drumSpeed.offset, ROTARY[speed].drum, t, ROTARY.drumTau);
  }

  _setDrive(t) {
    const k = 0.35 + 2.5 * this.params.drive; // input scale into tanh(4x)/tanh(4)
    rampTo(this.pre.gain, k / CLIP_G, t, 0.02);
    rampTo(this.post.gain, (Math.tanh(CLIP_G) / k) * (1 - 0.3 * this.params.drive), t, 0.02);
  }

  /** A key is down at `t` (voices the engine still holds — pedal included — count as down). */
  _keyDownAt(t) {
    for (const v of this.alloc.voices) {
      if ((v.state === 'held' || v.state === 'released') && v.startedAt <= t && v.releasedAt > t) return true;
    }
    return false;
  }

  /**
   * Hammond percussion (review M1): ONE envelope per instrument. A note-on with no key down re-arms and fires it
   * (t0 = t); every note struck while it decays — the rest of a chord at the same `when`, a roll, a fill —
   * gets the 3rd harmonic at the envelope's current level 0.9·e^{−(t−t0)/τ}, decaying on the same τ.
   * @returns {number} level for a note starting at t (0 = none)
   */
  _percLevel(t) {
    if (!this._keyDownAt(t)) this._percT = t;
    const dt = t - this._percT;
    const lv = dt >= 0 ? PERC.level * Math.exp(-dt / PERC.tau) : 0;
    return lv > 2e-3 ? lv : 0;
  }

  /** Apply a pending oversample change while nothing sounds through the shaper (switching is then inaudible). */
  _syncOversample() {
    const os = overdriveOversample(this.params.drive);
    if (this.shaper.oversample !== os && this.alloc.size === 0) this.shaper.oversample = os;
  }

  _buildVoice(v, note, vel, t) {
    const ctx = this.ctx;
    const f = noteToFreq(note);
    this._syncOversample();
    const rot = this.rng.int(0, WAVE_ROTATIONS - 1);
    const o = this.osc(v, this.waves[rot], f / 2, 0, t); // one oscillator at f/2 (16′ fundamental), random phase
    const envG = v.add(new GainNode(ctx, { gain: 0 }));
    v.out = v.add(new GainNode(ctx, { gain: VOICE_GAIN }));
    o.connect(envG);
    // percussion: 3rd harmonic (2⅔′ = harmonic 6 of f/2, so rotation 6·rot keeps it locked to the tonewheel)
    const lv = this.params.percussion ? this._percLevel(t) : 0;
    if (lv > 0) {
      const p = this.osc(v, this.sines[(6 * rot) % 8], 3 * f, 0, t);
      const pg = v.add(new GainNode(ctx, { gain: 0 }));
      setNow(pg.gain, 0, t);
      linearTo(pg.gain, lv, t, 0.001, { from: 0 });
      rampTo(pg.gain, 0, t + 0.001, PERC.tau);
      v._stopSource(p, t + PERC.tau * 6.9 * 1.3);
      p.connect(pg).connect(envG);
      v.data.perc = p;
      v.data.percLevel = lv;
    }
    envG.connect(v.out).connect(this.bus);
    // key click: 4 ms windowed noise → shared BPF
    if (this.params.click > 0) {
      const c = new AudioBufferSourceNode(ctx, { buffer: this.rng.pick(this.clicks) });
      c.connect(this.clickBpf);
      v.addSource(c, t);
    }
    v.env = makeEnv(ctx, envG.gain, { a: 0.005, s: 1, r: this.params.release }, t);
    v.onRelease = (rt) => v.env.release(rt, this.params.release);
    v.data.osc = o;
    v.data.rot = rot;
    v.data.f = f;
  }

  _glide(v, note, t) {
    const f = noteToFreq(note);
    if (!v.data.tosc) v.data.tosc = new TrackedParam(v.data.osc.frequency, v.data.f / 2);
    v.data.tosc.glide(f / 2, t, 0.01);
    if (v.data.perc) {
      if (!v.data.tperc) v.data.tperc = new TrackedParam(v.data.perc.frequency, 3 * v.data.f);
      v.data.tperc.glide(3 * f, t, 0.01);
    }
    v.data.f = f;
  }

  // Drawbar changes: rebuild the wave once per 30 ms burst of changes, timed on the audio clock
  // (ConstantSource onended), then swap it on every live voice.
  _scheduleWave(t) {
    if (this._waveTimer) return;
    const timer = new ConstantSourceNode(this.ctx, { offset: 0 });
    timer.connect(this._sink);
    this._waveTimer = timer;
    timer.onended = () => {
      try {
        timer.disconnect();
      } catch (e) {
        /* ignore */
      }
      this._waveTimer = null;
      if (this.disposed) return;
      this.waves = drawbarWaves(this.ctx, this._bars());
      this.forVoices((v) => v.data.osc && v.data.osc.setPeriodicWave(this.waves[v.data.rot || 0]));
    };
    timer.start(t);
    timer.stop(t + 0.03);
  }

  _applyParam(key, val, t) {
    if (key.startsWith('drawbar')) this._scheduleWave(t);
    else if (key === 'drive') {
      this._setDrive(t);
      this._syncOversample();
    }
    else if (key === 'click') rampTo(this.clickG.gain, val * 1.5, t);
    else if (key === 'rotary') {
      const on = val !== 'off';
      rampTo(this.dryG.gain, on ? 0 : 1, t, 0.03);
      rampTo(this.rotG.gain, on ? 1 : 0, t, 0.03);
      if (on) this._setRotarySpeed(this._rotaryTarget(), t);
    }
  }

  /**
   * Rotor speed = the `rotary` param, with morph as the Leslie half-moon switch RELATIVE to it (review M2):
   * morph < .5 → the param's speed, morph ≥ .5 → the other speed; 'off' → null (morph is a no-op). So the
   * engine's neutral morph(0) never changes a preset, and morph(1) always flips it.
   * @returns {'fast'|'slow'|null}
   */
  _rotaryTarget() {
    const base = this.params.rotary;
    if (base !== 'fast' && base !== 'slow') return null;
    if (!(this.morphX >= 0.5)) return base;
    return base === 'fast' ? 'slow' : 'fast';
  }

  _morph(x, t) {
    const s = this._rotaryTarget();
    if (s && s !== this.rotarySpeed) this._setRotarySpeed(s, t);
  }
}

export default OrganInstrument;
