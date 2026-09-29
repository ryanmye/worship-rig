# Importing GarageBand / Logic instruments ("My Samples")

`tools/import-garageband.mjs` converts the sampled instruments that ship with GarageBand and Logic (EXS/Sampler
instruments: Yamaha and Steinway grands, strings, choirs, bells, …) into Worship Rig's sample format. The app loads
them as **My Samples** next to the built-in instruments.

It runs with Node 18 or later and has no npm dependencies. For audio it uses **ffmpeg** when it is installed
(`brew install ffmpeg`), otherwise the `afconvert` command that ships with macOS. ffmpeg is needed for the best
results: it cuts zones out of Apple's consolidated `.caf` files by exact sample counts, and it writes mp3 like the
bundled library. afconvert has no mp3 encoder and no sample-accurate cut (details below).

## Personal use only

The instruments are Apple's content, covered by the GarageBand/Logic software licence. As far as I understand it,
that licence lets you use the sounds in your own music and performances. It does not let you redistribute the samples
themselves. (That is a plain-language reading, not legal advice.) So:

- The converted files go to `~/Music/Worship Rig/Samples/` (default) or `<repo>/user-samples/`. Both are scanned by
  the app, both are outside what gets packaged, and `user-samples/` is git-ignored. **Never commit, bundle or share
  them.**
- Every instrument's manifest entry carries `"license": "personal-use"` and
  `"attribution": "Apple Logic/GarageBand sound library — personal use only, not redistributable"`.
- The six real Apple instrument *definitions* (zone maps, no audio) used as parser test fixtures are Apple files, so
  they are not in the repo: they live on the Mac in `~/Music/Worship Rig/exs-fixtures/` (override with
  `RIG_EXS_FIXTURES=<dir>`), and `test/unit/exs/real-files.test.mjs` skips when that folder is missing.

## Quick start

```sh
cd ~/Projects/worship-rig
brew install ffmpeg                                        # optional but recommended
node tools/import-garageband.mjs --list                    # what's installed, sample counts, estimated size
node tools/import-garageband.mjs --import "Yamaha Grand Piano" --dry     # preview, writes nothing
node tools/import-garageband.mjs --import "Yamaha Grand Piano"
node tools/import-garageband.mjs --validate "$HOME/Music/Worship Rig/Samples/yamaha-grand-piano"
```

Then restart Worship Rig or use **Settings → Rescan samples**. The instrument appears under My Samples as
"Yamaha Grand Piano (Logic)".

Commands for importing the two pianos into the repo's `user-samples/` (what the first real run is set up to do;
`--batch 60` keeps each command short and is only needed where a command has a time limit):

```sh
node tools/import-garageband.mjs --list --pianos
node tools/import-garageband.mjs --out user-samples --import "Yamaha Grand Piano"
node tools/import-garageband.mjs --out user-samples --import "Steinway Grand Piano 2" \
  --id steinway-grand-piano --name "Steinway Grand Piano"
node tools/import-garageband.mjs --validate user-samples/yamaha-grand-piano
node tools/import-garageband.mjs --validate user-samples/steinway-grand-piano
```

When the library is not in the default place (for example a copy mounted elsewhere), add
`--root "<…>/Logic" --root "<…>/GarageBand/Instrument Library"`.

