# UI v6 U8a (iPad layouts + edge states): skeptic review (2026-11-26)

Verdict: **VERIFIED, after fixes.** As delivered it was PARTIAL. The iPad layouts, the edge states, the absorbed
polish and flag-off purity do what the builder says. Three defects were left, all in the portrait layout or edge
states it adds:

- F1 (medium): at 820 px, once the sounds were ready, a MIDI problem's words ("Not allowed yet", "No device",
  "Starting…") had 0 px of room. Only "MIDI ●" was left.
- F3 (low-medium): at 820 × 1180 the first-run Start here card left the faders a 66 px track and the Trying banner
  left 59 px. Both are under the fader's 80 px input.
- F2 (low): the empty library's Restore a backup… looked live under Lock but was refused.

Each is fixed with a test that fails on the code before the fix.

Under review: 6c7c189, d6dd56e, 3b4d000, 567c75e and a85ee33 on lane-u8, rebased onto v2-native dcb2f06 (polish
batch 1). These add `app/styles-v6-ipad.css`, `app/styles-v6-states.css`, `views/v6/start.js` and the `ui-v6-ipad`
suite. They change v6 `perform.js`, `strip.js`, `lib.js`, `sidebar/sidebar.js`, `settings.js` and
`components/startCard.js`. `git diff dcb2f06..HEAD` doesn't touch `store.js`, `controller.js`, `engine/`, `shared/`,
`midi.js`, `main.js`, `index.html`, `styles.css` or the Electron files. I didn't build it. I checked the shared top
bar first, then rotation, then the edge states.

These claims held:

- **The top-bar rules are scoped to the flag.** Every rule that touches today's top bar is in `styles-v6-ipad.css`.
  That file is imported by `styles-v6.css`, which perform.js links only while the v6 Perform is mounted, and each rule
  also needs `body:has(.v6-perform)`.
  - Flag off, I took every element's box, opacity, cursor and overflow at 1280 × 800 and 1024 × 700 on dcb2f06 and on
    lane-u8. They are identical apart from the live meter bars: 563 / 507 elements.
  - The ui-v6 / ui-v6-edit purity probes against dcb2f06 are identical too.
- **The 44 px coarse rules don't reach a fine pointer.** The same comparison with the flag on, using a fine pointer,
  at 1280 × 800 and 1024 × 700 (453 / 397 elements) differs in only three places:
  - ⚙ is 44 px wide (it was 40 / 38);
  - the MIDI lamp clips and ellipsizes its words;
  - an empty strip's name has the default cursor, because it can't pick.

  None of the `(pointer: coarse)` sizes show up.
- **Rotation in the middle of a gesture (Chromium emulation, mouse).**
  - A range drag keeps going with the new key geometry and commits one value.
  - A strip reorder by its grip completes; the drop line is hidden afterwards.
  - A sidebar resize is cancelled (`onMq` → `endDrag(false)`), and the width pref is unchanged.
  - These held in both directions with no errors. Chromium fires no `pointercancel` on a viewport change. A real iPad
    most likely cancels the touch, which the same `endDrag(false)` / cancel paths handle (read, not run).
- **Rotation and a soft keyboard (emulated as a height change) with dialogs open.** I tested Rename, Save snapshot,
  the bank's search, the chooser's search and Settings' search. Each was typed into, shrunk to 820 × 760 or
  1180 × 420, restored, then rotated. Each stays open, keeps its text and focus, and keeps its input on screen, and
  the page never scrolls sideways. Settings keeps its drill state: a height-only resize re-runs `setDrill(drill)`.
  O3 has a caveat about the emulation.
- **Long names and 16 instruments.**
  - A 95-character song name ellipsizes in row 1 of the portrait song bar (521 px), and every song bar item stays in
    the bar at 820, 1180 and 1024 px.
  - At 820 × 1180 with 16 instruments, the strips scroll in their own row, the keyboard is full width (792 px) and no
    page scroll appears. Sixteen range bars in 26 px are thin but each one is there. For the pills, see O2.
- **Settings' 30 s timer.** I wrapped `setInterval`. Exactly one 30 s interval runs while the v6 Settings is open. It
  is cleared on close, replaced (not doubled) when Settings is re-opened on a section while open, and cleared when the
  flag goes off with Settings open. None ever runs with the flag off.
- **Start here.**
  - It uses today's key. The × and the first-song-change rule persist across a reload.
  - Flag off, today's card is word for word: the `songBar` branch is the only change, and the ui-v6-ipad flag-off
    check reads today's text in today's Notes.
