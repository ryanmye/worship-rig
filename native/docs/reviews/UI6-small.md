# UI v6 small tasks (U-METRO, D24.7 Esc setting, U1 O3 preview switch): skeptic review (2026-11-26)

Verdict: **VERIFIED, after fixes.** As delivered and rebased the work was PARTIAL. I found four low defects and
fixed all of them:

- With "Esc always panics" on, an Esc typed into a modal dialog on Perform panicked.
- The Click module's held − / + kept stepping after the window lost focus.
- At 1024 × 700, "Preparing n of m" pushed the sidebar's module down 50 px.
- A v6 flip dropped the Revert baseline (U1 O4). The Settings switch made this a player action.

No finding touches the engine. Under normal playing, none of them loses sound or an edit.

Under review: three commits on lane-small, built on 4c75351 and rebased by the coordinator onto v2-native b163c20
(U1–U4 plus the slot-move store API, skeptic-VERIFIED; only CONTRACT_CHANGES conflicted). I didn't build them.

- f5125c9 U-METRO: `v6/sidebar/metronome.js`, plus the load state in `sidebar.js` and `styles-v6-sidebar.css`.
- c3f8ca3 D24.7: `settings.escPanics`, `main.js` `escPanicKey`, and the Settings row.
- bee755a U1 O3: the Settings › Look row, and `onSettings` → `applyUiV6`.

These claims held:

- **The rebase.** The Click module imports `tapBpm` from `components/quickSheet.js`. On b163c20 that is the sheet
  the U4 left panel opens, unchanged.
  - Tap from the module and Tap in the Quick sheet each keep their own run of taps. Each run writes
    `songs.<id>.tempo` with the same rule (> 2 s starts over, the last ≤ 4 taps, 30–300, rounded).
  - Taps don't combine across the two: 2 in the sheet plus 2 in the module don't make a 4-tap run. That's harmless.
  - Nothing in `left.js`, `quickSheet.js`, `engine/`, `shared/`, `controller.js` or `views/components/` changed
    (`git diff b163c20 --stat`).
  - The store change is the `escPanics` row only (store.js + `esc-panics-store.test.mjs`).
- **Click module = today's chip, path by path:**
  - The tile calls `controller.toggleClick()`, which starts with `settings.click`'s count-in and quiet-after, or
    stops. Its state follows `status.click` (on / counting).
  - A panic turns it off (aria-pressed false), and the tab dot and the rail's accent border follow it.
  - With no tempo, the tile is disabled ("no tempo") where today's chip hides. The controller's `available` agrees
    (false).
  - − / + and Tap clamp to the store's 30–300. A stored 99.6 (from an import) shows as 100 and steps from 100, as
    the Quick sheet's number would.
  - Lock leaves the tile, − / + and Tap live and disables Count-in & level….
