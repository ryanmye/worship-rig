# UI v6 U5a (the v6 Edit shell + instrument panel): skeptic review (2026-11-26)

Verdict: **VERIFIED, after fixes.** As delivered it was PARTIAL: three low layout / accessibility defects and one
low test gap. None touches playing, the store or the engine. Two items stay open for Ryan / U5b, and the rebase onto
lane-moveui needs four known changes (listed below).

Under review: commits 68aa246 and 593d115 on lane-u5, on top of v2-native 715b936. They add `views/v6/edit/edit.js`,
`views/v6/edit/instrument.js`, `styles-v6-edit.css` and the `ui-v6-edit` suite. They change `main.js`, add exports to
`views/edit/shell.js`, change one assertion in `ui-v6/left.tests.mjs` and update run-all and the docs. I didn't build
it. Another skeptic was reviewing lane-moveui on the same 2-CPU box, so I ran the suites one at a time.

These claims held:

- **Module boundaries.** `git diff 715b936` touches nothing in `engine/`, `shared/`, `store.js`, `controller.js`,
  `server.js`, today's `views/perform.js`, `views/components/`, `views/edit/panels/*`, or the v6 Perform files
  (`perform.js`, `strip.js`, `keyboard.js`, `sidebar/`, `left.js`). `views/edit/shell.js` gains one export line and
  nothing else. `v6/edit/` calls no engine method: it reads `listInstruments` through the core and passes the engine
  to `eqKeyboard`, as `slot.js` does.
- **main.js.** The boot mount reads the flag. `applyEditV6` destroys the mounted Edit and mounts the other one.
  `applyUiV6` resolves after both swaps (`Promise.all`). A flip that happens while the swap loads re-runs it. If the
  v6 Edit fails to import, today's Edit mounts instead. I flipped the flag with Set-lowest armed and the Change menu
  open, then played a note on today's Edit: nothing was written and no listener was left behind. I flipped it six
  times with Tone EQ open: store listeners stayed 14 → 14 and the element count stayed 2080 → 2080.
- **Flag-off purity** against 715b936 was identical in both full runs: 105 requests, 15 store listeners,
  4 intervals, 2529 elements (1047 in Edit), and the same CSS.
- **Paths and clamps.** I compared `instrument.js` with `edit/panels/slot.js` line by line, not only through the
  suite.
  - Sound: the same `smartSlidersFor` specs, shelf read through `readEq` and write through `shelfWrites`.
  - Range: note boxes go through `songField` + `parseKey`; Whole keyboard writes 0 / 127; Set by playing is the same
    one-shot, with the same 127 / 0 fix-up when the new end crosses the other.
  - Octave: stepper −2…2. Transpose: ±12. Voices: `mono`. Pitch bend: `bendEnabled`.
  - Touch: `velocityCurve` + `touch.shape|min|max|top` from the PARAMS rows.
  - Sustain: `slots.<i>.sustain`. Release writes null at the instrument's own value, else rounds to 0.01. Pedal hold
    writes null at "natural", else half-seconds below 10 s, capped at 30.
  - Sends: reverb / delay / chorus. Advanced: pan, width (skipped when it is a smart slider), params with
    "Reset these settings".
  - Change instrument: `defaultSlot` into an empty place, else `.instrument`, with the 8 s Undo.
    Remove: `slots.<i>` = null, with Undo.
  - Every path is today's. Mute, gain and the chips go through the v6 strip, with v6 Perform's writes and scene rule.
  - The suite's data-bind check only proves that v6 covers today's paths, not that it adds none. Reading the code, it
    adds none.
- **Tone EQ** is mounted when the category opens and destroyed when it closes. Over 15 Tone EQ ↔ Sound / Range
  switches, an instrument switch and back: created 18, destroyed 18, nothing left mounted, store listeners 14 → 14.
- **Switching instrument mid-drag on the Range keyboard** (mouse held on the low handle, `select('slot:1')`, move,
  release): neither instrument's range was written, because the base keyboard writes only on release. After the
  rebase this case changes (see R1).
