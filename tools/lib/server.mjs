// Tiny static server for the offline tools (NOT the app's server.js): app/ at /, tools/lib/ at /__lib/.
// The app's own URLs (engine at /js/engine/index.js, manifest at /samples/manifest.json) resolve exactly as in the app.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.css': 'text/css',
};

function resolve(urlPath) {
  const p = decodeURIComponent(urlPath.split('?')[0]);
  let base = path.join(ROOT, 'app');
  let rel = p;
  if (p.startsWith('/__lib/')) {
    base = HERE;
    rel = p.slice('/__lib'.length);
  }
  const full = path.normalize(path.join(base, rel));
  return full.startsWith(base) ? full : null;
}

export function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    const file = resolve(req.url);
    if (req.url === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain', connection: 'close' });
      return res.end('not found');
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': fs.statSync(file).size, 'cache-control': 'no-store', connection: 'close' });
    fs.createReadStream(file).pipe(res);
  });
  // No keep-alive and no request timeouts: a render keeps the page busy for minutes, and a reused idle socket then
  // got Node's 408 / a reset (audition organ-swell rendered untrimmed: "gain-trims.json unavailable (HTTP 408)").
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}
