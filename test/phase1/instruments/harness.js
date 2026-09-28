// Page-side harness: builds instruments in a seeded OfflineAudioContext, renders, analyses in JS.
// Loaded by harness.html; run.mjs calls window.T.<case>(...) through page.evaluate and asserts on the numbers.
import { SynthInstrument, PATCHES, glassWaves } from '/js/engine/synth.js';
import { OrganInstrument, PRESETS } from '/js/engine/organ.js';
import { createRng } from '/js/shared/prng.js';
import { noteToFreq } from '/js/shared/music.js';

const SR = 44100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

// `raw`: tap the instrument before its static output ceiling (trimNode) — for tests that rely on linear
// superposition of renders (steal), which a soft-clip engaged by 17 stacked voices would break.
function make(ctx, kind, id, params = {}, seed = 1234, raw = false) {
  const rng = createRng(seed);
  const inst = kind === 'organ' ? new OrganInstrument(ctx, rng, id, params) : new SynthInstrument(ctx, rng, id, params);
  (raw && inst.trimNode ? inst.trimNode : inst.output).connect(ctx.destination);
  return inst;
}

/** Render `seconds`; `setup(inst, ctx)` schedules events and may return extra state. */
async function render(kind, id, params, seconds, setup, seed = 1234, raw = false) {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SR), SR);
  const inst = make(ctx, kind, id, params, seed, raw);
  const extra = (await setup(inst, ctx)) || {};
  const t0 = performance.now();
  const buf = await ctx.startRendering();
  const renderMs = performance.now() - t0;
  await sleep(30); // let the last onended events land
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const M = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) M[i] = 0.5 * (L[i] + R[i]);
  return { inst, L, R, M, extra, renderMs, seconds };
}

// ---- analysis ---------------------------------------------------------------------------------------
const idx = (t) => Math.max(0, Math.round(t * SR));
function peakAbs(x, a = 0, b = Infinity) {
  let m = 0;
  for (let i = idx(a), e = Math.min(x.length, idx(b)); i < e; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
}
function rms(x, a = 0, b = Infinity) {
  let s = 0, n = 0;
  for (let i = idx(a), e = Math.min(x.length, idx(b)); i < e; i++) { s += x[i] * x[i]; n++; }
  return n ? Math.sqrt(s / n) : 0;
}
function hasNaN(...chs) {
  for (const x of chs) for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return true;
  return false;
}
function rmsWindows(x, win = 0.01) {
  const n = Math.round(win * SR);
  const out = [];
  for (let i = 0; i + n <= x.length; i += n) {
    let s = 0;
    for (let j = i; j < i + n; j++) s += x[j] * x[j];
    out.push(Math.sqrt(s / n));
  }
  return out;
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
/** Hann-windowed magnitude spectrum of x[a..a+len) zero-padded to N. */
function spectrum(x, a, len, N) {
  const re = new Float64Array(N), im = new Float64Array(N);
  const s = idx(a);
  for (let i = 0; i < len && s + i < x.length; i++) re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1)));
  fft(re, im);
  const mag = new Float64Array(N / 2);
  for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
  return mag;
}
/** Peak frequency (parabolic interpolation on log magnitude) within [fLo, fHi]. */
function peakFreq(mag, N, fLo = 20, fHi = 20000) {
  const k0 = Math.max(1, Math.floor((fLo * N) / SR)), k1 = Math.min(mag.length - 2, Math.ceil((fHi * N) / SR));
  let k = k0;
  for (let i = k0; i <= k1; i++) if (mag[i] > mag[k]) k = i;
  const a = Math.log(mag[k - 1] + 1e-30), b = Math.log(mag[k] + 1e-30), c = Math.log(mag[k + 1] + 1e-30);
  const p = (0.5 * (a - c)) / (a - 2 * b + c || 1e-30);
  return ((k + p) * SR) / N;
}
function magAt(mag, N, f, halfWidthHz = 3) {
  const k0 = Math.floor(((f - halfWidthHz) * N) / SR), k1 = Math.ceil(((f + halfWidthHz) * N) / SR);
  let m = 0;
  for (let k = Math.max(0, k0); k <= k1 && k < mag.length; k++) m = Math.max(m, mag[k]);
  return m;
}
function centroid(x, a, b) {
  const N = 16384;
  const acc = new Float64Array(N / 2);
  let frames = 0;
  for (let t = a; t + N / SR <= b; t += N / SR / 2) {
    const m = spectrum(x, t, N, N);
    for (let k = 0; k < m.length; k++) acc[k] += m[k] * m[k];
    frames++;
  }
  let num = 0, den = 0;
  for (let k = 1; k < acc.length; k++) { num += ((k * SR) / N) * acc[k]; den += acc[k]; }
  return { hz: num / den, frames };
}
/**
 * Click detector (SPEC §11): |first difference| > 6 × its local median (20 ms window) inside [a, b].
 * Returns the worst ratio found.
 */
