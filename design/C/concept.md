# C: "Hardware panel". Perform and Edit are one front panel

**Idea in one line:** Worship Rig becomes a stage keyboard, following the Nord Stage and Yamaha CP line. It has one fixed front panel where every section has a permanent place. **Perform is the panel. Edit is the same panel with a drawer pulled out under the section you touched.** You never go to a different page, so you always know which sound you are changing.

Mockups: `perform.html`, `quick-settings.html`, `edit.html`, and `edit-fx.html` (a bonus that shows the Effects drawer). Screenshots: `perform.png`, `perform-1024.png`, `quick.png`, `quick-1024.png`, `edit.png`, `edit-fx.png`. The generator is in `src/build.mjs` and `src/shoot.mjs`.

---

## 1. The panel (the same in both views)

The panel runs left to right in fixed columns. Their widths are shared CSS variables, so a column never moves when you switch views.

| Column | What is on the surface | Perform | Edit |
|---|---|---|---|
| **CONTROL** (like a Nord's wheel section) | Mod-wheel bar and value, "→ Pad level", Swell, and lamps for Pedal, Expr and Bend→Drone | live | + a drawer for **Wheels & pedals** |
| **1 KEYS · 2 PAD · 3 EXTRA · 4 BASS** (slot colours) | Slot LED, an instrument display, **SPACE** and **ECHO** knobs (the sends), a vertical **Level** fader and dB, a **PLAY** lamp, **OCT −/+** with a 5-LED ladder, and **SUS** and **MUTE** LED buttons | live | the display becomes the instrument picker, and the drawer holds everything else |
| **DRONE** (Tonic pattern) | Off / Synth / My Pads LED buttons, a 12-key grid, Major/Minor, **Brightness** and **Movement** knobs, **Follow chords** and **Keep on next song** LEDs, and a vertical **Level** fader | live | + a drawer with Width, Key fade, "minor keys use the major pad file" and the pad folder |
| **EFFECTS** (shared, neutral grey) | **Vibe** ◀ name ▶; **SPACE** list with an LED per preset (Dry…Ambient Wash) plus a Level knob; **ECHO** list (No Echo…Ambient Trails) plus a Level knob; a small **FED BY** bar per slot under each; an **ALSO** lamp row for Chorus, Lofi, Tone EQ and Glue | live (presets and levels) | + a fine-tune drawer for every FX parameter |

Above the panel:

- **Program row.** It shows a large LCD-style display with the setlist and song number, the song name at 46 px, **KEY** at 46 px in accent, and the **CHORD** readout. Next to it are Transpose −/0/+ and the Notes scribble strip. "↺ Revert song" sits in the display corner.
- **Program buttons.** This is the setlist strip, with Prev on the left and Next showing the song name and key.

Below the panel is a 61-key keyboard. It has a thin **coloured range bar for each slot**, and held notes are lit. Next to it are **SYSTEM**, Fade out, PANIC and Lock.

One control shape per role, everywhere:
- **Vertical fader:** volume only (slot Level, Drone Level).
- **Rotary knob in the owner's colour:** "how much" (sends, tone, width, FX amounts). Shared FX knobs are neutral grey.
- **LED button:** on/off, and only for values that are really boolean (Sustain, Mute, Major/Minor, Follow, Keep, Ping-pong, Mono…).
- **LED list:** choose one (Space and Echo presets, Touch). An LED is lit only when the current values match a preset. When the song is Custom, the closest preset's LED is half-lit, so it never shows a dead "Custom".
- **Segmented / stepper:** only inside drawers (Transpose, Notes at once, Touch for this sound, Echo timing).
- **Horizontal slider:** only the master volume in the top bar.

## 2. Edit = the panel "opened"

- Press **Edit** and the columns don't move. Each section gets a small **MORE ▾** tab, and the instrument displays turn into pickers (dashed border).
- Clicking a section's tab or header **selects** it. The section gets a 2 px outline in its own colour, the tab reads **EDITING**, and a **drawer** slides out below the panel. The drawer's outline is the same colour and joins the section's outline with no line in between, so the section and its drawer read as one shape. Only one drawer is open at a time, and ◀ PREV / NEXT ▶ step to the neighbouring section.
- The slot drawer (`edit.png`) holds everything that isn't on the surface, in four named groups:
  - **Sound:** instrument picker, plus that instrument's own params (Release and Tone for Grand Piano).
  - **Colour & stereo:** Lows, Highs, Chorus send, Pan, Width.
  - **How it plays:** Transpose, Pitch bend, Notes at once (Poly / Lowest / Highest = `mono`), Touch for this sound (`velocityCurve`).
  - **Where it plays:** range text, Lowest and Highest note steppers, and draggable handles on that slot's coloured bar on the keyboard below. The other slots' bars dim.
- The Effects drawer (`edit-fx.png`) holds six modules side by side: Space, Echo, Chorus, Lofi tape, Tone, Glue. Each has an ON/OFF tag, or the preset name, beside its title.
- The **program row becomes editable in place.** The name gets a caret. Play In, Hear In, Octave, Minor, Tempo with Tap, Notes and Reset to factory all sit where the key and notes were.
- The **program-button row becomes the library bar:**
  - a Setlist picker (New, Rename and Delete in its menu);
  - drag grips on the chips, with Duplicate and Delete on the current chip;
  - **+ Add song** (a popover with New blank, Factory by category, and Library with search);
  - **Library ▾** (Import, Export library, Export song).
- There are at most **two disclosure levels**: the panel, then one drawer. Instrument params sit in the slot drawer itself, not in a third expander.

## 3. Quick settings from Perform: SYSTEM

`quick.png` and `quick-1024.png` show this. The **SYSTEM** button sits next to Fade out, PANIC and Lock, and opens the same kind of drawer over the lower panel, with a notch pointing at the button. Panic, Fade and Lock stay above the scrim and keep working. The header reads **ALL SONGS**: "These are rig settings, not part of the song." The drawer contains:

- **Touch:** Light / Normal / Heavy / Fixed (`settings.velocitySens`).
- **Sustain pedal:** a large live lamp ("Pedal down"), **Reversed** (`pedalInvert`), and **Test pedal**.
- **Sound out:** latency readout, **Mono** (`monoOutput`), **Restart audio**.
- **Keyboard:** the connected device, **Keyboard picks songs** (`programChange`), **Computer keys play notes** (`computerKeyboard`).
- **If it goes wrong:** three lines of static help (hidden at 1024).
- **All settings…** opens the existing modal for set-and-forget items (latency mode, output device, MIDI input, MIDI Learn, pad folder, My Samples, backups).

The panel itself answers "Sunday Keys toggles". **Per-song** quick changes are the LED buttons and knobs already on the surface: SUS, OCT, MUTE, the SPACE and ECHO sends, the Space and Echo preset lists, Vibe, and Drone Brightness and Movement. Each one is a true toggle or cycle of an existing value, so no "remembered previous value" state is needed. The Sunday Keys-style Engage/Bypass for sends was avoided on purpose. **Perform Lock** freezes all of them, and SYSTEM too (except Restart audio and Test pedal), as the existing `isLocked()` guards already do for song edits.

## 4. How this answers the user's complaints

| User's words | Cause (research D#) | What C does |
|---|---|---|
| **"I feel disconnected from what I'm changing"** | D1: Edit's layout is unrelated to Perform's. D3: two "Reverb"s with no link. D5: no picture of what's sounding. | **Position is identity.** Keys is always column 2 in orange, in both views, and its drawer is attached to it by a continuous orange outline. The send is called **SPACE** on the slot and **SPACE** on the effect, and the effect shows a **FED BY** bar per slot, so the send → room flow is drawn. Key ranges are coloured bars on the keyboard. The **PLAY** lamp lights when a held note is in that slot's range. |
| **"Too noisy / everything is just buttons/dials"** | D2: every control is the same slider. D6: about 17 identical cards. | **One chassis, not 17 cards:** sections are divided by a hairline, not boxed. **Each control shape means one thing** (fader = volume, knob = amount, LED = on/off, LED list = pick one), so the eye can sort the panel before reading labels. The drawer shows **one section at a time**, with a maximum of about 12 controls in four named groups. There are no horizontal sliders in the song area. |
| **"Settings I can change from Perform, like Sunday Keys' toggles"** | D7: stage-critical settings are in a modal. | Per-song modifiers live on the panel (SUS, OCT, MUTE, SPACE and ECHO knobs, Space and Echo preset lists). Rig settings are one press away in **SYSTEM**, clearly labelled as all-songs. |
| **"Shouldn't change the functionality much"** | | Every parameter, preset and setting maps to an existing store path. The only additions are *derived* displays: the PLAY lamp, FED BY bars and the half-lit closest preset. |

## 5. Where every feature lives (nothing lost)

| Feature (store path) | Perform | Edit |
|---|---|---|
| Slot instrument (`slots.i.instrument`) | display, read-only | display = picker; drawer: Sound picker with groups |
| Gain (`gain`) / mute (`muted`) | slot fader + MUTE | same |
| Pan, width, EQ low/high (`pan`, `width`, `eq.low/high`) | — | slot drawer: Colour & stereo knobs |
| Octave (`octave`) | OCT −/+ with LED ladder (−2…+2) | same |
| Transpose (`transpose`) | — | slot drawer: How it plays stepper |
| Split (`lowNote/highNote`) | range bars on the keyboard (read-only) | drawer: Where it plays (Lowest/Highest steppers), plus drag handles on the bar |
| Sustain (`sustain`) | SUS LED button | same |
| Mono (`mono`) | — | drawer: "Notes at once" segmented |
| Velocity (`velocityCurve`) | — | drawer: "Touch for this sound" |
| Pitch bend (`bendEnabled`) | — | drawer: "Bends this sound" LED |
| Sends (`sends.reverb/delay/chorus`) | SPACE and ECHO knobs | same; Chorus in the drawer |
| Instrument params (`params.*`) | — | drawer: Sound group, knobs from `listInstruments()` |
| Drone mode/key/major-minor/gain | Drone section | same |
| Drone brightness/movement | knobs on the surface | same |
| Drone width/fade | — | Drone drawer |
| Chord-follow / continue across songs / minor→relative-major | Follow and Keep LEDs on the surface | + the relative-major LED and pad-folder status in the Drone drawer |
| Space / Echo / Vibe presets | Effects LED lists and Vibe ◀▶ | same |
| Reverb size/damp/predelay/return | Space Level knob (return) | Effects drawer: Space |
| Delay time/feedback/pingpong/tone/sync/return | Echo Level knob (return) | Effects drawer: Echo |
| Chorus rate/depth/return, Lofi ×7, EQ low/mid/high, Glue | ALSO lamps (on when above 0 or not flat) | Effects drawer modules |
| Master volume | top bar | top bar |
| Easy Transpose (playIn/hearIn/transposeOctave/minor) | Transpose −/+ and the KEY display; drone key grid | program row: Play In / Hear In / Octave / Minor |
| Tempo + tap | — | program row |
| Mod wheel / expression / CC7 volume / bend mode+range / swell seconds | CONTROL section readouts, Swell | Control drawer: target + min/max for each, bend mode and range, Swell time |
| Songs / setlists: add, duplicate, delete, reorder, factory browser, import, export, reset to factory | setlist strip, Prev/Next | library bar: Setlist ▾, grips, + Add song, Library ▾; Reset to factory in the program display |
| Notes | scribble strip (a Notes button at 1024) | editable in place |
| Recording, meter, MIDI/Sound/Ready status | top bar (unchanged) | same |
| Fade out, Panic, Lock, Revert song | bottom cluster; Revert in the display corner | as today: Edit has no stage buttons (the output meter sits there, as in the current Edit) |
| Settings | SYSTEM drawer (stage items), gear → modal (everything) | gear → modal |

## 6. Behaviour notes and open questions

- **1024×700:** Perform is mocked (`perform-1024.png`). The columns shrink, Notes turns into a button, and labels shorten (Bright, Move, Follow, Keep). **Edit at 1024×700 is not mocked.** The plan is for the drawer to *overlay* the lower half of the panel, rather than push it, when the viewport is under 800 px tall. The selected section's header and display stay visible above it. This is unverified.
- The Edit fader is short, about 90 px at 1440×900, because the drawer takes the space. It's still the same control in the same place, but it's less precise while the drawer is open.
- **Perform gets more live controls than today:** sends, octave and sustain per slot, plus the Echo list. That makes Perform busier than the current four bare faders, and adds more ways to change the song by accident (ux.md M7). Revert song and Lock cover it, but it is a real trade against "calm Perform". If the critic finds it too busy, a fallback is to drop the per-slot knobs from Perform and keep only SUS, OCT and MUTE.
- The LED-list look assumes the six Space and five Echo presets stay short, one-line names. It holds at 1024 (checked).
