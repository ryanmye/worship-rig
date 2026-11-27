# U-CVD (D32, Colour-blind colours): skeptic review (2026-11-27)

Verdict: **PARTIAL**. It is shippable as a setting, but design calls are open. Off is today's app: across 8 themes × today's
and v6 Perform / Edit / Settings, every computed style and every canvas is identical to the base, except for the new
row and the height it adds. Both purity probes are identical too. The palette numbers hold up. I re-implemented
Machado 2009 and OKLab separately and got the builder's table to two decimals. The ON-window inks match what Chromium
draws. I fixed three defects on lane-cvd, each with a test that fails before its fix:

- F1: numbers floated off short range bars.
- F2: screen readers read the numbers.
- F3: canvases kept the old colour after a live toggle.

It stays PARTIAL, not VERIFIED, for two reasons. Number badges still collide on short bars that share a range when
a song has 10 or more instruments (O1). And the palettes themselves need Ryan's eye (O2–O4).

Under review: lane-cvd 56b3b8e, 53385d2, 41b9774 and fcffe43, rebased by the orchestrator onto v2-native 36ef998. My
fix was c320833. I then rebased the lane onto v2-native c10ad59 (lane-fu), which made the lane ace72a0, 12505d8,
fc1fae6, 3e825d0 and fix 31b0f09; this file is the commit after them. CONTRACT_CHANGES conflicted, and I kept both
sides: "U-SNAP follow-up" and "Empty-library silence" come first, then "U-CVD". lane-fu's changes to v6
edit.js / effects.js / instrument.js (the snapshot-aware Space & Echo summaries) don't touch `slotColor`. The gates
below ran on the rebased tip. `app/js/engine/` is untouched. The probe scripts ran against
lane-cvd and against a `git archive` copy of origin/v2-native in /tmp. They are not committed.

