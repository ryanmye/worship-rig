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
- G5: `get sampleStatus` shape is ambiguous. Shim relies on `load{phase:'samples', loaded:{id:bool}}` events.
- G6: 4 Hz idle tick equals the 0.25 s clock cap; shim raises the rate to 30 Hz on first meter read.
- G7: `hostLatency` is in the tick prose but not in engine-api.json. Shim honours it if present.
- G8: chatty traffic (play:input 24 for 6 note-ons; cache preload/estimate 11 each at boot). Dedupe later.
- G9: shim needs native to emit `state` before `load{start}` and before the `audio start` reply.
- G10: recorder.js is unavailable under the bridge until a native recorder adapter (`rec`) exists.
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
- Library migration from the Electron origin's localStorage.
