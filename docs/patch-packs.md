# Patch packs

A patch pack is a folder of your own song files that Worship Rig loads by itself. Use one to keep your sounds for
specific songs (layers, effects, scenes, drone, key and tempo) next to the sample instruments they use. It also
works as a song bank: a list of ready-made songs you add to the library one at a time.

Patch packs live in the same folders as My Samples ([GarageBand import](garageband-import.md)). Like My Samples
content, they are never put in the git repository and never packaged into the app.

## Where packs go

The pack folders sit in the My Samples folders:

- `<repo>/user-samples/` (when you run from the source folder)
- `~/Music/Worship Rig/Samples/`

`RIG_USER_SAMPLES` replaces both, as for My Samples. If two folders hold a pack with the same name, the first one
is used.

```
~/Music/Worship Rig/Samples/
  Cedar Keys/                 ← a pack (the folder name is the pack's id)
    manifest.json             ← optional: My Samples instruments (user:<id>)
    pack.json                 ← optional: {"mode": "auto" | "bank", "name": "…"}
    songs/
      lantern-hymn.json       ← one song, in the app's song export format
      sunday-set.json         ← or an array of songs
```

Each file in `songs/*.json` holds one of these:

- One song, exactly as **Edit › Export song** writes it: `{"app":"worship-rig","kind":"song","schema":2,"song":{…}}`.
- An array of such songs, or of bare song objects (an object with a `patch`). A bare song has no `schema`, so it is
  read as a 1.x song with 4 slots, the same as Import does.

A song can use the pack's own sampler instruments by their engine id, `user:<id>`, where `<id>` is the instrument
id in the pack's `manifest.json`. If an instrument isn't found in any My Samples pack, the server reports it and the
song is still loaded; that slot simply makes no sound until the instrument is there.

### Song bank metadata (optional)

A song file can carry a `bank` block next to `song`. A plain exported song file doesn't have one, and the block
doesn't change how the file imports:

```json
{ "app": "worship-rig", "kind": "song", "schema": 2,
  "song": { "name": "Lantern Hymn", "tempo": 72, "patch": { … } },
  "bank": { "title": "Lantern Hymn", "artist": "…", "ccli": "1234567", "originalKey": "Eb",
            "bpm": 72, "timeSig": "6/8", "tags": ["slow", "opener"] } }
```

`title` is required (if it is missing, the song's name is used). Any other field that doesn't look right is left
out. The song itself still holds the sound, the key and the tempo. The bank fields are only used for browsing.

## Auto packs and bank packs

- **Auto (the default).** The pack's songs are added to the end of the library at start-up, each one once. They are
  not added to any setlist.
- **Bank** (`pack.json` has `"mode": "bank"`). Nothing is added by itself. The songs are listed in
  **Settings › My Samples › Song bank**, where you can search by title or artist. **Add to library** copies one song.
  With the new layout (UI v6), the Song bank opens over the stage instead, from the Setlist's **+ Add song › From
  the Song bank** or **Settings › Sounds & Samples › Open Song bank…**: filter by key, tempo, feel and pack, and
  **Try it** plays a song without adding it (nothing is saved until you keep it).

After you add a pack, or change one, press **Rescan** in Settings › My Samples, or restart.

## What happens when a pack changes

Each pack song has a stable id, `<pack>:<file>`, with `#<n>` added for the n-th entry (counting from 0) of an
array file. The library remembers every pack song it has taken in.

| You… | Worship Rig… |
| --- | --- |
| add a song file | adds the song once (auto packs) |
| change a song file, and haven't edited that song | updates the song in place: the same library entry, position and setlists |
| change a song file, and have edited that song | keeps your version and never overwrites it |
| export your edited song back into its pack file | takes the file as your version, so later changes to the file update the song again |
| delete a pack song from the library | remembers that, and doesn't add it again, even if the file changes later |
| remove the pack folder | changes nothing: the songs stay in the library |
| reorder the songs in an array file | treats each position as the same song, so append new songs to the end |

"Edited" means any change saved to that song: its sounds, levels, mutes, key, tempo, notes or chart. If you
change a value back by hand, the song counts as unedited again. A song updated in place while it is on screen
takes the new version as its saved state, so Revert doesn't bring the old version back.

A file is "changed" when its content changes. Saving it with no changes does nothing.

## Limits

| What | Limit |
| --- | --- |
| One file | 1 MB |
| Files per pack | 200 |
| Songs per file | 100 |
| Pack songs in all | 2000 |
| All pack files together | 8 MB |
| Nesting depth | 64 |
| Slots per song | 1 to 16 |

Anything over a limit is skipped and listed in the log or warning. A song that doesn't fit the library's 2 MB cap is
skipped and tried again at the next start.

## Where it works

- **Mac app (Electron) and the Chrome version:** fully supported.
- **The native 2.0 shell:** doesn't serve My Samples yet. Its `/api/health` says `userPatches: false`, so the
  app never asks for packs there.
