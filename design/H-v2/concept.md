# H-v2: H, with a calm Edit and state colours you can read from the music stand

**In one line:** Perform is H's Perform (ON tile = mute, chips per strip, one-tap Space/Echo chips, "Sing it in…",
Quick sheet) with the colours fixed. **ON is a solid tile in the sound's colour, OFF is a grey struck-through tile**,
chips are a quieter tint, and a small **white dot** marks anything changed since the song was loaded. Revert counts
those dots. Edit keeps H's one-part-at-a-time panel and its sentence title, but the rig map is now **one row of tabs**
(Keys · Pad · Extra · Bass · Drone · Effects · Master). The wiring is behind a **Show wiring** switch.

Nothing under `app/` was touched. Mockups are static HTML built by `src/build.mjs` (run
`node design/H-v2/src/build.mjs --shots` from the repo root; it also prints the measured fader throw).

| File | Shows |
|---|---|
| `perform.png` · `perform-1024.png` | Perform at rest. Two changes this morning: Keys Octave +1, Pad Space 50 → 75 (dots, "Revert · 2 changed") |
| `perform-off.png` · `perform-off-1024.png` | Pad switched OFF |
| `perform-off-1024-50pct.png` · `…-grey.png` | The 1024 OFF shot at 50 % (and greyscale): ON/OFF check |
| `perform-2chips.png` · `perform-2chips-1024.png` | Two-chip variant (Space, Echo only) for comparing fader height |
| `perform-locked.png` | Locked, with a hold in progress on Transpose +, and a **design-note card** (magenta, not UI) for the rule |
| `perform-step.png` | Keys **Octave** step panel ("as loaded" marker, "starts on your next note") |
| `perform-key.png` | KEY ▾ → Sing it in… (unchanged from H) |
| `quick.png` | Quick sheet (unchanged from H apart from the tempo hint) |
| `edit.png` · `edit-1024.png` | Edit, Keys tab, wiring hidden (default) |
| `edit-wiring.png` | Same, **Show wiring** on |
| `edit-effects.png` | The **Effects** tab: three plain-English lines (Space, Echo, Chorus) |

---

## 1. What changed from H, and why

### (1) The rig map is now a row of tabs
The volunteer critic's #1: H's map read as wiring (DRY MIX / SHARED EFFECTS labels, three send lanes, dot-size legend).

- **One row of 7 tabs**, each carrying Perform's colour on a 3 px top bar, the role name, the sound name and a
  white changed-dot. **Effects** and **Master** are set apart by a gap and use the neutral steel (`--fx`), because
  they're shared.
- **The selected tab opens into its panel** like a folder tab. That replaces H's coloured tie-line: the connection is
  the shape itself.
