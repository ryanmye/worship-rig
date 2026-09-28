# EQ prototype "octaves": a graphic EQ laid over the piano

A per-slot EQ whose x-axis is the keyboard. There is one bar per octave (A0–A1 … A5–A6, A6–C8), plus an **Air** bar
for everything above C8. You drag a bar up or down (±12 dB) and hear the result on real Salamander notes. A live
spectrum sits behind the bars, and every bar lists its Hz, Q and dB, so a setting can be copied in from another EQ or
out to one. Keys the slot never plays are greyed out, and so are the bars over them.

Design only. Nothing under `app/` was changed.

## Run it

```sh
python3 -m http.server 8460 --directory /home/claude/worship-rig
# open http://127.0.0.1:8460/design/eq/octaves/index.html
node design/eq/octaves/shoot.mjs      # regenerates every PNG here (serves the repo itself; set
                                      # PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers in this container)
```

The page reads `../../../app/samples/manifest.json` and loads the samples it lists (the middle velocity layer only,
fetched lazily for the slot's range). Opened from `file://`, it shows a banner and falls back to a synth voice.
The shoot run reports **0 console errors and 0 HTTP ≥ 400**.

| File | What |
|---|---|
| `index.html` | the prototype (self-contained; the only external requests are the samples) |
| `eq.png` / `eq-1024.png` | Keys slot (C3–C8), "less mud + a little air" setting, loop playing, at 1440×900 and 1024×700 |
| `story-1..3.png` | storyboard: flat → dragging A4–A5 (live Hz/Q/dB chip) → released at +10 dB, analyser lifted over 440–880 Hz |
| `eq-bass-smooth.png` | Bass slot (A0–B2, −1 octave) in Smooth mode; everything above B2 is "overtones only" |
| `eq-pad-fit.png` | Pad (synth, C2–C6) with two 2-octave bars; an EqualizerAPO paste was fitted (dashed line = the original curve) |
| `eq-extra.png` | Extra on Rhodes (samples C1–G7, slot C4 up): three bars off, G#7–C8 hatched as "stretched sample" |
| `shoot.mjs` | Playwright driver for all of the above |

## What you see and do

- **Axis.** One unit is one semitone, so the axis is log-frequency and the key centres sit exactly at their
  fundamentals: A0 = 27.5 Hz at the left, C8 = 4186 Hz at the right. The white keys are drawn with the widths needed
  to make that true (C, E, F and B are 1.5 semitones wide; D, G and A are 2). A Hz ruler (30 · 50 · 100 … 4k) runs
  between the plot and the keys. Past the top edge of C8 (4.31 kHz), an **air zone** squeezes 4.3–20 kHz (2.2 octaves)
  into 11 semitones' width and gets its own blue ruler (6k · 10k · 20k). There are no keys there; it is labelled
  "overtones".
- **Keyboard = the pitch you hear.** It shows physical key + 12·octave, so Bass (keys A0–B3, −1 octave) lights up
  A0–B2. Clicking a key plays that sounding pitch on the slot's instrument, and dragging across keys glides. Keys the
  slot never plays refuse, with a toast that says why.
- **Bars.** Drag anywhere in a bar's column. The bar follows the pointer, in 0.5 dB steps (0.1 dB with Shift).
  Double-click resets a bar to 0. Arrow keys work when the canvas has focus (←/→ picks a band, ↑/↓ ±0.5 dB,
  Shift ±3 dB, `w` widens).
- **Alt-drag (or Alt-click) widens a bar.** It merges the bar with the neighbour on the side you drag toward (the
  right by default) into one 2-octave peaking band. Doing it again splits them. A merged bar is labelled "2 OCT", and
  its table row gets a chip.
- **Smooth.** The bars become nodes on a Catmull-Rom spline through the band centres. The audio is the same either
  way. In both modes the white line is the **true summed response**, computed with the same RBJ maths Web Audio uses,
  so what's drawn is what you hear.
- **Analyser.** Two 16k-point FFTs (2.7 Hz bins at 44.1 kHz, fine enough to separate the notes around A0), mapped onto
  the same axis. The fill in the slot colour is after the EQ; the dotted line is before it.
- **Presets** (Flat, Less mud, Warm, Bright & clear, Air only, Tight bass, Behind the vocal). **A/B**: each slot has
  two full settings, and the filters switch with a 12 ms glide. **Copy A→B** copies the current one into the other.
  **Chord / Loop** play voicings inside the slot's range, so there is always signal while you compare.
- **Where this slot plays.** Instrument, lowest key, highest key and octave. Changing any of them re-greys the keys
  immediately.

## How a bar becomes a filter

Each bar is a `BiquadFilterNode` of type `peaking`. Its centre is the geometric centre of its span. Its Q gives the
filter a bandwidth **K = 1.917 times** the bar's width, where K is chosen so that a 1-octave bar is exactly **Q 0.70**
(RBJ: `Q = 2^(B/2) / (2^B − 1)`, with B the bandwidth in octaves). Q 0.70 is roughly a 1.9-octave bell, so
neighbouring bars overlap and the summed curve has no ripple. The Q is rounded to two decimals, and the engine uses
the rounded value, so the table can be copied exactly.

| Bar | Keys | Span | Centre | Q | Merged with the next bar |
|---|---|---|---|---|---|
| A0–A1 | A0 → A1 | 27.5–55 Hz | 38.9 Hz | 0.70 | A0–A2: 55.0 Hz, Q 0.28 |
| A1–A2 | A1 → A2 | 55–110 Hz | 77.8 Hz | 0.70 | A1–A3: 110 Hz, Q 0.28 |
| A2–A3 | A2 → A3 | 110–220 Hz | 155.6 Hz | 0.70 | A2–A4: 220 Hz, Q 0.28 |
| A3–A4 | A3 → A4 | 220–440 Hz | 311.1 Hz | 0.70 | A3–A5: 440 Hz, Q 0.28 |
| A4–A5 | A4 → A5 | 440–880 Hz | 622.3 Hz | 0.70 | A4–A6: 880 Hz, Q 0.28 |
| A5–A6 | A5 → A6 | 880–1760 Hz | 1244.5 Hz | 0.70 | A5–C8: 1919 Hz, Q 0.24 |
| A6–C8 | A6 → C8 | 1.76–4.19 kHz (1.25 oct) | 2714 Hz | 0.54 | n/a |
| Air | above C8 | 4.3–20 kHz | 9 kHz | high shelf, S 1 | never merges |

- Each centre lands on an E♭ key (38.9 Hz is E♭1, 77.8 Hz is E♭2, and so on), which makes the bars easy to find.
- The span is from A key centre to A key centre, so each A key is shared by two bars.
- Merged bars can't overlap: a bar that is already part of a pair can't join another one.
- A merged pair's gain lives on its lower bar. The upper bar sits at an identity 0 dB.
- Web Audio shelves ignore Q (they use S = 1), which is why Air says "S 1".

**Bringing an EQ over.** Paste into the box and click **Fit to octaves**. It accepts EqualizerAPO/REW lines
(`Filter 1: ON PK Fc 250 Hz Gain -3 dB Q 1.41`, `HSC`/`LSC`, `HP`/`LP`, `notch`), free text
(`PK 250 Hz Q 1.4 −3 dB`, `HS 8 kHz +2 dB`, `2 oct` as a bandwidth) and graphic-EQ lists (`31:0, 63:+2, 1k:0, …`,
which get Q 1.41 each). It skips `Preamp` and says so.

The foreign curve is sampled at 180 log-spaced points, and the live bars are fitted to it by weighted Gauss–Newton:
6 iterations, a numeric Jacobian and a small ridge. Points where the slot sounds get weight 1; points below its
lowest note get 0.05. The result reports the RMS and worst-case error, and the original curve stays on the plot as a
dashed line.

Example (`eq-pad-fit.png`): a 250 Hz −3 dB bell, an 8 kHz +4 dB shelf and a 3.1 kHz Q 6 −5 dB notch fit with
0.8 dB RMS where the Pad sounds, worst 4.3 dB at 3.15 kHz. The notch is flagged as only approximated, because
octave bars can't make it. **Copy as text** writes the bars back out as `PK 622.3 Hz Q 0.70 +2.0 dB ; A4–A5` lines,
which any parametric EQ accepts.

## Greyed zones: how they're computed

For each MIDI note m on the axis (A0..C8):

```
soundLo = slot.lowNote  + 12·slot.octave   (+ slot.transpose + song transpose in the real app — see below)
soundHi = slot.highNote + 12·slot.octave   (+ same)
status(m) = m < soundLo                      → 'below'      never sounds; nothing to EQ
          | m > soundHi                      → 'over'       no fundamentals, but the played notes' overtones are here
          | inst sampled and m ∉ [iLo, iHi]  → 'stretched'  still plays: the sampler repitches the nearest sample
          | otherwise                        → 'plays'
```

`[iLo, iHi]` is the lowest and highest note across all of the instrument's manifest layers: A0–C8 for Salamander,
C1–G7 for the Rhodes. Synths and the organ have no limit. A bar takes the most "alive" status among its keys:

- **`below` means the bar is off.** Its gain is forced to 0 dB, it can't be dragged, and it is drawn as a dashed
  "OFF" box. Its table field is disabled with a "no notes" chip.
- **`over` means "overtones only".** The bar is hatched and dimmer, but it stays editable.
- **`plays` covers any key that plays or is stretched.**

**Where this departs from the brief ("bars over greyed key ranges are disabled"), and why:**

1. **Only bars *below* the range are disabled.** A bass note's energy runs from its fundamental up through several
   kHz of overtones. `eq-bass-smooth.png` shows the Bass analyser full of partials above B2. Disabling every bar above
   the Bass range would remove the most common bass move, cutting 1–3 kHz clank. So those bars stay live and are
   labelled for what they are.
2. **A bar that overlaps the range at all stays live, even if most of it is greyed.**
3. **An off bar is forced to 0 dB, not just locked in the UI.** A Q 0.7 bell reaches about ±1 octave. A +12 dB bar at
   A1–A2 over a Keys slot that starts at C3 would still lift C3 by several dB. The stored value is kept, so widening
   the range brings it back.
4. **Stretched keys are not greyed**, because they really do play. They are hatched, and the hover text says
   "stretched sample".

## Proposed parameter model (for `shared/params.js`)

Add these rows after the existing slot EQ. All of them are optional and stay absent until set, per the SCHEMA 1
convention, and the store and controller pick them up without changes.

```js
// octave EQ (design/eq/octaves): 7 peaking bars A0–A1 … A6–C8 at fixed f0/Q (EQ_BANDS) + an air shelf, dB
num('slots.<i>.eq.oct0', -12, 12, 0, 'dB', 'lin', 'A0–A1'),   // … oct1 … oct6 ('A6–C8')
num('slots.<i>.eq.air',  -12, 12, 0, 'dB', 'lin', 'Air'),
bool('slots.<i>.eq.join0', false, 'Join A0–A1 + A1–A2'),       // … join5: bar k+1 folds into bar k (2-octave band)
```

- **Fixed f0/Q live in a pure table**, `shared/eq-bands.js`, as `EQ_BANDS` with `{lo, hi, f0, q}`, plus the merged
  f0/Q and `bandStatus(cfg, songTranspose, instRange)`. The UI and the engine then compute the same greyed set.
  Storing f0 and Q per song would only make migration and MIDI-learn harder.
- **Joins as 6 bools**, rather than a bitmask or an enum. That keeps every row a plain PARAMS type and learnable.
  Conflicting joins (k and k+1 both set) resolve with the lower k winning, in `eq-bands.js`, so the store never needs
  cross-field validation.
- **The existing `eq.low` (shelf at 120 Hz) and `eq.high` (shelf at 6 kHz) stay** as the quick "Lows/Highs" knobs, so
  current songs don't change. The editor could offer a "fold Lows/Highs into the bars" action: fit them with the same
  fitter and zero the knobs. That's an explicit user action, not a migration.
- The master EQ (`fx.eq.*`) is untouched.

## Engine changes this implies

1. **`fx.js` `Channel`**: 8 more biquads (7 peaking + 1 high shelf) after `eqHigh`, giving
   `eqLow → eqHigh → oct0…oct6 → air → pan`. At 0 dB a peaking biquad is exactly identity (b = a), so default songs
   render the same as today to float precision. `nodeCount` goes from 16 to 24 per slot, 32 more biquads across four
   slots. I haven't measured the CPU cost; it should be small next to the samplers.
2. **`Channel.setOctEq(gainsDb[8], joins[6], activeMask[8], when, step)`**. Gains, and the frequency/Q of a joined
   pair, move with `rampTo(…, TAU)` from `shared/automation.js`, never with direct AudioParam calls (CLAUDE.md). A
   join toggle glides f0 and Q rather than stepping them, which avoids a click. Masked bars ramp to 0 dB.
3. **`audio.js` `setParam`**: `slots.i.eq.oct<k>`, `eq.air` and `eq.join<k>` go to `setOctEq`. The active mask must be
   recomputed whenever something moves the sounding range or the sample range: `lowNote`, `highNote`, `octave`,
   `transpose`, the global song transpose, or an instrument swap. The instrument range is min/max over the sampler's
   layers, or `null` for synths and organ.

   The prototype ignores `slot.transpose` and the song transpose. The real UI must include them: a song in D shifts
   every greyed boundary by 2 semitones.
4. **Analyser taps for the editor**: `engine.slotAnalysers(i)` creates, on demand, two AnalyserNodes
   (fftSize 16384) tapped at `wOut` (pre-EQ) and at the input to `pan` (post-EQ). The editor gets them through the
   controller, since views never touch the engine, and they are disconnected when the editor closes, so there is no
   FFT cost on stage.
5. **Audition**: `controller.auditionNote(slot, soundingMidi)` → `engine.auditionNote(i, n, {when})`. It plays one
   slot's instrument at a sounding pitch, bypassing the split. That's what clicking a key in the editor needs.

For the UI, the editor would sit under the slot's **More → Tone** group as a "Tone map" sheet, reusing `keyLayout()`
geometry from `views/components/keys.js`. That needs a variant with equal semitones, since today's `keyLayout()` has
equal white keys, which doesn't fit a frequency axis.

## Limits and open questions

- **Verified in headless Chromium only:** screenshots, drag, Alt-merge, fit, no console errors. The analyser traces
  in the PNGs are real Web Audio output from the Salamander samples, but nobody has listened to the audio on speakers
  yet.
- The prototype uses one velocity layer and no sustain pedal, release samples or gain calibration beyond the
  manifest's `gainTrim`. It's for hearing the EQ, not the instrument.
- Q 0.70 bars can't make narrow notches (Q > 3) or steep cuts. The fitter says so. Surgical moves stay in a real
  parametric EQ; that's what the Hz/Q table is for.
- The air zone's squeeze factor (11 units for 2.2 octaves) is a taste call. It keeps the piano at about 89% of the
  width.
- Open: should the Air shelf follow the slot, starting an octave above its top note, instead of sitting at a fixed
  9 kHz? A fixed frequency is easier to transfer, so I kept it.
