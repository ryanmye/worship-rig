// Worship Rig recorder (SPEC §0.7, §7; REVIEW 1.6, 1.8, 6.6).
// Captures engine.recordTap (post-clip, exact output) with an AudioWorklet and streams 16-bit stereo WAV to:
//   • Electron: window.rig.stream* → ~/Music/Worship Rig/Rig YYYY-MM-DD HHmm.wav (header patched every 10 s)
//   • Chrome:   showSaveFilePicker writable (NOTE: Chrome writes to a hidden .crswap file and only creates the real
//               file on close(), so a tab crash loses the take — README says so)
//   • OPFS:     navigator.storage (no prompt; used by tests and as the fallback, then offered as a download)
//   • memory:   last resort (warns above 10 minutes; stops itself at 60 minutes so a long service can't OOM the page)
// Events: 'state' {state, result?, reason?}, 'level' {peakL, peakR, peak}, 'warn' {message}.
import { wavHeader } from './shared/wav.js';

export const WORKLET_URL = new URL('./worklets/recorder-processor.js', import.meta.url);
export const PROCESSOR_NAME = 'rig-recorder';
const CHANNELS = 2;

/** `Rig YYYY-MM-DD HHmm.wav` (local time). */
export function recordingFilename(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `Rig ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}.wav`;
}

const loadedByCtx = new WeakMap();

/**
 * addModule(url), retrying via a blob: URL of the fetched source (REVIEW 1.6). Cached per context.
 * @returns {Promise<'direct'|'blob'>}
 */
