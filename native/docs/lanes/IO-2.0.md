# IO-2.0: multiple audio outputs and per-layer keyboard assignment (D42)

Two 2.0 lanes Ryan added on 2026-11-28. Both need an engine change, so in 2.0 both are **native only** (Mac first).
The web engine (`app/js/engine`, the golden oracle) stays frozen until the 2.0 tag (D13). In the Chrome version both
pickers are hidden: the controller hides them when the engine doesn't advertise the feature.

## Shared rules

- With nothing set (every layer on Main and on Any keyboard), the native engine's output must be bit-for-bit what it
  is today. The fixtures stay byte-identical; the oracle covers that default path.
- The new store fields are optional and stay absent until they are set (CLAUDE.md "Store schema"), so there is no
  SCHEMA bump. A schema-1/1.x library migrates unchanged.
- The engine contract changes (`native/contract/engine-api.json`) are additive, with a contract version bump and a
  CONTRACT_CHANGES section with measurements.
- Neither feature can be tested without hardware: an interface with more than 2 outputs, and two keyboards. Both need
  Ryan's hands-on test (add them to MAC_CHECK step 4).

## Lane OUT: multiple / configurable audio outputs

- **The host.** The Mac host opens up to the interface's output channel count; today it opens 2, or 4 for the aux
  click (`rig_apple_audio.c`, `RIG_MAX_OUTPUT_CHANNELS`). On the iPad it stays 2 in 2.0 and gets USB multichannel in
  2.0.x. On Windows it comes with the WASAPI host.
- **Routing.** Each layer, the drone and the click (which already has main/aux) gets an output pair: Main, Out 3–4,
  Out 5–6, and so on.
  - A layer routed to another pair takes its effects with it. Each output pair in use gets its own copy of the master
    effects (reverb/delay/chorus, EQ/comp) fed by that pair's layers' sends. A copy costs CPU only while the pair is
    in use; measure the cost and record it.
  - Example: pads on Out 3–4 carry the pads' own reverb on 3–4.
- **Storage.** The song stores the pair number (`slots.<i>.output`, `drone.output`, absent = Main).
  - The pair names are kept per device ("Out 3–4: Pads to FOH"): an interface-specific setting, kept with the
    device-local settings.
  - If the current interface lacks the pair, the audio plays on Main and Rig shows one warning.
- **Tests.**
  - With everything on Main, the output is identical to today's.
  - The outputs summed equal the normal mix (with tolerance ≈1e-5, CLAUDE.md caveat).
  - Pair fallback when the interface has fewer outputs.
  - The CPU cost per extra pair.
- **Estimate:** 3–5 agent-days for the Mac [E].

## Lane KBD: assign a layer to a keyboard / MIDI channel

- Each layer gets a Keyboard setting and a Channel setting.
  - Keyboard: Any (default) or a keyboard by name. It is kept by name because ids change on re-plug; the existing
    `midiInputId` rebind logic already matches by name.
  - Channel: Any or 1–16.
  - Works with Settings › Keyboards & MIDI on "All inputs".
- **This is an engine change** (corrects my first estimate to Ryan, which said it needed none).
  - Today the engine's `noteOn(note, vel, {when, touch})` plays every layer whose key range has the note, and it tracks
    held/sounding notes by note number only (`audio.js` noteOn).
  - Per-keyboard layers need `noteOn`/`noteOff` to carry the source (keyboard + channel). The engine then plays only the
    layers that accept that source.
  - Held, sounding and pedaled notes must be tracked per source, so the same note on both keyboards doesn't cut itself
    off. The controller already tracks held notes and the pedal per source (`heldBySrc`, `pedalBySrc`).
- **Store:** `slots.<i>.keyboard` (a name) and `slots.<i>.channel` (1–16), both absent = Any.
  - If the named keyboard isn't connected, that layer plays from any keyboard and Rig shows one warning, so a song
    never goes silent.
- **Tests:**
  - with every layer on Any, the output is identical to today's;
  - two simulated inputs route to their own layers;
  - the same note on both keyboards;
  - the pedal on one keyboard doesn't hold the other's notes;
  - unplugging one keyboard mid-note releases its notes.
- **Estimate:** 1–2 agent-days [E].

## Lane TOUCH: Pianoteq-style keyboard calibration + dynamics in dB (D43)

Ryan, 2026-11-28, on his Roland FP-10: soft notes too loud, and hard notes don't get louder. Copy Pianoteq's two-part
model as it is ("instead of creating another simplified version just with more variables").

**1. Per-keyboard calibration curve**
- Piecewise-linear velocity → velocity, monotone, with 2–12 points.
- Kept in `settings.keyboards[<device name>]`, device-local like today's per-keyboard touch.
- Applied in the controller before the engine; the engine then gets the calibrated velocity on the linear curve.
  - So it needs no engine change and works in Chrome and native.
  - The layers' own `velocityCurve` / `touch` still apply after it.
