// Lane N10 (MAC_CHECK "2.0 release checklist" B3): which refs can build or publish what. release.yml (Electron 1.x)
// must never run its build or release job for a v2.*+ tag, by any event; release-native.yml publishes only from a
// workflow_dispatch with publish ticked on a v2.* tag. GitHub Actions can't run here, so this evaluates the
// workflows' own tag filters and job `if:` expressions with a small evaluator for the subset they use (literals,
// context paths, !, ==, !=, &&, ||, parentheses, startsWith). Also: asset names vs 1.1's update check, and the
// release-notes body (tools/release/release-notes.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  releaseBody, draftReason, notesCandidates, bundleVersionForTag, filesSection,
} from '../../../tools/release/release-notes.mjs';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// js-yaml is not a direct dependency: it comes with electron-builder (package-lock), so it is there after `npm ci`
let yaml = null;
try {
  yaml = require('js-yaml');
} catch {
  yaml = null;
}
const noYaml = yaml ? false : 'js-yaml not installed (npm ci)';
const wf = (name) => yaml.load(read(`.github/workflows/${name}`));

// ---- a GitHub filter glob (the subset the tag filters use: *, ?, [..]) and an expression evaluator ---------------
function globMatch(pattern, s) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const j = pattern.indexOf(']', i);
      re += pattern.slice(i, j + 1);
      i = j;
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(s);
}

function evalExpr(src, ctx) {
  const s = src.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1').trim();
  const toks = [];
  const re = /\s*(?:('(?:[^']|'')*')|(&&|\|\||==|!=|!|\(|\)|,)|([A-Za-z_][\w.-]*)|(\d+))/y;
  let m;
  let end = 0; // exec() resets lastIndex to 0 when it fails: keep the last good position
  while (end < s.length && (m = re.exec(s))) {
    end = re.lastIndex;
    if (m[1]) toks.push({ t: 'lit', v: m[1].slice(1, -1).replace(/''/g, "'") });
    else if (m[2]) toks.push({ t: m[2] });
    else if (m[3]) toks.push({ t: 'id', v: m[3] });
    else toks.push({ t: 'lit', v: Number(m[4]) });
  }
  assert.equal(end, s.length, `unparsed expression tail in: ${s}`);
  let i = 0;
  const peek = () => toks[i] && toks[i].t;
  const eat = (t) => { assert.equal(peek(), t, `expected ${t} in ${s}`); return toks[i++]; };
  // GitHub compares strings case-insensitively
  const loose = (a, b) => (typeof a === 'string' && typeof b === 'string'
    ? a.toLowerCase() === b.toLowerCase() : a === b);
  const truthy = (v) => !(v === false || v === null || v === undefined || v === '' || v === 0);
  const fns = {
    startsWith: (a, b) => String(a ?? '').toLowerCase().startsWith(String(b ?? '').toLowerCase()),
    success: () => true, always: () => true, cancelled: () => false, failure: () => false,
  };
  function primary() {
    const k = peek();
    if (k === '!') { i++; return !truthy(primary()); }
    if (k === '(') { i++; const v = or(); eat(')'); return v; }
    if (k === 'lit') return toks[i++].v;
    const id = eat('id').v;
    if (peek() === '(') {
      i++;
      const args = [];
      while (peek() !== ')') { args.push(or()); if (peek() === ',') i++; }
      eat(')');
      assert.ok(fns[id], `unknown function ${id}`);
      return fns[id](...args);
    }
    if (id === 'true') return true;
    if (id === 'false') return false;
    if (id === 'null') return null;
    return id.split('.').reduce((o, k2) => (o == null ? undefined : o[k2]), ctx);
  }
  function cmp() {
    let v = primary();
    while (peek() === '==' || peek() === '!=') {
      const op = toks[i++].t;
      const r = primary();
      v = op === '==' ? loose(v, r) : !loose(v, r);
    }
    return v;
  }
  function and() { let v = cmp(); while (peek() === '&&') { i++; const r = cmp(); v = truthy(v) ? r : v; } return v; }
  function or() { let v = and(); while (peek() === '||') { i++; const r = and(); v = truthy(v) ? v : r; } return v; }
  const v = or();
  assert.equal(i, toks.length, `trailing tokens in ${s}`);
  return truthy(v);
}

