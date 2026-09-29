#!/usr/bin/env node
// Performance profiler (reviews/performance.md). Serves the real app, boots it in headless Chromium and, for every
// factory song, runs a scripted 20 s perform loop through controller.perform (chords every 1 s, a melody note every
// 250 ms, the sustain pedal on alternate bars, a 30 Hz mod-wheel triangle sweep). It records per song:
//   * engine._debugStats() sampled every 250 ms (peak voices / nodes, decodedMB, pinnedMB), and voices after release
//   * main thread: longtask (count / total / max) and long-animation-frame script attribution, CDP
//     Performance.getMetrics deltas (TaskDuration, ScriptDuration, Layout, RecalcStyle), and a CDP sampling
//     Profiler (self time by function url:line)
//   * Linux: /proc per-thread CPU of the renderer (main, Web Audio device thread, reverb background, compositor) and
//     the GPU process. The audio thread's own render cost is visible only there: render-quantum overruns are not.
//   * heap (performance.memory + CDP Runtime.getHeapUsage, after a forced GC), CDP Memory.getDOMCounters, DOM
//     element count, and live event listeners counted by an addEventListener/removeEventListener patch installed
//     before any app script (FinalizationRegistry drops the listeners of collected targets)
//   * per perform call (noteOn/noteOff/sustain/wheel) its synchronous main-thread cost, and the event-loop lag: the
//     melody runs on absolute 250 ms deadlines and records how late each fires (what a MIDI message would wait)
//   Each song loop starts once the main thread, the reverb warm and sample fetches have been quiet for 3 s.
// Then 10 song switches (library order from the last song, so the first is a jump back to song 1): per switch the
// wall time to !loading with its long tasks and sample fetches, then a 10 s loop played straight away (the neighbour
// warm-up runs under it) with the same per-call costs and lag.
// Usage: node tools/profile.mjs [--only slug,slug] [--loop 20] [--switches 10] [--no-profiler] [--json out.json]
// The numbers are relative on a loaded 2-CPU box: compare songs within one run.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const { createServer } = require(path.join(ROOT, 'server.js'));

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const LOOP_S = Number(arg('loop', 20));
const SWITCHES = Number(arg('switches', 10));
const ONLY = arg('only', null)?.split(',').map((s) => s.trim());
const JSON_OUT = arg('json', null);
const PROFILER = !argv.includes('--no-profiler');
const CLK_TCK = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// ------------------------------------------------------------------------------------------------ /proc (Linux)
function threadTicks(pid) {
  const out = new Map();
  let tids = [];
  try {
    tids = fs.readdirSync(`/proc/${pid}/task`);
  } catch {
    return out;
  }
  for (const tid of tids) {
    try {
      const st = fs.readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8');
      const rp = st.lastIndexOf(')');
      const f = st.slice(rp + 2).split(' ');
      out.set(tid, { name: st.slice(st.indexOf('(') + 1, rp), ticks: Number(f[11]) + Number(f[12]) });
    } catch {}
  }
  return out;
}
function procTicks(pid) {
  try {
    const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const g = f.slice(f.lastIndexOf(')') + 2).split(' ');
    return Number(g[11]) + Number(g[12]);
  } catch {
    return null;
  }
}
const cmdline = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return '';
  }
};
function descendants(pid) {
  const all = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      all.push({ pid: Number(d), ppid: Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]) });
    } catch {}
  }
  const kids = new Set([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) if (kids.has(p.ppid) && !kids.has(p.pid)) (kids.add(p.pid), (grew = true));
  }
  kids.delete(pid);
  return [...kids];
}
function group(name) {
  if (name === 'CrRendererMain') return 'main';
  if (/^AudioOutputDevi|^AudioDevice|^WebAudio|^AudioWorklet|^RealtimeAudio/i.test(name)) return 'audio';
  if (/^Reverb|convolution|^HRTF/i.test(name)) return 'reverbBg';
  if (/^Compositor$/.test(name)) return 'compositor';
  return 'other';
}
const rssMB = (pid) => {
  try {
    const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
};

// ------------------------------------------------------------------------------------------------ page init script
// Installed before any app script. Long tasks + LoAF, and a live-listener count per target kind.
const INIT = () => {
  const P = (window.__perf = { long: [], loaf: [], adds: 0, removes: 0, live: 0 });
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) P.long.push({ t: e.startTime, d: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.duration < 50) continue;
        P.loaf.push({
          t: e.startTime,
          d: e.duration,
          block: e.blockingDuration,
          style: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0,
          scripts: (e.scripts || []).map((s) => ({
            d: s.duration,
            inv: s.invoker,
            fn: s.sourceFunctionName,
            url: (s.sourceURL || '').replace(/^https?:\/\/[^/]+/, ''),
            pos: s.sourceCharPosition,
            layout: s.forcedStyleAndLayoutDuration,
          })),
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch {}
  // live listeners: WeakMap<target, Map<fn, Set<type|capture>>>; targets are enumerable through WeakRefs
  const reg = new WeakMap();
  const refs = new Set();
  const fin = new FinalizationRegistry((n) => {
    P.live -= n.count;
  });
  const holder = new WeakMap(); // target → {count} (the finalizer's held value)
  const kind = (t) =>
    t === window ? 'window' : t === document ? 'document' : t instanceof Element ? 'element' : t instanceof AudioNode ? 'audionode' : t instanceof BroadcastChannel ? 'broadcast' : t instanceof MediaQueryList ? 'mediaquery' : t?.constructor?.name || 'other';
  const add0 = EventTarget.prototype.addEventListener;
  const rem0 = EventTarget.prototype.removeEventListener;
  const cap = (o) => !!(typeof o === 'boolean' ? o : o && o.capture);
  function drop(t, type, fn, c) {
    const m = reg.get(t);
    const s = m && m.get(fn);
    const key = `${type}|${c}`;
    if (!s || !s.has(key)) return;
    s.delete(key);
    if (!s.size) m.delete(fn);
    holder.get(t).count--;
    P.live--;
    P.removes++;
  }
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (fn) {
      const t = this;
      let m = reg.get(t);
      if (!m) {
        reg.set(t, (m = new Map()));
        const h = { count: 0 };
        holder.set(t, h);
        fin.register(t, h);
        refs.add(new WeakRef(t));
      }
      let s = m.get(fn);
      if (!s) m.set(fn, (s = new Set()));
      const c = cap(opts);
      const key = `${type}|${c}`;
      if (!s.has(key)) {
        s.add(key);
        holder.get(t).count++;
        P.live++;
        P.adds++;
        if (opts && typeof opts === 'object') {
          if (opts.once) {
            // a once-listener removes itself after its first call; approximate by counting it until then
            const wrapped = fn;
            add0.call(t, type, () => drop(t, type, wrapped, c), { once: true, capture: c });
          }
          if (opts.signal) opts.signal.addEventListener('abort', () => drop(t, type, fn, c), { once: true });
        }
      }
    }
    return add0.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    if (fn) drop(this, type, fn, cap(opts));
    return rem0.call(this, type, fn, opts);
  };
  P.listeners = () => {
    const byKind = {};
    const byType = {};
    let detached = 0;
    for (const r of refs) {
      const t = r.deref();
      if (!t) {
        refs.delete(r);
        continue;
      }
      const m = reg.get(t);
      let n = 0;
      for (const s of m.values()) {
        n += s.size;
        for (const k of s) byType[k.split('|')[0]] = (byType[k.split('|')[0]] || 0) + 1;
      }
      if (!n) continue;
      const k = kind(t);
      byKind[k] = (byKind[k] || 0) + n;
      if (t instanceof Node && !t.isConnected) detached += n;
    }
    return { live: P.live, adds: P.adds, removes: P.removes, byKind, detached, byType };
  };
};

// The in-page perform loop (setInterval-driven, no Playwright round-trips while it runs).
const LOOP = async ({ loopS, tail = 3000 }) => {
  const { engine, controller } = window.__rig;
  const perf = controller.perform;
  const stats = [];
  const chords = [
    [36, 60, 64, 67],
    [43, 59, 62, 67],
    [45, 60, 64, 69],
    [41, 60, 65, 69],
  ];
  const melody = [72, 74, 76, 79, 76, 74, 72, 71];
  const t0 = performance.now();
  let held = [];
  let bar = 0;
  let step = 0;
  let wheelT = 0;
  const timers = [];
  const peak = { voices: 0, nodes: 0, decodedMB: 0, pinnedMB: 0, sounding: 0 };
  const sample = () => {
    const s = engine._debugStats();
    for (const k of Object.keys(peak)) peak[k] = Math.max(peak[k], s[k] || 0);
    stats.push({ t: Math.round(performance.now() - t0), v: s.voices, n: s.nodes });
  };
  // main-thread cost of one controller.perform call (controller → engine → voice graph): the input-latency floor
  const cost = { on: [], off: [], wheel: [], ped: [], chord: [], lag: [] };
  const timed = (arr, fn) => {
    const a = performance.now();
    fn();
    arr.push(performance.now() - a);
  };
  const chord = () => {
    for (const n of held) timed(cost.off, () => perf.noteOff(n));
    if (bar % 2 === 1) timed(cost.ped, () => perf.sustain(false));
    held = chords[bar % 4];
    const chordT0 = performance.now();
    for (const n of held) timed(cost.on, () => perf.noteOn(n, 80 + (bar % 3) * 10));
    cost.chord.push(performance.now() - chordT0);
    if (bar % 2 === 0) setTimeout(() => timed(cost.ped, () => perf.sustain(true)), 60);
    bar++;
  };
  const mel = () => {
    const n = melody[step++ % melody.length];
    timed(cost.on, () => perf.noteOn(n, 70));
    setTimeout(() => timed(cost.off, () => perf.noteOff(n)), 200);
  };
  const wheel = () => {
    wheelT += 1 / 30;
    const ph = (wheelT % 4) / 4; // 4 s triangle 0 → 1 → 0
    timed(cost.wheel, () => perf.wheel(ph < 0.5 ? ph * 2 : 2 - ph * 2));
  };
  // the melody runs on absolute deadlines (t0 + k × 250 ms): how late each one fires is the main-thread queueing
  // delay a MIDI message arriving at that instant would see (on top of the perform call's own cost)
  let melK = 0;
  let melTimer = 0;
  let stopped = false;
  const melTick = () => {
    if (stopped) return;
    const target = t0 + melK * 250;
    cost.lag.push(Math.max(0, performance.now() - target));
    mel();
    melK++;
    melTimer = setTimeout(melTick, Math.max(0, t0 + melK * 250 - performance.now()));
  };
  chord();
  melTimer = setTimeout(melTick, 0);
  timers.push(setInterval(chord, 1000), setInterval(wheel, 1000 / 30), setInterval(sample, 250));
  await new Promise((r) => setTimeout(r, loopS * 1000));
  stopped = true;
  clearTimeout(melTimer);
  for (const t of timers) clearInterval(t);
  for (const n of held) perf.noteOff(n);
  perf.sustain(false);
  perf.wheel(0);
  perf.releaseAll();
  sample();
  const endStats = engine._debugStats();
  await new Promise((r) => setTimeout(r, tail));
  const after = engine._debugStats();
  const q = (arr, p) => {
    if (!arr || !arr.length) return null;
    const so = [...arr].sort((x, y) => x - y);
    return Math.round(so[Math.min(so.length - 1, Math.floor(p * so.length))] * 100) / 100;
  };
  const summ = (arr) => ({ n: arr.length, p50: q(arr, 0.5), p95: q(arr, 0.95), max: q(arr, 1) });
  const costs = Object.fromEntries(Object.entries(cost).map(([k, arr]) => [k, summ(arr)]));
  return { peak, end: endStats, after3s: after, samples: stats.length, costs };
};

// ------------------------------------------------------------------------------------------------ main
const server = createServer({ appDir: path.join(ROOT, 'app'), port: 0 });
const info = await server.listen();
const origin = `http://127.0.0.1:${info.port}`;
const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.grantPermissions(['midi'], { origin }).catch(() => {});
await context.addInitScript(INIT);
const page = await context.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const reqs = []; // sample / pad audio requests (fetches during a perform loop mean decoding while playing)
page.on('request', (r) => {
  if (/\/(samples|user-samples|pads)\/.+\.(wav|mp3|ogg|flac|m4a)/i.test(r.url())) reqs.push({ t: Date.now(), url: r.url() });
});
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable', { timeDomain: 'threadTicks' }).catch(() => cdp.send('Performance.enable'));
if (PROFILER) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
}
const ev = (fn, a) => page.evaluate(fn, a);
const until = (fn, a, timeout = 60000) => page.waitForFunction(fn, a, { timeout, polling: 100 });
const log = (...a) => console.log('[profile]', ...a);

log(`${origin} cpus=${os.cpus().length} load=${os.loadavg().map((x) => x.toFixed(1)).join(' ')}`);
const bootT0 = Date.now();
await page.goto(`${origin}/`);
await until(() => !!(window.__rig && window.__rig.ready), null, 120000);
await ev(() => window.__rig.ready);
const overlay = await page.$('#overlay-start:not([hidden])');
if (overlay) await overlay.click().catch(() => {});
await until(() => window.__rig.engine.ctx && window.__rig.engine.ctx.state === 'running', null, 60000);
const bootMs = Date.now() - bootT0;

const bpid = descendants(process.pid).find((p) => /chrom/i.test(cmdline(p)) && !cmdline(p).includes('--type=')) || null;
function findProcs() {
  const kids = bpid ? descendants(bpid) : [];
  const rs = kids.filter((p) => cmdline(p).includes('--type=renderer'));
  const renderer = rs.find((p) => [...threadTicks(p).values()].some((t) => group(t.name) === 'audio')) || rs[0] || null;
  const gpu = kids.find((p) => cmdline(p).includes('--type=gpu-process')) || null;
  return { renderer, gpu };
}
const LINUX = process.platform === 'linux' && !!bpid;

async function gcNow() {
  await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
  await sleep(200);
  await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
}
async function memSnap() {
  await gcNow();
  const dom = await cdp.send('Memory.getDOMCounters').catch(() => ({}));
  const hu = await cdp.send('Runtime.getHeapUsage').catch(() => ({}));
  const page1 = await ev(() => ({
    heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
    elements: document.getElementsByTagName('*').length,
    listeners: window.__perf.listeners(),
  }));
  return {
    heapMB: r1(page1.heapMB),
    cdpHeapMB: hu.usedSize != null ? r1(hu.usedSize / 1048576) : null,
    domNodes: dom.nodes ?? null,
    documents: dom.documents ?? null,
    jsListeners: dom.jsEventListeners ?? null,
    elements: page1.elements,
    listeners: page1.listeners,
  };
}
async function metrics() {
  const { metrics: m } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(m.map((x) => [x.name, x.value]));
}
function cpuSnap() {
  if (!LINUX) return null;
  const p = findProcs();
  const th = p.renderer ? threadTicks(p.renderer) : new Map();
  return { at: Date.now(), p, th, gpu: p.gpu ? procTicks(p.gpu) : null };
}
function cpuDelta(a, b) {
  if (!a || !b) return null;
  const s = (b.at - a.at) / 1000;
  const g = { main: 0, audio: 0, reverbBg: 0, compositor: 0, other: 0 };
  for (const [tid, t] of b.th) {
    const prev = a.th.get(tid);
    // headless_shell names its main thread after itself: the main thread is the one whose tid is the pid
    const k = Number(tid) === b.p.renderer ? 'main' : group(t.name);
    g[k] += (t.ticks - (prev ? prev.ticks : 0)) / CLK_TCK;
  }
  const pct = (x) => r1((x / s) * 100);
  const total = Object.values(g).reduce((x, y) => x + y, 0);
  return {
    renderer: pct(total),
    main: pct(g.main),
    audio: pct(g.audio),
    reverbBg: pct(g.reverbBg),
    compositor: pct(g.compositor),
    gpu: a.gpu != null && b.gpu != null ? pct((b.gpu - a.gpu) / CLK_TCK) : null,
    rendererRssMB: b.p.renderer ? rssMB(b.p.renderer) : null,
  };
}
/** CPU profile → self ms by function (url:line:col), plus totals for (program)/(garbage collector)/(idle). */
function selfTimes(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const d = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000;
    self.set(profile.samples[i], (self.get(profile.samples[i]) || 0) + d);
  }
  const agg = new Map();
  const special = {};
  for (const [id, ms] of self) {
    const cf = byId.get(id).callFrame;
    if (!cf.url) {
      special[cf.functionName || '(anon native)'] = (special[cf.functionName || '(anon native)'] || 0) + ms;
      continue;
    }
    const url = cf.url.replace(/^https?:\/\/[^/]+\//, 'app/');
    const key = `${url}:${cf.lineNumber + 1}:${cf.columnNumber + 1} ${cf.functionName || '(anonymous)'}`;
    agg.set(key, (agg.get(key) || 0) + ms);
  }
  const byFile = new Map();
  for (const [k, ms] of agg) {
    const f = k.split(':')[0];
    byFile.set(f, (byFile.get(f) || 0) + ms);
  }
  const top = [...agg].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, ms]) => [k, r1(ms)]);
  // callers of the 8 hottest app functions: the nearest ancestor frame that is a different app function
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const keyOf = (cf) => `${cf.url.replace(/^https?:\/\/[^/]+\//, 'app/')}:${cf.lineNumber + 1}:${cf.columnNumber + 1} ${cf.functionName || '(anonymous)'}`;
  const hot = new Set(top.slice(0, 8).map(([k]) => k));
  const callers = {};
  for (const [id, ms] of self) {
    const cf = byId.get(id).callFrame;
    if (!cf.url) continue;
    const k = keyOf(cf);
    if (!hot.has(k)) continue;
    let p = parent.get(id);
    let ck = '(root)';
    while (p != null) {
      const pcf = byId.get(p).callFrame;
      if (pcf.url && keyOf(pcf) !== k) {
        ck = keyOf(pcf);
        break;
      }
      p = parent.get(p);
    }
    callers[k] ??= {};
    callers[k][ck] = (callers[k][ck] || 0) + ms;
  }
  for (const k of Object.keys(callers)) {
    callers[k] = Object.entries(callers[k]).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, ms]) => [c, r1(ms)]);
  }
  const files = [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, ms]) => [k, r1(ms)]);
  const jsMs = [...agg.values()].reduce((a, b) => a + b, 0);
  return { callers, jsMs: r1(jsMs), special: Object.fromEntries(Object.entries(special).map(([k, v]) => [k, r1(v)])), top, files, all: agg };
}

