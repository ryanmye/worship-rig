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

## Merged tree 05ec36f: bounded waits, soak L-8 verification, full run (2026-09-28, native macOS)

Tree: `05ec36f` plus `c889fd9` (L-4, local): `soak.mjs` and `smoke-chrome-fallback.mjs` now wait on `__rig.ready`
through `lib.waitRigReady` (30 s, throws with `controller.status.midi`). `soak.mjs` also bounds its
`__rig.viewsReady` wait to 30 s. Both files already granted only `'midi'`, so no grant changed. chrome-fallback
15/15 after the change.

### Soak, 20 min (L-8 verification)

`node test/run-all.mjs --only soak --soak-minutes 20`: **11/12**, 20m47s. 18109 events, 4134 notes, 38 song
switches (15 lofi), 15 panics, 30 key changes, 185 sweeps. Voices back to 0 in 1.12 s, nodes 226 → 226, heap
10.67 → 11.35 MB (+0.68 MB), audio running throughout, 0 NaN, 0 console errors.

- CSV (`test/logs/soak.csv`, 44 rows): `memMode` = `large-set` in every row. `budgetMB` = 600 and `capMB` = 700 in
  every row. `memNote` is sampled but is not a CSV column (it is missing from `COLS`), so the CSV can't show it.
- Max `pinnedMB` **568.9** (factory:anthem, t = 877 s). Max `decodedMB` **754.2** (factory:upright-pad,
  t = 1147 s).
- Rows with `pinnedMB > 600`: **none**. The pin budget holds.
- `factory:upright-pad`: 1147 s, decoded 754.2, pinned 421.2, retiring 1. 1177 s, decoded 591.1, pinned 421.2,
  retiring 0. On 3a69692 it pinned 939.4 MB.
- `factory:gospel-stab-b3` was not visited: the soak's random walk covered 15 factory songs this run, so the
  754 MB pin from 3a69692 could not recur here. The cloud's 44-song walk is not reproduced by this suite.
- Verdict: **L8_FAIL** under the agreed rule, because the cap check failed. The pinned part of L-8 is fixed: no row
  is over the budget, and the peak is 568.9 MB. The failure has a different cause, filed below as L-10.

### L-10: decoded samples briefly exceed the 700 MB cap during a song switch (minor; design question, NEEDS CLOUD/Ryan)

- Suite: soak, "decoded samples stay under the engine cache cap (pins limited)" (`test/integration/soak.mjs:434`).
- Observed: one row of 44 is over the cap. At t = 1147 s, on factory:upright-pad just after the switch from
  factory:dusty-piano, decoded was 754.2 MB, pinned 421.2 MB and `retiring` 1. By the next sample (1177 s,
  retiring 0) it had dropped to 591.1 MB, which is under the 595 MB low-water mark. Every other row was ≤ 696.2 MB.
- Cause (suspected, not instrumented): `BufferCache._evict` (`app/js/engine/sampler.js:403`) runs on every acquire,
  so at 754 MB nothing else was evictable. That means about 333 MB was unpinned but still referenced, which fits
  the retiring dusty-piano instruments (dusty-piano had been the pinned 332.9 MB before the switch). When they were
  released, 163 MB was freed. The cache's JSDoc says referenced buffers are never evicted, so the cap is soft by
  design during a switch overlap. The soak check treats it as a hard cap in every row.
- Decision needed:
  - (a) Accept it as a soft cap. LOCAL would then relax the check to require `decoded ≤ cap` only in rows with
    `retiring === 0`, or up to a stated margin.
  - (b) Treat the overlap as a real risk (old and new sampled songs both resident) and have the engine expose
    `referencedMB` in `status` so the check can require `pinned + referenced`-only overshoot.
- Also: add `memNote` to the soak `COLS` so the "alone" exemption is visible in the CSV. This is a LOCAL change,
  not made yet.

### Full run (`npm test`, soak skipped)

**11/12** suites passed, 6m56s.

| suite | result | detail |
|---|---|---|
| unit | PASS | 276 pass |
| engine | PASS | 68/69, 1 soft warn (`offline.eqCpu` absolute timings, as before) |
| instruments | PASS | 143/143 |
| synth-extra | PASS | 153/153 |
| shell | PASS | 180 pass |
| ui-core | PASS | 41 pass |
| edit-v2 | FAIL | 81/82, L-9 (`song.test.mjs`, '1388' !== '13'), unchanged |
| settings | PASS | 29/29 |
| eq | PASS | 25/25, 2 notes |
| chrome-fallback | PASS | 15/15, 1 skipped |
| electron-full | PASS | 28/28 |
| build-lint | PASS | 23/23, 1 skipped (packaged boot needs Linux + xvfb) |

