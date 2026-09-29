# Worship Rig: making it warm enough to open every day

The user's words: *"the design low-key looks a bit cold. It looks just like a vibe coded tool that you would use and not
something that I would want to come back to on a daily basis."*

Scope: visual language, voice and small rituals only. Same H-v2 layout and components. Stage legibility must not get
worse: text ≥ 4.5:1, lamps distinguishable at 1.5 m, no glare, no per-frame blur or filters, and 1024–1512 px widths.

Evidence tags:
- **[src]**: stated in a fetched source (§10).
- **[measured]**: computed or screenshotted here (scripts in `probe/`).
- **[shot]**: seen in the repo screenshots.
- **[knowledge]**: my own recollection of the product. Not re-verified this session, so treat it as a lead, not a fact.
- **[infer]**: my reasoning.

---

## 0. TL;DR

The app looks cold for measurable reasons, and **six moves fix most of it without touching layout**:

1. **Re-hue the neutrals** from slate blue (OKLCH hue ≈ 258°) to a low-chroma ember charcoal (hue ≈ 55°, C ≈ 0.012).
   Also make the text ivory, not blue-white.
2. **Tame the slot colours** from near-max chroma "neon" to lamp colours: ember, sage-mint, sky, plum. They keep
   ≥ 7:1 on panels, and they fix an existing colour-blind collision (§5.3).
3. **Type with a voice.** Use one warm humanist sans for the UI (Figtree, OFL, 63 KB, has `tnum`). Use a soft serif
   (Fraunces with SOFT = 100, OFL) **only** for things read from across the room: the song title, the chord, the
   welcome.
4. **Light, not boxes.** Use one static warm "stage wash" from above plus a 2 % grain tile. Panels get a soft rim and a
   1 px warm top highlight instead of a grey outline. Labels go from TRACKED CAPS to sentence case.
5. **Motion that breathes only when nothing is happening.** Idle and pad-sustain lamps breathe on opacity (compositor
   only). Level glow is a pseudo-element's opacity. Nothing moves under Lock unless it's a meter.
6. **Rituals.** Turn the unavoidable "Click to start audio" overlay into a **welcome and warm-up** surface, give the
   setlist a "Today" framing, remember the last session, and close with an end-of-set moment. Change the copy from
   telemetry to a friendly stagehand.

A probe theme (tokens plus about 15 rules, injected with Playwright) already moves the look a long way
(`probe/warm-perform-1440.png` vs `probe/base-perform-1440.png`) **[measured]**. It also shows that **a theme file alone
can't finish the job**: about 250 hard-coded hex literals in `styles.css` and the edit CSS still leak cold navy and slate
(§6.2).

---

## 1. Why it reads "cold / vibe-coded" (diagnosis)

| # | Cause | Evidence |
|---|---|---|
| C1 | **Every neutral is slate blue.** `--bg #0b0d10` → OKLCH(0.158 0.007 **258°**), `--panel #15181d` (261°), `--line-2 #3a414d` (261°), `--muted #a3acb8` (256°), `--text #f1f4f8` (255°), topbar `#101318` (261°). That's the Tailwind *slate-900* family, the default of countless generated dashboards. | [measured] `probe` OKLCH conversion |
| C2 | **Slot colours sit at the sRGB chroma ceiling**: C = 0.155–0.18 (`#ff8a3d`, `#3ddc84`, `#4aa8ff`, `#b784ff`). On slate they read as "status LEDs / neon" rather than lamps. | [measured] |
| C3 | **System font everywhere.** SF Pro / Segoe / Roboto at weight 700–800. Nothing says *this* app. | `styles.css:37-38` |
| C4 | **Tracked uppercase micro-labels**: 8 rules in `styles.css` (`.tb-cap`, `.section-title`, `.fader-label`…), `letter-spacing .08em`, 12 px. SPACE, ECHO, TRANSPOSE, KEY & DRONE, MASTER, WHEEL. This is the single strongest "admin dashboard" tell. | [shot] perform.png; `styles.css:105-107` |
| C5 | **Everything is a 1 px grey box** (`.panel`, `.btn`, `.seg`, `.mchip` all `border: 1px solid var(--line-2)`), with uniform 7–10 px radii. There's no light source and no depth except outlines. | `styles.css:67-77,293` |
| C6 | **The top bar reads as telemetry**: `MIDI Blocked`, `LOADING 15/19`, `42 ms`, `00:00`, `READY` in caps with coloured dots. That's useful, but it greets you like a server monitor. | [shot] |
| C7 | **Cold one-offs**: Fade out is navy `#182231`, toasts are `#1f242c`, piano white keys are blue-grey `#b9c0c9`, the wheel fill is steel `#a9b8c9`, and the accidental key buttons are `#14171c`. | `styles.css:312,752,855,912,926` |
| C8 | **No memory, no place.** Every launch is the same "Click anywhere to start audio" card. Nothing knows it's Sunday, what you played last week, or that you're about to soundcheck. | `index.html:69-75` |
| C9 | **The icon is a generic level meter** in the neon slot colours on slate (`icons/icon.svg`). | [shot] |

