# CORE1: cache pump and restart while asleep (skeptic review, 2026-11-22)

Verdict: **VERIFIED.** All three items are done: mackit O1, W3A R1 and T00c O4. Each has a test, and the O1 and R1
tests fail when the fix is reverted (I checked this with scratch-linked binaries). Every builder claim I re-ran holds.
I made two changes, both to the test file the task owns. The first fixes a timing race in the test's sleep helper
that TSan exposed. The second adds a test case for the no-host restart wake, which nothing covered before. CORE1 moves
no fixture. All 112 renders are byte-identical to the wave-3 `build-w2` renders and to clang-20.
No frozen file changed.

## What I re-ran

I used my own dirs, `native/core/build-core1sk[-clang20|-asan|-tsan]` and `native/devhost/build-core1sk`, at `-j2` or
less. Another builder was running Playwright, run-all and ASan renders on the same box, at load 6 to 10.

| config | build | ctest |
|---|---|---|
| g++ 13 Release | 0 warnings | Run 1 (`-j1`, load 7): 79/80. `rt.realtime` hit 4 xruns (limit 3). Run 2 (`-j2`, final test file, load 10): 78/80. `rt.realtime` hit 7 xruns and `unit.voice-limit-cpu` came in 0.2 % over its budget. Every failure was a timing check, and each one passed when re-run alone (see open item 3). |
| clang++-20 Release (`-Werror` from `cmake/RigWarnings.cmake`) | 0 warnings | **80/80** |
| g++ ASan+UBSan (`-fno-sanitize-recover=all`) | 0 warnings | **80/80**, no sanitizer report. `rt.realtime` alone reports 61 xruns as a MESSAGE. |
| g++ TSan, CI regex (29 tests, `rig_tests` target) | 0 warnings | 28/29, **0 ThreadSanitizer reports**. `unit.runtime_cache` failed on a race in the test, not the engine (fixed below). After the fix it passed 3/3 alone. |
| devhost g++ | 0 warnings | **5/5** (`probe.null` included) |

- `node --test test/unit/engine-bridge/*.test.mjs` with `RIG_DEVHOST` set to my devhost gives **120 pass, 0 fail, 0
  skip**. The builder's 2 skips were the devhost-gated tests.
- `node test/run-all.mjs --fast`: I did not start one, because another session's run held the fixed ports. Its
  summary (`test/logs/summary.txt`, 07:20) shows 10/12. One failure is the known eq L-21. The other is an `engine`
  failure, and the same suite's re-run log at 07:31 shows 98/99 with 0 failures and 1 soft warning (`offline.eqCpu`,
  box load). CORE1 changed no file in `app/` or `test/`.

### Fixtures

- `rig_render` of all 112 fixtures with g++ and with clang-20 gives the same bytes for all 112 (`cmp`). Both are also
  byte-identical to `build-w2/golden-out`, the wave-3 baseline.
- `tools/golden/parity.mjs <g++> --twin <clang-20>` exits 0 and reports 112/112 at the manifest tier, 110 at the exact
  tier, and no unexpected failures.
- This is expected. The cache pump runs only in the realtime control loop, which offline engines never start
  (`Engine::create`), and the restart wake is limited to realtime paths.

## The claims, checked

**mackit O1 (cache pump).**
- `controlLoop` now calls `pumpCache()` every turn. The turn is woken by the decode workers, or otherwise runs every
  4 ms.
- `unit.runtime_cache` case 1 (16 slots of ep-rhodes, cold, 8 notes) gives 128 voices on g++ and loads in 1.2 s.
  The audio thread made 0 allocations.
- With a scratch build that drops the pump and `setWake` (`engine.cpp` recompiled, `rig_tests` relinked; the tree was
  not touched), the samples are still not loaded after 60 s and `REQUIRE(loaded)` fails. So the test is meaningful.
- `rig-probe` with the null backend, ep-rhodes, `--notes 0,8 --no-preload`: samples loaded 5.3 s after the commit
  (under load), **121 voices**, `errors` empty.
- The same probe *with* the preload also gives **121**. This confirms the builder's reading. Slot 3 takes the Bass
  role defaults, so the 121 comes from the probe's song, not from the cold path. The BUILD_PLAN acceptance line
  ("128 voices") assumes every slot is full range; the unit test sets that up and gets 128.

**W3A R1 (restart while asleep).**
- `hostAudioStarted` wakes the engine only when the bridge requested the reopen (`pending_`). The no-host branch of
  `requestAudio` wakes it as well.
- A scratch build without both wakes fails case 3, and also my new no-host case. Steps 1 and 2 stay asleep, and time
  stands still.
- A host-initiated reopen keeps the sleep state, and the next note wakes the engine. That matches a suspended
  AudioContext.

**T00c O4 (`rt.realtime` under ASan).** The test now prints a MESSAGE instead of asserting under ASan or TSan. It
detects the sanitizer through the g++ `__SANITIZE_*__` macros or clang's `__has_feature`. Release and RelWithDebInfo
still assert `xruns <= 3`, and that check stays meaningful: my g++ Release run did trip it under load (see below). The
ASan xrun counts are real noise: 61 alone at load 8, and 74 in the builder's run.

**Probe hook.** `--no-preload`, the `"preload"` report key and `waitSamples` behave as described. `waitSamples` checks
`"loaded":[true]` against one patch that holds every slot, so it waits for all 16. A timeout is recorded as an error
and the sweep still runs.

## Real-time and threading reading

- **Audio thread:** untouched. The pumped results reach it as `SamplerOp::Zones` commands, the same path `cache
  preload` already used. Case 1 shows the audio thread allocating nothing.
