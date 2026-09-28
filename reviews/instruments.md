# Review: engine-instruments (voice.js, synth.js, organ.js)

Reviewer focus: synth DSP and Web Audio. Scope is `app/js/engine/voice.js`, `synth.js` and `organ.js`, checked against SPEC §2 and §3.2–3.4, REVIEW §3 and CONTRACT_CHANGES.
Skipped, because the fixups agent owns them: the strings delayed-vibrato onset and the `shared/automation.js` anchoring.

Baseline: `node test/phase1/instruments/run.mjs` gives **111/111 PASS**.
Every measurement below comes from seeded `OfflineAudioContext` renders in headless Chromium, run through Playwright. The scratch harness is at
`/tmp/claude-0/-home-claude/7e62a35d-8374-53c8-b5e9-fdad80c27279/scratchpad/review-instruments/` (`node run.mjs <experiment>…`, experiments are in `exp.js`).
CONFIRMED means a render or an API measurement reproduces the problem. SUSPECTED means it is reasoned from code or DSP and was not measured end to end.
Perf numbers are noisy because the box has 2 cores and a load average of about 5 from other agents.

---

## Findings

### MAJOR

**M1. Organ percussion fires on only one note of a chord.** `organ.js:210` · CONFIRMED
`if (this.params.percussion && !this.alloc.anyHeld(v))` is evaluated separately for each note-on. Notes of a chord arrive one after another, even when they share the same `when`. So the first note gets the 2⅔′ "pop" and every other note of the chord finds a held voice and gets nothing.
Render (gospel, rotary off, click 0, notes C4/E4/A4, level at 3f from 60 to 250 ms):

| chord spread | C4 3f | E4 3f | A4 3f |
|---|---|---|---|
| 0 ms (same `when`) | −29.5 dB | −80.5 dB (= no perc) | −82.1 dB |
| 5 ms (MIDI roll) | −29.5 dB | −77.5 dB | −77.1 dB |

On a Hammond, one shared percussion envelope is armed when all keys are up. Every key struck during its decay gets the percussion at the envelope's current level, so a struck chord pops on every note.
This is the defining sound of the `gospel` preset. It also interacts with the sustain pedal: a pedal-held voice stays `'held'`, so with the pedal down percussion never re-arms. Organ slots in the Keys role default to `sustain:true`.
*Fix:* use an instrument-level percussion envelope. On a note-on, if no voice is `'held'` **or** the last trigger was less than about 1.5 s ago, give the note's perc osc gain `0.9·exp(−(t−tTrig)/0.2)` and let it decay on the same τ. Only a note-on with no held keys re-arms `tTrig = t`.
Separately, organ slots probably want `sustain:false` by default. That belongs to shell/engine.

**M2. The engine's first `morph(0)` turns the gospel/fast rotary to slow.** `organ.js:279–283` (interacts with `audio.js:768–777`) · CONFIRMED
`audio.js` never initialises `sc.morph`. The first `_applyWheels` after a commit therefore calls `inst.morph(0, t)` on every slot. `OrganInstrument._morph` maps x ≤ .5 to `'slow'`, whatever the preset's `rotary` param says.
Real engine render (the `gospel` preset, `rotary:'fast'`, is committed and one note is played): the spy shows `_morph(0)` at t = 0 with `rotarySpeed` going from `fast` to slow, and the output's dominant AM rate is **1.6 Hz** where about 6–7 Hz is expected.
Every other patch's morph is additive, so morph 0 is neutral for them. The organ's is absolute.
*Fix (organ side):* treat morph as a speed toggle relative to the param. For example `const base = this.params.rotary; const s = x > 0.5 ? (base === 'fast' ? 'slow' : 'fast') : base;`, which keeps Leslie-switch semantics. If only "morph → fast" is wanted, use `x > .5 ? 'fast' : base`. engine-core should also initialise `sc.morph = 0` so a no-op morph isn't sent.

**M3. The Bell aliases badly in the top octave and at high index.** `synth.js:534–538` · CONFIRMED
The deviation is `index·(0.6+0.4·vel)·r·f`, with no limit relative to Nyquist. At C7 with morph 1 (r = 5.1) the carrier's instantaneous frequency reaches about 23.4 kHz: it is clamped by Chromium and folds.
Each 44.1 kHz render was compared with a 176.4 kHz reference; the figure is the energy that the reference does not explain:

