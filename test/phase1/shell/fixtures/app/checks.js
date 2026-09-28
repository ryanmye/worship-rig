// Shared in-page checks for the shell Playwright and Electron boot tests.
// The test runner serves this folder with js/ symlinked to the real app/js.
import { Recorder, loadWorkletModule, WORKLET_URL } from './js/recorder.js';
import { parseWavHeader, int16ToFloat32 } from './js/shared/wav.js';
import { MidiInput } from './js/midi.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal "engine": oscillator → gain → recordTap (the tap is NOT connected to the destination). */
export function toneEngine(ctx, freq = 440, amp = 0.5) {
  const osc = new OscillatorNode(ctx, { frequency: freq });
  const g = new GainNode(ctx, { gain: amp });
  const tap = new GainNode(ctx);
  osc.connect(g).connect(tap);
  osc.start();
  return { ctx, recordTap: tap, stop: () => osc.stop() };
}

export function analyzeWav(buf) {
  const h = parseWavHeader(buf);
  const pcm = new Int16Array(buf.slice(h.dataOffset, h.dataOffset + h.availableBytes));
  const [L, R] = int16ToFloat32(pcm, h.channels);
  let sum = 0;
  let peak = 0;
  let nan = 0;
  for (let i = 0; i < L.length; i++) {
    const v = L[i];
    if (Number.isNaN(v)) nan++;
    sum += v * v;
    peak = Math.max(peak, Math.abs(v), Math.abs(R[i]));
  }
  const frames = L.length;
  return {
    header: { format: h.format, channels: h.channels, sampleRate: h.sampleRate, bitsPerSample: h.bitsPerSample, dataBytes: h.dataBytes, riffOk: new DataView(buf).getUint32(4, true) === 36 + h.dataBytes },
    fileBytes: buf.byteLength,
    frames,
    seconds: frames / h.sampleRate,
    rmsDb: 20 * Math.log10(Math.sqrt(sum / Math.max(1, frames)) || 1e-12),
    peak,
    nan,
  };
}

/** In-page mock of window.rig (behaves like main.js: positional file, header patches). */
export function mockRig() {
  let bytes = new Uint8Array(0);
  const log = { opens: 0, writes: 0, patches: 0, closes: 0 };
  return {
    isElectron: true,
    log,
    bytes: () => bytes.buffer,
    streamOpen: async (name) => ((log.opens += 1), { id: 1, path: `/mock/${name}` }),
    streamWrite: async (id, buf) => {
      const b = new Uint8Array(buf);
      const out = new Uint8Array(bytes.length + b.length);
      out.set(bytes);
      out.set(b, bytes.length);
      bytes = out;
      log.writes += 1;
      return { bytes: bytes.length };
    },
    streamPatchHeader: async (id, buf) => ((log.patches += 1), bytes.set(new Uint8Array(buf), 0), { ok: true }),
    streamClose: async () => ((log.closes += 1), { path: '/mock/x.wav', bytes: bytes.length }),
  };
}

/**
 * Record `seconds` of a 440 Hz tone through the real worklet into a sink.
 * @returns analysis + recorder result summary
 */
export async function recordOnce({ sink = 'opfs', rig, seconds = 1, headerIntervalSec = 10 } = {}) {
  const ctx = new AudioContext();
  await ctx.resume();
  const eng = toneEngine(ctx);
  const rec = new Recorder({ engine: eng, sink, rig: rig ?? null, autoDownload: false, headerIntervalSec });
  const levels = [];
  const states = [];
  rec.addEventListener('level', (e) => levels.push(e.detail.peak));
  rec.addEventListener('state', (e) => states.push(e.detail.state));
  const t0 = performance.now();
  const started = await rec.start();
  await sleep(seconds * 1000);
  const elapsedAtStop = rec.elapsed;
  const res = await rec.stop();
  const wall = (performance.now() - t0) / 1000;
  eng.stop();
  let analysis = null;
  if (res && res.blob) analysis = analyzeWav(await res.blob.arrayBuffer());
  else if (rig && rig.bytes) analysis = analyzeWav(rig.bytes());
  await ctx.close();
  return {
    started,
    ctxRate: ctx.sampleRate,
    wall,
    elapsedAtStop,
    result: res && { sink: res.sink, filename: res.filename, durationSec: res.durationSec, dataBytes: res.dataBytes, path: res.path || null, bytes: res.bytes, error: res.error || null },
    levels: levels.length,
    maxLevel: Math.max(0, ...levels),
    states,
    analysis,
    rigLog: rig && rig.log ? { ...rig.log } : null,
  };
}

