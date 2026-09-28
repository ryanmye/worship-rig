# Worship Rig — UX research: "what am I changing?" and quick settings in Perform

Scope: presentation / information-architecture only. Same features, same data model (Song = 4 slots + fx + drone +
routing), same components (fader, knob, toggle, segmented, select, stepper, keyGrid, miniKeyboard, pianoKeyboard,
meter, chordReadout, wheelStrip, setlistStrip). Target: volunteer keys player, non-technical, MacBook beside a keyboard,
sometimes low light.

Evidence tags: **[src]** = stated in a fetched source (URL in §6). **[shot]** = seen in the repo screenshots
(`test/phase2/ui-edit/screenshots/app-1440x900-edit*.png`, `ui-core/screenshots/perform*.png`,
`reviews/ux-shots/1440x900-10-edit-scrolled-bottom.png`). **[infer]** = my reasoning, not verified with users.
Sunday Keys / MainStage-template layout details are partly from support docs and blog text only; I could not view
their screenshots or videos, so exact on-screen arrangement is **partly unverified**.

---

## 1. Diagnosis — why Edit feels "noisy, all dials, disconnected"

| # | Cause | Evidence |
|---|---|---|
| D1 | **Edit does not look like the thing you play.** Perform = 4 vertical coloured channel strips in a row (+ drone block). Edit = song header, then a 2×2 grid of horizontal cards, then drone at the bottom, FX in a separate right column. The user's mental model built in Perform ("Keys strip, Pad strip…") is thrown away on switching views. | [shot] perform.png vs app-1440x900-edit.png |
| D2 | **One control shape for everything.** Level, Pan, Reverb send, Echo send, Chorus send, Width, Lows, Highs, Reverb size/darkness/pre-delay, Echo time/repeats… are all the same horizontal slider with the same white thumb and the same visual weight. Nothing says "this one matters", "this one is a tone tweak", "this one is plumbing". | [shot] app-1440x900-edit.png: Keys "More" open shows 7 identical sliders + 2 note inputs; right column 4+4 identical sliders |
| D3 | **Two things called "Reverb" with no visual link.** Slot card: "Reverb 45%" (send). Right column: "REVERB +0.4 dB · size 72%" (the shared room). A novice can't tell that the slot knob means "how much of Keys goes into the room" and the right-hand one "what the room sounds like / how loud". Same for Echo and Chorus. The signal flow (slot → sends → shared FX → master) is nowhere drawn. | [shot]; params.js `slots.<i>.sends.*` vs `fx.*.returnGain` |
| D4 | **Values are engineering units, not musical outcomes.** "+0.4 dB · size 72%", "−1.9 dB · 500 ms", "0.35", "C-1 / G9", "Standard". Vibe/Space/Echo pickers — the musical layer — read "Custom" on factory songs, so the friendly layer looks broken and pushes users down to raw sliders. | [shot] Opener shows Vibe/Space/Echo = Custom |
| D5 | **No "what's sounding" feedback in Edit.** Perform has per-slot fader fill + wheel indicator; Edit has only a master meter bottom-right. No per-slot activity, the bottom piano does not show slot key ranges (range is two text inputs), so you can't see *which* sound a key triggers. | [shot]; key range is `LOWEST C-1 / HIGHEST G9` text |
| D6 | **Flat hierarchy of cards.** Setlist/Songs, Notes, Easy Transpose, Tempo, 4 slots, Wheels & pedals, Key drone, Vibe/Space/Echo, Reverb, Echo, Chorus, Lofi, Tone, Glue, Master: ~17 same-looking bordered panels with same-size uppercase headers. Everything is a peer. | [shot] app-1440x900-edit-collapsed.png |
| D7 | **Settings you'd reach for mid-service are in a modal.** Touch (velocity), Sustain "Reversed" + Test pedal, Mono output, Restart audio, Keyboard picks songs — all behind the gear in a 2-column modal, not reachable from Perform without leaving it. Perform only has Space/Vibe selects (and they read "Custom"). | [shot] app-1440x900-settings.png, perform.png |

