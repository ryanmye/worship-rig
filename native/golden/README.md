# Golden reference audio (native 2.0)

The web engine (`app/js/engine`) is the reference oracle for the native C++ engine. It renders deterministically
offline (OfflineAudioContext, seeded PRNG, every call timed with `{when}`), so the harness in `tools/golden/` turns
a declarative fixture list into reference WAVs. The native test runner replays the same fixtures from
`manifest.json` alone (no JS needed) and must land within each fixture's tolerance.

## Regenerate

```sh
npm ci                                   # once (Playwright; Chromium comes from PLAYWRIGHT_BROWSERS_PATH or
                                         # ~/.cache/ms-playwright; GOLDEN_CHROMIUM=<exe> overrides)
node tools/golden/render.mjs             # everything: every fixture × 2 renders + seed-spread renders, manifest, PCM dumps
node tools/golden/render.mjs --only eq-,reverb-room    # a subset (ids containing a substring), merged into the manifest
node tools/golden/render.mjs --smoke     # only the committed smoke subset
node tools/golden/pcm.mjs                # (re)dump the Chromium-decoded sampler PCM (render.mjs does it too); --check verifies
node tools/golden/coverage.mjs           # rewrite COVERAGE.md; node tools/golden/tiers.mjs rewrites the tier table below
node tools/golden/promote.mjs <dir>      # which statistical fixtures a native render now passes exactly (--apply promotes)
node tools/golden/compare.mjs --self-test                # comparator self-check
node tools/golden/compare.mjs <dir>                      # <dir>/<id>.wav (e.g. native renders) vs the goldens
node tools/golden/compare.mjs <id> <file.wav>            # one fixture
node tools/golden/render.mjs --out <dir> --seed 2        # renders with another engine seed, manifest untouched
```

Measured on the Linux CI box (2 slow CPUs, headless Chromium 157.0.8103.78): the full run takes **234 s**
(≈ 100 s for 87 fixtures × 2 repeat renders, ≈ 135 s for 4 seed-spread renders of each of the 40 PRNG-dependent
fixtures; `--no-spread` skips those). It needs no audio device.

## Layout

| path | what | committed |
|---|---|---|
| `manifest.json` | every fixture: definition, stats, sha256, classification, tolerance, PRNG streams | yes |
| `stimuli/*.wav` | the dry inputs effect fixtures inject (mono unless `channels: 2`) | yes (2.2 MB) |
| `smoke/*.wav` | 11 smoke fixtures (one per DSP block family) | yes (8.6 MB) |
| `out/*.wav` | every other fixture | no (`.gitignore`; regenerate) |
| `pcm/<set>/<note>.{wav,json}` | Chromium-decoded sampler PCM + sidecars (see "Sampler PCM") | sidecars yes; `.wav` only the few listed in `pcm/.gitignore` (cap 2.5 MB) |
| `COVERAGE.md` | contract rows and operations x fixtures, what is uncovered and why (generated) | yes |

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
  transpose {semis}   keyContext {pc, minor}   routing {routing}   panic   fadeOut {seconds}   monoOut {on}
  eqAudition {slot, mode: bypass|on}   commit {next, retain?}   retainReverb {next}          (T17)
setup.next        [patch, ...] prepare()d before the render starts; `commit {next: i}` swaps to patch i at its time
setup.live        event types called at their time through the engine timer instead of up front (see below)
patch top level   bend {mode: pitch|tape|morph|drone-swell|none, range}, swell {seconds, pedal?}, modWheel / expression /
                  volume {target, min, max}: the routing block the engine normalizes
