# Chart view (D7, hidden): skeptic review (2026-11-24)

Verdict: **VERIFIED, after fixes.** As delivered, the change was PARTIAL. Flag-off purity, storage, XSS safety, the
transpose-follow rule and the timers all held. Eight defects did not:

- an Em chart on a song set to G showed Gm Eb Bb F (V1);
- the Panic test was vacuous (V2);
- an orphan dialog could open after the view was gone (V3);
- Lock didn't stop a save from a dialog that was already open (V4, reachable only by a store write today);
- there was no focus trap (V5);
- chords were 1.7:1 on Daylight Day (V6);
- targets were under 44 px (V7);
- the review printed "null" (V8).

All eight are fixed, with tests, and the gate is green. Ryan still has to confirm two choices: V1's relative-key rule,
and the dialog covering PANIC (O1).

Under review: the uncommitted change in `wt-chart` (lane-chart on 5430a8e): `app/js/views/chart/*`,
`app/styles-chart.css`, and the edits to main.js, store.js and perform.js, with their tests. I didn't build it. Every
chart in my probes and tests was written for them.

## Gate

The box had 2 CPUs and another agent running; the load average was 3–5 throughout. I ran the suites one at a time.

| suite | result |
|---|---|
| `node --test 'test/unit/charts/*.test.mjs'` | 119/119 (C2's 106 + chart-view 13) |
| shell unit + browser (`run.mjs --skip electron`) | unit 261/261, browser PASS (includes chart-store 9/9) |
| chart (`test/phase2/chart/run.mjs`) | 15/15, then 15/15 |
| settings | 86/86 |
| ui-core | 77/77 at load 4–5, including "H-v2 Quick sheet: TAP sets the song tempo" |
| themes | not run: no shared CSS changed (`styles-chart.css` is linked only while the flag is on) |
| `build-engine-api.mjs --check` | up to date |
| console.error / HTTP ≥ 400 | 0 in the chart suite and in every probe (flag off and on) |
| Electron suites | not run (Linux box). The flag-off path is the same code in both shells. |

**ui-core claim: confirmed.** The TAP test passes on this branch at load 4–5. It times real taps, so 94 BPM at load 9
fits stretched intervals. The chart code isn't loaded in ui-core (flag off).

## How I checked

- **Flag-off purity** (`/tmp` probe; not committed). I served `git archive 5430a8e app` and this branch through the
  same server.js, three boots each, at 1280×800. I compared:
  - the requests;
  - `store.subscribe` listeners, counted by a routed store.js that exposes the `listeners` Set;
  - the window and document `addEventListener` calls, by type;
  - `setInterval` calls;
  - the DOM (outerHTML, with digit-bearing attribute values normalised).

  Results:
  - Non-sample requests were identical, 103 paths each. Sample mp3 fetches vary from run to run in both builds.
  - 14 store listeners in both builds, the same listener types, 3 intervals in both.
  - The DOM was identical. One base/branch pair differed only by the MIDI-clock `<select>` being filled
    asynchronously.
  - Boot to `__rig.ready` took 5.7–7.1 s on base and 6.3–7.2 s on the branch, which is noise. The flag-off cost in
    main.js is one `URLSearchParams` and one `store.get()`.
  - The only difference is `__rig.setChartView` and the `__rig.views.chart` getter, which is intended.
  - `?chart=0` with the flag absent is a no-op: `set` returns false and fires no notification.
- **Lifecycle** (flag on). I counted `requestAnimationFrame` and `setTimeout` calls coming from `views/chart/` by
  stack.
  - Auto-scroll stops on a switch to Edit (offsetParent null), on a song switch and on close. It keeps running
    through a resize, with the rate recomputed every frame.
  - With the dialog open, a pending remove-confirm timer, auto-scroll on, and then the flag turned off: subscribers
    went from 15 back to 14, with 0 rAF, 0 timers and 0 `.chv-*` nodes left, including 3.5 s later after the remove
    timer would have fired. Five on/off cycles also leave nothing behind.
- **Store.**
  - At the cap: 32768 emoji (65536 units) are accepted and one more unit is refused; combining marks, `é` × 65536,
    lone surrogates (JSON is 6×) and newlines (JSON is 2×) all pass. The library check uses the JSON size, so the
    escaping counts.
  - `__proto__` and `constructor` keys are dropped. `migrate` is idempotent on messy input.
- **Older build.** I ran the 650df77 store against a library made by this branch:
  - `migrate` keeps `song.chart`;
  - load, edit, persist and duplicate keep it;
  - its export carries it;
  - this branch reads it back intact.

  650df77 also exports `settings.chartView`, because it doesn't know the setting is device-local. That's harmless: a
  replace-import here keeps this machine's value, and a merge ignores settings.
- **XSS.** A chart had `<img onerror>` in its title, a `<script>` comment, an HTML section label, `<img>` lyrics, an
  `<svg onload>` inside a chord, an `<iframe>` in a tab section, and entities. Result: 0 elements injected, 0 alerts,
  and the text was shown literally. The only sink is `h()`, which uses textContent, createTextNode and setAttribute.
  There is no innerHTML anywhere in `views/chart/` or util.js.
- **Transpose.** I checked every target key from a G chart and from an Em chart. The spelling is C2's: Db shows
  `Bbm E B`, because Fb and Cb are never written (C2 F2). I also checked unkeyed charts in both modes, a `{key: A}`
  chart on a G song, and a stored key against the source key; the source key wins.
- **Module boundaries.** Views use `store.set`, `setChart` and `addSong` only, with no engine or controller import.
  logic.js imports only `shared/`. Every new line is ≤ 120 characters. The perform.js change is the claimed 2 lines.
- **Screenshots** (`chart-view-shots/`): Classic and Sanctuary Day at 1280×800, Classic at 1024×700, and the import
  dialog at 1024×700. I looked at all four.

## Findings

- **V1 (major) Mode mismatch transposed into the wrong key.** `chartShift` matched tonics.
  - Before: an Em chart on a song set to G showed Gm Eb Bb F over a G drone, and a G chart on an Em song showed E
    major.
  - Fix: when the modes differ, the chart's tonic is neither Play In nor Hear In, and its relative key is one of them,
    the chart is matched through its relative key. Parallel mismatches (Em on E) keep the tonic match.
  - Both modes use one pitch class, so Heard − Hands equals the transpose amount for all 12 × 12 × 2 songs (tested).
  - **Ryan to confirm** the rule (O2).
- **V2 (major, test) The Panic test was vacuous.** The controller's Esc branch calls its inner `panic()` (controller.js
  `case 'Escape'`), not `controller.panic`, so wrapping the method could never count anything. The test now counts the
  `action` events of type `panic`, and a positive control (Esc with nothing open) must see exactly one.