function clickScan(x, a, b, from = 0) {
  const W = Math.round(0.02 * SR);
  const i0 = Math.max(1, idx(from));
  const d = new Float64Array(x.length);
  for (let i = 1; i < x.length; i++) d[i] = Math.abs(x[i] - x[i - 1]);
  let worst = 0, at = 0;
  const hop = Math.round(0.001 * SR);
  for (let c = idx(a); c < Math.min(x.length, idx(b)); c += hop) {
    const lo = Math.max(i0, c - W / 2), hi = Math.min(x.length, Math.max(c + W / 2, lo + W / 2));
    const w = Array.from(d.subarray(lo, hi)).sort((p, q) => p - q);
    const med = w[w.length >> 1] || 1e-12;
    for (let i = c; i < Math.min(c + hop, x.length); i++) {
      const r = d[i] / med;
      if (r > worst) { worst = r; at = i / SR; }
    }
  }
  return { ratio: worst, at };
}
/** Energy above `fc` (4-pole Butterworth HPF = two RBJ biquads, Q .541/1.307) of x over [a,b]. */
function hfEnergy(x, fc, a, b) {
  let y = Float64Array.from(x.subarray(Math.max(0, idx(a) - 2048), Math.min(x.length, idx(b))));
  for (const Q of [0.5412, 1.3066]) {
    const w0 = (2 * Math.PI * fc) / SR, al = Math.sin(w0) / (2 * Q), cw = Math.cos(w0);
    const b0 = (1 + cw) / 2, b1 = -(1 + cw), b2 = (1 + cw) / 2, a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
    const out = new Float64Array(y.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = (b0 * y[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1; x1 = y[i]; y2 = y1; y1 = v; out[i] = v;
    }
    y = out;
  }
  let s = 0;
  for (let i = Math.min(2048, idx(a)); i < y.length; i++) s += y[i] * y[i];
  return s;
}
/** Dominant amplitude-modulation rate in [fLo,fHi] of x over [a,b] (rectify, 10 ms smoothing, DFT scan). */
function amRate(x, a, b, fLo = 0.3, fHi = 12) {
  const env = [];
  const hop = Math.round(SR / 200);
  for (let i = idx(a); i + hop <= Math.min(x.length, idx(b)); i += hop) {
    let s = 0;
    for (let j = i; j < i + hop; j++) s += x[j] * x[j];
    env.push(Math.sqrt(s / hop));
  }
  const mean = env.reduce((p, q) => p + q, 0) / env.length;
  let best = 0, bestF = 0, total = 0;
  for (let f = fLo; f <= fHi; f += 0.02) {
    let re = 0, im = 0;
    for (let i = 0; i < env.length; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (env.length - 1));
      re += (env[i] - mean) * w * Math.cos((2 * Math.PI * f * i) / 200);
      im -= (env[i] - mean) * w * Math.sin((2 * Math.PI * f * i) / 200);
    }
    const m = Math.hypot(re, im);
    if (m > best) { best = m; bestF = f; }
  }
  // modulation depth ≈ 2·|X(f)| / (Σw · mean)
  const sw = env.length / 2;
  total = (2 * best) / (sw * mean);
  return { hz: bestF, depth: total };
}

// ---- cases ----------------------------------------------------------------------------------------
const ALL = [
  ...PATCHES.map((p) => ({ kind: 'synth', id: p.id, meta: p })),
  ...PRESETS.map((p) => ({ kind: 'organ', id: p.id, meta: p })),
];

function voiceBook(inst, voices) {
  return {
    liveVoices: inst.liveVoiceCount(),
    liveNodes: inst.liveNodeCount(),
    voiceNodes: voices.map((v) => v.liveNodes).reduce((a, b) => a + b, 0),
    states: [...new Set(voices.map((v) => v.state))],
  };
}

const T = {
  list: () => ALL.map(({ kind, id, meta }) => ({ kind, id, name: meta.name, group: meta.group, params: meta.params.map((p) => p.key) })),

  // noteOn C4 vel .8 for 1 s, release → non-silent, finite, peak ≤ 0 dBFS, < −60 dBFS by off + r·1.3 + .5
  async basic(kind, id, params = {}) {
    const on = 0.1, off = 1.1;
    const probe = make(new OfflineAudioContext(1, 1, SR), kind, id, params);
    const r = probe.params.release;
    const seconds = off + r * 1.3 + 0.5 + 0.4;
    const voices = [];
    const res = await render(kind, id, params, seconds, (inst) => {
      const v = inst.noteOn(60, 0.8, on);
      voices.push(v);
      inst.noteOff(v, off);
    });
    const deadline = off + r * 1.3 + 0.5;
    return {
      release: r,
      holdRmsDb: db(rms(res.M, on + 0.3, off)),
      peakDb: db(Math.max(peakAbs(res.L), peakAbs(res.R))),
      nan: hasNaN(res.L, res.R),
      tailDb: db(Math.max(peakAbs(res.L, deadline), peakAbs(res.R, deadline))),
      renderMs: res.renderMs,
      ...voiceBook(res.inst, voices),
    };
  },

  // REVIEW 1.1: noteOff 0.2 s into a 1.2 s attack must release from where it is, never swell.
  async releaseDuringAttack(kind, id) {
    const meta = ALL.find((x) => x.id === id).meta;
    const hasAttack = meta.params.some((p) => p.key === 'attack');
    const params = hasAttack ? { attack: 1.2 } : {};
    // unison detune beats at ~2–3 Hz (±1.5 dB in 40 ms windows) — that is not the envelope under test
    if (meta.params.some((p) => p.key === 'detune')) params.detune = 0;
    const on = 0.1, off = 0.3;
    const probe = make(new OfflineAudioContext(1, 1, SR), kind, id, params);
    const r = probe.params.release;
    const seconds = off + r * 1.3 + 0.9;
    const voices = [];
    const res = await render(kind, id, params, seconds, (inst) => {
      const v = inst.noteOn(60, 0.8, on);
      voices.push(v);
      inst.noteOff(v, off);
    });
    // 40 ms windows (≥ 2 periods of the lowest partial, sub at C3) aligned on the noteOff: the one ending at off
    // vs every one starting ≥ 20 ms after it (a linear attack still rises until off itself).
    const atOff = rms(res.M, off - 0.04, off);
    let maxAfter = 0;
    for (let t = off + 0.02; t + 0.04 <= seconds; t += 0.04) maxAfter = Math.max(maxAfter, rms(res.M, t, t + 0.04));
    const deadline = off + r * 1.3 + 0.5;
    return {
      hasAttack,
      atOffDb: db(atOff),
      maxAfterDb: db(maxAfter),
      unreleasedLevelDb: hasAttack ? db(rms(res.M, on + 1.3, on + 1.35)) : null, // what 1.1 bug would leave
      tailDb: db(Math.max(peakAbs(res.L, deadline), peakAbs(res.R, deadline))),
      nan: hasNaN(res.L, res.R),
      ...voiceBook(res.inst, voices),
    };
  },

  // 17 overlapping notes → the 17th steals the oldest (voice 0) with a 20 ms fade. Three renders, same seed
  // (so every voice is sample-identical across them — only the steal differs):
  //   A: polyphony 17, nothing stolen   B: like A but voice 0 killed at its own start (never sounds)
  //   C: polyphony 16 → steal at tS (mode 'hard': polyphony 17 + voice0.kill(tS), no fade)
  // voice0 = A − B; the steal transient is D = C − A = −voice0·(1 − g(t)).
  // A click is broadband: high-passed (8 kHz, 4-pole; sub-bass 1.5 kHz, it is LPF'd at 250 Hz) energy of D over
  // the fade window must not exceed that of voice0 itself (a smooth gain adds no HF) — ratio in dB.
  // Also reported: SPEC detector (|Δx| > 6× local 20 ms median) on the mix C vs the same scan on A.
  async steal(kind, id, mode = 'steal') {
    const hasAttack = ALL.find((x) => x.id === id).meta.params.some((p) => p.key === 'attack');
    const params = hasAttack ? { attack: 0.01 } : {};
    if (kind === 'organ') params.click = 0;
    const tS = 0.1 + 16 * 0.05;
    const play = (poly17, killAt) => (inst) => {
      if (poly17) inst.alloc.max = 17;
      const vs = [];
      for (let i = 0; i < 17; i++) vs.push(inst.noteOn(48 + i, 0.8, 0.1 + i * 0.05));
      if (killAt !== undefined) vs[0].kill(killAt);
      return { vs };
    };
    const dur = tS + 0.3;
    const A = await render(kind, id, params, dur, play(true), 1234, true);
    const B = await render(kind, id, params, dur, play(true, 0.1), 1234, true);
    const C = await render(kind, id, params, dur, mode === 'hard' ? play(true, tS) : play(false), 1234, true);
    const v0 = new Float32Array(A.M.length), D = new Float32Array(A.M.length);
    for (let i = 0; i < D.length; i++) { v0[i] = A.M[i] - B.M[i]; D[i] = C.M[i] - A.M[i]; }
    const band = id === 'sub-bass' ? 1500 : 8000;
    const e = (x) => hfEnergy(x, band, tS, tS + 0.03);
    const hfRatioDb = 10 * Math.log10((e(D) + 1e-20) / (e(v0) + 1e-20));
    const hfVsMixDb = 10 * Math.log10((e(D) + 1e-20) / (e(C.M) + 1e-20));
    let ev0 = 0;
    for (let i = idx(tS); i < idx(tS + 0.03); i++) ev0 += v0[i] * v0[i];
    const hfFracDb = 10 * Math.log10((e(D) + 1e-20) / (ev0 + 1e-20));
    const mixC = clickScan(C.M, tS - 0.002, tS + 0.03);
    const mixA = clickScan(A.M, tS - 0.002, tS + 0.03);
    const stolen = C.extra.vs[0];
    return {
      mode,
      hfRatioDb,
      hfVsMixDb,
      hfFracDb,
      preDiff: peakAbs(D, 0, tS - 0.001),
      mixRatio: mixC.ratio,
      mixRatioNoSteal: mixA.ratio,
      steals: C.inst.alloc.steals,
      stolenState: stolen.state,
      stolenNodes: stolen.liveNodes,
      voice0Db: db(rms(v0, tS - 0.05, tS)),
      nan: hasNaN(C.L, C.R),
    };
  },

  // kill() → every source stopped, all nodes disconnected (Voice bookkeeping) once onended fired.
  async kill(kind, id) {
    const voices = [];
    const res = await render(kind, id, {}, 2.5, (inst) => {
      for (const [i, n] of [60, 64, 67, 71].entries()) voices.push(inst.noteOn(n, 0.8, 0.1 + i * 0.01));
      voices[0].kill(0.5);
      voices[1].kill(0.5);
      voices[2].fadeOut(0.5, 0.03);
      inst.allOff(0.6);
      return { before: voices.map((v) => v.liveNodes) };
    });
    return { nodesBefore: res.extra.before, ...voiceBook(res.inst, voices), tailDb: db(peakAbs(res.M, 0.7)) };
  },

  // Organ drawbars: 800000000 → peak at f/2 (16′); 008000000 → peak at f (8′).
  async drawbarPeak(bars) {
    const params = { rotary: 'off', percussion: false, click: 0, drive: 0 };
    for (let i = 0; i < 9; i++) params[`drawbar${i + 1}`] = Number(bars[i]);
    const res = await render('organ', 'gospel', params, 1.6, (inst) => { inst.noteOn(60, 0.8, 0.05); });
    const N = 65536;
    const mag = spectrum(res.M, 0.3, N >> 1, N);
    return { peakHz: peakFreq(mag, N, 40, 4000), f: noteToFreq(60) };
  },

  // Rotary AM rate (left mic): fast vs slow; `viaMorph` sets rotary slow and calls morph(1).
  async rotaryRate(speed, viaMorph = false) {
    const params = { percussion: false, click: 0, rotary: viaMorph ? 'slow' : speed };
    const res = await render('organ', 'gospel', params, 9, (inst) => {
      if (viaMorph) inst.morph(1, 0);
      inst.noteOn(72, 0.8, 0.05);
      inst.noteOn(76, 0.8, 0.05);
    });
    const L = amRate(res.L, 4, 9);
    const R = amRate(res.R, 4, 9);
    return { L, R };
  },

  // FM EP keytracked decay: time from peak to −20 dB for C3 vs C6.
  async epDecay(note) {
    const res = await render('synth', 'soft-keys', { tremolo: 0 }, 7, (inst) => { inst.noteOn(note, 0.8, 0.05); });
    const w = rmsWindows(res.M, 0.02);
    let pk = 0, pi = 0;
    w.forEach((x, i) => { if (x > pk) { pk = x; pi = i; } });
    let j = pi;
    while (j < w.length && w[j] > pk * 0.1) j++;
    return { t20: (j - pi) * 0.02, reached: j < w.length };
  },

  // Sub bass 2nd harmonic level (C2) at a given drive.
  async subHarmonic(drive) {
    const res = await render('synth', 'sub-bass', { drive }, 2, (inst) => { inst.noteOn(36, 0.8, 0.05); });
    const N = 65536;
    const f = noteToFreq(36);
    const mag = spectrum(res.M, 0.4, N >> 1, N);
    const h1 = magAt(mag, N, f), h2 = magAt(mag, N, 2 * f);
    return { h2dB: db(h2 / h1), peakHz: peakFreq(mag, N, 30, 400) };
  },

  // Drone-osc per-voice drift: 4th harmonic frequency across 1 s windows (unison spread/drift zeroed).
  async droneDrift(drift) {
    const params = { detune: 0, unisonDrift: 0, drift, attack: 0.3 };
    const res = await render('synth', 'drone-osc', params, 24, (inst) => { inst.noteOn(48, 0.8, 0.05); });
    const f4 = 4 * noteToFreq(48);
    const N = 65536;
    const fs = [];
    for (let t = 2; t + 1 <= 23; t += 1) fs.push(peakFreq(spectrum(res.M, t, SR, N), N, f4 - 8, f4 + 8));
    const lo = Math.min(...fs), hi = Math.max(...fs);
    return { spreadCents: 1200 * Math.log2(hi / lo), minHz: lo, maxHz: hi, f4 };
  },

  // Strings delayed vibrato (SPEC §3.3: .5 s onset, 5 Hz ±8¢). Unison detune zeroed so the 5 saws are coherent;
  // instantaneous frequency of the 4th harmonic from 50 ms Hann windows (10 ms hop). Note-on at 0.05 s.
  async vibratoOnset() {
    const on = 0.05;
    const note = 57; // A3, 220 Hz
    const res = await render('synth', 'strings', { detune: 0 }, 2.2, (inst) => { inst.noteOn(note, 0.8, on); });
    const h = 4 * noteToFreq(note);
    const N = 16384, W = 0.05, hop = 0.01;
    const track = (a, b) => {
      const fs = [];
      for (let t = a; t + W <= b + 1e-9; t += hop) fs.push(peakFreq(spectrum(res.M, t, Math.round(W * SR), N), N, h - 60, h + 60));
      const lo = Math.min(...fs), hi = Math.max(...fs);
      return { ppCents: 1200 * Math.log2(hi / lo), n: fs.length };
    };
    const early = track(on + 0.05, on + 0.4); // entirely inside the 0.5 s onset delay (ends 0.45 s)
    const late = track(on + 1.0, on + 2.0);
    return { earlyPpCents: early.ppCents, latePpCents: late.ppCents, windows: [early.n, late.n], hz: h };
  },

  // Morph direction: spectral centroid (morph 0 vs 1); soft-keys: tremolo AM depth instead.
  async morphEffect(kind, id) {
    const note = id === 'sub-bass' ? 36 : 60;
    const out = {};
    for (const x of [0, 1]) {
      const res = await render(kind, id, id === 'soft-keys' ? { tremolo: 0.1 } : {}, 3, (inst) => {
        inst.morph(x, 0);
        inst.noteOn(note, 0.8, 0.05);
      });
      if (id === 'sub-bass') {
        // morph = drive: 2nd harmonic re fundamental (C2)
        const N = 65536, f = noteToFreq(note), mag = spectrum(res.M, 0.8, N >> 1, N);
        out[x] = { value: magAt(mag, N, 2 * f) / magAt(mag, N, f) };
      } else if (id === 'soft-keys') {
        // auto-pan depth: modulation of L/(L+R) energy at the tremolo rate
        const wl = rmsWindows(res.L, 0.005), wr = rmsWindows(res.R, 0.005);
        const bal = wl.map((l, i) => l / (l + wr[i] + 1e-12)).slice(Math.round(0.3 / 0.005), Math.round(1.5 / 0.005));
        out[x] = { value: Math.max(...bal) - Math.min(...bal) };
      } else {
        out[x] = { value: centroid(res.M, 0.8, 2.9).hz };
      }
    }
    return { metric: id === 'soft-keys' ? 'panDepth' : id === 'sub-bass' ? 'H2/H1' : 'centroidHz', m0: out[0].value, m1: out[1].value };
  },

  // Bend + legato on the sub bass (sine peak).
  async bendLegato() {
    const res = await render('synth', 'sub-bass', { drive: 0 }, 3, (inst) => {
      const v = inst.noteOn(36, 0.8, 0.05);
      inst.setBend(2, 0.05);
      inst.legatoTo(v, 43, 1.5);
    });
    const N = 65536;
    const a = peakFreq(spectrum(res.M, 0.3, N >> 1, N), N, 30, 200);
    const b = peakFreq(spectrum(res.M, 1.8, N >> 1, N), N, 30, 200);
    return { bentHz: a, expectBent: noteToFreq(38), legatoHz: b, expectLegato: noteToFreq(45) };
  },

  // Every param / morph / bend exercised on a held note: finite, bounded, still decays.
  async allParams(kind, id) {
    const meta = ALL.find((x) => x.id === id).meta;
    const accepted = {};
    const probe = make(new OfflineAudioContext(1, 1, SR), kind, id, {});
    const r = Math.max(...meta.params.filter((p) => p.key === 'release').map((p) => p.max / 3), probe.params.release);
    const seconds = 1.2 + r * 1.3 + 0.8;
    const voices = [];
    const res = await render(kind, id, {}, seconds, (inst) => {
      voices.push(inst.noteOn(60, 0.8, 0.05), inst.noteOn(67, 0.5, 0.1));
      let t = 0.4;
      for (const p of meta.params) {
        let v;
        if (p.unit === 'bool') v = !p.default;
        else if (p.unit === 'enum') v = p.enum.find((e) => e !== p.default);
        else v = p.key === 'release' ? Math.min(p.max, r) : p.min + (p.max - p.min) * 0.5;
        accepted[p.key] = inst.setParam(p.key, v, t);
        t += 0.01;
      }
      accepted.__unknown = inst.setParam('nope', 1, t);
      inst.morph(0.7, 0.6);
      inst.setBend(1, 0.7);
      inst.setBend(0, 0.9);
      for (const v of voices) inst.noteOff(v, 1.2);
    });
    const deadline = 1.2 + r * 1.3 + 0.5;
    return {
      accepted,
      nan: hasNaN(res.L, res.R),
      peakDb: db(Math.max(peakAbs(res.L), peakAbs(res.R))),
      tailDb: db(Math.max(peakAbs(res.L, deadline), peakAbs(res.R, deadline))),
      ...voiceBook(res.inst, voices),
    };
  },

  async allOff(kind, id) {
    const voices = [];
    const res = await render(kind, id, {}, 1.6, (inst) => {
      for (const n of [48, 55, 60, 64]) voices.push(inst.noteOn(n, 0.8, 0.05));
      inst.allOff(1.0, 0.03);
    });
    return { tailDb: db(peakAbs(res.M, 1.0 + 0.03 * 1.3 + 0.005)), before: db(rms(res.M, 0.9, 1.0)), ...voiceBook(res.inst, voices) };
  },

  // Seeded renders must match. Chromium sums a node's inputs in hash-set order, so graphs with ≥ 3 inputs into one
  // node differ run-to-run by float rounding (~1e-6); "identical" therefore means max |Δ| < 1e-5 (−100 dBFS).
  async determinism() {
    const chord = (inst) => { for (const n of [48, 60, 64, 67]) inst.noteOn(n, 0.7, 0.05); };
    const a = await render('synth', 'warm-pad', { attack: 0.05 }, 1, chord, 7);
    const b = await render('synth', 'warm-pad', { attack: 0.05 }, 1, chord, 7);
    const c = await render('synth', 'warm-pad', { attack: 0.05 }, 1, chord, 8);
    let same = 0, diff = 0;
    for (let i = 0; i < a.L.length; i++) {
      same = Math.max(same, Math.abs(a.L[i] - b.L[i]), Math.abs(a.R[i] - b.R[i]));
      diff = Math.max(diff, Math.abs(a.L[i] - c.L[i]));
    }
    return { sameSeedMaxDiff: same, otherSeedMaxDiff: diff };
  },

  // CPU: 16 voices for 4 s; ×realtime = audio seconds / wall seconds (offline render, one thread).
  async perf(kind, id) {
    const res = await render(kind, id, { attack: 0.05 }, 4, (inst) => {
      for (let i = 0; i < 16; i++) inst.noteOn(40 + i * 2, 0.7, 0.01 + i * 0.001);
    });
    return { renderMs: res.renderMs, xRealtime: 4 / (res.renderMs / 1000), nodes: res.inst.liveNodeCount() };
  },
};

// Level survey (≈ tools/calibrate.mjs): C-E-G at vel 96/127 for 4 s; RMS/peak over 3–4 s (after pad attacks).
T.level = async (kind, id) => {
  const res = await render(kind, id, {}, 4.2, (inst) => { for (const n of [60, 64, 67]) inst.noteOn(n, 96 / 127, 0.05); });
  return { rmsDb: db(rms(res.M, 3, 4)), rms03: db(rms(res.M, 0.05, 3.05)), peakDb: db(Math.max(peakAbs(res.L), peakAbs(res.R))) };
};
// dispose(): everything stops, nothing sounds, voice bookkeeping empties.
T.dispose = async (kind, id) => {
  const voices = [];
  const res = await render(kind, id, {}, 1, (inst) => {
    voices.push(inst.noteOn(60, 0.8, 0.1), inst.noteOn(64, 0.8, 0.1));
    inst.dispose();
    return { after: inst.noteOn(67, 0.8, 0.2) };
  });
  return { peak: peakAbs(res.M), noteOnAfterDispose: res.extra.after, ...voiceBook(res.inst, voices) };
};
// Real-time AudioContext smoke test (the app's normal mode): sound within 300 ms, silence after release.
T.realtime = async (kind, id) => {
  const ctx = new AudioContext();
  await ctx.resume();
  const inst = kind === 'organ' ? new OrganInstrument(ctx, createRng(3), id, { attack: 0.01 }) : new SynthInstrument(ctx, createRng(3), id, { attack: 0.01 });
  const an = new AnalyserNode(ctx, { fftSize: 4096 });
  inst.output.connect(an);
  const v = inst.noteOn(60, 0.8, ctx.currentTime + 0.02);
  await sleep(300);
  const buf = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(buf);
  const on = db(Math.sqrt(buf.reduce((a, x) => a + x * x, 0) / buf.length));
  inst.noteOff(v, ctx.currentTime);
  const r = inst.params.release;
  await sleep((r * 1.3 + 0.3) * 1000);
  an.getFloatTimeDomainData(buf);
  const off = db(Math.max(...buf.map(Math.abs)));
  const live = inst.liveVoiceCount();
  inst.dispose();
  await ctx.close();
  return { onDb: on, offDb: off, live, state: 'ok' };
};

// ================= instruments fixes (reviews/instruments.md M1–M3, m1–m9; audition E1) =================
const mean = (x, a, b) => { let s = 0, n = 0; for (let i = idx(a), e = Math.min(x.length, idx(b)); i < e; i++) { s += x[i]; n++; } return n ? s / n : 0; };
/** Envelope (RMS per `hop` samples) of x over [a, b]. */
function envelope(x, a, b, hop = 220) {
  const e = [];
  for (let i = idx(a); i + hop <= Math.min(x.length, idx(b)); i += hop) { let s = 0; for (let j = i; j < i + hop; j++) s += x[j] * x[j]; e.push(Math.sqrt(s / hop)); }
  return e;
}
/** Peak-to-peak (dB) of the amplitude modulation of envelope `e` (fs = SR/hop) at `f` Hz (detrended, Hann DFT). */
function amPkPk(e, f, fs) {
  const n = e.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += e[i]; sxx += i * i; sxy += i * e[i]; }
  const k = (n * sxy - sx * sy) / (n * sxx - sx * sx), c0 = (sy - k * sx) / n, m = sy / n;
  let re = 0, im = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)), v = (e[i] - (c0 + k * i)) * w;
    re += v * Math.cos((2 * Math.PI * f * i) / fs); im -= v * Math.sin((2 * Math.PI * f * i) / fs);
  }
  const mi = Math.min(0.999, (2 * Math.hypot(re, im)) / (n / 2) / m);
  return db((1 + mi) / (1 - mi));
}
/** 3rd-harmonic level (dB re full scale, Hann 4096) of note n in the organ render around 60–150 ms. */
function thirdHarm(res, n) {
  const N = 4096, mag = spectrum(res.M, 0.06, N, N);
  return db(magAt(mag, N, 3 * noteToFreq(n), 8) / (N / 4));
}

