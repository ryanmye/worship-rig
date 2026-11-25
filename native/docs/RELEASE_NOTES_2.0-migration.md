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

## What does not move, and why

1.x never wrote these into its backups or exports, because they belong to one machine and one keyboard (the same rule
2.0 follows). Set them again once in 2.0:
- each keyboard's touch curve, and "remember this keyboard";
- the dynamic range;
- the click (level, count-in, output) and MIDI clock out;
- global hotkeys, and the update check;
- the chosen MIDI input, audio output and My Pads folder;
- menu-bar mode and low-resource;
- the My Samples packs themselves. Songs keep pointing at them: put the packs back in
  `~/Music/Worship Rig/Samples/` (Mac).

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

1.1 does not crash on a 2.0 library. It refuses one: "This file was made by a newer version of Worship Rig." If the
Chrome version of 1.x opens a browser profile that 2.0 already upgraded, it keeps the 2.0 library aside and shows the
factory songs.
- The 1.x library from before the upgrade is still in that profile, but 1.x has no button to restore it. Ask for
  help, or import a 1.x export file.
- A hand-edited 2.0 file whose `schema` is set to 1 does load in 1.1. It cuts songs to 4 sounds (sounds 5 to 16 are
  lost) and ignores 2.0-only settings.
- After that, opening 2.0 again in the same Chrome profile shows the factory songs, not your 2.0 library: the 2.0
  library is only in that hidden copy. Going back and forth twice deletes the hidden copies (only the newest 3 are
  kept), so the 1.x and 2.0 libraries are then gone from that profile. Before going back to 1.x, use 2.0's
  Settings › Export library, and keep that file.
- Keep your last 1.x export if you might go back.

## Not yet verified (needs the Mac or the iPad)

- The native first-launch prompt itself (NSAlert, the remembered answer) and its scan of `~/Library/Application
  Support/*/backups/`. The Electron folder name is still to be checked on the Mac.
- The iPad Files picker and AirDrop / "Open in" on a real iPad.
- WebKit's storage limit with a library near the 2 MB cap.
- One known gap: if the newest 1.x backup is damaged, the first-launch import fails safely but does not fall back to
  the next older one (the Swift side picks only the newest). Use File › Import Library Backup… and pick an older
  `rig-….json`.
