# UI v6 U7b (the chord chart in the v6 layout): skeptic review (2026-11-26)

Verdict: **VERIFIED, after fixes.** As delivered and rebased the work was PARTIAL. The refactor of today's hidden
chart view is faithful, both flag combinations are pure, and nothing outside the views changed. I found five
defects and fixed all of them:

- One medium in playing. A tap on the chart left it focused. Space, the sustain pedal, then paged the chart, and the
  first Esc only let go of it, with no Panic.
- Four low:
  - A finger on a mini fader plus a finger scrolling the chart counted as a pinch.
  - The Edit chart dialog drew the preview of an oversized paste.
  - A chart saved on a Try it song said "Chart saved.".
  - The header's segmented buttons were 40 px tall.

I also applied the two orchestrator decisions (below).

Under review: e414a0b on lane-u7b, rebased by the coordinator onto v2-native f46bac4 (U7a: Song bank + Try it; only
docs conflicted). It adds:

- `app/js/views/v6/chart/` (`chart.js`, `panel.js`, `minis.js`, `edit.js`) and `app/styles-v6-chart.css`;
- `views/chart/core.js`, with today's `index.js` refactored onto it, and `import.js chartReview`;
- the `logic.js` percent / Fit / jump helpers and the sidebar's late modules.

It touches `main.js` (`applyChartView`), `v6/perform.js` (`chartMounts.v6`), `v6/sidebar/notes.js` and
`v6/edit/edit.js`. I didn't build it.

## Orchestrator decisions applied (tier 2)

- **(a) The default placement for a device that never chose is the stage.** This is Ryan's earlier "give the user
  the choice" plus the orchestrator's recommendation. The commit is 7c85476.
  - `CHART_PLACEMENT_DEFAULT = 'stage'`.
  - With nothing stored, the Chart tab, the rail icon, Notes' Chart and v6 Edit's Chart button put the chart up on
    the stage. The sidebar folds, with Chart lit.
  - The builder's `save()` wrote `placement` with every size, mode or speed change, so any tap froze the default
    as if it had been chosen. `placement` is now written only by ⇥ Sidebar / ⤢ Stage.
  - Test: "U7b both on" checks the default, that nothing is stored, the stage, ⇥ Sidebar and that 'side' is then
    stored.
- **(b) Kept as built:**
  - the snapshots row on the stage (foldable);
  - separate stage and sidebar text sizes (100 % / 75 %);
  - the Chart tab / rail behaviour (`take()` / `away()`: on the stage, the tab only brings the chart back up there).

## These claims held

- **The refactor (v6 off + chart on = today's hidden view).** I diffed `index.js` / `import.js` against f46bac4
  line by line, then ran one scenario on the base build and on the branch:
  - the scenario: boot `?chart=1&ui6=0`, set a chart, open it, A+, speed −, Hands, open Add chart and type, Esc,
    auto-scroll on / off;
  - **identical** on both builds: the panel's outerHTML, the toggle, `state()`, the stored prefs, the dialog's
    outerHTML (with its review), the auto-scroll rate, the window / document listener counts by type, and errors
    (none);
  - the only difference is one extra request, `views/chart/core.js`;
  - today's 15 chart checks pass.
  - Prefs saves now merge into the stored object (before, they replaced it). That is intended, so the v6 fields
    survive today's view.
- **Flag combinations.**
  - v6 on + chart off: the chart suite's purity probe against f46bac4 is identical (139 requests, 17 store
    listeners, 2022 elements).
  - Both flags off: ui-v6's flag-off purity against f46bac4 is identical, and today's chart suite fetches nothing.
  - Four chart on / off cycles, with the chart on the stage and the Edit dialog open, leave no chart DOM, no v6
    stylesheet and no `.v6-chart-on`. The window / document listener count returns to a stable value, and the tabs
    and rail return to the four modules in order.
  - The saved layout keeps Chart's place and tab while the flag is off.
- **main.js races.** `setChartView(true); setUiV6(false)` in one tick ends with today's view and no v6 chart. The
  reverse order ends with the v6 chart in the sidebar registry. `applyChartView`'s retry works because a pending load
  is reused and then re-dispatched to the other module.
