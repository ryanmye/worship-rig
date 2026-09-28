# engine-core review: audio.js, fx.js, sampler.js, drone.js, instruments.js, index.js

Reviewer role: senior Web Audio / real-time audio engineer. The review is read-only. The code was reviewed as of 2026-09-28 00:30.
The fixups agent's concurrent edits (automation `{from}`, PARAMS, sampler polyphony 32) are out of scope. I re-checked every
engine-core call site of `linearTo`/`glideTo` after its automation change. All of them pass an explicit `from`, so
nothing below depends on that change.

**How the findings were checked.** Each finding carries a status:
- CONFIRMED: reproduced in headless Chromium (Playwright) against the current code.
- SUSPECTED: mechanism found in the code but not reproduced.

Repro scripts are in `$SCRATCH/review-engine/`, where `$SCRATCH` = `/tmp/claude-0/-home-claude/7e62a35d-8374-53c8-b5e9-fdad80c27279/scratchpad`.
Run one with `node $SCRATCH/review-engine/run-exp.mjs $SCRATCH/review-engine/<eN>.js`. The runner starts the engine
test server, opens `/__tests/harness.html`, and evaluates the script in the page.

The existing suite `node test/phase1/engine/run.mjs` gives **30/30 PASS, 0 console errors** (log: `testrun.log`).

---

## Findings (most severe first)

### 1. [major] A reused instrument keeps the previous song's params (Felt Piano → Grand Piano stays dark). CONFIRMED
`audio.js:494` `_applySlotCfg(reuse)` only visits keys present in the **new** `cfg.params`:
`for (const [k, v] of Object.entries(cfg.params || {})) if (prev?.params?.[k] !== v) …`.
If song B uses the same `{type,id}` in the same slot and leaves a param at its default (empty `params`), the instance keeps
song A's value. `getParam()` then reports the default, so the UI shows a value the instrument isn't using.

- Repro `e1-param-leak.js`, sampler: Felt Piano sets `tone: .3`, then Grand Piano commits with `{}`. After the switch the
  instance still has `tone = 0.3` (LPF 1.5 kHz), while `getParam('slots.0.params.tone')` returns 1.
- Same repro, real synth.js warm-pad: `attack` set to 7.2 stays 7.2 after the switch; `getParam` says 1.2.
- Factory order Grand → Rhodes → **Felt → Dusty** hits this. Any user setlist that shares warm-pad or salamander does too.

Fix:
```js
// _applySlotCfg, reuse branch
for (const m of this.registry.paramsFor(sc.ref)) {
  const want = cfg.params?.[m.key] ?? m.default;
  const have = sc.inst.getParam ? sc.inst.getParam(m.key) : prev?.params?.[m.key] ?? m.default;
  if (have !== want) sc.inst.setParam?.(m.key, want, t);
}
```

### 2. [major] Files-mode drone: two key changes inside the load→`playing` window leave BOTH keys playing indefinitely. CONFIRMED
`drone.js:264-273` `_fadeOutAll` only fades `this.activeEls`. An element joins `activeEls` in `_fadeInEl` (`:546`), which
runs on `playing` (`:522-528`), not in `_play`.

A second `setKey` that arrives before the first element fires `playing` therefore cannot see it. That element then fades
in to full and loops forever (it schedules its own loop crossfades) alongside the new key. It goes away only at the next
key or mode change.

Repro `e3c.js` (C → G → C, 5 ms apart): G and C both sit at gain 1.00 for the rest of the run, and G keeps looping. With
local WAV the window is about 20 ms. With multi-MB MP3 pads, a Range seek to a random offset, and (in Electron) a USB
pad folder, it is 50–300 ms. Transpose ± tapped twice, or a mis-tap corrected on the key grid, will hit it.

Fix: register the element as live at `_play` time and let fade-out cancel elements that haven't started:
```js
// _play: after _grab()
e.pending = true; this.activeEls.push(e);
// onplaying: if (e.seq !== seq || e.started || e.fadingOut) return; e.pending = false; …
// _fadeOutEl(e,…): if (e.pending) { this._releaseEl(e); return; }   // silent, so a hard release is fine
// _fadeInEl: keep the includes() guard
```