Collapsed Edit (app-1440x900-edit-collapsed.png) is already fairly calm — the noise is mostly **what appears on
expand** (D2/D3) and the **mismatch with Perform** (D1). So the fix is less "hide more" and more "change what the
expanded state looks like and where it sits". [infer]

---

## 2. Pattern catalog (from the field)

### P1. Colour-coded sections, one per sound, fader-first — Sunday Keys MainStage template
- Four colour-coded sections numbered 1–4 left to right: **orange 1, green 2, blue 3, purple 4** — literally Worship
  Rig's slot colours. Each has a title, a level meter, a **left fader that is "always a volume control for that
  sound"**, then **"Modifiers"**: sound-shaping controls such as reverb, delay, a tone (brighter/darker) control,
  chorus, octave. A fifth "Extra" section is simplified (label + meter + horizontal fader). Tonic pad panel mid-left;
  output section = master, panic, tap tempo, mono. [src: SK-basics]
- Modifiers named in patch demos: Reverb, Shimmer, Delay (1/4, 1/8), Octave, Tone, "Del Level" knob — i.e. **a few
  musical words per sound, toggled "at the press of a button"**. [src: SK-piano]
- Patch notes: "click the section text to view a brief description of the sound, its mod and pitch mappings". Clicking
  a section's text label or a modifier label shows a quick description. [src: SK-walkthrough, SK-layered]
- **Relevance:** this is the exact mental model the user referenced. Edit's slot = a Perform strip + its modifiers.
  Worship Rig already has the ingredients: per-slot Level (fader), Reverb/Echo/Chorus sends, Lows/Highs (tone),
  Octave, Mute.

### P2. Engage/Bypass toggle on the main screen, parameters one tap deeper — Sunday Keys app
- Effects live **per Sound**, up to 3 audio + 1 MIDI FX; on the main screen each shows an **"Engage/Bypass button to
  the left of the Effect name"**; tapping the name opens that effect's parameter menu ("Confirm" to keep). [src: SK-fx]
- Sound Settings (ADSR, filter, EQ, compressor, voice count, transpose, fader range) are behind a separate "sliders"
  button, not on the main screen. [src: SK-sounds]
- Tonic pad: quick = **Engage/Bypass, Brightness, Shimmer, key**; deeper (tap preset name) = preset, fade times, pan.
  "Patch Lock" stores Tonic state per patch; by default Tonic ignores patch changes. [src: SK-tonic]
- Snapshots store only fader positions + FX engaged state + mod wheel; **parameter edits are not snapshotted**.
  Button states: saved+selected light blue, saved gray, empty dark gray. [src: SK-snap]
- Effects/Notes toggle: one pane swaps between FX and notes. [src: SK-additional]
- Settings menu holds audio device/buffer, MIDI inputs, performance prefs; only tempo/metronome surface in the main UI.
  [src: SK-settings]
- **Relevance:** the "toggles" the user remembers = named on/off chips on the performance screen, with the continuous
  value one level down. Two-level structure: *name + on/off* visible, *numbers* behind the name.

### P3. Physical section panel, state always visible — Nord Stage 4, Yamaha CP88
- Nord: three independent engines (organ/piano/synth) each with its own panel area, per-layer control, **dedicated
  effects section per layer**, LED zone indication between keyboard zones, OLED for program + synth. [src: BTK-nord]
- Yamaha CP88: panel sections **colour-coded (piano yellow, EP red, sub-section green)**; "actual buttons and knobs
  dedicated to single sound adjustment functions"; "the functional control panel constantly shows the state of each
  knob and switch"; two-LED buttons for glanceable state. [src: yamaha-cp]
- **Relevance:** effects live *inside* the sound's section, so "what am I changing" is answered by position. The
  panel doubles as the status display — no separate summary needed.

