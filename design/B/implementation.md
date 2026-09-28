# Proposal B: implementation plan

The same features, data model, params table and store/controller APIs apply throughout. No engine changes, and no new
persisted fields. The existing split still holds: views call `store.set(...)` for persisted values and
`controller.*` for actions.

## Effort: overall **M–L**. This can ship in two independent phases.

| Phase | Scope | Effort |
|---|---|---|
| 1. Perform panel + Quick settings | strip head tiles, Sustain/Octave foot, drone tile, switch bar, quick sheet | **M** (≈2–3 days incl. tests) |
| 2. Edit song sheet | rail kept; slot/FX cards → sentence lines + cards; keyboard range lanes | **L** (≈4–6 days incl. rewriting the ui-edit test) |

Phase 1 alone answers "settings I can change from Perform". Phase 2 answers "noisy / disconnected".

## Components

**Reused as they are:** `fader` (vertical in strips, horizontal for Level, sends and params), `toggle` (LED toggles),
`segmented` (every chip row: presets, octave, response, voices, drone mode, Major/Minor, Touch, pedal), `select`
(instrument picker, wheel targets), `stepper` (transpose, slot transpose, bend range), `keyGrid`, `pianoKeyboard`,
`meter`, `chordReadout`, `wheelStrip`, `setlistStrip`, and `h`/`disposer`/`blurAfterPointer`/`rafCoalesce`.

**New or extended (all small, all in `app/js/views/components/`):**

1. `layerTile({ role, color, onToggle })` → `.set({ on, empty, instName })`. A `<button aria-pressed>` with the role,
   ON/OFF badge, LED and instrument name. It is used for the 4 slots and the drone. About 60 lines in `buttons.js`.
2. `segmented` gains a `variant: 'chips'` style class and **`setNear(value|null)`**, which draws the dashed "closest"
   outline. That is about 15 lines. Nearest-preset search is a new **pure** helper in `shared/fx-presets.js`:
   `nearestPreset(presets, getValue)`, which returns the preset with the smallest normalised distance over its numeric
   params. It is unit-tested next to `matchPreset`.
3. `toggle` gains `variant: 'switch'` (the pill switch on Edit lines). This is CSS only.
4. `sentence({ color, parts })`. Parts are strings or `{ text, onClick, bind }` tokens rendered as `<button class="tok">`
   (keyboard-focusable, underlined). It returns `{ el, set(parts) }`. The text builders are pure functions
   (`slotSentence(slot, role, patch)`, `droneSentence`, `handsSentence`, `fxSentence.*`) in a new
   `app/js/views/sentences.js`. This extends today's `slotSummary()`/`firstSentence()` in edit.js. Being pure, they can
   be tested with node:test.
5. `rangeLanes({ from:36, to:96, lanes:[{slot, color}], onRange(slot, {low, high}) })`. These are coloured bars with
   drag handles, laid over `pianoKeyboard` in a shared wrapper. It reuses `keyLayout()` for x positions and the
   `miniKeyboard` drag logic. Notes outside 36–96 render as an arrow "◂ extends below". It is about 120 lines in
   `keys.js`.
6. `sheet({ anchor, onClose })`, a generic bottom sheet with a scrim. It traps focus, closes on Esc (Esc stays Panic
   when no sheet is open, research M1), and leaves `.p-actions` uncovered. About 50 lines in `util.js`.

## File-by-file

* **`app/js/views/perform.js`**
  * The strip build around line 200: the head becomes `layerTile` wired to the existing `toggleMute(i)`. The MUTE
    button is removed. Its `data-testid="slot-mute-i"` moves to the tile.
  * The foot adds `toggle` (Sustain → `slots.i.sustain`) and `stepper` (Octave → `slots.i.octave`, range −2…2),
    both disabled when locked.
  * The drone block's mode `segmented` moves inside the drone tile. Tile tap: if `mode !== 'off'` → `'off'`;
    otherwise → `'files'` if `settings.padFolder` is set, else `'synth'`. This is derived from existing state, so
    nothing new is stored. The Synth/My Pads chips set the mode explicitly. `data-testid="drone-mode"` stays on the
    chips.
  * The `spaceSel`/`vibeSel` selects (line ≈136) are replaced by the switch bar's chip rows (Space in the bar, Vibe
    in the sheet). `data-testid="space-preset"` and `"vibe-preset"` move to the chip groups.
  * The Echo chips use `ECHO_PRESETS`. Lofi toggle: on → apply the `fx.lofi.*` subset of `VIBE_PRESETS.lofi`; off →
    `fx.lofi.amount = 0`.
  * `revertBtn` moves into the quick sheet (same `revertSong()` and the same disabled logic).
  * Lock handling (≈ lines 509/696) extends to the new controls. Pedal reversed/Mono in the bar are wrapped with the
    existing hold gesture (`HOLD_TO_UNLOCK_MS`) while locked.
