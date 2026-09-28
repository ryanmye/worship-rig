# Angle D: "Progressive-disclosure mixer"

**In one line:** Edit becomes a **mixing desk plus an inspector**. The desk shows every sound at once as a vertical
strip: the same strips as Perform, in the same order and colours, with the same faders. Each strip's row of sends
runs into three **shared-effect strips** and then into the **Master** strip. Click any strip's name and the
**inspector** on the right opens that one thing, with four tabs. Perform stays as it is, with two additions: a
three-cell **quick row** under each fader that opens a small panel inside that strip, and an **Output & playing**
popover on the top-bar Master.

Lineage: the Logic channel strip and inspector, the Ableton mixer and its return tracks, and the per-section
modifiers of the Sunday Keys MainStage template (research.md P1, P3, P5).

Mockups (1440×900 unless noted, HTML next to each PNG):
- `perform.png`, `perform-1024.png` (1024×700)
- `quick.png`, `quick-1024.png`: the quick panel for the Keys strip, open
- `quick-output.png`: the Output & playing popover, open
- `edit.png`: Keys selected, Sound tab
- `edit-space.png`: the Space effect selected, Presets tab
- `edit-1024.png`

---

## 1. How D answers "noisy", "all buttons and dials" and "disconnected"

| What you said | What causes it today | What D does |
|---|---|---|
| **"Too noisy"** | About 17 cards that all look alike (D6). Opening a section adds a stack of identical sliders (D2). The FX column holds 7 more cards. | **Rows, not cards.** Each row of the desk is *one* thing across every sound: Range, Space, Echo, Chorus, Level. It is labelled **once**, in the left gutter, so no strip repeats "Reverb 45%". You read it like a table: across a row to compare sounds, down a column to see one sound. **Only one thing is ever open in depth**: the inspector. The 7-card FX column becomes 3 effect strips and a Master strip, the same shape as the sounds. A send at 0 shows an empty track with a grey "0". The empty Extra slot shrinks to a 36 px dashed "+ add a sound" lane. Pan moves off the strip into the inspector, because nobody pans mid-song. |
| **"Everything is just buttons/dials"** | Level, pan, sends, EQ and reverb size are all the same horizontal slider (D2). | **The desk has no knobs.** Each shape does one job and means the same thing everywhere: a **vertical fader** is always loudness, a **thin bar** is always "how much goes into a shared effect", a **coloured range bar** is always "where on the keyboard", and the **MUTE** button is unchanged. Knobs appear only in the inspector, and only for an instrument's own character (Tone, Release, Brightness). Preset *names* come before numbers: "Stage", "Dotted ⅛", "Full Set". |
| **"Disconnected from what I'm changing"** | Edit uses a different layout from Perform (D1). "Reverb" means two unconnected things (D3). Nothing in Edit shows what is sounding (D5). | 1. **Edit is Perform's strips, pulled taller.** The order (Keys, Pad, Extra, Bass, then drone), the colours and the fader are all the same. 2. **The sends are drawn as buses.** The Space row runs right, through every sound, and ends *in* the Space strip, where a junction pill shows a coloured dot for each sound feeding it, sized by how much. "Keys → Space 25" and the room itself are visibly one pipe. Select Space and its whole row lights up (`edit-space.png`). 3. **Selection is shown in three places.** The strip gets a coloured outline, the inspector's top edge, icon and name use the same colour, and the keyboard's range bar for that sound brightens and grows drag handles. The inspector's ‹ › arrows step through the strips in desk order. 4. **An activity LED** on each strip lights while you hold notes inside that sound's range. 5. **Perform and Edit hand off to each other.** The quick panel's "Open in Edit ›" opens Edit with that strip already selected. |

What D deliberately gives up: it doesn't hide the other sounds while you edit one (angle A's approach). Its bet is
that seeing the whole rig as a desk, with one inspector, is less disorienting than a single focused sound. The
cost is more on screen at once (see Risks).

---

## 2. Information architecture

