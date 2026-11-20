#!/usr/bin/env node
// T01: AudioParam timeline reference curves from the golden Chromium. Each case drives ConstantSourceNode.offset in
// an OfflineAudioContext with the app's own helpers (app/js/shared/automation.js, app/js/engine/fx.js) or raw
// AudioParam calls, renders it, and stores every output sample as an exact float32 bit pattern. The native port
// (native/core/src/time/param.cpp + automation.h) replays the same calls at the same frames and must match sample by
// sample (tests/time_automation_test.cpp).
//
//   node tools/golden/vectors/dump-automation.mjs   → tools/golden/vectors/data/automation.txt
//
// Format:
//   case <name> sr <rate> frames <n> rate <a|k> init <offset> window <from> <to>
//   call <frame> <op> <args...> [!throw]      op run when the context is at <frame> (0 = before rendering; others
//                                              via suspend(frame/sr), multiples of 128); args are JS String(n),
//                                              'nan' = none
//   out <b64>                                  samples [from, to) as float32 bit patterns b[i]: d1 = b[i] - b[i-1],
//                                              d2 = d1[i] - d1[i-1] (int32, mod 2^32; b and d1 are 0 before the
//                                              first sample); LEB128 varints of 2·zigzag(d2) for d2 ≠ 0 and of
//                                              2·run + 1 for a run of d2 = 0; base64 (RFC 4648, padded)
//   end
import fs from 'node:fs';
import path from 'node:path';
import { openPage, DATA } from './lib.mjs';

const OUT = path.join(DATA, 'automation.txt');
const N = NaN;

