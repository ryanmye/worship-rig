# Cloud response to reviews/local-findings.md

Cloud tree, 2026-09-28. Nothing here is committed: these are cloud working-tree edits, and they reach the Mac with
the next drop / SYNC. Details and measurements are in CONTRACT_CHANGES "## l3" and "## l3-l4-merge".

- **L-1 (ELECTRON_RUN_AS_NODE)**
  - Fixed where: pulled from main (db41087). `electronEnv()` is in `test/integration/lib.mjs`, and it is used by
    `electron-full.mjs`, `build-lint.mjs` (build and packaged boot) and `test/phase1/shell/electron.boot.mjs`. The
    four files are byte-identical to main.
  - Linux: `ELECTRON_RUN_AS_NODE=1 … --only build-lint,electron-full` passes 2/2, and shell passes.
  - Mac, verify after sync: `ELECTRON_RUN_AS_NODE=1 node test/run-all.mjs --only shell,electron-full` still passes
    (the SYNC merge should be a no-op for these files).
- **L-2 (build-lint on macOS)**
  - Fixed where: pulled from main (7e2439d) into `build-lint.mjs`: `--mac dir` on darwin, and the asar is read from
    `<productName>.app/Contents/Resources`. It was merged by hunk. The integrator's earlier build-lint change was
    already on main, so nothing was lost.
  - `test/README.md`: only the build-lint row was merged. Main's ui-edit rows are stale and were not taken.
  - Mac, verify: `node test/run-all.mjs --only build-lint` gives 23/23 with 1 skipped (boot is Linux-only), as
    reported.
