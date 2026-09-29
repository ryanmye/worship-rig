# Sanctuary: a night-time nave for Worship Rig

Direction brief: calm and reverent. Deep ink-navy base, cream text, brass accent, tracked small-caps labels, a serif for
headings, a subtle stained-glass light in the drone card, opacity-only motion, and a "Before the service" screen with the
setlist and a breathing pad visual. Same H-v2 layout and components.

Deliverables:
- `app/themes/sanctuary/`: `theme.css`, `fonts/` (Alegreya + Figtree woff2 subsets and their OFL texts), `grain.png`,
  `mark.svg`, `lancet-glass.svg`, `lancet-light.svg`, `lancet-lead.svg`. It is not linked from `index.html`.
- This folder: screenshots of the real app with the theme injected (`perform.png`, `perform-1024.png`, `edit.png`,
  `edit-drone.png`, `edit-1024.png`, `quick.png`, `idle.png`), `shoot.mjs` (screenshots plus the contrast audit),
  `perf.mjs` (paint/raster A/B), and `contrast-audit.json` / `base-contrast-audit.json`.

Evidence tags: **[measured]** means computed or screenshotted here. **[read]** is my reading of the screenshots.
**[infer]** is reasoning I didn't test.

---

## 0. An honest note on the brief

The colleague's research (`../research.md` §1, C1) measured the coldness as *slate-blue neutrals*. This brief asks for
navy, so it keeps a blue base on purpose. What changes:

- **It stops being slate grey.** Today's neutrals are near-grey with a blue cast: OKLCH C 0.007–0.011 at hue 258–261°.
  That is the Tailwind look. Sanctuary's are a *chosen colour*: ink with a violet lean, C 0.038–0.040 at hue 277–279°.
  That reads as midnight velvet or a painted vault, not an unfinished grey **[measured]**.
- **Everything lit is warm.** Text, labels, thumbs, piano keys, the changed dots and the drone are cream/brass at hue
  82–90°. So the warmth comes from *light on a dark room*, the way candles work in a nave. It does not come from a warm
  floor.
- **Honest limit [read]:** next to the Ember probe (`../probe/warm-perform-1440.png`), Sanctuary reads as *reverent and
  night-time* rather than *cosy*. If Ryan's complaint is mainly colour temperature, Ember is the warmer answer. If it's
  "this looks like a generated tool, not a place", Sanctuary answers it too: through the book typeface, the window, the
  ritual screen and the voice. Show him both.

## 1. The idea

The app is a nave at night: a dark indigo vault, cream light, brass trim, and **one** stained-glass window.

- **The window is the drone card.** The drone is the pad that holds the room, so it gets the coloured light pooling in
  its corner (`.p-drone::before`). It breathes slowly while the drone sounds. It stays still when the drone is off or
  the rig is locked.
- **Songs are set in the book face.** The song title, key, chord, setlist names, "Next", the notes and Edit's
  plain-English sentence are all set in Alegreya, the way a service order or hymnal sets them. Everything you *press*
  stays in a clean sans (Figtree). One rule, applied everywhere, so the serif never decorates a control.
- **Labels are rubrics.** Captions (Transpose, Chord, Key & drone, Notes, This song…) are true small caps from the book
  face, tracked +0.09 em, in brass-cream. That's the look of a service leaflet, not tracked sans caps on a dashboard.
- **Lamps are glass.** An ON tile is lit glass: its slot colour, a highlight across the top and a soft halo. OFF is an
  unlit pane with a rim. The slot colours are the research's CVD-safe "warm v2" set.
- **Brass means "you are here":** the current song (a brass plate), the selected view, the key. Amber `--warn` stays
  reserved for lock/hold, and PANIC stays red.

## 2. Palette

### 2.1 Tokens (all in `theme.css`)

