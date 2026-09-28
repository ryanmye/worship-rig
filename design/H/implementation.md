# H: implementation plan

**Rule:** this is presentation only, plus one deliberate behaviour change (the lock scope, concept §4).

- Every control writes the same `store.set(path, v)` or `controller.*` it writes today.
- There are **no new store fields, no new PARAMS rows and no engine changes**.
- There is one new controller wrapper: `transposeTo(pc)`, over the existing `transposeBy`.
- There is one new view-level read: "Song's own", which applies a subset of the snapshot perform.js already takes for
  Revert.

**Effort: L overall.** It ships as two halves that don't depend on each other. Land Perform first.

| Half | Effort | Notes |
|---|---|---|
| **Perform + Quick sheet + lock rule** | M | Answers "settings I can change from Perform". Lower risk. |
| **Edit restructure** | L | `edit.js` is about 1,700 lines of card layout. |

---

## 1. New shared pieces (do first, S–M)

| Piece | What | Tests |
|---|---|---|
| `components/onTile.js` | Button: role, LED, ON/OFF badge. `set({ on, playing })`. It's used by the strips, the drone and Edit's ON STAGE column. | aria-pressed mirrors state |
| `components/modChip.js` | Button: label, value text, bottom amount bar, `lit` state, and a `kind: 'amount' \| 'steps' \| 'toggle'` option. | lit rules: > 0, ≠ 0, boolean |
| `components/stepPanel.js` | Mounted **inside** the owning strip (`position:absolute`). It takes `steps: [{ value, label }]` and an optional fine `fader` bound to the same path. A tap calls `onChange` and closes the panel. `role="group"` plus `data-perform-overlay`. | The panel's rect stays inside its strip's rect |
| `components/holdButton.js` | Fires after N ms. It cancels on pointerup, leave or blur, and on keyup for Enter/Space. Lift it from the Lock hold logic in perform.js:353–428. | A 300 ms press does nothing; a 1 s press fires once |
| `components/wordSlider.js` | Styled `<input type=range>` plus a word/value header and end words. `bipolar` fills from the centre. Double-click resets, as `fader` does. | word buckets; bipolar fill |
| `shared/smart-controls.js` (pure) | `smartSlidersFor(instrumentMeta)` → [{ role, path }]; `wordFor(role, v)`; `nearestPreset(list, values)` (wraps `matchPreset`); `describeSlot(slot, meta)` → sentence tokens. | node:test for each rule; each "smart" slider maps to exactly one PARAMS path |

`components/index.js` and `_fallback-components.js` must export and mirror these.

## 2. Perform (app/js/views/perform.js), M

| Change | How |
|---|---|
| Strip head → `onTile` | Tap = the existing mute toggle (`slots.i.muted`). Remove the bottom MUTE button. Add `.off` to the strip from `slotMuteState(slot)` (CSS only, per concept §2). |
| Name line | Group icon from `instrument-groups.js`, plus the name. The tag line = the existing wheel tag + a Chorus badge when `sends.chorus > 0`. |
| 2×2 chips | `modChip`s bound to `slots.i.sends.reverb`, `slots.i.sends.delay`, `slots.i.octave` (steps +2…−2) and `slots.i.sustain` (toggle). A click outside an open step panel closes it and is **swallowed**: a one-shot capture-phase `pointerdown` that calls `stopPropagation` and `preventDefault`. |
| Empty slot | When `instrument` is empty, the strip column shrinks to 60 px (44 at 1024) with "+ EXTRA · empty". The grid template is switched by a class on `.perform`; there are no inline widths. |
| Header FX chips | Two rows of `segmented`-like chips (neutral `--fx`), with the existing `applyPreset(list, id)`. **Song's own** is shown only when the snapshot's value didn't match a preset. Tapping it writes only the `fx.delay.*` / `fx.reverb.*` keys from the Revert snapshot (`SAVED_FIELDS` snapshot → `patch.fx.<unit>`). Nearest preset: `nearestPreset()` gives the dashed class. Space `⋯` opens Ambient Wash + Vibe chips. At < 1250 px, render the two pills instead (the same chips in a popover anchored under the pill). |
| KEY ▾ → Sing it in… | Reuse `keyGrid`. A tap calls `controller.transposeTo(pc)`: about 6 new lines that pick the nearest shift in −6…+5 and call the existing `transposeBy(delta)`. Header readout "G · you play D". |
| Drone head → `onTile` | Off ↔ last source. The view keeps `lastDroneMode` in memory (default `'synth'`) and writes the existing `drone.mode`. The Synth/My Pads segmented control stays. |
| Next | The existing next card becomes a `<button>` with a chevron (it already calls `nextSong`). |
| PANIC | Restyled (solid `--panic`, white text) and labelled "Esc". |
| Range bars | A `pianoKeyboard` overlay `rangeBars()`, display only, from `lowNote/highNote`. A muted slot's bar is grey. |
| Stale comment | perform.js:83 "tempo only changes in Edit" → tempo is editable from Quick; Revert already covers it. |

