# Worship Rig warmth: options

Ryan's note: *"the design low-key looks a bit cold. It looks just like a vibe coded tool that you would use and not
something that I would want to come back to on a daily basis."*

Nothing under `app/` is linked or changed. Each option is a theme layer (`app/themes/<id>/theme.css` plus vendored OFL
fonts) that was injected into the running app with Playwright and screenshotted. The layout and components are H-v2,
unchanged. `options.html` in this folder has the same content with current-vs-themed screenshots side by side.

Evidence tags: **[measured]** means computed from pixels or tokens (script named). **[verified]** means read in the
code. **[critic]** means a critic agent's finding that I did not re-derive. **[infer]** means my own reasoning.

---

## 1. Why it reads cold (diagnosis)

Every cause below is visible in `test/phase2/ui-core/screenshots/perform.png` and `probe/base-perform-1440.png`.

| # | Cause | Evidence |
|---|---|---|
| 1 | **Blue-black neutrals.** `--bg #0b0d10`, `--panel #15181d`, `--line-2 #3a414d` all sit at OKLCH hue 255–261°, which is Tailwind's slate family and the default of generated dashboards. Over the room pixels (L < 0.35), today is OKLab a −0.18, b −1.00 (×100): slightly blue. | [measured] `styles.css:3-10`; the OKLab script in §4 |
| 2 | **Blue-white text.** `--text #f1f4f8` (hue 255°) at 16.1:1 on the panel. That is more than the stage needs; the warm options sit at 13–15:1 with ivory. | [measured] |
| 3 | **Neon slot colours.** `#ff8a3d #3ddc84 #4aa8ff #b784ff` sit at OKLCH chroma 0.155–0.18, near the sRGB ceiling. They read as status LEDs, not lamps. Extra and Bass also collide for deutan viewers (ΔE×100 0.6). | [measured] `research.md` §1 C2, §5.3 |
| 4 | **A uniform chip grid.** Nearly every region is a 1 px `--line-2` box with a 7–10 px radius: about 70 look-alike outlined boxes on one Perform screen (the 13 FX chips, the 12 drone keys, 8 strip chips, 6 setlist chips…). There is no light source and no depth, only outlines. | counted by eye on `probe/base-perform-1440.png`; `styles.css:67-77,293` |
| 5 | **System sans everywhere**, at weight 700–800 (`--font` and `--font-display` are both the SF/Segoe stack). Nothing about the type says *this* app. | [verified] `styles.css:37-38` |
| 6 | **Tracked caps micro-labels** (SPACE, ECHO, TRANSPOSE, KEY & DRONE, MASTER, WHEEL): 8 `text-transform: uppercase` rules at `.08em` tracking. This is the strongest "admin panel" tell. | [verified] `styles.css` |
| 7 | **No texture, light or motion.** Flat fills and no gradient anywhere. Nothing responds except the meters. | [shot] |
| 8 | **Dashboard density and telemetry voice.** The top bar greets you with `MIDI Blocked · Sound OK 42 ms · LOADING 10/19`; there is also "nothing changed" and "My Pads: no folder chosen". Nothing knows what day it is or what you played last time. | [shot]; `index.html:69-75` |

**Keep:** the plain-English Edit sentence, the Notes panel, the cream drone and the amber accent. They are already warm.

**What a theme alone cannot fix [critic, verified]:** about 150 lines of `styles.css` carry hard-coded hex values
(`grep -c`), and there are more in the edit CSS. Every option overrides those class by class (170–250 class names).
The daily hook and the copy need JS in every option.

---

## 2. How the options were scored

There were 4 proposals in round 1 (Ember, Sanctuary, Studio, Daylight). The top two were refined, and all were
re-scored. Each was scored 0–10 by three critics who re-shot the real app with the theme injected:
- **Warmth:** would a keys player want to open this every day; is it a place or a decorated dashboard?
- **Stage:** contrast, glare in a dark room, lamps and states read at 1.5 m, motion, and the four-slot colour language.
- **Build:** adoption cost and risk: token layer vs overrides, behaviour at 1024–1512 px, per-frame cost, fonts, how it
  ships.

| Round | Design | Warmth | Stage | Build | **Total** | Would use daily |
|---|---|---|---|---|---|---|
| 1 | Sanctuary | 6.5 | 7.5 | 7 | **7.00** | 3 of 3 |
| 1 | Daylight | 7 | 7 | 7 | **7.00** | 3 of 3 |
| 1 | Studio | 7 | 6 | 7 | **6.67** | 2 of 3 (Stage: no) |
| 1 | Ember | 6.5 | 6 | 6 | **6.17** | 2 of 3 (Stage: no) |
| 2 | **Sanctuary v2** | 7 | 7 | 7 | **7.00** | 3 of 3 |
| 2 | **Daylight v2** | **7.5** | 7 | 6 | **6.83** | 2 of 3 (Build: no) |

