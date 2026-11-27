# NEXT-PLATFORMS: iPhone 2.0, then Windows 2.0 (D27)

Status: plan only, nothing built. Written 2026-11-26. Order (D27, Ryan): Mac/iPad 2.0 first, then iPhone, then
Windows. D31 (Ryan, 2026-11-27): building starts as soon as the 2.0 work Claude can do is done; see D31 for what may
land on v2-native before the 2.0 tag.

Evidence tags as in the Windows doc: **[R]** checked in this repo, **[V]** checked against a source this session,
**[E]** estimate, **[U]** from memory, verify before relying on it.

- iPhone: this file, §1.
- Windows: [`NEXT-PLATFORMS-windows.md`](NEXT-PLATFORMS-windows.md) (options comparison, tree issues W1–W11, phased
  plan, tier-1 questions). Summary in §2.
- Sizes for all apps: §3.

---

## 1. iPhone 2.0: a full instrument and a remote for the Mac

### 1.1 What already carries over

- The iOS target exists and is iPad-only: `TARGETED_DEVICE_FAMILY: "2"`, iOS 17.5 [R] (`native/apple/project.yml`).
  Adding iPhone is `"1,2"` plus phone layouts; the core, `RigAudio` (C), `RigHost`, `RigSchemeHandler`, `RigLibrary`
  and the `rig://` scheme are shared Apple code [R].
- The v6 UI is modular (D15): strips, sidebar modules (Drone, Setlist, Notes, Click, Chart), the left panel and the
  bottom row are separate components [R], so a phone layout is a new arrangement of the same modules, not a fork.
- iPad memory limits already apply on iOS: sample cache 320 MB int16 hard cap, engine resident ≤ 450 MB on 4 GB iPads
  [R] (`ARCHITECTURE.md` §memory). The iPhone uses the same `ios` config.

### 1.2 Instrument mode (own audio)

- **Layout [E, to mock up first]:** portrait = one instrument focused at a time (swipe between strips, levels in a
  compact row), drone and PANIC always reachable, bottom keyboard optional (off by default; most phone users play a
  MIDI keyboard). Landscape = up to 4 strips plus PANIC/Lock. Settings and Edit as full-screen sheets.
- **MIDI:** USB-C (iPhone 15 and later) and Bluetooth LE MIDI through CoreMIDI [U]; Lightning phones need a camera
  adapter [U]. Same native MIDI path as the iPad.
- **Memory:** phones with 4 GB RAM get the iPad budget unchanged; 6–8 GB phones could raise the cap later [U for
  which models]. E6 (iPad memory budget, measured on hardware) must land first; that is the gate for iPhone.
- **Audio session:** same as the iPad (playback category, background audio while a set is running) [R for the iPad
  design; iPhone behaviour with the ringer switch U].

### 1.3 Remote mode (control a Mac on the same network)

- **Scope (D27):** song (pick, Next/Prev), drone (on, key, level), master level, PANIC, snapshots. No audio over the
  network: the Mac plays, the phone only sends commands and shows state.
- **Transport [E]:** the Mac app advertises itself with Bonjour and serves a small WebSocket endpoint on the local
  network; the phone discovers it and pairs with a short code shown on the Mac (no open control port without
  pairing). Commands are the same bus the menu-bar popover will use (D27), so one command set serves both.
- **iOS needs** a Local Network usage string and the Bonjour service type in Info.plist [U].
- **Safety:** PANIC on the phone must work even if the phone's state view is stale; the Mac stays the source of truth
  and rejects commands while Perform is locked except PANIC (same rule as D24.1 / Lock) [E].

### 1.4 Steps [E]

1. Phone layout mockups (HTML, like the v6 mockups) for Ryan to pick from. Can be done now; it is design, not build.
2. After Mac/iPad 2.0: E6 measured on an iPad; then widen the device family and build the phone layout from the
   modules; iPhone UI suite (ui-v6-iphone) at 390×844 and 430×932 plus landscape.
3. The Mac command bus (shared with the menu-bar popover), then remote mode on the phone.
4. TestFlight beta, then App Store (tier 1: Ryan).

### 1.5 Open questions for Ryan (tier 1)

