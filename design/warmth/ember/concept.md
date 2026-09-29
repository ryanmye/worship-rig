# Ember: a warm room you light before you play

**Files**
- Theme: `app/themes/ember/`
  - `theme.css`
  - `fonts/NunitoSans-var.woff2`, `fonts/YoungSerif-Regular.woff2`, and an `OFL-*.txt` for each
  - `grain.png`, `mark.svg`
- Preview and audit: `design/warmth/ember/shoot.mjs`
- Screenshots: `perform.png`, `perform-1024.png`, `edit.png`, `edit-1024.png`, `quick.png`, `idle.png`
- Audit output: `audit-*.json`

Nothing under `app/` is linked or changed. The shots come from the real app: it's served by `server.js`, Sunday Pad + Piano is
selected, a Cmaj7 is held through `controller.perform`, and the theme is injected with `page.addStyleTag`.

## 1. The idea

Today the rig looks like a monitoring dashboard: slate-blue greys, neon status colours, tracked caps and grey boxes.
Ember treats it as an instrument sitting in a dark room with one warm light source.

- **The body is charcoal with a brown heart.** Nothing is blue-grey. A faint hearth glow rises from behind the keyboard
  row.
- **Every sound is a lamp.** An ON tile is a lit lamp, with light pooled at the top, a warm halo and a lit label window.
  OFF is an unlit, recessed lamp.
- **A sounding strip glows with its own light.** A soft column in the slot's colour rises behind the fader and follows
  the level. At rest it goes dark.
- **The drone is a pilot light.** Its tile breathes slowly while it's on and the stage is unlocked.
- **Type has a voice.** A friendly humanist sans for everything you operate. A warm, heavy 70s serif for what you read
  from 1.5 m: the song title, key, chord, transpose and wheel values, and the wordmark.
- **The daily hook is lighting the room.** The browser already forces one click before sound. Ember spends that click on
  a welcome: what day it is, today's set, and how last time ended (§6).

Lineage: Nord (state shown as light on a body with one character) and Teenage Engineering OP-1 field (colour-coded
controls, muted earthy palette). Ember takes the warmth from materials (wax, brass, bone, terracotta), not from
ornament: there's no wood, no skeuomorphism and no illustrations on live controls.

## 2. Palette

The neutrals sit at OKLCH hue 50 with chroma 0.013–0.016. Above about 0.02 they turn muddy brown.

