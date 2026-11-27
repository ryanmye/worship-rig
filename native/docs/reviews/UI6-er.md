# U-EDITRANGE (D26.2) + UI v6 polish batch 2: skeptic review (2026-11-27)

Verdict: **VERIFIED.** I found no defect in the lane's app code. Perform's range bars behave exactly as on the base
on 16 scripted gestures. The Edit row's guards hold on every cancel path I tried, including three the builder's
tests don't cover. B1–B4 do what CONTRACT_CHANGES says. One fix, in a test only (F1): the "polish1 U5a P1" flake
was already there on 03293a3, and it came from a race in the test's own probe. That probe is now deterministic.
Two open items are for Ryan / the orchestrator: a sound left loaded in an empty library (O1), and multi-touch on
two range bars at once (O2).

Under review: 3b18016, 7818e21, 1c9846a, b17865c and 298d2c2 on lane-er, based on v2-native 03293a3. The lane
leaves `app/js/engine/`, `shared/`, `store.js` and `main.js` untouched. `controller.js` changes only in
`backFromTrial`. Probe scripts were run against both trees and are not committed. The base tree was a temporary
worktree at 03293a3, removed afterwards.

## A. range-guard.js, Perform unchanged, Edit's bars draggable

- **Perform, base vs lane, behaviour identical.** One probe ran the same gestures against both trees and recorded
  every `lowNote` / `highNote` write (song, slot, field, value), the final ranges of both songs, and the
  picked / dragging state. The gestures were:
  - a commit;
  - drags interrupted by Lock, a song switch, `moveSlot`, `insertSlot` before the slot, `addSlot`, removing an
    earlier slot, removing the dragged slot, the flag going off, and a view switch;
  - Esc during a pick, Esc during a drag, and pointercancel;
  - a touch drag with a second touch pressing and releasing another handle (ignored);
  - a pen hover, then a pen drag ending in pointercancel;
  - a press-drag on an unpicked bar.

  The two JSON outputs differ only in the number of throttled live writes (4 vs 5, which depends on timing). The
  final ranges, the first and last write, the slots written, and the picked / dragging state were identical. Each
  restore landed on the instrument that was dragged: the shifted index after a remove, insert or move. A removed
  instrument got no write. A song switch never wrote to the next song.
- **Code reading confirms it.** `sync()` runs the base's three checks in the base's order: the song switch, then
  the slot count signature (only when the song is the same), then the view. They run at the same point of
  `render()`, after the row and bar closes of a song switch and before `row.cancelDrags()` for the view. `shown` is
  updated after the drops, so a restore goes to the song that was shown (as `shownId` did). `slotMap` keeps the
  `id !== shownId` early return and `row.slotMap()` before the remap. `kb` is read lazily. Perform does not opt in to
  blur.
- **Edit, beyond the builder's nine paths.** These held:
  - Removing an earlier slot mid-drag: the restore lands on the moved instrument.
  - Removing the dragged slot: nothing is written.
  - `insertSlot` before the slot: the restore lands at the new index.
  - A MIDI note (`controller.perform.noteOn`) mid-drag doesn't disturb the drag, and the release commits.
  - The window blur listener is added once per mounted Edit. It survives view flips (net 0). It is removed when the
    flag goes off and comes back with the flag on. Nothing leaks.
