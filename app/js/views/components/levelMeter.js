// levelMeter(): a thin vertical level bar for one slot, beside its fader (polish-1; design/H-v2 edit.html `.act`).
// It reads `read()` → {peak, rms} (controller.slotLevel(i)) on the shared meterClock loop (idle-cpu-ui: one rAF for
// every meter, ≤ 30 updates/s on any display), but only while it is on screen: an IntersectionObserver takes it out
// of the loop when its view is hidden (Perform while Edit shows, an empty slot, a closed panel, data-low-resource,
// data-window-hidden). A meter that is not read lets the engine disconnect its analyser tap after 2 s
// (engine.slotLevel), so a hidden meter costs no CPU on either thread. With nothing sounding the bar makes no DOM
// writes, and once its input stayed below −90 dBFS for SILENT_MS it is not read at all until the next activity
// (wakeMeters: a note, any input, a drone / master change). It has no probe: a strip only sounds after a note.
import { h, disposer } from './util.js';
import { dbToMeter } from './meter.js';
import { addMeter, wakeMeters, meterClockStats, SILENT_AMP } from './meterClock.js';

const RELEASE_PER_MS = 0.012 / 16.7; // ~20 dB/s, as the top-bar meter

/**
 * idle-cpu R1: wake every sleeping meter (kept for importers; main.js now wakes them from controller.onActivity).
 */
export function wakeLevelMeters() {
  wakeMeters();
}

/** Test hook: how many strip meters are awake / asleep on screen, and whether the shared loop is scheduled. */
export function levelMeterStats() {
  const s = meterClockStats();
  return { active: s.level.awake, dormant: s.level.visible - s.level.awake, scheduled: s.scheduled };
}

/**
 * @param {{read:() => ({peak:number, rms?:number}|null), label?:string, className?:string}} o
 * @returns {{el:HTMLElement, set():void, destroy():void, readonly running:boolean, readonly sleeping:boolean,
 *            readonly level:number, readonly reads:number}}
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
  const tick = (now, dt) => {
    let r = null;
    try {
      r = typeof o.read === 'function' ? o.read() : null;
    } catch {
      r = null;
    }
    reads++;
    const p = r && Number.isFinite(r.peak) ? r.peak : 0;
    const target = p > 0 ? dbToMeter(20 * Math.log10(p)) : 0;
    // fast attack, ~20 dB/s release (as the top-bar meter)
    level = target > level ? target : Math.max(target, level - RELEASE_PER_MS * dt);
    const q = Math.round(level * 1000);
    if (q !== shown) {
      shown = q;
      cover.style.transform = `scaleY(${(1 - q / 1000).toFixed(3)})`;
      const nowHot = level > dbToMeter(-3);
      if (nowHot !== hot) el.classList.toggle('hot', (hot = nowHot));
    }
    return q !== 0 || p >= SILENT_AMP;
  };
  const client = addMeter({ tick, kind: 'level' });
  d.add(() => client.remove());
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      client.setVisible(!!(e && e.isIntersecting));
    });
    io.observe(el);
    d.add(() => io.disconnect());
  } else client.setVisible(true);
  return {
    el,
    set() {},
    /** True while this meter is on screen: in the frame loop or asleep until the next activity (test hook). */
    get running() {
      return client.visible;
    },
    /** True while asleep (silent; not read until wakeMeters(); test hook). */
    get sleeping() {
      return client.visible && !client.awake;
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
