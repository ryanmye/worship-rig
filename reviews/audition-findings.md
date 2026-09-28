# Audition findings (tools/calibrate.mjs + tools/audition.mjs)

These findings are for the ui, integration, samples, engine and presets owners. The data behind them is in
`audition/report.json`, `audition/calibration.json` and `audition/index.html` (the players, numbers and badges). To
regenerate everything, run `node tools/calibrate.mjs && node tools/audition.mjs`. That takes about 2 + 5 min in
headless Chromium. `--only slug,slug` re-renders only those clips and merges them into the existing report.

Status of each finding:
- **CONFIRMED** = measured.
- **SUSPECTED** = mechanism found in the code, not measured.

The audition renders with the calibrated trims. Synth/organ trims and `droneTrim` go through a render shim until
`gain-trims.json` is wired into the engine (CONTRACT_CHANGES.md "## audition" #1).

## Result: 20 PASS · 3 WARN · 6 FAIL (29 clips, 87.8 MB)

None of the failures can be fixed by calibration. Each one traces to a sample file, an instrument, or a preset value.

| clip | status | RMS 0.5–8 s | peak | mono loss | DC | mono-render peak | cause |
|---|---|---|---|---|---|---|---|
| sunday-pad-piano | WARN | −22.2 | −2.55 | 2.52 | −5e-5 | −3.07 | drone −20.5 dB under the mix (P3) |
| building-swell | PASS | −23.4 | −9.25 | 0.99 | ~0 | −7.3 | |
| prayer-wash | PASS | −24.8 | −11.23 | 1.49 | ~0 | −9.67 | drone −14.8 dB under the mix, faint (P3) |
| organ-swell | PASS | −21.6 | −9.14 | 0.50 | −7e-5 | −7.86 | pad −10.7 dB under the organ (P4) |
| grand-piano | **FAIL** | −22.1 | −2.47 | **3.06** | −5e-5 | −3.09 | Salamander stereo phase (S4) |
| rhodes | PASS | −21.2 | −6.86 | 0.56 | −1e-4 | −4.9 | |
| felt-piano | **FAIL** | **−14.2** | −0.87 | **3.18** | −9e-5 | +0.27 | velocityCurve "soft" (P1), plus S4 and C2 |
| lofi-rhodes | PASS | −23.5 | −10.34 | 0.30 | ~0 | −7.77 | the lofi HPF hides E1 |
| dusty-piano | **FAIL** | −18.9 | −7.47 | **3.49** | ~0 | −5.82 | S4 (and P2) |
| glass-ocean | PASS | −24.9 | −10.99 | 1.00 | ~0 | −9.24 | |
| sub-shimmer | WARN | −23.5 | −12.88 | 0.25 | ~0 | −10.43 | drone −18.8 dB under the mix (P3), pad plays the bass note (P5) |
| synth-warm-pad | PASS | −23.4 | −9.03 | 1.08 | ~0 | −8.05 | |
| synth-glass-pad | PASS | −23.9 | −12.41 | 0.89 | ~0 | −10.63 | |
| synth-strings | PASS | −23.8 | −9.62 | 1.04 | ~0 | −8.57 | |
| synth-sub-bass | PASS | −25.3 | −19.04 | 0.00 | ~0 | −16.03 | |
| synth-soft-keys | **FAIL** | −23.5 | −12.45 | 0.29 | **−0.0185** | −11.52 | 1:1 FM DC (E1) |
| synth-bell | PASS | −25.2 | −10.29 | 0.18 | ~0 | −7.38 | |
| synth-drone-osc | PASS | −25.7 | −10.9 | 1.09 | ~0 | −8.73 | |
| organ-gospel | PASS | −21.2 | −8.26 | 0.55 | −8e-5 | −6.18 | |
| organ-soft-pad | PASS | −20.9 | −8.75 | 0.63 | ~0 | −6.6 | |
| organ-full | PASS | −23.8 | −11.58 | 1.31 | −9e-5 | −9.29 | |
| organ-church | PASS | −19.0 | −7.1 | 0.12 | ~0 | −4.47 | |
| sampler-salamander-piano | PASS | −22.5 | −2.71 | 2.88 | −5e-5 | −3.34 | S4 (just under 3 dB) |
| sampler-ep-rhodes | PASS | −21.9 | −8.34 | 0.26 | −8e-5 | −5.45 | 8 dead keys at the extremes (S3) |
| sampler-ep-wurli | PASS | −23.5 | −7.66 | 0.42 | 3e-4 | −5.0 | |
| sampler-vibes | **FAIL** | −17.9 | −1.59 | 0.28 | **0.00145** | **+1.25** | sample DC × a +27 dB trim (S2), C2 |
| sampler-celesta | WARN | −20.9 | −3.18 | 0.25 | ~0 | −0.18 | C2 |
| sampler-music-box | **FAIL** | −21.1 | −0.98 | 0.22 | **0.00664** | **+2.03** | sample DC × a +30 dB trim (S2), C2 |
| sampler-nylon-guitar | PASS | −24.4 | −3.75 | 0.24 | −3e-4 | −0.77 | |

The click detector reported 0 events on every clip. It self-tests on each run and passed. It is skipped for the two
lofi songs, which have deliberate crackle. No clip had NaN/Inf samples, a silent chord or a drop-out.

## Calibration (final trims, dB)

Measurement: C3-E3-G3 at velocity 96, 3 s, slot gain 1, sends 0, lofi 0, master 1.0, band 100 Hz–5 kHz over 0–3 s,
target −18 dBFS. The sub-bass is measured on a single C2 in 40 Hz–5 kHz. The drone is measured in key C at
drone.gain 1 with target −24 dBFS. CONTRACT_CHANGES.md "## audition" #2 explains why this differs from the §12
wording, and `--spec-literal` reproduces the literal spec.

| instrument | as found (trim 0)* | trim | after | peak @ master 1 |
|---|---|---|---|---|
| sampler salamander-piano | −26.3 | **+8.3** | −18.0 | −2.1 |
| sampler ep-rhodes | −33.9 | **+15.9** | −18.0 | −3.5 |
| sampler ep-wurli | −40.1 | **+22.1** | −18.0 | −4.0 |
| sampler vibes | −45.2 | **+27.2** | −18.0 | −2.8 |
| sampler celesta | −42.1 | **+24.1** | −18.0 | −1.7 |
| sampler music-box | −48.6 | **+30.0** (clamped; wants +30.6) | −18.6 | −1.2 |
| sampler nylon-guitar | −42.0 | **+24.0** | −18.0 | −2.2 |
| synth warm-pad | −17.8 | −0.2 | −18.0 | −2.8 |
| synth glass-pad | −17.7 | −0.3 | −18.0 | −5.9 |
| synth strings | −17.9 | −0.1 | −18.0 | −2.9 |
| synth sub-bass (C2) | −22.5 | +4.5 | −18.0 | −14.6 |
| synth soft-keys | −18.6 | +0.6 | −18.0 | −7.8 |
| synth bell | −20.1 | +2.1 | −18.0 | −5.3 |
| synth drone-osc | −20.8 | +2.8 | −18.0 | −2.5 |
| organ gospel | −21.2 | +3.2 | −18.0 | −6.0 |
| organ soft-pad | −19.8 | +1.8 | −18.0 | −7.0 |
| organ full | −17.5 | −0.5 | −18.0 | −6.0 |
| organ church | −23.1 | +5.1 | −18.0 | −4.5 |
| drone (key C, gain 1) | −11.7 | **−12.3** (droneTrim) | −24.0 | −8.2 |

\* "As found" is band RMS with trim 0, taken as −18 − trim. This is exact for everything except the loudest sampler
attacks, where it is within ≈0.3 dB. Under the spec-literal method (0.5–3.0 s window) the first dry run read: piano
−30.3, ep-rhodes −34.9, wurli −41.8, vibes −48.4, celesta −45.2, music-box −50.6, nylon −44.0, pads −17.0…−17.4,
sub-bass (triad) −18.4, soft-keys −19.0, bell −21.5, drone-osc −20.0, organs −17.4…−23.0, drone −14.5.

---

## Findings by owner

### samples

**S1. The MusyngKite files are 20–30 dB below full scale. CONFIRMED.**
ffmpeg `volumedetect` on the C4 files gives these peaks: ep-rhodes −22.7, vibes −26.2, music-box −18.6,
nylon-guitar −22.5 dBFS. Salamander v14/C4 peaks at −1.3.
- Consequence: trims of +16…+30 dB, and music-box hits the widened ±30 clamp. The spec's ±12 clamp leaves these
  instruments 10–16 dB too quiet.
- Fix: gain-normalize each instrument's set as a whole (one gain per instrument, so the balance between notes is
  kept) to about −1 dBFS peak when encoding the MP3. This also improves MP3 SNR. Then re-run `node tools/calibrate.mjs`,
  and the trims fall back inside ±12.

