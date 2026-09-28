# Proposal B-v2: Sunday Keys–style panel + song-sheet Edit (revised after critique)

Mockups: `perform.html`, `perform-locked.html`, `perform-sound.html`, `quick-settings.html`, `quick-mac.html`, `edit.html`.
Screenshots at 1440×900: `perform.png`, `perform-locked.png`, `perform-sound.png`, `quick.png`, `quick-mac.png`, `edit.png`.
Screenshots at 1024×700: `perform-1024.png`, `quick-1024.png`, `edit-1024.png`.
Sources are in `src/`. Rebuild everything with `node design/B-v2/src/build.mjs` from the repo root (`--only=perform.png,…` to re-shoot a subset).

> **Input note.** The critique I received had lens 1 in full ("live usability: a working worship keys player / MD") and its
> `concreteChanges` list up to item 5. Items after that were cut off, and so were lenses 2 and 3. I turned each of lens 1's
> 14 problems into a change myself. On top of that I did one extra pass of my own against the user's two complaints
> ("noisy", "disconnected"). The table below separates the two.

## The idea (unchanged from v1)

**Perform** is a panel of lit switches. **Edit** reads like the song. The two views share colours, words and the same switches.

v2 keeps that idea and changes how the panel behaves under pressure. Four things changed:

- **Lock** now protects the song file and the rig, not your playing.
- **PANIC** is the brightest thing on screen.
- **Rig settings** are gone from the stage.
- **Quick settings** no longer covers the faders.

## What changed, and why

### From the critique (lens 1: live usability)

