// v11-memory: BufferCache's switch headroom (engine/sampler.js). Once the engine sets `protect` (the playing and the
// incoming song), the 700 MB cap is hard: unpinned buffers go first (LRU, to the low-water mark), then pinned buffers
// outside `protect`, LRU, only until the cap holds. Referenced buffers never go (gapless rule). With `protect` null
// (no song prepared yet) pins stay absolute, as before. Pure cache logic: entries are seeded by hand, the one decode
// is a stubbed _load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BufferCache } from '../../../app/js/engine/sampler.js';

const MB = 1024 * 1024;
const fakeBuf = (mb) => ({ numberOfChannels: 2, length: (mb * MB) / 8, sampleRate: 44100 });

/** A 100 MB cache with entries {key: mb}, lastUsed in insertion order. */
function cacheOf(entries, cap = 100) {
  const c = new BufferCache({ capBytes: cap * MB });
  let t = 0;
  for (const [key, mb] of Object.entries(entries)) {
    c.entries.set(key, { buffer: fakeBuf(mb), bytes: mb * MB, refs: new Set(), lastUsed: ++t });
    c.bytes += mb * MB;
    c.sizes.set(key, mb * MB);
  }
  c._tick = t;
  return c;
}

test('protect null: pins are absolute (pre-v11 rule), the cache may sit over its cap', () => {
  const c = cacheOf({ a: 40, b: 40, c: 40 });
  c.setPins(['a', 'b', 'c']);
  assert.equal(c.decodedMB, 120, 'nothing evictable');
});

test('protect set: unpinned go first, then pinned outside protect (LRU), only until the cap holds', () => {
  const c = cacheOf({ old1: 30, old2: 30, free: 20, cur: 30 });
  c.protect = new Set(['cur']);
  c.setPins(['old1', 'old2', 'cur']);
  assert.equal(c.entries.has('free'), false, 'the unpinned buffer goes first');
  assert.equal(c.decodedMB, 90, 'under the cap: no pinned buffer had to go');
  c.entries.set('new', { buffer: fakeBuf(25), bytes: 25 * MB, refs: new Set(), lastUsed: ++c._tick });
  c.bytes += 25 * MB;
  c.protect.add('new'); // the incoming song's (unpinned, not yet referenced) copy is not a victim either
  c._evict();
  assert.equal(c.entries.has('new'), true);
  assert.equal(c.entries.has('old1'), false, 'LRU pinned buffer outside protect evicted');
  assert.equal(c.entries.has('old2'), true, 'just enough: the second one stays');
  assert.equal(c.decodedMB, 85);
  assert.equal(c.pinned.has('old1'), true, 'its pin stays (a later preload / rewarm decodes it again)');
  assert.equal(c.evictedPinned, 1);
});

test('referenced and protected buffers are never evicted, even over the cap', () => {
  const c = cacheOf({ held: 60, cur: 60, other: 10 });
  c.entries.get('held').refs.add({}); // a retiring instrument with a held note
  c.protect = new Set(['cur']);
  c.setPins(['cur', 'other']);
  assert.equal(c.entries.has('other'), false);
  assert.equal(c.entries.has('held'), true);
  assert.equal(c.entries.has('cur'), true);
  assert.equal(c.decodedMB, 120, 'over the cap only by referenced + protected bytes');
  assert.equal(c.referencedBytes, 60 * MB);
});

test('a protected long key also protects through its legacy key (stand-in)', () => {
  const c = cacheOf({ '/s/A1.mp3#max=30': 60, x: 50 });
  c.superseded.set('/s/A1.mp3', '/s/A1.mp3#max=30');
  c.supersededBy.set('/s/A1.mp3#max=30', '/s/A1.mp3');
  c.protect = new Set(['/s/A1.mp3']);
  c.setPins(['/s/A1.mp3', 'x']);
  assert.equal(c.entries.has('/s/A1.mp3#max=30'), true);
  assert.equal(c.entries.has('x'), false);
});

test('acquire makes room before inserting: decodedMB never passes the cap by the new buffer', async () => {
  const c = cacheOf({ old: 50, cur: 45 });
  c.protect = new Set(['cur', '/new.mp3']);
  c.setPins(['old', 'cur']);
  const peak = [];
  const orig = c._deleteEntry.bind(c);
  c._deleteEntry = (k) => {
    peak.push(c.bytes);
    orig(k);
  };
  const raw = { numberOfChannels: 2, length: (10 * MB) / 8, sampleRate: 44100 };
  c._load = async () => raw; // a decoded 10 MB buffer (no fetch / decodeAudioData in node)
  const buf = await c.acquire('/new.mp3', null, 60, {}, undefined);
  assert.equal(buf, raw);
  assert.ok(c.bytes <= c.capBytes, `${c.decodedMB} MB ≤ cap`);
  assert.equal(c.entries.has('old'), false, 'the old song’s pinned buffer gave way');
  assert.deepEqual(peak, [95 * MB], 'evicted before the insert (95 + 10 never held)');
});

test('roomFor: only unpinned, unreferenced bytes count as room', () => {
  const c = cacheOf({ p: 60, u: 30 });
  c.setPins(['p']);
  assert.equal(c.roomFor(35 * MB), true, '90 + 35 − 30 unpinned = 95 ≤ 100');
  assert.equal(c.roomFor(45 * MB), false, 'would need the pinned one');
});
