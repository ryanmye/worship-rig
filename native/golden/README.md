# Golden reference audio (native 2.0)

The web engine (`app/js/engine`) is the reference oracle for the native C++ engine. It renders deterministically
offline (OfflineAudioContext, seeded PRNG, every call timed with `{when}`), so the harness in `tools/golden/` turns
a declarative fixture list into reference WAVs. The native test runner replays the same fixtures from
`manifest.json` alone (no JS needed) and must land within each fixture's tolerance.

## Regenerate

```sh
npm ci                                   # once (Playwright; Chromium comes from PLAYWRIGHT_BROWSERS_PATH or
                                         # ~/.cache/ms-playwright; GOLDEN_CHROMIUM=<exe> overrides)
node tools/golden/render.mjs             # everything: 87 fixtures × 2 renders + seed-spread renders, manifest
node tools/golden/render.mjs --only eq-,reverb-room    # a subset (ids containing a substring), merged into the manifest
node tools/golden/render.mjs --smoke     # only the committed smoke subset
node tools/golden/compare.mjs --self-test                # comparator self-check
node tools/golden/compare.mjs <dir>                      # <dir>/<id>.wav (e.g. native renders) vs the goldens
node tools/golden/compare.mjs <id> <file.wav>            # one fixture
node tools/golden/render.mjs --out <dir> --seed 2        # renders with another engine seed, manifest untouched
```

Measured on the Linux CI box (2 slow CPUs, headless Chromium 157.0.8103.78): the full run takes **about 3 min**
(≈ 100 s for 87 fixtures × 2 repeat renders, plus ≈ 70 s of seed-spread renders for the PRNG-dependent ones;
`--no-spread` skips those). It needs no audio device.

## Layout

| path | what | committed |
|---|---|---|
| `manifest.json` | every fixture: definition, stats, sha256, classification, tolerance, PRNG streams | yes |
| `stimuli/*.wav` | the dry inputs effect fixtures inject (mono unless `channels: 2`) | yes (2.2 MB) |
| `smoke/*.wav` | 11 smoke fixtures (one per DSP block family) | yes (8.6 MB) |
| `out/*.wav` | the other 76 fixtures | no (`.gitignore`; ≈ 115 MB, regenerate) |

All WAVs are 32-bit IEEE float, 44100 Hz. Fixture renders are stereo. Slot-tap renders can exceed 0 dBFS (the
calibrated sampler trims put a vel-120 Salamander note at +6.6 dBFS before the master −6 dB and the catcher), so the
native side must compare in float, not clip to 16 bit.

## Fixture contract (`manifest.fixtures[].fixture`)

```
{ id, kind, seconds, seed, smoke?, setup, events }
setup.patch       SPEC §2 patch (the engine normalizes it; the result is in resolved.patch: use that)
setup.tap         recorded node, default 'out'
setup.inject      {stimulus, at, gain = 1, start}: stimuli/<stimulus>.wav started at `start` s into node `at`
setup.drone       {mode:'synth', gain, brightness, movement, width, fade, key:{pc, minor}}
setup.tempo / timeSig / click{level} / transpose / keyContext{pc, minor} / wheel{mod, expr}
events[]          {t, type, …} issued in time order, each with when = t (seconds from render start):
  noteOn {note, vel, touch?}   noteOff {note}   pedal {down}   cc {cc, value}  (1 mod, 11 expr, 7 volume, 64 pedal)
  wheel {source, value, glide?}   bend {value}   param {path, value, glide?}   droneKey {pc, minor, fade?}
  clickStart {countIn?, quietAfter?}   clickStop   swell {start}
```

Order of operations the reference uses (`tools/golden/page.js renderFixture`), which the native runner must mirror:
1. new engine (seed), `setParam` of every `patch.fx.*` / `master.*` value **before start** (so the song's reverb
   unit is the one built at start: no 0.8 s IR crossfade at commit, glue engaged from t 0);
2. `start()`, then tempo, time signature, click settings; `prepare(patch)` and `commit(token, {when: 0})`;
3. transpose, key context, drone `setKey` + `configure`, wheels (all at t 0);
4. stimulus source started at `inject.start`; output re-pointed to the tap;
5. every event in time order; render `seconds × 44100` frames (rounded up).

`kind: 'drone-freeze'` is different: it is the lowres2 frozen-drone loop (`engine/drone-freeze.js
renderDroneLoop`) for `setup.key` / `setup.params`, `loopSec`, `prerollSec`, `seamSec` and an optional
`setup.reverb {size, damp, predelay, wet}`; the WAV is the finished seamless loop (`loopSec` long).

### Test points

The native engine has to expose the same points (by name) for isolated tests.

| inject `at` | node |
|---|---|
| `fx.sum` | dry + returns sum, before lofi |
| `fx.reverb.input` | reverb send bus (HPF 180 → LPF 9 k → predelay → IR → return gain → wheel) |
| `fx.delay.input` / `fx.chorus.input` | send buses (chorus input is mono) |
| `fx.eqIn` | master EQ input (after lofi) |
| `fx.preComp` | catcher compressor → soft clip → out |
| `slot0.strip` | slot 0 strip input: fader → wheel → width → slot EQ → pan |

| tap | node |
|---|---|
| `out` | the master output (catcher + soft clip included); also carries the click |
| `fx.sum` | the sum before lofi |
| `fx.reverb.output` / `fx.delay.output` / `fx.chorus.output` | unit returns (after return gain) |
| `fx.lofi.output` | lofi chain output (= master EQ input) |
| `fx.eqOut` | master EQ output |
| `fx.master` | after the glue compressor and master volume |
| `slot0.pan`, `slot1.pan` | a slot after instrument → trim → strip (before sends and the sum) |