| Token | Hex | OKLCH | Role |
|---|---|---|---|
| `--bg` | `#0a0c1e` | 0.164 0.038 277 | the vault |
| `--panel` | `#131529` | 0.205 0.040 278 | cards |
| `--panel-2` | `#1c1e33` | 0.244 0.040 279 | controls |
| `--panel-3` | `#27293e` | | hover, selected rows |
| `--off-tile` | `#181a2c` | | unlit lamp |
| `--ev2-rig-bg` | `#0d0f23` | | Edit rig well |
| `--line` / `--line-2` | `#25273c` / `#3c3e52` | | rims |
| `--text` | `#f5ecd8` | 0.945 0.028 87 | cream, never white |
| `--muted` | `#cec1aa` | 0.815 0.035 82 | secondary |
| `--faint` | `#ab9d87` | | tertiary |
| `--label` | `#d3bf94` | | small-caps rubrics |
| `--accent` | `#e6ba65` | 0.811 0.115 82 | brass |
| `--accent-ink` / `--ink-on-lamp` | `#1c1406` / `#150f08` | | ink on brass / on lamps |
| `--warn` | `#f7a23d` | | lock / hold only |
| `--slot-0..3` | `#f78955` `#6ed889` `#7ad1f7` `#b073da` | | Keys ember · Pad green · Extra sky · Bass amethyst |
| `--drone` | `#edd9a6` | | the candle |
| `--fx` | `#cdbf9f` | | shared effects (pewter-cream) |
| `--panic` | `#d9363a` | | unchanged |
| glass | ruby `#d9485a`, sapphire `#3f66d8`, gold `#e6ba65`, emerald `#3fae7c`, amethyst `#8a5bd0` | | window only, 18–30 % alpha |

### 2.2 Text contrast, every pair used [measured, WCAG 2.x]

| fg ↓ / bg → | bg | panel | panel-2 | panel-3 | off-tile | rig |
|---|---|---|---|---|---|---|
| text `#f5ecd8` | 16.5 | 15.3 | 13.9 | 12.1 | 14.6 | 16.1 |
| muted `#cec1aa` | 10.9 | 10.1 | 9.2 | 8.0 | 9.7 | 10.7 |
| faint `#ab9d87` | 7.3 | 6.8 | 6.2 | **5.4** | 6.5 | 7.1 |
| label `#d3bf94` | 10.7 | 10.0 | 9.1 | 7.9 | 9.5 | 10.5 |
| accent `#e6ba65` | 10.7 | 9.9 | 9.0 | 7.9 | 9.5 | 10.4 |
| drone `#edd9a6` | 13.9 | 12.9 | 11.8 | 10.2 | 12.3 | 13.6 |
| warn `#f7a23d` | 9.4 | 8.7 | 7.9 | 6.9 | 8.3 | 9.2 |
| fx `#cdbf9f` | 10.7 | 9.9 | 9.0 | 7.8 | 9.4 | 10.4 |
| chip text `#a99d8b` | 7.3 | 6.8 | 6.1 | 5.4 | 6.4 | 7.1 |
| notes `#e9dfcb` | 14.6 | 13.6 | 12.4 | 10.8 | 13.0 | 14.3 |
| Edit sentence `#d8ccb5` | 12.2 | 11.3 | 10.3 | 9.0 | 10.8 | 11.9 |
| slot-0 Keys | 8.0 | 7.4 | 6.8 | 5.9 | 7.1 | 7.8 |
| slot-1 Pad | 10.9 | 10.2 | 9.2 | 8.0 | 9.7 | 10.7 |
| slot-2 Extra | 11.3 | 10.5 | 9.6 | 8.3 | 10.0 | 11.1 |
| slot-3 Bass | 5.8 | 5.4 | 4.9 | 4.3 ¹ | 5.2 | 5.7 |

¹ Bass is never set as text on panel-3. As a lamp (non-text) it needs 3:1, and it gets 4.3.

Ink on lamps (tile names, ON states, brass plates): Keys 7.9, Pad 10.7, Extra 11.1, **Bass 5.7** (the lowest), drone
13.7, brass `.seg.on` 10.5, current-song plate 9.1–12.0 (numbers `#4d3814` 5.6–7.0). PANIC white on `#d9363a` is 4.63,
unchanged from today. Piano key labels `#372c1d` on the ivory keys are 6.2–7.4.

Non-text: track edge on panel 4.3, LED-off on the top bar 4.0, muted fader 5.0 (all ≥ 3).

### 2.3 Audit of the real app (computed styles) [measured]

