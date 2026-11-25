# CORE3 (synth / organ units built off the control thread, neighbour prebuilds; CORE2A O2): skeptic review, 2026-11-24

Verdict: **VERIFIED** (three defects found and fixed here, none in the switch path itself; one review case added, the
cap case extended). A switch to a synth / organ song no longer holds the control loop; `prepare` is answered once the
song is built; the newest switch wins, an older prepare still answers, a commit takes effect at once; nothing new runs
on the audio thread; neighbours are prebuilt within a cap that holds against measured RSS. Every builder mutation
(M1-M3) fails the tests. No fixture moved: all 112 renders are byte-identical to `b9a0c27`, including
`auto-filter-cutoff`. The builder's open item 1 ("`auto-filter-cutoff` depends on binary layout") is **not a layout
bug**: it is an empty instrument catalogue, built when `native/contract` is missing at configure (O3). The tick-gap
test bound reworked in the finish pass was still flaky on a loaded box (O2), and the cap evicted the wrong song first
(O1).

Tree: `v2-native` at `650df77` plus this review's edits (`HEAD` moved to `db15e0e` meanwhile: the chart view, nothing
under `native/core`, `native/contract`, `native/devhost` or `app/js/engine`). Own build dirs (fresh, real directories,
`-j2`, one heavy job at a time; the box was shared with another agent, load average 2-6 for most of the session):
`native/core/build-sk` (g++ 13 Release), `build-sk-clang20` (clang++-20 Release, `-Werror`), `build-sk-asan` (g++
RelWithDebInfo, `RIG_SANITIZE=address;undefined`, `-fno-sanitize-recover=all`), `build-sk-tsan` (g++ RelWithDebInfo,
`RIG_SANITIZE=thread`), `native/devhost/build-sk` (g++ Release). The `b9a0c27` base: `git archive b9a0c27 native/core
native/contract` into a scratch tree (app/ and native/golden symlinked: unchanged since `b9a0c27`), g++ Release
`rig_render`. A copy of the tree for the mutations. Playwright: `PLAYWRIGHT_BROWSERS_PATH=/root/.cache/rig-pw`. All
deleted after this report.

## Gate, measured here

| check | result |
|---|---|
| ctest g++ 13 Release | **84/84** (`-j2`), 0 warnings. With this review's edits, at load ~4: 82/84, `rt.realtime` and `unit.runtime_preload` (timing) pass alone; `unit.core3` passes |
| ctest clang++-20 Release `-Werror` | **84/84** (`-j2`), 0 warnings |
| ctest g++ ASan+UBSan | **84/84**, no sanitizer report. `-j2` at load ~6: 81/84, the three failures timing bounds only (`unit.runtime` "active >= 45" 38, `unit.runtime_preload` gaps 306-504 ms vs 250, `unit.core3` gaps 320-580 ms vs 250); all three pass alone |
| ctest g++ TSan, CI regex + `cache\|samples_\|sampler\|core2b\|core3\|synth\|organ` (44 suites) | **44/44**, **0 TSan warnings**. `-j2` at load ~4: 42/44, `unit.runtime_preload` (352 / 367 ms vs 250) and `unit.core3` (327 ms vs 250, the C/D window) timing only; both pass alone |
| `unit.core3` (this review's version, 9 cases) | idle 5/5; under two `yes` loops 3/3; alone under ASan and TSan 1/1 each |
| fixtures (`rig_render`, all 112) | **112/112 byte-identical to `b9a0c27`** (g++); g++ = clang-20 112/112; `parity.mjs --twin <clang-20>` **exit 0**, 112/112 manifest tier, 110 exact, "unexpected failures: none" |
| devhost ctest | 5/5 |
| `node --test test/unit/engine-bridge/*.test.mjs`, `RIG_DEVHOST` = this review's devhost | **131 / 0 / 0** |
| ui-core on `rig-devhost --no-adapter` (raw) | **76, 75 / 77**: only the three known suite read races (CORE2A O1: polish-2A banners; v11-metronome, v11-decisions, which pass alone, 2/2); no bridge error reply, the two known warns, `sanitizer: (none)`. **Tick gaps max 130 / 177 ms**, over 150 ms 0 / 4, none over 400; the 177 ms one is a `cache estimate` (O6), not a build. Longest synth / organ-only `prepare` reply **129 / 144 ms**; the longest replies (1.7-1.9 s) are all sampler songs waiting for decodes |
| `app/js/engine/**`, `native/golden/**` | unchanged |

## Mutations (the builder's M1-M3, re-created here on a copy of the tree, with this review's test file)

| mutation | result |
|---|---|
| M1: `startFresh` never used (every unit built inline in `prepare`), `prebuild` a no-op | **8 of 9 cases fail** (the offline case passes, as it should). Idle: `play` mid-switch held **2256 ms**, switch gap **2299 ms** (bound 50), prebuilt neighbour 1816 ms. Under two `yes` loops: idle-loop gap 170 ms, bound 255 ms, switch gap **4723 ms**: 18x the bound |
| M2: one utility-priority lane, switch jobs ahead of prebuilds in it, a running prebuild waited for | **fails** "prebuild in flight": unrelated 4-organ switch **5364 ms** (reference 293), the very neighbour **5865 ms**, `prebuildBusy` 0, hits 10 |
| M3: the superseded replies flushed only by a `prepare` with an id | **fails** "a newer prepare without an id": the older prepare is never answered (`REQUIRE` at :456) |

The finish pass's bound (`max(50, 1.3 x` the idle loop's largest gap over 1 s`)`) is meaningful (M1 fails by 18x on a
loaded box) but **not robust** (O2).

