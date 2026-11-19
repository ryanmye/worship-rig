# Worship Rig native shell (Apple) -- UNBUILT

Status: every Swift, C and YAML file here is UNBUILT and UNTESTED. It was written on Linux, with no Xcode, no
compiler for Apple frameworks and no device. Expect compile errors on first build. See `../docs/SHELL.md` for the
architecture and the later-task list.

## Layout

- `project.yml`: XcodeGen spec. Targets `WorshipRig-macOS` (macOS 14.5) and `WorshipRig-iPad` (iPadOS 17.5).
  The `app/` and `docs/` folders are bundled as resources. `RigCore.xcframework` comes from `scripts/build-core.sh`.
- `scripts/build-core.sh`: CMake build of `native/core` (target `rig_core`) for macOS arm64, iOS arm64 and an
  optional simulator slice, merged into `build/RigCore.xcframework`. Flags: `--mac-only`, `--sim`.
- `Sources/Shared/`: SwiftUI app, `WKWebView`, `rig://app/` scheme handler, `rig` script message handler, host
  vtable glue, audio and MIDI wrappers, bridging header.
- `Sources/Audio/`: C. AUHAL (macOS) and RemoteIO (iPad) render callbacks, device list, file decode, CoreMIDI UMP
  to bytes into `rig_midi_in`.
- `Sources/macOS`, `Sources/iPad`: empty, reserved for per-platform code.

## Untested (all of it)

Swift compile, C compile, XcodeGen output, the CMake cross builds, scheme handler and Range requests, CSP on the
custom scheme, localStorage persistence on `rig:`, the document-start script and `__rigNative.queue` replay,
audio device open and render, device-change handling, AVAudioSession, CoreMIDI hot-plug, ExtAudioFile decode,
the on-the-fly `main.js` patch, iPad signing.

## First build on a Mac

1. Xcode 15.4 or later. `brew install xcodegen cmake`.
2. `cd native/apple && ./scripts/build-core.sh --mac-only` (target `rig_core` must build).
3. `xcodegen`, open `WorshipRig.xcodeproj`, run scheme `WorshipRig-macOS`. Fix compile errors.
4. Check: page loads from `rig://app/`; CSP `'self'` matches the custom scheme (if not, name the scheme
   explicitly in the CSP); localStorage survives relaunch; the six themes render (nesting, `light-dark()`);
   `__rig.engine` is a `BridgeEngine`; the log shows `hello`; `audio start` then a key press makes sound.
5. Plug in a MIDI keyboard and check notes and the port list in Settings.

## iPad with a free Apple ID

1. Build the iOS slice: `./scripts/build-core.sh` (without `--mac-only`).
2. Xcode > Settings > Accounts: add the Apple ID. This creates a Personal Team.
3. Set `DEVELOPMENT_TEAM` for the `WorshipRig-iPad` target in `project.yml` (or pick the team in Signing), rerun
   `xcodegen`. If registration fails, change the bundle id prefix (`bundleIdPrefix`, `PRODUCT_BUNDLE_IDENTIFIER`).
4. Connect the iPad by cable, tap Trust. Enable Developer Mode (Settings > Privacy & Security > Developer Mode),
   then restart the iPad.
5. Choose the iPad as the run destination and run.
6. On the iPad: Settings > General > VPN & Device Management > trust the developer, then relaunch the app.
7. Free-account limits: the install expires after 7 days (rebuild and reinstall) and only a few apps are allowed.
