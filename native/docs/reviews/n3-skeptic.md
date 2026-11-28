# n3-skeptic: review of lane N3 (B2, file import and export in the native Mac / iPad app)

Reviewer: strong skeptic, 2026-11-28. Branch `lane-n3`. Reviewed at builder tip 769ed99 (gated tree 712a347).
Worktree /home/claude/wt-n3.

**Verdict: MERGE** (after the fixes below, which are committed on the lane).

The design holds:
- Every app export goes through `rig.saveText`.
- No export path can commit a main-frame load, so an export can no longer end a recording (n0-skeptic O1).

The Swift is unbuilt. CI mac-check is the only compiler, so a compile error there stays possible. I found none
reading every changed line, and tree-sitter-swift 0.7.4 reports 0 ERROR nodes in all 13 `Shared/*.swift` files.

## Rebase

- At the start of the review, `origin/v2-native` was cd377cf, the lane's own base, so there was nothing to rebase.
- During the gate run it moved to e8bd0c7. That commit is D44 and touches only `native/docs/DECISIONS.md`; no file
  overlaps with the lane.
- The lane was rebased onto e8bd0c7 cleanly.
- `git diff origin/v2-native...HEAD -- app/js/engine` is empty.

## Findings and fixes

| id | what | severity | status |
|---|---|---|---|
| F1 | Two toasts show before the save panel answers, so a Cancel still says "exported" (builder Q3). They are Edit's Export library ("Library exported") and the v6 song menu's Export ("Exported …"). | low (wrong feedback on stage) | **fixed** |
| F2 | `safeName` capped names at 200 *characters*, but APFS limits names to 255 UTF-8 *bytes*. A long CJK or emoji song name (3-4 bytes per character) failed with ENAMETOOLONG. A long ASCII name lost its `.rig-song.json`. | low | **fixed** |
| F3 | iPad: only the export picker's delegate clears `busy`. If a swipe-down dismissal does not call `documentPickerWasCancelled` [U], every later export answers `busy` until the app is relaunched. | med (iPad, [U]) | **fixed (belt)** |
| F4 | The listener calls `preventDefault()` before it knows whether `fetch(blob:)` works from a `rig://` page (builder Q1, [U]). If the read failed, nothing was saved, and WebKit's own download path had already been suppressed. | low (no app path uses the listener today) | **fixed** |
| O-mid | A middle-click fires `auxclick`, not `click`, so the listener missed it (Chromium downloads it). In WebKit, RigNavigation's belt covers it (`.download`, or a cancel for a new window). | low | **fixed** |
| O-svg | An SVG `<a>`'s `href` is an `SVGAnimatedString`. `String(a.href)` gave `[object SVGAnimatedString]`, so the anchor was not taken over. | trivial | **fixed** |
| O-closed | The listener does not see anchors inside a *closed* shadow root (composedPath hides them) or detached anchors. RigNavigation is the belt for both. The app has neither: no `attachShadow`, and every `<a download>` is appended to `body` before `click()`. | — | by design; documented |
| O-hidden | `choose` and `runOpenPanel` attach their sheet to `webView.window` even when the window is hidden or minimised. The sheet would be invisible and `busy` would stay set. This can't happen in 2.0 today: without N5's menus or N7's menu-bar mode, an export needs a click in the visible window. | — | open (N5 / N7) |
| O-err | Errors are mostly silent. On the iPad a failed temp write answers `{error}` with no alert. On both platforms `file too large` and `busy` give only a JS warn or nothing, and the callers ignore `{error}` (since F1 they show nothing). Mac write errors do show an alert. | low | open |

### Fixes

The fixes are commits be46cfe, d113fdb and a51fb3d (prefixed `n3-skeptic:`), plus LANE.md updates.

