# Real 1.x library exports (Lane E5)

These libraries were made by the 1.x apps themselves, not written by hand. Each tag's own `app/` and `server.js` were
taken with `git archive <tag>` (no checkout) and run headless in Chromium. The libraries were built through 1.x's real
UI and its store and controller APIs, and written exactly as that build writes them.

| Folder | Tag | Commit |
|---|---|---|
| `v1.1.0/` | v1.1.0 | `c8704a77f3b6de8442f20c19bf1a8eb12924a030` |
| `v1.0.0/` | v1.0.0 | `b3d07581cf64a6d154e87eeefdd679ef02a80a80` |
| `v1.1.1/` | v1.1.0 + the uncommitted 1.1.1 patch (`native/docs/patches/v1.1.1-prep.diff`), run with `--from` | `c8704a77f3b6de8442f20c19bf1a8eb12924a030` + patch |

`v1.1.1/` was made from the v1.1.1-prep worktree as it is on disk (`--from`), because 1.1.1 is not committed or
tagged. Its manifest says so (`source.kind: 'worktree'`, the HEAD and the changed files). Its backups and exports
carry the D11 `deviceSettings` block.

The generator is `tools/gen-library-1x-fixtures.mjs`, as of lane-e5, based on v2-native `10c3ec7`.

## Files per library

- `<name>.backup.json` is the text 1.x's `controller.backupNow()` passes to `rig.backupNow`. Electron's main.js
  writes it verbatim as `rig-YYYYMMDD-HHMMSS.json`, tagged `{"origin":"http://127.0.0.1:<port>",…}`. The port is
  the generator's random one, not 8438.
- `<name>.export.json` is Settings › Export library. The real button was clicked and the download caught.
- `<name>.localstorage.json` is the raw `localStorage['rig.v1']`, the state 1.x held. The tests treat it as the
  truth.
- `*.json.gz` marks a file over 200 KB, which is written gzipped. Only `huge` is.
- `manifest.json` holds the commit, the counts, whether a backup was written, the console errors and the
  generator's details.
- `v1.1.0/downgrade-v1.1.0.json` is a 2.0 library offered to the 1.1 app through Settings › Import…,
  "Import latest backup" and localStorage. It records what 1.1 did and whether the page threw.

## Libraries

- `rich`: every 1.x feature.
  - Song and slot features: an edited factory song and untouched ones; 2 factory songs deleted; a blank user song
    with all 4 slots (gain, pan, octave, transpose, range, sends, velocity curve, bend, width, legacy eq and bands
    b2/b7, release, pedalHold, touch, sustain, mono); a My Samples slot (`user:my-grand`); a muted slot; fx
    eq/comp/lofi; drone; wheels; timeSig; tempo/key/minor; notes; a duplicate; a song made from a factory template.
  - Scenes: 2, saved through `controller.scenes.save` (v1.1.0 only).
  - Library and settings: 3 setlists; Program Change, Pedal reversed and the theme clicked in Settings; latency,
    touch and other settings; MIDI Learn (5 mappings); keyboards (touch curves); hotkeys; click; MIDI clock;
    dynamic range; device-local settings.
  - Unknown fields on the song, slot, setlist, settings and meta.
  - v1.0.0 has no scenes, keyboards or click, so those parts are skipped there.
- `devices` (v1.1.1 only, D11): every 1.x device-local setting (MIDI input `Stage Piano MIDI Out`, audio output
  `dev-0xabc`, the Electron pad folder `/Volumes/Rig/Pads`, MIDI clock `IAC Driver Bus 1`, two keyboards, click,
  hotkeys, menu-bar mode, low-resource, audio sleep, update check, dynamic range) and one user song. All made up.
- `pristine`: an untouched factory seed. 1.x writes no backup of it (round2-shell #2), so it has no `.backup.json`.
- `empty`: every song and setlist deleted.
- `unicode`: CJK, RTL with combining marks, ZWJ emoji, quotes, backslashes, U+2028 and a soft hyphen in a keyboard
  name.
- `deleted-factory`: 5 factory songs deleted (including the current one and since:2 songs), the library order
  reversed, one song reset to factory, one renamed.
- `huge`: 200 songs, 1 938 486 characters. That is just under the 2 000 000 cap (security S2).

No samples, no user data, no Apple content: every name and note is made up by the generator.

## Regenerate

```sh
git fetch --depth=50 origin tag v1.1.0 tag v1.0.0   # if the tags are missing
export PLAYWRIGHT_BROWSERS_PATH=/root/.cache/rig-pw  # in the cloud container
node tools/gen-library-1x-fixtures.mjs               # both tags; or --ref v1.1.0 --only rich,huge
node tools/gen-library-1x-fixtures.mjs --from <wt-111>  # v1.1.1/ from the v1.1.1-prep worktree (label: its version)
node test/phase2/migration-1x/run.mjs                # the suite reads the fixtures by content, not by id
```

Ids and timestamps change on every run. The tests never hard-code them.
