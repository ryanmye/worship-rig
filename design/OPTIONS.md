# Worship Rig UI redesign: morning options

Nothing under `app/` has been changed. Everything here is a mockup plus a plan. Open `options.html` in this folder for
the same content with the screenshots side by side.

## What's wrong today (3 sentences)

Perform is in decent shape (reviews/ux.md calls its top-down order "clear"), but it has **no quick switches**. To change
a sound's reverb, echo, octave, sustain, tempo or pedal direction mid-service you have to leave for Edit or Settings,
and Perform-lock freezes every song-level write except drone level (`perform.js:445`), so Transpose and the pickers go
dead and nobody would actually lock it.
**Edit is a wall of look-alike sliders**: about 20 visible at once (level, pan, reverb, echo, chorus, width, lows,
highs per sound, then REVERB/ECHO columns on the right), three unexplained "Custom" dropdowns (Vibe/Space/Echo),
ALL-CAPS jargon (PRE-DELAY, REPEATS, LOWS), and at 1024×700 only one sound card fits before scrolling (ux.md M9). That
is your *"too noisy, everything is just buttons/dials"*.
Edit also looks nothing like Perform, "Reverb" means two things (the room vs. how much each sound sends into it), and
nothing shows what is sounding. That is your *"I feel disconnected from what I'm changing"*.

(The old "every Edit slot card is yellow" complaint, ux.md M4, is fixed in tonight's build: the current screenshot shows
Keys orange and Pad green.)

## How we got here

Every design was scored by the same three critics, each 0–10:
- **Live:** a working worship keys player / MD on a Sunday (song switching, swell, key change, kill the drone, the
  10-second fix during the sermon, glanceability, danger near live controls).
- **Volunteer:** a UX researcher thinking of a non-technical volunteer (cause → effect, plain words, calm Edit).
- **Feasibility:** the lead engineer (existing components and data model, no functional change).

| Round | Design | Live | Volunteer | Feasibility | **Total** | Would ship |
|---|---|---|---|---|---|---|
| 1 | A "Instrument-first" | 7 | 7 | 7 | **7.00** | 2 of 3 |
| 1 | B "Sunday Keys-style panel" | 6.5 | 7 | 7 | **6.83** | 1 of 3 |
| 1 | D "Progressive mixer" | 6 | 6 | 6.5 | **6.17** | 0 of 3 |
| 1 | C "Hardware panel" | 5 | 5 | 6 | **5.33** | 0 of 3 |
| 2 | H (hybrid of A + B) | 7.5 | 7 | 7 | **7.17** | 3 of 3 |
| 2 | A-v2 | 7 | 7 | 7 | **7.00** | 3 of 3 |
| 2 | B-v2 | 7 | 7 | 7 | **7.00** | 3 of 3 |
| 3 | **H-v2** (H + calm tabbed Edit + readable state colours) | 7.5 | 8 | 7.5 | **7.67** | 3 of 3 |
| 3 | **H-sheet** (H's Perform + Edit as a song sheet) | 7 | 7.5 | 7 | **7.17** | 2 of 3 (Live: no) |

Totals are the mean of the three lenses. The per-lens numbers for rounds 1–2 and for H-sheet come from the critics'
own results in the workflow journals; the totals match the authoritative list.

**The three options below**, in order of recommendation: **H-v2**, **H-sheet**, **B-v2**.
- H (7.17) is not listed separately: H-v2 is H with its critics' fixes applied, and scored higher on every lens.
- **A-v2 (7.00) ties B-v2 but is dropped.** It keeps round knobs in Edit, the exact thing you complained about, and
  today's strict lock, so its new chips go dead when you lock for the service. Its good parts (rig map + one panel,
  Sing it in…, the Quick sheet) already live in H-v2.
- B-v2 stays in as the one genuinely different Perform (a full-width switch bar), and because its song-sheet Edit was
  the calmest screen in round 2.

**All three keep the data model: no new store field, no PARAMS row, no engine code.** The only behaviour change is
the lock rule, and it needs your OK (decision 2).

---