- **V3 Orphan dialog.** `openImport` awaits `import('./import.js')`. If the flag went off in that window, the dialog
  opened on `<body>` with no owner (reproduced: 1 orphan). It now re-checks `destroyed`, Lock and the song after the
  await.
- **V4 (low, defensive) Lock leak.** Lock only disabled the buttons, so a dialog that was already open could still
  Save or add CSV songs once Lock came on. Today only Perform's Lock button sets the lock, and the dialog covers it, so
  the UI can't reach this. A store write can (DevTools, tests, a future hotkey). Now Lock coming on closes the dialog,
  as main.js closes Settings, and `save()` refuses under Lock.
- **V5 No focus trap.** The dialog has `aria-modal`, but Tab left it on 29 of 30 presses, into the covered Perform
  controls. It now has a Tab and Shift+Tab trap, like settings-import.js. A keyboard-opened dialog returns focus to
  its button. A tapped one doesn't, because a focused button would hold off Space = sustain and Esc = Panic.
- **V6 Contrast.** Chords and section headings used `--accent`, which is a fill on Daylight Day: 1.74:1. They now read
  `--accent-text` first (themes/README hook), which gives 6.12:1.
  - Every pickable theme measures ≥ 4.5:1 for lyric, chord, heading, comment and key text.
  - The lowest are chord and heading at 5.64 on Sanctuary Day; heading text is 14.9 px bold.
  - The chart suite now asserts this for every theme.
