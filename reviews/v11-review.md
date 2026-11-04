<!-- v1.1 bug + security review of 0187e88..ef3d58a (cloud, 2026-11-04). R-3/R-4 fixed in v11-decisions; R-1/R-2/R-5..R-8 in v11-review-fixes. -->
# v1.1 review: `git diff 0187e88..ef3d58a` (read-only)

Scope: the seams between the six v1.1 workers (scenes, metronome, touch, electron, importer, polish) plus the
Electron security surface. Every finding below was traced through the code. R-1 to R-3 were also reproduced in a
scratch worktree at ef3d58a (now removed). Nothing in `/home/user/worship-rig` was edited.

Counts: **High 1 · Medium 2 · Low 5** (8 in total).

Collision tags: **(a)** = the worker changing memory/buffer handling in `app/js/engine/**`. **(b)** = the worker
doing hotkeys→songs, Panic stops the click, and keyboard curves device-local (touches controller.js, store.js,
global-hotkeys.js, shared/hotkeys.js).

---

## R-1 · High · confirmed (engine repro): the pedal swell's gain factor is never recomputed when the drone level changes

- **Where:** `app/js/engine/drone.js:941` `_pedalFactor()`, which is only read in `pedalSwell()` (`:930`) and
  `bendSwell()` (`:909`). `Drone.setParam('gain', …)` (`:273`) does not re-evaluate it. In `app/js/engine/audio.js:1620`,
  `_syncPedalSwell()` returns early whenever the wanted state is unchanged (commit, routing change).
- **What's wrong:** v11-touch "hold pedal = sustain + drone swell" sets `bendGain` to `1 / drone.gain` (capped at ×4)
  at the moment the pedal goes down, so the drone rises "toward drone.gain 1". If the drone level moves while the pedal
  is held, `level.gain` changes but `bendGain` keeps the old factor. Any of these moves it:
  - a scene step (v11-scenes glides `drone.gain`);
  - the Perform drone fader;
  - a MIDI-learned drone fader;
  - a song switch where both songs have the combo.

  The sustain pedal is down most of the time when playing pads, so this is the normal case, not an edge case.
- **Failure scenario:** a song has `swell.pedal: true` and `drone.gain` 0.25. The player holds the sustain pedal, and
  the drone swells to an effective 1.0 as designed. A footswitch scene, or the drone fader, then sets `drone.gain` to
  1.0. The drone plays at 1.0 × 4 = **4.0** (+12 dB above "full"), and up to ×8 at fader max. In the other direction,
  pulling the fader down under the pedal makes the drone quieter than the swell target.

  Measured with a scratch engine suite (offline, real Drone): `swelled 3.99 → bendAfter 4, levelAfter 1, effective 4`.
- **Suggested fix:** when the drone level changes, recompute the target in the drone. Keep `this._bendTarget` and call
  `rampTo(this.bendGain.gain, min(4, bendTarget × _pedalFactor()), t, τ)` from `setParam('gain')` while
  `_pedalOn`. Alternatively, define the swell as a separate gain stage that targets an absolute level instead of a
  multiplier of the current level. Add a test: raise `drone.gain` while the pedal is held, and assert that the
  effective level stays ≤ 1.
- **Collides with:** (a) (`app/js/engine/**`).

## R-2 · Medium · confirmed (controller repro): a scene change or live scene move during a re-prepare is undone when the new instrument commits

- **Where:**
  - `app/js/controller.js:423–457` `reprepare()`: it prepares `live(song)` at `:432`, synchronously, with the scene
    playing at that moment. After the commit it only calls `applySongLevel(…)` (`:453`, which sends transpose, routing,
    drone and tempo, never slot gains) and `catchUp(song)`, which diffs store snapshots only.
  - `goScene()` (`:592`) and `adjustScene()` (`:650`) are allowed during the re-prepare, because `targetId === appliedId`.
  - Engine `commit()` (`app/js/engine/audio.js:743–759`) drops pending coalesced slot writes (`cancelAll(isSongKey)`)
    and re-applies the prepared `ps.cfg` gains.
