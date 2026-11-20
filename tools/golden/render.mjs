#!/usr/bin/env node
// Golden reference renders: the web engine (app/js/engine) as the test oracle for the native C++ engine.
//
//   node tools/golden/render.mjs                 every fixture, each rendered twice (repeatability), manifest written
//   node tools/golden/render.mjs --only eq-,reverb-room   ids containing any of these substrings (manifest merged)
//   node tools/golden/render.mjs --smoke         the smoke subset only
//   node tools/golden/render.mjs --repeat 1      skip the second render (no repeatability numbers)
//   node tools/golden/render.mjs --no-spread     skip the seed-spread renders of PRNG-dependent fixtures
//   node tools/golden/render.mjs --golden-dir <dir>   write manifest / WAVs / pcm there instead of native/golden (dry runs)
//   node tools/golden/render.mjs --allow-chromium-change   merge or re-render although this Chromium differs from the
//                                                manifest's pin (a FULL run then re-pins; --only keeps the old pin and
//                                                stamps the entries, which compare.mjs then refuses)
//   node tools/golden/render.mjs --out <dir> [--seed N]   render to <dir>/<id>.wav only (manifest untouched), e.g.
//                                                with another engine seed: what a native engine that does not port
//                                                the PRNG streams would produce (checks the statistical tolerances)
//
// Output: native/golden/smoke/<id>.wav (smoke fixtures, committed), native/golden/out/<id>.wav (the rest,
// git-ignored), native/golden/stimuli/<name>.wav (the dry inputs, committed) and native/golden/manifest.json.
// Every WAV is 32-bit float, 44.1 kHz. Contract and tolerances: native/golden/README.md.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { dumpUrls, writeGitignore, COMMIT_CAP_BYTES } from './pcm.mjs';
import { FIXTURES, SYNTH_IDS, ORGAN_IDS } from './fixtures.mjs';
import { STIMULI, makeStimulus, GOLDEN_SR, STIM_LEAD_SEC, hashSeed } from './stimuli.mjs';
import { encodeWavF32 } from './wav.mjs';
import {
  levelStats, thirdOctaveBands, maxAbsDiff, envelopeDb, envCorrelation, bandDiff, compareSignals,
} from './analysis.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const argvEarly = process.argv.slice(2);
const GOLD = path.resolve(argvEarly.includes('--golden-dir') ? argvEarly[argvEarly.indexOf('--golden-dir') + 1]
  : path.join(ROOT, 'native/golden'));
const EXACT_REPEAT = 1e-5; // CLAUDE.md: Chromium's input-summing order moves renders by ≈ 1e-6

// ---- args ---------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const ONLY = arg('--only', null)?.split(',').filter(Boolean) || null;
const SMOKE_ONLY = argv.includes('--smoke');
const OUT_DIR = arg('--out', null);
const SEED = arg('--seed', null);
const SPREAD = !argv.includes('--no-spread');
const REPEAT = OUT_DIR ? Math.max(1, Number(arg('--repeat', 1)) || 1) : Math.max(1, Number(arg('--repeat', 2)) || 2);

// ---- static server: app/ at /, tools/golden/ at /__golden/ ---------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.css': 'text/css',
};
function startServer() {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    let base = path.join(ROOT, 'app');
    let rel = p;
    if (p.startsWith('/__golden/')) {
      base = HERE;
      rel = p.slice('/__golden'.length);
    }
    const file = path.normalize(path.join(base, rel));
    if (req.url === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain', connection: 'close' });
      return res.end('not found');
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': fs.statSync(file).size, 'cache-control': 'no-store',
      connection: 'close' });
    fs.createReadStream(file).pipe(res);
  });
  // tools/lib/server.mjs: no keep-alive, no request timeouts (a long render keeps the page busy)
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