No new failures in the full run. L-9 is still open (NEEDS CLOUD).

## Merged tree d921d4d: full run + soak, build, packs, perf (2026-09-28, native macOS)

Tests ran on d921d4d (app/ and test/ are unchanged through e6da619). The build is from e6da619, which is d921d4d
plus the local shell fixes L-11 and L-12 in main.js. Log: `test/logs/full-soak-20260928T180427.txt`.

### Full run + 20-min soak: 11/13 suites, 28m18s

| suite | result | detail |
|---|---|---|
| unit | PASS | 276 pass |
| engine | PASS | 68/69, 1 soft warn (`offline.eqCpu` absolute timings, as before) |
| instruments | PASS | 143/143 |
| synth-extra | PASS | 153/153 |
| shell | PASS | 180 pass (unit, browser, electron) |
| ui-core | FAIL | 45/46, L-20 |
| edit-v2 | PASS | 90/90 (L-9 is green) |
| settings | PASS | 29/29 |
| eq | FAIL | 25/26, L-21 |
| chrome-fallback | PASS | 15/15, 1 skipped |
| electron-full | PASS | 28/28 |
| build-lint | PASS | 23/23, 1 skipped |
| soak | PASS | 12/12 |

Both failures reproduce on every run so far: they failed in the fast run and failed again here. No other suite
failed, so no flake re-runs were needed.

### Soak (SOAK_OK)

- Activity: 16964 events, 4027 notes, 927 chords, 38 song switches (14 lofi), 14 panics, 31 key changes and
  172 sweeps across 15 factory songs.
- Recovery: after release, voices were back to 0 in 1.11 s. Nodes went 226 → 226. Heap went 10.75 → 11.39 MB
  (+0.64 MB). Audio kept running. There were 0 NaN and 0 console errors.
- Memory, from `test/logs/soak.csv` (44 rows, `memMode` = large-set in every row):
  - Max `pinnedMB` was 568.9 (factory:anthem, t = 158 s), within the 600 MB budget.
  - Max `decodedMB` was 695.2 (factory:lofi-rhodes, t = 578 s, retiring 0), within the 700 MB cap.
  - 0 of 44 rows were over the cap and 0 of 44 were over the budget, so the L-10 soft-cap exemption was never needed.

### L-20: `.song-name` is 2 px taller than its box at 1280×800 (minor, cosmetic plus test sensitivity, NEEDS CLOUD)

- Where it fails: `test/phase2/ui-core/run.mjs:2092` ("polish-2A responsive"), at the first viewport, 1280×800.
  The assertion message is `Y div.song-name[song-name] "Sunday Pad + Piano" 42>40`.
- Overflow: `scrollHeight` 42 against `clientHeight` 40, which is 2 px.
- The loop stops at that first viewport, so the other five viewports (1366×768 … 1024×700) were not checked.
- Screenshot: `test/phase2/ui-core/screenshots/responsive-1280x800.png`. Nothing is visibly cut. The title reads
  whole.
- Cause: `.song-name` is set as `font: 800 clamp(…, 40px)/1.05 var(--font-display)` (`app/styles.css:640`) with
  `overflow: hidden`. With `-apple-system` / SF Pro Display at weight 800, the glyph box is taller than a 1.05 line
  box. The Linux fallback font fits.
- Suggestion: allow for macOS system-font metrics, in either of two ways:
  - CSS: `line-height: 1.1`, or 1–2 px of `padding-block` inside the fixed row.
  - Test: tolerate ≤ 2 px of Y overflow on `.song-name` only, since it ellipsizes on X anyway, and let the loop
    report every viewport before it asserts.

### L-21: EQ band note cells cut their text on macOS at every width tested (minor, real and visible, NEEDS CLOUD)

- Where it fails: eq, "compact threshold 1080 px" (`test/phase2/eq/run.mjs:617`). At 1100 px the cells
  `≈F#6 +23¢` and `≈F#7 +23¢` fail the "every band cell shows its whole value" check.
- To measure it, I ran a scratch copy of the runner with the `cut` assertion turned into a log line. The copy lives
  outside the repo. The runner was not edited.

