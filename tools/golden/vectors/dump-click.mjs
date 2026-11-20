#!/usr/bin/env node
// T07: reference vectors for the native click (native/core/src/click/): the REAL app/js/engine/metronome.js and
// app/js/shared/click-math.js, driven through audio.js's click glue (clickStart/clickStop/setClick/setTempo/
// setTimeSig) with an offline AudioTimer of fx.js semantics (a timer at t fires before the 128-frame quantum
// k = ceil(t·sr/128 − 1e-6), with time k·128/sr; timers of one quantum in submission order) over a fake
// BaseAudioContext that records what the metronome asks of Web Audio. Pure arithmetic: no Chromium needed (the only
// Math calls on these paths are floor/ceil/round/abs; the click *sound* is checked against the goldens).
//
//   node tools/golden/vectors/dump-click.mjs   → tools/golden/vectors/data/click-metronome.txt
//
// Format (hex = exact binary64 bit pattern):
//   case <name> <sampleRate> <frames>     one scenario; the native test renders `frames` in 128-frame quanta
//   call <when> <op> <json>               the script: when = -1 → issued before rendering (as page.js), else issued
//                                         at the first quantum boundary >= when (as page.js `setup.live`); ops:
//                                         tempo {bpm}, sig {sig}, config {level,record,output}, start {countIn,
//                                         quietAfter,when?}, stop {when?}, clock {on}
//   ret <op> <json>                       start's / config's return value, in call order
//   tick <hex t> <kind 0 accent|1 beat|2 sub>   AudioBufferSourceNode.start(t), in scheduling order
//   clear <hex t>                         stop(): live sources with start >= t − 1e-6 disconnected
//   clock <hex t> <status>                MIDI clock sink messages (0xf8 clock, 0xfa start, 0xfc stop), in order
//   state <json>                          the metronome's state events, in order
//   end
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const OUT = path.join(HERE, 'data', 'click-metronome.txt');

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);
const hex64 = (x) => {
  f64[0] = x;
  return u64[0].toString(16).padStart(16, '0');
};

// ---- fake Web Audio: only what metronome.js touches -----------------------------------------------------------------
let rec = null; // current scenario's log
class FakeParam {
  constructor(v) {
    this.value = v;
  }
  cancelAndHoldAtTime() {}
  cancelScheduledValues() {}
  setTargetAtTime() {}
  setValueAtTime() {}
}
class FakeNode {
  connect(n) {
    return n;
  }
  disconnect() {}
}
globalThis.GainNode = class extends FakeNode {
  constructor(ctx, o = {}) {
    super();
    this.gain = new FakeParam(o.gain ?? 1);
  }
};
globalThis.ChannelMergerNode = class extends FakeNode {};
globalThis.AudioBuffer = class {
  constructor(o) {
    this.length = o.length;
    this.sampleRate = o.sampleRate;
  }
  copyToChannel() {}
};
globalThis.AudioBufferSourceNode = class extends FakeNode {
  constructor(ctx, o) {
    super();
    this.buffer = o.buffer;
    this.onended = null;
  }
  start(t) {
    const kind = ['accent', 'beat', 'sub'].indexOf(rec.kindOf(this.buffer));
    this._t = t;
    rec.lines.push(`tick ${hex64(t)} ${kind}`);
  }
};

const { Metronome } = await import(path.join(ROOT, 'app/js/engine/metronome.js'));

