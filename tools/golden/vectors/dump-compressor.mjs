#!/usr/bin/env node
// T03: single-node reference renders of DynamicsCompressorNode from the golden Chromium (157.0.8103.78), plus the two
// measurements the JS engine takes once per page at start (app/js/engine/fx.js measureCompMakeup, measureGlueRef).
// The native port (native/core/src/dsp/compressor.cpp) replays every case through the same 128-frame quanta and is
// compared sample by sample (native/core/tests/test_master_dsp.cpp); the measured makeup and glue table are compared
// with the native re-measurement (native/core/src/mix/master_chain_tables.cpp).
//
//   node tools/golden/vectors/dump-compressor.mjs   -> tools/golden/vectors/data/compressor.txt
//
// Format:
//   makeup <hex64>          measureCompMakeup() (linear)
//   glueref <hex64> x 11    measureGlueRef() (dB at amount k/10)
//   case <name>
//   spec <json>
//   out <b64>               float32 LE output of channel 0 (the node always outputs 2 channels)
//   out1 <b64>|same         channel 1 (`same`: bit-identical to channel 0, not stored)
//   end
//
// Spec: sr, frames, ch (input channels 1|2), node {threshold, knee, ratio, attack, release}, ev (threshold / ratio
// automation [[param, op, value, time(, tau)]] with op set|target), sig {kind 'sine'|'noise', hz, seg, levels[], r}.
// Input sample i of channel c (computed in double with Math.*, then float32; the C++ test repeats it with rig::js):
//   a = Math.pow(10, levels[min(floor(i / round(seg * sr)), n - 1)] / 20)
//   sine:  a * Math.sin(2 * Math.PI * hz * i / sr) * (c ? r : 1)
//   noise: a * noise(i * 2 + c) * (c ? r : 1)        (noise: integer hash below, exact in float32)
import fs from 'node:fs';
import path from 'node:path';
import { openPage, DATA, hex64 } from './lib.mjs';

const OUT = path.join(DATA, 'compressor.txt');

const CATCHER = { threshold: -3, knee: 3, ratio: 12, attack: 0.003, release: 0.25 };
const glue = (a) => ({ threshold: -24 * a, knee: 6, ratio: 1 + 3 * a, attack: 0.01, release: 0.25 });
const STEPS = [-40, -12, -3, -1, 0, 2, -6, -30];
const CASES = [];
const add = (name, spec) => CASES.push({ name, spec });

add('catcher-steps', { sr: 44100, frames: 52920, ch: 2, node: CATCHER,
  sig: { kind: 'sine', hz: 1000, seg: 0.15, levels: STEPS, r: 1 } });
add('catcher-steps-mono', { sr: 44100, frames: 52920, ch: 1, node: CATCHER,
  sig: { kind: 'sine', hz: 1000, seg: 0.15, levels: STEPS, r: 1 } });
add('catcher-noise-48k', { sr: 48000, frames: 48000, ch: 2, node: CATCHER,
  sig: { kind: 'noise', seg: 0.2, levels: [-20, 0, 6, -10, -40], r: 0.4 } });
for (const a of [0.1, 0.5, 1]) {
  add(`glue-${a}-steps`, { sr: 44100, frames: 52920, ch: 2, node: glue(a),
    sig: { kind: 'sine', hz: 1000, seg: 0.15, levels: STEPS, r: 0.6 } });
}
add('glue-1-noise', { sr: 44100, frames: 44100, ch: 2, node: glue(1),
  sig: { kind: 'noise', seg: 0.1, levels: [-30, -6, -18, 0, -24, -3, -12, -40, -2, -9], r: 1 } });
add('default-noise', { sr: 44100, frames: 44100, ch: 2,
  node: { threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25 },
  sig: { kind: 'noise', seg: 0.25, levels: [-30, -6, -50, -12], r: 0.8 } });
add('fast-slow', { sr: 44100, frames: 44100, ch: 2,
  node: { threshold: -20, knee: 0, ratio: 20, attack: 0, release: 1 },
  sig: { kind: 'sine', hz: 220, seg: 0.1, levels: [-6, -40, 0, -30, -3, -60, -10, -1, -50, -20], r: 1 } });
// fx.comp.amount changes while engaged: rampTo (setTarget tau 15 ms + pin at 12 tau) of threshold and ratio, k-rate
add('glue-automated', { sr: 44100, frames: 44100, ch: 2, node: glue(0.3),
  ev: [['threshold', 'target', -24, 0.3, 0.015], ['threshold', 'set', -24, 0.48],
    ['ratio', 'target', 4, 0.3, 0.015], ['ratio', 'set', 4, 0.48],
    ['threshold', 'target', -6, 0.7, 0.015], ['ratio', 'target', 1.5, 0.7, 0.015]],
  sig: { kind: 'sine', hz: 1000, seg: 0.25, levels: [-10, -10, -3, -20], r: 1 } });

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
    const s = spec.sig;
    const segN = Math.round(s.seg * spec.sr);
    for (let c = 0; c < spec.ch; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < spec.frames; i++) {
        const a = Math.pow(10, s.levels[Math.min(Math.floor(i / segN), s.levels.length - 1)] / 20);
        const v = s.kind === 'sine' ? a * Math.sin(2 * Math.PI * s.hz * i / spec.sr) : a * noise(i * 2 + c);
        d[i] = v * (c ? s.r : 1);
      }
    }
    const src = new AudioBufferSourceNode(ctx, { buffer: buf });
    const comp = new DynamicsCompressorNode(ctx, spec.node);
    for (const [p, op, v, t, tc] of spec.ev || []) {
      if (op === 'set') comp[p].setValueAtTime(v, t);
      else comp[p].setTargetAtTime(v, t, tc);
    }
    src.connect(comp).connect(ctx.destination);
    src.start(0);
    const r = await ctx.startRendering();
    const c0 = r.getChannelData(0), c1 = r.getChannelData(1);
    const same = c0.every((v, i) => Object.is(v, c1[i]));
    out.push(`case ${name}`, `spec ${JSON.stringify(spec)}`, `out ${b64(c0)}`,
      `out1 ${same ? 'same' : b64(c1)}`, 'end');
  }
  const fx = await import('/js/engine/fx.js');
  const makeup = await fx.measureCompMakeup();
  const table = await fx.measureGlueRef();
  return { lines: out, makeup, table };
}, CASES);
await browser.close();
server.close();

const header =
  `# DynamicsCompressorNode reference renders from Chromium ${version} (tools/golden/vectors/dump-compressor.mjs)`;
const lines = [header, `makeup ${hex64(results.makeup)}`, `glueref ${results.table.map(hex64).join(' ')}`,
  ...results.lines];
fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`wrote ${OUT}: ${CASES.length} cases, makeup ${results.makeup}, glue table ${results.table.join(' ')}`);
