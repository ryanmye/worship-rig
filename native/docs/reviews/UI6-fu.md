# U-SNAP follow-up (UI6-snap O1/O2/O5) + empty-library silence (UI6-er O1): skeptic review (2026-11-27)

Verdict: **VERIFIED after F1.** One defect in the empty-library step, fixed on lane-fu with a test that fails before
the fix (F1, 5ef3853): a library restored over the empty one with the same song ids played no drone under a song
whose drone said ON. Everything else does what CONTRACT_CHANGES says. PANIC is byte-identical to the base in every
state except a drone left on with no song behind it. The builder's correction holds: PANIC has never stopped a drone
the song has on. Two open items are for the orchestrator / Ryan, both with numbers: the master stays faded after the
empty spell until a note (O1), and the snapshot line pushes Edit's rig down by 37–50 px on a touch screen (O2).

Under review: 42c445a and 0fcc0f4 on lane-fu, rebased onto origin/v2-native 36ef998. The only conflict was
`native/docs/lanes/UI6-build-plan.md` (C-SHIP queued on one side, "Built" on the other); I kept both entries.
`app/js/engine/`, `app/js/engine-bridge/`, `store.js` and `main.js` are untouched (`git diff 36ef998 --` on them is
empty). My probe scripts ran against the lane and a temporary worktree at 36ef998. They are not committed, and the
worktree was removed afterwards.

## B. Empty-library silence; PANIC and an orphaned drone

- **The claim about PANIC holds.** SPEC.md:139 says `allNotesOff` leaves the drone untouched. ENGINE_CONTRACT.md:121
  says the same ("**Drone untouched.**"). REVIEW.md:152 says "Leave the drone alone". README.md:297 says "(the drone
  keeps going)", and docs/release-notes-1.1.0.md:103 says "The drone keeps going, as before."
- **PANIC is byte-identical to the base.** One probe ran the same steps against both trees and recorded every engine
  call, every controller event (action, status, scene, song, warn, click, cue, trial…), the timeouts and intervals
  before and after, `status.pedal` / `status.click` and `menuBarState()`. The seven states were: a song whose drone
  is on with a held note, the pedal, the swell and the click running; a song whose drone is off; a snapshot holding
  the drone ON over a song whose drone is off; a snapshot holding it OFF; Lock; MIDI Learn armed; a song switch in
  flight. Base and lane gave identical JSON in all seven, `[["allNotesOff"]]` in each. `droneOffIfOrphaned` sends
  nothing unless `droneSent` is on and no selected song (with its snapshot) wants the drone.
