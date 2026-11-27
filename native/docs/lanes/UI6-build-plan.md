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

- **CAP (UI6-cship O1, tier 2: mine):** one size rule for every add: saving a chart, adding a Song bank song and pack
  top-up follow D9 + D33's O4 note too (past 2 MB warn and go through; refuse only past the 2.5 MB restore cap).

- ~~**CVD2 (UI6-cvd O1/O5/O6, tier 2: mine):**~~ **Built (lane-fu2; skeptic pending):** range-bar numbers placed in
  JS (components/keys.js placeBadges / cvdBadges → --cvd-x, only while the setting is on) so none stacks, in the v6
  keyboard and today's; the v6 Edit tab name stops before the changed dot; a muted number goes grey (v6 muted bars
  keep their lamp colour: pre-existing, left). CONTRACT_CHANGES "## CVD2".

- ~~**FU2 (UI6-fu O1/O2/O3 + quirks; tier 2: mine):**~~ **Built (lane-fu2; skeptic pending):** O1 (b): the
  empty-library step fades only while a key or the pedal is held; O2: both Edits keep the snapshot line's room while
  the song has snapshots (0 px shift measured); O3: bank-trial deterministic (root cause: a stale keep-alive socket
  after the 5–17 s synchronous "random sequences" test); the v6 Edit header row fits below 1100 px (chart on too);
  today's Edit fits an 820 px window. CONTRACT_CHANGES "## FU2".

- ~~**C-SHIP (D33):**~~ **Built (lane-cship; skeptic pending; "C-SHIP status" below):** the chord chart ships in
  2.0: default on with a Settings › Perform switch, placeholders gone, chart-view review O1 (PANIC reachable over the
  chart dialogs), O3, O4, O7 fixed; purity probes re-based; iPad sizes and all 8 themes with charts on.

