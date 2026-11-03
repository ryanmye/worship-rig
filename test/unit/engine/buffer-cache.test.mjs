// v11-polish (BACKLOG B memory, sustain-critic R1): the leaner long-cap swap in BufferCache (engine/sampler.js).
// A legacy-cap copy (neighbour preload) and the long variant of the same file are never both kept: the long buffer
// stands in for the legacy key (has / acquire / pins / estimates). Pure cache logic: entries are seeded by hand and
// fetch must never run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BufferCache } from '../../../app/js/engine/sampler.js';

const MB = 1024 * 1024;
const URL = '/samples/piano/A1.flac';
const LONG = `${URL}#max=30`;
const fakeBuf = (mb) => ({ numberOfChannels: 2, length: (mb * MB) / 8, sampleRate: 44100 });

/** A cache holding `URL` (legacy, 4 MB) and/or `LONG` (5 MB) as if decoded; fetch throws if anything decodes. */
function cacheWith({ legacy = true, long = true, cap = 700 } = {}) {
  const c = new BufferCache({ capBytes: cap * MB });
  globalThis.fetch = () => {
    throw new Error('no decode expected');
  };
  const put = (key, mb) => {
    const buffer = fakeBuf(mb);
    c.entries.set(key, { buffer, bytes: mb * MB, refs: new Set(), lastUsed: 0 });
    c.bytes += mb * MB;
    c.sizes.set(key, mb * MB);
  };
  if (legacy) put(URL, 4);
  if (long) {
    put(LONG, 5);
    c.longKeys.set(URL, new Set([LONG]));
  }
  return c;
}

test('supersede: the legacy copy goes once its owner moved to the long one; the long buffer stands in', async () => {
  const c = cacheWith();
  const inst = {};
  c.entries.get(URL).refs.add(inst);
  c.pin([URL]); // the old neighbour window still pins the legacy key
  c.supersede(URL, LONG, inst);
  assert.equal(c.entries.has(URL), false, 'legacy copy deleted although pinned');
  assert.equal(c.decodedMB, 5, 'only the long buffer is held');
  assert.equal(c.has(URL), true, 'has(url) answers through the long buffer');
  assert.equal(c.pinnedMB, 5, 'the legacy pin holds the long buffer');
  const buf = await c.acquire(URL, null, 33, {}, undefined);
  assert.equal(buf, c.entries.get(LONG).buffer, 'acquire(legacy) returns the long buffer, no decode');
  assert.equal(c.estimateBytes([URL, LONG]).bytes, 5 * MB, 'estimate counts the long buffer once');
});

test('supersede keeps a legacy copy another instrument still plays', () => {
  const c = cacheWith();
  const a = {};
  const b = {};
  c.entries.get(URL).refs.add(a);
  c.entries.get(URL).refs.add(b);
  c.supersede(URL, LONG, a);
  assert.equal(c.entries.has(URL), true);
  assert.equal(c.decodedMB, 9);
});

test('a legacy request (neighbour preload) for a file whose long variant is held reuses it', async () => {
  const c = cacheWith({ legacy: false });
  const buf = await c.acquire(URL, null, 33, null, undefined);
  assert.equal(buf, c.entries.get(LONG).buffer);
  assert.equal(c.decodedMB, 5, 'no second, shorter copy');
  c.setPins([URL]);
  assert.equal(c.pinnedMB, 5);
  assert.equal(c.estimateBytes([URL]).bytes, 5 * MB, 'the pin budget prices it at the long size');
});

test('eviction: a legacy pin protects its stand-in; without it the long buffer is evictable and the link goes', () => {
  const c = cacheWith({ legacy: false, cap: 1 }); // 5 MB held over a 1 MB cap: anything unprotected goes
  c.superseded.set(URL, LONG);
  c.supersededBy.set(LONG, URL);
  c.setPins([URL]);
  assert.equal(c.entries.has(LONG), true, 'pinned through the legacy key');
  c.setPins([]);
  assert.equal(c.entries.has(LONG), false, 'evicted once unpinned');
  assert.equal(c.has(URL), false);
  assert.equal(c.superseded.size + c.supersededBy.size, 0, 'no dangling stand-in link');
});