- **The sentence title stays** ("KEYS plays Grand Piano on every key, ● an octave up, a little into the Hall,
  sustain on"). The white dot in the sentence marks the word you changed.
- **Show wiring** (off by default, `edit-wiring.png`) opens a strip under the tabs whose columns line up with the
  tabs. Each sound drops into three lanes (Space · Hall / Echo · song's own / Chorus · gentle), which end in "to
  Master". **Each crossing shows a number (25 %, 10 %)**, not a dot size, and those are the same values as the sound's
  chips. Zero is a dashed "–", and the drone shows "fixed". The caption says it once: "Every sound goes straight to
  Master. The numbers are how much also goes into each shared effect." There are no DRY MIX / SHARED EFFECTS labels.
- **The Effects tab borrows B-v2's calm "How it sounds" lines** (`edit-effects.png`): "The room is a **Hall**",
  "The echo is **the song's own**", "The chorus is **gentle**", each followed by its preset chips (or two word
  sliders for Chorus), a one-line Fine-tune summary, and **"How much of each sound goes in"** as the **same Keys / Pad /
  Bass chips as Perform** (tap → the same 100/75/50/25/Off steps). H's separate Space/Echo/Chorus panels collapse
  into this one tab.
- **Master tab** (not mocked): H's Tape + Master panels. Tape moves here from the old map ("Tape & finish" link in
  the Effects footer).
- **Keyboard block** (wheel/bend routing, swell time): there's no tab for it in the brief's list, so it's a quiet
  **"Wheels & pedal"** link at the right of the tab row. *Deviation from the brief; flagged.*

### (2) State colours
The critic: Keys ON (orange pill) vs OFF (amber pill) looked the same from the stand, lit chips out-shone the ON tile,
and amber meant six things.

| State | H | H-v2 |
|---|---|---|
| Sound ON | tinted tile, coloured outline, small coloured ON pill | **solid fill in the slot colour**, dark text, white LED, soft glow: the loudest thing in the strip |
| Sound OFF | dark tile with a **solid amber OFF** | **grey tile, name struck through, hollow LED, "OFF" outlined in grey**; the rest of the strip goes grey and 36 % opacity; grey range bar |
| Chip in use (Space/Echo > 0, Octave ≠ 0, Sustain on) | solid slot fill (brighter than the tile) | **20 % tint of the slot colour + coloured outline + amount bar**: clearly on, clearly quieter than the tile |
| Chip at rest | grey outline | grey outline (unchanged) |
| Sustain off | amber "Sus. off" | grey "Sustain off" with a hollow LED; amber is gone |
| Changed | "lit" meant "not default" | **white dot** before the value: differs from the song as loaded |

**Amber is now used only for lock** (HOLD tags, the Locked button, the hold-progress fill). The accent yellow keeps
one job: "where you are" (current tab, current song, KEY, held keys). The pedal LED is white.

**50 % check** (`perform-off-1024-50pct.png`, and the greyscale copy): the ON tiles are solid colour blocks and the
OFF tile is a dark outline. Mean luminance of the tile area in the greyscale copy: Keys ON 155, **Pad OFF 53**, Bass ON
152. That's a 3× difference with colour removed, so it doesn't depend on hue. *[measured on the mockup, not the app]*

**Changed dot:**
- **Meaning:** the value differs from the Revert snapshot that perform.js already keeps (`snap.song`: the song as
  the controller committed it). It isn't a comparison with factory or default.
- **Where it shows:** on chips, header FX chips, Edit tabs, sentence words, and Edit's footer
  ("1 change since the song was loaded").
- **The Revert button counts the dots** ("↺ Revert · ● 2 changed").
- **Faders and levels don't get a dot and aren't counted.** They're continuous playing, so the count would never be
  0. Revert still restores them, as it does today.
- **Step panels mark the loaded value** with a small "as loaded" line (perform-step.png), so you can find your way
  back without Revert.

### (3) The lock rule: a behaviour change that needs Ryan's OK
The rule is mocked in `perform-locked.png` with a design-note card in place of Notes. The card is magenta, dashed,
labelled "not part of the UI", and says "needs Ryan's OK before it's built".

| While locked | Controls |
|---|---|
| **Live, one tap** | faders · ON tiles (4 + drone) · drone level · wheel & Swell · **all strip chips** · **header Space/Echo chips** (incl. Song's own) · Prev/Next · Fade out · PANIC · Quick › This song |
| **Hold 600 ms** (amber HOLD tag, amber fill rises inside the button, "keep holding… (0.6 s)") | KEY ▾ Sing it in… · Transpose −/+ · drone key grid · Major/Minor · Revert |
| **Frozen** (dimmed) | Edit tab · ⚙ · drone Synth/My Pads, Brightness, Movement, toggles, pad folder · Quick › This Mac · setlist reorder |

**What today's lock does** (read from `app/js/views/perform.js:445, 559–612`): faders, mutes and Prev/Next are
already live. Transpose, the key grid, drone mode/quality/options, the Space/Vibe pickers, reorder and Revert are
frozen. So the real change is two things:
- **Chips and header FX become live.**
- **Key changes and Revert go from frozen to hold.**

**If Ryan says no,** the chips freeze under lock exactly like today's pickers. The layout doesn't change.

The Locked button now reads "playing stays live / hold to unlock".

### (4) Two chips vs four
`perform-2chips.png`: only Space and Echo per strip. Octave and Sustain become **read-only badges on the tag line,
shown only when not normal** ("Oct +1 ●", "Oct −1", "Sus. off"). You change them in Edit's On-stage column.

| Fader track (measured by build.mjs) | 1440×900 | 1024×700 |
|---|---|---|
| Today's app (from OPTIONS.md, not re-measured) | ≈ 315 px | — |
| **H-v2, 4 chips** | **250 px** (−21 %) | **143 px** |
| **H-v2, 2 chips** | **302 px** (−4 %) | **189 px** |

My take: four chips if Ryan actually moves octave or sustain mid-song (the player critic said he does). Two chips if
the fader is the main instrument. It's a one-line switch (`chips: 2`), so it could even be a Setting later. That would
be a new store field, so it isn't proposed now. *[judgement, untested with players]*

### (5) The other critique items (OPTIONS.md "Risks the critics raised" + "Two changes before the Edit half")

| # | Item | Verdict | In H-v2 |
|---|---|---|---|
| 1 | Rig map loudest/most technical; DRY MIX / SHARED EFFECTS labels; dot legend (25 % ≈ 10 %) | **Accepted** | Tabs + Show wiring with numbers; labels and legend removed |
| 1b | "Or borrow B-v2's sentence lines as the How-it-sounds side" | **Accepted, scoped** | The Effects tab is B-v2's lines. Sound tabs keep the 3-column panel, because B-v2's lines don't show *where* sound goes and the On-stage copy is H's main "connected" device |
| 2 | ON vs OFF same hue; chips out-shine tile; amber × 6 | **Accepted** | §(2) |
| 2b | "OFF grey + struck-through, never amber" | **Accepted** | The name is struck through, not the dB. A struck dB made the level look deleted rather than parked. The dB just greys with the strip |
| 3 | "Lit = not default" → "changed since loaded" dot + Revert count | **Accepted** | §(2); faders excluded from the count (reason above) |
| 4a | Jargon in echo chips (Slap, ¼, Dotted ⅛, Trails, 420 ms) | **Accepted** | Header chips are a word + a small hint: Off *no echo* · Slapback *1 repeat* · Quarter *on the beat* · Dotted 8th *worship echo* · Trails *long, dark* · Song's own *as saved*. Space chips get size hints (none/small/medium/big/huge). **ms only appear in Edit** |
| 4b | "Space 25 %" vs "Hall" naming | **Partly rejected** | I kept **Space** as the one noun on the strip chip. Renaming the chip after the room reads "Dry 25 %" when Dry is chosen, and "Hall 25 %" changes meaning when the preset changes. The step panel now says "how much goes into the Space (Hall)", and the Edit sentence says "a little into the Hall", so both words are always shown together |
| 5a | Octave/Sustain apply on the next note (audio.js:779) | **Engine change rejected, copy accepted** | Re-pitching held voices is engine work, outside "no engine code". The Octave step panel says "**Starts on your next note**; held notes keep ringing." |
| 5b | "Nearest preset" for a custom echo has no rule | **Accepted by removal** | The dashed "nearest" chip is gone from Perform and from Edit's send steps. "Song's own" selected is enough, and it removes a rule nobody could explain |
| 5c | One mockup says synced, another custom 420 ms | **Accepted** | Consistent everywhere: this song's echo is a **fixed 420 ms** (Effects line: "so it doesn't follow the tempo"; Quick: "This song's echo is fixed") |
| 6 | Fader throw −20 % | **Accepted as a choice** | Measured both variants (§4) |
| 7 | Looser lock needs sign-off | **Accepted** | Design-note card + this doc; revert path stated |
| — | B-v2 per-strip sound picker in Perform | **Still rejected** | It costs 38 px of fader, and changing instruments is an Edit job |
| — | A "Show wiring" preference saved per user | **Rejected for now** | It would be a new settings field. It's view memory only (resets on reload), and hidden is the right default for volunteers |

---

## 2. Perform (unchanged apart from §1)
The positions are today's, as in H: wheel · strips · Key & drone · notes · keyboard · Revert / Fade out / PANIC /
Lock. Other changes:
- The header FX card is wider (640 px) to fit the two-line chips; the song title drops 2 px.
- The empty EXTRA column is a neutral dashed grey (not blue), so it stops looking like a fifth colour.
- At 1024 the FX rows collapse to the Space / Echo pills, as in H.

Everything else is exactly as in H/concept.md §2: step panels inside the strip (tap = done, an outside click is
swallowed), Song's own, Sing it in…, Next as a button, and PANIC as the brightest control, labelled "Esc".

## 3. Edit
```
┌ library ┐┌ [● LIVE] Sunday Pad + Piano · Key D ▾ · 72 BPM Tap · Notes · "The song that's playing…" · ⋯ Song ┐
│         ││ YOUR RIG  Pick a part to edit it…                       [⌨ Wheels & pedal]  (○ Show wiring)     │
│         ││ ▔KEYS●▔   ▔PAD●▔    ┄EXTRA┄      ▔BASS▔     ▔DRONE▔       ▔EFFECTS▔     ▔MASTER▔                  │
│         ││ │Grand Piano│ Warm Pad  + Add a sound  Sub Bass   D major·Synth   Hall·echo: own  −6.0 dB·Tape off │
│         ││ ┘          └──────────────────────────────────────────────────────────────────────────────────── │
│         ││ [icon] KEYS plays Grand Piano on every key, ● an octave up, a little into the Hall, sustain on  [Change ▾]│
│         ││ ON STAGE (= Perform strip)  │ THE SOUND ITSELF (3 word sliders) │ WHERE IT PLAYS (range, Response)    │
│         ││ › Advanced  Pan · Width · Highs · Transpose · Voices · Pitch bend        ● 1 change since the song was loaded │
└─────────┘└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
 keyboard row: legend · 61 keys with range bars (display only) · output meter · Fade out · PANIC ⌘.
```
- The panel gains about 130 px of height from dropping the map. It goes to the On-stage fader (now as tall as a
  Perform fader) and to spacing, not to more controls.
- At 1024 the library becomes "☰ Songs", tabs drop their sub-labels, and nothing scrolls (`edit-1024.png`).
- The rest follows H: word sliders, no knobs, Change instrument ▾ → Remove this sound…, ⋯ Song → Reset to factory…, and
  PANIC shows ⌘ . in Edit.

## 4. Honest limits
- **"Since the song was loaded" is really "since the Revert snapshot".** Today perform.js re-snapshots when you leave
  Edit, so after an Edit visit the dots clear. The Edit footer's copy is slightly optimistic about that. The
  alternative is keeping the snapshot across Edit visits, which changes what Revert does (not proposed).
- **The white dot is small** (8 px). It's meant for a glance after the sermon, not for reading mid-song. Revert's
  count is the reliable readout. *[untested]*
- **Effects-tab chips reuse Perform's step panel,** which was sized for a strip. Inside a 250 px column it needs
  checking at 1024 (not mocked).
- **"Wheels & pedal" as a link, not a tab,** is my call. If Ryan wants it as an 8th tab, the grid has room at 1440 but
  not at 1024.
- **The word buckets and the sentence copy** are still my wording, untested with a volunteer. The Sunday Keys
  reference is still from support-doc text (see research.md).
