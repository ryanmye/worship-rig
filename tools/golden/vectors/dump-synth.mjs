#!/usr/bin/env node
// T11: reference renders of app/js/engine/synth.js (the real module, in the golden Chromium) for what the golden
// fixtures do not exercise: legato glides (TrackedParam, FmDepth.retune), pitch bend, every IMPL[*].apply param,
// morph, the 16-voice steal fade, allOff, fadeOutVoice, and the hidden drone-osc (random-walk BufferSource at 3 kHz,
// unison LFO). Each case builds `new SynthInstrument(ctx, rng, patch, params)` in an OfflineAudioContext with
// rng = createRng(hashSeed(`1|${name}`)) (what fx.js rngFor(1, name) returns; the instrument forks it), adds the
// registry's gain trim (instruments.js `_trim`, gain-trims.json) after inst.output, issues every call up front at
// currentTime 0 with its `when` (as the golden page does), renders, and stores a window of the output.
// tests/test_synth_vectors.cpp replays the same calls on the native SynthInstrument, each applied at the start of
// the quantum that contains its time (as the graph delivers commands), and compares sample by sample.
//
//   node tools/golden/vectors/dump-synth.mjs   -> tools/golden/vectors/data/synth.txt
//
// Format:
//   case <name>
//   spec <json>   {patch, params, trimDb, sr, sec, win:[from,to] (frames), cap, ev:[[t, op, a, b], ...]}
//                 ops: on (note, vel 1..127; vel01 = vel / 127), off (note), legato (from, to), bend (semis),
//                 param (key, value), morph (x), allOff (), fade (note, fadeSec)
//   out <b64>     float32 LE samples [win0, win1) of channel 0 then channel 1
//   end
import fs from 'node:fs';
import path from 'node:path';
import { openPage, DATA } from './lib.mjs';

const OUT = path.join(DATA, 'synth.txt');
const trims = JSON.parse(fs.readFileSync(path.join(DATA, '../../../../app/js/engine/gain-trims.json'), 'utf8')).synth;

const SR = 44100;
const W = (a, b) => [Math.round(a * SR), Math.round(b * SR)];
const CASES = [
  { name: 'warm-legato', patch: 'warm-pad', sec: 0.9, win: W(0.3, 0.85),
    ev: [[0.05, 'on', 60, 100], [0.4, 'legato', 60, 64], [0.7, 'off', 64]] },
  { name: 'warm-params', patch: 'warm-pad', params: { resonance: 0.5, detune: 25 }, sec: 0.8, win: W(0.25, 0.8),
    ev: [[0.05, 'on', 48, 90], [0.3, 'param', 'cutoff', 4000], [0.3, 'param', 'lfoRate', 1.5],
      [0.35, 'param', 'resonance', 0.9], [0.4, 'param', 'sub', 0.1], [0.45, 'param', 'detune', 10],
      [0.5, 'morph', 0.7], [0.55, 'param', 'lfoDepth', 900]] },
  { name: 'glass-morph', patch: 'glass-pad', params: { bloom: 0.3 }, sec: 0.8, win: W(0.2, 0.8),
    ev: [[0.05, 'on', 60, 100], [0.3, 'morph', 1], [0.4, 'param', 'chorus', 1], [0.45, 'param', 'detune', 12],
      [0.5, 'param', 'cutoff', 2500], [0.6, 'off', 60]] },
  { name: 'strings-vib', patch: 'strings', params: { vibDelay: 0.1 }, sec: 0.7, win: W(0.1, 0.7),
    ev: [[0.05, 'on', 67, 110], [0.3, 'param', 'vibRate', 7], [0.35, 'param', 'vibDepth', 20],
      [0.4, 'param', 'detune', 20], [0.45, 'morph', 1], [0.5, 'bend', -1]] },
  { name: 'sub-drive', patch: 'sub-bass', sec: 0.8, win: W(0.15, 0.8),
    ev: [[0.05, 'on', 36, 100], [0.2, 'param', 'drive', 0.9], [0.25, 'param', 'cutoff', 600],
      [0.3, 'param', 'tri', 0.8], [0.32, 'param', 'glide', 0.1], [0.35, 'legato', 36, 43], [0.45, 'morph', 0.5],
      [0.6, 'off', 43]] },
  { name: 'bell-ratio', patch: 'bell', sec: 0.7, win: W(0.1, 0.7),
    ev: [[0.05, 'on', 72, 100], [0.25, 'param', 'ratio', 5], [0.35, 'morph', 1], [0.45, 'legato', 72, 76]] },
  { name: 'keys-trem', patch: 'soft-keys', sec: 0.6, win: W(0.1, 0.6),
    ev: [[0.05, 'on', 60, 100], [0.06, 'on', 84, 60], [0.2, 'param', 'tremolo', 0.8], [0.25, 'param', 'tremRate', 7],
      [0.3, 'param', 'drive', 0.9], [0.35, 'legato', 60, 55], [0.4, 'morph', 0.5]] },
  { name: 'bell-steal-bend', patch: 'bell', sec: 0.7, win: W(0.0, 0.7), cap: 16,
    ev: [...Array.from({ length: 18 }, (_, i) => [0.02 + i * 0.01, 'on', 48 + i, 70 + i]), [0.1, 'off', 50],
      [0.3, 'bend', 2], [0.5, 'allOff']] },
  { name: 'warm-fade', patch: 'warm-pad', params: { attack: 0.05 }, sec: 0.6, win: W(0.1, 0.6),
    ev: [[0.05, 'on', 60, 100], [0.05, 'on', 67, 100], [0.3, 'fade', 60, 0.1]] },
  { name: 'drone-osc', patch: 'drone-osc', params: { attack: 0.2 }, sec: 1.0, win: W(0.0, 1.0),
    ev: [[0.05, 'on', 48, 100], [0.05, 'on', 55, 100], [0.3, 'param', 'drift', 8], [0.35, 'param', 'unisonDrift', 10],
      [0.4, 'param', 'sub', 0.8], [0.45, 'param', 'cutoff', 3000], [0.5, 'param', 'detune', 20], [0.6, 'morph', 1]] },
];

