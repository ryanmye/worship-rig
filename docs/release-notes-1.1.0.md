Worship Rig 1.1 adds a click with a count-in, saved scenes for each song, and a touch that fits your own keyboard.
Every new feature stays out of the way until you turn it on. A 1.0 library opens and plays the same as before.

### Click and count-in

Tap **Click**, next to the tempo on Perform, to start a click at the song's tempo. Tap it again to stop. In
**Edit › Song › Click** you set the song's **Time** (4/4, 3/4, 2/4, 5/4, 6/8 or 12/8), which is saved with the song.
The same place has the **Count-in** (Off, 1 bar or 2 bars), what happens **After the count-in** (**Keep clicking** or
**Go quiet**) and the level, which apply to every song. The click never holds up a song change. Press Next whenever
you like, then tap Click when the leader is ready. If the click is running when you change songs, it picks up the new
song's tempo within a beat and starts a new bar there. If you have an
audio interface with 4 outputs, **Settings › Audio › Click output › Outputs 3–4** puts the click in your in-ears only,
and the music stays on 1–2. Recordings leave the click out unless you turn on **Record the click**.
**Settings › MIDI keyboard › Clock out** sends MIDI clock to a drum machine or delay pedal while the click runs. In
6/8 and 12/8 the tempo counts the dotted quarter, the beat you'd tap. Click is hidden for a song with no tempo, and the
app always starts with the click off.

### Scenes

You can save up to three sets of levels per song, such as verse, chorus and bridge, and step through them with a
footswitch. Set the faders, the ON switches, the drone level and the mod wheel the way you want. Then open
**Quick › This song** and tap **Save as scene** 1, 2 or 3, or save it in **Edit › Song › Scenes**. Perform then shows
**SCENE 1 2 3** in the song row. Tap a number to play that scene, and tap the lit number to go back to the song's own
levels. A change takes half a second to glide over, and the notes you're holding keep sounding. To use a footswitch, go
to **Settings › MIDI Learn**, click Learn next to **Next scene**, and press the switch. One switch cycles through all
the scenes. Every song starts on its own levels. A song with no scenes looks the same as in 1.0.

### Your keyboards (touch)

**Settings › MIDI keyboard › Your keyboards** lists every keyboard you've plugged in, plus the computer keys.
**Touch…** gives one keyboard its own feel. Press **Fit to my touch**, play six soft notes and then six hard ones, look
at the curve, and press **Use this**. **Back to standard** undoes it. **Remember** tells the app to pick that keyboard
when the input is set to **First keyboard (automatic)**, and **Forget** clears what was saved for it. Each keyboard's
touch is saved on this Mac under the keyboard's name. It isn't included when you export your library, and an import
doesn't replace it. Sounds set to **Normal** response follow the keyboard's own touch. To give one sound its own curve,
use the new **Own** choice in Edit's Response setting.

### Pedal

Two new switches are in **Edit › Master › Wheels & pedal**. **Pedal curve › Log (fine when quiet)** gives an
expression pedal finer control at the quiet end. **Sustain pedal also swells the drone** brings the drone up while you
hold the sustain pedal and lets it sink back when you lift your foot. Both are saved per song and off until you turn
them on.

### Global shortcuts (Mac app)

In **Settings › Menu bar › Global shortcuts**, turn on **Work in any app** to use these keys from any app, even with
the Worship Rig window hidden:

- **Next song** / **Previous song** (through the setlist): ⌃⌥⌘] / ⌃⌥⌘[
- **Panic (all notes off)**: ⌃⌥⌘P
- **Master louder** / **Master softer** (2 dB): ⌃⌥⌘= / ⌃⌥⌘-
- **Next scene** / **Previous scene**: ⌃⌥⌘. / ⌃⌥⌘,

To set your own keys, click a shortcut and press the new combination. macOS doesn't tell apps when another app uses
the same shortcut, so if one does nothing, pick another. The shortcuts are off until you switch them on.

### Update check (Mac app)

Once a day the app asks GitHub whether a newer version is out. When one is, **Settings › About** says so, for example
"Version 1.1.1 is available. You have 1.1.0." It also shows a **Download** button, which opens the right .dmg for your
Mac in your browser, and a **What's new** button. The check never downloads or installs anything by itself and never
interrupts Perform. It's the only time Worship Rig goes online, and the **Check for updates** switch in the same place
turns it off.

### GarageBand / Logic importer (Mac app)

**Settings › My Samples › Import from GarageBand / Logic…** lists the sampled instruments that GarageBand or Logic
installed on this Mac, with their size. Tick the ones you want and press **Import**. They are converted into your My
Samples folder while you keep playing, and they show up in the instrument picker without a restart. **Stop** doesn't
leave a half-converted instrument behind. For the best result, install ffmpeg first (in Terminal:
`brew install ffmpeg`). Without it, the app uses the Mac's own converter, which is slower. Apple's sounds are for your
own use on this Mac: Worship Rig never copies them into the app and never shares them. The Terminal tool
(`tools/import-garageband.mjs`) still works.

### Themes and polish

- Each theme now uses its own wording. Sanctuary, for example, says "All 12 ready", and after the last fade of a
  setlist, "That’s the set. Thank you for serving." Classic keeps the wording it had.
- The Daylight themes have a **Light: Day · Stage · Auto** switch in **Settings › Appearance**. **Auto** follows your
  Mac's light or dark appearance, and Perform lock always shows Stage.
- The EQ graph now matches each theme, including a light graph in Daylight Day.
- The Sustain light on each strip shows when the pedal is down.
- Long chord names shrink to fit the chord card.
- The Effects chips show each sound's EQ curve.
- The Quick sheet fits on smaller screens.
- On a smaller screen, the first-run Start card now shows up by itself in Notes.

### Fixes

- **Frozen drone:** in low-resource mode (menu bar, or the window hidden) the drone plays from a recorded loop. That
  loop could dip in volume by a few dB, or swell slightly, once each time it went around. It now keeps
  an even level.
- **Panic** also stops the click and the count-in, and the MIDI clock sends Stop. The drone keeps going, as before.
- Moving between piano songs uses less memory, because the same piano samples are no longer kept twice.
- In the Chrome version, a recording explains that Chrome only writes the file when you stop it.
- Improved text contrast in Classic's Quick sheet and the menu-bar popover.

### Install / update

**Which file?**
- Apple Silicon Mac (M1 or later): `Worship-Rig-arm64.dmg`
- Intel Mac: `Worship-Rig-x64.dmg`
- The `.zip` files hold the same app. Use one if a .dmg won't open.

**Updating from 1.0:** quit Worship Rig, open the .dmg and drag Worship Rig to Applications, replacing the old copy.
Your songs, setlists and settings stay.

**First open:** like 1.0, this build is **ad-hoc signed**, not notarized by Apple. On macOS 14 and earlier, right-click
the app › **Open**. On macOS 15 and later, click **Done**, then **System Settings › Privacy & Security › Open
Anyway**. See the README ("Running on your Mac → First open on another Mac") for the full steps.

**From 1.1 on**, the app tells you about new versions itself, in Settings › About (see "Update check" above).

Starter library: worship-rig-starter-library.json. Import it via **Settings › Library & backups** if you want the
factory set back.

### Not yet checked on real hardware

<!-- LOCAL: from reviews/v11-mac-checklist.md "LOCAL (Mac) checks". Delete each line once it is checked on the Mac,
     and the whole section when it is empty. The "Before tagging" items (test runs, CI, build size) are not listed:
     they must pass before the tag. -->

Everything above was built and tested in software. These parts still need a real Mac, real hardware or real ears:

- Global shortcuts from another app with the window hidden, which app wins when another app (for example Rectangle)
  holds the same combination, and recording a ⌃⌥⌘ combination in Settings.
- The update check in the installed app: the "available" line, Download and the switch that turns it off.
- Fit to my touch and Remember with two real keyboards plugged in.
- An expression pedal on the Log curve, and how "Sustain pedal also swells the drone" sounds.
- The longer theme wording in the top bar at 1024 px with the Mac's own font, Daylight Auto following a real
  appearance change, and the Daylight Day EQ graph.
- The importer with real GarageBand and Logic instruments: Homebrew ffmpeg found when the app is opened from Finder,
  importing while Perform plays, Stop on a large piano, the Mac's own converter (.m4a), and quitting during an import.
- A real footswitch (momentary and press-only) on Next scene, and how the half-second scene glide sounds on a PA.
- Outputs 3–4 on a real 4-output interface, MIDI clock into a real drum machine or delay pedal, and how the click
  sounds and how loud it is in in-ears.
- Still open from 1.0: splitting a recording when audio restarts, and MIDI Learn on a second keyboard.
