# C-SHIP (D33, the chord chart ships in 2.0): skeptic review (2026-11-27)

Verdict: **VERIFIED after F1, F2 and the O4 call.** I could not break the lazy load. With charts on and no charts,
nothing of the chart is requested, drawn or listened to in either UI until it is used. Every entry point mounts it
once. A chart arriving on the current song loads it by every path I tried. Off takes everything away again. O1, O3
and O7 hold at six sizes. I fixed two defects, each with a test that fails first:

- F1: the pressed Chart toggle was unreadable under the mouse in Studio.
- F2: O1's lifted PANIC covered the Edit chart dialog's Cancel at 1024 × 700.

I also implemented the orchestrator's O4 call: an add or duplicate past 2 MB warns and goes through, per D9. Open
items are consistency calls for the orchestrator (O1) and small UX notes (O2–O6). Nothing is blocking.

Under review: lane-cship b56c4f5, a17195e, 3066cbd and be45060 (the builder's 37bcf08 … 21e563c), rebased onto
origin/v2-native ee5bcb9 (U-CVD). The rebase conflicted in CONTRACT_CHANGES.md, main.js `onSettings` (`applyCvd` +
`onChartSettings`) and the ui-v6 / ui-v6-edit purity DOM filters. I kept both sides in each; the filters now leave out
both rows, `setting-row-cvd` and `setting-row-chart-view`. The b947801 gates.mjs cherry-pick was dropped as already
applied. `app/js/engine/` is untouched. My probes are in `.probe/` (git-ignored, not committed).

## The O4 call (orchestrator, tier 2): implemented

The builder's O4 refused an add or duplicate past `LIBRARY_MAX_CHARS`. That contradicts D9: "a save past 2,000,000
characters warns but is not refused".

- **What changed.** `store.songOverflows` now checks `LIBRARY_RESTORE_MAX_CHARS` (2,500,000). Past 2 MB, an add or
  duplicate goes through, and its save gives D9's `library-size` warning: the same one as any save, once a session,
  then at +10 %. Past 2.5 MB it returns null and writes nothing, with a `library-full` notice: "“X” was not added:
  the library would be 2.6 MB, and a backup over 2.5 MB cannot be restored. …". So songs added this way can never
  make the library's own backup unrestorable.
- **Where it is logged.** A note under DECISIONS D33, CONTRACT_CHANGES "C-SHIP (D33)" O4, and the release notes'
  "Large libraries" paragraph.
- **Tests.**
  - `chart-store.test.mjs` "C-SHIP (chart-view O4 per D9)" fails on the first cut. It duplicates a 64 KB chart until
    refused, saves each copy, and checks: duplicates past 2 MB are saved and warned, the refusal comes inside 2.5 MB,
    a refused add or duplicate writes nothing, a blank song still fits, and the export restores.
  - `kept.test.mjs` D9 and `d8-skeptic` D9 now assert that each add past 2 MB returns an id. Under the first cut
    those adds silently wrote `songs.null.notes`.
- **migration-1x fixtures.** Back to the base's `addSong` builders: `bigLib`, D9's 40 adds, `quota.pw` `grow` and the
  2.47 M copy. Each now throws if an add is refused, instead of looping forever. `quota.pw`'s grow-until-the-quota
  loop used to add songs; new songs now stop at 2.5 MB, before Chromium's ~5.24 M quota. So the fixture adds 100 blank
  songs inside the cap and then fills their notes, which are edits. Both quota tests pass in real Chromium: the save
  fails at `used` 5,227,850 and the main key is untouched.

## What held

- **Lazy load, live counts.** `.probe/p1.mjs` wraps add/removeEventListener on window, document and body, plus
  setInterval/clearInterval and the store's listener Set, so these are live counts, not just adds. Results at
  1280 × 800 on the factory library:
  - Today's UI, on vs off: 112 = 112 requests, no chart request, the same live listeners, intervals and store
    listeners. The only DOM difference is `button[chart-toggle]`.
  - v6, on vs off: 155 = 155 requests. The DOM adds only the Chart tab and the rail icon, and the sidebar's modules
    list gains `chart`.
  - Flipping charts off live from on equals a charts-off boot, and flipping back on equals the on boot.
  - After use, Off brings today's UI back to exactly the off snapshot: listeners, DOM and CSS links all gone,
    stylesheets included.
  - After use, Off on v6 matches the off snapshot except for the Drone module's own DOM, listeners, interval and
    store listener. The chart had gone up on the stage, the default placement, which folds the sidebar to its rail,
    and turning charts off leaves the rail folded (O4).
  - The base comparison runs in the gates with `UI6_PURITY_BASE=origin/v2-native` (ui-v6 and ui-v6-edit "flag-off
    purity"): 105 requests, 15 store listeners, 4 intervals, 2529 elements; identical with charts off, and
    identical + the toggle with charts on.
- **Each entry loads it once.** Today's UI: a double click before the module arrives gives one mount, one toggle,
  the panel open and store listeners 15 → 16. v6: two quick tab clicks, then the rail icon, then Notes' Chart give
  store listeners 20 throughout, one chart (stage or side) and one `chart` module.
  - v6 Edit's Chart button with nothing loaded switches to Perform and puts the chart up on the stage. A second Edit →
    Chart still shows one chart. With the side placement it opens the sidebar on Chart (`.probe/p2.mjs`).
- **A chart arriving on the current song loads it; elsewhere it doesn't.** Probe p2 checked this in both UIs:
  - An auto patch pack song with a chart (not current) loads nothing, and neither does `setChart` on another song.
  - Switching to that song loads it.
  - A replace import whose current song has a chart loads it.
  - Song bank Try it with a chart loads it (v6).
  - A reload with the sidebar left on the Chart tab loads it (the documented rule).
  - The chart suite covers import, the Edit chart dialog's Save and a reload with a chart.
- **Migration and scope.** `true` (hidden builds), `1`, `'true'`, `{}` and `null` all migrate to absent (on).
  `false` is kept, and migration is idempotent. The setting is not exported. A replace import keeps this device's
  value either way. That includes restoring a kept copy and "Restore previous library…": both go through
  `importJSON({replace})`.
  - `?chart=0` and `?chart=1` both work. `?chart=1` on a v6 boot only turns charts on: the v6 Perform mounts after
    the check, so the chart then loads by the usual rules. The builder flagged this. CONTRACT_CHANGES now says so;
    it was "and load now".
- **O1 PANIC above both dialogs.** Probe p3 checked today's UI at 1280 × 800 and 1024 × 700, v6 at 1280 × 800 and
  1024 × 700, and touch contexts at 1180 × 820 and 820 × 1180:
  - `elementFromPoint` at PANIC's centre is PANIC. A click or tap panics once, and the dialog stays open.
  - Esc closes the dialog without a panic; the next Esc panics.
  - With "Esc always panics" (D24.7) on, Esc in a chart dialog still only closes it. That is the existing rule that
    a dialog's Esc never panics (polish2 O1; O5).
  - Lock closes the dialog and drops the body class, and PANIC under Lock panics.
  - Turning charts off, or swapping the UI, with a dialog open leaves no host, no `chart-dlg-open` and no dialog
    mark, and the next Esc panics.
- **O3.** In an iPad touch context, today's toggle is 56 × 44 before and after the chart loads (coarse pointer).
- **O7.** The new message is in both dialogs; the chart suite checks the text.
- **v6 Edit header with the Chart button.** I checked 1024 × 700, 1100 × 800, 1101 × 800, 1280 × 800,
  1180 × 820 (touch) and 820 × 1180 (touch), each with a 46-character song name. The header has no scroll at any of
  them, and the Chart button is inside it and visible (47 × 44 on touch). Portrait wraps to two rows, as it did
  before the button showed; the screenshot is clean.
- **iPad placeholder.** The Chart tab is 129 × 44 in portrait and 192 × 44 in landscape. A tap loads the chart onto
  the stage (the default placement), with mini faders, in both orientations, with no console errors.
- **Themes.**
  - ui-v6-themes had no state for the placeholder, so I added one: `chart-loading`. It holds the v6 chart module's
    request back, so the sidebar's Chart module shows "Loading the chart…". It is in the Mac set and in
    IPAD_STATES. A two-theme run (Studio, Daylight Day × 3 sizes) is clean; the full run is in the gates.
  - Probe p4 measured contrast in all 8 themes. The v6 note is ≥ 7.06 and the tab ≥ 10.85. Today's toggle idle is
    ≥ 13.66, pressed ≥ 5.89, and pressed under the mouse failed in Studio (F1).
- **Release notes.** The draft named "Settings › Perform › Chord charts" and a "text size in percent". Neither is
  what both UIs show. The rows are Perform layout (v6) and Look › Perform view (today's), and today's chart steps
  text size with A− / A+. I reworded the line, and added Edit's Chart button. The rest is accurate: chords follow
  Easy Transpose, auto-scroll, and the chart travels in exports and backups.

## Findings (fixed)

- **F1 (low–medium; the toggle ships on by default) Studio: the pressed Chart toggle under the mouse was
  unreadable.** This is how the toggle sits right after the click that opens the chart. Studio's cap rule
  `.btn:hover:not(:disabled)` paints a dark gradient, and it beat the pressed accent at equal specificity because
  the theme loads later. That left accent ink on near-black: 1.33 : 1 at the gradient's worst stop. The same rule
  is in the base's hidden build.
  - Fix: styles.css keeps the accent under `:is(:hover, :active)` of the pressed toggle.
  - Test: chart suite "C-SHIP skeptic F1" checks every theme idle, pressed and pressed + hover (gradient stops
    counted). It fails before the fix with `studio hover 1.33`. Commit 259a633.
- **F2 (medium) O1's lifted PANIC covered the chart dialogs' own controls.** PANIC sits at z 61 over the dialogs'
  backdrop, and the dialogs are 90vh / 92vh high and centred, so on a short window they reach PANIC's row.
  - At 1024 × 700, the v6 Edit chart dialog ran 70–630 and PANIC 596–692. PANIC covered 5/15 of Cancel's sample
    points and 1/15 of Remove chart's, so a tap on Cancel's lower half panicked. Today's import review at
    1024 × 700 reached 21 px under PANIC.
  - Fix: `views/chart/import.js` `keepClearOfPanic(host)`, used by both dialogs. While a dialog is open, its host
    gets `--chart-dlg-clear`: the room below PANIC's top + 8 px, kept up to date on resize. The hosts pad by it, and
    the dialogs' max-height leaves it free. The six sizes now give 0 px² of overlap and no covered control.
  - Tests (chart suite), both failing before the fix:
    - "C-SHIP skeptic F2": today's import with a long ChordPro paste at 1024 × 700 and 1280 × 800.
    - "U7b (C-SHIP skeptic F2)": v6 Edit chart at 1024 × 700, 1280 × 800 and 1440 × 900, plus a 40 px shorter
      resize while open, with Save on screen.
  - Commit a723b11.

## Open items

- **O1 (orchestrator) The other 2 MB refusals.** The O4 call covers + New, Duplicate and the CSV placeholders, which
  now go to 2.5 MB. Three paths still refuse at 2 MB:
  - `setChart` (`chartOverflows`, security S2);
  - Song bank Add (`addPackSong`, "The library is full");
  - pack top-up (`topUpPacks`).

  A merge refusing at 2 MB is D9's own rule. A player can now duplicate a song past 2 MB but not add a chart or a
  bank song. Applying the same rule (warn, refuse past 2.5 MB) would make this consistent. I didn't change them:
  they were outside the call.
- **O2 (low) A tap on the Chart tab gives no feedback until the module arrives** on the stage placement (the
  default). The placeholder's `take()` puts the chart on the stage, so the "Loading the chart…" line never shows, and
  the tab stays on the previous module meanwhile. That took about 100 ms here; on a first load on an iPad it may show.
- **O3 (doc, fixed in the doc)** `?chart=1` on a v6 boot doesn't load at once (see above).
- **O4 (low, Ryan's eye)** Turning charts Off while the chart is on the stage leaves the sidebar folded to its rail.
  Turning them back on brings the chart back up on the stage, because this device left it up. That is consistent
  with the "left up" rule, but a player who turns charts off may expect the sidebar back.
- **O5 (note)** With "Esc always panics" on, Esc in a chart dialog closes the dialog and doesn't panic. This is the
  app's dialog rule (a dialog's Esc never panics), not D24.7's "even with a sheet open". It matches every other
  v6 dialog.
- **O6 (env, not C-SHIP)**
  - This box's Chromium is build 1243, and Playwright 1.56 wants 1194. Browser runs need
    `PLAYWRIGHT_BROWSERS_PATH=/root/.cache/rig-pw` (tools/cloud/setup.sh's mapping). Without it every browser suite
    fails to launch.
  - shell-unit's `bank-trial.test.mjs` "skeptic F1–F3" failed 3 of 3 while another lane's gates loaded the box.
    It failed on the base worktree too (origin/v2-native, same box, same time): `addFromBank` → "That song is no
    longer in the Song bank". This is FU2 O3's flake, made steady by load. It passed in the gate rerun. It is not
    caused by C-SHIP.
- Toasts (MIDI not allowed, the wake-lock note) draw over the chart dialogs at 1024 × 700. That is pre-existing and
  app-wide, not chart-specific.

## Not verified

- Real Mac (WebKit / the native shell), real iPad touch and on-screen keyboard resizes, Electron, real MIDI.
- Screen-reader announcement of the placeholder's "Loading the chart…" (role=status is set).
- Today's screens' theme audit (`themes` / `tools/themes/shoot.mjs`), beyond probe p4's contrast of the toggle; the
  `themes`, `eq`, `mini`, engine and Electron suites were not run.
- First-load time of the chart modules on a slow device (O2).

## Gates

Run with `node tools/cloud/gates.mjs` on tree bf76580 (clean), one suite at a time, `UI6_PURITY_BASE=origin/v2-native`,
`PLAYWRIGHT_BROWSERS_PATH=/root/.cache/rig-pw`. The commit after it only adds this file and LANE.md.

| suite | result | count / note |
|---|---|---|
| shell-unit | PASS (2nd run) | 417/417; the 1st run failed `bank-trial` "skeptic F1–F3" (O6), which passed on the rerun once the box was quieter |
| unit | PASS | 689 pass, 0 fail |
| chart | PASS | 47/47 (+ F1, F2 ×2) |
| ui-v6 | PASS | 91/91; flag-off purity vs origin/v2-native |
| ui-v6-edit | PASS | 44/44; purity vs origin/v2-native |
| ui-v6-ipad | PASS | 29/29 |
| ui-v6-bank | PASS | 23/23 |
| settings | PASS | 118/118 (app, fixture, mac, bridge, v6) |
| ui-core | PASS | 79/79 |
| edit-v2 | PASS | 14/14 files |
| migration-1x | PASS | unit + browser (both quota.pw tests) |
| ui-v6-themes | PASS | 30/30 runs clean (8 themes × Mac / portrait / landscape + 6 colour-blind); 43 Mac screens with `chart-loading` |

Also, on the O4 tree 9606281 alone: shell-unit, unit and migration-1x PASS.

## Commits (lane-cship, after the rebase)

- 9606281: the O4 call per D9 (store, chart-store / kept / d8-skeptic tests, quota.pw, CONTRACT_CHANGES, DECISIONS
  note, release notes).
- 259a633: F1 (styles.css + chart suite test).
- 24b817f: the ui-v6-themes tour's `chart-loading` state (Mac + IPAD_STATES).
- 2877800: the release-notes line and the `?chart=1` note.
- a723b11: F2 (import.js `keepClearOfPanic`, v6 chart edit.js, styles-chart.css, styles-v6-chart.css, chart suite
  tests, CONTRACT_CHANGES).
- a25b76d, 15ebecb, 983879e, bf76580: LANE.md (WIP).
- The builder's commits after my rebase: b56c4f5, a17195e, 3066cbd, be45060. 3066cbd's message ("O4 refuses addSong
  past the cap") is out of date: 9606281 reverses that part.
