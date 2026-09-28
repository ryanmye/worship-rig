# Sample licenses

Worship Rig bundles three third-party sample libraries under `app/samples/`. All three are
redistributable under the licenses below; each section names the license, gives its URL (the
Creative Commons license texts are incorporated by that reference, as the licenses allow), the
required attribution, and what was changed. Per-instrument `license`, `source` and `attribution`
fields in `app/samples/manifest.json` repeat this.

| Library | License | Instruments (manifest ids) |
|---|---|---|
| Salamander Grand Piano V3 | CC BY 3.0 | `salamander-piano` |
| VS Chamber Orchestra 2: Community Edition | CC0 1.0 | `upright-piano` |
| Musyng Kite soundfont (via gleitz/midi-js-soundfonts) | CC BY-SA 3.0 | the other 21 (listed below) |

---

## Salamander Grand Piano (CC-BY 3.0)

- **Title:** Salamander Grand Piano V3
- **Author:** Alexander Holm
- **License:** Creative Commons Attribution 3.0 Unported (CC-BY 3.0)
- **License URL:** https://creativecommons.org/licenses/by/3.0/
- **Source URL:** https://github.com/sfzinstruments/SalamanderGrandPiano

Used in: `app/samples/salamander-piano/` (manifest id `salamander-piano`, "Grand Piano (Salamander)").

**Attribution:**

