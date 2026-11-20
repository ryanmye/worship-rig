# 2.0 product decisions (owner: Ryan; recorded by the orchestrator)

Decisions that change 2.0's scope. Each names where it lands. Agents: treat these as requirements.

## D1 — Polyphony: 64 notes per sound by default, adjustable (Ryan, 2026-11-20)
- Today (1.x web engine): synth/organ sounds cap at 16 voices (`voice.js`/`instruments.js` MAX_VOICES), samplers at 32
  (`sampler.js` SAMPLER_MAX_VOICES); the oldest released, then oldest held voice is stolen with a 20 ms fade.
- 2.0: default cap **64 voices per slot** for every instrument kind, with a Settings › Audio choice of
  **32 / 64 / 128**. Stealing policy unchanged. Fixed-capacity pools stay (no allocation on the audio thread): size
  them for 128 and enforce the chosen cap at note-on.
- Guard rail (orchestrator proposal, not yet Ryan's word): a global ceiling across all slots, sized from the CPU
  measurement on the oldest supported iPad, so 16 slots x 128 voices cannot overload the audio thread.
- Parity: goldens that never exceed 16 simultaneous voices are unaffected; add one fixture that holds > 16 notes
  under the pedal to pin the new behaviour (no web-engine golden exists for it: unit-test the allocator instead).

## D2 — Audio buffer size selectable, 128 frames available (Ryan, 2026-11-20)
- Settings › Audio gets an explicit **buffer size: 64 / 128 / 256 / 512 frames** (default 128) instead of only the
  latency hint. The engine still renders 128-frame quanta internally (ARCHITECTURE §3, the FIFO already handles host
  blocks that are not 128); 64 means two host callbacks per quantum and needs the FIFO path measured for xruns.
- Apple: AUHAL `kAudioDevicePropertyBufferFrameSize` on macOS, `AVAudioSession.setPreferredIOBufferDuration` on
  iPad (the OS may round it: show the actual value). Reported latency must follow the actual size.
- Contract: the `audio` op gains `bufferFrames`; the `state` event reports the granted size.

## D3 — Up to 16 sound slots per song, scrolling (Ryan, 2026-11-20)
- Today: exactly 4 slots (Keys, Pad, Extra, Bass): `shared/params.js` SLOT_COUNT = 4, fixed arrays in the store,
  scenes, wheels routing, Perform strips, Edit tabs, the native graph's fixed UnitSlots.
- 2.0: a song has **1..16 slots**; new songs start with today's 4; the user adds/removes slots. Perform shows the
  strips in a **horizontally scrolling** row (current 4-strip layout unchanged when a song has <= 4); Edit's block
  tabs scroll the same way. Slot colours/names extend beyond the four roles.
- Lands in: params grammar (`slots.<i>` with i < 16), engine-api.json + ENGINE_CONTRACT, store SCHEMA bump with an
  idempotent migration (4-slot songs stay identical), scenes, wheel/pedal routing, MIDI learn targets, the bridge,
  the native graph (16 slot channels + retiring channels sized for 16), memory budget/pin policy (16 samplers can
  exceed the iPad budget: the cache must cap it), Perform/Edit UI, the web shim.
- Parity: the web oracle stays at 4 slots for goldens; slots 4..15 are tested as copies of the slot-0 path (unit and
  bridge tests), plus a native-only fixture with 16 active slots for CPU and memory.

## D4 — Total voice limit across slots: a Setting, Auto + manual (Ryan, 2026-11-20)
Answers the T00c open question (its numbers are kept below). Ryan chose "add to settings", form "Auto + manual".
- Settings › Sound gets **Total voice limit: Auto | 128 | 256 | 512 | Off** (default Auto), next to the per-slot
  **Voices per sound: 32 | 64 | 128** (D1). Store key `settings.voiceLimit` ('auto' | 128 | 256 | 512 | 'off').
- Engine: `config {voiceLimit: 'auto' | 128 | 256 | 512 | 0}` (0 = off), echoed with the effective number in
  `get state.voiceLimit` / `state.voiceLimitEffective`. At the limit a note-on first applies the per-slot cap, then
  steals the globally oldest released voice, then the globally oldest held voice, in any slot (retiring channels
  included), with the usual 20 ms fade. Allocation-free on the audio thread.
- Auto = a per-profile number sized so the render stays at or under about 60 % of the quantum with the measured
  per-voice cost (desktop/Mac and iPad profiles; provisional values from the Linux bench until the Mac/iPad are
  measured, which stays on the Mac list).
- The web engine (1.x oracle) is unchanged: 16/32 voices, 4 slots; goldens unaffected.

## Settings page restructure (Ryan, 2026-11-20; 2.0 only)
Simplify Settings into **sidebar categories** (one visible at a time, like macOS System Settings; a horizontal tab
strip on narrow/iPad portrait): Sound · Keyboards & MIDI · Sounds & Samples · Look · Library & Backup · Mac (Mac app
only) · About. Every existing setting keeps working; rarely used ones move under an "Advanced" disclosure in their
category. Lands on `v2-native` with the 2.0 Sound options (D1, D2, D4); 1.x keeps today's page.

## T00c measurements behind D4 (was the open question)

Not implemented: D1 as decided is per slot only. The numbers that make the question real (Linux box, 2 vCPU,
g++ -O3, 48 kHz, 128-frame quantum = 2667 µs; ARCHITECTURE 7.1):

- 16 slots with idle strips: 90-100 µs per quantum (3.6 %). 16 slots × 8 test voices: 420-480 µs (17 %).
  16 slots × 64 test voices: **2430 µs (91 %)**: one more step and the audio thread misses its deadline.
- The test voice is the cheapest possible voice (sine + one envelope, ≈ 2.2 µs per voice per quantum). Synth and
  sampler voices cost several of them (T11/T12 publish their per-voice cost), and the oldest supported iPad is
  slower than this box (Mac list). So 16 slots × 64 (the default) can already overload the audio thread when
  everything is held under the pedal; 16 × 128 certainly can.
- Proposal: an engine-wide ceiling N (total live voices across all slots, retiring channels included), sized from
  the per-voice cost on the oldest supported iPad (e.g. the count that keeps the render at ≤ 60 % of the quantum).
  At the ceiling a note-on steals the globally oldest released voice, then the oldest held one, in any slot; the
  per-slot cap still applies first. Cost: one counter per quantum in the Model / graph, a `ceiling` stat.
- Without it, the protection is the per-slot cap alone (16 × 32 = 512 voices at the lowest setting) plus the xrun
  counter in `stats`.

Decided 2026-11-20: a Setting, Auto + manual (D4 above).

## Scheduling
- 2.0 only; 1.1 ships with 4 slots and today's limits.
- These change frozen interfaces, so they land as one serial step **T00c (scale-out amendment)** after the wave-1
  integrator and before wave 2 (T11/T12/T13 build on the amended interfaces). UI work for D3 is a separate task in
  the UI wave.