Ember was dropped. Its hearth glow never rendered (a specificity bug), Young Serif set old-style figures ("0" read as
"o" on Transpose), and its level glow cost +75 % compositor layer area [critic, measured by the critic].

---

## 3. Recommendation

**Ship Daylight v2, with its Stage (walnut) light as the default for everyone and Day as an opt-in. Fix the eight
points in §3.1 first.** Sanctuary v2 has the higher total, but:

1. **It isn't warmer than today.** Its own `warmth.py` measures its room pixels at OKLab b −3.18, against −1.00 today
   (bluer), and I reproduced that number. Daylight v2 Stage measures b +1.37. The complaint is literally "cold", and the
   warmth critic calls Sanctuary v2 "a plum night-mode with gold trim" whose v1→v2 changes are "nearly
   indistinguishable" at thumbnail size.
2. **Daylight v2 scored highest on the lens that is the complaint** (warmth 7.5, the best of any design in either
   round). Its lower total comes entirely from the Build lens, and every Build blocker is wiring, not look.
3. **The biggest Build blocker applies to every option, including Sanctuary.** [verified] `main.js:39` launches
   Electron with `autoplay-policy no-user-gesture-required`, and `app/js/main.js:873-878` only shows `#overlay-start`
   when audio did not start on its own. So on the Mac app, a start screen that replaces the audio-unlock click
   (Sanctuary's "Before you play", Daylight's Today sheet, Studio's session sheet, Ember's "Light the room") **never
   appears**. The Daylight critic caught this; the Sanctuary critics did not. Each hook needs its own trigger (the first
   launch of the day) whichever option is chosen.
4. Daylight's hook is real code (`daylight-v2/today.js`, 363 lines, read-only on the store). The other hooks are CSS
   plus a mock.

It is not a clean win. Daylight v2 Stage lowers slot chroma, so Pad and Extra drift apart less (ΔE×100 14 vs 26 today)
[critic]. The chord drops to a 22 px serif. The Today card eats Notes at 1366×768. Those are the first three fixes
below.

### 3.1 Must-fix before Daylight v2 ships (from its critics)

1. **Stage slot chroma.** Keep the four hues but set chroma ≥ 0.15 in the dusk branch, so every slot pair is ΔE×100 ≥ 20
   and Pad and Extra differ by ≥ 0.08 L. The pastels stay in Day only.
2. **Chord in sans.** `.chord-name` goes back to Instrument Sans 800 with lining, tabular figures at today's size. The
   idle chord colour becomes `--faint`, so the idle→live step is ≥ 2:1 again.
3. **Today card.** Hide it under Lock, and on a service day after song 2. Below 1440 × 800 collapse it to one line.
   Notes must never show fewer lines than today.
4. **Light choice.** Default to Stage when nothing is stored, **not** "follow the Mac": on a light-mode Mac, Auto
   paints paper (mean luminance 0.83) in a dark room. Lock forces Stage only for as long as it is locked. Apply the
   light instantly (no view-transition) when Lock or audio triggers it, so a PANIC tap can't land in a crossfade.
5. **A light switch people can reach:** Day · Stage · Auto in Quick › This Mac and in Settings › Appearance. The Today
   sheet gets its own first-launch-of-the-day trigger, independent of `#overlay-start`.
6. **Delete the CSS copy bridge.** The `font-size:0` + `::after` swaps get read twice by screen readers. Land the ~7
   strings in JS (main.js, perform.js, edit/lib.js, edit/shell.js, index.html) and update the 4 tests that assert them.
   The top bar's healthy state is one lamp plus one phrase, and it must be screenshotted.
7. **Flash-free boot:** `app/themes/boot.js` as a classic script in `<head>` sets `data-theme`/`data-mode` from
   localStorage before first paint; `color-scheme: light dark`; font preload; `document.fonts.ready.then(fitName)`.
8. **Guard rails:** drop the `body:not([data-theme])` branch. Add a selector-coverage test in ui-core that fails if any
   theme.css selector matches nothing across Perform/Quick/Edit/EQ, because other agents are renaming classes now.
   Fix the leftover dashed drone key (`styles.css:866`). Collapse the empty Extra/Bass wells into one narrow "+ Extra /
   + Bass" well.

---

## 4. Colour temperature, measured

This is the OKLab mean ×100 over the room pixels (L < 0.35) of the 1440 Perform shot, using the `sanctuary-v2/warmth.py`
method re-run over all shots. Positive b is yellow, negative b is blue.

