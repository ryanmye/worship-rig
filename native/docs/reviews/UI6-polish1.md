# UI v6 polish batch 1 (U5a P1, U5b O2/O3/O5, U7a O1–O4, U7b O1–O3): skeptic review (2026-11-26)

Verdict: **VERIFIED, after one fix.** The items do what the builder says. One defect came from the rebase onto U7c
(F1, low): with Settings opened over the Song bank, the Esc that closed Settings handed the focus back to the bank's
search box, and the new `onEscape` hook then cleared the player's search. On 38c664b the same Esc closed the whole
browser, so this was an old double action showing up in a new way. The fix is one option in `bank.js`.

Under review: bfbfcd2, 774a669, 552552f, 7980edd and ee064a3 on lane-pol1, rebased onto v2-native 38c664b (U7c plus
its skeptic fix). The rebase conflicted in `components/overlay.js`, where U7c's `underModal` meets polish's
`onEscape`. Views and CSS only: `git diff 38c664b..HEAD` leaves `store.js`, `controller.js`, `engine/`, `shared/`,
`midi.js`, `main.js` and the Electron files untouched. I didn't build it. I checked the Esc logic first, then the
Back-into-gap rule.

These claims held:

- **overlay.js Esc order after the merge.** An `underModal` entry returns before `preventDefault`, so the Esc goes to
  Settings (main.js closes Settings or clears its search; D24.7 stands down for `settingsOpen` / `escClosedSettings`).
  Every other entry is `preventDefault`ed and `stopPropagation`ed first, then `onEscape` may keep it open. So an Esc
  that `onEscape` uses never reaches the controller's Esc = Panic (`defaultPrevented`). Only the bank passes
  `onEscape`. I probed (probe scripts, not committed):
  - The bank's search: text and focus, then Esc clears it and the browser stays; the next Esc closes. No panic with
    "Esc always panics" off or on (on: `escTyping` stands down for the search box, as before). Text left in the box
    with the focus elsewhere in the browser: Esc closes it (off) or panics and closes it (on), as on 38c664b.
  - Learn mode or Arrange under Settings: unchanged from U7c (ui-v6 "U7c skeptic F3" green).
  - The Quick sheet, the step panels, the v6 popovers and the song menu: no `onEscape`, so they behave exactly as on
    38c664b.
- **U5a P1, label in a frame.** `rafCoalesce` takes the latest bar centre; `d.add(() => placeTip.cancel())` cancels
  a frame that is still pending at destroy; the frame skips a hidden or detached label. I probed:
  - a live write followed by ⌘E in the same task, then back to Perform: the pick is dropped on the view switch, so
    no label is left misplaced;
  - Edit writes while Perform is hidden;
  - the flag going off one microtask after a write.
  - These gave the same result on 38c664b and on lane-pol1, with no errors. I didn't re-measure the ms figures.
    The test's count of layout reads outside a frame (0, Edit and Perform) and the ±2 px centring are green.
- **U5b O2, chooser holds the song.** The listener is on `document` in the capture phase. The controller's
  `onKeyDown` is a `document` bubble listener and skips `defaultPrevented` keys, so the order is right. In Electron,
  ⌘← / ⌘→ are menu items with `registerAccelerator: false`, so the renderer handles them and the chooser's
  `preventDefault` reaches them too.
  - Typing in the chooser's search box: ← and Shift+← move and select (`'pad'`, caret 1–2), and the song stays.
  - The IPC path (menu click, global hotkey, MIDI Program Change → `controller.nextSong`) is not keydown, so it
    still changes the song. The chooser then closes through `onLeaveSong`, and nothing is written to either song.
    That is a deliberate switch, so this is right.
  - After the chooser closes, → on `<body>` is Next again (the listener is removed).
- **U5b O3 / O5.** The "not available" line shows only once the engine list is loaded (`all.length > 0`), so
  nothing flashes at boot. The ≤ 760 px rules are scoped to `.v6.v6-edit`. The 1024 × 700 fit test is green.
- **U7a O2, Back into the gap.** The view writes `settings.setlistIndex` / `settings.setlistGap` with `store.set`,
  after `controller.backFromTrial()` resolves. Is that correct and race-free?
  - `selectSong` resolves true only after its commit. A superseding Next or GO during the load makes it return
    false, and then nothing is written. `keepGap` checks again that the same song and list are current.
  - `appliedIndex` stays where the commit put it (the reprise, or −1). That is the same state the controller is in
    when an entry is removed while its song plays, so `isPlaying` / cue / GO behave as in that case. Both writes are
    `NAV_SETTINGS`: no backup and no "edited" mark. The controller's `onStore` sees `cur === targetId`, so there is
    no second `selectSong`.
  - Probed with [a, b, c, b], b@1 replaced, then b@1 removed during the trial. Back gives b in the gap: Prev = a@0,
    Next = c@1. Then Next plays c@1 and Prev plays a@0. With [a, b, c], an insert at 0 after Back moves the gap to 2,
    with Prev = a@1 and Next = c@2 (store M4).
  - It stays within the module boundaries: views may `store.set`, and these are plain settings. The rule does live
    in a view, though, so only the banner's Back follows it. `perform.js destroy()`, which runs Back when the flag
    goes off, does not (O2).
- **U7a O3, trial export, in today's Edit code.** The new branch needs `isTrialId(s.id)`. The store's load skips
  `trial:` ids (store.js `isTrialId` in the load filter), imports make new ids, and Try it is v6 only. So flag off
  can't reach the branch, and ui-v6 / ui-v6-edit purity vs 38c664b is identical (105 requests, 15 store listeners, 4
  intervals, 2529 elements). Before this, a trial export from the setlist's Library file section called
  `download(name, null)` (`store.exportSong` returns null for a trial), and the ⋯ menu did nothing. A library song
  still exports from both places (test).