### 3. [major] Files-mode drone: pool exhaustion hard-cuts an audible element (click). CONFIRMED
`drone.js:459-466` `_grab()`: when all 4 pool elements are busy, it steals the first element that isn't in `activeEls`.
Elements that are fading out are not in `activeEls`, so the victim is often at high gain. `_releaseEl` then does
`setNow(e.gain.gain, 0, now)` (`:477`), which is a step to 0.

Repro `e3d.js` (fade 4 s, key changes 700 ms apart): 3 hard cuts at gains 0.85, 0.27 and 0.93.

The pool fills up because loop crossfades use 2 elements. Also, the random start offset (`:512`) can land right at
`le − xf`, so a loop crossfade starts about 200 ms after a key change (visible in the `e3b` log).

Fix:
- In `_grab`, steal the busy element with the lowest *scheduled* level (track `e.level`/fade end), and fade it
  (`rampTo(gain, 0, now, 0.005)`, i.e. about 30 ms) before pausing. Or grow the pool on demand to 6.
- Clamp the random offset to `[ls, le − xf − fade − 2]`.

### 4. [major] `restart()` silently turns a files-mode drone into the synth drone. CONFIRMED
`audio.js:248-266`. The new `Drone` has no files. `applyState` → `setMode('files')` finds none → falls back to synth and
warns "No pad file for C". The controller re-calls `attachFiles` only afterwards (`controller.js:850`), and
`attachFiles` (`drone.js:425`) never re-evaluates the mode.

Repro `e4.js`: before the restart `effective: 'files'`; after restart + attachFiles, `effective: 'synth'` with 0 files
playing. Restart is exactly what the player presses when audio died mid-set.

Fix, either or both:
- (a) In `restart()`, keep `const files = this.drone?.files` and set `this.drone.files = files` right after `_build()`,
  before `applyState`.
- (b) At the end of `attachFiles`: if `cfg.mode === 'files' && effectiveMode !== 'files' && this.key && this._fileFor(this.key)`,
  call `this._start(this.key, 1.5, now, true)`.

### 5. [major] Mono output is summed *after* the ceiling and peaks at +2.4 dBFS. CONFIRMED
`fx.js:951-955, 973-980`: `clip → mono(0.5(L+R)) × √2 → out`. Centred content comes out at 1.414 × the clipped level, so
the −0.3 dBFS ceiling becomes about +2.7 dBFS. The DAC hard-clips, and the recorder's ±1 clamp flat-tops.

Repro `e16.js` (loud centred chord): stereo peak −0.62 dBFS, **mono peak +2.39 dBFS**. Mono output exists for the church
mono DI.

Fix: do the stereo/mono selection *before* the comp and clip:
`master → masterWheel → fadeGain → [stereo | mono sum] → comp → clipPre → clip → out`.
The alternative is to sum at 0.5 (−6 dB) post-clip, which is quieter.

### 6. [major] Main-thread IR builds of 75–370 ms right after song switches (and during wash sweeps). CONFIRMED
- `buildIR` (`fx.js:274`) is synchronous JS: 110–180 ms per IR at 48 kHz in this container (`e2-ir-timing.js`), plus
  10–27 ms for the `convolver.buffer =` set.
- The IR cache holds **4** entries (`fx.js:371`), but the factory setlist has **8** distinct IR keys.
- The controller calls `preload([prev,next])` after every commit. `engine.preload` calls `reverb.getIR` synchronously for
  each (`audio.js:463-465`).

Repro `e19.js`, stepping through the factory setlist: `preloadNeighbors` blocks the main thread for
0 / 327 / 128 / 0 / 76 / 162 / 80 / 0 / 367 / 270 / 0 ms. Web MIDI events are delivered on the main thread, so these
blocks become note latency at the downbeat of the new song. An M-series Mac is maybe 2–3× faster, which still leaves
30–150 ms.

The same work runs in timer callbacks mid-performance:
- `reverb.request()` (`fx.js:476`) when `macro.wash` crosses buckets: 201 ms max gap in `e2`.
- A deferred commit swap.

`prepare()` also builds the IR synchronously while the old song is still playing.

Fix:
1. Move `buildIR` to a Worker (pure Float32 math; transfer the two channel arrays and build the AudioBuffer on the main
   thread), or chunk it with `await` yields every ~4 ms.