| Token | Hex | Role |
|---|---|---|
| `--bg` | `#150e0b` | room |
| `--bg-deep` | `#0d0806` | rings, recesses |
| `--panel` | `#1e1713` | panels (drawn at 93 %, so the hearth glow shows through a little) |
| `--panel-2` / `--panel-3` | `#28201c` / `#342b26` | buttons / raised |
| `--line` / `--line-2` | `#352d29` / `#4c433d` | rules / button rims |
| `--text` | `#f7efe3` | ivory, never white |
| `--muted` / `--faint` | `#c9bbac` / `#ac9b8d` | secondary / tertiary |
| `--accent` | `#f7b755` | amber coal: current song, key, selection |
| `--warn` | `#f5a33a` | lock / hold only (unchanged role) |
| `--slot-0` Keys | `#e68867` | terracotta |
| `--slot-1` Pad | `#a9daa4` | sage |
| `--slot-2` Extra | `#80b9de` | dusty blue |
| `--slot-3` Bass | `#bb79b5` | plum |
| `--drone` | `#edd9aa` | candle wax |
| `--fx` | `#cbbba5` | parchment (shared effects) |
| `--panic` | `#cf4232` | ember red |
| `--ink-on-lamp` | `#1e130e` | text on every lit tile |
| `--wheel-fill` | `#c4a77c` | brass (luminance 0.41, below today's steel at 0.47, so no extra glare) |
| `--key-white` | `#cdbfad` | bone (luminance 0.53, about the same as today's `#b9c0c9`) |

### Contrast: every text/background pair the theme uses (WCAG 2)

| Text | on | Ratio | | Text | on | Ratio |
|---|---|---|---|---|---|---|
| text | bg | 16.74 | | ink-on-lamp | accent | 10.27 |
| text | panel | 15.51 | | ink-on-lamp | Keys `#e68867` | 7.00 |
| text | panel-2 | 14.02 | | ink-on-lamp | Pad `#a9daa4` | 11.48 |
| text | panel-3 | 12.12 | | ink-on-lamp | Extra `#80b9de` | 8.58 |
| text | pop-bg `#261d18` (Quick, step panel) | 14.48 | | ink-on-lamp | Bass `#bb79b5` | **5.64** (lowest lamp) |
| text | toast `#2a201b` | 13.94 | | ink-on-lamp | drone | 13.08 |
| text | sel-fx `#43372f` (chosen FX chip) | 10.08 | | ink-on-lamp | warn (faded chip) | 8.82 |
| text | fade button `#2c2019` | 13.87 | | white | panic | **4.69** |
| muted | panel / panel-2 / panel-3 | 9.42 / 8.52 / 7.36 | | panic-text | panic-bg | 10.41 |
| faint | bg / panel / panel-2 | 7.12 / 6.59 / 5.96 | | key label `#5b4a3e` | bone key | **4.67** |
| faint | panel-3 / off-tile | 5.15 / 5.65 | | `#5a3f10` (chip no./key) | accent | 5.51 |
| accent | panel / panel-2 | 9.99 / 9.03 | | FX chip `#e6dbcc` / sub `#ab9a8b` | panel-2 | 11.70 / 5.88 |
| warn | panel | 8.58 | | Edit sentence `#dccfbf` | panel | 11.56 |
| drone / fx | panel | 12.72 / 9.43 | | LIVE `#b9e3b3` | `#1f2e1d` | 10.02 |
| text | chip-on tint (Keys / Pad / Extra / Bass) | 10.98 / 9.63 / 10.54 / 11.57 | | faded `#ffdca6` | `#2e2108` | 11.99 |

Non-text elements (need ≥ 3:1):

| Element | Ratio |
|---|---|
| Slot colours on panel | 6.81 / 11.16 / 8.35 / 5.49 |
| track-edge on panel | 3.61 |
| led-off on bg | 3.61 |
| led-off on panel-2 | 3.02 |
| muted-fader on panel | 3.93 |
| brass wheel on its track | 6.79 |

**Rendered audit** (`shoot.mjs`): the script takes each visible text run's computed colour, multiplied by its ancestors'
opacity, and compares it with the median *rendered* pixel behind it. It re-shoots with all text transparent, so grain,
the hearth wash, the translucent panels and the level glow are all included. It skips runs that are covered, such as
text under the Quick sheet.

| Shot | Text runs | Fails |
|---|---|---|
| Perform 1440 | 152 | 0 |
| Perform 1024 | 119 | 0 |
| Edit 1440 | 166 | 0 |
| Edit 1024 | 101 | 0 |
| Quick 1440 | 133 | 0 |
| Welcome | 30 | 0 |

The lowest pairs are the piano key labels (4.67) and PANIC's "Esc" (4.69). Disabled controls (Prev on song 1, and
Revert with nothing to revert) are exempt and reported separately.

**Colour-blind lamp separation** (Machado 2009 simulation, minimum OKLab ΔE×100 over Keys, Pad, Extra, Bass and accent):

| | Normal | Deutan | Protan | Tritan |
|---|---|---|---|---|
| Ember | 12.9 | **8.5** | 10.0 | 9.2 |
| Today | 14.7 | 0.6 | 5.6 | 8.4 |

Today, Extra and Bass are indistinguishable for deutan viewers. Ember staggers lightness (sage 0.84, blue 0.76,
terracotta 0.72, plum 0.665) so every pair stays apart under all three deficiencies.

## 3. Type

| Role | Face | Why |
|---|---|---|
| Everything you operate | **Nunito Sans** (OFL; wght 200–1000; opsz/wdth/YTLC pinned; Latin subset, 30 KB woff2) | Humanist and open with a large x-height, so it stays clear at 12 px on dark. It's friendly without looking like a kids' app, and its digits are tabular by default (every digit is 600 units wide), so `tabular-nums` still holds. |
| Title, key, chord, transpose, wheel %, wordmark, welcome | **Young Serif** (OFL; one heavy weight; 27 KB) | A warm, chunky 70s old-style that reads from across the stage and is on-genre for worship. It has a real `tnum` feature, so it can drive `--font-display` directly: the transpose and wheel numbers don't jitter, which was the Fraunces gotcha in research §5.5. |

- `font-synthesis: style` means Young Serif is never faux-bolded.
- I tried Atkinson Hyperlegible Next first and dropped it. Its slashed zero turned every "0", "100%" and "00:00" into
  "Ø". The transpose box read "Ø".
- Labels are sentence case. Caps stay only on the lamp names (KEYS, PAD, DRONE), which act as physical labels, on the
  Edit tab roles, and on PANIC.
- `headerChipRow.js` upper-cases "Space" and "Echo" in JS. The theme turns them back with `lowercase` + `::first-letter`.
  The clean fix is to drop that `.toUpperCase()`.
- Neither face has ♭ ♯ ⌘ or arrows, so those fall back to the system font. Check this on the Mac.

## 4. Texture, light and motion (and what they cost)

| Element | How | Cost |
|---|---|---|
| Hearth wash and vignette | Two static radial gradients on `body` | Painted once. No `background-attachment: fixed` and no filter. |
| Grain | `grain.png`, a 160 px tile (18 KB), warm speckle, alpha ≤ 20/255 | Static bitmap, costs the same as a solid fill. Invisible at 1.5 m; it takes the plastic flatness off up close. |
| Panels | 93 % opaque, a warm 6 % rim, a 1 px lit top edge, a long soft drop shadow | Static. |
| Lamp (ON tile) | A top-light gradient, a halo from `box-shadow`, and a radial LED dot | Static; nothing animates. |
| **Level glow** (CSS only, no JS change) | Restyles the existing `levelMeter` DOM. `.lvl-meter` widens to the fader track and moves behind the input (`z-index: -1` in an isolated track). Its `.lvl-cover` goes transparent and draws, below its own bottom edge, a centred beam of the slot colour at up to 24 % plus the thin level bar. `levelMeter.js` already scales the cover (`scaleY`), so the beam rises and falls with the sound. Two mask layers keep the bar whole and fade the beam's floor. At `.hot` (≥ −3 dB) the column is fully lit and the bar turns amber. | The cover gets `will-change: transform`, so a level change is a composite, not a repaint. That's one extra layer per filled strip. Menu-bar low-resource mode already hides `.lvl-meter`. |
| Drone breathing | `::after` halo with a static box-shadow, `opacity` 0.3 ↔ 0.85 over 7 s | Opacity only, compositor-only. Stops under Lock, `prefers-reduced-motion` and `data-low-resource`. |
| Start overlay | `backdrop-filter: blur(3px)` becomes a solid 85 % fill | Removes a live blur over the whole app. |
| Stills only | `shoot.mjs` injects `transition: none` for screenshots | Not part of the theme. |

**Unverified:** I didn't paint-profile this. Other agents were loading the box during the runs (load average 20–30,
rAF at about 2 fps at times), so any profile would have been noise. Before shipping, profile Perform on the M-series Mac
with a chord held: the level-glow layers, the mask and the grain under the live meters. The fallback is to drop the
mask (a hard beam floor) and keep everything else.