**S2. The MusyngKite files carry DC offset, which the big trims amplify into a hard DC failure. CONFIRMED.**

| file | raw DC | DC/peak | DC in the clip after the trim | check |
|---|---|---|---|---|
| music-box C4 | 4.8e-4 | 2.9e-3 | 0.0066 (after +30 dB) | fails |
| vibes C4 | 8.8e-5 | 1.3e-3 | 0.00145 (after +27 dB) | fails |
| ep-wurli | ~7e-5 | | 3e-4 | passes |

- Fix: remove DC when converting, e.g. ffmpeg `-af highpass=f=10`, before normalizing.
- An alternative is a DC blocker in the sampler (1-pole HPF at ~10 Hz after `tone`), but source files are the right
  place for it.

**S3. ep-rhodes has 8 silent files, so there are dead keys at both ends. CONFIRMED.**
- The files are `A0, Bb0, B0, Ab7, A7, Bb7, B7, C8`. Each is 13,001 bytes and peaks at **−91 dBFS**.
- The manifest lists all 88 notes, so those keys play their own silent sample instead of repitching a neighbour.
- Fix: drop them from the manifest `notes`. Nearest-note repitch then covers the keys. Also make `validate.mjs`
  reject files whose peak is below −60 dBFS.
- The other MusyngKite instruments were checked and have no silent files.