/** Playwright's own Chromium; else a preinstalled build under PLAYWRIGHT_BROWSERS_PATH (newer than the lockfile's). */
async function launch() {
  const args = ['--autoplay-policy=no-user-gesture-required'];
  try {
    const browser = await chromium.launch({ headless: true, args });
    return { browser, exe: chromium.executablePath() };
  } catch (e) {
    const roots = [process.env.GOLDEN_CHROMIUM, process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers',
      path.join(os.homedir(), '.cache/ms-playwright')].filter(Boolean);
    for (const r of roots) {
      if (fs.existsSync(r) && fs.statSync(r).isFile()) {
        return { browser: await chromium.launch({ headless: true, args, executablePath: r }), exe: r };
      }
      if (!fs.existsSync(r)) continue;
      const dirs = fs.readdirSync(r).sort().reverse();
      for (const d of dirs) {
        for (const sub of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/headless_shell',
          'chrome-linux64/chrome', 'chrome-linux/chrome']) {
          const exe = path.join(r, d, sub);
          if (fs.existsSync(exe)) {
            return { browser: await chromium.launch({ headless: true, args, executablePath: exe }), exe };
          }
        }
      }
    }
    throw e;
  }
}

/**
 * What identifies the Chromium that renders goldens (T17 task 4): the version (= the source tag the kernel ports must
 * follow, SETUP_REVIEW 17), Playwright's build directory (its revision), the user agent and a hash of the binary.
 */
async function chromiumPin(browser, exe) {
  const page = await browser.newPage();
  const userAgent = await page.evaluate(() => navigator.userAgent);
  await page.close();
  const hash = crypto.createHash('sha256');
  await new Promise((res, rej) => fs.createReadStream(exe).on('data', (c) => hash.update(c)).on('end', res).on('error', rej));
  const m = /(chromium(?:_headless_shell)?-\d+)/.exec(exe);
  return { version: browser.version(), product: /headless/.test(exe) ? 'chrome-headless-shell' : 'chromium',
    playwrightBuild: m ? m[1] : path.basename(path.dirname(exe)), userAgent, executableSha256: hash.digest('hex'),
    platform: `${os.platform()}-${os.arch()}` };
}

/** Same Chromium? Version is what decides (the binary hash is recorded for diagnosis). */
export const samePin = (a, b) => !!a && !!b && a.version === b.version;

function unb64(s) {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

async function openPage(browser, base) {
  const page = await browser.newPage();
  const log = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') log.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => log.push(`[pageerror] ${e.message}`));
  await page.goto(`${base}/__golden/page.html`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  return {
    async render(fx) {
      log.length = 0;
      const r = await page.evaluate((f) => window.__render(f), fx);
      return { ...r, chs: [unb64(r.L), unb64(r.R)], L: undefined, R: undefined, console: log.slice() };
    },
    async decode(url, rate) {
      const r = await page.evaluate(([u, sr]) => window.__decodePcm(u, sr), [url, rate]);
      return { rate: r.rate, frames: r.frames, chs: r.channels.map(unb64) };
    },
    async instruments() {
      return page.evaluate(async () => {
        const { AudioEngine } = await import('/js/engine/index.js');
        const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 128, sampleRate: 44100 });
        const e = new AudioEngine({ context: ctx, seed: 1, manifestUrls: ['./samples/manifest.json'] });
        await e.start();
        const l = e.listInstruments().map((x) => x.ref);
        e.dispose();
        return l;
      });
    },
  };
}

/** One server + browser + page, for tools that only need the page (pcm.mjs). */
export async function startBrowserPage() {
  const server = await startServer();
  const { browser } = await launch();
  const page = await openPage(browser, `http://127.0.0.1:${server.address().port}`);
  return { page, close: async () => { await browser.close(); server.close(); } };
}

// ---- randomness: which seeded streams a fixture audibly depends on ------------------------------------------------
/**
 * Every random decision of the engine comes from mulberry32 streams (app/js/shared/prng.js createRng) seeded by
 * FNV-1a hashes of a name: rngFor(seed, name) = createRng(hashSeed(`${seed}|${name}`)); reverb IRs use
 * createRng(hashSeed(`${seed}|ir|${key}`)). This lists the streams that reach the tapped output.
 */
