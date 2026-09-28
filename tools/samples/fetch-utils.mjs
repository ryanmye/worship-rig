// Small concurrency-limited fetch-to-file helper with retry/backoff, shared by
// the download scripts. Uses global fetch (Node 22) through the environment's
// HTTPS_PROXY; never touches TLS verification settings.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

// Downloads `url` to `destPath`. Returns {ok:true, bytes} / {ok:false, status}
// (404) / throws after exhausting retries for other failures.
export async function fetchToFile(url, destPath, { retries = 3, backoffMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) {
        return { ok: false, status: 404, url };
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(dirname(destPath), { recursive: true });
      await writeFile(destPath, buf);
      return { ok: true, bytes: buf.length, url };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(backoffMs * Math.pow(2, attempt));
      }
    }
  }
  throw new Error(`Failed to fetch ${url} after ${retries + 1} attempts: ${lastErr?.message}`);
}

export async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Runs `tasks` (array of () => Promise) with at most `limit` in flight.
export async function runPool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
