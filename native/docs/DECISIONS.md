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
- **Measured (Mac check #2, 2026-11-21, `MAC_CHECK.md` Results):** Ryan's M2 Pro, Core Audio, a USB-C dock at
  44.1 kHz: 64 / 128 / 256 / 512 frames granted exactly, 0 late callbacks and 0 xruns at every size, latency 2.9 / 5.8 /
  11.6 / 23.2 ms; **64 frames measured safe** on the Mac (`d2_64_frames.safe`). The default stays 128. iPad
  (AVAudioSession rounding) not measured yet.

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
- **Measured (Mac check #2, 2026-11-21):** warm-pad costs **4.82 µs per voice per quantum** on Ryan's M2 Pro (Linux
  box ≈ 9 µs); `rig-probe` suggests desktop Auto **256** (raw 271). **Desktop Auto stays 128 for now**
  (`kAutoVoiceLimitDesktop`, `mock-native.js AUTO_VOICE_LIMIT`): the 60 % sizing covers the steady state only, the
  burst of steal fades + voice construction (D4 review R1) is not measured on the Mac, and `unit.voice-limit-cpu`
  holds the budget on the Linux box (fit 125-154 there). The Mac measurement supports 256: **orchestrator / Ryan
  decision** (needs a timed large layered chord on the Mac first). iPad 64 stays PROVISIONAL (no iPad probe yet).

## Settings page restructure (Ryan, 2026-11-20; 2.0 only)
Simplify Settings into **sidebar categories** (one visible at a time, like macOS System Settings; a horizontal tab
strip on narrow/iPad portrait): Sound · Keyboards & MIDI · Sounds & Samples · Look · Library & Backup · Mac (Mac app
only) · About. Every existing setting keeps working; rarely used ones move under an "Advanced" disclosure in their
category. Lands on `v2-native` with the 2.0 Sound options (D1, D2, D4); 1.x keeps today's page.

## D5 — Drone freeze kept, with a Settings toggle (Ryan, 2026-11-21; answers Q7)
- Keep 1.x's drone freeze (low-resource mode renders a short loop of the drone and plays it instead of the live
  synth). `drone-freeze-dry/-wet` stay native fixtures and must pass (T16).
- Settings › Sound › Advanced gets **Freeze drone to save CPU** (store `settings.droneFreeze`, default on = 1.x
  behaviour: freeze whenever low-resource mode is on; off = always the live drone). Engine: `config {droneFreeze: bool}`
  (T16, contract + bridge row); the toggle itself lands with the UI wave.
- D4 follow-up (Ryan, 2026-11-21): desktop Auto stays **128**; 256/512 remain manual choices in Settings.

## Orchestrator decisions for wave 3 (2026-11-21)
- **O-W3-1 voice addressing (T12 O3):** additive `Instrument::fadeNote(int note, std::int64_t frame, float seconds)`
  (default no-op) behind a core `Op::FadeNote` (note in `a`, seconds in `f`), implemented once in `VoicePool` and used
  by synth, sampler, organ, synth-extra; no new audio event. T14 owns the Model side and lands the additive
  frozen-header change (marked `INTERFACE-CHANGE(T14)`); T15 wires it into its instruments.
- **O-W3-2 drone low-resource hook (T13 O6):** `SongState.lowResource` (additive, set by the Model before
  `forEachService`, like `newBar`) plus `config {droneFreeze}`; `DroneService` reads both. T16 lands it
  (`INTERFACE-CHANGE(T16)`).

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

## Away-week decisions (tier 2, orchestrator; AWAY_WEEK_PLAN §1; easy to reverse)
- **O-AW-1 (Lane C, 2026-11-23): chart import = ChordPro + plain chord-over-lyrics text, plus an optional
  WorshipTools song-list CSV.** WorshipTools has no public API and no bulk export; songs come out as ChordPro, one at a
  time, from Planning's editor (`lanes/C1-worshiptools.md`). So there is no WorshipTools-specific format, and no
  account, key or terms are involved. `{key}`/`{tempo}` are optional on import; a missing tempo is asked for.

