// Phase-1 tests for app/js/engine/synth-extra.js. `node test/phase1/synth-extra/run.mjs` → exit 0 on pass.
//   --only id,id     restrict the per-patch checks
//   --calibrate      measure every patch with the tools/calibrate.mjs method and print gainTrim corrections
//   --write          (with --calibrate) iterate and rewrite the `gainTrim` numbers in synth-extra.js until all are within ±0.1 dB
// Renders in seeded OfflineAudioContexts inside headless Chromium; analysis in page JS (+ tools/lib/analysis.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../../app/js/engine/synth-extra.js');
const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const ONLY = has('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const TARGET = -18;

const results = [];
let failed = 0;
function check(name, ok, info) {
  results.push({ name, ok, info });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  — ${info}` : ''}`);
}
const f1 = (x) => (x === -Infinity ? '-inf' : x === null || x === undefined ? 'n/a' : Number(x).toFixed(1));
const f2 = (x) => Number(x).toFixed(2);

const { server, port } = await startServer(0);
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
let page;
const consoleErrors = [];

async function openPage() {
  page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/__test/harness.html`);
  await page.waitForFunction(() => window.harnessReady === true, null, { timeout: 15000 });
}
const T = (name, ...a) => page.evaluate(([n, x]) => window.T[n](...x), [name, a]);

async function calibrate(write) {
  for (let pass = 1; pass <= (write ? 4 : 1); pass++) {
    const list = await T('list');
    let worst = 0;
    const src = fs.readFileSync(SRC, 'utf8');
    let out = src;
    console.log(`calibration pass ${pass} (target ${TARGET} dBFS band RMS)`);
    for (const p of list) {
      const m = await T('calib', p.id);
      const next = Math.round((p.gainTrim + (TARGET - m.bandDb)) * 10) / 10;
      const raw8 = (await T('peak8', p.id, true)).peakDb + (next - p.gainTrim);
      worst = Math.max(worst, Math.abs(m.bandDb - TARGET));
      console.log(`  ${p.id.padEnd(14)} measured ${f2(m.bandDb)} dBFS at gainTrim ${p.gainTrim} → ${next}   (peak ${f1(m.peakDb + next - p.gainTrim)}, 8-voice vel-1 raw peak ${f1(raw8)} dBFS, DC ${m.dc.toExponential(1)}, mono loss ${f2(m.monoLossDb)} dB)`);
      const re = new RegExp(`(patch\\('${p.id}', '[^']*', '[^']*', )(-?[0-9.]+)(,)`);
      if (!re.test(out)) throw new Error(`gainTrim for ${p.id} not found in source`);
      out = out.replace(re, `$1${next}$3`);
    }
    if (!write) return;
    if (worst <= 0.1) { console.log('  all within ±0.1 dB'); return; }
    fs.writeFileSync(SRC, out);
    await page.close();
    await openPage(); // reload the module with the new numbers
  }
}

try {
  await openPage();
  if (has('--calibrate')) {
    await calibrate(has('--write'));
  } else {
    const all = (await T('list')).filter((p) => !ONLY || ONLY.has(p.id));
    console.log(`patches: ${all.map((x) => `${x.id} [${x.group}]`).join(', ')}\n`);

    console.log('— metadata');
    for (const p of all) {
      check(`meta ${p.id}`, typeof p.name === 'string' && typeof p.group === 'string' && Number.isFinite(p.gainTrim) && p.params.length > 0 && new Set(p.params).size === p.params.length,
        `${p.params.length} params, gainTrim ${p.gainTrim} dB`);
    }

    console.log('\n— basic: one note vel .8, 1 s, release');
    for (const { id } of all) {
      const r = await T('basic', id);
      check(`basic ${id}`,
        !r.nan && r.holdRmsDb > -50 && r.peakDb <= -1 && r.tailDb < -60 && r.liveVoices === 0 && r.liveNodes === 0 && r.voiceNodes === 0,
        `hold RMS ${f1(r.holdRmsDb)} dBFS, peak ${f1(r.peakDb)}, tail@off+r·1.3+.5 ${f1(r.tailDb)} dBFS (r=${r.release}s), live ${r.liveVoices}/${r.voiceNodes}`);
    }

    console.log('\n— release during attack (noteOff 0.2 s into a 1.2 s attack where the patch has one)');
    for (const { id } of all) {
      const r = await T('releaseDuringAttack', id);
      check(`release-in-attack ${id}`,
        !r.nan && r.maxAfterDb <= r.atOffDb + 1 && r.tailDb < -60 && (!r.hasAttack || r.unreleasedLevelDb < r.atOffDb - 12) && r.liveVoices === 0,
        `at off ${f1(r.atOffDb)} dB, max after ${f1(r.maxAfterDb)} dB, tail ${f1(r.tailDb)} dBFS${r.hasAttack ? `, level at 1.3 s ${f1(r.unreleasedLevelDb)} dB` : ' (no attack param)'}`);
    }

    console.log('\n— 8 voices at velocity 1: peak ≤ −1 dBFS (and what the safety ceiling had to catch)');
    const peaks = {};
    for (const { id } of all) {
      const r = await T('peak8', id);
      const b = await T('peak8', id, true);
      peaks[id] = { withCeil: r.peakDb, raw: b.peakDb };
      check(`peak8 ${id}`, !r.nan && r.peakDb <= -1, `${f1(r.peakDb)} dBFS (without ceiling ${f1(b.peakDb)} dBFS${b.peakDb > -3 ? ', ceiling knee engaged' : ''})`);
    }

    console.log('\n— calibration (tools/calibrate.mjs method, 48 kHz): band RMS −18 ±0.5 dBFS, |DC| < 1e-3, mono-sum loss < 3 dB');
    for (const { id, gainTrim } of all) {
      const r = await T('calib', id);
      const raw = await T('calib', id, 0, null, true);
      r.peakDb = raw.peakDb; // report the chord's raw (pre-ceiling) peak: below −3 dBFS = the ceiling never touches it
      check(`gainTrim ${id}`, !r.nan && Math.abs(r.bandDb - TARGET) <= 0.5,
        `${f2(r.bandDb)} dBFS over ${r.window.join('–')} s at gainTrim ${gainTrim} dB (chord raw peak ${f1(r.peakDb)} dBFS)${r.window[1] !== 3 ? `; literal 0–3 s method reads ${f2(r.band03Db)} dBFS` : ''}`);
      check(`DC ${id}`, Math.abs(r.dc) < 1e-3, `|DC| ${Math.abs(r.dc).toExponential(1)}`);
      check(`mono-sum ${id}`, r.monoLossDb < 3, `loss ${f2(r.monoLossDb)} dB`);
    }
    {
      const r = await T('calib', 'supersaw-pad', 1);
      console.log(`      (supersaw-pad at morph 1 — widest: mono-sum loss ${f2(r.monoLossDb)} dB, band ${f2(r.bandDb)} dBFS)`);
    }

    console.log('\n— voice stealing (17th note steals the oldest, 20 ms fade)');
    for (const { id } of all) {
      const s = await T('steal', id, 'steal');
      const h = await T('steal', id, 'hard');
      check(`steal ${id}`,
        // pre-steal renders must match to within the render-to-render noise floor (FM patches amplify Chromium's
        // input-summation-order noise to ~1e-4); the SPEC mix detector may not rise by more than 15 % over the no-steal mix
        s.steals === 1 && s.preDiff < Math.max(1e-4, 2 * s.noiseFloor) && (s.hfRatioDb < 3 || s.hfFracDb < -60) &&
          s.mixRatio <= Math.max(6, s.mixRatioNoSteal * 1.15) && !s.nan && s.stolenState === 'dead' && s.stolenNodes === 0,
        `HF(D)/HF(voice) ${f1(s.hfRatioDb)} dB, HF(D)/E(voice) ${f1(s.hfFracDb)} dB [hard kill ${f1(h.hfRatioDb)} / ${f1(h.hfFracDb)} dB]; ` +
          `mix |Δx|/median ${f2(s.mixRatio)} (no steal ${f2(s.mixRatioNoSteal)}); pre-steal |Δ| ${s.preDiff.toExponential(1)} (noise ${s.noiseFloor.toExponential(1)})`);
    }

    console.log('\n— kill() / dispose() / allOff bookkeeping');
    for (const { id } of all) {
      const r = await T('kill', id);
      check(`kill ${id}`, r.liveVoices === 0 && r.liveNodes === 0 && r.voiceNodes === 0 && r.states.join() === 'dead' && r.tailDb < -80,
        `nodes before ${r.nodesBefore.join('/')}, after ${r.voiceNodes}, tail ${f1(r.tailDb)} dBFS`);
      const d = await T('dispose', id);
      check(`dispose ${id}`, d.peak === 0 && d.noteOnAfterDispose === null && d.liveVoices === 0 && d.voiceNodes === 0, `peak ${d.peak}, live voices ${d.liveVoices}`);
      const o = await T('allOff', id);
      check(`allOff ${id}`, o.tailDb < -60 && o.liveVoices === 0 && o.liveNodes === 0, `before ${f1(o.before)} dB, after fade ${f1(o.tailDb)} dBFS`);
    }

    console.log('\n— morph direction');
    for (const { id } of all) {
      const r = await T('morphEffect', id);
      check(`morph ${id} (${r.metric} up)`, r.m1 > r.m0 * 1.05, `${r.metric} ${f2(r.m0)} → ${f2(r.m1)} (${f1(((r.m1 / r.m0) - 1) * 100)} %)`);
    }

    console.log('\n— setParam / morph / bend / legato on held notes');
    for (const { id } of all) {
      const r = await T('allParams', id);
      const rejected = Object.entries(r.accepted).filter(([k, v]) => k !== '__unknown' && !v).map(([k]) => k);
      check(`params ${id}`, !r.nan && r.peakDb <= -1 && r.tailDb < -60 && rejected.length === 0 && r.accepted.__unknown === false && r.liveVoices === 0,
        `${Object.keys(r.accepted).length - 1} params, peak ${f1(r.peakDb)} dBFS, tail ${f1(r.tailDb)} dBFS${rejected.length ? `, rejected ${rejected}` : ''}`);
    }

    const want = (id) => !ONLY || ONLY.has(id);
    console.log('\n— patch-specific');
    if (want('supersaw-pad')) {
      const r = await T('supersawClusters');
      check('supersaw-pad ≥ 6 distinct partials per harmonic cluster', r.count >= 6,
        `${r.count} peaks around H4 of C4 at ${r.peaks.join(', ')}¢; −20 dB cluster width ${f1(r.widthCents)}¢`);
    }
    if (want('pluck')) {
      const c3 = await T('pluckDecay', 48);
      const c6 = await T('pluckDecay', 84);
      check('pluck decay C6 shorter than C3', c6.t20 < c3.t20 * 0.8 && c3.reached && c6.reached, `−20 dB after ${f2(c3.t20)} s (C3) vs ${f2(c6.t20)} s (C6)`);
    }
    if (want('808-sub')) {
      const r = await T('pitchDrop808');
      check('808-sub pitch drop = 2 st exponential over 60 ms', r.glideCycles >= 2 && r.modelErrCents < 10 && r.dropSemis > 1.0 && Math.abs(r.lateErrCents) < 3 && r.settledAt !== null && r.settledAt < 0.1,
        `per-cycle pitch within ${f1(r.modelErrCents)}¢ of the 2 st/60 ms model over ${r.glideCycles} cycles; first cycle ${f1(r.firstHz)} Hz @${Math.round(r.firstAt * 1000)} ms → ` +
          `${f2(r.lateHz)} Hz (target ${f2(r.target)}, ${f1(r.lateErrCents)}¢), within 0.1 st by ${Math.round((r.settledAt ?? NaN) * 1000)} ms; cycles [ms,Hz] ${JSON.stringify(r.cycles)}`);
      const z = await T('pitchDrop808', { pitchDrop: 0 });
      check('808-sub pitchDrop 0 = no drop', Math.abs(z.dropSemis) < 0.05, `${f2(z.dropSemis)} st`);
    }
    if (want('dx-epiano')) {
      const lo = await T('dxVelocity', 0.3);
      const hi = await T('dxVelocity', 0.95);
      check('dx-epiano brightness rises with velocity', hi.centroidHz > lo.centroidHz * 1.2 && hi.overtoneDb > lo.overtoneDb + 10,
        `overtones (≥1.5·f) vs fundamental, first .37 s: ${f1(lo.overtoneDb)} dB (vel .3) → ${f1(hi.overtoneDb)} dB (vel .95); ` +
          `centroid 0.05–0.85 s ${Math.round(lo.centroidHz)} → ${Math.round(hi.centroidHz)} Hz; level ${f1(lo.rmsDb)} → ${f1(hi.rmsDb)} dBFS`);
    }
    for (const id of ['square-lead', '808-sub', 'synth-bass']) {
      if (!want(id)) continue;
      const r = await T('legato', id);
      check(`legatoTo + bend ${id}`, Math.abs(r.beforeHz / r.expectBefore - 1) < 0.005 && Math.abs(r.afterHz / r.expectAfter - 1) < 0.005,
        `${f2(r.beforeHz)} Hz (expect ${f2(r.expectBefore)}) → ${f2(r.afterHz)} Hz (expect ${f2(r.expectAfter)})`);
    }
    if (!ONLY) {
      const r = await T('determinism');
      check('seeded render is deterministic', r.sameSeedMaxDiff < 1e-5 && r.otherSeedMaxDiff > 1e-2, `same seed ${r.sameSeedMaxDiff.toExponential(1)}, other seed ${r.otherSeedMaxDiff.toExponential(1)}`);
    }

    console.log('\n— CPU: 16 voices × 4 s offline (best of 3; synth.js warm-pad rendered interleaved as the reference)');
    for (const { id } of all) {
      const r = await T('perf', id);
      check(`perf ${id}`, r.xRealtime > 1.5 || r.relCost < 1.6,
        `${f1(r.xRealtime)}× realtime (${Math.round(r.renderMs)} ms), ${f2(r.relCost)}× warm-pad's cost (warm-pad ${f1(r.refX)}× here), ${r.nodes} voice nodes`);
    }

    console.log('\n— real-time AudioContext');
    for (const id of ['supersaw-pad', 'dx-epiano', '808-sub'].filter(want)) {
      const r = await T('realtime', id);
      check(`realtime ${id}`, r.onDb > -50 && r.offDb < -60 && r.live === 0, `on ${f1(r.onDb)} dBFS after 250 ms, ${f1(r.offDb)} dBFS after release, live voices ${r.live}`);
    }

    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  }
} catch (e) {
  console.error(e);
  failed++;
} finally {
  await browser.close();
  server.close();
}

if (!has('--calibrate')) console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
