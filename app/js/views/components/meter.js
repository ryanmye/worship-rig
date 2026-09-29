// meter(): stereo peak meter driven by engine.analyserL/R on requestAnimationFrame (SPEC §13). set() is unused.
// performance #2 / idle-cpu R1: ≤ 30 updates/s, DOM writes only on change, and no frame loop while silent.
import { h, disposer } from './util.js';

const FLOOR_DB = -60;
/** performance #2: minimum time between two meter updates (≈ 30 fps; rAF alone runs at 120 Hz on ProMotion). */
export const MIN_FRAME_MS = 30;
/** idle-cpu R1: after this long at zero the meter stops its frame loop and polls every IDLE_POLL_MS. */
export const IDLE_MS = 1000;
export const IDLE_POLL_MS = 250;
const RELEASE_PER_MS = 0.012 / 16.7; // ~20 dB/s on the 60 dB scale

/** dBFS → 0..1 meter position. */
export const dbToMeter = (db) => Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
const HOT = dbToMeter(-6);
const FLOOR_AMP = 10 ** (FLOOR_DB / 20);

/**
 * @param {{engine?:{analyserL:AnalyserNode|null, analyserR:AnalyserNode|null}, analysers?:()=>[AnalyserNode|null, AnalyserNode|null],
 *          vertical?:boolean, label?:string, compact?:boolean}} [o]
 */
export function meter(o = {}) {
  const d = disposer();
  const getAn = o.analysers || (() => [o.engine?.analyserL || null, o.engine?.analyserR || null]);
  const mkBar = (ch) => {
    const fill = h('div.meter-fill');
    const hold = h('div.meter-hold');
    const bar = h('div.meter-bar', { dataset: { ch } }, fill, hold);
    return { bar, fill, hold, level: 0, peak: 0, peakT: 0, clipT: -1e9, q: -1, hq: -1, clip: false, hot: false };
  };
  const L = mkBar('L');
  const R = mkBar('R');
  const el = h(`div.meter${o.vertical ? '.vertical' : ''}${o.compact ? '.compact' : ''}`, { role: 'meter', 'aria-label': o.label || 'Output level', 'aria-valuemin': String(FLOOR_DB), 'aria-valuemax': '0' }, L.bar, R.bar);
  let buf = null;
  let raf = 0;
  let poll = 0; // idle: a slow setTimeout poll instead of a frame loop
  let lastWork = 0;
  let quietSince = 0;
  let lastAria = 0;
  let aria = '';
  const peakOf = (an) => {
    if (!an) return 0;
    const n = an.fftSize;
    if (!buf || buf.length !== n) buf = new Float32Array(n);
    an.getFloatTimeDomainData(buf);
    let p = 0;
    for (let i = 0; i < n; i++) {
      const a = buf[i] < 0 ? -buf[i] : buf[i];
      if (a > p) p = a;
    }
    return p;
  };
  // performance #2 / idle-cpu R1: write only what changed (a transform, the hold in 0.5 % steps, class flips)
  const apply = (m, peak, now, dt) => {
    const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    const target = dbToMeter(db);
    // fast attack, ~20 dB/s release (0.012 per 60 fps frame, scaled by the real frame time)
    m.level = target > m.level ? target : Math.max(target, m.level - RELEASE_PER_MS * dt);
    if (m.level >= m.peak || now - m.peakT > 1200) {
      m.peak = m.level;
      m.peakT = now;
    }
    if (db > -0.5) m.clipT = now;
    const q = Math.round(m.level * 1000);
    if (q !== m.q) {
      m.q = q;
      m.fill.style.transform = o.vertical ? `scaleY(${(q / 1000).toFixed(3)})` : `scaleX(${(q / 1000).toFixed(3)})`;
    }
    const hq = Math.round(m.peak * 200);
    if (hq !== m.hq) {
      m.hq = hq;
      m.hold.style[o.vertical ? 'bottom' : 'left'] = `${(hq / 2).toFixed(1)}%`;
    }
    const clip = now - m.clipT < 1500;
    if (clip !== m.clip) m.bar.classList.toggle('clip', (m.clip = clip));
    const hot = m.level > HOT;
    if (hot !== m.hot) m.bar.classList.toggle('hot', (m.hot = hot));
    return db;
  };
  const readAn = () => {
    try {
      return getAn();
    } catch {
      return [null, null];
    }
  };
  const frame = (now) => {
    raf = 0;
    // performance #2: at most ~30 updates a second, whatever the display's refresh rate
    if (now - lastWork < MIN_FRAME_MS) {
      raf = requestAnimationFrame(frame);
      return;
    }
    const dt = lastWork ? Math.min(100, now - lastWork) : 16.7;
    lastWork = now;
    const an = readAn();
    const dbL = apply(L, peakOf(an[0]), now, dt);
    const dbR = apply(R, peakOf(an[1]), now, dt);
    if (now - lastAria > 500) {
      lastAria = now;
      const v = String(Math.max(FLOOR_DB, Math.round(Math.max(dbL, dbR))));
      if (v !== aria) el.setAttribute('aria-valuenow', (aria = v));
    }
    // idle-cpu R1: silent (bars and holds at 0, no clip light) for IDLE_MS → stop the frame loop, poll slowly
    const silent = !L.q && !R.q && !L.hq && !R.hq && !L.clip && !R.clip;
    if (!silent) quietSince = 0;
    else if (!quietSince) quietSince = now;
    else if (now - quietSince > IDLE_MS) {
      lastWork = 0;
      poll = setTimeout(idlePoll, IDLE_POLL_MS);
      return;
    }
    raf = requestAnimationFrame(frame);
  };
  const idlePoll = () => {
    poll = 0;
    const an = readAn();
    if (peakOf(an[0]) > FLOOR_AMP || peakOf(an[1]) > FLOOR_AMP) { // above the meter's −60 dB floor
      quietSince = 0;
      raf = requestAnimationFrame(frame);
    } else poll = setTimeout(idlePoll, IDLE_POLL_MS);
  };
  // round2-ui #10: only animate while on screen. A meter in a hidden view (Edit's while in Perform) would otherwise
  // read both analysers every frame on the thread that also handles MIDI. IntersectionObserver reports
  // display:none ([hidden] ancestors) as not intersecting.
  const start = () => {
    if (!raf && !poll) {
      quietSince = 0;
      raf = requestAnimationFrame(frame);
    }
  };
  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    clearTimeout(poll);
    raf = 0;
    poll = 0;
    lastWork = 0;
  };
  start();
  d.add(stop);
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e && e.isIntersecting) start();
      else stop();
    });
    io.observe(el);
    d.add(() => io.disconnect());
  }
  return {
    /** True while the meter is live: its frame loop or, when idle, its slow poll (test hook). */
    get running() {
      return !!raf || !!poll;
    },
    /** True while the frame loop runs (not the idle poll; test hook). */
    get animating() {
      return !!raf;
    },
    el,
    set() {},
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
