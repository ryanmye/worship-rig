# Onboarding / first-run walk (C6 critics, 2026-09-29)

I played a volunteer keys player opening Worship Rig for the first time: a laptop, no MIDI device, an empty
library, and only README.md to go on. Screens are in `reviews/onboarding-shots/` (`NN-*.png`, named below as `#NN`).

## Setup, and what this walk can't tell you

- Tree: the cloud tree as of 01:15Z. The server was `server.js` on :8491 with an empty My Samples root, and the
  browser was Playwright Chromium in a fresh persistent profile (no localStorage), 1440×900 unless noted.
- Chrome was launched two ways:
  - with the launcher's flags (`serve.mjs` `CHROME_FLAGS`, incl. `--autoplay-policy=no-user-gesture-required`),
    which is what README's "Start Worship Rig.command" gives;
  - once as a plain tab (`#01a/b`).
- **Harness stubs.** Playwright can't show real permission prompts or native dialogs, so four things are stubbed:
  - **Web MIDI** answers "granted, zero inputs", which is what a Mac with no keyboard gets after *Allow*. Real
    Chromium in this container gives "Platform dependent initialization failed" (no ALSA), or `NotAllowedError`
    unless `midi-sysex` is granted as well.
  - **`showDirectoryPicker`** returns an OPFS folder `Pads` holding a generated 20 s C-major WAV
    (`Warm Pad - C.wav`) plus the same file under a name the app can't read (`pad take 3.wav`).
  - **`showSaveFilePicker`** returns an OPFS file, as if the user had clicked Save.
  - **Toasts and banners** go through a MutationObserver logger, so every quoted line below has a timestamp.
- **The box was loaded** (load average 15–18, 2 CPUs). All timings are much worse than on an M-series Mac, and I
  mark them as such. The one bug I rank highest (O1) doesn't depend on timing.
- **Not covered: Electron.** The README's recommended path is `npm install && npm run build:mac` in Terminal. A
  volunteer can't do that, and it can't be walked here. The local session's MAC_REVIEW
  (`reviews/local-review-mac.md`) covers the first launch of the built app.
- **Which README.** I walked the cloud copy. The Mac copy (c3a3178) adds a "Running on your Mac" section (Gatekeeper,
  where files are kept, `tools/update.command`), which I read too. It is admin material and doesn't change the
  verdicts below.

## The walk, step by step

