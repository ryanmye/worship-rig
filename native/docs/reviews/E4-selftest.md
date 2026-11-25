# Lane E4 (Mac app `--self-test`, check.sh `selftest` stage, CI step): skeptic review, 2026-11-25

Verdict: **VERIFIED** (upgraded by the orchestrator on 2026-11-25 from CI run 45556580456 at 3e1d006: apple-mac
PASS, 0 warnings; apple-sim PASS, 1 warning as before; the self-test PASS, 12/12 checks in 10.81 s: hello minor 5,
`visibility visible` (E7 settled), 58240 frames, 0 render errors, `state running`, note peak -3.2 dBFS, migration
imported 2 songs at schema 2, 0 page errors, 90 rig:// responses with none >= 400, 0 WebContent terminations.
124 late null-sink blocks are informational. `continue-on-error` dropped.) It was **VERIFIED-PENDING-CI**: Everything that runs off a Mac was run here and passes. That covers the null sink
on the real realtime core (gcc 13, clang 20 `-Werror -Weverything`, TSan, ASan+UBSan), the JS bodies and the
fixture, the check.sh stage behind stubs (pass, fail, hang, crash, crash at quit, garbage, no app, not macOS),
shellcheck, actionlint and a tree-sitter Swift parse. A line-by-line reading finds the default (non-self-test) path
unchanged and the isolation real. No defect would stop the build or corrupt Ryan's library. Six smaller defects are
fixed here (E3-E6, E8, E9). The Swift has still never been compiled, and the alpha-0 window's WebKit visibility (E7)
is a guess that only CI can settle.

Tree: `/home/claude/wt-e4` (`lane-e4`, uncommitted on `10c3ec7`) plus this review's edits. The core libraries were
linked read-only from `/home/claude/worship-rig/native/core/build-int{,-tsan,-asan}`; their `src/` and `include/`
are identical to this tree's (`diff -rq`). shellcheck 0.11.0 / actionlint 1.7.12 / tree-sitter-swift came from a
throwaway venv in `/tmp`. Nothing was installed system-wide.

## What CI's first run must show to upgrade to VERIFIED

In `mac-check` (`macos-15`):
1. `apple-mac` PASS with **0 compiler warnings**, and `apple-sim` PASS with no new warning (1 before). This is the
   first compile of RigSelfTest.swift, the `@main` move and `init(selfTest:)`, on both targets.
2. The step `tools/mac/check.sh --stage selftest` has **outcome `success`**. The log shows `selftest   PASS ... N
   checks, every required one passed`, no `::error` / `::warning` annotation and no crash report in the artifact.
3. `check-out/selftest/selftest.json` shows:
   - `pass:true`, `timedOut:false`, `seconds` < 60
   - `hello`: `protocol` 1, `minor` >= 5
   - `boot`: `phase` "ok", `engineKind` "BridgeEngine" and **`visibility` "visible"** (E7)
   - `audio`: `frames` >= 12000, `renderErrors` 0, `stateRunning` true, `lateBlocks` close to 0
   - `migration`: `outcome` "staged", `probe.hit` true, `schema` 2, `songs` 2
   - `page`: `errorCount` 0, `http` [], `httpResponses` > 0
   - `webcontent`: 0 terminations
   - process exit 0, so there was no crash at quit (E11)
4. `note` and `midi` are informational, but record them: a `note` peak of -200 dBFS means the core rendered silence
   for a committed song, and that should get its own look.
5. `goldens`, `build-test` and `sanitizers` stay green, and the `mac-check` job is green overall.

If item 2 or 3 fails: PARTIAL (or FAILED if the app does not launch at all), with the `failed` list and
`selftest.log` as the evidence.

## Findings

