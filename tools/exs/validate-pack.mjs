// Validates an imported "My Samples" pack (<out>/<id>/manifest.json) with the same checks tools/samples/validate.mjs
// applies to the bundled library (reviews/audition-findings.md S2/S3):
//   - manifest shape: { instruments:[…] } whose entries use app/samples/manifest.json's keys (license/source/
//     attribution strings, finite gainTrim and release, layers with [lo,hi] vel ranges tiling 0..127, flat note names)
//   - every listed file exists, ffprobe decodes it and it lasts > 0.2 s
//   - not silent (peak ≥ −60 dBFS), no DC offset (|dc|/peak ≤ 5e-4), not clipped (peak ≤ 0 dBFS)
//   - total size ≤ maxMb
// Needs ffmpeg + ffprobe on PATH. Used by `node tools/import-garageband.mjs --validate <pack dir>`.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyze } from '../samples/audio-stats.mjs';
import { pool } from './convert.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIN_PEAK_DB = -60;
export const MAX_DC_RATIO = 5e-4;
const NOTE_RE = /^(C|Db|D|Eb|E|F|Gb|G|Ab|A|Bb|B)-?\d$/;
const REQUIRED = ['id', 'name', 'category', 'ext', 'layers', 'release', 'gainTrim', 'license', 'source', 'attribution'];
const OPTIONAL = ['group', 'widthDefault', 'maxMonoLossDb'];

/** Keys the bundled manifest uses (so a schema change there is caught here too). */
export function bundledKeys() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(here, '../../app/samples/manifest.json'), 'utf8'));
    const keys = new Set();
    for (const i of m.instruments) for (const k of Object.keys(i)) keys.add(k);
    return keys;
  } catch {
    return new Set([...REQUIRED, ...OPTIONAL]);
  }
}

