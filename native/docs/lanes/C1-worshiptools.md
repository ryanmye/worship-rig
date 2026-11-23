# Lane C1: what WorshipTools exports (research, 2026-11-23)

Web research by the cloud session (AWAY_WEEK_PLAN Lane C1). Sources are WorshipTools' own docs and help forum.
Nothing here was tested against a real WorshipTools account. Ryan's account is the check.

## Findings

- **No public API.** The help-forum thread "API / OpenSource" (2023) consists of users asking for one, and no staff
  reply is shown. There is no developer page. An import therefore needs **no account, key or terms**, and C1 raises
  no tier-1 question.
  <https://www.worshiptools.com/help/thread/6322455870177280>
- **ChordPro is the song format.** Charts and Planning render and edit ChordPro. Planning imports `.chord`, `.cho`,
  `.crd`, `.chopro`, `.pro` and `.txt`.
  <https://worshiptools.com/en-us/docs/129-import-chordpro>
- **Getting songs out.** WorshipTools has no bulk song export. A user reports exporting one song at a time from
  Planning's ChordPro editor; others are still asking for a library export (thread, Nov 2025).
  <https://www.worshiptools.com/help/thread/6288190654644224>
- **Song list as CSV.** Planning › Songs › "Export list" downloads a CSV of titles, authors and CCLI numbers (staff
  reply, 2024). It carries no charts.
  <https://www.worshiptools.com/help/thread/5692149844672512>
- **SongSelect ChordPro comes only with SongSelect Premium.** With the Advanced plan a church gets PDFs only.
  <https://www.worshiptools.com/en-gb/docs/169-missing-chordpro>

## What this means for Lane C2 (tier 2, logged as O-AW-1)

- Import **ChordPro** (all six extensions above, plus `.chordpro`) and plain chord-over-lyrics text. There is no
  separate "WorshipTools format" to support. Optionally, a WorshipTools CSV song list can create placeholder songs
  (title, author) to be filled in later.
- Fields to read from ChordPro directives:
  - `title`/`t`, `key`, `tempo`, `time`, `artist`, `ccli`;
  - section names: `start_of_verse`/`sov` with a label, `{comment: Chorus}`/`{c:}`, and WorshipTools-style
    `Verse 1:` lines.
- **Unverified:** whether WorshipTools' ChordPro export writes `{tempo:}` and `{key:}`. SongSelect ChordPro usually
  carries `{key}`, and `{tempo}` sometimes. The importer must treat both as optional and ask for a tempo when it is
  missing.
- Charts are the user's licensed content. They stay in the user's library, never in the repo. Test charts are written
  for the tests.
