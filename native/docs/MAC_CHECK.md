# Mac checks with as little Mac time as possible

Goal (Ryan, 2026-11-20): the Mac push agent tests the Mac things, and Ryan's own hands-on Mac time is spent only on
what cannot be automated. Everything that can run without a human runs in tier 0 (GitHub CI) or tier 1 (one
unattended command on the Mac). Tier 2 is one short checklist for Ryan, done once, after songs play.

| tier | where | who | cost to Ryan | covers |
|---|---|---|---|---|
| 0 | GitHub Actions `macos-15` (`.github/workflows/native-core.yml`) | CI, on every push touching native/ or tools/mac/ | none | core build + ctest + goldens under Apple clang (`build-test`), Apple compile of both targets (`mac-check`) |
| 1 | Ryan's Mac, `bash tools/mac/check.sh` | the push agent, one `RUN` | none after the one-time setup below | tier 0 again on the real Mac, plus the audio probe on the real output device (D2, D4 numbers) |
| 2 | Ryan's Mac and iPad, by hand | Ryan | about 20 minutes, once, after T13/T14 | what needs ears, hands, a MIDI keyboard, his real library, an iPad |

Status: `tools/mac/check.sh` and `rig-probe` are tested on Linux (argument parsing and usage errors, `git archive`
export and reuse, `--src`, the core stage from a clean export, the probe stage on the null audio backend, missing-tool
and bad-revision paths, `summary.json` parsed back, Apple stages SKIPPED with a reason; shellcheck clean). The skeptic
review (`native/docs/reviews/mackit.md`) also ran the macOS code paths on Linux behind stub `uname`/`xcodebuild`/
`xcodegen`/`sw_vers`/`sysctl`/`libtool` commands (compile error capture, scheme fallback, simulator platform missing,
Xcode license), the timeout watchdog and a TERM in the middle of the core build (summary still written, no process
left behind). The script
was written for `/bin/bash` 3.2 but only run under bash 5 here. The macOS-only
parts (Core Audio probe run, `build-core.sh`, `xcodegen`, `xcodebuild`, the `mac-check` CI job) are written but have
never run: the first tier-0 or tier-1 run is their test.

## Tier 0: CI (no Mac)

- `build-test` (matrix `ubuntu-latest`, `macos-15`): `cmake --preset release`, build, `ctest` incl. the golden
  comparisons (the `goldens` job renders them with the pinned Chromium).
- `mac-check` (`macos-15`): `bash tools/mac/check.sh --rev HEAD --stage tools,apple-mac,apple-sim --out check-out`,
  uploaded as the `mac-check` artifact. It builds the xcframework slices, generates the project and compiles
  `WorshipRig-macOS` and `WorshipRig-iPad` (iOS Simulator). `summary.json` carries the first 80 compiler errors per
  stage (`file:line: error: ...`, repo-relative), so the cloud can fix Swift from the artifact alone.
- The workflow triggers on `native/core`, `native/golden`, `native/contract`, `native/apple`, `native/devhost`,
  `tools/golden`, `tools/mac`, `app/js/engine` and the workflow itself.

When tier 0 is green, tier 1 is mostly a confirmation on Ryan's machine plus the probe numbers.

## Tier 1: `tools/mac/check.sh` through the push agent (one RUN, unattended)

```sh
bash tools/mac/check.sh [--rev <ref>] [--stage tools,core,probe,apple-mac,apple-sim] [--out <dir>] [--quick]
                        [--jobs N] [--cache <dir>] [--repo <dir>] [--src <tree>]
```