- **E1 (verified): the default path is unchanged.** RigHost with `selfTest == nil` builds the same
  configuration. `audio_start` now goes through `audioStart(... bufferFrames: 0)` to
  `audio.start(..., bufferFrames: 0)`, the same as the old call because RigAudio's default is 0. `audio_stop` is
  unchanged. The deinit's extra `stopNullSink()` is a no-op. The pump, bridge, navigation and scheme hooks are nil
  optional calls. RigLibrary with `autoOffer = true`, `persistAnswer = true` and `autoAnswer = nil` keeps the old
  guards, the UserDefaults write, the readyProbe, the dialog and the staging, and every new `report(...)` is a no-op
  without `done`. `RigEntry.main` falls through to `WorshipRigApp.main()` unless `--self-test` or `RIG_SELFTEST=1`
  is given. A custom `@main` with `@MainActor static func main()` calling `App.main()` is a valid pattern, and the
  `@MainActor` is what keeps it legal under Swift 6 compilers. `RigHost()` resolves to `init(selfTest:)`: NSObject's
  `init()` is no longer inherited, so the call cannot be ambiguous. `iOS`: everything outside `#if os(macOS)` in
  RigSelfTest.swift is Foundation/WebKit, and the null sink is plain C + pthreads.
- **E2 (verified, with residue): isolation.**
  - The web data store is non-persistent.
  - `overrideRoot` is set before `RigHost` exists, so `ensureDirectories`, `recordings_dir` and `backupsDir` all
    point into `$TMPDIR`, which is deleted at the end.
  - The UserDefaults key is never written. The shell writes UserDefaults nowhere else (grep).
  - `electronEntries()` reads only `RIG_ELECTRON_BACKUPS`, and returns `[]` without it.
  - `latestAnywhere()` cannot pick a self-made backup over the fixture, because `controller.backupNow` never writes
    a pristine library.
  - No `~/Music` or Application Support path is touched, so there are no TCC prompts.
  - Not audited: defaults that AppKit or WebKit may write internally.
  - `RIG_SELFTEST=1` is also the Electron self-test switch. A shell with it exported would start the native app in
    self-test mode, which is harmless (isolated, exits).
- **E3 (fixed): `RigSelfTest.run()` was nonisolated** while it called `NSApplication.shared` and constructed an
  `NSApplicationDelegate` class. That class may be inferred `@MainActor` from its conformance. This was probably
  fine in Swift 5 mode, since the same pattern is in RigHost, which builds with 0 warnings, but it is now
  `@MainActor`, like its only caller.
- **E4 (fixed): App Nap.** An `.accessory` process with no visible window is an App Nap candidate. App Nap coalesces
  the main-thread polls and the sink's `nanosleep` pacing. The runner now holds
  `beginActivity([.userInitiatedAllowingIdleSystemSleep, .latencyCritical])`. The window also gets
  `isRestorable = false`.
- **E5 (fixed): a restart could outlive `finish()`.** `stopNullSink()` ran, then `exit()`. A restart that the core's
  device thread issued in between would start a new sink, which would call `rig_render` during static destruction.
  `stopNullSink(closing: true)` now refuses any later `audio_start`.
- **E6 (fixed): an `inf` note peak made the whole report unserialisable.** JSONSerialization rejects non-finite
  numbers, so the fallback line dropped every check and read `pass:false`, even though `note` is not required. Now
  `peak` is -1, `finite` is false, and `note` warns.
- **E7 (open, CI decides): the alpha-0 window may count as occluded.** I am not sure whether WindowServer reports a
  fully transparent window as visible. I recall Electron reports of `opacity 0` windows on macOS going `hidden`, but
  I have not checked them.
  - If it does not count as visible, the page's timers are throttled and rAF stops (one rAF in main.js, not on the
    boot path).
  - Timers would still fire, late, so this slows the run and should not fail it.
  - `boot.visibility` records it.
  - If it reads "hidden": try `alphaValue = 0.01`, or the `_windowOcclusionDetectionEnabled` SPI.
- **E8 (fixed): a SKIPPED self-test looked green on CI.** When the compile step fails, check.sh SKIPs with exit 0.
  The result step now emits `::warning ... did not run`. Both steps use `if: ${{ !cancelled() }}`: they still run
  after a failed build, but not after a cancel.
- **E9 (fixed): crash evidence in check.sh.** The `.ips` was searched for the instant the process died, but
  ReportCrash writes it afterwards. The stage now waits 5 s after a signal exit. Also, when a crash note was present,
  the stderr tail was dropped from `errors`. It is now kept, before the note.
- **E10 (open, low): a stale app with `--src`.** `<cache>/local/dd-apple-mac` survives across different `--src` trees.
  So `--src X --stage selftest`, without `apple-mac`, launches whatever was built last, and `dd-` wins over a newer
  `sym-`. With `--rev`, the cache is per sha and the problem does not arise. CI and Mac check #4 are unaffected.
