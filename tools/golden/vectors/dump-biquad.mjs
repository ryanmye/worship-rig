#!/usr/bin/env node
// T02: single-node reference renders of BiquadFilterNode from the golden Chromium (157.0.8103.78): every type at
// low / mid / high frequencies (incl. 0 Hz and >= Nyquist edges), Q in dB for lowpass / highpass, gains for shelves
// and peaking, mono and stereo inputs, constant params, k-rate automation (the slot EQ) and a-rate automation (the
// master EQ, per-frame coefficients), and a type change mid-render (kernel reset). The native port
// (native/core/src/dsp/biquad.cpp) replays every case through the same 128-frame quanta
// (native/core/tests/test_biquad.cpp).
//
//   node tools/golden/vectors/dump-biquad.mjs   -> tools/golden/vectors/data/biquad.txt
//
// Format:
//   case <name>
//   spec <json>
//   out <b64>          float32 LE output of channel 0
//   out1 <b64>|same|-  channel 1 (`same`: bit-identical to channel 0; `-`: mono)
//   end
//
// Spec: sr, frames, ch (1|2), type, f, q, g (initial param values), rate ('a-rate'|'k-rate'), auto (list of
// [param, method, ...args] AudioParam calls made before rendering), retype ([frame, type]: node.type set from a
// suspend at that frame), amp. Input sample i of channel c: amp * (Math.sin(2*PI*hz_c*i/sr) + 0.5 * noise(i*2+c)),
// hz_0 = 431, hz_1 = 2711 (noise = the integer hash below, in [-1, 1)).
import fs from 'node:fs';
import path from 'node:path';
import { openPage, DATA } from './lib.mjs';

const OUT = path.join(DATA, 'biquad.txt');
const CASES = [];
const add = (name, spec) => CASES.push({ name, spec: { sr: 44100, frames: 2048, ch: 1, rate: 'a-rate', amp: 0.4,
  auto: [], ...spec } });
const BUTTER = 20 * Math.log10(Math.SQRT1_2);

for (const f of [0, 20, 150, 1000, 6000, 19000, 22050, 30000]) {
  add(`lowpass-${f}`, { type: 'lowpass', f, q: BUTTER, g: 0 });
  add(`highpass-${f}`, { type: 'highpass', f, q: BUTTER, g: 0 });
}
add('lowpass-res12', { type: 'lowpass', f: 2000, q: 12, g: 0 });
add('highpass-qneg', { type: 'highpass', f: 300, q: -6, g: 0 });
for (const f of [0, 60, 120, 1000, 6000, 22050]) {
  for (const g of [-9, 0, 6]) {
    add(`lowshelf-${f}-${g}`, { type: 'lowshelf', f, q: 1, g });
    add(`highshelf-${f}-${g}`, { type: 'highshelf', f, q: 1, g });
  }
}
for (const [f, q, g] of [[600, 2, 9], [3000, 1.5, -7], [80, 0.3, 4], [1000, 0, 6], [12000, 10, -15], [0, 1, 6]]) {
  add(`peaking-${f}-${q}-${g}`, { type: 'peaking', f, q, g });
}
for (const [f, q] of [[600, 2], [60, 10], [1500, 0], [0, 1]]) add(`notch-${f}-${q}`, { type: 'notch', f, q, g: 0 });
for (const [f, q] of [[600, 2], [5000, 0.5], [1500, 0]]) add(`bandpass-${f}-${q}`, { type: 'bandpass', f, q, g: 0 });
for (const [f, q] of [[600, 2], [5000, 0.5], [1500, 0]]) add(`allpass-${f}-${q}`, { type: 'allpass', f, q, g: 0 });
add('stereo-peaking', { type: 'peaking', f: 900, q: 4, g: 3, ch: 2 });
add('stereo-lowpass', { type: 'lowpass', f: 1200, q: 3, g: 0, ch: 2 });
add('stereo-48k-highshelf', { type: 'highshelf', f: 8000, q: 1, g: 3, ch: 2, sr: 48000 });
// automation: k-rate (slot EQ nodes) and a-rate (master EQ: per-frame coefficients while the gain moves)
const glide = [['frequency', 'setValueAtTime', 600, 0.01], ['frequency', 'exponentialRampToValueAtTime', 1500,
  0.025], ['gain', 'setTargetAtTime', -6, 0.012, 0.015], ['gain', 'setValueAtTime', -6, 0.012 + 0.18],
['Q', 'linearRampToValueAtTime', 4, 0.03]];
add('krate-peaking-auto', { type: 'peaking', f: 600, q: 2, g: 9, rate: 'k-rate', auto: glide, frames: 4096 });
add('arate-peaking-auto', { type: 'peaking', f: 600, q: 2, g: 9, rate: 'a-rate', auto: glide, frames: 4096 });
add('arate-lowshelf-gain', { type: 'lowshelf', f: 100, q: 1, g: 0, ch: 2, frames: 4096,
  auto: [['gain', 'setTargetAtTime', 6, 0.02, 0.015], ['gain', 'setValueAtTime', 6, 0.02 + 0.18]] });
