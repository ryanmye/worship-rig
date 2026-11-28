// Lane N0: the native shell's window.rig (app/js/native-shell/*.js) run in a vm the way RigShellScripts injects it,
// against a fake webkit.messageHandlers.rigShell. The Swift around it compiles only on the CI Mac; the checks at the
// end keep the two sides' method names and file rules in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, SHELL_DIR, SWIFT_ROUTER, SEPARATOR, shellFiles, documentStartScript, loadShell, fakeHandler, plain }
  from './fake-shell.mjs';

const flush = () => new Promise((r) => setImmediate(r));
const SWIFT_DIR = path.join(ROOT, 'native/apple/Sources/Shared');

test('files: NN-name.js, 00-core first, each a classic script (no import / export: injected, not loaded)', () => {
  const files = shellFiles();
  assert.ok(files.length >= 3, files.join(', '));
  assert.equal(files[0], '00-core.js');
  for (const f of files) {
    assert.match(f, /^\d{2}-[a-z0-9-]+\.js$/, f);
    const src = fs.readFileSync(path.join(SHELL_DIR, f), 'utf8');
    assert.doesNotThrow(() => new vm.Script(src, { filename: f }), f);
    assert.ok(!/^\s*(import|export)\s/m.test(src), `${f}: no module syntax`);
    for (const [i, line] of src.split('\n').entries()) assert.ok(line.length <= 120, `${f}:${i + 1} > 120 columns`);
  }
  const all = fs.readdirSync(SHELL_DIR);
  assert.deepEqual(all.filter((n) => !n.endsWith('.js')), [], 'only .js files in app/js/native-shell');
});

test('core: window.rig flags, __rigNative queue, __rigShell basics (Mac defaults)', () => {
  const { win } = loadShell();
  assert.deepEqual(plain({ ...win.rig, onMenu: undefined }), {
    isElectron: false, shell: 'native', platform: 'macos', menuOwnsShortcuts: false, keepsAwake: false,
  });
  assert.equal(typeof win.rig.onMenu, 'function');
  assert.equal(win.__rigShell.native, true);
  assert.equal(win.__rigShell.platform, 'macos');
  assert.equal(win.__rigShell.shellVersion, 2);
  win.__rigNative.receive([{ ev: 'tick' }]);
  assert.deepEqual(plain(win.__rigNative.queue), [[{ ev: 'tick' }]], 'early native deliveries are parked');
});

test('core: config decides platform and the N5 flags; an unknown platform reads as macos', () => {
  const ipad = loadShell({ config: { platform: 'ipados', menuOwnsShortcuts: false } }).win;
  assert.equal(ipad.rig.platform, 'ipados');
  assert.equal(ipad.__rigShell.platform, 'ipados');
  const n5 = loadShell({ config: { platform: 'macos', menuOwnsShortcuts: true, keepsAwake: true } }).win;
  assert.equal(n5.rig.menuOwnsShortcuts, true);
  assert.equal(n5.rig.keepsAwake, true);
  const odd = loadShell({ config: { platform: 'darwin', menuOwnsShortcuts: 'yes' } }).win;
  assert.equal(odd.rig.platform, 'macos');
  assert.equal(odd.rig.menuOwnsShortcuts, false, 'only a real true turns it on');
  const none = loadShell({ config: null }).win;
  assert.equal(none.rig.platform, 'macos');
});

test('__rigShell is merged, never replaced: keys set before the script survive', () => {
  const recording = () => false;
  const { win } = loadShell({ pre: (w) => { w.__rigShell = { recording, extra: 1 }; } });
  assert.equal(win.__rigShell.recording, recording);
  assert.equal(win.__rigShell.extra, 1);
  assert.equal(typeof win.__rigShell.menu, 'function');
});

test('menu: onMenu / menuReady / unsubscribe; a throwing callback does not stop the others', () => {
  const { win, warns } = loadShell();
  assert.equal(win.__rigShell.menuReady(), false);
  const got = [];
  const offA = win.rig.onMenu((id) => got.push(['a', id]));
  win.rig.onMenu(() => { throw new Error('boom'); });
  win.rig.onMenu((id) => got.push(['c', id]));
  assert.equal(win.__rigShell.menuReady(), true);
  win.__rigShell.menu('importLatestBackup');
  assert.deepEqual(got, [['a', 'importLatestBackup'], ['c', 'importLatestBackup']]);
  assert.equal(warns.length, 1);
  offA();
  win.__rigShell.menu('x');
  assert.deepEqual(got.slice(2), [['c', 'x']]);
  assert.equal(typeof win.rig.onMenu('not a function'), 'function', 'a bad callback gets a no-op unsubscribe');
});

test('injected twice into one document: one window.rig, one menu list', () => {
  const s = loadShell();
  const rig = s.win.rig;
  const got = [];
  rig.onMenu((id) => got.push(id));
  s.run();
  assert.equal(s.win.rig, rig);
  s.win.__rigShell.menu('m');
  assert.deepEqual(got, ['m']);
});