// M1: Hammond percussion shared by the whole instrument.
T.percussion = async (spreadMs = 0) => {
  const notes = [60, 64, 69];
  const go = (perc) => render('organ', 'gospel', { rotary: 'off', click: 0, drive: 0, percussion: perc }, 0.4, (inst) => {
    notes.forEach((n, i) => inst.noteOn(n, 0.8, 0.05 + (i * spreadMs) / 1000));
  });
  const on = await go(true), off = await go(false);
  // re-arm: C4 held 0.05–2.2 s, E4 added at 2.0 s (decayed → none), everything up, A4 at 2.5 s (re-armed → full)
  const re = await render('organ', 'gospel', { rotary: 'off', click: 0, drive: 0, percussion: true }, 2.9, (inst) => {
    const a = inst.noteOn(60, 0.8, 0.05);
    const b = inst.noteOn(64, 0.8, 2.0);
    inst.noteOff(a, 2.2); inst.noteOff(b, 2.2);
    const c = inst.noteOn(69, 0.8, 2.5);
    return { levels: [a, b, c].map((v) => v.data.percLevel || 0) };
  });
  return {
    chord: notes.map((n) => ({ note: n, perc: thirdHarm(on, n), noPerc: thirdHarm(off, n) })),
    rearmLevels: re.extra.levels,
  };
};