| viewport | card | layout | cut cells (`scrollWidth > clientWidth`) |
|---|---|---|---|
| 1100 | 1066 | compact | `≈F#6 +23¢` 78>74, `≈F#7 +23¢` 77>74 |
| 1112 | 1078 | compact | same as 1100 |
| 1124–1512 | 1090–1478 | full | `≈F#6 +23¢ · 1.5 kHz` 145>138 |

- So the full layout also cuts band 4, by 7 px, at 1124, 1280, 1366, 1440 and 1512. The test never reaches those
  widths because it fails first at 1100. The 1280 screenshot shows `≈F#6 +23¢ · 1.5 kH`. The font is
  `-apple-system` / SF Pro Text.
- Screenshots:
  - `test/phase2/eq/screenshots/FAIL-compact-threshold-1080-px-compactBelowHeight-no-overflow-aro.png`
  - `test/logs/l21-probe/eq-probe-{1100,1112,1124,1280,1366,1440,1512}x900.png`
  - All of these are git-ignored and exist only on the Mac.
- Suggestion: size the NOTE column for macOS metrics. SF Pro Text is about 5 % wider than the Linux fallback, so
  add roughly 6–8 px (compact) and 8–10 px (full) to the column, or size it in `ch` with headroom. Or drop the
  ` · 1.5 kHz` suffix when it doesn't fit, since the HZ column already shows it. A test tolerance would hide a cut
  that users can see here, so prefer the CSS change.

### Build and packs

- BUILD: `npm run build:mac` succeeded in 24 s. The app is 365M and the zip 190M. `app.asar` has 2127 entries,
  with 0 `user-samples` entries.
- PACKS_OK, 28 packs. The built app's `/api/health` returned
  `{"ok":true,…,"userSamples":true,"features":["user-samples"]}`. `/api/user-samples` returned enabled, root
  `~/Music/Worship Rig/Samples`, count 28, 0 errors, one instrument per pack. The packs:
  - Pianos: amplified-piano, below-the-surface-piano, boogie-man-piano, classical-grand, grand-piano,
    learner-s-piano, mellow-vibe-piano, more-modulation-piano, parallel-earth-piano, perfect-mix-piano,
    powered-tube-piano, pure-digital-piano, record-collection-grand, rise-above-piano, rusty-piano,
    simple-physics-piano, small-amped-acoustic-piano, steinway-grand-piano, subtle-dynamics-piano,
    supporting-cast-piano, worn-tape-piano, yamaha-grand-piano.
  - Keys: 80s-chime-vibe, claverotor, different-phases-clav, double-tracked-wurli, flea-market-wurli, lullaby-vibes.
- `clientSeenMsAgo` is null in the Mac app. That is expected: the heartbeat is Chrome-only. After quitting, port
  8438 was free.

### PERF: built app, M-series Mac, 120 Hz display

Method:
- Numbers are `ps` RSS and %CPU, averaged over 5 s samples. The utility row sums the Audio, Network and
  VideoCapture services.
- Idle: the app launched with `open` and was left untouched for 30 s on its startup song, Sunday Pad + Piano, with
  0 voices sounding.
- Play: the app launched with `--remote-debugging-port=9223` and Playwright attached over CDP. On each song, a
  4-note chord was played through `controller.perform.noteOn/noteOff` every 500 ms for 20 s. Songs were selected
  by `factoryId`, because the library's songs have their own ids (`song_…`), and `selectSong('factory:…')` warns
  and does nothing.

| phase | main | GPU | renderer | utility ×3 | total | max voices |
|---|---|---|---|---|---|---|
| idle (plain `open`) | 141 MB / 0.2 % | 71 / 2.7 | 536 / 47.5 | 132 / 0.2 | 880 MB / 50.6 % | 0 |
| idle (CDP) | 147 / 0.0 | 74 / 2.6 | 536 / 46.0 | 134 / 0.1 | 890 / 48.7 | 0 |
| idle, AudioContext suspended | 137 / 0.0 | 75 / 2.7 | 215 / 27.1 | 130 / 0.1 | 557 / 29.9 | 0 |
| play Sunday Pad + Piano | 130 / 0.0 | 78 / 16.4 | 217 / 49.7 | 127 / 0.0 | 552 / 66.1 | 36 |
| play Anthem | 129 / 0.1 | 74 / 15.4 | 257 / 51.3 | 128 / 0.0 | 588 / 66.8 | 36 |
| play Organ Swell | 127 / 0.0 | 76 / 16.5 | 255 / 51.0 | 126 / 0.0 | 583 / 67.5 | 28 |