- **Empty library.**
  - New song selects it. `store.addSong` selects anyway when nothing is current, so the card's `selectSong` only loads
    it.
  - D24.4 ("a new song from + Add song is not selected") is about adding while a song plays, where Perform must not
    switch the sound by itself. Here nothing plays, so this is a different entry point, and selecting is right.
  - Restore a backup… (Chrome) opens Settings › Library & Backup, drilled in at 820, with Import… visible. The Mac
    app's restore list is in the same `data-section="backups"`: read, not run.
  - Song bank… shows only with bank songs, and opens the browser.
- **The edge states are reachable and readable on the v6 stage.** The suite drives each of them. I re-read the 820
  and 1280 screenshots: first run, loading, MIDI denied / no device, stalled + Restart sound, restarting, asleep,
  paused, Lock, second window, storage full and empty library. That is where F1 showed: the stalled shot at 820 read
  "MIDI N".
- **Interplay with polish batch 1.**
  - The popover clamp only changes start-aligned popovers that aren't `beside`. The bank's set menu and the setlist's
    Add song are `align: 'end'`, so they are unchanged.
  - keyboard.js's handles are pooled and `pick()` lays them out synchronously, so `focusPicked` finds the handle in
    the same task. The rAF label then measures on the handle's `focus`.
  - Enter on a name under Lock, or on an empty strip, picks nothing, and `focusPicked` returns (`kb.picked !== i`).
    A keyboard pick switched by a pointer tap clears `kbPicked`, so the focus is not pulled back.
- **The coarse name hit area** is 44 px and ends exactly at the ON tile's top. A tap on the tile's top pixel hits the
  tile at 820 and 1180.
- **Zero console.error / HTTP ≥ 400** in every suite and probe.

## Findings

- **F1 (medium) A MIDI problem's words vanished at 820 px once the sounds were ready.**
  - U8a made `#midi-status > .midi-name` shrinkable at every width (to stop it running over the Sound lamp). That
    rule beat today's `.midi-name.off { flex-shrink: 0 }`, which exists because a MIDI state is a state, not a name.
  - At ≤ 900 px the ready words come back once all sounds are ready ("All 19 ready", ~90 px), and they took all of
    the MIDI lamp's room: `Not allowed yet` 0/101 px, `No device` 0/65, `Starting…` 0/61. The lamp then read "MIDI ●".
  - The suite's MIDI check rotated during loading, while the ready words were still hidden, and only checked
    `isVisible`.
  - At 1024 and 1280 "Not allowed yet" was cut to 80 / 92 px.
  - Fix (b9175e5, `styles-v6-ipad.css`): the MIDI state doesn't shrink, and the ready words ellipsize first. At ≤ 900
    px the ready words are hidden while a MIDI problem shows; the green lamp and its title stay.
  - Result: the words show whole at every size (101/101, 65/65, 61/61), with no overlaps. At 1280 × 800 the ready
    words lose about 9 px ("…") only while MIDI has a problem.
  - Test: ui-v6-ipad "skeptic F1" (blocked and no device, after ready, at 820 × 1180, 1024 × 1366, 1180 × 820,
    1024 × 700 and 1280 × 800).
- **F3 (low-medium) The Start here card and the Trying banner crushed the portrait faders.**
  - Both sit in the Learn / Arrange bars' slot. U8a gave the panel under the strips back 60 px only under Learn and
    Arrange.
  - At 820 × 1180 the result was:
    - first run: a 66 px track;
    - trying: 59 px. dcb2f06 had 178 px, before the two-row song bar and the stacked bottom row.

    Both are below the 80 px fader input, so the thumb sat over the dB and the Space / Echo row. A new player sees
    the first-run layout first.
  - Fix (39e2414): the same 240 px panel cap applies whenever `.v6-start` or `.v6-trybar` is visible. Now: first run
    126 px, trying 119 px.
  - 1024 × 768 / 1024 × 700 landscape stay at 91 / 81 px (first run) and 106 / 96 px (trying), all above the input.
  - Tests:
    - ui-v6-ipad first run: ≥ 96 px at 820, ≥ 80 px at 1024 × 768 / 700;
    - ui-v6-bank Try it: ≥ 96 px at 820.
- **F2 (low) The empty library's Restore a backup… looked live under Lock.**
  - It opens Settings, which `main.js` refuses under Lock with a toast. Meanwhile the top bar's ⚙ beside it is
    disabled, so the button broke Lock's "one look".
  - Fix (3af5e53, `start.js`): the button is disabled with a title, and the lock line names it. Song bank… stays
    live, because the browser is browse-only under Lock (U7a).
  - Test: ui-v6-ipad empty library.

These are acceptable, not defects, or not from U8a:

- **The MIDI lamp ellipsizes at 1280 on the Mac.** With the flag on, a connected device's long name ellipsizes (92 of
  179 px). Before, it ran over the Sound lamp. The full name stays in the title.
- **"Sound stopped — click "Restart sound"", "Play A S D F G H J K on your computer"** on an iPad: this is today's
  wording, which U8a reuses (O4).

## Gate

The box had 2 CPUs, shared with lane U8b. I ran the suites one at a time, after all three fixes.

| suite | result |
|---|---|
| ui-v6-ipad | **28/28** (+1: F1; F2 / F3 asserts added to existing checks) |
| ui-v6 (incl. flag-off purity vs dcb2f06) | **76/76**, purity identical (105 requests, 15 store listeners, 4 intervals, 2529 elements) |
| ui-v6-edit (incl. purity) | **37/37**, purity identical |
| ui-v6-bank | **21/21** (Try it now also checks 820 × 1180) |
| chart | **41/41** |
| settings (app, fixture, mac, bridge, v6) | **111/111** |
| ui-core | **78/78** |
| shell unit (`test/phase1/shell/run.mjs --only unit`) | **384/384** |
| each new check on the pre-fix code | F1, F2 and F3 (both suites) fail without their fixes |
| console.error / HTTP ≥ 400 | 0 |
| edit-v2, migration-1x, Electron / Mac suites | not run |

The builder's counts for ui-v6-edit (32) and ui-v6-bank (17) predate the rebase onto dcb2f06, which added polish 1's
checks.

## Fixes (commits on lane-u8)

- b9175e5 F1 (`styles-v6-ipad.css`, ui-v6-ipad "skeptic F1").
- 39e2414 F3 (`styles-v6-ipad.css`, ui-v6-ipad first run, ui-v6-bank Try it).
- 3af5e53 F2 (`views/v6/start.js`, ui-v6-ipad empty library).
- This review, plus a skeptic note in CONTRACT_CHANGES "## UI v6 U8a" and in the build plan's U8a status.

## Open items

- **O1 Back from a trial that began in an empty library does nothing (low, U7a; easier to reach now).**
  - Empty library, then Song bank…, then Try it, then Back. `controller.backFromTrial` finds no song to go back to and
    returns "There is no song to go back to." The banner toasts it, and the trial stays.
  - Keep it works. U8a's card makes this path the obvious one.
  - Options: Back ends the trial into the empty library (a controller change), or the banner hides Back when there
    is nothing to go back to (view only).
- **O2 The strips' name pills cut the last pill with 16 instruments (low, U1, pre-existing).**
  - `.v6-pills` is `overflow: hidden`, no wrap, 908 px wide with 16.
  - At 820 the 16th pill is past the edge. At 1180 and at the Mac's 1024 × 700 the hint is cut. The same happens on
    dcb2f06.
  - The strips still scroll to it. Either let the pills scroll, or shrink them further, from about 12 instruments.
- **O3 A viewport shortened below its width flips the orientation queries (for Ryan, emulation only).**
  - PORTRAIT_MQ and Edit's portrait rules use `orientation: portrait`.
  - A height-shrinking soft keyboard at 820 × 760 (Android Chrome's behaviour) turns them off. Perform swaps to the
    landscape layout while typing, and with the v6 Edit / chooser open the page snaps to today's 1024 px body
    minimum and zooms out.
  - The iPad app is a WKWebView, whose keyboard doesn't resize the layout viewport, so it shouldn't happen there.
    iPad Split View / Stage Manager windows narrower than tall are another matter. Neither was verified.
- **O4 iPad wording from today's chrome (for Ryan / U9).** These are today's strings on every platform; a touch-only
  iPad would want its own:
  - the Start here card's "No keyboard yet? Play A S D F G H J K on your computer (Space = sustain)";
  - the stalled banner's "click "Restart sound"".
- **O5 The builder's claims to confirm with Ryan:**
  - Quick is an icon only at ≤ 900 px;
  - the meter is hidden in portrait;
  - New song from the empty card plays it;
  - Arrange at ≤ 790 px tall hides the 2 × 2 grid;
  - the Edit sentence's words are exempt from 44 px.

  Mine: with a MIDI problem at ≤ 900 px the ready words go (F1).
- **O6 Not verified:**
  - a real iPad / WebKit (touch cancel on rotation, the soft keyboard, `:has()` support is there from iPadOS 15.4);
  - the Mac app's Restore a backup… (code read);
  - real MIDI hardware with a long device name on the iPad;
  - screen readers;
  - themes other than Sanctuary (U8b);
  - the Electron suites, edit-v2 and migration-1x (not run).
