# C "Hardware panel": implementation plan

**Scope:** presentation and information architecture only.
- No store schema change, no new params, no engine or controller change.
- Every control writes the same `store.set('songs.<id>.…')` paths that `perform.js` and `edit.js` write today.
- It reads the same `PARAMS`, `describe()`, `listInstruments()`, `SPACE/ECHO/VIBE_PRESETS` and `matchPreset`.

**Overall effort: L.** Perform is about M, Edit about L, and the components are S–M. The work splits into three reviewable steps (below).

## 1. The core structural change

Today Perform and Edit are two unrelated DOM trees: `perform.js` (895 lines) and `edit.js` (1748 lines). C needs **one panel DOM that both views share**:

- New `app/js/views/panel.js`, `mountPanel(el, ctx, { mode })`. It builds the chassis columns (Control, 4 slots, Drone, Effects), subscribes to the store, and patches values in place. This follows the existing targeted-patching rule (SPEC §10), so there is no re-render on song switch.
- `setMode('perform'|'edit')` only toggles classes: `.panel.edit` shows the MORE tabs, turns the instrument display into a picker, and enables the drawer. It never rebuilds the DOM. That is what keeps positions stable.
- `perform.js` keeps what is Perform-only: the program row, setlist strip, keyboard, stage cluster, lock and revert snapshot, and the SYSTEM drawer. It mounts `panel.js`, and its slot, drone and preset render code moves into `panel.js`.
- `edit.js` keeps the library and program editing (song name, Easy Transpose, tempo, notes, setlist management, import/export, reset). Its slot-card, drone-section, FX-section and wheels-section builders are **re-homed as drawer bodies**:
  - `buildSlotBody` → slot drawer
  - `presetPicker` and the FX expanders → Effects drawer
  - wheels & pedals → Control drawer
  - key drone → Drone drawer

  The field-binding helpers (`bindCtl`, `bindFn`, `refresh`, `track`) move with them, or `panel.js` imports them from a small shared `bind.js`.
- `main.js`'s view switch (`setView`) stops hiding one view and showing another for the panel area. The program row, library bar and bottom row swap their Perform/Edit variants, and the panel stays mounted. `#view-perform` and `#view-edit` can remain as the wrappers for those variant rows.

## 2. Components

| Need | Existing component | Change |
|---|---|---|
| Slot and Drone Level | `fader({vertical:true})` | reuse as is (thumb, relative drag from B2, dB label) |
| Rotary knob (sends, tone, width, FX, instrument params) | `knob()` is currently a compact **horizontal** slider, deliberately "no rotary mousing on stage" | **new visual skin, same API and same `<input type=range>`**. The rotary look is CSS (`conic-gradient` arc plus a rotated pointer driven by `--v`, see `.dial` in `src/build.mjs`). Input: vertical **relative drag** via the existing `util.relativeDrag`, the wheel, and the arrow keys. Double-click to reset **in Edit only**, as today. Size **M**. |
| LED button (SUS, MUTE, Major/Minor, Follow, Keep, Mono, Reversed…) | `toggle()` | add a `.led` span and `aria-pressed`, via a CSS class (S) |
| LED list, choose one (Space, Echo, Touch) | `segmented()` | a vertical layout variant: `segmented({ layout:'list', leds:true })` with `role=radiogroup` (S). Half-lit "closest" = a new `approx` option that computes nearest-by-distance over the preset params (UI-only; `matchPreset` stays). |
| OCT −/+ with LED ladder | `stepper()` | add a `ladder` render option for −2…+2 (S) |
| Vibe ◀ name ▶ | `select()` / `stepper()` | a cycling stepper over `VIBE_PRESETS` (S) |
| Instrument display / picker | `select()` + `instrument-groups.js` | reuse; in Perform it renders as a read-only LCD |
| Drone key grid | `keyGrid()` | reuse (the lock guard already exists in `setSongKey`) |
| Keyboard with range bars | `pianoKeyboard()` | **add an overlay of slot range bars** (absolute divs computed from `keyLayout()`), with drag handles when a slot is selected (M). Reuses `miniKeyboard`'s range logic (nearest-handle drag, arrows ±1, Shift ±12, double-click = whole keyboard). `miniKeyboard` is no longer needed in the slot card. A Sunday Keys-style "press Set, then play a key" is deliberately left out, because it would be a new input feature. |
| PLAY lamp | none | derived: `heldNotes ∩ [lowNote, highNote] && !muted`. Held notes are already fed to `pianoKeyboard.set(held)` (S) |
| FED BY bars | none | derived: four bars whose heights are `slots[i].sends.reverb` / `.delay` (S) |
| ALSO lamps | none | derived: chorus `returnGain > 0`, lofi `amount > 0`, EQ not flat, comp `amount > 0` (S) |
| Wheel strip, chord readout, meter, setlist strip | `wheelStrip`, `chordReadout`, `meter`, `setlistStrip` | reuse; restyle to match the panel. `setlistStrip` gets an `editable` mode (grips, dup/delete on the current chip), and the drag reorder it already has is reused. |
| Drawer | none | new `drawer.js`, about 60 lines: a container that attaches to a column index, shows a title and PREV/NEXT/DONE, and closes on Done or on a second click of the section tab (S) |
| SYSTEM drawer | the controls exist in `settings.js` | factor `settings.js`'s Touch, pedal (Reversed + Test), Mono, Restart, Program Change and Computer keyboard rows into exported builders, and mount them in both the modal and the SYSTEM drawer (S–M) |