## Option 1: H-v2, the hybrid with a calm tabbed Edit (recommended)

`H-v2/perform.png`, `H-v2/edit.png`, `H-v2/quick.png` · also perform-off, perform-2chips, perform-locked, perform-step,
perform-key, edit-wiring, edit-effects, and the 1024 versions.

**The idea:** Perform stays where your hands already know it, and each sound gets Sunday Keys–style switches. The
colours now say one thing each: **ON is a solid tile in the sound's colour, OFF is a grey struck-through tile**, a chip
in use is a quiet tint, and a small white dot marks "changed since the song was loaded". Edit shows **one sound at a
time**, picked from **one row of 7 tabs** in Perform's colours, and the left column of the panel is a copy of that
sound's Perform strip.

**On Sunday (Perform):**
- The top of each strip is a big **ON tile**, which is the mute. The small MUTE button at the bottom goes away.
  Off = grey, name struck through, the rest of the strip at 36 % opacity. In the greyscale 50 % check the ON tiles
  measure mean luma ~155 vs OFF 53 *[measured on the mockup, not the app]*.
- Four chips sit under each fader: **Space · Echo · Octave · Sustain**.
  - Space, Echo and Octave: tap → five big steps (100/75/50/25/Off, or +2…−2) inside that strip → tap one, done. The
    step panel marks the "as loaded" value.
  - Octave says "starts on your next note" (the engine applies it on the next note, audio.js:779; no engine change).
  - Sustain toggles directly. Sustain off is grey, not amber: **amber now means only "lock"**.
- The header gets one-tap **Space** chips (Dry/Room/Stage/Hall/Cathedral, with size hints) and **Echo** chips
  (Off *no echo* · Slapback *1 repeat* · Quarter *on the beat* · Dotted 8th *worship echo* · Trails · **Song's own**).
  Song's own brings the song's custom echo back if you fat-finger Off. ms only appear in Edit.
- **Revert shows a count** ("↺ Revert · ● 2 changed"). Faders are not counted: they're playing, so the count would
  never be 0.
- **KEY ▾ → "Sing it in…"**: the leader says "let's do it in G", you tap G, the band hears G and your hands stay in D.
- The empty EXTRA slot collapses to a thin grey column, and PANIC is the brightest thing on screen.

**Quick settings (the "Sunday Keys toggles" answer):** a **Quick** button drops a sheet over the song header and
setlist rows only. Strips, drone, keyboard and PANIC stay visible and live, and you keep playing while it's open.

| Section | Contents | Under lock |
|---|---|---|
| This song (Revert undoes) | Tempo + big TAP, Swell time stepper | live |
| This Mac (soundcheck) | Touch (Light/Normal/Heavy/Fixed), live PEDAL DOWN light, pedal Reversed | frozen |
| If something's wrong | Sound OK readout, hold-to-restart audio | live |

Mono output and "Keyboard picks songs" deliberately **stay in Settings**: flipping them mid-set changes the PA feed or
makes the Nord jump songs.

**In Edit:**
- Song list on the left; one row of **tabs**: Keys · Pad · Extra · Bass · Drone | Effects · Master. Each tab shows
  Perform's colour bar, the sound name, and a changed dot. The selected tab opens into its panel like a folder tab.
- The panel title is a **sentence that rewrites itself**: "KEYS plays **Grand Piano** on **every key**, an octave up, a
  little into the **Hall**, sustain **on**". Click an underlined word to jump to its control.
- Three columns: **On stage** (the same ON tile, fader and chips as Perform) · **The sound itself** (three wide word
  sliders: Brightness / Warmth / Ring-out, or Fade-in for pads) · **Where it plays** (range, Response). Everything else
  is under **› Advanced**. **There are no round knobs anywhere.**
- The wiring (sends into Space/Echo/Chorus) is behind a **Show wiring** switch, off by default, and shows real numbers
  (25 %, 10 %), not dot sizes.
- The **Effects tab** borrows B-v2's calm lines: "The room is a **Hall**", "The echo is **the song's own**", each with
  its preset chips, a Fine-tune fold, and "How much of each sound goes in" as the same Keys/Pad/Bass chips as Perform.

**Scores:** Live **7.5** · Volunteer **8** · Feasibility **7.5** → **7.67**, 3 of 3 would ship. Highest of any round.

**Effort: L overall, in two independent halves.**
- **Perform + Quick + lock + changed dots: M.** Shippable on its own. The colour fix is CSS only.
- **Edit (tabs + panels + Show wiring + Effects tab): L**, lighter than H's (no SVG map; three FX panels become one
  tab). edit.js is 1,748 lines and still gets restructured.

