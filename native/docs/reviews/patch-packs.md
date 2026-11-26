# Review O-AW-PP: patch packs and the Song bank (skeptic, 2026-11-25)

Tree: `/home/claude/wt-pack` (lane-pack on 1959e0f, uncommitted). Brief: DECISIONS O-AW-PP, `docs/patch-packs.md`,
CONTRACT_CHANGES "Patch packs (2.x step 1)".

## Verdict

**VERIFIED after six fixes (PP-1 to PP-6).** Only PP-1 could lose a pack update. It froze a song, but never cost a
user edit. The rest are UX, accessibility and noise fixes. No user edit could be overwritten in any path I tried.
Script injection is not possible. A library without packs is unchanged: same store, same localStorage keys, same
visible DOM, zero console errors. The one network difference is a single extra same-origin `GET /api/health`,
which is accepted (see O-1).

## Gate (Linux container, 2 shared CPUs, one suite at a time, after all fixes)

| Suite | Result |
| --- | --- |
| shell unit (`run.mjs --only unit`) | 29 files, 320 pass (incl. patch-packs 29/29: 25 builder + 4 new) |
| shell browser | 2 files pass (browser.pw + patch-packs.pw 5/5, incl. 1 new); 0 console errors, 0 HTTP ≥ 400 |
| shell electron (`xvfb-run`) | 23 pass, 1 skip (L-14 macOS-only, pre-existing). Includes "patch packs in Electron … S4 key" |
| `run-all --only unit` | 670 pass, 0 fail, 11 skip |
| settings | 88/88 (app, fixture, mac, bridge) |
| ui-core (once) | 91 pass, 0 fail |
| migration-1x (`xvfb-run`) | 113 pass, 0 fail (the D11 "box is ticked" test did not flake) |
| No-packs diff vs 1959e0f (scratch Playwright, My Samples on / off) | store equal (ids normalised), localStorage keys equal, Settings' visible elements and text equal, 0 console errors on both sides |

## Findings

| Id | Severity | Finding | Status |
| --- | --- | --- | --- |
| PP-1 | High (data, update path) | When a Rescan updated the selected song in place, the Revert snapshot kept the old version, and Perform showed "changed" dots. Revert then wrote the old version back, which counted as an edit, so the song never took another pack update. This also happens at boot: the pack read lands after the first song is selected, so the trigger is simply "edit the file, launch". Reproduced: `revertSong()` → tempo 70 and `kept` forever. | Fixed |
| PP-2 | Medium (UX) | The natural authoring loop (edit in the app, then Export song into the pack file) left the song "edited" for good: no later file change ever applied, and deleting it meant it was never re-added. | Fixed |
| PP-3 | Medium (a11y) | Rescan, the summary, search and Add were 36 px, 36 px and about 20 px tall. Every row's button had the same name, "Add to library". | Fixed |
| PP-4 | Low | Search folded accents (NFD) but not ø, æ, œ, ß, ł, so "soren" didn't find "Søren". | Fixed |
| PP-5 | Low | The library cap check left out the new `meta.packSongs` record (~110 chars each). | Fixed |
| PP-6 | Low (noise) | An instrument-only pack duplicated across the two roots was reported again in the "Patch packs: N problems" toast at every boot. A folder name over 200 characters or a file name over 245 passed the server, then failed the client's `PACK_ID_RE` with a bare "not a pack song". | Fixed |

### Checked and holding

- **Paths.**
  - The slug comes from `readdir`, so it can't contain `/`. Links out of a root are skipped, and so are `songs/`
    links out of the pack: `songs` linked to another pack's folder, or a file linked outside.
  - A FIFO named `x.json` is skipped. It is not a regular file, so the scan never blocks on it.
  - `pack.json` as a folder → "auto" with an error.
- **Huge or deep input.**
  - A 1 MB file of `[` (500k deep) and of 150k nested objects: V8's `JSON.parse` doesn't recurse, and
    `deeperThan` stops at 64. Each scan takes 264 ms.
  - Every regex is anchored and length-bounded: `PACK_ID_RE` runs after the 460-char check, and the bank key, time
    signature and ccli patterns are simple. No ReDoS.
- **`__proto__`, `constructor`.** These keys stay own data properties end to end. Nothing is polluted, and the
  stored song's prototype is still `Object.prototype` (probe). See O-3.
- **Instrument ids.**
  - A `user:` id from another pack is allowed by design: ids are global across My Samples.
  - A missing `user:` id gives a server warning. An unknown built-in id is stored as is, as with Import.
  - An invalid slot becomes an empty slot.
- **S4.** `/api/user-patches` is in `PRIVATE_ROUTE_RE`, including under a page prefix. Electron injects the key
  (main.js `onBeforeSendHeaders`). The Electron boot test gets 200 with the key, and the unit test gets 403
  without it.
