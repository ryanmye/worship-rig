# Proposal B: a Sunday Keys–style performance panel plus a song sheet for Edit

Mockups: `perform.html`, `quick-settings.html` and `edit.html`. Screenshots are `perform.png`, `perform-1024.png`,
`quick.png`, `quick-1024.png`, `edit.png` and `edit-1024.png`. Sources are in `src/`, and `node design/B/src/build.mjs`
rebuilds the HTML and the screenshots.

## The idea in one paragraph

**Perform** becomes a panel of lit switches. Each sound's strip is topped by a big coloured tile that *is* its on/off
switch (KEYS · ON · Grand Piano). Under the fader sit two small modifiers, Sustain and Octave. The drone gets the same
kind of tile, following Sunday Keys' Tonic panel. A **switch bar** above the keyboard holds the song-wide choices as
fingertip chips: Space (Room/Stage/Hall/Cathedral), Echo (Off/Slap/¼/Dotted ⅛/Trails), Lofi, and on wide screens
Pedal reversed and Mono. The bar ends in a **Quick settings** sheet with two labelled halves, *This song* and *This Mac*.
**Edit** becomes a calm, two-column **song sheet**. The left column, *What plays*, has one line per sound, drone and
hands. The right column, *How it sounds*, holds the shared room and effects. Every line reads as a sentence whose
underlined words are the controls, for example "**KEYS** plays <u>Grand Piano</u> on <u>every key</u>, sustain <u>on</u>".
Only one line is open at a time.

## Why this answers "noisy / all dials / disconnected"

