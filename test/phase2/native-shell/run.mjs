#!/usr/bin/env node
// Lane N0: the real app with the native shell's window.rig (app/js/native-shell, injected as RigShellScripts does)
// over the bridge engine and MockNative, plus Chrome's unchanged copy.
//   node test/phase2/native-shell/run.mjs
// The polyfill's unit tests are test/unit/native-shell (suite `unit`); the controller's are
// test/phase1/shell/native-shell.test.mjs (suite `shell-unit`).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const t0 = Date.now();
const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1',
  path.join(here, 'native-shell.pw.mjs')], { cwd: repo, stdio: 'inherit', timeout: 420000 });
const ok = r.status === 0;
console.log(`=== native-shell: ${ok ? 'PASS' : `FAIL (exit ${r.status}${r.signal ? `, ${r.signal}` : ''})`} in ` +
  `${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(ok ? 0 : 1);
