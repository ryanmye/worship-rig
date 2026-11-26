# UI v6 U4 (the left panel: Quick + wheel column): skeptic review (2026-11-26)

Verdict: **VERIFIED, after fixes.** As delivered and rebased it was PARTIAL: one low defect and one misleading test
artefact. Neither touches playing.

Under review: commit 9208d76 on lane-u4, built on U3 before U3's skeptic fixes and rebased by the coordinator onto
v2-native ee94331 (U1–U3 with their skeptic fixes; only CONTRACT_CHANGES conflicted). It adds
`app/js/views/v6/left.js`, `app/styles-v6-left.css` and `test/phase2/ui-v6/left.tests.mjs`. It changes
`v6/perform.js`, `styles-v6.css` (one `@import`), `run.mjs` (`UI6_ONLY`) and the docs. I didn't build it.

These claims held:

- **The rebase.** `v6/perform.js` carries U2-skeptic's `rangeSig` (F3) and the hidden-view drop (F4), U3's sidebar
  mount, and U4's `leftPanel` mount, `openQuick(opts, from)` / `toggleQuick(from)` and `lp.setPedal` in `readRuntime`.
  All 48 checks pass on top of it, including the U1 F3 1024 × 700 fader check and every U2 / U3 skeptic check.
- **Module boundaries.** `git diff ee94331` touches nothing in `engine/`, `shared/`, `store.js`, `controller.js`,
  `main.js`, `server.js`, today's `views/perform.js` or `views/components/` (so `quickSheet.js` and `readouts.js` are
  unchanged). `left.js` has no timer: the pedal lamp rides the shell's 150 ms / 1 Hz tick and the CC64 microtask.
- **One sheet, two openers.**
  - There is one `.qs` in the DOM, whichever button opened it.
  - Either button closes it. A song switch (`nextSong`), a cue then GO, and leaving Perform close it and reset both
    buttons (`aria-expanded="false"`, no `.on`). A Lock toggle while it is open keeps it open and flips `.locked`.
  - Focus: Enter on the left Quick keeps the focus on that button. Esc from inside the sheet, or from the button
    itself, leaves the focus on the left Quick. From the top bar's Quick, Esc returns focus there. No panic in any case.
  - **Both buttons read `aria-expanded="true"` while the sheet is open.** I judge that right: both are disclosure
    buttons for the same popup, and a screen reader on either should hear "expanded". Neither has `aria-controls`;
    the top bar's never had one (see O3).
- **Esc order (D24.7).**
  - Mouse: Quick (left) then a strip's ⋯ menu: Esc closes the menu, Esc closes Quick, and only the third Esc panics.
  - Opening the left Quick while the sidebar's customize popover is open closes the popover (outside pointer-down, as
    the top bar's Quick does). The next Esc closes Quick and the one after panics.
  - Coarse context at 1180 × 820: range pick (strip 3's name), then the left Quick, then customize. The Escs went
    customize → Quick → pick → panic.
  - With a pick active, the "tap the keys to finish" tap ends the pick and leaves Quick open (the sheet is non-modal).
- **Wheel column = today's.** I ran the same scripted inputs on today's Perform (flag off) and on v6 and compared what
  the column shows after each step: value, pickup class, ghost, Expr / Vol rows, bend lamp, pedal lamp and input.
  - The steps: `perform.wheel(0.6)`, CC1 10 / 60 / 90 (pickup, then takeover), CC7, CC11, bend mode `drone-swell`, a
    bend down, CC64, Swell, panic and next song.
  - Every step matched. The only differences were in samples taken 50 ms after Swell starts, which are timing-bound.
    I resampled Swell every 100 ms for 1.2 s and stop: today read 1 2 3 5 7 8 8 10 13 15 16 17 → 22 %, v6 read
    1 2 4 5 7 8 10 12 13 15 16 19 → 22 %, both tracking `engine.wheelValues().mod`.
  - **Performance #3 holds** (ui-core's check run against `.v6-left`): a still wheel (20 frames of
    `perform.wheel(0.5)`) makes 0 DOM writes, and 400 ms of idle runtime ticks make 0. A moving wheel makes 57 writes
    and swaps no nodes.
  - **The stuck pedal:** CC64 down reads "Pedal" at 19 s and "Pedal held" at 21.5 s. Releasing it brings back "Pedal".
