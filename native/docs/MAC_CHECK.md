# Mac checks with as little Mac time as possible

Goal (Ryan, 2026-11-20): the Mac push agent tests the Mac things, and Ryan's own hands-on Mac time is spent only on
what cannot be automated. Everything that can run without a human runs in tier 0 (GitHub CI) or tier 1 (one
unattended command on the Mac). Tier 2 is one short checklist for Ryan, done once, after songs play.

| tier | where | who | cost to Ryan | covers |
|---|---|---|---|---|
| 0 | GitHub Actions `macos-15` (`.github/workflows/native-core.yml`) | CI, on every push touching native/ or tools/mac/ | none | core build + ctest + goldens under Apple clang (`build-test`), Apple compile of both targets and the macOS app's UI-less first launch, `--self-test` (`mac-check`) |
| 1 | Ryan's Mac, `bash tools/mac/check.sh` | the push agent, one `RUN` | none after the one-time setup below | tier 0 again on the real Mac, plus the audio probe on the real output device (D2, D4 numbers) |
| 2 | Ryan's Mac and iPad, by hand | Ryan | about 25 minutes, once, after the tier-1 re-run on the integration commit | what needs ears, hands, a MIDI keyboard, his real library, an iPad |

Status: `tools/mac/check.sh` and `rig-probe` are tested on Linux (argument parsing and usage errors, `git archive`
export and reuse, `--src`, the core stage from a clean export, the probe stage on the null audio backend, missing-tool
and bad-revision paths, `summary.json` parsed back, Apple stages SKIPPED with a reason; shellcheck clean). The skeptic
review (`native/docs/reviews/mackit.md`) also ran the macOS code paths on Linux behind stub `uname`/`xcodebuild`/
`xcodegen`/`sw_vers`/`sysctl`/`libtool` commands (compile error capture, scheme fallback, simulator platform missing,
Xcode license), the timeout watchdog and a TERM in the middle of the core build (summary still written, no process
left behind). The script
was written for `/bin/bash` 3.2 but only run under bash 5 here. The macOS-only
parts ran for the first time in Mac check #2 (tier 1, see Results: Core Audio probe, `build-core.sh`, `xcodegen` and
the macOS `xcodebuild` PASS; the simulator build needs the iOS platform installed). The `mac-check` CI job was first
read back by the scoped integrator (2026-11-24, "CI Mac check" below).

## Results

### CI Mac check (GitHub Actions `native-core`, `650df77` and `f4869e3`; read back 2026-11-24)

Read with `env -u GH_TOKEN gh run list -R ryanmye/worship-rig -b v2-native` and `gh run view --job ... --log`. Both
runs are push runs on `v2-native` and concluded **success**, every job green. This is CI's `macos-15` runner (Apple
clang from the runner's Xcode), not Ryan's Mac: no Core Audio device, no probe, no launch.

| job | `650df77` (run 45113813640, CORE3 builder finish pass) | `f4869e3` (run 45543732316, CORE3 VERIFIED, HEAD) |
|---|---|---|
| `goldens` (renders the non-committed goldens with the pinned Chromium) | success | success |
| `build-test (macos-15)` | success, ctest **84/84** | success, ctest **84/84** |
| `build-test (ubuntu-latest)` | success | success |
| `mac-check` (`check.sh --rev HEAD --stage tools,apple-mac,apple-sim`) | success: `tools` PASS, `apple-mac` PASS (0 compiler warnings), `apple-sim` PASS (1 compiler warning) | success: `tools` PASS, `apple-mac` PASS (0 compiler warnings), `apple-sim` PASS (1 compiler warning) |
| `sanitizers` (Linux) | success: ASan 84/84, TSan 31/31 | success: ASan 84/84, TSan 38/38 (regex + `core3\|synth\|organ`) |

What it shows: the core with MACFIX and CORE3 builds and passes all 84 ctests (goldens included) under Apple clang on
macOS, and both Apple targets compile and link from a `check.sh` export. The `apple-sim` warning was not read here
(one warning, both runs). Not shown: anything on Ryan's M2 Pro (the probe, Core Audio, the app's first launch).
The commits between the two (`9b96f13`..`db15e0e`: docs, the chart lanes in `app/`) have no run of their own. The
three CORE3 / MACFIX checkpoints before `650df77` (`6045199`, `a26c191`, `7f2e9a8`) failed `build-test (macos-15)`;
at `7f2e9a8` the one failure was `unit.core3`'s old tick-gap bound (`test_core3.cpp:344`, 145.8 ms vs 80), the bound
the finish pass and CORE3 review O2 reworked. So the macOS runner is a place where `unit.core3`'s timing bounds can
trip (CORE3 O2 follow-up, T13).

### Mac check #3 (2026-11-22, tier 1, `b9a0c27`, the CORE2 integration commit)

Ryan's M2 Pro, Apple clang 21.0.0 (clang-2100.1.1.101). The run started at 23:36:09Z and failed (exit 1) at
23:40:14Z. Logs are in `~/Projects/worship-rig-v2/outbox/logs/20261122T233551Z-check/`.

| stage | result |
|---|---|
| `export`, `tools` | PASS |
| `core` | **FAIL, 68/70.** <ul><li>`unit.synth` fails at `test_synth.cpp:260-261`: the reply for `synth:juno-pad` contains neither the instrument name nor `"code":"unsupported"`.</li><li>`unit.synth-extra` fails at `test_synth_extra.cpp:86`: `REQUIRE(synthExtraFactory() != nullptr)`; the factory is null.</li></ul>Linux passes 82/82. Owner: **MACFIX**, fixed (below): a test-order bug, not a Mac or linker bug; the app was never affected. The 70 vs 82 is the 12 `golden.*` tests, excluded by design. |
| `probe` | PASS: 64 frames safe; desktop auto voice-limit suggestion 288. |
| `apple-mac` | PASS, 0 warnings |
| `apple-sim` | FAIL, environment only: the iOS 26.5 simulator platform is not installed. |

Hands-on: **on hold** until MACFIX and CORE3 land and Mac check #4 passes `core`. (2026-11-24: both landed and
VERIFIED, scoped re-check green, CI Mac check green at `f4869e3`; Mac check #4 is next: "Mac check #4: the stages it
needs" under Tier 1.)