- **U7a interplay.**
  - A Try it song with a chart shows its chart on the stage, with the mini faders of the trial's instruments.
  - Back shows the previous song's chart again, still on the stage.
  - A cue never swaps the chart.
  - `perform.js` `chartMounts` sits beside U7a's `openBank` / banner and doesn't touch them.
  - ui-v6-bank passes 16/16.
- **Mini faders = the strips' writes.**
  - With a snapshot playing, a mini fader drag changes the live level through `scenes.adjust`. The stored gain stays
    0.8, and the strip and the mini agree (697 / 697).
  - Under Lock the ON tile still mutes, and Edit chart… is disabled.
  - A song switch mid-drag doesn't write into the next song (gain 0.7 stays 0.7).
  - There is no MIDI-learn badge on the strips either, so the minis lack nothing there.
- **Text size.**
  - Fit is disabled on an empty chart, and calling `fit()` there is a no-op.
  - A single 400-character line fits at nothing: Fit gives 50 % and the sheet scrolls sideways (as documented).
  - A two-line chart gets 200 %. A 62-character line gets 50 %, with no wrap, and wraps one step up.
  - ⌘+ in a text field does nothing. Ctrl-wheel off the chart does nothing, and a plain wheel scrolls.
  - Bad stored values fall back to the defaults without errors: `pct: 77`, `'75'`, `speed: 99`, `mode: 'zz'`,
    `placement: 'nowhere'`, `stage: 'yes'`, `font: 'x'`.
  - The migration is idempotent: font 5 → 175 % once, and a later font 0 doesn't move it.
- **Edit chart.**
  - Offers are never applied silently.
  - Esc closes the dialog without a Panic, with "Esc always panics" both on and off, and with the focus on a dialog
    button or on nothing. The next Esc panics.
  - Markup in the title, a section name, a chord, a lyric, a tab block or the song name is shown as text (no
    element, no request).
  - `store.setChart` is used as before: today's save, plus a Remove (`null`) like today's.
- **Untouched:** `store.js`, `controller.js`, `engine/`, `shared/`, `views/perform.js` and `views/components/`
  (`git diff f46bac4 --stat`).
- **Layout.** At 1024 × 700 and 820 × 1180, neither the stage nor the sidebar makes the page scroll, and the dialog
  fits (1024: 20–1004 × 70–630; 820: 16–804 × 114–1066).
- Zero console.error and no HTTP ≥ 400, in every suite and every probe.

## Findings

- **F1 (medium, live) A tap on the chart left it focused.**
  - The chart body is `tabindex=0`, for keyboard scrolling. A click or tap focused it.
  - Measured: Space then paged the chart 320 px and no sustain came on (`status.pedal` false). The first Esc only
    blurred the chart: 0 panics.
  - Today's chart body was never focusable, so on v6 this was a regression for a surface the player taps mid-song.
  - Fix (539cafb, `panel.js`): a focus that isn't `:focus-visible` (a pointer) is let go at once. Tab still reaches
    the chart, and ↑ ↓ PgUp PgDn Home End still scroll it.
  - Test: "U7b skeptic F1": tap → nothing focused, Space = pedal with no scroll, Esc = one Panic; keyboard focus →
    ↓ scrolls.
- **F2 (low, iPad) A hand on a mini fader plus a finger scrolling the chart was a pinch.**
  - The pinch read `e.touches`, which holds every finger on the screen.
  - Measured at 1180 × 820: text 100 → 150 %, and the scroll was cancelled (touchmove prevented).
  - Fix (539cafb): only touches that started on the chart count.
  - Test: "U7b skeptic F2" (CDP touch): the size is unchanged, and a real pinch on the chart still steps.
- **F3 (low) Edit chart drew an oversized paste.**
  - A 300 KB paste drew 5000 preview lines: 942 ms on the main thread at each typing pause, with the keys live
    behind the dialog.
  - Fix (23b6cf9, `edit.js`): over `CHART_MAX_CHARS` there is no preview, "Too large to show…" appears, and the
    status reads "Too large to save". The size error and the disabled Save are as before.
  - Test: "U7b skeptic F3".