// [name, sr, frames, rate, init, calls[[frame, op, ...args]], window?]
const CASES = [
  ['set-steps', 44100, 8192, 'a', 0, [[0, 'set', 0.5, 0.01], [0, 'set', 1, 0.0123456], [0, 'set', -2, 0.1],
    [0, 'set', 3, 0.1]]],
  ['set-same-time-order', 48000, 2048, 'a', 0, [[0, 'set', 0.25, 0.01], [0, 'target', 1, 0.01, 0.005],
    [0, 'set', 0.75, 0.02]]],
  ['linear-basic', 44100, 8192, 'a', 0, [[0, 'set', 0, 0], [0, 'lin', 1, 0.1]]],
  ['linear-basic-k', 44100, 8192, 'k', 0, [[0, 'set', 0, 0], [0, 'lin', 1, 0.1]]],
  ['linear-offgrid', 48000, 8192, 'a', 0.3, [[0, 'set', 0.3, 0.00123], [0, 'lin', -0.7, 0.0777], [0, 'lin', 2, 0.1]]],
  ['linear-implicit-start', 44100, 4096, 'a', 0.6, [[0, 'lin', 1, 0.05]]],
  ['exp-up', 44100, 16384, 'a', 0, [[0, 'set', 0.001, 0], [0, 'exp', 1, 0.2]]],
  ['exp-down', 48000, 16384, 'a', 0, [[0, 'set', 1, 0.01], [0, 'exp', 0.0001, 0.3]]],
  ['exp-down-k', 48000, 16384, 'k', 0, [[0, 'set', 1, 0.01], [0, 'exp', 0.0001, 0.3]]],
  ['exp-invalid-sign', 44100, 2048, 'a', 0, [[0, 'set', -1, 0], [0, 'exp', 1, 0.02]]],
  ['target-basic', 44100, 8192, 'a', 1, [[0, 'target', 0, 0.01, 0.05]]],
  ['target-converge', 44100, 8192, 'a', 1, [[0, 'target', 0.5, 0.003, 0.002]]],
  ['target-k', 48000, 8192, 'k', 1, [[0, 'target', 0.2, 0.01, 0.02]]],
  ['target-then-linear', 44100, 16384, 'a', 1, [[0, 'target', 0, 0, 0.05], [0, 'lin', 1, 0.2]]],
  ['target-then-exp', 44100, 16384, 'a', 1, [[0, 'target', 0.1, 0.0101, 0.03], [0, 'exp', 1, 0.25]]],
  ['target-then-linear-k', 48000, 16384, 'k', 1, [[0, 'target', 0, 0, 0.05], [0, 'lin', 1, 0.2]]],
  ['cancel-mid-linear', 44100, 8192, 'a', 0, [[0, 'set', 0, 0], [0, 'lin', 1, 0.1], [0, 'cancel', 0.05]]],
  ['hold-mid-linear', 44100, 8192, 'a', 0, [[0, 'set', 0, 0], [0, 'lin', 1, 0.1], [0, 'hold', 0.0503]]],
  ['hold-mid-exp', 44100, 8192, 'a', 0, [[0, 'set', 0.01, 0], [0, 'exp', 1, 0.1], [0, 'hold', 0.06]]],
  ['hold-mid-target', 44100, 8192, 'a', 1, [[0, 'target', 0, 0.01, 0.03], [0, 'hold', 0.04]]],
  ['curve-in', 44100, 8192, 'a', 0, [[0, 'curve', 64, 0, 0.01, 0.1]]],
  ['curve-out-hold', 48000, 8192, 'a', 0, [[0, 'curve', 16, 1, 0.005, 0.09], [0, 'hold', 0.05]]],
  ['curve-overlap-throws', 44100, 2048, 'a', 0, [[0, 'curve', 8, 0, 0.01, 0.02], [0, 'set', 1, 0.02],
    [0, 'set', 1, 0.015]]],
  ['rampTo-chain', 44100, 16384, 'a', 0.2, [[0, 'rampTo', 1, 0.02, 0.015], [0, 'rampTo', 0, 0.1, 0.015],
    [0, 'rampTo', 0.5, 0.2, 0.004]]],
  ['rampTo-chain-k', 44100, 16384, 'k', 0.2, [[0, 'rampTo', 1, 0.02, 0.015], [0, 'rampTo', 0, 0.1, 0.015]]],
  ['rampTo-zero-tc', 48000, 4096, 'a', 0.2, [[0, 'rampTo', 0.7, 0.01, 0]]],
  ['setNow-future', 44100, 8192, 'a', 0, [[0, 'setNow', 0.5, 0.01], [0, 'setNow', 0.25, 0.05], [0, 'setNow', 1, 0.03]]],
  ['glideTo-from', 44100, 16384, 'a', 0, [[0, 'glideTo', 880, 0.02, 0.15, 220], [0, 'glideTo', 110, 0.1, 0.2, 500]]],
  ['glideTo-to-zero', 48000, 16384, 'a', 1, [[0, 'glideTo', 0, 0.01, 0.2, 1]]],
  ['glideTo-negative', 44100, 8192, 'a', 0, [[0, 'glideTo', -0.5, 0.01, 0.1, 0.5]]],
  ['glideTo-no-from', 44100, 8192, 'a', 0.4, [[0, 'glideTo', 2, 0, 0.1, N]]],
  ['linearTo-interrupt', 44100, 16384, 'a', 0, [[0, 'linearTo', 1, 0.01, 0.2, 0], [0, 'linearTo', 0, 0.1, 0.1, 0.45]]],
  ['linearTo-no-from', 44100, 8192, 'a', 0.25, [[0, 'linearTo', 1, 0, 0.1, N]]],
  ['holdAndFade', 44100, 16384, 'a', 0.8, [[0, 'setNow', 0.8, 0], [0, 'holdAndFade', 0.05, 0.2]]],
  ['linFrom', 48000, 8192, 'a', 0, [[0, 'rampTo', 1, 0, 0.015], [0, 'linFrom', 0.3, 0.9, 0.05, 0.05]]],
  ['glideFrom', 48000, 8192, 'a', 0, [[0, 'glideFrom', 0.0001, 1, 0.01, 0.1]]],
  ['equalPowerFade-in', 44100, 8192, 'a', 0, [[0, 'equalPowerFade', 0, 1, 0.01, 0.1, 16]]],
  ['equalPowerFade-out', 48000, 16384, 'a', 1, [[0, 'equalPowerFade', 1, 0, 0.02, 0.25, 16]]],
  ['equalPowerFade-k', 44100, 8192, 'k', 0, [[0, 'equalPowerFade', 0.2, 0.9, 0.01, 0.1, 16]]],
  // calls made later on the audio clock (suspend): "now" clamping, param.value, pruning
  ['late-rampTo-now', 44100, 16384, 'a', 0, [[0, 'rampTo', 1, 0, 0.05], [4096, 'rampTo', 0.25, 0, 0.01],
    [8192, 'linearTo', 0.75, 0, 0.05, N]]],
  ['late-past-times', 48000, 16384, 'a', 0, [[0, 'set', 0.5, 0], [2048, 'set', 1, 0.001], [4096, 'lin', 0, 0.01],
    [6144, 'target', 0.6, 0, 0.01], [8192, 'value', 0.1]]],
  ['late-k', 44100, 16384, 'k', 0, [[0, 'rampTo', 1, 0, 0.05], [4096, 'glideTo', 0.1, 0, 0.1, N],
    [8192, 'setNow', 0.5, 0.2]]],
  ['scene-glides', 44100, 32768, 'a', 0.8, [[0, 'linFrom', 0.8, 0.2, 0.1, 0.5], [8192, 'linFrom', 0.55, 1, 0.3, 0.5],
    [16384, 'rampTo', 0.4, 0, 0.015]]],
  // long render, compared in a late window: float precision of the x86 SSE linear-ramp path at large frames
  ['long-linear', 3000, 30000, 'a', 0, [[0, 'set', 0, 2], [0, 'lin', 1, 9.5]], [26000, 28176]],
  ['long-target', 3000, 30000, 'a', 1, [[0, 'target', 0, 8, 0.4]], [24000, 26048]],
];

