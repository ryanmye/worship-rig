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
- [x] 1. docs/release-notes-2.0.md
- [ ] 2. README.md + docs/site/
- [ ] 3. MAC_CHECK.md 2.0 release checklist
- [ ] 4. native/docs/lanes/U9-review-list.md
- [ ] 5. Checks (site/link tests, build-lint), final report here

## Next step
2. README.md + docs/site/ (base the site on origin/main's index.html, which has the 1.1.1 lines).

## Findings / unverified claims
- F1 (blocker candidate, code read): native app MIDI input unwired: no requestMIDIAccess polyfill in app/js
  (ENGINE_CONTRACT §5 / WEBKIT_AUDIT 5), RigMIDI.listen connects only `midi listen` ids, nothing in app/js sends one.
- F2 (code read): no WKDownload handling in RigNavigation.swift: Export library / Export song in the native app.
- F3 (code read): native app lacks My Samples, patch packs / Song bank content, GarageBand importer, My Pads, menu
  bar, global hotkeys, update check, MIDI clock out (RigSchemeHandler /api/health, RigLibrary window.rig polyfill).
- F4: no native release pipeline: release.yml builds the Electron app; native is arm64-only, macOS 14.5+.
- F5: 1.1.1 is published (GitHub API: release v1.1.1, 2026-11-26); migration draft still said "to be published".
- F6: origin/main has site / release.yml changes v2-native lacks (1.1.1 line, releases/latest link, release: published).

## Open questions
