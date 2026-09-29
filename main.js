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
// Menu-bar mode (L14, docs/menubar-mode.md "Electron side: as built"): a Tray icon whose menu is rebuilt from the bus
//   `state`, a frameless popover window (app/mini.html) under it, hide-on-close + dock hide on macOS while
//   `settings.menuBarMode` is on (mirrored here via setMenuBarMode and kept in rig-shell.json), an optional login item,
//   and the IPC relay for the bus (main renderer publishes state / receives commands; the popover subscribes / sends).
//   Launch with --hidden (or at login) to start with the main window hidden when menu-bar mode is on.
//
// Test/dev env overrides: RIG_APP_DIR, RIG_PORT, RIG_PADS_DIR, RIG_USER_DATA, RIG_RECORDINGS_DIR, RIG_USER_SAMPLES,
// RIG_SELFTEST=1 (collect console output + HTTP responses ≥ 400, read window.__RIG_SELFTEST__, print one JSON line, quit),
// RIG_SELFTEST_TIMEOUT_MS, RIG_DEBUG_PERMS=1 (log every permission request/check).

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, powerSaveBlocker, screen, session, shell } =
  require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');
const { createServer, userSamplesHome, KEY_HEADER } = require('./server.js');

const IS_MAC = process.platform === 'darwin';
const SELFTEST = process.env.RIG_SELFTEST === '1';
const PORT = Number(process.env.RIG_PORT) || 8438;
const APP_DIR = path.resolve(process.env.RIG_APP_DIR || path.join(__dirname, 'app'));
const BACKUPS_KEEP = 10;
// security S4: per-launch key the server requires on the personal-audio routes; only our window's requests carry it
const SERVER_KEY = crypto.randomBytes(24).toString('base64url');
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
  app.on('second-instance', () => showMain());
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

  registerMenuBarIpc();
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
// menu-bar mode (L14, docs/menubar-mode.md): Tray + popover + bus relay + hide-on-close
//
//   main renderer ──rig:busPublish(stateJson)──▶ main.js ──rig:miniState──▶ popover   (+ Tray menu rebuild)
//   popover       ──rig:miniCommand(cmdJson)───▶ main.js ──rig:busCommand─▶ main renderer (openMain: main.js itself)
//
// Payloads are JSON strings (the bus validates them again in the renderer); main.js checks type, size, JSON shape
// and the sender's origin (handle() → isOurFrame) and relays the validated object re-serialised.
const BUS_STATE_MAX = 64 * 1024;
const BUS_COMMAND_MAX = 4 * 1024;
const BUS_COMMANDS = new Set([
  'hello', 'selectMode', 'nextMode', 'prevMode', 'panic', 'fadeOutAll', 'master', 'droneToggle', 'droneKey',
  'lowResource', 'openMain', 'record',
]);
const POPOVER_W = 320;
const POPOVER_H = 440;
const TRAY_MODES_MAX = 12; // the popover shows ≤ 6; the menu can afford a few more
// build/trayTemplate{,@2x}.png (node build/make-tray-icon.mjs prints these). The two PNGs ship in the package
// (package.json build.files); these embedded copies are the fallback if they are ever missing.
const TRAY_ICON_1X =
  'iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAeklEQVR42mNgGAUkgN1A/BqIVaht8H8oTqC1wQZALENtg12g7OfUNjgB' +
  'iU8y0ADifihNVYM3QzVuprbB+6Ea9xNhcAoQf4fSVDUYXe0wMxg98n5D+RFQ/B8qhk0tSckNZFg7EHNAcTtUDJta+oPzSGFIKj4/IAaP' +
  'YAAAtKNvB/KDagIAAAAASUVORK5CYII=';
const TRAY_ICON_2X =
  'iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAYAAAAehFoBAAAA50lEQVR42u2YMRKCMBBFU1BacASOYJkj5AAUlpQU3sQDWFJQWHgAS45h' +
  'wRFyAAoLXGdSZHZWAWeii/4/86rPbF4RIGAMgiBI6ljiStyIM7HRLtwTY8RBu/DI6CAM4dfCjjgSeyLTLrxj3Um78EXoVQt3EF6QIrAK' +
  '4TZasNUu7IRFnWbhSli0+lfhmvCBWruwFTqrWXhqLoQhDGEIJxKeejV71jVR17DOL5ib7PBTEkPoenaiK6LfAEO4du7cZMfLR3Ji++Sb' +
  'LQtd/sZcRFVK4Yb6BF7Y67PyDVnpafK7wqvbEgiCIMbcAZDot5DEtCgGAAAAAElFTkSuQmCC';

