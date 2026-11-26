# UI v6 move + D24 tweaks (U-MOVE UI, U-TWEAKS, small-window fit): skeptic review (2026-11-26)

Verdict: **VERIFIED, after fixes.** As rebased the work was PARTIAL: ui-v6 ran 67/68, and an Esc during a range drag
did not cancel the drag. I fixed both. Neither touches the engine or the store, and neither loses a sound.

Under review: seven commits on lane-moveui, built on b163c20 and rebased by the coordinator onto v2-native 715b936
(U1–U4, the slot insert / move store API, the Click module, the Esc setting and the preview switch, all
skeptic-VERIFIED). `test/phase2/ui-v6/run.mjs` and the docs conflicted. I didn't build them.

- 346d332 Edit: the selected tab and the 8 s Undo follow a slot move (`edit/shell.js`, `edit/panels/slot.js`).
- 69d5994 D24.6 drone percentages. 1d9bac4 small-window fit. dba4cf8 D23.1 PANIC / Lock taps.
- 4c2e9cd U-MOVE + D24.2 / D24.3 (`strips-row.js`, `strip.js`, `perform.js`, `keyboard.js`, `bottom.js`, CSS).
- fbdaea5 tests (`move.tests.mjs`), d125761 docs.

These claims held:

- **The rebase.** run.mjs keeps every check of 715b936 (29 `T(` calls both sides; three titles reworded for D23),
  the UI6-small F4 check, and the `moveTests` call. The whole suite runs; see F1 for the one check that then failed.
- **Module boundaries.** `git diff 715b936` touches nothing in `app/js/engine`, `shared/`, store.js, controller.js,
  main.js, server.js, today's `views/perform.js` or `views/components/`. No `innerHTML`, no new console calls.
