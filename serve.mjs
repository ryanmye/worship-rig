#!/usr/bin/env node
// Worship Rig — Chrome launcher / local server CLI (SPEC §1, REVIEW 1.20).
//   node serve.mjs [--port 8437] [--open] [--pads <dir>] [--app <dir>] [--user-samples <dir>[:<dir>…]]
// Serves app/ on http://127.0.0.1:<port>/ (reusing an already-running Worship Rig server if one answers),
// and with --open launches Chrome in a dedicated profile as an app window.
// H2: when the server is reused and a Worship Rig window pinged it recently (/api/heartbeat, every 15 s), no second
// window is opened — the URL is printed instead (a second window would play every note twice). If no window is
// alive (it was closed but the server kept running), one is opened. The page itself also holds a Web Lock, so a
// second window that does open anyway is read-only and muted.
// My Samples: user sample packs from ./user-samples and ~/Music/Worship Rig/Samples are served too
// (RIG_USER_SAMPLES or --user-samples replaces those folders).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { createServer, defaultUserSampleRoots } = require('./server.js');
const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { port: 8437, open: false, pads: null, app: path.join(here, 'app'), userSamples: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const eq = a.indexOf('=');
      if (eq >= 0) return a.slice(eq + 1);
      i += 1;
      return argv[i];
    };
    if (a === '--open') out.open = true;
    else if (a.startsWith('--port')) out.port = Number(val());
    else if (a.startsWith('--pads')) out.pads = val();
    else if (a.startsWith('--app')) out.app = val();
    else if (a.startsWith('--user-samples')) out.userSamples = val();
    else if (a === '-h' || a === '--help') out.help = true;
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) out.port = 8437;
  return out;
}

/** A window that pinged within this long counts as open. */
export const WINDOW_ALIVE_MS = 45000;

/** @param {{reused:boolean, clientSeenMsAgo?:number|null}} info @returns {boolean} */
export function shouldOpenWindow(info, wantOpen) {
  if (!wantOpen) return false;
  if (!info.reused) return true;
  return !(typeof info.clientSeenMsAgo === 'number' && info.clientSeenMsAgo >= 0 && info.clientSeenMsAgo < WINDOW_ALIVE_MS);
}

const CHROME_FLAGS = [
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--no-first-run',
  '--no-default-browser-check',
];

function has(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

function openChrome(url) {
  if (process.platform === 'darwin') {
    const profile = path.join(os.homedir(), 'Library', 'Application Support', 'Worship Rig Chrome');
    const chromeApp = ['/Applications/Google Chrome.app', path.join(os.homedir(), 'Applications/Google Chrome.app')];
    if (!chromeApp.some((p) => fs.existsSync(p))) {
      console.log('Google Chrome was not found. Install it from https://www.google.com/chrome/ and try again,');
      console.log(`or open this address in Chrome yourself: ${url}`);
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
      return;
    }
    const args = ['-na', 'Google Chrome', '--args', `--user-data-dir=${profile}`, `--app=${url}`, ...CHROME_FLAGS];
    spawn('open', args, { stdio: 'ignore', detached: true }).unref();
    return;
  }
  if (process.platform === 'linux') {
    const bin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(has);
    if (bin) {
      const profile = path.join(os.homedir(), '.config', 'worship-rig-chrome');
      spawn(bin, [`--user-data-dir=${profile}`, `--app=${url}`, ...CHROME_FLAGS], { stdio: 'ignore', detached: true }).unref();
      return;
    }
  }
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', 'chrome', `--app=${url}`, ...CHROME_FLAGS], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  console.log(`Open this address in Google Chrome: ${url}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node serve.mjs [--port 8437] [--open] [--pads <folder>] [--app <dir>] [--user-samples <dir>[:<dir>…]]');
    return;
  }
  const server = createServer({
    appDir: path.resolve(args.app),
    port: args.port,
    padsRoot: args.pads ? path.resolve(args.pads) : null,
    userSamples: args.userSamples ? defaultUserSampleRoots({ env: { RIG_USER_SAMPLES: args.userSamples } }) : true,
    log: (m) => console.log(`[worship-rig] ${m}`),
  });
  const info = await server.listen();
  const url = `http://127.0.0.1:${info.port}/`;
  if (info.reused) {
    console.log(`Worship Rig is already running at ${url}`);
  } else {
    console.log(`Worship Rig is running at ${url}`);
    if (info.port !== args.port) {
      console.log(`(port ${args.port} was busy with something else, so ${info.port} is used instead —`);
      console.log(' note: songs saved in Chrome are stored per address, so keep using the same port.)');
    }
    if (args.pads) console.log(`Pad folder: ${path.resolve(args.pads)}`);
    const mine = await server.rescanUserSamples().catch(() => null);
    if (mine && mine.count) console.log(`My Samples: ${mine.count} instrument(s) from ${mine.packs.map((p) => p.dir).join(', ')}`);
    console.log('Keep this window open while you play. Press Ctrl+C to stop.');
  }
  if (shouldOpenWindow(info, args.open)) openChrome(url);
  else if (args.open && info.reused) {
    console.log('A Worship Rig window is already open — switch to it (it may be behind other windows).');
    console.log(`If you can't find it, open ${url} in Chrome.`);
  }
  if (info.reused) return; // the other process keeps serving

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('\nStopping Worship Rig server…');
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`Worship Rig could not start: ${err && err.message}`);
    process.exit(1);
  });
}