| note / setting | alias energy re total | loudest alias |
|---|---|---|
| C6 (84), morph 1 | −41.6 dB | 18.5 kHz |
| E6 (88), morph 1 | −27 dB | 15.9 kHz |
| G6 (91), morph 1 | −17.4 dB | 18.5 kHz |
| A6 (93), morph 1 | −14.9 dB | 15.4 kHz |
| C7 (96), morph 0 | −26.7 dB | 12.7 kHz |
| **C7 (96), morph 1** | **−7.5 dB** | **689 Hz, only 5 dB below the 2093 Hz carrier** (an inharmonic growl) |
| C6, index 6 (param max) | −15.1 dB | 13.8 kHz |

*Fix:* limit the index per note so that `f + (I+1)·f_m ≤ ~0.42·sr`, i.e. `I_eff = min(I, max(0, (0.42·sr − f)/(r·f) − 1))`. Or add a keytracked index (`× keytrack(note, 72, −1)` above C5), which also sounds more natural. Apply the same limit in `retune()` (see m6).

### MINOR

**m1. Web Audio lowpass/highpass `Q` is in dB, so none of the "Butterworth" filters are Butterworth.** `synth.js:196–197, 247, 249, 317, 369, 408, 599`; `organ.js:145–146` · CONFIRMED (`getFrequencyResponse`)
For `lowpass` and `highpass` the spec defines Q as a resonance in **dB** (bandpass/peaking Q is linear). Measured:
- `lowpass Q .707` at fc: **+0.7 dB**. A Butterworth filter is −3.0 dB at fc.
- `lpfPair` (Q .54 then 1.31) at 1.8 kHz: **+1.8 dB at fc and a +3.8 dB bump at 1.39 kHz**, not maximally flat. This colours warm-pad, strings and drone, and makes the filter LFO sweep read as a gentle wah.
- The warm-pad `resonance` knob at 1 (Q 6.01) peaks at only **+7.5 dB**. The knob is weak.
- The organ rotary crossover (both branches Q .707): the rotary path has a **+3 dB bump at 500–630 Hz** relative to dry (slow and fast measured). With the crossover Q set to −3.01 dB (true Butterworth) the same measurement is within about ±1 dB around the expected AM-centre offset (−1 to −2 dB).

*Fix:* pass Q in dB: `Q = 20·log10(q)`. Butterworth pair: **−5.33 / +2.32**. Single 2-pole Butterworth: **−3.01**. Resonance: e.g. `2.32 + res·16` for a real 0 → +18 dB range. Glass LPF Q .6 → −4.4. Re-run `tools/calibrate.mjs` afterwards, since levels move by about 1–2 dB.
The same mistake is visible in `fx.js:338–339, 516–517, 765–766` and `sampler.js:227, 309` (out of scope, FYI to engine-core).

