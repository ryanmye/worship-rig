# UI v6 U1 (the hidden v6 Perform shell and strip): skeptic review (2026-11-26)

Verdict: **VERIFIED, after fixes.** As delivered, the change was PARTIAL.

These claims held:

- flag-off purity, checked against the full outerHTML and every listener rather than the suite's DOM shape;
- the store paths each strip control writes;
- Revert counts and changed dots;
- Esc / ⌘. panic;
- on / off cycles that leave nothing behind;
- the module boundaries;
- an untouched engine;
- zero console.error.

Four defects did not hold:

- An empty strip showed the level and sends of the instrument that sat there before a Remove (F1).
- A strip's ⋯ menu stayed open, acting on a different instrument, after the slots shifted under it (F2).
- At the Mac app's minimum window (1024 × 700) with more than 5 instruments, the fader had a 58 px track and its thumb
  covered the dB readout (F3).
- The snapshot row's Update / Save as new links were 36 px tall (F4).

All four are fixed, each with a test, and the gate is green. Of the 3 "pre-existing" run-all failures, two are real on
base 966b0b4 and one is a known flake (details below). Ryan still has to decide three things: PANIC and Lock now need a
hold (O1, O2), and there is no way to turn v6 on in the Mac app other than DevTools (O3).

Under review: commit 6623b04 on lane-u1 (base 966b0b4 on v2-native). It touches `app/js/views/v6/*`,
`app/styles-v6.css`, main.js, store.js, `test/phase2/ui-v6/run.mjs` and run-all. I didn't build it.

## Gate

The box had 2 CPUs, and another agent was running engine and edit-v2. The load average was 2–7. I ran the suites one
at a time.

| suite | result |
|---|---|
| ui-v6 (`test/phase2/ui-v6/run.mjs`) | 14/14 as delivered. After the fixes 16/16 (2 new tests and 1 extended), passing in all 3 runs, including the one in run-all |
| shell unit (`run.mjs --only unit`) | 328 pass, 0 fail, including the new `ui-v6-store.test.mjs` |
| `node test/run-all.mjs --fast` (after the fixes, at e988aa4 + 7c14aa6) | 13/15 passed, 3 skipped, 35m53s, with another agent's ui-core running alongside (load ~7). Both failures are pre-existing: engine 98/99 (only the `/__tests/api/health` 404 console.error) and eq 27/28 (L-21). migration-1x 115/115, shell 346, ui-core 91, edit-v2 114, settings 88, themes 58, chart 15, ui-v6 16/16 |
| contrast audit: `tools/themes/shoot.mjs` (a copy with the flag on), 1280×800 | Sanctuary 111 runs, 0 fail (lowest 4.63, PANIC); Sanctuary Day 0 fail (lowest 4.48, the 22 px bold key letter: large text, needs 3); Daylight Day 0 fail (lowest 4.67) |
| independent flag-off purity probe (3 base/branch pairs) | identical; see below |
| console.error / HTTP ≥ 400 | 0 in every probe, flag off and on (only the expected MIDI / wake-lock warnings) |
| Electron suites | not run (Linux). The flag-off path is the same code in both shells. |

**The 3 "pre-existing" run-all failures**: I checked each on a base checkout (`git worktree add /tmp/u1-base
966b0b4`, node_modules symlinked, removed afterwards).

- **engine**: the console.error `404 /__tests/api/health` is there on base too (base: 97/99, with the same 404).
  - Base also failed `realtime.audioSleep` once under load 3–5, a timing test.
  - The branch changes nothing in `app/js/engine`, `shared/` or controller.js.
  - **Confirmed pre-existing.**
- **eq "L-21 note labels fit"**: fails the same way on base, with the same cells (`db "−12.5" 37.5 > 32.0`,
  `q "1.41" 30.0 > 28.0`). **Confirmed pre-existing.**
- **migration-1x "box is ticked"**: passes on base and passes on the branch (114/114 each).
  - It is the D11 import test that times out under load. The patch-packs review records it as a known flake.
  - **A flake, not a branch failure.**

## How I checked