let menuBarMode = false; // settings.menuBarMode, mirrored by the renderer (setMenuBarMode) and kept in rig-shell.json
let startHidden = false; // --hidden / opened at login, with menu-bar mode on: the main window starts hidden
/** @type {Tray|null} */
let tray = null;
/** @type {Menu|null} the Tray menu (built even where there is no Tray, so the self-test can read it) */
let trayMenu = null;
let trayMenuKey = '';
/** @type {BrowserWindow|null} */
let popover = null;
let popoverHiddenAt = 0;
let popoverSentSeq = 0;
const popoverLog = []; // 'show' | 'hide' transitions (self-test)
let busState = null; // last published state (parsed)
let busStateJson = null;
let busSeq = 0;
/** @type {((wc: Electron.WebContents, source: string) => void)|null} set by installSelftest */
let selftestWatch = null;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Popover position: centred under the tray icon, 4 px below it, clamped to the display's work area.
 * @param {{x:number,y:number,width:number,height:number}|null} trayBounds  null/empty → top-right of the work area
 * @param {{x:number,y:number,width:number,height:number}} workArea
 * @returns {{x:number, y:number, width:number, height:number}}
 */
function popoverBounds(trayBounds, workArea, w = POPOVER_W, h = POPOVER_H) {
  const wa = workArea;
  const b = trayBounds && trayBounds.width > 0 ? trayBounds : null;
  const x = b ? Math.round(b.x + b.width / 2 - w / 2) : wa.x + wa.width - w - 8;
  const y = b ? Math.round(b.y + b.height + 4) : wa.y + 4;
  return { x: clamp(x, wa.x, wa.x + wa.width - w), y: clamp(y, wa.y, wa.y + wa.height - h), width: w, height: h };
}

/**
 * Parse and validate a bus message (state or command) sent as a JSON string.
 * @returns {object} the parsed message; throws with a short reason otherwise
 */
function parseBusJson(json, max) {
  if (typeof json !== 'string') throw new Error('expected a JSON string');
  if (json.length > max) throw new Error(`message too large (${json.length} > ${max})`);
  let o;
  try {
    o = JSON.parse(json);
  } catch {
    throw new Error('invalid JSON');
  }
  if (!o || typeof o !== 'object' || Array.isArray(o) || o.v !== 1) throw new Error('expected an object with v:1');
  return o;
}

const isStr = (s, max = 200) => typeof s === 'string' && s.length > 0 && s.length <= max;

/** docs/menubar-mode.md `state`: checks the parts main.js reads (current, modes, lowResource). @returns {object} */
function validateBusState(o) {
  const c = o.current;
  if (c != null && (typeof c !== 'object' || !isStr(c.id) || typeof c.name !== 'string')) {
    throw new Error('state.current must be null or {id, name, key}');
  }
  if (!Array.isArray(o.modes) || o.modes.some((m) => !m || !isStr(m.id) || typeof m.name !== 'string')) {
    throw new Error('state.modes must be an array of {id, name, key, index}');
  }
  return o;
}

/** docs/menubar-mode.md `command`. @returns {object} */
function validateBusCommand(o) {
  if (!BUS_COMMANDS.has(o.type)) throw new Error(`unknown command type ${JSON.stringify(String(o.type)).slice(0, 40)}`);
  const bool = (k) => {
    if (typeof o[k] !== 'boolean') throw new Error(`${o.type}.${k} must be a boolean`);
  };
  if (o.type === 'selectMode' && !isStr(o.id)) throw new Error('selectMode.id must be a non-empty string');
  if (o.type === 'master' && !(typeof o.value === 'number' && o.value >= 0 && o.value <= 2)) {
    throw new Error('master.value must be a number 0..2');
  }
  if (o.type === 'droneKey' && !(Number.isInteger(o.pc) && o.pc >= 0 && o.pc <= 11)) {
    throw new Error('droneKey.pc must be an integer 0..11');
  }
  if (o.type === 'lowResource' || o.type === 'record') bool('on');
  return o;
}

/** Relay a validated command to the main renderer; `openMain` is handled here. @returns {{ok:true}|{error}} */
function sendBusCommand(cmd) {
  if (cmd.type === 'openMain') {
    showMain();
    return { ok: true };
  }
  if (!win || win.isDestroyed()) return { error: 'main window not ready' };
  win.webContents.send('rig:busCommand', JSON.stringify(cmd));
  return { ok: true };
}

function sendToPopover() {
  if (!popover || popover.isDestroyed() || !busStateJson || popoverSentSeq >= busSeq) return;
  popoverSentSeq = busSeq;
  popover.webContents.send('rig:miniState', busStateJson, busSeq);
}

function publishBusState(json, state) {
  busState = state;
  busStateJson = json;
  busSeq += 1;
  // a hidden popover gets the newest state when it is shown (fewer wake-ups while idle)
  if (popover && !popover.isDestroyed() && popover.isVisible()) sendToPopover();
  refreshTrayMenu();
}

const oneLine = (s, max = 80) => String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);
const modeLabel = (m) => {
  const name = oneLine(m.name) || 'Untitled';
  return m.key ? `${name}  (${oneLine(m.key, 8)})` : name;
};

