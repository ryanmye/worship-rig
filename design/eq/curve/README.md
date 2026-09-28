# Slot EQ prototype: "curve"

This is a parametric EQ drawn over a piano keyboard. It has four draggable bands: a low shelf, two bells and a high
shelf. The x-axis is the keyboard itself, with the Hz scale on the same axis, so a setting copied from another EQ can
be typed straight in. Keys the slot never plays are greyed out. Nothing under `app/` was changed.

## Run it

```sh
python3 -m http.server 8460 --directory /home/claude/worship-rig
# open http://127.0.0.1:8460/design/eq/curve/index.html
node design/eq/curve/shoot.mjs http://127.0.0.1:8460   # regenerates the PNGs; also checks the curve against Chromium
```

The page fetches `/app/samples/manifest.json` and the real MP3s: Salamander `v9` for Keys and Bass, Rhodes for
Extra. Pad has no samples in the repo, so it is a small stand-in synth pad (two detuned saws and a triangle). Serve
the repo root, not `app/`.

Files:

| File | What it shows |
|---|---|
| `eq.png` | 1440×900, Keys slot, hovering band 3 |
| `eq-1024.png` | 1024×700, Bass slot with the "Cut mud (Bass)" preset |
| `story-1.png` | Storyboard: band 3 is grabbed at A6 (0 dB), and the analyser shows the dry chord |
| `story-2.png` | Storyboard: band 3 is dragged to A5 at +9 dB. The partials of the D-major chord between C5 and F#6 now rise above the dry outline (orange = lifted), and the keys under the band are tinted with a bracket over them |
| `story-3.png` | Storyboard: band 3 is dragged on past C8 to 10 kHz. The handle turns dashed and gets an "overtones only" tag, the table row says the same, and the analyser barely moves because the piano has almost nothing up there |

## Concept

- **The axis is the keyboard, and the keyboard is pitch-true.** Every semitone has the same width
  (log-frequency), and each key sits centred on its own fundamental. White keys are 1.5 or 2 semitones wide depending
  on their neighbours. Black keys are 0.92 semitone wide, which works out to about 0.54 of an average white key, close
  to a real piano. So "that key" and "that frequency" line up exactly.
  - Keys zone: A0 (27.5 Hz) to C8 (4186 Hz), 88 units.
  - Compressed zones on each side: "sub" (20–27 Hz, ×0.5) and "air" (4.2–20 kHz, ×0.42). A high shelf or an air band
    still has somewhere to live, but those zones don't eat the keyboard's width.
  - One mapping, `uOfF` / `fOfU`, drives the curve, the analyser, the Hz ruler, the keyboard and hit-testing.
- **Hz stays visible for transfer:**
  - The ruler under the graph marks 20, 50, 100 Hz, 200, 500, 1 kHz, 2k, 5k, 10k and 20k, plus 440.
  - The hover readout gives a note, its Hz and the curve's dB at the cursor.
  - Each table row shows Note ("A3 · 220 Hz", or "≈B3 +21¢ · 250 Hz" when a frequency falls between keys), Hz, Gain
    dB and Q. All of them can be edited.
  - The Hz field accepts `250`, `1.2k`, `1k2` or `3.5 kHz`. The Note field accepts `F#2`, `Bb4` or plain Hz. The Q
    field accepts a Q, or a bandwidth such as `1 oct` (converted with Q = 1 / (2·sinh(ln2/2 · BW))).
  - "Copy as text" exports the four bands.
- **Interaction:**
  - Drag a numbered dot: sideways sets the note, up and down sets boost or cut. Frequency snaps to the nearest key, or
    to ISO third-octaves in the sub and air zones. Gain snaps to 0.5 dB.
  - Hold ⌥ or Shift for no snapping (0.1 dB steps, any Hz).
  - Width (Q), in any of three ways: the mouse wheel over or near the dot; a trackpad pinch (ctrl+wheel, where
    spreading = wider); or dragging the two side tabs at the band's half-gain points.
  - Width is also shown on the keys. Keys under the selected band are tinted by how much it changes each note's
    fundamental (orange = boost, blue = cut), with a white bracket over the half-gain span.
  - Double-click a dot for 0 dB.
  - Keyboard: arrows move by a semitone or 0.5 dB, `[` and `]` change width, `1`–`4` pick a band, `B` does A/B, and
    Space plays the loop.
