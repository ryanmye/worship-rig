# UI v6 U2 (the keyboard with draggable range bars): skeptic review (2026-11-26)

Verdict: **VERIFIED, after fixes.** As delivered (and as rebased), the change was PARTIAL.

Under review: commit 912dac5 on lane-u2, rebased by the coordinator onto v2-native 2fff370 (U1 + its skeptic
fixes). It adds `app/js/views/v6/keyboard.js`, `app/styles-v6-keyboard.css` and the harness
`test/phase2/ui-v6/keyboard-harness.html`, and changes `bottom.js`, `perform.js`, `strip.js`, `strips-row.js`,
`styles-v6.css` and the ui-v6 suite. I didn't build it.

These claims held:

- **Snapping.** I dragged both ends of a bar to every key's edge ±1.5 px, on both sizes: the 61 keys of 'perform'
  (C2–C7, 760 px) and the 88 of 'range' (A0–C8, 700 px). That is 476 drags with 0 mismatches, black keys included.
- **Writes.** There is one `store.set` per release, only for the end that moved, at
  `songs.<id>.patch.slots.<i>.lowNote|highNote`. Nothing is written while dragging, by a press without travel, or by a
  `pointercancel`. A clipped end is kept unless that end is dragged.
- **Past the edge** gives 0 / 127, and the bar is then drawn with edge markers. The threshold is a quarter of a white
  key, not the half the contract said; the contract is corrected.
- **Lock** blocks drags and arrows, hides the handles and takes them out of the tab order.
- **Revert** restores the patch exactly (`JSON.stringify` equal), including 0 / 127 ends and ranges outside the keys.
- **A song switch mid-drag** writes nothing to either song.
- **MIDI notes during a drag** light their keys, and the drag continues and writes the right value.
- **⌘.** panics with a handle focused and in pick mode. A focused handle's first Esc only lets go of the focus, as
  everywhere else, and the second one panics.
- **Pick mode.**
  - Esc closes the overlay on top first: the Quick sheet, then the pick.
  - Taps on a popover keep the pick.
  - Panning the strip row keeps the pick.
  - Tapping bar 6 of 7 scrolls its strip into view.
  - The finishing tap on the keys plays no note.
- **The rebase.** `strips-row.js` holds U1-skeptic's `slotsSig` (F2: menus close on a slot shift) and U2's
  `picked` / `coarse` together. U1's F1 / F2 test still passes, and an emptied picked strip ends the pick.
- **Module boundaries.** `git diff 2fff370` touches nothing in `app/js/engine`, `shared/`, store.js,
  controller.js, main.js, today's `views/perform.js`, `views/edit/`, `views/components/` or server.js. There is no
  `setTimeout` or `innerHTML` in keyboard.js.
- **Flag-off purity** against 2fff370. With my independent probe (3 base / branch boot pairs) these were identical:
  - requests: 112, 105 unique;
  - every `addEventListener` by target and type: 0 differences;
  - intervals: 4 = 4;
  - store listeners: 15 = 15;
  - `body` and `head` outerHTML;
  - stylesheets;
  - `__rig` keys.
- **Zero console.error and no HTTP ≥ 400**, in the suite and in every probe.

Six things did not hold. All six are fixed, each with a test (F1 through the gate itself).

## Findings

- **F1 (medium, gate) The suite failed after the rebase: 25/26, not the claimed 26.**
  - The purity check compares against `git merge-base HEAD v2-native`, which is now 2fff370. That base already has
    `__rig.setUiV6`, so `assert.deepEqual(extraKeys, ['setUiV6'])` failed.
  - The flag-off app itself was identical: every earlier assertion in that check passed.
  - Fix (1072b5a): the branch must not lose a `__rig` key and may add only `setUiV6`.