// M2: organ morph relative to the rotary param (AM rate of a held dyad, left mic).
T.organMorph = async (rotary, x) => {
  const res = await render('organ', 'gospel', { percussion: false, click: 0, rotary }, 7, (inst) => {
    inst.morph(x, 0);
    inst.noteOn(72, 0.8, 0.05); inst.noteOn(76, 0.8, 0.05);
    return { speed: inst.rotarySpeed };
  });
  return { speed: res.extra.speed, am: amRate(res.L, 3, 7) };
};
// M2 through the real engine: gospel (rotary 'fast') committed, one note, dominant AM rate of the output.
T.engineGospel = async () => {
  const { AudioEngine } = await import('/js/engine/index.js');
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 4 * SR, sampleRate: SR });
  const e = new AudioEngine({ context: ctx, seed: 7, manifestUrl: '/__test/fixtures/manifest.json' });
  await e.start();
  const slots = [{ instrument: { type: 'organ', id: 'gospel' }, gain: 1, sends: { reverb: 0, delay: 0, chorus: 0 } }, null, null, null];
  const tok = await e.prepare({ slots, fx: {} });
  e.commit(tok, { when: 0 });
  e.noteOn(60, 100, { when: 0.1 });
  const inst = e.slots && e.slots[0] && e.slots[0].inst;
  const buf = await ctx.startRendering();
  return { am: amRate(buf.getChannelData(0), 1.5, 3.9, 0.3, 9), speed: inst ? inst.rotarySpeed : null, morph: inst ? inst.morphX : null };
};

