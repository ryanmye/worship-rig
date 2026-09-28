# Round 3 review: Edit area (H-v2)

Scope: `app/js/views/edit/**`, `components/{onTile,stepChip,stepPanel,headerChipRow,holdButton,quickSheet,overlay}.js`,
`shared/song-diff.js`, `shared/smart-controls.js`. The review was read-only. Experiments used Playwright on the real
app (`app/`, own server). The scripts are in the session scratchpad `review3-edit/exp*.mjs`.

## Suites (run one at a time, 2-CPU box)

| Suite | Result |
|---|---|
| `node test/phase2/edit-v2/run.mjs` | 10/10 files, 75 tests, all pass |
| `node test/phase2/settings/run.mjs` | 26/26 |
| `node test/phase2/ui-core/run.mjs` | 39/39 |

`reviews/local-findings.md` did not exist when this review ran.

## Findings

### M1 (major, CONFIRMED): an Edit step panel left open over a keyboard view switch eats Perform's first Esc (Panic) and first tap

- **Where:** `components/overlay.js:19-36` (`onKey` / `onPointerDown` act on `stack` top without checking visibility).
  Neither `views/edit/shell.js` nor its panels close their step-chip overlays when the Edit view is hidden.
- **Problem:** In Edit, open a slot's Space chip. Then switch view with Ctrl+E (Chrome; `controller.js:911`) or ⌘E
  (the Electron menu → `toggleView`). A pointer switch closes the panel through the outside tap; a keyboard switch
  does not, so the panel stays registered in the shared overlay stack inside the hidden `#view-edit`.
- **Measured (exp2):**
  - Control: Esc in Perform → 1 panic.
  - After Ctrl+E: `stillOpenAfterCtrlE: true`. The first Esc gives **0 panics**, because `onKey`
    preventDefaults, stops propagation and closes the invisible panel. The second Esc panics.
  - The first tap on a Perform strip chip is swallowed (`performChipOpenedOnFirstTap: false`).
  - The reverse direction (a Perform panel open, then ⌘E to Edit) leaves Perform's panel open in the same way.
- **Fix:** Make the overlay stack ignore overlays that can't be seen. In `onKey` and `onPointerDown`, first close
  every entry whose `el` is disconnected or `el.closest('[hidden]')` (reason `'hidden'`), then act only on a visible
  top entry. Belt and braces: the shell listens for `settings.view` leaving `'edit'` (an `onStoreHooks` entry) and
  calls a new `ctx.onLeaveView` hook, so panels `close()` their chips. Add a ui-core/integration test: Edit chip open
  → Ctrl+E → Esc panics.

### M2 (major, CONFIRMED): the slot panel keeps a step panel open across a song switch, and its fine-slider drag writes into the next song (round2-ui #2 class)

- **Where:**
  - `panels/slot.js:1013-1017`: `onLeaveSong` closes the menu and confirm and disarms, but never closes the chips.
  - `lib.js:409-411`: `binder.cancelDrags()` calls `c.cancelDrag?.()`, which `stepChip` does not have
    (`stepChip.js:200-233`).
  - Compare Effects (`effects.js:538-541`, closes its chips) and Perform (`perform.js` `renderSong`, closes
    `S.space/echo/octave`).
- **Measured (exp3):**
  - With Keys › Space open, `controller.selectSong(b)` leaves the panel open (`openAfterSwitch: true`).
  - Start a drag on the panel's fine slider in song A, switch to B mid-drag (as MIDI Next / ⌘→ does), and keep
    moving. B's `slots.0.sends.reverb` goes **0.30 → 1.00** (`draggedIntoNewSong: true`).
- **Fix:** In slot.js `onLeaveSong`, add `for (const {chip} of body?.chips || []) chip.close?.();`. Also give
  `stepChip` a `cancelDrag()` that closes the panel (or forwards to `fine.cancelDrag()`), so every
  `binder.track`ed chip is covered by `cancelDrags()` without each panel remembering.

### M3 (major, CONFIRMED): Edit › Effects has no "Song's own" for Space, so one audition tap loses a song's custom room

- **Where:** `panels/effects.js:214-216` (the Space chip row is `SPACE_PRESETS` only; Echo gets `own` at `:228-234`),
  combined with `perform.js:911-914` (leaving Edit makes the current song the new Revert snapshot).
- **Measured (exp8):** The boot song ("Sunday Pad + Piano") has room `{size .62, damp .5, predelay .025,
  returnGain 1}`, which matches no preset.
  - Edit's Space chips: dry, room, stage, hall, cathedral, wash. Echo's chips include `own`.
  - Tap Hall, then return to Perform. The snapshot is now Hall, Revert reads "nothing changed", and the original
    room is unrecoverable (`lost: true`).
  - Perform still shows a Space "Song's own" chip, which now means Hall. That is misleading.
- **Fix:** Add a Space "Song's own" chip in Edit mirroring the Echo one: show it when the baseline room matches no
  preset, and have it write `patch.fx.reverb` back from `editState.baseline`. Also write the whole object once, like
  Perform, instead of per key. Consider rebuilding Perform's Space own-chip visibility when the snapshot is re-taken
  on leaving Edit.

### m1 (minor, CONFIRMED): Brightness/Warmth show the dB of a shelf that the Tone editor switched off

- **Where:** `panels/slot.js:693-698` (`shelfDb` ignores `band.on`). `shared/eq-math.js:365-370` (`shelfWrites`) also
  targets off bands and silently switches them back on.
- **Measured (exp4, E5):** With `b1` = lowshelf +6 dB, `on:false`, Warmth reads **"Full +6.0 dB"** while the Tone
  summary on the same panel says **"Flat"**, and the engine hears it flat.
