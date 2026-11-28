# Lane N1 skeptic review: Song bank and patch packs in the native app (rig_hostkit)

Reviewer: n1-skeptic, 2026-11-27. Branch `lane-n1` (builder tip 3120fc7, 9 commits on origin/v2-native), worktree
/home/claude/wt-n1. Every gate was re-run on this box. None of the builder's numbers were taken on trust.

## Verdict: MERGE (after the fixes below, which are on the branch)

The scanner port matches server.js byte for byte. That holds for every class I could generate on Linux, including
new classes the builder's tree did not have. It is memory-clean under ASan + UBSan and bounded in time, memory and
stack. The oracle (`app/js/engine`, `native/contract`) and `native/core/src` outside `hostkit/` are untouched. Making
`userSamples: true` unconditional causes no failing request: every route the page can ask for is served.

Two things the Linux box cannot settle:

- The Swift code only compiles on CI mac-check.
- The size-cap question F2 is settled upstream by lane CAP (44a72d6): pack top-up and Song bank add warn past 2 MB
  and are refused only past 2.5 MB.

## Fixes made (commits `n1-skeptic: …`)

| id | what | where |
| --- | --- | --- |
| F1 | patches.h's header said V8's SyntaxError texts are *not* reproduced and that pack.json errors use hostkit's own wording. Both claims are stale: since 54b7883 they are reproduced and tested. Rewritten, and the read-cap divergence (a file growing between stat and read is read up to 16 MB) is now listed. | native/core/src/hostkit/patches.h |
| F2 | **Pack size caps vs D9 / D33 O4 (superseded upstream).** `store.topUpPacks` and `store.addPackSong` refused past `LIBRARY_MAX_CHARS` (2 M). D9 says a save past 2 M warns and is not refused, and the D33 O4 note says an add is refused only past the 2.5 M restore cap. I fixed this on the branch. Then origin/v2-native merged lane CAP (44a72d6, "one size rule for every add"), which fixes the same thing with the same reading. I dropped my change (store.js, patch-packs.test.mjs, docs/patch-packs.md back to the lane's text), so the rebase takes upstream's version. | (dropped; upstream 44a72d6) |
| F3 | Parity gaps: the builder's trees had no non-UTF-8 names, quote / backslash / control / newline names, a root that is a link, the exact 1 MiB boundary, a surrogate cut in the pack name's `.slice(0, 120)`, a UTF-16-vs-byte file-name length, `songs` as a file or link, links to a folder or through a file (ENOTDIR), 400k nesting, too-deep-then-syntax-error, repeated `id` / `bank`, `__proto__` envelopes, NFC/NFD twins, pre-1970 half-millisecond mtimes (Math.round vs `std::round`), or the 500-folder cap. Added as tree variant `edge` in parity.test.mjs: 24 songs, 13 packs, 28 errors, **identical**. | test/unit/hostkit/corpus.mjs `buildEdgeTree`, parity.test.mjs |
| O3 | iPad Settings › My Samples would have said "Folder: /var/mobile/Containers/Data/Application/<UUID>/Documents/Samples". It now says "Folder: On My iPad › Worship Rig › Samples" (`RigPaths.userSamplesShownName`; `roots` keeps the real path; Mac, self-test and `RIG_USER_SAMPLES` unchanged). | RigPaths.swift, RigSchemeHandler.swift, MAC_CHECK step 5 |
| — | Self-test `packs`: the 6-term `Optional == true` chain is split into one Bool per term, to cut the risk of a type-checker timeout in CI's first compile. Behaviour is unchanged. | RigSelfTest.swift |
| — | The devhost Playwright test also presses Settings › My Samples › **Rescan** with no instruments. It checks the text ("No sample instruments yet.", no "isn't turned on here" note, no Reload button) and that the manifest was re-read, still with 0 console errors and 0 HTTP ≥ 400. | test/unit/hostkit/songbank-devhost.test.mjs |

## 1. Parity (server.js is the reference)

Read line by line against server.js:433-705: listPackDirs, packSongFiles, hasUserPatches, readPackJson,
checkPatchEntry, userRefsOf, deeperThan, within, the caps and the message texts. The control flow matches, including
these points:

- the ordering of the skip / colon / slug-length checks (none of them fires for a pack without songs);
- the song cap is checked before a file is read and again inside the array loop;
- a non-regular file after `stat` is skipped silently, without counting toward `files`;
- `total` grows before the parse, so an invalid file still counts toward 8 MB;
- an envelope `bank: null` beats the song's own `bank`;
- `raw.songs !== undefined` is true for `null`;
- `Math.round` is modelled as floor(x + .5), not `std::round`. The pre-1970 mtimes in `edge` prove it: −4999.5 gives
  −4999, and −0.4 gives 0 (−0 written as 0).

The JSON model:

- It is iterative. The tree is cut at depth 64, so `jsonStringify` and the `JVal` destructors recurse at most 64
  deep. That is safe on a 512 KB GCD thread stack.
- Repeated keys keep their first position and take the last value. Array-index keys come first.
- `__proto__` is an own key.
- Numbers of up to 15 digits are read exactly. Longer ones go through yyjson's correctly rounded reader, and overflow
  gives ±Infinity. They are written through `std::to_chars` shortest, which core's js_number.cpp already uses on
  mac-check, so it is available at the 14.5 / 17.5 floors.
- Lone surrogates are kept as WTF-8 and written escaped.

Results:

- **Measured:** the 20065-case JSON corpus, the 3000-case text corpus, 9000 realistic names, the main and caps trees,
  server.js's real HTTP route and the new edge tree are all byte for byte equal. This includes every error text and
  every libuv message (ENOENT, ENOTDIR, ELOOP and EISDIR all occur).
- **Duplicates:** an earlier root wins, a later duplicate is reported only when it has songs, and a link root
  re-reports every pack. Identical.
- **Caps:** 1 MiB per file (1048576 is read, 1048577 is skipped), 200 files, 100 songs per file, 2000 songs, 8 MB in
  total, 500 folders (the cap also ends later roots), 200-character slug, 245-unit file name (counted in UTF-16, not
  bytes), 64 levels of nesting, 1–16 slots. All identical.
- **Known divergences, all documented:**
  - collation of exotic code points (21 adjacent inversions in 3000, measured; it affects only list order, and caps
    only at the boundary);
  - a FIFO named pack.json (server.js hangs; hostkit reads it as empty);
  - a file growing past 16 MB between stat and read (server.js reads it all);
  - the ICU table is pinned to Node 22.23.5 / ICU 78.3. Electron's ICU on Ryan's Mac may differ in rare orders.
    PackIds and hashes do not depend on order.
- **Not testable here:**
  - EACCES: this box runs as root, so permission checks never fire. The message comes from the same libuv table.
  - DT_UNKNOWN file systems: the lstat fallback has been read but not run.
  - macOS realpath and NFD behaviour: Node and hostkit call the same libc on the same bytes, so they should agree.
    Mac-only.

## 2. Safety

- **Traversal.** No request data reaches hostkit: the roots are fixed in Swift and devhost. Pack folders must
  realpath inside their root, and song files inside their pack, with the same `within()` as server.js. A `songs` link
  out of the pack gives "is a link to a file outside the pack" (main tree).
- **TOCTOU.** realpath → stat → open has the same race as server.js. Exploiting it needs a local writer in the My
  Samples folder.
- **O1 (not fixed, parity):** `pack.json` is stat'ed and read through links with no `within()` check, as in
  server.js. Up to 64 KB of any file is parsed. Its trimmed `name` (≤ 120 characters) and, for a non-JSON file, V8's
  10-character context snippet reach the page's pack list and errors. The impact is local only (the user's own app
  and files). If tightened, do it in server.js and hostkit together, or parity breaks.