- **Text format:** Pianoteq's `Velocity = [in…; out…]`, for both paste and copy. Community curves for many keyboards
  exist in it; an example for the FP-10 is `[0, 1, 18, 32, 50, 108, 127; 0, 0, 30, 57, 84, 127, 127]`.
- **Assistant:** five steps, silence threshold, p, mp, f and fff.
  - The player plays several notes at each level; Rig takes the median for each.
  - Those medians map to fixed targets, with Pianoteq's p/mf/f reference points at 32/64/96. Pick the fff target and the
    silence point so playing harder than f still gets louder. Don't clamp at the median hard note: that is the current
    fit's flaw.
- **Editor:** drag points on a graph, with numbers for each point and presets (Linear plus the old named curves as
  points), plus a live velocity readout and a histogram of the last ~200 notes.
- **Migration:** an existing `{shape, min, max, top}` keyboard curve keeps working as it is. A curve becomes points only
  when the player saves a new one.

**2. Dynamics in dB**
- `settings.dynamicRange` (device-local, today 1..3 × the built-in span) is shown as dB: the span from the softest to
  the loudest note. Built-in spans are 10 dB (multi-layer) and 24 dB (single layer), see `shared/touch-curve.js`.
- Raise the limit so multi-layer instruments can reach about 60 dB (Pianoteq's default; range ≈ 6).
  - `DYN_RANGE.max` in shared.
  - The native `Model::setDynamicRange` clamp (bridge.cpp / schema.cpp say 1..3), plus `mock-native.js`.
- `app/js/engine` code stays as it is. Values ≤ 3 play bit-for-bit as today, so the fixtures don't change.
- Check the master ceiling/limiter with ~60 dB at the loud end and record peak levels in CONTRACT_CHANGES.
- Decide and record in CONTRACT_CHANGES whether to show the setting as one dB number for both instrument kinds or as a
  multiplier. Single-layer instruments would reach 144 dB at 6×, so the single-layer span probably needs its own cap.

**Tests**
- With no curve set, the output is identical to today's.
- A pasted Pianoteq string matches its points, and copying it back out returns the same string.
- The curve is monotone; bad input is refused.
- Assistant fits on synthetic velocity sets, including a light board that never sends 127.
- dynamicRange > 3 on web and native agree within ≈1e-5.

**Then:** Ryan's FP-10 test (MAC_CHECK step 4). **Estimate:** 2–3 agent-days [E].

## Lane TOUCH2: a fuller custom touch (D48)

Ryan, 2026-11-28: "add a custom touch but make it more comprehensive. look at how other apps do this", then "add".
It builds on TOUCH (D43, merged c64aa857). Everything is applied in the controller before the engine, so
`app/js/engine` doesn't change and it works in Chrome and native. It runs after lane KBD, because both change the
controller's MIDI note path.

Models it copies:
- the Studiologic SL88: keyboard sensitivity ±25 % relative to the current curve; black/white balance plus per-key
  sensitivity; 6 user curves; a programmable Fixed value;
- MainStage's Velocity Processor: Scale/Add and Compress/Expand;
- PianoTuner: a cut-off velocity and a maximum-velocity slider;
- Kawai's VPC editor and VelPro: key velocity offsets and per-key curves.

1. **Shape sliders on top of the points curve:**
   - Lighter ↔ Heavier: relative sensitivity, about ±25 %.
   - Squeeze ↔ Spread: compress/expand around the middle.
   - Silent below: the cut-off.
   - Loudest: a cap.

   They transform the saved points, not the raw velocity a second time, and the graph shows the result live. Store the
   sliders next to the points so they can be undone. The pure maths goes in `shared/velocity-cal.js` and stays
   monotone.
2. **Key balance, per keyboard** (device-local):
   - a black/white offset;
   - an 88-key per-key offset strip, ±20 velocity steps or a %;
   - an "Even out" assistant: play each key once at the same strength, take the median, and suggest offsets toward the
     keyboard's median. The player keeps or undoes them.

   The offset applies to the raw velocity before the curve. It works by MIDI note number, so it follows physical keys,
   not transposed notes.
3. **Curve library:**
   - Named curves saved on this device.
   - Pick one per keyboard (today's default) and, optionally, per layer: a `slots.<i>.velocityCurve` value naming a
     library curve.
   - A per-layer curve must not apply twice with the keyboard curve: define and test the order (keyboard calibration,
     then the layer curve).
   - Export/import of a library curve as Pianoteq text.
4. **Fixed:** a value from 1 to 127 (today it is fixed at 100/127).

Leave out release velocity: no Rig instrument uses note-off velocity (check and record the result).

**Tests:**
- With nothing set, the output is identical to today's (TOUCH curves play the same).
- Sliders keep the curve monotone.
- Key-balance offsets clamp to 1..127 and never turn a sounding note silent unless the cut-off says so.
- The Even out assistant behaves on synthetic uneven boards.
- The library curve per layer combines with the keyboard curve as intended.

**Then:** UI in the old layout and v6, then Ryan's FP-10 check in MAC_CHECK step 4. **Estimate:** about 2 agent-days
[E].
