// Shared offline analysis helpers for tools/calibrate.mjs and tools/audition.mjs ("robot listener").
// Pure ES2022, no dependencies: runs in Node (and in a browser if ever needed). All levels are dBFS where
// 0 dBFS = a full-scale sample value of ±1.0. Signals are Float32Array / Float64Array per channel.

export const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
export const dbPow = (p) => (p > 0 ? 10 * Math.log10(p) : -Infinity);
export const fromDb = (d) => Math.pow(10, d / 20);
export const round = (x, n = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** n) / 10 ** n : x);

const span = (len, sr, a = 0, b = Infinity) => {
  const i0 = Math.max(0, Math.floor(a * sr));
  const i1 = Math.min(len, Math.floor(Math.min(b, len / sr) * sr));
  return [i0, Math.max(i0, i1)];
};

/** Mean square of one channel over [a, b] seconds. */
export function meanSquare(x, sr, a = 0, b = Infinity) {
  const [i0, i1] = span(x.length, sr, a, b);
  let s = 0;
  for (let i = i0; i < i1; i++) s += x[i] * x[i];
  return i1 > i0 ? s / (i1 - i0) : 0;
}

/**
 * Stereo RMS in dBFS: sqrt of the mean square averaged over channels (the usual "RMS of a stereo file";
 * a mono signal on both channels reads the same as that mono signal).
 */
export function rmsDb(chs, sr, a = 0, b = Infinity) {
  let p = 0;
  for (const c of chs) p += meanSquare(c, sr, a, b);
  return dbPow(p / chs.length);
}

// ---- biquads (RBJ cookbook), 4th-order Butterworth = two cascaded sections with Q .5412 / 1.3066 ----------------
const BW4_Q = [0.5411961, 1.3065630];

function biquadCoefs(type, f0, q, sr) {
  const w0 = (2 * Math.PI * f0) / sr;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0, b1, b2;
  if (type === 'lowpass') {
    b0 = (1 - cw) / 2;
    b1 = 1 - cw;
    b2 = (1 - cw) / 2;
  } else {
    b0 = (1 + cw) / 2;
    b1 = -(1 + cw);
    b2 = (1 + cw) / 2;
  }
  const a0 = 1 + alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
}

function biquadRun(x, c) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = yi;
    y[i] = yi;
  }
  return y;
}

/** 4th-order Butterworth high-pass / low-pass (filter state starts at the first sample). */
export function butter4(x, type, f0, sr) {
  let y = x;
  for (const q of BW4_Q) y = biquadRun(y, biquadCoefs(type, f0, q, sr));
  return y;
}

/** Band-pass [lo, hi] Hz = HPF lo ∘ LPF hi (both 4th-order Butterworth). */
export function bandpass(x, sr, lo, hi) {
  let y = x;
  if (lo > 0) y = butter4(y, 'highpass', lo, sr);
  if (hi < sr / 2) y = butter4(y, 'lowpass', hi, sr);
  return y;
}

/**
 * Band-limited stereo RMS (dBFS). The whole signal is filtered from t=0 (so filter start-up transients are outside
 * a measurement window that starts later), then measured over [a, b].
 */
export function bandRmsDb(chs, sr, lo, hi, a = 0, b = Infinity) {
  return rmsDb(chs.map((c) => bandpass(c, sr, lo, hi)), sr, a, b);
}

/** Sample peak over all channels (dBFS) and where it happened. */
export function peak(chs, sr) {
  let m = 0;
  let at = 0;
  for (const c of chs) {
    for (let i = 0; i < c.length; i++) {
      const v = Math.abs(c[i]);
      if (v > m) {
        m = v;
        at = i;
      }
    }
  }
  return { db: db(m), lin: m, at: at / sr };
}

/** Largest |mean| over channels. */
export function dcOffset(chs, sr, a = 0, b = Infinity) {
  let worst = 0;
  for (const c of chs) {
    const [i0, i1] = span(c.length, sr, a, b);
    let s = 0;
    for (let i = i0; i < i1; i++) s += c[i];
    const m = i1 > i0 ? s / (i1 - i0) : 0;
    if (Math.abs(m) > Math.abs(worst)) worst = m;
  }
  return worst;
}

/** Count of non-finite samples (NaN/±Infinity). */
export function nonFinite(chs) {
  let n = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) if (!Number.isFinite(c[i])) n++;
  return n;
}

/**
 * Mono-sum loss (dB): stereo RMS minus RMS of (L+R)/2. 0 dB = fully correlated (mono-compatible), +3 dB = L and R
 * uncorrelated, → ∞ for anti-phase. A mono PA playing this sounds `loss` dB quieter than the stereo mix.
 */