## Items

- **Off-thread builds, newest wins, older prepare answers, commit at once: correct, tested.** `startFresh` posts a
  private-copy `BuildJob` (factory, `UnitEnv`, the slot's patch, `SongState`); the factories of `inst.synth`
  (synth.js, synth-extra through the T15 hook) and `inst.organ` read only `env.sampleRate`, `env.seed` and the slot
  (checked: `makeSynth`, `makeSynthExtraUnit`, `makeOrgan`); `ensureModulesRegistered` on a worker is a `call_once`
  already done by `rig_create`. `whenBuilt` / `pumpBuilds` send the reply; `takeBuilt` claims unstarted jobs by
  compare-exchange and waits for running ones (lane 0 only, see below), so a commit is never late by more than one
  unit build. A superseded plan's `onBuilt` is cleared and the bridge flushes its replies (also without an id now).
- **Two lanes, `promote()`: correct.** All queue state and `runLane` are under `mu_`. `promote` is true for done,
  queued-in-lane-1 (moved to lane 0), queued-in-lane-0 or running-in-lane-0, false only when lane 1 popped it. A job
  in the prebuilt set is never `unwanted` (eviction erases it from the set as it marks it; `discard` keeps only wanted
  ones), so "popped by lane 1 and skipped" cannot be adopted. A plan therefore never waits on a lane-1 thread.
  - **The duplicate build when `promote` fails: no leak, no double free.** Both copies are `shared_ptr`s; the lane-1
    copy goes back into the set (charged against the cap), the switch's copy is a new job; `take()` moves the `Unit`
    out exactly once and `~BuildJob` frees a never-taken one, on whichever thread drops the last reference (worker or
    control), never attached, so the audio thread never saw it. The copy left behind costs cap space until evicted.
- **Bank build outside the mutex ("keep the larger"): correct.** Lookup and insert are under the mutex; the second
  finisher returns the first's bank when it covers its families, so equal requests share one instance; tables depend
  only on (rate, families) and `PeriodicWave::create` has no shared state (checked). Nit O4.
- **Eviction while a switch is pending; memory pressure; rate change: correct.** A pending plan's jobs are never in
  the prebuilt set, so eviction and `dropPrebuilt` (memory pressure, rate change) cannot touch them. A rate change
  marks the plan's jobs unwanted and re-posts them at the new rate; the reply waits for the new ones. There was no
  test of that path: added (review case, below).
- **Teardown: correct.** `~Engine` clears the `WakeLink` first; `~Model` resets the `SongGraph` while every member it
  reads exists; `~SongGraph` discards the plan while the worker lives (`worker_` is declared last, so it is joined
  first among the members); the worker drops queued jobs and finishes the running one (the test hook's wait is
  interruptible). A `prepare` callback capturing `&e` is never run after teardown (cleared with the plan).
- **`testPrebuildDelayMs`: no behaviour in release** (0 by default, read only by lane 1 after a claim: one relaxed
  load per prebuild job). It is compiled into every build; acceptable.
- **The id-less supersede flush: correct, tested** (M3). Replies carry the old token, which can no longer commit.
- **Memory cap: holds.** Measured here, RSS per prebuilt unit with warm banks (g++ Release, 48 kHz, one kind per
  process): organ **5.81 MB** (charged 6), synth.js warm-pad **2.14 MB**, synth-extra dx-epiano / supersaw-pad
  **2.59 / 2.58 MB** (charged 2.7). The charge is an upper bound, so 64 / 32 MB of charges is at most that much RSS.
- **Builder claims checked.** 16-organ switch: `play` 0.09-1.2 ms, gap 37-47 ms idle, reply after 1.2-1.45 s;
  prebuilt neighbour 3.4-4.7 ms; superseded reply 0.9-6.3 ms; prebuild in flight 0.28-0.38 s / 0.71-0.94 s (10
  organs); cap 10 / 5 units kept, 60 / 30 MB. All reproduced. "2 passes under load": 1 of 2 failed here (O2).

## Findings

- **O1 (fixed, T13): the cap evicted the most wanted song first.** `prebuild` stamped LRU in request order, so the
  first-named song was the least recently used. controller.js `pinWindow` sends `windowCandidates` order: current,
  next, prev, next2, prev2 ("the order the byte budget fills in"). Over the cap (likely on the iPad: 32 MB is 5
  organs), the Next song's units went before prev2's. The builder's cap test asked for `[A, B]`, kept B, and did not
  check which. Fix: after posting, the request's units are re-stamped in reverse request order
  (`graph_build.cpp`). Test: the cap case now checks that naming A again posts only what the cap left out (desktop
  0, iPad 5; the old code posts 10 in both), and an LRU-across-requests check (X, Y, X again, Z over the cap: Y loses
  1-2 units, X stays whole). INTERFACE_LOG CORE3-13.
- **O2 (fixed, test): the switch tick-gap bound was still flaky under load.** `1.3 x` the idle loop's largest gap over
  1 s failed 1 of 2 runs under two `yes` loops (switch gap 72.88 ms, bound 72.81): the switch window is ~4 s there,
  the idle sample 1 s, and the switch lane is one more runnable thread at default priority. Now: 50 ms when the idle
  loop's own gap (over 2 s) is <= 40 ms (an idle box: one 30 Hz tick plus jitter, 37 ms here), else `1.5 x` it.
  After: 5/5 idle (gaps 37-43 ms, bound 50), 3/3 under two `yes` loops (52-56 ms vs bounds 66-72); M1 still fails
  by 18x loaded. On an idle box the switch gap reached **47 ms** in 3 of 5 runs of the builder's version (37 ms idle
  loop): 3 ms under the 50 ms spec bound. The extra ~10 ms is the control thread's own work at `prepare` (16 strips
  built inline, the patch parse) plus the switch lane competing on 2 CPUs. Within spec, but a quiet CI runner that is
  a little slower would trip it: noted for T13. Test change: INTERFACE_LOG CORE3-14.
