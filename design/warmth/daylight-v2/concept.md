# Daylight v2: one planner, two lights, and a reason to open it

This is a refinement of `design/warmth/daylight/`, made after the critique of v1 (score 7). It answers Ryan's note:
*"the design low-key looks a bit cold … not something that I would want to come back to on a daily basis."*

The v1 diagnosis still stands. The rig is a stage console seven days a week, so it feels like a tool and not a place.
The v1 cure was a warm paper Day, a warm Stage, and a Today hook. v2 fixes the parts the critique showed were still
cold or unfinished:
- It was a *warm dashboard*: every region was the same card.
- There were dashed placeholder boxes.
- The copy was server-monitor copy.
- The Stage neutrals were charcoal.
- The daily hook was a mock.

**Files.** Nothing here is linked from `index.html`, and nothing under `app/` outside the new folder was touched.
- **Theme:** `app/themes/daylight-v2/theme.css`, `fonts/` (Instrument Sans and Fraunces, OFL texts included),
  `mark.svg`, `sun.svg`, `moon.svg`, `today.svg`. v1's `paper.png` is dropped.
- **Daily hook:** `design/warmth/daylight-v2/today.js`. This is a working ES module, not a mock. Its landing path is
  `app/themes/daylight-v2/today.js`. It is kept out of `app/` for now because other agents are editing
  `app/js/**`, and a script under `app/` is more than a theme asset.
- **Evidence:**
  - `shoot.mjs` runs the real app with the theme injected and today.js imported through a Playwright route.
  - `palette.py` checks token contrast, OKLCH and colour vision.
  - `audit-*.json` holds the contrast of the rendered pixels, now including CSS-generated text, plus the glare figures.
- **Screenshots:**
  - Day: `perform.png`, `perform-1366.png`, `perform-1024.png`, `quick.png`, `edit.png`, `edit-tone-eq.png`,
    `edit-1024.png`
  - Stage: `perform-dusk.png`, `perform-1366-dusk.png`, `edit-dusk.png`
  - The Today sheet: `idle.png`, Sunday 09:12, Stage

---

## 1. What changed from v1, item by item