### P4. Few musical macros + a picture — GarageBand Smart Controls, Arturia Analog Lab, Spitfire LABS
- Smart Controls map "the most important parameters to a simple panel"; controls are labelled in musical terms (Tone,
  Ambience, Reverb, Chorus, Drive; for EP: tone/tremolo/chorus etc.); "tone controls … on the left, effects on the
  right". [src: apple-sc, audeobox]
- Analog Lab: instrument image + **4 macros (Brightness, Timbre, Time, Movement)**; Stage view organises presets/FX
  into songs/playlists; full instrument editor is a separate, deeper view. [src: arturia, arturia-forum]
- LABS: "clutter-free interface … sliders for expression and dynamics" (typically 2–3 controls). [src: musictech-labs]
- Pianoteq: main panel is preset + a few performance controls; deep physical-model editing is in separate panels
  opened from the instrument picture; the model has far more params than the UI exposes. [src: pianoteq]
- **Relevance:** per-slot default view should be ~2–4 named, musical controls with a recognisable identity (the
  instrument name big, slot colour), not 9 sliders.

### P5. Signal flow drawn left→right with on/off per device and fold — Ableton device chain, Gig Performer wiring
- Ableton: "Signals in a device chain always travel from left to right"; every device has an on/off switch in its
  title bar; devices can be **folded** to their title bar; meters between devices show signal at each stage.
  [src: ableton-fx]
- Ableton Racks: up to 16 Macros (8 shown) each mapped to many params, custom names/colours; **Macro Variations** =
  stored macro states; **Key Zone Editor** draws each chain's key range as a bar over the note range. [src: ableton-rack]
- Gig Performer: a rackspace = plugins wired together + **panels of widgets** for live use; variations = same
  wiring, different widget values; shape widgets give "logical sections and different colors". [src: gp-panels,
  gp-var, gp-performer]
- **Relevance:** a *tiny* flow diagram (4 slot chips → Room / Echo / Chorus → Master) would resolve D3. Folding by
  title bar with a one-line value is what Edit already does; the missing part is *direction* and *belonging*.

### P6. Key ranges as coloured bars above the keyboard — Sunday Keys app, MainStage, Ableton, Komplete Kontrol
- Sunday Keys: "a Sound's Layer Range represented by a colored bar just above the on-screen Keyboard"; drag the ends,
  or tap the low/high box and play a note. [src: SK-keyboard]
- MainStage: layer = coloured bar in the workspace; drag its edges to set range. [src: SK-layer-range]
- Komplete Kontrol: Light Guide lights key zones/splits in colour on the keyboard itself. [src: NI-kontrol]
- **Relevance:** Worship Rig already renders a 61-key `pianoKeyboard` at the bottom of Edit and has `miniKeyboard`
  range selectors. Drawing the 4 slot ranges as coloured bars over the existing bottom keyboard replaces "C-1 / G9".

### P7. Colour → control correspondence — Teenage Engineering OP-1
- "The four color encoders are related to the graphical interface … A green graphical element or text hints that the
  green encoder will change its value." [src: op1]
- **Relevance:** Worship Rig's 4 slot colours should appear on *every* control that belongs to a slot (sends, tone,
  range bar, flow chip), and **only** there. Shared/global controls neutral (ux.md M4 already asks for this).

### P8. Separate "live" layout that hides editing — MainStage, Cantabile, Gig Performer
- MainStage: Edit / Layout / Perform modes; Perform shows the workspace full-screen. [src: mainstage-modes]
- Cantabile **Live Mode** "hid[es] all the unnecessary editing tools"; a **Controller Bar** with "large buttons for
  … tapping a tempo, loading next or previous songs … and transpose changes"; a **Ticker Bar** (setlist as a
  horizontal list); Show Notes that update per song. [src: cantabile3]
- **Relevance:** Worship Rig already has this split. The gap is a *small, curated* set of settings that survive into
  Live — Cantabile's Controller Bar / Sunday Keys' output section — not the whole Settings modal.

