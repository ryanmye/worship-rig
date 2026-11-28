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
- **Superseded on when it ships: D33 (2026-11-27) moves step 1 to 2.0** (task C-SHIP: on by default, Settings ›
  Perform › Chord charts; CONTRACT_CHANGES "C-SHIP (D33)"). The rest of D7 stands.
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
- **O-AW-F2 (orchestrator, tier 2, Lane F2, 2026-11-25): the core reports eviction, trim and rate changes with
  `load {phase:'samples'}`.** Review F1 open item 1: a sampler evicted at the cache cap or trimmed by
  `rig_host_memory_pressure` kept a setlist chip "ready", and a rate change left one "loading", until the next preload
  or prepare. The other option was a shim re-ask on a `state` sampleRate change, which covers rate changes only.
  Decided:
  - the core emits the samples event whenever a known sampler's loaded state changes because of eviction, a trim or
    a rate change, naming only the ids whose state changed ("known" = the core already told the shim about it, by an
    event or a one-sampler `get sampleStatus` answer);
  - coalesced, at most one such event per control tick;
  - sent from the control thread, with no lock added on the audio path;
  - the shim's `sampleStatus` fallback stays as it is.

  No contract minor bump: same event, same shape (ENGINE_CONTRACT 6.5). CONTRACT_CHANGES "Lane F2", INTERFACE_LOG
  "F2", SHELL.md G5.
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
- **O-AW-ML (2.x step 5, 2026-11-25): MIDI learn for any continuous PARAMS path.** FX-gap-analysis "MIDI learn",
  CONTRACT_CHANGES "MIDI learn any param (2.x step 5)". The rules:
  1. **Model.** A mapping is `settings.midiLearn[<path>] = {cc, channel, min?, max?, invert?}`. The key is a §4 path in
     the current-song grammar (`slots.1.sends.reverb`, `fx.delay.feedback`). A path is learnable when its PARAMS row
     is numeric with a finite min < max and is not a switch, a choice, a whole-number step (octave, transpose, note
     range, touch.top) or the dynamic `slots.<i>.params.<key>` row (`shared/learn.js isLearnablePath`). The fixed
     LEARNABLE rows, their stored `{cc|note, channel}` and their behaviour are unchanged. New fields are optional; no
     SCHEMA bump; `migrate()` stays idempotent and keeps unknown ids and fields.
  2. **Scope: the mapping follows the current song.** `slots.<i>.*` acts on slot i of whichever song plays, `fx.*`,
     `drone.*` and `master.volume` on that song's own values. A song without slot i (or with it empty) is a no-op.
     This is the rule the UIA slot levels already use. Not chosen: binding a mapping to one song. That would need
     song-keyed ids and a second lookup, and per-song changes are what scenes are for. Easy to reverse: an optional
     `songId` field can be added later (migrate keeps unknown fields).
  3. **Value.** CC 0..127 runs from the mapping's min to its max (the row's when absent) along Edit's slider curve:
     2·pos³ for gains shown in dB, log for log rows (Hz, Q, times), else linear. `invert` runs it backwards. min > max
     is allowed. The result is clamped to the row. With no min/max/invert, a level is exactly the 1.x learned fader.
  4. **One CC, several params.** When the first mapping on a CC is a fader, every fader mapping on that CC moves (one
     knob opens the reverb send and the delay feedback together). A button mapping keeps the 1.x first-match rule.
     Skeptic C1: a CC or note holds either one button or any number of faders. A learn clears the mappings of the
     other kind (or another button) on that control and its overlapping channels, and it reports them.
  5. **Writes.** Through `store.set` (clamped), then the controller's store→engine diff, like a slider drag. So a knob
     edits the song (changed dot, Revert undoes it), as a learned level fader always has. Wheels stay live-only. A
     custom path writes at most once per 20 ms (`LEARN_WRITE_MS`) with a trailing write of the last value. The fixed
     rows are not throttled. A song switch drops a pending write, from the moment the store selects the next song
     (skeptic S1), and the knob picks up again there. Pickup (soft takeover) applies to every learned
     fader. A current value no CC stands for (release's null = the instrument's own) is taken over at once. Pedal
     hold runs on its slider's track, with 'natural' at the top (skeptic L1). A value outside the mapping's range
     picks up at the nearer end.
  6. **Perform Lock.** No learning under the lock: `controller.learn` refuses (`{error:'perform-locked'}`), turning
     the lock on cancels a pending learn, and Edit's menu does not open. Learned controls keep playing.
  7. **UI (provisional).** Edit: right-click, Ctrl-click or long-press a slider, fader or chip whose `data-bind` is
     learnable → Learn MIDI knob / Forget. Long-press is Chromium only: WebKit on iPad touch fires no `contextmenu`,
     so the iPad needs its own gesture before it ships (skeptic open item O1). Settings › Keyboards & MIDI › MIDI Learn lists the custom mappings under
     the fixed rows, with Learn and Remove. min / max / invert have no UI yet (store and controller only).

