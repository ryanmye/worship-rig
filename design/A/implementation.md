# Angle A: implementation plan

**Rule:** presentation only. Every control still writes the same `store.set(path, v)` / `controller.*` call it does
today. There are no new store fields, no new PARAMS rows and no engine changes. Settings keep their current keys.

**Overall effort: L.** Perform + Quick drawer is **M**. The Edit restructure is **L**, because edit.js is 1,713 lines
of card-based layout. They can ship separately: Perform first, since it's lower risk and answers the "toggles" request.

---

## 1. Reused as-is (components/*)
| Component | Where in A |
|---|---|
| `fader` (vertical) | Level in Perform strips (unchanged) **and** the Edit Sound panel, Drone panel, Master panel |
| `fader` (horizontal) | Advanced rows, drone level, fx Level in panel headers |
| `segmented` | Octave (−2…+2), Voices, Touch, drone mode, major/minor, Touch in Quick, **preset chips** (Space/Echo/Vibe) |
| `toggle` | Sustain pedal, Pitch bend, Follow chords, Continue, Reversed, Mono, Keyboard picks songs (the switch look is CSS only) |
| `select` | Instrument picker (grouped via `instrument-groups.js`), wheel/expression/CC7/bend routing in the Keyboard panel |
| `stepper` | Slot transpose, bend range, tempo |
| `keyGrid` | Drone key (Perform + Drone panel) |
| `pianoKeyboard` | Perform + Edit bottom keyboard (gets an overlay, see below) |
| `meter`, `wheelStrip`, `setlistStrip`, `chordReadout` | unchanged |
| edit.js `bindCtl / bindFn / refresh / section` machinery | kept. Panels are built with the same binding helpers, so store→DOM patching stays targeted (SPEC §13) |

