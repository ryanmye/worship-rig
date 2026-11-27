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
- [x] 1. read inputs (MAC_CHECK B3, LaneR F3, workflows, project.yml, check.sh, afterPack.js, update-check.js)
- [x] 2. release.yml gated to v1.* (main's `release: published` + reuse-release folded in, gated)
- [x] 3. package-release.sh (build Release + ad-hoc sign + gates + zip + dmg + sizes + sha256; shellcheck clean; stub-run on Linux)
- [x] 4. release-native.yml (mac / ipad / release jobs; actionlint + shellcheck clean)
- [ ] 5. MAC_CHECK steps 2/3/8 (+ README) docs
- [ ] 6. local validation (actionlint / yaml parse, shellcheck, gate test)
- [ ] 7. final report here

## Next step
6a. test/unit/release/release-workflows.test.mjs, then 5. docs

## Findings
- main's release.yml (261ea8d) has a `release: published` trigger that v2-native lacks; the merge of v2-native into
  main would have kept it un-gated. Folded into v2-native's copy with the v1 gate, so the merge takes ours cleanly.
- XcodeGen's generated Info.plist may not carry MARKETING_VERSION (its default is a literal "1.0" in some versions,
  unverified): project.yml now sets CFBundleShortVersionString / CFBundleVersion from the build settings explicitly.

## Open questions
