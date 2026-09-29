# Review round 4: edit-lib (views/edit/lib.js, shell.js, panels/song.js, song-header.js, slot.js)

Reviewer: cloud C6 review4 (edit-lib), 2026-09-28 ~22:10–22:55Z. This review was read-only: none of the scope files
changed while it ran (lib.js 21:37Z, shell/song-header 20:42Z, slot 20:48Z, song 20:04Z).

Focus: after L-9, the `createBinder` text/dirty semantics for every text field; the order of debounce, blur and song
switch; IME; undo (⌘Z) in fields; binder destroy on rebuild; stale sentence titles; and a slot rebuild on an
instrument change while the EQ editor is in use.

Experiments are in `/tmp/claude-0/-home-claude/7e62a35d-8374-53c8-b5e9-fdad80c27279/scratchpad/review4-edit-lib/`:
- `e2-harness.mjs <name>`: the edit-v2 harness. Names: `notefield`, `ime`, `badinput`, `undo`, `crossundo`,
  `songundo`, `nameundo`, `rebuild`.
- `e5-viewswitch.mjs`, `e6d-undo-perform.mjs`: the real app.
- `e1e/main.cjs`: Electron. Run it with `xvfb-run electron --no-sandbox main.cjs`.

Harness experiments boot `factory:prayer-wash`, a synth-only song, because of the load problem described next.

## Suites

| Run | Result |
|---|---|
| `node test/phase2/edit-v2/run.mjs` (22:12–22:22Z) | 9/11 files pass: shell 10, bottom 5, drone 6, effects 5, master 4, setlist 13, slot 12, song 8, integration-widths 5 |
| failing file: song-header | 0/10. Every test failed with `pageerror: probing is not defined`. controller.js was being edited by the round4-controller fixer at the time (`let probing` landed 22:20:53Z). Not an edit-lib defect. |
| failing file: integration | 0/12, a boot timeout at the same time |
| `--only song-header` re-run (22:37Z, and again at 22:47Z) | 0/10. The harness `controller.start()` was not ready within 30 s on both attempts. |

**Why the re-runs time out.** The box's load average was 17–28 at the time, from other agents' suites. At that load,
decoding the default song's Salamander piano takes more than 60 s. A diagnostic run
(`e0-diag.mjs`) showed the fetches moving forward slowly (v4 → v9 → v14 layers), not hung. The same panels boot and
behave normally on a synth song: the `ime` and `nameundo` experiments below exercise song-header this way.

**To do:** re-run `song-header` and `integration` when the box is quiet.

## Findings

### M1 (major, CONFIRMED): ⌘Z / Ctrl+Z after a song switch overwrites the previous song's notes with the current song's notes, even from Perform

**Where**
- `panels/song.js:167-170`: every `input` on the notes textarea arms the 500 ms debounce, with no check of focus or
  source.
- `shell.js:202-212`: `core.songField` sets `fieldIds` on `focus` and never clears it. So `commitNotes` writes to the
  song the textarea was *last focused on*, long after focus has left.
- `main.js:521` (Electron main, LOCAL): `{ role: 'editMenu' }` makes ⌘Z `webContents.undo()`. That is a frame-level
  undo that works wherever focus is, including in Perform.

**Mechanism**
- Chromium keeps one undo stack per frame. After you type in the notes, switch songs and press undo anywhere, the
  hidden or unfocused textarea gets `beforeinput`/`input` with `inputType: historyUndo`.
- Its text is by now the new song's notes, which the binder painted in.
- The debounce commits that text to the old song id.

