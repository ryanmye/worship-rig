// T15: shared driver of dump-synth-extra.mjs and dump-organ.mjs (the dump-synth.mjs method of T11 for the
// synth-extra.js and organ.js instruments). Each case builds the real instrument in an OfflineAudioContext of the
// golden Chromium with rng = createRng(hashSeed(`1|${name}`)) (what fx.js rngFor(1, name) returns; the instrument
// forks it), adds the registry's gain trim (instruments.js `_trim`, gain-trims.json) after inst.output, issues every
// call up front at currentTime 0 with its `when` (as the golden page does), renders, and stores a window of the
// output. tests/test_synth_extra_vectors.cpp replays the calls on the native instrument (each applied at the start
// of the quantum containing its time, as the graph delivers commands) and compares sample by sample.
//
// Format:
//   case <name>
//   spec <json>   {kind: synth|organ, patch, params, trimDb, sr, sec, win:[from,to] (frames), cap, tol,
//                  ev:[[t, op, a, b], ...]}   ops: on (note, vel 1..127; vel01 = vel / 127), off (note), legato
//                  (from, to), bend (semis), param (key, value), morph (x), allOff (), fade (note, fadeSec)
//   out <b64>     float32 LE samples [win0, win1) of channel 0 then channel 1
//   end
import fs from 'node:fs';
import path from 'node:path';
import { openPage } from './lib.mjs';

export async function dumpCases(out, title, kind, cases, defaultSr = 44100) {
  const trims = JSON.parse(fs.readFileSync(path.join(path.dirname(out), '../../../../app/js/engine/gain-trims.json'),
    'utf8'))[kind];
  const { browser, page, server, version } = await openPage();
  await page.evaluate(async () => {
    const { SynthExtraInstrument } = await import('/js/engine/synth-extra.js');
    const { OrganInstrument } = await import('/js/engine/organ.js');
    const { createRng, hashSeed } = await import('/js/shared/prng.js');
    window.renderCase = async (spec) => {
      const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(spec.sec * spec.sr),
        sampleRate: spec.sr });
      const rng = createRng(hashSeed(`1|${spec.name}`));
      const Ctor = spec.kind === 'organ' ? OrganInstrument : SynthExtraInstrument;
      const inst = new Ctor(ctx, rng, spec.patch, spec.params || {});
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
      const o = new Float32Array(2 * n);
      o.set(buf.getChannelData(0).subarray(w0, w1), 0);
      o.set(buf.getChannelData(1).subarray(w0, w1), n);
      const bytes = new Uint8Array(o.buffer);
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    };
  });
  const lines = [`# ${title} (tools/golden/vectors/${path.basename(process.argv[1])}), Chromium ${version}`];
  for (const c of cases) {
    // times on the frame grid (the native Model hands instruments frames), issued in time order (stable)
    const sr = c.sr || defaultSr;
    const ev = c.ev.map(([t, ...rest]) => [Math.round(t * sr) / sr, ...rest]).sort((a, b) => a[0] - b[0]);
    const win = c.win.map((x) => Math.round(x * sr));
    const spec = { kind, patch: c.patch, params: c.params || {}, trimDb: trims[c.patch] || 0, sr, sec: c.sec, win,
      cap: c.cap || 0, tol: c.tol || 2e-4, ev, name: c.name };
    const b64 = await page.evaluate((s) => window.renderCase(s), spec);
    lines.push(`case ${c.name}`, `spec ${JSON.stringify(spec)}`, `out ${b64}`, 'end');
    console.log(`${c.name}: ${c.patch}, ${win[1] - win[0]} frames`);
  }
  fs.writeFileSync(out, `${lines.join('\n')}\n`);
  await browser.close();
  server.close();
  console.log(`wrote ${out}`);
}