- ~~**Empty-library silence (UI6-er O1, tier 2: mine):**~~ **Built (lane-fu; skeptic pending):** when no song is
  selected and no songs are left (delete the last song, Back from an empty-library trial, an empty import) the
  controller turns the drone off and fades the voices (Fade out's path), once; PANIC turns off a drone left on with no
  song behind it (the controller now records the drone mode it last sent the engine). A drone a song or snapshot has
  on still keeps going under PANIC, as in 1.x; PANIC is otherwise unchanged. CONTRACT_CHANGES "## Empty-library
  silence; PANIC stops an orphaned drone (UI6-er O1)".

- ~~**U-SNAP follow-up (UI6-snap O1/O2/O5, tier 2: mine):**~~ **Built (lane-fu; skeptic pending):** while a snapshot
  plays, both Edit views show a line under the header's chips: "Changing snapshot “Hall” for now: Update keeps it,
  Own levels edits the song" (O1; today's Edit says "scene “Scene n”"); v6 Edit's Effects "Sends" and the
  instrument's "Space & Echo" summaries read the song as it plays (O2); the dialog's drone row no longer says "and its
  key" (O5). CONTRACT_CHANGES "## U-SNAP follow-up (UI6-snap O1 / O2 / O5)".

- ~~**U-CVD (D32):**~~ **Built (lane-cvd; awaiting the skeptic):** Settings › Look › Colour-blind colours (Off /
  Red–green / Blue–yellow), `settings.cvd` per device; `html.cvd-rg` / `.cvd-by` (main.js + boot.js mirror); a
  palette per theme × type in styles.css (8 colours, 8..15 repeat; Machado ΔE×100 ≥ 10.3, neighbour ΔL ≥ 0.09, lamp
  ink ≥ 4.9 : 1 in the ON window: `tools/themes/cvd-check.mjs`); v6 position 7 gets its own colour; instrument
  numbers on range bars and before the v6 strip / Edit tab names. CONTRACT_CHANGES "## U-CVD".

- **U-SNAP (D26.1):** snapshots remember Space / Echo (sends + the song's room / echo choice) and the drone (on,
  key, sound). shared/scenes.js + controller apply path + Save snapshot dialog "It keeps". Core-data change:
  builder + strong skeptic.

- ~~**U-SNAP (D26.1):**~~ **Built (lane-snap; awaiting the skeptic):** snapshots remember Space / Echo (sends + the
  song's room / echo rows) and the drone (on, sound; its key follows the song's, or a key chosen in Save snapshot,
  relative: DECISIONS D26.1a). shared/scenes.js +
  controller apply path + every view that writes those fields goes through `controller.scenes.take` / `adjust` first
  and shows `scenes.view(song)` (v6 and flag off) + Save snapshot "It keeps" / names / voice.js copy.
  CONTRACT_CHANGES "## Snapshots remember Space / Echo / drone (D26.1)".
- **U-EDITRANGE (D26.2):** Edit's bottom-row range bars draggable with Perform's guards.

- ~~**U-EDITRANGE (D26.2):** Edit's bottom-row range bars draggable with Perform's guards.~~ **Built (lane-er):**
  Perform's write rule and guards moved to `views/v6/range-guard.js`, used by Perform (unchanged) and the v6 Edit's
  row (plus a window-blur cancel there). CONTRACT_CHANGES "## UI v6 U-EDITRANGE". Skeptic review pending.

- **Core flake (not UI):** CI run on f46bac4 (2026-11-26 19:37 UTC, macos-15 build-test) failed
  `unit.core3` at test_core3.cpp:353 `CHECK(busy <= 1)` (switch back to B: more than one job in the prebuild lane's
  hands). The commit changed JS/docs only and later runs passed: likely a timing/lane-count assumption in the test
  (or a real race). Needs a core builder + skeptic; check how many prebuild workers run on the macOS runner.

- ~~**Polish batch 2 (UI6-polish1 O1/O2, orchestrator):**~~ **Built (lane-er; also UI6-U8a O1: Back from a
  trial begun in an empty library ends it; CONTRACT_CHANGES "## UI v6 polish batch 2"; skeptic review pending):**
  v6 Perform overlays (Quick sheet, step panels, popovers) opt in to `underModal` so the Esc that closes Settings
  never closes them (today's Perform unchanged); move the
  Back-into-the-gap rule from bank/banner.js into `controller.backFromTrial` so every Back (incl. perform.js destroy
  on a flag flip) uses it. O3 (reload drops a setlist gap) is pre-existing: note only. Also (orchestrator screenshot,
  2026-11-27): v6 Edit's song title is cut mid-word at 1280×800 ("Sunday Pad + Pia" with no ellipsis) — ellipsize or
  let the KEY / BPM / Notes chips give way; check at 1180 and 820 too.

- ~~**U8 themes (UI6-U6 O3, pre-existing):**~~ **Done (U8b, lane-u8b):** Daylight Day's Sound note `.st-engine-note` is 1.88:1 even with the
  flag off; fix in the themes pass. Also UI6-U6 O1/O2 (rotation keeps the open category; live "n min ago").
  (Polish batch 1 skipped O1/O2: both live in `views/v6/settings.js`, lane-u7c's file at the time.)

  flag off; fix in the themes pass. ~~Also UI6-U6 O1/O2 (rotation keeps the open category; live "n min ago").~~
  **O1 / O2 done in U8a** (see "U8a status"); the themes pass is not (U8b).
- **Polish (U5b open Q4, orchestrator):** Perform's Change opens the instrument chooser over Perform (no switch to
  Edit), so the sound changes where you play (D14 single sound at the desk). U5b Q1–Q3 kept as built: live moves
  don't dot (today's rule), Edit's range bars display only, Lock from Edit goes to Perform and locks.
- ~~**Polish (UI6-U5b O2/O3/O5):**~~ **Done (polish batch 1, lane-pol1):** chooser: ←/→ must not change the song while it is open; "not available" line for
  an instrument missing from the engine list; kinds list fit at 1024×700. O1 (Edit range bars draggable) waits for
  Ryan; O4/O6 noted.
- ~~**Polish (UI6-U7a O1–O4):**~~ **Done (polish batch 1, lane-pol1; O2 rule in CONTRACT_CHANGES):** Edit's single-song Export refuses a trial song (or tells the player to Keep it
  first) — no `trial:` id in any file; Esc in the bank's search box clears first; Back when the replaced entry was
  removed; Edit v6's "Song bank…" title text.