## Stimuli

Defined in `tools/golden/stimuli.mjs` (closed-form, float64 → float32 once): `impulse` (0.5 at 0.25 s), `sweep`
(exp. 20 Hz–20 kHz, 2 s, −12 dBFS), `noise` (0.5 s white, ±0.25), `stereo-noise` (independent L/R, 1 s), `sine`
(440 Hz, 1 s), `steps` (1 kHz at −36/−24/−12/−6/−1 dBFS, 0.4 s each), `tone-burst` (200 Hz + 2 kHz, 50 ms bursts).
Noise uses mulberry32 seeded by FNV-1a of the stimulus' `seed` string (one draw per frame; stereo: L then R).
The WAVs in `stimuli/` are authoritative: feed them, don't regenerate.

## Classification and tolerances

- **Repeatability.** Each fixture renders twice in two pages at once; `repeatMaxAbsDiff` is the max sample
  difference. Chromium sums node inputs in hash-set order (≈ 1e-6 jitter); `exactRepeatThreshold` is 1e-5.
- **exact**: repeatable ≤ 1e-5 and no PRNG stream reaches the tap (or silent). Tolerance: max |diff| ≤ 2e-4
  (−74 dBFS), every third-octave band within 0.25 dB (bands within 60 dB of the loudest), envelope correlation
  ≥ 0.999, envelope lag 0, RMS within 0.1 dB. `tolerance.fallback` is the statistical tolerance: a runner may use it
  for a fixture whose path contains a Chromium node the port reimplements rather than mirrors sample for sample
  (`chromiumNodes`, e.g. DynamicsCompressorNode, MP3 decode, OscillatorNode wavetables), and must log that it did.
- **statistical**: repeatable only above 1e-5 (audio-rate FM: soft-keys, dx-epiano, synth-bass; lofi wow/flutter),
  or a seeded PRNG stream reaches the tap. Tolerance: bands within `bandsDb` (bands within 50 dB of the loudest),
  envelope correlation ≥ `envCorr`, |lag| ≤ `envLagMs`, RMS within `rmsDb`. For PRNG-dependent fixtures these are
  per fixture: never tighter than 1.5 dB / 0.95 / 10 ms / 1 dB, and widened to 1.25 × the **seed spread** (the same
  fixture rendered with engine seeds +1 and +2, `seedSpread`) so that "as close as another seed would be" passes.
  `prngPortRecommended: true` marks fixtures where that widening was needed: without a port of the PRNG streams
  those are weak tests; with the port they should be held to the exact tolerance.

Measures (`tools/golden/analysis.mjs`): peak/RMS over both channels; third-octave bands of (L+R)/2, Welch
(Hann, 4096, hop 2048), ISO centres 25 Hz–20 kHz; 10 ms RMS envelope in dB (floor −120), Pearson correlation over
blocks above −90 dB; lag = the ±200 ms shift that maximises it.

## Randomness (for the C++ port)

Every random decision in the engine comes from one PRNG: mulberry32 (`app/js/shared/prng.js createRng`, with
`range`, `int`, `gaussian` (Box–Muller, spare cached), `pick`, `shuffle`, `fork` = createRng(floor(next()·2^32))).
Streams are named and seeded with FNV-1a: `rngFor(seed, name) = createRng(hashSeed(`${seed}|${name}`))`.

| stream | name | consumers |
|---|---|---|
| instrument | `inst\|<slot>\|<type>\|<id>\|<seq>` (seq = engine-wide creation counter, 1-based) | voices fork it per note |
| drone | `drone` | each drone-osc instrument forks it |
| frozen drone | `drone-freeze\|<pc>\|<minor 0/1>` | renderDroneLoop's drone |
| reverb IR | `createRng(hashSeed(`${seed}\|ir\|${bucket}\|${dampQ}\|${sr}`))` | buildIRChannels (noise, early taps) |
| chorus | `chorus` | one draw: LFO start phase |
| lofi crackle | `crackle` | 6 s impulse loop (count, positions, amplitudes) |

`manifest.fixtures[].randomness.streams` lists, per fixture, the streams that reach its tap (with the seed and,
for instruments, how many rng calls the render made). Porting mulberry32 + FNV-1a is ~30 lines; reproducing a
stream also needs the same draw order inside each consumer.

## Not captured (and why)

- **Files-mode drone** (the user's pad files): an offline engine disables it (HTMLMediaElement playback).
- **MIDI clock out, aux click outputs 3–4, the recorder tap**: not audio on the main output. `click-*` fixtures
  capture the click on `out` only.
- **Realtime-only behaviour**: reverb builds deferred to a quiet pause, fx idle sleep, low-resource drone freeze
  swaps (the loop itself is captured via `renderDroneLoop`), the audio watchdog, latency.
- **Song switches** (prepare/commit under held notes, channel retirement): every fixture is one committed patch.
- **My Samples** packs and other bundled sampler sets: two bundled sets (Salamander piano, MusyngKite Rhodes) are
  covered. Samples are MP3: the reference uses Chromium's decoder (FFmpeg) and its resampling; a native decoder
  (e.g. minimp3/dr_mp3) can differ in priming/padding handling, so check sample-start alignment first if a sampler
  fixture fails.
- Only 44.1 kHz. The engine's behaviour at 48 kHz (IR keys include the rate) is not rendered.
- The references depend on the Chromium build (`manifest.chromium`). Rerunning on another build can move
  Chromium-implemented nodes; compare a rerun with `compare.mjs` before replacing the goldens.
