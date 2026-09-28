# Proposal B-v2: implementation plan

The features, data model, PARAMS table, store schema and controller API all stay the same, and the engine is untouched.
Views keep calling `store.set(...)` and `controller.*`. Everything below is view code, CSS and tests. Line numbers refer to
`app/js/views/perform.js` / `edit.js` as of 2026-09-28.

## Effort: **M–L** overall, shipped as 3 independent phases

| Phase | Scope | Effort |
|---|---|---|
| 1. Perform panel | ON tiles, sound picker popover, Sustain/Octave foot, collapsed empty slot, drone tile, switch bar (Space/Echo/Lofi/Undo), Prev·chips·Next row, PANIC/selected-chip restyle | **M** (2–3 days incl. tests) |
| 2. Lock rule + Quick drawer | v2 lock allowlist, hold-to-change helper, right push drawer with This song / This Mac tabs, "Song's own" chips | **S–M** (1–2 days) |
| 3. Edit song sheet | sentence lines, 3-row open line, FX cards with sends inside, range lanes, LIVE marker, dock Fade/PANIC | **L** (4–6 days incl. the ui-edit test rewrite) |

Phases 1 and 2 answer "settings I can change from Perform". Phase 3 answers "noisy / disconnected". The critique's
must-fix items (Pedal/Mono off the bar, PANIC colour, and the drone tile under lock) are all in phases 1–2.

## Components (`app/js/views/components/`)

**Reused as-is:** `fader`, `toggle`, `segmented`, `select`, `stepper`, `keyGrid`, `pianoKeyboard`, `meter`, `chordReadout`,
`wheelStrip`, `setlistStrip`, `h`/`disposer`/`blurAfterPointer`/`rafCoalesce`, and `groupInstruments`/`stageName` from
`instrument-groups.js`.

**New or extended:**