- **Fix:** Put one `shelfTarget(eq, which)` in eq-math, shared by read and write. For display, return 0 dB (or
  "off") when `!target.on`. Moving the slider may keep re-enabling the band, but say so in the Tone hint.

### m2 (minor, CONFIRMED): "No changes since the song was loaded" is shown after real sound edits

- **Where:** `panels/slot.js:961-967` / `lib.js:298-299` (`changeText`) and the rig hint at `shell.js:584`.
- **Measured (exp4):** Warmth moved to +8.4 dB writes `eq.b1.db`. Afterwards the slot footer still reads "No changes
  since the song was loaded" and the Keys tab has no dot.
  - This is per the DIFF_WATCH design (switch-type moves only), but the sentence is false. The same happens for
    Master (tape, glue, EQ), drone sliders, Effects fine-tune, range, pan and instrument params.
- **Fix (copy only):** Say "No switch changes since the song was loaded". Alternatively, when the counted set is
  empty but `JSON(slot) !== JSON(baseline slot)`, show "Sound edited (no switch changes)". The tab hint needs the
  same wording.

### m3 (minor, CONFIRMED): an instrument change drops the slot's instrument params with no Undo

- **Where:** `panels/slot.js:276-285` → `store.js:841` (`params: sameInst ? slot.params : {}`).
- **Measured (exp10):** `params.release = 5`. Pick Upright Piano, then pick Grand Piano back: `params` is `{}`, and
  no toast or Undo appears. "Remove this sound…" has confirm + Undo. A mis-pick in the menu (arrow + Enter) is
  irreversible once the player leaves Edit, because leaving rebaselines.
- **Fix:** Capture `{instrument, params}` before the write and show the same 8 s Undo toast, restoring both through
  `songs.<id>.patch.slots.<i>`.

### m4 (minor, CONFIRMED): the drone ON tile forgets its source on a tab switch, and Edit and Perform keep separate memories

- **Where:** `panels/drone.js:49` (`lastSource` is per mount) against Perform's `lastDroneSource` (kept per session
  until a song change).
- **Measured (exp8, E9):** Baseline Synth. Set My Pads, tile OFF, visit Keys, back to Drone, tile ON → **synth**.
  Perform would have restored My Pads.
- **Fix:** Keep the last-off source in one place both views read, for example a small map in the shell core exposed
  as `ctx.lastDroneSource`, or a controller field. Clear it on song change.

## Checked and solid

- **No leaks across 50 tab switches** (exp1). Keys was run with Advanced and Tone open, so the EQ editor mounts on
  every visit, plus the song block and one Effects step panel.
  - Live listeners on window, document, controller, engine, MIDI and EditState are unchanged, except window +1. That
    one is overlay.js's one-time `click` swallow hook, installed by the first overlay ever opened, and is by design.
  - `store.subscribe` count unchanged. The `#view-edit` node count is identical (1098). One `.eqk`, zero stray
    `.step-panel`, no stale `data-dialog-open`.
- **Tone editor lifecycle:** lazy mount, destroyed on close, rebuild and unmount (the integration test plus exp1).
- **Changed dots against Revert:** Edit uses `getBaseline()` when the ids match and falls back to its own snapshot
  on `songSelected` or a song change. Perform and Edit changed-path sets agree (the integration test). The store is
  deep-frozen, so the snapshot references are safe.
- **Esc inside Edit:** never panics. The shell's window-capture handler runs before overlay.js and main.js, and
  step panels still close through overlay.js because the shell does not `stopPropagation` when nothing of its own
  closed. `data-own-escape` fields work. Settings wins when it is open.
- **Lock:** Edit is unreachable while locked (`setView` refuses, ⌘E is bounced by `onSettings`, and the boot fixes
  the stored view). No Edit control needs its own lock rule.
- **Smart-control mapping direction:**
  - Brightness → `params.cutoff` (lowpass Hz), `params.tone` (sampler lowpass 0..1, fallback LPF, FM index 0..2),
    or the high shelf. All of them get brighter as the value rises.
  - Warmth + = a higher low shelf = "fuller".
  - The words and ends match. The legacy `eq.low/high` rows are no longer written once b-rows exist.
- **Song-bound fields (round2-ui #3):** name, notes, tempo and note fields commit to the song they were focused on.
  The notes debounce flushes on leave-song and on unmount.
- **1024×700, all 7 tabs with every section open** (exp6): no horizontal overflow anywhere and no control clipped
  outside the body. The body scrolls vertically (364 px tall), which the contract allows. Sentence-title tokens are
  23 px tall (inline text links; below the 28 px target). The EQ editor's 24–26 px buttons belong to eq-ui.
- **Sentence titles and tab summaries** re-render on every relevant store event and on instrument arrival. No stale
  titles were seen across song switches.

## Prioritized fix list

1. **M1:** overlay.js ignores and closes hidden overlays, and the shell closes panel chips when Edit is hidden. This
   is a safety issue (Esc = Panic). Add a test.
2. **M2:** slot.js `onLeaveSong` closes its chips, and `stepChip.cancelDrag()` exists. Add a test: a fine drag
   across `selectSong` writes nothing to the new song.
3. **M3:** a Space "Song's own" chip in Edit, restoring the room from the baseline.
4. **m1:** `shelfDb` / `shelfWrites` respect `on`, through one shared target helper.
5. **m3:** Undo toast for instrument changes.
6. **m2:** change-line and tab-hint copy.
7. **m4:** shared drone last-source memory.