function randomnessOf(fx, resolved) {
  const s = fx.setup || {};
  const streams = [];
  const seed = fx.seed >>> 0;
  const tap = s.tap || 'out';
  const fxp = resolved?.patch?.fx || {};
  const viaSum = ['out', 'fx.sum', 'fx.lofi.output', 'fx.eqOut', 'fx.master'].includes(tap);
  const stream = (name, why, seedStr = `${seed}|${name}`) => streams.push({ name, seed: hashSeed(seedStr), why });
  if (fx.kind === 'drone-freeze') {
    const k = s.key;
    stream(`drone-freeze|${k.pc}|${k.minor ? 1 : 0}`, 'renderDroneLoop: drone voices (forked per instrument)');
    if (s.reverb) stream(`ir|<key of size ${s.reverb.size}, damp ${s.reverb.damp}>`, 'reverb IR noise',
      `${seed}|ir|${resolved.reverbKey || ''}`);
    return { prng: 'mulberry32', hash: 'FNV-1a', engineSeed: seed, streams };
  }
  // instrument streams count only when the instrument sounds: a strip-test slot that never gets a note draws at
  // construction but is not connected (idle-cpu #1: inst.output joins the strip on the first note)
  // Engine stream names: a fresh engine creates the song's instruments in slot order, seq 1, 2, … (audio.js prepare)
  const calls = resolved?.rngCalls || {};
  const notes = fx.events.some((e) => e.type === 'noteOn');
  let k = 0;
  (resolved?.patch?.slots || []).forEach((sl, i) => {
    if (!sl) return;
    k++;
    const n = calls[`inst|${sl.instrument.type}|${sl.instrument.id}|#${k}`] || 0;
    if (notes && n > 0) {
      const nm = `inst|${i}|${sl.instrument.type}|${sl.instrument.id}|${k}`;
      stream(nm, `instrument rng (${n} calls; forked per voice)`);
    }
  });
  const droneCalls = Object.entries(calls).filter(([nm]) => nm.includes('drone-osc')).reduce((t, [, c]) => t + c, 0);
  if (s.drone && droneCalls > 0) stream('drone', `drone rng (${droneCalls} calls by its drone-osc instruments)`);
  const slots = (resolved?.patch?.slots || []).filter(Boolean);
  const reverbFed = s.inject?.at === 'fx.reverb.input' || slots.some((sl) => (sl.sends?.reverb || 0) > 0) ||
    !!s.drone || fx.events.some((e) => e.type === 'param' && /sends\.reverb/.test(e.path) && e.value > 0);
  const reverbHeard = tap === 'fx.reverb.output' || (viaSum && (fxp.reverb?.returnGain ?? 1) > 0);
  if (reverbFed && reverbHeard && resolved?.reverbKey) {
    stream(`ir|${resolved.reverbKey}`, 'reverb IR noise (buildIRChannels)', `${seed}|ir|${resolved.reverbKey}`);
  }
  const chorusFed = s.inject?.at === 'fx.chorus.input' || slots.some((sl) => (sl.sends?.chorus || 0) > 0);
  if (chorusFed && (tap === 'fx.chorus.output' || viaSum)) stream('chorus', 'chorus LFO start phase (1 draw)');
  const lofiOn = (fxp.lofi?.amount || 0) > 0 && (fxp.lofi?.crackle || 0) > 0;
  if (lofiOn && tap !== 'fx.reverb.output' && tap !== 'fx.delay.output' && !tap.startsWith('slot')) {
    stream('crackle', 'lofi crackle impulse positions (6 s loop)');
  }
  // the stimulus is shipped as a WAV (native/golden/stimuli/), so its seed never makes a fixture statistical
  const stim = s.inject && STIMULI[s.inject.stimulus];
  const stimulusSeed = stim?.seed ? { name: stim.seed, seed: hashSeed(stim.seed) } : undefined;
  return { prng: 'mulberry32', hash: 'FNV-1a', engineSeed: seed, streams, stimulusSeed };
}

/**
 * Chromium nodes in the recorded path whose exact output a native port reimplements rather than mirrors (heuristic,
 * from the fixture's setup). Where the native implementation of one of these is not sample-identical, its runner
 * may fall back to the statistical tolerance (tolerance.fallback) and must log that it did.
 */
