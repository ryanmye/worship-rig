#!/usr/bin/env node
// Golden reference renders: the web engine (app/js/engine) as the test oracle for the native C++ engine.
//
//   node tools/golden/render.mjs                 every fixture, each rendered twice (repeatability), manifest written
//   node tools/golden/render.mjs --only eq-,reverb-room   ids containing any of these substrings (manifest merged)
//   node tools/golden/render.mjs --smoke         the smoke subset only
//   node tools/golden/render.mjs --repeat 1      skip the second render (no repeatability numbers)
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
import { FIXTURES, SYNTH_IDS, ORGAN_IDS } from './fixtures.mjs';
import { STIMULI, makeStimulus, GOLDEN_SR, STIM_LEAD_SEC, hashSeed } from './stimuli.mjs';
import { encodeWavF32 } from './wav.mjs';
import { levelStats, thirdOctaveBands, maxAbsDiff, envelopeDb, envCorrelation, bandDiff } from './analysis.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const GOLD = path.join(ROOT, 'native/golden');
const EXACT_REPEAT = 1e-5; // CLAUDE.md: Chromium's input-summing order moves renders by ≈ 1e-6

// ---- args ---------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const ONLY = arg('--only', null)?.split(',').filter(Boolean) || null;
const SMOKE_ONLY = argv.includes('--smoke');
const REPEAT = Math.max(1, Number(arg('--repeat', 2)) || 2);

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
    return await chromium.launch({ headless: true, args });
  } catch (e) {
    const roots = [process.env.GOLDEN_CHROMIUM, process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers',
      path.join(os.homedir(), '.cache/ms-playwright')].filter(Boolean);
    for (const r of roots) {
      if (fs.existsSync(r) && fs.statSync(r).isFile()) return chromium.launch({ headless: true, args, executablePath: r });
      if (!fs.existsSync(r)) continue;
      const dirs = fs.readdirSync(r).sort().reverse();
      for (const d of dirs) {
        for (const sub of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/headless_shell',
          'chrome-linux64/chrome', 'chrome-linux/chrome']) {
          const exe = path.join(r, d, sub);
          if (fs.existsSync(exe)) return chromium.launch({ headless: true, args, executablePath: exe });
        }
      }
    }
    throw e;
  }
}

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
  for (const [name, calls] of Object.entries(resolved?.rngCalls || {})) {
    if (calls > 0) streams.push({ name, calls, why: 'instrument rng (rngFor(seed, `inst|slot|type|id|seq`), forks per voice)' });
  }
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
  const stim = s.inject && STIMULI[s.inject.stimulus];
  if (stim?.seed) streams.push({ name: `stimulus:${s.inject.stimulus}`, seed: hashSeed(stim.seed), why: 'stimuli.mjs noise' });
  return { prng: 'mulberry32', hash: 'FNV-1a', engineSeed: seed, streams };
}

// ---- tolerances -----------------------------------------------------------------------------------------------------
const TOL_EXACT = { maxAbsDiff: 2e-4, bandsDb: 0.25, bandRangeDb: 60, envCorr: 0.999, rmsDb: 0.1 };
const TOL_STAT = { bandsDb: 1.5, bandRangeDb: 50, envCorr: 0.95, rmsDb: 1 };

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const round = (x, d = 6) => (Number.isFinite(x) ? Number(x.toPrecision(d)) : x);

