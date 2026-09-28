# Slot EQ: decision

Two prototypes, both working against real Salamander/Rhodes samples, nothing under `app/` touched:

| Prototype | What it is | Review score |
|---|---|---|
| `curve/` | 4 draggable parametric bands (low shelf, 2 bells, high shelf) over a pitch-true 88-key axis, Hz ruler, typed Hz/Note/dB/Q table | **7.3** (volunteer 7 · live-sound 7 · engine/UI lead 8) |
| `octaves/` | 7 fixed octave bars (A0–A1 … A6–C8) + an Air shelf over the same axis, paste-and-fit importer | not scored in this run (the review pass returned results for `curve` only) |

## 1. What to build

**Build `curve`, as one EQ model, and take three things from `octaves`.** No octave-bar mode.

Why curve:
- **Transfer is exact.** The user asked for Hz "so people can transfer other EQs over". A parametric band takes
  `PK 250 Hz Q 1.4 −3 dB` verbatim. Octave bars can only fit it: `octaves` reports 0.8 dB RMS and 4.3 dB worst-case on
  its own example, and cannot make a notch at all.
- **Backward compatible for free.** Today's `eq.low` (120 Hz shelf) and `eq.high` (6 kHz shelf) *are* curve's outer
  bands. `octaves` keeps them as separate knobs, so a song would run two EQs in series with two sources of truth.
- **Cheaper.** +3 biquads per slot (2 bells + low cut) against +8 for octaves.

Taken from `octaves`:
1. **"Bring an EQ over" paste box** (EqualizerAPO/REW lines, `PK/LSC/HSC/HP`, free text, `2 oct` bandwidths). With
   parametric bands it maps line-for-line instead of fitting; lines that don't fit (a 3rd bell, a notch type, a
   shelf slope) are listed as "skipped" rather than approximated.
2. **Its greying rule for the high side:** above the top note stays live ("overtones"), below the bottom note is the
   only real "nothing here" zone.
3. **The "Where this slot plays" re-grey on change** (range, octave, instrument), plus transpose, which both
   prototypes omitted.

The "simple mode" for volunteers is **not** octave bars (that would be a second param model and 8 more filters). It is
what H already specifies: the **Brightness** word slider (= `eq.high`) and a **Warmth** word slider (= `eq.low`) in
"The sound itself", plus preset chips. The keyboard EQ is the Advanced → Tone panel for people who want it.

## 2. Param model

Flat rows, **two path segments after `slots.<i>`** (`eq.mid1Hz`, not `eq.b1.freq`). Reason, verified in code:
`store.normalizeSlot` nests only one level (store.js:238–239: `out[segs[0]] = {…, [segs[1]]: c}`), so a 3-segment
row would be written to `slot.eq.b1` as a number. Two segments need no store or controller change (store `SLOT_EXTRA`,
controller `SLOT_PARAMS` derive from the table).

| Path | Range | Default | Unit / curve | Label | Notes |
|---|---|---|---|---|---|
| `slots.<i>.eq.low` | −12…12 | 0 | dB / lin | Low shelf | **existing row, unchanged** |
| `slots.<i>.eq.lowHz` | 40…500 | **120** | Hz / log | Low shelf Hz | = today's fixed `eqLow` (fx.js:1369) |
| `slots.<i>.eq.mid1` | −12…12 | 0 | dB / lin | Bell 1 | |
| `slots.<i>.eq.mid1Hz` | 20…20000 | 400 | Hz / log | Bell 1 Hz | |
| `slots.<i>.eq.mid1Q` | 0.3…10 | 1 | lin / log | Bell 1 width | RBJ linear Q |
| `slots.<i>.eq.mid2` / `mid2Hz` / `mid2Q` | same | 0 / 2500 / 1 | | Bell 2 … | |
| `slots.<i>.eq.high` | −12…12 | 0 | dB / lin | High shelf | **existing row, unchanged** (H's Brightness slider) |
| `slots.<i>.eq.highHz` | 1000…16000 | **6000** | Hz / log | High shelf Hz | = today's fixed `eqHigh` (fx.js:1370) |
| `slots.<i>.eq.cutHz` | 20…400 | 20 (= off) | Hz / log | Low cut | 2nd-order Butterworth (`BUTTER2_Q`, dB Q) |

Decisions against the brief, with the evidence:
- **Frequency is stored in Hz, not as a MIDI-note float.** The brief assumed a MIDI float "round-trips to Hz
  exactly". Measured in Node: for 39 common EQ frequencies, 30 do not (e.g. 40 → 39.999999999999986,
  25 → 25.000000000000004). Hz is what a transferred setting *is*; the note ("≈B3 +21¢") is derived for display. An
  `Hz`/`log` row gives the same equal-semitone slider and MIDI-learn taper a MIDI float would.