1. **`onTile({ role, color, onToggle })`** → `.set({ on })`. A `<button aria-pressed>` with an LED, the role and an ON/OFF
   badge, about 40 lines in `buttons.js`. There is also a `mini: true` variant for Edit lines. It carries no instrument
   name on purpose (critique #5).
2. **`soundPicker({ slot, onPick })`** → `.set({ ref, name, disabled })`. A select-looking button plus a popover listing
   `groupInstruments(engine.listInstruments())`, with the slot's current group first. It closes on pick, Esc or outside click.
   It has to stay above `.p-actions` so PANIC is never covered: max-height is computed from the `.p-bottom` top. About 110
   lines. Edit keeps its `select` (same list source).
3. **`holdToChange(el, { ms = 600, active: () => isLocked(), onCommit })`**. This lifts the existing Lock-button hold logic
   (perform.js ≈353–425: pointer capture, keyboard repeat guard, `.holding` class) into `util.js` so the Lock button,
   Transpose ±, the drone key grid, Major/Minor and Revert share one implementation. When `active()` is false it is a plain
   click. About 60 lines, and it replaces about 70 in perform.js.
4. **`segmented`** gains `variant: 'chips'` (CSS) and an optional **`extra` chip** slot for "Song's own"
   (`.setExtra({ label, sub, on } | null)`). About 20 lines.
5. **`sheetDrawer({ side: 'right', onClose })`**. A container that toggles `.qs` on the Perform root. The CSS grid pushes
   the stage, with no overlay and no scrim. Esc closes it and does not panic while it is open (the same `markDialog` pattern
   Edit uses, edit.js ≈1600). About 40 lines.
6. Edit only: **`sentence({ color, parts })`** plus pure builders in a new `views/sentences.js`, and **`rangeLanes(...)`**,
   the same as v1 (see `design/B/implementation.md` items 4–5).

## File by file

### `app/js/views/perform.js`

- **Strip build (≈200–216).** Replace `slot-head` and the MUTE button with `onTile` (→ existing `toggleMute(i)`) plus
  `soundPicker` (→ `setSong('patch.slots.i.instrument', ref)` via the same path Edit uses). Add the foot: a `toggle`
  (Sustain → `patch.slots.i.sustain`) and a `stepper` (−2…+2 → `patch.slots.i.octave`). Keep `data-testid="slot-mute-i"`
  on the tile.
- **Empty slot.** Render a `.slim` column that opens the picker. Grid template: `92px 1fr 1fr 64px 1fr 330px 250px`
  when EXTRA is empty; any empty slot index gets the narrow track.
- **Drone block (≈273).** The ON tile toggles the mode between `'off'` and its last on-mode. That on-mode comes from the
  derived rule in v1: `'files'` if `settings.padFolder` is set, else `'synth'`. The Synth/My Pads `segmented` stays, and
  `data-testid="drone-mode"` stays on it. Brightness, Movement, `continueAcrossSongs` and `chordFollow` are removed from the
  stage and built in `quick.js`. "Drone options ›" opens the drawer scrolled to the Drone row.
- **Head (≈147).** Remove `soundBox` (the Space/Vibe selects, ≈136). Next moves from the song row into the setlist row as a
  button beside the strip, reusing the existing next-song handler and `gapOf()` logic.
- **Switch bar (new, ≈80 lines).** Space `segmented` over `SPACE_PRESETS` (Room/Stage/Hall/Cathedral + "More" popover for
  Dry/Ambient Wash). Echo over `ECHO_PRESETS` (Off = `none`). Lofi `toggle`: on applies the `fx.lofi.*` subset of
  `VIBE_PRESETS.lofi`; off sets `fx.lofi.amount = 0`. Undo: the existing `revertBtn`, wrapped in `holdToChange`. Keep
  `data-testid`s `space-preset`, `echo-preset`, `revert-song`.
- **"Song's own" chip.** Compute `matchPreset(ECHO_PRESETS, getFrom(snap.song))`. If that is `null` (the loaded song had a
  custom echo), show the extra chip labelled with `formatValue('fx.delay.time', …)`. Tapping it applies the
  `fx.delay.*` values from `snap.song` (the snapshot already kept for Revert, ≈487–489). The chip is lit when the current
  values equal the snapshot's. Space works the same way with `fx.reverb.*`. There is **no new stored state**, because the
  snapshot is in memory and is re-taken on the Edit→Perform return exactly as today (≈542).
- **Lock (≈445, 538–628).** Replace `if (isLocked() && field !== 'drone.gain') return;` with an allowlist:
  ```js
  const LOCK_LIVE = [/^drone\.(gain|mode)$/, /^patch\.slots\.\d\.(gain|muted|sustain|octave)$/, /^patch\.fx\.(reverb|delay|lofi)\./];
  const LOCK_HOLD = [/^drone\.(key|minor)$/, /^transpose/];          // only reachable through holdToChange
  ```
  Here `drone.mode` is allowed only from the ON tile. The Synth/My Pads chips stay disabled under lock, so the chip handler
  checks `isLocked()` itself. Transpose: `tDown/tUp.disabled = !song` (≈559), plus `holdToChange`. The drone grid and
  quality use `holdToChange` instead of `setDisabled(locked)` (≈601–603). The pickers, drone mode chips, Vibe, drone
  options and swell time keep `setDisabled(locked)`. Update the Lock button tooltip text (≈320) to the v2 rule.
- **Styles.** Lift `design/B-v2/src/perform.css` into `app/styles.css`. It is written against the existing tokens and adds
  `--sel-bg`, `--sel-line`, `--panic`, `--panic-ink` and `--lockc`. The PANIC restyle is a one-rule change and can ship on
  its own.

### `app/js/views/quick.js` (new, ≈220 lines)

- **This song:** Space/Echo (with blurbs from `preset.blurb` and the extra "Song's own" chip), Lofi, Vibe, Drone
  (2 faders + 2 toggles moved from perform.js), and Swell time (4/8/12/16 s; any other stored value shows as its own lit chip,
  so nothing is lost).
- **This Mac:** `settings.pedalInvert` + Test, `settings.monoOutput`, `settings.velocitySens`,
  `settings.programChange`, `settings.computerKeyboard`, `controller.restartAudio()`, and "All settings…" →
  `ctx.openSettings()`.
- **Lock:** This Mac rows get `setDisabled(locked)` except Test and Restart audio.

### `app/js/views/settings.js`

Export `startPedalTest(ctx, onResult)` (≈365–400) and the `VEL_HINTS` copy so quick.js reuses them. The modal itself
is unchanged.

### `app/js/views/edit.js` (phase 3)

- Same as v1 (`design/B/implementation.md`, the edit.js section), with these v2 differences:
  - The open slot line has **3 rows**. *Sound* is the select plus the first 2 params. *Plays* is split + **the same
    `stepper` and `toggle` components as the Perform foot**. The rest goes in a `details` fold, "More for <Role>".
  - The line's on/off is `onTile({ mini: true })`.
- **LIVE marker.** A `span.live` in the sheet head plus the one-line note. The rail heading gets the "Tap a song to switch to
  it" hint, and the current row gets `.playing` bars driven by the existing `currentSongId`. No behaviour changes.
- **Dock.** Append `fadeBtn` and `panicBtn`, bound to `controller.fadeOutAll()` and `controller.panic()` (the same calls
  Perform uses). The Esc handler (≈1600–1625) is unchanged.

### Tests

- **`test/phase2/ui-core/run.mjs`**
  - `space-preset`/`vibe-preset`: select → chip click (vibe is now inside the drawer).
  - `revert-song`: now in the switch bar.
  - Lock assertions: Transpose/drone key are **not** disabled but ignore a click; a 600 ms hold commits; Sustain and Space
    work while locked; the picker and Vibe are disabled while locked; the drone tile toggles while locked.
  - New: the drawer leaves `.p-actions` and every `.strip .vf` clickable (elementFromPoint); PANIC is not covered by the
    picker popover.
- **node:test**
  - "Song's own" logic as a pure helper in `shared/fx-presets.js`: `ownChip(presets, snapGet, curGet)` →
    `{show, on, label}`.
  - The `sentences.js` builders.
- **`test/phase2/ui-edit/run.mjs`**: the selector rewrite as in v1, plus: the dock PANIC calls `controller.panic`, and Esc
  still does not.

## Risks (implementation)

1. **The behaviour change in lock** touches ui-core tests and `CONTRACT_CHANGES.md` (log it as "## perform-lock v2").
2. **Hold-to-change on 12 key buttons.** Pointer capture per button is fine, but the keyboard path (Enter held) must reuse
   the existing repeat guard (≈397–420), or Enter auto-repeat will change keys.
3. **Popover focus.** The sound picker must return focus to the picker button and `blurAfterPointer` after a pick, so
   Space goes back to being sustain (SPEC §10).
4. **Width budget at 1024 with the drawer open** (strips about 114 px). The picker hides its chevron there, and the foot
   stacks Sustain over Octave. Check this against long instrument names ("Clean Electric Guitar"), which ellipsize.