- **Analyser:** a pre-EQ and a post-EQ `AnalyserNode` (FFT 16384) are drawn on the same keyboard axis.
  - The dry sound is a light outline.
  - What you hear is a tinted fill.
  - Wherever the two differ by more than 1 dB, the gap is stroked, orange for lifted and blue for cut. That makes the
    EQ's effect on real piano partials readable at a glance, and it is what the storyboard shows.
  - Small triangles on the ruler and yellow keys mark the notes that are sounding.
- **Greyed zones**, two kinds (the Hz scale stays underneath both):
  - Below the lowest note the slot can sound, the area is hatched: "Keys doesn't play here: no notes to shape, only
    rumble". The analyser really does show low-level rumble there, so the label doesn't claim silence.
  - Above the highest note, a grey veil marks "Overtones only". The EQ still acts there, but on the tone colour of
    lower notes, not on notes of its own.
  - Greyed keys are hatched, and clicking one gives a toast ("Keys doesn't play C2 · its notes are C3–C8") instead of
    a sound.
- **Band hints** in the "Acts on" column and on the dot:
  - `Boost/Cut notes F#3–C5 (+ overtones)`
  - `Overtones only: above top note B2`
  - `No effect: below lowest note`
  - `Flat`

  A band that falls entirely in a grey zone gets a dashed ring and a tag on the graph. The Bass/"Cut mud" screenshot is
  a good example: for a bass played A0–B2, a 250 Hz cut is overtones only. That is correct and useful to know, and it
  is not a warning.
- **Presets** ("Start from" in the header): Flat, Warm, Air and Cut mud (Bass). They apply to the current slot.
- **A/B**: "A · EQ on" and "B · Bypass" do a 12 ms crossfade between the EQ chain and a dry path. While bypassed, the
  curve turns grey and dashed.

## How greyed zones are computed

This belongs in `shared/` as a pure function, e.g. `soundingRange(slot, inst, controller, songTranspose)`:

```
shift    = 12·slot.octave + slot.transpose + songTranspose        // same as audio.js:1151 (sn = n + …)
physical = [max(controller.lo, slot.lowNote), min(controller.hi, slot.highNote)]   // the split is on the physical note
sounding = [max(physical.lo + shift, inst.range.lo), min(physical.hi + shift, inst.range.hi)]
fLo = midiF(sounding.lo − ½), fHi = midiF(sounding.hi + ½)
silent zone   = [20 Hz, fLo)      overtones zone = (fHi, 20 kHz]
```

- `controller` is the keyboard you play. The prototype assumes 88 keys (A0–C8). The real feature could learn the
  lowest and highest notes it has seen per MIDI input, or add a Settings row ("61 / 73 / 76 / 88 keys").
- `inst.range` should come from `engine.listInstruments()`, which needs a new `range: [lo, hi]` field:
  - Samplers (factory and My Samples): the union of all layers' sampled notes in the manifest. That is A0–C8 for most
    instruments and C1–G7 for Rhodes.
  - Synth, organ and drone: [0, 127], or a patch-declared range.
- **Caveat, and a decision to make:** `SamplerInstrument.nearest()` repitches without limit. In the current engine,
  Rhodes G#7–C8 *does* sound, as G7 stretched up. The prototype greys it out ("Rhodes samples stop at G7"). Either:
  - grey only by split and controller, and use the sampled range just for a softer hint; or
  - add `range` to the manifest and enforce it in `noteOn`, which I'd recommend for pitched factory packs.
- Band reach: sample the band's own response on 400 log points from 20 Hz to 20 kHz, and keep the frequencies where
  `|dB| ≥ max(0.5, 0.3·|gain|)`. Then:
  - `max < fLo`: no effect
  - `min > fHi`: overtones only
  - anything else: the notes inside the reach, clamped to `sounding`

  The response math is RBJ with Web Audio's conventions: linear Q for peaking, and S = 1 for shelves, where Web Audio
  ignores Q. `shoot.mjs` checks it against `BiquadFilterNode.getFrequencyResponse`: max error 0.0000 dB.

## Proposed param model

