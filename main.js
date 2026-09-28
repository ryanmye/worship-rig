'use strict';
// Worship Rig — Electron main process (SPEC §7, REVIEW 1.5, 1.8, 1.16, 1.17, 2.3).
// Serves app/ from server.js on http://127.0.0.1:8438/ (fixed port → stable localStorage origin),
// loads it in a sandboxed window, allows MIDI, keeps the Mac awake, and provides IPC for
// recording streams, pad folders and auto-backups.
//
// M5: Electron always runs its OWN server (never reuses another process's): 8438 if free, else the next free port.
//   The library lives in localStorage per origin, so on another port it looks empty: a dialog explains it and offers
//   to import the newest disk backup, and every window close writes a library backup (tagged with its origin) so the
//   other port's library can always be imported back. Nothing about the port is persisted.
// M6: recording streams are closed with sizes fixed from the file on navigation/reload, renderer crash, destroy and
//   quit; closeStream always re-derives the RIFF/data sizes from the real file size.
// L3: a renderer that keeps crashing (3× in 60 s) gets a Reload / Quit / Open Backups dialog instead of a loop.
// L4: recording files are created exclusively ('wx+', " 2", " 3" … on collision); only dialog-approved paths overwrite.
// L10: closing/quitting (or reloading) while recording asks first.
// My Samples (shell-3): the server scans <repo>/user-samples and ~/Music/Worship Rig/Samples (RIG_USER_SAMPLES
//   overrides) for GarageBand/user sample packs; Rig menu → Open My Samples Folder / Rescan My Samples.
//
// Test/dev env overrides: RIG_APP_DIR, RIG_PORT, RIG_PADS_DIR, RIG_USER_DATA, RIG_RECORDINGS_DIR, RIG_USER_SAMPLES,
// RIG_SELFTEST=1 (collect console output + HTTP responses ≥ 400, read window.__RIG_SELFTEST__, print one JSON line, quit),
// RIG_SELFTEST_TIMEOUT_MS, RIG_DEBUG_PERMS=1 (log every permission request/check).

const { app, BrowserWindow, Menu, dialog, ipcMain, powerSaveBlocker, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { createServer, userSamplesHome } = require('./server.js');

const IS_MAC = process.platform === 'darwin';
const SELFTEST = process.env.RIG_SELFTEST === '1';
const PORT = Number(process.env.RIG_PORT) || 8438;
const APP_DIR = path.resolve(process.env.RIG_APP_DIR || path.join(__dirname, 'app'));
const BACKUPS_KEEP = 10;
const BACKUP_MAX_BYTES = 50 * 1024 * 1024;

if (process.env.RIG_USER_DATA) app.setPath('userData', path.resolve(process.env.RIG_USER_DATA));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

/** @type {BrowserWindow|null} */
let win = null;
let server = null;
let serverInfo = null;
let powerBlockId = null;
let quitting = false;
let closeStage = 'open'; // 'open' | 'finishing' | 'done' (L10 / M5 backup on close)
const crashTimes = [];
const CRASH_WINDOW_MS = 60000;
const CRASH_MAX = 3;
const UNREADABLE_KEEP = 5;

const recordingsDir = () => path.resolve(process.env.RIG_RECORDINGS_DIR || path.join(app.getPath('music'), 'Worship Rig'));
const backupsDir = () => path.join(app.getPath('userData'), 'backups');
const shellConfigPath = () => path.join(app.getPath('userData'), 'rig-shell.json');

function log(...a) {
  console.log('[worship-rig]', ...a);
}

// ---------------------------------------------------------------------------------------------
// single instance
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

// ---------------------------------------------------------------------------------------------
// small persisted shell config (pad folder survives restarts without a dialog)
function readShellConfig() {
  try {
    return JSON.parse(fs.readFileSync(shellConfigPath(), 'utf8')) || {};
  } catch {
    return {};
  }
}
function writeShellConfig(patch) {
  const next = { ...readShellConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(shellConfigPath()), { recursive: true });
    fs.writeFileSync(shellConfigPath(), JSON.stringify(next, null, 2));
  } catch (err) {
    log('could not save shell config:', err.message);
  }
}

