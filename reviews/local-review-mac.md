# Local review: macOS behaviour of the Electron shell

- Date: 2026-09-28 (22:00–23:00Z)
- Commit reviewed: `8c7d04f` on `main` (Electron/server code identical to the merge `d921d4d` of cloud snapshot
  20260928T215342Z). Fixes below are on top of it. Line numbers refer to `8c7d04f`.
- Machine: macOS 26.4 (Darwin 25.4.0, build 25E5207k), Apple Silicon, Electron 44.4.5, Node 25.2.0, electron-builder
  26.15.3. M-Audio Keystation 49es connected.
- Files: `main.js`, `preload.js`, `server.js`, `serve.mjs`, `Start Worship Rig.command`, `build/afterPack.js`,
  `package.json` `build`.
- Method: code reading, plus experiments. Every Electron launch used `RIG_PORT=8451` (8452/8453 for the collision
  runs) and a throw-away `RIG_USER_DATA` in the scratchpad, driven over CDP (`--remote-debugging-port=9451`), and was
  quit by SIGTERM (which goes through the normal `close` → `finishClose` path; see L-14). Nothing touched 8437/8438,
  the real library or `~/Music/Worship Rig`.
- Not possible from this shell: screenshots of native UI (no Screen Recording permission), reading or clicking
  native dialogs (no Accessibility permission), and real system sleep (it would have suspended the concurrent soak).

## Findings (most severe first)

### L-11: the Chrome version and the Mac app both play every note when both are open. CONFIRMED, FIXED `03c51d1`

- Severity: minor in likelihood, major if hit (every note doubled, a flanged sound, during a service).
- Where: `app/js/controller.js:1784` (`requestInstanceLock`, a Web Lock) is per origin *and* per browser. Chrome on
  `127.0.0.1:8437` and Electron on `127.0.0.1:8438` are different origins in different browsers, so neither sees the
  other. `main.js` never looked for the Chrome launcher's server, and `serve.mjs` never looked for the app's.
- Repro: `node serve.mjs --port 8453` + a Playwright Chromium page on it (MIDI granted), and
  `RIG_PORT=8451 npx electron .` at the same time.
- Observed: both report `{"instance":"primary","midi":"Keystation 49es Port 1","connected":true,"audio":"running"}`.
  CoreMIDI gives both the keyboard, so every key sounds twice.
- Expected: at least a warning.
- Fix (25 lines, owned files):
  - `main.js`: after the page loads, `chromeWindowCheck()` asks `127.0.0.1:8437/api/health` (`RIG_CHROME_PORT`
    overrides). If a Chrome window pinged it within 45 s (`clientSeenMsAgo`, the same rule `serve.mjs` uses for H2),
    it logs the fact and shows a warning sheet. The sheet names the Chrome window and its Terminal window. Skipped
    under `RIG_SELFTEST`.
  - `serve.mjs`: if the app's server answers on 8438 (`RIG_PORT` overrides), it prints a warning before opening
    Chrome.
- Verified after the fix: the same two-window setup with `RIG_CHROME_PORT=8453` logs
  `[worship-rig] a Worship Rig window is open in Chrome (port 8453): both would play every note; warning shown`. With
  no Chrome page open, nothing is logged. `RIG_PORT=8451 node serve.mjs --port 8454`, with the app on 8451, prints
  `Note: the Worship Rig Mac app is open too. Both windows play every note you play; quit one of them.`
- Test for the cloud to add (`test/phase1/shell/electron.boot.mjs`-style): start `createServer({port: P})`, hit
  `/api/heartbeat` once, launch Electron with `RIG_CHROME_PORT=P` (no SELFTEST, so the check runs), and assert the
  log line. For serve.mjs, spawn it with `RIG_PORT=<a running server's port>` and assert the stdout line.

### L-12: the traffic lights sit on the logo, and the window can't be dragged (ux-round2 G8). CONFIRMED, FIXED `5e2c7cb`

