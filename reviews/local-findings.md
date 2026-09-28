# Local findings: full test run on the Mac

- Date: 2026-09-28 (run started 18:48Z, summary 19:05Z)
- Machine: macOS Darwin 25.4.0 (Apple Silicon, arm64), Node 25.2.0, Electron 44 (44.4.5), Playwright Chromium build 1194
- Commit tested: `a1979cc` (full `npm test` = `node test/run-all.mjs --skip soak`). Fixes L-1 and L-2 are in `db41087` and
  `7e2439d`; the suites they touch were re-run with `--only` on top of them.
- Soak was not run (skipped on purpose; it comes later).

## Suites

| suite | full run @ a1979cc | wall | re-run after fixes | wall |
|---|---|---|---|---|
| unit | PASS 267 pass, 0 fail | 6.4 s | n/a | |
| engine | PASS 59/59, 0 soft warnings, 0 console errors | 1m37s | n/a | |
| instruments | PASS 143/143 | 23.6 s | n/a | |
| synth-extra | PASS 153/153 | 37.5 s | n/a | |
| shell | **FAIL** 152 pass, 14 fail (all 14 = Electron boot) | 15.5 s | PASS 166 pass, 0 fail (L-1) | 18.7 s |
| ui-core | PASS 39 pass, 0 fail | 1m41s | n/a | |
| ui-edit | **TIMEOUT**, killed after 720 s (first test hung) | 12m01s | still fails (L-3, NEEDS CLOUD); diagnostic run with only `midi` granted: 94/94 in 33 s | |
| chrome-fallback | PASS 15/15, 1 skipped | 7.6 s | n/a | |
| electron-full | **FAIL** 4/21, 17 failed | 1.1 s | PASS 28/28 (L-1) | 13.6 s |
| build-lint | **FAIL** 5/6, 1 failed | 3.7 s | PASS 23/23, 1 skipped (boot: Linux only) (L-2) | 5.2 s |
| soak | SKIP (`--skip soak`) | n/a | n/a | |

Full run: 6/10 suites passed, total 16m54s. After L-1 and L-2: 9/10. The one left is ui-edit, which is blocked on L-3.

## Findings

### L-1: Electron launchers inherit `ELECTRON_RUN_AS_NODE`

- Severity: minor. Class: test bug (harness), triggered by the environment.
- Suites: shell (Electron boot, 14 tests), electron-full (17 checks); build-lint's packaged boot had the same pattern.
- Where: `test/phase1/shell/electron.boot.mjs:27`, `test/integration/electron-full.mjs:137`,
  `test/integration/build-lint.mjs:48,99` (all spread `process.env` into the Electron env).