### Lock rule (perform.js + quick.js), S
- Replace the blanket `if (isLocked()) return` guards with a table: `LOCK = { live: [...], hold: [...], frozen: [...] }`.
- **Hold** controls: Transpose ±, KEY ▾, the drone key grid, Major/Minor and Revert. Wrap them in `holdButton(600)`
  only while locked, show a `HOLD` tag, and flash the hint on a short press. This reuses the unlock hint.
- **Live** controls: all chips and ON tiles, the header FX chips, Quick › This song, and the drone ON tile plus Level.
  Their `isLocked()` early-returns are removed.
- Update the Lock tooltip copy (perform.js:320) to match concept §4.

### Esc (app/js/main.js, about 5 lines)
- Perform overlays use `role="group"` plus `data-perform-overlay`, never `role="dialog"`, so `popupOpen()` stays false
  and the controller's Esc → panic runs.
- Exempt them from the "first Esc just blurs the focused control" rule:
  `if (f && !els.overlay.contains(f) && !f.closest('[data-perform-overlay]'))`.
- perform.js adds a `keydown` Escape listener that **only closes** overlays. It never calls `preventDefault`.

## 3. Quick sheet: new `app/js/views/quick.js`, M
- It is absolutely positioned over grid rows 1–2 of `.perform`. There's no focus trap, and the piano keys keep
  working.
