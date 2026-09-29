# Sanctuary v2: the nave, warmed

v2 of `../sanctuary/concept.md`, rebuilt after the daily-use critique (6.5/10: "premium dark mode", "decorated rather
than warm"). Same H-v2 layout, components and data model. Nothing under `app/` changed except the new
`app/themes/sanctuary-v2/` folder, which is not linked from `index.html`.

Evidence tags: **[measured]** means computed or screenshotted here. **[read]** is my reading of the screenshots.
**[infer]** is reasoning I didn't test.

Deliverables:
- `app/themes/sanctuary-v2/` (156 KB): `theme.css`, `fonts/` (Alegreya and Figtree Latin woff2, OFL texts, same files
  as v1), `mark.svg`, `triplet.svg` (the drone window), and `window-glass.svg` / `window-light.svg` / `window-lead.svg`
  (the start screen's window). v1's `grain.png` is gone.
- This folder:
  - Screenshots of the real app with the theme injected: `perform.png`, `perform-1366.png`, `perform-1024.png`,
    `edit.png`, `edit-drone.png`, `edit-1366.png`, `edit-1024.png`, `quick.png`, `idle.png` (a weekday),
    `idle-sunday.png` and `drone-off.png`.
  - `compare.png`: today, v1, v2 and Ember side by side.
  - `contrast-audit.json`.
  - Scripts: `shoot.mjs`, `palette.py` (tokens, WCAG, CVD, wheel glare), `windows.py` (generates the SVGs),
    `warmth.py` (colour temperature of a screenshot) and `perf.mjs`.

---

## 0. The honest number first

`warmth.py` measures the mean OKLab *b* (yellow +, blue −) and *a* (red +, green −) of each Perform screenshot. It
reports all pixels, and separately the "room" pixels (L < 0.35, about 86 % of the frame) **[measured]**:

| Perform 1440 | room *a* | room *b* | share of pixels on the warm side (b > 0) |
|---|---|---|---|
| today | −0.18 | −1.00 | 10 % |
| Sanctuary v1 (navy 277°) | +0.58 | −3.92 | 13 % |
| **Sanctuary v2 (plum 298°)** | **+1.84** | **−3.18** | 14 % |
| Ember | +0.96 | +1.10 | 99 % |

- v2 is *redder* than anything else here, and less blue than v1.
- On the yellow–blue axis it is still bluer than today. Today is a near-neutral grey, and a plum can't have positive
  *b*.
- So v2 fixes "cold" in the sense of *sterile, generated, nobody's room*, and it looks warmer side by side
  (`compare.png`) **[read]**. It does **not** beat Ember on colour temperature.
- If Ryan means literal temperature, Ember is still the answer. The knob is `H` in `palette.py`: hue 330 (aubergine)
  gives room *b* ≈ −1.9 at the same lightness **[measured, computed from tokens, not shot]**, but it drifts toward
  wine, and the critique asked for 290–300.

## 1. What changed, change by change

| # | Critique's change | Verdict | What I did |
|---|---|---|---|
| 1 | Make the room warm, not just the text | **Accepted, adapted** | Brass `inset 0 1px 0` rim raised 10 % → **18 %**. Every `.panel` gets a **6 % brass wash** at its top, fading out by 58 % of its height (≈ +3 % L, warmer). The song card gets a **10 % brass pool** from its top-left corner, and the vault a 12 % pool top-left (it shows in the gutters and the top bar). *Adapted:* a pool "behind the song-title card" can't show through an opaque card, so it's painted *in* the card. The wash is `background-image` only, so any colour the app sets on a panel still shows. All static. |
| 2 | Nudge the base to plum 290–300° | **Accepted** | Every neutral rotated from hue 277 to **298** at the same OKLCH L and C (`palette.py`): bg `#100a1c`, panel `#191327`, panel-2 `#221c31`, panel-3 `#2d273c`. Every hard-coded v1 indigo hex in the theme was rotated the same way. Contrast re-audited (§3). |
| 3 | Fade out: drop the blue-violet slab | **Accepted; wine rejected** | Panel-2 plane lit from above, a brass rim at 45 % and cream text, the same in Edit's keyboard bar. *Wine rejected:* a wine button next to PANIC would blur PANIC's rule of being the only red. `.faded` keeps the app's amber (a hold state). |
| 4 | Rebuild the drone window or cut it | **Rebuilt** | `triplet.svg` is three stepped lancets (an Early English triplet) with **6 hand-cut quarries**, dark lead (2.2 viewBox units ≈ 1.5 px at 30 px tall), each pane its own radial glow, a brass hood and sill. It sits in the drone card's **title row, top-right**, the one spot that is empty at 1024, 1366 and 1440 (measured with DOM boxes). So it *cannot* pass behind a control. The diagonal rays are gone. In Edit it's the last flex item of the drone panel's title row (`.ev2-panel:has(.ev2-drone) .ev2-title::after`), so it takes its own space, and the stray stripes in Options are gone. *Deviation:* the panes are opaque glass, not 25–35 % alpha, because nothing sits behind them. At that alpha a 30 px window just looked muddy **[read]**. **New meaning:** the window is *lit while the drone sounds* (breathing .78 ↔ 1 over 8 s), *unlit* (.3) when it's off (`drone-off.png`), and held still under Lock. It is a second, redundant drone indicator, never the only one. |
| 5 | Lamp tiles as lit glass; Pad toward emerald | **Accepted, tuned** | Vertical gradient from +0.05 L at the top to −0.065 L at the foot (*not* ~85 % L: at 85 % Bass ink drops to ~4.3). A sheen over the top half, a **1 px 40 % white inner highlight**, a lead-dark rim (`color-mix(slot 42 %, ink)`) and a 36 % same-hue halo. **Pad `#4ec491`** (emerald, OKLCH .74 .13 162), not the suggested `#5fc98a`, which put Pad/brass under protan at 4.4 ΔE. **Bass `#af80e1`** (slightly lighter) so ink clears 4.89 on the dark foot. The first v2 audit caught the ON badge (a dark chip on the dark foot, 4.40), so the badge is now a *cream* chip (min 7.85). |
| 6 | Wheel: candle gradient | **Accepted, dimmed** | Candle `#dcc28a` at the level edge, with a 3 px `#f3e2b4` meniscus, easing to brass `#bd8e44` 70 % of the way down and `#9f7536` at the base. I used a slightly dimmer edge than the suggested `#edd9a6` to keep glare down: mean fill luminance is **0.373**, against today 0.469 and v1 0.395 **[measured, palette.py]**. |

The other problems the critique raised, and what happened to each:

- **Top bar mixed three treatments.** Fixed. Status read-outs (MIDI, READY, MASTER, PEDAL, BEND, swell) are back to
  bold sans caps in `--muted`. Small-caps rubrics are only for section headings now. The top bar reads brand serif,
  then sans.
- **Grain invisible.** Removed. It showed nowhere at 1440, and it was the one unresolved raster cost in v1's perf notes.
- **"Before the service" was Sunday-only.** Now day-aware (§5).
- **Start-screen window looked like clip-art.** Rebuilt as `window-*.svg`, generated by `windows.py`:
  - irregular hand-cut quarries with wandering lead lines, no grid;
  - each pane its own off-centre radial glow;
  - glass mostly sapphire and ruby with gold, like pot-metal glass;
  - a sexfoil oculus instead of the cross;
  - only the light layer breathes.
- **The warmest parts need JS.** Still true, and a theme can't fix it. §6 lists the exact JS work. If only `theme.css`
  ships, he gets the Perform/Edit changes (§1), which carry most of the critique's points, but not the start screen or
  the voice.

## 2. Palette

| Token | Hex | Role |
|---|---|---|
| `--bg` / `--panel` / `--panel-2` / `--panel-3` | `#100a1c` `#191327` `#221c31` `#2d273c` | plum ink, OKLCH L .164/.205/.244/.289, C .037–.040, h 297 |
| `--off-tile` / `--ev2-rig-bg` / `--track` | `#1e182a` `#140d21` `#322b41` | unlit pane, Edit rig well, fader track |
| `--line` / `--line-2` | `#2b253a` `#423c50` | rims |
| `--panel-lift` / `--panel-rim` | `#e6ba650f` / `#e6ba652e` | the candle wash (6 %) and the lit top edge (18 %) |
| `--text` `--muted` `--faint` `--label` | `#f5ecd8` `#cec1aa` `#ab9d87` `#d3bf94` | cream, unchanged |
| `--accent` / `--accent-2` | `#e6ba65` / `#f1cd84` | brass, unchanged |
| `--slot-0..3` | `#f78955` **`#4ec491`** `#7ad1f7` **`#af80e1`** | Keys ember · **Pad emerald** · Extra sky · **Bass amethyst** |
| `--ok` | `#56cc97` | status green (sits with the emerald) |
| `--sel-fx` | `#392c52` | selected shared-effect chip |
| `--warn` / `--panic` | `#f7a23d` / `#d9363a` | unchanged |

## 3. Legibility [measured]

**Contrast audit of the real app** (`shoot.mjs`; every visible text node, alpha-composited over every gradient stop,
worst case). The audit now parses `oklch()`/`oklab()` stops, so the lamp tiles' relative-colour gradients are
included.

| View | Text elements | Failing | Lowest | Lowest non-PANIC |
|---|---|---|---|---|
| Perform 1440 / 1366 / 1024 | 154 / 150 / 120 | 0 | 4.63 PANIC (unchanged from today) | KEYS on the Keys tile's foot, 6.14 |
| Quick sheet 1440 | 190 | 0 | 4.63 PANIC | |
| Edit 1440 / Drone / 1366 / 1024 | 193 / 165 / 181 / 103 | 0 | 4.63 PANIC | list numbers, 5.39 |
| Start screen | 24 | 0 | 6.05 | |

Total: **1292 text elements, 0 failing**. Disabled controls are exempt, as in v1: Prev 3.02, "nothing changed" 2.36.

**Token pairs** (`palette.py`), minimum across bg, panel, panel+lift, panel-2, panel-2+lift, panel-3, off-tile and rig:

| Pair | Min contrast |
|---|---|
| text | 12.2 |
| muted | 8.1 |
| faint | 5.4 |
| label | 7.9 |
| brass | 7.9 |
| drone | 10.3 |
| warn | 6.9 |
| notes | 10.8 |
| Edit sentence | 9.0 |

Ink on the lamps' *darkest stop*: Keys 6.15, Pad 6.86, Extra 8.91, **Bass 4.89** (lowest). Their mid-tiles are 7.9,
8.7, 11.1 and 6.3. Ink on drone 13.7, ink on brass 10.0.

**Non-text:**

| Element | Contrast |
|---|---|
| lamp vs unlit pane | 5.7–10.1 |
| track edge | 4.3 |
| LED-off | 4.2 |
| muted fader | 5.0 |
| Fade out's brass rim on bg | 3.9 |

**CVD** (Machado 2009, OKLab ΔE×100, minimum pair among the four slots, then with brass added):

| Vision | 4 slots | + brass | v1 slots | today |
|---|---|---|---|---|
| normal | 15.1 | 11.5 | 16.3 | |
| deutan | **8.4** | 6.7 | 6.8 | 0.6 |
| protan | 10.7 | 6.0 | 15.4 | |
| tritan | **8.0** | 8.0 | 3.6 | |

Emerald fixed v1's weak tritan pair (Pad ~ Extra) and improved deutan.

**Glare:**

| Element | v2 | today |
|---|---|---|
| wheel fill, mean luminance | 0.373 | 0.469 |
| text | 0.844 | 0.902 |

The piano's white keys are unchanged from v1 (0.43–0.52). The only new bright things are a 30 px window and a 3 px
meniscus.

## 4. Type, texture, motion

- **Type.** Unchanged from v1: Alegreya for songs, Figtree for controls. One rule changed: *status read-outs are
  sans*. Rubrics (serif small caps) are only for section headings: Transpose, Chord, Key & drone, Notes, Next, Setlist,
  On stage.
- **Texture.** All static:
  - the vault (3 radial gradients on a fixed `body::after`);
  - the panel wash and rim;
  - the song-card pool;
  - lit-glass tiles (2 gradients and 4 shadows);
  - the window SVG.
- **Motion** is opacity only:
  - the drone window, a 118×33 px layer instead of v1's whole-card conic gradient, .78 ↔ 1 over 8 s while the drone
    sounds; still when it's off, locked, under reduced-motion or in low-resource mode;
  - the start screen's light layer, 6.4 s;
  - 140–400 ms fade-ins.
  - No blur, no `backdrop-filter`, no animated gradients.
- **Perf: unmeasured.** `perf.mjs` (base / v1 / v2 / still) couldn't produce numbers: the shared container was at a
  load average of 22–35, and tracing returned zero Paint events. **[infer]** v2 should cost no more than v1: it drops
  the grain and shrinks the only animated layer from the whole drone card to 118×33 px. Run
  `node design/warmth/sanctuary-v2/perf.mjs` on the Mac before shipping.

## 5. The daily hook: "Before you play"

The browser requires one click before audio, and Sanctuary spends it on a moment. v2 makes that moment true on any
day:

- **The heading follows the day.** It reads *Before the service* on Sunday (`idle-sunday.png`) and *Before you play*
  on other days (`idle.png`, a Monday evening). The date line is `<weekday> <morning|afternoon|evening> · <date>`.
- **The sentence names the set.** Weekday: *My Set has 19 songs, starting with Sunday Pad + Piano in C. Tap anywhere
  and the pad comes in.* Sunday: *…in today's set… while people come in.*
- **Memory is relative.** *On Sunday you ended on Prayer Wash* on a weekday, *Last week you ended on…* on a Sunday,
  then device and latency.
- **Window.** The new hand-cut window, with the light breathing about 9 times a minute, and *The pad is ready in C*.

## 6. What a theme can't ship (needs JS/HTML, by whoever owns those files)

1. `#overlay-start` markup: the `sanct-before` block from `shoot.mjs › mountIdle`, with the day logic exactly as
   written there. Clicking anywhere keeps today's start handler.
2. One `localStorage` record, `worship-rig.lastSession` = {songName, device, latencyMs, at}, written when a song is
   left or the app closes.
3. The voice strings from v1 §5: *Preparing 15 of 19*, *All 19 ready*, *Faded out. Play to bring it back.*,
   *Up next*, and so on.
4. The set's end: after Fade out on the last song, *That's the set. Thank you for serving.* Not built.

## 7. Shipping

- **Toggle.** `<body data-theme="sanctuary-v2">` (or `"sanctuary"`). Plain injection (no attribute) also applies it.
- **Link order.** After `styles-edit-v2.css` and `eq-keyboard.css`. Add Alegreya and Figtree (OFL 1.1) to
  `LICENSES.md`.
- **Size.** 156 KB, far inside the 500 MB app budget.
- **Needs Chromium 119+** for relative colour (`oklch(from var(--c) …)`) on the lamp tiles. Electron 44 is well past
  that. Older engines would drop the gradient declaration and fall back to the flat slot colour.
- **Not reviewed.** The Settings modal, the EQ keyboard, Show wiring in use, and the lock state and banners were not
  screenshotted (same gap as v1).

## 8. Reproduce

```sh
python3 design/warmth/sanctuary-v2/windows.py     # regenerate the window SVGs
python3 design/warmth/sanctuary-v2/palette.py     # tokens, WCAG, lamp ink, CVD, wheel glare
node design/warmth/sanctuary-v2/shoot.mjs         # all shots + contrast-audit.json (~8 min: waits for 19 songs)
python3 design/warmth/sanctuary-v2/warmth.py      # colour temperature table + compare.png
node design/warmth/sanctuary-v2/perf.mjs          # paint/raster A/B, on the Mac
```
