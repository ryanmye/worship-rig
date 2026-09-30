#!/usr/bin/env node
// Worship Rig — every test suite, sequentially, with per-suite timing, logs and a summary table.
//   node test/run-all.mjs [--fast] [--only a,b] [--skip a,b] [--soak-minutes N] [--quiet] [--list]
//
//   --fast            skip the soak and everything that launches Electron (shell's Electron boot, electron-full,
//                     build-lint)
//   --only / --skip   comma-separated suite names or groups (unit, phase1, phase2, integration, electron);
//                     a suite named explicitly in --only runs even if --fast/--skip would drop it
//   --soak-minutes N  length of the soak's random phase (default 20)
//   --quiet           don't stream suite output (it still goes to test/logs/<suite>.log)
//   --list            print the suites and exit
// Exit code: 0 only if every suite that ran passed. Each suite's stdout+stderr → test/logs/<suite>.log;
// the summary table → test/logs/summary.txt.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const logs = path.join(here, 'logs');
const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const listOpt = (name) => new Set((opt(name) || '').split(',').map((s) => s.trim()).filter(Boolean));
const FAST = argv.includes('--fast');
const QUIET = argv.includes('--quiet');
const ONLY = listOpt('--only');
const SKIP = listOpt('--skip');
const SOAK_MIN = Number(opt('--soak-minutes') || process.env.SOAK_MINUTES || 20);
const node = process.execPath;
const MIN = 60000;

/** First existing path among candidates (relative to repo), or null. */
const firstExisting = (...c) => c.find((p) => fs.existsSync(path.join(repo, p))) || null;
const synthExtra = firstExisting('test/phase1/synth-extra/run.mjs', 'test/phase1/instruments/synth-extra.mjs', 'test/phase1/instruments/run-synth-extra.mjs', 'test/phase1/engine/synth-extra.mjs');

// name, groups, command, timeout. `electron`/`soak` groups are what --fast drops.
const SUITES = [
  { name: 'unit', groups: ['unit'], cmd: [node, '--test', '--test-reporter=spec', 'test/unit/**/*.test.mjs'], timeout: 3 * MIN },
  { name: 'engine', groups: ['phase1'], cmd: [node, 'test/phase1/engine/run.mjs'], timeout: 20 * MIN },
  { name: 'instruments', groups: ['phase1'], cmd: [node, 'test/phase1/instruments/run.mjs'], timeout: 15 * MIN },
  { name: 'synth-extra', groups: ['phase1'], cmd: synthExtra ? [node, synthExtra] : null, timeout: 15 * MIN, absent: 'no synth-extra runner yet' },
  { name: 'shell', groups: ['phase1'], cmd: [node, 'test/phase1/shell/run.mjs', ...(FAST ? ['--skip', 'electron'] : [])], timeout: 12 * MIN },
  { name: 'ui-core', groups: ['phase2'], cmd: [node, 'test/phase2/ui-core/run.mjs'], timeout: 12 * MIN },
  // H-v2 Edit (views/edit/**): shell + one file per panel + integration, one process per file (each file has a
  // 900 s budget, CONTRACT §7), so the suite's own limit is well above the sum of typical files (~4–6 min idle).
  { name: 'edit-v2', groups: ['phase2'], cmd: [node, 'test/phase2/edit-v2/run.mjs'], timeout: 30 * MIN },
  { name: 'settings', groups: ['phase2'], cmd: [node, 'test/phase2/settings/run.mjs'], timeout: 10 * MIN },
  { name: 'eq', groups: ['phase2'], cmd: [node, 'test/phase2/eq/run.mjs'], timeout: 10 * MIN },
  // menu-bar popover (app/mini.html) + the real app, two pages over BroadcastChannel (C7 menubar-B)
  { name: 'mini', groups: ['phase2'], cmd: [node, 'test/phase2/mini/run.mjs'], timeout: 10 * MIN },
  // themes-setup: every registered theme boots flash-free, switches at runtime, picker/Quick, selector coverage
  // (writes test/phase2/themes/coverage-<id>.json for the theme agents)
  { name: 'themes', groups: ['phase2'], cmd: [node, 'test/phase2/themes/run.mjs'], timeout: 25 * MIN },
  { name: 'chrome-fallback', groups: ['integration'], cmd: [node, 'test/integration/smoke-chrome-fallback.mjs'], timeout: 5 * MIN },
  { name: 'electron-full', groups: ['integration', 'electron'], cmd: [node, 'test/integration/electron-full.mjs'], timeout: 8 * MIN },
  { name: 'build-lint', groups: ['integration', 'electron'], cmd: [node, 'test/integration/build-lint.mjs'], timeout: 15 * MIN },
  { name: 'soak', groups: ['integration', 'soak'], cmd: [node, 'test/integration/soak.mjs', '--minutes', String(SOAK_MIN)], timeout: (SOAK_MIN + 8) * MIN },
];

const known = new Set(SUITES.flatMap((s) => [s.name, ...s.groups]));
for (const n of [...ONLY, ...SKIP]) if (!known.has(n)) {
  console.error(`unknown suite or group "${n}". Known: ${[...known].join(', ')}`);
  process.exit(2);
}

if (argv.includes('--list')) {
  for (const s of SUITES) console.log(`${s.name.padEnd(16)} [${s.groups.join(', ')}]  ${s.cmd ? s.cmd.slice(1).join(' ') : `(${s.absent})`}`);
  process.exit(0);
}

