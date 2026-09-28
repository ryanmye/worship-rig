# Angle D: implementation plan

The guiding rule is **no change to functionality**. `store.js`, `controller.js`, `engine/*`, `shared/params.js` and
`shared/fx-presets.js` are untouched. Every control in D writes a path that exists today, through
`store.set(...)`, or calls a `controller.*` action that exists today (`restartAudio`, mute toggling, preset apply).
No schema bump and no migration.

Estimated effort: **M**. Perform is S. Edit is M: it is a re-layout of `edit.js` around existing bindings, not a
rewrite of them.

---

## 1. What is reused

| Existing | Used for in D |
|---|---|
| `fader({vertical:true})` (components/fader.js) | every strip fader on the desk: 4 slots, drone, 3 returns, master. It is the same component and colour as Perform. |
| `knob()` | quick-panel "Into Space"; inspector "Shape the ‹instrument›" knobs (the round variant; see §2) |
| `segmented()` | Octave −2…+2, Touch, drone mode, Voices, Major/Minor |
| `stepper()` | Transpose; quick-panel Octave |
| `toggle()` | Sustain, Pitch bend, Mono, Keyboard picks songs, Continue across songs |
| `select()` / instrument-groups.js | instrument picker in the Sound tab (grouped as today) |
| `keyGrid()` | drone Key tab |
| `miniKeyboard({low, high, onRange})` | Range tab |
| `pianoKeyboard()` + `.set(heldSet)` | bottom keyboard in Edit (already there) |
| `meter()` | master strip + top bar (analysers already exist) |
| `presetPicker()`, `matchPreset`, `applyPreset` (edit.js / fx-presets.js) | Space / Echo / Vibe preset cards. Change "Custom" to "Custom (closest: X)" by picking the preset with the least distance; this is display only. |
| `bindCtl` / `bindFn` / `refresh(rels)` (edit.js) | every desk cell and inspector control binds through these, so store→DOM patching and the "no full re-render on song switch" rule stay intact |
| `curveSpark`, `slotSummary`, `formatInstrumentParam` | Response tab, tab summaries, knob captions |
| `slotMuteState` / `toggleMute` (perform.js) | desk MUTE. Export it from perform.js (or move it to components/util.js) so both views share it. |
| Settings pedal test (`startPedalTest`, `pedalListener`, settings.js ~L360–395) | Output popover "Test". Extract it into a small shared module (`views/pedal-test.js`) that both the modal and the popover call. |

## 2. New pieces (all view-only)

| New | Where | Size |
|---|---|---|
| `quickRow(slotIndex)` + `quickPanel(slotIndex)` | perform.js (+ ~60 lines of CSS in styles.css) | S |
| `outputPopover()`, which reuses the settings bindings for `settings.monoOutput`, `velocitySens`, `pedalInvert`, `programChange`, `master.volume` and `controller.restartAudio()` | perform.js, or a new `views/output-popover.js` | S |
| `popover` primitive: anchor, outside-click-closes-but-passes-through, Esc, focus return | components/popover.js | S |
| `sendBar({value, color, onChange})`: the thin horizontal bar used on the desk rows. Drag or arrow keys; double-click resets. It is an `<input type=range>` styled thin, following the fader.js approach. | components/fader.js (a variant) | S |
| `rangeBar({low, high, color})`, a read-only mini range, plus draggable range bars over `pianoKeyboard` | components/keys.js | S–M |
| `activityLed(slot)`: held notes ∩ `[lowNote, highNote]` ∩ not muted, from the same held-set Perform already feeds `pianoKeyboard.set()` | edit.js | S |
| Desk layout: one CSS grid with named columns (`k p x b d | rv dl ch | ma`) and rows (`head range sp ec chr fad db mute`). Bus lines are grid items under the cells. See `design/D/src/edit.css`, which ports almost 1:1. | styles-edit.css | M |
| Inspector shell: header (colour, icon, name, ‹ ›), tab bar with per-tab summaries, one body at a time | edit.js | M |
| Song bar pills (Key, Tempo, Notes, Wheel) that select the "Song" inspector | edit.js | S |
| `knob` round variant: CSS-only (conic-gradient ring). The same `<input type=range>` underneath, with vertical drag via the existing `relativeDrag` (util.js). | components/fader.js | S |

## 3. Files that change

- `app/js/views/edit.js`: the main work. `buildSlotBody` and the `section()` cards are split into
  - `deskColumn(i)`: head, range, the 3 sends, fader, dB, mute
  - `inspectorTabs(i)`: Sound / Range / Response / Effects

  The FX sections (`presetPicker` and friends) move from the right column into the return/Master inspector tabs.
  The Easy Transpose, Tempo, Notes and Wheels cards move into the Song inspector. The library panel is unchanged.
  Each control keeps the store address it binds today.
- `app/styles-edit.css`: the desk grid, inspector and song bar. The old card styles are removed.
- `app/js/views/perform.js`: quick row, quick panel and Output popover. The Space/Vibe selects stay as they are.
- `app/styles.css`: quick row and panel, popover, `--drone` / `--fx` tokens.
- `app/js/views/settings.js`: pedal test extracted (behaviour unchanged).
- `app/js/views/components/*`: `popover.js` (new), a `sendBar` variant, `rangeBar`, the round `knob` style.
- `app/js/main.js`: `setView('edit', {select: 'slot:0'})`, so "Open in Edit ›" lands on the right strip. This is a
  view argument only, and nothing is persisted. (The last-selected strip could go in the view's
  `readSections`/`writeSections` localStorage, as the section open state does today.)
- Tests: update `test/phase2/ui-edit` selectors (`data-testid`s on the desk cells and inspector controls). Add
  Playwright checks for:
  - desk fader → `engine.getParam('slots.0.gain')`
  - send bar → `slots.0.sends.reverb`
  - Space preset card → `fx.reverb.size`
  - quick panel octave → `slots.0.octave`
  - Output popover Mono → `settings.monoOutput`
  - zero `console.error`

## 4. Order of work (each step ships on its own)
1. Perform quick row, quick panel and Output popover (S). This is independent of Edit and answers "settings from
   Perform" straight away.
2. Edit desk with the inspector showing the *existing* slot card body inside the Sound tab (M−). This proves the
   layout early.
3. Split the body into the 4 tabs; move FX into the return/Master inspectors; add the Song inspector (M).
4. Range bars on the keyboard, activity LEDs, hover-linking (S).

## 5. Risks
- **Comprehension:** mixer literacy (concept.md §4). Test step 2 with a real volunteer before doing step 3.
- **Regression surface:** edit.js is 1,748 lines, and its tests key on the current DOM. Keeping `bindCtl` addresses
  identical limits this to selector churn.
- **1024×700 Edit:** the library drawer and a scrolling inspector. This needs a real-device check on a 13" MacBook
  at 100% zoom.
- **Popover focus and keyboard:** Space = sustain only when nothing is focused (SPEC §10). The popovers must blur
  on close and never keep focus, or the computer-keyboard sustain breaks.
- **Perform-lock:** the quick panel must honour `settings.performLock` (read-only), and the Output popover must
  allow only Restart audio when locked. Otherwise a locked rig can be changed mid-song.
- **Not done, on purpose:** Solo, per-slot level meters (these need engine taps) and a drone send control (the
  engine's value is fixed). Each would be a feature change.