What's already warm and should be kept: the plain-English Edit sentences ("KEYS plays **Grand Piano** on every key, a
little into the song's own Space"), the Notes panel, the cream drone (`--drone #e8d9a8`), and the amber accent.
**[shot]**

---

## 2. Reference catalogue

| Reference | What makes it warm / characterful | What transfers to Worship Rig | Evidence |
|---|---|---|---|
| **Nord Stage 4 / Nord brand** | One unmistakable body colour (Nord red), physical LED faders per layer, and drawbars with LED ladders. The panel is dense but the *light* tells you state. | The **lamp metaphor**: state is light on a warm dark body, not boxes. Per-layer LED fader = our strip fader fill. One signature colour for the brand mark only, never red for UI (red = PANIC). | [src] nordkeyboards overview; [knowledge] the red |
| **Teenage Engineering OP-1 / OP-1 field** | Four colour-coded encoders; "a green graphical element … hints that the green encoder will change its value". Animated, illustrated screens (tape reels, dancing waveforms). The field moved to **darker blue, ochre, grey, orange**: a *muted* palette with character. | Colour = identity mapping (we already do slot → colour). **Desaturate toward ochre / earthy.** Small illustrated moments (a tape reel for REC, a candle for idle) instead of generic icons. | [src] TE guide; Perfect Circuit review; blakecrosley |
| **Spitfire LABS** | Each instrument has its own **cover artwork**, and there's one big friendly dial with few controls. The brand uses a 12-colour system mapped to sound families. | A tiny **per-instrument glyph/artwork** (the Edit title icon slot `ev2-title-icon` already exists) gives each sound a face. "Few, big, named" controls, which H-v2 already has. | [src] MusicRadar; Villagers |
| **Ableton Note / Move** | Copy is verb-led and low-pressure ("Pick a sound to sketch with, and start playing", "Make new ideas a habit"). Move: colour-coded pads and **touch an encoder to see its value**. | Voice (§7). Reveal numbers on touch; lead with words (H-v2 already says "Words first, numbers beside them"). | [src] ableton.com/note; Orb Mag |
| **Endel** | Thin lines and "sparkling dots" on dark that **adapt to time of day, weather and heart rate**. "The designed world should be as detailed as possible". "Trustability". It's subtle enough to fade into the background. | An **ambient idle state** that changes with time of day (early-morning soundcheck vs evening), kept to the background. Detail that rewards a second look. | [src] Readymag interview |
| **Headspace (2024 rebrand)** | Signature orange; a palette chosen to stand out against the "dreary sea of blues and greys". The goal is "kind, warm and welcoming". The custom Aperçu cut "flexes from playful to clinical". | An **explicit rejection of blue-grey** is the cure for C1. The type must also flex: playful in the welcome, clinical on the dB readouts. | [src] It's Nice That; Kimp |
| **Calm** | A dark, deep-blue night world with nature imagery and serif display. Its warmth comes from imagery and voice, not from the palette. | Counter-example: dark *blue* can still feel warm **if** there's imagery and a human voice. We have no imagery budget, so shift the neutrals instead. | [knowledge] |
| **Things 3** | Whitespace, bold type, "thoughtful splashes of colour". Every animation is purposeful ("Lovely, unfolding animations keep your place"). **Today** and **This Evening** make it a daily surface. | A **"Today" frame** for the setlist. Motion that *keeps your place* (the step panel unfolding from its chip), never decoration. | [src] MacStories; culturedcode.com |
| **Bear** | Themes are part of the product ("a beautiful place to write"): Red Graphite as default, plus sepia themes "for a warmer vibe". One accent (red) on a graphite neutral. | **One accent on a warm graphite.** Offering a second theme later is a legitimate "this is mine" feature. | [src] Bear blog |
| **iA Writer** | Custom duospace type (from IBM Plex Mono, OFL) because type sets the psychological mode; "a smaller palette of font shapes" feels "calmer". | Type choice is a feel lever, not decoration. Keep the family count at 2. | [src] ia.net |
| **Logic / Apple Music dark** | Warm-neutral greys (not blue) with vibrancy, SF Pro Rounded in places, and album art doing the colour. | Neutral greys *can* be fine, but the blue cast is what makes ours cold. | [knowledge] |
| **Arturia V Collection / skeuomorphism** | Wood cheeks and cream panels borrow "50 years of studio mythology". The critique is that you copy "the aesthetics without understanding why" and get "illegible tiny text". The ideal is "functional modernism with personality". | Borrow **materials as colour** (walnut, cream, amber), not photoreal wood. | [src] KnobSmith; Splice |
| **Moises / BandLab** | Musician-first dark UIs. Moises says "human, modern, and unmistakably Moises". | Tone only; nothing specific was verified. | [src] design.moises.ai (no specifics) |
| **Sunday Sounds / Sunday Keys** | Near-black brand (`#101010`), casual voice ("Hey folks"), and a redesign aimed at "less intimidating". | Voice: a worship-team friend, not a vendor. | [src] Sunday Sounds walkthrough |
| **Bethel Music (Heaven Come 2019)** | "A little grunge and 70s nostalgia", "full of colour and life", with gradient treatments. Worship brands lean on **texture + warm film tones + serif/editorial type**. | Grain and a warm film cast are on-genre for worship. So is an editorial serif for titles. | [src] Stephen James Hart |
| **Planning Center Services** | The tool the same volunteers use weekly. Tapestry theming uses CSS custom properties. Specific colours not verified. | Our users already live in PCO. A familiar song/plan vocabulary ("Plan", "Today's set") lowers friction. | [src] Tapestry docs (no colours) |

