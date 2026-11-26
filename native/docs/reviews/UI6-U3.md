# UI v6 U3 (the right sidebar): skeptic review (2026-11-26)

Verdict: **VERIFIED, after fixes.** As delivered (and as rebased), it was PARTIAL: two low defects and one test race.

Under review: commit 53e9aab on lane-u3, rebased by the coordinator onto v2-native 7f1b128 (U1 + U2 with their
skeptic fixes). It adds `app/js/views/v6/sidebar/` (`sidebar.js`, `modules.js`, `drone.js`, `setlist.js`, `notes.js`),
`app/styles-v6-sidebar.css` and `test/phase2/ui-v6/sidebar.tests.mjs`. It changes `v6/perform.js`, `v6/songbar.js`,
`v6/strips-row.js`, `styles-v6.css`, today's `views/perform.js` (3 `export`s) and `views/settings.js` (2 lines). I
didn't build it.

These claims held:

- **The rebase.** `strips-row.js` has U1-skeptic's `slotsSig` (F2: menus close on a slot shift), U2's `picked` /
  `coarse` / pick on `pointerup`, and U3's "pills whenever the row overflows" together. `perform.js` has U2-skeptic's
  `rangeSig` (F3) and the hidden-view drop (F4) beside the sidebar mount. Every U1 / U2 check passes on top of it, the
  U2 skeptic's included. The one interplay problem was a test race (F3 below).
- **Module boundaries.** `git diff 7f1b128` touches nothing in `app/js/engine`, `shared/`, `store.js`,
  `controller.js`, `main.js`, `server.js`, `views/edit/` or `views/components/`. Today's `views/perform.js` only gains
  `export` on `holdGate`, `brightnessWord` and `movementWord`. There is no `setTimeout` in the sidebar except the
  lock hint's (cleared on destroy). The only `innerHTML` is the modules' static icon markup.
- **Corrupt or foreign localStorage.** I tried 16 values: invalid JSON, a string, an array, `null`, a number, `true`,
  wrong types for every field, width `1e309` / `−5` / `199.9` / `200.4` / `99999`, removed module ids (`tone`,
  `chart`) in order / tab / hidden, everything hidden, duplicates, and `__proto__`. Every one gave a valid layout with
  no error. Unknown ids were dropped, at least one module was shown, the width was null or ≥ 200 and clamped at render,
  and a hidden or unknown tab fell back to the first shown module.
- **A width saved on a wide screen.**
  - 1150 px saved at 1920 shows as 620 px (62 % of the 1000 px board) at 1024 × 700, both on a resize and on a
    reload. The width is already clamped on the first frame after mount.
  - The saved 1150 is kept until the player changes the width.
  - Strips stay at 150 px with the pills shown, and the page never scrolls.
  - Dragging and End at 1024 clamp correctly.
- **Resize and fold.** The 200 px … 62 % clamp, the fold below 200, ⟨ restoring the earlier width, and ←/→ / Shift /
  Home / End on the grip all held, as the suite checks.
- **Customize.**
  - Hiding the open tab moves to the first shown module. Hiding it while folded, then opening, works.
  - The last shown module can't be hidden.
  - A ⠿ drag stopped by a flag off or a fold leaves no document listener behind.
  - The song bar's Setlist / Notes show a hidden module again and only ever open the sidebar (D24.5), folded or not.
- **Drone writes, path by path, against today's Key & drone card** (`views/perform.js` 642–760, 1050–1065,
  1215–1250):
  - ON tile → `drone.mode` (off ↔ last source / snapshot / synth).
  - Synth / My Pads → `drone.mode`.
  - Key grid → `hearIn` + `playIn`, with the transpose kept.
  - Major / Minor → `minor`.
  - Level → `controller.scenes.adjust('drone.gain')` while a scene plays (I checked: no store write, and the live level
    moved), else `drone.gain`.
  - Bright → `drone.brightness`; Move → `drone.movement`.
  - Keep across songs → `drone.continueAcrossSongs`.
  - Follow chords → `drone.chordFollow`, shown for the synth only.
  - The pad button is the same, and the same under Lock.
  - Lock follows the LOCK table: the tile and Level stay live, the keys and Major / Minor need a hold, and the rest is
    frozen.
  - The only display difference: the tile's sub-label shows the song's key, not the key the engine is playing.
- **Cue then GO (D6, O-AW-2).**
  - A sidebar cue followed by → on the page, or by `controller.nextSong()` (the learned / footswitch path), plays the
    cued song, and the list's "now" follows.
  - A cue set elsewhere (`controller.cueSong`, as a program change does) shows as cued, with "GO · ready".
  - Enter on a focused row cues that row (its own action), as the U1 popover did.
