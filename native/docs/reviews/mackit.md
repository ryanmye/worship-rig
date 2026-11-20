# Mac check kit (`tools/mac/check.sh`, `rig-probe`, CI `mac-check`): skeptic review

Tree: `ad45bff` (the orchestrator checkpointed the kit while the review ran) + this review's edits. Box: 2-vCPU Linux,
`--jobs 2`, own caches under the session scratchpad (deleted afterwards). No Xcode, no bash 3.2 here.

## Verdict

**PARTIAL**: everything that can run on Linux runs and passes; the macOS-only commands (Core Audio probe run,
`build-core.sh` on Apple toolchains, `xcodegen`, `xcodebuild`, the CI job) are still unexecuted and get their first
test in CI's `mac-check` or the first RUN. Seven defects fixed in owned files (below); none blocks a first run.

Re-run here, after the fixes:

- Full default run from a clean `git archive` of `HEAD` (`ad45bff`): export 1 s, tools PASS, core PASS 159 s (46
  passed, the three `unit.samples_*` listed as `NoData`: builder gap 2 confirmed, `.gitignore` line 26), probe PASS
  58 s (null backend; `auto_voice_limit_suggestion.desktop` 64 at 9.07 us/voice), Apple stages SKIPPED "not macOS",
  exit 0, `summary.json` parses.
