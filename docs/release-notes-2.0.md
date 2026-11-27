> **Draft, not released** (Lane R, 2026-11-27). Ryan publishes it, after his Mac review (U9) and the hands-on list
> in `native/docs/MAC_CHECK.md` "2.0 release checklist". Everything marked **New layout** is only there with
> **Settings › Look › Perform view › Try the new layout (preview)** turned on, until that review makes the new layout
> the default. Things marked *(not yet tried on a real Mac / iPad)* were built and tested in software only. The
> "Editor's notes" at the end go before publishing.

Worship Rig 2.0 is a new Mac app with its own sound engine, and the first version for the iPad. A song can now have
up to 16 sounds, song changes are cued and then played with one Go, a scene can bring its own reverb, echo and drone,
any slider can be put on a MIDI knob, and every song can carry a chord chart. Your 1.x songs, setlists and settings
come over (see "Bringing your 1.x library over").

### A new sound engine in the Mac and iPad app

The Mac app and the iPad app play through a new engine written in C++, instead of the browser's Web Audio. The
screens are the same web pages as before. The new engine was checked against the old one with 112 recorded test
renders: all 112 match within their tolerance, and 110 of them sample for sample. *(Nobody has compared the two by
ear on a Mac yet.)*

- **Song changes stay smooth.** Synth and organ sounds are built away from the engine's timing thread, and the songs
  next to the current one in the setlist (Next, Prev and one more each way) are built ahead of time, so Next and Prev
  are instant. A jump to a song further away can take a moment before its sound comes in, but the notes you are
  playing stay on time. Notes you hold keep ringing on the old sound, as in 1.x.
- **Settings › Sound** has three new choices:
  - **Voices per sound: 32 · 64 · 128** (64 by default; 1.x had 16 for synths and 32 for sampled sounds). When a sound
    runs out, the oldest released note goes first, as before.
  - **Buffer size: 64 · 128 · 256 · 512 frames** (128 by default). The line next to it shows the size the Mac gave.
    On an M2 Pro through a USB-C dock, 64 frames played with no dropouts (2.9 ms; 128 is 5.8 ms).
  - **Total voice limit: Auto · 128 · 256 · 512 · Off**, across all the sounds of a song. **Auto** is 128 on the Mac
    and 64 on the iPad for now *(the iPad number is not measured yet)*.
