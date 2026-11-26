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

## Queued small tasks

- **U-MOVE (D23):** store `insertSlot(after)` / `moveSlot(from, to)` (carry scenes, wheel targets, instrument
  fields; MIDI learn stays positional), v6 Duplicate next to the original, ⋯ Earlier / Later, drag-to-reorder strips
  (and in Edit's rig tabs later); PANIC and Lock back to a tap.
- **U-METRO (D23):** Metronome sidebar module (today's click chip behaviour) + load state in the sidebar header.

- **Preview switch for Ryan (U1 review O3):** `?ui6=1` only works in Chrome; the Mac app needs a visible way to turn
  v6 on for the U9 review. Add "Try the new layout (preview)" in Settings (today's Settings, Look or Mac category),
  writing `settings.uiV6`. Before U8 ends.
- Pre-existing red suites to fix separately: eq "L-21 note labels fit" (fails on base), engine suite's 404 on
  `/__tests/api/health` and the CPU-timing `offline.eqCpu` on the 2-CPU box.

## Open questions carried into the build (decide, log in DECISIONS, tell Ryan)

- **Snapshots vs today's scenes.** Today: up to 3 scenes per song, levels / ON / drone level / wheel only. The v6
  mockups show named snapshots that may also hold Space / Echo and the drone. U1 shows the existing scenes in the
  snapshots row (names "Scene 1…" until named; no schema change). Widening what a snapshot holds is a separate,
  logged decision.
- Chart and song bank pieces already exist hidden (chart view D7, bank O-AW-PP); U7 reuses their logic.
