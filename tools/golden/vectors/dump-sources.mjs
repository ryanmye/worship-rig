#!/usr/bin/env node
// T11a: single-node reference renders of the Web Audio source nodes from the golden Chromium: OscillatorNode (the four
// built-in types and custom PeriodicWaves at several frequencies, sample rates, detune / frequency automation, FM
// through the frequency param, sub-sample start, stop), AudioBufferSourceNode (playbackRate, detune, sub-sample start,
// offset / duration, loop points, k-rate automation, negative rates, buffer rate != context rate) and
// ConstantSourceNode (automated offset, start / stop inside a quantum). Each case renders one node into an
// OfflineAudioContext and stores the output as raw float32 (little endian, base64). The native ports
// (native/core/src/dsp/{oscillator,periodic_wave,buffer_source,constant_source}.cpp) replay the same spec through the
// same quanta and are compared sample by sample (tests/test_sources.cpp).
//
//   node tools/golden/vectors/dump-sources.mjs   -> tools/golden/vectors/data/sources.txt
//
// Format (the spec is the JSON the page interpreted, so the C++ test reads the same numbers):
//   case <name>
//   spec <json>
//   out <b64>       float32 LE samples [win0, win1) of every channel, channel after channel
//   ended <q|-1>    BufferSource only: first quantum boundary q (multiple of 128 frames) at which the main thread
//                   had already seen `onended` (-1: never within the render); informational
//   end
//
// Spec fields. Common: sr, frames, win:[from,to] (default the whole render), start (seconds), stop (seconds).
//   osc: type ('sine'|'square'|'sawtooth'|'triangle'|'custom'), wave {real, imag, dn} (custom), freq, detune,
//        fEv / dEv: [[op, value, time(, tau)]] with op set|lin|exp|target on frequency / detune,
//        fm {f, depth}: a sine of f Hz through a GainNode(depth) into frequency
//   buf: bufCh, bufLen, bufSr, bufSeed, rate, detune, rEv / dEv, loop [start, end] or null, offset, dur,
//        trackEnd (suspend at every quantum to find when `onended` was seen)
//   cs:  offset, ev: [[op, value, time(, tau)]]
//
// Buffer content (identical in the page and in C++, IEEE double arithmetic then float32):
//   x(i, c) = 0.7 * ((i % 64) / 64 - 0.5) * (c ? -1 : 1) + 0.2 * (noise(i * 2 + c, seed) / 8388608 - 1) * 0.5 ...
// see bufSample() below.
import fs from 'node:fs';
import path from 'node:path';
import { openPage, DATA } from './lib.mjs';

const OUT = path.join(DATA, 'sources.txt');

const PHI = 0.7;
const chorusWave = { real: [0, Math.sin(PHI)], imag: [0, Math.cos(PHI)], dn: true };
const cosWave = { real: [0, 1], imag: [0, 0], dn: true };
// nine drawbar harmonics (organ.js style): amplitudes of partials 1..9
const organReal = [0, 0.3, 0.1, 0.5, 0.2, 0, 0.15, 0, 0, 0.05];
const organImag = [0, 0.6, 0.4, 0.2, 0.1, 0.3, 0, 0.1, 0.05, 0.02];
const organWave = { real: organReal, imag: organImag, dn: true };
// 40 partials with 1/n rolloff (normalised path)
const richReal = [0];
const richImag = [0];
for (let n = 1; n <= 40; n++) {
  richReal.push(((n * 7) % 5 - 2) / (4 * n));
  richImag.push(((n * 3) % 7 - 3) / (3 * n));
}
const richWave = { real: richReal, imag: richImag, dn: false };

const CASES = [];
const add = (name, spec) => CASES.push({ name, spec });

// ---- oscillator: built-in types at 5 frequencies (one below 20 Hz) ----
const FREQS = [7.3, 110, 440, 3951.07, 12345];
for (const type of ['sine', 'square', 'sawtooth', 'triangle']) {
  for (const f of FREQS) add(`osc-${type}-${f}`, { k: 'osc', sr: 44100, frames: 4096, type, freq: f, start: 0 });
}
for (const type of ['square', 'sawtooth']) {
  for (const f of FREQS) add(`osc-${type}-48k-${f}`, { k: 'osc', sr: 48000, frames: 4096, type, freq: f, start: 0 });
}
for (const f of [2.5, 440, 9000]) add(`osc-sawtooth-96k-${f}`, { k: 'osc', sr: 96000, frames: 4096,
  type: 'sawtooth', freq: f, start: 0 });
