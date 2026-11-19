#!/usr/bin/env node
// Compare WAVs against the golden references with the manifest tolerances (node, no deps).
//
//   node tools/golden/compare.mjs <dir>                  every manifest fixture: <dir>/<id>.wav vs its golden
//   node tools/golden/compare.mjs <id> <test.wav>        one fixture
//   node tools/golden/compare.mjs --ref a.wav --test b.wav [--id <id>]   two files (tolerance from <id>, else exact)
//   node tools/golden/compare.mjs --self-test            goldens vs themselves (must pass) and vs perturbed copies
//                                                        (must fail)
//   options: --manifest <path> (default native/golden/manifest.json), --json (machine-readable rows)
//
// Exit status 0 when every compared fixture passes, 1 otherwise (2 on usage errors). A fixture whose golden WAV is
// absent (out/ not regenerated) is reported as 'missing' and does not fail the run unless --strict.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from './wav.mjs';
import { levelStats, thirdOctaveBands, envelopeDb, envCorrelation, maxAbsDiff, bandDiff } from './analysis.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLD = path.resolve(HERE, '../../native/golden');

/**
 * Compare a test signal against a reference under a tolerance.
 * @param {{sr:number, chs:Float32Array[]}} ref
 * @param {{sr:number, chs:Float32Array[]}} test
 * @param {object} tol manifest tolerance ({maxAbsDiff?, bandsDb, bandRangeDb, envCorr, rmsDb})
 * @returns {{pass:boolean, fails:string[], maxAbs:number, bandsDb:number, worstHz:number|null, envCorr:number,
 *   rmsDb:number, lengthDiff:number}}
 */
export function compareSignals(ref, test, tol) {
  const fails = [];
  if (ref.sr !== test.sr) fails.push(`sample rate ${test.sr} ≠ ${ref.sr}`);
  if (ref.chs.length !== test.chs.length) fails.push(`channels ${test.chs.length} ≠ ${ref.chs.length}`);
  const d = maxAbsDiff(ref.chs, test.chs);
  if (d.lengthDiff > 0) fails.push(`length differs by ${d.lengthDiff} frames`);
  const lr = levelStats(ref.chs);
  const lt = levelStats(test.chs);
  const silentR = lr.rms < 1e-7;
  const silentT = lt.rms < 1e-7;
  const rmsDb = silentR && silentT ? 0 : silentR || silentT ? Infinity : Math.abs(lr.rmsDb - lt.rmsDb);
  const bd = silentR && silentT ? { worstDb: 0, worstHz: null }
    : bandDiff(thirdOctaveBands(ref.chs, ref.sr), thirdOctaveBands(test.chs, test.sr), tol.bandRangeDb ?? 60);
  const ec = envCorrelation(envelopeDb(ref.chs, ref.sr), envelopeDb(test.chs, test.sr));
  if (tol.maxAbsDiff !== undefined && !(d.maxAbs <= tol.maxAbsDiff)) {
    fails.push(`max|diff| ${d.maxAbs.toExponential(2)} > ${tol.maxAbsDiff}`);
  }
  if (!(bd.worstDb <= tol.bandsDb)) {
    fails.push(`band ${bd.worstHz?.toFixed(0)} Hz off ${bd.worstDb.toFixed(2)} dB > ${tol.bandsDb}`);
  }
  if (!(ec >= tol.envCorr)) fails.push(`envelope corr ${ec.toFixed(4)} < ${tol.envCorr}`);
  if (!(rmsDb <= tol.rmsDb)) fails.push(`rms off ${rmsDb.toFixed(2)} dB > ${tol.rmsDb}`);
  return {
    pass: fails.length === 0, fails, maxAbs: d.maxAbs, bandsDb: bd.worstDb, worstHz: bd.worstHz, envCorr: ec, rmsDb,
    lengthDiff: d.lengthDiff,
  };
}

function loadManifest(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const fmt = (x, d = 2) => (x === Infinity ? 'inf' : Number.isFinite(x) ? x.toFixed(d) : String(x));
function printTable(rows) {
  const head = ['fixture', 'class', 'max|diff|', 'band dB', 'env corr', 'rms dB', 'result'];
  const body = rows.map((r) => r.missing ? [r.id, r.cls, '-', '-', '-', '-', 'missing'] : [
    r.id, r.cls, r.maxAbs.toExponential(2), fmt(r.bandsDb), fmt(r.envCorr, 4), fmt(r.rmsDb),
    r.pass ? 'PASS' : `FAIL: ${r.fails.join('; ')}`,
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => (i === 6 ? 4 : String(b[i]).length))));
  const line = (cells) => cells.map((c, i) => (i === 6 ? c : String(c).padEnd(w[i]))).join('  ');
  console.log(line(head));
  console.log(line(w.map((n) => '-'.repeat(n))));
  for (const b of body) console.log(line(b));
}

function compareFixture(entry, testFile, manifestDir) {
  const refFile = path.join(manifestDir, entry.file);
  if (!fs.existsSync(refFile) || !fs.existsSync(testFile)) {
    return { id: entry.id, cls: entry.classification, missing: true };
  }
  const r = compareSignals(readWav(refFile), readWav(testFile), entry.tolerance);
  return { id: entry.id, cls: entry.classification, ...r };
}