`shoot.mjs` walks every visible text node and resolves its colour, ancestor opacity and the alpha-composited stack of
backgrounds, including every gradient stop, and takes the worst case. Large text is ≥ 24 px, or ≥ 18.66 px bold.

| View | Text elements | Failing | Lowest (enabled) |
|---|---|---|---|
| Perform 1440 | 154 | 0 | 4.63 PANIC / Esc (unchanged) · next 5.45 "EXTRA · empty" |
| Quick sheet 1440 | 190 | 0 | 4.63 PANIC |
| Before the service | 24 | 0 | 5.74 |
| Edit 1440 (Keys) | 193 | 0 | 4.63 PANIC · next 5.37 list numbers |
| Edit 1440 (Drone) | 165 | 0 | 4.63 PANIC |
| Perform 1024 | 120 | 0 | 4.63 PANIC |
| Edit 1024 | 103 | 0 | 4.63 PANIC |

The first pass had one real failure: piano key labels at 4.69. I darkened them to `#372c1d`, which gives 6.2.

The same audit on today's theme (`base-contrast-audit.json`) has its lowest non-PANIC text at 4.64 (Edit list numbers,
`#8a93a0` on `#252a33`). Sanctuary's lowest is 5.37. Disabled controls are exempt from WCAG, but they still read
slightly better than today: Prev 3.02 vs 2.58, "nothing changed" 2.35 vs 2.17.

The window's glass and the vault (`body::after`) are pseudo-elements, so the audit can't see them. Two checks cover
them. The vertical "EXTRA · empty" labels sit directly on the vault: before it moved to `::after`, the audit measured
them at 5.45 against its brightest stop, `#1f2458`. The glass is handled by layout: every control inside the drone card has its
own opaque fill, and the bare label ("Key & drone") sits at the opposite corner, where the mask is at 0.

### 2.4 Lamps on stage [measured]

- **Colour-blind separation** (Machado 2009, OKLab ΔE×100, minimum pair among the four slots): normal > 9, protan > 9,
  **deutan 6.8** (today: **0.6**, Extra ≈ Bass), tritan 3.6 (Pad ~ Extra, a rare condition). With brass added, the
  closest pair is Pad ~ brass at 5.4 (protan/deutan).
- **ON vs OFF**: the lit lamps are 5.2–10.0:1 against the unlit `--off-tile`, and OFF also strikes the name through.
- **Glare**: the largest light areas are *dimmer* than today. The wheel fill has relative luminance 0.395 (today 0.469).
  The piano's white keys are 0.43–0.52 (today 0.52). The text is 0.844 (today 0.902), so cream reduces halation.

## 3. Type

| Role | Face | Where |
|---|---|---|
| Book (serif) | **Alegreya**, OFL, Huerta Tipográfica. Variable wght 400–900, with true `smcp`/`c2sc`, `tnum`, `lnum`. Latin subset **52 KB** woff2 | song title, key letter, chord, transpose number, wheel %, setlist names, Next, notes, Edit's sentence and song name, small-caps labels, Quick sheet title, "Before the service" |
| UI (sans) | **Figtree**, OFL, Erik Kennedy. wght 300–900, `tnum`. Latin subset **19 KB** woff2 | every control, value, dB readout and lamp name |

- **Why Alegreya.** I set four serifs on the navy at stage sizes (Source Serif 4, Newsreader, Alegreya, Crimson Pro).
  Alegreya was the only one with real small caps, tabular figures *and* enough weight at 40 px. Its calligraphic
  rhythm reads as literary and liturgical without being gothic. Source Serif 4 at display optical size was too thin
  on dark. Newsreader has no small caps **[measured, fontTools; read, specimen]**.
- It has `tnum`, so the research's gotcha (§5.5: Fraunces has no tnum) goes away. `--font-display` can point at the
  serif, and the transpose and wheel numbers stay steady (`lining-nums tabular-nums`).
- Small caps use `font-variant-caps: all-small-caps`, 15–16 px, weight 650, `letter-spacing: .09em`, in `--label`. Lamp
  names (KEYS, PAD, DRONE) stay in bold sans caps, because they are physical labels you read at 1.5 m.