- **What's wrong:** the playing scene is controller state, not store state, so `catchUp` can't see that it changed.
  Glides sent to the old channels are overwritten by the commit with the levels the prepare captured.
- **Failure scenario:**
  1. Scene 2 plays, with Keys at 0.2.
  2. In Edit, change the Keys instrument. This is a structural change, so a re-prepare starts. A piano decode takes
     1–5 s.
  3. Press the footswitch, or step to scene 1, while it loads.
  4. After the commit, the engine is back at Keys 0.2 while Perform's faders and `scenes.state()` say scene 1 (0.8).
     The repro printed `view [0.8, 0.55] engine [0.2, 0.55]`.

  The same happens to a Perform fader move (`adjustScene`) made during the load. The rescan → re-prepare path is
  affected too.
- **Suggested fix:** in `reprepare`, keep `const sent = live(song)` from before the await. After the commit, send
  `levelDiff(levelsOf(sent), levelsOf(live(store.getSong(id))))`, or run `applyParamDiff(sent, live(cur))`, before
  `catchUp`. Alternatively, have `goScene` / `adjustScene` refuse, or queue, while `repreparing === appliedId`. Add a
  shell test that uses `fakeEngine({manual: true})` to step a scene between prepare and commit.
- **Collides with:** (b) (controller.js).

## R-3 · Medium · confirmed (store repro): `settings.keyboards` leaks into exports and is overwritten by a replace-import (security S3)

- **Where:**
  - `app/js/store.js:61–66` `DEVICE_LOCAL_SETTINGS` does not include `keyboards`.
  - `exportJSON` (`:1659`) filters by that list. Its own comment, security S3, says that MIDI device names identify
    the hardware and stay on the machine.
  - The replace-import keep list (`:1711`) has the same gap.
- **What's wrong:**
  - `settings.keyboards` is keyed by MIDI device name, and it carries each board's calibrated touch curve and its
    `remember` flag. All of it goes into a shared library file.
  - Importing someone else's library (replace) wipes this rig's calibration and remembered boards, and installs theirs.
  - The `remember` names from the other library then steer this rig's 'first' input choice, through
    `midi.setRemembered`.
- **Failure scenario:** the repro set `setKeyboard('Keystation 49 MK3', {remember: true, touch: {shape: 0.8}})`.
  `exportJSON()` then contained `{"Keystation 49 MK3":{"remember":true,"touch":{…}}}`. A replace-import of another
  rig's library left `{"Other Rig Keys":{"remember":true}}`, and the local entry was gone.
- **Suggested fix:**
  - Add `'keyboards'` to `DEVICE_LOCAL_SETTINGS`. That covers export, keep-on-replace and `isEditPath`.
  - Make the shell test assert that the export has no `keyboards` and that a replace-import keeps the local map.
  - Note in CONTRACT_CHANGES that `normalizeSettings` then drops an imported value (the `keep` spread writes
    `undefined`).
- **Collides with:** (b). This is the "keyboard curves device-local" item; make sure `remember` moves with it, not only
  the curves.

## R-4 · Low · confirmed: Electron main accepts single, unmodified keys as global shortcuts

- **Where:**
  - `global-hotkeys.js:19` `ACC_RE` and `:45` `sanitizeHotkeyConfig`.
  - The store's `normalizeHotkeys` (`app/js/shared/hotkeys.js`) only parses. It doesn't apply `acceleratorError`
    (the rule of two of ⌃⌥⌘ or a function key). Only the Settings recorder enforces that rule.
- **What's wrong:** main is supposed to "never trust the page's types". Today
  `rig.setHotkeys({on: true, keys: {nextMode: 'A', prevMode: 'Space', panic: 'Return', …}})` passes the sanitiser
  unchanged (checked in node).
- **Failure scenario:** a compromised renderer, or a buggy future writer of `settings.hotkeys`, can take up to 7
  plain keys system-wide. Every other app on the Mac stops receiving them, and each press reaches the page as a bus
  command, which leaks the timing of those keystrokes. A replace-import can't trigger this: `hotkeys` is device-local
  and an imported value is dropped. That is why this is Low.