**Rebase (36ef998, the orchestrator's).** CONTRACT_CHANGES keeps both sides: "## UI v6 polish batch 2" ends whole,
and "## U-CVD" follows it. In
ui-v6 run.mjs, the U-SNAP / polish2 imports and calls stand, `cvdTests` runs after them, and the purity DOM filter
has all three rows. There are no conflict markers. With the rebase, the badges appear on:

- Edit's draggable bottom bars (U-EDITRANGE);
- the On Stage card's strip;
- the 16-tab Edit row (screenshot `UI6-cvd-shots/v6-edit-16-split-sanctuary-rg-1280.png`).

## Findings (fixed)

- **F1: a range bar's number sat past the end of its bar.** The badge went at `left: 2px + i × 16px` from the bar's
  start, whatever the bar's width. On a split song, position 7 (114 px) on a 1-octave bar (≈ 137 px at 1280) is at
  the edge. Positions 9–15 on short bars land beyond the bar's end, over the keyboard or another bar's line.
  - Measured at 1280 × 800 with 16 split instruments: positions 10, 12 and 16 were off their bars, and positions 1,
    7 and 13 were on 12 px slivers. At 820 × 1180 and 1180 × 820 it was the same or worse.
  - In the ui-v6 suite's own 8-instrument song, Sub Bass's default range is a 39 px bar, and its "3" overhung it.
  - Screenshot: `UI6-cvd-shots/F1-before-split-bars-1280.png`.
  - Fix: `left: clamp(0px, calc(2px + i × 16px), calc(100% − 20px))`. Test: ui-v6 "U-CVD skeptic F1". Every
    number lies inside its bar when the bar is ≥ 24 px wide. Position 7 sits on a fifth.
- **F2: the numbers were read out.** Generated content is in Chromium's accessibility tree. With cvd on:
  - the strip's name button became "2 Warm Pad";
  - Edit's tabs became "1 Grand Piano −1.9 dB";
  - the "Instrument ranges" group read "1 2 3 …".

  Accessible names changed with a visual setting.
  - Fix: `content: var(--cvd-n) / ''` (empty alt text). It sits inside `@supports (content: 'x' / '')`, so an engine
    without the alt syntax keeps the plain number. Without the wrapper, a var() declaration would be invalid at
    computed-value time and the badge would vanish. The native floor is iPadOS 17.5; I have not verified when WebKit
    added the alt syntax.
  - Test: ui-v6 "U-CVD skeptic F2". The aria snapshots of the strips row, the range group and Edit's tabs are
    identical Off and on. `cvd-palettes.test.mjs`'s guard check now looks inside the `@supports` wrapper.
- **F3: canvases kept the old colour after a live toggle** (the builder's stated risk). It is visible on the main
  screens. I measured the most common saturated pixel against `--slot-N` after toggling Red–green with the view open:
  - v6 Edit › Tone EQ: the plot and the key strip stayed in the Off colour (`122,209,247` vs `0,194,252`).
  - Today's Edit slot panel: the EQ mini curve stayed in the Off colour. So did the response-curve spark (it also
    ignored theme switches before).
  - The colours were only right after a rebuild (another slot, then back).

  Fix:
  - `eq-palette.js` `onThemeChange` also observes html's `class`. Only cvd toggles a class on html, which I checked
    with grep.
  - `panels/slot.js` redraws the spark on it.

  Tests: ui-v6 "U-CVD skeptic F3" (Tone EQ key strip) and settings [app] "U-CVD skeptic F3" (today's response curve,
  toggled through the Settings row). Both failed before: drawn `122,209,247` vs `0,194,252`, and `61,220,132` vs
  `128,165,90`.

## Checks that held

- **Palettes.** I wrote an independent script (Machado 2009 severity 1.0 on linear sRGB, OKLab, WCAG). For all 16
  palettes it reproduces `cvd-check.mjs`:
  - min ΔE×100 under simulation is 10.27 (nave rg, 1–7 deutan) to 12.13;
  - neighbour ΔL (7–0 included, normal and simulated) is ≥ 0.090;
  - lamp ink flat is ≥ 5.20.

  Hand checks, ink flat / in the ON window: Classic rg slot 3 `#908dff` 6.80 / 4.90; Ember rg `#f25300` 5.21 / 7.36;
  Sanctuary Day rg `#a95113` 5.21 / 7.09; Nave rg `#ff7217` 6.95 / 4.90.

  `THEMES` (ink and window colour / alpha) matches the lit ON tile's `.ot-state` in Chromium for all 8 themes. On
  Sanctuary Day, the tile's white gloss gradient (≤ 20 %) still leaves cream ink ≥ 5.1 : 1 in the window.
- **Every theme × type × UI, on.** With 16 instruments and Red–green / Blue–yellow on in all 8 themes, in today's and
  the v6 Perform:
  - `--slot-0..15` resolve to `palette[i mod 8]` on body, `.v6`, `#view-perform` and `#view-edit`. The theme files'
    `:where()` rules (0,1,0 / 0,2,0) lose to the cvd rules (0,2,1).
  - Every strip icon and range bar is drawn in its palette colour and carries number i + 1.
  - No console errors and no HTTP ≥ 400.
- **Off is exactly today.** The probe matched elements by key (tag, classes, testid) and compared their computed
  styles. Base vs lane, cvd absent, 16 instruments, 8 themes × (today, v6) × (Perform, Edit with slot 9 / Range,
  Settings › Look):
  - Classic and Sanctuary: all properties of every element plus `::before` / `::after`, and a hash of every canvas
    (the EQ curves and the response curve of slot 9, i.e. position ≥ 7).
  - The other six themes: the colour / content / box / canvas properties.

  Results:
  - Perform and Edit are identical in all 32 cases. I re-ran four that first differed by audio "ready" timing; the
    rest of the noise was meters, a toast, and the server port in a url().
  - Settings differs only in `settings-panel-look` / `settings-appearance` height (+95 px, the new row).
  - `slotColor(i ≥ 7)` returns `var(--v6-cvd-k, <today's>)`. `--v6-cvd-k` is declared only under the class, so Off
    computes as today. No caller compares the strings: every use is a CSS value (`--c`, `style.background`,
    `setProperty`). keyboard.js's render key just re-renders.
- **Device-local, import, migrate.** The setting is not in `exportJSON` (the `DEVICE_LOCAL_SETTINGS` filter):
  - Merge imports ignore settings.
  - A replace-import keeps this machine's value. When the value is absent, `keep` spreads `cvd: undefined`, and
    `normalizeSettings` deletes it, so a foreign 'rg' never arrives.
  - `migrate` drops bad values.
  - A theme or cvd change is not an edit (`isEditPath`).
- **Mirror and boot.** boot.js runs in `<head>` before the stylesheets, so with a good mirror there is no flash.
  - The mirror is per origin, as the library is, so Chrome :8437 and the Mac app :8438 agree with their own stores.
  - `onSettings(store.get())` runs at boot and clears a stale mirror (test exists).
  - mini.html gets the class, but mini.css draws no slot colour, so it is harmless.
- **Slots 8–15 repeat 0–7.** In a 9-instrument song, 1 and 9 share a colour. A number tells them apart wherever cvd
  is on and an instrument is drawn by colour alone: range bars (Perform, Edit bottom row, Edit › Range), v6 strips,
  the On Stage card, and v6 Edit tabs. Without a number, they carry names or order:
  - pills, chart minis and Space & Echo rows show names;
  - bank song-card dots show order only;
  - today's strips and Edit tabs carry words ("Sound 9").
- **Settings rows.** Today's and the v6 Settings use the same segmented radiogroup:
  - arrows move and choose;
  - search finds the row through `data-keywords` (the builder's test: "colour blind", "color blind", "tritanopia",
    "blue yellow");
  - the Look summary says when cvd is on.

  Lock doesn't gate it or hide badges. Under Lock, Daylight Auto shows Stage, and the Stage palette with it, as the
  theme already does.
- **No layout shift / touch targets.** The builder's tests assert unchanged rects for strips, name rows, bars, the
  keyboard and tab heights. My probe saw no box change when switching on (the badges are absolute or inline in an
  ellipsised name). `pointer-events: none`; handles stay above (z 2).

## Open items

- **O1 (fix candidate, mine): badge collisions on short bars.** A CSS clamp can't see the other bars. Two short bars
  with the same range at positions ≥ 9 clamp to the same spot. In the 16-instrument split test, "10" and "16"
  overlap and "15" is half covered (`UI6-cvd-shots/F1-after-split-bars-1180x820.png`). Slivers at the keyboard's
  edge (a range mostly off the shown keys) stack their numbers at x = 0.
  - Proper fix: `keyboard.js` `layoutBars` (and today's `perform.js` bars) already know every bar's L / R. Place
    each number greedily in its own bar, avoiding the numbers already placed, and set `--cvd-x`. About 30 lines and a
    test. Worth it only if 10+ instrument split songs matter.
- **O2 (Ryan, design): the dark themes' palettes are light pastels.** L is 0.67–0.95, and several lamps are
  near-white: Classic rg `#fddbff` / `#fff37e`; Sanctuary rg `#b8f1ff`; Studio / Nave rg `#bafdff` / `#befcff`;
  `#00fff8` / `#00feef` cyans. The cause is the ink-in-window floor (≈ 4.9 : 1 with dark ink): to get 8 colours that
  far apart, the search pushed them light.
  - On stage, the white ones may read as "selected / highlighted" or glare. They sit next to the white range-handle
    dots and changed dots.
  - Options:
    - (a) accept;
    - (b) lower the count to 6 colours + numbers (wider gaps at the same lightness);
    - (c) let the cvd palettes use a cream / dark ink choice per lamp.
  - Swatches: `UI6-cvd-shots/palettes.svg` (each theme × type, normal and as deutan / protan / tritan; backgrounds
    are approximate theme bg colours).
- **O3 (Ryan, design): Sanctuary Day's palettes are very deep.** Cream ink caps lamps at L ≈ 0.5. `#001864`,
  `#420028`, `#381900` and `#00175c` (L 0.25) read close to black on paper, and as 1.75 px range bars at 16
  instruments they are hard to tell from the keys' black edges. Same options as O2.
- **O4 (Ryan / orchestrator): thin margins, model-specific.** Every palette clears ΔE 10 by 0.3–2.1. That is a
  search optimum, not slack. Applied to gamma-encoded RGB (a mistake some simulators make), 12 of 16 drop below 10
  (Ember rg 2–6: 2.5). Linear is the correct use, so this is not a defect, but the separation is only as good as the
  model. Real colour-blind viewers have not seen it (see Not verified). OKLab ΔE 10 is roughly 5 JNDs: fine side by
  side, modest for picking out a 2 px bar's colour at a distance. The numbers carry that load.
- **O5 (small): a two-digit number under the changed dot.** On a 16-tab Edit row, a tab's changed dot sits on the
  second digit of "10"–"16". Today's design puts the dot over the name's ellipsis; with numbers it covers a digit.
- **O6 (small): a muted instrument's number keeps the lamp colour.** The bar itself goes grey (`.rbar.off`), so the
  coloured badge on a grey bar can read as "on". A grey badge (or reduced opacity) under `.off` would match the bar.
- **O7: stale mirror.** If the mirror says on and the store says Off (the library was replaced outside the app),
  the first frames paint cvd colours until main.js runs. This is rare and self-correcting.
- **O8: screen-reader numbers (design call).** F2 makes the numbers silent, so accessible names are the same as Off.
  If Ryan wants "Instrument 3, Strings" spoken, that belongs in the names, not in the badges.

## Not verified

- Real colour-blind viewers. Everything here is Machado simulation.
- The Mac app (Electron), a real iPad, and WebKit's handling of `content: x / ''` (and of the `@supports` fallback).
  Only Chromium headless was used.
- Real VoiceOver speech. I checked Chromium's accessibility tree, not the spoken output.
- The ui-v6-themes cvd audit for the five themes outside its default set (Classic, Sanctuary Day, Daylight Stage,
  Ember, Nave) was not re-run. The builder reports 10/10 clean with `--cvd only`. The default run (Sanctuary, Daylight
  Day, Studio × rg, by) is in the gates below.
- Contrast of text on the ON tile outside the label window. That is the themes' existing design, covered by the
  ui-v6-themes audit only where it runs.

## Gates (2-CPU box shared with other agents, one suite at a time)

Rows marked (A) ran on lane-cvd rebased onto c10ad59 with the F1–F3 fix (31b0f09 + the review draft). Rows marked
(B) ran through `tools/cloud/gates.mjs` on the final rebase onto 937a04a (tree 675088eace0b). The two trees differ
only in `tools/cloud/` (`git diff --stat 3e9c9cf b62cbcb`), and app/ and test/ are byte-identical.

| suite | result | notes |
|---|---|---|
| shell unit | 415 / 416 (A and B) | One failure outside the lane, see below |
| unit | 689 pass / 0 fail / 12 skipped of 701 (B) | (A) had one importer-host flake: "progress snapshots", load avg 13. It also flaked on the old base tree and passed on rerun |
| ui-v6 | 90 / 90 (A, B) | Flag-off purity vs origin/v2-native (`UI6_PURITY_BASE`) identical: 105 requests, 15 store listeners, 4 intervals, 2529 elements. U-CVD + skeptic F1–F3 pass |
| ui-v6-edit | 43 / 43 (A, B) | Purity vs origin/v2-native identical (1047 in Edit) |
| ui-v6-ipad | 29 / 29 (A) | |
| ui-v6-bank | 23 / 23 (A) | |
| settings | 115 / 115 (A) | app, fixture, mac, bridge, v6. Includes [app] "U-CVD skeptic F3" |
| ui-core | 78 / 78 (A) | |
| themes | 58 / 58 (A) | |
| edit-v2 | 14 / 14 files (A) | |
| ui-v6-themes | 30 / 30 clean in 2253 s (A) | 8 themes × 3 sizes + Sanctuary, Daylight Day, Studio × rg, by: 0 text / ring / edge fails |

0 console.error and 0 HTTP ≥ 400 in every browser suite. `app/js/engine/` is untouched.

**The shell unit failure is not this lane's.** `bank-trial.test.mjs` "skeptic F1–F3: Back after list edits…":
`ctl.addFromBank(LANTERN)` answers "That song is no longer in the Song bank. Press Rescan." Run alone
(`--test-name-pattern`) it passes on lane-cvd. Run with the full file it fails on lane-cvd, on a plain
origin/v2-native c10ad59 tree, and on the old 36ef998 tree. It had passed on 36ef998 in my first gate run 7 hours
earlier. So it depends on the order of the tests in that file and on something in the environment or the clock. The
lane touches neither the controller, the server nor the bank. I did not chase it further; it is for the orchestrator.