## D6: Setlist switching is "Cue, then Go" (Ryan, 2026-11-22; Lane S, tier 1)
- Of the three mockups (<https://claude.ai/artifact/QcJTbknF8qXJ9sb47THV6e>), Ryan picked **C. Cue, then Go**.
- How it works:
  - Tapping a song cues it, and nothing changes until **Go**. Go is a large button or a footswitch.
  - Each song shows its load state: playing, cued, ready, loading or not loaded.
  - Go waits until the cued song is ready.
- Ryan does not like the rest of the mockup UI around it. The visual design gets a separate pass later, with Ryan.
  Lane S builds the cue/go behaviour and its state first, and keeps the look provisional.

## D7: Chart view ships in 2.1, built ahead of time behind a hidden setting (Ryan, 2026-11-25)
- **2.0 scope is unchanged.** The chart view is the first 2.x feature.
- **Two steps:**
  1. A chord-chart view with transpose that follows Easy Transpose, auto-scroll and big type.
  2. PDF attachments.
- **Real notation (MusicXML) goes to the backlog.**
- The view is built now behind a hidden setting, off by default, so it can't affect 2.0.
- **The UI is provisional.** Ryan wants to design it together later; the build covers behaviour and plumbing only.
- **O-AW-2 (Lane S, 2026-11-25): with a cue set, a learned `nextSong`, → and the menu/global Next also GO the cue.**
  Before this, only the on-screen GO played the cue; a 1.x footswitch mapped to `nextSong` played the neighbour of the
  playing song and silently dropped the cue (review S-cue-go S5). `prevSong` clears the cue and steps back.
- **O-AW-3 (Lane S, 2026-11-25): existing 1.x Program Change users keep "switch".** A library with
  `programChange: true` and no `programChangeAction` is treated as `'switch'`. Turning PC on in 2.0 writes `'cue'`.
  Review S6: a silent change to cueing would leave program-button users with no GO within reach mid-service. No SCHEMA
  bump.
- **O-AW-4 (Lane S / core, 2026-11-25): song load state on 2.0 comes from a shim fallback for now.** The native core
  never emits `load {phase:'samples'}` (ENGINE_CONTRACT §6, review S-cue-go S3), so every sampler song read "not
  loaded". After each preload the shim asks `get sampleStatus` and fills `_loaded`. The core emitting the event, as
  the contract requires, is an open core item that is done after CORE3 lands; the shim fallback stays as a
  belt-and-braces measure.
  - Lane F1 (2026-11-25): the core now emits it (after a preload's decodes, once a prepare's samples settle, after
    a pin re-warm pass), with no contract minor bump: the shape was already in ENGINE_CONTRACT 6.5 and the shim
    treats the event as optional. The fallback stays. CONTRACT_CHANGES "Lane F1", INTERFACE_LOG "F1".
- **O-AW-F1 (Lane F1, 2026-11-25): the native shell keeps the newest 10 library backups, as main.js does
  (was 3).** Review E5 open item 4: after a replace import, the debounce backup of the imported library plus two
  more pushed the pre-import backup out. The other option was a `rig-preimport-*` file kept apart from the
  rotation. Chosen: 10, because:
  - it is the rule the Electron app already uses and that SHELL.md promised ("same rotation as main.js"), so the
    two shells and the JS stand-in (`test/phase2/migration-1x/lib.mjs`) stay one contract;
  - it needs no app/js change. A separate pre-import file needs a new `backupNow` kind from the controller, the
    Electron side to match, and a rule for when that file is pruned and how `latestAnywhere` ranks it;
  - the pre-import backup now survives 9 more backups. The controller writes at most one per 10 minutes of editing
    plus one per window close, so that is about 1.5 hours of continuous editing (less with many window closes),
    where 3 was about 20 minutes;
  - the cost is small: a library is at most ~2 MB (the store cap), so 10 files are ≤ ~20 MB, in Application Support
    on the Mac and in the app's Documents/Backups on the iPad.

  Easy to reverse: one constant, `RigBackups.keepLibrary`. A dedicated pre-import file can still be added later if
  Ryan wants a restore point that never rotates.
- **O-AW-E5 (Lane E5, 2026-11-25): Settings › Import… of a whole library into the untouched factory library
  replaces it.** Before this it merged. A 1.x export then became 19 + N songs (the 1.x factory copies doubled), its
  setlists were renamed "(imported)", and its settings were dropped: MIDI Learn, Program Change, theme, touch and
  pedal. The rule:
  - Only a library file with songs counts, and only into a `pristine` seed (meta.edited false). Device-local
    settings are kept, as in every replace.
  - Into an edited library, Import… still merges.
  - Edit's setlist-panel Import is unchanged (merge).
  - It is a store option, `importJSON(text, {replacePristine:true})`, so this is easy to reverse.
  - No SCHEMA bump.
  - E5 skeptic (reviews/E5-migration.md): tier 2 confirmed. No backup is written on this path, and none is needed:
    every write of library content (songs, orders, setlists, MIDI Learn, Program Change, latency, view…) clears
    `pristine`, and that is persisted. What a pristine library can hold is factory songs (re-addable from Edit ›
    Factory…), navigation, device-local settings (kept) and the theme. The theme is the one 2.0 choice the replace
    overwrites; the release notes say so.

## D8: 1.1 ↔ 2.0 in one Chrome profile: fix in 2.0, plus a 1.1.1 patch (Ryan, 2026-11-25; review E5 M4)
- **The problem.** Switching back and forth between 1.1 and 2.0 in one browser profile hides each version's library
  in a backup key. After two round trips, both copies are pruned.
- **The 2.0 fix:**
  - a migration copy is never pruned;
  - a "Restore previous library" action;
  - a warning in the release notes.
- **The 1.1.1 patch.** 1.x refuses to overwrite a library with a newer schema, and offers to keep it.
- **Not yet approved: publishing the patch.** Pushing `main`, tagging and releasing 1.1.1 each still need Ryan's OK.
  Until then, the patch is prepared on a local branch.

## D9: The library size cap warns and still allows restores (Ryan, 2026-11-25; review E5 M3)
- **Saves.** A save that pushes the library past 2,000,000 characters warns but is not refused.
- **Imports.** An import or restore of the library's own backup is allowed up to 1.25× the cap.

## D10: A full browser storage refuses the save (Ryan, 2026-11-26; review D8-D9 K2)
- When storage is completely full, 2.0 refuses the save. It warns and keeps the last good save. It never deletes a
  distinct kept library to make room.

## D11: 1.1.1 is approved to publish, and it also exports 1.x's per-machine settings (Ryan, 2026-11-26)
- **Approved.** Ryan approved pushing `main`, tagging `v1.1.1` and the GitHub release that release.yml makes.
  This is a one-time override of the pre-push guard, for `main` and that tag only.
- **Order.** The release waits until the settings export below is built, reviewed and green on main's `test.yml`.
- **Settings export.** 1.1.1 also writes the device-local settings into its backups and exports, and 2.0 imports them.
  - Covered: touch curves, click, MIDI clock, hotkeys, MIDI and audio devices, the pad folder, menu-bar mode and the
    rest.
  - Not covered: settings that only make sense on the same machine, which is the reason they were device-local.

## D12: The chart view matches through the relative key (Ryan, 2026-11-26; chart-view review V1/O2)
- An Em chart on a song set to G lines up with the G drone. The chart header may show "Key Em".

## D13: 2.x effects work waits for any engine change until 2.0 ships (Ryan, 2026-11-26)
- FX-gap steps 2–4 change the web engine, which is the golden oracle. They start after the 2.0 release:
  - 2: delay sync values and a feedback high-pass;
  - 3: per-slot velocity ranges;
  - 4: one wheel driving several targets.
- Steps 1 and 5 need no engine change and are in progress now:
  - 1: patch packs, with the song settings bank folded in;
  - 5: MIDI learn for any parameter.
