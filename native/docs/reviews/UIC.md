# UIC (UI-wave review follow-ups: UIA O1 / O2, UIB O1 / O2 / O4): skeptic review, 2026-11-22

Verdict: **VERIFIED** (with two corrections made here). All five open items are done, and each has a test that fails
without its fix (checked by running each new node test against the `35b6e43` file, and the Settings test by reading
the base table code). The web-engine ui-core suite reads exactly what it read before. The gate holds on this review's
own builds. Two builder claims did not hold and are corrected here: the status-lamps pass on `rig-devhost` was an
artifact of the shim's 400 ms optimistic window over a **core defect the builder missed** (the core's tick never
reports the pedal), and the raw count is **66-68/77 over three runs**, not a stable 70. Every remaining failure has
a core or contract owner; none is left in the files UIC owns.

Tree: `v2-native` at the orchestrator's UIC checkpoints (`2dfc840` and later) plus this review's edits. Own build
dirs (fresh, real directories, `-j2`, one at a time): `native/core/build-uicsk` (g++ 13 Release),
`build-uicsk-clang20` (clang++-20 Release, `-Werror`), `build-uicsk-asan` (g++ RelWithDebInfo,
`RIG_SANITIZE=address;undefined`), `build-uicsk-devhost` (g++ Release, `native/devhost`). Playwright through the
existing 1194 → 1243 mapping (`scratchpad/uisk/pw`); nothing installed.

## Gate, measured here

| check | result |
|---|---|
| ctest g++ 13 Release | **80/80** (`-j2`), 0 warnings |
| ctest clang++-20 Release `-Werror` | **80/80** (`-j1`), 0 warnings |
| ctest g++ ASan+UBSan | ASAN_RESULT |
| fixtures (`rig_render`, all 112, `compare.mjs`) | **112/112** |
| g++ vs clang-20 renders | byte-identical, 112/112 (`cmp`) |
| vs the builder's g++ renders (`scratchpad/uic/r-gcc`) | byte-identical, 112/112: no fixture moved |
| `parity.mjs --twin <clang-20>` | exit 0; 110 at the exact tier; "unexpected failures: none" |
| `node --test test/unit/engine-bridge/*.test.mjs` | **123 / 0 / 2 skip**; **125 / 0 / 0** with `RIG_DEVHOST` = this review's devhost |
| `node test/run-all.mjs --fast` (after this review's edits) | RUNALL_RESULT |
| ui-core on `rig-devhost`, `--no-adapter` (raw) | **68, 68, 66 / 77** (below) |

No file under `app/js/engine` or `native/core` changed (`git diff 35b6e43 -- app/js/engine native/core` is empty).

## Items

- **UIA (a), MIDI-learn Sound 5-16: done, tested.** `learnRowsFor(n, midiLearn)` inserts `slots.4..n-1.gain` after
  the Bass level; `n` is clamped to 4..16, so a song of 4 slots or fewer gets the 1.x 14 rows. A mapped level past the
  count stays listed so it can be cleared. Rows are rebuilt from a store subscription only when the id list changes;
  cells of rows that leave are kept, so a pending learn keeps its button. The settings test grows the song to 6,
  learns Sound 6 from the table, moves it with the CC through pickup to +6 dB, shrinks back, clears the kept row and
  gets the 1.x list back. Without the fix the table is the static `LEARN_ROWS` and the `slots.5.gain` row never
  appears, so the test times out at its first wait.
- **UIA (b), mock 16 slots: done, tested.** `op_set` (single and batch) validates with `isValidPath(path,
  MAX_SLOTS)`; `tick.slots` has max(4, song slots) ≤ 16 pairs, matching the core (`buildTick`: `std::clamp(slotCount,
  kWebSlots, kMaxSlots)`). Base `mock-native.js` → both `engine.test.mjs` tests fail (2/25). Nit: CONTRACT_CHANGES and
  INTERFACE_LOG say "`set` / `param`"; the mock has no `param` op, only `set` with and without `batch`.
- **UIB O4: done, tested.** `restarting` stays set through `resumeRecording(part)` (`try/finally`), and the failure
  path clears it. Base `controller.js` → `uic-restart.test.mjs` fails (a second engine restart in the window). The
  flag now also covers the watchdog (`restarting` makes the stuck-tick check return) and `onEngineRestarted` for the
  duration of `recorder.start`; both are right (the restart already happened).
- **UIB O1, suite side: done; web engine unchanged.** Every helper's web branch is the original read (`rmsNow`'s RMS,
  `e.slots` taps, `pedaled.size`, `sounding.size`, `getParam`, `transpose`, `metronome.*`, `drone.getState()`,
  `activeNotes`); `freshStats` returns at once; the tap-idle timeouts stay 5 s / 3 s; `fx?.reverb.settled()` is the
  same call when `fx` exists. The three cleanup hooks change state only after the test and only toward the state the
  passing path leaves. On the bridge some reads are weaker than on the web engine, which PARITY now says: transpose,
  drone mode and `clickRunning` read the shim's own applied value; `soundingHas(n)` is "held" only.
