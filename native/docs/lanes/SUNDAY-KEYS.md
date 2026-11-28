# Sunday Keys session (when Ryan is back on his Mac)

Ryan bought Sunday Keys (2026-11-28). This is the plan for the hands-on session; nothing here is built yet.
Rule, same as GarageBand content: anything made from Sunday Keys (recorded notes, settings copied from its patches)
is personal content. It lives in Ryan's My Samples folder and never goes into git, a build, a pack upload or `app/`.

## 1. Listen and compare (about 30 min, Ryan + Claude)

- Pick 5–8 Sunday Keys patches Ryan actually uses (pads, keys, a lead, a swell).
- For each: play the same short phrase in Sunday Keys and in Worship Rig's nearest factory song, and note what is
  missing: tone, effects (reverb tail, shimmer, delay sync, chorus, tremolo, swells), layering, velocity ranges,
  what one knob or wheel does.
- Output: a "sound targets" table appended to [FX-gap-analysis.md](FX-gap-analysis.md), ranked by how much each gap
  matters to Ryan. That ranking decides the order of FX steps 2–4 and the new effects after 2.0 (D13).

## 2. Rebuild the patches Ryan likes as Worship Rig songs (no audio copied)

- For each target: a Worship Rig song with our own instruments and effects that gets as close as it can, saved to
  his library (or a personal patch pack under My Samples). Gaps that need new DSP go into the table from step 1.

## 3. Optional: his Sunday Keys sounds as My Samples instruments (personal use only)

- First look at what Sunday Keys stores on disk and in what format [U: not known yet]. We only use what it offers
  openly (an export, an AU/standalone we can play); we don't try to unlock or decrypt anything.
- The clean route is **resampling**: play each note at a few velocities through Sunday Keys and record the output
  into a My Samples instrument (the same folder and manifest format the GarageBand importer writes). That needs a
  small Mac tool (record a MIDI-driven render per note, trim, loop points, write the manifest); about 2–3 agent-days
  [E], built after 2.0 unless Ryan wants it sooner.
- Effects in Sunday Keys stay in Sunday Keys: we record dry where it allows, and rebuild effects with ours (step 2).

## Before the session (cloud, now)

- Nothing needs building yet. When the session is near: a short checklist in MAC_CHECK and, if Ryan wants step 3,
  a spike on recording an AU's output on macOS (AVAudioEngine offline render, if Sunday Keys ships an AU [U]).
