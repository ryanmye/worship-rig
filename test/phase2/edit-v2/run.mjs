#!/usr/bin/env node
// edit-v2 suite (H-v2 Edit, views/edit/CONTRACT.md §7): runs shell.test.mjs, every panels/*.test.mjs and any
// integration*.test.mjs, one process at a time (each file boots its own server on a free port and one Chromium).
//   node test/phase2/edit-v2/run.mjs                 all files
//   node test/phase2/edit-v2/run.mjs --only slot,drone   panels/slot.test.mjs + panels/drone.test.mjs ('shell',
//                                                        'integration' also work as names)
//   node test/phase2/edit-v2/run.mjs --list
// Exit code 0 only when every file passed. Screenshots → test/phase2/edit-v2/screenshots/.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const ONLY = new Set((opt('--only') || '').split(',').map((s) => s.trim()).filter(Boolean));
// Budgets (views/edit/CONTRACT.md §7). Under `node --test`, --test-timeout also bounds the FILE: node:test runs each
// file as one test, so the old 240 s "per test" value killed whole files with 4–6 mounts on a loaded box
// (hv2-edit-song / -drone / -effects / -slot reports). Without --test the flag has no effect at all (checked on node
// 22.22). So it is now the per-file budget, 900 s; single tests are bounded by the harness's page waits (goto 30 s,
// controller start 45 s, song load 60 s, t.until 15 s by default). The outer kill below is a backstop for a process
// that ignores its own timeout (a hung Chromium): the budget + 60 s.
const FILE_BUDGET_MS = Number(process.env.EDITV2_FILE_BUDGET_MS || process.env.EDITV2_TEST_TIMEOUT_MS || 900 * 1000);
const TIMEOUT_MS = Number(process.env.EDITV2_TIMEOUT_MS || FILE_BUDGET_MS + 60 * 1000); // outer kill, per file

const nameOf = (f) => path.basename(f).replace(/\.test\.mjs$/, '');
const files = [
  ...(fs.existsSync(path.join(HERE, 'shell.test.mjs')) ? [path.join(HERE, 'shell.test.mjs')] : []),
  ...fs.readdirSync(path.join(HERE, 'panels')).filter((f) => f.endsWith('.test.mjs')).sort()
    .map((f) => path.join(HERE, 'panels', f)),
  ...fs.readdirSync(HERE).filter((f) => /^integration.*\.test\.mjs$/.test(f)).sort().map((f) => path.join(HERE, f)),
].filter((f) => !ONLY.size || ONLY.has(nameOf(f)) || (ONLY.has('integration') && nameOf(f).startsWith('integration')));

if (argv.includes('--list')) {
  for (const f of files) console.log(`${nameOf(f).padEnd(14)} ${path.relative(process.cwd(), f)}`);
  process.exit(0);
}
if (!files.length) {
  console.error(`no test files match --only ${[...ONLY].join(',')}`);
  process.exit(2);
}

/** Run one test file; resolves {name, code, ms}. */
function runFile(file) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const args = ['--test', '--test-reporter=spec', `--test-timeout=${FILE_BUDGET_MS}`, file];
    // own process group, so a timeout also kills the file's Chromium (no orphaned renderers holding ~1 GB)
    const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env, detached: true });
    const timer = setTimeout(() => {
      console.error(`\n[edit-v2] ${nameOf(file)} timed out after ${TIMEOUT_MS / 1000} s`);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ name: nameOf(file), code: code ?? (signal ? 1 : 0), ms: Date.now() - t0 });
    });
  });
}

const results = [];
for (const f of files) {
  console.log(`\n=== edit-v2 · ${nameOf(f)} (${path.relative(process.cwd(), f)})`);
  results.push(await runFile(f));
}
console.log('\nedit-v2 summary');
for (const r of results) console.log(`  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.name.padEnd(14)} ${(r.ms / 1000).toFixed(1)} s`);
const failed = results.filter((r) => r.code !== 0);
console.log(`edit-v2: ${results.length - failed.length}/${results.length} files passed`);
process.exit(failed.length ? 1 : 0);
