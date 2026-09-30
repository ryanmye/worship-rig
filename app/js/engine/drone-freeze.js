// Frozen drone for low-resource mode (lowres2; CONTRACT_CHANGES "## lowres2", reviews/idle-cpu-mac.md).
//
// On the Mac a hidden, sounding synth drone cost ≈ 30 Energy Impact: ≈ 21 the live drone-osc voices on the audio
// thread and ≈ 9.5 the reverb convolver it feeds. In low-resource mode the drone is rendered OFFLINE once (its voices
// for the current key + its reverb send, at unit drone level) into a seamless stereo loop, which then plays from one
// looping AudioBufferSourceNode while the live voices stop and the reverb, no longer fed, goes to sleep (fx idle
// sleep). This module holds the pure pieces: the offline render, the seam crossfade and the seam check.
//
// Loop recipe: render preroll + loopLen + xfade frames; keep [preroll, preroll + loopLen) and crossfade the xfade
// frames that follow the loop end into its head with an equal-power fade (head: sin, tail: cos). Looping that buffer
// plays …x[P+L−1] → x[P+L]·1 + x[P]·0… at the wrap, i.e. exactly the rendered continuation: no seam step.
import { AudioTimer, BUTTER2_Q, rngFor } from './fx.js';
import { shareWaveCache } from './voice.js';

/**
 * Default loop length (s): 20 s stereo float = 7.3 MB at 48 kHz (≤ FREEZE_MAX_BYTES). The render costs about what
 * the live drone costs in real time for its length (voices + convolver, on the offline render thread), so the
 * shorter end of the brief's 20–30 s keeps that burst small.
 */
export const FREEZE_LOOP_SEC = 20;
/** Seam crossfade (s, equal-power, ≥ 1 s): the frames after the loop end fade into its head. */
export const FREEZE_SEAM_SEC = 1.5;
/** Rendered before the loop and dropped: drone-osc attack (2.5 s) + the reverb's early energy. */
export const FREEZE_PREROLL_SEC = 4;
/** Live ↔ frozen and frozen ↔ frozen crossfade (s, equal-power). */
export const FREEZE_SWAP_SEC = 1.5;
/** Thaw: the live synth starts this long before the frozen loop fades (its attack and drift settle first). */
export const FREEZE_THAW_LEAD_SEC = 1.5;
/** A change of what the loop bakes in re-renders this long after the last change (audio clock). */
export const FREEZE_DEBOUNCE_SEC = 2;
/** Baked reverb-return level tolerance (dB): smaller changes keep the loop. */
export const FREEZE_WET_TOL_DB = 1;
/** Hard cap per loop buffer (bytes; 2 channels × float32). */
export const FREEZE_MAX_BYTES = 12 * 1024 * 1024;

/**
 * Loop length in frames for `loopSec` at `sr`, clamped to [1 s, 30 s] and to FREEZE_MAX_BYTES (2 × float32).
 * @param {number} sr sample rate
 * @param {number} loopSec
 * @returns {number} frames
 */
export function freezeLoopFrames(sr, loopSec) {
  const sec = Math.min(30, Math.max(1, Number(loopSec) || FREEZE_LOOP_SEC));
  return Math.min(Math.round(sec * sr), Math.floor(FREEZE_MAX_BYTES / 8));
}

/**
 * Make [start, start + loopLen) of each channel loop seamlessly, in place: its first `xf` frames become
 * head·sin + tail·cos, where tail = the `xf` frames right after the loop end (so `chans` must hold them).
 * @param {Float32Array[]} chans rendered channels (length ≥ start + loopLen + xf)
 * @param {number} start first loop frame
 * @param {number} loopLen frames
 * @param {number} xf crossfade frames (≤ loopLen / 2)
 * @returns {Float32Array[]} views of the loop in `chans` (subarrays, no copy)
 */
export function makeSeamlessLoop(chans, start, loopLen, xf) {
  const n = Math.max(0, Math.min(xf, Math.floor(loopLen / 2)));
  const w = n > 0 ? (Math.PI / 2) / n : 0;
  for (const c of chans) {
    for (let i = 0; i < n; i++) {
      const x = i * w;
      c[start + i] = c[start + i] * Math.sin(x) + c[start + loopLen + i] * Math.cos(x);
    }
  }
  return chans.map((c) => c.subarray(start, start + loopLen));
}