| option | meaning |
|---|---|
| `--list` | Instruments found. `samples` = audio files found / files needed; size = estimate of the converted output. `(consolidated)` marks instruments that live in one `.caf`. Combine with `--pianos` / `--import` to filter. |
| `--import "<text>"` | Import every instrument whose name contains the text (case-insensitive); an exact name match wins over substring matches. Repeatable. |
| `--pianos` | Import every name matching `piano\|grand\|upright\|keys`. |
| `--dry` | Print the plan (layers, notes, size), write nothing. |
| `--out <dir>` | Output root (default `~/Music/Worship Rig/Samples`; `<repo>/user-samples` also works). A folder inside `<repo>/app` is refused, since it would be packaged. |
| `--format mp3\|m4a\|wav` | `mp3` (default with ffmpeg) = 160 kb/s, 48 kHz, like the bundled library. `m4a` (default with afconvert only) = AAC 192 kb/s. `wav` = 16-bit PCM. |
| `--bitrate 160k` / `--rate 48000` | Encoder bitrate / output sample rate (rate: ffmpeg only). |
| `--encoder auto\|ffmpeg\|afconvert` | Default: ffmpeg if installed. |
| `--max-mb N` | If the estimate is above N MB (default 120), thin every layer to a minor-third grid (then evenly) until it fits. `0` = off. |
| `--max-notes-per-layer N` | Thin each velocity layer to at most N notes (minor-third grid first, lowest and highest kept). |
| `--max-seconds auto\|N\|0` | Cut each file after N s. `auto` (default) = the app's own cap + 1 s: 17 s up to C4, 11 s above (the sampler never plays further). |
| `--no-levels` | Don't bake Logic's group + zone volume into the files (see "Levels"). |
| `--id <slug>` / `--name <text>` | Override the output folder/id and the display name (one instrument per run). |
| `--jobs N` | Parallel ffmpeg conversions (default: CPU count, max 8). |
| `--batch N` | Convert at most N files, keep the work folder, exit with code 3. Run the same command again to continue; the finished instrument is installed on the last run. |
| `--dump <file.exs>` | Print everything the parser read from one file, plus the plan. `--hex` adds raw chunk bytes, `--json` gives JSON. |
| `--validate <pack dir>` | Check an imported pack: manifest keys/shape match `app/samples/manifest.json`, velocity layers tile 0–127, every file exists, decodes (ffprobe), lasts > 0.2 s, is not silent (peak ≥ −60 dBFS), has no DC offset (\|dc\|/peak ≤ 5e-4) and is not clipped; total ≤ `--max-mb`. Prints a size table. Needs ffmpeg/ffprobe. |
| `--root <dir>` | Search this folder instead of the Apple locations (repeatable; used for both instruments and audio). |
| `--cache <file>` / `--reindex` | Sample-index cache location / force a rebuild. |

## Where it looks

Instruments (`.exs`):

- `/Library/Application Support/GarageBand/Instrument Library/` (whole tree)
- `/Library/Application Support/Logic/Sampler Instruments/`
- `~/Music/Audio Music Apps/Sampler Instruments/`

Audio files. An `.exs` stores each sample's file name plus a folder path from Apple's authoring machine, so files are
found by name, in this order:

1. next to the `.exs`
2. the stored folder, if it exists on this Mac
3. an index of every audio file under the GarageBand Instrument Library (including `Sampler Files`), `Logic/EXS
   Factory Samples`, `Logic/Sampler Instruments` and `~/Music/Audio Music Apps/{Samples,Sampler Instruments}`. The
   match is by exact name, ignoring case. If two files share a name, the one whose folders match the stored path wins.
4. the same name with a different audio extension (`.aif` → `.caf`, etc.)

The index is cached in `~/Library/Caches/worship-rig-exs-index.json`. It is rebuilt when a search folder's
modification time changes, when it is more than 7 days old, with `--reindex`, or once per run if a selected
instrument has missing samples.

## What gets written

```
<out>/yamaha-grand-piano/
  manifest.json
  v0-64/A0.mp3  C1.mp3  Db1.mp3 …
  v65-99/…
  v100-127/…
```

`manifest.json` has exactly the shape of `app/samples/manifest.json`: `{ "instruments": [ … ] }`, and each instrument
uses the bundled keys in the bundled order. Layer `dir`s are relative to the pack folder:

```json
{
  "instruments": [{
    "id": "yamaha-grand-piano",
    "name": "Yamaha Grand Piano (Logic)",
    "category": "piano",
    "ext": "mp3",
    "layers": [{ "vel": [0, 64], "dir": "v0-64", "notes": ["A0", "C1", "Db1", "…"] }, "…"],
    "release": 0.12,
    "gainTrim": 0,
    "license": "personal-use",
    "source": "Logic Sampler Instruments/01 Acoustic Pianos/Yamaha Grand Piano.exs",
    "attribution": "Apple Logic/GarageBand sound library — personal use only, not redistributable"
  }]
}
```

The app loads each `<slug>/manifest.json` as a secondary manifest, with ids namespaced `user:<id>` by the engine, and
serves the files through `/user-samples/…` (see CONTRACT_CHANGES "## shell-3"). Re-importing an instrument replaces
its folder atomically. To remove one, delete its folder and rescan.

### How zones become layers

- **Only the key-down, pedal-up sound is kept.** Skipped: groups selected by the sustain pedal being *down*
  (group "select by" = CC64 64–127: Yamaha "… sus", Steinway "p… pedal …", Grand Piano "Sustain pedal #2"), release-
  trigger groups, groups named like release / key-off / noise / hammer, muted groups, reversed zones and zones whose
  sample index is invalid. Groups selected by CC64 0–63 (pedal up) and key-range groups such as Steinway's
  "No Dampers" (the top octaves) are kept.
