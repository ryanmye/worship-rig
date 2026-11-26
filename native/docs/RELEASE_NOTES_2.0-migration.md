# Worship Rig 2.0: bringing your 1.x library over (DRAFT, Lane E5, 2026-11-25)

This is a draft for the Lane R release notes. Everything marked *verified* was run in JS against libraries made by
the real 1.1.0 and 1.0.0 apps (`test/phase2/migration-1x`). Everything marked *not yet run* still needs the Mac or the
iPad.

## What moves

Every song, with:
- its 4 sounds and all their settings, scenes, tempo, key, time signature and notes;
- the drone and effects;
- factory songs you edited or deleted;
- songs that use My Samples instruments.

Also:
- every setlist, in order, with the current setlist and song;
- MIDI Learn mappings, Program Change ("Keyboard picks songs"), touch sensitivity, pedal polarity, latency and theme.

Program Change keeps working exactly as in 1.x: a program button jumps straight to the song. Turning it on fresh in
2.0 gives the new "cue, then Go" behaviour instead.

## Your own computer's settings (they come over from 1.1.1)

Some settings belong to one computer and one keyboard rather than to the library:
- each keyboard's touch curve, and "remember this keyboard";
- the dynamic range;
- the click (level, count-in, output) and MIDI clock out;
- global hotkeys, and the update check;
- the chosen MIDI input, audio output and My Pads folder;
- menu-bar mode and low-resource.

1.1.0 and older never wrote these into backups or exports. **Worship Rig 1.1.1 does** (*verified* in JS with
libraries made by the 1.1.1 code, `test/phase2/migration-1x/device-settings.test.mjs`):
- **From this Mac's backups** (the first-launch import, and Settings › Import latest backup…, which reads the old
  app's backups folder), 2.0 takes them over by itself.
- **From a file** (Settings › Import…), 2.0 asks first: "Also use its device settings here". The box is ticked when
  the file was saved on this computer and unticked when it came from another one. A file you pick in File › Import
  Library Backup… or receive by AirDrop brings the library only; import it with Settings › Import… to choose. On the
  iPad nothing is taken over by itself, not even from its own Backups folder.
- 1.1.1's Settings › Export library includes these settings only when you turn on **With this computer's device
  settings** next to its button. Its backups always include them.
- Either way, 2.0 only fills in what you have not set in 2.0 yet. A setting you changed in 2.0 stays, even if you
  changed it back to how it started.
- A MIDI keyboard, MIDI clock port, audio output or pad folder that is not there right now is skipped, and one line
  says which. Choose it again in Settings. A pad folder chosen in Chrome always has to be chosen again.
- A setting that 2.0 cannot use is left out, with a warning.

With a backup or export from 1.1.0 or older, set these once again in 2.0.

Also not moved, from any version: the My Samples packs themselves. Songs keep pointing at them: put the packs back
in `~/Music/Worship Rig/Samples/` (Mac). And 2.0's own per-computer settings (voices, buffer size, voice limit,
drone freeze) are never taken from a file.

## Steps: Mac

1. Open the old Worship Rig (1.x) once and quit it, so its latest backup is on disk. 1.x writes a backup whenever
   its window closes, about a minute after the first edit of a session and then at most every 10 minutes while you
   edit. Edits made since its last backup are only in the backup once the window has closed. A never-edited 1.x
   library has no backup, but it is only the factory songs anyway.
2. Open Worship Rig 2.0. On the first launch it asks **"Import your Worship Rig library?"**. Choose **Import**.
   - It only asks while the 2.0 library is untouched, and only once.
   - The 1.x backups are only read, never changed or deleted.
3. If you said "Not now", or want to do it later, choose **File › Import Library Backup…** and pick the newest
   `rig-….json`. 1.x's Rig menu › Open Backups Folder shows where they are.
4. Alternatively, in 1.x use **Settings › Export library**. Then in 2.0 use **Settings › Import…** with that file.
   - Into an untouched 2.0 library this replaces it completely, settings included. A theme you picked in 2.0
     before importing is replaced by the 1.x library's theme (or the default, if 1.x never had one set).
   - Into a library you have already changed it adds the songs and setlists, and leaves your settings alone.

## Steps: iPad

The iPad cannot read the Mac's files. Copy one file over:
1. On the Mac, take the newest `rig-….json` from 1.x's backups folder, or a Settings › Export library file.
2. AirDrop it to the iPad, or put it in Files. Then either:
   - open it with Worship Rig ("Import this library?" › Import), or
   - use **Import Library Backup…** and pick it.
