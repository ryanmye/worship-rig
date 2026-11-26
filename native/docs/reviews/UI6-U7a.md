# UI v6 U7a (Song bank browser + Try it): skeptic review (2026-11-26)

Verdict: **VERIFIED, after fixes.** As delivered it was PARTIAL. The core promise held: no trial song ever reached
storage, an export or a backup, and `meta.edited` never moved. Four defects sat around it: one medium (the saved
setlist position and Back went wrong after a setlist edit during a trial), one medium in playing (Next during a trial
went back to the top of the set) and two low.

Under review: b96e6d5, 9bfa25f, 175bf55 and 9bb45f0 on lane-u7a, rebased on v2-native aae23ce. They add the store's
trial songs (`startTrial` / `endTrial` / `persisted` / `packSongPreview`), the controller's `tryBankSong` /
`backFromTrial` / `keepTrial` / `trial` / `bankSong`, `views/v6/bank/` and `styles-v6-bank.css`, and touch
`main.js`, `v6/perform.js`, `v6/settings.js` and `v6/sidebar/setlist.js`. I didn't build it. The library's
persistence was the first thing I checked.

These claims held:

- **Every write path goes through `persisted()`.**
  - In the store: `persistNow` (and its D10 retries), `exportJSON` and `keepCurrent`. The other `keepRaw` calls
    copy raw storage text.
  - Electron: the debounced backups, Back up now, the backup before a replace, and the backups on hide and close
    (`__rigShell.library()` → `libraryJSON()` → `exportJSON`).
  - Settings' and Edit's Export library also go through `exportJSON`.
  - The native shell writes nothing of its own. Its `RigLibrary.swift` `backupNow(json)` gets `libraryJSON()`, and
    the library lives in WKWebView localStorage through the same store. `rig://` also says `userPatches: false`, so
    nothing can start a trial there yet.
- **The save debounce.**
  - A save already pending when a trial starts writes `persisted()` when it fires.
  - A real edit during a trial (notes, setlists, theme, MIDI Learn, deletes) is saved without the trial song, with
    the replaced selection.
  - A write that only touches the trial song schedules no save, and the store writes nothing.
- **D10, storage full during a trial.** I used a quota-limited storage: the save is refused, the last good save and
  every kept key are unchanged, and the retry writes no `trial:`.
- **A muted second window opened mid-trial** reads the library with the previous song current and no trial song.
  It is `second-window` read-only, and its Try it is refused with the secondary message.
- **Reload, replace and import.** `migrate()` drops `trial:` songs. A reload lands on the replaced song (bank-trial
  checks the controller end to end). `trialSeq` never restarts within a page, and storage never holds a trial id,
  so ids can't collide. The D23 slot lineage of a trial song goes with `endTrial` (`put(undefined)` →
  `noteLayout`).
- **Edits to the trial song stay with it.** I tried insertSlot, moveSlot, rename, saving scenes, Revert and a
  MIDI Learn clear. localStorage was byte for byte unchanged during the trial and after Back, and no `trial:`
  appeared.
- **Song switches end a trial.** GO, Next / Prev, a library row, Program Change (through `applySong`), the menu-bar
  mode select and setCurrentSetlist all commit a library song, and `trialCommitted` drops every trial song.
- **Controller property run** (scratch, not committed): 25 seeds × 40 random steps of try / back / keep / fader /
  real edit / select / next / setlist remove / reload / revert / scene / insertSlot / lock.
  - Storage never held `trial:`.
  - The saved current song always existed.
  - There was never more than one trial song.
  - `controller.trial()` was set exactly when the store had a trial song.
  - Order, setlists and `meta.edited` changed only through library operations.
  - Back always landed on `trialReturn()`.
  - Result: 0 problems.
