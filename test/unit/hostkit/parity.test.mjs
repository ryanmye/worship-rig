// Lane N1: hostkit (native/core/src/hostkit, the native app's patch-pack scanner) against server.js, the reference.
// Needs the rig-hostkit CLI: RIG_HOSTKIT_CLI=<path> (ctest `unit.hostkit-parity` sets it), else the first one built
// under native/core/build*/; skipped when there is none. Everything is generated here, in a temp folder.
//   1. JSON.parse + JSON.stringify on a generated corpus (the hash is sha1 of a stringify): byte for byte
//   2. Node's UTF-8 decode, .length, .slice(0, 40), .trim(): byte for byte
//   3. localeCompare(numeric, base) order: identical on realistic names, measured on exotic ones
//   4. scanUserPatches / hasUserPatches / GET /api/user-patches and /api/health on generated pack trees: byte for
//      byte (error texts included: hostkit reproduces V8's SyntaxError messages)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { jsonCases, textCases, nameCases, exoticAlphabet, REAL_ALPHABET, buildTree, wtf8 } from './corpus.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const server = require(path.join(root, 'server.js'));

function findCli() {
  if (process.env.RIG_HOSTKIT_CLI) return process.env.RIG_HOSTKIT_CLI;
  const core = path.join(root, 'native/core');
  for (const d of fs.readdirSync(core).filter((n) => n.startsWith('build')).sort()) {
    for (const sub of ['', 'release', 'debug', 'asan']) {
      const p = path.join(core, d, sub, 'rig-hostkit');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
const CLI = findCli();
const skip = CLI ? false : 'rig-hostkit not built (cmake --build <dir> --target rig-hostkit), or set RIG_HOSTKIT_CLI';

const run = (args, input) => execFileSync(CLI, args, { input, maxBuffer: 1 << 28 });
const hexLines = (bufs) => `${bufs.map((b) => b.toString('hex')).join('\n')}\n`;

function deeperThan(v, max, d = 0) {  // server.js
  if (v === null || typeof v !== 'object') return false;
  if (d >= max) return true;
  for (const x of Array.isArray(v) ? v : Object.values(v)) if (deeperThan(x, max, d + 1)) return true;
  return false;
}
/** v with every container at depth >= max replaced by null (what hostkit builds when it is too deep). */
function cut(v, max, d = 0) {
  if (v === null || typeof v !== 'object') return v;
  if (d >= max) return null;
  if (Array.isArray(v)) return v.map((x) => cut(x, max, d + 1));
  const o = {};
  for (const k of Object.keys(v)) Object.defineProperty(o, k, { value: cut(v[k], max, d + 1), enumerable: true, writable: true, configurable: true });
  return o;
}

test('JSON.parse + JSON.stringify (and SyntaxError texts): byte for byte on the corpus', { skip }, () => {
  const cases = jsonCases(20000);
  const got = run(['json'], hexLines(cases)).toString().replace(/\n$/, '').split('\n');
  assert.equal(got.length, cases.length);
  let ok = 0;
  let bad = 0;
  const fails = [];
  for (const [i, b] of cases.entries()) {
    let want;
    try {
      const v = JSON.parse(b.toString('utf8'));
      want = `ok ${deeperThan(v, 64) ? 1 : 0} ${wtf8(JSON.stringify(cut(v, 64))).toString('hex')}`;
      ok++;
    } catch (e) {
      want = `err ${wtf8(e.message).toString('hex')}`;
      bad++;
    }
    if (got[i] !== want && fails.length < 10) {
      const show = (x) => (x.startsWith('err ') ? `err ${Buffer.from(x.slice(4), 'hex').toString()}` : x);
      const [g, w] = [show(got[i]), show(want)];
      let k = 0;
      while (k < g.length && g[k] === w[k]) k++;
      const at = Math.max(0, k - 60);
      fails.push(`${JSON.stringify(b.toString('latin1').slice(0, 80))}…: at ${k}: ${g.slice(at, k + 60)} vs ${w.slice(at, k + 60)}`);
    }
  }
  console.log(`json corpus: ${cases.length} cases (${ok} valid, ${bad} invalid)`);
  assert.deepEqual(fails, []);
});

test('UTF-8 decode, length, slice(0, 40), trim: byte for byte', { skip }, () => {
  const cases = textCases(3000);
  const got = run(['text'], hexLines(cases)).toString().replace(/\n$/, '').split('\n');
  const fails = [];
  for (const [i, b] of cases.entries()) {
    const s = b.toString('utf8');
    const want = [wtf8(s).toString('hex'), s.length, wtf8(s.slice(0, 40)).toString('hex'), wtf8(s.trim()).toString('hex')].join(' ');
    if (got[i] !== want && fails.length < 10) fails.push(`${JSON.stringify(s)}: ${got[i]} vs ${want}`);
  }
  assert.deepEqual(fails, []);
});

/** Sort with both and count the positions that differ. */
function collate(names) {
  const bufs = names.map((n) => Buffer.from(n, 'utf8'));
  const got = run(['collate'], hexLines(bufs)).toString().replace(/\n$/, '').split('\n').map((h) => Buffer.from(h, 'hex').toString('utf8'));
  const want = [...names].sort((x, y) => x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }));
  let diff = 0;
  for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) diff++;
  return { got, want, diff };
}