function chromiumNodesOf(fx, resolved) {
  const s = fx.setup || {};
  const tap = s.tap || 'out';
  const out = new Set();
  const slots = (resolved?.patch?.slots || []).filter(Boolean);
  const notes = fx.events.some((e) => e.type === 'noteOn');
  if (notes && slots.some((x) => x.instrument.type === 'sampler')) out.add('mp3-decode+resample (decodeAudioData)');
  if (notes && slots.some((x) => x.instrument.type === 'sampler')) out.add('AudioBufferSourceNode playbackRate');
  if ((notes && slots.some((x) => x.instrument.type !== 'sampler')) || s.drone || fx.kind === 'drone-freeze') {
    out.add('OscillatorNode/PeriodicWave wavetables');
  }
  const fxp = resolved?.patch?.fx || {};
  if (tap === 'fx.reverb.output' || (s.drone && tap !== 'fx.sum') || fx.kind === 'drone-freeze' && s.reverb ||
    slots.some((x) => (x.sends?.reverb || 0) > 0) && tap === 'out') out.add('ConvolverNode');
  if (tap === 'out') out.add('DynamicsCompressorNode (catcher)');
  if (tap === 'out') out.add('WaveShaperNode (soft clip)');
  if ((fxp.comp?.amount || 0) > 0 && ['out', 'fx.master'].includes(tap)) out.add('DynamicsCompressorNode (glue)');
  if ((fxp.lofi?.amount || 0) > 0 && ['out', 'fx.lofi.output', 'fx.master'].includes(tap)) {
    out.add('WaveShaperNode 4x oversampling (lofi)');
  }
  if (tap === 'fx.chorus.output' || tap === 'fx.lofi.output' || slots.some((x) => (x.sends?.chorus || 0) > 0)) {
    out.add('DelayNode with audio-rate delayTime');
  }
  return [...out];
}

// ---- tolerances -----------------------------------------------------------------------------------------------------
const TOL_EXACT = { maxAbsDiff: 2e-4, bandsDb: 0.25, bandRangeDb: 60, envCorr: 0.999, envLagMs: 0, rmsDb: 0.1 };
const TOL_STAT = { bandsDb: 1.5, bandRangeDb: 50, envCorr: 0.95, envLagMs: 10, rmsDb: 1 };
/** Engine seeds of the seed-spread renders (fixture seed + these). */
const SPREAD_SEEDS = [1, 2, 3, 4];

/**
 * Statistical tolerance for a PRNG-dependent fixture: never tighter than TOL_STAT, and wide enough that renders of
 * the same fixture with other engine seeds pass (×1.25 margin), i.e. "as close to the golden as another seed is".
 * `widened` marks fixtures whose seed spread exceeds TOL_STAT: there the statistical test is weak, and only a native
 * port of the PRNG streams (mulberry32 + the stream names + draw order) makes the fixture a strong (exact) test.
 */
function spreadTolerance(spread) {
  // seeds decorrelate the envelope itself (frozen-drone loops: ρ < 0.5 across seeds): the envelope checks say nothing
  // there without the PRNG port, so they are switched off (envCorr −1, lag up to the ±200 ms search window)
  const noEnv = spread.envCorr < 0.5;
  const t = {
    bandsDb: round(Math.max(TOL_STAT.bandsDb, 1.25 * spread.bandsDb), 3),
    bandRangeDb: TOL_STAT.bandRangeDb,
    envCorr: noEnv ? -1 : round(Math.max(-1, Math.min(TOL_STAT.envCorr, spread.envCorr - 0.05)), 3),
    envLagMs: noEnv ? 200 : Math.max(TOL_STAT.envLagMs, Math.abs(spread.lagMs) + 10),
    rmsDb: round(Math.max(TOL_STAT.rmsDb, 1.25 * spread.rmsDb), 3),
  };
  const widened = t.bandsDb > TOL_STAT.bandsDb || t.envCorr < TOL_STAT.envCorr || t.envLagMs > TOL_STAT.envLagMs ||
    t.rmsDb > TOL_STAT.rmsDb;
  return { ...t, widened };
}

/**
 * Honest tier record per fixture (T17 task 3; SETUP_REVIEW 7, 33): the tolerance actually in force, why it is that wide,
 * and for a statistical fixture what makes it exact, so the promotion pass (promote.mjs) is mechanical.
 */
