# LANE TOUCH (D43): builder state

Brief: Ryan's FP-10: soft notes too loud, hard notes don't get louder. Copy Pianoteq's two-part model.
(1) Per-keyboard piecewise-linear velocity calibration curve (2–12 monotone points, Pianoteq text
`Velocity = [in…; out…]` paste/copy, five-step assistant silence/p/mp/f/fff with p/mf/f = 32/64/96, editor with
draggable points + numbers + presets + live readout + histogram), applied in the controller before the engine,
stored in settings.keyboards (device-local), old `{shape,min,max,top}` curves unchanged. (2) settings.dynamicRange
shown in dB, cap raised so multi-layer reaches ≈60 dB (shared DYN_RANGE, native clamp, mock-native), single-layer
capped, values ≤ 3 bit-identical, peaks at max measured. No app/js/engine change. Spec: native/docs/lanes/IO-2.0.md
"Lane TOUCH". Worktree /home/claude/wt-touch, branch lane-touch from origin/v2-native a28f0b3. Never push / stash.

## Checklist
- [x] 0. LANE.md, baseline native build (g++ Release, build-touch-base) + baseline renders of the 112 fixtures
- [x] 1. shared/velocity-cal.js: parse/format/eval/validate/fit/presets + node:test
- [x] 2. store.js: settings.keyboards[*].velocity validation; migrate idempotent; tests
- [x] 3. controller: apply calibration before the engine (silent = 0), capture/readout/histogram feed; tests
- [ ] 4. DYN_RANGE max 6, single-layer cap (72 dB), validDynRange; native clamp (song.cpp, sampler.cpp, schema/bridge
      comments), mock-native; tests (web/native agree > 3)
- [ ] 5. UI: Settings › Keyboards (old layout) + v6 equivalent: editor, assistant, dB dynamics; tests
- [ ] 6. Native rebuild g++ / clang-20 -Werror / ASan; ctest; fixtures byte-identical vs baseline
- [ ] 7. Peak measurements at max through the master ceiling; CONTRACT_CHANGES "TOUCH (D43)"; MAC_CHECK step 4 item
- [ ] 8. Gates: shell-unit, unit, settings, ui-core, ui-v6, migration-1x (+ new suites)
- [ ] 9. Final report in this file

## Next step
4 (native clamp + mock); baseline renders are in /home/claude/scratch/touch/base-renders (112, from
native/core/build-touch-base at a28f0b3 sources).

## Findings / decisions so far
- Calibration stored as `settings.keyboards[name].velocity = {in, out}` (2 dp, 2–12 points, in strictly rising,
  out non-decreasing, 0..127); invalid = refused by setKeyboard, dropped by normalizeKeyboards. Points beat an older
  `touch` on the same entry; Settings clears `touch` when it saves points.
- Controller: calibrated velocity rounded to an integer (the bridge carries integers); 0 = silent, not sent.
  `controller.recentVelocities(name)` = last 200 raw velocities per device (histogram).
- Assistant targets silence 0 / p 32 / mp 48 / f 96 / fff 120; full (127) at fff + 7·(fff − f)/24 (≤ 127); an fff
  median ≥ 126.5 (board tops out) plays 127.
- Dynamics: DYN_RANGE.max 6; velocityDb caps r so span·r ≤ 72 dB (single layer stops at range 3 = 72 dB; ≤ 3 is
  bit-identical, unit-tested over every 0.01 step).

## Open questions
