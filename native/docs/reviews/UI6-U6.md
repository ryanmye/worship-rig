# UI v6 U6 (the v6 Settings): skeptic review (2026-11-26)

Verdict: **VERIFIED, after fixes.** As delivered it was PARTIAL: six low defects, none of them in playing. The undo
journal, the control-count claim and flag-off purity held under everything I threw at them.

Under review: ebce7b2, db7bc59, 5f02505, bc96c67 and e1a56e3 on lane-u6, on v2-native acfa900. They add
`app/js/views/v6/settings.js`, `app/js/views/v6/settings-summary.js`, `app/styles-v6-settings.css`, the settings
suite's `v6` mode (`test/phase2/settings/v6.mjs`) and `test/phase1/shell/ui-v6-settings.test.mjs`. They change
`views/settings.js` (hooks), `main.js` (one Esc line), `controller.js` (`lastBackupAt()`), `v6/sidebar/sidebar.js`
(exports) and `v6/snapshots.js` (exports). I didn't build it.

These claims held:

- **The undo journal.** I compared the whole Settings DOM (every element, every attribute, `<details>` open state)
  before and after each case, plus net window / document listeners, store listeners, live timeouts and `<html>`
  attributes.
  - Flag off while Settings is open on each of the 8 categories: identical. On MIDI Learn it falls back to Keyboards
    & MIDI, and on Perform layout to Look.
  - Flag off mid-search: identical, `data-settings-search` is gone, and the next Esc closes Settings. The same holds
    with a disclosure the search had opened (Diagnostics), which closes again.
  - Flag off with a MIDI Learn pending: the learn completes on the moved-back table (CC 21 → Keys level). The only
    DOM difference is that row's Clear being enabled, which is the mapping itself.
  - Flag off at 820 px while drilled in: `data-v6-drill` is removed, and today's narrow strip and body come back.
  - Flag off with the GarageBand import dialog open (Mac fixture): the dialog stays usable, and Esc closes it, then
    Settings.
  - 10 live flips with Settings open, then 10 flips with open / close in between: the DOM is identical. Store
    listeners stayed 15, window listeners 39 and document listeners 37 (both net), and `<link>`s 7.
- **Partial failure.** I injected a `throw` at four points of `enhance()`: after the header, after the MIDI Learn
  move, before `inst`, and inside `opened()` while open. Each time, today's Settings came back with only one line
  different: the preview switch, which is now on. Tabs were back in today's order, the CSS link was removed, Esc
  closed Settings, and there was one `console.warn` and no `console.error`. Reopening still gave today's Settings.
- **Control-count proof** (Chrome): 119 = 116 same element + 3 rebuilt, and 139 = 119 + 20, reproduced.
  - I ran it again on the Mac fixture with the full fake rig from `mac.mjs`. All 144 of today's controls are the
    same element with the flag on, none changes its hidden state, and v6 has 164. The only category moves are the 34
    MIDI Learn buttons, Keyboards → MIDI Learn.
  - I clicked through 36 controls the same way with the flag off and on, and compared the store writes and the row
    state after each. Every one matched. Those were latency, mono, drone freeze, click record, MIDI clock, Restart
    audio, Show device names, touch, the dynamic range slider, pedal reversed, Test my pedal, computer keys, Esc
    always panics, Program change and its Cue / channel, Learn (CC inject) and Clear, Choose pad folder…
    (`showDirectoryPicker` called), the pad-files chooser, Rescan, the GarageBand how-to, theme cards, Light Stage /
    Auto, chips, menu-bar mode / low-resource / menu-bar set, Export (download), Import… (chooser + file) and
    Diagnostics.
  - The only differences were the theme cards' "Aa" preview text and random ids.
- **Deep links:** every alias the suite lists, plus `learn`, `midilearn`, `layout`, `sidebar`, `theme`, `mac`,
  `bank`, `about` and `diag`, at 1280 and at 820 px. At 820 px each lands drilled in, with the right crumb.