add('arate-highcut-freq', { type: 'lowpass', f: 6000, q: 0, g: 0, frames: 4096,
  auto: [['frequency', 'setValueAtTime', 6000, 0.01], ['frequency', 'exponentialRampToValueAtTime', 500, 0.05]] });
add('krate-retype', { type: 'peaking', f: 1500, q: 2, g: 0, rate: 'k-rate', retype: [1280, 'highshelf'],
  frames: 4096 });

const { browser, page, server, version } = await openPage();
const results = await page.evaluate(async (cases) => {
  const noise = (v) => {
    let h = Math.imul((v ^ 99) + 0x7f4a7c15, 0x9e3779b1) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    return (h >>> 8) / 8388608 - 1;
  };
  const b64 = (arr) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const out = [];
  for (const { name, spec } of cases) {
    const ctx = new OfflineAudioContext(spec.ch, spec.frames, spec.sr);
    const buf = new AudioBuffer({ numberOfChannels: spec.ch, length: spec.frames, sampleRate: spec.sr });
    for (let c = 0; c < spec.ch; c++) {
      const d = buf.getChannelData(c);
      const hz = c === 0 ? 431 : 2711;
      for (let i = 0; i < spec.frames; i++) {
        d[i] = spec.amp * (Math.sin(2 * Math.PI * hz * i / spec.sr) + 0.5 * noise(i * 2 + c));
      }
    }
    const src = new AudioBufferSourceNode(ctx, { buffer: buf });
    const bq = new BiquadFilterNode(ctx, { type: spec.type, frequency: spec.f, Q: spec.q, gain: spec.g });
    for (const p of [bq.frequency, bq.Q, bq.gain, bq.detune]) p.automationRate = spec.rate;
    for (const [p, m, ...a] of spec.auto) bq[p][m](...a);
    if (spec.retype) {
      ctx.suspend(spec.retype[0] / spec.sr).then(() => {
        bq.type = spec.retype[1];
        ctx.resume();
      });
    }
    src.connect(bq).connect(ctx.destination);
    src.start(0);
    const r = await ctx.startRendering();
    const c0 = r.getChannelData(0);
    let o1 = '-';
    if (spec.ch === 2) {
      const c1 = r.getChannelData(1);
      o1 = c0.every((v, i) => Object.is(v, c1[i])) ? 'same' : b64(c1);
    }
    out.push(`case ${name}`, `spec ${JSON.stringify(spec)}`, `out ${b64(c0)}`, `out1 ${o1}`, 'end');
  }
  return out;
}, CASES);
await browser.close();
server.close();

const header = `# BiquadFilterNode reference renders from Chromium ${version} (tools/golden/vectors/dump-biquad.mjs)`;
fs.writeFileSync(OUT, [header, ...results].join('\n') + '\n');
console.log(`wrote ${OUT}: ${CASES.length} cases`);