---

## 3. Principles (for the theme designer)

1. **Warm the neutrals, not the accents.** Coldness lives in the 90 % of pixels that are "grey". Hue 40–70°, chroma
   0.008–0.015 in OKLCH. Above about 0.02 it turns brown and muddy. [measured / infer]
2. **Never pure white, never pure black.** Use ivory text (`#f4f0e6`) on charcoal. That avoids halation, which is worse
   in a dark room and for astigmatic eyes. [src] Level Access, James Robinson
3. **Colour is light.** An ON state is a lit lamp: a slight inner gradient and, while sounding, a soft glow. OFF is an
   unlit lamp: a dark tile with a visible rim. Selected-but-not-ON gets an outline only, never a fill (this also fixes
   the H-v2 drone-glance risk).
4. **Fewer boxes, more planes.** Separate by value steps (bg → panel → panel-2) and a 1 px warm top highlight ("edge
   lighting"). Outline only what you can press. [src] James Robinson
5. **Two type voices.** A humanist sans for everything you operate. A soft serif only for things you *read from across
   the stage*: song title, chord, welcome. No serif on numbers that change (no `tnum` in Fraunces).
6. **Sentence case.** Caps only for the slot lamp names (KEYS / PAD, which work as physical labels) and PANIC.
7. **Motion only at rest.** When you're playing, only meters and lamps respond to *sound*. Ambient motion (breathing,
   time-of-day wash) runs only when idle and stops under Lock. Everything animates `opacity` or `transform`, and
   honours `prefers-reduced-motion`. [src] web.dev, SitePoint
8. **The app should know what day it is.** Rituals give a reason to open it on a Tuesday: warm-up, today's set, the last
   session, a thank-you at the end.
9. **Speak like the MD who likes you.** Short, plain, kind, never cute. No exclamation marks in errors.
10. **Stage first, always.** Every warm move is checked against 4.5:1 text, 3:1 non-text, lamp separation in CVD
    simulation, and a 50 % greyscale glance.

---

## 4. Axis-by-axis findings

### 4.1 Colour temperature: how warm products avoid the "grey dashboard"

- **Tinted neutrals.** Bear's graphite, Apple's warm greys and Sunday Sounds' `#101010` (neutral, not blue) all avoid
  the blue cast; Tailwind slate is the default look of generated UIs [infer]. James Robinson notes that dark values
  tolerate more tint "without it looking like oh wow there's that color" [src], and also that viewers are "more
  forgiving of cold than warm tones" in darkness [src]. **That's a caution**: keep warm chroma low or it reads as brown.