- **Injection.**
  - Bank title, artist, meta, toasts and warnings all go through `h()` `text` / `textContent` / `setAttribute`.
    There is no innerHTML on this path; the only one in the app is perform.js `ICONS`, which is static.
  - A pack with `<img src=x onerror=…>` as its title and `<b>` as its artist rendered as text: 0 elements, no
    dialog (screenshot checked).
- **Edit coverage of `sig`.**
  - Every user edit lives in the song object (chart, scenes, slot eq, release and pedalHold included). Setlist,
    order and program-change data sit outside it, and the update keeps them.
  - All 19 factory songs, exported both as schema-2 and as bare 1.x entries, gave 0 `sig` drift across
    persist → reload → migrate, and all 38 updated afterwards.
  - Undefined keys and key order don't matter (`stableStringify`). A future normaliser can only make songs look
    edited, which is the safe direction (O-2).
- **Races.**
  - Store calls are synchronous; `sig` is checked at the write.
  - A muted second window never writes, and `addFromBank` refuses there.
  - Concurrent rescans share one promise.
  - Replace import, the E5 pristine import and D8 `restorePreviousLibrary` all replace `meta`. Pack songs are taken in
    afresh at the next boot or Rescan, and are never duplicated.
  - A merge import drops `meta` (its copies are plain songs).
- **Two roots, one slug.** The first root wins; the later one is reported only when it has songs (PP-6).
- **Setlists.** An update in place keeps the id, so setlists are unchanged (builder test).
- **Bank.**
  - Add is idempotent: a double click adds 1, then "In library". Delete → Add makes a new id, and top-ups never
    bring it back.
  - Search ignores case and accents.
  - Contrast on Sanctuary: title 14.0:1, meta and hint 9.3:1, search 15.4:1.
- **Swift stub.** It is correct and minimal: health returns `userPatches: false` with no `'user-patches'` feature,
  so the client never asks, and the `/api/user-patches` stub stays off the 404 count. It compiles only on CI
  (mac-check), and was not built here.

## Fixes (files)

- PP-1:
  - `controller.js`: new `packSongsUpdated(ids)`. It re-reads `selected` and emits `'action'`
    `{type:'packSongsUpdated', ids}`.
  - `views/perform.js`: re-takes its snapshot on that action.
- PP-2, PP-5: `store.js` `topUpPacks` (relink when the fingerprints are equal, with no song write;
  `recLen`) and `addPackSong` (adds the record's size).
- PP-3: `styles-settings.css` (44 px; the summary gets its own marker and focus ring) and `views/settings.js`
  (`aria-label` per row).
- PP-4: `shared/patch-packs.js` `FOLD_EXTRA`.
- PP-6: `server.js`. `listPackDirs` lists duplicates with `skip`, `scanUserPatches` reports them only when they
  have songs, and there are new `USER_PATCH_SLUG_MAX` / `USER_PATCH_FILE_NAME_MAX` checks.
- Tests:
  - `patch-packs.test.mjs` +4: PP-1 end to end against a real server (confirmed failing without the fix), PP-2,
    PP-4, PP-6.
  - `patch-packs.pw.mjs` +1: Perform's `savedSnapshot` follows the update with no changed dots; the targets are
    ≥ 44 px; the aria-labels.
- Docs: `docs/patch-packs.md` (export-back row; Revert note) and CONTRACT_CHANGES "Patch packs: skeptic fixes".

## Open items (not fixed)

- **O-1: one extra `GET /api/health` at boot for every user.** The controller can't see the engine's cached health
  answer, and app/js/engine is off-limits. The request is same-origin, returns 200 and logs nothing. Removing it
  needs the engine to expose its health answer, or a shared health helper. Accepted for now.
- **O-2: a future normaliser makes every pack song read as edited**, so updates silently stop. A cheap fix when
  SCHEMA next bumps: in `migrate`, if `fingerprint(raw song) === rec.sig`, re-sign it with the normalised song.
  Today: 0 drift (measured).
- **O-3 (pre-existing, not pack-specific).** `importJSON` / `migrate` keep a top-level `__proto__` /
  `constructor` key on a song as own data. It is harmless today, but `Object.assign({}, song)` anywhere would set
  that copy's prototype. Packs make the intake automatic, so `normalizeSong` should drop `isReservedKey` keys at the
  top level.
- **O-4: `meta.packSongs` is never pruned.** By design, deletes are remembered. It costs about 110 chars per pack
  song ever seen: about 220 KB for 2000, against the 2 MB cap. Renamed files add records.
- **O-5: boot cost at the caps.** A first top-up of 2000 small songs took 1.8 s on the main thread here (the cap
  stopped it at 1305). A steady-state boot takes 75 ms. Typical packs are far below this.
- **O-6.** A second Chrome tab that takes over as primary doesn't re-run the top-up until a Rescan or restart.
- **O-7.** Running from source and the packaged app share port 8438's library. If the repo's `user-samples/` and
  `~/Music/...` hold different packs with the same slug, unedited songs flip between the two versions on each
  launch. Edits are still protected.