1. One app with both modes, or a separate "Worship Rig Remote"? (Default [E]: one app, mode chosen on first launch.)
2. Minimum iPhone (iOS 17.5 like the iPad, or newer).
3. Does remote mode need to work without Wi-Fi (Mac hotspot, USB)? Default: same Wi-Fi only.
4. Price / App Store listing (shared with the iPad listing).

### 1.5a Ryan's call (D29, then D30)

- **D30: ship remote-only.** No instrument mode on iPhone in 2.0; §1.2 is kept for a later version.

- Remote from the XR up. Instrument mode only if Ryan's iPhone 14 runs it properly; otherwise remote-only until
  phones improve. Order: remote → engine spike on the 14 → phone layouts (if it passes) → RAM floor per phone.

### 1.6 Earliest iPhone and work [V for iOS lists and RAM, E for effort]

- iOS 26 and iOS 27 run on iPhone 11 and later plus SE (2nd/3rd gen); iOS 26 dropped XS / XS Max / XR. With the
  iPad's iOS 17.5 target, XS / XR are also in.
- RAM: 3 GB = XR, SE 2nd gen; 4 GB = XS, 11, 12, 12 mini, 13, 13 mini, SE 3rd gen; 6 GB = 12/13 Pro, 14, 15;
  8 GB = 15 Pro, 16, 16e, 17; 12 GB = Air, 17 Pro. USB-C from iPhone 15 [U].
- The SE 2nd gen (3 GB, 4.7-inch) is on every current iOS, so any minimum iOS keeps a 3 GB small phone in; raising
  the minimum iOS removes almost no work. App Store targeting cannot select by RAM [U].
- Effort: instrument mode ≈ 12–19 agent-days, remote ≈ 11–17, the 3 GB / 4.7-inch tier ≈ 3–5; total ≈ 26–41.

---

## 2. Windows 2.0: summary of NEXT-PLATFORMS-windows.md

- **Recommendation:** a native C++ host with WebView2 (core in-process, clang-cl; WASAPI via the devhost's miniaudio
  host; native WinMM MIDI). It mirrors the Apple shell (custom `rig://app` scheme, document-start script,
  postMessage bridge). Fallback: Electron with the core as a Node-API addon.
- **Phases [E]:** CI job on windows-2025 with render hashes compared to Linux (3–6 agent-days) → devhost spike with
  the real UI in Edge (3–5 agent-days plus one session from Ryan) → WebView2 MVP (2–4 weeks) → parity: ASIO,
  tray/hotkeys, installer, signing, updater (4–7 weeks).
- **Tree issues to fix first (W1–W11):** clang-cl matches `GNU|Clang` in `RigWarnings.cmake` (`-Wall` =
  `-Weverything` there, fails with `-Werror`); `inst_catalogue.inc` is a 60,852-byte string literal (MSVC limit
  16,380); `-isystem`, `__builtin_inf()`, `fopen` under `/WX`; narrow-string paths; no flush-to-zero on ARM64 `cl`;
  no Windows thread priority; the devhost server uses POSIX `poll`/`pipe`.
- **Biggest blocker:** no Windows test PC; CI runners have no audio device.
- **Channel (D28, Ryan):** a download from the website, not the Store; unsigned at first (SmartScreen warning on
  first launch), paid signing optional later.
- **Tier-1 questions still open:** ASIO under
  its GPLv3 option (licence text still to read); test hardware (x64 or ARM64); Windows 10 support; exclusive WASAPI
  default; size budget; updater style.

---

## 3. App sizes [E unless marked]

Nothing for 2.0 has been measured yet; these are estimates from the parts.

| App | Contents | Size |
|---|---|---|
| Mac 1.x (today) | Electron ≈ 285 MB + samples ≈ 79 MB | 365 MB [R, CLAUDE.md] |
| Mac 2.0 | samples 80 MB [R] + web UI 4.3 MB [R] + core and Swift shell | ≈ 95–120 MB |
| iPad / iPhone 2.0 | same content | ≈ 95–115 MB |
| Windows 2.0 (WebView2) | same content; WebView2 is in Windows 10/11 | ≈ 90–120 MB |
| Windows via Electron (fallback) | bundles Chromium | ≈ 350–370 MB |

Samples are MP3, so downloads are close to installed size. Optional sound packs (Lane P) are separate downloads.
To replace the estimates: have the macOS CI job build the app and report its bundle size each run (small task).
