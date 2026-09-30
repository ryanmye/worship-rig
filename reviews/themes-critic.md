# Themes critic: Sanctuary (sanctuary, sanctuary-day) and Daylight (daylight-stage, daylight-day)

2026-09-29. Re-ran coverage (`test/phase2/themes/run.mjs --only coverage`), `tools/themes/shoot.mjs` for all four ids
(1440×900), and a runtime-switch residue probe (a chain of `store.set('settings.theme', id)` switches, each step
compared against a fresh reload of the same id: html/body attributes, theme links, preloads, `document.fonts`,
computed styles and boxes of 13 Perform elements, `.chord-name` scroll metrics). Small CSS fixes went straight into
the theme folders (see CONTRACT_CHANGES `## themes-critic`). The items below are larger or outside the theme folders.

## T1 (medium): a runtime theme switch drops the chord face's metric overrides, so the chord overflows again

- Where: `app/js/main.js` `warmThemeFonts()` (~line 146). It re-creates each `@font-face` of the incoming sheet as a
  `FontFace` in `document.fonts`, but copies only `weight` / `style` / `stretch`. Both themes now have a chord-only face
  whose whole point is `ascent-override` / `descent-override` (`'Sanctuary Chord'`, `'Instrument Sans Chord'`, the fix
  for ui-core #40 / #47). Faces added through the FontFaceSet win over CSS-connected ones with the same descriptors,
  so after a runtime switch the chord renders with the font's own metrics.
- Measured at 1280×800 (fresh reload → after a runtime switch, `.chord-name` scrollHeight / clientHeight):
  Sanctuary and Sanctuary Day 51/51 → **56/51** (text box 7 px outside the clipped box), Daylight Stage and Day
  51/51 → **53/51**. Every other probed property was identical to the fresh reload, at every step of the chain.
  At the end of the chain `document.fonts` holds both `Instrument Sans Chord` faces: one with `ascentOverride 91%`,
  one with `normal` (the one that is used).
- It lasts until the next launch (boot.js links the sheet normally, no FontFace copies), so it hits exactly the session
  where Ryan picks the theme in Settings, and any test that switches at runtime and then measures the chord.
- Fix (main.js, not a theme file): copy every descriptor the rule has, e.g.
  ```js
  for (const [k, p] of [['weight', 'font-weight'], ['style', 'font-style'], ['stretch', 'font-stretch'],
    ['unicodeRange', 'unicode-range'], ['featureSettings', 'font-feature-settings'], ['display', 'font-display'],
    ['ascentOverride', 'ascent-override'], ['descentOverride', 'descent-override'],
    ['lineGapOverride', 'line-gap-override'], ['sizeAdjust', 'size-adjust']]) { … }
  ```
  or `document.fonts.delete()` the warmed faces once the new sheet is enabled (its own `@font-face` rules reuse the
  cached files). Either way, add a themes-suite assertion: after `switch → <id>`, `.chord-name` scrollHeight ≤
  clientHeight (it is 51/51 on a fresh boot for all four ids).
- No theme-side workaround: any `@font-face` the sheet has is warmed, and the warmed copy always wins.
- Evidence: `design/warmth/ship/critic/residue.json` (probe output), `design/warmth/ship/critic/residue.mjs`.

## T2 (low): warmed faces are never removed

Related to T1: the FontFace copies stay in `document.fonts` after switching away (after a Sanctuary → Daylight →
Classic chain, all of `Sanctuary Book/Chord/Sans`, `Fraunces Soft`, `Instrument Sans(Chord)` are still there). Harmless
today because family names are unique per theme, except Nave (v1) and Sanctuary v2 sharing `Sanctuary Book` /
`Sanctuary Sans` (same files). The `delete()` variant of the T1 fix clears this too.

## T3 (low, JS): response-curve reference diagonal on paper

`edit/panels/slot.js:852` strokes the "Normal" diagonal in hard-coded `rgba(255,255,255,.18)`: invisible on Sanctuary
Day and Daylight Day paper. Read a token (e.g. `--line-2`) instead. (Sanctuary's own deferred item 4.)
Screenshot: `design/warmth/ship/critic/daylight-day/edit.png` (the spark right of "Response").

## T4 (low, app-wide): Quick › This Mac "Sustain pedal" caption is clipped

"press it: the light / comes on" is cut by the sheet's bottom edge in Classic too (`design/warmth/ship/classic/quick.png`),
so it is not a theme regression. `design/warmth/ship/critic/sanctuary-day/quick.png`.

## T5 (test harness): "store wins over a stale mirror" pairs the Sanctuary siblings

As the Sanctuary agent reported: `test/phase2/themes/run.mjs` takes the first two css themes, now `sanctuary` /
`sanctuary-day`, which share a file, so the switch is a synchronous attribute flip and the test's DCL snapshot already
shows the store's id. One-line fix: `const b = list.find((t) => t.css !== list[0].css).id`.

---

# Themes critic, round 2: Studio (`studio`) and Ember (`ember`)

2026-09-29, this box (2 CPUs, serial, load 3–5). Re-ran `test/phase2/themes/run.mjs --theme studio,ember`,
`tools/themes/shoot.mjs --theme <id> --out design/warmth/ship/critic/<id>/` (all 6 shots), a runtime-switch residue chain,
a box diff against Classic and a chord-ink clip probe (`design/warmth/ship/critic/se/`). Screens were compared with the
option shots Ryan saw (`design/warmth/studio/perform.png`, `design/warmth/ember/perform.png`). Both are dark only; neither
brief has a light sibling. Two small CSS fixes went into the theme folders (CONTRACT_CHANGES `## themes-critic-2`).
What is left is below.

## S1 (fixed here): Studio's song-name tape read as a text selection

`::first-line` painted the tape behind the glyphs only, with no ends: the title looked selected, not taped
(before: `design/warmth/ship/studio/perform.png`; option: `design/warmth/studio/perform.png`). The strip is now the
`.song-name` box itself (fit-content, 12 px ends, torn masks shared with the Edit title). Height and y are Classic's;
x is −10 px, and the box is narrower (text-intrinsic). Long names still step down and ellipsize inside the tape
(`design/warmth/ship/critic/se/tapes.png`). After: `design/warmth/ship/critic/studio/perform.png`.

## E1 (low): Ember's chord and title line boxes overflow their clip boxes, which trips ui-core #40's probe

- Fresh boot at 1280×800: `.chord-name` scrollHeight/clientHeight **56/51** (Nunito Sans 800: ascent + descent ≈ 1.36 em
  in a 1.1 line box), `.song-name` **50/48** (Young Serif). Classic 51/51 and 48/48; Studio 52/51 and 48/48 (inside the
  probe's +1).
- **No glyph ink leaves the box.** `se/chordclip.mjs` renders Gm, Dsus, Eb, F#m, Gsus, Cadd9, Bb/D and Jg at 46 px with
  overflow hidden and visible, and diffs the 20 px outside the box: 0 px for Studio and Ember (Classic clips "Jg" by
  12 px). So nothing is cut on stage.
- ui-core `OVERFLOW_PROBE` (polish-2A responsive, #40) flags `.chord-name` and `.song-name` on Ember with
  `scrollHeight > clientHeight + 1`. Classic fails #40 for other reasons, so the Ember agent's back-to-back run hid it.
- Fix: an `'Ember Chord'` / `'Ember Title'` face on the same files with `ascent-override` / `descent-override` (as
  Sanctuary's `'Sanctuary Chord'`). **Do it after T1**: `warmThemeFonts` drops the overrides on a runtime switch, so
  today the fix would hold only after a relaunch.

## E2 / S2 (low, JS): FX captions are upper case in the markup

"SPACE" / "ECHO" (`headerChipRow.js:57` `label.toUpperCase()`). Both options showed "Space" / "Echo". Both agents
dropped the CSS lowercase + `::first-letter` flip on critic advice, because it turned "EQ" into "Eq". Fix: drop
`.toUpperCase()`, and add `text-transform: uppercase` to styles.css `.fx-chiprow .fx-lab span` so Classic keeps its
look. Studio already sets `text-transform: none` there. Ember lists it as deferred #3.
Screenshot: `design/warmth/ship/critic/ember/perform.png` (header, left of Dry/Off).

## Residue (clean)

`design/warmth/ship/critic/residue.mjs` (`OUT=…/se CHAIN=…`; output `se/residue.{json,log}`) chain classic → studio → ember → studio → sanctuary → ember → classic → ember → daylight-day → studio →
nave → ember at 1280×800. Each step was compared with a fresh reload of the same id. Checked: html/body attributes,
`color-scheme`, exactly one `#theme-css` with no `data-theme-next`, and the computed style and box of 13 Perform elements.
Result: **0 diffs at every Studio / Ember / Classic step**, and no console errors. The only diffs in the chain are T1 on
Sanctuary (56/51) and Daylight Day (53/51). Studio and Ember have no metric-override faces, so T1 cannot touch them.
Their warmed faces (`Rubik`, `Nunito Sans`, `Young Serif`) stay in `document.fonts` after a switch away (T2). The family
names are unique to each theme, so this is harmless.

---

# Themes critic, round 3: Nave (`nave`) and Classic (`classic`)

2026-09-29, this box (2 CPUs, serial, load < 3). Re-ran coverage (`test/phase2/themes/run.mjs --theme nave`, 11/11),
`tools/themes/shoot.mjs --theme <id> --out design/warmth/ship/critic/<id>/` (all 6 shots each), a runtime-switch residue
chain that also asks CDP which platform font renders each element (`design/warmth/ship/critic/nc/residue-nc.mjs`), and a
light-OS boot check (`nc/lightos.mjs`). Nave was compared with the v1 option Ryan saw
(`design/warmth/sanctuary/perform.png`): same vault, lancet window in the drone card, book-serif setlist and title, lit
lamp tiles; the differences are the critics' fixes (OFF lamps unlit, emerald Pad, sans status words) and the shared
mark. Neither brief has a light sibling; both render dark on a light-OS context (`color-scheme: dark` from `data-mode`).
One fix went into the Nave folder (N1, CONTRACT_CHANGES `## themes-critic-3`). What is left is below.

## N1 (fixed here, partly): a runtime switch through Nave re-set the whole sans in Instrument Sans, in Sanctuary too

- Cause: `main.js warmThemeFonts` (T1) copies each `@font-face` into `document.fonts` **without its unicode-range**, and
  the last copy wins. Nave's minus/plus face (Instrument Sans, `unicode-range: U+2212, U+002B`) was declared after the
  Figtree face, so its range-less copy took every glyph. Nave also reused Sanctuary v2's family names (`Sanctuary Sans`,
  `Sanctuary Book`), and warmed faces are never removed (T2), so the copies leaked into Sanctuary.
- Measured (1280×800, chain classic → nave → sanctuary → nave → classic → nave → sanctuary → classic, CDP
  `CSS.getPlatformFontsForNode`), before: after the switch into Nave, `.slot-inst` "Instrument Sans:11" (fresh:
  Figtree), `.fader-value` "Instrument Sans:7" (fresh: Instrument Sans 1 + Figtree 6), `.slot-inst` 7 px wider; **the same on
  Sanctuary after passing through Nave**.
- Fix (theme.css only): families renamed `Nave Book` / `Nave Sans`; the Instrument Sans face now comes first and the
  Figtree face gets the complementary range (`U+0000-002A, U+002C-2211, U+2213-10FFFF`). Fresh boot is unchanged
  (fader value still Instrument Sans 1 + Figtree 6; 0 contrast fails, mini shots pixel-identical). After a runtime
  switch the Figtree copy now wins, so the UI stays in Figtree and only the minus falls back to Figtree's own.
  Sanctuary steps now show only its own T1 chord diff.
- Left: after a runtime switch into Nave, `.chord-name` 56/51 and `.song-name` 49/48 (fresh 51/51, 48/48): T1, the
  `Nave Book` metric overrides are dropped. And the minus is Figtree's until relaunch. **Both go away with T1's fix as
  proposed** (copy `unicodeRange` and the overrides), which is now more urgent: every theme with an override or a
  ranged face depends on it (Sanctuary, Daylight, Nave; Ember's E1 fix would too).
- Evidence: `design/warmth/ship/critic/nc/residue.json` (after), `nc/chain-*.png`, `nc/fresh-*.png`.

## C1 (low, not a theme file): Classic's own contrast fails, unchanged by the theme work

The Classic agent listed these; re-measured here (`design/warmth/ship/critic/classic/summary.json`):
- Quick: 167 runs / **1 fail**, the tile's "ON" pill 4.14 under the `.qs` `box-shadow: 0 22px 60px #000c` (styles.css).
  Screenshot: `design/warmth/ship/critic/classic/quick.png`.
- Mini: 23 runs / **2 fails**, `.m-num` "2"/"3" 3.49 (mini.css fallback `--m-faint`, want ≥ `#9a9185`). Screenshot:
  `design/warmth/ship/critic/classic/mini.png`. Nave's mini is clean (it sets the tokens).
Perform 185/0, Edit 166/0, EQ 158/0, mini-drone-keys 28/0 (lowest 5.31). Classic has no theme folder, so both fixes
belong to the styles.css / mini.css owners.

## Residue (Classic clean; Nave = N1 remainder only)

Every Classic step in the chain: 0 diffs from a fresh reload (attributes, `color-scheme`, no theme link, fonts, computed
style and box of 13 elements), 0 console errors. Nave steps: exactly one `#theme-css`, no `data-theme-next`, no stale
preload, attributes right; the only diffs are the four N1-remainder lines above.
