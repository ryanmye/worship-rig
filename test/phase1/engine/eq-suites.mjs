// Slot EQ suites (design/eq/DECISION.md §3 + AMENDMENT.md §2/§5): WING-style bands b1..b8, low/high cut, k-rate,
// click-free chain switches and type swaps, getEqResponse / getSlotPlayRange, CPU. Registered into `offline` by
// suites.mjs (which passes its helpers in, so the click detector and render helpers are the same ones).
import { Channel, AudioTimer, EQ_WARM, EQ_XFADE, EQ_TYPE_FADE } from '/js/engine/fx.js';
import { PARAMS, clamp as clampParam } from '/js/shared/params.js';

const PROBES = [50, 100, 170, 300, 520, 800, 1200, 2000, 3100, 4700, 7000, 11000];

/**
 * @param {object} h helpers from suites.mjs: {SR, mkCtx, mkEngine, slot, patch, use, mono, clicks, db}
 * @returns {Object<string, () => Promise<object>>}
 */
export function eqSuites(h) {
  const { SR, mkCtx, mkEngine, slot, patch, use, mono, clicks, db } = h;

  /** Hann-windowed single-bin DFT magnitude of `f` over [a, a + dur). */
  function toneMag(d, a, dur, f) {
    const i0 = Math.round(a * SR);
    const n = Math.round(dur * SR);
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const x = d[i0 + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
      const ph = (2 * Math.PI * f * (i0 + i)) / SR;
      re += x * Math.cos(ph);
      im -= x * Math.sin(ph);
    }
    return Math.hypot(re, im);
  }
  /** Sum of sines (mono) into a node from t = 0. */
  function sines(ctx, dest, freqs, amp) {
    const g = new GainNode(ctx, { gain: amp });
    for (const f of freqs) {
      const o = new OscillatorNode(ctx, { frequency: f });
      o.connect(g);
      o.start(0);
    }
    g.connect(dest);
    return g;
  }
  function noise(ctx, dest, amp = 0.05, seed = 1) {
    const b = new AudioBuffer({ length: SR, numberOfChannels: 2, sampleRate: SR });
    let s = seed >>> 0 || 1;
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        s = (s * 1664525 + 1013904223) >>> 0;
        d[i] = ((s / 4294967296) * 2 - 1) * amp;
      }
    }
    const src = new AudioBufferSourceNode(ctx, { buffer: b, loop: true });
    src.connect(dest);
    src.start(0);
  }
  /** "Never created": the EQ section removed from a live strip (wOut → pan directly). */
  function bypassEq(ch) {
    ch.eq._drop(ch.eq.active);
    ch.eq._drop(ch.eq.incoming);
    ch.wOut.connect(ch.pan);
  }
  const maxDiff = (a, b) => {
    let m = 0;
    for (const [x, y] of [[a.getChannelData(0), b.getChannelData(0)], [a.getChannelData(1), b.getChannelData(1)]])
      for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - y[i]));
    return m;
  };
  const kRate = (ch) => {
    let all = true;
    for (const side of [ch.eq.active, ch.eq.incoming]) {
      if (!side) continue;
      for (const n of side.nodes.values()) for (const p of [n.frequency, n.Q, n.gain, n.detune]) all = all && p.automationRate === 'k-rate';
    }
    return all;
  };

  /** One offline render of slot 0 (fallback synth 'bell' + an injected test signal) with EQ writes. */
  async function renderSlot({ eq, writes = [], sec = 1.35, signal = 'probes', notes = [], bypass = false, before = null } = {}) {
    const ctx = mkCtx(sec);
    const e = await mkEngine(ctx);
    await use(e, patch({ 0: slot('synth', 'bell', eq ? { eq } : {}) }, { master: { volume: 1 } }));
    const ch = e.slots[0].strip;
    if (signal === 'probes') sines(ctx, ch.input, PROBES, 0.004);
    else if (signal === 'low') sines(ctx, ch.input, [110, 165, 220, 330], 0.03);
    else if (signal === 'noise') noise(ctx, ch.input, 0.03);
    for (const [n, t] of notes) e.noteOn(n, 90, { when: t });
    for (const [t, p, v] of writes) {
      if (t <= 0) e.setParam(p, v, { when: 0 });
      else e.at(t, (tt) => e.setParam(p, v, { when: tt }));
    }
    if (before) before(e, ctx, ch);
    if (bypass) bypassEq(ch);
    const buf = await ctx.startRendering();
    return { e, ch, buf, d: mono(buf) };
  }

  return {
    /** Defaults, 0 dB / off bands and legacy rows render identically to a strip without any EQ (≤ 2e-6). */
    async eqIdentity() {
      const notes = [[60, 0.05], [64, 0.05], [67, 0.3]];
      const run = (o) => renderSlot({ signal: 'noise', notes, sec: 1.2, ...o });
      const never = await run({ bypass: true });
      const dflt = await run({});
      const zeroBands = await run({ eq: { low: 0, high: 0, b2: { on: true, type: 'peak', hz: 500, db: 0, q: 2 }, b5: { on: false, type: 'notch', hz: 900 }, b3: { type: 'off' }, cutHz: 20, hiCutHz: 20000 } });
      // at runtime: a band added at 0 dB goes through a chain switch (warm-up + crossfade of identical signals)
      const added = await run({ writes: [[0.3, 'slots.0.eq.b4.on', true], [0.3, 'slots.0.eq.b4.hz', 700], [0.6, 'slots.0.eq.b6.on', true]] });
      // legacy vs b-rows: the same graph built twice; noise only (no synth voices, whose multi-oscillator sums vary
      // by Chromium's input summing order, CLAUDE.md caveat)
      const legacy = await run({ eq: { low: 4, high: -3 }, notes: [] });
      const rows = await run({ eq: { b1: { on: true, type: 'lowshelf', hz: 120, db: 4 }, b8: { on: true, type: 'highshelf', hz: 6000, db: -3 } }, notes: [] });
      const diffs = {
        default: maxDiff(dflt.buf, never.buf),
        zeroAndOffBands: maxDiff(zeroBands.buf, never.buf),
        bandsAddedLive: maxDiff(added.buf, never.buf),
        legacyVsBRows: maxDiff(legacy.buf, rows.buf),
      };
      const legacyAudible = maxDiff(legacy.buf, never.buf) > 1e-3;
      const e = legacy.e;
      const got = {
        b1db: e.getParam('slots.0.eq.b1.db'), b8db: e.getParam('slots.0.eq.b8.db'), b1on: e.getParam('slots.0.eq.b1.on'),
        b3on: e.getParam('slots.0.eq.b3.on'), b1hz: e.getParam('slots.0.eq.b1.hz'), low: e.getParam('slots.0.eq.low'),
        cutHz: e.getParam('slots.0.eq.cutHz'), hiCutHz: e.getParam('slots.0.eq.hiCutHz'), mid1Hz: e.getParam('slots.0.eq.mid1Hz'),
      };
      const getOk = got.b1db === 4 && got.b8db === -3 && got.b1on === true && got.b3on === false && got.b1hz === 120 && got.low === 4 && got.cutHz === 20 && got.hiCutHz === 20000 && got.mid1Hz === 400;
      // every slot EQ row: setParam → getParam round trip (clamped)
      const bad = [];
      for (const row of PARAMS.filter((r) => r.path.startsWith('slots.<i>.eq.'))) {
        const p = row.path.replace('<i>', '0');
        const v = row.unit === 'bool' ? !row.default : row.unit === 'enum' ? row.enum.find((x) => x !== row.default) : row.max + 1;
        e.setParam(p, v);
        const want = clampParam(p, v);
        const back = e.getParam(p);
        // legacy rows of a band that has b-rows are stored but not effective; the row itself still reads back
        if (back !== want) bad.push(`${p}: ${back} ≠ ${want}`);
      }
      const nodes = { default: dflt.ch.nodeCount, zeroAndOff: zeroBands.ch.nodeCount, eqDefault: dflt.ch.eq.nodeCount };
      const pass = Object.values(diffs).every((x) => x <= 2e-6) && legacyAudible && getOk && !bad.length && nodes.eqDefault === 3 && kRate(dflt.ch) && kRate(added.ch) && added.ch.eq.switches === 2;
      return { pass, maxDiff: diffs, legacyAudible, getParam: got, roundTripBad: bad.slice(0, 5), nodes, switches: added.ch.eq.switches };
    },

    /** Each band type (and the dedicated cuts, and the whole chain) as rendered = getEqResponse within 0.2 dB. */
    async eqBandResponse() {
      const ref = await renderSlot({});
      const win = [0.3, 1.0];
      const refMag = PROBES.map((f) => toneMag(ref.d, win[0], win[1], f));
      const cases = [
        ['peak +6 1k Q1.4', { b3: { on: true, type: 'peak', hz: 1000, db: 6, q: 1.4 } }],
        ['peak −9 300 Q4 (live)', null, [['b3.on', true], ['b3.hz', 300], ['b3.db', -9], ['b3.q', 4]]],
        ['lowshelf +6 200', { b1: { on: true, type: 'lowshelf', hz: 200, db: 6 } }],
        ['highshelf −6 3k (live)', null, [['b8.hz', 3000], ['b8.db', -6]]],
        ['notch 1.5k Q2', { b4: { on: true, type: 'notch', hz: 1500, q: 2 } }],
        ['band lowcut 250', { b5: { on: true, type: 'lowcut', hz: 250, q: Math.SQRT1_2 } }],
        ['band highcut 2.5k Q1.2 (live)', null, [['b6.on', true], ['b6.type', 'highcut'], ['b6.hz', 2500], ['b6.q', 1.2]]],
        ['cutHz 120 + hiCutHz 5k (live)', null, [['cutHz', 120], ['hiCutHz', 5000]]],
        ['legacy low +4 high −3', { low: 4, high: -3 }],
        ['DECISION mid1 −4 @ 700', { mid1: -4, mid1Hz: 700, mid1Q: 2 }],
        ['WING: 8 bands + both cuts', {
          cutHz: 40, hiCutHz: 14000,
          b1: { on: true, type: 'lowshelf', hz: 90, db: 3 }, b2: { on: true, type: 'peak', hz: 180, db: -4, q: 2 },
          b3: { on: true, type: 'peak', hz: 400, db: 2.5, q: 0.8 }, b4: { on: true, type: 'notch', hz: 650, q: 6 },
          b5: { on: true, type: 'peak', hz: 1500, db: -3, q: 3 }, b6: { on: true, type: 'peak', hz: 2600, db: 4, q: 1 },
          b7: { on: true, type: 'peak', hz: 5500, db: -2, q: 2 }, b8: { on: true, type: 'highshelf', hz: 8000, db: 3 },
        }],
      ];
      const rows = [];
      for (const [label, eq, live] of cases) {
        const r = await renderSlot({ eq: eq || undefined, writes: (live || []).map(([k, v]) => [0, `slots.0.eq.${k}`, v]) });
        const want = r.e.getEqResponse(0, PROBES);
        let worst = 0;
        const got = PROBES.map((f, i) => {
          const m = db(toneMag(r.d, win[0], win[1], f) / refMag[i]);
          worst = Math.max(worst, Math.abs(m - want[i]));
          return +m.toFixed(2);
        });
        rows.push({ label, worstDb: +worst.toFixed(4), ok: worst <= 0.2, got, want: [...want].map((x) => +x.toFixed(2)), wired: r.ch.eq.active.ids.join(' ') });
      }
      // perBand and above-Nyquist handling
      const e = ref.e;
      e.setParam('slots.0.eq.b3.on', true);
      e.setParam('slots.0.eq.b3.db', 6);
      const pb = e.getEqResponse(0, [1000, 30000], { perBand: true });
      const pbOk = Object.keys(pb.bands).join() === 'b1,b3,b8' && Math.abs(pb.total[0] - (pb.bands.b1[0] + pb.bands.b3[0] + pb.bands.b8[0])) < 1e-4 && Number.isFinite(pb.total[1]);
      const pass = rows.every((x) => x.ok) && pbOk && e.getEqResponse(2, PROBES) === null;
      return { pass, rows: rows.map((x) => `${x.label}: worst ${x.worstDb} dB [${x.wired}]${x.ok ? '' : ` ✗ got ${x.got} want ${x.want}`}`), perBandOk: pbOk, wing: { probesHz: PROBES, renderedDb: rows[rows.length - 1].got, getEqResponseDb: rows[rows.length - 1].want } };
    },

    /** Low/high cut engage/bypass (chain crossfade) and band add/remove/type switches are click-free; a raw type swap is not. */
    async eqSwitchClicks() {
      const notes = [[48, 0.05], [55, 0.05], [60, 0.05], [64, 0.05]];
      const w = [];
      const at = (t, k, v) => w.push([t, `slots.0.eq.${k}`, v]);
      // dedicated cuts in and out (DECISION's dry/wet bypass), then gliding while engaged
      at(0.4, 'cutHz', 150);
      at(0.7, 'cutHz', 90);
      at(0.9, 'cutHz', 20);
      at(1.1, 'hiCutHz', 900);
      at(1.3, 'hiCutHz', 20000);
      // a band added at 0 dB, dragged, retyped in place (peak ↔ shelves) and by switch (notch, cut), removed
      at(1.5, 'b3.on', true);
      at(1.5, 'b3.hz', 220);
      at(1.6, 'b3.db', 9);
      at(1.8, 'b3.type', 'lowshelf');
      at(2.0, 'b3.type', 'highshelf');
      at(2.2, 'b3.type', 'peak');
      at(2.4, 'b3.type', 'notch');
      at(2.6, 'b3.type', 'lowcut');
      at(2.8, 'b3.type', 'peak');
      at(3.0, 'b3.on', false);
      at(3.2, 'b1.type', 'off');
      at(3.4, 'b1.type', 'lowshelf');
      at(3.4, 'b1.db', 6);
      const sw = [];
      const r = await renderSlot({ signal: 'low', notes, writes: w, sec: 3.8, before: (e, ctx, ch) => {
        for (const t of [1.0, 1.7, 1.9, 2.5, 3.1]) e.at(t, () => sw.push([t, ch.eq.switches, ch.eq.active.ids.join(' ')]));
      } });
      const hit = clicks(r.d, SR, 0.3, 3.7);
      // positive control: same signal, band 3 at +12 dB swapped to a notch with no fade
      const ctl = await renderSlot({ signal: 'low', notes, sec: 1.6, writes: [[0, 'slots.0.eq.b3.on', true], [0, 'slots.0.eq.b3.hz', 220], [0, 'slots.0.eq.b3.db', 12]],
        before: (e, ctx, ch) => e.at(1.0, () => { ch.eq.active.nodes.get('b3').type = 'notch'; }) });
      const ctlHit = clicks(ctl.d, SR, 0.3, 1.5);
      // in-place type swaps are not chain switches: 0.4 lc on · 0.9 off · 1.1 hc on · 1.3 off · 1.5 b3 · 2.4 notch ·
      // 2.6 lowcut · 2.8 peak · 3.2 b1 off stays wired (identity) · 3.4 back: 8 switches, none for 1.8/2.0/2.2/3.2/3.4
      const pass = hit.length === 0 && ctlHit.length >= 1 && r.ch.eq.switches === 8 && kRate(r.ch);
      return { pass, clicks: hit.slice(0, 5), controlClicks: ctlHit.length, switches: r.ch.eq.switches, timeline: sw, wiredAtEnd: r.ch.eq.active.ids.join(' '), timings: { warm: EQ_WARM, xfade: EQ_XFADE, typeFade: EQ_TYPE_FADE } };
    },

    /** k-rate coefficient steps while dragging (gain ±12 dB, Hz 150 → 2 kHz, Q) every 10 ms: no zipper clicks. */
    async eqDragZipper() {
      const w = [[0, 'slots.0.eq.b3.on', true], [0, 'slots.0.eq.b3.hz', 150]];
      for (let k = 0; k <= 150; k++) {
        const t = 0.3 + k * 0.01;
        const x = k / 150;
        w.push([t, 'slots.0.eq.b3.db', 12 * Math.sin(2 * Math.PI * 2 * x)]);
        w.push([t, 'slots.0.eq.b3.hz', 150 * Math.pow(2000 / 150, x)]);
        w.push([t, 'slots.0.eq.b3.q', 0.5 + 3 * x]);
        w.push([t, 'slots.0.eq.b8.db', -12 * x]);
      }
      const r = await renderSlot({ signal: 'low', notes: [[48, 0.05], [60, 0.05]], writes: w, sec: 2.1 });
      const hit = clicks(r.d, SR, 0.3, 2.0);
      return { pass: hit.length === 0 && kRate(r.ch), clicks: hit.slice(0, 5), writes: w.length, kRate: kRate(r.ch) };
    },

    /** getSlotPlayRange: split ∩ sampled range, octave + slot transpose + song transpose. */
    async eqPlayRange() {
      const ctx = mkCtx(0.1);
      const e = await mkEngine(ctx);
      await use(e, patch({
        0: slot('sampler', 'test-keys', { lowNote: 48, highNote: 72, octave: -1, transpose: 2 }),
        1: slot('synth', 'bell', { lowNote: 100, highNote: 127, octave: 2 }),
      }));
      e.setTranspose(3);
      const a = e.getSlotPlayRange(0); // shift −12 + 2 + 3 = −7 → sounds 41..65; fixture samples C4..A4 (60..69)
      const b = e.getSlotPlayRange(1); // shift +27: 127..154 → 127 only; synth: every sounding note is "sampled"
      e.setTranspose(0);
      const c = e.getSlotPlayRange(0);
      const empty = e.getSlotPlayRange(2);
      const ok =
        a.lowNote === 41 && a.highNote === 65 && a.sampledLow === 60 && a.sampledHigh === 65 && a.transpose === -7 && a.physLow === 48 && a.physHigh === 72 &&
        a.instrumentRange?.[0] === 60 && a.instrumentRange?.[1] === 69 &&
        b.lowNote === 127 && b.highNote === 127 && b.sampledLow === 127 && b.sampledHigh === 127 && b.instrumentRange === null &&
        c.lowNote === 38 && c.highNote === 62 && c.sampledLow === 60 && c.sampledHigh === 62 && empty === null;
      await ctx.startRendering();
      return { pass: ok, split: a, synth: b, noSongTranspose: c };
    },

    /**
     * CPU (DECISION §3 method: 4 strips × looping stereo noise, offline at 48 kHz; here 10 s renders, 5 rounds with the
     * configs interleaved, fastest of each, scaled to DECISION's 30 s: the box is shared, and the minimum is the least
     * load-dependent estimate). Hard: the EQ section's own cost (chain gain, k-rate) stays within +30 % of the same
     * number of plain biquads measured in this run (or within 0.5 % of a core of it). Soft (box load): the EQ costs
     * within ±30 % of DECISION's table.
     */
    async eqCpu() {
      const SR48 = 48000;
      const SEC = 10;
      const SCALE = 30 / SEC;
      const render = async (mode) => {
        const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: SR48 * SEC, sampleRate: SR48 });
        const timer = new AudioTimer(ctx);
        const sink = new GainNode(ctx);
        sink.connect(ctx.destination);
        const dummy = { input: new GainNode(ctx) };
        const buf = new AudioBuffer({ length: SR48, numberOfChannels: 2, sampleRate: SR48 });
        for (let c = 0; c < 2; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < d.length; i++) d[i] = Math.random() * 0.2 - 0.1;
        }
        for (let s = 0; s < 4; s++) {
          const ch = new Channel(ctx, { sum: sink, reverb: dummy, delay: dummy, chorus: dummy, env: { timer } }, s);
          ch.fader.gain.value = 1;
          const src = new AudioBufferSourceNode(ctx, { buffer: buf, loop: true });
          src.connect(ch.input);
          src.start(0);
          const five = { cutHz: 60, b2: { on: true, type: 'peak', hz: 400, db: 0, q: 1 }, b3: { on: true, type: 'peak', hz: 2500, db: 0, q: 1 } };
          if (mode === 'none' || mode.startsWith('raw')) {
            bypassEq(ch);
            if (mode.startsWith('raw')) {
              const n = Number(mode[3]);
              ch.wOut.disconnect(ch.pan);
              let prev = ch.wOut;
              for (let k = 0; k < n; k++) {
                const b = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 200 * (k + 1), gain: 0 });
                if (mode.endsWith('r')) {
                  for (const p of [b.frequency, b.Q, b.gain, b.detune]) p.automationRate = 'k-rate';
                  for (let t = 0; t < SEC; t += 0.5) b.gain.setTargetAtTime(Math.round(t * 2) % 2 ? 6 : -6, t, 0.1);
                }
                prev.connect(b);
                prev = b;
              }
              prev.connect(ch.pan);
            }
          } else if (mode === 'eq5') ch.setEq(five, 0, true);
          else if (mode === 'eq5r') {
            ch.setEq(five, 0, true);
            for (let t = 0.5; t < SEC; t += 0.5) {
              const g = Math.round(t * 2) % 2 ? 6 : -6;
              ch.setEq({ ...five, low: g, high: -g, b2: { ...five.b2, db: g }, b3: { ...five.b3, db: -g } }, t);
            }
          } else if (mode === 'eq10') {
            const bands = {};
            for (let k = 1; k <= 8; k++) bands[`b${k}`] = { on: true, type: k === 1 ? 'lowshelf' : k === 8 ? 'highshelf' : 'peak', hz: 100 * 2 ** k, db: 2, q: 1 };
            ch.setEq({ ...bands, cutHz: 40, hiCutHz: 16000 }, 0, true);
          }
        }
        const t0 = performance.now();
        await ctx.startRendering();
        timer.dispose();
        return performance.now() - t0;
      };
      const MODES = ['none', 'raw2', 'eq2', 'raw5', 'eq5', 'raw5r', 'eq5r', 'eq10'];
      const best = Object.fromEntries(MODES.map((m) => [m, Infinity]));
      for (let round = 0; round < 5; round++)
        for (const m of MODES) best[m] = Math.min(best[m], await render(m === 'eq2' ? 'default' : m));
      const ms = Object.fromEntries(MODES.map((m) => [m, Math.round(best[m] * SCALE)])); // per 30 s of audio
      // the EQ section's own cost over the strip without it, vs DECISION's (its "none" = 32 ms had no strip at all)
      const cost = (m) => ms[m] - ms.none;
      const PAIRS = { eq2: 'raw2', eq5: 'raw5', eq5r: 'raw5r' };
      const rel = Object.fromEntries(Object.entries(PAIRS).map(([k, r]) => [k, cost(k) / Math.max(1, cost(r))]));
      const DEC = { eq2: 251 - 32, eq5: 568 - 32, eq5r: 796 - 32 };
      const vsDecision = Object.fromEntries(Object.keys(DEC).map((k) => [k, +(cost(k) / DEC[k]).toFixed(2)]));
      const core = (x) => `${((x / 30000) * 100).toFixed(1)} %`;
      const hard = Object.entries(PAIRS).every(([k, r]) => rel[k] <= 1.3 || ms[k] - ms[r] <= 0.005 * 30000);
      const absOk = Object.values(vsDecision).every((x) => x >= 0.7 && x <= 1.3);
      const out = {
        renderMs: ms, relToPlainBiquads: Object.fromEntries(Object.entries(rel).map(([k, v]) => [k, +v.toFixed(2)])), vsDecision,
        eqShareOfOneCore: { default: core(cost('eq2')), five: core(cost('eq5')), fiveRampingKrate: core(cost('eq5r')), allTen: core(cost('eq10')) },
        stripShareOfOneCore: { none: core(ms.none), default: core(ms.eq2), allTen: core(ms.eq10) },
      };
      if (!hard) return { pass: false, ...out };
      return absOk ? { pass: true, ...out } : { pass: false, soft: true, note: 'absolute numbers outside DECISION ±30 % (box load?)', ...out };
    },
  };
}