/** fx.js AudioTimer offline semantics over a manually advanced clock. */
class OfflineTimer {
  constructor(ctx) {
    this.ctx = ctx;
    this.items = [];
    this.seq = 0;
  }
  at(when, cb) {
    const t = Math.max(Number.isFinite(when) ? when : 0, 0);
    const k = Math.ceil((t * this.ctx.sampleRate) / 128 - 1e-6);
    const e = { k, t, cb, id: ++this.seq, cancelled: false };
    this.items.push(e);
    return () => {
      e.cancelled = true;
    };
  }
  /** Fire every timer due at quantum q (also the ones the callbacks add that are due). */
  run(q) {
    this.ctx.currentTime = (q * 128) / this.ctx.sampleRate;
    for (;;) {
      let best = null;
      for (const e of this.items) {
        if (e.k <= q && (!best || e.k < best.k || (e.k === best.k && e.id < best.id))) best = e;
      }
      if (!best) break;
      this.items.splice(this.items.indexOf(best), 1);
      if (!best.cancelled) best.cb(Math.max(best.t, this.ctx.currentTime));
    }
  }
}

function runCase(name, sr, frames, script, { channels = 2 } = {}) {
  const ctx = { sampleRate: sr, currentTime: 0, destination: { maxChannelCount: channels, channelCount: 2 } };
  const timer = new OfflineTimer(ctx);
  const lines = [];
  const m = new Metronome({
    ctx,
    timer,
    recordTap: new GainNode(ctx),
    emit: (d) => lines.push(`state ${JSON.stringify(d)}`),
    warn: () => {},
  });
  rec = { lines, kindOf: (b) => Object.keys(m.buffers).find((k) => m.buffers[k] === b) };
  // audio.js glue state
  const eng = { tempo: null, timeSig: '4/4' };
  const _t = (when) => (Number.isFinite(when) && when > ctx.currentTime ? when : ctx.currentTime);
  // live sources: wrap stop() to log the clear threshold
  const stop0 = m.stop.bind(m);
  m.stop = (o = {}) => {
    if (m.grid) lines.push(`clear ${hex64(Math.max(Number.isFinite(o.when) ? o.when : 0, ctx.currentTime))}`);
    return stop0(o);
  };
  const apply = (op, a) => {
    switch (op) {
      case 'tempo':
        eng.tempo = Number(a.bpm) > 0 ? Number(a.bpm) : null;
        m.retime({ bpm: eng.tempo });
        return undefined;
      case 'sig':
        eng.timeSig = a.sig;
        m.retime({ sig: a.sig, newBar: !!a.newBar }); // controller.js song switch: setTimeSig(sig, {newBar: true})
        eng.timeSig = m.sig;
        return undefined;
      case 'config':
        return m.configure(a, _t(a.when));
      case 'start':
        return m.start({ bpm: eng.tempo, sig: eng.timeSig, countIn: a.countIn || 0, quietAfter: !!a.quietAfter,
          when: _t(a.when) });
      case 'stop':
        m.stop({ when: _t(a.when) });
        return undefined;
      case 'clock':
        m.setClockSink(a.on ? (msgs) => msgs.forEach((x) => lines.push(`clock ${hex64(x.t)} ${x.data[0]}`)) : null);
        return undefined;
      default:
        throw new Error(op);
    }
  };
  const head = [`case ${name} ${sr} ${frames}`];
  const doCall = (op, a) => {
    const r = apply(op, a);
    if (op === 'start' || op === 'config') lines.push(`ret ${op} ${JSON.stringify(r ?? null)}`);
  };
  for (const [when, op, a] of script) {
    head.push(`call ${when} ${op} ${JSON.stringify(a)}`);
    if (when < 0) doCall(op, a);
    else timer.at(when, () => doCall(op, a));
  }
  const nq = frames / 128;
  for (let q = 0; q < nq; q++) timer.run(q);
  return [...head, ...lines, 'end'];
}