> Salamander Grand Piano V3 by Alexander Holm, licensed under a Creative Commons Attribution
> 3.0 Unported License (https://creativecommons.org/licenses/by/3.0/).
> Source: https://github.com/sfzinstruments/SalamanderGrandPiano

**Modifications from the original:** the original samples are 24-bit FLAC files (30 notes,
16 velocity layers). This project uses 3 of those velocity layers (v4, v9, v14), transcoded
to MP3 (libmp3lame, 160 kbps, 48 kHz), with trailing silence below −60 dBFS trimmed (only after
the first 8 seconds — onsets are never touched), a 0.5 s fade-out applied at the trimmed tail,
and total length capped at 20 seconds per file. Sharp-based source filenames (e.g. `D#1v9.flac`)
were renamed to flat equivalents (e.g. `Eb1.mp3`) for consistency with the app's other sample set.
No pitch, tuning, or timbral changes were made.

---

## VS Chamber Orchestra 2: Community Edition — Upright Piano (CC0 1.0)

- **Title:** VS Chamber Orchestra 2: Community Edition (VSCO 2 CE), instrument "Upright Piano"
- **Authors:** Versilian Studios LLC / Sam Gossner; Simon Dalzell (Ivy Audio). Sample cutting: Elan Hickler / Soundemote.
- **License:** CC0 1.0 Universal (public domain dedication) — https://creativecommons.org/publicdomain/zero/1.0/
- **License file fetched from:** https://raw.githubusercontent.com/sgossner/VSCO-2-CE/master/LICENSE (begins "CC0 1.0 Universal"; the download script refuses to run if that changes)
- **Source URL:** https://github.com/sgossner/VSCO-2-CE (region map `SFZ` branch `UprightPiano.sfz`; audio `master` branch `Keys/Upright Piano/Player_dyn{1,2,3}_rr1_*.wav`)
- **Homepage:** http://vis.versilstudios.net/vsco-community.html

Used in: `app/samples/upright-piano/` (manifest id `upright-piano`, "Upright Piano (VSCO)").

CC0 requires no attribution. The library README asks users to credit Versilian Studios / Sam
Gossner and Ivy Audio / Simon Dalzell, link the VSCO CE homepage, and not sell the samples
directly (a request, not a license condition); we honour it:

> Upright Piano from VS Chamber Orchestra 2: Community Edition by Versilian Studios (Sam Gossner)
> and Simon Dalzell (Ivy Audio), CC0 1.0. http://vis.versilstudios.net/vsco-community.html

**Modifications from the original:** 3 dynamic layers × 23 notes (every major third A0..C8,
round-robin 1 only) from 24-bit/44.1 kHz WAV; 10 Hz DC high-pass; per-file gain so every note sits
on a smooth key-level curve per layer (the originals jump up to ±6 dB note to note, and the SFZ's
flat per-layer volumes made the soft layer louder than the loud one in the bass) with the layers
4.5 dB apart; trailing audio below −60 dBFS trimmed after the first 8 s, 0.5 s fade-out, 20 s cap;
MP3 (libmp3lame, 160 kbps, 48 kHz); files renamed to flat note names (`Db4.mp3`) in layer folders
`dyn1` (vel 0–60), `dyn2` (61–110), `dyn3` (111–127). No pitch or timbral changes. Per-file source
URLs and gains: `tools/samples/vsco-upright-sources.json`.

---

## Musyng Kite soundfont samples (CC BY-SA 3.0)

- **Soundfont:** Musyng Kite (`Musyng Kite.sfpack`, http://www.synthfont.com/SoundFonts/Musyng.sfpack)
- **Rendered to MP3 by:** gleitz/midi-js-soundfonts — https://github.com/gleitz/midi-js-soundfonts (folder `MusyngKite/`)
- **License:** Creative Commons Attribution-ShareAlike 3.0 (CC BY-SA 3.0) — https://creativecommons.org/licenses/by-sa/3.0/
- **License statement:** the repository README (https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/master/README.md,
  checked 2026-09-28): "Musyng Kite Soundfont … Released under Creative Commons Attribution Share-Alike 3.0 license".

> **Correction (samples-2):** earlier versions of this file listed these samples as MIT. The
> repository's `LICENSE.txt` (MIT, reproduced below) covers the repository itself; the README
> licenses the rendered Musyng Kite samples under CC BY-SA 3.0, which is what applies to the audio.

Used in (manifest id → folder `app/samples/<id>/`):
`bright-piano` "Bright Piano", `honky-tonk` "Honky-Tonk Piano", `harpsichord` "Harpsichord",
`ep-rhodes` "Rhodes (MusyngKite)", `ep-wurli` "Wurlitzer (MusyngKite)", `electric-grand` "Electric Grand",
`clavinet` "Clavinet", `vibes` "Vibraphone", `celesta` "Celesta", `music-box` "Music Box",
`marimba` "Marimba", `xylophone` "Xylophone", `glockenspiel` "Glockenspiel", `tubular-bells` "Tubular Bells",
`steel-drums` "Steel Drums", `nylon-guitar` "Nylon Guitar", `steel-guitar` "Steel-String Guitar",
`clean-guitar` "Clean Electric Guitar", `harp` "Harp", `dulcimer` "Dulcimer", `kalimba` "Kalimba".

**Attribution:**

> Musyng Kite soundfont samples, rendered to MP3 by gleitz/midi-js-soundfonts
> (https://github.com/gleitz/midi-js-soundfonts), licensed under CC BY-SA 3.0
> (https://creativecommons.org/licenses/by-sa/3.0/). Modified by the Worship Rig project as described below.

**ShareAlike:** the modified sample files in the folders above are adaptations and are distributed
under CC BY-SA 3.0 as well. This applies to those audio files only; it does not relicense the
rest of Worship Rig.

**Modifications from the original:** per instrument, all 88 notes A0..C8 (`<folder>-mp3/<Note>.mp3`,
flat names) were downloaded, then: notes whose peak is below −80 dBFS were dropped (ep-rhodes: A0, Bb0,
B0, Ab7, A7, Bb7, B7, C8 — silent placeholder files; neighbouring notes are repitched instead);
10 Hz high-pass (DC offset removal); 0.4 s fade-out at the end of each file (the originals are cut
off at ~3.1 s, often still sounding); one gain per instrument so its loudest note peaks at −1 dBFS
(note-to-note balance kept), except `kalimba`, `marimba`, `harp` and `steel-guitar`, where each note
was additionally set onto a smooth key-level curve to remove soundfont zone steps of 9–13 dB;
re-encoded as MP3 (libmp3lame VBR quality 2, 44.1 kHz). Per-instrument gains and dropped notes:
`tools/samples/musyngkite-processing.json`. No pitch or timbral changes.

**midi-js-soundfonts repository license (MIT), reproduced for completeness:**

```
Copyright (C) 2012 Benjamin Gleitzman (gleitz@mit.edu)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## User-imported pad files

Worship Rig lets a user point the app at a local folder of their own audio files ("pad
folder") for use as drone/pad material. These user-supplied files are read locally at
runtime (via a local file URL/handle) and are **never bundled, copied, uploaded, or otherwise
redistributed by the app** — they stay wherever the user put them on their own machine.

---

## Bundled sample size

Total size of `app/samples/` (all instrument audio + manifest): **79.2 MB** (1,999 files, 23 instruments;
budget ≤ 120 MB). Salamander 22.1 MB; VSCO upright 15.4 MB; 21 Musyng Kite instruments 41.7 MB combined
(1.3–2.7 MB each). Per-instrument table: `node tools/samples/validate.mjs --quick`.
