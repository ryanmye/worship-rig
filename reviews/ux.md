# Worship Rig — UX review (stage use)

Reviewer scope: SPEC §10/§13, the existing Phase 2 screenshots, and a live run of the real app (server.js on :8451, Chromium with
`--autoplay-policy=no-user-gesture-required`) at 1440×900, 1280×800 and 1024×700. States were forced through `window.__rig`:
a 12-song setlist, a 60-character song name, all four slots filled with the longest instrument names, six paragraphs of notes, a +1
transpose, held chords, stalled audio, loading, recording, a missing pad folder, no MIDI, Perform lock and Edit/Settings.
The new screenshots are in `reviews/ux-shots/` (`<size>-NN-<state>.png`). Scripts are in the session scratchpad and were not added to the repo.

Items marked **[verified]** were reproduced in the browser or confirmed in code. **[est.]** marks an estimate or assumption.

---

## Summary

The Perform view is in good shape. It has a clear top-down order, large transpose and nav buttons, a visible focus ring,
radio-group ARIA on the segmented controls and key grid, delete confirmations in Edit, and a lock that really blocks Edit and Settings
(⌘E is refused with a toast). Text contrast is high almost everywhere.

The problems are in four areas:
- **Emergency states.** The stalled-audio recovery button collides with the top bar.
- **Accidental input.** A tap on a fader track jumps the level, Esc panics even in Edit, and nothing guards against closing the tab.
- **Missing state.** The sustain pedal, whether the drone is sounding, the faded-out state and muted slots are not shown.
- **Two one-line bugs that break colour meaning.** Muted faders keep their colour, and all Edit slot cards are yellow.

---

## Blockers

### B1. Stalled audio: the "Restart audio" button is clipped and overlaps READY [verified]
- Evidence: `1440x900-14-stalled-loading-midi-connected.png` shows "Restart audi" with the READY LED drawn over it.
  `1024x700-14-…` shows "Restart ●udio" with "READY" drawn over it and the MIDI name cut to "Rola…".
- Cause: `#btn-restart-audio` is inserted inside `.tb-status`, which is `flex:1 1 auto; justify-content:center`, with no room
  reserved for it. `.tb-item` has `white-space:nowrap`, so the items overlap instead of wrapping. The button is also
  `min-height:34px` (`.warn-btn`).
- Why it blocks: this is the one moment a volunteer has to find and press a control under stress. The toast's "Restart audio"
  action is also small (32 px), at the bottom left, and disappears after 10 s.
- Fix: when `audio === 'stalled'`, show a full-width banner under the top bar instead of squeezing the button into it.
  ```html
  <div id="audio-banner" class="audio-banner" role="alert" hidden>
    <span>Sound has stopped.</span><button class="btn btn-restart">Restart sound</button></div>
  ```
  ```css
  .audio-banner{position:fixed;top:var(--topbar-h);left:0;right:0;z-index:60;display:flex;gap:16px;align-items:center;
    justify-content:center;padding:10px 16px;background:#4a1216;border-bottom:2px solid var(--danger);font:700 20px/1.2 var(--font)}
  .audio-banner .btn-restart{min-height:48px;font-size:18px;background:var(--danger);color:#fff;border-color:#ff8586}
  ```
  Keep the top bar showing only the red LED plus the word "Stalled", and give the error toast a longer life with no timeout.

### B2. A tap anywhere on a fader track jumps the level, and double-click resets it [verified in code]
- `fader.js` uses a native `<input type=range>` over the whole 56×330 px track. A pointerdown on the track moves the value to that
  point straight away. Only the 44×26 px thumb actually "grabs". The same is true of the mod-wheel strip (60×320), where a click
  jumps the pad swell.
- `dblclick` resets to the default (for example, the Pad fader going from −30 dB to about −2 dB in one gesture).
- In Perform, every change is written into the song (`store.set('songs.<id>.patch.slots.i.gain')`), so the jump persists.
- Fix (M):
  - In Perform, use relative drag. On pointerdown, capture the pointer and store `startY` and `startPos`, and do not change
    the value. On pointermove, set `pos = startPos + (startY − y)/trackHeight`. Call `preventDefault()` on the native pointerdown
    so the thumb does not jump.
  - Turn off dblclick reset in Perform, or require Alt+dblclick. Keep it in Edit.
  - Apply the same change to `wheelStrip`.

