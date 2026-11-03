'use strict';
// In-app GarageBand / Logic importer, Electron main side (v11-importer; Settings › My Samples › "Import from
// GarageBand / Logic…"). main.js owns the IPC (rig:garageBand*; the isOurFrame guard of every handler) and hands
// this module a worker factory. Every scan and every import runs in a fresh worker process
// (tools/exs/import-worker.mjs: an Electron utilityProcess in the app, a child_process.fork in the tests), so neither
// the main process (which also serves the samples) nor the renderer (which plays them) ever blocks on the library
// walk or the conversions.
//
// Security: the renderer never sends a path. A scan returns opaque keys; an import takes keys from the latest scan
// only, and the worker re-checks every .exs path (realpath inside the library roots) and the output folder (main's
// My Samples folder, which must be inside a scan root and outside app/). Limits: LIMITS.maxPerImport instruments and
// LIMITS.maxTotalMb estimated per run, one operation at a time, a scan timeout. The output is personal-use Apple
// content: it goes to ~/Music/Worship Rig/Samples (or RIG_USER_SAMPLES), never into the app or the repo's app/.
const path = require('node:path');
const crypto = require('node:crypto');

/** Size / count limits (mirrored by tools/exs/importer.mjs APP_LIMITS, which the worker enforces again). */
const LIMITS = Object.freeze({
  maxPerImport: 40, maxTotalMb: 2048, scanTimeoutMs: 10 * 60 * 1000, cancelGraceMs: 5000,
});
/** The worker entry (packaged: package.json build.files lists tools/exs/*.mjs the importer needs). */
const WORKER_FILE = path.join(__dirname, 'tools', 'exs', 'import-worker.mjs');
const PROGRESS_MIN_MS = 100;

/**
 * Worker adapter over child_process.fork (tests; plain Node).
 * @param {string} [file]
 * @param {{env?: object}} [o]
 */
function forkWorker(file = WORKER_FILE, o = {}) {
  const { fork } = require('node:child_process');
  const c = fork(file, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: o.env || process.env, execArgv: [] });
  return {
    post: (m) => c.connected && c.send(m),
    onMessage: (cb) => c.on('message', cb),
    onExit: (cb) => c.on('exit', (code) => cb(code)),
    kill: () => c.kill('SIGTERM'),
    pid: c.pid,
    stdout: c.stdout,
    stderr: c.stderr,
  };
}

/**
 * Worker adapter over Electron's utilityProcess (the Mac app). Verified on Electron 44: an .mjs entry inside app.asar
 * loads, relative ESM imports work and child processes (ffmpeg) spawn.
 * @param {object} utilityProcess  require('electron').utilityProcess
 * @param {string} [file]
 */
function utilityWorker(utilityProcess, file = WORKER_FILE) {
  const c = utilityProcess.fork(file, [], { serviceName: 'Worship Rig importer', stdio: 'pipe' });
  return {
    post: (m) => c.postMessage(m),
    onMessage: (cb) => c.on('message', cb),
    onExit: (cb) => c.on('exit', (code) => cb(code)),
    kill: () => c.kill(),
    get pid() {
      return c.pid;
    },
    stdout: c.stdout,
    stderr: c.stderr,
  };
}

const keyOf = (exsPath) => crypto.createHash('sha1').update(String(exsPath)).digest('hex').slice(0, 16);

/**
 * @param {object} o
 * @param {() => object} o.spawn  a worker adapter factory (forkWorker / utilityWorker)
 * @param {() => string} o.out  the output folder (main: userSamplesHome())
 * @param {() => string[]} [o.allowedOut]  folders the output must be inside (main: the server's My Samples roots)
 * @param {string[]|null} [o.roots]  library roots (RIG_GB_LIBRARY); null = the Apple default locations
 * @param {string} [o.cache]  sample-index cache file
 * @param {number} [o.jobs]  parallel conversions (default: the worker's defaultJobs())
 * @param {(snapshot: object) => void} [o.onProgress]  import progress (throttled to ≤ 10/s, state changes at once)
 * @param {(...a: any[]) => void} [o.log]
 */
