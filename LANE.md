# LANE N0 (builder): native shell surface — polyfill files and capability flags

Brief (orchestrator, D35 wave 1): move the `window.rig` polyfill out of the Swift string into injected JS files under
app/ (one per feature, loaded only in the native shell: Chrome / Electron make no new requests), one thin Swift
handler per feature behind a router; a capability flag (`rig.shell === 'native'`) replacing `isElectron` gates where
the native app has the feature, Electron unchanged; `getInfo` for Settings › About; no Chrome wording in About and
Library & Backup under the native shell; the Menu-bar section and the dead "Open mini panel" button (LaneR O1)
hidden until N7; the controller merges into `__rigShell` and never replaces it; NMA O5 (shell `play panic` on every
page load) and O3 (the MIDI adapter retries a failed first `midi listen`: backoff, then the next hot-plug). Swift
thin (compiled only by CI mac-check); JS testable on Linux (MockNative, boot-mock); MAC_CHECK steps for the rest.
Gates (UI6_PURITY_BASE=origin/v2-native): shell-unit, unit, native-midi, ui-core, ui-v6, ui-v6-edit, settings,
migration-1x (+ any new suite). app/js/engine untouched. No push.

Worktree /home/claude/wt-n0, branch lane-n0 from origin/v2-native c7bccec.

## Steps
- [x] 0. worktree, read the brief inputs, LANE.md
- [x] 1. polyfill files app/js/native-shell/*.js + test/unit/native-shell (fake shell, vm)
- [x] 2. Swift: RigShellRouter (router + features), script loader, RigLibrary as a feature, RigInfo (getInfo),
        panic + rec stop on every main-frame commit, self-test `shell` step
- [x] 3. app edits: controller (menuOwnsShortcuts, keepsAwake, __rigShell merge), settings / v6 settings (Mac
        category, About, backups copy, Menu bar, MIDI text), main.js MIDI texts, pad gates
- [x] 4. native-midi.js: first-listen retry (backoff, then next `ports`) + unit tests
- [x] 5. Playwright: native-shell suite (real app, bridge-mock, real polyfill files); migration-1x repointed
- [ ] 6. docs: CONTRACT_CHANGES, SHELL.md, MAC_CHECK, NATIVE-GAPS note, release notes
- [ ] 7. gates via tools/cloud/gates.mjs; final report here

## Next step
6. docs (CONTRACT_CHANGES, SHELL.md, MAC_CHECK, ENGINE_CONTRACT adapter note, NATIVE-GAPS, release notes); then gates.

## Findings / decisions so far
- Files go under `app/js/native-shell/` (brief), not `native/apple/Resources/shell/` (plan): app/ is already a folder
  reference in both targets (project.yml), so no new resource phase; Chrome / Electron never request them.
- Plan says `menuOwnsShortcuts` Mac true: wrong for N0. Nothing binds ⌘. ⌘E ⌘R ⌘⇧F natively until N5, so true now
  would leave them dead. Shipped false on both platforms (Swift `RigHost.shellConfig`); the controller honours it.
- Plan says the Mac category shows for `isMacApp`: in N0 it would hold only Low-resource. Instead it appears in the
  native app once a Mac-only member exists (setMenuBarMode / setLoginItem / setHotkeys / setUpdateCheck: N7-N9);
  until then the section stays in Look as "Low-resource mode" (no menu-bar rows, no mini panel, no login hint).
- Page-load release (O5): `RigNavigationDelegate.didCommit` → `RigHost.pageDidCommit` posts `play panic` AND
  `rec stop` (the crash path's pair; SHELL.md "Recording ownership" already says a reload stops the recording, but
  only the crash path did). The pump queue is not dropped there (didCommit may arrive after the new page's hello).

## Open questions
- Settings in the native app (probe .probe/chrome-words.mjs, bridge-mock + real shell files): the only Chrome /
  browser / Terminal words left are the GarageBand Terminal steps in My Samples (N2 / N6) and "bring one from
  Chrome" in the new Library hint (intended).
- Pre-existing race (not N0): opening Settings before main.js's lazy settings mount finishes (`__rig.viewsReady`)
  shows the placeholder, which the mount then hides again (body keeps `settings-open`). A native ⌘, (N5) right at
  launch could hit it; the suite waits for viewsReady.