These are flat scalar rows in `PARAMS`, so the store, controller and MIDI-learn keep working unchanged
(CLAUDE.md: "add the row and implement it in `engine.setParam`"). k = 0..3:

| Path | Range / default | Unit, taper |
|---|---|---|
| `slots.<i>.eq.b<k>.type` | enum `lowshelf \| peaking \| highshelf`; defaults `lowshelf, peaking, peaking, highshelf` | enum |
| `slots.<i>.eq.b<k>.freq` | 20–20000; defaults **120**, 400, 2500, **6000** | `Hz`, `log` |
| `slots.<i>.eq.b<k>.gain` | −12…+12, default 0 | `dB`, `lin` |
| `slots.<i>.eq.b<k>.q` | 0.3–10, default 1 (ignored for shelves) | `lin`, `log` |
| `slots.<i>.eq.b<k>.on` | bool, default true | bool |

- **Migration** (`migrate()` stays idempotent and keeps unknown fields):
  - `eq.low` → `eq.b0.gain`, since b0 defaults to a 120 Hz low shelf, which is today's `eqLow`.
  - `eq.high` → `eq.b3.gain`, since b3 is the 6 kHz high shelf, today's `eqHigh`.
  - The two bells default to 0 dB, so every existing song sounds bit-for-bit the same (a 0 dB peaking biquad is the
    identity).
  - Keep `eq.low` and `eq.high` as accepted aliases in `setParam` for one release, for MIDI mappings and older backups.
- Field stays optional (absent until set), like today's `slot.eq`.
- The Edit summary chip ("Tone EQ" at edit.js:1219) should read any band with `|gain| ≥ 0.05` and `on`.

## Engine changes (fx.js SlotStrip, audio.js setParam)

- `SlotStrip`: replace `eqLow` and `eqHigh` with `this.eq = [4 × BiquadFilterNode]`, chained
  `wOut → eq0 → eq1 → eq2 → eq3 → pan`.
  - `setEqBand(k, {type, freq, gain, q, on}, when, step)` does the following:
    - Gain: `rampTo` (or `setNow` when `step`), using `on ? gain : 0`.
    - Frequency: `glideFrom` / `glideTo` with `{from}`, since exponential behaves better for Hz.
    - Q: `rampTo`.
  - **Type change** is an instant switch on the node, which clicks. Ramp that band's gain to 0 over about 15 ms, switch
    `type` inside `engine.at(when + 0.015, …)`, then ramp back. There are no `setTimeout`s, so offline renders stay
    deterministic.
- `audio.js setParam`: extend the `rest[0] === 'eq'` branch to `eq.b<k>.<field>` and coalesce per band.
  - Keep the `low`/`high` alias branch.
  - `getParam` mirrors it.
  - Song load (`s.setEq(cfg.eq…)` at audio.js:613/618) becomes a loop over the four bands with `step = true`.
- Cost: 16 biquads across the 4 slots instead of 8, which is negligible.
- **Analyser for the real UI:** add an optional per-slot `AnalyserNode` tap before and after the EQ, created only
  while the EQ editor is open, and exposed through `controller.*`. Views never touch the engine.
- **Log it:** a `## slot-eq-4band` section in `CONTRACT_CHANGES.md` covering the new rows, the migration, and the
  bit-exact check. Render a song offline with `eq.low = 3` before and after the change; the diff should be ≈1e-6
  (the Chromium summing-order tolerance).
- The master EQ (`fx.eq.*`) can reuse the same editor. Its greyed zone is the union of all active slots' sounding
  ranges.

## Known limits of the prototype

- Shelves have a fixed slope. Web Audio's shelving biquad ignores Q, so shelf Q/slope from another EQ can't be carried
  over (the field shows "—"). Supporting it would need an `IIRFilterNode` (not automatable, so crossfade on change) or
  a worklet.
- The slot data is a mock of one song: Keys split C3+, Pad on every key, Extra = Rhodes C4+, Bass left hand to B3 one
  octave down.
- The `AudioContext` is created at 48 kHz so the drawn curve matches the audio exactly. At 44.1 kHz the air zone
  differs by a fraction of a dB near 20 kHz.
- The prototype sets `AudioParam`s with `setTargetAtTime` directly. The real code must use `shared/automation.js`.