- **F2 (medium) Tapping a strip name soon after a touch drag did nothing. This was the iPad test's flake.**
  - The coordinator saw "U2 iPad (coarse): tap a strip…" time out in 2 of 5 full runs. I reproduced it in 2 of 4 runs at
    6× CPU throttle. The failing wait was the switch to strip 2 right after the first touch drag.
  - Cause: Chromium's tap suppression. A tap that lands within about 0.4 s of a quick touch drag (the drag's fling) gets
    `pointerdown` and `pointerup` but **no `click`**, and the name picked on `click`. A probe of touch drag + tap on a
    name failed 13 of 16 times with no throttle; only gaps of ≥ 350 ms got through.
  - This is a real defect, not just test timing. It is exactly D18's flow ("drag the ends · tap another instrument to
    switch"), on Chromium touch (Electron or Chrome on a touch screen). On WebKit / iPad it is not verified.
  - Fix (0922d4a, `strip.js`):
    - A touch / pen press on the name that moves ≤ 10 px picks on `pointerup`.
    - The click that may follow within 1 s is ignored, so there is no double toggle.
    - Mouse, keyboard and AT clicks keep the click path.
  - Tests:
    - real CDP touches: drag, then an immediate tap, twice;
    - a deterministic check: `pointerup` without a click picks; `pointerup` + click is one toggle; a press that moved
      picks nothing. This check fails on the old code.
  - Afterwards: the probe failed 0 of 16 at 1× and 0 of 16 at 6×, the iPad test passed 5 of 5 at 6×, and the full
    suite passed in both later runs (27/27).
- **F3 (medium) A Remove during a drag wrote the wrong instrument's range.**
  - The drag (and the pick) holds a slot index. Slot 2's highest end was being dragged when slot 0 was removed (by a
    store write: Edit, a second finger on ⋯ Remove, any writer). The release then wrote the end into the old slot 3:
    Church 60–84 became 60–65.
  - A pick likewise outlined the neighbour.
  - Fix (521d485, `perform.js`): when the song's slot count changes, the drag and the pick are dropped (U1 F2's rule
    for menus).
- **F4 (medium) A drag interrupted by a view switch wrote "every key".**
  - With the mouse held, `ctx.setView('edit')` (⌘E, a MIDI view switch) hid the keyboard. Its rect is then 0 px wide, so
    `snap()` returned 127, and the release wrote it. Warm Pad 40–80 became 40–127.
  - Fix (521d485):
    - `perform.js` drops the drag and the pick whenever the view isn't Perform.
    - `keyboard.js` ignores moves while its width is ≤ 1 px.
- **F5 (low) A one-key range moved the wrong way.**
  - A stored lo === hi range, which today's Edit allows:
    - → on the lowest handle moved it a key down (60–60 became 59–60);
    - ← on the highest handle moved it up;
    - a short drag inward also moved it down;
    - the lowest handle's `aria-valuenow` (60) was above its `aria-valuemax` (59).
  - Fix (521d485): the clamp keeps the end's start as a bound. ARIA max / min is now `max(hi − 1, lo)` /
    `min(lo + 1, hi)`. Outward moves still work.
- **F6 (low) A second finger on the keys cancelled a coarse drag.**
  - The keys' "tap to finish" capture listener also ran while one finger dragged an end. The drag was cancelled
    (unwritten), the pick ended and the note was swallowed.
  - Fix (a731481, `keyboard.js`): while a drag is on, the keys play. The test is a two-finger CDP sequence in the iPad
    check, which fails on the old code.

These are acceptable or not defects:

- **The changed count in v6 and Edit differ for a range edit (asked).**
  - A range drag makes v6's Revert say "1 changed" and dots the bar. Edit shows 0 changes and no dot, because it uses
    today's `DIFF_WATCH`.
  - Going to Edit and back retakes the snapshot, as for every edit today, so the count goes to 0.
  - I judge this acceptable: Revert itself compares the whole saved song in both views, so it restores the range
    either way, and flag-off views are unchanged. U5 must use `V6_DIFF_WATCH` for Edit v6's Range dot (the build plan
    already says so). Until then it is a known mismatch while the flag is being tried out.
- **The coarse hit layer is 46 px tall**, so it reaches 12 px above the keys section, over the strips' bottom padding.
  It overlaps no control at 1024×700, 1180×820 and 1366×1024. The fine layer stays inside the section.
- **Synthetic same-frame arrow presses** count once, because the handle reads the rendered value. Real key repeat
  (≥ 30 ms apart) steps every time.