| # | README says | What the novice sees | Verdict |
|---|---|---|---|
| 1 | "Double-click `Start Worship Rig.command`" (after installing Node from nodejs.org) | Terminal, then Chrome app window. | Needs Node + Terminal; a volunteer can't recover from any error here. See R1. |
| 2 | "Chrome needs one click on the page before it will make sound" | Via the launcher **no click is needed**: the autoplay flag starts audio (`#02b`, overlay hidden). The overlay "Click anywhere to start audio / Your browser needs one click before it can play sound." only appears in a plain tab (`#01b`), where the top bar at the same time says **"Sound OK 10 ms"**. | README wrong for its own path. The plain tab contradicts itself (O14). |
| 3 | "Chrome asks … MIDI devices. Click Allow." | 1.3 s: toast *"Chrome will ask to use your MIDI devices — click “Allow”."*; 6.2 s: *"No MIDI keyboard found. Plug it in any time — it connects automatically. Meanwhile the computer keys A–; play notes."* (8 s, then gone). Top bar: amber **MIDI No device**. | Good copy, but it disappears (O5). |
| 4 | (nothing about waiting) | First 3 s: the title reads **"Sunday Pad + P̶i̶ano"**, with a "⟳ Loading…" chip drawn over the end of the song name (`#03`). Top bar **"LOADING 10/19"** for a long time: `status.ready` took **142 s** on the first boot here (loaded box) and 4.8 s on later boots. | O2 is a layout bug. O3: the novice doesn't know whether to wait. |
| 5 | "No keyboard handy? … A W S E D F T G Y H U J K O L P ;" (paragraph 3 of "Connect your keyboard") | A-D-G plays and the CHORD readout shows **C** (`#08`). The on-screen piano has no letter labels. Settings › MIDI says, in amber, *"No keyboard connected — check the USB cable."* | Works. It is discoverable only through an 8 s toast (O5). |
| 6 | Quick settings (README doesn't mention **Quick**) | *"When locked: This song stays live, This Mac is frozen"*, *"This song’s echo is fixed."*, *"—BPM"*, *"Sustain pedal — press it: light on?"*, *"Hold to restart audio"* (`#07`). | Jargon (O8). |
| 7 | First Space/Echo change: "The menus show the preset's name while the song matches it, and **Custom** once you change a knob"; "*Stage* (the Sunday default)" | On the default song both rows show **"Song’s own / as saved"** selected (`#03`), not Stage. Tapping **Hall** and **Dotted 8th** works instantly; the bottom row shows **"↺ Revert · 2 changed"** (`#08`). Vibe is hidden behind the Space row's **"…"** chip (`#09`). | O4. Also README drift: "Custom" → "Song’s own", "Dotted Eighth" → "Dotted 8th", "No Echo" → "Off". |
| 8 | First recording: "Press REC (or ⌘R) … Chrome asks where to save each recording." | The save dialog appears with the suggested name `Rig 2026-09-28 2129.wav`. Toasts: *"Recording “Rig 2026-09-28 2129.wav”"*, then *"Saved “Rig 2026-09-28 2129.wav” — 00:07"*. On this loaded box, 1.5 s after the click REC didn't look armed yet (`#10`). The *Saved* toast came about 35 s after the stop click, with only the frozen `00:07` in between (`#11`). | Flow OK. The stop feedback is weak under load (O11; timing is loaded-box, unverified on a Mac). |
| 9 | First pad pack: "choose **Settings → Pad folder** … Files it can't read are listed so you can **set their key by hand**. Then set a song's drone to **Files**." | Settings › **MY PADS FOLDER** › **Choose pad folder…** → *"Folder: Pads"*, *"1 of 2 pad files matched to a key; not recognised: pad take 3.wav."* (`#14`). There is **no control to set a key by hand** (grep: none in app/). The drone buttons are **Synth / My Pads**, not "Files". On Perform: *"My Pads: 1 key from 2 files"*. In D: toast *"No pad file for D; using the synth drone."* (`#18`, `#19`). After a reload: *"My Pads reconnected: 1 key."* (with OPFS; a real folder handle may need **Reconnect**). | README promises a feature that doesn't exist (O10). Vocabulary drift. |
| 10 | Saving a new song (README has no section for it) | Edit: the left panel has **SETLIST · New · Rename · Delete** at the top and **+ New · Factory… · Library…** at the bottom (`#20`). **+ New** makes "New Song" (Grand Piano + Warm Pad), appends it as **#20** of *My Set* and makes it live (`#21`). The header says *"The song that’s playing. Changes are heard now and saved with it."* To rename it you click the title; it's an input with no pencil or edit affordance (`#22`). There is no Save button, and none is needed. | Works, but the first two steps are guesses (O12). |
| 11 | "**Perform lock** stops accidental edits during the service." | One tap locks (`#24`): gold frame, **"Locked · playing stays live · hold to unlock"**, and HOLD tags on key/transpose/Revert. Edit and the gear are greyed out; clicking them does nothing and says nothing. A single tap on Locked shows *"press and hold (0.6 s)"* (`#27`). **Holding it for 2.5 s leaves it locked** (`#28`); see O1. | **Bug (O1).** |
| 12 | Settings: "Latency … Output device … Mono output … **Program Change** … **Velocity sensitivity** Soft/Hard/Fixed"; "**Settings → Invert sustain pedal**"; "Settings → **MIDI input**" | The labels are **Touch** (Light/Normal/Heavy/Fixed), **Sustain pedal: Reversed**, **Song buttons: Keyboard picks songs**, and **MIDI KEYBOARD › Input**. My Samples shows a raw path and a Terminal command (*"open Terminal in the Worship Rig folder and run node tools/import-garageband.mjs …"*). The Menu bar section ends in a debug line: *"Low-resource: off · keeps large-set · 332.9 MB kept loaded · level taps 2 · voices 0"* (`#15a–e`). | Vocabulary drift (R3). O9. |

## Where the copy or flow confuses or strands a novice

- **O1 (bug): holding Lock "too long" re-locks.** `components/holdButton.js:175`: after a completed hold, only clicks
  within 600 ms of *activation* are suppressed (`suppressClickUntil = now + 600`). Once unlocked, `needsHold()` is
  false, so the click that follows a later pointerup calls `activate()` again and re-locks.
  - Measured (mouse): 1000 ms → unlocked; 1300 ms and 2000 ms → still locked. The 750 ms attempt also stayed locked
    here, because the 600 ms timer was late on the loaded box.
  - Holding Enter for 2 s does unlock (keyboard path, round2-ui #5).
  - A novice told "hold to unlock" holds until something happens, typically 1–2 s. The lock flickers off and back
    on, and they conclude it's broken.
  - The ui-core test holds exactly 800 ms, so it can't see this.
  - Fix: suppress the one click that ends the activating pointer sequence (set a flag on activation, clear it on
    the next `click` or `pointerdown`) instead of using a time window. Add a test that holds for 2 s.
- **O2 (bug):** during the first seconds the "⟳ Loading…" chip is drawn over the song title
  (`#03`: "Sunday Pad + Pi[ano]"). That is the first thing a novice reads.
- **O3:** the **"LOADING 10/19"** top-bar word has no "you can play now". Its tooltip is *"Every song in the set is
  loaded and switches instantly"*. The novice can't tell whether to wait. Suggest *"Loading sounds 10/19 · play
  now"*, or keep the lamp and put the count in the tooltip.
- **O4:** the first 11 songs in library order (the original factory set, Sunday Pad + Piano through Sub + Shimmer,
  so the default song too) match **no** Space or Echo preset.
  - So the very first screen highlights **"Song’s own · as saved"** on both rows. To a novice that reads as
    "nothing picked" or jargon.
  - README says the Sunday default is *Stage*.
  - Checked with `matchPreset` over `presets.js`: only Anthem, Gospel Stab + B3, Upright + Pad, Music Box, Dream
    Juno, 80s Ballad and Synthwave match (Clav Funk matches the echo only).
- **O5:** the only line that tells a keyboard-less user they can play the computer keys is an 8 s toast, shown next to
  another toast.
  - Afterwards nothing says so: the MIDI lamp says "No device", and Settings › MIDI says *"No keyboard connected —
    check the USB cable."* (it assumes they own one).
  - The on-screen piano doesn't label A…; either.
  - Settings › Computer keyboard lists only *"A W S E D F T G Y H U J K = notes"*, though the code maps up to
    `K O L P ;` (controller.js:52) and the toast says *"A–;"*.
- **O6:** README's Chrome section says Chrome needs a click. Through the launcher it doesn't (O14 covers the plain
  tab).
- **O7:** *"Your screen might dim during long songs. Keep the laptop plugged in."* appears when the wake lock is
  denied. Plugging in doesn't stop dimming. Better: *"Chrome couldn't keep the screen awake — set Displays → never
  sleep for the service."* (Here the wake lock is denied because Chromium is headless; on real Chrome this is rare.)
- **O8: Quick sheet copy.**
  - *"When locked: This song stays live, This Mac is frozen"*: in Chrome it isn't "this Mac", and "frozen" is
    ambiguous.
  - *"This song’s echo is fixed."* means "not tempo-synced", but it reads as "repaired".
  - *"press it: light on?"* is a riddle. Try *"Press your pedal: the light should come on. If it's on when your
    foot is up, tap Reversed."*
- **O9: Settings leaks developer text.**
  - The raw folder path under My Samples.
  - A Terminal command in the GarageBand disclosure.
  - The Menu-bar debug line.
  - "Modes from" / "Modes:", which aren't defined anywhere a novice would see.
- **O10:** README promises manual key assignment for unrecognised pad files; the app only lists them.
  - Either add a per-file key picker (M) or change README to *"rename the file so its name contains the key, e.g.
    'Pad - Eb.mp3'"* (S). The Settings hint already says exactly that.
  - README's *"Pad folder"* / *"Files"* are *"My Pads folder"* / *"My Pads"* in the app.
- **O11:** stopping a recording shows no *"Saving…"* state that a novice notices. On the loaded box the Saved toast
  took about 35 s. The `busy` class exists (main.js), but it doesn't change the label. Suggest REC → "Saving…" while
  `stopping`.
- **O12: new song.**
  - Two "New" buttons ~560 px apart do different things (**New** = setlist, **+ New** = song).
  - The title rename has no affordance.
  - A novice who tweaks a factory song doesn't learn that the change is permanent. "Reset to factory" sits in the
    **⋯ Song** menu, and Revert only covers the changes since the song was loaded.
  - Suggest labels **New setlist** / **+ New song**, a pencil on hover in the title, and a one-line note under
    Revert: *"changes are saved; Revert undoes them"*.
- **O13:** while locked, Edit and ⚙ are disabled silently. A tap should say *"Locked — hold Lock to edit"* (the same
  hint the Lock button already has).
- **O14:** in a plain Chrome tab the top bar says **"Sound OK 10 ms"** while the overlay says the browser needs a
  click, and the console shows 12× "AudioContext was not allowed to start". Only reachable by typing the URL, but the
  two messages contradict each other. Cause not investigated.

## What's missing from README (LOCAL owns README.md; request filed in for-local.md)

- **R1: no volunteer path.** Line 1 of the instructions is Terminal + `npm install` + `npm run build:mac`.
  - Split it into *"Setting it up (once, by whoever looks after the church laptop)"* and *"Playing (volunteers start
    here)"*.
  - The second part should say: double-click Worship Rig in Applications; that's it.
- **R2: no "first five minutes".** Suggested order:
  - it opens on Sunday Pad + Piano;
  - no keyboard? play A S D F G H J K;
  - → / NEXT changes the song;
  - Space row = room size;
  - Lock before the service; hold Lock (just until it lets go) to unlock.
- **R3: vocabulary drift.** Each README term should match the app's label.

  | README | App |
  |---|---|
  | Invert sustain pedal | Sustain pedal › **Reversed** (also in Quick) |
  | the first-run "press your pedal" step | Settings › **Test my pedal** (there is no first-run step) |
  | Program Change | **Song buttons › Keyboard picks songs** |
  | Velocity sensitivity *Soft / Hard / Fixed* | **Touch** *Light / Normal / Heavy / Fixed* |
  | MIDI input | **MIDI keyboard › Input** |
  | Pad folder / drone **Files** | **My Pads folder** / drone **My Pads** |
  | Custom | **Song’s own** (and Vibe: **your own mix**) |
  | Dotted Eighth, No Echo | **Dotted 8th**, **Off** |
  | Edit → Songs (Export/Import) | Edit › **Export / import** (bottom-left) or Settings › **Library & backups** |

- **R4: missing sections.**
  - The Perform screen at a glance: strips, ON tiles, KEY / "you play", Transpose, WHEEL, Swell, NEXT, Revert,
    Fade out, PANIC, Lock. One annotated screenshot would do.
  - **Quick** (not mentioned at all).
  - "Make your own song" (Edit › + New, click the title to rename, changes save themselves, ⋯ Song › Reset to factory).
- **R5: false claims.** Remove *"set their key by hand"* (O10) and *"Chrome needs one click"* for the launcher path
  (O6). Fix the computer-key list in Settings, or leave README as it is (README is right; Settings is incomplete).
- **R6:** mention that tweaking a factory song changes it for good, and that Reset to factory brings it back.

## The first 60 seconds should be

- **0–5 s.** Opens on Perform, *Sunday Pad + Piano*, sound running (the launcher and the Mac app need no click).
  - The title is never covered.
  - The top bar says *"Loading sounds 3/19 · play now"*.
- **One "Start here" card** instead of a toast. It is persistent until dismissed, sits in the Notes panel, and is
  stored in localStorage so it shows once:
  - *"No keyboard yet? Play **A S D F G H J K** on your computer (Space = sustain). Plug a USB keyboard in any time —
    it connects by itself."*
  - While no MIDI device is connected, the on-screen piano shows the letters.
- **5–30 s.** They play and see the CHORD readout. The card's second line says: *"→ or NEXT = next song. The
  **Space** row changes the room."*
  - The first 11 factory songs should show a named Space (Stage/Room/Hall) rather than "Song’s own". That is a sound
    change, so it needs a listen.
- **30–60 s.** Third line: *"Before the service: tap **Lock**. To unlock, hold it."*
  - The card closes after the first Next, or on ×.
  - Lock must unlock however long it's held (O1).

## Prioritized fix list

Owners follow COORDINATION.md. Size: S ≤ 1 h, M ≤ half a day, L more.

| Pri | Fix | Size | Owner / file |
|---|---|---|---|
| 1 | **O1** Lock re-locks after a hold longer than ~1.2 s: suppress the click that ends the activating press, not a 600 ms window. Add a 2 s-hold test. | S | CLOUD `views/components/holdButton.js`, ui-core |
| 2 | **O2** "Loading…" chip over the song title | S | CLOUD `views/perform.js` / `styles.css` |
| 3 | **O5** Settings MIDI line: "No keyboard connected — plug one in, or play the computer keys A–;". Computer-keyboard row lists `K O L P ;`. | S | CLOUD `views/settings.js` |
| 4 | **R3/R5/O6/O10** README vocabulary table, remove the false claims | S | LOCAL `README.md` (for-local.md) |
| 5 | **O9** Menu-bar debug line → Diagnostics; hide raw path/Terminal command behind the disclosure; define "Modes" | S | CLOUD `views/settings.js` (C7 section) |
| 6 | **O8/O7** Quick sheet and wake-lock copy | S | CLOUD `components/quickSheet.js`, `main.js` |
| 7 | **O3** Loading copy "· play now" | S | CLOUD `main.js` |
| 8 | **O12** "New setlist" / "+ New song", title pencil, "changes are saved" note | S | CLOUD `views/edit/panels/{setlist,song-header}.js` |
| 9 | **O13** Tap on a disabled Edit/⚙ while locked → "Locked — hold Lock to edit" | S | CLOUD `main.js` |
| 10 | **O11** REC shows "Saving…" while stopping | S | CLOUD `main.js` / `styles.css` |
| 11 | **First-60-s card** + on-screen key letters while no MIDI device | M | CLOUD `views/perform.js`, `main.js` |
| 12 | **R1/R2/R4/R6** README: volunteer path, first five minutes, Perform at a glance, Quick, make-your-own-song | M | LOCAL `README.md` |
| 13 | **O10** Per-file key picker for unrecognised pad files (or keep the README fix only) | M | CLOUD `views/settings.js`, `controller.attachPads` |
| 14 | **O14** Plain-tab "Sound OK" while audio is still gesture-blocked | M | CLOUD `main.js` (investigate) |
| 15 | **O4** Named Space/Echo on the first 11 factory songs (needs a listen and FACTORY_VERSION rules) | L | CLOUD `presets.js` + audition |
| 16 | **R1** A prebuilt app handed to volunteers (no Node/Terminal on their side) | L | LOCAL / Ryan |
