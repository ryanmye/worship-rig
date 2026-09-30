// lowres2 critic: adversarial cases for the frozen drone and audio sleep (reviews/lowres2-critic.md). Run with
// `node test/phase1/engine/critic-run.mjs [name]` (one headless Chromium page per case, serially).
import { AudioEngine } from '/js/engine/index.js';

const MANIFEST = '/__fixtures/manifest.json';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const until = async (fn, ms, step = 20) => {
  const t0 = performance.now();
  while (!fn() && performance.now() - t0 < ms) await wait(step);
  return Math.round(performance.now() - t0);
};
function slot(type, id, extra = {}) {
  return { instrument: { type, id }, gain: 1, sends: { reverb: 0, delay: 0, chorus: 0 }, ...extra };
}
function patch(slots, fx = {}) {
  const s = [null, null, null, null];
  for (const [i, v] of Object.entries(slots)) s[i] = v;
  return { slots: s, fx };
}
async function use(engine, p) {
  const tok = await engine.prepare(p);
  if (!engine.commit(tok, { when: 0 })) throw new Error('commit refused');
}
// same detector as suites.mjs clicks() (6 × local median and 4.5 × local RMS of the first difference)
function clicks(d, sr, a, b, floor = 1e-3) {
  const i0 = Math.max(2, Math.floor(a * sr));
  const i1 = Math.min(d.length, Math.floor(b * sr));
  const n = i1 - i0;
  if (n <= 0) return [];
  const h = new Float32Array(n);
  for (let i = 0; i < n; i++) h[i] = Math.abs(d[i0 + i] - d[i0 + i - 1]);
  const B = 256;
  const nb = Math.ceil(n / B);
  const med = new Float64Array(nb);
  const ms = new Float64Array(nb);
  for (let bi = 0; bi < nb; bi++) {
    const seg = Array.from(h.subarray(bi * B, Math.min(n, (bi + 1) * B)));
    let q = 0;
    for (const v of seg) q += v * v;
    seg.sort((x, y) => x - y);
    med[bi] = seg[seg.length >> 1] || 0;
    ms[bi] = seg.length ? q / seg.length : 0;
  }
  const found = [];
  for (let i = 0; i < n; i++) {
    const bi = Math.floor(i / B);
    const lo = Math.max(0, bi - 4);
    const hi = Math.min(nb - 1, bi + 4);
    const cand = Array.from(med.subarray(lo, hi + 1)).sort((x, y) => x - y);
    const lm = cand[cand.length >> 1];
    let q = 0;
    for (let k = lo; k <= hi; k++) q += ms[k];
    const lr = Math.sqrt(q / (hi - lo + 1));
    if (h[i] > floor && h[i] > 6 * lm && h[i] > 4.5 * lr) {
      found.push(+((i0 + i) / sr).toFixed(3));
      i += B;
    }
  }
  return found;
}
function rmsDb(d, sr, a, b) {
  const i0 = Math.max(0, Math.floor(a * sr));
  const i1 = Math.min(d.length, Math.floor(b * sr));
  let s = 0;
  for (let i = i0; i < i1; i++) s += d[i] * d[i];
  return +db(Math.sqrt(s / Math.max(1, i1 - i0))).toFixed(2);
}
/** min / max 50 ms-window RMS (dB) over [a, b]. */
function windowRange(d, sr, a, b, win = 0.05) {
  let mn = Infinity;
  let mx = -Infinity;
  for (let t = a; t + win <= b; t += win) {
    const v = rmsDb(d, sr, t, t + win);
    mn = Math.min(mn, v);
    mx = Math.max(mx, v);
  }
  return { min: +mn.toFixed(2), max: +mx.toFixed(2) };
}
/** Stereo power (dB, (L² + R²) / 2) over [a, b] s of a capture. */
function stereoDb(c, sr, a, b) {
  const i0 = Math.max(0, Math.floor(a * sr));
  const i1 = Math.min(c.L.length, Math.floor(b * sr));
  let s = 0;
  for (let i = i0; i < i1; i++) s += 0.5 * (c.L[i] * c.L[i] + c.R[i] * c.R[i]);
  return +(10 * Math.log10(s / Math.max(1, i1 - i0) + 1e-30)).toFixed(2);
}
/** L/R correlation coefficient over [a, b]. */
function lrCorr(c, sr, a, b) {
  const i0 = Math.max(0, Math.floor(a * sr));
  const i1 = Math.min(c.L.length, Math.floor(b * sr));
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = i0; i < i1; i++) {
    lr += c.L[i] * c.R[i];
    ll += c.L[i] * c.L[i];
    rr += c.R[i] * c.R[i];
  }
  return +(lr / Math.sqrt(ll * rr + 1e-30)).toFixed(3);
}
/** Clicks of a capture, leaving out the capture's own gaps (±12 ms). */
function capClicks(c, sr, a, b, floor) {
  return clicks(c.d, sr, a, b, floor).filter((t) => !c.gapAt.some((g) => Math.abs(t - g) < 0.012));
}
/** 50 ms window range of a capture's stereo power, skipping windows that touch a gap. */
function capRange(c, sr, a, b, win = 0.05) {
  let mn = Infinity;
  let mx = -Infinity;
  let at = null;
  for (let t = a; t + win <= b; t += win) {
    if (c.gapAt.some((g) => g > t - 0.01 && g < t + win + 0.01)) continue;
    const v = stereoDb(c, sr, t, t + win);
    if (v < mn) {
      mn = v;
      at = +t.toFixed(2);
    }
    mx = Math.max(mx, v);
  }
  return { min: +mn.toFixed(2), max: +mx.toFixed(2), minAt: at };
}
/** Gap-free capture of recordTap (AudioWorklet, frame-stamped blocks; as suites.mjs captureTapExact). */
async function capture(engine, seconds) {
  const ctx = engine.ctx;
  if (!ctx.__criticCap) {
    const CAP = `class CriticCap extends AudioWorkletProcessor {
      constructor() { super(); this.on = true; this.port.onmessage = () => { this.on = false; }; }
      process(inputs) {
        if (!this.on) return false;
        const i = inputs[0];
        const l = new Float32Array(128);
        const r = new Float32Array(128);
        if (i && i.length) { l.set(i[0]); r.set(i[1] || i[0]); }
        this.port.postMessage({ f: currentFrame, l, r }, [l.buffer, r.buffer]);
        return true;
      }
    }
    registerProcessor('critic-cap', CriticCap);`;
    ctx.__criticCap = ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([CAP], { type: 'text/javascript' })));
  }
  await ctx.__criticCap;
  const node = new AudioWorkletNode(ctx, 'critic-cap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const blocks = [];
  const need = Math.ceil((seconds * ctx.sampleRate) / 128);
  return new Promise((resolve) => {
    node.port.onmessage = (ev) => {
      blocks.push(ev.data);
      if (blocks.length < need) return;
      node.port.onmessage = null;
      node.port.postMessage('stop');
      engine.recordTap.disconnect(node);
      node.disconnect();
      const f0 = blocks[0].f;
      const len = blocks[blocks.length - 1].f + 128 - f0;
      const L = new Float32Array(len);
      const R = new Float32Array(len);
      let gaps = 0;
      const gapAt = [];
      blocks.forEach((b, k) => {
        L.set(b.l, b.f - f0);
        R.set(b.r, b.f - f0);
        if (k && b.f !== blocks[k - 1].f + 128) {
          gaps++;
          gapAt.push(+((blocks[k - 1].f + 128 - f0) / ctx.sampleRate).toFixed(4), +((b.f - f0) / ctx.sampleRate).toFixed(4));
        }
      });
      const d = new Float32Array(len);
      for (let i = 0; i < len; i++) d[i] = 0.5 * (L[i] + R[i]);
      resolve({ d, L, R, t0: f0 / ctx.sampleRate, gaps, gapAt });
    };
    engine.recordTap.connect(node);
    node.connect(ctx.destination);
  });
}
/** Count OfflineAudioContext renders started / running at once (the freeze renders). */
function renderMeter() {
  const P = OfflineAudioContext.prototype;
  if (!P.__criticOrig) P.__criticOrig = P.startRendering;
  const m = { started: 0, running: 0, maxRunning: 0 };
  P.startRendering = function () {
    m.started++;
    m.running++;
    m.maxRunning = Math.max(m.maxRunning, m.running);
    const p = P.__criticOrig.call(this);
    p.finally(() => m.running--);
    return p;
  };
  m.restore = () => {
    P.startRendering = P.__criticOrig;
  };
  return m;
}
function droneState(e) {
  const d = e.drone;
  return {
    frozen: !!d.frozen, frozenPc: d.frozen ? d.frozen.sig.pc : null, fzOut: d._fzOut.length,
    layers: d.layers.filter((L) => !L.dead).length, layersAll: d.layers.length, voices: d.liveVoiceCount(),
    sendGate: +d.sendGate.gain.value.toFixed(3), sendMuted: d._sendMuted, pending: !!d._fz.pendingSig,
    rendering: d._fz.rendering, sounding: d.sounding, eff: d.effectiveMode, renders: d._fz.renders,
    mb: e._debugStats().droneFreezeMB,
  };
}
async function frozenEngine(seed, { loopSec = 4, prerollSec = 3.5, key = 2, slots = {}, modules = false } = {}) {
  const e = new AudioEngine({ seed, manifestUrl: MANIFEST, instrumentModules: modules });
  await e.start();
  await use(e, patch(slots, { reverb: { size: 0.1 } }));
  e._setDroneFreezeOptions({ loopSec, prerollSec });
  e.drone.configure({ mode: 'synth', gain: 0.5, fade: 0.3 });
  e.drone.setKey(key);
  await wait(3000);
  return e;
}
const stable = (e) => {
  const d = e.drone;
  return !d._fzOut.length && !d.layers.some((L) => L.dead) && !d._fz.pendingSig && !d._fz.rendering;
};