## 3. Files that change

- `app/js/views/panel.js`: **new** (the shared panel).
- `app/js/views/components/drawer.js`: **new**. `fader.js` gets the rotary skin for `knob`. `buttons.js` gets the LED option and the list/ladder variants. `keys.js` gets the range-bar overlay. `setlist.js` gets the editable mode.
- `app/js/views/perform.js`: slot/drone/preset rendering moves out to `panel.js`. The program row is rebuilt as an LCD. SYSTEM button and drawer are added.
- `app/js/views/edit.js`: the left library column and the centre/right card grid are removed. Library → the editable setlist row plus "+ Add song" and "Library ▾" popovers. Slot/drone/FX/wheels bodies → drawer bodies.
- `app/js/views/settings.js`: export the stage-setting row builders; the modal keeps everything.
- `app/styles.css`: panel chassis, `.sec`, `.led`, `.lcd`, `.hb`, `.dial` and drawer tokens. **Reuse the existing tokens**: `--slot-0..3`, `--accent`, `--led-off` (≥ 3:1, per the UX review), `--track-edge`.
- `app/styles-edit.css`: shrinks a lot (cards, the 2×2 grid and the three columns go away).
- `app/js/main.js`: the view switch keeps the panel mounted.
- Tests:
  - `test/phase2/ui-core` and `ui-edit` selectors change.
  - Every engine/store assertion stays the same: faders change `engine.getParam`, the key grid changes the drone key, settings persist.
  - New checks: the drawer opens under the right column, and the lock freezes SUS/OCT/sends and SYSTEM.

## 4. Suggested order (each step shippable)

1. **Perform panel (M).**
   - Rotary knob skin, LED toggle, LED list.
   - Build `panel.js` for Perform only: slot SUS/OCT/SPACE/ECHO, Space/Echo lists, Vibe, Drone Brightness/Movement, and the ALSO/FED BY/PLAY derived lamps.
   - Range bars on the keyboard (read-only).
   - Lock-guard every new control through the existing `isLocked()`.
2. **SYSTEM drawer (S–M).** Settings row builders and `drawer.js`.
3. **Edit = panel opened (L).**
   - Edit mode of `panel.js`.
   - Drawers built from `edit.js` bodies.
   - Program row editing.
   - Editable setlist row with Add/Library popovers.
   - Range handles.
   - Delete the old Edit layout.

## 5. Risks

- **Busier Perform, and more accidental song changes (M7).** Perform gains sends, octave, sustain and the Echo list per song. Mitigations: relative-drag knobs (no jump-to-click); the Lock covers them; Revert song already exists. If it is still too busy, drop the per-slot knobs from Perform (keep SUS/OCT/MUTE). That fallback is a CSS/mode flag, not a feature.
- **Rotary knobs with a mouse or trackpad** are the classic plugin-UI complaint, and the reason `knob()` is horizontal today. They need relative vertical drag, plus a fine-drag modifier (Shift), wheel and keys. The drag must be tested on a MacBook trackpad in low light. It is unverified until then.
- **The Edit fader is short** (about 90 px at 1440×900) while a drawer is open. **Edit at 1024×700 is not mocked.** The plan (drawer overlays the lower panel when height < 800) needs a mockup and a critic pass.
- **The library in a strip** is weaker than today's left column for large libraries (search is in the "+ Add song" popover). Users with 50+ songs might miss the always-visible list.
- **Big refactor surface.** Merging the slot/drone/FX renderers of two 900–1700-line views into one `panel.js` is the bulk of the L. The reward is that the two views can never drift apart again. Mitigation: step 1 touches Perform only, and the old Edit keeps working until step 3.
- **Skeuomorphism in bright rooms.** LEDs and LCDs are low-contrast by nature. Keep the `--led-off` ≥ 3:1 rule, glow only on the lit state, and 12 px minimum label size. Lists and buttons must still read at 1.5 m (ux.md M10).
- **The "closest preset" half-lit LED** is a new UI computation, a nearest-preset distance. It is presentation only, but it could mislead ("Stage-ish") if the distance metric is crude.