**Risks the round-3 critics raised (still open, none mocked yet):**
1. **The drone tile is the weakest glance on the screen**, and "kill the drone" is a top-3 Sunday move. Its cream ON
   fill is the same fill as the selected key "D", "Major" and "Synth" in the same card, and no drone-OFF state is
   mocked. Fix: drone uses the same `onTile`; grid/Major/Synth selections become outline-only.
2. **The card title changed from "Key & drone" (today, perform.js:275) to "DRONE D major".** The 12-key grid under it
   calls `setSongKey()`, which re-keys everything the band hears. With the new title a player will read the grid as
   "drone pitch only". Fix: keep "Key & drone" (or "Song key – everything moves") as the card title.
3. **Revert looks like a harmless "fix it" button.** It is one tap when unlocked, next to Fade out, and the count
   includes mutes, so reverting to fix an octave also un-parks a pad you muted on purpose and snaps every fader. Fix:
   take `muted` out of the count (mutes are playing moves, like faders) and put Revert behind the 600 ms hold always.
4. **The white dot means too many things** (changed, the LED ring, the pedal LED, the toggle knob, a bullet in the
   sentence), and **counts disagree across screens** (Perform "2 changed", Edit footer "1 change", Effects tab no dot).
5. **"Since the song was loaded" is really "since the Revert snapshot"**, and perform.js re-takes that snapshot when
   you leave Edit (verified, perform.js:540). So Edit's dots and footer over-promise. Engineer's fix: **changed dots in
   Perform only for the first build**; drop Edit dots and the main.js baseline getter until the snapshot rule is
   decided.
6. **Edit has no undo.** Revert lives only in Perform.
7. **The drone ON tile can't remember its source.** `drone.mode` is `'off' | 'synth' | 'files'`, so turning the tile off
   saves `'off'`, and after a reload a My Pads song comes back as Synth. Fix without a new field: on ON, use the
   snapshot's mode if not off, else Synth; document the reload case.
8. **The lock change is three changes, not two:** chips + header FX go live; key and Revert move to hold; *and* the
   drone tile writes `drone.mode`, which `setSong()` blocks today (perform.js:445) and `droneMode.setDisabled(locked)`
   freezes (perform.js:601). Both verified.
9. **Fader throw** drops from ≈315 px today *(from an earlier measurement, not re-measured)* to **250 px** at 1440 with
   4 chips (**143 px** at 1024). With 2 chips: 302 / 189 px (measured by build.mjs on the mockup).
10. **Esc.** H's plan makes Esc = panic + close any overlay. The round-2 A-v2 live critic flagged that every Mac user
   presses Esc to dismiss a popover, which would cut a held pad under a prayer. The round-3 live critic asks to keep
   today's rule: Esc closes an open overlay without panicking, Esc with nothing open panics, ⌘. always panics.

## Option 2: H-sheet, H's Perform with Edit as a song sheet

`H-sheet/edit.png`, `H-sheet/edit-word.png`, `H-sheet/perform.png`, `H-sheet/quick.png` · also edit-advanced, edit-fx,
perform-step, and the 1024 versions.

**The idea:** Perform, Quick and the lock rule are H's. Edit becomes a **song sheet**: one plain-English line per sound
("KEYS plays Grand Piano on every key, a little into the Hall, a touch of echo, sustain on"). **The underlined words are
the controls**, and a word that matches a Perform chip opens **the same 100/75/50/25/Off steps as that chip**, labelled
"Same steps as the Space 25% chip on your Perform strip". Opening a line shows 3 word sliders and the range; Advanced
is inside the line. Nothing is more than two levels deep.

