#!/usr/bin/env node
// Audits sample files for the problems found in reviews/audition-findings.md:
//   SILENT  peak < -80 dBFS (S3: dead keys)
//   DC      max|channel mean| / peak > DC_RATIO (S2: DC amplified by big trims)
//   PHASE   L/R correlation < 0 (S4: stereo image cancels when summed to mono)
// Usage: node tools/samples/audit.mjs [--json out.json] <dir|file>...
//   (default: every directory under app/samples that holds .mp3 files)
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { analyze } from './audio-stats.mjs';
import { runPool } from './fetch-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SAMPLES_ROOT = join(__dirname, '..', '..', 'app', 'samples');
export const SILENT_DB = -80;
export const DC_RATIO = 5e-4;

export function flags(s) {
  const f = [];
  if (s.peakDb < SILENT_DB) f.push('SILENT');
  if (s.dcRatio > DC_RATIO) f.push('DC');
  if (s.channels === 2 && s.corr < 0) f.push('PHASE');
  return f;
}

async function collect(p, out) {
  const st = await stat(p);
  if (st.isFile()) {
    if (/\.(mp3|wav|flac)$/i.test(p)) out.push(p);
    return;
  }
  for (const e of (await readdir(p)).sort()) await collect(join(p, e), out);
}

async function main() {
  const args = process.argv.slice(2);
  let jsonOut = null;
  const ji = args.indexOf('--json');
  if (ji >= 0) { jsonOut = args[ji + 1]; args.splice(ji, 2); }
  const targets = args.length ? args : [SAMPLES_ROOT];
  const files = [];
  for (const t of targets) await collect(t, files);
  const stats = await runPool(files.map((f) => () => analyze(f)), 4);
  const byDir = new Map();
  for (const s of stats) {
    s.flags = flags(s);
    const d = relative(SAMPLES_ROOT, dirname(s.file));
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(s);
  }
  for (const [d, list] of byDir) {
    const peak = Math.max(...list.map((s) => s.peakDb));
    const worstDc = Math.max(...list.map((s) => s.dcRatio));
    const flagged = list.filter((s) => s.flags.length);
    const corrs = list.filter((s) => s.corr !== undefined).map((s) => s.corr);
    console.log(
      `${d.padEnd(24)} n=${String(list.length).padStart(3)} setPeak=${peak.toFixed(1)} dBFS worstDC/peak=${worstDc.toExponential(1)}` +
        (corrs.length ? ` corr[min ${Math.min(...corrs).toFixed(2)} max ${Math.max(...corrs).toFixed(2)}]` : '') +
        ` flagged=${flagged.length}`,
    );
    for (const s of flagged) {
      const n = relative(SAMPLES_ROOT, s.file);
      console.log(
        `   ${s.flags.join(',').padEnd(10)} ${n} peak=${s.peakDb.toFixed(1)} dc/peak=${s.dcRatio.toExponential(1)}` +
          (s.corr !== undefined ? ` corr=${s.corr.toFixed(3)} early=${s.corrEarly.toFixed(3)} monoLoss=${s.monoLossDb.toFixed(2)}` : ''),
      );
    }
  }
  if (jsonOut) await writeFile(jsonOut, JSON.stringify(stats, null, 1));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
