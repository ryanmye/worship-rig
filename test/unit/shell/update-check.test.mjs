// v11-electron: update-check.js — version compare, arch/asset pick, release parsing, the once-a-day rule, the fetch
// error mapping, and the checker with a fake fetch/clock/cache (never the network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const U = require('../../../update-check.js');

const asset = (name) => ({ name, browser_download_url: `https://github.com/${U.REPO}/releases/download/v1.1.1/${name}` });
const RELEASE = {
  tag_name: 'v1.1.1', draft: false, prerelease: false, html_url: `https://github.com/${U.REPO}/releases/tag/v1.1.1`,
  assets: ['Worship-Rig-arm64.dmg', 'Worship-Rig-arm64.zip', 'Worship-Rig-x64.dmg', 'Worship-Rig-x64.zip',
    'worship-rig-starter-library.json'].map(asset),
};

test('compareVersions: numeric parts, v prefix, missing parts, prereleases', () => {
  const c = U.compareVersions;
  assert.equal(c('1.1.1', '1.0.1'), 1);
  assert.equal(c('v1.0.1', '1.0.1'), 0);
  assert.equal(c('1.10.0', '1.9.9'), 1, 'numeric, not string order');
  assert.equal(c('1.1', '1.1.0'), 0);
  assert.equal(c('2', '1.99.99'), 1);
  assert.equal(c('1.1.0-beta.1', '1.1.0'), -1);
  assert.equal(c('1.1.0-beta.2', '1.1.0-beta.10'), -1);
  assert.equal(c('1.1.0-beta', '1.1.0-alpha'), 1);
  assert.equal(c('1.1.0-rc.1', '1.1.0-rc.1.1'), -1);
  assert.equal(c('1.0.1', 'nightly'), 1, 'unreadable sorts lowest');
  assert.equal(c('garbage', 'nonsense'), 0);
  assert.equal(U.parseVersion('v1.2.3+build.5').nums.join('.'), '1.2.3');
  assert.equal(U.parseVersion('1.2.3.4'), null);
});

test('buildArch: arm64, x64, and an Intel copy under Rosetta gets the Apple Silicon build', () => {
  assert.equal(U.buildArch('arm64'), 'arm64');
  assert.equal(U.buildArch('x64'), 'x64');
  assert.equal(U.buildArch('x64', true), 'arm64');
});

test('pickAsset: Worship-Rig-<arch>.dmg first, then .zip; only this repo’s release URLs', () => {
  assert.equal(U.pickAsset(RELEASE.assets, 'arm64').name, 'Worship-Rig-arm64.dmg');
  assert.equal(U.pickAsset(RELEASE.assets, 'x64').name, 'Worship-Rig-x64.dmg');
  assert.equal(U.pickAsset(RELEASE.assets.filter((a) => !a.name.endsWith('.dmg')), 'x64').name, 'Worship-Rig-x64.zip');
  assert.equal(U.pickAsset([asset('Worship-Rig-1.1.1-arm64.dmg')], 'arm64'), null, 'only the stable names count');
  assert.equal(U.pickAsset([{ name: 'Worship-Rig-arm64.dmg', browser_download_url: 'https://evil.example/x.dmg' }], 'arm64'), null);
  assert.equal(U.pickAsset(null, 'arm64'), null);
});

test('parseRelease: newer/older/same, drafts and prereleases ignored, bad URLs fall back to the releases page', () => {
  const r = U.parseRelease(RELEASE, { currentVersion: '1.0.1', arch: 'arm64' });
  assert.deepEqual(r, {
    latest: '1.1.1', update: true, pageUrl: RELEASE.html_url,
    downloadUrl: RELEASE.assets[0].browser_download_url, asset: 'Worship-Rig-arm64.dmg',
  });
  assert.equal(U.parseRelease(RELEASE, { currentVersion: '1.1.1', arch: 'arm64' }).update, false);
  assert.equal(U.parseRelease(RELEASE, { currentVersion: '1.2.0', arch: 'arm64' }).update, false);
  assert.equal(U.parseRelease({ ...RELEASE, draft: true }, { currentVersion: '1.0.1', arch: 'arm64' }), null);
  assert.equal(U.parseRelease({ ...RELEASE, prerelease: true }, { currentVersion: '1.0.1', arch: 'arm64' }), null);
  assert.equal(U.parseRelease({ ...RELEASE, tag_name: 'latest' }, { currentVersion: '1.0.1', arch: 'arm64' }), null);
  assert.equal(U.parseRelease({ ...RELEASE, html_url: 'javascript:alert(1)' }, { currentVersion: '1', arch: 'x64' }).pageUrl,
    U.RELEASES_PAGE);
  assert.equal(U.parseRelease('nope', { currentVersion: '1', arch: 'x64' }), null);
});

