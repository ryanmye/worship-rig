# LANE N3 (builder): B2, file import and export in the native Mac / iPad app

Brief: every 1.x import/export path (Settings › Export library / Import…, Edit's Export song / Export library /
Import…, the v6 song menu's Export, chart Import file, backup files; recordings if they use downloads) works in the
native app on macOS 14.5+ and iPadOS as in Chrome/Electron, and never navigates the page (n0-skeptic O1: a main-frame
commit sends `play panic` + `rec stop`, so an export during a recording could end the take). One thin Swift feature
behind RigShellRouter (save panel / document picker; open panel) with the JS in app/js/native-shell/ gated on its own
`rig` member; Chrome/Electron unchanged. WKWebView never treats a blob:/download as a navigation. Regression test: an
export during a recording doesn't stop it (bridge-mock native-shell suite). `app/js/engine` untouched.
Worktree /home/claude/wt-n3, branch lane-n3, from origin/v2-native cd377cf. Never push, never stash.

## Checklist

- [x] Read RESUMABLE.md, CLAUDE.md, NATIVE-GAPS N3 + finding 8, MAC_CHECK B2, SHELL.md, n0-skeptic O1
- [x] JS: app/js/native-shell/30-files.js (`rig.saveText`, the `<a download>` blob:/data: click intercept)
- [x] App: settings.js + edit/lib.js `download()` try `rig.saveText` first (native only)
- [x] Swift: RigFiles.swift (saveFile: NSSavePanel / UIDocumentPicker forExporting; WKDownload fallback; NSOpenPanel)
- [x] Swift: RigNavigation (cancel main-frame blob:/data:, `.download` for shouldPerformDownload, didBecome download,
      runOpenPanelWith), RigHost registers RigFiles
- [x] Self-test `files` step (RIG_SAVE_DIR / saveDir, exact bytes, URL unchanged, no commit, recording survives)
- [x] node unit tests (30-files.js in vm; polyfill method list; selftest filesProbe)
- [x] Playwright native-shell: exports via saveText, no download / navigation, recording survives; Import… round trip;
      Chrome unchanged (download event, exact bytes)
- [x] Docs: CONTRACT_CHANGES "N3", MAC_CHECK step 4/5 items, SHELL.md, NATIVE-GAPS status
- [x] Gates (UI6_PURITY_BASE=origin/v2-native): shell-unit, unit, native-midi, native-shell, settings, migration-1x,
      ui-core, ui-v6, ui-v6-edit, chart
- [x] Final report below, tip SHA

## Next step

None: handed back. Skeptic review next (orchestrator).

## Findings / notes

- Recordings: under the bridge engine recorder.js returns NativeRecorder (the core writes the WAV), so no download
  path is reached in the native app. `downloadBlob` (OPFS / memory sinks) is Chrome only. The click intercept still
  covers it.
- Pad files (Settings › Choose pad files, `<input type=file>` → blob: URLs the core cannot open) belong to N4.
- Not in N3 (noted for their lanes): `rig.openFolder` / `revealFile` / `openDoc` (NATIVE-GAPS 1b rows 4-6; N5 menus).
- n0-skeptic O2 (N8): settings-mac.js treats `rig.platform !== 'darwin'` as non-Mac; native reports 'macos'. Not
  fixed here.

## Open questions

- Q1 [U, Mac]: does WebKit resolve a `blob:` URL for `fetch()` from a `rig://app` page? The listener depends on it
  (the helpers do not: they never make a blob in the app). If not, the listener's read fails with a warn and nothing
  is saved for that one click (no navigation either); the helpers' path is unaffected.
- Q2 [U, Mac]: does a detached `<a download>` click become a WKDownload in WebKit (self-test `files-download`, not
  required)? Nothing in the app clicks a detached anchor today.
- Q3 (design, Ryan if he cares): the callers' toasts ("Library exported", "Exported …") show before the save panel
  answers, as in Chrome; a Cancel in the panel still leaves that toast. Not changed (it would mean editing 3 callers
  for a native-only difference).

## Report (builder, 2026-11-28)

**What was built**
- `app/js/native-shell/30-files.js` (gated on `rig.shell === 'native'`): `rig.saveText(name, text)` → `rigShell
  {m:'saveFile'}`; plus a window capture-phase click listener that takes over every `<a download>` on `blob:` /
  `data:` (default prevented, content read at once, saved as text or base64). Chrome / Electron never load it.
- App edits (2-3 lines each): `views/settings.js` and `views/edit/lib.js` `download()` return `rig.saveText(...)` in
  the native app; otherwise unchanged. Covers Settings › Export library, Edit's Export library / Export song, the v6
  song menu's Export this song….
- `native/apple/Sources/Shared/RigFiles.swift` (new RigShellFeature + WKDownloadDelegate): `saveFile` → NSSavePanel
  sheet + atomic write on a utility queue (Mac), temp file + `UIDocumentPickerViewController(forExporting:asCopy:
  true)` (iPad); one panel at a time (`busy`); name sanitised; 64 MiB cap; `saveDir` / `RIG_SAVE_DIR` saves without a
  panel. WKDownload fallback: temp destination at once, then the same panel / picker. `runOpenPanel` (macOS):
  NSOpenPanel sheet with the page's multiple / directory flags.
- `RigNavigation.swift`: `.download` for `shouldPerformDownload` on rig/blob/data; main-frame or new-window `blob:` /
  `data:` loads **cancelled** (were `.allow`); `didBecome download` → RigFiles; `runOpenPanelWith` (macOS, LaneR F2);
  `pageCommitted` self-test hook. `RigHost.swift`: `files`, registered on the router, `files.host = self` (weak).
- Self-test step `files` (+ `files-recording`, `files-download`), after `packs`: see MAC_CHECK self-test table.
- Recordings: no download path in the native app (NativeRecorder; the core writes the WAV). Chord chart import and
  every `<input type=file>` need no JS change (NSOpenPanel on the Mac, WebKit's picker on the iPad).

**Test evidence** (Linux, 2-CPU box, tree 712a347, clean; `UI6_PURITY_BASE=origin/v2-native node tools/cloud/gates.mjs`):
shell-unit PASS 32 s · unit PASS 37 s · native-midi PASS 3 s · native-shell PASS 16 s · settings PASS 154 s ·
migration-1x PASS 114 s · ui-core PASS 360 s · ui-v6 PASS 365 s (flag-off purity vs origin/v2-native: identical) ·
ui-v6-edit PASS 383 s (purity identical) · chart PASS 218 s.
- New: `test/unit/native-shell/files.test.mjs` (10), `selftest-scripts` +1 (filesProbe), polyfill method list +
  `saveFile`, native-shell suite: B2 test (7 subtests: recording on MockNative; Settings Export library, Edit Export
  library + Export song, v6 song menu Export, raw WAV-blob and data: `<a download>` clicks all reach `saveFile` with
  the right name / text / bytes; 0 Playwright downloads, 0 main-frame loads, no `rec stop` until the test stops the
  take; Settings › Import… reads a picked file) and the Chrome test checks Export library is still a download with
  the store's JSON. Mutation: 30-files.js disabled → 6 of 7 B2 subtests fail.
- `git diff origin/v2-native...HEAD -- app/js/engine`: empty. tree-sitter-swift 0.7.4: 0 ERROR nodes in all 13
  Shared/*.swift.

**Decisions**
- Two layers in JS (helpers → `saveText`; a listener for any other blob/data `<a download>`) and two in Swift
  (`.download` → WKDownload; cancel non-download main-frame blob/data). The JS listener makes the export path not
  depend on WebKit's download behaviour at all; the Swift layers are the belt.
- One Swift method `saveFile` taking `text` or `base64` (binary-safe for the listener); JS member `rig.saveText`.
- Write failures show a native alert (Mac / iPad) and reply `{error}`; JS only `console.warn`s (zero console.error).
- No accept filter on the Mac open panel (WebKit passes none); the page validates as in Chrome.
- Kept out of scope (row 1b, other lanes): `rig.openFolder` / `revealFile` / `openDoc` (N5 menus), pad files (N4).

**Only a Mac / iPad can verify** (MAC_CHECK): CI mac-check compiles RigFiles.swift / RigNavigation / RigHost /
RigSelfTest and the self-test `files` step passes (`files-recording` required once the recording starts;
`files-download` reported). Step 4 item 5 (save panel, Cancel, Replace, open panel for Settings / Edit / chart
import, export during a recording keeps the take whole, one panel at a time). Step 5 B2 item (Files export picker,
import picker, chart import, export during a recording). Q1 / Q2 above.

**Noted, not fixed:** n0-skeptic O2 (N8): settings-mac.js reads `rig.platform !== 'darwin'` as non-Mac; native says
'macos'.

Tip: see `git log -1 lane-n3` (this report commit, docs only, on top of the gated tree 712a347).

## Skeptic (n3-skeptic, 2026-11-28)

- [x] Read RESUMABLE, LANE, CLAUDE.md, NATIVE-GAPS N3 + finding 8, SHELL.md, n0-skeptic O1
- [x] Rebase: cd377cf at the start (nothing to do); moved to e8bd0c7 (D44, DECISIONS.md only) during the gates:
      rebased cleanly
- [x] JS review + Chromium listener probe (/home/claude/scratch/n3/probe/out.json)
- [x] Swift review (tree-sitter 0 ERROR nodes after the fixes)
- [x] Fixes F1 (toast on {saved}), F2 (safeName bytes + suffix), F3 (iPad swipe dismiss), F4 (failed read → WebKit
      download hand-off), O-mid (auxclick), O-svg
- [x] Gates (UI6_PURITY_BASE=origin/v2-native) 10/10 PASS on tree 641120a (cde92dc, pre-rebase)
- [x] shell-unit, unit, native-shell rerun on the rebased tree 387d42c: PASS (32 s / 35 s / 13 s)
- [x] Report native/docs/reviews/n3-skeptic.md (verdict MERGE)

Findings so far: F1 toasts before the panel answers (fixed); F2 200-character cap is not a byte cap, cuts the
suffix (fixed); F3 iPad picker swiped away may leave `busy` set forever [U] (fixed, belt); O-mid middle-click is
`auxclick` (fixed); O-svg SVG anchor href (fixed); F4 the listener prevents the default before knowing the
blob read works (Q1): a failure saved nothing (fixed: detached-anchor hand-off to WKDownload); O-closed closed shadow roots / detached anchors not seen by the
listener (Swift belt; app has neither); O-hidden a save sheet on a hidden window (menu-bar mode, N7) would be
invisible with `busy` set.