/**
 * Seam check of a loop: the step across the wrap (last frame → first frame) against the largest step inside it.
 * @param {ArrayLike<number>[]} chans loop channels
 * @returns {{seamDelta:number, bodyDelta:number, ok:boolean}} ok: seamDelta ≤ bodyDelta
 */
export function seamCheck(chans) {
  let seam = 0;
  let body = 0;
  for (const c of chans) {
    const n = c.length;
    if (n < 2) continue;
    seam = Math.max(seam, Math.abs(c[0] - c[n - 1]));
    for (let i = 1; i < n; i++) {
      const d = Math.abs(c[i] - c[i - 1]);
      if (d > body) body = d;
    }
  }
  return { seamDelta: seam, bodyDelta: body, ok: seam <= body };
}

/**
 * Render the synth drone for one key, offline, into a seamless stereo loop: the drone's own graph (a Drone of the
 * same class at unit level: gain 1, no wheel / swell) plus its reverb send (the same chain as fx.js Reverb: HPF 180 →
 * LPF 9 k → predelay → the live reverb's IR → return × wheel). Deterministic: seeded by (seed, key) and scheduled at
 * `when` 0 (CLAUDE.md), so the same inputs give the same loop (within Chromium's input-summing order, ≈ 1e-6).
 * @param {object} o
 * @param {Function} o.DroneClass the Drone class (passed in: drone.js imports this module)
 * @param {object} o.registry InstrumentRegistry (drone-osc)
 * @param {number} o.seed engine seed
 * @param {number} o.sampleRate the realtime context's rate (the IR must match it)
 * @param {{pc:number, minor:boolean}} o.key
 * @param {{brightness:number, movement:number, width:number}} o.params
 * @param {number} [o.trimDb] gain-trims.json droneTrim
 * @param {{ir:AudioBuffer, predelay:number, wet:number}|null} [o.reverb] null / wet 0 → dry only
 * @param {number} [o.loopSec] FREEZE_LOOP_SEC
 * @param {number} [o.seamSec] FREEZE_SEAM_SEC
 * @param {number} [o.prerollSec] FREEZE_PREROLL_SEC
 * @param {BaseAudioContext} [o.waveSource] the realtime context: its PeriodicWaves are reused (voice.js shareWaveCache)
 * @returns {Promise<{buffer:AudioBuffer, loopSec:number, renderSec:number, renderMs:number, buildMs:number,
 *   postMs:number, maxStepMs:number, stepMs:number[], bytes:number,
 *   seam:{seamDelta:number, bodyDelta:number, ok:boolean}}>}
 */
