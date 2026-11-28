# lane-core3f (builder): core3 CI flake + CAP

Brief: (1) CI run on f46bac4 (macos-15) failed `unit.core3` at test_core3.cpp:353 `CHECK(busy <= 1)` ("switch back
to B"). Find the root cause (test timing, lane/worker-count assumption, or a real prebuild race), reproduce it
deterministically, fix it (test or core), golden fixtures byte-identical; prove 1000x loops on g++ and clang++-20,
ASan clean, worker counts 1..4. (2) CAP (UI6-cship O1): saving a chart, adding a Song bank song and pack top-up warn
past 2,000,000 chars and go through; refuse (write nothing, restore-cap notice) only past 2,500,000. Shell unit tests.
Gates: native g++ / clang++-20 -Werror / ASan ctest + fixtures; JS via gates.mjs shell-unit,unit,chart,migration-1x,
ui-v6-bank,settings. Don't push.

## Checklist
- [x] worktree from origin/v2-native (cae9f84), node_modules linked
- [x] T1: read CI log, read test + build_worker (.probe/ci/*.log)
- [x] T1: root cause + deterministic repro (hook testSwitchSlotWaitMs; unfixed 0/10 adopted 5/5)
- [x] T1: fix (BuildWorker::PrebuildHold in SongGraph::prepare + onRateChanged) 34c9bec
- [x] T1: loops (supersede + core3f cases per run; logs .probe/loop-*/summary.txt): g++ 1000 (839 + 161 after the
      restart), clang-20 1000, RIG_TEST_DECODE_THREADS 1..4 x25, taskset 1 CPU x40 (g++, clang), ASan x20, TSan x2:
      0 prebuild-count failures (busy <= 1 and hits + busy == 10 in every run), 0 sanitizer reports. Timing-bound
      failures (tick gaps / reply latency, load avg 3-19 from another agent + my own jobs) in about half the runs
- [x] T3 (added by coordinator): runtime_preload :314 flake (CI 45940152991, `301.5 < 156.083`): root cause = macOS
      runner stalls, not the engine (same job: an idle loop, nothing loading, 242.8 ms gap; macOS idle samples are
      40-60 ms otherwise; locally idle or under 3 busy loops the window never exceeds 60 ms and no iteration runs
      >= 10 ms). Fix 1f14219: Engine records long control-loop iterations; checkLive fails on a held loop, reports a
      gap with no long iteration as box, cap 1 s. SIGSTOP 350 ms repro: old 3/3 FAIL, new 3/3 pass; hold mutation
      (300 ms in processMessage) new 2/2 FAIL
- [x] T3 loops + native gates re-run after T3 (see the report)
- [x] T1: native gates: fixtures 112/112 byte-identical to base (g++ and clang-20); ctest clang-20 -Werror 84/84;
      g++ 83/84 and ASan 83/84 (unit.core3 tick-gap bounds only, load avg 4-6 from another agent; 0 sanitizer
      reports); A/B with a temp no-hold toggle under the same load: hold 3/8 clean, no-hold 1/8 (same gap lines)
- [x] docs: CONTRACT_CHANGES "## core3f" + "## CAP", INTERFACE_LOG, docs/patch-packs.md
- [x] T2: refusal sites: store.js chartOverflows (setChart + validate), addPackSong, topUpPacks fits()
- [x] T2: fix + shell unit tests (be247be)
- [x] T2: JS gates (tree 036a06d): shell-unit 418/419 = pre-existing bank-trial "skeptic F1–F3" (fails on base
      cae9f84 too; fixed on lane-fu2 e872443, stale keep-alive) -> 419/419 with that test hunk applied (not committed);
      unit 689/0/12; chart 47/47 (first 2 runs: v6 contrast .v6-ts-n under load avg 19, passed with my loops paused);
      migration-1x 115/0 (first run: D11 import 20 s timeout under load); ui-v6-bank 23/23; settings 118/118
- [x] final report here

## Next step
Done: handed back. Orchestrator: launch the skeptic; at merge, CONTRACT_CHANGES.md conflicts with v2-native c7bccec
(both append sections at the end: keep both); drop LANE.md.

## Final report (lane tip: the commit that adds this report, on top of 4e08e10)

### T1: core3 CI flake (`test_core3.cpp:353 CHECK(busy <= 1)`, macos-15)
- **Evidence.** 2 failed runs in .probe/ci (45885049507 on f46bac4; 45963347960), both "8 adopted, 2 in the
  prebuild lane's hands". The coordinator's newer hits (c10ad59, d35b788) are on commits without this fix.
- **Root cause: a real race in the core (minor: a duplicate build, no corruption).** `SongGraph::startFresh`
  promoted a song's prebuilt jobs one slot at a time. Lane 1 (one utility-priority thread, FIFO) could finish its
  job between two slots and pop the song's next queued one, which the next slot then found busy and built again.
  That gave 2 duplicates on the 3-core runner, and up to all of them with a slow control thread. It is not a worker
  count: BuildWorker always has 2 threads (one per lane) whatever `hardware_concurrency`; only the sample decode
  pool scales (1 here, 2 on macos-15), and the case has no sampler.
- **Fix (34c9bec).** `BuildWorker::PrebuildHold` (hold / release, nests): lane 1 starts nothing new while held.
  `SongGraph::prepare` and `onRateChanged` hold it over their slot loop, so at most the one job lane 1 had at the
  start is duplicated. Test hook `testSwitchSlotWaitMs`, plus a new case "core3f: a switch takes its prebuilt units
  in one step": unfixed core 0 adopted / 10 busy (5/5, deterministic), fixed 9 / 1. INTERFACE_LOG CORE3-16.
- **Loops** (the supersede case with :353 + the new case per run): g++ 1000, clang-20 1000,
  RIG_TEST_DECODE_THREADS 1/2/3/4 x25, taskset 1 CPU x40 (g++ and clang-20), ASan x20, TSan x2. In every run: busy
  <= 1, hits + busy == 10, 0 sanitizer reports.
  - **Not "1000 clean passes".** About half of those runs failed core3's tick-gap / reply-latency bounds. That was
    load (avg 3-19 from another agent plus my builds), and it showed up on the unfixed core as well. Under the same
    load, an A/B with a temporary no-hold toggle gave: hold 3/8 clean, no-hold 1/8 clean, the same lines.
  - 2 loop failures are artifacts of my SIGSTOP pause: g++ 311 and clang 194 had their 60 s reply waits expire
    while paused.
  - On the idle box afterwards: ctest g++, clang-20 and ASan all 84/84, unit.core3 included.
- **Worker counts.** 1..4 was covered as decode-pool size. Real 3-4 core runs are not possible on this 2-CPU box.

### T3 (coordinator): runtime_preload :314 flake (`301.5 < 156.083`, run 45940152991)
- **Root cause: macOS runner stalls, not the engine.** In the same job the next case's idle loop (nothing loading)
  showed 242.8 ms; macOS idle samples are otherwise 40-60 ms. Locally, idle or under 3 busy loops, the window never
  passed 60 ms and no control-loop iteration reached 10 ms. Even idle, 2 of 300 local windows had 116 / 143 ms gaps
  with no long iteration, which the old check fails.
- **Fix (1f14219).** Engine records control-loop iterations >= 10 ms (wake to flush; `longIterations()`, stats
  `loopIterMaxMs`, additive). runtime_preload `checkLive` replaces its 7 tick-gap checks:
  - it fails when an iteration overlapping the window reaches the bound (a held loop, lock waits included);
  - a gap with no long iteration is reported as the box and fails only past 1 s (3 s sanitized).

  INTERFACE_LOG CORE3-17, CONTRACT_CHANGES "core3f T3".
- **Proof.**
  - A 350 ms SIGSTOP in the window: old test 3/3 FAIL (362-382 ms), new 3/3 pass.
  - Mutation (300 ms sleep in the loop at that `prepare`; not committed): new test 2/2 FAIL.
  - Loops: the case 300x g++ idle (2 box gaps); 100x clang-20 at load ~10 (11 box gaps, up to 692 ms); the suite
    30x g++. All pass. ASan 8/8, TSan 8/8, 0 warnings.

### T2: CAP (UI6-cship O1)
- `store.restoreCapRefusal` is the one rule, used by:
  - `addSong` and `duplicateSong`;
  - `setChart` (was refused past 2 MB);
  - `addPackSong` (was refused past 2 MB);
  - `topUpPacks` (was skipped past 2 MB).
- Past 2,000,000 the add goes through and the save warns (`library-size`). Past 2,500,000 it writes nothing and
  sends a `library-full` notice.
- `setChart` / `addPackSong` return the notice text as the error. `addPackSong` also returns `notified: true`, so
  Settings, the v6 bank sheet and the trial banner skip their own toast (no "×2").
- `topUpPacks` sends one notice per call and keeps its skip lines.
- A merge import still refuses past 2 MB (D9 grants 1.25x to replace / restore only).
- Tests: 4 new / rewritten shell tests (`chart-store`, `patch-packs`), all fail on the old store.

### Gates
- **Native** (after T3, idle box):
  - ctest g++ 13 84/84; clang++-20 `-Werror` 84/84 (0 warnings); g++ ASan+UBSan 84/84 (0 reports);
  - TSan: core3 and runtime_preload, 0 warnings;
  - fixtures: all 112 `rig_render` outputs byte-identical to the base cae9f84 build, g++ and clang-20 (re-checked
    after T3); `app/js/engine` unchanged.
- **JS** (gates.mjs, tree 036a06d; T3 touched only native files):
  - unit 689/0/12; chart 47/47; migration-1x 115/0; ui-v6-bank 23/23; settings 118/118.
  - shell-unit 418/419. The 1 is bank-trial "skeptic F1–F3", which fails on base too; FU2 has since fixed it on
    v2-native. With FU2's keep-alive test hunk applied it is 419/419 (not committed).
  - First runs of chart (contrast) and migration-1x (D11 timeout) failed under load avg 19 and passed on rerun.

### Risks / not verified
- PrebuildHold: lane 1 idles for the length of a switch's slot loop (ms); a rate change holds it the same way.
- T3: iteration time is wall time, so on a loaded box a preempted iteration counts as held (max 158 ms seen at
  load ~10, under the adaptive bound). core3's own tick-gap bounds stay load-sensitive (CORE3 O2). Using `checkLive`
  there is a possible follow-up, not done here.
- **Not verified:** on CI or the Mac (nothing pushed); real 3-4 core worker counts; the CAP UI paths in a browser,
  except through the bank / settings / chart suites.
- Build dirs: native/core/build/{gcc,clang20,asan,tsan}. Probes, logs and loop summaries: `.probe/` (git-ignored).