---

## Major

### M1. Esc = Panic everywhere, including Edit and inline confirms [verified]
- In Edit, click ✕ on a song, then press Esc to "cancel". Result: `{"panics":1, "confirming":true}`. Held notes are cut, and the
  confirmation stays open.
- `controller.onKeyDown` has no view check and no `onButton` check for Escape. Esc is the universal "cancel" key, so the one
  thing a user expects it to do (close the confirm) does not happen, and something surprising does. The drone survives
  (`allNotesOff` leaves it alone) but the pad and piano voices stop with a 30 ms fade.
- Fix (S):
  - Handle `Escape → panic` only when `settings.view === 'perform'`, nothing popup-like is open (`.ed-confirm`,
    `.ed-song.confirming`, `details[open]` in the factory browser, `settingsOpen`), and focus is not on a button.
  - In Edit, Esc cancels the open confirm. ⌘. stays as the global panic.

### M2. No guard against closing or reloading the tab in Chrome mode [verified in code]
- `beforeunload` is only armed while recording (`main.js`). ⌘W, ⌘Q, a stray trackpad swipe-back, or closing the wrong tab all cut
  the sound. The volunteer then gets a "Click anywhere to start audio" overlay in the middle of a song.
- Fix (S): arm `beforeunload` whenever `engine.ctx.state === 'running'` and the view is Perform, or when any note or the drone has
  sounded in the last 60 s. Electron can confirm in `close`.

### M3. A muted slot still shows its full colour [verified]
- `1440x900-19-swell-running.png`: with Keys muted, the fader fill is still bright orange. The only cues are the MUTE button and a
  struck-through 16 px value.
- Cause: `fader()` sets `el.style.setProperty('--fader-color', o.color)` inline. That overrides `.fader.muted{--fader-color:#59606b}`.
- Fix (S):
  ```css
  .fader.muted{--fader-color:#59606b !important}
  .slot:has(.mute-btn[aria-pressed=true]){opacity:.55}
  .slot:has(.mute-btn[aria-pressed=true]) .slot-role::after{content:' · MUTED';color:var(--danger)}
  ```
  An alternative is to put `.slot.muted` on the card from `renderSlots`.

### M4. Edit slot cards lose the four slot colours; all are accent yellow [verified]
- Pixel sample of the top border on Keys and Pad cards in `app-edit.png` gives `(255,201,77)` = `--accent` for both. The role labels
  are yellow too, and so are the mini-keyboard range highlights.
- Cause: `edit.js` `h()` does `Object.assign(e.style, {'--role': …})`. Custom properties cannot be set through property
  assignment, so the call silently does nothing.
- Fix (S), in `edit.js h()`:
  ```js
  else if (k === 'style' && typeof v === 'object')
    for (const [p, val] of Object.entries(v)) p.startsWith('--') ? e.style.setProperty(p, val) : (e.style[p] = val);
  ```
  Apply the same guard to `components/util.js h()` to be safe.