### P9. Principles
- **Progressive disclosure (NN/g):** show the few most important options first; "the very fact that something appears
  on the initial display tells users that it's important"; **>2 disclosure levels hurts usability**; the trigger label
  must say what's behind it. [src: nng-pd]
- **Direct manipulation (NN/g, Shneiderman):** "continuous representation of the object of interest", physical,
  incremental, reversible actions whose effect is immediately visible. [src: nng-dm, shneiderman]
  → Here the *object of interest* is "the Keys sound" or "the room", so controls should sit on/inside a picture of
  that object, and the picture should change when the value changes (fill, glow, range bar, flow line thickness).

---

## 3. What this implies for Worship Rig (no new features)

### 3a. Edit — fix "noisy" and "disconnected"
1. **Mirror Perform's geometry.** Four slot columns side by side in slot colour (like Perform's strips / Sunday Keys'
   four sections), drone as a 5th column/block in the same position as in Perform. Edit becomes "Perform with the
   lids open", not a different page. (P1, P3) [infer: strongest single fix for D1]
2. **Three tiers per slot, max two disclosure levels** (P2, P4, P9):
   - Tier 1 (always): instrument name big + picker, **Level fader** (same vertical component as Perform), Mute,
     per-slot meter/activity. 
   - Tier 2 (always, compact): **musical chips/knobs** — "Room" (reverb send), "Echo" (delay send), "Chorus", "Tone"
     (Lows/Highs pair or a single tilt display), "Octave −1/0/+1". Knob component, slot-coloured. These are the
     Sunday Keys "modifiers".
   - Tier 3 (behind "More for Keys"): Pan, Width, exact Lows/Highs, Transpose, Voices, Velocity, Sustain, Pitch bend,
     instrument-specific params. 
3. **Make sends visibly flow into the shared FX.** Label the slot knob "→ Room 45%" and render the shared FX as a
   "Room / Echo / Chorus" row *downstream* of the four slots (bottom or right), each showing which slots feed it
   (four coloured dots whose size = send). Clicking a slot's Room knob highlights the Room block. (P5, D3)
4. **Shared FX: preset first, sliders second.** Space and Echo as **segmented chips** (Dry · Room · Stage · Hall ·
   Cathedral · Wash; No Echo · Slapback · ¼ · Dotted ⅛ · Trails) using the existing `SPACE_PRESETS`/`ECHO_PRESETS`
   and `segmented`; sliders only under "Fine-tune". If the song is "Custom", show "Custom (closest: Stage)" rather
   than a dead select. (P4, D4) — *uses existing presets; matchPreset already exists.*
5. **Draw key ranges on the bottom keyboard** as four coloured bars above `pianoKeyboard`; low/high set by dragging
   bar ends or "click then play a note" (Sunday Keys pattern). Keeps `lowNote/highNote` params. (P6, D5)
6. **Words before numbers.** Summaries in musical language ("Big hall, quiet", "Dotted ⅛ echo") with the dB/ms as
   secondary grey text. Units stay available on hover/focus. (D4)
7. **Visual weight hierarchy:** one control shape per role — vertical fader = volume only; knob = colour/space
   amount; segmented chips = choose-one; toggle = on/off. Right now everything is the horizontal slider. (D2)
8. **Global/song-meta (Setlist, Tempo, Notes, Transpose, Wheels & pedals) out of the sound area**: a song header
   strip and the left library column. They are not "the sound", so they shouldn't be peers of the slot cards. (D6)

### 3b. Perform — quick settings ("like Sunday Keys' toggles")
Candidates, all existing params/settings; pick a small set (≤ 6–8) so Perform stays glanceable:
- **Per-slot modifier chips under each strip** (Room / Echo / Octave): show state (lit when send > 0 / octave ≠ 0);
  tap opens a small popover with the knob. *Caution:* a pure on/off toggle for a continuous send needs a remembered
  "previous value" → that is **new state** (a feature). Presentation-only alternatives: (a) chip = popover with the
  existing knob; (b) chip cycles between existing preset values (e.g. Octave −1/0/+1). [infer]