- **Esc setting, every overlay type, setting on.** One Esc gave one panic and closed the overlay in each case:
  - sidebar ⋯ customize;
  - a strip's ⋯ menu;
  - Sing it in;
  - the Quick sheet (today's and v6);
  - the range pick (coarse context at 1180 × 820);
  - a focused control.
  - Lock on: Esc still panics. Held Esc (auto-repeat): one panic.
  - Edit and Settings keep their Esc. Turning the setting on inside an open Settings and pressing Esc closes Settings
    without a panic: the `escClosedSettings` mark works for both listener orders.
  - MIDI learn lives in Edit only (`learn-menu.js`), so it never meets `escPanicKey`.
  - With the setting absent, no listener is added. The window keydown counts match the base in the purity probe.
- **Preview switch.**
  - Six rapid store writes (on / off) end in the last state, with one Perform in `#view-perform`.
  - A flip with a v6 popover open leaves no `.v6` node, and the next Esc panics: no stale overlay eats it.
  - The Settings button is disabled under Lock, and Lock closes Settings, so the row can't be reached while locked.
- **Load state.**
  - The 500 ms re-count runs only while "Preparing" shows, and stops when ready.
  - After flag off, only main.js's own poll is left.
  - A secondary window shows nothing.
  - The rail spinner shows while the sidebar is folded.
- **Flag-off purity and the two excluded rows.** The probe now leaves out `setting-row-esc-panics` and
  `setting-row-ui-v6`. That is legitimate, because both rows are meant to exist with the flag off: D24.7 asks for the
  row in Settings, and U1 O3 asks for a visible switch. I checked that nothing else hides behind the exclusion. I
  diffed every element of the flag-off app against b163c20 as a multiset, with no exclusion: **exactly 16 elements
  differ, all inside those two rows** (each row: 1 row div, 2 divs, 4 spans, 1 toggle button).
  - Requests, window / document listeners, intervals, store listeners and stylesheets are identical (105 / 15 / 4).
  - So "flag-off purity" now means today's app plus two Settings rows, and nothing else.
  - The exclusion matches by row testid only. A third row would need its own entry, and it couldn't hide anything
    outside those rows.
- **Header with four tabs.**
  - At 1280 × 800 (a 258 px sidebar), the tabs get their own row (71 / 62 / 60 / 54 px, none under 44) and the header
    doesn't overflow.
  - At 1024 × 700 (220 px), the tabs are 53 / 45 / 44 / 44 px.
  - The page doesn't scroll at either size.
- **Leaks.** The ui-v6 on / off cycles (store listeners back to boot's) pass with the Click module in the registry.
  The module's window `blur` listener (F2) is released with it.
- Zero console.error and no HTTP ≥ 400, in the suites and in every probe.

## Findings

- **F1 (low) "Esc always panics" panicked in a modal dialog on Perform while typing.**
  - The chart view (D7, hidden) mounts on Perform. Its Add chart dialog is a `role=dialog aria-modal` with a
    textarea.
  - With the setting on, an Esc typed there panicked (measured: 1 panic) and cancelled the paste: all notes off,
    pedal up, click stopped.
  - Today's hotkeys skip text fields (controller `isTextControl`), and main.js never panics with a dialog open.
    D24.7 lists "a pick, popover or sheet". A modal and typing are not on that list.
  - Fix (8c0727f, `main.js` `escTyping` / `escModalOpen`):
    - `escPanicKey` stands down for a text field (the key's target first, as the controller's `keyEl`), an IME
      composition (`isComposing`), and a visible modal dialog / alertdialog on Perform. Today's rule then runs.
    - Ranges (faders, wheel) are still "focused controls", and they panic.
    - The hint text says so (93f961f).
  - Test: ui-v6 D24.7 checks Add chart typed into, a text field and an IME Esc. It fails on bee755a.
- **F2 (low) A held − / + kept stepping after the window lost focus.**
  - Mouse down on +, then a window blur (⌘-Tab sends no pointerup): +9 to +10 BPM in 1.2 s, on to 300 or the next
    pointer event on the button.
  - Also, a press slid off the button left `pressed` set, so the next Enter on it did nothing (measured: 101 → 101).
  - Fix (d891c14, `metronome.js`):
    - Window blur and a song change stop every repeat.
    - The click handler steps only for detail-0 clicks (keyboard / assistive tech). A pointer press already stepped
      on pointerdown.
  - Test: U-METRO Click (blur mid-hold; slide off, then Enter). It fails on bee755a.
- **F3 (low) "Preparing n of m" moved the module at 1024 × 700.**
  - In a sidebar under ~270 px, the line's text width (150 px) plus ⋯ and ⟩ didn't fit one row. ⟩ wrapped onto a
    third header row and the module moved down 50 px while the set loaded, putting Count-in & level… below the fold
    at 1024 × 700.
  - The builder's "the module never moves" held at 280 px only.
  - Also, the base `.v6-sb-load` rule came after the container queries and overrode the < 240 px rule (same
    specificity) for a three-tab sidebar.
  - Fix (1a6d844, CSS): the line takes the room left (flex-basis 0) and wraps onto two short lines inside the 44 px
    row. The base rule moved above the queries.
  - Test: U-METRO load state at 1024 × 700 and with a 250 px sidebar. It fails on bee755a.
- **F4 (low; UI6-U1 O4, now reachable from Settings) A v6 flip dropped the Revert baseline.**
  - Each flip mounted a fresh Perform, and the fresh Perform took the current song, unsaved changes included, as the
    baseline. Revert and Edit's changed dots then forgot those changes.
  - Measured: reverb return 1 → 0.123, flip, baseline 0.123, `changedPaths` [].
  - Fix (49d7323): `main.js` `swapPerform` hands the old view's `savedSnapshot` to the new one
    (`ctx.carrySnapshot`, set only during the mount), and both `perform.js` and `v6/perform.js` adopt it. Boot is
    unchanged.
  - Test: "skeptic UI6-small F4" flips today → v6 → today. It fails on bee755a.

These are acceptable or not defects:

- **A second (muted) window doesn't follow a flip until it reloads.** That is true of every setting in a secondary
  window (it doesn't re-read the library live). It isn't new.
- **"Preparing n of m" shows twice** with v6 on: in the top bar and in the sidebar. D23.3 asked for the sidebar
  line. The top bar's line goes when v6 replaces the top bar.
- **No tempo: the tile is disabled; today's chip is hidden.** That's a module design choice, and it's labelled
  "no tempo".
- **PANIC still reads "hold · or Esc".** That is U-MOVE (D23.1), not these tasks.

## Gate

The box had 2 CPUs, shared with lane-moveui's suites (load average 3–8). I ran the suites one at a time.

| suite | result |
|---|---|
| ui-v6 (`test/phase2/ui-v6/run.mjs`) | **53/53** as rebased (bee755a; the builder's "44/44" isn't this suite's count on b163c20). Each new check fails on bee755a: a 3/7 `UI6_ONLY` run. **54/54** at 49d7323 |
| flag-off purity vs b163c20 (in ui-v6) | identical (105 requests, 15 store listeners, 4 intervals, 2529 elements), with the two rows excluded. Without the exclusion: exactly those rows' 16 elements |
| settings (`test/phase2/settings/run.mjs`) | **94/94** at 49d7323, and again after the hint text (93f961f) |
| ui-core (`test/phase2/ui-core/run.mjs`) | **78/78** at 49d7323 |
| shell unit (`test/phase1/shell/run.mjs --only unit`) | **357/357** at 49d7323 |
| console.error / HTTP ≥ 400 | 0 |
| `run-all --fast`, Electron / Mac suites, real iPad | not run |

## Fixes (commits on lane-small)

- 8c0727f `main.js` and the D24.7 check: F1. 93f961f: the Settings hint.
- d891c14 `v6/sidebar/metronome.js` and the U-METRO Click check: F2.
- 1a6d844 `styles-v6-sidebar.css` and the U-METRO load-state check: F3.
- 49d7323 `main.js` `swapPerform`, `perform.js`, `v6/perform.js` and the check "skeptic UI6-small F4": F4.
- This review, a skeptic note in the three CONTRACT_CHANGES sections, and the build plan's status.

## Open items (for Ryan / the orchestrator)

- **O1 (tier 2) The Esc rule with the setting on.** F1 is my reading of D24.7:
  - Esc panics with a pick, popover or sheet open.
  - Esc doesn't panic while typing in a box or with a modal dialog open on Perform; today the only one is the hidden
    chart view's Add chart.
  - If Ryan wants "every Esc", drop `escModalOpen()` from `escPanicKey`, but keep the IME check.
- **O2 Not verified:**
  - a real IME composition Esc and a real ⌘-Tab mid-hold (both checked with synthetic events);
  - VoiceOver's activation of − / + (expected: a detail-0 click);
  - touch hold-repeat on a real iPad;
  - the Electron / Mac app (the preview row there);
  - themes beyond Sanctuary.
