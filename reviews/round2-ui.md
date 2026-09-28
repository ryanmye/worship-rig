# Round 2 review: ui (index.html, styles*.css, main.js, views/**)

Scope: `app/index.html`, `app/styles.css`, `app/styles-edit.css`, `app/js/main.js`, `app/js/views/**`, read against
CONTRACT_CHANGES "shell fixes", "shell-3", "ui-core-2", "ui-edit-2", "midi-default" and "engine-3".

Suites, run one at a time on the loaded 2-CPU box:

- `node test/phase2/ui-core/run.mjs`: **25/25 pass** (95 s).
- `node test/phase2/ui-edit/run.mjs`: **88/88 pass** (app and fixture modes).

Experiments are in `/tmp/claude-0/-home-claude/7e62a35d-8374-53c8-b5e9-fdad80c27279/scratchpad/review2-ui/`
(`exp1.mjs` to `exp4.mjs`). Each one runs against a fresh `createServer` on a random port with a throwaway browser
profile at 1024×700. No console errors appeared in any run.

Labels:

- **CONFIRMED** means reproduced in a browser, unless the finding says "by inspection". In that case the code path is
  deterministic and was traced end to end.
- **SUSPECTED** means reasoned from the code but not reproduced.

## Findings

### 1. MAJOR: after Settings is closed with the mouse, focus lands on the gear button, so Space re-opens Settings instead of sustaining (CONFIRMED)

- **Where:** `app/js/views/settings.js:953` (`close()` always calls `prevFocus.focus()`) and `app/js/main.js:188-193`.
- **Problem:** `main.js closeSettings()` is meant to leave pointer users with nothing focused. It checks
  `:focus-visible` and skips its own focus call. But it calls `settingsView.close()` first, and that has already
  focused `prevFocus`, which is `#btn-settings`, captured at open time. Nothing blurs it afterwards.
- **Measured (exp1 E1, exp2):**
  - Click the gear, then click Close (or the backdrop). `document.activeElement` is `btn-settings`.
  - Hold Space: `controller.status.pedal` stays false, because the controller ignores Space when something is
    focused. On key-up the button activates and **Settings opens again**.
  - ArrowRight does not change song, because `onButton` is true.
  - The first Esc only blurs, so Panic needs a second press.
- **Stage impact:** the player closes Settings, then sustain, song navigation and one-press Panic all stop working
  until they click somewhere empty.
- **Fix:**
  - Make `settings.close()` stop restoring focus when it runs under main.js: only restore when `ctx.closeSettings` is
    absent, or leave the job to main.js.
  - In main.js, record `lastFocusKb = lastFocus?.matches(':focus-visible')` at open. At close, focus `lastFocus` only
    when `lastFocusKb` is true. Otherwise blur `document.activeElement`.
  - Add a ui-core test: mouse-close Settings, then check that Space sets `status.pedal` and Settings stays closed.

### 2. MAJOR: a fader drag that is still going when the song changes writes into the new song, and the fader then shows the old song's level (CONFIRMED)

- **Where:**
  - `app/js/views/components/fader.js:191-197`: `set()` only stashes the value while dragging.
  - `fader.js:125-130`: `endDrag` sets `stash = null` and never applies it.
  - `app/js/views/perform.js:414-422`: `setSlotGain` resolves `shownId` when it writes.
  - The same pattern affects the top-bar Master (`main.js:224`, alias `master.volume`) and every Edit fader and knob
    (`edit.js:289`, alias writes to the current song).
- **Measured (exp1 E2):**
  - Song A has Pad at 0.55 and song B has Pad at 0.75.
  - Drag A's Pad fader up (A becomes 0.94), then select B (as a MIDI-learned Next or program change would), then
    move the mouse a little more and release.
  - Result: **B's Pad = 1.186**. B's level continued from A's value, and the change is persisted.
- **Second case (E2b):** no movement after the switch. B's store value is correct, but the fader keeps showing
  **A's dragged level (+2.4 dB)** until some other store change re-renders it. The player sees the wrong level for
  the song that is actually playing.
