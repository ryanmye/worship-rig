#!/usr/bin/env node
// T02: single-node reference renders of DelayNode from the golden Chromium (157.0.8103.78) for wa::DelayLine
// (native/core/src/dsp/delay_line.cpp, tests/test_strip_delay_line.cpp): constant delays (0, one frame, fractional,
// long), a-rate automation (linear and exponential ramps, setTarget), max delays that are not whole frames, and a
// 48 kHz case. Mono input (one kernel).
//
//   node tools/golden/vectors/dump-delay-line.mjs   -> tools/golden/vectors/data/delay-line.txt
//
// Format: as dump-biquad.mjs (case / spec / out / out1 '-' / end).
// Spec: sr, frames, max (maxDelayTime), delay (initial delayTime), auto ([method, ...args] on delayTime), amp.
// Input sample i: amp * (Math.sin(2*PI*431*i/sr) + 0.5 * noise(i*2)).
import fs from 'node:fs';
import path from 'node:path';
import { openPage, DATA } from './lib.mjs';

const OUT = path.join(DATA, 'delay-line.txt');
const CASES = [];
const add = (name, spec) => CASES.push({ name, spec: { sr: 44100, frames: 8192, amp: 0.4, max: 1, delay: 0,
  auto: [], ...spec } });

add('zero', { delay: 0 });
add('one-frame', { delay: 1 / 44100 });
add('fractional', { delay: 0.0123456 });
add('long', { delay: 0.15, frames: 16384 });
add('max-odd', { max: 0.0337, delay: 0.0337 });
add('ramp-linear', { delay: 0.01, auto: [['setValueAtTime', 0.01, 0.02], ['linearRampToValueAtTime', 0.08, 0.12]] });
add('ramp-exp', { delay: 0.05, auto: [['setValueAtTime', 0.05, 0.01], ['exponentialRampToValueAtTime', 0.002, 0.1]] });
add('target', { delay: 0.002, auto: [['setTargetAtTime', 0.03, 0.01, 0.02]] });
add('48k', { sr: 48000, delay: 0.00731, max: 0.5 });

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
    const ctx = new OfflineAudioContext(1, spec.frames, spec.sr);
    const buf = new AudioBuffer({ numberOfChannels: 1, length: spec.frames, sampleRate: spec.sr });
    const d = buf.getChannelData(0);
    for (let i = 0; i < spec.frames; i++) {
      d[i] = spec.amp * (Math.sin(2 * Math.PI * 431 * i / spec.sr) + 0.5 * noise(i * 2));
    }
    const src = new AudioBufferSourceNode(ctx, { buffer: buf });
    const dl = new DelayNode(ctx, { maxDelayTime: spec.max, delayTime: spec.delay });
    for (const [m, ...a] of spec.auto) dl.delayTime[m](...a);
    src.connect(dl).connect(ctx.destination);
    src.start(0);
    const r = await ctx.startRendering();
    out.push(`case ${name}`, `spec ${JSON.stringify(spec)}`, `out ${b64(r.getChannelData(0))}`, 'out1 -', 'end');
  }
  return out;
}, CASES);
await browser.close();
server.close();

const header = `# DelayNode reference renders from Chromium ${version} (tools/golden/vectors/dump-delay-line.mjs)`;
fs.writeFileSync(OUT, [header, ...results].join('\n') + '\n');
console.log(`wrote ${OUT}: ${CASES.length} cases`);
