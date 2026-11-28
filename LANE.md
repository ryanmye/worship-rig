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
- [x] 4. DYN_RANGE max 6, single-layer cap (72 dB), validDynRange; native clamp (song.cpp, sampler.cpp, schema/bridge
      comments), mock-native; tests (web/native agree > 3)
- [x] 5. UI: Settings › Keyboards (old layout) + v6 equivalent: editor, assistant, dB dynamics; tests
- [ ] 6. Native rebuild g++ / clang-20 -Werror / ASan; ctest; fixtures byte-identical vs baseline
- [x] 7. Peak measurements at max through the master ceiling; CONTRACT_CHANGES "TOUCH (D43)"; MAC_CHECK step 4 item
- [ ] 8. Gates: shell-unit, unit, settings, ui-core, ui-v6, migration-1x (+ new suites)
- [ ] 9. Final report in this file

## Next step
5 (UI tests: settings app + v6 modes), then 6 (clang-20 / ASan builds, ctest), 7 (docs), 8 (gates).
Baseline renders: /home/claude/scratch/touch/base-renders (112, native/core/build-touch-base at a28f0b3 sources);
new renders after the clamp change: 112/112 cmp-identical (g++). build-touch-base is now the lane's g++ build.
node_modules is a symlink to /home/claude/worship-rig/node_modules (git-ignored).

## Findings / decisions so far
- Calibration stored as `settings.keyboards[name].velocity = {in, out}` (2 dp, 2–12 points, in strictly rising,
  out non-decreasing, 0..127); invalid = refused by setKeyboard, dropped by normalizeKeyboards. Points beat an older
  `touch` on the same entry; Settings clears `touch` when it saves points.
- Controller: calibrated velocity rounded to an integer (the bridge carries integers); 0 = silent, not sent.
  `controller.recentVelocities(name)` = last 200 raw velocities per device (histogram).
- Assistant targets silence 0 / p 32 / mp 48 / f 96 / fff 120; full (127) at fff + 7·(fff − f)/24 (≤ 127); an fff
  median ≥ 126.5 (board tops out) plays 127.
- Dynamics: DYN_RANGE.max 6; velocityDb = 1.x 1.1.2's function (915f496) byte for byte (orchestrator, 2026-11-28):
  past 3 pianos widen downwards only (60 dB at 6, top +5 dB), spans >= 20 dB stop at 3; ≤ 3 bit-identical. My first
  cut (72 dB span cap, pivot kept, top +12.5 dB) was replaced, not kept.

- Golden fixtures dyn-range-salamander-piano / dyn-range-ep-rhodes (range 6, slot tap, gain 0.3) and dyn-peak-r1/3/6
  (tap out). Native vs web (1.1.2 rule): ep-rhodes 2.98e-8; salamander 5.84e-5; per-note level change 6 vs 1, web −
  native ≤ 1.7e-6 dB (.probe/ratio.json). Peaks: past 3 none rise (CONTRACT_CHANGES table).
- 112 old fixtures byte-identical vs base: compare with the base's PCM set (pcm-base: only ep-rhodes C4/E4 wavs);
  render.mjs wrote 155 MB of PCM dumps into native/golden/pcm (git-ignored), which changes native sampler renders.
- Goldens rendered by playwright's chromium-1194 build of 157.0.8103.78 (the pin names the headless-shell-1243 build of
  the same version); chromiumPin restored to the old object so nothing else churns.

## Open questions
