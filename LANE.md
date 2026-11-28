# Lane LIC (builder): relicense v2-native to PolyForm Noncommercial 1.0.0 (D38)

Brief: relicense the 2.0 line (`v2-native`) from GPL-3.0-only to PolyForm Noncommercial 1.0.0 per DECISIONS D38.
Clean-room rewrite of the one outside-account commit (ilomacht cf6e15f, port preflight) first; then LICENSE (verbatim
PolyForm NC text + Required Notice), a 1.x GPL note, every licence statement (package.json, README, site, release
notes, app strings, Info.plist, CONTRIBUTING.md new, LICENSES.md intro), a bundled third-party licence audit, the
Windows plan's ASIO lines (WASAPI only), CLAUDE.md/rules docs. Light lane: only `node tools/cloud/gates.mjs
unit,shell-unit` at the end. Don't push.

## Steps
- [ ] 1. Clean-room rewrite of test/port-preflight.mjs + call sites + findings-doc lines
- [ ] 2. LICENSE (PolyForm NC 1.0.0 verbatim) + LICENSE-1.x.md
- [ ] 3. Licence statements (package.json, README, site, release notes, app/, Info.plist, CONTRIBUTING.md, LICENSES.md)
- [ ] 4. Bundled third-party licence audit; Windows plan ASIO lines
- [ ] 5. CLAUDE.md / rules docs
- [ ] 6. Gates unit,shell-unit; final report here

## Next step
1.

## Findings / open questions
(none yet)
