import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, createRng, hashSeed } from '../../../app/js/shared/prng.js';

test('mulberry32 golden values (reference implementation, seed 1)', () => {
  const r = mulberry32(1);
  assert.equal(r(), 0.6270739405881613);
  assert.equal(r(), 0.002735721180215478);
  assert.equal(r(), 0.5274470399599522);
});

test('mulberry32 golden values seed 0 and 42 are stable', () => {
  const a = mulberry32(0);
  const b = mulberry32(42);
  const va = [a(), a(), a()];
  const vb = [b(), b(), b()];
  assert.deepEqual(va, GOLDEN_0);
  assert.deepEqual(vb, GOLDEN_42);
});

const GOLDEN_0 = [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197];
const GOLDEN_42 = [0.6011037519201636, 0.44829055899754167, 0.8524657934904099];

test('mulberry32 is deterministic and in [0,1)', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  for (let i = 0; i < 10000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

test('seeds: different seeds differ; numbers truncated to uint32; strings hashed', () => {
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
  assert.equal(mulberry32(1.9)(), mulberry32(1)());
  assert.equal(mulberry32(2 ** 32 + 5)(), mulberry32(5)());
  assert.equal(mulberry32(-1)(), mulberry32(0xffffffff)());
  assert.equal(mulberry32('hello')(), mulberry32(hashSeed('hello'))());
  assert.equal(mulberry32(NaN)(), mulberry32(0)());
  assert.equal(mulberry32(undefined)(), mulberry32(0)());
  assert.equal(hashSeed(''), 0x811c9dc5);
  assert.equal(hashSeed('a'), 0xe40c292c); // FNV-1a reference
});

test('createRng: next matches mulberry32, seed exposed, default seed 0', () => {
  const r = createRng(7);
  const m = mulberry32(7);
  assert.equal(r.seed, 7);
  for (let i = 0; i < 5; i++) assert.equal(r.next(), m());
  assert.equal(createRng().next(), mulberry32(0)());
  assert.equal(createRng('abc').seed, hashSeed('abc'));
});

test('range', () => {
  const r = createRng(3);
  for (let i = 0; i < 2000; i++) {
    const x = r.range(-2, 5);
    assert.ok(x >= -2 && x < 5);
  }
  const g = createRng(1);
  assert.equal(g.range(10, 20), 10 + 10 * 0.6270739405881613);
});

test('int is inclusive, covers both ends, handles swapped/fractional bounds', () => {
  const r = createRng(9);
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const x = r.int(1, 6);
    assert.ok(Number.isInteger(x) && x >= 1 && x <= 6);
    seen.add(x);
  }
  assert.equal(seen.size, 6);
  for (let i = 0; i < 200; i++) {
    const x = r.int(6, 1);
    assert.ok(x >= 1 && x <= 6);
    const y = r.int(0.5, 2.5); // → 1..2
    assert.ok(y === 1 || y === 2);
  }
  assert.equal(r.int(4, 4), 4);
});

test('gaussian: deterministic, finite, ~N(0,1), uses cached spare', () => {
  const a = createRng(11);
  const b = createRng(11);
  let sum = 0;
  let sq = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const x = a.gaussian();
    assert.equal(x, b.gaussian());
    assert.ok(Number.isFinite(x));
    sum += x;
    sq += x * x;
  }
  const mean = sum / N;
  const variance = sq / N - mean * mean;
  assert.ok(Math.abs(mean) < 0.03, `mean ${mean}`);
  assert.ok(Math.abs(variance - 1) < 0.05, `var ${variance}`);
  // Spare: two gaussians consume exactly two uniforms.
  const c = createRng(5);
  const m = mulberry32(5);
  c.gaussian();
  c.gaussian();
  m();
  m();
  assert.equal(c.next(), m());
});

test('gaussian golden values', () => {
  const r = createRng(1);
  const u1 = 1 - 0.6270739405881613;
  const u2 = 0.002735721180215478;
  const rad = Math.sqrt(-2 * Math.log(u1));
  assert.equal(r.gaussian(), rad * Math.cos(2 * Math.PI * u2));
  assert.equal(r.gaussian(), rad * Math.sin(2 * Math.PI * u2));
});

test('pick', () => {
  const r = createRng(2);
  const arr = ['a', 'b', 'c'];
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(r.pick(arr));
  assert.deepEqual([...seen].sort(), arr);
  assert.equal(r.pick([]), undefined);
  assert.equal(r.pick(null), undefined);
  assert.equal(createRng(1).pick([10, 20, 30, 40]), 30); // floor(0.627 * 4) = 2
});

test('shuffle returns a new permutation, deterministic, input untouched', () => {
  const src = [1, 2, 3, 4, 5, 6, 7, 8];
  const a = createRng(4).shuffle(src);
  const b = createRng(4).shuffle(src);
  assert.deepEqual(a, b);
  assert.notEqual(a, src);
  assert.deepEqual(src, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...a].sort((x, y) => x - y), src);
  assert.deepEqual(createRng(1).shuffle([]), []);
  assert.deepEqual(createRng(1).shuffle([9]), [9]);
  assert.deepEqual(createRng(1).shuffle('abc').sort(), ['a', 'b', 'c']); // iterables
});

test('fork gives an independent deterministic child', () => {
  const p1 = createRng(100);
  const p2 = createRng(100);
  const c1 = p1.fork();
  const c2 = p2.fork();
  assert.equal(c1.seed, c2.seed);
  assert.equal(c1.next(), c2.next());
  assert.equal(p1.next(), p2.next());
  assert.notEqual(c1.seed, 100);
});
