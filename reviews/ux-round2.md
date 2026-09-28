# UX round 2: the implemented H-v2 (Perform, Quick, Edit, Tone EQ, Settings)

The earlier critics reviewed mockups. This review drives the real app.

**Setup.** `server.js` ran on a free port, with headless Chromium (`--autoplay-policy=no-user-gesture-required`) and the
'midi' grant. States were driven through `window.__rig`, and the song was factory "Sunday Pad + Piano". Pages were
measured at 1440×900, 1024×700, 1280×800, 1366×768, 1440×860 (a realistic Mac app window) and 1512×900. Screenshots are
in `reviews/ux2-shots/` (`pNN` Perform, `eNN` Edit, `sNN` Settings). They were compared with `design/H-v2/*.png` and the
H-v2 promises in `design/OPTIONS.md`.

**How the numbers were measured.**
- Contrast is WCAG 2.x. The text colour comes from computed styles, composited over every ancestor's background and
  the cumulative opacity. Gradients use their first stop.
- Hit targets are the bounding rects of every visible interactive element.
- Luma is the mean greyscale value of the screenshot pixels.

The scripts are in the session scratchpad and are not in the repo.

**Tags.** **[measured]** means a number from the running app. **[seen]** means read off a screenshot. **[code]** means
read in the source. **[est.]** means an inference I have not checked. The app logged 0 console errors across all runs.

**Things this run cannot show.**
- This box has no MIDI device, so the top bar reads "MIDI Blocked".
- The 42 ms latency is the container's, not the Mac's.
- The factory song is in C and has no Bass. The mockup has D and a Bass strip, so strip counts differ.
- Nothing was run under Electron on macOS.

---

## 1. Summary

**Kept.** The H-v2 promises largely hold in the build:
- ON tiles vs OFF tiles measure mean luma **158 vs 49**; the mockup measured 155 vs 53.
- The drone tile measures **201 on vs 54 off**.
- The step panels have 5 steps, an "as loaded" mark, and "Starts on your next note".
- Also in place: Song's own, Sing it in…, the Quick sheet exactly over the header and setlist, lock HOLD badges, the
  full-width stalled banner, the tabbed Edit with the sentence title, word sliders and no knobs, and Show wiring with
  real numbers.

**Built better than the mockup:**
- The round-3 drone fixes are in.
- Revert says "nothing changed" instead of showing "0".
- Touch and Response use the same words (Light/Normal/Heavy/Fixed).
- There are level meters and keyboard range bars.

**New problems** are all outside the two sizes the mockup was drawn at:
1. **Window sizes between the two breakpoints.** Perform at 1280–1400 px wide is visibly broken: clipped title,
   truncated chips, top-bar overlap, a clipped drone card. A realistic Mac window of 1440×~860 loses 40 px of fader
   throw.
2. **Persistent banners** ("not saving", "second window") take 58–66 px from the stage. At 1024 that leaves **83 px of
   fader throw**, down from 141.
3. **Toasts cover the header Space/Echo chips** and the Faded chip. Taps pass through toasts, so they land on chips
   you can't see.
4. **The Effects tab's preset chips truncate at 1280–1440** ("Ro…", "H…", "Son…").
5. **One custom room has three names:** "Custom", "custom" and "Song's own", and the sentence says "into the Space".

The stage-critical contrast misses are few: Restart sound **3.27:1**, PANIC "Esc" **3.72:1**, and the chips on an OFF
strip at **1.9–3.3:1**.

---

## 2. Implemented vs mockup: deviations, and whether each is better or worse

### Perform