| # | Critique | v2 | |
|---|---|---|---|
| 1 | Stage is "decorated but still cold": neutrals at chroma ≤ 0.008 read as generic near-black | Walnut neutrals at OKLCH chroma 0.012–0.019, hue 57–67. `bg #1b1611`, `panel #261f19`, `panel-2 #2f2720`, `panel-3 #3a3129`, `line-2 #52463b`, `text #f5ede0`. A static **music-stand lamp** (an amber radial at 12 % alpha) sits behind the song title, which now prints straight onto the desk. Glare re-measured in §4 | **accepted** |
| 2 | Every region is the same white card, so it reads as a dashboard | What you **read** has no card. The song title and key, the chord and the setlist rail print onto the desk, and the chord gets a hairline rule instead of a box. **Notes** is a songbook page: cream stock (`#fbf5e8` / `#2a221b`), a pencil margin rule, faint ruled lines that scroll with the text, and Fraunces text at 16.5/27 px. What you **operate** keeps its card | **accepted**; the setlist rail and chord were added to the critique's list |
| 3 | Four dashed boxes read as wireframe placeholders | None left. Prev at song 1 is a flat label, *Start of set* (*Start* below 1440 px). Revert with nothing to revert is a flat *↺ Revert / As saved*. An empty EXTRA/BASS slot is a soft inset well with a round **+** and *Extra · add a sound* set in Fraunces. Edit's empty-tab stripe is a plain faint line | **accepted**, with one change: upright Fraunces instead of italic, because the vendored cut has no italic and a synthesised oblique looks cheap |
| 4 | The copy is still cold, so land §7 or don't ship | **Part landed with the theme** as a CSS bridge (§3). It changes the visible words and nothing else: DOM text and tests are untouched. **The rest is a JS string table** that is a blocker in the landing checklist (§6) | **accepted, partly**, because JS belongs to other agents right now |
| 5 | The daily hook is mocked | `today.js` is real. It reads the live store, keeps a per-Mac session log, parses the next service from the setlist name, describes what changed since last time with `shared/song-diff.js`, owns the Day · Stage · Auto light, and sets Stage on Lock, sticky. Every Today pixel in the v2 shots is rendered by it. Landing is one import in `main.js` | **accepted** |
| 6 | Auto following macOS is risky both ways | Auto stays the CSS default, because a CSS-only rule either flips back to white on unlock or never shows Day. The fix lives in today.js: (a) the sheet shows Day · Stage · Auto at every launch, so Day is always one tap away even on a dark-mode Mac; (b) with no stored choice, a **service-day morning pre-selects Stage** (`idle.png`); (c) Lock sets Stage and keeps it. | **accepted in JS; the CSS change was rejected** |
| 7 | The current chip's name is squeezed ("Sunday Pad + Piano") and the last chip is hard-clipped | This was not a fit rule. Instrument Sans has a narrow bold word space (about 0.19 em). Chip, strip, Next and tile names now get `word-spacing: .09em`. The rail ends in a static 36 px fade, a mask on the scroller's own box, so it never repaints on scroll | **accepted** |
| 8 | Notes are set in the operating sans | Fraunces text cut (see 2) | **accepted** |
| 9 | Drone ON looks disabled next to Keys and Pad | Linen stays. It is the slot colour furthest from amber (ΔE 10.5) and keeps the best deutan/protan separation. **Moving it to honey #e6cc8e would cut protan ΔE from 7.2 to 5.4.** ON now uses the drone's own ink: a 1.5 px edge, a 3 px printed bottom and a filled ON pill (6.4:1 day, 10.7:1 stage) | **accepted as a stronger edge, not a new colour** |
| 10 | The paper tooth is invisible at 1x | `paper.png` removed, saving 16 KB and one body layer | **accepted** |
| 11 | The EQ canvas stays dark and looks like a theming bug | It is still a dark display, because the canvas paints hard-coded colours (`eq-keyboard.js` 877–1265), but it is now framed as one: a walnut bezel with a 1 px highlight around `.eqk-graph`. Found while re-shooting: v1 left the band table's inputs with dark fields and ink text, which was unreadable (`edit-tone-eq.png` was never shot in v1). They are paper now, and the summary's slot-coloured words are 2.3:1 → ink-mixed, ≥ 4.7:1 | **accepted**; retheming the canvas itself needs JS (§6) |

---

## 2. Palette

All values are day / stage. Only Stage and a few new surfaces changed from v1.

| Token | Day | Stage (v2) | Stage (v1) |
|---|---|---|---|
| `--bg` | `#f3efe7` | `#1b1611` | `#171513` |
| `--panel` | `#fdfbf7` | `#261f19` | `#211e1b` |
| `--panel-2` / `-3` | `#f6f2eb` / `#ece6dc` | `#2f2720` / `#3a3129` | `#2a2623` / `#34302c` |
| `--line` / `--line-2` | `#e5ded2` / `#d2c8b9` | `#3a3029` / `#52463b` | `#35302b` / `#4b4540` |
| `--text` / `--muted` / `--faint` | `#27211b` / `#5e554b` / `#6f665b` | `#f5ede0` / `#cfc3b2` / `#ada08e` | `#f3eee4` / `#cbc3b6` / `#a9a093` |
| `--track-edge`, `--led-off` | `#958b7e` | `#877a6b` | `#7d756b` |
| `--dl-topbar` / `--dl-pop` / `--dl-well` | `#fbf8f2` / `#fffdf9` / `#ebe5db` | `#211a15` / `#2c241d` / `#140f0b` | |
| Notes stock (new) | `#fbf5e8`, margin rule `rgb(196 98 70 / .38)` | `#2a221b`, rule `rgb(232 150 110 / .30)` | |
| Lamp wash (new) | `rgb(255 236 196 / .55)` | `rgb(246 176 84 / .12)` | |
| Accent, slots, drone, panic | unchanged from v1 | unchanged | |