- **Lock.** The wheel, Swell and Quick stay live. In the sheet, This Mac is frozen and This song is live (today's LOCK
  table). The suite checks this.
- **The page-width rule** `body:has(> #views > #view-perform:not([hidden]) > .v6-perform) { min-width: 0 }`:
  - 820 × 1180: the horizontal page scroll is 0 (base: 204 px) with 4 or 7 instruments and the sidebar panel open or
    folded. The Quick sheet stays inside 820 px.
  - Edit computes 1024 px (the suite checks it).
  - After a flag-off the rule doesn't match, `body` is back to 1024 px, no `.v6` element is left, and today's Quick
    opens. The rule lives in `styles-v6-left.css`, which is linked only while v6 is mounted, so it can't match with
    the flag off.
  - Settings over the v6 Perform at 820 px now lays out at 820 px instead of scrolling sideways. It looked fine.
  - **Engines (static check, not run):**
    - Electron 44's Chromium supports `:has()`, which Chromium has shipped since 105.
    - The native Mac / iPad app (WKWebView) targets macOS 14.5 / iPadOS 17.5 (`native/apple/project.yml`), so Safari
      17.x WebKit, and Safari has supported `:has()` since 15.4.
    - `-webkit-line-clamp` with `display: -webkit-box`, `overflow-wrap: anywhere` and `container: none` are also
      fine there.
- **Fit.** I measured strip width, fader track, wheel track, the column inside the board and page scroll, U4 against
  ee94331, at 1024 × 700, 1180 × 820 and 1280 × 800, with 4 and 7 instruments and the sidebar open and folded.
  - Every strip and fader number is identical to the base: the left column keeps the placeholder's 84 / 64 px. So
    **U4 neither worsens nor improves U3's O1.**
  - The wheel track is 206 px at 1024 × 700 (caption hidden), 240 px at 1180 × 820 and 220 px at 1280 × 800.
  - The column fits the board everywhere, and the page never scrolls.
  - The sheet, from either opener, never overlaps PANIC, Fade out, Lock or Revert at the four sizes. At 1024 × 700
    its body doesn't need to scroll.
- **Leaks.** I ran 9 flag on / off cycles, each with the sheet opened from the left, then CC1, CC11, bend and CC64
  down / up.
  - Store listeners stayed at 15 → 15.
  - Net window, document, controller, MIDI and engine listeners were unchanged. MediaQueryList listeners moved to the
    new lists, and the old ones were removed.
  - Live timeouts went 8 → 3, and elements 2304 → 2301.
  - Flag off with the sheet open leaves the top bar's `aria-expanded="false"`.