- **Fix:**
  - (a) Give the fader and knob a `cancelDrag()`: release the pointer capture, `emitter.cancel()`, `dragging = false`,
    then render the stash or current value. Perform, Edit and main.js call it on all their faders when the shown
    song id changes.
  - (b) In `endDrag`, if `stash !== null` and nothing is pending, apply the stash.
  - (c) Perform: capture the song id at drag start (`onStart`) and drop writes whose captured id ≠ `shownId`.

### 3. MAJOR: Edit text fields (song name, notes, tempo, key-range notes) write into the next song after a switch that doesn't come from the mouse (CONFIRMED)

- **Where:** `app/js/views/edit.js`:
  - `:282`: `applyBind` never refreshes a focused text field.
  - `:937-958`: writes use the `'song.name'` and `'song.notes'` aliases, which resolve to the store's current song.
  - `:1606-1613`: `showSong` switches without flushing or blurring.
  - The same applies to `noteField` (`:391-405`) and `tempoInput` (`:968`).
- **Measured (exp1 E3):**
  - Title field: in Edit on "Prayer Wash", type " (live)" in the title. Switch to "Organ Swell" through
    `controller.selectSong`, as MIDI Next or a program change does. Press Enter.
  - Result: **"Organ Swell" is renamed "Prayer Wash (live)"**, and the field went on showing the old name the whole
    time.
  - Notes: type in the notes, switch song, type one more character.
  - Result: **song B's notes are replaced with song A's full notes text**, through the 500 ms debounced flush.
  - A pointer click on another row is safe, because the blur and change happen before the switch.
- **Fix:**
  - Write with explicit ids: `store.set(\`songs.${id}.name\`, …)`, with `id` captured on focus or on the first
    input, the same way `flushNotes` should take it.
  - In `showSong()`, before changing `shownId`:
    - flush pending notes to the old id;
    - if a text field inside `root` is focused, commit it to the old id and blur it;
    - then refresh with `force`.

### 4. MINOR: in the setlist "gap" state, the Perform strip highlights a reprise of the removed song as current (CONFIRMED)

- **Where:** `app/js/views/components/setlist.js:261-265`. `curIndex()` falls back to `findIndex(currentId)` when
  `currentIndex` is −1. `perform.js:531-540` passes −1 but not the gap.
- **Measured (exp4):**
  - Add the first song again at the end of the set, select entry 1, then remove entry 1.
  - Result: `setlistGap: true`, but chip 19 of 19 (the reprise) is highlighted and scrolled into the left third.
  - Next says "Building Swell · C", which is chip 1. The strip says you are at the end of the set, while Next and
    Prev act on the gap.
- **Fix:** pass `gap: nb.gap` (or `currentIndex: -1, strict: true`) to `setlistStrip.set`. When it is set, do not
  fall back to `findIndex`, and draw a gap marker the way Edit's `ed-gap-row` does.

### 5. MINOR: holding Enter on the lock button re-locks it about 0.6 s after it unlocks (CONFIRMED)

- **Where:** `app/js/views/perform.js:381-398`.
- **Problem:** after the 600 ms hold unlocks, the auto-repeated Enter keydowns are no longer `preventDefault`ed,
  because `isLocked()` is now false. Each one clicks the button, and `suppressClickUntil` only covers 600 ms.
- **Measured (exp3):** lock is true at 37 ms, **false at 645 ms, true again at 1229 ms**. Space does not have this
  problem: its keyup click is suppressed by `holdTimer`/`suppress`, and was checked at 0.8 s and 1.5 s.
- **Fix:** in keydown, also `preventDefault()` any `e.repeat` Enter or Space when a hold just completed, for
  example while `performance.now() < suppressClickUntil || e.repeat`. Or ignore keyboard clicks (`detail === 0`)
  until a keyup has been seen after the unlock.

### 6. MINOR: Perform slot names don't refresh after a My Samples rescan (CONFIRMED by inspection)

- **Where:** `app/js/views/perform.js:791-795`.
- **Problem:** `refreshNames()` runs only on the controller's `'ready'` event. Edit already listens to the engine's
  `instruments`, the controller's `instruments` and `user-samples`, and `rig-instruments-changed`
  (`edit.js:1663-1667`), as engine-3 and shell-3 ask. Perform listens to none of them.