3. The current iPad library is saved as a backup first (Files › On My iPad › Worship Rig › Backups). That backup can
   be imported back the same way.

## Safety (verified)

- Before an import replaces a library you have edited, that library is backed up. If the backup cannot be written,
  nothing is replaced. A change made while the backup is being written (a fader, a scene) is backed up too. Importing
  that backup brings the library back exactly.
- A damaged or truncated backup, a file from a newer version, or a `.json` that is not a Worship Rig library is
  refused, and nothing changes: not the library, and not the backups folder.
- A damaged library found at start-up is kept as `rig-unreadable-….json` before 2.0 starts fresh.
- Big libraries (tested at 200 songs, ~1.9 M characters, just under the limit) come over whole.
- Unicode names come over unchanged: CJK, Hebrew, emoji and accents.

## Going back to 1.x

1.1 does not crash on a 2.0 library. It refuses one: "This file was made by a newer version of Worship Rig."

The Chrome versions of 1.x and 2.0 keep their library in the same place in the browser. Going back and forth in one
Chrome profile is safe in 2.0 (D8, *verified* with the real 1.1.0 store, 2.0 → 1.1 → 2.0 → 1.1 → 2.0):
- When 2.0 upgrades a 1.x library, it keeps a copy of the 1.x library first.
- When 1.1.0 opens a profile that 2.0 already upgraded, it sets the 2.0 library aside and shows the factory songs.
  The next time 2.0 opens, it finds the set-aside library, keeps it, and says where it is.
- These copies are never deleted to make room for newer backups, however often you switch.
- **Settings › Library & backups › Restore previous library…** lists every library the browser kept, by date and
  version (1.x or 2.0), and puts the one you choose back. Your current library is kept first, so a restore can be
  undone the same way. If the current library cannot be kept (the browser's storage is full), nothing is replaced.
- Browser storage is limited (about 5 MB in Chrome). Only if it is full does 2.0 remove a kept copy, and then only an
  earlier state of a library that is still kept: an older copy whose songs and setlists are all in a newer copy, or
  in your current library. A different library is never removed to make room, and the newest 1.x copy and the
  newest 2.0 copy always stay. 2.0 says when it has removed one. If nothing can be removed, 2.0 says it could not
  save, and nothing is replaced. Export your library from Settings and remove songs you do not need.
- **Worship Rig 1.1.1** (a small 1.x update, *to be published*) never sets a 2.0 library aside. It says "This library
  was saved by Worship Rig 2.0 …" and offers a separate 1.x library, or to quit. 2.0's Restore previous library…
  lists that separate 1.x library too.

Still worth knowing:
- 1.x itself has no button to restore a kept library. Restore it in 2.0, or import a 1.x export file into 1.x.
- A hand-edited 2.0 file whose `schema` is set to 1 does load in 1.1. It cuts songs to 4 sounds (sounds 5 to 16 are
  lost) and ignores 2.0-only settings.
- Before going back to 1.x, Settings › Export library is still the simplest way to be sure. Keep your last 1.x export
  if you might go back.

## Large libraries

A library is meant to stay under about 2 MB (a song is usually about 2 KB, so this is hundreds of songs; long notes
and charts take the most room). 2.0 no longer refuses a save past that: it saves and warns you, once per session and
again at each further 10 % of growth. Restoring a library from a backup, an export or Restore previous library… works
up to 2.5 MB, so a library that grew a little past 2 MB can still be brought back. Adding songs from a file (a merge)
still has to fit the 2 MB.

## Not yet verified (needs the Mac or the iPad)

- The native first-launch prompt itself (NSAlert, the remembered answer) and its scan of `~/Library/Application
  Support/*/backups/`. The Electron folder name is still to be checked on the Mac.
- The iPad Files picker and AirDrop / "Open in" on a real iPad.
- The `via` tag the Mac app adds to each backup it hands over (1.1.1 settings), and the settings themselves on a real
  Mac with a real keyboard, audio interface and pad folder.
- WebKit's storage limit with a library near the 2 MB cap, and with kept copies next to it.
- One known gap: if the newest 1.x backup is damaged, the first-launch import fails safely but does not fall back to
  the next older one (the Swift side picks only the newest). Use File › Import Library Backup… and pick an older
  `rig-….json`.
