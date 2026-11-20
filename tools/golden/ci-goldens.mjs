#!/usr/bin/env node
// CI goldens (WAVE0B_REVIEW V11 / SETUP_REVIEW R22): regenerate the golden WAVs that ctest's `golden.*` tests compare
// against, because native/golden/out/ is git-ignored (only smoke/ and stimuli/ are committed).
//
//   node tools/golden/ci-goldens.mjs --list      print the ids ctest needs that are not committed (one per line)
//   node tools/golden/ci-goldens.mjs             render those ids into native/golden/out/ with the web engine
//                                                (`render.mjs --out`: the manifest is never touched), then check
//                                                that the browser is the manifest's pinned Chromium (exit 3 if not)
//   node tools/golden/ci-goldens.mjs --out-dir <dir>   the same into <dir> (dry run: native/golden/out untouched)
//
// The id set = every id in native/core/tests/golden_ids/*.ids (the fixtures wave tasks have made pass), minus the ones
// whose golden lives in committed smoke/. The browser: Playwright's own if installed, else GOLDEN_CHROMIUM (render.mjs
// `launch`); CI installs Chrome for Testing at the pinned version and passes it as GOLDEN_CHROMIUM. Each rendered
// WAV's sha256 is compared with the manifest: a mismatch is reported (Chromium sums inputs in hash-set order, so
// a fixture with repeatMaxAbsDiff > 0 can differ by ~1e-6 run to run), never fatal: the tolerances absorb it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const GOLD = path.join(ROOT, 'native/golden');
const IDS_DIR = path.join(ROOT, 'native/core/tests/golden_ids');

const manifest = JSON.parse(fs.readFileSync(path.join(GOLD, 'manifest.json'), 'utf8'));
const byId = new Map(manifest.fixtures.map((e) => [e.id, e]));
const wanted = [];
for (const f of fs.readdirSync(IDS_DIR).filter((n) => n.endsWith('.ids')).sort()) {
  for (const line of fs.readFileSync(path.join(IDS_DIR, f), 'utf8').split('\n')) {
    const id = line.replace(/#.*/, '').trim();
    if (!id) continue;
    if (!byId.has(id)) {
      console.error(`${f}: '${id}' is not a manifest fixture`);
      process.exit(2);
    }
    if (!wanted.includes(id)) wanted.push(id);
  }
}
const needed = wanted.filter((id) => !byId.get(id).file.startsWith('smoke/'));

if (process.argv.includes('--list')) {
  console.log(needed.join('\n'));
  process.exit(0);
}

const oi = process.argv.indexOf('--out-dir');
const out = oi > 0 ? path.resolve(process.argv[oi + 1]) : path.join(GOLD, 'out');
// render.mjs --only matches substrings; the extra fixtures it may pick up (glue-100 -> glue-100-bursts) are goldens too
const r = spawnSync(process.execPath, [path.join(HERE, 'render.mjs'), '--out', out, '--only', needed.join(',')],
  { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
const info = JSON.parse(fs.readFileSync(path.join(out, 'render-info.json'), 'utf8'));
const pin = manifest.chromiumPin?.version || manifest.chromium;
if (info.chromium !== pin) {
  console.error(`REFUSED: rendered with Chromium ${info.chromium}, the goldens are pinned to ${pin}`);
  process.exit(3);
}
fs.rmSync(path.join(out, 'render-info.json'));
let same = 0;
const differ = [];
for (const id of needed) {
  const e = byId.get(id);
  const buf = fs.readFileSync(path.join(out, `${id}.wav`));
  if (crypto.createHash('sha256').update(buf).digest('hex') === e.sha256) same++;
  else differ.push(`${id} (repeat max|diff| ${e.repeatMaxAbsDiff})`);
}
console.log(`ci-goldens: ${needed.length} goldens rendered with Chromium ${pin}; sha256 = manifest for ${same}` +
  (differ.length ? `; differs (within Chromium's own repeat noise?) for ${differ.join(', ')}` : ''));