const songs = await ev(() => {
  const s = window.__rig.store.get();
  return s.songOrder.map((id) => ({ id, fid: s.songs[id].factoryId || null, name: s.songs[id].name }));
});
const factory = songs.filter((s) => s.fid && (!ONLY || ONLY.some((o) => s.fid.endsWith(o))));
log(`boot ${bootMs} ms; ${songs.length} songs in library, profiling ${factory.length}; linux=${LINUX}`);

/** Wait until the main thread had no long task for `quietMs` (max `maxMs`); returns the wait in ms. */
async function quiesce(quietMs = 3000, maxMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const age = await ev(() => {
      const L = window.__perf.long;
      const last = L.length ? L[L.length - 1] : null;
      return last ? performance.now() - (last.t + last.d) : Infinity;
    });
    const inflight = await ev(() => window.__rig.engine.fx?.reverb?._inflight?.size || 0);
    const lastReq = reqs.length ? reqs[reqs.length - 1].t : 0;
    if (age >= quietMs && !inflight && Date.now() - lastReq >= quietMs) return Date.now() - t0;
    await sleep(500);
  }
  return Date.now() - t0;
}

async function selectSong(id) {
  const t0 = Date.now();
  await ev((sid) => window.__rig.controller.selectSong(sid), id);
  await until((sid) => {
    const c = window.__rig.controller;
    return c.status.songId === sid && !c.status.loading;
  }, id, 180000);
  return Date.now() - t0;
}