export function loadWorkletModule(ctx, url = WORKLET_URL, { fetchFn = globalThis.fetch } = {}) {
  const key = String(url);
  let perCtx = loadedByCtx.get(ctx);
  if (!perCtx) loadedByCtx.set(ctx, (perCtx = new Map()));
  if (perCtx.has(key)) return perCtx.get(key);
  const p = (async () => {
    try {
      await ctx.audioWorklet.addModule(key);
      return 'direct';
    } catch (first) {
      console.warn('[recorder] addModule failed, retrying via blob URL:', first && first.message);
      const src = await (await fetchFn(key)).text();
      const blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      try {
        await ctx.audioWorklet.addModule(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      return 'blob';
    }
  })();
  perCtx.set(key, p);
  p.catch(() => perCtx.delete(key));
  return p;
}

/** Trigger a browser download of a Blob. */
export function downloadBlob(blob, filename, doc = globalThis.document) {
  if (!doc || !doc.createElement) return false;
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  (doc.body || doc.documentElement).appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

// ---------------------------------------------------------------------------------------------
// sinks: open(sr, ch) → write(ArrayBuffer) → patchHeader(dataBytes) → close(dataBytes) → result
class ChainSink {
  constructor() {
    this.chain = Promise.resolve();
    this.error = null;
  }
  _q(fn) {
    this.chain = this.chain.then(() => (this.error ? undefined : fn())).catch((err) => {
      this.error = this.error || err;
    });
    return this.chain;
  }
}

export class ElectronSink extends ChainSink {
  constructor(rig, filename, { flushBytes = 65536 } = {}) {
    super();
    this.kind = 'electron';
    this.rig = rig;
    this.filename = filename;
    this.flushBytes = flushBytes;
    this.pending = [];
    this.pendingBytes = 0;
    this.path = null;
    this.id = null;
  }
  async open(sampleRate, channels) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    const r = await this.rig.streamOpen(this.filename);
    if (!r || r.error || r.id === undefined) throw new Error((r && r.error) || 'streamOpen failed');
    this.id = r.id;
    this.path = r.path || this.filename;
    const w = await this.rig.streamWrite(this.id, wavHeader(sampleRate, channels, 0));
    if (w && w.error) throw new Error(w.error);
  }
  _flush() {
    if (!this.pendingBytes) return this.chain;
    const out = new Uint8Array(this.pendingBytes);
    let o = 0;
    for (const b of this.pending) {
      out.set(new Uint8Array(b), o);
      o += b.byteLength;
    }
    this.pending = [];
    this.pendingBytes = 0;
    return this._q(async () => {
      const r = await this.rig.streamWrite(this.id, out.buffer);
      if (r && r.error) throw new Error(r.error);
    });
  }
  write(buf) {
    this.pending.push(buf);
    this.pendingBytes += buf.byteLength;
    if (this.pendingBytes >= this.flushBytes) this._flush();
  }
  patchHeader(dataBytes) {
    this._flush();
    return this._q(async () => {
      const r = await this.rig.streamPatchHeader(this.id, wavHeader(this.sampleRate, this.channels, dataBytes));
      if (r && r.error) throw new Error(r.error);
    });
  }
  async close(dataBytes) {
    this._flush();
    await this.chain;
    // M6: the final header is always requested, even after a write error (main also fixes sizes on close)
    try {
      await this.rig.streamPatchHeader(this.id, wavHeader(this.sampleRate, this.channels, dataBytes));
    } catch {
      /* main re-derives the sizes from the file */
    }
    const r = await this.rig.streamClose(this.id);
    if (this.error) throw this.error;
    if (r && r.error) throw new Error(r.error);
    return { path: (r && r.path) || this.path, bytes: r && r.bytes };
  }
  async abort() {
    if (this.id !== null) await this.rig.streamClose(this.id);
  }
}

/** Positioned writes into a FileSystemWritableFileStream (FSA picker or OPFS). */
export class WritableSink extends ChainSink {
  constructor(fileHandle, filename, kind) {
    super();
    this.kind = kind;
    this.handle = fileHandle;
    this.filename = filename;
    this.pos = 0;
  }
  async open(sampleRate, channels) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.writable = await this.handle.createWritable({ keepExistingData: false });
    await this.writable.write({ type: 'write', position: 0, data: wavHeader(sampleRate, channels, 0) });
    this.pos = 44;
  }
  write(buf) {
    const position = this.pos;
    this.pos += buf.byteLength;
    this._q(() => this.writable.write({ type: 'write', position, data: buf }));
  }
  patchHeader(dataBytes) {
    return this._q(() => this.writable.write({ type: 'write', position: 0, data: wavHeader(this.sampleRate, this.channels, dataBytes) }));
  }
  async close(dataBytes) {
    await this.patchHeader(dataBytes);
    await this.chain;
    if (this.error) throw this.error;
    await this.writable.close();
    const file = await this.handle.getFile();
    return { file, blob: file, bytes: file.size };
  }
  async abort() {
    try {
      await this.writable?.abort();
    } catch {
      /* ignore */
    }
  }
}

export class MemorySink {
  constructor(filename) {
    this.kind = 'memory';
    this.filename = filename;
    this.chunks = [];
    this.error = null;
  }
  async open(sampleRate, channels) {
    this.sampleRate = sampleRate;
    this.channels = channels;
  }
  write(buf) {
    this.chunks.push(buf);
  }
  patchHeader() {
    return Promise.resolve();
  }
  async close(dataBytes) {
    const blob = new Blob([wavHeader(this.sampleRate, this.channels, dataBytes), ...this.chunks], { type: 'audio/wav' });
    this.chunks = [];
    return { blob, bytes: blob.size };
  }
  async abort() {
    this.chunks = [];
  }
}

async function opfsFileHandle(nav, filename, keep = 5) {
  const root = await nav.storage.getDirectory();
  const dir = await root.getDirectoryHandle('recordings', { create: true });
  // prune old takes (names sort by date)
  try {
    const names = [];
    for await (const [name, h] of dir.entries()) if (h.kind === 'file' && name.endsWith('.wav')) names.push(name);
    names.sort();
    for (const n of names.slice(0, Math.max(0, names.length - (keep - 1)))) await dir.removeEntry(n).catch(() => {});
  } catch {
    /* entries() unsupported → no pruning */
  }
  let name = filename;
  for (let i = 2; i < 100; i++) {
    try {
      await dir.getFileHandle(name);
      name = filename.replace(/\.wav$/, ` ${i}.wav`);
    } catch {
      break;
    }
  }
  return { handle: await dir.getFileHandle(name, { create: true }), name };
}

// ---------------------------------------------------------------------------------------------
export class Recorder extends EventTarget {
  /**
   * @param {object} o
   * @param {{ctx: BaseAudioContext, recordTap: AudioNode}} o.engine
   * @param {Window} [o.win]
   * @param {object} [o.rig]  window.rig (Electron)
   * @param {'auto'|'electron'|'fsa'|'opfs'|'memory'} [o.sink='auto']
   * @param {boolean} [o.autoDownload=true]  offer the file as a download when a fallback (OPFS/memory) sink was used
   * @param {URL|string} [o.workletUrl]
   * @param {number} [o.batchFrames=4096]
   * @param {number} [o.headerIntervalSec=10]
   * @param {number} [o.memoryWarnSec=600]
   * @param {number} [o.memoryMaxSec=3600]  the memory sink stops (and offers the file) after this long
   * @param {() => number} [o.now]
   */
  constructor(o = {}) {
    super();
    this.engine = o.engine;
    this.win = o.win || globalThis;
    this.rig = o.rig !== undefined ? o.rig : this.win.rig;
    this.defaultSink = o.sink || 'auto';
    this.autoDownload = o.autoDownload !== false;
    this.workletUrl = o.workletUrl || WORKLET_URL;
    this.batchFrames = o.batchFrames || 4096;
    this.headerIntervalSec = o.headerIntervalSec ?? 10;
    this.memoryWarnSec = o.memoryWarnSec ?? 600;
    this.memoryMaxSec = o.memoryMaxSec ?? 3600;
    this.now = o.now || (() => Date.now());
    this._state = 'idle';
    this._frames = 0;
    this._bytes = 0;
    this._onPageHide = () => {
      if (this.isRecording) this.stop();
    };
  }

  get state() {
    return this._state;
  }
  get isRecording() {
    return this._state === 'recording';
  }
  /** Seconds recorded so far (sample-accurate, chunk granularity). */
  get elapsed() {
    return this._sr ? this._frames / this._sr : 0;
  }

  _setState(state, extra = {}) {
    this._state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: { state, ...extra } }));
  }
  _warn(message) {
    console.warn(`[recorder] ${message}`);
    this.dispatchEvent(new CustomEvent('warn', { detail: { message } }));
  }

  /** Load the worklet on the engine's current context. @returns {Promise<boolean>} */
  async init() {
    const ctx = this.engine && this.engine.ctx;
    if (!ctx || !ctx.audioWorklet || !this.engine.recordTap) {
      this._unavailable('no audio context');
      return false;
    }
    try {
      await loadWorkletModule(ctx, this.workletUrl);
      if (this._state === 'unavailable') this._setState('idle');
      return true;
    } catch (err) {
      this._unavailable((err && err.message) || String(err));
      return false;
    }
  }

  _unavailable(reason) {
    this._warn(`Recording unavailable: ${reason}`);
    this._setState('unavailable', { reason });
  }

  async _makeSink(kind, filename) {
    const nav = this.win.navigator;
    if (kind === 'auto') {
      if (this.rig && this.rig.isElectron) kind = 'electron';
      else if (typeof this.win.showSaveFilePicker === 'function') kind = 'fsa';
      else kind = nav && nav.storage && nav.storage.getDirectory ? 'opfs' : 'memory';
    }
    if (kind === 'electron') return new ElectronSink(this.rig, filename);
    if (kind === 'fsa') {
      try {
        const handle = await this.win.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'WAV audio', accept: { 'audio/wav': ['.wav'] } }],
        });
        return new WritableSink(handle, handle.name || filename, 'fsa');
      } catch (err) {
        if (err && err.name === 'AbortError') return null; // user cancelled
        this._warn(`Save dialog unavailable (${err && err.message}); recording in the browser and offering a download instead`);
        return this._makeSink(nav && nav.storage && nav.storage.getDirectory ? 'opfs' : 'memory', filename);
      }
    }
    if (kind === 'opfs') {
      try {
        const { handle, name } = await opfsFileHandle(nav, filename);
        return new WritableSink(handle, name, 'opfs');
      } catch (err) {
        this._warn(`Browser storage unavailable (${err && err.message}); recording to memory`);
        return new MemorySink(filename);
      }
    }
    return new MemorySink(filename);
  }

  /**
   * Start recording. Call directly from the click handler (Chrome's save dialog needs the user gesture).
   * @param {{sink?:string, filename?:string}} [o]
   * @returns {Promise<{ok:boolean, sink?:string, filename?:string, path?:string, cancelled?:boolean, error?:string}>}
   */
  async start(o = {}) {
    if (this._state === 'recording' || this._state === 'starting' || this._state === 'stopping') return { ok: false, error: `busy (${this._state})` };
    const filename = o.filename || recordingFilename(new Date(this.now()));
    this._setState('starting');
    let sink;
    try {
      sink = await this._makeSink(o.sink || this.defaultSink, filename);
    } catch (err) {
      this._setState('idle');
      return { ok: false, error: (err && err.message) || String(err) };
    }
    if (!sink) {
      this._setState('idle');
      return { ok: false, cancelled: true };
    }
    if (!(await this.init())) {
      await sink.abort?.();
      return { ok: false, error: 'Recording unavailable' };
    }
    const ctx = this.engine.ctx;
    this._sr = ctx.sampleRate;
    this._frames = 0;
    this._bytes = 0;
    this._lastHeaderFrames = 0;
    this._memWarned = false;
    this._memCapped = false;
    this._errored = false;
    try {
      await sink.open(this._sr, CHANNELS);
    } catch (err) {
      this._warn(`could not open the recording file: ${err && err.message}`);
      await sink.abort?.();
      if (sink.kind !== 'memory') {
        this._setState('idle');
        return this.start({ ...o, sink: 'memory', filename });
      }
      this._setState('idle');
      return { ok: false, error: (err && err.message) || String(err) };
    }
    let node;
    try {
      node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: CHANNELS,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { batchFrames: this.batchFrames },
      });
    } catch (err) {
      await sink.abort?.();
      this._unavailable((err && err.message) || String(err));
      return { ok: false, error: 'Recording unavailable' };
    }
    this._sink = sink;
    this._node = node;
    this._stopped = null;
    node.port.onmessage = (e) => this._onMessage(e.data);
    this.engine.recordTap.connect(node);
    node.port.postMessage({ cmd: 'start' });
    this._ctx = ctx;
    this._filename = sink.filename || filename;
    this.win.addEventListener?.('pagehide', this._onPageHide);
    this._setState('recording', { sink: sink.kind, filename: this._filename, path: sink.path || null });
    return { ok: true, sink: sink.kind, filename: this._filename, path: sink.path || null };
  }

  _onMessage(m) {
    if (!m) return;
    if (m.type === 'chunk') {
      const sink = this._sink;
      if (!sink) return;
      this._frames += m.frames;
      this._bytes += m.buf.byteLength;
      sink.write(m.buf);
      if (sink.error && !this._errored) {
        this._errored = true;
        this._warn(`writing the recording failed: ${sink.error.message}`);
      }
      if (this._frames - this._lastHeaderFrames >= this.headerIntervalSec * this._sr) {
        this._lastHeaderFrames = this._frames;
        sink.patchHeader(this._bytes);
      }
      if (sink.kind === 'memory' && !this._memWarned && this.elapsed > this.memoryWarnSec) {
        this._memWarned = true;
        this._warn(`Recording has been kept in memory for over ${Math.round(this.memoryWarnSec / 60)} minutes; stop and save it soon.`);
      }
      if (sink.kind === 'memory' && !this._memCapped && this.elapsed >= this.memoryMaxSec) {
        this._memCapped = true;
        this._warn(`Recording stopped after ${Math.round(this.memoryMaxSec / 60)} minutes (it was kept in memory, which can't hold more safely). The file is being saved; press Record to continue in a new take.`);
        this.stop();
      }
      const peak = Math.max(m.peakL, m.peakR);
      this.dispatchEvent(new CustomEvent('level', { detail: { peakL: m.peakL, peakR: m.peakR, peak } }));
    } else if (m.type === 'stopped') {
      if (this._stopped) this._stopped();
    }
  }

  /**
   * Stop and finalise the file.
   * @returns {Promise<{sink, filename, durationSec, bytes, path?, blob?, file?}|null>}
   */
  async stop() {
    if (this._state !== 'recording') return null;
    this._setState('stopping');
    const node = this._node;
    const sink = this._sink;
    this.win.removeEventListener?.('pagehide', this._onPageHide);
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 1500);
      this._stopped = () => {
        clearTimeout(t);
        resolve();
      };
      try {
        node.port.postMessage({ cmd: 'stop' });
      } catch {
        resolve();
      }
    });
    try {
      this.engine.recordTap.disconnect(node);
    } catch {
      /* tap may belong to a closed context */
    }
    try {
      node.port.postMessage({ cmd: 'dispose' });
      node.port.onmessage = null;
    } catch {
      /* ignore */
    }
    this._node = null;
    this._sink = null;
    const base = { sink: sink.kind, filename: this._filename, durationSec: this._frames / this._sr, frames: this._frames, sampleRate: this._sr, dataBytes: this._bytes };
    let result;
    try {
      result = { ...base, ...(await sink.close(this._bytes)) };
    } catch (err) {
      this._warn(`could not finish the recording: ${err && err.message}`);
      result = { ...base, error: (err && err.message) || String(err) };
    }
    if (result.blob && (sink.kind === 'opfs' || sink.kind === 'memory')) {
      result.download = () => downloadBlob(result.blob, result.filename, this.win.document);
      if (this.autoDownload && this.defaultSink === 'auto') result.download();
    }
    this._setState('idle', { result });
    return result;
  }

  /** Toggle helper for the REC button. */
  async toggle(o) {
    return this.isRecording ? this.stop() : this.start(o);
  }
}

/** Convenience factory. */
export function createRecorder(o) {
  return new Recorder(o);
}
