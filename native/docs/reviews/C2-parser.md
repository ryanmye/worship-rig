# C2 part 1, chart parser: skeptic review (2026-11-24)

Verdict: **PARTIAL**. As delivered, the parser failed two hard checks. First, one 4 KB line could hang it for more
than 10 s (catastrophic regex backtracking, F1). Second, transposition misspelled common borrowed chords (D# for Eb
in G, F2). I fixed both, plus 12 smaller defects (F3-F14), and added 49 tests. All 106 chart tests now pass. The
verdict stays PARTIAL for two reasons: real WorshipTools/SongSelect exports have never been run through the parser
(O7), and a few inherent ambiguities are documented rather than solved (O1-O3).

Under review (all uncommitted in `wt-c`, branch `lane-c`): `app/js/shared/chart-parse.js`,
`test/unit/charts/chart-parse.test.mjs` and `native/docs/lanes/C2-parser.md`. I ran node unit tests only, with no
browser suites. Every chart in the tests was written for them; none is copied from a song.

## What I tested

| area | what | count |
|---|---|---|
| purity/style | grep for DOM, Web Audio, fetch, `process`, `Buffer`, `require`; JSDoc before each export; lines ≤120; eslint `no-unused-vars` | 14 exports, 0 hits |
| never throws | seeded fuzz: 400 random charts (an alphabet of braces, brackets, bars, CR/LF, NUL, lone surrogates, emoji, RTL, combining marks, BOM, ZWJ) through `parseChart` ×4 formats, `parseChordPro`, `parsePlainChart`, `parseSongListCsv`, `detectFormat`, `parseHeading`, `transposeChart` ×3 | ~4,800 calls |
| | 100 strings of random UTF-16 code units; one 1 MB random file through every entry point | 304 calls |
| | model invariants on every result: `at` is an integer in `0..lyric.length` and never between surrogate halves (for well-formed input); the result serialises to JSON | every call |
| | `transposeChart` given malformed models: null sections, lines and chords, non-string chords, circular, primitives | 10 |
| ReDoS | 15 pathological 100 KB inputs (runs of spaces, `[`, `{`, `]`, `"`, `|`, tabs, chord tokens, suffix runs, directive lines) × 6 entry points, each one timed | 90 |
| ChordPro | directive names, short forms and case; `{meta}`; the comment family; `sov`/`label=` labels; nested and unclosed environments; stray `{`/`[`; multi-byte positions; end-of-line chords; CR, CRLF, BOM | 12 tests |
| plain text | headings (12 positive, 5 negative), chord-like lyric words, all-caps text, bars, `x2`/`2x`, `(C)`, heading plus chords, CJK/emoji/NFD/RTL columns, the header | 9 tests |
| transposition | theory table built in the test from key signatures: 12 major keys × 18 chords and 12 minor keys × 11 chords, every key to every key, n = ±1..±11 | 7,656 chords |
| | `transposeChord`: 12 roots × 9 qualities (`'' m 7 maj7 sus4 add9 m7b5 dim aug`) × with/without a `/3rd` bass × both spellings × n −11..11 × `preferFlats` true/false, with round trips | 19,872 asserts |
| | whole-chart round trips: 24 keys × ±1..±11 | 528 |
| CSV | RFC 4180: doubled quotes, commas and CRLF/LF inside quotes; 4 header variants; ragged rows; thousands separators | 3 tests |
| mutation | 30 mutants on the delivered code against the delivered suite; 50 on the fixed code against both suites | see F15 |

Times on this shared 2-CPU box. Before the fixes: `'Verse' + 4000 spaces + '!'` took more than 10 s (killed) in both
parsers, `'{t' + 4000 spaces + 'x'` took more than 10 s in `parseChordPro`, and 20 KB of `'a' + spaces + 'b'` took
845 ms (quadratic). After the fixes, every 100 KB case takes 1-60 ms when the box is idle (up to ~300 ms at load
average 3-4) and grows linearly from 100 to 400 KB. The tests' ceiling is 600 ms per call, so they don't flake on a
slow CI box but still catch anything quadratic.

