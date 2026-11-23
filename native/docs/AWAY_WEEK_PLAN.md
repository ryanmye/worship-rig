# Away-week plan (Ryan away from his Mac, week of 2026-11-23)

Written by the cloud session on 2026-11-23 from Ryan's answers:
- His Mac will be off or asleep.
- He wants help setting up GitHub so pushes go directly from the cloud.
- All four tracks, plus anything else useful.
- Decisions are tiered; only the top tier goes to Ryan.

## 0. Preconditions (before Ryan leaves)

1. **Direct push from the cloud.** The cloud can read GitHub but not write to it: the environment's `GH_TOKEN` is
   invalid. Ryan creates a fine-grained token scoped to `ryanmye/worship-rig` only, with these permissions:
   - Contents read/write.
   - Actions read/write (to start and read CI runs).
   - Metadata read.
   - Expiry of about 14 days.

   He then gives it to the session. It is stored only in the container's git credential store. It is never written to
   the repo, to memory or to docs, and Ryan revokes it when he is back.
2. **Push rules stay as they were with the Mac agent**, enforced by a local `pre-push` hook in the cloud clone:
   - Only `v2-native`, fast-forward only.
   - Never `main`, never tags, never releases, never a force push.
   - No `user-samples/`, no `sound-packs/`, no `*.exs`/`*.caf`/`*.aif`, no file over 20 MB.
3. **Mac stand-in: the GitHub Actions macOS runners.** `native-core.yml` already has `goldens` and `mac-check`
   (`macos-15`). With Actions access the cloud starts them, reads the results and records them in MAC_CHECK.md as
   "CI Mac check".

   They cannot do these things; they stay on the "when Ryan is back" list:
   - real audio output, MIDI, the M2 Pro probe numbers, and Ryan's ears;
   - iPad installs, which need his Apple ID.
4. **Nothing is lost if the push breaks.** Every checkpoint is also written as a bundle in the chat outputs. If the
   container is reclaimed, the next session restores from the newest bundle.

## 1. Decision tiers

| Tier | What | How |
|---|---|---|
| **1: ask Ryan** (chat; work continues on other lanes) | Anything public or irreversible: releases and tags, pushing `main`, uploading or hosting packs anywhere, a licence doubt, deleting or migrating user data in a way that can't be undone, dropping a 1.x feature, the visual direction of the setlist redesign (he picks from mockups) | Ask once, with options and a recommendation |
| **2: decide and log** | Choices inside an agreed feature: defaults, layouts, file formats, internal architecture, contract minor bumps | Write it in DECISIONS.md (`O-AW-n`) so it is easy to reverse; it goes in the daily summary |
| **3: just do** | Bug fixes, tests, refactors, docs, flaky-test fixes, review findings | The commit message and the review file |

**Daily summary.** Around 18:00 America/New_York, a short message covering:
- what landed;
- the tier-2 decisions made;
- any open tier-1 questions;
- the dashboard link.

## 2. Lanes (2 CPUs: at most two heavy agents at once; each item is builder → skeptic, then a scoped check)

### Lane E: engine and 2.0 cleanup (first; it gates release prep)

1. CORE3 (song switch off the control thread, neighbour pre-build), then the scoped re-check of CORE3 and MACFIX.
   This is in progress now.
2. **Open core items from the CORE2 integration:**
   - CORE2A O3–O5, CORE2B N1–N4, CORE1 items 1–4.
   - T14 monoSwitch legato, wash `SetFeedback`, tape lead.
   - T11/T15 O5, T16 O4, W3A R5, T06 `protect([])`.
   - T11a: make chorus-fast-deep-noise exact.
3. **The three ui-core timing races:** v11-metronome, v11-decisions and the polish-2A banners. Fix them in the suite,
   by waiting on the core event instead of a fixed delay.
4. **`--self-test` mode for the Mac app**, run on the CI macOS runner:
   - launch with no UI, load `rig://app/`, bridge `hello`, play a short silent render, then quit;
   - wire it into `check.sh` and `mac-check`.

   This is the first real launch of the Mac app, and it happens without Ryan.
5. **Library migration from 1.x** (SHELL.md follow-up; data-loss risk):
   - import the Electron app's localStorage library (or an exported backup) into the 2.0 app on first run, with a
     backup kept;
   - tests use real 1.x exports.
6. iPad: a memory-budget model and the iPad Auto voice limit from the measured per-voice costs. Verified on the iPad
   later.

### Lane S: setlist and song switching (2.x)

