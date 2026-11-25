#!/usr/bin/env node
// Lane E5: 1.x → 2.0 library migration suite. node:test files (store, the four import paths through the controller
// with main.js / RigLibrary.swift stand-ins, the 1.1 downgrade), then the Playwright file (the real 2.0 app).
//   node test/phase2/migration-1x/run.mjs [--only unit|browser]
// Fixtures: test/fixtures/library-1x (README there; regenerate with tools/gen-library-1x-fixtures.mjs).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const suites = [
  { name: 'unit', files: fs.readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(here, f)), timeout: 180000 },
  { name: 'browser', files: [path.join(here, 'browser.pw.mjs')], timeout: 300000 },
];
let failed = 0;
for (const s of suites) {
  if (only && s.name !== only) continue;
  console.log(`\n=== ${s.name} (${s.files.length} file${s.files.length === 1 ? '' : 's'})`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1', ...s.files],
    { cwd: repo, stdio: 'inherit', timeout: s.timeout });
  const ok = r.status === 0;
  if (!ok) failed += 1;
  console.log(`=== ${s.name}: ${ok ? 'PASS' : `FAIL (exit ${r.status}${r.signal ? `, ${r.signal}` : ''})`} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
console.log(failed ? `\nmigration-1x: ${failed} suite(s) failed` : '\nmigration-1x: all suites passed');
process.exit(failed ? 1 : 0);
