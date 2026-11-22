# W3B organ + drone follow-ups: skeptic review

Verdict: **VERIFIED**. All of the builder's claims reproduce. That covers T15 review items 1-4 (item 5, fadeNote, was
already in place), the T16 follow-ups, the fx-row-sweep root cause and fix, and the four drone promotions. Each
item has a test that fails without its fix. I made no code changes. One new finding (N1, below) is a pre-existing
defect in the same area as item 1. It sits in a T13 file, so it is recorded here rather than fixed.

Build dirs (fresh, `-j2`): `native/core/build-w3b-review` (g++ 13 Release), `build-w3b-review-clang20`
(clang++-20 Release `-Werror`), `build-w3b-review-asan` (g++ RelWithDebInfo, `RIG_SANITIZE=address;undefined`).
Baseline: `ec58466` (the wave-3 commit before W3A / W3B), from `git archive` in the shared scratchpad, folder
`w3bsk-base`, `rig_render` only.

## Measured

| check | result |
|---|---|
| fixtures, manifest tier, g++ | **112/112** (`compare.mjs`) |
| fixtures, manifest tier, clang-20 | **112/112**; all 112 renders byte-identical to g++ |
| vs `ec58466`, byte-identical | 108/112 |
| moved: `drone-freeze-dry` / `-wet` | silence → 2.81e-6 / 3.65e-6; meant to move: runner diff |
| moved: `fx-row-sweep` | 1.22e-1, rms 1.17 dB (FAIL) → **3.20e-5**, bands 0.00, env corr 1.0000, rms 0.00 dB; meant to move: lofi / delay call time |
| moved: `auto-filter-cutoff` | 5.75e-1 (FAIL at `ec58466`) → 4.28e-6 (= the T14 review's number). This is **W3A's** movement, see below |
| ctest g++ / clang-20 | **78/78** / **78/78**, 0 warnings in both builds |
| ctest ASan+UBSan | **77/78**, no sanitizer report, 0 build warnings. `rt.realtime` fails (xruns 9 / 12 > 3, twice more alone); this is the known ASan load flake, with the same failure in the D4 / T00c ASan logs. `unit.clock` failed once under `-j2` next to the other builder's compile (`renders 10 > 10`) and passed alone |
| JS | `node test/run-all.mjs --only unit`: 510 pass / 0 fail / 9 skip; `node --test test/unit/engine-bridge/*.test.mjs`: 111 pass / 0 fail / 2 skip |
| manifest | W3B's promotions are exactly `drone-synth-2keys`, `-stage`, `drone-freeze-dry`, `-wet` → exact (tolerance / tier / prng fields only). The other five promotions in the diff since `ec58466` are W3A's. `fx-row-sweep` stays statistical (tier blocker: Chromium itself repeats at 1.4e-5) |

`auto-filter-cutoff` uses only numeric `slots.0.params.cutoff` / `resonance` rows on a synth `warm-pad`, tapped at
`slot0.pan`. None of the W3B code paths reach it:

- the string branch in `Model::set` applies to strings only;
- the drawbar hook is organ-only;
- the song.cpp lines are organ-only;
- the lofi / delay changes act on fx units that are not in this tap.

So the movement comes from W3A (most likely W3A-2, the store at call time). At `ec58466` it fails against the
unchanged golden (same sha256), so the task's "109/112 now" premise counts W3A's tree.

## Each item

1. **Rotary as a string (HIGH)**: done and tested. `Model::set` → `instEnumIndex`. JS `coerceParam` maps an unlisted
   name to `p.default`, so the builder is right not to drop it, and the review text was wrong.
   - The test fails without the fix: `'off'` would become 0 = slow.
   - Divergence, documented as W3B-4: a string for a numeric row is dropped, where JS would use `Number(s)` and
     fall back to the default when that is NaN. The UI never sends one.
2. **Morph / release reach an organ (HIGH)**: done and tested in all three places (`sendRelease`, `applyFresh`,
   `applyWheels`). `applyWheels` is where the live morph is sent; there is no separate "reuse" morph sender.
   - Morph = rotary `'fast'` to < 1e-6.
   - The live wheel moves the sound by > 1e-2.
   - The run-time release is `== 0` against building with the same release.
3. **Drawbar changes heard (MEDIUM)**: done and tested.
   - A burst gives one rebuild.
   - A held chord after the swap measured **0** against "built with it" in 0.7-1.2 s. The test only asserts
     `< stayed / 20`, so the "byte-identical" claim is true but looser in the test than in the report.
   - Not reachable through a reused channel: reuse requires `paramsMatch`, so different drawbars always build fresh.
4. **Delays follow a rate change (LOW)**: done and tested, organ horn and juno chorus, with no allocation.
   - The rate guard compares against `XHost::sr_`, which `setSampleRate` / `process` update. So a drawbars-only
     payload built after a rate change is accepted.
   - `attachFitting` shrinks max from 10 ms to 9.15 ms at 48 kHz. That is harmless: the horn needs ≤ 1.35 ms and
     the chorus ≤ 5.5 ms.
5. **fadeNote**: confirmed. `XHost::fadeNote` covers organ and synth-extra, tested in `unit.organ` / `unit.synth_extra`.
6. **T16**:
   - Both diffs are applied verbatim against `/mnt/user-data/outputs/v2/t16/*.diff`; the only additions are the
     `INTERFACE-CHANGE(W3B)` marker comments.
   - `rngNameFor` is gone, and the drone fixtures are byte-identical to `ec58466`.
   - `hello.minor` is 3 with `"droneFreeze"`, and `test_t00c` checks it.

## fx-row-sweep root cause: confirmed

- `tools/golden/page.js` calls `applyEvent` for every non-`live` event before `startRendering`.
- `fx.js Lofi.apply` (line 1499) calls `_updateCurves()` (WaveShaper `.curve`) synchronously, and only the ramps
  and `_engage` use `when`.
- `Delay.updateTime` / `_switchTo` decide `ready` and pick `this.active` at call time, and the retry timer reads
  `effectiveTime()` when it fires.

So native now delivers the lofi state and the delay ops immediately, with their time in the payload / `f.e`
(`DelayUnit::apply` uses `max(f.e, lastQuantumTime)`). That is the JS semantics, and live use with `when` = now is
unchanged. No tolerance was touched, and no other fixture moved.

## Real-time safety (changed code)

- Audio thread:
  - the organ drawbars-only swap: per-voice pointer `retable` and a `std::swap` of `unique_ptr` arrays; the old
    tables travel back in the payload;
  - `setRate`: a re-attach and a `memset` of ≤ ~1000 floats;
  - the lofi garbage array grew from 8 to 32.
  - None of these allocate, free or lock. `unit.organ` asserts `rtAllocs == 0`.
- Control thread:
  - `drawbarWaves` (≈ 4.7 MB, ≈ 50 ms);
  - the debounce timer, guarded by a `weak_ptr` alive flag and an `attachedKind` / instType check when it fires.
- Payload give-back: `XHost` returns every owned payload, including an ignored wrong-rate one, through
  `garbage_[8]`. ASan / LSan were clean.

## New finding

**N1, MEDIUM (pre-existing; T13 `src/model/song.cpp`, not W3B's lines): organ `rotary` is invisible to the song
reuse path.**

- The catalogue's enum row has no `min` / `max`, so `min == max == 0`. Both `paramsMatch` and `applyReused` clamp
  `paramOf(...)` into `[0, 0]`, and `paramOf` returns the default for a string.
- Every rotary value therefore compares equal. A song switch between two songs on the same organ preset keeps the
  first song's rotary, and no `InstParam` is sent.
- JS (`audio.js:617`, `_applySlotCfg`) compares `'fast' !== 'off'`, so it rebuilds or sends `setParam`.
- Probe (scratch, not in the tree): commit soft-pad `{"rotary":"fast"}`, then commit soft-pad `{"rotary":"off"}`, then
  play a chord. Against a fresh `'off'` build: max|diff| **0.131** in 0.7-1.5 s, and stats show `channelsReused 1`.
- Since W3B-4 the Model stores the index (`{"rotary":1.0}`) where the JS store keeps `"fast"`. That is harmless
  only while this path ignores rotary.
- Suggested fix (T13 / orchestrator, about 15 lines): an `instParamValue(const SlotPatch &, key, const
  CatalogueParam &)` in song.cpp that, for an enum row (`p.min >= p.max` and `p.key == "rotary"`), resolves:
  - a string through `inst::instEnumIndex(sp, key, s)`;
  - a number by `round`;
  - absent, the preset default (`instEnumIndex(sp, key, "")`).

  Use it in both loops without the clamp. The probe above is the regression test: put it in `unit.song` or
  `unit.organ`, and it must give < 1e-5.

## Other open items (no fixture affected)

- **LOW (W3A / T14 `src/model/wheels.cpp`).** The wash `SetFeedback` is still sent at `frameOf(t)`, while every
  other `DelayOp` is now delivered at call time. With events issued ahead of time, the two can reach the unit out
  of call order. JS calls `setFeedback` at call time. To be consistent, send it with `c.frame = kFrameNow` and keep
  `f.e = t`.
- **LOW.** `LofiUnit` still leaks a state silently past 32 applies per quantum (8 before). That is unreachable: the
  worst fixture has 7, and live calls are coalesced. A counter would make it visible.
- **NOTE.** In a golden-page style render, organ.js's single 30 ms timer reads `_bars()` when it fires, after all
  up-front calls. Native arms per call at `when` from the coalesced handler. The two agree live, and no fixture has
  drawbar rows.
- **NOTE (promotion, T15 / orchestrator).** `promote.mjs` (dry run) shows 18 T15 / T13 statistical fixtures passing
  the exact tier on both compilers, for example `synth-juno-pad`, `organ-*` and `pan-mono-src`. They were outside
  W3B's promotion list.
- **Carried over, unchanged:** T15 review 5 (T11 O5 `pendingEnded_`), 6, 7 and 8; T16 review O4 (`DroneUnit::later`
  cap) and O5 (sanitizer guards for clang ASan).
