// Signal measures shared by render.mjs (manifest stats) and compare.mjs (tolerance checks). Node, no deps.
//
// Definitions (the native test runner must compute the same, see native/golden/README.md):
//   peak            max |x| over both channels
//   rms             sqrt(mean(x²)) over both channels and all frames
//   bands           third-octave band energies (dB re full-scale power) of the mono mix (L+R)/2: Welch average of
//                   Hann-windowed 4096-point FFTs, hop 2048, bins summed into bands with ISO centres
//                   10^(k/10) Hz, k = 14..43 (25 Hz … 20 kHz), edges centre·2^(±1/6)
//   envelope        10 ms (441-frame) block RMS of the mono mix, in dB floored at −120
//   envCorr         Pearson correlation of two envelopes (in dB), over blocks where either is above −90 dB
//   maxAbsDiff      max over channels and frames of |a − b| (lengths: the shorter; a length mismatch is reported)

/** @returns {Float32Array} (L+R)/2 */
export function monoMix(chs) {
  const n = chs[0].length;
  const m = new Float32Array(n);
  if (chs.length === 1) m.set(chs[0]);
  else for (let i = 0; i < n; i++) m[i] = (chs[0][i] + chs[1][i]) / 2;
  return m;
}

/** @returns {{peak:number, rms:number, peakDb:number, rmsDb:number}} */
export function levelStats(chs) {
  let peak = 0;
  let ss = 0;
  let n = 0;
  for (const c of chs) {
    for (let i = 0; i < c.length; i++) {
      const v = c[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      ss += v * v;
    }
    n += c.length;
  }
  const rms = Math.sqrt(ss / Math.max(1, n));
  const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  return { peak, rms, peakDb: db(peak), rmsDb: db(rms) };
}

/** In-place iterative radix-2 FFT. */
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

export const BAND_CENTERS = Array.from({ length: 30 }, (_, i) => Math.pow(10, (i + 14) / 10));

/**
 * Third-octave band energies of the mono mix (dB; −Infinity → −200).
 * @param {Float32Array[]} chs
 * @param {number} sr
 * @returns {number[]} one per BAND_CENTERS entry
 */
export function thirdOctaveBands(chs, sr) {
  const x = monoMix(chs);
  const N = 4096;
  const hop = 2048;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const psd = new Float64Array(N / 2 + 1);
  let frames = 0;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let s = 0; s === 0 || s + N <= x.length; s += hop) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < N && s + i < x.length; i++) re[i] = x[s + i] * win[i];
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
    if (s + N >= x.length) break;
  }
  const out = [];
  for (const fc of BAND_CENTERS) {
    const lo = fc * Math.pow(2, -1 / 6);
    const hi = fc * Math.pow(2, 1 / 6);
    let e = 0;
    for (let k = Math.ceil((lo * N) / sr); k <= Math.floor((hi * N) / sr) && k <= N / 2; k++) e += psd[k];
    // the lowest bands can be narrower than a bin: take the nearest bin then
    if (e === 0 && Math.floor((hi * N) / sr) < Math.ceil((lo * N) / sr)) {
      e = psd[Math.min(N / 2, Math.round((fc * N) / sr))];
    }
    const v = e / Math.max(1, frames) / (N * N);
    out.push(v > 0 ? Math.max(-200, 10 * Math.log10(v)) : -200);
  }
  return out;
}

/**
 * 10 ms block RMS envelope of the mono mix in dB (floor −120).
 * @returns {Float64Array}
 */
export function envelopeDb(chs, sr, blockSec = 0.01) {
  const x = monoMix(chs);
  const B = Math.round(blockSec * sr);
  const nb = Math.ceil(x.length / B);
  const env = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let ss = 0;
    const e = Math.min(x.length, (b + 1) * B);
    for (let i = b * B; i < e; i++) ss += x[i] * x[i];
    const r = Math.sqrt(ss / Math.max(1, e - b * B));
    env[b] = r > 1e-6 ? 20 * Math.log10(r) : -120;
  }
  return env;
}

/** Pearson correlation of two dB envelopes over the blocks where either is above `gateDb`. 1 when both are silent. */
export function envCorrelation(a, b, gateDb = -90) {
  const n = Math.min(a.length, b.length);
  let sa = 0;
  let sb = 0;
  let m = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] > gateDb || b[i] > gateDb) {
      sa += a[i];
      sb += b[i];
      m++;
    }
  }
  if (m < 2) return 1;
  const ma = sa / m;
  const mb = sb / m;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    if (!(a[i] > gateDb || b[i] > gateDb)) continue;
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 && db === 0) return 1;
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/** max |a − b| over channels, and the length difference (frames). */
export function maxAbsDiff(a, b) {
  let m = 0;
  const nch = Math.min(a.length, b.length);
  let n = Infinity;
  for (let c = 0; c < nch; c++) {
    const x = a[c];
    const y = b[c];
    const len = Math.min(x.length, y.length);
    n = Math.min(n, len);
    for (let i = 0; i < len; i++) {
      const d = Math.abs(x[i] - y[i]);
      if (d > m || Number.isNaN(d)) m = Number.isNaN(d) ? Infinity : d;
    }
  }
  return { maxAbs: m, frames: n, lengthDiff: Math.abs(a[0].length - b[0].length), channelDiff: a.length - b.length };
}

/**
 * Worst band difference (dB) between two band vectors, over bands where the reference is within `rangeDb` of its
 * loudest band (quieter bands are noise floor and not compared).
 */
export function bandDiff(ref, test, rangeDb = 60) {
  const top = Math.max(...ref);
  let worst = 0;
  let worstHz = null;
  ref.forEach((r, i) => {
    if (r < top - rangeDb) return;
    const d = Math.abs(r - test[i]);
    if (d > worst) {
      worst = d;
      worstHz = BAND_CENTERS[i];
    }
  });
  return { worstDb: worst, worstHz };
}
