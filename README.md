# Worship Rig

Project page: https://ryanmye.github.io/worship-rig/

Worship Rig turns your Mac and a MIDI keyboard into a live keys rig for church, ambient and lofi sets.
Plug in your keyboard, pick a song, and play. You get grand and upright pianos, electric pianos, organ, pads,
strings, synths, mallets and guitars (see [Sounds](#sounds)), a key "drone" pad that holds the song's key underneath
you, and one-button song changes that never cut off a note you're holding. It can also record your playing to a WAV
file, and play sampled instruments you convert from GarageBand ([My Samples](#my-samples-garageband-and-your-own-sounds)).

It runs two ways, with exactly the same sound and screens:

- **As a Mac app** ("Worship Rig.app"), which you build once on your own Mac. This is the recommended way.
- **In Google Chrome**: double-click `Start Worship Rig.command`. Use this if you can't build the app.

Nothing is downloaded while you play. Everything, the sounds included, lives on your Mac.

---

## Build the Mac app (once)

You need an Apple Silicon Mac (M1 or newer) and **Node.js** from <https://nodejs.org> (the "LTS" installer).

1. Open **Terminal** (press ⌘-Space, type *Terminal*, press Return).
2. Type `cd ` (with a space after it), drag the `worship-rig` folder onto the Terminal window, and press Return.
3. Run these two commands one after the other. The first takes a few minutes; it downloads the build tools.
   ```
   npm install
   npm run build:mac
   ```
4. The app is now in `dist/mac-arm64/Worship Rig.app`. Drag it into your **Applications** folder.
   (A `.zip` and a `.dmg`, `dist/Worship-Rig-arm64.zip`/`.dmg`, are made too, for moving it to another Mac.)

**First launch:** double-click the app. It isn't from the App Store, but the build signs it for this Mac,
so it just opens. A copy moved to *another* Mac through a browser, AirDrop or Messages needs one extra step the
first time: see [Running on your Mac](#running-on-your-mac).

Want to try it without building? From the same Terminal folder run `npm start`.

## Run it in Chrome instead

Double-click **`Start Worship Rig.command`** in the `worship-rig` folder. A Terminal window opens (leave it open
while you play; closing it stops Worship Rig), and Chrome opens Worship Rig in its own window.

- If Node.js isn't installed, the window tells you where to get it.
- The first time, macOS may ask whether you want to open a file downloaded from the internet. Click **Open**.
- Chrome asks whether Worship Rig may use your **MIDI devices**. Click **Allow**.
- Chrome needs one click on the page before it will make sound ("Click to start audio"). The Mac app doesn't.
- Songs you make in Chrome and songs you make in the Mac app are stored **separately**. To move them across,
  use **Export** in one and **Import** in the other (Edit → Songs).
- **Only one Worship Rig window plays.** If you double-click the launcher again while Worship Rig is already open,
  no second window opens (the Terminal says so; switch to the one you have). If a second window does get opened
  (for example by typing the address into another tab), it shows *"Another Worship Rig window is open — this one is
  read-only and muted"*: it makes no sound, ignores the keyboard and saves nothing, so two windows can never play
  every note twice or undo each other's edits. Close the other window and this one takes over by itself.
- If Chrome's pad folder is still allowed, it reconnects by itself when Worship Rig starts; otherwise Settings shows
  **Reconnect** (Chrome asks once).

## Connect your keyboard

1. Plug the keyboard in with USB (or a USB-MIDI interface) **before or after** opening Worship Rig; either works.
2. The MIDI light on the Perform screen turns on when notes arrive, and your keyboard's name appears next to it.
3. If there's no light: check **Settings → MIDI input**. "First keyboard" works for most setups. "All inputs" listens
   to everything (it can double notes if your keyboard shows up twice). You can also pick one device by name.

If you unplug the keyboard mid-song, any notes it was holding are released, so nothing gets stuck. Plug it back in
and keep playing.

No keyboard handy? Your computer keyboard plays notes too: **A W S E D F T G Y H U J K O L P ;** play C4 up to E5,
**Z / X** shift the octave down or up, and **Space** is the sustain pedal.

## Sustain pedal and polarity

Plug the sustain pedal into your keyboard's **Sustain** jack. If the sound holds when your foot is **up** and stops
when you press down, your pedal is "the other polarity" (common with cheap square footswitches). Turn on
**Settings → Invert sustain pedal**. The first-run "press your pedal" step checks this for you.

## Songs and setlists

A **Song** is a complete sound. It sets which instruments are playing, how loud each one is, the effects, which
key you play in and which key the band hears, the drone, and what the wheels do. There are four **slots** per song:

| Slot | Colour | Usually |
|---|---|---|
| Keys | orange | piano / electric piano / organ |
| Pad | green | the soft sustained sound |
| Extra | blue | bells, strings, a second texture |
| Bass | purple | left-hand bass (low notes only) |

A **Setlist** is the order of songs for a service. Step through it with the **◀ ▶** buttons, the **← →** arrow keys,
**⌘← / ⌘→**, or a footswitch (see MIDI Learn). When you switch songs, notes you're already holding (or holding with
the pedal) keep ringing on the old sound until you let go. Only new notes use the new song, so switches are
seamless. The **Ready** light means every song in the setlist is loaded and switching will be instant.

Worship Rig comes with 19 factory songs. Each one has a note explaining what it's for and what the wheels do.

| Category | Songs |
|---|---|
| Worship | Sunday Pad + Piano, Building Swell, Prayer Wash, Organ Swell, Anthem, Gospel Stab + B3, Upright + Pad |
| Keys | Grand Piano, Rhodes, Felt Piano, Clav Funk |
| Lofi | Lofi Rhodes, Dusty Piano |
| Ambient | Glass Ocean, Sub + Shimmer, Music Box Lullaby, Dream Juno |
| Synth | 80s Ballad, Synthwave |

Change them as much as you like: **Reset to factory** puts one back the way it was. If you used an earlier version,
the eight newer songs (Anthem through Synthwave) are added to your library the next time you start Worship Rig.
Your own songs and setlists aren't touched.

## Sounds

Every instrument is on your Mac. None is streamed. In **Edit**, pick an instrument for a slot from these groups:

| Group | Instruments |
|---|---|
| Piano | Grand Piano (Salamander), Upright Piano, Bright Piano, Honky-Tonk Piano, Harpsichord |
| Electric Piano | Rhodes, Wurlitzer, Electric Grand, Clavinet |
| Organ | Gospel Organ, Soft Organ, Full Organ, Church Organ (drawbars, rotary speaker) |
| Synth Pads | Warm Pad, Glass Pad, Strings, Supersaw Pad, Juno Pad, Shimmer Pad |
| Synth Keys | Soft Keys (FM electric piano), DX E-Piano, Bell, Pluck, Poly Stab |
| Brass & Leads | Analog Brass, Square Lead |
| Bass | Sub Bass, 808 Sub, Synth Bass (play them mono, on the lowest note) |
| Mallets & Bells | Vibraphone, Celesta, Music Box, Marimba, Xylophone, Glockenspiel, Tubular Bells, Steel Drums |
| Guitar & plucked | Nylon Guitar, Steel-String Guitar, Clean Electric Guitar, Harp, Dulcimer, Kalimba |
| My Samples | whatever you add yourself (next section) |

By style:
- **Worship:** Grand or Upright Piano with Warm/Glass/Supersaw Pad and the key drone; Gospel Organ; Strings for builds.
- **Gospel / soul / funk:** Gospel Organ, Rhodes, Wurlitzer, Clavinet, Poly Stab, Synth Bass.
- **Ambient:** Glass, Shimmer and Juno Pads, Bell, Music Box, Celesta, with the Ambient space.
- **Lofi:** Soft Keys, Rhodes or piano through the Lofi Tape vibe.
- **80s / synthwave:** DX E-Piano, Juno Pad, Analog Brass, Square Lead, 808 Sub.

Every instrument is level-matched, so switching instruments in a slot doesn't jump in volume.

## Space, Echo and Vibe (FX presets)

The FX column in Edit has three preset menus (the Perform screen has quick Space and Vibe menus). Each one only
changes the settings it's about:

- **Space** sets the reverb: *Dry*, *Room*, *Stage* (the Sunday default), *Hall*, *Cathedral*, *Ambient Wash*.
- **Echo** sets the delay: *No Echo*, *Slapback*, *Quarter Note*, *Dotted Eighth* (the modern-worship ping-pong), *Ambient
  Trails*. The tempo-synced ones follow the song's **tempo**, so set that (or tap it) first.
- **Vibe** sets space, echo and the lofi/chorus amounts together: *Sunday*, *Full Set*, *Prayer*, *Jam*, *Lofi Tape*,
  *Ambient*.

The menus show the preset's name while the song matches it, and **Custom** once you change a knob. Picking a Space
never touches your echo, and the other way round. The newer factory songs use these presets, so you can see at a
glance which space each one is in.

## My Samples: GarageBand and your own sounds

Worship Rig can also play sampled instruments that live outside the app, in a **My Samples** folder:

- `Music/Worship Rig/Samples` in your home folder (the Mac app's **Rig → Open My Samples Folder** opens it, creating
  it if needed), and
- `user-samples/` inside the `worship-rig` folder, if you run Worship Rig from there.

Each sub-folder is one sample pack: a `manifest.json` plus its audio files (MP3, WAV, M4A/AAC, AIFF or CAF). The
instruments appear in the instrument picker under **My Samples**.

**GarageBand and Logic instruments.** If GarageBand or Logic is installed on your Mac, `tools/import-garageband.mjs`
converts their sampled instruments (Steinway Grand Piano, strings, choirs and more) into this folder. It also works
for sound packs you downloaded in GarageBand. Step-by-step instructions are in
[docs/garageband-import.md](docs/garageband-import.md) (also in the app: **Help → Importing GarageBand Sounds**).
Those sounds are Apple's and licensed to you for personal use only, so they stay on your Mac: Worship Rig never
copies them into the app, the build or git.

After adding or removing packs, choose **Rig → Rescan My Samples** (or **Settings → My Samples → Rescan**). If a
message says to restart, quit and reopen Worship Rig.

## Easy Transpose

Say the band plays in **B** but you'd rather play in **G** shapes. Set **Play In: G** and **Hear In: B** on the song.
You play G shapes and everyone hears B. The **− / +** buttons on the Perform screen move the key a half-step
("take it up one") without touching the song's settings. The drone always follows the **Hear In** key.

## Wheels and Swell

- **Mod wheel**: usually brings the **pad** in and out, so you can start on piano alone and swell the pad for the
  chorus. Until you touch the wheel it counts as "all the way up", so pads never start silent.
- **Expression pedal** (if you have one): does the same as the mod wheel by default.
- **Pitch-bend wheel**: depends on the song. It might bend the synth pitch, lift the drone (push up) and
  tuck it away (pull down), switch the organ's rotary speaker between slow and fast, or do a lofi tape-stop.
- **No wheels?** Press **Swell** (or **Shift+↑**). The pad rises over a few seconds. Press it again to go back.
  **↑ / ↓** nudge an on-screen wheel.
- **Keyboard volume knob** (MIDI CC7) controls the master volume.

## Drone pads

The drone is a soft, endless pad in the song's key: root, fifth and octave, with no third, so it works under
major and minor chords alike. Turn it on per song (**Drone → Synth**). It crossfades smoothly when the key changes
and can keep going across song changes.

**Using your own pad recordings.** Many worship pad packs are free, for example:
- **Churchfront** "Warm" ambient pads: <https://churchfront.com/ambient-pads/> (free; they email you the
  download link).
- **Spread Worship** pads in all 12 keys (12 MP3s, about 19 minutes each): the free download link is in
  <https://spreadworship.com/blog/how-to-use-pads-in-worship/> (their "Simple Pads" pack on Gumroad is a paid,
  larger set).
Download one, unzip it anywhere (e.g. `Music/Pads`), then choose **Settings → Pad folder**. Worship Rig works out
each file's key from its name ("Pad - C#.mp3", "Warm Pad in Eb", "Ambient_Pad_-_F#m.mp3" …). Files it can't read
are listed so you can set their key by hand. Then set a song's drone to **Files**. For a minor song it plays the
relative major's file (A minor → C) unless you turn that off. Your pad files are never copied into the app.

## Recording

Press **REC** (or **⌘R**) to record exactly what comes out of Worship Rig. Press it again to stop.

- **Mac app:** recordings go straight to **Music → Worship Rig** as `Rig 2026-10-04 1030.wav`. No dialog.
  The file is written as you play, so even if something crashes, everything up to the last few seconds is saved.
  **Help → Open Recordings Folder** takes you there.
- **Chrome:** Chrome asks where to save each recording. Be aware that Chrome only creates the real file when you
  press stop: if the Chrome window crashes or is force-quit mid-recording, that take is lost. If Chrome can't show
  the save dialog, it records internally and downloads the file to your **Downloads** folder when you stop.
- Recordings are 16-bit stereo WAV at your Mac's audio rate (usually 48 kHz). That's about 11 MB per minute.

## MIDI Learn: map a footswitch to "Next Song"

The most useful thing you can do with MIDI Learn: put a footswitch on your keyboard's second pedal jack (or use a
button/pad on your controller), then go to **Settings → MIDI Learn**, click **Learn** next to **Next Song**, and
press the footswitch. Now you can change songs without taking your hands off the keys. Do the same for
**Previous Song** if you have two.

You can also learn **Panic**, **Fade Out All**, **Swell**, and faders/knobs for each slot's level, the drone level,
the reverb level and the master volume. Learned faders use "pickup": a hardware knob does nothing until you move it
past the value on screen, so the sound never jumps.

## Other handy controls

- **Panic** (**⌘.** or **Esc**): silences stuck notes instantly (the drone keeps going).
- **Fade Out All** (**⌘⇧F**): everything, drone included, fades out over about 6 seconds. Good for the end of a
  prayer time. The next note you play brings the volume back.
- **Perform / Edit** (**⌘E**): the Perform screen is big and simple for the service. Edit is where you build songs.
- **Perform lock** stops accidental edits during the service.
- The Mac app keeps your Mac from going to sleep while it's open, and saves a backup of all your songs now and then
  and every time you close it (**Help → Open Backups Folder**; the last 10 are kept). **Rig → Import Latest
  Backup…** puts the newest one back (your current songs are backed up first).
- Closing or quitting the Mac app while recording asks first. The part recorded so far is always kept.
- If audio has to restart during a recording (Restart audio, or the output device disappears), the take is split:
  the first part is saved and recording continues in a new file (a message says where).

## Settings

- **Latency** (the delay between pressing a key and hearing it): *Lowest* is best for playing. If you hear
  crackles, try *Balanced*, then *Safe*. The Perform screen shows the delay in milliseconds and warns above 40 ms.
- **Output device**: send the sound to your audio interface or the sound desk instead of the headphone jack.
- **Mono output**: turn on if the church sound desk takes a single (mono) cable from you.
- **Program Change**: off by default, because many keyboards send these by accident and would jump songs.
- **Velocity sensitivity**: *Soft* makes gentle playing louder; *Hard* needs more force; *Fixed* ignores how hard
  you play.

## Troubleshooting

- **No sound at all.** Check the volume and output device. If the Perform screen says *Audio stopped*, press
  **Restart audio** (also in the **Rig** menu). This fixes most problems after unplugging headphones, an interface,
  or waking the Mac from sleep.
- **Keyboard lights up but no sound (Chrome).** Click once on the page to start audio.
- **No MIDI light (Chrome).** Chrome must be allowed to use MIDI devices. If you clicked *Block*, click the icon at
  the left of the address bar (or Chrome settings → Privacy → Site settings → MIDI devices) and allow it.
- **Notes feel late.** Bluetooth headphones and speakers add a lot of delay (100 ms or more). Use wired headphones
  or an audio interface for playing. Also try *Latency: Lowest*.
- **Crackles or dropouts.** Close other heavy apps, and try *Latency: Balanced*.
- **The pedal works backwards.** Settings → Invert sustain pedal.
- **Stuck note.** Press **Panic** (⌘.).
- **"Worship Rig is already running".** Starting it twice just reuses the first one. That's fine.
- **Mac app: "Port 8438 is in use … opened on port 8439".** Something else (often the Chrome launcher's server, or
  a copy of Worship Rig that didn't quit) is using the app's usual address. Songs are saved per address, so the
  library looks like the factory songs. Click **Import Latest Backup** in that message to continue with your songs,
  or quit the other program and restart Worship Rig. Whatever you change on the other port is backed up when you
  close the app, and the next normal start offers that newer backup (Rig → Import Latest Backup…).
- **"Your changes could not be saved".** The browser's storage is full or blocked. Worship Rig keeps retrying;
  export the library (Settings) to be safe. If your saved library can't be read at all, it is kept untouched (and,
  in the Mac app, copied to the backups folder) and nothing overwrites it.

## Running on your Mac

**Downloads.** Each release on GitHub has four files. Pick **arm64** for an Apple Silicon Mac (M1 or later) and
**x64** for an Intel Mac; `Worship-Rig-<arch>.dmg` opens a window where you drag the app to Applications,
and the `.zip` holds the same app if you'd rather unzip it. Each is about 200 MB, and the app is about 370 MB
installed. They aren't notarized, so the first open needs the Gatekeeper steps below.

**Building.** After `npm install`, `npm run build:mac` takes about half a minute on an M-series Mac. It makes
`dist/mac-arm64/Worship Rig.app` (about 365 MB) plus `dist/Worship-Rig-arm64.zip` and `.dmg` (about
190 MB each). For Intel: `npx electron-builder --mac dir zip dmg --x64 --publish never` (app in `dist/mac/`).
The app has to stay under 500 MB on disk (around 400 MB is fine). The build check (`build-lint`) fails above
480 MB and prints what takes the space.

**Releases** (maintainer): push a `v*` tag matching `package.json`'s version; the release workflow builds and
attaches dmg+zip for arm64 and x64 to a prerelease. Run it by hand from Actions with *dry_run* ticked to only build.

**First open on another Mac.** The app isn't notarized by Apple. A copy that came through a browser, AirDrop or
Messages makes macOS say *"Apple could not verify 'Worship Rig' is free of malware"*. On macOS 15 and later,
right-click → Open no longer gets past this. Instead:
1. Click **Done**.
2. Open **System Settings → Privacy & Security**, scroll down to *"Worship Rig" was blocked*, and click
   **Open Anyway**.

Or run this once in Terminal: `xattr -dr com.apple.quarantine "/Applications/Worship Rig.app"`. If macOS says
*"damaged"*, the copy itself is broken. Copy the zip again and double-click it to unpack.

**Where things are kept.**
- **Songs and setlists** live in the app's own browser storage, which is kept separately for each address. The
  Mac app (`127.0.0.1:8438`) and Chrome (`127.0.0.1:8437`) therefore have separate libraries. `npm start` and the
  built app share one.
- **App folder**: `~/Library/Application Support/Worship Rig/`. It holds that storage, plus `rig-shell.json` (your
  pad folder, once chosen).
- **Backups**: `backups/rig-YYYYMMDD-HHMMSS.json` in that folder. One is written every time you close the window
  or quit, as long as you've changed anything since the factory songs. More are written now and then while you
  play. The newest 10 are kept. Open them with **Help → Open Backups Folder**.
- **Recordings**: `~/Music/Worship Rig/Rig 2026-10-04 1030.wav` (`… 2.wav` if that name is taken). The folder is
  created at your first recording.
- **My Samples**: the built app only looks in `~/Music/Worship Rig/Samples/`. The `user-samples/` folder in the
  repo is only scanned when you run from source (`npm start` or the Chrome launcher). To use a pack in the app,
  put it in `~/Music/Worship Rig/Samples/`.

**MIDI and privacy prompts.** macOS doesn't ask anything for a USB MIDI keyboard. The Mac app allows MIDI for its
own page, so you won't see a prompt; Chrome asks once. Worship Rig never opens the microphone, so there's no
microphone prompt either.

**Sleep.** While the app is open the screen stays on, so the Mac won't doze off mid-service. Closing the lid still
puts it to sleep. After waking, play a note; if the top bar says *Audio stopped*, press **Restart audio**.

**One window at a time.**
- Opening the app again just brings its window to the front.
- Closing the window quits Worship Rig, like **⌘Q**. Both ask first if you're recording. **⌘W** does nothing on
  purpose, so a stray keystroke can't end your set.
- Don't run the Chrome version and the app at the same time: both would play every note. The app warns you if a
  Chrome window of Worship Rig is open, and the Chrome launcher's Terminal warns you if the app is open.
- A second Chrome window on the same address is read-only and muted (see [Run it in Chrome
  instead](#run-it-in-chrome-instead)).

**Updating.** Double-click **`tools/update.command`** in the `worship-rig` folder to pull the latest code, rebuild
the app and open it, all in one step. A Terminal window shows progress and closes itself when it's done; if
something goes wrong (no internet, local changes in the way, a build error) it prints a plain-English explanation
and waits for a key press so you can read it. It refuses to run over local changes, so it's safe to double-click
any time.

## Manual check on your Mac (5 minutes, after each build)

1. `npm run build:mac` finishes; the app opens from Applications.
2. The MIDI light and your keyboard's name appear when you play.
3. The sustain pedal holds notes the right way round (use Invert if not).
4. Every factory song makes sound. Try the mod wheel and pitch bend on each.
5. Hold a chord (with or without the pedal) and press Next Song: the chord keeps ringing until you let go, and the
   next notes use the new sound.
6. Record 30 seconds, stop, and play the file from Music → Worship Rig.
7. Unplug the keyboard while holding a chord: nothing gets stuck. Plug it back in: it plays again.
8. Change the output device in Settings (e.g. to headphones/interface): the sound moves there.
9. Close the lid or let the Mac sleep, wake it: sound comes back (press Restart audio if it says Audio stopped).

## Licenses

The app's own code is free software under the **GNU GPL v3** (`LICENSE`; SPDX `GPL-3.0-only`). The bundled sounds
keep their own licences, listed below and in `LICENSES.md`.

The grand piano is the Salamander Grand Piano by Alexander Holm (CC BY 3.0). The upright piano comes from VS Chamber
Orchestra 2: Community Edition by Versilian Studios (CC0). The other 21 sampled instruments come from the Musyng Kite
General MIDI soundfont, as rendered by gleitz/midi-js-soundfonts, under **CC BY-SA 3.0** (attribution, share-alike).
Earlier versions of this README said MIT, which was wrong. The synths, organ and drone are generated in code. See
`LICENSES.md` for the full notices and what was changed. Pad files and My Samples stay on your Mac and are never
redistributed.

---

## For developers

Plain ES modules, no build step for the app itself. Node ≥ 22.12 for the tools and tests (Electron 44 requires it).

```
main.js, preload.js, server.js   Electron shell and the local HTTP server (also used by serve.mjs)
serve.mjs                        Chrome launcher / server CLI (Start Worship Rig.command runs it)
app/index.html, app/styles*.css  the page
app/js/main.js                   bootstrap: store → engine → controller → views
app/js/store.js                  library + settings (localStorage), validation, factory seeding
app/js/controller.js             the only place store and engine meet (song switching, MIDI/keyboard, restarts)
app/js/midi.js, recorder.js      Web MIDI input + learn; WAV recorder (AudioWorklet)
app/js/presets.js                factory songs
app/js/shared/                   pure helpers: params (address grammar), fx-presets, music, automation, wav …
app/js/engine/                   Web Audio engine: audio.js (graph, prepare/commit), fx.js, sampler.js, synth.js,
                                 synth-extra.js, organ.js, drone.js, instruments.js (registry), gain-trims.json
app/js/views/                    Perform, Edit, Settings (+ components/)
app/samples/                     bundled samples + manifest.json (see LICENSES.md)
tools/                           calibrate, audition, sample downloaders, import-garageband
test/                            node:test + Playwright + Electron suites (test/README.md)
docs/                            developer and user docs (below)
```

- `npm start` runs the Electron app from source; `npm run serve` runs the Chrome version.
- `npm test` runs every suite except the 20-minute soak; `node test/run-all.mjs --fast` also skips the Electron
  suites. `node test/phase1/shell/run.mjs` runs the shell suite alone. See `test/README.md`.
- Electron serves `app/` from a small built-in web server on `http://127.0.0.1:8438/` (Chrome version: `:8437`).
  The address normally never changes, because songs are saved per address. Electron always runs its own server
  (never another process's); if 8438 is taken it uses the next free port, shows a dialog, and offers the newest
  disk backup (backups carry an `origin` field; one is written on every window close). Nothing about the port is
  persisted, so the next start tries 8438 again.
- Single instance: Electron uses the app single-instance lock; the page also takes the Web Lock `rig-instance`
  (secondary windows are read-only and muted, `controller.status.instance`). `serve.mjs --open` doesn't open a
  second Chrome window when the page pinged `/api/heartbeat` within 45 s.
- The renderer is plain ES modules under `app/js/` (no build step). `server.js`, `main.js` and `preload.js` are the
  shell. `SPEC.md` is the original design contract; `CONTRACT_CHANGES.md` records every change to it.
- Docs: [docs/architecture.md](docs/architecture.md) (how the pieces fit, as built),
  [docs/garageband-import.md](docs/garageband-import.md) (My Samples importer), `test/README.md` (test suites),
  `LICENSES.md`, and `CLAUDE.md` (conventions for coding sessions).
