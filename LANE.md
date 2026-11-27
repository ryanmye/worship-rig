# LANE C-SHIP (builder) — lane-cship, worktree /home/claude/wt-cship

Brief: DECISIONS D33, the chord chart ships in 2.0. `settings.chartView` absent = on, `false` = off (device-local);
Settings › Perform "Chord charts" in both Settings UIs (v6 search: chart, chords, chordpro, lyrics); the v6 Chart
sidebar module, v6 Edit's Chart button and today's Chart toggle show by default; "coming in 2.1" placeholders gone;
lazy load stays (no chart module requests / listeners / DOM until used or a song has a chart; purity probes express
it); chart-view O1 (PANIC over the chart dialogs), O3 (44 px toggle on touch), O4 (addSong / duplicateSong check
LIBRARY_MAX_CHARS), O7 (over-1 MB message); docs (CONTRACT_CHANGES "C-SHIP (D33)", release-notes draft, build plan,
2.1 mentions). Engine untouched. Don't push. Report: changes, purity before/after, tests, gates, risks, lane tip.

## Checklist
- [x] store: chartView semantics + migration; O4 cap in addSong / duplicateSong (notice `library-full`)
- [x] main.js lazy entry (today's toggle placeholder, v6 sidebar placeholder replaced in place), ?chart / setChartView
- [x] Settings row in both UIs (v6: moved into Perform layout › Perform)
- [x] Notes / v6 Edit chart buttons default on; 2.1 placeholders gone
- [x] O1 (body.chart-dlg-open lifts .btn-panic to z 61), O3 (styles.css coarse 44 px), O7 (fileTooLargeMessage)
- [x] tests: shell unit, chart suite, ui-v6, ui-v6-edit, settings, ui-core
- [x] docs: CONTRACT_CHANGES, DECISIONS notes, release-notes draft, BUILD_PLAN, UI6-build-plan, mockups README
- [x] fix: v6 Edit header overflowed at 1024×700 with the Chart button shown (styles-v6-edit.css ≤ 1100 px)
- [x] gates on ba4dfbc (gates.mjs): all PASS except migration-1x (O4 broke fixtures that grew past 2 MB by addSong;
      bigLib looped forever → 180 s / 480 s timeouts)
- [x] migration-1x fixtures fixed (d8-skeptic bigLib + D9 test, quota.pw.mjs); d8 12/12 and quota.pw 2/2 alone
- [x] gates.mjs migration-1x on ca7fe5e: PASS (117 s)
- [x] UI6-build-plan "C-SHIP status"; CONTRACT_CHANGES gates

## Gates so far (old runner, before the v6 Edit header CSS fix and the sidebar-test fix)
shell unit 415/415 (one run hit the known bank-trial F1–F3 flake, FU2 O3; 3 + 3 reruns pass), unit 685/0/12 skip,
chart 44/44, ui-v6 84/85 (U3 Notes asserted the 2.1 text; test fixed, not rerun), ui-v6-edit 42/44 (1024×700
overflow, CSS fixed, not rerun), ui-v6-ipad 29/29, ui-v6-bank 23/23, settings 114/114, ui-core 79/79, edit-v2 14/14
files, migration-1x running at the restart rule change.

## Purity (factory library, no charts, 1280×800)
- today's UI vs base 36ef998 (?chart=0): 105 requests, 15 store listeners, 4 intervals, 2529 elements; branch charts
  off identical; charts on identical + the Chart toggle only.
- v6: base ?chart=0 148 requests; branch charts on vs off: 148 requests, 19 store listeners, 3 intervals, same
  window / document listeners; +10 elements (Chart tab + rail icon).

## Gates on ba4dfbc (gates.mjs)
shell-unit, unit, chart 44/44, ui-v6 85/85, ui-v6-edit 44/44, ui-v6-ipad 29/29, ui-v6-bank 23/23, settings 114/114,
ui-core 79/79, edit-v2 14/14 files, ui-v6-themes 24/24 clean: PASS. migration-1x FAIL (fixtures, fixed next commit).

## Next step
Hand back (report below in the hand-off). Nothing open in the lane.

## Findings / risks
- Lazy rule has no store listener of its own: a chart arriving on a non-current song loads nothing until used.
- `__rig.setChartView(true)` / `?chart=1` still load at once (dev switch); on a v6 boot ?chart=1 only arms.
- O1 relies on no PANIC ancestor making a stacking context (checked with elementFromPoint in both Performs).

# Skeptic (C-SHIP)

Brief: try to break C-SHIP; implement the orchestrator's O4 change (add/duplicate past 2 MB warns and goes through;
refused only past the restore cap 2,500,000); review doc native/docs/reviews/UI6-cship.md. Commit on lane-cship only.

## Checklist
- [x] rebase onto origin/v2-native (ee5bcb9; conflicts CONTRACT_CHANGES, main.js applyCvd, ui-v6/ui-v6-edit purity
      filters: both sides kept)
- [x] read DECISIONS D7/D9/D16/D33, CONTRACT_CHANGES C-SHIP, reviews chart-view.md, UI6-U7b.md, diff
- [x] O4 change (store, chart-store test, kept.test, migration-1x fixtures, CONTRACT_CHANGES, DECISIONS note,
      release notes) 9606281; shell-unit, unit, migration-1x PASS on it
- [x] lazy load probes (both UIs, entry points, chart arrival, Off unloads): .probe/p1.mjs, p2.mjs — all held
- [x] migration / device-local / export-import / ?chart (unit tests + code read; ?chart=1 on v6 boot doc fixed)
- [x] O1 PANIC, O3, O7, v6 Edit header ≤1100 px: .probe/p3.mjs — all held (6 sizes, Esc off/on, Lock, off/swap)
- [x] iPad + themes placeholder (tour state chart-loading, 24b817f; p4 contrast probe)
- [x] release notes line (2877800)
- [ ] gates (running: UI6_PURITY_BASE=origin/v2-native, PLAYWRIGHT_BROWSERS_PATH=/root/.cache/rig-pw;
      log .probe/gates2.out)
- [ ] review doc

## Findings (before fixing)
- Env: this box's Chromium is build 1243, Playwright 1.56 wants 1194: export
  PLAYWRIGHT_BROWSERS_PATH=/root/.cache/rig-pw (tools/cloud/setup.sh mapping) for every browser run / gates.mjs.
- O-a: chart writes (setChart / chartOverflows) are still refused past 2 MB, while D9 lets every other save pass it
  (notes edits, now adds). Not changed (outside the O4 call); for the orchestrator.
- F1 (fixed): today's pressed Chart toggle under the mouse in Studio: dark cap hover under accent ink, 1.04–1.33 : 1
  (pre-existing in the hidden build, now on by default). styles.css hover/active rule; chart suite test fails first.
- O-a also: addPackSong (bank Add) refuses at 2 MB, while + New / Duplicate now go to 2.5 MB.
