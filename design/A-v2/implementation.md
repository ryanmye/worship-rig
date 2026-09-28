# Angle A v2: implementation plan

**Rule:** this is presentation only. Every control writes the same `store.set(path, v)` or `controller.*` call it
does today. There are **no new store fields, no new PARAMS rows and no engine changes**. The only controller
addition is a thin wrapper, `transposeTo(pc)`, over the existing `transposeBy`.

**Effort: L overall.** It ships in two independent halves:
- **Perform + Quick sheet: M.** Lower risk, and it answers "settings I can change from Perform".
- **Edit restructure: L.** edit.js is about 1,700 lines of card layout.

Land Perform first.

---

## 1. Perform (app/js/views/perform.js, ~830 lines) — M

| Change | How | Notes |
|---|---|---|
| Strip: icon, badge line, 2 chips, muted look | New `modChip` component (button, label, value, amount bar) for `slots.i.sends.reverb` / `.delay`. The badge line is plain text from `slots.i.octave` and `sends.chorus`, shown only when non-zero. The line keeps a fixed height. | Muted: add `.muted` to the strip from the existing `slotMuteState(slot)`, so it is CSS only. MUTE's label becomes "MUTED". |
| In-strip step panel | New `stepPanel` component, **mounted inside the strip element** (`position:absolute` within the strip), so it can't overlap a neighbour. Steps are `[1, .75, .5, .25, 0]` × the param's max. A tap calls `store.set` and closes the panel. The fine slider is a vertical `fader` bound to the same path. | Opening is refused under `performLock` (the chips stay display-only). A click outside closes the panel and is swallowed: a capture-phase `pointerdown` on `document` that calls `stopPropagation`/`preventDefault` once. |
| KEY ▾ → Sing it in… | The key readout becomes a button. The popover reuses `keyGrid`. A tap calls `controller.transposeTo(pc)`: new, about 6 lines, it computes `delta` to the nearest shift in −6…+5 and calls the existing `transposeBy(delta)`, so `hearIn` and `transposeOctave` are written exactly as the ± buttons write them. | Refused under lock (the transpose buttons already check `isLocked()`). |
| Space/Echo selects → pills | The existing `applyPreset(list, id)` is unchanged. The pill label comes from `nearestPreset()` when the value is custom. Vibe chips live in the Space pill menu. | Presentation-only nearest-match. It stores nothing. |
| Drone Brightness/Movement | Horizontal `fader` bound to `drone.brightness` / `drone.movement` (already PARAMS rows, today only in Edit). | These are song fields, so they are frozen under lock like the other drone options. |
| Range bars over the keyboard | `pianoKeyboard` overlay `rangeBars({from,to})`, **display only**, read from `slots.i.lowNote/highNote`. A muted slot's bar is grey. | |
| PANIC face shows "Esc" | Copy only. | |
| Quick button + sheet | See §2. | |
| Stale comment | perform.js:84 says "tempo only changes in Edit". Tempo is changeable from Quick now. `SAVED_FIELDS` **already** has `tempo` and `patch` (and swell is in `patch`), so Revert covers both. Update the comment and add a test (below). | |

### Esc: the one change outside views (app/js/main.js, ~5 lines)
- Perform overlays (step panel, Sing it in…, pill menus, Quick sheet) use `role="group"` plus `aria-label`, **never
  `role="dialog"`**. This keeps `popupOpen()` false, so Esc reaches the controller's panic.
- In the Esc handler, exempt them from the first-Esc-blurs rule:
  `if (f && !els.overlay.contains(f) && !f.closest('[data-perform-overlay]'))`.
- perform.js adds its own `keydown` listener for Escape that **only closes** overlays. It never calls
  `preventDefault`, so the controller's panic still runs.

## 2. Quick sheet: new `app/js/views/quick.js` — M
- The sheet is mounted by perform.js as an absolutely positioned element over the header and setlist grid rows
  (`grid-row: 1 / 3`). It has no focus trap and piano keys keep working.
- **This song:**
  - Tempo readout and TAP. Reuse Edit's tap-tempo helper: lift it from edit.js into `components/tapTempo.js` if it
    isn't a component yet. It writes `song.tempo`.
  - Swell time: a `stepper` over `song.patch.swell.seconds`, with steps `[1,2,3,4,6,8,12,16,24,32,45,60]`.
- **Every song:**
  - Touch: a `segmented` control for `settings.velocitySens`.
  - Pedal: a light driven by the controller's existing pedal state (the same source as the wheel strip's PEDAL LED),
    plus Reversed as a `toggle` for `settings.pedalInvert`.
- **If something's wrong:**
  - Status from the same source as the top-bar "Sound" LED.
  - When status is OK: a `holdButton` (new, S) that fires `controller.restartAudio()` after holding for 1000 ms and
    cancels on pointerup or leave. Lock's hold-to-unlock logic is the model, so lift it if it's reusable.
  - When status is not OK: a plain primary button.
- **Closes on:**
  - ✕ or the Q key (Q only when no text field is focused).
  - Esc: close, then panic via the controller as usual.
  - Any committed song change, from the controller's `songSelected` event, which perform.js already listens to.
  - Outside clicks pass through.
