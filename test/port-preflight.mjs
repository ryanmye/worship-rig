// L11-7: the suites bind fixed ports (8438 Electron, 8437 Chrome). A Worship Rig already running on the Mac (the
// installed app is a login item) holds 8438, so the test build falls back to 8439 and four shell tests fail for
// no app reason. Check before any suite starts and stop with a message that says what to quit.
import net from 'node:net';

/**
 * Resolves true when nothing listens on 127.0.0.1:port.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/**
 * Exits the process (code 2) when any of `ports` is taken, unless RIG_ALLOW_BUSY_PORT=1.
 * @param {number[]} ports
 * @param {string} who label for the message, e.g. 'run-all'
 */
export async function requirePortsFree(ports, who) {
  if (process.env.RIG_ALLOW_BUSY_PORT === '1') return;
  const busy = [];
  for (const p of ports) if (!(await portFree(p))) busy.push(p);
  if (!busy.length) return;
  console.error(`${who}: port ${busy.join(', ')} is already in use on 127.0.0.1. The suites need it free.\n` +
    'Usually a Worship Rig app or `npm start` / `npm run serve` is still running: quit it and run again.\n' +
    '(Find it with: lsof -nP -iTCP:' + busy[0] + ' -sTCP:LISTEN.) Set RIG_ALLOW_BUSY_PORT=1 to run anyway.');
  process.exit(2);
}