**Note on the mockups:** H-sheet was built before H-v2 existed, so `H-sheet/perform.png` shows **H's** Perform with the
old colours (amber OFF, "lit = non-default"). If you pick H-sheet, Perform would be H-v2's; only Edit differs.

**On Sunday (Perform):** the same as Option 1 (ON tiles, 4 chips, header Space/Echo chips, Song's own, Sing it in…,
PANIC as the brightest control), once H-v2's Perform is copied in.

**Quick settings:** the same Quick sheet as Option 1.

**In Edit:**
- One line per sound, plus HANDS (wheel, pedal, bend, swell) and EFFECTS (Space · Echo · Chorus · Tape · Vibe).
  Each line = the ON tile · the sentence · a level slider · › to open. **All 7 lines fit at 1440×900 and at 1024×700**
  with KEYS open.
- The sentence **names only what differs from normal**; Octave and Chorus at their default live in Advanced.
- Opening a line: **Shape the piano** (Brightness / Warmth / Ring-out word sliders) + **Where it plays**.
- EFFECTS open reuses the exact Perform header chip rows, including Song's own. "Who goes in: Keys a little · Pad half ·
  Bass dry" replaces the rig map's lanes, in words.
- No map, no knobs, no chip grid anywhere in Edit.

**Scores:** Live **7** · Volunteer **7.5** · Feasibility **7** → **7.17**. **The live player would not ship it.**

**Effort: L overall** (Perform + Quick + lock: M, same as H; Edit sheet: "a light L", no map or focus routing, but
the sentence copy needs its own tested module).

