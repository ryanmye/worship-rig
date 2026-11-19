// Dry test stimuli for the golden renders (tools/golden). Pure and dependency-free: the browser page imports it to
// build the AudioBuffer that drives an effect, and render.mjs imports it to write the same samples as WAV
// (native/golden/stimuli/*.wav), so the native engine is fed bit-identical input.
//
// Every stimulus is computed in float64 and rounded to float32 once, with closed-form formulas a C++ port can copy.
// Randomness comes from mulberry32 (a verbatim copy of app/js/shared/prng.js `mulberry32`, kept here so this file
// also runs in node without the app's module paths); a string seed is hashed with FNV-1a (`hashSeed`).

/** Golden sample rate (Hz). */
export const GOLDEN_SR = 44100;
/** Every stimulus starts with this much silence (s): the engine's commit ramps settle first. */
export const STIM_LEAD_SEC = 0.25;

/**
 * FNV-1a 32-bit (same as app/js/shared/prng.js hashSeed).
 * @param {string} s
 * @returns {number} uint32
 */
export function hashSeed(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32 (same as app/js/shared/prng.js): floats in [0, 1) with 2^-32 resolution.
 * @param {number} seed uint32
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stimulus definitions. `seconds` is the total buffer length including STIM_LEAD_SEC of leading silence.
 * kind: impulse | sweep | noise | sine | steps | stereo-noise | tone-burst
 */
export const STIMULI = Object.freeze({
  // one sample at 0.5 at the end of the lead-in (reverb / echo / EQ impulse responses)
  impulse: { kind: 'impulse', seconds: 0.5, amp: 0.5 },
  // exponential (Farina) sine sweep 20 Hz → 20 kHz over 2 s, 10 ms raised-cosine fades at both ends
  sweep: { kind: 'sweep', seconds: 2.5, amp: 0.25, f0: 20, f1: 20000, dur: 2, fade: 0.01 },
  // 0.5 s of white noise, uniform in [−amp, amp), 5 ms linear fades; L and R identical (mono stimulus)
  noise: { kind: 'noise', seconds: 1, amp: 0.25, dur: 0.5, fade: 0.005, seed: 'golden-noise' },
  // independent L/R noise (slot width: the side signal must be non-zero)
  'stereo-noise': { kind: 'stereo-noise', seconds: 1.5, amp: 0.25, dur: 1, fade: 0.005, seed: 'golden-stereo-noise' },
  // steady 440 Hz sine, 1 s, 10 ms fades (chorus / lofi modulation)
  sine: { kind: 'sine', seconds: 1.5, amp: 0.3, hz: 440, dur: 1, fade: 0.01 },
  // 1 kHz sine in 0.4 s steps at −36, −24, −12, −6, −1 dBFS then 0.25 s silence (compressor / limiter curves)
  steps: { kind: 'steps', seconds: 2.25, hz: 1000, step: 0.4, levelsDb: [-36, -24, -12, -6, -1], fade: 0.002 },
  // 200 Hz + 2 kHz tone bursts at −6 dBFS: 50 ms on / 450 ms off ×4 (compressor attack / release)
  'tone-burst': { kind: 'tone-burst', seconds: 2.5, hz: [200, 2000], amp: 0.5, on: 0.05, period: 0.5, count: 4,
    fade: 0.001 },
});

function fadeGain(i, n, nf) {
  if (nf <= 0) return 1;
  return Math.min(1, i / nf, (n - 1 - i) / nf);
}

/**
 * Generate a stimulus as two float32 channels at `sr`.
 * @param {string} id key of STIMULI
 * @param {number} [sr]
 * @returns {{L:Float32Array, R:Float32Array, def:object}}
 */
export function makeStimulus(id, sr = GOLDEN_SR) {
  const def = STIMULI[id];
  if (!def) throw new Error(`unknown stimulus ${id}`);
  const len = Math.round(def.seconds * sr);
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  const s0 = Math.round(STIM_LEAD_SEC * sr);
  switch (def.kind) {
    case 'impulse':
      L[s0] = def.amp;
      R[s0] = def.amp;
      break;
    case 'sweep': {
      const n = Math.round(def.dur * sr);
      const k = Math.log(def.f1 / def.f0);
      const nf = Math.round(def.fade * sr);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const ph = ((2 * Math.PI * def.f0 * def.dur) / k) * (Math.exp((t / def.dur) * k) - 1);
        let g = 1;
        if (i < nf) g = 0.5 - 0.5 * Math.cos((Math.PI * i) / nf);
        else if (i >= n - nf) g = 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / nf);
        L[s0 + i] = R[s0 + i] = def.amp * g * Math.sin(ph);
      }
      break;
    }
    case 'noise':
    case 'stereo-noise': {
      const n = Math.round(def.dur * sr);
      const nf = Math.round(def.fade * sr);
      const rnd = mulberry32(hashSeed(def.seed));
      for (let i = 0; i < n; i++) {
        const g = def.amp * fadeGain(i, n, nf);
        // one draw per frame (mono) or L then R (stereo): the C++ port must keep this order
        const a = rnd() * 2 - 1;
        L[s0 + i] = g * a;
        R[s0 + i] = def.kind === 'noise' ? g * a : g * (rnd() * 2 - 1);
      }
      break;
    }
    case 'sine': {
      const n = Math.round(def.dur * sr);
      const nf = Math.round(def.fade * sr);
      for (let i = 0; i < n; i++) {
        L[s0 + i] = R[s0 + i] = def.amp * fadeGain(i, n, nf) * Math.sin((2 * Math.PI * def.hz * i) / sr);
      }
      break;
    }
    case 'steps': {
      const n = Math.round(def.step * sr);
      const nf = Math.round(def.fade * sr);
      def.levelsDb.forEach((db, j) => {
        const a = Math.pow(10, db / 20);
        for (let i = 0; i < n; i++) {
          const f = s0 + j * n + i;
          L[f] = R[f] = a * fadeGain(i, n, nf) * Math.sin((2 * Math.PI * def.hz * (j * n + i)) / sr);
        }
      });
      break;
    }
    case 'tone-burst': {
      const n = Math.round(def.on * sr);
      const per = Math.round(def.period * sr);
      const nf = Math.round(def.fade * sr);
      for (let b = 0; b < def.count; b++) {
        for (let i = 0; i < n; i++) {
          let v = 0;
          for (const hz of def.hz) v += Math.sin((2 * Math.PI * hz * i) / sr);
          const f = s0 + b * per + i;
          L[f] = R[f] = (def.amp / def.hz.length) * fadeGain(i, n, nf) * v;
        }
      }
      break;
    }
    default:
      throw new Error(`unknown stimulus kind ${def.kind}`);
  }
  return { L, R, def };
}
