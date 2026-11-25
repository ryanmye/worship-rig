# Shell and bridge client (2.0)

Owner: bridge-and-shell. Apple code is UNBUILT. Contract: `ENGINE_CONTRACT.md`, `engine-api.json`.

## Architecture

```
web UI (app/js, unchanged)  ->  controller  ->  engine object
                                                   |
                      Web engine (reference oracle) or BridgeEngine (app/js/engine-bridge)
                                                   |  BRIDGE v1 JSON, transport injected
                 webkit.messageHandlers.rig  <->  window.__rigNative.receive
                                                   |
                       Swift shell (RigHost) -> C API rig_post / rig_render / rig_midi_in -> native core
```

The shell is a `WKWebView` serving the app from `rig://app/` (`WKURLSchemeHandler`). A document-start user script
creates `__rigNative.queue`; the transport replays it on the first listener. Audio (AUHAL / RemoteIO) and CoreMIDI
sit in C and call the core directly, so the render callback never enters Swift.

## Module map (app/js/engine-bridge)

- `link.js`: `BridgeLink`, envelope, id correlation, per-op timeouts, stats, protocol-error reporting.
- `transports.js`: `webkitTransport`, `loopbackPair` (for tests).
- `clock.js`: `EngineClock`, tick-based `currentTime` capped at +0.25 s, never decreasing.
- `bridge-engine.js`: `BridgeEngine`, the whole 63-entry contract surface, local answers per contract 6.6, ctx,
  analyser and drone facades, batched `set`, meter subscription (30 Hz on read, 4 Hz after 2 s idle).
- `mock-native.js`: validates every message against `engine-api.json` and answers plausibly.
- `boot-mock.js`, `select.js`: engine selection. `select.js` uses the bridge over webkit, the mock with
  `?engine=bridge-mock`, otherwise the Web engine.

## App edit still needed (outside owned paths)

In `app/js/main.js` replace `import { AudioEngine } from './engine/index.js';` with
`import { AudioEngine } from './engine-bridge/select.js';`. It is the only engine import outside the engine folder.
Until then `RigSchemeHandler` patches `main.js` on the fly. Also decide `isElectron` / `rig.native`, and check CSP
`'self'` on the custom scheme.

## Tests

`node --test "test/unit/engine-bridge/*.test.mjs"`: 89 tests (surface 8, link 13, clock 10, meters 8, events 12,
validation 7, engine 23, transports 7). `node test/unit/engine-bridge/boot-smoke.mjs [--json --out --seconds
--headed]` (Playwright, not in run-all) boots the real UI against the mock using a copy of main.js: 10 s scripted
session, exit 0, boot about 2.1 s, 56 engine members touched, none outside the contract, none missing on the shim,
0 validation findings, 0 timeouts. Not touched by the UI session: drone.attachFiles, drone.files, latency, modWheel,
recordTap, reloadManifests, sleepBlockers, volumeCC (need MIDI, pads, recorder, My Samples).

## Contract gaps

- G1 (closed in SETUP_REVIEW): `when` is sent by setRouting, eqAudition, drone.setKey, drone.configure; song/config/drone
  ops now list it.
- G2 (closed in SETUP_REVIEW): `set` path/value are optional in the spec (required unless `batch` is given).
- G3: clickStart is sync in the contract (`{t0, downbeat}`); native cannot answer sync. Shim returns an estimate.
- G4: setClockSink(fn) has no port id but `config.midiClock.port` needs one. Shim sends `fn.portId ?? 'auto'`.
- G5 (shape settled; shim updated by Lane S, DECISIONS O-AW-4): `get sampleStatus {patches}` answers
  `{loaded: bool[], failed: bool[]}`, one entry per patch (ENGINE_CONTRACT §6.4 `get`). The core never emits
  `load{phase:'samples'}`, so the shim asks instead (`bridge-engine.js` `_refreshSampleStatus`): after every
  `cache preload` reply (before `preload()` resolves), after a `prepare` for samplers not yet known decoded (not
  delaying the token), and after `reloadManifests` for every sampler it knows. Each request sends one one-slot patch
  per distinct sampler id, so the answer is per instrument. One request is in flight at a time, and ids asked for
  meanwhile ride one follow-up. The `samples` event is still honoured (mock-native, a core that adds it later).
  Measured on `rig-devhost` (S-cue-go "Re-check"): at most one `get sampleStatus` per preload (fewer when
  preloads overlap: 5 for 7 while an 8-song set pinned), round trip ≤ 3.4 ms, `preload()` resolves 3–24 ms later.
  Known gap: a buffer the core evicts later still reads decoded until a preload names its sampler again.