- **Unbounded reads: none.**
  - pack.json is capped at 64 KB by stat.
  - Song files are S_ISREG only, ≤ 1 MiB by stat, 8 MB in total.
  - `fsReadText` stops at 16 MB whatever stat said. `/dev/zero` behind a pack.json link stops there, where Node would
    read until it runs out of memory.
  - `O_NONBLOCK` keeps a FIFO from blocking. On a regular file it has no effect.
- **ASan + UBSan, fresh build** (RelWithDebInfo, `-fno-sanitize-recover=all`, leak detection on): ctest passed 88/88,
  including unit.hostkit-* and parity on all three trees driven by the ASan CLI.
- **C API abuse under ASan:** none of these inputs crashes, leaks or aborts:
  - roots NULL, `null`, `[`, `{}`, mixed arrays, a 6000-character path, an embedded `\u0000`, `/` and `/proc`, a
    relative root, 60000 levels of nesting;
  - ids `not json` and `[1,"user:x"]`.
- **Exceptions:** all three entry points wrap the whole body in `catch (...)`. Nothing throws through the C ABI. NULL
  is returned only on allocation failure. Swift answers that with a 500, devhost with a 500 JSON.
- **rig_hostkit_free:** the result is malloc'd and freed with free. Swift frees it exactly once in `defer`, after
  `Data(bytes:count:)` has copied it. Devhost copies it into `std::string` before freeing. Misuse is possible only by
  a caller that double-frees, and none does.