## 5. Voice: a friendly stagehand, not telemetry

Rules:
- Second person, present tense, 7 words or fewer where possible.
- No "Oops" and no "!" in errors.
- Worship-literate words are fine ("set", "service", "soundcheck"). Scripture and church jargon are not.

Ten real strings, rewritten:

| # | Where (today's exact text) | Ember |
|---|---|---|
| 1 | `index.html` overlay: "Click anywhere to start audio" | **"Sunday morning."** (day part from the clock) + "Tap anywhere to light the room." |
| 2 | Overlay sub: "Your browser needs one click before it can play sound." | "Your browser needs one tap before it can make sound." (kept as small print) |
| 3 | Top bar: "Loading…" / "Loading 16/19" | "Warming up · 16 of 19" |
| 4 | Top bar: "Ready" | "Ready to play" |
| 5 | Revert: "nothing changed" | "as saved" |
| 6 | Edit foot: "No switch changes since the song was loaded" | "Just as you saved it" |
| 7 | Drone card: "My Pads: no folder chosen" | "No pad folder yet. Songs use the built-in drone." |
| 8 | Faded chip: "Faded — play to resume" | "Resting. Play to bring it back." |
| 9 | Toast (`main.js:590`): "MIDI was blocked — allow it in the browser's site settings." | "Your keyboard isn't allowed yet. Allow MIDI in site settings." |
| 10 | Quick sheet: "Changes apply now. Keep playing." | "Changes are live. Keep playing." |