for (const f of [13, 1000]) add(`osc-triangle-22k-${f}`, { k: 'osc', sr: 22050, frames: 4096,
  type: 'triangle', freq: f, start: 0 });
for (const f of [0.1, 0.5, 1.7, 3.2, 12]) add(`osc-sine-lowfreq-${f}`, { k: 'osc', sr: 44100, frames: 4096,
  type: 'sine', freq: f, start: 0 });

// ---- oscillator: custom PeriodicWaves ----
for (const f of [0.4, 7.3, 110, 440, 5000]) {
  add(`osc-chorus-wave-${f}`, { k: 'osc', sr: 44100, frames: 4096,
  type: 'custom', wave: chorusWave, freq: f, start: 0 });
}
for (const f of [0.35, 5, 130.81, 1046.5, 6000]) {
  add(`osc-organ-wave-${f}`, { k: 'osc', sr: 48000, frames: 4096, type: 'custom', wave: organWave, freq: f, start: 0 });
}
for (const f of [3, 82.4, 440, 2093]) {
  add(`osc-rich-normalized-${f}`, { k: 'osc', sr: 44100, frames: 4096,
  type: 'custom', wave: richWave, freq: f, start: 0 });
}
add('osc-cos-wave-5', { k: 'osc', sr: 44100, frames: 4096, type: 'custom', wave: cosWave, freq: 5, start: 0 });
add('osc-rich-96k-220', { k: 'osc', sr: 96000, frames: 4096, type: 'custom', wave: richWave, freq: 220, start: 0 });

// ---- oscillator: params, scheduling ----
add('osc-detune-700', { k: 'osc', sr: 44100, frames: 4096, type: 'sawtooth', freq: 220, detune: 700, start: 0 });
add('osc-detune-neg1200', { k: 'osc', sr: 44100, frames: 4096, type: 'square', freq: 880, detune: -1200, start: 0 });
add('osc-freq-negative', { k: 'osc', sr: 44100, frames: 4096, type: 'sawtooth', freq: -330, start: 0 });
add('osc-freq-negative-low', { k: 'osc', sr: 44100, frames: 4096, type: 'triangle', freq: -2.1, start: 0 });
add('osc-freq-above-nyquist', { k: 'osc', sr: 44100, frames: 4096, type: 'sine', freq: 30000, start: 0 });
add('osc-freq-ramp', { k: 'osc', sr: 44100, frames: 4096, type: 'sawtooth', freq: 100, start: 0,
  fEv: [['set', 100, 0], ['lin', 2000, 0.05]] });
add('osc-freq-exp-ramp-sine', { k: 'osc', sr: 44100, frames: 4096, type: 'sine', freq: 50, start: 0,
  fEv: [['set', 50, 0], ['exp', 3000, 0.07]] });
add('osc-freq-target', { k: 'osc', sr: 48000, frames: 4096, type: 'square', freq: 300, start: 0,
  fEv: [['target', 1500, 0.01, 0.02]] });
add('osc-freq-ramp-through-low', { k: 'osc', sr: 44100, frames: 4096, type: 'sine', freq: 40, start: 0,
  fEv: [['set', 40, 0], ['lin', 0.5, 0.03], ['lin', 8, 0.08]] });
add('osc-detune-ramp', { k: 'osc', sr: 44100, frames: 4096, type: 'sawtooth', freq: 330, start: 0,
  dEv: [['set', 0, 0], ['lin', 1200, 0.06]] });
add('osc-freq-and-detune-ramps', { k: 'osc', sr: 44100, frames: 4096, type: 'triangle', freq: 200, start: 0,
  fEv: [['set', 200, 0], ['lin', 900, 0.05]], dEv: [['set', -100, 0], ['lin', 300, 0.05]] });
add('osc-start-subsample', { k: 'osc', sr: 44100, frames: 4096, type: 'sine', freq: 440, start: 0.0123456 });
add('osc-start-subsample-saw', { k: 'osc', sr: 48000, frames: 4096, type: 'sawtooth', freq: 1234.5, start: 0.00789 });
add('osc-start-subsample-low', { k: 'osc', sr: 44100, frames: 4096, type: 'triangle', freq: 7.3, start: 0.0123456 });
add('osc-start-subsample-ramp', { k: 'osc', sr: 44100, frames: 4096, type: 'sawtooth', freq: 100, start: 0.00321,
  fEv: [['set', 100, 0], ['lin', 1500, 0.06]] });
