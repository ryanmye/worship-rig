#!/usr/bin/env node
// electron-builder config sanity for the host platform (SPEC §7/§1 package.json "build"):
//   node test/integration/build-lint.mjs [--keep] [--no-boot]
// Runs `npx electron-builder --linux dir` (`--mac dir` on macOS, L-2) with the repo's own "build" config into a
// temp output dir (Electron taken from node_modules/electron/dist, so nothing is downloaded), then inspects
// app.asar (resources/ on linux, <productName>.app/Contents/Resources/ on mac):
//   • present: package.json, main.js, preload.js, server.js, README.md, LICENSES.md, app/index.html,
//     app/samples/manifest.json and EVERY sample file the manifest lists
//   • excluded: app/js/engine/test.html, test/, tools/, audition/, reviews/, dist/, node_modules/electron*, *.md specs
//   • every file under app/ that exists on disk (minus the exclusions) is packaged
// Then (unless --no-boot, Linux + xvfb) boots the packaged binary with RIG_SELFTEST=1: the real app has no probe, so
// main.js times out waiting for window.__RIG_SELFTEST__ and reports (exit 2) — the report still proves the packaged
// app served index.html from the asar on 127.0.0.1 with zero console.error.
// The temp output (~300 MB) is always removed unless --keep.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { checker, electronEnv, freePort, hasXvfb, repoRoot, sleep } from './lib.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const KEEP = process.argv.includes('--keep');
const BOOT = !process.argv.includes('--no-boot');
const { check, skip, finish } = checker('build-lint');

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-it-build-'));
let code = 1;
try {
  // ---- static config checks (cheap, before the build)
  const b = pkg.build || {};
  check('package.json has a "build" config with appId + productName', !!(b.appId && b.productName), `${b.appId} / ${b.productName}`);
  check('build.files excludes app/js/engine/test.html', (b.files || []).includes('!app/js/engine/test.html'), JSON.stringify(b.files));
  check('mac target is arm64 dir+zip, identity null (ad-hoc), afterPack hook exists', JSON.stringify(b.mac?.target || []).includes('arm64') && b.mac?.identity === null && fs.existsSync(path.join(repoRoot, b.afterPack || '')), `${JSON.stringify(b.mac?.target)} afterPack ${b.afterPack}`);
  check('mac icon exists', !!b.mac?.icon && fs.existsSync(path.join(repoRoot, b.mac.icon)), b.mac?.icon);
  check('main entry exists', fs.existsSync(path.join(repoRoot, pkg.main || 'index.js')), pkg.main);

  // ---- build
  // integration-2: Electron 44's npm package has no postinstall; the binary is fetched on the first
  // require('electron'). In a fresh clone where nothing has launched Electron yet, dist/ would not exist.
  require(path.join(repoRoot, 'node_modules', 'electron'));
  const electronDist = path.join(repoRoot, 'node_modules', 'electron', 'dist');
  const electronVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  // L-2: electronDist is the host's own Electron (Electron.app on macOS), so build for the host platform: a
  // `--linux dir` build from a Mac dist fails renaming the missing linux `electron` binary.
  const platform = process.platform === 'darwin' ? 'mac' : 'linux';
  const args = ['electron-builder', `--${platform}`, 'dir', '--publish', 'never', `-c.directories.output=${out}`, `-c.electronDist=${electronDist}`, `-c.electronVersion=${electronVersion}`];
  console.log(`# npx ${args.join(' ')}`);
  const t0 = Date.now();
  const r = spawnSync('npx', args, { cwd: repoRoot, encoding: 'utf8', timeout: 600000, env: electronEnv({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' }) });
  const log = `${r.stdout || ''}${r.stderr || ''}`;
  const built = check(`electron-builder --${platform} dir succeeds (${((Date.now() - t0) / 1000).toFixed(0)} s)`, r.status === 0, r.status === 0 ? '' : log.slice(-2500));
  if (!built) throw new Error('build failed');
  const unpacked = fs.readdirSync(out).map((d) => path.join(out, d)).find((d) => fs.existsSync(path.join(d, 'resources')) || fs.existsSync(path.join(d, `${pkg.build.productName}.app`)));
  // linux: <out>/linux-*-unpacked/resources/app.asar; mac: <out>/mac-*/<productName>.app/Contents/Resources/app.asar
  const asarPath = unpacked && (platform === 'mac' ? path.join(unpacked, `${pkg.build.productName}.app`, 'Contents', 'Resources', 'app.asar') : path.join(unpacked, 'resources', 'app.asar'));
  check('app.asar produced', asarPath && fs.existsSync(asarPath), asarPath || fs.readdirSync(out).join(', '));

  // ---- contents
  const list = new Set(asar.listPackage(asarPath).map((p) => p.replace(/\\/g, '/').replace(/^\//, '')));
  const has = (rel) => list.has(rel);
  for (const f of ['package.json', 'main.js', 'preload.js', 'server.js', 'README.md', 'LICENSES.md', 'app/index.html', 'app/package.json', 'app/js/main.js', 'app/js/engine/index.js', 'app/js/worklets/recorder-processor.js', 'app/samples/manifest.json']) {
    check(`packaged: ${f}`, has(f));
  }
  check('excluded: app/js/engine/test.html', !has('app/js/engine/test.html'));
  const leaked = [...list].filter((p) => /^(test|tools|audition|reviews|dist|build)(\/|$)/.test(p) || /^node_modules\/(electron|electron-builder|playwright)(\/|$)/.test(p) || /^(SPEC|REVIEW|VERIFY|CONTRACT_CHANGES)\.md$/.test(p));
  check('nothing from test/, tools/, audition/, reviews/, build/, dev deps or spec docs is packaged', leaked.length === 0, leaked.slice(0, 10).join(', '));

  // manifest (as packaged) → every listed sample present
  const manifest = JSON.parse(asar.extractFile(asarPath, 'app/samples/manifest.json').toString('utf8'));
  const wanted = [];
  for (const inst of manifest.instruments || []) {
    const ext = inst.ext || inst.format || 'mp3';
    for (const L of inst.layers || []) {
      const dir = L.dir ?? inst.dir ?? inst.id;
      if (L.files && typeof L.files === 'object') for (const rel of Object.values(L.files)) wanted.push(path.posix.normalize(`app/samples/${rel}`));
      else for (const note of L.notes || inst.notes || []) wanted.push(`app/samples/${dir}/${note}.${L.ext || ext}`);
    }
  }
  const missing = wanted.filter((f) => !has(f));
  check(`every sample the manifest lists is packaged (${wanted.length} files, ${(manifest.instruments || []).length} instruments)`, wanted.length > 0 && missing.length === 0, missing.length ? `${missing.length} missing: ${missing.slice(0, 12).join(', ')}` : '');
  const missingOnDisk = wanted.filter((f) => !fs.existsSync(path.join(repoRoot, f)));
  if (missingOnDisk.length) console.log(`# note: ${missingOnDisk.length} manifest entries are missing in the source tree too (samples issue, not packaging): ${missingOnDisk.slice(0, 8).join(', ')}`);

  // every file under app/ on disk is packaged (except the exclusion)
  const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name), `${rel}${d.name}/`) : [`${rel}${d.name}`]));
  const onDisk = walk(path.join(repoRoot, 'app')).map((f) => `app/${f}`).filter((f) => f !== 'app/js/engine/test.html' && !/\.DS_Store$/.test(f));
  const notPacked = onDisk.filter((f) => !has(f));
  check(`every app/ file on disk is packaged (${onDisk.length} files)`, notPacked.length === 0, notPacked.slice(0, 10).join(', '));
  const size = fs.statSync(asarPath).size / 1048576;
  console.log(`# app.asar ${size.toFixed(1)} MB, ${list.size} entries`);

  // ---- boot the packaged app (Linux + xvfb)
  if (BOOT && process.platform === 'linux' && hasXvfb()) {
    const bin = fs.readdirSync(unpacked).map((f) => path.join(unpacked, f)).find((f) => fs.statSync(f).isFile() && (fs.statSync(f).mode & 0o111) && /worship/i.test(path.basename(f)) && !/\.so/.test(f));
    if (!bin) check('packaged executable found', false, fs.readdirSync(unpacked).join(', '));
    else {
      const port = await freePort();
      const userData = path.join(out, 'userData');
      const res = await new Promise((resolve) => {
        const child = spawn('xvfb-run', ['-a', bin, '--no-sandbox'], {
          env: electronEnv({ RIG_SELFTEST: '1', RIG_SELFTEST_TIMEOUT_MS: '12000', RIG_PORT: String(port), RIG_USER_DATA: userData, RIG_RECORDINGS_DIR: path.join(out, 'rec'), RIG_APP_DIR: '', ELECTRON_ENABLE_LOGGING: '0' }),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        let so = '';
        let se = '';
        child.stdout.on('data', (d) => (so += d));
        child.stderr.on('data', (d) => (se += d));
        const k = setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* gone */
          }
        }, 60000);
        child.on('close', (c) => {
          clearTimeout(k);
          // integration-2: xvfb-run's exit-5 path returns before it kills its Xvfb, which then leaks; reap the group
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            /* group already gone (normal case) */
          }
          const line = so.split('\n').find((l) => l.startsWith('RIG_SELFTEST '));
          resolve({ code: c, report: line ? JSON.parse(line.slice(13)) : null, so, se });
        });
      });
      const rep = res.report;
      // integration-2: on a wrong exit code, show stderr too. Exit 5 is xvfb-run's own "problem while cleaning up
      // temporary directory" (seen once under load, after the app had printed a good report), not the app's.
      const seTail = res.code === 2 ? '' : `\n${res.se.split('\n').filter((l) => /xvfb-run|rm:|error/i.test(l)).slice(-6).join('\n')}`;
      if (!check('packaged app boots and reports (selftest timeout expected: exit 2)', rep && rep.timeout === true && res.code === 2 && !rep.loadError, rep ? `exit ${res.code}, url ${rep.url}${seTail}` : `exit ${res.code}\n${res.so.slice(-1500)}\n${res.se.slice(-1500)}`)) {
        /* details printed */
      }
      if (rep) {
        check(`packaged app loads from http://127.0.0.1:${port}/`, rep.url === `http://127.0.0.1:${port}/`, rep.url);
        const errs = (rep.console || []).filter((c) => c.level === 'error');
        check('packaged app: zero console.error (index.html, modules, samples served from app.asar)', rep.consoleErrors === 0, errs.map((e) => e.message).slice(0, 6).join(' | '));
      }
      await sleep(200);
    }
  } else skip('boot packaged app', BOOT ? 'needs Linux + xvfb-run' : '--no-boot');
  code = finish();
} catch (e) {
  if (!/build failed/.test(String(e))) check(`build-lint crashed: ${e.message}`, false, e.stack);
  code = finish();
} finally {
  if (KEEP) console.log(`# kept ${out}`);
  else fs.rmSync(out, { recursive: true, force: true });
}
process.exit(code);