Stage OKLCH chroma (bg / panel / panel-2): **0.013 / 0.015 / 0.017** in v2, against 0.005 / 0.007 / 0.008 in v1.

**Text pairs** (`palette.py`, WCAG 2.x, day / stage):
- text on bg, panel, panel-3: 13.9 / 15.5; 15.4 / 14.0; 12.8 / 10.9
- muted on panel-3: 5.9 / 7.3
- faint on panel-3: **4.54** / 4.96 (the tightest designed pair)
- text / muted / faint on Notes stock: 14.7 / 6.7 / 5.2 by day, 13.5 / 9.0 / 6.1 on stage
- accent text on panel: 6.1 / 10.0
- lamp ink on the slots: ≥ 5.6 by day (Bass) and ≥ 6.6 on stage
- white on PANIC: 4.67 / 5.17

**Non-text pairs:**
- Track edge and LED-off: 3.24 / **3.89** (3.7 in v1).
- ON-tab edge: ≥ 4 by day.
- Stage lamps on the panel: 6.0–9.7.

`palette.py` prints `text on key_white` as LOW on stage (1.46). That pair is never used: stage key labels are
`--dl-key-label` on dimmed ivory, which renders at 5.83.

**Colour vision** (min OKLab ΔE×100 between slots): day 13.9 normal, 7.8 deutan, 7.2 protan, 4.3 tritan. Stage 14.0 /
6.1 / 8.3 / 5.4. Today's app is at 0.6 deutan, with Extra ≈ Bass.

---

## 3. Voice: what landed with the theme, and what still needs JS

**In the theme (CSS bridge).** Every swap below keys off a class or attribute that `main.js` / `perform.js` already
set, so it is always true to the state:

| Where | Before | v2 |
|---|---|---|
| Top bar, sound running, delay < 40 ms | `● Sound OK 12 ms` | *(hidden: calm when all is well)* |
| Top bar, sound paused, stopped, muted or slow | `● Sound OK 42 ms` | unchanged: it shows because it needs you |
| Top bar, loading | `● Loading 15/19` | `● Warming up…` (the setlist chips already spin per song) |
| Top bar, ready | `● READY` | `● Ready to play` |
| Top bar, MIDI caption | `MIDI Blocked` | `Keyboard Blocked` |
| Revert, nothing to revert | dashed box, `nothing changed` | flat label, `As saved` |
| Prev at song 1 | dashed box, `◀ Prev` | flat label, `Start of set` / `Start` |
| Empty slot | `EXTRA · empty` in tracked caps | `Extra · add a sound` in Fraunces |
| Start overlay (without today.js) | `Click anywhere to start audio` | `Tap anywhere to wake the sound.` |

Result: the healthy top bar is **one lamp plus one phrase** (plus the keyboard lamp while MIDI needs attention). The
shots show "Sound OK 42 ms" only because headless Chromium reports a 42 ms output delay, which is over the app's own
40 ms warning line.

Cost of the bridge:
- The visible words come from `::after` while the DOM keeps the old text, so a screen reader hears both, for example
  "nothing changed As saved".
- For that reason the bridge is **temporary**. Delete the "v2 status" block and the three `::after` swaps once the JS
  strings land.
- `test/phase2/ui-core/run.mjs:2118` measures the width of "Sound OK" at several window sizes. With the theme linked,
  the Sound item is `display: none` while healthy, so that geometry test needs a theme-off run or an update.

**Still JS (landing blocker, §6):**
- `main.js:625–631` MIDI values: `Blocked` → "not allowed yet", `No device` → "not plugged in", `Starting…`.
- `main.js:613` toast: "The keyboard is blocked. Allow MIDI in the browser's site settings, then plug it in again."
- `perform.js:1286`: "No pad folder yet. Songs use the built-in drone."
- `perform.js:315` / `1323`: "Faded. Play to bring it back."
- `index.html:57`: "The sound stopped." · **Restart sound**.
- `edit/lib.js:314`: "Just as you saved it".
- `edit/shell.js:643`: "Pick a part to shape it. A dot means you changed something since the song loaded."
- Tests that assert the old strings and must change with them: `test/phase2/ui-core/run.mjs:978` (`'Ready'`) and
  `:2566` (`'Sound OK'`), `components.hv2.mjs:1043`, `test/integration/smoke-chrome-fallback.mjs`.