- **F1**: new `afterSave(result, fn)` in `views/edit/lib.js`, used by setlist.js `exportLibrary` and v6 song-menu.js.
  - When `download()` returns nothing (a browser download), `fn` runs at once, synchronously as before. Chrome and
    Electron are unchanged.
  - In the native app, `fn` runs only when the reply is `{saved}`.
  - Settings › Export library and Edit's Export song never showed a toast.
  - Tests: a unit test of `afterSave` (browser / saved / canceled / error). A new native-shell B2 subtest: a
    `{canceled}` reply shows no "Exported" toast (watched with a MutationObserver).
  - Mutation check: with `afterSave` forced to always toast, the new subtest fails.
- **F2**: `RigFiles.maxNameBytes = 240`.
  - Above the cap, the suffix is kept: from the first dot whose tail is at most 24 bytes and has no space
    (`.rig-song.json`, `.json`).
  - The part before the suffix is shortened by whole Characters.
- **F3**: `picker.presentationController?.delegate = d`. `ExportDelegate` also answers
  `presentationControllerDidDismiss` with nil. `answer` was already once-only, so a picker that reports both still
  answers once.
- **F4**: new `handOff(href, name)`.
  - After a failed read, the listener clicks a detached copy of the anchor.
  - That click never reaches `window`, so there is no loop. WebKit's own `<a download>` handling makes it a
    WKDownload (`.download` → RigFiles), never a load.
  - Chromium check with `fetch` forced to fail: one download (`hand.json`), no main-frame navigation, one warn.
  - The self-test's `filesProbe` now records the listener's warnings (`files.probe.fileWarns`, counted in the
    `files` detail). A Q1 failure therefore shows even when the hand-off still writes `N3 click.json`.
- **O-mid**: a capture listener on `auxclick` (button 1) runs the same code as `click`.
- **O-svg**: when `href` is not a string, the listener reads the `href` attribute.
- Docs:
  - CONTRACT_CHANGES "N3": a new "N3 skeptic fixes" subsection.
  - MAC_CHECK: F1 and F2 rows in step 4 item 5, and an F3 row in the iPad B2 item.
- Test counts: `files.test.mjs` 10 → 14; the native-shell B2 test 7 → 8 subtests; the selftest `filesProbe` test
  asserts no listener warnings.

## Adversarial checks

### 1. Can any export path still navigate the main frame or end a recording?

**The app's own call sites.** All five export call sites go through the two `download()` helpers, which call
`rig.saveText` in the native app before any blob is made:
- Settings › Export library
- Edit's Export library
- Edit's Export song (setlist and song header)
- the v6 song menu

Other paths that could navigate:
- `recorder.js` `downloadBlob` is never reached under the bridge: NativeRecorder records, and the core writes the
  WAV.
- `app/js` (engine aside) contains no `window.open` on a blob, no `location.*` assignment, no iframes, no
  `<embed>` / `<object>`, no PDFs and no data: navigations.
- The only `location.reload()` is Settings' "Reload" after a My Samples change, which is meant to reload.

**The listener, probed in real Chromium.** Chromium stands in for WebKit's event dispatch here; the probe scripts are
in /home/claude/scratch/n3/probe.

| case | saved via saveFile | browser download |
|---|---|---|
| keyboard Enter on a focused anchor | 1 | 0 |
| ⌘-, Ctrl-, Shift-click | 1 each | 0 |
| click on a `<span>` inside the anchor | 1 | 0 |
| `target=_blank` | 1 | 0 |
| anchor in an open shadow root | 1 | 0 |
| `revokeObjectURL` right after `click()` | 1 (exact bytes: fetch resolved the URL at once) | 0 |
| middle-click | 0 before O-mid, **1 after** | 1 before, 0 after |
| anchor in a closed shadow root | 0 | 1 (in WebKit: the Swift belt) |
| detached anchor `click()` | 0 | 1 (in WebKit: the Swift belt) |
| non-cancelable synthetic `MouseEvent('click')` | 1 | 1 (in WebKit, a second WKDownload, dropped as `busy` while a panel is open; no load) |

There were no main-frame navigations and no popups in any case.

