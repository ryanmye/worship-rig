# Effects and patch gap analysis against a typical MainStage worship-keys rig (2026-11-26)

This is a read-only analysis; no code changed. It covers 2.x work, after 2.0 ships. Anything rebuilt from purchased
third-party patches is personal content: it lives under the git-ignored `user-samples/` folder, the same rule as
GarageBand content, and never goes into this repo.

New DSP is always built in the web engine first, because it is the oracle. Then the PARAMS row is added, then
fixtures in `native/golden/manifest.json`, then `engine-api.json` is regenerated, then the C++ port. Size: S/M/L.

## What we have and what's missing

**Reverb: yes.** One send reverb using a generated-IR convolver (`fx.js:578`), with size, damp, predelay and return,
and 6 presets.
- Missing: user IR files, hi/lo-cut controls, modulation, a second reverb.
- Size: M.

**Shimmer: no.** The synth-extra "shimmer-pad" is a pad with an octave layer, not an effect.
- Missing: pitch shift inside the reverb's feedback loop.
- Size: L. It needs an AudioWorklet, a bit-matched native port, and new fixtures.

**Delay: partial.** Sync to off, 1/4, 1/8d or 1/8, ping-pong, a low-pass in the loop, feedback up to 0.9.
- Missing: 1/16, 1/2 and triplets, a high-pass in the feedback, separate L/R times, wow/saturation.
- Size: S for the sync values and the high-pass; M for the rest.

**Chorus: partial.** One global 2-voice send.
- Missing: ensemble, a per-slot insert, sync.
- Size: S–M.

**Tremolo: partial.** It exists only inside shimmer-pad.
- Missing: a general, tempo-synced effect.
- Size: M. Needs the insert framework.

**Rotor: partial.** Organ only.
- Missing: rotor on any slot (EP, Wurli) and a speed footswitch.
- Size: M. Organ fixtures must stay byte-identical.

**Phaser: no.**
- Missing: all of it.
- Size: M. Needs the insert framework.

**Drive/amp: partial.** Organ drive and the global master lofi.
- Missing: per-slot drive, amp and cabinet.
- Size: M. Needs the insert framework.

**Compressor: partial.** The master glue, with one knob.
- Missing: a per-slot compressor and threshold/ratio controls.
- Size: S–M.

**Channel EQ: yes.** Per-slot 8-band EQ with cuts, plus a master 3-band.

**Filter sweep on a wheel or pedal: partial.** `macro.intensity` morphs pad-like instruments only.
- Missing: an LFO filter, and any instrument's cutoff on the mod wheel or expression pedal.
- Size: M.

**Expression swell: yes.** Expression drives slot, drone, reverb or master gain with min/max and a curve.
- Missing: more than one target per controller.

**Layer crossfade on the mod wheel: partial.** One target per controller; inverted ranges work.
- Missing: one source driving several targets, as `[{target,min,max}]`.
- Size: S–M. Touches the store, `wheels.cpp` and the UI.

**Arpeggiator/sequencer: no.**
- Missing: all of it, scheduled on the audio clock.
- Size: M. Both engines, plus fixtures.

**Tempo sync: partial.** Delay, click and MIDI clock out follow the song tempo.
- Missing: sync for chorus, tremolo, LFO and the arpeggiator, and MIDI clock in.
- Size: S per effect.

**Splits and layers: yes.** 1–16 slots, each with a key range, octave/transpose and mono modes.
- Missing: velocity ranges per slot.
- Size: S.

**Sampler: partial.** Velocity layers and nearest-root repitch; **one-shot only, no loops**.
- Missing: loops (key for sampled pads and strings), velocity crossfades, round-robin, release triggers.
- Size: M for loops; M for the rest.

**Scenes: partial.** 3 per song, covering levels, mutes, drone and wheel.
- Missing: snapshots of FX and instrument parameters, and more than 3 scenes.
- Size: S for the count; M for FX.

**Sustain behaviours: yes.** Per-slot sustain, pedalHold, release, pedal invert.
- Missing: a latch / "hold until the next chord" mode, and sostenuto.
- Size: S–M.

**Pad player: yes.** The drone `files` mode and the synth drone.

**MIDI learn: partial.** A fixed list of targets.
- Missing: learning any PARAMS path.
- Size: M. No DSP change and no fixtures.

**Per-slot insert chain: no.** Slots only reach the global sends and the master.
- Missing: an insert stage in the strip that disconnects exactly when unused, so the 112 fixtures stay identical.
- Size: L. It is the prerequisite for tremolo, phaser, amp and rotor per layer.

**Third-party AUs: no.** Out of scope.

The web oracle runs 4 slots (DECISIONS D3). Slots 5–16 exist only in the native engine.

## Where personal content goes

**Samples.** `user-samples/<pack>/manifest.json` and `~/Music/Worship Rig/Samples/` (`server.js:235`, `:322`). Both
are already git-ignored and never packaged.

**Patches and songs.** Nothing auto-loads them yet. For now they can sit as song JSON in `user-samples/<pack>/songs/`
and be imported from Settings. A merge creates new ids, so auto-loading the same files at every start would
duplicate songs. The smallest auto-loading pack, size S, needs no DSP and no fixtures:
1. A `GET /api/user-patches` route, advertised in `/api/health`.
2. An idempotent `store.topUpPacks()` modelled on `topUpFactory`, with a stable `packId` per song.

## Importer status

**Verified:**
- `tools/exs` reads `.exs` only. The parser was checked against 6 real Apple instruments
  (`docs/garageband-import.md`). CLAUDE.md still says "synthetic only"; that line is stale.
- Loop points are parsed but then dropped (`mapping.mjs:104`).
- Also dropped: pedal groups, release triggers, fine tune, per-zone pan and velocity crossfades.
- A third-party `.exs` with its audio under the search roots would very likely import as it is.

**Not verified:**
- Newer Logic Sampler chunks.
- `.aupreset`, `.cst` and `.patch` blobs, and the `.concert` layout.
- How MainStage refers to sampler instruments.

A realistic first step is a "list the instruments this concert uses" report built from real files on the Mac. Effect
settings would be rebuilt by hand from MainStage's UI, not decoded.

## Suggested order

1. Patch-pack auto-load (S).
2. Delay sync values and a feedback high-pass (S).
3. Per-slot velocity range (S).
4. Multi-target wheel/expression for crossfades (S–M).
5. MIDI learn for any PARAMS path (M).
6. Sampler loops, with the importer carrying loop points through (M). This is the biggest win for imported pads and
   strings.
7. Per-slot insert framework (L), then tremolo, autofilter, drive, phaser and rotor (S–M each).
8. Scenes that cover FX (M).
9. Arpeggiator (M).
10. Shimmer (L).
11. A concert reader (L; needs real files on the Mac).