const { browser, page, server, version } = await openPage();
const results = await page.evaluate(async (cases) => {
  const A = await import('/js/shared/automation.js');
  const fx = await import('/js/engine/fx.js');
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  const nn = (v) => (v === null ? undefined : v); // NaN survives JSON as null
  const from = (v) => (v === null || Number.isNaN(v) ? undefined : { from: v });
  const OPS = {
    set: (p, v, t) => p.setValueAtTime(v, t),
    lin: (p, v, t) => p.linearRampToValueAtTime(v, t),
    exp: (p, v, t) => p.exponentialRampToValueAtTime(v, t),
    target: (p, v, t, tau) => p.setTargetAtTime(v, t, tau),
    curve: (p, n, dir, t, dur) => p.setValueCurveAtTime(A.equalPowerCurve(n, dir ? 'out' : 'in'), t, dur),
    cancel: (p, t) => p.cancelScheduledValues(t),
    hold: (p, t) => p.cancelAndHoldAtTime(t),
    value: (p, v) => {
      p.value = v;
    },
    setNow: (p, v, w) => A.setNow(p, v, w),
    rampTo: (p, v, w, tc) => A.rampTo(p, v, w, tc),
    glideTo: (p, v, w, d, f) => A.glideTo(p, v, w, d, from(f)),
    linearTo: (p, v, w, d, f) => A.linearTo(p, v, w, d, from(f)),
    holdAndFade: (p, w, s) => A.holdAndFade(p, w, s),
    linFrom: (p, a, b, w, d) => fx.linFrom(p, a, b, w, d),
    glideFrom: (p, a, b, w, d) => fx.glideFrom(p, a, b, w, d),
    equalPowerFade: (p, a, b, w, d, s) => fx.equalPowerFade(p, a, b, w, d, s),
  };
  const out = [];
  for (const [name, sr, frames, rate, init, calls, win] of cases) {
    const ctx = new OfflineAudioContext(1, frames, sr);
    const src = new ConstantSourceNode(ctx, { offset: init });
    if (rate === 'k') src.offset.automationRate = 'k-rate';
    src.connect(ctx.destination);
    src.start(0);
    const threw = new Set();
    const run = (i) => {
      const [, op, ...args] = calls[i];
      try {
        OPS[op](src.offset, ...args.map(nn));
      } catch (e) {
        threw.add(i);
      }
    };
    const byFrame = new Map();
    calls.forEach((c, i) => {
      if (!byFrame.has(c[0])) byFrame.set(c[0], []);
      byFrame.get(c[0]).push(i);
    });
    for (const [f, idx] of byFrame) {
      if (f === 0) idx.forEach(run);
      else ctx.suspend(f / sr).then(() => {
        idx.forEach(run);
        ctx.resume();
      });
    }
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    const [w0, w1] = win || [0, frames];
    // second differences of the bit patterns, zero runs collapsed (see the format note at the top)
    const bytes = [];
    const varint = (v) => {
      do {
        let b = v % 128;
        v = Math.floor(v / 128);
        if (v) b += 128;
        bytes.push(b);
      } while (v);
    };
    let prev = 0;
    let prevD = 0;
    let zeros = 0;
    for (let i = w0; i < w1; i++) {
      f32[0] = d[i];
      const bits = u32[0];
      const d1 = (bits - prev) | 0;
      const d2 = (d1 - prevD) | 0;
      prev = bits;
      prevD = d1;
      if (d2 === 0) {
        zeros++;
        continue;
      }
      if (zeros) varint(zeros * 2 + 1);
      zeros = 0;
      varint((((d2 << 1) ^ (d2 >> 31)) >>> 0) * 2);
    }
    if (zeros) varint(zeros * 2 + 1);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    out.push(`case ${name} sr ${sr} frames ${frames} rate ${rate} init ${init} window ${w0} ${w1}`);
    calls.forEach((c, i) => {
      const [f, op, ...args] = c;
      const argText = args.map((a) => (a === null ? 'nan' : String(a))).join(' ');
      out.push(`call ${f} ${op} ${argText}${threw.has(i) ? ' !throw' : ''}`);
    });
    out.push(`out ${btoa(bin)}`, 'end');
  }
  return out;
}, CASES);
await browser.close();
server.close();
fs.mkdirSync(DATA, { recursive: true });
const header = `# AudioParam reference curves from Chromium ${version} (tools/golden/vectors/dump-automation.mjs)`;
fs.writeFileSync(OUT, [header, ...results].join('\n') + '\n');
console.log(`wrote ${OUT}: ${CASES.length} cases, ${fs.statSync(OUT).size} bytes`);