test('isCheckDue: at most once a day; an offline attempt may retry after an hour', () => {
  const H = 3600 * 1000;
  assert.equal(U.isCheckDue(null, 1e12), true);
  assert.equal(U.isCheckDue({ attemptAt: 1e12 }, 1e12 + 23 * H), false);
  assert.equal(U.isCheckDue({ attemptAt: 1e12 }, 1e12 + 24 * H), true);
  assert.equal(U.isCheckDue({ attemptAt: 1e12, error: 'rate-limited' }, 1e12 + 2 * H), false);
  assert.equal(U.isCheckDue({ attemptAt: 1e12, error: 'offline' }, 1e12 + 30 * 60000), false);
  assert.equal(U.isCheckDue({ attemptAt: 1e12, error: 'offline' }, 1e12 + H), true);
  assert.equal(U.isCheckDue({ attemptAt: 1e12 + 5 * H }, 1e12), true, 'a clock that went backwards: check');
});

const res = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
});

test('fetchLatest maps every failure to a quiet error code (never throws)', async () => {
  const o = { currentVersion: '1.0.1', arch: 'arm64' };
  const seen = [];
  const ok = await U.fetchLatest({ ...o, fetch: async (url, init) => (seen.push([url, init]), res(200, RELEASE)) });
  assert.equal(ok.latest, '1.1.1');
  assert.equal(seen[0][0], U.LATEST_API);
  assert.match(seen[0][1].headers['User-Agent'], /^Worship-Rig\/1\.0\.1$/);
  const err = async (fetch) => (await U.fetchLatest({ ...o, fetch })).error;
  assert.equal(await err(async () => {
    throw new TypeError('net::ERR_INTERNET_DISCONNECTED');
  }), 'offline');
  assert.equal(await err(async () => res(403, {}, { 'x-ratelimit-remaining': '0' })), 'rate-limited');
  assert.equal(await err(async () => res(429, {})), 'rate-limited');
  assert.equal(await err(async () => res(404, {})), 'no-release');
  assert.equal(await err(async () => res(500, {})), 'bad-response');
  assert.equal(await err(async () => res(200, '{not json')), 'bad-response');
  assert.equal(await err(async () => res(200, { tag_name: 'x' })), 'bad-response');
});

/** A checker with a fake clock, timers, cache and fetch. */
function checker(o = {}) {
  let t = 1e12;
  const timers = [];
  const calls = [];
  let cache = o.cache || null;
  const statuses = [];
  const c = U.createUpdateChecker({
    supported: o.supported ?? true,
    currentVersion: o.currentVersion || '1.0.1',
    arch: 'arm64',
    fetch: async (url) => {
      calls.push(url);
      return o.respond ? o.respond() : res(200, RELEASE);
    },
    now: () => t,
    readCache: () => cache,
    writeCache: (x) => (cache = x),
    setTimeout: (fn, ms) => {
      const h = { fn, ms, cancelled: false };
      timers.push(h);
      return h;
    },
    clearTimeout: (h) => h && (h.cancelled = true),
    launchDelayMs: 20000,
    tickMs: 3600000,
    onStatus: (s) => statuses.push(s),
  });
  const runTimers = async () => {
    const due = timers.splice(0).filter((h) => !h.cancelled);
    for (const h of due) await h.fn();
  };
  return { c, calls, statuses, runTimers, timers, advance: (ms) => (t += ms), cache: () => cache };
}

