# UI v6 U8b (all 8 themes pass contrast): skeptic review (2026-11-26)

Verdict: **VERIFIED, after fixes.** As delivered it was PARTIAL. The colour work is real and, where the builder's
audit looked, it holds: I hand-checked the token pairs and they match. Three defects were left, though. The audit's
blind spots hid the first two, and the third was only visible at a size the audit never ran:

- F1 (medium): field hints were never audited. Every v6 placeholder was Chromium's default `#757575`, which fails in
  all 8 themes.
- F2 (low-medium): text under a popover's or the Quick sheet's shadow was only re-measured when it already failed
  on its computed colour. On the dark themes the shadow darkens light ink as much as its background, so those runs
  passed on paper and failed as drawn.
- F3 (medium, a U8a layout defect found by the contrast audit): at 820 × 1180 the Start here card and a Learn /
  Arrange bar together left the faders no track. The thumb sat over every strip's dB.

The audit never ran at the iPad sizes; F3 is the only thing that failed there after F1 / F2.

Each is fixed, and the extended `ui-v6-themes` fails on the code before the fix. The 1.x changes (Bass a step
lighter, Daylight's engine note, Daylight's EQ focus) are exactly as documented, and nothing else changes with the
flag off.

Under review: 2d525ac, ede3243, eb01361, 36bfc36, fa63a15 and 823da1a on lane-u8b, rebased onto v2-native 9217f7a
(U8a). origin/v2-native has since moved to c256074, but those commits are docs only (D27–D29). `git diff
9217f7a..823da1a` touches no file under `app/js/` (engine, store, views), only CSS, theme files, tools, tests and
docs.

## What held

- **Hand-checked pairs.** My own sRGB/WCAG computation, from the theme tokens:
  - Sanctuary Day 4..6 (`#a8336a #5f6b00 #3a57b0`) with cream ink in the 22 % ON window: 7.98 / 7.58 / 8.38. The
    claim was 7.6–8.4.
  - Daylight Day pastels with ink `#241a10` in the 14 % window: 5.94 / 8.42 / 6.05. The claim was ≥ 5.9.
  - Bass `#a883d4` → `#b495db`: 4.47 → 5.31. Studio `#b37fd2` → `#bd90d9` in its `#1f191524` window: 4.54 → 5.31.
  - Daylight Day engine note `#eea43a` → `--dl-warn-text #8f4a00` on paper: 1.88 → 5.98.
  - The EQ ring `#7cc4ff` on the walnut bezel: about 7.2.
  - Switches: Sanctuary ON (`#1c1406` on `#e6ba65`) is 10.0. Sanctuary Day OFF (thumb `#fffdf8` on text 52 % over
    `#f0eae0`) is 3.9.
  - Every audit row I sampled agrees with these to within ±0.1.
- **The audit measures what it says.**
  - Rings are measured in keyboard modality, and "nothing changes on focus" counts as a fail.
  - Fields are measured on the wrapper that draws them.
  - Switches are measured thumb against track. I checked the DOM: `.v6-sw::before` is the track and `.v6-sw-k` is
    the thumb.
  - Closed `<details>`, `[hidden]` and the scrim hit test hold.
  - The `fades` exemption only applies inside the strips' 48 px edge fade while the strips are not scrolled to the
    end.
- **Flag off is unchanged where it should be.**
  - I compared the computed styles of every element (colour, background, border, outline, box-shadow, opacity, fill)
    on today's Perform, Edit and every Settings category, flag off at 1280 × 800, base 9217f7a against the lane, in
    all 8 themes.
  - Zero differences, apart from the live status lamps ("warming up" against "ready" timing) and the server port in
    `url()`.
  - Targeted reads confirm the intended 1.x changes, and only those:
    - `--slot-3` on body: Studio `#b37fd2` → `#bd90d9`, Nave `#b073da` → `#bc8ae0`, Daylight Day `#a883d4` →
      `#b495db`.
    - Daylight Day's engine note `rgb(238,164,58)` → `rgb(143,74,0)`. Sanctuary, Studio and Nave are unchanged.
    - Daylight Day's EQ band field: focused it showed no change before (`rgb(210,200,185)` both ways), and now its
      border turns `--focus` `rgb(47,111,176)`. The other themes are unchanged.
  - `test/phase2/themes` coverage and the purity probes: see the gate table.
- **U8a's surfaces pass in all 8 themes at 1280 × 800, 820 × 1180 and 1180 × 820.** These are the Start here card,
  the empty library, its Perform-lock line, the Trying banner and the MIDI lamp's words ("Not allowed yet" /
  "Blocked" / "No device"). U8a's portrait and landscape layouts were checked in a touch context, where
  `(pointer: coarse)` matches.
  - I ran every state at both iPad sizes in 6 of the themes. After F1 / F2, nothing failed apart from the
    artefacts in "Audit fixes".
  - The empty library's lock line is `--warn` text, which would fail on paper. It never shows on paper, because
    Perform lock switches the Daylight and Sanctuary families to their dark sibling (`themes.js` `locked`). The audit
    measured it on Stage: 4.69 or better.

## Findings