- Severity: minor (cosmetic, plus you can't move the window except by the keyboard or zoom).
- Where: `main.js:587` `titleBarStyle: 'hiddenInset'`. No CSS in `app/` sets `-webkit-app-region` or insets the top
  bar.
- Evidence:
  - A probe window with `hiddenInset` has `getContentBounds()` equal to `getBounds()` (1440×887). The page extends
    under the title-bar strip where macOS draws the traffic lights (x ≈ 12–80, y ≈ 12–30).
  - In the real app, `document.elementFromPoint` at (20,18) and (40,18) is `IMG.tb-logo` (box 14,14,28×28), and
    at (66,18) it is `SPAN.tb-name "Worship Rig"` (box 50,17,98×22).
  - 0 elements have a non-`none` app-region, so there is no drag area. Electron documents hidden title bars as
    non-draggable without one.
  - The overlap itself could not be screenshotted (only CDP page captures work here, and they don't include the
    window buttons).
- Fix (1 line, `main.js`): use the standard macOS title bar (drop `hiddenInset`). The window gets a normal title
  bar that can be dragged. The page loses its height: measured `innerHeight` 887 → 855 on this display, so the title
  bar is 32 px. That is still above `minHeight`. A selftest launch after the change had 0 console errors, 0 warnings
  and 0 HTTP errors. The logo is still at page (14,14), but page coordinates now start below the title bar, so the
  traffic lights no longer cover it.
- For the cloud: if G8's CSS fix lands (`.topbar { padding-left: 78px; -webkit-app-region: drag }` + `no-drag` on
  controls, gated on `rig.platform === 'darwin'`), restore `titleBarStyle: 'hiddenInset'` in `main.js` in the same
  change. Otherwise the padding would show under a normal title bar.

### L-13: README's Gatekeeper advice is out of date for macOS 15 and later. CONFIRMED, FIXED in README `c3a3178`

- Severity: minor (docs; it blocks a first launch on a second Mac).
- Where: `README.md` "First launch" (before this change): "right-click the app, choose Open".
- Repro: copy `dist/Worship Rig-0.1.0-arm64-mac.zip`, give it a Safari-style `com.apple.quarantine` xattr, then
  extract it with `ditto -x -k` (Archive Utility semantics).
- Observed:
  - The quarantine flag propagates to `Worship Rig.app`.
  - `codesign --verify --deep --strict` still passes, so the ad-hoc signature survives the zip.
  - `spctl --assess --type execute` gives `rejected`.
  - `syspolicy_check distribution` reports "Adhoc Signed App" and "Notary Ticket Missing (Fatal)".
- What the user sees: a valid but ad-hoc, un-notarized app gets "Apple could not verify 'Worship Rig' is free of
  malware", not "damaged". Since macOS 15, right-click → Open no longer offers an Open button for that dialog. The
  way through is System Settings → Privacy & Security → **Open Anyway**, or
  `xattr -dr com.apple.quarantine "/Applications/Worship Rig.app"`. "Damaged" appears only for a broken signature,
  for example a copy that lost its symlinks.
