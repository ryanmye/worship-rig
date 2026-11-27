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
- [ ] T1: loops: g++ 1000x running (.probe/loop-gcc1000/summary.txt); clang-20 1000x; ASan; taskset 1/2 CPUs;
      RIG_TEST_DECODE_THREADS 1..4
- [ ] T1: native gates (ctest g++, clang-20 -Werror, ASan; fixtures byte-identical vs .probe/fx-base)
- [x] docs: CONTRACT_CHANGES "## core3f" + "## CAP", INTERFACE_LOG, docs/patch-packs.md
- [x] T2: refusal sites: store.js chartOverflows (setChart + validate), addPackSong, topUpPacks fits()
- [x] T2: fix + shell unit tests (be247be)
- [x] T2: JS gates (tree 036a06d): shell-unit 418/419 = pre-existing bank-trial "skeptic F1–F3" (fails on base
      cae9f84 too; fixed on lane-fu2 e872443, stale keep-alive) -> 419/419 with that test hunk applied (not committed);
      unit 689/0/12; chart 47/47 (first 2 runs: v6 contrast .v6-ts-n under load avg 19, passed with my loops paused);
      migration-1x 115/0 (first run: D11 import 20 s timeout under load); ui-v6-bank 23/23; settings 118/118
- [ ] final report here

## Next step
Loops are SIGSTOPped (pkill -CONT to resume) while native gates run: fixtures, ctest g++ / clang20 / asan. Then resume
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