- **Long lists.** With 169 songs, 20 store writes re-render in about 17 ms in total.
  - A song switch while the list is open scrolls the list to the "now" row (row 168 is visible).
  - It never scrolls the page, the board or the sidebar body, at 1280 × 800 or at 1024 × 700.
- **+ Add song.**
  - New song is added at the end and **not selected** (D24.4), with an "Edit it" toast. That holds with a setlist,
    with the whole library, and with an empty setlist (see O2).
  - From my library adds to the current setlist and is disabled for the whole library.
  - From the Song bank, with a real bank pack (`createServer({userSamples})` and a `{mode:'bank'}` pack):
    - the item is enabled ("1 song, in Settings for now");
    - Settings opens with `details.st-bank` open, its item listed and the section in view.
  - Without packs it is disabled, as the suite checks.
- **Leaks.** I ran 12 flag on / off cycles over every tab, each with the customize and Add song popovers opened and
  the sidebar folded and reopened. Everything stayed the same:
  - store listeners: 15 → 15;
  - live ResizeObservers;
  - window, document, MediaQueryList and controller listeners, apart from the overlay manager's one-time click
    swallow, which stays installed by design;
  - rAF rate: 29.5 / 30 / 29.5 per second with the drone open, folded and the flag off.
  - The grip uses window `resize` and a `matchMedia` listener, both removed on destroy. It has no ResizeObserver; the
    strips row's existing one re-measures the pills.
- **Flag-off purity** against 7f1b128 (the suite's check: requests, listeners, intervals, store listeners, DOM,
  stylesheets, `__rig` keys) was identical in every run: 105 requests, 15 store listeners, 4 intervals, 2529
  elements.
- **Today's Perform and Settings.** ui-core and settings pass, and Settings' Song bank section opens from
  `open({section: 'bank'})`.
- **Zero console.error and no HTTP ≥ 400** in the suite and in every probe.

## Findings

- **F1 (low) ⟩, ⟨ and the rail icons pressed from the keyboard dropped the focus to the page.**
  - All three hide themselves. After Enter on ⟩, ⟨ or a rail icon, `document.activeElement` was `body` (150 ms
    later), so a keyboard player had to Tab in from the top again. → on the grip already moved the focus to ⟨.
  - Fix (e5523b3, `sidebar.js`): a keyboard activation (`click` with `detail` 0) focuses ⟨ after folding and the open
    tab after opening.
  - A pointer click is left alone on purpose. Chrome drops the focus to the page there, where Space is the sustain
    pedal. Focusing ⟨ would make the next Space reopen the sidebar instead.
  - Test: "U3 skeptic F1" (fails on the old code: "⟩ (Enter) → ⟨").
- **F2 (low) The drone forgot My Pads across a tab switch.**
  - The source the ON tile turned off lived in the mounted module, and every tab switch or fold unmounts it.
  - The sequence was: My Pads, tile off, a look at the Setlist, back, tile on. It came back as **Synth**, and while
    off the Sound switch showed Synth. Today's card (always mounted) gives My Pads; it forgets only on a song change.
  - Fix (919e386, `drone.js`): kept per song for the sidebar's life (`WeakMap` by module ctx), and still forgotten for
    another song.
  - A song switch made while the drone module is unmounted, then a switch back, now keeps the source. Today's card
    would forget it. I judge that harmless: it is still that song's last source.
  - Test: "U3 skeptic F2" (fails on the old code: "the off drone shows the sound it will come back with").
- **F3 (low, test) The U1 "> 5 instruments" check raced U3's overflow pills.**
  - U3's `render()` keeps the pills shown while the row's `.overflow` class is set. The class is re-measured on the
    next frame (`visible`).
  - Going from 7 back to 5 instruments, the check asserted the pills hidden in the same frame as the `.scroll` change.
    It failed in 1 of 4 full runs on the loaded 2-CPU box.
  - The UI corrects itself one frame later, so this is not user-visible.
  - Fix (3b9c484, `run.mjs`): wait for the pills to hide and check that `.overflow` is gone.

These are acceptable or not defects:

- **Notes / Setlist un-hide a module** the player had hidden: this is the builder's choice, listed for Ryan.
- **Enter on a focused setlist row cues it** instead of GO: a focused control keeps its own Enter (S7, controller).
- **The drone tile in the narrow sidebar reads "● ON".** "Drone" is hidden and the key shows only from a 400 px
  container, as the builder chose. The tab says Drone and the grid shows the key.
- **The drone's Bright / Move show only the word.** D24.6 (a percentage) is queued in U-TWEAKS; it is not a U3
  defect.

## Gate

