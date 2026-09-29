// Finds the audio file an EXS sample chunk refers to. Stored paths point at the authoring machine, so resolution is
// by file name: (1) next to the .exs, (2) the stored absolute path if it exists here, (3) an index of every audio
// file under the sample roots (exact name, case-insensitive; ties broken by how many trailing folder names match
// the stored path), (4) same stem with another audio extension (Apple ships some libraries re-encoded as .caf).
// The index is built once and cached as JSON.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const INDEX_VERSION = 2;
export const AUDIO_EXT = new Set(['.wav', '.wave', '.aif', '.aiff', '.aifc', '.caf', '.m4a', '.mp3', '.sd2']);
export const MAX_INDEX_AGE_MS = 7 * 24 * 3600 * 1000;

const HOME = os.homedir();
export const DEFAULT_INSTRUMENT_ROOTS = [
  '/Library/Application Support/GarageBand/Instrument Library',
  '/Library/Application Support/Logic/Sampler Instruments',
  path.join(HOME, 'Music/Audio Music Apps/Sampler Instruments'),
];
export const DEFAULT_SAMPLE_ROOTS = [
  '/Library/Application Support/GarageBand/Instrument Library', // includes Sampler/Sampler Files
  '/Library/Application Support/Logic/EXS Factory Samples',
  '/Library/Application Support/Logic/Sampler Instruments',
  path.join(HOME, 'Music/Audio Music Apps/Samples'),
  path.join(HOME, 'Music/Audio Music Apps/Sampler Instruments'),
];
export const DEFAULT_CACHE = path.join(HOME, 'Library/Caches/worship-rig-exs-index.json');

/** Recursive file walk; skips unreadable dirs, dot-dirs and symlinked dirs (loop safety). */
export function walkFiles(root, accept) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if ((e.isFile() || e.isSymbolicLink()) && accept(e.name, p)) out.push(p);
    }
  }
  return out.sort();
}

const isAudio = (name) => AUDIO_EXT.has(path.extname(name).toLowerCase());

function rootStamp(roots) {
  return roots.map((r) => {
    try {
      return { root: r, mtimeMs: Math.round(fs.statSync(r).mtimeMs) };
    } catch {
      return { root: r, mtimeMs: null };
    }
  });
}

export function buildIndex(roots) {
  const files = {};
  let count = 0;
  for (const r of roots) {
    for (const p of walkFiles(r, isAudio)) {
      const k = path.basename(p).toLowerCase();
      (files[k] ||= []).includes(p) || files[k].push(p);
      count++;
    }
  }
  return { version: INDEX_VERSION, builtAt: Date.now(), roots: rootStamp(roots), count, files };
}

/**
 * Load the cached index if it is for the same roots, their mtimes are unchanged and it is < 7 days old; else rebuild
 * and write the cache (best effort).
 * @returns {{ index:object, rebuilt:boolean }}
 */
export function loadOrBuildIndex(roots, cachePath = DEFAULT_CACHE, { rebuild = false, log = () => {} } = {}) {
  if (!rebuild) {
    try {
      const idx = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const fresh = idx.version === INDEX_VERSION && Date.now() - idx.builtAt < MAX_INDEX_AGE_MS && JSON.stringify(idx.roots) === JSON.stringify(rootStamp(roots));
      if (fresh) return { index: idx, rebuilt: false };
    } catch {
      /* no cache */
    }
  }
  log(`indexing audio files under ${roots.length} folder(s)…`);
  const index = buildIndex(roots);
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(index));
  } catch (e) {
    log(`(could not write index cache ${cachePath}: ${e.message})`);
  }
  return { index, rebuilt: true };
}

/** Normalise a stored EXS path (may use ':' HFS separators or a trailing slash) into folder components. */
export function storedDirParts(p) {
  if (!p) return [];
  const s = p.includes('/') ? p : p.replace(/:/g, '/');
  return s.split('/').filter(Boolean).map((x) => x.toLowerCase());
}

function trailingMatch(candidate, storedParts) {
  const parts = path.dirname(candidate).split(path.sep).filter(Boolean).map((x) => x.toLowerCase());
  let n = 0;
  while (n < parts.length && n < storedParts.length && parts[parts.length - 1 - n] === storedParts[storedParts.length - 1 - n]) n++;
  return n;
}

const exists = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

function best(all, storedParts, exsDir) {
  const cands = (all || []).filter(exists); // the cached index may be stale
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];
  const scored = cands.map((c) => ({ c, s: trailingMatch(c, storedParts) * 10 + (exsDir && c.startsWith(exsDir) ? 1 : 0) }));
  scored.sort((a, b) => b.s - a.s || a.c.length - b.c.length || (a.c < b.c ? -1 : 1));
  return scored[0].c;
}

/** security S7: `p` resolves (realpath) inside one of `roots`. */
export function underRoots(p, roots) {
  let real;
  try {
    real = fs.realpathSync(p);
  } catch {
    return false;
  }
  return roots.some((r) => {
    try {
      const rr = fs.realpathSync(r);
      return real === rr || real.startsWith(rr.endsWith(path.sep) ? rr : rr + path.sep);
    } catch {
      return false;
    }
  });
}

/**
 * @param {{ fileName:string, path:string }} sample
 * @param {string} exsPath
 * @param {object} index
 * @param {{ roots?: string[] }} [opts]  S7: when given, an absolute sample path stored in the .exs is used only if it
 *   lies inside one of these roots (a third-party .exs could otherwise name any readable file, e.g. ~/.ssh keys);
 *   a stored path must always have an audio extension
 * @returns {{ path:string, how:string } | null}
 */
export function resolveSample(sample, exsPath, index, { roots } = {}) {
  const fileName = path.basename(String(sample.fileName || sample.name || '').replace(/:/g, '/'));
  if (!fileName) return null;
  const exsDir = path.dirname(exsPath);
  const local = path.join(exsDir, fileName);
  if (exists(local)) return { path: local, how: 'next to .exs' };
  if (sample.path) {
    const stored = path.join(sample.path.includes('/') ? sample.path : '/' + sample.path.replace(/:/g, '/'), fileName);
    const allowed = isAudio(stored) && (!roots || underRoots(stored, roots));
    if (path.isAbsolute(stored) && allowed && exists(stored)) return { path: stored, how: 'stored path' };
  }
  const parts = storedDirParts(sample.path);
  const files = index?.files || {};
  const exact = best(files[fileName.toLowerCase()], parts, exsDir);
  if (exact) return { path: exact, how: 'index (name)' };
  const stem = fileName.replace(/\.[^.]+$/, '').toLowerCase();
  const alts = [];
  for (const ext of AUDIO_EXT) if (files[stem + ext]) alts.push(...files[stem + ext]);
  const alt = best(alts, parts, exsDir);
  if (alt) return { path: alt, how: 'index (stem, other extension)' };
  return null;
}