function trayCommand(cmd) {
  const r = sendBusCommand(cmd);
  if (r.error) log('tray command', cmd.type, r.error);
  refreshTrayMenu(true); // a radio/checkbox flips locally on click: show the real state until the next publish
}

/** Tray menu template from the bus state (null → the renderer has not published yet). */
function trayMenuTemplate(s) {
  const cur = s && s.current;
  const modes = s ? s.modes.slice(0, TRAY_MODES_MAX) : [];
  const ready = !!s;
  const nowLabel = !s ? 'Worship Rig is starting…' : cur ? `Now: ${modeLabel(cur)}` : 'No song selected';
  return [
    { id: 'current', label: nowLabel, enabled: false },
    ...(appMemoryMB ? [{ id: 'memory', label: `Memory: ${appMemoryMB} MB`, enabled: false }] : []),
    { type: 'separator' },
    ...modes.map((m) => ({
      id: `mode:${m.id}`,
      label: modeLabel(m),
      type: 'radio',
      checked: !!cur && m.id === cur.id,
      click: () => trayCommand({ v: 1, type: 'selectMode', id: m.id }),
    })),
    ...(modes.length ? [{ type: 'separator' }] : []),
    { id: 'prev', label: 'Previous', enabled: ready, click: () => trayCommand({ v: 1, type: 'prevMode' }) },
    { id: 'next', label: 'Next', enabled: ready, click: () => trayCommand({ v: 1, type: 'nextMode' }) },
    { id: 'panic', label: 'Panic (all notes off)', enabled: ready, click: () => trayCommand({ v: 1, type: 'panic' }) },
    { type: 'separator' },
    {
      id: 'lowResource',
      label: 'Low-resource mode',
      type: 'checkbox',
      checked: !!(s && s.lowResource),
      enabled: ready,
      click: (item) => trayCommand({ v: 1, type: 'lowResource', on: !!item.checked }),
    },
    { type: 'separator' },
    { id: 'openMain', label: 'Open Worship Rig', click: () => showMain() },
    { id: 'quit', label: 'Quit Worship Rig', click: () => app.quit() },
  ];
}

/** Rebuild the Tray menu when the parts it shows changed (state is published up to 4×/s). */
function refreshTrayMenu(force = false) {
  if (!menuBarMode) return;
  const s = busState;
  const brief = (m) => m && [m.id, m.name, m.key];
  appMemoryMB = appMemory();
  const modes = s && s.modes.slice(0, TRAY_MODES_MAX).map(brief);
  const key = JSON.stringify(s ? [brief(s.current), modes, !!s.lowResource, appMemoryMB] : null);
  if (!force && trayMenu && key === trayMenuKey) return;
  trayMenuKey = key;
  trayMenu = Menu.buildFromTemplate(trayMenuTemplate(s));
  if (tray && !tray.isDestroyed()) {
    const cur = s && s.current;
    tray.setToolTip(cur ? `Worship Rig: ${modeLabel(cur)}` : 'Worship Rig');
  }
}

let appMemoryMB = 0;
/** RSS of the main process + renderers (app.getAppMetrics, KB → MB), rounded to 5 MB so the menu rebuilds rarely. */
function appMemory() {
  try {
    const kb = app.getAppMetrics()
      .filter((m) => m.type === 'Browser' || m.type === 'Tab')
      .reduce((sum, m) => sum + ((m.memory && m.memory.workingSetSize) || 0), 0);
    return Math.round(kb / 1024 / 5) * 5;
  } catch {
    return 0;
  }
}

function trayImage() {
  // createFromPath picks up @2x and marks *Template files as template images; the embedded copy is the fallback
  const file = path.join(__dirname, 'build', 'trayTemplate.png');
  let img = fs.existsSync(file) ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
  if (img.isEmpty()) {
    img = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_1X, 'base64'), { scaleFactor: 1 });
    img.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(TRAY_ICON_2X, 'base64') });
  }
  img.setTemplateImage(true);
  return img;
}

// v1 is macOS only (docs/menubar-mode.md "Not in v1": the Windows/Linux tray); the menu and popover work everywhere
function ensureTray() {
  if (!IS_MAC || (tray && !tray.isDestroyed())) return;
  tray = new Tray(trayImage());
  tray.setToolTip('Worship Rig');
  tray.on('click', (e) => {
    if (e && (e.ctrlKey || e.metaKey)) popUpTrayMenu();
    else togglePopover();
  });
  tray.on('right-click', () => popUpTrayMenu());
}

function popUpTrayMenu() {
  refreshTrayMenu();
  if (tray && !tray.isDestroyed() && trayMenu) {
    hidePopover();
    tray.popUpContextMenu(trayMenu);
  }
}

function destroyTray() {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
  trayMenu = null;
  trayMenuKey = '';
}

