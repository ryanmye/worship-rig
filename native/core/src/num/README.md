# src/num: bit-exact numerics (M5, T01)

What the golden renders (Chromium 157.0.8103.78, V8 15.7, x86-64 Linux, glibc 2.39, CPU with FMA) actually compute,
and the native code that reproduces it on any platform.

| file | what |
|---|---|
| `js_math.h` | `rig::js::*` = JavaScript `Math.*`; `rig::fdlibm::*` = Chromium `third_party/fdlibm` (Blink C++) |
| `js_math_llvm.cpp` | sin cos tan exp log log2 log10 expm1 cbrt atan atan2 over LLVM libc; sinh cosh (V8 15.7), sqrt, round, fround |
| `llvm_libc/` | vendored LLVM libc subset, unmodified, Apache-2.0 WITH LLVM-exception (`LICENSE.TXT`), see below |
| `js_pow.cpp`, `js_pow_data.inc` | Math.pow = V8 `math::pow` wrapper + glibc 2.39 `__pow_fma` (ARM optimized-routines v23.01, MIT) |
| `js_tanh.cpp` | Math.tanh = glibc 2.39 `__tanh_fma` + `__expm1_fma` (fdlibm, Sun notice) |
| `fdlibm.cpp`, `fdlibm_embed.h`, `fdlibm_v8.inc` | `rig::fdlibm`: the vendored V8 12.4 `third_party/v8_ieee754/ieee754.cc` |
| `prng.h`, `hash_seed.h` | `hashSeed` (FNV-1a over UTF-16 units), `mulberry32`, `Rng` (createRng helpers), `rngFor`, `toUint32` |
| `js_number.{h,cpp}` | JS `String(n)` (Number::toString) for seed strings and keys |
| `num.cmake` | build hook: `-isystem llvm_libc` for `js_math_llvm.cpp` |

Vectors: `tools/golden/vectors/dump-{math,prng}.mjs` → `tools/golden/vectors/data/{math,prng}.txt`, tested by
`tests/num_math_test.cpp`, `tests/num_prng_test.cpp` (bit-exact, every case).

## Which library is behind Math.* in Chromium 157 (finding 14)

Source (V8 15.7-lkgr `src/base/ieee754.cc`, `src/numbers/ieee754.cc`, `src/flags/flag-definitions.h`): V8 no longer
uses fdlibm for most of Math. `sin cos tan exp log log2 log10 log1p expm1 cbrt atan atan2 asin acos` forward to LLVM
libc `shared::*`; `Math.pow` is `std::pow` (flag `use_std_math_pow`, default true off AIX) after V8's special cases;
`Math.tanh` is `std::tanh`; `sinh`/`cosh` are V8 code over the LLVM `expm1`/`exp`. `std::*` is the system libm:
glibc 2.39, whose x86-64 build picks `__pow_fma` / `__tanh_fma` / `__expm1_fma` by ifunc on FMA CPUs.

Measured on 1e5 inputs per function (`dump-math.mjs --n 100000`: engine argument ranges + random binades + edges),
mismatches against the golden Chromium / max error in ulp:

| fn | (a) vendored V8 12.4 fdlibm | (b) glibc 2.39 here (FMA ifuncs) | (b') glibc, FMA ifuncs off | (c) correctly rounded (MPFR) | chosen → result |
|---|---|---|---|---|---|
| sin | 3097 / 1 | 105 / 1 | | 0 | LLVM libc → 0 |
| cos | 2658 / 1 | 103 / 1 | | 0 | LLVM libc → 0 |
| tan | 3021 / 1 | 204 / 1 | | 0 | LLVM libc → 0 |
| exp | 8238 / 1 | 58 / 1 | | 0 | LLVM libc → 0 |
| log | 3514 / 1 | 39 / 1 | | 0 | LLVM libc → 0 |
| log2 | 477 / 1 | 67 / 1 | | 0 | LLVM libc → 0 |
| log10 | 3500 / 2 | 3410 / 2 | | 0 | LLVM libc → 0 |
| expm1 | 6482 / 1 | 6424 / 1 | 6483 / 1 | 0 | LLVM libc → 0 |
| cbrt | 8412 / 1 | 52937 / 3 | | 0 | LLVM libc → 0 |
| atan | 1853 / 1 | 139 / 1 | | **113 / 1** (tiny \|x\|: V8 returns x) | LLVM libc, non-FMA path → 0 (FMA path: 157 / 1) |
| atan2 | 17673 / 1 | 78 / 1 | | 0 | LLVM libc → 0 |
| sqrt | 0 | 0 | | 0 | IEEE sqrt → 0 |
| pow | 9812 / 1 | **0** | 72 / 1 | 89 / 1 | glibc `__pow_fma` port → 0 |
| tanh | 436 / 2 | **0** | 15 / 2 | 13817 / 2 | glibc `__tanh_fma` port → 0 |
| sinh | 5769 / 2 | 5255 / 2 | 5294 / 2 | 24017 / 2 | V8 15.7 sinh over LLVM → 0 |
| round, fround | | | | | exact → 0 |

Also: every function returns identical bits from a cold call, a warmed-up call and a hot-loop call site (the dumper
checks; which V8 tiers actually ran is not observed). The final `rig::js` was re-run on the 1.5 M investigation cases
with g++ 13 and clang 18, each with and without `-mfma -mavx2`: 0 mismatches. `js_pow`/`js_tanh` additionally
agree with this box's glibc on 3e7 random inputs each.

Why the explicit `std::fma` in `js_pow.cpp` / `js_tanh.cpp`: glibc's FMA variants are compiled with GCC's default
`-ffp-contract=fast`, so GCC fused multiply-adds the source does not spell out (18 in pow, 12 in expm1, read from
`gcc -O2 -mfma -mavx2 -fdump-tree-widening_mul-lineno` of the same sources; a rebuild that way matches glibc on 2e7
inputs, one with only the explicit `fma()` calls differs in 14020). Each fusion is now a `std::fma` and the files
build with `-ffp-contract=off`, so x86 without FMA, arm64 and any compiler give the same bits.

`rig::fdlibm` (V8 12.4 fdlibm) is not what JavaScript runs any more, but it is exactly Chromium's
`third_party/fdlibm` (function bodies diffed against the 157.0.8103.78 copy), which Blink's Web Audio C++ calls:
`AudioParamHandler` exponential ramps (`fdlibm::pow`), setTarget start values and
`DiscreteTimeConstantForSampleRate` (`fdlibm::exp`). Verified indirectly by the 45 bit-exact AudioParam curves.
Kernel ports (biquad, compressor, oscillator, …) should check their Chromium source for `fdlibm::` calls and use
`rig::fdlibm` there, `rig::js` for anything computed in JavaScript, and never `<cmath>` transcendental functions on a
parity path.

## Where bit-exactness is impossible or conditional

- **The oracle depends on the rendering machine.** Math.pow/tanh are glibc ifunc variants: Chromium on an x86 CPU
  without FMA gives other bits (72 pow / 15 tanh cases in 1e5 at 1 ulp), and Chromium on macOS uses Apple libm for
  `std::pow`/`std::tanh`. The port reproduces the FMA-CPU Linux goldens; goldens re-rendered elsewhere can differ by
  1 ulp in pow/tanh-derived values (the golden manifest should record the CPU flags / OS; it records the Chromium
  version only).
- **Exact-tier consequence:** none expected for float32 audio (a 1-ulp double error changes the float32 result with
  probability ≈ 2^-29 per value), but double-precision accumulators fed by pow/tanh (IR generator envelopes and
  filter state, contract §3.4) are bit-exact only with this port; any other libm drifts.
- **FTZ/DAZ:** `rig::js` follows IEEE subnormals; JS runs them on the main thread without flush-to-zero. Call them
  outside `rt::RenderScope` when a table or IR must match JS for subnormal intermediates.
- Not ported (no engine use): Math.asin/acos/log1p/asinh/acosh/atanh/hypot/cosh-hard-cases. `rig::fdlibm` has
  asin/acos/log1p, which are NOT what V8 15.7 runs.

## llvm_libc provenance

`llvm/llvm-project` commit `63c34b32e0dbd23a0a240d86f4531a425a1cff2a` (main, fetched 2026-11-19), directory `libc/`:
the include closure of `shared/math/{sin,cos,tan,exp,log,log2,log10,expm1,cbrt,atan,atan2}.h` as resolved by
clang/gcc `-MM` for x86-64 Linux, aarch64 Linux, arm64 macOS and x86-64 macOS (164 files, 0.86 MB), unmodified.
Correctly rounded functions give the same bits at any revision; `atan` is not correctly rounded everywhere, so its
code path (non-FMA, forced in `js_math_llvm.cpp`) is what is pinned. To refresh: re-run the closure with the same
targets and re-run `tests/num_math_test.cpp`.
