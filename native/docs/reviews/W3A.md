# W3A perform follow-ups: skeptic review (2026-11-22)

Verdict: **VERIFIED.** Every task item was done and each has a test that fails on the old behaviour. All builder
claims I could re-check hold. One small defect was in a task-owned file, and I fixed it (`sleepBlockers` before
`audio start`). The other points are notes or open items for other owners. W3A moves no fixture. I proved this by
rendering all 112 fixtures with W3A's audio-relevant hunks reverted: the result is byte-identical to the current tree.

## What I re-ran

I used my own dirs (`native/core/build-w3a-rv[-clang20|-asan|-tsan]`) at `-j2` or less. The W3B skeptic was building
at the same time on the same box.

| config | build | ctest |
|---|---|---|
| g++ 13 Release `build-w3a-rv` | 0 warnings | **78/78** |
| clang++-20 Release `-Werror` `build-w3a-rv-clang20` | 0 warnings | **78/78** |
| g++ ASan+UBSan `build-w3a-rv-asan` | 0 warnings | **78/78** (`-j2`, next to the other builder's compile; `rt.realtime` passed there and 3/3 alone); 0 sanitizer reports |
| g++ TSan `build-w3a-rv-tsan` (sleep, runtime, model, song, t00c, voice-limit, perform, perform_carry, wheels) | see below | see below |

JS: `node test/run-all.mjs --only unit` gives 510 pass / 0 fail / 9 skip. `node --test
test/unit/engine-bridge/*.test.mjs` gives 111 pass / 0 fail / 2 skip.

The ASan `rt.realtime` load flake (T00c O4) did not trip this time. That fits the builder's account, but this run does
not confirm it.

### Fixtures

- `rig_render` of all 112 fixtures on g++: **112/112** at the manifest tier (`compare.mjs`). The exact-tier dry run
  (`promote.mjs`) fails only `bend-modes`, at 6.54e-4 (T14 O3, unchanged).
- g++ and clang++-20 renders are **byte-identical** for all 112 (`cmp`).
- **Tree minus W3A** (the builder skipped this). I copied the tree to scratch and reverted every W3A hunk that can
  reach audio:
  - F1 (both `delay_register.cpp` lines; W3B's call-time `sendOp` kept)
  - the master `out` multiply
  - T13 O2 store, O3 second loop, O4 `sendOff`
  - T07 O7 (`Model::noteOn/Off` straight to `Perform::noteOn/Off`)
  - the `wake()` calls in `setLowResource`, `clickStart` and the drone

  Its renders are **byte-identical to the current tree for all 112**. So `drone-freeze-dry`, `drone-freeze-wet` and
  `fx-row-sweep` were moved by W3B (the runner's drone-freeze path and the delay's call-time ops), not by W3A.
- The 5 promotions are in the manifest as `exact` with `promotedFrom: statistical` and pass the exact tier. They are
  listed in `t14.ids`, and `golden.t14` passes on all three configs.

## Claims checked, item by item

1. **F1 (delay ignores macro.wash).**
   - The two lines and the include are exactly the T14 review's diff, marked and logged (W3A-7).
   - Precondition 1 holds: `SongGraph::commit` sets `routing_ = plan->routing` first. `Perform::delayFeedback()`
     recomputes `washFb` from the current routing and patch, so `onCommit` sees the new song.
   - Precondition 2 holds: `applyAll` is reached only from `onCommit` / `onSet`.
   - The test is meaningful. A washed switch is compared against a plain 0.75 reference. The old code sent 0.3 at the
     commit, and 0.3 against 0.75 over echoes 5-10 is far outside the 1 dB check.
2. **JS ports.** I read all ten against `test/phase1/engine/suites.mjs`. The thresholds match JS where JS measures
   audio (sustainRelease, transposeFFT, tapeBendStream, sceneGlide). Where JS reads Web Audio internals, the native
   test measures the render or the Model state instead. The gaps are named in each case:
   - drone voicing: T16's
   - the cache-variant and dispose-race halves
   - `pedalSwellLevelMoves` runs 2.5 s later, because the JS harness plays the fallback drone preset and native the
     full drone patch

   The report says none of them exposed a T14 defect. I did not re-check that against the pre-T14 tree.
   `intensityMacroAndBrightness` checks the reverb wheel only as the ratio 1.15 / 0.8 between mod 1 and mod 0, not
   the absolute 0.8. Nit.
3. **Sleep / wake.** I compared it line by line with audio.js `sleep`, `wake`, `_sleepHold`, `sleepBlockers`,
   `_rampLead`, `_outGainAt` (1478-1640), and the order matches:
   - noteOn / noteOff: `noteInput` before the hold.
   - sustain: hold before `noteInput`.
   - Replays run at `t` once the state is `awake`.
   - The +5 ms suspend timer and the `seq` cancel behave as in JS.

   On the engine side, `sleepState_` is gone and `awake_` is set only by `sleepChanged`. A `play` while asleep now
   queues, wakes, and reports the real `queued`; the realtime test shows `queued:1`. The `out` param is applied after
   the clip curve, as the contract's master chain line has it (`… clip curve → out(sleep ramp)`, record tap after it).
   Two differences from JS, both benign:
   - **Wake is synchronous**, so the queue never holds more than the one call that caused the wake. A note-off that
     arrives "while waking" plays at its own time, where JS would stack it on the ramp start.
   - **Re-entrancy from the drone's `h_.wake()` is safe.** It reaches `Sleep::wake` only with an empty queue, or with
     the state already `awake`.
4. **Carry-overs.**
   - T00c O2: `Model::commit` → `setSlotCount`. The test commits straight to the Model.
   - T00c O3: comment plus test. The targeted NoteOn reaches `RetireInst<0>`, measured by Goertzel at the retired
     pitch.
   - T13 O2: stored at call time. Clamping is shared with the send through `resolveInstrumentParam`. A commit still
     cancels pending `slots.*` flushes (`co_.cancelAll(isSongKey)`), so the flush cannot write the old song's value
     into the new patch.
   - T13 O3: the second loop in `applyReused`. The `user:` sampler test has a control ("set, no switch" is heard)
     and a check ("reused commit restores 0.2 s").
   - T13 O4: `sendOff` is ungated to `Inst<slot>` while the move frame is ahead. Before the fix the release frame was
     0.5 s; the test asserts 0.3 s.
   - T07 O7: `holders_` bits per pitch. Both orders are tested, and so is the single-path re-strike.
5. **Promotions.** Checked above.

**Real-time safety.** The only audio-thread change is `MasterChain`: one more a-rate `wa::Param` evaluation and an
in-place multiply per quantum, with no allocation and no lock. Everything else runs on the control thread: `Sleep`,
`holders_`, `sendOff`, the `applyReused` JSON loop (allocates, control thread), `storeInstrumentParam`, and the drone
`wake` from `DroneCore::newLayer` / `filesTo`. `Engine::awake_` is the existing atomic.

**INTERFACE-CHANGE list.** W3A-1..11 match the diff. Two small gaps:

- The `model.h` comment lines on `sleep` / `sleepState` / `sleepBlockersJson` carry no tag of their own. W3A-2 logs
  them as comments.
- W3A-9 (`song.{h,cpp}`) is a T13 file, not a frozen one, and is tagged "W3A".

## Fixes made in this review (task-owned files)

- `src/model/sleep.{h,cpp}`: `sleepBlockers()` answered `[]` on a realtime engine before `audio start`. JS answers
  `['no-audio']` when `!this.fx`. Native now answers `["no-audio"]` while no master chain is attached as well. The
  `unit.sleep` realtime case checks it before `audio start`.
- `tests/test_sleep.cpp`: a wrong comment ("the 5 ms wake ramp") in the pedal case. Only a sustain is queued there,
  so the ramp is 60 ms.

I rebuilt and re-ran on all three configs: `unit.sleep` 6/6, full ctest 78/78 (g++, clang-20, ASan), and the 112
renders are unchanged (`cmp` against the renders made before the fix).

## Open items (not fixed here)

| id | sev | owner | item |
|---|---|---|---|
| R1 | low | T08 + T14 | `audio restart` / `output` while asleep: JS builds a new context that starts awake. The native Model stays `asleep`, so the engine renders silence until the next perform call or `wake`. That call now wakes it (before W3A, nothing did). Either `hostAudioStarted` should call `Model::wake(0)`, or the contract should state it. |
| R2 | info | T14 | T13 O4 covers NoteOff only. A `FadeNote`, or a mono `NoteOn` / `LegatoTo`, aimed at a retiring channel and posted between a commit call and its later `when` is still gated to the move frame. Not reachable today: the UI commits with `when` = now, and the runner posts in time order. |
| R3 | info | T07 / T14 | `noteOffFrom` for a source that never held the pitch still calls `noteOff` when no source holds it. controller.js ignores it. This is the single-source behaviour from before (a stray note-off passes through), and it is harmless. |
| R4 | nit | T03 / T14 | `MasterChain` always evaluates `out_` a-rate. A constant-1 fast path would save one evaluation per quantum. That is optional; the cost is negligible next to the compressors. |
| R5 | carry | T12 / T13 | (builder) `user:` samplers have no param definitions, so a key missing from the new song is not reset to its default. |
| R6 | carry | T16 | (builder) the native drone reference has one click-detector hit at 6.78 s with no pedal and no moves. That is drone content. `pedalSwellLevelMoves` counts only clicks that the reference lacks. |