| Complaint | Cause (research D#) | What B does |
|---|---|---|
| **Noisy** | About 17 identical cards, and every section opens into rows of identical sliders (D2, D6) | A closed line is a single sentence. Only one sound is open at a time, and even open it shows 4 labelled rows of choose-one chips and toggles. Sliders appear only where the value really is continuous (Level, instrument params, room "Fine-tune"). Fine-tune and Placement & tone stay folded, and there is never a third disclosure level. |
| **All dials/buttons** | Level, sends, EQ and room params are all the same horizontal slider (D2); units are engineering units (D4) | There is one control shape per role: tile = on/off for a sound; chip row = pick one (presets, octave, response, voices); LED toggle = on/off setting; slider = continuous amount. Values are shown as words first ("Hall", "swells with the mod wheel", "below middle C"), with dB/ms kept in grey or in Fine-tune. "Custom" is never a dead end: the closest preset gets a **dashed outline** and the label says "Custom 420 ms". |
| **Disconnected from what I'm changing** | Edit's layout doesn't match Perform's (D1); "Reverb" means two things (D3); Edit doesn't show what's sounding (D5) | (1) Each line is written in the language of the result ("PAD plays Warm Pad, swells with the mod wheel"), so the sentence changes as you edit it. That is the "continuous representation of the object" (NN/g direct manipulation). (2) **Slot colour follows the sound**: the line's rail, its underlined words, its Level fill, its send bar in the FX cards and its **range bar over the keyboard** all use its colour. (3) Sends live in exactly one place, inside each effect card, as "Sent into the room: Keys 25% · Pad 50% · Bass dry" in slot colours. That makes the send → shared-room relationship visible without a diagram. (4) The keyboard dock shows each sound's key range as a coloured bar with drag handles, so "C-1/G9" text inputs go away. (5) Perform and Edit share vocabulary and state: the same ON switch, the same "Hall" chip, the same Sustain/Octave. |
| **"Settings I can change from Perform, like Sunday Keys' toggles"** | Mid-service settings are behind a modal (D7) | Tier 1 is always visible and one tap away: sound on/off tiles, Sustain, Octave, the drone tile, the Space/Echo/Lofi chips, and Pedal reversed/Mono at ≥1180 px. Tier 2 is the Quick settings sheet: Vibe, all 6 spaces with a blurb, all echoes, Swell time, Revert song, Touch, Sustain pedal Normal/Reversed plus **Test my pedal** and a live pedal LED, Stereo/Mono, song buttons, computer keys, and Restart audio. Tier 3 is the existing Settings modal ("All settings…"). |

## Perform: information architecture (1440×900; 1024×700 in brackets)

```
top bar   brand · Perform/Edit · MIDI / Sound / READY · REC 00:00 · meter · Master · ⚙        (unchanged)
song row  Song name + KEY + "you play in D · 72 BPM"   | Transpose − 0 + | Chord | Next ▸     (Notes button at 1024)
setlist   ◀ Prev | chips                                                                     (unchanged)
stage     Wheel | KEYS | PAD | EXTRA | BASS | DRONE (Tonic) | Notes                         (Notes column hidden at 1024)
            each strip: [ ROLE · ON ● / Instrument ]  ← the tile IS the on/off (mute) switch
                        vertical Level fader + dB (+ wheel marker)
                        [ Sustain ● ]  [ − Oct 0 + ]
            drone:     [ DRONE · ON ● / D major  (Synth | My Pads) ]
                        12-key grid · Major/Minor · Level · Brightness · Movement · Carry over · Follow chords
switch bar SPACE Room Stage [Hall] Cathedral More▾ | ECHO Off Slap ⌜¼⌟ Dotted⅛ Trails | LOFI ●Tape |
           RIG (THIS MAC) ●Pedal reversed ●Mono | [≡ Quick settings]                      (1024: Room Stage Hall More · Off ¼ ⅛ · Tape · Quick)
bottom    61-key keyboard | Fade out | PANIC | Lock                                         (unchanged)
```

* **State is visible at a glance, even in low light.** A lit tile is filled with the slot colour and shows ON and a
  glowing LED. An OFF tile is grey and shows an OFF badge, and its fader, Sustain and Octave dim to 45%. A selected
  shared chip is a near-white fill with dark text. That is the brightest thing on screen apart from the song name,
  and the colour is kept away from the slot colours, so "shared" never looks like "Keys" (research P7/M4). Custom
  presets get a dashed outline on the nearest chip.
* **Colour discipline.** Slot colours appear only on things that belong to a slot. Shared FX are neutral. The drone
  keeps the app's existing gold, because the key grid already uses it.
* **The quick settings sheet** rises over the stage. It deliberately leaves the song row visible (1440) and always
  leaves the **Fade out / PANIC / Lock row uncovered**. It has two halves, each with a scope line:
  * *This song*: "saved with 'Sunday Pad + Piano'", and "frozen while Perform is locked".
  * *This Mac*: "every song · stays live when locked".

  This settles the per-song vs global question from research §5 by labelling each half.
* **Perform lock.** The existing rule is kept: song-level controls freeze (Sustain, Octave, drone tile/mode/key,
  Space/Echo/Lofi, Vibe, Swell time, Revert), while faders, sound ON tiles (mute), wheel, Swell, Fade and Panic stay
  live. The two *This Mac* toggles in the bar (Pedal reversed, Mono) become **hold-to-change** (600 ms, the same
  gesture as unlock) while locked, so an accidental brush can't flip the pedal mid-song.

## Edit: information architecture

```
top bar (unchanged)
rail (220px)  Setlist ▾ · songs in set (drag to reorder, current highlighted) · New / Factory / Library · Library file   (drawer "Songs ▾" at 1024)
sheet head    Sunday Pad + Piano [FROM FACTORY]                         [Notes] [Reset to factory]
              In the key of <D major> — you play in <D>, no transpose · tempo <72 BPM> tap to set
┌ WHAT PLAYS ───────────────────────────────┐ ┌ HOW IT SOUNDS ─────────────────────────────┐
│ KEYS plays <Grand Piano> on <every key>…  ▬ ◉ │ │ Vibe: <your own mix>  [Sunday][Full Set]…     │
│   Sound  [Grand Piano ▾] Release ▬ Tone ▬     │ │ The room is a <Hall> [Dry][Room][Stage][Hall]…│
│   Where  [Every key|Split…] [−2 … +2] [− 0 st +]│ │   blurb · Sent into the room: Keys ▬ Pad ▬ Bass▬│
│   Feel   ●Sustain ●Pitch bend [Soft|Normal|…]  │ │   ▸ Fine-tune size · darkness · pre-delay · level│
│   Voices [All|Lowest|Highest]  ▸ Placement&tone│ │ Echo: <custom 420 ms> — fed by ●10% ●10%   ›  │
│ PAD plays <Warm Pad>, <swells with the wheel> ▬ ◉│ │ Chorus: <gentle shimmer> on ● Pad 35%       ›  │
│ EXTRA is empty — <choose a sound>            › │ │ Lofi tape: <off>                        ◉  ›  │
│ BASS plays <Sub Bass> <below middle C>, …    ▬ ◉│ │ Finish: tone <flat>, glue <off>, master <−6 dB>›│
│ DRONE hums <synth> in <the song key>, …      ▬ ◉│ └──────────────────────────────────────────────┘
│ HANDS wheel <brings in the Pad>, bend <lifts…> › │
└──────────────────────────────────────────────┘
dock  KEYS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  (range bars with drag handles, slot colours; muted = dimmed)
      PAD  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      BASS ━━━━━━━━━━━┫
      61-key clickable keyboard                                           output meter
```

* **Sentence rules.** A sentence mentions only what differs from normal. Full range, sustain on, octave 0 and pan
  centre are not spelled out, except on the open line. Clicking an underlined word opens that line and focuses the
  matching control. That is one disclosure level; the folds inside it are the second and last.
* **Keys and hands.** At most one "What plays" line is open. Opening another closes the first, and the keyboard
  range bar for the open sound gets its handles.
* **Right column.** The FX cards are neutral grey. Only the per-slot send bars inside them use slot colours.

## Every existing feature has a place (nothing lost)

| Feature | Perform | Edit |
|---|---|---|
| Slot instrument | tile shows name | line token → "Sound" row picker (grouped, same `select`) |
| gain | vertical fader (unchanged) | line Level slider (dB in open line) |
| mute (`muted`) | **tile tap** (ON/OFF) | line on/off switch |
| pan, width, eq.low/high | — | "Placement & tone" fold |
| octave | foot stepper `− Oct 0 +` | "Where" chip row −2…+2 |
| transpose (slot) | — | "Where" stepper `− 0 st +` |
| lowNote/highNote (split) | — | "Every key / Split…" + dock range bars (drag, or Split… then play a note) |
| sustain | foot LED toggle | "Feel" toggle |
| bendEnabled | — | "Feel" toggle "Pitch bend" |
| mono (off/lowest/highest) | — | "Voices" All notes / Lowest only / Highest only |
| velocityCurve | — | "Feel" chips Soft/Normal/Hard/Fixed, labelled **Response** so it doesn't clash with the global **Touch** |
| sends reverb/delay/chorus | — | inside the Space / Echo / Chorus cards as slot-coloured bars ("Sent into the room") |
| per-instrument params | — | "Sound" row: first 2 params inline + "N more" expands in place |
| drone mode | tile tap (on/off) + Synth/My Pads chips in tile | DRONE line open: mode chips |
| drone key / minor | 12-key grid + Major/Minor (unchanged, lock-frozen) | follows the song key: the "In the key of" token in the head |
| drone gain, brightness, movement | Level + two sliders | DRONE line |
| drone width, fade, minorUsesRelativeMajorFile | — | DRONE line open |
| drone chordFollow, continueAcrossSongs | two LED toggles (1440) | DRONE line open |
| Space presets + reverb size/damp/predelay/returnGain | switch bar chips; all 6 in Quick | Space card chips + Fine-tune |
| Echo presets + delay time/feedback/pingpong/tone/sync/returnGain | switch bar chips; all 5 in Quick | Echo card chips + fine-tune |
| Vibe presets | Quick → This song | Vibe card chips |
| chorus rate/depth/returnGain | — | Chorus card |
| lofi amount/wow/flutter/crackle/bits/tone/saturation | switch bar "Tape" toggle | Lofi card: switch + Amount + fold |
| fx.eq low/mid/high, comp (Glue), master.volume | Master in top bar | Finish card |
| Easy Transpose (playIn/hearIn/transposeOctave/minor) | Transpose ± card | sheet head sentence tokens |
| tempo + tap | "72 BPM" in song row | head token + tap |
| modWheel/expression/volume targets + min/max, bend mode/range, swell seconds | wheel strip (unchanged); Swell time in Quick | HANDS line open: 4 routings + bend range + swell time |
| songs, setlists, reorder, factory browser, import/export, reset to factory | setlist strip, Prev/Next | rail + head buttons (unchanged behaviour) |
| notes | Notes column (1440) / Notes button (1024) | head "Notes" button → inline editor under head |
| Revert song | Quick → This song | — |
| recording | top bar REC (unchanged) | same |
| chord readout, MIDI/audio/Ready status, Fade out, Panic, Lock | unchanged | status unchanged |
| Settings: Touch, pedal invert + test, mono, program change, computer keyboard, Restart audio | **Quick → This Mac** (+ Pedal reversed/Mono in bar) | via ⚙ |
| Settings: latency, output device, MIDI input, MIDI Learn, pad folder, My Samples, backups | ⚙ / "All settings…" (unchanged modal) | same |

## What B deliberately does not do

* It adds no snapshots, no new per-song state and no "remember previous send" toggles. The chips *apply existing
  presets*. The Lofi toggle applies the Lofi-Tape vibe's lofi values or sets amount 0. The drone tile toggles
  `mode` between off and Synth/My Pads (see implementation.md for the exact rule).
* Edit's slots don't mirror Perform's four vertical strips. That was angle A. B instead makes Edit *read* like the
  song and uses colour and shared vocabulary for continuity. The price is less positional sameness between the two
  views (see risks).