- **Velocity** is what Logic uses: the zone's own range if its velocity-range flag is on, otherwise 0–127, then
  narrowed to its group's range. (Yamaha and Steinway zones have the flag off and their velocity comes from the
  groups; Grand Piano and the Keyboard Collection use zone ranges.)
- **Velocity layers:** one manifest layer per velocity band. The tool takes the union of all split points, gives each
  root in each band one zone, and merges neighbouring bands that play the same audio (same file, same start within
  0.1 s), also when one of them maps a root or two to a neighbour's file. Yamaha's "f" (100–117) and "ff" (118–127)
  both use the `_H` files, so they become one layer 100–127. The first layer is extended to 0 and the last to 127.
- **Notes:** each zone contributes its root key, as a flat name (`Db4`, C4 = MIDI 60). Apple's file names use
  C3 = 60, so `084_C5KM56_H.wav` (MIDI 84) becomes `C6.mp3`. The zone's key range is ignored because the app repitches
  the nearest sample. Coarse tune is folded into the root. Fine tune is not carried over (warning above 10 cents).
- **Duplicates** (round-robins, split-stereo L/R zones, layered groups on the same root and band): the zone whose key
  range contains its root wins, then the first in file order. So a borrowed neighbour (Yamaha's soft layer plays
  `042_ped_s.wav` on key 41) never replaces a note's own sample.
- **Sample start/end:** a zone that plays part of a file is cut to that frame range, and two-segment zones in
  consolidated CAFs are joined (see "Format notes").
- **Levels:** Logic's group volume + zone volume (dB) is baked into each file, relative to the loudest zone kept, so
  nothing is boosted and soft layers stay softer than loud ones (Yamaha: soft −2 dB, medium −1 dB, loud 0 dB).
  `--no-levels` turns this off. The instrument's overall level is still `gainTrim` (0; `tools/calibrate.mjs` sets it).
- **DC offset:** the ffmpeg encode chain runs every file through a 10 Hz high-pass, the same fix `tools/samples/process-musyngkite.mjs` uses (S2), so files pass the importer's own `--validate` DC check (`|dc|/peak ≤ 5e-4`).
- **Headroom:** mp3 and m4a output is lowered by a further 1 dB (`LOSSY_HEADROOM_DB`), uniformly, so layers keep
  their relative levels. Lossy encoders overshoot the source peak: Yamaha's `107_B6KM56_H.wav` peaks at 0.00 dBFS
  and came out of libmp3lame 160k at +0.22 dBFS (clipped). WAV output gets no headroom. With afconvert this means
  every file takes the decode → level in JS → encode path (two afconvert calls instead of one).
- **Length:** by default each file stops at the app's cap + 1 s (17 s up to C4, 11 s above) with a 0.25 s fade, since
  the sampler never plays past its cap.
- **Release τ** comes from the name: 0.6 s for strings, choir, voice and pads; 0.4 s for organ, brass, winds and
  synths; 0.12 s for pianos, EPs, mallets, bells, guitars and plucks. `gainTrim` is 0.
- **Category / group** also come from the name. Strings, Choir and Pads get an explicit `group`.

## Status: verified on real files

The parser was checked byte by byte against six real Apple instruments, kept outside the repo in `~/Music/Worship Rig/exs-fixtures/`:
Yamaha Grand Piano, Grand Piano, Steinway Grand Piano 2, Steinway Piano 2 (Logic "01 Acoustic Pianos"), and Flea
Market Wurli and Lullaby Vibes (Logic "Keyboard Collection"). All six are little-endian (`TBOS`). The consolidated
layout was checked against the audio in `Steinway Piano_consolidated.caf` on Ryan's Mac.
`test/unit/exs/real-files.test.mjs` pins every finding below; `test/unit/exs/convert.test.mjs` checks the sample-exact
cuts on a synthetic CAF whose every frame carries its own index.

### Format notes (with evidence)

Offsets are from the start of each chunk (84-byte header included). All fields are in `tools/exs/layout.mjs`.

- **Header chunk:** u32 counts at 88 / 92 / 96 / 100 = zones / groups / samples / params. They match the chunks that
  follow in all six files (Yamaha: 688 / 8 / 477 / 1).
