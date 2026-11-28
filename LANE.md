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
- [x] 6. docs: CONTRACT_CHANGES, SHELL.md, MAC_CHECK, NATIVE-GAPS note, release notes
- [x] 7. gates via tools/cloud/gates.mjs; final report here

## Next step
Done (report below). Orchestrator: see INCIDENT, then fast-forward lane-n0 to lane-n0-tip.

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

## INCIDENT (needs the orchestrator): a foreign stash was applied to this worktree
At 9e7e887 (tree clean) I ran `git stash -q && <parse> ; git stash pop -q` to compare a parse before / after. With
nothing to stash, `stash pop` applied the repo-wide **stash@{0} "WIP on lane-u4: 28544f2 …"** (another lane's, shared
across worktrees) into wt-n0: conflicts in app/js/views/v6/perform.js, app/styles-v6.css, test/phase2/ui-v6/run.mjs
(UU). The stash entry was kept (still stash@{0}). Reverting the three files was refused by the permission classifier,
so they are left as they are. **To fix:**
`git -C /home/claude/wt-n0 restore --source=HEAD --staged --worktree -- app/js/views/v6/perform.js app/styles-v6.css test/phase2/ui-v6/run.mjs`
None of my work is in those three files (all N0 work up to 9e7e887 is committed). Until then nothing can be committed
on lane-n0 (unmerged index), so later N0 edits sit uncommitted in the worktree.

## Final report (builder N0)

**Where the work is.** lane-n0 tip 9e7e887 (all code + tests). The docs, the report and one Swift tidy-up are one
more commit on **branch `lane-n0-tip`** (worktree /home/claude/wt-n0g, made from 9e7e887 because wt-n0's index holds
the foreign stash, see INCIDENT). After the restore command above: `git -C /home/claude/wt-n0 merge --ff-only
lane-n0-tip`, then delete wt-n0g and lane-n0-tip. Not pushed.

**Changes**
- `window.rig` moved out of Swift into `app/js/native-shell/{00-core,10-library,20-info}.js` (classic scripts;
  injected by `RigShellScripts` after `window.__rigShellConfig = {keepsAwake, menuOwnsShortcuts, platform}`; never
  requested by Chrome / Electron). New RigShellRouter.swift: `RigShellFeature` protocol, `RigShellRouter` (the
  `rigShell` handler, dispatch by `m`), `RigShellScripts`, `RigInfo` (getInfo). RigLibrary is now a feature (its
  string polyfill and WK conformance removed; behaviour unchanged). RigHost registers both features.
- Flags: `rig.shell === 'native'`, `rig.platform`, `rig.menuOwnsShortcuts`, `rig.keepsAwake` (both false until N5).
  The controller honours the last two; merges `recording` / `library` into `__rigShell` (never replaces it; dispose
  removes only its own). Electron and Chrome paths unchanged.
- Settings (native): About from getInfo (version (Mac app | iPad app), build, folders; no Electron / local server
  rows); Library & Backup app copy + Back up now; LaneR O1: Menu-bar rows, the mini-panel button and the login hint
  hidden until `setMenuBarMode` / `setLoginItem` exist; the section reads "Low-resource mode"; no Mac category until
  a Mac-only member exists; app MIDI "starting" text, no permission probe; My Samples "not in this version yet";
  v6 About / Library summaries. Pad gates accept the native shell once it has `choosePadFolder` / `listPads` (N4).
- NMA O5: `didCommit` → `RigHost.pageDidCommit` posts `play panic` + `rec stop` on every main-frame load.
- NMA O3: NativeMidiAccess retries a failed first `listen` (timeout / busy / not-started / internal) after 1, 2, 4,
  8 s, then on each `ports` event; requestMIDIAccess stays pending (controller shows "MIDI starting").
- Self-test: new required step `shell` (`shellProbe`).
- Docs: CONTRACT_CHANGES "N0", SHELL.md, ENGINE_CONTRACT (adapter), MAC_CHECK (step 4 item 16, step 5, self-test
  row + JSON), NATIVE-GAPS (N0 as built), release notes editor's note 3.

**Tests added**: unit test/unit/native-shell/polyfill.test.mjs (12) + fake-shell.mjs (shared helper);
test/unit/selftest (+1 shellProbe); test/unit/engine-bridge/native-midi-retry.test.mjs (5); shell-unit
test/phase1/shell/native-shell.test.mjs (7); new suite `native-shell` (test/phase2/native-shell, registered in
run-all: 10 Playwright checks, Mac / iPad / Chrome); migration-1x browser.pw.mjs now runs the real shell files.

**Gates** (tools/cloud/gates.mjs, UI6_PURITY_BASE=origin/v2-native, tree 9e7e887 clean, in wt-n0g): shell-unit PASS
39 s, unit PASS 37 s, native-midi PASS 4 s (9/9), native-shell PASS 13 s (10/10), settings PASS 157 s, migration-1x
PASS 128 s, ui-core PASS 342 s, ui-v6 PASS 286 s (flag-off purity vs base: pass), ui-v6-edit PASS 281 s (purity:
pass). After the docs commit: unit + shell-unit rerun (see below). app/js/engine untouched (`git diff
origin/v2-native --stat -- app/js/engine` empty). tree-sitter-swift: 0 ERROR nodes in all 12 Shared/*.swift.

**Mac / iPad only** (MAC_CHECK): CI mac-check compiles RigShellRouter.swift and the edits, and the self-test `shell`
step proves the files are found in the bundle and injected, getInfo answers with the bundle version and the merge
kept `__rigShell.menu` (the migration step must still pass). Ryan step 4 item 16: About / no Chrome wording / no Mac
category / Back up now; reload with notes held and a recording running (O5); ⌘ shortcuts act once; late MIDI.
Step 5: iPad About.

**Risks**
- Swift unbuilt: `RigShellFeature` handing the WK `replyHandler` through a plain `@escaping (Any?, String?) -> Void`
  (same type the old RigLibrary method declared, so it should compile as that did); a split boolean in stepShell to
  stay clear of the type checker's limit.
- didCommit ordering vs the new page's messages: panic / rec stop may reach the core after the new page's `hello`;
  harmless (nothing is held yet), and the pump queue is deliberately not dropped there.
- `rec stop` on every load also ends a recording on a deliberate reload (as 1.x did; SHELL.md already said so).
- The first-listen retry keeps requestMIDIAccess pending indefinitely for a retryable error with no hot-plug: the
  lamp stays "Starting…" instead of "Error" (by design; the old behaviour was "failed" for the page's life).
- Not mine but seen: opening Settings before `__rig.viewsReady` shows the placeholder that the mount then hides
  (pre-existing; N5's ⌘, at launch could hit it). settings-mac.js treats `rig.platform !== 'darwin'` as non-Mac
  (Electron's value): N8 must map 'macos'. My Samples' GarageBand Terminal steps are the only Chrome-era copy left
  (N2 / N6).
