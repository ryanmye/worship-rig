# Daylight: one planner, two lights

Direction for Ryan's note: *"the design low-key looks a bit cold. It looks just like a vibe coded tool that you would
use and not something that I would want to come back to on a daily basis."*

Files:
- Theme: `app/themes/daylight/theme.css`, `fonts/` (Instrument Sans, Fraunces with OFL texts), `paper.png`,
  `mark.svg`, `sun.svg`, `moon.svg`, `today.svg`. These are new files only. Nothing in `index.html` links them.
- Evidence: `shoot.mjs` (Playwright against the real app, with the theme injected), `palette.py` (token contrast,
  OKLCH and colour-vision simulation), and `audit-*.json` (contrast measured on the rendered pixels).
- Screenshots: `perform.png`, `perform-1024.png`, `edit.png`, `quick.png`, `idle.png`, plus `today.png`,
  `perform-dusk.png`, `edit-dusk.png` and `edit-1024.png`.

---

## 1. The idea

Most of the week the rig is used in daylight: learning a set on Tuesday, changing a pad at the kitchen table, a
Thursday rehearsal with the lights up. Only on Sunday is it a dark stage. Right now the app is a stage console every day
of the week. It has slate-blue neutrals, neon lamps and tracked caps, and that's why it feels like a tool you *use*
rather than a place you *come back to*.

**Daylight gives the rig two lights and one identity.**

- **Day** is warm paper. The desk is oat, the cards are white, and the text is ink. The four sounds are coloured planner
  tabs. The current song is highlighted in amber the way you'd mark a setlist with a highlighter, and the chosen
  effect is circled in ink. It draws on Things 3 (calm whitespace, colour only where it means something, a "Today"
  surface) and Craft (a soft serif for reading, paper warmth, generous corners).
- **Stage** (dusk) is the same page turned over for the dark. The neutrals become warm graphite, the paper colour
  becomes the text, and the tabs become lamps with a soft glow. Glare matches today's app (mean luminance 0.07 vs 0.07).
- **The switch is a single property.** Every colour token is `light-dark(day, stage)`, so `color-scheme` picks the
  light. Auto follows the Mac's appearance. A *Day · Stage · Auto* toggle sets `data-mode`, and Lock sets Stage
  (§6).
- **A daily hook.** A "Today" card and a before-service sheet know what day it is, what's next, and what you played
  last time (§8).

Nothing moves in the layout. H-v2's components, sizes and hit areas are unchanged, and the theme only restyles them.

---

## 2. What changes, at a glance

| Before (cold) | Daylight |
|---|---|
| Slate-blue neutrals (OKLCH hue ≈ 258°) every day | Oat paper by day (hue 70–85°, C ≤ 0.02); warm graphite on stage (hue 60–70°, C ≤ 0.008) |
| Neon slot colours at the sRGB chroma ceiling | Tangerine, sage, sky and plum, as tabs by day and lamps by night. Extra and Bass are separated by lightness (the deutan collision is fixed) |
| System font, 800 weight, tracked CAPS labels | Instrument Sans for everything you operate; Fraunces Soft for what you read from across the room; sentence case |
| Every control is a 1 px grey box | Paper keys with a printed edge and a soft shadow; ON tiles have a darker bottom edge like a tab's binding |
| Fader caps are grey plastic | A paper cap with a grip line in the slot's colour |
| Generic meter logo | A sun rising over four lamp tabs (`mark.svg`) |
| "Click anywhere to start audio" | A Today sheet: the day, the set, last time, and one *Start sound* button |

---

## 3. Palette (hex, and contrast for every text/background pair used)

All ratios are WCAG 2.x, computed by `palette.py`. The rendered audit (§9) re-measures them on real pixels.

### 3.1 Neutrals

