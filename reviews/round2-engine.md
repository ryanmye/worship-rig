# Round 2 review: engine

Scope: `app/js/engine/{audio,fx,sampler,drone,instruments,synth-extra,synth,organ,voice}.js`, `app/js/shared/params.js`,
`tools/calibrate.mjs`, `tools/audition.mjs`. Read against CONTRACT_CHANGES "engine-core fixes", "instruments fixes",
"synth-extra" and "engine-3".

Suites, run one at a time on the loaded 2-CPU box:

| suite | result |
|---|---|
| `node test/phase1/engine/run.mjs` | 53/53, 0 console errors |
| `node test/phase1/instruments/run.mjs` | 142/143. `steal soft-keys` failed on `preDiff`. It is flaky, see m4. |
| `node test/phase1/synth-extra/run.mjs` | 153/153 |
| `npm run test:unit` | 239/239 |

Experiment scripts are in the session scratchpad, `review2-engine/exp*.mjs`. They use Playwright against
`test/phase1/engine/server.mjs`. No repo file was changed apart from this report.

## Findings

### M1. A sustained sampler note at MIDI ≥ 90 keeps sounding after note-off. [major, CONFIRMED]

- **Where:** `app/js/engine/sampler.js:429`, `v.ignoreRelease = n >= 90; // undamped strings`
- **Problem:** The piano "no dampers in the top octaves" rule is applied to every sampler, including user packs.
  The GarageBand importer creates `strings`, `choir`, `pad` and `organ` categories, and those samples sustain.
  - Experiment (`exp5.mjs`): a user pack with a steady 6 s sample at C4 and C7. Note-off at 1.0 s.
    - Notes 84 and 89 are at −48.8 dB by 2.0–2.5 s.
    - Notes 90 and 96 are still at **−31.3 dB, the held level**, at 2.0–2.5 s and at 3.5–4.0 s.
  - Such a note plays until its sample ends, which is up to the 10 s cap, at full level.
  - Transpose and slot octave make this worse, because the rule tests the *sounding* note.
  - Panic still works (`fadeOut` ignores the flag).
- **Fix:** Make undamped keys an explicit per-instrument manifest field. Suggested shape: `undampedFrom: 90`, set on the
  factory pianos (and the harp and dulcimer if wanted), off by default. At minimum, gate the rule on
  `category === 'piano'` and never apply it to `user:` entries.

### M2. The macro.wash reverb size is lost on a song switch or restart. [major, CONFIRMED]

- **Where:**
  - `app/js/engine/audio.js:411`: prepare stages the song's plain `size`.
  - `audio.js:901-907`: `_lastWashBucket` gates the wash request.
  - `audio.js:176-194`: `_resetState` never clears `_lastWashBucket`.
- **Problem:**
  - commit crossfades the reverb to the new song's *unwashed* IR.
  - `_applyWheels` then asks for the washed IR only when the washed bucket differs from the *previous* washed bucket.
  - With the wash wheel up and an unchanged washed bucket (always true at wheel 1: `lerp(size, .9, 1)` = 0.9 → bucket 8),
    no request is made. The reverb stays at the song's small size until the wheel crosses a bucket boundary.
  - restart() has the same problem, because `_lastWashBucket` survives it.
- **Measured** (`exp.mjs wash`), with `modWheel` routed to `macro.wash`:

  | step | reverb unit | expected |
  |---|---|---|
  | song A (size .3), wheel 1 | `8\|0.5` | `8\|0.5` |
  | switch to song B (size .5) | `5\|0.5` | 8 (`_effReverbSize()` = 0.9) |
  | wheel moved to .99 | `5\|0.5` | 8 |

- **Fix:**
  - Stage the effective size in prepare: `lerp(p.fx.reverb.size, .9, W)` when the new patch routes a wheel to
    `macro.wash`. That also avoids a double crossfade (unwashed, then washed).
  - In `_applyWheels`, compare `want` with the bucket the reverb is actually at or heading to, not with
    `_lastWashBucket`. Otherwise reset `_lastWashBucket = undefined` in commit and in `_resetState`.

### M3. Engaging the glue dips the level by 3–4.5 dB for about 150 ms. [major, CONFIRMED]

- **Where:**
  - `app/js/engine/fx.js:1504`: `glueDelay` is 384 frames.
  - `fx.js:1590-1598`: engage.
  - `fx.js:1617-1626`: bypass disconnects the compressor.
- **Problem:**
  - The compressor's input is connected at engage and the dry→wet crossfade starts 8.7 ms later.
  - A DynamicsCompressor that has just started to receive signal over-reduces for about 100–200 ms.
  - After a bypass, the compressor is no longer pulled, so its envelope stays frozen at whatever it was when bypassed.
    That makes the next engage worse.
  - The engine-3 click test passes because this is a level dip, not a click.
- **When it happens:** turning the Glue knob up from 0 while playing. It also happens on every commit from a
  glue-off song into a glue-on song, if notes are sounding.