const { browser, page, server, version } = await openPage();
await page.evaluate(async () => {
  const { SynthInstrument } = await import('/js/engine/synth.js');
  const { createRng, hashSeed } = await import('/js/shared/prng.js');
  window.renderCase = async (spec) => {
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(spec.sec * spec.sr),
      sampleRate: spec.sr });
    const inst = new SynthInstrument(ctx, createRng(hashSeed(`1|${spec.name}`)), spec.patch, spec.params || {});
    if (spec.cap) inst.alloc.max = spec.cap;
    const trim = new GainNode(ctx, { gain: Math.pow(10, spec.trimDb / 20) });
    inst.output.connect(trim).connect(ctx.destination);
    const voices = new Map();
    for (const [t, op, a, b] of spec.ev) {
      if (op === 'on') voices.set(a, inst.noteOn(a, b / 127, t));
      else if (op === 'off') inst.noteOff(voices.get(a), t);
      else if (op === 'legato') {
        const v = voices.get(a);
        inst.legatoTo(v, b, t);
        voices.delete(a);
        voices.set(b, v);
      } else if (op === 'bend') inst.setBend(a, t);
      else if (op === 'param') inst.setParam(a, b, t);
      else if (op === 'morph') inst.morph(a, t);
      else if (op === 'allOff') inst.allOff(t, 0.03);
      else if (op === 'fade') inst.fadeOutVoice(voices.get(a), t, b);
    }
    const buf = await ctx.startRendering();
    const [w0, w1] = spec.win;
    const n = w1 - w0;
    const out = new Float32Array(2 * n);
    out.set(buf.getChannelData(0).subarray(w0, w1), 0);
    out.set(buf.getChannelData(1).subarray(w0, w1), n);
    const bytes = new Uint8Array(out.buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
});
const lines = [`# synth.js reference renders (tools/golden/vectors/dump-synth.mjs), Chromium ${version}`];
for (const c of CASES) {
  // times on the frame grid: the native Model hands instruments frames (Model::frameFor), so a time whose t * sr is a
  // hair above an integer (0.02 + 7 * 0.01) would start Chromium's oscillators on the sub-sample path natively absent
  const ev = c.ev.map(([t, ...rest]) => [Math.round(t * SR) / SR, ...rest]);
  const spec = { patch: c.patch, params: c.params || {}, trimDb: trims[c.patch] || 0, sr: SR, sec: c.sec,
    win: c.win, cap: c.cap || 0, ev, name: c.name };
  const b64 = await page.evaluate((s) => window.renderCase(s), spec);
  lines.push(`case ${c.name}`, `spec ${JSON.stringify(spec)}`, `out ${b64}`, 'end');
  console.log(`${c.name}: ${c.patch}, ${spec.win[1] - spec.win[0]} frames`);
}
fs.writeFileSync(OUT, `${lines.join('\n')}\n`);
await browser.close();
server.close();
console.log(`wrote ${OUT}`);