- RSS understates the renderer. After the suspend, renderer RSS fell from 536 to 215 MB while the engine still
  held 417 MB of decoded samples, because macOS compresses pages. `footprint` on the renderer after the play runs
  showed `phys_footprint` 1099 MB (peak 1122 MB), and that is the real figure.
- `decodedMB` stayed at 417.1 on all three songs, because large-set pinning had already loaded them.
- For comparison, GarageBand 20 s after launch, idle: RSS 321 MB, `phys_footprint` 609 MB, 2.3 % CPU.
- About the GarageBand quit: an AppleScript `get name of windows` hung, probably on the project chooser's modal. I
  sent `quit app`, with SIGTERM as a fallback, and GarageBand exited. I clicked no dialogs.

### L-22: the renderer uses about 46 % of a core while idle and silent (major for battery and low-resource mode, real, NEEDS CLOUD)

- Observed: on the built app with 0 voices, the renderer averaged 46–48 % CPU (`ps`) over 30 s. `top` read 44 %
  at the same time.
- The breakdown:
  - `requestAnimationFrame` runs at 120.5 /s while idle (ProMotion).
  - Suspending the AudioContext drops the renderer to 27 %. That puts about 19 points on the silent audio graph
    (174 nodes: shared FX, convolvers and taps processing silence) and about 27 points on the UI, which redraws at
    120 Hz while nothing changes (meters, analyser, strips).
- Expected: near-zero CPU when silent. That means stopping the rAF loops when levels are 0 or unchanged, capping
  meters at 30–60 fps, and letting idle FX sleep.
- This bears directly on C7 `lowResource` and on the C6 performance critic.
- Uncertainty: `ps` %CPU is a decaying average. `top` read 19 % after the play runs (after a suspend/resume
  cycle), so part of the idle load may depend on state. That needs a CPU profile.

### Notes

- The built app starts a VideoCaptureService utility process (45 MB). It probably comes from device enumeration.
  This is FYI only.
- A leftover Google Chrome process with Worship Rig switches (pid 66929, from an earlier `serve.mjs` session) was
  running throughout. I left it alone.

## Security batch (review-4 S1, S4–S8)

Local fixes for `reviews/security.md`. There is one commit per item, all on `main`, and all are pushed.

- **S1 step 1** (`31bf4ca`): the six Apple `.exs` files are out of the repo.
  - They are untracked and deleted from the working tree. `.gitignore:21-22` ignores `tools/exs/fixtures/real/`.
  - Copies live in `~/Music/Worship Rig/exs-fixtures/`, byte-identical (cmp) to the originals, 6 files.
  - `test/unit/exs/real-files.test.mjs:15-20` reads `RIG_EXS_FIXTURES` (default `~/Music/Worship Rig/exs-fixtures`,
    with `~` expanded). If any of the six files is missing, it prints the reason and skips every test.
  - `docs/garageband-import.md` and the `tools/exs/layout.mjs` header now say where the files live.
  - Tree scan: no other Apple content is tracked.
    - The only `.exs`/GarageBand path hits are `docs/garageband-import.md` and `tools/import-garageband.mjs`.
    - The "Apple Inc" hits are MIDI port-manufacturer strings in `app/js/midi.js:42` and `midi-default.test.mjs`.
    - `audition/mp3` holds renders of the bundled CC instruments. `app/samples` is all CC0/CC-BY/CC-BY-SA per its
      manifest.
  - **Step 2 (history purge / private repo) is not done. It needs Ryan.**
- **S4** (`c88f071`): personal audio routes are keyed per launch.
  - `server.js` gains `createServer({secret})`. `PRIVATE_ROUTE_RE` (`:76`) covers `/api/user-samples`,
    `/api/user-samples/manifest.json`, `/user-samples/*`, `/api/pads` and `/pads/*`. They answer 403 unless the request
    has `X-Rig-Key: <secret>` (timing-safe compare, `keyOk` `:455`, gate `:687`).
  - `main.js:43` generates a 24-byte key at each launch and passes it to the server (`:1605`).
  - `installPermissions` adds the header only to requests for our own origin (`session.webRequest.onBeforeSendHeaders`,
    `:1125`). The main window and the popover share the default session, so both get it.
  - The Chrome fallback (serve.mjs) passes no secret and behaves as before, as the review recommends.
  - `sendJSON` and `sendText` now send `nosniff`.
  - Not done: fix 1 of the review (dropping `roots` from the HTTP manifest). `test/phase1/shell/shell3.test.mjs:106`
    asserts `m.roots`, and local may not edit it. That call belongs to the cloud.
  - Probe with a plain node client and `secret:'k3y'`: health and index are 200; every private route is 403 without
    the key or with a wrong key, and 200/404 with it.
