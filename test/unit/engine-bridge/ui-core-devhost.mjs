#!/usr/bin/env node
// Opt-in: the ui-core Perform suite (test/phase2/ui-core/run.mjs, unchanged) against rig-devhost = the real UI on the
// NATIVE core. ui-core-devhost.preload.cjs swaps server.js's createServer for rig-devhost; everything else (Chromium,
// the page, the assertions) is the suite's own. NOT in run-all (it needs the C++ build and the native modules that
// later waves land; until then most failures say what the core does not do yet, not what the shim gets wrong).
//   node test/unit/engine-bridge/ui-core-devhost.mjs [--bin path/to/rig-devhost] [--grep <regex>] [--json]
//        [--out report.json] [--timeout-min 40] [--keep-log] [--no-adapter]
// --no-adapter: without ui-core-devhost.adapter.js (the Web Audio internals the suite reads: engine.slots, getParam,
// pedaled, ...), i.e. the raw count.
// Exit 0 when every selected test passes. The report lists each test (ok / FAIL / skip, ms, first error line) and
// the bridge's error replies and warn events (from the devhost log), grouped by op.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { devhostBinary, REPO } from './devhost-proc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);

/**
 * Parse node:test TAP: top-level `ok` / `not ok` lines (4-space indented subtests are ignored) + the first error
 * message of each failure.
 * @param {string} tap
 * @returns {{name:string, ok:boolean, skip:boolean, ms:number|null, error:string|null}[]}
 */
export function parseTap(tap) {
  const lines = tap.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(ok|not ok) \d+ - (.*?)(\s+# SKIP.*)?$/.exec(lines[i]);
    if (!m) continue;
    const r = { name: m[2], ok: m[1] === 'ok', skip: !!m[3], ms: null, error: null };
    for (let j = i + 1; j < lines.length && /^ {2}/.test(lines[j]); j++) {
      const d = /^ {2}duration_ms: ([\d.]+)/.exec(lines[j]);
      if (d) r.ms = Math.round(Number(d[1]));
      if (r.error === null) {
        const e = /^ {2}error: (.*)$/.exec(lines[j]);
        if (e) {
          let msg = e[1].replace(/^['"|>-]+\s*/, '').replace(/['"]$/, '');
          if (!msg && lines[j + 1]) msg = lines[j + 1].trim();
          r.error = msg.slice(0, 240);
        }
      }
    }
    out.push(r);
  }
  return out;
}

/** Error replies and warn events from a rig-devhost --log file, grouped. */
export function bridgeProblems(logFile) {
  const ops = new Map();
  const errors = {};
  const warns = {};
  if (!fs.existsSync(logFile)) return { errors, warns };
  const flat = (m) => (Array.isArray(m) ? m.flatMap(flat) : [m]);
  for (const l of fs.readFileSync(logFile, 'utf8').split('\n')) {
    if (!l) continue;
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    for (const m of flat(e.msg)) {
      if (!m || typeof m !== 'object') continue;
      const sub = m.action || m.what;
      if (e.dir === 'in' && m.id !== undefined) ops.set(m.id, `${m.op}${sub ? `:${sub}` : ''}`);
      else if (e.dir === 'out' && m.re !== undefined && !m.ok) {
        const k = `${ops.get(m.re) || '?'} -> ${m.error && m.error.code}: ${m.error && m.error.message}`;
        errors[k] = (errors[k] || 0) + 1;
      } else if (e.dir === 'out' && m.ev === 'warn') {
        const k = String(m.message).slice(0, 160);
        warns[k] = (warns[k] || 0) + 1;
      }
    }
  }
  return { errors, warns };
}

async function main() {
  const bin = devhostBinary(opt('--bin'));
  if (!bin) {
    console.error('rig-devhost not built: cmake -S native/devhost -B native/core/build-t09 && cmake --build ...');
    process.exit(2);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-uicore-devhost-'));
  const logFile = path.join(work, 'bridge.jsonl');
  const errFile = path.join(work, 'devhost.stderr');
  const nodeArgs = ['--require', path.join(here, 'ui-core-devhost.preload.cjs'), '--test-reporter=tap'];
  if (opt('--grep')) nodeArgs.push(`--test-name-pattern=${opt('--grep')}`);
  nodeArgs.push(path.join(REPO, 'test/phase2/ui-core/run.mjs'));
  const env = { ...process.env, RIG_DEVHOST_BIN: bin, RIG_DEVHOST_LOG: logFile, RIG_DEVHOST_STDERR: errFile,
    RIG_DEVHOST_RECORDINGS: work, ...(flag('--no-adapter') ? { RIG_UICORE_NO_ADAPTER: '1' } : {}) };
  const t0 = Date.now();
  const child = spawn(process.execPath, nodeArgs, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let tap = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    tap += d;
    for (const l of String(d).split('\n')) if (/^(ok|not ok) \d+/.test(l)) process.stderr.write(`${l.slice(0, 160)}\n`);
  });
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const limit = Number(opt('--timeout-min', 40)) * 60000;
  const killer = setTimeout(() => child.kill('SIGTERM'), limit);
  const code = await new Promise((r) => child.on('exit', (c, s) => r(c ?? s)));
  clearTimeout(killer);
  const tests = parseTap(tap);
  const devErr = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '';
  const report = {
    devhost: bin,
    exit: code,
    seconds: Math.round((Date.now() - t0) / 1000),
    counts: {
      total: tests.length,
      pass: tests.filter((t) => t.ok && !t.skip).length,
      fail: tests.filter((t) => !t.ok).length,
      skip: tests.filter((t) => t.skip).length,
    },
    tests,
    bridge: bridgeProblems(logFile),
    devhostSummary: ((devErr.match(/rig-devhost: audio: .*/g) || []).pop() || '').replace(/^rig-devhost: /, ''),
    sanitizer: devErr.match(/(ERROR: AddressSanitizer|runtime error|WARNING: ThreadSanitizer).*/g) || [],
    suiteStderr: stderr.split('\n').filter(Boolean).slice(-20),
  };
  if (flag('--keep-log')) report.log = logFile;
  else fs.rmSync(work, { recursive: true, force: true });
  if (opt('--out')) fs.writeFileSync(opt('--out'), `${JSON.stringify(report, null, 2)}\n`);
  if (flag('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    const c = report.counts;
    console.log(`ui-core against rig-devhost: ${c.pass} pass, ${c.fail} fail, ${c.skip} skip of ${c.total}`
      + ` (${report.seconds} s, exit ${code})`);
    for (const t of tests) {
      const tag = t.skip ? 'skip' : t.ok ? 'ok  ' : 'FAIL';
      console.log(`  ${tag} ${t.name.slice(0, 100)}${t.ms !== null ? ` (${t.ms} ms)` : ''}`
        + `${!t.ok && t.error ? `\n         ${t.error}` : ''}`);
    }
    console.log('bridge error replies:');
    for (const [k, n] of Object.entries(report.bridge.errors)) console.log(`  ${n} x ${k}`);
    console.log('warn events:');
    for (const [k, n] of Object.entries(report.bridge.warns)) console.log(`  ${n} x ${k}`);
    console.log(`devhost: ${report.devhostSummary}`);
    console.log(`sanitizer: ${report.sanitizer.length ? report.sanitizer.join('\n  ') : '(none)'}`);
  }
  process.exitCode = report.counts.fail === 0 && report.counts.total > 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