- **This song:** tempo readout + TAP (lift Edit's tap helper into `components/tapTempo.js` and write `song.tempo`), and
  a Swell time `stepper` over `patch.swell.seconds` (steps 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 45, 60).
- **This Mac:** a Touch `segmented` for `settings.velocitySens`, the pedal LED from the same source as the wheel strip's
  PEDAL light, and a Reversed `toggle` for `settings.pedalInvert`. These are disabled under lock, except the LED.
- **If something's wrong:** status from the top-bar Sound LED source. `holdButton(1000)` → `controller.restartAudio()`
  while OK; a plain primary button when not OK.
- **Closes on:** ✕, Q (when no text field is focused), Esc (close, then panic as usual), or the controller's
  `songSelected`. Outside clicks pass through, since the sheet covers nothing live.

## 4. Edit (app/js/views/edit.js), L
The frame is the same as A-v2's plan: `rigMap` + `focusPanel(blockId)` → `soundPanel(i)`, `dronePanel()`,
`keyboardPanel()`, `fxPanel('reverb' | 'delay' | 'chorus' | 'lofi')` and `masterPanel()`, each built from today's
section builders and the `bindCtl / bindFn / refresh` helpers. H deltas:

| Delta | How |
|---|---|
| Sentence title | `describeSlot()` tokens rendered as buttons. A click scrolls to and focuses the bound control. It re-renders on `store.subscribe` for that slot only. |
| ON STAGE column | The **same** `onTile` / `modChip` / `stepPanel` / `fader` instances as Perform, plus an Edit-only wide Chorus chip (`sends.chorus`). |
| Sound column | Three `wordSlider`s from `smartSlidersFor(meta)`. The mapped params are hidden from Advanced › engine, with a note there saying where they went. |
| Where it plays | `miniKeyboard` with handles for `lowNote/highNote`. "Set lowest/highest…" arms a one-shot listener on the controller's note-on (the next note sets the bound; Esc or a click disarms). A Response `segmented` control for `velocityCurve`. |
| FX panels | Preset tiles (the existing blurbs), Fine-tune as `wordSlider`s, and "Who's sending in" as a per-slot `segmented` [Off 25 50 75 100] with a dashed-nearest class for custom values. |
| LIVE badge + hint | Static copy. It's the existing behaviour (`controller.selectSong` on click). |
| ⋯ Song menu | Duplicate, Rename, **Reset to factory…** (the existing handler behind the existing confirm). |
| Remove this sound… | The last item in the instrument menu. It confirms, then shows a toast with **Undo**, which writes back the captured slot object via `store.set('songs.<id>.patch.slots.<i>', prev)`. |
| Fade out + PANIC | Added to the keyboard row. `controller.fadeOutAll()` / `controller.panic()`; the label says ⌘ .; Esc behaviour in Edit is unchanged. |
| Delete | The old right FX column and the slot cards' "More" sliders. |

## 5. Tests
- **Esc** with each Perform overlay open (step panel, Sing it in…, ⋯ menu, Quick sheet): `controller.panic` is called
  **and** the overlay closes. Esc with Settings open still does **not** panic.
- **Swallowed click:** with a step panel open, a `pointerdown` on another strip's fader leaves its gain unchanged.
- **Step panel geometry:** the panel's rect stays within its strip at 1440×900 and 1024×700.
- **Quick geometry:** the sheet doesn't intersect `.strip`, the drone, the keyboard or the action buttons at both
  sizes. It closes on `songSelected`.
- **Lock table:** each "live" control changes the store while locked. Each "hold" control ignores a 300 ms press and
  applies after 600 ms. Each "frozen" control is disabled.
- **Song's own:** load a song with a custom delay → tap Off → tap Song's own → `fx.delay` deep-equals the loaded value
  and slot gains are untouched.
- **Sing it in:** from D/D, tapping G gives `hearIn = 7`, `playIn = 2` and +5. Tapping B from D gives −3.
- **Revert** covers the Quick tempo and swell edits.
- **smart-controls:** every instrument in `listInstruments()` gets 3 sliders, each bound to one valid PARAMS path.
- **Nothing lost:** every PARAMS address used by a factory song has a bound control reachable in ≤ 2 clicks in Edit.
- Update the ui-core and ui-edit Playwright selectors. Keep the `data-testid`s on controls that bind the same path
  (MUTE's test id moves to the ON tile).

## 6. Order
1. `smart-controls.js`, `onTile`, `modChip`, `stepPanel`, `holdButton`, the Esc exemption and its tests.
2. Perform strips (tile, chips, off state, empty-slot column), header FX chips + Song's own, KEY ▾, drone tile, PANIC
   style, range bars.
3. The lock table + Quick sheet. **Shippable after step 3.**
4. Edit: rig map + sound panel (ON STAGE, word sliders, range picker, sentence), keyboard row, ⋯ Song menu.
5. Edit: drone / keyboard / FX / master panels, then delete the old right column.
6. The 1024 pass, screenshots, and `## ui-hybrid` in CONTRACT_CHANGES.md (the lock-scope change goes there, with the
   table).

## 7. Risks
- **Concurrent agents are editing app/.** perform.js and edit.js are conflict hotspots. Land this after they merge, or
  land it panel by panel.
- **Fader throw** is about 250 px at 1440 and about 140 px at 1024. Measure it in the Playwright pass. The fallback is
  to show Octave/Sustain as badges (concept §7).
- **The lock-scope change** needs the owner's sign-off. It's isolated in the `LOCK` table, so it can be reverted.
- **Song's own** depends on the load snapshot existing. If Perform wasn't the view that loaded the song (e.g. it was
  selected in Edit), take the snapshot on the first Perform mount, as Revert does today.