- **S5** (`c17622c`): `rewriteUserInstrument` (`server.js:263-305`) checks the fields that go into sample URLs.
  - Instrument `ext`/`format` must match `/^[a-z0-9]{1,5}$/i`, or the instrument is dropped.
  - A layer's `ext` must match the same rule, and its effective `notes[]` must be note names (`/^[A-G][#b]?-?\d$/`) or
    MIDI integers 0-127, or the layer is dropped.
  - An invalid instrument-level `notes` is removed.
  - Each drop adds a `<slug>: instrument "id" …` line to `errors[]`.
  - The review's `notes` means the note-name array, not free text. The renderer is already XSS-safe (S10), so free-text
    fields were left alone.
  - Real packs: 28 instruments and 47 layers before and after. A hostile manifest (`wav/../../api/heartbeat#`,
    `C4/../../x#`, `a?b`, `x.y`) was dropped with the right messages.
- **S6** (`c2667da`, `main.js`):
  - `streamOpen`: `forceWav` (`:109`) forces `.wav` on bare names and on unapproved absolute paths. An absolute path
    must also pass `realWithin(recordingsDir)` (`:115`, which follows symlinks). Save-dialog paths are unchanged (the
    user chose them). Every opened take goes into `writtenPaths` (`:333`).
  - `revealFile` (`:431`) allows only Recordings, backups (realpath) or a take this process wrote. Anything else gets
    `{error:'not allowed'}`, so it no longer reveals whether arbitrary paths exist.
- **S7** (`9a8be4e`): importer path trust.
  - `tools/exs/sample-index.mjs:134,168`: a stored absolute sample path must have an audio extension. When the caller
    passes `roots`, it must also realpath inside one of them. The importer passes the sample and instrument roots
    (`import-garageband.mjs:615`).
  - `checkOutDir` (`:48`) refuses any `--out` inside `<repo>/app` (realpath, symlinks included) with a friendly error
    and exit 2. It warns when `--out` is in the repo but outside `user-samples/`. The docs table notes this.
- **S8** (`0012c72`, `test/integration/build-lint.mjs`):
  - Repo checks (`:44`, from `git ls-files`) fail on any tracked `.exs`/`.caf`, `user-samples/**`,
    `tools/exs/fixtures/real/**`, `*personal-use*` file name, or tracked `manifest.json` with a `personal-use` license.
  - Asar checks (`:97`) fail on `.exs`/`.caf`/`.aif`/`.aiff` or `*personal-use*` files, a packaged `manifest.json` with
    a `personal-use` license, or an `app/samples/<dir>` the manifest doesn't list.

**Tests:**
- `node --test test/unit/exs/real-files.test.mjs`: 7/7 pass. With `RIG_EXS_FIXTURES=/nonexistent`: 7 skipped, exit 0.
- `node --test test/unit/exs/*.test.mjs`: 61/61.
- `node test/phase1/shell/run.mjs --only unit`: 188/188, after S4, S5 and S6.
- `RIG_PORT=8452 node --test test/phase1/shell/electron.boot.mjs`: 12/16. The 4 failures only assert the hard-coded
  port 8438/8439, which can't be used while Ryan's app is open. The pads Range, My Samples manifest + sample,
  streamOpen-denied, dup-take and M6 steps all pass through the key header, and no request got a 403.
- `node test/run-all.mjs --only unit,chrome-fallback,build-lint`: 3/3. unit 286 pass, chrome-fallback 15/15,
  build-lint 31/31.

## Release pipeline (dmg + x64, 2026-09-30, native macOS)

Config (`d941f57`): mac targets are `dir` + `zip` + `dmg` (arm64 by default), `mac.artifactName`
`Worship-Rig-${version}-${arch}.${ext}` (no space, no `-mac` suffix), `dmg.filesystem: "APFS"`.
The workflow is `.github/workflows/release.yml` (`6a1bde3`).

