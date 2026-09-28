#!/usr/bin/env node
// Validates app/samples/manifest.json per SPEC.md §9 and reviews/audition-findings.md:
//   - every listed file exists, decodes, lasts > 0.2 s
//   - no silent files (peak < -60 dBFS; S3) and no DC offset (|DC|/peak > 5e-4; S2)  [skipped with --quick]
//   - every instrument has id/name/category/license/source/attribution, a finite gainTrim and release
//   - total bundled size <= 120 MB
// Prints a per-instrument size table. Stereo files with negative L/R correlation are reported as warnings
// (Salamander's spaced-pair recordings have some; see LICENSES.md / audition S4).
// Usage: node tools/samples/validate.mjs [--quick]
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { analyze } from './audio-stats.mjs';
import { runPool } from './fetch-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_ROOT = join(__dirname, '..', '..', 'app', 'samples');
const QUICK = process.argv.includes('--quick');
const MIN_PEAK_DB = -60;
const MAX_DC_RATIO = 5e-4;
const MAX_TOTAL_MB = 120;
const CATEGORIES = new Set(['piano', 'ep', 'mallet', 'guitar', 'pluck']);

function ffprobeDuration(file) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `ffprobe exit ${code}`));
      const dur = parseFloat(out.trim());
      if (!Number.isFinite(dur)) return reject(new Error(`ffprobe returned no duration for ${file}`));
      resolve(dur);
    });
    proc.on('error', reject);
  });
}

async function dirBytes(dir) {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? await dirBytes(p) : (await stat(p)).size;
  }
  return total;
}

async function main() {
  const manifest = JSON.parse(await readFile(join(SAMPLES_ROOT, 'manifest.json'), 'utf8'));
  const errors = [];
  const warnings = [];
  const table = [];
  let totalFiles = 0;
  let totalBytes = 0;
  const ids = new Set();

  for (const inst of manifest.instruments) {
    for (const k of ['id', 'name', 'category', 'license', 'source', 'attribution'])
      if (!inst[k] || typeof inst[k] !== 'string') errors.push(`${inst.id}: missing/invalid "${k}"`);
    if (ids.has(inst.id)) errors.push(`duplicate id ${inst.id}`);
    ids.add(inst.id);
    if (!CATEGORIES.has(inst.category)) errors.push(`${inst.id}: unknown category "${inst.category}"`);
    if (!Number.isFinite(inst.gainTrim)) errors.push(`${inst.id}: gainTrim not a number`);
    if (!Number.isFinite(inst.release) || inst.release <= 0) errors.push(`${inst.id}: bad release`);

    let instBytes = 0;
    let instFiles = 0;
    const jobs = [];
    for (const layer of inst.layers) {
      if (!layer.notes?.length) errors.push(`${inst.id}: empty layer ${layer.dir}`);
      for (const note of layer.notes) {
        const file = join(SAMPLES_ROOT, layer.dir, `${note}.${inst.ext}`);
        jobs.push(async () => {
          let s;
          try {
            s = await stat(file);
          } catch {
            errors.push(`MISSING: ${file}`);
            return;
          }
          instFiles++;
          instBytes += s.size;
          try {
            const dur = await ffprobeDuration(file);
            if (dur <= 0.2) errors.push(`TOO SHORT (${dur.toFixed(3)}s): ${file}`);
          } catch (err) {
            errors.push(`FFPROBE FAILED: ${file} (${err.message})`);
            return;
          }
          if (QUICK) return;
          const a = await analyze(file);
          if (!(a.peakDb >= MIN_PEAK_DB)) errors.push(`SILENT (peak ${a.peakDb.toFixed(1)} dBFS): ${file}`);
          if (a.dcRatio > MAX_DC_RATIO) errors.push(`DC OFFSET (|dc|/peak ${a.dcRatio.toExponential(1)}): ${file}`);
          if (a.peakDb > 0) errors.push(`CLIPPED (peak ${a.peakDb.toFixed(2)} dBFS): ${file}`);
          if (a.channels === 2 && a.corr < 0) warnings.push(`${inst.id}: L/R anti-correlated (${a.corr.toFixed(2)}) ${layer.dir}/${note}`);
        });
      }
    }
    await runPool(jobs, 2);
    totalFiles += instFiles;
    totalBytes += instBytes;
    table.push({ id: inst.id, files: instFiles, mb: instBytes / 1e6, license: inst.license });
  }

  console.log('Instrument           Files      MB  License');
  console.log('------------------------------------------------');
  for (const row of table)
    console.log(`${row.id.padEnd(20)} ${String(row.files).padStart(5)}  ${row.mb.toFixed(2).padStart(6)}  ${row.license}`);
  console.log('------------------------------------------------');
  console.log(`TOTAL (manifest)     ${String(totalFiles).padStart(5)}  ${(totalBytes / 1e6).toFixed(2).padStart(6)}`);
  const dirMB = (await dirBytes(SAMPLES_ROOT)) / 1e6;
  console.log(`app/samples/ on disk        ${dirMB.toFixed(2).padStart(6)} MB (limit ${MAX_TOTAL_MB})`);
  if (dirMB > MAX_TOTAL_MB) errors.push(`app/samples is ${dirMB.toFixed(1)} MB > ${MAX_TOTAL_MB} MB`);
  if (Math.abs(dirMB - totalBytes / 1e6) > 0.5) warnings.push(`app/samples holds ${(dirMB - totalBytes / 1e6).toFixed(2)} MB not listed in the manifest`);

  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log(' - ' + w);
  }
  if (errors.length) {
    console.error('\nVALIDATION FAILED:');
    for (const e of errors) console.error(' - ' + e);
    process.exit(1);
  }
  console.log(`\nAll manifest files exist and decode${QUICK ? '' : ', none silent, DC-free, unclipped'}. Validation OK.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