function createPopover() {
  popover = new BrowserWindow({
    width: POPOVER_W,
    height: POPOVER_H,
    show: false,
    frame: false,
    transparent: true, // rounded corners come from mini.css
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    title: 'Worship Rig',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // no audio in the popover: let Chromium throttle it while hidden
    },
  });
  const p = popover;
  const wc = p.webContents;
  p.setAlwaysOnTop(true, 'pop-up-menu');
  // show on the current Space (and over full-screen apps) instead of switching back to the Space it was last shown on
  if (IS_MAC) p.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  wc.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target) && !originOk(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, target) => {
    if (!originOk(target)) e.preventDefault();
  });
  wc.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') hidePopover();
  });
  wc.on('did-finish-load', () => drivePlaceholder(wc));
  // show/hide bookkeeping lives in showPopover/hidePopover: on macOS the window 'show'/'hide' events follow the
  // occlusion state, so they don't fire while the screen is locked or the window is covered
  p.on('blur', () => hidePopover());
  p.on('closed', () => {
    if (popover === p) popover = null;
    popoverSentSeq = 0;
  });
  if (selftestWatch) selftestWatch(wc, 'popover');
  wc.loadURL(`${ourOrigin()}/mini.html`);
  return p;
}

function showPopover() {
  if (!popover || popover.isDestroyed()) createPopover();
  const b = tray && !tray.isDestroyed() ? tray.getBounds() : null;
  const display =
    b && b.width ? screen.getDisplayMatching(b) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  popover.setBounds(popoverBounds(b, display.workArea));
  popover.show();
  popover.focus();
  popoverLog.push('show');
  sendToPopover();
  notifyMenuBarState();
}

function hidePopover() {
  if (!popover || popover.isDestroyed() || !popover.isVisible()) return;
  popover.hide();
  popoverLog.push('hide');
  popoverHiddenAt = Date.now();
  notifyMenuBarState();
}

function togglePopover() {
  if (popover && !popover.isDestroyed() && popover.isVisible()) {
    hidePopover();
    return;
  }
  // the click on the tray icon blurred (and so hid) the popover a moment ago: that click meant "close"
  if (Date.now() - popoverHiddenAt < 300) return;
  showPopover();
}

/**
 * TEMPORARY (until the cloud's app/mini.html + views/mini.js land): the placeholder page can't carry a script (the CSP
 * forbids inline scripts and only app/mini.html is ours to add), so main.js drives it. Only runs on a page with
 * <meta name="rig-mini-placeholder"> (the cloud's mini.html has none, so it is never touched); it creates no bus,
 * it only calls window.rig.miniSubscribe / miniCommand. Delete this function once the real popover UI is in the tree.
 */
function drivePlaceholder(wc) {
  const code = `(() => {
    if (!document.querySelector('meta[name="rig-mini-placeholder"]') || window.__rigMiniDriven) return false;
    window.__rigMiniDriven = true;
    const $ = (id) => document.getElementById(id);
    window.rig.miniSubscribe((json) => {
      let s;
      try { s = JSON.parse(json); } catch { return; }
      const c = s.current;
      $('now').textContent = c ? c.name + (c.key ? ' · ' + c.key : '') : 'No song selected';
      $('modes').textContent = (s.modes || []).map((m) => (c && m.id === c.id ? '▸ ' : '  ') + m.name).join('\\n');
      $('raw').textContent = JSON.stringify(s, null, 1);
    });
    for (const b of document.querySelectorAll('button[data-cmd]')) {
      b.addEventListener('click', () => window.rig.miniCommand(JSON.stringify({ v: 1, type: b.dataset.cmd })));
    }
    window.rig.miniCommand(JSON.stringify({ v: 1, type: 'hello' }));
    return true;
  })()`;
  wc.executeJavaScript(code, true).catch(() => {});
}

function menuBarStateSnapshot() {
  let loginItem = false;
  try {
    loginItem = !!app.getLoginItemSettings().openAtLogin;
  } catch {
    /* unsupported platform */
  }
  return {
    on: menuBarMode,
    popoverOpen: !!(popover && !popover.isDestroyed() && popover.isVisible()),
    loginItem,
    windowVisible: !!(win && !win.isDestroyed() && win.isVisible()),
    tray: !!(tray && !tray.isDestroyed()),
    // reviews/for-local.md L-14 hook 1 names these two as well
    menuBarMode,
    windowDestroyed: !win || win.isDestroyed(),
  };
}

/** Push {on, popoverOpen, loginItem, windowVisible, tray} to both renderers (window.rig.onMenuBarState). */
function notifyMenuBarState() {
  const snap = menuBarStateSnapshot();
  for (const w of [win, popover]) if (w && !w.isDestroyed()) w.webContents.send('rig:menuBarState', snap);
}

