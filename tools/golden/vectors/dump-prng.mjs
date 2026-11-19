#!/usr/bin/env node
// T01: reference vectors for the native PRNG port (native/core/src/num/prng.h, js_number.cpp), computed by the app's
// own modules (app/js/shared/prng.js, app/js/engine/fx.js rngFor/reverbBucket) inside the golden Chromium.
//
//   node tools/golden/vectors/dump-prng.mjs   → tools/golden/vectors/data/prng.txt
//
// Line formats (hex = exact binary64 bit pattern; strings are ASCII without spaces unless given as code units):
//   hash <string> <uint32>                    hashSeed(string)
//   hash16 <code units hex,comma-separated> <uint32>   hashSeed of a non-ASCII string
//   mul <seed uint32> <hex> <hex> ...         mulberry32(seed) first draws
//   rng <seed uint32> <op> <args> = <hex...>  one createRng helper call, in stream order per seed
//   rngfor <seed uint32> <name> <hex> ...     fx.js rngFor(seed, name) first draws
//   str <hex> <String(x)>                     JS Number::toString
//   u32 <hex> <uint32>                        x >>> 0
import fs from 'node:fs';
import path from 'node:path';
import { openPage, hex64, mulberry32, DATA } from './lib.mjs';

const OUT = path.join(DATA, 'prng.txt');
const { browser, page, server, version } = await openPage();

// Doubles for String(n) and >>> 0: engine-shaped values plus edge cases and a spread over every exponent.
const r = mulberry32(0x7a11);
const nums = [0, -0, 1, -1, 0.1, 0.2, 0.1 + 0.2, 1 / 3, 2 / 3, 44100, 48000, 96000, 22050, 1e21, 1e-7, 1e-6, 123e-20,
  9.999999999999999e20, 1e20, 0.000001, 0.0000001, 5e-324, 1.7976931348623157e308, 2 ** 53, 2 ** 53 + 2, 2 ** 31,
  2 ** 32, 2 ** 32 + 0.5, -(2 ** 31), -(2 ** 32) - 1, 4294967295.9, -0.5, -1.5, 1.5, 2.5, 100, 1e100, -1e-100,
  Infinity, -Infinity, NaN, 0.30000000000000004, 1.1, 1.15, 2.675, 123456789012345680000, 1.5e-9, 25e-8];
for (let d = 0; d <= 10; d++) nums.push(Math.round(d) / 10, d / 10, Math.round(d / 10 * 10) / 10);
for (const b of [1.5, 2.5, 3.5, 5, 8, 0.6, 0.9, 1.2, 1.8, 2.2, 3, 4, 6]) nums.push(b, b * 9 / 9);
for (let i = 0; i < 400; i++) {
  const e = Math.floor(r() * 120) - 60;
  nums.push((r() * 2 - 1) * 10 ** e, Math.round(r() * 1e6) / 1e3, (r() - 0.5) * 2 ** (Math.floor(r() * 2098) - 1074));
}

const res = await page.evaluate(async (nums) => {
  const prng = await import('/js/shared/prng.js');
  const fx = await import('/js/engine/fx.js');
  const b = new Float64Array(1);
  const u = new BigUint64Array(b.buffer);
  const hx = (v) => {
    b[0] = v;
    return u[0].toString(16).padStart(16, '0');
  };
  const out = [];
  // hashSeed: engine seed strings (fx.js:29, audio.js:620, fx.js:627 with irKey()) and generic ASCII
  const seeds = [0, 1, 7, 42, 12345, 0xdeadbeef, 0xffffffff];
  const names = ['drone', 'chorus', 'crackle', 'inst|0|sampler|salamander-piano|1', 'inst|3|synth|warm-pad|12',
    'inst|1|organ|gospel|7', 'drone-freeze|0|0', 'drone-freeze|9|1'];
  const strs = ['', 'a', 'abc', 'hello world', 'x'.repeat(100)];
  for (const s of seeds) for (const n of names) strs.push(`${s >>> 0}|${n}`);
  for (const sr of [44100, 48000]) {
    for (const size of [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1]) {
      for (const damp of [0, 0.25, 0.3, 0.5, 0.77, 1]) {
        const dq = Math.round(Math.min(1, Math.max(0, damp)) * 10) / 10;
        strs.push(`1|ir|${fx.reverbBucket(size)}|${dq}|${sr}`);
      }
    }
  }
  for (const s of strs) out.push(`hash ${s.replaceAll(' ', '_')} ${prng.hashSeed(s.replaceAll(' ', '_'))}`);
  for (const s of ['é', '♪ ♫', 'a\u0000b', '🎹 keys', 'ñandú|ir|1.5']) {
    const cu = [...Array(s.length)].map((_, i) => s.charCodeAt(i).toString(16)).join(',');
    out.push(`hash16 ${cu} ${prng.hashSeed(s)}`);
  }
  // mulberry32 streams
  for (const s of [0, 1, 2, 42, 0x7fffffff, 0x80000000, 0xffffffff, prng.hashSeed('1|drone')]) {
    const next = prng.mulberry32(s);
    out.push(`mul ${s >>> 0} ${Array.from({ length: 48 }, () => hx(next())).join(' ')}`);
  }
  // createRng helpers in a fixed op sequence per seed
  for (const s of [1, 99, 0xcafef00d]) {
    const g = prng.createRng(s);
    const rec = (op, args, vals) => out.push(`rng ${s} ${op} ${args.join(',') || '-'} = ${vals.map(hx).join(' ')}`);
    for (let i = 0; i < 4; i++) rec('next', [], [g.next()]);
    rec('range', [-3, 7.5], [g.range(-3, 7.5)]);
    rec('range', [100, 20], [g.range(100, 20)]);
    rec('int', [1, 6], [g.int(1, 6)]);
    rec('int', [6.5, 1.2], [g.int(6.5, 1.2)]);
    rec('int', [-10, 10], [g.int(-10, 10)]);
    for (let i = 0; i < 5; i++) rec('gaussian', [], [g.gaussian()]);
    rec('pick', [7], [[0, 1, 2, 3, 4, 5, 6].indexOf(g.pick([0, 1, 2, 3, 4, 5, 6]))]);
    rec('shuffle', [10], g.shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const f = g.fork();
    rec('fork', [], [f.seed, f.next(), f.next()]);
    rec('next', [], [g.next()]);
  }
  // rngFor (fx.js)
  for (const s of [1, 2, 4294967295]) {
    for (const n of ['drone', 'chorus', 'crackle', 'inst|0|sampler|salamander-piano|1']) {
      const g = fx.rngFor(s, n);
      out.push(`rngfor ${s} ${n} ${Array.from({ length: 6 }, () => hx(g.next())).join(' ')}`);
    }
  }
  for (const x of nums) out.push(`str ${hx(x)} ${String(x)}`);
  for (const x of nums) out.push(`u32 ${hx(x)} ${x >>> 0}`);
  return out;
}, nums);
await browser.close();
server.close();
fs.mkdirSync(DATA, { recursive: true });
const header = [`# PRNG / String(n) vectors from Chromium ${version} (tools/golden/vectors/dump-prng.mjs)`];
fs.writeFileSync(OUT, [...header, ...res].join('\n') + '\n');
console.log(`wrote ${OUT}: ${res.length} lines, ${fs.statSync(OUT).size} bytes`);
void hex64;