function tierOf(e) {
  const t = e.tolerance;
  if (e.classification === 'exact') return { class: 'exact', maxAbsDiff: t.maxAbsDiff, bandsDb: t.bandsDb, envCorr: t.envCorr };
  const streams = [...new Set((e.randomness?.streams || []).map((x) => x.name.split('|')[0]))];
  const blockers = [];
  if (e.repeatMaxAbsDiff > EXACT_REPEAT) {
    blockers.push(`not repeatable in Chromium itself (two renders differ by ${e.repeatMaxAbsDiff.toExponential(1)} > ` +
      `${EXACT_REPEAT}: audio-rate FM / input-sum order); a PRNG port alone cannot make it exact`);
  }
  const widened = e.prngPortRecommended === true;
  const seed = e.seedSpread;
  return {
    class: 'statistical',
    bandsDb: t.bandsDb, envCorr: t.envCorr, envLagMs: t.envLagMs, rmsDb: t.rmsDb,
    why: seed ? `1.25 x the spread of the same fixture under engine seeds ${seed.seeds.join(',')} ` +
      `(bands ${seed.bandsDb} dB, env corr ${seed.envCorr}, rms ${seed.rmsDb} dB)${t.envCorr === -1 ? '; envelope check off (seeds decorrelate it)' : ''}`
      : 'default statistical tolerance (not PRNG-dependent; Chromium run-to-run jitter above 1e-5)',
    weakWithoutPort: widened,
    exactIf: e.exactIfPrngPorted ? { port: 'mulberry32 + FNV-1a seeding + draw order of the listed streams', streams } : null,
    blockers,
    promote: e.exactIfPrngPorted ? 'node tools/golden/promote.mjs <native render dir> --apply' : null,
  };
}