- **Flag-off purity** against 715b936 (the suite's probe): 105 requests, 15 store listeners, 4 intervals, 2529
  elements, identical.
- **Today's Edit with the flag off.** The two Edit changes act only on `store.onSlotMap`. With the flag off the only
  slot maps come from Edit's own "Slots −" (always the last slot) and a realigning Revert after it. Both keep every
  other slot's index, so the selected tab and the Undo records don't move. Checked in the browser with the flag off:
  - a Remove's Undo brings the sound back;
  - "Slots −" leaves `slot:1` selected, and removing the selected last slot falls back to the count clamp, as before;
  - an Undo whose slot was removed meanwhile is refused, as before (the store refuses a write past the end; only the
    instrument-change toast's wording changed).
  - edit-v2 14/14.
- **Reorder + Revert** (probe, real grip drag and held Revert): with two scenes, a wheel target on slot 3 and four
  distinct ranges, a drag of slot 0 to the end and then Revert gave `patch` and `scenes` byte-equal to the snapshot.
  Duplicate, then Earlier on another strip, then Revert: also equal. A later Add doesn't inherit the copy's scene
  entry.
- **Reorder during a playing scene, with a held note and the pedal down:** the scene stays applied (`n: 0`), no
  error, and the note releases normally.
- **Drops at the ends:** far left of the row lands at 0, far right at n−1.
- **Drag cancelled mid-auto-scroll** (7 instruments, pointer at the row's right edge): Esc ends it, the scroll stops
  at once (162 → 162 px over 400 ms), no transform is left, nothing is written, no panic. Lock mid-scroll is the same.
- **Every live-write cancel path restores the start value**, on the right instrument and song:
  - Lock, Edit, a song switch, a pick switch, `pointercancel` (the builder's checks);
  - a move, an insert and a remove mid-drag (the instrument at its new index, or nothing when it was removed);
  - a song switch with a trailing live write pending: the old song gets its value back, the new one is untouched;
  - a v6 flag flip mid-drag;
  - Lock at 6× CPU throttle.
- **Throttle.** 24 live writes in a 2 s drag, gaps ≥ 53 ms, the last write is the release value. One write + its
  render: median 1.8 ms, p95 7 ms (16 instruments: 2.8 / 5 ms). At 6× CPU throttle: median 7.5 ms, p95 18 ms
  (16 instruments: 9.3 / 25 ms), so ≤ 20 writes/s stays under about a fifth of one CPU.
- **Esc (D24.7).** Off: the grip drag, the pick and the ⋯ menu each take one Esc without a panic; the next Esc panics.
  "Esc always panics" on: one Esc panics and also ends the grip drag (unwritten) or the pick.
- **Pick first for mouse users:** a press on an unpicked bar picks it and moves nothing; the cursor is a pointer over
  a pickable bar; the hint then says "click". The name's title says "Click to change which keys play this
  instrument".
- **Keyboard:** unpicked handles are `tabindex -1`; Enter on a name picks; the picked bar's two handles become tab
  stops; ←/→ write. Tabbing through the strips keeps the pick.
- **16 instruments:** Duplicate is disabled at 16. **D24.6** matches today's card ("Soft · 48%").
- **Small window.** Per device in the sidebar prefs; the rule is read once per page load, so resizing across 1100 px
  (1080 ↔ 810 ↔ 1180 ↔ 1000, twice) changes nothing and never scrolls the page. Opening in iPad portrait doesn't set
  `smallOpen`.
- Zero console.error and no HTTP ≥ 400, in the suites and in every probe.

## Findings

- **F1 (test, from the rebase) ui-v6 was 67/68.**
  - The D24.7 "Esc always panics" check came from lane-small. It runs after the U2 checks, and since D24.3 those leave
    a range pick open (the "U2 screenshot" drag picks Sub Bass first). The pick is an overlay with its own Esc, so the
    check's "the second Esc panics" waited forever. It passed alone (`UI6_ONLY=D24.7`).
  - The app behaved correctly: Esc closes what is open first, the pick included (D24.7).
  - Fix (aa44c39): the check starts with `kb.pick(null)`. Without it, `UI6_ONLY='U2 screenshot|D24.7'` fails.
- **F2 (low) An Esc during a range drag ended the pick but not the drag.**
  - The pick overlay's `onClose` set `picked = null` without `cancelDrag()`, which `pick(null)` does. The drag went on
    writing live (the bar no longer picked) and committed on release. Measured: 64 → 76 dragged, Esc, release: 76
    stored, with the setting off and with it on (that press also panicked).
  - The grip drag's Esc drops its drag, and the contract lists every other cancel as restoring. D24.3 brings this to
    the Mac, where a mouse drag plus Esc is natural.
  - Fix (f496b09, `keyboard.js`): the overlay's Esc cancels a drag in progress first (start value back).
  - Test: the D24.2 cancel-path check gains `esc` and `escPanics`. It fails without the fix.

These are acceptable or not defects:

- **An outside write to the dragged end mid-drag wins if the pointer doesn't move again.** With a whole-patch write
  mid-drag (a Revert with another finger), a release without further movement writes nothing, because the last live
  value was already sent. The store keeps the Revert, and the bar snaps to it on release. Any further movement
  re-applies the drag to that end. Before D24.2 the release always wrote. Reaching it needs two hands, and the
  result is "Revert wins", so I left it.
- **A positional whole-array write mid-drag** (no slot map, same count) would send the live writes to the instrument
  now at that index. Nothing on Perform does that while a drag is held (Edit's whole-array write, imports), and U2's
  write-on-release had the same exposure. The cancel's `expect` check stops a wrong restore.
- **Auto-scroll keeps a rAF loop running** while the pointer stays in the edge zone after the row hits its end (one
  rect read per strip per frame). It's cheap, and it stops on release or any cancel.
- **The empty slot's name is still a focusable `role=button`** that does nothing. It's harmless.

## Gate

The box had 2 CPUs, shared with lane-u5's suites (load average 3–8). I ran the suites one at a time.

| suite | result |
|---|---|
| ui-v6 (`test/phase2/ui-v6/run.mjs`) | **67/68** as rebased (F1; the builder's 63/63 was on b163c20, before lane-small's checks). **68/68** at f496b09 |
| flag-off purity vs 715b936 (in ui-v6) | identical (105 requests, 15 store listeners, 4 intervals, 2529 elements) |
| ui-core (`test/phase2/ui-core/run.mjs`) | 77/78 on the first run: today's Quick sheet TAP check got 93 BPM for 120 ± 20 (timing under load; code untouched by this lane). **78/78** on the rerun |
| edit-v2 (`test/phase2/edit-v2/run.mjs`) | **14/14** files |
| settings (`test/phase2/settings/run.mjs`) | **94/94** (the builder's 90/90 was on b163c20) |
| shell unit (`test/phase1/shell/run.mjs --only unit`) | **357/357** |
| probes (`/tmp/mvs/probe.mjs`, `small.mjs`; 1× and 6× CPU) | as above; 0 console.error |
| `run-all --fast`, Electron / Mac suites, real iPad | not run |

## Fixes (commits on lane-moveui)

- aa44c39 `test/phase2/ui-v6/run.mjs`: F1.
- f496b09 `app/js/views/v6/keyboard.js` and the D24.2 cancel-path check in `move.tests.mjs`: F2.
- This review, a skeptic note in CONTRACT_CHANGES "## UI v6 move + D24 tweaks", and the build plan's status.

## Open items (for Ryan / the orchestrator)

- **O1 The builder's choices to confirm** (build plan, "U-MOVE UI + D24 tweaks status"):
  - Lock unlocks with a hold (a tap locks);
  - the grip drags at once on touch;
  - a cancelled live drag writes the old value back even under Lock;
  - the finishing click on the keys plays no note on the Mac too;
  - a move drops a range pick rather than following the instrument.
- **O2 Keyboard reach of the range handles.** With pick first, a keyboard user presses Enter on a name and then Tabs
  through every strip control to reach the handles: 32 Tab presses with 3 instruments. Before D24.3 the handles were
  tab stops of their own (2 per bar). A cheap improvement: a keyboard pick (Enter / Space on the name) moves the focus
  to the picked bar's lowest handle.
- **O3 Small window on a 1080 px iPad (10.2", landscape).** The sidebar starts folded there. A rotation to portrait
  then shows the portrait panel folded too: the start decision carries over, although the rule exempts portrait. The
  player can open it with one tap, but opening it in portrait doesn't set `smallOpen`, so this repeats each launch
  until it is opened once in landscape. Also, any open in a small window latches `smallOpen` for good, including the
  song bar's Notes / Setlist chips (D24.5). That is the rule as written ("until opened there once"); Ryan may want
  only the ⟨ / rail opens to count.
- **O4 Not verified:**
  - the Electron / Mac app (its first-frame `innerWidth`, real trackpad scrolling mid-drag);
  - a real iPad (WebKit pointer capture on the grip, rotation);
  - real MIDI hardware during a reorder (I used `controller.perform`);
  - Cue / GO from the setlist UI mid-drag (the song-switch path it uses is tested);
  - themes beyond Sanctuary.