// Alias energy of a fixed-pitch FM note: legit partials sit on |f + k·fm| (+ j·14f for the soft-keys tine);
// everything else below 20 kHz is folded (aliased) energy. Returns dB re total and the loudest alias re f0.
T.fmAlias = async (id, note, morph = 0, params = {}, t = 0.015) => {
  const N = 8192;
  const res = await render('synth', id, { attack: 0.002, ...params, ...(id === 'soft-keys' ? { tremolo: 0 } : {}) }, 0.6, (inst) => {
    inst.morph(morph, 0);
    inst.noteOn(note, 1, 0.01);
    return { r: id === 'bell' ? inst.impl.ratio(inst) : 1 };
  });
  const f = noteToFreq(note);
  const mag = spectrum(res.M, t, N, N);
  const legit = new Uint8Array(mag.length);
  const mark = (x) => { const k = Math.round((Math.abs(x) * N) / SR); for (let j = k - 4; j <= k + 4; j++) if (j >= 0 && j < legit.length) legit[j] = 1; };
  if (id === 'bell') for (let k = -40; k <= 40; k++) mark(f + k * f * res.extra.r);
  else for (let k = -30; k <= 30; k++) for (let j = -6; j <= 6; j++) mark(f + k * f + j * 14 * f);
  let tot = 0, bad = 0, worst = 0;
  for (let k = 1; k < mag.length - 1 && (k * SR) / N < 20000; k++) {
    tot += mag[k] ** 2;
    if (!legit[k]) { bad += mag[k] ** 2; if (mag[k] >= mag[k - 1] && mag[k] >= mag[k + 1]) worst = Math.max(worst, mag[k]); }
  }
  const f0 = magAt(mag, N, f);
  return { aliasDb: 10 * Math.log10((bad + 1e-30) / tot), worstReF0Db: db(worst / f0) };
};

