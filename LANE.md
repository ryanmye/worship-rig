# LANE N1 (builder): Song bank and patch packs from My Samples in the native app (D35, wave 1)

Brief: port server.js `scanUserPatches` (listPackDirs, packSongFiles, readPackJson, checkPatchEntry, userRefsOf,
hasUserPatches; caps, messages, ordering, sha1 hash of `JSON.stringify([schema, song, bank])`) to a small C++ library
`rig_hostkit` (native/core/src/hostkit, own static target, yyjson), serve it from rig-devhost (`--user-samples DIR`:
/api/health flags + /api/user-patches) and from a thin Swift route in RigSchemeHandler (Mac `~/Music/Worship Rig/Samples`
+ RIG_USER_SAMPLES; iPad `Documents/Samples`). Tests: ctest (edge cases), node parity vs server.js on generated trees
(byte-for-byte), Playwright of the real app on rig-devhost (Song bank, Try it, Keep), self-test step `packs`.
Personal content never committed; app/js/engine unchanged. Worktree /home/claude/wt-n1, branch lane-n1 (from
origin/v2-native 030562e). Don't push.

## Checklist

- [x] 0. worktree, LANE.md
- [x] 1. hostkit JS-value layer: yyjson → JS semantics (dup keys, index-key order, doubles), JSON.stringify port,
      UTF-8 (WHATWG decode) / UTF-16 helpers, collation (localeCompare numeric/base), SHA-1; CLI `rig-hostkit`
- [x] 2. differential test vs node: JSON.parse/stringify on a generated corpus; collation order vs Intl.Collator
- [x] 3. scanner port + C API (`rig_hostkit_scan_patches`, `rig_hostkit_has_patches`, `rig_hostkit_free`) + ctest
- [x] 4. node parity test (server.js vs CLI on generated trees), wired as a ctest and an opt-in node test
- [ ] 5. devhost routes (`--user-samples`), devhost test
- [ ] 6. Playwright: real app on rig-devhost, Song bank from a generated pack, Try it, Keep
- [ ] 7. Swift: RigPaths.userSampleRoots, RigSchemeHandler routes, bridging header, build-core.sh, self-test `packs`
      (+ node test of its JS)
- [ ] 8. docs: patch-packs.md, devhost README, CONTRACT_CHANGES, MAC_CHECK, release notes known gaps
- [ ] 9. gates: ctest g++ / clang++-20 / ASan (+ goldens), gates.mjs shell-unit,unit,ui-v6-bank,ui-core,settings,
      migration-1x
- [ ] 10. final report here

## Next step

5 (devhost routes).

## Findings / decisions

- NATIVE-GAPS N1 said "yyjson raw-number read / write, so hashes match JSON.stringify on files the app wrote". Wrong
  for hand-written files (5.0, 1E2, escapes, duplicate keys, index-key order) and yyjson also rejects lone "\udXXX"
  escapes JSON.parse accepts. Done instead: hostkit's own JSON.parse model (iterative, V8 grammar and SyntaxError
  texts) + JSON.stringify model (doubles via yyjson's correctly rounded reader, Number#toString via to_chars), so
  the hash matches for every file. Proven on 20k generated cases (byte for byte, error texts too).
- localeCompare(numeric, base) is modelled by a generated primary-weight table from Node's ICU (gen-collation.mjs,
  85 KB source, ~26 KB binary): realistic names 9000/9000 identical order; exotic code points 21 adjacent inversions
  in 3000 (number forms, Suzhou numerals, l-middle-dot): documented gap.
- server.js's readdir order before the sort is libuv scandir = strcmp of the raw names; hostkit does the same, so
  ties (Alpha / alpha) break identically.
- Divergence kept: a FIFO / device named pack.json reads as empty (server.js would block forever on it).
- user: ids: the Swift and devhost routes pass null (no check) until N2 has a My Samples scanner; server.js warns
  "which no My Samples pack has" for every user: ref there, which would be false on the native app's side.

## Open questions