/**
 * Dock icon on/off (macOS). Only acts on a change: a redundant dock.show() leaves a promise that can resolve after a
 * later hide() (seen while the screen is locked) and bring the icon back.
 */
function setDock(visible) {
  if (!IS_MAC || !app.dock || app.dock.isVisible() === visible) return;
  if (visible) app.dock.show().catch(() => {});
  else app.dock.hide();
}

let lastWindowEvent = null;
/**
 * Menu-bar mode: tell the main renderer when its window is shown/hidden, on the Rig menu channel (onMenu ids
 * `windowShown` / `windowHidden`; `rig:window-visible` goes out at the same moments, even with the mode off). With
 * backgroundThrottling off, visibilitychange may never fire. The popover opening
 * does not count as "shown". `windowFollowDocument` (mode turned off) hands the decision back to the document.
 * @param {'windowShown'|'windowHidden'|'windowFollowDocument'} id
 */
function sendWindowEvent(id, force = false) {
  if (id !== 'windowFollowDocument') sendWindowVisible(id === 'windowShown', force);
  if (!force && (id === lastWindowEvent || (!menuBarMode && id !== 'windowFollowDocument'))) return;
  lastWindowEvent = id;
  sendMenu(id);
}

let lastVisibleSent = null;
/**
 * IPC `rig:window-visible` (preload → DOM CustomEvent 'rig:window-visible' {detail:{visible}}) on every visibility
 * change of the main window, whatever menuBarMode is (the renderer ignores it when it doesn't need it). Deduped.
 */
function sendWindowVisible(visible, force = false) {
  if ((!force && visible === lastVisibleSent) || !win || win.isDestroyed()) return;
  lastVisibleSent = visible;
  win.webContents.send('rig:window-visible', visible);
}
// ⌘H hides the whole app: win.isVisible() stays true then, so app.isHidden() has to be asked too (macOS)
const appHidden = () => IS_MAC && typeof app.isHidden === 'function' && app.isHidden();
const windowShownNow = () => !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && !appHidden());

/**
 * The renderer calls setMenuBarMode(on) at start and on every change: the single source of truth for the tray
 * (only while on), the dock icon (hidden while on and the window is hidden) and the window events above.
 */
function applyMenuBarMode(on) {
  const next = !!on;
  if (next !== menuBarMode) writeShellConfig({ menuBarMode: next });
  menuBarMode = next;
  if (next) {
    ensureTray();
    refreshTrayMenu(true);
    setDock(windowShownNow());
    sendWindowEvent(windowShownNow() ? 'windowShown' : 'windowHidden', true); // the renderer is listening now
  } else {
    destroyTray();
    if (popover && !popover.isDestroyed()) popover.destroy();
    if (win && !win.isDestroyed() && !win.isVisible()) showMain(); // never leave a hidden window without a way back
    else setDock(true);
    sendWindowEvent('windowFollowDocument', true);
    sendWindowVisible(windowShownNow(), true); // the renderer is listening: give it the current state either way
  }
  notifyMenuBarState();
  return menuBarStateSnapshot();
}

/** Show + focus the main window (tray "Open Worship Rig", openMain, dock click, second launch). */
function showMain() {
  hidePopover();
  if (!win || win.isDestroyed()) return;
  setDock(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  sendWindowEvent('windowShown');
  notifyMenuBarState();
}

/** macOS + menu-bar mode: closing the window hides it; audio keeps running and the library is backed up (M5). */
function hideMainToMenuBar() {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  win.hide();
  setDock(false);
  sendWindowEvent('windowHidden');
  notifyMenuBarState();
  const q = '(() => { try { const s = window.__rigShell; return s ? s.library() : null; } catch (e) { return null; } })()';
  withTimeout(wc.executeJavaScript(q, true).catch(() => null), 1500)
    .then((lib) => (typeof lib === 'string' && lib.length > 2 ? backupNow(lib) : null))
    .catch((err) => log('backup on hide:', err && err.message));
}

function registerMenuBarIpc() {
  handle('rig:busPublish', async (event, json) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return { error: 'only the main window publishes' };
    const state = validateBusState(parseBusJson(json, BUS_STATE_MAX));
    publishBusState(json, state);
    return { ok: true, seq: busSeq };
  });
  handle('rig:miniCommand', async (_e, json) => sendBusCommand(validateBusCommand(parseBusJson(json, BUS_COMMAND_MAX))));
  handle('rig:miniLastState', async () => (busStateJson ? { json: busStateJson, seq: busSeq } : null));
  handle('rig:setMenuBarMode', async (_e, on) => {
    if (typeof on !== 'boolean') return { error: 'expected a boolean' };
    return applyMenuBarMode(on);
  });
  handle('rig:getMenuBarState', async () => menuBarStateSnapshot());
  // preload routes a page's window.close() here (L-14), so it emits 'close' like the close button does
  handle('rig:closeWindow', async (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w && !w.isDestroyed()) w.close();
    return { ok: true };
  });
  handle('rig:setLoginItem', async (_e, on) => {
    if (typeof on !== 'boolean') return { error: 'expected a boolean' };
    // from source, the login item would be the bare Electron binary (it opens Electron's default app, not the rig)
    if (!app.isPackaged) return { error: 'Open at login needs the packaged app (npm run build:mac)' };
    if (!IS_MAC && process.platform !== 'win32') return { error: 'not supported on this platform' };
    app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true });
    notifyMenuBarState();
    return menuBarStateSnapshot();
  });
}