function ffprobeDuration(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=sample_rate,channels,codec_name', '-of', 'json', file]);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `ffprobe exit ${code}`));
      try {
        const j = JSON.parse(out);
        const s = j.streams?.[0] || {};
        resolve({ duration: parseFloat(j.format?.duration), sampleRate: Number(s.sample_rate), channels: s.channels, codec: s.codec_name });
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Pure manifest checks. @returns {string[]} errors */
export function checkManifest(m, keys = bundledKeys()) {
  const errors = [];
  if (!m || !Array.isArray(m.instruments)) return ['manifest has no "instruments" array'];
  const extra = Object.keys(m).filter((k) => k !== 'instruments');
  if (extra.length) errors.push(`manifest has top-level keys the bundled one does not: ${extra.join(', ')}`);
  for (const inst of m.instruments) {
    const id = inst.id || '?';
    for (const k of REQUIRED) if (!(k in inst)) errors.push(`${id}: missing "${k}"`);
    for (const k of Object.keys(inst)) if (!keys.has(k) && !OPTIONAL.includes(k)) errors.push(`${id}: key "${k}" is not in app/samples/manifest.json's schema`);
    for (const k of ['id', 'name', 'category', 'ext', 'license', 'source', 'attribution']) if (k in inst && (typeof inst[k] !== 'string' || !inst[k])) errors.push(`${id}: "${k}" must be a non-empty string`);
    if (!Number.isFinite(inst.gainTrim)) errors.push(`${id}: gainTrim not a number`);
    if (!Number.isFinite(inst.release) || inst.release <= 0) errors.push(`${id}: bad release`);
    if (!Array.isArray(inst.layers) || !inst.layers.length) {
      errors.push(`${id}: no layers`);
      continue;
    }
    let expect = 0;
    for (const L of inst.layers) {
      if (!Array.isArray(L.vel) || L.vel.length !== 2 || !(L.vel[0] <= L.vel[1])) errors.push(`${id}: bad vel ${JSON.stringify(L.vel)}`);
      else {
        if (L.vel[0] !== expect) errors.push(`${id}: velocity layers do not tile 0..127 (expected ${expect}, got ${L.vel[0]})`);
        expect = L.vel[1] + 1;
      }
      if (typeof L.dir !== 'string' || !L.dir || L.dir.includes('..') || path.isAbsolute(L.dir)) errors.push(`${id}: bad layer dir ${JSON.stringify(L.dir)}`);
      if (!Array.isArray(L.notes) || !L.notes.length) errors.push(`${id}: empty layer ${L.dir}`);
      for (const n of L.notes || []) if (!NOTE_RE.test(n)) errors.push(`${id}: note "${n}" is not a flat note name`);
    }
    if (expect !== 128) errors.push(`${id}: velocity layers end at ${expect - 1}, not 127`);
  }
  return errors;
}

/**
 * @param {string} dir pack folder containing manifest.json
 * @returns {Promise<{ dir, errors:string[], warnings:string[], rows:object[], totalBytes:number, totalSec:number }>}
 */
export async function validatePack(dir, { maxMb = 120, jobs = 4, quick = false } = {}) {
  const errors = [];
  const warnings = [];
  let m;
  try {
    m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  } catch (e) {
    return { dir, errors: [`cannot read manifest.json: ${e.message}`], warnings, rows: [], totalBytes: 0, totalSec: 0 };
  }
  errors.push(...checkManifest(m));
  const rows = [];
  let totalBytes = 0;
  let totalSec = 0;
  for (const inst of m.instruments || []) {
    for (const L of inst.layers || []) {
      const row = { id: inst.id, layer: L.dir, vel: L.vel, notes: (L.notes || []).length, bytes: 0, sec: 0, minPeakDb: Infinity, maxPeakDb: -Infinity, maxDc: 0, rates: new Set() };
      rows.push(row);
      await pool(L.notes || [], jobs, async (note) => {
        const file = path.join(dir, L.dir, `${note}.${inst.ext}`);
        let size;
        try {
          size = fs.statSync(file).size;
        } catch {
          errors.push(`MISSING: ${file}`);
          return;
        }
        row.bytes += size;
        let info;
        try {
          info = await ffprobeDuration(file);
        } catch (e) {
          errors.push(`FFPROBE FAILED: ${file} (${e.message})`);
          return;
        }
        if (!(info.duration > 0.2)) errors.push(`TOO SHORT (${info.duration}s): ${file}`);
        row.sec += info.duration || 0;
        row.rates.add(`${info.codec} ${info.sampleRate} Hz ${info.channels}ch`);
        if (quick) return;
        const a = await analyze(file);
        row.minPeakDb = Math.min(row.minPeakDb, a.peakDb);
        row.maxPeakDb = Math.max(row.maxPeakDb, a.peakDb);
        row.maxDc = Math.max(row.maxDc, a.dcRatio);
        if (!(a.peakDb >= MIN_PEAK_DB)) errors.push(`SILENT (peak ${a.peakDb.toFixed(1)} dBFS): ${file}`);
        if (a.dcRatio > MAX_DC_RATIO) errors.push(`DC OFFSET (|dc|/peak ${a.dcRatio.toExponential(1)}): ${file}`);
        if (a.peakDb > 0) errors.push(`CLIPPED (peak ${a.peakDb.toFixed(2)} dBFS): ${file}`);
        if (a.channels === 2 && a.corr < 0) warnings.push(`${inst.id}: L/R anti-correlated (${a.corr.toFixed(2)}) ${L.dir}/${note}`);
      });
      totalBytes += row.bytes;
      totalSec += row.sec;
    }
  }
  if (maxMb && totalBytes > maxMb * 1048576) errors.push(`pack is ${(totalBytes / 1048576).toFixed(1)} MB > ${maxMb} MB`);
  return { dir, errors, warnings, rows, totalBytes, totalSec, instruments: (m.instruments || []).map((i) => ({ id: i.id, name: i.name, ext: i.ext, layers: i.layers.length })) };
}

export function printReport(rep, log = console.log, err = console.error) {
  log(`Pack ${rep.dir}`);
  log(`  ${'layer'.padEnd(12)} ${'vel'.padEnd(9)} ${'notes'.padStart(5)} ${'MB'.padStart(7)} ${'audio s'.padStart(8)}  ${'peak dBFS'.padEnd(13)} ${'max|dc|/pk'.padStart(10)}  format`);
  for (const r of rep.rows) {
    const pk = Number.isFinite(r.minPeakDb) ? `${r.minPeakDb.toFixed(1)}..${r.maxPeakDb.toFixed(1)}` : '-';
    log(`  ${r.layer.padEnd(12)} ${`${r.vel[0]}-${r.vel[1]}`.padEnd(9)} ${String(r.notes).padStart(5)} ${(r.bytes / 1048576).toFixed(2).padStart(7)} ${r.sec.toFixed(0).padStart(8)}  ${pk.padEnd(13)} ${r.maxDc.toExponential(1).padStart(10)}  ${[...r.rates].join(', ')}`);
  }
  log(`  ${'TOTAL'.padEnd(22)} ${String(rep.rows.reduce((n, r) => n + r.notes, 0)).padStart(5)} ${(rep.totalBytes / 1048576).toFixed(2).padStart(7)} ${rep.totalSec.toFixed(0).padStart(8)}`);
  if (rep.warnings.length) {
    log(`  ${rep.warnings.length} warning(s):`);
    for (const w of rep.warnings.slice(0, 20)) log(`   - ${w}`);
  }
  if (rep.errors.length) {
    err(`  VALIDATION FAILED (${rep.errors.length}):`);
    for (const e of rep.errors.slice(0, 40)) err(`   - ${e}`);
  } else log('  OK: manifest matches the bundled schema; every file exists, decodes, is not silent, DC-free and unclipped.');
}
