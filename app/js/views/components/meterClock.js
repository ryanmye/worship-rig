// meterClock: the one frame loop every level meter shares (idle-cpu-ui; reviews/idle-cpu-mac.md, idle-cpu R1/R1c/R4).
// On the Mac (120 Hz ProMotion) the meters re-armed requestAnimationFrame every frame even at level 0: 121 style
// recalcs/s in every configuration. Here:
//   * one loop for all meters (meter.js top-bar/Edit meters and levelMeter.js strip bars), at ≤ 30 updates/s on any
//     display: after a frame the next one is requested from a setTimeout, so a 120 Hz display produces ~30 frames/s,
//     not 120 with 90 skipped (a skipped rAF still costs a BeginMainFrame; idle-cpu R1c);
//   * a meter whose input stayed below −90 dBFS (and whose bar is back at rest) for SILENT_MS goes to sleep; with every
//     meter asleep the loop stops completely (0 rAF callbacks/s) until wakeMeters() — main.js calls it from the
//     controller's 'activity' signal (note-on, any input, drone / master / song changes, recording);
//   * a safety probe: while asleep, meters that can probe (the stereo meters, whose master analysers are always
//     connected) are read once every PROBE_MS by a timer (no rAF), so sound that no activity announced still wakes
//     them within a second;
//   * nothing runs, and nothing is read, under <html data-low-resource> or <html data-window-hidden> or while the
//     document is hidden (no rAF, no analyser reads, no probe); clearing the attribute wakes the meters, no reload.
// Clients never read layout in their tick (no offsetWidth / getBoundingClientRect); they write transform / opacity /
// classes only, and only when the value changed.

/** Frame period at the 30 fps cap. */
export const FRAME_MS = 1000 / 30;
/**
 * Timer slack: the timer that precedes a frame's rAF is set this much short of FRAME_MS, so the rAF lands on the vsync
 * at ≈ FRAME_MS (at most 1000 / (FRAME_MS − SLACK_MS) ≈ 32 frames/s).
 */
const SLACK_MS = 2;
/** A meter that stayed silent this long sleeps; with every meter asleep the loop stops. */
export const SILENT_MS = 500;
/** "Silent" = peak below −90 dBFS (the bars' floor is −60 dB). */
export const SILENT_AMP = 10 ** (-90 / 20);
/** Safety probe period while every meter sleeps (a timer, not rAF). */
export const PROBE_MS = 1000;
/** Longest dt handed to a tick (the bars' full 60 dB release takes 3 s). */
const MAX_DT_MS = 5000;

/**
 * @typedef {object} MeterClient
 * @property {(now:number, dt:number) => boolean} tick  update the meter; true while it is not at rest (input above
 *   SILENT_AMP, or the bar / hold / clip light still moving)
 * @property {() => boolean} [probe]  cheap check while asleep: true when there is sound (wakes every meter)
 * @property {string} [kind]  'meter' | 'level' (stats only)
 */

/** @type {Set<{c:MeterClient, visible:boolean, awake:boolean, quietSince:number, last:number}>} */
const entries = new Set();
let raf = 0;
let timer = 0;
let probeTimer = 0;
let lastRun = 0;
let observing = false;
const stats = { frames: 0, rafs: 0, probes: 0, wakes: 0 };

const doc = () => (typeof document !== 'undefined' ? document : null);
/** True while meters must neither animate nor read: low-resource, hidden window or hidden document. */
export function meterBlocked() {
  const d = doc();
  if (!d) return true;
  const r = d.documentElement;
  return r.hasAttribute('data-low-resource') || r.hasAttribute('data-window-hidden') || d.visibilityState === 'hidden';
}

const awakeVisible = () => {
  for (const e of entries) if (e.visible && e.awake) return true;
  return false;
};

function cancel() {
  if (raf) cancelAnimationFrame(raf);
  clearTimeout(timer);
  clearTimeout(probeTimer);
  raf = 0;
  timer = 0;
  probeTimer = 0;
  lastRun = 0;
}

function armProbe() {
  if (probeTimer || meterBlocked()) return;
  let any = false;
  for (const e of entries) if (e.visible && e.c.probe) any = true;
  if (any) probeTimer = setTimeout(probeRun, PROBE_MS);
}

function probeRun() {
  probeTimer = 0;
  if (meterBlocked() || awakeVisible()) return;
  stats.probes++;
  for (const e of entries) {
    if (!e.visible || !e.c.probe) continue;
    let loud = false;
    try {
      loud = !!e.c.probe();
    } catch {
      loud = false;
    }
    if (loud) {
      wakeMeters();
      return;
    }
  }
  armProbe();
}