- Repro: `ELECTRON_RUN_AS_NODE=1 node test/run-all.mjs --only shell,electron-full` at `a1979cc`.
- Observed: `main.js:37 TypeError: Cannot read properties of undefined (reading 'setPath')` under "Node.js v24.21.0"
  (Electron's own Node), no `RIG_SELFTEST` line, and every later test fails on `null.result`.
- Expected: Electron boots as Electron.
- Cause: the shell that ran the suite was started from an Electron host and exported `ELECTRON_RUN_AS_NODE=1`. VS Code
  terminals and Electron-hosted agents do the same, so it isn't only this Mac. With that variable set, `npx electron .`
  runs `main.js` as plain Node and `require('electron').app` is undefined.
- Fixed in `db41087`: new `electronEnv(extra)` in `test/integration/lib.mjs` drops the variable, and all three launchers
  use it. Regression check: the re-run above was done with `ELECTRON_RUN_AS_NODE=1` still exported and passes.

### L-2: build-lint can never pass on macOS

- Severity: major (the suite fails on every Mac run). Class: test bug.
- Suite: build-lint.
- Where: `test/integration/build-lint.mjs:45` (at `a1979cc`), which hard-codes `electron-builder --linux dir` with
  `-c.electronDist=node_modules/electron/dist`.
- Repro: `node test/run-all.mjs --only build-lint` at `a1979cc` on a Mac.
- Observed: `ENOENT … rename '<out>/linux-arm64-unpacked/electron' -> '<out>/linux-arm64-unpacked/worship-rig'`.
- Expected: the packaging check runs on the host.
- Cause: on macOS `node_modules/electron/dist` holds `Electron.app`, not a Linux `electron` binary, so a Linux target
  built from that dist cannot work.
- Fixed in `7e2439d`: on darwin, build-lint runs `--mac dir` (the afterPack ad-hoc codesign runs too) and reads
  `app.asar` from `<productName>.app/Contents/Resources`. All content checks are unchanged. The packaged-app boot is
  still Linux+xvfb only. `test/README.md` row updated.

### L-3: `controller.start()` never resolves while Web MIDI init is pending (**NEEDS CLOUD**)

- Severity: major. Class: real bug in app code (robustness). It shows up as a test hang, and the trigger is
  Mac-specific.
- Suite: ui-edit (app mode). This is why the suite hit run-all's 12-minute timeout.
- Where: `app/js/controller.js:1805` (`await midiReady` at the end of `startPrimary()`; protected module), fed by
  `app/js/midi.js:132` (`await nav.requestMIDIAccess({sysex:false})`, no timeout). `app/js/main.js:741` exposes the
  same promise as `window.__rig.ready`.
- Repro: `UIEDIT_MODES=app node test/phase2/ui-edit/run.mjs` on this Mac, which has 2 MIDI inputs visible to Chromium.
  It hangs at `test/phase2/ui-edit/run.mjs:129` (`await ev(() => window.__rig.ready)`).
- Observed, with `requestMIDIAccess` instrumented through an init script:
  - The app's own call (t=395 ms, from `MidiInput.init ← startPrimary ← start`) is still pending after 12 s and 30 s.
  - `controller.status` meanwhile says `ready: true`, `audio: running`, and
    `midi: {available:false, reason:null}`.
  - A second call from `page.evaluate` in the same page resolves in 3 ms with 2 inputs.
  - A plain page, even one that starts an AudioContext first or runs `permissions.query({name:'midi'})` at the same
    time, gets a resolved first call. I could not isolate what in the app's boot makes the first call stick.
  - It only happens when the context grants `midi-sysex`, which is what ui-edit does
    (`test/phase2/ui-edit/run.mjs:51`). With only `midi` (as ui-core and soak grant), Chromium rejects at once with
    `NotAllowedError` and everything passes (94/94).
- Expected: `start()` settles once audio and the song are up. MIDI availability should arrive through status events,
  not gate the start promise.
- User impact (not verified by hand): in the Chrome fallback, `requestMIDIAccess` also stays pending while Chrome's
  permission prompt is unanswered, so anything chained on `start()` / `__rig.ready` waits for the user. In `main.js`
  that is only the overlay fallback at line 735, so the visible impact is likely small. Electron resolves quickly.
- Suggested fix (cloud): stop awaiting `midiReady` in `startPrimary()`, or race it against a short timeout and let
  the later `midi` events update status. Test bodies that await `window.__rig.ready` should also bound the wait (see
  L-4).
- Not fixed locally: the fix belongs in `controller.js`, which is protected.

### L-4: ui-edit waits on `window.__rig.ready` with no timeout

- Severity: minor. Class: test bug.
- Suite: ui-edit. `test/phase2/ui-edit/run.mjs:129`.
- Observed: `page.evaluate` has no timeout, so L-3 turned into 12 silent minutes and then a run-all kill. The log then
  shows 47 "Target page … closed" failures that hide the real cause.
- Expected: fail in seconds with the MIDI status. A local patch (30 s race and throw with `controller.status.midi`)
  did that, but later tests then cascade into 30 s locator timeouts because boot never switched to the Edit view.
- **Not committed**: the coordinator says the next cloud snapshot deletes `test/phase2/ui-edit/` and replaces it with
  the edit-v2/settings/eq suites. The change was reverted to avoid a modify/delete conflict. For the cloud: the
  replacement suites should bound any wait on `__rig.ready`, and should decide on purpose whether to grant
  `midi-sysex`, since on a Mac with MIDI inputs that grant reaches the real CoreMIDI stack. The same unbounded wait is
  in `test/integration/electron-full.mjs:40`, `soak.mjs:333` and `smoke-chrome-fallback.mjs:88`. Those pass here
  because they grant only `midi`, or run in Electron.

## Environment

- ffmpeg 9.0.2 and Playwright Chromium build 1194 (repaired before this run) are fine: no "Executable doesn't exist"
  or dyld errors in any suite.
- This session's shell exports `ELECTRON_RUN_AS_NODE=1` and `ELECTRON_NO_ATTACH_CONSOLE=1` (inherited from the host).
  L-1 makes the suites immune to the first. The second is harmless.
- Ports 8437 and 8438 were free before every run, and no leftover Electron/Chromium processes were left behind.
- To check by hand: under electron-full on this Mac, Electron logged
  `[midi] MIDI unavailable (failed): Platform dependent initialization failed`, even though Playwright's Chromium
  sees 2 MIDI inputs on the same machine. This may be an artefact of launching Electron from the agent's (possibly
  sandboxed) shell. Please confirm that the keyboard connects when `Worship Rig.app` is launched from Finder (README
  manual Mac checklist).