| Token | Day | Stage | Role |
|---|---|---|---|
| `--bg` | `#f3efe7` oat | `#171513` | the desk |
| `--panel` | `#fdfbf7` | `#211e1b` | a card |
| `--panel-2` | `#f6f2eb` | `#2a2623` | inset controls |
| `--panel-3` | `#ece6dc` | `#34302c` | hover, selected row |
| `--line` / `--line-2` | `#e5ded2` / `#d2c8b9` | `#35302b` / `#4b4540` | hairlines / control edges |
| `--text` | `#27211b` ink | `#f3eee4` paper | |
| `--muted` | `#5e554b` | `#cbc3b6` | |
| `--faint` | `#6f665b` | `#a9a093` | |
| `--accent` (fill) | `#f4b73f` | `#f6c35a` | current song, key, selection |
| `--dl-accent-text` | `#8a5300` | `#f6c35a` | amber *as text* |
| `--warn` / `--dl-warn-text` | `#eea43a` / `#8f4a00` | `#f7ad4a` / same | lock and hold only |
| `--panic` | `#d23f2f` | `#c9372a` | |
| `--dl-ink-on-lamp` | `#241a10` | `#1d1712` | text on any lamp or tab |

### 3.2 Text pairs

| Pair | Day | Stage |
|---|---|---|
| text on bg / panel / panel-2 / panel-3 | 13.9 / 15.4 / 14.3 / 12.8 | 15.8 / 14.3 / 13.0 / 11.3 |
| text on top bar | 15.0 | 15.0 |
| muted on panel / panel-2 / panel-3 / bg | 7.1 / 6.5 / 5.9 / 6.4 | 9.5 / 8.6 / 7.5 / 10.4 |
| faint on panel / panel-2 / panel-3 / bg | 5.5 / 5.1 / **4.5** / 4.9 | 6.4 / 5.8 / 5.1 / 7.1 |
| accent-ink on accent (current song chip, key, Start) | 9.2 | 10.1 |
| accent text on panel / panel-2 | 6.1 / 5.7 | 10.2 / 9.2 |
| lamp ink on Keys / Pad / Extra / Bass / Drone | 6.9 / 8.4 / 8.9 / **5.6** / 11.2 | 8.1 / 9.2 / 10.6 / 6.6 / 13.1 |
| slot-tinted text: `color-mix(slot 40–48 %, ink)` on panel | ≥ 4.7 (Extra, the lightest, is the lowest) | pastel, ≥ 9 |
| white on PANIC | 4.7 | 5.2 |
| key label on white key / on a held (amber) key | 5.5 / 9.2 | 5.5 / 10.1 |

### 3.3 Non-text (≥ 3:1 where it carries meaning)

| Pair | Day | Stage |
|---|---|---|
| fader track edge on panel | 3.2 | 3.7 |
| LED off on panel / top bar | 3.2 / 3.2 | 3.7 / 3.8 |
| muted fader on panel | 3.3 | 3.7 |
| wheel level line (ink/paper) on the wheel well | 12+ | 11+ |
| ON tab edge `color-mix(slot 62 %, ink)` on panel | ≥ 4 (every slot) | lamp itself ≥ 6.2 |
| lamp on panel | 1.9–3.0 (so the tab carries a printed edge, above) | 6.2–9.9 |

### 3.4 Slots and colour vision

| Slot | Day | Stage |
|---|---|---|
| Keys | `#f28a4c` tangerine | `#f39a62` |
| Pad | `#79c68f` sage | `#7fcb92` |
| Extra | `#7cc4ee` sky | `#8fd0f5` |
| Bass | `#a883d4` plum | `#b98bdc` |
| Drone | `#e4d3a8` linen (ink `#6c5728`) | `#eddcae` candle |

Minimum OKLab ΔE×100 between any two of Keys, Pad, Extra, Bass and Drone (Machado 2009 simulation):

| | normal | deutan | protan | tritan |
|---|---|---|---|---|
| Today's app | 14.7 | **0.6** (Extra ≈ Bass) | 5.6 | 8.4 |
| Daylight, day | 13.9 | **7.8** | 6.3 | 4.3 |
| Daylight, stage | 14.0 | **6.1** | 8.3 | 5.4 |