- **UI.**
  - The strips and sidebar are `inert` under the browser: 60 Tabs never reached them. The left panel, song bar,
    keyboard row, PANIC and Lock stay reachable.
  - The computer keyboard plays while the browser has focus.
  - Esc (D24.7):
    - With "Esc always panics" off, the first Esc closes the browser without a panic, and the next Esc panics.
    - With it on, one Esc panics and closes the browser.
    - Typing in the search box, Esc closes the browser and never panics.
    - No check covered this before. It is now a ui-v6-bank check.
  - The iPad portrait and 1280 screenshots match the mockup's layout.
  - Flag off: purity vs aae23ce is identical (105 requests, 15 store listeners, 4 intervals, 2529 elements).
  - Without packs nothing is requested (ui-v6-bank's first check).
- **Engine, `shared/`, server and Electron main: unchanged** (`git diff aae23ce`).

## Findings

- **F1 (medium, library position) A setlist edit during a trial left the saved selection and Back on the wrong
  entry.**
  - `trialNav` (the selection `persisted()` saves, and Back's way home) was captured at Try it and never followed
    list edits.
  - During a trial, `removeFromSetlist` / `moveSong` / `addToSetlist` / `duplicateSong` / `deleteSong` repositioned
    the trial song's own position (-1, it is in no list) instead of `trialNav`.
  - The saved `setlistIndex` / `setlistGap` then differed from the library without the trial. In a scratch property
    run against a reference store that never sees the trial, 378 of 400 seeds failed.
  - Back landed on a shifted index, or on the first copy of a reprise.
  - Deleting the replaced song during a trial left Back going to the top of the list rather than to the song after
    it (M4).
  - Fix (d7033df): `navBase()` / `putNavPos()` reposition `trialNav` the way M4 repositions the selection.
    `deleteSong` of the replaced song moves `trialNav` on to the song that followed it. `deleteSetlist` and
    `setCurrentSetlist` reset its position. The new `store.trialReturn()` is Back's target, and the controller's Back
    and `trial().prev` use it.
  - Tests:
    - bank-trial "skeptic F1": a reprise, a removal before it and a delete, compared with the reference.
    - A 60 seed × 60 step property: storage and export always equal the reference.
- **F2 (low, PP-1 through the trial) A pack update during a trial froze the song.**
  - A rescan during a trial updated the replaced pack song in place. Back brought back the old version as its Revert
    snapshot, so Revert after Back wrote the old pack version back.
  - That reads as an edit, so the song stopped taking pack updates.
  - Fix (fcc1f90): `packSongsUpdated` also refreshes `trial.prev.baseline`.
  - Test: bank-trial "skeptic F1–F3". It fails without the fix ("Revert after Back = the updated pack version").
- **F3 (low) Keep missed fields the player removed while trying.**
  - Keep copied only the keys present in the trial song. A `timeSig` set back to 4/4 (removed), or a removed chart,
    stayed on the kept song.
  - Fix (fcc1f90): Keep compares the union of both songs' keys, and a removed key is written as `null`, which
    removes it.
  - Test: the same test. It fails without the fix ("kept as it was played (4/4)").
- **F4 (medium, playing) Next during a trial went back to the top of the set.**
  - A trial song is in no list, so `store.neighbors()` gave index -1 and next = the first song.
  - A pedal or learned Next, →, or a GO with nothing cued, while trying a bank song mid-set, played song 1.
  - Fix (bb295df): `neighbors()` reads `navBase()`. Next plays the entry after the replaced one and Prev the one
    before, and the preload window follows. The trial song's `currentIndex()` stays -1.
  - Test: bank-trial "skeptic F4", which fails without the fix. Flagged in O5 as a choice to confirm.

These are acceptable or not defects:

- Size checks (`topUpPacks`' `fits`, `addPackSong`, the chart cap) measure `JSON.stringify(state)`, which includes
  the trial song. They over-count by one song, so they are conservative and never let the library grow past the cap.
- `backUpBeforeReplace` compares `store.get()` parts, which include trial songs. A fader move in a trial during an
  import's backup wait makes it refuse ("kept changing"). That is conservative, and nothing is lost.
- Export song on a trial song (Edit) writes that one song with its `trial:` id. Importing it gives a new id. This is
  explicit, one song, and not a library export or backup.

## Gate

The box had 2 CPUs, shared with lane-u5b's skeptic. I ran the suites one at a time.

| suite | result |
|---|---|
| bank-trial (`node --test test/phase1/shell/bank-trial.test.mjs`) | **8/8** (4 + F1, F1 property, F1–F3, F4) |
| shell unit (`test/phase1/shell/run.mjs --only unit`, incl. ui-v6-bank unit, patch-packs unit) | **377/377** |
| ui-v6-bank (`test/phase2/ui-v6-bank/run.mjs`) | **16/16** (15 + Esc) |
| ui-v6 (incl. flag-off purity vs aae23ce) | **68/68**, purity identical |
| settings (5 modes) | **111/111** |
| ui-core | **78/78** on the rerun. The first run had 77/78: "every factory song … Lofi Rhodes reaches −200 dBFS within 500 ms", a timing check, run while the other lane's Chromium was busy (load 5.5) |
| migration-1x (library safety) | unit **107/107**, browser **8/8** |
| patch-packs.pw | **5/5** |
| each new check against the pre-fix code | F1 ×2, F1–F3 (each part separately) and F4 fail without their fixes |
| console.error / HTTP ≥ 400 | 0 |
| ui-v6-edit, edit-v2, Electron / Mac suites | not run |

## Fixes (commits on lane-u7a)

- d7033df F1 (`store.js`, `controller.js`, `bank-trial.test.mjs`).
- fcc1f90 F2 / F3 (`controller.js`, `bank-trial.test.mjs`).
- bb295df F4 (`store.js`, `bank-trial.test.mjs`).
- e333dd7 the Esc check in ui-v6-bank (test only).
- This review, plus a skeptic note in CONTRACT_CHANGES "## UI v6 U7a (Song bank)" and in the build plan's U7a status.

## Open items

- **O1 Esc in the browser's search closes the whole browser (low).** Settings' search clears first. Here one Esc
  with text typed closes the browser, and the filter text stays for the next open.
- **O2 Back can't bring back the "gap" state (low).**
  - If the replaced entry itself is removed during a trial, the save and a reload keep the gap correctly (F1).
  - Back, though, selects the song through `selectSongId`, which always clears the gap. It lands on another copy of
    that song, or on the song outside the list.
- **O3 A trial song has an Edit "Export song"** with a `trial:` id in the file (builder's "not done").
- **O4** Edit v6's "Song bank…" title still says "today's list in Settings" (builder's, lane-u5b's file).
- **O5 Choices to confirm with Ryan**, from the builder, plus mine:
  - The tempo bands are Slow < 80 ≤ Mid < 115 ≤ Fast.
  - Feel matches any chosen tag.
  - Keep keeps what the player changed while trying, so the kept song reads as edited.
  - Back works under Lock.
  - A second Try it keeps the first one's Back.
  - My library's Try it is a plain switch.
  - Mine (F4): Next / Prev from a trial step from the replaced entry.
  - Mine (F1): if the replaced song is deleted during a trial, Back goes to the song after it.
  - A setlist switch during a trial selects that setlist's first song, which ends the trial, because the trial song
    is in no list.
- **O6 Not verified:**
  - the real Electron app's backups (code read only);
  - the native app (no bank on `rig://` yet; code read only);
  - a real iPad / WebKit;
  - real MIDI Program Change hardware (the code path is `applySong`);
  - the 1.1.1 kept copies with a trial running (code read: `keepCurrent` writes `persisted()`; migration-1x is
    green);
  - screen readers;
  - themes other than Sanctuary.