- **Band type is fixed per band, not a stored enum, in v1.** A type switch needs fade → switch → fade through
  `engine.at` (the prototype skips this and clicks), adds 4 learnable enum rows per slot, and makes "Low shelf" labels
  wrong when band 0 becomes a bell. If a notch is ever wanted: `eq.mid<k>Type` enum `['bell','notch']` later.
- **No per-band on/off rows.** A/B in the editor is an audition, not song data: `controller.eqAudition(i, 'bypass')`
  ramps the strip to flat without writing the store.
- **No migration.** Every existing song is already valid: absent rows = defaults = today's 120 Hz / 6 kHz shelves.
  `eq.low`/`eq.high` keep their meaning, so MIDI-learn mappings and H's Brightness slider keep working.
- Master EQ (`fx.eq.*`) is untouched in v1. The same editor can drive it later; its grey zone is the union of the
  active slots' ranges.

## 3. Engine change

**fx.js `SlotStrip`** (fx.js:1355–1420):

```
wOut ─→ cutDry ─────────────────┐
wOut ─→ lowCut (HP) ─→ cutWet ──┴─→ eqLow ─→ eqMid1 ─→ eqMid2 ─→ eqHigh ─→ pan
```

- New nodes: `lowCut` (highpass, `Q: BUTTER2_Q`), `cutDry`/`cutWet` (gain 1/0), `eqMid1`, `eqMid2` (peaking, 0 dB).
  `nodeCount` 16 → 21. Add all five to the `dispose()` list (fx.js:1414).
- `setEq(o, when, step)` takes an object `{low, lowHz, mid1, mid1Hz, mid1Q, …, cutHz}`; only present keys move.
  Gains and Q: `rampTo(…, TAU)` (or `setNow` when `step`). Hz: `glideTo(p, hz, when, TAU, {from: this._eq[key]})`
  with the last target tracked in `this._eq` (CLAUDE.md: ramps scheduled ahead need `{from}`).
- Low cut at 20 Hz is **not** identity: a 20 Hz Butterworth is −1.07 dB at A0 (27.5 Hz). So `cutHz ≤ 20.5` means
  bypass: `equalPowerFade` cutWet → cutDry over 20 ms; above that, fade to wet and glide the frequency.
- **`automationRate = 'k-rate'` on every EQ biquad param** (frequency, Q, gain, detune), including the existing
  `eqLow`/`eqHigh`.
- **No bypass when gains are 0.** Measured instead:
  - A 0 dB peaking / lowshelf / highshelf biquad is **bit-exact identity** in Chromium: 2 in series vs none, 5 s
    of noise, max |diff| = 0. Existing songs render the same.
  - CPU, 4 slots × stereo noise, 30 s rendered offline at 48 kHz in this 2-CPU container (median of 3):

    | Chain per slot | Render time | ≈ share of one core |
    |---|---|---|
    | none | 32 ms | 0.1 % |
    | today (2 shelves, static) | 251 ms | 0.8 % |
    | proposed (5 biquads, static) | 568 ms | 1.9 % |
    | 5 biquads, gain ramping, a-rate | 2901 ms | 9.7 % |
    | 5 biquads, gain ramping, k-rate | 796 ms | 2.7 % |

    Static cost is about +1 % of a core, not worth a graph switch (which itself needs a crossfade). The real cost is
    Chromium's per-sample coefficient path while a param is ramping (5×), which k-rate removes. k-rate steps the
    coefficients every 128 frames (2.7 ms); with TAU smoothing no zipper is expected, but **nobody has listened
    for it on speakers yet**.