- Also, in Edit the Pan slider and every FX slider use accent yellow, which sits next to Keys orange (#ff8a3d vs #ffc94d).
  Make non-slot sliders neutral with `--fader-color:#c9d1db`, so colour only ever means a slot.

### M5. Sustain pedal state is not shown anywhere [verified]
- Grep of `views/` and `index.html` finds no pedal or sustain indicator in Perform. The controller knows `pedalDown`.
- A stuck or inverted pedal is the most common live keys failure, and the spec itself adds "pedal invert" and a "press your pedal"
  step.
- Fix (S): add a pedal LED under Swell in the wheel strip, reusing `.drone-swell` styling, driven by a controller `pedal` event.
  ```html
  <div class="pedal-lamp"><span class="led"></span><span>Pedal</span></div>
  ```
  ```css
  .pedal-lamp.down .led{background:var(--ok);box-shadow:0 0 8px var(--ok)}
  ```
  Also show "Pedal held" in the top bar when the pedal has been down for more than 20 s, to catch a stuck or inverted pedal.

### M6. Drone and fade state are not glanceable [verified]
- The key grid always highlights the song key, even when the drone is Off (`1440x900-07-locked.png`). Only the small "Off" segment
  (47×40) says the drone is silent.
- The section title "KEY · DRONE" merges two concepts.
- There is no "drone sounding" lamp.
- After **Fade out**, master and drone sit at 0 until the next note-on (`engine.fadeOutAll`), and the UI shows nothing apart from
  a 0.35 s flash on the button. A player who faded out during a prayer will not know why the drone is gone.
- Fix (M):
  - Add a one-line drone readout in the drone head, 20 px or more: "Drone: Eb major · Synth · −9 dB", or "Drone off" in muted
    text. Drive it from the engine, not the store.
  - When `mode==='off'`, dim `.key-grid .key-btn.on` to an outline (`background:transparent;border:2px solid var(--accent);color:var(--accent)`).
  - After Fade out, relabel the button "Faded — play to bring back" with an amber border until the next note-on.

### M7. Changes made in Perform silently rewrite the song, and the key grid is a re-key button [verified in code]
- The following all call `store.set` on the song: the faders, mute, transpose ±, the drone key grid (`setSongKey` writes `hearIn`
  **and** `playIn`), Major/Minor, drone mode and level. Perform lock blocks none of them.
- One mis-tap on the grid, which sits 12 px above the drone Level slider and next to Major/Minor, permanently re-keys the song for
  every future service. There is no "revert" anywhere.
- Fix (M):
  - (a) Perform lock should also freeze the key grid, Major/Minor and drone mode. Faders and mute can stay live.
  - (b) Add "Revert to saved" per song in Edit, which means keeping a `savedPatch` snapshot that is taken whenever Edit is left.
    The fuller version is "Perform changes are for this service" with an explicit "Save to song".
  - (c) Move the Level slider into its own row below the toggles so it is not adjacent to the grid.

### M8. What comes next is not visible [verified]
- "Next ▶" is a bare label. With 12 songs, 1024×700 shows about 4 chips and 1440 shows about 5.5. The current chip only scrolls
  into view on change, so "what's next" requires scanning the strip.
- Fix (S): make the Next button two lines.
  ```html
  <button class="nav-btn next"><small>Next</small><b>Build My Life · F</b></button>
  ```
  ```css
  .nav-btn.next{min-width:200px;max-width:280px}
  .nav-btn b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  ```
  Also keep the current chip scrolled to the left third of the strip so the next two chips are always visible.

### M9. Edit at 1024×700 (and 1280×800) is barely usable [verified]
- `1024x700-09-edit-stress.png`:
  - The centre column shows only the song header.
  - Easy Transpose is clipped, and no slot card is visible without scrolling.
  - The FX row takes the bottom half.
  - The left list shows 3 songs, because the Setlist and Library-file cards are fixed.
- At 1280, "+ Library…" overflows its card (`1280x800-09`).
- A non-technical volunteer faces about 70 controls per song: 4 slots × about 14 controls, plus 5 FX units and wheels/pedals.
- Fix (L). Progressive disclosure:
  - **Slot card default**: instrument picker + Level only. Put Pan, Reverb/Delay/Chorus, Key range, Octave/Transpose,
    Voices/Velocity, Sustain/Pitch bend behind `<details class="ed-params"><summary>More for Keys</summary>`, closed by default.
  - **FX column default**: one "Room" slider (reverb level) and one "Echo" slider (delay level). Expanders hold the rest, and
    Chorus and Lofi are closed.
  - **Wheels & pedals and Tempo**: closed by default.
  - **Library file card**: fold into a "⋯ Library" menu button on the Setlist card.
  - **Under 1180 px**: make FX a tab (`Sound | Effects`) in the centre column instead of a 240 px band.

### M10. Legibility at 1.5 m [est.]
Assumption: a 13–14″ MacBook at its default scaling is about 0.20–0.22 mm per CSS px. For a glance at 1.5 m in low light, a cap
height of about 6 mm (about 14 arcmin, roughly 3× the acuity threshold) means about **36–40 px bold** type. About **22–24 px** is
readable if the player leans in and looks.

| Element | Size now | Glance at 1.5 m? | Suggest |
|---|---|---|---|
| Song name | 44 px (40 at ≤820 h) | yes | keep |
| Key (Hear-In) | 36 px (32) | yes | keep |
| Play-In pill | 17 px | no | 22 px; this is the key the player reads charts in |
| Chord | 44 px | yes (competes, see H1) | 32 px |
| Transpose value | 26 px | with attention | 30 px |
| Slot instrument | 16 px | no | 19–20 px, 2-line clamp |
| Slot dB value | 16 px | no | 20 px (the fader position carries the meaning anyway) |
| Slot role (KEYS…) | 12 px caps | colour only | 14 px |
| "wheel 61%" badge | 11 px | no | 13 px, or drop it since the indicator line already shows it |
| Wheel % | 20 px | with attention | 24 px |
| Setlist chip name | 15 px | no | 17 px; current chip 18 px |
| "LOADING…" | 13 px, faint | no | see S4 |
| Status bar (MIDI/Audio) | 12–14 px | LED colour only | fine for a glance, but see S3 |
| Notes | 17 px | read at the keyboard, not the stand | keep; make the size adjustable 17/20/24 |

### M11. Hit targets under 44 px that are used live [verified by measurement at 1440×900 unless noted]
| Control | Size | Fix |
|---|---|---|
| Perform/Edit switch | 88×38 | `min-height:44px` |
| Settings | 44×40 | 44×44 |
| REC | 84×40 | 44 high; it is also next to Master, see S7 |
| Master fader (top bar) | 92×34 input, 22×30 thumb | see S7 |
| Restart audio (top bar) | 34 high, clipped | see B1 |
| Drone mode Off/Synth/My Pads | 47×40 | 44 high, and at least 64 wide for "Off" |
| Major/Minor | 70×40 | 44 |
| Drone Level | 106×34, thumb 22×30 | 44 high; the thumb should be 28×36 |
| Drone toggles | 214×40 | 44 |
| Pad folder button | 97×37, wraps to 2 lines ("Pad / folder…") | 44, `white-space:nowrap` |
| Key grid at ≤820 px height | 58×40 | keep 44; take the height from the piano instead (see H3) |
| Notes toggle / Close (<1340 px) | 86×36 | 44 |
| Toast action "Restart audio" | 32 high | 44 |
| Vertical fader thumbs | 44×26 | 44×32; with relative drag (B2), the whole track becomes the target |

---

## Hierarchy (Perform)

- **H1 [verified].** The eye goes song name → **chord** → PANIC → Key. The chord readout is the same size and weight as the song
  name (44/800), and it changes with every chord you play. Movement pulls the eye away from the song name and key.
  - Shrink the chord to 32 px `color:var(--muted)` and brighten it to `--text` only while notes are held.
  - Or make it hideable, as a toggle under Settings > Display.
- **H2.** Accent yellow means "selected" in about 9 places at once: the Perform tab, the current chip, the Key, the drone key, Synth,
  Major, the Level fill, the toggle LEDs and the Play-In pill. Nothing stands out any more. Reserve solid yellow fills for
  (1) the current chip and (2) the active key. Other "on" segments should use a yellow outline on `--panel-3`:
  ```css
  .segmented .seg.on{background:var(--panel-3);color:var(--accent);box-shadow:inset 0 -3px 0 var(--accent)}
  ```
- **H3. Glare.** The on-screen piano (1030×78 px of `#e9ecef`) is the brightest thing on screen in a dark room, and it is the least
  used control. The PANIC block (`#ff4d4f`, 118×96) is second.
  - Dim the white keys to `#9aa3ad` and the black keys to `#15181d`, or collapse the piano by default in Perform. That frees about
    90 px for bigger faders.
  - Make PANIC `background:#5a0d10; border:2px solid var(--danger); color:#ffc9ca`, turning full red on `:hover`/`:active`.
  - Consider a "Stage dim" toggle that lowers `--text` to `#c9ced6` and `--thumb` to `#b9c0c9`.
- **H4.** The Notes column at 1440 is the largest bright text mass (#dfe4ea, 17 px). That is fine, but below 1340 px Notes and the
  drone are mutually exclusive (`1024x700-04-stress-notes-open.png`). Opening notes hides the drone key and mode, and the notes are
  cut mid-line with no sign that they scroll.
  - Add `mask-image:linear-gradient(#000 85%,transparent)` on `.notes-text` when it overflows.
  - Give it its own "Notes" overlay that covers the slots, not the drone.

---

## State visibility

| State | Shown? | Issue / fix |
|---|---|---|
| MIDI connected | LED + device name (flash on activity) | good. "Blocked", "Error" and "Waiting…" are OK; add a click-through to Settings > MIDI |
| Audio running / stalled | LED + word + ms | "Audio" is both the label and the running state, so it reads as nothing. Show "Sound OK · 12 ms", and see B1 for stalled |
| Latency ≥ 40 ms | amber number, tooltip only | on stage an amber number with no explanation causes worry. Click → Settings > Audio |
| Recording | red REC + red timer + blinking dot | good. The blink hides the dot 50% of the time; use a pulse instead. Add a 3 px red top border on `body.recording` so recording shows from any view |
| Loading | 13 px "LOADING…" top-right with a 0.15 s fade, plus a chip spinner | too small (S4) |
| Ready | LED only; the word "READY" is always printed | when not ready the LED is `#3a404b` on `#101318` = **1.79:1**, so it looks off/absent rather than "not yet". Show "Loading 3/12" → "Ready" as text |
| Wheel value | 20 px % + target | good; the pickup ghost is a nice touch |
| Sustain pedal | **missing** | M5 |
| Key vs Play-In | "KEY Eb" 36 px + "Play in D" pill 17 px | clear, but the player's chart key is the small one. Make the pill 22 px |
| Drone on/off + key | only the 47 px "Off" segment | M6 |
| Muted slot | button + struck value; the fader stays coloured | M3 |
| Faded out | not shown | M6 |
| Perform lock | "Locked" label + LED; bg `#3a2d00` vs panel = **1.32:1** | add a lock glyph to the top bar and a 2 px amber outline on `.perform` while locked |

## Error / empty states and copy
- **Empty slot [verified].** It shows "—" in 40 px light weight with a lone grey line at mid-height. It looks like a broken fader.
  Replace it with `Empty` in 14 px `--faint`, centred, and no line.
- **Instrument names expose library names.** "Grand Piano (Salamander)", "Wurlitzer (MusyngKite)", "Rhodes (MusyngKite)",
  "Drone Oscillator". Strip the parentheses in Perform (keep them in Edit's picker tooltip). Rename "Drone Oscillator" to
  "Sub Drone" or similar.
- **Wake-lock toast.** "screen wake lock unavailable: Wake Lock permission request denied" is lowercase, raw API text, and shows
  on launch. [est.] It may only fire in headless mode, but guard it anyway. Suggested copy: "Your screen might dim during long
  songs. Keep the laptop plugged in." Show it once and only as info.
- **Raw `err.message` pass-through.** Several messages include raw error text:
  - "Recording didn't start: ${r.error}"
  - "Recording unavailable: ${reason}"
  - "Could not read ${f.name}: ${err.message}"
  - "Device names unavailable: ${err.message}"
  - "Pad folder: ${r.error}"
  - "Could not open the folder: ${err.message}"

  Map these to plain sentences and log the detail with `console.warn`.
- **Truncated pad status [verified].** "Pad folder not loaded — the synth drone pl…" is cut off at 1440. Shorten it to "Pad folder
  not connected — using the synth drone", and let it wrap to 2 lines (`white-space:normal`).
- **Edit jargon:**
  - Key range "C-1 / G9" → "Lowest / Highest", with a default of "Whole keyboard".
  - "0 st" → "0 semitones".
  - "VOLUME KNOB (CC7) CONTROLS" → "Volume knob controls".
  - "Voices: Poly / Mono (lowest)" → "Play: Chords / Single note (lowest)".
  - Truncated labels "VOI…", "VEL…" and "TRANSP…" at ≤1340 px wide.
  - "Tempo — BPM Tap ×": the × has no label; make it "Clear".
- **Settings.** "Diagnostics: Decoded samples 518 MB · Voices · Audio nodes" is fine as diagnostics, but it should be collapsed.
  "MIDI unavailable" in amber has no next step; add "Allow MIDI in the address bar, then reload".

## Consistency (Perform / Edit / Settings)
- Drone mode names: **"My Pads"** (Perform), **"Pad files"** (Edit), **'PAD FOLDER (DRONE "PAD FILES" MODE)'** (Settings). Pick
  "My Pads" everywhere.
- "Chord follow [EXPERIMENTAL]" vs "Follow chords (experimental)"; "Continues across songs" vs "Continue across songs".
- Slot colours break in Edit (M4). FX and Pan use accent yellow, which is close to Keys orange.
- Buttons: Perform `.btn` is 40 px / 15 px and Edit `.ed-btn` is 36 px / 14 px. Settings uses `.ed-btn`, so the Learn/Clear
  buttons are 30 px. That is acceptable off stage, but put both on one `--control-h` token.
- Toasts sit bottom-left over the on-screen piano in every view. At 1280×800 they reach up into the wheel and Keys panels
  (`1280x800-03`) and hide held-note highlights. Move them to the top-right below the top bar, `width:min(440px,40vw)`.

## Keyboard / accessibility
- **Good [verified]:** the focus ring is visible (3 px `#7cc4ff`, 10.4:1 on bg). The segmented controls and key grid use
  radiogroup with roving tabindex. Mute and toggles use `aria-pressed`. Faders have `aria-valuetext` with dB. Settings is a
  `role=dialog` with `aria-modal`, and Esc closes it.
- **Tab order [verified].** Top bar → transpose → **12 setlist chips** (12 stops) → Next → wheel → 4 × (fader, mute) → drone →
  notes (scroll region) → Fade/Panic/Lock. Give the strip one tab stop with arrow navigation inside
  (`role=listbox`/`option`, `aria-activedescendant`). Put Prev/Next before the strip.
- **No live announcements.** Song changes and the stalled state are not announced to screen readers. Add
  `aria-live="polite"` on `.song-name` and use role=alert for the banner in B1.
- **Meter updates `aria-valuenow` on every animation frame.** Throttle to 4 Hz, or mark the meter `aria-hidden` (it duplicates
  nothing actionable).
- **Colour-only states:** the Ready LED, the toggle LEDs (10 px dots) and slot identity. Pair them with text or shape (see the
  table above).
- **Motion.** There is no `@media (prefers-reduced-motion)`. Wrap the REC blink, `.st-pedal-prompt` pulse and spinner in it.

## Contrast (WCAG ratio from the CSS tokens)
| Pair | Ratio | Verdict |
|---|---|---|
| `--text` #f1f4f8 on `--panel` #15181d | 16.1 | ok |
| `--muted` #a3acb8 on panel / topbar | 7.8 / 8.1 | ok |
| `--faint` #6e7784 on panel / panel-2 (chip numbers, stale chord, empty text, `.ed-h3`) | 3.9 / 3.6 | below 4.5 for 12–13 px text. Raise to `#8a93a0` (about 5.4 on panel) |
| accent on panel (Key) | 11.6 | ok |
| accent-ink on accent (current chip) | 12.0 | ok |
| slot colours on panel: orange / green / blue / purple | 7.6 / 10.0 / 7.1 / 6.6 | ok |
| white on PANIC `#ff4d4f` | 3.27 | AA-large only; fine at 20 px bold, and H3 changes it anyway |
| piano key label #555c66 on #e9ecef | 5.7 | ok |
| LED off #3a404b on topbar | 1.79 (non-text, needs 3.0) | fail: raise to `#5a616c` or draw a ring |
| REC dot idle #7a2a2c on panel-2 | 1.71 | fail: `#b0383b` |
| fader track #2a2f38 on panel | 1.32 | fail: the unfilled part of a fader is invisible in low light. Use `#3a414d` plus a 1 px `#4a5260` border |
| muted fader #59606b on panel | 2.80 | borderline, and currently not applied anyway (M3) |
| Lock-on bg #3a2d00 vs panel | 1.32 | the locked state is only readable from the text and LED |
| disabled controls (opacity .45) | about 4.1 | ok for disabled |

---

## Minor
- **S1.** Unlock is a single click on a 118×96 button right next to PANIC. Make unlock press-and-hold for 1 s, with a fill
  animation on the button.
- **S2.** Setlist chips are drag-reorderable in Perform when unlocked, so a sloppy click-drag reorders the service. Allow
  reordering in Perform only with Alt held, or only in Edit.
- **S3.** The top-bar status items do nothing when clicked. MIDI and Audio should open the matching Settings section.
- **S4.** Loading: move "Loading…" next to the song name at 17 px accent with a spinner. Dim the song name to `--muted` until the
  commit happens, so the player knows the new sound is not live yet.
- **S5.** A stray orange 2 px mark renders after the chord letter ("D ˈ") in several captures (`1024x700-03`). Origin not
  investigated. [unverified cause]
- **S6.** `.song-name` has `title=` only. On long names the ellipsis hides the distinguishing part (for example "(Hymn Arran…" vs
  another arrangement). Consider middle truncation, or shrink to 36 px when it overflows
  (`font-size:clamp(32px, 4.4vw, 44px)`).
- **S7.** The Master fader sits in the top bar as a 92 px slider beside REC, with double-click reset to the default. It is a
  whole-house volume control used live. Either make it 44 high and at least 160 px wide with relative drag (B2), or move it to the
  bottom action row as a vertical fader beside Fade out.
- **S8.** Edit song-row actions (✎ ⧉ ✕) are 30×30 and only appear on hover, so they cannot be found on touch or by a first-time
  user. Show them on `.current` always.
- **S9.** The Delete confirm offers "Remove from set" and "Delete song" under the prompt "Delete?". Change the prompt to
  "Remove “X” from this set, or delete it from your library everywhere?"
- **S10.** ⌘R in Chrome opens the system save dialog, which is modal, over Perform. That is fine, but add "(choose where to save)"
  to the first-run hint so it is not a surprise mid-song.

---

## Top 10 changes for the follow-up UI agent
| # | Change | Files | Effort |
|---|---|---|---|
| 1 | Stalled-audio banner below the top bar with a 48 px "Restart sound" button; stop squeezing the button into `.tb-status`; error toast has no timeout (B1) | index.html, styles.css, main.js | S |
| 2 | Relative-drag faders and wheel in Perform (no jump-to-click); no dblclick reset in Perform; thumb 44×32 (B2) | components/fader.js, readouts.js, styles.css | M |
| 3 | Stage-safety keys: Esc→panic only in Perform with no confirm open and nothing focused; `beforeunload` armed while audio runs; hold-to-unlock Lock (M1, M2, S1) | controller.js (key handler), main.js, perform.js | S |
| 4 | Two colour bugs: `.fader.muted` `!important` plus a dimmed muted slot card; `edit.js h()` `setProperty` for `--role`; neutral colour for non-slot sliders (M3, M4) | styles.css, edit.js, styles-edit.css | S |
| 5 | New status lamps: Pedal LED in the wheel strip; drone readout line ("Drone: Eb major · Synth" / "Drone off") with the key grid outlined when off; "Faded — play to bring back" state on Fade out; Ready shows "Loading n/12" (M5, M6) | perform.js, readouts.js, controller.js (emit `pedal`), main.js, styles.css | M |
| 6 | Next button shows the next song name and key; current chip kept in the left third of the strip (M8) | perform.js, setlist.js, styles.css | S |
| 7 | Perform edits: lock also freezes the key grid, Major/Minor and drone mode; move drone Level off the grid row; add "Revert to saved" per song (M7) | perform.js, main.js, edit.js, store.js (snapshot) | M |
| 8 | Stage sizing and glare pass: font sizes from the M10 table; 44 px minimum on the M11 controls; dim the piano keys and PANIC idle state; `--faint` → `#8a93a0`; LED-off, REC-dot and fader-track contrast fixes; chord readout 32 px muted (M10, M11, H1–H3) | styles.css | S–M |
| 9 | Edit progressive disclosure: slot card = picker + Level, the rest in "More"; FX = Room/Echo with expanders; Library card as a menu; FX as a tab under 1180 px (M9) | edit.js, styles-edit.css | L |
| 10 | Copy and label pass: one drone-mode name ("My Pads"); drop "(Salamander)/(MusyngKite)" in Perform; "Empty" slot state; plain-English replacements for C-1/G9, st, CC7, Poly/Mono, raw `err.message`, the wake-lock toast; move toasts to the top-right (copy section, S9) | perform.js, main.js, edit.js, settings.js, controller.js (warn text), styles.css | S–M |