- **U7a O4, U7b O3.** The wording matches the code: `openSettings({section:'bank'})` → `openBank` over Perform;
  `trialKeepsLibraryCopy` reads the same `meta.packSongs` record that `addFromBank` uses for `existing`.
- **U7b O1, Notes focus.** I probed at 1180 × 820 with touch:
  - A touch tap leaves nothing focused, and so does a tap at 820 × 1180 portrait.
  - Tab reaches the notes and keeps them focused, and PageDown scrolls them (0 → 294).
- **U7b O2, chart resume.** `place()` is read from the panel that is showing, before the old one is dropped.
  `resume()` checks `el.isConnected`. A panel left in the folded sidebar stops its own loop on its next frame
  (core.js `offsetParent === null`). The test covers ⇥ / ⤢ both ways, and a stopped scroll stays stopped.
- **Zero console.error / HTTP ≥ 400** in every browser suite and probe.

## Findings

- **F1 (low) The Esc that closes Settings over the Song bank cleared the bank's search.**
  - Settings can open over the browser (⌘, or the gear; the bank has `closeOnOutside: false`). Settings' own
    window listener runs first and closes Settings. Because the search box was keyboard-focused, it gets the focus
    back. Then overlay.js runs: the bank is the top entry and not `underModal`, so `onEscape` saw the focused,
    non-empty search and cleared it.
  - On 38c664b the same Esc closed the browser instead (the U7c F3 class of bug, which was fixed only for learn mode
    and Arrange). Probe, with "Esc always panics" off and on: 38c664b → `{bank: false, q: 'river'}`; ee064a3 →
    `{bank: true, q: ''}`; with the fix → `{bank: true, q: 'river'}`, no panic.
  - Fix (9014689): the bank's overlay entry is `underModal: true`, like learn mode and Arrange. An Esc meant for
    Settings never touches it. The bank's next Esc behaves as O1.
  - Test: ui-v6-bank "polish1 F1", for D24.7 off and on. It asserts the state that the unfixed code gets wrong.

These are acceptable or not defects:

- **A reload after Back into the gap lands on the reprise.** The selection is saved with the gap, but at boot
  `selectSong(cur, {index})` → `selectSongId` drops a gap whose index doesn't point at the song. An entry removed
  while its song plays does exactly the same on 38c664b (probed: both give `idx 2, Next null`). Not from this batch.
- **A tap on notes that already have keyboard focus keeps the focus**, because no new `focus` event fires. The
  chart body (U7b F1) behaves the same.
- **`resume()` across a song switch in the same task.** Store notifications come a microtask later, so a placement
  change in the same task as a song switch could carry the old song's line and auto-scroll into the new song's
  panel. No single user event does both, and a footswitch, MIDI or the rotation each arrive as their own task. This
  is theoretical, so I left it.
- **`bank.js` `escInSearch` doesn't check `isComposing`.** No overlay does today.

## Gate

The box had 2 CPUs, shared with lane U8's screenshot script. I ran the suites one at a time.

| suite | result |
|---|---|
| ui-v6 (incl. flag-off purity vs 38c664b) | **76/76**, purity identical |
| ui-v6-edit (incl. purity) | **37/37**, purity identical |
| ui-v6-bank | **21/21** (+1: F1) |
| chart | **41/41** |
| settings (app, fixture, mac, bridge, v6) | **111/111** |
| edit-v2 (14 files) | **14/14 files** |
| shell unit (`test/phase1/shell/run.mjs --only unit`) | **384/384** |
| console.error / HTTP ≥ 400 | 0 |
| ui-core, migration-1x, Electron / Mac suites | not run |

## Fixes (commits on lane-pol1)

- 9014689 F1 (`views/v6/bank/bank.js`, `test/phase2/ui-v6-bank/polish1.tests.mjs`).
- This review, plus a skeptic note in CONTRACT_CHANGES "## UI v6 polish batch 1".

## Open items

- **O1 Settings' Esc still closes the other Perform overlays that stay open under it (low, pre-existing).** These
  are the Quick sheet (`closeOnOutside: false`), and a step panel or popover when Settings is opened with ⌘,. This
  is the same class as U7c F3 / F1 here. `underModal` is opt-in, so flag off stays pure. Either opt in the v6 ones
  as well, or make overlay.js skip every entry on `e.rigSettingsEsc`, which would change today's Perform and needs a
  decision.
- **O2 Back-into-gap lives in the banner.** `perform.js destroy()` (flag going off during a trial) and any future
  Back (menu bar, a learned control) skip the rule. Moving it into `controller.backFromTrial` (a `gap` option for
  `selectSong`, or `store.selectSongId(id, index, {gap})`) would give one rule for every caller, but that is a
  controller / store change. The batch chose views only.
- **O3 A reload drops any setlist gap** (see above; store / controller boot, pre-existing).
- **O4 Not verified:**
  - the P1 ms figures (not re-measured; the layout-read count and the centring test are green);
  - real Electron global hotkeys and real MIDI Program Change under the chooser (the IPC path was exercised
    through `controller.nextSong`, and the rest is from reading the code);
  - a real iPad / WebKit (`:focus-visible` on touch; Chromium touch emulation only);
  - screen readers;
  - themes other than Sanctuary;
  - ui-core, migration-1x and the Electron suites (not run).