/** Main-thread long tasks (PerformanceObserver 'longtask', ≥ 50 ms) and a rAF-gap meter for shorter stalls. */
function stallMeter() {
  const m = { longTasks: [], maxGapMs: 0, on: true };
  try {
    m.obs = new PerformanceObserver((l) => {
      for (const x of l.getEntries()) m.longTasks.push(Math.round(x.duration));
    });
    m.obs.observe({ type: 'longtask', buffered: false });
  } catch {}
  // a 4 ms timer chain: the largest lateness of a timer ≈ the longest main-thread task (≤ 1–2 ms of timer slop)
  const STEP = 4;
  let last = performance.now();
  const tickFn = () => {
    const now = performance.now();
    m.maxGapMs = Math.max(m.maxGapMs, now - last - STEP);
    last = now;
    if (m.on) setTimeout(tickFn, STEP);
  };
  m.reset = () => {
    m.longTasks.length = 0;
    m.maxGapMs = 0;
    last = performance.now();
  };
  m.stop = () => {
    m.on = false;
    m.obs?.disconnect();
  };
  setTimeout(tickFn, STEP);
  return m;
}

export const critic = {
  // lowres2-scope R1: live ↔ frozen level through the swap, many cycles, with the real drone-osc (synth.js,
  // `modules`) and the fallback one. 100 ms windows of stereo power vs the steady level before the action.
  async r1Swap() {
    const out = {};
    for (const modules of [true, false]) {
      const label = modules ? 'real' : 'fallback';
      const res = { liveToFrozen: [], thaw: [] };
      const e = await frozenEngine(modules ? 71 : 65, { key: 4, modules });
      await wait(modules ? 1000 : 0); // synth.js drone-osc attack 2.5 s
      const sr = e.ctx.sampleRate;
      e._setDroneFreezeOptions({ debounceSec: 0 });
      const res0 = res;
      res0.controlLive = [];
      res0.controlFrozen = [];
      // control: the same statistic on a steady stretch with no action (the drone's own 100 ms window spread)
      const control = async (list) => {
        const c = await capture(e, 8);
        const steady = stereoDb(c, sr, 0.05, 1.45);
        const rg = capRange(c, sr, 1.5, 7.9, 0.1);
        list.push({ dipDb: +(rg.min - steady).toFixed(2), bumpDb: +(rg.max - steady).toFixed(2), gaps: c.gaps });
      };
      const run = async (list, act, isDone) => {
        const cp = capture(e, 8);
        await wait(1500);
        const tAct = e.ctx.currentTime;
        await act();
        const c = await cp;
        const a = tAct - c.t0;
        const steady = stereoDb(c, sr, 0.05, Math.max(0.5, a - 0.05));
        const rg = capRange(c, sr, a, 7.9, 0.1);
        list.push({ dipDb: +(rg.min - steady).toFixed(2), bumpDb: +(rg.max - steady).toFixed(2), minAt: +(rg.minAt - a).toFixed(2), gaps: c.gaps });
        await until(isDone, 30000, 50);
        await wait(1000);
      };
      for (let k = 0; k < 4; k++) {
        await wait(3000); // the live voices settle
        await control(res.controlLive);
        await run(res.liveToFrozen, async () => e.setLowResource(true), () => !!e.drone.frozen && stable(e));
        await control(res.controlFrozen);
        await run(res.thaw, async () => e.setLowResource(false), () => !e.drone.frozen && stable(e));
      }
      e.dispose();
      const worst = (xs) => ({ dip: Math.min(...xs.map((x) => x.dipDb)), bump: Math.max(...xs.map((x) => x.bumpDb)) });
      out[label] = {
        worst: {
          liveToFrozen: worst(res.liveToFrozen), thaw: worst(res.thaw), controlLive: worst(res.controlLive),
          controlFrozen: worst(res.controlFrozen),
        },
        ...res,
      };
    }
    // a swap must not dip more than 3 dB beyond the drone's own spread (the worse of the live / frozen controls)
    const beyond = (w) => Math.min(w.liveToFrozen.dip, w.thaw.dip) - Math.min(w.controlLive.dip, w.controlFrozen.dip);
    for (const l of ['real', 'fallback']) out[l].worst.swapBeyondControlDb = +beyond(out[l].worst).toFixed(2);
    const pass = ['real', 'fallback'].every((l) => out[l].worst.swapBeyondControlDb >= -3);
    return { pass, ...out };
  },

  // lowres2-scope R4: the longest main-thread task per render (default 20 s loop), real and fallback drone-osc
  async r4Stall() {
    const out = {};
    for (const modules of [true, false]) {
      const label = modules ? 'real' : 'fallback';
      const e = await frozenEngine(modules ? 73 : 59, { loopSec: 20, prerollSec: undefined, modules });
      e._setDroneFreezeOptions({ debounceSec: 0 });
      e.setLowResource(true);
      await until(() => !!e.drone.frozen && stable(e), 60000, 50);
      await wait(1000);
      const m = stallMeter();
      const rounds = [];
      for (let k = 0; k < 4; k++) {
        await wait(1500);
        m.reset();
        const r0 = e.drone._fz.renders;
        e.setParam('drone.brightness', k % 2 ? 0.5 : 0.56);
        await until(() => e.drone._fz.renders > r0, 60000, 10);
        await wait(300);
        const s = e.drone._fz.lastStats || {};
        rounds.push({ maxTaskMs: +m.maxGapMs.toFixed(1), longTasks: m.longTasks.slice(), renderMs: e.drone._fz.lastRenderMs, ...s });
        await wait(1600);
      }
      m.reset();
      await wait(3000);
      const idleMaxMs = +m.maxGapMs.toFixed(1);
      m.stop();
      e.dispose();
      const steps = rounds.map((r) => r.maxStepMs).sort((a, b) => a - b);
      out[label] = {
        maxTaskMs: Math.max(...rounds.map((r) => r.maxTaskMs)), idleMaxMs, medianMaxStepMs: steps[steps.length >> 1],
        rounds,
      };
    }
    // the render's own main-thread steps (wall clock; a loaded shared box stretches them); the timer lateness also
    // holds Chromium's GC after a render (freeing the offline graph and its 12 MB render buffer), reported only
    const pass = out.real.medianMaxStepMs <= 20 && out.fallback.medianMaxStepMs <= 20;
    return { pass, ...out };
  },

  // (1) key change (A → B) during a crossfade: live → frozen, frozen → frozen, frozen → live (thaw), and while a
  // render is in flight. Reference: the same A → B change on the live drone. Dip / bump are measured against
  // min / max of the steady levels before (key A) and after (key B), 100 ms windows; swaps are logged (a stale render
  // must never be swapped in).
  async keyDuringCrossfade() {
    const out = {};
    const A = 2;
    const B = 7;
    const e = await frozenEngine(51, { key: A });
    const sr = e.ctx.sampleRate;
    e._setDroneFreezeOptions({ debounceSec: 0.5 });
    const swaps = [];
    const origSwap = e.drone._freezeSwap.bind(e.drone);
    e.drone._freezeSwap = (res, sig, t) => {
      swaps.push({ pc: sig.pc, key: e.drone.key.pc });
      return origSwap(res, sig, t);
    };
    const settle = async (frozen) => {
      await until(() => stable(e) && !!e.drone.frozen === frozen && e.drone.liveVoiceCount() === (frozen ? 0 : e.drone.liveVoiceCount()), 30000, 50);
      await wait(frozen ? 800 : 3000);
    };
    const toA = async (lowRes) => {
      if (e.lowResource !== lowRes) e.setLowResource(lowRes);
      e.drone.setKey(A);
      await settle(lowRes);
    };
    const scen = async (label, lowRes, arm, settleFrozen) => {
      await toA(lowRes);
      const r = {};
      const nSw = swaps.length;
      await arm();
      const cp = capture(e, 9);
      await wait(1000);
      e.drone.setKey(B);
      const c = await cp;
      r.gaps = c.gaps;
      r.beforeDb = stereoDb(c, sr, 0.05, 0.95);
      r.clicks = capClicks(c, sr, 0.01, 8.99);
      await settle(settleFrozen);
      r.after = droneState(e);
      const c2 = await capture(e, 4);
      r.afterDb = stereoDb(c2, sr, 0, 4);
      const rg = capRange(c, sr, 1.0, 8.9, 0.1);
      r.dipDb = +(rg.min - Math.min(r.beforeDb, r.afterDb)).toFixed(2);
      r.bumpDb = +(rg.max - Math.max(r.beforeDb, r.afterDb)).toFixed(2);
      r.minAt = rg.minAt;
      r.swaps = swaps.slice(nSw).map((x) => `${x.pc}@key${x.key}`);
      r.staleSwaps = swaps.slice(nSw).filter((x) => x.pc !== x.key).length;
      r.structOk = r.after.fzOut === 0 && r.after.frozen === settleFrozen && r.staleSwaps === 0 &&
        (settleFrozen ? r.after.voices === 0 && r.after.layers === 0 && r.after.frozenPc === B && r.after.sendGate < 0.01
          : r.after.voices > 0 && r.after.layers === 1 && r.after.sendGate > 0.39);
      out[label] = r;
    };
    await scen('controlLive', false, async () => {}, false);
    await scen('liveToFrozen', false, async () => {
      e.setLowResource(true);
      await until(() => !!e.drone.frozen, 30000, 5); // the swap has started; the key change lands 1 s into it
    }, true);
    await scen('frozenToFrozen', true, async () => {
      const r0 = e.drone._fz.renders;
      e.setParam('drone.brightness', e.drone.p.brightness > 0.52 ? 0.5 : 0.55);
      await until(() => e.drone._fz.renders > r0, 30000, 5);
    }, true);
    await scen('thaw', true, async () => {
      e.setLowResource(false);
    }, false);
    await scen('renderInFlight', true, async () => {
      e.setParam('drone.brightness', e.drone.p.brightness > 0.52 ? 0.5 : 0.55);
      await until(() => e.drone._fz.rendering, 5000, 2); // capture starts; the render (≈ 0.5 s) is still running…
    }, true);
    e.dispose();
    const ctl = out.controlLive;
    const keys = ['liveToFrozen', 'frozenToFrozen', 'thaw', 'renderInFlight'];
    for (const k of keys) {
      const r = out[k];
      r.ok = r.structOk && r.clicks.length <= Math.max(1, ctl.clicks.length) && r.dipDb >= ctl.dipDb - 6 && r.bumpDb <= Math.max(ctl.bumpDb, 0) + 3.5; // live ↔ loop beating: review #3
    }
    return { pass: keys.every((k) => out[k].ok), ...out };
  },

  // level through the swaps themselves, same key (nothing else changes): live → frozen, frozen → frozen (a re-render
  // for a tiny brightness change: two nearly identical loops) and frozen → live. 100 ms windows of stereo power vs
  // the steady level before; a drone crossfaded with a copy of itself at a random time offset beats (coherent sum).
  async swapLevel() {
    const out = { liveToFrozen: [], frozenToFrozen: [], frozenMove: [], frozenWidth: [], thaw: [] };
    const e = await frozenEngine(65, { key: 4 });
    const sr = e.ctx.sampleRate;
    e._setDroneFreezeOptions({ debounceSec: 0 });
    const run = async (label, act, isDone) => {
      const cp = capture(e, 7);
      await wait(1500);
      const tAct = e.ctx.currentTime;
      await act();
      const c = await cp;
      const a = tAct - c.t0;
      const steady = stereoDb(c, sr, 0.05, Math.max(0.5, a - 0.05));
      const rg = capRange(c, sr, a, 6.9, 0.1);
      const end = stereoDb(c, sr, 6.0, 6.95);
      out[label].push({ steadyDb: steady, dipDb: +(rg.min - steady).toFixed(2), bumpDb: +(rg.max - steady).toFixed(2), endDb: +(end - steady).toFixed(2), minAt: +(rg.minAt - a).toFixed(2), gaps: c.gaps });
      await until(isDone, 30000, 50);
      await wait(1500);
    };
    let bright = 0.5;
    for (let k = 0; k < 3; k++) {
      await run('liveToFrozen', async () => e.setLowResource(true), () => !!e.drone.frozen && stable(e));
      for (let j = 0; j < 2; j++) {
        bright = bright === 0.5 ? 0.505 : 0.5;
        const r0 = e.drone._fz.renders;
        await run('frozenToFrozen', async () => e.setParam('drone.brightness', bright), () => e.drone._fz.renders > r0 && stable(e));
      }
      {
        const r0 = e.drone._fz.renders;
        await run('frozenMove', async () => e.setParam('drone.movement', k % 2 ? 0.3 : 0.4), () => e.drone._fz.renders > r0 && stable(e));
      }
      {
        const r0 = e.drone._fz.renders;
        await run('frozenWidth', async () => e.setParam('drone.width', k % 2 ? 0.7 : 0.5), () => e.drone._fz.renders > r0 && stable(e));
      }
      await run('thaw', async () => e.setLowResource(false), () => !e.drone.frozen && stable(e));
      await wait(1500);
    }
    e.dispose();
    const worst = (xs) => ({ dip: Math.min(...xs.map((x) => x.dipDb)), bump: Math.max(...xs.map((x) => x.bumpDb)) });
    out.worst = {};
    for (const k of ['liveToFrozen', 'frozenToFrozen', 'frozenMove', 'frozenWidth', 'thaw']) out.worst[k] = worst(out[k]);
    // live ↔ frozen swaps beat (a fresh live layer vs the loop at an arbitrary phase): reported, review #3
    const pass = ['frozenToFrozen', 'frozenMove', 'frozenWidth'].every((k) => out.worst[k].dip >= -3 && out.worst[k].bump <= 2);
    return { pass, ...out };
  },

  // frozen level vs live, same key: stereo power and L/R correlation over whole loops (4 s and the default 20 s)
  async levelMatch() {
    const out = {};
    for (const loopSec of [4, 20]) {
      const e = await frozenEngine(63, { loopSec, prerollSec: loopSec === 4 ? 3.5 : undefined });
      const sr = e.ctx.sampleRate;
      await wait(1500);
      const W = Math.min(loopSec, 8);
      const live = [];
      for (let k = 0; k < 2; k++) {
        const c = await capture(e, W);
        live.push({ db: stereoDb(c, sr, 0, W), monoDb: rmsDb(c.d, sr, 0, W), corr: lrCorr(c, sr, 0, W), gaps: c.gaps });
      }
      e.setLowResource(true);
      await until(() => !!e.drone.frozen && stable(e), 60000, 50);
      await wait(1000);
      const frozen = [];
      for (let k = 0; k < 2; k++) {
        const c = await capture(e, W);
        frozen.push({ db: stereoDb(c, sr, 0, W), monoDb: rmsDb(c.d, sr, 0, W), corr: lrCorr(c, sr, 0, W), gaps: c.gaps });
      }
      const b = e.drone.frozen.src.buffer;
      const bc = { L: b.getChannelData(0), R: b.getChannelData(1) };
      const avg = (xs, k) => +(xs.reduce((s, x) => s + x[k], 0) / xs.length).toFixed(2);
      out[`loop${loopSec}`] = {
        live, frozen, loopBufCorr: lrCorr(bc, sr, 0, loopSec),
        stereoDiffDb: +(avg(frozen, 'db') - avg(live, 'db')).toFixed(2), monoDiffDb: +(avg(frozen, 'monoDb') - avg(live, 'monoDb')).toFixed(2),
        corrLive: avg(live, 'corr'), corrFrozen: avg(frozen, 'corr'),
      };
      e.dispose();
    }
    const pass = [4, 20].every((l) => Math.abs(out[`loop${l}`].stereoDiffDb) <= 1 && Math.abs(out[`loop${l}`].monoDiffDb) <= 1.5);
    return { pass, ...out };
  },

  // (2) low-resource toggled on/off 5 times in 3 s: no stuck buffers, no double drone, live voice count restored
  async rapidToggle() {
    const out = {};
    const meter = renderMeter();
    const e = await frozenEngine(53);
    const sr = e.ctx.sampleRate;
    out.liveVoices = e.drone.liveVoiceCount();
    out.liveDb = stereoDb(await capture(e, 4), sr, 0, 4);
    const s0 = meter.started;
    for (let i = 0; i < 5; i++) {
      e.setLowResource(true);
      await wait(300);
      e.setLowResource(false);
      await wait(300);
    }
    out.rendersStartedOffEnd = meter.started - s0;
    out.maxConcurrentRenders = meter.maxRunning;
    out.offSettleMs = await until(() => stable(e) && !e.drone.frozen && meter.running === 0, 60000, 50);
    await wait(1500);
    out.offState = droneState(e);
    out.offDb = stereoDb(await capture(e, 4), sr, 0, 4);
    // same, ending on (frozen); the level through the toggles (a double drone reads ≥ +3 dB)
    const s1 = meter.started;
    const cp = capture(e, 9);
    for (let i = 0; i < 5; i++) {
      e.setLowResource(true);
      await wait(300);
      if (i < 4) {
        e.setLowResource(false);
        await wait(300);
      }
    }
    const ct = await cp;
    out.toggleRange = capRange(ct, sr, 0.05, 8.9, 0.25);
    out.toggleClicks = capClicks(ct, sr, 0.01, 8.99).length;
    out.rendersStartedOnEnd = meter.started - s1;
    out.onSettleMs = await until(() => stable(e) && !!e.drone.frozen && meter.running === 0, 60000, 50);
    await wait(500);
    out.onState = droneState(e);
    out.onDb = stereoDb(await capture(e, 4), sr, 0, 4);
    // and back off: the live count comes back
    e.setLowResource(false);
    await until(() => stable(e) && !e.drone.frozen, 20000, 50);
    await wait(1500);
    out.finalState = droneState(e);
    out.finalDb = stereoDb(await capture(e, 4), sr, 0, 4);
    out.maxConcurrentRendersTotal = meter.maxRunning;
    meter.restore();
    e.dispose();
    const pass = out.offState.fzOut === 0 && !out.offState.frozen && out.offState.voices === out.liveVoices &&
      out.offState.layers === 1 && out.onState.frozen && out.onState.fzOut === 0 && out.onState.voices === 0 &&
      out.onState.layers === 0 && out.finalState.voices === out.liveVoices && out.finalState.layers === 1 &&
      Math.abs(out.offDb - out.liveDb) <= 2 && Math.abs(out.onDb - out.liveDb) <= 2 && Math.abs(out.finalDb - out.liveDb) <= 2 &&
      out.toggleRange.max - out.liveDb <= 2.5;
    return { pass, ...out };
  },

  // (3) a song switch while frozen, the way controller.applyDrone does it (setKey, then configure(song.drone)):
  // synth in another key → frozen in the new key; drone off → the loop stops; files → loop stops, files play;
  // continueAcrossSongs false → songChanged fades it, the new song's drone freezes again
  async songSwitch() {
    const out = {};
    const e = await frozenEngine(55);
    e.drone.attachFiles([
      { name: 'Test Pad - C.wav', url: '/__fixtures/pads/Test%20Pad%20-%20C.wav' },
      { name: 'Test Pad - G.wav', url: '/__fixtures/pads/Test%20Pad%20-%20G.wav' },
    ]);
    e.setLowResource(true);
    await until(() => !!e.drone.frozen && stable(e), 30000);
    const song = (key, d) => {
      e.drone.setKey(key);
      e.drone.configure({ fade: 0.3, gain: 0.5, chordFollow: false, continueAcrossSongs: true, ...d });
    };
    // synth, new key
    song(7, { mode: 'synth' });
    await until(() => stable(e) && e.drone.frozen?.sig.pc === 7, 30000, 50);
    out.synthNewKey = droneState(e);
    // drone off
    song(9, { mode: 'off' });
    await until(() => stable(e) && !e.drone.frozen, 20000, 50);
    await wait(2500);
    out.off = droneState(e);
    // files mode (C)
    song(0, { mode: 'synth' });
    await until(() => stable(e) && e.drone.frozen?.sig.pc === 0, 30000, 50);
    song(7, { mode: 'files' });
    await wait(4000);
    out.files = { ...droneState(e), audibleEls: e.drone.pool ? e.drone.pool.filter((x) => !x.el.paused && x.gain.gain.value > 0.01).length : 0 };
    out.filesPlayable = e.drone.effectiveMode === 'files';
    // back to synth with continueAcrossSongs false (songChanged fades, then configure starts it)
    song(2, { mode: 'synth' });
    await until(() => stable(e) && e.drone.frozen?.sig.pc === 2, 30000, 50);
    e.drone.configure({ continueAcrossSongs: false });
    e.drone.songChanged();
    song(4, { mode: 'synth', continueAcrossSongs: false });
    await until(() => stable(e) && e.drone.frozen?.sig.pc === 4, 30000, 50);
    out.noContinue = droneState(e);
    e.dispose();
    const pass = out.synthNewKey.frozen && out.synthNewKey.voices === 0 && out.synthNewKey.fzOut === 0 &&
      !out.off.frozen && out.off.voices === 0 && out.off.fzOut === 0 && !out.off.pending && !out.off.sounding &&
      !out.files.frozen && out.files.fzOut === 0 && (out.filesPlayable ? out.files.voices === 0 && out.files.audibleEls >= 1 : true) &&
      out.noContinue.frozen && out.noContinue.frozenPc === 4 && out.noContinue.voices === 0 && out.noContinue.fzOut === 0;
    return { pass, ...out };
  },

  // (4)–(7): audio sleep through the real controller (audioSleepSec 2)
  async sleepInputs() {
    const { createController } = await import('/js/controller.js');
    const { createStore, memoryStorage } = await import('/js/store.js');
    const { MidiInput } = await import('/js/midi.js');
    const { createBus } = await import('/js/shared/bus.js');
    const e = new AudioEngine({ seed: 57, manifestUrl: MANIFEST, instrumentModules: false });
    await e.start();
    await use(e, patch({ 0: slot('sampler', 'test-keys', { sustain: true }) }));
    const sr = e.ctx.sampleRate;
    const store = createStore({ storage: memoryStorage(), seed: false, requestIdle: null, warn: () => {} });
    store.set('settings.audioSleepSec', 2);
    const midi = new MidiInput({ nav: null, warn: () => {} });
    const recorder = Object.assign(new EventTarget(), {
      isRecording: false,
      async toggle() {
        this.isRecording = !this.isRecording;
        this.dispatchEvent(new CustomEvent('state', { detail: { state: this.isRecording ? 'recording' : 'idle' } }));
        return this.isRecording;
      },
    });
    const ctl = createController({
      store, engine: e, midi, recorder, doc: document, win: window, nav: null, rig: null, locks: null,
      heartbeat: false, indexedDB: null, watchdogMs: 200, autoRestart: false,
    });
    await ctl.start();
    const mini = createBus({ role: 'mini', hello: false });
    const asleep = () => e.sleepState === 'asleep';
    const out = {};
    // (4) pedal held with no notes: must not sleep; released: sleeps ≈ 2 s later
    await until(asleep, 9000);
    midi._inject([0xb0, 64, 127]);
    await until(() => e.sleepState === 'awake', 2000);
    await wait(4500);
    out.pedalHeldStayedAwake = e.sleepState === 'awake';
    out.pedalHeldBlockers = e.sleepBlockers();
    if (!out.pedalHeldStayedAwake) await until(() => e.sleepState === 'awake', 3000);
    const tRel = performance.now();
    midi._inject([0xb0, 64, 0]);
    await until(() => e.sleepState === 'awake', 2000);
    await until(asleep, 9000);
    out.sleptAfterReleaseMs = Math.round(performance.now() - tRel);
    out.pedalOk = out.pedalHeldStayedAwake && out.sleptAfterReleaseMs >= 1800 && out.sleptAfterReleaseMs <= 4500;
    // (5) a note 1 ms after sleep, three moments: during the 150 ms ramp, while ctx.suspend() is pending, right
    // after 'asleep'. engine.sleep() is called directly (controller sleep off meanwhile, so only this sleep runs); the
    // note comes through MIDI → controller. runMs = wall time until the context runs again; onsetCtxMs = context
    // time from the message to the note's onset (the capture runs through the suspend).
    store.set('settings.audioSleepSec', 0);
    const noteCase = async (moment, note) => {
      const r = { moment };
      if (e.sleepState !== 'awake') midi._inject([0xb0, 1, 0]); // a harmless CC wakes it
      await until(() => e.sleepState === 'awake' && e.ctx.state === 'running', 3000);
      await wait(1500); // the previous note has rung out
      const cp = capture(e, 3);
      await wait(300);
      let fire = null;
      const fired = new Promise((res) => {
        fire = () => {
          r.stateAtFire = e.sleepState;
          r.ctxStateAtFire = e.ctx.state;
          r.ctxAtFire = e.ctx.currentTime;
          r.tFire = performance.now();
          midi._inject([0x90, note, 100]);
          res();
        };
      });
      const origSuspend = e.ctx.suspend;
      if (moment === 'suspendPending') {
        e.ctx.suspend = function (...a) {
          const p = origSuspend.apply(this, a);
          delete e.ctx.suspend;
          fire(); // the message lands while the suspend is still pending (ctx.state 'running', engine 'sleeping')
          return p;
        };
      }
      const sp = e.sleep();
      if (moment === 'ramp') setTimeout(fire, 1);
      if (moment === 'asleep') sp.then(() => setTimeout(fire, 1));
      await fired;
      r.runMs = await until(() => e.ctx.state === 'running' && e.sleepState === 'awake', 5000, 1);
      r.sleepResolved = await Promise.race([sp, wait(3000).then(() => 'pending')]);
      await wait(500);
      midi._inject([0x80, note, 0]);
      const c = await cp;
      if (e.ctx.suspend !== origSuspend) delete e.ctx.suspend;
      r.gaps = c.gaps;
      const i0 = Math.max(0, Math.floor((r.ctxAtFire - c.t0 - 0.2) * sr));
      let on = null;
      for (let i = i0; i < c.d.length; i++) if (Math.abs(c.d[i]) > 1e-3) { on = i; break; }
      r.noteSounded = on !== null;
      r.onsetCtxMs = on === null ? null : +((c.t0 + on / sr - r.ctxAtFire) * 1000).toFixed(1);
      r.totalMs = on === null ? null : +(r.runMs + Math.max(0, r.onsetCtxMs)).toFixed(1);
      r.lastWake = e._debugStats().lastWake;
      r.ctxState = e.ctx.state;
      r.sleepState = e.sleepState;
      r.clicks = on === null ? [] : capClicks(c, sr, Math.max(0.01, on / sr - 0.2), Math.min(c.d.length / sr - 0.01, on / sr + 0.3)).map((t) => +(t - on / sr).toFixed(3)).filter((t) => Math.abs(t) > 0.005); // ±5 ms: the note's own attack
      r.ok = r.noteSounded && r.totalMs <= 80 && r.ctxState === 'running' && r.sleepState === 'awake' && r.clicks.length === 0;
      delete r.tFire;
      return r;
    };
    out.note = [];
    const notes = { ramp: 62, suspendPending: 64, asleep: 65 };
    for (const m of ['ramp', 'suspendPending', 'asleep']) out.note.push(await noteCase(m, notes[m]));
    store.set('settings.audioSleepSec', 2);
    // (6) asleep → the popover starts recording (bus command) → awake, and stays awake while recording
    await until(() => e.sleepState === 'awake', 3000);
    await until(asleep, 9000);
    mini.command({ type: 'record', on: true });
    out.recWakeMs = await until(() => e.sleepState === 'awake' && e.ctx.state === 'running', 3000);
    await wait(100);
    out.recRecording = recorder.isRecording;
    await wait(4000);
    out.recStayedAwake = e.sleepState === 'awake';
    mini.command({ type: 'record', on: false });
    await wait(300);
    out.recStopped = !recorder.isRecording && !ctl.status.recording;
    out.recSleptAfterMs = await until(asleep, 9000);
    out.recBlockersAfter = e.sleepBlockers();
    out.recSleepDebug = ctl._sleepDebug();
    // (7) asleep → a hot-plug event → awake, no click
    const cp7 = capture(e, 1.5);
    await wait(200);
    midi._handleStateChange({ port: { type: 'input', id: 'hp-1', name: 'Hotplug Keys', state: 'connected', manufacturer: '' } });
    out.hotplugWakeMs = await until(() => e.sleepState === 'awake' && e.ctx.state === 'running', 3000);
    out.hotplugKind = ctl._sleepDebug().lastInputKind;
    const c7 = await cp7;
    out.hotplugGaps = c7.gaps;
    out.hotplugPeak = +Math.max(...Array.from(c7.d, Math.abs)).toExponential(2);
    out.hotplugClicks = clicks(c7.d, sr, 0.01, c7.d.length / sr - 0.01, 1e-4).length;
    ctl.dispose();
    mini.close();
    e.dispose();
    const noteOk = out.note.every((r) => r.ok);
    const pass = out.pedalOk && noteOk && out.recWakeMs < 500 &&
      out.recRecording && out.recStayedAwake && out.recStopped && out.recSleptAfterMs < 9000 && out.hotplugWakeMs < 500 && out.hotplugClicks === 0;
    return { pass, noteOk, ...out };
  },

  // (8) a re-render (default 20 s loop) while a live pad note is held: the realtime output has no dropout. Rounds of
  // [5 s without a render, 5 s with one] (the box is shared, so gaps — skipped render quanta — are compared to the
  // rounds without a render); main-thread long tasks are reported too (MIDI input waits behind them).
  async renderNoDropout() {
    const out = { rounds: [] };
    const e = await frozenEngine(59, { loopSec: 20, prerollSec: undefined, slots: { 0: slot('synth', 'warm-pad') } });
    e._setDroneFreezeOptions({ debounceSec: 0 });
    const sr = e.ctx.sampleRate;
    e.setLowResource(true);
    await until(() => !!e.drone.frozen && stable(e), 60000, 50);
    e.noteOn(57, 100);
    e.noteOn(64, 90);
    await wait(2500);
    const longTasks = [];
    let obs = null;
    try {
      obs = new PerformanceObserver((l) => {
        for (const x of l.getEntries()) longTasks.push([x.startTime, x.duration]);
      });
      obs.observe({ type: 'longtask', buffered: false });
    } catch {}
    const measure = async (withRender, k) => {
      const r = { withRender };
      const cp = capture(e, 5);
      const tA = performance.now();
      await wait(500);
      if (withRender) {
        const r0 = e.drone._fz.renders;
        e.setParam('drone.brightness', k % 2 ? 0.5 : 0.56);
        r.renderDoneMs = await until(() => e.drone._fz.renders > r0, 60000, 10);
        r.renderMs = e.drone._fz.lastRenderMs;
      }
      const c = await cp;
      const tB = performance.now();
      r.gaps = c.gaps;
      let run = 0;
      let maxRun = 0;
      for (let i = 0; i < c.d.length; i++) {
        if (Math.abs(c.d[i]) < 1e-4) run++;
        else run = 0;
        if (run > maxRun) maxRun = run;
      }
      r.maxSilentRunMs = +((maxRun / sr) * 1000).toFixed(2);
      r.clicks = capClicks(c, sr, 0.01, 4.99).length;
      const lt = longTasks.filter(([t]) => t >= tA && t <= tB).map(([, d]) => Math.round(d));
      r.longTasks = lt;
      return r;
    };
    for (let k = 0; k < 4; k++) {
      out.rounds.push(await measure(false, k));
      out.rounds.push(await measure(true, k));
      await wait(1600); // the swap ends
    }
    obs?.disconnect();
    e.noteOff(57);
    e.noteOff(64);
    e.dispose();
    const sum = (w, k) => out.rounds.filter((r) => r.withRender === w).reduce((s, r) => s + r[k], 0);
    const mx = (w, k) => Math.max(...out.rounds.filter((r) => r.withRender === w).map((r) => r[k]));
    const lts = (w) => out.rounds.filter((r) => r.withRender === w).flatMap((r) => r.longTasks);
    out.summary = {
      gapsWithout: sum(false, 'gaps'), gapsWith: sum(true, 'gaps'),
      silentMaxWithoutMs: mx(false, 'maxSilentRunMs'), silentMaxWithMs: mx(true, 'maxSilentRunMs'),
      clicksWithout: sum(false, 'clicks'), clicksWith: sum(true, 'clicks'),
      longTaskMaxWithoutMs: Math.max(0, ...lts(false)), longTaskMaxWithMs: Math.max(0, ...lts(true)),
    };
    const S = out.summary;
    // a gap (skipped render quanta) is the audio thread missing its deadline: the render must not add any; the longest
    // hole is reported (the shared box drops 20–70 ms now and then with or without a render)
    const pass = S.gapsWith <= S.gapsWithout + 2 && S.clicksWith <= S.clicksWithout + 1;
    return { pass, ...out };
  },

  // (9) 20 re-renders (default 20 s loop): no growth of held loop memory; decoded / pinned MB unchanged; RSS reported
  async memory20() {
    const out = {};
    const e = await frozenEngine(61, { loopSec: 20, prerollSec: undefined });
    e._setDroneFreezeOptions({ debounceSec: 0 });
    e.setLowResource(true);
    await until(() => !!e.drone.frozen && stable(e), 60000, 50);
    await wait(2000);
    const snap = async () => {
      if (window.__gc) await window.__gc();
      await wait(300);
      const s = e._debugStats();
      return { decodedMB: s.decodedMB, pinnedMB: s.pinnedMB, droneFreezeMB: s.droneFreezeMB, nodes: s.nodes, timers: s.timers,
        rssMB: window.__rss ? await window.__rss() : null, heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null };
    };
    out.before = await snap();
    const b = [0.5, 0.56];
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      const r0 = e.drone._fz.renders;
      e.setParam('drone.brightness', b[i % 2] + 0.001 * i);
      await until(() => e.drone._fz.renders > r0, 60000, 20);
      await wait(1700); // the swap crossfade ends and the old loop is disposed
    }
    out.renders = e.drone._fz.renders;
    out.totalSec = Math.round((performance.now() - t0) / 1000);
    await until(() => stable(e), 10000, 50);
    out.after = await snap();
    out.state = droneState(e);
    const loopMB = +((e.drone.frozen?.bytes || 0) / 1048576).toFixed(2);
    out.loopMB = loopMB;
    e.dispose();
    await wait(500);
    out.afterDispose = window.__rss ? await snap().catch(() => null) : null;
    const pass = out.after.droneFreezeMB - out.before.droneFreezeMB <= loopMB &&
      out.after.decodedMB - out.before.decodedMB <= loopMB && out.after.pinnedMB - out.before.pinnedMB <= loopMB &&
      out.state.fzOut === 0 && (out.after.rssMB == null || out.after.rssMB - out.before.rssMB <= 2 * loopMB + 15);
    return { pass, ...out };
  },
};
