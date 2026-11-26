# UI v6 build plan (D16–D22)

Ryan, 2026-11-26: build the new UI now, iterate on finishing touches before he is back on his Mac, then release 2.0
(D19, D22). The designs are the HTML mockups in `native/docs/design/mockups/` (open them in a browser; the tabs at
the top switch frames). They are the spec for layout and behaviour, not code to copy.

## Ground rules

- **Behind a flag until Ryan flips it.** `settings.uiV6` is `true` or absent, exactly like `settings.chartView`
  (store.js validation, main.js `?ui6=1` / `__rig.setUiV6(on)` hooks). Flag off = byte-for-byte today's app: no new
  requests, listeners, DOM or CSS (the chart-view review's "flag-off purity" probe is the test to copy). Flag on =
  the v6 Perform (and later Edit / Settings) replace today's views.
- **Module boundaries (CLAUDE.md):** views call `store.set` and `controller.*` only; `shared/` stays pure.
  New code lives in `app/js/views/v6/` (one file per module, like `views/edit/panels/`), CSS in
  `app/styles-v6.css` + one file per module, every selector under `.v6`. Linked only while the flag is on.
- **One module, used everywhere (D15).** The strip, the Drone module, the keyboard with range bars are each one
  component with a size option; Perform, Edit and the iPad layouts mount the same component.
- **Equal instruments (D15).** No Keys / Pad / Extra / Bass labels anywhere but the instrument chooser. Colours by
  position: `--slot-0`… (extend to 16 with the mockup's POS_COL after the first 4).
- Engine untouched (golden oracle). Zero console.error, no 404s. Every task: builder, then a separate skeptic;
  gates = the affected UI suites + `node test/run-all.mjs --fast` + flag-off purity probe.

## Tasks (in order; ≤ 2 heavy agents at once)

| id | task | mockup | depends |
|---|---|---|---|
| U1 | Flag + v6 Perform shell: top bar (reuse), song bar (name, key + "you play", transpose, Space picker, snapshot chip, chord, Notes, Setlist), snapshots row (fold ⌃ / chip ▾), board (left panel slot, strips, right sidebar slot), bottom row (keyboard slot, Revert, Fade out, PANIC, Lock). The **strip** component: name, ON tile, vertical fader + meter, dB, Space / Echo / Octave / Sustain 2×2, Change, ⋯ (Earlier, Later, Duplicate, Open in Edit, Remove-hold). Add instrument. > 5 instruments scroll at the 5-across width with the name-pill minimap. | perform-v6.html | — |
| U2 | Bottom keyboard component: today's keys + one range bar per instrument with drag handles (snap to keys, label while dragging), iPad pick-then-drag mode (tap a strip first; outline + "changing range"; others dim). Edit › Range variant: 88 keys, one bar, keys outside dimmed. | perform-v6 "Drag a colour…", "iPad · pick…"; edit "Instrument · Range" | U1 for mounting; component can be built first |
| U3 | Right sidebar: one module at a time as tabs, collapse to icon rail (⟩ / ⟨), resizable by dragging its left edge (200 px … 62 % of the stage, fold below 200), ⋯ customize (show/hide, reorder, starts open/collapsed), saved per device. Modules: Drone (today's key grid, Synth / My Pads, Major/Minor, Level / Bright / Move, Sustain, Keep across songs), Setlist (cue then Go, + Add song menu), Notes. | perform-v6 sidebar tabs | U1 |
| U4 | Left panel: Quick button (today's quickSheet opening over the strips) + today's wheel column (wheel, target, Swell, pedal). | perform-v6 "Left · Quick open" | U1 |
| U5 | Edit v6: library (foldable), song header, rig tabs by instrument name + Drone / Effects / Master, per-panel category list with current-state summaries and changed dots (D18), Instrument chooser dialog, Tone EQ (existing eqKeyboard), Effects sends table. | edit.html | U1, U2 |
| U6 | Settings v6: category list with state summaries, search, MIDI Learn and Perform layout categories, Song bank entry, theme previews (D21). | settings.html | U3 (layout prefs) |
| U7 | Chart placement (stage with mini faders, or sidebar tab; per device), text size in % (D16 notes), Song bank browser over the stage with Try it (replaces; banner Keep / Add to setlist / Back) (D17), small dialogs: MIDI Learn mode on Perform, Arrange, Save snapshot, Song menu, Edit chart. | chart.html, song-bank.html, dialogs.html | U3 |
| U8 | iPad layouts (landscape = Mac; portrait stacks), edge states (loading, MIDI off, audio stalled, first run, Lock), all 8 themes incl. the two day themes (contrast audit via tools/themes/shoot.mjs). Menu bar popover unchanged. | all | U1–U7 |
| U9 | Ryan's review on his Mac, finishing touches, then flip the default and retire the old views (tier 1: Ryan says when). | — | U8 |

## U1 status (builder, 2026-11-26; lane-u1; skeptic pass done, see below)

- **Skeptic (2026-11-26): PARTIAL as delivered, VERIFIED after fixes.** The review is
  `native/docs/reviews/UI6-U1.md`. It fixed four defects: stale values on empty strips, menus outliving a slot
  shift, a 58 px fader at 1024 × 700 and 36 px snapshot links. It added a uiV6 store unit test, and the ui-v6 suite
  is now 16/16. Open for Ryan: PANIC and Lock now need a hold, and there is no Mac-app switch yet (O1–O3).
- Built: `settings.uiV6` + `?ui6=1` / `__rig.setUiV6`; `app/js/views/v6/` (`perform.js` shell, `songbar.js`,
  `snapshots.js`, `strips-row.js`, `strip.js`, `bottom.js`, `lib.js`) and `app/styles-v6.css`; suite
  `test/phase2/ui-v6/run.mjs` (in run-all). Interface notes: CONTRACT_CHANGES "## UI v6 U1".
- Wired: every strip control (today's calls), Change / Open in Edit (Edit's picker), Duplicate (appends at the end),
  Remove (hold), Add instrument, > 5 scroll + name pills, snapshots (today's scenes) with Update / Save as new and the
  fold, song bar (key / Sing it in, "you play", transpose, Space room, chord, Notes, Setlist cue + GO), today's
  keyboard with range bars, Revert / Fade out / PANIC / Lock, the top-bar Quick sheet.
- Placeholders: the left panel (U4) and the right sidebar (U3) are empty dashed columns, so the drone, wheel and
  setlist modules are not on the v6 stage yet. ⋯ Earlier / Later are disabled ("Coming"): no store slot move.
- For U2: `bottom.js` holds the keyboard; replace its display-only range bars. For U3 / U4: mount into
  `.v6-right` / `.v6-left` (perform.js `right` / `left`).

## U2 status (builder, 2026-11-26; lane-u2 from lane-u1 6623b04, rebased onto 2fff370; skeptic pass done)

- **Skeptic (2026-11-26): PARTIAL as delivered, VERIFIED after fixes.** The review is
  `native/docs/reviews/UI6-U2.md`. Fixed: the purity check failing after the rebase (25/26), the iPad test's flake
  (a real Chromium tap-suppression miss on the strip names), a drag writing the wrong slot after a Remove, a drag
  writing "every key" when the view hid, one-key ranges moving the wrong way, and a second finger on the keys
  cancelling a drag. ui-v6 is 27/27. Open for Ryan: the four builder choices below, Esc in pick mode (O-items).

- Built: `app/js/views/v6/keyboard.js` (`rangeKeyboard`, sizes 'perform' and 'range'), `app/styles-v6-keyboard.css`
  (imported by styles-v6.css); bottom.js now mounts it; strips get the iPad pick outline ("changing range"); harness
  `test/phase2/ui-v6/keyboard-harness.html`. Interface notes: CONTRACT_CHANGES "## UI v6 U2".
- Wired: drag either end (fine pointers: always; coarse: pick an instrument first), snaps to every key, label while
  dragging, writes `slots.<i>.lowNote` / `highNote` once on release; ←/→ / Shift on a focused handle; clipped ends
  kept; past the edge = 0 / 127; Lock freezes it; a range edit counts in Revert and dots its bar (v6 only).
- Choices to confirm with Ryan: write on release (not live while dragging); strict lowest < highest; the finishing
  tap on the keys plays no note; past the keyboard edge = "every key that way".
- For U5: mount `` rangeKeyboard({size: 'range', onRange: (i, f, n) => ctx.set(`slots.${i}.${f}`, n)}) `` and render
  one bar `{i, name, color: slotColor(i), lo, hi, changed}`; the Range category's dot needs the same range paths as
  `V6_DIFF_WATCH`.

## Queued small tasks

- **U5b (orchestrator tier 2 answers to the U5a builder's questions):** every Edit category dot means "changed
  since the song began" (compare against the baseline for all of the category's paths, so Sound / Tone EQ / Touch /
  Advanced dot too, as the mockup shows); v6 Edit uses the v6 Perform bottom row (range bars + Revert / Fade out /
  PANIC / Lock), as the mockup; the Edit strip keeps its Change / ⋯ row hidden (mockup). Plus Drone / Effects /
  Master category panels and the instrument chooser (D18, mockup edit.html).

- **U-MOVE (D23):** store `insertSlot(after)` / `moveSlot(from, to)` (carry scenes, wheel targets, instrument
  fields; MIDI learn stays positional), v6 Duplicate next to the original, ⋯ Earlier / Later, drag-to-reorder strips
  (and in Edit's rig tabs later); PANIC and Lock back to a tap.
- **U-TWEAKS (D24):** live throttled range writes during a drag; pick-first mode on all pointers; drone Bright /
  Move percentages.
- ~~**Esc setting (D24.7):**~~ **Done (lane-small; skeptic VERIFIED after fixes, reviews/UI6-small.md):** Settings › Keyboards & MIDI ›
  "Esc always panics" (`settings.escPanics`, per device, absent = off). On: Esc on Perform (today's and v6) panics at
  once and the open overlay still closes. CONTRACT_CHANGES "## Esc always panics (D24.7)".
- **Small-window fit (UI6-U3 O1, orchestrator tier 2):** at ≤ 1100 px wide the sidebar starts folded unless the
  player opened it there before; the Add tile goes slim from 4 instruments (not 5). Goal: 4 strips at 1024×700
  without sideways scroll.
- ~~**U-METRO (D23):**~~ **Done (lane-small; skeptic VERIFIED after fixes, reviews/UI6-small.md):** sidebar module "Click" (today's chip:
  on / off with the count-in, tempo − / + / Tap, setup read only, Count-in & level… → Edit › Song) + "Loading…" /
  "Preparing n of m" in the sidebar header and a spinner on the rail. CONTRACT_CHANGES "## UI v6 U-METRO".

- ~~**Preview switch for Ryan (U1 review O3):**~~ **Done (lane-small; skeptic VERIFIED after fixes, reviews/UI6-small.md):** Settings › Look ›
  Perform view › "Try the new layout (preview)", swaps Perform live (Chrome and the Mac app). CONTRACT_CHANGES
  "## UI v6 preview switch in Settings". Original note: `?ui6=1` only works in Chrome; the Mac app needs a visible way to turn
  v6 on for the U9 review. Add "Try the new layout (preview)" in Settings (today's Settings, Look or Mac category),
  writing `settings.uiV6`. Before U8 ends.
- Pre-existing red suites to fix separately: eq "L-21 note labels fit" (fails on base), engine suite's 404 on
  `/__tests/api/health` and the CPU-timing `offline.eqCpu` on the 2-CPU box.

## U3 status (builder, 2026-11-26; lane-u3 from lane-u2 f4d70a7, rebased onto 7f1b128; skeptic pass done)

- **Skeptic (2026-11-26): VERIFIED after fixes** (two low defects, one test race). The review is
  `native/docs/reviews/UI6-U3.md`. Fixed: keyboard focus lost when ⟩ / ⟨ / a rail icon hid themselves (F1), the drone
  forgetting My Pads across a tab switch (F2), and a same-frame pills assertion in the U1 check that raced U3's
  overflow pills (F3). ui-v6 is 40/40, ui-core 78/78, settings 90/90. Open for Ryan / U4 / U8: at 1024 px the open
  sidebar (≥ 200 px, D16) makes a 4-instrument song scroll and the pills take ~40 px off the faders (O1).

- Built: `app/js/views/v6/sidebar/` (`sidebar.js` container, `modules.js` registry, `drone.js`, `setlist.js`,
  `notes.js`) and `app/styles-v6-sidebar.css` (imported by styles-v6.css); suite part
  `test/phase2/ui-v6/sidebar.tests.mjs` (run by run.mjs). Interface notes: CONTRACT_CHANGES "## UI v6 U3".
- Wired: tabs, the icon rail (⟩ / ⟨, drone dot + key), resize by the left-edge grip (drag, ←/→, 200 px … 62 % of the
  board, fold below 200), ⋯ customize (show / hide, ↑ ↓ + drag order, Starts Open / Collapsed), per-device layout in
  `localStorage['worship-rig.v6.sidebar']`; Drone (today's writes and lock rules), Setlist (cue then Go, Prev, + Add
  song: library, Song bank via Settings, New song), Notes (read only); the song bar's Notes / Setlist open their tab;
  iPad portrait panel under the strips.
- Placeholders: Drone "Sustain" (no drone pedal hold exists anywhere yet), Notes "Chart · coming in 2.1"; the Song bank
  entry opens today's list in Settings (U7 builds the browser).
- Choices to confirm with Ryan: New song is added at the end and not selected (Perform never switches the sound by
  itself; the toast offers "Edit it"); the pad-folder line shows only while My Pads is chosen (the column is short);
  Starts applies per page load; the song bar's Notes / Setlist un-hide a module the player had hidden.
- For U4 / U6 / U7: the left panel is still the placeholder; Settings › Perform layout can read / write the same
  localStorage key (`normalizePrefs`); Chart as a sidebar tab = one module in `modules.js`.
- Known: below 1024 px wide the whole app still has `body { min-width: 1024px }` (today's), so 820 px portrait scrolls
  sideways; U8 owns the iPad layouts.

## U4 status (builder, 2026-11-26; lane-u4 from lane-u3 28544f2, rebased onto ee94331; skeptic pass done)

- **Skeptic (2026-11-26): VERIFIED after fixes.** The review is `native/docs/reviews/UI6-U4.md`. Fixed: an open Quick
  sheet stayed put when its opener moved on a resize / rotation / snapshots fold (F1), and the Quick screenshots were
  taken mid fade-in (F2, test). ui-v6 is 49/49, ui-core 78/78; flag-off purity vs ee94331 identical. U3's O1 (1024 px
  crowding) is unchanged by U4; at 820 px portrait the page no longer scrolls sideways, but the strips now scroll in
  their row (U8).

- Built: `app/js/views/v6/left.js` (`leftPanel`), `app/styles-v6-left.css` (imported by styles-v6.css); perform.js
  mounts it in `.v6-left` and opens the one Quick sheet from either button; suite part
  `test/phase2/ui-v6/left.tests.mjs` (run by run.mjs). Interface notes: CONTRACT_CHANGES "## UI v6 U4".
- Wired: Quick (today's sheet, all of it incl. Save as scene; a one-column panel beside the button, or under the top
  bar's Quick; floats, Esc / either button closes, focus back to the opener); today's wheel column (wheelStrip: wheel
  with pickup, target by instrument name, Expr / Vol, Swell, pedal lamp + "Pedal held", Bend → drone lamp), same calls
  and live updates as today; Lock leaves it live. The v6 Perform drops `body { min-width: 1024px }` (820 px portrait
  no longer scrolls sideways; Edit keeps it).
- Placeholders: none in the left panel.
- Choices to confirm with Ryan: the sheet opens beside the left button but under the top bar's button (anchored to the
  opener); its header shows the subtitle, or the "Under Lock: …" line while locked (not both); the target says
  "Warm Pad level", an empty slot "Instrument n level"; the wheel caption hides below 760 px tall windows.
- Known: at 820 px the top bar (today's) still overlaps itself (U8); the sheet can reach over the keyboard's left part
  at 1280×800 (it is ~555 px tall, the board 488 px), as the mockup's does.

## Open questions carried into the build (decide, log in DECISIONS, tell Ryan)

- **Snapshots vs today's scenes.** Today: up to 3 scenes per song, levels / ON / drone level / wheel only. The v6
  mockups show named snapshots that may also hold Space / Echo and the drone. U1 shows the existing scenes in the
  snapshots row (names "Scene 1…" until named; no schema change). Widening what a snapshot holds is a separate,
  logged decision.
- Chart and song bank pieces already exist hidden (chart view D7, bank O-AW-PP); U7 reuses their logic.
