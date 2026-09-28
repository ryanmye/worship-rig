// Runs inside Electron (main.js with RIG_SELFTEST=1 reads window.__RIG_SELFTEST__).
// Two phases: all checks, then a stream is left open and the page reloads (M6: main must finish the stream on
// navigation); after the reload the script picks up its results from sessionStorage and reports.
import * as checks from './checks.js';

const PHASE_KEY = 'rig-selftest-phase1';
const out = { steps: {} };
async function step(name, fn) {
  try {
    out.steps[name] = await fn();
  } catch (err) {
    out.steps[name] = { thrown: String((err && err.message) || err) };
    console.warn(`[selftest] ${name} failed:`, err);
  }
}

function wavHeader0() {
  const b = new ArrayBuffer(44);
  const v = new DataView(b);
  const s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  s(0, 'RIFF');
  v.setUint32(4, 36, true);
  s(8, 'WAVE');
  s(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, 48000, true);
  v.setUint32(28, 192000, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  s(36, 'data');
  v.setUint32(40, 0, true); // provisional: 0 data bytes
  return b;
}

async function phase1(rig) {
  out.isElectron = !!(rig && rig.isElectron === true);
  out.platform = rig && rig.platform;
  out.origin = location.origin;
  await step('info', () => rig.getInfo());
  await step('padsBaseUrl', () => rig.padsBaseUrl());
  await step('listPads', () => rig.listPads());
  await step('http', () => checks.httpChecks());
  await step('audio', () => checks.audioRunning());
  await step('worklet', () => checks.blobRetry());
  await step('midi', () => checks.midiInit());
  await step('backup', () => rig.backupNow(JSON.stringify({ app: 'worship-rig', selftest: true })));
  await step('backupRotation', async () => {
    for (let i = 0; i < 12; i++) await rig.backupNow(JSON.stringify({ app: 'worship-rig', n: i }));
    return true;
  });
  await step('latestBackup', async () => {
    const b = await rig.latestBackup();
    return { path: b.path, n: JSON.parse(b.text).n };
  });
  await step('onMenu', () => typeof rig.onMenu(() => {}) === 'function');
  // My Samples (RIG_USER_SAMPLES = the fixture's "My Samples" folder)
  await step('userSamplesDir', () => rig.userSamplesDir());
  await step('rescanUserSamples', () => rig.rescanUserSamples());
  await step('userSamplesHttp', async () => {
    const health = (await (await fetch('/api/health', { cache: 'no-store' })).json()).userSamples;
    const m = await (await fetch('/api/user-samples/manifest.json', { cache: 'no-store' })).json();
    const L = m.instruments[0].layers[0];
    const url = new URL(`${L.dir}/${L.notes[0]}.${m.instruments[0].ext}`, new URL('/api/user-samples/manifest.json', location.href)).href;
    const r = await fetch(url, { headers: { Range: 'bytes=0-99' } });
    return { health, ids: m.instruments.map((i) => i.id), url, status: r.status, type: r.headers.get('content-type') };
  });
  // integration #2: main must count HTTP errors (Electron's console-message never shows "Failed to load resource")
  await step('probe404', async () => (await fetch('/__selftest-404.json', { cache: 'no-store' })).status);
  await step('streamOpenDenied', () => rig.streamOpen('/etc/passwd-not-allowed.wav'));
  // L4: bare names never overwrite: the second open of the same name gets " 2"
  await step('exclusive', async () => {
    const a = await rig.streamOpen('dup.wav');
    const b = await rig.streamOpen('dup.wav');
    await rig.streamClose(a.id);
    await rig.streamClose(b.id);
    return { a: a.path, b: b.path };
  });
  if (out.steps.audio && out.steps.audio.advanced) {
    await step('record', () => checks.recordOnce({ sink: 'electron', rig, seconds: 1, headerIntervalSec: 0.3 }));
  } else {
    out.steps.record = { skipped: 'audio context not running in this environment' };
  }
  const pads = out.steps.listPads;
  if (Array.isArray(pads) && pads[0] && out.steps.audio && out.steps.audio.advanced) {
    await step('mediaElement', () => checks.mediaElementRms(pads[0].url));
  }
  // M6: leave a stream open (header says 0 bytes, 1000 data bytes written) and reload
  const s = await rig.streamOpen('abandoned.wav');
  await rig.streamWrite(s.id, wavHeader0());
  await rig.streamWrite(s.id, new Uint8Array(1000).fill(7).buffer);
  out.steps.abandoned = { id: s.id, path: s.path };
  sessionStorage.setItem(PHASE_KEY, JSON.stringify(out));
  location.reload();
}

async function phase2(rig, saved) {
  Object.assign(out, saved);
  // the stream must already be finished by main (did-start-navigation), so writing to it fails
  await step('afterReload', async () => {
    await new Promise((r) => setTimeout(r, 300));
    return { write: await rig.streamWrite(out.steps.abandoned.id, new Uint8Array(4).buffer) };
  });
  window.__RIG_SELFTEST__ = out;
}

(async () => {
  const rig = window.rig;
  const saved = sessionStorage.getItem(PHASE_KEY);
  if (saved) {
    sessionStorage.removeItem(PHASE_KEY);
    await phase2(rig, JSON.parse(saved));
  } else await phase1(rig);
})();
