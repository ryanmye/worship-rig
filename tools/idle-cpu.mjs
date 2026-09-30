#!/usr/bin/env node
// Idle-CPU profiler (reviews/idle-cpu.md). Serves the real app, boots it in headless Chromium, selects a song and
// measures where an idle renderer spends its CPU, per configuration:
//   A baseline (Perform, 'Sunday Pad + Piano', drone ON)      B drone off
//   C1 reverb returnGain 0 (convolver still fed)                C2 + active reverb unit disconnected, idle units dropped
//   D low-resource (controller.setLowResource(true): meters hidden, taps off)
//   E Edit view instead of Perform                              F1 setWindowVisible(false)  F2 same with menuBarMode on
//   G1 'Glass Ocean' (synth only)                               G2 'Grand Piano' (sampler only)
//   H 'Sunday Pad + Piano' with a chord held (playing)
//   I A + the hidden 'Loading…' spinner's infinite animation paused (measurement-only style injection)
//   J D + the spinner paused (meters off and no running animation: the UI floor)
//   K Sunday Pad + Piano, drone off, the pad played once (a fresh never-played pad vs one that has sounded)
//   W A + the window hidden through LOCAL's 'rig:window-visible' {visible:false} DOM event, menuBarMode off
//     (idle-cpu-ui: the renderer must stop its meters from that event alone)
// Metrics per configuration (window of MEASURE_S seconds after SETTLE_S):
//   * /proc per-thread CPU of the renderer (Linux): main, the Web Audio device thread, reverb background threads,
//     compositor, raster, workers, other; the GPU and browser processes. This is the only place the audio thread's
//     CPU shows up in realtime (CDP metrics cover the main thread only).
//   * CDP Performance.getMetrics deltas: TaskDuration, ScriptDuration, LayoutDuration, RecalcStyleDuration,
//     ThreadTime, ProcessTime, Layout/RecalcStyle counts.
//   * page counters (installed before any app script): timer / rAF / idle-callback firings per second with their
//     call sites, AnalyserNode reads/s, DOM mutations/s, long tasks, running CSS/Web animations, live started
//     source nodes by class, engine._debugStats(), reverb units (IR length, connected).
//   * DSP estimate: an OfflineAudioContext engine given the live engine's getState() renders OFFLINE_S seconds
//     (silence in, drone as configured); CPU of the offline render thread / OFFLINE_S = audio-thread share.
// Usage: node tools/idle-cpu.mjs [--only A,B,...] [--measure 20] [--settle 10] [--offline 20] [--no-offline]
//        [--json out.json] [--emulate-prefix] [--app <dir>] [--theme <id>] [--themes <id,id,…> [--rounds N]]
//        [--channel chromium] [--headed] [--chrome-args "<switches>"] [--inject-css "<css>"]
// --theme pins a registered theme (app/js/shared/themes.js) before boot; without it the app's default applies.
// --themes (mac-findings, Sanctuary paint cost) measures configuration A once per theme per round, switching at runtime
// (settings.theme, then theme.pending + fonts), rows "A:<id>"; rounds interleave the themes so box drift hits them all.
// --app serves another copy of app/ (A/B a UI change against a snapshot of the tree). UI columns (idle-cpu-ui):
// raf = rAF callbacks/s, rcs = style recalcs/s and lay = layouts/s (CDP RecalcStyleCount / LayoutCount deltas),
// an = AnalyserNode reads/s (UI and engine taps), man = reads of engine.analyserL/R (the stereo meters),
// slot = controller.slotLevel() reads/s (the strip level meters' analyser taps).
// Linux only for the /proc numbers (elsewhere they are omitted); 2-CPU CI boxes are noisy: compare configs within
// one run, and read the CPU-time columns (not wall time).
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
const MEASURE_S = Number(arg('measure', 20));
const SETTLE_S = Number(arg('settle', 10));
const OFFLINE_S = Number(arg('offline', 20));
const NO_OFFLINE = argv.includes('--no-offline');
const ONLY = arg('only', null)?.split(',').map((s) => s.trim().toUpperCase());
const JSON_OUT = arg('json', null);
// --emulate-prefix: connect every fresh instrument at once, as the engine did before idle-cpu #1 (A/B the fix)
const EMULATE_PREFIX = argv.includes('--emulate-prefix');
const APP_DIR = path.resolve(arg('app', path.join(ROOT, 'app')));
const THEME = arg('theme', null);
const THEMES = arg('themes', null)?.split(',').map((s) => s.trim()).filter(Boolean) || null;
const ROUNDS = Number(arg('rounds', 1));
const CLK_TCK = 100; // /proc stat ticks per second on Linux (sysconf(_SC_CLK_TCK); 100 on every mainstream kernel)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SONGS = { sunday: 'Sunday Pad + Piano', glass: 'Glass Ocean', grand: 'Grand Piano' }; // by name (ids are generated)