- **E11 (open, by design): `exit()` with the core's threads alive.** This is NSApp.terminate's path, so a crash at
  quit is a real finding. Expect possible flakes there before blaming the self-test.
- **E12 (open): the workflow's `paths` do not include `app/**`.** A UI change outside `app/js/engine/` does not run
  the only launch of the app. Adding it would trigger the whole heavy workflow, so this is Ryan's or the
  orchestrator's call.
- **E13 (accepted): `selftest` is in the default stage list.** Mac check #4 is an explicit
  `--stage tools,core,probe`, and `--quick` is unchanged, so neither is affected. A plain `check.sh` builds
  `apple-mac` first, then launches that fresh build. The launch is isolated (E2). It is transparent,
  mouse-transparent and never activated, and it adds about 15 s. It needs a GUI login session: from the push agent
  in Terminal that is fine, but over a bare ssh session the stage would FAIL.
- **E14 (process): `node_modules` in the worktree is an untracked symlink.** `.gitignore`'s `node_modules/` pattern
  does not match a symlink. Do not `git add -A`.
- **E15 (note): the step budgets add up to more than 60 s** (20+15+25+5+1+30+10). On a very slow run, the report says
  `timedOut` instead of naming the step. The stderr lines still show where it stopped.

## Measured here

| check | result |
|---|---|
| `run-null-sink-test.sh` (gcc, `build-int`) | PASS 12/12: 24064 frames in 0.5 s, 0 late, restart 14592 in 0.3 s, `rig_destroy` 1 ms |
| sink compile gcc / clang-20 `-O0/-O2 -Wall -Wextra -Werror -Wpedantic -Wconversion -Wsign-conversion -Wshadow` | clean; clang-20 `-Weverything` (minus padded / C++-compat / unsafe-buffer) clean; `--analyze` clean |
| TSan (gcc, sink + test `-fsanitize=thread`, `build-int-tsan` core) | 3/3 runs PASS, no report |
| ASan + UBSan (`-fno-sanitize-recover`, `build-int-asan` core, leaks on) | 3/3 runs PASS, no report |
| `node --test 'test/unit/selftest/*.test.mjs'` | 9/9 |
| `node --test "test/unit/**/*.test.mjs"` | 663 pass, 0 fail, 10 skip |
| check.sh `--stage selftest` stubs (fake `uname`/`xcodebuild`/`sw_vers`/…, fake app) | pass → PASS rc 0; required fail → FAIL rc 1 with `errors` = FAIL lines; hang → FAIL at 120 s, process tree killed; SEGV before result → FAIL + `.ips` copied; abort after a pass line → FAIL "exited 134"; pass + exit 1 → FAIL; garbage stdout → FAIL; no app → SKIPPED rc 0; Linux → SKIPPED. The app got `--self-test`, `RIG_SELFTEST=1` and the fixture dir |
| shellcheck 0.11 (check.sh, run-null-sink-test.sh) / actionlint 1.7.12 + shellcheck | clean / clean |
| tree-sitter-swift parse of all `Sources/Shared/*.swift` | 0 ERROR nodes |
| fixture | synthetic: two songs built from factory instruments (salamander-piano, warm-pad, strings, glass-pad), no sample data, no GarageBand / Apple content, no user paths; not git-ignored |

## Fixes made in this review

- `RigSelfTest.swift`: `@MainActor run()` (E3); `beginActivity` token (E4); `isRestorable = false`; finite-peak
  guard (E6); `stopNullSink(closing: true)` in `finish()` (E5).
- `RigHost.swift`: `nullSinkClosed` and `stopNullSink(report:closing:)` (E5).
- `tools/mac/check.sh`: 5 s wait for ReportCrash after a signal exit, and the stderr tail kept alongside the crash
  note (E9).
- `.github/workflows/native-core.yml`: `!cancelled()`; `::warning` on SKIPPED (E8).
- `CONTRACT_CHANGES.md` E4: one bullet listing these.

## Open items

E7 (visibility: read `boot.visibility` on the first run), E10, E11, E12, E14. Also, `run-null-sink-test.sh` is not
run by any CI job. Adding it to `build-test` on Linux would keep the sink tested off the Mac.