- **F1 (medium) Field hints (placeholders) were unstyled and unaudited.**
  - The audit walked text nodes. A field's placeholder, its value and a select's shown option are not text nodes,
    so it never saw them.
  - Every v6 placeholder was the UA's `#757575`:
    - bank search "Search title or artist": 2.68 (Studio), 3.09–3.13 (Nave, Classic), 3.71 (Daylight Day);
    - the chooser's "Search sounds": 3.09–4.13;
    - Edit's "Find a song…": 3.09–4.46.

    The only exception was v6 Settings' search, which the builder had styled.
  - Fix (703bb75): `:is(.v6, .v6-st) :is(input, textarea)::placeholder { color: var(--muted); opacity: 1 }`.
  - The audit now reads field words: the placeholder in its `::placeholder` colour, the value, and a select's
    option. The text-hiding pass also hides `::placeholder`. Values and selects had no failures.
- **F2 (low-medium) Text beside a popover or the Quick sheet failed as drawn on the dark themes.**
  - The audit's shadow pass only read the rendered ink when a run already failed on its computed colour. That catches
    dark ink on a darkened tile. It never catches light ink on a dark board: the shadow darkens both the ink and the
    background, while the computed colour stays the same.
  - The audit now judges every run under a shadow on its drawn ink. It takes the same frame with the casters'
    shadows switched off and computes the darkening on the run's inkiest pixels (per channel, so thin glyphs are
    judged on their colour, not their coverage), then applies that darkening to the computed colour.
  - Found with the builder's shadows (`0 8px 20px`, 55 % of `#000c`):
    - "Octave normal" / "Octave" beside Space / ⋯: 4.18 (Classic 1280), 4.00 (Classic 820), and 3.2–4.5 in my
      first exploratory runs (Sanctuary, Ember, Nave);
    - the keys' "C6" beside Quick: 4.42 (Ember 1180 × 820).
  - Fix (703bb75): `--v6-pop-sh` / `--v6-qs-sh`.
    - Dark themes: `0 2px 6px` at 25 % of `--v6-sh`, a 20 % black.
    - Paper keeps the builder's values (`0 8px 20px` 55 % / `0 2px 8px` 50 % of an 18 % brown); nothing under them
      fails.
    - Edit's Vibe menu and the portrait song drawer (both new in the tour) pass with their own shadows, so I left
      them unchanged.
  - Test: `ui-v6-themes` before the fix (33d2a68 with 823da1a's CSS; Classic, Nave and Daylight Day; three sizes)
    found **36** text failures (F1 and F2). After the fix it found 0.
- **F3 (medium) Start here plus Learn / Arrange left the faders no track at 820 × 1180 (U8a).**
  - The full suite at 820 × 1180 failed every strip's dB in Learn on a first run, at 1.1–2.1:1 in 6 themes. The
    "background" was the fader thumb lying over the words.
  - The Start here card and the Learn / Arrange bar share the slot above the strips. U8a F3 gave the panel's room
    back for each one alone; together, with 4 instruments, the track was 61.6 px (under the 80 px input), and with 7
    it was none. At 1180 × 820 it was 93.8 px.
  - A first-run player opening Learn hits exactly this.
  - Fix (9ff3226, `styles-v6-ipad.css`): while Learn or Arrange is on, at every size, the card is hidden. The
    mode's bar is the instruction then. The card comes back on Done; only × or a song change ends it.
  - Test: ui-v6-ipad "skeptic U8b". It requires a track of at least 96 px at 820 and 1180 and at least 80 px at
    1024 × 768, and the card back after Done. Before the fix it failed with 61.5625. The ui-v6-themes learn state at
    portrait covers the contrast side.
  - For Ryan: hiding the card is my choice. The other option was a smaller panel under the strips (about 140 px).
- **Audit fixes (no product change) that came with the iPad run.** Each of these gave false fails at 820 / 1180 px:
  - **Controls clipped out of their scroller** were measured. Edit's song-list row 11 under the chooser at
    1180 × 820 was "2.62". It is scrolled out of the list, so the hit test met an ancestor. Controls are now cut by
    their clipping ancestors, the way text runs were already. The chooser does trap Tab (`chooser.js`).
  - **Runs partly under an overlay** were measured when their centre was a pixel outside it. A strip's ON label
    under the song menu at 820 read 2.7, and a key letter half under the Add song popover read 4.4 (the same letter
    in view is about 6). A run a third covered (5 of 15 sample points) is now skipped, like a covered centre.
  - **A state change between reading colours and the background shot.** The drone's ON tile read 1.4:1 at portrait
    while the set was still preparing. The tour now waits for every sound to be ready.

## Not defects / builder's claims confirmed with a caveat

- The Daylight Day "locked" state is audited in Stage colours. That is the theme's behaviour, not a gap.
- The builder's "before" counts (274 · 138 · 354) are measured with their tool on dcb2f06. I didn't re-run that.
  I only checked the "after" side, at the lane tip, with the stricter audit.

## Gates

On the 2-CPU box (shared), one suite at a time, after all fixes. `PLAYWRIGHT_BROWSERS_PATH=/root/.cache/rig-pw`.

| suite | result |
|---|---|
| ui-v6-themes (8 themes × 1280 × 800 / 820 × 1180 / 1180 × 820) | **24/24 clean**: 0 text / ring / edge fails, 0 not reached, 0 errors; 86 294 text runs, 22 426 rings, 621 edges; 21m39s |
| the same suite on 823da1a's CSS (Classic, Nave, Daylight Day) | 36 text fails (F1 / F2): the regression check fails before |
| ui-v6-ipad | **29/29** (+1: skeptic U8b, F3; 61.6 px before the fix) |
| ui-v6 (incl. flag-off purity vs 9217f7a) | **76/76**, identical (105 requests, 15 store listeners, 4 intervals, 2529 elements) |
| ui-v6-edit (incl. purity) | **37/37**, identical (1047 elements in Edit) |
| ui-v6-bank | **21/21** |
| chart | **41/41** |
| settings (app, fixture, mac, bridge, v6) | **111/111** |
| ui-core | **91/91** |
| themes | **58/58** (coverage JSON: only `generated` timestamps changed, not committed) |
| shell unit | **384/384** in 3 of 4 runs; one run had 383 / 1 fail, and its output was not kept. No JS changed in this lane, so I read it as a flake |
| flag-off computed-style diff, 8 themes, today's Perform / Edit / Settings | 0 differences outside the live status lamps; the 3 intended 1.x changes confirmed |
| console.error / HTTP ≥ 400 | 0 |
| edit-v2, migration-1x, Electron / Mac | not run |

## Fixes and commits (lane-u8b)

- 33d2a68: the audit and tour extensions plus the suite at three sizes (the regression test; it fails on 823da1a's
  CSS).
- 703bb75: F1 placeholders and F2 dark overlay shadows (`styles-v6.css`, `styles-v6-left.css`).
- 9ff3226: F3, Start here steps aside under Learn / Arrange (`styles-v6-ipad.css`, ui-v6-ipad "skeptic U8b").
- This review, plus a skeptic note in CONTRACT_CHANGES "## UI v6 U8b (themes)" and the build plan's U8b status.

## Open items

- **O1 The Quick sheet covers the keyboard at 1280 × 800 (layout: U4 / U8a, design call).** U8a didn't change it.
  - Measured (Studio): with Start here gone the sheet runs 194–751 px and the keyboard 700–779, so the sheet covers
    its top 51 px.
  - With Start here showing it runs 258–788. That covers the keys' full height from C2 to about C5, and its body
    scrolls 27 px.
  - It stays inside the view, so nothing is clipped. The computer keys and MIDI still play.
  - Capping the sheet above the keyboard would push "Hold to restart the sound" (the emergency row) behind a
    scroll. That trade is Ryan's call, so I didn't fix it.
- **O2 Design choices for Ryan (unchanged by me, all pass):**
  - Day themes' positions 4..6:
    - Sanctuary Day `#e46aa0 #c9d867 #6f9cf0` → `#a8336a #5f6b00 #3a57b0`;
    - Daylight Day → `#f08fb8 #c9d867 #86b0f4`;
    - dark themes' pos-4 `#e46aa0` → `#ee84b2`.
  - The switch ON thumb is now `--accent-ink` (dark on the amber), where it was a light thumb (1.2–1.8:1). On paper
    the OFF track is text 52 %, where it was 18 % (1.3:1).
  - Field borders are `--v6-field-line` (`--muted` 58 % + `--line-2`), so they are visibly stronger than
    `--line-2` (1.5–2:1).
  - Shadows:
    - popovers: `0 18px 40px #000c` → builder `0 8px 20px` 55 % → mine on dark `0 2px 6px` 25 %;
    - Quick: `22 + 60 px` → builder `0 2px 8px` 50 % → mine on dark `0 2px 6px` 25 %.

    The dark themes' popovers now read as flat sheets with a line. Ryan should look at a dark theme with ⋯ open.
- **O3 Bass a step lighter costs Extra/Bass luminance separation (for Ryan).** The research §5.3 "deutan
  separation" note asked for exactly this kind of distance. Extra vs Bass as a contrast ratio:
  - Nave 1.95 → 1.57;
  - Studio 2.02 → 1.71;
  - Daylight Day 1.60 → 1.33.

  The alternative was a darker ON window (ink 18–20 %) with Bass unchanged.
- **O4 The audit still doesn't see:** hover / pressed / dragging states; the learn-picked outline on paper; rings
  of a control that is the second of its look on a different background (one ring per tag + class + state); text
  in images or canvas (the EQ plot's labels are canvas); Settings content below the fold; the stalled / second
  window / storage-full banners (today's chrome, unchanged by U8b).
- **O5 Doc nit.** Studio's theme comment says Bass ink is 6.4:1. I compute 6.75 on the flat colour. The number in
  the window, 5.3, is right.

## Not verified

- A real iPad / WebKit: I used Chromium's touch emulation at scale 1, because the audit reads screenshot pixels at
  CSS px.
- The Electron / Mac suites, edit-v2 (no colour expectations in it; I grepped), migration-1x.
- Screen readers, forced colours / increased contrast.
- The builder's before-numbers.