**The Swift belt.** Swift cancels every main-frame or new-window `blob:` / `data:` action that is not a download
(`targetFrame?.isMainFrame ?? true`), and answers `.download` for downloads. So even what the listener misses cannot
commit.

**Size limits.** A big `data:` URL is read by `fetch`. JS checks the 64 MiB cap on `blob.size` before base64, and
Swift checks it again after decoding.

**Revoked blobs.** It is [U] whether WebKit, like Chromium, resolves the blob URL when `fetch()` is called (so that a
later revoke doesn't matter). The app doesn't depend on it: the helpers revoke after 10 s (recorder.js after 60 s),
and in the native app the helpers don't use the listener at all.

### 2. Cancelling main-frame blob:/data: navigations

Nothing legitimate breaks:
- the app's pages are `rig://app/…`;
- the crash-loop page is `loadHTMLString(…, baseURL: nil)`, so `about:blank`, which is allowed;
- the self-test loads `rig://`;
- there are no PDFs, chart attachments or iframes;
- recordings play from the core's files, not through blob navigations;
- pad-file `blob:` URLs are subresources (audio src), not navigations.

Subframes may still load `blob:` / `data:`. The app has none. Content that could inject an iframe would already be
running script in the main frame, so allowing subframes adds no attack surface.

### 3. Chrome / Electron

- Only RigShellScripts (Swift) loads `app/js/native-shell/*`. No page imports it.
- Both helpers test `rig.shell === 'native'`. Chrome has no `globalThis.rig`, and Electron's preload `rig` has no
  `shell`.
- `afterSave(undefined, fn)` runs `fn` synchronously, so the toasts in Chrome and Electron are unchanged.
- The native-shell suite's Chrome test still sees a real download with the store's JSON.
- UI6 purity (flag off, against origin/v2-native) passes, see Gates.
- Failures only `console.warn`.

### 4. Swift (read line by line; compiled only in CI mac-check)

- **Availability.** The deployment targets are macOS 14.5 and iOS 17.5. Everything used is older:
  - `WKNavigationActionPolicy.download`, `WKDownload`, `shouldPerformDownload`: macOS 11.3 / iOS 14.5
  - `UIDocumentPickerViewController(forExporting:asCopy:)`: iOS 14
  - `NSSavePanel.allowedContentTypes`, `UTType`: macOS 11 / iOS 14
  - `if let x {` and `guard let self else`: Swift 5.7 (the project uses SWIFT_VERSION 5.9)
- **Delegate signatures** match the SDK: `didBecome download`,
  `decideDestinationUsing:suggestedFilename:completionHandler:`, `downloadDidFinish`, `didFailWithError:resumeData:`,
  and `runOpenPanelWith:initiatedByFrame:completionHandler:` (macOS only, inside `#if`).
- **Platform split.** The iOS `alert` / `export` / `ExportDelegate` and the macOS `choose` / `runOpenPanel` / `alert`
  are cleanly split. `place()` calls whichever `alert` exists on the platform.
- **Concurrency.** RigFiles conforms to WKDownloadDelegate in its primary declaration, so newer SDKs may infer
  `@MainActor` for it. RigNavigationDelegate (WKNavigationDelegate / WKUIDelegate) follows the same pattern, is built
  the same way in `RigHost.init`, and already compiles. At worst this gives Swift 5 mode warnings, not errors.
- **Main thread.** `handle`, the panel completions and the WKDownload callbacks all run on main. Only `Data.write`
  runs on the `io` queue, and `done` hops back to main. `downloads` is touched only on main.
- **Retain cycles.**
  - `host` is weak, and `RigHost` holds `files`.
  - The panel closure captures `p`: the usual panel-retains-its-handler pattern, released when the handler runs.
  - iPad: `exporter → ExportDelegate → done → self` is a cycle only until the picker answers (`done = nil`,
    `exporter = nil`), and with F3 also on a swipe dismissal.
  - RigFiles lives as long as the host either way.
- **Temp files.**
  - iPad: `<tmp>/rig-files/<uuid>/<name>`, removed when the picker answers, or at once when there is no top view
    controller.
  - WKDownload temps are removed after `place`, on cancel, on failure, and when dropped as busy.
  - If the app is killed while the picker is open, the temp file stays until the OS purges tmp.
- **Busy logic.** One panel at a time, shared by save, open and the download fallback. Every path clears `busy`:
  - macOS: on cancel, when the write is done, when the open panel finishes;
  - iPad: on the picker's answer (and, with F3, on a swipe dismissal).
  - `saveDir` bypasses it by design. A WKDownload that arrives while busy is dropped with an NSLog.
- **File names.** `/ \ :` and control characters become `-`. Leading dots and surrounding whitespace are stripped.
  An empty result gets the default name; `.` and `..` end up empty, so they get it too. F2 adds the byte cap.
- **Writes.** `Data.write(.atomic)`; the WKDownload path uses `replaceItemAt` / `moveItem`. The app is not sandboxed
  (entitlements `{}`), so a path picked in the panel needs no security-scoped bookmark.
- **64 MiB cap.** JS answers `{error:'file too large'}` before base64, and Swift checks again after decoding. No
  alert either way (O-err).
- **base64.** `btoa` over 32 KiB `fromCharCode` chunks produces no whitespace, so `Data(base64Encoded:)` accepts it.
  Invalid base64 answers `nothing to save`.

### 5. Toasts before the panel answers (builder Q3)

Fixed (F1). It was small and touches only the native path; Chrome is unchanged.

### 6. Engine

`git diff origin/v2-native...HEAD -- app/js/engine` is empty.

## Gates

`UI6_PURITY_BASE=origin/v2-native node tools/cloud/gates.mjs …` on tree 641120a (commit cde92dc, before the docs-only
rebase), clean, 2-CPU box:

| suite | result | time |
|---|---|---|
| shell-unit | PASS | 34 s |
| unit | PASS | 40 s |
| native-midi | PASS | 3 s |
| native-shell | PASS | 15 s |
| settings | PASS | 129 s |
| migration-1x | PASS | 104 s |
| ui-core | PASS | 346 s |
| ui-v6 | PASS | 324 s |
| ui-v6-edit | PASS | 361 s |
| chart | PASS | 171 s |

After the rebase (which added only DECISIONS.md) and this report, shell-unit, unit and native-shell were rerun on the
final tree; see LANE.md.

## Open questions

- **Q1 [U, Mac]:** can `fetch()` read a `blob:` URL that a `rig://app` page made? The app's helpers don't need it.
  If it fails, F4 hands the URL to WKDownload, and the self-test `files` detail counts the listener's warnings.
- **Q2 [U, Mac]:** does WebKit turn a detached `<a download>` click into a WKDownload? The self-test reports it as
  `files-download` (not required). F4 now relies on it as well.
- **O-hidden (N5 / N7):** once menu shortcuts or menu-bar mode can start an export while the window is hidden,
  `choose` and `runOpenPanel` should use `begin` (or show the window first) when `!window.isVisible`.
- **O-err (Ryan):** should `{error}` show the user something (an iPad write failure, `file too large`)? It is a
  design choice. With today's library sizes these errors can't happen in practice.

## Only a Mac / iPad can verify

- CI mac-check compiles RigFiles / RigNavigation / RigHost / RigSelfTest for macOS and the iOS simulator.
- The self-test steps `files` (now with the `fileWarns` count), `files-recording` and `files-download` pass.
- MAC_CHECK step 4 item 5 on the Mac:
  - the save panel: Save, Cancel (no toast, F1), Replace
  - a long non-ASCII song name (F2)
  - the open panel for Settings, Edit and the chart import
  - an export during a recording keeps the take whole
  - only one panel at a time
- Step 5, B2 on the iPad:
  - the Files export picker: Save and Cancel
  - swipe the picker down, then export again (F3)
  - the import picker and the chart import
  - an export during a recording
- Q1 and Q2 above.
