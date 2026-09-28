// levelMeter(): a thin vertical level bar for one slot, beside its fader (polish-1; design/H-v2 edit.html `.act`).
// It reads `read()` → {peak, rms} (controller.slotLevel(i)) once per frame, but only while it is on screen: one
// shared requestAnimationFrame loop serves every visible meter, and an IntersectionObserver takes a meter out of the
// loop when its view is hidden (Perform while Edit shows, an empty slot, a closed panel). A meter that is not read
// lets the engine disconnect its analyser tap after 2 s (engine.slotLevel), so a hidden meter costs no CPU on
// either thread. With nothing sounding the bar makes no DOM writes.
import { h, disposer } from './util.js';
import { dbToMeter } from './meter.js';

/** @type {Set<{frame:(now:number)=>void}>} meters on screen */
const active = new Set();
let raf = 0;
function loop(now) {
  raf = 0;
  for (const m of active) m.frame(now);
  if (active.size) raf = requestAnimationFrame(loop);
}
function wake() {
  if (!raf && active.size) raf = requestAnimationFrame(loop);
}

/**
 * @param {{read:() => ({peak:number, rms?:number}|null), label?:string, className?:string}} o
 * @returns {{el:HTMLElement, set():void, destroy():void, readonly running:boolean, readonly level:number,
 *            readonly reads:number}}
 */
export function levelMeter(o = {}) {
  const d = disposer();
  const cover = h('i.lvl-cover');
  const el = h('div.lvl-meter', { 'aria-hidden': 'true', title: o.label || 'Level' }, cover);
  if (o.className) el.classList.add(...String(o.className).split(/\s+/).filter(Boolean));
  let level = 0; // 0..1 meter position (dbToMeter: −60…0 dBFS)
  let shown = -1; // last written position (thousandths)
  let hot = false;
  let reads = 0;
  const self = {
    frame() {
      let r = null;
      try {
        r = typeof o.read === 'function' ? o.read() : null;
      } catch {
        r = null;
      }
      reads++;
      const p = r && Number.isFinite(r.peak) ? r.peak : 0;
      const target = p > 0 ? dbToMeter(20 * Math.log10(p)) : 0;
      // fast attack, ~20 dB/s release at 60 fps (as the top-bar meter)
      level = target > level ? target : Math.max(target, level - 0.012);
      const q = Math.round(level * 1000);
      if (q === shown) return;
      shown = q;
      cover.style.transform = `scaleY(${(1 - q / 1000).toFixed(3)})`;
      const nowHot = level > dbToMeter(-3);
      if (nowHot !== hot) el.classList.toggle('hot', (hot = nowHot));
    },
  };
  const start = () => {
    active.add(self);
    wake();
  };
  const stop = () => {
    active.delete(self);
  };
  d.add(stop);
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e && e.isIntersecting) start();
      else stop();
    });
    io.observe(el);
    d.add(() => io.disconnect());
  } else start();
  return {
    el,
    set() {},
    /** True while this meter is in the frame loop (test hook). */
    get running() {
      return active.has(self);
    },
    /** Current bar position 0..1 (test hook). */
    get level() {
      return level;
    },
    /** How many times read() was called (test hook). */
    get reads() {
      return reads;
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
