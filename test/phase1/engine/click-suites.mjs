// Click / metronome suites (v11-metronome, engine/metronome.js). Registered into `offline` / `realtime` by suites.mjs,
// which passes its helpers in. Offline: onsets on the beat grid within 1 sample across a tempo change, accent / beat /
// subdivision levels, count-in + "count-in only", MIDI clock pulses, the recorder tap and outputs 3–4. Realtime: the
// pump's main-thread cost while it runs, no late clicks, and the click keeps the audio awake.
import { CLICK_PEAK, CLICK_KIND_GAIN } from '/js/engine/index.js';

/**
 * @param {object} h helpers from suites.mjs: {SR, mkCtx, mkEngine, db}
 * @returns {{offline: Object<string, Function>, realtime: Object<string, Function>}}
 */
export function clickSuites(h) {
  const { SR, mkEngine, db } = h;
  const mkCtxN = (sec, ch) =>
    new OfflineAudioContext({ numberOfChannels: ch, length: Math.ceil(sec * SR), sampleRate: SR });

  /** Onsets: the first sample above `thr` after ≥ 20 ms below it. @returns {{i:number, peak:number}[]} */
  function onsets(d, thr = 1e-4) {
    const out = [];
    let quiet = Math.round(0.02 * SR);
    for (let i = 0; i < d.length; i++) {
      if (Math.abs(d[i]) > thr) {
        if (quiet >= Math.round(0.02 * SR)) {
          let pk = 0;
          for (let j = i; j < Math.min(d.length, i + Math.round(0.03 * SR)); j++) pk = Math.max(pk, Math.abs(d[j]));
          out.push({ i, peak: pk });
        }
        quiet = 0;
      } else quiet++;
    }
    return out;
  }

  const offline = {
    /** The grid: onsets within 1 sample of t·sr (fractional start), across a tap-tempo change; accent levels. */
    async clickGrid() {
      const ctx = mkCtxN(4, 2);
      const e = await mkEngine(ctx);
      e.setTempo(120);
      e.setClick({ level: 1 });
      const t0 = 0.25013; // 11030.7 frames: a sub-sample start
      e.clickStart({ when: t0 });
      let change = null;
      e.at(1.31, () => {
        e.setTempo(150); // like Tap: lands on the first beat past the scheduled horizon
        change = { ...e.metronome.grid.segs.at(-1) };
      });
      const buf = await ctx.startRendering();
      const L = buf.getChannelData(0);
      const R = buf.getChannelData(1);
      const want = e.metronome.grid.ticks(0, 4 - 0.05);
      const got = onsets(L);
      const errs = want.map((k, n) => (got[n] ? got[n].i - k.t * SR : Infinity));
      const maxErr = Math.max(...errs.map(Math.abs));
      // independent of the grid object: 0.5 s apart before the change, 0.4 s after, the change on a whole beat
      const before = want.filter((k) => k.t < change.t0 - 1e-9);
      const after = want.filter((k) => k.t >= change.t0 - 1e-9);
      const spacingOk = before.every((k, n) => Math.abs(k.t - (t0 + n * 0.5)) < 1e-9)
        && after.every((k, n) => Math.abs(k.t - (change.t0 + n * 0.4)) < 1e-9)
        && Number.isInteger(change.beat0) && change.t0 > 1.31;
      const acc = got.filter((_, n) => want[n]?.kind === 'accent').map((o) => o.peak);
      const beat = got.filter((_, n) => want[n]?.kind === 'beat').map((o) => o.peak);
      const accPeak = Math.min(...acc);
      const ratio = Math.max(...beat) / accPeak;
      let lrSame = true;
      for (let i = 0; i < L.length; i += 7) if (Math.abs(L[i] - R[i]) > 1e-6) lrSame = false;
      const kinds = want.slice(0, 5).map((k) => k.kind).join(',');
      const pass = got.length === want.length && maxErr <= 1 && spacingOk && kinds === 'accent,beat,beat,beat,accent'
        && Math.abs(accPeak / CLICK_PEAK - 1) < 0.03 && Math.abs(ratio - CLICK_KIND_GAIN.beat) < 0.02 && lrSame;
      return {
        pass, clicks: got.length, expected: want.length, maxErrSamples: +maxErr.toFixed(3), spacingOk,
        changeAt: +change.t0.toFixed(4), changeBeat: change.beat0, accPeakDb: +db(accPeak).toFixed(2),
        beatOverAccent: +ratio.toFixed(4), kinds, lrSame,
      };
    },

    /** 6/8 subdivisions, a 1-bar count-in with "count-in only", MIDI clock + Start on the downbeat, Stop. */
    async clickCountInMidi() {
      const ctx = mkCtxN(5, 2);
      const e = await mkEngine(ctx);
      e.setTempo(60);
      e.setTimeSig('6/8');
      e.setClick({ level: 0.5 });
      const msgs = [];
      e.setClockSink((m) => msgs.push(...m));
      const r = e.clickStart({ when: 0.1, countIn: 1, quietAfter: true }); // one bar of 6/8 at 60 = 2 s
      const states = [];
      e.addEventListener('click', (ev) => states.push({ t: ctx.currentTime, ...ev.detail }));
      e.at(4.0, () => e.clickStop());
      const buf = await ctx.startRendering();
      await new Promise((res) => setTimeout(res, 60)); // let the sources' onended events arrive
      const d = buf.getChannelData(0);
      const got = onsets(d);
      const acc = 0.5 * CLICK_PEAK; // level 0.5
      const kinds = got.map((o) => (o.peak > 0.8 * acc ? 'A' : o.peak > 0.4 * acc ? 'B' : 's'));
      const clocks = msgs.filter((m) => m.data[0] === 0xf8);
      const startI = msgs.findIndex((m) => m.data[0] === 0xfa);
      const stop = msgs.find((m) => m.data[0] === 0xfc);
      const gaps = clocks.slice(1).map((m, i) => m.t - clocks[i].t);
      const gapErr = Math.max(...gaps.map((g) => Math.abs(g - 1 / 36)));
      const pass = Math.abs(r.downbeat - 2.1) < 1e-9 && got.length === 6 && kinds.join('') === 'AssBss'
        && got.every((o, n) => Math.abs(o.i - (0.1 + n / 3) * SR) <= 1)
        && startI > 0 && Math.abs(msgs[startI].t - 2.1) < 1e-9 && msgs[startI + 1]?.data[0] === 0xf8
        && Math.abs(clocks[0].t - 0.1) < 1e-9 && gapErr < 1e-9 && !!stop && Math.abs(stop.t - 4.0) < 0.003
        && states.some((s) => s.running && !s.counting) && states.at(-1).running === false
        && e.metronome.liveCount === 0;
      return {
        pass, downbeat: r.downbeat, clicks: got.length, kinds: kinds.join(''), clocks: clocks.length,
        startAt: startI > 0 ? msgs[startI].t : null, stopAt: stop?.t ?? null, gapErrSec: gapErr,
        states: states.map((s) => `${s.running ? (s.counting ? 'counting' : 'running') : 'stopped'}`).join('>'),
      };
    },

    /** The recorder's tap has no click unless "record the click" is on. */
    async clickRecordTap() {
      const ctx = mkCtxN(2.4, 4);
      const e = await mkEngine(ctx);
      // probe: recordTap → channels 3–4 of the render; the main output (and the click) up-mix into 1–2
      const sp = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
      const m = new ChannelMergerNode(ctx, { numberOfInputs: 4 });
      e.recordTap.connect(sp);
      sp.connect(m, 0, 2);
      sp.connect(m, 1, 3);
      m.connect(ctx.destination);
      e.setTempo(120);
      e.clickStart({ when: 0.1 });
      e.at(1.2, () => e.setClick({ record: true }));
      const buf = await ctx.startRendering();
      const main = onsets(buf.getChannelData(0));
      const tapBefore = onsets(buf.getChannelData(2).subarray(0, Math.round(1.2 * SR)));
      const tapAfter = onsets(buf.getChannelData(2).subarray(Math.round(1.2 * SR)));
      const pass = main.length === 5 && tapBefore.length === 0 && tapAfter.length === 2;
      return { pass, mainClicks: main.length, tapBefore: tapBefore.length, tapAfter: tapAfter.length };
    },

    /** Outputs 3–4: the click leaves channels 1–2 (the music) and plays on 3 and 4 only. */
    async clickAuxOutput() {
      const ctx = mkCtxN(1.4, 4);
      const e = await mkEngine(ctx);
      const outs = e.clickOutputs();
      const r = e.setClick({ output: 'aux' });
      e.setTempo(120);
      // music on 1–2: a constant tone into fx.sum, so the 'discrete' up-mix of the main bus is checked too
      const osc = new OscillatorNode(ctx, { frequency: 220 });
      const g = new GainNode(ctx, { gain: 0.1 });
      osc.connect(g).connect(e.fx.sum);
      osc.start(0);
      e.clickStart({ when: 0.1 });
      const buf = await ctx.startRendering();
      const ch = [0, 1, 2, 3].map((c) => buf.getChannelData(c));
      const clicks = ch.map((d) => onsets(d).length);
      const rmsOf = (d) => Math.sqrt(d.reduce((a, x) => a + x * x, 0) / d.length);
      const music = ch.map(rmsOf);
      // the click is absent from 1–2: their content is the tone alone (the same on L and R)
      let lrDiff = 0;
      for (let i = 0; i < ch[0].length; i++) lrDiff = Math.max(lrDiff, Math.abs(ch[0][i] - ch[1][i]));
      const pass = outs.aux && r.output === 'aux' && clicks[2] === 3 && clicks[3] === 3 && music[0] > 0.01
        && lrDiff < 1e-6 && e.ctx.destination.channelInterpretation === 'discrete' && music[2] < music[0];
      // back to 'main': the destination returns to its own layout
      e.setClick({ output: 'main' });
      const restored = ctx.destination.channelCount === 4 && ctx.destination.channelInterpretation === 'speakers';
      return { pass: pass && restored, outs, clicks, musicRms: music.map((x) => +x.toFixed(4)), restored };
    },
  };

  const realtime = {
    /** CPU while running: the pump's main-thread time, no late clicks, sleepBlockers names it, stop drops the rest. */
    async clickCpu() {
      const { AudioEngine } = await import('/js/engine/index.js');
      const e = new AudioEngine({ seed: 3, manifestUrl: '/__fixtures/manifest.json', instrumentModules: false });
      await e.start();
      e.setTempo(132);
      e.setTimeSig('12/8'); // busiest grid: 12 clicks per bar (3 per beat)
      e.setClick({ level: 0.2 });
      const sinkMsgs = [];
      e.setClockSink((m) => sinkMsgs.push(...m));
      const t0 = performance.now();
      e.clickStart();
      const blockers = e.sleepBlockers();
      await new Promise((r) => setTimeout(r, 5000));
      const st = { ...e.metronome.stats };
      const wall = (performance.now() - t0) / 1000;
      e.clickStop();
      const liveAfterStop = e.metronome.liveCount;
      await new Promise((r) => setTimeout(r, 200));
      const liveLater = e.metronome.liveCount;
      const blockersAfter = e.sleepBlockers();
      e.dispose();
      const msPerSec = st.pumpMs / wall;
      const pass = blockers.includes('click') && !blockersAfter.includes('click') && st.late === 0 && st.ticks >= 30
        && msPerSec < 5 && liveLater === 0 && sinkMsgs.length > 350;
      return {
        pass, wallSec: +wall.toFixed(2), pumps: st.pumps, ticks: st.ticks, pulses: st.pulses, late: st.late,
        pumpMsPerSec: +msPerSec.toFixed(3), pumpMsAvg: +(st.pumpMs / st.pumps).toFixed(4), liveAfterStop, liveLater,
      };
    },

    /**
     * v11-review-fixes R-8: an audio restart while the click runs sends MIDI Stop (with the old context's clock)
     * before the new grid's Start, so a receiver sees Start · clocks · Stop · Start · clocks · Stop, never two Starts
     * in a row. Through the real midi-clock.js with a fake Web MIDI output (timestamps in send order).
     */
    async clickRestartMidi() {
      const { AudioEngine } = await import('/js/engine/index.js');
      const { createMidiClock } = await import('/js/midi-clock.js');
      const sent = [];
      const port = { id: 'o1', name: 'Fake Clock In', state: 'connected',
        send: (data, ts) => sent.push({ b: data[0], ts }) };
      const access = { outputs: new Map([[port.id, port]]) };
      const e = new AudioEngine({ seed: 3, manifestUrl: '/__fixtures/manifest.json', instrumentModules: false });
      await e.start();
      const clock = createMidiClock({ getAccess: () => access, getCtx: () => e.ctx });
      const connected = clock.setOutput('Fake Clock In');
      e.setClockSink(clock.sink);
      e.setTempo(120);
      e.setClick({ level: 0.1 });
      e.clickStart();
      await new Promise((r) => setTimeout(r, 800));
      const beforeRestart = sent.length;
      await e.restart();
      const runningAfter = !!e.clickState()?.running;
      await new Promise((r) => setTimeout(r, 800));
      e.clickStop();
      e.dispose();
      const seq = sent.filter((m) => m.b !== 0xf8).map((m) => m.b.toString(16)).join(' ');
      const iStop = sent.findIndex((m) => m.b === 0xfc);
      const iStart2 = sent.findIndex((m, i) => i > iStop && m.b === 0xfa);
      const clocksBetween = sent.slice(iStop + 1, iStart2).filter((m) => m.b === 0xf8).length;
      // the Stop goes out at the restart, timed before the new grid's Start (its first pulse: no count-in)
      const pass = connected && beforeRestart > 20 && runningAfter && seq === 'fa fc fa fc' && iStop >= beforeRestart &&
        clocksBetween === 0 && sent[iStop].ts <= sent[iStart2].ts;
      return { pass, connected, seq, beforeRestart, runningAfter, clocksBetween, sent: sent.length };
    },
  };
  return { offline, realtime };
}