- **Zone:** root at 85, key range at 90/91 and velocity at 93/94 are right. Every one of Yamaha's 688 zones has a
  root equal to its file's `NNN_` prefix (`084_C5KM56_H.wav` → 84). Sample start/end at 96/100 are frame offsets into
  the file, and sample index at 176 and group index at 172 are right. Options bit 3 (0x08) is the velocity-range flag:
  0x08 on Grand Piano and Keyboard Collection zones, 0x00 on Yamaha and Steinway zones. With the flag off, the groups'
  ranges tile 0–127 exactly (Yamaha 0–64 / 65–99 / 100–117 / 118–127, Steinway 0–39 / 40–59 / 60–89 / 90–127). The
  zones' own stale ranges (0–51 / 52–88 / 89–107 / 108–127) would leave gaps, so they are clearly unused.
- **Group:** min/max velocity at 89/90. "Select group by" at 168–171: type (3 = MIDI controller), controller number,
  low, high. Pedal-up groups are `03 40 00 3F` (CC64 0–63) and pedal-down groups `03 40 40 7F` (CC64 64–127), in all
  three pianos that have them. The group key range is at 172/173 (Steinway "Single Wound" 0–28, "Double Wound" 29–40,
  "Triple Unwound" 41–91, "No Dampers" 92–127, matching their zones exactly). The release-trigger byte (157) and the
  mute bit are 0 everywhere, so they remain unverified.