- **A signature hue with a meaning.** Nord red = the brand, Headspace orange = optimism, TE orange = engineering. Ours
  should be **amber/candle** (`--accent`), which already means Lock/hold, so the *brand* warmth comes from the neutrals
  and the stage wash, not from a new accent. [infer]
- **Earthy lamp colours.** OP-1 field moved to "darker blue, ochre, gray, and orange" [src], toward muted and
  materials-like. Our slot colours can do the same at C ≈ 0.10–0.16.

### 4.2 Typography

Every candidate below was verified in `google/fonts` METADATA.pb as **OFL** and inspected with fontTools for `tnum`,
axes and size [measured]:

| Family | Licence | Size (variable TTF) | `tnum` | Axes | Role fit |
|---|---|---|---|---|---|
| **Figtree** | OFL (Erik Kennedy) | **63 KB** | yes | wght 300–900 | **Primary UI.** Friendly geometric-humanist, open apertures, clear at 12–13 px, sturdy at 800. Smallest file. |
| Manrope | OFL | 165 KB | yes | wght 200–800 | UI alternative: more technical and squarer. Warm-ish, but closer to "SaaS". |
| Instrument Sans | OFL | 194 KB | yes | wdth 75–100, wght 400–700 | UI alternative with editorial character; the `wdth` axis helps tight strips at 1024. |
| Onest | OFL | 193 KB | yes | wght 100–900 | UI alternative, neutral-friendly. |
| Atkinson Hyperlegible Next | OFL (Braille Institute) | 115 KB | yes | wght 200–800 | **Legibility fallback** for stage numerals and letters (distinct I/l/1). Less "character". |
| DM Sans | OFL (Colophon) | 240 KB | **no** | opsz, wght | Avoid: the app uses `tabular-nums` in 9 places, and DM Sans has no `tnum`. |
| Nunito | OFL | 277 KB | no (digits are tabular by default) | wght | Rounded and friendly, but reads "kids' app" at bold weights. Avoid for stage. |
| Bricolage Grotesque | OFL | 408 KB | yes | opsz, wdth, wght | Display sans with quirk. An alternative if a serif feels too churchy. Heavy file. |
| **Fraunces** | OFL (Undercase) | 360 KB (subset it) | **no** | opsz 9–144, wght, **SOFT 0–100**, WONK | **Display only.** SOFT = 100 gives the warm, rounded "old-style soft serif". Set WONK = 0 for calm. |
| Newsreader | OFL (Production Type) | 452 KB | yes, tabular by default | opsz, wght | Display alternative: bookish and hymnal-like, and safe for numbers. |
| Instrument Serif | OFL | 70 KB | no | Regular only | Too thin for 1.5 m on dark. Welcome-screen headline only, if at all. |
| Source Serif 4 | OFL (Adobe) | not downloaded | not checked | opsz, wght | Sober editorial alternative. |
| Inter Tight / Outfit | OFL | not downloaded | not checked | wght | Inter Tight is still "default SaaS". Outfit is geometric and cool. Neither is a warmth win. |

Notes:
- **None of these has ♭/♯ glyphs** [measured]. The UI prints "Db/F#" today. If a design uses ♭ ♯, the fallback font will
  draw them, so test on the Mac.
- `font-src 'self'` in the server CSP (`server.js:89`) means fonts **must** be same-origin files under
  `app/themes/<id>/fonts/`. That matches the no-network rule [measured].
- Subsetting Fraunces to Latin + opsz/wght/SOFT with `pyftsubset` should cut it well under 360 KB [infer, not done].

### 4.3 Texture

- **Grain**: a static 128 px tiled PNG (37 KB, alpha ≤ 22/255) as a `body` background layer. It isn't an SVG
  `feTurbulence` filter: CSS-Tricks' grainy gradients are pretty but "suck performance-wise" when filtered live [src].
  A bitmap tile costs nothing extra to repaint [infer]. **Never `background-attachment: fixed`**, which forces full
  repaints [infer].
- **Stage wash**: one `radial-gradient` from above the header (peak ≈ `#3a2618`) fading into `--bg`. It reads like a
  warm light on a dark stage. It's static and painted once. Header text on the wash is still ≥ 12:1 [measured].