const bootMem = await memSnap();
const results = [];
const allSelf = new Map();
for (const s of factory) {
  const loadMs = await selectSong(s.id);
  const settleMs = await quiesce(); // neighbour preload / reverb warm settles (measured separately in the switches)
  const mem0 = await memSnap();
  const pt0 = await ev(() => performance.now());
  const m0 = await metrics();
  const c0 = cpuSnap();
  if (PROFILER) await cdp.send('Profiler.start');
  const loopT0 = Date.now();
  let loop;
  try {
    loop = await ev(LOOP, { loopS: LOOP_S });
  } catch (e) {
    loop = { error: String(e) };
  }
  const loopT1 = Date.now();
  const prof = PROFILER ? (await cdp.send('Profiler.stop')).profile : null;
  const c1 = cpuSnap();
  const m1 = await metrics();
  const pt1 = await ev(() => performance.now());
  const perfWin = await ev(([a, b]) => {
    const L = window.__perf.long.filter((x) => x.t >= a && x.t <= b);
    const F = window.__perf.loaf.filter((x) => x.t >= a && x.t <= b);
    return { long: L, loaf: F };
  }, [pt0, pt1]);
  const mem1 = await memSnap();
  const wall = (pt1 - pt0) / 1000;
  const md = (k) => r1(((m1[k] - m0[k]) / wall) * 1000); // ms per s of wall
  const st = prof ? selfTimes(prof) : null;
  if (st) for (const [k, ms] of st.all) allSelf.set(k, (allSelf.get(k) || 0) + ms);
  const L = perfWin.long;
  const row = {
    fid: s.fid,
    name: s.name,
    loadMs,
    settleMs,
    reverbKey: await ev(() => window.__rig.engine.fx?.reverb?.active?.key || null),
    costs: loop.costs || null,
    engine: loop.peak ? { ...loop.peak, voicesEnd: loop.end.voices, voicesAfter3s: loop.after3s.voices, nodesAfter3s: loop.after3s.nodes, retiring: loop.after3s.retiring } : loop,
    longtasks: { n: L.length, totalMs: r1(L.reduce((a, x) => a + x.d, 0)), maxMs: r1(Math.max(0, ...L.map((x) => x.d))) },
    loafTop: perfWin.loaf.sort((a, b) => b.d - a.d).slice(0, 3),
    cdp: { taskMsPerS: md('TaskDuration'), scriptMsPerS: md('ScriptDuration'), layoutMsPerS: md('LayoutDuration'), styleMsPerS: md('RecalcStyleDuration'), layouts: m1.LayoutCount - m0.LayoutCount, styles: m1.RecalcStyleCount - m0.RecalcStyleCount },
    cpu: cpuDelta(c0, c1),
    profiler: st ? { jsMsPerS: r1(st.jsMs / wall), special: st.special, top: st.top.slice(0, 8), files: st.files, callers: st.callers } : null,
    sampleRequests: reqs.filter((x) => x.t >= loopT0 && x.t <= loopT1).length,
    mem: { before: mem0, after: mem1, heapDeltaMB: r1(mem1.heapMB - mem0.heapMB), listenerDelta: mem1.listeners.live - mem0.listeners.live, domDelta: mem1.domNodes - mem0.domNodes },
  };
  results.push(row);
  log(
    `${s.fid.padEnd(30)} load ${String(loadMs).padStart(6)} ms | voices ${row.engine.voices} nodes ${row.engine.nodes} → ${row.engine.nodesAfter3s} | dec ${row.engine.decodedMB} pin ${row.engine.pinnedMB} | ` +
      `long ${row.longtasks.n}/${row.longtasks.maxMs} ms | noteOn p50/p95/max ${row.costs?.on?.p50}/${row.costs?.on?.p95}/${row.costs?.on?.max} lag p95/max ${row.costs?.lag?.p95}/${row.costs?.lag?.max} wheel p95 ${row.costs?.wheel?.p95} | js ${row.profiler?.jsMsPerS} ms/s task ${row.cdp.taskMsPerS} | cpu r ${row.cpu?.renderer} a ${row.cpu?.audio} m ${row.cpu?.main} | ` +
      `heap ${mem1.heapMB} dom ${mem1.domNodes} lis ${mem1.listeners.live} | fetches ${row.sampleRequests}`,
  );
}

