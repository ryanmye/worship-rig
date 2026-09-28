# Angle A: "Instrument-first"

**One line:** Edit shows *one sound at a time*, as an instrument with a picture, a name and 3 knobs labelled in words.
Above it sits a small live **rig map** (Keyboard → the four sounds + drone → Space / Echo / Chorus → Tape → Master).
The map is both the navigation and the answer to "what am I changing?". Perform stays as it is, plus two additions:
per-sound **modifier chips** under each fader, and a **Quick settings** drawer.

Mockups (1440×900 unless noted): `perform.png`, `perform-1024.png` (1024×700), `perform-chip.png`, `quick.png`,
`quick-1024.png`, `edit.png`, `edit-1024.png`, `edit-space.png`, `edit-advanced.png`. The HTML sources are next to them.

---

## 1. Why the current Edit feels the way it does, and what A does about it

| User's words | Cause (research.md) | What A changes |
|---|---|---|
| **"Too noisy"** | About 17 identical cards compete: the setlist, notes, transpose, tempo, 4 slots, wheels, drone, and 7 FX cards in a right-hand column (D6). An expanded slot adds 9 identical sliders (D2). | Edit has **three regions**: library (left), rig map (top), and **one focus panel**. The FX column and the wheels/drone/notes cards are gone as separate cards, because every one of them is now a block on the map that opens *in the same panel*. Only one thing is ever open. |
| **"Everything is just buttons/dials"** | One control shape for everything. Level, pan, sends, EQ and reverb size all use the same slider (D2). Values are shown in dB and ms (D4). | **One shape per job, each labelled in words:** the vertical fader is always *volume*. A round knob is always *the character of this sound* (Brightness / Warmth / Fade-in or Ring-out). A "pipe" slider with an arrow is always *how much goes into a shared effect* ("Space 25% → Hall"). Chips are always *pick one* (Hall, Dotted Eighth, Octave). Each value is shown as a word first ("Bright", "Slow") with the number in grey after it. The first level has about 10 controls in 4 labelled groups. Everything else is behind **Advanced** (the second and last level). |
| **"Disconnected from what I'm changing"** | Edit doesn't look like Perform (D1). "Reverb" means both a send and the room, with no link between them (D3). Nothing shows what is sounding (D5). | (a) The **map's sound blocks use Perform's strip order and colours** (Keys orange, Pad green, Extra blue, Bass purple, drone cream). (b) The block you're editing is outlined, and **a line in its colour runs from the block down into the panel**, so the panel is visibly attached to it. (c) The panel's **send pipes are the same controls as the dots on the map**: move "Space 25%" and the orange dot on the Space lane grows. (d) Blocks and lanes **light up from the notes you're holding**, and the bottom keyboard shows **each sound's key range as a coloured bar**. The selected sound's bar stays bright and the others dim. |

What A deliberately doesn't do: it doesn't open all four sounds side by side. That is angle "Perform with the lids
open" from research §3a. A trades seeing everything at once for *focus plus a map*. The map keeps the whole rig
visible, but only one sound's controls are ever open.

---

## 2. Information architecture

### Edit (edit.png)
```
┌ top bar (unchanged; REC, master, gear) ───────────────────────────────────────────────┐
│ Library  │ Song header: name · [Key D · you play D ▾] · [72 BPM Tap] · [Notes] · Reset │
│ (setlist,│ ┌ YOUR RIG ────────────────────────────────────────────── Vibe [Custom ▾] ┐ │
│  songs,  │ │ [Keyboard] → [KEYS][PAD][EXTRA][BASS][DRONE] ══ dry ══▶ [Tape] → [Master] │ │
│  +New,   │ │  → Space ──●────●──────────○──────────▶ (Space · Hall)   ┐                │ │
│  Factory,│ │  → Echo  ──●────●──────────○──────────▶ (Echo · Custom)  ├─▶ Tape         │ │
│  Library,│ │  → Chorus──○────●──────────○──────────▶ (Chorus)         ┘                │ │
│  export) │ └───────┬──────────────────────────────────────────────────────────────────┘ │
│          │ ┌ FOCUS PANEL (whatever block is selected) ───────────────────────────────┐ │
│          │ │ [icon] KEYS SOUND / Grand Piano · Piano, sampled · [Change instrument ▾]│ │
│          │ │ LEVEL │ SOUND (3 knobs)  │ INTO THE SHARED EFFECTS (3 pipes) │ HOW IT PLAYS│ │
│          │ │ ▸ Advanced  Pan Center · Width 100% · … (summary)    [all at default]    │ │
└──────────┴─┴─────────────────────────────────────────────────────────────────────────┴─┘
  61-key keyboard with coloured range bars (Keys / Pad / Bass) + output meter
```
- **Clicking a map block** fills the focus panel. There is one panel type per block kind: *Sound* (4 slots), *Drone*,
  *Keyboard* (input and routing), *Space / Echo / Chorus / Tape* (shared effects), and *Master*.
