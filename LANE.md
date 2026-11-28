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
- [x] 6. Native rebuild g++ / clang-20 -Werror / ASan; ctest; fixtures byte-identical vs baseline
- [x] 7. Peak measurements at max through the master ceiling; CONTRACT_CHANGES "TOUCH (D43)"; MAC_CHECK step 4 item
- [x] 8. Gates: shell-unit, unit, settings, ui-core, ui-v6, migration-1x (+ new suites)
- [x] 9. Final report in this file

## Next step
Done; hand back. (After a restart: nothing to resume.)

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

## Final report (builder, 2026-11-28)

**Gated tree: `75e6488`** (all code; this report commit adds only LANE.md text). Tip SHA: the commit that adds this
section (see `git log -1` on lane-touch).

### What I built
1. **Calibration curve** (`app/js/shared/velocity-cal.js`, new, pure): Pianoteq points `{in, out}` (2–12, 0..127,
   in rising, out non-decreasing, refused not repaired), `parseVelocity` / `formatVelocity` for
   `Velocity = [in…; out…]` (round-trips byte for byte), `compileCurve` / `calAt` / `calVelocity` (whole velocity,
   0 = silent), presets Linear / Light / Heavy / Fixed (old named curves as points, ≤ 0.8 velocity off),
   `curveFromTouch` (old `{shape,min,max,top}` shown as points), five-step `fitCalibration`.
   Store: `settings.keyboards[name].velocity` (device-local, validated, `setKeyboard` refuses bad curves, migrate
   idempotent, no SCHEMA bump). Controller: `keyboardNoteOn` applies it before the engine (2-arg noteOn, linear at
   the engine; silent notes not sent), points beat an older `touch`; `recentVelocities(name)` (last 200 per device).
   Edit › slot sparkline draws the points for Normal slots.
2. **Editor** (`views/components/velocity-editor.js`, new; same nodes in the old and v6 Settings): graph with
   histogram, draggable / keyboard-movable points, live readout, numbers, Add point, presets, Pianoteq text Copy /
   Use pasted, Calibrate… (five steps). CSS in `styles-settings.css`, theme tokens only.
3. **Dynamics in dB**: slider 10–60 dB (store keeps the multiplier). `DYN_RANGE.max` 6. `velocityDb` is **the 1.x
   1.1.2 function (`915f496`) byte for byte** (orchestrator's rule): past 3× pianos widen downwards only (60 dB at 6×,
   top stays +5 dB), spans ≥ 20 dB stop at 3× (72 dB); ≤ 3 bit-identical. Native `sampler.cpp` mirrors it operation
   for operation; clamps 1..6 in `song.cpp` / sampler op; mock-native and shim via `validDynRange`; contract text.
4. **Goldens**: `setup.dynamicRange` (page.js + native `fixture_runner.cpp`), five exact fixtures `dyn-range-*`,
   `dyn-peak-r1/3/6` (`tests/golden_ids/touch.ids`, COVERAGE op). Docs: CONTRACT_CHANGES "TOUCH (D43)",
   INTERFACE_LOG "TOUCH", MAC_CHECK step 4 item 17, golden README field.

### Test evidence
- Gates on `75e6488`: shell-unit, unit, settings (119/119, all five modes), ui-core, ui-v6 (first run failed the
  flag-off purity check on one extra `<option>` in the MIDI-clock select, a device-list timing difference outside this
  lane; `--force` rerun PASS), migration-1x, edit-v2: all PASS.
- Native on the 1.1.2 rule: g++ ctest 89/89; clang-20 (-Werror) 0 warnings, 88/89 in the full run (rt.realtime
  xruns 4 > 3 under load), rt.realtime alone PASS; ASan+UBSan 89/89, no report (13 cut off by a restart, rerun).
  `golden.touch` PASS on g++ / clang / ASan.
- Fixtures: the 112 old ones render byte-identical to the base (`a28f0b3`) build with g++ and clang-20 (112/112
  `cmp`, base PCM set); their manifest entries are unchanged. New ones native vs web: ep-rhodes 2.98e-8, salamander
  5.84e-5 (its own residue; range-1 fixture 1.51e-4), dyn-peak 5.6–6.3e-5; level change 6× vs 1× per note,
  web − native ≤ 1.7e-6 dB.
- Peaks (web, master −6 dB): past 3× no peak rises (7-note fff piano chord +10.9 dBFS before the ceiling,
  −1.02 dBFS out, at 3, 4.5 and 6).
- `git diff origin/v2-native...HEAD -- app/js/engine`: empty.

### Decisions (and why)
- Assistant targets silence 0 / p 32 / mp 48 / f 96 / fff 120; full at fff + 7·(fff − f)/24 (≤ 127), an fff median
  ≥ 126.5 plays 127: harder than fff still gets louder; a light board reaches full at its hardest notes. Pianoteq's
  own fit algorithm is not published: these targets are mine, built on its p/mf/f = 32/64/96 reference points.