add('osc-start-subsample-detune-ramp', { k: 'osc', sr: 44100, frames: 4096, type: 'sine', freq: 300, start: 0.00321,
  dEv: [['set', 0, 0], ['lin', 1200, 0.06]] });
add('osc-start-stop', { k: 'osc', sr: 44100, frames: 4096, type: 'square', freq: 523.25, start: 0.0101, stop: 0.0502 });
add('osc-stop-exact-quantum', { k: 'osc', sr: 44100, frames: 4096, type: 'sine', freq: 440, start: 0,
  stop: 256 / 44100 });
add('osc-fm', { k: 'osc', sr: 44100, frames: 4096, type: 'sine', freq: 440, start: 0, fm: { f: 110, depth: 200 } });
add('osc-fm-custom-48k', { k: 'osc', sr: 48000, frames: 4096, type: 'custom', wave: organWave, freq: 220, start: 0.0021,
  fm: { f: 5, depth: 30 } });
add('osc-long-sine-phase', { k: 'osc', sr: 44100, frames: 220500, type: 'sine', freq: 440.123, start: 0,
  win: [218000, 220048] });
add('osc-long-saw-lowfreq', { k: 'osc', sr: 48000, frames: 480000, type: 'sawtooth', freq: 7.37, start: 0,
  win: [477000, 479048] });

// ---- buffer source ----
const B = { bufCh: 1, bufLen: 3000, bufSeed: 1 };
const S = { bufCh: 2, bufLen: 3000, bufSeed: 5 };
const bs = (name, extra) => add(name, { k: 'buf', sr: 44100, frames: 4096, rate: 1, detune: 0, ...B, ...extra });
bs('buf-rate-1-mono', { start: 0 });
bs('buf-rate-1-stereo', { ...S, start: 0 });
for (const r of [0.5, 1.5, 2.03]) bs(`buf-rate-${r}`, { start: 0, rate: r });
bs('buf-rate-2.03-stereo', { ...S, start: 0, rate: 2.03 });
bs('buf-rate-0.7937-stereo', { ...S, start: 0, rate: 0.7937005259840998 });
bs('buf-rate-1-start-subsample', { start: 0.00123456 });
bs('buf-rate-1.5-start-subsample', { start: 0.00789, rate: 1.5 });
bs('buf-offset-rate-1', { start: 0.01, offset: 0.0123456 });
bs('buf-offset-rate-1.3', { start: 0.01, offset: 0.0123456, rate: 1.3 });
bs('buf-offset-beyond-end', { start: 0.01, offset: 1.5 });
bs('buf-detune-700', { start: 0, detune: 700 });
bs('buf-detune-neg-1200-rate-1.5', { start: 0, detune: -1200, rate: 1.5 });
bs('buf-loop-whole-rate-1', { start: 0, loop: [0, 0] });
bs('buf-loop-whole-rate-0.7', { start: 0, loop: [0, 0], rate: 0.7 });
bs('buf-loop-whole-rate-1.37-stereo', { ...S, start: 0, loop: [0, 0], rate: 1.37 });
bs('buf-loop-points-rate-1', { start: 0, loop: [0.01, 0.037] });
bs('buf-loop-points-integer-rate-1', { start: 0, loop: [500 / 44100, 1500 / 44100] });
bs('buf-loop-points-rate-1.37-stereo', { ...S, start: 0, loop: [0.012, 0.041], rate: 1.37 });
bs('buf-loop-points-rate-0.3', { start: 0, loop: [0.02, 0.05], rate: 0.3 });
bs('buf-loop-start-only', { start: 0, loop: [0.02, 0] });
bs('buf-loop-invalid-points', { start: 0, loop: [0.05, 0.02] });
bs('buf-loop-end-beyond', { start: 0, loop: [0.01, 5] });
bs('buf-loop-start-subsample', { start: 0.00789, loop: [0.005, 0.04], rate: 0.9 });
bs('buf-loop-offset', { start: 0.003, offset: 0.05, loop: [0.01, 0.06], rate: 1 });
bs('buf-loop-too-fast', { start: 0, loop: [0.001, 0.0011], rate: 5 });
bs('buf-duration', { start: 0.005, offset: 0.01, dur: 0.02 });
bs('buf-duration-rate-0.5', { start: 0.0031, offset: 0.002, dur: 0.02, rate: 0.5 });
bs('buf-duration-loop', { start: 0, offset: 0.004, dur: 0.12, loop: [0.01, 0.03], rate: 1.1 });
bs('buf-stop-mid', { start: 0, stop: 0.0301 });
bs('buf-stop-mid-loop', { start: 0, stop: 0.0301, loop: [0, 0], rate: 1.2 });
bs('buf-rate-ramp-krate', { start: 0, loop: [0, 0], rEv: [['set', 1, 0], ['lin', 2, 0.05]] });
bs('buf-rate-target-krate', { start: 0, rEv: [['target', 0.5, 0.01, 0.01]] });
bs('buf-detune-ramp-krate', { start: 0, loop: [0, 0], dEv: [['set', 0, 0], ['lin', 1200, 0.06]] });
bs('buf-rate-fast-clamp', { start: 0, rate: 2000 });
bs('buf-rate-zero', { start: 0, offset: 0.01, rate: 0, frames: 1024 });
bs('buf-rate-negative-1', { start: 0, offset: 0.05, rate: -1 });
bs('buf-rate-negative-0.7-loop', { start: 0, offset: 0.05, rate: -0.7, loop: [0.01, 0.06] });
bs('buf-rate-negative-1.3-stereo', { ...S, start: 0.0021, offset: 0.06, rate: -1.3 });
bs('buf-bufrate-22050', { start: 0, bufSr: 22050 });
bs('buf-bufrate-22050-loop', { start: 0, bufSr: 22050, loop: [0.01, 0.06], rate: 1.5 });
bs('buf-bufrate-48000-in-44100', { start: 0, bufSr: 48000 });
bs('buf-sr-48000-rate-1.5', { sr: 48000, start: 0.003, rate: 1.5 });
bs('buf-short-loop-click', { start: 0, bufLen: 700, bufSeed: 9, loop: [0, 0], rate: 1.01 });
bs('buf-ended-nonloop', { start: 0.001, frames: 8192, trackEnd: true });
bs('buf-ended-stop', { start: 0, stop: 0.0301, loop: [0, 0], frames: 8192, trackEnd: true });
bs('buf-ended-exact-boundary', { start: 0, bufLen: 512, frames: 2048, trackEnd: true });
bs('buf-ended-rate-2', { start: 0, rate: 2, frames: 4096, trackEnd: true });

