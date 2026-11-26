# UI v6 U7c (MIDI Learn on Perform, Arrange, Save snapshot, song menu): skeptic review (2026-11-26)

Verdict: **VERIFIED, after fixes.** As delivered it was PARTIAL. The learn model, D25 names, Arrange, the Save
snapshot dialog and the song menu all did what the builder said. The gap was PANIC safety in learn mode: the
on-screen PANIC and a MIDI PANIC footswitch both stopped working while a learn waited (F1, medium). There was also a
dead end after a key was heard (F2, low) and an Esc that ended learn mode or Arrange when it only meant to close
Settings (F3, low).

Under review: 5d41b78, 4f473f7, b521ab7, 66ce55b and d7219b1 on lane-u7c (from v2-native f46bac4). They add
`views/v6/learn-mode.js`, `arrange.js`, `dialogs.js`, `song-menu.js` and `styles-v6-dialogs.css`; controller
`learnCapture()` / `learn(id, {heard})` / `scenes.save(n, {name})`; midi.js `accept: 'control'`; and
`shared/scenes.js` scene names (D25). They also touch `perform.js`, `settings.js`, `sidebar.js`, `snapshots.js`,
`songbar.js`, `strip.js` and `strips-row.js`. I didn't build it. I checked PANIC first.

These claims held:

- **The learn model is the existing one.** `learn(id, {heard})` runs the same code as every learn. It checks the
  Lock, the learnable check and the kind (`heardFor` is midi.js's rule: a fader takes a CC that is not 64 / 66 / 67,
  a button takes a note or a CC). It keeps min / max / invert on a re-learn, clears and reports C1 conflicts, and
  resets pickups. The mapping format and O-AW-ML rules 1–7 are unchanged. Tapping a target only picks it: the fader
  does not move, no step panel opens, and Fade out does not fade.
- **What `'control'` captures.** The structural CCs (0 / 32 / 6 / 38 / 96–101) are delivered normally. CC64 resolves
  `sustain-pedal-reserved` and keeps sustaining. CC120–127, Program Change, pitch bend, aftertouch and note-offs are
  never taken. A swallowed note-on never leaves a stuck note, because its note-off is delivered and releases nothing.
  CC1 / 7 / 11 and 66 / 67 are taken, as a fader learn takes them in Settings' table today (see O2).
- **A learned knob that is already moving.** Its first message is the capture and the rest drive its mapping (pickup
  as usual). Tapping a second fader then adds a second fader on that CC (O-AW-ML rule 4, see O3). A button on that
  CC clears the faders and the toast names them (C1).
- **Ends and restarts.**
  - Done, Esc, the Lock coming on, Edit, and the flag going off all end learn mode. The Lock also refuses to start
    it, including a right-click under Lock.
  - A song switch (Next, Program Change) or a slot move drops a half-made learn.
  - Exit cancels only our own capture. When Settings' table Learn… takes MIDI, learn mode ends quietly.
  - With D24.7 on, one Esc panics and leaves. Learn mode and Arrange never show together.
- **Badges stay positional (D23).** With `slots.0.gain` learned, `store.moveSlot(0 → 1)` leaves the CC21 badge on
  strip 1's fader, which the knob still moves. That follows O-AW-ML rule 2. Any change waits for Ryan (D23).
- **D25 names.**
  - `sceneNameOf` folds whitespace and strips C0 controls. It cuts at 40 code points, so it never splits a surrogate
    pair.
  - `migrate()` keeps names, drops bad ones and stays idempotent. The schema-1 path is unit-tested.
  - Export / import and Duplicate keep names, and so do slot moves (they spread the scene).
  - The chips, the fold chip and the toasts are text only. `<img src=x onerror=…>` showed as text and nothing ran.
  - "It keeps" matches `captureScene` / `applyScene` exactly: levels and ON / OFF of every filled slot, the drone's
    level, and the wheel only when the song routes it. `wheelNow()` is always a number, so the wheel is kept
    whenever the dialog says it is.
  - At 3 snapshots, Save as new is disabled and Enter means Update. Update keeps the name unless the field was
    edited. An emptied field removes the name.
  - Naming a scene changes the stored song, so a patch-pack song stops taking pack updates. Saving any scene already
    did that (O-AW-PP rule 3), so this is nothing new.