- Silent output (0) is not sent to the engine (Pianoteq: velocity 0 out = no sound; engine 0 = note-off).
- Calibrated velocity is rounded to an integer (the bridge carries integers) so web and native agree.
- Points replace an old `touch` only when the player edits; an entry with both plays the points.
- The old Feel/Softest/Loudest sliders and two-step fit left the UI (`fitTouch` stays exported; 1.1.2's fitTouch
  change is not ported, as the orchestrator said; nothing here contradicts it).
- Dynamics shown as one dB number (pianos) with the single-layer number beside it.
- No bridge minor bump: same field, wider range, the reply echoes the range in force.
- My first dynamics cut (72 dB span cap, pivot kept, top +12.5 dB, fff chords ≈ 19 dB into the ceiling) was
  replaced by the 1.1.2 rule; no second rule kept.
- Goldens were rendered by playwright's chromium-1194 build of the pinned 157.0.8103.78; the manifest pin object was
  left as it was.

### Only Ryan's FP-10 can verify (MAC_CHECK step 4 item 17)
Key Touch Light vs Medium, the assistant with real keys (does fff still get louder), a pasted community FP-10 curve,
how 30 / 45 / 60 dB feel (at 60 dB velocity ≈ 96 plays 7.5 dB quieter: the master may want raising), a 1.1.2
backup with Range 6× sounding the same, real pointer drag on the Mac / iPad.

### Notes for the orchestrator
- `node_modules` in the worktree is a symlink to the main repo's (git-ignored); `native/golden/out` holds symlinks
  to the main repo's goldens plus the five new ones; `native/golden/pcm` holds 155 MB of git-ignored PCM dumps that
  render.mjs wrote (they change native sampler renders: compare against a base with the same PCM set).
- Build dirs: `native/core/build-touch-base` (g++, rebuilt on the lane), `-clang20`, `-asan`; delete when merged.

## Skeptic (touch-skeptic, 2026-11-28)
Brief: adversarial review of lane TOUCH (velocity-cal, assistant, controller, storage, purity-test edit, removed UI,
native clamp/fixtures), rebase onto origin/v2-native, gates, report in native/docs/reviews/touch-skeptic.md.
- [x] S0. rebase onto origin/v2-native (9f844af): one conflict, CONTRACT_CHANGES (both sections kept)
- [x] S1. velocity-cal parse/print/eval probes
- [x] S2. assistant fit probes
- [x] S3. controller paths (silent notes, note-off, pedal, mono, learn, computer keys)
- [x] S4. migration/storage/exports/backups
- [x] S5. ui-v6 purity edit
- [x] S6. removed UI references / 1.x features
- [x] S7. native clamp, fixtures, velocityDb vs wt-v112 byte compare
- [ ] S8. gates
- [ ] S9. report
Findings:
- F1 (fixed 3a2aedc): calVelocity rounded outputs < 0.5 to silence; Heavy preset silenced key velocities 1..3 (old
  'hard' played them). Now only an output of exactly 0 is silent; > 0 plays at least 1.
- O2 (fixed 32bf082): parser silently dropped an empty field ("0, , 127"); text after "]" gave a wrong reason.
- O3 (fixed 9ae8616): ui-v6 purity excluded the whole Your keyboards block; narrowed to the rows' Touch editors.
- O4 (fixed ee6e832): stale 1..3 comments (bridge-engine, mock-native). O5: dead `.st-kb-fit` CSS selector.
- Ryan: "Fit to my touch" (1.x 1.1.0, improved in 1.1.2) and the Feel/Softest/Loudest keyboard sliders are gone from
  2.0 Settings (replaced by points + Calibrate…); old curves still play. Needs his OK.
- velocityDb: JS byte-identical to wt-v112 5473b04 (function + constants + validDynRange); native same op order,
  -ffp-contract=off. Native after rebase: g++ ctest 89/89, clang-20 0 warnings 89/89, ASan+UBSan 89/89 (79 + 10
  rerun after a 30-min cut); 112 old fixtures cmp-identical to base renders with g++ and clang-20.
- F2 (fixed 0d84888): ui-v6-edit's own flag-off purity check failed (the builder ran edit-v2, not ui-v6-edit):
  same narrow TOUCH exclusion as ui-v6.
- O8 (fixed): migration-1x D11 "from this computer" toast flake (2-toast stack evicts the info toast); pre-existing,
  reproduced on clean archives of 9f844af and e8bd0c7; the test now reads a MutationObserver toast log.
- Next: S8 JS gates (shell-unit,unit,settings,ui-core,ui-v6,edit-v2,ui-v6-edit,migration-1x,chart), then report.
