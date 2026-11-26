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

- **Polish (UI6-U5a P1):** the range keyboard's always-visible label (`showTip`) forces a reflow on every live
  write (~10 ms at 6× CPU); measure it in a requestAnimationFrame (shared with Perform).
- **Polish (UI6-move O2/O3, orchestrator):** Enter on a strip name (pick) moves focus to the picked bar's low
  handle; the small-window "opened here" memory counts only a deliberate open of the sidebar (⟨ / rail), not the
  Notes / Setlist chips, and is keyed by orientation so an iPad rotated to portrait is not held folded.

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

- **U-MOVE (D23):** store half done (skeptic VERIFIED, `reviews/U-MOVE-store.md`); UI half built on lane-moveui
  (see "U-MOVE UI + D24 tweaks status" below; skeptic VERIFIED after fixes, `reviews/UI6-move.md`). Left for later: drag-to-reorder in Edit's rig tabs.
- **U-TWEAKS (D24):** built on lane-moveui (live throttled range writes, pick-first on all pointers, drone %); skeptic
  VERIFIED after fixes (`reviews/UI6-move.md`).
- **Esc setting (D24.7):** "Esc always panics" toggle, per device, read by the v6 Esc handling (and today's).
- **Small-window fit (UI6-U3 O1, orchestrator tier 2):** built on lane-moveui (sidebar folded at ≤ 1100 px until
  opened there once; slim Add from 4); 4 strips at 1024×700 fit with no scroll, folded or open. Skeptic VERIFIED
  (`reviews/UI6-move.md`).
- **U-METRO (D23):** Metronome sidebar module (today's click chip behaviour) + load state in the sidebar header.

- ~~**Preview switch for Ryan (U1 review O3):**~~ **Done (lane-small; skeptic VERIFIED after fixes, reviews/UI6-small.md):** Settings › Look ›
  Perform view › "Try the new layout (preview)", swaps Perform live (Chrome and the Mac app). CONTRACT_CHANGES
  "## UI v6 preview switch in Settings". Original note: `?ui6=1` only works in Chrome; the Mac app needs a visible way to turn
  v6 on for the U9 review. Add "Try the new layout (preview)" in Settings (today's Settings, Look or Mac category),
  writing `settings.uiV6`. Before U8 ends.
- Pre-existing red suites to fix separately: eq "L-21 note labels fit" (fails on base), engine suite's 404 on
  `/__tests/api/health` and the CPU-timing `offline.eqCpu` on the 2-CPU box.

## U-MOVE UI + D24 tweaks status (builder, 2026-11-26; lane-moveui from b163c20, rebased onto 715b936; skeptic done)

- **Skeptic (2026-11-26): VERIFIED after fixes** (one low defect, one test-order failure from the rebase). The review
  is `native/docs/reviews/UI6-move.md`. Fixed: an Esc mid range drag ended the pick but the drag kept writing and
  committed on release (F2); the lane-small D24.7 check met a range pick left open by the U2 checks (F1). ui-v6 68/68,
  ui-core 78/78 (one TAP-timing flake on the first run), edit-v2 14/14, settings 94/94, shell unit 357/357.

- Built: ⋯ Duplicate next to the original (`store.insertSlot`, scenes copied), ⋯ Earlier / Later, a ⠿ grip to drag a
  strip (mouse / pen / touch, drop line, auto-scroll, Esc), all refused under Lock and ended by a song switch, the
  view hiding, Lock or any slot change; protections keyed on the order through `store.onSlotMap` (⋯ menus, step
  panels, fader / reorder / range drags, the pick; Edit's selected tab and 8 s Undo); PANIC a tap, Lock as today
  (tap locks, hold unlocks); live range writes (≤ 1 / 50 ms + final) with every cancel restoring the start value on
  the right instrument; pick first on every pointer on Perform; drone Bright / Move %; small-window fit. Interface
  notes: CONTRACT_CHANGES "## UI v6 move + D24 tweaks". Suite: `test/phase2/ui-v6/move.tests.mjs`; ui-v6 63/63.
- Choices to confirm with Ryan: Lock unlocks with a hold (D23.1 "as today"; a single tap both ways was the other
  reading); the grip drags at once on touch (no long-press: it is a dedicated handle with `touch-action: none`, the
  rest of the row still scrolls); a cancelled live range drag writes the old value back even under Lock; the finishing
  click on the keys plays no note on the Mac too (U2's iPad rule, now every pointer); a move drops a range pick rather
  than following the instrument.
- Not done: drag-to-reorder in Edit's rig tabs (later, per D23); MIDI learn stays positional (D23 tier 2).

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

## U5a status (builder, 2026-11-26; lane-u5 from v2-native 715b936; skeptic pass done)

- **Skeptic (2026-11-26): VERIFIED after fixes** (`native/docs/reviews/UI6-U5a.md`). Fixed: category tablist
  semantics (F1), Advanced below the list's fold at 1024 × 700 (F2), Tone EQ scrolling sideways at 1024 × 700 and
  its "Keys plays…" summary (F3, D15), the library's setlist head overlapping (F4). ui-v6-edit 18/18, edit-v2 14/14
  (117), ui-v6 54/54, settings 94/94. **Rebase onto lane-moveui needs R1–R3** (live range writes vs `update()`'s
  cancel; the strip's name button and grip in Edit; slot-move following + Undo `followSlot` in the v6 Edit).
- **Rebased onto v2-native acfa900 (2026-11-26), R1–R3 done** (CONTRACT_CHANGES "## UI v6 U5a", "After the
  rebase"): a cancelled live range drag restores into its own song and instrument (instrument switch, song switch,
  leaving Edit, slot move); the strip's name opens Range and the ⠿ grip is hidden in Edit; the selected tab and the
  8 s Undos follow a move. ui-v6-edit 21/21, ui-v6 68/68 (its "U-MOVE Edit" check runs on both Edits now), edit-v2
  14/14 (117), settings 94/94, flag-off purity vs acfa900 identical. Not pushed or merged; no skeptic pass after the
  rebase yet.

- Built: `app/js/views/v6/edit/edit.js` (`mountEditV6`, mountEdit's interface), `views/v6/edit/instrument.js` (the
  instrument panel), `app/styles-v6-edit.css`; main.js mounts / swaps it with `settings.uiV6`; `views/edit/shell.js`
  exports its core (`createEditCore`, `editPanelFrame`, `editDefaultTab`; no behaviour change). Suite
  `test/phase2/ui-v6-edit/run.mjs` (16 checks, in run-all). Interface notes: CONTRACT_CHANGES "## UI v6 U5a".
- Wired: library column (today's setlist module + Song bank…, ⟨ fold to a rail, per device), song header (today's
  module + Time + Chart while the chart view is on), rig tabs by instrument (position colour, dB, changed dot incl.
  range) + Add + Drone / Effects / Master, the instrument panel (sentence with jump words, Change instrument ▾ =
  today's picker, the D18 category list with state + dots, remembered per device; Sound, Tone EQ (today's
  eqKeyboard, mount on open / destroy on leave), Range (U2's 88-key rangeKeyboard + boxes + Whole keyboard + Set by
  playing + Octave), Touch, Sustain, Space & Echo, Advanced, all on today's slot-panel paths), the v6 strip on the
  right, iPad portrait (tabs row, no strip, library as a drawer from ☰ Songs).
- Placeholders: Drone / Effects / Master / Song are today's panels in the v6 card (U5b); the keyboard row is today's
  Edit one (role legend hidden); Song bank… opens today's list in Settings (U7); Chart opens the chart on Perform.
- Gates: ui-v6-edit 16/16, edit-v2 14/14 files (117 tests), ui-v6 54/54 (U4's iPad check updated: Edit at 820 px is
  the v6 Edit now, `min-width: 0`), settings 94/94; engine / shared / store / controller / v6 Perform files unchanged;
  flag-off purity vs 715b936 identical (105 requests, 15 store listeners, 4 intervals, 2529 elements, 1047 in Edit).
- Open for Ryan / U5b: category dots follow today's rule (V6_DIFF_WATCH), so Sound, Tone EQ, Touch and Advanced never
  dot (the mockup shows a dot on Tone EQ); the eqKeyboard's own header still says "Keys plays…" (a role word, D15).

## U6 status (builder, 2026-11-26; lane-u6 from acfa900; awaiting the skeptic)

## U6 status (builder, 2026-11-26; lane-u6 from acfa900; skeptic pass done)

- **Skeptic (2026-11-26): VERIFIED after fixes.** The review is `native/docs/reviews/UI6-U6.md`.
  - F1: search found rows today's code hides.
  - F2: a keyboard drill-in at 820 px dropped the focus to `<body>`.
  - F3: the undo journal grew by one listener per Forget per render.
  - F4: `lastBackupAt()` reported failed attempts.
  - F5: Learn… was 2.6:1 under Daylight Day.
  - F6: Back up now left the summary stale.
  - The undo journal held through flag-offs on every category, mid-search, mid-learn, at 820 px, with the
    GarageBand dialog open, over 10× flips and with injected throws.
  - Esc never panics with Settings open (Perform v6, today's Edit, Edit v6 via a scratch merge of lane-u5).
  - Settings 111/111, ui-v6 68/68 (purity identical), ui-core 78/78, shell unit 364/364.
  - Open: drill-in loses its place on a rotation (O1); stale-while-open details (O2); a pre-existing Daylight Day
    contrast fail in today's Sound note (O3).


- Built: `app/js/views/v6/settings.js` (`enhanceSettings`: the v6 Settings applied in place to today's
  `views/settings.js` DOM and undone when the flag goes off, live too), `views/v6/settings-summary.js` (pure category
  summaries), `app/styles-v6-settings.css` (scope `.v6-st`). Small hooks in `views/settings.js` (`syncV6`, `v6Api`,
  `shown` / `opened`), one Esc line in main.js, `controller.lastBackupAt()`. `sidebar.js` exports `customizeList` /
  `sidebarLayout` / `prefsWithShown` (the ⋯ popover uses them too); `snapshots.js` exports `snapsFolded` /
  `setSnapsFolded`. Interface notes: CONTRACT_CHANGES "## UI v6 U6".
- Wired: summaries under every category (live), search (word starts in labels, hints and control words; filters
  categories and rows; Enter / Shift+Enter; Esc clears first), MIDI Learn category (learned list + Forget, D20 rule,
  Learn…, today's table), Perform layout (sidebar modules show / hide / order + Starts on the live sidebar, snapshots
  row fold), Song bank entry in Sounds & Samples (today's list), theme preview cards, iPad portrait drill-in.
- Left out (no setting exists yet): Perform layout's left panel row and the chart placement / text size rows (U7).
- Choices to confirm with Ryan: Look › Perform view (Chips per sound, the preview switch) stays in Look; the drill-in
  (not a top row) on iPad portrait; search matches word starts; Day / Stage / Auto only for Daylight (today's rule;
  the mockup shows it for every theme); the mockup's "Learn, then tap what it should change on screen" is U7's MIDI
  Learn mode, so Learn… here goes to today's table.
- Tests: settings suite mode `v6` (13 checks, incl. the control-count proof: 119 today, all kept, + 20 new) and
  `test/phase1/shell/ui-v6-settings.test.mjs`. Settings 107/107, ui-v6 68/68, ui-core 78/78 (rerun after a TAP
  timing flake), edit-v2 14/14, shell unit 363/363. Screenshots: `/home/claude/design-out/u6/` (`u6-<category>-1280.png`,
  `u6-search-1280.png`, `u6-ipad-list-820.png`, `u6-ipad-look-820.png`, `u6-*-sanctuary-day.png`, `u6-mac-1280.png`).

## Open questions carried into the build (decide, log in DECISIONS, tell Ryan)

- **Snapshots vs today's scenes.** Today: up to 3 scenes per song, levels / ON / drone level / wheel only. The v6
  mockups show named snapshots that may also hold Space / Echo and the drone. U1 shows the existing scenes in the
  snapshots row (names "Scene 1…" until named; no schema change). Widening what a snapshot holds is a separate,
  logged decision.
- Chart and song bank pieces already exist hidden (chart view D7, bank O-AW-PP); U7 reuses their logic.
