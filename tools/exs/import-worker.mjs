// In-app GarageBand / Logic importer worker (v11-importer). importer-host.js starts this file in its own process — an
// Electron utilityProcess in the Mac app, a child_process.fork in the tests — so the library walk, the .exs parsing,
// the sample index and the ffmpeg / afconvert runs never block Electron's main process (which also serves the
// samples) or the renderer (which plays them). One request per process:
//   → {type:'scan', roots, out, cache, reindex}      ← {type:'result', ok:true, data: scanLibrary(...)}
//   → {type:'import', exsPaths, roots, out, allowedOut, cache, jobs}
//                                                     ← {type:'progress', ...}*, {type:'result', ok, data}
//   → {type:'cancel'}                                 the running import stops (current instrument discarded)
//   ← {type:'log', line}                              CLI-style log lines, for main's log
// SIGTERM (the app quitting) cancels like 'cancel' and exits after the clean-up.
import os from 'node:os';
import { scanLibrary, importInstruments } from './importer.mjs';

const port = process.parentPort || null; // Electron utilityProcess
const post = (msg) => {
  try {
    if (port) port.postMessage(msg);
    else if (process.send) process.send(msg);
  } catch {
    /* parent gone */
  }
};
const log = (line) => post({ type: 'log', line: String(line).slice(0, 2000) });
const abort = new AbortController();
let busy = null;

// Conversions are background work: let the audio and the UI win every contest for a core (children inherit it).
try {
  os.setPriority(0, 10);
} catch {
  /* not permitted: run at normal priority */
}

async function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'cancel') {
    abort.abort();
    return;
  }
  if (busy) return post({ type: 'result', ok: false, error: 'busy' });
  if (msg.type === 'scan') {
    busy = 'scan';
    try {
      const data = scanLibrary({ roots: msg.roots, out: msg.out, cache: msg.cache, reindex: !!msg.reindex, log });
      post({ type: 'result', ok: true, data });
    } catch (e) {
      post({ type: 'result', ok: false, error: 'scan-failed', message: e.message });
    }
    return finish();
  }
  if (msg.type === 'import') {
    busy = 'import';
    try {
      const data = await importInstruments({
        exsPaths: msg.exsPaths, roots: msg.roots, out: msg.out, allowedOut: msg.allowedOut, cache: msg.cache,
        jobs: msg.jobs, signal: abort.signal, log, onProgress: (ev) => post({ type: 'progress', ...ev }),
      });
      post({ type: 'result', ok: data.ok, data, error: data.error });
    } catch (e) {
      log(e.stack || e.message);
      post({ type: 'result', ok: false, error: 'import-failed', message: e.message });
    }
    return finish();
  }
  post({ type: 'result', ok: false, error: 'unknown-request' });
}

function finish() {
  // let the last message flush, then leave (one request per process)
  setTimeout(() => process.exit(0), 50);
}

if (port) port.on('message', (e) => handle(e && e.data));
else process.on('message', (m) => handle(m));
process.on('SIGTERM', () => {
  abort.abort();
  if (busy !== 'import') process.exit(0);
  setTimeout(() => process.exit(0), 3000); // importOne removes its work folder on abort; don't wait forever
});
process.on('disconnect', () => {
  abort.abort();
  setTimeout(() => process.exit(0), 3000);
});