function tierSummary(fixtures) {
  const st = fixtures.filter((e) => e.classification === 'statistical');
  const range = (k) => {
    const v = st.map((e) => e.tolerance[k]).filter((x) => x !== -1);
    return { min: Math.min(...v), max: Math.max(...v) };
  };
  const worst = (k, f) => st.reduce((m, e) => (f(e.tolerance[k], m.v) ? { id: e.id, v: e.tolerance[k] } : m), { id: null, v: k === 'bandsDb' ? 0 : 9 });
  return {
    exact: fixtures.length - st.length, statistical: st.length,
    exactIfPrngPorted: st.filter((e) => e.exactIfPrngPorted).length,
    statisticalBandsDb: range('bandsDb'), statisticalEnvCorr: range('envCorr'), statisticalRmsDb: range('rmsDb'),
    widestBands: worst('bandsDb', (x, y) => x > y), lowestEnvCorr: worst('envCorr', (x, y) => x !== -1 && x < y),
    envelopeCheckOff: st.filter((e) => e.tolerance.envCorr === -1).map((e) => e.id),
    note: 'ARCHITECTURE 8.2 states bands 1.5 dB / envelope 0.95 for the whole tier; the real per-fixture values are ' +
      'fixtures[].tolerance (see native/golden/README.md, Honest tiers)',
  };
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const round = (x, d = 6) => (Number.isFinite(x) ? Number(x.toPrecision(d)) : x);

// ---- main -----------------------------------------------------------------------------------------------------
async function main() {
  // --extra <file.json>: ad-hoc fixtures (an array) for --out renders while developing a fixture; never in the manifest
  const extra = OUT_DIR && arg('--extra', null) ? JSON.parse(fs.readFileSync(arg('--extra'), 'utf8')) : [];
  let list = [...FIXTURES, ...extra.map((f) => ({ seed: 1, ...f }))].filter((f) => (!SMOKE_ONLY || f.smoke) && (!ONLY || ONLY.some((o) => f.id.includes(o))));
  if (!list.length) throw new Error('no fixtures selected');
  if (SEED !== null) list = list.map((f) => ({ ...f, seed: Number(SEED) >>> 0 }));
  if (OUT_DIR) return renderTo(list, path.resolve(OUT_DIR));
  for (const d of ['smoke', 'out', 'stimuli']) fs.mkdirSync(path.join(GOLD, d), { recursive: true });

  // stimuli (always: cheap); mono stimuli are written as 1-channel files to keep the committed set small
  const stimuli = {};
  for (const id of Object.keys(STIMULI)) {
    const { L, R, def } = makeStimulus(id, GOLDEN_SR);
    const stereo = def.kind === 'stereo-noise';
    const buf = encodeWavF32(stereo ? [L, R] : [L], GOLDEN_SR);
    const file = `stimuli/${id}.wav`;
    fs.writeFileSync(path.join(GOLD, file), buf);
    stimuli[id] = {
      file, channels: stereo ? 2 : 1, frames: L.length, sha256: sha256(buf), leadSec: STIM_LEAD_SEC, def,
    };
  }

  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const { browser, exe } = await launch();
  const pin = await chromiumPin(browser, exe);
  const chromiumVersion = pin.version;
  const manifestPath0 = path.join(GOLD, 'manifest.json');
  const prev0 = fs.existsSync(manifestPath0) ? JSON.parse(fs.readFileSync(manifestPath0, 'utf8')) : null;
  const prevPin = prev0 ? (prev0.chromiumPin || { version: prev0.chromium }) : null;
  const fullRun = !ONLY && !SMOKE_ONLY;
  const allowChange = argv.includes('--allow-chromium-change');
  if (prevPin && !samePin(prevPin, pin) && !allowChange) {
    console.error(`REFUSED: the manifest's goldens come from Chromium ${prevPin.version}, this browser is ` +
      `${pin.version} (${exe}). Chromium-implemented nodes (compressor, convolver, wavetables, decode) can move between ` +
      `versions: compare with compare.mjs first, then pass --allow-chromium-change${fullRun ? ' to re-pin' : ''}.`);
    await browser.close();
    server.close();
    process.exit(3);
  }
  const keepPin = prevPin && !samePin(prevPin, pin) && !fullRun ? prevPin : pin;
  const pages = [];
  for (let i = 0; i < REPEAT; i++) pages.push(await openPage(browser, base));

  // coverage check: every synth / organ in the registry has a fixture
  const refs = await pages[0].instruments();
  const missing = refs.filter((r) => (r.type === 'synth' && !SYNTH_IDS.includes(r.id)) ||
    (r.type === 'organ' && !ORGAN_IDS.includes(r.id)));
  if (missing.length) {
    console.warn(`WARNING: instruments without a fixture: ${missing.map((r) => `${r.type}:${r.id}`).join(', ')}`);
  }

  const manifestPath = path.join(GOLD, 'manifest.json');
  const prev = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  const entries = new Map((prev?.fixtures || []).map((e) => [e.id, e]));
  const t0 = Date.now();
  let i = 0;
  for (const fx of list) {
    i++;
    const tf = Date.now();
    // the repeat renders run in separate pages at the same time (2 CPUs: the offline render threads overlap)
    const runs = await Promise.all(pages.map((p) => p.render(fx)));
    const a = runs[0];
    const rep = runs.length > 1 ? maxAbsDiff(a.chs, runs[1].chs).maxAbs : null;
    const buf = encodeWavF32(a.chs, a.sr);
    const dir = fx.smoke ? 'smoke' : 'out';
    const file = `${dir}/${fx.id}.wav`;
    fs.writeFileSync(path.join(GOLD, file), buf);
    const lv = levelStats(a.chs);
    const randomness = randomnessOf(fx, a.resolved);
    const random = randomness.streams.length > 0;
    const repeatable = rep === null ? null : rep <= EXACT_REPEAT;
    // a silent render (Dry space, No Echo) is exact whatever it would draw
    const classification = lv.peak > 0 && (repeatable === false || random) ? 'statistical' : 'exact';
    const issues = [...new Set([...(a.warnings || []), ...a.console])].filter(Boolean);
    const entry = {
      id: fx.id,
      kind: fx.kind,
      classification,
      // statistical only because of seeded PRNG streams: exact once the native side ports mulberry32 + the streams
      exactIfPrngPorted: classification === 'statistical' && repeatable !== false,
      smoke: !!fx.smoke,
      addedBy: fx.addedBy,
      chromium: chromiumVersion,
      file,
      sha256: sha256(buf),
      sampleRate: a.sr,
      channels: 2,
      frames: a.chs[0].length,
      seconds: fx.seconds,
      peak: round(lv.peak),
      peakDb: round(lv.peakDb, 4),
      rms: round(lv.rms),
      rmsDb: round(lv.rmsDb, 4),
      bandsDb: thirdOctaveBands(a.chs, a.sr).map((x) => round(x, 4)),
      repeatMaxAbsDiff: rep,
      renderMs: a.ms,
      tolerance: classification === 'exact' ? { ...TOL_EXACT, fallback: TOL_STAT } : TOL_STAT,
      chromiumNodes: chromiumNodesOf(fx, a.resolved),
      randomness,
      fixture: fx,
      resolved: a.resolved,
      issues,
    };
    if (classification === 'statistical' && random && SPREAD) {
      // seed spread: the same fixture with other engine seeds, rendered on the pages in parallel
      const vars = await Promise.all(SPREAD_SEEDS.map((d, j) => pages[j % pages.length]
        .render({ ...fx, seed: fx.seed + d })));
      const sp = { seeds: SPREAD_SEEDS.map((d) => fx.seed + d), bandsDb: 0, envCorr: 1, rmsDb: 0, lagMs: 0, maxAbs: 0 };
      for (const v of vars) {
        const c = compareSignals({ sr: a.sr, chs: a.chs }, { sr: v.sr, chs: v.chs }, TOL_STAT);
        sp.bandsDb = Math.max(sp.bandsDb, c.bandsDb);
        sp.envCorr = Math.min(sp.envCorr, c.envCorr);
        sp.rmsDb = Math.max(sp.rmsDb, c.rmsDb);
        sp.maxAbs = Math.max(sp.maxAbs, c.maxAbs);
        if (Math.abs(c.lagMs) > Math.abs(sp.lagMs)) sp.lagMs = c.lagMs;
      }
      for (const k of ['bandsDb', 'envCorr', 'rmsDb', 'maxAbs']) sp[k] = round(sp[k], 4);
      entry.seedSpread = sp;
      const { widened, ...tol } = spreadTolerance(sp);
      entry.tolerance = tol;
      entry.prngPortRecommended = widened;
    }
    entry.tier = tierOf(entry);
    const used = (a.resolved?.samplesUsed || []).filter((u) => u.url);
    if (used.length) {
      entry.needsPcm = true;
      entry.pcm = { required: true, decoder: 'Chromium decodeAudioData', files: used.map((u) => ({
        url: u.url.replace(/^\.\//, ''), engine: { frames: u.frames, rate: u.rate, channels: u.channels,
          dualMono: u.dualMono, onsetTrimSec: u.onsetTrimSec, capped: u.capped, monoFix: u.monoFix } })) };
    }
    if (runs.length > 1) {
      entry.repeatEnvCorr = round(envCorrelation(envelopeDb(a.chs, a.sr), envelopeDb(runs[1].chs, a.sr)));
      entry.repeatBandsDb = round(bandDiff(entry.bandsDb, thirdOctaveBands(runs[1].chs, a.sr)).worstDb, 4);
    }
    entries.set(fx.id, entry);
    const pct = lv.peak > 0 ? lv.peakDb.toFixed(1) : '-inf';
    console.log(`[${i}/${list.length}] ${fx.id.padEnd(28)} ${classification.padEnd(11)} peak ${pct.padStart(6)} dB  ` +
      `repeat ${rep === null ? '-' : rep.toExponential(2)}  ${((Date.now() - tf) / 1000).toFixed(1)} s` +
      (issues.length ? `  issues: ${issues.length}` : '') +
      (lv.peak === 0 && !/dry|none/.test(fx.id) ? '  SILENT' : ''));
  }
  const renderSec = (Date.now() - t0) / 1000;
  // sampler PCM: dump what Chromium decodes for every sample a fixture plays (pcm.mjs documents format and size policy)
  const pcmUrls = [...entries.values()].flatMap((e) => (e.pcm?.files || []).map((f) => f.url));
  let pcmInfo = prev0?.pcm || null;
  if (pcmUrls.length) {
    const tp = Date.now();
    const recs = await dumpUrls(pages[0], pcmUrls, GOLD);
    const usage = new Map();
    for (const e of entries.values()) for (const f of e.pcm?.files || []) usage.set(f.url, (usage.get(f.url) || 0) + 1);
    const sel = writeGitignore(GOLD, recs, usage);
    for (const e of entries.values()) {
      for (const f of e.pcm?.files || []) Object.assign(f, recs.get(f.url), { committed: sel.committed.has(f.url) });
    }
    pcmInfo = { dir: 'pcm', format: 'WAV 32-bit float at the file rate + JSON sidecar {source, frames, rate, channels, sha256}',
      files: recs.size, totalBytes: sel.totalBytes, committedBytes: sel.committedBytes, commitCapBytes: COMMIT_CAP_BYTES,
      regenerate: 'node tools/golden/pcm.mjs', seconds: Math.round((Date.now() - tp) / 100) / 10 };
  }
  await browser.close();
  server.close();

  // stale entries (fixtures removed from fixtures.mjs) are dropped
  const ids = new Set(FIXTURES.map((f) => f.id));
  const fixtures = FIXTURES.map((f) => entries.get(f.id)).filter(Boolean);
  for (const id of entries.keys()) if (!ids.has(id)) console.warn(`dropped stale manifest entry ${id}`);
  const manifest = {
    schema: 1,
    generator: 'tools/golden/render.mjs',
    generatedAt: new Date().toISOString(),
    chromium: keepPin.version,
    // T17: the goldens are only valid for this Chromium (compare.mjs refuses others without --allow-chromium-change)
    chromiumPin: { ...keepPin, pinned: true },
    node: process.version,
    sampleRate: GOLDEN_SR,
    format: 'WAV 32-bit IEEE float, interleaved stereo (stimuli: mono unless channels 2)',
    exactRepeatThreshold: EXACT_REPEAT,
    tolerances: { exact: TOL_EXACT, statistical: TOL_STAT },
    measures: 'tools/golden/analysis.mjs (definitions in its header and native/golden/README.md)',
    lastRun: {
      fixtures: list.length, repeat: REPEAT, seconds: Math.round(renderSec * 10) / 10, cpus: os.cpus().length,
    },
    stimuli,
    pcm: pcmInfo || undefined,
    tiers: tierSummary(fixtures),
    fixtures,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
  const committedPcm = pcmInfo ? pcmInfo.committedBytes : 0;
  const sizeOf = (d) => fs.readdirSync(path.join(GOLD, d))
    .reduce((s, f) => s + fs.statSync(path.join(GOLD, d, f)).size, 0);
  const by = (k) => fixtures.reduce((m, e) => ((m[e[k]] = (m[e[k]] || 0) + 1), m), {});
  console.log(`\n${list.length} fixtures rendered ×${REPEAT} in ${renderSec.toFixed(1)} s ` +
    `(chromium ${chromiumVersion})`);
  console.log(`manifest: ${fixtures.length} fixtures; by kind ${JSON.stringify(by('kind'))}; ` +
    JSON.stringify(by('classification')));
  const MB = (b) => (b / 1048576).toFixed(2);
  console.log(`sizes: smoke ${MB(sizeOf('smoke'))} MB, stimuli ${MB(sizeOf('stimuli'))} MB, ` +
    `out ${MB(sizeOf('out'))} MB, ` +
    `manifest ${MB(fs.statSync(manifestPath).size)} MB, pcm ${MB(pcmInfo?.totalBytes || 0)} MB ` +
    `(${MB(committedPcm)} MB committed)`);
  console.log(`COMMITTED audio: ${MB(sizeOf('smoke') + sizeOf('stimuli') + committedPcm)} MiB (budget 14 MB)`);
  const weak = fixtures.filter((e) => e.prngPortRecommended).map((e) => e.id);
  console.log(`PRNG port recommended (seed spread exceeds the default statistical tolerance): ${weak.length}: ` +
    weak.join(' '));
  const reps = fixtures.map((e) => e.repeatMaxAbsDiff).filter((x) => x !== null && x !== undefined);
  if (reps.length) console.log(`repeat max|diff|: max ${Math.max(...reps).toExponential(2)}, ` +
    `exactly 0 in ${reps.filter((x) => x === 0).length}/${reps.length}`);
}

/** --out: plain renders to a directory (no manifest, no stimuli). */
async function renderTo(list, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const server = await startServer();
  const { browser, exe } = await launch();
  const pin = await chromiumPin(browser, exe);
  const page = await openPage(browser, `http://127.0.0.1:${server.address().port}`);
  const t0 = Date.now();
  // compare.mjs reads this to refuse comparing renders of one Chromium against goldens of another
  fs.writeFileSync(path.join(dir, 'render-info.json'), `${JSON.stringify({ generator: 'tools/golden/render.mjs --out',
    chromium: pin.version, chromiumPin: pin, seeds: [...new Set(list.map((f) => f.seed))], ids: list.map((f) => f.id) },
  null, 1)}\n`);
  for (const fx of list) {
    const a = await page.render(fx);
    fs.writeFileSync(path.join(dir, `${fx.id}.wav`), encodeWavF32(a.chs, a.sr));
    console.log(`${fx.id} (seed ${fx.seed}) ${a.ms} ms`);
  }
  console.log(`${list.length} fixtures → ${dir} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await browser.close();
  server.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
