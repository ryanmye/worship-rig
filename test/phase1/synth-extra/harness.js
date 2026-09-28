// Page-side harness for synth-extra.js: builds instruments in seeded OfflineAudioContexts, renders, analyses in JS.
// run.mjs calls window.T.<case>(...) through page.evaluate and asserts on the numbers.
import { SynthExtraInstrument, PATCHES } from '/js/engine/synth-extra.js';
import { createRng } from '/js/shared/prng.js';
import { noteToFreq } from '/js/shared/music.js';
import { bandRmsDb, dcOffset, monoLossDb } from '/__lib/analysis.mjs';

const SR = 44100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const META = new Map(PATCHES.map((p) => [p.id, p]));
const isBass = (id) => META.get(id).group === 'Bass';
const hasParam = (id, k) => META.get(id).params.some((p) => p.key === k);
const baseNote = (id) => (isBass(id) ? 36 : 60);

function make(ctx, id, params = {}, seed = 1234) {
  const inst = new SynthExtraInstrument(ctx, createRng(seed), id, params);
  inst.output.connect(ctx.destination);
  return inst;
}

/** Render `seconds`; `setup(inst, ctx)` schedules events and may return extra state. */
async function render(id, params, seconds, setup, seed = 1234, sr = SR) {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
  const inst = make(ctx, id, params, seed);
  const extra = (await setup(inst, ctx)) || {};
  const t0 = performance.now();
  const buf = await ctx.startRendering();
  const renderMs = performance.now() - t0;
  await sleep(30); // let the last onended events land
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const M = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) M[i] = 0.5 * (L[i] + R[i]);
  return { inst, L, R, M, extra, renderMs, seconds, sr };
}

// ---- analysis (same helpers as test/phase1/instruments/harness.js) ----------------------------------------------
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
function spectrum(x, a, len, N) {
  const re = new Float64Array(N), im = new Float64Array(N);
  const s = idx(a);
  for (let i = 0; i < len && s + i < x.length; i++) re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1)));
  fft(re, im);
  const mag = new Float64Array(N / 2);
  for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
  return mag;
}
function peakFreq(mag, N, fLo = 20, fHi = 20000) {
  const k0 = Math.max(1, Math.floor((fLo * N) / SR)), k1 = Math.min(mag.length - 2, Math.ceil((fHi * N) / SR));
  let k = k0;
  for (let i = k0; i <= k1; i++) if (mag[i] > mag[k]) k = i;
  const a = Math.log(mag[k - 1] + 1e-30), b = Math.log(mag[k] + 1e-30), c = Math.log(mag[k + 1] + 1e-30);
  const p = (0.5 * (a - c)) / (a - 2 * b + c || 1e-30);
  return ((k + p) * SR) / N;
}
function centroid(x, a, b) {
  const N = 16384;
  const acc = new Float64Array(N / 2);
  for (let t = a; t + N / SR <= b; t += N / SR / 2) {
    const m = spectrum(x, t, N, N);
    for (let k = 0; k < m.length; k++) acc[k] += m[k] * m[k];
  }
  let num = 0, den = 0;
  for (let k = 1; k < acc.length; k++) { num += ((k * SR) / N) * acc[k]; den += acc[k]; }
  return num / den;
}
function clickScan(x, a, b, from = 0) {
  const W = Math.round(0.02 * SR);
  const i0 = Math.max(1, idx(from));
  const d = new Float64Array(x.length);
  for (let i = 1; i < x.length; i++) d[i] = Math.abs(x[i] - x[i - 1]);
  let worst = 0;
  const hop = Math.round(0.001 * SR);
  for (let c = idx(a); c < Math.min(x.length, idx(b)); c += hop) {
    const lo = Math.max(i0, c - W / 2), hi = Math.min(x.length, Math.max(c + W / 2, lo + W / 2));
    const w = Array.from(d.subarray(lo, hi)).sort((p, q) => p - q);
    const med = w[w.length >> 1] || 1e-12;
    for (let i = c; i < Math.min(c + hop, x.length); i++) worst = Math.max(worst, d[i] / med);
  }
  return worst;
}
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
function voiceBook(inst, voices) {
  return {
    liveVoices: inst.liveVoiceCount(),
    liveNodes: inst.liveNodeCount(),
    voiceNodes: voices.map((v) => v.liveNodes).reduce((a, b) => a + b, 0),
    states: [...new Set(voices.map((v) => v.state))],
  };
}
const releaseOf = (id, params = {}) => make(new OfflineAudioContext(1, 1, SR), id, params).params.release;