// ------------------------------------------------------------------------------------------------ /proc sampling
function readThreads(pid) {
  const out = new Map();
  let tids = [];
  try {
    tids = fs.readdirSync(`/proc/${pid}/task`);
  } catch {
    return out;
  }
  for (const tid of tids) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8');
      const rp = stat.lastIndexOf(')');
      const name = stat.slice(stat.indexOf('(') + 1, rp);
      const f = stat.slice(rp + 2).split(' ');
      const ticks = Number(f[11]) + Number(f[12]); // utime + stime (fields 14, 15)
      out.set(tid, { name, ticks });
    } catch {}
  }
  return out;
}
function procTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(f[11]) + Number(f[12]);
  } catch {
    return null;
  }
}
function childPids(pid) {
  const all = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
      all.push({ pid: Number(d), ppid: Number(f[1]) });
    } catch {}
  }
  const kids = new Set([pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of all) if (kids.has(p.ppid) && !kids.has(p.pid)) (kids.add(p.pid), (grew = true));
  }
  kids.delete(pid);
  return [...kids];
}
/** Resident set (MB) of a process; Linux VmRSS (the Mac's "phys footprint" is a different, larger measure). */
function rssMB(pid) {
  try {
    const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/);
    return m ? Math.round(Number(m[1]) / 1024) : null;
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
/** Thread name → group. Chromium truncates comm to 15 chars. */
function group(name) {
  if (name === 'CrRendererMain') return 'main';
  if (/^AudioOutputDevi|^AudioDevice|^WebAudio|^AudioWorklet|^RealtimeAudio/i.test(name)) return 'audio';
  if (/^OfflineAudio/i.test(name)) return 'offline';
  if (/^Reverb|convolution|^HRTF/i.test(name)) return 'reverbBg';
  if (/^Compositor$/.test(name)) return 'compositor';
  if (/^CompositorTile|^Raster/.test(name)) return 'raster';
  if (/^DedicatedWorker|^Worker/.test(name)) return 'worker';
  if (/^V8|^ThreadPool/.test(name)) return 'pool';
  return 'other';
}

// ------------------------------------------------------------------------------------------------ page init script
// Installed before any app script: counts timer / rAF / idle callbacks (with call sites), analyser reads, started
// source nodes, DOM mutations and long tasks. Negligible overhead next to what it measures (a few µs per call).
const INIT = () => {
  const P = (window.__prof = {
    t: { timeout: 0, interval: 0, raf: 0, idle: 0 },
    sites: new Map(), // "kind site" -> fires
    an: { float: 0, byte: 0, freqF: 0, freqB: 0 },
    slot: 0, // controller.slotLevel() calls (counted by a wrapper installed after boot)
    man: 0, // reads of the master analysers engine.analyserL/R (the stereo meters; the engine's own taps excluded)
    mut: 0,
    mutRecords: 0,
    mutTargets: new Map(),
    longTasks: 0,
    longMs: 0,
    live: new Map(), // class -> count of started, not ended source nodes
    reset() {
      this.t = { timeout: 0, interval: 0, raf: 0, idle: 0 };
      this.sites = new Map();
      this.an = { float: 0, byte: 0, freqF: 0, freqB: 0 };
      this.slot = 0;
      this.man = 0;
      this.mut = 0;
      this.mutRecords = 0;
      this.mutTargets = new Map();
      this.longTasks = 0;
      this.longMs = 0;
    },
  });
  const site = () => {
    const s = new Error().stack.split('\n');
    for (let i = 3; i < s.length; i++) {
      const l = s[i];
      if (!l.includes('__prof') && !l.includes('INIT')) {
        const m = l.match(/\/js\/(.+?):(\d+):\d+\)?$/) || l.match(/at (.+)$/);
        return m ? (m[2] ? `${m[1]}:${m[2]}` : m[1]) : l.trim();
      }
    }
    return '?';
  };
  const bump = (kind, where) => {
    P.t[kind]++;
    const k = `${kind} ${where}`;
    P.sites.set(k, (P.sites.get(k) || 0) + 1);
  };
  const oTo = window.setTimeout;
  const oIv = window.setInterval;
  const oRaf = window.requestAnimationFrame;
  const oRic = window.requestIdleCallback;
  window.setTimeout = function (fn, ms, ...a) {
    const w = site();
    if (typeof fn !== 'function') return oTo.call(this, fn, ms, ...a);
    return oTo.call(this, function (...x) {
      bump('timeout', w);
      return fn.apply(this, x);
    }, ms, ...a);
  };
  window.setInterval = function (fn, ms, ...a) {
    const w = site();
    if (typeof fn !== 'function') return oIv.call(this, fn, ms, ...a);
    return oIv.call(this, function (...x) {
      bump('interval', w);
      return fn.apply(this, x);
    }, ms, ...a);
  };
  window.requestAnimationFrame = function (fn) {
    const w = site();
    return oRaf.call(this, (ts) => {
      bump('raf', w);
      return fn(ts);
    });
  };
  if (oRic) {
    window.requestIdleCallback = function (fn, o) {
      const w = site();
      return oRic.call(this, (dl) => {
        bump('idle', w);
        return fn(dl);
      }, o);
    };
  }
  const A = window.AnalyserNode && AnalyserNode.prototype;
  if (A) {
    for (const [m, k] of [['getFloatTimeDomainData', 'float'], ['getByteTimeDomainData', 'byte'], ['getFloatFrequencyData', 'freqF'], ['getByteFrequencyData', 'freqB']]) {
      const o = A[m];
      A[m] = function (...x) {
        P.an[k]++;
        return o.apply(this, x);
      };
    }
  }
  const S = window.AudioScheduledSourceNode && AudioScheduledSourceNode.prototype;
  if (S) {
    const oStart = S.start;
    S.start = function (...x) {
      const r = oStart.apply(this, x);
      if (!this.__profLive && !(this.context instanceof OfflineAudioContext)) {
        this.__profLive = true;
        const c = this.constructor.name;
        P.live.set(c, (P.live.get(c) || 0) + 1);
        this.addEventListener('ended', () => P.live.set(c, P.live.get(c) - 1), { once: true });
      }
      return r;
    };
  }
  const startObs = () => {
    new MutationObserver((recs) => {
      P.mutRecords += recs.length;
      for (const r of recs) {
        P.mut++;
        const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        const k = el ? `${r.type}:${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : el.tagName}${r.attributeName ? '@' + r.attributeName : ''}` : r.type;
        P.mutTargets.set(k, (P.mutTargets.get(k) || 0) + 1);
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          P.longTasks++;
          P.longMs += e.duration;
        }
      }).observe({ type: 'longtask', buffered: false });
    } catch {}
  };
  if (document.documentElement) startObs();
  else document.addEventListener('readystatechange', startObs, { once: true });
};