// ---- constant source ----
const cs = (name, extra) => add(name, { k: 'cs', sr: 44100, frames: 4096, offset: 1, start: 0, ...extra });
cs('cs-constant', { offset: 0.5 });
cs('cs-zero', { offset: 0 });
cs('cs-ramp', { offset: 0, ev: [['set', 0, 0.002], ['lin', 1, 0.05]] });
cs('cs-exp-ramp', { offset: 0.01, ev: [['set', 0.01, 0], ['exp', 2, 0.06]] });
cs('cs-target', { offset: 1, ev: [['target', 0.2, 0.01, 0.015]] });
cs('cs-steps', { offset: 0.1, ev: [['set', 0.1, 0], ['set', 0.7, 0.0123], ['set', -0.3, 0.0456]] });
cs('cs-start-mid-quantum', { offset: 0.8, start: 0.00789 });
cs('cs-start-stop', { offset: 0.8, start: 0.00789, stop: 0.0404 });
cs('cs-ramp-start-stop', { offset: 0, start: 0.0041, stop: 0.052, ev: [['set', 0, 0], ['lin', 5, 0.06]] });
cs('cs-48k-ramp', { sr: 48000, offset: 0.25, ev: [['set', 0.25, 0.001], ['lin', 0.9, 0.04]] });