Two more for the rituals: the end of set reads "That's the set. Thanks for serving." and the idle state reads "Resting
in C major".

## 6. The daily hook: "light the room" (`idle.png`)

The one click the browser demands becomes a small ritual that knows what day it is. The mock is in `idle.png`; the
styles are already in `theme.css` under `.ember-welcome`, and nothing renders them yet.

1. **Welcome.** It shows the day part ("Sunday morning.", "Wednesday evening.") and one warm button, *Light the room*.
   The whole overlay stays clickable, just as today.
2. **Today.** The set name, song count and starting key, then the first four songs with their keys, with the first one
   lit amber. It's a Things-style "Today" rather than "My Set".
3. **Last time.** "Sunday, 21 Sept, 52 min. You ended on Prayer Wash in D." This needs a tiny session log (start, end,
   last song/key) in the store or in `localStorage`. There's no schema change: the field is optional, and `migrate()`
   keeps unknown fields.
4. **Lamps warming.** The Keys, Pad, Extra and Drone dots light as their samples decode. This is the same data as today's
   "Loading n/19", told as lamps coming on.
5. **At the other end:**
   - After Fade out on the last song, the lamps dim with the audio and one line reads "That's the set. Thanks for
     serving.", with the time played.
   - *Banked embers*: after 2 minutes unlocked and silent, the chrome dims to 70 %, the drone keeps breathing, and the
     key shows large and soft. Any note brings it back instantly. It never runs under Lock.

Why it works: it's a reason to open the app on a Tuesday to rehearse ("you ended on Prayer Wash in D"), it costs one
click the user already makes, and it never touches the playing surface.

## 7. Shipping it

1. Load: add `<link rel="stylesheet" href="./themes/ember/theme.css">` after the edit CSS, and `data-theme="ember"` on
   `<body>`, or leave the attribute off.
   - The file is **one** block under `:where(body[data-theme="ember"], body:not([data-theme]))`. `:where()` adds zero
     specificity, so the same rules work in both cases:
     - Injected with no attribute: it applies.
     - Toggled by attribute: it applies for `ember` and turns off for any other value.
   - The alternative, a guarded block plus an unguarded copy in the same file, would always apply and duplicate every
     rule.
   - Asset URLs are root-absolute (`/themes/ember/...`), so they resolve both linked and inlined, and stay same-origin
     under CSP `font-src 'self'`.
2. Token pass (research §5.4). The theme names the cold one-offs it overrides so a later pass can promote them:
   `--key-white`, `--key-black`, `--key-label`, `--wheel-fill`, `--wheel-track`, `--pop-bg`, `--pop-line`, `--toast-bg`,
   `--btn-fade-bg`, `--btn-fade-line`, `--accidental-bg`, `--ink-on-lamp`.
3. Add `LICENSES.md` rows for Nunito Sans and Young Serif (both OFL 1.1, no Reserved Font Name). The theme adds 57 KB
   of fonts and 20 KB of images to the app, well inside the 500 MB budget.
4. JS for the rituals (§6) touches `main.js` / `perform.js`, which other agents are editing, so none of it is done here.
