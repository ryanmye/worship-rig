// Preload for ui-core-devhost.mjs (not a test file): replaces server.js's createServer, for the process it is
// --require'd into, by one that starts rig-devhost (native core, null audio backend) on the requested port. The suite
// (test/phase2/ui-core/run.mjs) then loads the real UI with main.js's engine import swapped to
// engine-bridge/boot-devhost.js, i.e. against the NATIVE engine, without a line of the suite or app/ edited.
// Env: RIG_DEVHOST_BIN (binary; required), RIG_DEVHOST_LOG (bridge log file, optional),
// RIG_DEVHOST_RECORDINGS (takes dir, optional), RIG_DEVHOST_STDERR (file for the host's stderr, optional).
'use strict';
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const REPO = path.resolve(__dirname, '../../..');
const SERVER = path.join(REPO, 'server.js');

/** The server.js `createServer` surface ui-core uses: listen() -> {url}, close(). */
function devhostCreateServer({ port = 0 } = {}) {
  const bin = process.env.RIG_DEVHOST_BIN;
  let child = null;
  return {
    listen() {
      const args = ['--port', String(port), '--backend', 'null', '--repo', REPO];
      if (process.env.RIG_DEVHOST_LOG) args.push('--log', process.env.RIG_DEVHOST_LOG);
      if (process.env.RIG_DEVHOST_RECORDINGS) args.push('--recordings', process.env.RIG_DEVHOST_RECORDINGS);
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const errFile = process.env.RIG_DEVHOST_STDERR;
      let err = '';
      child.stderr.on('data', (d) => {
        err += d;
        if (errFile) fs.appendFileSync(errFile, d);
      });
      return new Promise((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error(`rig-devhost did not start: ${err}`)), 15000);
        child.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`rig-devhost exited ${code}: ${err}`));
        });
        child.stdout.on('data', (d) => {
          out += d;
          const m = /listening on (http:\/\/[\d.]+:\d+\/)/.exec(out);
          if (!m) return;
          clearTimeout(timer);
          resolve({ url: m[1], port: Number(/:(\d+)\/$/.exec(m[1])[1]) });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        if (!child || child.exitCode !== null) return resolve();
        child.removeAllListeners('exit');
        child.on('exit', () => resolve());
        child.kill('SIGTERM');
        return undefined;
      });
    },
  };
}

/** An installed full Chromium when Playwright's pinned revision is absent (this box: 1243 for a 1194 pin). */
function findChromium() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers',
    path.join(require('node:os').homedir(), '.cache/ms-playwright')].filter(Boolean);
  for (const r of roots) {
    if (!fs.existsSync(r) || !fs.statSync(r).isDirectory()) continue;
    for (const d of fs.readdirSync(r).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
      for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const exe = path.join(r, d, sub);
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

// UIB (T09 / T11 O7): the suite reads a few Web Audio engine internals (engine.slots, getParam, pedaled, ...);
// ui-core-devhost.adapter.js answers them on the BridgeEngine instance in every page (RIG_UICORE_NO_ADAPTER=1: off)
const ADAPTER = process.env.RIG_UICORE_NO_ADAPTER === '1' ? null
  : fs.readFileSync(path.join(__dirname, 'ui-core-devhost.adapter.js'), 'utf8');
function withAdapter(browser) {
  if (!ADAPTER || !browser || browser.__uiCoreAdapter) return browser;
  browser.__uiCoreAdapter = true;
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...a) => {
    const ctx = await newContext(...a);
    await ctx.addInitScript({ content: ADAPTER });
    return ctx;
  };
  browser.newPage = async (...a) => (await browser.newContext(...a)).newPage();
  return browser;
}

// The suite launches `channel: 'chromium'`; never `playwright install` here, so fall back to what is installed.
try {
  const { chromium } = require(require.resolve('playwright', { paths: [REPO] }));
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async (o = {}) => {
    try {
      return withAdapter(await launch(o));
    } catch (e) {
      const exe = process.env.BRIDGE_CHROMIUM || findChromium();
      if (!exe || !/Executable doesn't exist/.test(String(e && e.message))) throw e;
      const { channel, ...rest } = o;
      return withAdapter(await launch({ ...rest, executablePath: exe }));
    }
  };
} catch {
  /* no playwright: the suite reports it */
}

const load = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  const real = load.call(this, request, parent, isMain);
  let resolved = null;
  try {
    resolved = Module._resolveFilename(request, parent, isMain);
  } catch {
    return real;
  }
  if (resolved !== SERVER) return real;
  return { ...real, createServer: devhostCreateServer };
};
