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
- [ ] T3 loops: g++ case x300 + suite x30 (.probe/loop-t3-*), then clang / ASan / TSan; re-run native gates
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
- [ ] final report here

## Next step
Loops resumed 10:25Z + sweeps.sh (dec1..4, cpu1, asan) + TSan build (nice 19). Wait, tally, report.
(old) Loops are SIGSTOPped (pkill -CONT to resume) while native gates run: fixtures, ctest g++ / clang20 / asan. Then resume
loops (gcc1000 at ~240, clang1000 just started), then taskset 1-CPU + RIG_TEST_DECODE_THREADS 1..4 sweeps, ASan loop.

## Findings
- CI: unit.core3 failed at :353 twice (run 45885049507 on f46bac4, 45963347960 on 2026-11-27 08:10Z), both
  "8 adopted, 2 in the prebuild lane's hands". Other macos failures in that window are other timing suites
  (runtime_preload gaps, voice-limit-cpu budget), not this.
- Root cause (real race, core): SongGraph::startFresh promotes prebuilt jobs one slot at a time; lane 1 (one thread,
  FIFO) can finish its job and pop the song's next queued job between two slots -> a second duplicate build
  (unbounded if the control thread is preempted / inline builds sit between). Not a worker-count assumption: the
  BuildWorker always has 2 threads (one per lane), independent of hardware_concurrency; only the sample decode pool
  scales (cache_service.cpp makeRunner: min(2, hw-1): 1 here, 2 on macos-15), and the organ-only test never uses it.
- CAP: refusal sites were chartOverflows (> 2 MB: setChart + raw set), addPackSong (> 2 MB), topUpPacks fits()
  (> 2 MB). Merge import (importJSON, > 2 MB non-replace) left as is: D9 only grants 1.25x to replace / restore.