- **Settings › Sound › Advanced › Freeze drone to save CPU** (on by default, which is 1.x's behaviour): in
  low-resource mode the drone plays from a recorded loop. Off keeps the live drone.
- **Recording** writes the WAV file from the engine itself, into **Music › Worship Rig** on the Mac and **Files › On
  My iPad › Worship Rig › Recordings** on the iPad. *(Not yet tried on a real Mac / iPad.)*
- The **Chrome version** keeps the browser's engine. It plays the first four sounds of a song (Edit says "Sounds 5–16
  are silent here"), and the three Sound choices above apply only in the Mac and iPad app.

### Up to 16 sounds per song

In **Edit**, the **Slots** button above the sound tabs adds or removes a sound, from 1 to 16. A new song starts with
four, and a 1.x song keeps its four exactly. On Perform, more sounds than fit scroll sideways. Scenes, the wheels and
the pedal, MIDI Learn and the range bars all work for every sound.

### Song changes: cue, then Go

Tapping a song in the setlist **cues** it, and nothing changes until you press **Go** (the Next button). Each song in
the setlist shows whether it is playing, cued, ready, loading or not loaded yet, and Go waits until the cued song is
ready. Tap the cued song again, or **✕**, to clear the cue. With nothing cued, Next plays the next song, as in 1.x.

- A footswitch learned to **Next Song**, the **→** key and the menu's Next also play the cued song. **Previous Song**
  clears the cue and steps back.
- **Settings › Keyboards & MIDI › Program buttons: Cue (Go plays it) · Switch now.** If your 1.x library already had
  Program Change on, it keeps switching at once, as before. Turning Program Change on in 2.0 starts on Cue.
- The look of the setlist is provisional: a design pass with Ryan comes later.

### Scenes remember Space, Echo and the drone

A scene used to keep the faders, the ON switches, the drone level and the mod wheel. It now also keeps:

- each sound's Space and Echo amounts, and the song's Space room and Echo choice;
- whether the drone is on, and its sound (Synth or My Pads).

The drone plays in the key the song is played in, so Easy Transpose or a new song key moves every scene's drone with
it. **New layout:** the **Save snapshot** dialog can also give a scene a key of its own, counted from the song's key
(so it still moves with Easy Transpose), and a name ("Hall", "Chorus") of up to 40 characters. Today's screens still
call them Scene 1, 2 and 3.

A scene change still glides over half a second and never restarts a note: Space and Echo glide, and a drone key change
crossfades as it always has. A scene saved by 1.x keeps meaning what it did: what it didn't save stays as the song
has it. While a scene plays, Edit says so in a line under its header ("Changing scene … for now: Update keeps it, Own
levels edits the song"). **Perform lock** leaves Save and Update working, as Quick › Save as scene did in 1.x.

### MIDI Learn on any setting

In **Edit**, right-click (or Ctrl-click, or long-press) any slider, fader or level chip and choose **Learn MIDI knob**,
then move a knob. **Forget** takes it off again. **Settings › Keyboards & MIDI › MIDI Learn** lists these mappings
under the fixed ones (Next Song, Panic, …), each with Learn and Remove.

- A mapping belongs to a place, not to one song: "sound 2's Space" moves sound 2's Space in whichever song is
  playing. A song without that sound ignores it. Moving or duplicating a sound doesn't move its knob.
- One knob can drive several faders at once (the reverb send and the delay feedback, for example).
- A knob move is an edit, like a slider drag: the song shows its changed dot and **Revert** undoes it.
- Knobs use pickup: they do nothing until they pass the value on screen, so the sound never jumps.
- Under **Perform lock** you can't learn, but learned knobs keep working.
- **New layout:** **Settings › MIDI Learn › Learn on Perform** (or a right-click on a Perform control) shows what can be
  learned on the stage: move a knob, then tap the control, or the other way round.
- On the iPad, Safari has no right-click or long-press menu, so today's Edit has no way in there yet. Use the new
  layout's **Learn on Perform**.

### Chord charts

Perform has a **Chart** button. Paste a chart or import a ChordPro file (`.cho`, `.chordpro`) or plain chords over
lyrics, and the chords follow Easy Transpose and the song's key. A chart in the relative minor lines up too: an Em
chart on a song in G plays with the G drone, and its header can say "Key Em". The chart scrolls by itself at a speed
you set, and the text size goes up and down.

- A song's chart travels with it in exports and backups.
- **Settings › Look › Perform view › Chord charts** turns the Chart button off on this computer.
- **New layout:** the chart is a tab in the right sidebar, or fills the stage with small faders for each sound
  (**⇥ Sidebar** / **⤢ Stage**, remembered on this device). Text size goes in steps from 50 % to 200 %: tap the
  percentage or ⌘0 for 100 %, **Fit** picks the biggest size whose longest line fits, and pinch or ⌘+ / ⌘− work
  too. Edit has a Chart button as well.
- Not in 2.0: PDF charts and real notation.

### Your own patch packs and the Song bank

Song files you put in a pack folder in **My Samples** (`<pack>/songs/*.json`) come into your library by themselves,
once each, at the end of the library. A newer version of a pack song replaces your copy only if you haven't changed
it, and a pack song you delete stays deleted. A pack marked as a bank (`pack.json`: `"mode": "bank"`) isn't added by
itself: pick songs from **Settings › Sounds & Samples › My Samples › Song bank** and press **Add to library**. The
folder layout is in [docs/patch-packs.md](patch-packs.md). Pack songs are your own files: nothing is uploaded or shared.

**New layout:** the Song bank opens over the stage (from **Setlist › + Add song › From the Song bank**, or from
Settings) with search and Key, Tempo (under 80, 80–114, 115 and up), Feel and Pack filters. **Try it** plays a bank
song in place of the current one without saving anything; the banner then offers **Keep it**, **Add to setlist** or
**Back** (the song you had, exactly as it was).

Patch packs and the Song bank work in the Chrome version today; the Mac and iPad app don't read My Samples yet (see
"Known gaps").

### The new layout (preview)

**Settings › Look › Perform view › Try the new layout (preview)** switches to the redesigned screens, and switching it
off brings today's screens back at once. Until Ryan's review on his Mac (U9), today's screens are the default and
everything in this section is a preview.

- **Perform:** the instrument strips fill the stage, each with its ON tile, fader and meter, Space / Echo / Octave /
  Sustain, **Change** and a **⋯** menu (Earlier, Later, Duplicate, Open in Edit, Remove). Drag a strip by its **⠿**
  grip to reorder; a duplicate goes next to the original. More than five scroll sideways, with a row of name pills
  to jump. Colours go by position, never by kind of sound, and no screen says Keys, Pad, Extra or Bass any more.
- **Left:** a **Quick** button (today's Quick sheet) above the wheel column (wheel, what it drives, Swell, pedal).
- **Right sidebar:** one module at a time as tabs: Drone, Setlist, Notes, Click and Chart. Drag its edge to resize
  it, fold it to an icon rail, and choose and order the modules with **⋯**. The sidebar header shows "Loading…" or
  "Preparing n of m" while songs load.
- **Song bar:** key and "you play", Transpose, the Space room, Notes, Setlist and a **⋯** song menu (Rename,
  Duplicate, Add to setlist, Export, Reset to as saved, Delete). A row under it holds the snapshots (named scenes),
  with Update and Save as new, and folds into one chip.
- **Range bars:** each sound's coloured bar above the bottom keyboard has a handle at each end. Tap the sound first,
  then drag a handle: you hear the split while you drag. Edit's bottom keyboard works the same way.
- **Edit:** a library column you can fold, tabs by instrument name plus Drone · Effects · Master, and for each one a
  short list of categories (Sound, Tone EQ, Range, Touch, Sustain, Space & Echo, Advanced) that shows its current
  setting and a dot when it changed since the song began. **Range** uses an 88-key keyboard. **Change instrument**
  opens a chooser with search.
- **Settings:** each category shows its current state, a search box finds any setting, and there are **MIDI Learn**
  and **Perform layout** categories and theme previews.
- **Arrange** (from the snapshots row) moves strips and sidebar modules.
- **iPad:** landscape looks like the Mac; portrait stacks the strips over a panel, with the keyboard full width.
- **First run and empty states:** a "Start here" band under the song bar; with no songs, a card with New song, Song
  bank and Restore a backup.

### Colour-blind colours

**Settings › Look › Appearance › Colour-blind colours: Off · Red–green · Blue–yellow** recolours the instrument
colours (strips, ON tiles, range bars, Edit tabs) in every theme with colours chosen to stay apart for that kind of
colour blindness, and puts each instrument's number on its range bar and tab, so colour is never the only way to tell
two apart. It is set per computer and works on today's screens and the new layout. Off is exactly the old colours.
*(Checked with a colour-blindness simulation, not yet by colour-blind players.)*

### PANIC, Esc and Lock

- **PANIC** is one tap. It silences every note and stops the click. A drone the song has on keeps going, as in 1.x;
  a drone left on with no song behind it stops.
- **Esc** first closes what is open (a menu, the Quick sheet, a range pick), and the next Esc panics. **⌘.** (or
  Ctrl+.) always panics at once. **Settings › Keyboards & MIDI › Esc always panics** makes every Esc on Perform panic
  at once, even with a menu open (not while you type in a box, and not in a dialog). It is set per computer.
- **Lock** locks with one tap and unlocks with a hold, as in 1.x. Under Lock the faders, ON tiles, PANIC, Go and the
  scene numbers stay live, the key and Transpose need a hold, and Edit, Settings, MIDI learning and range drags are
  frozen.
- When the last song is gone (deleted, or Back from a trial in an empty library), the drone turns off and any notes
  you are still holding fade out, so an empty library is silent.

### How big a library can get

A library is meant to stay under about 2 MB (2,000,000 characters; a song is about 2 KB, so that is hundreds of
songs, and long notes and charts take the most room).

- A save past 2 MB goes through and warns you, once per session and again at each further 10 %.
- Restoring a backup, an export or a kept library works up to 2.5 MB, so a library that grew a little past 2 MB can
  always be brought back.
- Adding songs from a file (a merge) still has to fit in 2 MB.
- A new or duplicated song past 2 MB is added with the warning; one that would take the library past 2.5 MB is not.
- Saving a chart, adding a Song bank song and a pack top-up still stop at 2 MB in this draft (being made to follow the
  same rule).
- If the browser's storage itself is full, the save is refused, the last good save is kept, and you are told.

### The iPad app

The iPad app is the same app: the same screens, the same engine and the same library format. It runs on iPadOS 17.5
or later and is installed from Xcode with a free Apple ID (there is no App Store version), which means it has to be
re-installed every 7 days. Your songs stay. The steps are in
[native/apple/README.md](../native/apple/README.md) (steps 7–10). Recordings and backups show up in **Files › On My
iPad › Worship Rig**. *(Not yet installed on a real iPad.)*

### Bringing your 1.x library over

Every song comes over, with its four sounds and all their settings, scenes, tempo, key, time signature and notes, the
drone and effects, factory songs you edited or deleted, and songs that use My Samples instruments. So does every
setlist, in order, with the current setlist and song, and your MIDI Learn mappings, Program Change, touch sensitivity,
pedal polarity, latency and theme. Program Change keeps working as in 1.x (see "cue, then Go").

**On the Mac**

1. Open the old Worship Rig (1.x) once and quit it, so its latest backup is on disk. (1.x writes a backup when its
   window closes, and while you edit, at most every 10 minutes. A 1.x library you never edited has no backup, but it
   is only the factory songs anyway.)
2. Open Worship Rig 2.0. On the first launch it asks **"Import your Worship Rig library?"**. Choose **Import**. It
   asks only once, and only while the 2.0 library is untouched. The 1.x backups are only read, never changed.
3. Said "Not now"? Choose **File › Import Library Backup…** later and pick the newest `rig-….json` (1.x's **Rig ›
   Open Backups Folder** shows where they are).
4. Or: in 1.x use **Settings › Export library**, then in 2.0 **Settings › Import…** with that file. Into an untouched
   2.0 library this replaces it completely, settings included (a theme you picked in 2.0 first is replaced by the 1.x
   one). Into a library you have already changed, it adds the songs and setlists and leaves your settings alone.

The 2.0 app is called **Worship Rig.app** too. If you drag it into Applications over 1.x, Finder replaces the old
app; your 1.x backups stay where they were, so the import still works. To keep 1.x as well, rename the old app first.

**On the iPad**

1. On the Mac, take the newest `rig-….json` from 1.x's backups folder, or a **Settings › Export library** file.
2. AirDrop it to the iPad or put it in Files, then open it with Worship Rig ("Import this library?" › **Import**), or
   use **Import Library Backup…** and pick it.
3. The current iPad library is saved as a backup first (Files › On My iPad › Worship Rig › Backups), and can be
   imported back the same way.

**Your computer's own settings.** Some settings belong to one computer and one keyboard: each keyboard's touch curve
and Remember, the dynamic range, the click (level, count-in, output), MIDI clock out, global shortcuts, the update
check, the MIDI input, audio output and pad folder, menu-bar mode and low-resource. 1.1.0 and older never saved these
in a backup or an export; **1.1.1 does**.

- From this Mac's 1.1.1 backups (the first-launch import, or Settings › Import latest backup…), 2.0 takes them over by
  itself.
- From a file (**Settings › Import…**), 2.0 asks first: **"Also use its device settings here"**, ticked when the file
  was saved on this computer. A file opened from File › Import Library Backup… or AirDrop brings the library only. On
  the iPad nothing is taken over by itself.
- 1.1.1's **Settings › Export library** includes them only with **With this computer's device settings** turned on.
  Its backups always do.
- 2.0 only fills in what you haven't set in 2.0 yet. A keyboard, clock port, audio output or pad folder that isn't
  plugged in or found is skipped, and a line says which. A pad folder chosen in Chrome has to be chosen again.
- From 1.1.0 or older, set these once more in 2.0. My Samples packs never move with a library: songs keep pointing at
  them, so put the packs back in `~/Music/Worship Rig/Samples/`. 2.0's own per-computer settings (voices, buffer
  size, voice limit, drone freeze, chord charts, colour-blind colours, Esc always panics) are never taken from a file.

**Safety**

- Before an import replaces a library you have edited, that library is backed up. If the backup can't be written,
  nothing is replaced. Importing that backup brings the library back exactly.
- A damaged or cut-off backup, a file from a newer version, or a `.json` that isn't a Worship Rig library is refused,
  and nothing changes.
- A damaged library found at start-up is kept as `rig-unreadable-….json` before 2.0 starts fresh.
- Big libraries (tested with 200 songs) and names in any script (CJK, Hebrew, emoji, accents) come over whole.

**Going back to 1.x**

- 1.1 refuses a 2.0 library ("This file was made by a newer version of Worship Rig.") instead of breaking it.
- The Chrome versions of 1.x and 2.0 keep their library in the same place in the browser. Going back and forth in one
  Chrome profile is safe in 2.0: it keeps a copy of the 1.x library when it upgrades it, finds a library 1.1.0 set
  aside, and never deletes these copies to make room. **Settings › Library & Backup › Restore previous library…** lists
  every library the browser kept, by date and version, and puts the one you choose back (your current one is kept
  first, so a restore can be undone the same way).
- **1.1.1** never sets a 2.0 library aside: it says "This library was saved by Worship Rig 2.0 …" and offers a
  separate 1.x library.
- Before going back to 1.x, **Settings › Export library** is still the simplest way to be sure. Keep your last 1.x
  export if you might go back.

The full migration notes, with what was tested how, are in
[native/docs/RELEASE_NOTES_2.0-migration.md](../native/docs/RELEASE_NOTES_2.0-migration.md).

### Install / update

**Which Mac?** The 2.0 Mac app needs an **Apple Silicon Mac (M1 or later)** and **macOS 14.5** or later. On an Intel
Mac, or on macOS 12 to 14.4, keep using [Worship Rig 1.1.1](https://github.com/ryanmye/worship-rig/releases/tag/v1.1.1).

**Which file?** `Worship-Rig-arm64.dmg`. The `.zip` holds the same app; use it if the .dmg won't open.
<!-- Editor: file names to be settled by the native release build (MAC_CHECK "2.0 release checklist" step 2). -->

**Updating from 1.x:** follow "Bringing your 1.x library over" above, then open the .dmg and drag Worship Rig to
Applications.

**First open:** like 1.x, this build is **ad-hoc signed**, not notarized by Apple. On macOS 15 and later, click
**Done**, then **System Settings › Privacy & Security › Open Anyway**; on macOS 14, right-click the app › **Open**.
See the README ("Running on your Mac → First open on another Mac") for the full steps.

### Known gaps

**Not in the Mac and iPad app yet** (they work in the Chrome version; the 1.x Mac app had them):

- **My Samples**, **patch packs** and the **Song bank**: the app doesn't read the My Samples folder yet, so its Song
  bank is empty, and the **GarageBand / Logic importer** isn't there.
- **My Pads**: a pad folder can't be chosen yet; the drone uses the synth drone.
- **Menu-bar mode**, **global shortcuts** and the **update check**.
- **MIDI clock out** for the click.

**Not yet tried on a real Mac or iPad.** The engine was measured on Ryan's M2 Pro (buffer sizes, the cost per voice)
and the app starts, loads and plays a note on GitHub's Mac test machines, but nobody has played it yet. Still to be
checked by hand:

- playing with a real MIDI keyboard and pedal in the app, song changes while holding notes, and how 2.0 sounds next
  to 1.x on the same songs;
- the first-launch import of a real 1.x library on a real Mac, and iPad import by AirDrop and Files;
- recording, audio device changes and sleep / wake in the app;
- the iPad install itself, its audio (interruptions, the screen locked, headphones in and out) and its memory limits;
- WebKit's storage limit with a library near 2 MB;
- the new layout on a real Mac and iPad: trackpad pinch and ⌘-scroll on the chart, touch on the iPad, the iPad's
  on-screen keyboard;
- colour-blind colours with colour-blind players, and VoiceOver.

**Waiting for 2.0.x or later:**

- **Optional sound packs** (2.0.x): free CC0 libraries (VSCO 2 Community Edition, Karoryfer, VCSL) as separate
  downloads you pick, so the app download stays small. Not ready yet.
- **The iPad's memory budget** and its own Auto voice limit, measured on a real iPad.
- **PDF charts** and real notation.
- **Effects steps** that change the engine: tempo values for the echo and a high-pass in its feedback, a velocity
  range per sound, and one wheel driving several things.
- After 2.0: an iPhone remote for the Mac, a browser remote for old phones, and Windows.
- One known gap from the migration: if the newest 1.x backup is damaged, the first-launch import stops safely but
  doesn't try the next older one. Use File › Import Library Backup… and pick an older `rig-….json`.

### Editor's notes (delete before publishing)

Found while writing these notes (Lane R, by reading the code on `v2-native` at d35b788; not run on a Mac). They are
in the release checklist (`native/docs/MAC_CHECK.md` "2.0 release checklist", "Blockers") and decide what the
"Known gaps" above may say:

1. **MIDI keyboard input in the Mac / iPad app looks unwired.** WKWebView has no Web MIDI, and the JS
   `requestMIDIAccess` polyfill over the native `midi` op (ENGINE_CONTRACT §5, WEBKIT_AUDIT item 5) is not in `app/js`.
   `RigMIDI.listen` connects only the sources a `midi listen` op names, and nothing in `app/js` sends one. If that
   holds on the Mac, a keyboard plays nothing in the app (and MIDI Learn, Program Change, touch fitting and the MIDI
   lamp don't work). This has to work before 2.0 ships; it is not a "known gap".
2. **Export from the Mac / iPad app** (Settings › Export library, Edit's Export song, the song menu's Export): the
   page downloads a file, and `RigNavigation.swift` has no download handling (no `WKDownload` delegate). Check it on
   the Mac.
3. The "Not in the Mac and iPad app yet" list comes from `RigSchemeHandler.swift` (`/api/health` says
   `userSamples: false, userPatches: false`), the `window.rig` polyfill in `RigLibrary.swift` (backupNow /
   latestBackup / onMenu only) and SHELL.md "Later tasks". Ryan decides whether 2.0 ships with them missing.
4. Intel Macs and macOS 12–14.4: the 1.1.x update check reads GitHub's latest release, so once 2.0 is "latest" every
   1.1 user is told about it, including the ones 2.0 can't run for. See the checklist's tier-1 questions.
5. The 2 MB rule line for charts, the Song bank and packs changes when the CAP task lands (UI6-build-plan "Queued
   small tasks"): re-read it then.