- **Read-only under `settings.performLock`:** controls are disabled, and the pedal light stays live.

## 3. Edit (app/js/views/edit.js, ~1,700 lines) — L
Unchanged from v1's plan: `rigMap` + `focusPanel(blockId)` → `soundPanel(i)`, `dronePanel()`, `keyboardPanel()`,
`fxPanel('reverb'|'delay'|'chorus'|'lofi')`, `masterPanel()`. Each builder is mostly moved code from today's section
builders, with the same `bindCtl / bindFn / refresh` helpers. v2 deltas:

| Delta | How |
|---|---|
| Reset to factory → **⋯ Song** menu | The same handler as today's header button, moved behind a menu item and gated by the existing confirm pattern (ux-shots `16-edit-delete-confirm`). |
| Clear slot → **Change instrument ▾ → Remove this sound…** | The last item in the grouped instrument list, after a divider. It confirms, then shows a toast with **Undo**. Undo writes back the slot object captured before clearing: one `store.set('songs.<id>.patch.slots.<i>', prev)`, which is an existing path. |
| **Fade out + PANIC** in Edit's keyboard row | The same `controller.fadeOutAll()` / `controller.panic()` as Perform. PANIC shows "⌘ .". Esc in Edit keeps cancelling, as today. |
| Keyboard range picker in the panel | Reuse `miniKeyboard` with two drag handles bound to `slots.i.lowNote/highNote`. "Set lowest… / Set highest…" arms a one-shot listener on the controller's existing note-on (`held` event); the next note becomes the bound, and Esc or a click disarms it. The bars above the bottom keyboard are **display only**. |
| Smart knobs | New `components/dial.js` (a hidden `<input type=range>` plus an SVG arc; vertical-relative drag via `util.relativeDrag`; wheel and arrow nudge; double-click reset). New `shared/smart-controls.js` (pure): `smartKnobsFor(meta)`, `wordFor(role, n)`, `nearestPreset()`. Both have node:test coverage. |

## 4. Components summary
| Component | Status |
|---|---|
| `fader`, `segmented`, `toggle`, `select`, `stepper`, `keyGrid`, `miniKeyboard`, `pianoKeyboard`, `meter`, `wheelStrip`, `setlistStrip`, `chordReadout` | reused |
| `modChip`, `stepPanel`, `holdButton`, `dial`, `rangeBars` (overlay), `presetTiles`, `rigMap` | new (S, S, S, S–M, S, S, M) |
| `components/index.js` + `_fallback-components.js` | export and mirror the new ones |

## 5. Tests to add or change
- **Esc panics with every Perform overlay open**: step panel, Sing it in…, pill menu, Quick sheet. Each case asserts
  that `controller.panic` was called and the overlay is gone. Also assert that Esc with Settings open still does
  **not** panic.
- **Outside click is swallowed** while a step panel is open: `pointerdown` on another strip's fader thumb leaves its
  gain unchanged and the panel closed.
- **Quick sheet geometry:** at 1440×900 and 1024×700, the sheet's bounding rect doesn't intersect any `.strip`, the drone
  block, the keyboard card, or Revert/Fade/PANIC/Lock. It closes on `songSelected`.
- **Lock:** the chips don't open, Sing it in… doesn't open, Quick controls are disabled and the pedal light still updates.
- **Revert covers Quick edits:** change the tempo and swell from Quick → Revert → both restored.
- **Sing it in:** from D/D, tapping G gives `hearIn = 7`, `playIn = 2` and a transpose readout of `+5`. Tapping B from D gives
  −3, not +9.
- **Nothing-lost test** (from v1): every PARAMS address used by a factory song has a bound control reachable in ≤ 2
  clicks in Edit.
- Update the ui-core and ui-edit Playwright selectors. Keep `data-testid`s on controls that bind the same path.

## 6. Order
1. `smart-controls.js`, tokens (`--fx`, `--drone`), `modChip`, `stepPanel`, and the main.js Esc exemption with its tests
   (S–M).
2. Perform: chips + muted look + badges, KEY ▾ Sing it in…, pills, drone sliders, range bars (M).
3. Quick sheet + `holdButton` (M). **This is shippable on its own after steps 1–3.**
4. Edit: rigMap + Sound panel (with the range picker and instrument menu), Fade/PANIC row, ⋯ Song menu (L).
5. Edit: the Drone / Keyboard / FX / Master panels; delete the old right column (M).
6. The 1024 pass, screenshots, CONTRACT_CHANGES `## ui-instrument-first`.

## 7. Risks
- **Concurrent agents are editing app/.** edit.js and perform.js are conflict hotspots. Land this after they merge, or
  land it panel by panel.
- **Knobs on a trackpad (Edit only now).** Mitigated by a hidden range input, the scroll wheel, a 78 px hit area and
  word values. Test on a real MacBook.
- **The in-strip panel hides its own strip's fader** while open (about 1 s in normal use). See concept §6.
- **Two key grids with different meanings** (Sing it in… vs Key & drone). This needs a real-player test (concept §6).
- **Hold-to-restart** must not also fire on a short click; add a test that a 300 ms press does nothing.
- **The Quick sheet covers Prev/Next while open.** Song changes still work by MIDI and keyboard shortcuts, and they
  close the sheet.