| Shot | a (red+) | b (yellow+) | Room L |
|---|---|---|---|
| Today (`probe/base-perform-1440.png`) | −0.18 | **−1.00** | 0.208 |
| Sanctuary v2 | +1.84 | **−3.18** | 0.215 |
| Daylight v2 Stage | +0.69 | **+1.37** | 0.238 |
| Studio | +0.23 | +0.79 | 0.262 |
| Ember | +0.96 | +1.10 | 0.209 |

Daylight v2 Day is a paper theme (L 0.97, b +1.05 over the light pixels), so it doesn't compare directly.

---

## Option 1: Daylight v2, "one planner, two lights" (recommended)

`daylight-v2/perform-dusk.png` (Stage), `perform.png` (Day), `edit-dusk.png`, `edit.png`, `idle.png` (the Today sheet),
`perform-1366-dusk.png`, `perform-1024.png`, `edit-tone-eq.png`.
Theme: `app/themes/daylight-v2/theme.css`.

**Scores: Warmth 7.5 · Stage 7 · Build 6 = 6.83.** Would use daily: 2 of 3 (Build said no, because of the blockers).

**The idea:** Stage is a warm walnut desk (bg `#1b1611`, panel `#261f19`, OKLCH hue 57–67°, C 0.013–0.017) with ivory
text. Day is warm paper. Both are driven by `light-dark()` on every token, switched by one property. What you *read*
is printed onto the desk (song title, chord, setlist rail) or onto a ruled songbook page (Notes). Only what you
*operate* keeps a card. There are no dashed boxes. Type is Instrument Sans (61 KB) for controls and Fraunces Soft
(55 KB) for the song title and the Edit sentence, both OFL. Labels are in sentence case.

**Daily hook:** a real `today.js`.
- The Perform Notes column starts with a Today card. On a weekday it reads "Practice for Sunday · in 6 days · song 1
  of 19 · last played Prayer Wash in D". On a Sunday it reads "Today · song 3 of 6 · 18 minutes in".
- A before-service sheet shows "Sunday morning · your 3rd Sunday with the rig" (never a streak), last time and where
  you ended, and "Since then: Building Swell has a longer swell. Nothing else changed." (from `shared/song-diff.js`).
  It also has Day · Stage · Auto and one Start button.
- The next service date is parsed from the setlist name. Session minutes are logged only while audio runs. Two
  per-Mac localStorage keys hold this, with no schema change.

**Stage legibility:** 0 contrast fails across 11 shots. The lowest is PANIC at 4.67 (Day) and 5.17 (Stage)
[measured, shoot.mjs]. Stage glare is mean L 0.080 against 0.073 today. The bright-pixel share moves +0.2 pt. Nothing
animates per frame (no filter, no backdrop-filter, no infinite animation).

**Risks:** slot chroma (fix 1), chord size (fix 2), the Today card crowding Notes (fix 3). In Day, a lit drone-toggle
lamp is 1.43:1 on paper while the OFF ring is 3.24:1 [critic]: ON has to be the more visible state. Edit's EQ graph is
still a black display in a paper page.

**Effort: M.**
- PR1 (S–M): the theme, boot.js, and the Settings/Quick switch.
- PR2 (S): the strings, which removes the bridge.
- PR3 (M): `today.js` → `app/js/views/today.js` with its own trigger.

---

## Option 2: Sanctuary v2, "the nave at night" (highest total)

`sanctuary-v2/perform.png`, `edit.png`, `idle.png`, `idle-sunday.png`, `drone-off.png`, `perform-1024.png`,
`compare.png`. Theme: `app/themes/sanctuary-v2/theme.css`.

**Scores: Warmth 7 · Stage 7 · Build 7 = 7.00.** Would use daily: 3 of 3.

**The idea:** a plum-ink room (bg `#100a1c`, OKLCH hue 296–299°), cream text, and brass for "you are here". Song names,
Notes and the Edit sentence are set in the Alegreya book serif, with Figtree for controls (72 KB, OFL). The lamp tiles
look like lit glass. A small leaded triple-lancet window in the drone card lights while the drone sounds and dims when
it's off. The wheel is candle-coloured.

**Daily hook:** a start screen, "Before you play" on weekdays and "Before the service" on Sunday. It shows the day and
time of day, the set's first six songs set like an order of service, and "On Sunday you ended on Prayer Wash". There is
a breathing stained-glass window. This is only markup: it needs main.js work, and as specified it rides on
`#overlay-start`, which **never shows in the Electron app** [verified, §3 point 3].

