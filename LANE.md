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
- [ ] T1: read CI log, read test + build_worker
- [ ] T1: root cause + deterministic repro
- [ ] T1: fix
- [ ] T1: loops (1000x g++, clang-20), ASan, worker counts 1..4
- [ ] T1: native gates (ctest g++, clang-20 -Werror, ASan; fixtures byte-identical)
- [ ] T2: find refusal sites
- [ ] T2: fix + shell unit tests
- [ ] T2: JS gates
- [ ] final report here

## Next step
T1: read CI log.

## Findings
(none yet)