**MACFIX (root cause, reproduced on Linux).** The "ld64 drops a static-initializer registration" hypothesis is
wrong. Nothing in `native/core` registers from a static initializer. `api/registry.cpp`'s `ensureModulesRegistered()`
calls every `rig_register_*` by name (from the generated `rig_modules.inc`), and `rig_create` calls it, so a linker
that pulls `rig_create` pulls every register object. A public-API-only program linked against `librig_core.a` with
`ld.lld --gc-sections` plays all ten synth-extra ids and the organ, and keeps all 17 `rig_register_*`. The real cause:
the registration runs at the **first `rig_create`** in the process, and ctest runs each suite as its own process
(`rig_tests -ts=<suite>`). In `unit.synth-extra` and `unit.synth`, the cases that normally create the first engine are
the golden-fixture cases. Without `native/golden/out` (git-ignored, so absent from the check's export) they `continue`
before any engine exists. Then:
- `test_synth_extra.cpp:86` read the hook before any engine existed, so it saw nullptr.
- `test_synth.cpp:255` saved the hook (nullptr) and set nullptr for the "T15 absent" path. The next `rig_create`
  registered T15 over that override, so the warning never came.

On Linux, `./rig_tests -ts=synth-extra -tc='inst.synth dispatch*'` and `-ts=synth -tc='synth-extra ids*'` reproduce
both failures exactly, and so do the two suites in a Mac-like tree (`git archive` of `b9a0c27`, no
`native/golden/out`, the `check.sh` devhost configuration). After the fix that tree passes 71/71 (`-LE devhost|golden`)
with g++ 13 and clang++-20. Fix:
`synthExtraFactory()` / `makeSynthExtra()` run `ensureModulesRegistered()` first. `test_synth` registers before it
overrides. The new suite `unit.registry-link` covers the rest: it fails if `rig_create` stops registering or a module
drops out (checked by mutation). The count: Linux registers 82 ctests = 70 + 12 `golden.*`; `check.sh` runs
`-LE devhost|golden` without `native/golden/out`, so 70. No suite is missing, and the golden-WAV cases inside the
unit suites skip too. `check.sh` now states the excluded count. Details: `INTERFACE_LOG.md` "MACFIX".
Skeptic (`reviews/MACFIX.md`): VERIFIED. A new first case of `unit.synth-extra` reads the hook before any engine
exists, so the Linux gate (goldens present) now fails if the fix is reverted. Expected at Mac check #4 on the tree
with CORE3: **72** core ctests (70 + `unit.registry-link` + `unit.core3`), 12 `golden.*` not run.

### Mac check #2 (2026-11-21, tier 1, `b0bf81a`)

Ryan's M2 Pro, macOS 26.4, Xcode 26.6, Apple clang 21; output through a ThinkPad USB-C dock at 44.1 kHz. Summary:
`~/Projects/worship-rig-v2/outbox/logs/20261121T060249Z-check/summary.json` (on the Mac; numbers below as relayed
by the orchestrator, not re-read from the file by the wave-2 integrator).

| stage | result | numbers |
|---|---|---|
| `tools` | PASS | |
| `core` | PASS | ctest **46/46** under Apple clang 21 (the 3 `unit.samples_*` dump cases absent in the export: known gap 2, fixed after this run: they now skip, `INTERFACE_LOG` 38; goldens excluded as designed) |
| `probe` | PASS | Core Audio. **D2**: 64 / 128 / 256 / 512 frames granted exactly, 0 late callbacks, 0 xruns at every size, reported latency 2.9 / 5.8 / 11.6 / 23.2 ms; `d2_64_frames.safe` true. **D4**: synth warm-pad **4.82 µs per voice per quantum** (Linux box ≈ 9 µs); `auto_voice_limit_suggestion.desktop` **256** (raw 271) |
| `apple-mac` | PASS | `WorshipRig-macOS` compiles and links, 0 warnings (first build of the Apple shell anywhere) |
| `apple-sim` | FAIL (environment only) | the iOS 26.5 simulator platform is not installed and CoreSimulator is older than Xcode's. Not a code result: install the platform (Xcode > Settings > Components, or `xcodebuild -downloadPlatform iOS`) and re-run `--stage apple-sim`. The script should report this as SKIPPED (it matches only the "is not installed" wording today): `tools/mac/check.sh` follow-up |

What it settles and what it does not:
- D2: 64 frames is measured safe on this Mac with this device (a USB dock, not the built-in output; the probe note
  above prefers the built-in output for latency figures). Default stays 128 (DECISIONS D2).
- D4: the Mac supports a desktop Auto of 256, but `kAutoVoiceLimitDesktop` stays **128** for now: the burst caveat
  (D4 review R1, ARCHITECTURE 7.1) is not measured on the Mac yet, and `unit.voice-limit-cpu` sizes against the Linux
  box. Raising it is an orchestrator / Ryan decision (DECISIONS D4). The iPad profile (64) is still unmeasured.
- Mac check #1 (earlier) failed the core build under Apple clang on an unused private field (`-Werror`); since then
  every gate also builds with clang++-20 `-Werror` on Linux as a stand-in.
- Still open on the Mac: a tier-1 re-run on the integration commit (engine + UI wave + CORE1 / CORE2), then tier 2
  (Ryan's hands-on checklist below), `apple-sim`, the iPad probe, reading back the CI `mac-check` result.

## Tier 0: CI (no Mac)

- `build-test` (matrix `ubuntu-latest`, `macos-15`): `cmake --preset release`, build, `ctest` incl. the golden
  comparisons (the `goldens` job renders them with the pinned Chromium).
- `mac-check` (`macos-15`): `bash tools/mac/check.sh --rev HEAD --stage tools,apple-mac,apple-sim --out check-out`,
  then `bash tools/mac/check.sh --rev HEAD --stage selftest --out check-out/selftest` (E4, "Self-test" below;
  `continue-on-error` while new, with an `::error` annotation and a "Self-test result" step that prints the JSON),
  all uploaded as the `mac-check` artifact. It builds the xcframework slices, generates the project and compiles
  `WorshipRig-macOS` and `WorshipRig-iPad` (iOS Simulator). `summary.json` carries the first 80 compiler errors per
  stage (`file:line: error: ...`, repo-relative), so the cloud can fix Swift from the artifact alone.
- The workflow triggers on `native/core`, `native/golden`, `native/contract`, `native/apple`, `native/devhost`,
  `tools/golden`, `tools/mac`, `app/js/engine` and the workflow itself.

When tier 0 is green, tier 1 is mostly a confirmation on Ryan's machine plus the probe numbers.

## Tier 1: `tools/mac/check.sh` through the push agent (one RUN, unattended)

```sh
bash tools/mac/check.sh [--rev <ref>] [--stage tools,core,probe,apple-mac,selftest,apple-sim] [--out <dir>] [--quick]
                        [--jobs N] [--cache <dir>] [--repo <dir>] [--src <tree>] [--app <Worship Rig.app>]
```

`--app` makes the `selftest` stage launch that app instead of the Debug build `apple-mac` made (the Release app of
"2.0 release checklist" step 2; release-native.yml uses it).

Run from `~/Projects/worship-rig`. Defaults: `--rev` = the local branch `v2-native` (the push agent fast-forwards it),
else `origin/v2-native`; all six stages; `--out` = `~/Projects/worship-rig-v2/outbox/logs/<UTC>-check/` (when the
outbox exists, else `./mac-check-<UTC>/`); `--jobs` = all CPUs. `--quick` = `core` + `apple-mac`, the compile-fix loop.
`--src <tree>` copies an uncommitted tree (minus build dirs) into `<cache>/local/src` instead of exporting a revision:
for testing the script itself, or a change before it is pushed.

What it guarantees:

- **The working tree, index and branches are never touched.** The revision is exported with read-only git
  (`git archive <sha> -- native app docs test tools/golden package.json | tar -x`) into
  `~/Library/Caches/worship-rig-check/<sha7>/src` (reused when present) and everything builds there: CMake trees,
  `native/apple/build`, the generated `.xcodeproj`, Xcode's DerivedData (`-derivedDataPath`). The cache keeps the three
  most recent revisions (about 1-2 GB each) and deletes older ones; nothing else is deleted.
- **Nothing is installed, no admin rights, no UI.** Missing tools are reported with the exact brew line and the stages
  that need them are SKIPPED. If `xcode-select` points at the Command Line Tools while `/Applications/Xcode.app`
  exists, the script sets `DEVELOPER_DIR` for its own process only. The app is launched only by `selftest`
  (transparent window, no audio device opened, nothing kept: "Self-test" below). The probe opens the
  default output device and writes zeros to it; it never changes the volume or the default device (the I/O buffer
  size it asks for, 64-512 frames, is Core Audio's per-client setting and ends with the process).
- **One machine-readable result.** `<out>/summary.json` plus one log per stage; a one-screen table at the end.
  Exit 0 = no stage FAILED (SKIPPED is not a failure), 1 = something failed, 2 = usage.
- **It keeps going.** A failed stage does not stop the stages that do not depend on it (core, probe and the two Apple
  stages are independent; all need the export).
- **It never waits forever.** Every external command that can take long runs under a timeout (macOS has no
  `timeout(1)`: a watchdog kills the command's whole process tree): configure 10 min, each build 40 min, ctest 30 min
  (900 s per test), the probe 5 min, xcodegen 5 min, each xcodebuild 40 min, the `xcodebuild -version/-showsdks`
  queries 1 min. Every command gets stdin from `/dev/null`, so nothing can sit at a prompt. A timeout is a FAIL with
  `check.sh: timed out after Ns` in the stage log.

| stage | what | M-series estimate (first run / same sha again) |
|---|---|---|
| (export) | `git archive` of the revision, ~145 MB | 5-15 s / 0 s |
| `tools` | macOS, CPU (performance + efficiency cores), Xcode, Apple clang, cmake, ninja, xcodegen, node versions; SDK list; first-launch status | < 5 s |
| `core` | `cmake -G Ninja -DCMAKE_BUILD_TYPE=Release` of `native/devhost` with `-DDEVHOST_CORE_TESTS=ON` (the core and its tests in the same tree the probe uses: the core compiles once), build `rig_tests rig_render rig-golden rig_bench`, `ctest -LE devhost -j<ncpu>`; failures are re-run once serially (timing tests) and reported as `flaky` if they pass. Golden tests are excluded when `native/golden/out` is absent (it is git-ignored, so always in an export): CI's `goldens` + `build-test` cover them on macos-15. `unit.samples_decode`, `unit.samples_process` and `unit.samples_service` read `tools/golden/decode-dump/data/raw*`, which is git-ignored too: without it their failures are listed as `NoData` and not counted (see "Known gaps"). Per-test results in `stages.core.tests`. | 1.5-3 min / 30-60 s |
| `probe` | build `rig-probe` + the dev host tests in the same tree, `ctest -L devhost` (null backend), then `rig-probe` on the default output (below), killed after 300 s | 2-3 min / 2 min |
| `apple-mac` | `scripts/build-core.sh --mac-only` (Ninja), `xcodegen generate`, `xcodebuild -scheme WorshipRig-macOS -configuration Debug -destination 'platform=macOS' CODE_SIGN_IDENTITY=- ARCHS=arm64 build` (compile and link only; arm64 because the xcframework slices are arm64 only) | 2-4 min / 1 min |
| `selftest` | runs the app `apple-mac` built (this run or an earlier one on the same sha: it stays in `<cache>/<sha7>/dd-apple-mac`) as `Worship Rig --self-test` with `RIG_ELECTRON_BACKUPS` = the exported fixture, killed after 120 s; `selftest.json` + `stages.selftest.result` in `summary.json`; crash reports copied. SKIPPED without a built app ("Self-test" below) | 10-20 s (guess) |
| `apple-sim` | `scripts/build-core.sh --sim --no-device`, `xcodegen`, `xcodebuild -scheme WorshipRig-iPad -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO ARCHS=arm64 build` (a generic destination otherwise also builds x86_64, which the arm64-only simulator slice cannot link); SKIPPED with a note if this Xcode has no iOS Simulator SDK | 2-4 min / 1 min |

Estimated total: 8-12 min for a new revision, about 3 min for a rerun of the same one, 1-3 min for `--quick` after a
Swift-only change. Measured on the 2-vCPU Linux box (`--jobs 2`, clean export of e2b5219): export 1 s, core 153 s
(build + 49 tests), probe 61 s (devhost build + tests + the probe in `--quick` mode on the null backend). The Apple
stages are estimates; the first real run replaces them (`summary.json` has `seconds` per stage).

If XcodeGen's project has no scheme that xcodebuild can auto-create, the Apple stages fall back to a target build
(`-target <name> -sdk <sdk> -arch arm64`); the log says so.

### Mac check #4: the stages it needs (scoped integrator, 2026-11-24)

Ryan's rule is "only check affected sections", so Mac check #4 runs only the stages that `git diff b9a0c27..f4869e3`
(the Mac check #3 commit to HEAD) affects:

```sh
bash tools/mac/check.sh --rev f4869e3 --stage tools,core,probe
```

(Or the PROTOCOL.md RUN line with `--stage tools,core,probe`.)

- `core`: affected. CORE3 and MACFIX changed `native/core` (the build worker, graph_build, song, the bridge, synth
  dispatch, the catalogue configure check). This is the stage that failed in Mac check #3. Expect **72/72**
  (`-LE devhost|golden`): the 70 from Mac check #3, plus `unit.registry-link`, plus `unit.core3`. The note says "12
  golden.* tests not run" (the 4-line `check.sh` change). Linux runs the same 72 plus 12 goldens: 84/84, and so does
  CI's `macos-15`. `unit.core3` is a timing test (`RUN_SERIAL`). If it fails only on its gap bound and passes on the
  serial re-run, it is reported as `flaky`: record the numbers for T13 (CORE3 O2 follow-up).
- `tools`: affected, because `tools/mac/check.sh` changed. It is also the first stage and costs under 5 s.
- `probe`: affected. It builds `rig-devhost` and `rig-probe` against the changed core. The probe's D2 / D4 songs go
  through the realtime `prepare` that CORE3 changed: a synth song's units are now built on a build lane, and the reply
  waits for them. Hands-on part A runs that same `rig-devhost` from `<cache>/<sha7>/build/` (only this stage builds it).
- `apple-mac`: not affected.
  - `native/apple` is unchanged, and so is the link layout. The core gained one object (`model/build_worker.o`) in the
    same `librig_core.a`. There are no new libraries and no link-line change. `std::thread` is in libc++, and MACFIX
    confirmed that every register object is still pulled through `rig_create`.
  - CI's `mac-check` compiled and linked `WorshipRig-macOS` at `f4869e3`.
  - Add it (`--stage tools,core,probe,apple-mac`) only if Ryan does hands-on part B in the same sitting. Part B opens
    the app from this commit's `dd-apple-mac` build directory.
- `apple-sim`: not affected. It still needs the iOS platform installed, and CI's `macos-15` builds it.

### summary.json

```json
{"tool": "tools/mac/check.sh", "schema": 1, "rev": "v2-native", "sha": "<40 hex>", "started": "...Z", "finished": "...Z",
 "host": {"os", "arch", "cpu", "cores", "xcode", "cxx", "cmake", "ninja", "xcodegen", "node", "jobs", "missing_brew"},
 "export": {"status", "seconds", "details", "src"},
 "out": "<dir>", "interrupted": "\"\" or \"signal during <stage>\"",
 "stages": {"<name>": {"status": "PASS|FAIL|SKIPPED", "seconds": 0, "details": "...", "log": "<name>.log",
                       "errors": ["native/apple/Sources/Shared/RigHost.swift:42:9: error: ...", "..."]},
            "core": {"...": "...", "tests": {"unit.bridge": "Passed", "...": "..."}, "flaky": "", "golden": "..."}},
 "probe": {"...": "rig-probe's report, below; null when the probe did not run"}}
```

`errors` is at most 80 entries: compiler and linker errors with paths relative to the repo (`native/...`), failing
ctest names (`unit.x: Failed`) followed by their doctest assertion lines, or the brew line for missing tools.

### The probe (`native/devhost`, `rig-probe`)

Built from `native/devhost/src/probe*.cpp` (UNTESTED on macOS: the Core Audio latency query in `probe_apple.cpp` and
the run against a real device have never executed). It answers the two open Mac questions in DECISIONS:

1. **D2, buffer size.** For 64, 128, 256 and 512 frames: `audio restart {bufferFrames}`, the granted period, rate,
   periods and latency, Core Audio's own `kAudioDevicePropertyBufferFrameSize` during the window, then 10 s of the
   real core rendering a typical 4-slot song (sampler + warm-pad + strings + sub-bass, a held C major chord) with the
   output muted. Per size: callbacks vs expected, late callbacks (start-to-start gap > 1.5 x the callback's
   duration), the core's own xrun counter, callback time p50 / p99 / max in microseconds and as % of the period.
   `d2_64_frames.safe` = granted 64, no late callback, no xrun, max < period, p99 < 60 %.
2. **D4, 'auto' total voice limit.** At 128 frames, per kind (`synth` = `warm-pad`, the costliest synth.js voice so
   far; `sampler` = `upright-piano`): 16 slots of it, polyphony 128, voice limit off, then 0, 1, 2, 4, 6, 8, 12, 16,
   24, 32, 48, 64, 96, 128 held notes per slot (x 16 voices each), 0.4 s settle (the note-on burst is excluded) and a
   1 s window per step, until the p99 per quantum is above 80 %. Fit `quantum time = fixed16 + per_voice x voices`;
   `max_voices_60` / `max_voices_80` from the p99 line; the measured 60 % / 80 % crossings are interpolated.
   `auto_voice_limit_suggestion.desktop = floor16((0.60 x quantum - fixed16_p99) / per_voice)` with the costliest
   kind, next to the provisional `kAutoVoiceLimitDesktop` (128) / `kAutoVoiceLimitIpad` (64). That number replaces
   `kAutoVoiceLimitDesktop` (and the mock's `AUTO_VOICE_LIMIT`) per ARCHITECTURE 7.1; the iPad needs its own run.

Total probe time about 90-120 s. Run it with the built-in output selected (the report names the device and its Core
Audio transport, `bltn` = built-in; Bluetooth output has its own large latency and makes the D2 numbers meaningless).
On Linux the same binary runs on miniaudio's null backend (`ctest probe.null`, ~10 s): that proves the plumbing and the
JSON, not the numbers.

The probe preloads each song (`cache preload`) before `prepare`; `--no-preload` skips that and exercises the cold
path. (When the probe was built, a cold realtime `prepare` left samplers silent because the control loop never pumped
the cache; CORE1 fixed that, see "Known gaps".)

### One-time setup on the Mac (Ryan, once, before the first RUN)

```sh
brew install cmake ninja xcodegen node
```

(`node` is optional: only the core's `unit.params-drift` test needs it.) Xcode 15.4+ from the App Store, opened once
(or `sudo xcodebuild -runFirstLaunch`, which also covers the license), and the iOS Simulator platform if Xcode did not
install it (Xcode > Settings > Components, or `xcodebuild -downloadPlatform iOS`); without it `apple-sim` is SKIPPED,
not failed (either `-showsdks` lists no simulator SDK, or xcodebuild says the iOS platform "is not installed").
An unaccepted Xcode license shows up in `tools` as "Xcode license not accepted", not as a missing Xcode.

### PROTOCOL.md: the RUN allow-list line to add

Add this line to the RUN allow-list in `~/Projects/worship-rig-v2/PROTOCOL.md`:

```
- bash -c "$(git -C ~/Projects/worship-rig show v2-native:tools/mac/check.sh)" check.sh --repo ~/Projects/worship-rig [--rev <v2-native|origin/v2-native|7-40 hex sha>] [--stage <comma list of tools,core,probe,apple-mac,selftest,apple-sim>] [--quick] [--out ~/Projects/worship-rig-v2/outbox/logs/<UTC>-check]   (read-only git; builds only under ~/Library/Caches/worship-rig-check; installs nothing; no sudo; 3-20 min, so start it with the Bash tool's run_in_background and wait for it: the foreground limit is 10 min; reply with the exit code and the summary.json path)
```

Why this form and not `bash tools/mac/check.sh`: the script is read from the `v2-native` branch with `git show`
(read-only), so the RUN works whatever branch `~/Projects/worship-rig` has checked out (it may be on a 1.x branch,
where `tools/mac/` does not exist; the push agent only fast-forwards `v2-native`), and the script matches the
revision it builds by default. When the
working tree is on `v2-native`, `bash tools/mac/check.sh [flags]` from `~/Projects/worship-rig` is the same thing.

Why in the background: a first run takes 8-15 min, and a Claude Code foreground Bash call is killed at 10 min.
If the run is killed anyway (TERM/INT/HUP), `check.sh` stops the command it was running (the whole process tree) and
still writes `summary.json`, with `"interrupted": "signal during <stage>"` and that stage FAILED; exit 143.

The cloud then sends `inbox/<UTC>-RUN.md` (first line `VERB: RUN`, then the command exactly as above) and reads
`outbox/logs/<UTC>-check/summary.json` back through the device tools. The loop for Swift compile errors is: read
`stages.apple-*.errors`, fix, push, RUN the same line with `--quick` (or wait for CI's `mac-check`).

## Tier 2: Ryan hands-on checklist (integrator, 2026-11-22: engine and UI wave done)

**When:** after Mac check #4 (`--stage tools,core,probe`, see "Mac check #4: the stages it needs" above) shows
`core` and `probe` PASS. Part A needs only those (`rig-devhost` is built by the `probe` stage). Part B opens the app
from that commit's `apple-mac` build directory, so it also needs `--stage apple-mac` on the same commit (`apple-sim`
may stay FAILED/SKIPPED for the missing iOS platform). About 25 minutes, MIDI keyboard with a sustain pedal,
headphones or the usual speakers. The 2.0 UI runs in Chrome on top of the native engine through `rig-devhost` (the dev host: real UI, real C++ engine, Core Audio output, Chrome's Web MIDI). The Apple app itself has
compiled but never been launched; it is part B.

**Part A: 2.0 in Chrome on the M2 Pro (`rig-devhost`)**

1. **Start.** Quit the 1.x app. In Terminal (keep it open; `<sha7>` = the commit the check built, the folder name under
   `~/Library/Caches/worship-rig-check/`):
   `~/Library/Caches/worship-rig-check/<sha7>/build/rig-devhost --log ~/Desktop/rig-bridge.jsonl`
   Open `http://127.0.0.1:8440/` in Chrome (one tab only: a second tab takes the engine over). Click once to start
   audio. Look for: the page loads, the top bar reaches Ready, no red banner.
2. **Your library.** In the 1.x app beforehand: **Export library** in Settings (its library / backup section). In
   the 2.0 page: Settings › Library & Backup › **Import…** and pick that file. Look for: "Imported N songs", your setlist as
   in 1.x.
3. **MIDI keyboard.** Plug it in; allow MIDI if Chrome asks. Play fast repeated notes on one key, then a chord held
   with the pedal, pedal up. Listen for: no lag or flams compared to 1.x, nothing stuck after pedal-up. Look for: the
   Perform pedal lamp stays lit the whole time the pedal is down and goes dark on release.
4. **Buffer size.** Settings › Sound › Buffer size **128** (the line next to it shows the size the Mac gave). Play a
   pad song with a piano for one minute: no clicks, crackles or dropouts. Then **64**, the same minute; then back to
   128.
5. **Switching songs while playing (the main thing to check).** Hold a chord with the pedal down and press **Next**
   (or click the next chip in the setlist) while still holding; keep playing for 10 s. Do it through the whole set,
   then once more backwards with Prev, and once with a jump to a song you have not opened in this session (its samples
   load cold). Listen for: the old song lets go cleanly, the new one sounds within about a second, no slot stays
   silent (a piano that never comes in), notes you play during the switch are not late or swallowed. Look for: the
   meters keep moving during the switch. Since CORE3 (`reviews/CORE3.md`) synth and organ sounds are built off the
   engine's control thread, and the songs next to the current one in the setlist (Next, Prev and one further each
   way) are built ahead of time, so the old "input held back up to ~0.3 s" (CORE2A O2) is gone on the Linux box
   (scoped integrator, 3 ui-core runs: no tick gap over 150 ms; next to a synth / organ switch at most 73 ms). Say
   whether anything still feels held on the Mac. What to listen for now:
   - **Next / Prev** into a synth / organ song: the new sound is there at once (it was built ahead).
   - **A jump** to a song that is not a neighbour (a setlist chip further away, or a song from the library): its synth
     / organ sounds are built when you switch, so the new song may take a moment to come in (up to ~1.5 s for a
     16-organ song on the Linux box; a 4-slot song is ~0.1 s), but the old song and the notes you play meanwhile must
     stay on time. Say if a jump is ever late by more than a second, or if a note is swallowed.
   - Sampler songs that have not been loaded this session still load cold (CORE2A, unchanged): up to ~2 s before the
     piano comes in; the rest of the song plays meanwhile.
   - Rare: the first time a sampler song's size is estimated, the engine can pause for ~0.15 s (CORE3 review O6, open).
     If you hear one small hitch right after selecting a sampler song for the first time, note the clock time.
6. **Perform controls.** On a few songs: Swell (rises; press again returns), mod wheel / expression pedal, Fade-out,
   transpose − / +, the Click chip on a song with a tempo, drone on / off and a key change, Panic (Esc) silences
   everything. Each does what 1.x does.
7. **More than 4 sounds.** In Edit, use **Slots** (rig bar) › add a slot until the song has 8; give Sound 5-8
   different instruments; in Perform the strips scroll sideways and all 8 play and meter.
8. **By ear against 1.x.** Pick 3 songs you know well; play each in 1.x and in 2.0 back to back (quit one before
   starting the other). Note anything clearly louder, quieter, duller or different.
9. **Stop** with Ctrl-C in Terminal.

Not in part A (the dev host does not serve them, so they do not count as failures here): pad files (the drone uses
the synth drone; the warning "No pad file for C" is expected), My Samples / GarageBand instruments, recording files,
CoreMIDI timing (Chrome's Web MIDI adds a hop that the app will not have).

**Part B: the Mac app (`WorshipRig-macOS`), when the Mac check build launches**

1. Open the build `check.sh` made: `open ~/Library/Caches/worship-rig-check/<sha7>/dd-apple-mac/Build/Products/Debug/`
   and double-click the app there (or Product › Run in Xcode). The window opens and the page loads (`rig://app/`),
   not a blank window.
2. Repeat part A steps 3-5 there (CoreMIDI is the app's own path).
   **MIDI in the app (lane NMA; only the Mac can check this, the cloud has no CoreMIDI).** With the keyboard
   plugged in before launch: the top bar's MIDI lamp names it within a second of the page loading (not "Not
   supported" / "Off"); Settings › MIDI lists it (and, greyed or not chosen, the IAC / network ports). Then:
   a. Play: notes and the sustain pedal sound; fast repeats on one key do not hang notes. Compare the feel with part A
      (Chrome's Web MIDI): the app is one WebView round trip per note (contract 5 "v1 default", open question 2);
      say if it feels later or less even than Chrome.
   b. Hot-plug: unplug the USB cable while holding a chord with the pedal down: the chord stops at once (no stuck
      notes) and a toast names the fallback; plug it back: the lamp names it again and it plays.
   c. MIDI Learn on one control (Perform › Learn, or Settings › MIDI), and a Program Change from the keyboard with
      Settings › Program change on: both act.
   d. Settings › Metronome › MIDI clock out: pick an output (a DAW on the IAC bus, or a drum machine); start the click
      on a song with a tempo: the receiver follows the tempo (the clock goes out natively to the chosen port by name).
   e. Settings › Diagnostics or Safari's Web Inspector (Develop › <Mac> › Worship Rig) console:
      `navigator.requestMIDIAccess.nativeMidi.access.stats` shows `messages` counting up and `dropped` 0 while
      playing; `__rig.midi.inputs` lists the keyboard as `hardware`.
   f. Reload with notes held (skeptic NMA F1): hold a chord with the sustain pedal down and reload the page (Web
      Inspector console `location.reload()`, or Settings › My Samples › Reload when it shows). The chord stops when
      the page comes back, and with the pedal still down a new note does not ring on after its key-up once the pedal
      is lifted (the new page's boot sends one `play panic`). The drone keeps playing.
   g. 1.x choices carry over by name (skeptic NMA O7, unverified): the keyboard chosen in 1.x Settings › MIDI and the
      keyboards marked "remember" (with their own touch curve) show the same names here and are still chosen /
      remembered. The app names a port by CoreMIDI's display name; if 1.x (Chrome) showed another name for the same
      keyboard, say both names.
   h. Listen set follows the choice (skeptic NMA): with two keyboards plugged in, Settings › MIDI › pick one: only it
      plays; pick "All": both play; unplug the chosen one while 'first' is on: the other takes over within a second
      (toast) and plays.
3. Switch through the six themes: each renders.
4. One real GarageBand / Logic instrument through Settings › My Samples imports and plays.

The iPad install (`native/apple/README.md` steps 7-10) comes after part B. On the iPad, repeat B2 a-c and f with a USB
keyboard (USB-C or the camera adapter). A Bluetooth MIDI keyboard shows up only once it is paired in an app that
offers the Bluetooth MIDI pairing view (GarageBand, for example): Worship Rig has no pairing view yet (lane NMA).

**How to report.** For each step number: **OK**, or **not OK** + one line (what you heard or saw, which song, the
clock time). Send that list in the chat with the cloud session, with `~/Desktop/rig-bridge.jsonl` and the last ~50
lines of the Terminal window attached (the bridge log has every message with a timestamp, so a glitch at a given clock
time can be traced). A screenshot for anything visual.

Everything else on the README's "Mac / iPad verification list" (WebContent crash recovery, memory-pressure simulation,
AVAudioSession interruptions) is optional for Ryan; it can be scripted into tier 1 later on top of the `--self-test` mode ("Self-test" below), which
now covers launch, load, `hello`, boot and quit from `check.sh`.

## 2.0 release checklist (Lane R, 2026-11-27; nothing here is done yet)

Every step that publishes something (merging to `main`, a tag, a GitHub release, the site, uploading anything) is tier
1: **Ryan does it, or says "go" for it**. The cloud prepares; it never tags, releases or pushes `main`. The design calls
for the review are in `native/docs/lanes/U9-review-list.md` (numbered there; the checkboxes in step 5 use those
numbers). The player-facing notes are `docs/release-notes-2.0.md` (a draft with a banner and "Editor's notes").

### Blockers found while writing the notes (code read at d35b788, not run on a Mac)

- [ ] **B1 MIDI keyboard input in the app.** At d35b788 (code read, not run): WKWebView has no Web MIDI; the
  `requestMIDIAccess` polyfill over the native `midi` op (ENGINE_CONTRACT §5 "v1 default", WEBKIT_AUDIT §7 A item 5)
  is not in `app/js`; `RigMIDI.listen` connects only the source ids a `midi listen` op names, and nothing in `app/js`
  sends one. If that reading holds, a keyboard plays nothing in the Mac and iPad app, and the MIDI lamp, MIDI Learn,
  Program Change, touch fitting and MIDI clock out don't work. **Being built on lane-nma** (builder + skeptic, with a
  mock-native test). Tick this box only when that lane is merged and VERIFIED **and** step 4 item 1 passes on the Mac.
  Part A of Tier 2 (Chrome + `rig-devhost`) doesn't catch it: Chrome has Web MIDI.
- [ ] **B2 Export and file import from the page.** Settings › Export library, Edit's Export song and the v6 song menu's
  Export click an `<a download>` on a `blob:` URL; `RigNavigation.swift` answers `.allow` for `blob:` (not
  `.download`) and has no `WKDownload` handling, so expect nothing saved, or the file shown in the app's window in
  place of the app. The page's file inputs (Settings › Import…, the chart's Import file, Choose pad files) need the
  UI delegate's `runOpenPanelWith` on macOS, which `RigNavigationDelegate` doesn't implement, so expect no file panel
  on the Mac (the iPad shows its own picker). File › Import Library Backup… (NSOpenPanel) is not affected. Check on
  the Mac (step 4 item 5); fix with a download delegate (save panel on the Mac, the Files picker on the iPad) and an
  open panel.
- [ ] **B3 No native release build.** `.github/workflows/release.yml` builds the **Electron** app on any `v*` tag
  (and, on `main`, on a release published from the web UI). Today a `v2.0.0` tag stops at its "Tag matches
  package.json version" step (package.json says 1.1.0 here, 1.1.1 on main), so nothing is published; but once step 7
  sets package.json to 2.0.0, the same tag publishes Electron arm64 + x64 builds of the 1.x shell under the 2.0 name.
  Before step 7 and any 2.0 tag: replace or gate that workflow (step 3).
  **Prepared on lane-n10 (not run on GitHub yet):** release.yml runs only for `v1.*` tags (push, a release published
  from the web UI, or a dispatch), and the new `release-native.yml` builds the native app for `v2.*` tags (step 3).
  Tick this box after step 3's dry run is green.

### Step 0: before starting

- [ ] Every 2.0 lane is merged on `v2-native` and VERIFIED: the core3 CI flake + CAP size rule (lane-core3f), Lane E2
  leftovers, this lane (R) after its skeptic, and B1 / B2 above.
- [ ] Ryan's answers to `U9-review-list.md` are applied (each answered item: built, reviewed, merged) or moved to 2.0.x.
- [ ] Ryan's tier-1 answers: U9 list items 1–5 and 7 (release scope, Intel / old macOS, Electron's future, who
  builds, PANIC and the drone).

### Step 1: gates on the release commit

- [ ] CI `native-core` green on the commit (`build-test` macos-15 + ubuntu, `goldens`, `mac-check` incl. `selftest`,
  `sanitizers`): `env -u GH_TOKEN gh api repos/ryanmye/worship-rig/actions/runs?branch=v2-native`.
- [ ] `node test/run-all.mjs` on the cloud box with `node tools/cloud/gates.mjs` (every suite, one at a time;
  `PLAYWRIGHT_BROWSERS_PATH=/root/.cache/rig-pw`), incl. build-lint (Electron size, fails > 480 MB).
- [ ] Tier 1 on Ryan's Mac, all stages on that commit: `bash tools/mac/check.sh --rev <sha> --stage
  tools,core,probe,apple-mac,selftest,apple-sim` (install the iOS platform first so `apple-sim` runs). Record it under
  "Results" as Mac check #5.

### Step 2: build the Release app (Ryan's Mac or CI; the same signing as 1.x)

1.x is **ad-hoc signed and not notarized** (`build/afterPack.js` runs `codesign --sign -`; release.yml sets
`CSC_IDENTITY_AUTO_DISCOVERY=false`). 2.0 keeps that: `project.yml` has `CODE_SIGN_IDENTITY: "-"` and the hardened
runtime off. Notarizing needs a paid Apple Developer ID; that is a separate tier-1 decision, not part of 2.0.

One script does the build and the packing, on the Mac and in `release-native.yml` alike (lane N10; UNRUN as written):

```sh
bash native/apple/scripts/package-release.sh --clean [--expect-version 2.0.0]
#   build-core.sh --mac-only, xcodegen, xcodebuild WorshipRig-macOS -configuration Release CODE_SIGN_IDENTITY=-
#   ARCHS=arm64 into native/apple/build/dd-release; then codesign --force --deep --sign - (as afterPack.js) and the
#   gates below; then native/apple/build/release-dist/: Worship-Rig-arm64.zip (ditto), Worship-Rig-arm64.dmg (hdiutil
#   UDZO, with an Applications link), SHA256SUMS, release.json, release-summary.md, app-path.txt
bash tools/mac/check.sh --rev HEAD --stage selftest --app "$(cat native/apple/build/release-dist/app-path.txt)"
#   the self-test ("Self-test" above) on the Release app instead of the Debug one
```

The script fails (exit 1) unless: the bundle id is `com.ryanmye.worshiprig.native` and the version is a number (and
equals `--expect-version` when given; CI passes the tag's); the executable is arm64 only; `Resources/app/index.html`
is in the bundle; no `user-samples` / `sound-packs` / `pack.json` and no Apple or pack audio / instrument file
(`.exs .caf .aif(f/c) .m4a .wav .flac .ogg .sfz .aupreset .cst .pst .patch .band .logicx`) is anywhere in it, and every
file in `Resources/app` and `Resources/docs` is tracked in git (so a GarageBand conversion or a pack copied into `app/`
fails the build even as an `.mp3`; N10 skeptic F3); `codesign --verify --deep --strict` passes and `codesign -dv` says
`Signature=adhoc` with that identifier; the app is at most 480 MB, counted in KB as build-lint does (the 500 MB rule;
a warning above 400 MB); the app inside the zip and inside the mounted dmg verifies too.

- [ ] The Release configuration has never been built: fix what it shows (the Debug build is what CI and `check.sh`
  compile).
- [ ] `release-summary.md` says `Signature=adhoc`, identifier `com.ryanmye.worshiprig.native`, version 2.0.0, and an
  app size under 500 MB (estimate ~100 MB, not measured).
- [ ] Asset names stay `Worship-Rig-arm64.dmg` / `.zip`: 1.1's update check (`update-check.js` `pickAsset`) looks for
  exactly those (checked by `test/unit/release/release-workflows.test.mjs`). There is no `x64` file (the core is
  built arm64 only), so an Intel 1.1 install is shown the release page, not a download.
- [ ] Copy the `.zip` to another account or Mac through AirDrop and do the first-open steps (macOS 15+: Done › System
  Settings › Privacy & Security › Open Anyway). The README's wording must match what macOS 26 shows.

### Step 3: the release workflow (cloud prepares, Ryan approves)

Prepared on lane-n10 (UNVERIFIED until it runs on GitHub; actionlint + shellcheck clean, and
`test/unit/release/release-workflows.test.mjs` evaluates every trigger and job `if:` per event):

- `release.yml` (Electron 1.x) runs only for `v1.*` tags: `push: tags: ['v1.*']`, and both jobs check
  `refs/tags/v1.` themselves because the `release: published` event (main's 261ea8d, folded in) and
  `workflow_dispatch` can't be filtered by tag. A branch dispatch is still a dry run. A 2.x tag, by any event, builds
  and publishes no Electron app.
- `release-native.yml` (the native app) runs on a `v2.*` tag push, on a `v2-native` push that changes the release
  files (`release-native.yml`, `package-release.sh`, `tools/release/`), and on `workflow_dispatch` (inputs `publish`,
  `latest`, both off by default). Jobs:
  - `mac` (macos-15): `brew install xcodegen ninja`; on a tag, the tag (minus `v` and any `-pre`) must equal
    `project.yml` `MARKETING_VERSION`; step 2's `package-release.sh --clean`; the self-test on the Release app
    (`check.sh --stage selftest --app`, fails the job); the release-notes preview; the summary (sizes, sha256,
    self-test JSON, whether the notes are final). Artifacts: `Worship-Rig-arm64.dmg`, `Worship-Rig-arm64.zip`,
    `release-native-meta` (SHA256SUMS, release.json, release-summary.md, release-notes-preview.md),
    `release-native-logs`.
  - `ipad` (macos-15, `continue-on-error`, never needed by `release`): `build-core.sh` (macOS + iphoneos), xcodegen,
    `xcodebuild archive` of `WorshipRig-iPad`, Release, `generic/platform=iOS`, `CODE_SIGNING_ALLOWED=NO`. An
    unsigned archive (artifact `WorshipRig-iPad-unsigned.xcarchive.zip`, 7 days) proves the Release configuration
    compiles and links for a device; it is not installable. There is no export or `.ipa`: that needs a team id, and
    the iPad install stays Xcode with Ryan's Personal Team (step 5).
  - `release` (ubuntu): only when the run is a `workflow_dispatch` **and** `publish` is ticked **and** the ref is a
    `v2.*` tag **and** `mac` passed. It checks the files against the build's SHA256SUMS, makes the body with
    `tools/release/release-notes.mjs --require-final` (docs/release-notes-<version>.md without the banner, "Editor's
    notes" and editor comments, links made absolute, a sha256 list; it refuses a file that is still a draft), and
    creates the release with the dmg, the zip, SHA256SUMS and the starter library (or attaches them to a release made
    earlier). A **pre-release** unless `latest` is ticked (U9 item 3: "latest" makes every 1.1 install offer 2.0,
    Intel ones included).

**The dry run** (publishes nothing; the orchestrator may start it with Ryan's OK, Ryan otherwise):

1. Until the 2.0 merge, `release-native.yml` is only on `v2-native`, and GitHub offers `workflow_dispatch` only for
   workflow files on the default branch. So the first dry run is the push of lane-n10 to `v2-native` (its files
   match the path filter). To run it again before the merge, push a change to one of those files, or (Ryan, tier 1)
   put `release-native.yml` on `main` alone: it does nothing there but wait for a dispatch or a `v2.*` tag.
2. Once the file is on `main`: GitHub › Actions › release-native › Run workflow › "Use workflow from" `v2-native`,
   `publish` unticked › Run. Or `gh workflow run release-native.yml --ref v2-native` (both inputs default off).
3. Find and fetch it: `env -u GH_TOKEN gh run list --workflow release-native.yml --limit 3`, then
   `gh run view <id> --log-failed` if red, and `gh run download <id> -n release-native-meta -D /tmp/rn` (add
   `-n Worship-Rig-arm64.zip` to fetch the app).

What to check on the run (and write under "Results"):

- [ ] `mac` green: package-release.sh passed every gate (version, arm64, adhoc, identifier, bundle contents, zip and
  dmg verify) and the **self-test passed** on the Release app ("Self-test: success" and the JSON with `"pass":true` in
  the summary; a failure is an `::error` "Release app self-test").
- [ ] Sizes in the summary / `release.json`: the app under **500 MB** (the gate fails above 480; a warning above
  400 MB), and the dmg and zip sizes for step 7's release notes and site.
- [ ] `release` was **skipped** (a branch or a tag push never publishes).
- [ ] `ipad`: green, or a warning with its reason (a red `ipad` doesn't block 2.0; note what it says).
- [ ] `release-notes-preview.md` reads right (step 7 makes it final).

**Publishing** is step 8 (tier 1, Ryan).

### Step 4: Mac hands-on (Ryan, about 40 minutes; after step 2's app)

Tier 2 parts A and B above, then these 2.0 items. Report as in Tier 2 ("How to report").

- [ ] 1. **MIDI keyboard in the app** (B1): the lamp lights, notes play, the pedal holds, Settings › Keyboards & MIDI
  lists the keyboard, Learn takes a knob.
- [ ] 2. **First launch with your real 1.x library**: quit 1.x, open 2.0, "Import your Worship Rig library?" ›
  Import; songs, setlists, MIDI Learn and theme as in 1.x. Confirm the Electron backups folder name
  (`ls ~/Library/Application Support`; `RigLibrary` scans `*/backups`).
- [ ] 3. **1.1.1 device settings** come over by themselves from this Mac's backups (touch curves, click, audio output).
- [ ] 4. **Song changes while holding notes** (Tier 2 A5) in the app, with **cue, then Go**: tap a chip (cued), Go,
  a footswitch on Next Song plays the cue, Prev clears it; a cold song shows "loading" until ready.
- [ ] 5. **Export and import** (B2): Settings › Export library writes a file; Settings › Import… opens a file panel
  and imports it back; the chart's Import file opens one too.
- [ ] 6. **Recording**: REC, 30 s, stop; the WAV is in Music › Worship Rig and plays.
- [ ] 7. **Buffer size 64 / 128** and **Voices per sound 128** with a big pedalled chord: no clicks. Optional: time a
  large layered chord (data for raising desktop Auto later; Ryan kept it at 128, D5 follow-up).
- [ ] 8. **8 sounds**: Edit › Slots to 8; all 8 play and meter; Chrome on the same library says 5–8 are silent there.
- [ ] 9. **Scenes with Space / Echo / drone**: save two that differ in room and drone on / off; switch with a held
  chord: glides, no restart, no click. Easy Transpose moves the scenes' drone.
- [ ] 10. **MIDI Learn any setting**: right-click a Space send in Edit › Learn MIDI knob; the knob moves it with
  pickup; Revert undoes it.
- [ ] 11. **Chord chart**: import a ChordPro file, transpose follows, auto-scroll, A− / A+; ⌘+ / ⌘− reach the page.
- [ ] 12. **Themes**: all **eight** (not six) render in the app; colour-blind colours Red–green and Blue–yellow in a
  dark theme and in Sanctuary Day.
- [ ] 13. **PANIC / Esc / Lock**: Esc closes a menu then panics; ⌘. panics at once; Esc always panics on; Lock taps on,
  holds off.
- [ ] 14. **Sleep / wake and an audio device change** (headphones ↔ interface) while the app plays.
- [ ] 15. **The new layout** (Settings › Look › Perform view › Try the new layout): go through U9-review-list.md
  sections 2–9 and answer each numbered item:
  - [ ] Perform: 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 52, 53, 54
  - [ ] Song bank and Try it: 26, 28 (needs a pack: run Chrome for this until the app reads My Samples)
  - [ ] MIDI Learn: 29, 30, 31, 32, 33
  - [ ] Edit: 34, 35, 36, 37
  - [ ] Settings: 38
  - [ ] iPad and small windows: 51, 39, 40, 41
  - [ ] Themes and colour: 42, 43, 44, 45, 46, 47
  - [ ] Esc: 48; design passes: 49, 50

### Step 5: iPad install (Ryan; needs his Apple ID)

- [ ] `native/apple/README.md` steps 7–10: `./scripts/build-core.sh` (with the iOS slice), `xcodegen`, team = his
  Personal Team, Developer Mode on, Run to the iPad, trust the developer profile.
- [ ] Launch, the page loads, a song plays (B1 decides MIDI over USB-C).
- [ ] AirDrop a 1.x backup › "Import this library?" › Import; Files › On My iPad › Worship Rig shows Backups and
  Recordings.
- [ ] The README's verification list items 6–7 (memory warning, AVAudioSession: silent switch, screen lock, a call,
  headphones in and out).
- [ ] Landscape in the new layout (U9 items 39–40). The app doesn't turn to portrait: Info-iPad allows landscape
  only, full screen (`project.yml`); U9 item 51 decides whether it should (then items 35, 41 apply).
- [ ] Note the free-account limits for the release notes (7-day expiry, data kept on re-install).
- [ ] The iPad memory budget and its Auto voice limit (Lane E6) stay for 2.0.x unless Ryan wants them first.

### Step 6: switch the new layout on by default (U9, tier 1: Ryan says when)

- [ ] After step 4 item 15's answers are built and reviewed.
- [ ] `settings.uiV6`: absent = on, `false` = off (as `settings.chartView` did in C-SHIP, D33), so libraries that never
  touched it get the new layout and anyone can still turn it off. Update `store.js` validation, `main.js`
  (`?ui6=`, `__rig.setUiV6`, the Perform / Edit mounts), the Settings row's words ("Use the classic layout"?), the
  purity probes (they then test "off" as an explicit `false`), and the release notes' "New layout" marks.
- [ ] Decide when today's views are retired (2.0 or 2.0.x); retiring them is a separate lane.
- [ ] Re-run ui-v6, ui-v6-edit, ui-v6-ipad, ui-v6-bank, ui-v6-themes, settings, ui-core, chart, edit-v2 with the
  default flipped.

### Step 7: version bumps (cloud prepares, on `v2-native`)

- [ ] `native/apple/project.yml`: `MARKETING_VERSION` is already `2.0.0`; set `CURRENT_PROJECT_VERSION` to the build
  number of the release build (1 for the first).
- [ ] `package.json` `version` (1.1.0 on `v2-native`; main has 1.1.1): release.yml's tag check
  (`tag == v<package.json version>`) now applies to `v1.*` tags only, so 2.0 doesn't need it; set it to 2.0.0 only
  if the Electron shell, if kept, should say 2.0.0. `release-native.yml` checks the tag against `project.yml`
  `MARKETING_VERSION` instead.
- [ ] Settings › About in the app: check what it shows as the version (the native `window.rig` has no `getInfo`).
- [ ] The engine's version string is still `worship-rig-core 0.1.0-skeleton` (native/core/src/api/rig_engine.cpp:51;
  seen in the first release-native dry run, 030562e): set it to the release version (or derive it from
  `MARKETING_VERSION`).
- First release-native dry run (030562e, 2026-11-27, build only): macOS Release app **89 MB** installed, zip 77.2 MB,
  dmg 86.1 MB; self-test ok (load, hello, boot, store); unsigned iPad archive 78.1 MB. Re-measure on the release commit.
- [ ] `docs/release-notes-2.0.md`: remove the banner and "Editor's notes", fill in the file names and sizes, and
  re-check "Known gaps" against what B1–B3 and U9 items 1–2 decided. The publish job refuses the file until the
  banner and "Editor's notes" are gone (`release-notes.mjs --require-final`); the dry run's summary says whether it
  would accept it.
- [ ] `docs/site/index.html`: put the measured download / installed sizes in the `download` section (the HTML comment
  there), check the What's new cards against the final scope, bump `style.css?v=`.

### Step 8: tag and release (instructions for Ryan; the cloud does none of this)

1. Merge `v2-native` into `main` (main has 1.1.1-only commits: `release.yml`'s `release: published` trigger, the site's
   1.1.1 line and `docs/release-notes-1.1.1.md`; the site part is already folded into `v2-native` by Lane R, and the
   workflow part by lane-n10: take v2-native's release.yml, which has main's `release: published` path gated to
   `v1.*`). Push `main`.
   - `pages.yml` deploys `docs/site/` on that push. Until the 2.0 release exists, the site's "Download for Mac"
     (`releases/latest/download/Worship-Rig-arm64.dmg`) still gives 1.1.1's Electron arm64 file under a page that
     says 2.0. So either release first from a tag on the merge commit and push `main` right after, or merge without
     `docs/site/` and bring it in once the release is up.
2. Tag: `git tag -a v2.0.0 -m "Worship Rig 2.0.0" <merge commit> && git push origin v2.0.0`. GitHub reads the
   workflows from the tagged commit, so tag a commit that has lane-n10's release.yml and release-native.yml (an older
   commit's release.yml would build Electron for any `v*` tag). The push runs `release-native` (build, self-test,
   files on the run; no release) and not `release`. Don't make the 2.0 release in the web UI (Releases › Draft a new
   release): nothing would attach files to it.
3. When that run is green: Actions › release-native › Run workflow › "Use workflow from" **tag `v2.0.0`**, tick
   `publish` (and `latest` only if U9 item 3 says "latest"; otherwise it is a pre-release) › Run. Or
   `gh workflow run release-native.yml --ref v2.0.0 -f publish=true [-f latest=true]`. It rebuilds, runs the
   self-test again and then creates the release.
4. Check the release page: title "Worship Rig v2.0.0", `Worship-Rig-arm64.dmg`, `Worship-Rig-arm64.zip`,
   `SHA256SUMS` and the starter library, the notes, pre-release or latest as decided.
5. Download `Worship-Rig-arm64.dmg` from the site's button on a clean account and do the first open.
6. On a Mac with 1.1.1 (only once the release is "latest"): Settings › About says 2.0.0 is available and Download
   opens the arm64 `.dmg`.
7. Tell the dashboard; revoke the away-week token if it is still live (AWAY_WEEK_PLAN §0).

### Screenshots for the 2.0 site

The site keeps today's screenshots (`docs/site/img/*.webp`): today's screens stay the default until step 6. New
shots, if wanted, from these (paths only; nothing over 1 MB goes into `docs/site/img`, and webp at 1440×900 like the
existing ones):

- 16 sounds, today's screens: `native/docs/reviews/UIA-shots/after-perform-16-1440x900.png`,
  `after-edit-16-1440x900.png` (`*-820x1180.png` are Chromium's iPad-portrait emulation; the app is landscape-only).
- Settings › Sound with the 2.0 choices: `native/docs/reviews/UIB-shots/after-sound-1440x900.png`,
  `after-sound-advanced-1440x900.png`; the categories: `native/docs/reviews/settings-shots/after-*-1440x900.png`.
- Chord chart: `native/docs/reviews/chart-view-shots/classic-1280.png`, `sanctuary-day-1280.png`, `import-1024.png`.
- Colour-blind colours, new layout: `native/docs/reviews/UI6-cvd-shots/v6-perform-16-sanctuary-rg-1280.png`,
  `v6-edit-16-split-sanctuary-rg-1280.png`; swatches `palettes.svg`.
- New layout (not in git; on the cloud box, regenerate with `node tools/themes/shoot-v6.mjs`):
  `/home/claude/design-out/` `u1`…`u8b` (`u7a/u7a-browse-1280.png` Song bank, `u7a/u7a-trying-1280.png` Try it, `u7b/u7b-stage-1280.png`
  chart on the stage, `u7c/u7c-savesnap-1280.png` Save snapshot, `u8a/` iPad).
- To retake for the release: Perform with a cued song in the setlist (cue, then Go) and the Chart button, in
  Sanctuary at 1440×900; the iPad in landscape once installed (step 5).

## Self-test (`Worship Rig --self-test`, E4)

A UI-less launch of the macOS app (`native/apple/Sources/Shared/RigSelfTest.swift`), so that the app's first launch
can happen on CI without Ryan. **UNBUILT as written:** none of the Swift had been compiled when this section was
written; the first `mac-check` run after it lands is its first build and first launch, and is the test of this text.

Run: `"<app>/Contents/MacOS/Worship Rig" --self-test` (or `RIG_SELFTEST=1`). `check.sh --stage selftest` does it
for the app the `apple-mac` stage built. Options (environment): `RIG_ELECTRON_BACKUPS=<dir>` adds the migration
step; `RIG_SELFTEST_IMPORT_MARKER` changes the song name it looks for (default "E4 self-test import", the fixture's);
`RIG_SELFTEST_SHOW=1` makes the window visible (debugging on a Mac).

What the run is like:
- `NSApplication` with the `.accessory` policy (no Dock icon, no menu bar), no SwiftUI scene. A borderless 1280×800
  window at the screen origin holds the web view, with alpha 0 and mouse events ignored: WebKit throttles timers and
  `requestAnimationFrame` in windowless or occluded views, and an off-screen window counts as occluded (a guess about
  WebKit, not measured; the result records `document.visibilityState` in `boot.visibility`).
- Audio: the core runs in realtime mode as in the app, but `rig_host.audio_start[_frames]` start
  `rig_apple_null_sink` (a pthread calling `rig_render` at 48 kHz, 128 frames, paced to the wall clock, output
  thrown away after measuring it). No Core Audio device is opened; the runner has none.
- Isolation, so a run on Ryan's Mac leaves nothing behind: a non-persistent `WKWebsiteDataStore` (no localStorage in
  the app's real store), backups and recordings under `$TMPDIR/worship-rig-selftest-<pid>` (deleted at the end),
  the migration answer not written to UserDefaults, Application Support never scanned (only
  `RIG_ELECTRON_BACKUPS`), every RigLibrary dialog answered Yes without being shown. CoreMIDI is created as in the
  app (a client and two ports; no source is connected).
- Budget: 60 s inside the app (a watchdog thread prints a `timedOut` result and `_exit(1)`); `check.sh` adds 120 s
  outside it. A normal run should take about 5-15 s (a guess).

Checks, in order (`required: false` ones are reported, not gated):

| check | passes when |
|---|---|
| `engine` | `rig_create` returned an engine |
| `load` | `didFinish` for `rig://app/index.html` within 20 s (no navigation failure, no WebContent crash) |
| `hello` | the page's `hello` (seen on `webkit.messageHandlers.rig`) got `ok:true`, `protocol` 1, `minor` ≥ 5 within 15 s |
| `boot` | `await window.__rig.ready` resolved within 25 s and `__rig.engine` is a `BridgeEngine` (the scheme handler's `main.js` patch worked, so the page uses the native core, not Web Audio) |
| `store` | `__rig.store` exists, `get().schema === 2`, at least one song, `loadInfo.status` `ok` or `fresh` |
| `audio` | the page's `audio start` reached the shell: ≥ 12000 frames on the null output within 5 s, 0 render errors, a `state` event `running` |
| `note` (not required) | `play {e:'input'}` + note 60 vel 100 through `rig_post` on the song the page committed: peak > -100 dBFS within 0.6 s |
| `migration` (with `RIG_ELECTRON_BACKUPS`) | `RigLibrary.offerFirstLaunchImport` (newest backup there that parses: the fixture's newer truncated file is skipped, review E5 item 3; pristine library, auto Yes) staged the file, `controller.onMenu('importLatestBackup')` imported it, and a song named the marker is in the library with schema 2 within 10 s |
| `midi` (not required) | `MIDIClientCreateWithBlock` returned 0 |
| `webcontent` | no WebContent process termination |
| `console` | zero page errors: `console.error` calls, uncaught errors, failed resource loads, unhandled rejections, CSP violations (a document-start hook posts each one to `rigSelfTest`) |
| `http` | zero rig:// responses with status ≥ 400 (`RigSchemeHandler.onStatus`) |

Exit 0 only when every required check passed and nothing timed out. `check.sh` also fails the stage when the JSON
says pass but the process exited non-zero: the self-test quits with `exit()`, the path `NSApp.terminate` takes, so
a crash in the core's or WebKit's teardown shows up here (the null output is stopped first).

The result (one line on stdout, keys sorted; check.sh copies it to `selftest.json`):

```json
{"audio":{"engineTime":0,"frames":0,"lateBlocks":0,"renderErrors":0,"sinkStarts":1,"stateRunning":true,"states":[]},
 "boot":{"engineKind":"BridgeEngine","loadStatus":"fresh","ms":0,"phase":"ok","pristine":true,"schema":2,"songs":19,
         "store":true,"userAgent":"...","visibility":"visible"},
 "checks":[{"detail":"...","ms":0,"name":"engine","ok":true,"required":true}],
 "failed":[],"hello":{"caps":[],"engine":"worship-rig-core ...","minor":5,"protocol":1,"sampleRate":48000,"seed":0},
 "host":{"apiVersion":65537,"app":"2.0.0 (1)","core":"...","os":"macOS 15.x","tempRoot":"...","webkit":"..."},
 "migration":{"dir":"...","outcome":"staged","probe":{"hit":true,"schema":2,"songs":2}},
 "note":{"peak":0,"peakDb":0},"page":{"errorCount":0,"errors":[],"http":[],"httpResponses":0},
 "pass":true,"schema":1,"seconds":0,"timedOut":false,"tool":"worship-rig-selftest"}
```

Each check is also logged to stderr as `selftest: ok|FAIL|warn <name>: <detail>` (in `selftest.log`; `check.sh`
echoes them into its own output, so they are in the CI log).

What it covers that nothing else did: the app's first launch (SwiftUI entry point, bundle resources, `rig://`
scheme handler, ES modules over a custom scheme, the `main.js` engine patch, the `window.rig` polyfill and the
document-start scripts, localStorage on `rig://app`), the BRIDGE v1 round trip through `WKScriptMessageHandler` and
`evaluateJavaScript`, the realtime core rendering inside the app process, the controller's boot on the native
engine, the RigLibrary first-launch import end to end against a fixture, and a clean quit.

What it cannot cover (stays on the Tier 2 list):
- **Real audio**: AUHAL, the device rate, buffer sizes, xruns, latency (RigAudio.swift and rig_apple_audio.c never
  run; the probe stage covers them on Ryan's Mac).
- **MIDI**: no device, so no CoreMIDI input, timestamps or hot-plug. The page's MIDI comes up "available" with no
  ports (lane NMA adapter: one `midi listen` request at boot, answered by the core).
- **Ryan's ears**: whether anything sounds right; the `note` check only says "not silence".
- **His real library**: the fixture is a synthetic 1.x-shaped backup (two factory songs), not a real export (Lane E 5);
  the real scan of `~/Library/Application Support/*/backups` and the native dialog are skipped.
- **The visible UI**: themes, layout, input; the window is transparent.
- The SwiftUI scene path itself (`WindowGroup`, `RigWebView`, `.onOpenURL`, the menu commands): the self-test builds
  its own window around the same `RigHost`.
- The iPad target (the mode is macOS only).

Verified before CI (Linux, 2026-11-25): `rig_apple_null_sink` against the realtime core
(`native/apple/selftest/run-null-sink-test.sh`, gcc 13 / clang 20 `-Werror`, TSan clean); the three JS bodies, the
fixture and its import (`node --test "test/unit/selftest/*.test.mjs"`, 9 tests); the stage's bash paths behind stub
macOS tools and a fake app (shellcheck 0.11 clean); the workflow (actionlint clean). A tree-sitter Swift parse of the
changed files finds no syntax error beyond the grammar's known `#if`-inside-a-type gap (also in the unchanged files).
Not verified: anything that needs the Swift compiler, AppKit or WebKit.

## Known gaps found while building this (owners: core / orchestrator)

- **Realtime sampler without a preload was silent: closed** (CORE1, `reviews/CORE1.md`). The control loop pumps the
  cache every turn and the decode workers wake it; `unit.runtime_cache` gets 128 voices cold. `rig-probe
  --no-preload` gives 121 voices with the probe's default role layout (slot 3 takes the Bass range), 128 with every
  slot full range. Since CORE2A, `cache preload` is also answered asynchronously, so a cold song switch no longer
  stops ticks or live input (`reviews/CORE2A.md`).
- **Three core tests failed in any clean checkout: closed** (INTERFACE_LOG 38): `unit.samples_decode`,
  `unit.samples_process` and `unit.samples_service` now skip when `tools/golden/decode-dump/data/raw*` is absent.

## Mapping of the old Mac/iPad list

| item (REPICKUP section 6, README, SETUP_REVIEW 5) | tier |
|---|---|
| Swift and C compile for both targets, XcodeGen output, `build-core.sh` slices | 0 (`mac-check`) and 1 (`apple-*`) |
| core `ctest` under Apple clang, goldens on macOS | 0 (`build-test` macos-15) and 1 (`core`, goldens excluded) |
| AUHAL at 64/128 frames, granted size, xruns, CPU per voice, D4 'auto' | 1 (`probe`, through miniaudio's Core Audio backend, which uses AUHAL) |
| T07 O6 jitter-free delay = device buffer + one quantum: device latency figures | 1 (`probe.device.core_audio`: device, safety-offset, stream latency frames) |
| CoreMIDI timestamps, real sound, themes, Electron localStorage migration, GarageBand content, iPad install and AVAudioSession | 2 |
| App launch, `rig://` load, bridge `hello`, boot on the native core, library schema, first-launch migration against a fixture, zero console errors / 404s | 0 (`mac-check` `selftest`, E4) and 1 (`selftest`) |
| iPad CPU per voice (D4 iPad profile) | open: needs an iPad build of the probe (no iOS test target yet) |