// ---- song switches: SWITCHES consecutive selects in library order, no notes held
const switches = [];
const order = songs.map((s) => s.id);
let cur = order.indexOf(await ev(() => window.__rig.controller.status.songId));
const swMem0 = await memSnap();
for (let i = 0; i < SWITCHES; i++) {
  cur = (cur + 1) % order.length;
  const a = await ev(() => performance.now());
  const ra = Date.now();
  const ms = await selectSong(order[cur]);
  const mid = await ev(() => performance.now());
  const rm = Date.now();
  // play straight away (a worship set: the song is picked and the band starts), 10 s
  const loop = await ev(LOOP, { loopS: 10, tail: 500 }).catch((e) => ({ error: String(e) }));
  const b = await ev(() => performance.now());
  const w = await ev(([x, m, y]) => ({
    load: window.__perf.long.filter((e) => e.t >= x && e.t <= m),
    after: window.__perf.long.filter((e) => e.t > m && e.t <= y),
    loaf: window.__perf.loaf.filter((e) => e.t >= x && e.t <= y).sort((p, q) => q.d - p.d).slice(0, 3),
  }), [a, mid, b]);
  const mx = (L) => r1(Math.max(0, ...L.map((e) => e.d)));
  const tot = (L) => r1(L.reduce((p, e) => p + e.d, 0));
  const sw = {
    to: songs[cur].fid,
    ms,
    load: { n: w.load.length, maxMs: mx(w.load), totalMs: tot(w.load), fetches: reqs.filter((x) => x.t >= ra && x.t < rm).length },
    after: { n: w.after.length, maxMs: mx(w.after), totalMs: tot(w.after), fetches: reqs.filter((x) => x.t >= rm).length },
    costs: loop.costs || loop,
    loaf: w.loaf,
  };
  switches.push(sw);
  log(`switch → ${sw.to}: ${ms} ms; load: ${sw.load.n} long max ${sw.load.maxMs} tot ${sw.load.totalMs} fetch ${sw.load.fetches}; ` +
    `then playing 10 s: ${sw.after.n} long max ${sw.after.maxMs} tot ${sw.after.totalMs} fetch ${sw.after.fetches}; ` +
    `noteOn p95/max ${sw.costs?.on?.p95}/${sw.costs?.on?.max} lag p95/max ${sw.costs?.lag?.p95}/${sw.costs?.lag?.max}`);
}
const swMem1 = await memSnap();