- **Threads:** hostkit has no global mutable state: only const tables, a per-parser yyjson pool, and `getcwd`. It is
  reentrant on the concurrent scheme queue.
  - The Swift hop is the existing pattern: the work runs on `queue`, `respond` → `DispatchQueue.main.async`, and the
    `stopped` set is checked under `lock`.
  - `RigPaths.overrideRoot` is read off main and written once on main before the web view loads. That is benign in
    Swift 5.9 minimal checking.

## 3. `/api/health` `userSamples: true` on native

I proved that no request fails because of it, from the code and in the devhost run:

- **Every `/api/*` URL in `app/js`:**
  - `./api/health`, `./api/user-patches` (controller);
  - `./api/user-samples/manifest.json` (web engine audio.js, controller over http only);
  - `/api/user-samples`, `/api/health` (settings.js);
  - `/api/heartbeat`.

  RigSchemeHandler answers each with a 200 (204 for the heartbeat). Every other path reaches the static tree, but
  nothing in the app builds another `/api/` URL. The manifest has `instruments: []`, so no `/user-samples/<token>/…`
  audio URL can exist.
- **On rig:// the BridgeEngine fetches nothing.** `controller.rescanUserSamples` fetches only on `http:`. On rig:// it
  calls `engine.reloadManifests` (the bridge → core). There is no `window.rig` in the native shell, so Settings goes
  through health → `/api/user-samples`.
- **`/api/user-patches` is requested only when health says `userPatches`.** The self-test step `packs` gates on 0
  such requests before a pack exists. Devhost Playwright shows the same.
- **Devhost Playwright** (the real UI v6 on the native core over rig-devhost): Settings shows "Folder: <root>",
  "No sample instruments yet.", no "isn't turned on here" note, and Rescan. Pressing Rescan re-reads the manifest,
  shows no Reload button, and the toast says "No new sample instruments (0 in My Samples)". The run ended with 0
  console errors and 0 HTTP ≥ 400.
- **Settings text:** sensible on the Mac. On the iPad it is now the Files name (O3).
- **What changes for a native user before N2:** Settings shows a My Samples folder, but dropping an instrument pack
  there does nothing audible (Rescan reports 0). Release notes "Known gaps" says so. Reverting to `false` would hide
  Rescan, and with it the only way to pick up a new pack without a restart. **Keep `true`.**

## 4. Swift, read line by line (CI is the first compiler)