- Fix: README "Running on your Mac" → *First open on another Mac*. The old paragraph now points there.
- Not tested: clicking through the actual dialog (it needs Accessibility, and a quarantined launch would leave a modal
  on Ryan's screen).

### L-14: a page `window.close()` skips the close path; electron-full's quit uses it. CONFIRMED, not fixed (test gap)

- Severity: minor. No user path is affected today: nothing in `app/` calls `window.close()`. It is a coverage hole.
- Where: `main.js:642-661` (`win.on('close')` → `finishClose`: the recording confirm and the backup on close).
  `test/integration/electron-full.mjs:128` quits run 2 with `window.close()`.
- Repro (temp userData, port 8451, over CDP):
  1. Rename song 1, and 50 ms later call `window.close()`. The app exits and **no backup is written**. After a
     relaunch the rename is **gone**, both from localStorage and from any backup.
  2. Add a `pagehide` listener that does `localStorage.setItem('probe', …)`, wait 0.4 s, then `window.close()`. The
     debounced (300 ms) store save persisted, but the pagehide write did not (`null` after relaunch).
  3. The same probe quit with **SIGTERM** (the path of the red button, ⌘Q and logout): the pagehide write persists
     (`["1790633178857","hidden"]`), a backup `rig-*.json` appears whenever the library isn't pristine, and a rename
     made immediately before the SIGTERM survives. Four cycles, 4/4.
- Why: Electron handles a renderer `window.close()` as a close from the contents side. `BrowserWindow` emits no
  `close` event, so `finishClose` never runs. The process then exits (`window-all-closed` → `app.quit()` →
  `will-quit` → `app.exit(0)`) before Chromium commits storage writes made during unload. Adding
  `session.defaultSession.flushStorageData()` in `will-quit` did **not** save them (tested on a scratch copy of
  main.js), so it isn't a one-line main-side fix.
- Proposed:
  - (cloud, test) electron-full run 2 should quit through the real path: SIGTERM the Electron pid, or call
    `app.quit()` via a test hook. It should then assert that a `backups/rig-*.json` whose name field matches an edit
    made just before quitting exists, and that none is written for a pristine library.
  - (cloud, app) never add an in-page "Quit" that calls `window.close()`. Route it through a `rig.quit()` IPC to
    `app.quit()`.

### L-15: waking from sleep relies on the renderer watchdog only. SUSPECTED (sleep not exercised)

- Severity: minor.
- Where:
  - `main.js:23` doesn't use `powerMonitor` at all.
  - `main.js:833` holds `powerSaveBlocker.start('prevent-display-sleep')` for the app's whole lifetime.
  - `app/js/controller.js:1263-1295`: a 1 s `tick`. `suspended`/`interrupted` → `ctx.resume()`; three suspended
    ticks after it has run, or two ticks with a stuck `currentTime`, → `stalled` → an auto `restartAudio` (at most
    every 10 s). A running take is split into a new file (`controller.js:1307-1323`).
- Verified: `pmset -g assertions` while the app runs shows `NoDisplaySleepAssertion named: "Electron"` and
  `NoIdleSleepAssertion named: "Playing audio"`. So the Mac never idle-sleeps with the app open. Closing the lid
  (without an external display) or Apple menu → Sleep still sleeps it. App Nap is not an issue while audio plays.
- The suspected gap:
  - If the output device changes while asleep (a USB interface or Bluetooth speaker that re-enumerates), Chromium
    can keep the context `running` on a fallback sink with `currentTime` advancing. The watchdog then sees nothing
    wrong.
  - The `devicechange` listener (`controller.js:1875`) should catch that case, but a changed device isn't
    guaranteed to fire it.
  - The recording file itself is safe: the stream stays open, the sleep gap is simply absent from the audio (no
    silence is written), and the RIFF sizes are fixed at close.
- Proposed (needs a renderer hook, so cloud + local):
  - `powerMonitor.on('resume', () => sendMenu('checkAudio'))` in main.js (4 lines, local).
  - The controller treats `checkAudio` as "run `tick()` now, and if `engine.ctx.sinkId` no longer matches an
    enumerated device, `restartAudio()`" (cloud).
  - Until then, README item 9 of the manual check (sleep → wake → Restart audio if needed) is the test. Ryan
    should run it with the dock output and with the JBL.

### L-16: on a fallback port the library offer appears twice. CONFIRMED, not fixed (NIT)

- Where: `main.js:665,726-742` (a native sheet: "Port N is in use … Import Latest Backup / Continue") and
  `controller.js:1675-1690` + `app/js/main.js:404` (an in-page banner: "A newer song library is available … Use that
  library / Not now").
- Repro: hold `127.0.0.1:8451` with `nc -l 127.0.0.1 8451`, then launch with `RIG_PORT=8451` and a userData whose
  newest backup came from 8451.
- Observed:
  - Log: `port 8451 busy (not Worship Rig); using 8452` and `… (songs saved on 8451 will not appear; a dialog offers
    the latest backup)`.
  - The page is on `http://127.0.0.1:8452` with 19 factory songs, `pristine: true`, and a visible banner offering
    the 8451 backup.
  - The native sheet is shown by the same launch (code path). It could not be read here (no Accessibility).
- Also verified: quitting that pristine fallback library writes **no** backup (still 9 files), so round2-shell #2's
  fix holds on the Mac.
- Proposed: drop one of the two prompts. The banner is enough; the native sheet could keep only the explanation and
  a Continue button.

### L-17: every My Samples scan logs one line per pack found in both roots. CONFIRMED, not fixed (NIT)

- Where: `server.js:574` logs every `scanUserSamples` error. On this Mac the 28 packs exist in both
  `<repo>/user-samples` and `~/Music/Worship Rig/Samples` (L-9/PACKS copied them). A source run (`npm start`,
  `serve.mjs`) therefore prints 28 lines `a pack named "…" was already found in an earlier folder; skipped` on each
  scan.
- The same strings go into `/api/user-samples` → `errors` (a list of 28 "errors" in Settings, if it shows them).
- Not an issue for the built app, which has one root.
- Proposed: report a duplicate identical pack (same slug, same manifest size) once as a note, not an error. Or keep
  it out of `errors` and log a single summary line.

### L-18: ⌘W does nothing. CONFIRMED, intentional-looking, documented (NIT)

- Where: `main.js:534` `{ role: 'windowMenu' }`. On macOS Electron builds it as Minimize (⌘M) / Zoom / Bring All to
  Front, with **no Close**. There is no File menu on the Mac (`main.js:505-522`), so ⌘W has no binding.
- Probe: `Menu.buildFromTemplate([{role:'windowMenu'}])` gives
  `[["minimize","CommandOrControl+M"],["zoom",""],["",""],["front",""]]`.
- For a live rig this is the safer choice: closing the only window quits (`main.js:795`). It is now documented in
  README.
- If the cloud wants ⌘W, add `{ role: 'close' }` to the Window menu. The close path would then back up and ask while
  recording, as the red button does.

### L-19: Help → docs has a silent failure path, but .md opens fine on macOS 26. SUSPECTED for older macOS only (NIT)

- Where: `main.js:435-462`. `openReadme`/`openDoc` copy the doc to temp and call `shell.openPath`, and only log an
  error.
- Measured:
  - `shell.openPath` on a file type with no handler returns `"Failed to open path"`, and nothing appears.
  - On this Mac, `.md` resolves to `net.daringfireball.markdown`, which conforms to `public.plain-text` and is
    declared by the system (CoreTypes and Notes, besides Xcode). TextEdit and Notes are always candidates, so
    round2-shell #7 does not reproduce on macOS 26.
  - macOS 12–14 without Xcode was not checked.
- Proposed (about 5 lines, main.js; not done because it isn't confirmed): on an `openPath` error, call
  `shell.openExternal(\`${ourOrigin()}/docs/${n}.md\`)`. `server.js:655` already serves `/docs/*.md` as text/plain.

## Verified OK

- **Window security** (`main.js:588-596`): `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity` left at its default (true). The preload (`preload.js:15-71`) exposes only `window.rig` via
  `contextBridge`, and every IPC handler checks the sender frame's origin (`main.js:240-264`).
- **New windows and navigation** (`main.js:600-609`): `setWindowOpenHandler` always denies. `will-navigate` blocks
  every off-origin URL. Both pass only `^https?://` URLs to `shell.openExternal`, so `file:`, `javascript:` and
  custom schemes are never opened.
- **Permissions** (`main.js:553-574`):
  - Requests are allowed only for `midi`, `midiSysex`, `speaker-selection`, `fullscreen` and
    `clipboard-sanitized-write`, and only from our own origin. Checks also allow `media` for audio only.
  - First launch logged exactly one request (`perm request midiSysex http://127.0.0.1:8451/`), granted with no
    prompt, and denied checks for `background-sync` and `media`/video.
  - `getUserMedia` is never granted, so macOS never shows a microphone prompt.
  - Info.plist carries `NSMicrophoneUsageDescription` ("Worship Rig does not record the microphone; …") and
    `LSMinimumSystemVersion` 12.0 (`plutil -p`, `package.json:64-67`).
- **First launch with an empty userData** (`RIG_SELFTEST=1`, 20 s):
  - `consoleErrors 0, consoleWarnings 0, httpErrors 0`.
  - 19 factory songs seeded ("Sunday Pad + Piano", "Building Swell", "Prayer Wash", …) with `meta.edited: false`.
  - Audio `running` at 19.8 ms, MIDI connected to Keystation 49es Port 1.
  - No dialog; `portChanged: false`, `otherLibrary: null`.
  - Created: only Chromium's profile files (`Local Storage`, `Preferences`, caches …). No `backups/`, no
    `rig-shell.json` (written only when a pad folder is chosen, `main.js:336`), and no recordings folder.
- **File locations**:
  - `recordingsDir` = `app.getPath('music')/Worship Rig` (`main.js:55`).
  - `backupsDir` = `userData/backups` (`main.js:56`), with `rig-shell.json` in userData (`main.js:57`).
  - My Samples = `os.homedir()/Music/Worship Rig/Samples` (`server.js:232-248`); the repo root is skipped inside
    `app.asar` (`server.js:236`).
  - Chrome profile = `~/Library/Application Support/Worship Rig Chrome` (`serve.mjs:69`).
  - All are built with `path.join`/`app.getPath`/`os.homedir()`. `grep /Users/` over the seven files finds nothing.
  - userData is `~/Library/Application Support/Worship Rig` for both `npm start` and the built app (Electron takes
    `productName`), so they share backups and, on the same port, the same library.
- **Recordings folder** is created lazily: on the first recording (`main.js:291,296`), the save dialog (`:269`) or
  Help → Open Recordings Folder (`:540`). The first launch above created nothing.
- **Backups**:
  - One on every window close/quit (`main.js:693`), except for a pristine factory library (`controller.js:1846`,
    verified: none after two pristine quits, one after every edited one).
  - Rotation keeps the newest 10 by mtime (`main.js:198-201`). L-5's counter suffix is in place (`main.js:195-196`).
  - Every file starts with `{"origin":"http://127.0.0.1:<port>"`, and `newestBackup()` reads that for M5.
- **Single instance** (`main.js:65-74`): a second `npx electron .` with the same userData exited 0 in under 1 s,
  and the first kept its server on 8451. The lock is per userData, so test runs with a temp userData never collide
  with the real app. Note: if a *hung* instance holds the lock, a relaunch quits silently; Force Quit is the way out.
- **Port fallback** (`server.js:761-789`, `main.js:829`): with `127.0.0.1:8451` held, the app moved to 8452 and
  logged it, and the M5 flow ran (see L-16).
  - macOS quirk (benign): a program listening on the *wildcard* address (`nc -l 8451` → `*:8451`) is **not**
    detected, because Node sets `SO_REUSEADDR` and BSD lets `127.0.0.1:8451` bind over `*:8451`. The server
    reported `{"port":8451,"tried":[8451]}`. The app then gets all loopback traffic for that port and works
    normally.
  - A stale Worship Rig server after a crash can't happen: the server lives in the Electron main process. The only
    other holder is `serve.mjs`, on 8437.
- **Menus** (`main.js:482-546`):
  - App menu: About, Settings… ⌘, (`:512`), Hide/Hide Others/Show All, Quit ⌘Q.
  - Edit menu: standard roles.
  - Rig menu: Panic ⌘., Fade Out All ⌘⇧F, Next/Previous Song ⌘→/⌘← (renderer-handled, `registerAccelerator:
    false`), Perform/Edit ⌘E, Record ⌘R, Restart Audio, My Samples ×2, Import Latest Backup….
  - View menu: Toggle Full Screen, Reload Window (no accelerator, so ⌘R never reloads), Toggle DevTools ⌥⌘I.
  - Window menu: see L-18. Help menu: README, GarageBand doc, Recordings, Backups.
- **Quit paths**:
  - ⌘Q / red button / SIGTERM → `close` → `finishClose` (`main.js:678-696`): a recording confirm, a backup and
    streams closed → `window-all-closed` → `app.quit()` → `will-quit` closes the server and exits 0.
  - Port 8451 was free after every run. Recording while closing or reloading asks first (`main.js:626-641,
    682-691`).
- **Gatekeeper and signing**:
  - `build/afterPack.js:17` ad-hoc signs before zipping, and the final `dist/mac-arm64/Worship Rig.app` verifies
    (`codesign --verify --deep --strict`: valid on disk, satisfies its DR). `Signature=adhoc`,
    `Identifier=com.ryan.worshiprig`.
  - The zip preserves the signature (see L-13).
- **Background throttling** (`main.js:39-41,593-594`): background timer throttling and renderer backgrounding are
  both disabled, so a hidden or occluded window keeps its MIDI and timers.

## Summary

9 findings: L-11 … L-19. 3 fixed (L-11, L-12, L-13), 1 documented as intended (L-18), 5 proposed for the cloud or
for later (L-14, L-15, L-16, L-17, L-19). 13 checks verified OK.