2. Raise the IR cache to ≥ 12 entries (≤ 4 MB each).
3. In `preload`, schedule IR warming via the chunked or worker path, never inline.
4. Optional: quantise `damp` in 0.25 steps to cut the number of keys.

Also related (minor): `processSample` runs on the main thread per decoded buffer, and `e7.js` saw a 124 ms max gap while
decoding salamander. That doesn't matter while everything is cached, but it lands mid-song after the pin issue (#12)
has evicted the buffers.

### 7. [major] Predelay changes at commit pitch-warp the reverb input (+9 semitones for ~20–50 ms). CONFIRMED
`fx.js:497` `setPredelay` = `rampTo(delayTime, v, t, 0.03)` on a live DelayNode. `commit()` calls it for every song
(`audio.js:543`). A 25 ms change with τ = 30 ms makes the read pointer run at up to about 1.8×.

Repro `e12.js`: 440 Hz held through the switch, predelay 40 → 15 ms. The reverb input reads 700–750 Hz for 20 ms and
stays elevated for about 50 ms. Factory predelays differ between almost every pair of songs (.015/.02/.025/.03/.04), and
pads are commonly held through a switch. That breaks §0.3 "never click".

Fix: give each convolver slot its own predelay DelayNode (`lpf → predelayA → convA`, `lpf → predelayB → convB`).
- Set the staged slot's predelay with `setNow` in `stage()`, so it rides the existing equal-power crossfade.
- On commit with an unchanged IR, stage the same IR onto the idle slot with the new predelay and crossfade anyway.
- For live knob edits, use `linFrom` over ≥ 0.5 s (≤ 5 % rate change).

### 8. [major] Lofi engage produces a click: the wet chain's latency makes its onset a step. CONFIRMED
`fx.js:832-850`. On engage, the wet chain is connected and the 30 ms dry→wet ramp starts at `when`. But the wet path has
about 9.4 ms of latency: the tape DelayNode's 5 ms plus the 4x oversampler's 192 frames. The delayed signal therefore
appears as a step once the wet gain is already at about 0.31.

Repro `e9b.js` (sine, lofi 0 → .3): 9 second-difference spikes up to 0.026 against a steady-state max of 0.00019
(137×). The spike sits exactly 15.4 ms after the event, which is the 9.4 ms wet path plus the compressor's 6 ms.

Triggers:
- A song switch into a lofi preset while anything rings.
- Turning the lofi knob up from 0.
- **Every tape-bend gesture** when the song's lofi amount is 0 (`audio.js:892, 903` → `L.hold('tape', true)`).

Fix: start the crossfade after the wet latency, e.g. `const w = when + 0.012;` and use `w` for both `linFrom`s in the
`on` branch. Also, anchor `_dryV` to the value *at* `when`: compute it from the last ramp's start/end, not its target.
Otherwise engage→bypass within 30 ms also steps (small extra spikes at +19 ms in `e9b`).

### 9. [major for tape presets] The tape bend re-anchors `delayTime` from a stale `.value` on every bend message and crackles. CONFIRMED
`audio.js:897-898`: `const cur = L.tape.delayTime.value; linFrom(L.tape.delayTime, cur, …, t, …)`, run for each
coalesced bend message (up to 100/s).

In realtime the event takes effect one or more render quanta after `.value` was read, and meanwhile the delay time has
been moving at 0.5 s/s. The anchor therefore jumps the read pointer back by `slope × lag`, which is a waveform
discontinuity every time.

Deterministic repro `e10b.js` (offline, 50 bend messages, event lands 3 ms after the read): **452 spike samples,
770× baseline**. The same stream with 0 ms lag is clean, and so is a single message with lag. A realtime ScriptProcessor
capture (`e10.js`) showed the same, but that capture is noisy under load.

Factory **Lofi Rhodes** and **Dusty Piano** use `bend: 'tape'`. `:909` (recover) has the same pattern.

Fix: keep the ramp analytically. Store `{t0, v0, slope}` and compute `cur = v0 + slope·(t − t0)` (clamped) instead of
reading `.value`. Or re-issue only when `depth` actually changes (skip identical x). Or drive the depth through a
ConstantSource → GainNode integrator rather than re-anchoring.

