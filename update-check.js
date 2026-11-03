'use strict';
// "Update available" check (v11-electron; CONTRACT_CHANGES "## v11-electron"). Not a silent updater: the builds are
// ad-hoc signed and not notarized, so Squirrel.Mac (electron-updater's macOS installer) refuses to apply an update.
// Instead, at most once a day, ask GitHub Releases for the latest release, compare it with app.getVersion(), and let
// Settings › About show "Version x.y.z is available — Download", which opens the right .dmg in the browser. Nothing is
// ever installed, and the app never quits or shows a dialog by itself.
// Pure: fetch, clock, cache and timers are injected (test/unit/shell/update-check.test.mjs); main.js wires Electron.

const REPO = 'ryanmye/worship-rig';
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
/** Only these URLs are ever opened (release page and asset downloads of this repo). */
const OPEN_PREFIX = `https://github.com/${REPO}/releases/`;
const DAY_MS = 24 * 60 * 60 * 1000;
/** An attempt that never reached GitHub (offline) may be retried after an hour; anything else waits a day. */
const OFFLINE_RETRY_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

// v-prefix, up to three numeric parts, optional -prerelease and +build
const VERSION_RE =
  /^\s*v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?:-([0-9A-Za-z.-]{1,40}))?(?:\+[0-9A-Za-z.-]*)?\s*$/;
/**
 * '1.2.3', 'v1.2.3', '1.2.3-beta.1' → {nums: [1,2,3], pre: 'beta.1'|''}; null when it isn't a version.
 * @param {*} s
 */
function parseVersion(s) {
  if (typeof s !== 'string') return null;
  const m = VERSION_RE.exec(s);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)], pre: m[4] || '' };
}

/**
 * semver order: 1.10.0 > 1.9.9, 1.1.0 > 1.1.0-beta, missing parts count as 0. Unreadable versions sort lowest.
 * @returns {-1|0|1}
 */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const pa = x.pre.split('.');
  const pb = y.pre.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb && Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) > Number(pb[i]) ? 1 : -1;
    if (na !== nb) return na ? -1 : 1;
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

/**
 * Which build to offer: Apple Silicon or Intel. An x64 copy running under Rosetta on an Apple Silicon Mac gets arm64.
 * @param {string} arch process.arch
 * @param {boolean} [translated] app.runningUnderARM64Translation
 * @returns {'arm64'|'x64'}
 */
function buildArch(arch, translated = false) {
  return arch === 'arm64' || translated ? 'arm64' : 'x64';
}

