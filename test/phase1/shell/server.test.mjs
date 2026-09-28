import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createServer, parseRange, mimeFor } = require('../../../server.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-server-'));
const appDir = path.join(tmp, 'app');
const padsDir = path.join(tmp, 'pads');
const BIN = Buffer.alloc(1000, 0).map((_, i) => i % 256);
const port = 20000 + Math.floor(Math.random() * 20000);
let srv;

function req(p, { method = 'GET', headers = {}, port: pt = port } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: pt, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}

before(async () => {
  fs.mkdirSync(path.join(appDir, 'js', 'worklets'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'samples', 'piano'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'index.html'), '<!doctype html><title>t</title>');
  fs.writeFileSync(path.join(appDir, 'js', 'a.js'), 'export const a = 1;');
  fs.writeFileSync(path.join(appDir, 'js', 'worklets', 'w.mjs'), '//');
  fs.writeFileSync(path.join(appDir, 'manifest.webmanifest'), '{}');
  fs.writeFileSync(path.join(appDir, 'samples', 'piano', 'C4.mp3'), BIN);
  fs.writeFileSync(path.join(appDir, '.secret'), 'x');
  fs.writeFileSync(path.join(tmp, 'outside.txt'), 'top secret');
  fs.mkdirSync(path.join(padsDir, 'Worship Pads', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(padsDir, 'Pad - C.mp3'), BIN);
  fs.writeFileSync(path.join(padsDir, 'Worship Pads', 'F#m Pad.wav'), BIN);
  fs.writeFileSync(path.join(padsDir, 'Worship Pads', 'deep', 'Bb.flac'), BIN);
  fs.writeFileSync(path.join(padsDir, 'notes.txt'), 'nope');
  fs.writeFileSync(path.join(padsDir, '.hidden.mp3'), BIN);
  fs.writeFileSync(path.join(tmp, 'outside.mp3'), BIN);
  srv = createServer({ appDir, port, padsRoot: padsDir });
  const info = await srv.listen();
  assert.equal(info.port, port);
  assert.equal(info.reused, false);
});
after(async () => {
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('parseRange unit cases', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=990-2000', 1000), { start: 990, end: 999 });
  assert.deepEqual(parseRange('bytes=1000-', 1000), { unsatisfiable: true });
  assert.deepEqual(parseRange('bytes=50-10', 1000), { unsatisfiable: true });
  assert.deepEqual(parseRange('bytes=abc', 1000), { unsatisfiable: true });
  assert.equal(parseRange('items=0-1', 1000), null);
  assert.equal(parseRange('bytes=0-1,5-6', 1000), null);
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(mimeFor('x.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(mimeFor('x.MP3'), 'audio/mpeg');
});

test('health endpoint', async () => {
  const r = await req('/api/health');
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.ok, true);
  assert.equal(j.app, 'worship-rig');
});

test('MIME types and cache headers', async () => {
  const cases = [
    ['/', 'text/html; charset=utf-8', 'no-cache'],
    ['/js/a.js', 'text/javascript; charset=utf-8', 'no-cache'],
    ['/js/worklets/w.mjs', 'text/javascript; charset=utf-8', 'no-cache'],
    ['/manifest.webmanifest', 'application/manifest+json; charset=utf-8', 'no-cache'],
    ['/samples/piano/C4.mp3', 'audio/mpeg', 'public, max-age=604800'],
  ];
  for (const [p, type, cache] of cases) {
    const r = await req(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['content-type'], type, p);
    assert.equal(r.headers['cache-control'], cache, p);
    assert.equal(r.headers['accept-ranges'], 'bytes', p);
  }
  const fav = await req('/favicon.ico');
  assert.equal(fav.status, 204, 'missing favicon is not a console error');
});

test('Range: 206 with Content-Range/Length, suffix, open-ended, 416, HEAD, 304', async () => {
  const r = await req('/samples/piano/C4.mp3', { headers: { Range: 'bytes=100-199' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], 'bytes 100-199/1000');
  assert.equal(r.headers['content-length'], '100');
  assert.deepEqual([...r.body], [...BIN.subarray(100, 200)]);
  const s = await req('/samples/piano/C4.mp3', { headers: { Range: 'bytes=-10' } });
  assert.equal(s.status, 206);
  assert.equal(s.headers['content-range'], 'bytes 990-999/1000');
  const o = await req('/samples/piano/C4.mp3', { headers: { Range: 'bytes=995-' } });
  assert.equal(o.body.length, 5);
  const bad = await req('/samples/piano/C4.mp3', { headers: { Range: 'bytes=5000-6000' } });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers['content-range'], 'bytes */1000');
  const h = await req('/samples/piano/C4.mp3', { method: 'HEAD' });
  assert.equal(h.status, 200);
  assert.equal(h.headers['content-length'], '1000');
  assert.equal(h.body.length, 0);
  const etag = h.headers.etag;
  const nm = await req('/samples/piano/C4.mp3', { headers: { 'If-None-Match': etag } });
  assert.equal(nm.status, 304);
});

test('traversal, dotfiles and foreign hosts are blocked', async () => {
  for (const p of ['/../outside.txt', '/%2e%2e/outside.txt', '/js/..%2f..%2foutside.txt', '/.secret', '/js/%00a.js', '/..%5coutside.txt']) {
    const r = await req(p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.body.toString().includes('top secret'), p);
  }
  const evil = await req('/', { headers: { Host: 'evil.example:8437' } });
  assert.equal(evil.status, 403);
  const post = await req('/', { method: 'POST' });
  assert.equal(post.status, 405);
});

test('/api/pads lists audio files recursively; /pads/<token>/ serves them with Range; traversal blocked', async () => {
  const r = await req('/api/pads');
  assert.equal(r.status, 200);
  const list = JSON.parse(r.body);
  assert.deepEqual(list.map((x) => x.path), ['Pad - C.mp3', 'Worship Pads/deep/Bb.flac', 'Worship Pads/F#m Pad.wav']);
  assert.deepEqual(list.map((x) => x.name), ['Pad - C.mp3', 'Bb.flac', 'F#m Pad.wav']);
  const base = srv.padsBaseUrl();
  assert.ok(list.every((x) => x.url.startsWith(base)));
  assert.equal(list[2].url, `${base}Worship%20Pads/F%23m%20Pad.wav`);
  const g = await req(list[2].url, { headers: { Range: 'bytes=0-9' } });
  assert.equal(g.status, 206);
  assert.equal(g.headers['content-type'], 'audio/wav');
  assert.equal(g.headers['content-range'], 'bytes 0-9/1000');
  for (const p of [`${base}../outside.mp3`, `${base}%2e%2e/outside.mp3`, `${base}..%2Foutside.mp3`, `${base}notes.txt`, `${base}.hidden.mp3`, '/pads/wrongtoken/Pad%20-%20C.mp3']) {
    const x = await req(p);
    assert.equal(x.status, 404, p);
  }
  // token rotates when the folder changes; old URLs stop working
  const oldUrl = list[0].url;
  srv.setPadsRoot(padsDir);
  assert.equal((await req(oldUrl)).status, 404);
  srv.setPadsRoot(path.join(tmp, 'unplugged-drive'));
  const missing = await req('/api/pads');
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.body), { error: 'missing' });
  srv.setPadsRoot(null);
  assert.deepEqual(JSON.parse((await req('/api/pads')).body), []);
  srv.setPadsRoot(padsDir);
});

test('listen(): reuses a running Worship Rig server; skips a foreign one', async () => {
  const again = createServer({ appDir, port });
  const info = await again.listen();
  assert.deepEqual([info.port, info.reused], [port, true]);
  await again.close();
  const foreignPort = port + 100;
  const foreign = http.createServer((q, s) => s.end('not us'));
  await new Promise((r) => foreign.listen(foreignPort, '127.0.0.1', r));
  const s2 = createServer({ appDir, port: foreignPort });
  const i2 = await s2.listen();
  assert.equal(i2.reused, false);
  assert.equal(i2.port, foreignPort + 1);
  assert.deepEqual(i2.tried, [foreignPort, foreignPort + 1]);
  await s2.close();
  await new Promise((r) => foreign.close(r));
});