test('localeCompare order: identical on realistic names', { skip }, () => {
  for (const seed of [3, 30, 300]) {
    const { got, want, diff } = collate(nameCases(3000, REAL_ALPHABET, seed));
    if (diff) {
      const i = got.findIndex((g, k) => g !== want[k]);
      assert.fail(`seed ${seed}: ${diff} of ${want.length} positions differ; first at ${i}: ${JSON.stringify(got.slice(i, i + 3))} vs ${JSON.stringify(want.slice(i, i + 3))}`);
    }
  }
});

test('localeCompare order: measured on exotic names (all of the modelled blocks, Hangul, emoji)', { skip }, () => {
  const names = nameCases(3000, exoticAlphabet(), 5);
  const { diff } = collate(names);
  // pairs out of order in hostkit's sort, as a share of all adjacent pairs of Node's order
  const { got, want } = collate(names);
  const pos = new Map(got.map((g, i) => [g, i]));
  let inv = 0;
  for (let i = 1; i < want.length; i++) if (pos.get(want[i - 1]) > pos.get(want[i])) inv++;
  console.log(`exotic names: ${diff} of ${names.length} positions differ, ${inv} adjacent inversions`);
  assert.ok(inv / names.length < 0.02, `${inv} inversions in ${names.length}`);
});

/** Byte for byte, with the first difference in the message. */
function sameBytes(got, want, what) {
  if (got === want) return;
  let k = 0;
  while (k < got.length && got[k] === want[k]) k++;
  assert.fail(`${what}: differs at ${k}:\n  hostkit ${got.slice(Math.max(0, k - 80), k + 80)}\n  server  ${want.slice(Math.max(0, k - 80), k + 80)}`);
}

for (const variant of ['main', 'caps', 'edge']) {
  test(`scanUserPatches on a generated tree (${variant}): byte for byte`, { skip }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rig hostkit Ä ${variant}-`));
    try {
      const roots = buildTree(dir, variant).map((r) => path.resolve(r));
      for (const ids of [null, ['user:here']]) {
        const want = JSON.stringify(await server.scanUserPatches(roots, { userIds: ids ? new Set(ids) : null }));
        const got = run(['scan', JSON.stringify(roots), ...(ids ? [JSON.stringify(ids)] : [])]).toString('utf8');
        sameBytes(got, want, `scan ${variant}`);
        const j = JSON.parse(want);
        console.log(`${variant}${ids ? ' +userIds' : ''}: ${j.patches.length} patches, ${j.packs.length} packs, `
          + `${j.errors.length} errors, ${Buffer.byteLength(want)} bytes: identical`);
        if (variant === 'main') assert.ok(j.patches.length > 20 && j.errors.length > 30, 'the tree exercises the scanner');
      }
      const has = run(['has', JSON.stringify(roots)]).toString();
      assert.equal(has, String(await server.hasUserPatches(roots)));
      assert.equal(run(['has', JSON.stringify([path.join(dir, 'nothing')])]).toString(), 'false');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('GET /api/user-patches and /api/health of server.js vs hostkit', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-hostkit-route-'));
  const roots = buildTree(dir, 'main').map((r) => path.resolve(r));
  const srv = server.createServer({ appDir: path.join(root, 'app'), port: 0, userSamples: roots, portTries: 0 });
  try {
    const { port } = await srv.listen();
    const base = `http://127.0.0.1:${port}`;
    const body = Buffer.from(await (await fetch(`${base}/api/user-patches`)).arrayBuffer()).toString('utf8');
    const health = await (await fetch(`${base}/api/health`)).json();
    // the server checks `user:` refs against its My Samples scan (no instruments in this tree): an empty id list
    const got = run(['user-patches', JSON.stringify(roots), '[]']).toString('utf8');
    sameBytes(got, body, 'GET /api/user-patches');
    assert.equal(health.userPatches, run(['has', JSON.stringify(roots)]).toString() === 'true');
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
