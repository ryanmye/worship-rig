# UIB (UI wave items 4-7: Settings and bridge): skeptic review

Verdict: **PARTIAL**. Items 4, 5 and 6 are done, tested and the tests bite. Item 7 is done as a measurement (the
devhost count is recorded in PARITY "UI parity" with owners) but the raw count did not move (25/77 against 25/76),
no shim-side failure was fixed in the shim (the 25 → 63 is a test-only adapter that stands in for Web Audio
internals), and `hello.minor` is 4, not the 3 the task names (justified, see below). One small defect in the item-6
fix was found and fixed here (R1). The gate holds on this review's own builds.

Build dirs (fresh, `-j2` or less, real directories): `native/core/build-uibsk` (g++ 13 Release),
`build-uibsk-clang20` (clang++-20 Release, `-Werror` from `cmake/RigWarnings.cmake`), `build-uibsk-asan` (g++
RelWithDebInfo, `RIG_SANITIZE=address;undefined`), `build-uibsk-devhost` (g++ Release, `native/devhost`). Tree:
`7ce6737` + the other builder's in-progress `native/core` work (CORE1) + this review's edits. Playwright on the
sibling skeptic's 1194 → 1243 mapping in the session scratchpad (`uisk/pw`); nothing installed.

## Measured

| check | result |
|---|---|
| fixtures, g++ | **112/112** (`compare.mjs`), 110 at the exact tier |
| fixtures, clang-20 | 112 renders **byte-identical** to g++ (md5 of all 112) |
| vs earlier renders | byte-identical (0/112 differ) to the wave-3-era g++ set `r-gcc2` (2026-11-22 01:23) and to `par-gcc` / `par-clang20` (04:07 / 04:19); no fixture moved |
| `parity.mjs` (twin = this review's clang-20 renders) | exit 0, "unexpected failures: none" |
| ctest g++ Release | 78/80 in the `-j1` run under load 7-9 (two other builders): `rt.realtime` (xruns 13 > 3) and `unit.runtime` (idle ticks 9 < 12). Alone: `unit.runtime` passes; `rt.realtime` failed once more alone (18 > 3) and then passed. A/B against the builder's own `build-uib/rig_tests -ts=realtime` back to back: both failed once and both passed once, so load, not this change (neither file is touched by UIB) |
| ctest clang++-20 `-Werror` | **80/80**, 0 warnings |
| ctest ASan+UBSan | **80/80** in one `-j1` run (incl. `rt.realtime` and `unit.runtime`), no sanitizer report, 0 build warnings |
| `unit.bridge_dynrange` | 3/3; ep-rhodes vel 40: range 1 −37.89 dB, range 3 −58.77 dB sent before the song and to the live sampler (−20.88 dB), back to 1 = −37.89 dB |
| `engine-api.json --check` | up to date (before and after this review's comment edits) |
| `node --test test/unit/engine-bridge/*.test.mjs` | **118 pass / 0 fail / 2 skip** |
| `run-all --fast` (sibling skeptic's run on `7ce6737`, same UIB code) | 11/12: unit 519 · **engine 98/99 + 1 soft warning, PASS** (`offline.eqCpu` is a soft warn this time: "absolute numbers outside ±30 % (box load?)") · instruments 143 · synth-extra 153 · shell 264 · ui-core 90 · edit-v2 109 · settings 84/84 · **eq 27/28** (the known `L-21`) · mini 14 · themes 58 · chrome-fallback 17 |
| after R1 (this review's controller edit) | `run-all --fast --only unit,shell,ui-core,settings,edit-v2,chrome-fallback`: **6/6** (519 · 264 · 90 · 109 · **84/84** · 17); `--only mini,themes,eq`: 14/14 · 58/58 · eq 27/28 (`L-21` only) |

The builder's open gate item "engine 98/99, `offline.eqCpu` failed" does not reproduce as a failure: the suite
passes with eqCpu as a soft warning (its ratios `eq2` 1.04, `eq5` 1.11 vs plain biquads are in range; only the
absolute ms are outside the DECISION band under load). UIB does not touch `app/js/engine`
(`git diff 47aa596 -- app/js/engine` is empty).

## Items

**Item 4 (Freeze drone to save CPU)**: done. Row in Sound › Advanced with deep link `drone-freeze` (+ aliases);
store: optional boolean, non-boolean dropped on load / refused on set, `null` resets, device-local (not exported).
Controller sends `setDroneFreeze` through `optional()` (web engine: no setter, nothing sent; the row's note says "With
the 2.0 engine"); at start-up only when stored `false` (absent = the core's default). Tests: app mode (web engine:
no setter, note visible, refuses `'no'`, not exported), bridge mode (nothing at boot, two toggles → two `config`
messages, note hidden), reboot with Freeze off → `config {droneFreeze:false}` at start. Screenshots look right at
1440×900 and 820×1180.

**Item 5 (`config {dynamicRange}`)**: done. Contract row (ENGINE_CONTRACT §1.1 + bridge table + `hello` minor list),
spec + regenerated JSON, schema `Number`, `opConfig` → `Model::setDynamicRange` (existing, clamps and rounds to
0.01, non-finite → 1), `get state` already carried `dynamicRange` (`song.cpp` `stateJson`). Shim `setDynamicRange`
uses `validDynRange ?? 1` like the web engine; the web engine's own method is unchanged. Real-time safety: the new
code runs on the bridge (control) thread only; it reuses `SongGraph::setDynamicRange`, which posts
`SamplerOp::DynamicRange` through the existing command queue (`sendUnitOp`), and `instrumentSetup` for samplers
attached later. No new audio-thread code.

**Item 6 (Settings review items 1-4)**: done as written; each has a test that fails without it:
- item 1: reverted the `restartAgain` lines in a scratch copy → the new `sound2.mjs` test fails (timeout waiting for
  the second restart); with them it passes.
- item 2: setters in `methods` (`nativeOnly`), allow-list gone, `surface.test.mjs` counts 68.
- item 3: `mock-native` `bufferFrames` in replies and `state`; node test + the granted-size line test (now a hard
  assertion, was a soft note).
- item 4: Settings reads `status.audioConfig.sampleRate`; the 44.1 kHz state-event test (5.8 ms, not 5.3) would fail
  on an `engine.ctx` read.

**Item 7 (devhost re-run, `hello.minor`)**: see "Item 7" below.

## Fixed in this review

- **R1 (low, introduced by item 6)**: a restart asked for while one runs now sets `restartAgain` but still returned
  `false` at once. Settings' "Restart audio" button toasts `ok ? 'Audio restarted' : 'Audio restart failed'`, so
  pressing it during a restart (for example right after a buffer pick) said "failed" for a restart that was in fact
  queued and then ran. Also the follow-up ran with the *first* caller's `opts` (a watchdog `{auto: true}` restart
  followed by a user pick toasted "Sound was restarted automatically"). `controller.js` `restartAudio`: a queued
  request returns a promise that resolves with the follow-up run's result (`false` when the running restart failed,
  never left pending), and the follow-up uses the latest request's `opts`. Test: the item-1 test in `sound2.mjs`
  calls `controller.restartAudio()` during the slow restart and asserts it resolves `true`; it fails on the builder's
  version ("a restart asked for during a restart resolves true once the follow-up ran") and passes now (bridge mode
  9/9, full settings 84/84). Logged in INTERFACE_LOG UIB-5. `controller.js` is UIA's file; the edit stays inside the
  UIB-5 lines.
- Doc nits in owned files: `engine-api.spec.mjs` METHODS JSDoc now defines `nativeOnly` (the JSON is unchanged,
  `--check` passes); `native/contract/README.md` lists the four newer `config` fields.

## Item 7

- **`hello.minor` 4, not 3**: accepted. The task's "3" was written when the core answered 3; this task's own item 5
  adds an additive bridge field, and the contract README rule ("additive: bump `minor`, add a capability") makes it
  4. Mock and core agree, and `sound-settings.test.mjs` reads `bridge.cpp` and fails if they diverge (caps list and
  minor). The deviation is the right call; the orchestrator should read item 7 as "match the core".
- **The count**: the honest UI-parity number is the raw one, **25/77**, unchanged from 25/76; the task expected "most
  should now pass". The builder's diagnosis holds (39 of 52 failures stop at one `waitSong` line that reads
  `engine.slots`, a Web Audio internal), and PARITY records both numbers. But 63/77 is a number about the suite plus
  a stand-in, not about the shim: the adapter answers `fx.reverb.settled()` with `true` always, reports the core's
  one voice total on the first filled slot, and `getParam` echoes the last value the UI sent. A test that passes
  through those reads proves the UI sent the right call, not that the core did the right thing. PARITY should keep
  quoting the raw count as the parity number.
- **"fix shim-side failures you can"**: none was fixed in `bridge-engine.js` itself. The listed shim-side rows (pedal
  / runtime answered from the 30 Hz tick and the 1 s stats; meters and wheel echo while silent) are owned by "T09",
  but the shim is this task's file. Not a regression: the UI's own pedal lamp reads controller status (set on input),
  not the engine, so the lag is in what the *tests* read. Left open (O1).
- Devhost re-run here (fresh `build-uibsk-devhost`, g++ Release, 0 warnings): **25/77** `--no-adapter`, **66/77**
  with the adapter; no bridge error reply, no sanitizer line. The 11 adapter-run failures are the builder's list
  minus `boots`, the Quick sheet geometry and `performance #2`, which passed this time (layout / timing, as the
  builder said). Recorded in PARITY "UI parity".

## Open items

- **O1** (item 7 follow-up, owner: whoever takes the shim next, T09 lineage): the suite-side fix the builder names
  (ui-core `waitSong` / sound check use contracted members when `engine.ctx` is not a `BaseAudioContext`) is the
  real fix for 39 of the failures and belongs in `test/phase2/ui-core` (UIA's suite in this wave); the shim-side
  rows (optimistic pedal mirror, silent meters) are not done.
- **O2**: `CONTRACT_CHANGES.md` (root) has no UIB section; `native/contract/README.md` asks for one for every
  additive contract change (minor 4). INTERFACE_LOG UIB-1..6 has the content. Orchestrator.
- (checked, not open) `unit.bridge_dynrange` "live" case really takes the live path: `SongGraph::commit` attaches the
  sampler on the control thread (`song.cpp` `attachBuilt`), so a `config` after `use()` finds it in
  `attachedKind` and posts `SamplerOp::DynamicRange`, while "before" goes through `instrumentSetup`.
- **O4** (pre-existing, not UIB): `restartAudio` clears `restarting` before `await resumeRecording(part)`, so a
  request in that window starts a second restart instead of queueing. Harmless today (no overlap in `call`), noted.
- Themes `coverage-*.json` (builder's hand-off): closed. The suite rewrites their `generated` timestamps on every run
  (the only changed lines); after this review's themes run they match `HEAD` and `47aa596` (`git diff` empty), so
  nothing is left to revert. Settings review item 5 (make the suite stop rewriting them) stays a nit.
- Build dirs to prune: `native/core/build-uib*` (builder) and `build-uibsk*` (this review).
