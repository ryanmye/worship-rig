# Lane N0 skeptic review: native shell surface (polyfill files, capability flags, getInfo, O3 / O5)

Reviewer: n0-skeptic, 2026-11-27. Branch `lane-n0-tip`. The builder's tip was 6b334cf: 6 commits on origin/v2-native
c7bccec, worktree /home/claude/wt-n0g. I did not touch /home/claude/wt-n0, the conflicted worktree from the builder's
INCIDENT. I rebased twice:

1. onto 3f5bf2c (core3f);
2. onto 0cc56b7, after lane N1 merged.

I re-ran every gate on the final tree. I took none of the builder's numbers on trust.

## Verdict: MERGE (after the fixes below, which are on the branch)

- Chrome and Electron behave as before. No page imports or requests the files under `app/js/native-shell/`; the
  native-shell suite asserts 0 requests, 0 console errors and no HTTP ≥ 400. Every changed gate reduces to the old
  `isElectron` value when `rig.shell` is not `'native'`. `app/js/engine` is untouched (the diff is empty).
- The native app claims nothing it lacks. Each native feature is gated on its own member: `backupNow`, `getInfo`,
  `choosePadFolder` / `listPads` (N4), and `setMenuBarMode` / `setLoginItem` / `setHotkeys` / `setUpdateCheck`
  (N7–N9).
- It hides nothing it has. Backups, latest backup and About all show.
- I read the Swift line by line and found no compile error. It follows the same patterns that CI mac-check already
  compiles: WeakReplyHandler, RigLibrary's old reply-handler conformance, and the self-test's split Bools.

## Fixes made (commits `n0-skeptic: …`)

| id | what | where |
| --- | --- | --- |
| F1 | The "Audio restarted, so the recording was split" toast ended with "(downloaded when you stop)" in the native app. That is Chrome's OPFS wording; the native core writes the file itself. Now it is shown in Chrome only. | controller.js `resumeRecording` |
| F2 | The Settings MIDI line for a `denied` reason in the native app said "allow it in the browser's site settings". The native app now uses the app text, as Electron does. Today the line is unreachable there: NativeMidiAccess rejects with bridge codes, never SecurityError. | settings.js (`midiStatusText(m, isApp, nativeShell)`) |
| F3 | The beforeunload guard was an `isElectron` gate meaning "Chrome tab" (it arms once audio has run). That broke the lane's acceptance line "no isElectron gate whose meaning is 'Mac app'", because the guard was armed in the native app too. Now the native app is recording-only, like Electron. As far as I know, WKWebView has no public beforeunload prompt, so the change should be invisible there. [unverified: whether WebKit then allows or silently blocks a reload is Mac-only] | main.js beforeunload |
| N1 merge | `getInfo().userSampleRoots` returned `[]`; it is now `RigPaths.userSampleRoots` (N1 added them). `userSamplesDir` stays null on purpose. A path there would make Settings › My Samples show the iPad container path again instead of N1's "On My iPad › Worship Rig › Samples" (n1-skeptic O3), because settings.js prefers `getInfo().userSamplesDir` over `/api/user-samples`. Comments and CONTRACT_CHANGES updated. | RigShellRouter.swift `RigInfo`, 20-info.js, CONTRACT_CHANGES "N0" |
| rebase | Conflicts on CONTRACT_CHANGES: I kept both core3f and N1 above N0. On selftest-scripts.test.mjs: I kept both `packsProbe` (N1) and `shellProbe` (N0) in the raw-string check. RigSelfTest.swift merged cleanly. The step chain is boot → shell → audio → note → migration → packs → end, with no step skipped. | |

## Review notes (what I checked and why it holds)

### Chrome / Electron purity

- `app/js/native-shell/*.js`: only RigShellScripts (Swift) and the tests reference them. No `.html` file, module
  import or service worker does. In Electron they ship inside `app/` (a few KB) but are never loaded.
- Controller: `menuOwnsShortcuts = isElectron || native && rig.menuOwnsShortcuts === true`. `keepsAwake` follows the
  same pattern. `installShellHook`: Electron still replaces `__rigShell` and deletes it on stop; Chrome still does
  nothing. Covered by shell-unit `native-shell.test.mjs`: "Electron unchanged" and "Chrome unchanged".
- Settings: Electron has `isApp = macFeatures = shellBackups = canPadFolder = true` and `menuBarRows = true`, so it
  takes the same branches as before. Chrome has `!rig`, so every new value equals the old `isElectron` (false) and
  `menuBarRows` is true (the old Chrome copy). The v6 summaries get `electron: shellBackups`, which equals
  `isElectron` outside native.
- Purity is also enforced by the ui-v6 / ui-v6-edit flag-off checks against origin/v2-native (gates below).

### `rig.shell === 'native'` gates: no claimed or hidden features

Every remaining `isElectron` gate means "the Electron process", or is harmless in native:

- heartbeat: http only;
- `recorder.start` sink: ignored by NativeRecorder;
- the FSA pad reattach: no FSA in WKWebView;
- `checkOtherLibrary` (M5 ports): native getInfo gives `otherLibrary: null`;
- `backupFromThisMachine`: native always sends `via`;
- `openMain` focus: harmless.

Feature by feature:

- **Mac category.** It shows in native only once a Mac-only member exists. In N0 its one row (Low-resource) stays
  in Look under the title "Low-resource mode". The menu-bar rows, the mini-panel button (LaneR O1) and the "Open at
  login is available in the Mac app" hint are all hidden.
- **Library & Backup.** Back up now is shown, because `rig.backupNow` exists. Automatic backups were already running
  in native: `scheduleBackup` keys on `rig.backupNow`, so the v6 summary "automatic backups" is true. Import latest
  backup is shown, because `rig.latestBackup` exists.
- **About.** Shows Version (Mac app | iPad app), Build, Backups and Recordings. There is no Electron row and no
  local-server row.

### `__rigShell` merge and shortcuts

- The controller does `Object.assign`s `recording` / `library` into the shell's object. `stop()` deletes only keys
  whose value is still its own.
- `onMenu` registration and `installShellHook` run inside `controller.start()`, before `__rig.ready` (= `started`)
  resolves. So the self-test `shell` step's single-shot `menuReady()` / `merged` check does not race the boot.
- `menuOwnsShortcuts` is false on both platforms (`RigHost.shellConfig`). With true, ⌘. ⌘E ⌘R ⌘⇧F would be dead
  until N5, because the only SwiftUI command is ⌘⇧I (Import Library Backup) and nothing else binds them. With false,
  the page's keydown handles them, and nothing native double-fires.

### Page-load release (O5): `didCommit` → `play panic` + `rec stop`

- **Main frame only.** The public `WKNavigationDelegate` callbacks have no subframe or same-document
  (hash / pushState) variant: WebKit reports those only through SPI. So a fragment change or an iframe cannot
  trigger the release.
- **`play panic` is the core's `allNotesOff`, which leaves the drone alone by contract.** The 1.x rule "PANIC never
  stops the song's drone" holds. The orphaned-drone stop (`droneOffIfOrphaned`) is controller state of the live
  page, and the shell cannot know it; the new page's controller reconciles its drone on boot. So a reload never
  stops a song's drone. That is correct, and it is the same as before.
- **`rec stop` with nothing recording is a no-op in the core.** `RecServiceImpl::stop` returns a zero result and
  emits nothing. With a recording, it emits `rec stopped`. That event reaches the new page, because the pump queue is
  kept, and NativeRecorder ignores it while idle. The old page's `pagehide` already sends `rec stop`, so this is the
  belt for a page that dies without `pagehide`.
- **Ordering.** didCommit is sent before the new document's subresource (module) loads go through the scheme
  handler, so it should normally reach the core before the new page's `hello`. Even if it lands after `hello`, it
  can only cut notes played in the first milliseconds after load, and the page cannot be recording yet.
- **Commits that are not reloads:** the crash path posts twice (harmless) and the crash-loop page commits too
  (harmless). See O1 for Export.

### native-midi.js first-listen retry (O3)

- **Bounds.** 5 attempts on timers: at 0, +1 s, +2 s, +4 s and +8 s (15 s in all). After that it retries only on a
  `ports` event. It retries only for `timeout` / `busy` / `not-started` / `internal`; any other code rejects at once.
- **No busy loop.** `_attempt` clears `_retry` synchronously, so a `ports` storm during an in-flight attempt triggers
  nothing. Each `ports` event while armed causes at most one attempt.
- **No duplicate listeners.** The `midi` listener is added once, in the constructor. After success `_retry` stays
  null, so later hot-plugs only apply ports.
- **Stale snapshots.** A stale reply snapshot is dropped through `_portsSeq`.
- **Dispose.** `dispose()` clears the timer, and `_disposed` stops a reply that lands late.
- **Tests.** native-midi-retry.test.mjs has 5 tests: timeout → success; busy ×5 → hot-plug success; hot-plug during
  the wait cancels the timer; non-retryable rejects; dispose.
