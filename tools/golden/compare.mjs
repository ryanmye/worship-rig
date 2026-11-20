#!/usr/bin/env node
// Compare WAVs against the golden references with the manifest tolerances (node, no deps).
//
//   node tools/golden/compare.mjs <dir>                  every manifest fixture: <dir>/<id>.wav vs its golden
//   node tools/golden/compare.mjs <id> <test.wav>        one fixture
//   node tools/golden/compare.mjs --ref a.wav --test b.wav [--id <id>]   two files (tolerance from <id>, else exact)
//   node tools/golden/compare.mjs --self-test            goldens vs themselves (must pass) and vs perturbed copies
//                                                        (must fail)
//   options: --manifest <path> (default native/golden/manifest.json), --json (machine-readable rows)
//   Chromium pin (T17): the goldens are only valid for manifest.chromiumPin.version. compare.mjs refuses (exit 2) when
//   a golden entry is stamped with another version, or when <dir>/render-info.json (written by `render.mjs --out`)
//   names another Chromium, unless --allow-chromium-mismatch is given (the run is then labelled in the output).
//
// Exit status 0 when every compared fixture passes, 1 otherwise (2 on usage errors). A fixture whose golden WAV is
// absent (out/ not regenerated) is reported as 'missing' and does not fail the run unless --strict.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from './wav.mjs';
import { levelStats, thirdOctaveBands, compareSignals, BAND_CENTERS } from './analysis.mjs';

export { compareSignals };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLD = path.resolve(HERE, '../../native/golden');

function loadManifest(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const fmt = (x, d = 2) => (x === Infinity ? 'inf' : Number.isFinite(x) ? x.toFixed(d) : String(x));
function printTable(rows) {
  const head = ['fixture', 'class', 'max|diff|', 'band dB', 'env corr', 'lag ms', 'rms dB', 'result'];
  const body = rows.map((r) => r.missing ? [r.id, r.cls, '-', '-', '-', '-', '-', 'missing'] : [
    r.id, r.cls, r.maxAbs.toExponential(2), fmt(r.bandsDb), fmt(r.envCorr, 4), String(r.lagMs), fmt(r.rmsDb),
    r.pass ? (r.label || 'PASS') : `FAIL: ${r.fails.join('; ')}`,
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => (i === 7 ? 4 : String(b[i]).length))));
  const line = (cells) => cells.map((c, i) => (i === 7 ? c : String(c).padEnd(w[i]))).join('  ');
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
    // one-pole lowpass at the signal's spectral centroid (third-octave power weighted): a spectral change the band
    // check must see, whatever the register (a fixed 1 kHz corner left a sub bass untouched)
    const bands = thirdOctaveBands(chs, sig.sr);
    let wsum = 0;
    let fsum = 0;
    bands.forEach((db, i) => {
      const p = Math.pow(10, db / 10);
      wsum += p;
      fsum += p * Math.log(BAND_CENTERS[i]);
    });
    const fc = wsum > 0 ? Math.exp(fsum / wsum) : 1000;
    const a = Math.exp((-2 * Math.PI * fc) / sig.sr);
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
  // perturbation rows print 'detected' (not 'PASS') so the table cannot be read as "the perturbed copy passed"
  printTable(rows.map((r) => {
    const self = r.id.endsWith('(self)');
    return { ...r, pass: self ? r.pass : !r.pass, label: self ? 'PASS' : 'detected', fails: r.fails };
  }));
  console.log(ok ? `\nself-test OK: ${pick.length} goldens pass against themselves; every perturbation is detected`
    : '\nself-test FAILED');
  return ok;
}

/** Reasons the comparison would mix Chromium versions (empty = fine). */
export function checkPin(manifest, pin, argv, opt) {
  const out = [];
  const odd = manifest.fixtures.filter((e) => e.chromium && e.chromium !== pin).map((e) => e.id);
  if (odd.length) out.push(`${odd.length} golden entries ` +
    `(${odd.slice(0, 3).join(', ')}${odd.length > 3 ? ', ...' : ''}) were ` +
    `rendered by another Chromium than the pin ${pin}`);
  const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--manifest'));
  const dirs = [];
  if (pos.length === 1 && fs.existsSync(pos[0]) && fs.statSync(pos[0]).isDirectory()) dirs.push(pos[0]);
  if (opt('--test')) dirs.push(path.dirname(opt('--test')));
  if (pos.length === 2) dirs.push(path.dirname(pos[1]));
  for (const d of dirs) {
    const f = path.join(d, 'render-info.json');
    if (!fs.existsSync(f)) continue;
    const info = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (info.chromium && info.chromium !== pin) out.push(`${d} was rendered by Chromium ${info.chromium}`);
  }
  if (opt('--expect-chromium'
    ) && opt('--expect-chromium') !== pin) out.push(`--expect-chromium ${opt('--expect-chromium')} != pin`);
  return out;
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
  const pin = manifest.chromiumPin?.version || manifest.chromium;
  const mismatches = checkPin(manifest, pin, argv, opt);
  if (mismatches.length) {
    if (!argv.includes('--allow-chromium-mismatch')) {
      console.error(`REFUSED: ${mismatches.join('; ')}.\nGoldens are pinned to Chromium ${pin}; another build can ` +
        `move ` +
        'Chromium-implemented nodes (compressor, convolver, wavetables, decoder). Re-render the goldens with ' +
        '`render.mjs --allow-chromium-change` or pass --allow-chromium-mismatch to compare anyway.');
      process.exit(2);
    }
    console.error(`WARNING (--allow-chromium-mismatch): ${mismatches.join('; ')}`);
  }
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