- **O-AW-PP (patch packs, 2026-11-25): auto-loading personal patch packs and a Song bank (FX-gap-analysis step 1,
  plus Ryan's "song settings bank" scope).** Layout and user-facing rules: `docs/patch-packs.md`. Interfaces:
  CONTRACT_CHANGES "Patch packs (2.x step 1)". Tier 2, and easy to reverse: everything sits behind the
  `'user-patches'` health feature and one optional `meta.packSongs` map, with no SCHEMA bump.
  1. **Identity.** `packId = <pack folder>:<file>`, plus `#<n>` (counting from 0) for an entry of an array file.
     Renaming the folder or the file makes a new song. Reordering an array re-keys its entries, so authors should
     append.
  2. **Once.** Every pack song the library takes in is recorded in `meta.packSongs` and never pruned. An auto song
     is added once, at the end of the library order, in no setlist. This mirrors `topUpFactory`'s version-gated
     "once".
  3. **Edit protection.** At write time the store records `sig = songFingerprint(song)`: a hash of every stored
     field except `id`, over key-sorted JSON. If the current fingerprint differs, the song was edited, and a newer
     pack version never overwrites it. Any persisted change counts, including mutes, levels and key. Undoing an
     edit by hand makes the song updatable again. If a future normaliser changes stored songs, they read as edited:
     the safe direction.
  4. **Update in place.** The rule is "content changed", not "mtime changed": the server's `hash` is over (schema,
     song, bank). An unedited song with a new hash is replaced under the same id, keeping its library position and
     setlists. This also happens on a Rescan while the song is current: Rescan is the player's own action. A
     touched file with no changes does nothing.
  5. **Delete memory.** A deleted pack song keeps its record, so it is never added or updated again. A pack folder
     that is gone changes nothing. A whole-library replace (restore, or O-AW-E5's pristine import) replaces `meta`
     too, so the packs are taken in afresh afterwards.
  6. **Pack writes are not edits.** Top-ups use the seed path, so an untouched factory library stays `pristine`.
     Its pack songs can be rebuilt from the files, so the pristine rules for backups and O-AW-E5 still hold. A
     Song bank add is the player's choice and does count as an edit.
  7. **Bank mode** (`pack.json` `"mode": "bank"`). These songs are never auto-added. **Add to library** copies one
     song with the same record, so rules 3 to 5 apply to it from then on. If the song is already in the library,
     Add returns it. Adding again after a delete is allowed, because it is an explicit request; top-ups still never
     bring it back. Switching a pack from bank to auto adds its unrecorded songs, and never ones that were deleted.
  8. **Bank metadata** `{title, artist, ccli?, originalKey, bpm, timeSig, tags[]}` sits beside `song` in the export
     envelope, so a plain song file imports as before. It is for browsing only and is never written into the song;
     the song body holds the key, tempo and time signature. Bad fields are dropped, and `title` falls back to the
     song name. Search matches every word in the title or artist, ignoring case and accents. The picker UI is
     provisional.
  9. **Gating.** `/api/health` advertises the feature only when a pack has `songs/*.json`. Without packs nothing is
     requested and the library is unchanged. The native shell (rig://) says `userPatches: false` until it serves My
     Samples. A muted second window reads but never writes.
  10. **Bad input.** Malformed, over-cap or future-schema entries are skipped with a warning. Other entries in the
     same file still load. A song that would overflow the 2 MB library cap is skipped without a record, so it is
     tried again later.

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

## D14: Design philosophy: single sound at the desk comes first (Ryan, 2026-11-26)
- See native/docs/DESIGN_PHILOSOPHY.md.
- **Priorities:**
  - daily desk practice and play-along with one sound;
  - worship nights with one sound all night;
  - song switching as secondary, kept in the background.
- **Main screen:** one sound plus its quick tweaks:
  - pad blend;
  - reverb;
  - tone;
  - transpose and sustain/pad hold.
- **Sound switching:** a full sound browser.
- **Menu bar:** a mini Perform.
- **iPad:** mirrors the Mac in landscape and portrait, as a standalone rig.
- **Recording ideas:** moves to 2.y, after the instrument controls get simpler.

## D15: Modular UI; all sounds are equal instruments (Ryan, 2026-11-26)
- There are no role labels outside the instrument chooser: no Keys/Pad/Extra/Bass and no "pad underneath".
- Every layer is the same instrument card, and the shared cards sit beside the layers.
- Cards can be arranged: show/hide, reorder and resize, with the layout saved.
- Perform, the menu bar and the iPad all use the same modules.
- Each card is a self-contained component.
- This supersedes the role-specific "Pad underneath" card in the first Perform design pass.
- Details are in DESIGN_PHILOSOPHY.md, "Modularity".

## D16: Perform v6 direction: the instrument strips are the main screen (Ryan, 2026-11-26)
- Mockup: `native/docs/design/mockups/perform-v6.html` (artifact "Perform v5 mockups"). Ryan: "looks like something
  i will use". It replaces the v3/v4 card layouts; the open v3/v4 questions lapse unless they come back.
- **Strips fill the stage**, Sunday Keys-style. Each keeps today's channel strip: ON tile, vertical fader + meter,
  dB, the 2×2 Space / Echo / Octave / Sustain buttons, Change and ⋯ (Earlier, Later, Duplicate, Open in Edit,
  Remove). Colours go by position, never by kind of sound (D15).
- **More than 5 instruments scroll sideways** at the 5-across width, with a row of name pills that shows which are on
  screen and jumps on tap.
- **Left sidebar:** a Quick button (today's Quick sheet: This song / This Mac / If something's wrong, opening over the
  strips so nothing reflows) above today's wheel column (wheel, what it drives, Swell, pedal).
- **Right sidebar:** one module at a time as tabs, collapsible to an icon rail; ⋯ chooses and orders the modules
  (Drone, Setlist, Notes, Tone, Snapshots; Chart in 2.1, now 2.0: D33). Drone keeps today's key grid, Synth /
  My Pads and Keep across songs.
- **Song bar** holds key, Transpose and the Space room; snapshots get their own row with Update / Save as new.
- **Kept from today:** the bottom keyboard (range bar per instrument, key letters, held notes), Revert / Fade out /
  PANIC / Lock, and the menu bar popover unchanged.
- **The right sidebar is resizable** (Ryan, same day): drag its left edge, between 200 px and 62 % of the stage;
  dragging below 200 px folds it to the rail. Strips never shrink below 150 px; past that they scroll.
- **The snapshots row folds** (Ryan, same day): ⌃ folds it into one "Snapshot: <name> ▾" chip in the song bar
  (gold dot when edited); ▾ brings the row back. With it and the right sidebar folded, the strips get the most room.
- **Chart placement is the player's choice** (Ryan, same day): on the stage (instruments become live mini faders) or
  as a sidebar tab; "⇥ Sidebar" / "⤢ Stage" in the chart header switches it, remembered per device.
  Mockup: `native/docs/design/mockups/chart.html`.
- **Chart text size is one tap away, in percent** (Ryan, same day): an always-visible small A / % / big A group
  steps 50 · 60 · 75 · 90 · 100 · 110 · 125 · 150 · 175 · 200 % of a default size (100 %; the sidebar opens at 75 %);
  tapping the % (or ⌘0) goes back to 100 %. **Fit** picks the biggest step whose longest line fits the width; pinch,
  ⌘+ / ⌘− and ⌘-scroll work on the chart with a brief "Text 150 %" readout. Remembered per device (as today).
  Implementation note: the hidden chart code stores a px index (CHART_FONT_STEPS); it moves to a percent of a base.
- Still open: whether "you play C" moves into the new song bar (proposed, not yet drawn).

## D17: Song bank: a browser over the stage; Try it replaces the sound (Ryan, 2026-11-26)
- Mockup: `native/docs/design/mockups/song-bank.html` (artifact "Song bank mockups"). Ryan: "looks good".
- Opens over the stage (keyboard row and PANIC stay live) from **Setlist › + Add song › From the Song bank** and
  from **Settings › My Samples** (replacing today's plain list there). Filters: search, key, tempo, feel tags, packs;
  a "Song bank | My library" toggle reuses the browser for the player's own songs.
- **Try it replaces** what is playing, as a trial: nothing is saved, and a banner offers Keep it (add to library),
  Add to setlist, or Back to the previous song (restored exactly, like Revert).
- Data is the existing O-AW-PP bank metadata; no schema change is implied by the design.

## D18: Each instrument's edit has a short category list (Ryan, 2026-11-26)
- Mockup: `native/docs/design/mockups/edit.html`, tabs "Instrument · …" (artifact "Edit mockups").
- In Edit, the selected instrument's panel gets a category list on its left: Sound, Tone EQ, Range, Touch, Sustain,
  Space & Echo, Advanced. Each row shows its current setting under the name and a dot when it changed since the song
  began; the chosen category fills the middle, the Perform strip stays on the right. On iPad portrait the list
  becomes a row of tabs. Purpose: always visible what is being edited.
- **Range uses a real keyboard** (Ryan, same day): Edit › Range shows an 88-key keyboard (A0–C8) with the
  instrument's range as one coloured bar with a handle at each end; keys outside it are dimmed. "Set lowest / highest
  by playing" and the note boxes stay.
- **The range colours on Perform's keyboard are draggable** (Ryan, same day): each instrument's bar above the bottom
  keyboard has a handle at each end; dragging shows "Sub Bass · C2–C5" and sets that instrument's range. Same for
  every screen with the bottom keyboard. Snaps to keys; touch targets are 34 px despite the thin bars.
  **On iPad, tap the instrument first** (Ryan, same day): its strip gets an outline and "changing range", only its
  bar is grabbable (26 px handles), the others dim; tap another instrument to switch, tap the keys to finish.
- **Drone, Effects and Master use the same category list** in Edit: Drone (Key & sound = the sidebar's Drone
  module, My Pads, Behaviour), Effects (Space, Echo, Sends table), Master (Volume & output, Master EQ, Glue, Wheels &
  pedal). The safety limiter and pitch-wheel target in the mockup are proposals to check against the engine.
- (An earlier reading, a per-instrument edit sidebar on Perform, was reverted at Ryan's request.)

## D19: The v6 UI is built in 2.0 (Ryan, 2026-11-26)
- Ryan chose to build the redesigned UI (D16–D18, charts and song bank designs) in 2.0, not 2.x: 2.0 waits until
  it is built and tested. Design continues in this order: finish Edit (Drone, Master, Effects), Settings, MIDI
  Learn + Arrange + dialogs, edge states + a themes check. A build plan follows the designs.
- **Final UI changes wait for Ryan's Mac** (back in about a week from 2026-11-26): the mockups are proposals until he
  has seen the real thing on his machine. Work in the meantime can prepare (plan, components behind a flag), but
  nothing replaces today's UI before then.

## D20: MIDI Learn moves stick; the Revert button undoes them (Ryan, 2026-11-26)
- Answer to lane-learn's open question: "revert with revert button, keep unchanged otherwise". Read as: a learned
  knob's move stays (like any on-screen change) and Revert undoes it. That is lane-learn's O-AW-ML rule 5 as built
  (a knob edits the song through store.set: changed dot, Revert undoes, wheels stay live-only), so lane-learn needs
  no change for this. (An earlier wording of D20 said "live only, song unchanged"; corrected here. Ryan to confirm.)

## D21: Settings design approved (Ryan, 2026-11-26)
- Mockup: `native/docs/design/mockups/settings.html` (artifact "Settings mockups"). Ryan: "something like that is
  fine. just easy to navigate and use". Category list with each category's current state, a search box, MIDI Learn
  and Perform layout as categories, the Song bank entry in Sounds & Samples, theme previews. Guiding rule for the
  build: easy to navigate and use beats completeness on screen.

## D22: Build the v6 UI now; finishing touches before Ryan is back; then 2.0 (Ryan, 2026-11-26)
- "you can build the ui first, and we can work on finishing touches before i get back before releasing 2.0".
- Plan: `native/docs/lanes/UI6-build-plan.md` (U1–U9). Built behind `settings.uiV6` (true or absent, like
  chartView) so today's UI keeps working and stays the default until Ryan flips it after seeing it on his Mac (U9,
  tier 1). Builder then skeptic per task; flag-off purity is a gate.
- No 1.2 with the new UI (Ryan, same day): it depends on 2.0-only pieces (UIA slots, patch packs, Cue-then-Go,
  MIDI learn any param). The new UI ships in 2.0.

## D23: v6 Perform answers: tap PANIC/Lock, move instruments, metronome in the sidebar (Ryan, 2026-11-26)
Answers to the U1 builder's questions (UI6-U1 review O1/O2):
1. **PANIC and Lock go back to a tap**, as today (the 600 ms hold from the mockup is dropped). Esc / ⌘. unchanged.
2. **Duplicate puts the copy next to the original, and instruments can be dragged around** (also ⋯ Earlier / Later).
   This is a real change of the song's slot order (v4 question 1, option a). Needs store API: insert a slot after i
   and move a slot from → to, carrying everything slot-indexed with the instrument (scenes' slot levels, wheel
   targets, the instrument's own fields). Tier 2 (orchestrator): MIDI-learn mappings stay **positional**
   (`slots.<i>.*` = the i-th strip of whichever song plays, O-AW-ML rule 2), so a learned knob keeps moving "strip
   1" after a reorder; colours also follow position (D15). To revisit if Ryan expects knobs to follow an instrument.
3. **The metronome click and the "Loading…" state go in the right sidebar**: a Metronome module (click on/off,
   tempo, Tap) and the song's load state shown in the sidebar (Setlist rows already mark loading songs; the current
   song's "Loading n of m" goes in the sidebar header).

## D24: More v6 answers (Ryan, 2026-11-26)
1. **Lock does not block snapshots**: Save / Update stay live under Lock (as today's Quick sheet).
2. **A range drag is heard while dragging**: write the range during the drag (throttled, e.g. ≤ 1 write per 50 ms,
   plus the final value on release), so the split is audible live. Supersedes U2's write-on-release.
3. **Tap the instrument first on every pointer**, Mac mouse included (U2's coarse-pointer pick mode becomes the
   only mode on Perform; Edit › Range keeps its single live bar).
4. **A new song from the setlist's "+ Add song" is not selected** (as U3 built).
5. **Notes / Setlist in the song bar only open the sidebar**, never close it (as U3 built).
6. **The drone's Bright / Move show a percentage** beside the word, as today's card.
7. **Esc in range-pick mode** (UI6-U2 review O2; Ryan: "go with what you think", orchestrator tier 2): Esc finishes
   the pick, like every other open overlay in today's app (Esc closes what is open first; the next Esc panics).
   ⌘. / Ctrl+. always panic at once, and the on-screen PANIC is a tap (D23). Reason: one consistent Esc rule across
   the app; a stuck note costs one extra key press, never a lost edit.
   Ryan: "or add to settings" → a setting **Settings › Keyboards & MIDI › "Esc always panics"** (off by default =
   the rule above; on = Esc panics at once even with a pick, popover or sheet open). Per device, not in the library.

## D25: Snapshots stay today's scenes; a snapshot can have a name (orchestrator, tier 2, 2026-11-26; UI v6 U7c)
- Answer to UI6-build-plan "Open questions carried into the build: Snapshots vs today's scenes", for the Save snapshot
  dialog (mockup `native/docs/design/mockups/dialogs.html` "Save snapshot").
- **What a snapshot holds is unchanged:** today's scene (`shared/scenes.js`): each instrument's level and ON / OFF, the
  drone's level, and the wheel's position when the song routes the wheel. Not Space / Echo, octave, sustain, range, or
  the drone's ON / key / sound. The dialog's "It keeps" list says exactly that, and what is not kept.
- **New: an optional `name` per scene.** A string, whitespace folded and trimmed, at most 40 characters
  (`SCENE_NAME_MAX`; longer is cut there, by code point); absent = "Scene n", as today. The normalizer drops anything
  else (not a string, empty). A scene with only a name is still unusable (dropped). No SCHEMA bump; `migrate()` keeps
  it and stays idempotent; export / import and slot moves keep it. `controller.scenes.save(n, {name})` sets it;
  without `name` an existing scene keeps its own (Quick's Save scene n and the row's Update never drop it).
- Shown in the v6 snapshots row's chips and the folded "Snapshot: <name>" chip. Today's UI (flag off) still says
  "Scene n".
- **Still open for Ryan:** widening what a snapshot holds (the mockup's "Instruments: … Space / Echo, octave,
  sustain", "Drone: on, C major", "Space & Echo: Hall, dotted 8th"). That is a separate decision: it changes what a
  scene change does to the sound (a reverb or drone change mid-song can restart or retune things), so it is not part of
  U7c. Easy to reverse: the name is one optional field.

## D26: Answers to the 26 Nov summary's open questions (Ryan, 2026-11-27: "1-5 yes sure")
1. **Snapshots also remember Space, Echo and the drone** (widens D25 / today's scenes). Scope for the build (to be
   designed and reviewed): per instrument its Space and Echo sends, the song's Space room and Echo choice, and the
   drone's on/off, key and sound, on top of today's levels / ON tiles / drone level / wheel. Optional fields in each
   scene (no SCHEMA bump; an old scene without them keeps today's meaning: those settings stay as the song has them).
   A snapshot change must not restart a voice or cut a sound (glide what can glide; a drone key change crossfades
   as today's key change does). "It keeps" in the Save snapshot dialog lists the new items.
2. **Range bars are draggable in Edit too** (D18 "every screen with the bottom keyboard"), with Perform's guards
   ported (pick first, live throttled writes, restore on every cancel path).
3. **Lock: a tap locks, unlocking needs a hold** (as built).
4. **Song bank: tempo bands < 80 / 80–114 / ≥ 115 BPM, Feel matches any chosen tag** (as built).
5. **Start here card under the song bar; the portrait top bar hides the meter and the idle clock** (as built).

### D26.1a: a snapshot's drone follows the key played; a chosen key is optional, relative (2026-11-27; U-SNAP)
- **Default:** a snapshot keeps no drone key. Its drone plays the key the song is played in (`song.hearIn` / `minor`),
  so an Easy Transpose or a key-grid change of the song moves every snapshot's drone with it.
- **Optional:** a key chosen for the snapshot in the Save snapshot dialog (Save as new / Update), stored as
  `drone.keyShift = {semis 0..11, minor?}` above the song's key (`minor` absent = the song's own major / minor).
  While such a snapshot plays, the key grids (sidebar Drone module, today's Perform card, the bus' droneKey) move
  that key on top of it (transient, kept by Update); without one they change the song's key as before.
- **Why not absolute** (the builder's first cut): an absolute key would not follow an Easy Transpose (a different
  singer), and a relative key captured on every save would turn "tap D, Save, tap back to C" into "the song's key".
  Choosing the key explicitly avoids both.

## D27: After Mac/iPad 2.0: iPhone 2.0, then Windows 2.0 (Ryan, 2026-11-27)
- **Order:** Mac/iPad 2.0 first; then iPhone; then Windows. No building before Mac/iPad 2.0 ships; plan now.
- **iPhone = both:** a full instrument on the phone (own audio, USB-C / Bluetooth MIDI, phone-sized UI from the same
  modules, D15) AND a remote for a Mac on the same network (song, drone, master, PANIC; extends the menu-bar
  popover's bus).
- **Windows = same sound as the Mac:** a native shell around the 2.0 core (not the 1.x Electron web engine).
- Plan doc: `native/docs/lanes/NEXT-PLATFORMS.md` (iPhone layout mockups + Windows options comparison).

## D28: Windows 2.0 ships as a download from the website (Ryan, 2026-11-27)
- **Channel:** a direct download (installer from the site / GitHub Releases), not the Microsoft Store. Answers
  NEXT-PLATFORMS-windows §7 question 1.
- **Signing:** not decided; the default is unsigned at first, which means Windows SmartScreen shows "Windows protected
  your PC → More info → Run anyway" on first launch until the file builds reputation. A paid signing route (Azure
  Artifact Signing ≈ $120/yr) can be added later without changing the channel. Uploading a release stays tier 1.

## D29: iPhone: remote from the XR up; instrument mode only if Ryan's iPhone 14 runs it properly (Ryan, 2026-11-27)
- **Remote mode** runs on every iPhone from the XR (iOS 17.5, the iPad's target). It has no audio engine, so 3 GB
  phones are fine.
- **Instrument mode** is gated on a test on Ryan's iPhone 14 (6 GB): full 2.0 engine, a heavy song, a 30-minute set
  with no dropouts and no memory kill. If the 14 fails, the iPhone app ships remote-only and instrument mode stays
  planned until phone hardware catches up.
- Tier 2 (mine, from this): build order is remote first, then a 1–2 day engine spike on the 14 before any phone
  layout work. If the 14 passes, instrument mode turns on per phone at runtime from a measured RAM floor
  (`ProcessInfo.physicalMemory`, the floor set from the 14 and E6); phones below it see remote only. The 3 GB
  instrument tier (≈ 3–5 agent-days) is dropped.

## D30: iPhone 2.0 ships remote-only (Ryan, 2026-11-27; supersedes D29's iPhone-14 gate)
- The iPhone app is a remote for the Mac (song, drone, master, PANIC, snapshots), iPhone XR and later, iOS 17.5.
- No instrument mode, no engine spike on the iPhone 14, no phone instrument layouts in 2.0. Instrument mode stays
  open for a later version when phone hardware improves (D27's "both" is deferred, not dropped).
- Effort ≈ 11–17 agent-days [E]; still after Mac/iPad 2.0 ships (D27).

## D31: Start the after-2.0 work as soon as the 2.0 work Claude can do is done (Ryan, 2026-11-27)
- Replaces D27's "no building before Mac/iPad 2.0 ships". The trigger is: every 2.0 item that does not need Ryan
  (his Mac review U9, the release itself, hardware checks) is merged and green.
- 2.0 queue still first: U8b themes, U-SNAP, U-EDITRANGE, polish batch 2, the core3 CI flake, Lane E2 leftovers,
  Lane R (release notes, README/site, release checklist; publishing stays tier 1).
- Tier 2 (mine), how the after-2.0 work may land without risking 2.0 (it is cut from v2-native):
  1. **Windows CI + tree fixes (W1–W11):** merged to v2-native only with fixtures byte-identical and ctest green on
     g++/clang++-20/ASan; the new windows-2025 job may fail without blocking.
  2. **Mac command bus, then the iPhone remote (D30):** additive, behind a hidden flag / a new target; flag-off
     purity probes identical; nothing visible in 2.0.
  3. **Lane P build scripts** (no audio in git, no uploads: uploading stays tier 1).
  4. **Held until 2.0 is tagged:** anything that changes the sound engine or the golden oracle (FX steps 2–4, D13),
     and work that needs hardware (E6 iPad memory, Windows audio/MIDI, iPhone on a device).

## D32: A colour-blind setting in Settings (Ryan, 2026-11-27)
- Ryan: "make color blind settings toggleable in settings". Answers the U8b review's O3 (the lighter Bass narrowed
  Extra/Bass lightness separation for deutan viewers).
- Tier 2 (mine), the shape: Settings › Look › **Colour-blind colours: Off (default) / Red–green / Blue–yellow**.
  Per device (like `escPanics`), not in the library or song exports.
  - On, it recolours the 16 instrument colours (`--slot-0..15`: strips, ON tiles, range bars, Edit cards, chooser) in
    every theme, day and night, with a palette chosen for that type: neighbours separated by lightness as well as
    hue, each colour still ≥ the theme's contrast rules (ui-v6-themes audit), checked with a CVD simulation
    (Machado 2009) for the chosen type.
  - It also adds a non-colour cue: each instrument's number on its range bar and strip tab, so no colour is the
    only way to tell two instruments apart.
  - Applies to the new UI and today's UI (themes are shared). Off = exactly today's colours (purity: no change).

## D33: The chord chart ships in 2.0 (Ryan, 2026-11-27: "move chord chart to 2.0"; replaces D7's "2.1")
- In 2.0: D7 step 1, the chord-chart view (paste / import ChordPro or plain chords, transpose follows Easy Transpose,
  auto-scroll, text size in %, on the stage or in the sidebar per device: U7b). PDF attachments (D7 step 2) and real
  notation stay after 2.0 unless Ryan moves them too.
- Tier 2 (mine), how it ships (task C-SHIP):
  - `settings.chartView` stops being hidden: absent = on, `false` = off. Settings › Perform gets "Chord charts"
    (on / off). The v6 Chart sidebar module, Edit's Chart button and today's Chart toggle show by default; the
    "Chart · coming in 2.1" placeholders go.
  - Fix before shipping (chart-view review): O1 PANIC must stay reachable while the import / Edit chart dialog is
    open (it is covered today; ⌘. works); O4 `duplicateSong` / `addSong` check `LIBRARY_MAX_CHARS`; O7 the over-1 MB
    message; O3 the Chart toggle meets 44 px on touch.
  - The flag-off purity probes change meaning: "chart off" is now an explicit `false`; with charts on, nothing
    loads until a song has a chart or the Chart module is opened (lazy module load as today).
  - The chart's look stays part of Ryan's Mac review (U9) with the rest of v6.
  - **Note (orchestrator, tier 2, 2026-11-27; C-SHIP skeptic): O4 follows D9.** An add / duplicate past 2,000,000
    characters warns (the same warning as any save past the cap) and goes through; it is refused only if it would
    take the library past the restore cap (1.25× = 2,500,000), so the library's own backup always stays restorable.
    The first cut refused it past 2 MB, which contradicted D9. CONTRACT_CHANGES "C-SHIP (D33)" O4.

## D34: A browser remote for old phones, more stripped down than the iPhone app (Ryan, 2026-11-27)
- Ryan: "sure add browser remote. even more stripped down than the phone app". Also settles the native floor: the
  App Store iPhone remote targets iOS 15 (iPhone 6s / SE 1st gen and later; Xcode 26 / App Store minimum), not the XR.
- Tier 2 (mine), the shape:
  - **What it is:** the Mac app serves one small page on the local network (off by default; Settings › Remote shows
    the address and a QR code and a pairing code). Any phone's browser opens it: old iPhones, Android, a tablet.
  - **What it does (only):** the song name and snapshot name; Previous / Next song; Previous / Next snapshot; PANIC;
    drone on / off. No levels, no Edit, no setlist editing. The Mac stays in charge; Lock blocks everything but PANIC.
  - **Built for old browsers:** one HTML file with ES5 script and plain CSS (no modules, no build step), plain
    WebSocket, no web fonts; target Safari on iOS 12 (iPhone 5s / 6) reliably, iOS 7 (iPhone 4) best effort,
    Android Chrome 50+. Falls back to polling if WebSocket fails.
  - **Same command bus** as the iPhone app and the menu-bar popover; pairing with a short code; local network only.
  - **Order:** after 2.0, with the Mac command bus (D31 item 2), before the iPhone app. Effort ≈ 3–5 agent-days [E].

## D35: Every 1.x Mac feature is in the native 2.0 app before 2.0 ships (Ryan, 2026-11-27: "Build all before 2.0")
- Found by Lane R (code reading): the native Mac / iPad app lacks My Samples, patch packs and Song bank content, the
  GarageBand / Logic importer, My Pads, menu-bar mode (mini panel), global shortcuts, the update check, Open at login,
  keeping the screen awake and most of the Rig / Help menus; MIDI input (B1, lane NMA), export / import of files
  (B2) and a native release build (B3) are blockers handled separately.
- All of these are built before the 2.0 tag (tier 1 answered). Estimate 12–20 agent-days [E]. Each is a lane with a
  builder and a skeptic; iPad equivalents where they make sense (Files picker / security-scoped bookmarks for folders;
  no menu bar or global shortcuts on iPad).

## D36: After-2.0 work runs alongside the 2.0 work (Ryan, 2026-11-28: "Interleave now")
- Ryan wants the after-2.0 things released around when 2.0 is. Of the box's two heavy slots, one keeps 2.0 moving
  (the D35 native-gaps lanes and their reviews, release prep) and the other takes after-2.0 work. 2.0 finishes later
  than it would with both slots; the rest arrives close behind it.
- Tier 2 (mine), order for the after-2.0 slot: (1) Windows CI + the W1–W11 tree fixes (land on v2-native only with
  fixtures byte-identical, D31); (2) the Mac command bus, then the browser remote (D34); (3) the iPhone remote app
  (D30, iOS 15 floor); (4) Lane P sound-pack build scripts (no audio in git, no uploads); (5) Windows WebView2 shell.
- Unchanged: D13 — FX steps 2–4 change the web engine (the golden oracle) and still wait for the 2.0 release; and
  anything that needs hardware Claude can't reach (a Windows PC, an iPhone, Ryan's App Store account) waits for Ryan.

## D37: 2.0 ships as a website download only; no App Store for now (Ryan, 2026-11-28)
- The Mac app: the ad-hoc signed zip / dmg from release-native (N10) on the website / GitHub Releases, like 1.x
  (macOS asks "Open Anyway" on first launch). No Apple Developer Program membership ($99/yr) for now, so no
  notarization, no TestFlight, no App Store.
- Consequences (mine, tier 2): no App Sandbox work, no bundle-ID changes, the update check stays. The iPad app (and
  later the iPhone remote) can't be installed from a website without a paid membership: Ryan installs it on his own
  devices from Xcode with his free Apple Account (MAC_CHECK step 5); from memory such installs expire after about
  7 days and need a re-install [U]. The browser remote (D34) needs no install at all.
- Revisit universal purchase / the App Store after 2.0 if Ryan wants it (notes: universal purchase needs one bundle ID
  across platforms; the Mac App Store needs App Sandbox, ~2–4 agent-days [E]).

## D38: 2.0 and later are licensed PolyForm Noncommercial 1.0.0 (Ryan, 2026-11-28: "polyform then", "for 2.0")
- From 2.0 on (the `v2-native` line: Mac, iPad, the remotes and Windows), the code is PolyForm Noncommercial 1.0.0:
  free to use, change and share for any noncommercial purpose (charities and churches, schools, personal use), not
  for commercial use. 1.x (`main`, releases up to 1.1.1) stays GPL-3.0-only; those releases can't be relicensed.
- Unchanged: the samples keep their own licences (Salamander CC BY 3.0, VSCO CC0, Musyng Kite CC BY-SA 3.0, in
  LICENSES.md), the fonts OFL 1.1, third-party code its own permissive licences.
- The one commit by another GitHub account (ilomacht, cf6e15f) is Ryan's own account (Ryan, 2026-11-28), so every
  copyright holder of this line is Ryan; no rewrite.
  Windows (D27/D28): everything planned works under PolyForm except the ASIO SDK's GPLv3 option; Windows 2.0 uses
  WASAPI only, and ASIO waits for Ryan to sign Steinberg's own licence if he wants it. Ryan (2026-11-28): "ship with
  wasapi for now, slot in asio if it turns out to not be good" — the Windows audio host keeps ASIO as a drop-in
  backend behind the same interface, decided by a test on a real PC with Ryan's interface. Outside contributions from now
  on need the contributor's agreement to PolyForm (CONTRIBUTING note). Not legal advice; Ryan may want a lawyer's look.

## D39: Rig works with SetFlow, in 2.1 (Ryan, 2026-11-28: "sure in 2.x", then "make this 2.1")
- Rig 2.x gets a SetFlow follower: a read-only client of a SetFlow host's LAN WebSocket (role "musician") that follows
  the MD's song, key, section, vamp, end and setlist through `controller.*` (BACKLOG 2.x "SetFlow follower").
- Not 2.0. Built after the Windows work in the after-2.0 slot (see below).
- Protocol-level interop only: SetFlow (andteklin/setflow, read at 741b972) has no LICENSE file, so no code is copied.
  Its message format is a prototype's; re-read it when the lane starts and pin the version it was built against.
- Ryan (2026-11-28) adds two parts to D39: Rig as a SetFlow controller (its pedal/pads send NEXT/REPEAT/VAMP/JUMP/END),
  and importing a SetFlow setlist's songs into Rig (songs + setlist with key and tempo; chart later). Same lane,
  follower first, then import, then controller.
- **D39 is 2.1** (Ryan, 2026-11-28: "we can make this 2.1 if nothing else is planned for 2.1"). Checked: nothing else
  was planned for 2.1 (D7's chart moved to 2.0 by D33; the other after-2.0 items carry no version). So (mine, tier 2):
  the SetFlow lane goes first in the after-2.0 slot (D36), ahead of Windows CI, the browser remote and the iPhone
  remote, which ship in a later 2.x when ready. **Overridden (Ryan, 2026-11-28: "no do windows stuff first"):** the
  after-2.0 slot runs Windows (CI + W1–W11, then the WebView2 shell) first, then the SetFlow lane, then the Mac
  command bus + browser remote and the iPhone remote. SetFlow stays the 2.1 feature set; Windows ships when it's ready. 2.1 = follower + setlist import + controller, plus the ChordPro chart
  import if it fits; FX steps 2–4 (D13) may also land in 2.1 if done in time, but don't hold it.

## D40: Windows, the iPhone remote and the browser remote are 2.0 work (Ryan, 2026-11-28: "make windows, phone, etc 2.0 level")
- They are no longer "after 2.0": they count as 2.0 work with the same priority as the D35 Mac lanes, and both heavy
  slots (D36's split is retired) take them in turn with the 2.0 lanes.
- Release (Ryan, same day, "Mac/iPad first"): 2.0 ships for Mac/iPad when that is ready; Windows (D27/D28, WASAPI per
  D38) and the remotes (D30/D34, needing the Mac command bus) follow as 2.0.x releases, not 2.1. Windows needs Ryan's
  real-PC test before its release.
- Order in the slots (mine, tier 2): Mac/iPad release blockers and D35 lanes first, interleaved with Windows CI +
  W1–W11 → Windows WebView2 shell, and the Mac command bus → browser remote → iPhone remote.
- Priority (Ryan, 2026-11-28: "browser remote > iphone remote > windows in that order"): the Mac command bus →
  browser remote first, then the iPhone remote, then Windows (CI + W1–W11 → WebView2 shell). The Mac/iPad 2.0 lanes
  still come first; the 2.0.x releases go in the same order.
- 2.1 stays the SetFlow work (D39), after those. FX steps 2–4 (D13) still wait for the 2.0 tag.

## D41: Sunday Keys gaps go on the 2.x list; a personal one-button Sunday Keys import tool (Ryan, 2026-11-28)
- BACKLOG 2.x gets the three gaps from the Sunday Keys comparison: multiple audio outputs, an arpeggiator + Easy Chord,
  and plugin hosting (AU/AUv3; VST3 later). Not 2.0; Arp/Easy Chord touch the engine, so after the 2.0 tag (D13).
- "A separate import sunday keys sounds plugin in one button for our personal use": built as a separate tool, kept out
  of this repository and every build (mine, tier 2: the safest reading of "personal use"), writing into My Samples.
  Plan in native/docs/lanes/SUNDAY-KEYS.md §4; first step is checking the installed formats in the Mac session.

## D42: Multiple audio outputs and per-layer keyboard assignment are 2.0 (Ryan, 2026-11-28: "yes")
- Two 2.0 lanes, specified in native/docs/lanes/IO-2.0.md:
  - **OUT:** each layer, the drone and the click get an output pair, and each pair carries its own effects.
  - **KBD:** each layer gets a Keyboard (by name) and a Channel; absent means Any.
- Both change the engine, so in 2.0 they are native only (Mac first); the Chrome version hides the pickers.
  - The web engine stays frozen until the 2.0 tag (D13).
  - Correction to what I first told Ryan: KBD needs an engine change too, because `noteOn` tracks notes by number only.
- The iPad gets multichannel output in 2.0.x. Windows gets both with its host.
- With nothing set, the native output must stay bit-for-bit what it is today, so the fixtures don't change.
- Both need Ryan's hardware test: an interface with more than 2 outputs, and two keyboards.
- Two copies of Rig at once stay unsupported: the second window is muted and read-only (H2).

