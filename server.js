'use strict';
// Worship Rig local HTTP server (SPEC §1, §7; REVIEW 1.5, 1.20).
// Used by BOTH main.js (Electron, port 8438) and serve.mjs (Chrome, port 8437).
// Static files from appDir with correct MIME + HTTP Range, /api/health, /api/pads, /pads/<token>/<rel>.
// Bound to 127.0.0.1 only; Host header checked (DNS-rebinding guard).
// HTML gets a Content-Security-Policy + X-Frame-Options: DENY (L7; dev fixtures under test/ are exempt, they use
// inline scripts). Pads: every served file must resolve (realpath) inside the chosen folder, so symlinks can't
// escape it; the listing skips escaping links, caps the walk, and is cached until a folder mtime changes (L6).
// /api/heartbeat: the Chrome page pings it; /api/health reports `clientSeenMsAgo` so serve.mjs knows whether a window
// is already open (H2). listen({reuse:false}) never reuses another process's server (Electron, M5).
// "My Samples" (shell-3, opt-in with createServer({userSamples})): GET /api/user-samples/manifest.json merges every
// <root>/<slug>/manifest.json (roots: <repo>/user-samples, then ~/Music/Worship Rig/Samples; RIG_USER_SAMPLES
// overrides) with layer dirs rewritten to /user-samples/<token>/<slug>/<dir>; always 200 (an empty list when nothing is
// there). /user-samples/<token>/<slug>/<file> serves audio only, realpath-checked inside the pack folder.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const APP_ID = 'worship-rig';
let VERSION = '0.0.0';
try {
  VERSION = require('./package.json').version || VERSION;
} catch {
  /* packaged builds may not ship package.json next to server.js */
}

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.caf': 'audio/x-caf',
  '.webm': 'audio/webm',
});

/** Audio file extensions listed by /api/pads. */
const PAD_EXTS = Object.freeze(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aiff', '.aif']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.aif', '.aiff', '.caf', '.webm']);
/** Audio served from "My Samples" packs (GarageBand conversions are .m4a/.wav; .caf/.aif as found). */
const USER_SAMPLE_EXTS = Object.freeze(['.mp3', '.wav', '.m4a', '.aac', '.caf', '.aif', '.aiff', '.flac', '.ogg', '.oga', '.opus', '.webm']);
const USER_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const USER_PACKS_MAX = 500;
/** API routes that are also answered under a path prefix (see handle()). */
const API_ROUTE_RE = /^\/api\/(health|heartbeat|pads|user-samples|user-samples\/manifest\.json)$/;
/** S4: routes that expose personal audio or its paths; they need the X-Rig-Key header when the server has a secret. */
const PRIVATE_ROUTE_RE = /^\/(api\/(pads|user-samples|user-samples\/manifest\.json)$|user-samples\/|pads\/)/;
const KEY_HEADER = 'x-rig-key';
const NO_CACHE_EXTS = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.webmanifest', '.map', '.md', '.txt']);
const PADS_MAX_DEPTH = 4;
const PADS_MAX_FILES = 2000;
const PADS_MAX_DIRS = 5000;

/** CSP for the app's HTML (mirrors app/index.html's meta policy; frame-ancestors only works as a header). */
const CSP = [
  "default-src 'self'",
  "script-src 'self' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "connect-src 'self' blob: data:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * @param {string} file
 * @returns {string} Content-Type
 */
function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * Parse a Range header against a file size (single range only).
 * @param {string|undefined} header
 * @param {number} size
 * @returns {null | {start:number, end:number} | {unsatisfiable:true}} null = serve the whole file (no/ignored Range)
 */
function parseRange(header, size) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const m = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!m) return null; // unknown unit → ignore (RFC 9110 §14.2)
  const spec = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  if (spec.length !== 1) return spec.length === 0 ? { unsatisfiable: true } : null; // multi-range → whole file
  const r = /^(\d*)-(\d*)$/.exec(spec[0]);
  if (!r || (r[1] === '' && r[2] === '')) return { unsatisfiable: true };
  let start;
  let end;
  if (r[1] === '') {
    const suffix = Number(r[2]);
    if (!(suffix > 0) || size === 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(r[1]);
    end = r[2] === '' ? size - 1 : Math.min(Number(r[2]), size - 1);
    if (!Number.isSafeInteger(start) || start >= size || Number(r[2] || start) < start) return { unsatisfiable: true };
  }
  return { start, end };
}