needsPcm / pcm    fixture plays samplers: the native run needs the Chromium-decoded PCM (see "Sampler PCM")
```

Order of operations the reference uses (`tools/golden/page.js renderFixture`), which the native runner must mirror:
1. new engine (seed), `setParam` of every `patch.fx.*` / `master.*` value **before start** (so the song's reverb
   unit is the one built at start: no 0.8 s IR crossfade at commit, glue engaged from t 0);
2. `start()`, then tempo, time signature, click settings; `prepare(patch)` and `commit(token, {when: 0})`;
3. transpose, key context, drone `setKey` + `configure`, wheels (all at t 0);
4. stimulus source started at `inject.start`; output re-pointed to the tap;
5. every event in time order; render `seconds × 44100` frames (rounded up). Events are issued **up front** with
   `{when: t}`, in time order, except the types listed in `setup.live`: those are called at their time by the engine's
   own offline timer, i.e. at the first 128-frame quantum boundary >= t, with `when` = that boundary. This is needed
   where the engine reads state at call time that a later event changes: `swell` is a state machine on timers (a stop
   issued up front replaces the start before it ran) and `routing` swaps the bend / wheel mapping that `bend` and
   `wheel` events read when they are called (issued up front they all see the first routing). A native runner must
   treat `live` events the same way (apply at the quantum boundary, in event order) and everything else sample
   accurately at `t`. Fixtures with `setup.next` call `prepare()` for every later patch before the render starts; a
   `commit` event is then `commit(token, {when: t})` (with `retain`, `retainReverb([patch])` first).

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
(440 Hz, 1 s), `steps` (1 kHz at −36/−24/−12/−6/−1 dBFS, 0.4 s each), `tone-burst` (200 Hz + 2 kHz,
50 ms bursts).
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
  fixture rendered with engine seeds +1…+4, `seedSpread`) so that "as close as another seed would be" passes;
  where seeds decorrelate the envelope itself (seed-spread envelope ρ < 0.5: the frozen-drone loops) the envelope
  checks are switched off. Out-of-sample check: renders with engine seed 7 pass 40/40 PRNG-dependent fixtures
  (with only 2 spread seeds, seed 5 failed 9/40, so the spread tolerances are an estimate, not a bound).
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
| instrument | `inst\|<slot>\|<type>\|<id>\|<seq>` (seq: engine-wide creation counter, from 1) | forked per note |
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
- **My Samples** packs. All 23 bundled sets are rendered (`sampler-*`, `sampler-sweep-1..6`, and the structural fixtures
  that use `ep-rhodes` / `ep-wurli`). Samples are MP3: the reference uses Chromium's decoder (FFmpeg) and, for 48 kHz
  files, its resampling; feed the native sampler the PCM dumps below, and test decoder parity separately.
- **Audio sleep / wake, low-resource freeze swap, files-mode drone, rate changes, meters, cache**: not renderable by an
  offline context or not audio; COVERAGE.md lists each with the test that has to cover it.
- Only 44.1 kHz. The engine's behaviour at 48 kHz (IR keys include the rate) is not rendered.
- The references depend on the Chromium build: see "Chromium pin".

## Sampler PCM (decoder independence)

The sampler goldens come from MP3s decoded by Chromium; a native decoder (dr_mp3) differs in priming and rounding. So
`render.mjs` (and `pcm.mjs`) dump, for every sample a fixture really plays (`manifest.fixtures[].pcm.files`, harvested
from the buffers the render started), what Chromium decoded:

```
pcm/<set>/<note>.wav    32-bit IEEE float, interleaved, the FILE's native rate (no resampling), all decoder channels, full length
pcm/<set>/<note>.json   {source, sourceSha256, sourceBytes, rate, channels, frames, sha256, engineRate, resampledByEngine, decoder}
```

`source` is the MP3's repo-relative path, `sha256` the hash of the `.wav`. The native runner loads this PCM through the
`samples.pcmOverride` test hook instead of decoding the MP3; the sampler's own processing (onset trim, 2 ms fade-in, cap,
dual-mono fold, mono-loss fix, +trim) still runs natively and is what the exact tier tests. Where `resampledByEngine`
is true (48 kHz files, e.g. `upright-piano`) the reference engine's context was 44.1 kHz, so Chromium resampled
during decode: the native side must resample the dump itself, and that step is not in the dump (a fixture on such a file
is tested with the resampler's own tolerance, or you add a second dump at 44.1 kHz). Fixtures with `needsPcm: true` are
the ones that need dumps (`pcm.required`); a missing `.wav` means "run `node tools/golden/pcm.mjs`" (about 10 s, needs
Chromium; `--check` verifies hashes).

Size cap: all dumps together are about 90 MB (one decoded sample is 1.1 MB: 3.1 s stereo float), so they are
regenerated, not committed. `pcm/.gitignore` un-ignores only the most-used files up to **2.5 MB** (`COMMIT_CAP_BYTES`
in `pcm.mjs`); sidecars are always committed so a regenerated dump can be verified. Committed golden audio is
stimuli + smoke + that subset, kept under 14 MB (render.mjs prints the figure).

## Chromium pin

`manifest.chromiumPin` = `{version, product, playwrightBuild, userAgent, executableSha256, platform}`; `manifest.chromium`
stays the plain version string, and every fixture entry carries `chromium` (the version that rendered it).

- `render.mjs` refuses (exit 3) when this browser's version differs from the manifest's pin, for partial and full runs.
  `--allow-chromium-change` overrides: a full run then re-pins, a partial `--only` run keeps the old pin and stamps its
  entries (so the mix is caught below).
- `compare.mjs` refuses (exit 2) when a golden entry's stamp differs from the pin, or when `<dir>/render-info.json`
  (written by `render.mjs --out`) names another Chromium, or `--expect-chromium` disagrees; `--allow-chromium-mismatch`
  compares anyway and prints a warning. Native renders carry no render-info.json and are never refused.
- The version is the source tag the kernel ports (compressor, PeriodicWave, resamplers, AudioParam timeline, biquad)
  must follow (SETUP_REVIEW 17): the goldens here are Chromium **157.0.8103.78**.

## Honest tiers

The architecture doc's "bands 1.5 dB, envelope corr 0.95" is the floor, not the tolerance of every statistical fixture:
the manifest's `fixtures[].tolerance` is what is enforced, and `fixtures[].tier` records why and what would make a
fixture exact (`exactIf.streams` = the PRNG streams to port: mulberry32 + FNV-1a seeding + the draw order inside each
consumer; `blockers` = Chromium itself is not repeatable, so a port cannot help). `manifest.tiers` summarizes. Each
PRNG-dependent tolerance is 1.25 x the spread of renders under other engine seeds, so it measures "as close as another
seed would be", which is weak: after the port the fixture should be exact. Promotion is mechanical:
`node tools/golden/promote.mjs <native render dir> --apply` re-tests every `exactIfPrngPorted` fixture against the exact
tolerance and rewrites its classification (the old tolerance becomes `fallback`).

<!-- tiers:begin -->
<!-- tiers:end -->