- ~~**Polish (UI6-U7b O1–O3):**~~ **Done (polish batch 1, lane-pol1; O3 by the wording):** the Notes module's body keeps pointer focus (Space scrolls instead of sustain, like
  U7b F1) — release pointer focus; auto-scroll resumes after a placement change; Keep on an already-in-library trial
  song keeps the chart set while trying (or the wording says otherwise).
- ~~**Polish (UI6-U5a P1):**~~ **Done (polish batch 1, lane-pol1; numbers in CONTRACT_CHANGES):** the range keyboard's always-visible label (`showTip`) forces a reflow on every live
  write (~10 ms at 6× CPU); measure it in a requestAnimationFrame (shared with Perform).
- ~~**Polish (UI6-move O2/O3, orchestrator):** Enter on a strip name (pick) moves focus to the picked bar's low
  handle; the small-window "opened here" memory counts only a deliberate open of the sidebar (⟨ / rail), not the
  Notes / Setlist chips, and is keyed by orientation so an iPad rotated to portrait is not held folded.~~ **Done in
  U8a** (see "U8a status").

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
- Placeholders: Drone "Sustain" (no drone pedal hold exists anywhere yet), Notes "Chart · coming in 2.1" (gone with
  C-SHIP, D33); the Song bank entry opens today's list in Settings (U7 builds the browser).
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

## U5b status (builder, 2026-11-26; lane-u5b from v2-native 4c485f5; no skeptic pass yet)

- Built: `app/js/views/v6/edit/catpanel.js` (the D18 category-list frame), `drone.js`, `effects.js`, `master.js`,
  `chooser.js` (Change instrument), `bottom.js` (the v6 Perform's bottom row in Edit); `edit.js` / `instrument.js`
  wire them; `views/v6/bottom.js` gains `{prefix}` and a `toggleLock` hook; `styles-v6-edit.css`. Suite part
  `test/phase2/ui-v6-edit/u5b.tests.mjs`. Interface notes: CONTRACT_CHANGES "## UI v6 U5b".
- Wired: Drone (Key & sound = the sidebar's Drone module + Width; My Pads; Behaviour), Effects (Space, Echo, Chorus,
  Sends table; Vibe; Tape & finish link), Master (Volume & output, Tape, Master EQ, Glue, Wheels & pedal), all on
  today's addresses; every category and rig-tab dot = changed since the song began (live moves never); the v6
  Perform bottom row (Revert / Fade out / PANIC / Lock) in Edit with its own test ids, mounted only while Edit shows;
  the chooser (kinds from the engine, playing now, search, Use + 8 s Undo, Cancel, Remove) from Change instrument ▾,
  + Add, the sentence and Perform's Change; U5a O3–O6.
- Not in today's app, so not drawn: the chooser's ▶ preview (no audition of a sound outside a slot), a "Strings"
  kind (the Strings synth is in the engine's Synth Pads group), a "Safety limiter" switch (the output ceiling is
  always on: a line of text), an output picker in Edit (it is per computer: read only + Settings › Audio), the
  drone's "Follow the song key" (the drone always plays the song key), Echo's "Follow tempo" switch (today's Timing
  choice instead), Wheels' sustain-pedal lamp and "Reversed" (per computer: Perform's left panel and Settings).
- Added beyond the mockup (kept from today's panels): Effects › Chorus, Master › Tape.
- Choices to confirm with Ryan: live moves never dot (instrument level / ON, drone Level / ON, master volume); a key
  change dots Drone › Key & sound; Edit's bottom-row range bars are display only (Range has the editor); Lock in Edit
  returns to Perform locked; Perform's Change still switches to Edit (the chooser could open over Perform instead).
- Gates: ui-v6-edit 29/29, ui-v6 68/68, edit-v2 14/14 (117), settings 94/94, shell unit 357/357; flag-off purity
  identical; engine / store / controller / shared / main.js unchanged.
- Known: at iPad portrait the bottom row's keyboard is ~260 px wide (the v6 Perform's row as it is; U8 does the iPad
  layouts); U5a's stage strip still carries Perform's strip test ids (scoped by `v6e-stage`).