- G6: 4 Hz idle tick equals the 0.25 s clock cap; shim raises the rate to 30 Hz on first meter read.
- G7: `hostLatency` is in the tick prose but not in engine-api.json. Shim honours it if present.
- G8: chatty traffic (play:input 24 for 6 note-ons; cache preload/estimate 11 each at boot). Dedupe later. Lane S
  (G5) adds at most one `get sampleStatus` per `cache preload` and per `prepare` with an unknown sampler: a warm
  switch costs 1 more request (1 preload + 1 sampleStatus), and pinning an 8-song set 5 more (for 7 preloads, 11
  estimates).
- G9: shim needs native to emit `state` before `load{start}` and before the `audio start` reply.
- G10: decided, see "Recording ownership" below. recorder.js still needs the JS `NativeRecorder` adapter (T09) and the
  core `rec` op (M17); until both exist, recording is unavailable under the bridge.
- G11: `get devices` is unused; the UI uses enumerateDevices. Needs edits in settings.js and latencyHint.js.
- G12: drone.attachFiles sends `path ?? url`.

## Later tasks (not started), mapped to window.rig (WEBKIT_AUDIT section 5)

- isElectron / platform flags.
- Recording stream: `rec` event plus a native recorder adapter.
- choosePadFolder, listPads.
- backupNow, latestBackup, importLatestBackup menu id.
- getInfo, openFolder, openUserSamplesFolder, revealFile.
- userSamplesDir, rescanUserSamples (and menu id).
- garageBandScan / garageBandImport (Mac only).
- onMenu ids: panic, fadeOutAll, nextSong, prevSong, toggleView, record, restartAudio, openSettings.
- bus: busPublish, onBusCommand, miniSubscribe, miniCommand; menu-bar mode; global hotkeys; update check.
- Web MIDI polyfill over the `midi` op/event (UI currently warns "MIDI unavailable").
- (done, unbuilt) Library migration: see "Library migration" below.

## Shell follow-up (SETUP_REVIEW 27, G10, memory, audio session). Everything below is UNBUILT.

### Web view recovery and external links (finding 27)

`RigNavigationDelegate` (Sources/Shared/RigNavigation.swift) is the web view's `navigationDelegate`.
- `decidePolicyFor`: `rig`, `about`, `blob`, `data` allowed; `http`, `https`, `mailto` open in the system browser
  (NSWorkspace / UIApplication) and are cancelled; anything else is cancelled and logged.
- `webViewWebContentProcessDidTerminate` -> `RigHost.webContentDidTerminate`: drop the event pump queue (it is
  addressed to the dead page), post `[{play panic}, {rec stop}]` to the core (the dead page can no longer release its
  held notes or stop its recording), then `webView.load(rig://app/index.html)` (`reload()` is unreliable with a nil
  `url`). The new page boots normally: `BridgeEngine` -> `hello` -> `state` -> `get state` -> the controller re-prepares
  and commits the current song from the library (localStorage lives in the data store, not the dead process).
  Three terminations inside 60 s show a static page with a Reload link instead of looping.
- Audio keeps running through the crash; only the UI is reloaded.

### Recording ownership (G10), decision

The native side owns recording end to end. JS never receives audio and never writes a file.
- Core `rec` op (M17): taps `out` (post ceiling, post sleep ramp; click only with `click.record`), a writer thread
  writes 16-bit stereo WAV at the device rate into `rig_config.recordings_dir`, refreshes the header every 1 s (a crash
  or jetsam leaves a playable file), names it `Rig YYYY-MM-DD HHmm.wav`.
- JS (`NativeRecorder`, T09) has the `recorder.js` public surface and only sends `rec {action:'start'|'stop'}` and
  reads `rec` events (`state`, `level`, `message`). It sends no `dir`; `filename` only if the user typed one.
- The shell chooses and creates the folder (`RigPaths.recordingsDir`, created at launch) and never touches the file.
  macOS `~/Music/Worship Rig/` (same folder the Electron app used). iPad `Documents/Recordings/`, visible in Files under
  On My iPad > Worship Rig because the iPad Info.plist sets `UIFileSharingEnabled` and
  `LSSupportsOpeningDocumentsInPlace`. Recordings are not excluded from iCloud/iTunes backup (big files: revisit).
- Lifecycle: page reload or crash stops the recording (shell posts `rec stop`); app termination relies on the 1 s header
  refresh. isElectron stays false under the shell, so `controller` takes the `recorder.start({sink:'opfs'})` branch
  until `NativeRecorder` is selected in recorder.js (a one-line app edit Ryan approves; SETUP_REVIEW 10).

### Library migration (Electron origin -> rig://app)

