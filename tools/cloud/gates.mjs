#!/usr/bin/env node
// Resumable gate runner for cloud lanes (orchestrator, 2026-11-27): the cloud box restarts often and kills every
// running process, so a 40-minute gate list run as one command loses everything done so far.
//   node tools/cloud/gates.mjs <suite|shell-unit>[,...] [--force] [--status]
// Runs the suites one at a time (2-CPU box rule) through test/run-all.mjs --only <suite>, and records each result in
// <git-dir>/rig-gates.json keyed by the tree it ran on (HEAD + a hash of `git diff HEAD`, untracked files included
// by name). A rerun skips every suite that already passed on the same tree, so after a restart the same command
// picks up where it stopped. Logs: <git-dir>/rig-gates/<suite>.log. `shell-unit` = test/phase1/shell/run.mjs
// --only unit. Exit code 0 only if every listed suite has passed on this tree.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const STATUS = argv.includes('--status');
const list = (argv.find((a) => !a.startsWith('--')) || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!list.length) {
  console.error('usage: node tools/cloud/gates.mjs suite[,suite...] [--force] [--status]');
  process.exit(2);
}
const git = (...a) => spawnSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout.trim();
const root = git('rev-parse', '--show-toplevel');
const gitDir = path.resolve(root, git('rev-parse', '--git-dir'));
const store = path.join(gitDir, 'rig-gates.json');
const logDir = path.join(gitDir, 'rig-gates');
fs.mkdirSync(logDir, { recursive: true });

/** The tree the gates run on: HEAD plus every uncommitted change (so editing a file invalidates old passes). */
function treeKey() {
  const head = git('rev-parse', 'HEAD');
  const diff = git('diff', 'HEAD');
  const untracked = git('ls-files', '--others', '--exclude-standard');
  const h = crypto.createHash('sha256').update(diff).update('\0').update(untracked).digest('hex').slice(0, 12);
  return `${head.slice(0, 12)}+${diff || untracked ? h : 'clean'}`;
}
const load = () => { try { return JSON.parse(fs.readFileSync(store, 'utf8')); } catch { return {}; } };
const save = (db) => { fs.writeFileSync(store + '.tmp', JSON.stringify(db, null, 1)); fs.renameSync(store + '.tmp', store); };

const key = treeKey();
const cmdFor = (s) => (s === 'shell-unit'
  ? [process.execPath, ['test/phase1/shell/run.mjs', '--only', 'unit']]
  : [process.execPath, ['test/run-all.mjs', '--only', s, '--quiet']]);

function runOne(s) {
  return new Promise((resolve) => {
    const [bin, args] = cmdFor(s);
    const log = fs.openSync(path.join(logDir, `${s}.log`), 'w');
    const t0 = Date.now();
    const child = spawn(bin, args, { cwd: root, stdio: ['ignore', log, log], env: process.env });
    child.on('exit', (code, sig) => resolve({ ok: code === 0, code, sig, secs: Math.round((Date.now() - t0) / 1000) }));
  });
}

const rows = [];
let failed = 0;
for (const s of list) {
  const db = load();
  const prev = db[key]?.[s];
  if (STATUS || (prev?.ok && !FORCE)) {
    rows.push([s, prev ? (prev.ok ? 'PASS' : 'FAIL') : '—', prev ? `${prev.secs}s, ${prev.at}` : 'not run',
      STATUS ? '' : 'skipped (passed on this tree)']);
    if (!prev?.ok) failed++;
    continue;
  }
  console.log(`[gates] ${s} … (log ${path.join(logDir, s + '.log')})`);
  const r = await runOne(s);
  const db2 = load();
  db2[key] = { ...(db2[key] || {}), [s]: { ...r, at: new Date().toISOString() } };
  save(db2);
  rows.push([s, r.ok ? 'PASS' : 'FAIL', `${r.secs}s`, r.ok ? '' : `exit ${r.code ?? r.sig}`]);
  if (!r.ok) failed++;
  if (key !== treeKey()) {
    console.log('[gates] the tree changed while a suite ran: later results would not belong to one tree; stopping.');
    process.exit(3);
  }
}
console.log(`\n[gates] tree ${key}`);
for (const r of rows) console.log(`  ${r[0].padEnd(14)} ${r[1].padEnd(5)} ${r[2]}  ${r[3]}`);
process.exit(failed ? 1 : 0);