- **Flag-off purity** against ee94331 (the suite's check) was identical in both full runs: 105 requests, 15 store
  listeners, 4 intervals, 2529 elements. The builder's "103 / 14 / 2528, identical" was against the pre-rebase base
  966b0b4.
- **Zero console.error and no HTTP ≥ 400** in the suite and in every probe.

## Findings

- **F1 (low) An open Quick sheet stayed where it was opened when its opener moved.**
  - `openQuick` placed the sheet once, on open. A window resize moved the opener, for example the Mac window crossing
    1100 px (the column goes 84 → 64 px) or an iPad rotation. So did folding the snapshots row (the board moves up
    48 px). Either way the sheet was left off its button.
  - Measured: open from the left at 1280 × 800, then resize to 1024 × 700. The sheet sat 34 px from the button and
    24 px below its top, its arrow pointed at nothing, and it covered 86 px² of Revert. From the top bar's Quick, the
    arrow drifted 44 px from the button's centre.
  - Fix (86b2abf, `v6/perform.js`): the placement is `placeQuick(from)`. It runs again, rAF-coalesced and only while
    the sheet is open, on window `resize` and on the snapshots fold / unfold. The resize listener exists only while
    the v6 Perform is mounted, so flag-off purity is unchanged.
  - Test: "U4 skeptic F1". It resizes 1280 → 1024 × 700 → 820 × 1180 → 1180 × 820 for each opener, then folds and
    unfolds the snapshots row. It fails on 9208d76 with "left: resized to 1024×700".
- **F2 (low, test) The Quick screenshots caught the theme's fade-in.**
  - `u4-quick-*.png` were taken during Sanctuary's 160 ms `sanct-fade` (opacity 0.81), so the review screenshots
    showed a half-transparent sheet over the strips.
  - The real sheet is opaque after 160 ms: I checked opacity 1 and the solid background.
  - Fix (2b60aa0, `left.tests.mjs`): wait for the sheet's finite animations before those screenshots.

These are acceptable or not defects:

- **PANIC and Lock still need a hold** ("hold · or Esc"). D23 makes them a tap again; that is queued (U-MOVE), not a
  U4 defect.
- **Two rAF coalescers per wheel event** (the shell's for the strip indicators, the column's own). Today's Perform has
  one. The cost is one extra callback per frame while the wheel moves, and nothing while it is still.
- **The "Esc always panics" setting (D24.7)** isn't built yet (queued). Without it, the rule above is the behaviour,
  as checked.

## Gate

The box had 2 CPUs, shared with another skeptic's suites in /home/claude/wt-move (load average 3–8). I ran the suites
one at a time.

| suite | result |
|---|---|
| ui-v6 (`test/phase2/ui-v6/run.mjs`) | **48/48** as rebased (9208d76; the builder's 42/43 predates the rebase). With F1's check on the old `perform.js`: fails as expected (5/6 in a `UI6_ONLY` run). **49/49** at 2b60aa0, purity included |
| ui-core (`test/phase2/ui-core/run.mjs`) | **78/78** at 9208d76 and again at 2b60aa0 (the builder's "91/91" is not this suite's count; U3's review also had 78) |
| flag-off purity vs ee94331 (in ui-v6) | identical (105 requests, 15 store listeners, 4 intervals, 2529 elements) |
| my probes (`/tmp/u4probe/p2–p9.mjs`, not committed) | still / moving wheel writes, song switch / cue-GO / Lock with the sheet open, keyboard focus and Esc, Esc order with ⋯ menu / customize / range pick, stuck pedal at 19 / 21.5 s, today-vs-v6 wheel sequence, Swell time series, fit vs ee94331 (24 combinations), sheet vs bottom-row overlap at 4 sizes and after resizes, Settings at 820 px, 9 on / off cycles |
| console.error / HTTP ≥ 400 | 0 |
| `run-all --fast`, settings, Electron / Mac suites, real iPad | not run |

## Fixes (commits on lane-u4)

- 86b2abf `app/js/views/v6/perform.js` and the check "U4 skeptic F1": F1.
- 2b60aa0 `test/phase2/ui-v6/left.tests.mjs`: F2.
- This review, plus a skeptic note in CONTRACT_CHANGES "## UI v6 U4" and the build plan's U4 status.

## Open items (for Ryan / U8)

- **O1 U3's O1 is unchanged by U4.** At 1024 × 700 with the sidebar open, a 4-instrument song still scrolls (strips
  150 px, faders 140 px; folded: 179 px / 182 px), exactly as on ee94331. U4 had no room to give: its column is the
  placeholder's width. The options in UI6-U3 O1 still stand.
- **O2 iPad portrait 820 × 1180.** The page no longer scrolls sideways (204 → 0 px). The strips now get the real
  820 px width, so even 4 instruments sit at the 150 px minimum and scroll inside the row with pills. On base they
  were 191 px, and the whole page scrolled instead. Today's top bar still overlaps itself at 820 px. Both belong to
  U8's portrait layout.
- **O3 (a11y, low)** Neither Quick button has `aria-controls` pointing at the sheet. That matches today's top bar
  button; worth adding for both at U8.
- **O4 Builder's choices to confirm** (build plan): the sheet is anchored to its opener (beside the left button,
  under the top bar's); one header line (the subtitle, or the Lock line while locked); "Warm Pad level" /
  "Instrument n level"; the wheel caption hides below 760 px tall windows; Save as scene 1 · 2 · 3 kept in the sheet
  (the mockup leaves it out).
- **O5 Not verified:**
  - real iPad / WebKit (`:has()` and the 64 px column on a device; the static check above only);
  - the Electron / Mac app;
  - real MIDI hardware: I injected bytes with `midi._inject`;
  - themes beyond Sanctuary;
  - screen readers (only ARIA attributes were checked).
