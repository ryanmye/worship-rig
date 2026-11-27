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
- [x] 5. MAC_CHECK B3 + steps 2/3/7/8, the check.sh usage; README; CONTRACT_CHANGES ## N10
- [x] 6. local validation: actionlint (with shellcheck) clean on all workflows; shellcheck clean on package-release.sh and check.sh; stub run of package-release.sh; test/unit/release/release-workflows.test.mjs 9/9, mutation-checked; `gates.mjs unit` PASS at 3f22e46
- [x] 7. final report here

## Next step
None: hand back. (A `node_modules` symlink to the main checkout is in the worktree, git-ignored, for the gates.)

## Findings
- main's release.yml (261ea8d) has a `release: published` trigger that v2-native lacks; the merge of v2-native into
  main would have kept it un-gated. Folded into v2-native's copy with the v1 gate, so the merge takes ours cleanly.
- XcodeGen's generated Info.plist may not carry MARKETING_VERSION (its default is a literal "1.0" in some versions,
  unverified): project.yml now sets CFBundleShortVersionString / CFBundleVersion from the build settings explicitly.

- workflow_dispatch only works for workflow files on the default branch (GitHub rule, not tested here): until the
  2.0 merge puts release-native.yml on main, "Run workflow" is not offered for it. So release-native.yml also runs (build
  only) on a push to v2-native that changes the release files: the orchestrator's push of this lane is the first dry
  run.

## Open questions

None for this lane beyond the tier-1 items already in MAC_CHECK (pre-release vs latest: U9 item 3; who dispatches).

## Final report

Changes (lane-n10 on origin/v2-native 7e92df4):
- `.github/workflows/release.yml`: Electron only for `v1.*` tags (`push: tags: ['v1.*']` + job-level `refs/tags/v1.`
  guards on `build` and `release`); main's 261ea8d `release: published` + reuse-existing-release folded in under the
  same gate, so the 2.0 merge can take this file. 1.x behaviour unchanged; branch dispatch is still a dry run.
- `.github/workflows/release-native.yml` (new): triggers `v2.*` tag push, `v2-native` push touching the release files
  (path filter), `workflow_dispatch` (`publish`, `latest`, default off). Jobs `mac` (macos-15: brew xcodegen ninja,
  tag vs MARKETING_VERSION, package-release.sh --clean, check.sh selftest on the Release app (fails the job), notes
  preview, summary; artifacts dmg / zip / meta / logs), `ipad` (unsigned Release `xcodebuild archive`,
  `CODE_SIGNING_ALLOWED=NO`, continue-on-error, not needed by release), `release` (ubuntu, contents: write, only
  dispatch + publish + `refs/tags/v2.` + green mac; sha256 re-check, notes with --require-final, pre-release unless
  latest; dmg, zip, SHA256SUMS, starter library).
- `native/apple/scripts/package-release.sh` (new): Release build + ad-hoc re-sign (as afterPack.js) + gates + zip /
  dmg (`Worship-Rig-arm64.*`, the update-check.js pickAsset names) + SHA256SUMS / release.json / summary.
- `tools/mac/check.sh --app <path>`: selftest stage on a given app.
- `native/apple/project.yml`: explicit `CFBundleShortVersionString`/`CFBundleVersion` from the build settings.
- `tools/release/release-notes.mjs` (new): release body from docs/release-notes-<v>.md; `--require-final`.
- `test/unit/release/release-workflows.test.mjs` (new, unit suite).
- Docs: MAC_CHECK B3 + steps 2, 3 (dry run + what to check), 7, 8; README build/release text; CONTRACT_CHANGES N10.

Unverified until CI runs it (no macOS here):
- The Release configuration has never been built (Debug only so far); Swift/C may warn or fail under -O / WMO.
- package-release.sh against the real codesign / hdiutil / ditto / lipo / PlistBuddy (only a stubbed run here),
  the hdiutil retry, the XcodeGen no-scheme fallback path for Release.
- That XcodeGen expands `$(MARKETING_VERSION)` in the plist (standard Xcode build-setting expansion; expected fine).
- The self-test passing on a Release build (same code; no `#if DEBUG` other than isInspectable).
- The iPad unsigned archive (CODE_SIGNING_ALLOWED=NO archive; the iOS platform on the macos-15 image).
- GitHub behaviour taken from docs, not tested: dispatch needs the workflow on the default branch (hence the
  v2-native path trigger), path filters don't apply to tag pushes, download-artifact patterns, `gh release
  create/edit --latest/--prerelease`.
- The release job (never run; it needs a tag + publish, tier 1).

## Skeptic (N10 review, 2026-11-27)

Brief: prove the six safety properties (Electron only for v1 refs; native publish only by dispatch + publish + v2 tag +
green mac, `latest` only by input, GITHUB_TOKEN only, minimal permissions; path-filtered v2-native push builds only;
package-release.sh safety + real leak check + 480 MB guard + ad-hoc signing; project.yml versions safe for Debug CI;
release-notes --require-final + link rewriting). Fix real problems; review in native/docs/reviews/N10.md.

- [x] S0. rebase: origin/v2-native is still 7e92df4 (lane is on it; nothing to rebase)
- [x] S1. read LANE.md, workflows (vs origin/main 261ea8d), package-release.sh, check.sh, project.yml, notes, test
- [x] S2. actionlint + shellcheck: clean as delivered
- [x] S3. fix F1-F5 (762539b, 35dbf6e, f69d9cd), extend the unit test (13 tests; 4dfa065)
- [x] S4. gates.mjs unit PASS at 4dfa065 (707 pass); actionlint + shellcheck clean
- [x] S5. native/docs/reviews/N10.md (verdict, F/O, CI/macOS-only items), committed

Skeptic verdict: pass after fixes (F1-F5 fixed; O1-O7 open, see the review). Next step: none, hand back.

Findings (before fixes):
- F1 release-notes.mjs is fail-open: its main guard compares import.meta.url (realpath) with argv[1] (not realpath),
  so run through a symlinked path it prints nothing and exits 0: `--require-final` passes and the release job would
  publish an empty body. Reproduced via /tmp/n10-sym/wt -> worktree.
- F2 link rewriting: a root-relative `/x` link becomes https://github.com/x, and `../` past the repo root eats
  `blob/<ref>` (`../../X.md` -> github.com/o/r/blob/X.md). Wrong URLs, silently.
- F3 package-release.sh leak check is names only (user-samples, sound-packs, *.exs). The bundle copies app/ and docs/
  verbatim (folder refs); GarageBand conversions are .m4a/.mp3 (importer), sound packs .wav/.flac/.sfz: none caught
  if copied into app/. Real check: every file under Resources/app and Resources/docs is tracked in git at the build
  commit, plus a media/personal extension ban over the whole bundle (.caf .aif .aiff .aifc .m4a .wav .flac .ogg .sfz
  .exs .aupreset .cst .pst .patch .band .logicx, pack.json).
- F4 480 MB guard floors to whole MB (kb/1024): 480.0-480.99 MB passes where build-lint (KB <= 480*1024) fails.
- F5 `leak="$(find … 2>/dev/null | head)"` under set -e/pipefail: a find error exits the script silently.