- **Sample chunk:** length 88, rate 92, bit depth 96 and channels 100 are right (Steinway CAF: 45,988,864 frames,
  which is ffprobe's `duration_ts`). The 4CC at 112 is stored as a u32 in file byte order, so it reads `EVAW` / `ffac`
  in little-endian files: it means `WAVE` / `caff`, and the parser now reverses it. 84 is the byte offset of the audio
  in the file: 512 for the Yamaha WAVs, 4096 for the Steinway CAF (its `data` chunk + 4-byte edit count, confirmed
  by reading the file). 116 is the file size: 1,576,252 = `061_C#3KM56_H.wav` on disk, and 183,959,552 = the Steinway
  CAF. Keyboard Collection files store 0 and the bare audio byte count there. The folder path is at 164 and the file
  name at 420.
- **Consolidated CAFs:** the sample chunk names one file (`Steinway Piano_consolidated.caf`, PCM s16be 44.1 kHz
  stereo, 184 MB). Each zone's 96/100 are offsets inside that file. Newer zones add a **second segment** at 200/204.
  Evidence from `Zone #1`: start 0, end 179064, segment 2 = 180224…802559. The frames from 179064 to 180223 are exact
  zeros. The audio runs 343, 350, 357, 366, 377 up to the end, then continues 389, 402, 414… at 180224, a seamless
  continuation. The loop points (796034…801399) are in the joined timeline: 802559 = loop end + (180224 − 179064).
  Segment 1 is always exactly 4 s (3 s, 2 s … 0.8 s for the higher notes) and segment 2 holds the rest of the decay.
  In the Steinway instruments only the softest layer's zones own their tail. The louder layers' zones ("Zone #14
  copy …") have their own peak-normalised attack segment, and their segment 2 points back at the softest layer's
  tail. For C4, all four attacks end at −42 dBFS and the shared tail starts at −42.2 dBFS, so the splice is
  seamless. Keyboard Collection zones use only the first segment (e.g. Lullaby Vibes: five zones at 8192…364075,
  380928…823351, …). The importer extracts segment 1 + segment 2 in order.
- **Levels:** zone volume (88) and group volume (84) vary. Steinway Piano 2 zones are −5 / −6 dB and its groups
  −6 … −10 dB, and Yamaha groups are +2 / 0 / −1 / −2 dB. Hence the baked levels.
- Other chunk types, all ignored: `0x0B` (Grand Piano has one per sample; Steinway Piano 2 has one), `0x08` ×16 and
  `0x0A` ×1 in Keyboard Collection files.

### Extraction (ffmpeg vs afconvert)

- **ffmpeg** (preferred) cuts with `atrim=start_sample=S:end_sample=E,asetpts=PTS-STARTPTS`. Those sample counts are
  frames of the decoded input at its own rate, applied before resampling to 48 kHz. Two-segment zones use
  `asplit` + two `atrim`s + `concat`. Levels use `volume=…dB` and truncation uses `afade`. Reading to a late offset
  in the 184 MB CAF takes about 0.4 s. Output goes through `<file>.part` and is then renamed. The cut math is
  unit-tested frame-exact on a synthetic CAF.
- **afconvert** (no ffmpeg) is only ever used for whole-file conversions, because it cannot cut by sample and cannot
  write mp3. For zones that play part of a file, the whole source is converted to 16-bit WAV once and held in memory,
  each zone's segments are cut and levelled in JS, and the result is encoded to m4a (AAC 192 kb/s) or kept as WAV.
  It works for consolidated CAFs too, but needs roughly the CAF's size in memory and temp space. If the encoder fails
  on the first file of a run, the run falls back along mp3 → m4a → wav (ffmpeg) or m4a → wav (afconvert).

## Results on Ryan's Mac

First real run, 2026-09-28, in the Mac's Linux workspace (4 cores, ffmpeg 160k mp3, `--jobs 4`), with
`--root "<…>/Logic" --root "<…>/GarageBand/Instrument Library"`. The finished packs are in `user-samples/`.

`--list --pianos` found 30 instruments (163 MB estimated for all). The two grands:

| instrument | zones | samples found | layers | notes | est. |
|---|---|---|---|---|---|
| Yamaha Grand Piano | 688 | 249/249 | 3 | 252 | 35 MB |
| Steinway Grand Piano 2 (consolidated) | 224 | 1/1 | 4 | 120 | 23 MB |
| Steinway Piano 2 (consolidated, same audio) | 280 | 1/1 | 4 | 120 | 23 MB |

Others with real multisamples: Classical Grand (GarageBand, 52 notes × 2 layers, 9.9 MB), Grand Piano (69 × 3,
9.9 MB), Record Collection Grand (69 × 3, 11 MB), Rise Above Piano (70 × 3, 11 MB), Small Amped Acoustic Piano
(60 × 2, 13 MB). Most of the rest are 1–10-zone character patches. Upright Jazz Bass matched `keys` in the filter and
is missing its samples (0/65).

| pack | layers (velocity) | notes per layer | files | size | audio | peak dBFS | wall time |
|---|---|---|---|---|---|---|---|
| `yamaha-grand-piano` "Yamaha Grand Piano (Logic)" | 0–64, 65–99, 100–127 | 80 / 86 / 86 | 252 | 35.8 MB | 1871 s | −12.7 … −0.5 | 9 s |
| `steinway-grand-piano` "Steinway Grand Piano (Logic)" | 0–39, 40–59, 60–89, 90–127 | 30 each (A0–C8, minor thirds) | 120 | 22.9 MB | 1195 s | −12.5 … −1.5 | 7 s |

Both pass `--validate`: the manifest keys match the bundled schema, every file decodes, none is silent or clipped,
and DC is at most 7.8e-5 of peak. The app's server (`createServer({ userSamples })`) lists both under
`/api/user-samples/manifest.json` and serves their mp3s (200, `audio/mpeg`). The unit tests pass (239/239).

Findings from the run:

- **Clipping, fixed.** The first Yamaha pass failed `--validate` on two loud-layer files (`v100-127/Eb7` 0.00 dBFS,
  `B7` +0.22 dBFS). The sources peak at −0.13 and 0.00 dBFS, and the mp3 encoder overshot them. Fix: the 1 dB lossy
  headroom (see "Levels"). `cli.test.mjs` was updated because the afconvert path now makes two calls per source.
- **Yamaha's samples are split across two packages.** 182 of its `KM56` files are in Logic's `EXS Factory
  Samples/01 Acoustic Pianos/Yamaha Grand Piano/`. The other 68 (for example `060_C3KM56_*`, `099_D#6KM56_*`) are
  only in GarageBand's `Instrument Library/Sampler/Sampler Files/Grand Piano/`. The two sets don't overlap, so
  both roots are needed. The index resolves this by itself.
- **"L/R anti-correlated" warnings** (Yamaha 40, Steinway 47, mostly from F5 up) come from Apple's recordings, not
  the converter. Correlations match the source: Yamaha `091_G5KM56_S.wav` is −0.80 at the source and −0.80 in
  `v0-64/G6.mp3`. The Steinway C6 attack cut from the CAF is −0.95 in both. This looks like a spaced mic pair on
  high notes. It only matters if the signal is summed to mono.
- The Linux workspace can't delete files on the mounted Projects folder, and the importer removes its temp and probe
  files. The packs were therefore built in a VM-local folder and copied into `user-samples/` (identical, `diff -rq`).
  On macOS this doesn't apply: `--out user-samples` works directly.

## Audio format

**mp3 at 160 kb/s, 48 kHz** is the default because the bundled library is mp3 and every Chromium/Electron build
decodes it. AAC/m4a (the afconvert default) needs proprietary codecs in Electron. That is expected on macOS but not
verified for this app's build. If an m4a import is silent in the app, re-import with ffmpeg installed (mp3) or with
`--format wav`. MP3 and AAC add some encoder priming at the start, and the app's onset trim (−50 dBFS) removes that
leading silence.

## Caveats and limitations

- **Pedal-down variants are not imported.** The app has no pedal-down sample set (it plays pedal-up samples and holds
  them). Yamaha's `ped_s` / `ped_mf` / `ped_h` files (all 344 zones of the four "sus" groups) and Steinway's
  "p… pedal" groups are skipped. With the pedal down, Logic switches to those recordings, which include sympathetic
  string resonance.
- **No loops.** The app's sampler is one-shot and caps each note at 10 s above C4 and 16 s at or below, with a 1 s
  fade. Logic loops the tails of these pianos, so very long held notes fade out in the app.
- **Borrowed notes are kept as Apple mapped them.** Yamaha's soft layer has 80 roots, not 86, because Apple maps a few
  keys to a neighbour's file. The app repitches the nearest root, as Logic does.
- **Fine tune** (up to ±25 cents on some Yamaha and Grand Piano zones) and **per-zone pan** are not carried over.
- **Velocity crossfades** (if a group sets one; not located in the format yet) are not applied: layers switch hard at
  their boundaries, as the app's sampler does for the bundled pianos.
- **The two Steinway instruments share one CAF and are the same audio.** "Steinway Piano 2" only differs in levels
  (zone volume −5/−6 dB, group −6 … −10 dB) and in a V6 group (121–127) that reuses V5's audio. Import one of them.
- **Keyboard Collection instruments** (Flea Market Wurli, Lullaby Vibes, …) map one zone per octave, or one zone
  for the whole keyboard, in their `.exs`, and carry extra `0x08` / `0x0A` chunks that are ignored. Their sound in
  Logic probably depends on the patch's effects too (not verified), so an import may sound plainer than the Logic
  patch. They are consolidated 24-bit CAFs; they parse and plan, but were not converted in the first real run.
- Instruments that are not sample-based (Alchemy patches, software-synth patches, Drummer kits, Ultrabeat) are not
  EXS instruments and are not found.
- Only little-endian files were available. Big-endian (`SOBT`) parsing uses the same table and is covered by
  synthetic tests only.

## Troubleshooting

| symptom | fix |
|---|---|
| `No instrument folders found` | Open GarageBand once and let it download its Sound Library (GarageBand → Sound Library → Download All Available Sounds), or pass `--root <folder>`. |
| `samples 0/60` or `(missing samples)` in `--list` | The sound pack isn't downloaded, or the samples are elsewhere: `--root "/path/to/folder"` (add the instrument folder too, since `--root` replaces the defaults), or `--reindex`. |
| `could not be parsed` for some files | Send `--dump <file> --hex`. |
| `Neither ffmpeg nor afconvert was found` | `brew install ffmpeg`, or run on a Mac. `--list`, `--dry` and `--dump` work anywhere. |
| Exit code 3 | You used `--batch`; run the same command again until it exits 0. |
| Instrument silent in the app | Check `--validate`. If you imported as m4a, re-import as mp3 (install ffmpeg) or `--format wav`. Check the app's console for 404s; file names must be `<Note>.<ext>` with flats (`Db4`, not `C#4`). |
| Wrong pitch | `--dump` the file and check the root notes. |
| Too big | `--max-mb 60`, or `--max-notes-per-layer 30` (every minor third across 88 keys). |

## Files

- `tools/import-garageband.mjs`: the CLI
- `tools/exs/layout.mjs`: binary layout (offsets, flags, what was verified and how)
- `tools/exs/parser.mjs`: defensive `.exs` parser
- `tools/exs/writer.mjs`: synthetic `.exs` writer (`node tools/exs/writer.mjs desc.json out.exs`)
- `tools/exs/mapping.mjs`: zones → manifest layers, segments, levels, name → category/release, note thinning
- `tools/exs/sample-index.mjs`: sample-file index and resolution
- `tools/exs/convert.mjs`, `tools/exs/wav.mjs`: ffmpeg / afconvert conversion and WAV slicing
- `tools/exs/validate-pack.mjs`: `--validate` (reuses `tools/samples/audio-stats.mjs`)
- `tools/exs/fixtures/*.json`: synthetic instrument descriptions. The real Apple
  instrument definitions live in `~/Music/Worship Rig/exs-fixtures/` (`RIG_EXS_FIXTURES`), not in the repo
- `test/unit/exs/*.test.mjs`: node:test suites (`npm run test:unit`)