# Merged tree 246f75c: full run + build (2026-09-28)

- Run: 19:37–19:43Z. Same machine as above (macOS Darwin 25.4.0, arm64, Node 25.2.0, Electron 44.4.5).
- Tree: `main` at `240e8d3`, which is merge `246f75c` plus a status line only. Full log:
  `test/logs/full-run-20260928T153702.txt` (git-ignored).
- Soak was skipped (`npm test` = `--skip soak`).

## Suites

| suite | full run @ 240e8d3 | wall | re-run after fix | wall |
|---|---|---|---|---|
| unit | PASS 275 pass, 0 fail | 6.4 s | n/a | |
| engine | PASS 64/65, 1 soft warning (`offline.eqCpu`: absolute timings outside DECISION ±30 %, faster box), 0 console errors | 1m40s | n/a | |
| instruments | PASS 143/143 | 23.6 s | n/a | |
| synth-extra | PASS 153/153 | 37.7 s | n/a | |
| shell | **FAIL** 165 pass, 1 fail (Electron boot: backup rotation) | 18.5 s | PASS 166/166, 3 of 3 runs (L-5) | 17.5–18.6 s |
| ui-core | PASS 39 pass, 0 fail | 1m43s | n/a | |
| edit-v2 | PASS 75 pass, 0 fail | 52.3 s | n/a | |
| settings | PASS 26/26 (app + fixture) | 11.7 s | n/a | |
| eq | PASS 22/22, 2 notes (engine has no `eqAudition()` / `slotAnalysers()` yet, so the component fallback is in use) | 9.4 s | n/a | |
| chrome-fallback | PASS 15/15, 1 skipped | 5.4 s | n/a | |
| electron-full | PASS 28/28 | 14.2 s | n/a | |
| build-lint | PASS 23/23, 1 skipped (packaged boot is Linux only); asar 77.6 MB, 2125 entries | 5.9 s | n/a | |
| soak | SKIP (`--skip soak`) | n/a | n/a | |

Full run: 11/12 suites passed, total 6m28s. After L-5: 12/12. L-3 is gone on this tree: the retired ui-edit
suite was replaced, and settings/edit-v2 pass here.

## Findings

### L-5: two library backups in the same millisecond overwrite each other

