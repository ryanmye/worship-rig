// Tiny static server for the engine tests (NOT the app's server.js): app/ at /, this folder at /__tests/,
// fixtures at /__fixtures/. Range-capable (206) so <audio> can seek.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon',
};

function resolve(urlPath) {
  const p = decodeURIComponent(urlPath.split('?')[0]);
  let base = path.join(ROOT, 'app');
  let rel = p;
  if (p.startsWith('/__tests/')) { base = HERE; rel = p.slice('/__tests'.length); }
  else if (p.startsWith('/__fixtures/')) { base = path.join(HERE, 'fixtures'); rel = p.slice('/__fixtures'.length); }
  else if (p.startsWith('/api/user-samples/')) { base = path.join(HERE, 'fixtures', 'user-samples'); rel = p.slice('/api/user-samples'.length); }
  const full = path.normalize(path.join(base, rel));
  if (!full.startsWith(base)) return null;
  return full;
}

// "My Samples" routes the way the app server is expected to serve them (CONTRACT_CHANGES "## engine-3" #5):
// /api/health advertises userSamples, /api/user-samples/** comes from fixtures/user-samples. /__nohealth/api/health
// answers without the flag (the engine must then not request that manifest at all).
function apiRoute(req, res) {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const json = (o) => {
    const b = JSON.stringify(o);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : b);
    return true;
  };
  if (p === '/api/health') return json({ ok: true, app: 'engine-tests', userSamples: true });
  if (p === '/__nohealth/api/health') return json({ ok: true, app: 'engine-tests' });
  return false;
}

export function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    if (apiRoute(req, res)) return;
    let file = resolve(req.url);
    if (file && fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (!file || !fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    const size = fs.statSync(file).size;
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
      let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : size - 1;
      end = Math.min(end, size - 1);
      if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
      res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || 8471);
  startServer(port).then(() => console.log(`engine test server on http://127.0.0.1:${port}/  (harness: /js/engine/test.html)`));
}
