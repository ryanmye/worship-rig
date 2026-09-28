# Round 2 review: shell (server.js, serve.mjs, main.js, preload.js, store.js, controller.js, recorder.js, presets.js)

Scope: the CONTRACT_CHANGES sections "shell fixes", "shell-3" and "midi-default" (store/controller side only; midi.js was
not reviewed), plus how they interact with "engine-3" (reloadManifests, commit refusal) and the ui-core-2/ui-edit-2
consumers.

Suites: `node test/phase1/shell/run.mjs` gives **unit 122/122, browser 12/12, electron 14/14**, all PASS on the first
run on the loaded box.

Experiments (scratch: `/tmp/claude-0/.../scratchpad/review2-shell/`):
- `sec.cjs` and `sec2.cjs` are server attacks: traversal, symlinks, dir-index, Host, docs, object-map manifest and
  symlinked packs.
- `ctl.mjs` covers revertSong after import, edits made while a song loads, and a double refusal at start-up.
- `presets.mjs` covers normalisation and preset matching for the 19 songs, plus the top-up after an import.

Note: port 18555 on this box is held by another agent's Worship Rig server (old build, no `userSamples`). Tests that pick
random ports in 20000–40000 could collide with it rarely. That is not a code issue.

## Findings (most severe first)

### 1. MINOR (security invariant): the realpath check is bypassed through a directory named like an audio file. CONFIRMED
`server.js:573-577` (user samples), `server.js:653-656` (pads), `server.js:428-431` (sendFile directory → index.html)

**Problem.** `userSampleFile()` and the `/pads/` route realpath-check `abs` and then call `sendFile(abs)`. When `abs` is
a directory, `sendFile` appends `index.html` and serves that file with no realpath check. Suppose a pack contains a
folder `evil.wav/` whose `index.html` is a symlink to `~/anything`. Then
`GET /user-samples/<tok>/pack/evil.wav` returns that file as `text/html`. Measured: 200, body `"TOP SECRET"`. The same
works for the pads folder: `/pads/<tok>/C.wav` returned 200 `"PAD SECRET"`. A non-link `index.html` in such a folder is
also served as same-origin HTML. It does get the CSP.

**Impact.** Limited. The token is only known to same-origin code, and `nosniff` + CSP rule out script execution from a
pack. But this breaks the documented guarantee "the file must realpath inside the pack/pad folder". Sample packs and pad
folders are exactly the kind of content that gets downloaded as zips, which can contain symlinks.

**Fix.** In both routes, after `realpath`:
- require `(await fsp.stat(real)).isFile()`;
- pass `real`, not `abs`, to `sendFile`. This also closes the check/open TOCTOU.

Give `sendFile` an option such as `{dirIndex:false}` so only the app route resolves `index.html`.

### 2. MINOR→MAJOR if hit (data safety): a pristine fallback-port library becomes the "newer library" offer. SUSPECTED (code-traced, not run in Electron)
`main.js:690` (finishClose), `main.js:231` (otherLibrary), `controller.js:1551` (`__rigShell.library`),
`controller.js:1388` (checkOtherLibrary)

**Chain.**
1. 8438 is busy, so Electron opens on 8439. Its localStorage is empty, so the store seeds the factory library.
2. The M5 dialog appears and the user clicks "Continue".
3. On quit, `finishClose` always writes `backupNow(library)`. The file is prefixed `"origin":"http://127.0.0.1:8439"`,
   so it becomes the newest rotation file.
4. On the next normal launch on 8438, `otherLibrary()` sees newest-backup origin ≠ ours. The banner and warn say *"A
   newer library from http://127.0.0.1:8439 … isn't shown here"*, and the banner button offers
   `importLatestBackup({replace:true})`.

That replaces the real library with an untouched factory library. It is recoverable, because the current library is
backed up first, but only from the Backups folder. Each such close also rotates a real backup out (10 kept).