// ---------------------------------------------------------------------------------------------
// recording streams (fs.open 'w+' so the header can be re-patched in place — REVIEW 1.8)
/** @type {Map<number, {fh: import('fs/promises').FileHandle, path:string, pos:number, chain:Promise<any>, owner:number}>} */
const streams = new Map();
let nextStreamId = 1;
const approvedPaths = new Set();

function sanitizeFileName(name) {
  const base = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/^\.+/, '').trim().slice(0, 180);
  return base || 'Rig recording.wav';
}

/**
 * Create a new file exclusively (never truncates an existing take): p, "p 2", "p 3", … (L4).
 * @returns {Promise<{fh: import('fs/promises').FileHandle, path: string}>}
 */
async function openExclusive(p) {
  const ext = path.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const cand = i === 1 ? p : `${stem} ${i}${ext}`;
    try {
      return { fh: await fsp.open(cand, 'wx+'), path: cand };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  const last = `${stem} ${Date.now()}${ext}`;
  return { fh: await fsp.open(last, 'wx+'), path: last };
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('expected ArrayBuffer');
}

/** Patch RIFF/data sizes from the real file size (used when a stream is closed without a final header). */
async function fixWavSizes(fh) {
  const st = await fh.stat();
  if (st.size < 44) return;
  const hdr = Buffer.alloc(44);
  await fh.read(hdr, 0, 44, 0);
  if (hdr.toString('ascii', 0, 4) !== 'RIFF' || hdr.toString('ascii', 36, 40) !== 'data') return;
  const data = Math.min(st.size - 44, 0xffffffff - 36);
  hdr.writeUInt32LE(36 + data, 4);
  hdr.writeUInt32LE(data, 40);
  await fh.write(hdr, 0, 44, 0);
}

async function closeStream(id) {
  const s = streams.get(id);
  if (!s) return { error: 'unknown stream' };
  streams.delete(id);
  try {
    await s.chain.catch(() => {});
    await fixWavSizes(s.fh).catch(() => {}); // M6: the file size is authoritative, whatever the renderer patched
    await s.fh.sync().catch(() => {});
    const st = await s.fh.stat();
    await s.fh.close();
    return { path: s.path, bytes: st.size };
  } catch (err) {
    return { error: err.message };
  }
}

async function closeAllStreams(filter = () => true) {
  const ids = [...streams.entries()].filter(([, s]) => filter(s)).map(([id]) => id);
  await Promise.all(ids.map((id) => closeStream(id)));
}

// ---------------------------------------------------------------------------------------------
// backups
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const BACKUP_RE = /^rig-\d{8}-\d{6}(-\d+)?\.json$/;

/**
 * @param {string|object} json
 * @param {'library'|'unreadable'} [kind]  'unreadable' = the raw text of a library the app could not read (H1);
 *        kept separately (rig-unreadable-*.json, newest 5) so the rotation never deletes it
 */
async function backupNow(json, kind = 'library') {
  const text = typeof json === 'string' ? json : JSON.stringify(json);
  if (!text || text.length > BACKUP_MAX_BYTES) return { error: 'backup too large or empty' };
  const dir = backupsDir();
  await fsp.mkdir(dir, { recursive: true });
  if (kind === 'unreadable') {
    const file = path.join(dir, `rig-unreadable-${stamp()}-${Date.now() % 1000}.json`);
    await fsp.writeFile(file, text);
    const old = (await fsp.readdir(dir)).filter((f) => f.startsWith('rig-unreadable-')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - UNREADABLE_KEEP))) await fsp.unlink(path.join(dir, f)).catch(() => {});
    return { path: file };
  }
  // L-5: a counter, not Date.now() % 1000, so two backups in the same millisecond never overwrite each other
  const s = stamp();
  let file = path.join(dir, `rig-${s}.json`);
  for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `rig-${s}-${i}.json`);
  await fsp.writeFile(file, text);
  const names = (await fsp.readdir(dir)).filter((f) => BACKUP_RE.test(f));
  const all = await Promise.all(names.map(async (f) => ({ f, t: (await fsp.stat(path.join(dir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
  all.sort((a, b) => a.t - b.t || a.f.localeCompare(b.f));
  for (const { f } of all.slice(0, Math.max(0, all.length - BACKUPS_KEEP))) await fsp.unlink(path.join(dir, f)).catch(() => {});
  return { path: file };
}

/** Newest library backup (rotation files only). @returns {Promise<{path, origin, savedAt}|null>} */
async function newestBackup() {
  const dir = backupsDir();
  let names;
  try {
    names = (await fsp.readdir(dir)).filter((f) => BACKUP_RE.test(f));
  } catch {
    return null;
  }
  const all = await Promise.all(names.map(async (f) => ({ f, t: (await fsp.stat(path.join(dir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
  all.sort((a, b) => b.t - a.t || b.f.localeCompare(a.f));
  if (!all.length) return null;
  const file = path.join(dir, all[0].f);
  let origin = null;
  try {
    const fh = await fsp.open(file, 'r');
    const head = Buffer.alloc(200);
    const { bytesRead } = await fh.read(head, 0, 200, 0);
    await fh.close();
    const m = /^\{"origin":"([^"]+)"/.exec(head.toString('utf8', 0, bytesRead));
    origin = m ? m[1] : null;
  } catch {
    /* unreadable head: no origin */
  }
  return { path: file, origin, savedAt: all[0].t };
}

/** M5: the newest backup came from another origin (port) → its library is newer than what this origin shows. */
async function otherLibrary() {
  const b = await newestBackup();
  return b && b.origin && b.origin !== ourOrigin() ? b : null;
}

// ---------------------------------------------------------------------------------------------
// IPC — every handler resolves; failures resolve to {error}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isOurFrame(event)) return { error: 'forbidden' };
    try {
      const r = await fn(event, ...args);
      return r === undefined ? null : r;
    } catch (err) {
      log(`${channel} failed:`, err && err.message);
      return { error: (err && err.message) || String(err) };
    }
  });
}

function ourOrigin() {
  return `http://127.0.0.1:${serverInfo ? serverInfo.port : PORT}`;
}

function isOurFrame(event) {
  try {
    const url = (event.senderFrame && event.senderFrame.url) || event.sender.getURL();
    return url.startsWith(ourOrigin() + '/') || url === ourOrigin();
  } catch {
    return false;
  }
}

function registerIpc() {
  handle('rig:saveFileDialog', async (_e, defaultName) => {
    const dir = recordingsDir();
    await fsp.mkdir(dir, { recursive: true });
    const r = await dialog.showSaveDialog(win, {
      title: 'Save recording',
      defaultPath: path.join(dir, sanitizeFileName(defaultName || 'Rig recording.wav')),
      filters: [{ name: 'WAV audio', extensions: ['wav'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (r.canceled || !r.filePath) return null;
    approvedPaths.add(path.resolve(r.filePath));
    return { path: r.filePath };
  });

  handle('rig:streamOpen', async (event, p) => {
    let target;
    let fh;
    const raw = String(p || '');
    if (path.isAbsolute(raw)) {
      target = path.resolve(raw);
      const inRec = target.startsWith(recordingsDir() + path.sep);
      const approved = approvedPaths.has(target);
      if (!approved && !inRec) return { error: 'path not allowed (use saveFileDialog first)' };
      approvedPaths.delete(target);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      if (approved) fh = await fsp.open(target, 'w+'); // the user confirmed overwriting in the save dialog
      else ({ fh, path: target } = await openExclusive(target));
    } else {
      // bare file name → default recordings folder, never overwrite
      await fsp.mkdir(recordingsDir(), { recursive: true });
      ({ fh, path: target } = await openExclusive(path.join(recordingsDir(), sanitizeFileName(path.basename(raw)))));
    }
    const id = nextStreamId++;
    streams.set(id, { fh, path: target, pos: 0, chain: Promise.resolve(), owner: event.sender.id });
    return { id, path: target };
  });

  handle('rig:streamWrite', async (_e, id, data) => {
    const s = streams.get(id);
    if (!s) return { error: 'unknown stream' };
    const buf = toBuffer(data);
    const pos = s.pos;
    s.pos += buf.length; // positions assigned in arrival order
    s.chain = s.chain.then(() => s.fh.write(buf, 0, buf.length, pos));
    await s.chain;
    return { bytes: s.pos };
  });

  handle('rig:streamPatchHeader', async (_e, id, data) => {
    const s = streams.get(id);
    if (!s) return { error: 'unknown stream' };
    const buf = toBuffer(data);
    if (buf.length !== 44) return { error: 'header must be 44 bytes' };
    s.chain = s.chain.then(() => s.fh.write(buf, 0, 44, 0));
    await s.chain;
    return { ok: true };
  });

  handle('rig:streamClose', async (_e, id) => closeStream(id));

  handle('rig:choosePadFolder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose your pad folder',
      message: 'Pick the folder that holds your pad audio files (one file per key).',
      properties: ['openDirectory'],
      defaultPath: server.padsRoot || app.getPath('music'),
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    const res = server.setPadsRoot(r.filePaths[0]);
    writeShellConfig({ padsRoot: res.path });
    return { path: res.path, baseUrl: res.baseUrl };
  });

  handle('rig:listPads', async () => {
    const list = await server.listPads();
    if (Array.isArray(list)) return list;
    return list; // {error:'missing'}
  });

  handle('rig:padsBaseUrl', async () => server.padsBaseUrl());

  handle('rig:backupNow', async (_e, json, kind) => backupNow(json, kind === 'unreadable' ? 'unreadable' : 'library'));

  handle('rig:latestBackup', async () => {
    const b = await newestBackup();
    if (!b) return { error: 'no backup found' };
    return { ...b, text: await fsp.readFile(b.path, 'utf8') };
  });

  handle('rig:getInfo', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    userData: app.getPath('userData'),
    port: serverInfo ? serverInfo.port : PORT,
    preferredPort: PORT,
    portChanged: !!(serverInfo && serverInfo.port !== PORT),
    reusedServer: false, // M5: Electron never reuses another server
    otherLibrary: await otherLibrary().catch(() => null),
    padsRoot: server ? server.padsRoot : null,
    userSamplesDir: userSamplesHome(),
    userSampleRoots: server ? server.userSampleRoots : [],
    recordingsDir: recordingsDir(),
    backupsDir: backupsDir(),
  }));

  handle('rig:openFolder', async (_e, kind) => {
    if (kind === 'userSamples') return openUserSamplesFolder();
    const dir = kind === 'backups' ? backupsDir() : kind === 'pads' ? server.padsRoot : recordingsDir();
    if (!dir) return { error: 'no folder' };
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    const err = await shell.openPath(dir);
    return err ? { error: err } : { ok: true };
  });

  handle('rig:userSamplesDir', async () => {
    const dir = userSamplesHome();
    return { path: dir, exists: fs.existsSync(dir), roots: server ? server.userSampleRoots : [] };
  });

  handle('rig:openUserSamplesFolder', async () => openUserSamplesFolder());

  handle('rig:rescanUserSamples', async () => {
    const r = await server.rescanUserSamples();
    return { count: r.count, instruments: r.instruments.map((i) => ({ id: i.id, name: i.name || i.id, pack: i.pack })), packs: r.packs, roots: r.roots, errors: r.errors };
  });

  handle('rig:openDoc', async (_e, name) => openDoc(name));

  handle('rig:revealFile', async (_e, p) => {
    const target = path.resolve(String(p || ''));
    if (!target.startsWith(recordingsDir() + path.sep) && !fs.existsSync(target)) return { error: 'not found' };
    shell.showItemInFolder(target);
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------------------------
// My Samples folder
const USER_SAMPLES_README = [
  'Worship Rig — My Samples',
  '',
  'Each sub-folder here is one sample pack: <pack>/manifest.json plus its audio files (same format as',
  'app/samples/manifest.json). Packs appear in the instrument picker under "My Samples" (ids "user:<id>").',
  '',
  'GarageBand / Logic instruments on this Mac can be converted into this folder with',
  '  node tools/import-garageband.mjs --list      (see docs/garageband-import.md)',
  '',
  'These files are for your own use on this Mac: never share them or add them to the app.',
  'After adding or removing packs: Rig menu → Rescan My Samples (or restart Worship Rig).',
  '',
].join('\n');

async function openUserSamplesFolder() {
  const dir = userSamplesHome();
  const existed = fs.existsSync(dir);
  await fsp.mkdir(dir, { recursive: true });
  if (!existed) await fsp.writeFile(path.join(dir, 'README.txt'), USER_SAMPLES_README).catch(() => {});
  const err = await shell.openPath(dir);
  return err ? { error: err, path: dir } : { ok: true, path: dir };
}

// ---------------------------------------------------------------------------------------------
// menu
function sendMenu(id) {
  if (win && !win.isDestroyed()) win.webContents.send('rig:menu', id);
}

async function openReadme() {
  const src = path.join(__dirname, 'README.md');
  try {
    const text = await fsp.readFile(src, 'utf8'); // works inside app.asar
    const dest = path.join(app.getPath('temp'), 'Worship Rig README.md');
    await fsp.writeFile(dest, text);
    const err = await shell.openPath(dest);
    if (err) log('open README:', err);
  } catch (err) {
    log('README not found:', err.message);
  }
}

/** Open a bundled doc (docs/<name>.md, or 'readme') in the Mac's default app for .md files. */
async function openDoc(name) {
  const n = String(name || '');
  if (!/^[a-z0-9-]{1,64}$/.test(n)) return { error: 'unknown doc' };
  if (n === 'readme') {
    await openReadme();
    return { ok: true };
  }
  const src = path.join(__dirname, 'docs', `${n}.md`);
  const text = await fsp.readFile(src, 'utf8'); // works inside app.asar; throws → {error}
  const dest = path.join(app.getPath('temp'), `Worship Rig ${n}.md`);
  await fsp.writeFile(dest, text);
  const err = await shell.openPath(dest);
  return err ? { error: err } : { ok: true };
}

async function confirmImportBackup() {
  const b = await newestBackup();
  if (!win || win.isDestroyed()) return;
  if (!b) {
    dialog.showMessageBox(win, { type: 'info', message: 'No library backup found yet.', detail: `Backups are written to ${backupsDir()} while you use Worship Rig.` });
    return;
  }
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Import', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Replace the library with the latest backup?',
    detail: `${path.basename(b.path)} (${new Date(b.savedAt).toLocaleString()}${b.origin ? `, from ${b.origin}` : ''}). The current library is backed up first; device settings are kept.`,
  });
  if (r.response === 0) sendMenu('importLatestBackup');
}

function buildMenu() {
  const rig = {
    label: 'Rig',
    submenu: [
      { label: 'Panic (all notes off)', accelerator: 'CmdOrCtrl+.', click: () => sendMenu('panic') },
      { label: 'Fade Out All', accelerator: 'CmdOrCtrl+Shift+F', click: () => sendMenu('fadeOutAll') },
      { type: 'separator' },
      // registerAccelerator:false → the renderer handles ⌘←/⌘→ itself, so text fields keep their arrows (REVIEW 1.17)
      { label: 'Next Song', accelerator: 'CmdOrCtrl+Right', registerAccelerator: false, click: () => sendMenu('nextSong') },
      { label: 'Previous Song', accelerator: 'CmdOrCtrl+Left', registerAccelerator: false, click: () => sendMenu('prevSong') },
      { type: 'separator' },
      { label: 'Perform / Edit', accelerator: 'CmdOrCtrl+E', click: () => sendMenu('toggleView') },
      { label: 'Record', accelerator: 'CmdOrCtrl+R', click: () => sendMenu('record') },
      { type: 'separator' },
      { label: 'Restart Audio', click: () => sendMenu('restartAudio') },
      { type: 'separator' },
      { label: 'Open My Samples Folder', click: () => openUserSamplesFolder().catch((err) => log('open My Samples:', err.message)) },
      { label: 'Rescan My Samples', click: () => sendMenu('rescanUserSamples') },
      { type: 'separator' },
      { label: 'Import Latest Backup…', click: () => confirmImportBackup() },
    ],
  };
  const template = [
    ...(IS_MAC
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('openSettings') },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : [{ label: 'File', submenu: [{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('openSettings') }, { role: 'quit' }] }]),
    { role: 'editMenu' },
    rig,
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Reload Window', click: () => win && win.webContents.reload() }, // recording → will-prevent-unload asks
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Open README', click: () => openReadme() },
        { label: 'Importing GarageBand Sounds', click: () => openDoc('garageband-import').catch((err) => log('open doc:', err.message)) },
        { label: 'Open Recordings Folder', click: () => fsp.mkdir(recordingsDir(), { recursive: true }).then(() => shell.openPath(recordingsDir())) },
        { label: 'Open Backups Folder', click: () => fsp.mkdir(backupsDir(), { recursive: true }).then(() => shell.openPath(backupsDir())) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------------------------
// permissions: MIDI + output-device selection; everything else denied.
// NOTE (verified on Electron 44.4.5): Chromium now gates ALL Web MIDI behind the sysex permission, so
// requestMIDIAccess({sysex:false}) arrives here as 'midiSysex'. Denying it blocks MIDI entirely. The renderer still
// never asks for sysex messages (midi.js requests {sysex:false}); only our own origin is allowed.
const ALLOW_REQUEST = new Set(['midi', 'midiSysex', 'speaker-selection', 'fullscreen', 'clipboard-sanitized-write']);

function originOk(url) {
  return typeof url === 'string' && (url.startsWith(ourOrigin() + '/') || url === ourOrigin());
}

function installPermissions(ses) {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && (details.requestingUrl || details.securityOrigin)) || (wc && wc.getURL());
    if (process.env.RIG_DEBUG_PERMS) log('perm request', permission, url, JSON.stringify(details));
    callback(ALLOW_REQUEST.has(permission) && originOk(url));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const url = requestingOrigin || (details && details.requestingUrl) || (wc && wc.getURL());
    if (process.env.RIG_DEBUG_PERMS) log('perm check', permission, url, JSON.stringify(details));
    if (!originOk(url)) return false;
    if (ALLOW_REQUEST.has(permission)) return true;
    // audio-output device labels in enumerateDevices(); no capture is ever started by the app
    if (permission === 'media' && (!details || !details.mediaType || details.mediaType === 'audio')) return true;
    return false;
  });
}

// ---------------------------------------------------------------------------------------------
// window
function createWindow(url) {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Worship Rig',
    backgroundColor: '#0e1014',
    show: false,
    // L-12 (ux-round2 G8): standard title bar. 'hiddenInset' put the traffic lights on the top bar's logo and left no
    // drag area; restore it only together with a CSS inset + -webkit-app-region: drag on the top bar.
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  const wc = win.webContents;
  win.once('ready-to-show', () => win && win.show());
  wc.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target) && !originOk(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, target) => {
    if (!originOk(target)) {
      e.preventDefault();
      if (/^https?:\/\//.test(target)) shell.openExternal(target);
    }
  });
  const wcId = wc.id;
  const ownStreams = (s) => s.owner === wcId;
  wc.on('render-process-gone', (_e, details) => {
    log('renderer gone:', details.reason);
    closeAllStreams(ownStreams).catch(() => {});
    if (quitting || SELFTEST || details.reason === 'clean-exit') return;
    onRendererCrash();
  });
  // M6: a reload / navigation abandons the page's streams: finish them now (sizes fixed from the file)
  wc.on('did-start-navigation', (e, _url, isInPlace, isMainFrame) => {
    const main = e && typeof e.isMainFrame === 'boolean' ? e.isMainFrame : isMainFrame;
    const same = e && typeof e.isSameDocument === 'boolean' ? e.isSameDocument : isInPlace;
    if (main && !same && [...streams.values()].some(ownStreams)) closeAllStreams(ownStreams).catch(() => {});
  });
  wc.on('destroyed', () => closeAllStreams(ownStreams).catch(() => {}));
  // L10: the page's beforeunload blocks unload while recording (Electron would silently refuse to close/reload)
  wc.on('will-prevent-unload', (e) => {
    if (closeStage === 'done' || SELFTEST) {
      e.preventDefault(); // already confirmed
      return;
    }
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Stop Recording', 'Keep Recording'],
      defaultId: 1,
      cancelId: 1,
      message: 'A recording is in progress.',
      detail: 'Continuing stops the recording; everything recorded so far is kept.',
    });
    if (choice === 0) e.preventDefault();
    else quitting = false;
  });
  win.on('close', (e) => {
    if (closeStage === 'done' || SELFTEST) return;
    e.preventDefault();
    if (closeStage === 'finishing') return;
    closeStage = 'finishing';
    finishClose(wc)
      .catch((err) => {
        log('close:', err && err.message);
        return true;
      })
      .then((proceed) => {
        if (proceed) {
          closeStage = 'done';
          if (win && !win.isDestroyed()) win.close();
        } else {
          closeStage = 'open';
          quitting = false;
        }
      });
  });
  win.on('closed', () => {
    win = null;
  });
  if (serverInfo && serverInfo.port !== PORT && !SELFTEST) wc.once('did-finish-load', () => portChangedDialog());
  if (!SELFTEST) wc.once('did-finish-load', () => chromeWindowCheck().catch(() => {}));
  if (SELFTEST) installSelftest(wc);
  wc.loadURL(url);
}

function withTimeout(p, ms, fallback = null) {
  return Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);
}

/**
 * Before the window closes: ask the page whether it records and for its library (last backup, M5), confirm a
 * running recording (L10), then finish streams. @returns {Promise<boolean>} proceed with closing
 */
async function finishClose(wc) {
  const q = '(() => { const s = window.__rigShell; if (!s) return null; try { return { recording: !!s.recording(), library: s.library() }; } catch (e) { return null; } })()';
  const info = wc.isDestroyed() ? null : await withTimeout(wc.executeJavaScript(q, true).catch(() => null), 1500);
  const recording = !!(info && info.recording) || [...streams.values()].some((s) => s.owner === wc.id);
  if (recording && win && !win.isDestroyed()) {
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Stop Recording and Quit', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'A recording is in progress.',
      detail: 'Quitting stops the recording. Everything recorded so far is kept in your recordings folder.',
    });
    if (r.response !== 0) return false;
  }
  if (info && typeof info.library === 'string' && info.library.length > 2) await backupNow(info.library).catch(() => {});
  await closeAllStreams((s) => s.owner === wc.id);
  return true;
}

/** L3: reload after a crash, but stop looping after CRASH_MAX crashes within CRASH_WINDOW_MS. */
function onRendererCrash() {
  const t = Date.now();
  crashTimes.push(t);
  while (crashTimes.length && t - crashTimes[0] > CRASH_WINDOW_MS) crashTimes.shift();
  if (crashTimes.length < CRASH_MAX) {
    setTimeout(() => win && !win.isDestroyed() && win.webContents.reload(), 1000);
    return;
  }
  crashTimes.length = 0;
  if (!win || win.isDestroyed()) return;
  dialog
    .showMessageBox(win, {
      type: 'error',
      buttons: ['Reload', 'Open Backups Folder', 'Quit'],
      defaultId: 0,
      cancelId: 2,
      message: 'Worship Rig keeps crashing.',
      detail: 'The window crashed several times in a row. You can try again, look at your library backups, or quit.',
    })
    .then(({ response }) => {
      if (response === 0 && win && !win.isDestroyed()) win.webContents.reload();
      else if (response === 1) fsp.mkdir(backupsDir(), { recursive: true }).then(() => shell.openPath(backupsDir()));
      else app.quit();
    });
}

/** M5: the app is not on its usual port, so its usual library (localStorage of that origin) isn't visible. */
async function portChangedDialog() {
  if (!win || win.isDestroyed()) return;
  const busy = serverInfo.busyWithRig && serverInfo.busyWithRig.includes(PORT) ? 'another copy of Worship Rig (or its Chrome launcher)' : 'another program';
  const b = await newestBackup();
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: b ? ['Import Latest Backup', 'Continue'] : ['Continue'],
    defaultId: 0,
    cancelId: b ? 1 : 0,
    message: `Port ${PORT} is in use by ${busy}, so Worship Rig opened on port ${serverInfo.port}.`,
    detail:
      `Songs are saved per port, so the library you normally use isn't shown here. ` +
      (b ? `Import the latest backup (${new Date(b.savedAt).toLocaleString()}) to continue with it. ` : '') +
      `Quit whatever uses port ${PORT} and restart Worship Rig to get back to your usual library.`,
  });
  if (b && r.response === 0) sendMenu('importLatestBackup');
}

/**
 * L-11: the Chrome version (serve.mjs, :8437) is another origin in another browser, so the page's Web Lock can't see
 * it and both windows would play every note. Its page pings /api/heartbeat every 15 s; warn if one did recently.
 */
async function chromeWindowCheck() {
  const chromePort = Number(process.env.RIG_CHROME_PORT) || 8437;
  if (!server || !serverInfo || serverInfo.port === chromePort) return;
  const h = await server.checkHealth(chromePort);
  if (!h || !(typeof h.clientSeenMsAgo === 'number' && h.clientSeenMsAgo < 45000) || !win || win.isDestroyed()) return;
  log(`a Worship Rig window is open in Chrome (port ${chromePort}): both would play every note; warning shown`);
  await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['OK'],
    message: 'Worship Rig is also open in Google Chrome.',
    detail: 'Both windows play every note you play. Close the Chrome window of Worship Rig (and its Terminal window) before you play.',
  });
}

// ---------------------------------------------------------------------------------------------
// self-test (CI): count console errors, read window.__RIG_SELFTEST__, print one JSON line and quit
function installSelftest(wc) {
  const consoleLog = [];
  const httpErrors = [];
  const counts = { error: 0, warning: 0 };
  // integration #2: console-message carries only console API calls, not Chromium's "Failed to load resource" network
  // errors, so HTTP responses ≥ 400 from our own server are counted here as errors too
  wc.session.webRequest.onCompleted((d) => {
    if (d.statusCode >= 400 && originOk(d.url)) {
      counts.error += 1;
      httpErrors.push({ status: d.statusCode, url: d.url, method: d.method, resourceType: d.resourceType });
      consoleLog.push({ level: 'error', message: `HTTP ${d.statusCode} ${d.method} ${d.url}`.slice(0, 500), source: 'network' });
    }
  });
  const LEVELS = ['verbose', 'info', 'warning', 'error'];
  wc.on('console-message', (e, lvl, msg) => {
    const level = typeof e.level === 'string' ? e.level : LEVELS[e.level ?? lvl] || String(lvl);
    const message = e.message ?? msg;
    if (level === 'error') counts.error += 1;
    if (level === 'warning') counts.warning += 1;
    consoleLog.push({ level, message: String(message).slice(0, 500) });
  });
  const timeoutMs = Number(process.env.RIG_SELFTEST_TIMEOUT_MS) || 25000;
  const started = Date.now();
  let finished = false;
  const finish = async (result, code) => {
    if (finished) return;
    finished = true;
    const out = { ...result, consoleErrors: counts.error, consoleWarnings: counts.warning, httpErrors, console: consoleLog, url: wc.getURL(), port: serverInfo && serverInfo.port };
    process.stdout.write(`RIG_SELFTEST ${JSON.stringify(out)}\n`);
    quitting = true;
    await closeAllStreams();
    app.exit(code);
  };
  const poll = async () => {
    if (finished || wc.isDestroyed()) return;
    try {
      const r = await wc.executeJavaScript('window.__RIG_SELFTEST__ ? JSON.stringify(window.__RIG_SELFTEST__) : null', true);
      if (r) return finish({ result: JSON.parse(r) }, 0);
    } catch {
      /* page not ready yet */
    }
    if (Date.now() - started > timeoutMs) return finish({ result: null, timeout: true }, 2);
    setTimeout(poll, 250);
  };
  wc.on('did-fail-load', (_e, code, desc) => finish({ result: null, loadError: `${code} ${desc}` }, 3));
  wc.once('did-finish-load', () => setTimeout(poll, 100));
}

// ---------------------------------------------------------------------------------------------
app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', (e) => {
  if (powerBlockId !== null && powerSaveBlocker.isStarted(powerBlockId)) powerSaveBlocker.stop(powerBlockId);
  if (streams.size || server) {
    e.preventDefault();
    Promise.all([closeAllStreams(), server ? server.close() : null])
      .catch(() => {})
      .finally(() => {
        server = null;
        streams.clear();
        app.exit(0);
      });
  }
});

app.whenReady().then(async () => {
  if (!app.hasSingleInstanceLock()) return;
  // M5: always our own server; My Samples on (repo user-samples/ + ~/Music/Worship Rig/Samples, or RIG_USER_SAMPLES)
  server = createServer({ appDir: APP_DIR, port: PORT, log, reuse: false, portTries: 20, userSamples: true });
  const cfg = readShellConfig();
  const padsDir = process.env.RIG_PADS_DIR || cfg.padsRoot || null;
  if (padsDir) server.setPadsRoot(padsDir);
  try {
    serverInfo = await server.listen();
  } catch (err) {
    dialog.showErrorBox('Worship Rig could not start', `The local server could not start: ${err.message}`);
    app.exit(1);
    return;
  }
  if (serverInfo.port !== PORT) log(`port ${PORT} busy; using ${serverInfo.port} (songs saved on ${PORT} will not appear; a dialog offers the latest backup)`);
  installPermissions(session.defaultSession);
  registerIpc();
  buildMenu();
  powerBlockId = powerSaveBlocker.start('prevent-display-sleep');
  createWindow(`http://127.0.0.1:${serverInfo.port}/`);
});

module.exports = { sanitizeFileName, stamp, openExclusive, fixWavSizes };