- **Space / Echo preset chips** (already has Space/Vibe selects; convert to chips or a popover of chips). Respect
  Perform-lock (already frozen per perform.js header).
- **Quick panel ("Quick settings" drawer / Controller Bar)** pulling from Settings: **Touch** (Light/Normal/Heavy/
  Fixed), **Pedal reversed + Test pedal**, **Mono output**, **Restart audio**, **Keyboard picks songs**, Latency
  (read-only + link). These are exactly the things that go wrong mid-service (ux.md M5 pedal, B1 stall). (P8, D7)
- **Drone block = Tonic pattern:** Engage (Off/Synth/My Pads), key grid, Level, plus 2 character knobs (Brightness,
  Movement — both exist as `drone.brightness/movement`) on the surface; Width/Key fade/options one level down. (P2)
- **Notes/FX swap** in one pane (Sunday Keys Effects/Notes toggle) to save space at 1024 px. (P2)

### 3c. Keep consistent across views
- Same slot colour tokens on every slot-owned control (P7); neutral for shared FX and master.
- Same component for the same param in both views (Level = vertical fader everywhere; Room = knob everywhere).
- Same names everywhere: "Room" vs "Reverb" vs "Space" — pick one user-facing word per concept (ux.md already flags
  "My Pads"/"Pad files").

---