### Perform (`perform.png`, `quick.png`, `quick-output.png`)
```
top bar ........ [Perform|Edit] [gear]  MIDI · Sound · READY   REC 00:00 meter   [MASTER ━━●━ −6.0 dB ▾]
song row ....... Song name + Key | Transpose −0+ | Space [Stage▾] Vibe [Full Set▾] | Chord
setlist row .... ◀ Prev | chips … | Next ▸
stage row ...... Wheel | KEYS | PAD | EXTRA | BASS | Key & drone | Notes
                         each strip: role · instrument · fader · dB · [PEDAL | OCT | SPACE] · MUTE
bottom ......... keyboard | Revert | Fade out | PANIC | Lock
```
- **Quick row (new, one per filled strip).** Three read-only cells show the state at a glance: **PEDAL** On/Off
  (slot-coloured LED), **OCT** −2…+2 (coloured when not 0), and **SPACE**, a small ring plus a number, or "—" at 0.
  The whole row is one button. MUTE stays its own full-width button. The most urgent action is never hidden behind
  a popover.
- **Quick panel (`quick.png`).** It opens *inside its own strip*, over that strip's fader area. It never covers a
  neighbouring strip's fader, the drone or the setlist. It holds:
  - Sustain switch (`slots.i.sustain`)
  - Octave stepper −/+ (`slots.i.octave`)
  - "Into Space" knob (`slots.i.sends.reverb`), captioned "Space is Stage" so you can see where it goes
  - "Open in Edit ›"

  Its scope tag reads **THIS SONG**. It closes on Esc, on a second tap, or on a tap outside. The outside tap passes
  through, so grabbing the Pad fader both closes the panel and moves the fader. Hardware faders keep working while
  it's open.
- **Output & playing popover (`quick-output.png`).** It hangs off the top-bar Master (the ▾ chevron). Its scope tag
  reads **ALL SONGS**. It holds:
  - Master volume
  - Mono
  - Touch: Light, Normal, Heavy or Fixed
  - Sustain pedal: Test, plus Reversed
  - Keyboard picks songs
  - Restart audio, showing latency
  - "All settings ›", which opens the existing modal

  These are the mid-service fixes from research D7 and ux.md M5/B1. Everything else stays in the Settings modal.
- **Perform-lock.** The quick row stays visible (it is status) but won't open. The Output popover is read-only
  except Restart audio. That matches today's rule that faders, mute, wheel, Swell, Fade and Panic stay live.

### Edit (`edit.png`, `edit-space.png`)
```
top bar (unchanged)
┌ Library ┐ ┌ Song bar: Name · [KEY D · you play D ▾] · [TEMPO 72 BPM Tap] · [Notes •] · [WHEEL Pad level · bend→drone ▾] · Reset ┐
│ setlist │ ┌ DESK ─────────────────────────────────────────────────────────────────────┐ ┌ INSPECTOR ────────┐
│ songs   │ │ gutter │ KEYS │ PAD │ +EXTRA │ BASS │ DRONE ║ SPACE │ ECHO │ CHORUS ║ MASTER │ │ ▣ KEYS · Grand     │
│ + New   │ │ Range  │ ▬▬▬  │ ▬▬▬ │   ┆    │ ▬░░  │  D    ║       │      │        ║ Tone   │ │ Sound|Range|Resp.. │
│ Factory │ │ ▸Space │ ━25──┼━50─┼───┼────┼─0───┼major─╫─►●●· │      │        ║ Glue   │ │ …one thing, deep…  │
│ Library │ │ ▸Echo  │ ━10──┼━15─┼───┼────┼─0───┼──────╫───────┼─►●● │        ║ Tape   │ │                    │
│ export  │ │ ▸Chorus│ ─0───┼━40─┼───┼────┼─0───┼──────╫───────┼──────┼─►·●·   ║        │ │                    │
│         │ │ Level  │ fader│fader│   ┆    │fader │fader ║ fader │fader │ fader  ║ fader+ │ │                    │
│         │ │        │ MUTE │MUTE │   ┆    │MUTE  │↻Cont.║  dB   │  dB  │  dB    ║ meter  │ │ Reset · Clear slot │
└─────────┘ └────────────────────────────────────────────────────────────────────────────┘ └────────────────────┘
Keyboard: "Where each sound plays" legend | coloured range bars above the 61 keys (drag the ends) | Output meter
```
**Inspector tabs, by what is selected.** There are always at most two levels: the desk, then one inspector tab.
Each tab shows a one-line summary under its name ("Range · Whole kbd", "Response · Normal"), so nothing hidden is
invisible.

