#!/usr/bin/env node
// T03: single-node reference renders of WaveShaperNode from the golden Chromium (157.0.8103.78): curve lookup with
// clamped ends at oversample none / 2x / 4x (Chromium Up/DownSampler, latency 128 / 192 frames), mono and stereo
// inputs, the master clip curve (fx.js clipCurve), a lofi-style tanh curve and a quantiser. The native port
// (native/core/src/dsp/waveshaper.cpp + resampler_updown.cpp) replays every case through the same 128-frame quanta
// (native/core/tests/test_master_dsp.cpp).
//
//   node tools/golden/vectors/dump-waveshaper.mjs   -> tools/golden/vectors/data/waveshaper.txt
//
// Format:
//   case <name>
//   spec <json>
//   out <b64>          float32 LE output of channel 0
//   out1 <b64>|same|-  channel 1 (`same`: bit-identical to channel 0; `-`: mono node)
//   end
//
// Spec: sr, frames, ch (1|2), os ('none'|'2x'|'4x'), curve {kind, n, p}, amp, hz.
// Curves (double with Math.*, stored as float32):
//   clip:  x = ((i / (n - 1)) * 2 - 1) * 2; fx.js clipCurve with ceil 10^(-0.3/20), knee .5
//   tanh:  x = (i / (n - 1)) * 2 - 1; Math.tanh(p * x) / p
//   quant: x = (i / (n - 1)) * 2 - 1; Math.round(x * 2^(p-1)) / 2^(p-1)
//   list:  p (the values)
// Input sample i of channel c: amp * (i / frames) * (Math.sin(2 * Math.PI * hz * i / sr) + 0.3 * noise(i * 2 + c)).
import fs from 'node:fs';
import path from 'node:path';
import { openPage, DATA } from './lib.mjs';

const OUT = path.join(DATA, 'waveshaper.txt');
const CASES = [];
const add = (name, spec) => CASES.push({ name, spec });

for (const os of ['none', '2x', '4x']) {
  add(`clip-${os}`, { sr: 44100, frames: 8192, ch: 2, os, curve: { kind: 'clip', n: 16384 }, amp: 2.5, hz: 997 });
  add(`tanh-${os}`, { sr: 44100, frames: 8192, ch: 2, os, curve: { kind: 'tanh', n: 4096, p: 2.8 }, amp: 1.6,
    hz: 5003 });
}
add('quant-none', { sr: 44100, frames: 4096, ch: 2, os: 'none', curve: { kind: 'quant', n: 32768, p: 10 },
  amp: 1.2, hz: 441 });
add('quant-4x-mono', { sr: 44100, frames: 4096, ch: 1, os: '4x', curve: { kind: 'quant', n: 32768, p: 12 },
  amp: 1.2, hz: 441 });
add('list2-none', { sr: 44100, frames: 2048, ch: 1, os: 'none', curve: { kind: 'list', p: [-1, 1] }, amp: 3,
  hz: 300 });
add('list3-2x', { sr: 44100, frames: 2048, ch: 2, os: '2x', curve: { kind: 'list', p: [0.5, -1, 0.3] }, amp: 1.5,
  hz: 300 });
add('tanh-4x-48k', { sr: 48000, frames: 8192, ch: 2, os: '4x', curve: { kind: 'tanh', n: 4096, p: 5 }, amp: 1,
  hz: 12000 });

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
  const makeCurve = (cv) => {
    if (cv.kind === 'list') return new Float32Array(cv.p);
    const n = cv.n;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (cv.kind === 'clip') {
        const ceil = Math.pow(10, -0.3 / 20);
        const k = 0.5;
        const x = ((i / (n - 1)) * 2 - 1) * 2;
        const ax = Math.abs(x);
        const y = ax < k ? ax : k + (ceil - k) * Math.tanh((ax - k) / (ceil - k));
        c[i] = Math.sign(x) * y;
      } else {
        const x = (i / (n - 1)) * 2 - 1;
        c[i] = cv.kind === 'tanh' ? Math.tanh(cv.p * x) / cv.p : Math.round(x * 2 ** (cv.p - 1)) / 2 ** (cv.p - 1);
      }
    }
    return c;
  };
  const out = [];
  for (const { name, spec } of cases) {
    const ctx = new OfflineAudioContext(spec.ch, spec.frames, spec.sr);
    const buf = new AudioBuffer({ numberOfChannels: spec.ch, length: spec.frames, sampleRate: spec.sr });
    for (let c = 0; c < spec.ch; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < spec.frames; i++) {
        d[i] = spec.amp * (i / spec.frames) * (Math.sin(2 * Math.PI * spec.hz * i / spec.sr) + 0.3 * noise(i * 2 + c));
      }
    }
    const src = new AudioBufferSourceNode(ctx, { buffer: buf });
    const ws = new WaveShaperNode(ctx, { curve: makeCurve(spec.curve), oversample: spec.os });
    src.connect(ws).connect(ctx.destination);
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

const header = `# WaveShaperNode reference renders from Chromium ${version} (tools/golden/vectors/dump-waveshaper.mjs)`;
fs.writeFileSync(OUT, [header, ...results].join('\n') + '\n');
console.log(`wrote ${OUT}: ${CASES.length} cases`);
