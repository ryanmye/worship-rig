// Lane N0: the native shell's document-start script as RigShellScripts (native/apple/Sources/Shared/
// RigShellRouter.swift) builds it, plus a fake `webkit.messageHandlers.rigShell` (a WKScriptMessageHandlerWithReply:
// postMessage returns a Promise of the reply). Shared by the node:test files here, the native-shell Playwright suite
// and migration-1x, so every test runs the real app/js/native-shell files, never a copy.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SHELL_DIR = path.join(ROOT, 'app/js/native-shell');
export const SWIFT_ROUTER = path.join(ROOT, 'native/apple/Sources/Shared/RigShellRouter.swift');
/** RigShellScripts.separator: between the config line and each file. */
export const SEPARATOR = '\n;\n';

/** The shell's script files in injection order (RigShellScripts: `*.js`, sorted by name). @returns {string[]} */
export function shellFiles() {
  return fs.readdirSync(SHELL_DIR).filter((n) => n.endsWith('.js')).sort();
}

/**
 * The whole document-start script for `config` (what Swift injects after the self-test hook).
 * @param {{platform?:string, menuOwnsShortcuts?:boolean, keepsAwake?:boolean}} [config]
 * @returns {string}
 */
export function documentStartScript(config = { platform: 'macos', menuOwnsShortcuts: false, keepsAwake: false }) {
  const parts = [`window.__rigShellConfig = ${JSON.stringify(config)};`];
  for (const n of shellFiles()) parts.push(`// ${n}\n${fs.readFileSync(path.join(SHELL_DIR, n), 'utf8')}`);
  return parts.join(SEPARATOR);
}

/**
 * A fake rigShell handler: `handlers[m](body)` answers (a value or a Promise); a missing method answers
 * {error:'unknown method m'} as RigShellRouter does; a handler that throws rejects (Swift's replyHandler(nil, msg)).
 * @param {Record<string, Function>} handlers
 * @returns {{postMessage(body:object):Promise<any>, calls:object[]}}
 */
export function fakeHandler(handlers = {}) {
  const calls = [];
  return {
    calls,
    postMessage(body) {
      calls.push(structuredClone(body));
      const fn = handlers[body && body.m];
      if (!fn) return Promise.resolve({ error: `unknown method ${body && body.m}` });
      try {
        return Promise.resolve(fn(body));
      } catch (e) {
        return Promise.reject(new Error(String((e && e.message) || e)));
      }
    },
  };
}

/**
 * Run the document-start script in a fresh vm context that stands in for the page's window.
 * @param {{config?:object, handlers?:Record<string, Function>, handler?:object|null, pre?:(win:object)=>void}} [o]
 *   handler: null = no rigShell handler at all; pre: runs before the script (e.g. a window.rig that is not ours)
 * Values made inside the context have its own Object.prototype: compare them through `plain()`.
 * @returns {{win:object, handler:object|null, run:()=>void, warns:any[][]}}
 */
export function loadShell({ config, handlers, handler, pre } = {}) {
  const h = handler === null ? null : handler || fakeHandler(handlers);
  const warns = [];
  const win = { console: { warn: (...a) => warns.push(a), error: (...a) => warns.push(a), log: () => {} } };
  if (h) win.webkit = { messageHandlers: { rigShell: h } };
  win.window = win;
  const ctx = vm.createContext(win);
  if (pre) pre(win);
  const src = documentStartScript(config);
  const run = () => vm.runInContext(src, ctx, { filename: 'native-shell-document-start.js' });
  run();
  return { win, handler: h, run, warns };
}

/** A JSON copy (drops the vm realm's prototypes, so deepStrictEqual compares shapes). @param {*} v */
export const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