- **Suggested fix:**
  - In `sanitizeHotkeyConfig`, require at least two of Control / Alt / Command / CommandOrControl, or an F-key. That
    is the same rule as `acceleratorError`, and a small CJS copy of it is enough.
  - Have `normalizeHotkeys` blank any accelerator that fails `acceleratorError`, so the store can't hold one.
- **Collides with:** (b) (global-hotkeys.js / shared/hotkeys.js).

## R-5 · Low · confirmed: the update URL allowlist is a string prefix, so `..` / `%2e%2e` leave the repo's releases path

- **Where:** `update-check.js:69` `openable()`, used by `parseRelease`, `status()` and `urlFor()`.
  `rig:openUpdate` → `shell.openExternal` (main.js).
- **What's wrong:** `u.startsWith('https://github.com/ryanmye/worship-rig/releases/')` is checked on the raw string.
  `…/releases/../../../evil/x` and `…/releases/%2e%2e/%2e%2e/%2e%2e/evil/download` both pass, and both normalise to
  `https://github.com/evil/…` (checked with `new URL`). The host stays `github.com`, and the URLs come only from GitHub's
  API, the `RIG_UPDATE_FEED` test feed or the local `rig-shell.json` cache. So this is defence in depth, not an
  exploit.
- **Suggested fix:**
  1. Parse with `new URL(u)`.
  2. Require `origin === 'https://github.com'`.
  3. Require that the normalised `pathname` is `/ryanmye/worship-rig/releases` or starts with
     `/ryanmye/worship-rig/releases/`, with no `..` in the decoded segments.
  4. Open `url.href`, not the raw string.

## R-6 · Low · confirmed (code): Perform's drone "audible" lamp and the on-screen keys' part colour ignore the playing scene

- **Where:**
  - `app/js/views/perform.js:1538–1546` `renderAudible()` reads `store.currentSong().drone.gain`.
  - `:1572` `partOf()` reads the base song's mute state.
  - Both should read `controller.scenes.view(song)`, as the faders already do.
- **Failure scenario:** a scene sets the drone level to −∞, or mutes Keys. Sanctuary and Nave keep the lancet lit, and
  Ember colours held keys with the muted slot's colour. The reverse happens for a scene that un-mutes a slot. The
  problem is cosmetic, and only in the warm themes.
- **Suggested fix:** use `liveOf(store.currentSong())` in both, and call `renderAudible()` from the `'scene'` listener.
  It is already reached through `renderSong`, but only `partOf` needs the extra call.

## R-7 · Low · confirmed (code): Edit's "Normal follows X's own touch" line can't match when several MIDI inputs are selected

- **Where:**
  - `app/js/views/edit/panels/slot.js:967` `activeCurve()` looks up `settings.keyboards[status.midi.name]`.
  - `app/js/controller.js:1281` builds that name as `d.activeName || sel.map(name).join(', ')`, for example
    "Keystation, nanoKEY" in 'all' mode or the all-ports fallback.
- **Failure scenario:** two boards, each with its own curve, and input set to "All". Each board plays its own curve
  (the controller applies curves per input id), but the Edit sparkline shows linear and the "Normal follows…" line is
  empty. The problem is display only.
- **Suggested fix:** expose the selected inputs' names (`status.midi.inputs.filter(i => i.selected)`) and show
  "follows each keyboard's own touch" when more than one has a curve.

## R-8 · Low · plausible (needs a MIDI clock receiver): an engine restart re-sends MIDI Start mid-song with no Stop before it

- **Where:**
  - `app/js/engine/audio.js` `restart()`: `clickWas` → `_teardown()` → `metronome.dispose()`, which is
    `stop({silent: true})`, so no MIDI Stop goes out. Then `this.clickStart()` runs.
  - `app/js/engine/metronome.js` `start()` resets `_startSent`, so the first pulse of the new grid carries
    `MIDI_START`.