/** Started from the login item (openAsHidden) or with --hidden. Best effort: macOS 13+ deprecates the login flags. */
function launchedHidden() {
  if (process.argv.includes('--hidden')) return true;
  try {
    const s = app.getLoginItemSettings();
    return !!(s.wasOpenedAsHidden || s.wasOpenedAtLogin);
  } catch {
    return false;
  }
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
  // S4: add the per-launch key to requests for our own origin (never to other hosts)
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    if (!originOk(details.url)) return callback({});
    callback({ requestHeaders: { ...details.requestHeaders, [KEY_HEADER]: SERVER_KEY } });
  });
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
  // menu-bar mode launched hidden (login item / --hidden): the page loads and plays, the window stays in the menu bar
  win.once('ready-to-show', () => win && !startHidden && win.show());
  // also covers ⌘H / minimise; on macOS show/hide follow occlusion, so showMain/hideMainToMenuBar send them as well
  win.on('show', () => {
    sendWindowEvent('windowShown');
    notifyMenuBarState();
  });
  win.on('hide', () => {
    sendWindowEvent('windowHidden');
    notifyMenuBarState();
  });
  win.on('focus', () => sendWindowEvent('windowShown'));
  // a reloaded page starts without our last state: send the next change even if it repeats
  wc.on('did-navigate', () => {
    lastVisibleSent = null;
  });
  win.on('minimize', () => sendWindowEvent('windowHidden'));
  win.on('restore', () => sendWindowEvent('windowShown'));
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
    // L14: menu-bar mode on macOS: the close button / ⌘W hide the window (audio keeps running); only an explicit
    // Quit (tray, app menu, ⌘Q → before-quit sets `quitting`) goes on to the recording check + backup below
    if (IS_MAC && menuBarMode && !quitting && closeStage === 'open') {
      e.preventDefault();
      hideMainToMenuBar();
      return;
    }
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
    // the popover alone must not keep the app alive (window-all-closed → quit)
    if (popover && !popover.isDestroyed()) popover.destroy();
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
    if (!win.isVisible()) showMain(); // quitting from the tray while hidden: the sheet needs a visible window
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
  // L14: the popover's console counts too (selftestWatch is called from createPopover)
  selftestWatch = (w, source) => {
    w.on('console-message', (e, lvl, msg) => {
      const level = typeof e.level === 'string' ? e.level : LEVELS[e.level ?? lvl] || String(lvl);
      const message = e.message ?? msg;
      if (level === 'error') counts.error += 1;
      if (level === 'warning') counts.warning += 1;
      consoleLog.push({ level, message: String(message).slice(0, 500), ...(source ? { source } : {}) });
    });
  };
  selftestWatch(wc, null);
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
      if (r) {
        const menubar = await withTimeout(menubarSelftest(wc), 20000, { error: 'menubar self-test timed out' })
          .catch((err) => ({ error: (err && err.message) || String(err) }));
        return finish({ result: JSON.parse(r), menubar }, 0);
      }
    } catch {
      /* page not ready yet */
    }
    if (Date.now() - started > timeoutMs) return finish({ result: null, timeout: true }, 2);
    setTimeout(poll, 250);
  };
  wc.on('did-fail-load', (_e, code, desc) => finish({ result: null, loadError: `${code} ${desc}` }, 3));
  wc.once('did-finish-load', () => setTimeout(poll, 100));
}

/**
 * L14 self-test (RIG_SELFTEST=1): menu-bar mode end to end through the real IPC paths. The fixture page calls the
 * bridge (setMenuBarMode, onBusCommand, busPublish) via executeJavaScript; the popover loads /mini.html and uses
 * miniSubscribe / miniCommand; tray menu items are clicked like a user would. Reported as `menubar` in the JSON line.
 */
