Worship Rig 1.1.1 is a safety fix for anyone who also tries Worship Rig 2.0 in the same Chrome, and it gets your
settings ready for the move to 2.0. Nothing else changes.

### A 2.0 library is never touched by 1.1

Worship Rig 2.0 in Chrome keeps its library in the same place in the browser as 1.1. Until now, when 1.1 opened
after 2.0 had saved there, it set the 2.0 library aside as a hidden backup and started again from the factory songs.
Going back and forth twice deleted those hidden copies, so both libraries could be lost.

1.1.1 never overwrites, moves or deletes a library saved by 2.0. When it finds one, it shows one message:
"This library was saved by Worship Rig 2.0 …", with two choices:

- **Use a separate 1.x library.** 1.1.1 keeps its own library next to the 2.0 one. The first time, it starts from the
  factory songs, and after that it opens the same separate library each time. Settings › Import… still brings in a
  1.x export.
- **Quit.** Nothing is changed. Open the library again in Worship Rig 2.0.

The 2.0 library stays exactly as 2.0 saved it, and 2.0 opens it as before.

### Your settings come along to Worship Rig 2.0

1.1.1 also saves this computer's own settings with its backups, so Worship Rig 2.0 can bring them over: each
keyboard's touch curve, the dynamic range, the click, MIDI clock, global hotkeys, the update check, the MIDI input,
audio output and My Pads folder, menu-bar mode and low-resource mode. 1.1 itself still keeps its own settings when it
imports a library, as before.

Settings › Export library leaves them out unless you turn on **With this computer's device settings** next to the
button. Turn it on when you move to Worship Rig 2.0 on another computer. That file then names your MIDI keyboard,
your audio output and where your pad folder is, so don't share it; to give songs to someone else, share single songs.