// ------------------------------------------------------------------------------------------------ in-page probes
/** Snapshot taken at the end of a window: counters (already reset at its start), engine stats, reverb, animations. */
const SNAP = () => {
  const P = window.__prof;
  const { engine, controller } = window.__rig;
  const R = engine.fx?.reverb;
  const units = R ? [...R.units.values()].map((u) => ({ key: u.key, len: u.conv.buffer?.length || 0, ch: u.conv.buffer?.numberOfChannels || 0, connected: u.connected, active: u === R.active, state: u.state })) : [];
  const anims = document.getAnimations().filter((a) => a.playState === 'running');
  return {
    t: { ...P.t },
    sites: [...P.sites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
    an: { ...P.an },
    slot: P.slot,
    man: P.man,
    mut: P.mut,
    mutTop: [...P.mutTargets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    longTasks: P.longTasks,
    longMs: Math.round(P.longMs),
    live: Object.fromEntries(P.live),
    stats: engine._debugStats(),
    units,
    sr: engine.ctx.sampleRate,
    baseLatency: engine.ctx.baseLatency,
    anims: anims.map((a) => `${a.animationName || a.constructor.name}@${a.effect?.target?.className || a.effect?.target?.tagName || '?'}`),
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    lowResource: controller.status.lowResource,
    drone: engine.drone?.getState?.().mode,
    view: document.body.dataset.view,
    songId: controller.status.songId,
  };
};

/** Offline copy of the live engine's state (prepare only; the render is timed separately by RENDER). */
const OFFLINE_PREP = async ({ seconds, mode }) => {
  const { engine } = window.__rig;
  const { AudioEngine } = await import('/js/engine/index.js');
  const sr = engine.ctx.sampleRate;
  const ctx = new OfflineAudioContext(2, Math.round(seconds * sr), sr);
  const off = new AudioEngine({ context: ctx, seed: engine.seed, manifestUrls: engine.manifestUrls });
  const st = engine.getState();
  await off.applyState(st);
  if (mode.droneOff) off.drone.setMode('off');
  if (mode.reverbOff) {
    off.setParam('fx.reverb.returnGain', 0);
    const R = off.fx.reverb;
    if (mode.reverbDisconnect && R.active) R._disconnect(R.active);
  }
  if (mode.chord) {
    off.sustain(true, { when: 0.02 });
    for (const n of mode.chord) off.noteOn(n, 90, { when: 0.05 });
  }
  window.__off = { ctx, off, drone: st.drone?.mode };
  return true;
};
const OFFLINE_RENDER = async () => {
  const { ctx, off, drone } = window.__off;
  const t0 = performance.now();
  await ctx.startRendering();
  const wall = performance.now() - t0;
  const stats = off._debugStats();
  off.dispose?.();
  window.__off = null;
  return { wall, stats, drone };
};

// ------------------------------------------------------------------------------------------------ main
const server = createServer({ appDir: APP_DIR, port: 0 });
const info = await server.listen();
const origin = `http://127.0.0.1:${info.port}`;
// --channel chromium: the full browser in new-headless mode (the real compositor → raster pipeline; the default
// headless shell barely rasters, so paint cost differences between themes do not show there). --headed: a window
// (run under xvfb-run on Linux).
const CHANNEL = arg('channel', null);
const browser = await chromium.launch({
  headless: !argv.includes('--headed'),
  ...(CHANNEL ? { channel: CHANNEL } : {}),
  // --chrome-args "a b": extra Chromium switches (e.g. GPU raster over SwiftShader, as the Mac rasters on the GPU)
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info',
    ...(arg('chrome-args', '') || '').split(/\s+/).filter(Boolean)],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.grantPermissions(['midi'], { origin }).catch(() => {});
await context.addInitScript(INIT);
// --inject-css "<css>": a measurement-only style added after boot (A/B a paint change without editing the tree)
const INJECT_CSS = arg('inject-css', null);
if (THEME || THEMES) {
  const { pinTheme } = await import('../test/integration/lib.mjs');
  await pinTheme(context, THEME || THEMES[0]);
}
const page = await context.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable', { timeDomain: 'threadTicks' }).catch(() => cdp.send('Performance.enable'));
const ev = (fn, a) => page.evaluate(fn, a);
const until = (fn, a, timeout = 60000) => page.waitForFunction(fn, a, { timeout, polling: 100 });

console.log(`[idle-cpu] ${origin}  cpus=${os.cpus().length}  load=${os.loadavg().map((x) => x.toFixed(1)).join(' ')}`);
await page.goto(`${origin}/`);
await until(() => !!(window.__rig && window.__rig.ready), null, 120000);
await ev(() => window.__rig.ready);
const overlay = await page.$('#overlay-start:not([hidden])');
if (overlay) await overlay.click().catch(() => {});
await until(() => window.__rig.engine.ctx && window.__rig.engine.ctx.state === 'running', null, 60000);
// count slotLevel reads (levelMeter's read() looks controller.slotLevel up on every call, so a wrapper sees them)
await ev(() => {
  const c = window.__rig.controller;
  if (typeof c.slotLevel !== 'function' || c.slotLevel.__prof) return;
  const o = c.slotLevel;
  c.slotLevel = function (...a) {
    window.__prof.slot++;
    return o.apply(this, a);
  };
  c.slotLevel.__prof = true;
  // the stereo meters' reads (AnalyserNode reads also include the engine's own fx idle / freeze taps)
  const e = window.__rig.engine;
  for (const an of [e.analyserL, e.analyserR]) {
    if (!an || an.__prof) continue;
    an.__prof = true;
    const proto = Object.getPrototypeOf(an);
    for (const m of ['getFloatTimeDomainData', 'getByteTimeDomainData', 'getFloatFrequencyData', 'getByteFrequencyData']) {
      an[m] = function (...x) {
        window.__prof.man++;
        return proto[m].apply(this, x);
      };
    }
  }
});
if (APP_DIR !== path.join(ROOT, 'app')) console.log(`[idle-cpu] app dir ${APP_DIR}`);
if (INJECT_CSS) {
  await page.addStyleTag({ content: INJECT_CSS });
  console.log(`[idle-cpu] injected CSS: ${INJECT_CSS}`);
}

// the renderer that runs our page = the child with a Web Audio device thread
// Browser has no process() (only BrowserServer does): the Chromium browser process is our child without --type=
const bpid = childPids(process.pid).find((p) => /chrom/i.test(cmdline(p)) && !cmdline(p).includes('--type=')) || null;
const findProcs = () => {
  const kids = bpid ? childPids(bpid) : [];
  const procs = kids.map((pid) => ({ pid, cmd: cmdline(pid) }));
  const renderers = procs.filter((p) => p.cmd.includes('--type=renderer'));
  let renderer = null;
  for (const r of renderers) {
    const names = [...readThreads(r.pid).values()].map((t) => t.name);
    if (names.some((n) => group(n) === 'audio')) renderer = r.pid;
  }
  if (!renderer && renderers.length) renderer = renderers.sort((a, b) => readThreads(b.pid).size - readThreads(a.pid).size)[0].pid;
  const gpu = procs.find((p) => p.cmd.includes('--type=gpu-process'))?.pid || null;
  const others = procs.filter((p) => p.pid !== renderer && p.pid !== gpu).map((p) => p.pid);
  return { renderer, gpu, others };
};
let procs = findProcs();
const LINUX = process.platform === 'linux' && !!procs.renderer;
if (LINUX) {
  const names = [...readThreads(procs.renderer).values()].map((t) => t.name);
  console.log(`[idle-cpu] renderer pid ${procs.renderer} threads: ${[...new Set(names)].join(', ')}`);
}

async function selectSong(name) {
  const id = await ev((n) => Object.values(window.__rig.store.get().songs).find((s) => s.name === n)?.id, name);
  if (!id) throw new Error(`no song named ${name}`);
  const ids = name;
  const ok = await ev((sid) => window.__rig.controller.selectSong(sid), id);
  if (!ok) {
    const st = await ev(() => ({ songId: window.__rig.controller.status.songId, loading: window.__rig.controller.status.loading }));
    if (st.songId !== id) throw new Error(`selectSong(${id}) → ${ok}; status ${JSON.stringify(st)}; ids ${JSON.stringify(ids).slice(0, 400)}`);
  }
  await until((sid) => {
    const c = window.__rig.controller;
    return c.status.songId === sid && !c.status.loading;
  }, id, 120000);
  if (EMULATE_PREFIX) {
    await ev(() => {
      const e = window.__rig.engine;
      // connect without _armSlot, so the idle disarm never undoes it (the old engine connected at prepare)
      for (const sc of e.slots) if (sc && sc.armed === false) sc.inst.output.connect(sc.strip.input);
      for (const x of e.drone?._idle || []) {
        if (x.armed === false) {
          x.armed = true;
          x.inst.output.connect(x.gain);
        }
      }
    });
  }
}

function metricsMap(res) {
  return Object.fromEntries(res.metrics.map((m) => [m.name, m.value]));
}
function threadTicksByGroup(pid) {
  const g = {};
  for (const [tid, t] of readThreads(pid)) {
    const k = Number(tid) === pid ? 'main' : group(t.name); // headless_shell names its main thread after itself
    g[k] = (g[k] || 0) + t.ticks;
  }
  return g;
}
function snapshotProc() {
  if (!LINUX) return null;
  return {
    r: threadTicksByGroup(procs.renderer),
    rt: procTicks(procs.renderer),
    gpu: procs.gpu ? procTicks(procs.gpu) : null,
    br: procTicks(bpid),
    others: procs.others.reduce((a, p) => a + (procTicks(p) || 0), 0),
    t: Date.now(),
  };
}
function procDelta(a, b) {
  if (!a || !b) return null;
  const s = (b.t - a.t) / 1000;
  const pct = (ticks) => Math.round(((ticks / CLK_TCK) / s) * 1000) / 10; // % of one core
  const groups = {};
  for (const k of new Set([...Object.keys(a.r), ...Object.keys(b.r)])) groups[k] = pct((b.r[k] || 0) - (a.r[k] || 0));
  return { renderer: pct(b.rt - a.rt), groups, gpu: b.gpu != null ? pct(b.gpu - a.gpu) : null, browser: pct(b.br - a.br), others: pct(b.others - a.others), seconds: s, rssMB: rssMB(procs.renderer) };
}

/**
 * Wait until background work of a song switch is done (so a window measures the steady idle state, not the
 * neighbour preload): controller ready and not loading, no reverb unit being built, decoded MB unchanged and no long
 * task for 3 s. Capped at 180 s.
 */
async function quiesce() {
  const t0 = Date.now();
  let last = null;
  let stable = 0;
  while (Date.now() - t0 < 180000) {
    const s = await ev(() => {
      const { engine, controller } = window.__rig;
      const busy = !controller.status.ready || controller.status.loading || !!engine.fx?.reverb?._inflight?.size;
      return { ok: !busy, mb: engine._debugStats().decodedMB, lt: window.__prof.longTasks };
    });
    const key = `${s.ok}|${s.mb}|${s.lt}`;
    stable = key === last && s.ok ? stable + 1 : 0;
    last = key;
    if (stable >= 3) return (Date.now() - t0) / 1000;
    await sleep(1000);
  }
  return -1;
}

async function measure(label, { seconds = MEASURE_S, settle = SETTLE_S } = {}) {
  const q = await quiesce();
  if (q < 0) console.log(`   (${label}: background work still running after 180 s)`);
  await sleep(settle * 1000);
  procs = findProcs();
  await ev(() => window.__prof.reset());
  const m0 = metricsMap(await cdp.send('Performance.getMetrics'));
  const p0 = snapshotProc();
  const t0 = Date.now();
  await sleep(seconds * 1000);
  const m1 = metricsMap(await cdp.send('Performance.getMetrics'));
  const p1 = snapshotProc();
  const wall = (Date.now() - t0) / 1000;
  const snap = await ev(SNAP);
  const d = (k) => (m1[k] ?? 0) - (m0[k] ?? 0);
  const pctOf = (sec) => Math.round((sec / wall) * 1000) / 10;
  const cdpM = {
    task: pctOf(d('TaskDuration')),
    script: pctOf(d('ScriptDuration')),
    layout: pctOf(d('LayoutDuration')),
    style: pctOf(d('RecalcStyleDuration')),
    thread: pctOf(d('ThreadTime')),
    process: pctOf(d('ProcessTime')),
    layouts: Math.round(d('LayoutCount') / wall),
    styles: Math.round(d('RecalcStyleCount') / wall),
  };
  const per = (x) => Math.round((x / wall) * 10) / 10;
  const r = {
    label,
    wall,
    load: os.loadavg()[0],
    cdp: cdpM,
    proc: procDelta(p0, p1),
    rate: {
      timeout: per(snap.t.timeout),
      interval: per(snap.t.interval),
      raf: per(snap.t.raf),
      idle: per(snap.t.idle),
      analyser: per(snap.an.float + snap.an.byte + snap.an.freqF + snap.an.freqB),
      slot: per(snap.slot),
      man: per(snap.man),
      mut: per(snap.mut),
    },
    snap,
  };
  const pr = r.proc;
  console.log(`\n[${label}] load ${r.load.toFixed(1)}  renderer ${pr ? pr.renderer : '?'}% ${JSON.stringify(pr?.groups || {})} gpu ${pr?.gpu ?? '?'}% browser ${pr?.browser ?? '?'}% others ${pr?.others ?? '?'}%`);
  console.log(`   cdp task ${cdpM.task}% script ${cdpM.script}% layout ${cdpM.layout}% style ${cdpM.style}% thread ${cdpM.thread}% process ${cdpM.process}%  layouts/s ${cdpM.layouts} styles/s ${cdpM.styles}`);
  console.log(`   rates/s ${JSON.stringify(r.rate)}  longTasks ${snap.longTasks} (${snap.longMs} ms)  anims ${snap.anims.length}`);
  console.log(`   live ${JSON.stringify(snap.live)}  stats ${JSON.stringify(snap.stats)}  rendererRSS ${pr?.rssMB ?? '?'} MB`);
  console.log(`   sites ${snap.sites.map(([k, v]) => `${k}=${per(v)}`).join(' | ')}`);
  console.log(`   mutTop ${snap.mutTop.map(([k, v]) => `${k}=${per(v)}`).join(' | ')}`);
  return r;
}

async function offline(label, mode = {}) {
  if (NO_OFFLINE) return null;
  await ev(OFFLINE_PREP, { seconds: OFFLINE_S, mode });
  await sleep(1500); // let decode / worker threads go quiet before the CPU window opens
  // The offline render thread ('OfflineAudioRen…') may exist only during startRendering(): sample /proc every
  // 100 ms while it runs (the realtime threads are excluded; offline convolvers use no background thread).
  const p0 = LINUX ? readThreads(procs.renderer) : null;
  const seen = new Map();
  let done = false;
  const poll = (async () => {
    while (!done && LINUX) {
      for (const [tid, t] of readThreads(procs.renderer)) if (group(t.name) === 'offline') seen.set(tid, t);
      await sleep(100);
    }
  })();
  const res = await ev(OFFLINE_RENDER).finally(() => (done = true));
  await poll;
  let cpu = null;
  const byName = {};
  if (LINUX) {
    let ticks = 0;
    for (const [tid, t] of seen) {
      const d = t.ticks - (p0.get(tid)?.ticks || 0); // Chromium may reuse the render thread across renders
      byName[t.name] = (byName[t.name] || 0) + d;
      ticks += d;
    }
    cpu = ticks / CLK_TCK;
  }
  // share of one core the same graph needs in realtime: CPU seconds / audio seconds (wall as the fallback)
  const out = { label, wallMs: Math.round(res.wall), cpuS: cpu, pct: Math.round(((cpu ?? res.wall / 1000) / OFFLINE_S) * 1000) / 10, pctWall: Math.round((res.wall / 1000 / OFFLINE_S) * 1000) / 10, voices: res.stats.voices, nodes: res.stats.nodes, threads: byName };
  console.log(`   offline[${label}] ${OFFLINE_S}s audio: wall ${out.wallMs} ms (${out.pctWall}%)  render CPU ${cpu?.toFixed(2)} s (${out.pct}% of a core)  voices ${out.voices} nodes ${out.nodes}  threads ${JSON.stringify(byName)}`);
  return out;
}

const want = (k) => !ONLY || ONLY.includes(k);
const results = [];
const rec = async (key, label, fn, offMode) => {
  if (!want(key)) return;
  const r = await measure(`${key} ${label}`);
  r.key = key;
  if (offMode !== undefined) r.offline = await offline(key, offMode || {});
  results.push(r);
  if (fn) await fn();
};

try {
  await selectSong(SONGS.sunday);
  const droneMode = await ev(() => window.__rig.engine.drone.getState().mode);
  console.log(`[idle-cpu] Sunday Pad + Piano selected; drone ${droneMode}; view ${await ev(() => document.body.dataset.view)}`);

  if (THEMES) {
    for (let round = 0; round < ROUNDS; round++) {
      for (const id of THEMES) {
        await ev(async (tid) => {
          window.__rig.store.set('settings.theme', tid);
          const t0 = performance.now();
          while (window.__rig.theme.current !== tid && performance.now() - t0 < 10000) {
            await new Promise((r) => setTimeout(r, 50));
          }
          await window.__rig.theme.pending;
          await document.fonts.ready;
        }, id);
        const shown = await ev(() => document.documentElement.dataset.theme);
        if (shown !== id) throw new Error(`theme ${id} did not apply (html[data-theme]=${shown})`);
        const r = await measure(`A:${id} (round ${round + 1}) Sunday, Perform, drone on`);
        r.key = `A:${id}`;
        results.push(r);
      }
    }
  }
  await rec('A', 'baseline Sunday, Perform, drone on', null, {});
  if (want('B')) {
    const prev = await ev(() => window.__rig.store.currentSong().patch.drone?.mode || window.__rig.engine.drone.getState().mode);
    await ev(() => window.__rig.engine.drone.setMode('off'));
    await rec('B', 'drone off', null, {});
    if (want('K')) {
      await ev(async () => {
        const e = window.__rig.engine;
        e.noteOn(67, 80);
        await new Promise((r) => setTimeout(r, 400));
        e.noteOff(67);
      });
      await sleep(12000); // release + reverb tail
      await rec('K', 'drone off, after one note (pad has sounded)');
    }
    await ev((m) => window.__rig.engine.drone.setMode(m), prev);
  }
  if (want('C1') || want('C2')) {
    const rg = await ev(() => window.__rig.engine.getParam('fx.reverb.returnGain'));
    await ev(() => window.__rig.engine.setParam('fx.reverb.returnGain', 0));
    await rec('C1', 'reverb returnGain 0 (convolver still fed)', null, { reverbOff: true });
    await ev(() => {
      const e = window.__rig.engine;
      const R = e.fx.reverb;
      window.__profActive = R.active;
      if (R.active) R._disconnect(R.active);
      e._trimReverbUnits();
    });
    await rec('C2', 'reverb unit disconnected + idle units dropped', null, { reverbOff: true, reverbDisconnect: true });
    await ev((v) => {
      const e = window.__rig.engine;
      const R = e.fx.reverb;
      if (window.__profActive) R._connect(window.__profActive);
      e.setParam('fx.reverb.returnGain', v);
    }, rg);
  }
  if (want('D')) {
    await ev(() => window.__rig.controller.setLowResource(true));
    await rec('D', 'low-resource (meters off, taps off)');
    await ev(() => window.__rig.controller.setLowResource(false));
  }
  if (want('E')) {
    await page.click('#view-switch button[data-value="edit"]');
    await until(() => document.body.dataset.view === 'edit');
    await rec('E', 'Edit view');
    await page.click('#view-switch button[data-value="perform"]');
    await until(() => document.body.dataset.view === 'perform');
  }
  const SPIN_OFF = '.song-loading-spin { animation: none !important; }';
  if (want('I')) {
    await page.addStyleTag({ content: SPIN_OFF }).then((h) => h.evaluate((el) => (el.id = 'idle-cpu-spin')));
    await rec('I', 'A + hidden spinner animation paused');
    await ev(() => document.getElementById('idle-cpu-spin')?.remove());
  }
  if (want('J')) {
    await page.addStyleTag({ content: SPIN_OFF }).then((h) => h.evaluate((el) => (el.id = 'idle-cpu-spin')));
    await ev(() => window.__rig.controller.setLowResource(true));
    await rec('J', 'low-resource + spinner paused (UI floor)');
    await ev(() => {
      window.__rig.controller.setLowResource(false);
      document.getElementById('idle-cpu-spin')?.remove();
    });
  }
  if (want('W')) {
    await ev(() => window.dispatchEvent(new CustomEvent('rig:window-visible', { detail: { visible: false } })));
    await rec('W', "'rig:window-visible' {visible:false}, menuBarMode off");
    await ev(() => window.dispatchEvent(new CustomEvent('rig:window-visible', { detail: { visible: true } })));
  }
  if (want('F1')) {
    await ev(() => window.__rig.controller.setWindowVisible(false));
    await rec('F1', 'setWindowVisible(false), menuBarMode off');
  }
  if (want('F2')) {
    await ev(() => {
      window.__rig.store.set('settings.menuBarMode', true);
      window.__rig.controller.setWindowVisible(false);
    });
    await rec('F2', 'setWindowVisible(false), menuBarMode on');
  }
  await ev(() => {
    window.__rig.store.set('settings.menuBarMode', false);
    window.__rig.controller.setWindowVisible(null);
    if (window.__rig.controller.status.lowResource) window.__rig.controller.setLowResource(false);
  });
  if (want('H')) {
    await ev(() => {
      for (const n of [48, 60, 64, 67]) window.__rig.engine.noteOn(n, 90);
      window.__rig.engine.sustain(true);
    });
    await rec('H', 'playing: C chord held (Sunday)', null, { chord: [48, 60, 64, 67] });
    await ev(() => {
      window.__rig.engine.sustain(false);
      window.__rig.engine.allNotesOff();
    });
  }
  if (want('G1')) {
    await selectSong(SONGS.glass);
    await rec('G1', 'Glass Ocean (synth only)', null, {});
  }
  if (want('G2')) {
    await selectSong(SONGS.grand);
    await rec('G2', 'Grand Piano (sampler only)', null, {});
  }
} catch (e) {
  console.log(`[idle-cpu] FAILED: ${e && e.stack ? e.stack : e}`);
} finally {
  console.log(`\n[idle-cpu] console errors: ${errors.length}${errors.length ? '\n  ' + errors.slice(0, 5).join('\n  ') : ''}`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ when: new Date().toISOString(), cpus: os.cpus().length, results, errors }, null, 2));
  // summary table
  const rows = results.map((r) => ({
    cfg: r.key,
    rend: r.proc?.renderer ?? '',
    main: r.proc?.groups.main ?? '',
    audio: r.proc?.groups.audio ?? '',
    rvbBg: r.proc?.groups.reverbBg ?? 0,
    comp: r.proc?.groups.compositor ?? 0,
    rast: r.proc?.groups.raster ?? 0,
    gpu: r.proc?.gpu ?? '',
    task: r.cdp.task,
    script: r.cdp.script,
    layout: r.cdp.layout,
    style: r.cdp.style,
    dsp: r.offline ? r.offline.pct : '',
    raf: r.rate.raf,
    rcs: r.cdp.styles,
    lay: r.cdp.layouts,
    tmr: Math.round((r.rate.timeout + r.rate.interval) * 10) / 10,
    an: r.rate.analyser,
    slot: r.rate.slot,
    man: r.rate.man,
    mut: r.rate.mut,
    osc: r.snap.live.OscillatorNode || 0,
    src: Object.values(r.snap.live).reduce((a, b) => a + b, 0),
    voices: r.snap.stats.voices,
    conv: r.snap.units.length,
    long: r.snap.longTasks,
    rssMB: r.proc?.rssMB ?? '',
    decMB: Math.round(r.snap.stats.decodedMB),
  }));
  if (rows.length) {
    const cols = Object.keys(rows[0]);
    const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
    console.log('\n' + cols.map((c, i) => c.padEnd(w[i])).join(' '));
    for (const r of rows) console.log(cols.map((c, i) => String(r[c]).padEnd(w[i])).join(' '));
  }
  await browser.close();
  await server.close?.();
  process.exit(0);
}