- **Vignette**: optional, via the same gradient stack. Keep edges ≥ `--bg` so the panels' contrast doesn't change.
- **Glass/blur**: avoid on stage surfaces. `backdrop-filter` re-blurs every frame the meters under it change. It's
  acceptable only on the rarely open Quick sheet and Settings modal, and even then a solid 94 % fill is safer [infer].

### 4.4 Motion ("alive, not busy")

| Moment | Motion | How (compositor-only) |
|---|---|---|
| ON lamp while its slot is sounding | Soft glow proportional to level, smoothed (attack 60 ms, release 400 ms) | `::after` with a fixed `box-shadow`; animate only its `opacity` from the existing meter value. SitePoint measured 211 → 51 ms paint with this versus animating `box-shadow` [src]. |
| Pad or drone sustaining with no keys held | Very slow **breath** (6 s, opacity 0.85 ↔ 1) on the lamp's LED dot only | CSS keyframes on `opacity`. Stop under Lock and under `prefers-reduced-motion`. |
| Idle (no notes for 2 min, not locked) | The stage wash drifts a few % in brightness; the chord readout shows the song key softly | Opacity on a wash layer. The drift is not per-frame JS. |
| Step panel / Quick sheet open | Unfold from the chip ("keep your place", as in Things) | 160–200 ms `transform: scaleY` + opacity, `cubic-bezier(.2,.8,.2,1)` |
| Song change | Title crossfade 180 ms; setlist current pill slides | `opacity` / `transform` |
| Fade out / end of set | A slow lamp-down alongside the audio fade | Opacity |
| **Never** | Pulsing ON lamps or PANIC, bouncing, confetti, parallax | These are ambiguous on stage: a pulsing lamp reads as "warning". |

### 4.5 Iconography and illustration

- Replace the meter icon with a mark that has a subject. Ideas: a **lamp or candle flame over four keys**, a **stylised
  sustain pedal with a glow**, or a **wordmark in the display serif** with the four slot colours as an underline
  ("four lamps") [infer].
- Give each instrument family a **small line glyph** (grand piano, Rhodes tine, organ drawbars, pad wave, bass string,
  drone ring). They're drawn at a 1.75 px stroke with rounded caps and live in `ev2-title-icon` and the Perform strip
  header. That's the LABS "each sound has a face" idea at icon scale [src LABS / infer].
- Illustration budget: one **empty-state** drawing per surface (empty EXTRA slot, no My Pads folder, empty set) in the
  same line style, in `--muted` at 40 %. Never on live controls.

### 4.6 Micro-copy voice: friendly, not cute

| Today | Proposed |
|---|---|
| Click anywhere to start audio | **Good morning.** Tap anywhere to wake the sound. |
| Your browser needs one click before it can play sound. | (keep as small print) |
| MIDI Blocked | Keyboard not allowed yet · *Allow* |
| LOADING 15/19 | Warming up sounds · 15 of 19 |
| READY | Ready to play |
| Sound OK 42 ms | Sound OK (42 ms stays, muted) |
| No switch changes since the song was loaded | Just as you saved it |
| My Pads: no folder chosen | No pad folder yet. Songs use the built-in drone. |
| nothing changed (Revert) | As saved |
| Fade out → (faded) | Faded. Tap to bring it back. |

Rules: second person, present tense, ≤ 7 words where possible. No "Oops" and no "!" in errors. Worship-literate but
not preachy: "set", "service", "soundcheck" and "MD" are fine; scripture or church jargon in UI strings is not. [infer]

### 4.7 Rituals: why you'd open it on a Tuesday