/** Does `event` start this workflow at all (the `on:` filters)? */
function triggers(w, event) {
  const on = w.on;
  if (!(event.name in on)) return false;
  if (event.name === 'push') {
    // path filters are taken as matched (they apply to branch pushes only, never to tags)
    const { tags, branches } = on.push || {};
    if (event.ref.startsWith('refs/tags/')) {
      return Boolean(tags) && tags.some((p) => globMatch(p, event.ref.slice('refs/tags/'.length)));
    }
    const b = event.ref.slice('refs/heads/'.length);
    return branches ? branches.some((p) => globMatch(p, b)) : !tags;
  }
  if (event.name === 'release') return (on.release.types || ['published']).includes(event.action);
  return true;
}

/** The jobs that would run for `event` (job-level `if:` plus `needs`; every needed job assumed green). */
function runningJobs(w, event) {
  if (!triggers(w, event)) return [];
  const ctx = {
    github: { event_name: event.name, ref: event.ref, ref_name: event.ref.replace(/^refs\/(tags|heads)\//, '') },
    inputs: event.inputs || {},
  };
  const ran = new Set();
  const order = Object.keys(w.jobs);
  for (let pass = 0; pass < order.length; pass++) {
    for (const name of order) {
      const job = w.jobs[name];
      const needs = [].concat(job.needs || []);
      if (ran.has(name) || !needs.every((n) => ran.has(n))) continue;
      if (job.if === undefined || evalExpr(String(job.if), ctx)) ran.add(name);
    }
  }
  return order.filter((n) => ran.has(n));
}

const tag = (t) => `refs/tags/${t}`;
const push = (ref) => ({ name: 'push', ref });
const rel = (t) => ({ name: 'release', action: 'published', ref: tag(t) });
const dispatch = (ref, inputs) => ({ name: 'workflow_dispatch', ref, inputs });

test('evaluator sanity: the subset behaves like GitHub', () => {
  const ctx = { github: { ref: 'refs/tags/v1.2.3', event_name: 'push' }, inputs: { dry_run: false } };
  assert.equal(evalExpr("startsWith(github.ref, 'refs/tags/V1.')", ctx), true); // case-insensitive, as GitHub
  assert.equal(evalExpr("${{ !startsWith(github.ref, 'refs/tags/') }}", ctx), false);
  assert.equal(evalExpr("github.event_name == 'push' && (inputs.dry_run == false || false)", ctx), true);
  assert.equal(evalExpr('inputs.publish == true', ctx), false);
  assert.equal(globMatch('v1.*', 'v1.1.2'), true);
  assert.equal(globMatch('v1.*', 'v10.0.0'), false);
  assert.equal(globMatch('v2.*', 'v2.0.0-beta.1'), true);
});

test('release.yml (Electron): no event on a v2.*+ tag builds or publishes anything', { skip: noYaml }, () => {
  const w = wf('release.yml');
  for (const t of ['v2.0.0', 'v2.0.0-beta.1', 'v2.1.0', 'v3.0.0', 'v10.0.0']) {
    assert.deepEqual(runningJobs(w, push(tag(t))), [], `push ${t}`);
    assert.deepEqual(runningJobs(w, rel(t)), [], `release published ${t}`);
    assert.deepEqual(runningJobs(w, dispatch(tag(t), { dry_run: false })), [], `dispatch on ${t}, dry_run off`);
    assert.deepEqual(runningJobs(w, dispatch(tag(t), { dry_run: true })), [], `dispatch on ${t}, dry run`);
  }
});

test('release.yml (Electron): 1.x releases work as before', { skip: noYaml }, () => {
  const w = wf('release.yml');
  assert.deepEqual(runningJobs(w, push(tag('v1.1.2'))), ['build', 'release']);
  assert.deepEqual(runningJobs(w, rel('v1.1.2')), ['build', 'release']);
  assert.deepEqual(runningJobs(w, dispatch(tag('v1.1.2'), { dry_run: false })), ['build', 'release']);
  assert.deepEqual(runningJobs(w, dispatch(tag('v1.1.2'), { dry_run: true })), ['build']);
  // a branch run is a dry run whatever dry_run says
  assert.deepEqual(runningJobs(w, dispatch('refs/heads/main', { dry_run: false })), ['build']);
  assert.deepEqual(runningJobs(w, push('refs/heads/main')), []);
});

test('release-native.yml: builds on v2.* tags and dispatch; publishes only on dispatch + publish + v2 tag',
  { skip: noYaml }, () => {
    const w = wf('release-native.yml');
    assert.deepEqual(runningJobs(w, push(tag('v1.1.2'))), [], 'a 1.x tag starts nothing');
    assert.deepEqual(runningJobs(w, rel('v2.0.0')), [], 'no release trigger');
    assert.deepEqual(runningJobs(w, push(tag('v2.0.0'))), ['mac', 'ipad'], 'tag push: build only');
    assert.deepEqual(runningJobs(w, push(tag('v2.0.0-beta.1'))), ['mac', 'ipad']);
    // the path-filtered dry run on v2-native (the release files changed): build only
    assert.deepEqual(runningJobs(w, push('refs/heads/v2-native')), ['mac', 'ipad']);
    assert.deepEqual(runningJobs(w, push('refs/heads/main')), []);
    assert.ok(w.on.push.paths.includes('.github/workflows/release-native.yml'));
    const off = { publish: false, latest: false };
    const on = { publish: true, latest: false };
    assert.deepEqual(runningJobs(w, dispatch('refs/heads/v2-native', off)), ['mac', 'ipad'], 'the dry run');
    assert.deepEqual(runningJobs(w, dispatch('refs/heads/v2-native', on)), ['mac', 'ipad'], 'publish on a branch');
    assert.deepEqual(runningJobs(w, dispatch('refs/heads/main', { publish: true, latest: true })), ['mac', 'ipad']);
    assert.deepEqual(runningJobs(w, dispatch(tag('v1.1.2'), on)), ['mac', 'ipad'], 'publish on a 1.x tag');
    assert.deepEqual(runningJobs(w, dispatch(tag('v2.0.0'), off)), ['mac', 'ipad'], 'tag, publish off');
    assert.deepEqual(runningJobs(w, dispatch(tag('v2.0.0'), on)), ['mac', 'ipad', 'release'], 'the one way');
    // defaults are off
    assert.equal(w.on.workflow_dispatch.inputs.publish.default, false);
    assert.equal(w.on.workflow_dispatch.inputs.latest.default, false);
    // the release needs the macOS build (and with it the self-test), not the iPad archive
    assert.deepEqual([].concat(w.jobs.release.needs), ['mac']);
    assert.equal(w.jobs.ipad['continue-on-error'], true);
    // least privilege: only the release job can write
    assert.deepEqual(w.permissions, { contents: 'read' });
    for (const [n, j] of Object.entries(w.jobs)) {
      if (n !== 'release') assert.equal(j.permissions, undefined, `${n} has no extra permissions`);
    }
  });

test('release-native.yml: asset names are the ones 1.1 update-check.js pickAsset offers', { skip: noYaml }, () => {
  const U = require('../../../update-check.js');
  const w = wf('release-native.yml');
  const uploads = w.jobs.mac.steps.filter((s) => String(s.uses || '').startsWith('actions/upload-artifact'))
    .map((s) => s.with.name);
  assert.ok(uploads.includes('Worship-Rig-arm64.dmg') && uploads.includes('Worship-Rig-arm64.zip'), uploads.join());
  const script = read('native/apple/scripts/package-release.sh');
  assert.match(script, /^NAME="Worship-Rig-arm64"$/m);
  const url = (n) => `https://github.com/${U.REPO}/releases/download/v2.0.0/${n}`;
  const assets = ['Worship-Rig-arm64.dmg', 'Worship-Rig-arm64.zip', 'SHA256SUMS', 'worship-rig-starter-library.json']
    .map((name) => ({ name, browser_download_url: url(name) }));
  assert.deepEqual(U.pickAsset(assets, 'arm64'), { name: 'Worship-Rig-arm64.dmg', url: url('Worship-Rig-arm64.dmg') });
  assert.equal(U.pickAsset(assets, 'x64'), null, 'no Intel build in 2.x: Intel 1.1 installs get the release page');
  const create = w.jobs.release.steps.find((s) => s.name === 'Create the release').run;
  for (const f of ['assets/Worship-Rig-arm64.dmg', 'assets/Worship-Rig-arm64.zip',
    'docs/starter/worship-rig-starter-library.json']) assert.ok(create.includes(f), f);
  assert.match(create, /--verify-tag/);
  assert.match(create, /kind=\(--prerelease\); fi/, 'pre-release unless latest is ticked');
});

test('project.yml: the bundle versions come from MARKETING_VERSION / CURRENT_PROJECT_VERSION', { skip: noYaml }, () => {
  const p = yaml.load(read('native/apple/project.yml'));
  assert.match(String(p.settings.base.MARKETING_VERSION), /^\d+\.\d+\.\d+$/);
  for (const t of ['WorshipRig-macOS', 'WorshipRig-iPad']) {
    const props = p.targets[t].info.properties;
    assert.equal(props.CFBundleShortVersionString, '$(MARKETING_VERSION)', t);
    assert.equal(props.CFBundleVersion, '$(CURRENT_PROJECT_VERSION)', t);
  }
  // the workflow's sed reads the same number
  const m = /^ *MARKETING_VERSION: *"?([0-9][0-9.]*)"?/m.exec(read('native/apple/project.yml'));
  assert.equal(m[1], String(p.settings.base.MARKETING_VERSION));
});

test('release-notes: tag -> file and bundle version', () => {
  assert.deepEqual(notesCandidates('v2.0.0'), ['release-notes-2.0.0.md', 'release-notes-2.0.md']);
  assert.deepEqual(notesCandidates('v2.0.1'), ['release-notes-2.0.1.md']);
  assert.deepEqual(notesCandidates('v2.1.0-beta.1'),
    ['release-notes-2.1.0-beta.1.md', 'release-notes-2.1.0.md', 'release-notes-2.1.md']);
  assert.equal(bundleVersionForTag('v2.0.0-rc.2'), '2.0.0');
  assert.throws(() => bundleVersionForTag('2.0.0'));
  assert.throws(() => notesCandidates('v2.0'));
});

test('release-notes: banner, comments and Editor\'s notes go; links become absolute; drafts are named', () => {
  const md = [
    '> **Draft, not released** (Lane R). Ryan publishes it.',
    '> The "Editor\'s notes" at the end go before publishing.',
    '',
    'Intro with [a doc](../native/docs/X.md), [the site](https://example.org/a) and [a section](#install).',
    '',
    '### Install',
    'Use the dmg.',
    '<!-- Editor: file names to be settled. -->',
    '<!-- two',
    'lines -->',
    '### Editor\'s notes (delete before publishing)',
    '1. secret',
    '#### sub of editor',
    'more',
    '### After',
    'kept',
  ].join('\n');
  assert.match(draftReason(md), /banner/);
  const body = releaseBody(md, { repo: 'o/r', ref: 'v2.0.0', docPath: 'docs/release-notes-2.0.md' });
  assert.ok(!/Draft|Editor|secret|sub of editor|<!--/.test(body), body);
  assert.match(body, /^Intro with \[a doc\]\(https:\/\/github\.com\/o\/r\/blob\/v2\.0\.0\/native\/docs\/X\.md\)/);
  assert.match(body, /\(https:\/\/example\.org\/a\)/);
  assert.match(body, /\(#install\)/);
  assert.match(body, /### After\nkept\n$/);
  assert.equal(draftReason('Intro\n\n### Install\n'), '');
  assert.match(draftReason('Intro\n\n## Editor’s notes\n'), /Editor/);
  const sums = `${'a'.repeat(64)}  Worship-Rig-arm64.dmg\n${'b'.repeat(64)}  Worship-Rig-arm64.zip\n`;
  assert.match(filesSection(sums), /`Worship-Rig-arm64\.dmg`: `a{64}`\n- `Worship-Rig-arm64\.zip`: `b{64}`/);
});

test('release-notes: the real 2.0 draft yields a clean body', () => {
  const name = 'release-notes-2.0.md';
  const o = { repo: 'ryanmye/worship-rig', ref: 'v2.0.0', docPath: `docs/${name}` };
  const body = releaseBody(read(`docs/${name}`), o);
  assert.ok(body.length > 2000);
  assert.ok(!/Draft, not released|Editor's notes|<!--/.test(body));
  assert.match(body, /Worship-Rig-arm64\.dmg/);
  for (const [, href] of body.matchAll(/\]\(([^)\s]+)\)/g)) assert.match(href, /^(https:\/\/|#|mailto:)/, href);
});