const { browser, page, server, version } = await openPage();
const results = await page.evaluate(async (cases) => {
  const f32 = new Float32Array(1);
  const noise = (v, seed) => {
    let h = Math.imul((v ^ seed) + 0x7f4a7c15, 0x9e3779b1) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    return (h >>> 8) / 8388608 - 1; // exact in float32, in [-1, 1)
  };
  const bufSample = (i, c, seed) => {
    const saw = (i % 64) / 64 - 0.5;
    return (c ? -0.7 : 0.7) * saw + 0.2 * noise(i * 2 + c, seed);
  };
  const applyEv = (param, evs) => {
    for (const [op, v, t, tc] of evs || []) {
      if (op === 'set') param.setValueAtTime(v, t);
      else if (op === 'lin') param.linearRampToValueAtTime(v, t);
      else if (op === 'exp') param.exponentialRampToValueAtTime(v, t);
      else if (op === 'target') param.setTargetAtTime(v, t, tc);
    }
  };
  const b64 = (arr) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const out = [];
  for (const { name, spec } of cases) {
    const chans = spec.k === 'buf' ? spec.bufCh : 1;
    const ctx = new OfflineAudioContext(chans, spec.frames, spec.sr);
    let node;
    let endedSeen = false;
    if (spec.k === 'osc') {
      const opts = { frequency: spec.freq, detune: spec.detune || 0 };
      if (spec.type === 'custom') {
        opts.periodicWave = new PeriodicWave(ctx, {
          real: new Float32Array(spec.wave.real), imag: new Float32Array(spec.wave.imag),
          disableNormalization: spec.wave.dn });
      } else {
        opts.type = spec.type;
      }
      node = new OscillatorNode(ctx, opts);
      applyEv(node.frequency, spec.fEv);
      applyEv(node.detune, spec.dEv);
      if (spec.fm) {
        const mod = new OscillatorNode(ctx, { frequency: spec.fm.f });
        const g = new GainNode(ctx, { gain: spec.fm.depth });
        mod.connect(g);
        g.connect(node.frequency);
        mod.start(0);
      }
      node.start(spec.start);
      if (spec.stop !== undefined) node.stop(spec.stop);
    } else if (spec.k === 'buf') {
      const bsr = spec.bufSr || spec.sr;
      const buffer = ctx.createBuffer(spec.bufCh, spec.bufLen, bsr);
      for (let c = 0; c < spec.bufCh; c++) {
        const d = buffer.getChannelData(c);
        for (let i = 0; i < spec.bufLen; i++) d[i] = bufSample(i, c, spec.bufSeed);
      }
      node = new AudioBufferSourceNode(ctx, { buffer, playbackRate: spec.rate, detune: spec.detune });
      if (spec.loop) {
        node.loop = true;
        node.loopStart = spec.loop[0];
        node.loopEnd = spec.loop[1];
      }
      applyEv(node.playbackRate, spec.rEv);
      applyEv(node.detune, spec.dEv);
      node.onended = () => {
        endedSeen = true;
      };
      if (spec.dur !== undefined) node.start(spec.start, spec.offset || 0, spec.dur);
      else if (spec.offset !== undefined) node.start(spec.start, spec.offset);
      else node.start(spec.start);
      if (spec.stop !== undefined) node.stop(spec.stop);
    } else {
      node = new ConstantSourceNode(ctx, { offset: spec.offset });
      applyEv(node.offset, spec.ev);
      node.start(spec.start);
      if (spec.stop !== undefined) node.stop(spec.stop);
    }
    node.connect(ctx.destination);
    let endedAt = -1;
    if (spec.trackEnd) {
      for (let q = 1; q * 128 < spec.frames; q++) {
        ctx.suspend((q * 128) / spec.sr).then(() => {
          if (endedSeen && endedAt < 0) endedAt = q;
          ctx.resume();
        });
      }
    }
    const buf = await ctx.startRendering();
    const [w0, w1] = spec.win || [0, spec.frames];
    const parts = [];
    for (let c = 0; c < chans; c++) parts.push(buf.getChannelData(c).slice(w0, w1));
    const all = new Float32Array(parts.length * (w1 - w0));
    parts.forEach((p, i) => all.set(p, i * (w1 - w0)));
    out.push(`case ${name}`, `spec ${JSON.stringify(spec)}`, `out ${b64(all)}`);
    if (spec.trackEnd) out.push(`ended ${endedAt}`);
    out.push('end');
  }
  return out;
}, CASES);
await browser.close();
server.close();
fs.mkdirSync(DATA, { recursive: true });
const header = `# Source-node reference renders from Chromium ${version} (tools/golden/vectors/dump-sources.mjs)`;
fs.writeFileSync(OUT, [header, ...results].join('\n') + '\n');
console.log(`wrote ${OUT}: ${CASES.length} cases, ${fs.statSync(OUT).size} bytes`);
