# NEXT-PLATFORMS: Windows 2.0 options (D27)

Status: research only, nothing built. Written 2026-11-26 for DECISIONS D27 ("Windows = same sound as the Mac: a
native shell around the 2.0 core"). It is the Windows half of the plan that D27 calls `NEXT-PLATFORMS.md`. Order
(D27): Mac/iPad 2.0 ships first, then iPhone, then Windows. Nothing here starts before then.

**Evidence tags:** **[V]** = checked this session against the linked source. **[R]** = checked in this repository
(file named). **[E]** = my estimate. **[U]** = from memory or inferred and not checked: verify before relying on it.

---

## 0. Summary

- **Recommendation: (a) a native C++ host with WebView2**, with the core linked in-process and built with
  **clang-cl**. Audio is WASAPI through the miniaudio host the devhost already has (`native/devhost/src/audio_host.cpp`
  implements the `rig_host` vtable), and MIDI is native (WinMM first). This is the Apple shell's design almost one to
  one: a custom `rig://app` scheme, a document-start script, a postMessage bridge, and audio and MIDI in C. The app
  would be about 90–110 MB installed **[E]**, against about 370 MB for Electron **[E]**.
- **Fallback: (b) Electron with the core as a Node-API addon.** It reuses the 1.x `main.js` (2078 lines, about 40
  `rig:*` IPC channels **[R]**), but the size is close to the Mac 1.x app's, and it keeps a second shell codebase
  alive that diverges from the Swift one.
- **Spike first, before any shell:** port `rig-devhost` to Windows. That means the core on clang-cl plus miniaudio
  WASAPI plus the real UI in Edge over the existing WebSocket transport. Day one gives Mac-identical sound on Windows,
  and it shows the compile and golden problems listed in §5.
- **No ASIO in Windows 2.0 (D38): WASAPI only.** Steinberg added a GPLv3 option to the ASIO SDK in October 2025
  **[V]**, but 2.0 is PolyForm Noncommercial 1.0.0, not GPL, so that option doesn't fit: a GPLv3 SDK can't be combined
  into a non-GPL app. Ryan (2026-11-28): "ship with wasapi for now, slot in asio if it turns out to not be good". So
  the Windows audio host keeps ASIO as a drop-in backend behind the same interface; whether it is needed is decided
  by a test on a real PC with Ryan's interface, and shipping it would then need Steinberg's proprietary licence,
  signed by Ryan.
- **Signing:** the cheapest clean routes are the Microsoft Store (free registration, and the Store signs MSIX for
  free) **[V]** or Azure Artifact Signing (about $9.99/month; individuals in the US and Canada only) **[V]**. Neither
  gives instant SmartScreen trust **[V]**. This is tier 1.
- **No Windows test machine exists** (BACKLOG "Windows / Linux" **[R]**). CI runners have no audio device, so latency,
  ASIO and MIDI hardware need a real PC. This is the biggest practical blocker.

---

## 1. Shell options

### 1.1 What the Apple shell is, and what carries over

The Apple shell is `native/apple/Sources`, 2962 lines including 466 lines of C audio and 570 lines of self-test
**[R]**. Each part maps to Windows like this:

| Apple part | (a) WebView2 C++ | (b) Electron + addon | (c) Tauri |
|---|---|---|---|
| `RigSchemeHandler` (`rig://app/`, main.js patched on the fly) | Custom scheme registration + `WebResourceRequested`; `rig://app` with `HasAuthorityComponent` + `TreatAsSecure` gives an http-like origin and a secure context **[V]** ([ICoreWebView2CustomSchemeRegistration](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2customschemeregistration)) | not needed: `server.js` on 127.0.0.1:8438 as in 1.x | `register_uri_scheme_protocol`; on Windows the origin is (I believe) `http(s)://<scheme>.localhost` **[U]** |
| document-start user script, `window.__rigNative` queue | `AddScriptToExecuteOnDocumentCreated` **[U: API name from memory]** | preload.js + contextBridge (exists) | Tauri init script |
| `webkit.messageHandlers.rig` ↔ `__rigNative.receive` | `chrome.webview.postMessage` / `PostWebMessageAsString` (new small `webview2Transport` in `engine-bridge/transports.js`) | ipcRenderer → main → addon `rig_post`; events by threadsafe function → `webContents.send` (2 hops) | Tauri `invoke` / events (Rust ↔ C FFI) |
| `WKScriptMessageHandlerWithReply` (`rigShell`: backups, latestBackup, onMenu) | postMessage with id correlation, or `AddHostObjectToScript` (COM, async proxies) **[U]** | exists in main.js (`rig:backupNow`, `rig:latestBackup`, …) **[R]** | Tauri commands |
| `RigNavigation` (external links, crash → panic + reload) | `NavigationStarting` / `NewWindowRequested` / `ProcessFailed` → same `[{play panic},{rec stop}]` + reload **[U: event names]** | exists (`render-process-gone`, `did-fail-load` handlers **[R]**) | partial (Rust side) |
| `rig_apple_audio.c` (AUHAL) | reuse devhost `audio_host.cpp` (miniaudio WASAPI) + later ASIO | the same C++ inside the addon | the same C++ over FFI |
| `RigMIDI.swift` (CoreMIDI → `rig_midi_in`, `rig_host_midi_ports`) | new C++: WinMM (later WinRT / Windows MIDI Services) | the same C++ in the addon | the same over FFI |
| `decode_file` (AAC/ALAC) | Media Foundation `IMFSourceReader` **[U]**, about 150 lines **[E]** | same | same |
| `RigLibrary` (backups, Electron-origin migration) | backups port directly; migration is mostly moot (1.x never shipped a Windows build, `package.json` is mac only **[R]**); import a Mac backup by file picker, as on the iPad | exists | new |
| `RigPaths` | Known Folders: Music\Worship Rig, %APPDATA%\Worship Rig | exists (needs Windows branches, BACKLOG **[R]**) | Tauri path API |
| `RigSelfTest` (`--self-test`, null audio) | port it: it lets CI launch the app on a Windows runner | exists (`RIG_SELFTEST=1`) **[R]** | new |
| tray / global hotkeys / login item / menu-bar mode | `Shell_NotifyIcon`, `RegisterHotKey`, Run key or MSIX StartupTask **[U]** | exists for macOS; needs Windows branches (BACKLOG **[R]**) | plugins: tray, global-shortcut, autostart **[U]** |

### 1.2 Comparison

| | (a) C++ + WebView2 | (b) Electron + Node-API addon | (c) Tauri 2 (Rust + WebView2) | (d) Qt 6 WebEngine |
|---|---|---|---|---|
| Sound = Mac (D27) | yes (same core) | yes (core in the addon, not Web Audio) | yes | yes |
| Audio-path latency | identical in all four: audio and MIDI stay native, the web view only carries control JSON | same | same | same |
| UI → core hop | 1 (postMessage) | 2 (renderer → main → addon) | 1 (IPC) + FFI | 1 (QWebChannel) |
| Web engine | system WebView2 = Chromium (Evergreen, preinstalled on Windows 11 **[V]** ([Evergreen vs Fixed](https://learn.microsoft.com/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version))) | bundled Chromium (Electron 44.4.5 in the repo **[R]**) | system WebView2 | bundled Chromium (QtWebEngine) |
| Installed size | ~10 MB exe/DLLs + app/ (samples ~79 MB) ≈ 90–110 MB **[E]** | Electron ~283 MB (the Linux `dist/` here **[R]**; Windows similar **[U]**) + 79 + addon ≈ 370 MB **[E]** | ~10–15 MB + app/ ≈ 95–115 MB **[E]**; +~180 MB if the WebView2 runtime is pinned ("fixedVersion") **[V]** ([Tauri Windows installer](https://v2.tauri.app/distribute/windows-installer/)) | ~150–250 MB **[E]** |
| 500 MB rule | wide headroom | fits, ~130 MB headroom **[E]** | wide headroom | fits |
| Language | C++ (same as core); COM/WRL boilerplate | JS (exists) + C++ addon (node-addon-api / cmake-js) | Rust (new language for the repo) | C++ / Qt (new framework) |
| Licence fit (was GPL-3.0-only; now PolyForm NC, D38: permissive deps only) | WebView2 SDK reported BSD-3-Clause **[V: per an IP review, not the file]** ([Eclipse IP issue](https://gitlab.eclipse.org/eclipsefdn/emo-team/iplab/-/issues/14072)); the runtime is an OS component | MIT | MIT / Apache-2.0 **[U]** | LGPL-3 / GPL-3: was fine under GPL, **does not fit PolyForm** (D38; Qt would need a commercial licence or LGPL dynamic linking) **[U]** |
| Reuse of 1.x shell features | low: re-implement `window.rig` (as Swift did) | **high**: main.js, server.js, hotkeys, tray, update check | low | low |
| Reuse of the 2.0 Apple design | **high** (same scheme, transport and C host) | medium (the core and C host carry over; the shell does not) | high (same design, in Rust) | medium |
| Auto-update | DIY: WinSparkle **[U]** or MSIX App Installer / Store | electron-updater (needs signing) | built-in updater plugin (signed manifests) **[U]** | DIY |
| WebView2 version drift | Evergreen updates under you, so the UI must survive Chromium updates (it already runs in Chrome and in devhost) | pinned per release | same as (a) | pinned |
| Maintenance | a third shell (Swift, C++ Win, + 1.x Electron until retired); small | keeps Electron alive on Windows only; main.js has macOS-only branches to split | adds a Rust toolchain + Tauri major-version churn (bundler 2.10.6, 2026-11-18 **[V]**, [releases](https://v2.tauri.app/release/tauri-bundler/all-versions/)) | heavy framework for a thin shell |
| Risk | WebView2 C++ API learning curve; `WebResourceRequested` runs on the UI thread and is "slower than other approaches" **[V]** ([local content](https://learn.microsoft.com/microsoft-edge/webview2/concepts/working-with-local-content)) | audio thread in the Electron main process (a main-process crash kills sound); ABI rebuilds are mitigated by Node-API | custom-scheme origin and IPC quirks on Windows **[U]**; Rust FFI to a C API is easy (bindgen) | build complexity, size |
| Effort to MVP **[E]** | 2–4 weeks | 1.5–3 weeks | 3–5 weeks | 4–6 weeks |
| Effort to parity **[E]** | +4–7 weeks | +2–4 weeks (main.js Windows branches) | +5–8 weeks | +5–8 weeks |

Notes:
- **(a) Serving app/**: until the one-line `main.js` swap lands in `app/` (SHELL.md "App edit still needed" **[R]**),
  the host must patch `main.js`, so at least `js/main.js` goes through `WebResourceRequested`. Once it lands, static
  files could use `SetVirtualHostNameToFolderMapping` (served in the WebView2 process, faster), with
  `WebResourceRequested` only for `/api/*` (My Samples, pads, patch packs). The catch is that a virtual host gives an
  `https://<name>` origin instead of `rig://app` **[V]**. Either origin is new on Windows, so localStorage migration
  does not depend on the choice.
- **(a) Custom-scheme POSTs**: "POST requests always contain an Origin header, therefore AllowedOrigins must be set
  even for same origin POST requests" **[V]** (the custom-scheme page above). Set `AllowedOrigins = ["rig://app"]`.
- **(b) Bridge**: the addon owns the miniaudio device and the MIDI ports itself. Do not use Web MIDI or Web Audio in
  the renderer. Electron's `server.js` still serves app/, so `select.js` needs an Electron-bridge transport and the
  `isElectron` paths stay as in 1.x.
- **(d) Other options**, briefly:
  - **Qt WebEngine**: works, but brings a Chromium-sized framework for a thin shell.
  - **CEF**: Electron's size, without Electron's tooling.
  - **The devhost + the system browser** (1.x `npm run serve` style): this is the spike vehicle in §6, not a
    product. The core stays a separate process, there is no app identity, and the browser can be closed.

---

## 2. Audio

### 2.1 WASAPI

| Mode | What it is | Latency | Catch |
|---|---|---|---|
| Shared, default | the audio engine mixes all apps | "By default all applications in Windows 10 and later will use 10-ms buffers" **[V]**; engine latency "reduced to 1.3 ms" on Windows 10+ **[V]** ([low-latency audio](https://learn.microsoft.com/en-sg/WINDOWS-HARDWARE/DRIVERS/audio/low-latency-audio)). Output total ≈ 15–25 ms **[E]** | fine for pads, sluggish for piano |
| Shared, low-latency (`IAudioClient3::InitializeSharedAudioStream`, Windows 10+) | period chosen from `GetSharedModeEnginePeriod` min/fundamental/max **[V]** ([API](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient3-initializesharedaudiostream)) | inbox HDAudio "128 samples (2.66ms@48kHz)" to 480 **[V]** | needs drivers that declare small buffers ("up to the OEMs") **[V]**; one app's small period applies to the whole endpoint **[V]**; USB class-driver behaviour **[U]** |
| Exclusive | bypasses the engine, straight to the driver buffer **[V]** | typically 3–5 ms periods on good hardware **[E/U]** | "no other application can use that endpoint" **[V]**: ProPresenter, click tracks and videos on the same interface go silent. A trade-off in a worship booth. |

**miniaudio (vendored 0.11.22 in `native/devhost/third_party` **[R]**):**
- It has WASAPI shared and exclusive (`shareMode`) **[R]**.
- It uses `IAudioClient3` low-latency shared mode **only when `wasapi.noAutoConvertSRC = true`**, because the call
  fails with `AUTOCONVERTPCM` (miniaudio.h §15.1 **[R]**). The core adopts the device rate (contract 6.3), so setting
  `noAutoConvertSRC` costs nothing.
- `ma_wasapi_usage_pro_audio` provides the MMCSS "Pro Audio" thread class **[R]**.
- miniaudio has **no ASIO backend** **[R/U]**.
- Buffer sizes: the D2 sizes (64/128/256/512) are requests. The host reports what it got. `rig_render` accepts any
  frame count, and longer callbacks are split (`audio_host.cpp` **[R]**).
- Host clock: `rig_host.host_time_ns` says "mach_absolute_time in ns" **[R]**. On Windows use QPC in ns, the same
  timebase that WASAPI `IAudioClock` and Windows MIDI Services timestamps use **[U]**.

### 2.2 ASIO

> **D38 (2026-11-28): Windows 2.0 ships WASAPI only, no ASIO.** 2.0's code is PolyForm Noncommercial 1.0.0, so the
> SDK's GPLv3 option below can't be used (GPLv3 code can only go into a GPL program). The only route left is
> Steinberg's proprietary agreement, which Ryan would have to sign. Design the audio host so ASIO can slot in later
> behind the same interface; a real-PC test with Ryan's interface decides whether it's needed ("ship with wasapi for
> now, slot in asio if it turns out to not be good", Ryan). The research below is kept for that decision; its
> "Compatibility with GPL-3.0-only" paragraph no longer applies.

- **Licence, current state [V]:**
  - In October 2025 Steinberg made ASIO dual-licensed, proprietary or GPLv3 ([CDM](https://cdm.link/open-steinberg-vst3-and-asio/), [heise](https://heise.de/-10963451), [Libre Arts](https://librearts.org/2025/11/steinberg-relicenses-vst3-and-asio/), [Wikipedia](https://en.wikipedia.org/wiki/Audio_Stream_Input/Output)).
  - The move was tied to an OBS partnership. VST3 3.8 went MIT at the same time.
  - Before that, the SDK was available only under a signed proprietary agreement **[V: Wikipedia]**. That is the
    known GPL problem: GPL apps such as Audacity could not distribute ASIO builds **[U: history]**.
- **SDK 2.3.4** carries "Dual license: Proprietary Agreement and GPLv3", per a mirror's README
  ([Codeberg mirror](https://codeberg.org/rubiefawn/asiosdk)) **[V: mirror, not steinberg.net]**. The mirror also
  says:
  - the ASIO name and logo are optional under GPLv3, but if used they must follow Steinberg's usage guidelines;
  - "ASIO" may not appear in the product name.
- **Compatibility with GPL-3.0-only (superseded by D38, kept for the record):** the sources say "GPLv3" or "GPLv3+", inconsistently. Both "GPL-3.0-only" and
  "GPL-3.0-or-later" code can be combined into a GPL-3.0-only program, so either reading works. **To verify (tier 1,
  "a licence doubt"):** read LICENSE.txt in the official SDK zip, check that it is the full GPLv3 with no additional
  restrictions, and record it in `LICENSES.md`. Some sources still repeat the older "a proprietary SDK licence
  agreement has to be signed", so do not rely on secondary sources.
- **Implementation:** use the SDK's host code (`asio.cpp`, `asiodrivers.cpp`, COM driver loading) directly, about
  600–900 lines of host glue **[E]**. RtAudio or PortAudio also wrap ASIO **[U]**. JUCE does not fit (AGPL or
  commercial) **[U]**.
- **ASIO specifics:**
  - The driver owns the buffer size (set in its control panel) and the sample rate, and the core adopts both.
  - Some drivers force non-power-of-two sizes; the core handles any size.
  - Usually one ASIO device at a time.
- **Universal ASIO drivers:**
  - **FlexASIO** is a universal ASIO driver over PortAudio (WASAPI shared/exclusive, KS, DirectSound, MME), with a
    20 ms default buffer **[V]** ([GitHub](https://github.com/dechamps/FlexASIO)). Licence not confirmed on the page
    **[U]**.
  - **ASIO4ALL** is closed freeware "on top of any device's existing WDM driver" **[V]**
    ([SOS](https://www.soundonsound.com/techniques/optimising-latency-pc-audio-interface)).
  - **Both only help an app that is an ASIO host.** They do not replace WASAPI for us. They are relevant only if we
    ship ASIO and a user's interface has no vendor driver.
- **What worship and live keys users expect [V, partly old sources]:**
  - On Windows, ASIO is the standard advice for live soft synths ([Sound On Sound](https://www.soundonsound.com/techniques/optimising-latency-pc-audio-interface), 2005).
  - About 6 ms is acceptable "to even the fussiest pianists", and pads tolerate far more.
  - Live users note that "the most important part is less the hardware and more the custom Windows driver", and
    most people notice latency from around 10 ms ([Cantabile forum](https://community.cantabilesoftware.com/t/audio-interface-recommendation/11043)).
  - Focusrite and RME interfaces, with their vendor ASIO drivers, are common **[V: same thread]**.
  - Windows live hosts (Cantabile, Gig Performer, Ableton) all offer ASIO **[U]**.
  - Conclusion **[E]**: WASAPI is acceptable for a first release (pads and keys at 128–256 frames on a decent
    interface). Without ASIO, users with Focusrite or RME interfaces will see the app as incomplete.

**Recommended audio plan:**
1. Spike/MVP: WASAPI shared low-latency (`noAutoConvertSRC`, Pro Audio MMCSS).
2. Add exclusive mode as a Settings option with a warning ("other apps go silent").
3. ~~Parity: an ASIO host behind a device-type picker~~. Not in Windows 2.0 (D38). Keep the host interface ready for
   it; if the real-PC test with Ryan's interface says WASAPI isn't good enough and Ryan signs Steinberg's proprietary
   licence, ASIO slots in behind a device-type picker.

---

## 3. MIDI

| API | Multi-client | BLE MIDI | Timestamps | Status |
|---|---|---|---|---|
| WinMM (`midiIn*`) | classic stack: one app per port **[U]**; under Windows MIDI Services every port is multi-client "regardless of the driver or API used" **[V]** | no **[U]** | 1 ms (`MIM_DATA` dwParam2) **[U]** | everywhere, incl. Windows 10; the classic stack has a 10-driver limit ([devblog index](https://devblogs.microsoft.com/windows-music-dev): "Windows MIDI Services and the 10-MIDI driver limit", Nov 2025) **[V: title only]** |
| WinRT `Windows.Devices.Midi` | classic: as WinMM **[U]** | yes, since Windows 10 1607 **[U]** | QPC-based **[U]** | C++/WinRT from a desktop app; device names now match WinMM under the new stack **[V]** |
| Windows MIDI Services (new stack + App SDK) | yes; MIDI 1.0 + 2.0, loopback endpoints, timestamps "accurate to under a microsecond", scheduled send **[V]** ([Windows blog, 2026-02-17](https://blogs.windows.com/windowsexperience/2026/02/17/making-music-with-midi-just-got-a-real-boost-in-windows-11/)) | **not shipped**: "on the backlog" (Feb 2026) **[V]**; "We will eventually have a first-class BLE MIDI 1.0 transport" (Apr 2026) **[V]** ([known issues](https://devblogs.microsoft.com/windows-music-dev/windows-midi-services-rollout-known-issues-and-workarounds)); the SDK reference already has a Bluetooth transport manager (MIDI 1.0 + 2.0) **[V]** ([SDK ref](https://microsoft.github.io/MIDI/sdk-reference/Transports/Bluetooth/MidiBluetoothTransportManager/)) | sub-µs | in-box on Windows 11 24H2 / 25H2 / 26H1 by controlled feature rollout **[V]**; App SDK runtime "in the coming months" as of Feb 2026, preview by `winget install Microsoft.WindowsMIDIServicesSDK` **[V]**; a "revert back to the old MIDI stack" option from end of June 2026 **[V]**; current SDK GA state **not verified** |

- **Recommendation:**
  - Native MIDI into the core, as on the Mac (`rig_midi_in`, `rig_host_midi_ports`, `midi_send` for clock out).
  - **WinMM first.** It works on every machine, and Windows 11 with the new stack makes it multi-client for free.
  - Use `midiConnect`-free plain input. Rebuild the port list on `WM_DEVICECHANGE` **[U]**.
  - Later: Windows MIDI Services SDK for µs timestamps and scheduled clock out, once its runtime is GA, with WinMM as
    the fallback.
  - BLE: via WinRT, or the Korg BLE driver (which the known-issues page names as the stopgap **[V]**), until the
    native transport ships.
- **Windows 10 (end of support Oct 2025 **[U: from memory]**, still common on church PCs):**
  - WinMM is single-client there, so if another app (ProPresenter, a DAW) holds the keyboard, we cannot open it.
  - Show this as a clear "port busy" message, not a silent failure.
- **Web MIDI in WebView2:**
  - It exists. `CoreWebView2PermissionKind.MidiSystemExclusiveMessages` (= `MidiSystemExclusiveMessageAccess`, 11) is
    raised when Web MIDI asks for SysEx **[V]** ([enum](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2permissionkind)).
  - Chrome gates all Web MIDI behind a prompt "starting in Chrome 124" **[V]** ([Chrome blog](https://developer.chrome.com/blog/web-midi-permission-prompt?hl=en)).
    How WebView2 reports a non-SysEx request is **not documented [U]**. Handle `PermissionRequested` for the
    `rig://app` origin only, as Electron's main.js does for `midi` / `midiSysex` (CLAUDE.md caveat **[R]**).
  - Chromium's Windows Web MIDI backend is WinMM by default, with WinRT behind a flag **[U]**.
  - **Do not play through Web MIDI.** Native MIDI keeps playing while the page reloads or crashes (SHELL.md: "Audio
    keeps running through the crash" **[R]**) and avoids the renderer hop. The Apple shell does the same: the UI's
    Web MIDI path is unused under the bridge, and SHELL.md lists a "Web MIDI polyfill over the `midi` op/event" as a
    later task **[R]**.

---

## 4. Distribution

### 4.1 Installer

| Format | Pros | Cons | Fits |
|---|---|---|---|
| **MSIX** | Microsoft Store signs it for free **[V]**; clean install and uninstall; App Installer or Store updates; StartupTask for login | packaged-app file-system virtualization of AppData **[U]**: write the library and backups to known folders and test it; a sideloaded MSIX still needs a trusted signature | (a), (c); (b) works too (electron-builder appx **[U]**) |
| **NSIS** (`-setup.exe`) | electron-builder's default; Tauri cross-builds it **[V]** | you sign it; DIY updater | (b), (c) |
| **MSI (WiX)** | enterprise / GPO-friendly; Tauri builds it on Windows only **[V]** | heavier tooling | (a), (c) |
| **Inno Setup** | simplest script installer, free **[U]** | you sign it; DIY updater | (a) |
| Portable zip | spike and beta testers | SmartScreen and Mark-of-the-Web prompts; no Start menu entry | spike |

**WebView2 runtime:**
- Preinstalled on Windows 11, and pushed to "eligible" Windows 10 devices.
- Microsoft still recommends shipping the runtime installer for edge cases **[V]** (Evergreen page above).
- Tauri's options: download bootstrapper (0 MB), embedded bootstrapper (~1.8 MB), offline installer (~127 MB),
  fixed runtime (~180 MB) **[V]**.
- Recommendation: Evergreen + embedded bootstrapper **[E]**.

### 4.2 Code signing and SmartScreen

| Route | Cost | Notes |
|---|---|---|
| **Microsoft Store (MSIX)** | free: individual registration has had no fee since 2025-09-10 **[V]** ([Windows blog](https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/)); company accounts free too **[V]** ([sign-up](https://learn.microsoft.com/en-us/windows/apps/get-started/sign-up)) | "Microsoft re-signs the package after certification" **[V]** ([code-signing options](https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options)); government ID + selfie verification; publishes under Ryan's name; Store review per release; Store-signed MSIX is Store-only (a GitHub download still needs its own signature) |
| **Azure Artifact Signing** (formerly Trusted Signing) | "Approximately $9.99/month" **[V]**; Basic tier 5,000 signatures/month, Premium 100,000 **[V]** ([pricing](https://azure.microsoft.com/en-us/pricing/details/trusted-signing/); the prices themselves were blank on the page) | "Individual developers are currently limited to the USA and Canada" **[V]**; no hardware token; identity check "a few business days"; publisher shown = verified legal name; billing starts at account creation and is not prorated **[V]** |
| OV certificate | "$150–300/year" **[V]**; key on an HSM or token since June 2023 **[V]**; max validity **460 days from 2026-03-01** **[V]** ([CA/B Forum CSC-31](https://cabforum.org/2025/11/17/ballot-csc-31-maximum-validity-reduction)) | CI signing needs a cloud HSM product (extra cost **[U]**) |
| EV certificate | "$400+/year" **[V]** | the instant-SmartScreen bypass "was removed in 2024" and EV now builds reputation like OV, so "no longer justified" **[V]** |
| SignPath Foundation | free for qualifying OSS **[V: mentioned by Microsoft]** | eligibility, and their name on the signature **[U]**; likely needs an OSI licence, which PolyForm NC is not (D38) **[U]** |
| Unsigned | 0 | "Strong SmartScreen block; enterprises may block entirely" **[V]**: not viable beyond a beta |

- **SmartScreen:** no route gives instant trust. Reputation builds over releases signed with a consistent identity
  **[V]**.
- **Licence and the Store [U]:** 2.0 is PolyForm Noncommercial (D38) and Ryan is its only copyright holder (the
  vendored core code is permissive), so Store distribution is his call (D28 chose the website anyway). The CC BY-SA samples (Musyng Kite) keep their attribution in About and
  `LICENSES.md`. Check the current Store policy text before submitting.

### 4.3 Auto-update

| Option | Fits |
|---|---|
| Today's 1.x model: check GitHub Releases daily and show "Version x.y.z available — Download" (`update-check.js` **[R]**; pure, injectable) | all; the zero-cost MVP |
| MSIX via Store, or an `.appinstaller` file on GitHub | (a)/(c) with MSIX |
| WinSparkle (Sparkle-style appcast, EdDSA-signed) **[U]** | (a) with NSIS / Inno / MSI |
| electron-updater (NSIS, needs signing) | (b) |
| Tauri updater plugin (signed update manifest) **[U]** | (c) |

### 4.4 CI build and sign on GitHub Actions

- **Runners:** `windows-latest` / `windows-2025` moved to **Visual Studio 2026** by 2026-06-15. `windows-2022` keeps
  VS 2022 **[V]** ([GitHub changelog](https://github.blog/changelog/2026-05-14-github-actions-upcoming-image-migrations)).
- **Signing:** `azure/artifact-signing-action@v2` runs on windows-2025 / windows-2022 only (no Windows Arm runners),
  with OIDC recommended **[V]** ([action](https://github.com/Azure/artifact-signing-action)). The page shows exe,
  dll and msix examples. MSI is not mentioned.
- **The repo's rules:**
  - Releases, tags, Store submissions and signing-account creation are **tier 1** (AWAY_WEEK_PLAN §1 **[R]**).
  - CI may build unsigned artifacts. A signing step runs only on a release workflow that Ryan triggers.
  - The secrets (Azure tenant/client ids, OIDC federation) are set up by Ryan.

---

## 5. CI: a Windows build-test job for native/core

### 5.1 What exists

`.github/workflows/native-core.yml` **[R]** has these jobs:
- `goldens` (ubuntu): renders the Chromium goldens and uploads them as an artifact.
- `build-test`: matrix `[ubuntu-latest, macos-15]`, `cmake --preset release`, Ninja, ctest.
- `sanitizers`: ASan/UBSan and TSan on Linux.
- `mac-check`.

The golden comparison is `tools/golden/compare.mjs` with per-fixture manifest tolerances (exact tier, etc.) **[R]**.
The **cross-compiler byte-identity** ("g++ = clang-20 byte-identical 112/112", BUILD_PLAN **[R]**) is an integrator
practice, not a CI gate today.

### 5.2 Compiler choice

**Use clang-cl as the gating Windows compiler. MSVC `cl` is non-blocking later, if at all.**

Why:
1. g++ and clang are already byte-identical, so clang-cl (the same optimizer and frontend semantics) is the shortest
   path to Windows renders that are identical too.
2. The MSVC STL and UCRT are a new variable in either case.
3. `cl` hits concrete blockers in today's tree (below).

clang-cl and cl objects link together, so the shell can be built with either.

### 5.3 Concrete issues found in the tree [R], to fix in the spike

| # | Where | Problem on Windows | Fix |
|---|---|---|---|
| W1 | `cmake/RigWarnings.cmake`, third-party flags in `CMakeLists.txt` | `CMAKE_CXX_COMPILER_ID MATCHES "GNU\|Clang"` is true for clang-cl, so GNU flags are passed. In clang-cl **`-Wall` = `-Weverything`** (a 2021 patch to change this was abandoned **[V]**, [D114651](https://reviews.llvm.org/D114651); LLVM's own CMake switched to `/W4` for this reason **[V]**, [r319330](https://lists.llvm.org/pipermail/llvm-commits/Week-of-Mon-20171127/505915.html)). With `-Werror` the build fails at once. | branch on `CMAKE_CXX_COMPILER_FRONTEND_VARIANT STREQUAL "MSVC"`: `/W4 /WX` + `/clang:-ffp-contract=off /clang:-fno-finite-math-only` (clang's default is `-ffp-contract=on` **[U]**, so it must stay off) |
| W2 | `src/num/num.cmake` | `COMPILE_OPTIONS "-isystem;…llvm_libc"`: `cl` rejects it; clang-cl probably wants `/external:I` or `-imsvc` **[U]** | per-frontend branch |
| W3 | `src/inst/catalogue.cmake` → `inst_catalogue.inc` | one **60,852-byte** raw string literal (measured in `build-int/generated`). `cl` limit: "a string can't be longer than 16380 single-byte characters" before concatenation **[V]** ([C2026](https://learn.microsoft.com/en-us/cpp/error-messages/compiler-errors-1/compiler-error-c2026)); concatenated totals near 64 KB also fail **[U]**. clang-cl is fine. | emit adjacent chunks ≤ 16 KB, or a `const char[]` byte array |
| W4 | `src/click/click_math.h` | `__builtin_inf()`: `cl` does not have it **[U]** | `std::numeric_limits<double>::infinity()` |
| W5 | `fopen` (wav.cpp, rec.cpp, decode.cpp, manifest.cpp) | `cl /W4 /WX` raises C4996 (deprecated "unsafe" CRT) **[U]** | `_CRT_SECURE_NO_WARNINGS` |
| W6 | `std::fopen(std::string)`, `std::filesystem::path(std::string)` | Windows treats narrow strings as the ANSI code page, so non-ASCII paths break (e.g. `C:\Users\José\Music`) **[U]** | app manifest `activeCodePage=UTF-8` (Windows 10 1903+) for the app **and** `rig_tests.exe`, or `_wfopen` / `u8path` at the IO boundary |
| W7 | `src/runtime/rt_guard.h` | FTZ/DAZ: the x64 path (`_M_X64`) is fine. Windows **ARM64** under `cl` has neither `__aarch64__` nor GNU inline asm, so no flush-to-zero (denormal CPU spikes) | `_M_ARM64` + `_ReadStatusReg` / `_WriteStatusReg` **[U]**, or build ARM64 with clang-cl |
| W8 | `model/build_worker.cpp`, `samples/decode_pool.cpp` | thread QoS only for `__APPLE__` / `__linux__` (compiles; default priority) | `THREAD_MODE_BACKGROUND_BEGIN` or `THREAD_PRIORITY_BELOW_NORMAL` |
| W9 | `native/devhost/src/server.cpp` | `poll.h`, `sys/socket.h`, `pipe()` | `WSAPoll` + a loopback socket pair for the wake fd (spike only) |
| W10 | `js_pow.cpp` / `js_tanh.cpp` use `std::fma` | UCRT `fma` must be correctly rounded; it is slow without `/arch:AVX2`, and old MSVC CRTs had bugs **[U]** | `unit.num_math` is bit-exact on every case; run it first |
| W11 | ordering | the MSVC STL's `unordered_map` iteration and `std::sort` tie order differ from libstdc++. `time/coalescer.h` iterates an `unordered_map` (control path) | goldens + byte-compare will show it; no known parity-path use **[E]** |

Already fine **[R]**:
- `/fp:precise` is in the MSVC branch, and VS2022 17.0+ makes `/fp:precise` contraction-free by default **[V]**
  ([MSVC blog](https://devblogs.microsoft.com/cppblog/the-fpcontract-flag-and-changes-to-fp-modes-in-vs2022/)).
- No `long double` outside the vendored libc.
- The parity paths avoid `<cmath>` transcendentals (`src/num/README.md`). The only `std::pow` / `std::exp` /
  `std::cos` uses are `Param::valueAt` (diagnostics) and the meter window.
- `rig_engine.h` already has `_WIN32` `RIG_API` export macros, and `rec.cpp` already uses `localtime_s`.

### 5.4 Float-difference risks for the golden gate

- Goldens come from Chromium on x86-64 Linux, glibc 2.39, with an FMA CPU (`src/num/README.md` **[R]**). The port
  reproduces them with its own libm, so the platform libm does not matter on parity paths. That is the main
  protection against UCRT differences.
- The remaining risks are compiler transformations (contraction, reassociation, vectorization) and library ordering.
  clang-cl with `-ffp-contract=off` matches the Linux clang build. `cl /fp:precise` forbids reassociation and, since
  17.0, contraction **[V]**, but its vectorizer and the order it evaluates arguments in can differ **[U]**. The
  existing g++ = clang identity is good evidence that the code does not depend on argument order.
- pffft takes the SSE path on x64 under both compilers. Windows ARM64 takes the NEON path, which the macOS arm64 CI
  job already covers within tolerance.

### 5.5 Proposed job (sketch, for `native-core.yml`)

```yaml
  build-test-windows:
    needs: goldens
    runs-on: windows-2025          # VS 2026 since 2026-06 [V]; pin windows-2022 if VS 2026 breaks something
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: actions/download-artifact@v4
        with: { name: goldens, path: native/golden/out }
      - uses: ilammy/msvc-dev-cmd@v1     # vcvars for clang-cl / link [U: or a VS dev shell step]
      - name: Configure (clang-cl, Ninja)
        run: cmake --preset release -DCMAKE_C_COMPILER=clang-cl -DCMAKE_CXX_COMPILER=clang-cl
        working-directory: native/core
      - run: cmake --build build/release
        working-directory: native/core
      - run: ctest --output-on-failure
        working-directory: native/core/build/release
      # byte-identity gate: hash every rig_render WAV and compare with the ubuntu g++ job's hashes (an artifact
      # the build-test job would upload), so "Windows = Mac sound" is a CI fact, not an integrator note
```

Also needed:
- a `windows-clang-cl` configure preset, or the cache vars above;
- in `build-test`, upload the render hashes (sha256 of each `<id>.wav`) from ubuntu g++ and macOS;
- a non-blocking `cl` job later, if wanted;
- MSVC ASan (`/fsanitize=address`) is possible; TSan does not exist on Windows, so keep TSan on Linux;
- `TMPDIR` → `TEMP` in the test env;
- the runner image is expected to have LLVM / clang-cl, Ninja and CMake **[U: check the image's software list]**;
- no audio device on runners, so `rt.*` suites must be checked: they render on a timer, like the devhost null
  backend **[R/U]**.

---

## 6. Recommendation and phased plan

**Pick (a): C++ + WebView2, core on clang-cl, miniaudio WASAPI, WinMM, MSIX (or Inno) + one signing route.** Keep
(b) as the fallback if the WebView2 host stalls. Both share the core, the C audio/MIDI host and §5. Only the window
and bridge layer differs, so switching costs about 1–2 weeks **[E]**.

| Phase | Scope | Exit criterion | Effort **[E]** |
|---|---|---|---|
| **0. CI (cloud, any time after Mac/iPad 2.0)** | W1–W8, W10 fixes; `build-test-windows` (clang-cl); render-hash byte compare vs ubuntu | ctest green on windows-2025; 112/112 WAVs byte-identical to Linux g++ (or the differences explained) | 3–6 agent-days |
| **1. Spike: devhost on Windows** | W9; miniaudio WASAPI (`noAutoConvertSRC`, Pro Audio); real UI in Edge over the existing WebSocket transport; WinMM input → `rig_midi_in` | Ryan plays on a real Windows PC: same patches sound like the Mac; buffer 128 reported; MIDI keyboard works | 3–5 agent-days + 1 Ryan session |
| **2. MVP: WebView2 shell** | `rig://app` scheme + main.js patch; `webview2Transport`; document-start `window.rig` minimal (backupNow / latestBackup / onMenu, as `RigLibrary`); ProcessFailed → panic + reload; paths; MF AAC decode; recordings; `--self-test` in CI; unsigned zip or MSIX for testers | E4-style self-test passes on a runner; a 2-hour rehearsal without xruns on Ryan's test PC | 2–4 weeks |
| **3. Parity** | exclusive-mode option (no ASIO host: D38, unless Ryan signs Steinberg's licence); My Samples / pads / patch packs `/api/*`; tray, global hotkeys, login item, single instance, sleep prevention (`SetThreadExecutionState`); update check (1.x model) then a real updater; installer + signing; Windows MIDI Services SDK when GA; BLE via WinRT | feature checklist = Mac 2.0 minus Mac-only (GarageBand importer, menu-bar popover → tray) | 4–7 weeks |
| **Release** | tier 1 | Ryan's call | — |

Total ≈ 2–3 months of agent time plus Ryan's hardware sessions **[E]**. These are rough ranges based on the Apple
shell's size (about 3k lines) and the devhost. They are not measured.

---

## 7. Open questions for Ryan (tier 1)

1. **Signing and channel** (recurring cost; publisher identity):
   - (i) Microsoft Store MSIX: free, Store-signed, ID verification, Store review per release.
   - (ii) Azure Artifact Signing: about $120/year, US individual, publisher = legal name; GitHub Releases + CI
     signing.
   - (iii) OV certificate: $150–300/year + token/HSM, 460-day renewals.
   - (iv) SignPath (OSS).
   - (v) Unsigned beta only.

   Suggested: (i) for users + (ii) for GitHub downloads, or (i) alone to keep the cost at zero.
2. **ASIO: answered by D38.** Windows 2.0 ships WASAPI only, with ASIO as a later drop-in backend behind the same
   interface if a real-PC test says WASAPI isn't good enough. The SDK's GPLv3 option doesn't fit a PolyForm app, so
   shipping ASIO needs Ryan to sign Steinberg's proprietary licence agreement.
3. **Test hardware:** which Windows PC(s), and x64 or ARM64? A Parallels VM on Apple silicon runs Windows 11 ARM:
   good for UI and MIDI smoke tests, useless for latency.
4. **Minimum Windows version:** Windows 11 only, or Windows 10 22H2 too? Windows 10 means single-client MIDI and the
   WebView2 runtime may be missing.
5. **Exclusive WASAPI as the default?** Suggested: off; shared low-latency by default.
6. **Size budget:** the same 500 MB rule? Under (a) it is a non-issue.
7. **Updates:** a check-and-link like 1.x, or silent updates (which need signing)?

---

## 8. Sources not reached

- The WebView2 "Distribute your app" page (`learn.microsoft.com/microsoft-edge/webview2/concepts/distribution`) and
  the Tauri Windows-installer page on the first try were refused by the fetch permission layer. The Tauri page was
  read on the second try; the distribution page was not read.
- The `learn.microsoft.com` low-latency page was read through its `en-sg` mirror.
- Not checked at all: the Windows MIDI Services SDK GA version as of 2026-11, the exact ASIO LICENSE.txt in the
  official SDK zip (moot for 2.0 after D38: no ASIO), and the runner image's LLVM version.
