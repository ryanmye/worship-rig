# touch-skeptic: review of lane TOUCH (D43, Pianoteq-style keyboard calibration + Dynamics in dB)

Reviewer: strong skeptic, 2026-11-28. Branch `lane-touch`, worktree /home/claude/wt-touch. Reviewed at builder tip
0404c16 (gated tree 75e6488).

**Verdict: MERGE** (after the fixes below, which are committed on the lane), with one question for Ryan (Q1).

The design holds:
- The calibration runs in the controller, before the engine. `git diff origin/v2-native...HEAD -- app/js/engine` is
  empty.
- `velocityDb` is the 1.1.2 function byte for byte, with the same constants. The native copy uses the same
  operations in the same order, built with `-ffp-contract=off`.
- With no curve set, the engine gets exactly the calls it got before.

## Rebase

- The lane was based on a28f0b3. `origin/v2-native` was at 9f844af (lanes N0 and N3, D44, the 1.1.2 patch).
- One conflict: `CONTRACT_CHANGES.md`, where both sides appended a section. Both were kept (N0, N3, then TOUCH).
- `controller.js` and `MAC_CHECK.md` merged by themselves. I checked the controller hunks by hand: N0's changes and
  the TOUCH note path don't touch each other.
- During the review `origin/v2-native` moved to 3872bd9 (D45 and the REMOTE lane plan, docs only). The lane was
  rebased onto it cleanly.
- After both rebases, `git diff origin/v2-native...HEAD -- app/js/engine` is still empty.

## Findings and fixes