### 10. [minor] `restart()` loses wheel, pickup and fade-out state (pad jumps to full, faded drone returns). CONFIRMED
`_teardown → _resetState` (`audio.js:156-172`) resets `wheel` to `{1,1,1}`, `_modOwner` to `'hw'` and `_fade` to null.
`getState()` (`:1122`) captures none of them.

Repro `e13.js`: wheel at .1 before the restart becomes pad wheel gain 1 (+20 dB) after. A completed `fadeOutAll`
(fadeGain 0) becomes fadeGain 1 with the drone sounding. The watchdog auto-restart can fire during a quiet moment after
a fade-out.

Fix:
- Add `wheel`, `modOwner` and `faded: !!this._fade` to `getState()`.
- In `applyState`, restore `this.wheel`, set `_modOwner = 'virtual'` with `_pickup = {lastHw:null}` (so the hardware
  must pick up), and `setNow(fx.fadeGain.gain, 0)` if it was faded.

### 11. [minor] A fresh channel's wheel gain starts at 1 and ramps down, so the first note after a switch blips. CONFIRMED
`fx.js:899` `Channel.wheel` starts at gain 1. `commit` → `setRouting` → `_applyWheels(t, 0.03)` → `rampTo(…, τ 30 ms)`,
so the fresh strip needs about 100 ms to reach the wheel factor.

Repro `e8.js`: wheel at 0 (slot should be silent), new instrument committed, note at the commit time → −22 dB for
30 ms, −30 dB up to 100 ms. Pads hide it (slow attack). Keys, bells and organ on a wheel- or expression-targeted slot
don't.

Fix: in `_applySlotCfg(fresh)` add `setNow(s.wheel.gain, this._slotWheelFactor(sc.index), t)`, computed after
`_routing` is updated. That means calling `setRouting` before the slot loop in `commit`.

### 12. [minor → major at 96 kHz or larger setlists] `BufferCache.pin()` replaces the pin set, so the setlist is unpinned after the first switch. CONFIRMED
`sampler.js:195` `this.pinned = new Set(urls)`. `controller.preloadSetlist()` pins the whole setlist; every later
`preloadNeighbors()` replaces it with prev+next only.

Repro `e6.js`: 4 pinned after preload(setlist), **0** after `preload([songWithoutSamples])`.

Measured decoded sizes at 48 kHz (`e7.js`): salamander 362 MB, each MusyngKite instrument about 100 MB, 966 MB total.
The factory setlist (salamander + rhodes, about 463 MB) fits under the 700 MB cap at 48 kHz. At a 96 kHz device rate
it doesn't, and neither does a user setlist with 3+ sampled instruments. After eviction, a later song re-decodes at
prepare: seconds of "loading", plus the `processSample` main-thread gaps from #6.

Fix: `preload(patches, {pin:'add'|'replace'})`, where neighbours add to the setlist pin set and `preloadSetlist`
replaces. Or keep two sets: `setlistPins` and `neighbourPins`.

### 13. [minor] Several public calls throw before `start()` (§0.9 "never throw"). CONFIRMED
Node repro (inline in the review log): these throw `TypeError`:
- `setWheel` / `modWheel` / `expression` / `volumeCC`, `pitchBend`, `swell`, `setParam(*)`: `this.coalesce`/`this.timer` undefined.
- `setTempo`: `this.fx.delay`.
- `getParam('drone.*')`: `this.drone`.

`noteOn`, `sustain`, `allNotesOff` and `fadeOutAll` guard on `!this.fx`. The controller's `call()` wrapper catches and
turns these into warn toasts, but a mod-wheel wiggle before "Click to start audio" produces one.