**audio.js** (the three places that hard-code the 2-band shape):
- Line 92 normalisation rebuilds `slot.eq = {low, high}` and drops every other field on song load. Replace with:
  clamp every present `eq.*` key that has a `slots.<i>.eq.*` PARAMS row.
- `setParam` lines 787–790: `cfg.eq = {...(cfg.eq || {}), [rest[1]]: v}`, then
  `coalesce.push(path, t, (tt) => sc.strip.setEq({[rest[1]]: v}, tt))`.
- `getParam` line 812: return `cfg.eq?.[rest[1]] ?? describe(path).default` (today's `?? 0` is wrong for Hz rows).
- `_applySlotCfg` lines 613/618: `s.setEq(fullEq(cfg.eq), t, step)`, where `fullEq` fills defaults from PARAMS.
- New, for the editor only (all reached through `controller.*`; views never touch the engine):
  - `engine.slotAnalysers(i)`: two `AnalyserNode`s (fftSize 16384) tapping `wOut` (pre) and the `pan` input (post),
    created when the Tone panel opens and disconnected when it closes, so there is no FFT cost on stage.
  - `engine.auditionNote(i, soundingMidi, {when})`: plays one slot's instrument at a sounding pitch, ignoring the split.
  - `engine.eqAudition(i, 'bypass' | 'on', {when})`: the non-persisted A/B.
  - `listInstruments()` entries gain `range: [lo, hi]` (samplers: union of manifest layers; synth/organ/drone: none).

## 4. Where it sits in Edit (H-v2)

- **Advanced drawer → "Tone" panel.** H-v2 §3's Advanced row today reads "Pan · Width · Highs · Transpose · …";
  "Highs" becomes **"Tone"** with a summary ("Flat", or "Custom · 3 bands"). Opening it shows the keyboard EQ across
  the full panel width: graph ≈180 px, Hz ruler, 64 px pitch-true keyboard. Preset chips on the header
  (Flat · Warm · Clear · Air · Less mud · Low cut). The Hz/Note/dB/Q table and the paste box sit under one
  disclosure, "Numbers (Hz · Q · dB)": the Hz ruler and the hover readout are always visible, the table is one click
  away, which keeps volunteers out of it without hiding it.
- **"The sound itself":** Brightness (`eq.high`, already in H) and Warmth (`eq.low`) word sliders are the simple mode.
  They move the same shelves the editor draws.
- **Mini read-only curve on the slot card:** a 120 × 28 px sparkline of the summed response on the same key axis,
  greyed outside the slot's range, in the Sound panel's header next to the sentence. Shown only when the EQ is not
  flat; clicking it opens Advanced → Tone. On the H-v2 tab row it's a small tone dot only (tabs drop sub-labels at
  1024, so there is no room for a curve).
- `slotSummary` "Tone EQ" (edit.js:1219) must read any non-zero gain or `cutHz > 20`, not just `low`/`high`.
- Perform: no change.

## 5. Greyed zones

A pure function in `shared/eq-axis.js`:

```
shift    = 12·slot.octave + slot.transpose + songTranspose          // as audio.js:1151
physical = [max(ctrl.lo, slot.lowNote), min(ctrl.hi, slot.highNote)]  // split is on the physical key
sounding = [physical.lo + shift, physical.hi + shift]
sampled  = inst.range ?? [0, 127]
fLo = midiF(sounding.lo − ½),  fHi = midiF(sounding.hi + ½)
```

| Zone | Where | Drawn as | Band tag |
|---|---|---|---|
| **No notes** | 20 Hz … fLo | hatched, muted grey keys; clicking a key → toast "Keys doesn't play C2 · its notes are C3–C8" | "No effect on notes" (still editable: a low shelf there cuts rumble) |
| Plays | fLo … fHi | normal keys, slot range bar | "Boost/Cut notes F#3–C5" |
| **Tone of your notes** | fHi … 20 kHz | a *light* tint, not a disabled veil; label "Tone (overtones) of C3–C8"; no dashed ring | "Brightens / darkens the tone of A0–B2" |
| Stretched sample | outside `sampled` but inside `sounding` | light diagonal hatch, hover "stretched sample" | as Plays (it does sound) |