**Risks (round-3 critics):**
1. **Mute trap (the live critic's no-ship reason).** The ON tile is the row header of every line, the biggest,
   most label-like thing on it, and the only way to open a line is a small chevron ~1,000 px away. A player in Edit
   mid-sermon clicks "KEYS" to open it and **mutes the piano in the room**. Fix: the label opens the line; mute
   becomes only an ON pill next to the level slider (B-v2's layout).
2. **The noise moved rather than disappeared** (volunteer). About 33 bold, dotted-underlined phrases in collapsed
   Edit read as a wall of links. Fix: normal weight, 3–4 tappable words per line, stronger underline on hover.
3. **Words disagree with Perform.** The sentence says "into the Hall" but the chip says "Space 25%"; the bucket rule
   would call Keys echo 10 % "dry" while echo is audibly on; "a little" and "a touch" both mean 25. Fix: range
   buckets where any nonzero value is at least "a touch", and use Perform's nouns ("a little Space (Hall)").
4. **Tapping "Hall" inside the KEYS line changes the room for every sound**, with only a neutral underline as a hint.
5. **Controls move from song to song**: a setting at default has no words, so Keys Octave is in the sentence for one
   song and 3 clicks deep in Advanced for the next. Bad for muscle memory.
6. **Song's own has no data source in Edit** (the snapshot lives in perform.js), and the Brightness/Warmth/Ring-out
   trio doesn't exist for organs (drawbars, drive, rotary) and many synths. Only the piano is mocked.
7. No undo in Edit; no muted-line state mocked; opening Advanced pushes DRONE and EFFECTS off-screen.

## Option 3: B-v2, the Sunday Keys switch bar + song-sheet Edit

`B-v2/perform.png`, `B-v2/edit.png`, `B-v2/quick.png` · also perform-locked, perform-sound, quick-mac, and the 1024
versions.

**The idea:** Perform becomes a panel of lit switches with **one full-width switch bar** for the shared effects, and
**Edit reads like the song** in two calm columns. It is the most literal take on "like Sunday Keys".

**On Sunday (Perform):**
- The same idea of ON tiles, plus a **sound picker** under each (Grand Piano ▾, frozen under lock), plus Sustain and
  Octave −/+ under each fader.
- A full-width **switch bar** above the keyboard: SPACE Room / Stage / Hall / Cathedral / More · ECHO Off / Slap / ¼ /
  Dotted ⅛ / Trails / Song's own · LOFI Tape · UNDO Revert song · **Quick settings**.
- Under lock: Space, Echo, Lofi, Sustain, Octave and the drone tile stay live; Transpose is press-and-hold.

**Quick settings:** a **right-side drawer that pushes the stage** over, with two tabs.
- **This song:** Space, Echo, Lofi, Vibe, drone brightness/movement, swell.
- **This Mac:** pedal Normal/Reversed + Test my pedal, Mono, Touch, keyboard toggles, Restart.
- Strips (tile, picker, fader, Sustain, Octave) and a mini drone strip stay usable while it's open.

**In Edit:**
- **What plays:** one line per sound ("KEYS plays Grand Piano on every key, sustain on", "BASS plays Sub Bass below
  middle C, an octave down, one note at a time"). Click to open: Sound / Plays / "More for Keys".
- **How it sounds:** "Vibe: your own mix", "The room is a Hall" (preset chips + "how much of each sound goes into the
  room"), "Echo: song's own 420 ms · Keys 10% · Pad 10%", "Chorus", "Lofi tape: off", "Finish".
- No map and no knobs.

**Scores:** Live **7** · Volunteer **7** · Feasibility **7** → **7.00**, 3 of 3 would ship.

**Effort: M–L**, in three independent phases: Perform panel M (2–3 days), lock + drawer S–M (1–2 days), Edit sheet L
(4–6 days including the ui-edit test rewrite). *[the designer's day estimates, not checked]*

**Risks (round-2 critics):**
1. **"UNDO: Revert song" is a one-tap chip inside the FX bar.** A player who mis-taps Echo reaches for "Undo" and
   instead every fader jumps back and the key resets, mid-song.
2. **Selected vs not is too weak in low light** ("Hall" vs "Room" differ by a slightly lighter grey and a 2 px border),
   and Sustain/Lofi on-off is an ~8 px LED dot.
3. **Fader throw:** 258 px at 1440, 182 px at 1024; at 1024 the drawer squeezes strips to about 114 px ("Grand P…").
4. **Esc is dead while the drawer is open** if it's built as a dialog (main.js disables Esc=Panic when a dialog is
   visible), and the drawer is meant to stay open for a whole song.
5. Edit: dotted underlines read as "definition", not "tap"; two different "on"s share a line (sustain on vs the ON
   badge); "Release 35%", "Tone 80%", "Oct 0" and "−1.9 dB" remain.
6. The empty EXTRA picker writes to a null slot as specified; the drone "last on-mode" rule changes behaviour.
7. The list of sentences doesn't show *where* sound goes, so "Reverb means two things" is only partly fixed.

---

## Side by side

| | **1 · H-v2** | **2 · H-sheet** | **3 · B-v2** |
|---|---|---|---|
| Total (Live / Volunteer / Feasibility) | **7.67** (7.5 / 8 / 7.5) | 7.17 (7 / 7.5 / 7) | 7.00 (7 / 7 / 7) |
| Would ship | 3 of 3 | 2 of 3 (Live: no) | 3 of 3 |
| Round | 3 | 3 | 2 |
| Perform switches per sound | ON tile + Space, Echo, Octave, Sustain | same as H-v2 | ON tile + sound picker + Sustain, Oct −/+ |
| Shared FX in Perform | one-tap chips in the header | same | full-width switch bar above the keys |
| ON / OFF | solid colour / grey struck-through | H-v2's once copied in (mockup: H's amber OFF) | lit tile / grey "OFF" pill |
| "What did I change?" | white dot + Revert count | H-v2's dots once its Perform is copied in (mockup: H's "lit = non-default") | Song's own chips only |
| Quick settings | top sheet over header | same | right push-drawer, 2 tabs, incl. Mono |
| Edit structure | 7 tabs + one panel + sentence title; wiring hidden | one sentence line per sound; words are controls | two columns of sentences: What plays / How it sounds |
| Dials in Edit | none (word sliders) | none | none |
| "Connected" by | Perform strip copied into Edit; same colours; sentence | same step panels as Perform, named after the chip | same switches + sentences |
| Fader throw at 1440 / 1024 (today ≈315 at 1440) | 250 / 143 (4 chips), 302 / 189 (2 chips) | same as H-v2 | 258 / 182 |
| Effort | M (Perform) + L (Edit) | M + light L | M + S–M + L |
| Biggest risk | drone glance + Revert too easy | ON tile as row header mutes live sound | one-tap "Undo" in the FX bar |

## Decisions you need to make

1. **Which option: H-v2, H-sheet or B-v2?**
2. **Lock rule.** Proposed: **live** = faders, ON tiles (4 + drone), drone level, wheel/Swell, all chips, header
   Space/Echo, Prev/Next, Fade out, PANIC, Quick › This song; **hold 600 ms** = KEY ▾ / Sing it in…, Transpose,
   the drone key grid, Major/Minor, Revert; **frozen** = Edit, ⚙, drone source/brightness/movement, Quick › This Mac,
   setlist reorder. It's isolated in one `LOCK` table. If you say no, the chips freeze under lock like today's
   pickers and nothing else changes.
3. **4 chips or 2 chips per strip.** 4 (Space, Echo, Octave, Sustain) costs about 20 % of fader throw (250 px vs
   ≈315 today at 1440). 2 (Space, Echo) keeps 302 px, and Octave/Sustain become read-only badges shown only when not
   normal. It's one const (`STRIP_CHIPS`) in the build, so it can be changed later.
4. **Edit: map-and-panel (H-v2's tabs + one panel) or song sheet (H-sheet / B-v2)?** The tabs scored higher on every
   lens; the sheet is shorter to read but moved the noise into ~33 links and has the mute trap.
5. Smaller, with my defaults: **Esc** keeps today's rule (closes an overlay, panics only when nothing is open; ⌘.
   always panics). **Revert** always needs the hold. **Changed dots** ship in Perform only at first.

## My recommendation

**Go with H-v2, and build its Perform half first.** It is the highest-scoring design of the night (7.67, up from 7.17),
all three critics would ship it, and it answers all three of your complaints: toggles you can reach mid-song, a calm
Edit with no knobs, and one sound at a time that looks like its Perform strip. Its Perform half doesn't depend on its
Edit half, so you get the "Sunday Keys toggles" without betting on the Edit rewrite, and the map-vs-sheet question can
wait until you've played the new Perform on a Sunday.

**Before building, fold in the round-3 fixes** (my synthesis of the critics, not yet mocked or re-scored):
1. The drone uses the same ON tile; the key grid, Major/Minor and Synth/My Pads selections become outline-only; mock the
   drone-OFF state. Keep "Key & drone" as the card title.
2. Take mutes out of the changed count; Revert always needs the 600 ms hold ("Hold to revert · 2 changed").
3. Changed dots in Perform only; no dots or footer in Edit until the snapshot rule is decided.
4. Keep today's Esc rule; the outside-click swallow never applies to PANIC, Fade out, ON tiles or Prev/Next.
5. Drone ON source: the snapshot's mode if not off, else Synth; document the reload case.

**Smallest first slice (M):** steps 1–3 of `H-v2/implementation.md`.
1. `shared/song-diff.js` (pure) + `onTile`, `modChip`, `stepPanel`, `holdButton`, with node:test and Playwright tests
   (Esc, colour contract, the 50 % legibility check).
2. Perform: the new tile/chip CSS, 4 or 2 chips (your decision 3), header Space/Echo chips with hints and Song's own,
   the Revert count, PANIC restyled.
3. The Quick sheet (Tempo/TAP, Swell, Touch, pedal light + Reversed, hold-to-restart). Add the lock table **only if you
   OK it**; otherwise the chips go disabled under lock like today's pickers.

This slice doesn't touch edit.js. Land it after the other agents editing `app/` have merged, because perform.js is a
conflict hotspot. If you want it smaller still, step 2 alone (tiles + chips, no Quick sheet, no lock change) is an S–M
that already removes the MUTE buttons and puts Space/Echo on every strip.