// m6: FM index follows legato / ratio change. Upper sideband (f + fm) re carrier of a note that was moved
// (legato +12 at 0.3 s, or morph 0→1 at 0.3 s) vs a fresh note with the same target and the same note-on time.
T.fmRescale = async (id, mode) => {
  const on = 0.1, tm = 0.3, a = 0.5, N = 16384;
  const p = id === 'soft-keys' ? { tremolo: 0, drive: 0, glide: 0.01, tine: 0 } : { glide: 0.01 };
  const moved = await render('synth', id, p, 1, (inst) => {
    const v = inst.noteOn(60, 0.8, on);
    if (mode === 'legato') inst.legatoTo(v, 72, tm); else inst.morph(1, tm);
  });
  const fresh = await render('synth', id, p, 1, (inst) => {
    if (mode === 'morph') inst.morph(1, 0);
    inst.noteOn(mode === 'legato' ? 72 : 60, 0.8, on);
  });
  const f = noteToFreq(mode === 'legato' ? 72 : 60);
  const r = id === 'bell' ? 3.5 + (mode === 'morph' ? 1.6 : 0) : 1;
  const side = (res) => { const m = spectrum(res.M, a, N, N); return db(magAt(m, N, f + r * f) / magAt(m, N, f)); };
  return { movedDb: side(moved), freshDb: side(fresh) };
};