- **Failure scenario:** an audio restart while the click runs and Clock out feeds a drum machine or delay pedal. The
  restart can come from a latency change, the "Restart sound" banner, or the watchdog. The receiver gets a second
  Start, which resets song position to bar 1, on a click grid with a new phase. The drum machine jumps relative to the
  band. The click jumps too, but the click is only heard in the in-ears.
- **Suggested fix:** on a restart, either send Stop before the new Start (honest), or send Continue (0xFB) and keep the
  old grid's phase. That would mean restarting at the next beat of the old grid rather than "now + 60 ms".
- **Collides with:** (b) ("Panic stops the click" touches the same stop / Stop-message path). It also touches
  engine/metronome.js, which is (a)'s tree.

---

## Checked and clean (no finding)

- **Bus contract:** `COMMAND_TYPES` (bus.js, 14), main.js `BUS_COMMANDS`, `validateBusCommand`, the controller's
  `handleCommand`, and `HOTKEY_IDS` in shared/hotkeys.js and global-hotkeys.js (7) all agree. `stateError` validates
  the optional `scene` field.
- **Automation:** the new code has no raw AudioParam calls and no glide without `{from}`. `fx.trackedMove` / `linFrom`
  pass `from`, and every writer of `fader.gain` and `drone.level.gain` records its move. The engine adds no
  `setTimeout`: the metronome pump and wheel glide use `AudioTimer`, which calls back with `max(t, currentTime)`, so
  a late pump skips past clicks as documented.
- **PARAMS ↔ engine:** the `slots.<i>.touch.*` rows and the `'custom'` enum go through `_setSlotParam` / `getParam`.
  They stay absent until set (SLOT_EXTRA). `velocityCurve` and `touch` writes invalidate the per-channel curve cache.
- **Store:**
  - `scenes`, `timeSig`, `keyboards`, `hotkeys`, `updateCheck`, `click` and `midiClockOut` stay absent until set.
  - `migrate` is idempotent for each of them: normalisers are applied twice, and junk is dropped.
  - Nested writes are refused where they should be.
  - A replace-import can't bring in `hotkeys` / `click` / `midiClockOut` / `updateCheck`: the `keep` spread writes
    `undefined`, and `normalizeSettings` deletes it. R-3 is the one gap.
- **IPC:** every new handler goes through `handle()` → `isOurFrame`, and argument types are checked.
  - The importer never takes a path from the page: keys are sha1s of the last scan. The worker re-checks `.exs`
    realpaths inside the roots and the output folder (`checkOutDir` + `insideDir`, realpath of the existing prefix).
  - `openExternal` only receives `openable()` URLs (see R-5).
  - The update check is off from source, under `RIG_SELFTEST`, and with `RIG_UPDATE_CHECK=0`, unless `RIG_UPDATE_FEED`
    is set. electron-full runs from source and build-lint's packaged boot sets `RIG_SELFTEST`, so neither touches the
    network.
- **Packaging:** `build.files` matches build-lint's present and allowed lists. The eight `tools/exs` modules import
  only each other and `node:*`, and nothing else from `tools/` ships.
- **Lifecycles:**
  - Settings parts (`mountKeyboards`, `mountHotkeys`, `mountUpdates`, the GarageBand panel) are released through
    `cleanups` / `listen`.
  - Edit panels release through `ctx` / binder: slot `offs` are tracked, song uses `ctx.listen`, and effects' tone
    glyphs are destroyed.
  - `onThemeChange` and `onVoiceChange` disconnect when their last listener goes.
- **Errors and 404s:** no new `console.error` and no new optional fetch. The Ember title font exists.
- **Refuted while checking:**
  - "Esc in the GarageBand panel triggers Panic": app/js/main.js's document-level Esc listener is registered before
    the controller's and calls `preventDefault` while Settings is open.
  - "Deleting an earlier scene while a later one plays leaves the engine on the wrong scene": the store notifies
    after `removeScene` has updated `applied` and `n`, and the repro passed.
  - "Learned faders don't re-pick-up after a scene step": `learnedFader` drops `picked` when the level moved by more
    than 0.02.