- The macOS branches on Linux behind stub commands on `PATH` (`uname` -> Darwin/arm64, `sw_vers`, `sysctl`,
  `xcode-select`, `xcodegen`, `libtool`, `xcodebuild`): `apple-mac` ran the real `build-core.sh --mac-only` (the
  core's macOS-slice CMake build, here with g++), the stub xcodegen, then a stub xcodebuild emitting a duplicated Swift
  error: FAIL, one error, repo-relative (`native/apple/Sources/Shared/RigHost.swift:42:9: error: ...`). Scheme
  fallback (`does not contain a scheme named` -> `-target` build): PASS. Simulator platform not installed: SKIPPED
  with the download note. Unaccepted license: `tools` FAIL "Xcode license not accepted ...", Apple stages SKIPPED with
  that reason. Host block shows "6 performance + 6 efficiency" from the stub sysctl.
- Timeout watchdog: a `bash -c 'sleep 50 & sleep 60'` tree is killed whole at the deadline (rc 124, nothing left);
  stdin is `/dev/null` (`cat` returns at once).
- TERM to `check.sh` 15 s into the core build: exit 143 within a second, `summary.json` written with
  `"interrupted": "signal during core"`, core FAIL "interrupted", the table printed on the run's stdout, no compiler
  or ninja process left.
- Cache pruning: with 4 older 7-hex dirs plus `local/` and `notes/`, the 3 newest hex dirs stay, the others go,
  non-hex names untouched.
- `bash -c "$(git show <rev>:tools/mac/check.sh)" check.sh --repo <repo> ...` (the new allow-list form): works,
  `--help` falls back to a one-line usage when `$0` is not a file.
- shellcheck 0.11 clean on `check.sh` and `build-core.sh`; `bash -n`; workflow YAML parses.

## Fixed here

| # | severity | defect | fix |
|---|---|---|---|
| 1 | HIGH | Only `rig-probe` had a timeout; cmake configure/build, both ctest runs, `build-core.sh`, xcodegen, every xcodebuild (incl. `-version`/`-showsdks`) could hang the unattended run forever. The old `run_timeout` also TERMed only the direct child (cmake -> ninja -> clang and xcodebuild -> swift-frontend survive). | `tmo`: watchdog kills the whole process tree (`pgrep -P`, collected before any kill), stdin from `/dev/null`, rc 124 + a log line; every long command goes through it (budgets in MAC_CHECK.md "It never waits forever"). `in_dir` + `exec` replaces `(cd x && cmd)` so the timeout reaches the command itself. |
| 2 | HIGH | The push agent is a Claude Code session: a foreground Bash call is killed at 10 min, a first run takes 8-15 min. Killed, `check.sh` left children running and wrote no `summary.json`. | TERM/INT/HUP trap: kills the running tree, records the stage as FAIL "interrupted", writes `summary.json` (`"interrupted"` field) on the run's own stdout (fd 3/4: the signal lands inside a `>> log` redirection), exit 143. The allow-list line now says to start it with `run_in_background`. |
| 3 | HIGH | The allow-list line `bash tools/mac/check.sh` from `~/Projects/worship-rig` only works if that working tree has `v2-native` checked out. The push agent only fast-forwards `v2-native`; nothing says the tree is on it (1.x work happens in the same clone). On any other branch the RUN fails with "No such file". | Allow-list line reads the script read-only from the branch: `bash -c "$(git -C ~/Projects/worship-rig show v2-native:tools/mac/check.sh)" check.sh --repo ~/Projects/worship-rig [flags]`; `usage()` copes with `$0` not being a file. MAC_CHECK.md and the REPICKUP pointer updated. (Speculation flagged: the Mac clone's checked-out branch is unknown here.) |
| 4 | MEDIUM | Generic iOS Simulator destination builds every arch in `ARCHS` (arm64 + x86_64); the xcframework's simulator slice is arm64 only, so the x86_64 half cannot link. Same risk for `platform=macOS` picking x86_64. Unverified on a Mac: from Xcode behaviour as I know it. | `ARCHS=arm64` passed to both Apple builds (compile check only; the arm64-only slices are build-core.sh's choice). |
| 5 | MEDIUM | Xcode 15+ ships the iOS platform separately: `-showsdks` can list `iphonesimulator` while the build fails with "iOS N is not installed. To use with Xcode, first download and install the platform": a FAIL for a missing install. An unaccepted license made `tools` say "Xcode not found". | That exact message -> `apple-sim` SKIPPED with the download note; `xcodebuild -version` output is parsed (license -> "Xcode license not accepted: sudo xcodebuild -license accept"). |
| 6 | LOW | `--rev -x` reached `git rev-parse` as an option; `git archive`'s stderr bypassed `export.log`; the cache pruning counted `local/` among the three kept revisions. | usage error for a `-` rev; `{ git archive | tar; } 2> export.log`; prune only `^[0-9a-f]{7}$`. |
| 7 | LOW | CI `brew install` auto-updates Homebrew first (1-3 min per run). | `HOMEBREW_NO_AUTO_UPDATE`, `HOMEBREW_NO_INSTALL_CLEANUP` on that step. |

## Checked and fine

- Never touches the repo: only `rev-parse`, `cat-file -e`, `archive`, `show` (read-only); builds, `native/apple/build`,
  the generated project and DerivedData (`-derivedDataPath`) all live under `~/Library/Caches/worship-rig-check/<sha7>`.
- No sudo, no install, no system setting: `DEVELOPER_DIR` is exported for the process only. miniaudio's Core Audio
  backend changes the device's nominal sample rate only when `coreaudio.allowNominalSampleRateChange` is set
  (miniaudio.h ~34460); the dev host never sets it. It does set `kAudioDevicePropertyBufferFrameSize`, which Core
  Audio treats per client process (ends with the process). Output: `muted_` set in the constructor, before the device
  starts; `renderInterleaved` zeroes the whole buffer after rendering. `probe_apple.cpp` only calls Get functions.
- BSD/GNU portability: no `sed -i`, `timeout`, `stat`, `date -d`, `readlink -f`, `mapfile` or associative arrays;
  `sed -E`, `getconf _NPROCESSORS_ONLN`, `du -sk`, `pgrep -P`, BSD awk `split` with a regex and `tr` octal ranges
  are all in macOS base. Bash 3.2 itself was not available here (same gap as the builder).
- JSON: probe numbers that are not finite become `null`; strings go through `json_str` (escapes, control bytes).

## Open (not fixed here)

| # | owner | item |
|---|---|---|
| O1 | core | Builder gap 1 (realtime sampler silent without a preload) is consistent with the code: `api/engine.cpp`'s control loop pumps only the recorder (`pumpRec`), never the cache service. Not re-measured here. |
| O2 | core / CI | Builder gap 2 confirmed (46/49 + 3 NoData on a clean export). CI's `build-test` will go red on them until the tests skip without `decode-dump/data/raw*`. |
| O3 | apple | If the first `apple-*` run fails on signing ("requires a development team"), add `CODE_SIGNING_ALLOWED=NO` to the macOS build too; `project.yml` uses `CODE_SIGN_STYLE: Automatic` with an empty team, which macOS normally accepts with identity `-`. |
| O4 | orchestrator | Two `check.sh` runs at once on the same revision share one build tree (no lock). The push agent handles inbox files one at a time, so this only matters if a RUN is sent while one is still running. |
| O5 | orchestrator | Ryan adds the new allow-list line (MAC_CHECK.md) to PROTOCOL.md, not the builder's `bash tools/mac/check.sh` line. |
