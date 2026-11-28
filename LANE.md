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
- [x] 5. devhost routes (`--user-samples`), devhost test
- [x] 6. Playwright: real app on rig-devhost, Song bank from a generated pack, Try it, Keep
- [x] 7. Swift: RigPaths.userSampleRoots, RigSchemeHandler routes, bridging header, build-core.sh, self-test `packs`
      (+ node test of its JS)
- [x] 8. docs: patch-packs.md, devhost README, CONTRACT_CHANGES, MAC_CHECK, release notes known gaps
- [x] 9. gates: ctest g++ / clang++-20 / ASan (+ goldens), gates.mjs shell-unit,unit,ui-v6-bank,ui-core,settings,
      migration-1x
- [x] 10. final report here (below)

## Next step

None: lane done, handed back (report below).

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
- Swift /api/health now always says userSamples: true (+ 'user-samples'), so Settings › My Samples shows the folder
  and Rescan on the native app. Until N2 the folder holds no instruments the native app plays ("No sample instruments
  yet"); Rescan goes through BridgeEngine.reloadManifests (core), no HTTP request. Check on the Mac (MAC_CHECK).

## Gates (tree 212aa4a, clean; 2026-11-27)

- ctest, native/core: g++ Release 88/88 (rerun at HEAD; the first run's unit.core3 failed a timing bound by 0.02 ms,
  50.0175 vs 50 ms tick gap, while two-CPU load; it passes on the rerun, and lane N1 touches no core source);
  clang++-20 Release (-Werror via RigWarnings.cmake, 0 warnings) 88/88; g++ ASan+UBSan RelWithDebInfo 88/88.
  Includes unit.hostkit-json / -scan / -text / -parity and golden.* (12 lists).
- Fixtures: the 112 golden renders of the g++ and clang builds are byte-identical (cmp); no file under app/,
  native/contract or native/core/src outside src/hostkit changed on the lane.
- native/devhost: devhost_tests 21/21 cases (233 assertions); opt-in node tests with RIG_DEVHOST
  (songbank-devhost.test.mjs: Song bank on rig-devhost, no pack, Rescan, Try it, Keep, Settings;
  engine-bridge/devhost.test.mjs) 3/3 pass.
- gates.mjs: shell-unit, unit (715 pass / 0 fail / 13 skipped; hostkit parity byte for byte on generated trees,
  packsProbe), ui-v6-bank, ui-core, settings, migration-1x all PASS. (A first settings run died on a Chromium
  "Target page closed" crash mid-suite, environment; the rerun passed.)

## Final report

Built: rig_hostkit (native/core/src/hostkit, static, no rig_core dependency): port of server.js scanUserPatches /
hasUserPatches with JS-exact JSON.parse/stringify, localeCompare(numeric, base), sha1; C API rig_hostkit.h; CLI
rig-hostkit. Served by rig-devhost --user-samples (health flags, /api/user-patches, /api/user-samples summary,
manifest) and by RigSchemeHandler (health flags via rig_hostkit_has_patches, /api/user-patches via
rig_hostkit_user_patches_json, both off the main thread; roots RigPaths.userSampleRoots: self-test temp root, else
RIG_USER_SAMPLES, else ~/Music/Worship Rig/Samples or iPad Documents/Samples). Self-test step `packs`.
app/js/engine unchanged. No pack content committed (tests generate synthetic packs).

Mac-only (CI mac-check / Ryan's Mac): Swift compiles (RigPaths, RigSchemeHandler, RigSelfTest, bridging header),
build-core.sh archives rig_hostkit into the slice; self-test `packs` passes; a real ~/Music/Worship Rig/Samples
pack shows up (auto song joins the library, Song bank lists bank songs, Add to library); iPad Files shows
Worship Rig › Samples; Settings › My Samples on native with userSamples: true reads sensibly.


## n1-skeptic (review in progress)

Brief: adversarial review of lane N1 (parity, safety, health flag, Swift by reading, oracle untouched, gates rerun).
Report: native/docs/reviews/n1-skeptic.md.

- [x] read RESUMABLE, LANE, CLAUDE.md, NATIVE-GAPS N1, patch-packs.md, D9 / D33 O4
- [x] code read: patches.cpp, js_json, js_text, sha1, hostkit_c, CLI, devhost, Swift diff
- [x] parity: new 'edge' tree (corpus.mjs buildEdgeTree): identical to server.js
- [x] fixes: F1 comment, F2 caps (dropped: upstream lane CAP 44a72d6 fixed it), F3 parity edge tree, O3 iPad folder name, self-test Bool split
- [x] gates: ctest ASan 88/88, clang 88/88 (0 warnings), g++ 87/88 (unit.core3 timing under load), goldens
      byte-identical x3, devhost 21/21 + Playwright 3/3, gates.mjs 6/6 PASS (tree 92908c98031d)
- [x] report: native/docs/reviews/n1-skeptic.md (verdict MERGE)

Findings so far:
- F1 patches.h header comment says V8 SyntaxError texts are not reproduced: stale (they are, and tested).
- F2 store.topUpPacks / addPackSong refuse past LIBRARY_MAX_CHARS (2 M): D9 (saves warn, not refused) and the D33
  O4 note (adds refused only past the 2.5 M restore cap) say otherwise. Pre-dates N1, but the brief requires it.
- O1 pack.json is read through a link out of the root (server.js does the same): its `name` and a SyntaxError snippet
  reach the page. Local, low.