const matches = (s, set) => set.has(s.name) || s.groups.some((g) => set.has(g));
function decide(s) {
  if (ONLY.size && !matches(s, ONLY)) return 'not selected';
  const explicit = ONLY.has(s.name);
  if (!explicit && matches(s, SKIP)) return '--skip';
  if (!explicit && FAST && (s.groups.includes('electron') || s.groups.includes('soak'))) return '--fast';
  if (!s.cmd) return s.absent;
  return null;
}

/** One-line detail from a suite's output. */
function detail(text) {
  const pass = [...text.matchAll(/^(?:#|ℹ) pass (\d+)$/gm)].reduce((a, m) => a + Number(m[1]), 0);
  const fail = [...text.matchAll(/^(?:#|ℹ) fail (\d+)$/gm)].reduce((a, m) => a + Number(m[1]), 0);
  const skipped = [...text.matchAll(/^(?:#|ℹ) skipped (\d+)$/gm)].reduce((a, m) => a + Number(m[1]), 0);
  const tap = /^(?:#|ℹ) pass \d+$/m.test(text) ? `${pass} pass, ${fail} fail${skipped ? `, ${skipped} skip` : ''}` : '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const summary = [...lines].reverse().find((l) => /^\S.*(\d+\s*\/\s*\d+ passed|passed,|\d+ passed|all suites passed|suite\(s\) failed)/i.test(l) && !/^(PASS|FAIL|ok|not ok)\b/.test(l));
  return [tap, summary && summary !== tap ? summary.replace(/^[^:]*phase-1: /, '') : ''].filter(Boolean).join('; ').slice(0, 90);
}

function runSuite(s) {
  return new Promise((resolve) => {
    const logFile = path.join(logs, `${s.name}.log`);
    const log = fs.createWriteStream(logFile);
    const t0 = Date.now();
    log.write(`$ ${s.cmd.map((a) => (a === node ? 'node' : a)).join(' ')}\n# started ${new Date().toISOString()}\n\n`);
    const child = spawn(s.cmd[0], s.cmd.slice(1), { cwd: repo, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let text = '';
    const onData = (d) => {
      const str = d.toString();
      text += str;
      if (text.length > 4e6) text = text.slice(-2e6);
      log.write(str);
      if (!QUIET) process.stdout.write(str);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let timedOut = false;
    const kill = (sig) => {
      try {
        process.kill(-child.pid, sig); // whole process group: browsers, xvfb, electron
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* gone */
        }
      }
    };
    killCurrent = kill;
    const timer = setTimeout(() => {
      timedOut = true;
      onData(`\n### run-all: TIMEOUT after ${s.timeout / 1000} s — killing\n`);
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 5000);
    }, s.timeout);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      killCurrent = null;
      const sec = (Date.now() - t0) / 1000;
      log.end(`\n# exit ${code}${signal ? ` (${signal})` : ''} after ${sec.toFixed(1)} s\n`);
      resolve({ status: timedOut ? 'TIMEOUT' : code === 0 ? 'PASS' : 'FAIL', code, signal, sec, detail: timedOut ? `killed after ${s.timeout / 1000} s` : detail(text), log: path.relative(repo, logFile) });
    });
  });
}

fs.mkdirSync(logs, { recursive: true });
fs.writeFileSync(path.join(logs, '.gitignore'), '*\n');
const results = [];
const tAll = Date.now();
let interrupted = false;
let killCurrent = null;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (interrupted) process.exit(130); // second Ctrl+C: leave now
    interrupted = true;
    console.log(`\n### run-all: ${sig} — stopping the current suite, skipping the rest`);
    if (killCurrent) killCurrent('SIGTERM');
  });
}
for (const s of SUITES) {
  const why = decide(s);
  if (why) {
    results.push({ name: s.name, status: 'SKIP', sec: 0, detail: why, log: '' });
    continue;
  }
  if (interrupted) {
    results.push({ name: s.name, status: 'SKIP', sec: 0, detail: 'interrupted', log: '' });
    continue;
  }
  console.log(`\n${'='.repeat(100)}\n=== ${s.name}  (${s.cmd.slice(1).join(' ')})\n${'='.repeat(100)}`);
  const r = await runSuite(s);
  results.push({ name: s.name, ...r });
  console.log(`=== ${s.name}: ${r.status} in ${r.sec.toFixed(1)} s${r.detail ? ` — ${r.detail}` : ''}`);
}

const fmt = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)}m${String(Math.round(sec % 60)).padStart(2, '0')}s` : `${sec.toFixed(1)}s`);
const rows = results.map((r) => [r.name, r.status, r.status === 'SKIP' ? '—' : fmt(r.sec), r.detail || '', r.log || '']);
const head = ['suite', 'result', 'time', 'detail', 'log'];
const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (cells) => `| ${cells.map((c, i) => c.padEnd(w[i])).join(' | ')} |`;
const failed = results.filter((r) => r.status === 'FAIL' || r.status === 'TIMEOUT');
const ran = results.filter((r) => r.status !== 'SKIP');
const table = [
  line(head),
  `|${w.map((n) => '-'.repeat(n + 2)).join('|')}|`,
  ...rows.map(line),
  '',
  `${ran.length - failed.length}/${ran.length} suites passed, ${results.length - ran.length} skipped, total ${fmt((Date.now() - tAll) / 1000)}${FAST ? ' (--fast)' : ''}`,
].join('\n');
console.log(`\n${table}`);
fs.writeFileSync(path.join(logs, 'summary.txt'), `${new Date().toISOString()}  node test/run-all.mjs ${argv.join(' ')}\n\n${table}\n`);
process.exit(failed.length || interrupted ? 1 : 0);
