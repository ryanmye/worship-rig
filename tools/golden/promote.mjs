#!/usr/bin/env node
// Mechanical exact-tier promotion pass (T17 task 3; SETUP_REVIEW 7). Run after the native Model / PRNG streams land:
//
//   node tools/golden/promote.mjs <dir of native renders>            dry run: which statistical fixtures now pass exact
//   node tools/golden/promote.mjs <dir> --apply                      rewrite manifest.json: classification -> exact
//   options: --manifest <path>, --only <substr,...>
//
// Candidates are the fixtures with `exactIfPrngPorted` (tier.exactIf names the streams to port). A candidate is
// promoted only when <dir>/<id>.wav passes the EXACT tolerance (manifest.tolerances.exact) against its golden; the old
// statistical tolerance is kept as tolerance.fallback, like every exact fixture. Fixtures with tier.blockers (not
// repeatable in Chromium itself) are never promoted: they stay statistical until a repeatable reference exists.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from './wav.mjs';
import { compareSignals } from './analysis.mjs';

const GOLD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../native/golden');
const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const dir = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--manifest' && argv[i - 1] !== '--only');
if (!dir) {
  console.error('usage: promote.mjs <native render dir> [--apply] [--only a,b] [--manifest path]');
  process.exit(2);
}
const mpath = opt('--manifest') || path.join(GOLD, 'manifest.json');
const mdir = path.dirname(mpath);
const manifest = JSON.parse(fs.readFileSync(mpath, 'utf8'));
const only = opt('--only')?.split(',');
let promoted = 0;
let tried = 0;
for (const e of manifest.fixtures) {
  if (e.classification !== 'statistical' || !e.exactIfPrngPorted
    || (only && !only.some((o) => e.id.includes(o)))) continue;
  if (e.tier?.blockers?.length) continue;
  const f = path.join(dir, `${e.id}.wav`);
  const ref = path.join(mdir, e.file);
  if (!fs.existsSync(f) || !fs.existsSync(ref)) continue;
  tried++;
  const r = compareSignals(readWav(ref), readWav(f), manifest.tolerances.exact);
  console.log(`${e.id.padEnd(30)} exact tolerance: ${r.pass ? 'PASS -> promote' : `fail (${r.fails.join('; ')})`}`);
  if (r.pass && argv.includes('--apply')) {
    e.tolerance = { ...manifest.tolerances.exact, fallback: e.tolerance };
    e.classification = 'exact';
    delete e.prngPortRecommended;
    e.tier = { class: 'exact', promotedFrom: 'statistical', maxAbsDiff: e.tolerance.maxAbsDiff,
      bandsDb: e.tolerance.bandsDb,
      envCorr: e.tolerance.envCorr };
    promoted++;
  }
}
if (argv.includes('--apply')) {
  const st = manifest.fixtures.filter((x) => x.classification === 'statistical').length;
  if (manifest.tiers) {
    manifest.tiers.statistical = st;
    manifest.tiers.exact = manifest.fixtures.length - st;
  }
  fs.writeFileSync(mpath, `${JSON.stringify(manifest, null, 1)}\n`);
}
console.log(`${tried} candidates compared, ${promoted} promoted${argv.includes('--apply') ? '' : ' (dry run)'}`);
