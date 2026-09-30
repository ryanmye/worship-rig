// meter(): stereo peak meter driven by engine.analyserL/R (SPEC §13). set() is unused.
// performance #2 / idle-cpu R1 / idle-cpu-ui: it runs on the shared meterClock loop (one rAF for every meter, ≤ 30
// updates/s on any display), writes only on change, moves the fill AND the peak hold with transform (no layout;
// idle-cpu R1b: `left` gave the drone's 4–6 layouts/s), never reads layout, and sleeps once its input stayed below
// −90 dBFS with the bars at rest for SILENT_MS. While asleep the clock probes the analysers once a second (a timer,
// no rAF); nothing runs or reads under data-low-resource / data-window-hidden.
import { h, disposer } from './util.js';
import { addMeter, FRAME_MS, SILENT_AMP } from './meterClock.js';

const FLOOR_DB = -60;
/** performance #2: minimum time between two meter updates (≈ 30 fps; rAF alone runs at 120 Hz on ProMotion). */
export const MIN_FRAME_MS = Math.floor(FRAME_MS);
/** idle-cpu R1 (kept for importers): how long a meter stays silent before it sleeps (meterClock SILENT_MS). */
export { SILENT_MS as IDLE_MS } from './meterClock.js';
const RELEASE_PER_MS = 0.012 / 16.7; // ~20 dB/s on the 60 dB scale

// idle-cpu-ui: every stereo meter reads the same master analysers (the top-bar meter and Edit's Master meter both show
// engine.analyserL/R); one read per analyser per clock frame is shared by all of them (keyed by the frame's `now`)
const framePeaks = new WeakMap();

/** dBFS → 0..1 meter position. */
export const dbToMeter = (db) => Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
const HOT = dbToMeter(-6);

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
    // idle-cpu-ui: the hold sits in a full-size track that moves with transform (a % translate of the 2 px hold itself
    // would be relative to its own width); themes keep painting .meter-hold
    const track = h('div.meter-hold-track', {}, hold);
    const bar = h('div.meter-bar', { dataset: { ch } }, fill, track);
    return { bar, fill, track, level: 0, peak: 0, peakT: 0, clipT: -1e9, q: -1, hq: -1, clip: false, hot: false };
  };
  const L = mkBar('L');
  const R = mkBar('R');
  const el = h(`div.meter${o.vertical ? '.vertical' : ''}${o.compact ? '.compact' : ''}`, { role: 'meter', 'aria-label': o.label || 'Output level', 'aria-valuemin': String(FLOOR_DB), 'aria-valuemax': '0' }, L.bar, R.bar);
  let buf = null;
  let lastAria = 0;
  let aria = '';
  const peakOf = (an) => {
    // a suspended / closed context (lowres2 audio sleep) leaves the analyser returning its last block forever: that is
    // not sound, and reading it would keep the meters awake
    if (!an || (an.context && an.context.state !== 'running')) return 0;
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
  // performance #2 / idle-cpu R1: write only what changed (transforms in 0.1 % / 0.5 % steps, class flips)
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
      const pct = (hq / 2).toFixed(1);
      // the track starts one bar-length before the bar (styles.css), so nothing ever overflows the bar's end
      m.track.style.transform = o.vertical ? `translateY(${(100 - hq / 2).toFixed(1)}%)` : `translateX(${pct}%)`;
    }
    const clip = now - m.clipT < 1500;
    if (clip !== m.clip) m.bar.classList.toggle('clip', (m.clip = clip));
    const hot = m.level > HOT;
    if (hot !== m.hot) m.bar.classList.toggle('hot', (m.hot = hot));
    return db;
  };
  const peakAt = (an, now) => {
    if (!an || typeof an !== 'object') return peakOf(an);
    const c = framePeaks.get(an);
    if (c && c.t === now) return c.p;
    const p = peakOf(an);
    framePeaks.set(an, { t: now, p });
    return p;
  };
  const readAn = () => {
    try {
      return getAn();
    } catch {
      return [null, null];
    }
  };
  const tick = (now, dt) => {
    const an = readAn();
    const pL = peakAt(an[0], now);
    const pR = peakAt(an[1], now);
    const dbL = apply(L, pL, now, dt);
    const dbR = apply(R, pR, now, dt);
    if (now - lastAria > 500) {
      lastAria = now;
      const v = String(Math.max(FLOOR_DB, Math.round(Math.max(dbL, dbR))));
      if (v !== aria) el.setAttribute('aria-valuenow', (aria = v));
    }
    // at rest: input below −90 dBFS, bars and holds at 0, no clip light (then the clock may put it to sleep)
    const rest = pL < SILENT_AMP && pR < SILENT_AMP && !L.q && !R.q && !L.hq && !R.hq && !L.clip && !R.clip;
    return !rest;
  };
  // the safety probe while asleep: any sound above the silence threshold wakes the meters
  const probe = () => {
    const an = readAn();
    return peakOf(an[0]) >= SILENT_AMP || peakOf(an[1]) >= SILENT_AMP;
  };
  const client = addMeter({ tick, probe, kind: 'meter' });
  d.add(() => client.remove());
  // round2-ui #10: only animate while on screen. A meter in a hidden view (Edit's while in Perform) would otherwise
  // read both analysers on the thread that also handles MIDI. IntersectionObserver reports display:none ([hidden]
  // ancestors, data-low-resource / data-window-hidden) as not intersecting.
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      client.setVisible(!!(e && e.isIntersecting));
    });
    io.observe(el);
    d.add(() => io.disconnect());
  } else client.setVisible(true);
  return {
    /** True while the meter is on screen and awake in the shared loop (test hook). */
    get running() {
      return client.visible && client.awake;
    },
    /** Same as running (the shared loop animates every awake visible meter; test hook). */
    get animating() {
      return client.visible && client.awake;
    },
    /** True while on screen but asleep (silent; woken by wakeMeters() or the probe; test hook). */
    get sleeping() {
      return client.visible && !client.awake;
    },
    el,
    set() {},
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