| # | Critique problem | v2 decision | Where to see it |
|---|---|---|---|
| 1 | Pedal reversed / Mono sit in the live switch bar, inches from Space/Echo | **Accepted.** Both are removed from the bar at every width. They now live only in Quick settings › *This Mac*, next to **Test my pedal** and a live pedal LED. The freed space holds an **Undo › Revert song** chip. | `perform.png`, `quick-mac.png` |
| 2 | The drone tile looks the same as the slot tiles but freezes under lock | **Accepted.** The drone ON tile behaves exactly like the slot ON tiles and stays live when locked. | `perform-locked.png` |
| 3 | Transpose is dead during a locked service | **Accepted, with a guard.** Under lock, Transpose −/+ is **press-and-hold** (600 ms, the same gesture as unlock) and shows an amber HOLD tag. A spontaneous key change takes one hold instead of unlock → change → re-lock. A plain brush does nothing. | `perform-locked.png` |
| 4 | Most of the new quick toggles are frozen in the mode people actually play in | **Accepted.** New lock rule, below. Sustain, Octave, Space, Echo and Lofi stay live under lock because Revert and "Song's own" can recover them. | `perform-locked.png` |
| 5 | Tapping the "Grand Piano" tile mutes the piano instead of picking a sound | **Accepted, reworked.** v2 uses **two separate objects** instead of a split tile. The **ON tile** holds only the role, LED and ON/OFF. Under it is a **sound picker** that looks like a select ("Grand Piano ▾") and opens a grouped popover anchored to the strip. PANIC stays visible below it. The picker is frozen under lock and shows a lock glyph. | `perform-sound.png` |
| 6 | PANIC was demoted, and the near-white "Hall" chip out-glowed it | **Accepted.** PANIC is a solid `#e5383b` fill with white 26 px text and a soft glow. A selected shared chip is now mid-grey `#3a4250` with a 2 px white border and bold white text, which reads as selected without being bright. The same style is used in Edit and in the drawer. | all Perform shots |
| 7 | The Quick settings sheet covers the faders and ON tiles | **Accepted** (the truncated item #5 said "right-side drawer"). It is now a **right-side drawer that pushes the stage**. The Wheel, all four strips (tile, picker, fader, Sustain, Octave) and a mini drone strip (ON tile, key and Level fader) stay usable. The song row, setlist and the Fade out / PANIC / Lock row are never covered. | `quick.png`, `quick-1024.png` |
| 8 | Fader throw was roughly halved (about 150 px at 1440, 100 px at 1024) | **Accepted.** The track is now **258 px at 1440 and 182 px at 1024**, measured by the build script. Today's app is about 315 px at 1440. The height came from moving the drone options off the stage, putting Sustain and Octave on one row, overlaying the wheel tag beside the fader, and slimming the song row by moving Next into the setlist row. It is still about 18 % shorter than today at 1440. See Risks. | `perform.png`, `perform-1024.png` |
| 9 | Edit has no PANIC or Fade out on screen | **Accepted.** The Edit dock now ends in **Fade out + PANIC**, in the same colours as Perform. Esc still never panics in Edit (ux.md M1); the on-screen button and ⌘. do. | `edit.png`, `edit-1024.png` |
| 10 | Edit doesn't say you are editing the live song, or what clicking another song does | **Accepted.** The sheet head has a green **LIVE** badge and the line "This is the song that's playing. Every change is heard right away and saved with the song." The rail says "Tap a song to switch to it — it starts playing", and the current song shows a small level-bars "playing" mark. This is today's behaviour (`controller.selectSong` on click), now labelled rather than changed. | `edit.png` |
| 11 | Revert is buried, and it is all-or-nothing | **Accepted in part.** Revert moves into the switch bar as its own **Undo** group (hold-to-revert under lock). For the fat-finger case the critique names (Echo "Off" wiping a custom 420 ms), each Space/Echo row gets a **"Song's own"** chip when the song was loaded with a custom value. Tapping it restores just that effect from the existing load snapshot. That gives per-effect undo with no new stored state. **Rejected:** a general per-control undo history, which is a new feature. | `perform.png`, `quick.png` |
| 12 | Drone set-and-forget options take stage space, and an empty EXTRA takes a full strip | **Accepted.** Brightness, Movement, Carry over and Follow chords move to Quick settings › This song › Drone. A "Drone options ›" row in the drone panel opens the drawer there. An empty slot collapses to a narrow dashed "+ EXTRA · EMPTY" column (64 px / 40 px) that opens the sound picker. | `perform.png`, `quick.png` |
| 13 | Prev and Next are in different places | **Accepted.** The setlist row is now **◀ Prev · chips · Next ▶ Building Swell · G**. Both song buttons are full-height targets at opposite ends of one row. | all Perform shots |
| 14 | The concept didn't say whether the Next card is a button | Resolved by #13: Next is a button. | — |

### My own pass (the user's words: "noisy", "disconnected")

| Issue in v1 | v2 change |
|---|---|
| The open Edit line still showed about 20 chips in 4 rows (Sound / Where / Feel / Voices), which was still noisy | The open line has **3 rows**: *Sound* (picker + the instrument's 2 main params), *Plays* (Every key/Split… · **− Oct 0 +** · **Sustain ●**) and a **More for Keys** fold whose summary reads "all notes · normal response · pitch bend on · no shift · centre · flat". Voices, Response, Pitch bend, semitone shift, pan, width and tone live in that fold. |
| "Disconnected": Perform and Edit used different widgets for the same thing (Oct chip row vs stepper, pill switch vs tile) | Edit's *Plays* row uses **the exact Perform foot widgets** (the same Octave stepper and Sustain LED toggle), with a tiny hint: "same switches as the Perform strip". Edit's on/off is a miniature of the Perform **ON tile** (the same colours and ON/OFF badge), not a generic pill switch. |
| "Sent into the room" was jargon | It now reads "How much of each sound goes into the room". Muted slots' send rows dim to 50 %. |
| The Quick sheet was two dense columns | The drawer has **two tabs, This song / This Mac**. Each row is a header line (the label plus what the current choice means, e.g. "Hall — big concert hall…") followed by chips at full width, with a scope line under the tabs that states the lock rule. |

## The v2 lock rule

**Lock protects the song file and the rig, not your playing.**

| While locked | Controls |
|---|---|
| **Live** (one tap) | faders, all 4 slot ON tiles, **drone ON tile**, drone Level, Wheel/Swell, **Sustain**, **Octave**, **Space / Echo / Lofi chips (incl. "Song's own")**, Prev/Next/setlist chips, Fade out, PANIC, opening Quick settings, **Test my pedal**, **Restart audio** |
| **Hold 600 ms** (amber HOLD tag, same gesture as unlock) | Transpose −/+, drone key grid, Major/Minor, Revert song |
| **Frozen** (dimmed, lock glyph) | sound pickers, drone Synth/My Pads, Vibe, drone options, Swell time, setlist reorder, Edit tab, ⚙ Settings, the rest of *This Mac* (pedal Normal/Reversed, Mono, Touch, keyboard toggles) |

Why hold, not freeze, for key changes: a mistaken key change is the one live mistake the audience hears in every note. Hold makes it deliberate without the unlock → change → re-lock routine.

Why *This Mac* freezes: Pedal reversed and Mono flipping mid-song are soundcheck mistakes. The critique's own "Freeze … This Mac settings" is adopted, but the two emergency actions (Test my pedal, Restart audio) stay live.

## Perform: information architecture (1440×900; 1024×700 in brackets)

```
top bar   brand · Perform/Edit · MIDI / Sound / READY · REC · meter · Master · ⚙          (unchanged)
song row  Song name + KEY + "you play in D · 72 BPM" | Transpose − 0 + | Chord               ([Notes] in song card)
setlist   ◀ Prev | 1 Sunday Pad + Piano D · 2 Building Swell G · … | NEXT Building Swell · G ▶
stage     Wheel | KEYS | PAD | +EXTRA (empty, 64px) | BASS | DRONE | Notes                    (Notes hidden)
            strip:  [● KEYS            ON]   ← ON tile = mute, and nothing else
                    [Grand Piano        ▾]   ← sound picker (popover; frozen when locked)
                    vertical Level fader + dB (wheel tag beside the fader on Pad)
                    [Sustain ●][− Oct 0 +]
            drone:  [● DRONE           ON]  D major  [Synth|My Pads]
                    12-key grid · Major/Minor · Level
                    [Drone options  brightness, movement, carry over ›]  → opens Quick › Drone
switch bar SPACE Room Stage [Hall] Cathedral More▾ | ECHO Off Slap ¼ Dotted⅛ Trails [Song's own 420 ms] |
           LOFI ●Tape | UNDO ↺ Revert song | [Quick settings]                              (Slap, Trails, Cathedral in More/drawer)
bottom    61-key keyboard | Fade out | PANIC (solid red) | Lock / Locked·hold to unlock
```

**Quick settings drawer** (520 px; 392 px at 1024). It sits right of the stage and pushes it. When it opens, the Notes column and the drone key grid step aside and the drone becomes a mini strip (ON tile, key, Level fader).
- **This song**: Space (6), Echo (5 + Song's own), Lofi, Vibe 🔒, Drone (Brightness, Movement, Carry over, Follow chords) 🔒, Swell time 🔒.
- **This Mac**: Sustain pedal Normal/Reversed + Test my pedal + live LED, Output Stereo/Mono, Touch, Keyboard toggles, Restart audio, plus **All settings…** (the unchanged modal).

## Edit: information architecture

```
rail (220)  Setlist ▾ · "Tap a song to switch to it — it starts playing." · songs (current shows ▮▮▮ playing) · New/Factory/Library
sheet head  [● LIVE] Sunday Pad + Piano [FROM FACTORY]                                 [Notes] [Reset to factory]
            In the key of D major — you play in D, no transpose · tempo 72 BPM tap to set
            This is the song that's playing. Every change is heard right away and saved with the song.
WHAT PLAYS                                                 HOW IT SOUNDS
 KEYS plays Grand Piano on every key, sustain on  ▬ [●ON] ›   Vibe: your own mix   [Sunday][Full Set]…
   Sound  [Grand Piano ▾]  Release ▬  Tone ▬                   The room is a Hall   [Dry][Room][Stage][Hall]…
   Plays  [Every key|Split…] [− Oct 0 +] [Sustain ●]             blurb · How much of each sound goes into the room: Keys ▬ Pad ▬ Bass ▬
   › More for Keys  all notes · normal response · …              › Fine-tune
 PAD plays Warm Pad, swells with the mod wheel    ▬ [●ON] ›   Echo: song's own 420 ms · ● Keys 10% ● Pad 10%  ›
 EXTRA is empty — choose a sound                         ›   Chorus: gentle shimmer on ● Pad 35%             ›
 BASS plays Sub Bass below middle C, an octave down, …  [OFF] ›   Lofi tape: off                         [OFF] ›
 DRONE hums a synth in the song key, carries over ▬ [●ON] ›   Finish: tone flat, glue off, master −6 dB      ›
 HANDS the wheel brings in the Pad, bend lifts the drone…  ›
dock   range lanes (open line gets handles; muted lane dimmed; "up to B3") + 61 keys | OUTPUT meter · [Fade out] [PANIC]
```

## Every existing feature still has a place

The v1 mapping table (in `design/B/concept.md`) still holds, with these v2 moves:

| Feature | v1 location | v2 location |
|---|---|---|
| Slot instrument (Perform) | not in Perform (tile showed the name) | strip **sound picker** popover (same grouped list as Edit's select) |
| pedal invert, mono output | Perform bar (≥1180) + Quick › This Mac | Quick › This Mac only |
| drone brightness / movement / continueAcrossSongs / chordFollow | drone panel (1440) | Quick › This song › Drone, plus the Edit DRONE line |
| Revert song | Quick › This song | switch bar › Undo (hold when locked) |
| Next song | card in the song row | button at the right end of the setlist row |
| slot transpose (semitones), mono, velocityCurve, bendEnabled, pan/width/eq | Edit "Where/Feel/Voices" rows + Placement fold | Edit **More for Keys** fold |
| slot octave, sustain, split | Edit "Where/Feel" rows | Edit **Plays** row (the Perform widgets) |
| Fade out, PANIC | Perform only | Perform + Edit dock |

Nothing is added to the data model. "Song's own" reads the snapshot that Perform already takes for Revert.

## Risks and open questions

1. **Fader throw is still 18 % shorter than today at 1440** (258 px vs about 315 px). The alternative is to drop the per-strip picker row (38 px) and open the picker by long-pressing the tile, but that is invisible to a volunteer. I kept the visible picker. [infer: untested with users]
2. **The looser lock is a behaviour change.** It is small and uses existing controls, but ui-core tests that assert "X disabled when locked" need updating. Anyone who relied on lock freezing Space/Echo loses that.
3. **Hold-to-change is a hidden gesture.** It is mitigated by the amber HOLD tags that appear only while locked, and by reusing the unlock gesture players already know. A first press should flash "hold to change key" (the existing lock hint pattern).
4. **The drawer squeezes the strips at 1024** (about 114 px wide, and the picker truncates to "Grand P…"). Everything stays usable, but it's tight. The alternative is to let the drawer overlay the drone mini strip at 1024.
5. **"Song's own" appears only when the loaded song had a custom value.** If the song was saved on a preset, the preset chip already does the job. This rule must be explained in one line in the blurb, as the mockup does.
6. **Sentence copy** (from v1) still needs a real volunteer test. BASS's sentence wraps to two lines at 1440, within the stated 2-line cap.