- **V7 Targets.** A−/A+, the speed −/+, ▲/▼ and × were 31–40 px wide. Dialog buttons were 36 px tall, the selects
  32 px, and the checkboxes 13 px.
  - Now every panel and dialog button is at least 44 × 44, and each offer row is a 44 px label with a 22 px box.
  - The Chart toggle stays at 36 px, like Notes and Click in that row (O3).
  - The suite asserts the panel sizes.
- **V8 The word "null" in the review.** `review.append(warnList(...))` appended the string "null" whenever the parser
  had no warnings. That was every clean chart, and the CSV view too. It is fixed, and the suite asserts that the
  review text never contains "null" or "undefined".

The other claims check out with no change needed:

- flag-off purity;
- `song.chart` with no SCHEMA bump, the 65536 cap and the library guard;
- charts travelling with export and import;
- `chartView` being device-local;
- offers starting unticked and only ticked ones being written;
- Hear In / Hands following Easy Transpose;
- the 2-bars-per-line pace (10 lines at 120 BPM in 4/4 = 40 s);
- the swap on a `currentSongId` switch;
- remove-confirm.

## Fixes (files)

- `app/js/views/chart/logic.js`: `chartShift` relative-key match (V1).
- `app/js/views/chart/index.js`: re-check after the import await, `destroyed`, Lock closes the dialog, keyboard opener
  (V3, V4, V5).
- `app/js/views/chart/import.js`: Tab trap, focus return, Lock check in `save()`, null-safe review append (V4, V5, V8).
- `app/styles-chart.css`: `--accent-text`, 44 px targets (V6, V7).
- `test/unit/charts/chart-view.test.mjs`: +1 test (V1, including the Heard − Hands invariant).
- `test/phase1/shell/chart-store.test.mjs`: +1 test (multi-byte cap, JSON-size library check, reserved keys).
- `test/phase2/chart/run.mjs`: the Panic test rewritten (V2); new tests for the focus trap, Lock / race, and
  contrast and targets on every theme; "null" assertions.
- `CONTRACT_CHANGES.md` "Chart view (D7, hidden)": a skeptic-pass note and updated test counts.

## Open items

- **O1 PANIC is covered while the import dialog is open.** The full-screen host is z 60; Settings is z 50 and also
  covers it. ⌘. still panics, and Esc closes the dialog. This is a library change that is frozen under Lock, so it may
  be acceptable. Ryan's call.
- **O2 V1's rule is a judgement.** If a song's minor flag is often left unset, the tonic match would be right for
  "Em chart on an E song", and V1 keeps that case. The header then shows "Key Em" on a song labelled G, with no "relative" hint.
- **O3** The Chart toggle is 36 px, following the row's convention (Notes, Click). It's below the 44 px rule.
- **O4** `duplicateSong` and `addSong` don't check `LIBRARY_MAX_CHARS`. A 64 KB chart duplicated 29 times passes 2 MB.
  Real charts are 2–5 KB, but this path predates charts and is now cheaper to hit.
- **O5** At 1024×700 the stage row leaves about 270 px for the chart: about 2.5 lines at the default 24 px (see the
  screenshot). This belongs to the D7 design pass.
- **O6** A key offer compares against Hear In. A chart written in the Play In key of a transposed song is offered as a
  key change, and ticking it moves both keys.
- **O7** A file over 1 MB is refused with "A chart can be at most 64 KB", although the file limit is 1 MB (for CSVs).
  The wording is slightly off.
- **O8** `renderTools()` runs on every store change while the panel is open. It's cheap, but I didn't measure it
  during a fader drag.
- **O9** I ran no Electron/Mac suites, so there is no real-keyboard or real-MIDI check of the dialog's key handling.
  The controller's typing guard covers the textarea.