// audition E1: soft-keys DC on a C3 chord at velocity 96.
T.softKeysDC = async () => {
  const res = await render('synth', 'soft-keys', {}, 3, (inst) => { for (const n of [48, 52, 55]) inst.noteOn(n, 96 / 127, 0.05); });
  let worst = 0;
  for (let t = 0.05; t + 0.1 <= 2.5; t += 0.05) worst = Math.max(worst, Math.abs(mean(res.M, t, t + 0.1)));
  return { dc: mean(res.M, 0.05, 2.5), worst100ms: worst, rms: rms(res.M, 0.05, 2.5) };
};

// m1: filter responses of the real nodes (getFrequencyResponse).
T.filters = async () => {
  const ctx = new OfflineAudioContext(2, SR, SR);
  const resp = (nodes, fs) => {
    const fr = Float32Array.from(fs), out = new Float64Array(fs.length).fill(1);
    for (const n of nodes) { const m = new Float32Array(fs.length), ph = new Float32Array(fs.length); n.getFrequencyResponse(fr, m, ph); for (let i = 0; i < fs.length; i++) out[i] *= m[i]; }
    return out;
  };
  const grid = []; for (let x = 50; x < 16000; x *= 1.005) grid.push(x);
  const pairOf = (res) => { const w = new SynthInstrument(ctx, createRng(1), 'warm-pad', { resonance: res }); const v = w.noteOn(60, 0.8, 0); return [v.data.l1, v.data.l2]; };
  const at = (nodes) => { const fc = nodes[0].frequency.value; return db(resp(nodes, [fc])[0]); };
  const pk = (nodes) => db(Math.max(...resp(nodes, grid)));
  const p0 = pairOf(0), p1 = pairOf(1);
  const sub = new SynthInstrument(ctx, createRng(1), 'sub-bass', {});
  const org = new OrganInstrument(ctx, createRng(1), 'gospel', {});
  const [lo, hi] = org.xover;
  const fx = 800;
  const lp = resp([lo], [fx])[0], hp = resp([hi], [fx])[0];
  return {
    pairAtFcDb: at(p0), pairPeakDb: pk(p0), res1PeakDb: pk(p1),
    subLpfAtFcDb: at([sub.lpf]),
    xoverLpDb: db(lp), xoverHpDb: db(hp), xoverPowerSumDb: 10 * Math.log10(lp * lp + hp * hp),
    busHpfQ: new SynthInstrument(ctx, createRng(1), 'strings', {}).hpf.Q.value,
  };
};
// m1: long-term band power of the rotary path re dry at the crossover (noise into the rotary input), minus
// the rotors' AM mean power (drum ≈ −0.9 dB, horn ≈ −1.3 dB, crossover mix of both).
T.rotaryBand = async (speed, fc = 800) => {
  const secs = 8;
  const ctx = new OfflineAudioContext(2, secs * SR, SR);
  const inst = new OrganInstrument(ctx, createRng(1), 'gospel', { rotary: speed });
  inst.trimNode.connect(ctx.destination);
  const nb = ctx.createBuffer(1, secs * SR, SR), d = nb.getChannelData(0), rng = createRng(9);
  for (let i = 0; i < d.length; i++) d[i] = (rng.next() * 2 - 1) * 0.1;
  const src = new AudioBufferSourceNode(ctx, { buffer: nb });
  src.connect(inst.rotG); src.start(0);
  const buf = await ctx.startRendering();
  const trim = inst.trimNode.gain.value, N = 8192;
  const band = (x) => { let s = 0; for (let a = 1; a + N / SR < secs; a += N / SR / 2) { const m = spectrum(x, a, N, N); for (let k = Math.floor((fc / 1.12) * N / SR); k <= Math.ceil((fc * 1.12) * N / SR); k++) s += m[k] * m[k]; } return s; };
  const L = band(buf.getChannelData(0)), R = band(buf.getChannelData(1)), X = band(d);
  const Pd = 0.897 ** 2 + 0.103 ** 2 / 2, Ph = 0.854 ** 2 + 0.146 ** 2 / 2;
  const x = fc / 800, l = 1 / (1 + x ** 4);
  const expDb = 10 * Math.log10(l * Pd + (1 - l) * Ph);
  return { levelDb: 10 * Math.log10((L + R) / 2 / X) - db(trim), expectedDb: expDb };
};

// m2: note-onset latency (frames) and the lazy organ oversample switch.
T.onsets = async () => {
  const out = {};
  for (const [kind, id, p] of [['synth', 'soft-keys', {}], ['synth', 'sub-bass', {}], ['organ', 'gospel', {}], ['organ', 'full', {}], ['organ', 'full', { drive: 0.8 }]]) {
    const res = await render(kind, id, { click: 0, percussion: false, attack: 0.002, rotary: 'off', ...p }, 0.2, (inst) => { inst.noteOn(60, 1, 0.01); });
    let i = 0; while (i < res.M.length && Math.abs(res.M[i]) < 1e-6) i++;
    out[id + (p.drive ? '@' + p.drive : '')] = i - Math.round(0.01 * SR);
  }
  const ctx = new OfflineAudioContext(2, SR, SR);
  const o = new OrganInstrument(ctx, createRng(1), 'gospel', {});
  const os0 = o.shaper.oversample;
  o.setParam('drive', 0.9, 0);
  const osIdle = o.shaper.oversample;
  o.setParam('drive', 0.2, 0);
  o.noteOn(60, 0.8, 0);
  o.setParam('drive', 0.9, 0);
  const osPlaying = o.shaper.oversample;
  return { frames: out, os: { gospelDefault: os0, afterDrive09Idle: osIdle, afterDrive09WhilePlaying: osPlaying } };
};