**Stage legibility:** 1292 text nodes, 0 fails. The lowest is PANIC at 4.63, and the lowest non-PANIC is 5.39
[measured, shoot.mjs]. Glare is *lower* than today (wheel 0.373 vs 0.469). Deutan separation goes from 0.6 to 8.4.
The critic found three problems:
- held keys fade into the ivory keybed (1.11:1 vs 1.20:1 today);
- Fade out and Faded now look alike;
- "Movement" is cut to "Movem…" at 1024.

**Build:** the theme sits in `body:is(...)` at (0,1,1) specificity, so it beats the app's state rules. In
`drone-off.png` an OFF lamp **still glows** [critic, visible]. The OFF badge loses its outline, and the 1024 tracking
rule is lost. The breathing window is an infinite animation whenever the drone is on, which works against the
idle-CPU fix. `will-change` on a full-screen layer costs ~20 MB of GPU memory. Perf is unmeasured.

**Why it isn't first:** it measures bluer than today (b −3.18 vs −1.00), and the warmth critic reads it as "premium
dark mode", not warm. It is still the most *characterful* option. If Ryan loves the book-serif setlist and the window,
it is a legitimate pick, but only after the neutrals move to hue 330–345 and are re-measured at b ≥ −1.0.

**Effort: S** for the theme. The start screen and strings need JS as a separate ticket.

---

## Option 3: Studio, "the rig as a small analog console" (best non-finalist)

`studio/perform.png`, `edit.png`, `idle.png` (a mock), `perform-1024.png`. Theme: `app/themes/studio/theme.css`.

**Scores: Warmth 7 · Stage 6 · Build 7 = 6.67.** Would use daily: 2 of 3 (Stage said no).

**The idea:** a warm-grey desk (OKLCH hue ~70°). Every control is a moulded cap that sinks when pressed. The meters
become LED ladders with the unlit segments visible. Fader caps are brushed metal with a channel stripe. The song name
sits on a strip of off-white label tape, and there is walnut trim. One family, Rubik (35 KB, OFL). There is no
ambient motion, only a 260 ms "filament" flash on off→on.

**Daily hook:** a session sheet ("Sunday morning · session 38", today's set on tape, last session) plus a 20-second
line check whose lamps light as each sound reaches the output. It is mocked only and needs main.js and a session log.

**Stage legibility:** the text audit holds. But:
- The current setlist song loses its amber and becomes beige tape, and the same tape appears six times, so "where am
  I in the set" is harder to find at 1.5 m [critic].
- Tape reads like a lit lamp (ΔE 6.3 from Drone ON).
- Glare is +20–24 % with four slots filled.

**Build:** the cleanest layer. It uses `:where()` throughout and all ~230 targeted classes exist [critic]. But the
desk-lamp pool and grain never render (`body { background }` wins), and its asset URLs are root-absolute, so they 404
under the edit-v2 harness.

**Why third:** it is warm by material, not by light. The warmth critic says "caps everywhere flatten the hierarchy…
reads like a plugin screenshot". The Stage critic said no.

**Effort: M.**

---

## 5. How it ships (for whichever option is picked)

- **Theme layer.** Put it in `app/themes/<id>/theme.css`, with every rule inside
  `:where(body[data-theme="<id>"])`. That has zero specificity, so it wins on source order and the app's
  state/media/`:disabled` rules still win on specificity. Fonts go in one shared `app/fonts/` with their OFL texts,
  added to `LICENSES.md`. The total is under 0.2 MB against the 500 MB budget.
- **Settings switch.** Add Settings › Appearance › *Look*: **Warm (default)** · Classic. For Daylight, also add
  *Light*: **Stage (default)** · Day · Auto, mirrored in Quick › This Mac. Store the look as an optional
  `settings.look` field (absent means the default, so there is no schema bump; `migrate()` keeps unknown fields). Store
  the light per Mac in localStorage, because it depends on the room. Log both in `CONTRACT_CHANGES.md`.
- **Boot.** A tiny classic `app/themes/boot.js` in `<head>` (CSP allows `'self'`) sets the attributes before first
  paint. `index.html` links only the active theme.
- **Recommended default:** the warm look is on for everyone, and Classic stays available for one release as the
  rollback. The light is Stage, because it is the dark-room-safe choice. Day is what Ryan picks for weekday practice.
- **Tests:** add a theme-on pass of the ui-core Perform suite, a selector-coverage check, and the contrast audit
  (`shoot.mjs`) against the real theme file, including ON/OFF lamp pairs, Faded, Lock and chord held.
- **Before it becomes the default,** profile on the Mac: drone on, meters still, theme vs Classic, accepting a
  compositor/GPU difference of 0.5 points or less. Nobody has measured this on Apple Silicon [unverified].