- Severity: minor. Class: real bug (`main.js`). It showed up as a flaky test.
- Suite: shell (Electron boot), `auto-backups land in userData/backups and only the newest 10 are kept`
  (`test/phase1/shell/electron.boot.mjs:132`).
- Where: `main.js:193-194` at `240e8d3`, in `backupNow()`.
- Repro: `node test/phase1/shell/run.mjs --only electron` at `240e8d3`. It failed 3 of 4 runs here (the full run plus
  2 of 3 re-runs).
- Observed: `9 !== 10` backup files after the fixture's 13 back-to-back `rig.backupNow()` calls.
- Expected: 10 files, with the newest (`n: 11`) kept.
- Cause: when `rig-<stamp>.json` already exists (same second), the fallback name is
  `rig-<stamp>-<Date.now() % 1000>.json`, and nothing checks whether that name is free. On an M-series Mac, two writes
  land in the same millisecond and the second one silently replaces the first. A standalone replay of the
  function lost a file in 37 of 50 runs. In real use this needs two backups within a millisecond (for example, the
  quit-time backup racing an auto-backup), so it is rare, but the loss would be silent.
- Fixed in `3a69692`: the suffix is now a counter (`-1`, `-2`, …) that is checked with `existsSync`. The names still
  match `BACKUP_RE`. After the fix, the replay lost 0 of 50 and the shell suite passed 3 of 3 runs.

### L-6: the top bar's "Sound OK" text runs into the latency readout at 1440 px (**NEEDS CLOUD**)

- Severity: cosmetic. Class: real bug (CSS). The top bar is on screen the whole time you perform.
- Where: `app/styles.css:181` (`.tb-item { min-width: 0 }`) together with `app/styles.css:186`
  (`.audio-text { min-width: 5.5ch }`). This file is CLOUD-owned.
- Repro: launch the app (built or source) on this Mac at its default window size (1440×887 CSS px, DPR 2) and look at
  the top bar. Screenshot described under Build.
- Observed: `#audio-text` is laid out 51 px wide but its content is 67 px (`scrollWidth`), so the "K" of "Sound OK"
  is drawn over the "2" of "20 ms".
- Expected: the two readouts sit side by side, as in the ≤ 1250 px rule, which sets `flex-shrink: 0` on
  `.tb-item > *`.
- Suspected cause: above 1250 px the flex children of `.tb-item` may still shrink, and `min-width: 5.5ch` lets
  "Sound OK" (8 characters) shrink below its text width. Suggested fix: `.audio-text { flex-shrink: 0 }` (or
  `min-width: 8.5ch`). This could go in the C1 polish pass.

### L-7: the packaged app does not see the repo's `user-samples/` packs (by design; FYI)

- Severity: minor (user-facing surprise). Class: expected behaviour. The docs could say it more plainly.
- Where: `server.js:236` skips `<repo>/user-samples` when running inside `app.asar`.
- Observed: `/api/user-samples` from `npm start` lists 2 packs (steinway-grand-piano, yamaha-grand-piano) from
  `<repo>/user-samples`. The built app lists 0, because its only root is `~/Music/Worship Rig/Samples`, which doesn't
  exist yet. `/api/health` is the same for both (`userSamples: true`).
- Impact today: none of the library's songs use a `user:` instrument (checked in `rig.v1`), so nothing falls back.
  The two converted Logic pianos are just missing from the picker in the built app.
- Action: LOCAL can copy the two packs to `~/Music/Worship Rig/Samples/` when Ryan wants them in the built app (they
  never leave the Mac). This was not done in this run.

## Build (`npm run build:mac` @ 3a69692)

- Result: OK, exit 0, **26 s** wall. electron-builder 26.15.3, Electron 44.4.5 (the zip came from the cache).
- Warnings:
  - `Specified application directory equals to project dir — superfluous or wrong configuration appDirectory=.`
    (`package.json` `build.directories.app: "."`; harmless; package.json is frozen).
  - `skipped macOS code signing reason=identity explicitly is set to null`. This is expected: afterPack ad-hoc signs
    first, and `codesign --verify --deep --strict` passes.