- **C imports:**
  - `rig_hostkit_has_patches(String)` → `Int32 == 1`;
  - `rig_hostkit_user_patches_json(String, nil)` → `UnsafeMutablePointer<CChar>!`, bound with `guard let`;
  - `Data(bytes: body, count: strlen(body))` (Darwin's `strlen` → `Int`);
  - `rig_hostkit_free(body)`.

  These match `rig_hostkit.h` names and types. The bridging header includes `<rig/rig_hostkit.h>`, which the
  xcframework headers dir (`$core/include`) provides.
- **Return and closure forms:** `return queue.async { … }` in a Void func matches the existing `return json(…)` form.
  The `[weak self]` / `self?.` calls go to private methods of the same class.
- **RigPaths:**
  - `split(separator:)` → `Substring.trimmingCharacters(in:)` (StringProtocol, Foundation);
  - `URL(fileURLWithPath:isDirectory:).standardizedFileURL`;
  - `FileManager.urls(for: .musicDirectory…)` sits inside `#if os(macOS)`;
  - `JSONSerialization.data(withJSONObject: [String])` is a valid top-level array. Its `\/` escapes are decoded by
    hostkit's parser.
  - The new `userSamplesShownName` uses only `ProcessInfo` and `overrideRoot`.
- **RigSelfTest:**
  - the `js(_:_:_:)` signature matches;
  - nested closures shadow `d` / `err` legally;
  - `report.set(_:_:)` / `report.check(_:_:required:ms:_:)` match;
  - `as? [Any] ?? ["?"]` parses as `(as?) ?? …`;
  - the raw `#"""` JS has no Swift escapes (node test `selftest-scripts`);
  - stepMigration's three exits now lead to `stepPacks`.
- **APIs:** all are available on macOS 14.5 and iPadOS 17.5. C++: `st_mtimespec` sits under `__APPLE__`, and
  `O_CLOEXEC`, `O_NONBLOCK`, `d_type` and `DT_*` exist on both.
- **build-core.sh:**
  - `cmake --build … --target rig_core rig_hostkit` is built for every slice (macOS, iOS, simulator), since it is
    inside `build_slice`;
  - `rig_hostkit` is defined outside `if(RIG_BUILD_TESTS)`, so `-DRIG_BUILD_TESTS=OFF` still has it;
  - `find "$dir" -name '*.a'` picks up `librig_hostkit.a` and libtool merges it into `librig_core_all.a`;
  - no `.cpp` basename is shared between core and hostkit, so there are no duplicate archive members.

## 5. Oracle and boundaries

- `git diff origin/v2-native...HEAD -- app/js/engine native/contract`: empty.
- `native/core/src`, `native/core/include` outside `hostkit`: no file changed. `rig_core` excludes `src/hostkit/`
  through a CMake filter.
- No pack content, audio or `user-samples/` is committed. Every pack in the tests is generated in a temp folder.
- No `app/` file changes on the branch (F2 dropped).

## 6. Gates (this box: 2 CPUs, another heavy agent running; one at a time)

| gate | result |
| --- | --- |
| ctest g++ ASan + UBSan, fresh build | 88/88 |
| ctest clang++-20 Release, fresh build (`-Werror` via RigWarnings) | 88/88, 0 warnings |
| ctest g++ Release, fresh build | 87/88 first run. `unit.core3` failed a wall-clock tick-gap bound (62.3 vs 50 ms, load 2.5–3); rerun: 1 pass, 1 fail again. It is timing under load, in a core test of code the lane does not touch. Clang and ASan pass it. Environmental. |
| goldens | the 112 renders of clang Release, g++ Release and g++ ASan are byte-identical (cmp, 0 differ) |
| devhost (build-n1-dh, incremental to HEAD) | devhost_tests 21/21 cases (233 assertions); ctest 5/5 (`probe.null` failed once on timing, then passed) |
| devhost Playwright (RIG_DEVHOST) | songbank-devhost (with the Settings Rescan step) and engine-bridge/devhost: 3/3 |
| gates.mjs (tree 92908c98031d, clean) | shell-unit PASS 34 s; unit PASS 54 s (716 pass / 0 fail / 13 skip; hostkit parity main, caps and edge identical); ui-v6-bank PASS 57 s; ui-core PASS 347 s; settings PASS 137 s; migration-1x PASS 90 s |

## Open questions

- **O2: resolved.** Upstream lane CAP made the same choice for the automatic top-up as for Song bank Add / Keep: it warns past 2 MB and is refused only past 2.5 MB.
- **O4 (licence owner): collation_table.inc** is data derived from ICU's root collation, generated from Node's
  `Intl.Collator` (ICU 78.3 / Unicode 17). ICU data is under the Unicode License V3, which asks for its notice in
  documentation of anything containing the data or derived from it. LICENSES.md has no Unicode / ICU entry. Worth a
  line, now that 2.0 is PolyForm Noncommercial (D38).
- **O1** (above): pack.json through links out of the root. Parity keeps it. Change server.js and hostkit together if
  wanted.
- **O5 (minor, devhost only):** the second `std::filesystem::absolute` in devhost's `/api/user-samples` route can
  throw (no `error_code`) if the working directory is gone. Dev tool, not shipped.

## Only a Mac / iPad can verify

- The Swift compiles: RigPaths (incl. `userSamplesShownName`), RigSchemeHandler, RigSelfTest, the bridging header.
  Then `build-core.sh` links `rig_hostkit_*` from `librig_core_all.a` in every slice.
- The self-test step `packs` passes on CI mac-check: 0 requests before packs, then `userPatches`, the auto song in
  the library, 2 bank songs, Add OK, 0 errors.
- A real `~/Music/Worship Rig/Samples` pack (MAC_CHECK step 4 item 16):
  - same ids and hashes as the Chrome version on the same folder;
  - APFS NFD / NFC names;
  - an EACCES file's message;
  - Electron's ICU vs the generated table on Ryan's real folder names.
- iPad: the Files › On My iPad › Worship Rig › Samples folder appears, and Settings shows that name (O3).
- `~/Music` access raises no TCC prompt (same folder as recordings, so it is expected to be fine).

## Rebase onto origin/v2-native (3f5bf2c)

`git merge-tree` on the final tip shows one conflict, in **CONTRACT_CHANGES.md**: both sides only append sections at
the end. Keep both. Once F2 was dropped, store.js, patch-packs.test.mjs and docs/patch-packs.md merge cleanly with
lane CAP, and docs/release-notes-2.0.md, MAC_CHECK.md and NATIVE-GAPS.md auto-merge.

The gates above ran on tree 92908c98031d, which still had F2. Dropping it brings the three files back to the lane's
text, and upstream CAP replaces them on merge. Re-run on the final tree (b4fba256cb85, F2 dropped): shell-unit PASS (31 s), ui-v6-bank PASS (44 s). After the
merge, re-run shell-unit, because upstream CAP owns patch-packs.test.mjs's cap tests.
