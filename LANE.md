# Lane LIC (builder): relicense v2-native to PolyForm Noncommercial 1.0.0 (D38)

Brief: relicense the 2.0 line (`v2-native`) from GPL-3.0-only to PolyForm Noncommercial 1.0.0 per DECISIONS D38.
Clean-room rewrite of the one outside-account commit (ilomacht cf6e15f, port preflight) first; then LICENSE (verbatim
PolyForm NC text + Required Notice), a 1.x GPL note, every licence statement (package.json, README, site, release
notes, app strings, Info.plist, CONTRIBUTING.md new, LICENSES.md intro), a bundled third-party licence audit, the
Windows plan's ASIO lines (WASAPI only), CLAUDE.md/rules docs. Light lane: only `node tools/cloud/gates.mjs
unit,shell-unit` at the end. Don't push.

## Steps
- [x] 1. ~~Clean-room rewrite~~ CANCELLED: coordinator relayed Ryan's confirmation that GitHub "ilomacht" is his own
  account (D38 updated on origin, 9ac004f). The draft rewrite was never committed; test/port-preflight.mjs,
  test/run-all.mjs, test/phase1/shell/run.mjs and reviews/v11-local-findings.md are byte-identical to origin/v2-native.
  Copyright holders of v2-native: Ryan Ye (GitHub accounts ryanmye and ilomacht) plus AI-generated contributions made
  at his direction (recorded in CONTRIBUTING.md and LICENSE-1.x.md).
- [x] 2. LICENSE (PolyForm NC 1.0.0 verbatim) + LICENSE-1.x.md
- [ ] 3. Licence statements (package.json, README, site, release notes, app/, Info.plist, CONTRIBUTING.md, LICENSES.md)
- [ ] 4. Bundled third-party licence audit; Windows plan ASIO lines
- [ ] 5. CLAUDE.md / rules docs
- [ ] 6. Gates unit,shell-unit; final report here

## Next step
3. (README, package.json, lockfile, CONTRIBUTING.md, site, release notes, LICENSES.md done) app strings, Info.plist; then 4

## Findings / open questions
- LICENSE text source: WebFetch of the official page only returns a summary (it won't reproduce text verbatim) and the
  official `.txt` (polyformproject.org/licenses/noncommercial/1.0.0.txt) is blocked by the box's proxy (403). Used the
  official repo's tagged copy, raw.githubusercontent.com/polyformproject/polyform-licenses/1.0.0/
  PolyForm-Noncommercial-1.0.0.md (sha256 c0ea4a89…fabbe5), cross-checked word for word against SPDX
  license-list-data `text/PolyForm-Noncommercial-1.0.0.txt` (same words, only hard-wrapped). LICENSE = Required
  Notice line, blank line, that file byte for byte.