- **Two fingers on both ends** of one bar: only the first finger drags. That is by design.

## Gate

The box had 2 CPUs. U3's builder and another agent's ui-core run were on it at times, with a load average of 3–7. I ran
the suites one at a time.

| suite | result |
|---|---|
| ui-v6 (`test/phase2/ui-v6/run.mjs`) | 25/26 as rebased (F1). 26/26 three times after F1 (F2 not yet in). **27/27** after F3–F6 (1 new check plus 2 extended). With the fixes removed it failed in the expected places (25/27). The final run, at a731481 + docs, was 27/27, purity included |
| ui-v6 iPad check alone, 6× CPU throttle | 2 of 4 failed before F2; 5 of 5 passed after |
| edit-v2 (`test/phase2/edit-v2/run.mjs`, at a731481) | **14/14 files** passed (integration 22 s) |
| flag-off purity probe vs 2fff370 (`/tmp/u2-probe/purity.mjs`, 3 pairs) | identical (see above) |
| snap sweep (harness, 476 drags) | 0 mismatches |
| console.error / HTTP ≥ 400 | 0 |
| Electron / Mac suites, real iPad | not run |

## Fixes (commits on lane-u2)

- 1072b5a `test/phase2/ui-v6/run.mjs`: F1.
- 0922d4a `app/js/views/v6/strip.js` and the iPad check: F2.
- 521d485 `app/js/views/v6/perform.js`, `keyboard.js` and the new check "U2 skeptic: a slot shift or a hidden view
  drops a drag; a one-key range never moves the wrong way": F3, F4 and F5.
- a731481 `keyboard.js` and the iPad check: F6.
- This review, plus a skeptic note in CONTRACT_CHANGES "## UI v6 U2" and the build plan's U2 status.

## Open items (for Ryan)

- **O1 The builder's four choices.**
  - Write on release: D24 (since decided) supersedes it, see O3.
  - Strictly lowest < highest, while today's Edit allows a one-key range.
  - The finishing tap on the keys plays no note.
  - Past the edge means "every key that way" (a quarter of a white key: about 7 px on Perform, about 3 px on the 88
    keys, so A0 and "every key down" are easy to confuse there, harmlessly).
- **O2 Esc during pick mode finishes the pick instead of panicking.** It is the overlay rule, as with popovers, and ⌘.
  always panics. With D24's "pick on every pointer", this reaches the Mac too, where Esc = panic is a habit. Ryan's
  call.
- **O3 Things that affect the D24 follow-up (live throttled writes; tap first on every pointer).**
  - **Cancel must restore once writes are live.** Today a cancelled drag (`pointercancel`, F3 slot shift, F4 hidden
    view, Lock, a song switch, a pick switch) is "write nothing". With live writes, the store already holds the
    dragged value, so cancel has to write `lo0` / `hi0` back. The F3 case must not write the old value into the
    shifted slot either: write back by the instrument held at drag start, or drop the write.
  - With live writes, every write re-renders the whole v6 Perform and runs the store → engine diff. `render()` keeps
    the drag (valuesOf reads the drag), but the changed count, Revert and the dots will tick while dragging. The 50 ms
    throttle is worth timing on the 2-CPU box.
  - Pick on every pointer: `pickMode()` becomes `size === 'perform'`. The fine-pointer hover / `hot` handles and the
    34 px reach then need the same `picked` gate. Most U2 checks drag without picking and need a pick step. F2's
    `pointerup` path skips mouse pointers on purpose, because mouse clicks are not suppressed, so it can stay.
- **O4 Small things.**
  - Every bar adds two handle tab stops ahead of Revert, so 32 with 16 instruments. Home / End aren't supported on the
    handles.
  - The coarse hit layer sits over the strips' bottom padding (no control there).
- **O5 Not verified.**
  - Real iPad / WebKit: whether Safari suppresses the click as Chromium does (F2 holds either way).
  - Real MIDI hardware during a drag: I used `controller.perform.noteOn`.
  - The Electron / Mac app.
  - Themes beyond Sanctuary.
  - The U1 fader's behaviour when the view hides mid-drag (out of scope; it may share F4's pattern).