---

## 4. Texture, light, motion and glare

- **Desk.** Two static gradients on `body`, painted once: the lamp pool at 15 % / 11 % of the viewport, over the song
  title, and the window light or stage wash. No image.
- **Notes ruling.** A `repeating-linear-gradient` on the scroller with `background-attachment: local`, so it is painted
  with the content and scrolls with it. Nothing is painted per frame.
- **Rail fade.** A static `mask-image` on the scroller's own box. The masked layer re-rasterises only when chips change.
- **Motion is unchanged from v1:**
  - a 160 ms unfold on popovers, and on the Today sheet;
  - `translateY(1px)` on press;
  - one 450 ms view-transition crossfade when the light changes, skipped under reduced motion.
- **Never:** no `backdrop-filter` (the start overlay's blur is off), no `filter`, no infinite animation.
- **Not profiled** on the M-series Mac under live meters. Every layer is static, so I expect no per-frame cost, but that
  is an inference, not a measurement.

**Glare** is measured on the rendered frame: the mean relative luminance, and the share of pixels with L > 0.45.

| Frame | mean L | bright share |
|---|---|---|
| Today's app, Perform (v1 measurement) | 0.073 | 0.079 |
| Daylight v1, Stage, Perform 1440 | 0.076 | 0.077 |
| **v2 Stage, Perform 1440** | **0.080** | **0.081** |
| v2 Stage, Perform 1366 | 0.083 | 0.082 |
| v2 Stage, Edit 1440 | 0.063 | 0.053 |
| v2 Today sheet (Stage, before the first tap) | 0.029 | 0.025 |
| v2 Day, Perform 1440 | 0.83 | 0.92 (paper, for daylight by design) |

The warmer, slightly lighter walnut and the lamp cost about +10 % mean luminance over today's app. The bright share is
+0.2 points and comes from the amber current-song chip and the lamps, not from large areas. The white keys stay dimmed
ivory `#cfc6b6` (UX H3). Lamps stay 6.0–9.7:1 on the panel, far more than enough to tell them apart at 1.5 m.
**Unverified in a real room.**

---

## 5. The daily hook: `today.js` (real, running in every shot)

`mountToday({ store, controller })` only reads the store and never calls the engine. Its own state is two
`localStorage` keys, per Mac like Edit's section state: `worship-rig.today.v1` (the session log) and
`worship-rig.light`. The store schema doesn't change.

**A. The Today card** sits at the top of the Notes column, 1366 px and up (`perform.png`, `perform-1366.png`).
- Weekday: "Practice for Sunday / **Sunday 4 October** / in 6 days · song 1 of 19 · last played Prayer Wash in D, 27
  Sept".
- On the day: "Today / **Sunday morning** / song 3 of 6 · 18 minutes in".
- A segment bar shows the set: done in amber ink, the current song in amber, the rest in pencil.
- It re-renders only when something it shows changes. The store notifies on every fader tick, so it compares a
  signature first.

**B. The before-service sheet** (`idle.png`) lives inside `#overlay-start`, so main.js's own pointerdown still unlocks
audio.
- It shows the day and part of day, the date and "your 3rd Sunday with the rig". The count is of service days in the
  log, is only shown from 2 on, and is never a streak.
- It shows the set, the song count and the first key, with the first four songs.
- **Last time:** date, minutes, and the song and key you ended on.
- **Since then:** in words, from `song-diff`'s watch list, for example "**Building Swell** has a longer swell. Nothing
  else changed."
- **Day · Stage · Auto:** these stop pointerdown propagation, so picking a light doesn't start the sound.
- **Start sound.**

**C. Next service.**
1. It is parsed from the setlist name: `2026-10-04`, `4 Oct`, `Oct 11`, `Sunday 4th`, `10/25` (month/day, or
   day/month when the first number is over 12), or weekday words ("Wed night").
2. A date in the past falls back to the next Sunday. So does anything unparseable.
3. This was checked in node against 9 names (in the run log, not a test file yet).

**D. The log.**
- One entry per app session: `{day, minutes, setId, lastSongId, lastKey}`. Minutes only count while the page is
  visible and audio is running, and the log is saved every 30 s and on `pagehide`.
- The set's songs are snapshotted as the next session's "since then" baseline, but only once a session passes 3
  minutes, so a quick peek doesn't reset it.
- The log keeps the last 120 entries.

**E. Fixture in the shots.** `shoot.mjs` seeds two earlier Sundays (47 and 52 minutes, both ending on Prayer Wash in D).
It also makes Building Swell's swell 2 s shorter in the snapshot, and pins "now" to Mon 28 Sep 10:20 or Sun 4 Oct 09:12.
Everything else is live data from the factory library.

**Not built:**
- The end-of-set "That's the set. 52 minutes. Thank you."
- The card at 1024 px, where Notes is a popover. It should become the Notes button's title.
- A node:test file for `nextService` and `describeChange`.
- today.js has about a dozen lines over 120 characters, which needs a lint pass on landing.

---

## 6. Landing checklist

1. Copy `design/warmth/daylight-v2/today.js` to `app/themes/daylight-v2/today.js`. Then:
   - In `index.html`: `<link rel="stylesheet" href="./themes/daylight-v2/theme.css">` after the edit CSS, and
     `data-theme="daylight-v2"` on `<body>`.
   - In `main.js`, after the views mount: `mountToday({ store, controller })`.
   - Add both fonts to `LICENSES.md` (OFL 1.1).
2. **Voice blocker:** land the §3 JS strings and their tests, then delete the CSS bridge rules.
3. `perform.js fitName` has to rerun on `document.fonts.ready`: Fraunces is wider than SF. The preview works around it
   with a 1 px viewport nudge.
4. Token promotion: move `--dl-*` into `styles.css`. That would shrink the theme by about 40 %.
5. EQ canvas: read `--eqk-bg` / `--panel` / `--text` in `eq-keyboard.js`'s paint so Day can have a paper graph.
   Optional: the bezel already makes the dark graph read as deliberate.

**Unverified:**
- Rendering on the Mac: SF fallback metrics, and Retina hinting of Instrument Sans at 11–12 px.
- A paint profile under live meters.
- Real-room glare of both lights.
- today.js across a real week of use, including midnight rollover while the app stays open.

---

## 7. Contrast audit (rendered)

Method (`shoot.mjs`):
1. Collect every visible text node, and in v2 **also every CSS `::after` label on a zero-size host**, so the bridge copy
   is audited too.
2. Re-shoot with all text transparent.
3. Compare the median background pixel with the blended text colour. The need is 4.5:1, or 3:1 for large text.

| Shot | Runs | Fails | Lowest |
|---|---|---|---|
| Perform 1440, day (with the Today card) | 161 | 0 | 4.67 PANIC (white on red); then 4.91 *Start of set* / *As saved* |
| Perform 1366, day | 155 | 0 | 4.67 PANIC |
| Perform 1024, day | 118 | 0 | 4.67 PANIC |
| Quick, day | 143 | 0 | 4.67 PANIC |
| Edit 1440, day | 166 | 0 | 4.67 PANIC |
| Edit, Tone EQ open, day | 159 | 0 | 4.67 PANIC (the v2 fix; there were 4 fails at 2.27 before it) |
| Edit 1024, day | 101 | 0 | 4.67 PANIC |
| Perform 1440, stage | 161 | 0 | 5.17 PANIC |
| Perform 1366, stage | 155 | 0 | 5.17 PANIC |
| Edit 1440, stage | 166 | 0 | 5.17 PANIC |
| Today sheet, stage | 39 | 0 | 5.86 |

Console and HTTP errors (excluding MIDI, which headless Chromium lacks): none across all 11 shots.
