# LANE N10 (builder): B3 native release build + Electron gate, PREPARE ONLY

Brief: limit release.yml (Electron) to `v1.*` tags (push and `release: published`) so a 2.x tag never builds or
publishes Electron, keeping 1.x releases as today. Add `.github/workflows/release-native.yml` (v2.* tags +
workflow_dispatch, macos-15): core Release build, XcodeGen, `xcodebuild -configuration Release` arm64, ad-hoc codesign,
`Worship-Rig-arm64.zip` + `.dmg` (names per update-check.js), sizes + sha256, self-test on the Release app, upload as
run artifacts; publishing OFF unless dispatch input `publish: true` AND ref is a v2 tag. iPad Release archive if
feasible without a team. Document dry run in MAC_CHECK step 3. Validate YAML locally. Light lane: no browser suites.
Never tag, release or push.

## Steps
- [x] 0. worktree + LANE.md
- [ ] 1. read inputs (MAC_CHECK B3, LaneR F3, workflows, project.yml, check.sh, afterPack.js, update-check.js)
- [ ] 2. release.yml gated to v1.*
- [ ] 3. package-release.sh (zip + dmg, sizes, sha256)
- [ ] 4. release-native.yml
- [ ] 5. MAC_CHECK steps 2/3/8 (+ README) docs
- [ ] 6. local validation (actionlint / yaml parse, shellcheck, gate test)
- [ ] 7. final report here

## Next step
1.

## Findings

## Open questions