test('checker: nothing happens until the renderer turns it on; then one check after the launch delay', async () => {
  const k = checker();
  assert.equal(k.timers.length, 0);
  assert.equal(k.c.status().state, 'idle');
  k.c.setEnabled(true);
  assert.equal(k.timers.length, 1);
  assert.equal(k.timers[0].ms, 20000);
  await k.runTimers();
  assert.equal(k.calls.length, 1);
  const s = k.c.status();
  assert.equal(s.state, 'update');
  assert.equal(s.latest, '1.1.1');
  assert.equal(s.current, '1.0.1');
  assert.equal(s.downloadUrl, RELEASE.assets[0].browser_download_url);
  assert.equal(s.error, null);
  assert.ok(k.statuses.some((x) => x.state === 'checking'), 'checking is reported');
  assert.equal(k.cache().latest, '1.1.1', 'cached (rig-shell.json in main)');
  // the next hourly tick, still the same day: no request
  k.advance(3600000);
  await k.runTimers();
  assert.equal(k.calls.length, 1);
  // a day later: one more
  k.advance(24 * 3600000);
  await k.runTimers();
  assert.equal(k.calls.length, 2);
});

test('checker: a relaunch within a day uses the cache (no request) and still shows the notice', async () => {
  const first = checker();
  first.c.setEnabled(true);
  await first.runTimers();
  const k = checker({ cache: first.cache() });
  assert.equal(k.c.status().state, 'update', 'known before any request');
  k.c.setEnabled(true);
  await k.runTimers();
  assert.equal(k.calls.length, 0);
  // after updating the app, the same cache reads "latest"
  const after = checker({ cache: first.cache(), currentVersion: '1.1.1' });
  assert.equal(after.c.status().state, 'latest');
  assert.equal(after.c.status().downloadUrl, null);
});

test('checker: off cancels the timer; unsupported (from source / self-test) never fetches, even on Check now', async () => {
  const k = checker();
  k.c.setEnabled(true);
  k.c.setEnabled(false);
  await k.runTimers();
  assert.equal(k.calls.length, 0);
  const u = checker({ supported: false });
  u.c.setEnabled(true);
  await u.runTimers();
  const s = await u.c.checkNow();
  assert.equal(u.calls.length, 0);
  assert.equal(s.state, 'unsupported');
  assert.equal(s.enabled, true);
});

test('checker: an automatic failure stays silent; Check now reports it in status.error', async () => {
  const k = checker({ respond: () => res(403, {}, { 'x-ratelimit-remaining': '0' }) });
  k.c.setEnabled(true);
  await k.runTimers();
  assert.equal(k.calls.length, 1);
  assert.equal(k.c.status().error, null, 'automatic: silent');
  assert.equal(k.c.status().state, 'idle');
  const s = await k.c.checkNow();
  assert.equal(s.error, 'rate-limited');
  assert.equal(k.calls.length, 2, 'Check now ignores the once-a-day rule');
});

test('checker: no release yet counts as up to date; urlFor only hands out this repo’s URLs', async () => {
  const k = checker({ respond: () => res(404, {}) });
  const s = await k.c.checkNow();
  assert.equal(s.state, 'latest');
  assert.equal(s.error, null);
  assert.equal(k.c.urlFor('download'), U.RELEASES_PAGE, 'no update: the releases page');
  const n = checker();
  await n.c.checkNow();
  assert.equal(n.c.urlFor('download'), RELEASE.assets[0].browser_download_url);
  assert.equal(n.c.urlFor('page'), RELEASE.html_url);
  const evil = checker({ cache: { attemptAt: 1e12, checkedAt: 1e12, latest: '9.0.0', pageUrl: 'https://evil.example/',
    downloadUrl: 'file:///etc/passwd' } });
  assert.equal(evil.c.urlFor('download'), U.RELEASES_PAGE);
  assert.equal(evil.c.urlFor('page'), U.RELEASES_PAGE);
});
