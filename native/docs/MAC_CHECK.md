# Mac checks with as little Mac time as possible

Goal (Ryan, 2026-11-20): the Mac push agent tests the Mac things, and Ryan's own hands-on Mac time is spent only on
what cannot be automated. Everything that can run without a human runs in tier 0 (GitHub CI) or tier 1 (one
unattended command on the Mac). Tier 2 is one short checklist for Ryan, done once, after songs play.

| tier | where | who | cost to Ryan | covers |
|---|---|---|---|---|
| 0 | GitHub Actions `macos-15` (`.github/workflows/native-core.yml`) | CI, on every push touching native/ or tools/mac/ | none | core build + ctest + goldens under Apple clang (`build-test`), Apple compile of both targets (`mac-check`) |
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
the macOS `xcodebuild` PASS; the simulator build needs the iOS platform installed); no result of the `mac-check` CI job
has been read back here yet.

## Results

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

## Tier 2: Ryan hands-on checklist (integrator, 2026-11-22: engine and UI wave done)

**When:** after the push agent's tier-1 `check.sh` RUN on the integration commit shows `core`, `probe` and
`apple-mac` PASS (`apple-sim` may stay FAILED/SKIPPED for the missing iOS platform). About 25 minutes, MIDI keyboard
with a sustain pedal, headphones or the usual speakers. The 2.0 UI runs in Chrome on top of the native engine through
`rig-devhost` (the dev host: real UI, real C++ engine, Core Audio output, Chrome's Web MIDI). The Apple app itself has
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
   meters keep moving during the switch. Known: switching *to* a song with synth or organ sounds builds them on the
   engine's control thread, which held input back by up to ~0.3 s on the Linux box (open item CORE2A O2); say
   whether you can feel it on the Mac.
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
3. Switch through the six themes: each renders.
4. One real GarageBand / Logic instrument through Settings › My Samples imports and plays.

The iPad install (`native/apple/README.md` steps 7-10) comes after part B.

**How to report.** For each step number: **OK**, or **not OK** + one line (what you heard or saw, which song, the
clock time). Send that list in the chat with the cloud session, with `~/Desktop/rig-bridge.jsonl` and the last ~50
lines of the Terminal window attached (the bridge log has every message with a timestamp, so a glitch at a given clock
time can be traced). A screenshot for anything visual.

Everything else on the README's "Mac / iPad verification list" (WebContent crash recovery, memory-pressure simulation,
AVAudioSession interruptions) is optional for Ryan; it can be scripted into tier 1 later (a UI-less `--self-test` mode
of the app would be the next step: launch, load, `hello`, quit, all from `check.sh`).

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
| iPad CPU per voice (D4 iPad profile) | open: needs an iPad build of the probe (no iOS test target yet) |
