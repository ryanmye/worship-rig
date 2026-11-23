# CORE3 builder report: finish pass (2026-11-23, new cloud session)

The orchestrator saved this from the builder's hand-back. It has **not been reviewed**, so every claim below is the
builder's own. The skeptic review goes to `CORE3.md`. Context: `CORE3-handoff.md`.

## macOS CI failure (run 45098812476, `test_core3.cpp:344`, `145.813 < 80`): the test bound, not the engine

- **What the check timed.** It timed the superseded prepare C from `t3`, which is taken before the test thread's
  `sleep_for(30)` and the post of D. C's reply is sent by D's `prepare`, so it cannot arrive before D is posted.
- **Why the control loop was not held.** Two facts in the same Mac log:
  - the tick-gap check over the C/D window (`maxGap < 100`, :350) passed;
  - when D was answered, 9 of C's 10 units were already built. D's jobs jump the queue ahead of C's on a one-lane
    worker, so that only happens if D was posted late.
- **Fix.** C is now timed from D's post. D is posted after a stats round trip confirms C is prepared. Without that
  wait, TSan put C's own parsing (130-250 ms) inside the bound.
- **Local flakes (3 of 6 in the old session).** These reproduce under load on the 2-CPU box. An idle loop alone shows
  48-65 ms tick gaps there, so the fixed 50 ms bound failed at 52-65 ms. The bound is now the larger of 50 ms and
  1.3 × the largest gap the idle loop shows over one second.
- **The tests still fail on pre-CORE3 code.** M1 builds everything inline with no prebuild. Under M1:
  - the superseded reply took 705 ms;
  - `play` mid-switch was held 1111 ms;
  - the largest switch gap was 1141 ms;
  - the prebuilt neighbour took 745 ms.

  6 of the 7 cases failed.

## Defects fixed

1. **A switch waited behind a prebuild, and its builds starved on a busy box.**
   - Cause: one worker at utility priority ran both switches and prebuilds.
   - Before: a 16-organ switch next to two busy threads took 13-14 s (1.1 s idle).
   - Fix: `BuildWorker` has two lanes. Lane 0 runs switches at default priority; lane 1 runs prebuilds at utility
     priority.
     - `promote()` moves a queued prebuild into lane 0.
     - If lane 1 is building that very job, the switch does not wait: it builds its own copy, and the other copy stays
       prebuilt (stat `prebuildBusy`).
     - The queued jobs of a superseded switch drop to lane 1.
   - After: 2.1-2.3 s under the same load.
   - Test: the hook `BuildWorker::testPrebuildDelayMs` (tests only) holds lane-1 jobs for 5 s. With it:
     - an unrelated switch is answered in 0.29-0.50 s (M2, a one-lane worker: 5243 ms);
     - a switch to the neighbour that is being prebuilt is answered in 0.61-0.69 s (M2: 5614 ms).
2. **The wavetable bank mutex was held during a cold build (80-300 ms).**
   - `WaveBank::get` and `XWaveBank::get` now build outside the mutex.
   - If two threads miss at the same time, both build and the larger table is kept.
   - There is no deterministic test. The TSan runs of the synth, organ and core3 suites cover it.
3. **A superseding `prepare` without an `id` left the older prepare unanswered** (a regression from CORE3's
   `waits=2`). The bridge now flushes the waiting replies whatever the id. New test; M3 fails it.

New cap / LRU test:
- Two 10-organ neighbours are requested (120 MB).
- The desktop keeps 10 units (60 MB) and evicts 10; the iPad keeps 5 (30 MB) and evicts 15.
- A song asked for again moves to the front of the LRU order.
- Evicted queued jobs are skipped.
- `rig_host_memory_pressure` empties the set.

## Was a `prepare` held behind a neighbour prebuild in ui-core?

Not in the builder's two runs. The longest prepare replies (0.5-2.3 s) were songs with sampler slots waiting for
their decodes (CORE2A). The longest reply for a song with synth/organ slots only was 126 / 118 ms. The 5.4 s in the old
`ui2` run matches the sampler pattern, but its log is gone, so this is **inferred, not verified**.

## Gate (builder's own dirs, deleted)

| check | result |
|---|---|
| ctest g++ 13 Release | 84/84, 0 warnings |
| ctest clang++-20 Release -Werror | 84/84 |
| ctest g++ ASan+UBSan | 84/84, no report |
| TSan (CI regex + cache, samples_, sampler, core2b, synth, organ, registry-link) | 45/45, 0 warnings |
| fixtures | 112/112 compare; `parity.mjs --twin` exit 0 (110 exact); g++ = clang-20 byte-identical |
| vs the b9a0c27 build | 111/112 byte-identical (open item 1) |
| engine-bridge `node --test` | 131/0/0 |
| devhost ctest | 5/5 |
| ui-core devhost `--no-adapter` | 77/77 and 77/77; largest tick gap 136 / 127 ms, none over 150 (CORE2 integration: 283-329 ms) |

`unit.core3`: 8 cases. They passed 4 runs in a row idle, 2 under load, and once each under TSan, ASan and clang.

## Open items

1. **High, pre-existing: `auto-filter-cutoff` depends on binary layout.** Owners: orchestrator / T11 / T14.
   - A b9a0c27 build renders it deterministically wrong: max|diff| 0.575 from 2.003 s on.
   - The builder's tree renders it right.
   - Adding one `fprintf` to an unexecuted function in `synth_extra_dsp.cpp` flips the builder's build to the wrong
     output.
   - Valgrind reports nothing, and ASan builds render it right.
   - Suspected cause: pointer- or address-order dependence (unverified).
   - Risk: a Mac or iPad build could ship this.
2. **CORE2A / T06:** the sample decode workers are utility priority too. Sampler prepares (0.5-2.3 s) will stretch on a
   busy device.
3. **T15:** a drawbar change rebuilds 8 PeriodicWaves (~60 ms) on the control thread. Pre-existing; not measured.
4. **Orchestrator:** add `synth|organ` to the CI TSan regex.
5. **Skeptic:** review:
   - the two-lane design;
   - the duplicate build when `promote` fails;
   - the bank merge;
   - the test hook;
   - mutations M1-M3.

Files changed:
- `native/core/src/model/build_worker.{h,cpp}`, `graph_build.cpp`, `song.{h,cpp}`
- `native/core/src/inst/synth_dsp.cpp` (T11), `native/core/src/inst/synth_extra_dsp.cpp` (T15)
- `native/core/src/bridge/bridge.cpp`
- `native/core/tests/test_core3.cpp`
- `CONTRACT_CHANGES.md`, `INTERFACE_LOG.md` (CORE3-9..12), `PARITY.md`
