// Spawns rig-devhost for the JS-side tools and the opt-in e2e test (not a test file). Binary: `bin`, else
// $RIG_DEVHOST (a path), else native/core/build-t09/rig-devhost. Port 0 + the banner line gives the bound port.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '../../..');

/** The binary to use, or null when none is built. */
export function devhostBinary(bin) {
  const env = process.env.RIG_DEVHOST;
  const cands = [bin, env && env !== '1' ? env : null, path.join(REPO, 'native/core/build-t09/rig-devhost')];
  for (const c of cands) if (c && fs.existsSync(c)) return path.resolve(c);
  return null;
}

/**
 * @param {{bin?:string, extra?:string[], backend?:string}} [o]
 * @returns {Promise<{port:number, base:string, wsUrl:string, stderr:()=>string, stop:()=>Promise<number>}>}
 */
export function startDevhost({ bin, extra = [], backend = 'null' } = {}) {
  const exe = devhostBinary(bin);
  if (!exe) throw new Error('rig-devhost not built (cmake -S native/devhost -B native/core/build-t09)');
  const child = spawn(exe, ['--port', '0', '--backend', backend, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => {
    err += d;
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`rig-devhost did not start: ${err}`)), 15000);
    child.on('exit', (code) => reject(new Error(`rig-devhost exited ${code}: ${err}`)));
    child.stdout.on('data', (d) => {
      out += d;
      const m = /listening on http:\/\/([\d.]+):(\d+)\//.exec(out);
      if (!m) return;
      clearTimeout(timer);
      const port = Number(m[2]);
      resolve({
        port,
        base: `http://${m[1]}:${port}`,
        wsUrl: `ws://${m[1]}:${port}/__rig/ws`,
        stderr: () => err,
        stop: () => new Promise((r) => {
          if (child.exitCode !== null) return r(child.exitCode);
          child.removeAllListeners('exit');
          child.on('exit', (code) => r(code));
          child.kill('SIGTERM');
          return undefined;
        }),
      });
    });
  });
}