/** Deterministic perturbations for the self-test (each must fail its fixture's tolerance). */
function perturb(sig, how) {
  const chs = sig.chs.map((c) => Float32Array.from(c));
  const n = chs[0].length;
  const lv = levelStats(chs);
  if (how === 'gain+1dB') for (const c of chs) for (let i = 0; i < n; i++) c[i] *= Math.pow(10, 1.5 / 20);
  if (how === 'click') {
    // one 0.01 FS sample error at the loudest frame: inaudible, but far beyond an exact fixture's max|diff|
    let k = 0;
    for (let i = 0; i < n; i++) if (Math.abs(chs[0][i]) > Math.abs(chs[0][k])) k = i;
    chs[0][k] += 0.01 * Math.max(lv.peak, 0.1);
  }
  if (how === 'lowpass') {
    // one-pole lowpass at ~1 kHz: a spectral change the band check must see
    const a = Math.exp((-2 * Math.PI * 1000) / sig.sr);
    for (const c of chs) {
      let y = 0;
      for (let i = 0; i < n; i++) c[i] = y = (1 - a) * c[i] + a * y;
    }
  }
  if (how === 'late50ms') {
    const s = Math.round(0.05 * sig.sr);
    for (const c of chs) {
      c.copyWithin(s, 0, n - s);
      c.fill(0, 0, s);
    }
  }
  return { sr: sig.sr, chs };
}

function selfTest(manifest, manifestDir) {
  let ok = true;
  const rows = [];
  const avail = manifest.fixtures.filter((e) => fs.existsSync(path.join(manifestDir, e.file)) && e.peak > 1e-4);
  // a few of each class (smoke first: always present)
  const pick = [...avail.filter((e) => e.classification === 'exact').slice(0, 4),
    ...avail.filter((e) => e.classification === 'statistical').slice(0, 4)];
  for (const e of pick) {
    const ref = readWav(path.join(manifestDir, e.file));
    const same = compareSignals(ref, ref, e.tolerance);
    rows.push({ id: `${e.id} (self)`, cls: e.classification, ...same });
    if (!same.pass) ok = false;
    const hows = e.classification === 'exact' ? ['click', 'gain+1dB', 'lowpass'] : ['gain+1dB', 'lowpass', 'late50ms'];
    for (const how of hows) {
      const r = compareSignals(ref, perturb(ref, how), e.tolerance);
      rows.push({ id: `${e.id} (${how})`, cls: e.classification, ...r, pass: r.pass,
        fails: r.pass ? ['PERTURBATION NOT DETECTED'] : r.fails });
      if (r.pass) ok = false;
    }
  }
  printTable(rows.map((r) => ({ ...r, pass: r.id.endsWith('(self)') ? r.pass : !r.pass, fails: r.fails })));
  console.log(ok ? `\nself-test OK: ${pick.length} goldens pass against themselves; every perturbation is detected`
    : '\nself-test FAILED');
  return ok;
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const manifestPath = opt('--manifest') || path.join(GOLD, 'manifest.json');
  const manifestDir = path.dirname(manifestPath);
  const manifest = loadManifest(manifestPath);
  const byId = new Map(manifest.fixtures.map((e) => [e.id, e]));
  const json = argv.includes('--json');
  const strict = argv.includes('--strict');
  if (argv.includes('--self-test')) process.exit(selfTest(manifest, manifestDir) ? 0 : 1);
  let rows;
  if (opt('--ref') && opt('--test')) {
    const e = opt('--id') ? byId.get(opt('--id')) : null;
    const tol = e ? e.tolerance : manifest.tolerances.exact;
    rows = [{ id: e?.id || path.basename(opt('--test')), cls: e?.classification || 'exact',
      ...compareSignals(readWav(opt('--ref')), readWav(opt('--test')), tol) }];
  } else {
    const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--manifest'));
    if (pos.length === 2 && byId.has(pos[0])) rows = [compareFixture(byId.get(pos[0]), pos[1], manifestDir)];
    else if (pos.length === 1 && fs.existsSync(pos[0]) && fs.statSync(pos[0]).isDirectory()) {
      rows = manifest.fixtures.map((e) => compareFixture(e, path.join(pos[0], `${e.id}.wav`), manifestDir));
    } else {
      console.error('usage: compare.mjs <dir> | <id> <test.wav> | --ref a.wav --test b.wav [--id id] | --self-test');
      process.exit(2);
    }
  }
  if (json) console.log(JSON.stringify(rows, null, 1));
  else printTable(rows);
  const failed = rows.filter((r) => (r.missing ? strict : !r.pass));
  if (!json) {
    console.log(`\n${rows.length - failed.length}/${rows.length} pass` +
      (rows.some((r) => r.missing) ? ` (${rows.filter((r) => r.missing).length} missing)` : ''));
  }
  process.exit(failed.length ? 1 : 0);
}

main();