- **Cost (by design, the builder's risk note).** A retryable error with no hot-plug keeps `requestMIDIAccess`
  pending forever, so the lamp stays on "Starting…".

### Swift (read, not built)

- **RigShellRouter.** Its conformance and replyHandler forwarding are identical in shape to WeakReplyHandler, which
  CI already compiles. `RigShellFeature: AnyObject`, so `RigLibrary` (NSObject) and `RigInfo` (plain final class)
  conform. RigLibrary's `reply replyHandler:` matches the requirement's `reply:` label. There is no leftover
  `WKScriptMessageHandlerWithReply` use of RigLibrary, and no reference to the removed `documentStartScript` or
  `polyfill(`.
- **Retain graph.**
  - The host holds the router; the router holds its features; `RigLibrary.host` is weak.
  - `WKUserContentController` holds only `WeakReplyHandler(router)`.
  - No cycles.
- **Threads.**
  - The router is called on main.
  - RigLibrary replies through `DispatchQueue.main.async`, unchanged.
  - `didCommit` is on main, and `post()` is the same `rig_post` the crash path already uses from main.
  - `RigShellScripts.documentStart` reads a few KB from the bundle synchronously at init. That is acceptable, and it
    runs before `webView.load`.
- **Init order.** `shellRouter` is set before `super.init()`, and nothing there touches `self`. `RigHost.shellConfig`
  and `platformName` are static.
- **iPad.** `RigInfo.info` puts `userData` under `#if os(macOS)`. `RigPaths.supportDirName` is not platform-guarded
  anyway.
- **Concurrency risk (low).** The protocol's `reply` is a plain closure, while newer SDKs import the WK replyHandler
  as `@MainActor @Sendable`. In Swift 5.9 with minimal checking, converting it is at most a warning, and
  WeakReplyHandler already does exactly this.
- **Self-test.** The `shell` step uses split Bool lets. Its probe is a raw string with no interpolation, and the node
  test compiles it.

### Settings wording under the native shell

- No "Chrome", "In Chrome", "mini panel" or "Local server" text appears in About, Library & Backup or the Look
  section. This is asserted by the native-shell suite, Mac and iPad.
- One "Chrome" mention is deliberate: the Library hint "To bring one from Chrome or Worship Rig 1.x, Export there and
  Import here".
- My Samples' GarageBand Terminal steps are the remaining Chrome-era copy, and they belong to N2 / N6.
- After N1, `/api/health` says `userSamples: true`, so N0's native note "My Samples isn't in this version of the app
  yet" no longer shows. That is consistent: N1 made the folder real.

## Gates (tools/cloud/gates.mjs, UI6_PURITY_BASE=origin/v2-native, final tree, clean)

Tree d2e43ea (rebased on origin/v2-native 0cc56b7, N1 included), clean, Linux 2-CPU box, one suite at a time.

| suite | result | time |
| --- | --- | --- |
| shell-unit | PASS | 34 s |
| unit | PASS | 33 s |
| native-midi | PASS | 3 s |
| native-shell (new, 10 checks) | PASS | 9 s |
| settings | PASS | 136 s |
| migration-1x | PASS | 75 s |
| ui-core | PASS | 305 s |
| ui-v6 (incl. flag-off purity vs origin/v2-native: identical) | PASS | 253 s |
| ui-v6-edit (purity: pass) | PASS | 279 s |

`git diff origin/v2-native...HEAD -- app/js/engine`: empty. The report commit touches only this file (docs), so the
passes stand for it.

## Open (not fixed here)

- **O1 (N3).** Export uses `<a download>` on a `blob:` URL, and RigNavigation answers `.allow`. If WebKit commits
  that as a main-frame navigation instead of a download (NATIVE-GAPS finding 8, [U]), the UI is replaced. Since N0,
  that commit also posts panic + rec stop, so an Export during a recording would end the take. N3's plan already
  cancels non-download `blob:` / `data:` main-frame navigations. Until then, Export in the native app is an
  unverified path regardless of N0.
- **O2 (N8).** settings-mac.js reads `rig.platform !== 'darwin'` as non-Mac, but the native value is `'macos'`. The
  builder noted this.
- **O3.** A retryable first-listen failure with no hot-plug leaves "Starting…" on the lamp forever. That is the
  builder's design. A "keep trying" hint after the 15 s backoff would be kinder (UI follow-up, not N0).
- **O4.** NATIVE-GAPS row 1c suggested iPad backup copy naming Files › Backups. N0 shows the generic "This app keeps
  its own library…" line. Optional.

## Mac / iPad only

- CI mac-check compiles RigShellRouter.swift and the edits. The self-test `shell` step must pass: the files are
  found in the bundle and injected, getInfo's version equals the bundle's, `menuReady` is true, and the merge kept
  `menu`. The `migration` and `packs` steps must still pass.
- MAC_CHECK step 4 item 16:
  - About has no Chrome or Electron rows.
  - There is no Mac category.
  - Back up now writes a file.
  - Reload with a chord and the pedal held: silence after the reload, the drone kept, and the recording closed and
    playable.
  - ⌘. ⌘E ⌘R ⌘⇧F each act exactly once. Also check that WKWebView delivers ⌘. to the page and does not eat it as
    `cancelOperation:`.
  - Late MIDI connects without a reload.
- Step 5: iPad About says "(iPad app)". Check that hardware-keyboard ⌘ shortcuts reach the page.
- F3: after audio has run, a Settings › My Samples "Reload" (`location.reload()`) reloads; nothing silently blocks it.
- O1: Export library in the Mac app. Does it download, or replace the UI? Run it while recording too.