/** The first addModule fails (non-blob URL) → loader retries via a blob: URL. */
export async function blobRetry() {
  const ctx = new AudioContext();
  const real = ctx.audioWorklet.addModule.bind(ctx.audioWorklet);
  const fakeCtx = { audioWorklet: { addModule: (u) => (String(u).startsWith('blob:') ? real(u) : Promise.reject(new Error('simulated scheme failure'))) } };
  const how = await loadWorkletModule(fakeCtx, WORKLET_URL);
  let nodeOk = false;
  try {
    new AudioWorkletNode(ctx, 'rig-recorder', { numberOfInputs: 1, numberOfOutputs: 0 });
    nodeOk = true;
  } catch {
    nodeOk = false;
  }
  await ctx.close();
  return { how, nodeOk };
}

export async function unavailableRecorder() {
  const ctx = new AudioContext();
  const eng = { ctx, recordTap: new GainNode(ctx) };
  const rec = new Recorder({ engine: eng, sink: 'memory', workletUrl: new URL('./does-not-exist.js', location.href), autoDownload: false });
  const r = await rec.start();
  await ctx.close();
  return { ok: r.ok, state: rec.state };
}

/** negative=true adds 416/404 probes (they log "Failed to load resource" console errors, so run them on a throw-away page). */
export async function httpChecks({ padUrl, negative = false } = {}) {
  const out = {};
  const js = await fetch('./js/recorder.js');
  out.jsType = js.headers.get('content-type');
  const wk = await fetch('./js/worklets/recorder-processor.js');
  out.workletType = wk.headers.get('content-type');
  out.health = await (await fetch('/api/health')).json();
  const pads = await (await fetch('/api/pads')).json();
  out.pads = pads;
  const url = padUrl || (pads[0] && pads[0].url);
  if (url) {
    const r = await fetch(url, { headers: { Range: 'bytes=0-99' } });
    out.range = { status: r.status, contentRange: r.headers.get('content-range'), length: (await r.arrayBuffer()).byteLength, type: r.headers.get('content-type') };
    if (!negative) return out;
    const bad = await fetch(url, { headers: { Range: 'bytes=99999999-' } });
    out.range416 = bad.status;
    const base = url.slice(0, url.indexOf('/', '/pads/'.length) + 1);
    out.traversal = [];
    for (const p of ['..%2Fsecret.mp3', '%2e%2e/secret.mp3', '..%5Csecret.mp3']) out.traversal.push((await fetch(base + p)).status);
    out.dotdot = (await fetch(`${location.origin}/pads/../secret.mp3`)).status;
  }
  return out;
}

/** <audio> element streaming a pad file through MediaElementSource must produce signal (same-origin). */
export async function mediaElementRms(url, ms = 800) {
  const ctx = new AudioContext();
  const a = new Audio();
  a.src = url;
  a.loop = true;
  const src = ctx.createMediaElementSource(a);
  const an = new AnalyserNode(ctx, { fftSize: 2048 });
  src.connect(an);
  await a.play();
  await sleep(ms);
  const buf = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(buf);
  let s = 0;
  for (const v of buf) s += v * v;
  a.pause();
  await ctx.close();
  return Math.sqrt(s / buf.length);
}

export async function midiInit() {
  const m = new MidiInput();
  const reasons = [];
  m.addEventListener('unavailable', (e) => reasons.push(`${e.detail.reason}: ${e.detail.message}`));
  const ok = await m.init();
  return { ok, reason: m.unavailableReason, reasons, inputs: m.inputs.length };
}

export async function audioRunning() {
  const ctx = new AudioContext();
  await ctx.resume().catch(() => {});
  const t0 = ctx.currentTime;
  await sleep(300);
  const r = { state: ctx.state, advanced: ctx.currentTime > t0, sampleRate: ctx.sampleRate };
  await ctx.close();
  return r;
}

/**
 * H2: start a controller (memory store, inert engine) with the page's real navigator.locks.
 * Exposes window.__instance = {status, store} and resolves with the status right after start().
 */
export async function instanceGuard() {
  const { createStore, memoryStorage } = await import('./js/store.js');
  const { createController } = await import('./js/controller.js');
  const store = createStore({ storage: memoryStorage(), autoFlush: false, warn: () => {} });
  const engine = new EventTarget();
  engine.started = 0;
  engine.start = () => {
    engine.started += 1;
    return Promise.resolve();
  };
  engine.prepare = () => Promise.resolve(1);
  const ctl = createController({ store, engine, midi: null, recorder: null, rig: null, heartbeat: false, indexedDB: null });
  ctl.addEventListener('warn', () => {});
  const origWarn = console.warn;
  console.warn = () => {};
  await ctl.start();
  console.warn = origWarn;
  window.__instance = { ctl, store, engine };
  return { instance: ctl.status.instance, message: ctl.status.instanceMessage, started: engine.started, readOnly: store.loadInfo.readOnly };
}
