# Wave 0b verification (T00b, T01, T06, T17, shell follow-ups)

Scope: the tree after the five wave-0b agents (commit 26c21d7 plus this pass's edits). Every number below was
measured here from a clean build directory (`native/core/build-verify/`), not copied from an agent report.
Ids: **V*n*** = this review; **R*n*** = `SETUP_REVIEW.md` section 3. "Fixed" = changed in this pass.
"[Mac]" = only a Mac/iPad can confirm.

## 1. Verified numbers

| check | result |
|---|---|
| g++ 13 Release, clean configure + build (`-Werror`) + `ctest` | 22/22 pass (0 warnings) |
| clang 18 Release | 22/22 pass |
| g++ ASan+UBSan (RelWithDebInfo) | 22/22 pass, no sanitizer output |
| clang 18 ASan | **cannot run here**: no compiler-rt (`libclang_rt.*` absent; `<sanitizer/asan_interface.h>` missing, which the vendored LLVM libc `sanitizer.h` includes under ASan) (V4) |
| clang 18 UBSan as `-fsanitize=undefined -fsanitize-trap=all` | 22/22 pass |
| g++ TSan, `queues offline bridge realtime clock dummy-module` | 6/6, clean (section 5) |
| all configs re-run from fresh dirs after this pass's edits | same results (section 5) |
| `golden.eq` | 18/18 `eq-*` exact (max diff 2.3e-6, `eq-notch-b`) |
| `rig_render` over all 108 fixtures, then `compare.mjs <dir>` | 108 rendered, no render error; **22/108 pass**: 18 `eq-*`, `eq-chain-8band` (8.7e-6), `pan-stereo-src` (3.0e-8), `reverb-dry`, `echo-none` (both silent goldens, V6) |
| `node tools/golden/compare.mjs --self-test` | OK: 8 goldens pass against themselves, 25/25 perturbation rows detected |
| `node test/run-all.mjs --only unit` | PASS: 488 pass, 0 fail, 7 skip (16.0 s) |
| `node native/contract/tools/build-engine-api.mjs --check` | up to date |
| throwaway module from BUILD_PLAN only (section 3) | builds, registers, auto-attached, tapped, injected, set rows reach it; md5 of every pre-existing file unchanged |
| owner for every file under `native/core` (331 files, glob check of the BUILD_PLAN table) | 11 unowned before this pass (V3), 0 after |
| T01 math vs a **fresh** Chromium 157 dump (20 000 cases per function, 340 390 total, not the committed set) | `rig::js` 0 mismatches with g++ and with clang `-mfma -mavx2`; `rig::fdlibm` 96–3500 per function, host glibc 9–10 635 (section 4) |
| T01 vectors regenerated from Chromium (`dump-math`, `dump-automation`, `dump-prng`) | byte-identical to the committed `math.txt`, `automation.txt`, `prng.txt` |
| T17 coverage recomputed from `engine-api.json` + manifest with an independent script | 102/102 rows (before T17: 51/102), 23/23 sample sets: T17's numbers hold |

## 2. Fixed in this pass

| id | file(s) | change |
|---|---|---|
| V1 | `src/bridge/bridge.cpp`, `tests/test_bridge.cpp` | **R1(f) was not closed.** The bridge still answered `unsupported` for `song`, `click`, `drone`, `cache`, `midi`, `rec`, ignored `config`, and lacked `play pedal/wheel/swell` and `get instruments/sampleStatus`, although the Model methods and service hooks exist. Consequence: T05's echo fixtures could not get their tempo, T07's click and T06's cache could not be reached through `rig_render`, so each would have edited T08's file. Now every op dispatches to its Model method; a missing service or empty result answers `unsupported`; `play bend/fade/input` stay `unsupported` (void T14 skeletons). Tests: `unsupported` per missing service, `song`/`config` reach the Model. |
| V2 | `tools/common/fixture_runner.cpp` | T17 added setup keys `next`, `live` and events `transpose keyContext routing panic fadeOut monoOut eqAudition commit retainReverb` that the frozen runner did not know (reported as `event X`, never sent). Added all of them with page.js semantics; events are now issued in time order (stable sort; the runner used array order, page.js sorts), and `setup.live` types are posted while rendering at the first 128-frame boundary ≥ t. `eqAudition` is flagged when the reply is not `true`; `routing` is always flagged `(T14)` because `Model::setRouting` cannot report "unimplemented". |
| V3 | `native/docs/BUILD_PLAN.md` | Owner rows for `tests/num_*`, `tests/time_*` (T01), `tests/samples_*` (T06), `src/inst/instrument.h` (orchestrator). Rule: frozen module headers are orchestrator-owned even inside an owner glob; the implementer only appends in the marked region. |
| V5 | `cmake/run_golden.cmake`, `CMakeLists.txt` | `compare.mjs` exits 0 when a golden WAV is absent, and `native/golden/out/` is git-ignored: on a fresh clone (CI) `golden.eq` passed while comparing nothing. Missing goldens now print `GOLDEN-MISSING` and ctest reports the test **Skipped** (checked by moving one golden away). |
| V7 | `BUILD_PLAN.md` | The plan named fixtures T17 never created (`pan-mono-sampler`, `pan-stereo-synth`, `transpose-octave`, `bend-normal`, `swell-8s`, `eq-chain-4band`, `fadeout-panic`, `routing-switch`, "3 samplers"). Replaced by the real ids in T02, T12, T13, T14, T15. |
| V8 | `BUILD_PLAN.md` | Wave-1 → wave-3 dependency: T02's done list had the mono pan law fixture, which is `pan-mono-src` = church **organ** (T15, wave 3, statistical 16.4 dB). Moved to T15; T02 gets a StereoPanner mono/stereo vector test from its own OfflineAudioContext dumper instead. `master-eq` is T03's fixture (T03 owns the `master` kind and the `fx.eq.`/`fx.comp.`/`master.` handlers); T02 unit-tests `MasterEq` against the same golden. Mono output (`setMono`, used by `fx-row-sweep`) had no owner: T03. T11a's "dumper cases via T17" do not exist: T11a writes `dump-sources.mjs`. |
| V9 | `third_party/chromium/LICENSE` | R24: BSD-3 text plus the 157.0.8103.78 tag, before the wave-1 Chromium ports (biquad, compressor, PeriodicWave, Up/DownSampler) start. |
| V10 | `native/docs/ARCHITECTURE.md` §6, §8.2 | §6 still said V8 `Math.*` = fdlibm `ieee754.cc`; now the measured split (LLVM libc + glibc FMA ports for JS math, `rig::fdlibm` for Blink `fdlibm::` calls) and the Chromium licence row. §8.2: tier counts 62 exact / 46 statistical / 41 `exactIfPrngPorted`, tolerances 1.5–16.4 dB and env-corr 0.73–0.95 with 3 checks off (R33). |
| S5 | `native/apple/Sources/Shared/RigLifecycle.swift` | `[weak self, weak src]` on a `DispatchSourceMemoryPressure` (a protocol existential: `weak` needs a class-bound type; possible compile error [Mac]). Reads `self.source` instead; the source is cancelled in `deinit`. |
| S6 | `RigNavigation.swift`, `RigHost.swift` | `WKUIDelegate.createWebViewWith` returns nil (never a second web view) and opens http(s)/mailto outside, for WebKit versions that skip the policy call on new windows [Mac]; `%d` with a Swift `Int` → `%ld`. |
| — | `native/core/README.md`, `BUILD_PLAN.md` | stub list and wave status updated; DoD notes V4/V5. |

## 3. The three blockers (R1–R3)

- **R1 interface freeze: closed after V1/V2.** Probe: in a copy of `native/core` I added only
  `src/fx/delay.cpp` (a pass-through `delay` with a `wa::Param` return gain), `src/fx/delay_register.cpp` (kind
  `delay`, set handler `fx.delay.`, service `probe-delay`), `src/fx/probe.cmake` (per-file definition; the source
  `#error`s without it), `tests/probe/test_probe.cpp` and `tests/golden_ids/probe.ids`, written from BUILD_PLAN and
  the headers alone. Result: configured and built with `-Werror`; `unit.probe` passed (the skeleton Model attached the
  kind by itself, `fx.delay.output` tap and `fx.delay.input` inject served, a `set fx.delay.returnGain` reached the
  module and halved the injected signal, the service was created); `golden.probe` ran; `rig_render` of the echo
  fixtures no longer listed the delay as unimplemented, only `song tempo`, which is what led to V1. No pre-existing
  file changed (md5 of all 331). The samples tests failed in the copy only because it had no `app/`.
- **R2 ownership: closed after V3.** The remaining overlap is intentional: `src/runtime/**` (T08) vs the four frozen
  runtime headers (first row wins), frozen module headers inside owner globs (rule added).
- **R3 hidden wave-2 dependencies: closed for sources (T11a exists).** One new one found and moved (V8).

## 4. T01 math and timeline

- Committed vectors are 522 cases per function (`n=500` + edges), which cannot tell the FMA from the non-FMA glibc
  pow (72 / 1e5 differ, so about 0.4 expected in 500). I therefore dumped 20 000 per function from the pinned
  Chromium (`dump-math.mjs --n 20000`, tier mismatches 0) and ran `rig::js`, `rig::fdlibm` and host glibc on them:

| fn | rig::js | rig::fdlibm | host glibc |
|---|---|---|---|
| sin / cos / tan | 0 / 0 / 0 | 615 / 526 / 632 | 22 / 13 / 46 |
| exp / log / log2 / log10 | 0 / 0 / 0 / 0 | 1682 / 717 / 96 / 719 | 12 / 11 / 9 / 703 |
| expm1 / cbrt / atan / atan2 | 0 / 0 / 0 / 0 | 1363 / 1674 / 362 / 3500 | 1349 / 10635 / 29 / 17 |
| pow / tanh / sinh | 0 / 0 / 0 | n/a | 0 / 0 / 1051 |
| sqrt / round / fround | 0 | 0 | 0 |

  T01's decision holds and the test discriminates (fdlibm is wrong for JS math; glibc matches only pow/tanh, as
  T01 said). Same result with clang `-mfma -mavx2`.
