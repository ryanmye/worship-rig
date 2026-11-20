#!/usr/bin/env node
// T01 / SETUP_REVIEW finding 14: what does V8's Math.* compute in the Chromium that rendered the goldens?
// Dumps Math.sin/cos/tan/exp/log/log2/log10/pow/tanh/atan/atan2/sqrt/cbrt/expm1 (+ sinh, used by eq-math, and
// Math.round / Math.fround) over deterministic inputs as exact hex doubles. The inputs mix generic coverage (random
// bit patterns per binade) with the argument ranges the engine uses (oscillator / IR phases, dB to gain, filter
// prewarp, setTarget decay, cents).
//
//   node tools/golden/vectors/dump-math.mjs                       → tools/golden/vectors/data/math.txt (committed)
//   node tools/golden/vectors/dump-math.mjs --n 100000 --out f    → a large investigation set (not committed)
//
// Format (one case per line): `<fn> <x hex> [<y hex>] <result hex>`; lines starting with '#' are comments. Every
// function is evaluated three times in the page (cold, then after warm-up loops) and the dump fails if the tiers
// disagree (Ignition / Sparkplug / Maglev / TurboFan must all call the same C implementation).
import fs from 'node:fs';
import path from 'node:path';
import { openPage, hex64, mulberry32, arg, DATA } from './lib.mjs';

const argv = process.argv.slice(2);
const N = Number(arg(argv, '--n', 500));
const OUT = arg(argv, '--out', path.join(DATA, 'math.txt'));

const ONE = ['sin', 'cos', 'tan', 'exp', 'log', 'log2', 'log10', 'tanh', 'atan', 'sqrt', 'cbrt', 'expm1', 'sinh',
  'round', 'fround'];
const TWO = ['pow', 'atan2'];

/** Random double with a uniformly chosen binade in [2^lo, 2^hi) and random mantissa bits (sign optional). */
function binade(rnd, lo, hi, signed) {
  const e = lo + Math.floor(rnd() * (hi - lo));
  const m = 1 + rnd() + rnd() * 2 ** -32; // 52+ random bits
  const v = m * 2 ** e;
  return signed && rnd() < 0.5 ? -v : v;
}
const uni = (rnd, a, b) => a + (b - a) * rnd();
const SR = [44100, 48000];

/** Engine-shaped inputs per function (each generator returns one input or [x, y]). */
const ENGINE = {
  // oscillator / LFO / IR phases: 2πk/n, 2π·f·t, equal-power x·π/2, Box–Muller 2πu
  sin: [(r) => 2 * Math.PI * r(), (r) => (Math.floor(r() * 64) / 63) * (Math.PI / 2),
    (r) => 2 * Math.PI * uni(r, 20, 8000) * (Math.floor(r() * 441000) / SR[Math.floor(r() * 2)]),
    (r) => (2 * Math.PI * Math.floor(r() * 4096)) / 4096, (r) => uni(r, -Math.PI, Math.PI)],
  // biquad cos(ω0), ω0 = 2πf/sr
  tan: [(r) => (Math.PI * uni(r, 10, 22050)) / SR[Math.floor(r() * 2)], (r) => uni(r, 0, Math.PI / 2)],
  // setTarget per-sample factor e^(−1/(τ sr)), decays e^(−dt/τ), IR envelopes e^(−6.9/(rt sr))
  exp: [(r) => -1 / (uni(r, 0.001, 2) * SR[Math.floor(r() * 2)]), (r) => -uni(r, 0, 12),
    (r) => -6.9 / (uni(r, 0.1, 12) * 44100), (r) => uni(r, -50, 50), (r) => -Math.floor(r() * 6) * 0.8],
  log: [(r) => 10 ** uni(r, -6, 6), (r) => uni(r, 1e-9, 1), (r) => 1 - r()],
  log2: [(r) => uni(r, 20, 20000) / 440, (r) => 2 ** uni(r, -2, 2)],
  log10: [(r) => 10 ** uni(r, -8, 3), (r) => uni(r, 0.01, 30)],
  tanh: [(r) => uni(r, -10, 10), (r) => uni(r, -1, 1) * uni(r, 1, 40)],
  atan: [(r) => uni(r, -50, 50)],
  sqrt: [(r) => uni(r, 0, 10), (r) => -2 * Math.log(1 - r())],
  cbrt: [(r) => uni(r, 0, 2) / 2],
  expm1: [(r) => uni(r, -1, 1)],
  sinh: [(r) => (Math.LN2 / 2) * uni(r, 0.05, 4)],
  // Math.round of dB/Hz/ms values and of exact halves; Math.fround of gains
  round: [(r) => uni(r, -100, 100) * 10, (r) => Math.floor(uni(r, -1e6, 1e6)) + 0.5, (r) => uni(r, -1, 1)],
  fround: [(r) => 10 ** uni(r, -6, 1), (r) => uni(r, -1, 1)],
  // dB → gain 10^(db/20), cents 2^(c/1200), exponential ramps (v1/v0)^x, glue makeup ^0.6, LPF sweep ratio^a
  pow: [(r) => [10, uni(r, -120, 24) / 20], (r) => [2, uni(r, -4800, 4800) / 1200],
    (r) => [uni(r, 1e-4, 20), uni(r, 0, 1)], (r) => [uni(r, 1, 30), 0.6], (r) => [3500 / 18000, uni(r, 0, 1)],
    (r) => [6, uni(r, 0, 1)], (r) => [uni(r, 0.01, 4), uni(r, -3, 3)]],
  atan2: [(r) => [uni(r, -1, 1), uni(r, -1, 1)]],
};
ENGINE.cos = ENGINE.sin;