- **Esc (D24.7).** With Settings open, Esc never panicked. I counted the controller's `action` / `panic` events,
  which catch both the controller's own Esc and main.js's `escPanicKey`.
  - The order was the same with "Esc always panics" off and on, over Perform v6, today's Edit and Edit v6: Esc clears
    the search, the next Esc closes Settings, and only the one after that is Perform's or Edit's.
  - It also held with the focus outside the search box (on a category).
  - Ctrl+. in Settings still panics once, the same as with the flag off. That is the global panic, as D23 wants.
  - GarageBand dialog plus search (Mac fixture): the dialog closes first, then the search clears, then Settings
    closes.
  - For Edit v6, I made a scratch merge of lane-u5 (f81a8ba) and threw it away afterwards. Only CONTRACT_CHANGES and
    the build plan conflicted.
- **Perform layout ↔ live sidebar.** Hiding Notes and moving Drone down in the ⋯ popover showed the same in Settings.
  Settings writes went to the live sidebar. Settings wrote to localStorage while in Edit, and the Perform sidebar then
  showed them. Collapsing the sidebar shows "sidebar folded" in the summary.
  - The last shown module can't be hidden.
  - There is only one list in the DOM at a time (4 rows).
  - The popover refactor (`customizeList` / `commitPrefs`) keeps the old rules: Starts saves without a rebuild, and
    order / show rebuild the heads. ui-v6's sidebar checks pass (below).
- **`controller.lastBackupAt()`** is a plain read: no store, disk or timer change. It reported the attempt rather than
  the success, which is F4.
- **Engine / shared / store / server / Electron main / preload / components: unchanged** (`git diff acfa900`).
- **Contrast** (the `tools/themes/shoot.mjs` audit, run over every category, the search state and the 820 px list):
  - Sanctuary: 0 fails at 1280 and 820.
  - Sanctuary Day: 0 fails at 820. At 1280 there is one "fail", the Perform strip's "Bend" `::after` behind the
    modal, which is an audit artefact.
  - Daylight Day: the v6 Learn… button was 2.6:1 (F5), plus a fail in today's Settings (O3).

## Findings

- **F1 (low) Search found rows that today's code hides.**
  - Under any theme but Daylight, today hides Daylight's Light row. Searching "auto follows" still gave "1 of 1",
    a badge on Look and an empty panel. "auto" and "stage" were also counted and jumped to.
  - Fix (76e87a0): units, and sections searched whole, with a hidden ancestor are left out.
  - Test "UI6-U6 skeptic F1".
- **F2 (low, keyboard / a11y) Drill-in by keyboard dropped the focus out of the dialog.**
  - At 820 × 1180, Enter or Space on a category row drilled in while the focus was on the row that the detail view
    hides. The focus fell to `<body>`, and the next Tab started from wherever.
  - Fix (c14116f): the focus goes to "‹ Settings", as after a deep link, and Back returns it to the row.
  - Test "F2", for both Enter and Space.
- **F3 (low) The undo journal grew while the flag stayed on.**
  - `renderLearned` gave each Forget button its own journalled click listener on every render (every open and every
    settings write). The journal, and the detached buttons it kept alive, grew until the flag went off.
  - Fix (1810b33): one delegated listener on the list. It looks the row's Clear up at click time, so it also follows
    a table rebuilt by today's code.
  - Test "F3": instrumented listeners, 4 opens, no detached Forget button still listened to, and Forget still works.
- **F4 (low) "backed up just now" after a failed backup.**
  - `lastBackup` is set before `rig.backupNow` runs, and `lastBackupAt()` returned it.
  - Fix (1da2601): `lastBackupAt()` returns only a backup that was written. It is still a read, with no new writes.
  - Unit test in `controller.test.mjs`.
- **F5 (low, Daylight Day) Learn… and Open Song bank… were 2.6:1.**
  - Daylight sets `--accent` to its text amber (`#8a5300`) inside `.ed-btn`, so the accent-filled buttons printed
    `--accent-ink` on dark brown.
  - Fix (7e59349): the fill is read on the dialog (`--v6s-fill`, `--v6s-fill-top`). It is now ≥ 4.5:1.
  - Test "F5".
- **F6 (low) Back up now left the summary stale.**
  - The summary re-rendered only on the next store write or status event: still "n songs · automatic backups" more
    than 4 s after a successful Back up now.
  - A `null` reply, which the toast reports as a failure, counted as a backup.
  - Fix (766c4d3, `views/settings.js`): `v6?.refresh()` after a success, and only a truthy, error-free reply counts.
  - Test: in the v6 Mac part, a failed backup leaves the summary, and a good one shows "backed up just now" within
    150 ms.