- **Song menu.**
  - Rename trims and folds whitespace and refuses an empty name. The 120-character maxlength was checked.
  - Duplicate puts the copy next to the song and does not select it. Add to setlist works.
  - Export writes `store.exportSong`. A trial song can't be exported from here.
  - Reset is Revert and is disabled while nothing changed.
  - Delete of the playing song selects the next one (M4, as in Edit). Delete of the last song is allowed, as in Edit.
  - Under Lock everything but Reset is frozen. The trial rules match U7a.
  - A song switch closes the menu (perform.js `closePops`), so its items never act on a song that is no longer
    playing. I added a check for this.
  - **Delete's backup path, simulated** with `ctx.rig.backupNow` present and `controller.backupNow` stubbed: a failed
    backup deletes nothing and says so, and a good one deletes and points to Import latest backup…. A pristine
    library writes no backup, matching `backupNow`'s own M5 rule.
- **Arrange.**
  - ◀ ▶ moves, the ⠿ drag (strips-row.js's own drag) and ✕ (needs the hold) all work.
  - The sidebar shows its customize list. A folded sidebar opens for Arrange and folds again, and the fold stays
    saved. A sidebar drag in progress is ended (`endDrag`).
  - A range pick that was open is dropped when a strip moves, so it can't outline the neighbour.
- **Esc order (D24.7).** With learn mode and the song menu open, the first Esc closes the menu and the next leaves
  learn mode. The same holds with the Save snapshot dialog open. Typing a space or Enter in the dialog's name field
  never picks a target.
- **Flag off and the engine.**
  - ui-v6's purity check against f46bac4 is identical (105 requests, 15 store listeners, 4 intervals, 2529
    elements).
  - Settings' table and Edit's learn menu still call `midi.learn` with `'fader'` / `'button'` and no `pass`, which
    behaves exactly as before. The settings and edit-v2 suites are green.
  - The engine and `shared/` (apart from scenes.js) are unchanged against f46bac4.
- **Zero console.error / HTTP ≥ 400** in every browser suite.

## Findings

- **F1 (medium, safety) PANIC didn't work while learning.**
  - On screen: a tap on PANIC in learn mode only picked it. In a stuck-note moment the big red button did nothing.
    Esc only left learn mode, so it took a second Esc or ⌘. to panic.
  - MIDI: `learnCapture` (`accept: 'control'`) took the next note or CC of any kind. The footswitch or pad learned
    to PANIC, pressed while a capture waited, became "CC 80 moved ✓" and did not panic.
  - There was also a quiet loss: tapping a fader after that cleared the PANIC mapping by C1 ("it was PANIC").
  - Decision: PANIC wins. A panic loses nothing, which is the builder's own D24.7 reasoning.
  - Fixes:
    - e4706f6: `midi.learn()` takes an optional `pass({cc|note, channel})`, and a matching message is delivered
      normally. `learnCapture` passes the live PANIC mapping, with channel overlap as in `learnedAll`. Settings'
      table learn has no `pass`, so re-learning the PANIC control is still done there.
    - 65f5c01: a tap, click or Enter on PANIC in learn mode panics, then picks it. A right-click still only picks.
  - Tests:
    - scene-names.test.mjs: the PANIC CC on any channel and a PANIC note on channel 10 pass through and panic, while
      the same note on another channel is captured. It fails without the fix.
    - ui-v6 "Learn on Perform from Settings": the tap on PANIC panics once, the learned pad panics during a capture,
      and the capture keeps waiting. It fails without the fix.
- **F2 (low) Dead end after a key or pedal switch was heard.**
  - Hearing a key or pedal switch and then tapping a fader gave "tap an outlined control, or move a knob first", but
    the capture had already ended, so moving a knob did nothing.
  - The only ways out were Done, or tapping an action. Tapping an action mapped the stray key to it (PANIC on
    middle C).
  - Fix (65f5c01): the tapped fader stays picked, the key is forgotten, and the capture waits again. A key heard
    while a fader is picked is refused the same way.
  - Test: the same ui-v6 check, which fails without the fix.
- **F3 (low) The Esc that closed Settings also ended learn mode or Arrange.**
  - Both are overlay.js overlays that stay open under Settings. overlay.js's window Esc listener runs after
    main.js's Settings one, so one Esc closed Settings and ended learn mode, which lost the heard knob. It ended
    Arrange too. An Esc that only cleared Settings' search did the same.
  - Fix (a73c88f): main.js marks an Esc pressed while Settings is open (`e.rigSettingsEsc`, an expando). overlay.js
    leaves an `underModal` entry alone for it. Only learn-mode.js and arrange.js opt in, so flag off behaves exactly
    as before (purity identical).
  - Test: ui-v6 "U7c skeptic F3", which fails without the fix.

These are acceptable or not defects:

- **Esc with "Esc always panics" on**, in learn mode or Arrange: it panics and leaves, which is the builder's
  choice. It is consistent with every other Perform overlay, and a panic loses nothing.