1. **Welcome and warm-up (the start overlay becomes a moment).** The browser *requires* one click anyway
   (`#overlay-start`), so spend it well. Show the day and time of day ("Sunday morning"), the set name and song count,
   first-up song and key, and **"Last time: Building Swell in D · 42 ms · Nord Stage 3"**. One big warm button: *Start
   sound*. [infer; pattern from Things "Today", Endel's time-aware world]
2. **Soundcheck strip (30 s).** "Play a chord": the four lamps light as each slot sounds, and the pedal lamp lights on
   press. Then it says "All four sounding. Pedal OK." It reuses Quick › This Mac's pedal light and the meters. [infer]
3. **A "Today" frame on the setlist.** The heading reads "Today · 6 songs · starts in C", not "My Set". For rehearsal
   days, "Practice" mode shows the notes panel bigger. [infer]
4. **Memory.** Reopen on the last song and scroll position, and show a quiet "Picking up where you left off". Needs a
   store read only; the data model is unchanged. [infer]
5. **End-of-set moment.** After Fade out on the last song, show "That's the set. Thanks for serving." with a time
   played and a *Save recording* if REC ran. A lamp-down animation. One line, no gamification. [infer]
6. **Ambient idle.** While unlocked and silent for 2+ min, dim the non-essential chrome to about 70 % and show the song
   key large and soft. Any note or touch restores it instantly. This is the "a room you walk into" feeling from Endel.
   Never while Locked. [infer]

---

## 5. Probe: how far a theme file gets (measured)

`probe/probe-theme.css` holds tokens plus about 15 rules, with Figtree and Fraunces loaded through `page.route`
(same-origin, CSP-safe). It was injected with `page.addStyleTag` after boot. Script: `probe/shoot.mjs`, which expects
`Figtree.ttf` and `Fraunces.ttf` beside it from `google/fonts`. Nothing under `app/` was changed.

### 5.1 Screenshots
- `probe/base-perform-1440.png` → `probe/warm-perform-1440.png`
- `probe/base-edit-1440.png` → `probe/warm-edit-1440.png`
- `probe/base-perform-1024.png` → `probe/warm-perform-1024.png`

Reading them: the ember charcoal, ivory text, sentence-case labels, soft-serif title and chord, and the stage wash turn
"slate dashboard" into "a room". At 1024 the Fraunces title "Sunday Pad + Piano" fits and reads well. The grain is
invisible at arm's length but kills the flat-plastic look up close. [measured / my read of the screenshots]

### 5.2 Palette used and contrast [measured]

OKLCH neutrals at hue 55°: `--bg #140f0c`, `--panel #1e1814`, `--panel-2 #28211d`, `--panel-3 #342c27`, `--line #37302b`,
`--line-2 #49413b`, `--text #f4f0e6`, `--muted #c3b9ab`, `--faint #a89c90`, `--accent #fcc35d`.

| Pair | Ratio |
|---|---|
| text on bg / panel / panel-3 | 16.7 / 15.4 / 12.0 |
| muted on panel / panel-3 | 9.1 / 7.1 |
| faint on panel-2 / panel-3 | 5.9 / 5.1 (≥ 4.5 ✓; today's `--faint` targets 4.5) |
| track-edge on panel | 3.6 (≥ 3 ✓) |
| led-off on bg | 3.75 (≥ 3 ✓) |
| muted-fader on panel | 4.1 (≥ 3 ✓) |
| panic-text on panic-bg | 9.7 |

### 5.3 Slot colours and colour-vision deficiency [measured]

Machado 2009 simulation, minimum OKLab ΔE×100 between any two of Keys / Pad / Extra / Bass / accent:

| Palette | normal | deutan (≈5 % of men) | protan | tritan (rare) |
|---|---|---|---|---|
| **Today** `#ff8a3d #3ddc84 #4aa8ff #b784ff` | 14.7 | **0.6 (Extra ≈ Bass: indistinguishable)** | 5.6 | 8.4 |
| Warm v1 (hue-shift only) | 12.7 | 1.6 | 5.2 | 6.7 |
| **Warm v2 (probe)** `#f78955 #6ed889 #7ad1f7 #b073da` | **15.0** | **6.8** | 5.1 | 3.6 (Pad ≈ Extra) |

Warm v2 separates Extra (a light sky blue) from Bass (a darker plum) by **lightness**, which fixes the existing deutan
collision. The cost is tritan Pad vs Extra, a far rarer condition. The slots also have fixed positions and names.
Bass `#b073da` is 5.3:1 on panel, fine for a lamp. The lamp ink `#1c140c` on each ON tile measures: Keys 7.5, Pad
10.3, Extra 10.6, Bass **5.5** (the lowest, still ≥ 4.5), accent 11.4.

### 5.4 What leaked (still cold after the theme) [measured, screenshots]

| Leak | Where |
|---|---|
| Fade out button: navy `#182231` / `#2f4058` | `styles.css:926` |
| Toasts `#1f242cf2` | `styles.css:314` |
| Piano white keys `#b9c0c9`, labels `#3a404a` | `styles.css:912,917` |
| Wheel fill steel `#a9b8c9` on `#20252d` | `styles.css:752` |
| Accidental key buttons `#14171c` (Db, Eb…, navy-black) | `styles.css:855` |
| Header FX captions (SPACE / ECHO), KEY, NEXT, strip PEDAL / BEND, Edit YOUR RIG / ON STAGE / THE SOUND ITSELF still in caps | their own rules (not the 8 shared label rules) |
| Edit `.ev2` redeclares `--ev2-rig-bg #101318`, `--fx`, `--chg` | `views/edit/base.css:7-20` |
| Off-tile, muted chip, `.cd` rings `#0d0f12`, `.ontile` ink `#0d0f12` | `styles.css:387,401-410,805,391` |

Counts: `styles.css` has 206 hex literals, `styles-edit.css` 73, the edit `base.css` 74, and the panel CSS about 150.
Of about 460 outside `:root`, 211 are `var(--x, #fallback)` fallbacks, which are harmless. **About 250 are truly hard
coded** [measured]. To theme cleanly, a follow-up (by whoever owns `app/` CSS once the other agents land) should promote
these to tokens:

`--key-white`, `--key-black`, `--key-label`, `--wheel-fill`, `--wheel-track`, `--btn-fade-bg`, `--btn-fade-line`,
`--toast-bg`, `--accidental-bg`, `--ink-on-lamp`, `--ring-bg`, `--topbar-bg`, `--swell-on-bg`, and a `--label-case` /
`--label-track` pair so caps become a theme choice.

### 5.5 Gotcha: `--font-display` is used for numbers

`--font-display` drives `.song-name`, `.song-key`, `.overlay-title`, `.chord-name`, **`.transpose-val` and
`.wheel-value`**, and the last two use `tabular-nums` (`styles.css:330,640,649,667,690,756`). Fraunces has no `tnum`, so
remapping `--font-display` to a serif would make the transpose and wheel numbers jitter. **Add `--font-title`** for the
title, chord and overlay, and keep `--font-display` a sans (the probe overrides `.song-name` and `.chord-name` directly
for that reason; the wheel "100%" still picked up Fraunces through `--font-display` and shows it).

---

## 6. Recommended direction: "Sanctuary" (and two alternatives)

**Sanctuary (recommended):** a warm, candle-lit room. Ember charcoal neutrals, ivory text and amber-candle accent. Lamp
slots in ember, sage, sky and plum. Figtree for the UI; Fraunces SOFT for the title, chord and welcome. A static stage
wash plus 2 % grain. Sentence-case labels, lamp glow on sound, breathing only at rest. A welcome/warm-up surface and an
end-of-set thank-you. **The probe is a first cut of this.**

Alternatives for the design round:
- **Nord Cream:** closer to the hardware on the stand. A warm-black body, *cream* panels for the header and notes cards
  (dark ink on `#efe6d2`), and a Nord-ish red **only** in the wordmark. Risk: large light areas cause glare in a dark
  room, so only small cream elements are safe. [infer]
- **Walnut:** Arturia-inspired material colour. Deep brown-black with a walnut-toned setlist rail and brass-coloured
  thumbs, in the same type pair. Risk: it tips into "vintage plugin cosplay". [src KnobSmith caution]

---

## 7. Risks and pushback

1. **Warm can go muddy.** Keep neutral chroma ≤ 0.015. Robinson notes that cold is more forgiving in the dark; our
   answer is low chroma, not zero.
2. **The amber accent must stay unique** (it means Lock). On warm neutrals amber is less distinct than on slate. Keep
   Lock using amber *plus* its icon and word, and don't make the brand colour amber-ish in the UI.
3. **A serif can read "wedding invitation / churchy".** Mitigate with SOFT = 100, WONK = 0 and weight 600, only in
   three places. Bricolage Grotesque is the non-serif fallback.
4. **Grain and wash cost** are unmeasured under real meter activity (I didn't run a paint profile). Before shipping,
   profile Perform with a chord held on the M-series Mac; bitmap grain should be negligible [infer].
5. **Font weight vs system.** Figtree at 800 is a little lighter than SF Pro Heavy. Measure the 50 % greyscale check
   again and the 1024 strip names ("Grand P…" truncation).
6. **Rituals cost engineering time** (JS in `main.js` / `perform.js`, which are hotspots other agents are editing). They
   need no data-model change, but they are not "just a theme".
7. **Don't over-rotate on personality.** The user opens this *at church, under pressure*. Delight belongs in the
   welcome, idle and end-of-set moments. The playing surface should just feel warm and calm.

---

## 8. Implementation shape (for whoever builds it)

- `app/themes/sanctuary/theme.css` + `fonts/Figtree.woff2`, `fonts/Fraunces-subset.woff2` + `grain.png` +
  `OFL.txt` for each font. Add them to `LICENSES.md`.
- Loading: one `<link>` after `styles.css` (a later index.html change, not done here). Or a Settings → Appearance
  toggle that swaps the link, which gives Bear-style "a place that's yours" ownership.
- Before the theme: the token-promotion pass from §5.4, plus `--font-title`.
- Tests to add: a colour contract test (tokens resolve, no `#0b0d10`-family hues left), a contrast table test over the
  token pairs in §5.2, and CVD ΔE ≥ 5 for deutan and protan between slots (the script is in `probe/`, inline in this
  doc's measurements).

---

## 9. Method

- I read `CLAUDE.md`, `design/OPTIONS.md` (H-v2) and the `styles.css` `:root` tokens and main components.
- I viewed `ui-core/perform.png`, `edit-v2/edit-1440.png`, `edit-tone-eq.png`, `ux2-shots/p02`, and `s40` settings.
- I ran the probe: served `app/` with `server.js` on a random port, used headless Chromium, injected the theme, and
  took screenshots at 1440×900 and 1024×700.
- I verified font licences from `google/fonts` METADATA.pb and checked features with fontTools 4.62.
- I computed OKLCH/WCAG contrast with a small Python script, and CVD with Machado 2009 matrices plus OKLab ΔE.

## 10. Sources

- Nord Stage 4 overview: https://www.nordkeyboards.com/products/nord-stage-4/overview/
- Nord about: https://www.nordkeyboards.com/about-us/
- TE design principles (secondary): https://blakecrosley.com/guides/design/teenage-engineering
- OP-1 layout guide: https://teenage.engineering/guides/op-1/original/layout
- OP-1 field review: https://www.perfectcircuit.com/signal/teenage-engineering-op-1-field-review
- Spitfire LABS: https://www.musicradar.com/news/fantastic-free-plugins-spitfire-audio-labs
- Villagers LABS brand: https://villagers.studio/projects/spitfire-labs
- Ableton Note: https://www.ableton.com/en/note/
- Ableton Move review: https://www.orbmag.com/reviews/ableton-move/
- Endel visual director interview: https://blog.readymag.com/tune-in-drop-out-how-endel-helps-get-into-the-flow-via-immersive-soundscapes-5ab08d932687/
- Endel critique: https://ixd.prattsi.org/2026/02/design-critique-endel-ios-app/
- Headspace rebrand: https://www.itsnicethat.com/articles/italic-studio-headspace-graphic-design-project-250424
- Headspace identity: https://www.kimp.io/headspace-brand/
- Headspace system: https://standards.site/case-studies/headspace/
- Things 3: https://www.macstories.net/reviews/things-3-beauty-and-delight-in-a-task-manager/
- Things features: https://culturedcode.com/things/features/
- Bear themes: https://blog.bear.app/2018/10/write-your-way-with-beautiful-themes-and-bear-pro/
- iA fonts: https://ia.net/topics/in-search-of-the-perfect-writing-font
- Dark mode guide: https://www.jamesrobinson.io/post/a-guide-to-dark-mode-design
- Halation and astigmatism: https://www.levelaccess.com/blog/accessibility-for-people-with-astigmatism/
- Grainy gradients: https://css-tricks.com/grainy-gradients/
- Box-shadow animation performance: https://www.sitepoint.com/css-box-shadow-animation-performance/
- web.dev animations: https://web.dev/articles/animations-guide
- Skeuomorphism critique: https://knobsmithaudio.com/articles/plugin-aesthetics-and-baggage
- Splice on skeuomorphism: https://splice.com/blog/exploring-world-of-skeuomorphism/
- Sunday Keys walkthrough: https://sundaysounds.com/blogs/news/sunday-keys-mainstage-template-overview-walkthrough
- Bethel Heaven Come 2019: https://www.stephenjameshart.com/blog/bethel-music-heaven-come-2019-design
- PCO Tapestry theming: https://planningcenter.github.io/tapestry-react/theming/
- Moises design: https://design.moises.ai/
- Font licences: https://github.com/google/fonts (`ofl/<family>/METADATA.pb`)

Not verified this session (from my knowledge only): Calm, Logic and Apple Music visuals, Arturia V Collection skins,
NI Maschine+, Elektron, BandLab, the Hillsong app, and Craft. None of them carry a load-bearing claim above.