- Sizes:
  - `Worship Rig.app`: **365 MB**
  - `Worship Rig-0.1.0-arm64-mac.zip`: **193 MB** (199,270,236 B). `unzip -t` reports no errors.
  - `app.asar`: 81.4 MB
- asar contents:
  - **2125** entries.
  - `grep -c user-samples` = **0**, and nothing matches steinway/yamaha.
  - `app/samples/**`: 2029 entries. 1999 of them are audio files, which is every file the manifest lists
    (23 instruments). `app/samples/manifest.json` is present.
  - `docs/*.md` and `main.js` are present.
- Signing:
  - `codesign -dv`: `Identifier=com.ryan.worshiprig`, `Format=app bundle with Mach-O thin (arm64)`,
    `CodeDirectory v=20400 … flags=0x2(adhoc)`, `Signature=adhoc`.
  - `spctl --assess --type execute`: `rejected` (exit 3). This is expected for ad-hoc signing. On first launch from
    a downloaded zip, Gatekeeper needs right-click → Open, or System Settings → Privacy & Security → Open Anyway.
  - `xattr -l`: only `com.apple.provenance` (empty value) and no `com.apple.quarantine`, because it was built locally.
- The bundle ships `Resources/app-update.yml` (github provider ryanmye/worship-rig). It is inert: nothing in
  `package.json` or `main.js` uses an updater.
- Launch of the built app (`open "dist/mac-arm64/Worship Rig.app"`, health checked after about 8 s):
  - `/api/health`:
    `{"ok":true,"app":"worship-rig","version":"0.1.0","pid":20261,"clientSeenMsAgo":null,"userSamples":true,"features":["user-samples"]}`
  - `~/Music/Worship Rig` was **not** created at launch. It is created on first recording or "Open … Folder". The
    library is Ryan's existing one (userData from 02:54), so this was not a clean-profile first launch.
  - `controller.status`: audio `running`, latency 19.8 ms, ready. MIDI is connected to **Keystation 49es Port 1**
    (Port 2 is also listed). The library is read-write. Setlist memory is 417 MB decoded out of a 700 MB cap.
  - `osascript quit` exits the app cleanly, and 8438 was free again afterwards.
- Screenshot: `screencapture` failed with `could not create image from display`, because this shell has no Screen
  Recording permission. I relaunched with `--remote-debugging-port` and took a page screenshot over CDP instead, with
  no clicks. That captures only the web contents, so an OS-level MIDI or microphone permission dialog would not
  show. None was reported by the app, and MIDI was already connected. What the screenshot shows:
  - The Perform view is fully rendered: "Sunday Pad + Piano", key C, transpose 0.
  - Space and Echo rows, with "Song's own" selected.
  - The setlist strip: 1–6 visible, with "Next: Building Swell · C".
  - KEYS (Grand Piano +1.7 dB) and PAD (Warm Pad −5.2 dB) on, and empty EXTRA/BASS.
  - The Key & Drone panel (drone off), Notes, the keyboard strip C2–C7, and Revert / Fade out / PANIC / Lock.
  - The top bar reads `MIDI Keystation 49…`, `Sound OK`, `20 ms` and `READY`, all with green LEDs.
  - There is no error banner and no "Audio stopped". The only defect is L-6.
- `npm start` from source, same checks:
  - Health JSON is identical apart from the pid (`userSamples: true` in both).
  - `/api/user-samples` differs (L-7): the source app reports 2 packs and 2 roots, the built app 0 packs and 1 root.
  - Status and the screenshot are identical to the built app, MIDI included.
  - This settles the open question in L-3's environment note: Electron started from this shell *does* reach
    CoreMIDI. The earlier `Platform dependent initialization failed` did not recur in today's electron-full log.

## Soak, 20 min, tree 3a69692 (2026-09-28, native macOS)