// ---- main -------------------------------------------------------------------------------------------------------------
async function main() {
  let list = FIXTURES.filter((f) => (!SMOKE_ONLY || f.smoke) && (!ONLY || ONLY.some((o) => f.id.includes(o))));
  if (!list.length) throw new Error('no fixtures selected');
  for (const d of ['smoke', 'out', 'stimuli']) fs.mkdirSync(path.join(GOLD, d), { recursive: true });

  // stimuli (always: cheap); mono stimuli are written as 1-channel files to keep the committed set small
  const stimuli = {};
  for (const id of Object.keys(STIMULI)) {
    const { L, R, def } = makeStimulus(id, GOLDEN_SR);
    const stereo = def.kind === 'stereo-noise';
    const buf = encodeWavF32(stereo ? [L, R] : [L], GOLDEN_SR);
    const file = `stimuli/${id}.wav`;
    fs.writeFileSync(path.join(GOLD, file), buf);
    stimuli[id] = { file, channels: stereo ? 2 : 1, frames: L.length, sha256: sha256(buf), leadSec: STIM_LEAD_SEC, def };
  }

  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launch();
  const pages = [];
  for (let i = 0; i < REPEAT; i++) pages.push(await openPage(browser, base));
  const chromiumVersion = browser.version();

  // coverage check: every synth / organ in the registry has a fixture
  const refs = await pages[0].instruments();
  const missing = refs.filter((r) => (r.type === 'synth' && !SYNTH_IDS.includes(r.id)) || (r.type === 'organ' && !ORGAN_IDS.includes(r.id)));
  if (missing.length) console.warn(`WARNING: instruments without a fixture: ${missing.map((r) => `${r.type}:${r.id}`).join(', ')}`);

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
    const classification = repeatable === false || random ? 'statistical' : 'exact';
    const issues = [...new Set([...(a.warnings || []), ...a.console])].filter(Boolean);
    const entry = {
      id: fx.id,
      kind: fx.kind,
      classification,
      // statistical only because of seeded PRNG streams: exact once the native side ports mulberry32 + the streams
      exactIfPrngPorted: classification === 'statistical' && repeatable !== false,
      smoke: !!fx.smoke,
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
      tolerance: classification === 'exact' ? TOL_EXACT : TOL_STAT,
      randomness,
      fixture: fx,
      resolved: a.resolved,
      issues,
    };
    if (runs.length > 1) {
      entry.repeatEnvCorr = round(envCorrelation(envelopeDb(a.chs, a.sr), envelopeDb(runs[1].chs, a.sr)));
      entry.repeatBandsDb = round(bandDiff(entry.bandsDb, thirdOctaveBands(runs[1].chs, a.sr)).worstDb, 4);
    }
    entries.set(fx.id, entry);
    const pct = lv.peak > 0 ? lv.peakDb.toFixed(1) : '-inf';
    console.log(`[${i}/${list.length}] ${fx.id.padEnd(28)} ${classification.padEnd(11)} peak ${pct.padStart(6)} dB  ` +
      `repeat ${rep === null ? '-' : rep.toExponential(2)}  ${((Date.now() - tf) / 1000).toFixed(1)} s` +
      (issues.length ? `  issues: ${issues.length}` : '') + (lv.peak === 0 && !/dry|none/.test(fx.id) ? '  SILENT' : ''));
  }
  const renderSec = (Date.now() - t0) / 1000;
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
    chromium: chromiumVersion,
    node: process.version,
    sampleRate: GOLDEN_SR,
    format: 'WAV 32-bit IEEE float, interleaved stereo (stimuli: mono unless channels 2)',
    exactRepeatThreshold: EXACT_REPEAT,
    tolerances: { exact: TOL_EXACT, statistical: TOL_STAT },
    measures: 'tools/golden/analysis.mjs (definitions in its header and native/golden/README.md)',
    lastRun: { fixtures: list.length, repeat: REPEAT, seconds: Math.round(renderSec * 10) / 10, cpus: os.cpus().length },
    stimuli,
    fixtures,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
  const sizeOf = (d) => fs.readdirSync(path.join(GOLD, d)).reduce((s, f) => s + fs.statSync(path.join(GOLD, d, f)).size, 0);
  const by = (k) => fixtures.reduce((m, e) => ((m[e[k]] = (m[e[k]] || 0) + 1), m), {});
  console.log(`\n${list.length} fixtures rendered ×${REPEAT} in ${renderSec.toFixed(1)} s (chromium ${chromiumVersion})`);
  console.log(`manifest: ${fixtures.length} fixtures; by kind ${JSON.stringify(by('kind'))}; ${JSON.stringify(by('classification'))}`);
  const MB = (b) => (b / 1048576).toFixed(2);
  console.log(`sizes: smoke ${MB(sizeOf('smoke'))} MB, stimuli ${MB(sizeOf('stimuli'))} MB, out ${MB(sizeOf('out'))} MB, ` +
    `manifest ${MB(fs.statSync(manifestPath).size)} MB`);
  const reps = fixtures.map((e) => e.repeatMaxAbsDiff).filter((x) => x !== null && x !== undefined);
  if (reps.length) console.log(`repeat max|diff|: max ${Math.max(...reps).toExponential(2)}, ` +
    `exactly 0 in ${reps.filter((x) => x === 0).length}/${reps.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
