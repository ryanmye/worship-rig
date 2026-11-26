# Worship Rig: design philosophy and users (Ryan, 2026-11-26; DECISIONS D14)

Every UI decision is checked against this file. When a design and this file disagree, this file wins until Ryan
changes it.

## Who uses it, in priority order

1. **Ryan at his desk, every day.** He sits at a desk keyboard (Mac) and plays one sound (piano, often with a pad
   under it):
   - to practise and noodle;
   - to play along with music or YouTube.

   The app is usually running in the menu bar, and he opens it to play. This user decides the layout.
2. **Worship nights.** One sound covers the whole set, and switching songs changes only key, tempo and notes. Song
   switching (Cue, then Go; D6) must keep working, but it stays in the background.
3. **Fellowship worship, later.** iPad on a stand by the keyboard, or iPad and keyboard at home without a Mac.

**Not now, but planned:**
- **Sounds per song or per set** come only if they turn out to be straightforward to build.
- **Recording ideas** waits for 2.y. The instrument controls need to get simpler first. Keep the thread open in
  BACKLOG.

## Principles

1. **One sound, front and centre.**
   - The main screen is the current sound: big, clear, playable.
   - Its quick tweaks are one touch away:
     - pad under the piano: amount, and which pad;
     - reverb / space;
     - tone (brightness / warmth);
     - transpose;
     - sustain / pad hold.
   - Nothing else competes for space on the main screen.
2. **Finding sounds means a full browser.** Search and browse every instrument and saved song, without a fixed
   favourites row.
3. **Song switching stays in the background.** Setlist, Cue/GO and load states stay available and correct, but they
   are small and collapsible. They grow only when a setlist is in use.
4. **The menu bar is a mini Perform.** It holds sound, the quick tweaks, transpose, sustain/pad hold, volume and
   Panic.
5. **The iPad mirrors the Mac.**
   - Same regions, same order, same words.
   - Landscape is the Mac layout.
   - Portrait stacks the same regions and hides nothing.
   - iPad is a standalone rig, at home or on a stand. It is not a remote control for the Mac.
6. **It should look like our app.** Use the existing themes and tokens (Sanctuary v2 is the default). Brass means
   "where you are", and amber is only for lock/hold.
   - Targets are at least 44 px (48 px on iPad).
   - Text contrast is at least 4.5:1.
   - Advanced controls (per-slot EQ, 16 slots, wheels) live in Edit, not on the main screen.
7. **Simple first.** If a feature adds complexity for the daily user, it goes to a later version (Ryan's standing
   rule).

## What this changes now

- **Perform redesign:** the current sound plus its quick tweaks become the main region. Strips for unused slots, the
  Key & Drone card and the setlist row shrink or move behind a disclosure. The baseline inventory
  (`design-out/perform/INVENTORY.md`) found about 45% of the 1280×800 window spent on things a one-sound player
  doesn't use, and the sound actually in use given 13.7%.
- **Charts, song bank and Edit** follow in that order, under the same principles.
