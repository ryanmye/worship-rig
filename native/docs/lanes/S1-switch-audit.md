# Lane S1: song switching audit (read-only, 2026-11-23)

This is a read-only code audit for AWAY_WEEK_PLAN Lane S1. Nothing was run. The audit marks its inferences
"(inf)".

## Switch paths

Every path ends in `controller.selectSong(id,{index})` (controller.js:532).

- Perform Prev/Next (perform.js:405-416). These do not wrap.
- A setlist chip tap: one tap, no confirm (components/setlist.js:37-40).
- An Edit setlist row (edit/panels/setlist.js:418).
- The arrow keys and ⌘/Ctrl+arrows (controller.js:1396-1431).
- Electron global hotkeys, off by default (shared/hotkeys.js:11-12).
- MIDI Learn `nextSong`/`prevSong`, mapped to a note or a CC (params.js:388).
- Program Change to the nth song (controller.js:1327). It is off by default, 0-based, and has no channel filter.

## What the screen shows during a switch

The store moves to the new song before `prepare`. Perform then shows the new song right away:

- the name is greyed;
- "Loading…" and a spinner sit in the KEY row and on the target chip;
- the faders show the new song's levels while the old song is still playing.

The top bar shows "Loading n of N" or "All N ready". It gives no state per song.

## Load state the engine already provides but the UI does not use

- `status.ready`.
- `status.memory`.
- The `loading {slot, progress}` event (re-emitted, nothing listens).
- The `ready {phase:'preload'}` event.
- `engine.cache.has(url)`.
- main.js `songsLoaded()`, which already works out ready per song but reports only a count.
- `estimatePreloadMB().exact`.

## Risks on stage

1. **Double-tap Next skips a song.** `nextSong` reads its neighbours from the store, which has already moved to the
   loading target. The CC retrigger guard covers bounce only.
2. **No confirm, and chips are live under Lock.** A mis-tap, or a swipe that ends as a tap (inf), switches songs.
3. **Hidden songs.** The strip scrollbar is hidden and only about 2-4 following chips are visible, so it is not
   obvious that more songs exist.
4. **No load state on Next or on the chips.** A cold song looks the same as a warm one.
5. **The screen shows a song you aren't hearing yet.** The faders show the new song during the load, and moving one
   edits the new song.
6. **A heavy 16-slot song can exceed PIN_BUDGET.** Then no neighbour is pinned and Next starts cold (inf).
7. **No iPad portrait layout.** `body{min-width:1024px}`.
8. **Program Change problems.** Any keyboard's patch change can switch songs (inf). There is one Learn mapping per
   control.
9. **Held notes and pedal stay on the old instruments.** This is by design (the gapless switch). The new song's reverb
   arrives after 2 s of quiet.

## Layout facts for the mockups (Sanctuary v2 night)

- **Rows:** head 102-112 px, nav 48-54 px, then the stage, then the bottom row at 76-94 px.
- **Nav row columns:** `90-110 | 1fr | 200-250`.
- **Chips:** at least 44 px tall and at most 280 px wide. The current chip is a brass plate (#efc878 → #dfb05a) with
  ink #1c1406.
- **Theme tokens:**

  | Token | Value |
  |---|---|
  | `--bg` | #160913 |
  | `--panel` | #21111c |
  | `--panel-2` | #2a1a25 |
  | `--text` | #f5ecd8 |
  | `--muted` | #cec1aa |
  | `--accent` | #e6ba65 (brass, "where you are") |
  | `--warn` | #f7a23d (lock/hold only) |
  | `--ok` | #9ccf66 |
  | `--danger` | #ef5b4f |

- **Book font:** Alegreya.