- `ctrl` = the lowest/highest note seen on the MIDI input this session, falling back to 88 keys (A0–C8).
- Band reach: the band's own digital RBJ response at 400 log points (20 Hz–20 kHz, at `ctx.sampleRate`); keep the
  points where `|dB| ≥ max(0.5, 0.3·|gain|)`; compare min/max with fLo/fHi.
- Both reviewers' fixes land here: the volunteer lens found "overtones only" read as *disabled* on the Bass tab,
  where the most common bass moves (250 Hz mud, 800 Hz–1 kHz definition) live; hence the tint and the wording.
- Q ↔ bandwidth uses the **digital** relation, `1/Q = 2·sinh(ln2/2 · BW · w0/sin w0)`. The review measured Q 1.4 as
  1.01 oct at 880 Hz but 0.74 oct at 10 kHz at 48 kHz; the prototype's analog formula is wrong in the air zone.
- Axis: one semitone = one unit (A0 27.5 Hz … C8 4186 Hz, 88 units); compressed "sub" (20–27.5 Hz, ×0.5) and "air"
  (4.3–20 kHz, ×0.42) zones either side, as in `curve`.
- Colour: sounding notes as white dots on key tops (not yellow fills); boost/cut tints never use the slot colour.

## 6. Steps and effort

| # | Step | Effort |
|---|---|---|
| 1 | `shared/eq-axis.js`: `uOfF/fOfU`, pitch-true key layout, `rbjCoeffs`, `bandReach`, `soundingRange`, Hz/note/`oct` parsers, digital Q↔BW, EqualizerAPO/REW paste parser (from `octaves`). node:test against the numbers in `curve/shoot.mjs` | M · 1 d |
| 2 | PARAMS rows (§2); shell3-style test that `slots.1.eq.mid1Hz` goes store → controller → engine and back, and that `normalizeSlot` keeps it | S · ½ d |
| 3 | Engine: SlotStrip nodes, object `setEq`, k-rate, low-cut crossfade, audio.js 92/613/618/787/812. Offline test: a song with `eq.low = 3` renders within 1e-5 of the pre-change build | M · 1 d |
| 4 | Engine extras: `range` in `listInstruments`, `slotAnalysers`, `auditionNote`, `eqAudition`, controller pass-throughs | M · 1 d |
| 5 | `views/components/eqCurve.js`: port `curve` (canvas, drag with per-axis deadzone, wheel/pinch/ear widths, keyboard nav, table, paste, Copy as text), using `keys.js` only for `isBlack`/`noteName` | L · 2–3 d |
| 6 | Edit wiring: Advanced → Tone, Warmth slider, mini curve, summary chip, presets | M · 1 d |
| 7 | `CONTRACT_CHANGES.md` `## slot-eq-5band` (rows, the identity and CPU numbers above), 1024 check, zero console errors, Playwright screenshots | S · ½ d |

About 7–8 days in total.

## 7. Open risks

- k-rate zipper and the low-cut crossfade are measured for CPU only, not listened to.
- The controller's key range is unknown until notes arrive; a 61-key board will grey less than it should at first.
- The drawn curve must use `ctx.sampleRate` (44.1 vs 48 kHz differ by a fraction of a dB near 20 kHz).
- Pad has no samples in the repo; both prototypes used a stand-in synth for it.
- Rhodes G#7–C8: the sampler repitches G7 without limit. This design shows it as "stretched", not greyed. Enforcing
  a manifest range in `noteOn` is a separate decision.

## Prototype fixes made during this decision (design/eq/curve/index.html only)

- A purely vertical drag no longer re-snaps a typed frequency (and a sideways one no longer touches the gain): a 4 px
  per-axis deadzone. Verified: typed 250 Hz, dragged 20 px up → still 250 Hz.
- Enter in an unchanged cell no longer re-parses its display text ("≈B3 +21¢ · 250 Hz" used to become B3 =
  246.94 Hz). Verified: stays 250 Hz. Zero console errors.