1. Read the current setlist UI, song switching and the Perform header. List what slows a switch or makes it risky
   on stage (taps, scroll, mis-taps, no next-song preview).
2. **Tier 1:** two or three mockups (Design artifacts) for Ryan to pick from on his phone. Examples: a big Next/Prev
   with a next-song preview, a setlist strip with load state per song, a confirm-free "armed next" switch.
3. Build the chosen design on top of 2.0's background loading and CORE3's neighbour pre-build:
   - show each song's load state (cold, loading, ready);
   - have a "next song ready" indicator.
4. **Hands-free switching:** MIDI Program Change and a footswitch CC go to Next/Prev/specific song, with MIDI Learn
   rows. This is tier 2, because it fits the agreed "smoother switching".
5. Tests: Playwright in ui-core plus a devhost run that switches songs while notes are held.

### Lane C: charts (2.x)

1. Research what WorshipTools exports (web: help pages, file formats) and whether an import needs an account or API
   key; if a key or terms are needed, that is tier 1.
2. **Import path:** ChordPro (`.cho`, `.chordpro`), plain chord-over-lyrics text, and the WorshipTools format if it
   is documented:
   - read title, key, tempo, time signature and section names;
   - create or update the song in the library and add it to a setlist;
   - suggest slot sounds from the key and tempo, as a tier-2 heuristic.
3. **Chart view on Perform** (BACKLOG A): the chart for the current song, with transpose following Easy Transpose,
   an auto-scroll option, and big type.
4. Tests: parser unit tests on sample charts written for the tests (not copied from copyrighted songs), plus
   Playwright for the import flow.

### Lane P: sound packs (2.0.x)

1. **Download.** VSCO 2 CE, then the Karoryfer CC0 libraries (String Cyborgs, Bigcat Cello, Meatbass, D. Smolken,
   Ergo), then VCSL only where needed.
   - They go into `sound-packs/`, which is git-ignored.
   - There is about 8 GB free, so one library at a time: download, extract what is needed, build, delete the raw
     files.
2. **Pack build tool** (`tools/packs/`):
   - pick the sustained articulations;
   - find loop points or keep long samples (the D-list lesson: short GM loops sound bad);
   - trim and encode to a size target per pack;
   - calibrate levels with `tools/calibrate.mjs`;
   - write a pack manifest in the My Samples format.
3. **In the app:**
   - Settings › My Samples › Add pack… and drag-to-install on the Mac;
   - on the iPad, the same button through the Files picker (code only, verified later);
   - remove a pack.
4. **Site:** a pick-your-packs page with a checkbox per pack. Where packs are hosted is tier 1: nothing is uploaded
   until Ryan says where.
5. **Listening.** Audition WAVs and short demos (a held chord and a swell) go to Ryan in the chat, so he can listen on
   his phone. His OK per pack is tier 1.

### Lane R: 2.0 release prep (after Lane E is green)

- 2.0 release notes: what changed for him, the 1.x → 2.0 migration steps, and known gaps.
- README and site update for 2.0. The site's download page gets ready for packs.
- A release checklist in MAC_CHECK. The release itself is tier 1, after Ryan's hands-on session.

### Other ideas (picked up when a lane is idle)

- Use the CI macOS runner for the per-voice cost of dx-epiano and supersaw and the chord-burst timing (D4 R1), with
  the null audio backend.
- A crash and recovery story for the Mac app: WebContent crash, then reload with the engine still running. Code plus
  a self-test case.
- Setlist export and import as a file (share a Sunday set between Mac and iPad).
- Accessibility pass on Perform (contrast and size of the stage-critical controls).

## 3. Order and parallelism

1. **Day 1:** finish Lane E 1, and set up the token and the CI Mac stand-in. Lane S 1–2 (mockups to Ryan) and Lane C 1
   (research) are light on CPU, so they run in parallel.
2. **Days 2–4:**
   - Lane E 2–5 runs alongside one feature lane at a time: Lane S 3–5 once Ryan picks a mockup, otherwise Lane C 2–4.
   - Lane P downloads run when the disk and the CPUs allow.
3. **Days 5–6:** Lane P build and UI, and Lane R. Re-run the full check once, then a CI Mac check.
4. **When Ryan is back:**
   - Mac check on the M2 Pro and his hands-on checklist (MAC_CHECK "Tier 2");
   - listening to the packs;
   - the iPad install;
   - then the 2.0 release (tier 1).

## 4. State

The dashboard artifact tracks every lane. REPICKUP.md section 2 points here. Each lane's reviews go under
`native/docs/reviews/`.
