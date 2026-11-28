# third_party

All code here is vendored unmodified (permissive licences, fit for the PolyForm Noncommercial 2.0 app, D38;
ARCHITECTURE section 6). Fetched with curl from the
canonical GitHub raw URLs on 2026-11-19. Compiled with `-w` into `rig_third_party`; our own code is `-Werror`.

| dir | upstream | version | licence | used by | status |
|---|---|---|---|---|---|
| `yyjson/` | github.com/ibireme/yyjson `src/yyjson.{h,c}` | tag 0.10.0 | MIT | bridge JSON in, tools | in use |
| `qrcodegen/` | github.com/nayuki/QR-Code-generator `cpp/qrcodegen.{hpp,cpp}` | commit 9a217d4 (2026-11-03), unchanged | MIT | Settings › Remote QR code (rig_hostkit, D45) | in use |
| `doctest/` | github.com/onqtam/doctest `doctest/doctest.h` | tag v2.4.11 | MIT | unit tests | in use |
| `dr_libs/` | github.com/mackron/dr_libs `dr_mp3.h`, `dr_wav.h` | master (dr_mp3 v0.7.5 unreleased) | public domain / MIT-0 | T06 decode | linked (impl in `impl/dr_libs_impl.c`), tested |
| `pffft/` | github.com/marton78/pffft `src/pffft.c`, `pffft_common.c`, `pffft_priv_impl.h`, `src/simd/*`, `include/pffft/pffft.h`, `src/fmv.h` | master (float build only) | BSD-like (FFTPACK) | T04 convolver, T11 PeriodicWave | linked, round-trip tested |
| `v8_ieee754/` | github.com/v8/v8 `src/base/ieee754.cc` | tag 12.4.254 | BSD-3 + Sun fdlibm notice | T01 bit-exact math | **source only, not built** |

Notes:

- **V8 `ieee754.cc` on current V8 `main` is no longer fdlibm.** It forwards `exp/log/sin/cos/pow/tanh` to LLVM libc's
  `shared::*` (correctly rounded implementations). The 12.4.254 revision still holds the fdlibm ports that older
  Chromium/V8 `Math.*` used. T01 must decide which one the golden JS actually ran (the Chromium here is 157.x): compare
  the C++ port against `Math.exp/log/sin/cos/pow/tanh` dumped from the golden Chromium before trusting either. The file
  needs V8's `macros.h`/`build_config.h`; T01 adds a 30-line shim instead of vendoring V8 headers.
- pffft is the marton78 fork's split layout. Only the float transforms are compiled; `pffft_double.c`, the
  convolution helpers and SIMD back-ends for other targets are not vendored. SIMD selection is automatic (SSE on
  x86-64, NEON on arm64, scalar fallback); `pf_*` headers other than those listed are not needed.
- miniaudio is NOT vendored here: it belongs to the Linux dev host (T09, `native/devhost/`).
- Licence texts: `yyjson/LICENSE`, `doctest/LICENSE.txt`, `pffft/LICENSE.txt`, `v8_ieee754/LICENSE`; dr_libs carries
  its dual licence at the end of each header.