async function menubarSelftest(wc) {
  const out = { platform: process.platform };
  const js = (w, code) => withTimeout(w.executeJavaScript(code, true), 5000, { error: 'executeJavaScript timeout' });
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await fn()) return true;
      await settle(50);
    }
    return false;
  };
  // the fake state and the commands below would reach a real controller (electron-full's probe runs the real app):
  // only the shell fixture page (no window.__rig) runs this part
  if (await js(wc, '!!window.__rig')) return { skipped: 'real app page (window.__rig): runs on the shell fixture only' };
  // the page's own L-14 step (hideOnClose, last in the fixture) leaves menu-bar mode on and the window hidden: start
  // from mode off + window shown, as a fresh launch would
  out.pageLeft = menuBarStateSnapshot();
  if (menuBarMode || !win.isVisible()) {
    applyMenuBarMode(false);
    await waitFor(() => win.isVisible());
    await settle(300);
  }
  out.before = await js(wc, 'window.rig.getMenuBarState()');
  await js(wc, `window.__mbMenu = []; window.rig.onMenu((id) => window.__mbMenu.push(id));
    window.__mbVisible = [];
    window.addEventListener('rig:window-visible', (e) => window.__mbVisible.push(e.detail && e.detail.visible));
    true`);
  const menuEvents = async () => {
    await settle(150);
    return js(wc, 'window.__mbMenu.splice(0)');
  };
  out.setMenuBarMode = await js(wc, 'window.rig.setMenuBarMode(true)');
  out.eventsOnEnable = await menuEvents();
  out.tray = !!(tray && !tray.isDestroyed());
  out.shellConfig = readShellConfig().menuBarMode === true;
  out.menuBeforeState = trayMenu ? trayMenu.items.filter((i) => i.type !== 'separator').map((i) => i.label) : null;
  await js(wc, "window.__mbCmds = []; window.rig.onBusCommand((j) => window.__mbCmds.push(JSON.parse(j))); true");
  const fake = {
    v: 1,
    current: { id: 'st-2', name: 'Selftest Pad + Piano', key: 'D' },
    modes: [
      { id: 'st-1', name: 'Selftest Opener', key: 'G', index: 0 },
      { id: 'st-2', name: 'Selftest Pad + Piano', key: 'D', index: 1 },
      { id: 'st-3', name: 'Selftest Closer', key: 'E', index: 2 },
    ],
    master: 0.5, masterDb: -6, droneOn: true, droneKey: 'D', audio: 'running', latencyMs: 12,
    midi: { connected: false, name: null }, lowResource: true, recording: false, windowVisible: true, memoryMB: 100,
  };
  const pub = (o) => js(wc, `window.rig.busPublish(${JSON.stringify(typeof o === 'string' ? o : JSON.stringify(o))})`);
  out.publish = await pub(fake);
  out.menu = trayMenu.items.filter((i) => i.type !== 'separator').map((i) => ({
    label: i.label, type: i.type, checked: i.checked, enabled: i.enabled,
  }));
  // invalid payloads are refused and do not replace the state
  const big = JSON.stringify({ ...fake, pad: 'x'.repeat(70 * 1024) });
  const cmd = (w, o) => js(w, `window.rig.miniCommand(${JSON.stringify(typeof o === 'string' ? o : JSON.stringify(o))})`);
  out.rejects = {
    publishTooBig: (await pub(big)).error,
    publishNotJson: (await pub('{nope')).error,
    publishNoModes: (await pub({ v: 1, current: null })).error,
    commandUnknown: (await cmd(wc, { v: 1, type: 'formatDisk' })).error,
    commandBadMaster: (await cmd(wc, { v: 1, type: 'master', value: 9 })).error,
    commandWrongVersion: (await cmd(wc, { v: 2, type: 'panic' })).error,
  };
  out.stateKept = JSON.parse(busStateJson).current.id === 'st-2';
  // tray menu clicks → commands in the main renderer
  trayMenu.getMenuItemById('mode:st-3').click();
  trayMenu.getMenuItemById('next').click();
  trayMenu.getMenuItemById('lowResource').click(); // MenuItem.click() flips a checkbox first, like a user click
  await waitFor(async () => (await js(wc, 'window.__mbCmds.length')) >= 3);
  out.trayCommands = await js(wc, 'window.__mbCmds.splice(0)');
  // popover: open (the tray-click path), receive the state, send a command, Esc closes, toggle again
  togglePopover();
  out.popoverShown = await waitFor(() => !!(popover && popover.isVisible()));
  const pw = popover.webContents;
  await waitFor(() => !pw.isLoading(), 8000);
  out.popoverUrl = pw.getURL();
  out.popoverState = await js(pw, `new Promise((res) => {
    const off = window.rig.miniSubscribe((j) => { off(); res(JSON.parse(j).current.name); });
    setTimeout(() => res(null), 3000);
  })`);
  out.popoverBridgeState = await js(pw, 'window.rig.getMenuBarState()');
  out.popoverCommand = await cmd(pw, { v: 1, type: 'prevMode' });
  await waitFor(async () => js(wc, "window.__mbCmds.some((c) => c.type === 'prevMode')"));
  out.popoverCommands = await js(wc, 'window.__mbCmds.splice(0)');
  out.placeholderText = await js(pw, "(document.getElementById('now') || {}).textContent || null");
  const b = popover.getBounds();
  out.popoverSize = [b.width, b.height];
  pw.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  out.popoverHiddenByEsc = await waitFor(() => !popover.isVisible());
  await settle(350); // past the blur/click debounce
  togglePopover();
  const reopened = await waitFor(() => popover.isVisible());
  togglePopover();
  out.popoverToggled = reopened && (await waitFor(() => !popover.isVisible()));
  out.popoverTransitions = popoverLog.slice();
  out.eventsDuringPopover = await menuEvents(); // opening the popover is not "shown"
  // hide-on-close (macOS): the window hides instead of closing, the dock icon goes away, a library backup is written;
  // openMain brings window and dock icon back
  if (IS_MAC) {
    // the fixture page has no controller: stand in for its __rigShell so backup-on-hide has a library to save
    await js(wc, `window.__rigShell = window.__rigShell || { recording: () => false, library: () => '{"hideBackup":1}' };
      true`);
    const backups = () => fs.readdirSync(backupsDir()).map((f) => path.join(backupsDir(), f));
    const before = new Set(backups());
    await js(wc, 'window.__mbVisible.length = 0; true');
    const isHideBackup = (f) => !before.has(f) && fs.readFileSync(f, 'utf8') === '{"hideBackup":1}';
    win.close();
    await waitFor(() => !win.isVisible());
    out.hideOnClose = { destroyed: win.isDestroyed(), visible: win.isVisible(), dock: app.dock.isVisible() };
    out.hideBackup = await waitFor(() => backups().some(isHideBackup));
    out.eventsOnHide = await menuEvents();
    out.openMain = await cmd(pw, { v: 1, type: 'openMain' });
    await waitFor(() => win.isVisible());
    out.afterOpenMain = { visible: win.isVisible(), dock: app.dock.isVisible() };
    out.eventsOnOpenMain = await menuEvents();
    out.windowVisible = await js(wc, 'window.__mbVisible.slice()'); // DOM CustomEvent details, hide → openMain
  } else {
    out.hideOnClose = 'macOS only';
  }
  out.after = await js(wc, 'window.rig.getMenuBarState()');
  out.setMenuBarModeOff = await js(wc, 'window.rig.setMenuBarMode(false)');
  out.trayAfterOff = !!(tray && !tray.isDestroyed());
  out.eventsOnDisable = await menuEvents();
  // minimise → restore with menu-bar mode OFF: rig:window-visible still fires (rig:menu events don't). The
  // minimise may not happen on a locked screen / headless CI: `minimizeObserved` says whether it did.
  await js(wc, 'window.__mbVisible.length = 0; true');
  win.minimize();
  out.minimizeObserved = await waitFor(() => win.isMinimized(), 3000);
  win.restore();
  await waitFor(() => !win.isMinimized(), 3000);
  out.windowVisibleMinimize = await js(wc, 'new Promise((r) => setTimeout(() => r(window.__mbVisible.slice()), 300))');
  out.eventsOnMinimize = await menuEvents();
  // ⌘H: app.hide() → app.show() (macOS). Needs an unlocked screen / a window server: `appHideObserved` says whether
  // the hide took effect (app.isHidden()).
  if (IS_MAC) {
    await js(wc, 'window.__mbVisible.length = 0; true');
    app.hide();
    out.appHideObserved = await waitFor(() => app.isHidden(), 3000);
    app.show();
    await waitFor(() => !app.isHidden(), 3000);
    out.windowVisibleAppHide = await js(wc, 'new Promise((r) => setTimeout(() => r(window.__mbVisible.slice()), 300))');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  quitting = true;
});