export async function renderDroneLoop(o) {
  const sr = o.sampleRate;
  const loopLen = freezeLoopFrames(sr, o.loopSec ?? FREEZE_LOOP_SEC);
  const xf = Math.min(Math.round((o.seamSec ?? FREEZE_SEAM_SEC) * sr), Math.floor(loopLen / 2));
  const pre = Math.round((o.prerollSec ?? FREEZE_PREROLL_SEC) * sr);
  const total = pre + loopLen + xf;
  // lowres2-critic R4: the main-thread work is split into tasks (yieldTask between them), so a MIDI note arriving
  // meanwhile waits for one step, not for all of it (one ≈ 74 ms task per render before). maxStepMs = the longest.
  const steps = new StepClock();
  const t0 = performance.now();
  const off = new OfflineAudioContext({ numberOfChannels: 2, length: total, sampleRate: sr });
  if (o.waveSource) shareWaveCache(o.waveSource, off); // R4: the live context's PeriodicWaves (no rebuild per render)
  const sum = new GainNode(off, { gain: 1 });
  sum.connect(off.destination);
  const revIn = new GainNode(off, { gain: 1 });
  const rv = o.reverb;
  if (rv && rv.ir && rv.wet > 0 && rv.ir.sampleRate === sr) {
    const hpf = new BiquadFilterNode(off, { type: 'highpass', frequency: 180, Q: BUTTER2_Q });
    const lpf = new BiquadFilterNode(off, { type: 'lowpass', frequency: 9000, Q: BUTTER2_Q });
    const pdSec = Math.min(0.5, Math.max(0, Number(rv.predelay) || 0));
    const pd = new DelayNode(off, { maxDelayTime: 0.5, delayTime: pdSec });
    const conv = new ConvolverNode(off, { disableNormalization: true });
    conv.buffer = rv.ir; // AudioBuffers are not tied to a context; same sample rate as the live convolver
    const ret = new GainNode(off, { gain: rv.wet });
    revIn.connect(hpf).connect(lpf).connect(pd).connect(conv).connect(ret).connect(sum);
  }
  await steps.next();
  const { pc, minor } = o.key;
  const timer = new AudioTimer(off);
  const d = new o.DroneClass({
    ctx: off,
    registry: o.registry,
    rng: rngFor(o.seed, `drone-freeze|${pc}|${minor ? 1 : 0}`),
    timer,
    sum,
    reverbIn: revIn,
    warn: () => {},
  });
  d.setTrim(o.trimDb || 0);
  const p = o.params || {};
  const cfg = { gain: 1, brightness: p.brightness, movement: p.movement, width: p.width, fade: 0.05, chordFollow: false };
  d.configure(cfg, { when: 0 });
  d.setKey(pc, { minor, when: 0 });
  await steps.next();
  // the drone-osc instrument (its random-walk buffer, shared nodes) in a task of its own: setMode takes it from the
  // idle list. Same rng order as building it inside setMode (nothing draws from the drone's rng in between).
  if (typeof d._buildInst === 'function' && Array.isArray(d._idle) && !d._idle.length) d._idle.push(d._buildInst());
  await steps.next();
  d.setMode('synth', { when: 0 });
  const buildMs = performance.now() - t0;
  steps.pause();
  const rendered = await off.startRendering();
  steps.resume();
  const renderMs = performance.now() - t0;
  const tPost = performance.now();
  try {
    d.dispose();
    timer.dispose();
  } catch {}
  await steps.next();
  const loop = [];
  for (let i = 0; i < 2; i++) {
    loop.push(makeSeamlessLoop([rendered.getChannelData(i)], pre, loopLen, xf)[0]); // one channel per task
    await steps.next();
  }
  const buffer = new AudioBuffer({ numberOfChannels: 2, length: loopLen, sampleRate: sr });
  for (let i = 0; i < loop.length; i++) {
    buffer.copyToChannel(loop[i], i);
    await steps.next();
  }
  const seam = await seamCheckChunked([buffer.getChannelData(0), buffer.getChannelData(1)], steps);
  steps.end();
  const postMs = performance.now() - tPost;
  return {
    buffer, loopSec: loopLen / sr, renderSec: total / sr, renderMs, buildMs, postMs, maxStepMs: steps.max,
    stepMs: steps.laps, bytes: loopLen * 8, seam,
  };
}

/**
 * Yield to the event loop: a new task at the back of the queue (a MessageChannel turn), so a MIDI message or a key
 * event queued meanwhile runs first. Not scheduler.yield(): its continuation is queued AHEAD of other tasks of the
 * same priority, which is exactly what a note must not wait behind.
 * @returns {Promise<void>}
 */
export function yieldTask() {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}

/** Times the synchronous steps between yields (lowres2-critic R4): `max` = the longest one (ms). */
class StepClock {
  constructor() {
    this.max = 0;
    this.laps = [];
    this.t = performance.now();
  }
  _lap() {
    const now = performance.now();
    this.laps.push(Math.round((now - this.t) * 10) / 10);
    this.max = Math.max(this.max, now - this.t);
    this.t = now;
  }
  async next() {
    this._lap();
    await yieldTask();
    this.t = performance.now();
  }
  pause() {
    this._lap();
  }
  resume() {
    this.t = performance.now();
  }
  end() {
    this._lap();
    this.max = Math.round(this.max * 10) / 10;
  }
}

/** seamCheck in slices of SEAM_SLICE frames with a yield between them (lowres2-critic R4). */
const SEAM_SLICE = 1 << 18;
async function seamCheckChunked(chans, steps) {
  let seam = 0;
  let body = 0;
  for (const c of chans) {
    const n = c.length;
    if (n < 2) continue;
    seam = Math.max(seam, Math.abs(c[0] - c[n - 1]));
    for (let i0 = 1; i0 < n; i0 += SEAM_SLICE) {
      const i1 = Math.min(n, i0 + SEAM_SLICE);
      for (let i = i0; i < i1; i++) {
        const d = Math.abs(c[i] - c[i - 1]);
        if (d > body) body = d;
      }
      if (i1 < n) await steps.next();
    }
  }
  return { seamDelta: seam, bodyDelta: body, ok: seam <= body };
}
