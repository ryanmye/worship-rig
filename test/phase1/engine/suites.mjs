// Engine test suites, run in-page (Chromium) by run.mjs. Offline suites inject a seeded OfflineAudioContext.
import { AudioEngine, buildIR, followVoicing } from '/js/engine/index.js';
import { eqSuites } from './eq-suites.mjs';

const SR = 44100;
const MANIFEST = '/__fixtures/manifest.json';
const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

// ----- helpers ---------------------------------------------------------------------------------------------------
function mkCtx(sec, sr = SR) {
  return new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(sec * sr), sampleRate: sr });
}
async function mkEngine(ctx, opts = {}) {
  const e = new AudioEngine({ context: ctx, seed: 7, manifestUrl: MANIFEST, instrumentModules: false, ...opts });
  await e.start();
  return e;
}
function slot(type, id, extra = {}) {
  return { instrument: { type, id }, gain: 1, sends: { reverb: 0, delay: 0, chorus: 0 }, ...extra };
}
function patch(slots, fx = {}, more = {}) {
  const s = [null, null, null, null];
  for (const [i, v] of Object.entries(slots)) s[i] = v;
  return { slots: s, fx, ...more };
}
async function use(engine, p, when = 0) {
  const tok = await engine.prepare(p);
  if (!engine.commit(tok, { when })) throw new Error('commit refused');
}
function mono(buf) {
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const out = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) out[i] = 0.5 * (L[i] + R[i]);
  return out;
}
function rms(d, sr, a, b) {
  const i0 = Math.max(0, Math.floor(a * sr));
  const i1 = Math.min(d.length, Math.floor(b * sr));
  let s = 0;
  for (let i = i0; i < i1; i++) s += d[i] * d[i];
  return Math.sqrt(s / Math.max(1, i1 - i0));
}
function peakAbs(d, sr, a, b) {
  let m = 0;
  for (let i = Math.floor(a * sr); i < Math.min(d.length, Math.floor(b * sr)); i++) m = Math.max(m, Math.abs(d[i]));
  return m;
}
/** Minimum 10 ms-window RMS (dBFS) over [a, b]. */
function minWindowDb(d, sr, a, b, win = 0.01) {
  let min = Infinity;
  let at = a;
  for (let t = a; t + win <= b; t += win) {
    const v = db(rms(d, sr, t, t + win));
    if (v < min) {
      min = v;
      at = t;
    }
  }
  return { min, at };
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}
/** Magnitude spectrum of [a,b] (Hann, zero-padded to n). */
function spectrum(d, sr, a, b, n = 32768) {
  const i0 = Math.floor(a * sr);
  const len = Math.min(n, Math.floor((b - a) * sr));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < len; i++) re[i] = d[i0 + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1)));
  fft(re, im);
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return { mag, binHz: sr / n };
}
/** Peak frequency with parabolic interpolation (log magnitude). */
function peakHz(d, sr, a, b, lo = 30, hi = 5000) {
  const { mag, binHz } = spectrum(d, sr, a, b);
  let k = 0;
  let m = -1;
  for (let i = Math.ceil(lo / binHz); i < Math.min(mag.length - 1, hi / binHz); i++) if (mag[i] > m) { m = mag[i]; k = i; }
  const y0 = Math.log(mag[k - 1] + 1e-20), y1 = Math.log(mag[k] + 1e-20), y2 = Math.log(mag[k + 1] + 1e-20);
  const p = (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2);
  return (k + p) * binHz;
}
function bandMag(d, sr, a, b, f) {
  const { mag, binHz } = spectrum(d, sr, a, b);
  const k = Math.round(f / binHz);
  let m = 0;
  for (let i = k - 3; i <= k + 3; i++) m = Math.max(m, mag[i]);
  return m;
}
/**
 * Click detector (SPEC §11): flags samples where the first difference exceeds 6 × its local median. It must also
 * exceed 4.5 × the local RMS of the first difference: for dense chords (≈ Gaussian) max/median alone reaches 6 by
 * chance, a real click is far above both. (A second-difference "HF" variant was tried and rejected: it fires on
 * the corners of band-limited triangle waves.) Positive control: clickDetectorSelfTest.
 */
function clicks(d, sr, a, b, floor = 1e-3) {
  const i0 = Math.max(2, Math.floor(a * sr));
  const i1 = Math.min(d.length, Math.floor(b * sr));
  const n = i1 - i0;
  const d1 = new Float32Array(n);
  const d2 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = i0 + i;
    d1[i] = Math.abs(d[k] - d[k - 1]);
    d2[i] = Math.abs(d[k] - 2 * d[k - 1] + d[k - 2]);
  }
  const found = [];
  for (const h of [d1]) {
    const B = 256;
    const nb = Math.ceil(n / B);
    const med = new Float64Array(nb);
    const ms = new Float64Array(nb);
    for (let bi = 0; bi < nb; bi++) {
      const seg = Array.from(h.subarray(bi * B, Math.min(n, (bi + 1) * B)));
      let q = 0;
      for (const v of seg) q += v * v;
      seg.sort((x, y) => x - y);
      med[bi] = seg[seg.length >> 1] || 0;
      ms[bi] = seg.length ? q / seg.length : 0;
    }
    for (let i = 0; i < n; i++) {
      const bi = Math.floor(i / B);
      const lo = Math.max(0, bi - 4);
      const hi = Math.min(nb - 1, bi + 4);
      const cand = Array.from(med.subarray(lo, hi + 1)).sort((x, y) => x - y);
      const lm = cand[cand.length >> 1];
      let q = 0;
      for (let k = lo; k <= hi; k++) q += ms[k];
      const lr = Math.sqrt(q / (hi - lo + 1));
      if (h[i] > floor && h[i] > 6 * lm && h[i] > 4.5 * lr) {
        found.push({ t: (i0 + i) / sr, dd: h[i], lm, order: h === d1 ? 1 : 2 });
        i += B;
      }
    }
  }
  return found.sort((x, y) => x.t - y.t);
}
/** Injects an impulse into the FX sum at `at`; returns (rendered) => master-chain latency in seconds. */
function chainLatencyProbe(e, at) {
  const b = new AudioBuffer({ length: 4, numberOfChannels: 1, sampleRate: e.ctx.sampleRate });
  b.getChannelData(0)[0] = 0.5;
  const s = new AudioBufferSourceNode(e.ctx, { buffer: b });
  s.connect(e.fx.sum);
  s.start(at);
  return (d) => {
    const sr = e.ctx.sampleRate;
    for (let i = Math.floor(at * sr); i < d.length; i++) if (Math.abs(d[i]) > 1e-4) return i / sr - at;
    return 0;
  };
}
const settle = () => new Promise((r) => setTimeout(r, 60));
function centroid(d, sr, a, b) {
  const { mag, binHz } = spectrum(d, sr, a, b, 16384);
  let s = 0, w = 0;
  for (let i = 1; i < mag.length; i++) { s += mag[i] * i * binHz; w += mag[i]; }
  return s / w;
}