- **Set lowest by playing, then another category / instrument**: disarmed, and a later note writes nothing. After
  leaving Edit with ⌘E (no pointer) the button stays armed and a note played on Perform writes nothing. Today's Edit
  behaves the same (its leave-view hook doesn't disarm either).
- **Undo.**
  - After Change instrument, Undo puts the old instrument and its params back.
  - After Remove, both the toast Undo and the empty pane's Undo work.
  - After a Remove followed by a Perform-style `removeSlot(0)` (the slots shift), the toast's Undo refuses ("That
    place has a sound again…") rather than overwriting another instrument. That is today's base behaviour. See R3
    for lane-moveui.
- **Empty instrument slots and 16 instruments.** An empty slot shows "Empty · choose a sound", the categories are
  disabled, and the strip is empty. Choose a sound fills it with `defaultSlot`.
  - At 16 instruments, + Add is disabled. The rig tabs scroll sideways inside their own row (2405 / 768 px at
    1024 px), the selected tab scrolls into view, and the page never scrolls.
- **Song switch from the library with Space & Echo open.** The new song's slot 2 was empty, so the pane showed Empty.
  The category is kept, and the tab count followed (4).
- **Remembered category.** I mounted with `bogus`, `null`, `[]`, unparsable JSON and `{"cat":"eq","lib":"x"}`. Each
  falls back to Sound (or keeps eq) and the library stays unfolded. A jump from a sentence word, or
  `focus: 'range'`, is not remembered.
- **Lock.** Edit is unreachable under Perform Lock: main.js sends `setView('edit')` back to Perform, and so does a
  `settings.view` write. The v6 Edit adds nothing to that. The strip it embeds renders `locked` the way Perform's
  does.
- **The hidden-strip choice.** With Perform showing, there is exactly one `v6-strip-0`: Edit drops its strip on leave
  and on any store event while hidden. With Edit showing there are two, because Perform's stays mounted while
  hidden. No app code queries strips document-wide, and the v6 Edit tests scope to `v6e-stage`. The choice is right.
- **The `left.tests.mjs` assertion change is legitimate.** With the flag on, Edit at 820 px is now the v6 Edit, which
  has its own portrait layout and `min-width: 0`. Today's Edit, with the flag off, still has 1024 px, and
  ui-v6-edit checks that.
- **iPad portrait 820 × 1180** has no sideways scroll. The categories form a row of tabs, the strip is hidden, and
  ☰ Songs opens the drawer, which Esc closes. **1180 × 820** has no sideways scroll in any category.
- **Chart** (with `__rig.setChartView(true)`) switches to Perform and presses the chart toggle there. **Song bank…**
  opens Settings with the bank section requested. Without packs it lands on the last category, the same as the
  v6 sidebar's entry (U3).
- **Zero console.error and no HTTP ≥ 400** in the suites and in every probe.

## Findings

- **F1 (low, a11y) The category list was a tablist in name only.**
  - The list had no `aria-orientation`, so a vertical list driven by ↑ / ↓ was announced as horizontal.
  - The tabs had no ids and no `aria-controls`, and the pane had an `aria-label` but was not labelled by its tab.
  - Fix (326fd92, `instrument.js`): per-mount ids. Each tab controls the pane, and the pane is
    `aria-labelledby` the chosen tab. `aria-orientation` is vertical, or horizontal at iPad portrait (the same media
    query as the CSS, so it needs no layout read).
  - Test: "skeptic U5a F1/F2" (fails on 593d115 at the aria check).
- **F2 (low, fit; D18 "always visible what is being edited") At 1024 × 700, Advanced was below the list's fold.**
  - The seven 46 px rows needed 349 px of a 308 px list, so a remembered Advanced mounted out of sight (scrollTop 0).
  - Fix (326fd92): tighter rows at `max-height: 760px` (40 px, all seven fit). The list also scrolls the chosen row
    into view on a category change, on mount and when Edit shows again. It scrolls only the list, never the page, and
    not on every store event.
  - Test: the same check. Advanced is remembered across a remount at 1024 × 700, and all rows are in sight.
- **F3 (low, fit) Tone EQ scrolled sideways at 1024 × 700.**
  - The eqKeyboard is laid out for today's full-width Advanced. In the ~400 px pane its A / B toggle ran 86 px past
    the edge and the 500 px band table ran 115 px past it, both clipped.
  - The builder's "nothing scrolls sideways at 1280 or 1024" check only ran with Range open.
  - Fix (e599b69, `styles-v6-edit.css`, ≤ 1250 px): the eqKeyboard head wraps, its lower grid stacks, and only the
    band table scrolls.
  - **The eqKeyboard's summary line is hidden in the v6 Edit.** It read "**Keys** plays Grand Piano from A0 to C8",
    a role word (D15; the builder's open item). The pane's line above it already gives the EQ's state.
  - Test: the sideways check now runs all seven categories at 1280 and 1024, and asserts that the summary is not
    shown.
- **F4 (low, layout) The library's setlist head overlapped itself.**
  - Today's head is "Setlist" + "+ Setlist" · Rename · Delete in nowrap text. In the 200 px column (1024 px) the
    buttons shrank below their text, which overlapped ("+ SetliRenamDelete"). At 244 px (1280) the text ran 2–4 px
    past the boxes.
  - Fix (28e5419): in the v6 Edit the caption takes its own line above the three buttons.
  - Test: "skeptic U5a F4" (all three clipped on the previous CSS).

Open for Ryan / U5b (not defects of the brief):

- **O1: the categories' dots follow today's rule.** Sound, Tone EQ, Touch and Advanced never get a dot (the
  builder's note), while the mockup shows one on Tone EQ.
- **O2: the strip is hidden at iPad portrait** (as in the mockup), so nothing in Edit can mute or unmute there or
  set the level. The sentence's "off" word jumps to the hidden strip's ON tile and does nothing.
- **O3: a11y nit.** The rig tabs' `tablist` also holds the "+ Add" button and a separator, which are not tabs.
- **O4: copy.** Touch › Feel shows a number ("0.50") where today's shows a word (`touchWord`).
- **O5: 16 instruments.** The rig row scrolls with no sign that more tabs sit to the right (Drone / Effects / Master
  are off-screen when the last instrument is selected).
- **O6: Song bank…** shows even without patch packs and then lands on Settings' last category (same as U3's entry).
- **O7: the top bar at 820 px.** The MIDI and Sound status overlap. That comes from U4's `min-width: 0`, not U5a.
  It shows behind the v6 Edit and the v6 Perform alike.

## Rebase onto lane-moveui (for the coordinator)

I read `git -C /home/claude/wt-moveui diff 715b936` for `v6/strip.js`, `v6/keyboard.js`, `edit/shell.js` and
`edit/panels/slot.js`. Textually only the docs conflict: CONTRACT_CHANGES and the build plan both append. moveui
leaves `main.js` alone. `shell.js` gains lines at ~1088 while U5a appends at the end. The `slot.js` exports that U5a
imports (`groupOf`, `groupOrder`, `parseKey`, `TOUCH_LABELS`) are unchanged. The behaviour needs four changes:

- **R1 `keyboard.js` live range writes (D24.2).**
  - `onRange` now gets `(i, field, note, phase, expect)`, with phase `live` / `end` / `key` / `cancel`. `liveWrite`
    isn't gated by size, so Edit › Range writes during a drag too. That is D24.2's intent.
  - (a) ui-v6-edit "Range: … (one end, one write)" asserts exactly `['slots.0.lowNote']` and will see several
    writes. Assert "only `slots.0.lowNote`, final value 48" instead.
  - (b) `instrument.js` `update()` sets `i = ni` before `buildPane() → destroyPane() → kb.cancelDrag()`. The
    `cancel` restore for the old slot then fails the `k !== i` guard and is refused. Switching instrument mid-drag
    would leave the live-written partial range on the old instrument.
  - Fix for (b): cancel the drag (`pane?.ctl.kb?.cancelDrag()`) before changing `i`, and honour `expect` (write the
    start value back only while the slot still holds `expect`).
  - Also re-check that a song switch mid-drag restores into the old song. `onLeaveSong` runs before the core moves
    to the next song id.
- **R2 `strip.js`.**
  - The name (`.v6-who`) is now always `role=button` with `tabindex 0` and the title "Click to change which keys
    play this instrument". It calls `v.pickRange`, which Edit's `stripV` lacks, so in Edit it is a focusable button
    that does nothing. Give `stripV` `pickRange: (k) => editState.select(\`slot:${k}\`, {focus: 'range'})`, or
    strip the role in Edit.
  - The new ⠿ grip (`.v6-grip`, shown at n ≥ 2 and unlocked) would show on Edit's strip with no `strips-row` drag
    behind it. Hide it under `.v6e-stage`.
  - (⋯ Earlier / Later sit in the hidden `.v6-btns`. `v.focusMore` is optional-chained. `stripV.moveSlot` exists.)
- **R3 `shell.js` / `slot.js` slot-move following (346d332).**
  - moveui's `store.onSlotMap` handler, which keeps the selected `slot:<i>` on its instrument, lives in `mountEdit`,
    not in `createCore`. `mountEditV6` doesn't get it, so port it.
  - Likewise `slot.js` `followSlot` for the 8 s Undo records (and the `u.i < 0` branches). `instrument.js` has its
    own copies of `pickInstrument` / `doRemove` / `doUndo` / `undoInstrument`.
  - On 715b936 both Edits are positional and the Undo refuses safely (measured above). After the rebase, today's Edit
    follows a move and the v6 Edit would not.
- **R4 checks to re-run after the rebase:** ui-v6-edit (R1a will fail as written), ui-v6 including move.tests,
  edit-v2 and settings. Add one probe: a range drag in Edit, then `select('slot:1')` mid-drag, and slot 0's range must
  come back.

## Gate

The box had 2 CPUs, shared with the lane-moveui skeptic (load average 2–6). I ran the suites one at a time at
28e5419.

| suite | result |
|---|---|
| ui-v6-edit (`test/phase2/ui-v6-edit/run.mjs`) | **16/16** as delivered (593d115); **18/18** at 28e5419 (+ F1/F2 and F4 checks; F3 widened the sideways check). Each new check fails on the code before its fix |
| edit-v2 (`test/phase2/edit-v2/run.mjs`) | **14/14** files, 117/117 tests |
| ui-v6 (`test/phase2/ui-v6/run.mjs`) | **54/54** |
| settings (`test/phase2/settings/run.mjs`) | **94/94** (app, fixture, mac, bridge) |
| flag-off purity vs 715b936 (in ui-v6 and ui-v6-edit) | identical (105 requests, 15 store listeners, 4 intervals, 2529 elements, 1047 in Edit) |

Not verified: the Mac app and WKWebView (Chromium only); a real MIDI keyboard (notes came through
`controller.perform`); touch input on the Range keyboard; the Daylight theme; screen-reader output (I checked the
ARIA attributes only); behaviour after the rebase onto lane-moveui (R1–R3 come from reading the diff).

## After the rebase (focused pass)

Scope: lane-u5 rebased onto v2-native acfa900 (move instruments + live range writes, UI6-move.md), plus 6f671a4
(R1–R3). Earlier U5a findings are not re-reviewed. Probes ran on the 2-CPU box with lane-u6's suites running (load
1.3–2.8).

**Verdict: VERIFIED after F1 and F2.** R1–R3 hold. One defect (F1, Esc) and one drift risk (F2) are fixed. One perf
note (P1) and one unreachable case (O8) stay open.

What I checked, beyond the builder's tests:

- **Every cancel path of an Edit range drag restores the start value on its own instrument**, probed with a held mouse
  button after at least one live write:
  - Pointercancel, leaving Edit (`setView`), and a flag flip mid-drag (`setUiV6(false)`, so the v6 Edit unmounts).
  - A song switch where the next song's instrument 1 is the same instrument, so the pane is not rebuilt and the same
    `dragSong` closure survives. The old song is restored and the next one is untouched.
  - A move of another instrument that shifts ours (2 → 0, ours 0 → 1). The restore lands at 1 and the tab follows.
  - The dragged instrument removed mid-drag: nothing is written onto the one that takes index 0.
- **Learned knob mid-drag.** `slots.0.gain` was written every 20 ms during the drag. Both commit and cancel came out
  right. Range fields cannot be learned (`isLearnablePath` rejects step-1 rows), so a knob can't fight the drag over
  `lowNote` or `highNote`.
- **The microtask window on a slot map.** Live writes come only from pointermove tasks and the trailing
  `setTimeout`, never between the store's synchronous `onSlotMap` and its microtasks. A pointermove dispatched in the
  same task as `moveSlot` is refused (`k !== i`). The only write is the restore, onto the moved instrument (tested).
  Strip fader `cancelDrag()` inside the store's call writes nothing (`fader.js` only drops the emitter), so it is safe.
- **`dragSong` after a commit with no 'end' write** keeps the old id. That is harmless: every successful live write
  resets it, and a cancel needs one.
- **followSlot.** Both Undos register it after their write. The `u.i < 0` branches match slot.js. Change → remove →
  Undo refuses (R3 test).
- **R2 semantics.**
  - The name is `role=button` with `tabindex 0`. Its accessible name is the instrument's name (the icon is
    `aria-hidden`), and the title is its description. Enter and Space work. There is no `aria-pressed`.
  - `setCoarse` and `setPicked` would put Perform's title and pressed state back, but only Perform's strips-row calls
    them, never Edit's strip.
  - Focus moves into the Range pane.
