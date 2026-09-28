// Phase-1 instrument tests (synth.js, organ.js, voice.js). `node test/phase1/instruments/run.mjs` → exit 0 on pass.
// Renders in a seeded OfflineAudioContext inside headless Chromium and analyses the buffers in page JS.
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const results = [];
let failed = 0;
function check(name, ok, info) {
  results.push({ name, ok, info });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  — ${info}` : ''}`);
}
const f1 = (x) => (x === -Infinity ? '-inf' : Number(x).toFixed(1));
const f2 = (x) => Number(x).toFixed(2);

const { server, port } = await startServer(0);
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

try {
  await page.goto(`http://127.0.0.1:${port}/__test/harness.html`);
  await page.waitForFunction(() => window.harnessReady === true, null, { timeout: 15000 });
  const T = (name, ...args) => page.evaluate(([n, a]) => window.T[n](...a), [name, args]);
  const all = await T('list');
  console.log(`instruments: ${all.map((x) => x.id).join(', ')}\n`);

  // 1. basic note per patch/preset
  console.log('— basic: C4 vel .8, 1 s, release');
  for (const { kind, id } of all) {
    const r = await T('basic', kind, id);
    check(`basic ${id}`,
      !r.nan && r.holdRmsDb > -50 && r.peakDb <= 0 && r.tailDb < -60 && r.liveVoices === 0 && r.liveNodes === 0 && r.voiceNodes === 0,
      `hold RMS ${f1(r.holdRmsDb)} dBFS, peak ${f1(r.peakDb)} dBFS, tail@r·1.3+.5 ${f1(r.tailDb)} dBFS (r=${r.release}s), live voices ${r.liveVoices}, nodes ${r.voiceNodes}`);
  }

  // 2. release during attack (REVIEW 1.1)
  console.log('\n— release during attack (noteOff 0.2 s into a 1.2 s attack)');
  for (const { kind, id } of all) {
    const r = await T('releaseDuringAttack', kind, id);
    check(`release-in-attack ${id}`,
      !r.nan && r.maxAfterDb <= r.atOffDb + 1 && r.tailDb < -60 && (!r.hasAttack || r.unreleasedLevelDb < r.atOffDb - 12) && r.liveVoices === 0,
      `at off ${f1(r.atOffDb)} dB, max after ${f1(r.maxAfterDb)} dB, tail ${f1(r.tailDb)} dBFS${r.hasAttack ? `, level at 1.3 s ${f1(r.unreleasedLevelDb)} dB` : ' (no attack param)'}`);
  }

  // 3. steal at 17 voices. The SPEC detector (|Δx| > 6× 20 ms local median) is applied to the mix and must not
  // rise above what the material itself scores without a steal; the isolated steal transient D = C − A must add no
  // broadband energy: HF(D) ≤ HF(stolen voice) + 3 dB, or HF(D) ≥ 60 dB below the stolen voice's energy.
  // Detector sanity: a hard kill (no fade) must be flagged on the darker patches, where it is audible;
  // on bright ones (strings, soft-keys, full organ…) a hard kill is masked by the voice's own HF and not asserted.
  console.log('\n— voice stealing (17th note steals the oldest, 20 ms fade)');
  // warm-pad / drone-osc left the positive-control set with the instruments fixes (per-voice HPF moved to the bus,
  // Butterworth LPF pair): a hard kill there now measures HF(D) ≈ HF(voice) and −73/−80 dB re the voice's energy,
  // i.e. it is no longer an audible click to control against (it was +24.5/+25.3 dB before).
  const DARK = new Set(['bell', 'gospel', 'soft-pad', 'church']);
  const flagged = (r) => r.hfRatioDb > 10 && r.hfFracDb > -60;
  // preDiff (C − A before the steal) is Chromium's input-summation-order jitter integrated through 16 voices' a-rate
  // FM inputs: 0.7–1.4e-4 run to run on soft-keys (round2-engine m4), −78 dB and not a pre-steal change. A real
  // early fade/kill shows up at the voice's own level (≥ 1e-2), so 1e-3 (−60 dB) still catches it without flaking.
  const PRE_TOL = 1e-3;
  for (const { kind, id } of all) {
    const s = await T('steal', kind, id, 'steal');
    const h = await T('steal', kind, id, 'hard');
    check(`steal ${id}`,
      s.steals === 1 && s.preDiff < PRE_TOL && (s.hfRatioDb < 3 || s.hfFracDb < -60) && !flagged(s) &&
        s.mixRatio <= Math.max(6, s.mixRatioNoSteal * 1.1) && !s.nan && s.stolenState === 'dead' && s.stolenNodes === 0,
      `HF(D)/HF(voice) ${f1(s.hfRatioDb)} dB, HF(D)/E(voice) ${f1(s.hfFracDb)} dB [hard kill ${f1(h.hfRatioDb)} / ${f1(h.hfFracDb)} dB]; ` +
        `mix |Δx|/median ${f2(s.mixRatio)} (no steal ${f2(s.mixRatioNoSteal)}); stolen voice ${s.stolenState}; pre-steal Δ ${s.preDiff.toExponential(1)}`);
    if (DARK.has(id)) check(`click detector flags a hard kill (${id})`, flagged(h), `${f1(h.hfRatioDb)} dB / ${f1(h.hfFracDb)} dB`);
  }

  // 4. kill(): zero live nodes
  console.log('\n— kill() bookkeeping');
  for (const { kind, id } of all) {
    const r = await T('kill', kind, id);
    check(`kill ${id}`, r.liveVoices === 0 && r.liveNodes === 0 && r.voiceNodes === 0 && r.states.join() === 'dead' && r.tailDb < -80,
      `nodes before ${r.nodesBefore.join('/')}, after ${r.voiceNodes}, states ${r.states.join(',')}, tail ${f1(r.tailDb)} dBFS`);
  }

  // 4b. dispose
  for (const { kind, id } of all) {
    const r = await T('dispose', kind, id);
    check(`dispose ${id}`, r.peak === 0 && r.noteOnAfterDispose === null && r.liveVoices === 0 && r.voiceNodes === 0, `peak ${r.peak}, live voices ${r.liveVoices}`);
  }

  // 5. organ drawbar spectrum
  console.log('\n— organ drawbars');
  {
    const a = await T('drawbarPeak', '800000000');
    check('drawbar 800000000 peak at f/2', Math.abs(a.peakHz / (a.f / 2) - 1) < 0.01, `${f2(a.peakHz)} Hz (f/2 = ${f2(a.f / 2)})`);
    const b = await T('drawbarPeak', '008000000');
    check('drawbar 008000000 peak at f', Math.abs(b.peakHz / b.f - 1) < 0.01, `${f2(b.peakHz)} Hz (f = ${f2(b.f)})`);
  }

  // 6. rotary speed
  console.log('\n— rotary AM rate');
  {
    const fast = await T('rotaryRate', 'fast');
    const slow = await T('rotaryRate', 'slow');
    const morph = await T('rotaryRate', 'fast', true);
    check('rotary fast AM rate 5–7.5 Hz', fast.L.hz > 5 && fast.L.hz < 7.5, `L ${f2(fast.L.hz)} Hz (depth ${f2(fast.L.depth)}), R ${f2(fast.R.hz)} Hz`);
    check('rotary slow AM rate < 1.5 Hz', slow.L.hz < 1.5, `L ${f2(slow.L.hz)} Hz (depth ${f2(slow.L.depth)}), R ${f2(slow.R.hz)} Hz`);
    check('organ morph(1) → fast rotary', morph.L.hz > 5 && morph.L.hz < 7.5, `L ${f2(morph.L.hz)} Hz`);
  }

  // 7. EP keytracked decay
  console.log('\n— soft-keys keytracked decay');
  {
    const c3 = await T('epDecay', 48);
    const c6 = await T('epDecay', 84);
    check('soft-keys decay C3 longer than C6', c3.t20 > c6.t20 * 2, `−20 dB after ${f2(c3.t20)} s (C3) vs ${f2(c6.t20)} s (C6)`);
  }

  // 8. sub-bass 2nd harmonic
  console.log('\n— sub-bass 2nd harmonic');
  {
    const d0 = await T('subHarmonic', 0);
    const dd = await T('subHarmonic', 0.3);
    const d1 = await T('subHarmonic', 1);
    check('sub-bass 2nd harmonic present (default drive)', dd.h2dB > -35, `H2 ${f1(dd.h2dB)} dB re H1 (drive 0: ${f1(d0.h2dB)}, drive 1: ${f1(d1.h2dB)})`);
    check('sub-bass drive raises H2', d1.h2dB > d0.h2dB + 3, `${f1(d0.h2dB)} → ${f1(d1.h2dB)} dB`);
  }

  // 9. drone drift
  console.log('\n— drone-osc per-voice drift');
  {
    const on = await T('droneDrift', 3);
    const off = await T('droneDrift', 0);
    check('drone-osc frequency drifts', on.spreadCents > 0.5 && on.spreadCents < 7 && off.spreadCents < 0.1,
      `4th-harmonic spread ${f2(on.spreadCents)}¢ over 20 s (drift 0: ${f2(off.spreadCents)}¢)`);
  }

  // 9b. strings delayed vibrato (SPEC §3.3: depth stays 0 for .5 s after noteOn, then ramps in)
  console.log('\n— strings delayed vibrato');
  {
    const r = await T('vibratoOnset');
    check('strings vibrato: none in the first 0.4 s', r.earlyPpCents < 1, `4th-harmonic p-p ${f2(r.earlyPpCents)}¢ over ${r.windows[0]} windows`);
    check('strings vibrato: present after 1.0 s (±8¢)', r.latePpCents > 8 && r.latePpCents < 24, `4th-harmonic p-p ${f2(r.latePpCents)}¢ over ${r.windows[1]} windows`);
  }

  // 10. morph direction
  console.log('\n— morph direction');
  for (const { kind, id } of all.filter((x) => x.kind === 'synth')) {
    const r = await T('morphEffect', kind, id);
    check(`morph ${id} (${r.metric} up)`, r.m1 > r.m0 * 1.05, `${r.metric} ${f2(r.m0)} → ${f2(r.m1)}`);
  }

  // 11. bend + legato
  console.log('\n— bend / legato');
  {
    const r = await T('bendLegato');
    check('setBend(+2) pitch', Math.abs(r.bentHz / r.expectBent - 1) < 0.005, `${f2(r.bentHz)} Hz (expect ${f2(r.expectBent)})`);
    check('legatoTo glide target', Math.abs(r.legatoHz / r.expectLegato - 1) < 0.005, `${f2(r.legatoHz)} Hz (expect ${f2(r.expectLegato)}, bend kept)`);
  }

  // 12. every param
  console.log('\n— setParam / morph / bend on held notes');
  for (const { kind, id } of all) {
    const r = await T('allParams', kind, id);
    const rejected = Object.entries(r.accepted).filter(([k, v]) => k !== '__unknown' && !v).map(([k]) => k);
    check(`params ${id}`, !r.nan && r.peakDb <= 0 && r.tailDb < -60 && rejected.length === 0 && r.accepted.__unknown === false && r.liveVoices === 0,
      `${Object.keys(r.accepted).length - 1} params, peak ${f1(r.peakDb)} dBFS, tail ${f1(r.tailDb)} dBFS${rejected.length ? `, rejected ${rejected}` : ''}`);
  }

  // 13. allOff
  console.log('\n— allOff (30 ms)');
  for (const { kind, id } of all) {
    const r = await T('allOff', kind, id);
    check(`allOff ${id}`, r.tailDb < -60 && r.liveVoices === 0 && r.liveNodes === 0, `before ${f1(r.before)} dB, after fade ${f1(r.tailDb)} dBFS`);
  }

  // 14. determinism
  {
    const r = await T('determinism');
    check('seeded render is deterministic', r.sameSeedMaxDiff < 1e-5 && r.otherSeedMaxDiff > 1e-2, `same seed max |Δ| ${r.sameSeedMaxDiff.toExponential(1)}, other seed ${r.otherSeedMaxDiff.toExponential(1)}`);
  }


  // ===== instruments fixes (reviews/instruments.md, reviews/audition-findings.md E1) =====
  console.log('\n— fixes: organ percussion (M1)');
  {
    const r0 = await T('percussion', 0);
    const r5 = await T('percussion', 5);
    const ok = (r) => r.chord.every((c) => c.perc > c.noPerc + 30);
    const fmt = (r) => r.chord.map((c) => `${c.note}: ${f1(c.perc)}/${f1(c.noPerc)}`).join(', ');
    check('percussion on every note of a chord at the same when', ok(r0), `3f with/without perc (dB) ${fmt(r0)}`);
    check('percussion on every note of a 5 ms roll', ok(r5), fmt(r5));
    const [a, b, c] = r0.rearmLevels;
    check('percussion single-trigger + re-arm', a > 0.85 && b === 0 && c > 0.85, `levels: first ${f2(a)}, added after 1.95 s held ${f2(b)}, after all keys up ${f2(c)}`);
  }

  console.log('\n— fixes: organ morph relative to rotary (M2)');
  {
    const g0 = await T('organMorph', 'fast', 0);
    const g1 = await T('organMorph', 'fast', 1);
    const s1 = await T('organMorph', 'slow', 1);
    const o1 = await T('organMorph', 'off', 1);
    check('gospel (fast) morph 0 stays fast', g0.speed === 'fast' && g0.am.hz > 5 && g0.am.hz < 7.5, `${g0.speed}, AM ${f2(g0.am.hz)} Hz`);
    check('fast + morph ≥ .5 → slow', g1.speed === 'slow' && g1.am.hz < 1.5, `${g1.speed}, AM ${f2(g1.am.hz)} Hz`);
    check('slow + morph ≥ .5 → fast', s1.speed === 'fast' && s1.am.hz > 5 && s1.am.hz < 7.5, `${s1.speed}, AM ${f2(s1.am.hz)} Hz`);
    check('rotary off: morph is a no-op', o1.speed === 'slow', `rotor state ${o1.speed} (built slow, never switched)`);
    const e = await T('engineGospel');
    check('real engine: committed gospel measures ~6–7 Hz AM', e.am.hz > 5 && e.am.hz < 7.5 && e.speed === 'fast', `AM ${f2(e.am.hz)} Hz, rotor ${e.speed}, morph ${e.morph}`);
  }

  console.log('\n— fixes: FM Nyquist guard (M3, m6, m9)');
  {
    const c7 = await T('fmAlias', 'bell', 96, 1);
    check('bell C7 morph 1 aliasing < −30 dB', c7.aliasDb < -30, `alias ${f1(c7.aliasDb)} dB re total (was −7.5), loudest ${f1(c7.worstReF0Db)} dB re f0`);
    let worst = -Infinity; const parts = [];
    for (const [n, m, p] of [[84, 1, {}], [88, 1, {}], [91, 1, {}], [93, 1, {}], [100, 1, {}], [84, 0, { index: 6 }], [72, 0, { index: 6, ratio: 8 }]]) {
      const r = await T('fmAlias', 'bell', n, m, p);
      worst = Math.max(worst, r.aliasDb); parts.push(`${n}/${m}${p.index ? '/i' + p.index : ''}${p.ratio ? '/r' + p.ratio : ''} ${f1(r.aliasDb)}`);
    }
    check('bell top octaves / max index+ratio aliasing < −30 dB', worst < -30, parts.join(', '));
    const t1 = await T('fmAlias', 'soft-keys', 89, 0, { tine: 2 }, 0.012);
    const t2 = await T('fmAlias', 'soft-keys', 84, 0, {}, 0.012);
    check('soft-keys tine sidebands: no alias peak above −60 dB re f0 (F6 tine 2, C6)', t1.worstReF0Db < -60 && t2.worstReF0Db < -60, `F6 ${f1(t1.worstReF0Db)} dB, C6 ${f1(t2.worstReF0Db)} dB`);
    for (const [id, mode] of [['bell', 'legato'], ['bell', 'morph'], ['soft-keys', 'legato']]) {
      const r = await T('fmRescale', id, mode);
      check(`${id} index follows ${mode} (m6)`, Math.abs(r.movedDb - r.freshDb) < 1.5, `upper sideband re carrier: moved ${f1(r.movedDb)} dB vs fresh ${f1(r.freshDb)} dB`);
    }
  }

  console.log('\n— fixes: soft-keys DC (audition E1)');
  {
    const r = await T('softKeysDC');
    check('soft-keys C3 chord |DC| < 1e-3', Math.abs(r.dc) < 1e-3, `mean ${r.dc.toExponential(1)} over 0.05–2.5 s (was −1.5e-2), worst 100 ms mean ${r.worst100ms.toExponential(1)}, RMS ${r.rms.toExponential(1)}`);
  }

  console.log('\n— fixes: filter Q in dB (m1)');
  {
    const r = await T('filters');
    check('lpfPair is Butterworth-4 (−3 dB at fc, no bump)', Math.abs(r.pairAtFcDb + 3.01) < 0.2 && r.pairPeakDb < 0.1, `at fc ${f2(r.pairAtFcDb)} dB, peak ${f2(r.pairPeakDb)} dB`);
    check('warm-pad resonance 1 = +12 dB peak', Math.abs(r.res1PeakDb - 12) < 0.5, `${f2(r.res1PeakDb)} dB`);
    check('single 2-pole Butterworth −3.01 dB at fc (sub-bass LPF)', Math.abs(r.subLpfAtFcDb + 3.01) < 0.1, `${f2(r.subLpfAtFcDb)} dB; bus HPF Q ${f2(r.busHpfQ)}`);
    check('organ crossover power-flat at 800 Hz', Math.abs(r.xoverPowerSumDb) < 0.1 && Math.abs(r.xoverLpDb + 3.01) < 0.1, `LP ${f2(r.xoverLpDb)} dB, HP ${f2(r.xoverHpDb)} dB, |LP|²+|HP|² ${f2(r.xoverPowerSumDb)} dB`);
    for (const sp of ['slow', 'fast']) {
      const b = await T('rotaryBand', sp);
      check(`rotary (${sp}) at the crossover within ±0.5 dB of the rotors' AM mean`, Math.abs(b.levelDb - b.expectedDb) < 0.5, `${f2(b.levelDb)} dB re dry vs ${f2(b.expectedDb)} expected`);
    }
  }

  console.log('\n— fixes: WaveShaper latency (m2)');
  {
    const r = await T('onsets');
    const fr = r.frames;
    check('soft-keys / sub-bass / organ (drive ≤ .5) onset ≤ 4 frames', fr['soft-keys'] <= 4 && fr['sub-bass'] <= 4 && fr.gospel <= 4 && fr.full <= 4, JSON.stringify(fr) + ' (was 179 / 131 / 193 / 193)');
    check('organ drive > .5 → 2x (latency 128 frames)', fr['full@0.8'] > 100 && fr['full@0.8'] < 140, `${fr['full@0.8']} frames (4x was 193)`);
    check('organ oversample switches only while silent', r.os.gospelDefault === 'none' && r.os.afterDrive09Idle === '2x' && r.os.afterDrive09WhilePlaying === 'none', JSON.stringify(r.os));
  }

  console.log('\n— fixes: rotary Doppler phase (m5), glass H3 (m3), tremolo (m4), mono lows (m7)');
  {
    const h = await T('hornPhase');
    check('horn pitch peak leads loudness peak by ~90°', h.pitchLeadDeg > 70 && h.pitchLeadDeg < 110, `${Math.round(h.pitchLeadDeg)}° (was −91°), rotor ${f2(h.rotorHz)} Hz, ±${f1(h.devHz)} Hz`);
    const g = await T('glassWave');
    check('glass partials 2/3 at −6/−14 dB', Math.abs(g.h2Db + 6) < 0.5 && Math.abs(g.h3Db + 14) < 0.5, `H2 ${f2(g.h2Db)} dB, H3 ${f2(g.h3Db)} dB (H3 was −21.7)`);
    const t = await T('tremolo');
    check('soft-keys tremolo: mono flutter ≤ 1 dB at full depth, sides modulated', t.monoPkPkDb <= 1 && t.sidePkPkDb > 10, `mono ${f2(t.monoPkPkDb)} dB p-p (was 3.3), side ${f1(t.sidePkPkDb)} dB p-p`);
    for (const [id, n] of [['warm-pad', 36], ['drone-osc', 38]]) {
      const r = await T('lowSide', id, n);
      check(`${id} mono below 150 Hz`, r.sideReMidDb < -20, `side re mid < 150 Hz: ${f1(r.sideReMidDb)} dB (was ${id === 'warm-pad' ? '−6.5' : '−14.7'})`);
    }
  }

  console.log('\n— fixes: headroom (m8), hidden drone-osc');
  {
    const parts = []; let worst = -Infinity;
    for (const { kind, id } of all) {
      const r = await T('peak16', kind, id);
      worst = Math.max(worst, r.peakDb); parts.push(`${id} ${f1(r.peakDb)}`);
    }
    const res1 = await T('peak16', 'synth', 'warm-pad', { resonance: 1 });
    worst = Math.max(worst, res1.peakDb); parts.push(`warm-pad(res 1) ${f1(res1.peakDb)}`);
    check('16 voices at velocity 1 peak ≤ −1 dBFS (every patch/preset)', worst <= -0.99, parts.join(', '));
    {
      let worstD = 0, worstPk = -Infinity; const pk = [];
      for (const { kind, id } of all) {
        const r = await T('ceilingTransparent', kind, id);
        worstD = Math.max(worstD, r.maxDiff); worstPk = Math.max(worstPk, r.peakDb); pk.push(`${id} ${f1(r.peakDb)}`);
      }
      check('output ceiling is inert at calibrated level (C-E-G vel 96, every patch/preset)', worstD < 1e-6, `max |Δ| ${worstD.toExponential(1)}; peaks ${pk.join(', ')} dBFS`);
    }
    const meta = all.find((x) => x.id === 'drone-osc');
    const hidden = await page.evaluate(() => import('/js/engine/synth.js').then((m) => m.PATCHES.find((p) => p.id === 'drone-osc').hidden === true));
    check('drone-osc is hidden: true in PATCHES', !!meta && hidden, '');
  }

  // 15. CPU (informational, loose bound)
  console.log('\n— CPU: 16 voices × 4 s offline');
  for (const [kind, id] of [['synth', 'warm-pad'], ['synth', 'strings'], ['synth', 'drone-osc'], ['synth', 'soft-keys'], ['organ', 'full']]) {
    const r = await T('perf', kind, id);
    check(`perf ${id}`, r.xRealtime > 1.5, `${f1(r.xRealtime)}× realtime (${Math.round(r.renderMs)} ms), ${r.nodes} voice nodes`);
  }

  // 16. real-time AudioContext smoke
  console.log('\n— real-time AudioContext');
  for (const [kind, id] of [['synth', 'warm-pad'], ['synth', 'soft-keys'], ['organ', 'gospel']]) {
    const r = await T('realtime', kind, id);
    check(`realtime ${id}`, r.onDb > -50 && r.offDb < -60 && r.live === 0, `on ${f1(r.onDb)} dBFS after 300 ms, ${f1(r.offDb)} dBFS after release, live voices ${r.live}`);
  }

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (e) {
  console.error(e);
  failed++;
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