| Where | Mockup | Build | Verdict |
|---|---|---|---|
| Fader throw | 250 px (1440) / 143 px (1024) | **257 / 141** [measured]; 2 chips 309 / 189 | ✓ same |
| ON/OFF tiles | solid colour vs grey struck-through, strip at 36 % | same; luma 158 vs 49 [measured on p04] | ✓ promise kept |
| Drone card | "DRONE D major" title; cream fill on key/Major/Synth | "Key & drone" title; drone ON tile is the only fill; key/Major/Synth outline-only; OFF tile grey struck-through with a dashed key outline (p05) | **Better**: round-3 fixes 1 and 2 are in, and "kill the drone" reads at a glance (201 vs 54) |
| Drone OFF | not mocked | **Follow chords disappears** while the drone is off, so "Continue across songs" jumps up (p05) | Worse (small): the layout moves under the finger; dim it instead of removing it |
| Revert | "↺ Revert · ● 2 changed" | "1 changed" with a dot; **"nothing changed"** greyed at 0 | Better (clearer), but see the contrast notes |
| Header chips at 1440 | Dry…Cathedral, each ~78–120 px | narrower chips; Space gets **Song's own** when the room matches no preset | ✓ fits at 1440; **truncates at 1280** (see §3) |
| Level meters | a meter beside each fader | a 4 px bar in the fader track, moving with the note (p02) | ✓ |
| Keyboard range bars | per slot | per slot, grey when OFF | ✓ |
| Chord readout | shows the held chord | shows the held chord; **after release it keeps the last *partial* chord dimmed**: the D-major release in p03 left "A" | Worse, see §4 G1 |
| "EXPERIMENTAL" tag on Follow chords | absent | present in Perform and Edit | Neutral to worse: it adds noise on the stage card; Edit alone would do |
| Pad folder row | "My Pads folder: Worship Pads · Change…" | "My Pads: no folder chosen · Choose folder…"; clipped at 1280 and with a banner | see §3 |
| Empty slot | one collapsed EXTRA column | EXTRA and BASS both collapse (this song has no bass); the "+" is **34×34** | OK; the "+" is below 44 |
| Stalled audio | not mocked | full-width red banner with "Restart sound" (the UX B1 fix) | Better than round 1, but the button contrast is 3.27 (§5) and the stage shrinks (§3) |
| Faded out | not mocked | an amber "Faded — play to resume" chip over the chord readout, and the Fade out button says the same (p22) | **Better**: the state is unmistakable |

### Quick sheet (p07, p13, p21)

- The layout, the sections and the lock note match the mockup.
- **Worse:** Tempo with no song tempo shows a 26 px "——" bar before "BPM". It reads like an empty slider. Mockup: "72".
- **Worse:** under lock the whole "This Mac" group is dimmed, **including the PEDAL DOWN lamp**. That is a live status
  readout for soundcheck, not a control (p21).
- At 1024 the "press it: light on?" hint is dropped, so "○ PEDAL DOWN" with the lamp off reads as a claim that the
  pedal *is* down.

### Edit