test('a window.rig that is not ours is left alone, and no feature is added to it', () => {
  const theirs = { isElectron: true };
  const { win } = loadShell({ pre: (w) => { w.rig = theirs; } });
  assert.equal(win.rig, theirs);
  assert.deepEqual(Object.keys(theirs), ['isElectron']);
  assert.equal(typeof win.__rigShell.call, 'function', '__rigShell.call still exists for the shell');
});

test('call: no handler, a rejected reply, a null reply, an unknown method; `m` cannot be overridden', async () => {
  const none = loadShell({ handler: null }).win;
  assert.deepEqual(plain(await none.rig.getInfo()), { error: 'shell unavailable' });
  const failing = loadShell({ handlers: { getInfo: () => { throw new Error('shell gone'); } } }).win;
  assert.deepEqual(plain(await failing.rig.getInfo()), { error: 'shell gone' });
  const nul = loadShell({ handlers: { getInfo: () => null } }).win;
  assert.deepEqual(plain(await nul.rig.getInfo()), { error: 'no reply' });
  const unknown = loadShell({ handlers: {} }).win;
  assert.deepEqual(plain(await unknown.__rigShell.call('nope')), { error: 'unknown method nope' });
  const h = fakeHandler({ backupNow: (b) => ({ path: `/b/${b.m}` }) });
  const w = loadShell({ handler: h }).win;
  assert.deepEqual(plain(await w.__rigShell.call('backupNow', { m: 'evil', json: '{}' })), { path: '/b/backupNow' });
  const throwsSync = { postMessage() { throw new Error('not allowed'); } };
  const t = loadShell({ handler: throwsSync }).win;
  assert.deepEqual(plain(await t.rig.latestBackup()), { error: 'not allowed' });
});

test('library: backupNow sends the JSON text (objects stringified) and the kind; latestBackup passes through',
  async () => {
    const staged = { path: '/x/rig-20261124-210000.json', origin: 'http://127.0.0.1:8438', savedAt: 1, text: '{}',
      via: 'backups' };
    const h = fakeHandler({ backupNow: (b) => ({ path: `/b/${b.kind || 'library'}` }), latestBackup: () => staged });
    const { win } = loadShell({ handler: h });
    assert.deepEqual(plain(await win.rig.backupNow('{"a":1}')), { path: '/b/library' });
    assert.deepEqual(plain(await win.rig.backupNow({ a: 2 }, 'unreadable')), { path: '/b/unreadable' });
    assert.deepEqual(plain(await win.rig.latestBackup()), staged);
    assert.deepEqual(plain(h.calls), [
      { json: '{"a":1}', m: 'backupNow' },
      { json: '{"a":2}', kind: 'unreadable', m: 'backupNow' },
      { m: 'latestBackup' },
    ]);
  });

test('info: getInfo asks the shell each time and returns its answer', async () => {
  let n = 0;
  const info = () => ({ version: '2.0.0', build: String(++n), shell: 'native', platform: 'macos', port: 0 });
  const { win, handler } = loadShell({ handlers: { getInfo: info } });
  assert.equal((await win.rig.getInfo()).build, '1');
  assert.equal((await win.rig.getInfo()).build, '2');
  assert.deepEqual(handler.calls, [{ m: 'getInfo' }, { m: 'getInfo' }]);
  await flush();
});

test('Swift side: the router loads this folder with this separator; every call() method has a Swift feature', () => {
  const router = fs.readFileSync(SWIFT_ROUTER, 'utf8');
  assert.ok(router.includes('"js/native-shell"'), 'RigShellScripts.dirName');
  assert.ok(router.includes(`separator = "${SEPARATOR.replace(/\n/g, '\\n')}"`), 'RigShellScripts.separator');
  assert.ok(router.includes('window.__rigShellConfig = '), 'the config line');
  const js = shellFiles().map((f) => fs.readFileSync(path.join(SHELL_DIR, f), 'utf8')).join('\n');
  const called = [...js.matchAll(/shell\.call\('([A-Za-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(called)].sort(), ['backupNow', 'getInfo', 'latestBackup']);
  const swift = fs.readdirSync(SWIFT_DIR).filter((f) => f.endsWith('.swift'))
    .map((f) => fs.readFileSync(path.join(SWIFT_DIR, f), 'utf8')).join('\n');
  const declared = [...swift.matchAll(/let methods(?:: \[String\])? = \[([^\]]*)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/"([A-Za-z]+)"/g)].map((x) => x[1]));
  for (const m of called) assert.ok(declared.includes(m), `no Swift RigShellFeature declares "${m}"`);
  assert.equal(new Set(declared).size, declared.length, 'a method is owned by one feature');
  // the polyfill no longer lives in a Swift string (lane N0): nothing assigns window.rig from Swift
  assert.ok(!/window\.rig\s*=/.test(swift), 'a Swift file still assigns window.rig');
});

test('documentStartScript: the config line first, then the files in order, joined by the separator', () => {
  const s = documentStartScript({ platform: 'ipados' });
  const parts = s.split(SEPARATOR);
  assert.equal(parts[0], 'window.__rigShellConfig = {"platform":"ipados"};');
  assert.deepEqual(parts.slice(1).map((p) => p.split('\n')[0]), shellFiles().map((f) => `// ${f}`));
});