- **Measured** (`exp.mjs glue`): 1 kHz reference tone at −23.01 dBFS, amount 1 engaged at 2.5 s. RMS in 50 ms windows:

  | case | 2.55 s | 2.60 s | 2.70 s | 2.80 s |
  |---|---|---|---|---|
  | fresh engage | −26.27 | −24.62 | −23.04 | −23.01 |
  | after an earlier engage at 0.9 amplitude, then bypass | **−27.55** | −25.29 | −23.22 | −23.01 |
  | same, with `fx.glueDelay = 0.3` patched at runtime | −23.01 | −23.01 | −23.01 | −23.01 |
  | fresh, with `fx.glueDelay = 0.3` | −23.01 | −23.01 | −23.01 | −23.01 |

- **Fix:**
  - Connect the compressor input, then start the crossfade about 250–300 ms later: `glueDelay ≈ 0.3`.
  - Keep `_glueXf` bookkeeping as is.
  - The knob then engages 0.3 s later, which is inaudible for a glue effect. The numbers above show this removes both
    the fresh dip and the stale-state dip.
  - Alternative: keep the compressor permanently connected behind `glueWet` = 0. Adding exact zeros keeps the bypass
    bit-exact, and the detector always tracks.

### m1. A failed My Samples reload wipes every user instrument. [minor, CONFIRMED]

- **Where:** `app/js/engine/instruments.js:384-399` (`reloadSecondary`) and `:429-443` (`_fetchManifest` returns null
  for "absent" and for "error" alike).
- **Problem:** A 5xx or network error on `/api/user-samples/manifest.json`, or a failed `/api/health`, during
  `reloadManifests()` deletes all `user:` defs. The next song that uses one gets FallbackSynth soft-keys.
  - Experiment (`exp.mjs reload`, route returns 503 during the reload):
    - before: `[user:test-keys, user:harp]`
    - after: `[]`
    - preparing `user:test-keys` gave `soft-keys` (fallback) and warned "Unknown sampled instrument".
  - The local server rarely fails, so the likelihood is low. The live consequence (the wrong instrument mid-set) is
    why this is worth fixing.
- **Fix:** Distinguish "not served" (health flag off, or a 200 with an empty list) from "failed". On failure, keep the
  previous `user:` entries, warn, and return the old count.

### m2. The sample cache is not refreshed on a rescan. [minor, CONFIRMED by code]

- **Where:** `sampler.js:274-278` (`failed.set(url, {permanent})`) and `instruments.js:384` (reload does not touch the
  cache).
- **Problem:** A user sample that 404'd or failed to decode is skipped permanently for the page's lifetime, even after
  the user fixes the file and presses Rescan. A re-imported file at the same URL also keeps playing the old decoded
  buffer. The server token only changes when the server restarts.
- **Fix:** In `reloadManifests()`, clear `cache.failed` and drop unreferenced `cache.entries` for URLs under the
  secondary manifests. Alternatively, have the server add a content hash or mtime to the sample URLs.

### m3. User manifest `release` and `gainTrim` are not clamped. [minor, CONFIRMED by code]

- **Where:** `sampler.js:80` and `:88`.
- **Problem:**
  - A hand-written manifest with `release: 3` makes the param default 3, above its max of 1.5. The UI knob then
    shows an out-of-range value, and a voice's time-to-−60 dB becomes 20.7 s.
  - `gainTrim: 40` becomes a ×100 output gain.
  - The importer writes sane values (0.12–0.6), so only hand-edited manifests are affected.
- **Fix:** For secondary manifests, clamp `release` to the param range [0.02, 1.5] and `gainTrim` to about ±30 dB,
  and warn when clamping.

### m4. The `steal soft-keys` test is flaky. [minor, test only, CONFIRMED flaky; cause SUSPECTED]

- **Where:** `test/phase1/instruments/run.mjs:63` (`preDiff < 1e-4`).
- **Measured:** Four identical in-page runs gave preDiff 1.35e-4, 0.68e-4, 0.91e-4 and 0.80e-4. Every other
  metric is stable (HF −1.25 dB, stolen voice dead, 0 nodes).
- **Suspected cause:** Chromium's input-summation order jitter, integrated through the FM modulators' a-rate frequency
  inputs over 16 voices. That is −78 dB, not a pre-steal difference.
- **Fix:** Raise the tolerance to 1e-3, or compare it with the A-vs-A re-render difference.

### m5. The two synth-extra audition FAILs are a threshold artifact, not an engine bug. [minor, tools, CONFIRMED by arithmetic and report.json]

- **Where:** `tools/audition.mjs:32` (`rmsLo: -26`).
- **Problem:**
  - A Keys-role instrument clip plays at slot gain 0.8 (−1.94 dB) with the −6 dB master. Its nominal level is therefore
    −18 − 6 − 1.94 = **−25.9 dBFS** before sends, which leaves about 1 dB of margin above the −26 floor.
  - Every decaying Keys patch sits just above the floor (`audition/report.json`): soft-keys −24.9, bell −25.6,
    tubular-bells −25.4, nylon −25.4.
  - dx-epiano (−26.6) and pluck (−27.3) lose 1–2 dB more because of their keytracked decay and −3 dB/oct above C4 in
    the progression's C4–C5 register.
  - Their engine-level calibration is correct: −18.2 and −18.3 with the pre-roll.