These are acceptable or not defects:

- `fold()` drops accents, so "é" matches every word starting with "e" and "pédal" finds "pedal". "(" matches the
  parentheses in labels. Unicode outside Latin ("日本", "ﬁ") gives "No match". Regex characters are escaped.
- `opened()` arms a 300 ms `setTimeout` that `destroy()` doesn't cancel. After a flip-off inside those 300 ms it
  renders the summaries into detached spans once. That is harmless.
- A failed enhancement leaves the flag on with today's Settings, and the next flip retries the import. There is no
  retry storm: `syncV6` runs on `uiV6` changes only.

## Gate

The box had 2 CPUs, shared with lane-u5's skeptic. I ran the suites one at a time.

| suite | result |
|---|---|
| settings, all 5 modes (`test/phase2/settings/run.mjs`) | **111/111** at 766c4d3 (app, fixture, mac, bridge, v6; v6 is 17 checks: the builder's 13 + F1, F2, F3, F5, with F6 inside the Mac part) |
| ui-v6 (`test/phase2/ui-v6/run.mjs`, incl. flag-off purity vs acfa900 and the sidebar / popover checks) | **68/68**; flag-off purity vs acfa900 identical (105 requests, 15 store listeners, 4 intervals, 2529 elements) |
| ui-core (`test/phase2/ui-core/run.mjs`) | **78/78**, first run |
| shell unit (`test/phase1/shell/run.mjs --only unit`) | **364/364** (363 + F4's test) |
| each new check against the pre-fix code | F1, F2, F3, F5 fail on e1a56e3 (13/17 in v6 mode); F6 fails without its fix (16/17); F4's unit test fails without its fix |
| my probes (`/tmp/u6probe/p1–p13`, not committed) | flips per category / mid-search / mid-learn / 10×, injected throws, search sweep, today-hidden units, drill-in focus and rotation, 36-control off-vs-on, contrast in 3 themes × 2 sizes, Mac fixture (controls, hidden units, GarageBand + Esc, Back up now), Settings over Edit v6 (scratch merge), Esc vs panic, sidebar both ways |
| console.error / HTTP ≥ 400 | 0 |
| edit-v2, Electron / Mac suites, real iPad | not run |

## Fixes (commits on lane-u6)

- 76e87a0 F1, c14116f F2, 1810b33 F3 (`views/v6/settings.js`, `test/phase2/settings/v6.mjs`).
- 1da2601 F4 (`controller.js`, `test/phase1/shell/controller.test.mjs`).
- 7e59349 F5 (`styles-v6-settings.css`, `v6.mjs`).
- 766c4d3 F6 (`views/settings.js`, `v6.mjs`).
- This review, plus a skeptic note in CONTRACT_CHANGES "## UI v6 U6" and in the build plan's U6 status.

## Open items

- **O1 Rotation loses the place (iPad, low).** If you rotate to landscape while drilled into a category and back to
  portrait, you get the list, not that category. Opening at 820 px also starts on the list, by design.
- **O2 Stale-while-open details (low).**
  - The "backed up n min ago" text doesn't tick while Settings stays open.
  - An automatic backup (controller timer) doesn't refresh the summary until the next store write.
  - A theme change during an active search doesn't re-run it, so the Light row's hits follow on the next keystroke.
- **O3 Pre-existing, not U6:** under Daylight Day, today's Sound › "Voices, buffer size and the voice limit…" note
  (`.st-engine-note`) is 1.88:1, with the flag off too.
- **O4 Choices to confirm with Ryan**, from the builder, plus mine:
  - Esc in the drilled-in detail closes Settings rather than going back to the list.
  - Search counts word starts only.
  - The Day / Stage / Auto row shows for Daylight only.
  - Perform view stays in Look.
  - Learn… goes to today's table, and U7 owns the "tap what it should change" flow.
- **O5 Not verified:**
  - the real Electron app and Mac (I used the fixture with a fake rig);
  - hotkey recording while a search is active (I checked the code path only: the v6 Esc listener stands down on
    `data-hotkey-capture`);
  - flipping the flag while an OS file chooser is open;
  - the search box's native × clear button (I used `fill('')` and `input`);
  - a real iPad / WebKit;
  - screen readers;
  - real MIDI hardware (I injected bytes);
  - themes other than Sanctuary, Sanctuary Day and Daylight Day.