function createGarageBandImporter(o) {
  const log = o.log || (() => {});
  let worker = null; // the one running worker adapter
  let op = null; // 'scan' | 'import'
  let lastScan = new Map(); // key → {exsPath, name, estBytes, found}
  let job = null; // import snapshot (kept after the run, for status())
  let sentAt = 0;
  let sendTimer = null;
  let cancelTimer = null;

  function spawnWorker(onMessage, onExit) {
    const w = o.spawn();
    worker = w;
    let done = false;
    for (const s of [w.stdout, w.stderr]) {
      if (s && typeof s.on === 'function') s.on('data', (d) => log('importer:', String(d).trim().slice(0, 500)));
    }
    w.onMessage((m) => {
      if (m && m.type === 'log') return log('importer:', m.line);
      return onMessage(m);
    });
    w.onExit((code) => {
      if (done) return;
      done = true;
      if (worker === w) worker = null;
      onExit(code);
    });
    return w;
  }

  function snapshot() {
    return job ? JSON.parse(JSON.stringify(job)) : { state: 'idle', items: [] };
  }

  function push(force = false) {
    if (!o.onProgress || !job) return;
    const now = Date.now();
    const send = () => {
      sendTimer = null;
      sentAt = Date.now();
      try {
        o.onProgress(snapshot());
      } catch (err) {
        log('importer progress handler failed:', err && err.message);
      }
    };
    if (force || now - sentAt >= PROGRESS_MIN_MS) {
      if (sendTimer) clearTimeout(sendTimer);
      send();
    } else if (!sendTimer) sendTimer = setTimeout(send, PROGRESS_MIN_MS - (now - sentAt));
  }

  /**
   * Scan the library. @returns {Promise<object>} {ok, out, roots, encoder, instruments:[{key,…}], parseErrors,
   *   truncated, limits} or {error}
   */
  function scan({ reindex = false } = {}) {
    if (op) return Promise.resolve({ error: 'busy' });
    op = 'scan';
    return new Promise((resolve) => {
      let settled = false;
      const end = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        op = null;
        resolve(r);
      };
      const w = spawnWorker((m) => {
        if (!m || m.type !== 'result') return;
        if (!m.ok) return end({ error: m.error || 'scan-failed', message: m.message });
        const d = m.data || {};
        const next = new Map();
        const instruments = (d.instruments || []).map((it) => {
          const key = keyOf(it.exsPath);
          next.set(key, { exsPath: it.exsPath, name: it.name, estBytes: it.estBytes || 0, found: it.found || 0 });
          const { exsPath, ...rest } = it; // never send absolute paths to the page
          return { key, ...rest };
        });
        lastScan = next;
        end({
          ok: true, out: d.out, roots: d.roots || [], encoder: d.encoder || {}, instruments,
          parseErrors: d.parseErrors || 0, truncated: !!d.truncated,
          limits: { maxPerImport: LIMITS.maxPerImport, maxTotalMb: LIMITS.maxTotalMb },
        });
      }, (code) => end({ error: 'worker-exit', message: `the importer stopped (exit ${code})` }));
      const timer = setTimeout(() => {
        w.kill();
        end({ error: 'timeout' });
      }, LIMITS.scanTimeoutMs);
      w.post({ type: 'scan', roots: o.roots || null, out: o.out(), cache: o.cache, reindex: !!reindex });
    });
  }

  /**
   * Start importing `keys` (from the latest scan). Resolves at once; progress arrives through onProgress.
   * @returns {{ok:true, total:number}|{error:string}}
   */
  function start(keys) {
    if (op) return { error: 'busy' };
    if (!Array.isArray(keys) || !keys.length) return { error: 'nothing-selected' };
    const uniq = [...new Set(keys)];
    if (uniq.length > LIMITS.maxPerImport) return { error: 'too-many' };
    const picked = [];
    for (const k of uniq) {
      if (typeof k !== 'string' || !lastScan.has(k)) return { error: 'unknown-instrument' };
      const it = lastScan.get(k);
      if (!it.found) return { error: 'no-samples' };
      picked.push({ key: k, ...it });
    }
    const est = picked.reduce((s, it) => s + it.estBytes, 0);
    if (est > LIMITS.maxTotalMb * 1048576) return { error: 'too-big' };
    op = 'import';
    if (cancelTimer) clearTimeout(cancelTimer);
    cancelTimer = null;
    const byPath = new Map(picked.map((it) => [it.exsPath, it.key]));
    job = {
      state: 'importing', error: null, startedAt: Date.now(), finishedAt: null, current: -1, imported: 0, failed: 0,
      total: picked.length, format: null,
      items: picked.map((it) => ({ key: it.key, name: it.name, state: 'waiting', done: 0, files: 0 })),
    };
    const item = (i) => job.items[i];
    const finish = (state, error, message) => {
      if (!job || job.state !== 'importing') return;
      op = null;
      if (cancelTimer) clearTimeout(cancelTimer);
      cancelTimer = null;
      for (const it of job.items) {
        if (it.state === 'waiting' || it.state === 'converting') it.state = state === 'failed' ? 'failed' : 'cancelled';
      }
      job.state = state;
      job.error = error || null;
      if (message) job.message = String(message).slice(0, 300);
      job.finishedAt = Date.now();
      job.imported = job.items.filter((it) => it.state === 'done').length;
      job.failed = job.items.filter((it) => it.state === 'failed').length;
      push(true);
    };
    spawnWorker((m) => {
      if (!m || !job) return;
      if (m.type === 'progress') {
        if (m.event === 'start' && Array.isArray(m.items)) {
          // the worker dedupes (GarageBand + Logic copies of one instrument): keep the items it will import
          const keys = new Set(m.items.map((x) => byPath.get(x.exsPath)).filter(Boolean));
          job.items = job.items.filter((it) => keys.has(it.key));
          job.total = job.items.length;
        } else if (m.event === 'instrument' && item(m.index)) {
          job.current = m.index;
          Object.assign(item(m.index), { state: 'converting', files: m.files || 0, done: 0 });
        } else if (m.event === 'file' && item(m.index)) {
          Object.assign(item(m.index), { done: m.done, files: m.files });
          return push();
        } else if (m.event === 'instrumentDone' && item(m.index)) {
          const it = item(m.index);
          it.state = m.ok ? 'done' : m.cancelled ? 'cancelled' : 'failed';
          if (m.ok) it.done = it.files;
          for (const f of ['notes', 'layers', 'missing', 'reason']) if (m[f] !== undefined) it[f] = m[f];
          if (m.message) it.message = String(m.message).slice(0, 300);
          job.imported = job.items.filter((x) => x.state === 'done').length;
          job.failed = job.items.filter((x) => x.state === 'failed').length;
        }
        return push(true);
      }
      if (m.type === 'result') {
        const d = m.data || {};
        if (d.format) job.format = d.format;
        if (!m.ok) return finish('failed', m.error || d.error || 'import-failed', m.message);
        return finish(d.cancelled || job.cancelling ? 'cancelled' : 'done');
      }
      return undefined;
    }, (code) => {
      if (job && job.state === 'importing') {
        if (job.cancelling) finish('cancelled');
        else finish('failed', 'worker-exit', `the importer stopped (exit ${code})`);
      }
      op = null;
    }).post({
      type: 'import', exsPaths: picked.map((it) => it.exsPath), roots: o.roots || null, out: o.out(),
      allowedOut: o.allowedOut ? o.allowedOut() : undefined, cache: o.cache, jobs: o.jobs,
    });
    push(true);
    return { ok: true, total: picked.length };
  }

  /** Stop the running import (finished instruments stay) or scan. @returns {{ok:boolean}} */
  function cancel() {
    if (op === 'scan' && worker) {
      worker.kill();
      return { ok: true };
    }
    if (op !== 'import' || !job || !worker) return { ok: false };
    job.cancelling = true;
    worker.post({ type: 'cancel' });
    const w = worker;
    // a worker stuck in a long synchronous step (afconvert of a big .caf) gets SIGTERM after the grace period
    cancelTimer = setTimeout(() => w.kill(), LIMITS.cancelGraceMs);
    push(true);
    return { ok: true };
  }

  return {
    scan,
    start,
    cancel,
    /** @returns {object} the current (or last) import snapshot, {state:'idle'} before any */
    status: () => ({ ...snapshot(), busy: op }),
    /** App quit: stop the worker (it cancels and cleans up on SIGTERM). */
    dispose() {
      if (sendTimer) clearTimeout(sendTimer);
      if (cancelTimer) clearTimeout(cancelTimer);
      if (worker) worker.kill();
      worker = null;
    },
  };
}

module.exports = { createGarageBandImporter, forkWorker, utilityWorker, LIMITS, WORKER_FILE, keyOf };
