# Hardware verification checklist — live session

Real gear: M-Audio Keystation 49es (CoreMIDI ports "Keystation 49es Port 1" / "Port 2"), sustain pedal, built-in
speakers, ThinkPad USB-C dock audio out (current macOS default output), Bluetooth (JBL Charge 5, AirPods).

Run each numbered section twice where noted: **Electron** (`npm start`, http://127.0.0.1:8438) and **Chrome**
(`npm run serve`, http://127.0.0.1:8437). Open GarageBand first (idle, in the background) so a "GarageBand Virtual
Out" CoreMIDI port exists for the auto-select test in §1. Fill every blank field with what actually happened —
numbers where the item asks for one. Leave unchecked boxes for anything not done.

---

## 1. MIDI input auto-select

The device picker is `app/js/views/settings.js:347-360` (`<select class="st-midi-input">`, bound to
`settings.midiInputId`); the "First keyboard (automatic)" option resolves via `midi.js` `_bestHardware()`
(`app/js/midi.js:216-231`), which ranks connected ports by `classifyInput()` (`app/js/midi.js:79-85`) — virtual/IAC
ports (regex `app/js/midi.js:35-41`, matches "GarageBand", "IAC", "Network", "Bus", "Through", etc., or manufacturer
`^Apple\b`) always rank 0 and are never auto-picked while a real port is present. The live connection line is
`Connected: <name>` / `No keyboard connected…`, rendered at `app/js/views/settings.js:903-916` from
`controller.onStatus`.

| Step | Expected | Electron result | Chrome result |
|---|---|---|---|
| 1. Open GarageBand (creates its virtual port). Plug in Keystation 49es. Open Settings → MIDI. Leave Input = "First keyboard (automatic)". | Settings shows `Connected: Keystation 49es Port 1` (not GarageBand/IAC). | ___ | ___ |
| 2. Open the Input dropdown. | Lists both "Keystation 49es Port 1"/"Port 2" and the GarageBand virtual port, the latter marked "(virtual)". | ___ | ___ |
| 3. Play a key with Input still on automatic. | Note sounds; no MIDI from GarageBand's virtual port is read. | ___ | ___ |

---

## 2. Sustain-pedal polarity detector

Logic: `inferPedalInvert(firstValue)` at `app/js/views/settings.js:60-63` — `< 64` on the first CC64 value after
pressing = reversed polarity. UI: "Test my pedal" button and result at `app/js/views/settings.js:362-416`
(`Settings → MIDI keyboard → Sustain pedal`). Applied live via `reapplyPedalInvert()` in
`app/js/controller.js:731-738` (a mid-press invert can only *release* stuck sustain, never falsely start it).

| Step | Expected | Electron result | Chrome result |
|---|---|---|---|
| 1. Plug the pedal in **already pressed down**, then click "Test my pedal" and let go, or press it. | Message reports the raw CC64 value received and normal/reversed polarity. | ___ | ___ |
| 2. If it reports reversed, click "Invert pedal". | `settings.pedalInvert` turns on; pedal now sustains correctly. | ___ | ___ |
| 3. Toggle `pedalInvert` manually while pedal is physically held down. | Notes release immediately if inverting makes it read "up" — never starts a false sustain. | ___ | ___ |
| Raw CC64 value on press (write the number): | | ___ | ___ |

---

## 3. Latency readout

Computed in the engine and delivered as `statechange {latencyMs}` (`app/js/controller.js:1129-1130`,
`1759-1761`, cited comment `app/js/controller.js:12`: `ctx.{state,currentTime,resume}, latencyMs`). Settings UI
shows it at `app/js/views/settings.js:901-904` (`<span class="st-status">`, next to the Latency segmented control,
flagged "— high" above 40 ms). The Perform Quick sheet also surfaces `sound: ok/stalled/restarting` from
`app/js/views/perform.js:1225-1234`.

Fill in the ms figure from Settings → Audio → Latency for each combination (use the "Lowest" latency preset unless
noted):

| Output | Electron (ms) | Chrome (ms) |
|---|---|---|
| Built-in speakers | ___ | ___ |
| ThinkPad dock (USB-C) | ___ | ___ |
| Bluetooth — JBL Charge 5 | ___ | ___ |
| Bluetooth — AirPods | ___ | ___ |

---

## 4. Mod / pitch-bend / expression (CC11) / volume (CC7) mapping per song

CC routing: `app/js/controller.js:811-823` — CC1→`modWheel`, CC11→`expression`, CC7→`volumeCC` (always targets
`master.volume`, not overridden per song — confirmed: no factory song's `routing` block sets a `volume` key, only
`app/js/presets.js:67`'s default does). Per-song `modWheel`/`expression`/`bend` targets are in
`app/js/presets.js` (`PAD = 'slots.1.gain'`, `app/js/presets.js:164`); pitch-bend `mode` values
(`pitch|morph|drone-swell|tape|none`) are declared at `app/js/presets.js:24`.

| Song | Mod wheel → | Expression → | Pitch-bend mode | Volume (CC7) |
|---|---|---|---|---|
| Sunday Pad + Piano | Pad level | Pad level | drone-swell | master.volume |
| Building Swell | Pad level | Pad level | pitch | master.volume |
| Prayer Wash | Pad level | Pad level | drone-swell | master.volume |
| Organ Swell | Pad level | Pad level | morph | master.volume |
| Grand Piano | Reverb amount (0.3–1) | Master volume | none | master.volume |
| Rhodes | Reverb amount (0.3–1) | Master volume | none | master.volume |
| Felt Piano | Reverb amount (0.3–1) | Master volume | none | master.volume |
| Lofi Rhodes | Reverb amount (0.3–1) | Master volume | tape | master.volume |
| Dusty Piano | Reverb amount (0.3–1) | Master volume | tape | master.volume |
| Glass Ocean | Pad level | Pad level | morph | master.volume |
| Sub + Shimmer | Pad level | Pad level | drone-swell | master.volume |
| Anthem | Intensity macro | Pad level | none | master.volume |
| Gospel Stab + B3 | Pad level | Master volume | morph | master.volume |
| Upright + Pad | Pad level | Pad level | drone-swell | master.volume |
| Clav Funk | Pad level (Wurlitzer) | Master volume | none | master.volume |
| Music Box Lullaby | Pad level | Pad level | morph | master.volume |
| Dream Juno | Intensity macro | Pad level | none | master.volume |
| 80s Ballad | Pad level | Pad level | pitch | master.volume |
| Synthwave | Wash macro | Master volume | pitch | master.volume |

There is **no expression-pedal-specific mapping in code** — a physical expression pedal simply sends CC11, so it
follows the "Expression →" column above like any CC11 source; the song blurbs in `presets.js` mention "an expression
pedal" only as prose, there is no separate expression-pedal routing field.

For each song, play a chord, move the mod wheel and pitch-bend wheel, and (if you have a CC11/CC7 pedal or a DAW to
send test CCs) confirm the target in the table actually moves. Note any mismatch:

Notes: _______________________________________________________________________________

---

## 5. MIDI Learn a footswitch/button to Next Song

Settings → MIDI keyboard → MIDI Learn table, built at `app/js/views/settings.js:421-453` (rows = `LEARN_ROWS`,
`app/js/views/settings.js:27`, sourced from `LEARNABLE` in `app/js/shared/params.js:336-340`, which includes
`nextSong`). Learn flow: `toggleLearn()` at `app/js/views/settings.js:454-494`, calling `midi.learn(id)`
(`app/js/midi.js:486-497`). **CC64 (sustain) is reserved** and can never be learned — `app/js/midi.js:448-451`
resolves `{error:'sustain-pedal-reserved'}`, and the sustain still functions; message shown via `LEARN_MESSAGES`
(`app/js/views/settings.js:46-48`).

| Step | Expected | Electron result | Chrome result |
|---|---|---|---|
| 1. Settings → MIDI keyboard → MIDI Learn → row "Next song" → click Learn. | Cell reads "Move a knob/fader or press a key/pad…", button becomes "Cancel". | ___ | ___ |
| 2. Press the footswitch/button (or a spare key/pad if no separate button is available). | Row shows the CC or note learned; toast confirms `Next song → …`. | ___ | ___ |
| 3. Press that control during Perform. | Song advances to the next song in the setlist. | ___ | ___ |
| 4. Try learning CC64 (press the sustain pedal while "Learn" is active on any row). | Learn is refused with the reserved-pedal message; pedal still sustains. | ___ | ___ |

---

## 6. Hot-unplug / replug with notes held

`_handleStateChange`/`_reattach` in `app/js/midi.js:308-325` release that port's notes and pedal on disconnect and
re-resolve the active port; a hot-plug move fires `'switched'`, surfaced as a toast by
`app/js/controller.js:864`: `` warn(`Now using ${e.detail.name || 'another MIDI input'}`) ``.

| Step | Expected | Electron result | Chrome result |
|---|---|---|---|
| 1. Hold a chord down, then unplug the Keystation USB cable mid-hold. | Held notes stop (no stuck notes); pedal (if held) releases too. | ___ | ___ |
| 2. Replug the keyboard. | Toast "Now using Keystation 49es Port 1" (or similar) appears; keyboard works again. | ___ | ___ |
| 3. Repeat holding the sustain pedal down while unplugging/replugging. | No stuck sustain after replug. | ___ | ___ |

---

## 7. Sleep/wake and output-device change → restart-audio path

Output picker: `app/js/views/settings.js:255-309` (`<select class="st-output">`, `settings.outputDeviceId`), applied
via `engine.setSinkId` at `app/js/controller.js:1476-1480` (falls back to a full `restartAudio()` if `setSinkId` is
unsupported). The always-visible health indicator/banner is the Quick sheet's Sound OK / Sound stalled control,
`app/js/views/components/quickSheet.js:253-267`: normal state offers a 1-second hold-to-restart button
(`onRestartAudio`, wired to `controller.restartAudio()` at `app/js/views/perform.js:665`); once `status.audio` is
`'stalled'` or `'restarting'` the hold button is replaced by a one-click "Restart audio" button. A stall also
auto-restarts after 10 s of no progress (`app/js/controller.js:1131-1139`, `lastAutoRestart`).

| Step | Expected | Electron result | Chrome result |
|---|---|---|---|
| 1. Play a note, put the Mac to sleep for 10+ s, wake it, play again. | Sound resumes on its own, or the Quick sheet shows "Sound stalled" within ~10 s and self-restarts. Note actual behavior. | ___ | ___ |
| 2. In Settings → Audio → Output device, switch from dock to built-in speakers while a note/pad is sounding. | Output moves with (at most) a very short glitch via `setSinkId`; no restart needed if supported. | ___ | ___ |
| 3. Unplug the dock entirely while it's the selected output. | `onDeviceChange` (`app/js/controller.js:1439-1450`) warns "The selected audio output was disconnected."; Quick sheet flips to stalled/restart. | ___ | ___ |
| 4. Use the Quick-sheet hold-to-restart (or Settings → "Audio engine" → Restart audio button, `app/js/views/settings.js:322-330`). | Toast "Audio restarted"; sound resumes. | ___ | ___ |

---

## 8. 30-second recording to ~/Music/Worship Rig

Filename pattern: `` recordingFilename() `` → `Rig YYYY-MM-DD HHmm.wav` (`app/js/recorder.js:15-18`), written under
`~/Music/Worship Rig/` in Electron (`app/js/recorder.js:3`). A mid-recording audio restart splits the file — warned
at `app/js/controller.js:1199`: `` Audio restarted, so the recording was split: <name> is saved; recording continues
in <name>… ``.

| Step | Expected | Electron result | Chrome result |
|---|---|---|---|
| 1. Start recording (Quick sheet / record control), play for 30 s, stop. | File named `Rig <date> <HHmm>.wav` appears in `~/Music/Worship Rig/` (Electron) or downloads (Chrome). | ___ | ___ |
| 2. Open the file in QuickTime Player. | Opens and plays cleanly, ~30 s duration, audio matches what was played. | ___ | ___ |
| 3. Start a recording, then trigger an audio restart (§7) mid-recording. | Recording splits into two files; toast names both; no data loss at the seam (may have a tiny gap). | ___ | ___ |
| Actual filename(s) recorded: | | ___ | ___ |

---

## 9. Perform-lock tiers

Three tiers defined at `app/js/views/perform.js:43-53` (`LOCK`), with the concept note at `perform.js:10-11`
("playing stays live, the song key and Revert need a 600 ms hold, soundcheck settings are frozen") and
`HOLD_MS = 600` at `perform.js:33`.

- **live** (works exactly as unlocked): slot faders, ON tiles, drone ON tile, drone level, wheel, Swell, strip
  chips, header Space/Echo, Quick › This song, Quick › restart audio, Prev/Next/setlist tap, Fade out, PANIC.
- **hold** (needs a 600 ms press-and-hold, amber HOLD tag): KEY ▾ "Sing it in…", Transpose −/+, drone key grid,
  Major/Minor, Revert (Revert always needs the hold, locked or not).
- **frozen** (disabled while locked): Edit, Settings, drone Synth/My Pads switch, Brightness, Movement, Follow
  chords, Continue across songs, pad folder, setlist reorder, Quick › This Mac.

| Step | Expected | Electron result | Chrome result |
|---|---|---|---|
| 1. Turn Perform lock on. Play notes, move wheel, tap faders/ON tiles, Prev/Next. | All work normally, no hold needed. | ___ | ___ |
| 2. Tap KEY ▾ or Transpose once (no hold). | Nothing happens / shows the amber HOLD tag; requires holding ~600 ms. | ___ | ___ |
| 3. Hold KEY ▾ / Transpose for 600 ms. | Action fires. | ___ | ___ |
| 4. Try opening Edit or Settings while locked. | Controls are disabled/inaccessible. | ___ | ___ |
| 5. Unlock (hold the Lock button). | Everything returns to normal. | ___ | ___ |

---

## 10. Every factory song plays

19 songs from `app/js/presets.js` `DEFS`:

- [ ] Sunday Pad + Piano
- [ ] Building Swell
- [ ] Prayer Wash
- [ ] Organ Swell
- [ ] Grand Piano
- [ ] Rhodes
- [ ] Felt Piano
- [ ] Lofi Rhodes
- [ ] Dusty Piano
- [ ] Glass Ocean
- [ ] Sub + Shimmer
- [ ] Anthem
- [ ] Gospel Stab + B3
- [ ] Upright + Pad
- [ ] Clav Funk
- [ ] Music Box Lullaby
- [ ] Dream Juno
- [ ] 80s Ballad
- [ ] Synthwave

For each: select it, play a chord on the Keystation, confirm sound and no console errors. Note any that fail to
load or sound wrong: _______________________________________________________________________________

---

## 11. Song switch while holding a chord is gapless

Play/hold a chord, tap Next/Prev (or the setlist strip) mid-hold.

| Electron result | Chrome result |
|---|---|
| ___ | ___ |

Expected: no audible gap/click, held notes carry over or fade per the new song's settings (not silence-then-attack).

---

## 12. Drone crossfade on key change

Drone key handling: `app/js/controller.js:264-296` — `droneCall('setKey', key.pc, {minor})` runs whenever the
song's key/minor changes (guarded by `lastDroneKey`), so the engine crossfades the drone into the new key.

| Step | Expected | Electron result | Chrome result |
|---|---|---|---|
| 1. Pick a song with drone on (e.g. Sunday Pad + Piano). Change the song key ("Sing it in…"). | Drone pitch shifts to the new key with an audible crossfade, not a hard cut. | ___ | ___ |
| 2. Toggle Major/Minor while the drone plays. | Drone crossfades to the relative mode smoothly. | ___ | ___ |

---

## 13. "My Pads" folder with a downloaded pad pack

Folder picker: `app/js/views/perform.js:540-545` (button `.pad-btn`, "Choose folder…"/"Rescan"/"Change…" per
`renderPads()` at `perform.js:1204-1216`); Electron uses a native folder dialog via `rig`, Chrome uses
`showDirectoryPicker()` (handle persisted in IndexedDB, `app/js/controller.js:1302-1322`). Server route
`/api/pads` (`server.js:680-683`, `listPads()` at `server.js:537-550`) lists files under `AUDIO_EXTS`
(`server.js:68`): `.mp3 .wav .flac .ogg .oga .opus .m4a .aac .aif .aiff .caf .webm`.

| Step | Expected | Electron result | Chrome result |
|---|---|---|---|
| 1. Download/unzip a pad pack of one-shot audio files (named or numbered per key) to a folder. | — | | |
| 2. Settings/Perform → My Pads → Choose folder… → pick that folder. | `padsInfo` shows "My Pads: N keys from M files"; a song with `drone.mode = 'files'` plays the folder's files. | ___ | ___ |
| 3. Check file formats actually loaded match `AUDIO_EXTS` above; anything outside that list is silently skipped. | — | ___ | ___ |

---

## 14. My Samples: steinway-grand-piano and yamaha-grand-piano

Packs live in `user-samples/steinway-grand-piano/` and `user-samples/yamaha-grand-piano/` (confirmed present in the
repo). Scanned by `scanUserSamples()` in `server.js` (roots documented `server.js:11-14`, default roots
`server.js:227-236`). Grouped in pickers under **"My Samples"** — last group in `INSTRUMENT_GROUPS`
(`app/js/views/components/instrument-groups.js:6-16`); an item lands there if its `group` field is unset and its
`ref.id` starts with `user:` (`instrument-groups.js:19-22`).

| Step | Expected | Electron result | Chrome result |
|---|---|---|---|
| 1. Open the instrument picker (Edit or slot picker). Scroll to "My Samples". | Both "Steinway Grand Piano" and "Yamaha Grand Piano" (or their pack names) are listed. | ___ | ___ |
| 2. Select each and play notes across the range. | Sounds play with no missing-sample gaps. | ___ | ___ |

---

## 15. Built .app checks (`npm run build:mac`)

Build output: `dist/mac-arm64/Worship Rig.app`. `user-samples/` is excluded from the bundle via the
`electron-builder` `files` glob `!**/user-samples/**` (`package.json:37`), matching the CLAUDE.md rule that
GarageBand-derived content must never ship.

- [ ] Run `npm run build:mac`, wait for it to finish.
- [ ] Launch `dist/mac-arm64/Worship Rig.app` from Finder (not `npm start`).
- [ ] First MIDI use triggers the macOS MIDI/sysex permission prompt; Allow it, keyboard works after.
- [ ] Audio plays on all three outputs (speakers/dock/Bluetooth) as in §3.
- [ ] Recording writes to `~/Music/Worship Rig/` as in §8.
- [ ] App menus (File/Edit/Window, or the app's custom menu) behave normally — no "app not responding".
- [ ] Confirm `user-samples/` is NOT inside the packaged app:
  ```sh
  ls "dist/mac-arm64/Worship Rig.app/Contents/Resources/app.asar"
  npx asar list "dist/mac-arm64/Worship Rig.app/Contents/Resources/app.asar" | grep -i user-samples
  ```
  Expected: the `grep` prints nothing.
  Actual grep output: _______________________________________________________________________________
- [ ] Bundle size: `du -sh "dist/mac-arm64/Worship Rig.app"` → record the number: ___________

---

# Results log — Electron (built app from main, 2026-09-29, Ryan at the Keystation 49es)

## 1. MIDI auto-select
- Connected line: "Keystation 49es Port 1" ✔ (GarageBand not open at the time, so its virtual port was not in the list).
- Dropdown lists both Keystation ports ✔. Automatic input plays normally ✔.

## 2. Pedal polarity
- "Test my pedal": raw CC64 = 127, reported normal ✔. Chord + pedal + hands off: notes hold ✔.

## 3. Latency (Settings → Audio, "Lowest")
| Output | Electron (ms) |
|---|---|
| ThinkPad USB-C dock | 20 |
| Bluetooth (JBL / AirPods — see note) | 176; sound followed the device change without a restart ✔ |

## 4. Wheels
- Sunday Pad + Piano, Grand Piano, Building Swell, Lofi Rhodes, Anthem: mod and pitch wheels behave as in the mapping table ("I think the wheels work"; no mismatch noticed). No expression/volume pedal available on the Keystation 49es.

## 5. MIDI Learn
- Steps 1–3 (learn Next song to a spare control): DEFERRED — the Keystation 49es has no spare buttons that send CC; retry with a footswitch or a pad controller.
- Step 4 (CC64 refused as reserved, pedal still sustains): ✔.

## 6. Hot-unplug / replug
- Unplug mid-chord: no stuck notes ✔. Replug: "Now using Keystation 49es Port 1" toast, plays again ✔. With pedal held: no stuck sustain ✔.

## 2 (addendum). Pedal polarity, second try
- On a second "Test my pedal" the app reported reversed polarity and offered Invert; after inverting, sustain works. First try had reported 127 / normal. Note for the cloud: the result depends on whether the pedal is pressed at plug-in time (expected by the heuristic), so the wording should tell the user to plug in with the pedal UP, or the test should sample both states.