## Findings and fixes

- **F1 (critical) ReDoS.**
  - `HEADING_RE` had four adjacent `\s*` runs. It ran on every line and was worse than cubic.
  - The directive regex `\s*(?:[:\s]\s*(.*?))?\s*\}$` was cubic.
  - Quadratic: `/\s+$/` (three places), `PLAIN_META_RE` `(.+?)\s*$`, and the two `detectFormat` `/m` regexes. The
    latter crossed newlines, so they were quadratic in the size of the whole file.
  - Fixes:
    - `parseHeading` now caps the length at 64, strips decoration with loops and does one plain anchored match.
    - Directives are read by `readDirectiveLine` (an `indexOf` scan).
    - `trimEnd()` replaces `/\s+$/`.
    - The meta regex has no trailing quantifier.
    - `detectFormat` scans line by line with a bounded `\[([^\]\n]{1,24})\]`.
    - The plain parser memoises each line's classification, where before it classified a line up to 5 times.
- **F2 (major) Transposition spelling.** Flats/sharps were picked per target key only. A borrowed bVI moved to G
  came out `D#`, bIII in D came out `A#`, and E/G# in C moved to F came out `A/Db`. The fix (`transposeChord`
  `fromKey`/`toKey`, used by `transposeChart` whenever the chart has a key):
  - A note spelled the old key's way takes the new key's spelling. I chose the harmonic chromatic scale (b2 b3 #4 b6
    b7 in major; b2 #3 #4 #6 #7 in minor) because it covers the borrowed chords common in worship sets.
  - A note spelled on purpose otherwise keeps its interval, and its letter moves with the key.
  - A slash bass is spelled as a tone of its chord, in every mode.
  - E#, B#, Cb, Fb and double accidentals are never written (Fdim, not E#dim, in F#), so the chart stays readable
    on stage.
  - Two builder assertions encoded the old spelling, and I changed them: `C/E +2 flats` gives `D/F#` (was `D/Gb`), and
    `Bbmaj7/D +1` gives `Bmaj7/D#` (was `Bmaj7/Eb`). In both, the bass is the chord's 3rd.
- **F3 Headings.** `Chorus 2x`, `CHORUS 3X`, `Tag x 2`, `Verse 2 (2x)` and `Bridge (build) x2` were read as lyrics.
  Fixed: repeat marks in either order, and a trailing parenthetical.
- **F4 Chord lines.** `|G   |C   |D  :|`, `G C D 2x` and `G (C) D` were read as lyrics, and the next line lost its
  chords. Fixed in `chordToken`: bars are peeled off with the column adjusted, `Nx` counts as a repeat mark, and an
  optional chord keeps its column.
- **F5** `Intro: G  C  D` became the guessed **title**. It is now a heading followed by a chord-only line, and the
  title guess skips such lines.
- **F6 Multi-byte columns (plain text).** `at` was the chord line's column used as a UTF-16 index. It split emoji
  surrogate pairs and separated `e` from a combining accent, and CJK text was misaligned. Fixed with `colToIndex`:
  monospace cells (CJK and emoji are 2 cells, marks and ZWJ are 0), and the index always falls on a character
  boundary. Tabs expand by cells too. ChordPro positions were already right.
- **F7** `{title: A}{key: G}` gave the title `A}{key: G`. Each directive on the line is now read.
- **F8** `[*Am]` annotations were transposed to `Bm`. They now carry `annotation: true` and are skipped.
- **F9** `transposeChart` threw on `{sections:[null]}`, `lines: null`, null chords and circular input. It now
  guards each of these and never throws.
- **F10** `keyPrefersFlats` returned false for `Cb`, `Abm` and `Dbm`. Fixed: any flat-named tonic is a flat key.
- **F11 Spec gaps.**
  - `{x_…}` warned; the spec says custom `x_` directives are ignored silently.
  - `{highlight}` was not treated as a comment.
  - `{title-guitar: …}` (a selector) leaked into the lyrics as text. It is now ignored with a warning.
  - `{start_of_abc}`, `ly`, `svg` and `textblock` read `[CEG]` as a chord. These blocks are now raw.
  - `{arranger}` and a few layout directives warned. They are now ignored.
- **F12** `detectFormat` returned ChordPro for a plain chart with `[Chorus]:`. A bracket now counts only when it holds
  a chord.
- **F13** `{capo: 3rd fret}` was unreadable (`\b` between digit and letter); it now reads as 3.
- **F14 CSV.**
  - A CCLI number written `"1,234,567"` was rejected.
  - A `Composer` column was not found.
  - A quoted line break stayed inside a title.

  Fixed (whitespace is collapsed to one line for title and author). The quoting itself was already RFC 4180-correct.
- **F15 The tests were weak.** The delivered suite let 9 of 30 mutants survive: CRLF removed, lone CR removed, BOM
  kept, `at` not clamped, G#m→Abm, `|` dropped, `xN` dropped, grid not raw, tabs transposed. On the fixed code, both
  suites together:
  - 50 mutants were applied and 46 were killed on the first run.
  - Of the 4 survivors, 1 was killed by a new test (flat preference with no options), and 1 was dead code that I
    removed (`flats` in key mode).
  - The other 2 are equivalent: a bare `|` is now handled by the bar strip, and the heading length cap is redundant
    because the code is linear anyway.

Already sound, with no change needed: purity, JSDoc on all exports, and line length; key, tempo and time parsing;
both label forms; end-of-line clamping; RTL kept in logical order; NUL kept as text; RFC 4180 quote handling; and the
key table choice. Key spelling follows music.js: Db (5♭) over C# (7♯), B (5♯) over Cb (7♭), G#m (5♯) over
Abm (7♭), Bbm (5♭) over A#m (7♯), and C#m over Dbm. Two pairs tie at 6 accidentals each: F# is chosen over Gb,
and Ebm over D#m. In both ties the choice matches music.js `KEY_NAMES_*`, so the Easy Transpose label and the chart
agree.

## Open items

- **O1 Ambiguous roots.** In a key whose own spelling of a chromatic note needs the fallback, a natural root is
  read as the flat-side degree. In Db, `A` could be #5 or bVI (spelled Bbb), and `D` could be #1 or b2 (spelled Ebb).
  So `Ddim7` in Db transposed to D gives `Ebdim7` (theory: `D#dim7`). This affects 70 of the 4,752 major-key theory
  cases. Slash basses are not affected.
- **O2** A lyric line made only of chord-like words (`A`, `Am`) reads as a chord line. The format itself doesn't say
  which it is, and a test pins the behaviour.
- **O3** Shorthand headings (`V1`, `PC`, and `C`/`B`, which are also chords) and `Repeat Chorus` are not recognised.
- **O4** Cell widths approximate East Asian Width without the full table. A ZWJ emoji sequence counts 2 cells for
  each pictograph.
- **O5** A second `{key}` (a modulation) keeps the first key and warns "Duplicate". The importer may want key
  changes.
- **O6** Conditional (selector) directives are ignored entirely. A chart with `-keyboard` selectors might want those
  honoured.
- **O7** No real WorshipTools or SongSelect ChordPro, and no real Export-list CSV, has been run through the parser.
  The header names and directive usage come from the C1 research only. This needs Ryan's account.
- **O8** There is no Playwright coverage of the import flow yet (this was already in the builder's list).
- **O9** `(C)` (an optional chord) loses its parentheses in the model.

## Files

- `app/js/shared/chart-parse.js`: fixes F1-F14.
- `test/unit/charts/chart-parse-review.test.mjs`: new, 49 tests.
- `test/unit/charts/chart-parse.test.mjs`: two spelling assertions corrected (F2).
- `native/docs/lanes/C2-parser.md`: the model notes and choices 10 and 11 updated to match.

`node --test 'test/unit/charts/*.test.mjs'`: 106 tests, 106 pass, 0 fail (~2.5 s).