// ---- ConvolverNode.buffer cost per IR bucket (Chromium partitions the IR synchronously on the main thread)
const convBench = await ev(async () => {
  const ctx = window.__rig.engine.ctx;
  const sr = ctx.sampleRate;
  const out = [];
  for (const sec of [1.5, 2, 2.8, 3.8, 5, 6.5, 8]) {
    const len = Math.ceil(1.1 * sec * sr); // fx.js IR length: 1.1 × the longest band RT (damp can lengthen a band)
    const buf = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: sr });
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp((-6.9 * i) / (sec * sr));
    }
    const runs = [];
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      const conv = new ConvolverNode(ctx, { disableNormalization: true });
      conv.buffer = buf;
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    out.push({ sec, frames: len, medianMs: Math.round(runs[1] * 10) / 10 });
  }
  return { sr, out };
});
log(`convolver.buffer cost @${convBench.sr} Hz: ${convBench.out.map((x) => `${x.sec}s ${x.medianMs}ms`).join(', ')}`);

const topAll = [...allSelf].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, ms]) => [k, r1(ms)]);
const out = {
  at: new Date().toISOString(),
  chromium: browser.version(),
  cpus: os.cpus().length,
  loadavg: os.loadavg().map(r1),
  loopS: LOOP_S,
  bootMs,
  bootMem,
  results,
  switches,
  switchMem: { before: swMem0, after: swMem1 },
  convBench,
  topAll,
  errors,
};
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
log(`top self time across all loops:\n${topAll.map(([k, ms]) => `  ${String(ms).padStart(8)} ms  ${k}`).join('\n')}`);
log(`errors: ${errors.length}${errors.length ? '\n  ' + errors.slice(0, 10).join('\n  ') : ''}`);
await browser.close();
await server.close?.();
process.exit(0);
