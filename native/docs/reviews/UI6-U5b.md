# UI v6 U5b (v6 Edit: Drone / Effects / Master, dots, bottom row, chooser): skeptic review (2026-11-26)

Verdict: **VERIFIED, after fixes.** As delivered it was PARTIAL. One medium defect: the chooser's backdrop covered
PANIC / Lock / the keys. There were three low defects: an unguarded range drag in the bottom row, dots that stayed
after a reset, and focus lost in the chooser. There were also one low staleness and one test-id nit. None of them
touches the store, controller, engine or `shared/`. Seven items stay open for Ryan or polish.

Under review: lane-u5b at c0b2dd6 (5b565a4 … c0b2dd6), rebased onto v2-native 025d90e (U6, the v6 Settings). It adds
`views/v6/edit/catpanel.js`, `drone.js`, `effects.js`, `master.js`, `chooser.js` and `bottom.js`. It changes
`edit.js`, `instrument.js`, `views/v6/bottom.js` (`{prefix}`, `toggleLock`) and `styles-v6-edit.css`, and adds
`test/phase2/ui-v6-edit/u5b.tests.mjs`. I didn't build it. lane-u7a was running its suites on the same 2-CPU box
(load average 2–6), so I ran mine one at a time.

These claims held:

- **Module boundaries.** `git diff 025d90e` touches nothing in `engine/`, `store.js`, `controller.js`, `shared/`,
  `main.js`, `server.js`, today's `views/edit/*`, the v6 sidebar, `v6/perform.js`, `keyboard.js` or `strip.js`.
  `views/v6/bottom.js` changes test ids, the `toggleLock` hook and (F4) one option.
- **Bound addresses.** I read the three panels against today's `edit/panels/drone.js`, `effects.js` and `master.js`,
  not only through the suite's data-bind check (which compares both ways: nothing missing, nothing extra).
  - Effects: the same SPACE / ECHO / VIBE presets through `applyPreset`, and "Song's own" as today's whole-object
    `patch.fx.<unit>` write. The slider rows and ranges come from PARAMS. Pre-delay is shown in ms from seconds.
    Timing is `fx.delay.sync`, with the same BPM / ms note and the same disabled Time. Sends cells are
    `slots.<i>.sends.reverb|delay|chorus` (0..1), read as 0 for an empty place, like today's chips. The only
    difference is that today's panel always shows at least 4 places, while v6 shows the song's own places.
  - Master: volume 0..2 linear gain with a dB word and double-click to −6 dB, `fx.lofi.*`, `fx.eq.*` (bipolar dB)
    and `fx.comp.amount`. Wheels & pedal use the same three target selects, From / To, the pedal curve, bend mode,
    bend range 0–24 and swell 1–60 s (log). "Sustain pedal also swells the drone" is written as a boolean. Wheel
    target labels name the instrument (D15). The written value is the same.
  - Drone: today's Width / Key fade / three toggles / Synth ↔ My Pads. The sidebar module writes `drone.gain`,
    `brightness`, `movement`, `mode`, `hearIn` / `playIn` (the transpose amount kept) and `minor` (real writes in the
    suite).