**Measured**
- E6c (`songundo`, harness Song panel):
  - A = "Song A notes." Type " Typed in A", then blur. A = "Song A notes. Typed in A".
  - `controller.selectSong(B)`, then Ctrl+Z, with focus in B's tempo field or with nothing focused. Both gave the same
    result: **A = "Song B has different, longer notes here."** (B's notes), and B was unchanged.
  - Events on the unfocused textarea: `["beforeinput:historyUndo", "input:historyUndo"]`.
- E6d (real app): the same steps, then switch to **Perform**, blur, and press Ctrl+Z. **A's notes = B's notes.**
  - This is silent and saved with the library.
  - A musician's reflex ⌘Z on stage loses another song's notes.
- Without a switch, the same ⌘Z in Perform silently reverts (and saves) the last notes typing done in Edit (E6b
  `crossundo`: Chromium also moves focus to the notes when the undo changes them).
- Name and tempo are not affected, because they commit only on `change` (E6e `nameundo`: A and B unchanged).

**Fix**
1. `shell.js` `core.songField`: forget the id when focus leaves:
   `input.addEventListener('focusout', () => fieldIds.delete(input))`.
   - Chromium's order is change → blur → focusout. That holds for an element blur, for a script `blur()`, and for a
     window deactivation (E1e). So the change commit and song.js's blur flush still use the id that was focused.
   - The re-focus on window return sets the id again.
   - `commit()` then falls back to `core.songId`.
2. `song.js` notes `input` listener: at the top, add
   `if (document.activeElement !== notesArea) { notesArea.value = ctx.song()?.notes ?? ''; return; }`.
   An undo or redo applied to an unfocused field must never become a commit. Undo while typing in the notes still
   works (E6a).
3. Tests:
   - edit-v2 `song`: E6c, asserting A is unchanged.
   - `integration`: E6d, the Perform variant.

### m1 (minor, CONFIRMED): the slot's Lowest/Highest note fields show a stale key after an outside write while focused

**Where:** `panels/slot.js:817`: `binder.ctl(addr, () => comp, { text: true })`.
- `text:true` skips every write while the field is focused, and does not update `b.last`.
- Unlike `'dirty'`, nothing re-applies on blur.

**Measured (E2, `notefield`)**
- (a) Keyboard flow: "Set lowest…" armed with Enter, focus moved to the Lowest field without a pointer, MIDI note 50
  played. The store has lowNote 50, but the field reads **C2**, and still reads C2 after blur.
- (b) Pointer flow: click the Lowest field, then drag the mini keyboard. Its `pointerdown` is `preventDefault`ed
  (keys.js:255), so **focus stays in the field**. The store has 47, but the field reads **C2**, before and after blur.
- Nothing is written wrongly: the next focus-and-blur without typing fires no `change`. The field shows a wrong key
  until the next write to that path.

**Fix:** `{ text: 'dirty' }`. The note fields are song-bound fields like tempo, so they get setClean while untouched
and the forced focusout re-apply. Add E2a and E2b to `slot.test.mjs`.

### m2 (minor, CONFIRMED by emulation): IME — the Enter that confirms a candidate in the song name blurs the field and commits it

**Where:** `panels/song-header.js:67-78`. The keydown handler acts on `e.key === 'Enter'` and `'Escape'` with no
`isComposing` guard.

**Measured (E3, `ime`)**
- A CDP `Input.imeSetComposition(" さんび")` followed by Enter gave keydown
  `{key:'Enter', isComposing:true, keyCode:229}`. This is what Chrome on macOS sends for the candidate-confirm Enter.
- The field blurred, and the store name became "Prayer Wash さんび" mid-edit.
- Esc during a composition, which cancels the conversion, would likewise revert and blur. That part is SUSPECTED
  (not emulated).

**Fix:** make the first line `if (e.isComposing || e.keyCode === 229) return;`. Do the same, for consistency, in the
tempo and note-field Enter handlers (`song.js:130`, `slot.js:814`) and in setlist's rename (outside this scope).

Also noted: during a composition the notes debounce can commit the unconverted text (Chromium fires `input` on every
composition update). This is cosmetic: the binder never writes into the field while it is dirty, and the final commit
replaces the text. Optional: skip arming the debounce while `e.isComposing`.

### m3 (minor, CONFIRMED): a bad number in the tempo field clears the song's tempo

**Where:** `panels/song.js:121-124`. A number input with bad input reads `value === ''`, so `commitTempo(null)` runs.

**Measured (E4, `badinput`, tempo was 88)**

| Typed, then Enter | `badInput` | Store tempo |
|---|---|---|
| `1e` | true | **null** |
| `-` | true | **null** |
| `12` | false | 30 (clamped, expected) |

The tempo disappears from the song, and synced echoes follow it.

**Fix:** at the top of the `change` handler, add
`if (tempoInput.validity.badInput) { tempoInput.value = <store tempo or ''>; return; }`. Keep `''` meaning Clear only
when `!badInput`.

### n1 (nit, CONFIRMED by reading): every slot rebuild leaves one closure in the panel ctx's `own` list

**Where:**
- `lib.js:535`: `ctx.onLeaveSong(...)` runs per binder.
- `shell.js:400-405`: `pctx.onLeaveSong` pushes its `off` into `own`.
- `binder.destroy()` calls `off`, but the entry stays in `own` until the panel unmounts, and it holds the destroyed
  binder's api.
- slot.js rebuilds on every switch to a song whose instrument differs for the shown slot.

**Impact:** tiny, one small object per rebuild.

**Fix:** have the `off` returned by `pctx.onLeaveSong`, `onLeaveView` and `onEscape` also splice itself out of `own`.
`listen` would benefit from the same change.

### n2 (nit, CONFIRMED by reading): a half-typed note name toasts during a song switch

**Where:** `panels/slot.js:805-809`. A song switch blurs the song-bound Lowest field, and `change` runs
`parseKey('C')`, which returns null. The warn toast "“C” is not a key name — try C4 or F#2" then shows at the moment
the song switches.

**Fix:** in the `change` handler, suppress the toast (and just revert) when the change comes from the leave-song blur.
One way is a `ctx.leaving` flag the shell sets around `leaveSong()`.

### n3 (nit, SUSPECTED): an `'instruments'` event while the instrument menu is open drops keyboard focus

**Where:** `panels/slot.js:1049`. `buildMenu()` replaces the items under the focused menu item, and focus falls to
`<body>`.

**Fix:** after the rebuild, re-focus the item with the same `data-value`.

## Checked and solid

- **L-9 binder (tempo, notes, name).** The song file passes 8/8, including the L-9 storm test.
  - Keys that don't edit (arrows, Home/End, selection) leave the field clean.
  - Paste, cut, drop, spellcheck and undo mark it dirty through `beforeinput`.
- **Window or page focus loss (⌘Tab, another window, the menu-bar popover).** E1e (Electron, a second WebContents
  takes focus): Chromium fires `change → blur → focusout` on the field with `activeElement` unchanged, then
  `focus → focusin` when focus returns.
  - The forced focusout re-apply therefore never clobbers a draft. Tempo and name commit on that `change`, and the
    notes are flushed by the `blur` before focusout runs.
  - I suspected a data-loss path here; it does not exist.
- **Microtask-batched store.** Inside a script `blur()` (Enter), `ctx.song()` still returns the song as it was before
  the commit.
  - `song.js:126-128` therefore writes the old tempo into the field. The clamp comment there is wrong for that path.
  - The binder's refresh in the next microtask fixes the field, because `b.last` was set from the same stale song, so
    the values differ.
  - The final value is always the store's. Covered by the storm test.
- **Song-switch order.** `leaveSong()` runs inside the batched notification, before `core.song` moves:
  1. The notes flush and the songField blur commit to the old id.
  2. focusout paints the old song.
  3. `refresh(null)` (forced) paints the new song.
  - The old-song write's own notification is dropped (not the current song).
- **View switch with a draft (E5, real app).** Type into the name, then Ctrl+E.
  - Chromium blurs the now-hidden field and commits the name.
  - `activeElement` is `<body>`, and Space works as sustain in Perform.
- **A slot rebuild with a typed, uncommitted Lowest draft (E7a).** An outside instrument change removes the focused
  input, and Chromium fires `change`, so D3 was committed to the right song. Nothing was lost.
- **A slot rebuild during an EQ drag (E7b).** Drag a band, then change the instrument mid-drag, then keep dragging and
  release.
  - No EQ writes after the rebuild. The editor count is created 2 / destroyed 1, with one `.eqk` and no errors.
  - `build()` destroys the Tone editor before the binder: `destroy()` runs leaveAB, cancelDrag and d.dispose.
  - A switch that keeps the instrument keeps the editor, and its own `songReset` drops the gesture (round3-eq M2).
- **Undo inside a focused field (E6a).** Ctrl+Z in the notes after the debounced commit restores the text, and the
  debounce re-commits it.
- **Binder destroy on rebuild.**
  - The old binder's subscriber still sits in `core.onStore`'s snapshot, but it runs over an emptied set, which is
    harmless.
  - The 'dirty' capture listeners are removed, tracked components are destroyed, and the leave hook is dropped (see
    n1 for the bookkeeping entry).
- **Sentence titles.**
  - Slot: the title is recomputed on every store event, on `'changes'` (baseline) and on `'instruments'`, deduplicated
    by a key. The Space noun, instrument name, changed dots and `update(i)` (forced) are all current.
  - Song: `KEY_RELS` + tempo + `'changes'`.
  - No stale path found.
- **⌘Z does not reach the app's own shortcuts.** In `controller.onKeyDown`, a modifier chord other than the handled
  ones returns before the computer-keyboard map, so Z (octave) doesn't fire.

## Prioritised fix list

1. **M1:**
   - `shell.js` songField: forget the id on `focusout`.
   - `song.js` notes `input`: ignore it when the textarea isn't focused.
   - Add the E6c and E6d tests.
2. **m1:** slot note fields → `text:'dirty'`, with E2 tests.
3. **m3:** tempo `validity.badInput` guard.
4. **m2:** `isComposing` / 229 guard in the name (and the other Enter handlers).
5. **n1–n3.**

## For the LOCAL session (the orchestrator to relay; this review is read-only outside this file)

After the M1 fix drops, check it on the Mac:
1. In Edit › Song, type into song A's notes.
2. Switch to song B.
3. Go to Perform and press ⌘Z.

A's notes must be unchanged. Before the fix this reproduces through the Edit ▸ Undo menu (`role: 'editMenu'`,
main.js:521). No main.js change is needed.