const cases = [];
for (const sr of [44100, 48000]) {
  cases.push(runCase(`fixture-120-44-${sr}`, sr, 2.5 * sr - ((2.5 * sr) % 128), [
    [-1, 'tempo', { bpm: 120 }], [-1, 'sig', { sig: '4/4' }], [-1, 'config', { level: 1 }],
    [-1, 'start', { when: 0.1 }], [-1, 'stop', { when: 2.1 }]]));
  cases.push(runCase(`fixture-90-68-${sr}`, sr, 6 * sr - ((6 * sr) % 128), [
    [-1, 'tempo', { bpm: 90 }], [-1, 'sig', { sig: '6/8' }], [-1, 'config', { level: 0.6 }],
    [-1, 'clock', { on: true }], [-1, 'start', { countIn: 1, quietAfter: true, when: 0.1 }]]));
  cases.push(runCase(`run-120-44-clock-${sr}`, sr, 128 * Math.ceil((4 * sr) / 128), [
    [-1, 'tempo', { bpm: 120 }], [-1, 'clock', { on: true }], [-1, 'start', { when: 0.25 }],
    [3.3, 'stop', {}]]));
  cases.push(runCase(`retime-34-${sr}`, sr, 128 * Math.ceil((7 * sr) / 128), [
    [-1, 'tempo', { bpm: 100 }], [-1, 'sig', { sig: '3/4' }], [-1, 'clock', { on: true }],
    [-1, 'start', { countIn: 2, when: 0.2 }], [2.0, 'tempo', { bpm: 140 }], [3.5, 'sig', { sig: '5/4' }],
    [4.2, 'tempo', { bpm: 77.5 }], [4.2, 'sig', { sig: '2/4' }], [6.0, 'stop', { when: 6.25 }]]));
  cases.push(runCase(`countin-restart-128-${sr}`, sr, 128 * Math.ceil((5 * sr) / 128), [
    [-1, 'tempo', { bpm: 72 }], [-1, 'sig', { sig: '12/8' }], [-1, 'clock', { on: true }],
    [-1, 'start', { countIn: 2 }], [1.0, 'sig', { sig: '6/8' }], [2.5, 'tempo', { bpm: 150 }]]));
  cases.push(runCase(`restart-and-null-${sr}`, sr, 128 * Math.ceil((4 * sr) / 128), [
    [-1, 'start', {}], [-1, 'tempo', { bpm: 133 }], [0.5, 'start', {}], [1.3, 'start', { countIn: 1 }],
    [1.4, 'config', { level: 0.25, output: 'aux' }], [2.0, 'tempo', { bpm: 0 }], [2.5, 'start', {}],
    [3.0, 'tempo', { bpm: 61 }], [3.1, 'start', { countIn: 1, quietAfter: true }]]));
  cases.push(runCase(`odd-countin-${sr}`, sr, 128 * Math.ceil((3 * sr) / 128), [
    [-1, 'tempo', { bpm: 180 }], [-1, 'sig', { sig: '7/8' }], [-1, 'clock', { on: true }],
    [-1, 'start', { countIn: 3, quietAfter: true }], [1.0, 'stop', {}], [1.5, 'start', { countIn: 1 }]]));
  // song switch (integrator, T07 review O2): same tempo and signature, newBar only -> the next free beat is a downbeat;
  // then a switch that also changes the tempo (controller.js: setTempo, then setTimeSig with newBar)
  cases.push(runCase(`songswitch-newbar-${sr}`, sr, 128 * Math.ceil((5 * sr) / 128), [
    [-1, 'tempo', { bpm: 120 }], [-1, 'sig', { sig: '4/4' }], [-1, 'clock', { on: true }], [-1, 'start', { when: 0.1 }],
    [1.3, 'sig', { sig: '4/4', newBar: true }], [2.95, 'tempo', { bpm: 96 }],
    [2.95, 'sig', { sig: '4/4', newBar: true }], [4.4, 'stop', {}]]));
}

const head = [
  '# Click metronome vectors from the real app/js/engine/metronome.js + shared/click-math.js',
  '# (tools/golden/vectors/dump-click.mjs; pure JS arithmetic, node ' + process.version + ')',
];
fs.writeFileSync(OUT, [...head, ...cases.flat()].join('\n') + '\n');
console.log(`wrote ${OUT}: ${cases.length} cases, ${cases.flat().length} lines`);