On paper a pale lamp can't carry state by colour alone (1.9–3.0:1 on the card). So a day ON tile is **colour + a
2.5 px darker bottom edge + an ink outline**, and OFF is a flat paper tile with a struck-through name. The same rule
(tint, plus an edge in the slot's ink) applies to chips in use, the open chip, and the selected tab.

---

## 4. Type

| Role | Face | Why |
|---|---|---|
| Everything you operate: labels, chips, numbers | **Instrument Sans** (OFL; wdth 75–100, wght 400–700; has `tnum`) | A warm grotesque, precise at 12 px and friendly at 17 px. The `wdth` axis earns its place: at ≤ 1250 px, chip names, strip names and Next set at 92 % width instead of truncating. `ss04`/`ss07` give the friendlier K and G. |
| What you read from across the room: song title, chord, the Edit sentence, the wordmark, sheet titles | **Fraunces Soft** (OFL; instanced SOFT = 100 and WONK = 0, keeping opsz and wght 500–800) | A soft serif with round terminals. It reads as a hymnal page or a handwritten setlist without looking churchy. Optical size is automatic, so the 46 px chord gets the display cut and the 21 px sentence the text cut. |

- Both fonts are subset to Latin plus the punctuation the UI uses (− U+2212, en and em dashes, curly quotes, ·, …,
  arrows). Neither has ♭ or ♯; the UI prints "Db / F#", so that's fine. Sizes: 61 KB + 55 KB woff2.
- **Fraunces never sets a changing number.** It has no `tnum`, so `--font-display` stays Instrument Sans (transpose
  and wheel values use it) and titles use a new `--dl-title`.
- Sentence case everywhere except physical labels (KEYS / PAD / EXTRA / BASS / DRONE on the lamps, PANIC, REC,
  MIDI). `headerChipRow` upper-cases its captions in JS, so the theme lower-cases them and capitalises the first
  letter with `::first-letter`.

---

## 5. Texture, light and motion, with performance notes

| Rule | How | Cost |
|---|---|---|
| **Paper tooth**: 1–5 % flecks on the desk only; cards stay clean | one 16 KB 128 px PNG tile as the first `body` background layer | painted once; `body` never repaints on meter frames (meters are their own layers). No `background-attachment: fixed`. |
| **Window light** (day) / **stage wash** (stage) | one static `radial-gradient` from the top left, as the second body layer | painted once |
| **Cards lift, keys press**: card shadow `0 1px 2px` + `0 6px 18px -10px` in warm brown; buttons get a 1 px inner highlight and a 1.5 px drop | static `box-shadow` | static. No shadow is animated; the lamp glow in Stage is the app's existing static glow |
| **ON tab edge** | `inset 0 -2.5px 0 color-mix(slot 62 %, ink)` | static |
| **Popovers unfold** (step panel, Quick, KEY ▾, menus, toasts) | 160 ms `opacity` + `translateY(4px) scale(.985)`, `cubic-bezier(.2,.8,.2,1)` | compositor only; runs once when opened |
| **Press** | `translateY(1px)` on `:active` | compositor |
| **Changing the light** | `document.startViewTransition()` around the `data-mode` change, crossfading once for 450 ms (`::view-transition-*` rules are in the theme) | one snapshot crossfade instead of hundreds of colour transitions |
| **Never** | no `backdrop-filter` (the theme turns the start overlay's blur *off*), no `filter`, no infinite animation, nothing breathing on the playing surface | |

Everything above is disabled under `prefers-reduced-motion`. **Not profiled:** I didn't run a paint profile under live
meters on the M-series Mac. Every layer is static, so I expect no per-frame cost, but that's an inference, not a
measurement.

---

## 6. Day, Stage, Auto: how the light is chosen

- **Auto** (the default, with no `data-mode`) sets `color-scheme: light dark`, so the Mac's appearance decides. With
  macOS Auto appearance, the rig turns to Stage at sunset.
- **Day / Stage** set `body[data-mode="day"|"dusk"]`. The control belongs in Quick › This Mac next to Touch, and on the
  Today sheet (mocked in `idle.png`).
- **Lock implies Stage**, and it's sticky. When Lock goes on, `main.js` sets `data-mode="dusk"` and leaves it there
  until the player changes it. Unlocking mid-service to fix something must never flood the room with white. That's
  why this isn't done in CSS with `body.perform-locked`, which would flip back on unlock.
- Glare check on the rendered frame (mean relative luminance, share of pixels with L > 0.45):

  | | mean L | bright share |
  |---|---|---|
  | today's app, Perform | 0.073 | 0.079 |
  | Daylight Stage, Perform | 0.076 | 0.077 |
  | Daylight Day, Perform | 0.85 | 0.92 (paper; not for a dark room, by design) |

  In Stage the piano's white keys are dimmed ivory `#cfc6b6` (the app's own UX H3 rule), and nothing larger than the
  amber current-song chip is bright.

---

## 7. Voice: a friendly stagehand, not a server monitor

Rules: second person, present tense, short. Say what happened and what to do. No "Oops", no "!", no church jargon.
"Set", "service", "soundcheck" and "practice" are fine. These are all real strings, with where they live:

| # | Today (source) | Daylight |
|---|---|---|
| 1 | "Click anywhere to start audio" (`index.html` overlay) | **Good morning.** Tap anywhere to wake the sound. *(or the Today sheet's* **Start sound***)* |
| 2 | "Your browser needs one click before it can play sound." | Your browser needs one tap before it can play. |
| 3 | "MIDI Blocked" (top bar) | Keyboard not allowed yet · *Allow* |
| 4 | "Loading…" / "Loading 15/19" (top bar) | Warming up sounds · 15 of 19 |
| 5 | "Ready" | Ready to play |
| 6 | "nothing changed" (Revert) | As saved |
| 7 | "No switch changes since the song was loaded" (Edit footer) | Just as you saved it |
| 8 | "My Pads: no folder chosen" | No pad folder yet. Songs use the built-in drone. |
| 9 | "MIDI was blocked — allow it in the browser’s site settings." (toast) | The keyboard is blocked. Allow MIDI in the browser's site settings, then plug it in again. |
| 10 | "Faded — play to resume" (faded chip) | Faded. Play to bring it back. |
| 11 | "Sound has stopped." / "Restart sound" (banner) | The sound stopped. · **Restart sound** |
| 12 | "Pick a part to edit it. The dot on a tab means a switch changed since the song was loaded." (Edit) | Pick a part to shape it. A dot means you changed something since the song loaded. |

Copy changes are JS and HTML edits, so they're outside this theme. They're listed so whoever lands the theme can land
the voice with it.

---

## 8. The daily hook: "Today"

A reason to open it on a Tuesday, and a moment on Sunday. Both surfaces are mocked in the screenshots only, because
they need JS in files other agents are editing right now.

**A. The Today sheet (`idle.png`).** The browser *requires* one click before audio, so that click becomes a moment
instead of a hurdle. It shows:
- the day and part of day ("Sunday morning"), the date, and a quiet count ("your 38th Sunday with the rig"; optional,
  and never a streak);
- the set: name, song count, estimated length (from song tempos and notes, if present), first key, and the first
  four songs with their keys, the first highlighted;
- **Last time**: date, minutes played, and the song and key you finished on (from a session log, §8.D);
- **Since then**: songs edited since the last service, in words;
- **Day · Stage · Auto**, and one big amber **Start sound**.

**B. The Today card on Perform (`today.png`).** It sits at the top of the Notes column and is about 110 px tall, so
the notes scroll under it:
- On a weekday: "Practice for Sunday / **Sunday 4 October** / in 6 days · song 1 of 6 · last played Prayer Wash in D,
  28 Sept".
- On the day: "Today / **Sunday morning** / song 3 of 6 · 18 minutes in".
- A six-segment progress line shows the set: songs done in amber ink, the current one in amber, the rest in pencil
  grey.
- At 1024 px there's no Notes column, so the card collapses into the Notes button's title.

**C. Where "next service" comes from.**
1. Parse the setlist name for a date: `4 Oct`, `Oct 4`, `4/10`, `2026-10-04`, `Sunday 4th`, and weekday words
   ("Sunday", "Wed night"). Take the next date ≥ today.
2. Otherwise, use the next Sunday.
3. On that day the card says "Today". Before it, "Practice for Sunday" and "in N days".

**D. The data.** This is one small append-only session log in the store: `{date, setId, minutes, lastSongId,
lastKey}`, written on Fade out of the last song or when the app quits. Unknown fields are kept (`migrate()` is
idempotent), so the schema doesn't change. "Since then" compares song `updatedAt` stamps to the last session date.

**E. End of set** (optional, same voice): after Fade out on the last song, the Today card says "That's the set. 52
minutes. Thank you." for 10 seconds. Then it rests.

---

## 9. Contrast audit (rendered, computed styles)

Method (`shoot.mjs`):
1. For every visible text node, read its computed colour, normalised through a 1 px canvas (the theme's
   `color-mix()` and `light-dark()` compute to `oklab()`), plus opacity, size and weight.
2. Re-shoot with all text transparent, so each run's box holds only what's really behind it.
3. Compare the median background pixel with the blended text colour. The need is 4.5:1, or 3:1 for large text
   (≥ 24 px, or ≥ 18.66 px bold).

| Shot | Text runs | Fails | Lowest |
|---|---|---|---|
| Perform 1440, day | 152 | 0 | 4.67 PANIC (white on red) |
| Perform 1024, day | 119 | 0 | 4.67 PANIC |
| Quick sheet, day | 133 | 0 | 4.67 PANIC |
| Today card, day | 159 | 0 | 4.67 PANIC |
| Edit 1440, day | 166 | 0 | 4.67 PANIC |
| Edit 1024, day | 101 | 0 | 4.67 PANIC |
| Perform 1440, stage | 152 | 0 | 5.17 PANIC |
| Edit 1440, stage | 166 | 0 | 5.17 PANIC |
| Today sheet (idle), stage | 32 | 0 | ≥ 5.9 |

The audit caught these, and they're fixed:
- PANIC lost its red to the shared button rule.
- Key labels on held amber keys were 3.1:1; they now use accent ink.
- A hovered current-song chip lost its amber; the hover rule now excludes `.current` and `.on`.
- The number on the selected Edit row in Stage was 4.45:1.
- Quick's "PEDAL DOWN" was 4.50:1.
- "Ready" in green on the top bar was 4.3:1; the day `--ok` is now `#287547` (5.3:1).
- Disabled **Revert / "nothing changed"** fell to 1.9:1 on paper at the app's `.45` opacity. Disabled controls are
  exempt from WCAG, but "nothing changed" is information. They're now dimmed by colour (flat, dashed, `--faint`) rather
  than by opacity.

---

## 10. Implementation notes for whoever lands it

1. **Linking.** Add `<link rel="stylesheet" href="./themes/daylight/theme.css">` after the edit CSS and
   `data-theme="daylight"` on `<body>`. A Settings › Appearance picker swaps `data-theme`. Add both fonts to
   `LICENSES.md` (OFL 1.1; the texts are in `fonts/`). About 150 KB in total.
2. **`perform.js fitSongName`** has to rerun on `document.fonts.ready`: Fraunces is wider than SF. In the preview, a
   1 px viewport nudge triggers its ResizeObserver.
3. **Light toggle**: `data-mode` plus `startViewTransition`, set to Stage on Lock and sticky (§6). Store it per Mac (Quick
   › This Mac), not per song.
4. **Token promotion.** The theme defines `--dl-well`, `--dl-key-white/black/edge/label`, `--dl-wheel`, `--dl-pop`,
   `--dl-lit`, `--dl-accent-text`, `--dl-warn-text`, `--dl-drone-ink` and `--dl-ink-on-lamp`, and overrides about 240
   app rules (most of them hard-coded colours) to use them. That's the research.md §5.4 promotion pass done from the outside. Moving those
   tokens into `styles.css` would shrink this file by about 40 %.
5. **Left as is on purpose.** The EQ keyboard canvas (`eq-keyboard.js`) paints its own dark colours. In Day it reads as a
   dark display window set into the page, like the screen on a keyboard. Re-theming it means reading tokens in JS.
6. **Unverified.**
   - Rendering on the Mac (SF fallback metrics, Retina hinting of Instrument Sans at 11–12 px).
   - The paint profile under live meters.
   - The ♭/♯ fallback, if the UI ever prints them.
   - Real-room glare of Day at a morning service. Day is meant for rehearsal; Stage is the service default through
     Lock.