* **`app/js/views/quick.js`** (new, about 200 lines). It builds the Quick settings sheet from components. This song:
  Vibe/Space/Echo `segmented` + blurb (`preset.blurb`), Swell time `segmented` (4/8/12/16 s; any other value is shown
  as a lit "N s" chip, so the existing value isn't lost), and Revert. This Mac: `settings.velocitySens`,
  `settings.pedalInvert` + Test, `settings.monoOutput`, `settings.programChange`, `settings.computerKeyboard`, and
  `controller.restartAudio()`. It is mounted by perform.js.
* **`app/js/views/settings.js`**: export `startPedalTest(ctx, onResult)` and the `VEL_HINTS` copy so quick.js reuses
  the same pedal-test flow (lines ≈365–400) instead of duplicating it. The Settings modal itself is unchanged.
* **`app/js/views/edit.js`**: the largest change.
  * The library rail code (`renderList`, `songRow`, setlists, import/export, factory) is kept as it is.
  * `makeCard`/`buildSlotBody` (≈1101–1430) are replaced by `slotLine(i)`, which has a sentence header and a 4-row
    body (Sound, Where, Feel, Voices) plus the Placement & tone fold, built from the same `bindCtl` helpers so every
    `data-bind` address survives.
  * `presetPicker` (≈1436) becomes chip rows.
  * The FX column becomes 6 cards, with the send faders moved from the slot cards into the Space/Echo/Chorus cards.
  * Drone and Wheels & pedals become the DRONE and HANDS lines.
  * The Easy Transpose section becomes the sheet-head sentence (the same `keySelect` controls, opened from the tokens).
  * Only one line is open at a time. Remember which one in the existing `readSections()`/`writeSections()` UI state
    (localStorage), not in the song.
* **`app/styles.css` / `app/styles-edit.css`**: add the token `--fx-on: #e4ebf4` (neutral lit state) and the tile,
  switch-bar, sheet, sentence/token and lane styles. The mockup CSS in `design/B/src/*.css` is written against the
  existing tokens and can be lifted almost as is.
* **`app/js/views/components/index.js`**: export the additions.
* **Tests**
  * `test/phase2/ui-core/run.mjs` uses data-testids. The only ones that change behaviour are `space-preset` and
    `vibe-preset` (select → chip click) and `revert-song` (now inside the sheet, so the test opens it first).
  * `test/phase2/ui-edit/run.mjs` has about 78 DOM selectors tied to `.ed-slot`, `details.ed-more`, `.ed-sends-sum`
    and `select[data-preset=…]`, and needs a rewrite of its selectors. The assertions (store values and engine
    params) stay. Keeping `data-bind="<address>"` on every control keeps most of it mechanical.
  * Add node:test for `sentences.js` and `nearestPreset`, plus Playwright for: tile toggles `muted`; Sustain/Octave
    persist; the lock freezes them; the sheet leaves PANIC clickable; range lanes set `lowNote`/`highNote`.

## Risks

1. **One-tap toggles overwrite continuous values.** Echo Off, Lofi on/off and the preset chips replace a song's custom
   `returnGain`/`amount` with preset values. Today's Perform Space/Vibe selects already behave this way, and
   **Revert song** undoes it (existing snapshot). An exact "restore my custom value" would need remembered state,
   which is out of scope.
2. **Global settings in the Perform bar** (Pedal reversed, Mono) can be flipped mid-song. They are mitigated by
   hold-to-change under lock and a "THIS MAC · ALL SONGS" label. An alternative is to keep them only in the sheet;
   the 1024 layout already does that.
3. **Sentence copy is harder than labels.** It needs care with odd states: a split plus octave plus mono gives a long
   sentence, and Custom FX need a description. The rule "mention only what differs from normal" and a hard cap (wrap
   to 2 lines max, then "…") keep it bounded. Wording needs a test with a real volunteer. This is [infer] and
   untested with users.
4. **Edit doesn't copy Perform's geometry** (unlike angle A). Continuity rests on colour, shared names and shared
   switches rather than on position. If "disconnected" is mainly about position, A's column layout is the stronger
   fix. B's sentence sheet could be combined with A's columns later.
5. **1024×700 Edit.** Two columns fit, but an open slot line pushes the rest of *What plays* below the fold (see
   `edit-1024.png`). Mitigation: at ≤1180 px, open lines show 3 rows and the Feel/Voices rows merge, or the right
   column becomes a tab.
6. **Test churn in ui-edit** (see above). It is mechanical but real.
7. **Colour/contrast.** The near-white "on" chip must stay ≥3:1 against `--panel` and dark text ≥7:1 on it (it is
   #0b0d10 on #e4ebf4, about 16:1). The dashed "closest" outline uses `--faint` (#8a93a0), which is about 5:1 on
   `--panel-2`. The dim OFF strip (45% opacity) should still keep its dB text ≥3:1; verify with the contrast table in
   reviews/ux.md.