| Selected | Tabs → contents |
|---|---|
| **A sound (Keys/Pad/Extra/Bass)** | **Sound**: instrument picker (grouped as today), "Shape the ‹instrument›" knobs from `listInstruments()` params, Octave −2…+2, Transpose ± semitones. **Range**: `miniKeyboard` low/high plus "Whole keyboard". **Response**: Touch curve with the existing curve spark, Voices (Poly / Mono lowest / Mono highest), Sustain pedal, Pitch bend. **Effects**: Space/Echo/Chorus amounts (the same values as the desk rows), Tone (Lows/Highs), Width, Pan. |
| **Drone** | **Sound**: mode Off / Synth / My Pads, Brightness, Movement, Width. **Key**: key grid, Major/Minor, Follow chords (experimental), Minor uses the relative-major file. **Behaviour**: Key fade, Continue across songs, My Pads folder status. |
| **Space** (reverb) | **Presets**: the 6 SPACE_PRESETS as named cards with their blurbs. A song that matches none reads "Custom (closest: Stage)". **Fine-tune**: Size, Darkness, Pre-delay, Level. **Fed by**: the four sounds' Space amounts, editable, the same values as the row. |
| **Echo** (delay) | **Presets**: the 5 ECHO_PRESETS. **Fine-tune**: Timing (sync), Time, Repeats, Tone, Ping-pong, Level. **Fed by**. |
| **Chorus** | **Fine-tune**: Rate, Depth, Level. **Fed by**. (There are no chorus presets today, so this tab doesn't exist.) |
| **Master** | **Vibe**: the 6 VIBE_PRESETS as cards. **Tone & glue**: master EQ Low/Mid/High and Glue. **Tape**: Lofi amount plus Wow, Flutter, Crackle, Bits, Tone, Saturation. The Master level is the strip's fader. |
| **Song** (click any song-bar pill or the song name) | **Song**: name, notes, tempo and Tap. **Key**: Easy Transpose (Play In, Hear In, Octave, Minor) with today's plain-language readout. **Wheels & pedals**: mod-wheel target and min/max, expression target and min/max, volume knob target, bend mode and range, Swell time. |

**Why the desk has no Solo.** The angle brief lists mute/solo, but Solo doesn't exist in the data model. Adding it
would be a feature, and a stage hazard: a stuck solo silences the band's keys. D keeps Mute only. If it's wanted
later, a *momentary* "Listen" (hold to solo) could be transient view state, never saved.

---

## 3. Every feature has a place

| Feature (store path) | Perform | Edit: desk | Edit: inspector / elsewhere |
|---|---|---|---|
| Instrument `slots.i.instrument` | strip name | strip head (click → inspector) | Sound tab picker |
| Gain `slots.i.gain` | strip fader | strip fader (same component) | — |
| Mute `slots.i.muted` | MUTE | MUTE | — |
| Pan `slots.i.pan` | — | — (moved off the strip) | Effects tab |
| Octave `slots.i.octave` | quick panel ± | — | Sound tab |
| Transpose `slots.i.transpose` | — | — | Sound tab |
| Split `slots.i.lowNote/highNote` | — | Range row (mini bar) | Range tab; range bars over the bottom keyboard (drag) |
| Sustain `slots.i.sustain` | quick panel switch; PEDAL cell | — | Response tab |
| Mono `slots.i.mono` | — | head subtitle ("Synth · mono") | Response tab (Voices) |
| Velocity `slots.i.velocityCurve` | — | — | Response tab (with curve spark) |
| Bend `slots.i.bendEnabled` | — | — | Response tab |
| Sends `slots.i.sends.{reverb,delay,chorus}` | Space: quick panel knob + SPACE cell | Space/Echo/Chorus rows | Effects tab; the effect's "Fed by" tab |
| Width, EQ `slots.i.width`, `.eq.low/high` | — | — | Effects tab (Tone, Width) |
| Instrument params `slots.i.params.*` | — | — | Sound tab ("Shape the …") |
| Drone mode, key, minor, gain | drone block (unchanged) | drone strip: fader, key letter, mode in the head | Drone Sound / Key tabs |
| Drone brightness, movement, width, fade | — | brightness/movement readout in the strip | Drone Sound / Behaviour tabs |
| Drone chordFollow, continueAcrossSongs, minorUsesRelativeMajorFile | chips (unchanged) | "↻ Continues" pill | Drone Key / Behaviour tabs |
| Space/Echo/Vibe presets | Space & Vibe selects (unchanged) | preset name in the Space/Echo/Master heads | Presets / Vibe tabs |
| Reverb, delay, chorus params and return levels | — | return faders = `fx.*.returnGain` | Fine-tune tabs |
| Lofi, master EQ, Glue | — | Master block: Tape / Tone / Glue status | Master tabs |
| Master volume | top bar; Output popover | Master strip fader | — |
| Easy Transpose (playIn, hearIn, transposeOctave, minor) | Transpose −/+ (unchanged) | song bar "KEY D · you play D" | Song → Key tab |
| Tempo | — | song bar pill + Tap | Song tab |
| Wheel/expression/volume/bend routing, swell | wheel strip (unchanged) | song bar "WHEEL …" pill | Song → Wheels & pedals tab |
| Songs & setlists (add, duplicate, delete, reorder, factory, import/export) | setlist strip, Prev/Next | library column (unchanged; "☰ Songs" drawer at 1024) | — |
| Notes | Notes card | song bar "Notes •" | Song tab |
| Reset to factory | Revert song | song bar | inspector "Reset Keys to factory" (per slot, existing) |
| Recording | top bar (unchanged) | top bar | — |
| Settings | gear; **Output popover** (subset) | gear | modal unchanged. Latency, device, MIDI input, Program Change, MIDI Learn, pad folder, My Samples and backups stay there |

---

## 4. Risks and open questions (my own reasoning, not tested with users)
- **The mixer idea may not land for a non-technical volunteer.** A desk with buses and returns is DAW-literate. D
  avoids the words "send", "return" and "bus", uses Space, Echo and Chorus throughout, and draws the pipe. Even so,
  this is the angle's biggest open question, and a critic or a 5-minute hallway test should settle it.
- **Density.** At rest the desk shows 9 faders, 9 send bars, 3 range bars and 3 mutes. That is less than today's
  expanded Edit, but more than a focus view. It relies on the table-like alignment to read as calm rather than
  busy.
- **The inspector is far from the strip it edits.** The Keys strip is on the left and the inspector on the right.
  Colour, name, outline and range-bar highlighting carry the link. Hover-linking (hovering an inspector control
  highlights the strip cell it drives) is recommended.
- **Edit at 1024×700 is tight.** The library becomes a drawer, strip text drops to one line, and the inspector
  (290 px) scrolls (`edit-1024.png`).
- **Per-sound level meters would need new engine taps.** Only the master has analysers today
  (`engine.analyserL/R`), so D uses **activity LEDs** instead. These are computed in the view from held notes ∩ the
  slot's key range ∩ not muted, so no engine change is needed. The return strips have no meters.
- **The quick panel covers its own fader while open.** Hardware faders still work, and the panel closes on any
  outside tap.
- **Scopes are mixed on purpose, and labelled.** The quick panel says THIS SONG and the Output popover says ALL
  SONGS.
- **The drone's reverb feed is fixed inside the engine** (0.4 for synth, 0 for files; drone.js). D shows it as a
  faded cream dot in the Space junction and doesn't make it editable, which would be a feature.
