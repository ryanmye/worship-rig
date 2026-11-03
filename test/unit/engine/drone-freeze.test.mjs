// CI-1: the frozen drone's seam crossfade keeps the level whatever the head/tail correlation (engine/drone-freeze.js
// makeSeamlessLoop, seamCorrelation). A steady drone's head and tail are coherent: the old equal-power fade dug a
// −5.8 dB hole mid-seam on the macos-14 runner's 48 kHz render (ρ ≈ −0.74) and bumped +1 dB on another voicing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSeamlessLoop, seamCorrelation } from '../../../app/js/engine/drone-freeze.js';
import { createRng } from '../../../app/js/shared/prng.js';

const SR = 8000;
const START = 1000;
const LOOP = SR; // 1 s
const XF = 2000;

/** a·sin(2π f t) + uniform noise in [−nAmp, nAmp], long enough for the loop and the tail after it */
function signal(f, a, nAmp, seed = 7) {
  const rng = createRng(seed);
  const c = new Float32Array(START + LOOP + XF);
  for (let i = 0; i < c.length; i++) c[i] = a * Math.sin((2 * Math.PI * f * i) / SR) + nAmp * rng.range(-1, 1);
  return c;
}
const power = (c, a, b) => {
  let s = 0;
  for (let i = a; i < b; i++) s += c[i] * c[i];
  return s / (b - a);
};
const db = (x) => 10 * Math.log10(x);

/** the old fade (g = 1), for the comparison */
function equalPowerOnly(c) {
  const w = Math.PI / 2 / XF;
  for (let i = 0; i < XF; i++) c[START + i] = c[START + i] * Math.sin(i * w) + c[START + LOOP + i] * Math.cos(i * w);
  return c.subarray(START, START + LOOP);
}

// 100.5 Hz over a 1 s lag: the tail is the head in anti-phase; 50 Hz: in phase
const CASES = [
  { name: 'anti-correlated (ρ ≈ −0.6)', f: 100.5, a: 1, n: 1, rho: [-0.7, -0.5] },
  { name: 'correlated (ρ ≈ +0.6)', f: 50, a: 1, n: 1, rho: [0.5, 0.7] },
  { name: 'in phase (ρ ≈ 1)', f: 50, a: 1, n: 0, rho: [0.99, 1] },
  { name: 'uncorrelated noise (ρ ≈ 0)', f: 50, a: 0, n: 1, rho: [-0.05, 0.05] },
];

for (const k of CASES) {
  test(`seam level: ${k.name}: mid-seam power within 1 dB of the body`, () => {
    const c = signal(k.f, k.a, k.n);
    const rho = seamCorrelation(c, START, LOOP, XF);
    assert.ok(rho >= k.rho[0] && rho <= k.rho[1], `ρ = ${rho}`);
    const body = power(c, START + XF, START + LOOP);
    const tail0 = c[START + LOOP];
    const headAfter = c[START + XF];
    const loop = makeSeamlessLoop([c], START, LOOP, XF)[0];
    const mid = power(loop, Math.round(XF * 0.4), Math.round(XF * 0.6));
    assert.ok(Math.abs(db(mid / body)) <= 1, `mid ${db(mid / body).toFixed(2)} dB vs body (ρ ${rho.toFixed(2)})`);
    // the wrap plays the rendered continuation, and the fade ends on the loop's own head
    assert.equal(loop[0], tail0);
    assert.equal(loop[XF], headAfter);
  });
}

test('seam level: the old equal-power fade misses on correlated material (what CI-1 fixed)', () => {
  const anti = equalPowerOnly(signal(100.5, 1, 1));
  const body = power(anti, XF, LOOP);
  assert.ok(db(power(anti, Math.round(XF * 0.4), Math.round(XF * 0.6)) / body) < -3);
  const inPhase = equalPowerOnly(signal(50, 1, 0));
  assert.ok(db(power(inPhase, Math.round(XF * 0.4), Math.round(XF * 0.6)) / power(inPhase, XF, LOOP)) > 2.5);
});

test('seamCorrelation: silent side → 0; clamped to [−0.9, 1]', () => {
  const c = new Float32Array(START + LOOP + XF);
  assert.equal(seamCorrelation(c, START, LOOP, XF), 0);
  const anti = signal(100.5, 1, 0);
  assert.equal(seamCorrelation(anti, START, LOOP, XF), -0.9);
});
