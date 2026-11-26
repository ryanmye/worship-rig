// Lane E5 (1.x → 2.0 library migration): fixtures, a deep diff, and JS stand-ins for the two disk-backup hosts.
//   electronHost(dir)   main.js's contract (rig:backupNow / rig:latestBackup): rotation rig-YYYYMMDD-HHMMSS[-n].json,
//                       newest BACKUPS_KEEP = 10; rig-unreadable-*.json newest 5; newest by mtime, then name.
//   nativeShell({...})  RigLibrary.swift's contract (RigBackups + RigLibrary): the window.rig polyfill
//                       {isElectron:false, platform, backupNow, latestBackup, onMenu} + __rigShell.menu; own rotation
//                       newest 10 (lane F1, O-AW-F1) / unreadable 5; latestBackup = a staged file once, else the
//                       newest of our own and the Electron backups that parses as a library (lane F1:
//                       `RigBackups.isLibrary`; truncated, newer-schema and non-library files are skipped); the macOS
//                       first-launch offer (pristine probe, the answer remembered); the picker / AirDrop stage
//                       (JSON-parsed first, as `stage(fileURL:)`).
// Both write real files in a temp dir, with an explicit, increasing mtime so "newest" is deterministic.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../../..');
export const FIX = path.join(ROOT, 'test/fixtures/library-1x');

/** @returns {{ref:string, commit:string, scenarios:object}[]} */
export function manifests() {
  return fs.readdirSync(FIX, { withFileTypes: true }).filter((d) => d.isDirectory())
    .map((d) => JSON.parse(fs.readFileSync(path.join(FIX, d.name, 'manifest.json'), 'utf8')));
}

/** Fixture text (gunzipped when the file is .gz). @param {string} ref @param {string} file e.g. 'rich.backup.json' */
export function fixture(ref, file) {
  const p = path.join(FIX, ref, file);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  return zlib.gunzipSync(fs.readFileSync(`${p}.gz`)).toString('utf8');
}

/** Every (ref, scenario, form) with its text. form: 'backup' | 'export' | 'localstorage'. */
export function allFixtures() {
  const out = [];
  for (const m of manifests()) {
    for (const [name, sc] of Object.entries(m.scenarios)) {
      for (const form of ['backup', 'export', 'localstorage']) {
        if (!sc.files[form]) continue;
        out.push({ ref: m.ref, name, form, sc, text: fixture(m.ref, `${name}.${form}.json`) });
      }
    }
  }
  return out;
}

/** Leaf-level differences between two JSON values: ['a.b.c: <old> -> <new>', …]. */
export function jsonDiff(a, b, p = '', out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const obj = (v) => v !== null && typeof v === 'object';
  if (obj(a) && obj(b) && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) jsonDiff(a[k], b[k], p ? `${p}.${k}` : k, out);
  } else out.push(`${p}: ${JSON.stringify(a)?.slice(0, 90)} -> ${JSON.stringify(b)?.slice(0, 90)}`);
  return out;
}

export const plain = (v) => JSON.parse(JSON.stringify(v));
export const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `rig-e5-${tag}-`));

const ROTATION_RE = /^rig-\d{8}-\d{6}(-\d+)?\.json$/;
let clock = Date.UTC(2026, 10, 1) / 1000; // seconds; every write is one second newer than the last
function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
/** Write a file with the next mtime (also how a test drops a 1.x backup into a folder). */
export function writeAged(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  clock += 1;
  fs.utimesSync(file, clock, clock);
  return file;
}
/** A rotation name for "now" in `dir` (counter suffix as main.js L-5 / RigBackups.write). */
export function rotationName(dir) {
  const s = stamp(new Date((clock + 1) * 1000));
  let f = path.join(dir, `rig-${s}.json`);
  for (let i = 1; fs.existsSync(f); i++) f = path.join(dir, `rig-${s}-${i}.json`);
  return f;
}
function list(dir, prefix = null) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => (prefix ? n.startsWith(prefix) && n.endsWith('.json') : ROTATION_RE.test(n)))
    .map((n) => ({ path: path.join(dir, n), name: n, mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((x, y) => y.mtime - x.mtime || y.name.localeCompare(x.name));
}
function rotate(dir, prefix, keep) {
  for (const e of list(dir, prefix).slice(keep)) fs.rmSync(e.path);
}
/** All files in a folder → {name: text} (to prove a folder was left untouched). */
export function snapshot(dir) {
  try {
    return Object.fromEntries(fs.readdirSync(dir).sort().map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]));
  } catch {
    return {};
  }
}

/** main.js (Electron) backups, as the renderer sees them through preload's window.rig. */
export function electronHost(dir, { keep = 10, fail = null } = {}) {
  const calls = [];
  const rig = {
    isElectron: true,
    platform: 'darwin',
    onMenu: () => () => {},
    async backupNow(json, kind = 'library') {
      calls.push(['backupNow', kind]);
      if (fail) return { error: fail };
      const text = typeof json === 'string' ? json : JSON.stringify(json);
      if (!text || text.length > 50 * 1024 * 1024) return { error: 'backup too large or empty' };
      if (kind === 'unreadable') {
        const f = writeAged(path.join(dir, `rig-unreadable-${stamp(new Date())}-${calls.length}.json`), text);
        rotate(dir, 'rig-unreadable-', 5);
        return { path: f };
      }
      const f = writeAged(rotationName(dir), text);
      rotate(dir, null, keep);
      return { path: f };
    },
    async latestBackup() {
      calls.push(['latestBackup']);
      const e = list(dir)[0];
      if (!e) return { error: 'no backup found' };
      const text = fs.readFileSync(e.path, 'utf8');
      const m = /^\{"origin":"([^"]+)"/.exec(text.slice(0, 200));
      return { path: e.path, origin: m ? m[1] : null, savedAt: e.mtime, text };
    },
  };
  return { rig, calls, list: () => list(dir), dir };
}