- **HFS+ dmg images don't attach on this Mac.** electron-builder's default dmg (HFS+) failed with
  `hdiutil: attach failed - no mountable file systems`. A bare `hdiutil create -fs HFS+` image fails the same way,
  inside and outside the sandbox, while an APFS image attaches. APFS is fine for the app's macOS 12+ minimum, so
  the config uses APFS.
- **CLI `--x64` doesn't override config arch.** Every target in `mac.target` pins `arch: ["arm64"]`, and build-lint
  checks for that. So `npx electron-builder --mac --x64` would rebuild arm64 and add nothing for x64
  (`computeArchToTargetNamesMap`). The x64 command names the targets:
  `npx electron-builder --mac dir zip dmg --x64 --publish never`.
- Builds went to a scratch output dir (`-c.directories.output=…`), because Ryan's app runs from
  `dist/mac-arm64/` and a build into `dist/` would replace it underneath him.

| | arm64 | x64 |
|---|---|---|
| build (dir+zip+dmg), local | 29 s | 71 s (includes the one-time x64 Electron download) |
| build job, CI (macos-14) | 72 s | 66 s |
| `Worship Rig.app` (`du -sm`) | 366 MB | 372 MB |
| `.zip` | 190.5 MB (199,788,509 B) | 196.8 MB (206,401,887 B) |
| `.dmg` (UDZO, APFS) | 191.3 MB (200,607,203 B) | 197.6 MB (207,226,881 B) |

- Both apps are under 480 MB. `node test/run-all.mjs --only build-lint`: 31/31 pass, 1 skipped, app 379 MB.
- dmg contents: `Worship Rig.app` (`Signature=adhoc`, `Identifier=com.ryan.worshiprig`), an `Applications` link and
  a volume icon. Volume name: "Worship Rig 0.1.0".
- x64 binary: `lipo -archs` prints `x86_64` and `file` reports `Mach-O 64-bit executable x86_64`. An x86_64-only
  binary running on this arm64 Mac (`hw.optional.arm64=1`) must be running under Rosetta, and that's the proof
  used here.

**Rosetta smoke** (`arch -x86_64 …/mac/Worship Rig.app/Contents/MacOS/Worship Rig`, `RIG_PORT=8452`, temp
`RIG_USER_DATA`, `RIG_SELFTEST=1`):
- The first launch took **35.4 s** to reach `/api/health` 200. Most of that is Rosetta translating Electron on
  first run. The second launch took **2.65 s**.
- Health: `{"ok":true,"app":"worship-rig","version":"0.1.0",…}`.
- Self-test report: `consoleErrors 0, consoleWarnings 0, httpErrors []`, then `timeout:true` with exit 2. That
  result is expected, because the real app has no `__RIG_SELFTEST__` probe.
- MIDI (read over DevTools, `--remote-debugging-port=9452`): the top bar shows `Keystation 49es Port 1`
  (`MIDI input: Keystation 49es Port 1`).
- Both runs quit themselves, and nothing was left on 8452.

**CI dry run**: https://github.com/ryanmye/worship-rig/actions/runs/36653192277. Both build jobs succeeded, and
`release` was skipped. It uploaded four artifacts:
- `Worship-Rig-0.1.0-arm64.zip` (200,948,216 B)
- `Worship-Rig-0.1.0-arm64.dmg` (201,769,903 B)
- `Worship-Rig-0.1.0-x64.zip` (206,402,051 B)
- `Worship-Rig-0.1.0-x64.dmg` (207,218,145 B)

No tag or GitHub release was created. The release job runs only for a `refs/tags/v*` ref: on a tag push, or on a
manual run on a tag with dry_run unticked. It checks the tag against the `package.json` version first.

## Final build b9f7f61: pedal ring, EQ under Advanced, Sanctuary vs Classic (2026-09-30, native macOS)

Built app `dist/mac-arm64/Worship Rig.app` (b9f7f61), relaunched with `--remote-debugging-port=9333` on a fresh temp
`RIG_USER_DATA` / `RIG_USER_SAMPLES` (factory library, Sanctuary default, 44.1 kHz context, Keystation connected).
Playwright attached over CDP.