Fix: guard with `if (!this.fx) return false;` (and store the value where it's state: `wheel`, `_patch`, `tempo`) so it
applies at `_build`.

### 14. [minor] The catcher compressor adds +1.1 dB of automatic makeup gain. CONFIRMED
`fx.js:945`. Chromium's DynamicsCompressor applies `(1/fullRangeGain)^0.6` makeup. `e11.js`: every input below
threshold comes out 1.10 dB hotter (−20 → −18.9 dBFS).

Consequences:
- The master level isn't what `master.volume` says.
- The clip knee (linear below 0.5 post-`clipPre`) is reached at about −7.1 dBFS pre-comp, not −6.
- The CONTRACT_CHANGES #1 claim that the clip is transparent under −6 dB master staging is off by 1.1 dB.

Fix: set `clipPre.gain = 0.5 * 10 ** (-1.1/20)`. Better, measure the makeup once at build time with a tiny offline
render, since it depends on threshold/knee/ratio.

### 15. [minor] Lofi sits before the master gain, and its WaveShapers clamp input at ±1 (no headroom). CONFIRMED (measurement)
`fx.js:936` (sum → lofi → master) with `sat`/`quant` WaveShapers. Per spec, a WaveShaper clamps input to [−1, 1].

`e17.js`: a 10-note, velocity-127, pedaled chord drives the **sum bus to +9 to +11 dBFS** on the piano presets.
- **Dusty Piano** (lofi .5) is therefore hard-limited inside lofi.
- The non-lofi piano presets lean on the catcher (out peak −0.7 dBFS, about 4 dB of gain reduction) and on the
  non-oversampled clip.

Fix: pre-scale the wet chain by 0.25 (−12 dB) at `wetIn` and restore after `wet` (the tanh curve is unity small-signal,
so the character only shifts). Alternatively move master gain ahead of lofi.

### 16. [minor] Drone key change constructs a new drone-osc instrument synchronously (5–33 ms per key; ×4 in chord-follow). CONFIRMED (timing)
`drone.js:276-286` `_newLayer` → `registry.create(drone-osc)`. `e15.js`: `create()` 4–31 ms per call (here), and
`setKey` 5–77 ms (`e14.js`). It runs right after commit (controller → `drone.setKey`) and, in chord-follow, **per chord
change while the player plays** (4 instruments each).

Fix: keep two long-lived drone-osc instruments (A/B) and noteOn/noteOff voices on the idle one. Chord-follow should
retune voices (setBend or legatoTo) instead of building instruments.

### 17. [minor] A failed sample URL is never retried, and fetch has no timeout. CONFIRMED by code
`sampler.js:154, 176-190`. Any transient fetch or decode failure (for example the server momentarily unavailable in the
Chrome-launcher path) marks the URL `failed` for the whole session, even across `restart()`. That note stays silent
forever. A hung fetch keeps its `inflight` promise forever, so that instrument's `prepare` never resolves again.

Fix: store `{url: failedAt}` and retry after 30 s or on the next `prepare`. Use `fetch(url, {signal: AbortSignal.timeout(20000)})`.

### 18. [minor] `restart()` during an in-flight `selectSong` prepare: commit is refused silently and the controller thinks the song applied. SUSPECTED
`applyState` → `prepare` bumps `_latestToken` (`audio.js:343`), so the controller's pending token is stale.
`commit()` returns false (`:412`), but `controller.selectSong` ignores the return value. The UI then shows song B while
the engine plays the restored song A.

Fix: `commit` emits `warn` on refusal. The controller checks the result and re-selects.

### 19. [minor] The mono-slot noteOn path is not exception-safe. SUSPECTED
`audio.js:943-946`. `_monoOn → _monoSwitch → inst.noteOn/legatoTo` is outside the try/catch that protects the poly path
(`:956`). If it throws, `forEach` aborts before `this.sounding.set(n, entries)`, and voices already started on lower
slots are orphaned, which means a stuck note. No current instrument throws there.

Fix: wrap it the same way as the poly path.

### 20. [minor] A small delay-time change (≤ 5 %) glides with τ 50 ms, briefly pitch-shifting the echoes by up to about 50 %. SUSPECTED (same mechanism as #7)
`fx.js:564-567`. Tempo-synced songs at 72 vs 75 bpm produce a chirp on the echo tail at the switch.

Fix: glide linearly over ≥ 0.5 s, or lower the crossfade threshold to 1 %.

### Nits
- `sampler.js:233, 263-266`: `tone = 1` isn't "open". The Q 0.5 LPF at 20 kHz is −1.9 dB at 10 kHz and −0.5 dB at 5 kHz.
  Use Q 0.707, or bypass (frequency = Nyquist) at tone ≥ .99.
- `audio.js:925-929`: after `fadeOutAll`, the next noteOn brings the drone back from silence to full in 5 ms. That's the
  spec wording, but a 200–500 ms restore (or keeping the drone faded) would avoid a thump.
- `this.pedaled` keeps dead-voice entries while the pedal stays down (inverted pedal = forever). Prune entries whose
  `voice.state === 'dead'` in `noteOn`.
- `commit` with a future `when`: the slot is swapped immediately, but the fresh fader is 0 until `when`. Notes in between
  are silent (offline only).

---

## Tested and found solid
- The full engine suite passes 30/30, 0 console errors (sustain deferral, re-strike, mono lowest, split, transpose FFT,
  gapless switch, superseded prepare, lofi bypass ≤ 1.3e-6, stuck-note fuzz back to baseline nodes, drone key change and
  files mode, bend modes, panic/fade, IR recipe).
- **commit() is cheap:** 0.4–4 ms with real salamander + synth + organ at 48 kHz (`e14.js`).
- **Restart mid-sample-load is safe:** `decodeAudioData` on a closed context still resolves in Chromium. No permanent
  failures, and the cache survives (`e5.js`).
- **Superseded prepare doesn't leak cache refs:** the plan is discarded only after `ready`, so `dispose()` releases every
  ref (`e6.js`).
- **Delay line switching** stays consistent under fuzz: 4 seeds, 50+ random time and ping-pong changes each. Exactly one
  active line with gate/out = 1, correct echo spacing afterwards, all finite (`e18.js`).
- **IR DSP:** the RBJ band-pass and low-shelf coefficients match the cookbook, and per-bucket energy normalisation is
  equal (0.70).
- **Memory arithmetic:** channels × frames × 4 matches the decoded sizes (above).
- **Clip curve:** exactly the identity below 0.5 post-`clipPre`. Mono downmix math is right; placement is the problem (#5).
- **Transpose, split and velocity curve** are evaluated at noteOn from the `sounding` map. noteOff and pedal-up release
  exactly those voices, including on retiring channels.
- **Pedal re-strike fade (30 ms)** and mono pedal-hold.
- **Engine-core automation anchoring:** every `linearTo`/`glideTo` call site passes an explicit `from`, so it is
  unaffected by the automation.js change.
- **Load at 16 held keys** on piano + pad + organ + drone: 60 voices, 861 nodes, 7 pending timers. Per-note allocations
  are small; strips are 6 nodes.

---

## Prioritized fix list (for the follow-up agent)
1. **#1 param leak on reuse** (`audio.js:494`): reset missing params to defaults. One loop.
2. **#2 + #3 files-mode drone:** track pending elements in `activeEls` and cancel them on fade-out; steal with a fade
   (or grow the pool); clamp the random offset away from the loop end.
3. **#4 restart keeps pad files** (carry `drone.files` into the new Drone, and/or re-evaluate the mode in `attachFiles`).
4. **#5 mono sum before comp/clip.**
5. **#7 predelay per convolver slot**, crossfaded with the IR swap.
6. **#8 lofi engage:** delay the crossfade by the wet latency (~12 ms); fix the `_dryV` anchor.
7. **#9 tape bend:** analytic anchor instead of `.value`.
8. **#6 IR builds off the main thread** (Worker or chunked), IR cache ≥ 12, no inline IR in `preload`.
9. **#10 restart restores wheel, pickup and fade state; #11 setNow the fresh strip's wheel gain at commit.**
10. **#12 additive pins; #13 pre-start guards; #17 retry and timeout for failed samples; #16 reuse drone instruments.**
11. **#14 compensate compressor makeup; #15 lofi headroom; #18–#20 and the nits.**

Regression tests to add alongside the fixes, all in the offline harness unless noted:
- #1: switch between two songs sharing an instrument and assert `inst.getParam === default`.
- #2 (realtime): two `setKey` calls 5 ms apart, then assert exactly one non-paused element above gain 0.01 after the fade.
- #5: assert mono peak ≤ −0.3 dBFS.
- #7: zero-crossing frequency of the reverb input across commit.
- #8: second-difference spike check at lofi engage.
- #9: `e10b`-style lag-emulated bend stream.