- **Fix:** Do not raise their internal `gainTrim` as CONTRACT_CHANGES suggests.
  - That would put their calibration chord 1.5–2 dB over −18.
  - For pluck, it would push more attacks into the −3 dBFS ceiling knee. Its raw 3-note chord peak was already
    +0.6 dBFS under the old window.
  - Instead, give instrument clips a floor relative to their nominal level (for example −28 for decaying Keys, or
    nominal − 2 dB), or render instrument clips at slot gain 1.
  - If the product owner feels dx is too quiet by ear, +1 dB on dx alone is defensible. pluck should stay as it is.

### Not reproduced (dropped)

- **Restart during sample decode poisoning the shared BufferCache.** Chromium decodes normally on a closed
  AudioContext, both in-flight and after `close()` (`exp2.mjs`). A restart 1.5 s into a Salamander preload left
  0 failed URLs and 90/90 samples loaded.
- **A commit landing inside restart()'s awaits.**
  - If it did, restart's `applyState(stale state)` would overwrite the song and the controller would believe the new
    song is applied.
  - I could not hit the window (`exp3.mjs`, delays 0–400 ms): restart finishes in a few ms with warm IR caches.
  - It is theoretically possible when the IR must be recomputed, for example a restart onto a new sample rate.
  - Cheap guard: have `restart()` capture `getState()` after `await old.close()`, or bump `_latestToken` at the start
    of restart so that any in-flight commit is refused (the #18 path the controller already retries).

## Solid (checked, no issues)

- **Width stage** (`fx.js:1341-1402`):
  - The M/S math is right. `wMid` 1-ch speakers downmix gives S⃗ = (S, −S), and S⃗ = 0 for mono.
  - The mono sum is invariant for every width.
  - Width 1 and EQ 0 add exact zeros (bit-exact).
  - Fresh strips step while ramped strips use TAU, and `_effWidth` applies `widthDefault`.
- **Slot and master EQ:** Shelves at 0 dB are identity. setEq handles undefined partial updates. PARAMS rows,
  `clamp()` defaults and `normalizePatch` fill width and eq consistently. getParam returns 0 or 1 when unset.
- **Glue bypass:** true disconnect after 40 ms, seq-guarded against re-engage, and the busy-branch retarget is
  consistent. The makeup table and interpolation are correct. `_start` refreshes the makeup once the table arrives.
  Only the engage dip (M3) is an issue.
- **Delay loop:** the single stereo DelayNode cycle with a Q pre-delay is well founded. The engine suite confirms echoes
  at 375.06/750.14/1125.22/1500.29 ms. The ≤5 % glide is anchored with `from` via `_tg`. Line flush/switch sequencing
  and the panic hold are correct.
- **User manifests:**
  - The `user:` prefix, 'My Samples' group, per-manifest URL base, `release` 0.15 default and `widthDefault` all work.
  - The health gate means no request is made without the flag.
  - Factory ids are untouched.
  - `render-page` restricts the tools to the factory manifest.
  - A fallback-built `user:` slot is rebuilt after a successful reload, because the param mismatch prevents reuse.
- **Registry:** synth-extra is merged without id collisions, `calibWindow` and `module` pass through, `hidden`
  handling is right, and the JSON fetch retries on 408/429/5xx.
- **Calibration:** the pre-roll, `calibWindow`, the synth-extra "measured, never trimmed" rule, the drone gate and
  `--only type:id` are implemented as documented.
- **Butterworth Q everywhere** (engine suite `filterQButterworth`). Sampler `tone 1` reaching Nyquist is an exact
  bypass.
- **Automation conventions:** no direct AudioParam calls in scope. The only `setTimeout`s are for network, worker and
  resume, never for audio timing.
- **CPU and memory:** the new per-strip nodes (7 gains + 3 biquads) and 3 master biquads are cheap. The lofi curve cache,
  IR and unit pools, tape segments and coalescer maps are all bounded.

## Prioritized fix list

1. **M1:** make sampler undamped-top-octave opt-in per manifest, off for `user:` and non-piano categories. This is a
   one-line gate plus a manifest field.
2. **M2:** stage the washed reverb size in prepare, and stop gating the wash request on `_lastWashBucket` (or reset it
   in commit and `_resetState`).
3. **M3:** set `glueDelay` to about 0.3 s, or keep the compressor detector permanently fed behind a zero wet gain.
4. **m1:** keep the previous `user:` defs when a reload fails.
5. **m2:** clear `cache.failed` and unreferenced entries for user URLs on `reloadManifests()`.
6. **m3:** clamp user-manifest `release` and `gainTrim`.
7. **m4:** loosen the `preDiff` tolerance in the instruments steal test.
8. **m5:** use a relative audition floor for instrument clips. Leave the synth-extra trims alone, except an optional
   +1 dB on dx after listening.
