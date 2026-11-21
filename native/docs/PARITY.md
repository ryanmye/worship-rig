# Native vs web-engine parity (golden fixtures)

Written by the wave-1 integrator; re-generate after every wave. Every row was measured on the integrated tree
(v2-native after wave 1 + the integration pass): all 108 fixtures of `native/golden/manifest.json` rendered by
`rig_render` (`native/core/build-int`, g++ 13 Release) and compared by `node tools/golden/compare.mjs <dir>` at the
fixture's **manifest** tier; the same renders were also checked against the **exact** tier
(`manifest.tolerances.exact`: max|diff| ≤ 2e-4, bands 0.25 dB, env-corr 0.999, rms 0.1 dB). The clang 18 Release
renders of all 108 are byte-identical to the g++ ones. Goldens: Chromium 157.0.8103.78 (manifest pin); every golden
WAV used here has the manifest's sha256 except the 22 instrument goldens noted below (not compared by any passing
fixture).

## T13 update (2026-11-21, builder; supersedes the counts below where they differ)

All 112 fixtures (108 + the four T13 synth.js twins) rendered by `rig_render` from `native/core/build-t13` (g++ 13
Release) and compared at the manifest tier: **73 / 112 pass**. Against the wave-2 baseline of this tree before T13
(67 pass: the 64 of `golden_ids/*.ids` plus `auto-filter-cutoff`, `song-lofi-rhodes`, `transpose-octave-range`), those
67 render **byte-identical** WAVs, and six more pass:

| fixture | tier (manifest) | max\|diff\| | note |
|---|---|---|---|
| `switch-retire-retain` | statistical (exactIfPrngPorted) | 2.46e-7 | T13 done fixture; passes the exact tier: promote |
| `auto-slot-level-synth` | exact (promoted) | 3.01e-6 | T13 twin of `auto-slot-level` (organ, T15) |
| `auto-reverb-send-synth` | exact (promoted) | 1.43e-6 | twin of `auto-reverb-send` |
| `auto-delay-send-synth` | exact (promoted) | 7.15e-7 | twin of `auto-delay-send` (`synth:pluck`, T15) |
| `auto-master-volume-synth` | exact (promoted) | 3.58e-6 | twin of `auto-master-volume` |
| `release-pedalhold` | exact | 3.9e-38 | T14's fixture; passes now (notes follow their channel, slots without a channel get no notes) |

Still failing in the T13 list: the four organ / pluck `auto-*` originals (silent: T15) and `fx-row-sweep` (no drone:
T16; band 158 Hz off 26.5 dB). The role-default fix in `parsePatch` (T13) changes no passing fixture: their patches
set every send they use.

## Summary

**50 / 108 pass** at the manifest tier, and all 50 also pass the exact tier. The other 58 are blocked by later
waves: each renders silence (or near-silence) and `rig_render` lists the missing module as `UNIMPLEMENTED`; none
fails for a harness or DSP-parity reason.