- **Decode workers:** they call only the wake lambda. That lambda takes `WakeLink::mu` and then
  `wakeControl()`, which does an atomic exchange and a semaphore release. No other lock is held, so it cannot
  deadlock with `~Engine`, which takes `mu` first.
- **Teardown:** the lambda owns a `shared_ptr` to the link, so the link outlives the Engine. The decode workers die
  with `model_`, after `wake_`.
- **Cost:** `pump()` costs one mailbox lock, the graveyard scan and an `ops_` erase on each turn. That is negligible.
- **Re-entrancy:** none. The synchronous `CacheServiceImpl::preload` loop pumps inside `processMessage`. `pumpCache`
  runs only at the top level of the loop, never from a cache callback.
- **Ordering:** `setWake` is called in the Engine constructor, before `setPaths` and before any request. Workers read
  `cfg_.wake` without a lock, which is safe only because it is set once before any job exists. The header requires
  exactly that.
- **Untested:** the wake itself. Remove it and the 4 ms poll still pumps, so no test fails; only the latency changes.
  This is harmless, but no test shows that the wake path works.
- **The teardown case (case 2) cannot prove the WakeLink is needed.** A semaphore destroyed inside a live `Engine`
  allocation is not poisoned by ASan (use-after-dtor is an MSan-only check). The builder's reworded comment already
  says the case is only a guard. The link is still correct, and it costs almost nothing.

## Fixes made (task-owned test file `tests/test_runtime_cache.cpp`)

- **Flake in `sleepNow`, found under TSan.** The helper read `t0` as soon as `awake()` turned false, then checked that
  engine time stood still. A render that had read `awake_` before the flip could still finish one more quantum.
  - TSan showed this twice in the restart case: `0.056 == 0.0533` and `0.1307 == 0.128`. Each gap is exactly 128
    frames.
  - The helper now waits for two more completed audio blocks before it reads `t0`.
  - The engine behaves correctly here. The sleep takes effect on the next quantum, as the contract allows.
  - After the fix the case passed 3/3 on each of g++, clang-20, ASan and TSan.
- New test case: *"W3A R1: with no host (the caller renders), audio restart / output
  while asleep wakes the engine too"*.
  - The `requestAudio` no-host wake (`if (realtime()) model_.wake(0.0)`) had no test. It is now covered for both
    `restart` and `output`.
  - It fails when that wake is reverted.
  - It passes on g++, clang-20, ASan and TSan.
- **(note) Cold load times under TSan were 42 to 92 s.** The sanitized timeout is 180 s, so the margin is about 2x on
  this box when it is loaded.

## Open items

1. **(low, T08 / ENGINE_CONTRACT) The restart wake sends an event that JS does not.** On a restart while asleep the
   native engine emits a `state` event with `sleep:"awake", wakeMs, queued:0` before the `running` one.
   - JS `restart()` emits no `sleep` event; it calls `_resetState()` and the sleep state silently becomes `awake`.
   - Through `bridge-engine.js` that event becomes `sleep {state:'awake'}`. The controller then runs `onEngineSleep`:
     it calls `emitActivity('wake')` and moves `lastInputAt` to now. So the next auto-sleep comes `audioSleepSec`
     after the restart, where JS would sleep again sooner.
   - The UX effect is arguably better. The builder's point that the wake also counts in `audioWakes` (JS resets its
     counters) is the same divergence.
   - The ENGINE_CONTRACT sleep line should record both.
2. **(carry, T06/T12) Nothing calls `setEpochSource` on the realtime cache**, so an evicted buffer is freed as soon as
   its refs reach 0.
   - From reading the code, this is safe today. The only release sites are `~SamplerZones` and the cancelled-load
     paths, and they run on the control thread.
   - A replaced table reaches the control thread only after the audio thread has applied the new table and handed the
     old one back (`deferGarbage`, then `giveBack` in `process`). The new table holds the same buffers.
   - So no buffer that a voice reads can hit 0 refs. This is not verified by a test. It is unchanged by CORE1, which
     only makes the existing finish/evict paths run in realtime without a preload.
3. **(info, pre-existing) The Release `rt.realtime` limit (`xruns <= 3`) still flakes on this box under load.**
   - g++: 4 xruns at load 7 here. clang-20: 10 xruns in the builder's run. Both pass alone.
   - I checked whether the pump makes this worse. `rt.realtime` uses only a test sine, so `pump()` has nothing to do
     there.
   - I ran 22 alternating runs each, at load 5 to 8, of the current binary and the scratch binary with no pump. They
     failed equally often: the current binary 4 of 12 in the last batch, the no-pump binary 6 of 12.
   - Combined counts (more than 3 xruns): 11 of 38 runs with the pump and 9 of 33 without. That is box noise, not
     CORE1.
   - My second full g++ run at load 10 failed `rt.realtime` (7 xruns) and `unit.voice-limit-cpu` (1871 us against a
     1867 us budget). Both passed when re-run alone.
   - O4 scoped only ASan, and Release should keep asserting. If CI sees it, `RUN_SERIAL` on `rt.realtime` would be
     the next step (orchestrator: CMakeLists is frozen).
4. **(docs, orchestrator)**
   - Close mackit O1, W3A R1 and T00c O4 in BUILD_PLAN "UI wave: how to start", REPICKUP and MAC_CHECK.
   - The probe acceptance figure for the default role layout is **121** voices (128 with every slot full range).
   - The builder's suggested `probe.null.cold` devhost ctest is worth adding. It belongs to T09, who owns that CMake.