function schedule() {
  if (raf || timer) return;
  if (meterBlocked() || !awakeVisible()) {
    lastRun = 0;
    armProbe();
    return;
  }
  clearTimeout(probeTimer);
  probeTimer = 0;
  const wait = lastRun ? FRAME_MS - SLACK_MS - (performance.now() - lastRun) : 0;
  if (wait > 1) {
    timer = setTimeout(() => {
      timer = 0;
      raf = requestAnimationFrame(meterFrame);
    }, wait);
  } else raf = requestAnimationFrame(meterFrame);
}

/**
 * The shared rAF callback (named: tests count it). Every callback is a frame: the timer in schedule() already spaced
 * it ≥ FRAME_MS − SLACK_MS from the last one (performance.now(), not the rAF timestamp: under load a late frame runs
 * with an old vsync timestamp, and an "early" check on it re-requested ~14 extra frames/s).
 */
function meterFrame() {
  raf = 0;
  stats.rafs++;
  if (meterBlocked()) {
    lastRun = 0;
    return;
  }
  const now = performance.now();
  lastRun = now;
  stats.frames++;
  for (const e of entries) {
    if (!e.visible || !e.awake) continue;
    // dt since THIS meter's last update, not the loop's: a meter coming back from a hidden view / low-resource / a
    // hidden window must release to the current level at once, not replay a stale bar at 20 dB/s (idle-cpu-ui critic)
    const dt = e.last ? Math.min(MAX_DT_MS, now - e.last) : FRAME_MS;
    e.last = now;
    let loud = true;
    try {
      loud = !!e.c.tick(now, dt);
    } catch {
      loud = false;
    }
    if (loud) e.quietSince = 0;
    else if (!e.quietSince) e.quietSince = now;
    else if (now - e.quietSince >= SILENT_MS) {
      e.awake = false;
      e.quietSince = 0;
    }
  }
  schedule();
}

function observeGates() {
  if (observing) return;
  const d = doc();
  if (!d) return;
  observing = true;
  const onGate = () => {
    if (meterBlocked()) cancel();
    else wakeMeters();
  };
  if (typeof MutationObserver === 'function') {
    new MutationObserver(onGate).observe(d.documentElement, { attributes: true,
      attributeFilter: ['data-low-resource', 'data-window-hidden'] });
  }
  d.addEventListener('visibilitychange', onGate);
}

/**
 * Wake every meter (the controller's 'activity' signal: a note, any input, a drone / master / song change, …).
 * Cheap when they are already awake.
 */
export function wakeMeters() {
  stats.wakes++;
  for (const e of entries) {
    e.awake = true;
    e.quietSince = 0;
  }
  schedule();
}

/**
 * Register a meter with the shared loop. It starts awake and invisible; call setVisible(true) when it is on screen.
 * @param {MeterClient} c
 * @returns {{setVisible(v:boolean):void, wake():void, remove():void, readonly awake:boolean, readonly visible:boolean}}
 */
export function addMeter(c) {
  observeGates();
  const e = { c, visible: false, awake: true, quietSince: 0, last: 0 };
  entries.add(e);
  return {
    setVisible(v) {
      v = !!v;
      if (v === e.visible) return;
      e.visible = v;
      if (v) {
        e.awake = true; // coming on screen: show the current level at once
        e.quietSince = 0;
        schedule();
      } else if (!awakeVisible()) {
        if (raf) cancelAnimationFrame(raf);
        clearTimeout(timer);
        raf = 0;
        timer = 0;
        lastRun = 0;
        schedule(); // re-arms the probe if a probing meter is still visible
      }
    },
    wake() {
      e.awake = true;
      e.quietSince = 0;
      schedule();
    },
    remove() {
      entries.delete(e);
      if (!awakeVisible()) {
        if (raf) cancelAnimationFrame(raf);
        clearTimeout(timer);
        raf = 0;
        timer = 0;
        lastRun = 0;
      }
    },
    get awake() {
      return e.awake;
    },
    get visible() {
      return e.visible;
    },
  };
}

/**
 * Test / debugging hook: registered meters by state, whether a frame is pending, and counters since load
 * (frames = updates run, rafs = rAF callbacks, probes = safety probes, wakes = wakeMeters calls).
 */
export function meterClockStats() {
  const by = { meters: 0, visible: 0, awake: 0, level: { visible: 0, awake: 0 } };
  for (const e of entries) {
    by.meters++;
    if (e.visible) by.visible++;
    if (e.visible && e.awake) by.awake++;
    if (e.c.kind === 'level') {
      if (e.visible) by.level.visible++;
      if (e.visible && e.awake) by.level.awake++;
    }
  }
  return { ...by, scheduled: !!(raf || timer), probing: !!probeTimer, blocked: meterBlocked(), ...stats };
}
