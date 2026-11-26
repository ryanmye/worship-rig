# U-MOVE (slot insert / move, D23), store + controller half: skeptic review (2026-11-26)

Verdict: **VERIFIED, after fixes.** As delivered, the change was PARTIAL: the slot ops themselves held under every
sequence I tried, but the Revert realignment (the part that protects scenes) stopped working after a few seconds of
ordinary editing.

Under review: commit 7dd1a51 on lane-move, on top of v2-native 7f1b128. It adds `store.insertSlot` /
`store.moveSlot` / `store.onSlotMap` and an in-memory slot lineage to `store.js`, an `onSlotMap` hook and `liveBefore`
to `controller.js`, a comment in `shared/scenes.js`, `test/phase1/shell/slot-move.test.mjs` and the CONTRACT_CHANGES
section "Slot insert / move (D23)". I didn't build it.

These claims held:

- **The slot ops.** `insertSlot(id, after, slot, {scenesFrom})` returns the index or -1, and `moveSlot(id, from, to)`
  returns a boolean. Each one does a single `put(['songs', id])` and a single `changed()`, so there is one
  notification (`songs.<id>`). Bad arguments, from === to, MAX_SLOTS and a missing song write nothing.
- **What travels with the instrument.** I checked this with a property test against a model, 1,800 random
  sequences of 60 steps each: insert (empty, filled, with and without scenesFrom), move, remove, add, gain edits,
  scene edits, wheel / pedal / knob target writes, snapshot and whole-patch Revert. Each slot carried a unique tag.
  After every step:
  - each scene's entry belonged to the tagged slot it was saved for;
  - every `slots.<i>.gain` target pointed at the same tagged slot as before the step (or at the default when its
    slot was removed);
  - `migrate(migrate(x))` equalled `migrate(x)`.
  At the end of each sequence:
  - the persisted song equalled the normalised in-memory song;
  - export → import(replace) round-tripped;
  - neither the export nor the persisted library held any lineage key.
  With F1–F3 fixed: 0 failures in 1,500 sequences. Before F2: 4 of 300 failed.
- **Nothing else in a song is slot-indexed.** I searched the song shape, the store's normalisers and `shared/`:
  - Everything per slot lives inside the Slot object, so it travels byte for byte: range, sends, EQ, sustain,
    `release` / `pedalHold`, touch, width, params.
  - Wheel targets can only be `slots.<i>.gain` (`isWheelTarget`).
  - Nothing else holds a slot index: chart, drone, fx, bend, swell (`seconds` / `pedal`), and the scenes' `drone` /
    `wheel`.
  - Setlists hold song ids only (`normalizeSetlist`).
  - `settings.keyboards` is keyed by device name.
  - MIDI learn (`settings.midiLearn`), the controller's pickups and pending learned writes stay positional, as
    D23 tier 2 and O-AW-ML rule 2 say.
- **The controller.**
  - **Fake-engine fuzz.** I modelled the engine's state as prepare → commit → setParam → setRouting and replayed
    random sequences against it: moves, inserts, removes, level moves through `scenes.adjust`, scene saves and
    steps, `revertSong` and target writes. I ran both engines (16 slots and 4 slots), and prepares that resolve at
    once as well as prepares held back (manual). That makes 440 sequences of 40 steps.
  - **What the fuzz checked.** After each settle, the engine's instrument, gain and pan matched `scenes.view(song)` in
    every slot the engine plays, and its wheel routing matched the song (`none` past the web engine's slots). There
    were 0 failures.
  - **The fuzz can see a fault.** Removing `liveBefore` makes it fail.
  - **Navigation.** On both engines and both prepare modes, the committed patch was the song's current layout in
    all three cases:
    - a move in a cued song, then GO;
    - a move in the song being selected while it prepares;
    - a move in the playing song while the next one loads, then going back.
- **The web engine in Chromium** (a real app probe, `controller.perform` input):
  - Moving an organ from slot 5, which the web engine doesn't play, to slot 1 re-prepares the patch. The engine's
    slot 1 then is the organ, and its slots 0..3 equal the song's.
  - A note held across the move rings on the retired channels. Slot 0's channel was reused (same instrument, same
    params). Note-off ends it.
  - A new note sounds on all four slots, the organ included.
  - A pedalled note across a move back is released by pedal-up.
  - console.error 0, HTTP ≥ 400 0.