/**
 * Resolve a URL path inside a root; returns null on traversal / dotfile / NUL.
 * @param {string} root absolute
 * @param {string} urlPath already stripped of query, may be percent-encoded
 * @returns {string|null}
 */
function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segs = decoded.split('/').filter((s) => s.length > 0);
  for (const s of segs) if (s === '..' || s.startsWith('.')) return null;
  const abs = path.resolve(root, ...segs);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

function encodeRel(rel) {
  return rel.split(/[\\/]/).map(encodeURIComponent).join('/');
}

/** true when `real` is `rootReal` or inside it */
function within(rootReal, real) {
  return real === rootReal || real.startsWith(rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep);
}

/**
 * List pad files under root. Symlinks are followed only when they resolve inside root (L6); each real directory is
 * visited once; at most PADS_MAX_DIRS directories and PADS_MAX_FILES files.
 * @returns {Promise<{rels:string[], dirs:Map<string, number>}>} dirs: visited dir → mtimeMs (cache validation)
 */
async function walkPads(root) {
  const out = [];
  const dirs = new Map();
  let rootReal;
  try {
    rootReal = await fsp.realpath(root);
  } catch {
    return { rels: out, dirs };
  }
  const seen = new Set();
  async function walk(dir, relBase, depth) {
    if (depth > PADS_MAX_DEPTH || out.length >= PADS_MAX_FILES || dirs.size >= PADS_MAX_DIRS) return;
    let real;
    try {
      real = await fsp.realpath(dir);
    } catch {
      return;
    }
    if (!within(rootReal, real) || seen.has(real)) return;
    seen.add(real);
    let entries;
    try {
      const st = await fsp.stat(dir);
      dirs.set(dir, st.mtimeMs);
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const target = await fsp.realpath(abs);
          if (!within(rootReal, target)) continue; // escapes the pad folder
          const st = await fsp.stat(target);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) await walk(abs, rel, depth + 1);
      else if (isFile && PAD_EXTS.includes(path.extname(e.name).toLowerCase())) {
        out.push(rel);
        if (out.length >= PADS_MAX_FILES) return;
      }
    }
  }
  await walk(root, '', 0);
  return { rels: out, dirs };
}

/**
 * Default "My Samples" scan roots, in priority order (an id found in an earlier root wins).
 * RIG_USER_SAMPLES (path-delimiter separated) replaces them. The project-local folder is skipped inside app.asar.
 * @param {{repoRoot?:string, env?:object, home?:string}} [o]
 * @returns {string[]} absolute paths (they need not exist)
 */
function defaultUserSampleRoots({ repoRoot = __dirname, env = process.env, home = os.homedir() } = {}) {
  const over = env && typeof env.RIG_USER_SAMPLES === 'string' ? env.RIG_USER_SAMPLES.split(path.delimiter).map((s) => s.trim()).filter(Boolean) : [];
  if (over.length) return over.map((p) => path.resolve(p));
  const roots = [];
  if (repoRoot && !/\.asar([\\/]|$)/.test(repoRoot)) roots.push(path.join(repoRoot, 'user-samples'));
  roots.push(path.join(home, 'Music', 'Worship Rig', 'Samples'));
  return roots;
}

/**
 * The folder "Open My Samples Folder" shows and the GarageBand importer writes to by default: the first
 * RIG_USER_SAMPLES entry, else ~/Music/Worship Rig/Samples.
 */
function userSamplesHome({ env = process.env, home = os.homedir() } = {}) {
  const over = env && typeof env.RIG_USER_SAMPLES === 'string' ? env.RIG_USER_SAMPLES.split(path.delimiter).map((s) => s.trim()).filter(Boolean) : [];
  return over.length ? path.resolve(over[0]) : path.join(home, 'Music', 'Worship Rig', 'Samples');
}

/** A manifest-relative path (layer dir or file) that stays inside its pack: no absolute paths, URLs, '..' or '\\'. */
function safeRel(rel) {
  if (typeof rel !== 'string') return null;
  if (rel.includes('\0') || rel.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('/')) return null;
  const segs = rel.split('/').filter((s) => s && s !== '.');
  if (segs.some((s) => s === '..')) return null;
  return segs.join('/');
}