- **L-3 (start() hangs on pending MIDI)**
  - Fixed where: `app/js/controller.js`.
    - `startPrimary()` no longer awaits MIDI.
    - A new option `midiInitTimeoutMs` (default 5 s) sets `status.midi` to
      `{available:false, reason:'pending', pending:true}` when the request hasn't answered. The request keeps
      running.
    - A late grant still runs `midi.select(settings…)` and clears reason/pending. A late denial sets
      'denied'/'failed'.
    - New `controller.midiReady()`.
    - `dispose()` makes a late answer inert.
    - `window.__rig.ready` = audio + song ready.
  - Tests: `test/phase1/shell/midi-l3.test.mjs` (8 tests) and a real-app Chromium test at the end of
    `browser.pw.mjs`.
  - **Open, cloud-owned UI (not changed here):** while pending, main.js toasts "MIDI could not start… reload" at
    about 6 s, and Settings says "…then reload". The proposed fix is in CONTRACT_CHANGES "## l3".
  - Mac, verify:
    - (a) `UIEDIT_MODES`-style diagnostic: with `midi-sysex` granted and 2 CoreMIDI inputs, `__rig.ready` now
      resolves in seconds. Record whether the app's first `requestMIDIAccess` ever answers, and when `status.midi`
      becomes `'pending'`. The root cause of the stuck first call is still not isolated.
    - (b) Chrome fallback (`npm run serve`), leaving the MIDI prompt unanswered: the app reaches Ready and sound
      works. Clicking Allow after more than 5 s connects the keyboard without a reload, and notes play.
    - (c) Worship Rig.app launched from Finder: the keyboard connects (checks the Electron "Platform dependent
      initialization failed" note).
- **L-4 (unbounded waits and sysex grants)**
  - Fixed where:
    - `test/integration/lib.mjs`: `MIDI_PERMISSIONS=['midi']` and `waitRigReady(page, {timeout:30000})`, which
      throws with `controller.status.midi`.
    - Used in `test/phase2/edit-v2/harness.mjs` (the 45 s ready-or-loaded race is replaced), `settings/run.mjs` and
      `eq/run.mjs`. All three now grant only `midi`.
    - The `electron-full.mjs` probe bounds `ready` and `viewsReady` to 30 s.
    - The reasoning is in test/README.md, "Web MIDI in the browser suites".
  - Linux: edit-v2 79/0, settings 26/26, eq 25/25.
  - Still open (other owners): `edit-v2/integration.test.mjs:96` grants `midi-sysex`. `soak.mjs:333` and
    `smoke-chrome-fallback.mjs:88` await `__rig.ready` without a bound (LOCAL owns them: switch to `waitRigReady`).
  - Mac, verify: `node test/run-all.mjs --only edit-v2,settings,eq` passes with the 2 MIDI inputs attached. Any hang
    now fails within 30 s and names `status.midi`.

## Update (polish-1)

- **L-3 UI follow-up: done.** `main.js` treats `status.midi.pending` as waiting (amber lamp, "Waiting…", one info
  toast "Waiting for MIDI permission — click Allow in Chrome's prompt…"; Electron: "MIDI is taking a while to
  start…"). There is no "could not start… reload" toast, and `midiHintShown` stays free for a later denial.
  Settings › MIDI reads "Waiting for MIDI permission — if Chrome shows a prompt, click Allow." Tests: ui-core
  "polish-1 (local L-3)", settings "MIDI pending".
- **L-4: `edit-v2/integration.test.mjs` now grants `MIDI_PERMISSIONS` ('midi' only).** `soak.mjs` and
  `smoke-chrome-fallback.mjs` are still LOCAL's.

## Update (l8)

- **L-8 (pinned samples over the cap in large-set): fixed in `app/js/controller.js`.** Details are in
  CONTRACT_CHANGES "## l8".
  - The ±1 / ±2 window is now also a byte budget. The current song is pinned first, then neighbours by distance
    (+1, −1, +2, −2) while the pinned total stays ≤ `PIN_BUDGET_MB` (600).
  - A switch applies the window with one `{pin:'replace'}`, so the old window is unpinned in the same call.
  - Neighbours never decoded before are decoded unpinned first and then planned with their exact sizes.
  - A song that alone is over 600 MB is pinned alone, with `status.memory.note` = "This song alone is X MB".
  - A `'warn'` event fires if `pinnedMB > capMB` after a preload.
  - `status.memory` gains `budgetMB`, `windowMB` and `pinnedSongs`.
  - The soak's cap check also requires `pinnedMB ≤ budgetMB` in every row (except "alone" rows), and there is a
    new `budgetMB` CSV column.
  - Linux: shell unit 153/153 (5 new L-8 tests; the walk fails at 754 MB against the old controller), engine pins
    2/2, soak (3 min) 12/12 with max pinned 568.9 MB.
- **Mac, re-check after the next drop:**
  - Run `node test/run-all.mjs --only soak --soak-minutes 20`.
  - The check "decoded samples stay under the engine cache cap (pins limited)" should PASS. Its detail now names
    the max pinned MB and the song.
  - In `test/logs/soak.csv`, the `pinnedMB` column should be ≤ 600 (`budgetMB`) in every row, especially the rows
    on `factory:gospel-stab-b3` and `factory:upright-pad` (754.2 / 939.4 MB before).
  - `decodedMB` should be ≤ 700, and decoded should no longer equal pinned there.
  - Report the new max pinned and the song. Also report any `[controller] pinned samples … exceed … cache cap`
    console warning.
- Note: `soak.mjs` is LOCAL-owned. The only edit is the check expression plus 2 fields in the page snapshot and
  1 CSV column. Merge it with the L-4 bounded-wait change.

## Update (l9)

- **L-9 (`text:'dirty'`: '13' typed → '1388' on the Mac): root cause is the test's key, plus binder hardening.**
  Details in CONTRACT_CHANGES "## l9".
  - `song.test.mjs:215` pressed `Control+A`. Playwright on macOS maps it to `moveToBeginningOfParagraph:`
    (`macEditingCommands.js:58`), so the caret went to 0 and `13` was typed in front of the `88`. The binder had
    held back the outside `99`. Reproduced on Linux 1/1 by sending the same key with that CDP command (`"1388"`);
    without it (or with `selectAll`) the field is `"13"`. The test now uses `ControlOrMeta+A`.
  - Binder (`views/edit/lib.js`): an outside write before the first keystroke keeps a whole-field selection (number
    fields are always re-selected), so a key replaces it instead of appending; the draft flag is set on
    `beforeinput` / `compositionstart` too; `focusout` re-applies the store value forced, so a debounced notes
    commit followed by outside writes can't leave a stale draft on screen.
  - New regression tests under a `store.set` storm every 20 ms: song tempo + notes, song-header name. Each asserts
    the field is exactly the typed text. Mutation-checked on Linux (each binder change reverted → the test fails).
  - Linux: edit-v2 11/11 files (90 tests), settings 29/29, ui-core 46/46.
- **Mac, verify after the next drop:** `node test/run-all.mjs --only edit-v2` passes, in particular
  `song: polish-1 text:"dirty"`, `song: L-9 — …storm…` and `song-header: L-9 — …rename storm…`. If a storm test
  fails on the Mac, report the actual value (it names whether a write was appended or a draft overwritten).
