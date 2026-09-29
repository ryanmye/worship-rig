# Studio: the rig as a small analog console

Ryan's words: *"the design low-key looks a bit cold. It looks just like a vibe coded tool that you would use and not
something that I would want to come back to on a daily basis."*

**The idea.** Right now the app reads like a status dashboard. Studio makes it read like the desk in a small studio:
the thing a musician sits down at, puts their hands on, and trusts. It's warm the way good hardware is warm. The panel is
warm grey, the caps have weight, the lamps glow, a meter looks like a meter, there's a strip of walnut at the edge, and
the name of what you're playing is written on a strip of tape. Nothing in the layout moves. H-v2 stays exactly as it
is; only material, light, type and voice change.

The warmth comes from **touch and light, not decoration**. Every added detail is one a player would find on real gear:

| On a console | In Studio |
|---|---|
| Scribble strip: artist's tape with the channel name in marker | The song name and each strip's instrument sit on off-white tape with torn ends. The current setlist song wears the same tape: *the one on the tape is the one playing*. |
| Moulded caps, lit from above | Every pressable control has a 2-stop cap gradient, a 1 px top highlight and a drop shadow. When pressed, the cap goes *into* the panel (inset shadow + 1 px travel). |
| Backlit lamp buttons | ON tiles are lit caps: the light pools at the top, with a bloom around them. OFF tiles are unlit caps that keep 6–9 % of their lens colour. |
| LED lenses | Off: a dark lens with a specular dot. On: hot core → colour → dark rim, plus a two-layer bloom. |
| LED-ladder meters | The strip level bars and the top-bar meter are cut into segments. The unlit segments stay visible, so an idle meter still reads as a meter. |
| Fader caps with a coloured line | Brushed-metal caps with grip ribs and a stripe in the channel's colour. The fader track is a cut slot. |
| Mod wheel | The wheel track is ribbed and shaded like a cylinder in its well. |
| Walnut cheeks / trim | Only three thin trims: a 3 px strip under the top bar (the meter bridge), 7 px cheeks at both ends of the keybed, and the session sheet's top edge. |
| Tape counter / display windows | The REC timer and the chord readout sit in recessed windows. |

What it's *not*: photoreal wood, screws, fake VU needles, knobs where there are faders, or anything that makes a control
harder to read. The research's warning about "vintage plugin cosplay" (research §6, KnobSmith) is the guard rail. I
tested every material against the stage-legibility rules below.

Files:
- `app/themes/studio/theme.css`: tokens + about 240 rules. Toggle it with `body[data-theme="studio"]`; it also works when
  simply injected.
- `app/themes/studio/fonts/Rubik-var.woff2` (35 KB, Latin subset) + `OFL-Rubik.txt`.
- `grain.png`: a 12 KB, 128 px powder-coat tile.
- `tape-l.svg` / `tape-r.svg`: torn-end masks.
- `mark.svg`: an app mark showing one console channel (a fader cap, a walnut cheek, a lit lamp).
- `design/warmth/studio/shoot.mjs` (screenshots + pixel contrast audit + glare metric) and `palette.py` (OKLCH →
  hex, WCAG table, CVD ΔE).

Screenshots (the real app, theme injected with Playwright, 'Sunday Pad + Piano', C-major chord held): `perform.png`,
`perform-1024.png`, `edit.png`, `edit-1024.png`, `quick.png`, `idle.png` (session-sheet mock). `base-perform.png` and
`base-edit.png` are the same shots without the theme.

---

## 1. Palette

The neutrals sit at OKLCH hue ≈ 70°, chroma 0.006–0.010. That's warm grey, not brown (Ember) and not slate (today). The
desk is lighter than today's near-black (L 0.235 vs 0.158), so it reads as a surface you work on rather than a void.
It's still dark enough that the lamps carry.