- **Effect:** a slot switched to a newly rescanned `user:` instrument shows `humanize('user:…')`, for example
  "User:steinway Grand", instead of the pack name, until the next restart.
- **Fix:** listen to the same four events and call `refreshNames()` then `renderSong(store.get())`.

### 7. MINOR: edit.js still has its own `CATEGORY_LABELS` without `synth` (CONFIRMED by inspection)

- **Where:** `app/js/views/edit.js:49`.
- **Problem:** shell-3 §4 asked the UI to import `CATEGORY_LABELS` from presets.js. Without it, the factory browser
  heading for 80s Ballad and Synthwave reads "synth" in lower case (`CATEGORY_LABELS[cat] || cat`), and their song
  rows lose the category in the tooltip.
- `INSTRUMENT_GROUPS` and `groupOf` also duplicate `components/instrument-groups.js`, which ui-core-2 offered for
  import.
- **Fix:** `import { CATEGORY_LABELS } from '../presets.js'`, and delete the local copy.

### 8. MINOR: Perform's Revert snapshot is a second, divergent copy of `controller.revertSong` (SUSPECTED)

- **Where:** `app/js/views/perform.js:465-478` and `:511`.
- **Problem:** Perform takes its own snapshot on every store `currentSongId` change. The controller's `songSelected`
  and `revertSong()` (shell-3 §2) are not used by any view. The two disagree in these cases:
  - **Failed or refused load.** The controller calls `selectSongId(appliedId)` again, so Perform re-snapshots the
    old song with the player's Perform tweaks included. Revert then no longer restores the song "as selected".
  - **`store.reload()`** when a secondary window takes over. The song id is the same, so Perform does not
    re-snapshot. Revert is enabled, and would write the stale pre-takeover values over what the other window saved.
  - **Tempo.** Perform's `SAVED_FIELDS` omits `tempo`, and the controller includes it. That is harmless today.
- **Fix:** drive the snapshot from `controller.on('songSelected')` (a commit, not a request), plus the existing
  "left Edit" and `importBackup` re-snapshots. Re-snapshot after a `store.reload()` (a controller `'instance'` event
  to primary). Or call `controller.revertSong()` and delete the local copy.

### 9. MINOR: dead code and write-only state left from earlier versions (CONFIRMED by inspection)

- `main.js:553` `popupOpen()`: selects `.ed-confirm`, `.confirming` and `#view-edit details[open]`. These are
  unreachable, because the handler already returns for any view other than Perform, and `#view-edit` is `[hidden]`
  in Perform.
- `markDialog()` (`_fallback-components.js:36`): writes `body.dataset.dialogOpen`. Nothing reads it (grep across
  `app/`), even though ui-edit-2 describes it as the flag main.js "may use". Either read it in `popupOpen()` or drop
  it.
- `perform.js:419-420` and `:431-439`: the `mutedGain` fallback for stores without first-class mute. shell fixes §1
  migrates `gain 0 + mutedGain` to `muted`, and `set(...muted)` is always accepted now, so this path is dead.
  `slotMuteState` can keep reading old data.
- `_fallback-components.js` (601 lines): reached only by the ui-edit fixture (`__RIG_FORCE_FALLBACK_COMPONENTS`).
  Keep it as a test aid if wanted, but it is a second implementation to maintain. Its fader, for example, lacks
  finding 2's fix.
- `controller.revertSong` and `songSelected`: unused by the UI (see finding 8).

### 10. MINOR: hidden views keep polling and animating (CONFIRMED by inspection)

- **Where:** `edit.js:1566` and `perform.js:740`.
- **Problem:** Edit's `C.meter({engine})` runs its own `requestAnimationFrame` loop from startup, reading both
  analysers every frame while Edit is hidden. The top-bar meter already does the same work. Perform's 150 ms
  `readRuntime` interval also keeps running in Edit.
- **Effect:** this is not a correctness problem, but it is steady main-thread load on the same thread as MIDI
  handling.
- **Fix:** pause the meter's loop while its element is not visible (an `IntersectionObserver`, or a `pause()` and
  `resume()` called from `applyView`), and skip `readRuntime` while `root.hidden`.

### 11. MINOR (a11y): nested modal dialogs (CONFIRMED by inspection)

