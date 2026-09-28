// Decodes an audio file with ffmpeg (f32le, native channel count/rate) and
// computes the stats the samples tooling checks:
//   peakDb      overall sample peak, dBFS
//   dc          per-channel mean (DC offset), and dcRatio = max|dc| / peak
//   corr        L/R Pearson correlation over the whole file (stereo only)
//   corrEarly   L/R correlation over the first 1.5 s (the attack, where phase
//               problems are most audible when the stereo image is summed)
//   monoLossDb  level drop when summed to mono: rms(L)+rms(R) combined vs rms((L+R)/2)
import { spawn } from 'node:child_process';

export function decode(file) {
  return new Promise((resolve, reject) => {
    const probe = spawn('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=channels,sample_rate',
      '-of', 'default=noprint_wrappers=1', file,
    ]);
    let meta = '';
    probe.stdout.on('data', (d) => (meta += d));
    probe.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${file}`));
      const channels = Number(/channels=(\d+)/.exec(meta)?.[1]);
      const sampleRate = Number(/sample_rate=(\d+)/.exec(meta)?.[1]);
      const proc = spawn('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-acodec', 'pcm_f32le', '-']);
      const chunks = [];
      let err = '';
      proc.stdout.on('data', (d) => chunks.push(d));
      proc.stderr.on('data', (d) => (err += d));
      proc.on('close', (c) => {
        if (c !== 0) return reject(new Error(`ffmpeg decode failed: ${file}: ${err}`));
        const buf = Buffer.concat(chunks);
        const all = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
        const frames = Math.floor(all.length / channels);
        const chs = Array.from({ length: channels }, () => new Float32Array(frames));
        for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) chs[c][i] = all[i * channels + c];
        resolve({ chs, sampleRate, channels, frames });
      });
    });
  });
}

const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

function corr(a, b, n) {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  const cov = sab - (sa * sb) / n;
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 1;
}

export async function analyze(file) {
  const { chs, sampleRate, channels, frames } = await decode(file);
  let peak = 0;
  const dc = [];
  const rms = [];
  for (const ch of chs) {
    let s = 0, ss = 0;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      s += v; ss += v * v;
    }
    dc.push(s / ch.length);
    rms.push(Math.sqrt(ss / ch.length));
  }
  const out = {
    file, channels, sampleRate, frames, duration: frames / sampleRate,
    peak, peakDb: db(peak), dc, dcRatio: peak > 0 ? Math.max(...dc.map(Math.abs)) / peak : 0,
    rmsDb: db(Math.sqrt(rms.reduce((s, r) => s + r * r, 0) / rms.length)),
  };
  if (channels === 2) {
    const [L, R] = chs;
    out.corr = corr(L, R, frames);
    out.corrEarly = corr(L, R, Math.min(frames, Math.round(1.5 * sampleRate)));
    let ss = 0;
    for (let i = 0; i < frames; i++) { const m = (L[i] + R[i]) / 2; ss += m * m; }
    const monoRms = Math.sqrt(ss / frames);
    const stereoRms = Math.sqrt((rms[0] ** 2 + rms[1] ** 2) / 2);
    out.monoLossDb = db(stereoRms) - db(monoRms);
  }
  return out;
}

// RBJ biquad (in place), used for band-limiting the loudness measure.
function biquad(x, sr, type, f0, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * f0) / sr;
  const cw = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
  else { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
  const a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    x[i] = y0;
  }
  return x;
}

// "Attack loudness": band RMS (100 Hz-5 kHz, the calibration band) over `win` seconds from the onset (first sample
// within 40 dB of the file's peak), channels averaged in power. Used to level-match notes within a sample set.
export async function earlyLoudnessDb(file, { win = 0.5, lo = 100, hi = 5000 } = {}) {
  const { chs, sampleRate } = await decode(file);
  let peak = 0;
  for (const ch of chs) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  const thr = peak * 10 ** (-40 / 20);
  let on = 0;
  outer: for (let i = 0; i < chs[0].length; i++) for (const ch of chs) if (Math.abs(ch[i]) > thr) { on = i; break outer; }
  const pre = Math.round(0.05 * sampleRate); // filter warm-up, excluded from the measurement
  const start = Math.max(0, on - pre);
  const n = Math.round(win * sampleRate);
  let ss = 0, cnt = 0;
  for (const ch of chs) {
    const seg = Float64Array.from(ch.subarray(start, on + n));
    biquad(biquad(seg, sampleRate, 'hp', lo), sampleRate, 'lp', hi);
    for (let i = on - start; i < seg.length; i++) { ss += seg[i] * seg[i]; cnt++; }
  }
  return db(Math.sqrt(ss / Math.max(1, cnt)));
}

// Least-squares quadratic y ≈ a + b·x + c·x² (x centred for conditioning); returns x => y.
export function polyfit2(xs, ys) {
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const S = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
  xs.forEach((x0, i) => {
    const x = x0 - mx;
    const v = [1, x, x * x];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) S[r][c] += v[r] * v[c];
      S[r][3] += v[r] * ys[i];
    }
  });
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(S[r][c]) > Math.abs(S[p][c])) p = r;
    [S[c], S[p]] = [S[p], S[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = S[r][c] / S[c][c];
      for (let k = c; k < 4; k++) S[r][k] -= f * S[c][k];
    }
  }
  const [a, b, c2] = [S[0][3] / S[0][0], S[1][3] / S[1][1], S[2][3] / S[2][2]];
  return (x0) => { const x = x0 - mx; return a + b * x + c2 * x * x; };
}

export { db };