/**
 * RigLibrary.swift in JS. `electronDirs` stand in for ~/Library/Application Support/<any>/backups (RIG_ELECTRON_BACKUPS);
 * iPad: pass none. `confirm(title, message) => boolean` answers the native dialogs.
 */
export function nativeShell({ ownDir, electronDirs = [], platform = 'darwin', confirm = () => true, defaults = new Map() }) {
  let staged = null;
  const menu = [];
  const calls = [];
  const dialogs = [];
  const KEY = 'rig.electronImportAnswered.v1';
  // Swift does not wait for the page; the tests do (`settled` = every handler's result for the last menu id)
  const shell = {
    settled: Promise.resolve([]),
    menu(id) {
      shell.settled = Promise.all(menu.slice().map((cb) => cb(id)));
    },
    menuReady: () => menu.length > 0,
  };
  const newerFirst = (x, y) => y.mtime - x.mtime || y.name.localeCompare(x.name); // RigBackups.newerFirst
  const electronEntries = () => electronDirs.flatMap((d) => list(d)).sort(newerFirst);
  /** RigBackups.isLibrary (lane F1, review E5 open item 3): a JSON object that is a whole library, schema <= 2. */
  const isLibrary = (text) => {
    let o;
    try {
      o = JSON.parse(text);
    } catch {
      return false;
    }
    if (!o || typeof o !== 'object' || Array.isArray(o) || o.kind === 'song') return false;
    if (!((o.songs && typeof o.songs === 'object') || o.kind === 'library')) return false;
    return !('schema' in o) || (typeof o.schema === 'number' && Number.isFinite(o.schema) && o.schema <= 2);
  };
  const payload = (e) => {
    const buf = fs.readFileSync(e.path);
    if (buf.length > 16 * 1024 * 1024) return null;
    const text = buf.toString('utf8');
    if (!isLibrary(text)) return null;
    const m = /^\{"origin":"([^"]+)"/.exec(text.slice(0, 200));
    return { path: e.path, origin: m ? m[1] : null, savedAt: e.mtime, text };
  };
  const latestAnywhere = () => {
    for (const e of [...list(ownDir), ...electronEntries()].sort(newerFirst)) {
      const p = payload(e);
      if (p) return p;
    }
    return { error: 'no backup found' };
  };
  const ask = (title, message) => {
    dialogs.push(title);
    return confirm(title, message);
  };
  const rig = {
    isElectron: false,
    platform,
    async backupNow(json, kind) {
      calls.push(['backupNow', kind === 'unreadable' ? 'unreadable' : 'library']);
      const text = typeof json === 'string' ? json : JSON.stringify(json);
      if (!text || Buffer.byteLength(text) > 16 * 1024 * 1024) return { error: 'backup too large or empty' };
      if (kind === 'unreadable') {
        const f = writeAged(path.join(ownDir, `rig-unreadable-${stamp(new Date())}-${calls.length % 1000}.json`), text);
        rotate(ownDir, 'rig-unreadable-', 5);
        return { path: f };
      }
      const f = writeAged(rotationName(ownDir), text);
      rotate(ownDir, null, 10); // RigBackups.keepLibrary (lane F1, O-AW-F1; was 3)
      return { path: f };
    },
    async latestBackup() {
      calls.push(['latestBackup']);
      if (staged) {
        const s = staged;
        staged = null;
        return s;
      }
      return latestAnywhere();
    },
    onMenu(cb) {
      if (typeof cb !== 'function') return () => {};
      menu.push(cb);
      return () => menu.splice(menu.indexOf(cb), 1);
    },
  };
  return {
    rig,
    shell,
    calls,
    dialogs,
    defaults,
    ownList: () => list(ownDir),
    /** macOS offerFirstLaunchImport → askIfPristine (readyProbe) → stageOfferedAndImport. @returns {Promise<string>} */
    async firstLaunch(store) {
      if (defaults.get(KEY)) return 'answered before';
      const newest = electronEntries().find((e) => payload(e)); // lane F1: the newest Electron library; staged below
      if (!newest) return 'no electron backup';
      if (!(store && shell.menuReady() && store.pristine === true)) return 'not pristine';
      const yes = ask('Import your Worship Rig library?', 'Found a library saved by the previous Worship Rig');
      defaults.set(KEY, true);
      if (!yes) return 'declined';
      // review F1: the file the offer dated, not latestAnywhere() (which also reads our own, maybe newer, rotation)
      const r = payload(newest) || { error: `${path.basename(newest.path)} is no longer a library` };
      if (r.error) return r.error;
      staged = r;
      shell.menu('importLatestBackup');
      return 'imported';
    },
    /** File › Import Library Backup… / the iPad Files picker / AirDrop "Open in" (handleOpen asks first). */
    pick(file, { openIn = false } = {}) {
      if (openIn && !ask('Import this library?', `${path.basename(file)} will replace the current library.`)) return 'declined';
      const text = fs.readFileSync(file, 'utf8');
      let obj;
      try {
        obj = JSON.parse(text);
      } catch {
        obj = null;
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        ask('Not a library file', `${path.basename(file)} is not a Worship Rig library backup.`);
        return 'not a library';
      }
      staged = { path: file, origin: typeof obj.origin === 'string' ? obj.origin : null, savedAt: Date.now(), text };
      shell.menu('importLatestBackup');
      return 'staged';
    },
  };
}