// ----- offline suites --------------------------------------------------------------------------------------------
export const offline = {
  async sustainDeferral() {
    const run = async (pedal) => {
      const ctx = mkCtx(2.5);
      const e = await mkEngine(ctx);
      await use(e, patch({ 0: slot('synth', 'sub-bass') }));
      if (pedal) e.sustain(true, { when: 0.1 });
      e.noteOn(60, 100, { when: 0.2 });
      e.noteOff(60, { when: 0.5 });
      if (pedal) e.sustain(false, { when: 1.5 });
      const d = mono(await ctx.startRendering());
      return { mid: db(rms(d, SR, 1.0, 1.4)), end: db(rms(d, SR, 2.1, 2.5)) };
    };
    const withPedal = await run(true);
    const without = await run(false);
    const pass = withPedal.mid > -40 && withPedal.end < -90 && without.mid < -90;
    return { pass, withPedal, without };
  },

  async restrike() {
    const ctx = mkCtx(1.6);
    const e = await mkEngine(ctx);
    await use(e, patch({ 0: slot('synth', 'sub-bass', { params: { tri: 0 } }) }));
    e.sustain(true, { when: 0.05 });
    e.noteOn(60, 100, { when: 0.2 });
    e.noteOff(60, { when: 0.4 });
    e.noteOn(60, 100, { when: 0.7 });
    e.noteOff(60, { when: 0.9 });
    const d = mono(await ctx.startRendering());
    await settle();
    const st = e._debugStats();
    const first = db(rms(d, SR, 0.4, 0.65));
    const second = db(rms(d, SR, 1.0, 1.5));
    const pass = st.voices === 1 && e.pedaled.size === 1 && Math.abs(first - second) < 1.5;
    return { pass, voices: st.voices, pedaled: e.pedaled.size, firstDb: first, secondDb: second };
  },

  async monoLowest() {
    const ctx = mkCtx(2.7);
    const e = await mkEngine(ctx);
    await use(e, patch({ 3: slot('synth', 'sub-bass', { mono: 'lowest', params: { tri: 0 } }) }));
    e.noteOn(48, 100, { when: 0.1 });
    e.noteOn(55, 100, { when: 0.5 }); // higher: must not change the pitch
    e.noteOn(43, 100, { when: 0.9 });
    e.noteOff(43, { when: 1.7 });
    const d = mono(await ctx.startRendering());
    const f1 = peakHz(d, SR, 0.25, 0.85);
    const f2 = peakHz(d, SR, 1.1, 1.65);
    const f3 = peakHz(d, SR, 1.95, 2.6);
    const ok = (f, midi) => Math.abs(f / (440 * 2 ** ((midi - 69) / 12)) - 1) < 0.005;
    return { pass: ok(f1, 48) && ok(f2, 43) && ok(f3, 48), f1, f2, f3 };
  },

  async split() {
    const ctx = mkCtx(1);
    const e = await mkEngine(ctx);
    await use(e, patch({ 0: slot('synth', 'soft-keys', { lowNote: 60 }), 3: slot('synth', 'sub-bass', { highNote: 59, mono: 'off' }) }));
    e.noteOn(50, 100, { when: 0.1 });
    e.noteOn(72, 100, { when: 0.1 });
    e.setTranspose(12);
    e.noteOn(55, 100, { when: 0.2 }); // physical 55 → bass slot even though it sounds 67
    const s50 = e.sounding.get(50).map((x) => x.slotIndex);
    const s72 = e.sounding.get(72).map((x) => x.slotIndex);
    const s55 = e.sounding.get(55).map((x) => [x.slotIndex, x.soundingNote]);
    e.setTranspose(0);
    e.noteOff(55, { when: 0.5 }); // released voices are exactly those recorded at noteOn
    const pass = s50.join() === '3' && s72.join() === '0' && s55.length === 1 && s55[0][0] === 3 && s55[0][1] === 67 && !e.sounding.has(55);
    await ctx.startRendering();
    return { pass, s50, s72, s55 };
  },

  async transposeFFT() {
    const ctx = mkCtx(3.3);
    const e = await mkEngine(ctx);
    await use(e, patch({ 0: slot('synth', 'sub-bass', { params: { tri: 0 }, highNote: 127, mono: 'off' }) }));
    const cases = [
      { tr: 3, play: 57, expect: 60 }, // A3 → C4
      { tr: -6, play: 57, expect: 51 }, // tritone
      { tr: 1, play: 59, expect: 60 }, // octave boundary B3 → C4
      { tr: 17, play: 55, expect: 72 }, // +octave + 4th
    ];
    cases.forEach((c, i) => {
      e.setTranspose(c.tr);
      e.noteOn(c.play, 100, { when: 0.05 + i * 0.8 });
      e.noteOff(c.play, { when: 0.75 + i * 0.8 });
    });
    const d = mono(await ctx.startRendering());
    const res = cases.map((c, i) => {
      const f = peakHz(d, SR, 0.15 + i * 0.8, 0.7 + i * 0.8);
      const want = 440 * 2 ** ((c.expect - 69) / 12);
      return { ...c, f, want, err: f / want - 1 };
    });
    return { pass: res.every((r) => Math.abs(r.err) < 0.005), res };
  },

  async gaplessSwitch() {
    const ctx = mkCtx(9);
    const e = await mkEngine(ctx);
    const A = patch({ 1: slot('synth', 'warm-pad', { sends: { reverb: 0.5, delay: 0.15, chorus: 0.4 } }) }, { reverb: { size: 0.5 } });
    const B = patch({ 0: slot('sampler', 'test-keys'), 1: slot('synth', 'bell') }, { reverb: { size: 0.3 } });
    await use(e, A, 0);
    for (const n of [60, 64, 67]) e.noteOn(n, 100, { when: 0.1 });
    const oldInst = e.slots[1].inst;
    const tok = await e.prepare(B);
    const committed = e.commit(tok, { when: 1.5 });
    const stale = e.commit(tok, { when: 1.6 }); // double commit refused
    e.noteOn(72, 100, { when: 2.0 });
    const newGoesToNew = e.sounding.get(72).every((x) => x.instrument !== oldInst);
    const heldOnOld = e.sounding.get(60).some((x) => x.instrument === oldInst);
    e.noteOff(72, { when: 2.3 });
    for (const n of [60, 64, 67]) e.noteOff(n, { when: 3.0 });
    const d = mono(await ctx.startRendering());
    await settle();
    const w = minWindowDb(d, SR, 0.6, 3.0);
    const cl = clicks(d, SR, 1.3, 2.0);
    const st = e._debugStats();
    const pass = committed && !stale && newGoesToNew && heldOnOld && w.min > -60 && st.retiring === 0 && cl.length === 0;
    return { pass, minWindowDb: w.min, at: w.at, committed, stale, newGoesToNew, heldOnOld, retiringAfter: st.retiring, clicks: cl.slice(0, 3) };
  },

  async supersededPrepare() {
    const ctx = mkCtx(0.5);
    const e = await mkEngine(ctx);
    const p1 = e.prepare(patch({ 0: slot('sampler', 'test-keys') }));
    const p2 = e.prepare(patch({ 0: slot('synth', 'bell') }));
    const [t1, t2] = await Promise.all([p1, p2]);
    const c1 = e.commit(t1);
    const c2 = e.commit(t2);
    const ok = !c1 && c2 && e.slots[0].ref.id === 'bell';
    await ctx.startRendering();
    return { pass: ok, c1, c2 };
  },

  async lofiBypassExact() {
    const render = async (lofi) => {
      const ctx = mkCtx(3);
      const e = await mkEngine(ctx, { lofi });
      await use(e, patch({ 0: slot('sampler', 'test-keys', { sends: { reverb: 0.3, delay: 0.2, chorus: 0.2 } }), 1: slot('synth', 'warm-pad', { sends: { reverb: 0.5, delay: 0.1, chorus: 0.4 } }) }));
      for (const n of [60, 64, 67]) e.noteOn(n, 90, { when: 0.1 });
      for (const n of [60, 64, 67]) e.noteOff(n, { when: 1.5 });
      return mono(await ctx.startRendering());
    };
    const a = await render(true);
    const b = await render(false);
    const a2 = await render(true);
    let maxDiff = 0;
    let selfDiff = 0;
    for (let i = 0; i < a.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
      selfDiff = Math.max(selfDiff, Math.abs(a[i] - a2[i]));
    }
    const level = db(rms(a, SR, 0.5, 1.5));
    // engaged then bypassed → wet chain disconnected again; lofi 1 darkens (centroid drops)
    const ctx = mkCtx(2);
    const e = await mkEngine(ctx);
    await use(e, patch({ 1: slot('synth', 'soft-keys', { params: { tone: 1, tri: 1 } }) }));
    e.noteOn(96, 100, { when: 0.05 });
    e.noteOn(84, 100, { when: 0.05 });
    e.setParam('fx.lofi.amount', 1, { when: 0.6 });
    e.setParam('fx.lofi.amount', 0, { when: 1.2 });
    const d = mono(await ctx.startRendering());
    await settle();
    const cOff = centroid(d, SR, 0.2, 0.55);
    const cOn = centroid(d, SR, 0.75, 1.15);
    const disconnected = e.fx.lofi._wetConnected === false && e.fx.lofi.engaged === false;
    // Chromium's offline renderer differs by ~1 ULP between *identical* renders (selfDiff), so "sample-exact" is
    // judged at float-noise level (≤ 2e-6 ≈ −114 dBFS) plus the structural check that the wet chain is detached.
    const neverBuilt = e.fx.lofi && !e.fx.lofi._wetConnected;
    const pass = maxDiff <= 2e-6 && level > -60 && disconnected && neverBuilt && Math.abs(cOn / cOff - 1) > 0.05;
    return { pass, maxDiff, selfDiff, levelDb: level, disconnected, centroidOff: cOff, centroidOn: cOn };
  },

  async delaySync() {
    const ctx = mkCtx(2.5);
    const e = await mkEngine(ctx);
    await use(e, patch({ 0: slot('synth', 'soft-keys', { sends: { reverb: 0, delay: 1, chorus: 0 } }) }, { delay: { sync: '1/8', feedback: 0.3, returnGain: 1 } }));
    e.setTempo(120); // 1/8 = 0.25 s
    const t = e.fx.delay.effectiveTime();
    const line = e.fx.delay.active.time;
    await ctx.startRendering();
    return { pass: Math.abs(t - 0.25) < 1e-9 && Math.abs(line - 0.25) < 1e-9, effectiveTime: t, lineTime: line };
  },

  async reverbSizeNoClick() {
    const ctx = mkCtx(4.5);
    const e = await mkEngine(ctx);
    await use(e, patch({ 1: slot('synth', 'warm-pad', { sends: { reverb: 0.8, delay: 0, chorus: 0 } }) }, { reverb: { size: 0.3 } }));
    for (const n of [57, 60, 64]) e.noteOn(n, 100, { when: 0.05 });
    e.setParam('fx.reverb.size', 0.9, { when: 1.5 });
    e.setParam('fx.reverb.size', 0.95, { when: 1.55 }); // debounced: only the last one is built
    const d = mono(await ctx.startRendering());
    const cl = clicks(d, SR, 1.2, 4.4);
    const key = e.fx.reverb.active.key;
    return { pass: cl.length === 0 && key.startsWith('8|'), clicks: cl.slice(0, 5), activeIR: key };
  },

  async stuckNoteFuzz() {
    const T = 20;
    const TAIL = 13;
    const ctx = mkCtx(T + TAIL, 32000);
    const e = await mkEngine(ctx);
    const rnd = (() => { let s = 12345; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
    const patches = [
      patch({ 0: slot('sampler', 'test-keys', { sends: { reverb: 0.3, delay: 0.2, chorus: 0 } }), 1: slot('synth', 'warm-pad', { sends: { reverb: 0.5, delay: 0.1, chorus: 0.3 } }), 3: slot('synth', 'sub-bass', { mono: 'lowest', highNote: 59 }) }, { reverb: { size: 0.5 } }),
      patch({ 0: slot('synth', 'soft-keys', { lowNote: 55, sends: { reverb: 0.4, delay: 0.3, chorus: 0 } }), 2: slot('synth', 'bell', { sustain: false }) }, { reverb: { size: 0.3 }, delay: { time: 0.5 } }),
      patch({ 1: slot('synth', 'strings', { mono: 'highest' }), 2: slot('sampler', 'test-mp3', { octave: 1 }) }, { reverb: { size: 0.4 } }),
    ];
    await use(e, patches[0], 0);
    const times = Array.from({ length: 2000 }, () => rnd() * T).sort((a, b) => a - b);
    const counts = {};
    let pi = 0;
    for (const t of times) {
      const r = rnd();
      let kind;
      if (r < 0.4) { kind = 'on'; e.noteOn(36 + Math.floor(rnd() * 48), 1 + Math.floor(rnd() * 126), { when: t }); }
      else if (r < 0.78) {
        kind = 'off';
        const held = [...e.held];
        const n = held.length && rnd() < 0.9 ? held[Math.floor(rnd() * held.length)] : 36 + Math.floor(rnd() * 48);
        e.noteOff(n, { when: t });
      } else if (r < 0.88) { kind = 'pedal'; e.sustain(rnd() < 0.5, { when: t }); }
      else if (r < 0.92) { kind = 'transpose'; e.setTranspose(Math.floor(rnd() * 13) - 6); }
      else if (r < 0.95) { kind = 'bend'; e.pitchBend(rnd() * 2 - 1, { when: t }); }
      else if (r < 0.985) {
        kind = 'song';
        pi = (pi + 1) % patches.length;
        const tok = await e.prepare(patches[pi]);
        e.commit(tok, { when: t });
      } else { kind = 'panic'; e.allNotesOff({ when: t }); }
      counts[kind] = (counts[kind] || 0) + 1;
    }
    for (const n of [...e.held]) e.noteOff(n, { when: T });
    e.sustain(false, { when: T });
    e.pitchBend(0, { when: T });
    const d = mono(await ctx.startRendering());
    await settle();
    const st = e._debugStats();
    const tailDb = db(peakAbs(d, 32000, T + TAIL - 0.5, T + TAIL));
    // node-leak check: a fresh engine with the same final patch and nothing played has the same node count
    const bctx = mkCtx(0.1, 32000);
    const base = await mkEngine(bctx);
    await use(base, patches[pi], 0);
    await bctx.startRendering();
    await settle();
    const baseNodes = base._debugStats().nodes;
    const pass = st.voices === 0 && e.sounding.size === 0 && e.pedaled.size === 0 && tailDb < -90 && st.retiring === 0 && st.nodes === baseNodes;
    return { pass, counts, stats: st, baselineNodes: baseNodes, tailPeakDb: tailDb };
  },

  async droneKeyChange() {
    const ctx = mkCtx(7.5);
    const e = await mkEngine(ctx);
    e.drone.configure({ mode: 'synth', gain: 1 }, { when: 0 });
    e.drone.setKey(0, { when: 0 });
    const noop = e.drone.setKey(0, { when: 1 }); // same key → no-op
    e.drone.setKey(7, { when: 3, fade: 3 });
    const d = mono(await ctx.startRendering());
    await settle();
    const w = minWindowDb(d, SR, 2.2, 7.4);
    const cl = clicks(d, SR, 2.5, 7.0);
    const fC = bandMag(d, SR, 1.5, 2.9, 130.81);
    const fG = bandMag(d, SR, 6.5, 7.4, 98);
    const layers = e.drone.layers.length;
    return { pass: w.min > -60 && cl.length === 0 && noop === false && layers === 1 && fC > 0 && fG > 0, minWindowDb: w.min, clicks: cl.slice(0, 3), layersAfter: layers, noop };
  },

  async droneChordFollow() {
    const ctx = mkCtx(3.2);
    const e = await mkEngine(ctx);
    e.drone.configure({ mode: 'synth', chordFollow: true }, { when: 0 });
    e.drone.setKey(2, { when: 0 });
    const snaps = [];
    for (const n of [50, 54, 57]) e.noteOn(n, 90, { when: 0.5 });
    e.at(1.4, () => snaps.push(e.drone._debugTargets()));
    for (const n of [50, 54, 57]) e.noteOff(n, { when: 1.5 });
    e.noteOn(43, 90, { when: 1.6 }); // G2
    e.noteOn(47, 90, { when: 1.6 }); // B2
    e.noteOn(50, 90, { when: 1.6 }); // D3
    e.noteOn(79, 90, { when: 1.6 }); // melody note above the split is ignored
    e.at(3.0, () => snaps.push(e.drone._debugTargets()));
    await ctx.startRendering();
    const pcs = (fs) => (fs ? [...new Set(fs.map((f) => ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12))].sort((a, b) => a - b) : null);
    const p1 = pcs(snaps[0]);
    const p2 = pcs(snaps[1]);
    const has = (p, want) => p && want.every((x) => p.includes(x));
    // pure voicing function sanity: 1 pc → hold (null)
    const hold = followVoicing([50, 62], null);
    return { pass: has(p1, [2, 6, 9]) && has(p2, [7, 11, 2]) && !p2.includes(4) && hold === null, dChord: p1, gChord: p2 };
  },

  async bendPitch() {
    const ctx = mkCtx(2.2);
    const e = await mkEngine(ctx);
    await use(e, patch({ 0: slot('synth', 'sub-bass', { params: { tri: 0 }, bendEnabled: true }), 2: slot('sampler', 'test-keys', { lowNote: 100 }) }, {}, { bend: { mode: 'pitch', range: 2 } }));
    e.noteOn(57, 100, { when: 0.05 });
    e.pitchBend(1, { when: 0.8 });
    e.pitchBend(0, { when: 1.5 });
    const d = mono(await ctx.startRendering());
    const f0 = peakHz(d, SR, 0.2, 0.75);
    const f1 = peakHz(d, SR, 0.9, 1.45);
    const f2 = peakHz(d, SR, 1.6, 2.15);
    const r = f1 / f0;
    const samplerIgnores = e.slots[2].inst.bend === 0; // sampler slot has bendEnabled false by default
    return { pass: Math.abs(r / 2 ** (2 / 12) - 1) < 0.005 && Math.abs(f2 / f0 - 1) < 0.005 && samplerIgnores, f0, f1, f2, samplerIgnores };
  },

  async chordReadout() {
    const ctx = mkCtx(0.5);
    const e = await mkEngine(ctx);
    await use(e, patch({ 0: slot('synth', 'soft-keys') }));
    const seen = [];
    e.addEventListener('chord', (ev) => seen.push(ev.detail.chord?.name ?? null));
    e.setKeyContext(0, false);
    for (const n of [52, 60, 67]) e.noteOn(n, 90, { when: 0.1 }); // E C G → C/E
    const c1 = e.heldChord()?.name;
    e.setKeyContext(6, false); // F# major prefers sharps
    e.noteOff(52, { when: 0.2 });
    e.noteOff(60, { when: 0.2 });
    e.noteOff(67, { when: 0.2 });
    for (const n of [61, 65, 68]) e.noteOn(n, 90, { when: 0.3 });
    const c2 = e.heldChord()?.name;
    e.noteOff(61);
    e.noteOff(65); // one note left → its name
    const c3 = e.heldChord()?.name;
    e.noteOff(68);
    const vel = [e.constructor.name, (await import('/js/engine/audio.js')).curveVelocity];
    const cv = vel[1];
    const curves = [cv(64, 'soft'), cv(64, 'normal'), cv(64, 'hard'), cv(10, 'fixed')];
    await ctx.startRendering();
    return { pass: c1 === 'C/E' && c2 === 'C#' && c3 === 'G#' && seen.at(-1) === null && curves[0] > curves[1] && curves[1] > curves[2] && Math.abs(curves[3] - 100 / 127) < 1e-9, c1, c2, c3, seen, curves };
  },

  async preloadAndLRU() {
    const ctx = mkCtx(0.5);
    const e = await mkEngine(ctx, { cacheMB: 0.5 }); // tiny cap: every unpinned, unreferenced buffer is evictable
    const P = patch({ 0: slot('sampler', 'test-keys') });
    const loads = [];
    e.addEventListener('ready', (ev) => loads.push(ev.detail.phase));
    await e.preload([P]);
    const pinned = e.cache.pinned.size;
    const afterPreload = e.cache.entries.size;
    // decoding another instrument (not pinned) over the cap does not evict the pinned set
    await use(e, patch({ 0: slot('sampler', 'test-mp3') }));
    await use(e, patch({ 0: slot('synth', 'bell') })); // test-mp3 retired; its buffer becomes evictable once disposed
    const pinnedStill = [...e.cache.pinned].every((u) => e.cache.entries.has(u));
    await ctx.startRendering();
    return { pass: pinned === 4 && afterPreload === 4 && pinnedStill && loads.includes('preload') && e.cache.decodedMB > 0, pinned, afterPreload, pinnedStill, decodedMB: e.cache.decodedMB };
  },

  async droneSongChangeAndFiles() {
    const run = async (cont) => {
      const ctx = mkCtx(4);
      const e = await mkEngine(ctx);
      await use(e, patch({ 0: slot('synth', 'soft-keys') }));
      e.drone.configure({ mode: 'synth', gain: 1, fade: 1, continueAcrossSongs: cont }, { when: 0 });
      e.drone.setKey(0, { when: 0 });
      const tok = await e.prepare(patch({ 0: slot('synth', 'bell') }));
      e.commit(tok, { when: 2 });
      e.drone.setKey(0, { when: 2 }); // controller re-sends the same key after the switch
      const d = mono(await ctx.startRendering());
      return { before: db(rms(d, SR, 1.7, 1.95)), after: db(rms(d, SR, 3.5, 3.9)), min: minWindowDb(d, SR, 1.8, 3.9).min };
    };
    const keep = await run(true);
    const restart = await run(false);
    // file mapping (no media needed): minor → relative-major file when enabled
    const ctx = mkCtx(0.2);
    const e = await mkEngine(ctx);
    e.drone.attachFiles([{ name: 'Pad - C.mp3', url: 'c' }, { name: 'Ambient_Pad_-_F#m.mp3', url: 'fsm' }, { name: 'Pad E flat.mp3', url: 'eb' }, { name: 'random.mp3', url: 'x' }]);
    const map = {
      Am: e.drone._fileFor({ pc: 9, minor: true })?.url, // relative major C
      'F#m': e.drone._fileFor({ pc: 6, minor: true })?.url, // relative major A missing → F#m file
      A: e.drone._fileFor({ pc: 9, minor: false })?.url, // A major → relative minor F#m
      Eb: e.drone._fileFor({ pc: 3, minor: false })?.url,
      D: e.drone._fileFor({ pc: 2, minor: false }) ?? null,
    };
    e.drone.cfg.minorUsesRelativeMajorFile = false;
    map['Am(noRel)'] = e.drone._fileFor({ pc: 9, minor: true })?.url;
    const warns = [];
    e.addEventListener('warn', (ev) => warns.push(ev.detail.message));
    e.drone.configure({ mode: 'files' }); // offline → warns, falls back to the synth drone
    e.drone.setKey(0);
    await ctx.startRendering();
    const fellBack = e.drone.effectiveMode === 'synth' && warns.some((w) => /files mode unavailable/.test(w));
    const pass =
      keep.min > -60 && Math.abs(keep.after - keep.before) < 3 && restart.after > -60 && restart.min > -80 &&
      map.Am === 'c' && map['F#m'] === 'fsm' && map.A === 'fsm' && map.Eb === 'eb' && map.D === null && map['Am(noRel)'] === 'c' && fellBack;
    return { pass, keep, restart, map, fellBack };
  },

  async clicksStealsDelay() {
    const ctx = mkCtx(5);
    const e = await mkEngine(ctx);
    await use(e, patch({ 1: slot('synth', 'strings', { sends: { reverb: 0, delay: 0.5, chorus: 0 } }) }, { delay: { time: 0.3, feedback: 0.5 } }));
    e.sustain(true, { when: 0.05 });
    // 24 notes into a 16-voice instrument → 8 steals (20 ms fades)
    for (let i = 0; i < 24; i++) {
      e.noteOn(48 + ((i * 7) % 29), 90, { when: 0.1 + i * 0.08 });
      e.noteOff(48 + ((i * 7) % 29), { when: 0.15 + i * 0.08 });
    }
    e.setParam('fx.delay.time', 0.45, { when: 2.8 }); // > 5 % → line crossfade, not a pitch-warping glide
    e.setParam('fx.delay.time', 0.46, { when: 3.4 }); // ≤ 5 % → short glide
    e.sustain(false, { when: 4.5 });
    const d = mono(await ctx.startRendering());
    const cl = clicks(d, SR, 0.5, 4.4);
    const lines = e.fx.delay.lines.map((l) => [l.state, +l.time.toFixed(3)]);
    return { pass: cl.length === 0 && e.fx.delay.active.time === 0.46, clicks: cl.slice(0, 4), lines };
  },

  async intensityMacroAndBrightness() {
    const ctx = mkCtx(1.5);
    const e = await mkEngine(ctx);
    await use(e, patch({ 1: slot('synth', 'warm-pad') }, {}, { modWheel: { target: 'macro.intensity', min: 0, max: 1 } }));
    e.setWheel('mod', 0, { when: 0.1 });
    e.drone.configure({ mode: 'synth', brightness: 0.8 }, { when: 0 });
    e.drone.setKey(4, { when: 0 });
    let slotW, revW, voices;
    e.at(0.5, () => {
      slotW = e.slots[1].strip.wheel.gain.value;
      revW = e.fx.reverb.wheel.gain.value;
      voices = e.drone.layers.find((l) => !l.dead)?.voices.length;
    });
    e.at(0.9, () => e.drone.setParam('brightness', 0.3, 0.9));
    let voices2;
    e.at(1.2, () => (voices2 = e.drone.layers.find((l) => !l.dead)?.voices.length));
    await ctx.startRendering();
    return { pass: Math.abs(slotW - 0.35) < 0.01 && Math.abs(revW - 0.8) < 0.01 && voices === 4 && voices2 === 3 && e.slots[1].morph === 0, slotW, revW, droneVoicesBright: voices, droneVoicesDark: voices2 };
  },

  async clickDetectorSelfTest() {
    // positive control: a 3-note pad + reverb, plus one sine hard-stopped (no fade) at its peak
    const ctx = mkCtx(3);
    const e = await mkEngine(ctx);
    await use(e, patch({ 1: slot('synth', 'warm-pad', { params: { tri: 0 }, sends: { reverb: 0.3, delay: 0, chorus: 0 } }) }));
    for (const n of [57, 60, 64]) e.noteOn(n, 90, { when: 0.05 });
    const o = new OscillatorNode(ctx, { frequency: 330 });
    const g = new GainNode(ctx, { gain: 0.08 });
    o.connect(g).connect(e.fx.sum);
    o.start(0.5);
    o.stop(0.5 + 495.25 / 330); // stops at a crest → full-amplitude step (≈ −28 dBFS under a ≈ −20 dBFS pad)
    const d = mono(await ctx.startRendering());
    const hit = clicks(d, SR, 1.0, 2.9);
    const quiet = clicks(d, SR, 1.0, 1.95);
    return { pass: hit.length >= 1 && Math.abs(hit[0].t - 2.0) < 0.02 && quiet.length === 0, hits: hit.slice(0, 3), stepDb: db(0.08 * 0.5) };
  },

  async bendModes() {
    const ctx = mkCtx(9);
    const e = await mkEngine(ctx);
    const warns = [];
    e.addEventListener('warn', (ev) => warns.push(ev.detail.message));
    await use(e, patch({ 1: slot('synth', 'warm-pad') }, {}, { bend: { mode: 'drone-swell', range: 2 } }));
    e.drone.configure({ mode: 'synth', gain: 0.3 }, { when: 0 });
    e.drone.setKey(0, { when: 0 });
    e.noteOn(64, 100, { when: 0.1 });
    let g = {};
    e.pitchBend(1, { when: 1.0 });
    e.at(1.8, () => (g.swellUp = e.drone.bendGain.gain.value));
    e.pitchBend(0, { when: 2.0 });
    e.at(2.5, () => (g.fallingSlowly = e.drone.bendGain.gain.value));
    e.pitchBend(-1, { when: 3.0 });
    e.at(3.8, () => (g.ducked = e.drone.bendGain.gain.value));
    e.pitchBend(0, { when: 4.0 });
    e.at(4.1, () => e.setRouting({ bend: { mode: 'tape' } }, { when: 4.1 }));
    e.at(4.2, () => e.pitchBend(-0.8, { when: 4.2 }));
    e.at(5.0, () => { g.tapeEngaged = e.fx.lofi.engaged; g.tapeDelay = e.fx.lofi.tape.delayTime.value; e.pitchBend(0, { when: 5.0 }); });
    e.at(6.3, () => { g.tapeReleased = !e.fx.lofi.engaged; e.setRouting({ bend: { mode: 'morph' } }, { when: 6.3 }); e.pitchBend(1, { when: 6.4 }); });
    e.at(7.0, () => (g.morph = e.slots[1].morph));
    const d = mono(await ctx.startRendering());
    let finite = true;
    for (const x of d) if (!Number.isFinite(x)) { finite = false; break; }
    const pass = finite && g.swellUp > 2 && g.fallingSlowly > 1.2 && Math.abs(g.ducked - 0.3) < 0.05 && g.tapeEngaged && g.tapeDelay > 0.1 && g.tapeReleased && g.morph === 1 && warns.length === 0;
    return { pass, ...g, finite, warns };
  },

  async sampler() {
    const ctx = mkCtx(6);
    const e = await mkEngine(ctx);
    await use(e, patch({ 0: slot('sampler', 'test-keys'), 2: slot('sampler', 'test-mp3', { lowNote: 100 }) }));
    e.noteOn(60, 110, { when: 0.5 }); // loud layer, onset trim
    e.noteOff(60, { when: 1.2 });
    e.noteOn(60, 30, { when: 1.5 }); // soft layer
    e.noteOff(60, { when: 2.2 });
    e.noteOn(62, 30, { when: 2.5 }); // repitch C4 → D4
    e.noteOff(62, { when: 3.2 });
    e.noteOn(93, 30, { when: 3.5 }); // ≥ 90 ignores release
    e.noteOff(93, { when: 3.6 });
    const chainLat = chainLatencyProbe(e, 5.5);
    const d = mono(await ctx.startRendering());
    const lat = chainLat(d);
    let onset = null;
    for (let i = Math.floor(0.5 * SR); i < 0.7 * SR; i++) if (Math.abs(d[i]) > 1e-3) { onset = i / SR - 0.5 - lat; break; }
    const h1 = bandMag(d, SR, 0.6, 1.15, 3 * 261.63) / bandMag(d, SR, 0.6, 1.15, 261.63);
    const h2 = bandMag(d, SR, 1.6, 2.15, 3 * 261.63) / bandMag(d, SR, 1.6, 2.15, 261.63);
    const f = peakHz(d, SR, 2.6, 3.15);
    const fErr = f / 293.66 - 1;
    const ringing = db(rms(d, SR, 3.8, 4.1));
    // mp3 onset trim via a direct instrument
    const ctx2 = mkCtx(1.5);
    const e2 = await mkEngine(ctx2);
    await use(e2, patch({ 0: slot('sampler', 'test-mp3') }));
    e2.noteOn(60, 100, { when: 0.5 });
    const d2 = mono(await ctx2.startRendering());
    let onset2 = null;
    for (let i = Math.floor(0.5 * SR); i < 0.8 * SR; i++) if (Math.abs(d2[i]) > 1e-3) { onset2 = i / SR - 0.5 - lat; break; }
    // missing sample → warn once, instrument still plays
    const ctx3 = mkCtx(1);
    const e3 = await mkEngine(ctx3);
    const warns = [];
    e3.addEventListener('warn', (ev) => warns.push(ev.detail.message));
    await use(e3, patch({ 0: slot('sampler', 'test-missing') }));
    e3.noteOn(62, 100, { when: 0.1 });
    const d3 = mono(await ctx3.startRendering());
    const missingWarned = warns.filter((w) => /D4/.test(w)).length === 1;
    const plays = db(rms(d3, SR, 0.3, 0.8)) > -50;
    // polyphony: 32 voices for sampled instruments (pedalled piano); the 33rd+ note steals (oldest released first)
    const ctx4 = mkCtx(1.5);
    const e4 = await mkEngine(ctx4);
    await use(e4, patch({ 0: slot('sampler', 'test-keys') }));
    const inst4 = e4.slots[0].inst;
    const count = () => {
      const vs = [...inst4.alloc.voices];
      return { playing: vs.filter((v) => v.state === 'held' || v.state === 'released').length, killed: vs.filter((v) => v.state === 'killed').length };
    };
    const poly = { max: inst4.alloc.max };
    e4.sustain(true, { when: 0.05 });
    for (let i = 0; i < 40; i++) { // allocation happens at call time, so count right after each noteOn
      e4.noteOn(36 + i, 90, { when: 0.1 + i * 0.01 });
      e4.noteOff(36 + i, { when: 0.105 + i * 0.01 });
      if (i === 31) poly.at32 = count();
      if (i === 39) poly.at40 = count();
    }
    await ctx4.startRendering();
    await settle();
    const polyOk = poly.max === 32 && poly.at32.playing === 32 && poly.at32.killed === 0 && poly.at40.playing === 32 && poly.at40.killed === 8;
    const pass =
      onset !== null && onset < 0.004 && h1 > 0.4 && h2 < 0.01 && Math.abs(fErr) < 0.005 && ringing > -60 && onset2 !== null && onset2 < 0.004 && missingWarned && plays && e.cache.decodedMB > 0 && polyOk;
    return { pass, chainLatencyMs: lat * 1000, onsetMs: onset * 1000, mp3OnsetMs: onset2 * 1000, loudH3ratio: h1, softH3ratio: h2, repitchHz: f, fErr, ringingDb: ringing, missingWarned, plays, decodedMB: e.cache.decodedMB, poly };
  },

  async macrosAndWheel() {
    const ctx = mkCtx(3);
    const e = await mkEngine(ctx);
    await use(e, patch({ 1: slot('synth', 'warm-pad') }, {}, { modWheel: { target: 'slots.1.gain', min: 0, max: 1 } }));
    const init = e.slots[1].strip.wheel.gain.value; // lastWheel initial 1.0 → no effect
    e.noteOn(60, 100, { when: 0.05 });
    e.setWheel('virtual', 0.2, { when: 0.5 });
    const ignored = e.setWheel('mod', 0.9, { when: 0.6 }) === false; // pickup: hardware far from 0.2 is ignored
    const taken = e.setWheel('mod', 0.1, { when: 0.7 }); // crossed → takes over
    e.setRouting({ modWheel: { target: 'macro.wash', min: 0, max: 1 } }, { when: 1.0 });
    e.setWheel('mod', 1, { when: 1.1 });
    const washFb = e.fx.delay.washFb;
    e.swell(true, { when: 1.5 });
    await ctx.startRendering();
    await settle();
    const swellVal = e.wheel.mod;
    return { pass: init === 1 && ignored && taken && Math.abs(washFb - 0.75) < 1e-6 && swellVal > 0.1 && swellVal < 0.3, init, ignored, taken, washFb, swellVal };
  },

  async panicAndFade() {
    const ctx = mkCtx(4);
    const e = await mkEngine(ctx);
    await use(e, patch({ 1: slot('synth', 'strings', { sends: { reverb: 0, delay: 0.5, chorus: 0 } }) }, { delay: { feedback: 0.8 } }));
    e.sustain(true, { when: 0.05 });
    e.noteOn(60, 100, { when: 0.1 });
    e.noteOff(60, { when: 0.3 });
    e.allNotesOff({ when: 1.0 });
    const cleared = e.sounding.size === 0 && e.pedaled.size === 0 && e.pedal === false;
    e.noteOn(64, 100, { when: 2.2 });
    e.fadeOutAll(1, { when: 2.5 });
    const d = mono(await ctx.startRendering());
    const before = db(rms(d, SR, 0.8, 0.95));
    const afterPanic = db(rms(d, SR, 1.5, 2.15)); // voices faded + the echoes in the 375 ms line flushed
    const afterFade = db(rms(d, SR, 3.6, 3.95));
    return { pass: cleared && before > -40 && afterPanic < -70 && afterFade < -70, cleared, beforeDb: before, afterPanicDb: afterPanic, afterFadeDb: afterFade };
  },

  async irRecipe() {
    const ctx = mkCtx(0.1);
    const rng = { s: 1, next() { this.s = (this.s * 16807) % 2147483647; return this.s / 2147483647; } };
    const ir = buildIR(ctx, rng, 2, 0.5);
    let e = 0;
    for (let c = 0; c < 2; c++) for (const x of ir.getChannelData(c)) e += x * x;
    const len = ir.duration;
    return { pass: Math.abs(e - 0.7) < 1e-3 && len > 2.6 && len < 2.7 && ir.numberOfChannels === 2, energy: e, seconds: len };
  },

  // ----- engine-core fixes (reviews/engine-core.md) — regression tests ---------------------------------------------
  /** #1: a reused instrument never keeps the previous song's params; getParam reflects the instance. */
  async paramResetOnReuse() {
    const ctx = mkCtx(0.5);
    const e = await mkEngine(ctx);
    await use(e, patch({ 0: slot('sampler', 'test-keys', { params: { tone: 0.3 } }) })); // "Felt Piano"
    const a = e.slots[0].inst;
    await use(e, patch({ 0: slot('sampler', 'test-keys') })); // "Grand Piano": no params
    const b = e.slots[0].inst;
    const sampler = { tone: b.getParam('tone'), reported: e.getParam('slots.0.params.tone'), lpfHz: Math.round(b._toneHz()) };
    await use(e, patch({ 0: slot('sampler', 'test-keys') })); // identical params → the instance is kept
    const kept = e.slots[0].inst === b;
    await use(e, patch({ 1: slot('synth', 'warm-pad', { params: { attack: 7.2 } }) }));
    await use(e, patch({ 1: slot('synth', 'warm-pad') }));
    const synth = { attack: e.slots[1].inst.getParam('attack'), reported: e.getParam('slots.1.params.attack') };
    // a live edit between prepare (reuse planned) and commit is reset to the song's value at commit
    const tok = await e.prepare(patch({ 1: slot('synth', 'warm-pad') }));
    const inst = e.slots[1].inst;
    e.setParam('slots.1.params.attack', 5);
    const liveBefore = inst.getParam('attack');
    e.commit(tok);
    const afterCommit = { same: e.slots[1].inst === inst, attack: e.slots[1].inst.getParam('attack'), reported: e.getParam('slots.1.params.attack') };
    await ctx.startRendering();
    const pass = a !== b && sampler.tone === 1 && sampler.reported === 1 && kept && synth.attack === 1.2 && synth.reported === 1.2 && liveBefore === 5 && afterCommit.same && afterCommit.attack === 1.2 && afterCommit.reported === 1.2;
    return { pass, sampler, kept, synth, liveBefore, afterCommit };
  },

  /** #5 (+ #14): mono is summed before the catcher/ceiling → peak ≤ −0.3 dBFS; below threshold the chain is unity. */
  async monoCeilingAndMakeup() {
    const run = async (monoOn) => {
      const ctx = mkCtx(1.5);
      const e = await mkEngine(ctx);
      await use(e, patch({ 0: slot('synth', 'sub-bass', { params: { tri: 0, tone: 1 }, gain: 2 }) }, { master: { volume: 2 } }), 0);
      if (monoOn) e.setMono(true);
      for (const n of [45, 52, 57, 64]) e.noteOn(n, 127, { when: 0.05 });
      const b = await ctx.startRendering();
      let m = 0;
      for (let c = 0; c < 2; c++) m = Math.max(m, peakAbs(b.getChannelData(c), SR, 0.1, 1.5));
      return +db(m).toFixed(2);
    };
    const stereoPeak = await run(false);
    const monoPeak = await run(true);
    // unity below threshold: −20 dBFS sine injected into the sum at master 1.0 (lofi off), stereo and mono
    const unity = async (monoOn) => {
      const ctx = mkCtx(1);
      const e = await mkEngine(ctx, { lofi: false });
      await use(e, patch({}, { master: { volume: 1 } }), 0);
      if (monoOn) e.setMono(true);
      const o = new OscillatorNode(ctx, { frequency: 1000 });
      const g = new GainNode(ctx, { gain: 0.1, channelCount: 1, channelCountMode: 'explicit' });
      o.connect(g).connect(e.fx.sum);
      o.start(0);
      const b = await ctx.startRendering();
      return { outDb: +db(rms(b.getChannelData(0), SR, 0.5, 1)).toFixed(3), makeupDb: +db(e.fx.compMakeup).toFixed(2) };
    };
    const st = await unity(false);
    const mo = await unity(true);
    const inDb = db(0.1 / Math.SQRT2);
    const pass = stereoPeak <= -0.3 && monoPeak <= -0.3 && Math.abs(st.outDb - inDb) < 0.05 && Math.abs(mo.outDb - (inDb + 3.01)) < 0.05 && st.makeupDb > 0.5;
    return { pass, stereoPeakDbFS: stereoPeak, monoPeakDbFS: monoPeak, inDb: +inDb.toFixed(3), stereoOutDb: st.outDb, monoOutDb: mo.outDb, compMakeupCancelledDb: st.makeupDb };
  },

  /** #7: predelay changes (commit and live knob) never ramp a live delay line → the reverb input keeps its pitch. */
  async predelayNoWarp() {
    const ctx = mkCtx(2.4);
    const e = await mkEngine(ctx);
    const mk = (pd) => patch({ 0: slot('synth', 'sub-bass', { params: { tri: 0, tone: 1 }, sends: { reverb: 1, delay: 0, chorus: 0 } }) }, { reverb: { size: 0.5, predelay: pd }, master: { volume: 0 } });
    await use(e, mk(0.04), 0);
    // tap the convolver input: both predelay lines (post line gain) of the unit
    const probe = new GainNode(ctx);
    for (const u of e.fx.reverb.units.values()) for (const g of u.pg) g.connect(probe);
    probe.connect(ctx.destination);
    e.noteOn(69, 120, { when: 0.05 }); // 440 Hz held across the switch
    const tok = await e.prepare(mk(0.015)); // next song: same IR, predelay 40 → 15 ms
    e.at(1.0, (t) => e.commit(tok, { when: t }));
    e.at(1.3, (t) => e.setParam('fx.reverb.predelay', 0.1, { when: t })); // live knob while the crossfade runs
    const b = await ctx.startRendering();
    const d = b.getChannelData(0);
    const bad = [];
    // instantaneous frequency from zero crossings in 20 ms windows (resolution 25 Hz); the old ramped DelayNode
    // read the input at 700–750 Hz for ~20 ms after the commit
    for (let w = 0.9; w < 2.28; w += 0.01) {
      let zc = 0;
      for (let i = Math.floor(w * SR) + 1; i < Math.floor((w + 0.02) * SR); i++) if (d[i - 1] < 0 !== d[i] < 0) zc++;
      if (Math.abs(zc * 25 - 440) > 40) bad.push([+w.toFixed(2), zc * 25]);
    }
    const u = e.fx.reverb.active;
    const cl = clicks(d, SR, 0.9, 2.3);
    const pass = bad.length === 0 && cl.length === 0 && Math.abs(u.pdV[u.cur] - 0.1) < 1e-9 && e.fx.reverb.units.size === 1;
    return { pass, offPitchWindows: bad.slice(0, 6), clicks: cl.slice(0, 3), activePredelay: u.pdV[u.cur] };
  },

  /** #8: lofi engage/bypass produces no step (second-difference spikes) on a steady sine. */
  async lofiEngageNoClick() {
    const run = async (events) => {
      const ctx = mkCtx(2);
      const e = await mkEngine(ctx);
      await use(e, patch({ 0: slot('synth', 'sub-bass', { params: { tri: 0, tone: 1 } }) }, { lofi: { amount: 0, crackle: 0, wow: 0, flutter: 0, saturation: 0, bits: 0 } }), 0);
      e.noteOn(57, 120, { when: 0.1 });
      for (const [t, v] of events) e.at(t, (tt) => e.setParam('fx.lofi.amount', v, { when: tt }));
      const d = (await ctx.startRendering()).getChannelData(0);
      const d2 = (i) => Math.abs(d[i] - 2 * d[i - 1] + d[i - 2]);
      let base = 0;
      for (let i = Math.floor(0.5 * SR); i < Math.floor(0.95 * SR); i++) base = Math.max(base, d2(i));
      let mx = 0;
      let spikes = 0;
      for (let i = Math.floor(0.99 * SR); i < Math.floor(1.3 * SR); i++) {
        const v = d2(i);
        mx = Math.max(mx, v);
        if (v > 0.002) spikes++;
      }
      return { spikes, steadyD2: +base.toFixed(5), eventD2: +mx.toFixed(5) };
    };
    const engage = await run([[1.0, 0.3]]);
    const engageBypass12 = await run([[1.0, 0.3], [1.012, 0]]);
    const engageBypass40 = await run([[1.0, 0.3], [1.04, 0]]);
    const pass = [engage, engageBypass12, engageBypass40].every((r) => r.spikes === 0 && r.eventD2 < 5 * r.steadyD2);
    return { pass, engage, engageBypass12, engageBypass40 };
  },

  /** #9: a stream of tape-bend messages (varying depth, every 3 ms, events landing 3 ms after they're read) is click-free. */
  async tapeBendStream() {
    const run = async (lag, step) => {
      const ctx = mkCtx(2);
      const e = await mkEngine(ctx);
      await use(e, patch({ 0: slot('synth', 'sub-bass', { params: { tri: 0, tone: 1 } }) }, { lofi: { amount: 0.001, crackle: 0, wow: 0, flutter: 0, saturation: 0 } }, { bend: { mode: 'tape', range: 2 } }), 0);
      e.noteOn(57, 120, { when: 0.05 });
      const n = Math.round(0.6 / step);
      for (let k = 0; k < n; k++) e.at(0.8 + k * step, (T) => e.pitchBend(-(0.2 + (0.6 * k) / n), { when: T + lag }));
      e.at(0.8 + n * step + 0.1, (T) => e.pitchBend(0, { when: T }));
      const d = (await ctx.startRendering()).getChannelData(0);
      const d2 = (i) => Math.abs(d[i] - 2 * d[i - 1] + d[i - 2]);
      let base = 0;
      for (let i = Math.floor(0.3 * SR); i < Math.floor(0.79 * SR); i++) base = Math.max(base, d2(i));
      let spikes = 0;
      let mx = 0;
      for (let i = Math.floor(0.8 * SR); i < Math.floor(1.9 * SR); i++) {
        const v = d2(i);
        mx = Math.max(mx, v);
        if (v > 10 * base) spikes++;
      }
      return { spikes, baseD2: +base.toFixed(5), maxD2: +mx.toFixed(5) };
    };
    const lag3ms_every3ms = await run(0.003, 0.003);
    const lag3ms_every12ms = await run(0.003, 0.012);
    const pass = lag3ms_every3ms.spikes === 0 && lag3ms_every12ms.spikes === 0;
    return { pass, lag3ms_every3ms, lag3ms_every12ms };
  },

  /** #11: a freshly committed strip starts at the current wheel factor (wheel 0 → silent first note, no blip). */
  async freshStripWheel() {
    const ctx = mkCtx(2);
    const e = await mkEngine(ctx);
    const routing = { modWheel: { target: 'slots.0.gain', min: 0, max: 1 } };
    await use(e, patch({ 0: slot('synth', 'bell') }, {}, routing), 0);
    e.setWheel('mod', 0, { when: 0 });
    const tok = await e.prepare(patch({ 0: slot('synth', 'soft-keys') }, {}, routing));
    e.at(1.0, (t) => {
      e.commit(tok, { when: t });
      e.noteOn(72, 110, { when: t });
    });
    const d = mono(await ctx.startRendering());
    const first100 = db(rms(d, SR, 1.0, 1.1));
    return { pass: first100 < -90, first100msDb: first100 };
  },

  /** #12: neighbour preloads add pins (union); 'replace' and unpin are explicit. */
  async pinsUnion() {
    const ctx = mkCtx(0.3);
    const e = await mkEngine(ctx, { cacheMB: 0.5 });
    const K = patch({ 0: slot('sampler', 'test-keys') });
    const M = patch({ 0: slot('sampler', 'test-mp3') });
    await e.preload([K], { pin: 'replace' }); // setlist
    const setlist = [...e.cache.pinned];
    await e.preload([M]); // neighbours (controller default call)
    const afterNeighbour = e.cache.pinned.size;
    const setlistStillPinned = setlist.every((u) => e.cache.pinned.has(u) && e.cache.entries.has(u));
    await e.preload([M], { pin: 'replace' });
    const afterReplace = e.cache.pinned.size;
    e.cache.unpin([...e.cache.pinned]);
    const afterUnpin = e.cache.pinned.size;
    await ctx.startRendering();
    const pass = setlist.length === 4 && afterNeighbour === 5 && setlistStillPinned && afterReplace === 1 && afterUnpin === 0;
    return { pass, setlist: setlist.length, afterNeighbour, setlistStillPinned, afterReplace, afterUnpin };
  },

  /**
   * morning-prep (integration-2 round 2 #3): with every song pinned the LRU cap can't be enforced; once the pins
   * are limited (controller: current ± neighbours) the unpinned songs are evicted. Also: pinnedMB / capMB in
   * _debugStats, sizes remembered after eviction (estimatePreloadMB exact), eviction down to the 85 % low-water mark.
   */
  async pinsLimitedEvict() {
    const ctx = mkCtx(0.3);
    const e = await mkEngine(ctx, { cacheMB: 100 });
    const K = patch({ 0: slot('sampler', 'test-keys') });
    const M = patch({ 0: slot('sampler', 'test-mp3') });
    await e.preload([K], { pin: 'replace' });
    const bytesK = e.cache.bytes;
    const urlsK = [...e.cache.entries.keys()];
    await e.preload([M], { pin: 'none' });
    const bytesM = e.cache.bytes - bytesK;
    const urlsM = [...e.cache.entries.keys()].filter((u) => !urlsK.includes(u));
    const est = await e.estimatePreloadMB([K, M, K]); // shared songs counted once
    const estOk = est.exact && Math.abs(est.mb * 1048576 - (bytesK + bytesM)) < 1 && est.capMB === 100;
    const pinnedOnlyK = e.cache.pinnedBytes === bytesK;
    const st = e._debugStats();
    const statsOk = 'pinnedMB' in st && st.capMB === 100 && st.pinnedMB <= st.decodedMB;
    // everything pinned (the old whole-library pin) and a cap below the total: nothing can go
    await e.preload([K, M], { pin: 'replace' });
    e.cache.capBytes = bytesK + bytesM / 2;
    e.cache.lowWaterBytes = e.cache.capBytes * 0.85;
    e.cache._evict();
    const overCapWhilePinned = e.cache.bytes === bytesK + bytesM;
    // pins limited to M (the song "around the current one"): K is unpinned, unreferenced → evicted LRU-first down
    // to the low-water mark (not all of it)
    await e.preload([M], { pin: 'replace' });
    const kLeft = urlsK.filter((u) => e.cache.entries.has(u)).length;
    const underCap = e.cache.bytes <= e.cache.lowWaterBytes;
    // a cap M alone fills: every unpinned buffer goes, the pinned one stays
    e.cache.capBytes = bytesM;
    e.cache.lowWaterBytes = bytesM * 0.85;
    e.cache._evict();
    const kEvicted = urlsK.every((u) => !e.cache.entries.has(u)) && e.cache.bytes === bytesM;
    const mKept = urlsM.every((u) => e.cache.entries.has(u));
    const sizesKept = e.cache.estimateBytes(urlsK).unknown === 0 && Math.abs(e.cache.estimateBytes(urlsK).bytes - bytesK) < 1;
    await ctx.startRendering();
    const pass = urlsK.length === 4 && urlsM.length >= 1 && bytesM > 0 && estOk && pinnedOnlyK && statsOk &&
      overCapWhilePinned && kLeft > 0 && kLeft < 4 && underCap && kEvicted && mKept && sizesKept;
    return { pass, bytesK, bytesM, est, pinnedOnlyK, statsOk, overCapWhilePinned, kLeft, underCap, kEvicted, mKept, sizesKept };
  },

  /** #13: public calls before start() never throw; stored values apply once started. */
  async beforeStartNoThrow() {
    const ctx = mkCtx(0.5);
    const e = new AudioEngine({ context: ctx, seed: 7, manifestUrl: MANIFEST, instrumentModules: false });
    const warns = [];
    e.addEventListener('warn', (ev) => warns.push(ev.detail.message));
    const calls = {
      setWheel: () => e.setWheel('mod', 0.25),
      modWheel: () => e.modWheel(0.25),
      expression: () => e.expression(0.5),
      volumeCC: () => e.volumeCC(0.8),
      pitchBend: () => e.pitchBend(0.5),
      swell: () => e.swell(true),
      slotParam: () => e.setParam('slots.0.params.tone', 0.5),
      reverbSize: () => e.setParam('fx.reverb.size', 0.7),
      master: () => e.setParam('master.volume', 0.3),
      drone: () => e.setParam('drone.gain', 0.5),
      droneGet: () => e.getParam('drone.gain'),
      tempo: () => e.setTempo(90),
      routing: () => e.setRouting({ bend: { mode: 'drone-swell' } }),
      keyCtx: () => e.setKeyContext(2),
      mono: () => e.setMono(false),
      noteOn: () => e.noteOn(60, 100),
      noteOff: () => e.noteOff(60),
      sustain: () => e.sustain(true),
      panic: () => e.allNotesOff(),
      fade: () => e.fadeOutAll(1),
      at: () => e.at(0.1, () => {}),
      transpose: () => e.setTranspose(2),
      chord: () => e.heldChord(),
      list: () => e.listInstruments(),
    };
    const threw = [];
    for (const [k, f] of Object.entries(calls)) {
      try {
        f();
      } catch (err) {
        threw.push(`${k}: ${err.message}`);
      }
    }
    await e.start();
    const applied = { wheel: e.wheel.mod, tempo: e.tempo, delayTempo: e.fx.delay.tempo, size: e.getParam('fx.reverb.size') };
    await ctx.startRendering();
    applied.master = +e.fx.master.gain.value.toFixed(3); // automation values are readable after rendering
    const pass = threw.length === 0 && applied.wheel === 0.25 && applied.tempo === 90 && applied.delayTempo === 90 && applied.size === 0.7 && applied.master === 0.3;
    return { pass, threw, applied, warns };
  },

  /** #15: the lofi wet chain has 12 dB of headroom (a +6 dBFS sum is not clamped at ±1 inside lofi). */
  async lofiHeadroom() {
    const ctx = mkCtx(1);
    const e = await mkEngine(ctx);
    await use(e, patch({}, { lofi: { amount: 0.001, crackle: 0, wow: 0, flutter: 0, saturation: 0, bits: 0 }, master: { volume: 0.25 } }), 0);
    const o = new OscillatorNode(ctx, { frequency: 440 });
    const g = new GainNode(ctx, { gain: 2 }); // +6 dBFS into the sum
    o.connect(g).connect(e.fx.sum);
    o.start(0);
    const d = (await ctx.startRendering()).getChannelData(0);
    const pk = peakAbs(d, SR, 0.5, 1);
    return { pass: e.fx.lofi.engaged && pk > 0.45 && pk < 0.55, engaged: e.fx.lofi.engaged, outPeak: +pk.toFixed(3), expected: 0.5, clampedWouldBe: 0.25 };
  },

  /** #16: drone key changes reuse two drone-osc instruments instead of constructing one per change. */
  async droneInstrumentReuse() {
    const ctx = mkCtx(11);
    const e = await mkEngine(ctx);
    let creates = 0;
    const oc = e.registry.create.bind(e.registry);
    e.registry.create = (...a) => {
      if (a[2]?.id === 'drone-osc') creates++;
      return oc(...a);
    };
    e.drone.configure({ mode: 'synth', gain: 1, fade: 1 }, { when: 0 });
    e.drone.setKey(0, { when: 0 });
    const ms = [];
    [7, 2, 9, 4].forEach((k, i) =>
      e.at(2 + i * 2, (tt) => {
        const t0 = performance.now();
        e.drone.setKey(k, { when: tt });
        ms.push(+(performance.now() - t0).toFixed(2));
      }),
    );
    const d = mono(await ctx.startRendering());
    const w = minWindowDb(d, SR, 1.2, 10.9);
    const fE = bandMag(d, SR, 9.8, 10.9, 82.41 * 2);
    return { pass: creates === 2 && w.min > -60 && fE > 0, drone_osc_creates: creates, keyChanges: 5, setKeyMs: ms, minWindowDb: w.min };
  },

  /** #17: transient sample-fetch failures are retried (≤ 2), a hung fetch times out, a 404 is not retried. */
  async sampleRetry() {
    const { BufferCache } = await import('/js/engine/sampler.js');
    const ctx = mkCtx(0.1);
    const real = '/__fixtures/test-keys/soft/C4.wav';
    const orig = window.fetch;
    const log = [];
    let flaky = 0;
    window.fetch = (u, o) => {
      const s = String(u);
      log.push(s);
      if (s.includes('flaky')) return ++flaky === 1 ? Promise.reject(new TypeError('Failed to fetch')) : orig(real, o);
      if (s.includes('hang'))
        return new Promise((_, rej) => o?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
      if (s.includes('gone')) return Promise.resolve(new Response('nope', { status: 404 }));
      return orig(u, o);
    };
    const warns = [];
    const c = new BufferCache({ warn: (m) => warns.push(m), fetchTimeoutMs: 150, retryDelayMs: 10 });
    let res;
    try {
      const t0 = performance.now();
      const a = await c.acquire('/x/flaky.wav', ctx, 60, null);
      const b = await c.acquire('/x/hang.wav', ctx, 60, null);
      const hangMs = performance.now() - t0;
      const g = await c.acquire('/x/gone.wav', ctx, 60, null);
      res = {
        flakyOk: !!a,
        flakyAttempts: log.filter((x) => x.includes('flaky')).length,
        hangNull: b === null,
        hangAttempts: log.filter((x) => x.includes('hang')).length,
        hangMs: Math.round(hangMs),
        goneAttempts: log.filter((x) => x.includes('gone')).length,
        goneNull: g === null,
        warns: warns.length,
      };
    } finally {
      window.fetch = orig;
    }
    const pass = res.flakyOk && res.flakyAttempts === 2 && res.hangNull && res.hangAttempts === 3 && res.hangMs < 3000 && res.goneAttempts === 1 && res.goneNull && res.warns === 2;
    return { pass, ...res };
  },

  /** #10/#11: gain-trims.json is wired (synth/organ output trim, droneTrim on the drone synth bus), manifest gainTrim is dB, hidden patches are not listed. */
  async gainTrimsAndRegistry() {
    const trims = await (await fetch('/js/engine/gain-trims.json')).json();
    const ctx = mkCtx(1);
    const e = await mkEngine(ctx, { instrumentModules: true });
    const { normalizeManifest } = await import('/js/engine/sampler.js');
    const [def6] = normalizeManifest({ instruments: [{ id: 'trim6', name: 'Trim 6', category: 'piano', ext: 'wav', gainTrim: 6, layers: [{ vel: [0, 127], dir: 'test-keys/soft', notes: ['C4'] }] }] }, MANIFEST);
    e.registry.samplers.set('trim6', def6);
    await use(e, patch({ 0: slot('synth', 'warm-pad'), 1: slot('organ', 'church'), 2: slot('sampler', 'trim6'), 3: slot('sampler', 'test-keys') }));
    const near = (a, b) => Math.abs(a - b) < 1e-4;
    const lin = (x) => Math.pow(10, x / 20);
    const [s0, s1, s2, s3] = e.slots.map((x) => x.inst);
    const r = {
      registryGainTrims: typeof e.registry.gainTrims === 'object' && near(e.registry.gainTrims.droneTrim, trims.droneTrim),
      synth: [s0.trimDb, trims.synth['warm-pad'], +s0.output.gain.value.toFixed(4)],
      organ: [s1.trimDb, trims.organ.church, +s1.output.gain.value.toFixed(4)],
      samplerTrimDb: def6.gainTrimDb,
      samplerOut: [+s2.output.gain.value.toFixed(4), +s3.output.gain.value.toFixed(4)],
    };
    const list = e.listInstruments();
    const ids = list.map((x) => `${x.ref.type}:${x.ref.id}`);
    let extra = [];
    try {
      extra = (await import('/js/engine/synth-extra.js')).PATCHES || [];
    } catch {}
    const extraListed = extra.filter((p) => !p.hidden).every((p) => list.some((x) => x.ref.type === 'synth' && x.ref.id === p.id && x.group === p.group));
    const droneOscHidden = !ids.includes('synth:drone-osc') && e.registry.paramsFor({ type: 'synth', id: 'drone-osc' }).length > 0;
    await ctx.startRendering();
    r.droneBus = +e.drone.synthBus.gain.value.toFixed(4);
    const pass =
      r.registryGainTrims && near(r.synth[0], r.synth[1]) && near(r.synth[2], lin(r.synth[1])) && near(r.organ[0], r.organ[1]) && near(r.organ[2], lin(r.organ[1])) &&
      r.samplerTrimDb === 6 && near(r.samplerOut[0], lin(6)) && near(r.samplerOut[1], 1) && near(r.droneBus, lin(trims.droneTrim)) && droneOscHidden && extraListed;
    return { pass, ...r, droneOscHidden, extraPatches: extra.length, extraListed, groups: [...new Set(list.map((x) => x.group))] };
  },

  /** #12 (instruments contract): sc.morph starts at 0 and the current morph is sent to a fresh instrument at commit. */
  async morphAtCommit() {
    const ctx = mkCtx(0.5);
    const e = await mkEngine(ctx);
    const calls = [];
    const oc = e.registry.create.bind(e.registry);
    e.registry.create = (...a) => {
      const inst = oc(...a);
      const m = inst.morph.bind(inst);
      inst.morph = (x, t) => {
        calls.push([a[2].id, x]);
        return m(x, t);
      };
      return inst;
    };
    await use(e, patch({ 0: slot('synth', 'bell') }));
    const plain = { morph: e.slots[0].morph, calls: calls.filter((c) => c[0] === 'bell') };
    e.setRouting({ modWheel: { target: 'macro.intensity', min: 0, max: 1 } });
    e.setWheel('mod', 0.4);
    await use(e, patch({ 1: slot('synth', 'warm-pad') }, {}, { modWheel: { target: 'macro.intensity', min: 0, max: 1 } }));
    const pad = { morph: e.slots[1].morph, calls: calls.filter((c) => c[0] === 'warm-pad') };
    await ctx.startRendering();
    const pass = plain.morph === 0 && plain.calls.length === 1 && plain.calls[0][1] === 0 && Math.abs(pad.morph - 0.4) < 1e-9 && pad.calls.length >= 1 && Math.abs(pad.calls[0][1] - 0.4) < 1e-9;
    return { pass, plain, pad };
  },

  /** Real synth.js / organ.js through the registry (if engine-instruments has delivered them). Soft. */
  async realInstrumentsSmoke() {
    const ctx = mkCtx(0.2);
    const e = await mkEngine(ctx, { instrumentModules: true });
    const list = e.listInstruments();
    const warns = [];
    const out = [];
    for (const it of list.filter((x) => x.ref.type !== 'sampler')) {
      const c = mkCtx(1.2);
      const en = await mkEngine(c, { instrumentModules: true });
      en.addEventListener('warn', (ev) => warns.push(ev.detail.message));
      await use(en, patch({ 0: slot(it.ref.type, it.ref.id) }));
      const fallback = !!en.slots[0].inst.isFallback;
      const inst = en.slots[0].inst;
      const rightPatch = (inst.patchId ?? inst.presetId ?? inst.id ?? inst.meta?.id) === it.ref.id;
      en.noteOn(60, 100, { when: 0.05 });
      en.noteOn(64, 100, { when: 0.05 });
      en.noteOff(60, { when: 0.8 });
      en.noteOff(64, { when: 0.8 });
      const d = mono(await c.startRendering());
      let finite = true;
      for (const x of d) if (!Number.isFinite(x)) { finite = false; break; }
      out.push({ id: `${it.ref.type}:${it.ref.id}`, fallback, rightPatch, levelDb: +db(rms(d, SR, 0.3, 0.8)).toFixed(1), finite });
    }
    await ctx.startRendering();
    // the drone on the real drone-osc: key change C → G stays continuous
    const dc = mkCtx(7.5);
    const de = await mkEngine(dc, { instrumentModules: true });
    de.drone.configure({ mode: 'synth', gain: 1, movement: 0.5, brightness: 0.7 }, { when: 0 });
    de.drone.setKey(0, { when: 0 });
    de.drone.setKey(7, { when: 3, fade: 3 });
    const dd = mono(await dc.startRendering());
    // saw resets trip the first-difference detector even on a steady drone, so compare rates: the crossfade window
    // must not flag more often than the steady state before it
    const steady = clicks(dd, SR, 0.6, 2.9).length / 2.3;
    const during = clicks(dd, SR, 3.0, 6.5).length / 3.5;
    const drone = { minWindowDb: +minWindowDb(dd, SR, 2.6, 7.4).min.toFixed(1), steadyFlagsPerSec: +steady.toFixed(2), crossfadeFlagsPerSec: +during.toFixed(2), fallback: !!de.drone.layers[0]?.inst.isFallback };
    drone.ok = drone.minWindowDb > -60 && during <= 2 * steady + 1 && !drone.fallback;
    const groups = [...new Set(list.map((x) => x.group))];
    return { pass: out.every((o) => o.finite && o.rightPatch && o.levelDb > -60) && drone.ok, soft: true, drone, groups, instruments: out, warns: [...new Set(warns)] };
  },

  // ----- engine-3 -------------------------------------------------------------------------------------------------
  /** engine-3 #1: every lowpass/highpass the engine builds is Butterworth (Web Audio Q is dB): −3.01 dB at fc, no peak. */
  async filterQButterworth() {
    const ctx = mkCtx(0.3);
    const e = await mkEngine(ctx);
    await use(e, patch({ 0: slot('sampler', 'test-keys', { params: { tone: 0.5 } }), 1: slot('sampler', 'test-mp3'), 2: slot('synth', 'warm-pad') }));
    const N = 600;
    const freqs = new Float32Array(N);
    for (let i = 0; i < N; i++) freqs[i] = 20 * Math.pow(1000, i / (N - 1)); // 20 Hz – 20 kHz
    /** cascade response (dB) of `nodes` at `freqs` (+ f) */
    const resp = (nodes, f) => {
      const fr = f ? new Float32Array([f]) : freqs;
      const tot = new Float64Array(fr.length);
      const m = new Float32Array(fr.length);
      const ph = new Float32Array(fr.length);
      for (const n of nodes) {
        n.getFrequencyResponse(fr, m, ph);
        for (let i = 0; i < fr.length; i++) tot[i] += 20 * Math.log10(m[i]);
      }
      return tot;
    };
    const check = (label, nodes, fc = nodes[0].frequency.value) => {
      const at = resp(nodes, fc)[0];
      const all = resp(nodes);
      let peak = -Infinity;
      for (const v of all) peak = Math.max(peak, v);
      return { label, fc: Math.round(fc), atFcDb: +at.toFixed(2), peakDb: +peak.toFixed(3), ok: Math.abs(at + 3.01) < 0.05 && peak < 0.02 };
    };
    const F = e.fx;
    const tone = e.slots[0].inst.tone;
    const v = e.slots[1].inst.noteOn(60, 0.5, 0.05); // single-layer sampler → per-voice velocity LPF
    const velLp = v.nodes.find((n) => n instanceof BiquadFilterNode);
    const strip = e.slots[0].strip;
    const rows = [
      check('reverb send HPF', [F.reverb.hpf]),
      check('reverb send LPF', [F.reverb.lpf]),
      check('delay tone LPF', [F.delay.lines[0].lp]),
      check('lofi tilt LPF', [F.lofi.lpf]),
      check('lofi tilt HPF', [F.lofi.hpf]),
      check('sampler tone LPF (tone .5)', [tone]),
      check('sampler velocity LPF', [velLp]),
      check('strip side HPF (width > 1)', [strip.wHp], 150),
      check('fallback synth LPF', [e.slots[2].inst.lpf]),
      check('drone HPF', [e.drone.hpf]),
    ];
    // 2-pole slope: one octave below 150 Hz ≈ −12.3 dB; tone 1 = Nyquist corner = exact bypass (0 dB at 10 kHz)
    const side75 = +resp([strip.wHp], 75)[0].toFixed(2);
    e.setParam('slots.0.params.tone', 1);
    const toneOpenHz = e.slots[0].inst._toneHz();
    tone.frequency.value = toneOpenHz;
    const toneOpen10k = +resp([tone], 10000)[0].toFixed(4);
    await ctx.startRendering();
    const pass = rows.every((r) => r.ok) && side75 < -11.5 && side75 > -13 && toneOpenHz === SR / 2 && Math.abs(toneOpen10k) < 0.01;
    return { pass, rows: rows.map((r) => `${r.label}: ${r.atFcDb} dB @ ${r.fc} Hz, peak ${r.peakDb}${r.ok ? '' : ' ✗'}`), side75Db: side75, toneOpenHz, toneOpen10kDb: toneOpen10k };
  },

  /** engine-3 #2: slot width (M/S, lows never widened) + slot EQ; width 1 / EQ 0 is bit-exact; mono sources keep their pan law. */
  async slotWidthEq() {
    const { Channel } = await import('/js/engine/fx.js');
    // (1) synthetic L-only tones through a bare strip: 1 kHz (side widened) and 60 Hz (side never widened)
    const strip = async (w, eq) => {
      const ctx = mkCtx(1);
      const sink = new GainNode(ctx);
      sink.connect(ctx.destination);
      const dummy = { input: new GainNode(ctx) };
      const ch = new Channel(ctx, { sum: sink, reverb: dummy, delay: dummy, chorus: dummy }, 0);
      ch.fader.gain.value = 1;
      ch.setWidth(w, 0, true);
      if (eq) ch.setEq(eq[0], eq[1], 0, true);
      const merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
      for (const f of [1000, 60]) {
        const o = new OscillatorNode(ctx, { frequency: f });
        o.connect(new GainNode(ctx, { gain: 0.25 })).connect(merge, 0, 0); // left only
        o.start(0);
      }
      merge.connect(ch.input);
      const b = await ctx.startRendering();
      const L = b.getChannelData(0);
      const R = b.getChannelData(1);
      const m = (d, f) => bandMag(d, SR, 0.4, 0.9, f) / bandMag(L, SR, 0.4, 0.9, 1000) * (w === 1 && !eq ? 1 : 1);
      return { L, R, hiL: m(L, 1000), hiR: m(R, 1000), loL: m(L, 60), loR: m(R, 60) };
    };
    const ref = await strip(1);
    const rel = (x, f) => bandMag(x, SR, 0.4, 0.9, f) / bandMag(ref.L, SR, 0.4, 0.9, f);
    const shape = {};
    for (const w of [0, 0.5, 1.5]) {
      const r = await strip(w);
      shape[w] = { hiL: +rel(r.L, 1000).toFixed(3), hiR: +rel(r.R, 1000).toFixed(3), loL: +rel(r.L, 60).toFixed(3), loR: +rel(r.R, 60).toFixed(3) };
    }
    // expected (L-only input a): L' = a(1+w)/2, R' = a(1−w)/2 (w ≤ 1); w 1.5: 1 kHz → 1.25 / 0.25 (R inverted), 60 Hz not
    // widened (the 2-pole side HPF leaves ≈ 0.97 / 0.03)
    const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;
    const shapeOk =
      near(shape[0].hiL, 0.5) && near(shape[0].hiR, 0.5) && near(shape[0].loL, 0.5) && near(shape[0].loR, 0.5) &&
      near(shape[0.5].hiL, 0.75) && near(shape[0.5].hiR, 0.25) && near(shape[0.5].loL, 0.75) && near(shape[0.5].loR, 0.25) &&
      near(shape[1.5].hiL, 1.25) && near(shape[1.5].hiR, 0.25) && near(shape[1.5].loL, 1, 0.05) && shape[1.5].loR < 0.05;
    const eqr = await strip(1, [6, -6]);
    const eqOk = { lo60Db: +db(rel(eqr.L, 60)).toFixed(2), hi1kDb: +db(rel(eqr.L, 1000)).toFixed(2) };
    // shelf responses: low shelf 120 Hz (+6 → +3 at 120, ≈ +5.2 at 60), high shelf 6 kHz (−6 → −3 at 6 kHz, ≈ −6 at 16 kHz)
    const c2 = mkCtx(0.1);
    const ch2 = new Channel(c2, { sum: new GainNode(c2), reverb: { input: new GainNode(c2) }, delay: { input: new GainNode(c2) }, chorus: { input: new GainNode(c2) } }, 0);
    ch2.setEq(6, -6, 0, true);
    const fr = new Float32Array([30, 120, 6000, 16000]);
    const mL = new Float32Array(4), mH = new Float32Array(4), ph = new Float32Array(4);
    ch2.eqLow.gain.value = 6;
    ch2.eqHigh.gain.value = -6;
    ch2.eqLow.getFrequencyResponse(fr, mL, ph);
    ch2.eqHigh.getFrequencyResponse(fr, mH, ph);
    const shelf = [...fr].map((f, i) => +(db(mL[i]) + db(mH[i])).toFixed(2));
    const shelfOk = near(shelf[0], 6, 0.35) && near(shelf[1], 3, 0.2) && near(shelf[2], -3, 0.2) && near(shelf[3], -6, 0.35) && near(eqOk.lo60Db, 5.6, 0.3) && near(eqOk.hi1kDb, 0, 0.3);

    // (2) width 1 + EQ 0 ≡ the old strip (wheel → pan) on a stereo sampler + a mono fallback synth
    const sal = (await import('/js/engine/sampler.js')).normalizeManifest(await (await fetch('/samples/manifest.json')).json(), '/samples/manifest.json');
    const salDef = sal.find((d) => d.id === 'salamander-piano');
    const onlyC5 = (def, wd, fix) => ({ ...def, id: `c5-${wd}-${fix}`, widthDefault: wd, decodeOpts: fix ? def.decodeOpts : undefined, layers: def.layers.filter((L) => L.lo >= 53 && L.hi <= 96).map((L) => ({ ...L, lo: 0, hi: 127, samples: L.samples.filter((s) => s.midi === 72) })) });
    const render = async ({ bypass = false, width = 1, wd = 1, bell = false, fix = false } = {}) => {
      const ctx = mkCtx(2.2);
      const e = await mkEngine(ctx);
      e.registry.samplers.set(`c5-${wd}-${fix}`, onlyC5(salDef, wd, fix));
      await use(e, patch({ 0: slot('sampler', `c5-${wd}-${fix}`, { width }), ...(bell ? { 1: slot('synth', 'bell') } : {}) }, { master: { volume: 1 } }));
      if (bypass) for (const sc of e.slots) if (sc) { sc.strip.wheel.disconnect(); sc.strip.wheel.connect(sc.strip.pan); }
      e.noteOn(72, 80, { when: 0.05 });
      const b = await ctx.startRendering();
      const L = b.getChannelData(0), R = b.getChannelData(1);
      const stDb = +db(Math.sqrt(0.5 * (rms(L, SR, 0.1, 2) ** 2 + rms(R, SR, 0.1, 2) ** 2))).toFixed(2);
      const fixInfo = e.slots[0].inst.layers[0]?.samples[0]?.buffer._monoFix;
      return { L, R, stDb, fixInfo, eff: e.slots[0].strip.width, wdInst: e.slots[0].inst.widthDefault };
    };
    const monoLoss = (r, a = 0.1, b = 2) => {
      const m = new Float32Array(r.L.length);
      for (let i = 0; i < m.length; i++) m[i] = 0.5 * (r.L[i] + r.R[i]);
      const st = Math.sqrt(0.5 * (rms(r.L, SR, a, b) ** 2 + rms(r.R, SR, a, b) ** 2));
      return +(db(st) - db(rms(m, SR, a, b))).toFixed(2);
    };
    const A = await render({ bell: true });
    const B = await render({ bell: true, bypass: true });
    let exact = 0;
    for (let i = 0; i < A.L.length; i++) exact = Math.max(exact, Math.abs(A.L[i] - B.L[i]), Math.abs(A.R[i] - B.R[i]));
    // mono bell at width .5 → identical (S = 0 and the channel count stays 1, so the panner keeps its mono law)
    const soloBell = async (w) => {
      const ctx = mkCtx(1);
      const e = await mkEngine(ctx);
      await use(e, patch({ 1: slot('synth', 'bell', { width: w }) }, { master: { volume: 1 } }));
      e.noteOn(72, 80, { when: 0.05 });
      const b = await ctx.startRendering();
      return { L: b.getChannelData(0), R: b.getChannelData(1) };
    };
    const b1 = await soloBell(1);
    const b5 = await soloBell(0.5);
    let monoSame = 0;
    for (let i = 0; i < b1.L.length; i++) monoSame = Math.max(monoSame, Math.abs(b1.L[i] - b5.L[i]), Math.abs(b1.R[i] - b5.R[i]));
    // (3) the real Salamander C5 (anti-correlated L/R, v9): mono-sum loss vs effective width. Raw file: side gain alone
    // cannot get it under 3 dB above w ≈ 0.43 (loss = 10·log10(1 + w²·S²/M²), S²/M² ≈ 5). With the manifest's
    // maxMonoLossDb 3 (decode-time side limit, stereo RMS kept) it is 3.0 dB at width 1 and < 3 at any width < 1.
    const raw = {};
    for (const w of [1, 0.7, 0.4, 0]) raw[w] = monoLoss(await render({ width: w }));
    const rawLevel = (await render()).stDb;
    const f1 = await render({ fix: true });
    const fixed = { 1: monoLoss(f1), 0.7: monoLoss(await render({ width: 0.7, fix: true })) };
    const shipped = await render({ wd: salDef.widthDefault, fix: true }); // slot width 1 × manifest widthDefault
    fixed.shipped = monoLoss(shipped);
    const levelKept = Math.abs(f1.stDb - rawLevel) < 0.15;
    const pass =
      shapeOk && shelfOk && exact <= 2e-6 && monoSame <= 2e-6 && raw[1] > 6 && raw[0] < 0.01 && raw[0.4] < 3 && raw[0.7] < raw[1] - 2 &&
      fixed[1] <= 3.05 && fixed[0.7] < 3 && fixed.shipped < 3 && levelKept && salDef.decodeOpts?.maxMonoLossDb === 3 &&
      salDef.widthDefault === 0.8 && shipped.wdInst === 0.8 && Math.abs(shipped.eff - 0.8) < 1e-9;
    return {
      pass, shape, shelfDb_30_120_6k_16k: shelf, eqRender: eqOk, bypassMaxDiff: exact, monoSourceWidthDiff: monoSame,
      c5MonoLossRawDb: raw, c5MonoLossFixedDb: fixed, c5StereoDb: { raw: rawLevel, fixed: f1.stDb }, monoFix: f1.fixInfo, widthDefault: salDef.widthDefault, shippedEffWidth: shipped.eff,
    };
  },

  /** engine-3 #3: master EQ + glue compressor (amount 0 ≡ never built; unity on the −23 dBFS reference; less crest). */
  async masterEqGlue() {
    const sal = (await import('/js/engine/sampler.js')).normalizeManifest(await (await fetch('/samples/manifest.json')).json(), '/samples/manifest.json');
    const salDef = sal.find((d) => d.id === 'salamander-piano');
    const chordNotes = [60, 63, 66, 69, 72];
    const loud = { ...salDef, id: 'sal-loud', layers: salDef.layers.filter((L) => L.lo >= 97).map((L) => ({ ...L, lo: 0, hi: 127, samples: L.samples.filter((s) => chordNotes.includes(s.midi)) })) };
    const piano = async (opts, events = []) => {
      const ctx = mkCtx(2.5);
      const e = await mkEngine(ctx, opts);
      e.registry.samplers.set('sal-loud', loud);
      await use(e, patch({ 0: slot('sampler', 'sal-loud', { sends: { reverb: 0.3, delay: 0, chorus: 0 } }), 1: slot('synth', 'warm-pad', { gain: 0.5 }) }, { master: { volume: 1 } }));
      for (const [t, v] of events) e.at(t, (tt) => e.setParam('fx.comp.amount', v, { when: tt }));
      for (const n of [48, 60, 64, 67, 72]) e.noteOn(n, 110, { when: 0.1 });
      const b = await ctx.startRendering();
      return { e, L: b.getChannelData(0), R: b.getChannelData(1) };
    };
    const maxDiff = (a, b, from = 0) => {
      let m = 0;
      for (let i = Math.floor(from * SR); i < a.L.length; i++) m = Math.max(m, Math.abs(a.L[i] - b.L[i]), Math.abs(a.R[i] - b.R[i]));
      return m;
    };
    const never = await piano({ glue: false });
    const zero = await piano({});
    const neverDiff = maxDiff(never, zero);
    const zeroDetached = !zero.e.fx._glueConnected && zero.e.fx.glue.numberOfInputs === 1;
    // engage at .6 s, bypass at 1.2 s → after the 30 ms crossfade + detach it is the dry path again
    const onoff = await piano({}, [[0.6, 1], [1.2, 0]]);
    const afterDiff = maxDiff(never, onoff, 1.3);
    const detachedAfter = onoff.e.fx._glueConnected === false && onoff.e.fx.glueEngaged === false;
    // dynamics of piano chords played loud / soft / loud / soft (C3 C4 E4 G4 C5, vel 110/45/100/40), amount 0 vs 1.
    // NOTE: sample-peak crest factor goes UP (the 10 ms attack lets each hammer transient through while the body is
    // compressed); what the glue reduces is the loudness range (spread of 50 ms RMS) and the loud/soft chord gap.
    const dyn = async (amount) => {
      const need = [48, 60, 63, 66, 72];
      const def = { ...salDef, id: 'sal-dyn', layers: salDef.layers.map((L) => ({ ...L, samples: L.samples.filter((s) => need.includes(s.midi)) })) };
      // the chords start 0.4 s after the commit: the glue's dry→wet crossfade lands GLUE_ENGAGE_DELAY (0.3 s) after it
      // engages (round2-engine M3), so a chord right at the commit would be judged half uncompressed
      const o = 0.4;
      const ctx = mkCtx(4.2 + o);
      const e = await mkEngine(ctx);
      e.registry.samplers.set('sal-dyn', def);
      await use(e, patch({ 0: slot('sampler', 'sal-dyn') }, { master: { volume: 1 }, comp: { amount } }));
      const pat = [[0.1 + o, 110], [1.1 + o, 45], [2.1 + o, 100], [3.1 + o, 40]];
      for (const [t, v] of pat) for (const n of [48, 60, 64, 67, 72]) { e.noteOn(n, v, { when: t }); e.noteOff(n, { when: t + 0.9 }); }
      const b = await ctx.startRendering();
      const L = b.getChannelData(0), R = b.getChannelData(1);
      const rr = (a, c) => Math.sqrt(0.5 * (rms(L, SR, a, c) ** 2 + rms(R, SR, a, c) ** 2));
      const w = [];
      for (let t = 0.12 + o; t < 4 + o; t += 0.05) w.push(db(rr(t, t + 0.05)));
      w.sort((x, y) => x - y);
      const pk = Math.max(peakAbs(L, SR, 0.1 + o, 4 + o), peakAbs(R, SR, 0.1 + o, 4 + o));
      const ch = pat.map(([t]) => db(rr(t + 0.02, t + 0.8)));
      return {
        loudnessRangeDb: +(w[Math.floor(w.length * 0.95)] - w[Math.floor(w.length * 0.1)]).toFixed(1),
        loudSoftGapDb: +((ch[0] + ch[2]) / 2 - (ch[1] + ch[3]) / 2).toFixed(1),
        crestDb: +(db(pk) - db(rr(0.1 + o, 4 + o))).toFixed(2),
        rmsDb: +db(rr(0.1 + o, 4 + o)).toFixed(1),
      };
    };
    const c0 = await dyn(0);
    const c1 = await dyn(1);
    // engage/bypass mid-chord: no clicks (first-difference detector) around the switch
    // (the engage crossfade starts GLUE_ENGAGE_DELAY = 0.3 s after the request: round2-engine M3)
    const clk = [...clicks(onoff.L, SR, 0.55, 1.0), ...clicks(onoff.L, SR, 1.15, 1.35)];
    // reference tone (1 kHz, amplitude .1 = −23.01 dBFS RMS) into the sum at master 1: unity at any amount
    const unity = async (amount) => {
      const ctx = mkCtx(1.2);
      const e = await mkEngine(ctx, { lofi: false });
      await use(e, patch({}, { master: { volume: 1 }, comp: { amount } }), 0);
      const o = new OscillatorNode(ctx, { frequency: 1000 });
      o.connect(new GainNode(ctx, { gain: 0.1, channelCount: 1, channelCountMode: 'explicit' })).connect(e.fx.sum);
      o.start(0);
      const b = await ctx.startRendering();
      return +db(rms(b.getChannelData(0), SR, 0.8, 1.2)).toFixed(3);
    };
    const inDb = +db(0.1 / Math.SQRT2).toFixed(3);
    const ref = {};
    for (const a of [1, 0.5, 0.35]) ref[a] = await unity(a);
    const tbl = (await (await import('/js/engine/fx.js')).measureGlueRef()).map((x) => +x.toFixed(2));
    // master EQ responses: low shelf 100 Hz, peaking 1 kHz Q .8, high shelf 8 kHz
    const c = mkCtx(0.1);
    const e = await mkEngine(c);
    e.setParam('fx.eq.low', 6);
    e.setParam('fx.eq.mid', -4);
    e.setParam('fx.eq.high', 3);
    await c.startRendering();
    const fr = new Float32Array([30, 1000, 16000]);
    const tot = [0, 0, 0];
    for (const n of [e.fx.eqLow, e.fx.eqMid, e.fx.eqHigh]) {
      const m = new Float32Array(3);
      n.getFrequencyResponse(fr, m, new Float32Array(3));
      for (let i = 0; i < 3; i++) tot[i] += db(m[i]);
    }
    const eq = tot.map((x) => +x.toFixed(2));
    const eqOk = Math.abs(eq[0] - 6) < 0.4 && Math.abs(eq[1] + 4) < 0.25 && Math.abs(eq[2] - 3) < 0.3 && e.getParam('fx.eq.mid') === -4;
    const unityOk = Object.values(ref).every((x) => Math.abs(x - inDb) < 0.1);
    const pass = neverDiff <= 1e-5 && zeroDetached && afterDiff <= 1e-5 && detachedAfter && c1.loudnessRangeDb < c0.loudnessRangeDb - 5 && c1.loudSoftGapDb < c0.loudSoftGapDb - 3 && clk.length === 0 && unityOk && eqOk;
    return { pass, neverDiff, zeroDetached, afterBypassDiff: afterDiff, detachedAfter, dynamics0: c0, dynamics1: c1, clicks: clk.length, inDb, unityOutDb: ref, glueRefTableDb: tbl, masterEqDb_30_1k_16k: eq };
  },

  /** engine-3 #4: every FX preset path is a valid §4 address; applying them via setParam gives the intended space/echo. */
  async fxPresets() {
    const P = await import('/js/shared/fx-presets.js');
    const { describe, clamp } = await import('/js/shared/params.js');
    const bad = [];
    for (const list of [P.SPACE_PRESETS, P.ECHO_PRESETS, P.VIBE_PRESETS]) {
      for (const p of list) {
        for (const [path, v] of Object.entries(p.params)) {
          if (!describe(path)) bad.push(`${p.id}: ${path} unknown`);
          else if (clamp(path, v) !== v) bad.push(`${p.id}: ${path}=${v} out of range (→ ${clamp(path, v)})`);
        }
      }
    }
    // every preset applies through engine.setParam and reads back
    {
      const c0 = mkCtx(0.2);
      const e0 = await mkEngine(c0);
      for (const list of [P.SPACE_PRESETS, P.ECHO_PRESETS, P.VIBE_PRESETS]) {
        for (const p of list) {
          P.applyPreset(p, (k, v) => { if (!e0.setParam(k, v)) bad.push(`${p.id}: setParam(${k}) refused`); });
          const back = P.matchPreset([p], (k) => e0.getParam(k), 1e-9);
          if (back !== p) bad.push(`${p.id}: values did not read back`);
        }
      }
      await c0.startRendering();
    }
    // RT60 from the Schroeder integral of an impulse through the reverb (T20: −5 … −25 dB, ×3)
    const rt60 = async (id) => {
      const ctx = mkCtx(12);
      const e = await mkEngine(ctx, { lofi: false });
      await use(e, patch({}, { master: { volume: 1 } }), 0);
      P.applyPreset(P.SPACE_PRESETS.find((p) => p.id === id), (k, v) => e.setParam(k, v, { when: 0 }));
      const b = new AudioBuffer({ length: 64, numberOfChannels: 1, sampleRate: SR });
      b.getChannelData(0)[0] = 0.5;
      const s = new AudioBufferSourceNode(ctx, { buffer: b });
      s.connect(e.fx.reverb.input);
      s.start(1.5); // after the 0.8 s IR crossfade
      const d = (await ctx.startRendering()).getChannelData(0).subarray(Math.floor(1.5 * SR));
      const E = new Float64Array(d.length);
      let acc = 0;
      for (let i = d.length - 1; i >= 0; i--) E[i] = acc += d[i] * d[i];
      const lvl = (i) => 10 * Math.log10(E[i] / E[0]);
      let i5 = 0, i25 = 0;
      while (i5 < d.length && lvl(i5) > -5) i5++;
      i25 = i5;
      while (i25 < d.length && lvl(i25) > -25) i25++;
      return +((3 * (i25 - i5)) / SR).toFixed(2);
    };
    const rt = { room: await rt60('room'), stage: await rt60('stage'), cathedral: await rt60('cathedral') };
    // dotted eighth at 120 bpm = 0.375 s: impulse through the delay, echo lags
    const ctx = mkCtx(2.6);
    const e = await mkEngine(ctx, { lofi: false });
    await use(e, patch({}, { master: { volume: 1 } }), 0);
    e.setTempo(120);
    P.applyPreset(P.ECHO_PRESETS.find((p) => p.id === 'dotted'), (k, v) => e.setParam(k, v, { when: 0 }));
    const b = new AudioBuffer({ length: 64, numberOfChannels: 1, sampleRate: SR });
    b.getChannelData(0)[0] = 0.5;
    const s = new AudioBufferSourceNode(ctx, { buffer: b });
    s.connect(e.fx.delay.input);
    s.start(0.5);
    const lat = chainLatencyProbe(e, 2.2); // between echo 4 (2.0 s) and echo 5 (2.375 s)
    const out = await ctx.startRendering();
    const L = out.getChannelData(0), R = out.getChannelData(1);
    const latency = lat(L);
    // ping-pong: echo k at k × 0.375 s, odd k on the left, even k on the right, within 0.1 + 0.1·k ms (the tone LPF's
    // group delay is ≈ 0.07 ms per pass). The old dL/dR loop added one render quantum (2.9 ms) on some passes.
    const echoes = [1, 2, 3, 4].map((k) => {
      const d = k % 2 ? L : R;
      const c = 0.5 + k * 0.375 + latency;
      let m = 0, at = 0;
      for (let i = Math.floor((c - 0.03) * SR); i < Math.floor((c + 0.03) * SR); i++) if (Math.abs(d[i]) > m) { m = Math.abs(d[i]); at = i; }
      return +((at / SR - 0.5 - latency) * 1000).toFixed(2);
    });
    const echoOk = echoes.every((t, k) => Math.abs(t - 375 * (k + 1)) < 0.1 + 0.1 * (k + 1)) && e.getParam('fx.delay.sync') === '1/8d' && e.fx.delay.p.pingpong === true;
    const pass = bad.length === 0 && rt.cathedral > rt.stage && rt.stage > rt.room && rt.room > 0.5 && echoOk;
    return { pass, invalid: bad, rt60s: rt, dotted120: { echoMs: echoes, expectedMs: [375, 750, 1125, 1500], chainLatencyMs: +(latency * 1000).toFixed(2) } };
  },

  /** engine-3 #5 + #8: secondary "My Samples" manifests (namespaced ids, own group, relative dirs, release default 0.15). */
  async userManifests() {
    const ctx = mkCtx(1.5);
    const e = await mkEngine(ctx, { manifestUrls: [MANIFEST, '/api/user-samples/manifest.json', '/__nohealth/api/user-samples/manifest.json'] });
    const list = e.listInstruments().filter((x) => x.ref.type === 'sampler');
    const mine = list.filter((x) => x.ref.id.startsWith('user:'));
    const keys = e.registry.samplers.get('user:test-keys');
    const harp = e.registry.samplers.get('user:harp');
    const factoryKeys = e.registry.samplers.get('test-keys');
    await use(e, patch({ 0: slot('sampler', 'user:test-keys'), 1: slot('sampler', 'user:harp') }));
    e.noteOn(60, 90, { when: 0.1 });
    e.noteOn(69, 90, { when: 0.1 });
    const d = mono(await ctx.startRendering());
    const plays = db(rms(d, SR, 0.2, 1)) > -40;
    const reloaded = (await e.reloadManifests()).filter((x) => x.ref.id.startsWith('user:')).length;
    const requested = performance.getEntriesByType('resource').map((r) => r.name);
    const noHealthFetched = requested.some((u) => u.includes('/__nohealth/api/user-samples/manifest.json'));
    // default URLs (resolved against the app root) and the lone-manifestUrl back-compat
    const def = new AudioEngine({ context: mkCtx(0.1), instrumentModules: false });
    const lone = new AudioEngine({ context: mkCtx(0.1), manifestUrl: MANIFEST, instrumentModules: false });
    const r = {
      ids: mine.map((x) => `${x.ref.id} [${x.group}]`),
      userKeysRelease: keys?.release,
      harpRelease: harp?.release,
      harpWidthDefault: list.find((x) => x.ref.id === 'user:harp')?.widthDefault,
      harpStripWidth: e.slots[1]?.strip.width,
      userKeysUrl: keys?.layers[0].samples[0].url.replace(location.origin, ''),
      factoryKeysIntact: !!factoryKeys && factoryKeys.group === 'Piano',
      harpTrim: +e.slots[1]?.inst.output.gain.value.toFixed(4),
      plays,
      reloaded,
      noHealthFetched,
      defaults: def.manifestUrls.map((u) => u.replace(location.origin, '')),
      lone: lone.manifestUrls.map((u) => u.replace(location.origin, '')),
    };
    const pass =
      r.ids.length === 2 && r.ids.includes('user:test-keys [My Samples]') && r.ids.includes('user:harp [Plucked (mine)]') && r.userKeysRelease === 0.15 && r.harpRelease === 0.4 &&
      r.harpWidthDefault === 0.5 && Math.abs(r.harpStripWidth - 0.5) < 1e-9 && r.userKeysUrl === '/api/user-samples/keys/C4.wav' && r.factoryKeysIntact && Math.abs(r.harpTrim - Math.pow(10, 3 / 20)) < 1e-3 &&
      plays && reloaded === 2 && !noHealthFetched && r.defaults.join() === '/samples/manifest.json,/api/user-samples/manifest.json' && r.lone.join() === MANIFEST;
    return { pass, ...r };
  },

  /** engine-3 #6 (+ #7 registry side): macro.intensity morphs every pad-like patch, incl. synth-extra pads and organ soft-pad. */
  async padLikeIntensity() {
    const ctx = mkCtx(0.5);
    const e = await mkEngine(ctx, { instrumentModules: true });
    const has = (t, id) => e.registry.has({ type: t, id });
    const route = { modWheel: { target: 'macro.intensity', min: 0, max: 1 } };
    const ids = [['synth', 'supersaw-pad'], ['synth', 'juno-pad'], ['synth', 'shimmer-pad'], ['organ', 'soft-pad'], ['synth', 'bell']].filter(([t, id]) => has(t, id));
    const morphs = {};
    for (let k = 0; k < ids.length; k += 4) {
      const chunk = ids.slice(k, k + 4);
      const slots = {};
      chunk.forEach(([t, id], i) => (slots[i] = slot(t, id)));
      await use(e, patch(slots, {}, route));
      e.setWheel('mod', 0.6);
      chunk.forEach(([t, id], i) => (morphs[`${t}:${id}`] = +e.slots[i].morph.toFixed(3)));
    }
    const calib = e.listInstruments().find((x) => x.ref.id === 'pluck')?.calibWindow;
    await ctx.startRendering();
    const pads = Object.entries(morphs).filter(([k]) => k !== 'synth:bell');
    const pass = ids.length === 5 && pads.every(([, m]) => m === 0.6) && morphs['synth:bell'] === 0 && Array.isArray(calib) && calib[1] === 1;
    return { pass, morphs, pluckCalibWindow: calib };
  },

  /**
   * round2-engine M1: "no dampers above note 90" is opt-in per manifest entry (`undampedFrom`), on by default only for
   * factory `category: 'piano'`. A sustaining user pack (or any non-piano entry) releases every key.
   */
  async undampedOptIn() {
    const { normalizeManifest } = await import('/js/engine/sampler.js');
    const url = '/__fixtures/test-keys/soft/C4.wav'; // 2.4 s sine, −6 dB/s; claimed as G6 (91) → plays at rate 1
    const entry = (id, extra = {}) => ({ id, name: id, ext: 'wav', release: 0.12, layers: [{ vel: [0, 127], files: { G6: url } }], ...extra });
    const [fPiano, fStrings, fPianoOff] = normalizeManifest({ instruments: [entry('f-piano', { category: 'piano' }), entry('f-strings', { category: 'strings' }), entry('f-piano-off', { category: 'piano', undampedFrom: null })] }, MANIFEST);
    const [uPiano, uStrings, uOptIn] = normalizeManifest({ instruments: [entry('piano', { category: 'piano' }), entry('strings', { category: 'strings' }), entry('optin', { category: 'strings', undampedFrom: 90 })] }, '/api/user-samples/manifest.json', { idPrefix: 'user:', group: 'My Samples' });
    const fields = Object.fromEntries([fPiano, fStrings, fPianoOff, uPiano, uStrings, uOptIn].map((d) => [d.id, d.undampedFrom]));
    const decay = async (def) => {
      const ctx = mkCtx(2.2);
      const e = await mkEngine(ctx);
      e.registry.samplers.set(def.id, def);
      await use(e, patch({ 0: slot('sampler', def.id) }));
      e.noteOn(91, 100, { when: 0.1 });
      e.noteOff(91, { when: 1.0 });
      const d = mono(await ctx.startRendering());
      return +(db(rms(d, SR, 1.6, 1.9)) - db(rms(d, SR, 0.8, 0.95))).toFixed(1); // level after note-off re held
    };
    const rel = { 'f-piano': await decay(fPiano), 'f-strings': await decay(fStrings), 'user:piano': await decay(uPiano), 'user:strings': await decay(uStrings), 'user:optin': await decay(uOptIn) };
    const pass =
      fields['f-piano'] === 90 && fields['f-strings'] === null && fields['f-piano-off'] === null && fields['user:piano'] === null && fields['user:strings'] === null && fields['user:optin'] === 90 &&
      rel['f-piano'] > -10 && rel['user:optin'] > -10 && rel['f-strings'] < -30 && rel['user:piano'] < -30 && rel['user:strings'] < -30;
    return { pass, undampedFrom: fields, afterNoteOffReHeldDb: rel };
  },

  /**
   * round2-engine M2: with a wheel on macro.wash, a song switch lands on the *washed* reverb IR (staged in prepare),
   * and stays there when the wheel then moves inside the same bucket. It used to land on the song's plain size.
   */
  async washAcrossCommit() {
    const ctx = mkCtx(4);
    const e = await mkEngine(ctx, { lofi: false });
    const route = { modWheel: { target: 'macro.wash', min: 0, max: 1 } };
    await use(e, patch({}, { reverb: { size: 0.3, damp: 0.5 } }, route), 0);
    e.setWheel('mod', 1, { when: 0 });
    const R = e.fx.reverb;
    const want = R.irKey(0.9, 0.5);
    const seen = {};
    e.at(1.2, () => (seen.songA = R.active?.key));
    const tok = await e.prepare(patch({}, { reverb: { size: 0.5, damp: 0.5 } }, route));
    const staged = e._plan?.reverb?.key;
    e.at(1.5, (t) => {
      seen.committed = e.commit(tok, { when: t });
      seen.targetAfterCommit = R.targetKey;
    });
    e.at(2.6, (t) => {
      seen.songB = R.active?.key;
      e.setWheel('mod', 0.99, { when: t });
    });
    e.at(3.9, () => (seen.afterWheel = R.active?.key));
    await ctx.startRendering();
    const pass = seen.songA === want && staged === want && seen.committed && seen.targetAfterCommit === want && seen.songB === want && seen.afterWheel === want;
    return { pass, want, staged, ...seen };
  },

  /**
   * round2-engine M3: engaging the glue does not dip the level. 1 kHz reference tone (−23.01 dBFS) at master 1,
   * amount 1 engaged at 2.5 s; 50 ms windows over 2.5–3.2 s stay within ±0.3 dB of the input. Cases: fresh
   * compressor; after an earlier engage on a hot (0.9) signal and a bypass (stale detector); amount changed while
   * the compressor is still settling (the wet must not come in before the crossfade).
   */
  async glueEngageNoDip() {
    const inDb = db(0.1 / Math.SQRT2);
    const run = async (kind) => {
      const ctx = mkCtx(3.3);
      const e = await mkEngine(ctx, { lofi: false });
      await use(e, patch({}, { master: { volume: 1 } }), 0);
      const o = new OscillatorNode(ctx, { frequency: 1000 });
      const g = new GainNode(ctx, { gain: kind === 'stale' ? 0.9 : 0.1, channelCount: 1, channelCountMode: 'explicit' });
      if (kind === 'stale') g.gain.setValueAtTime(0.1, 1.2);
      o.connect(g).connect(e.fx.sum);
      o.start(0);
      if (kind === 'stale') {
        e.at(0.2, (t) => e.setParam('fx.comp.amount', 0.9, { when: t }));
        e.at(1.0, (t) => e.setParam('fx.comp.amount', 0, { when: t }));
      }
      e.at(2.5, (t) => e.setParam('fx.comp.amount', kind === 'retarget' ? 0.5 : 1, { when: t }));
      if (kind === 'retarget') e.at(2.6, (t) => e.setParam('fx.comp.amount', 1, { when: t }));
      const b = await ctx.startRendering();
      const L = b.getChannelData(0);
      const w = [];
      for (let t = 2.5; t + 0.05 <= 3.2 + 1e-9; t += 0.05) w.push(+(db(rms(L, SR, t, t + 0.05)) - inDb).toFixed(2));
      return { minDb: Math.min(...w), maxDb: Math.max(...w), engaged: e.fx.glueEngaged };
    };
    const r = { fresh: await run('fresh'), stale: await run('stale'), retarget: await run('retarget') };
    const pass = Object.values(r).every((x) => x.engaged && x.minDb > -0.3 && x.maxDb < 0.3);
    return { pass, inDb: +inDb.toFixed(2), windowsReInputDb: r };
  },

  /**
   * round2-engine m1–m3: a failed My Samples reload keeps the user instruments; a successful one clears the sample
   * cache's failure marks and unreferenced buffers for user URLs (factory ones untouched); a hand-edited manifest's
   * `release` and `gainTrim` are clamped (with a warning).
   */
  async userManifestGuards() {
    const { normalizeManifest } = await import('/js/engine/sampler.js');
    const ctx = mkCtx(0.5);
    const e = await mkEngine(ctx, { manifestUrls: [MANIFEST, '/api/user-samples/manifest.json'] });
    const warns = [];
    e.addEventListener('warn', (ev) => warns.push(ev.detail.message));
    const userIds = () => [...e.registry.samplers.keys()].filter((id) => id.startsWith('user:')).sort().join();
    const before = userIds();
    const uC4 = new URL('/api/user-samples/keys/C4.wav', location.href).href;
    const uA4 = new URL('/api/user-samples/keys/A4.wav', location.href).href;
    const fC4 = new URL('/__fixtures/test-keys/soft/C4.wav', location.href).href;
    const C = e.cache;
    C.failed.set(uA4, { at: Date.now(), permanent: true }); // (uC4 is decoded for real below, by user:test-keys)
    C.failed.set(fC4, { at: Date.now(), permanent: true });
    const fake = (refs) => ({ buffer: null, bytes: 100, refs: new Set(refs), lastUsed: 0 });
    C.entries.set(uA4, fake([]));
    C.entries.set(fC4, fake([]));
    C.bytes += 200;
    // synthetic failures (a real 503 would log a console error): manifest 503, then health unreachable
    const realFetch = window.fetch;
    const fail = async (mode) => {
      window.fetch = (u, o) => {
        const s = String(u);
        if (mode === '503' && s.includes('/api/user-samples/manifest.json')) return Promise.resolve(new Response('busy', { status: 503 }));
        if (mode === 'net' && s.includes('/api/health')) return Promise.reject(new TypeError('Failed to fetch'));
        if (mode === 'off' && s.includes('/api/health')) return Promise.resolve(new Response(JSON.stringify({ ok: true, userSamples: false }), { status: 200 }));
        return realFetch(u, o);
      };
      try {
        await e.reloadManifests();
      } finally {
        window.fetch = realFetch;
      }
      return userIds();
    };
    const after503 = await fail('503');
    const afterNet = await fail('net');
    const marksKept = C.failed.has(uA4) && C.entries.has(uA4);
    await use(e, patch({ 0: slot('sampler', 'user:test-keys') }));
    const notFallback = e.slots[0]?.inst && !e.slots[0].inst.isFallback && e.slots[0].inst.id === 'user:test-keys';
    const failWarned = warns.some((m) => /My Samples reload failed/.test(m));
    const afterOff = await fail('off'); // not served any more: the user entries do go
    await e.reloadManifests();
    const afterOk = userIds();
    const cache = {
      userFailedCleared: !C.failed.has(uA4),
      userEntryDropped: !C.entries.has(uA4),
      userReferencedKept: C.entries.has(uC4),
      factoryFailedKept: C.failed.has(fC4),
      factoryEntryKept: C.entries.has(fC4),
    };
    C.entries.set('x:ref', fake(['owner']));
    const refKept = C.invalidate(['x:ref']).dropped === 0 && C.entries.has('x:ref');
    // m3: clamping (secondary manifest, hand-edited values)
    const cw = [];
    const [hot] = normalizeManifest({ instruments: [{ id: 'hot', layers: [{ vel: [0, 127], files: { C4: 'a.wav' } }], release: 3, gainTrim: 40 }] }, '/api/user-samples/manifest.json', { idPrefix: 'user:', warn: (m) => cw.push(m) });
    const clamped = { release: hot.release, releaseParamDefault: hot.params.find((p) => p.key === 'release').default, gainTrimDb: hot.gainTrimDb, warnings: cw.length };
    await ctx.startRendering();
    const pass =
      before === 'user:harp,user:test-keys' && after503 === before && afterNet === before && marksKept && notFallback && failWarned && afterOff === '' && afterOk === before &&
      Object.values(cache).every(Boolean) && refKept && clamped.release === 1.5 && clamped.releaseParamDefault === 1.5 && clamped.gainTrimDb === 30 && clamped.warnings === 2;
    return { pass, before, after503, afterNet, marksKeptOnFailure: marksKept, userInstrumentNotFallback: notFallback, failWarned, afterNotServed: afterOff, afterOk, cache, refKept, clamped };
  },

  /**
   * polish-1: engine.slotLevel(i), the strip meters' tap. Created on the first read (not for an empty slot), reads
   * the slot's own level (a quiet slot 1 next to a loud slot 0), disconnected SLOT_TAP_IDLE_SEC after the last read
   * (not after the first), recreated by the next read, and a song switch taps the new strip. A just-connected
   * analyser has not run yet, so the first read of a fresh tap is zeros (a meter shows it one frame later).
   */
  async slotLevelTap() {
    const ctx = mkCtx(4.2);
    const e = await mkEngine(ctx);
    const A = patch({ 0: slot('synth', 'warm-pad'), 2: slot('synth', 'warm-pad', { gain: 0.1 }) });
    await use(e, A);
    const tokB = await e.prepare(A); // the same song again: a fresh strip (gapless commit at 3.2)
    const out = { bad: e.slotLevel(9), empty: e.slotLevel(1), tapsEmpty: e.slotTapCount() };
    out.first = e.slotLevel(0); // t = 0: tap created, silent
    out.tapsFirst = e.slotTapCount();
    e.noteOn(60, 110, { when: 0.1 });
    e.at(0.5, () => e.slotLevel(2)); // connects slot 2's tap (a fresh analyser reads zeros until it has run)
    e.at(0.8, () => {
      out.loud = e.slotLevel(0);
      out.quiet = e.slotLevel(2);
      out.taps08 = e.slotTapCount();
    });
    e.at(2.3, () => (out.taps23 = e.slotTapCount())); // last read 0.8 → still connected at 2.3 (first read + 2 s passed)
    e.at(3.0, () => (out.taps30 = e.slotTapCount())); // 0.8 + 2 s idle → released
    e.at(3.2, (t) => (out.committed = e.commit(tokB, { when: t })));
    e.noteOn(64, 110, { when: 3.3 });
    e.at(3.5, () => e.slotLevel(0)); // a fresh tap on the new strip
    e.at(3.8, () => {
      out.again = e.slotLevel(0);
      out.tapsAgain = e.slotTapCount();
      out.newStripTapped = !!e._slotTaps[0]?.strips.has(e.slots[0].strip);
    });
    await ctx.startRendering();
    await settle();
    e._teardown();
    out.tapsAfterTeardown = e._slotTaps.filter(Boolean).length;
    const r = (x) => x && { peak: +x.peak.toFixed(4), rms: +x.rms.toFixed(4) };
    const pass = out.bad === null && out.empty?.peak === 0 && out.tapsEmpty === 0 && out.first?.peak === 0 &&
      out.tapsFirst === 1 && out.loud?.peak > 0.01 && out.loud.rms > 0 && out.loud.rms <= out.loud.peak &&
      out.quiet?.peak > 0 && out.quiet.peak < out.loud.peak / 5 && out.taps08 === 2 && out.taps23 === 2 &&
      out.taps30 === 0 && out.committed === true && out.again?.peak > 0.01 && out.tapsAgain === 1 &&
      out.newStripTapped && out.tapsAfterTeardown === 0;
    return { pass, ...out, first: r(out.first), loud: r(out.loud), quiet: r(out.quiet), again: r(out.again) };
  },
};

// ----- real-time suites ------------------------------------------------------------------------------------------
function captureTap(engine, seconds) {
  // ScriptProcessor capture of the exact post-clip output (recordTap)
  const ctx = engine.ctx;
  const sp = ctx.createScriptProcessor(4096, 2, 2);
  const chunks = [];
  let n = 0;
  const need = Math.ceil(seconds * ctx.sampleRate);
  return new Promise((resolve) => {
    sp.onaudioprocess = (ev) => {
      const L = ev.inputBuffer.getChannelData(0);
      const R = ev.inputBuffer.getChannelData(1);
      const m = new Float32Array(L.length);
      for (let i = 0; i < L.length; i++) m[i] = 0.5 * (L[i] + R[i]);
      chunks.push(m);
      n += m.length;
      if (n >= need) {
        sp.onaudioprocess = null;
        engine.recordTap.disconnect(sp);
        sp.disconnect();
        const out = new Float32Array(n);
        let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        resolve(out);
      }
    };
    engine.recordTap.connect(sp);
    sp.connect(ctx.destination);
  });
}

// slot EQ (design/eq/AMENDMENT.md): offline.eqIdentity … offline.eqCpu
Object.assign(offline, eqSuites({ SR, mkCtx, mkEngine, slot, patch, use, mono, clicks, db }));

export const realtime = {
  async smoke() {
    const e = new AudioEngine({ seed: 3, manifestUrl: MANIFEST });
    await e.start();
    const state = e.ctx.state;
    const t0 = e.ctx.currentTime;
    await use(e, patch({ 0: slot('sampler', 'test-keys'), 1: slot('synth', 'warm-pad', { gain: 0.3 }) }));
    const cap = captureTap(e, 1.6);
    const tOn = e.ctx.currentTime + 0.05;
    e.noteOn(60, 100, { when: tOn });
    e.noteOff(60, { when: tOn + 0.6 });
    const d = await cap;
    const sr = e.ctx.sampleRate;
    let onsetWin = -Infinity;
    for (let t = 0; t < 0.4; t += 0.01) onsetWin = Math.max(onsetWin, db(rms(d, sr, t, t + 0.01)));
    let nan = false;
    for (const x of d) if (!Number.isFinite(x)) { nan = true; break; }
    const buf = new Float32Array(2048);
    e.analyserL.getFloatTimeDomainData(buf);
    const advanced = e.ctx.currentTime > t0;
    const stats = e._debugStats();
    e.dispose();
    return { pass: state === 'running' && advanced && onsetWin > -50 && !nan, state, onsetWindowDb: onsetWin, advanced, latencyMs: e.latencyMs, stats };
  },

  async restart() {
    const e = new AudioEngine({ seed: 9, manifestUrl: MANIFEST, instrumentModules: false });
    await e.start();
    await use(e, patch({ 0: slot('sampler', 'test-keys'), 1: slot('synth', 'warm-pad', { gain: 0.4 }) }, { reverb: { size: 0.4 } }));
    e.drone.configure({ mode: 'synth', gain: 0.5 });
    e.drone.setKey(7);
    e.setParam('slots.1.gain', 0.3);
    const mb = e.cache.decodedMB;
    const oldCtx = e.ctx;
    let fetched = 0;
    const orig = window.fetch;
    window.fetch = (...a) => { fetched++; return orig(...a); };
    await e.restart({ latency: 0.01 });
    window.fetch = orig;
    const cap = captureTap(e, 0.8);
    e.noteOn(60, 100, { when: e.ctx.currentTime + 0.05 });
    const d = await cap;
    const lvl = db(rms(d, e.ctx.sampleRate, 0.2, 0.8));
    const res = {
      newCtx: e.ctx !== oldCtx && oldCtx.state === 'closed',
      slot0: e.slots[0]?.ref.id,
      slot1Gain: e.getParam('slots.1.gain'),
      droneKey: e.drone.key,
      cacheSurvived: e.cache.decodedMB === mb,
      refetchedSamples: fetched,
      levelDb: lvl,
    };
    e.dispose();
    return { pass: res.newCtx && res.slot0 === 'test-keys' && Math.abs(res.slot1Gain - 0.3) < 1e-9 && res.droneKey?.pc === 7 && res.cacheSurvived && fetched <= 1 && lvl > -50, ...res };
  },

  /** #6: IRs are computed off the main thread; prepare resolves with the unit ready; commit and warmed switches set no convolver buffer. */
  async irOffMainThread() {
    const { irStats } = await import('/js/engine/fx.js');
    const e = new AudioEngine({ seed: 11, manifestUrl: MANIFEST, instrumentModules: false });
    await e.start();
    const R = e.fx.reverb;
    let sets = 0;
    let setMs = [];
    const onu = R._newUnit.bind(R);
    R._newUnit = (...a) => {
      const t = performance.now();
      const u = onu(...a);
      sets++;
      setMs.push(+(performance.now() - t).toFixed(1));
      return u;
    };
    const P = (size, damp = 0.5, predelay = 0.02) => patch({}, { reverb: { size, damp, predelay } });
    // cold prepare: IR in the worker, unit ready when prepare resolves
    const s0 = { ...irStats };
    const tok = await e.prepare(P(0.62, 0.3));
    const coldReady = R.units.has(R.irKey(0.62, 0.3));
    const setsBefore = sets;
    let t0 = performance.now();
    e.commit(tok);
    const commitMs = +(performance.now() - t0).toFixed(2);
    const commitSets = sets - setsBefore;
    // warmed: preload (idle-time unit), then the switch sets nothing
    await e.preload([P(0.3, 0.6), P(0.85, 0.2)]);
    await R.settled();
    const setsWarm = sets;
    t0 = performance.now();
    const p = e.prepare(P(0.85, 0.2, 0.04));
    const prepareSyncMs = +(performance.now() - t0).toFixed(2);
    const tok2 = await p;
    t0 = performance.now();
    e.commit(tok2);
    const commit2Ms = +(performance.now() - t0).toFixed(2);
    const warmSwitchSets = sets - setsWarm;
    const mainThreadIRs = irStats.sync - s0.sync + irStats.chunked - s0.chunked;
    const workerIRs = irStats.worker - s0.worker;
    const units = R.units.size;
    e.dispose();
    const pass = coldReady && commitSets === 0 && warmSwitchSets === 0 && mainThreadIRs === 0 && workerIRs === 3 && units >= 4;
    return { pass, coldReady, commitSets, warmSwitchSets, mainThreadIRs, workerIRs, units, commitMs, prepareSyncMs, commit2Ms, convolverSetMs: setMs, soft_note: 'convolverSetMs = Chromium ConvolverNode.buffer setter (main thread, unavoidable); only in prepare (cold) or idle callbacks (preload)' };
  },

  /** #2: two key changes 5 ms apart in files mode → only the last key plays afterwards. */
  async droneFilesKeyRace() {
    const e = new AudioEngine({ seed: 5, manifestUrl: MANIFEST, instrumentModules: false });
    await e.start();
    const d = e.drone;
    d.attachFiles([
      { name: 'Test Pad - C.wav', url: '/__fixtures/pads/Test%20Pad%20-%20C.wav' },
      { name: 'Test Pad - G.wav', url: '/__fixtures/pads/Test%20Pad%20-%20G.wav' },
    ]);
    d.configure({ mode: 'files', fade: 1 });
    d.setKey(0);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(2500);
    if (d.effectiveMode !== 'files') {
      e.dispose();
      return { pass: true, skipped: 'headless Chromium could not play the WAV fixture' };
    }
    d.setKey(7);
    await wait(5);
    d.setKey(0);
    await wait(3000);
    const audible = d.pool.filter((x) => !x.el.paused && x.gain.gain.value > 0.01).map((x) => x.file?.name);
    e.dispose();
    return { pass: audible.length === 1 && /- C\./.test(audible[0]), audible };
  },

  /** #3: key changes while the pool is busy never hard-cut an audible element. */
  async droneFilesNoHardCut() {
    const e = new AudioEngine({ seed: 6, manifestUrl: MANIFEST, instrumentModules: false });
    await e.start();
    const d = e.drone;
    d.attachFiles([
      { name: 'Test Pad - C.wav', url: '/__fixtures/pads/Test%20Pad%20-%20C.wav' },
      { name: 'Test Pad - G.wav', url: '/__fixtures/pads/Test%20Pad%20-%20G.wav' },
    ]);
    d.configure({ mode: 'files', fade: 4 });
    d.setKey(0);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(2500);
    if (d.effectiveMode !== 'files') {
      e.dispose();
      return { pass: true, skipped: 'headless Chromium could not play the WAV fixture' };
    }
    const cuts = [];
    const orig = d._releaseEl.bind(d);
    d._releaseEl = (el) => {
      cuts.push({ gain: +el.gain.gain.value.toFixed(3), playing: !el.el.paused });
      return orig(el);
    };
    for (const k of [7, 0, 7, 0, 7]) {
      d.setKey(k);
      await wait(700);
    }
    await wait(5000);
    const hard = cuts.filter((c) => c.playing && c.gain > 0.05);
    const pool = d.pool.length;
    const audible = d.pool.filter((x) => !x.el.paused && x.gain.gain.value > 0.01).map((x) => x.file?.name);
    e.dispose();
    return { pass: hard.length === 0 && pool <= 6 && audible.length === 1 && /- G\./.test(audible[0]), hardCutsWhileAudible: hard, releases: cuts.length, pool, audible };
  },

  /** #4 + #10: restart keeps the files-mode drone, wheel values/pickup owner and the fade-out state. */
  async restartKeepsState() {
    const e = new AudioEngine({ seed: 8, manifestUrl: MANIFEST, instrumentModules: false });
    await e.start();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await use(e, patch({ 1: slot('synth', 'warm-pad') }, {}, { modWheel: { target: 'slots.1.gain', min: 0, max: 1 } }));
    e.drone.attachFiles([{ name: 'Test Pad - C.wav', url: '/__fixtures/pads/Test%20Pad%20-%20C.wav' }]);
    e.drone.configure({ mode: 'files', fade: 1 });
    e.drone.setKey(0);
    e.setWheel('mod', 0.1);
    await wait(1500);
    const filesOk = e.drone.effectiveMode === 'files';
    e.fadeOutAll(0.2);
    await wait(400);
    await e.restart();
    await wait(1500);
    const after = {
      droneMode: e.drone.effectiveMode,
      wheel: e.wheel.mod,
      padWheelGain: +e.slots[1].strip.wheel.gain.value.toFixed(3),
      fadeGain: +e.fx.fadeGain.gain.value.toFixed(3),
    };
    e.noteOn(60, 100);
    await wait(100);
    after.fadeAfterNote = +e.fx.fadeGain.gain.value.toFixed(3);
    e.noteOff(60);
    // virtual wheel owner survives → hardware must pick up
    e.setWheel('virtual', 0.4);
    await e.restart();
    const ignored = e.setWheel('mod', 0.9) === false;
    const owner = e.wheelValues().owner;
    e.dispose();
    const pass = (!filesOk || after.droneMode === 'files') && Math.abs(after.wheel - 0.1) < 1e-9 && Math.abs(after.padWheelGain - 0.1) < 0.01 && after.fadeGain === 0 && after.fadeAfterNote > 0.99 && ignored && owner === 'virtual';
    return { pass, filesPlayable: filesOk, ...after, pickupAfterRestart: ignored, owner };
  },

  /** round2-engine M2: the washed reverb size survives restart() (it used to come back at the song's plain size). */
  async washSurvivesRestart() {
    const e = new AudioEngine({ seed: 9, manifestUrl: MANIFEST, instrumentModules: false });
    await e.start();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const route = { modWheel: { target: 'macro.wash', min: 0, max: 1 } };
    await use(e, patch({}, { reverb: { size: 0.3, damp: 0.5 } }, route));
    e.setWheel('mod', 1);
    const want = e.fx.reverb.irKey(0.9, 0.5);
    const settle = async () => {
      for (let i = 0; i < 60 && e.fx.reverb.active?.key !== want; i++) await wait(100);
      return e.fx.reverb.active?.key;
    };
    const before = await settle();
    await e.restart();
    const afterRestart = await settle();
    const targetAfterRestart = e.fx.reverb.targetKey;
    await use(e, patch({}, { reverb: { size: 0.5, damp: 0.5 } }, route));
    const afterSwitch = await settle();
    e.dispose();
    const pass = before === want && afterRestart === want && targetAfterRestart === want && afterSwitch === want;
    return { pass, want, before, afterRestart, targetAfterRestart, afterSwitch };
  },

  async droneFiles() {
    const e = new AudioEngine({ seed: 5, manifestUrl: MANIFEST, instrumentModules: false });
    await e.start();
    const warns = [];
    e.addEventListener('warn', (ev) => warns.push(ev.detail.message));
    const n = e.drone.attachFiles([
      { name: 'Test Pad - C.wav', url: '/__fixtures/pads/Test%20Pad%20-%20C.wav' },
      { name: 'Test Pad - G.wav', url: '/__fixtures/pads/Test%20Pad%20-%20G.wav' },
    ]);
    // can this browser play the media at all?
    const probe = document.createElement('audio');
    probe.src = '/__fixtures/pads/Test%20Pad%20-%20C.wav';
    const playable = await new Promise((r) => {
      probe.oncanplay = () => r(true);
      probe.onerror = () => r(false);
      setTimeout(() => r(false), 5000);
    });
    if (!playable) {
      e.dispose();
      return { pass: true, skipped: 'headless Chromium could not load the WAV fixture into <audio>' };
    }
    e.drone.configure({ mode: 'files', gain: 1, fade: 2 });
    e.drone.setKey(0);
    const d = await captureTap(e, 31);
    const sr = e.ctx.sampleRate;
    // started ~0.1–0.5 s after play() + 2 s fade-in; measure from 4 s to 31 s
    const w = minWindowDb(d, sr, 4, 30.9);
    const els = e.drone.pool ? e.drone.pool.filter((x) => x.busy).length : 0;
    const loops = e.drone.pool ? e.drone.pool.reduce((a, x) => a + x.seq, 0) : 0;
    e.dispose();
    return { pass: n === 2 && w.min > -60 && !warns.some((x) => /unavailable|failed/.test(x)), attached: n, minWindowDb: w.min, at: w.at, busyElements: els, elementStarts: loops, warns };
  },
};