// security S5: the engine builds `${dir}/${note}.${ext}` from these, so they must not carry '/', '.', '#', '?'…
const SAFE_EXT_RE = /^[a-z0-9]{1,5}$/i;
const SAFE_NOTE_RE = /^[A-G][#b]?-?\d$/;
const safeExt = (e) => e === undefined || e === null || e === '' || (typeof e === 'string' && SAFE_EXT_RE.test(e));
const safeNotes = (n) => Array.isArray(n) && n.every((x) => (typeof x === 'string' && SAFE_NOTE_RE.test(x)) || (Number.isInteger(x) && x >= 0 && x <= 127));

/**
 * Rewrite one manifest instrument so its sample URLs point at /user-samples/<token>/<slug>/…
 * (the engine resolves `<dir>/<note>.<ext>` and `files` values against the manifest URL; absolute paths win).
 * S5: `ext` / `format` / a layer's `ext` must be 1-5 letters or digits and `notes[]` note names (C4, Db4, F#-1) or
 * MIDI numbers; an instrument or layer that breaks this is dropped with a line in `errors`.
 * @param {string[]} [errors]
 * @returns {object|null} null when no layer is usable
 */
function rewriteUserInstrument(inst, prefix, errors = []) {
  if (!inst || typeof inst !== 'object' || typeof inst.id !== 'string' || !inst.id || !Array.isArray(inst.layers)) return null;
  if (!safeExt(inst.ext) || !safeExt(inst.format)) {
    errors.push(`instrument "${inst.id}": "ext"/"format" must be a plain file extension such as "wav"; skipped`);
    return null;
  }
  const instNotesOk = inst.notes === undefined || safeNotes(inst.notes);
  const join = (rel) => (rel ? `${prefix}/${encodeRel(rel)}` : prefix);
  const layers = [];
  for (const [i, L] of inst.layers.entries()) {
    if (!L || typeof L !== 'object') continue;
    const out = { ...L };
    const usesNotes = !(L.files && typeof L.files === 'object');
    const notesOk = L.notes !== undefined ? safeNotes(L.notes) : instNotesOk;
    if (!safeExt(L.ext) || (usesNotes && !notesOk)) {
      errors.push(`instrument "${inst.id}" layer ${i + 1}: "ext" must be a plain file extension and "notes" note names (C4, Db4) or MIDI numbers; layer skipped`);
      continue;
    }
    if (L.files && typeof L.files === 'object') {
      const files = {};
      for (const [note, rel] of Object.entries(L.files)) {
        const r = safeRel(rel);
        if (r) files[note] = join(r);
      }
      if (!Object.keys(files).length) continue;
      out.files = files;
    } else {
      const r = safeRel(L.dir ?? inst.dir ?? inst.id);
      if (r === null) continue;
      out.dir = join(r);
    }
    layers.push(out);
  }
  if (!layers.length) return null;
  const { dir, ...rest } = inst;
  if (!instNotesOk) delete rest.notes;
  return { ...rest, layers };
}

/**
 * Scan "My Samples" roots: every <root>/<slug>/manifest.json (slug = folder name; dot-folders and symlinks that
 * leave the root are skipped). An instrument id already seen (earlier root / pack) is dropped with an error entry.
 * @param {string[]} roots
 * @param {string} token URL token
 * @returns {Promise<{instruments:object[], packs:Map<string,{dir:string, root:string, count:number}>, errors:string[]}>}
 */
async function scanUserSamples(roots, token) {
  const instruments = [];
  const packs = new Map();
  const errors = [];
  const ids = new Set();
  for (const root of roots || []) {
    let rootReal;
    try {
      rootReal = await fsp.realpath(root);
      if (!(await fsp.stat(rootReal)).isDirectory()) continue;
    } catch {
      continue; // missing root: nothing to scan
    }
    let entries;
    try {
      entries = await fsp.readdir(rootReal, { withFileTypes: true });
    } catch (err) {
      errors.push(`${root}: ${err.message}`);
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    for (const e of entries) {
      if (packs.size >= USER_PACKS_MAX) break;
      if (e.name.startsWith('.') || !(e.isDirectory() || e.isSymbolicLink())) continue;
      const slug = e.name;
      if (packs.has(slug)) {
        errors.push(`${path.join(root, slug)}: a pack named "${slug}" was already found in an earlier folder; skipped`);
        continue;
      }
      let dir;
      try {
        dir = await fsp.realpath(path.join(rootReal, slug));
        if (!(await fsp.stat(dir)).isDirectory()) continue;
        if (!within(rootReal, dir)) {
          // Kept a skip (a link could otherwise widen what /user-samples serves to its target, e.g. '/'), but no
          // longer silent (round2-shell #6): an external-drive link is a natural setup.
          const msg = `is a link to a folder outside My Samples (${dir}); skipped. Move the folder here instead.`;
          errors.push(`${path.join(root, slug)}: ${msg}`);
          continue;
        }
      } catch {
        continue;
      }
      let json;
      try {
        const mf = path.join(dir, 'manifest.json');
        const st = await fsp.stat(mf);
        if (st.size > USER_MANIFEST_MAX_BYTES) throw new Error('manifest.json is too large');
        json = JSON.parse(await fsp.readFile(mf, 'utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT') errors.push(`${path.join(root, slug, 'manifest.json')}: ${err.message}`);
        continue;
      }
      // Same forms as the engine's normalizeManifest (sampler.js): a top-level array, {instruments:[…]}, or the
      // app/samples/manifest.json object map {instruments:{id:{…}}} (round2-shell #5).
      let list = null;
      if (Array.isArray(json)) list = json;
      else if (json && Array.isArray(json.instruments)) list = json.instruments;
      else if (json && json.instruments && typeof json.instruments === 'object') {
        list = Object.entries(json.instruments).map(([id, v]) => (v && typeof v === 'object' ? { id, ...v } : null));
      }
      if (!list) {
        const mf = path.join(root, slug, 'manifest.json');
        errors.push(`${mf}: no instrument list (expected "instruments": [...]); skipped`);
        continue;
      }
      if (!list.length) errors.push(`${path.join(root, slug, 'manifest.json')}: the instrument list is empty`);
      const prefix = `/user-samples/${token}/${encodeURIComponent(slug)}`;
      let count = 0;
      for (const inst of list) {
        const why = [];
        const r = rewriteUserInstrument(inst, prefix, why);
        for (const w of why) errors.push(`${slug}: ${w}`);
        if (!r && why.length) continue;
        if (!r) {
          errors.push(`${slug}: instrument ${inst && inst.id ? `"${inst.id}"` : '(no id)'} has no usable layers; skipped`);
          continue;
        }
        if (ids.has(r.id)) {
          errors.push(`${slug}: instrument id "${r.id}" is already used by another pack; skipped`);
          continue;
        }
        ids.add(r.id);
        instruments.push({ ...r, pack: slug });
        count += 1;
      }
      packs.set(slug, { dir, root: rootReal, count });
    }
  }
  return { instruments, packs, errors };
}

/**
 * @param {object} opts
 * @param {string} opts.appDir     directory served at /
 * @param {number} [opts.port=8437]
 * @param {string} [opts.host='127.0.0.1']
 * @param {string|null} [opts.padsRoot=null]
 * @param {number} [opts.portTries=5]  extra ports tried (port+1..port+N) when busy (and not reused)
 * @param {boolean} [opts.reuse=true]  a busy port answering our /api/health is reused (serve.mjs); false → next port
 * @param {boolean} [opts.csp=true]  send the Content-Security-Policy header on app HTML
 * @param {boolean|string[]} [opts.userSamples=false]  "My Samples": true = defaultUserSampleRoots(), or explicit roots
 * @param {string|null} [opts.docsDir=<repo>/docs]  served read-only at /docs/<name>.md (text/plain, so Chrome shows it)
 * @param {string|null} [opts.secret=null]  security S4: when set, the personal-audio routes (/api/user-samples*,
 *   /user-samples/, /api/pads, /pads/) answer 403 unless the request carries `X-Rig-Key: <secret>`. Electron's
 *   main.js adds that header to its own window's requests (session.webRequest), so another local process (or macOS
 *   account) can no longer list or download My Samples / pad audio. The Chrome fallback passes none (a page can't
 *   hold a secret it doesn't also expose) and keeps the open behaviour.
 * @param {(msg:string)=>void} [opts.log]
 */
function createServer(opts = {}) {
  const appDir = path.resolve(opts.appDir || path.join(__dirname, 'app'));
  const host = opts.host || '127.0.0.1';
  const basePort = Number.isInteger(opts.port) ? opts.port : 8437;
  const portTries = Number.isInteger(opts.portTries) ? opts.portTries : 5;
  const reuse = opts.reuse !== false;
  const cspEnabled = opts.csp !== false;
  const log = opts.log || (() => {});
  let padsRoot = opts.padsRoot ? path.resolve(opts.padsRoot) : null;
  let token = crypto.randomBytes(9).toString('base64url');
  let port = null;
  let server = null;
  let padCache = null; // {root, rels, dirs}
  let lastClientSeen = 0; // Date.now() of the last /api/heartbeat
  const userRoots = opts.userSamples === true ? defaultUserSampleRoots() : Array.isArray(opts.userSamples) ? opts.userSamples.map((p) => path.resolve(p)) : [];
  const userSamplesOn = opts.userSamples === true || Array.isArray(opts.userSamples);
  const docsDir = opts.docsDir === null ? null : path.resolve(opts.docsDir || path.join(__dirname, 'docs'));
  const userToken = crypto.randomBytes(9).toString('base64url'); // stable per process: engine-cached URLs stay valid
  let userScan = null; // last scanUserSamples() result
  let userScanning = null;
  const secret = typeof opts.secret === 'string' && opts.secret ? Buffer.from(opts.secret) : null;

  /** S4: the per-launch key on a personal-audio route (always true when the server has no secret). */
  function keyOk(req) {
    if (!secret) return true;
    const v = req.headers[KEY_HEADER];
    if (typeof v !== 'string') return false;
    const b = Buffer.from(v);
    return b.length === secret.length && crypto.timingSafeEqual(b, secret);
  }

  function hostAllowed(req) {
    const h = String(req.headers.host || '').toLowerCase();
    if (!h) return true;
    const name = h.replace(/:\d+$/, '');
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
  }

  function sendJSON(req, res, status, obj) {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function sendText(req, res, status, text, extra = {}) {
    const body = Buffer.from(text);
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  /**
   * @param {object} o
   * @param {boolean} [o.dirIndex=true]  a directory serves its index.html. Only the app route wants that; the
   *   realpath-checked routes (/user-samples, /pads) pass false (round2-shell #1: `x.wav/index.html` bypass).
   * @param {string} [o.typePath]  path whose extension picks the Content-Type (the requested name, when `abs` is
   *   its realpath)
   */
  async function sendFile(req, res, abs, { cache, html = true, dirIndex = true, typePath }) {
    let st;
    try {
      st = await fsp.stat(abs);
      if (st.isDirectory() && dirIndex) {
        abs = path.join(abs, 'index.html');
        st = await fsp.stat(abs);
      }
    } catch {
      return false;
    }
    if (!st.isFile()) return false;
    const size = st.size;
    const etag = `W/"${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': mimeFor(typePath || abs),
      'Accept-Ranges': 'bytes',
      'Last-Modified': st.mtime.toUTCString(),
      ETag: etag,
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    };
    if (/\.html?$/i.test(abs) || (typePath && /\.html?$/i.test(typePath))) {
      headers['X-Frame-Options'] = 'DENY';
      if (html) headers['Content-Security-Policy'] = CSP;
    }
    if (req.headers['if-none-match'] === etag && !req.headers.range) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    let range = parseRange(req.headers.range, size);
    const ifRange = req.headers['if-range'];
    if (range && ifRange && ifRange !== etag && ifRange !== headers['Last-Modified']) range = null;
    if (range && range.unsatisfiable) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
      res.end();
      return true;
    }
    let status = 200;
    let start = 0;
    let end = size - 1;
    if (range) {
      status = 206;
      start = range.start;
      end = range.end;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || size === 0) {
      res.end();
      return true;
    }
    const stream = fs.createReadStream(abs, { start, end });
    stream.on('error', (err) => {
      log(`read error ${abs}: ${err.message}`);
      res.destroy(err);
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return true;
  }

  function cacheFor(abs, isPad) {
    const ext = path.extname(abs).toLowerCase();
    if (isPad) return 'private, max-age=3600';
    if (NO_CACHE_EXTS.has(ext)) return 'no-cache';
    if (AUDIO_EXTS.has(ext)) return 'public, max-age=604800';
    return 'no-cache';
  }

  /** Cached listing is valid while every visited directory keeps its mtime (adds/removes/renames change it). */
  async function padCacheValid(root) {
    if (!padCache || padCache.root !== root) return false;
    for (const [dir, mtime] of padCache.dirs) {
      try {
        if ((await fsp.stat(dir)).mtimeMs !== mtime) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  async function listPads() {
    if (!padsRoot) return [];
    const root = padsRoot;
    try {
      const st = await fsp.stat(root);
      if (!st.isDirectory()) return { error: 'missing' };
    } catch {
      return { error: 'missing' };
    }
    if (!(await padCacheValid(root))) {
      const w = await walkPads(root);
      padCache = { root, rels: w.rels, dirs: w.dirs };
    }
    return padCache.rels.map((rel) => ({ name: path.basename(rel), path: rel, url: `/pads/${token}/${encodeRel(rel)}` }));
  }

  /**
   * @returns {Promise<string|null>} the real path of a regular file inside the real pad folder (no symlink escape),
   *   else null. The caller serves this path, not `abs` (round2-shell #1: no check/open gap, no directory index).
   */
  async function padRealFile(abs) {
    try {
      const [rootReal, real] = await Promise.all([fsp.realpath(padsRoot), fsp.realpath(abs)]);
      if (!within(rootReal, real) || !(await fsp.stat(real)).isFile()) return null;
      return real;
    } catch {
      return null;
    }
  }

  /** Re-scan the "My Samples" roots. @returns {Promise<{count, instruments, roots, packs, errors}>} */
  async function rescanUserSamples() {
    if (!userSamplesOn) return { count: 0, instruments: [], roots: [], packs: [], errors: [] };
    if (!userScanning) {
      userScanning = scanUserSamples(userRoots, userToken)
        .then((r) => {
          userScan = r;
          for (const e of r.errors) log(`My Samples: ${e}`);
          return r;
        })
        .finally(() => {
          userScanning = null;
        });
    }
    const r = await userScanning;
    return {
      count: r.instruments.length,
      instruments: r.instruments,
      roots: userRoots.slice(),
      packs: [...r.packs].map(([slug, p]) => ({ slug, dir: p.dir, count: p.count })),
      errors: r.errors.slice(),
    };
  }

  /**
   * @returns {Promise<{abs:string, real:string}|null>} the audio file of a /user-samples/<token>/<slug>/<rel> URL:
   *   `real` is its realpath, inside the pack and a regular file (round2-shell #1), `abs` the requested path
   */
  async function userSampleFile(rest) {
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    let slug;
    try {
      slug = decodeURIComponent(rest.slice(0, slash));
    } catch {
      return null;
    }
    if (!userScan || !userScan.packs.has(slug)) await rescanUserSamples(); // a pack added since the last scan
    const pack = userScan && userScan.packs.get(slug);
    if (!pack) return null;
    const abs = safeJoin(pack.dir, rest.slice(slash + 1));
    if (!abs || !USER_SAMPLE_EXTS.includes(path.extname(abs).toLowerCase())) return null;
    try {
      const real = await fsp.realpath(abs);
      if (!within(pack.dir, real) || !(await fsp.stat(real)).isFile()) return null;
      return { abs, real };
    } catch {
      return null;
    }
  }

  async function handle(req, res) {
    if (!hostAllowed(req)) return sendText(req, res, 403, 'Forbidden host');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendText(req, res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }
    let pathname;
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch {
      return sendText(req, res, 400, 'Bad request');
    }
    // A page served from a sub-folder (dev fixtures: appDir = repo root, page at /app/) resolves the engine's
    // './api/…' URLs under that folder; answer them like the root routes instead of logging a console 404.
    const apiAt = pathname.indexOf('/api/');
    if (apiAt > 0 && API_ROUTE_RE.test(pathname.slice(apiAt))) pathname = pathname.slice(apiAt);
    if (pathname === '/api/health') {
      return sendJSON(req, res, 200, {
        ok: true,
        app: APP_ID,
        version: VERSION,
        pid: process.pid,
        clientSeenMsAgo: lastClientSeen ? Date.now() - lastClientSeen : null,
        userSamples: userSamplesOn, // the engine requests /api/user-samples/manifest.json only when this is true
        features: userSamplesOn ? ['user-samples'] : [],
      });
    }
    if (secret && PRIVATE_ROUTE_RE.test(pathname) && !keyOk(req)) return sendText(req, res, 403, 'Forbidden');
    if (pathname === '/api/user-samples/manifest.json') {
      // always 200: a missing/empty folder is an empty list (a 404 would log a console error in Chromium)
      const r = await rescanUserSamples();
      return sendJSON(req, res, 200, { app: APP_ID, kind: 'user-samples', instruments: r.instruments, roots: r.roots, packs: r.packs.map(({ slug, count }) => ({ slug, count })), errors: r.errors });
    }
    if (pathname === '/api/user-samples') {
      // summary for the Settings panel (Chrome has no window.rig): folder, roots, instrument count
      const r = await rescanUserSamples();
      const home = userSamplesOn ? (opts.userSamples === true ? userSamplesHome() : userRoots[0] || null) : null;
      return sendJSON(req, res, 200, { enabled: userSamplesOn, dir: home, path: home, roots: r.roots, count: r.count, packs: r.packs.map(({ slug, count }) => ({ slug, count })), errors: r.errors });
    }
    if (docsDir && /^\/docs\/[A-Za-z0-9._-]+\.md$/.test(pathname)) {
      const abs = safeJoin(docsDir, pathname.slice('/docs/'.length));
      if (abs) {
        try {
          const body = await fsp.readFile(abs);
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
          return res.end(req.method === 'HEAD' ? undefined : body);
        } catch {
          /* fall through to the app dir / 404 */
        }
      }
    }
    if (pathname.startsWith('/user-samples/')) {
      const rest = pathname.slice('/user-samples/'.length);
      const slash = rest.indexOf('/');
      if (!userSamplesOn || slash < 0 || rest.slice(0, slash) !== userToken) return sendText(req, res, 404, 'Not found');
      const f = await userSampleFile(rest.slice(slash + 1));
      const o = { cache: 'private, max-age=3600', dirIndex: false, typePath: f && f.abs };
      if (f && (await sendFile(req, res, f.real, o))) return undefined;
      return sendText(req, res, 404, 'Not found');
    }
    if (pathname === '/api/heartbeat') {
      lastClientSeen = Date.now();
      return sendJSON(req, res, 200, { ok: true });
    }
    if (pathname === '/api/pads') {
      const list = await listPads();
      return sendJSON(req, res, Array.isArray(list) ? 200 : 404, list);
    }
    if (pathname.startsWith('/pads/')) {
      const rest = pathname.slice('/pads/'.length);
      const slash = rest.indexOf('/');
      const tok = slash < 0 ? rest : rest.slice(0, slash);
      if (!padsRoot || tok !== token || slash < 0) return sendText(req, res, 404, 'Not found');
      const abs = safeJoin(padsRoot, rest.slice(slash + 1));
      if (!abs || !PAD_EXTS.includes(path.extname(abs).toLowerCase())) return sendText(req, res, 404, 'Not found');
      const real = await padRealFile(abs);
      if (!real) return sendText(req, res, 404, 'Not found');
      const o = { cache: cacheFor(abs, true), dirIndex: false, typePath: abs };
      if (await sendFile(req, res, real, o)) return undefined;
      return sendText(req, res, 404, 'Not found');
    }
    const abs = safeJoin(appDir, pathname === '/' ? '/index.html' : pathname);
    if (!abs) return sendText(req, res, 404, 'Not found');
    // dev/test fixtures (never shipped) use inline scripts: no CSP for them
    const csp = cspEnabled && !/^\/?test\//.test(path.relative(appDir, abs).split(path.sep).join('/'));
    if (await sendFile(req, res, abs, { cache: cacheFor(abs, false), html: csp })) return undefined;
    if (pathname === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
      return res.end();
    }
    return sendText(req, res, 404, 'Not found');
  }

  function checkHealth(p) {
    return new Promise((resolve) => {
      const req = http.get({ host, port: p, path: '/api/health', timeout: 1000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 4096) req.destroy();
        });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            resolve(res.statusCode === 200 && j && j.ok === true && j.app === APP_ID ? j : false);
          } catch {
            resolve(false);
          }
        });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
    });
  }

  function tryListen(p) {
    return new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => {
        handle(req, res).catch((err) => {
          log(`handler error: ${err && err.message}`);
          if (!res.headersSent) sendText(req, res, 500, 'Internal error');
          else res.destroy();
        });
      });
      s.keepAliveTimeout = 5000;
      const onErr = (err) => {
        s.removeListener('listening', onOk);
        reject(err);
      };
      const onOk = () => {
        s.removeListener('error', onErr);
        resolve(s);
      };
      s.once('error', onErr);
      s.once('listening', onOk);
      s.listen(p, host);
    });
  }

  return {
    /**
     * Start listening. Busy port + our /api/health → {reused:true} (unless reuse:false); otherwise tries port+1..+N.
     * @returns {Promise<{port:number, reused:boolean, url:string, tried:number[], busyWithRig?:number[], clientSeenMsAgo?:number|null}>}
     */
    async listen() {
      if (server) return { port, reused: false, url: `http://${host}:${port}/`, tried: [port] };
      const tried = [];
      const busyWithRig = [];
      for (let p = basePort; p <= basePort + portTries; p++) {
        tried.push(p);
        try {
          server = await tryListen(p);
          port = server.address().port;
          if (p !== basePort) log(`port ${basePort} busy${busyWithRig.length ? ' (another Worship Rig)' : ' (not Worship Rig)'}; using ${port}`);
          return { port, reused: false, url: `http://${host}:${port}/`, tried, busyWithRig };
        } catch (err) {
          if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
          const h = await checkHealth(p);
          if (h) {
            if (!reuse) {
              busyWithRig.push(p);
              continue;
            }
            port = p;
            log(`Worship Rig already running on ${p}; reusing it`);
            return { port, reused: true, url: `http://${host}:${p}/`, tried, clientSeenMsAgo: h.clientSeenMsAgo ?? null };
          }
        }
      }
      const e = new Error(`No free port in ${basePort}..${basePort + portTries}`);
      e.code = 'EADDRINUSE';
      throw e;
    },
    /** @param {string|null} dir absolute folder of pad files (null clears). Rotates the URL token. */
    setPadsRoot(dir) {
      padsRoot = dir ? path.resolve(dir) : null;
      padCache = null;
      token = crypto.randomBytes(9).toString('base64url');
      return { path: padsRoot, baseUrl: `/pads/${token}/` };
    },
    get padsRoot() {
      return padsRoot;
    },
    get token() {
      return token;
    },
    get port() {
      return port;
    },
    get appDir() {
      return appDir;
    },
    padsBaseUrl() {
      return `/pads/${token}/`;
    },
    /** "My Samples" scan roots (empty when the feature is off). */
    get userSampleRoots() {
      return userRoots.slice();
    },
    get userSamplesEnabled() {
      return userSamplesOn;
    },
    /** @returns {Promise<{count, instruments, roots, packs:{slug,dir,count}[], errors}>} */
    rescanUserSamples,
    /** @returns {Promise<Array<{name,path,url}>|{error:'missing'}>} */
    listPads,
    /** GET /api/health on another port. @returns {Promise<object|false>} */
    checkHealth,
    /** @returns {Promise<void>} */
    close() {
      return new Promise((resolve) => {
        if (!server) return resolve();
        const s = server;
        server = null;
        s.close(() => resolve());
        if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      });
    },
  };
}

/** @param {string} host @param {number} port @returns {Promise<object|false>} the /api/health body when it is Worship Rig */
function probeHealth(port, host = '127.0.0.1') {
  return createServer({ host, port }).checkHealth(port);
}

module.exports = {
  createServer, parseRange, mimeFor, safeJoin, walkPads, probeHealth, scanUserSamples, defaultUserSampleRoots, userSamplesHome,
  PAD_EXTS, USER_SAMPLE_EXTS, APP_ID, CSP, KEY_HEADER,
};