Run from `~/Projects/worship-rig`. Defaults: `--rev` = the local branch `v2-native` (the push agent fast-forwards it),
else `origin/v2-native`; all five stages; `--out` = `~/Projects/worship-rig-v2/outbox/logs/<UTC>-check/` (when the
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
  exists, the script sets `DEVELOPER_DIR` for its own process only. The app is never launched. The probe opens the
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
| `apple-sim` | `scripts/build-core.sh --sim --no-device`, `xcodegen`, `xcodebuild -scheme WorshipRig-iPad -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO ARCHS=arm64 build` (a generic destination otherwise also builds x86_64, which the arm64-only simulator slice cannot link); SKIPPED with a note if this Xcode has no iOS Simulator SDK | 2-4 min / 1 min |

Estimated total: 8-12 min for a new revision, about 3 min for a rerun of the same one, 1-3 min for `--quick` after a
Swift-only change. Measured on the 2-vCPU Linux box (`--jobs 2`, clean export of e2b5219): export 1 s, core 153 s
(build + 49 tests), probe 61 s (devhost build + tests + the probe in `--quick` mode on the null backend). The Apple
stages are estimates; the first real run replaces them (`summary.json` has `seconds` per stage).

If XcodeGen's project has no scheme that xcodebuild can auto-create, the Apple stages fall back to a target build
(`-target <name> -sdk <sdk> -arch arm64`); the log says so.

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

The probe preloads each song (`cache preload`) before `prepare`. Reason, found while building it: in realtime mode
the engine's control loop never calls the cache service's `pump()`, so samples requested by a cold `prepare` are
decoded but never delivered and a sampler stays silent (the dev host and the Apple shell both run realtime). Owner:
core (`api/engine.cpp` `controlLoop`, `samples/cache_service` `setWake`/`pump`). The app's controller preloads songs,
which hides it in normal use, but a song opened without a preload would be silent.

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
- bash -c "$(git -C ~/Projects/worship-rig show v2-native:tools/mac/check.sh)" check.sh --repo ~/Projects/worship-rig [--rev <v2-native|origin/v2-native|7-40 hex sha>] [--stage <comma list of tools,core,probe,apple-mac,apple-sim>] [--quick] [--out ~/Projects/worship-rig-v2/outbox/logs/<UTC>-check]   (read-only git; builds only under ~/Library/Caches/worship-rig-check; installs nothing; no sudo; 3-20 min, so start it with the Bash tool's run_in_background and wait for it: the foreground limit is 10 min; reply with the exit code and the summary.json path)
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

## Tier 2: Ryan by hand (one checklist, deferred until songs play)

Do this once, after T13/T14 (song model and perform) land and tier 1 is green; until then there is nothing to hear.
About 20 minutes with the MIDI keyboard and the iPad at hand. Write the results into `native/docs/SHELL.md`.

1. **Launch** the macOS build: `open ~/Library/Caches/worship-rig-check/<sha7>/dd-apple-mac/Build/Products/Debug/Worship\
   Rig.app` (the last check's build), or Product > Run in Xcode: the window opens, the page loads from `rig://app/`,
   no blank window.
2. **MIDI keyboard** (CoreMIDI timing): play fast repeated notes and a chord with the pedal; notes start without
   audible lag or flams, pedal holds and releases.
3. **Sound at 128 frames**: Settings > Sound > buffer 128 (the granted size shows); play a pad and a piano for a
   minute: no clicks or dropouts. Try 64 if the probe said `safe: true`.
4. **Themes**: switch through the six themes; each renders (colours, `light-dark()`).
5. **Library**: first launch offers the Electron library import; Yes brings the songs over (Electron origin
   127.0.0.1:8438 -> `rig://app`); then Settings > Library & Backup > import latest backup works too. Relaunch: the
   library is still there.
6. **A GarageBand-imported sample** (My Samples): one real GarageBand/Logic instrument imports and plays.
7. **iPad install** (`native/apple/README.md` steps 7-10): build for the device with the free Apple ID team, trust
   the developer on the iPad, the app opens, plays through the speaker and over headphones, keeps playing with the
   screen locked.

Everything else on the README's "Mac / iPad verification list" (WebContent crash recovery, memory-pressure simulation,
AVAudioSession interruptions) is optional for Ryan; it can be scripted into tier 1 later (a UI-less `--self-test` mode
of the app would be the next step: launch, load, `hello`, quit, all from `check.sh`).

## Known gaps found while building this (owners: core / orchestrator)

- **Realtime sampler without a preload is silent.** `api/engine.cpp` `controlLoop` never calls the cache service's
  `pump()` and nobody calls `setWake`, so decodes started by a cold `prepare` in realtime mode are never integrated
  (`sampler_service.cpp`: "realtime on a later pump()"). Shown by `rig-probe` on the null backend: 16 slots of
  `ep-rhodes`, 8 notes held, 0 voices; with a `cache preload` first, 128 voices. The probe preloads; the core should
  pump the cache in its control loop (and set the wake to its semaphore).
- **Three core tests fail in any clean checkout** (CI's `build-test` included): `unit.samples_decode`,
  `unit.samples_process` and `unit.samples_service` (`pcmOverride` case) need `tools/golden/decode-dump/data/raw44100`
  / `raw48000`, which `.gitignore` excludes while `data/manifest.json` is committed, so `Dump::ok()` is true and the
  tests REQUIRE files that are not there. They should skip when the raw dumps are missing (as the goldens do), or CI
  should generate them. `check.sh` reports them as `NoData` meanwhile.

## Mapping of the old Mac/iPad list

| item (REPICKUP section 6, README, SETUP_REVIEW 5) | tier |
|---|---|
| Swift and C compile for both targets, XcodeGen output, `build-core.sh` slices | 0 (`mac-check`) and 1 (`apple-*`) |
| core `ctest` under Apple clang, goldens on macOS | 0 (`build-test` macos-15) and 1 (`core`, goldens excluded) |
| AUHAL at 64/128 frames, granted size, xruns, CPU per voice, D4 'auto' | 1 (`probe`, through miniaudio's Core Audio backend, which uses AUHAL) |
| T07 O6 jitter-free delay = device buffer + one quantum: device latency figures | 1 (`probe.device.core_audio`: device, safety-offset, stream latency frames) |
| CoreMIDI timestamps, real sound, themes, Electron localStorage migration, GarageBand content, iPad install and AVAudioSession | 2 |
| iPad CPU per voice (D4 iPad profile) | open: needs an iPad build of the probe (no iOS test target yet) |