| Where | Mockup | Build | Verdict |
|---|---|---|---|
| Setlist column | a list plus New / Factory / Library | adds **search** and **New · Rename · Delete** for the setlist (28 px tall); collapses to a "Songs" button at 1024 | Better for real use; the small targets are fine for Edit |
| Sentence | "…a little into the **Hall**…" | with a custom room: "…a little into the **Space**…" (e20) | **Worse**: "the Space" is an internal noun; use "into the song's own room" |
| Where it plays | mini keyboard plus Set lowest/highest | adds **"C-1 to G9"** note fields and "Whole keyboard" | **Worse copy**: C-1 and G9 are MIDI extremes, not keys a player owns. Show "every key" or real key names (A0–C8) |
| Response | Soft / Normal / Hard / Fixed | Light / Normal / Heavy / Fixed, plus a curve sparkline; "how it answers …" ellipsized | Better (matches Quick › Touch); the ellipsis is cosmetic |
| Footer | "● 1 change since the song was loaded" | "No switch changes since the song was loaded" | Worse copy ("switch changes" is internal; this is the round3-edit m2 fix). Try "Nothing changed since the song was loaded (levels don't count)" |
| Effects tab | 6 Space chips, fits | **7 Space chips** (Ambient Wash + Song's own, round3-edit M3) → **"Ro…", "H…", "Cathed…", "Ambient W…", "Son…"** at 1440; at 1280 *every* chip is ellipsized (e25, e39) | **Worse**: a regression at desktop widths. It is fine at 1024–1100, where the chips wrap to 3 columns (e34) |
| Effects tab summary | "Hall · echo: own" | "**Custom** · echo:…" | Worse: "Custom" appears nowhere else as the room's name |
| Wiring | "Space Hall" | "Space **custom**" (e31) | Same naming problem. Otherwise it matches the mockup, including real numbers and "fixed" for the drone |
| Tone EQ (e29/e30) | not mocked in H-v2 | a WING-style editor with graph, keyboard, band table, A/B and presets | Powerful, but engineer-facing; see §6 |
| Master tab | not mocked | the sentence "MASTER is at −6.0 dB, tape off, tone flat, glue off", plus folds | "glue" and "tape" are jargon on the first line a volunteer reads |
| Edit PANIC | "⌘ ." | "⌘ ." at 11 px, **3.19:1** | see §5 |
| Changed dots in Edit | the mockup had them; round-3 fix 3 said Perform only | built in Edit against Perform's baseline (the counts agree, per the integration test) | Better than the fix proposed; the wording is the issue |

---

## 3. Stage legibility and layout

### L1. Widths between the breakpoints break Perform [measured + seen, p20/p23/p25]

The ≤1250 compact layout and the ≥1440 layout were both designed. Nothing in between was. Measurements:

| Viewport | Fader throw | Drone card clipped | What breaks |
|---|---|---|---|
| 1512×900 | 257 | 0 | nothing |
| **1440×860** (a 1440×900 window on a 1440×900 Mac after the menu bar [est.]) | **217** | 8 px | the pad-folder row is tight; toasts cover the chips (p23) |
| **1366×768** | 157 | 68 px | title "Sunday Pad + P…"; chips ellipsized; the top bar shows "Bl…" with "Sound OK" overlapped by "42 ms" (p25) |
| **1280×800** | 189 | 36 px | title clipped at the top edge; "Cathedra", "Slapback", "Dotted 8t", "worship ech"; drone "C majc"; the folder row cut off; "Sound OK" overlapped by "42 ms" (p20) |
| 1024×700 | 141 | 0 | fine (the pill layout) |

- main.js creates the window at 1440×900 with `minWidth: 1024`, so any width in between is one drag away.
- **Fix (M):** apply the compact header, where Space/Echo become pills, up to ~1400 px, or let the header chip rows
  drop their hint line (`small`) under 1400.
- **Test** Perform at 1280×800 and 1440×860 in ui-core's responsive test, not only at 1440×900 and 1024×700.

### L2. Persistent banners take their height out of the stage [measured, p19]

- `#banners` pushes the grid down. The stalled banner (p09/p10) is brief, but the **"not saving"**, **"second
  window"** and **newer-library** banners can stay up for a whole service.
- Fader throw with one banner:
  - 1440: 257 → **191**
  - 1280: 189 → **131**
  - 1024: 141 → **83**
- The drone card clips a further 21–94 px.
- **Fix (S/M):** while a banner shows, drop the Notes column, or shrink the header row's padding. Or dock the non-danger
  banners into the top bar as a single amber pill ("Not saving ▸") and keep full width for `danger` only.

### L3. Toasts sit on top of the header's live controls [seen, p22/p23/p25; code: styles.css:269]

- `.toasts` is `right:16px; top: topbar + 8px; width: min(440px, 40vw)`. It covers the Echo/Space chip rows and the
  CHORD / Faded chip.
- Toasts are `pointer-events:none`, so a tap still reaches the chip underneath: the player taps something they can't
  see.
- Two info toasts ("MIDI is blocked…", "screen might dim…") took the whole right half of the header at start-up.
- **Fix (S):** anchor the toasts bottom-right above the Revert / Fade / PANIC / Lock row, or over the Notes column in
  Perform.

### L4. Small type on the stage [measured; font sizes from computed style]

These pass contrast but are small at arm's length:
- 1440: piano C-labels 9.5 px; header chip hints ("no echo", "1 repeat") 11 px; "PEDAL" / "BEND" 11 px; "→ Pad
  level", "↻ wheel 60%", "Chorus 35%" 11.5 px; the ON-tile "ON" 12.5 px.
- 1024: the same, 10.5–11.5 px.
- The mockup uses the same sizes, so this is not a regression. But the **pedal lamp is a 10×10 px dot plus an 11 px
  word** (`pedal-lamp` 62×22 at 1024) and it's the only "is sustain stuck?" cue.
- **Fix (S):** tint the whole wheel-strip footer (or the Sustain chips) when the pedal is down, not just the 10 px dot.

### L5. PANIC is not the brightest thing on screen [measured luma]

- The promise was "PANIC is the brightest thing on screen". PANIC measures a mean luma of **110**. The current-song
  pill measures 188 (amber), the KEYS ON tile 158 and the drone ON tile 201.
- It is the most saturated element, so it still stands out in colour. It doesn't in greyscale or for a red-weak eye.
- The mockup has the same property, so this is not a regression, but the promise as written is not met.
- **Fix (S):** add a 2 px light border or a lighter top gradient to PANIC.

---

## 4. State-visibility gaps

- **G1. The chord readout keeps a partial chord.** [measured, p03/p04] A held D–D–F#–A released note by note leaves
  **"A"** (dimmed) on the readout, because `_updateChord` re-names the chord on every note-off (engine audio.js:1530).
  Real releases are staggered by some ms [est.], so the idle readout will often show one note of the last chord.
  **Fix (S):** on note-off, keep `_lastChord` unless the new chord has ≥ 3 notes or is a power chord; or clear the
  stale readout after ~2 s.
- **G2. The empty-slot "+" looks live under lock.** [measured] `disabled:false`, opacity 1. A tap gives the toast
  "Perform lock is on — unlock it to edit." Every other frozen control is dimmed. **Fix (S):** dim it like the
  other frozen controls (it leads to Edit, which is frozen).
- **G3. The Quick sheet's PEDAL DOWN lamp is dimmed under lock** (p21), even though it's a readout. Whether it still
  lights under lock was not tested. **Fix (S):** exclude the lamp from the frozen group.
- **G4. Stalled audio next to a green READY.** In p09 the top bar reads "● Stopped 42 ms ● READY", with the latency
  in amber. Two green or amber signals sit beside a dead engine. **Fix (S):** while stalled, grey READY and hide the
  latency.
- **G5. The MIDI state is truncated while loading.** "MIDI **Bloc…**" and "Sound OK**42 ms**" (no gap) show at 1440
  during "LOADING n/19" (p01), and at all times at 1280/1366. That covers every launch, which is when the player checks
  MIDI. This is local L-6 (COORDINATION C3), still present in this tree.
- **G6. The drone OFF state moves the card layout** (Follow chords is removed; see §2).
- **G7. Quick › Tempo shows "——" for "no tempo".** Write "no tempo — TAP to set".
- **G8. [code; needs a Mac check] The Electron window uses `titleBarStyle: 'hiddenInset'`** (main.js:584), but no CSS
  insets the top bar or sets `-webkit-app-region: drag`. The macOS traffic lights would then sit on the "Worship Rig"
  logo at x ≈ 12–80, and the window could not be dragged by its top bar.
  - This can't be seen on Linux. The local Mac session should screenshot `npm start` to confirm.
  - Fix (S): `.topbar { padding-left: 78px; -webkit-app-region: drag }`, plus `no-drag` on the buttons, when
    `rig.isElectron && platform === 'darwin'`.

**Verified OK:**
- Changed dots on chips, header chips and Edit tabs.
- The Revert count; mutes and faders are not counted (p04 shows the Pad OFF and still "1 changed").
- The HOLD badges and the "press and hold (0.6 s)" hint under lock (p17).
- The locked amber frame.
- The OFF tile strike-through.
- The Faded chip.
- The "Waiting for MIDI permission" path, which is covered by tests, not by this run.

---

## 5. Contrast (computed) and hit targets

### Contrast failures on enabled controls (WCAG AA: 4.5, or 3.0 for large text)

| Ratio | Text | Where | Note |
|---|---|---|---|
| **3.27** | "Restart sound", 18 px / 800, white on #ff4d4f | stalled banner (p09/p10) | 18 px is just under the 18.66 px bold "large" cut. This is the one emergency button; use `--panic` #d9363a (4.63 with white) or darker |
| **3.72** | "Esc", 11 px, on PANIC | Perform PANIC | Raise to ≥ #fff at 0.95, or make it 13 px |
| **3.19** | "⌘ .", 11 px, opacity .75, on PANIC | Edit bottom bar | same |
| **1.87** | "Octave normal" on an **OFF** strip (36 % opacity) | p04 | The chips on an OFF strip are still live (you can set Space before unmuting). At 36 % the values are 1.8–3.3:1, "Octave normal" is nearly invisible, and "−5.2 dB" is 1.82. Suggest 50 % for the chips and the dB readout and 36 % for the rest |
| 2.10–3.26 | "↻ wheel 60%", "Chorus 35%", Space/Echo/Sustain values on the OFF strip | p04/p05 | same cause |
| 2.17 | Edit bottom legend "all" (the Pad row) | e20+ | a dimmed legend row; fine if intended as "not the selected slot" |

Disabled or frozen controls (WCAG-exempt) sit at 1.46–2.6:1: the locked drone Brightness/Movement/Follow/Continue,
Revert "nothing changed" (2.17), and Prev on the first song (2.59). That is readable as "dead". The one exception worth
fixing is G3, where a readout is dimmed as though it were frozen.

Everything else on every screen (6,566 text runs across 40 audited states) passes AA. That includes the coloured ON tiles
("ON" 5.78:1), the step chips, the header chip hints (5.66) and the Edit sentence.

### Hit targets under 44 px on Perform (a stage control, 44 px bar)

- **1440:**
  - Empty-slot "+": 34×34.
  - Drone Brightness/Movement sliders: 34 px tall.
  - Settings: 42×44.
  - Everything else is ≥ 44: ON tiles 46, chips 46, PANIC 150×94, Lock 124×94.
- **1024** (all live under lock unless noted):
  - **Swell 62×38** (live).
  - **KEY ▾ 67×38** (hold).
  - **Space/Echo pills 244×36** (live, and each is two taps: pill → menu).
  - **Step-panel steps 162×37.**
  - Notes 99×36.
  - Follow/Continue 36 px tall.
  - Brightness/Movement 26 px tall.
  - Quick sheet: × 36×32, All settings 32 tall, Touch segments / Reversed / TAP / Swell ± 38 tall.
- **Fix (S):** a `min-height: 44px` floor for `.swell-btn`, `.key-open`, `.fxpill` and `.sp-step` at ≤ 1250 px. The
  rows have the room: the 1024 header is 94 px tall.

### Edit and Settings (desk use, 24 px WCAG 2.2 floor)

- Under 24:
  - Show wiring switch **116×20**.
  - Range handles **12×48** (a 12 px drag width).
  - Summary links "Bring an EQ over (paste)" 17 tall and "Diagnostics" 16 tall.
  - The "Open the GarageBand guide" link 15 tall.
- 24–30:
  - EQ on/off 40×24, band number/delete 26×26.
  - The sentence tokens "on" 26×29 and "C" 15×29.
  - Wiring lane buttons 24 tall.
  - Word sliders 28 tall.
  - The setlist New/Rename/Delete 28 tall.

These are acceptable for a mouse. The range handles and the Show wiring switch deserve ≥ 24 px.

---

## 6. Copy that is jargon, or that disagrees with itself

**Naming disagreements (fix first, S):**
- The custom room is **"Song's own"** (the Perform chip, the Effects sentence), **"Custom"** (the Effects tab summary,
  "Vibe: Custom"), **"custom"** (wiring), and **"the Space"** (the slot sentence). Use "song's own" everywhere, and
  "Vibe: your own mix" as in the mockup.
- Settings › MIDI learn says **"Reverb level"**; Perform and Edit say **Space**.
- "Touch" (Quick, Settings) and "Response" (Edit) name the same idea with the same four words. Pick one label.

**Jargon a volunteer meets on the first screen of a tab:**
- Slot › Where it plays: **"C-1 to G9"**.
- Advanced:
  - "In The sound itself above: Release **(τ)** → Ring-out · Tone → Brightness."
  - "**Voices** Chords", "0 **semitones**", "Pan Center".
- Tone EQ:
  - **"≈B2 −49¢"**.
  - **Q**.
  - **LS / HS / LC / HC** node labels.
  - **"A · EQ on / B · Bypass"**.
  - The preset **"Wing channel"** (a console brand).
  - "Acts on", "FLAT · set a boost or cut", "Bring an EQ over (paste)".

  Acceptable behind Advanced › Tone, but hide the Q column, show "B2" without cents, and rename the preset
  "Mixer default".
- Master sentence: "tape off, tone flat, **glue** off". Tape fold: Wow / Flutter / Crackle / **Bit crush** /
  Saturation. Suggested: "glue" → "Even out (compressor)".
- Drone:
  - "**Key fade** · Smooth 5.0 s" means how long a key change crossfades; say "Key change: smooth".
  - "**Minor keys use the major pad**" is a double negative in effect.
  - "Chord follow **EXPERIMENTAL**".
- Edit footer: "No **switch** changes since the song was loaded".
- Settings:
  - "**Latency** … 42 ms — high".
  - "Song buttons: the keyboard's **program/patch** buttons".
  - "Audio engine".
- Perform: "**↻ wheel 60%**" under the Pad name. Without the icon's meaning it reads as a rotation. Try "wheel: 60 %".

**Good copy, keep it:**
- "Tap one: done. Starts on your next note; held notes keep ringing."
- "Band hears C · you play C · 0" and "Your hands stay in C".
- "Sound stopped — click 'Restart sound'."
- "Faded — play to resume".
- "HOLD a key or Major/Minor to change it while locked".
- "The ON tile and Level are live moves; they never count as changes."

---

## 7. Top 10 (ranked by Sunday risk)

| # | Problem | Fix | Effort |
|---|---|---|---|
| 1 | Perform breaks at 1280–1400 px and loses 40 px of throw in a real 1440×~860 Mac window (L1) | extend the compact header (pills, no chip hints) up to ~1400 px; add 1280×800 and 1440×860 to the ui-core responsive test | **M** |
| 2 | Persistent banners cut fader throw to 83 px at 1024 and clip the drone card (L2) | dock the warn/info banners into the top bar as a pill; keep the full-width banner for `danger` (stalled) only | **S–M** |
| 3 | Toasts cover the header Space/Echo chips and the Faded chip, and taps pass through to hidden chips (L3) | anchor the toasts bottom-right above the action row (or over Notes) | **S** |
| 4 | Effects tab preset chips ellipsize at 1280–1440 ("Ro…", "H…", "Son…") | let the chip grid wrap (`repeat(auto-fill, minmax(110px,1fr))`, as at 1024), or drop the hint line when there are more than 6 chips | **S** |
| 5 | The custom room has 4 names (Song's own / Custom / custom / "the Space"); MIDI learn says "Reverb" | one label everywhere: "song's own"; "Space level" in Settings | **S** |
| 6 | Restart sound 3.27:1; PANIC "Esc" 3.72, "⌘ ." 3.19 | Restart on #d9363a (4.63) or darker; PANIC sub-labels at full white, 13 px | **S** |
| 7 | 1024 live controls below 44 px: Swell 38, KEY 38, Space/Echo pills 36, step-panel steps 37 | a 44 px floor at ≤ 1250 (the 94 px header row has room) | **S** |
| 8 | Chord readout idles on a leftover single note ("A" after a D chord) (G1) | keep the last ≥ 3-note chord on note-off; clear the stale value after ~2 s | **S** |
| 9 | OFF-strip chips at 1.9–3.3:1 while still live; the pedal lamp is a 10 px dot (L4) | 50 % opacity for the chips and dB; tint the wheel-strip footer or the Sustain chip while the pedal is down | **S** |
| 10 | Jargon: "C-1 to G9", τ, ¢, Q, "Wing channel", "glue", "switch changes", "Key fade", "↻ wheel" | a copy pass (list in §6); hide Q and cents behind a "Details" toggle in Tone | **M** |

**Also:**
- **(S)** Dim the empty-slot "+" under lock (G2).
- **(S)** Keep the Quick PEDAL DOWN lamp live under lock (G3).
- **(S)** Grey READY while stalled (G4).
- **(S)** Keep Follow chords (dimmed) when the drone is off (G6).
- **(S)** "no tempo — TAP to set" (G7).
- **(S, local Mac check first)** Confirm the traffic-light overlap and add the Electron top-bar inset and drag region
  (G8).
- L-6 top-bar overlap: already queued as C3.

---

## 8. Screenshot index (`reviews/ux2-shots/`)

**Perform:**
- p01 idle 1440 · p02 chord held + pedal + wheel 60 % · p03 Octave step panel · p04 Octave +1 changed, Pad OFF, Revert
  "1 changed" · p05 drone OFF · p06 Sing it in… · p07 Quick
- p08 2 chips · p09/p10 stalled 1440/1024 · p11 idle 1024 · p12 chord 1024 · p13 Quick 1024 · p14 Space step 1024 · p15
  2 chips 1024
- p16 locked 1440 · p17 locked tap on Transpose (hold hint) · p18 locked 1024 · p19 library banner 1024 · p20 1280×800
- p21 Quick under lock · p22 faded out (+ toast over the header) · p23 1440×860 · p24 1512×900 · p25 1366×768

**Edit:**
- e20 Keys · e21 Pad · e22 Extra (empty) · e23 Bass (empty) · e24 Drone · e25 Effects · e26 Master · e27 Song
- e28 Keys Advanced · e29/e30 Tone EQ 1440/1024 · e31/e32 Show wiring 1440/1024 · e33–e36 Keys/Effects/Drone/Master at
  1024
- e37 Effects after a preset tap (changed dot) · e38 Master › Wheels & pedal · e39 Effects 1280×800

**Settings:** s40 top · s41 scrolled · s45 1024.
