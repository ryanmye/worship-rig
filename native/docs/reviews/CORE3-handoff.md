# CORE3: state at handoff (orchestrator, 2026-11-23 02:45Z)

The old Cowork session stopped the CORE3 workflow during its **builder** step, so a new cloud session can take
over. Nothing has been reviewed. The builder never wrote a report. The facts below come from its logs, copied to
`tools/cloud/orchestration/core3/`.

**The task.** It is in `tools/cloud/orchestration/core3.js`, `BUILD`. In short:
- build synth and organ instruments off the control thread;
- answer `prepare` only once the build is done, with the newest switch winning;
- pre-build the setlist neighbours that the controller already preloads, under a memory cap;
- write tests that fail without the fix.

**Code.** The builder's edits are committed in the work-in-progress checkpoints up to `42e656f` (`CORE3: checkpoint`).
`git diff b9a0c27 -- native/core app` shows them, together with MACFIX's (see `reviews/MACFIX.md` for which files
are MACFIX's).

**Measured: before and after** (`base_rt.txt` and `fix_rt.txt`, from the builder's harness `measure_rt.cpp`, cold
process). The key column is how long a `play` sent during a switch waited:

| song | before: play held (ms) | after: play held (ms) | synth/organ build (ms) |
|---|---|---|---|
| organ-swell | 279.1 | 6.3 | about 300 |
| sub-shimmer | 304.4 | 0.4 | about 270 |
| building-swell | 149.0 | 1.6 | about 233 |
| anthem | 91.9 | 1.4 | about 75 |
| 80s-ballad (dx-epiano) | (not in the base table) | 0.5 | 194 |
| test:heavy16b, 16 synth/organ slots | n/a | 12.3 | 367 |

After the fix, the largest tick gap in the harness is 33-41 ms. The `prepare` replies still take as long as the
build, which is by design: the old song plays until then.

**Unfinished or failing when stopped:**
- **`unit.core3` (the builder's new suite) failed in 3 of the 6 ctest logs** (`ctest-gcc`, `ctest-gcc2`,
  `ctest-clang`); the later runs passed. It is unknown whether that is a race in the test or in the code: find out
  first.
- **ui-core `--no-adapter`, 4 runs** (`uiruns.txt`):
  - ui2 was 77/77, but with gaps of 658 and 436 ms. One `prepare` reply took up to 5.4 s. Look at whether a
    `prepare` waits behind a neighbour pre-build.
  - ui3 was 74/77: the three known suite timing races (CORE2A O1), with a largest gap of 235 ms.
  - The other runs are in the file.
- No skeptic review was done. The builder had not written its report, and was writing its CONTRACT_CHANGES section
  when it was stopped.

**Next, in the new session:**
1. Finish CORE3 with a builder: fix the `unit.core3` flake, and check that `prepare` is never queued behind a
   neighbour pre-build (the 5.4 s reply and the 658 ms gap).
2. An independent skeptic review, written to `reviews/CORE3.md`.
3. The scoped re-check of CORE3 and MACFIX (`integ4.js`).