// ---- cases ------------------------------------------------------------------------------------------------------
const T = {
  list: () => PATCHES.map((p) => ({ id: p.id, name: p.name, group: p.group, gainTrim: p.gainTrim, calibWindow: p.calibWindow || null, params: p.params.map((x) => x.key) })),

  // one note (C4, Bass C2) vel .8 held 1 s → sounds, finite, < −60 dBFS by off + release·1.3 + .5, bookkeeping empty
  async basic(id) {
    const on = 0.1, off = 1.1;
    const r = releaseOf(id);
    const seconds = off + r * 1.3 + 0.9;
    const voices = [];
    const res = await render(id, {}, seconds, (inst) => {
      const v = inst.noteOn(baseNote(id), 0.8, on);
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
      ...voiceBook(res.inst, voices),
    };
  },

  // REVIEW 1.1: noteOff 0.2 s into a (1.2 s, where the patch has an attack param) attack releases from where it is
  async releaseDuringAttack(id) {
    const hasAttack = hasParam(id, 'attack');
    const params = hasAttack ? { attack: 1.2 } : {};
    // the patch's own amplitude motion (detuned-unison beating, tremolo) would swamp a 1 dB criterion on 40 ms windows
    if (hasParam(id, 'detune')) params.detune = 0;
    if (hasParam(id, 'tremDepth')) params.tremDepth = 0;
    const on = 0.1, off = 0.3;
    const r = releaseOf(id, params);
    const seconds = off + r * 1.3 + 0.9;
    const voices = [];
    const res = await render(id, params, seconds, (inst) => {
      const v = inst.noteOn(baseNote(id), 0.8, on);
      voices.push(v);
      inst.noteOff(v, off);
    });
    // level in the 40 ms ending exactly at noteOff vs every 40 ms window after it (the attack ramp is still rising
    // inside a window that ends earlier, which alone reads ~+1.5 dB on a 1.2 s linear attack)
    const atOff = rms(res.M, off - 0.04, off);
    let maxAfter = 0;
    for (let a = off + 0.005; a + 0.04 <= res.seconds; a += 0.04) maxAfter = Math.max(maxAfter, rms(res.M, a, a + 0.04));
    const deadline = off + r * 1.3 + 0.5;
    return {
      hasAttack,
      atOffDb: db(atOff),
      maxAfterDb: db(maxAfter),
      unreleasedLevelDb: hasAttack ? db(rms(res.M, on + 1.3, on + 1.35)) : null,
      tailDb: db(Math.max(peakAbs(res.L, deadline), peakAbs(res.R, deadline))),
      nan: hasNaN(res.L, res.R),
      ...voiceBook(res.inst, voices),
    };
  },

  // Steal click test (same method as test/phase1/instruments): A poly 17, B voice0 never sounds, C poly 16 → steal.
  // D = C − A is the steal transient; its HF energy must not exceed the stolen voice's own HF (+3 dB) or be ≥ 60 dB
  // under the voice's energy. mode 'hard' = no fade (detector positive control).
  async steal(id, mode = 'steal') {
    const params = hasParam(id, 'attack') ? { attack: 0.01 } : {};
    const tS = 0.1 + 16 * 0.05;
    const lo = isBass(id) ? 36 : 48;
    const play = (poly17, killAt) => (inst) => {
      if (poly17) inst.alloc.max = 17;
      const vs = [];
      for (let i = 0; i < 17; i++) vs.push(inst.noteOn(lo + i, 0.8, 0.1 + i * 0.05));
      if (killAt !== undefined) vs[0].kill(killAt);
      return { vs };
    };
    const dur = tS + 0.3;
    const A = await render(id, params, dur, play(true));
    const A2 = await render(id, params, dur, play(true)); // render-to-render noise floor (Chromium input-sum order)
    const B = await render(id, params, dur, play(true, 0.1));
    const C = await render(id, params, dur, mode === 'hard' ? play(true, tS) : play(false));
    const v0 = new Float32Array(A.M.length), D = new Float32Array(A.M.length);
    for (let i = 0; i < D.length; i++) { v0[i] = A.M[i] - B.M[i]; D[i] = C.M[i] - A.M[i]; }
    const band = isBass(id) ? 1500 : 8000;
    const e = (x) => hfEnergy(x, band, tS, tS + 0.03);
    let ev0 = 0;
    for (let i = idx(tS); i < idx(tS + 0.03); i++) ev0 += v0[i] * v0[i];
    const stolen = C.extra.vs[0];
    return {
      mode,
      hfRatioDb: 10 * Math.log10((e(D) + 1e-20) / (e(v0) + 1e-20)),
      hfFracDb: 10 * Math.log10((e(D) + 1e-20) / (ev0 + 1e-20)),
      preDiff: peakAbs(D, 0, tS - 0.001),
      noiseFloor: (() => { let m = 0; for (let i = 0; i < A.M.length; i++) m = Math.max(m, Math.abs(A.M[i] - A2.M[i])); return m; })(),
      mixRatio: clickScan(C.M, tS - 0.002, tS + 0.03),
      mixRatioNoSteal: clickScan(A.M, tS - 0.002, tS + 0.03),
      steals: C.inst.alloc.steals,
      stolenState: stolen.state,
      stolenNodes: stolen.liveNodes,
      nan: hasNaN(C.L, C.R),
    };
  },

  async kill(id) {
    const voices = [];
    const n0 = baseNote(id);
    const res = await render(id, {}, 2.5, (inst) => {
      for (const [i, d] of [0, 4, 7, 11].entries()) voices.push(inst.noteOn(n0 + d, 0.8, 0.1 + i * 0.01));
      voices[0].kill(0.5);
      voices[1].kill(0.5);
      voices[2].fadeOut(0.5, 0.03);
      inst.allOff(0.6);
      return { before: voices.map((v) => v.liveNodes) };
    });
    return { nodesBefore: res.extra.before, ...voiceBook(res.inst, voices), tailDb: db(peakAbs(res.M, 0.7)) };
  },

  async dispose(id) {
    const voices = [];
    const res = await render(id, {}, 1, (inst) => {
      voices.push(inst.noteOn(60, 0.8, 0.1), inst.noteOn(64, 0.8, 0.1));
      inst.dispose();
      return { after: inst.noteOn(67, 0.8, 0.2) };
    });
    return { peak: peakAbs(res.M), noteOnAfterDispose: res.extra.after, ...voiceBook(res.inst, voices), sharedLive: res.inst.liveNodeCount() };
  },

  async allOff(id) {
    const voices = [];
    const n0 = baseNote(id);
    const res = await render(id, {}, 1.6, (inst) => {
      for (const d of [-12, -5, 0, 4]) voices.push(inst.noteOn(n0 + d, 0.8, 0.05));
      inst.allOff(1.0, 0.03);
    });
    return { tailDb: db(peakAbs(res.M, 1.0 + 0.03 * 1.3 + 0.005)), before: db(rms(res.M, 0.9, 1.0)), ...voiceBook(res.inst, voices) };
  },

  // 8 voices at velocity 1 (keys/pads: C3..C5 spread; Bass: C2..G3), held through the attack, then released.
  // `bypass`: ceiling curve removed → reports the peak the ceiling would have had to catch (×4 pre-scale undone).
  async peak8(id, bypass = false) {
    const notes = isBass(id) ? [36, 40, 43, 45, 48, 50, 52, 55] : [48, 52, 55, 59, 62, 64, 67, 72];
    const hold = 3.5;
    const r = releaseOf(id);
    const res = await render(id, {}, hold + Math.min(r, 3) + 0.2, (inst) => {
      if (bypass) inst.ceil.curve = null;
      const vs = notes.map((n) => inst.noteOn(n, 1, 0.05));
      for (const v of vs) inst.noteOff(v, hold);
    });
    const pk = Math.max(peakAbs(res.L), peakAbs(res.R));
    return { peakDb: db(pk) + (bypass ? 20 * Math.log10(4) : 0), nan: hasNaN(res.L, res.R) };
  },

  // Calibration measurement = tools/calibrate.mjs method: 48 kHz, C3-E3-G3 (Bass: C2) vel 96/127 at t=0, off at 3 s,
  // band RMS 100 Hz–5 kHz (Bass 40 Hz–5 kHz) over 0–3 s (stereo mean square). Also DC, mono-sum loss, peak.
  async calib(id, morph = 0, windowOverride = null, bypass = false) {
    const sr = 48000;
    const notes = isBass(id) ? [36] : [48, 52, 55];
    const res = await render(id, {}, 3.2, (inst) => {
      if (bypass) inst.ceil.curve = null;
      if (morph) inst.morph(morph, 0);
      const vs = notes.map((n) => inst.noteOn(n, 96 / 127, 0));
      for (const v of vs) inst.noteOff(v, 3);
    }, `calibrate|synth|${id}`, sr);
    const chs = [res.L, res.R];
    const band = isBass(id) ? [40, 5000] : [100, 5000];
    let pk = 0;
    for (const c of chs) for (let i = 0; i < c.length; i++) pk = Math.max(pk, Math.abs(c[i]));
    const win = windowOverride || META.get(id).calibWindow || [0, 3];
    return {
      window: win,
      bandDb: bandRmsDb(chs, sr, band[0], band[1], win[0], win[1]),
      band03Db: bandRmsDb(chs, sr, band[0], band[1], 0, 3),
      dc: dcOffset(chs, sr, 0, 3),
      monoLossDb: monoLossDb(chs, sr, 0.1, 3),
      peakDb: db(pk) + (bypass ? 20 * Math.log10(4) : 0),
      nan: hasNaN(res.L, res.R),
    };
  },

  // Morph direction. Pluck: level over 0.5–1.5 s (decay length); dx-epiano: centroid over the first 0.8 s;
  // everything else: spectral centroid 0.8–2.9 s. morph set at t=0 before the note.
  async morphEffect(id) {
    const note = baseNote(id);
    const out = {};
    for (const x of [0, 1]) {
      const res = await render(id, {}, 3, (inst) => {
        inst.morph(x, 0);
        inst.noteOn(note, 0.8, 0.05);
      });
      if (id === 'pluck') out[x] = rms(res.M, 0.5, 1.5);
      else if (id === 'dx-epiano') out[x] = centroid(res.M, 0.05, 0.85);
      else if (id === '808-sub') out[x] = centroid(res.M, 0.1, 1.5);
      else out[x] = centroid(res.M, 0.8, 2.9);
    }
    return { metric: id === 'pluck' ? 'rms 0.5–1.5 s' : 'centroid Hz', m0: out[0], m1: out[1] };
  },

  // Supersaw: partials resolved around the 4th harmonic of C4 (±45¢): count distinct spectral peaks within 30 dB of the
  // cluster maximum, and the −20 dB width of the cluster in cents.
  async supersawClusters() {
    const res = await render('supersaw-pad', { attack: 0.05 }, 4, (inst) => { inst.noteOn(60, 0.8, 0.05); });
    const N = 1 << 18;
    const mag = spectrum(res.M, 1.0, Math.round(2.8 * SR), N);
    const h = 4 * noteToFreq(60);
    const k0 = Math.floor((h * Math.pow(2, -45 / 1200) * N) / SR), k1 = Math.ceil((h * Math.pow(2, 45 / 1200) * N) / SR);
    let mx = 0;
    for (let k = k0; k <= k1; k++) mx = Math.max(mx, mag[k]);
    const peaks = [];
    for (let k = k0 + 2; k <= k1 - 2; k++) {
      if (mag[k] > mx * Math.pow(10, -30 / 20) && mag[k] >= mag[k - 1] && mag[k] >= mag[k + 1] && mag[k] >= mag[k - 2] && mag[k] >= mag[k + 2]) {
        peaks.push(1200 * Math.log2(((k * SR) / N) / h));
      }
    }
    let lo = Infinity, hi = -Infinity;
    for (let k = k0; k <= k1; k++) if (mag[k] > mx * 0.1) { lo = Math.min(lo, k); hi = Math.max(hi, k); }
    return { peaks: peaks.map((c) => Math.round(c * 10) / 10), count: peaks.length, widthCents: 1200 * Math.log2(hi / lo) };
  },

  // Pluck keytracked decay: time from peak to −20 dB.
  async pluckDecay(note) {
    const res = await render('pluck', {}, 3, (inst) => { inst.noteOn(note, 0.8, 0.05); });
    const w = rmsWindows(res.M, 0.01);
    let pk = 0, pi = 0;
    w.forEach((x, i) => { if (x > pk) { pk = x; pi = i; } });
    let j = pi;
    while (j < w.length && w[j] > pk * 0.1) j++;
    return { t20: (j - pi) * 0.01, reached: j < w.length };
  },

  // 808 pitch drop: instantaneous frequency from upward zero crossings (linear interpolation) of a C2 note.
  async pitchDrop808(params = {}) {
    const on = 0.05;
    const res = await render('808-sub', params, 1, (inst) => { inst.noteOn(36, 0.8, on); });
    const x = res.M;
    const zc = [];
    for (let i = idx(on) + 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) zc.push((i - 1 + -x[i - 1] / (x[i] - x[i - 1])) / SR);
    const cyc = [];
    for (let i = 1; i < zc.length; i++) cyc.push({ t: (zc[i] + zc[i - 1]) / 2 - on, f: 1 / (zc[i] - zc[i - 1]) });
    const target = noteToFreq(36);
    const first = cyc[0];
    const late = cyc.filter((c) => c.t > 0.2 && c.t < 0.6);
    const fLate = late.reduce((a, c) => a + c.f, 0) / late.length;
    const settled = cyc.find((c) => Math.abs(12 * Math.log2(c.f / target)) < 0.1);
    // model: exponential glide from target·2^(drop/12) to target over dropTime (defaults 2 st / 60 ms)
    const drop = params.pitchDrop ?? 2, dt = params.dropTime ?? 0.06;
    const model = (t) => target * Math.pow(2, (drop / 12) * Math.max(0, 1 - t / dt));
    const inGlide = cyc.filter((c) => c.t < dt);
    const modelErrCents = inGlide.length ? Math.max(...inGlide.map((c) => Math.abs(1200 * Math.log2(c.f / model(c.t))))) : 0;
    // extrapolate the start pitch: the first cycle already averages ~15 ms of the glide
    return {
      firstHz: first.f, firstAt: first.t, lateHz: fLate, target,
      dropSemis: 12 * Math.log2(first.f / fLate),
      modelErrCents, glideCycles: inGlide.length,
      lateErrCents: 1200 * Math.log2(fLate / target),
      settledAt: settled ? settled.t : null,
      cycles: cyc.slice(0, 6).map((c) => [Math.round(c.t * 1000), Math.round(c.f * 10) / 10]),
    };
  },

  // DX EP brightness vs velocity: spectral centroid of the first 0.8 s at C4.
  // Also the overtone ratio: energy above 1.5·f (H2 and up, tine sidebands) vs the fundamental, first 0.37 s.
  async dxVelocity(vel) {
    const res = await render('dx-epiano', { chorus: 0 }, 1.2, (inst) => { inst.noteOn(60, vel, 0.05); });
    const N = 16384;
    const mag = spectrum(res.M, 0.05, N, N);
    const f = noteToFreq(60);
    let lo = 0, hi = 0;
    for (let k = 1; k < mag.length; k++) {
      const hz = (k * SR) / N;
      if (hz < 40) continue;
      if (hz < 1.5 * f) lo += mag[k] * mag[k];
      else hi += mag[k] * mag[k];
    }
    return { centroidHz: centroid(res.M, 0.05, 0.85), overtoneDb: 10 * Math.log10(hi / lo), rmsDb: db(rms(res.M, 0.05, 0.85)) };
  },

  // legatoTo on mono-style patches: pitch before and after a glide to +7 semitones (+ setBend +2 kept).
  async legato(id) {
    const n0 = baseNote(id);
    const params = id === 'square-lead' ? { vibDepth: 0 } : id === '808-sub' ? { drive: 0, decay: 8 } : {};
    const res = await render(id, params, 2.2, (inst) => {
      const v = inst.noteOn(n0, 0.8, 0.05);
      inst.setBend(2, 0.05);
      inst.legatoTo(v, n0 + 7, 1.0);
    });
    const N = 65536;
    const f0 = noteToFreq(n0 + 2), f1 = noteToFreq(n0 + 9);
    const a = peakFreq(spectrum(res.M, 0.35, N >> 1, N), N, f0 * 0.94, f0 * 1.06);
    const b = peakFreq(spectrum(res.M, 1.3, N >> 1, N), N, f1 * 0.94, f1 * 1.06);
    return { beforeHz: a, expectBefore: f0, afterHz: b, expectAfter: f1 };
  },

  // Every param / morph / bend on held notes: accepted, finite, bounded, still decays.
  async allParams(id) {
    const meta = META.get(id);
    const accepted = {};
    const r = Math.max(...meta.params.filter((p) => p.key === 'release').map((p) => p.max / 3), releaseOf(id));
    const seconds = 1.2 + r * 1.3 + 0.8;
    const voices = [];
    const n0 = baseNote(id);
    const res = await render(id, {}, seconds, (inst) => {
      voices.push(inst.noteOn(n0, 0.8, 0.05), inst.noteOn(n0 + 7, 0.5, 0.1));
      let t = 0.4;
      for (const p of meta.params) {
        const v = p.key === 'release' ? Math.min(p.max, r) : p.min + (p.max - p.min) * 0.5;
        accepted[p.key] = inst.setParam(p.key, v, t);
        t += 0.01;
      }
      accepted.__unknown = inst.setParam('nope', 1, t);
      inst.morph(0.7, 0.6);
      inst.setBend(1, 0.7);
      inst.setBend(0, 0.9);
      inst.legatoTo(voices[1], n0 + 5, 0.95);
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

  async determinism() {
    const chord = (inst) => { for (const n of [48, 60, 64, 67]) inst.noteOn(n, 0.7, 0.05); };
    const a = await render('supersaw-pad', { attack: 0.05 }, 1, chord, 7);
    const b = await render('supersaw-pad', { attack: 0.05 }, 1, chord, 7);
    const c = await render('supersaw-pad', { attack: 0.05 }, 1, chord, 8);
    let same = 0, diff = 0;
    for (let i = 0; i < a.L.length; i++) {
      same = Math.max(same, Math.abs(a.L[i] - b.L[i]), Math.abs(a.R[i] - b.R[i]));
      diff = Math.max(diff, Math.abs(a.L[i] - c.L[i]));
    }
    return { sameSeedMaxDiff: same, otherSeedMaxDiff: diff };
  },

  // CPU: 16 voices held for 4 s; ×realtime = audio seconds / wall seconds (offline render, one thread). Best of 2.
  async perf(id) {
    let best = Infinity, nodes = 0, ref = Infinity;
    for (let k = 0; k < 3; k++) {
      // reference: synth.js warm-pad, 16 voices, rendered interleaved (the machine may be shared/noisy)
      const { SynthInstrument } = await import('/js/engine/synth.js');
      const rc = new OfflineAudioContext(2, 4 * SR, SR);
      const ri = new SynthInstrument(rc, createRng(1), 'warm-pad', { attack: 0.05 });
      ri.output.connect(rc.destination);
      for (let i = 0; i < 16; i++) ri.noteOn(40 + i * 2, 0.7, 0.01 + i * 0.001);
      const r0 = performance.now();
      await rc.startRendering();
      ref = Math.min(ref, performance.now() - r0);
      const res = await render(id, hasParam(id, 'attack') ? { attack: 0.05 } : {}, 4, (inst) => {
        const lo = isBass(id) ? 28 : 40;
        for (let i = 0; i < 16; i++) inst.noteOn(lo + i * 2, 0.7, 0.01 + i * 0.001);
      });
      best = Math.min(best, res.renderMs);
      nodes = res.inst.liveNodeCount();
    }
    return { renderMs: best, xRealtime: 4 / (best / 1000), nodes, refMs: ref, refX: 4 / (ref / 1000), relCost: best / ref };
  },

  async realtime(id) {
    const ctx = new AudioContext();
    await ctx.resume();
    const inst = new SynthExtraInstrument(ctx, createRng(3), id, hasParam(id, 'attack') ? { attack: 0.01 } : {});
    const an = new AnalyserNode(ctx, { fftSize: 4096 });
    inst.output.connect(an);
    const v = inst.noteOn(baseNote(id), 0.8, ctx.currentTime + 0.02);
    await sleep(250);
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    const on = db(Math.sqrt(buf.reduce((a, x) => a + x * x, 0) / buf.length));
    inst.noteOff(v, ctx.currentTime);
    await sleep((inst.params.release * 1.3 + 0.3) * 1000);
    an.getFloatTimeDomainData(buf);
    const off = db(Math.max(...buf.map(Math.abs)));
    const live = inst.liveVoiceCount();
    inst.dispose();
    await ctx.close();
    return { onDb: on, offDb: off, live };
  },
};

window.T = T;
window.harnessReady = true;