**Pedal ring** (factory "Grand Piano", drone off; `midi._inject` on the selected input: CC64 127 → `status.pedal`
true, note on vel 90, note off at 0.5 s, pedal kept down; stereo RMS / peak of `engine.analyserL/R` every 0.5 s for
30 s; pedal up at the end → `status.pedal` false, silence 1.5 s later):
- **C4 (60): RMS last ≥ −50 dBFS at 6.0 s (peak at 13.5 s), −61.9 at 14 s, then a cliff at 15.5 s (−63 → −90).**
  That is the file's end, not a cap. CONTRACT "## sustain" lists octave 4 as 8.7–15.5 s after the onset trim, under
  the old 16 s cap too. So "≈ 20 s" does not apply to C4.
- **A1 (33, a 20.0 s file): RMS last ≥ −50 dBFS at 19.0 s (peak at 19.5 s), −51.6 at 18 s, −72.3 at 20 s**, silent
  from 28 s (reverb tail). This is past the old 16 s cap, so the long `maxSec` works in the built app.
- `pedaled` stayed 1 for the whole 30 s. No early fade.

**EQ under Advanced: yes.** Edit → Keys (`.ev2-tab[data-block="slot:0"]`, selected) → click the
`details[data-sec="slot0-adv"]` summary. Two frames later `details[data-sec="slot0-adv"] .ev2-slot-tone-host >
section.eqk` was mounted. There is no `details[data-sec="slot0-tone"]`. The only other `summary` in Advanced is the
EQ's own "Bring an EQ over (paste)". "Tone" is a plain heading (`.ev2-slot-adv-h`).
- Site: sanctuary, 1440 × 900 @2× (`Emulation.setDeviceMetricsOverride`), Sunday Pad + Piano, Keys › Advanced open.
- `edit.webp` is scrolled to the Advanced header: pan/width, transpose/voices, Tone and the EQ's top (86.7 KB).
- `edit-eq.webp` uses the old framing, scrolled to "Tone": graph, keyboard and bands (96.1 KB).
- Both were made with `cwebp -q 82 -resize 1440 0`.

**Sanctuary vs Classic** (Sunday Pad + Piano, drone `synth` sounding with analyser peak 0.08–0.15, Perform view,
visible 1440 × 856 window at 2×, no emulation; 10 s settle, then a 20 s window; `ps -o time=` deltas on the Renderer
helper and the GPU pid; CDP `Performance.getMetrics` deltas). There were two interleaved rounds (S, C, then C, S):

| theme | renderer % | GPU % | Layout ms/s | RecalcStyle ms/s | recalcs/s | Task ms/s |
|---|---|---|---|---|---|---|
| sanctuary | 37.4 / 39.8 | 5.3 / 5.5 | 0 / 0 | 3.09 / 3.42 | 29.0 / 28.9 | 48.0 / 51.7 |
| classic | 41.4 / 42.7 | 5.9 / 6.0 | 0 / 0 | 3.72 / 3.91 | 29.3 / 28.7 | 55.1 / 54.2 |

- The Sanctuary premium is gone. Before, Sanctuary cost +6–8 renderer points and +2 GPU (45–47 % vs 38.9 %; 10.8
  vs 8.9 GPU). Now Sanctuary measures 2.9–4.0 points **below** Classic, with GPU −0.5. Both gaps are inside the
  audio-thread noise between windows.
- GPU is about half of the 05:32Z run on both themes (10.8 / 8.9 → 5.4 / 6.0). Either the meters are now
  compositor-only (`will-change`), or the window size differs.

Restored: nothing to restore (temp profile). The debug instance was quit, then the app was reopened with a plain
`open` on the real profile (no 9333).

## L-30 resolved (2026-09-30): menu-bar icon missing — macOS 26 per-bundle-id state

Symptom: the tray item existed (AX listed one unnamed 40×24 item) but macOS 26.4 drew it nowhere: tray.getBounds()
{x:0,y:0} (parked) or, after enabling System Settings › Menu Bar › "Allow in the Menu Bar", a frame under the clock
(x 1473) that the clock painted over. Other third-party icons rendered fine with 70 px free right of the notch, so
neither the notch nor the icon files (old and new both tested) were the cause. Matches exelban/stats#3120 ("stuck
per-bundle-ID state inside macOS Tahoe: the same binary renders fine with a different CFBundleIdentifier").
Fix: build.appId com.ryan.worshiprig → com.ryanmye.worshiprig; rebuilt; the item is drawn at x 904 immediately.
Side effects: a new row in Settings › Menu Bar, login-item registration to re-check. The trayHidden/trayShown toast
and Rig menu fallbacks (44ff0b9) stay: the parked case is real on this OS.