- **When an orphan can still occur.** With the empty step in place, an orphan needs the step's own
  `drone.configure {mode:'off'}` to fail (the builder's test fakes that). No other route leaves `droneSent` on with
  no song. A trial is a selected song. Learn, Lock and a snapshot all need a song, so in those states PANIC is the
  base PANIC (above).
- **Every path to an empty library is covered by one hook.** The step runs in `onStore`, so every store-level route
  reaches it:
  - `deleteSong`, called from today's Edit ⋯ Song, the Edit setlist panel and the v6 song menu;
  - Back from a trial (`backToEmpty`);
  - a replacing `importJSON`: Settings import, `importBackup`, and `restoreKept` / Restore previous library.
  A merge import of an empty file is refused ("No songs found"). Removing a song from a setlist or the bank never
  deletes it (only `deleteSong` and `endTrial` remove songs). The step runs once per empty spell, and not at all on a
  fresh start (`appliedId === null`), on a second window, or before `start`.
- **A footswitch in the empty library.** `nextScene` / `prevScene` count the scenes of `store.getSong(appliedId)`.
  That song is gone, so the count is 0 and nothing moves. The bus' `droneToggle` / `droneKey` and a learned `drone.gain`
  do nothing with no song. The bus' `panic` is `panic()`.
- **Audio restart.** `afterRestart` / `restorePads` keep the drone off with no song (0fcc0f4). `engine.restart`
  re-applies the engine's own state, so the drone stays off and the fade stays on. `droneSent` follows the engine:
  `restart` keeps the engine and its state, and the only "new engine" is a second window taking over, which resets
  `droneSent` with `appliedId`.
- **Native bridge.** `DroneCore::configure` (native/core/src/drone/drone_core.cpp:329–371) sets only the fields that
  are present, then `setMode`. A partial `{mode:'off'}` is therefore the drone's own fade, as on the web
  (drone.js:365). The builder's MockNative test (drone:off, play:fade, play:panic, no findings) passes.
- **A song added afterwards is selected and its drone configured. The master stays faded until a note.** That is O1
  below, measured in the web engine. A drag or a tap is not affected.

## A. U-SNAP follow-up (O1 line, O2 summaries, O5 copy)

- **Text and buttons.** "Changing snapshot “Hall” for now: Update keeps it, Own levels edits the song" in the v6
  Edit, and "Changing scene “Scene 1” …" in today's Edit. Update saves over the snapshot, keeps its name and shows
  "“Hall” updated." Own levels goes back to the song's own levels, and the line goes away. Both work from the
  keyboard: Tab focuses each button, Enter runs Update and Space runs Own levels. Under Lock the line and both buttons
  stay live (D24.1).
- **Sizes**, all with a 19 px line on one line, nothing clipped, no overflow inside the header (probe, 1280 / 1180 /
  1024 / 820 wide):

  | view, pointer | 1280×800 | 1180×820 | 1024×700 | 820×1180 |
  |---|---|---|---|---|
  | v6 Edit, mouse: header px | 58 → 64 | 58 → 64 | 58 → 64 | 98 → 120 |
  | today's Edit, mouse | 52 → 74 | 48 → 70 | 48 → 70 | 48 → 70 |
  | v6 Edit, touch (buttons 59×44, 80×44) | 58 → 95 | 58 → 95 | 58 → 95 | 112 → 161 |
  | today's Edit, touch | 52 → 102 | 48 → 98 | 48 → 98 | 48 → 98 |

  Pre-existing, and the same at rest without the line: the v6 Edit's ⋯ Song button sticks out of the header at
  1024×700 on a coarse pointer, and today's Edit is 1004 px wide in an 820 px window.
- **A drag while a footswitch changes the snapshot** (`controller.scenes.go(0)` mid-drag, the layout moving 6 px with
  a mouse and 37 px on touch in the v6 Edit, 22 / 50 px in today's Edit). The same gesture ended on the same value
  as without the change:
  - the v6 Edit's vertical level fader: 630 → 473 → 316 both ways. Edit's faders are relative (`fader({relative})`),
    so they move by the pointer's delta, not its position.
  - the horizontal word sliders (Brightness, Warmth, Ring-out, and Pan / Width in today's Edit): the same values
    both ways. The page moves vertically, and a horizontal range follows x.

  So a drag in progress is safe. A tap that lands during the shift is O2.
- **Purity.** The line is made the first time a snapshot plays. The flag-off purity checks (ui-v6, ui-v6-edit:
  requests, listeners, intervals, store listeners, DOM, CSS) against 36ef998 pass.
- **`:has()`.** Chromium (Electron 44, WebView2) supports it, and so does WebKit since Safari 15.4, below the
  deployment floor of macOS 14.5 / iPadOS 17.5 (WEBKIT_AUDIT §1). The app already has 35 other `:has()` rules.
- **Voices.** No voice other than Classic overrides any scene word (`shared/voice.js`: Sanctuary, Ember, Studio and
  Daylight have no `scene*` key). The line in Classic words therefore matches every other snapshot / scene text those
  voices show. Acceptable, and no copy needed.
- **O2 (summaries) are live.** With Effects shown, a snapshot change moves "2 of 2 in the Space" to "1 of 2". The
  instrument's row reads 90 % under the snapshot, 25 % after Own levels, and 55 % after a live move on the snapshot.
  This works through the shell's `'scene'` → synthetic sends refresh.
- **O5.** The row reads "The drone: ON / OFF, sound and level", and the choice is labelled "Its key" (ui-v6
  dialogs test).

## Findings

- **F1 (fixed, 5ef3853): the same library brought back after the empty spell played no drone.**
  - The empty step turned the drone off but left the deleted song as `targetId`. A library restored over the empty
    one keeps its song ids, as Settings › Restore previous library (the undo a player reaches for after deleting
    every song), a replacing Import… or a backup do. So `onStore` took the restored song for the one already playing.
    `applyDiff` against the deleted song found the same drone mode and sent nothing.
  - Measured in the web engine (Chromium, real app): `engine.drone.cfg.mode` 'off', `sounding` false,
    `menuBarState().droneOn` true. A note brought the master back but not the drone.
  - Before this lane it couldn't happen: the deleted song's drone just kept going.
  - Fix: `silenceEmptyLibrary` clears `targetId`, as `backToEmpty` already did, so that song is selected like any
    other (prepare, commit, drone configured). After the fix: 'synth', sounding.
  - In the empty library, `goScene` / `adjustScene` now also refuse (`targetId !== appliedId`), the same state as
    after Back.
  - Test: shell `empty-silence.test.mjs` "UI6-fu F1", with a replace import and `restorePreviousLibrary`. It fails
    before the fix (0 `drone.configure` calls, 1 expected). CONTRACT_CHANGES has a line in the lane's section.

## Gates (lane-fu at 5ef3853, one at a time, PLAYWRIGHT_BROWSERS_PATH=/root/.cache/rig-pw, UI6_PURITY_BASE=36ef998)

| suite | result |
|---|---|
| shell unit (`test/phase1/shell/run.mjs --only unit`) | **413/414**: the one failure is O3 (`bank-trial` "skeptic F1–F3"), which fails the same way on 36ef998; `empty-silence` 7/7 |
| unit (`test/unit/**`) | **685 pass, 0 fail** (697 tests, 12 skipped) |
| ui-v6 (incl. flag-off purity vs 36ef998) | **84/84**, purity identical |
| ui-v6-edit (incl. purity, snapline) | **43/43**, purity identical |
| ui-v6-bank | **23/23** |
| ui-v6-ipad | **29/29** |
| ui-core | **95/95** (7 + 10 + 78), incl. "UI6-snap O1" and "UI6-er O1" |
| edit-v2 | **14/14 files** |
| settings (app, fixture, mac, bridge, v6) | **111/111** |
| ui-v6-themes | not run: nothing visible changed after the builder's commits |

0 console.error and 0 HTTP ≥ 400 in every browser suite above (each suite's own check) and in my probes.

## Open items

- **O1 (orchestrator / Ryan): after the empty spell the master stays faded until a note, so a song added or
  restored afterwards comes up with its drone silent.**
  - Measured in the web engine: after the empty step, `fadeGain` is 0 (`getRuntimeState().faded` true). A song added
    then is selected with its drone configured and sounding, but `fadeGain` is still 0. The same holds after a
    restore and after a footswitch Next.
  - Perform's Fade button reads "Faded out" (Sanctuary; Classic: "Faded — play to resume") the whole time. One note
    brings `fadeGain` back to 1, and the drone is heard.
  - That is Fade out's own rule, so it is consistent, but here the player never pressed Fade out.
  - "Un-fade on song select" needs an engine call. Neither engine has one: `noteOn` is the only thing that clears
    `_fade`, and `applyRuntimeState` only sets a fade. So it is outside this lane's "engine untouched".
  - The options:
    - (a) accept it;
    - (b) controller only: fade only when something is held at that moment (a key in `heldBySrc`, or
      `engine.pedal`). With nothing held, the deleted song's voices are release tails that end by themselves, and the
      drone-off is what matters. Deleting a song in Edit or pressing Back with your hands off the keys would then
      leave no faded master;
    - (c) an engine `unfade` / `play {e:'unfade'}` (ENGINE_CONTRACT row, both engines), called on the first song
      selected after the empty spell.

    I'd take (b).
  - Stage risk is low. An empty library is a setup state, the chip says "play to resume", and the first chord
    restores everything. But the faded master can outlast setup by hours if the app stays open.
- **O2 (Ryan / design): on a touch screen the snapshot line moves Edit's rig down 37–50 px when a footswitch changes
  the snapshot.**
  - The v6 Edit moves 37 px (49 px at 820×1180) and today's Edit 50 px. With a mouse it is 6 / 22 px.
  - The 44 px targets make the touch line 46 px tall.
  - Drags in progress are unaffected (measured above). A tap that lands during the shift hits whatever is up to
    50 px lower.
  - Options: accept it (Edit during a footswitch-driven set is unusual), keep the line's height reserved while the
    song has snapshots (this changes the header at rest and the purity baseline), or overlay the line without
    moving the rig.
- **O3 (test infra, pre-existing): shell unit `bank-trial.test.mjs` "skeptic F1–F3" fails in a full-file run, on
  the base 36ef998 too.**
  - `addFromBank(LANTERN)` answers "That song is no longer in the Song bank": `packsInfo.entries` is empty at that
    test's boot.
  - It passes alone and in any pair I tried. It fails with "Keep = Add…" + "random sequences" (~9 s) before it.
  - UI6-er's gate had it passing (386/386), so it looks load- or timing-dependent, maybe the pack scan behind
    `packsReady`. Not the lane's: it fails identically at 36ef998.

## Not verified

- A real iPad / Mac (WKWebView): touch was Playwright `hasTouch` (pointer: coarse) with mouse-driven drags. No real
  fingers, and no WebKit layout.
- A real MIDI footswitch. Snapshot changes were `controller.scenes.go(n)` and `nextScene` through the controller.
- The native core. `DroneCore::configure` was read, not run. The bridge ran against MockNative only.
- How it sounds: no listening. The fade and drone were read from the web engine's state (`fadeGain`, `drone.cfg`,
  `sounding`).
- The Electron / Mac suites, chart, migration-1x, and ui-v6-themes. I changed nothing visible (F1 is controller
  only), so I didn't run themes.
- Screen-reader announcement of the line (`role="status"`).