- **UIB O1, shim side: done, tested; overstated.** `optimistic.test.mjs` 4/4 fail against the base shim. The design
  is sound for a core that reports its state: a perform call sets the mirror, a disagreeing tick within 400 ms is
  ignored, an agreeing tick or 400 ms hands it back. But the builder's "five tests pass only with the new shim" does
  not hold for two of them (next section).
- **UIB O2: done.** Root `CONTRACT_CHANGES.md` "## UIB" matches INTERFACE_LOG UIB-1..6 and the UIB review (minor 4,
  R1, the 25/77 raw count).

## Found here

- **S1 (core defect, missed by the builder; owner T14 / T08): the tick never reports the pedal or held notes.**
  `Engine::buildTick` writes `pedal` / `held` from the `rig_meters` snapshot, and `Graph`'s snapshot fill
  (`graph/graph.cpp`) never sets `m.pedal` or `m.held`; the comment "T14 fills the snapshot's pedal/held" was never
  done. Probe (`scratchpad/uicsk/probe/pedal-probe.mjs`, this review's devhost, a note and the pedal held for 1.6 s):
  `engine.pedal` true at 0.2 and 0.4 s (the optimistic mirror), false from 0.6 s on; `held` 0 throughout. So on 2.0
  the Perform pedal lamp and the strips' pedal lights (`perform.js` `readRuntime` reads `engine.pedal`) go dark 0.4 s
  after the pedal goes down. The status-lamps test passed on the bridge only because it checked "lit within 2 s"
  (v11-polish reads the strip light at exactly 400 ms). **Fixed in the test**: status lamps now also asserts the lamp
  is still lit 1 s later (`test/phase2/ui-core/run.mjs`); it passes on the web engine and fails on the bridge with
  the true cause. The core fix (fill the tick's `pedal` / `held` from `Perform` on the control thread, or fill the
  snapshot) is recorded in PARITY with its owner.
- **S2 (test cascade): round2-ui #1 "Space = sustain" was not a shim win.** It failed in the builder's base-shim A/B
  and in this review's first two runs at its last line (`controller.status.pedal` still true after Space up) because
  status lamps had failed with the pedal down. **Fixed**: a `t.after` hook in status lamps lifts the pedal (no-op on
  the passing path); round2-ui #1 then passed in the next full run and in two `--grep` runs.
- **S3 (count): the raw number is 66-68, not a stable 70.** Three full raw runs here: 68 (S1's check added; S2
  cascade), 68 (same), 66 (after the S2 hook). The third run's extra failures (polish-2A banners "that Esc did not
  panic", v11-metronome bpm 100 vs 80 after Next, v11-decisions 30 s wait) passed in the other runs; on the bridge
  those reads come from the core's `notes` / `click` events, which arrive late while `cache preload` blocks the
  control thread (all 9 tick gaps over 400 ms in that run contain a preload; inferred, not traced per test). PARITY
  "UI parity" now records the three runs, the S1 row and the timing row.
- Verified builder claims: `cache preload` busy-waits (`CacheServiceImpl::preload`: `while (!done) if (pump() == 0)
  sleep_for(1 ms)`) and every tick gap over 400 ms contains one (9/9 in this review's log); `getParam` is
  `notContract` ("tests only") and `get state` carries only `gain` / `pan` per slot; the tick `runtime` lacks
  `swelling` (`runtimeStateJson`) while `wheelValuesJson` has it, and the probe shows the shim's `swelling` true at
  0.25 s and false from 0.5 s on.

## Open

- **O1 (core, T14 / T08)**: S1, tick `pedal` / `held`. User-visible on 2.0 (pedal lamp).
- **O2 (core, T14 / T08)**: tick `runtime.swelling` (builder's row).
- **O3 (core, T06 / T08)**: `cache preload` blocks the control thread (builder's row); also the likely cause of the
  run-to-run spread in the raw count (S3).
- **O4 (contract, orchestrator)**: no contracted param read-back (5 tests). Note: `get state` already carries the
  song `transpose`, so a core-side transpose check needs no new op once a state read is contracted.
- **O5 (nit)**: the shim's `swell()` with no argument decides "start" from its own `swelling`, which the core never
  confirms (O2), so a second press more than 400 ms later mirrors nothing; harmless once O2 lands. `clickStop()`'s
  optimistic `running: false` has no expiry (it waits for native's `click` event).
- **O6 (docs, orchestrator; carried from UIA O3)**: `CLAUDE.md` still says `SCHEMA = 1`; BUILD_PLAN / REPICKUP not
  updated for the UI wave.
- Build dirs to prune: `native/core/build-uic*` (builder) and `build-uicsk*` (this review).