## U7a status (builder, 2026-11-26; lane-u7a from v2-native 025d90e; awaiting the skeptic)

## U7a status (builder, 2026-11-26; lane-u7a from v2-native 025d90e; skeptic: verified after fixes)

- Built: the Song bank browser over the v6 stage and Try it (D17). `app/js/views/v6/bank/` (`bank.js` browser,
  `banner.js` the Trying banner, `model.js` pure filters), `app/styles-v6-bank.css`; store trial songs
  (`startTrial` / `endTrial` / `persisted` / `packSongPreview`), controller `tryBankSong` / `backFromTrial` /
  `keepTrial` / `trial` / `bankSong` + the `'trial'` event; `main.js` `ctx.openBank`. Interface notes:
  CONTRACT_CHANGES "## UI v6 U7a (Song bank)".
- Wired: entry from Setlist › + Add song › From the Song bank, v6 Settings › Open Song bank… (today's list hidden
  there) and `openSettings({section:'bank'})` (Edit v6's Song bank… too); filters (search, key, tempo, feel, packs),
  detail, Add to library (today's record), Add to setlist ▾, Try it (nothing saved; banner: Keep it, Add to setlist,
  Back), My library mode (Try it = switch), Lock, iPad portrait (filters on top, list, detail under).
- Try it guarantees, tested: localStorage byte for byte, Export / backup source, `meta.edited`, library order and
  setlists unchanged while trying, after fader moves too; reload = gone; Back = same song, setlist entry and Revert
  snapshot; Keep = today's add (same record) + select.
- Choices to confirm with Ryan: tempo bands Slow < 80 ≤ Mid < 115 ≤ Fast; Feel is "any chosen tag"; Keep keeps what
  the player changed while trying (so the kept song reads as edited and a newer pack version will not overwrite it;
  untouched it is exactly today's add); Back is allowed under Lock (a way out, like GO) and lands on the song's own
  levels (no scene); a second Try it keeps the first one's Back; My library's Try it is a plain switch (no banner);
  leaving v6 (flag off) goes Back from a trial; the browser does not focus the search on a pointer open (Space stays
  the pedal, no iPad keyboard pop-up).
- Not done: Edit v6's own "Song bank…" button title still says "today's list in Settings" (lane-u5b's file; the
  route already opens the browser); a trial song can be edited in Edit (transient) and exported alone with Edit's
  Export song (explicit, one song; not a library export or backup).
- Tests: `test/phase2/ui-v6-bank/run.mjs` 15/15 (in run-all), `bank-trial.test.mjs` 4/4, `ui-v6-bank.test.mjs` 5/5;
  ui-v6 68/68 (purity vs 025d90e identical), settings 111/111, ui-core 78/78, ui-v6-edit 22/22, shell unit 373/373.
  Screenshots: `/home/claude/design-out/u7a/` (`u7a-browse-1280.png`, `u7a-trying-1280.png`,
  `u7a-setlist-entry-1280.png`, `u7a-library-1280.png`, `u7a-browse-1180.png`, `u7a-trying-1180.png`,
  `u7a-browse-ipad-820.png`, `u7a-trying-ipad-820.png`).
- Skeptic (2026-11-26, `native/docs/reviews/UI6-U7a.md`): **VERIFIED after fixes F1–F4** (trial nav follows setlist
  edits, Back / saved position; pack update during a trial; Keep removes fields; Next from a trial steps from the
  replaced entry). Open: O1 Esc in the search closes the browser, O2 Back can't restore a gap, O5 choices to confirm.

## U7b status (builder, 2026-11-26; lane-u7b from v2-native 8bd0d2f; skeptic: verified after fixes)

- Built: the chart in the v6 layout, only while `settings.uiV6` and `settings.chartView` are both on.
  `app/js/views/v6/chart/` (`chart.js` mountChartV6: placement, the sidebar module, the stage, ⌘ keys; `panel.js` the
  one chart panel; `minis.js` mini faders; `edit.js` the Edit chart dialog), `app/styles-v6-chart.css`; shared
  `views/chart/core.js` (today's render cache / auto-scroll / paging, now used by today's view too) and
  `import.js chartReview` (today's review + save); `logic.js` percent / Fit / jump helpers; sidebar late modules
  (`addModule` / `removeModule`, `take` / `away` / `width`). Interface notes: CONTRACT_CHANGES "## UI v6 U7b (chart)".
- Wired: Chart as a sidebar tab (540 px while it shows, own drag width) and on the stage (strips → live mini faders,
  sidebar folded with Chart lit, ▤ Strips, ⇥ Sidebar / ⤢ Stage, per device); key on show incl. D12, Heard / Hands,
  auto-scroll + speed, jumps, reading line; text size in % (steps, % / ⌘0 → 100, Fit, ⌘+ / ⌘−, ⌘-scroll, pinch,
  "Text 150%" readout, per place, px index migrated once); Edit chart (source / live preview / status line / offers
  unticked / Save / Cancel / Remove / Add a chart); Lock rules; iPad landscape = Mac, portrait = music stand; the
  Notes module's Chart button; the v6 Edit's Chart button.
- Not drawn (deviations from the mockups): the snapshots row stays on the stage (the mockup drops it there; the player
  can fold it); ▤ Strips also in landscape (the mockup has no way back there); Edit chart… also in the sidebar (after
  the scroll controls); the Edit dialog's "Paste…" (paste works in the box) is "Choose file…", Insert section is a
  select, and the review (offers) sits under the text; chords are the lyric's size (today's sheet; the mockup draws
  them at 90 %); the readout is "Text 150%" without the hint line; no level meters on the mini faders.
- Choices to confirm with Ryan (the placement default is superseded: see the skeptic line below): the default
  placement is the sidebar (a new tab behaves like every tab); the rail's
  Chart / the Chart tab put it up on the stage when that is where this device shows it; the stage and the sidebar
  keep separate sizes (100 % / 75 %); the migration fills the stage size only; one jump row that scrolls sideways.
- Gates: chart 33/33 (today's 15 + U7b 18), ui-v6 68/68 (purity vs 8bd0d2f identical), ui-v6-edit 32/32, settings
  111/111, shell unit 364/364, unit 685/685 (12 skipped as before); engine / store / controller / shared unchanged.
  Screenshots: `/home/claude/design-out/u7b/` (`u7b-stage-1280`, `u7b-sidebar-1280`, `u7b-wide-sidebar-1280`,
  `u7b-150-1280`, `u7b-edit-1280`, `u7b-stage-1180`, `u7b-stage-820`; mockups in `mock/`).
- Not verified: the Mac app (⌘+ / ⌘− reach the page because the app menu has no zoom roles; ⌘-scroll on a real
  trackpad), a real iPad (pinch was CDP touch emulation), VoiceOver.
- Skeptic (2026-11-26, `native/docs/reviews/UI6-U7b.md`): **VERIFIED after fixes F1–F5** (a tap left the chart
  focused: Space paged it, Esc only blurred; a finger on a mini fader + one on the chart was a pinch; no preview over
  the size cap; a trial song's chart said "saved"; 40 px buttons). Orchestrator decisions applied: (a) default
  placement = the stage (stored only when the player picks); (b) snapshots row on the stage, separate stage / sidebar
  sizes, Chart tab / rail as built. Open: O1 Notes module focus (same as F1), O2–O7 in the review.

## U7c status (builder, 2026-11-26; lane-u7c from v2-native f46bac4; awaiting the skeptic)

- Built: MIDI Learn mode on Perform (`views/v6/learn-mode.js`), Arrange (`arrange.js` + strip handles + the sidebar's
  `arrange(on)`), the Save snapshot dialog and a name dialog (`dialogs.js`), the song menu (`song-menu.js`, ⋯ in the
  song bar), `styles-v6-dialogs.css`; controller `learnCapture()` / `learn(id, {heard})` / `scenes.save(n, {name})`,
  midi.js `accept: 'control'`, shared/scenes.js scene names (D25). Interface notes: CONTRACT_CHANGES "## UI v6 U7c".
- Wired: learn knob-first or tap-first on every learnable v6 control (strip level / Space / Echo, drone level, master,
  Swell, Fade out, PANIC) with outlines, badges, the D20 toast, from Settings › MIDI Learn › Learn on Perform and a
  right-click; Esc / Done / Lock / song switch / Edit / flag off; Arrange from the snapshots row (◀ ▶ ✕ hold, the strip
  drag, the sidebar's customize list); Save snapshot from + Save / Save as new (suggested name, It keeps, Update /
  Save as new / Cancel, names in the row and fold chip); song menu (Rename…, Duplicate, Add to setlist ▸, Export,
  Reset to as saved, Delete) with Lock and trial-song rules.
- Decided here (tier 2/3, logged): **D25** snapshots stay today's scenes + an optional name; **Esc with "Esc always
  panics" on** panics and leaves learn mode / Arrange (like every other Perform overlay); the Save snapshot dialog is
  modal (Esc never panics there); **Delete** backs up the library first in the Mac app (refuses if it can't) and says
  "no automatic backup in Chrome" there; "+ Save" stays enabled at 3 snapshots while one plays (Update / rename).
- Choices to confirm with Ryan: the name heuristic (instruments on + louder / softer / drone up / down); badges show
  the CC ("CC21") instead of the mockup's "K1"; Update keeps the old name unless the field was edited; the trial song's
  Rename is refused too ("Keep it first"); Arrange orders the sidebar with the list in the sidebar body (tabs are
  outlined, not dragged themselves).
- Open for Ryan: widening what a snapshot holds (Space / Echo, drone key / sound) — D25 keeps it as today.
- Not done: an iPad long-press entry (Safari has no contextmenu; Settings › Learn on Perform works there); at 820 px
  the song bar's ⋯ makes the existing tight bar tighter (U8's iPad pass).
- Gates: ui-v6 74/74 (purity vs f46bac4 identical), ui-v6-bank 17/17, ui-v6-edit 32/32, settings 111/111, ui-core
  78/78, shell unit 383/383 (+6 in `scene-names.test.mjs`), edit-v2 learn 1/1; engine untouched. Screenshots:
  `/home/claude/design-out/u7c/` (`u7c-learn-1280.png`, `u7c-learn-done-1280.png`, `u7c-arrange-1280.png`,
  `u7c-savesnap-1280.png`, `u7c-songmenu-1280.png`, `u7c-*-820.png`).
- **Skeptic (2026-11-26, `native/docs/reviews/UI6-U7c.md`): VERIFIED after fixes.**
  - Fixes:
    - F1 (medium): PANIC works while learning. A tap panics and picks, and the learned PANIC footswitch is never
      captured.
    - F2 (low): no dead end after a key is heard.
    - F3 (low): the Esc that closes Settings no longer ends learn mode or Arrange.
  - Open:
    - The 820 px song bar overflows (U8).
    - For Ryan: whether CC1 / 11 should be capturable, reassign vs add on a learned knob, and the tap-on-PANIC
      choice.
  - Gates: ui-v6 76/76 (purity identical), ui-v6-bank 17/17, ui-v6-edit 32/32, shell unit 384/384, migration-1x unit
    107/107, settings 111/111, ui-core 78/78, edit-v2 117/117 (14 files).

## U8a status (builder, 2026-11-26; lane-u8 from v2-native 38c664b, rebased onto dcb2f06; skeptic pass done)

- **Skeptic (2026-11-26): PARTIAL as delivered, VERIFIED after fixes.** The review is
  `native/docs/reviews/UI6-U8a.md`. Fixed:
  - a MIDI problem's words showing 0 px at 820 once the sounds were ready (F1);
  - the Start here card and the Trying banner leaving the portrait faders a 66 / 59 px track (F3);
  - the empty library's Restore a backup… looking live under Lock (F2).

  Open: Back from a trial that began in an empty library does nothing (O1); 16 pills cut (O2, pre-existing);
  orientation flips under a height-shrinking keyboard (O3); today's "click" / computer-keys wording on an iPad (O4).
- Built: iPad layouts and edge states. `app/styles-v6-ipad.css`, `app/styles-v6-states.css` (both imported by
  styles-v6.css), `views/v6/start.js` (first-run Start here band, empty-library card); small changes in `perform.js`,
  `strip.js`, `lib.js` (popover clamp), `sidebar/sidebar.js`, `settings.js`, `components/startCard.js` (`songBar`
  wording, default unchanged). Interface notes: CONTRACT_CHANGES "## UI v6 U8a (iPad + edge states)".
- Layouts: landscape 1180 × 820 / 1366 × 1024 / 1024 × 768 is the Mac layout. The top bar never overlaps itself;
  at ≤ 900 px Quick is an icon, there is no meter, the clock shows only while recording and the ready words only
  when ready. At portrait (820 × 1180, 1024 × 1366):
  - the song bar has two rows;
  - 4 strips fit with no scroll, with the panel under them open or folded (7 scroll in their row);
  - the keyboard is full width over Revert / Fade out / PANIC / Lock (Perform and Edit);
  - faders keep ≥ 96 px in Learn / Arrange;
  - the chart's mini faders have their names above.

  On a touch screen every control is ≥ 44 px, except the Edit sentence's words (by design). Arrange at ≤ 790 px tall
  hides the 2 × 2 grid. Five or more sidebar tabs wrap at 220 px (a U7b overflow).
- Absorbed polish: **UI6-U4 O2** (strips at 150 px in portrait), **UI6-U4 / U5a O7 / U7c O1** (the top bar
  overlapping, the 820 px song bar), **UI6-U5b known** (keyboard ~260 px), **UI6-U6 O1** (rotation keeps the
  Settings category), **UI6-U6 O2** (summaries tick every 30 s while open), **UI6-move O2** (Enter on a name →
  the low handle; the focus comes back on Esc), **UI6-move O3** (small-window fold per orientation; only ⟨ / rail
  latch it).
- Edge states, each with its words on screen (tested):
  - first run: today's Start here card under the song bar (v6 wording);
  - loading: "Loading…" / "Preparing n of m" in the sidebar header and the lamp;
  - MIDI not allowed / no device: the lamp;
  - sound stopped (banner + Restart sound), restarting, asleep, paused (the start overlay);
  - Perform lock: one look; the strip name says it is frozen;
  - a muted second window: banner + "Muted";
  - storage full (D10): "Latest changes not saved yet — retrying";
  - empty library: a v6 card with New song / Song bank / Restore a backup, where today shows "No song" + "Loading…".
- Choices to confirm with Ryan:
  - Start here sits under the song bar (today: in Notes);
  - the empty-library card offers New song, which plays it;
  - the iPad portrait top bar hides the meter and the idle clock;
  - Arrange on short windows hides the Space / Echo / Octave / Sustain grid;
  - touch-only 44 px sizing (the Mac keeps today's sizes).
- Gates: ui-v6-ipad 27/27 (new), ui-v6 76/76 (purity vs 38c664b identical), ui-v6-edit 32/32, ui-v6-bank 17/17,
  chart 38/38, settings 111/111, ui-core 78/78, shell unit 384/384; engine / store / controller / shared / main.js
  unchanged. Screenshots: `/home/claude/design-out/u8a/`.
- Not done (U8b): the 8-theme contrast audit (tools/themes/shoot.mjs), incl. UI6-U6 O3.

## C-SHIP status (builder, 2026-11-27; lane-cship from v2-native c10ad59; skeptic pending)

- Built (D33): chord charts on by default (`settings.chartView` absent = on, false = off, device-local), Settings ›
  Perform › Chord charts in both Settings UIs, today's Chart toggle and the v6 Chart sidebar module shown by default
  and loaded only when used, "coming in 2.1" gone, chart-view O1 / O3 / O4 / O7 fixed. CONTRACT_CHANGES "C-SHIP
  (D33)".
- Purity: charts off identical to the base build (today's UI and v6); charts on with no charts: the same requests,
  listeners, intervals and store listeners, plus the entry only (Chart toggle; v6 Chart tab + rail icon).
- Gates: see CONTRACT_CHANGES "C-SHIP (D33)".
- Open: the skeptic pass; the chart's look stays part of U9 (Ryan's Mac review).

## Open questions carried into the build (decide, log in DECISIONS, tell Ryan)

- **Snapshots vs today's scenes.** Today: up to 3 scenes per song, levels / ON / drone level / wheel only. The v6
  mockups show named snapshots that may also hold Space / Echo and the drone. U1 shows the existing scenes in the
  snapshots row (names "Scene 1…" until named; no schema change). Widening what a snapshot holds is a separate,
  logged decision. **U7c → D25:** snapshots stay today's scenes; an optional name per scene (no SCHEMA bump); widening
  stays open for Ryan.
- Chart and song bank pieces already exist hidden (chart view D7, bank O-AW-PP); U7 reuses their logic.

## U8b status (builder, 2026-11-26; lane-u8b from v2-native dcb2f06; rebased onto 9217f7a; skeptic done)

- **Skeptic (2026-11-26): VERIFIED after fixes** (`native/docs/reviews/UI6-U8b.md`).
  - Fixed:
    - F1: field placeholders were unaudited and failed in all 8 themes;
    - F2: text beside a popover / Quick under its shadow failed as drawn on the dark themes;
    - F3: at 820 px, Start here + Learn / Arrange left the faders no track (U8a layout).
  - The audit and the tour now cover the iPad sizes, U8a's surfaces, field words and shadows; ui-v6-themes runs all
    three sizes.
  - For Ryan: O1 (the Quick sheet over the keys at 1280 × 800), O2 (design calls with before / after values) and
    O3 (Bass lighter costs Extra / Bass luminance separation).

- Built: the shared audit `tools/themes/audit-lib.mjs` (shoot.mjs now imports it; + clipping, scrim hit-test for
  `::after`, closed `<details>`, drop-shadow pixels, edge fades, and a WCAG 1.4.11 half: focus rings, field edges,
  switch thumbs), the v6 tour `tools/themes/v6-tour.mjs` / `shoot-v6.mjs` (38 states × 8 themes, 1280 × 800, contact
  sheets) and the suite `test/phase2/ui-v6-themes/run.mjs` (in run-all). Fixes are colour only: v6 tokens
  (`--v6-sh`, `--v6-scrim`, `--v6-danger`, `--v6-ok`, `--v6-cmix`, `--v6-tint-text`, `--v6-field-line`), day-theme
  position sets for 4..6, `--slot-3` a step lighter in Studio / Nave / Daylight Day, focus rings in `--focus`, Daylight's
  engine note (O3) and EQ focus. Details and numbers: CONTRACT_CHANGES "## UI v6 U8b (themes)".
- Before → after (the final tool on dcb2f06 vs this lane): text 274 → 0, focus rings 138 → 0, field / switch edges
  354 → 0 over 8 themes × 38 states; today's screens 1 → 0 (O3). Gates: ui-v6-themes 8/8 (0 errors), themes 58/58,
  ui-v6 76/76 (flag-off purity vs dcb2f06 passes), settings 111/111 (5 modes incl. v6); engine untouched.
- For Ryan / design calls: the day themes' positions 4..6 are new colours (Sanctuary Day deep glass, Daylight Day
  pastels); v6 switches now have a dark thumb when on; field borders are visibly stronger (3 : 1) in every theme;
  popover and Quick sheet shadows are lighter. Edit's song name has no field edge (a title with ✎): exempted, not
  changed. At 1280 × 800 the v6 Quick sheet's foot reaches the keyboard (layout: U8a).
- Not covered: iPad sizes (U8a's layouts; the tour is 1280 × 800 only), hover / pressed / dragging states, the
  learn-picked green outline on paper (no state for it in the tour), focus rings of controls hidden behind others.