/** Generic coverage: random binades across the function's useful domain, plus edge values. */
const GENERIC = {
  sin: (r) => binade(r, -30, 20, true), cos: (r) => binade(r, -30, 20, true), tan: (r) => binade(r, -30, 20, true),
  exp: (r) => uni(r, -745, 709.7), log: (r) => binade(r, -1074, 1024, false),
  log2: (r) => binade(r, -1000, 1000, false), log10: (r) => binade(r, -1000, 1000, false),
  tanh: (r) => binade(r, -30, 5, true), atan: (r) => binade(r, -30, 30, true),
  sqrt: (r) => binade(r, -1000, 1000, false), cbrt: (r) => binade(r, -1000, 1000, true),
  expm1: (r) => binade(r, -30, 9, true), sinh: (r) => binade(r, -30, 9, true),
  round: (r) => binade(r, -10, 60, true), fround: (r) => binade(r, -160, 130, true),
  pow: (r) => [binade(r, -20, 20, false), uni(r, -40, 40)],
  atan2: (r) => [binade(r, -20, 20, true), binade(r, -20, 20, true)],
};
const EDGES = [0, -0, 1, -1, 0.5, -0.5, 2.5, -2.5, 0.49999999999999994, 2 ** 52 + 1, 2, Math.PI, Math.PI / 2,
  Math.PI / 4, 1e-300, 5e-324, 710, -746, 1e300, Infinity, -Infinity, NaN];

function inputs(fn) {
  const r = mulberry32(0x5eed0000 + [...fn].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
  const out = [];
  const gens = ENGINE[fn];
  const nEngine = Math.ceil(N * 0.6);
  for (let i = 0; i < nEngine; i++) out.push(gens[i % gens.length](r));
  while (out.length < N) out.push(GENERIC[fn](r));
  if (TWO.includes(fn)) {
    for (const a of [0, 1, -1, 10, 2, 0.5]) for (const b of [0, 0.5, -0.5, 2, 1 / 3]) out.push([a, b]);
  } else {
    for (const e of EDGES) out.push(e);
  }
  return out;
}

const { browser, page, server, version } = await openPage();
const lines = [`# Math.* of V8 in Chromium ${version} (tools/golden/vectors/dump-math.mjs, n=${N} per function)`,
  '# <fn> <x> [<y>] <result>, IEEE-754 binary64 bit patterns in hex'];
let tierMismatch = 0;
for (const fn of [...ONE, ...TWO]) {
  const xs = inputs(fn);
  const res = await page.evaluate(([fn, xs, two]) => {
    const f = Math[fn];
    const b = new Float64Array(1);
    const u = new BigUint64Array(b.buffer);
    const hx = (v) => {
      b[0] = v;
      return u[0].toString(16).padStart(16, '0');
    };
    const run = () => (two ? xs.map(([x, y]) => hx(f(x, y))) : xs.map((x) => hx(f(x))));
    const a = run();
    let sink = 0;
    for (let k = 0; k < 20; k++) for (let i = 0; i < xs.length; i++) sink += two ? f(xs[i][0], xs[i][1]) : f(xs[i]);
    const b2 = run();
    // a hot inlined call site (TurboFan / Maglev lower Math.fn to a C call; must be the same function)
    const hot = new Array(xs.length);
    for (let k = 0; k < 5; k++) {
      for (let i = 0; i < xs.length; i++) hot[i] = two ? Math[fn](xs[i][0], xs[i][1]) : Math[fn](xs[i]);
    }
    const c = hot.map(hx);
    let bad = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b2[i] || a[i] !== c[i]) bad++;
    return { r: a, bad, sink: Number.isFinite(sink) };
  }, [fn, xs, TWO.includes(fn)]);
  tierMismatch += res.bad;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    lines.push(Array.isArray(x) ? `${fn} ${hex64(x[0])} ${hex64(x[1])} ${res.r[i]}` : `${fn} ${hex64(x)} ${res.r[i]}`);
  }
  console.log(`${fn}: ${xs.length} cases, tier mismatches ${res.bad}`);
}
await browser.close();
server.close();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`wrote ${OUT} (${fs.statSync(OUT).size} bytes), Chromium ${version}, tier mismatches ${tierMismatch}`);
if (tierMismatch) process.exitCode = 1;
