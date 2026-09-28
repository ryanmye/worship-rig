// meter(): stereo peak meter driven by engine.analyserL/R on requestAnimationFrame (SPEC §13). set() is unused.
import { h, disposer } from './util.js';

const FLOOR_DB = -60;

/** dBFS → 0..1 meter position. */
export const dbToMeter = (db) => Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));

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
    return { bar, fill, hold, level: 0, peak: 0, peakT: 0, clipT: 0 };
  };
  const L = mkBar('L');
  const R = mkBar('R');
  const el = h(`div.meter${o.vertical ? '.vertical' : ''}${o.compact ? '.compact' : ''}`, { role: 'meter', 'aria-label': o.label || 'Output level', 'aria-valuemin': String(FLOOR_DB), 'aria-valuemax': '0' }, L.bar, R.bar);
  let buf = null;
  let raf = 0;
  let lastAria = 0;
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
  const apply = (m, peak, now) => {
    const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    const target = dbToMeter(db);
    // fast attack, ~20 dB/s release
    m.level = target > m.level ? target : Math.max(target, m.level - 0.012);
    if (m.level >= m.peak || now - m.peakT > 1200) {
      m.peak = m.level;
      m.peakT = now;
    }
    if (db > -0.5) m.clipT = now;
    m.fill.style.transform = o.vertical ? `scaleY(${m.level.toFixed(3)})` : `scaleX(${m.level.toFixed(3)})`;
    m.hold.style[o.vertical ? 'bottom' : 'left'] = `${(m.peak * 100).toFixed(1)}%`;
    m.bar.classList.toggle('clip', now - m.clipT < 1500);
    m.bar.classList.toggle('hot', m.level > dbToMeter(-6));
    return db;
  };
  const frame = (now) => {
    raf = requestAnimationFrame(frame);
    let an;
    try {
      an = getAn();
    } catch {
      an = [null, null];
    }
    const dbL = apply(L, peakOf(an[0]), now);
    const dbR = apply(R, peakOf(an[1]), now);
    if (now - lastAria > 500) {
      lastAria = now;
      el.setAttribute('aria-valuenow', String(Math.max(FLOOR_DB, Math.round(Math.max(dbL, dbR)))));
    }
  };
  // round2-ui #10: only animate while on screen. A meter in a hidden view (Edit's while in Perform) would otherwise
  // read both analysers every frame on the thread that also handles MIDI. IntersectionObserver reports
  // display:none ([hidden] ancestors) as not intersecting.
  const start = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
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
    /** True while the animation loop runs (test hook). */
    get running() {
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
