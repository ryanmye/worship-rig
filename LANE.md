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
- [ ] 1. polyfill files app/js/native-shell/*.js + test/unit/native-shell (fake shell, vm)
- [ ] 2. Swift: RigShellRouter (router + features), script loader, RigLibrary as a feature, RigInfo (getInfo),
        panic + rec stop on every main-frame commit, self-test `shell` step
- [ ] 3. app edits: controller (menuOwnsShortcuts, keepsAwake, __rigShell merge), settings / v6 settings (Mac
        category, About, backups copy, Menu bar, MIDI text), main.js MIDI texts, pad gates
- [ ] 4. native-midi.js: first-listen retry (backoff, then next `ports`) + unit tests
- [ ] 5. Playwright: native-shell suite (real app, bridge-mock, real polyfill files); migration-1x repointed
- [ ] 6. docs: CONTRACT_CHANGES, SHELL.md, MAC_CHECK, NATIVE-GAPS note, release notes
- [ ] 7. gates via tools/cloud/gates.mjs; final report here

## Next step
1.

## Findings / decisions so far
- Files go under `app/js/native-shell/` (brief), not `native/apple/Resources/shell/` (plan): app/ is already a folder
  reference in both targets (project.yml), so no new resource phase; Chrome / Electron never request them.

## Open questions