- **Flag-off purity** (a `/tmp` probe, not committed; stricter than the suite's own check).
  - Setup: I served `/tmp/u1-base/app` and the branch's `app/` through the same server.js. I booted each 3 times at
    1280×800 in Sanctuary, waited for ready plus Settings and Edit plus 2.5 s, and then compared the items below.
  - **Requests**: identical as a multiset, 110 per boot and 103 unique. The order varies from boot to boot on base too.
    No request touches `views/v6/` or `styles-v6.css`.
  - **Listeners**: every live `addEventListener` on window, document, the controller, the engine, MIDI, MediaQueryList,
    EditState and the rest, net of removes, by type and capture: 0 differences.
  - **Timers and frames**: `setInterval` 4 = 4. `setTimeout` and rAF counts are within run-to-run noise.
  - **Store listeners**: 14 = 14.
  - **DOM**: the full `body.outerHTML` and `head.outerHTML`, with digit-bearing attributes normalised, were identical in
    2 of 3 pairs. The third pair differed only in the top bar's "Preparing 11 of 19" load progress.
  - **CSS**: the same stylesheets with the same rule counts (styles.css 681, settings 234, …).
  - **`__rig`**: the only difference is `setUiV6` and `views.v6`.
  - `?ui6=0` with the flag absent is a no-op: `set` returns false and fires no notification (unit test).
- **Lifecycle** (flag on).
  - Probe: I counted net window/document and other EventTarget listeners, pending `setTimeout` and rAF calls (with
    stacks, filtered to `views/v6/`), store listeners, `.v6` / `.v6-pop` / `[data-perform-overlay]` nodes and the
    `link[data-v6-css]`.
  - Cycles: 4 off/on cycles, each with the Setlist popover, a ⋯ menu, the Quick sheet and a step panel opened first.
  - Result: back to the boot numbers every time, with 0 v6 timers, 0 v6 rAF, 0 v6 nodes and no link.
  - The only lasting change is overlay.js's single window click-capture listener. It is installed once, the first time
    any overlay opens, by design.
  - Rapid `setUiV6(true / false / true)` and `(false / true / false)` without awaiting end in the last state with
    exactly one Perform mounted.
  - With the chart view on: it mounts on v6 (toggle in the song bar, panel on the board) and moves back to today's
    Perform when the flag goes off.
- **Writes against today's Perform.**
  - I read `views/perform.js` and the v6 strip side by side. `setSlotGain` goes through `scenes.adjust` first, then
    `slots.<i>.gain`.
  - The rest map one to one: `.muted` (through `slotMuteState`), `.sends.reverb`, `.sends.delay`, `.octave` and
    `.sustain`. The Space room goes through the same `applyPreset` loop, Revert writes `SAVED_FIELDS`, and Sing it in
    uses the same `singItInShift + singOctave − transposeSemisOf`.
  - Parity probe: the same 4 edits (a fader move, Octave, Space and transpose) in each view. Both report Revert
    `data-count` 3 and the same `changedPaths` (`slots.0.sends.reverb`, `slots.1.octave`, `hearIn`). Edit's
    `editState.changes` is 3 as well.
  - Leaving Edit retakes the snapshot, as today (`lastView === 'edit'`).
- **Esc / ⌘. / Ctrl+.** each panic at once with v6 on, counted by `action` events of type panic: 1, 2, 3. Esc with a v6
  popover open closes it with no panic. Esc in Edit with a hidden v6 menu still panics, because overlay.js prunes
  hidden overlays.
- **Scenes.** I saved a scene, then moved a fader while it played. "edited" appears, and the song's own gain is
  unchanged (the scene took the move). Save as new gives scene 2, which then plays. "+ Save" stays live under Lock, as
  today's Quick › Save as scene does (O6).
- **Lock.** Change, Add, Duplicate, Open in Edit and Remove are frozen. If Lock comes on while a ⋯ menu is open, its
  Duplicate stays clickable but does nothing: `duplicateSlot` and `removeSlot` re-check `isLocked`. Transpose and the
  key need a hold.
- **Edges.**
  - 16 instruments: 152 px strips, the row scrolls, `pill-15` scrolls strip 15 fully into view, Add and Duplicate are
    disabled.
  - Empty library: "No song", no strips, Add hidden. Key and Own levels are disabled, and Revert / PANIC holds throw
    nothing.
  - A song switch mid-fader-drag cancels the drag. The new song's gain stays at its saved 0.7, and the popovers close.
- **Module boundaries.** Views write through `store.set` / `addSlot` / `removeSlot` and `controller.*` only.
  - The engine is only read: `listInstruments`, `wheelValues`, `pedal`, `getRuntimeState` and `_fade`, the same reads
    perform.js makes.
  - Nothing under `app/js/engine`, `shared/` or controller.js changed.
  - The one `setTimeout` is the view's 150 ms / 1 Hz runtime poll, the same as today. The one `innerHTML` is the static
    icon table.
  - Every new line is ≤ 120 characters.
- **Accessibility.**
  - Every visible v6 button and input is ≥ 44 × 44, including the popovers, the step panels and the 44 px pill
    buttons; F4 was the exception.
  - Every control has an accessible name.
  - Tab order is the song bar, snapshots, pills, then each strip (ON, level, Space, Echo, Octave, Sustain, Change, ⋯);
    the empty strips' disabled controls are skipped.
  - After a pointer tap on a setlist entry, pill or snapshot chip, focus is back on body, so Space stays the sustain
    pedal (checked: pedal down, cue unchanged).
  - Contrast is in the gate table.

## Findings

- **F1 (medium) An empty strip showed stale values.**
  - Strips are reused by position. Removing slot 0 of `[Piano, Pad, —, Organ]` made strip 1 empty, but it kept Pad's
    −5.2 dB fader, Space 50 %, Echo 10 %, Octave +1 and their changed dots (dimmed, but readable).
  - A fresh empty slot showed a made-up "−1.9 dB".
  - Fix (`strip.js`, `styles-v6.css`): the empty branch zeroes the fader, sets every chip off, clears the loaded and
    changed state and hides the dB readout.
- **F2 (low) A ⋯ menu outlived a slot shift.**
  - Setup: slot 2's menu was open, and slot 0 was removed elsewhere (Edit, a store write).
  - Result: the menu stayed open with the old header, and its Remove (hold) would have removed the instrument that is
    now at index 2.
  - A menu on a strip that became hidden also stayed open.
  - Fix (`strips-row.js`): menus and step panels close whenever the song's slot count changes.
- **F3 (medium) The fader was unusable at the minimum window.**
  - Main.js sets the Mac window minimum to 1024 × 700. There, with > 5 instruments, the name-pill row left a 58 px
    track under the fader's 80 px input, so the thumb sat on the "−1.9 dB" readout. With 4 instruments the track was
    102 px.
  - Today's Perform keeps 141 px at that size.
  - Fix: a `max-height: 760px` block with 6 px gaps, a 52 px song bar and tighter strip padding. The track is now 114 px
    with 7 instruments and 156 px with 4. 1280×800 is unchanged.
- **F4 (low) Update / Save as new were 36 px tall** (`.v6 .link`). The suite's 44 px check never saw them, because
  they only show while a scene is edited. Fix: 44 px minimum height and width.
- **Coverage, not a defect:** `settings.uiV6`'s store rules had no unit test. `ui-v6-store.test.mjs` now covers:
  - true or absent;
  - refused values;
  - device-local, not exported;
  - an import never turns it on, and a replace keeps this machine's value;
  - not an edit;
  - a no-op off write;
  - migrate.

## Fixes (files, commits on lane-u1)

- 565c37c `app/js/views/v6/strip.js`, `strips-row.js`, `styles-v6.css`: F1, F2. The test is ui-v6 "a Remove that
  shifts the slots…".
- 227acae `app/styles-v6.css`: F3. The test is ui-v6 "1024×700 with 4 and 7 instruments…", which fails at 58 px
  without the fix.
- e988aa4 `app/styles-v6.css`: F4. The ui-v6 snapshots test now asserts the size.
- 7c14aa6 `test/phase1/shell/ui-v6-store.test.mjs`: the store rules.
- This review, plus a skeptic note in CONTRACT_CHANGES "## UI v6 U1" and the build plan's U1 status.

I checked each new test against the unfixed code: F1/F2 and F3 fail there (F2 also reproduced in a probe).

## Open items (for Ryan)

- **O1 PANIC needs a 600 ms hold on screen.** This is a behaviour change from today's tap. It follows the mockup ("hold ·
  or Esc") and DESIGN_PHILOSOPHY ("dangerous ones hard to hit by accident"). Esc, ⌘. and Ctrl+. still panic at once.
  On an iPad with no keyboard, a hold is the only way. Ryan's call.
- **O2 Lock needs a hold to lock, too.** Today one press locks and only unlocking needs a hold. This also follows the
  mockup ("hold to lock").
- **O3 No switch in the Mac app.** The only ways in are `?ui6=1`, which works in the Chrome version on :8437, and
  `__rig.setUiV6(true)` from DevTools. For U9 on his Mac, Ryan needs a hidden toggle (a Settings row or a menu item)
  or the DevTools route. Each port keeps its own value (localStorage per origin).
- **O4 Revert baseline on a flag flip.** Switching v6 on or off mounts a fresh Perform, which takes a fresh Revert
  snapshot, so changes made before the flip are no longer counted. This only matters while the flag is being tried
  out. U9 removes it.
- **O5 16 instruments.** The pills shrink to 44 px "W…" stubs and the "16 instruments · scroll" hint is clipped. The
  colours still tell them apart, and tap-to-scroll works. A design pass could size or wrap them.
- **O6 Snapshot "+ Save" / Update stay live under Lock.** That matches today's Quick › Save as scene, but a saved
  scene is a library write. Decide whether Lock should freeze it.
- **O7 Small things.**
  - The Setlist popover closes on GO (any song switch closes the v6 popovers), so cueing the next song needs a reopen.
    The U3 sidebar replaces it.
  - The pills use `aria-pressed` to mean "on screen", which reads oddly to assistive technology; `aria-current` or no
    state would be clearer.
  - An empty strip still draws a dimmed fader thumb at gain 0, a little above the bottom (the relative fader shape).
- **O8 Not verified.**
  - No Electron/Mac suites, real MIDI or real touch.
  - No iPad sizes beyond 1024×700 and 1440×900 (U8).
  - Contrast only in Sanctuary, Sanctuary Day and Daylight Day (all 8 themes are U8).
  - No fader-drag cost under a real load (a rough check gave the same order as today).