// dock icon click / Finder re-open while the window is hidden in the menu bar
app.on('activate', () => showMain());

// ⌘H / "Hide Worship Rig" (macOS app-level hide): the window stays "visible" to Electron and fires no window events,
// so without these the page never hears it is hidden and nothing throttles. 'show' only counts when the window
// itself is up (not hidden to the menu bar, not minimised).
app.on('hide', () => sendWindowEvent('windowHidden'));
app.on('show', () => {
  if (windowShownNow()) sendWindowEvent('windowShown');
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
  server = createServer({ appDir: APP_DIR, port: PORT, log, reuse: false, portTries: 20, userSamples: true, secret: SERVER_KEY });
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
  // L14: known before the renderer boots (it mirrors settings.menuBarMode via setMenuBarMode on start)
  menuBarMode = !!cfg.menuBarMode && !SELFTEST;
  startHidden = menuBarMode && launchedHidden();
  if (menuBarMode) {
    ensureTray();
    refreshTrayMenu(true);
    if (startHidden) setDock(false);
  }
  powerBlockId = powerSaveBlocker.start('prevent-display-sleep');
  createWindow(`http://127.0.0.1:${serverInfo.port}/`);
});

module.exports = {
  sanitizeFileName, stamp, openExclusive, fixWavSizes,
  popoverBounds, parseBusJson, validateBusState, validateBusCommand,
};