`node test/run-all.mjs --only soak --soak-minutes 20`: **11/12**, 20m47s. 17494 events, 4012 notes, 38 song switches
(14 lofi), 13 panics, 30 key changes, 183 sweeps. Voices back to 0 in 1.1 s, nodes 226 → 226, heap +0.83 MB, audio
running throughout, 0 NaN, 0 console errors. Log: `test/logs/soak.log`, CSV: `test/logs/soak.csv`.

### L-8 — pinned decoded samples exceed the cache cap under the large-set policy (major, real bug, NEEDS CLOUD)

- Suite: soak, check "decoded samples stay under the engine cache cap (pins limited)".
- Where: `app/js/controller.js:29-31, 91-93` (morning-prep pin policy, `PIN_BUDGET_MB = 600`, mode `large-set`).
- Repro: the soak above; the CSV column `pinnedMB` versus `capMB` (700).
- Observed: mode was `large-set` for the whole run (the soak drives the full factory library as a set). Pinned bytes
  went over the 700 MB cap in 7 of 44 samples: 754.2 MB while on `factory:gospel-stab-b3` (4 samples) and 939.4 MB
  while on `factory:upright-pad` (2 samples; decoded == pinned, so nothing was evictable). Typical values elsewhere
  were 185–420 MB pinned.
- Expected: in `large-set` mode only the current ±2 songs are pinned, so pinned bytes should stay well under the cap
  and decoded bytes should never be 100 % pinned.
- Suspected cause: the ±2 window is computed on library order, and the neighbours of the heavy sampled songs
  (upright-pad, gospel-stab-b3 sit next to other multi-sampled pianos/organs) sum past the budget, i.e. the window
  is a count, not a byte budget. Alternatively the previous window is not unpinned before the next is pinned during
  a switch (the overshoot lasts several 30 s samples, so it is not a transient). Suggest making the window a byte
  budget (drop the farthest neighbour until ≤ PIN_BUDGET_MB) or asserting pinned ≤ cap after each preload.
- Note: the same check passed on the 2-vCPU Linux container with the old library-pin policy (STATUS.md reported
  1023.6 MB decoded, flat). On the Mac the new policy holds most of the time but not around the heaviest songs.

## Sync 20260928T203314Z (cloud 7bf3382 → merge 05ec36f), fast suite on macOS

`npm test -- --fast`: **9/10** (unit 276, engine 68/69 + 1 soft warn, instruments 143, synth-extra 153, shell 166,
ui-core 41, edit-v2 81/82, settings 29, eq 25, chrome-fallback 15), 6m23s. Merge conflicts (COORDINATION.md add/add,
test/integration/lib.mjs one-sided) resolved by hand with Ryan's approval.

### L-9 — polish-1 `text:'dirty'` binder: an outside write is appended to a typed draft (major, real bug, NEEDS CLOUD)

- Suite: edit-v2 · song, `test/phase2/edit-v2/panels/song.test.mjs:215` ("tempo and notes follow outside writes
  while focused until typed in"). Deterministic on this Mac: failed 2 of 2 runs (full fast run, then `--only edit-v2`).
- Observed: after typing `13` into the focused tempo field, an outside store write of `88` leaves the field showing
  `1388`. Expected `13` (a typed draft must not be overwritten or appended to).
- Where: the polish-1 text `dirty` binder in the cloud-owned Edit panels (song panel / shared binder; cloud to locate).
- Suspected cause: the binder applies the outside value with `value +=` / insertion at the caret instead of
  skipping the write while `dirty` is set, or `dirty` is set on `input` but the assertion fires after a `change`
  that clears it. Could also be a Playwright `type` vs `fill` difference: `page.type` on macOS Chromium leaves the caret at
  the end and a subsequent programmatic `value = '88'`... would replace, not append, so append suggests the binder
  concatenates. Cloud's own run reportedly saw this as a flake; here it is not.
