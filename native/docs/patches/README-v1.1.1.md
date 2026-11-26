# Worship Rig 1.1.1 (prepared, NOT published)

`v1.1.1-prep.diff` is `git -C <wt-111> diff` of local branch `v1.1.1-prep` (from tag `v1.1.0`, c8704a7). Nothing is
committed, tagged or pushed. DECISIONS D8, D11; review E5 M4.
Regenerate with `git -C <wt-111> add -N <new files>` then `git -C <wt-111> diff > v1.1.1-prep.diff`.

## What it does

- **store.js (the guard).** Before loading, `createStore` checks `rig.v1`. If it holds a library whose schema is newer
  than 1 (2.0 Chrome writes schema 2 there on the same origin), the store uses `rig.v1.1x` instead
  (`SEPARATE_LIBRARY_SUFFIX`), and `loadInfo.newerLibrary = {schema, key}`.
  - 1.1.1 then never writes `rig.v1`, never writes a `.backup-` key for it and never prunes. 1.1.0 copied the 2.0
    text into the newest-3 rotation and seeded over it, which was how both libraries were lost after two round
    trips.
  - The next launch opens the same separate library.
  - An unreadable (corrupt) library still takes the H1 path, and `importJSON` still refuses a newer file.
- **main.js.** One danger banner: "This library was saved by Worship Rig 2.0, and Worship Rig 1.1 cannot open it. It
  is kept untouched…". It has two buttons:
  - **Use a separate 1.x library** dismisses the banner.
  - **Quit** runs `window.close()`. If the browser keeps the tab open, a toast says it can be closed and that nothing
    was changed.
- **settings.js.** The Backups note says that a separate 1.x library is in use.
- **Device settings for 2.0 (D11).** `store.exportJSON({device: true})` adds an optional top-level block
  `deviceSettings` = `{v: 1, install, settings}`: the 13 `DEVICE_LOCAL_SETTINGS` the library has, and a machine
  marker. The marker (`store.installId()`) is 32 random hex digits, made once per origin and kept in localStorage
  `rig.install`; it is never a host, user or device name.
  - Written by every backup (`controller.libraryJSON`, Settings › Back up now). Settings › Export library writes it
    only while its toggle **With this computer's device settings** is on (off by default; D11 skeptic DS4).
    `exportJSON()` without the option is 1.1.0's file, so the S3 test still holds for the library's own settings.
  - 1.1.1's `importJSON` drops the block (a replace keeps this machine's settings, as before). 1.1.0 keeps it as an
    unknown top-level field and never reads it. No SCHEMA bump: the file stays schema 1.
  - Trade-off (D11 over S3): a backup, and an export with the toggle on, names the MIDI / audio devices and the pad
    folder's path (the account name on a Mac). A plain export does not. The release notes say not to share the
    opted-in file.
- **Version and docs.** `package.json` and `package-lock.json` go to 1.1.1. The server and the About box read
  `package.json`. Adds `docs/release-notes-1.1.1.md` (1.x keeps its changelog as release notes) and a
  CONTRACT_CHANGES section.
- **Tests.**
  - `store.test.mjs`: 2 new tests, replacing "future schema is refused".
  - `fixes.test.mjs`: the H1 future-schema test is rewritten.
  - `browser.pw.mjs`: 1 new test. The real app runs two launches on an origin holding a 2.0 library and 3 backup
    keys. It checks the banner, both buttons, `rig.v1` byte for byte, that no key is pruned and zero console errors.
  - `browser.pw.mjs` (D8/D9 skeptic): Quit. In a tab with history Chromium ignores `window.close()`, and the toast
    "You can close this window now. Nothing was changed." shows. A window the page opened closes. `rig.v1` is
    unchanged and there are zero console errors.
  - The store and fixes tests fail on the 1.1.0 store.
  - D11: `device-settings.test.mjs` (5: block shape, an untouched library's block, the marker, import drops the
    block, `backupNow` writes it after the origin tag) and `browser.pw.mjs` +1 (the real Export library button:
    no block by default; with the toggle on the download holds the block, its marker is
    `localStorage['rig.install']`; zero console errors).
- **2.0 side.** 2.0 lists `rig.v1.1x` under Restore previous library… ("the separate library of Worship Rig 1.1.1").
  `test/phase2/migration-1x/downgrade.test.mjs` applies this diff to `git archive v1.1.0` and runs
  2.0 → 1.1.1 → 2.0 → 1.1.1 → 2.0 on one storage (pass).

## D11 re-run (2026-11-26, after the device-settings change)

`xvfb-run -a node test/run-all.mjs --only unit,shell,ui-core,settings,electron-full`, one at a time:

| Suite | Result |
| --- | --- |
| unit | 399 pass, 7 skip |
| shell | 281 pass, 1 skip (unit 243, browser 16, electron 22 + 1 skip) |
| ui-core | 82/82 |
| settings | 60/60 |
| electron-full | 28/28 |

The 2.0 side reads files made by this code: `test/fixtures/library-1x/v1.1.1` (generator `--from` this worktree).
Not re-run for D11: engine, instruments, synth-extra, edit-v2, eq, mini, themes, chrome-fallback, build-lint (none
touches the store's export or the Settings Library section beyond the one button).

## Test results before D11 (Linux container, 2 CPUs, another heavy job running)

`xvfb-run -a node test/run-all.mjs --skip soak` (29 min):

| Suite | Result |
| --- | --- |
| unit | 399 pass |
| instruments | 143/143 |
| synth-extra | 153/153 |
| shell | 274 pass, 1 skip (includes the new tests) |
| ui-core | 82/82 |
| edit-v2 | 105/105 |
| settings | 60/60 |
| mini | 14/14 |
| themes | 58/58 |
| chrome-fallback | 17/17 |
| electron-full | 28/28 |

Three suites failed on the first run. None of the failures is from this change:

- **engine 97/99.** `realtime.audioSleep` had one capture gap under load. Run alone (`run.mjs audioSleep`), it
  passes. The 1 soft warning is older than this change.
- **eq 27/28.** L-21 "note labels fit under emulated SF Pro metrics" also fails here on unmodified v1.1.0. It depends
  on the environment's fonts.
- **build-lint 44/45.** The packaged-app self-test exited 5, with "xvfb-run: problem while cleaning up temporary
  directory". On the rerun: 45/45.

Skeptic re-run (review `D8-D9.md`), one suite at a time: unit 399, shell 274 + 1 skip (browser 15/15 with the
Quit test), ui-core 82, settings 60/60, electron-full 28/28 under xvfb-run. Run alone: engine `audioSleep` 1/1,
build-lint 45/45. eq L-21 fails the same way on plain `git archive v1.1.0` here (27/28 on both), so it is the
environment's fonts.

Not run: soak, and the Mac (packaged `.app`, real Chrome profile, `window.close()` in a Chrome app window).

## To publish (tier 1: Ryan's OK for each step)

1. Commit on `v1.1.1-prep`, or apply this diff to a branch off `v1.1.0`. Merge into `main`.
2. Run the Mac checks: `npm test` on the Mac, `npm run build:mac`, and Chrome :8437 with a 2.0 library in the same
   profile.
3. Push `main`, tag `v1.1.1`, build and upload the release, and update `docs/site/index.html`. It still links the
   1.1.0 notes, and its sizes are for 1.0.1.
4. Until 1.1.1 ships, 1.1.0 users are protected only by 2.0's own fix (kept copies and Restore previous library…).