- **O3 (fixed, T11 hook): "`auto-filter-cutoff` depends on binary layout" is an empty instrument catalogue.**
  Reproduced first, then explained:
  - this review's first `b9a0c27` build (`git archive b9a0c27 native/core`) rendered it wrong: max|diff| 0.575, from
    frame 88320 (2.0027 s: the first quantum after the `cutoff` set at 2.0 s), the builder's exact symptom;
  - not memory: valgrind memcheck on that binary, 0 errors, and the render under valgrind is the same wrong one;
  - not addresses: the same render with ASLR off (`setarch -R`), and with the core's 108 objects linked in forward
    and in reverse order; swapping in HEAD's `synth_dsp.o`, `synth_extra_dsp.o` or `synth_dispatch.o` changed nothing;
  - gdb: `SynthInstrument::setParam` is never called in the wrong build (3 calls in the right one);
    `setInstrumentParam` runs, but `findCatalogue("synth", "warm-pad")` returns null, so the param is stored and never
    sent (`index < 0`);
  - cause: `src/inst/catalogue.cmake` embeds `native/contract/engine-api.json`; the export had no `native/contract`,
    so configure printed a WARNING and embedded `[]`. With `native/contract` added, the same `b9a0c27` source renders
    all 112 byte-identical to HEAD, `auto-filter-cutoff` included; an `fprintf` added to an unexecuted function in
    `synth_extra_dsp.cpp` (the builder's flip) renders it right too.

  So nothing is layout-dependent, and no fixture or build is wrong in the repo. The risk is real all the same: a
  core configured without `native/contract` drops every `set slots.<i>.params.*`, and with `RIG_BUILD_TESTS=OFF`
  (`native/apple/scripts/build-core.sh`) nothing says so (`unit.synth-catalogue` and this fixture do, in a test
  build). Fix: a missing `engine-api.json` or one without `instruments.list` now stops configure (`FATAL_ERROR`;
  checked: configure fails without it, passes with it). INTERFACE_LOG CORE3-15. Not tried, as the cause was found:
  `-O0/-O1/-O2`, MSan, `-ftrivial-auto-var-init=pattern` (clang-20 Release renders all 112 byte-identical to g++).
- **O4 (nit, T11 / T15): two same-rate banks can coexist.** When two threads miss with different families, both
  results stay in `g_banks` (neither covers the other), and the "two most recent rates" trim then counts them as two
  rates and can drop the other rate's bank. Cache only: a later `get` rebuilds the union. Leave.
- **O5 (nit, T13): the build key leaves out the engine seed.** A `config {seed}` change after a prebuild adopts units
  seeded with the old one. Realtime only; prebuilt units already use a different rng stream name than an inline build
  (CORE3-3). Leave.
- **O6 (T06 / CORE2A, not CORE3): the first `cache estimate` of a sampler patch holds the control loop.** The only
  tick gap over 150 ms next to a switch in the ui-core runs (177 ms, run 2) started at a `prepare` of glass-pad +
  synth that was answered in 0.5 ms (prebuilt); the loop was then busy 148 ms answering a `cache estimate` of a
  salamander-piano patch (of 742 estimates the next longest is 42 ms). Not measured further here.

## What this review changed

- `native/core/src/model/graph_build.cpp`: O1 (LRU re-stamp in reverse request order).
- `native/core/tests/test_core3.cpp`: O2 (bound), O1 (cap case: which song is kept; LRU across requests), new case
  "a rate change while a switch is building" (reply still sent, units rebuilt at 44.1 kHz, prebuilt set dropped,
  new song sounds). M1 fails the new case, as expected.
- `native/core/src/inst/catalogue.cmake`: O3 (`FATAL_ERROR`).
- `INTERFACE_LOG.md` CORE3-13..15, `CONTRACT_CHANGES.md` "## CORE3" (review paragraph), `PARITY.md` (UI parity row).

## Open items

- **O2 follow-up (T13):** the idle-box switch gap (47 ms of 50) leaves little margin; if CI trips it, build the 16
  strips of a 16-slot switch off the control thread too, or measure where the 10 ms goes.
- **O6 (T06 / CORE2A):** the cold `cache estimate` (148 ms on the control thread).
- **Builder open item 2 (CORE2A / T06): sample decode workers at utility priority**, unchanged; sampler prepares
  stretch on a busy box (ui-core: the long replies are all sampler songs, see above).
- **Builder open item 3 (T15): a drawbar change rebuilds 8 PeriodicWaves (~60 ms) on the control thread.** Not
  measured here.
- **Orchestrator:** add `synth|organ` to the CI TSan regex (the bank merge runs there); this review ran them (0
  warnings).
- **Orchestrator / T11:** the CORE3 builder report's open item 1 is closed by O3; the BUILD_PLAN / MAC_CHECK wording
  ("a Mac or iPad build could ship this") should say "a core configured without `native/contract`", now a configure
  error.