**S4. Some Salamander samples are partly out of phase between L and R. The piano songs fail mono-sum loss because of it. CONFIRMED.**
Mono-sum loss per file (dB; 0 = mono-safe, 3 = uncorrelated, > 3 = anti-phase content):

| notes | v4 / v9 / v14 |
|---|---|
| **C5** | **8.4 / 8.1 / 8.0** |
| A3 | 5.5 / 5.4 / 5.2 |
| A6 | 4.8 / 4.7 / 4.7 |
| Gb3 | 4.3 / 4.2 / 4.2 |
| A4 | 4.1 / 4.1 / 4.2 |
| Eb5–Eb7 | 3.7–5.1 |
| most others | 0.6–2.5 |

- Consequence: on a mono PA or mono DI (REVIEW 3.11), keys mapped to C5 lose about 8 dB and turn comb-filtered.
  C5 is used by B4–Db5.
- The audition's I, vi and IV chords contain C5. Grand Piano measures 3.06 dB, Felt 3.18 and Dusty 3.49, all over
  the 3 dB limit.
- Fix, at conversion: for each file, measure the inter-channel delay and correlation. Time-align where a delay
  explains it. Otherwise reduce the side signal (M/S) until correlation is ≥ 0.3.
- A sampler `width` param would also work, but it can't fix a single note.

### engine-instruments

**E1. soft-keys puts a large, note-synchronous DC offset on its output. CONFIRMED.**
- In a 1:1 FM pair (carrier frequency = modulator frequency, `synth.js:483–488`), the first lower sideband falls
  exactly on **0 Hz**.
- With frequency-modulation (deviation = index·f) the output therefore carries DC while the index is high:
  −0.05…−0.076 (≈ −22 dBFS) in the first 0.5 s after each chord, decaying with the index τ of 0.4 s. The clip
  averages −0.0185.
- Consequences: a sub-audible thump on each note, lost headroom, and asymmetric drive into the soft-sat `tanh`.
- Lofi Rhodes hides it only because the lofi tilt HPF sits downstream.
- Fix: a DC blocker (biquad HPF at ~20 Hz, Q .707) on `inst.bus` **before** `inst.pre` / the shaper. Then re-run
  calibrate. The trim may move by a few tenths of a dB.

### engine-core

**C1. gain-trims.json has to be wired before the calibration takes effect for synth, organ and drone. CONFIRMED (not wired).**
- The recipe is in CONTRACT_CHANGES.md "## audition" #1.
- Until it's wired, the drone plays **12.3 dB hotter** than calibrated, and synth/organ run at their built-in trims.
  Those come out too quiet by up to 5.1 dB: church organ 5.1, sub-bass 4.5, gospel 3.2.
- Sampler trims are live already, through manifest `gainTrim`.