- **Timeline tests compare against Chromium, not themselves.** `unit.time` replays 45 `ConstantSourceNode.offset`
  renders from an OfflineAudioContext (`automation.txt`) sample by sample; re-dumping gave a byte-identical file.
  `unit.param` (shared file) is analytic expectations only, which is fine as a complement.
- LOW: `dump-automation.mjs` and `dump-prng.mjs` ignore `--out` and overwrite the committed data (I hit this; the
  output was identical). `dump-math.mjs` honours it.
- LOW: the oracle depends on the rendering CPU (FMA glibc ifuncs); `manifest.chromiumPin` records no CPU flags
  (T01's suggestion; orchestrator/T17 follow-up in `render.mjs`).
- Licences of the new code: LLVM libc (Apache-2.0 WITH LLVM-exception), ARM optimized-routines pow (MIT), glibc
  `s_tanh.c`/`s_expm1.c` (Sun fdlibm notice; glibc's 1997 Shimizu change is LGPL-2.1+ code): all GPL-3 compatible,
  now listed in ARCHITECTURE §6.

## 5. Final clean runs after this pass's edits

Filled in below by the final run of `build-verify/final/run.sh` (fresh build dirs, all edits in):

| config (fresh dir under `native/core/build-verify/final/`) | result |
|---|---|
| g++ 13 Release | 22/22 pass, 0 compiler warnings |
| clang 18 Release | 22/22 pass, 0 compiler warnings |
| g++ ASan+UBSan RelWithDebInfo | 22/22 pass, no sanitizer report |
| clang 18 UBSan (trap) RelWithDebInfo | 22/22 pass |
| g++ TSan: `unit.bridge unit.clock unit.dummy-module unit.offline unit.queues rt.realtime` | 6/6 pass, no TSan warning |
| `rig_render` all 108 → `compare.mjs` (g++ build and clang build) | 22/108 pass each; the 108 WAVs are bit-identical between g++ and clang |

`unit.bridge` grew from 10 to 11 cases (V1). The 86 failing fixtures all list an unimplemented module in
`rig_render`'s output (instruments, FX, master chain, click, drone, perform features); none fails for a harness
reason.

## 6. Findings (open)

| id | sev | finding | owner / action |
|---|---|---|---|
| V6 | MEDIUM | `reverb-dry` and `echo-none` goldens are digital silence (return gain 0); they pass with no reverb or delay code (they did so in this run). Two of T04/T05's done fixtures prove nothing until the non-silent ones pass. | noted in T04/T05 rows; T17 follow-up: a `peak > 0` sanity flag in `compare.mjs` output |
| V11 | MEDIUM | R22 still open: `native/golden/out/` (163 MB) is not committed; only `smoke/` (11 WAVs). On CI every `golden.*` test is now Skipped (V5) instead of a false pass. | orchestrator: commit the exact-tier WAVs a task's `.ids` lists (the 18 `eq-*` are about 6 MB), or regenerate in CI |
| V12 | MEDIUM | `Model::setRouting`, `pitchBend`, `fadeOutAll`, `noteInput`, `setMono` are void skeletons: callers (and the golden runner) cannot see that they do nothing. `monoOut` in `fx-row-sweep` is reported as applied while no unit sums to mono. | T03 (mono), T14 (others); T08 may return `unsupported` from the bridge until they land |
| V13 | LOW | `Unit::giveBack` leaks a payload when the event ring is full (R18 open). | T08 (separate Garbage ring) |
| V14 | LOW | `src/graph/test_points.h` named `tests/test_test_points.cpp`; the test is `tests/test_t00b_api.cpp`. | **fixed** (comment) |
| V15 | LOW | `samples_decode` parity test returns early (passes) if the decode dump is missing. The dump is committed (`tools/golden/decode-dump/data`, 14 files), so this only bites if it is deleted. | T06 note |
| V16 | INFO | 14 PARAMS rows are covered only by statistical fixtures (`sends.*`, `fx.reverb.size/damp/predelay`, `fx.chorus.*`, `drone.*`); they become exact with T04, T05, T16's PRNG promotion. | per task |

## 7. Swift read for compile-level mistakes (UNBUILT; no Swift toolchain here)

Read: `RigNavigation`, `RigLibrary`, `RigLifecycle`, `RigHost`, `RigAudio`, `RigPaths`, `WorshipRigApp`,
`project.yml`. Fixed S5, S6 (section 2). Checked and fine: `rig_host_memory_pressure` / `rig_set_paths` are declared
in `rig_engine.h` and defined in `src/api/rig_engine.cpp` (the shell agent's link worry is unfounded);
`audio_start` is a void C callback and `RigAudio.start` returns Void (`queue.async`, R25); `rig_apple_audio_request`
has the `session_*` fields the iPad path writes; `RIG_DEVICE_INTERRUPTED` exists; postfix `#if` modifiers and `#if`
inside `.commands` are Swift 5.5+; `window.__rig.store.pristine`, `controller.importLatestBackup`,
`rig.onMenu('importLatestBackup')` exist in `app/js` as `RigLibrary` assumes; the crash-recovery `post` uses valid
`play panic` / `rec stop` messages (the latter now answers `unsupported` until T08's `rec`, harmless).
[Mac] to confirm: `WKScriptMessageHandlerWithReply` / `decidePolicyFor` witnesses without `@MainActor @Sendable`
on the closure parameter (expected: warnings in Swift 5 mode, errors only in Swift 6 mode); `iOS
UIWindowScene.keyWindow` (iOS 15+, fine for 17.5).

## 8. Verdict

**GO for wave 1** on the corrected BUILD_PLAN: T02, T03, T04, T05, T07, T08, T09, T11a can start, at most 5 at once
(T04, T11a, T03, T02, T08 first; T05, T07, T09 as slots free). Open items V6, V11–V16 do not block any of them.