- Neither face has ♭/♯. The app prints "Db/F#" today, so nothing changes (same caveat as the research).
- Loading: `@font-face` with absolute `/themes/sanctuary/fonts/…` URLs, same origin, so CSP `font-src 'self'` holds.
  `font-display: block` is safe because the files are local.

## 4. Texture and motion

**Texture** (all static):

| Layer | What | Cost |
|---|---|---|
| Vault | 2 radial gradients (an indigo light from above, a 11 % brass glow below the keyboard) plus a 128 px grain PNG (18 KB, alpha ≤ 16/255) | on `body::after`, `position: fixed`, `will-change: transform`, meant to be its own layer that rasters once (see below) |
| Panel edge | `inset 0 1px 0` brass at 10 % (lit from above) | static box-shadow |
| Glass | `.p-drone::before`: a conic-gradient of 6 jewel shards with thin "lead" gaps, masked to the card's upper-right corner | one layer, painted once |
| Lamps | a `linear-gradient(#fff 22 % → 0)` highlight on ON tiles | static |

**Motion**: opacity only, and only when nothing needs your attention.

| Moment | Motion | Rule |
|---|---|---|
| Drone sounding, rig unlocked | window glass breathes, opacity .62 ↔ .95, 8 s ease-in-out | stops for `.off`, `.perform.locked`, `prefers-reduced-motion`, and `data-low-resource` |
| Before the service | the window's light layer breathes, .35 ↔ 1, 6.4 s (about 9 breaths a minute) | the glass and lead layers are static |
| Quick sheet, step panel, overlay | 140–400 ms opacity fade-in | reduced-motion: none |
| Song loading | the title dims to .8 opacity | |
| **Never** | pulsing lamps, pulsing PANIC, moving gradients, blur | |

**Performance.** These were measured in headless Chromium, in a shared 2-CPU container with software raster. Other
agents' test suites pushed the load average to ~25 while I measured, so treat everything below as a lead, not a
result.