- **"Two picks" is not a bug.** I tried Edit › Range open on instrument 0 (its own live bar) while the bottom row had
  instrument 1 picked.
  - Dragging the Range panel's bar leaves the bottom pick alone.
  - One Esc mid-drag both cancels that drag (the panel's Esc handler, value back) and closes the bottom pick. Both
    are window listeners on the same Esc, so the drag is never committed.
  - With "Set highest by playing" armed and a bottom pick open, the first tap on the bottom keys only finishes the
    pick (D24.3, no note), and the arm stays armed. The next tap sets the range. That's consistent, though it costs
    one extra tap.
  - The hidden Perform's pick and Edit's pick share the overlay group `v6-range-pick` and can't both be open. Each
    guard drops its own pick when the view isn't its own.
- **The old Edit `setRange` "cancel during song switch" bug** was real in the code (it read the current song) but
  couldn't be reached on 03293a3: the bars were `barsReadOnly`. The guard's `shown` fixes it for the now-live bars
  (builder's `song` path).
- **Native bridge.** Live writes in Edit take Perform's path: `store.set` → `controller` store diff →
  `engine.setParam`. Edit's own `ctx.set` adds nothing the bars need: the dots and Revert read the store against the
  baseline. I didn't run it against a native build.
- **Throttle and cost** (ui-v6-edit gate, this box, another suite running): 20 live writes, all gaps ≥ 40 ms. One
  Edit write plus its render: median 2.3 ms, p95 8.3 ms, max 10.3 ms.

## B1. `underModal`

Probe on both trees, with "Esc always panics" off and on:
- Ctrl+. under Settings, with the Quick sheet and a range pick open, panics at once.
- The on-screen PANIC tap still panics with both open.
- Esc order on the lane: Settings → pick → Quick sheet → panic. With "Esc always panics" on, each Esc after Settings
  closes also panics. On the base, the Esc that closed Settings also closed the top overlay. That is the change O1
  of UI6-polish1 asked for.
- The ui-v6 polish2 test covers the five overlay kinds and the flag-off Quick sheet.
- `quickSheet` / `stepChip` default `underModal` to false, so the flag-off Perform is unchanged (purity identical,
  and the polish2 flag-off test).

## B2. Back into the gap

The rule moved verbatim, apart from `settings()` for `store.get().settings`: the same reads before the switch and
the same two writes after `selectSong` resolves true. The banner keeps only the toast. The two Back paths are
`views/v6/bank/banner.js` and `views/v6/perform.js` `destroy()` (a grep finds no other caller). Both now reach the
rule, and `destroy()` is covered by the ui-v6-bank "polish2 O2" flag flip. The shell `bank-trial` O2 test covers the
setlist positions (b in the gap at 1, Prev a, Next c; no gap for an entry that is still there). The banner test
"polish1 U7a O2" still passes unchanged.

## B3. Back from a trial begun in an empty library

Probed in the browser with a bank song whose drone is on:
- Back returns `{ok: true, empty: true}`. Afterwards `currentSongId` is null, there are no songs, the banner is gone
  and the empty card is back. Saved: no songs, `currentSongId` null, and nothing persisted during the trial.
- **Back while the trial is still loading**: Back ends it, and the pending `applySong` sees its song gone and returns
  false. The result is no selection, no trial and no trial song. Try it reports "The song could not be loaded." That
  is the same as Back during a load in a non-empty library, so it is pre-existing.
- **Reload afterwards**: an empty library and silence (the engine is fresh).
- **New song afterwards**: selected and loaded (`status.songId` = the new id). A store-level replace selects in the
  same way, because the controller's `cur !== targetId` with `targetId` null.
- **The sound left behind** is O1 below.

## B4. v6 Edit title ellipsis

- No window or document listener and no interval: a `ResizeObserver` on the field, binder `fn(['name'])`, an
  element `input` listener and one `requestAnimationFrame`. All are released through `core.cleanups`. Purity is
  identical; the v6 Edit isn't mounted with the flag off anyway.
- One read pair per frame, inside the frame. Toggling `long` changes `text-overflow` only, so the size doesn't change
  and the observer doesn't loop.
- `.long:not(:focus)` (today's CSS) means a focused rename shows the whole text. `input` re-runs the check, so the
  title follows the typed value.
- Today's header also re-checks on window `resize`, so the two writers agree on the same rule. The gate test covers
  three sizes, a resize back and a long rename.

## Findings

- **F1 (test, pre-existing on 03293a3; fixed).** The ui-v6-edit "polish1 U5a P1" probe wraps
  `requestAnimationFrame` to count layout reads made outside a frame. The race:
  - A frame the range label asked for before the wrap (the set-up's writes or the pick) runs unwrapped.
    `rafCoalesce` reuses that pending frame instead of asking again.
  - `until()` returns as soon as the label's text is set, which can be before that frame.
  - So the old frame's in-frame reads counted as "forced" (2) whenever it landed in the probe's window, which
    happens more often on a loaded box.

  Alone, the test passed 3/3 on the base. A probe on the base that leaves one frame pending gives `forced` 2 every
  time without a drain and 0 with one. The fix is in the test only:
  - `tipProbe` now makes that pending frame itself (`pre`, so the case is always present).
  - It lets the frames already asked for run before it wraps.
  - Its window now also covers the label's own (wrapped) frame, so the check is stronger.

  Without the drain the test fails on every run ("Edit: layout reads outside a frame: 2"; 2/2 runs). With it, it
  passes (3/3 alone, and in the full gate). Commit 50032f1, which also wraps one UI6-build-plan line that was over
  120 characters.

## Gates (lane-er after F1, one suite at a time, PLAYWRIGHT_BROWSERS_PATH=/root/.cache/rig-pw)

| suite | result |
|---|---|
| shell unit (`test/phase1/shell/run.mjs --only unit`) | **386/386** |
| ui-v6 (incl. flag-off purity vs 03293a3) | **78/78**, purity identical (105 requests, 15 store listeners, 2529 els) |
| ui-v6-edit (incl. purity, F1's test) | **41/41**, purity identical (1047 elements in Edit) |
| ui-v6-bank | **23/23** |
| ui-v6-ipad | **29/29** |
| settings (app, fixture, mac, bridge, v6) | **111/111** |
| ui-core | **91/91** (7 + 6 + 78), 0 fail |
| edit-v2 | **14/14 files** |

0 console.error and 0 HTTP ≥ 400 in every browser suite above (each suite's own check) and in my probes.
`app/js/engine/` is untouched (`git diff 03293a3 -- app/js/engine` is empty).

## Open items

- **O1 (Ryan / orchestrator): an empty library keeps the last sound loaded, drone included.**
  - Measured after Back from an empty-library trial of a song with a synth drone: `engine.drone.sounding` stays
    true in mode 'synth', and the keys play the trial's instruments. `controller.menuBarState().droneOn` says false,
    and the sidebar's Drone module is drawn with no song behind it.
  - It is not new: deleting the last song leaves the deleted song's sound and drone the same way, as measured
    before the trial in the same probe. PANIC leaves the drone untouched in any state (engine `allNotesOff`).
  - Fade (`v6-fade`) is on screen and fades the drone. A reload is silent.
  - Back makes the state reachable from one more place. Since the empty library before the trial was already
    "something loaded", Back can't return to silence by itself. If the empty library should be silent, the fix is
    one controller step for both paths: drone off and fade out the voices when `currentSongId` becomes null with no
    songs. That is a sound-behaviour decision, so I didn't make it.
- **O2 (low): two range drags on the same instrument at once (multi-touch, iPad: Edit › Range's bar with one finger,
  the bottom bar with another) both write live.** The last write wins and each cancel's `expect` check keeps a
  restore off the other's value. Not reachable with a mouse. The same shape exists on Perform for a held Revert
  (850 ms) during a touch drag: Revert writes, and the drag's next live write puts its value back. Note only.

## Not verified

- A native (2.0 core) build: the bridge path was read, not run.
- Real touch hardware: touch and pen were checked with synthetic PointerEvents and Playwright only.
- The Electron / Mac suites, chart, migration-1x and ui-v6-themes were not run. ui-v6-themes was the other agent's
  job on this box.
- The full ui-v6-edit suite on 03293a3, to catch the flake in the act: I proved the race with a targeted probe on the
  base instead.
