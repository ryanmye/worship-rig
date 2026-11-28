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
- [ ] JS: app/js/native-shell/30-files.js (`rig.saveText`, the `<a download>` blob:/data: click intercept)
- [ ] App: settings.js + edit/lib.js `download()` try `rig.saveText` first (native only)
- [ ] Swift: RigFiles.swift (saveFile: NSSavePanel / UIDocumentPicker forExporting; WKDownload fallback; NSOpenPanel)
- [ ] Swift: RigNavigation (cancel main-frame blob:/data:, `.download` for shouldPerformDownload, didBecome download,
      runOpenPanelWith), RigHost registers RigFiles
- [ ] Self-test `files` step (RIG_SAVE_DIR / saveDir, exact bytes, URL unchanged, no commit, recording survives)
- [ ] node unit tests (30-files.js in vm; polyfill method list; selftest filesProbe)
- [ ] Playwright native-shell: exports via saveText, no download / navigation, recording survives; Import… round trip;
      Chrome unchanged (download event, exact bytes)
- [ ] Docs: CONTRACT_CHANGES "N3", MAC_CHECK step 4/5 items, SHELL.md, NATIVE-GAPS status
- [ ] Gates (UI6_PURITY_BASE=origin/v2-native): shell-unit, unit, native-midi, native-shell, settings, migration-1x,
      ui-core, ui-v6, ui-v6-edit, chart
- [ ] Final report below, tip SHA

## Next step

JS 30-files.js.

## Findings / notes

- Recordings: under the bridge engine recorder.js returns NativeRecorder (the core writes the WAV), so no download
  path is reached in the native app. `downloadBlob` (OPFS / memory sinks) is Chrome only. The click intercept still
  covers it.
- Pad files (Settings › Choose pad files, `<input type=file>` → blob: URLs the core cannot open) belong to N4.
- Not in N3 (noted for their lanes): `rig.openFolder` / `revealFile` / `openDoc` (NATIVE-GAPS 1b rows 4-6; N5 menus).
- n0-skeptic O2 (N8): settings-mac.js treats `rig.platform !== 'darwin'` as non-Mac; native reports 'macos'. Not
  fixed here.

## Open questions

(none yet)