localStorage is per origin: Electron used `http://127.0.0.1:8438` (port can differ), the shell uses `rig://app`, so a
first launch looks empty. No app/js change is needed: `RigLibrary` (Sources/Shared/RigLibrary.swift) injects a minimal
`window.rig = {isElectron:false, platform, backupNow, latestBackup, onMenu}` at document start, backed by a
`WKScriptMessageHandlerWithReply` named `rigShell`. The existing controller paths then work unchanged:
`backupNow` (30 s debounce, tagged `{"origin":...}`), `importLatestBackup` (replace, current library backed up first),
the Settings "import latest backup" button.
- Own backups: `RigPaths.backupsDir` (macOS `~/Library/Application Support/Worship Rig Native/backups`, iPad
  `Documents/Backups`), same names and rotation as main.js (`rig-YYYYMMDD-HHMMSS[-n].json`, newest 3; `rig-unreadable-*`
  newest 5).
- macOS first launch: after the first `rig://` load, if no answer is recorded (UserDefaults
  `rig.electronImportAnswered.v1`) and a backup exists in any `~/Library/Application Support/*/backups/` (the Electron
  userData folder is named by the app, so scan, excluding our own folder; `RIG_ELECTRON_BACKUPS=<dir>` overrides), the
  shell waits for `__rig.store` and the controller's `onMenu` registration, checks `store.pristine === true`, and asks
  natively "Import your Worship Rig library?". Yes -> `latestBackup` serves the newest file once and the shell calls
  `__rigShell.menu('importLatestBackup')`, which `controller.onMenu` handles. The answer is stored either way.
- `latestBackup()` = a staged file (once) else the newest by mtime of our own backups and the Electron ones.
- iPad (no access to another app's files): Files picker (File > Import Library Backup..., Cmd-Shift-I, or the
  Settings button after a picker choice), or AirDrop / Files "Open in" of a `rig-*.json`
  (CFBundleDocumentTypes public.json,
  `.onOpenURL`) which asks to replace, then stages and imports. Get the file from the Mac's
  `~/Library/Application Support/<Worship Rig>/backups/` (newest `rig-*.json`) or Electron's Rig menu >
  Open Backups Folder.
- Caveat: the Electron backup is as fresh as its last write (every edit + 30 s, and window close). Quit the old app
  once before migrating. A pristine library is never backed up, so a never-edited Electron install has nothing
  to import.

### Memory pressure (SETUP_REVIEW 21a)

`RigLifecycle`: iPad `UIApplication.didReceiveMemoryWarning` -> `rig_host_memory_pressure(e, 1)`, a second warning
within 30 s -> level 2; macOS `DISPATCH_SOURCE_TYPE_MEMORYPRESSURE` warning/critical -> 1/2. The page also gets
`window` event `rig:memory {detail:{level}}` (nobody listens yet; the core's `warn` code `memory` already reaches JS).
The call is direct: the header declares it (T00b); an older core fails at link time with an undefined symbol.

### Audio session and routes (iPad)

`RigAudio`: category `.playback`, mode `.default`, not mixable (`RigAudio.mixWithOthers` flips it), preferred IO buffer
128 frames, `UIBackgroundModes: [audio]` in project.yml (no entitlements file entry; free Apple ID accepted).
- Interruption began: close the unit, `rig_host_audio_state(INTERRUPTED)`. Ended: reactivate and reopen regardless of
  `.shouldResume`, 3 quiet retries 0.5 s apart, then `CLOSED` with the error text (JS shows it, user taps restart).
- Route change (`newDeviceAvailable`, `oldDeviceUnavailable`, `override`): `rig_host_devices_changed` and a reopen so
  the core re-reads rate and latency. `categoryChange` ignored (self-inflicted). Unplugging headphones keeps playing
  on the speaker: open question whether it should pause. `mediaServicesWereReset`: close, reopen.
- `didBecomeActive`: reopen if the core wants sound and the unit is gone.
- `rig_host.audio_start` now returns immediately (`queue.async`, finding 25); completion through
  `rig_host_audio_started`.
- CoreAudio.framework dropped from the iPad target (macOS only); the iPad plist gains file sharing and document types.

### Needed from the core / contract (for the orchestrator)

1. `rec` op: use only `recordings_dir`; ignore or reject `dir` outside it (iPad has no other writable root), sanitise
   `filename`, create the folder if missing, `rec stop` with no recording returns `{path:null}` not an error, report a
   write failure as `rec {state:'error', message}`.
2. A repeated `hello` (page reload) must reset per-page state: meter/RTA subscriptions, `midi route`/learn, pending
   replies; and re-emit `state`, `load{instruments}`, `midi ports` and a `rec` event for a recording in progress
   (the shell stops recording on reload today, so the last is optional).
3. `get state` should include `rec:{state, path}`.
4. `rig_host_audio_state(INTERRUPTED)` followed by `rig_host_audio_started` with another sample rate (finding 16).
5. Not done here (other owners): finding 28 (JS posts `JSON.stringify`), finding 29 (tick coalescing while the scene is
   inactive), finding 30 (RigHost deinit), pads/`choosePadFolder`, `getInfo`, the real menu bar.