## 2. New pieces
| New | What | Size |
|---|---|---|
| `shared/smart-controls.js` (pure) | `smartKnobsFor(instrumentMeta, slotIndex)` → `[{role:'brightness'|'warmth'|'shape', path, label, words}]` using the rule in concept §3; `wordFor(role, normalised)`; `nearestPreset(presets, getValue)` (distance over each preset's own params, used for "Custom ≈ Hall"). node:test covered. | S |
| `components/dial.js` | A rotary knob built on a visually hidden `<input type=range>` (keeps a11y, keyboard, and the existing `{el,set,destroy,onChange}` contract). SVG arc like the mockup's `knob()` helper. Drag is **vertical relative** via the existing `util.relativeDrag`, so there is no jump-on-tap (ux B2). Wheel/arrow nudge; double-click reset from `params.describe`. `bipolar` option for Warmth. The existing `knob` (a compact horizontal slider) stays for anything that still uses it. | S–M |
| `fader` variant `send` | CSS plus an arrow and an optional destination chip ("→ Hall" jumps to that map block). Same component, same path `slots.i.sends.*`. | S |
| `components/rigMap.js` | Absolutely positioned HTML blocks + one `<svg>` for wires (x in %, y in % so it scales, `vector-effect: non-scaling-stroke`), plus dots sized by send. `set({song, selected, lit})`. Subscribes to the store paths it shows (instrument names, gains, sends, drone mode/key, preset names, lofi amount, master). `onSelect(blockId)`. Geometry is lifted from `design/A/src/edit.mjs`. | M |
| Activity ("lights") | In edit.js/perform.js: on the controller's existing **`held` event** (perform.js already consumes `e.detail.held`), a slot is lit if `slot && !muted && gain>0 && held.some(n => n>=lowNote && n<=highNote)`. An FX block is lit if any lit slot has send > 0. No engine access. | S |
| `pianoKeyboard` range overlay | `rangeBars({from,to})` sits above the keys: one bar per non-empty slot, `set({ranges, selected})`. In Edit the bar ends are draggable and write `slots.i.lowNote/highNote` (plus "click the end, then play a note", like Sunday Keys). | S–M |
| `presetTiles` | `segmented` with a `blurb` line per option (the blurbs already exist in `fx-presets.js`) and a "near" (dashed) state from `nearestPreset`. | S |
| Perform `modChip` + `popover` | Chip = button showing label, value and a bottom amount bar in slot colour. Popover = the same `dial` + a line of context. The popover must `blurAfterPointer` and close on Esc **without** triggering panic (ux M1 context), and must respect `settings.performLock`. | S–M |
| `views/quick.js` | Drawer mounted by perform.js. Sections: This song (Space/Echo presetTiles via `applyPreset` → `store.set`), Every song (`settings.velocitySens`, `settings.pedalInvert` + live pedal light from the controller's `pedal` status, `settings.monoOutput`, `settings.programChange`), status + `controller.restartAudio()`, and "All settings" → `ctx.openSettings()`. It is read-only when `performLock` is set. It is non-modal: no focus trap, and piano keys keep working. | M |

## 3. Files that change
| File | Change | Effort |
|---|---|---|
| `app/js/views/perform.js` (829 lines) | Strip: add icon + 4 modChips + popover. Replace the Space/Vibe selects with 2 pills (Vibe moves into the Space popover). Drone block gets 2 dials. Add the Quick button + drawer and the range overlay on the keyboard. | M |
| `app/js/views/edit.js` (1,713 lines) | **Largest change.** Replace the card grid (`makeCard`, `buildSlotBody`, the FX column, the Wheels/Drone/Transpose cards) with `rigMap` + a `focusPanel(blockId)` switch that calls the panel builders: `soundPanel(i)`, `dronePanel()`, `keyboardPanel()` (Easy Transpose + routing), `fxPanel('reverb'|'delay'|'chorus'|'lofi')`, `masterPanel()`. Each builder is mostly *moved* code from today's section builders, re-laid out into the 4 columns + Advanced. The library column (`renderList` etc.) and import/export are untouched. The selected block is remembered per session in `readSections/writeSections` (it already stores open/closed state). | L |
| `app/styles-edit.css` (367 lines) | Mostly rewritten for map, panel, Advanced, and the 1024 layout (library → drawer). | M |
| `app/styles.css` | Tokens `--fx` (steel) and `--drone` (cream) so shared FX and the drone never use a slot colour or the accent (ux M4, H2). Styles for chip, pill, drawer and dial. | S |
| `app/js/views/components/index.js` | Export `dial`, `rangeBars`, `presetTiles`, `popover`. | S |
| `app/js/views/_fallback-components.js` | Mirror the new exports (it exists so the views run if a component fails to load). | S |
| `app/js/views/settings.js` | **No change.** The drawer writes the same settings keys. Optionally extract the "Touch" and "pedal" row builders so Quick and Settings share them. | S |
| `test/phase2/ui-edit/**`, `test/phase2/ui-core/**` | Update selectors. **Add a "nothing lost" test:** for every PARAMS address used by a factory song, Edit exposes a bound control reachable in ≤ 2 clicks (map block → panel, or panel → Advanced). Add a Quick drawer test: Touch/Reversed/Mono persist in `store.settings` and are disabled under Perform-lock. | M |
| `CONTRACT_CHANGES.md` | A `## ui-instrument-first` section (new components, no store/engine changes). | S |

## 4. Suggested order
1. `smart-controls.js` + `dial` + tokens (S). Nothing visible changes yet.
2. Perform: chips + popover, pills, drone dials, range bars, **Quick drawer** (M). Shippable on its own, and it
   answers "settings I can change from Perform".
3. Edit: rigMap + Sound panel for the 4 slots, with Advanced (L, the biggest step).
4. Edit: Drone / Keyboard / Space / Echo / Chorus / Tape / Master panels (M). The old right column is deleted in
   this step.
5. The 1024 pass + tests + screenshots.

## 5. Risks
- **The focus panel hides the other sounds' controls.** To compare the Keys and Pad levels you switch blocks. The map
  shows every level line and send dot, but not a fader for each. If users balance levels in Edit a lot, this is
  worse than "4 columns open". Mitigation: the Level faders stay on Perform, where balancing really happens.
- **Knobs on a trackpad.** A rotary control dragged vertically is a learned gesture. The mitigations are a hidden
  range input (arrow keys), scroll-wheel nudge, a big hit area (78 px) and the value shown as a word. This needs a
  real try on a MacBook trackpad.
- **The word buckets could mislead** ("Bright" at 100% tone on a dark sample). The number is always shown. Words
  come from the normalised position, not from analysing the sound.
- **Map crowding with long names** (My Samples / GarageBand imports). Blocks truncate. Use `stageName()` and a
  `title` tooltip. The panel header always shows the full name.
- **Test churn.** ui-edit Playwright tests are tied to today's card DOM. Keep `data-testid`s on controls that bind the
  same path wherever possible.
- **Concurrent agents are editing `app/` right now.** Land this after their changes merge, or rebase panel by panel.
  edit.js is the conflict hotspot.
- **Popovers and the drawer in a live service.** Accidental changes are possible, so both honour Perform-lock. Esc
  closes them first, and PANIC stays uncovered at every size (checked at 1440 and 1024).
- **"Lights" aren't audio.** They're driven by held notes, so tails and sustained decay aren't shown (see concept §5).