- **The first key played in step 1 is captured** as "Note 60 moved". That is what `'control'` is for (pads). With
  F2 it is no longer a trap. Its note-off is delivered, so the key doesn't stick.
- **The emoji limit.** The field's `maxlength=40` counts UTF-16 units, so 20 emoji fit in the field while storage
  takes 40. Text pasted into the field is cut there too. It errs short, and nothing is lost.
- **Grapheme clusters at the cut.** A ZWJ sequence that straddles the 40th code point can lose its tail, and only
  C0 controls are stripped (bidi overrides stay). This is cosmetic and limited to the player's own text.
- **Lock coming on while the song menu is open** (only reachable without a click, for example from a script): the
  items stay drawn as enabled. Their actions re-check the Lock and do nothing. Duplicate then says "Could not
  duplicate".

## Gate

The box had 2 CPUs, shared with another lane's measuring script. I ran the suites one at a time.

| suite | result |
|---|---|
| shell unit (`test/phase1/shell/run.mjs --only unit`) | **384/384** (+1: F1) |
| migration-1x unit (`node --test test/phase2/migration-1x/*.test.mjs`) | **107/107** |
| ui-v6 (incl. flag-off purity vs f46bac4) | **76/76** (+2: song menu song switch / Mac backup, F3), purity identical |
| ui-v6-bank | **17/17** |
| ui-v6-edit | **32/32** |
| settings (app, fixture, mac, bridge, v6) | **111/111** |
| ui-core | **78/78** |
| edit-v2 (all 14 files, incl. learn 3/3) | **117/117** |
| each new check against the pre-fix code | F1 (unit and browser), F2 and F3 fail without their fixes |
| console.error / HTTP ≥ 400 | 0 |
| Electron / Mac suites, migration-1x browser | not run |

## Fixes (commits on lane-u7c)

- e4706f6 F1, MIDI side (`midi.js`, `controller.js`, `scene-names.test.mjs`).
- 65f5c01 F1 on-screen PANIC and F2 (`learn-mode.js`, `dialogs.tests.mjs`, including the song menu checks).
- a73c88f F3 (`main.js`, `overlay.js`, `learn-mode.js`, `arrange.js`, `dialogs.tests.mjs`).
- This review, plus a skeptic note in CONTRACT_CHANGES "## UI v6 U7c" and in the build plan's U7c status.

## Open items

- **O1 820 × 1180: the song bar overflows (low, U8).** ⋯ adds about 44 px. The song name shrinks to "Sun…" and the
  Setlist button is cut at the right edge. The builder saw this too. The top bar's status text also overlaps at this
  width, which is not from U7c.
- **O2 The mod wheel, CC7 / CC11 and pedals 66 / 67 can be captured in step 1 (for Ryan).** Touching the wheel
  while learning gives "CC 1 moved". Tapping a fader then makes the wheel move that fader as well as its routed
  target. Settings' table allows the same thing today. One option is to skip CC1 / 11 in `'control'` the way the
  structural CCs are skipped. It is Ryan's call, because some players want a wheel on a level.
- **O3 Reassign or add? (for Ryan).** Moving a knob that is already learned to a level, then tapping Space, makes
  it drive both (O-AW-ML rule 4). The toast says only "CC 21 → Grand Piano Space ✓", while both controls show a
  CC21 badge. A player may expect the knob to move over to Space alone. At least the toast could say "also moves
  Grand Piano level".
- **O4 Delete's hold text doesn't say the song leaves every setlist.** Edit's confirm does. The menu does show
  "in My Set" on Add to setlist.
- **O5 A Chromium touch long-press on a strip fader starts learn mode** (contextmenu). That covers touchscreen
  laptops only: iPad Safari sends no contextmenu (O-AW-ML O1 stays open) and Ryan's Mac has no touch screen.
- **O6 Choices to confirm with Ryan**, from the builder, plus mine:
  - The name heuristic.
  - "CC21" badges instead of "K1".
  - Update keeps the old name unless the field was edited.
  - Rename is refused on a trial song.
  - Arrange orders the sidebar from a list.
  - Mine (F1): a tap on PANIC in learn mode panics and picks. The PANIC footswitch is never captured, so it is
    re-learned in Settings' table.
- **O7 Not verified:**
  - the real Mac app's Delete backup (simulated with stubs; code read: `controller.backupNow` → `rig.backupNow`);
  - real MIDI hardware: knob bursts, a toggle-mode footswitch as PANIC, Program Change;
  - a real iPad / WebKit;
  - screen readers;
  - themes other than Sanctuary;
  - migration-1x browser and the Electron suites (not run).