- **Two disclosure levels at most:** the panel, then *Advanced* (which slides up inside the panel; see
  edit-advanced.png). The current "More for Keys → Rhodes settings (2)" path is three levels.
- **At 1024×700** (edit-1024.png) the library collapses to a "☰ Songs" button, the map blocks drop their level line,
  and the panel hides its helper sentences. Everything still fits with no scrolling. Today Edit at 1024 is
  "barely usable" (ux M9).

### Perform (perform.png)
The layout is unchanged: wheel strip, 4 strips, drone, notes, keyboard, PANIC. The changes are small:
1. **Each strip gains an instrument icon and a 2×2 block of modifier chips**: *Space · Echo · Chorus · Octave*.
   A chip is lit in the slot colour when its value isn't zero, and a thin bar along its bottom shows the amount. Unused
   chips are quiet outlines. **Tapping a chip opens a popover containing the same knob as Edit** (perform-chip.png),
   plus a link to change the space. These are not on/off toggles, because a true toggle would need a remembered
   "previous value", which is new state (research caveat).
2. The **Space / Vibe selects become two pills: Space and Echo.** Each shows the preset name, or "Custom ≈ Quarter"
   (the closest preset) instead of a dead "Custom". Tapping a pill opens the preset chips. The **Vibe** presets, which
   are a Perform select today, become the first chip row inside the Space pill's popover (not mocked).
3. The **drone block follows Sunday Keys' Tonic layout:** mode, key, major/minor and level, plus two small character
   knobs (**Brightness, Movement**) that already exist as `drone.brightness/movement`. The My Pads folder line keeps
   its place at the bottom.
4. **Key-range bars** sit above the on-screen keyboard: thin, in slot colours.
5. A **Quick** button (sliders icon) sits in the top bar beside the gear.

### The Perform "quick settings" answer (quick.png)
A **non-modal drawer** on the right. Perform stays live and playable underneath, and the drawer never covers PANIC,
Fade out or Lock. It is split by *scope*, so it's obvious what gets saved where:

| Section | Contents (all existing) | Scope |
|---|---|---|
| **This song** | Space preset chips (Dry … Ambient Wash), Echo preset chips (No Echo … Ambient Trails). The current preset is filled; the closest match to a custom value is dashed ("≈ Quarter Note"). | saved with the song |
| **Every song** | Touch (Light/Normal/Heavy/Fixed = `settings.velocitySens`); Sustain pedal: a live pedal light plus *Reversed* (`pedalInvert`), which is also the "test your pedal" step; Mono output; Keyboard picks songs (`programChange`) | this Mac |
| **If something's wrong** | Sound status + latency, **Restart audio** | — |
| footer | "Read-only while Perform is locked" · **All settings** (opens the existing modal) | — |

This is Sunday Keys' pattern: name and state visible, with numbers one level down. It is limited to the ~8 things
that actually go wrong or get changed mid-service (research D7, ux M5/B1). Perform-lock freezes the drawer, the same
as every other Perform control.

---

## 3. The smart knobs: how three words map to existing params (no new state)

Each knob is a **view of exactly one existing parameter**. There are no multi-param macros, no new stored values,
and moving a knob is the same `store.set(path, v)` as today. The label and the word ("Bright", "Slow") come from a
rule based on which params the instrument has:

| Knob | Maps to (first one that exists) | Words (5 buckets of the normalised value) |
|---|---|---|
| **Brightness** | `params.cutoff` (synth pads, strings, bass) → `params.tone` (sampler, soft-keys "Brightness") → `slots.i.eq.high` (organ, anything else) | Dark · Mellow · Natural · Bright · Sparkly |
| **Warmth** | `slots.i.eq.low` (every instrument; bipolar, fills from 12 o'clock) | Thin · Lean · Neutral · Full · Big |
| **Fade-in** *or* **Ring-out** | `params.attack` if the instrument's default attack ≥ 0.1 s (pad-like) → labelled **Fade-in**; otherwise `params.release` → labelled **Ring-out** | Instant…Swell / Short…Long |

Examples: Grand Piano = Tone / Lows / Release. Warm Pad = Cutoff / Lows / Attack. Sub Bass = Cutoff / Lows / Release.
Organ = Highs / Lows / Release.

Whatever a knob shows is removed from that sound's Advanced list, and Advanced says so ("Cutoff and Attack live on
the Brightness and Fade-in knobs"). Double-click resets to the PARAMS default, as today.

---

## 4. Nothing lost: where every existing feature lives

| Feature | Today | In A |
|---|---|---|
| Slot instrument picker (grouped) | select in slot card | **Change instrument ▾** in the Sound panel header. It is the same grouped list, with a group icon per row. Empty slot: map block "+ Add sound" |
| Slot gain | slider | Vertical **Level** fader in the Sound panel (same component as Perform) plus the map block's level line |
| Mute | button | Under the Level fader (Edit); strip Mute (Perform) |
| Pan, Width | More → sliders | **Advanced → Mix** |
| EQ low / high | More → Lows/Highs | Lows = **Warmth** knob; Highs = Brightness knob (organ) or Advanced → Mix |
| Octave | More | **How it plays → Octave** (−2…+2 chips); Perform chip "Octave" |
| Transpose (per slot) | More | Advanced → Playing |
| Split / key range | two note inputs "C-1 / G9" | **How it plays → range slider + Split…**; coloured bars above the Edit keyboard (drag the ends) |
| Sustain | toggle | **How it plays → Sustain pedal** switch |
| Mono (lowest/highest) | select | Advanced → Playing → Voices (Poly / Mono low / Mono high) |
| Velocity curve | select | Advanced → Playing → Touch |
| Pitch bend enabled | toggle | Advanced → Playing |
| Sends (reverb/delay/chorus) | 3 sliders | **Into the shared effects** pipes (Space/Echo/Chorus) + map dots; Perform chips |
| Per-instrument params | "Rhodes settings (n)" | Smart knobs (2–3 of them) + **Advanced → "<Instrument> engine"** (the rest) |
| Drone mode / key / major-minor / gain | Perform block + Edit card | Perform block (unchanged); Edit: **Drone** map block → panel with the same key grid, Level fader |
| Drone brightness / movement | Edit sliders | Knobs on the Perform drone block *and* Drone panel |
| Drone width, key fade | Edit sliders | Drone panel → Advanced |
| Drone chord-follow, continue, minor→relative-major file | toggles | Drone panel ("How it plays" column); chord-follow + continue also on Perform |
| Space / Echo / Vibe presets | selects ("Custom") | Space/Echo **preset tiles** in their panels (edit-space.png); **Vibe** pill on the map title row and as a chip row in the Space/Echo panels; Perform: Space/Echo pills (Vibe chips inside the Space pill's popover) + Quick drawer (Space/Echo) |
| Reverb size / damp / predelay / level | slider card | Space panel → **Fine-tune** knobs (Size, Darkness, Pre-delay) + Level in the header |
| Delay time / sync / feedback / tone / ping-pong / level | slider card | Echo panel: preset tiles + Fine-tune (Time or Sync chips, Repeats, Tone, Ping-pong switch) + Level |
| Chorus rate / depth / level | card | Chorus panel: Rate, Depth knobs + Level; "who's sending in" pipes |
| Lofi (amount, wow, flutter, crackle, bits, tone, saturation) | card | **Tape** block → panel: Amount knob (block shows "off" at 0) + the other six in Advanced |
| Master EQ (low/mid/high), Glue (comp), master volume | cards | **Master** block → panel: Volume fader, Tone (3 knobs), Glue knob |
| Easy Transpose (Play In / Hear In / octave / minor) | card | Song header chip **"Key D · you play D"** → opens the **Keyboard** panel at Easy Transpose |
| Wheel / expression / CC7 / bend routing, bend range, swell time | "Wheels & pedals" card | **Keyboard** block → panel: "Mod wheel controls ▾", "Expression ▾", "Volume knob ▾", "Pitch-bend wheel ▾ + range", "Swell time". The block reads "wheels" |
| Tempo + tap | header | Song header chip (BPM + Tap) |
| Notes | collapsible card | Header chip **Notes** → a popover editor; Perform notes column unchanged |
| Reset to factory | header button | Header (ghost button). The panel footer badge says "all at default" / "changed from factory" |
| Songs / setlists (add/dup/delete/reorder, factory browser, import/export) | left column | Same left column (calmer: key badges, accent bar on the current song); a "☰ Songs" drawer at 1024 |
| Recording, master, status | top bar | Unchanged |
| Settings modal (latency, device, MIDI in, Learn, pad folder, My Samples, backups…) | gear | Unchanged. The ~8 live items are *also* in Quick |
| Perform: wheel strip, Swell, setlist strip, Next, chord, Fade out, PANIC, Lock, Revert | — | Unchanged |

---

## 5. Open questions / honest limits
- **The "lights" come from held notes, not audio.** A block is lit when a held note falls in its range and the slot is
  unmuted. Reverb tails and the pedal-sustained decay don't light anything. Per-slot audio meters would need engine
  analysers, which is out of scope.
- **"Custom ≈ closest preset"** is new *presentation* logic: a nearest-preset distance over the preset's own params.
  It stores nothing.
- The **word buckets** ("Bright", "Slow") are my own copy and haven't been tested with users. The number is always
  shown next to the word.
- At 1024 the Quick drawer covers the drone block (quick-1024.png). That's acceptable for a drawer you open briefly,
  but it's a trade-off.
- The map is a **picture of the real topology** (SPEC §3.1): sends → reverb/delay/chorus → lofi → master, with the
  drone dry except its fixed internal send. If the engine topology changes, the map has to change with it.
- There is no instrument *artwork*, only one line icon per group. Real illustrations would be new assets.