- **Where:** `main.js:636-638` sets `role=dialog`, `aria-modal` and `aria-label` on `#view-settings`, and
  `settings.js:208` puts another `role=dialog aria-modal` inside it.
- **Effect:** screen readers announce two dialogs.
- **Fix:** once `mountSettings` succeeds, remove the outer role and aria attributes (keep them only for the
  placeholder).

### 12. MINOR (a11y): the focusable notes panel steals arrows (SUSPECTED)

- **Where:** `perform.js:279` (`.notes-text` has `tabindex=0`).
- **Problem:** the controller only exempts text controls and buttons. With the notes focused by keyboard, ↑/↓
  nudge the **mod wheel**, which changes the sound, instead of scrolling the notes, and ←/→ switch songs.
- **Fix:** give it `role="document"`, or handle its own ↑/↓/PageUp/PageDown with `stopPropagation` and
  `preventDefault` after scrolling.

## Checked and solid

- Both suites pass: ui-core 25/25 and ui-edit 88/88. No console errors in any of my runs.
- **Layout at 1024×700.** Perform, Perform locked, Edit and Settings fit with no page scroll (`scrollWidth` 1024,
  `scrollHeight` 700). Screenshots are in the scratch dir. Long names ellipsize, and hit targets are 44 px or more.
- **Lock rules in Perform.** Edit, Settings, key grid, major/minor, drone mode, Follow/Continue, transpose,
  Space/Vibe, Revert and reordering are all frozen. Faders, mute, wheel, Swell, drone Level, Fade out, Panic and
  navigation stay live. A ⌘E or menu switch to Edit while locked is bounced back to Perform in `main.js:452-457`.
  Holding Space to unlock doesn't relock after 0.8 s or 1.5 s.
- **Esc.** Esc panics only in Perform with nothing focused and no popup. Edit and Settings always `preventDefault`.
  A focused control is blurred first. The listener order (main.js before `controller.start`, plus capture listeners
  in Settings and Edit) is correct.
- **"Custom" detection.** It matches the data: 11 of the 19 factory songs, the pre-v2 ones, are legitimately Custom
  for Space and Vibe, and the 8 new songs show their named presets. Perform (`songFxValue`) and Edit (`valueOf`
  with defaults) agree for every current preset path.
  - Product note: "Sunday Pad + Piano" shows Space: Custom, because its reverb size is .62 and Stage is .42.
- **Revert snapshot references are safe.** The store is immutable (`setIn` plus `deepFreeze`), so `snap.song` can't
  be mutated by later edits.
- **Components and listeners.**
  - Perform components are disposer-based and the setlist's ResizeObserver disconnects.
  - Edit's `destroyGroup` removes binds and components when a slot body is rebuilt.
  - Settings' timers run only while it is open, and `close()` stops the pedal test and MIDI learn.
  - The setlist strip patches names in place and rebuilds only when ids or order change.
- **Lamps.** The pedal lamp polls `engine.pedal` and updates immediately on CC64. The Faded chip follows
  `getRuntimeState().faded`. The drone readout reads the engine's actual mode and key. The audio and Ready lamps
  handle the secondary window.

## Prioritized fix list

1. **#1 Settings focus.** A small change: settings.js `close()` plus main.js `closeSettings()`. Add a regression
   test.
2. **#2 Fader drag across a song switch.** Add `cancelDrag()`, apply the stash at drag end, and have Perform, Edit
   and main.js call `cancelDrag()` on a song change. Add a test: drag, then `selectSong`, then release, and check
   that the new song is unchanged.
3. **#3 Edit text fields.** Write with explicit ids, and flush and blur in `showSong`. Add a test: type, then
   `selectSong`, then Enter, and check the other song's name and notes.
4. **#4 Gap highlight** in the Perform setlist strip.
5. **#6 Perform instrument names** after a rescan (a four-line listener).
6. **#5 Enter-hold relock.**
7. **#8 Revert:** single source of truth from `songSelected`, plus re-snapshot on `store.reload`.
8. **#7 `CATEGORY_LABELS` import** and the other duplicates.
9. **#10 Idle polling in hidden views**, **#11 nested dialog roles**, **#12 notes arrows**, **#9 dead-code
   cleanup**.