| module (task) | pass | of | note |
|---|---|---|---|
| T02 filters & strip | 25 | 25 | 18 `eq-*`, `eq-chain-8band`, `eq-type-change` (golden re-rendered, see below), `eq-legacy-rows`, `pan-stereo-src`, `width-0/50/150`; all max\|diff\| 0 |
| T03 dynamics & master | 7 | 7 | ≤ 2.53e-7 |
| T04 reverb | 6 | 6 | `reverb-dry` is a silent golden; the other 5 ≤ 3.73e-9, **promoted to exact** in this pass |
| T05 delay / chorus / lofi | 10 | 10 | `echo-none` is a silent golden; `chorus-default-sine` **promoted to exact**; `chorus-fast-deep-noise` (1.98e-4, 99 % of the exact limit) and `lofi-tape-sine` (Chromium's own repeat diff 6.09e-5) stay statistical |
| T07 click | 2 | 2 | bit-exact |
| T11 synth.js | 0 | 6 | wave 2 |
| T12 sampler | 0 | 8 | wave 2 (`needsPcm`) |
| T13 Model: song & graph | 0 | 6 | wave 2, but 4 of its 6 also need T15 instruments (see "plan corrections") |
| T14 Model: perform | 0 | 14 | wave 3 |
| touch (BUILD_PLAN: T12) | 0 | 5 | all use `synth-808-sub` (synth-extra, T15) and the velocity curve (T14) |
| T15 synth-extra + organ | 0 | 15 | 10 synth-extra, 4 organ, `pan-mono-src` |
| T16 drone | 0 | 4 | `drone-freeze-*` also blocked on Ryan's Q7 |
| **total** | **50** | **108** | tiers after promotion: 68 exact / 40 statistical |

Silent goldens (peak 0, they pass with no code and prove nothing): `reverb-dry`, `echo-none`. Every other passing
golden peaks between 0.0097 (`reverb-hall`) and 1.06 (`eq-highshelf-c`), and the native render's peak matches.

ctest `golden.*` compares all 50 (`golden.eq` 18, `golden.t02` 7, `golden.master` 7, `golden.reverb` 6,
`golden.t05` 10, `golden.click` 2), at the manifest tier.

## Changes to the goldens in this pass

- `eq-type-change`: re-rendered (`node tools/golden/render.mjs --only eq-type-change`) after page.js started passing
  `{ when }` to `eqAudition` (0af78a6). Old golden peak 0.289 (audition at t = 0), new 0.501; native max|diff| 0
  against the new one. Added to `tests/golden_ids/t02.ids`.
- Promoted with `tools/golden/promote.mjs <renders> --apply --only …`: `reverb-room`, `reverb-stage`, `reverb-hall`,
  `reverb-cathedral`, `reverb-wash`, `chorus-default-sine` (statistical → exact; the statistical tolerance is kept as
  `tolerance.fallback`). Caveat: `render.mjs` re-classifies a fixture it re-renders (main mode), so a later
  `render.mjs --only <one of these>` undoes the promotion: run promote.mjs again after it. CI uses `--out` and never
  touches the manifest.
- Not changed: the 22 instrument goldens (`synth-*`, `organ-*`, `sampler-salamander-piano`, `sampler-ep-rhodes`)
  on disk do not match their manifest sha256 (re-rendered at 2026-11-19 20:34 without the manifest being kept,
  probably two concurrent `render.mjs --only` runs). No passing fixture uses them. **Before T11/T12/T15 compare
  against them, re-render them** (`node tools/golden/render.mjs --only synth-,organ-,sampler-salamander,sampler-ep`)
  so the WAV and the manifest stats agree (the committed `smoke/organ-gospel.wav` is one of them).

## Plan corrections found while classifying the blocked fixtures (carried into BUILD_PLAN)

- `auto-slot-level`, `auto-reverb-send`, `auto-master-volume` play `organ` patches and `auto-delay-send` plays
  `synth:pluck` (synth-extra): T13's four `auto-*` done fixtures cannot pass before T15 (wave 3). T13 closes them
  after T15, or T17 adds synth.js twins (warm-pad) so T13 can close in wave 2.
- `touch-*` (T12's list) play `synth:808-sub` (synth-extra, T15) through the velocity curve (contract 2.4, T14): move
  them to T14 with T15.
- `song-lofi-rhodes` plays `synth:soft-keys` (T11), not a sampler: it closes with T14 + T11 + T05, not T12.
- `fx-row-sweep` and `switch-retire-retain` (T13) play `sampler:ep-rhodes`: T13 needs T12 for them (both wave 2).
- `synth-*` fixtures all use instrument type `synth`; 10 of the 16 ids are synth-extra.js patches (T15). The Model
  attaches kind `inst.synth`, so T11's `inst.synth` factory must hand synth-extra ids to T15's implementation (a
  registration hook in T11's files; T15 then registers into it) instead of a separate `inst.synth-extra` kind.

## Per fixture, grouped by module

`tier` is the manifest classification after this pass; "blocked (Tn; needs …)" names the task that unblocks the
fixture and every task it needs.

### T11 synth.js: 0/6

| fixture | tier (manifest) | result | max\|diff\| | golden peak |
|---|---|---|---|---|
| `synth-warm-pad` | statistical (exactIfPrngPorted) | blocked (T11; needs T11) | — | 0.538945 |
| `synth-glass-pad` | statistical (exactIfPrngPorted) | blocked (T11; needs T11) | — | 0.517183 |
| `synth-strings` | statistical (exactIfPrngPorted) | blocked (T11; needs T11) | — | 0.534989 |
| `synth-sub-bass` | statistical (exactIfPrngPorted) | blocked (T11; needs T11) | — | 0.319434 |
| `synth-soft-keys` | statistical | blocked (T11; needs T11) | — | 0.412834 |
| `synth-bell` | statistical (exactIfPrngPorted) | blocked (T11; needs T11) | — | 0.526968 |

### T15a synth-extra: 0/10

| fixture | tier (manifest) | result | max\|diff\| | golden peak |
|---|---|---|---|---|
| `synth-supersaw-pad` | statistical (exactIfPrngPorted) | blocked (T15; needs T15) | — | 0.532257 |
| `synth-juno-pad` | statistical (exactIfPrngPorted) | blocked (T15; needs T15) | — | 0.512069 |
| `synth-shimmer-pad` | statistical (exactIfPrngPorted) | blocked (T15; needs T15) | — | 0.43857 |
| `synth-dx-epiano` | statistical | blocked (T15; needs T15) | — | 0.737701 |
| `synth-pluck` | statistical (exactIfPrngPorted) | blocked (T15; needs T15) | — | 0.640472 |
| `synth-poly-stab` | statistical (exactIfPrngPorted) | blocked (T15; needs T15) | — | 0.533543 |
| `synth-analog-brass` | statistical (exactIfPrngPorted) | blocked (T15; needs T15) | — | 0.466971 |
| `synth-square-lead` | statistical (exactIfPrngPorted) | blocked (T15; needs T15) | — | 0.260282 |
| `synth-808-sub` | exact | blocked (T15; needs T15) | — | 0.543317 |
| `synth-synth-bass` | statistical (exactIfPrngPorted) | blocked (T15; needs T15) | — | 0.831105 |

### T15b organ: 0/5

| fixture | tier (manifest) | result | max\|diff\| | golden peak |
|---|---|---|---|---|
| `organ-gospel` | statistical (exactIfPrngPorted) | blocked (T15; needs T15) | — | 0.615092 |
| `organ-soft-pad` | statistical (exactIfPrngPorted) | blocked (T15; needs T15) | — | 0.455656 |
| `organ-full` | statistical (exactIfPrngPorted) | blocked (T15; needs T15) | — | 0.585334 |
| `organ-church` | statistical (exactIfPrngPorted) | blocked (T15; needs T15) | — | 0.578005 |
| `pan-mono-src` | statistical (exactIfPrngPorted) | blocked (T15; needs T15) | — | 0.393329 |

### T12 sampler: 0/8

| fixture | tier (manifest) | result | max\|diff\| | golden peak |
|---|---|---|---|---|
| `sampler-salamander-piano` | exact | blocked (T12; needs T12) | — | 2.13862 |
| `sampler-ep-rhodes` | exact | blocked (T12; needs T12) | — | 0.501643 |
| `sampler-sweep-1` | exact | blocked (T12; needs T12) | — | 0.263085 |
| `sampler-sweep-2` | exact | blocked (T12; needs T12) | — | 0.117181 |
| `sampler-sweep-3` | exact | blocked (T12; needs T12) | — | 0.166909 |
| `sampler-sweep-4` | exact | blocked (T12; needs T12) | — | 0.148714 |
| `sampler-sweep-5` | exact | blocked (T12; needs T12) | — | 0.108632 |
| `sampler-sweep-6` | exact | blocked (T12; needs T12) | — | 0.646478 |

### T04 reverb: 6/6

| fixture | tier (manifest) | result | max\|diff\| | golden peak |
|---|---|---|---|---|
| `reverb-dry` | exact | PASS | 0 | 0 **silent golden: proves nothing** |
| `reverb-room` | exact (exactIfPrngPorted) | PASS | 2.79e-9 | 0.0115702 |
| `reverb-stage` | exact (exactIfPrngPorted) | PASS | 3.03e-9 | 0.0104251 |
| `reverb-hall` | exact (exactIfPrngPorted) | PASS | 2.79e-9 | 0.0096711 |
| `reverb-cathedral` | exact (exactIfPrngPorted) | PASS | 3.26e-9 | 0.0111403 |
| `reverb-wash` | exact (exactIfPrngPorted) | PASS | 3.73e-9 | 0.0124886 |

### T05 delay/chorus/lofi: 10/10

| fixture | tier (manifest) | result | max\|diff\| | golden peak |
|---|---|---|---|---|
| `echo-none` | exact | PASS | 0 | 0 **silent golden: proves nothing** |
| `echo-slapback` | exact | PASS | 0 | 0.0954261 |
| `echo-quarter` | exact | PASS | 0 | 0.0968031 |
| `echo-dotted` | exact | PASS | 0 | 0.0951075 |
| `echo-ambient-echo` | exact | PASS | 0 | 0.0576195 |
| `echo-dotted-noise` | exact | PASS | 0 | 0.184427 |
| `chorus-default-sine` | exact (exactIfPrngPorted) | PASS | 9.18e-6 | 0.299999 |
| `chorus-fast-deep-noise` | statistical (exactIfPrngPorted) | PASS (exact tier too) | 1.98e-4 | 0.249744 |
| `lofi-tape-sine` | statistical | PASS (exact tier too) | 7.18e-5 | 0.280664 |
| `lofi-crush-sweep` | exact | PASS | 4.75e-6 | 0.222305 |

### T02 filters & strip: 25/25

| fixture | tier (manifest) | result | max\|diff\| | golden peak |
|---|---|---|---|---|
| `eq-lowshelf-a` | exact | PASS | 0 | 0.502102 |
| `eq-lowshelf-b` | exact | PASS | 0 | 0.492148 |
| `eq-lowshelf-c` | exact | PASS | 0 | 0.502847 |
| `eq-peak-a` | exact | PASS | 0 | 0.53689 |
| `eq-peak-b` | exact | PASS | 0 | 0.496704 |
| `eq-peak-c` | exact | PASS | 0 | 0.635667 |
| `eq-highshelf-a` | exact | PASS | 0 | 0.81843 |
| `eq-highshelf-b` | exact | PASS | 0 | 0.207113 |
| `eq-highshelf-c` | exact | PASS | 0 | 1.0575 |
| `eq-notch-a` | exact | PASS | 0 | 0.49128 |
| `eq-notch-b` | exact | PASS | 0 | 0.499786 |
| `eq-notch-c` | exact | PASS | 0 | 0.343814 |
| `eq-lowcut-a` | exact | PASS | 0 | 0.495986 |
| `eq-lowcut-b` | exact | PASS | 0 | 0.491097 |
| `eq-lowcut-c` | exact | PASS | 0 | 0.499464 |
| `eq-highcut-a` | exact | PASS | 0 | 0.222313 |
| `eq-highcut-b` | exact | PASS | 0 | 0.0771001 |
| `eq-highcut-c` | exact | PASS | 0 | 0.353331 |
| `width-0` | exact | PASS | 0 | 0.248934 |
| `width-50` | exact | PASS | 0 | 0.249397 |
| `width-150` | exact | PASS | 0 | 0.385729 |
| `pan-stereo-src` | exact | PASS | 0 | 0.495212 |
| `eq-chain-8band` | exact | PASS | 0 | 0.391105 |
| `eq-type-change` | exact | PASS | 0 | 0.500538 |
| `eq-legacy-rows` | exact | PASS | 0 | 0.459939 |

### T03 dynamics & master: 7/7

| fixture | tier (manifest) | result | max\|diff\| | golden peak |
|---|---|---|---|---|
| `master-eq` | exact | PASS | 0 | 0.599979 |
| `glue-50` | exact | PASS | 5.96e-8 | 0.557283 |
| `glue-100` | exact | PASS | 0 | 0.202145 |
| `glue-100-bursts` | exact | PASS | 0 | 0.223477 |
| `limiter-steps` | exact | PASS | 2.42e-7 | 0.768086 |
| `limiter-steps-hot` | exact | PASS | 2.53e-7 | 0.847003 |
| `limiter-bursts-hot` | exact | PASS | 2.38e-7 | 0.83452 |

### T16 drone: 0/4

| fixture | tier (manifest) | result | max\|diff\| | golden peak |
|---|---|---|---|---|
| `drone-synth-2keys` | statistical (exactIfPrngPorted) | blocked (T16; needs T11, T13, T16) | — | 0.242428 |
| `drone-synth-stage` | statistical (exactIfPrngPorted) | blocked (T16; needs T11, T13, T16) | — | 0.154709 |
| `drone-freeze-dry` | statistical (exactIfPrngPorted) | blocked (T16 (Q7); needs T16) | — | 0.224502 |
| `drone-freeze-wet` | statistical (exactIfPrngPorted) | blocked (T16 (Q7); needs T16) | — | 0.22316 |

### T13 Model: song & graph: 0/6

| fixture | tier (manifest) | result | max\|diff\| | golden peak |
|---|---|---|---|---|
| `auto-slot-level` | statistical (exactIfPrngPorted) | blocked (T13; needs T13, T15) | — | 0.27533 |
| `auto-reverb-send` | statistical (exactIfPrngPorted) | blocked (T13; needs T13, T15) | — | 0.1508 |
| `auto-delay-send` | statistical (exactIfPrngPorted) | blocked (T13; needs T13, T15) | — | 0.174809 |
| `auto-master-volume` | statistical (exactIfPrngPorted) | blocked (T13; needs T13, T15) | — | 0.202193 |
| `switch-retire-retain` | statistical (exactIfPrngPorted) | blocked (T13; needs T12, T13) | — | 0.261398 |
| `fx-row-sweep` | statistical | blocked (T13; needs T12, T13, T16) | — | 0.180855 |

### T14 Model: perform: 0/14

| fixture | tier (manifest) | result | max\|diff\| | golden peak |
|---|---|---|---|---|
| `auto-filter-cutoff` | statistical (exactIfPrngPorted) | blocked (T14; needs T11, T13, T14) | — | 0.645677 |
| `auto-modwheel-cc` | statistical (exactIfPrngPorted) | blocked (T14; needs T13, T14, T15) | — | 0.1678 |
| `scene-glide` | statistical (exactIfPrngPorted) | blocked (T14; needs T11, T13, T14, T15, T16) | — | 0.399547 |
| `song-sunday-pad-piano` | statistical (exactIfPrngPorted) | blocked (T14; needs T11, T12, T13, T14, T16) | — | 0.683564 |
| `song-lofi-rhodes` | statistical | blocked (T14; needs T11, T13, T14) | — | 0.180786 |
| `song-gospel-stab-b3` | statistical (exactIfPrngPorted) | blocked (T14; needs T13, T14, T15) | — | 0.371712 |
| `bend-pitch-sampler` | exact | blocked (T14; needs T12, T13, T14) | — | 0.589994 |
| `bend-tape` | exact | blocked (T14; needs T12, T13, T14) | — | 0.191481 |
| `bend-modes` | statistical (exactIfPrngPorted) | blocked (T14; needs T11, T13, T14, T16) | — | 0.674804 |
| `swell-pedal-drone` | statistical (exactIfPrngPorted) | blocked (T14; needs T13, T14, T15, T16) | — | 0.309359 |
| `mono-legato` | exact | blocked (T14; needs T12, T13, T14) | — | 0.245834 |
| `transpose-octave-range` | exact | blocked (T14; needs T12, T13, T14) | — | 0.27539 |
| `panic-fadeout` | exact | blocked (T14; needs T12, T13, T14) | — | 0.233735 |
| `release-pedalhold` | exact | blocked (T14; needs T12, T13, T14) | — | 0.248002 |

### touch (BUILD_PLAN: T12; really T14 + T15 808-sub): 0/5

| fixture | tier (manifest) | result | max\|diff\| | golden peak |
|---|---|---|---|---|
| `touch-soft` | exact | blocked (T14; needs T13, T14, T15) | — | 0.488865 |
| `touch-hard` | exact | blocked (T14; needs T13, T14, T15) | — | 0.489016 |
| `touch-fixed` | exact | blocked (T14; needs T13, T14, T15) | — | 0.467116 |
| `touch-custom` | exact | blocked (T14; needs T13, T14, T15) | — | 0.477981 |
| `touch-keyboard` | exact | blocked (T14; needs T13, T14, T15) | — | 0.488762 |

### T07 click: 2/2

| fixture | tier (manifest) | result | max\|diff\| | golden peak |
|---|---|---|---|---|
| `click-120-44` | exact | PASS | 0 | 0.5 |
| `click-90-68-countin` | exact | PASS | 0 | 0.3 |


## UI parity through rig-devhost (T09 baseline)

`node test/unit/engine-bridge/ui-core-devhost.mjs` (the `ui-core` Perform suite against `rig-devhost`, real UI in
headless Chromium): **21 / 76 pass** (T09 builder run, 23 min; the T09 review re-ran the `boots|Panic cuts` subset:
1 pass, 1 fail on `get:instruments -> unsupported`). This is the wave-1 baseline; it must rise with wave 2 (T11
`get instruments`) and wave 3 (T14 `play input`, fade, bend). 55 of the failures need T11, T14 or a ui-core adapter
for Web Audio internals (`strip.pan`, `AnalyserNode`, `getParam`) that the native bridge does not expose.

Environment notes (not defects):

- Playwright 1.56 pins Chromium build 1194 (141.0.7390.37); this box only has `/opt/pw-browsers/*-1243`, which is
  Chrome for Testing 157.0.8103.78 (the golden pin; no Playwright release ships it as 1243). `render.mjs` falls
  back to it by itself; the plain `ui-core` suite may not launch here. Point `PLAYWRIGHT_BROWSERS_PATH` /
  `executablePath` at it, or let CI install Chrome for Testing 157.0.8103.78 (`@puppeteer/browsers`, as
  `.github/workflows/native-core.yml` does for the goldens).
- The `boot-devhost.mjs` recording is digital silence until an instrument exists (T11): it proves the recording
  plumbing, not audio.

## How to reproduce

```sh
cd native/core && cmake -S . -B build-x -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build-x -j2
build-x/rig_render --manifest ../golden/manifest.json --out /tmp/parity          # all 108, ~17 s
node ../../tools/golden/compare.mjs /tmp/parity                                     # manifest tier
node ../../tools/golden/promote.mjs /tmp/parity                                     # exact-tier dry run
```
