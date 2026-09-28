#!/usr/bin/env node
// Shell phase-1 test runner: node:test units → Playwright (Chromium) → Electron boot.
//   node test/phase1/shell/run.mjs [--only unit|browser|electron] [--skip browser,electron]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const skip = new Set((argv.includes('--skip') ? argv[argv.indexOf('--skip') + 1] : process.env.RIG_SKIP || '').split(',').filter(Boolean));

const units = fs.readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(here, f));
const suites = [
  { name: 'unit', files: units, timeout: 120000 },
  { name: 'browser', files: [path.join(here, 'browser.pw.mjs')], timeout: 300000 },
  { name: 'electron', files: [path.join(here, 'electron.boot.mjs')], timeout: 300000 },
];

let failed = 0;
for (const s of suites) {
  if ((only && s.name !== only) || skip.has(s.name)) {
    console.log(`\n=== ${s.name}: skipped`);
    continue;
  }
  console.log(`\n=== ${s.name} (${s.files.length} file${s.files.length === 1 ? '' : 's'})`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1', ...s.files], { cwd: repo, stdio: 'inherit', timeout: s.timeout });
  const ok = r.status === 0;
  if (!ok) failed += 1;
  console.log(`=== ${s.name}: ${ok ? 'PASS' : `FAIL (exit ${r.status}${r.signal ? `, ${r.signal}` : ''})`} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
console.log(failed ? `\nshell phase-1: ${failed} suite(s) failed` : '\nshell phase-1: all suites passed');
process.exit(failed ? 1 : 0);