- **Drone module mounted twice** (Perform's sidebar module stays mounted while Edit › Drone › Key & sound shows):
  - One key tap is two writes, `hearIn` + `playIn`. ON off / on is one `drone.mode` write each. Nothing is written
    twice, because neither module writes from a render.
  - Perform's hidden module follows the change.
  - Over 8 rounds of switching Edit tabs, Drone categories and Perform ↔ Edit, store listeners stayed 17 → 17 and
    the element count 2178 → 2175.
- **Dots** (apart from F3) compare every listed path against `ctx.getBaseline()`:
  - Live moves never dot: instrument level and ON, drone Level and ON (song-diff's `drone.mode` rule), master
    volume.
  - Revert clears them. The rig tab follows its categories.
  - Cost: all rig-tab dots for 16 instruments plus Drone / Effects / Master take ~1.0 ms per store write on this box
    (microbenchmark, 200 runs). They are memoised on the song / baseline objects, which change on every write.
  - A range write in Edit with 16 instruments: median 11.4 / 19.1 ms against 13.6 / 11.1 ms on 025d90e, two runs
    each under load 2–6. That is noise.
- **Esc (D24.7).** With "Esc always panics" on, Esc in the chooser's search box closes the chooser, and a second Esc
  does nothing. Neither panics (controller `action` events counted), at 1024 × 700 and 820 × 1180. `escPanicKey`
  only acts on Perform, and the Edit core's capture listener closes the chooser first.
- **Chooser.**
  - The kinds are `groupOrder` / `groupOf`, with "Guitar" and "Guitar & Plucks" merged, and their counts are right.
  - "playing now", search across kinds, Cancel / Esc / backdrop write nothing, and Use writes only
    `slots.<i>.instrument`, then Undo. An empty place gets `defaultSlot`. Remove has today's confirm. Perform's
    Change switches to Edit. Under Lock, main.js refuses `setView('edit')` before `select`, so no chooser opens in
    the hidden Edit.
  - Tab wraps inside the dialog, and arrows move through the tiles.
- **Bottom row Lock** from Edit: it goes to Perform and then locks. The row unmounts in the store's microtask, after
  `onActivate` returns. PANIC and Fade out call the controller.
- **U5a O3–O6** hold as described: tablist semantics, Feel as a word, ‹ / › read in rAF only while Edit shows, and
  Song bank… only with bank songs.
- **Fit.** The chooser, after F1, fits at 1024 × 700 (dialog 82–580 px, Use at 521–565) and at 820 × 1180, with no
  sideways scroll (the builder's fit check also passes).
- **Flag-off purity** against 025d90e is identical in both suites: 105 requests, 15 store listeners, 4 intervals,
  2529 elements (1047 in Edit).
- **Zero console.error and no HTTP ≥ 400** in every suite and probe.

## Findings

- **F1 (medium, stage safety; mockup) The chooser's backdrop covered the bottom row.**
  - It was appended to the Edit root with `inset: 0`, so PANIC, Fade out, Lock, Revert and the keys sat under the
    dim backdrop. A tap on PANIC closed the chooser and didn't panic (`elementFromPoint` on PANIC was the backdrop).
  - The mockup dims only the body (`.frame.dimmed .ebody`), and D17 keeps the keyboard row and PANIC live over the
    Song bank in the same way.
  - Fix (aa29fd1): the chooser opens in `.v6e-body`. The body is `position: relative` only while the chooser is in
    it (`:has`), so the iPad drawer keeps its containing block.
  - Test: "skeptic U5b F1/F2/F6" checks that PANIC / Lock / Revert / Fade / keys are on top, and a PANIC click with
    the chooser open panics. It fails on c0b2dd6. The builder's backdrop tap at (4, 400) now taps the backdrop's own
    edge (f983e8b).
- **F2 (low, keyboard) A kind picked with Enter / Space dropped the focus to `<body>`.**
  - The render replaced the button. A following → / ← was then Next / Prev song under the open dialog, and ↑ / ↓
    moved the mod wheel.
  - Fix (aa29fd1): a keyboard activation (`detail === 0`) focuses the new kind button. A pointer click still leaves
    nothing focused, as every Edit button does (shell blur).
  - Test: the same check, which fails on c0b2dd6 at the focus assertion.
- **F3 (low, dots) An optional object set back to its defaults kept its dot.**
  - This affected `fx.eq`, `fx.comp` and a slot's `touch`. `relsDiffer` / `instCatChanges` compared the whole object
    with the baseline's `undefined` (only leaves fell back to PARAMS defaults). So Master EQ low +3 → 0 (or a
    double-click reset) left Master EQ, the Master tab and the Touch row dotted, though the sound was the same. This
    contradicted the builder's own note.
  - Fix (f20f340): `catpanel.js` `sameWithDefaults` compares key by key, with each absent leaf at its PARAMS
    default. `instCatChanges` uses it too. As a side effect, an absent `sends.chorus` and 0 are now the same.
  - Test: "skeptic U5b F3" fails on c0b2dd6.
- **F4 (low, data) The bottom row's range bars were not display only.**
  - `keyboard.js` picks a bar on a tap by itself (`onRangePick` only reports it). The ends then dragged with live
    writes through Edit's `setRange`, which lacks the v6 Perform's guards: song switch, slot count and `onSlotMap`.
  - Probe: pick bar 0 and drag the low end, switch song mid-drag, then release. The first song kept the partial value
    (51, no restore), and the next song's place 1 got 54.
  - Fix (dba14e2): `bottomRow(v, {barsReadOnly})` renders the bars with the keyboard's locked look. That means no
    pick and no handles (tabIndex −1, hit layer off). The keys still play. Edit passes it.
  - Test: "skeptic U5b F4/F5" (a tap shows no pick hint, handles −1, a drag writes no range). It fails on c0b2dd6.
- **F5 (nit, tests) Two elements had the test id `v6e-drone`.** With Drone › Key & sound open, the renamed module root
  and the panel both had it.
  - Fix (dba14e2): the module root is `v6e-dmod-root`.
  - Test: the same check, with no duplicate id in `#view-edit` outside the stage strip. It fails on the old rename.
- **F6 (low, staleness) The chooser outlived a change of its place's instrument.**
  - F1 makes Revert reachable with it open. It then still showed the old "playing now", title and note.
  - Fix (aa29fd1): `instrument.js` closes it when the place's instrument differs from the one it opened for.
  - Test: "skeptic U5b F1/F2/F6" (instrument changed, chooser open, hold Revert: the chooser closes and the
    instrument is back). It fails on c0b2dd6 with F1 applied.

## Open (for Ryan / polish; not defects of the brief)

- **O1 Bottom-row range bars in Edit.** D18 says the draggable bars are "the same for every screen with the bottom
  keyboard". The builder chose display only (Range has its own editor), and F4 makes the code match that choice. If
  Ryan wants them draggable in Edit, port the v6 Perform's guards (song-switch / count / `onSlotMap` drops and a
  per-drag song id) before turning them back on. Also show Edit's strip outline (`onRangePick`).
- **O2 A pointer click on a kind leaves nothing focused** (app-wide convention). ← / → then change the song under the
  open chooser, and the song switch closes it. That is harmless but surprising. A modal could swallow arrows at the
  document while open.
- **O3 Missing instrument.** A place whose instrument is not in the engine's list (manifest gone) opens the chooser on
  the first kind, with no "playing now" tile and no "not available" line (U5a's menu had one). Use still works.
- **O4 The drone ON tile's remembered source is per view.** Edit's module ctx and Perform's sidebar each keep their
  own. Off in Perform then on in Edit falls back to the snapshot's source. Today's Edit and Perform behave the same.
- **O5 The chooser's kinds list scrolls at 1024 × 700** (9 kinds in ~360 px), now that it sits above the bottom row.
  Bass is below the fold there.
- **O6 Sentence nit.** Drone's level word reads `drone.gain`, not the scene's live level (the module's fader does).
- **O7** Five lines over 120 columns predate this review: `instrument.js` ×3, `run.mjs`, `ui-v6/move.tests.mjs` ×2.

## Gate

The box had 2 CPUs, shared with lane-u7a. I ran each suite one at a time at f983e8b.

| suite | result |
|---|---|
| ui-v6-edit (`UI6_PURITY_BASE=025d90e`) | **32/32** (29 + 3 skeptic checks). First full run 30/32: the builder's chooser check tapped the old full-view backdrop (fixed in the test, f983e8b), and the small-items check cascaded from it |
| ui-v6 | **68/68** |
| edit-v2 | **14/14** files, 117/117 tests |
| settings (now with U6) | **111/111** (app, fixture, mac, bridge, v6) |
| shell unit (`test/phase1/shell/run.mjs --only unit`) | **364/364** (357 before the rebase onto U6) |
| flag-off purity vs 025d90e (ui-v6, ui-v6-edit) | identical (105 requests, 15 store listeners, 4 intervals, 2529 elements, 1047 in Edit) |

Not verified:
- The Mac app / WKWebView (Chromium only).
- A real MIDI keyboard.
- Touch input on the chooser and the bars.
- The Daylight theme.
- Screen-reader output (ARIA attributes only).
- My Samples kinds with real user packs (none on this box).
- The Song bank button with real bank songs (the builder stubs it).
- iPad portrait drawer + chooser together.