- **Revert.** All three Reverts (perform.js, v6, `controller.revertSong`) write only the saved fields. A whole-patch
  write that equals the snapshot restores the slot order and the targets exactly, and with the lineage the scenes too
  (the builder's tests, plus F1–F3 below).
  - Today's Revert semantics are unchanged: scenes are still not a Revert field, and Revert still goes back to the
    song's own levels.
  - A reorder counts as a change for Perform's count and Edit's dots (`patch` differs).
- **Boundaries.** `git diff 7f1b128` touches nothing in `app/js/engine` or the views. The `shared/` change is a
  comment. No `setTimeout` was added.

Three things did not hold. All three are fixed, each with a test that fails on the old code.

## Findings

- **F1 (medium) Ordinary editing pushed the Revert layout out of the lineage, so a move + Revert put the scenes on the
  wrong instruments again.**
  - `noteLayout` records one layout per slot write and kept the last 256, dropping the oldest. That is about 4 s of a
    fader drag (about 60 writes a second), two sweeps of a learned CC (128 writes each, not throttled), or a slow range
    drag.
  - After that the pre-move layout was gone, so Revert was positional again. In the probe, a move, 300 writes, then
    Revert left the scene at `[0.2, 0.3, 0.4, 0.1]` instead of `[0.1, 0.2, 0.3, 0.4]`. That is the same misalignment
    the lineage was built to fix.
  - Fix (7ffb990, `evictLayout`): every entry now records `at` (the store's `now()`). When the history is full, the
    first and last layout of each token run are kept (right after and right before a re-order, the usual Revert
    snapshot), and so is the newest. Of the rest, the one that was current for the shortest time goes (a drag's
    in-between values); on a tie, the oldest goes.
  - Test: a move then 600 drag writes; a snapshot in the middle of a run, then drags, a move and more drags; and the
    same with a frozen clock.
- **F2 (low) A Revert to a shorter layout kept the removed slot's scene entries, and the next added slot inherited
  them.**
  - `realignFor` treated an earlier layout whose tokens are a prefix of the current ones as positional.
  - Example: Duplicate the last instrument (insertSlot at the end with `scenesFrom`), Revert, then "+": the new slot
    played the copy's scene level. The same happened before D23 with add, scene, Revert. Only a reload cut the entries.
  - Fix (9d9cfa2): equality now also needs the same length, so the prefix case realigns, and the scenes are cut to the
    restored slots in the same write (the slot map is the identity).
- **F3 (low) removeSlot + scene deleted + Revert gave the restored slot another scene's level.**
  - The removed slot's scene entries are kept by scene index. After the first scene was deleted, the remaining scene
    got the deleted scene's level for the restored slot: 0.2 instead of its own 0.6.
  - Fix (d478fd1): the kept entries are used only while the song has as many scenes as at the removal. Otherwise the
    slot comes back uncovered, as it did before D23.

These are acceptable or not defects:

- **Two deep-equal slots** (a Duplicate) swapped and then Reverted keep their scene entries swapped. Content
  matching can't tell the two apart, and the newest match wins. Both are the same instrument with the same params,
  so they sound the same. Only which strip shows which scene level differs.
- **A coincidental match.** Only the three Reverts write a whole `patch` or `patch.slots` through `set`; imports and
  pack updates use `put` or whole-song paths, which stay positional. So realignment only happens on a write that
  restores an earlier layout, and the newest matching layout wins (writing the current layout is a no-op).
- **Page reload.** The lineage is lost, but every Revert snapshot is per session too (controller `selected`,
  Perform's `snap`, Edit's `getBaseline`; nothing is in sessionStorage). After a reload Revert restores the
  post-reload layout, so nothing needs realigning. That is at least as good as before.
- **Library replace / instance takeover.** `importJSON` (replace) and `reload()` clear the lineage, and Revert is then
  positional. The controller already refreshes its `selected` snapshot on a generation change (round2-shell #3).
- **Memory.** The lineage holds at most 256 layouts and 64 removed slots per song, and only for songs written in
  this session. Layouts share structure with the state: each one is a new array of up to 16 refs plus the slot that
  changed. That is about 0.4 MB in the worst case for one heavily edited song. A deleted song's line goes at its next
  put. Nothing is persisted.
- **Patch packs.** A move changes `songFingerprint`, so a pack song counts as edited and pack updates stop, as after
  any edit. A Revert that restores it exactly makes the fingerprint match again.
- **Not normal form in memory** (pre-existing, not D23): after addSlot or a positional shrink, a scene can have fewer
  or more entries than the song has slots until the next load. `migrate` is idempotent, and the persisted song is the
  normalised one.

## Gate

The box had 2 CPUs. Another skeptic's ui-v6 run was on it at times, and the load average was 3–9. I ran the suites
one at a time.

| suite | result |
|---|---|
| slot-move (`node --test test/phase1/shell/slot-move.test.mjs`) | **13/13** (10 + F1–F3); each new test fails on the code before its fix |
| shell unit (`test/phase1/shell/run.mjs --only unit`) | **356/356** (353 + 3) |
| shell browser (`--only browser`) | **18/18** |
| ui-core (`test/phase2/ui-core/run.mjs`) | 77/78. The failure is "H-v2 Quick sheet: TAP…": 4 taps 500 ms apart gave 84 BPM instead of 120 ± 20 (click overhead under load). Run alone it failed twice more (66, 91), and **the base 7f1b128 fails it the same way** (94), so it is environmental and not caused by this change |
| edit-v2 (`test/phase2/edit-v2/run.mjs`) | **14/14 files** |
| ui-v6 (`test/phase2/ui-v6/run.mjs`) | **27/27**. The flag-off purity check (against the merge-base 7f1b128) passes, so U2's purity fix holds on this branch |
| store property test (model, 1,500 × 60 steps, after the fixes) | 0 failures |
| controller fuzz (model engine, 440 × 40 steps) | 0 failures |
| web-engine probe in Chromium | as above; console.error 0, HTTP ≥ 400 0 |
| Electron / Mac, real MIDI hardware | not run |

## Fixes (commits on lane-move)

- 7ffb990 `store.js` `evictLayout`, plus test "skeptic F1": F1.
- 9d9cfa2 `store.js` `realignFor`, plus test "skeptic F2": F2.
- d478fd1 `store.js` the Revert fill, plus test "skeptic F3": F3.
- This review, plus a skeptic note in CONTRACT_CHANGES "## Slot insert / move (D23)".

## Open items

- **O1 For the UI task (v6 Duplicate / Earlier / Later / drag, Edit).** A move keeps the slot count, so these
  count-keyed protections don't fire on it:
  - v6 `strips-row.js` `slotsSig` and `perform.js` (U1 F2, U2 F3) are keyed on `id:count`. A move during a range
    drag, a pick or an open ⋯ menu would write to the neighbour. Key them on the order, through `store.onSlotMap` or
    the instrument refs.
  - Edit's 8 s Undo for "Remove this sound" and for an instrument change (`panels/slot.js`) writes back by index.
    After a move it can land on another slot.
  - Edit's selected block (`ctx.editState`) is positional.
- **O2 Ryan: MIDI learn stays positional** (D23 tier 2): a learned knob keeps moving "strip i" after a reorder, as
  documented. Revisit if he expects knobs to follow an instrument.
- **O3 Not verified.**
  - The Electron / Mac app and the native (bridge) engine; only the fake engine stood in for 16 slots.
  - Real MIDI hardware: I used `controller.perform`.
  - Two windows writing the same library at once (pre-existing H2 territory).
  - A held note through a same-instrument swap on the real engine. By design it keeps its channel and takes that
    index's new params; I checked this on the fake engine only.