// m5: horn Doppler vs AM phase (5 kHz probe through the fast horn, left mic). + = pitch peak leads loudness peak.
T.hornPhase = async () => {
  const secs = 4, ctx = new OfflineAudioContext(2, secs * SR, SR);
  const inst = new OrganInstrument(ctx, createRng(1), 'gospel', { rotary: 'fast' });
  inst.output.connect(ctx.destination);
  const o = new OscillatorNode(ctx, { frequency: 5000 }), g = new GainNode(ctx, { gain: 0.2 });
  o.connect(g).connect(inst.rotG); o.start(0);
  const L = (await ctx.startRendering()).getChannelData(0);
  const W = 44, env = [], ph = [];
  for (let i = SR; i + W < L.length; i += W) {
    let a = 0, b = 0;
    for (let j = i; j < i + W; j++) { a += L[j] * Math.cos((2 * Math.PI * 5000 * j) / SR); b -= L[j] * Math.sin((2 * Math.PI * 5000 * j) / SR); }
    env.push(Math.hypot(a, b)); ph.push(Math.atan2(b, a));
  }
  const fr = [];
  for (let i = 1; i < ph.length; i++) { let dp = ph[i] - ph[i - 1]; while (dp > Math.PI) dp -= 2 * Math.PI; while (dp < -Math.PI) dp += 2 * Math.PI; fr.push(dp / (W / SR) / (2 * Math.PI)); }
  const e2 = env.slice(1), fs = SR / W;
  const comp = (x, f) => { let re = 0, im = 0; const m = x.reduce((p, q) => p + q, 0) / x.length; for (let i = 0; i < x.length; i++) { re += (x[i] - m) * Math.cos((2 * Math.PI * f * i) / fs); im -= (x[i] - m) * Math.sin((2 * Math.PI * f * i) / fs); } return { mag: Math.hypot(re, im), ph: Math.atan2(im, re) }; };
  let best = 0, bf = 0;
  for (let f = 5; f < 8; f += 0.005) { const c = comp(e2, f); if (c.mag > best) { best = c.mag; bf = f; } }
  let lead = ((comp(fr, bf).ph - comp(e2, bf).ph) * 180) / Math.PI;
  while (lead > 180) lead -= 360; while (lead < -180) lead += 360;
  return { rotorHz: bf, pitchLeadDeg: lead, devHz: (2 * comp(fr, bf).mag) / fr.length };
};

// m3: glass wave partial levels (one oscillator, rotation 0).
T.glassWave = async () => {
  const ctx = new OfflineAudioContext(1, SR, SR);
  const o = new OscillatorNode(ctx, { type: 'custom', periodicWave: glassWaves(ctx)[0], frequency: 261.63 });
  o.connect(ctx.destination); o.start(0);
  const x = (await ctx.startRendering()).getChannelData(0), N = 131072, mag = spectrum(x, 0.2, 16384, N); // zero-padded: no scalloping
  const h = [1, 2, 3].map((k) => magAt(mag, N, k * 261.63, 1));
  return { h2Db: db(h[1] / h[0]), h3Db: db(h[2] / h[0]) };
};

// m4: soft-keys tremolo at full depth (morph 1): per-side AM and the mono fold-down's flutter.
T.tremolo = async () => {
  const res = await render('synth', 'soft-keys', { tremolo: 1, decay: 3, drive: 0 }, 3, (inst) => { inst.morph(1, 0); inst.noteOn(60, 0.8, 0.01); });
  const S = new Float32Array(res.L.length); for (let i = 0; i < S.length; i++) S[i] = (res.L[i] + res.R[i]) / 2;
  const hop = 147, fs = SR / hop, eL = envelope(res.L, 0.6, 2.4, hop), eS = envelope(S, 0.6, 2.4, hop);
  return { sidePkPkDb: amPkPk(eL, 4.5, fs), monoPkPkDb: Math.max(amPkPk(eS, 4.5, fs), amPkPk(eS, 9, fs)) };
};

// m7: side-channel energy re mid below 150 Hz.
T.lowSide = async (id, note) => {
  const res = await render('synth', id, { attack: 0.01 }, 2, (inst) => { inst.noteOn(note, 0.8, 0.01); });
  const N = 32768, S = new Float32Array(res.L.length);
  for (let i = 0; i < S.length; i++) S[i] = 0.5 * (res.L[i] - res.R[i]);
  const ms = spectrum(res.M, 0.5, N, N), ss = spectrum(S, 0.5, N, N);
  let em = 0, es = 0;
  for (let k = 1; (k * SR) / N < 150; k++) { em += ms[k] ** 2; es += ss[k] ** 2; }
  return { sideReMidDb: 10 * Math.log10(es / em) };
};

// m8: 16 voices (C2…A5, 3 semitones apart) at velocity 1: output peak; and ceiling transparency at calibrated level.
T.peak16 = async (kind, id, params = {}) => {
  const res = await render(kind, id, { attack: 0.01, ...params }, 2.5, (inst) => { for (let i = 0; i < 16; i++) inst.noteOn(id === 'sub-bass' ? 36 : 36 + i * 3, 1, 0.02); });
  return { peakDb: db(Math.max(peakAbs(res.L), peakAbs(res.R))) };
};
T.ceilingTransparent = async (kind, id) => {
  const ctx = new OfflineAudioContext(4, 3 * SR, SR);
  const inst = make(ctx, kind, id, {}, 1234);
  inst.output.disconnect();
  const m = new ChannelMergerNode(ctx, { numberOfInputs: 4 });
  const sp1 = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 }), sp2 = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
  inst.output.connect(sp1); inst.trimNode.connect(sp2);
  sp1.connect(m, 0, 0); sp1.connect(m, 1, 1); sp2.connect(m, 0, 2); sp2.connect(m, 1, 3);
  m.connect(ctx.destination);
  for (const n of [60, 64, 67]) inst.noteOn(n, 96 / 127, 0.05);
  const b = await ctx.startRendering();
  let d = 0, pk = 0;
  for (let c = 0; c < 2; c++) { const x = b.getChannelData(c), y = b.getChannelData(c + 2); for (let i = 0; i < x.length; i++) { d = Math.max(d, Math.abs(x[i] - y[i])); pk = Math.max(pk, Math.abs(y[i])); } }
  return { maxDiff: d, peakDb: db(pk) };
};
window.T = T;
window.harnessReady = true;
