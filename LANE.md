# LANE R: 2.0 release prep (docs only, no release)

Brief: write docs/release-notes-2.0.md (player-facing changes, 1.x -> 2.0 migration merged in, Known gaps, v6-flag
items marked); update README.md and docs/site/ for 2.0 (screenshots by path only, download page ready for optional
sound packs with no links); add a 2.0 release checklist to native/docs/MAC_CHECK.md (build, sign/notarize as 1.x,
Mac hands-on incl. every open "for Ryan" item from reviews UI6-*.md, iPad install, U9 flag flip, version bumps,
tag/release steps as instructions for Ryan); write native/docs/lanes/U9-review-list.md (every design call / O-item
for Ryan from UI6-*.md and DECISIONS, deduped, grouped by screen). Verify claims against code; tag unverified.
Nothing published, no tags, no pushes.

## Steps
- [x] 0. Read sources (plan Lane R, DECISIONS, migration notes, 1.1.0 notes, README, site, MAC_CHECK, UI6 plan, reviews)
- [x] 1. docs/release-notes-2.0.md (+ migration doc points to it; "1.1.1 to be published" fixed)
- [x] 2. README.md + docs/site/ (site based on origin/main's 1.1.1 page)
- [x] 3. MAC_CHECK.md "2.0 release checklist"
- [x] 4. native/docs/lanes/U9-review-list.md
- [x] 5. Checks: site HTML parse + local links + anchors (0 errors), Chromium render 1280 / 390 px light + dark (no
  horizontal overflow; only file:// font-CORS console errors), build-lint 45/45 (1 skip: no .app on Linux; asar
  80.4 MB). No site / link test exists in test/.

## Final report

**Files changed** (all docs; no app code):
- `docs/release-notes-2.0.md` (new): draft banner; engine, 16 sounds, cue then Go, scenes with Space / Echo / drone,
  MIDI Learn any setting, chord charts, patch packs + Song bank, the new layout (preview), colour-blind colours,
  PANIC / Esc / Lock, size rules (D9 + D33 note), iPad, migration (merged from RELEASE_NOTES_2.0-migration.md),
  install, Known gaps, Editor's notes. "New layout" marks every flag-gated item (main.js: `settings.uiV6 === true`
  gates v6 Perform / Edit / Settings, Song bank browser + Try it, Learn on Perform, Arrange, Save snapshot dialog with
  names and a drone key, song menu, sidebar, chart placements / % sizes; default-on: cue/Go, 16 slots, scenes D26.1,
  MIDI learn in Edit, Chart button, colour-blind, Esc setting, Settings categories).
- `native/docs/RELEASE_NOTES_2.0-migration.md`: kept; points to the release notes; 1.1.1 marked released.
- `README.md`: 2.0 intro, three ways to run, "Not in the 2.0 app yet" list, Get the Mac app (download + native build),
  1.x Electron path kept, 16 sounds, cue then Go, scenes, patch packs, MIDI learn any setting, Panic / Esc / Lock,
  new Settings rows, Chord charts, The new layout, The iPad app, where 2.0 keeps things, native/ for developers.
- `docs/site/index.html` + `style.css`: from origin/main's page (keeps its 1.1.1 lines); 2.0 hero / facts / features,
  What's new in 2.0 cards, Intel / older macOS → 1.1.1, iPad install, "Optional sound packs" list with no links (and an
  HTML comment for Lane P), sizes left as an HTML comment to fill at release, privacy for the 2.0 app. Credits and
  LICENSES.md untouched (credits block byte-identical to main). No images added.
- `native/docs/MAC_CHECK.md`: "2.0 release checklist" (B1–B3 blockers, steps 0–8, screenshots list).
- `native/docs/lanes/U9-review-list.md` (new): 50 numbered items by screen + "Already answered" table.

**Blockers / findings (code read at d35b788, not run on a Mac):**
- F1 / B1: MIDI keyboard input in the native app looks unwired (no `requestMIDIAccess` polyfill in app/js;
  `RigMIDI.listen` connects only `midi listen` ids; nothing sends one). If right, a keyboard plays nothing in the app.
- F2 / B2: no WKDownload handling in RigNavigation.swift: Export library / Export song in the app unverified.
- F3: native app lacks My Samples, patch-pack / Song bank content, GarageBand importer, My Pads, menu bar, global
  hotkeys, update check, MIDI clock out (`/api/health` userSamples/userPatches false; window.rig polyfill =
  backupNow / latestBackup / onMenu). Listed as known gaps; Ryan decides (U9 item 2).
- F4 / B3: release.yml builds Electron on any v* tag; no native Release build or dmg script. The 2.0 app is
  arm64-only, macOS 14.5+; 1.1.x's update check would announce 2.0 to Intel / old-macOS users (U9 item 3).
- F5: v1.1.1 is published (GitHub REST API, 2026-11-26).
- F6: origin/main has 1.1.1-only commits (site line, release.yml `release: published`, release-notes-1.1.1.md,
  package.json 1.1.1); site folded in here, the rest is in checklist step 8.

**Unverified claims** (in the docs, tagged there where player-facing):
- Everything about the native app on real hardware: sound by ear, recording, MIDI, export, first-launch import, iPad
  install / audio session / memory, WebKit storage, trackpad pinch / ⌘-scroll, VoiceOver.
- The README's Release `xcodebuild` line and the checklist's dmg / zip commands (never run; CI and check.sh build
  Debug).
- App size ~100 MB (BUILD_PLAN estimate).
- Colour-blind palettes (simulation only).
- "In-ears only" Outputs 3–4 click in the native app (the site keeps the 1.x sentence).
- Pack descriptions on the site (VSCO 2 CE contents, Karoryfer titles from AWAY_WEEK_PLAN Lane P).

**Lane tip:** see `git log -1` on lane-r (this commit). Not pushed.

## Open questions
- All in native/docs/lanes/U9-review-list.md section 1 (tier 1) for Ryan.

## Skeptic (Lane R review, 2026-11-27)

Brief: check every factual claim in the Lane R docs against the code on lane-r, DECISIONS, CONTRACT_CHANGES and the
merged UI6 reviews; fix on lane-r; write native/docs/reviews/LaneR.md. Docs only: no browser suites.

- [x] 0. Rebase: lane-r already sits on origin/v2-native tip d35b788 (nothing to rebase)
- [ ] 1. release-notes-2.0.md: v6 flag marks vs main.js / views; default-on items
- [ ] 2. Known gaps vs Swift shell (scheme handler, RigLibrary, menus); B1–B3 wording
- [ ] 3. Size text vs D9 + D33 O4; hardware vs project.yml
- [ ] 4. README + site (+ HTML parse / link check; credits / LICENSES unchanged)
- [ ] 5. MAC_CHECK 2.0 checklist
- [ ] 6. U9 list vs reviews + D26–D34
- [ ] 7. Review doc LaneR.md, final report

Findings so far: (none yet)