The box had 2 CPUs. Another agent's edit-v2 suite (in /home/claude/wt-move) was running at the start, with a load
average of 1–7. I ran the suites one at a time.

| suite | result |
|---|---|
| ui-v6 (`test/phase2/ui-v6/run.mjs`) | 38/38 as rebased (53e9aab). With the fixes: 39/39 (F1 + F2 as one check), then split in two. With the app fixes removed it failed where expected: F1 (and the F3 race once, 37/39), then F2 alone (38/39). **40/40** at 919e386 (purity included), and again after the docs commit |
| ui-core (`test/phase2/ui-core/run.mjs`, at 919e386) | **78/78** |
| settings (`test/phase2/settings/run.mjs`, at 919e386) | **90/90** (modes: app, fixture, mac, bridge) |
| flag-off purity vs 7f1b128 (in ui-v6) | identical (105 requests, 15 store listeners, 4 intervals, 2529 elements) |
| my probes (`/tmp/u3rev/probe.mjs`, not committed) | corrupt prefs ×16, small screen, focus, hide, scene, cue / → / nextSong, 169-song list, empty setlist, bank pack, leaks ×12 cycles, drone last source, portrait: as above |
| console.error / HTTP ≥ 400 | 0 |
| Electron / Mac suites, real iPad | not run |

## Fixes (commits on lane-u3)

- 3b9c484 `test/phase2/ui-v6/run.mjs`: F3.
- e5523b3 `app/js/views/v6/sidebar/sidebar.js` and the check "U3 skeptic F1": F1.
- 919e386 `app/js/views/v6/sidebar/drone.js` and the check "U3 skeptic F2": F2.
- This review, plus a skeptic note in CONTRACT_CHANGES "## UI v6 U3" and the build plan's U3 status.

## Open items (for Ryan / U4 / U8)

- **O1 (medium, layout) At 1024 px wide, the open sidebar makes a 4-instrument song scroll.**
  - U1's placeholder was 160 px at ≤ 1100 px. U3 uses D16's 200 px minimum, with a 220 px default.
  - At 1024 × 700 the board leaves about 704 px for the strips. Four strips (150 px) plus the full-size "Add
    instrument" tile (120 px) need 744 px. The row therefore scrolls, the pills row appears, and the faders drop from
    182 px (base) to 140 px. Even a 200 px sidebar overflows by 20 px.
  - At 1180 × 820 with 5 instruments the pills now show too, because the row overflows. The faders go from 248 px to
    204 px.
  - Options:
    - start folded at ≤ 1100 px;
    - make the Add tile slim from 4 instruments (today: from 5);
    - a narrower left column.
  - U4 / U8 own the 1024 and iPad layouts.
- **O2 (low) An empty current setlist.**
  - The store's nav falls back to the library, so the sidebar title says "Library" and lists every song, while + Add
    song says "add one to ‘Empty set’".
  - New song (or a library song) then turns the shown list into that one-song setlist, without the playing song
    (`currentIndex` −1). The song bar reads "Empty set · 1 songs".
  - It is the same store rule as Edit's "+ New song" (`addSong` adds to the current setlist), so it is consistent but
    surprising. Wording for Ryan.
- **O3 (low) Width memory.**
  - ← or End at the widest point of a small window saves the clamped width over a wider one saved on a big screen
    (1150 became 620).
  - A drag-fold from the default width makes that width explicit.
  - Both follow from "the player moved it".
- **O4 (low) The grip's `pointerup` doesn't check the pointer id**, so a second finger lifting ends the first finger's
  drag on the 8 px grip. Harmless.
- **O5 Not in U3's row:** the mockup's customize has "Snapshots also in the top row" and the Tone / Snapshots modules
  (D16). D23's Metronome module and the "Loading n of m" header are queued as U-METRO.
- **O6 iPad portrait 820 × 1180:** `body { min-width: 1024px }` still makes the page 1024 px wide. A mobile context
  zooms it out. U4 / U8 own this, as the builder noted. The panel, the fold to one row and the rotation to landscape
  and back all worked.
- **O7 The builder's choices to confirm** (build plan):
  - New song is not selected (D24.4 since confirms it);
  - the pad-folder line shows only for My Pads;
  - Starts applies per page load;
  - Notes / Setlist un-hide a module.
- **O8 Not verified:**
  - real iPad / WebKit (touch on the grip, the ⠿ drag, container queries);
  - the Electron / Mac app, including the drone's pad-folder Rescan path, which needs `isElectron`;
  - real MIDI hardware: I used `controller.nextSong` / `cueSong` and the keyboard;
  - themes beyond Sanctuary;
  - screen readers (only the ARIA attributes were checked).