- **F4 (low) "Chart saved." on a Try it song.**
  - A trial song is never saved (U7a), so Back drops the chart. Keep keeps it, because `keepTrial` copies changed
    fields, `chart` included.
  - Fix (23b6cf9, `edit.js`, `import.js chartReview`): the dialog header says "trying this song: Keep it to save the
    chart", and the toast says "Chart set for this try. Keep it to save it with the song.".
  - Test: "U7b skeptic F4": the header and the toast, and nothing reaches `exportJSON`.
- **F5 (low) 40 px buttons.**
  - Heard / Hands, small A / % / big A / Fit and the dialog's ChordPro / Chords over words buttons were 40 px tall.
    ⇥ was 36 px wide at 1024 × 700.
  - This broke the project's rule (UI6-U1, chart-view review): every visible Perform button is at least 44 × 44.
  - Fix (83858fb, CSS): 44 px minimum. The two wells lose their 2 px padding, so the header keeps its height
    (46 px wells). The stage's tools still keep one row at 1024 × 700 (the iPad / 1024 check passes).
  - Test: "U7b skeptic F5": every button and select in the stage and sidebar headers, the mini faders and Edit chart,
    at 1280 × 800 and at 1024 × 700.

Each new check fails on e414a0b. I ran the full v6 part with the app reverted: 17/23, with exactly the default
check and F1–F5 failing, each on its own assertion.

## Gate

The box had 2 CPUs, shared with lane-u7c. I ran the suites one at a time.

| suite | result |
|---|---|
| chart (`test/phase2/chart/run.mjs`: today's 15 + U7b 23) | **38/38** |
| ui-v6 (incl. flag-off purity vs f46bac4) | **68/68** |
| ui-v6-edit | **32/32** |
| ui-v6-bank | **16/16** |
| settings (5 modes) | **111/111** |
| shell unit (`test/phase1/shell/run.mjs --only unit`) | **377/377** |
| chart unit (`node --test test/unit/charts/*.test.mjs`) | **123/123** |
| new checks against e414a0b | default + F1–F5 fail |
| console.error / HTTP ≥ 400 | 0 |
| ui-core, edit-v2, Electron / Mac suites | not run |

## Fixes (commits on lane-u7b)

- 7c85476 decision (a): default placement = the stage (`chart.js`, chart tests).
- 539cafb F1 / F2 (`panel.js`, chart tests).
- 23b6cf9 F3 / F4 (`edit.js`, `import.js`, chart tests).
- 83858fb F5 (`styles-v6-chart.css`, chart tests).
- This review, plus a skeptic note in CONTRACT_CHANGES "## UI v6 U7b (chart)" and in the build plan's U7b status.

## Open items

- **O1 The Notes module has F1's focus issue (low; U3's file).** `v6-notes-text` is `tabindex=0`, so a tap on the
  notes holds off Space and the first Esc. The same `:focus-visible` let-go would fix it. I didn't change it here.
- **O2 Auto-scroll stops when the chart changes place** (⇥ / ⤢, ▤ Strips). Each place has its own panel. This is
  harmless, but the player has to press ▶ again.
- **O3 Keep on a trial song that is already in the library** selects that song as it is, and the chart set while
  trying is dropped (U7a's Keep rule). F4's "Keep it to save it" is then not quite true.
- **O4 A 64 KB chart (the cap) costs ~350 ms per typing pause** in the preview on this box. Real charts are
  2–5 KB.
- **O5 Test hook:** `__rig.views.chart.state().pct` is the shown panel's percent. It overrides the top-level stage
  `pct` while the sidebar shows.
- **O6 Choices to confirm with Ryan** (the builder's, minus decision a):
  - the migration fills the stage size only;
  - there is one row of jumps, which scrolls sideways;
  - the mini faders have no meter or wheel indicator;
  - ▤ Strips also shows in landscape;
  - Edit chart… also sits in the sidebar.
- **O7 Not verified:**
  - the Mac app: ⌘+ / ⌘− reaching the page (there are no zoom roles in the menu: code read), ⌘-scroll and pinch on
    a real trackpad;
  - a real iPad (touch was CDP emulation), and WebKit's `:focus-visible` on the F1 path (Safari ≥ 15.4 has it; an
    engine without it keeps the old focus);
  - VoiceOver;
  - the Electron suites.