**Fix.** Choose one of these (the first is the simplest):
- Don't write the close or scheduled backup while the library is pristine. The store knows this: `loadInfo.status ===
  'fresh'` and no entity path changed since. Have `__rigShell.library()` return `null` in that case.
- Have `otherLibrary()` only offer a backup whose library differs from a pristine factory seed, for example with a
  `meta.edited` flag or `meta.lastEditAt` in the export.

### 3. MINOR: `controller.revertSong()` snapshot is not refreshed by an import. CONFIRMED
`controller.js:451` (`selected = {id, song}`), `controller.js:465-476`, `controller.js:1408-1419`

`store.importJSON(…, {replace:true})` keeps `currentSongId`. The store subscription then only runs `applyDiff`, not
`selectSong`, so `selected` still holds the pre-import song.

Measured (`ctl.mjs` E1): after an import that sets slot-0 gain 0.123 and tempo 111, `ctl.revertSong()` returned true
and wrote back gain 0.8 and tempo null, so the imported values were lost.

Perform currently uses its own snapshot (`perform.js:469`) and re-snapshots after `importBackup`, so today this only
affects API callers. It is still a trap for the next UI that calls the contract API.

**Fix.** Re-snapshot `selected` when a store change replaces `songs.<selected.id>` wholesale (the import path) and in
`importLatestBackup()`, or clear it (`selected = null`) whenever `importJSON` succeeds.

### 4. MINOR: the `songSelected` / `revertSong` snapshot is taken at request time, not at commit time. CONFIRMED
`controller.js:403` (`const song = store.getSong(id)` before `await prepare`), `controller.js:451-453`

When the user moves a fader while a song loads (sampler loads take seconds), `catchUp()` correctly sends the edit to the
engine, but the snapshot and `songSnapshot` are the pre-edit song. Measured (`ctl.mjs` E2): store gain 0.31, snapshot
gain 0.7. So "Revert" undoes a change made during loading, and `songSelected.patchSnapshot` does not match what the
engine plays at the event.

**Fix.** Use `const committed = store.getSong(id)` right after the commit, for both `selected` and the event payload.
Alternatively, document that the snapshot is the song "as requested".

### 5. MINOR: a pack manifest in object-map form silently yields 0 instruments. CONFIRMED
`server.js:344`

The server accepts only `{instruments:[…]}` or a top-level array. The engine's `normalizeManifest`
(`sampler.js:54-55`) also accepts `instruments: {id: {...}}`, which is the "same format as app/samples/manifest.json"
that the README.txt promises. Measured: pack `mapform` → `packs:[{slug:'mapform',count:0}]`, `errors: []`. The user
sees nothing and gets no explanation.

**Fix.** Accept the object form the same way (`Object.entries(list).map(([id, v]) => ({id, ...v}))`). Either way, push
an `errors` entry when a pack's manifest has no instrument list.

### 6. MINOR (UX): a pack symlinked from outside the root is skipped with no error entry. CONFIRMED
`server.js:329-330`

`~/Music/Worship Rig/Samples/BigPiano → /Volumes/External/BigPiano` is a natural setup for large GarageBand
conversions. Measured: `instruments 0, packs [], errors []`. The per-file realpath check already confines serving to
`pack.dir`, so allowing an out-of-root pack adds no new reach: the user put the link there. At the very least, add an
`errors` entry ("… is a link to a folder outside My Samples; move the folder here instead").

Note that the contract text describes the skip as intended. This finding is about the silence.

### 7. MINOR: "Importing GarageBand Sounds" may do nothing on a stock Mac. SUSPECTED (macOS behaviour, not testable here)
`main.js:447-460` (openDoc), `main.js:433` (openReadme), `views/settings.js:703-705`

`openDoc` writes `Worship Rig <n>.md` to temp and calls `shell.openPath`. With no app registered for `.md` (common
without Xcode or an editor), `openPath` returns an error string. Settings ignores the returned `{error}`, and the Help
menu only logs it, so the click does nothing.

**Fix.** On an `openPath` error, fall back to `shell.openExternal(\`http://127.0.0.1:${port}/docs/${n}.md\`)`. The server
already serves `/docs/*.md` as text/plain for exactly this. Alternatively, write the temp copy as `.txt`.

### 8. MINOR (musical balance): the stab and lead layers of two new songs can't come forward. SUSPECTED (numbers from the engine-3 audition, not re-measured)
`presets.js:400` (Gospel Stab + B3, poly-stab gain 0.5), `presets.js:513` (Synthwave, square-lead gain 0.6)

The engine-3 audition reports the poly-stab at −12.6 dB and the square lead at −13.5 dB under the mix. For Gospel Stab
the mod wheel is `slots.1.gain` with max 1, so full wheel leaves the stab at about −12.6 dB. That contradicts "bring
the stabs in for hits". A lead melody 13 dB under the chords is buried.

**Suggested fix.** poly-stab 0.5 → about 0.8 (+4 dB) and square-lead 0.6 → about 0.9 (+3.5 dB). Then re-run
`node tools/audition.mjs` for those two songs to confirm the peak stays under −1 dBFS.

### 9. NIT (convention): Clav Funk's space shows "Custom". CONFIRMED
`presets.js:440`

`fxMerge(fxParams(space('room'), …), {reverb:{returnGain:.5}})` overrides one preset value, so `matchPreset` finds no
space (measured: space null, echo slapback). That goes against CLAUDE.md's "spread in unchanged, so the UI shows their
names". The contract table does say "reverb return .5", so this is deliberate.

**Option.** Keep Room unchanged and lower the slot reverb sends instead (0.12/0.15 → about 0.09/0.11). The space then
reads "Room".

### 10. NIT: a double refusal on the very first selection leaves `status.songId` null while the store selects the song. CONFIRMED
`controller.js:436`

Measured (`ctl.mjs` E3): `status.songId null`, store current `song1`, one warn. The warn tells the user to press the
song again, which works because `selectSong` runs afresh. Any UI keyed on `status.songId` shows no song until then.

**Fix.** When `appliedId` is null, keep `songId: id` with `loading:false`, or add `status.songFailed:true`.

## Solid (checked, no action)

**Server security.**
- Encoded traversal (`%2e%2e/`), an encoded slash in the slug (`pack%2F..%2F..`), an escaping file symlink and a wrong
  token all return 404.
- Host `evil.example` and `127.0.0.1.evil.com` return 403. `localhost` is allowed.
- `/docs/` rejects `..%2f` and dot-names: the regex allows no `%`, and `safeJoin` rejects dot segments. Docs are served
  `text/plain` + `nosniff`.
- The CSP header equals the `index.html` meta plus `frame-ancestors`.
- Files get `CORP: same-origin`. That stops cross-origin `<audio>` use even with a leaked token.
- The UI has no `innerHTML` sinks, so pack-supplied names and attributions can't inject markup.

**Manifest rewrite.**
- `..`, absolute paths and URL `files` entries are dropped. Slug and dir are `encodeURIComponent`-ed per segment and
  decoded once by `safeJoin`, so the round trip is consistent.
- The token is stable across rescans. Concurrent rescans are coalesced.
- Always 200 when the feature is off or a folder is missing.
- API routes under a prefix are answered (`/foo/bar/api/user-samples/manifest.json` → 200).

**selectSong / reprepare retry (engine-core #18).**
- The `my !== seq` check comes before `commit`, and commit plus the recursive retry are synchronous. A newer tap can
  therefore never be overridden by a retry, and a superseded retry returns false.
- The engine refuses exactly on a stale `_latestToken` or a missing plan, which the retry re-creates.
- A double refusal restores the selection to `appliedId`/`appliedIndex`.
- reprepare mirrors this with one forced retry.
- `songSelected` is emitted once per successful select, including after a retry.

**The 8 new songs.**
- All normalise unchanged (no clamping).
- Every instrument id exists: the samplers are in `app/samples/manifest.json` (A0–C8), and the synths are in
  `synth-extra.js`.
- Splits match the notes: 59/60 for "below middle C", 71/72 for "from C5", and C3 = 48.
- Bend 'morph' ignores `bendEnabled` (`audio.js:_morphFor`), so "bloom" and "rotary" claims work even on slots with
  pitch bend off.
- `macro.intensity` scales slot 1 by 0.35–1 and morphs the pad-like instruments, as the Anthem and Dream Juno notes
  describe.
- Preset matching (measured):

  | song | matches |
  |---|---|
  | Anthem | Stage / Dotted / Full Set |
  | Gospel Stab + B3 | Room / Slapback (also Jam) |
  | Upright + Pad | Stage / No Echo |
  | Music Box Lullaby | Cathedral / No Echo |
  | Dream Juno | Wash / Ambient Trails / Ambient |
  | 80s Ballad | Hall / No Echo |
  | Synthwave | Stage / Quarter |

- All songs with a synced echo carry a tempo.
- The engine-3 audition reports all 8 as PASS (−17.8…−23.3 dBFS, peak ≤ −1.42).

**Factory top-up.**
- It runs once (main.js calls `seedFactory` at boot), appends to the library only, skips existing `factoryId`s, and
  never touches setlists or the current song. A fresh seed writes v2.
- Measured by-design edge: importing (replace) an old v1 backup with no `factoryVersion` makes the next boot append
  the 8 songs again. That is consistent with the migration, but it happens one restart after the import, not at it.

**Test suites.** All three green: unit 122, browser 12, electron 14.

## Prioritised fix list

1. **#1 dir-index realpath bypass.** Serve `real`, require `isFile()`, and disable dir-index for `/user-samples` and
   `/pads`. About 6 lines. Add a test with a `x.wav/index.html → outside` symlink for each route.
2. **#2 pristine fallback-port backup.** Skip backups of an unedited library, or don't offer them as "newer". This
   protects the real library in the M5 path.
3. **#4, then #3: snapshot semantics.** Snapshot at commit time, and refresh or clear `selected` on import. Both are
   small changes in `controller.js`, with the two `ctl.mjs` cases as tests.
4. **#5 and #6: My Samples diagnostics.** Accept the object-map manifest, and report empty or out-of-root packs in
   `errors`.
5. **#7 docs fallback.** Use `openExternal` to the served `/docs/…` when `openPath` fails.
6. **#8 and #9: preset balance.** Raise poly-stab and square-lead, re-audition, and optionally keep Clav Funk's space as
   a named preset.
7. **#10.** Cosmetic status on the first-select failure.
