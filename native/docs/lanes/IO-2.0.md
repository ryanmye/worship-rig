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