- **Solid.** Everything is static except one opacity animation per surface: no filters, no `backdrop-filter` (the
  start overlay drops today's `blur(3px)`), no `background-attachment: fixed`, no animated gradients or shadows.
- **Paint events over 5 s, idle** (measured when the box was quieter): today 29, Sanctuary 25, Sanctuary with the
  breathing disabled 14. Both themes show the same 13 full-viewport repaints, which come from the app, not the theme.
  The breathing did **not** add Paint events.
- **Raster with a chord held: inconclusive.**
  - The first runs had Sanctuary rastering more than today (261–1298 ms vs 159–223 ms per 6 s). I suspected the app's
    full-frame repaints were re-rastering the grain and gradients, so I moved the vault onto a fixed `body::after` with
    `will-change: transform` (its own layer).
  - An alternating A/B (`perf.mjs`) then gave a median paint+raster per 5 s of: today 7 ms, vault on `body` 977 ms,
    vault on its own layer 323 ms.
  - A follow-up that isolated the glass and the vault gave 151 ms and 2 093 ms for the *same* variant in consecutive
    runs. That's pure noise.
  - **Before shipping:** run `node design/warmth/sanctuary/perf.mjs base,sanct,still` on the Mac (GPU raster), and
    drop the grain tile first if Sanctuary costs measurably more than today.
- Whether the vault really gets its own layer is **unverified**. A CDP LayerTree check returned no layers in headless
  mode.

## 5. Voice

The voice is a verger or stage manager who likes you. It's plain and present tense, calm, and never cute. It uses no
exclamation marks and puts no scripture in controls. Worship words are fine where they are the real words (set,
service). Ten real strings, with where they live:

| # | Today (file) | Sanctuary |
|---|---|---|
| 1 | "Click anywhere to start audio" (`index.html` overlay) | **Before the service** · button *Start the sound* |
| 2 | "Your browser needs one click before it can play sound." (`index.html`) | Your browser asks for one tap before it can play. |
| 3 | "Loading 15/19" (`main.js:530`) | Preparing 15 of 19 |
| 4 | "Ready" (`main.js:523`) | All 19 ready |
| 5 | MIDI "Blocked" (`main.js:609`) | Keyboard not allowed yet |
| 6 | "Faded — play to resume" (`perform.js:312`) | Faded out. Play to bring it back. |
| 7 | "Next" (`perform.js:358`) | Up next |
| 8 | "No notes for this song. Add some in Edit." (`perform.js:1037`) | Nothing written for this song yet. Add a note in Edit. |
| 9 | "My Pads: no folder chosen" (`perform.js:1261`) | No pad folder yet. The built-in drone is playing. |
| 10 | "No switch changes since the song was loaded" (`edit/lib.js:314`) | Just as the song began |
| 11 | "Pick a part to edit it. The dot on a tab means a switch changed since the song was loaded." (`edit/shell.js:632`) | Choose a part to shape it. A dot means it has moved since the song began. |
| 12 | "My Set" default name (`store.js:1411`) | Today's set |

The theme can't change these; they need small JS/HTML edits by whoever owns those files.

## 6. The daily hook: "Before the service"

The browser *requires* one click before audio (`#overlay-start`), and today that click is spent on "Click anywhere to
start audio". Sanctuary spends it on a moment (`idle.png`, a mock built from the real store's setlist):

- **Left:** a double-lancet window with an oculus, in the four lamp colours plus brass. Its light breathes at about 9
  breaths a minute, the pad already "in the room". Under it: *The pad is ready in C* (the first song's key).
- **Right:** *Sunday morning · 28 September* in small caps, then **Before the service**, then one sentence: *19 songs in
  today's set, starting with Sunday Pad + Piano in C.* After that comes the first six songs, set like an order of
  service (name, then key in brass), and *Start the sound* (a brass pill), with "Last Sunday you ended on Prayer Wash ·
  Nord Stage 3 · sound OK at 42 ms".
- **Why it brings you back:** it knows the day and what's next, and it remembers last time. It takes zero extra clicks,
  because the tap you must make anyway is the one that starts the sound.
- **Build notes** (main.js; the CSS is already in `theme.css`, with classes prefixed `sanct-`):
  - Render the markup from `shoot.mjs › mountIdle` into `#overlay-start`, using the greeting from the time of day.
  - Read the setlist and keys from the store. Keep "last session" (song, device, latency) under one `localStorage` key.
  - Clicking anywhere keeps today's start handler.
  - Companion: after Fade out on the last song, one line, *That's the set. Thank you for serving.*, with a lamp-down.
    That one isn't built.

## 7. Shipping it

- **Loading.** One block serves both uses. `body:is([data-theme="sanctuary"], :not([data-theme]))` applies when the
  file is injected or linked plainly (no attribute), or when `data-theme="sanctuary"` is set. Any other `data-theme`
  value switches it off, so a Settings › Appearance toggle only needs to set `document.body.dataset.theme`.
  - I didn't write a literal duplicate unguarded block, because this guard covers the "simply injected" case without
    doubling 400 lines.
  - The guard adds (0,1,1) specificity, which is why no rule needs `!important`. It is also why I only override
    backgrounds on specific classes: a generic `.btn` background would beat single-class rules like `.btn-panic`. I hit
    that on the first pass (PANIC turned grey), and it's fixed.
- **Link order.** After `styles-edit-v2.css` and `eq-keyboard.css`. Add both fonts to `LICENSES.md` (OFL 1.1; the texts
  are in `fonts/`).
- **Size.** About 135 KB in total: fonts 72 KB, grain 18 KB, SVGs 6 KB, CSS 31 KB.
- **Not themed or not reviewed.** The Settings modal content, the EQ keyboard (`eq-keyboard.css`, 52 hex literals), Show
  wiring in use, the lock state and banners were not screenshotted. The research's token-promotion pass (§5.4) would
  let a theme reach them cleanly. I patched the leaks that show on these screens (the Fade out navy, toasts, piano,
  wheel, accidentals, `.ev2` token block, menus, the thumb gradients).
- **Nothing under `app/` changed** except the new `app/themes/sanctuary/` folder.

## 8. Reproduce

```sh
node design/warmth/sanctuary/shoot.mjs            # all screenshots + contrast-audit.json (≈ 6 min: waits for all 19 songs)
node design/warmth/sanctuary/shoot.mjs --base --only audit   # today's theme, for comparison
node design/warmth/sanctuary/perf.mjs base,vault0,sanct,still   # paint/raster A/B, chord held (run on the Mac)
```
