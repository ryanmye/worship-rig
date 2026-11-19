# WebKit portability audit (app/ in WKWebView, macOS 14+ / iPadOS 17+, later WebView2)

Scope: everything under app/ except app/js/engine/** (replaced by the native engine, see ENGINE_CONTRACT.md).
Method: STATIC. Playwright WebKit is NOT installed (`ls /opt/pw-browsers` shows chromium, chromium-1243,
chromium_headless_shell*, ffmpeg-1011 only; installing is forbidden here), so nothing below was run in WebKit.
Tags: [C] certain (spec/compat fact checked against the code), [D] needs a device (behaviour unverified; the Safari
version numbers are from memory of release notes and must be re-checked on a device).
Sizes: S < 0.5 day, M 0.5-2 days, L > 2 days. "App edit" = a change to an app/ file (owner's decision; none made here).

## 0. What the shell must provide

1. A custom URL scheme handler serving app/ (section 2). Root-absolute URLs (`/fonts/..`, `/themes/..`) need the page at
   `scheme://host/` with app/ as the root, exactly as server.js does today.
2. A `window.rig` object injected at document start (WKUserScript) before any module runs (section 5).
3. A `navigator.requestMIDIAccess` polyfill backed by the contract `midi` op (section 1).
4. WKUIDelegate / WKDownloadDelegate glue for file inputs, blob downloads and `window.open` (section 1).
5. Deployment floor macOS 14.5 / iPadOS 17.5, not 14.0 / 17.0, because of `light-dark()` (section 3).

## 1. APIs outside app/js/engine/ (file:line, WebKit behaviour, fix)

### Web MIDI [C]
- midi.js:138,143 `requestMIDIAccess`; access.inputs / onstatechange / onmidimessage at midi.js:153,168,339,345,575;
  midi-clock.js uses the MIDIAccess outputs.
- Absent in WKWebView: MidiInput emits `unavailable`, the top bar shows no MIDI.
- Fix: the shell injects a polyfill with the surface midi.js reads (inputs/outputs Maps, onstatechange,
  port.onmidimessage, port.send, port.state/name/id/manufacturer) fed by the contract ops `midi listen/route/send`.
  No app edit. Size M.

### Web Audio objects read outside the engine folder [C]
- No view constructs an AudioContext. Reads only: controller.js:1604,1705,1862,1919,1931,2070 (`engine.ctx.state`,
  `resume`, `getOutputTimestamp`), main.js:832,933,1004, recorder.js:302,379 (`ctx.audioWorklet`), meter.js:31,53 and
  eq-keyboard.js:823-842,988-1011 (`engine.analyserL/R`, `getFloatTimeDomainData`, `getFloatFrequencyData`).
- The JS shim must supply a fake `ctx` (`state` always 'running', `currentTime`, `resume`, `getOutputTimestamp`) and fake
  analysers fed by the `tick` meters plus the optional base64 spectrum (already in ENGINE_CONTRACT). Size M.
- settings.js:348 tests `'setSinkId' in AudioContext.prototype`. The shim should NOT define a global AudioContext; the
  output picker then reads native devices instead (needs an app edit, S).

### Output devices, getUserMedia [C absence, D macOS]
- controller.js:1736,2003-2005,2038,2455; settings.js:320-324,348,363; latencyHint.js:52-53.
- `enumerateDevices` in WKWebView returns no audiooutput list (iOS certain, macOS [D]). settings.js:363 `askLabels` calls
  `getUserMedia({audio:true})`: it would raise a microphone prompt for nothing. Never expose it.
- Fix: output list from native (`get devices`), `restart({sinkId})` maps to `audio output`; hide the "show names" button.
  App edit in settings.js and latencyHint.js. Size M.

### File System Access, OPFS [C]
- settings.js:692,744 (`showDirectoryPicker`), recorder.js:4,163,326-332 (`showSaveFilePicker`, `createWritable`),
  recorder.js:220,328 (OPFS), controller.js:1791 (IndexedDB handle restore).
- Not in WKWebView; all are feature-gated and fall to OPFS/memory/null. Moot when the `isElectron` branch is taken
  (recorder 'electron' sink at recorder.js:98-99 becomes the native `rec` op; pads via `rig.choosePadFolder`). Size S.

### Web Locks, BroadcastChannel, wakeLock
- Locks: controller.js:65,210,2306-2330 (single-instance guard). `navigator.locks` is secure-context only and custom
  schemes are probably not secure contexts [D]; the code already treats missing locks as granted. No work.
- BroadcastChannel: shared/bus.js:128-151, controller.js:2584. Between two WKWebViews it works only if they share a
  process pool and data store [D]. Use the rig bus (`busPublish`, `onBusCommand`, `miniSubscribe`, `miniCommand`).
- wakeLock: controller.js:1987-1994,2543, gated by `!isElectron`. WKWebView support unreliable [D]. iPad: native
  `UIApplication.shared.isIdleTimerDisabled` while the engine is awake; take the isElectron branch. Size S.

### Workers, worklets, MediaRecorder
- recorder.js:11,34-41,303 (AudioWorklet via URL, then blob: retry), engine/fx.js:431 module Worker (engine).
- Both vanish with native `rec` and native reverb. Do not load recorder-processor.js. Size S.

### fetch of app files [C]
- controller.js:1960 (`/api/user-samples/manifest.json`), settings.js:921,925 (`/api/health`, `/api/user-samples`),
  controller.js:2373 (`/api/heartbeat`, http only), engine instruments.js:26,445-450, sampler.js:618, audio.js:240.
- fetch of a custom scheme works when the handler answers. Routes are listed in section 2. Size M.

### localStorage persistence and quota
- store.js:149-160 (`LIBRARY_MAX_CHARS` 2,000,000; `BACKUPS_KEEP` 3), store.js:638-650 (probe), main.js:115-237,
  themes/boot.js:37, startCard.js:11-77, latencyHint.js:25-36, edit/lib.js:547-590, settings.js:1292-1300.
- Persistent on a default WKWebsiteDataStore. Quota is about 5 MB per origin [D]; the constants assume Chromium's
  measured 5.2 M characters. ITP's 7-day purge of script-writable storage is a browser rule; for WKWebView apps it
  depends on app-bound domains [D].
- THE ORIGIN CHANGES: Electron used `http://127.0.0.1:<port>` (the port itself can change, `portChanged` in getInfo),
  so existing libraries are not visible in the native app.
- Fix: (1) one-time migration: the shell reads the newest Electron backup (the file `rig.latestBackup()` serves) and
  the UI imports it; (2) the shell stores every `rig.backupNow` on disk and restores from `latestBackup` when
  localStorage is empty (the Electron contract already does this); (3) lower the limits only if a device test shows a
  smaller quota. Size M.

### CSP
- index.html:7, mini.html:7, server.js:84-95.
- Matching of `'self'` for non-http schemes is [D] (works for typical `app://` handlers; verify `worker-src`,
  `connect-src`). `webkit.messageHandlers` is not governed by CSP [C]. If `'self'` fails, name the scheme explicitly.
  `style-src 'unsafe-inline'` stays (inline styles everywhere). Size S.

### Smaller items
- themes/boot.js:75 `blocking="render"` on a dynamic link: ignored by Safari [C]; possible first-paint flash. S.
- store.js:681 `requestIdleCallback`: absent in Safari <= 18 [C]; store falls back (null). No work.
- controller.js:2701 `performance.memory`: Chromium only [C]; guarded; use native `get stats`. S.
- eq-keyboard.js:671 `navigator.clipboard.writeText`: needs secure context + gesture [D]; fallback through the bridge. S.
- main.js:932 `beforeunload`: no prompt in WKWebView [C]; shell flushes the recording in applicationWillTerminate. S.
- main.js:1093, controller.js:2421-2422,2855 `visibilitychange`/`blur`: fires on iPad background; a hidden macOS window may
  throttle JS timers and rAF [D]. Shell posts the same `rig:window-visible` DOM event the preload dispatches
  (preload.js:27-31). S.
- Downloads `<a download>` of blobs: edit/lib.js:200-206 (library/song export), settings.js:135-140,
  song-header.js:228, setlist.js:644,650. macOS WKWebView ignores `download` unless the shell implements
  `decidePolicyFor ... shouldPerformDownload` and WKDownloadDelegate (NSSavePanel); iPad needs a share sheet or document
  picker [C needs shell code; exact blob: behaviour D]. Alternative: `rig.saveText(name, text)` (app edit). Size M.
- `<input type=file>`: setlist.js:113-120 (import), settings.js:689-756 (pad files, multiple, audio/*), settings.js:824
  (import library). macOS shows nothing unless the shell implements `WKUIDelegate runOpenPanelWith`; iPadOS handles it
  natively [C]. Size S.
- `window.open`: settings.js:898 (docs fallback), settings.js:1227 (`mini.html` popup, only when `!isElectron`).
  Ignored without `createWebViewWith` [C]. Take the isElectron branch (`rig.openDoc`; the mini panel becomes an
  NSPopover). iPad: no mini panel. S.
- `window.close` override (preload.js:41-47): page `window.close()` does nothing in WKWebView; shell handles Cmd-W. No work.
- Present and fine in Safari 16-17 [C]: ResizeObserver, matchMedia, MutationObserver, Pointer Events, `:focus-visible`.

Syntax outside the engine (grep): `??=` 1, lookbehind regex 2, `import.meta` 1, `.at()` 3, `replaceAll/flatMap/fromEntries/
matchAll` 9; all <= Safari 16.4. No private `#fields`, no `static {}`, no `using`, no `structuredClone`, no
`AbortSignal.any`, no `Object.groupBy`, no `Promise.withResolvers`, no `Intl.*`. A Safari parse on a device is the only
full proof [D].

Not used anywhere in app/ (0 hits): setSinkId on elements, SharedWorker, service workers, SharedArrayBuffer, `<dialog>`,
popover attribute, `inert`, `startViewTransition`.

## 2. Routes the page relies on (server.js) and how the shell provides them

Today server.js serves everything over http://127.0.0.1 (also inside Electron). With a custom scheme the base becomes
`scheme://rig/`.

Static (GET/HEAD; server also sends Range, ETag, nosniff, CSP and X-Frame-Options on HTML):
- `/`, `/index.html`, `/mini.html`.
- `/styles.css`, `/styles-settings.css`, `/mini.css`, `/js/views/edit/styles-edit-v2.css` (it `@import`s base.css and 7
  panels/*.css, so 8 extra requests), `/js/views/components/eq-keyboard.css`.
- `/themes/boot.js` (loaded TWICE in index.html:9,15 and mini.html:9,12), `/themes/<id>/theme.css` for 6 ids
  (sanctuary, sanctuary-v2, daylight, daylight-v2, ember, studio), per-theme assets (`/themes/daylight/paper.png`,
  `mark.svg`, `sun.svg`, `moon.svg`, `today.svg`; theme.css:117,166,191 use root-absolute `url('/themes/..')`).
- `/fonts/*.woff2` (root-absolute in theme.css `@font-face`; 7 woff2 files, 344 KB with licences in app/fonts), `/assets/mark.svg`,
  `/icons/*`, `/favicon.ico` (server answers 204).
- `/js/**` ES modules (`type=module`; dynamic `import()` only in the engine, instruments.js:518). MIME must be
  `text/javascript`; module scripts load in CORS mode, same-origin is fine [C].
- `/samples/**` (80 MB, 24 instrument folders, manifests, gain-trims.json): engine only. The native engine reads the
  bundle directly; the WebView needs none of it.
- `/docs/<name>.md` (server.js:699, text/plain): settings.js:57,890-898 links `docs/garageband-import.md`. Intercepted
  when `rig.openDoc` exists, otherwise this route is needed.

API (JSON, no-store; optional `X-Key` header when the server runs with a secret):
- `GET /api/health` returns `{ok, app, version, pid, clientSeenMsAgo, userSamples, features}`; used at settings.js:921 and
  engine instruments.js:445. Shell: answer with `userSamples:false`, or drop.
- `GET /api/user-samples/manifest.json` (controller.js:1960, engine) and `GET /api/user-samples` (settings.js:925):
  "My Samples". Shell: bridge (`rig.rescanUserSamples`, `rig.userSamplesDir`, already in preload).
- `GET /user-samples/<token>/<slug>/<file>` (engine only, Range). Native engine reads the files.
- `GET /api/heartbeat` (controller.js:2373,2471): active only when `!isElectron && protocol==='http:'`
  (controller.js:212). Inert on a custom scheme. No work.
- `GET /api/pads` and `GET /pads/<token>/<rel>` (Range; streamed through `<audio>` by the engine, ENGINE_CONTRACT Q16).
  The UI only forwards what `rig.listPads()` returns (`{name, path, url}`; perform.js:619,1432,1441;
  controller.js:1843,2460). With native streaming the url becomes an opaque id. `<audio>` over a WKURLSchemeHandler is
  fragile (needs full Range/206 support) [D]; do not depend on it.
- Host check (403), `Cross-Origin-Resource-Policy`, `X-Frame-Options`: not needed; the handler must reject paths outside
  app/ and any `..` (safeJoin semantics).

Minimum the handler answers: the static tree under app/ without samples, `/docs/*.md`, and three JSON stubs
(`/api/health`, `/api/user-samples`, `/api/user-samples/manifest.json`) unless the bridge replaces them.

## 3. CSS (styles.css 1319 lines, styles-settings.css 251, mini.css 214, eq-keyboard.css 248, edit css 1378, themes 3194)

### Version floors found
- `light-dark()`: 352 uses in themes (daylight 106, daylight-v2 125, sanctuary-v2 108), plus 10 in eq-keyboard.css, 3
  in mini.css, 10 in edit css. Safari 17.5 [C]. BLOCKER below 17.5: an invalid custom-property value makes `--bg`,
  `--panel`, `--text` etc. fall to initial and the UI becomes unreadable. WKWebView tracks the OS point release, not the
  app SDK, so the deployment target must be macOS 14.5 / iPadOS 17.5, or the colours must be precomputed. It needs
  `color-scheme` on `:root` (boot.js sets it inline; daylight-v2 theme.css:45-46).
- CSS nesting: 1,227 lines starting with or containing `&` (studio 203, daylight 246, daylight-v2 237, sanctuary 185,
  sanctuary-v2 202, ember 143). Shape: `:where(html:is([data-theme=..])) { &:root{..} & body{..} & .x{..} }` with nested
  `@media`. Safari 17.2 [C]. Below that, ALL six themes produce no rules. `&` inside `:where()` has specificity 0 and the
  theme comments depend on `0,2,0` ordering (daylight-v2 theme.css:44-47): verify the cascade on a device for all six
  themes [D].
- `color-mix(in oklab|srgb)`: 240 + 46 uses; Safari 16.2 [C]; fine at the 17.5 floor.
- `:is/:where` 112, `:has` 14 (styles.css:745-761,964,1055,1271-1272,1312; sanctuary-v2 theme.css:490-495):
  Safari 14 / 15.4 [C]. `:root:has(#banners > :not([hidden]))` (styles.css:1271) restyles the whole page whenever a
  banner toggles: a layout-cost check is [D].
- `@container` size queries and `container: x / size|inline-size`: styles.css:462,586,649,785,856,899,940-975,
  1136-1168; Safari 16 [C]. A `size` container needs an explicit size from layout, same as Chromium.
- `contain: strict`: styles.css:979; fine [C].

### Features WebKit lacks or treats differently
- `@font-face` `ascent-override`, `descent-override`, `line-gap-override`: 7 blocks in 5 themes (sanctuary:28,43;
  ember:32,41; daylight-v2:36; sanctuary-v2:35; studio:29; daylight has none), also copied by themeFonts.js:20-22 through
  `new FontFace()`. Not supported in Safari up to 17 as far as I know [D]. Unknown descriptors are ignored, so the chord
  name line box is 1.22 em instead of 1.1 em: a 2-5 px overflow (see the comment at daylight-v2 theme.css:29-33).
  Cosmetic; fix per theme with `line-height` on `.chord-name` if it shows. Size S-M.
- `field-sizing: content`: edit/panels/song-header.css:18. Not in Safari 17/18 [C]. The song-name input falls back to the
  default size (about 20 characters). Cosmetic S.
- `backdrop-filter: blur(3px)`: styles.css:344 (`.overlay-start`); Safari <= 17 needs the `-webkit-` prefix [C]. Themes
  set it to `none`. Cosmetic S.
- `text-wrap: balance`: styles.css:576; Safari 17.5 [C]; ignored below, harmless.
- `scrollbar-width: none|thin`: styles.css:827, slot.css:18; Safari 18.2 [C]. styles.css:828 has the
  `::-webkit-scrollbar` twin; slot.css:18 `thin` is ignored (macOS overlay scrollbars). Fine.
- `::view-transition-old/new`: daylight/theme.css:524; Safari 18+ and no JS calls `startViewTransition`. Inert.
- `@import` in styles-edit-v2.css:3-10: works, but 8 serial requests through the handler. S: inline at build time.

### Fine in WebKit [C]
- `::-webkit-slider-thumb` 22, `::-webkit-slider-runnable-track` 22, `-webkit-appearance` 7: WebKit-origin. Custom thumbs with
  negative margins (styles.css:143,154,871) can mis-align versus Chromium [D].
- `accent-color` (styles-settings.css:79,157,166,242, Safari 15.4), `conic-gradient` with `calc(var(--hold) * 360deg)`
  (styles.css:535 and each theme `.hb-ring`), `-webkit-box` + `-webkit-line-clamp` (6 + 7), `-webkit-mask[-image]` (8),
  `prefers-reduced-motion` / `prefers-color-scheme`, `-webkit-font-smoothing` (styles.css:52; macOS only).
- Absent in app CSS (0 hits): `@property`, `@layer`, `@scope`, subgrid, `dvh/svh`, `env(safe-area-*)`, `@supports`,
  anchor positioning, `popover`, `overscroll-behavior` on the page.

### The 6 theme files
sanctuary 458 lines, sanctuary-v2 536, daylight 524, daylight-v2 626, ember 378, studio 672, plus boot.js and a README.
All six need nesting (17.2); daylight, daylight-v2 and sanctuary-v2 need `light-dark()` (17.5); five use font metric
overrides. ember and studio are dark only.

## 4. JS syntax / feature floor
No syntax beyond Safari 16.4 outside the engine (section 1). The effective floor of the app is therefore set by CSS:
Safari 17.5.

## 5. Electron-only surface: `window.rig` (preload.js, 212 lines)

Exposed: `isElectron`, `platform`, 41 methods. Also a DOM event `rig:window-visible` (preload.js:27-31) and a
`window.close` override (preload.js:41-47). `getLoginItem` is called (settings.js:1211) but is NOT exposed by preload.js
(it falls back to `getMenuBarState`; dead branch). `saveFileDialog` and `padsBaseUrl` have no callers in app/.

Format: member(s) | callers | Mac shell | iPad shell.

- `isElectron`, `platform` | controller.js:199,1348,1663,1668,1791,1989,2382,2470,2546; settings.js:202,727,797,1005,
  1022,1226,1232,1381; perform.js:619,1432,1441; recorder.js:325; settings-mac.js:51 | true on Mac | open question below
- `streamOpen/Write/PatchHeader/Close` | recorder.js:98-99 (ElectronSink) | replaced by native `rec` | same
- `saveFileDialog`, `padsBaseUrl` | none | skip | skip
- `choosePadFolder`, `listPads` | settings.js:727-731; controller.js:1843,2460; perform.js:619 | NSOpenPanel + security-scoped
  bookmark | document picker, copy into the app container
- `backupNow`, `latestBackup` | controller.js:2135-2171,2208; settings.js:846 | yes; also the migration source | yes
- `getInfo` | controller.js:2188; settings.js:911-913,1005-1007 | yes (port fields meaningless, return 0) | yes
- `openFolder`, `openUserSamplesFolder`, `revealFile` | settings.js:1029,951-962; main.js:638 | NSWorkspace | hide
- `userSamplesDir`, `rescanUserSamples` | settings.js:914; controller.js:1950-1955,2274,2903 | yes | optional
- `garageBandScan/Import/Cancel/Status`, `onGarageBandProgress`, `openDoc` | settings.js:893-998;
  settings-import.js:192,219 | Mac only (importer-host.js; can ship later) | omit; the UI mounts only when present
- `onMenu` ids `panic fadeOutAll nextSong prevSong toggleView record restartAudio openSettings importLatestBackup
  rescanUserSamples` | controller.js:2256-2260,2442-2443,2930 | NSMenu items with accelerators (the controller skips its own
  Cmd-./E/R/Shift-F handling when isElectron, controller.js:1348) | UIKeyCommand, or the controller's own keydown
  handling (needs `!isElectron`)
- `busPublish`, `onBusCommand`, `miniSubscribe`, `miniCommand` | shared/bus.js:143-303; controller.js:2583 | second WKWebView
  in an NSPopover loading mini.html, relayed by the shell | omit (bus falls back to BroadcastChannel, harmless)
- `setMenuBarMode`, `getMenuBarState`, `setLoginItem`, `onMenuBarState` | main.js:1188-1189; settings.js:1132-1138,
  1211-1212 | NSStatusItem, SMAppService login item, hide on close, dock policy | omit
- `setHotkeys`, `pauseHotkeys`, `getHotkeyStatus`, `onHotkeyStatus`, `testHotkey`, `cancelHotkeyTest`, `onHotkeyTest` |
  settings.js:1095; settings-mac.js:52,224; shell-mirror.js:13-27 | global hotkeys (Carbon RegisterEventHotKey) | omit
  (settings-mac mounts only if `rig.setHotkeys` exists)
- `setUpdateCheck`, `checkForUpdate`, `getUpdateStatus`, `onUpdateStatus`, `openUpdate` | settings.js:1093;
  settings-mac.js:333-348; shell-mirror.js | Sparkle or the update-check.js logic | omit (App Store)

Open question for the owner: `isElectron` selects four unrelated behaviours (native recorder, no heartbeat, no
wakeLock/locks/BroadcastChannel, Mac-only UI copy). On Mac the shell can set it true with no app edit. On iPad it would
also show Mac-only wording (settings.js:1022), so the preferred fix is a small app edit introducing `rig.native` or
checks by member presence (most Mac-only UI is already gated by `typeof rig.setHotkeys` and the like). Size M for the
edit across about 20 sites, or S if iPad sets `isElectron:true` and simply omits the Mac-only members.

## 6. iPad touch audit

Layout and viewport [C]
- `body{min-width:1024px; min-height:700px; overflow:hidden}` (styles.css:47-48). Portrait widths (744-834) are clipped
  and cannot scroll. Landscape (1024 split view minimum, 1080, 1133, 1180, 1194) fits, but lands in the compact layouts
  `@media (max-width:1250/1340/1400/1500px)` (styles.css:352-362,519,625,744,757,1128,1178,1270), designed for small
  Mac windows. Heights 744-834 minus status bar can trip `max-height:820px` / `740px` (styles.css:383,1164). Decision:
  landscape-only (S) or a portrait layout (L).
- No `viewport-fit=cover`, no `env(safe-area-inset-*)`, no `dvh` (index.html:5): the home indicator and rounded corners
  overlap the bottom row. S (meta + CSS, app edit).
- Inputs: body font 15px and `font: inherit` on inputs (styles.css:51,59). iOS WKWebView zooms the page when an input
  below 16px gets focus. Affected: song name, tempo (type=number), EQ Hz/Q text fields, setlist search/rename, notes
  textarea. Fix: 16px on touch, or disable pinch in the shell (`pinchGestureRecognizer.isEnabled=false`). S.
- Virtual keyboard: no `visualViewport` handling anywhere (0 hits); `overflow:hidden` with fixed panels means fields in the
  lower half (song notes, Edit setlist) can sit under the keyboard [D]. Shell resizes the web view with the keyboard
  layout guide. S-M.

Touch input
- Pointer model is sound: 26 `pointerdown` handlers, `setPointerCapture` (util.js:210, keys.js:142,297, holdButton.js:179,
  eq-keyboard.js:1423, perform.js:242), `touch-action:none` on faders (styles.css:133), piano (1069), fc-piano and the EQ
  plot (eq-keyboard.css:112). relativeDrag (util.js:195-255) handles touch. Per-key capture gives independent
  multi-touch. Missing: `touch-action:manipulation` on buttons and `-webkit-tap-highlight-color` [D].
- Hit targets under 44pt: `.perform .btn` 40px (styles.css:72,83), `.lh-x` 28px (568), `.ev2-song-pencil` 28px,
  `.bstrip .banner-btn` 26px (283), `.bstrip-more` 31px. Faders (thumb 44x32) and keys are fine. M (app edit).
- Hover-only: Edit setlist row actions show only on `:hover`/`:focus-within` (edit/panels/setlist.css:73-74). WebKit
  emulates hover on tap but does not focus buttons on tap, so reaching rename/delete by touch is [D]-risky. The song pencil
  (song-header.css:167) is visible at opacity .7, fine. 75 other `:hover` rules are cosmetic. About 91 `title=` tooltips
  are invisible on touch (hold buttons already show a cap on tap, holdButton.js:113-130). S-M.
- Double-click: fader.js:206 (reset), keys.js:314, edit/lib.js:700, edit/panels/setlist.js:485 (rename).
  eq-keyboard.js:1482 already has a pointer double-tap path (`lastDouble`, line 93). Synthetic `dblclick` on touch is
  unreliable in WKWebView [D]; the others need a double-tap helper (S each).
- Drag-and-drop reorder uses HTML5 DnD: components/setlist.js:61-119 (Perform strip) and edit/panels/setlist.js:434,
  551-577. iPadOS 17 supports it with long-press lift [D] but it competes with strip scrolling (`overflow-x:auto`).
  Provide up/down buttons on iPad. M.
- Wheel: eq-keyboard.js:1601 changes Q by scroll; a text field alternative exists (eq-keyboard.js:484-485). Fine.
- Context menu: keys.js:156 and mini.js:366 only `preventDefault`. `-webkit-touch-callout:none` is not set (long-press
  callouts on non-selectable text are suppressed by `user-select:none` on body) [D].
- Hardware keyboard: `e.code` shortcuts (controller.js:1340-1412; z/x octave, arrows). iPad delivers keydown to
  WKWebView; Cmd combos may be consumed by the system [D].
- Start overlay "Click anywhere to start audio" (index.html:56-63) is meaningless with a native engine: the fake
  `ctx.state` must be 'running' immediately, otherwise main.js:94,933,1004 raise "Audio stopped - Restart sound".

Anything not marked [C] above is unverified; no rendering was done.

## 7. Prioritised list

### A. Blockers for a first WKWebView boot
1. Custom scheme handler for app/ with root-absolute paths, MIME, JSON stubs (section 2). M
2. `window.rig` injected at document start, plus the `isElectron` decision (section 5). M
3. OS floor 14.5 / 17.5 for `light-dark()` (nesting 17.2, color-mix 16.2 are covered by it) (section 3). S (policy)
4. Engine-adjacent objects the UI reads: fake `ctx`, analysers, cached `listInstruments` (section 1). M
5. Web MIDI polyfill from the native `midi` op (midi.js:138). M
6. Library migration from Electron's localStorage origin via the backup file, and persistence via `backupNow`. M
7. WKUIDelegate `runOpenPanel`, WKDownloadDelegate and `createWebView` for import, export, doc links. S-M
8. Device check of CSP `'self'` on the scheme and the nesting cascade across all 6 themes [D]. S
9. Output device list from native; never call getUserMedia (settings.js:363). S

### B. iPad-specific work
1. Orientation decision and layout floor (body min 1024x700). S landscape-only, L portrait
2. Safe areas (`viewport-fit=cover`, `env()`). S
3. Input font-size >= 16px or pinch disabled. S
4. Keyboard avoidance. S-M
5. Hover-only list actions, tooltips, small hit targets. M
6. Double-tap helpers (fader, keys, lib.js:700, setlist rename). S each
7. Reorder without HTML5 DnD. M
8. Omit Mac-only rig members (mini panel, hotkeys, updater, importer, login item) or gate by `rig.native`. S-M
9. `isIdleTimerDisabled` in place of wakeLock; foreground/background to `rig:window-visible`. S
10. Export/import through share sheet and document picker; pad files copied into the app container. M

### C. Cosmetic, later
`field-sizing` (song name width), `-webkit-backdrop-filter`, font metric overrides on chord text, `@import` waterfall,
`blocking=render` flash, `scrollbar-width: thin`.

Counts: 9 blockers, 10 iPad items, 6 cosmetic. `window.rig`: 41 methods + 2 properties; 3 never callable or never
called (`saveFileDialog`, `padsBaseUrl`, `getLoginItem`); 5 Mac-only groups (menu bar, hotkeys, updater, importer,
login item). Routes: 7 static families + 3 API stubs (+ engine-only `/samples`, `/user-samples`, `/pads`).
CSS floors: 17.5 (light-dark, text-wrap), 17.2 (nesting), 16.2 (color-mix), 16 (container), 15.4 (`:has`, accent-color).
About 14 items remain [D].
