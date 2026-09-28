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
