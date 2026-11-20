#!/usr/bin/env node
// T02: single-node reference renders of StereoPannerNode from the golden Chromium (157.0.8103.78): the mono and the
// stereo equal-power laws (contract 3.1), constant pans (PanToTargetValue: float gains, Vsmul / Vsma) and automated
// pans (PanWithSampleAccurateValues: double gains per frame), incl. the clamp to [-1, 1] and the p <= 0 branch at 0.
// The native port (native/core/src/dsp/panner.cpp) replays every case (native/core/tests/test_panner.cpp, <= 1e-6;
// in practice bit-exact).
//
//   node tools/golden/vectors/dump-panner.mjs   -> tools/golden/vectors/data/panner.txt
//
// Format: as dump-biquad.mjs (case / spec / out / out1 / end; outputs are always 2 channels).
// Spec: sr, frames, ch (input channels 1|2), pan (initial value), auto ([method, ...args] calls on pan), amp.
// Input sample i of channel c: amp * (Math.sin(2*PI*hz_c*i/sr) + 0.5 * noise(i*2+c)), hz_0 = 431, hz_1 = 2711.
import fs from 'node:fs';
import path from 'node:path';
import { openPage, DATA } from './lib.mjs';

const OUT = path.join(DATA, 'panner.txt');
const CASES = [];
const add = (name, spec) => CASES.push({ name, spec: { sr: 44100, frames: 1024, amp: 0.4, auto: [], ...spec } });

for (const ch of [1, 2]) {
  for (const pan of [-1, -0.5, -1e-7, 0, 0.3, 0.5, 1, 1.5, -3]) add(`const-${ch}ch-${pan}`, { ch, pan });
  add(`ramp-${ch}ch`, { ch, pan: -1, frames: 4096, auto: [['setValueAtTime', -1, 0.005],
    ['linearRampToValueAtTime', 1, 0.08]] });
  add(`target-${ch}ch`, { ch, pan: -0.5, frames: 4096, auto: [['setTargetAtTime', 1, 0.01, 0.015],
    ['setValueAtTime', 1, 0.01 + 0.18], ['setTargetAtTime', 0.5, 0.06, 0.015]] });
  add(`overrange-ramp-${ch}ch`, { ch, pan: 0, frames: 2048, auto: [['linearRampToValueAtTime', 2, 0.04]] });
}

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
    const ctx = new OfflineAudioContext(2, spec.frames, spec.sr);
    const buf = new AudioBuffer({ numberOfChannels: spec.ch, length: spec.frames, sampleRate: spec.sr });
    for (let c = 0; c < spec.ch; c++) {
      const d = buf.getChannelData(c);
      const hz = c === 0 ? 431 : 2711;
      for (let i = 0; i < spec.frames; i++) {
        d[i] = spec.amp * (Math.sin(2 * Math.PI * hz * i / spec.sr) + 0.5 * noise(i * 2 + c));
      }
    }
    const src = new AudioBufferSourceNode(ctx, { buffer: buf });
    const p = new StereoPannerNode(ctx, { pan: Math.max(-1, Math.min(1, spec.pan)) });
    if (spec.pan < -1 || spec.pan > 1) p.pan.value = spec.pan;  // the attribute clamps to the nominal range
    for (const [m, ...a] of spec.auto) p.pan[m](...a);
    src.connect(p).connect(ctx.destination);
    src.start(0);
    const r = await ctx.startRendering();
    const c0 = r.getChannelData(0);
    const c1 = r.getChannelData(1);
    const o1 = c0.every((v, i) => Object.is(v, c1[i])) ? 'same' : b64(c1);
    out.push(`case ${name}`, `spec ${JSON.stringify(spec)}`, `out ${b64(c0)}`, `out1 ${o1}`, 'end');
  }
  return out;
}, CASES);
await browser.close();
server.close();

const header = `# StereoPannerNode reference renders from Chromium ${version} (tools/golden/vectors/dump-panner.mjs)`;
fs.writeFileSync(OUT, [header, ...results].join('\n') + '\n');
console.log(`wrote ${OUT}: ${CASES.length} cases`);
