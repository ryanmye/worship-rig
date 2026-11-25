# Lane C2, part 1: the chart parser (2026-11-24)

Code: `app/js/shared/chart-parse.js` (pure; no DOM, no Web Audio, no fetch). Tests: `test/unit/charts/` (57 builder
cases plus the skeptic's file, run by the existing `unit` suite in `test/run-all.mjs`). Review:
`native/docs/reviews/C2-parser.md`, which changed choices 10 and 11 below. Scope per O-AW-1: ChordPro, plain
chord-over-lyrics, and the Planning song-list CSV. There is no UI yet.

## The model

```
{title, subtitle, artist, key, tempo, timeSig, capo, ccli, copyright,
 sections:[{name, kind, lines:[{lyric, chords:[{at, chord, annotation?}]}], recall?}], warnings:[string]}
```

- `key` is normalised ('Bb', 'F#m'). `tempo` is an integer BPM (20..400). `timeSig` is a string ('6/8') that the
  parser does not restrict to `TIME_SIGS`. `capo` is 1..99. `ccli` is a digit string. Missing means `null`.
- `at` is a UTF-16 index into `lyric` (what `slice` takes), clamped to `0..lyric.length`. Plain-text columns are
  mapped by monospace cell (CJK and emoji are 2 cells, combining marks 0), so `at` never splits a surrogate pair or
  an accent from its letter. A chord-only line has `lyric: ''` and all `at: 0`, in order. `[*text]` annotations carry
  `annotation: true` and are never transposed.
- `kind`: verse, chorus, prechorus, bridge, tag, intro, outro, interlude, instrumental, tab, grid, other.
- Extra line flags: `comment: true` (a `{c:}` that is not a section name); a section with `recall: true` is a bare
  `{chorus}` marker with no lines.
- `warnings` are strings, with `Line n:` where a line is known. The parser never throws.

Exports: `parseChart(text, {name, format})`, `parseChordPro`, `parsePlainChart`, `parseSongListCsv` (returns
`{songs, warnings}`, each song a model with no sections), `detectFormat(name, text)`, `transposeChord`,
`transposeChart`, `transposeKey`, `normalizeKey`, `keyPrefersFlats`, `parseHeading`, `isChord`, `splitChord`.

## Choices (each tier 2)

1. `at` clamps to the lyric length, so a chord printed past the end of a short lyric stays on that line.
2. Tabs expand to 4-column stops before columns are read, in plain and ChordPro lyric lines (not in `tab` blocks).
3. Blank lines are dropped. Structure comes from sections, not spacing.
4. Text before any heading goes in an unnamed section (`name: ''`, `kind: 'other'`).
5. `{c: Chorus}` / `{comment: Verse 2}` outside a block starts a section when the text is a heading word; other
   comments become `comment` lines. Heading lines (`Verse 1:`, `[Bridge]`) are also recognised inside ChordPro.
6. Heading words: verse, chorus, refrain, pre-chorus, bridge, tag, intro, outro, ending, coda, interlude,
   turnaround, vamp, instrumental, solo, hook. A trailing `x2` or a parenthetical is dropped from the name.
7. Duplicate field directives: first wins, with a warning. `{capo: 0}` is `null`. `{author}`/`{composer}` fill
   `artist` only when `{artist}` is absent.
8. Unknown directives warn; known layout directives (`define`, `new_page`, font and size ones, `columns`, ...) are
   ignored silently. `{meta: key value}` routes to the field.
9. Plain text: a header of `Key: G`-style lines is read before the first content. A lone first line followed by a
   blank line or a heading is guessed to be the title, with a warning.
10. Chord recognition is conservative: root A-G with `#`/`b`, a known suffix charset, optional slash bass. Lowercase,
    `Dad`, `Bed` and Nashville numbers are not chords. A plain line is a chord line only if every token is a chord or
    a bar/repeat mark (`|G`, `D:|`, `x2`, `2x`, `(C)` included). `Intro: G C D` is a heading plus a chord line.
11. Transposing: the key is respelled with the usual key names (Db, Eb, F#, Ab, Bb). With a key, chords are spelled
    for the new key (`transposeChord` `fromKey`/`toKey`): a note spelled the old key's way takes the new key's
    spelling (harmonic chromatic: b2 b3 #4 b6 b7 in major), and a note spelled on purpose otherwise keeps its
    interval (E/G# in C → A/C# in F). A slash bass is spelled as a tone of its chord (D/F#, never D/Gb). E#, B#,
    Cb, Fb and double accidentals are never written. With no key, flats vs sharps follow the chart's own accidentals,
    then the first chord. A multiple of 12 is an exact copy. `transposeChord` alone, with no options, keeps flats if
    the input has one, else uses sharps.
    `tab`/`grid` sections and comments are never transposed. `capo` is not changed.
12. CSV: columns are found by header name (title/song, author/artist/writers, CCLI variants), delimiter is
    guessed (comma, semicolon, tab), BOM and CRLF are handled, and rows without a title are skipped with a warning.

## What the importer UI needs next

- A picker for `.cho .chopro .chordpro .chord .crd .pro .txt .csv`, reading text, then `parseChart(text, {name})`, or
  `parseSongListCsv` when `detectFormat` says `csv`. Show `warnings` in a review step.
- A missing tempo is asked for (O-AW-1). `key` also is optional. `timeSig` must be checked against `TIME_SIGS`.
- Mapping to a song: title, key, tempo, timeSig, and the chart stored with the song. The store field and the
  schema change are not decided. Charts are the user's content and stay in the library, never in the repo.
- A renderer for Perform that lays `chords` over `lyric` by `at` (monospace or measured spans), and a transpose that
  follows Easy Transpose by calling `transposeChart(model, semitones)` per render.
- Probably a `chartToChordPro(model)` serializer for export and storage, not written yet.
- Playwright coverage of the import flow, still to do.