**C2. Mono mode sums after the clip stage, so it clips. CONFIRMED.**
- This corroborates reviews/engine-core.md #5.
- Mono render peaks: music-box **+2.03 dBFS**, vibes **+1.25**, felt-piano **+0.27**, celesta −0.18. Their stereo
  peaks are ≤ −0.87.
- Centred content comes out at 1.414× the ceiling. Move the mono sum ahead of comp → clip.

### presets (presets.js)

**P1. Felt Piano: velocityCurve "soft" is backwards for a felt sound. CONFIRMED.**
- The engine's `soft` curve is v^0.6. It *raises* velocities: 96 → 107, which selects the top Salamander layer
  (97–127), the brightest and loudest one.
- The clip measures **−14.2 dBFS RMS**, over the −16 limit. It peaks at −0.87 and its mono render at +0.27.
- Same song and seed with only the curve changed: **"normal" −20.0 dBFS**, **"hard" −21.2 dBFS** (hard: 96 → 81,
  middle layer).
- Recommend `velocityCurve: 'hard'`. The alternative is 'normal' with the slot gain at about 0.7.

**P2. Dusty Piano: same "soft" curve. CONFIRMED.**
- It is in range (−18.9 dBFS) but the hottest non-organ song, and the top layer contradicts the "warm, narrow tone"
  in its notes.
- Recommend `'normal'`.

**P3. The key drone is inaudible or faint in all three drone songs once droneTrim is applied. CONFIRMED (layer solo renders).**

| song | drone.gain | drone solo vs the mix |
|---|---|---|
| Sunday Pad + Piano | 0.35 | **−20.5 dB** |
| Sub + Shimmer | 0.30 | **−18.8 dB** |
| Prayer Wash | 0.45 | −14.8 dB |

- With the calibration, the drone at drone.gain 1.0 sits 6 dB under a single instrument at unity. Preset gains of
  .3–.45 (−7…−10.5 dB) bury it.
- The presets were probably balanced against the *untrimmed* drone, which is 12.3 dB hotter.
- Recommend drone.gain ≈ 1.0 in those three songs. Computed from the solo levels, that lands at about −11 / −8 / −8 dB
  under the mix: an underlay you can still hear.
- The other option is a different drone target in calibrate (`--drone-target`). That's a product call, not a bug.
- Also consider the PARAMS default `drone.gain` (−6 dB) for new songs.

**P4. Organ Swell: the pad sits 10.7 dB under the organ at wheel 0.7. CONFIRMED.**
- At wheel 1.0 it would be about −7.6 dB (computed: +3.1 dB, not rendered).
- The notes say "a warm pad behind it". It's barely there unless the wheel is full.
- If it should be heard, raise the pad gain from .45 to about .6.
- For comparison, Sunday Pad + Piano's pad sits −8.1 dB under the piano, which is fine.

**P5. Sub + Shimmer: the glass pad also plays the left-hand bass note. CONFIRMED (lint + render).**
- The pad's `lowNote` is 0, so the C2-range bass note that the sub plays (the Bass slot is mono `lowest` with
  highNote 59, so it never plays chords) also sounds on the glass pad, adding a 65–100 Hz pad note under the sub.
  74 % of the mix's power is below 120 Hz. Most of that is the sub itself; the pad's share was not isolated.
- If a cleaner split is wanted, set the pad `lowNote: 48`. The notes text says "glass pad over the whole keyboard",
  so this is a judgment call.

**P6. Info.** Every factory song has playIn = hearIn = C, so no factory song exercises Easy Transpose. The audition
plays in each song's Hear-In key, so the transposed path is untested here. The engine suite covers it.

### ui / integration

- `audition/` is git-ignored, and the orchestrator ships the pack to Ryan from there. `index.html` is
  self-contained (inline CSS, no scripts). The `<audio>` players use relative `*.wav` paths, so the folder has to
  travel whole.
- Renders are deterministic to max |Δ| ≈ 3e-6 between runs, which is < 0.1 LSB at 16 bit. The WAV bytes can still
  differ at rounding boundaries (Chromium sums node inputs in hash order).
- After C1 is wired, the tools detect `registry.gainTrims` and drop their shim by themselves. Re-running
  `node tools/audition.mjs` then verifies the real wiring. The numbers should match this report to ±0.1 dB.
- After S1/S2/E1 are fixed, re-run `node tools/calibrate.mjs` first, then the audition.