- **Lock while Edit shows.** See O8.
- **Throttle at 6× CPU** (CDP). The ≤ 1 per 50 ms rule holds: 24 writes in a 30–40 step sweep, minimum gap 123 ms,
  because pointer delivery itself slows. The final value is right, and a cancel under throttle restores. See P1 for
  the cost.

Findings:

- **F1 (low, fixed in 8b3e9a4) An Esc during an Edit range drag did nothing to the drag.**
  - The drag kept writing live and committed on release. The Esc went to the panel's other handlers (confirm, menu,
    Set-by-playing).
  - The v6 Perform's pick Esc already cancels mid-drag (UI6-move F2). In Edit, Esc never panics.
  - Fix: the instrument panel's `onEscape` cancels a drag in progress first, which puts the start value back.
  - Test: ui-v6-edit "skeptic after the rebase F1" (Esc, pointercancel, same-task move + pointermove, removed
    instrument). It fails at the Esc check on 6f671a4.
- **F2 (drift risk, fixed in f81a8ba) mountEditV6 had a verbatim copy of mountEdit's `onSlotMap` tab-follow handler.**
  - Fix: one function, shell.js `followSelectedSlot` (exported as `editFollowSelectedSlot`), used by both. The
    subscription is the same, and a store without `onSlotMap` gets a no-op cleanup.
  - Covered by ui-v6-edit R3, ui-v6 "U-MOVE Edit" (flag on and off), edit-v2, and flag-off purity vs acfa900.