| id | what | severity | status |
|---|---|---|---|
| F1 | `calVelocity` rounded every output under 0.5 to 0, which is a silent note. The Heavy preset (the old 'hard' curve, v^1.6, as points) maps key velocities 1–3 to 0.05–0.35, so they made no sound. The old 'hard' curve played them (about −10 dB on a piano), because the engine never got a 0. A pasted or edited curve with a shallow start had the same problem. The module's own rule, and Pianoteq's, is that only an output of 0 is silent. | med (lost soft notes on stage, in the lane's own preset) | **fixed** |
| O2 | `parseVelocity` read `0, , 127` as two points instead of refusing the missing number, which goes against the module's "refused, not repaired" rule. Text after the `]` (`Velocity = [...];`, or a note pasted from a forum) was refused with the wrong reason ("missing its closing ]"). | low | **fixed** |
| F2 | The **ui-v6-edit** gate failed. The suite has its own flag-off purity check ("charts off: non-sample requests"), and the builder had only taught ui-v6's check about the two new modules. The builder ran `edit-v2`, not `ui-v6-edit`. | med (a red gate) | **fixed** |
| O3 | The ui-v6 flag-off purity check left out the whole `[data-testid="settings-keyboards"]` block. That also dropped the heading, the Dynamics row and every keyboard row's head (Touch… / Remember / Forget) from the DOM comparison. Only each row's hidden `.st-kb-edit` actually changed. | low (a weaker test) | **fixed** (narrowed) |
| O4 | Stale `1..3` comments in `bridge-engine.js` setDynamicRange and in `mock-native.js`. | trivial | **fixed** |
| O5 | Dead CSS: `.st-kb-fit .ed-btn` (the old fit box is gone). | trivial | **fixed** |
| O6 | Parsing is strict about surrounding text. `My FP-10: Velocity = [...]` is refused ("Paste one curve"). The player has to paste the curve alone. | low | open (by design; the message says what to paste) |
| O8 | migration-1x "D11 Settings › Import… from this computer" is flaky, and the flake is older than this lane: it reproduces on clean archives of 9f844af and e8bd0c7. The toast stack keeps 2 (main.js), and the warn toasts for this box's missing devices can arrive after the info "Device settings used: N" and push it out before the 50 ms poll sees it. | low (a red gate on a loaded box) | **fixed** (the test reads every added toast) |
| O7 | After a downgrade, 1.x keeps `velocity` (it keeps unknown entry fields) but doesn't play it. Saving points clears `touch`, so a keyboard calibrated in 2.0 plays Standard touch in 1.x. 1.1.1 also clamps the Range to 3. | — | expected; noted |

### Fixes

The fixes are commits 4943757, 8f7b5b3, b46f9b6, e1f118d, 6804cc1, 972f44f, d77dfca and c50114b (SHAs after the
second rebase; prefixed `touch-skeptic:`). They are recorded in CONTRACT_CHANGES under "TOUCH (D43)", as "touch-skeptic fixes".

- **F1:** `calVelocity` returns 0 only when `calAt` is exactly 0. Any positive output plays velocity 1 or more.
  - Unit test: Heavy sounds at every key velocity from 1 to 127, and an output of 0.008 plays velocity 1.
  - touch-cal test: the on-screen note that was "silent" at an output of 0.4 now plays velocity 1.
  - The FP-10 example still makes key velocity 1 silent (its output there is exactly 0). So does the assistant's
    region below the silence median.
- **O2:** an empty field between commas, or before the first number, is refused ("A number is missing between two
  commas"). A trailing comma is still accepted. Text after the `]` gives "Paste only the curve: there is text after
  its closing ]".
- **O3:** the purity filter is `[data-testid="settings-keyboards"] .st-kb-edit`. `TOUCH_MODULES` (the two new modules
  removed from the request set) is unchanged and narrow. Its JSDoc was moved so that `purityBoot`'s doc sits on
  `purityBoot` again.
- **F2:** `test/phase2/ui-v6-edit/run.mjs` `purityBoot` gets the same `TOUCH_MODULES` request filter and the same
  `[data-testid="settings-keyboards"] .st-kb-edit` DOM filter.
- **O8:** the test installs the first-launch test's MutationObserver toast log before it clicks Import, and waits
  on the log. It passed 3 runs out of 3; before the fix it failed 3 of 3 on 9f844af and 1 of 2 on e8bd0c7.
- **New controller test** (touch-cal, 7th test):
  - A silent note (FP-10 curve, velocity 1) under the pedal, on a re-strike and as a duplicate note-on sends no
    `noteOn` and no `noteOff`.
  - A silent strike and release on the FP-10 doesn't cut the same note held on another keyboard.
  - A sounding note whose curve turns all-silent while it is held still gets its note-off.

## What I checked (adversarial items of the brief)

1. **Text format (velocity-cal.js).** I probed 37 strings (`/home/claude/scratch/touch/p1.mjs`).
   - The community FP-10 curve `[0, 1, 18, 32, 50, 108, 127; 0, 0, 30, 57, 84, 127, 127]` is accepted. That includes
     the flat start (0→0, 1→0) and the flat top (108→127, 127→127). It prints back byte for byte.
   - Accepted: spaces only, no brackets, `:` or no `=`, any case, tabs, CR LF, NBSP, `.5` and `5.`, two decimals.
   - Refused: a sign, an exponent, hex, values over 127, rows of different lengths, 1 point, 13 points, a duplicate
     or falling input, a falling output, a third row, nested brackets. `127.004` is refused after rounding to two
     places; so are inputs that become equal after rounding (1.001 and 1.004).
   - Between points the curve is linear, and flat outside them.
   - Rounding: `Math.round`, so 63.5 → 64. After F1, a positive output plays at least 1.
2. **Assistant fit.** I probed 14 synthetic sets (`p2.mjs`): typical, a light board (fff around 50), a board that
   tops out (fff 127), fff = 126, f and fff 1 apart, near-equal steps, a gap of exactly 2, outliers (1 and 127 in
   every step), junk values (strings, null, 0, −5, 200), too few notes, a high silence step, half-integer medians.
   - Every fitted curve is monotone over 1..127.
   - The fff median plays 120, and harder notes still get louder (fff + 5 → 125–127). The full level point
     `fff + 7·(fff − f)/24` is always above fff (at least +0.58), so the input row always rises strictly.
   - Too few notes → `few`; steps under 2 apart → `order`.
3. **Controller.**
   - The curve is applied once. Calibrated notes go to the engine as a 2-argument `noteOn` (no `{touch}`), so the
     keyboard's old `touch` and the Touch setting don't apply as well.
   - Slots on soft / hard / fixed / own still apply their own curve after it, as the spec says. 'normal' slots play
     it linearly.
   - Lookup is per keyboard by name (`inputNames`), and is rebuilt when the settings or the inputs change.
   - The computer keys and on-screen keys are unchanged unless `@computer` has a curve. The computer keys then send
     100 through it.
   - Learned button notes return before `captured()` and the curve, so they are unaffected and kept out of the
     histogram.
   - `recentVelocities` holds 200 entries per device in a ring buffer (Uint8Array), for at most 64 devices (the
     oldest is evicted). The on-screen path clamps the raw value to 1..127 before logging it, so the Uint8Array
     can't wrap.
   - Silent notes: see the new test above. `noteOffFrom` only sends a note-off for a note it holds, and the pedal is
     engine-side, so a note that was never sent can't be held or stuck.
4. **Storage.**
   - `settings.keyboards` is in `DEVICE_LOCAL_SETTINGS`, so it is not exported and a replace-import keeps it.
   - `velocity` is validated in `normalizeKeyboards` (dropped, never repaired) and in `setKeyboard` (the whole call
     is refused).
   - I probed bad data that must not crash: a string, `in` as a string, a 1e6-element array (refused on length
     before the loop), an object inside `out`, extra fields. `migrate()` is idempotent on a library with a valid
     curve and an invalid one.
   - A 1.1.2 `deviceSettings` block with `dynamicRange: 6` is now kept at 6 (it was clamped to 3), so a 1.1.2 backup
     sounds the same. Its `{touch}` keyboards come through as they are.
   - Old `{shape,min,max,top}` entries still play through `{touch}` exactly as before (touch-cal test 3). The editor
     shows them as points but saves nothing until the player changes something.
5. **ui-v6 purity edit.** The change was narrow but excluded too much; see O3. With the narrower filter, ui-v6's
   purity test still passes against the base (32 s, compared, not skipped), so the only DOM change in that block is
   inside `.st-kb-edit`. ui-v6-edit's copy of the check had not been updated at all; see F2.
6. **Removed UI.**
   - The old keyboard Feel / Softest / Loudest / Full volume at sliders, the curve diagram and the two-step "Fit to
     my touch" are gone from Settings (both layouts). No test id, class or code still refers to them. The only
     leftover was the dead CSS in O5.
   - `fitTouch` stays exported and tested.
   - The per-slot Own curve in Edit (Feel / Softest note / …) is a different feature and is unchanged.
   - 1.x docs (`docs/release-notes-1.1.0.md`, the site's screenshot alt text) still describe Fit to my touch. They
     describe 1.x, so I left them.
   - This drops a 1.x feature: see Q1.
7. **Native.**
   - The clamp is 1..6 in `SongGraph::setDynamicRange` (`kDynRangeMax`) and in the sampler's `DynamicRange` op.
     `mock-native.js` and `bridge-engine.js` use `validDynRange`, which follows `DYN_RANGE.max`.
   - The contract text and spec say 1..6. There is no minor bump (same field, same reply), which is fine.
   - Manifest: 112 → 117 fixtures. The 112 old entries are unchanged (deep-equal), and none were removed. The five
     new ones are `exact`, with the default exact tolerances. `chromium` and `chromiumPin` are unchanged.
   - The top-level `tiers` summary and `pcm` totals were recomputed by render.mjs. The old summary was stale (it named
     fixtures promoted to exact long ago). Six new `pcm/salamander-piano/v14/*.json` sidecars were added for the new
     fixtures, in the existing pattern (the WAVs are git-ignored).
   - Byte identity of the old fixtures after the rebase: rendered with the lane's g++ and clang-20 builds against the
     base's PCM set (`RIG_SAMPLES_PCM_OVERRIDE=…/pcm-base`), all 112 are `cmp`-identical to the builder's base
     renders (a28f0b3) for both compilers.

## Gates

(filled in below after the gate run)

## Questions

- **Q1 (Ryan): Fit to my touch is gone.** 2.0 Settings no longer has the keyboard's two-step "Fit to my touch" (1.1.0;
  D44 improved it in 1.1.2: full at the 90th-percentile hard note) or the Feel / Softest / Loudest / Full volume at
  sliders.
  - They are replaced by the points editor, presets and the five-step Calibrate….
  - Curves made with them keep playing exactly as before, and the editor shows them as points.
  - Points can approximate any of those curves closely: `curveFromTouch` samples one at 10–11 points, and the
    Light / Heavy presets stay within 0.8 velocity of the old soft / hard curves.
  - Even so, it is a 1.x feature removed by a lane, so it needs Ryan's OK. If he wants it back, `fitTouch` is still
    exported and a "Fit (2 steps)" button could write `touch` as before.
- Q2 (orchestrator): the silence step makes everything below its median silent (Pianoteq's model). A player who
  presses the silence keys too hard loses soft notes until they recalibrate. The editor shows it ("→ silent") and
  the curve can be dragged.

## Only Ryan's FP-10 can verify

MAC_CHECK step 4 item 17:
- Key Touch Light vs Medium.
- The assistant with real keys: does fff still get louder, and is the silence step understood?
- A pasted community FP-10 curve.
- How 30 / 45 / 60 dB feel. At 60 dB a velocity-96 note plays 7.5 dB quieter, so the master may want raising.
- A 1.1.2 backup with Range 6× sounding the same.
- Pointer drag on the Mac and on the iPad.
- After F1: whether Heavy's softest notes (velocity 1 for key velocities 1–3) are wanted or are noise.