const openable = (u) =>
  typeof u === 'string' && (u === RELEASES_PAGE || u.startsWith(OPEN_PREFIX)) && !/[\s"'<>]/.test(u);

/**
 * The release asset for this Mac: Worship-Rig-<arch>.dmg (release.yml's stable names), else the .zip, else null.
 * @param {Array<{name: string, browser_download_url: string}>} assets
 * @param {'arm64'|'x64'} arch
 * @returns {{name: string, url: string}|null}
 */
function pickAsset(assets, arch) {
  if (!Array.isArray(assets)) return null;
  for (const ext of ['dmg', 'zip']) {
    const name = `Worship-Rig-${arch}.${ext}`;
    const a = assets.find((x) => x && x.name === name && openable(x.browser_download_url));
    if (a) return { name, url: a.browser_download_url };
  }
  return null;
}

/**
 * GitHub's /releases/latest JSON → what Settings needs. Drafts and prereleases never count (the API skips them too).
 * @param {*} json
 * @param {{currentVersion: string, arch: 'arm64'|'x64'}} o
 * @returns {{latest: string, update: boolean, pageUrl: string, downloadUrl: string|null, asset: string|null}|null}
 */
function parseRelease(json, { currentVersion, arch }) {
  if (!json || typeof json !== 'object' || json.draft || json.prerelease) return null;
  const v = parseVersion(json.tag_name);
  if (!v) return null;
  const latest = v.nums.join('.') + (v.pre ? `-${v.pre}` : '');
  const asset = pickAsset(json.assets, arch);
  return {
    latest,
    update: compareVersions(latest, currentVersion) > 0,
    pageUrl: openable(json.html_url) ? json.html_url : RELEASES_PAGE,
    downloadUrl: asset ? asset.url : null,
    asset: asset ? asset.name : null,
  };
}

/**
 * Is an automatic check due? At most once a day; an offline attempt (nothing reached GitHub) after an hour.
 * @param {{attemptAt?: number, error?: string|null}|null} cache
 * @param {number} now
 */
function isCheckDue(cache, now) {
  const at = cache && Number(cache.attemptAt);
  if (!Number.isFinite(at) || at <= 0 || at > now) return true;
  return now - at >= (cache.error === 'offline' ? OFFLINE_RETRY_MS : DAY_MS);
}

/**
 * One request to the feed. Never throws: failures come back as {error: 'offline' | 'rate-limited' | 'no-release' |
 * 'bad-response'} (shown in plain words only after "Check now"; an automatic check stays silent).
 * @param {{fetch: Function, url?: string, currentVersion: string, arch: 'arm64'|'x64', timeoutMs?: number}} o
 */
async function fetchLatest(o) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), o.timeoutMs || FETCH_TIMEOUT_MS) : null;
  try {
    let res;
    try {
      res = await o.fetch(o.url || LATEST_API, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Worship-Rig/${o.currentVersion}` },
        ...(ctl ? { signal: ctl.signal } : {}),
      });
    } catch {
      return { error: 'offline' };
    }
    if (res.status === 404) return { error: 'no-release' };
    const h = res.headers && typeof res.headers.get === 'function' ? res.headers : null;
    const remaining = h ? h.get('x-ratelimit-remaining') : null;
    if (res.status === 429 || (res.status === 403 && remaining === '0')) return { error: 'rate-limited' };
    if (!res.ok) return { error: 'bad-response' };
    let json;
    try {
      json = await res.json();
    } catch {
      return { error: 'bad-response' };
    }
    const r = parseRelease(json, o);
    return r || { error: 'bad-response' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The checker main.js keeps one of. The setting (settings.updateCheck, mirrored by the renderer) turns it on; until
 * the renderer says so nothing is checked. `supported` false (running from source, or a self-test without a fake
 * feed) means it never touches the network.
 * @param {{
 *   fetch: Function, url?: string, supported: boolean, currentVersion: string, arch: 'arm64'|'x64',
 *   now?: () => number, readCache: () => object|null, writeCache: (c: object) => void,
 *   setTimeout?: Function, clearTimeout?: Function, launchDelayMs?: number, tickMs?: number,
 *   onStatus?: (status: object) => void,
 * }} o
 */
function createUpdateChecker(o) {
  const now = o.now || Date.now;
  const later = o.setTimeout || setTimeout;
  const cancel = o.clearTimeout || clearTimeout;
  const launchDelayMs = o.launchDelayMs ?? 20000;
  const tickMs = o.tickMs ?? 60 * 60 * 1000;
  let enabled = false;
  let checking = false;
  let timer = null;
  let manualError = null; // the error of a "Check now" (shown); automatic errors stay silent
  let cache = o.readCache() || null;

  function status() {
    const c = cache || {};
    const known = c.latest && parseVersion(c.latest);
    const update = !!(known && compareVersions(c.latest, o.currentVersion) > 0);
    return {
      enabled,
      supported: !!o.supported,
      current: o.currentVersion,
      state: !o.supported ? 'unsupported' : checking ? 'checking' : update ? 'update' : known ? 'latest' : 'idle',
      latest: known ? c.latest : null,
      pageUrl: update && openable(c.pageUrl) ? c.pageUrl : RELEASES_PAGE,
      downloadUrl: update && openable(c.downloadUrl) ? c.downloadUrl : null,
      asset: update ? c.asset || null : null,
      checkedAt: Number.isFinite(c.checkedAt) ? c.checkedAt : null,
      error: manualError,
    };
  }
  const push = () => {
    const s = status();
    if (o.onStatus) o.onStatus(s);
    return s;
  };

  async function run(manual) {
    if (!o.supported || checking) return status();
    checking = true;
    if (manual) manualError = null;
    push();
    const at = now();
    const r = await fetchLatest(o);
    checking = false;
    if (r.error && r.error !== 'no-release') {
      cache = { ...(cache || {}), attemptAt: at, error: r.error };
      if (manual) manualError = r.error;
    } else {
      // no release yet counts as "you have the latest"
      const latest = r.error ? o.currentVersion : r.latest;
      cache = { attemptAt: at, checkedAt: at, error: null, latest, pageUrl: r.pageUrl || RELEASES_PAGE,
        downloadUrl: r.downloadUrl || null, asset: r.asset || null };
      manualError = null;
    }
    try {
      o.writeCache(cache);
    } catch {
      /* a cache that can't be saved only means one more check next launch */
    }
    return push();
  }

  function schedule(ms) {
    if (timer) cancel(timer);
    timer = later(tick, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  async function tick() {
    timer = null;
    if (!enabled) return;
    if (isCheckDue(cache, now())) await run(false);
    if (enabled) schedule(tickMs);
  }

  return {
    /** settings.updateCheck from the renderer. Turning on schedules the launch check (if one is due). */
    setEnabled(on) {
      const next = !!on && !!o.supported;
      if (next && !enabled) schedule(launchDelayMs);
      if (!next && timer) {
        cancel(timer);
        timer = null;
      }
      enabled = !!on;
      return push();
    },
    /** "Check now" in Settings (ignores the once-a-day limit; still never with supported false). */
    checkNow: () => run(true),
    status,
    /** The URL `kind` opens ('download' falls back to the release page), or null when nothing safe is known. */
    urlFor(kind) {
      const s = status();
      const u = kind === 'download' ? s.downloadUrl || s.pageUrl : s.pageUrl;
      return openable(u) ? u : null;
    },
    dispose() {
      enabled = false;
      if (timer) cancel(timer);
      timer = null;
    },
  };
}

module.exports = {
  REPO, LATEST_API, RELEASES_PAGE, DAY_MS, OFFLINE_RETRY_MS,
  parseVersion, compareVersions, buildArch, pickAsset, parseRelease, isCheckDue, fetchLatest, createUpdateChecker,
};