- **P1 (open, perf) A live range write costs about 3× more in Edit than in the v6 Perform.**
  - Measured at 6× throttle, 4 instruments, samples loaded, 30 writes each followed by a task turn:

    | View | Median | p95 | Long tasks in a drag |
    |---|---|---|---|
    | Edit | 40–42 ms | 59–72 ms | 6 (≤ 77 ms) |
    | v6 Perform | 13.6 ms | 28.5 ms | 0 |

  - A hand-like sweep with live writes took 1.9 s, against 1.1 s with the writes refused. The first, cold sweep took
    6.0 s.
  - The largest single cost is the 'range' size's always-shown label. `showTip` reads `offsetWidth` / `clientWidth`
    after the render's DOM writes, which forces a reflow: about 10 ms per write at 6×. The Edit core's fan-out is about
    17 ms, and the hidden v6 Perform's re-render adds more.
  - `renderKb` runs twice per event, once from its binder and once from the panel's catch-all subscribe. I tried a
    memo to skip the second run. It changed nothing measurable (42 → 40 ms), so I reverted it.
  - At 1× this is about 7 ms per write, ≤ 14 % of a CPU at 20 writes per second, so it is not a defect on the Mac.
  - Suggestion for U5b or polish: measure the tip in a rAF (keyboard.js, shared with Perform).
- **O8 (open, not reachable) Lock coming on while Edit shows.**
  - Lock is set only by the two Perform Lock buttons. There is no hotkey or menu item, and main.js bounces only a
    view *change* into Edit.
  - Through a store write, Edit stays open and the drag goes on and commits: Edit's range keyboard passes
    `locked:false`. Today's Edit behaves the same, so this is not a U5a change.
- A move of a *different* instrument also ends the user's drag (with its restore), as on the v6 Perform. That is
  intended.

Gates (lane-u5 at f81a8ba, one suite at a time):

| Suite | Result |
|---|---|
| ui-v6-edit (`UI6_PURITY_BASE=acfa900`) | 22/22 (flag-off purity vs acfa900: pass) |
| ui-v6 | 68/68 |
| edit-v2 | 14/14 files, 117/117 tests |
| console.error / HTTP ≥ 400 | 0 in every suite and probe |

I did not run these:
- Settings (no settings code touched).
- A real touch device or iPad.
- Electron on the Mac.
- An actual screen reader (DOM semantics only).