| Token | Hex | Role |
|---|---|---|
| `--bg` | `#201e1b` | the desk |
| `--bg-deep` | `#161311` | recesses (fader slots, windows) |
| `--bridge` | `#1a1815` | meter bridge (top bar) |
| `--panel` | `#2a2723` | module face |
| `--panel-2` / `--cap-top`→`--cap-bot` | `#35312d` / `#3b3732`→`#312d29` | caps |
| `--panel-3` | `#3f3b36` | hover |
| `--line` / `--line-2` | `#3a3632` / `#534f4a` | seams |
| `--text` | `#f4f0e6` | ivory |
| `--muted` | `#cdc6bc` | labels |
| `--faint` | `#b2aba2` | quiet text |
| `--accent` | `#f7c367` | incandescent amber: current song key, selection |
| `--warn` | `#faaa49` | lock / hold only (unchanged meaning) |
| `--slot-0` Keys | `#f2955a` | amber-orange lamp |
| `--slot-1` Pad | `#80cd8b` | sage lamp |
| `--slot-2` Extra | `#9edaff` | sky lamp (lightest) |
| `--slot-3` Bass | `#b37fd2` | lilac lamp (darkest) |
| `--drone` | `#ebd9ae` | candle wax (kept from today's warm drone) |
| `--ink-on-lamp` | `#1f1915` | text on lamps and amber |
| `--tape` / `--tape-ink` | `#d0cabb` / `#2a221d` | label tape |
| `--panic` | `#c9372a` (cap gradient `#d4412f`→`#b93021`) | PANIC |
| `--walnut` | `#5a3a24 · #7d5236 · #6a452c · #8a5c3a · #5e3d26` | trims only |
| `--key-white` / `--key-label` | `#c8c0b2` / `#4d463e` | bone keys (same luminance as today's `#b9c0c9`) |
| `--meter-on-g/y/r` / `--meter-off` | `#79d28d` `#f2c14a` `#ef5a45` / `#34302b` | LED ladder |

### 1.1 Contrast: every text/background pair the theme uses (WCAG 2.x, `palette.py`)

| Text | Background | Ratio |
|---|---|---|
| text `#f4f0e6` | meter bridge `#1a1815` | 15.57 |
| muted `#cdc6bc` | meter bridge | 10.46 |
| warn `#faaa49` (MIDI Blocked) | meter bridge | 9.20 |
| ok `#79d28d` | meter bridge | 9.63 |
| muted | tape-counter window `#0f0d0b` | 11.45 |
| REC on `#ff8a78` | tape-counter window | 8.46 |
| text | panel `#2a2723` | 13.06 |
| muted | panel | 8.78 |
| faint `#b2aba2` | panel | 6.54 |
| text | cap (mid) `#36322e` | 11.17 |
| muted | cap | 7.50 |
| faint (chip numbers) | cap | 5.59 |
| step chip `#c8c0b5` | cap | 7.06 |
| FX chip `#ebe4d8` / sub `#b8b0a5` | cap | 10.06 / 5.93 |
| selected FX `#fffaf0` / sub `#e2d9cc` | `#504943` | 8.50 / 6.33 |
| accent-ink `#1f1915` | accent `#f7c367` (seg on, held keys) | 10.72 |
| tape-ink `#2a221d` | tape `#d0cabb` / tape bottom `#c9c2b2` | 9.55 / 8.81 |
| tape-ink-soft `#5b5147` (chip num/key on tape; name while loading, ≥ 28 px) | tape | 4.74 |
| lamp ink `#1f1915` | Keys / Pad / Extra / Bass / Drone | 7.63 / 9.12 / 11.53 / 5.70 / 12.47 |
| lamp ink | Bass lamp at its darkest (bottom edge, 90 % mix) | 4.68 |
| OFF tile name, faint | OFF cap `#302c28` | 6.09 |
| OFF pill `#e0d8cc` | `#2c2825` | 10.34 |
| white | PANIC mid `#c9372a` / lower `#b93021` (Esc) | 5.17 / 5.99 |
| Locked sub `#f0d7a4` | `#271d0b` | 11.81 |
| Faded `#ffdca6` | `#2e230c` | 11.78 |
| chord live `#fff6e2` / idle faint | chord window `#1b1815` | 16.44 / 7.78 |
| notes `#ece5d9` | panel | 11.87 |
| key label `#4d463e` | key face `#c8c0b2` / lip `#bcb4a6` | 5.15 / 4.52 |
| slot badge `#e6dfd4` | `#252220` | 11.95 |
| Edit sentence `#dbd3c7` | rig `#25221f` | 10.66 |
| Edit setlist row `#e2dbcf` | panel | 10.81 |
| Edit LIVE `#bfe8c7` | `#1f1c19` | 12.58 |
| popover text / muted / faint | pop `#34302b` | 11.51 / 7.73 / 5.76 |

Non-text: `--led-off` / `--track-edge` `#79736d` on panel 3.18, on the bridge 3.78. Keys lamp on panel 6.53; Bass lamp
on panel 4.87. The empty-slot dash `#6f6962` on the desk is 3.07 (today's is 1.89).

### 1.2 Rendered-pixel audit (`shoot.mjs`)

For every visible text run, the script takes the median background pixel from a re-shot frame with all text
transparent. That captures gradients, grain, glows and the Quick sheet's shadow. It then blends the text colour and
opacity onto that pixel and applies WCAG with the 24 px / 18.66 px-bold large-text rule.

| Shot | Text runs | Fails | Lowest |
|---|---|---|---|
| Perform 1440 | 152 | 0 | 4.65 (setlist number "1" on the tape) |
| Perform 1024 | 119 | 0 | 4.65 (same) |
| Quick 1440 | 133 | 0 | 4.79 ("Echo" label on a tinted step chip) |
| Edit 1440 | 166 | 0 | 4.79 ("Space" label on a tinted step chip) |
| Edit 1024 | 101 | 0 | 4.62 (same) |
| Session sheet (idle) | 31 | 0 | 6.26 |

(The final numbers are in `audit-*.json`. "Disabled (exempt)" rows are disabled controls at `opacity .45`, as today.)

One failure was found and fixed: with the Quick sheet open, the app's own 60 px drop shadow fell across the ON tiles and
pulled "ON" to 3.94:1. The theme gives the sheet a short 10 px shadow.

### 1.3 Glare (same metric on base vs Studio)

| Shot | Mean relative luminance | Share of pixels with L > 0.45 |
|---|---|---|
| Perform 1440, today | 0.073 | 7.9 % |
| Perform 1440, Studio | 0.086 | 8.6 % |
| Edit 1440, today | 0.057 | 4.9 % |
| Edit 1440, Studio | 0.071 | 5.8 % |

The desk is lighter by design. At 300 nits, +0.013 mean luminance is about +4 cd/m². The bright pixels are the keys (the
same luminance as today), the two tapes (L 0.59, the same as today's amber current-song chip) and the lamps. Nothing is
brighter than today's brightest element. If Ryan finds it bright in the room, `--bg` / `--panel` can drop 0.03 L without
touching anything else.

### 1.4 Colour vision (Machado 2009, min OKLab ΔE×100 between Keys / Pad / Extra / Bass / accent)

| | normal | deutan | protan | tritan |
|---|---|---|---|---|
| today | 14.7 | **0.6** (Extra ≈ Bass) | 5.6 | 8.4 |
| Studio | 11.1 | 5.8 | 4.7 (Pad vs amber accent; no slot pair is lower) | 8.0 |

Extra is the lightest lamp and Bass the darkest, so they separate by lightness. That fixes the existing deutan collision
without giving up tritan the way the research's v2 did (3.6).

---

## 2. Type

**One family: Rubik** (OFL, Hubert & Fischer et al.): the variable wght 300–900 file, subset to Latin, 35 KB woff2. It
has `tnum`, so the transpose, wheel, dB and timer numbers don't jitter. Its slightly rounded corners read like moulded
caps and rubber buttons, which is exactly the Studio material. It's humanist enough to be friendly, and sturdy at 700 on
a dark stage.

- UI: Rubik 500–700 (600 for labels, 700 for names and values).
- Tape (song name, strip instrument, setlist current): Rubik 650–700, −0.015em. The tape itself is the display
  treatment, so no second family is needed. A serif would pull toward "hymnal" (Sanctuary/Ember's territory); a marker
  font would be cosplay and harder to read at 1.5 m.
- Labels go from TRACKED CAPS to sentence case (13 px / 600, `--muted`). Caps stay only where they are a physical label:
  the lamp names (KEYS / PAD), PANIC, and the Edit tab roles.
- `--font-display` stays the same sans, so the research's `tnum` gotcha (§5.5) can't happen.
- Width: Rubik sets about 5 % wider than SF Pro. At ≤ 1250 px the theme takes a hair of tracking off the status lamps,
  Next name and drone labels. Checked at 1024: nothing collides or ellipsizes that didn't before.
- ♭/♯ and ↻ aren't in Rubik (the app prints Db/F#; ↻ falls back), as with every candidate in the research.

---

## 3. Texture, material and motion

### 3.1 Rules
1. **Materials are colour and light, never images of objects.** The only bitmaps are one 128 px grain tile and two
   8 px SVG masks.
2. **Every pressable is a cap; everything else is flat.** Panels get a 1 px lit top edge and a dark seam, not an
   outline.
3. **Wood only as trim**: at most 7 px wide, and never behind text.
4. **Tape only for names**: the song, the strip's instrument, and the current setlist song. Never on controls.
5. **Lamps and LEDs are the only things that glow.** Glows are static box-shadows, never animated.
6. **Nothing moves unless sound or your hands move it.** The meters move with sound, a cap moves when pressed, and a lamp
   flashes once (260 ms) when it's switched on. There's no ambient breathing on stage. That differs from Sanctuary and
   Ember on purpose: a console at rest is still.

### 3.2 Performance notes
- **No** `backdrop-filter` (the start overlay's `blur(3px)` is removed), **no** `filter`, and **no**
  `background-attachment: fixed`. The one `local` attachment is on the Notes text, so its ruled lines scroll with it.
- **Grain**: one 12 KB PNG tile drawn as a background layer on `body` and on each module. It's painted with the module
  and costs nothing per frame. A meter tick invalidates only the meter's small rect.
- **LED-ladder meters**: a static `mask-image` (repeating gradient) on `.lvl-meter` / `.meter-bar`. The existing
  `levelMeter.js` / `meter.js` still only change the cover's `transform: scaleY/scaleX`. The masked area is
  6 × ~250 px per strip and 72 × 8 px in the top bar. I didn't profile it on the Mac. It's the same repaint area as
  today's bar, plus a mask composite.
- **Lamp flash**: an `opacity` animation on a pseudo-element, which runs only when a tile goes from off to on (and once
  at boot). Transitions on tiles are 120–180 ms, colour and shadow only.
- `prefers-reduced-motion` turns off the flash and the tile transitions. `data-low-resource` (menu-bar mode) drops the
  grain and the wash.
- Paint was not profiled with a chord held on the M-series Mac. That's the one check to do before shipping (research
  §7.4).

---

## 4. Voice: the engineer who's on your side

Short, plain, a little studio: "line check", "session", "channel", "as saved". Present tense, second person, no "!"
in errors, no church jargon in the chrome. It's a friendly engineer, not a vendor or a server.

| Where (real string today) | Studio |
|---|---|
| Start overlay: "Click anywhere to start audio" | **Sunday morning** · *Start the session* (button) |
| Top bar: "MIDI Blocked" | Keyboard not allowed yet · **Allow** |
| Top bar: "LOADING 15/19" | Warming up · 15 of 19 |
| Top bar: "READY" | All sounds ready |
| Revert: "nothing changed" | As saved |
| Edit footer: "No switch changes since the song was loaded" | Just as you saved it |
| Edit rig hint: "Pick a part to edit it. The dot on a tab means a switch changed since the song was loaded." | Pick a channel to work on. A dot means you've moved something since loading. |
| Perform drone card: "My Pads: no folder chosen" | No pad folder yet. Songs use the built-in drone. |
| Toast: "Chrome will ask to use your MIDI devices — click "Allow"." | Chrome's about to ask about your keyboard. Say Allow. |
| Toast: "MIDI was blocked — allow it in the browser's site settings." | Your keyboard is blocked. Allow MIDI in Chrome's site settings, then come back. |
| Quick: "Sustain pedal · press it: light on?" | Press the pedal. Does its lamp light? |
| Quick: "Hold to restart audio" | Hold to restart the sound |
| Edit strip foot: "Same switches, same colours as your Perform strip" | Same channel as on your Perform page |

All of these are JS/HTML strings (`index.html`, `perform.js`, the edit panels, `quickSheet.js`), so a theme can't
change them. They're listed for whoever owns those files.

---

## 5. The daily hook: the session sheet and a line check

In a studio, every session starts the same way. You check the track sheet, then you do a **line check**: play each
source and watch its meter come up before anyone hits record. It takes 20 seconds, it's calming, and it's the moment you
know everything works. Worship keys players already do an informal version at every soundcheck.

Studio turns the click the browser *requires* (`#overlay-start`) into that ritual (`idle.png`):

- **Left: the session sheet.** "Sunday morning" (from the clock), the date, and *session 38*: a quiet count, no
  streaks. Today's set is on a strip of tape with its song count, followed by the first four songs and their keys on a
  ruled sheet. At the bottom is **Last session**: the date, the length, and where you finished ("Prayer Wash in D").
  That's the memory that makes it feel like *your* desk.
- **Right: the line check.** Four small LED ladders (Keys, Pad, Drone, Extra) plus a Pedal lamp. Play a chord and hold
  the pedal. Each lamp lights when its sound actually reaches the output (the existing slot level taps and the pedal
  lamp). Channels that aren't in the first song stay dark. "Start the session" (the required gesture) sits under it, so
  a player can check lines and go, or just go.
- **End of session** (not mocked): after Fade out on the last song, the tape counter stops and a one-line strip says
  "That's a wrap. 54 minutes, 6 songs." That line becomes next week's "Last session".
- **Why it brings you back on a Tuesday.** It's a place, not a tool: it knows the day, remembers last time, and
  gives you one small satisfying thing to do (the line check) that also proves the rig works. There's no gamification
  and nothing to "keep up".

The styles for the mock (`.studio-session`, `.ss-*`) ship in `theme.css`. The markup is in `shoot.mjs` `WELCOME`.
Wiring it needs `main.js` (the overlay), a store read for the last session, and a small session log write. There's no
schema change: the log is an optional field (see CLAUDE.md, "Store schema").

---

## 6. What the theme can't do alone (integration notes)

1. **Refit the song name after the font loads.** `perform.js` `fitName` runs on a rename or a song-block resize, not on
   a font swap. Rubik is wider than the system font, so a linked theme needs
   `document.fonts.ready.then(() => fitName.push())`. Without it, "Sunday Pad + Piano" can ellipsize until the next
   resize. In the screenshots, `shoot.mjs` nudges the viewport by 1 px to fire the ResizeObserver.
2. **Token promotion (research §5.4).** The theme overrides about 60 hard-coded literals selector by selector (piano
   keys, wheel, Fade out, toasts, pop-overs, Edit panels). Promoting them to tokens (`--key-white`, `--wheel-fill`,
   `--btn-fade-bg`, `--toast-bg`, `--ink-on-lamp`, …) would shrink the theme to mostly tokens. The token names are
   already declared at the top of `theme.css`.
3. **Linking.** Add `<link rel="stylesheet" href="./themes/studio/theme.css">` after the edit CSS, and set
   `data-theme="studio"` on `<body>` (or leave the attribute off). Add Rubik (OFL) to `LICENSES.md`. Package size:
   +97 KB in total (theme.css 44 KB, font 35 KB, OFL text 4 KB, grain 12 KB, SVGs 2 KB).
4. **Copy (§4) and the session sheet (§5)** live in JS that other agents are editing right now. Nothing under
   `app/js/**` was touched.
5. **Caps in the DOM.** "LIVE", "TAP" and "PEDAL DOWN" are upper case in the markup, and their containers are flex, so
   `::first-letter` can't be used to recase them. They read as physical labels, so I left them.

## 7. Risks and pushback

- **A lighter desk is a real trade.** It's what makes Studio feel like a surface, and it costs +18 % mean luminance.
  I measured it, and it's small in absolute terms, but only the room can decide. The fallback is one token change.
- **Tape is the most "personality" move, and the easiest to overdo.** It's limited to names. If Ryan finds the torn
  ends or the −0.5° tilt twee, drop the mask and the rotation, and the clean off-white strip still carries the idea.
- **Caps everywhere add visual texture.** On the header FX row (11 caps) it's busy up close. It reads fine at 1.5 m
  because the selected chip is the only one with a white rim. If it's too much, flatten `.fxc` back to panel-2 and keep
  caps for the big controls only.