## 4. Anti-patterns to avoid
- Surfacing *every* param in Perform (Gig Performer/MainStage let you; Cantabile/Sunday Keys deliberately don't).
- More than two disclosure levels (NN/g) — e.g. Edit section → "More for Keys" → "Rhodes settings (2)" is already 3.
- A bare on/off toggle for a continuous value without remembering the old value (silent data loss or a new feature).
- Colour meaning two things (accent yellow = selected *and* FX sliders next to Keys orange) — ux.md M4/H2.
- Signal-flow diagrams that are decorative/large; it should be small and double as a status display (meters/lit).
- Hiding the fader in Edit behind a different widget than Perform (breaks recognition).
- Making Settings items editable in Perform *without* Perform-lock covering them (Touch/pedal changes mid-song).
- "Custom" as a dead end label on factory songs.

---

## 5. Open questions for proposers [infer]
- Does a 4-column Edit fit 1024×700 with the library column? Likely needs the library to collapse to a drawer.
- Should Perform quick settings be per-song (song patch) or global (settings)? Touch/pedal/mono are global today;
  mixing scopes in one panel needs a visible "this song / all songs" label.
- Snapshots are out of scope (new feature), but Sunday Keys' main quick-change mechanism is snapshots; don't
  accidentally design toward it.

---

## 6. Sources (fetched unless marked "search only")
- SK-basics — Sunday Keys for MainStage 2021: Basics — https://support.sundaysounds.com/article/3294-sunday-keys-for-mainstage-2021-sunday-keys-basics
- SK-layered — Using the Layered Worship Patches — https://support.sundaysounds.com/article/3293-sunday-keys-for-mainstage-2021-using-the-layered-worship-patches
- SK-walkthrough — MainStage template walkthrough — https://sundaysounds.com/blogs/news/sunday-keys-mainstage-template-overview-walkthrough
- SK-piano — Worship Piano patch demo — https://sundaysounds.com/blogs/news/worship-piano-patch-sunday-keys
- SK-overview — App Overview — https://support.sundaysounds.com/article/3146-app-overview---what-you-see-on-screen
- SK-additional — Additional Controls — https://support.sundaysounds.com/article/3135-additional-controls
- SK-fx — Effects — https://support.sundaysounds.com/article/3140-effects
- SK-sounds — Sounds — https://support.sundaysounds.com/article/3141-sounds
- SK-keyboard — On-Screen Keyboard — https://support.sundaysounds.com/article/3134-on-screen-keyboard
- SK-tonic — Tonic (app) — https://support.sundaysounds.com/article/3136-tonic
- SK-tonic-ms — Tonic in MainStage — https://support.sundaysounds.com/article/3298-sunday-keys-for-mainstage-2021-using-the-tonic-pad-player
- SK-snap — Patch Snapshots — https://support.sundaysounds.com/article/3139-patch-snapshots ; blog https://sundaysounds.com/blogs/news/patch-snapshots-in-sunday-keys-the-complete-guide-for-worship-keys-players
- SK-settings — Settings — https://support.sundaysounds.com/article/3194-settings
- SK-app — App page / App Store — https://sundaysounds.com/pages/sunday-keys-app ; https://apps.apple.com/us/app/sunday-keys/id1615360535
- SK-layer-range — MainStage layer range — https://support.sundaysounds.com/article/3029-how-to-adjust-the-layer-range-of-a-mainstage-patch-create-a-keyboard-sound
- mainstage-modes — Apple MainStage guide — https://support.apple.com/en-au/guide/mainstage/mstged5131fb/mac
- BTK-nord — Between The Keys, Nord Stage 4 review — https://www.betweenthekeys.com/nord-stage-4-review/
- yamaha-cp — Yamaha CP88/CP73 design insight — https://www.yamaha.com/en/tech-design/design/insights/id_115/
- apple-sc — GarageBand Smart Control types — https://support.apple.com/en-md/guide/garageband/gbndf553bab8/mac ; overview https://garageband.skydocu.com/en/use-smart-controls/overview/
- audeobox — Smart Controls guide — https://www.audeobox.com/learn/garageband/garageband-smart-controls/
- arturia — Analog Lab overview — https://www.arturia.com/products/software-instruments/analoglab/overview
- arturia-forum — Analog Lab macros — https://forum.arturia.com/t/analog-lab-pro-macros-performance-macros-controlling-parts-macros/3756
- musictech-labs — Spitfire LABS — https://musictech.com/products/spitfire-audio-labs-software-instrument-plugin/
- pianoteq — Pianoteq manual — https://www.modartt.com/user_manual?product=pianoteq
- NI-kontrol — Kontrol S MK3 manual — https://docs.native-instruments.com/online-guides/kontrol-s-mk3-manual/en/welcome-to-kontrol-mk3
- ableton-fx — Ableton manual, Instruments and Effects — https://www.ableton.com/en/manual/working-with-instruments-and-effects/
- ableton-rack — Ableton manual, Racks — https://www.ableton.com/en/manual/instrument-drum-and-effect-racks/
- gp-panels — Gig Performer panels & widgets — https://gigperformer.com/working-with-panels-and-widgets
- gp-var — Gig Performer rackspaces & variations — https://gigperformer.com/docs_5_0/UserManualOnline/rackspaces-and-variations.html
- gp-performer — Gig Performer Performer View — https://gigperformer.com/docs/userguide/performerview.html
- cantabile3 — Cantabile tour — https://www.cantabilesoftware.com/cantabile3/ ; racks https://www.cantabilesoftware.com/guides/racks
- camelot — Camelot features — https://audiomodeling.com/camelot/features/ (little UI detail)
- op1 — OP-1 layout guide — https://teenage.engineering/guides/op-1/original/layout
- nng-pd — NN/g Progressive Disclosure — https://www.nngroup.com/articles/progressive-disclosure/
- nng-dm — NN/g Direct Manipulation — https://www.nngroup.com/articles/direct-manipulation/
- shneiderman — Direct Manipulation (search only) — https://www.cs.umd.edu/~ben/papers/Shneiderman1997Direct.pdf
- Elektron — Digitakt manual (search only, not fetched) — https://www.elektron.se/wp-content/uploads/2026/09/Digitakt-User-Manual_ENG_OS1.53_260909.pdf
