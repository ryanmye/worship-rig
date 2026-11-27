# Lane R (2.0 release prep docs): skeptic review (2026-11-27)

Lane `lane-r`, builder tip f3a0b18 on `origin/v2-native` d35b788 (no rebase needed: nothing new upstream). Docs-only
review: code, git and the docs were read; the site got an HTML parse and a local link / anchor check. No browser or
Electron suites were run (two heavy agents share this 2-CPU box), and nothing was run on a Mac.

Checked: `docs/release-notes-2.0.md`, `README.md`, `docs/site/index.html` + `style.css`, `native/docs/MAC_CHECK.md`
"2.0 release checklist", `native/docs/lanes/U9-review-list.md`, `native/docs/RELEASE_NOTES_2.0-migration.md`, against
`app/js` (main.js, store.js, controller.js, views), `native/apple` (project.yml, Sources/Shared/*.swift,
scripts/build-core.sh), `.github/workflows/release.yml`, `update-check.js`, DECISIONS (D1–D34), CONTRACT_CHANGES
(C-SHIP, FU2, CVD2, CORE3), PARITY.md, SHELL.md, WEBKIT_AUDIT.md and the merged reviews `UI6-*.md`.

## Verdict

**VERIFIED after fixes.** The builder's text was largely right; the "New layout" marks, the size rules, the
hardware floor and the licences all hold. Thirteen findings were fixed on lane-r, in four commits. Two open items are
for the orchestrator (app code, not docs). Everything about the native app on real hardware stays unverified, as the
docs themselves say.

## What holds (checked, no change)

- **"New layout" marks.** Everything marked is behind `settings.uiV6 === true` (main.js `performView` /
  `loadEditV6`, views/v6/*): v6 Perform, Edit and Settings, the Song bank browser and Try it (views/v6/bank), Learn on
  Perform (v6/learn-mode.js), Save snapshot's name and drone key (v6/dialogs.js), the song menu, the sidebar,
  Arrange, chart placements and % sizes (v6/chart), Edit's Chart button (v6/edit/edit.js). Unmarked items are on by
  default: cue, then Go (views/perform.js, LOCK table "Prev / Next-Go / setlist tap (cues)"), 1–16 slots, scenes
  with Space / Echo / drone (shared/scenes.js D26.1), MIDI learn in today's Edit (views/edit/learn-menu.js), chord
  charts (`settings.chartView !== false`, D33 / C-SHIP; today's row Look › Perform view › Chord charts), colour-blind
  colours on both layouts (main.js applyCvd, D32), Esc always panics (Keyboards & MIDI), the Settings categories.
- **Size text** matches D9 and the D33 O4 note: `LIBRARY_MAX_CHARS` 2,000,000 warns (once, then +10 %),
  `LIBRARY_RESTORE_MAX_CHARS` 2,500,000 for a whole-library replace / restore, a merge must fit 2,000,000, add /
  duplicate refused only past 2,500,000. `setChart`, `addPackSong` and `topUpPacks` still stop at 2,000,000: the CAP
  task (lane-core3f) is not merged, and the notes don't claim it is.
- **Hardware**: `project.yml` macOS 14.5 / iOS 17.5, `LSMinimumSystemVersion` 14.5; `build-core.sh` builds arm64
  slices only, so Apple Silicon only (the Release line's `ARCHS=arm64` matters: project.yml sets no ARCHS).
- **Known gaps** (My Samples, packs / bank content, GarageBand importer, My Pads, menu-bar mode, shortcuts, update
  check, MIDI clock out): `/api/health` says `userSamples: false, userPatches: false`; `window.rig` is backupNow /
  latestBackup / onMenu with `isElectron: false` (no choosePadFolder, setUpdateCheck, setHotkeys, setLoginItem); no
  `showDirectoryPicker` in WebKit. Recording is wired (`NativeRecorder`, `RigPaths.recordingsDir`).
- **Licences**: `LICENSES.md` identical to origin/main and d35b788; the site's credits block unchanged vs main;
  Musyng Kite's CC BY-SA 3.0 line and its link anchor (`#musyng-kite-soundfont-samples-cc-by-sa-30`) intact.
- **Site**: HTML parse 0 errors (no unclosed or stray tags, no duplicate ids), every local href / src and `#anchor`
  resolves; every `blob/main/…` target exists on lane-r except `docs/release-notes-1.1.1.md`, which is on main
  (comes in with checklist step 8's merge). The new CSS uses only existing variables.
- **README / notes links**: every relative link and `#anchor` resolves (GitHub slug rules).
- Themes: 8 (shared/themes.js), as step 4 item 12 says; `pickAsset` wants `Worship-Rig-<arch>.dmg|zip`; the
  starter library exists; `build-core.sh --mac-only` exists; 1.1.1 is published (D11; builder's F5).

## Findings (all fixed on lane-r)

- **F1 (medium) The iPad app is landscape-only.** Info-iPad in `project.yml` lists only
  `UIInterfaceOrientationLandscapeLeft/Right` and sets `UIRequiresFullScreen`. The notes promised "portrait stacks
  the strips over a panel", MAC_CHECK step 5 checked "Portrait and landscape" and wanted an iPad portrait screenshot,
  and U9 asked about portrait / Split View items as if they could happen. Fixed: the notes and README say the iPad app
  stays in landscape; step 5 and the screenshots say so; new U9 item 51 asks whether to allow portrait; items 35 and
  41 depend on it; editor's note 6. (c119f0a, 983a5a9, 6c36bb6, 4bd1bc0)
- **F2 (medium) File import from the page on the Mac.** `RigNavigationDelegate` is the web view's `uiDelegate` and
  has no `webView(_:runOpenPanelWith:initiatedByFrame:completionHandler:)`; on macOS WebKit shows no file panel for
  `<input type=file>` without it. So Settings › Import…, the chart's Import file and Choose pad files likely do
  nothing in the Mac app (the iPad presents its own picker). B2 covered export only. Also, export answers `.allow`
  (not `.download`) for the `blob:` of an `<a download>`. Fixed: B2, step 4 item 5 and editor's note 2 cover both;
  File › Import Library Backup… (NSOpenPanel) is unaffected. (c119f0a, 6c36bb6)
- **F3 (low) B3 overclaimed.** A `v2.0.0` tag today fails release.yml's "Tag matches package.json version" step
  (package.json 1.1.0 here, 1.1.1 on main), so nothing is published; the Electron-as-2.0 risk starts when step 7 sets
  package.json to 2.0.0. Step 8's "Draft a new release on main" also runs main's release.yml. Fixed. (6c36bb6)
- **F4 (low) U9 asked settled things again.** Item 6 (desktop Auto 128: D5 follow-up, Ryan 2026-11-21), item 8 (PDF
  charts after 2.0: D33), item 25 (chart auto-scroll carries on after a place change: polish batch 1,
  UI6-polish1 "U7b O2, chart resume"), item 27 (Keep wording: polish batch 1, "U7a O4, U7b O3"). Fixed: they point
  to "Already answered" (numbers kept so references hold); MAC_CHECK step 0 / step 4 items 7 and 15 updated.
  (4bd1bc0, 6c36bb6)
- **F5 (low) U9 missed four items for Ryan**: UI6-U8b's "For Ryan: hiding the [Start here] card" in Learn / Arrange
  (now 52); D16's Tone and Snapshots sidebar modules, not built (UI6-U3 O5; now 53); D16 "Still open: whether 'you
  play C' moves into the new song bar", built (now 54); the orientation (F1, now 51). (4bd1bc0)
- **F6 (low) U9 item 7's references didn't resolve**: "ORCH 'Waiting on Ryan'" is ORCH-STATE.md (not in git) and
  DECISIONS has no "dashboard question 7". Now UI6-er O1 and the build plan's "Empty-library silence". Item 1 says B1
  is being built on lane-nma. (4bd1bc0)
- **F7 (low) "110 of them sample for sample".** PARITY's exact tier is max|diff| ≤ 2e-4 (bands 0.25 dB), not
  identical samples. Now "110 also pass the strictest check". (c119f0a)
- **F8 (low) "Next, Prev and one more each way" are pre-built.** The controller pins ±1 in the library, ±2 only in a
  large setlist, the whole setlist when it fits; the core prebuilds those under a 64 MB cap (iPad 32 MB;
  CONTRACT_CHANGES CORE3). Now "Next and Prev at least, as many as fit a memory limit". (c119f0a)
- **F9 (low) Known gaps were incomplete, and the README gave 1.x behaviour to "the Mac app".** Missing in the 2.0
  app: Open at login (Settings › Mac is Electron-only), keeping the screen awake (1.x `powerSaveBlocker`
  'prevent-display-sleep'; the shell asks for nothing like it), most Rig / Help menu items (`WorshipRigApp.swift` has
  one: Import Library Backup…). MIDI clock out hangs on B1 (`setClockSink` sends `config midiClock`, but its port
  comes from Web MIDI). Fixed in the notes' Known gaps, the README ("Not in the 2.0 app yet", Recording, Other handy
  controls) and U9 item 2. (c119f0a, 983a5a9, 4bd1bc0)
- **F10 (low) README "Settings › MIDI Learn"**: in today's 2.0 Settings it is Keyboards & MIDI › MIDI Learn (the v6
  Settings has its own MIDI Learn category, as the notes say). (983a5a9)
- **F11 (low) MAC_CHECK step 7's last bullet was already done** (the migration doc's 1.1.1 line, c7911dd). Removed.
  (6c36bb6)
- **F12 (low) Internal words in player text**: "(U9)", "in this draft (being made to follow the same rule)", "Save and
  Update" under Lock (today's screens have Quick › Save as scene), "no screen says Keys…" (today's still do), and
  "an export … up to 2.5 MB" (only into an untouched library; a merge must fit 2 MB). Fixed; the chart setting's
  new-layout place (Settings › Perform layout) added. (c119f0a)
- **F13 (low) iPad "Import Library Backup…"** is a `CommandGroup` item; iPadOS 17 has no menu bar, so it needs a
  keyboard (⇧⌘I). Notes and README say so. (c119f0a, 983a5a9)

## Open items (not fixed here)

- **O1 (orchestrator, app code) The native app's Settings shows Chrome's Menu-bar section.** With `isElectron`
  false, settings.js places "Menu bar" in Look with "Used by the Mac app. In Chrome, keep this tab open and use the
  mini panel.", "Open at login is available in the Mac app." and an "Open mini panel" button whose
  `window.open('mini.html')` the shell drops (`createWebViewWith` returns nil). Confusing inside the Mac app; a small
  task for the native-gaps lane (hide the section, or word it for the app).
- **O2 (doc nit) SHELL.md is stale on recording**: "recording is unavailable under the bridge" and "Later tasks:
  Recording stream" while `recorder.js` selects `NativeRecorder` for the bridge. Not a Lane R file; left.
- **O3** B1 (lane-nma), B2 and B3 are queued / in flight; the notes' MIDI, export / import and Known-gaps lines must
  be re-read when they merge (editor's notes 1, 2, 3) and the size lines when CAP merges (note 5).
- **O4** The Release `xcodebuild` line (README, checklist step 2) and the dmg / zip commands have never run; CI and
  check.sh build Debug. Already flagged in both places.

## Not verified

- Anything on a Mac or iPad: WebKit's behaviour for `<a download>` with `.allow` and for file inputs without
  `runOpenPanelWith` (F2 is from WebKit's documented macOS behaviour, not a run), MIDI, recording, first-launch
  import, display sleep, the iPad install, sound by ear.
- The 1.1.1 strings quoted in the migration section ("With this computer's device settings", 1.1.1's refusal line):
  they live on `main` / `v1.1.1-prep`; E5's review covered them, not re-read here.
- The site's look (no render this time: the builder's Chromium shots at 1280 / 390 px stand; only text and one HTML
  comment changed since).
- The browser suites: none run (docs-only lane; box shared).

## Commits (skeptic, on lane-r)

- 2308c60 WIP: LANE.md skeptic section
- 7a98b15 WIP: findings in LANE.md before fixing
- c119f0a F1 F7 F8 F9 F12 F13: release notes
- 983a5a9 F9 F10 F13: README
- 6c36bb6 F1 F2 F3 F4 F11: MAC_CHECK checklist
- 4bd1bc0 F4 F5 F6: U9 list
- this doc + LANE.md (the commit that adds this file)