**m2. The instrument-level WaveShaper oversampling adds latency to the two most latency-critical instruments.** `synth.js:458` (soft-keys 4x), `organ.js:114` (4x), `synth.js:406` (sub-bass 2x) · CONFIRMED
Measured note-onset delay: organ `4x` **193 frames (4.4 ms)**, `2x` 129, `none` 1. Soft-keys is about 190 frames. Sub-bass is 131 frames (3.0 ms). Bell (no shaper) is 1 frame.
engine-core removed 4x from the master clip for exactly this reason (CONTRACT_CHANGES engine-core #1).
The oversampling is not buying anything on these instruments. Aliasing was measured on octave stacks, where every legitimate product lands on a harmonic grid and aliases are off-grid:
- Soft-keys (3 notes, drive .3 or 1): `none` ≡ `4x`, both −122 dB or lower off-grid.
- Sub-bass (drive 1): `none` ≡ `2x`, no alias detectable against a 176.4 kHz reference.
- Organ gospel (drive .35): `none` ≡ `4x`.
- Organ `full` at drive 1: `none` leaves aliases at −29 dB re f0 (at 18–19.5 kHz), `2x` leaves −69 dB, `4x` leaves none.

*Fix:* soft-keys and sub-bass `oversample:'none'`. Organ `'2x'`, or `'none'` while drive < .5 (switching `oversample` live might click, so only switch it on setParam with a 20 ms duck, or simply use `'2x'`).

**m3. Glass-pad 3rd partial is −21 dB, not −14 dB.** `synth.js:111` · CONFIRMED
The triangle's own 3rd harmonic is `−1/9`. Adding `+0.2` partly cancels it, giving `0.089`. Single-oscillator FFT: H2 −6.7 dB, **H3 −21.7 dB** (spec: −14 dB). The intended upper sparkle is 7 dB short.
*Fix:* `sin[3] = -0.2` (|H3| = −14 dB, keeping the triangle's sign). Or `sin[3] -= 0.2` if in-phase reinforcement (−10 dB) is the goal.

**m4. Soft-keys "stereo tremolo" is an equal-power auto-pan, so a mono fold-down has a 9 Hz flutter.** `synth.js:460–463` · CONFIRMED
In a mono input, StereoPanner uses cos and sin gains, so L+R varies with |pan|. At tremolo 1 (depth .9): L is 21.7 dB pk-pk at 4.5 Hz, and **the mono sum is 3.3 dB pk-pk at 9 Hz**. At the default .25 it is negligible (about 0.15 dB).
REVIEW 3.11 says churches often take a mono DI, and morph (bend or macro) pushes depth up to .9. A Suitcase-style tremolo modulates L and R linearly in antiphase, so the mono sum stays constant.
*Fix:* replace the panner with `ChannelSplitter`-less antiphase gains: `gL = 1 − d·(1+lfo)/2`, `gR = 1 − d·(1−lfo)/2`, i.e. two GainNodes fed by the LFO through ±d/2 and a ChannelMerger. The mono sum is then constant (`2 − d`).

**m5. Rotary horn Doppler has the wrong sign relative to the AM.** `organ.js:171` · CONFIRMED
The delay and the AM are driven by the same LFO with the same sign, so the horn is loudest when it is **farthest** (maximum delay). A 5 kHz probe through the fast horn gives rotor 6.8 Hz, deviation ±75 Hz (1.5 %), and the **pitch peak lags the amplitude peak by 91°**. In a real Leslie the pitch peak leads it by 90°: it gets higher and louder together while approaching.
*Fix:* `gain: -ROTARY.hornDelayDepth`. This is a one-character change.

**m6. FM index isn't rescaled on legato or ratio change (Bell, Soft-keys).** `synth.js:548–552` (bell `retune`), `synth.js:506–509` (soft-keys `glide`) and default `glidePitched` for bell · CONFIRMED
The deviation (Hz) stays fixed while f or f_m moves. For Bell C4: index 2.0 becomes **0.69** after legato +12 and morph 1 (−9 dB brightness). An octave-down legato doubles the index, which makes M3 worse.
Soft-keys' `glide` only re-targets m1's final value. The in-flight index during the 0.4 s decay, and the tine, jump by the f ratio.
*Fix:* scale the deviation gain by `f_new·r_new / (f_old·r_old)` at the glide time. Keep `{dev0, t0, target, τ}` in `v.data` so the current value can be computed analytically, then `rampTo`/`setNow` the scaled one.

**m7. "Mono below 150 Hz" (SPEC §3.3 warm-pad, REVIEW 3.11) isn't implemented.** `synth.js:201–210` (sawStack panners) · CONFIRMED
Side energy relative to mid below 150 Hz: warm-pad C2 **−6.5 dB**, G2 −8.1 dB, strings E2 −5.3 dB, drone-osc D2 −14.7 dB.
*Fix (cheap, per instrument, not per voice):* bus → M/S. Splitter → (L−R)/2 → HPF 150 Hz (Q −3.01 dB) → recombine with M. This is about 6 nodes per instrument.

**m8. Peaks above 0 dBFS at the instrument output with stacked sine voices.** `synth.js:532–541` (bell), `organ.js` (all voices phase 0) · CONFIRMED peaks, SUSPECTED downstream pumping
Test chord: 8 notes (C3–E5) at velocity 1. Peaks at the instrument output:

| instrument | 8-note chord peak | 16 voices peak |
|---|---|---|
| **bell** | **+3.6 dBFS** | **+6.3 dBFS** (RMS −18.7) |
| church | — | +3.3 dBFS |
| warm-pad (resonance 1) | +0.7 dBFS | +2.4 dBFS |
| warm-pad (default) | — | +1.7 dBFS |
| strings | — | +1.9 dBFS |
| drone-osc | — | +1.7 dBFS |
| everything else | ≤ −0.2 dBFS | — |

The signal is float until the master, so this isn't clipping. But bell and organ voices all start at sine phase 0, so simultaneous onsets align their peaks. After fader ×1 and master −6 dB, a bell chord lands at about −2.4 dBFS, above the catcher's −3 dB threshold, so the whole mix would duck briefly.
*Fix:* random start phase for the carrier and modulator, and for the organ tonewheel, via a cached 8-rotation sine/drawbar PeriodicWave (the same trick as the saws; `rotatedWaves(ctx,'sine',[0,1])`). Tonewheels are free-running on the real instrument anyway. Keep sub-bass H2 phase-locked to its fundamental: it must use the same rotation index.

**m9. The soft-keys tine gate only checks the tine's own frequency.** `synth.js:491` · CONFIRMED (small)
`fT < 0.45·sr` ignores the sidebands at `f + k·fT`. Off-grid (aliased) peaks relative to the fundamental during the 30 ms tine: C6 default about −36 dB, F6 with tine 2 about **−31 dB**, F5 with tine 2 about −33 dB. They are brief and mostly masked.
*Fix:* taper the tine index to 0 as `f + 2·fT` approaches 0.45·sr.

### NIT

- **n1.** `organ.js:246–264`: a drawbar change swaps the PeriodicWave on sounding voices mid-cycle. A church chord with the 16′ going 8→0 gives an HF burst +4.6 dB over the tone's own HF for about 10 ms, with the largest sample step −60 dB re peak (CONFIRMED). That is a faint tick, comparable to a real drawbar move. It is acceptable. Rebuilding the wave on the main thread measured 0.35 ms.
- **n2.** `synth.js:570` and `122–154`: `randomWalkBuffer` computes 192 k Catmull-Rom samples (768 KB) per drone-osc *instance*, and drone.js builds a new instance on every key change (commit path). The constructor measured **9.1 ms** of main-thread time. That goes against §0.11 in spirit. Cache the buffer per context and let each instance use its own random offset and rate, which it already does.
- **n3.** Soft-keys default drive .3 saturates the polyphonic sum. The distortion residual after best-fit gain: 1 note −33 to −36 dB, **4 notes at velocity .8 −18 dB**, 8 notes at velocity 1 −12 dB with −3.8 dB compression. This is intermodulation between notes, which is grittier than "Soft Keys" suggests. Consider a default of .15. Organ gospel (4 notes, −21 dB) and full (8 notes, −9.6 dB) are idiomatic.
- **n4.** Spec conflict: §2 macro.intensity says "+lerp(0,1800,x)¢ via morph", but warm-pad morph is +2400¢ and strings +1600¢ (§3.3). The engine passes x through, so at full intensity the pad moves 2400¢. Decide which is right.
- **n5.** Allocator steals the oldest-held voice when every voice is held (pedal down). In worship playing that is often the left-hand root pedal point, so the bass of the chord disappears on the 17th note. Consider not stealing the lowest held note, or making the engine release pedal-only voices before physically held ones.
- **n6.** Always-running per-voice nodes at zero level: glass bloom osc (bloom 0), warm-pad/drone sub osc (sub 0), and the organ rotary graph (4 osc, 2 delays, 2 biquads) when `rotary:'off'`. Each is small.
- **n7.** `glassWaves()` allocates and fills a `Float32Array(64)` on every glass note before hitting the cache. Hoist the lookup.

---

## Solid (verified, no change needed)

- **Voice lifecycle.** A voice owns every node. Sources are counted; teardown happens on the last `onended`, and links from shared modulators are disconnected. `kill` makes every source stop at the earliest scheduled stop ("earliest wins" guard). The harness checks 0 live nodes after release, kill, steal, allOff and dispose for all 11 patches and presets.
  In a **real-time** context, `dispose()` with 3 notes still held works: voices reach `dead` with 0 nodes, and all 3 (synth) or 7 (organ) shared sources fire `ended` (CONFIRMED). noteOff, fadeOut or legato on a killed or dead voice is a no-op (state guards). A build failure mid-voice kills and tears down cleanly.
- **Envelopes.** `makeEnv` anchors with `setNow(0,t)` before the linear attack. Release during attack or decay releases from the instantaneous value (harness: release-in-attack passes for all). Steal fades are τ = 20 ms/6.9 on `v.out` with stop at 26 ms (−78 dB), and pass the isolated-transient HF test for every patch.
- `TrackedParam` makes legato and glide exact, and leaves bend intact. Bend is one shared cents ConstantSource into k-rate detune; morph and param changes use shared control nodes with 15–50 ms smoothing. No clicks were found in the allParams sweep. Harness bend/legato accuracy is < 0.5 %.
- **Sub-bass.** Adding a phase-locked H2 instead of an asymmetric shaper is a justified deviation. All components are sine-phase aligned, so the symmetric tanh produces **no DC**: measured held mean 6e-4 on an RMS of 6e-2, which is a partial-cycle artefact, including after legato. H2 tracks drive (−23 → −12.5 dB) and inharmonic content is at the analysis floor.
- **Warm-pad recipe.** 5 phase-rotated saws at 0/±9/±17¢ (inner ones scaled from the detune param), pans ±.3/±.6, sub tri at −12 dB (power-correct), HPF 120, keytrack 50 %, velocity ±30 %, one shared LFO ±300¢, −3 dB/oct above C4. The phase-rotated saw PeriodicWaves are cached per context and correct (sin/cos rotation algebra checked).
- **Soft-keys.** Index `(0.3+1.5v)·tone` decays to .2 with τ .4 s. Tine is 14:1, index .8, τ 30 ms, and its source stops at +0.3 s. The keytracked amp τ gives −20 dB at 6.94 s for C3 and 1.96 s for C6.
- **Organ.** `disableNormalization` amplitude is exact: a single 8′ drawbar measured 0.075 against an expected 0.075. Drawbar dB law and harmonic map match §3.4. Overdrive sits before the rotary with unity small-signal gain. Rotary rates are 5.9–6.8 Hz fast and 0.72 Hz slow, with inertia by setTarget and phase-locked L/R quadrature oscillators. The click is 4 ms Hann noise through a shared BPF; its peak is about equal to a single tone's but its RMS is −25 dB, a plausible Hammond-like level.
- **CPU.** Filter params are k-rate (the right call). Shared LFOs are fanned out, and only strings vibrato and drone drift are per-voice. No per-note PeriodicWave or curve creation. Organ is 4 nodes per voice (6 with percussion).
  16 voices × 4 s offline: organ 46–57×, bell and sub-bass 35×, soft-keys 33×, glass 13×, strings about 7–8×, **warm-pad and drone-osc about 6.7×**. That puts a 16-voice warm-pad at roughly 15 % of one (container) core; at 48 kHz that is about 0.4 ms of each 2.67 ms quantum.
  Easy win: the per-voice HPFs are static (not keytracked), so moving them to the instrument bus is mathematically identical (LTI) and measured **about 12–14 % faster** (noisy) for warm-pad and strings. Panners cost nothing measurable.
- **§3.2 API as used by audio.js/instruments.js.** `new X(ctx, prng, id, params)`, `noteOn → Voice`, `noteOff`, `allOff(t, .03)`, `fadeOutVoice`, `legatoTo` (engine only calls it on `'held'`), `setBend`, `morph`, `setParam` (warns and returns false on an unknown key, never throws), `liveVoiceCount`, `liveNodeCount`, `_sharedNodes`, `dispose`. All present and behaving. The one semantic mismatch is organ morph (M2).

---

## Prioritized fix list

1. **M2**: organ `_morph` relative to the `rotary` param. This is one line; in addition engine-core should initialise `sc.morph = 0`. Gospel currently never sounds "fast".
2. **M1**: shared Hammond-style percussion envelope, so chord notes struck together or during the decay get percussion.
3. **m2**: WaveShaper `oversample`: soft-keys and sub-bass `'none'`, organ `'2x'`. Removes 3–4.4 ms of note latency.
4. **M3** (+ **m6**, **m9**): cap the FM index against Nyquist in bell and the soft-keys tine, and rescale the deviation on legato and ratio change.
5. **m1**: convert every LP/HP `Q` to dB (Butterworth pair −5.33/+2.32, single −3.01, organ crossover −3.01), widen the resonance range, then recalibrate trims.
6. **m5**: horn delay depth sign (one character).
7. **m3**: glass H3 coefficient (one line).
8. **m4**: linear antiphase tremolo (mono-safe).
9. **m7**: instrument-level M/S low-side HPF for warm-pad, strings and drone.
10. **m8**: random start phase for bell, soft-keys and organ via cached rotated sine/drawbar waves (fixes peak stacking).
11. CPU: move the static per-voice HPFs to the instrument bus (~12–14 %).
12. Nits n1–n7 as time allows (n2 drone walk-buffer caching and n5 steal priority first).