export function monoLossDb(chs, sr, a = 0, b = Infinity) {
  if (chs.length < 2) return 0;
  const [L, R] = chs;
  const [i0, i1] = span(L.length, sr, a, b);
  let sl = 0, sr2 = 0, sm = 0;
  for (let i = i0; i < i1; i++) {
    sl += L[i] * L[i];
    sr2 += R[i] * R[i];
    const m = 0.5 * (L[i] + R[i]);
    sm += m * m;
  }
  return dbPow((sl + sr2) / 2) - dbPow(sm);
}

/** Mono downmix (L+R)/2. */
export function mixMono(chs) {
  if (chs.length === 1) return Float32Array.from(chs[0]);
  const out = new Float32Array(chs[0].length);
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * (chs[0][i] + chs[1][i]);
  return out;
}

// ---- FFT / spectral centroid --------------------------------------------------------------------------------------
export function fft(re, im) {
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
      let cr = 1, ci = 0;
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

/** Average power spectrum (Hann frames of n, hop n/2) of a mono signal over [a, b]. */
export function powerSpectrum(x, sr, a = 0, b = Infinity, n = 4096) {
  const [i0, i1] = span(x.length, sr, a, b);
  const acc = new Float64Array(n / 2);
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  let frames = 0;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let s = i0; s + n <= i1; s += n / 2) {
    for (let i = 0; i < n; i++) {
      re[i] = x[s + i] * w[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < n / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  if (frames) for (let k = 0; k < n / 2; k++) acc[k] /= frames;
  return { pow: acc, binHz: sr / n, frames };
}

/** Spectral centroid (Hz) of the mono downmix over [a, b]. */
export function spectralCentroid(chs, sr, a = 0, b = Infinity) {
  const { pow, binHz, frames } = powerSpectrum(mixMono(chs), sr, a, b);
  if (!frames) return NaN;
  let num = 0, den = 0;
  for (let k = 1; k < pow.length; k++) {
    num += k * binHz * pow[k];
    den += pow[k];
  }
  return den > 0 ? num / den : NaN;
}

/** Fraction of mono power below `hz` over [a, b] (e.g. how bass-heavy a mix is). */
export function powerFractionBelow(chs, sr, hz, a = 0, b = Infinity) {
  const { pow, binHz } = powerSpectrum(mixMono(chs), sr, a, b, 8192);
  let lo = 0, all = 0;
  for (let k = 1; k < pow.length; k++) {
    all += pow[k];
    if (k * binHz < hz) lo += pow[k];
  }
  return all > 0 ? lo / all : 0;
}

/** Short-window RMS envelope (dBFS) of the mono downmix: [{t, db}] every `hop` s over windows of `win` s. */
export function envelopeDb(chs, sr, win = 0.05, hop = 0.05) {
  const m = mixMono(chs);
  const out = [];
  for (let t = 0; t + win <= m.length / sr + 1e-9; t += hop) out.push({ t: round(t, 3), db: round(dbPow(meanSquare(m, sr, t, t + win)), 1) });
  return out;
}

/** Longest stretch (s) inside [a, b] whose 10 ms RMS stays below `floorDb` (drop-outs). */
export function longestDropout(chs, sr, a, b, floorDb = -60, win = 0.01) {
  const m = mixMono(chs);
  let run = 0, best = 0, bestAt = null, start = null;
  for (let t = a; t + win <= b; t += win) {
    if (dbPow(meanSquare(m, sr, t, t + win)) < floorDb) {
      if (start === null) start = t;
      run += win;
      if (run > best) {
        best = run;
        bestAt = start;
      }
    } else {
      run = 0;
      start = null;
    }
  }
  return { seconds: round(best, 3), at: bestAt === null ? null : round(bestAt, 3) };
}

// ---- click detector -----------------------------------------------------------------------------------------------
/**
 * High-frequency burst detector. Clicks (discontinuities, hard voice kills, zipper steps) are broadband and
 * impulsive, so they show up as a short burst in the > `hpHz` band that stands far above the recent HF level.
 * Steady bright content (saw pads, cymbal-like bells, hiss) raises the local baseline and is not flagged.
 *
 * Per channel: 4th-order HPF at `hpHz` → RMS envelope in 1 ms hops over 2 ms windows → local baseline = median
 * of the envelope over ±`ctxMs` (the window centre ±3 ms excluded) → flag hops where env > baseline + `ratioDb`
 * AND env > `floorDb`. Adjacent flags merge into one event. Events starting within `graceMs` after any time in
 * `excludeTimes` (scheduled note-ons: hammer/tine attacks are legitimate HF bursts) are dropped.
 *
 * (A plain first-difference test, "|Δx| > 6× local median", flags dense saw pads with no event at all; see
 * CONTRACT_CHANGES.md engine-instruments "§11 click detector". The HF-burst form is robust to that.)
 *
 * @returns {{count:number, events:{t:number, db:number, overDb:number, ch:number}[]}}
 */
export function detectClicks(chs, sr, {
  hpHz = 7000, ratioDb = 18, floorDb = -66, ctxMs = 120, excludeTimes = [], graceMs = 80, a = 0.02, b = Infinity,
} = {}) {
  const hop = Math.max(1, Math.round(sr * 0.001));
  const win = hop * 2;
  const ratio = Math.pow(10, ratioDb / 20);
  const floor = Math.pow(10, floorDb / 20);
  const events = [];
  chs.forEach((c, ch) => {
    const h = butter4(c, 'highpass', hpHz, sr);
    const nh = Math.floor((h.length - win) / hop);
    const env = new Float64Array(Math.max(0, nh));
    for (let k = 0; k < nh; k++) {
      let s = 0;
      const o = k * hop;
      for (let i = 0; i < win; i++) s += h[o + i] * h[o + i];
      env[k] = Math.sqrt(s / win);
    }
    const ctx = Math.round(ctxMs);
    const tmp = [];
    let open = null;
    const [k0, k1] = [Math.floor((a * sr) / hop), Math.min(nh, Math.floor((Math.min(b, c.length / sr) * sr) / hop))];
    for (let k = Math.max(k0, 0); k < k1; k++) {
      tmp.length = 0;
      for (let j = Math.max(0, k - ctx); j < Math.min(nh, k + ctx); j++) if (Math.abs(j - k) > 3) tmp.push(env[j]);
      tmp.sort((x, y) => x - y);
      const base = tmp.length ? tmp[tmp.length >> 1] : 0;
      const hit = env[k] > floor && env[k] > base * ratio;
      if (hit) {
        const over = db(env[k] / Math.max(base, 1e-12));
        if (!open) open = { t: (k * hop) / sr, db: db(env[k]), overDb: over, ch };
        else if (over > open.overDb) {
          open.overDb = over;
          open.db = db(env[k]);
        }
      } else if (open) {
        events.push(open);
        open = null;
      }
    }
    if (open) events.push(open);
  });
  const grace = graceMs / 1000;
  const kept = events
    .filter((e) => !excludeTimes.some((t) => e.t >= t - 0.005 && e.t <= t + grace))
    .sort((x, y) => x.t - y.t);
  // merge L/R duplicates within 5 ms
  const merged = [];
  for (const e of kept) {
    const last = merged[merged.length - 1];
    if (last && e.t - last.t < 0.005) {
      if (e.overDb > last.overDb) Object.assign(last, e);
    } else merged.push({ ...e });
  }
  return { count: merged.length, events: merged.map((e) => ({ t: round(e.t, 3), db: round(e.db, 1), overDb: round(e.overDb, 1), ch: e.ch })) };
}

/**
 * Positive/negative control for detectClicks (run before trusting it): a clean sine and a dense detuned-saw pad must
 * give 0 events; the same sine with a single phase jump must give ≥ 1 event at the jump.
 */
export function clickDetectorSelfTest(sr = 44100) {
  const n = sr * 2;
  const sine = new Float32Array(n);
  const jump = new Float32Array(n);
  const saws = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    sine[i] = 0.25 * Math.sin(2 * Math.PI * 440 * t);
    jump[i] = 0.25 * Math.sin(2 * Math.PI * 440 * t + (i >= sr ? Math.PI / 2 : 0));
    let s = 0;
    for (const f of [130.81, 164.81, 196, 261.63]) for (const d of [-0.004, 0, 0.004]) s += ((f * (1 + d) * t) % 1) * 2 - 1;
    saws[i] = 0.02 * s;
  }
  const a = detectClicks([sine, sine], sr);
  const b = detectClicks([jump, jump], sr);
  const c = detectClicks([saws, saws], sr);
  const hitAtJump = b.events.some((e) => Math.abs(e.t - 1) < 0.01);
  return { pass: a.count === 0 && c.count === 0 && hitAtJump, clean: a.count, sawPad: c.count, jump: b.count, hitAtJump };
}
