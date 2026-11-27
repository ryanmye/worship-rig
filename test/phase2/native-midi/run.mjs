#!/usr/bin/env node
// Lane NMA: MIDI on the 2.0 bridge engine without Web MIDI (the native Mac / iPad app's WKWebView).
//   node test/phase2/native-midi/run.mjs
// The real app on BridgeEngine over MockNative with navigator.requestMIDIAccess removed (native-midi.pw.mjs). The
// adapter's unit tests are test/unit/engine-bridge/native-midi.test.mjs (suite `unit`).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const t0 = Date.now();
const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1',
  path.join(here, 'native-midi.pw.mjs')], { cwd: repo, stdio: 'inherit', timeout: 300000 });
const ok = r.status === 0;
console.log(`=== native-midi: ${ok ? 'PASS' : `FAIL (exit ${r.status}${r.signal ? `, ${r.signal}` : ''})`} in ` +
  `${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(ok ? 0 : 1);
